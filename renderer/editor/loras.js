// @ts-check
// LoRAs on the user's ComfyUI and Comfy Cloud (item 50, docs/PLAN_LORAS.md §3.1): the switched-on rows of a recipe go
// into the queued copy of its graph as a chain of LoraLoaderModelOnly nodes between the graph's model loader and
// whatever reads the model, at run time; the recipe file never changes (the comfyprompt.wireUpsampler precedent).
//
// The model source is the single live node whose class outputs MODEL and takes no MODEL itself (a UNETLoader, a
// checkpoint loader), live meaning its result reaches the recipe's result or an output node. A recipe may say
// otherwise: `loras: false` (no LoRAs, cloud_ideogram_4 with its two loaders) or `loras: { model, family }` (`model` the
// node the chain starts after, which may itself read a MODEL, as the MOSS edit recipe's edit LoRA does; `family` the
// base model its LoRAs must fit, for the hint). electron/main/recipes.js normalize checks the declaration against the
// graph; on a Comfy Cloud recipe it is a field of the variant (providers.comfycloud.loras, its text route's as
// text.loras).
//
// App-only: host.js imports it (since LR1: the store's rows, the refusal, the splice in queueGenerate, the via line and
// the PNG metadata) and main requires it for Comfy Cloud graphs (LR5); it is not in
// tools/build_node.py FILES (the node's own graphs take a Load LoRA node by hand). Pure, no DOM, no editor:
// tools/loras_test.js imports this file.

/** Rows per recipe at most (the user's decision of 2026-11-06). */
export const MAX_LORAS = 5;
/** The node a chain is made of when the source gives the model alone, and the one when it gives a CLIP too. */
export const LORA_MODEL_CLASS = "LoraLoaderModelOnly";
export const LORA_CLIP_CLASS = "LoraLoader";
/** LoraLoaderModelOnly's strength range (ComfyUI nodes.py): a stored strength outside it is clamped. */
const STRENGTH_MIN = -100, STRENGTH_MAX = 100;

/**
 * What a class gives and takes when the node list does not say (the list unread, or a class it lacks): the loaders a
 * graph may start from (`model`, `clip`: their output slots) and the LoRA loaders, which read a MODEL (`reads`).
 * @type {Record<string, { model: number, clip?: number, reads?: boolean }>}
 */
const KNOWN = {
    UNETLoader: { model: 0 },
    CheckpointLoaderSimple: { model: 0, clip: 1 },
    UnetLoaderGGUF: { model: 0 },
    UnetLoaderGGUFAdvanced: { model: 0 },
    CheckpointLoaderGGUF: { model: 0 },
    LoraLoaderModelOnly: { model: 0, reads: true },
    LoraLoader: { model: 0, clip: 1, reads: true },
};
/** The output nodes a graph is walked back from when the node list does not mark them. */
const OUTPUT_CLASSES = new Set(["SaveImage", "SaveImageAdvanced", "PreviewImage", "PreviewAny"]);
/** Model loaders whose LoRAs need the pack's own LoRA node (ComfyUI-nunchaku): no chain of core nodes. */
const OWN_LORA_NODE = /^Nunchaku/;

/** @param {any} v */
const isLink = (v) => Array.isArray(v) && v.length === 2 && (typeof v[0] === "string" || typeof v[0] === "number") && Number.isInteger(v[1]);
/** @param {any} v @param {string} id @param {number} slot */
const reads = (v, id, slot) => isLink(v) && String(v[0]) === id && v[1] === slot;

/**
 * A LoRA name as two servers may spell it: the path separators as "/", the ends trimmed (ComfyUI lists
 * `klein\x.safetensors` on Windows and `klein/x.safetensors` on Linux; the names are otherwise matched exactly).
 * @param {any} name
 */
export function normalizeName(name) {
    return String(name == null ? "" : name).trim().replace(/\\/g, "/");
}

/**
 * The names an input of `cls` takes by the node list (its combo), or null when the list gives none: both forms
 * ComfyUI answers, the older `[[names], {...}]` and the newer `["COMBO", { options: [names] }]` (comfycloud.js
 * choicesOf's twin; never `spec[0]` alone).
 * @param {any} info the node list (/object_info), or null
 * @param {string} cls
 * @param {string} input
 * @returns {string[] | null}
 */
