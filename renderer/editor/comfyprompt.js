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
 * The format a run of a ComfyUI recipe sends boxes in: its `boxes.schema` ("flux3", "moss") when it declares the input
 * the rows go to (and "moss" its layout node), else null. A provider recipe answers null here (its format is its
 * variant's `options.boxes`).
 * @param {any} r
 * @returns {string | null}
 */
export function localBoxSchema(r) {
    const b = r && r.kind !== "provider" && r.prompt ? r.boxes : null;
    if (!b || typeof b.schema !== "string" || typeof b.input !== "string" || b.input.indexOf("|") <= 0) return null;
    return b.schema !== "moss" || (typeof b.layout === "string" && !!b.layout) ? b.schema : null;
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
 * canvas node's output `slot` (box_prompt) instead of its plain prompt, in place. A "moss" recipe instead wires its
 * layout node's element input to the canvas node's elements output (the one after box_prompt: the node only ever
 * appends outputs, nodes.py RETURN_NAMES) and takes `input` from the layout node, which writes the prompt as the
 * caption and the boxes in the picture's pixels. Answers whether it was wired: false when the recipe declares no boxes,
 * the slot is none, or that input does not read the canvas node.
 * @param {Record<string, any>} prompt
 * @param {any} r
 * @param {number} slot
 */
export function wireBoxPrompt(prompt, r, slot) {
    const schema = localBoxSchema(r);
    if (!schema || !Number.isInteger(slot) || slot < 0) return false;
    const at = r.boxes.input.indexOf("|");
    const node = prompt && prompt[r.boxes.input.slice(0, at)];
    const name = r.boxes.input.slice(at + 1);
    const v = node && node.inputs ? node.inputs[name] : undefined;
    if (!isLink(v) || String(v[0]) !== String(r.canvas)) return false;
    if (schema === "moss") {
        const lay = prompt[r.boxes.layout];
        if (!lay || !lay.inputs) return false;
        lay.inputs.element = [v[0], slot + 1];
        node.inputs[name] = [String(r.boxes.layout), 0];
        return true;
    }
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
    const out = localBoxSchema(r) === "moss" ? "elements" : "box_prompt";
    return `${name} sends the boxes through the Inpaint Canvas node's ${out} output, which the node on this ComfyUI does not have: update the Inpaint Canvas node to its current GitHub version (a git clone: git pull in its folder under custom_nodes; installed through the Comfy Registry or the Manager: replace that folder with a git clone of ${NODE_REPO}), then restart ComfyUI, or turn the Boxes switch under the prompt off.`;
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

// ---- a prompt upsampler in the recipe's graph (FLUX 3 Image Klein, 0.1.50 Q9) ----------------------------------------

/** The ordinal BFL's upsampler names a picture by ("the first image" is the crop). */
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const ordinalImage = (n) => (n >= 1 && n <= ORDINALS.length ? `the ${ORDINALS[n - 1]} image` : `image ${n}`);
/** The edit request around the user's words, as BFL's upsampler was trained on it (flux-3-image-klein `pup.py`). */
export const UPSAMPLE_EDIT_REQUEST = (text) => `Reference images follow in order (the first image, the second image, ...).\nUser request: ${text}\nOutput the caption.`;

/**
 * The prompt with each picture name the recipe gives (`refs.name`, "<ref_image_{n0}>") written as the ordinal the
 * upsampler reads ("the second image" for <ref_image_1>): its guides name pictures by ordinal and forbid angle-bracket
 * tokens, and the image model then gets the upsampler's caption with the pictures in the same order.
 * @param {string} text
 * @param {any} r
 */
export function ordinalNames(text, r) {
    const pat = r && r.refs && typeof r.refs.name === "string" ? r.refs.name : "";
    const m = /\{(n0|n)\}/.exec(pat);
    if (!m || typeof text !== "string") return text;
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(esc(pat.slice(0, m.index)) + "(\\d+)" + esc(pat.slice(m.index + m[0].length)), "g");
    return text.replace(re, (_, d) => ordinalImage(+d + (m[1] === "n0" ? 1 : 0)));
}

/**
 * `prompt` (a copy of the recipe's graph as it is queued, its Settings rows written) with the recipe's `upsampler`
 * resolved, in place. The recipe file keeps the upsampler as Comfy's templates do: a switch node (`upsampler.switch`,
 * a ComfySwitchNode whose `switch` a Settings row writes) choosing between the plain wrapper (on_false) and the
 * TextGenerate node (`upsampler.run`, on_true), and a PreviewAny (`upsampler.show`) on its caption. The queued prompt
 * never holds the switch: its consumers take the chosen side directly, and the upsampler's nodes (`upsampler.nodes`)
 * go only when it runs, since ComfyUI checks every node an output reads, a lazy side too (a missing upsampler file
 * would refuse every run). It runs when the switch is on, no box goes (its plain guides know no boxes), the server has
 * the upsampler's file and its node types; else the prompt goes as typed and `note` says why (null when the switch is
 * off). Running, the TextGenerate node gets the request: Generate new without pictures after the crop takes the `t2i`
 * guide (`upsampler.t2i`) with "TARGET CANVAS: W:H" and no picture, everything else the `i2i` guide the graph holds,
 * with the crop batch's pictures in the image model's order and BFL's three-line request; the pictures' names as
 * ordinals (`ordinalNames`).
 * @param {Record<string, any>} prompt
 * @param {any} r
 * @param {{ text: string, fresh?: boolean, refsGo?: boolean, aspect?: string | null, boxes?: boolean, files?: string[] | null, classes?: Record<string, any> | null }} o
 * @returns {{ on: boolean, note: string | null, show: string | null }}
 */
export function wireUpsampler(prompt, r, o) {
    const u = r && r.upsampler;
    const none = { on: false, note: null, show: null };
    if (!u || !prompt) return none;
    const sw = prompt[u.switch], run = prompt[u.run];
    if (!sw || !sw.inputs || !run || !run.inputs) return none;
    const wanted = sw.inputs.switch !== false;
    const clip = run.inputs.clip && prompt[run.inputs.clip[0]];
    const file = clip && clip.inputs ? String(clip.inputs.clip_name || "") : "";
    const lacks = ["TextGenerate", "PreviewAny"].filter((c) => o.classes && !o.classes[c]);
    let why = null;
    if (!wanted) why = "";
    else if (o.boxes) why = "The prompt upsampler stays off while boxes go (its guides take no boxes); the prompt went with the boxes as typed.";
    else if (lacks.length) why = `The prompt went as typed: the prompt upsampler needs ComfyUI's ${lacks.join(" and ")} node${lacks.length === 1 ? "" : "s"} (ComfyUI 0.42 or newer).`;
    else if (o.files && file && !o.files.includes(file)) why = `The prompt went as typed: the prompt upsampler's file ${file} is not on your ComfyUI (models/text_encoders; the recipe's description says where to get it), or switch the Prompt upsampler row off.`;
    const on = why === null;
    const side = on ? [String(u.run), 0] : sw.inputs.on_false;
    // the switch's consumers take the chosen side; the switch itself never goes
    for (const node of Object.values(prompt)) {
        if (!node || !node.inputs) continue;
        for (const [k, v] of Object.entries(node.inputs)) if (Array.isArray(v) && String(v[0]) === String(u.switch)) node.inputs[k] = side;
    }
    delete prompt[u.switch];
    if (!on) {
        for (const id of u.nodes || []) delete prompt[id];
        return { on: false, note: why || null, show: null };
    }
    const text = ordinalNames(String(o.text || ""), r);
    if (o.fresh && !o.refsGo && typeof u.t2i === "string") {
        delete run.inputs.image;
        run.inputs.system_prompt = u.t2i;
        run.inputs["sampling_mode.presence_penalty"] = 1.5;
        run.inputs.prompt = (o.aspect ? `TARGET CANVAS: ${o.aspect}\n` : "") + text;
    } else {
        run.inputs.prompt = UPSAMPLE_EDIT_REQUEST(text);
    }
    return { on: true, note: null, show: u.show && prompt[u.show] ? String(u.show) : null };
}
