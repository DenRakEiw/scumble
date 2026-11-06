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
// the PNG metadata), lora_panel.js too (LR2: the strength's range, the picker's groups and search; LR3: the base-model
// hint familyOf / recipeFamily / loraHint, the trigger words, the picker's family group), and main requires it for
// Comfy Cloud graphs (LR5); it is not in
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
 * The strengths a row may hold: the node list's own range of LoraLoaderModelOnly's strength_model (ComfyUI's is
 * -100 .. 100), else that one. The LoRAs section's spinner steps -2 .. 2; a typed value is clamped to this.
 * @param {any} [info] the node list, or null
 * @returns {{ min: number, max: number }}
 */
export function strengthRange(info = null) {
    const def = info && info[LORA_MODEL_CLASS] && info[LORA_MODEL_CLASS].input;
    const spec = def && ((def.required && def.required.strength_model) || (def.optional && def.optional.strength_model));
    const o = Array.isArray(spec) && spec[1] && typeof spec[1] === "object" ? spec[1] : {};
    const min = Number.isFinite(o.min) ? o.min : STRENGTH_MIN, max = Number.isFinite(o.max) ? o.max : STRENGTH_MAX;
    return min <= max ? { min, max } : { min: STRENGTH_MIN, max: STRENGTH_MAX };
}

/**
 * A typed strength as a row stores it: a number clamped to `strengthRange(info)`, rounded to 1/1000; null for what is
 * no number ("", "abc"), so the row keeps its value.
 * @param {any} value
 * @param {any} [info]
 * @returns {number | null}
 */
export function clampStrength(value, info = null) {
    const t = typeof value === "string" ? value.trim().replace(",", ".") : value;
    if (t === "" || t == null || typeof t === "boolean") return null;
    const v = Number(t);
    if (!Number.isFinite(v)) return null;
    const { min, max } = strengthRange(info);
    return Math.round(Math.min(max, Math.max(min, v)) * 1000) / 1000;
}

/**
 * The subfolder part of a server name ("klein\\sub\\x.safetensors" -> "klein\\sub", the server's own separators), ""
 * for a file at the root of models/loras.
 * @param {any} name
 */
export function loraFolder(name) {
    const s = String(name == null ? "" : name);
    const at = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
    return at > 0 ? s.slice(0, at) : "";
}

/**
 * The server's names as the picker groups them, by subfolder: `[{ folder, names }]`, the folders in the order of
 * their names (any case; one spelled with "\\" and one with "/" are one folder, shown as the first name spells it),
 * the files of the root of models/loras last as folder "" (the picker shows "(root)"), each group's names in the
 * list's own order (ComfyUI sorts them).
 * @param {any} names
 * @returns {{ folder: string, names: string[] }[]}
 */
export function groupByFolder(names) {
    /** @type {Map<string, { folder: string, names: string[] }>} */
    const by = new Map();
    for (const n of Array.isArray(names) ? names : []) {
        if (typeof n !== "string" || !n) continue;
        const folder = loraFolder(n), key = normalizeName(folder).toLowerCase();
        let g = by.get(key);
        if (!g) by.set(key, g = { folder, names: [] });
        g.names.push(n);
    }
    const groups = [...by.values()];
    groups.sort((a, b) => Number(a.folder === "") - Number(b.folder === "") || a.folder.localeCompare(b.folder, undefined, { sensitivity: "base", numeric: true }));
    return groups;
}

/**
 * The names a search keeps: every word of `query` (split at spaces) found somewhere in the name, any case, "/" and
 * "\\" alike ("klein/nyc" finds "klein\\nyc_style.safetensors"); an empty query keeps all. The list's order stays.
 * @param {any} names
 * @param {any} query
 * @returns {string[]}
 */
