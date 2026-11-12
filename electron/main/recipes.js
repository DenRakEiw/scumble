// @ts-check
// Recipes: the shipped ones in <app>/recipes, the user's in <userData>/recipes. A recipe
// is an API-format prompt with a fixed canvas node id (ComfyUI recipes) or a provider
// call (API recipes); see docs/RECIPES.md. This file lists them and imports a user's
// ComfyUI workflow (UI format from Save / Export, or API format from Export (API)) that
// contains an Inpaint Canvas node.
"use strict";

const path = require("node:path");
const fsp = require("node:fs/promises");
const { list, normalize, remove, save, slug, userDir, userFileStems } = require("./recipes_store");
const { fromWorkflow } = require("./recipes_workflow");
const { cloudMark, detach, detectRoles, fromCloudGraph, fromGraph, fromPrompt, holdsCanvas, looksLikePrompt, promotedOf, toPrompt } = require("./recipes_graph");

// ---- the shape of a recipe -------------------------------------------------------------
//
// docs/RECIPES.md describes this in prose, tools/recipes_test.js checks the shipped files at
// run time, and the typedefs below are the same agreement in a form a type checker reads.
// What `normalize()` guarantees to everything downstream - the editor's provider select,
// the Upscale dialog, `list_recipes`, the adapters - is `providers`, `providerIds`,
// `default` and `task` on a provider recipe, and per variant `limits`, `edit`, `refs` (the name
// a reference picture has in the prompt the model gets, docs/PLAN_REFS.md C3), and either
// `text` (an edit recipe) or `factor` (an upscaler).

/**
 * One Settings-panel control. `index` is the slot (1-8) the ComfyUI node's `setting_n`
 * output carries; a provider variant uses `key` instead: the parameter the adapter sends.
 *
 * @typedef {Object} SettingRow
 * @property {number} [index]
 * @property {string} [node]
 * @property {string} [input]
 * @property {string} [key]
 * @property {string} [label]
 * @property {any} [spec]
 */

/**
 * A preset a recipe file ships (the Realism Pass's L and M): values for Settings rows, keyed "<node>:<input>" as the
 * user's own presets in settings.recipePresets are. Shown first in the Preset row; the user cannot delete one.
 *
 * @typedef {Object} ShippedPreset
 * @property {string} name
 * @property {Record<string, any>} values
 */


/**
 * The biggest crop an edit variant takes, filled in for every variant by editLimits().
 *
 * @typedef {Object} EditLimits
 * @property {number} min
 * @property {number} max         the long side
 * @property {number} step        both sides are rounded to a multiple of this
 * @property {number} pixels      area cap, 0 = none
 * @property {number} minPixels   area floor, 0 = none
 * @property {number} ratio       the steepest crop the model takes, 0 = any
 * @property {string[]} aspects   aspect presets the model renders ("W:H"); the crop's context is widened to the nearest one, [] = any
 * @property {number} [out]       an upscaler's answer: the long side it may pass at most (the sent long side times the
 *                                factor; RTX Video Super Resolution on Comfy Cloud: 8192), absent = no cap
 * @property {number} [outPixels] an upscaler's answer: the area it may pass at most (Magnific Creative: 25,300,000), absent = no cap
 */

/**
 * What an upscale variant does with the factor, filled in by upscaleFactor().
 *
 * @typedef {Object} UpscaleFactor
 * @property {number} default
 * @property {number} min
 * @property {number} max
 * @property {number[] | null} steps   the only values the model takes, null = a free range
 * @property {boolean} fixed           the model picks its own factor
 * @property {boolean} [whole]         only whole factors in min..max (the adapter rounds any other, Magnific Precision)
 */

/**
 * The text-to-image shape of a variant ("Generate new"), null when it has none.
 *
 * @typedef {Object} TextShape
 * @property {string} model
 * @property {number[]} sizes
 * @property {any} fixed
 * @property {SettingRow[]} settings
 * @property {string} note
 * @property {TextRefs | null} refs   the reference layers go along to a new image (26f); null: the prompt alone
 * @property {any} [options]   the route's own options instead of the variant's (a Comfy Cloud recipe's text-to-image graph)
 * @property {string[]} [aspects]   the aspects the route takes for a new image ("W:H"), where the variant's options and
 *   limits do not list them (item 34: the Generate new dialog and the New dialog's presets offer them; renderer/editor/genpresets.js)
 * @property {LoraDecl} [loras]   a Comfy Cloud graph variant's `loras` as it holds for this route's graph (normalize;
 *   absent: the variant declared none, or nothing of it holds here)
 */