export function comboOf(info, cls, input) {
    const def = info && info[cls] && info[cls].input;
    const spec = def && ((def.required && def.required[input]) || (def.optional && def.optional[input]));
    if (!Array.isArray(spec)) return null;
    const list = Array.isArray(spec[0]) ? spec[0] : spec[0] === "COMBO" && spec[1] && Array.isArray(spec[1].options) ? spec[1].options : [];
    const names = list.filter((/** @type {any} */ x) => typeof x === "string");
    return names.length ? names : null;
}

/**
 * The rows a run loads: switched on (`on` not false), a name, a finite strength; in their order.
 * @param {any} rows
 * @returns {{ name: string, strength: number }[]}
 */
export function usableRows(rows) {
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const row of rows) {
        if (!row || typeof row !== "object" || row.on === false) continue;
        if (typeof row.name !== "string" || !row.name.trim()) continue;
        if (typeof row.strength !== "number" || !Number.isFinite(row.strength)) continue;
        out.push({ name: row.name, strength: row.strength });
    }
    return out;
}

/**
 * What a class of the graph gives: its MODEL and CLIP output slots (-1: none), whether it reads a MODEL, and whether
 * anything is known about it (the node list's `output` / `input`, else the KNOWN table).
 * @param {any} info
 * @param {string} cls
 * @returns {{ known: boolean, model: number, clip: number, readsModel: boolean }}
 */
function classOf(info, cls) {
    const d = info && info[cls];
    if (d && Array.isArray(d.output)) {
        const takes = (/** @type {any} */ group) => Object.values((group && typeof group === "object") ? group : {}).some((s) => Array.isArray(s) && s[0] === "MODEL");
        return { known: true, model: d.output.indexOf("MODEL"), clip: d.output.indexOf("CLIP"), readsModel: !!d.input && (takes(d.input.required) || takes(d.input.optional)) };
    }
    const k = KNOWN[cls];
    if (k) return { known: true, model: k.model, clip: k.clip == null ? -1 : k.clip, readsModel: !!k.reads };
    return { known: false, model: -1, clip: -1, readsModel: false };
}

/**
 * The nodes whose result reaches the recipe's result (`r.result`, "node:slot"), `r.save` (a Comfy Cloud graph's
 * SaveImage) or an output node (by the node list, else by OUTPUT_CLASSES), walked backwards; the upsampler's own nodes
 * (`r.upsampler.nodes`) left out. A graph with none of them: every node.
 * @param {Record<string, any>} prompt
 * @param {any} r
 * @param {any} info
 * @returns {Set<string>}
 */
function liveNodes(prompt, r, info) {
    const skip = new Set(((r && r.upsampler && r.upsampler.nodes) || []).map(String));
    const roots = [];
    const res = r && typeof r.result === "string" && r.result ? r.result : "";
    if (res) { const at = res.lastIndexOf(":"); roots.push(at < 0 ? res : res.slice(0, at)); }
    if (r && r.save != null) roots.push(String(r.save));
    for (const [id, n] of Object.entries(prompt)) {
        const cls = n && n.class_type;
        if (!cls) continue;
        const d = info && info[cls];
        if (d ? !!d.output_node : OUTPUT_CLASSES.has(cls)) roots.push(id);
    }
    const stack = roots.filter((id) => prompt[id] && !skip.has(id));
    if (!stack.length) return new Set(Object.keys(prompt).filter((id) => !skip.has(id)));
    const live = new Set();
    while (stack.length) {
        const id = /** @type {string} */ (stack.pop());
        if (live.has(id) || !prompt[id] || skip.has(id)) continue;
        live.add(id);
        for (const v of Object.values(prompt[id].inputs || {})) if (isLink(v) && prompt[String(v[0])]) stack.push(String(v[0]));
    }
    return live;
}

/**
 * Where a LoRA chain starts in this graph: `{ node, slot, clip }` (`clip` the source's CLIP slot and the live inputs
 * that read it, when the source gives a CLIP and a text encoder takes it: then the chain is LoraLoader nodes), or
 * `{ none: reason }` (no LoRAs here), or `{ many: [ids] }` (two model loaders, and the recipe names neither).
 * `r` is the recipe (`loras`, `result`, `upsampler`), or for a Comfy Cloud graph `{ loras, save }` of its variant.
 * @param {Record<string, any>} prompt the graph (API format)
 * @param {any} r
 * @param {any} [info] the node list (/object_info), or null: then the KNOWN table
 * @returns {{ node: string, slot: number, clip: { slot: number, consumers: { node: string, input: string }[] } | null } | { none: string } | { many: string[] }}
 */