export function filterNames(names, query) {
    const list = Array.isArray(names) ? names.filter((n) => typeof n === "string" && n) : [];
    const words = normalizeName(query).toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return list;
    return list.filter((n) => { const s = normalizeName(n).toLowerCase(); return words.every((w) => s.includes(w)); });
}

// ---- the base model a LoRA looks made for (LR3, docs/PLAN_LORAS.md §3.4) ----------------------------------------------
//
// Read from the file's reduced header (electron/main/loraheader.js: its module paths with N for every index, the block
// indices per prefix, the hidden width per prefix, a few metadata fields), else from ComfyUI's /view_metadata answer
// (metadata only, reduced by loraMeta below), else from the subfolder's name. The tensor names decide over the
// metadata, which lies (ai-toolkit writes "sd_1.5" into FLUX and Qwen LoRAs: 314 of the user's 528 files in
// flux/, klein/ and qwen/ on 2026-11-06). Only a keys answer can turn the row's line amber; nothing is ever refused.

/**
 * The families a hint names, with the family each is a size or kind of (`parent`): a LoRA for FLUX.2 Klein 9B fits a
 * recipe that runs "FLUX.2 Klein" (4B or 9B, the user's pick in its Settings) and one that runs "FLUX.2".
 * @type {Record<string, { label: string, parent?: string }>}
 */
export const FAMILIES = {
    sd15: { label: "SD 1.5" },
    sdxl: { label: "SDXL" },
    flux1: { label: "FLUX.1" },
    flux2: { label: "FLUX.2" },
    flux2_dev: { label: "FLUX.2 dev", parent: "flux2" },
    flux2_klein: { label: "FLUX.2 Klein", parent: "flux2" },
    flux2_klein_4b: { label: "FLUX.2 Klein 4B", parent: "flux2_klein" },
    flux2_klein_9b: { label: "FLUX.2 Klein 9B", parent: "flux2_klein" },
    flux3: { label: "FLUX 3" },
    qwen_image: { label: "Qwen Image (Edit 2509 / 2511)" },
    qwen_image_2_1: { label: "Qwen Image 2.1" },
    moss_image: { label: "MOSS-Image" },
    z_image: { label: "Z-Image" },
    ideogram4: { label: "Ideogram 4" },
    p_h3_image: { label: "P-H3-Image" },
};

/** A family's label ("FLUX.2 Klein 9B"); an unknown id as it is. @param {any} f */
export function familyLabel(f) {
    return (f && FAMILIES[f] && FAMILIES[f].label) || String(f || "");
}

/** A family and the families it is a size or kind of, nearest first. @param {string} f */
function lineage(f) {
    const out = [];
    for (let x = f; x && !out.includes(x); x = FAMILIES[x] ? FAMILIES[x].parent : undefined) out.push(x);
    return out;
}

/**
 * Whether a LoRA of family `lora` fits a recipe of family `recipe`: the same, or one a size or kind of the other
 * (flux2_klein_9b under flux2_klein). Either unknown: true (nothing to say).
 * @param {any} lora
 * @param {any} recipe
 */
export function familyFits(lora, recipe) {
    if (!lora || !recipe) return true;
    return lineage(lora).includes(recipe) || lineage(recipe).includes(lora);
}

/**
 * The structural table: each family a LoRA's module paths can show, with what its base model has. Read 2026-11-06 from
 * the user's base models' headers (read-only: diffusion_models/flux1-dev-fp8, flux-2-klein-4b, flux-2-klein-base-4b,
 * flux-2-klein-9b, flux3-image-klein-bf16, qwen_image_edit_bf16, qwen_image_2.1_int8_convrot, moss_image_sft_bf16,
 * zImage_turbo) and checked against the user's LoRAs (loras/flux, flux_2, klein, Flux_3, kontext, qwen, z_image,
 * ideogram): `h` the hidden width (the smallest out-features under the block prefixes), `double` / `single` / `tb` /
 * `layers` the highest block index the model has (19 / 38 FLUX.1 blocks are 0 .. 18 / 0 .. 37), `deny` the multiples
 * of h an out-feature of the row's model never is (FLUX.1's MLP gives 4h and 7h, FLUX.2's 6h and 9h: what tells a
 * FLUX.1 LoRA from a FLUX.2 Klein 4B one, both 3072 wide). The FLUX.2 dev row is read from the user's two flux_2/
 * LoRAs (no FLUX.2 dev model on the machine); Ideogram 4's width from its one LoRA.
 * @type {{ family: string, names: (m: string[]) => boolean, h?: number, double?: number, single?: number, tb?: number, layers?: number, deny?: number[] }[]}
 */
