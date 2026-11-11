// @ts-check
// toPrompt, fromPrompt, fromGraph, the Comfy Cloud graph, roles and detach, looksLikePrompt: moved out of recipes.js (item 56 S11, docs/PLAN_SPLIT.md), text unchanged.
"use strict";

const { REF_NAME_DEFAULT, validRefName } = require("./providers/refs");
const { FIXED_OUTPUTS, LIMITS_DEFAULT, backendOutputName, localBoxes, lorasOf, shippedPresets, slug, tailOutputs, withoutUpsampler } = require("./recipes_store");
const { specDefault, storedSpec } = require("./recipes_workflow");

/** @typedef {import("./recipes.js").Recipe} Recipe */
/** @typedef {import("./recipes.js").LoraDecl} LoraDecl */

/** The Realism Pass's label (renderer/editor/realism.js LABEL; tools/recipes_test.js checks they agree). */
const PASS_LABEL = "Realism Pass (Windows only, RTX only)";

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
 * row's value, label and spec where the same node input is still wired to the same slot's output. `opts.outputNames`:
 * the canvas node's output names in the slot order the prompt uses (the page's graph shows the tail outputs right
 * after the connected settings); without them a slot is read in the backend's order (tailOutputs).
 */
function fromPrompt(src, objectInfo, meta, base, opts = {}) {
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
    const names = opts && Array.isArray(opts.outputNames) ? opts.outputNames : null;
    const tailNotes = tailOutputs(prompt, canvasId, (slot) => (names && typeof names[slot] === "string" && names[slot] ? names[slot] : backendOutputName(slot)));
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
    const notes = [...tailNotes];
    if (resultLocal && resultApi) notes.push("both result inputs were wired; the recipe uses result_local (mode local)");
    return { kind: "comfy", mode, canvas: canvasId, result: resultLocal || resultApi, needs, settings, prompt, description: `Imported from ${meta.file} on ${meta.date}.` + (notes.length ? " " + notes.join("; ") + "." : ""), notes };
}

// What a recipe file keeps of the recipe a graph was opened from: the fields its graph does not hold
const GRAPH_KEEPS = ["description", "family", "task", "refs", "models", "presets", "factor", "limits", "boxes", "edit", "upsampler", "loras", "newImage", "promptRequired", "needsVersion"];

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
    // the canvas node's output names in the page's slot order: the tail outputs sit right after the connected settings
    const canvasUi = wf ? wf.nodes.find((n) => n && n.type === "InpaintCanvas" && Array.isArray(n.outputs)) : null;
    const outputNames = canvasUi ? canvasUi.outputs.map((o) => (o && typeof o.name === "string" ? o.name : null)) : null;
    const fields = fromPrompt(output, objectInfo || {}, { file: "ComfyUI", date }, base || undefined, { outputNames });
    const graph = { kind: "comfy", mode: fields.mode, canvas: fields.canvas, result: fields.result, needs: fields.needs, settings: fields.settings, prompt: fields.prompt, ...(wf ? { workflow: wf } : {}) };
    /** @type {Record<string, any>} */
    const kept = {};
    if (base) for (const k of GRAPH_KEEPS) if (/** @type {any} */ (base)[k] !== undefined) kept[k] = /** @type {any} */ (base)[k];
    // what the held recipe's fields say must still hold for the graph saved: its shipped presets only for the rows the
    // graph keeps, and the Realism Pass's task only while the graph still holds the pack's settings node
    if (kept.presets) {
        const rows = new Set((fields.settings || []).map((s) => `${s.node}:${s.input}`));
        const presets = shippedPresets(kept.presets).map((p) => ({ name: p.name, values: Object.fromEntries(Object.entries(p.values).filter(([k]) => rows.has(k))) }))
            .filter((p) => Object.keys(p.values).length);
        if (presets.length) kept.presets = presets; else delete kept.presets;
    }
    if (kept.task === "pass" && !Object.values(fields.prompt || {}).some((n) => n && n.class_type === "DLSS5Settings")) delete kept.task;
    // the boxes' input only while the saved graph still feeds it the canvas node's plain prompt (a node renamed, a link
    // moved or a Settings row on it: no box rows go there)
    if (kept.boxes !== undefined && !localBoxes(/** @type {Recipe} */ ({ id: "", ...graph, task: kept.task, boxes: kept.boxes })).boxes) delete kept.boxes;
    // the LoRAs' model source only while the saved graph still holds that node (its family stays)
    if (kept.loras !== undefined) {
        const got = lorasOf(kept.loras, fields.prompt, fields.canvas);
        if (got.loras === undefined) delete kept.loras; else kept.loras = got.loras;
    }
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
 * `promoted` (promotedOf of the UI graph) tells a reading without titles the template's own controls.
 * @param {{ output: any, workflow?: any, base?: Recipe | null, name?: string, ids?: string[], date: string, promoted?: { name: string, label?: string, node: string, input: string }[] }} a
 * @returns {Recipe}
 */
