// @ts-check
// Recipes: the shipped ones in <app>/recipes, the user's in <userData>/recipes. A recipe
// is an API-format prompt with a fixed canvas node id (ComfyUI recipes) or a provider
// call (API recipes); see docs/RECIPES.md. This file lists them and imports a user's
// ComfyUI workflow (UI format from Save / Export, or API format from Export (API)) that
// contains an Inpaint Canvas node.
"use strict";

const path = require("node:path");
const fsp = require("node:fs/promises");
const { app } = require("electron");

const { REF_NAME_DEFAULT, validRefName } = require("./providers/refs");

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
 * @property {"edit" | "upscale"} [task]
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
 */

const FIXED_OUTPUTS = 13;   // InpaintCanvas outputs before setting_1 (nodes.py RETURN_NAMES)
const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);
const SKIP_TYPES = new Set(["Note", "MarkdownNote", "PrimitiveNode", "Reroute"]);

function userDir() {
    return path.join(app.getPath("userData"), "recipes");
}

async function readDir(dir, source) {
    const out = [];
    let names = [];
    try { names = (await fsp.readdir(dir)).filter((n) => n.endsWith(".json")).sort(); } catch (_) { return out; }
    for (const n of names) {
        try {
            const r = JSON.parse(await fsp.readFile(path.join(dir, n), "utf8"));
            r.id = r.id || n.replace(/\.json$/, "");
            r.file = n;
            r.source = source;
            r.kind = r.kind === "provider" ? "provider" : "comfy";
            out.push(normalize(r));
        } catch (err) {
            console.warn("recipe", n, "unreadable:", err.message);
        }
    }
    return out;
}

// Which providers can make an image from the prompt alone, and how the model id differs
// from the editing one. fal and WaveSpeed put the editing model under an /edit path, the
// others (OpenRouter, ModelArk and Comfy Router too) use the same id without the image field. A variant overrides this with
// `text: { model, sizes }`, or switches it off with `text: false`. Magnific's edit routes end in "-edit" and differ in
// more than the name, so every magnific variant names its text route (or `text: false`); tools/magnific_test.js holds them to it.
// Oxen.ai uses the same id on /images/generate (Grok Imagine's text model is another id: its variant names it).
const TEXT_PROVIDERS = new Set(["toapis", "openai", "gemini", "bfl", "fal", "replicate", "wavespeed", "openrouter", "ark", "comfyrouter", "comfypartner", "oxen", "magnific", "loopback"]);

// The long sides a provider documents for a generated image. Gemini's image models take
// 1K, 2K or 4K (imageConfig.imageSize), OpenAI's the three standard shapes at 1024 and 1536;
// the rest take a free size, so they get the generic ladder. A variant overrides with
// `text: { sizes: [...] }`.
const TEXT_SIZES = {
    gemini: [1024, 2048, 4096],
    openai: [1024, 1536],
};
const TEXT_SIZES_DEFAULT = [768, 1024, 1280, 1536, 2048, 3072, 4096];

// The biggest crop a provider variant will take for an *edit*, which is what the app pushes
// the emitted size to (host.apiSize "max"). `max` is the long side, `step` the multiple both
// sides are rounded to, `pixels` an area cap (0 = none) and `minPixels` an area *floor*
// (0 = none), which GPT Image 2.5 has: it refuses anything under 655,360 pixels; `ratio` the
// steepest crop it takes (0 = any; the crop's context is widened to it). A recipe
// sets `limits` for all its variants, a variant overrides it; without either the generic
// entry below applies. The numbers are the providers' own, and where a provider stays silent
// the conservative 2048 stands - raising one is a two-line recipe change, so do it with a
// source, not a guess.
const LIMITS_DEFAULT = { min: 256, max: 2048, step: 16, pixels: 0, minPixels: 0, ratio: 0, aspects: /** @type {string[]} */ ([]) };

/**
 * @param {Recipe} r
 * @param {ProviderVariant} v
 * @returns {EditLimits}
 */
function editLimits(r, v) {
    const l = { ...LIMITS_DEFAULT, ...(r.limits || {}), ...(v.limits || {}) };
    const n = (x, d) => (Number.isFinite(+x) && +x > 0 ? Math.round(+x) : d);
    l.step = Math.max(1, n(l.step, LIMITS_DEFAULT.step));
    l.max = Math.max(l.step, n(l.max, LIMITS_DEFAULT.max));
    l.min = Math.max(l.step, Math.min(l.max, n(l.min, LIMITS_DEFAULT.min)));
    l.pixels = Math.max(0, Math.round(+l.pixels || 0));
    l.minPixels = Math.max(0, Math.round(+l.minPixels || 0));
    if (l.pixels && l.minPixels > l.pixels) l.minPixels = 0;
    // `ratio`: the steepest crop the model takes (Seedream on ToAPIs: 3, i.e. 3:1); 0 = any
    l.ratio = Number.isFinite(+l.ratio) && +l.ratio >= 1 ? +l.ratio : 0;
    // `aspects`: the only shapes the model renders (Seedream and GPT Image 2 on Magnific), as "W:H"; [] = any
    l.aspects = Array.isArray(l.aspects) ? [...new Set(l.aspects.filter((x) => /^\d+(\.\d+)?:\d+(\.\d+)?$/.test(String(x))).map(String))] : [];
    return l;
}

// An upscale recipe (`task: "upscale"`, docs/RECIPES.md "Upscale recipes") says what factors the
// model takes: `factor: { default, min, max, steps }` on the recipe or a variant; `steps` lists the
// only values a model accepts (Magnific Creative: 2, 4, 8, 16), `fixed: true` a model that picks
// its own factor (Recraft's upscalers). Without it: 2, 1 to 4.
const FACTOR_DEFAULT = { default: 2, min: 1, max: 4, steps: null, fixed: false };

/**
 * @param {Recipe} r
 * @param {ProviderVariant} v
 * @returns {UpscaleFactor}
 */
function upscaleFactor(r, v) {
    const f = { ...FACTOR_DEFAULT, ...(r.factor || {}), ...(v.factor || {}) };
    const n = (x, d) => (Number.isFinite(+x) && +x >= 1 ? +x : d);
    f.min = n(f.min, FACTOR_DEFAULT.min);
    f.max = Math.max(f.min, n(f.max, FACTOR_DEFAULT.max));
    f.steps = Array.isArray(f.steps) ? f.steps.map(Number).filter((x) => Number.isFinite(x) && x >= f.min && x <= f.max).sort((a, b) => a - b) : null;
    if (f.steps && !f.steps.length) f.steps = null;
    f.default = Math.min(f.max, Math.max(f.min, n(f.default, FACTOR_DEFAULT.default)));
    if (f.steps && !f.steps.includes(f.default)) f.default = f.steps[0];
    f.fixed = f.fixed === true;
    return f;
}