const TABLE = [];
/** @param {string[]} m @param {RegExp} re */
const anyOf = (m, re) => m.some((x) => re.test(x));
// FLUX's own module names: ComfyUI's and kohya's double_blocks / single_blocks, the diffusers names' single blocks and
// the double block's norm1 / ff (Qwen has neither); Qwen's: img_mod, txt_mod, img_mlp, txt_mlp in transformer_blocks
const FLUX_NAMES = /(?:^|[._])(?:double|single)_blocks[._]N[._]|single_transformer_blocks[._]N[._]|(?:^|[._])transformer_blocks[._]N[._](?:norm1(?:_context)?|ff(?:_context)?)[._]/;
const QWEN_NAMES = /(?:^|[._])transformer_blocks[._]N[._](?:img_mod|txt_mod|img_mlp|txt_mlp)(?:[._]|$)/;
const QWEN_EDIT_NAMES = /(?:^|[._])transformer_blocks[._]N[._](?:img_mod|txt_mod|txt_mlp|img_mlp[._]net)(?:[._]|$)/;
// Qwen Image 2.1: one stream (attn.to_q / to_k / to_v / to_out, no add_*), a gated MLP whose halves LoRAs address
// (img_mlp.gate_layer / proj, ComfyUI lora.py), txt_in.text_norm
const QWEN21_NAMES = /(?:^|[._])transformer_blocks[._]N[._]img_mlp[._](?:gate_up|gate_layer|proj|out)$|(?:^|[._])txt_in[._]text_norm$/;
const DOUBLE_ATTN = /(?:^|[._])transformer_blocks[._]N[._]attn[._]/;
const ADD_ATTN = /(?:^|[._])transformer_blocks[._]N[._]attn[._](?:add_[qkv]_proj|to_add_out)$/;
const ONE_STREAM_ATTN = /(?:^|[._])transformer_blocks[._]N[._]attn[._]to_(?:q|k|v|out)(?:[._]N)?$/;
const LAYERS_ATTN = /(?:^|[._])layers[._]N[._](?:attention[._]|feed_forward[._]|adaln_modulation)/i;
const MOSS_NAMES = /(?:^|[._])layers[._]N[._]proj[._](?:q|k|v|o|qkv|ffn_up_gate|ffn_down)$/;
// FLUX 3: its content_mode_blocks.<mode> and txt_mode_blocks, and single blocks of q_proj / k_proj / v_proj / attn_out /
// mlp_in / mlp_out (FLUX.1 and FLUX.2 have linear1 / linear2 there): the user's Flux_3 LoRAs, flux3-image-klein
const FLUX3_NAMES = /content_mode_blocks[._]|txt_mode_blocks[._]|(?:^|[._])single_blocks[._]N[._](?:attn_out|[qkv]_proj|mlp_in|mlp_out)$/;
/** @param {string[]} m */
const fluxNames = (m) => !anyOf(m, FLUX3_NAMES) && !anyOf(m, QWEN_NAMES) && (anyOf(m, FLUX_NAMES) || anyOf(m, DOUBLE_ATTN));
TABLE.push(
    { family: "flux3", names: (m) => anyOf(m, FLUX3_NAMES) },
    { family: "flux1", names: fluxNames, h: 3072, double: 18, single: 37, deny: [9] },
    { family: "flux2_klein_4b", names: fluxNames, h: 3072, double: 4, single: 19, deny: [4, 7] },
    { family: "flux2_klein_9b", names: fluxNames, h: 4096, double: 7, single: 23, deny: [4, 7] },
    { family: "flux2_dev", names: fluxNames, h: 6144, double: 7, single: 47, deny: [4, 7] },
    { family: "qwen_image", names: (m) => !anyOf(m, FLUX_NAMES) && !anyOf(m, QWEN21_NAMES) && (anyOf(m, QWEN_EDIT_NAMES) || anyOf(m, ADD_ATTN)), h: 3072, tb: 59 },
    { family: "qwen_image_2_1", names: (m) => !anyOf(m, FLUX_NAMES) && !anyOf(m, QWEN_EDIT_NAMES) && !anyOf(m, ADD_ATTN) && (anyOf(m, QWEN21_NAMES) || anyOf(m, ONE_STREAM_ATTN)), h: 4096, tb: 31 },
    { family: "moss_image", names: (m) => anyOf(m, MOSS_NAMES), h: 3072, layers: 41 },
    { family: "z_image", names: (m) => anyOf(m, LAYERS_ATTN), h: 3840, layers: 29 },
    { family: "ideogram4", names: (m) => anyOf(m, LAYERS_ATTN), h: 4608 },
);