export function modelSource(prompt, r, info = null) {
    if (!prompt || typeof prompt !== "object") return { none: "the recipe has no graph" };
    const decl = r ? r.loras : undefined;
    if (decl === false) return { none: "the recipe takes no LoRAs" };
    const live = liveNodes(prompt, r, info);
    for (const id of live) {
        const cls = String(prompt[id].class_type || "");
        if (!OWN_LORA_NODE.test(cls)) continue;
        const c = classOf(info, cls);
        if (!c.known || c.model >= 0) return { none: `its model loader ${cls} needs the pack's own LoRA node` };
    }
    /** @type {string[]} */
    let found = [];
    /** @type {Record<string, number>} */
    const slotOf = {};
    const declared = decl && typeof decl === "object" && typeof decl.model === "string" && decl.model ? decl.model : "";
    if (declared && prompt[declared]) {
        const c = classOf(info, String(prompt[declared].class_type || ""));
        if (c.known && c.model !== 0) return { none: `the recipe's model source ${declared} (${prompt[declared].class_type}) gives no MODEL at its first output` };
        found = [declared];
        slotOf[declared] = 0;
    } else {
        // a declared node this graph lacks (a Comfy Cloud recipe's other route): the generic rule
        for (const id of live) {
            const c = classOf(info, String(prompt[id].class_type || ""));
            if (!c.known || c.model < 0 || c.readsModel) continue;
            // a loader whose model nothing live reads (a checkpoint kept for its VAE) is no source
            if (![...live].some((o) => Object.values(prompt[o].inputs || {}).some((v) => reads(v, id, c.model)))) continue;
            found.push(id);
            slotOf[id] = c.model;
        }
    }
    if (!found.length) return { none: "the graph has no model loader Scumble can see" };
    if (found.length > 1) return { many: found.sort() };
    const node = found[0], slot = slotOf[node];
    const c = classOf(info, String(prompt[node].class_type || ""));
    let clip = null;
    if (c.clip >= 0) {
        const consumers = [];
        for (const o of live) for (const [k, v] of Object.entries(prompt[o].inputs || {})) if (reads(v, node, c.clip)) consumers.push({ node: o, input: k });
        if (consumers.length) clip = { slot: c.clip, consumers };
    }
    return { node, slot, clip };
}

/** A fresh node id `stem` (then `stem_2`, `stem_3` ...) the graph does not hold yet; flattened imports use "57:12". */
function freshId(/** @type {Set<string>} */ taken, /** @type {string} */ stem) {
    let id = stem, n = 2;
    while (taken.has(id)) id = `${stem}_${n++}`;
    taken.add(id);
    return id;
}

/**
 * The switched-on rows into the queued copy of a graph, in place: a chain `scumble_lora_1 .. n` after the model
 * source, every input that read the source's MODEL (and, for LoraLoader, its CLIP) re-pointed to the chain's end. A
 * name that differs from the node list's only in its separators goes in the list's spelling. Nothing changes without
 * a usable row or without a source (`note` then says why the rows stayed out). More than MAX_LORAS usable rows throw.
 * @param {Record<string, any>} prompt the copy that is queued (never the recipe's own graph)
 * @param {any} r the recipe, or a Comfy Cloud variant's `{ loras, save }`
 * @param {any} rows [{ name, strength, on }]
 * @param {any} [info] the node list, or null
 * @returns {{ applied: { name: string, strength: number }[], note: string | null }}
 */
