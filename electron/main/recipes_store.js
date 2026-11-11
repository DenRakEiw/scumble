// @ts-check
// node output constants, the user's folder, normalize() with its variant helpers, the shipped presets, and the store (list, remove, save, slug): moved out of recipes.js (item 56 S11, docs/PLAN_SPLIT.md), text unchanged.
"use strict";

const path = require("node:path");
const fsp = require("node:fs/promises");
const { app } = require("electron");
const { REF_NAME_DEFAULT, validRefName } = require("./providers/refs");

/** @typedef {import("./recipes.js").ShippedPreset} ShippedPreset */
/** @typedef {import("./recipes.js").EditLimits} EditLimits */
/** @typedef {import("./recipes.js").UpscaleFactor} UpscaleFactor */
/** @typedef {import("./recipes.js").TextShape} TextShape */
/** @typedef {import("./recipes.js").TextRefs} TextRefs */
/** @typedef {import("./recipes.js").ProviderVariant} ProviderVariant */
/** @typedef {import("./recipes.js").Recipe} Recipe */
/** @typedef {import("./recipes.js").LocalUpsampler} LocalUpsampler */
/** @typedef {import("./recipes.js").UpsamplerRequest} UpsamplerRequest */
/** @typedef {import("./recipes.js").LocalBoxes} LocalBoxes */
/** @typedef {import("./recipes.js").LoraDecl} LoraDecl */

const FIXED_OUTPUTS = 13;   // InpaintCanvas outputs before setting_1 (nodes.py RETURN_NAMES)
const SETTING_SLOTS = 8;    // setting_1 .. setting_8
/**
 * The node's tail outputs after the settings (docs/PLAN_NODE_BOXES.md D2): backend slots 21 and 22; the node's frontend
 * shows them right after the connected settings, so a UI graph (and the page's graphToPrompt) holds them at a visible
 * slot that may be a setting's number. A recipe reads them by name: a recipe file keeps every prompt input on the plain
 * prompt, so a consumer of box_prompt gets the plain prompt (the one input a recipe's `boxes` names is wired to
 * box_prompt by the run that sends boxes, host.queueGenerate), and one of elements loses its link (tailOutputs).
 */
const TAIL_OUTPUTS = ["box_prompt", "elements"];
const PROMPT_SLOT = 7;
// The box formats a ComfyUI recipe takes: FLUX 3's rows, which the Inpaint Canvas node writes into its box_prompt output
// (boxes_rows.py), and MOSS-Image's JSON layout, which ComfyUI's MOSSImageLayoutPrompt writes from the node's elements
const LOCAL_BOX_SCHEMAS = ["flux3", "moss"];
const MOSS_LAYOUT = "MOSSImageLayoutPrompt";

/** A canvas output's name by its slot in the backend's order (no names known: an API prompt). */
function backendOutputName(slot) {
    if (slot < FIXED_OUTPUTS) return null;
    if (slot < FIXED_OUTPUTS + SETTING_SLOTS) return `setting_${slot - FIXED_OUTPUTS + 1}`;
    return TAIL_OUTPUTS[slot - FIXED_OUTPUTS - SETTING_SLOTS] || null;
}

/**
 * Every link from the canvas node (`canvasId`) in `prompt` read by its output's name (`nameOf(slot)`): a setting moves
 * to its backend slot, box_prompt's consumer is wired to the plain prompt, elements' consumer loses its link. Returns
 * the notes (in place).
 */