function textModelOf(providerId, model) {
    const m = String(model || "");
    if (providerId === "fal" || providerId === "wavespeed") return m.replace(/\/(edit|inpaint|fill)$/, "");
    return m;
}

/**
 * The text-to-image shape of one provider variant, or null when it has none.
 * @param {string} providerId
 * @param {ProviderVariant} v
 * @returns {TextShape | null}
 */
function textVariant(providerId, v, where = providerId) {
    if (v.text === false) return null;
    if (!TEXT_PROVIDERS.has(providerId)) return null;
    const t = v.text && typeof v.text === "object" ? v.text : {};
    const model = t.model || textModelOf(providerId, v.model);
    if (!model && providerId !== "loopback") return null;
    return {
        model,
        sizes: Array.isArray(t.sizes) ? t.sizes : (TEXT_SIZES[providerId] || TEXT_SIZES_DEFAULT),
        fixed: t.fixed || v.fixed || null,
        settings: Array.isArray(t.settings) ? t.settings : (v.settings || []),
        note: t.note || "",
        refs: textRefsOf(t.refs, where),
    };
}

/**
 * A text shape's `refs` (26f): absent or false: null (the prompt alone); true: every field null; an object: each field
 * checked, a bad one null with a warning; anything else null with a warning.
 * @param {any} refs
 * @param {string} where
 * @returns {TextRefs | null}
 */
function textRefsOf(refs, where) {
    if (refs === undefined || refs === null || refs === false) return null;
    const out = { max: null, field: null, model: null, options: null, name: null };
    if (refs === true) return out;
    if (typeof refs !== "object" || Array.isArray(refs)) {
        console.warn(`recipe ${where}: text.refs ${JSON.stringify(refs)} is neither true nor an object; this model makes new images from the prompt alone`);
        return null;
    }
    const bad = (k) => console.warn(`recipe ${where}: text.refs.${k} ${JSON.stringify(refs[k])} is not valid; left out`);
    if (refs.max !== undefined) { if (Number.isInteger(refs.max) && refs.max > 0) out.max = refs.max; else bad("max"); }
    for (const k of ["field", "model"]) if (refs[k] !== undefined) { if (typeof refs[k] === "string" && refs[k].trim()) out[k] = refs[k].trim(); else bad(k); }
    if (refs.options !== undefined) { if (refs.options && typeof refs.options === "object" && !Array.isArray(refs.options)) out.options = refs.options; else bad("options"); }
    if (refs.name !== undefined) { if (validRefName(refs.name)) out.name = refs.name; else bad("name"); }
    return out;
}

/**
 * Provider recipes are model-centric: `providers` maps a provider id to the variant that
 * runs the model there ({ model, input, fields, fixed, settings, options, note }) and
 * `default` names the home provider. A recipe with a top-level `provider` (the old shape,
 * the smoke test's loopback) becomes a one-provider recipe. Every variant also gets its
 * `text` shape filled in, which is what "Generate new" uses.
 */
/**
 * A variant's `refs`: `{ name }`, the name a reference picture has in the prompt the model gets ("image {n}", n its
 * place among the pictures sent; `{n0}` counts from 0). An invalid pattern warns and takes the default.
 */
function refsOf(refs, where) {
    const name = refs && typeof refs === "object" ? refs.name : undefined;
    if (name === undefined) return { name: REF_NAME_DEFAULT };
    if (validRefName(name)) return { name };
    console.warn(`recipe ${where}: refs.name ${JSON.stringify(name)} is not a valid pattern (1-40 characters with {n} or {n0}, no @ or other braces); using "${REF_NAME_DEFAULT}"`);
    return { name: REF_NAME_DEFAULT };
}

/**
 * A ComfyUI recipe's declared `refs` (docs/PLAN_REFS.md 26e): `name` a valid pattern, `slots` the pictures its graph
 * reads, the crop included (an integer 1 to 16, the most TextEncodeQwenImage21 takes; null otherwise). A `refs` that
 * is no object or has a bad name is dropped with a warning, so the renderer derives both from the graph
 * (renderer/editor/comfyrefs.js).
 * @param {Recipe} r
 */
function comfyRefs(r) {
    if (r.refs === undefined || r.refs === null) return;
    const where = `recipe ${r.id}`;
    if (typeof r.refs !== "object" || Array.isArray(r.refs) || (r.refs.name !== undefined && !validRefName(r.refs.name))) {
        console.warn(`${where}: refs ${JSON.stringify(r.refs)} is not { name: a pattern with {n} or {n0}, slots: 1-16 }; the names come from the graph`);
        delete r.refs;
        return;
    }
    const out = {};
    if (r.refs.name !== undefined) out.name = r.refs.name;
    if (r.refs.slots !== undefined) {
        const s = r.refs.slots;
        out.slots = Number.isInteger(s) && s >= 1 && s <= 16 ? s : null;
        if (out.slots === null && s !== null) console.warn(`${where}: refs.slots ${JSON.stringify(s)} is not an integer from 1 to 16; the graph decides`);
    }
    r.refs = out;
}

/**
 * Fill in everything the rest of the app is allowed to rely on. Runs on every recipe that
 * is read from disk or imported; the shape it answers is the typedef above.
 * @param {Recipe} r
 * @returns {Recipe}
 */
function normalize(r) {
    if (r.kind !== "provider") {
        // a ComfyUI recipe may be an upscaler too (recipes/upscale_model_local.json): the model picks its own
        // factor, and only the selection mode exists (the node's stitch fits the answer back into the box)
        if (r.task === "upscale") r.factor = { ...FACTOR_DEFAULT, fixed: true };
        else if (r.task !== undefined) r.task = "edit";
        comfyRefs(r);
        return r;
    }
    if (!r.providers || typeof r.providers !== "object" || !Object.keys(r.providers).length) {
        const id = r.provider || "loopback";
        r.providers = { [id]: { model: r.model || "", input: r.input || "fill", fields: r.fields || null, fixed: r.fixed || null, settings: r.settings || [], options: r.options || null, note: r.note || "" } };
        r.default = id;
    }
    r.task = r.task === "upscale" ? "upscale" : "edit";
    for (const [id, v] of Object.entries(r.providers)) {
        v.limits = editLimits(r, v);
        v.refs = refsOf(v.refs !== undefined ? v.refs : r.refs, `${r.id}/${id}`);
        if (r.task === "upscale") {
            // an upscaler makes nothing from a prompt alone, so it has no Generate new shape
            v.text = null;
            v.edit = true;
            v.factor = upscaleFactor(r, v);
            // the tab's prompt goes along as guidance only where the model takes one (Clarity, Magnific Creative)
            v.usesPrompt = v.usesPrompt === true || (v.usesPrompt === undefined && r.usesPrompt === true);
            continue;
        }
        v.text = textVariant(id, v, `${r.id}/${id}`);
        v.edit = v.edit !== false;   // false: text to image only, no Generate on a crop
    }
    r.providerIds = Object.keys(r.providers);
    if (!r.default || !r.providers[r.default]) r.default = r.providerIds[0];
    return r;
}