/**
 * Where a recipe's LoRAs go (item 50, docs/PLAN_LORAS.md §3.1, §3.5; lorasOf): `false` takes none; `model` names the
 * node of the graph the chain starts after (renderer/editor/loras.js modelSource; a node that itself reads a MODEL is
 * allowed, as an edit LoRA in the graph), `family` the base model the LoRAs must fit (the picker's hint).
 *
 * @typedef {false | { model?: string, family?: string }} LoraDecl
 */

/**
 * A text shape's reference pictures (docs/PLAN_REFS.md 26f): `max` lowers the route's own cap (null: the route's),
 * `model` / `options` the route a run with references goes to where the text route takes no pictures (fal's and
 * WaveSpeed's edit routes, Magnific's "-edit" routes), `field` the picture field where it differs, `name` the naming
 * pattern where it differs from the variant's refs.name.
 *
 * @typedef {Object} TextRefs
 * @property {number | null} max
 * @property {string | null} field
 * @property {string | null} model
 * @property {Record<string, any> | null} options
 * @property {string | null} name
 */

/**
 * One provider's way to the model. Everything below `note` is filled in by normalize().
 *
 * @typedef {Object} ProviderVariant
 * @property {string} [model]
 * @property {string} [input]                 "fill" (crop + mask) or "edit" (instruction)
 * @property {SettingRow[]} [settings]
 * @property {Record<string, any>} [fixed]    parameters sent as they are
 * @property {Record<string, string> | null} [fields]   input names for Replicate and fal
 * @property {Record<string, any> | null} [options]     adapter switches
 * @property {string} [note]
 * @property {EditLimits} [limits]
 * @property {boolean} [edit]                 false = from the prompt alone only
 * @property {TextShape | false | null} [text]   `false` in a file switches "Generate new" off; normalize() leaves a shape or null
 * @property {UpscaleFactor} [factor]         upscalers only
 * @property {boolean} [usesPrompt]           upscalers only: the tab's prompt goes along
 * @property {{ name: string }} [refs]        what the model calls reference picture n ("image {n}"); always set by normalize()
 * @property {LoraDecl} [loras]               a graph variant (Comfy Cloud): where the LoRAs go in `options.graph`; its
 *   text route's own resolution is `text.loras`
 */

/**
 * A recipe as it leaves this file. A ComfyUI recipe carries `prompt`, `canvas` and
 * `result`; a provider recipe carries `providers`.
 *
 * @typedef {Object} Recipe
 * @property {string} id
 * @property {string} [name]
 * @property {string} [description]
 * @property {string} [family]
 * @property {"comfy" | "provider"} [kind]
 * @property {string} [file]
 * @property {"builtin" | "user"} [source]
 * @property {"edit" | "upscale" | "pass" | "relight"} [task]   pass: the Realism Pass (ComfyUI recipes only)
 * @property {ShippedPreset[]} [presets]       presets the recipe file ships for its Settings rows
 * @property {Record<string, ProviderVariant>} [providers]
 * @property {string[]} [providerIds]
 * @property {string} [default]               the provider id a run takes without a choice
 * @property {string} [provider]              the old one-provider shape
 * @property {EditLimits} [limits]
 * @property {Partial<UpscaleFactor>} [factor]
 * @property {boolean} [usesPrompt]
 * @property {"local" | "api"} [mode]         ComfyUI recipes
 * @property {string} [canvas]
 * @property {string} [result]
 * @property {string[]} [needs]
 * @property {SettingRow[]} [settings]
 * @property {Record<string, any>} [models]
 * @property {Record<string, any>} [prompt]
 * @property {any} [text]
 * @property {any} [fixed]
 * @property {any} [fields]
 * @property {any} [options]
 * @property {string} [model]
 * @property {string} [input]
 * @property {string} [note]
 * @property {{ name?: string, slots?: number | null } | null} [refs]   the variants' default name pattern; ComfyUI recipes: slots (26e)
 * @property {LocalBoxes} [boxes]             ComfyUI recipes: where the Inpaint Canvas node's box rows go (localBoxes)
 * @property {boolean} [edit]                 ComfyUI recipes: false = a text-to-image graph, Generate new only (normalize)
 * @property {LocalUpsampler} [upsampler]     ComfyUI recipes: a prompt upsampler in the graph (localUpsampler)
 * @property {LoraDecl} [loras]               ComfyUI recipes: where the LoRAs go (lorasOf); a provider recipe's is its variant's
 * @property {{ drop: string[] }} [newImage]  ComfyUI recipes: the inputs Generate new without pictures leaves out (localNewImage)
 * @property {Record<string, string>} [needsVersion]  ComfyUI recipes: node type -> the ComfyUI release that brings it (comfyprompt.lacksNodesText)
 * @property {boolean} [promptRequired]       true: a run with an empty prompt is refused before anything goes (P-H3-Image:
 *                                            without words the model redraws the crop, or its upsampler invents an edit)
 * @property {string[]} [notes]               notes from importing or converting a workflow
 */