function fromCloudGraph({ output, workflow, base, name, ids, date, promoted }) {
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
        if (RESULT_NODES.has(node.class_type)) saves.push({ id, result: !!(mark && mark.kind === "result") });
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
    let saveId = null, found = null, textOnly = false;
    if (!marked.length) {
        // nobody titled it (a Comfy template as it is): the roles read from the graph (detectRoles), its subgraph
        // controls first; the bar and the recipe's note say what was read, and titles correct a wrong guess. A graph
        // that takes no picture makes new images (V6 step 5): its size goes where its width and height controls point
        const controls = promoted || promotedOf(workflow);
        const d = detectRoles(prompt, controls, { text: true });
        if (!d.pictures.length) {
            textOnly = true;
            const size = sizeTargets(prompt, controls);
            if (!size.width.length || !size.height.length) throw new Error("This graph takes no picture (for an edit, title the LoadImage that takes Scumble's crop \"Scumble crop\"), and Scumble cannot tell where the size of a new image goes: give it width and height controls (a subgraph's) or an Empty Latent Image node.");
            d.values.width = size.width;
            d.values.height = size.height;
            d.found.push(`size: ${size.width.concat(size.height).map(([id, k]) => `${prompt[id].class_type} ${id}.${k}`).join(", ")}`);
        }
        d.pictures.forEach((id, k) => {
            prompt[id]._meta = { ...(prompt[id]._meta || {}), title: `scumble:picture:${k}` };
            prompt[id].inputs = { ...(prompt[id].inputs || {}), image: "" };
        });
        maxPicture = d.pictures.length - 1;
        if (d.maskFrom) {
            // the graph read its mask from a picture's MASK output (painted in ComfyUI): Scumble's selection comes in as
            // a picture of its own, white where to repaint, through ImageToMask
            let lid = "scumble_mask_picture", n2 = 2;
            while (prompt[lid]) lid = `scumble_mask_picture_${n2++}`;
            prompt[lid] = { class_type: "LoadImage", inputs: { image: "" }, _meta: { title: "scumble:mask" } };
            let mid = "scumble_mask", n3 = 2;
            while (prompt[mid]) mid = `scumble_mask_${n3++}`;
            prompt[mid] = { class_type: "ImageToMask", inputs: { image: [lid, 0], channel: "red" } };
            for (const node of Object.values(prompt)) for (const [k, v] of Object.entries(node.inputs || {})) if (Array.isArray(v) && String(v[0]) === d.maskFrom && +v[1] === 1) node.inputs[k] = [mid, 0];
            maskId = lid;
        }
        Object.assign(values, d.values);
        saveId = d.save;
        found = d.found;
    } else {
        if (!Object.values(prompt).some((n) => n._meta && n._meta.title === "scumble:picture:0")) {
            throw new Error("No node is titled \"Scumble crop\": title the LoadImage that takes Scumble's crop so (see docs/RECIPES.md, Comfy Cloud recipes).");
        }
        const save = saves.find((s) => s.result) || (saves.length === 1 ? saves[0] : null);
        if (!save) throw new Error(saves.length ? "The graph has several SaveImage nodes: title the one Scumble reads \"Scumble result\"." : "The graph has no SaveImage node, so no picture would come back.");
        saveId = save.id;
        // Scumble's own titles (a cloud copy, an earlier save) mark only the pictures: a value no title names comes from
        // the recipe saved before while its node and input are still there, else it is read as for an untitled graph
        const was = (base && base.providers && base.providers.comfycloud && base.providers.comfycloud.options && base.providers.comfycloud.options.values) || {};
        /** @type {Record<string, [string, string][]> | null} */
        let read = null;
        for (const k of ["prompt", "negative", "seed", "width", "height"]) {
            if (values[k]) continue;
            const keep = (Array.isArray(was[k]) ? was[k] : []).filter(([id, input]) => prompt[id] && prompt[id].inputs && input in prompt[id].inputs && !Array.isArray(prompt[id].inputs[input]));
            if (keep.length) { values[k] = keep; continue; }
            if (k === "width" || k === "height") continue;
            if (read === null) { try { read = /** @type {Record<string, [string, string][]>} */ (detectRoles(prompt, promoted || promotedOf(workflow)).values || {}); } catch (_) { read = {}; } }
            if (read[k]) values[k] = read[k];
        }
    }
    if (maskId) {
        // the mask picture is opaque, white where to repaint: what read the LoadImage's MASK output reads its red channel
        let mid = "scumble_mask", n = 2;
        while (prompt[mid]) mid = `scumble_mask_${n++}`;
        let used = false;
        for (const node of Object.values(prompt)) for (const [k, v] of Object.entries(node.inputs || {})) if (Array.isArray(v) && String(v[0]) === maskId && +v[1] === 1) { node.inputs[k] = [mid, 0]; used = true; }
        if (used) prompt[mid] = { class_type: "ImageToMask", inputs: { image: [maskId, 0], channel: "red" } };
    }
    // only what leads to the result stays (a preview, a before / after compare and what fed only them go): a run on
    // Comfy Cloud computes the picture Scumble reads and nothing else, and a preview node's own widget (ImageCompare's
    // compare_view) never fails the graph there; a value whose node went is dropped with it
    if (saveId && prompt[saveId]) {
        // (what Scumble writes stays, wired or not: its picture and mask nodes, which set the picture count, and every
        // node a value goes into)
        const marks = Object.keys(prompt).filter((id) => /^scumble:(picture:\d+|mask)$/.test(String((prompt[id]._meta || {}).title || "")) || Object.values(values).some((pairs) => pairs.some(([x]) => String(x) === id)));
        const keep = new Set([String(saveId), ...marks]);
        const todo = [String(saveId), ...marks];
        while (todo.length) {
            const n = prompt[todo.pop()];
            for (const v of Object.values((n && n.inputs) || {})) if (Array.isArray(v) && prompt[v[0]] && !keep.has(String(v[0]))) { keep.add(String(v[0])); todo.push(String(v[0])); }
        }
        for (const id of Object.keys(prompt)) if (!keep.has(id)) delete prompt[id];
        for (const k of Object.keys(values)) { values[k] = values[k].filter(([id]) => prompt[id]); if (!values[k].length) delete values[k]; }
    }
    const needs = Array.from(new Set(Object.values(prompt).map((n) => n.class_type)));
    const wf = workflow && typeof workflow === "object" && Array.isArray(workflow.nodes) && Array.isArray(workflow.links) ? workflow : null;
    const keepRows = base && base.providers && base.providers.comfycloud && Array.isArray(base.providers.comfycloud.settings)
        ? base.providers.comfycloud.settings.filter((s) => { const i = String(s.key || "").indexOf("|"); return i > 0 && prompt[s.key.slice(0, i)]; }) : [];
    const options = { graph: prompt, pictures: maxPicture + 1, mask: !!maskId, values, needs, save: saveId, ...(wf ? { workflow: wf } : {}) };
    const variant = {
        model: "", input: maskId ? "fill" : "edit", options, settings: keepRows, limits: { ...LIMITS_DEFAULT },
        refs: { name: (base && base.providers && base.providers.comfycloud && base.providers.comfycloud.refs && base.providers.comfycloud.refs.name) || REF_NAME_DEFAULT },
        note: found ? `Read from the graph: ${found.join("; ")}.` : `A graph made for Comfy Cloud: ${marked.join(", ")}.`,
    };
    // a text-to-image graph makes new images only (Generate new): its graph is the variant's, the text route names it
    const shaped = (v) => (textOnly ? { ...v, edit: false, text: { model: v.model } } : v);
    if (base) {
        if (!base.providers || !base.providers.comfycloud || !base.providers.comfycloud.options || !base.providers.comfycloud.options.graph) throw new Error(`"${base.name || base.id}" is no Comfy Cloud recipe: save this graph as a new recipe.`);
        const was = base.providers.comfycloud;
        return /** @type {Recipe} */ ({ id: base.id, name: base.name || base.id, kind: "provider", ...(base.description ? { description: base.description } : {}), ...(base.task ? { task: base.task } : {}), default: "comfycloud",
            providers: { comfycloud: shaped({ ...variant, model: was.model || base.name || base.id, limits: was.limits || variant.limits }) } });
    }
    const clean = String(name || "").trim().slice(0, 80);
    if (!clean) throw new Error("A new recipe needs a name.");
    const taken = new Set(ids || []);
    const stem = slug(clean);
    let id = stem, k = 2;
    while (taken.has(id)) id = `${stem}_${k++}`;
    return /** @type {Recipe} */ ({ id, name: clean, kind: "provider", description: `Made for Comfy Cloud on ${date}.`, default: "comfycloud",
        providers: { comfycloud: shaped({ ...variant, model: clean }) } });
}