function tailOutputs(prompt, canvasId, nameOf) {
    const notes = [];
    for (const [id, node] of Object.entries(prompt)) {
        if (!node || !node.inputs || String(id) === String(canvasId)) continue;
        for (const [input, v] of Object.entries(node.inputs)) {
            if (!Array.isArray(v) || String(v[0]) !== String(canvasId) || +v[1] < FIXED_OUTPUTS) continue;
            const name = nameOf(+v[1]);
            const m = /^setting_([1-8])$/.exec(name || "");
            if (m) node.inputs[input] = [v[0], FIXED_OUTPUTS + +m[1] - 1];
            else if (name === "box_prompt") {
                node.inputs[input] = [v[0], PROMPT_SLOT];
                notes.push(`${node.class_type} ${id}.${input} took the canvas's box_prompt; a recipe keeps the plain prompt there (a run sends boxes only through the input its "boxes" field names), so it takes the plain prompt`);
            } else if (name === "elements") {
                delete node.inputs[input];
                notes.push(`${node.class_type} ${id}.${input} took the canvas's elements (boxes); Scumble sends none to a local recipe, so the link was dropped`);
            }
        }
    }
    return notes;
}
const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);
const SKIP_TYPES = new Set(["Note", "MarkdownNote", "PrimitiveNode", "Reroute"]);
/** Widgets of the frontend alone, which a named widget list carries and a run does not take. */
const UI_WIDGETS = new Set(["control_after_generate", "control_before_generate", "upload"]);

function userDir() {
    return path.join(app.getPath("userData"), "recipes");
}

// A recipe id is a file name in the recipes folder (save writes `<id>.json`, remove looks it up): letters, digits, ".",
// "_" and "-" only, never a path separator (H1 S9a). Every shipped id and every id the app makes (`slug`) is one.
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const safeId = (id) => SAFE_ID.test(String(id));

/** An id read from a recipe file made safe: what is not a letter, digit, ".", "_" or "-" becomes "_" (a warning says so). */
function readId(id, file) {
    const s = String(id);
    if (SAFE_ID.test(s)) return id;
    const fixed = s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "recipe";
    console.warn(`recipe ${file}: its id ${JSON.stringify(s).slice(0, 80)} holds characters other than letters, digits, ".", "_" and "-"; read as "${fixed}"`);
    return fixed;
}