/** @param {any} blocks @param {string[]} prefixes the highest index under any of them, -1 for none */
function maxIndex(blocks, prefixes) {
    let mx = -1;
    for (const p of prefixes) for (const i of (blocks && Array.isArray(blocks[p]) ? blocks[p] : [])) if (Number.isInteger(i) && i > mx) mx = i;
    return mx;
}
/** @param {any} outs @param {string[]} prefixes @param {number} h the out-features under them that are whole multiples of h, as multiples */
function multiples(outs, prefixes, h) {
    const out = new Set();
    for (const p of prefixes) for (const o of (outs && Array.isArray(outs[p]) ? outs[p] : [])) if (Number.isInteger(o) && o % h === 0) out.add(o / h);
    return out;
}
/** @param {any} width @param {string[]} prefixes the smallest width under any of them, null for none */
function minWidth(width, prefixes) {
    let w = null;
    for (const p of prefixes) { const v = width && width[p]; if (Number.isInteger(v) && v > 0 && (w == null || v < w)) w = v; }
    return w;
}

/**
 * The families a reduced header's module paths fit: the SD ones by their own names first, then every row of TABLE
 * whose names, width, block counts and out-features hold (a width or a block prefix the header lacks rules nothing out).
 * @param {any} header
 * @returns {string[]}
 */
function keyFamilies(header) {
    const m = header && Array.isArray(header.modules) ? header.modules.filter((x) => typeof x === "string") : [];
    if (!m.length) return [];
    // SD 1.5 and SDXL: kohya's text-encoder names (SDXL has two), the U-Net's own block names
    if (anyOf(m, /^lora_te[12]_/) || anyOf(m, /(?:^|[._])(?:input|output)_blocks[._]|(?:^|[._])middle_block[._]/)) return ["sdxl"];
    if (anyOf(m, /^lora_te_text_model/) || anyOf(m, /^lora_unet_(?:down|up)_blocks[._]|^lora_unet_mid_block[._]/)) return ["sd15"];
    const b = header.blocks || {}, w = header.width || {};
    const D = ["double_blocks", "transformer_blocks"], S = ["single_blocks", "single_transformer_blocks"];
    const out = [];
    for (const row of TABLE) {
        if (!row.names(m)) continue;
        if (row.double != null || row.single != null) {
            const h = minWidth(w, [...D, ...S]);
            if (row.h && h != null && h !== row.h) continue;
            if (row.double != null && maxIndex(b, D) > row.double) continue;
            if (row.single != null && maxIndex(b, S) > row.single) continue;
            if (row.deny && h != null) { const x = multiples(header.outs, [...D, ...S], h); if (row.deny.some((k) => x.has(k))) continue; }
        } else if (row.tb != null) {
            const h = minWidth(w, ["transformer_blocks"]);
            if (row.h && h != null && h !== row.h) continue;
            if (maxIndex(b, ["transformer_blocks"]) > row.tb) continue;
        } else if (row.h) {
            const h = minWidth(w, ["layers"]);
            if (h != null && h !== row.h) continue;
            if (row.layers != null && maxIndex(b, ["layers"]) > row.layers) continue;
        }
        out.push(row.family);
    }
    return out;
}