/**
 * Where the size of a new image goes in a text-to-image graph: the inputs its width and height controls drive (by name
 * or label), else the width and height of its Empty...Latent... nodes. A control's input fed by a link (a resolution
 * node) means every input that output feeds: each becomes a literal (1024 until a run writes its own) and the nodes
 * left without a consumer go (a resolution selector the node list may not even know). Changes `prompt`.
 * @param {Record<string, any>} prompt
 * @param {{ name: string, label?: string, node: string, input: string }[]} promoted
 */
function sizeTargets(prompt, promoted) {
    const out = { width: /** @type {[string, string][]} */ ([]), height: /** @type {[string, string][]} */ ([]) };
    const fed = new Set();
    for (const k of /** @type {("width" | "height")[]} */ (["width", "height"])) {
        const re = new RegExp(`^${k}$`, "i");
        let pairs = (promoted || []).filter((p) => (re.test(p.name) || (p.label && re.test(p.label))) && prompt[p.node] && prompt[p.node].inputs && p.input in prompt[p.node].inputs).map((p) => [p.node, p.input]);
        if (!pairs.length) pairs = Object.keys(prompt).filter((id) => /^Empty.*Latent/i.test(prompt[id].class_type) && prompt[id].inputs && k in prompt[id].inputs).map((id) => [id, k]);
        const all = new Map();
        for (const [id, input] of pairs) {
            const v = prompt[id].inputs[input];
            if (!Array.isArray(v)) { all.set(`${id}|${input}`, [id, input]); continue; }
            fed.add(String(v[0]));
            for (const [nid, n] of Object.entries(prompt)) for (const [kk, vv] of Object.entries(n.inputs || {})) if (Array.isArray(vv) && String(vv[0]) === String(v[0]) && +vv[1] === +v[1]) all.set(`${nid}|${kk}`, [nid, kk]);
        }
        out[k] = Array.from(all.values());
        for (const [id, input] of out[k]) if (Array.isArray(prompt[id].inputs[input])) prompt[id].inputs[input] = 1024;
    }
    // the size's former sources, and what fed only them, when nothing reads them any more
    const used = (id) => Object.values(prompt).some((n) => Object.values(n.inputs || {}).some((v) => Array.isArray(v) && String(v[0]) === id));
    const queue = Array.from(fed);
    while (queue.length) {
        const id = String(queue.pop());
        if (!prompt[id] || OUTPUT_ONLY.test(prompt[id].class_type) || used(id)) continue;
        const ups = Object.values(prompt[id].inputs || {}).filter(Array.isArray).map((v) => String(v[0]));
        delete prompt[id];
        queue.push(...ups);
    }
    return out;
}