/**
 * A prompt upsampler in a ComfyUI recipe's graph (`upsampler`, checked by localUpsampler; recipes/flux3_klein_local.json,
 * 0.1.50 Q9): `switch` a ComfySwitchNode whose on_true is `run` (a TextGenerate or a TextGenerateV2) and whose on_false
 * is the prompt as typed, `nodes` the nodes only the upsampler needs (they go only when it runs,
 * comfyprompt.wireUpsampler), `show` a PreviewAny among them on its caption, `t2i` BFL's guide for Generate new without
 * pictures, `request` a recipe's own request text instead of BFL's (recipes/p_h3_image_local.json:
 * comfyprompt.upsamplerRequest), `extract` a JsonExtractString on the run when the run answers JSON (the switch's on_true is
 * then that node; recipes/minimax_h3_image_local.json), `source` where the guides come from.
 *
 * @typedef {Object} LocalUpsampler
 * @property {string} switch
 * @property {string} run
 * @property {string[]} nodes
 * @property {string} [show]
 * @property {string} [extract]
 * @property {string} [t2i]
 * @property {UpsamplerRequest} [request]
 * @property {string} [source]
 */

/**
 * A recipe's own upsampler request (`upsampler.request`): `edit` (with `{text}`, and `{pictures}` for one `picture`
 * block per picture sent, its `{n}` 1-based) and `t2i` (with `{text}` and `{aspect}`, the nearest of `aspects`);
 * `verbatim` a pattern (`match`) a prompt that needs no lead matches, and the lead of `edit` it then goes without (`drop`).
 *
 * @typedef {Object} UpsamplerRequest
 * @property {string} [edit]
 * @property {string} [t2i]
 * @property {string} [picture]
 * @property {string[]} [aspects]
 * @property {{ match: string, drop: string }} [verbatim]
 */

/**
 * Boxes in the prompt on the user's ComfyUI (a ComfyUI recipe's `boxes`, checked by localBoxes): `schema` the format
 * they go in, `input` the "node|input" of the recipe's graph that takes the canvas node's plain prompt. "flux3": the
 * Inpaint Canvas node's box_prompt output writes FLUX 3's rows, and a run sending boxes takes `input` from box_prompt
 * instead (host.queueGenerate). "moss": `layout` names the graph's MOSSImageLayoutPrompt node (ComfyUI 0.42's own, which
 * writes MOSS-Image's JSON layout from core bounding-box elements in the picture's pixels); a run sending boxes wires
 * its element input to the canvas node's elements output and takes `input` from it (comfyprompt.wireBoxPrompt).
 *
 * @typedef {Object} LocalBoxes
 * @property {string} schema
 * @property {string} input
 * @property {string} [layout]
 */


/** A provider recipe names its variants in a `providers` map, or, in the old shape, one `provider`. */
function hasVariants(data) {
    const p = data.providers;
    return !!(data.provider || (p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).length));
}


/**
 * Import a workflow file. `objectInfo` comes from the connected server (null when
 * offline: API-format files still work, UI-format files need the widget order).
 */