export function spliceLoras(prompt, r, rows, info = null) {
    const use = usableRows(rows);
    if (use.length > MAX_LORAS) throw new Error(`At most ${MAX_LORAS} LoRAs per recipe; the rows name ${use.length}.`);
    if (!use.length || !prompt || typeof prompt !== "object") return { applied: [], note: null };
    const src = modelSource(prompt, r, info);
    if ("none" in src) return { applied: [], note: `The LoRAs stayed out: ${src.none}.` };
    if ("many" in src) return { applied: [], note: `The LoRAs stayed out: the graph has ${src.many.length} model loaders (${src.many.join(", ")}) and the recipe names none of them.` };
    const cls = src.clip ? LORA_CLIP_CLASS : LORA_MODEL_CLASS;
    const names = comboOf(info, cls, "lora_name") || comboOf(info, LORA_MODEL_CLASS, "lora_name");
    const taken = new Set(Object.keys(prompt));
    const ids = use.map((_, i) => freshId(taken, `scumble_lora_${i + 1}`));
    const last = ids[ids.length - 1];
    // every reader of the source's MODEL (and CLIP) takes the chain's end; the chain's own nodes are added after
    for (const node of Object.values(prompt)) {
        if (!node || !node.inputs) continue;
        for (const [k, v] of Object.entries(node.inputs)) {
            if (reads(v, src.node, src.slot)) node.inputs[k] = [last, 0];
            else if (src.clip && reads(v, src.node, src.clip.slot)) node.inputs[k] = [last, 1];
        }
    }
    /** @type {{ name: string, strength: number }[]} */
    const applied = [];
    use.forEach((row, i) => {
        let name = row.name;
        if (names && !names.includes(name)) {
            const n = normalizeName(name);
            const same = names.find((x) => normalizeName(x) === n);
            if (same) name = same;
        }
        const strength = Math.min(STRENGTH_MAX, Math.max(STRENGTH_MIN, row.strength));
        const model = i ? [ids[i - 1], 0] : [src.node, src.slot];
        const inputs = src.clip
            ? { model, clip: i ? [ids[i - 1], 1] : [src.node, src.clip.slot], lora_name: name, strength_model: strength, strength_clip: strength }
            : { model, lora_name: name, strength_model: strength };
        prompt[ids[i]] = { class_type: cls, inputs };
        applied.push({ name, strength });
    });
    return { applied, note: null };
}

/**
 * The switched-on rows whose name the server's list (`names`, its lora_name combo) lacks: `[{ name, server }]`, where
 * `server` is the list's spelling of a name that differs only in its separators (sent so, not refused) and null for a
 * file the server does not have. Against an empty or unread list nothing is missing: the names go as typed and
 * ComfyUI's own check answers (the Settings rows' precedent, host.js missingSettingFiles).
 * @param {any} rows
 * @param {any} names
 * @returns {{ name: string, server: string | null }[]}
 */
export function missingLoras(rows, names) {
    const list = Array.isArray(names) ? names.filter((x) => typeof x === "string") : [];
    if (!list.length) return [];
    const out = [];
    for (const row of usableRows(rows)) {
        if (list.includes(row.name)) continue;
        const n = normalizeName(row.name);
        out.push({ name: row.name, server: list.find((x) => normalizeName(x) === n) || null });
    }
    return out;
}

/**
 * A LoRA as a line names it: the file's stem, its folders and extension off ("klein\Flux3_Targa.safetensors" ->
 * "Flux3_Targa"; the Preset row's suggestion does the same, host.js renderPresets).
 * @param {any} name
 */
export function loraStem(name) {
    return String(name == null ? "" : name).replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]+$/i, "");
}

/**
 * The LoRAs a run loaded as the status line, the via line and the log name them: "Flux3_Targa 0.8, nyc_style 1.0"
 * (each strength to two decimals at most, one at least), "" for none.
 * @param {any} applied [{ name, strength }]
 */
export function loraWords(applied) {
    if (!Array.isArray(applied)) return "";
    return applied.filter((a) => a && typeof a.name === "string").map((a) => {
        const s = String(Math.round((+a.strength || 0) * 100) / 100);
        return `${loraStem(a.name)} ${/[.e]/.test(s) ? s : s + ".0"}`;
    }).join(", ");
}

/**
 * The base model a LoRA looks made for (docs/PLAN_LORAS.md §3.4): `{ family, label, from, sure }` or null. LR3 reads
 * the reduced header (the module paths, then the metadata); until then the folder alone, which names no family.
 * @param {any} header the reduced header answer, or null
 * @param {string | null} [folder] the subfolder of the server's name ("klein"), or null
 * @returns {{ family: string | null, label: string, from: "keys" | "metadata" | "folder", sure: boolean } | null}
 */
export function familyOf(header, folder = null) {
    const f = typeof folder === "string" ? folder.trim() : "";
    return f ? { family: null, label: `in folder ${f}`, from: "folder", sure: false } : null;
}

/**
 * The base model a recipe's LoRAs must fit: its declared `loras.family`, else null (LR3 adds the graph's CLIPLoader
 * type and Qwen Image 2.1's cache).
 * @param {any} r
 * @returns {string | null}
 */
export function recipeFamily(r) {
    const l = r && r.loras;
    return l && typeof l === "object" && typeof l.family === "string" && l.family ? l.family : null;
}