// ---- the roles of a graph nobody titled (item 35 V6): Comfy's image-edit templates saved as they are -----------------

const OUTPUT_ONLY = /^(PreviewImage|PreviewAny|MaskPreview|ImageCompare|SaveImage|SaveImageAdvanced|SaveAnimatedWEBP|SaveAnimatedPNG)$/;
const RESULT_NODES = new Set(["SaveImage", "SaveImageAdvanced"]);
const naturally = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

/**
 * The controls a UI workflow's subgraphs show (their promoted inputs: a template's prompt, seed, steps ...), as
 * { name, label, node, input } with the node's flat id ("<instance>:<inner>", as ComfyUI flattens a graph for a run) and
 * the inner input the control drives; `label` is what the control shows when it differs from its name (Qwen Image Edit
 * 2509's "prompt_1" shows "negative_prompt"). Muted and bypassed instances show none. Needs no node definitions.
 */
function promotedOf(wf) {
    const out = [];
    if (!wf || !Array.isArray(wf.nodes)) return out;
    const defs = new Map(((wf.definitions && wf.definitions.subgraphs) || []).map((d) => [d.id, d]));
    const walk = (nodes, prefix, depth) => {
        if (depth > 8) return;
        for (const n of nodes || []) {
            const def = n && defs.get(n.type);
            if (!def || n.mode === 2 || n.mode === 4) continue;
            const inner = new Map((def.nodes || []).map((x) => [String(x.id), x]));
            const at = `${prefix}${n.id}:`;
            for (const raw of def.links || []) {
                const l = Array.isArray(raw) ? { origin: raw[1], originSlot: raw[2], target: raw[3], targetSlot: raw[4] } : { origin: raw.origin_id, originSlot: raw.origin_slot, target: raw.target_id, targetSlot: raw.target_slot };
                if (String(l.origin) !== "-10") continue;
                const slot = def.inputs && def.inputs[+l.originSlot];
                const name = slot && slot.name;
                const tn = inner.get(String(l.target));
                const input = tn && tn.inputs && tn.inputs[+l.targetSlot] && tn.inputs[+l.targetSlot].name;
                if (name && input) out.push({ name: String(name), label: slot.label ? String(slot.label) : "", node: at + String(l.target), input: String(input) });
            }
            walk(def.nodes, at, depth + 1);
        }
    };
    walk(wf.nodes, "", 0);
    return out;
}

