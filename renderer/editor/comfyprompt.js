// @ts-check
// The whole picture through an upscale recipe on the user's ComfyUI (docs/PLAN_0_1_42.md U2): the recipe's own graph,
// with its Inpaint Canvas node turned into a loader of one picture (InpaintCanvasLoadRef, the same pack) and a
// PreviewImage on the recipe's result, so the answer comes back at its own size instead of being fitted into a box by
// the node's stitch. host.runComfyUpscale queues it through comfyPictureRun.
// And boxes in the prompt on the user's ComfyUI: a recipe that declares where FLUX 3's box rows go (`boxes: { schema,
// input }`, electron/main/recipes.js localBoxes) has that input taken from the Inpaint Canvas node's box_prompt output
// for a run that sends boxes (host.queueGenerate; the node writes the rows from the canvas state, docs/PLAN_NODE_BOXES.md).
//
// App-only: host.js imports it; it is not in tools/build_node.py FILES (the node has no whole-picture route, and its
// own graphs wire box_prompt by hand). Pure, no DOM, no editor: tools/comfyprompt_test.js imports this file.

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

// ---- boxes in the prompt on the user's ComfyUI -----------------------------------------------------------------------

/** The canvas node's output that carries the prompt with FLUX 3's box rows (nodes.py, after the settings slots). */
export const BOX_PROMPT = "box_prompt";

/**
 * The format a run of a ComfyUI recipe sends boxes in: its `boxes.schema` ("flux3") when it declares the input the rows
 * go to, else null. A provider recipe answers null here (its format is its variant's `options.boxes`).
 * @param {any} r
 * @returns {string | null}
 */
export function localBoxSchema(r) {
    const b = r && r.kind !== "provider" && r.prompt ? r.boxes : null;
    return b && typeof b.schema === "string" && typeof b.input === "string" && b.input.indexOf("|") > 0 ? b.schema : null;
}

/**
 * The slot of the Inpaint Canvas node's box_prompt output on the server whose node list is `objectInfo`, found by its
 * name (it follows the settings slots), or -1: a node from before the boxes, or no node list.
 * @param {any} objectInfo
 */
export function boxPromptSlot(objectInfo) {
    const info = objectInfo && objectInfo.InpaintCanvas;
    const names = info && Array.isArray(info.output_name) ? info.output_name : [];
    return names.indexOf(BOX_PROMPT);
}

/**
 * `prompt` (a copy of the recipe's graph as it is queued) with the input the recipe's `boxes.input` names taken from the
 * canvas node's output `slot` (box_prompt) instead of its plain prompt, in place. Answers whether it was wired: false
 * when the recipe declares no boxes, the slot is none, or that input does not read the canvas node.
 * @param {Record<string, any>} prompt
 * @param {any} r
 * @param {number} slot
 */
export function wireBoxPrompt(prompt, r, slot) {
    if (!localBoxSchema(r) || !Number.isInteger(slot) || slot < 0) return false;
    const at = r.boxes.input.indexOf("|");
    const node = prompt && prompt[r.boxes.input.slice(0, at)];
    const name = r.boxes.input.slice(at + 1);
    const v = node && node.inputs ? node.inputs[name] : undefined;
    if (!isLink(v) || String(v[0]) !== String(r.canvas)) return false;
    node.inputs[name] = [v[0], slot];
    return true;
}

/** Where the Inpaint Canvas node's current version is (the boxes are newer than the Comfy Registry's 0.3.4). */
export const NODE_REPO = "https://github.com/DenRakEiw/ComfyUI-InpaintCanvas";

/**
 * The sentence a run that sends boxes refuses with when the Inpaint Canvas node on the server has no box_prompt output
 * (the Comfy Registry's 0.3.4 has none: the boxes came to the node on 2026-10-15). A Registry or Manager install has no
 * .git folder, so a git pull is no way out for it: it is replaced by a clone.
 * @param {any} r
 */
export function oldNodeBoxes(r) {
    const name = (r && (r.name || r.id)) || "This recipe";
    return `${name} sends the boxes through the Inpaint Canvas node's box_prompt output, which the node on this ComfyUI does not have: update the Inpaint Canvas node to its current GitHub version (a git clone: git pull in its folder under custom_nodes; installed through the Comfy Registry or the Manager: replace that folder with a git clone of ${NODE_REPO}), then restart ComfyUI, or turn the Boxes switch under the prompt off.`;
}

/**
 * The boxes of a new picture (Generate new on a fresh canvas): a Keep, Move or Remove box has no source in a picture that
 * does not exist yet and is left out, with the note an API model's Generate new gives (boxes_format.js rowsText); New,
 * Text and From boxes stay (a From box's reference goes in the node's batch). `boxes` as canvas_state carries them.
 * @param {any[]} boxes
 * @returns {{ boxes: any[], dropped: string[] }}
 */
export function newImageBoxes(boxes) {
    const out = [], dropped = [];
    for (const b of boxes || []) {
        if (b && (b.kind === "keep" || b.kind === "move" || b.kind === "remove")) dropped.push(`${b.id}: a new image has no source to keep, move or remove (${b.kind}).`);
        else if (b) out.push(b);
    }
    return { boxes: out, dropped };
}

/** An @img token in a box's description (boxes_model.js TOKEN). */
const BOX_TOKEN = /@img([1-9][0-9]*)\b/g;

/**
 * The boxes with each @img token of a description written as the name the recipe gives its picture (`nameOf(n)`: the
 * name of @img<n>'s picture in this run, "<ref_image_1>", or null), as the prompt names it; a token whose picture does
 * not go stays as it is, and the node's note says so. New objects; the boxes given are not changed.
 * @param {any[]} boxes
 * @param {(n: number) => string | null} nameOf
 */
export function nameBoxTokens(boxes, nameOf) {
    return (boxes || []).map((b) => {
        if (!b || typeof b.desc !== "string" || !b.desc.includes("@img")) return b;
        return { ...b, desc: b.desc.replace(BOX_TOKEN, (m, n) => nameOf(+n) || m) };
    });
}

/**
 * A canvas state's boxes (`state.boxes`, document pixels) drawn on a picture of `from` [w, h], sent with a new picture of
 * `to` [w, h] (Generate new on a fresh canvas): each rect (and a keep / move / remove source, which newImageBoxes leaves
 * out of a new picture) scaled as fractions of the picture, as an API model's Generate new places its boxes (another
 * shape stretches them); a from box's source is fractions of its layer and stays. In place; answers whether anything
 * was scaled.
 * @param {any} state
 * @param {[number, number]} from
 * @param {[number, number]} to
 */
export function scaleStateBoxes(state, from, to) {
    const list = state && Array.isArray(state.boxes) ? state.boxes : null;
    const [fw, fh] = from || [0, 0], [tw, th] = to || [0, 0];
    if (!list || !list.length || !(fw > 0 && fh > 0 && tw > 0 && th > 0) || (fw === tw && fh === th)) return false;
    const sx = tw / fw, sy = th / fh;
    const scale = (/** @type {any} */ q) => (Array.isArray(q) && q.length === 4 ? [q[0] * sx, q[1] * sy, q[2] * sx, q[3] * sy] : q);
    for (const b of list) {
        if (!b || typeof b !== "object") continue;
        b.rect = scale(b.rect);
        if (b.kind !== "from" && b.src != null) b.src = scale(b.src);
    }
    return true;
}