/**
 * A metadata value's family (`ss_base_model_version`, `modelspec.architecture`): "flux2_klein_9b", "flux3",
 * "sdxl_base_v1-0", "stable-diffusion-xl-v1-base/lora" ...; null for one this table does not know ("wan", "SD3").
 * @param {any} v
 * @returns {string | null}
 */
function metaFamily(v) {
    const s = String(v || "").toLowerCase();
    if (!s) return null;
    if (/sdxl|stable-diffusion-xl/.test(s)) return "sdxl";
    if (/^sd[_-]?1|^sd1|stable-diffusion-v1/.test(s)) return "sd15";
    if (/klein[._-]?9b/.test(s)) return "flux2_klein_9b";
    if (/klein[._-]?4b/.test(s)) return "flux2_klein_4b";
    if (/flux[._-]?2[._-]?klein|klein/.test(s)) return "flux2_klein";
    if (/flux[._-]?2[._-]?dev/.test(s)) return "flux2_dev";
    if (/flux[._-]?2/.test(s)) return "flux2";
    if (/flux[._-]?3/.test(s)) return "flux3";
    if (/flux[._-]?1|^flux(?:[._-]?dev|[._-]?schnell|[._-]?kontext)?(?:\/|$)/.test(s)) return "flux1";
    if (/qwen.*2[._]1/.test(s)) return "qwen_image_2_1";
    if (/qwen/.test(s)) return "qwen_image";
    if (/moss/.test(s)) return "moss_image";
    if (/z[._-]?image|zimage/.test(s)) return "z_image";
    if (/ideogram/.test(s)) return "ideogram4";
    return null;
}

/**
 * The base model a LoRA looks made for: `{ family, name, label, from, sure, candidates }` or null. From the module
 * paths first (`from: "keys"`: "looks like FLUX 3"; two families the paths cannot tell apart, a FLUX.1 LoRA on a few
 * blocks against FLUX.2 Klein 4B with the same width, give `family: null` and both as `candidates`: "looks like FLUX.1
 * or FLUX.2 Klein 4B"), then the metadata (`from: "metadata"`: "metadata says SDXL", the raw value when this table
 * does not know it), then the folder (`from: "folder"`: "in folder klein"). `sure` only for a single keys family.
 * @param {any} header the reduced header (loraheader.js reduceHeader), or `{ metadata }` (loraMeta), or null
 * @param {string | null} [folder] the subfolder of the server's name ("klein"), or null
 * @returns {{ family: string | null, name: string, label: string, from: "keys" | "metadata" | "folder", sure: boolean, candidates: string[] } | null}
 */
export function familyOf(header, folder = null) {
    const fams = keyFamilies(header);
    if (fams.length) {
        const names = fams.map(familyLabel);
        const name = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
        return { family: fams.length === 1 ? fams[0] : null, name, label: `looks like ${name}`, from: "keys", sure: fams.length === 1, candidates: fams };
    }
    const meta = header && header.metadata && typeof header.metadata === "object" ? header.metadata : null;
    const raw = meta && [meta.ss_base_model_version, meta["modelspec.architecture"]].find((v) => typeof v === "string" && v.trim());
    if (raw) {
        const fam = metaFamily(meta.ss_base_model_version) || metaFamily(meta["modelspec.architecture"]);
        const name = fam ? familyLabel(fam) : String(raw).trim().slice(0, 40);
        return { family: fam, name, label: `metadata says ${name}`, from: "metadata", sure: false, candidates: fam ? [fam] : [] };
    }
    const f = typeof folder === "string" ? folder.trim() : "";
    return f ? { family: null, name: f, label: `in folder ${f}`, from: "folder", sure: false, candidates: [] } : null;
}