async function importFile(file, objectInfo, opts) {
    const text = await fsp.readFile(file, "utf8");
    let data;
    try { data = JSON.parse(text); } catch (err) { throw new Error("Not a JSON file: " + err.message); }
    const meta = { file: path.basename(file), date: new Date().toISOString().slice(0, 10) };
    const builtinDir = opts && opts.builtinDir ? opts.builtinDir : path.join(__dirname, "..", "..", "recipes");
    let recipe;
    // a graph made for Comfy Cloud (item 35 V5c): no Inpaint Canvas node, its nodes marked by title
    const graphLike = data && (Array.isArray(data.nodes) || looksLikePrompt(data) || (data.workflow && Array.isArray(data.workflow.nodes)));
    if (graphLike && !data.kind && !holdsCanvas(data)) {

        const stem0 = path.basename(file).replace(/\.json$/i, "");
        let output = data, wf = null;
        if (!looksLikePrompt(data)) {
            wf = Array.isArray(data.nodes) ? data : data.workflow;
            const info = (opts && opts.cloudObjectInfo ? await opts.cloudObjectInfo() : null) || objectInfo;
            if (!info) throw new Error("Reading a workflow saved from the ComfyUI UI needs the node definitions: store a Comfy Cloud key (or connect a ComfyUI), or export the workflow in API format.");
            output = fromWorkflow(wf, info, meta, { noCanvas: true }).prompt;
        }
        const ids = [...(await list(builtinDir)).map((r) => r.id), ...(await userFileStems())];
        let made;
        try { made = fromCloudGraph({ output, workflow: wf, name: stem0, ids, date: meta.date, promoted: wf ? promotedOf(wf) : [] }); }
        catch (err) { throw new Error(`This graph has no Inpaint Canvas node, and Scumble could not read it as a Comfy Cloud graph: ${err.message}`); }
        const bump = /^_(\d+)$/.exec(made.id.slice(slug(stem0).length));
        if (bump) made.name = `${made.name} ${bump[1]}`;
        const savedCloud = await save(made);
        const out = normalize({ ...made, file: path.basename(savedCloud), source: "user" });
        out.notes = [...(Array.isArray(out.notes) ? out.notes : []), `id ${out.id}`];
        return out;
    }
    if (data && data.kind && data.prompt && data.canvas) {
        recipe = { ...data };            // a Scumble recipe file
    } else if (data && data.kind === "provider" && hasVariants(data)) {
        recipe = { ...data };            // a provider recipe, in either shape
    } else if (data && Array.isArray(data.nodes)) {
        if (!objectInfo) throw new Error("Reading a workflow saved from the ComfyUI UI needs the node definitions: connect to ComfyUI first (or export the workflow in API format).");
        recipe = fromWorkflow(data, objectInfo, meta);
    } else if (looksLikePrompt(data)) {
        recipe = fromPrompt(data, objectInfo || {}, meta);
    } else if (data && data.workflow && Array.isArray(data.workflow.nodes)) {
        if (!objectInfo) throw new Error("Reading a workflow saved from the ComfyUI UI needs the node definitions: connect to ComfyUI first.");
        recipe = fromWorkflow(data.workflow, objectInfo, meta);
    } else {
        if (data && data.kind === "provider") throw new Error("This provider recipe names no provider: it needs a `providers` map (or, in the old shape, a `provider`).");
        throw new Error("This file is neither a ComfyUI workflow, an API-format prompt nor a Scumble recipe.");
    }
    const existing = await list(builtinDir);
    const byId = new Map(existing.map((r) => [r.id, r]));
    const fileStems = await userFileStems();
    const stem = path.basename(file).replace(/\.json$/i, "");
    const rawId = data && data.kind && typeof recipe.id === "string" ? recipe.id.trim() : "";
    const prev = rawId && slug(rawId) === rawId ? byId.get(rawId) : undefined;
    const keepOwnId = !!(rawId && slug(rawId) === rawId && (prev || !fileStems.has(rawId.toLowerCase())));
    let idNote;
    if (keepOwnId) {
        recipe.id = rawId;
        idNote = prev && prev.source === "user" ? `replaced your recipe ${recipe.id}`
            : prev && prev.source === "builtin" ? `shadows the shipped ${recipe.id}`
                : `id ${recipe.id}`;
        recipe.name = recipe.name || stem;
    } else {
        const baseId = slug(rawId || stem);
        let id = baseId, n = 2;
        while (byId.has(id) || id === "flux2_klein_local" || fileStems.has(id.toLowerCase())) id = `${baseId}_${n++}`;
        recipe.id = id;
        idNote = `id ${recipe.id}`;
        recipe.name = recipe.name || (id === baseId ? stem : `${stem} ${n - 1}`);
    }
    const saved = await save(recipe);
    // the file keeps the shape it was written in; the caller gets the recipe as list() serves it
    const out = normalize({ ...recipe, file: path.basename(saved), source: "user" });
    out.notes = [...(Array.isArray(out.notes) ? out.notes : []), idNote];
    return out;
}

module.exports = { list, remove, save, userFileStems, importFile, fromWorkflow, fromPrompt, toPrompt, fromGraph, fromCloudGraph, cloudMark, detectRoles, promotedOf, detach, userDir, _normalize: normalize };