async function list(builtinDir) {
    const builtin = await readDir(builtinDir, "builtin");
    const user = await readDir(userDir(), "user");
    const seen = new Set(user.map((r) => r.id));
    return [...user, ...builtin.filter((r) => !seen.has(r.id))];
}

async function remove(id) {
    const safe = String(id || "").replace(/[^A-Za-z0-9._-]/g, "");
    if (!safe) throw new Error("bad recipe id");
    await fsp.unlink(path.join(userDir(), safe + ".json"));
    return true;
}

async function save(recipe) {
    await fsp.mkdir(userDir(), { recursive: true });
    const file = path.join(userDir(), recipe.id + ".json");
    await fsp.writeFile(file, JSON.stringify(recipe, null, 2) + "\n", "utf8");
    return file;
}

function slug(name) {
    return String(name || "recipe").toLowerCase().replace(/\.json$/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "recipe";
}

// ---- conversion ----------------------------------------------------------------------

/** Widget input names of a node class in widgets_values order, with the seed control slots marked. */
function widgetNames(info) {
    const out = [];
    if (!info || !info.input) return out;
    for (const group of ["required", "optional"]) {
        for (const [name, spec] of Object.entries(info.input[group] || {})) {
            if (!Array.isArray(spec)) continue;
            const type = spec[0], opts = spec[1] || {};
            const isWidget = Array.isArray(type) || WIDGET_TYPES.has(type);
            if (!isWidget || opts.forceInput) continue;
            out.push({ name, spec });
            const control = opts.control_after_generate || ((type === "INT") && (name === "seed" || name === "noise_seed"));
            if (control) out.push({ name: null, control: true });   // "randomize" / "fixed" takes one slot
        }
    }
    return out;
}

/** A spec for the recipe file: combo lists shrink to the chosen value (the live list comes from /object_info at run time). */
function storedSpec(spec, value) {
    if (!Array.isArray(spec)) return undefined;
    if (Array.isArray(spec[0])) return [[value !== undefined ? value : spec[0][0]], {}];
    if (spec[0] === "COMBO") return [[value !== undefined ? value : ((spec[1] && spec[1].options) || [""])[0]], {}];
    return spec;
}

function specDefault(spec) {
    if (!Array.isArray(spec)) return undefined;
    const type = spec[0], opts = spec[1] || {};
    if (opts.default !== undefined) return opts.default;
    if (Array.isArray(type)) return type[0];
    if (type === "COMBO") return Array.isArray(opts.options) ? opts.options[0] : undefined;
    if (type === "INT" || type === "FLOAT") return 0;
    if (type === "BOOLEAN") return false;
    return "";
}

/**
 * A UI-format workflow (nodes / links) -> API-format prompt plus the recipe fields.
 * `objectInfo` is the server's /object_info (widget order and setting specs).
 *
 * Subgraphs (definitions.subgraphs) are flattened the way ComfyUI executes them: an
 * inner node gets the id "<instance id>:<inner id>", links from the subgraph's input
 * node (-10) take the instance's incoming link (or its promoted widget value), links
 * into the output node (-20) are followed when something outside reads that output.
 *
 * `opts.noCanvas` (item 35 V5c, a graph exported from Comfy Cloud): a workflow without the Inpaint Canvas node is
 * flattened too, and only { prompt, needs, notes } come back (fromCloudGraph makes the recipe).
 */
function fromWorkflow(wf, objectInfo, meta, opts) {
    const defs = new Map(((wf.definitions && wf.definitions.subgraphs) || []).map((d) => [d.id, d]));
    const nodes = new Map();       // flat id -> node (with _prefix)
    const links = new Map();       // flat link id -> { id, origin, originSlot, target, targetSlot, type }
    const instances = new Map();   // flat id of a subgraph instance -> { def, prefix }
    const overrides = new Map();   // "<flat node id>|<input index>" -> promoted widget value

    /** The promoted widget value of subgraph input k on an instance node (its widgets_values follow the widget inputs in order). */
    function instanceWidgetValue(inst, k) {
        const values = Array.isArray(inst.widgets_values) ? inst.widgets_values : [];
        let vi = 0;
        for (let i = 0; i < (inst.inputs || []).length; i++) {
            const inp = inst.inputs[i];
            if (!inp.widget) continue;
            if (i === k) return values[vi];
            vi += 1;
            if (inp.type === "INT" && (inp.name === "seed" || inp.name === "noise_seed")) vi += 1;   // control_after_generate slot
        }
        return undefined;
    }

    function parseLink(l) {
        if (Array.isArray(l)) return { id: l[0], origin: String(l[1]), originSlot: +l[2], target: String(l[3]), targetSlot: +l[4], type: l[5] };
        if (l && l.id != null) return { id: l.id, origin: String(l.origin_id), originSlot: +l.origin_slot, target: String(l.target_id), targetSlot: +l.target_slot, type: l.type };
        return null;
    }

    function addGraph(gNodes, gLinks, prefix, inst) {
        const pid = (id) => prefix + String(id);
        for (const raw of gLinks || []) {
            const l = parseLink(raw);
            if (!l) continue;
            if (l.origin === "-10") {
                // from the subgraph's input node: the instance's incoming link, else its promoted widget value
                const inp = inst && (inst.inputs || [])[l.originSlot];
                const outer = inp && inp.link != null ? links.get(inst._prefix + String(inp.link)) : null;
                // the promoted widget on the instance holds the current value (the inner
                // node's widgets_values can be stale); it is the input's value when nothing
                // is linked, and the value a setting link replaced otherwise
                const v = inst ? instanceWidgetValue(inst, l.originSlot) : undefined;
                if (v !== undefined) overrides.set(`${pid(l.target)}|${l.targetSlot}`, v);
                if (!outer) continue;
                l.origin = outer.origin; l.originSlot = outer.originSlot;
            } else {
                l.origin = pid(l.origin);
            }
            l.target = l.target === "-20" ? prefix + "-20" : pid(l.target);
            links.set(pid(l.id), l);
        }
        for (const n of gNodes || []) {
            const node = { ...n, id: pid(n.id), _prefix: prefix };
            nodes.set(node.id, node);
            if (defs.has(n.type)) {
                const def = defs.get(n.type);
                instances.set(node.id, { def, prefix: node.id + ":" });
                addGraph(def.nodes, def.links, node.id + ":", node);
            }
        }
    }
    addGraph(wf.nodes, wf.links, "", null);

    const canvasNodes = Array.from(nodes.values()).filter((n) => n.type === "InpaintCanvas");
    const noCanvas = !!(opts && opts.noCanvas);
    if (!canvasNodes.length && !noCanvas) throw new Error("This workflow has no Inpaint Canvas node.");
    if (canvasNodes.length > 1) throw new Error("This workflow has more than one Inpaint Canvas node; a recipe needs exactly one.");
    const canvasNode = canvasNodes[0] || null;
    const canvasId = canvasNode ? canvasNode.id : null;

    /** Follow a link back through reroutes, primitives, bypassed nodes and subgraph outputs to a real source. */
    function resolveLink(l, depth = 0) {
        if (!l || depth > 80) return null;
        const src = nodes.get(l.origin);
        if (!src) return null;
        if (instances.has(l.origin)) {
            const inner = Array.from(links.values()).find((x) => x.target === l.origin + ":-20" && x.targetSlot === l.originSlot);
            return inner ? resolveLink(inner, depth + 1) : null;
        }
        if (src.type === "Reroute") {
            const inp = (src.inputs || [])[0];
            return inp && inp.link != null ? resolveLink(links.get(src._prefix + String(inp.link)), depth + 1) : null;
        }
        if (src.type === "PrimitiveNode") return { primitive: true };
        if (src.mode === 4) {
            // bypassed: the output passes an input of the same type through (same slot first)
            const outType = (src.outputs || [])[l.originSlot] && src.outputs[l.originSlot].type;
            const ins = src.inputs || [];
            const cand = (ins[l.originSlot] && ins[l.originSlot].type === outType && ins[l.originSlot].link != null ? ins[l.originSlot] : null) || ins.find((i) => i.type === outType && i.link != null);
            return cand ? resolveLink(links.get(src._prefix + String(cand.link)), depth + 1) : null;
        }
        if (src.mode === 2) return { muted: true };
        return { id: l.origin, slot: l.originSlot };
    }
    const resolve = (/** @type {any} */ node, /** @type {any} */ linkId) => resolveLink(links.get(node._prefix + String(linkId)));

    const prompt = {};
    const widgetValues = new Map();   // flat id -> { input: widget value } before links replaced them
    const missingTypes = new Set();
    for (const n of nodes.values()) {
        const id = n.id;
        if (SKIP_TYPES.has(n.type) || instances.has(id) || n.mode === 2 || n.mode === 4) continue;
        const info = objectInfo[n.type];
        if (!info) missingTypes.add(n.type);
        const inputs = {};
        if (id !== canvasId) {
            const names = widgetNames(info);
            const values = Array.isArray(n.widgets_values) ? n.widgets_values : [];
            let vi = 0;
            for (const w of names) {
                if (vi >= values.length) break;
                const v = values[vi++];
                if (w.name) inputs[w.name] = v;
            }
            widgetValues.set(id, { ...inputs });
        }
        (n.inputs || []).forEach((inp, idx) => {
            if (inp.link == null) return;
            if (id === canvasId && (inp.name === "result" || inp.name === "result_local")) return;
            const ov = overrides.get(`${id}|${idx}`);
            if (ov !== undefined && !links.has(n._prefix + String(inp.link))) { inputs[inp.name] = ov; return; }
            const src = resolve(n, inp.link);
            if (!src || src.primitive) return;       // primitives: the target's widgets_values hold the value
            if (src.muted) { delete inputs[inp.name]; return; }
            inputs[inp.name] = [src.id, src.slot];
        });
        prompt[id] = { class_type: n.type, inputs, ...(n.title ? { _meta: { title: n.title } } : {}) };
    }
    // links whose source was dropped (muted, unknown) leave dangling refs
    for (const node of Object.values(prompt)) {
        for (const [k, v] of Object.entries(node.inputs)) if (Array.isArray(v) && !prompt[v[0]]) delete node.inputs[k];
    }
    if (!canvasNode) {
        const flatNotes = [];
        if (missingTypes.size) flatNotes.push("node types unknown to the node list it was read with: " + Array.from(missingTypes).join(", "));
        if (instances.size) flatNotes.push(`${instances.size} subgraph${instances.size > 1 ? "s" : ""} flattened`);
        return { prompt, needs: Array.from(new Set(Object.values(prompt).map((n) => n.class_type))), notes: flatNotes };
    }

    const wired = (name) => {
        const inp = (canvasNode.inputs || []).find((i) => i.name === name);
        const src = inp && inp.link != null ? resolve(canvasNode, inp.link) : null;
        return src && src.id ? `${src.id}:${src.slot}` : null;
    };
    const resultLocal = wired("result_local"), resultApi = wired("result");
    if (!resultLocal && !resultApi) throw new Error("Nothing is wired into the Inpaint Canvas node's result or result_local input, so no result could come back.");

    // setting outputs: the first real (non-instance) consumer of setting_n, found on the flattened links
    const settings = [];
    (canvasNode.outputs || []).forEach((o, i) => {
        if (i < FIXED_OUTPUTS || !o || !o.links || !o.links.length) return;
        const l = Array.from(links.values()).find((x) => x.origin === canvasId && x.originSlot === i && !instances.has(x.target) && !x.target.endsWith("-20") && prompt[x.target]);
        if (!l) return;
        const target = nodes.get(l.target);
        const tin = (target.inputs || [])[l.targetSlot];
        if (!tin) return;
        const info = objectInfo[target.type];
        const spec = info && info.input && ((info.input.required && info.input.required[tin.name]) || (info.input.optional && info.input.optional[tin.name])) || null;
        const node = prompt[l.target];
        const current = node.inputs[tin.name];
        if (Array.isArray(current)) {
            const ov = overrides.get(`${l.target}|${l.targetSlot}`);
            const wv = widgetValues.get(l.target) || {};
            node.inputs[tin.name] = ov !== undefined ? ov : (wv[tin.name] !== undefined ? wv[tin.name] : specDefault(spec));
        }
        const stored = storedSpec(spec, node.inputs[tin.name]);
        settings.push({ index: i - FIXED_OUTPUTS + 1, node: l.target, input: tin.name, label: `${target.title || target.type} · ${tin.name}`, ...(stored ? { spec: stored } : {}) });
    });

    const mode = resultLocal ? "local" : "api";
    const needs = Array.from(new Set(Object.values(prompt).map((n) => n.class_type)));
    const notes = [];
    if (resultLocal && resultApi) notes.push("both result inputs were wired; the recipe uses result_local (mode local)");
    if (missingTypes.size) notes.push("node types unknown to this server: " + Array.from(missingTypes).join(", "));
    if (instances.size) notes.push(`${instances.size} subgraph${instances.size > 1 ? "s" : ""} flattened`);
    return {
        kind: "comfy", mode, canvas: canvasId, result: resultLocal || resultApi, needs, settings, prompt,
        description: `Imported from ${meta.file} on ${meta.date}.` + (notes.length ? " " + notes.join("; ") + "." : ""),
        notes,
    };
}

// The canvas node's own widgets a recipe keeps (the crop's padding, target size, feather and multiple); everything
// else on it (canvas_state, the result sources, the run's values) is filled in at queue time (host.queueGenerate)
const CANVAS_PARAMS = ["padding", "target_size", "feather", "multiple_of"];

/**
 * A ComfyUI recipe -> the API-format prompt ComfyUI's page loads as a graph (docs/PLAN_COMFY_VIEW.md §2.3, item 35 V2):
 * the inverse of fromPrompt. The canvas node's result input (`result_local` in mode local, else `result`) is wired back
 * to `recipe.result`, every Settings row's input to the canvas node's `setting_<index>` output, the rest as stored.
 * @param {Recipe} recipe
 */
function toPrompt(recipe) {
    if (!recipe || !recipe.prompt || !recipe.canvas || !recipe.prompt[recipe.canvas]) throw new Error("This recipe is not a ComfyUI recipe (it holds no graph).");
    const prompt = JSON.parse(JSON.stringify(recipe.prompt));
    const canvasId = String(recipe.canvas);
    const canvas = prompt[canvasId];
    canvas.inputs = { ...(canvas.inputs || {}) };
    const m = /^(.+):(\d+)$/.exec(String(recipe.result || ""));
    if (!m || !prompt[m[1]]) throw new Error(`The recipe's result "${recipe.result || ""}" names no node of its graph.`);
    canvas.inputs[recipe.mode === "api" ? "result" : "result_local"] = [m[1], +m[2]];
    for (const s of recipe.settings || []) {
        if (!s || !s.index || !prompt[s.node] || !s.input) continue;
        prompt[s.node].inputs = { ...(prompt[s.node].inputs || {}), [s.input]: [canvasId, FIXED_OUTPUTS + s.index - 1] };
    }
    return prompt;
}

/**
 * An API-format prompt (Export (API), the node's own saved prompt, or the graph of ComfyUI's page) -> recipe fields.
 * `base`, the recipe the graph was opened from (item 35), gives back what an API prompt cannot hold: each Settings
 * row's value, label and spec where the same node input is still wired to the same slot's output.
 */
function fromPrompt(src, objectInfo, meta, base) {
    const prompt = JSON.parse(JSON.stringify(src));
    const canvasIds = Object.keys(prompt).filter((id) => prompt[id] && prompt[id].class_type === "InpaintCanvas");
    if (!canvasIds.length) throw new Error("This prompt has no Inpaint Canvas node.");
    if (canvasIds.length > 1) throw new Error("This prompt has more than one Inpaint Canvas node; a recipe needs exactly one.");
    const canvasId = canvasIds[0];
    const canvas = prompt[canvasId];
    const asRef = (v) => (Array.isArray(v) && v.length === 2 ? `${v[0]}:${v[1]}` : (typeof v === "string" && v ? v : null));
    const resultLocal = asRef(canvas.inputs.result_source_local) || asRef(canvas.inputs.result_local);
    const resultApi = asRef(canvas.inputs.result_source) || asRef(canvas.inputs.result);
    if (!resultLocal && !resultApi) throw new Error("The Inpaint Canvas node has no result_source / result_source_local; nothing would come back.");
    const kept = {};
    for (const k of CANVAS_PARAMS) if (typeof canvas.inputs[k] === "number") kept[k] = canvas.inputs[k];
    canvas.inputs = kept;
    const baseRow = (id, name, index) => (base && Array.isArray(base.settings) ? base.settings.find((s) => s && String(s.node) === String(id) && s.input === name && s.index === index) : null);
    const baseValue = (id, name) => {
        const n = base && base.prompt && base.prompt[id];
        const v = n && n.inputs ? n.inputs[name] : undefined;
        return Array.isArray(v) ? undefined : v;
    };
    const settings = [];
    for (const [id, node] of Object.entries(prompt)) {
        if (!node || !node.inputs) continue;
        for (const [name, v] of Object.entries(node.inputs)) {
            if (!Array.isArray(v) || String(v[0]) !== canvasId || +v[1] < FIXED_OUTPUTS) continue;
            const index = +v[1] - FIXED_OUTPUTS + 1;
            const info = objectInfo[node.class_type];
            const spec = info && info.input && ((info.input.required && info.input.required[name]) || (info.input.optional && info.input.optional[name])) || null;
            const was = baseRow(id, name, index);
            const value = was ? baseValue(id, name) : undefined;
            node.inputs[name] = value !== undefined ? value : specDefault(spec);
            const stored = was && was.spec !== undefined ? was.spec : storedSpec(spec, node.inputs[name]);
            settings.push({ index, node: id, input: name, label: was && was.label ? was.label : `${(node._meta && node._meta.title) || node.class_type} · ${name}`, ...(stored ? { spec: stored } : {}) });
        }
    }
    settings.sort((a, b) => a.index - b.index);
    const mode = resultLocal ? "local" : "api";
    const needs = Array.from(new Set(Object.values(prompt).map((n) => n.class_type)));
    const notes = [];
    if (resultLocal && resultApi) notes.push("both result inputs were wired; the recipe uses result_local (mode local)");
    return { kind: "comfy", mode, canvas: canvasId, result: resultLocal || resultApi, needs, settings, prompt, description: `Imported from ${meta.file} on ${meta.date}.` + (notes.length ? " " + notes.join("; ") + "." : ""), notes };
}

// What a recipe file keeps of the recipe a graph was opened from: the fields its graph does not hold
const GRAPH_KEEPS = ["description", "family", "task", "refs", "models"];

/**
 * The graph of ComfyUI's page -> a recipe to save (docs/PLAN_COMFY_VIEW.md §2.3, item 35 V3). `output` is the API
 * prompt and `workflow` the UI graph `app.graphToPrompt()` answered (untrusted: checked here); `base` the recipe the
 * window held. Without `name` the recipe is `base` overwritten (Save to recipe: its id, name and the fields a graph
 * does not hold stay); with `name` it is a new recipe under a fresh id among `ids` (Save as new recipe).
 * @param {{ output: any, workflow: any, objectInfo?: any, base?: Recipe | null, name?: string, ids?: string[], date: string }} a
 * @returns {Recipe}
 */
function fromGraph({ output, workflow, objectInfo, base, name, ids, date }) {
    if (!looksLikePrompt(output)) throw new Error("ComfyUI's page answered no graph Scumble can read.");
    const wf = workflow && typeof workflow === "object" && Array.isArray(workflow.nodes) && Array.isArray(workflow.links) ? workflow : null;
    const fields = fromPrompt(output, objectInfo || {}, { file: "ComfyUI", date }, base || undefined);
    const graph = { kind: "comfy", mode: fields.mode, canvas: fields.canvas, result: fields.result, needs: fields.needs, settings: fields.settings, prompt: fields.prompt, ...(wf ? { workflow: wf } : {}) };
    /** @type {Record<string, any>} */
    const kept = {};
    if (base) for (const k of GRAPH_KEEPS) if (/** @type {any} */ (base)[k] !== undefined) kept[k] = /** @type {any} */ (base)[k];
    if (!name) {
        if (!base || !base.id) throw new Error("This window holds no recipe to save into: use Save as new recipe.");
        return /** @type {Recipe} */ ({ id: base.id, name: base.name || base.id, ...kept, ...graph });
    }
    const clean = String(name).trim().slice(0, 80);
    if (!clean) throw new Error("A new recipe needs a name.");
    const taken = new Set(ids || []);
    const stem = slug(clean);
    let id = stem, n = 2;
    while (taken.has(id) || id === "flux2_klein_local") id = `${stem}_${n++}`;
    return /** @type {Recipe} */ ({ id, name: clean, ...kept, description: `Saved from ComfyUI on ${date}.`, ...graph });
}

// ---- a graph made for Comfy Cloud, marked by node titles (item 35 V5c, docs/RECIPES.md "Comfy Cloud recipes") -------
//
// A graph without the Inpaint Canvas node (exported from Comfy Cloud, or saved from the ComfyUI window there) becomes a
// cloud recipe when its nodes say where Scumble's pictures and values go, by title (any case, ":" or spaces between):
//   "Scumble crop"        a LoadImage: the crop (picture 0)
//   "Scumble picture <n>" a LoadImage: picture n of the node's batch order (1 the Original when it goes, else the
//                         first reference; then the references)
//   "Scumble mask"        a LoadImage: the selection, white where to repaint (its MASK output is turned into
//                         ImageToMask of the red channel, since the picture has no alpha)
//   "Scumble prompt" / "Scumble negative"  the node whose text input takes the prompt / the negative prompt
//   "Scumble seed"        the node whose seed (or noise_seed) input takes the seed
//   "Scumble result"      the SaveImage Scumble reads (needed only when the graph has more than one)

/** What a node title marks: { kind: "picture", k } / { kind: "mask" | "prompt" | "negative" | "seed" | "result" }, or null. */
function cloudMark(title) {
    const t = String(title || "").trim().toLowerCase().replace(/[\s:_-]+/g, " ");
    if (!t.startsWith("scumble ")) return null;
    const rest = t.slice(8).trim();
    if (rest === "crop") return { kind: "picture", k: 0 };
    const m = /^picture (\d{1,2})$/.exec(rest);
    if (m) return { kind: "picture", k: +m[1] };
    return ["mask", "prompt", "negative", "seed", "result"].includes(rest) ? { kind: rest } : null;
}

/** The input of a marked node a value goes into: the first of `names` it has, else its first string input. */
function markedInput(node, names) {
    const inputs = (node && node.inputs) || {};
    for (const n of names) if (n in inputs && !Array.isArray(inputs[n])) return n;
    if (names.includes("text")) for (const [k, v] of Object.entries(inputs)) if (typeof v === "string") return k;
    return null;
}

/**
 * A marked API prompt -> a Comfy Cloud recipe (the provider shape detach() makes: one variant, comfycloud, with
 * options.graph). `base` a cloud recipe it overwrites (its id, name, description and the Settings rows whose input is
 * still there), else `name` and `ids` give a new one. `workflow` (the UI graph) is kept to open it again as laid out.
 * @param {{ output: any, workflow?: any, base?: Recipe | null, name?: string, ids?: string[], date: string }} a
 * @returns {Recipe}
 */
function fromCloudGraph({ output, workflow, base, name, ids, date }) {
    if (!looksLikePrompt(output)) throw new Error("This is no graph Scumble can read.");
    /** @type {Record<string, any>} */
    const prompt = JSON.parse(JSON.stringify(output));
    if (Object.values(prompt).some((n) => n.class_type === "InpaintCanvas")) throw new Error("This graph holds the Inpaint Canvas node, which Comfy Cloud does not have: run it as a ComfyUI recipe (or make a cloud copy of that recipe).");
    /** @type {Record<string, [string, string][]>} */
    const values = {};
    let maxPicture = -1, maskId = null;
    const saves = [], marked = [];
    for (const [id, node] of Object.entries(prompt)) {
        const mark = cloudMark(node._meta && node._meta.title);
        if (node.class_type === "SaveImage") saves.push({ id, result: !!(mark && mark.kind === "result") });
        if (!mark || mark.kind === "result") continue;
        marked.push(`${mark.kind}${mark.k != null ? " " + mark.k : ""}`);
        if (mark.kind === "picture" || mark.kind === "mask") {
            if (node.class_type !== "LoadImage") throw new Error(`The node "${node._meta.title}" (${node.class_type}) must be a LoadImage.`);
            node.inputs = { ...(node.inputs || {}), image: "" };
            if (mark.kind === "picture") {
                node._meta.title = `scumble:picture:${mark.k}`;
                maxPicture = Math.max(maxPicture, mark.k);
            } else {
                if (maskId) throw new Error("Only one node may be titled \"Scumble mask\".");
                node._meta.title = "scumble:mask";
                maskId = id;
            }
            continue;
        }
        const input = mark.kind === "seed" ? markedInput(node, ["seed", "noise_seed"]) : markedInput(node, ["text", "prompt", "positive", "negative"]);
        if (!input) throw new Error(`The node "${node._meta.title}" (${node.class_type}) has no input the ${mark.kind} can go into.`);
        (values[mark.kind] = values[mark.kind] || []).push([id, input]);
    }
    if (!Object.values(prompt).some((n) => n._meta && n._meta.title === "scumble:picture:0")) {
        throw new Error("No node is titled \"Scumble crop\": title the LoadImage that takes Scumble's crop so (see docs/RECIPES.md, Comfy Cloud recipes).");
    }
    const save = saves.find((s) => s.result) || (saves.length === 1 ? saves[0] : null);
    if (!save) throw new Error(saves.length ? "The graph has several SaveImage nodes: title the one Scumble reads \"Scumble result\"." : "The graph has no SaveImage node, so no picture would come back.");
    if (maskId) {
        // the mask picture is opaque, white where to repaint: what read the LoadImage's MASK output reads its red channel
        let mid = "scumble_mask", n = 2;
        while (prompt[mid]) mid = `scumble_mask_${n++}`;
        let used = false;
        for (const node of Object.values(prompt)) for (const [k, v] of Object.entries(node.inputs || {})) if (Array.isArray(v) && String(v[0]) === maskId && +v[1] === 1) { node.inputs[k] = [mid, 0]; used = true; }
        if (used) prompt[mid] = { class_type: "ImageToMask", inputs: { image: [maskId, 0], channel: "red" } };
    }
    const needs = Array.from(new Set(Object.values(prompt).map((n) => n.class_type)));
    const wf = workflow && typeof workflow === "object" && Array.isArray(workflow.nodes) && Array.isArray(workflow.links) ? workflow : null;
    const keepRows = base && base.providers && base.providers.comfycloud && Array.isArray(base.providers.comfycloud.settings)
        ? base.providers.comfycloud.settings.filter((s) => { const i = String(s.key || "").indexOf("|"); return i > 0 && prompt[s.key.slice(0, i)]; }) : [];
    const options = { graph: prompt, pictures: maxPicture + 1, mask: !!maskId, values, needs, save: save.id, ...(wf ? { workflow: wf } : {}) };
    const variant = {
        model: "", input: maskId ? "fill" : "edit", options, settings: keepRows, limits: { ...LIMITS_DEFAULT },
        refs: { name: (base && base.providers && base.providers.comfycloud && base.providers.comfycloud.refs && base.providers.comfycloud.refs.name) || REF_NAME_DEFAULT },
        note: `A graph made for Comfy Cloud: ${marked.join(", ")}.`,
    };
    if (base) {
        if (!base.providers || !base.providers.comfycloud || !base.providers.comfycloud.options || !base.providers.comfycloud.options.graph) throw new Error(`"${base.name || base.id}" is no Comfy Cloud recipe: save this graph as a new recipe.`);
        const was = base.providers.comfycloud;
        return /** @type {Recipe} */ ({ id: base.id, name: base.name || base.id, kind: "provider", ...(base.description ? { description: base.description } : {}), ...(base.task ? { task: base.task } : {}), default: "comfycloud",
            providers: { comfycloud: { ...variant, model: was.model || base.name || base.id, limits: was.limits || variant.limits } } });
    }
    const clean = String(name || "").trim().slice(0, 80);
    if (!clean) throw new Error("A new recipe needs a name.");
    const taken = new Set(ids || []);
    const stem = slug(clean);
    let id = stem, k = 2;
    while (taken.has(id)) id = `${stem}_${k++}`;
    return /** @type {Recipe} */ ({ id, name: clean, kind: "provider", description: `Made for Comfy Cloud on ${date}.`, default: "comfycloud",
        providers: { comfycloud: { ...variant, model: clean } } });
}

/** Whether a UI workflow or an API prompt has a node titled for Scumble (cloudMark). */
function marksCloud(data) {
    if (looksLikePrompt(data)) return Object.values(data).some((n) => cloudMark(n && n._meta && n._meta.title));
    const wf = data && Array.isArray(data.nodes) ? data : data && data.workflow;
    if (!wf || !Array.isArray(wf.nodes)) return false;
    const all = [...wf.nodes, ...(((wf.definitions && wf.definitions.subgraphs) || []).flatMap((d) => d.nodes || []))];
    return all.some((n) => n && cloudMark(n.title));
}

/** Whether a UI workflow or an API prompt holds an Inpaint Canvas node (subgraph definitions included). */
function holdsCanvas(data) {
    if (looksLikePrompt(data)) return Object.values(data).some((n) => n.class_type === "InpaintCanvas");
    const wf = data && Array.isArray(data.nodes) ? data : data && data.workflow;
    if (!wf || !Array.isArray(wf.nodes)) return false;
    const all = [...wf.nodes, ...(((wf.definitions && wf.definitions.subgraphs) || []).flatMap((d) => d.nodes || []))];
    return all.some((n) => n && n.type === "InpaintCanvas");
}

// The Inpaint Canvas node's outputs (node repo nodes.py RETURN_NAMES) as detach() treats them
const CANVAS_OUTPUTS = ["crop_image", "crop_mask", "image", "mask", "stitch_info", "crop_width", "crop_height", "prompt", "control_image", "denoise", "seed", "mode", "negative"];
const DETACH_VALUES = /** @type {Record<number, string>} */ ({ 5: "width", 6: "height", 7: "prompt", 9: "denoise", 10: "seed", 11: "mode", 12: "negative" });
const DETACH_DEFAULTS = /** @type {Record<string, any>} */ ({ width: 1024, height: 1024, prompt: "", negative: "", seed: 0, denoise: 1, mode: "" });

/**
 * A ComfyUI recipe in the cloud form (docs/PLAN_COMFY_VIEW.md §2.4, item 35 V5): the same graph without the Inpaint
 * Canvas node, for a server that has none (Comfy Cloud, which takes no custom nodes). Scumble crops and stitches
 * itself, as for every provider, and the graph takes the pictures through core nodes:
 * - `crop_image` picked by `ImageFromBatch` (one picture at index k) -> that node becomes a `LoadImage` of picture k
 *   (0 the crop, then the Original where it goes, then the references: the node's own batch order, which is also the
 *   order the provider path sends them in); a picture past the run's last is the last one, as ImageFromBatch clamps;
 *   `crop_image` used whole -> picture 0 (the batch holds the crop alone without references), with a note;
 * - `crop_mask` -> `LoadImage` + `ImageToMask` (red: the mask picture is white where to repaint);
 * - crop_width, crop_height, prompt, negative, seed, denoise, mode -> values the run writes into those inputs;
 * - `image`, `mask` (full size), `stitch_info`, `control_image` -> refused by name;
 * - the result -> a `SaveImage` the run reads back; the Settings rows -> provider rows keyed "<node>|<input>".
 * The new nodes are titled "scumble:picture:<k>" and "scumble:mask" (the run finds them by title).
 * @param {Recipe} recipe
 * @returns {{ recipe: Recipe, notes: string[], needs: string[] }}
 */
function detach(recipe) {
    if (!recipe || recipe.kind === "provider" || !recipe.prompt || !recipe.canvas || !recipe.prompt[recipe.canvas]) throw new Error("Only a ComfyUI recipe can be turned into a Comfy Cloud recipe.");
    const canvasId = String(recipe.canvas);
    /** @type {Record<string, any>} */
    const prompt = JSON.parse(JSON.stringify(recipe.prompt));
    delete prompt[canvasId];
    const m = /^(.+):(\d+)$/.exec(String(recipe.result || ""));
    if (!m || !prompt[m[1]]) throw new Error(`The recipe's result "${recipe.result || ""}" names no node of its graph.`);
    const taken = new Set(Object.keys(recipe.prompt));
    const newId = (/** @type {string} */ stem) => { let id = `scumble_${stem}`, n = 2; while (taken.has(id)) id = `scumble_${stem}_${n++}`; taken.add(id); return id; };
    /** @type {Record<string, [string, string][]>} */
    const values = {};
    const notes = [];
    let maxPicture = 0, maskLink = null;
    const loadPicture = (k) => ({ class_type: "LoadImage", inputs: { image: "" }, _meta: { title: `scumble:picture:${k}` } });
    let whole = null;
    for (const [id, node] of Object.entries(recipe.prompt)) {
        if (id === canvasId || !node || !node.inputs) continue;
        for (const [name, v] of Object.entries(node.inputs)) {
            if (!Array.isArray(v) || String(v[0]) !== canvasId) continue;
            const slot = +v[1];
            const what = CANVAS_OUTPUTS[slot] || `setting_${slot - FIXED_OUTPUTS + 1}`;
            if (slot === 0) {
                const pick = node.class_type === "ImageFromBatch" && name === "image";
                const len = pick ? +(node.inputs.length == null ? 1 : node.inputs.length) : 0;
                if (pick && len === 1 && Number.isFinite(+node.inputs.batch_index || 0)) {
                    const k = Math.max(0, Math.round(+node.inputs.batch_index || 0));
                    prompt[id] = loadPicture(k);     // same id: what read the pick reads the picture
                    maxPicture = Math.max(maxPicture, k);
                } else if (pick) {
                    throw new Error(`The node ${id} (ImageFromBatch) takes ${len} pictures of crop_image at once; a Comfy Cloud recipe takes them one by one.`);
                } else {
                    if (!whole) { whole = newId("picture_0"); prompt[whole] = loadPicture(0); }
                    prompt[id].inputs[name] = [whole, 0];
                    notes.push(`${node.class_type} ${id} takes crop_image whole: it gets the crop alone`);
                }
            } else if (slot === 1) {
                if (!maskLink) {
                    const img = newId("mask_picture");
                    prompt[img] = { class_type: "LoadImage", inputs: { image: "" }, _meta: { title: "scumble:mask" } };
                    const mid = newId("mask");
                    prompt[mid] = { class_type: "ImageToMask", inputs: { image: [img, 0], channel: "red" } };
                    maskLink = [mid, 0];
                }
                prompt[id].inputs[name] = maskLink;
            } else if (DETACH_VALUES[slot]) {
                const key = DETACH_VALUES[slot];
                (values[key] = values[key] || []).push([id, name]);
                prompt[id].inputs[name] = DETACH_DEFAULTS[key];
            } else {
                throw new Error(`The node ${id} (${node.class_type}) reads the Inpaint Canvas node's ${what}, which a Comfy Cloud recipe cannot give.`);
            }
        }
    }
    const save = newId("save");
    prompt[save] = { class_type: "SaveImage", inputs: { images: [m[1], +m[2]], filename_prefix: "scumble" } };
    const canvasInputs = recipe.prompt[canvasId].inputs || {};
    const step = +canvasInputs.multiple_of > 0 ? +canvasInputs.multiple_of : 16;
    const max = +canvasInputs.target_size > 0 ? +canvasInputs.target_size : 2048;
    const rows = (recipe.settings || []).filter((s) => s && s.node && s.input && prompt[s.node]).map((s) => ({ index: s.index, key: `${s.node}|${s.input}`, label: s.label || `${s.node} · ${s.input}`, ...(s.spec !== undefined ? { spec: s.spec } : {}) }));
    const needs = Array.from(new Set(Object.values(prompt).map((n) => n.class_type)));
    const name = recipe.name || recipe.id;
    /** @type {Recipe} */
    const out = {
        id: `${recipe.id}_cloud`, name: `${name} (Comfy Cloud)`, kind: "provider",
        description: `${name} without the Inpaint Canvas node, run on Comfy Cloud; Scumble crops and stitches.`,
        ...(recipe.task ? { task: recipe.task } : {}),
        default: "comfycloud",
        providers: {
            comfycloud: {
                model: name, input: maskLink ? "fill" : "edit",
                options: { graph: prompt, pictures: maxPicture + 1, mask: !!maskLink, values, needs, save },
                settings: rows,
                limits: { ...LIMITS_DEFAULT, max, step, aspects: [] },
                refs: { name: (recipe.refs && recipe.refs.name) || REF_NAME_DEFAULT },
                note: "A ComfyUI recipe without its Inpaint Canvas node, on Comfy Cloud's GPUs.",
            },
        },
    };
    return { recipe: out, notes, needs };
}

/** A provider recipe names its variants in a `providers` map, or, in the old shape, one `provider`. */
function hasVariants(data) {
    const p = data.providers;
    return !!(data.provider || (p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).length));
}