/** The text encoder's type a graph's CLIPLoader names, as a family (DualCLIPLoader's "flux" is FLUX.1's pair). */
const CLIP_FAMILY = { flux2: "flux2", flux3: "flux3", moss_image: "moss_image", qwen_image: "qwen_image", lumina2: "z_image", sdxl: "sdxl", ideogram4: "ideogram4", minimax: "p_h3_image" };

/**
 * The base model a recipe's LoRAs must fit: its declared `loras.family` (a Comfy Cloud variant's, passed as `{ loras }`
 * by LR5), else its graph's text encoder: the CLIPLoader `type` (`flux3`, `moss_image`, `lumina2` -> Z-Image ...;
 * `qwen_image` with a QwenImage21Cache in the graph -> Qwen Image 2.1; `flux2` refined by the model file the graph
 * loads, "klein" + "9b" / "4b" or "dev"), DualCLIPLoader's `flux` -> FLUX.1; null when it says nothing (a checkpoint
 * loader, `stable_diffusion`) or the recipe takes no LoRAs.
 * @param {any} r a recipe (`loras`, `prompt`), or a Comfy Cloud graph's `{ loras, options: { graph } }`
 * @returns {string | null}
 */
export function recipeFamily(r) {
    const l = r && r.loras;
    if (l === false) return null;
    if (l && typeof l === "object" && typeof l.family === "string" && l.family) return l.family;
    const g = r && (r.prompt || (r.options && r.options.graph));
    if (!g || typeof g !== "object") return null;
    const nodes = Object.values(g).filter((n) => n && typeof n === "object" && typeof n.class_type === "string");
    for (const n of nodes) {
        const t = String((n.inputs && n.inputs.type) || "").toLowerCase();
        let fam = null;
        if (/^(?:CLIPLoader|CLIPLoaderGGUF)$/.test(n.class_type)) fam = CLIP_FAMILY[t] || null;
        else if (/^(?:DualCLIPLoader|DualCLIPLoaderGGUF)$/.test(n.class_type)) fam = t === "flux" ? "flux1" : t === "sdxl" ? "sdxl" : null;
        if (!fam) continue;
        if (fam === "qwen_image" && nodes.some((x) => x.class_type === "QwenImage21Cache")) return "qwen_image_2_1";
        if (fam === "flux2") {
            const file = nodes.map((x) => String((x.inputs && (x.inputs.unet_name || x.inputs.ckpt_name)) || "")).find((x) => /flux[._-]?2/i.test(x)) || "";
            if (/klein/i.test(file)) return /9b/i.test(file) ? "flux2_klein_9b" : /4b/i.test(file) ? "flux2_klein_4b" : "flux2_klein";
            if (/dev/i.test(file)) return "flux2_dev";
        }
        return fam;
    }
    return null;
}

/**
 * The row's line for a LoRA of hint `fam` under a recipe of family `recipeFam`: `{ kind: "hint", text }` (grey: "looks
 * like FLUX 3", "metadata says SDXL", "in folder klein"), or `{ kind: "mismatch", text }` (amber) when the module
 * paths name families none of which fits the recipe's; a metadata or folder answer never turns it amber (metadata lies,
 * folders are a hint). null without a hint.
 * @param {ReturnType<typeof familyOf>} fam
 * @param {string | null} recipeFam
 * @returns {{ kind: "hint" | "mismatch", text: string } | null}
 */