async function readDir(dir, source) {
    const out = [];
    let names = [];
    try { names = (await fsp.readdir(dir)).filter((n) => n.endsWith(".json")).sort(); } catch (_) { return out; }
    for (const n of names) {
        try {
            const r = JSON.parse(await fsp.readFile(path.join(dir, n), "utf8"));
            r.id = readId(r.id || n.replace(/\.json$/, ""), n);
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
const TEXT_PROVIDERS = new Set(["toapis", "openai", "gemini", "bfl", "fal", "replicate", "wavespeed", "openrouter", "ark", "minimax", "comfyrouter", "comfypartner", "oxen", "magnific", "loopback"]);
// Providers whose text route a variant must name itself (`text: { model }`): Comfy Cloud makes new images only through a
// recipe's own text-to-image graph (item 35 V6), so its partner-node variants get none by default.
const TEXT_NAMED = new Set(["comfycloud"]);

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
    // `out`: an upscaler's answer cap on the long side (host.upscaleOutRefusal); kept only as a whole positive number
    if (l.out !== undefined) { const o = Math.round(+l.out); if (Number.isFinite(o) && o > 0) l.out = o; else delete l.out; }
    // `outPixels`: an upscaler's answer cap by area (Magnific Creative, 25.3 MP); the same rule
    if (l.outPixels !== undefined) { const o = Math.round(+l.outPixels); if (Number.isFinite(o) && o > 0) l.outPixels = o; else delete l.outPixels; }
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
    f.whole = f.whole === true;
    return f;
}

/**
 * A ComfyUI upscaler's factor: unfixed when the recipe names the input it goes into (`factor.input` "node|input", the
 * node in its graph: RTX Video Super Resolution's `resize_type.scale`), else fixed (an upscale model picks its own).
 * @param {Recipe} r
 * @returns {UpscaleFactor & { input?: string }}
 */
function comfyFactor(r) {
    const want = r.factor && typeof r.factor === "object" ? /** @type {any} */ (r.factor) : null;
    const m = want && typeof want.input === "string" ? /^([^|]+)\|(.+)$/.exec(want.input) : null;
    if (!m || !r.prompt || !r.prompt[m[1]]) {
        if (want && want.input !== undefined) console.warn(`${r.id}: factor.input ${JSON.stringify(want.input)} names no node of its graph; the factor is fixed`);
        return { ...FACTOR_DEFAULT, fixed: true };
    }
    const f = upscaleFactor(/** @type {Recipe} */ ({ id: r.id, factor: { ...want, fixed: false } }), /** @type {ProviderVariant} */ ({}));
    return { ...f, input: want.input, fixed: false };
}

/**
 * A ComfyUI upscaler's size limits, kept only as whole positive numbers: `min` the input's short side, `max` its long
 * side, `out` the answer's long side (RTX Video Super Resolution: 64, 4096, 8192), `picture` the whole picture's long
 * side alone (an upscale model: 2048, so a 4x model answers 8192; its selection's box keeps no cap). A missing one is
 * no limit.
 * @param {Recipe} r
 */
function comfyLimits(r) {
    const l = r.limits && typeof r.limits === "object" ? /** @type {any} */ (r.limits) : null;
    /** @type {Record<string, number>} */
    const out = {};
    if (l) for (const k of ["min", "max", "out", "picture"]) { const v = Math.round(+l[k]); if (Number.isFinite(v) && v > 0) out[k] = v; }
    if (Object.keys(out).length) r.limits = /** @type {any} */ (out); else delete r.limits;
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
    const t = v.text && typeof v.text === "object" ? v.text : {};
    if (!TEXT_PROVIDERS.has(providerId) && !(TEXT_NAMED.has(providerId) && t.model)) return null;
    const model = t.model || textModelOf(providerId, v.model);
    if (!model && providerId !== "loopback") return null;
    return {
        model,
        sizes: Array.isArray(t.sizes) ? t.sizes : (TEXT_SIZES[providerId] || TEXT_SIZES_DEFAULT),
        fixed: t.fixed || v.fixed || null,
        settings: Array.isArray(t.settings) ? t.settings : (v.settings || []),
        note: t.note || "",
        refs: textRefsOf(t.refs, where),
        ...(t.options && typeof t.options === "object" ? { options: t.options } : {}),
        ...textAspectsOf(t.aspects, where),
    };
}

/**
 * A text shape's own `aspects` (item 34): the "W:H" strings of a list, each once; anything else is dropped with a
 * warning. Absent: nothing (the dialog reads the variant's options and limits, else its general list).
 * @param {any} list
 * @param {string} where
 * @returns {{ aspects?: string[] }}
 */
function textAspectsOf(list, where) {
    if (list == null) return {};
    if (!Array.isArray(list)) { console.warn(`recipe ${where}: text.aspects is not a list, ignored`); return {}; }
    /** @type {string[]} */
    const out = [];
    for (const a of list) {
        const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(String(a));
        if (!m || !(+m[1] > 0) || !(+m[2] > 0)) { console.warn(`recipe ${where}: text.aspects entry ${JSON.stringify(a)} is not W:H, dropped`); continue; }
        const s = `${+m[1]}:${+m[2]}`;
        if (!out.includes(s)) out.push(s);
    }
    return out.length ? { aspects: out } : {};
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
 * A ComfyUI recipe's `boxes` checked against its graph (LocalBoxes): an object with a `schema` the app sends ("flux3",
 * "moss") and an `input` "node|input" of a node other than the canvas whose value is a link to the canvas node's
 * plain prompt (output 7) and that no Settings row writes, on an edit recipe; "moss" also a `layout`, the id of the
 * graph's MOSSImageLayoutPrompt node, whose element input no link fills (the run wires it). Answers `{ boxes }` (only
 * those keys) or `{ why }`.
 * @param {Recipe} r
 * @returns {{ boxes?: LocalBoxes, why?: string }}
 */
function localBoxes(r) {
    const b = /** @type {any} */ (r.boxes);
    if (!b || typeof b !== "object" || Array.isArray(b)) return { why: "is no object { schema, input }" };
    if (!LOCAL_BOX_SCHEMAS.includes(b.schema)) return { why: `names the schema ${JSON.stringify(b.schema)}; a ComfyUI recipe takes ${LOCAL_BOX_SCHEMAS.join(", ")}` };
    if (r.task !== undefined && r.task !== "edit") return { why: `is on a recipe of task "${r.task}"; only an edit recipe sends boxes` };
    const m = typeof b.input === "string" ? /^([^|]+)\|(.+)$/.exec(b.input) : null;
    if (!m) return { why: `names the input ${JSON.stringify(b.input)}, not "node|input"` };
    const node = r.prompt && r.prompt[m[1]];
    if (!node || !node.inputs || String(m[1]) === String(r.canvas)) return { why: `names the input ${b.input}, whose node is not in the graph (or is the canvas node)` };
    const v = node.inputs[m[2]];
    if (!Array.isArray(v) || String(v[0]) !== String(r.canvas) || +v[1] !== PROMPT_SLOT) return { why: `names the input ${b.input}, which does not take the canvas node's prompt (output ${PROMPT_SLOT})` };
    if ((r.settings || []).some((s) => s && String(s.node) === String(m[1]) && s.input === m[2])) return { why: `names the input ${b.input}, which a Settings row writes` };
    if (b.schema !== "moss") return { boxes: { schema: b.schema, input: b.input } };
    const lay = typeof b.layout === "string" && String(b.layout) !== String(r.canvas) ? r.prompt[b.layout] : null;
    if (!lay || lay.class_type !== MOSS_LAYOUT || !lay.inputs) return { why: `names the layout ${JSON.stringify(b.layout)}, which is no ${MOSS_LAYOUT} node of the graph` };
    if (String(b.layout) === String(m[1])) return { why: `names the input ${b.input} on the layout node itself` };
    if (lay.inputs.element !== undefined) return { why: `names the layout ${b.layout}, whose element input is filled already (a run that sends boxes wires it)` };
    return { boxes: { schema: b.schema, input: b.input, layout: String(b.layout) } };
}

/**
 * A ComfyUI recipe's `upsampler` checked against its graph (LocalUpsampler): `switch` a ComfySwitchNode of the graph
 * whose on_true links `run`, a TextGenerate or a TextGenerateV2, and whose on_false is a link; `nodes` ids of the graph
 * other than the canvas, the switch and the nodes on_false reads, `run` among them; `show` (optional) among them too;
 * `request` (optional) an object whose `edit` / `t2i` (one at least) are strings holding `{text}`, `picture` a string
 * holding `{n}`, `aspects` "W:H" strings, `verbatim` `{ match, drop }` (a pattern that compiles, a text `edit` holds).
 * Answers `{ upsampler }` (only those keys and the strings `t2i`, `source`) or
 * `{ why }`.
 * @param {Recipe} r
 * @returns {{ upsampler?: LocalUpsampler, why?: string }}
 */
function localUpsampler(r) {
    const u = /** @type {any} */ (r.upsampler);
    if (!u || typeof u !== "object" || Array.isArray(u)) return { why: "is no object { switch, run, nodes }" };
    const g = r.prompt || {};
    const sw = g[u.switch], run = g[u.run];
    if (!sw || sw.class_type !== "ComfySwitchNode" || !sw.inputs) return { why: `names the switch ${JSON.stringify(u.switch)}, which is no ComfySwitchNode of the graph` };
    if (!run || (run.class_type !== "TextGenerate" && run.class_type !== "TextGenerateV2")) return { why: `names the run ${JSON.stringify(u.run)}, which is no TextGenerate or TextGenerateV2 node of the graph` };
    const on = sw.inputs.on_true, off = sw.inputs.on_false;
    const ex = u.extract !== undefined ? g[u.extract] : null;
    if (u.extract !== undefined && (!ex || ex.class_type !== "JsonExtractString" || !ex.inputs || !Array.isArray(ex.inputs.json_string) || String(ex.inputs.json_string[0]) !== String(u.run))) return { why: `names the extract ${JSON.stringify(u.extract)}, which is no JsonExtractString of the graph reading ${u.run}` };
    const answer = u.extract !== undefined ? u.extract : u.run;
    if (!Array.isArray(on) || String(on[0]) !== String(answer)) return { why: `names the switch ${u.switch}, whose on_true does not take ${answer}` };
    if (!Array.isArray(off)) return { why: `names the switch ${u.switch}, whose on_false is no link (the prompt as typed)` };
    const nodes = Array.isArray(u.nodes) ? u.nodes.map(String) : [];
    if (!nodes.includes(String(u.run))) return { why: "lists nodes without its run" };
    const bad = nodes.find((id) => !g[id] || id === String(r.canvas) || id === String(u.switch) || id === String(off[0]));
    if (bad !== undefined) return { why: `lists the node ${JSON.stringify(bad)}, which is not in the graph or is the canvas, the switch or the prompt as typed` };
    if (u.show !== undefined && !nodes.includes(String(u.show))) return { why: `names the show node ${JSON.stringify(u.show)}, which its nodes do not list` };
    if (u.extract !== undefined && !nodes.includes(String(u.extract))) return { why: `names the extract ${JSON.stringify(u.extract)}, which its nodes do not list` };
    /** @type {LocalUpsampler} */
    const out = { switch: String(u.switch), run: String(u.run), nodes };
    if (u.show !== undefined) out.show = String(u.show);
    if (u.extract !== undefined) out.extract = String(u.extract);
    if (typeof u.t2i === "string" && u.t2i) out.t2i = u.t2i;
    if (u.request !== undefined) {
        const q = u.request;
        if (!q || typeof q !== "object" || Array.isArray(q)) return { why: "names a request that is no object { edit, t2i }" };
        /** @type {UpsamplerRequest} */
        const req = {};
        for (const k of /** @type {const} */ (["edit", "t2i"])) {
            if (q[k] === undefined) continue;
            if (typeof q[k] !== "string" || !q[k].includes("{text}")) return { why: `names a request whose ${k} is no text with {text}` };
            req[k] = q[k];
        }
        if (!req.edit && !req.t2i) return { why: "names a request with neither edit nor t2i" };
        if (q.picture !== undefined) {
            if (typeof q.picture !== "string" || !q.picture.includes("{n}")) return { why: "names a request whose picture is no text with {n}" };
            req.picture = q.picture;
        }
        if (q.aspects !== undefined) {
            if (!Array.isArray(q.aspects) || !q.aspects.length || !q.aspects.every((a) => typeof a === "string" && /^\d+:\d+$/.test(a))) return { why: "names a request whose aspects are no list of W:H" };
            req.aspects = q.aspects.slice();
        }
        if (q.verbatim !== undefined) {
            const v = q.verbatim;
            let re = null;
            try { re = v && typeof v === "object" && typeof v.match === "string" && v.match ? new RegExp(v.match) : null; } catch { re = null; }
            if (!re || typeof v.drop !== "string" || !v.drop || !req.edit || !req.edit.includes(v.drop)) return { why: "names a request whose verbatim is no { match: a pattern, drop: a text of its edit }" };
            req.verbatim = { match: v.match, drop: v.drop };
        }
        out.request = req;
    }
    if (typeof u.source === "string" && u.source) out.source = u.source;
    return { upsampler: out };
}

/**
 * A ComfyUI recipe's `newImage` checked against its graph: `drop` a list of "node|input", each an input of a node of
 * the graph other than the canvas node that holds a link (the picture Generate new's fresh canvas would send).
 * Answers `{ newImage }` or `{ why }`.
 * @param {Recipe} r
 * @returns {{ newImage?: { drop: string[] }, why?: string }}
 */
function localNewImage(r) {
    const n = /** @type {any} */ (r.newImage);
    if (!n || typeof n !== "object" || Array.isArray(n) || !Array.isArray(n.drop) || !n.drop.length) return { why: "is no object { drop: [\"node|input\", ...] }" };
    const g = r.prompt || {};
    for (const spec of n.drop) {
        const at = typeof spec === "string" ? spec.indexOf("|") : -1;
        const id = at > 0 ? spec.slice(0, at) : "", input = at > 0 ? spec.slice(at + 1) : "";
        const node = id && id !== String(r.canvas) ? g[id] : null;
        if (!node || !node.inputs || !Array.isArray(node.inputs[input])) return { why: `names ${JSON.stringify(spec)}, which is no linked input of a node of the graph` };
    }
    return { newImage: { drop: n.drop.map(String) } };
}

/**
 * The graph with its upsampler left out (`up`, a checked LocalUpsampler): the switch's consumers take its on_false
 * (the prompt as typed), the switch and the upsampler's nodes go. A copy; the graph given as it was without `up`.
 * @param {Record<string, any>} prompt
 * @param {LocalUpsampler | undefined} up
 */
function withoutUpsampler(prompt, up) {
    const g = JSON.parse(JSON.stringify(prompt || {}));
    const sw = up && g[up.switch];
    if (!sw || !sw.inputs || !Array.isArray(sw.inputs.on_false)) return g;
    const off = sw.inputs.on_false;
    for (const node of Object.values(g)) {
        if (!node || !node.inputs) continue;
        for (const [k, v] of Object.entries(node.inputs)) if (Array.isArray(v) && String(v[0]) === String(up.switch)) node.inputs[k] = off;
    }
    delete g[up.switch];
    for (const id of up.nodes || []) delete g[id];
    return g;
}

/**
 * A recipe's `loras` (LoraDecl) checked against one graph: `false` as it is; an object keeps `model` while it names a
 * node of the graph other than the canvas node, and `family` while it is a name (other keys go). Answers `{ loras }`
 * (undefined when nothing of it holds: the graph's own model loader is then found by renderer/editor/loras.js's rule)
 * and the findings in `why`, one per part left out.
 * @param {any} decl
 * @param {Record<string, any> | null | undefined} graph
 * @param {string} [canvas]
 * @returns {{ loras?: LoraDecl, why: string[] }}
 */
function lorasOf(decl, graph, canvas) {
    if (decl === false) return { loras: false, why: [] };
    if (!decl || typeof decl !== "object" || Array.isArray(decl)) return { why: [`${JSON.stringify(decl)} is neither false nor { model, family }`] };
    /** @type {{ model?: string, family?: string }} */
    const out = {};
    const why = [];
    if (decl.model !== undefined) {
        const m = typeof decl.model === "string" ? decl.model : "";
        if (m && graph && graph[m] && m !== String(canvas == null ? "" : canvas)) out.model = m;
        else why.push(`names the model source ${JSON.stringify(decl.model)}, which is no node of the graph`);
    }
    if (decl.family !== undefined) {
        if (typeof decl.family === "string" && decl.family.trim()) out.family = decl.family.trim();
        else why.push(`names the family ${JSON.stringify(decl.family)}, which is no name`);
    }
    if (!Object.keys(out).length && !why.length) why.push("names neither a model source nor a family");
    return Object.keys(out).length ? { loras: out, why } : { why };
}

/**
 * Fill in everything the rest of the app is allowed to rely on. Runs on every recipe that
 * is read from disk or imported; the shape it answers is the typedef above.
 * @param {Recipe} r
 * @returns {Recipe}
 */
function normalize(r) {
    r.presets = shippedPresets(r.presets);
    if (!r.presets.length) delete r.presets;
    // a recipe whose runs refuse an empty prompt (host.promptMissing): true or absent, any other value dropped
    if (r.promptRequired !== undefined && r.promptRequired !== true) {
        if (r.promptRequired !== false) console.warn(`${r.id}: promptRequired ${JSON.stringify(r.promptRequired)} is no true or false; an empty prompt goes`);
        delete r.promptRequired;
    }
    if (r.kind !== "provider") {
        // a ComfyUI recipe may be an upscaler too (recipes/upscale_model_local.json): the model picks its own
        // factor, and only the selection mode exists (the node's stitch fits the answer back into the box);
        // or the Realism Pass (task "pass", recipes/realism_pass.json): the box at its own size through DLSS 5
        // RTX Video Super Resolution (recipes/rtx_vsr_local.json) names the input its factor goes into
        if (r.task === "upscale") { r.factor = comfyFactor(r); comfyLimits(r); }
        else if (r.task !== undefined && r.task !== "pass" && r.task !== "relight") r.task = "edit";
        // false: a text-to-image graph (recipes/moss_image_local.json), Generate new only; a run on a selection refuses
        r.edit = r.edit !== false || r.task === "upscale" || r.task === "pass" || r.task === "relight";
        comfyRefs(r);
        // boxes in the prompt (the node's box_prompt): a declaration that does not hold is dropped, so no run sends any
        if (r.boxes !== undefined) {
            const got = localBoxes(r);
            if (got.boxes) r.boxes = got.boxes;
            else {
                console.warn(`${r.id}: boxes ${JSON.stringify(r.boxes)} ${got.why}; the recipe sends no boxes`);
                delete r.boxes;
            }
        }
        // a prompt upsampler in the graph: a declaration that does not hold is dropped (the graph then goes as it is, its
        // switch deciding on the server)
        if (r.upsampler !== undefined) {
            const up = localUpsampler(r);
            if (up.upsampler) r.upsampler = up.upsampler;
            else {
                console.warn(`${r.id}: upsampler ${up.why}; the graph goes as it is`);
                delete r.upsampler;
            }
        }
        // Generate new as text to image on an edit graph (P-H3-Image): a declaration that does not hold is dropped (the
        // fresh canvas's white crop then goes as the picture, as on every other edit recipe)
        if (r.newImage !== undefined) {
            const got = localNewImage(r);
            if (got.newImage) r.newImage = got.newImage;
            else {
                console.warn(`${r.id}: newImage ${got.why}; Generate new sends the fresh canvas`);
                delete r.newImage;
            }
        }
        // where the LoRA rows go (item 50): a part that does not hold is left out, the rest kept
        if (r.loras !== undefined) {
            const got = lorasOf(r.loras, r.prompt, r.canvas);
            for (const w of got.why) console.warn(`${r.id}: loras ${w}; left out`);
            if (got.loras === undefined) delete r.loras;
            else r.loras = got.loras;
        }
        return r;
    }
    if (!r.providers || typeof r.providers !== "object" || !Object.keys(r.providers).length) {
        const id = r.provider || "loopback";
        r.providers = { [id]: { model: r.model || "", input: r.input || "fill", fields: r.fields || null, fixed: r.fixed || null, settings: r.settings || [], options: r.options || null, note: r.note || "" } };
        r.default = id;
    }
    r.task = r.task === "upscale" ? "upscale" : r.task === "relight" ? "relight" : "edit";
    for (const [id, v] of Object.entries(r.providers)) {
        v.limits = editLimits(r, v);
        v.refs = refsOf(v.refs !== undefined ? v.refs : r.refs, `${r.id}/${id}`);
        // a graph variant's LoRAs (item 50): checked against its edit graph here, against its text route's graph below
        const lorasDeclared = v.loras;
        const graph = v.options && typeof v.options === "object" && v.options.graph && typeof v.options.graph === "object" ? v.options.graph : null;
        if (lorasDeclared !== undefined) {
            const got = graph ? lorasOf(lorasDeclared, graph) : { why: ["is on a variant without a graph (LoRAs go into Comfy Cloud graphs only)"] };
            for (const w of got.why) console.warn(`recipe ${r.id}/${id}: loras ${w}; left out`);
            if (got.loras === undefined) delete v.loras;
            else v.loras = got.loras;
        }
        if (r.task === "upscale") {
            // an upscaler makes nothing from a prompt alone, so it has no Generate new shape
            v.text = null;
            v.edit = true;
            v.factor = upscaleFactor(r, v);
            // the tab's prompt goes along as guidance only where the model takes one (Clarity, Magnific Creative)
            v.usesPrompt = v.usesPrompt === true || (v.usesPrompt === undefined && r.usesPrompt === true);
            continue;
        }
        if (r.task === "relight") {
            v.text = null;
            v.edit = true;
            continue;
        }
        v.text = textVariant(id, v, `${r.id}/${id}`);
        v.edit = v.edit !== false;   // false: text to image only, no Generate on a crop
        // the text route runs its own graph (text.options) or the variant's: the declaration holds for it as far as its
        // graph has the named node (two templates' graphs share ids such as 75:70, so each route is checked by itself)
        if (lorasDeclared !== undefined && graph && v.text) {
            const tg = v.text.options && typeof v.text.options === "object" && v.text.options.graph && typeof v.text.options.graph === "object" ? v.text.options.graph : null;
            if (!tg) {
                if (v.loras !== undefined) v.text.loras = v.loras;
            } else {
                const got = lorasOf(lorasDeclared, tg);
                for (const w of got.why) console.warn(`recipe ${r.id}/${id} (text): loras ${w}; left out`);
                if (got.loras !== undefined) v.text.loras = got.loras;
            }
        }
    }
    r.providerIds = Object.keys(r.providers);
    if (!r.default || !r.providers[r.default]) r.default = r.providerIds[0];
    return r;
}

/**
 * A recipe file's `presets`, checked: each a name and a values object of "<node>:<input>" keys with plain values;
 * a malformed entry is dropped, a later one of the same name too.
 * @param {any} list
 * @returns {ShippedPreset[]}
 */
function shippedPresets(list) {
    if (!Array.isArray(list)) return [];
    /** @type {ShippedPreset[]} */
    const out = [];
    const seen = new Set();
    for (const p of list) {
        if (!p || typeof p !== "object") continue;
        const name = typeof p.name === "string" ? p.name.trim() : "";
        if (!name || seen.has(name) || !p.values || typeof p.values !== "object" || Array.isArray(p.values)) continue;
        /** @type {Record<string, any>} */
        const values = {};
        for (const [k, v] of Object.entries(p.values)) {
            // "<node>:<input>": a node id may hold colons itself (a flattened subgraph's "57:12"), an input name none
            if (/^.+:[^:]+$/.test(k) && ["string", "number", "boolean"].includes(typeof v)) values[k] = v;
        }
        if (!Object.keys(values).length) continue;
        seen.add(name);
        out.push({ name, values });
    }
    return out;
}

async function list(builtinDir) {
    const builtin = await readDir(builtinDir, "builtin");
    const user = await readDir(userDir(), "user");
    const seen = new Set(user.map((r) => r.id));
    return [...user, ...builtin.filter((r) => !seen.has(r.id))];
}

/** Remove the user recipe `id`: the file it was read from (its `file`, which may differ from `<id>.json`). */
async function remove(id) {
    const want = String(id || "");
    if (!safeId(want)) throw new Error("bad recipe id");
    const r = (await readDir(userDir(), "user")).find((x) => String(x.id) === want);
    if (!r) throw new Error(`no recipe of yours has the id "${want}"`);
    await fsp.unlink(path.join(userDir(), r.file));
    return true;
}

/**
 * Write a user recipe: over the file a user recipe of the same id was read from (its `file`, which may differ from
 * `<id>.json`, so one id never lies in two files), else as `<id>.json`.
 */
async function save(recipe) {
    const id = String(recipe && recipe.id);
    if (!safeId(id)) throw new Error(`a recipe id is letters, digits, ".", "_" and "-" only; "${id.slice(0, 80)}" is not saved`);
    const dir = userDir();
    const had = (await readDir(dir, "user")).find((x) => String(x.id) === id);
    const file = path.join(dir, had ? had.file : id + ".json");
    if (path.dirname(file) !== dir) throw new Error(`the recipe "${id.slice(0, 80)}" would land outside the recipes folder`);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, JSON.stringify(recipe, null, 2) + "\n", "utf8");
    return file;
}

function slug(name) {
    return String(name || "recipe").toLowerCase().replace(/\.json$/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "recipe";
}

module.exports = { FIXED_OUTPUTS, LIMITS_DEFAULT, SKIP_TYPES, UI_WIDGETS, WIDGET_TYPES, backendOutputName, list, localBoxes, lorasOf, normalize, remove, save, shippedPresets, slug, tailOutputs, userDir, withoutUpsampler };