function looksLikePrompt(obj) {
    const vals = Object.values(obj || {});
    return vals.length > 0 && vals.every((v) => v && typeof v === "object" && typeof v.class_type === "string");
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
    let recipe;
    // a graph made for Comfy Cloud (item 35 V5c): no Inpaint Canvas node, its nodes marked by title
    const graphLike = data && (Array.isArray(data.nodes) || looksLikePrompt(data) || (data.workflow && Array.isArray(data.workflow.nodes)));
    if (graphLike && !data.kind && !holdsCanvas(data)) {
        if (!marksCloud(data)) throw new Error("This graph has no Inpaint Canvas node. A graph made for Comfy Cloud needs its nodes titled for Scumble: \"Scumble crop\" on the LoadImage of the crop, and more (docs/RECIPES.md, Comfy Cloud recipes).");
        const stem0 = path.basename(file).replace(/\.json$/i, "");
        let output = data, wf = null;
        if (!looksLikePrompt(data)) {
            wf = Array.isArray(data.nodes) ? data : data.workflow;
            const info = (opts && opts.cloudObjectInfo ? await opts.cloudObjectInfo() : null) || objectInfo;
            if (!info) throw new Error("Reading a workflow saved from the ComfyUI UI needs the node definitions: store a Comfy Cloud key (or connect a ComfyUI), or export the workflow in API format.");
            output = fromWorkflow(wf, info, meta, { noCanvas: true }).prompt;
        }
        const ids = (await list(opts && opts.builtinDir ? opts.builtinDir : path.join(__dirname, "..", "..", "recipes"))).map((r) => r.id);
        const made = fromCloudGraph({ output, workflow: wf, name: stem0, ids, date: meta.date });
        const savedCloud = await save(made);
        return normalize({ ...made, file: path.basename(savedCloud), source: "user" });
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
    const stem = path.basename(file).replace(/\.json$/i, "");
    recipe.id = recipe.id && data.kind ? slug(recipe.id) : slug(stem);
    recipe.name = recipe.name || stem;
    // never shadow a shipped recipe silently
    recipe.id = recipe.id.replace(/^flux2_klein_local$/, "flux2_klein_local_imported");
    const saved = await save(recipe);
    // the file keeps the shape it was written in; the caller gets the recipe as list() serves it
    return normalize({ ...recipe, file: path.basename(saved), source: "user" });
}

module.exports = { list, remove, save, importFile, fromWorkflow, fromPrompt, toPrompt, fromGraph, fromCloudGraph, cloudMark, detach, userDir, _normalize: normalize };