export function loraHint(fam, recipeFam) {
    if (!fam) return null;
    const cands = fam.from === "keys" ? (fam.family ? [fam.family] : fam.candidates || []) : [];
    if (recipeFam && cands.length && !cands.some((f) => familyFits(f, recipeFam))) {
        return { kind: "mismatch", text: `This LoRA looks made for ${fam.name}; this recipe runs ${familyLabel(recipeFam)}. ComfyUI loads it without an error and the picture may come back unchanged.` };
    }
    return { kind: "hint", text: fam.label };
}

// ---- the metadata and the trigger words -------------------------------------------------------------------------------

/** The metadata fields kept, the caption tags (five, each shorter than 40), one field's and the whole part's length. */
const META_KEYS = ["ss_base_model_version", "ss_sd_model_name", "modelspec.architecture", "modelspec.trigger_phrase", "modelspec.title"];
const TAGS = 5, TAG_LEN = 40, META_FIELD = 4000, MAX_METADATA = 16 * 1024;

/**
 * The most frequent caption tags of ss_tag_frequency (a JSON string `{ dataset: { tag: count } }`): counts summed over
 * the datasets, tags trimmed, shorter than 40 characters and seen at least a quarter as often as the most frequent
 * one, the five most frequent (a tie by name). The twin of
 * electron/main/loraheader.js topTags.
 * @param {any} freq
 * @returns {string[]}
 */
export function topTags(freq) {
    let d = freq;
    if (typeof d === "string") { try { d = JSON.parse(d); } catch (_) { return []; } }
    if (!d || typeof d !== "object") return [];
    /** @type {Map<string, number>} */
    const sum = new Map();
    for (const set of Object.values(d)) {
        if (!set || typeof set !== "object") continue;
        for (const [tag, count] of Object.entries(set)) {
            const t = String(tag).trim();
            const c = Number(count);
            if (!t || t.length >= TAG_LEN || !Number.isFinite(c)) continue;
            sum.set(t, (sum.get(t) || 0) + c);
        }
    }
    const top = [...sum.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    // a trigger word is in (nearly) every caption: a fragment of a sentence caption, seen a few times, is no tag
    const floor = top.length ? top[0][1] / 4 : 0;
    return top.filter((e) => e[1] >= floor).slice(0, TAGS).map((e) => e[0]);
}

/**
 * ComfyUI's /view_metadata answer (a file's `__metadata__`) reduced as main reduces a header it reads itself: the
 * fields of META_KEYS that are non-empty strings, each at most 4,000 characters, and `tags`; as JSON at most 16 KB,
 * the longest field halved until it fits. The twin of electron/main/loraheader.js reduceMetadata.
 * @param {any} meta
 * @returns {Record<string, any>}
 */
export function loraMeta(meta) {
    /** @type {Record<string, any>} */
    const out = {};
    if (!meta || typeof meta !== "object") return out;
    for (const k of META_KEYS) {
        const v = meta[k];
        if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, META_FIELD);
    }
    const tags = topTags(meta.ss_tag_frequency);
    if (tags.length) out.tags = tags;
    while (JSON.stringify(out).length > MAX_METADATA) {
        let longest = "";
        for (const k of META_KEYS) if (typeof out[k] === "string" && (!longest || out[k].length > out[longest].length)) longest = k;
        if (!longest) break;
        out[longest] = out[longest].slice(0, Math.floor(out[longest].length / 2));
    }
    return out;
}

/**
 * The words a LoRA's chips offer: its trigger phrase first (modelspec.trigger_phrase, split at commas), then its most
 * frequent caption tags; each trimmed, shorter than 40 characters, once (any case), five at most.
 * @param {any} header the reduced header or `{ metadata }`, or null
 * @returns {string[]}
 */
