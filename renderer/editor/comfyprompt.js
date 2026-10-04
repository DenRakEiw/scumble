// @ts-check
// The whole picture through an upscale recipe on the user's ComfyUI (docs/PLAN_0_1_42.md U2): the recipe's own graph,
// with its Inpaint Canvas node turned into a loader of one picture (InpaintCanvasLoadRef, the same pack) and a
// PreviewImage on the recipe's result, so the answer comes back at its own size instead of being fitted into a box by
// the node's stitch. host.runComfyUpscale queues it through comfyPictureRun.
//
// App-only: host.js imports it; it is not in tools/build_node.py FILES (the node has no whole-picture route). Pure, no
// DOM, no editor: tools/comfyprompt_test.js imports this file.

/** The node of wholePicturePrompt whose picture is the answer. */
export const WHOLE_OUTPUT = "scumble_out";
/** What the canvas node becomes: the Inpaint Canvas pack's loader of a stored picture (`ref`: a JSON file reference). */
export const LOAD_CLASS = "InpaintCanvasLoadRef";

/** The canvas node's outputs by slot: the twin of electron/main/recipes.js CANVAS_OUTPUTS (a renderer module cannot read it). */
export const CANVAS_OUTPUTS = ["crop_image", "crop_mask", "image", "mask", "stitch_info", "crop_width", "crop_height", "prompt", "control_image", "denoise", "seed", "mode", "negative"];

/** @param {any} v */
const isLink = (v) => Array.isArray(v) && v.length === 2 && (typeof v[0] === "string" || typeof v[0] === "number") && Number.isInteger(v[1]);

/**
 * The result a recipe names ("node:slot", the slot 0 when left out) -> { node, slot }, or null.
 * @param {{ result?: string }} r
 */
export function resultOf(r) {
    const s = String((r && r.result) || "");
    if (!s) return null;
    const at = s.lastIndexOf(":");
    const node = at < 0 ? s : s.slice(0, at);
    const slot = at < 0 ? 0 : +s.slice(at + 1);
    return node && Number.isInteger(slot) && slot >= 0 ? { node, slot } : null;
}

/**
 * Every input of the recipe's graph that reads the canvas node: [{ node, input, slot }].
 * @param {{ prompt?: Record<string, any>, canvas?: string }} r
 */
export function canvasReads(r) {
    /** @type {{ node: string, input: string, slot: number }[]} */
    const out = [];
    const canvas = String((r && r.canvas) || "");
    for (const [id, node] of Object.entries((r && r.prompt) || {})) {
        if (id === canvas || !node || !node.inputs) continue;
        for (const [input, v] of Object.entries(node.inputs)) if (isLink(v) && String(v[0]) === canvas) out.push({ node: id, input, slot: v[1] });
    }
    return out;
}

/**
 * "" when the recipe can upscale the whole picture this way, else the sentence it refuses with: a graph that reads more
 * than the picture from the canvas node (its mask, its prompt, a Settings slot) has nothing to read once the node is a
 * loader, and the answer must be the result's own picture.
 * @param {any} r
 */
export function wholePictureRefusal(r) {
    const name = (r && (r.name || r.id)) || "This recipe";
    if (!r || !r.prompt || typeof r.prompt !== "object") return "No recipe selected.";
    if (!r.canvas || !r.prompt[r.canvas]) return `${name} has no canvas node "${r && r.canvas}".`;
    const res = resultOf(r);
    if (!res || !r.prompt[res.node] || res.node === r.canvas) return `${name} names no result node of its graph.`;
    if (r.prompt[WHOLE_OUTPUT]) return `${name} holds a node named ${WHOLE_OUTPUT}, the one Scumble adds for the answer; it cannot upscale the whole picture.`;
    const more = canvasReads(r).filter((x) => x.slot !== 0);
    if (more.length) {
        const what = Array.from(new Set(more.map((x) => CANVAS_OUTPUTS[x.slot] || `setting ${x.slot - CANVAS_OUTPUTS.length + 1}`)));
        return `${name} reads more than the picture from the canvas node (its ${what.join(", ")}); it cannot upscale the whole picture.`;
    }
    return "";
}

/**
 * The prompt that upscales a stored picture with the recipe's graph: a copy of `r.prompt`; the canvas node keeps its id
 * and becomes `InpaintCanvasLoadRef { ref }` (its output 0 is an IMAGE like the canvas node's slot 0, so the links that
 * read `[canvas, 0]` read the picture); the Settings rows' values (`settings`: the editor's, `{ [index]: { value } }`)
 * and the factor (`factor` into the recipe's `factor.input`, when it is not null) written; a `PreviewImage` named
 * WHOLE_OUTPUT on the recipe's result (temp files: nothing lands in the user's output folder). Throws
 * wholePictureRefusal's sentence. The recipe's own graph is not changed.
 * @param {any} r a ComfyUI upscale recipe as normalize() serves it
 * @param {{ filename: string, subfolder?: string, type?: string }} ref the stored picture
 * @param {number | null} factor
 * @param {Record<string, { value?: any } | undefined> | null} [settings]
 * @returns {Record<string, { class_type: string, inputs: Record<string, any>, _meta?: any }>}
 */
export function wholePicturePrompt(r, ref, factor, settings) {
    const why = wholePictureRefusal(r);
    if (why) throw new Error(why);
    const prompt = JSON.parse(JSON.stringify(r.prompt));
    const was = prompt[r.canvas];
    prompt[r.canvas] = {
        ...(was && was._meta ? { _meta: was._meta } : {}),
        class_type: LOAD_CLASS,
        inputs: { ref: JSON.stringify({ filename: ref.filename, subfolder: ref.subfolder || "", type: ref.type || "input" }) },
    };
    for (const s of Array.isArray(r.settings) ? r.settings : []) {
        if (!s || s.node === r.canvas) continue;
        const entry = settings ? settings[String(s.index)] : undefined;
        const node = prompt[s.node];
        if (entry && entry.value != null && node && node.inputs) node.inputs[s.input] = entry.value;
    }
    const target = r.factor && typeof r.factor.input === "string" ? r.factor.input : "";
    if (factor != null && target) {
        const at = target.indexOf("|"), node = prompt[target.slice(0, at)];
        if (node && node.inputs) node.inputs[target.slice(at + 1)] = factor;
    }
    const res = /** @type {{ node: string, slot: number }} */ (resultOf(r));
    prompt[WHOLE_OUTPUT] = { class_type: "PreviewImage", inputs: { images: [res.node, res.slot] } };
    return prompt;
}

/**
 * The node types the whole-picture prompt of `r` queues (what /object_info must list), sorted.
 * @param {any} r
 */
export function wholePictureClasses(r) {
    const p = wholePicturePrompt(r, { filename: "-" }, null, null);
    return Array.from(new Set(Object.values(p).map((n) => n.class_type))).sort();
}