/**
 * Where Scumble's pictures and values go in an API prompt nobody titled for it (cloudMark): the LoadImage nodes in the
 * order their consumers number them (image_1 / image1 / image before image_2 ...; the node id breaks a tie) as pictures
 * 0, 1, ...; a LoadImage whose MASK output is read as the mask; the prompt, the negative and the seed from the
 * subgraph controls of that name or label (`promoted`, promotedOf), else from the encoders' text inputs (positive when
 * their conditioning reaches a "positive" input or no "negative" one) and the seed inputs; with no negative found, the
 * `negative_prompt` input of a node the prompt goes into; the one SaveImage(Advanced) as the result. `opts.text`: a
 * graph that takes no picture is fine (a text-to-image graph, V6 step 5; `pictures` is empty). Returns
 * { pictures, maskFrom, values, save, found } or throws with what it could not tell.
 */
function detectRoles(prompt, promoted, opts = {}) {
    const ids = Object.keys(prompt);
    const users = new Map();   // "<id>|<slot>" -> [{ node, cls, input }]
    for (const [nid, n] of Object.entries(prompt)) {
        for (const [k, v] of Object.entries((n && n.inputs) || {})) {
            if (!Array.isArray(v)) continue;
            const key = `${v[0]}|${+v[1]}`;
            if (!users.has(key)) users.set(key, []);
            users.get(key).push({ node: nid, cls: n.class_type, input: k });
        }
    }
    const consumers = (id, slot) => users.get(`${id}|${slot}`) || [];
    const anyConsumers = (id) => { const out = []; for (const [key, list] of users) if (key.startsWith(id + "|")) out.push(...list); return out; };
    const found = [];
    const label = (id) => `${prompt[id].class_type} ${id}`;

    // the pictures
    const rank = (id) => {
        let best = Infinity;
        for (const c of consumers(id, 0)) {
            if (OUTPUT_ONLY.test(c.cls)) continue;
            const m = /(\d+)$/.exec(c.input);
            best = Math.min(best, m ? +m[1] : 1);
        }
        return best;
    };
    const loads = ids.filter((id) => prompt[id].class_type === "LoadImage" && (consumers(id, 0).some((c) => !OUTPUT_ONLY.test(c.cls)) || consumers(id, 1).length));
    loads.sort((a, b) => rank(a) - rank(b) || naturally(a, b));
    if (!loads.length && !opts.text) throw new Error("No LoadImage takes a picture into this graph, so Scumble cannot tell where its crop goes: title one \"Scumble crop\".");
    loads.forEach((id, k) => found.push(`${k === 0 ? "crop" : "picture " + k}: ${label(id)}`));
    const masks = loads.filter((id) => consumers(id, 1).length);
    if (masks.length > 1) throw new Error(`Several LoadImage nodes give a mask (${masks.join(", ")}): title the one Scumble's selection goes into "Scumble mask".`);
    if (masks.length) found.push(`mask: the MASK of ${label(masks[0])}`);

    // the prompt, the negative, the seed: the template's own controls first
    // a control whose label names a prompt role is that role whatever its name ("text" shown as "negative_prompt")
    const ROLE_LABEL = /^(prompt|text|positive|positive_prompt|negative|negative_prompt)$/i;
    const promotedTo = (re, type) => (promoted || []).filter((p) => (p.label && ROLE_LABEL.test(p.label) ? re.test(p.label) : re.test(p.name) || (p.label && re.test(p.label))) && prompt[p.node] && prompt[p.node].inputs && typeof prompt[p.node].inputs[p.input] === type).map((p) => [p.node, p.input]);
    let pos = promotedTo(/^(prompt|text|positive|positive_prompt)$/i, "string");
    let neg = promotedTo(/^(negative|negative_prompt)$/i, "string");
    let seed = promotedTo(/^(noise_)?seed$/i, "number");
    // the encoders' text inputs when the controls name no prompt, or the negative side alone when they name the prompt
    // and no negative (Flux.2 Klein's negative encoder has no control of its own)
    const negativeOnly = pos.length > 0;
    if (!pos.length || !neg.length) {
        // where a linked text starts: four hops along string links at most, to a node holding the text itself
        // (a switch, ComfySwitchNode, is followed along the branch it takes: its literal, or a boolean primitive's value;
        // a prompt enhancer along its prompt input; six hops at most)
        const boolOf = (v) => (typeof v === "boolean" ? v : Array.isArray(v) && prompt[v[0]] && typeof (prompt[v[0]].inputs || {}).value === "boolean" ? prompt[v[0]].inputs.value : false);
        const textSource = (link) => {
            let at = link;
            for (let hop = 0; hop < 6 && Array.isArray(at) && prompt[at[0]]; hop++) {
                const src = prompt[at[0]], inputs = src.inputs || {};
                if (typeof inputs.value === "string") return [String(at[0]), "value"];
                if (typeof inputs.text === "string" && !Object.values(inputs).some(Array.isArray)) return [String(at[0]), "text"];
                if ("on_true" in inputs || "on_false" in inputs) {
                    const pick = boolOf(inputs.switch) ? "on_true" : "on_false";
                    if (typeof inputs[pick] === "string") return [String(at[0]), pick];
                    at = inputs[pick];
                    continue;
                }
                // (a text shown on its way: PreviewAny's source)
                at = Object.entries(inputs).filter(([kk, vv]) => Array.isArray(vv) && /^(string|text|value|prompt|source)/i.test(kk)).map(([, vv]) => vv).pop();
            }
            return null;
        };
        // the encoders' text inputs, by where their conditioning goes: the first hop that reaches an input named
        // "positive" or "negative" decides (further on, a node's positive output reaches the sampler's positive input
        // whatever came in as negative); positive when that hop holds both, or when none is ever reached
        const side = (start) => {
            let edge = [start];
            const seen = new Set([start]);
            for (let depth = 0; depth < 8 && edge.length; depth++) {
                const next = [];
                let positive = false, negative = false;
                for (const id of edge) {
                    for (const c of anyConsumers(id)) {
                        if (c.input === "positive") positive = true;
                        if (c.input === "negative") negative = true;
                        if (!seen.has(c.node)) { seen.add(c.node); next.push(c.node); }
                    }
                }
                if (positive) return "positive";
                if (negative) return "negative";
                edge = next;
            }
            return "positive";
        };
        for (const id of ids) {
            const n = prompt[id];
            // a conditioning node with a prompt of its own (P-H3-Image's PH3ImageConditioning) is an encoder too, by its
            // prompt input alone
            const conditioner = /Conditioning$/.test(n.class_type) && !!n.inputs && "prompt" in n.inputs;
            if (!conditioner && (!/Encode|Text/.test(n.class_type) || /Generate|Preview|Show|Note|Save/.test(n.class_type))) continue;
            for (const [k, v] of Object.entries(n.inputs || {})) {
                if (conditioner && k !== "prompt") continue;
                // a text that comes in by link (a text node, a concatenation of a fixed word and one): the text node at its end
                const at = typeof v === "string" ? [id, k] : Array.isArray(v) && /^(text|prompt|positive)$/i.test(k) ? textSource(v) : null;
                if (!at) continue;
                if (/^negative(_prompt)?$/i.test(k)) { neg.push(at); continue; }
                if (!/^(text|prompt|positive)$/i.test(k)) continue;
                // (the negative side alone never takes the prompt's own encoder: Flux.1 Kontext zeroes the prompt's
                // conditioning for its negative, and a negative written there would replace the prompt)
                if (negativeOnly && pos.some(([x, y]) => x === id || (x === at[0] && y === at[1]))) continue;
                if (side(id) === "negative") neg.push(at);
                else if (!negativeOnly) pos.push(at);
            }
        }
    }
    // an encoder with a negative field of its own (Mage Flow, Boogu): the negative goes beside the prompt
    if (!neg.length) for (const [id] of pos) if (typeof (prompt[id].inputs || {}).negative_prompt === "string" && !neg.some(([x]) => x === id)) neg.push([id, "negative_prompt"]);
    if (!seed.length) for (const id of ids) for (const [k, v] of Object.entries(prompt[id].inputs || {})) if (/^(noise_)?seed$/.test(k) && typeof v === "number") seed.push([id, k]);
    if (pos.length) found.push(`prompt: ${pos.map(([id, k]) => `${label(id)}.${k}`).join(", ")}`);
    if (neg.length) found.push(`negative: ${neg.map(([id, k]) => `${label(id)}.${k}`).join(", ")}`);
    if (seed.length) found.push(`seed: ${seed.map(([id, k]) => `${label(id)}.${k}`).join(", ")}`);

    // the result
    const saves = ids.filter((id) => RESULT_NODES.has(prompt[id].class_type));
    const fed = (id) => { const v = prompt[id].inputs && prompt[id].inputs.images; return Array.isArray(v) && prompt[v[0]] && prompt[v[0]].class_type === "LoadImage"; };
    const real = saves.filter((id) => !fed(id));
    // several: the one a sampler made (a sampler within twelve hops upstream), when that is one
    const sampled = (id) => {
        let edge = [id];
        const seen = new Set(edge);
        for (let depth = 0; depth < 12 && edge.length; depth++) {
            const next = [];
            for (const x of edge) {
                for (const v of Object.values((prompt[x] && prompt[x].inputs) || {})) {
                    if (!Array.isArray(v) || seen.has(String(v[0])) || !prompt[v[0]]) continue;
                    if (/Sampler/.test(prompt[v[0]].class_type)) return true;
                    seen.add(String(v[0]));
                    next.push(String(v[0]));
                }
            }
            edge = next;
        }
        return false;
    };
    const made = real.length > 1 ? real.filter(sampled) : real;
    const save = made.length === 1 ? made[0] : real.length === 1 ? real[0] : saves.length === 1 ? saves[0] : null;
    if (!save) throw new Error(saves.length ? `The graph has several SaveImage nodes (${saves.join(", ")}): title the one Scumble reads "Scumble result".` : "The graph has no SaveImage node, so no picture would come back.");
    found.push(`result: ${label(save)}`);
    const values = {};
    if (pos.length) values.prompt = pos;
    if (neg.length) values.negative = neg;
    if (seed.length) values.seed = seed;
    return { pictures: loads, maskFrom: masks[0] || null, values, save, found };
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
    // the user: "nein, kein anderes comfy cloud rezept" (docs/PLAN_0_1_42.md §1)
    if (recipe.task === "pass") throw new Error(`${PASS_LABEL} runs on your own ComfyUI only: it has no Cloud copy.`);
    const canvasId = String(recipe.canvas);
    // the Cloud copy runs the prompt as typed: the upsampler's model is a file on the user's ComfyUI
    const graph = withoutUpsampler(recipe.prompt, recipe.upsampler);
    /** @type {Record<string, any>} */
    const prompt = JSON.parse(JSON.stringify(graph));
    delete prompt[canvasId];
    const m = /^(.+):(\d+)$/.exec(String(recipe.result || ""));
    if (!m || !prompt[m[1]]) throw new Error(`The recipe's result "${recipe.result || ""}" names no node of its graph.`);
    const taken = new Set(Object.keys(graph));
    const newId = (/** @type {string} */ stem) => { let id = `scumble_${stem}`, n = 2; while (taken.has(id)) id = `scumble_${stem}_${n++}`; taken.add(id); return id; };
    /** @type {Record<string, [string, string][]>} */
    const values = {};
    const notes = [];
    let maxPicture = 0, maskLink = null;
    const loadPicture = (k) => ({ class_type: "LoadImage", inputs: { image: "" }, _meta: { title: `scumble:picture:${k}` } });
    let whole = null;
    for (const [id, node] of Object.entries(graph)) {
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
    // the copy's graph has no factor row: an upscaler runs at what its graph holds (an upscale model at its own)
    const ft = recipe.task === "upscale" && recipe.factor && typeof (/** @type {any} */ (recipe.factor)).input === "string" ? String((/** @type {any} */ (recipe.factor)).input) : "";
    if (ft) {
        const at = ft.indexOf("|"), node = prompt[ft.slice(0, at)];
        const held = node && node.inputs ? node.inputs[ft.slice(at + 1)] : undefined;
        notes.push(`the Comfy Cloud copy runs at the factor its graph holds${held != null ? ` (${held}×)` : ""}; change it in its graph`);
    }
    // where the LoRAs go: the recipe's declaration as a field of the Cloud copy's variant (item 50, docs/PLAN_LORAS.md §3.5)
    /** @type {LoraDecl | undefined} */
    let loras;
    if (recipe.loras !== undefined) {
        const got = lorasOf(recipe.loras, prompt);
        loras = got.loras;
        const named = recipe.loras && typeof recipe.loras === "object" ? recipe.loras.model : undefined;
        if (named !== undefined && !(loras && loras.model)) notes.push(`the LoRAs' model source ${JSON.stringify(named)} is not in the Comfy Cloud copy; its graph's own model loader takes them there`);
    }
    /** @type {Recipe} */
    const out = {
        id: `${recipe.id}_cloud`, name: `${name} (Comfy Cloud)`, kind: "provider",
        description: `${name} without the Inpaint Canvas node, run on Comfy Cloud; Scumble crops and stitches.`,
        ...(recipe.task ? { task: recipe.task } : {}),
        ...(recipe.task === "upscale" ? { factor: { fixed: true } } : {}),
        ...(recipe.promptRequired === true ? { promptRequired: true } : {}),
        default: "comfycloud",
        providers: {
            comfycloud: {
                model: name, input: maskLink ? "fill" : "edit",
                options: { graph: prompt, pictures: maxPicture + 1, mask: !!maskLink, values, needs, save },
                settings: rows,
                limits: { ...LIMITS_DEFAULT, max, step, aspects: [] },
                refs: { name: (recipe.refs && recipe.refs.name) || REF_NAME_DEFAULT },
                note: "A ComfyUI recipe without its Inpaint Canvas node, on Comfy Cloud's GPUs.",
                ...(loras !== undefined ? { loras } : {}),
            },
        },
    };
    return { recipe: out, notes, needs };
}

function looksLikePrompt(obj) {
    const vals = Object.values(obj || {});
    return vals.length > 0 && vals.every((v) => v && typeof v === "object" && typeof v.class_type === "string");
}

module.exports = { cloudMark, detach, detectRoles, fromCloudGraph, fromGraph, fromPrompt, holdsCanvas, looksLikePrompt, promotedOf, toPrompt };