export function loraTriggers(header) {
    const meta = header && header.metadata && typeof header.metadata === "object" ? header.metadata : {};
    const words = [];
    const trig = typeof meta["modelspec.trigger_phrase"] === "string" ? meta["modelspec.trigger_phrase"].split(",") : [];
    for (const w of [...trig, ...(Array.isArray(meta.tags) ? meta.tags : [])]) {
        const t = String(w == null ? "" : w).trim();
        if (!t || t.length >= TAG_LEN || words.some((x) => x.toLowerCase() === t.toLowerCase())) continue;
        words.push(t);
        if (words.length >= TAGS) break;
    }
    return words;
}

/**
 * The prompt with a trigger word appended: `<prompt>, <word>` (the prompt's trailing spaces and commas off), the word
 * alone into an empty prompt.
 * @param {any} prompt
 * @param {any} word
 */
export function appendWord(prompt, word) {
    const p = String(prompt == null ? "" : prompt).replace(/[\s,]+$/, "");
    const w = String(word == null ? "" : word).trim();
    if (!w) return String(prompt == null ? "" : prompt);
    return p ? `${p}, ${w}` : w;
}

// ---- the picker's family group ----------------------------------------------------------------------------------------

/** A folder name's family words: which folder a recipe's family looks for ("klein" for FLUX.2 Klein, "Flux_3" ...). */
const FOLDER_WORDS = {
    flux1: /^(?:flux|flux[ ._-]?1(?:[ ._-]?dev)?|flux[ ._-]?dev|kontext)$/i,
    flux2: /^flux[ ._-]?2|klein/i,
    flux2_dev: /^flux[ ._-]?2(?:[ ._-]?dev)?$/i,
    flux2_klein: /klein/i,
    flux2_klein_4b: /klein/i,
    flux2_klein_9b: /klein/i,
    flux3: /^flux[ ._-]?3/i,
    qwen_image: /qwen(?![ ._-]?(?:image[ ._-]?)?2[ ._-]?1)/i,
    qwen_image_2_1: /qwen[ ._-]?(?:image[ ._-]?)?2[ ._-]?1/i,
    moss_image: /moss/i,
    z_image: /^z[ ._-]?image|zimage/i,
    sdxl: /sdxl/i,
    sd15: /^sd[ ._-]?1[ ._-]?5$/i,
    ideogram4: /ideogram/i,
};

/**
 * Whether a folder of the picker belongs to a recipe's family: one of its parts named for it (FOLDER_WORDS), or one of
 * its files' known hints a keys family that fits (`hintOf(name)`: the cached familyOf answer, or null).
 * @param {{ folder: string, names: string[] }} group
 * @param {string | null} recipeFam
 * @param {(name: string) => any} [hintOf]
 */
export function folderFits(group, recipeFam, hintOf) {
    if (!recipeFam || !group) return false;
    const word = FOLDER_WORDS[recipeFam];
    const parts = String(group.folder || "").split(/[\\/]+/).filter(Boolean);
    if (word && parts.some((p) => word.test(p))) return true;
    if (typeof hintOf !== "function") return false;
    return group.names.some((n) => {
        const f = hintOf(n);
        return !!(f && f.from === "keys" && f.family && familyFits(f.family, recipeFam));
    });
}

/**
 * The picker's groups split for a recipe's family: `{ first, rest }`, `first` the groups that fit it (folderFits), the
 * rest behind *Show all*; with no family known, or no group fitting, everything is `first`.
 * @param {{ folder: string, names: string[] }[]} groups
 * @param {string | null} recipeFam
 * @param {(name: string) => any} [hintOf]
 */
export function familyGroups(groups, recipeFam, hintOf) {
    const all = Array.isArray(groups) ? groups : [];
    if (!recipeFam) return { first: all, rest: [] };
    const first = all.filter((g) => folderFits(g, recipeFam, hintOf));
    return first.length ? { first, rest: all.filter((g) => !first.includes(g)) } : { first: all, rest: [] };
}
