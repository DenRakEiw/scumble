// Boxes in the prompt, the renderer's half (item 28, docs/PLAN_BOXES.md §4 and §8): geometry in image pixels turned
// into fractions of the frame a run sends (the crop of an edit, the new image of Generate new). Main's
// electron/main/providers/boxes.js writes the rows the model reads, since only main knows the final layout of the
// pictures (which slot is ref_image_k). Pure functions, no DOM, no editor: tools/boxes_test.js imports this file.
//
// A box as the request carries it (`request.boxes`):
//   { id: "edit_1",                     // /^[a-z][a-z0-9]*_[1-9][0-9]*$/, unique per request
//     kind: "new" | "keep" | "move" | "remove" | "from",
//     rect: [l, t, r, b],               // fractions 0..1 of the frame: the target
//     src: [l, t, r, b] | null,         // keep / move / remove: where it is in the frame; from: where it is in the reference
//     ref: null | i,                    // from: the reference's index as the {@ref:i} markers count it (0-based, the Original included)
//     desc: "..." }                     // at most DESC_MAX characters, newlines folded

/** The shape of a box id: a lowercase name, an underscore and a number (the docs' `<knight_1>`). */
export const BOX_ID = /^[a-z][a-z0-9]*_[1-9][0-9]*$/;

/** The longest description a box carries. */
export const DESC_MAX = 400;

/** The side under which a box at the emitted size is "small" (the docs: a 40 x 25 px element "often did not appear"). */
export const SMALL_PX = 48;

/** The frame of a run in image pixels, from planCrop's info (`bbox` = [x, y, w, h]). */
export function frameOf(info) {
    const b = info && info.bbox;
    return { x: b[0], y: b[1], w: b[2], h: b[3] };
}

/** A description as a row carries it: one line, trimmed, at most DESC_MAX characters. */
export function foldDesc(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, DESC_MAX);
}

/**
 * A rectangle in image pixels ([l, t, r, b], r and b exclusive) as fractions of the frame, clamped to 0..1. Null when
 * the clamped box is empty (the rectangle lies outside the frame) or thinner than 1/1000 on a side.
 */
export function toFrame(rectPx, frame) {
    if (!Array.isArray(rectPx) || rectPx.length !== 4 || !frame || !(frame.w > 0) || !(frame.h > 0)) return null;
    const [l, t, r, b] = rectPx.map(Number);
    if (![l, t, r, b].every(Number.isFinite)) return null;
    const c = (v) => Math.max(0, Math.min(1, v));
    const out = [c((l - frame.x) / frame.w), c((t - frame.y) / frame.h), c((r - frame.x) / frame.w), c((b - frame.y) / frame.h)];
    if (out[2] - out[0] < 0.001 || out[3] - out[1] < 0.001) return null;
    return out;
}

/**
 * The selection as one box (S1): `bounds` the selection's bounding box ([x0, y0, x1, y1] image pixels, inclusive, as
 * editor.selectionBounds() gives it; null without a selection), `frame` the crop. With a `pair` (the first @img token
 * the prompt carries, `pair.ref` its picture index) the box takes that reference's whole picture into the selection
 * (kind "from"); without one it is a New row described by the prompt. The desc keeps the prompt's {@ref:i} markers:
 * main resolves them in the rows as in the prompt. Null without a selection or when it lies outside the frame.
 */
export function selectionBox(bounds, frame, { prompt = "", pair = null } = {}) {
    if (!Array.isArray(bounds) || bounds.length !== 4) return null;
    const rect = toFrame([bounds[0], bounds[1], bounds[2] + 1, bounds[3] + 1], frame);
    if (!rect) return null;
    const desc = foldDesc(prompt);
    const from = pair && Number.isInteger(pair.ref) && pair.ref >= 0;
    return from
        ? { id: "edit_1", kind: "from", rect, src: [0, 0, 1, 1], ref: pair.ref, desc }
        : { id: "edit_1", kind: "new", rect, src: null, ref: null, desc };
}

/** The kinds a box may have (main's boxes.js keeps the same set). */
export const KINDS = new Set(["new", "keep", "move", "remove", "from"]);

const pxRect = (r) => Array.isArray(r) && r.length === 4 && r.every((v) => Number.isFinite(Number(v))) && Number(r[0]) < Number(r[2]) && Number(r[1]) < Number(r[3]);

/**
 * A plugin's boxes (`scumble.generate.register`, docs/PLUGINS.md "Generate"; S2 of docs/PLAN_BOXES.md) mapped into
 * the request's shape. A plugin box is the request's shape with `rect` and `src` in **image pixels** ([l, t, r, b],
 * r and b exclusive) and, on a from box, `layer` (the reference layer's id) instead of `ref`; its `src` is then where
 * the element sits in that layer as it is placed in the picture (image pixels too; null = the whole picture).
 * `ctx.frame` is the run's frame ({ x, y, w, h }), `ctx.references` the pictures of this run as the {@ref:i} markers
 * count them ([{ index, layerId, frame }]). `opts.taken` holds the ids already used (boxes or strings): a duplicate
 * gets the next free number (edit_1 -> edit_2). Returns { boxes, notes }: a box (or its source) outside the frame is
 * dropped with a note naming it. Throws on a malformed box (`err.code` "shape": the plugin's bug) and on a from box
 * whose layer this run does not send (`err.code` "layer", `opts.nameOf(layerId)` names it: the run refuses, as an
 * unresolvable @img token does).
 */
export function pluginBoxes(list, ctx, { taken = [], nameOf = null } = {}) {
    const fail = (code, msg) => { const e = new Error(msg); e.code = code; return e; };
    if (list == null) return { boxes: [], notes: [] };
    if (!Array.isArray(list)) throw fail("shape", "boxes() did not return a list");
    const frame = ctx && ctx.frame;
    const where = ctx && ctx.mode === "new" ? "image" : "crop";
    const used = new Set(taken.map((b) => (typeof b === "string" ? b : b && b.id)).filter(Boolean));
    const out = [], notes = [];
    list.forEach((b, i) => {
        const who = `Box ${b && typeof b.id === "string" ? b.id : "#" + (i + 1)}`;
        if (!b || typeof b !== "object") throw fail("shape", `${who}: not an object`);
        if (typeof b.id !== "string" || !BOX_ID.test(b.id)) throw fail("shape", `${who}: the id is not a lowercase name, an underscore and a number (knight_1)`);
        if (!KINDS.has(b.kind)) throw fail("shape", `${who}: the kind "${String(b.kind).slice(0, 20)}" is not new, keep, move, remove or from`);
        if (!pxRect(b.rect)) throw fail("shape", `${who}: rect is not [l, t, r, b] in image pixels with l < r and t < b`);
        if (b.desc != null && typeof b.desc !== "string") throw fail("shape", `${who}: desc is not a string`);
        let src = null, ref = null;
        if (b.kind === "from") {
            if (typeof b.layer !== "string" || !b.layer) throw fail("shape", `${who}: a from box needs layer, the reference layer's id`);
            if (b.src != null && !pxRect(b.src)) throw fail("shape", `${who}: src is not [l, t, r, b] in image pixels with l < r and t < b`);
            const r = (ctx && ctx.references || []).find((x) => x && x.layerId === b.layer);
            if (!r) throw fail("layer", `${who}: ${nameOf ? nameOf(b.layer) : "layer " + b.layer} is not a reference picture of this run: nothing was sent.`);
            ref = r.index;
            src = b.src == null ? [0, 0, 1, 1] : toFrame(b.src, r.frame);
            if (!src) { notes.push(`${who}: its source lies outside the reference layer, so the box was not sent.`); return; }
        } else if (b.kind !== "new") {
            if (!pxRect(b.src)) throw fail("shape", `${who}: src is not [l, t, r, b] in image pixels with l < r and t < b`);
            src = toFrame(b.src, frame);
            if (!src) { notes.push(`${who}: its source lies outside the ${where}, so the box was not sent.`); return; }
        } else if (b.src != null) throw fail("shape", `${who}: a new box has no src`);
        const rect = toFrame(b.rect, frame);
        if (!rect) { notes.push(`${who} lies outside the ${where} and was not sent.`); return; }
        let id = b.id;
        if (used.has(id)) {
            const m = /^(.*_)([1-9][0-9]*)$/.exec(id);
            let n = Number(m[2]) + 1;
            while (used.has(m[1] + n)) n++;
            id = m[1] + n;
        }
        used.add(id);
        out.push({ id, kind: b.kind, rect, src, ref, desc: foldDesc(b.desc) });
    });
    return { boxes: out, notes };
}

/** True when `rect` (fractions) is under SMALL_PX on a side at the emitted size ([w, h] pixels). */
export function smallBox(rect, emitted) {
    if (!Array.isArray(rect) || !Array.isArray(emitted)) return false;
    const w = (rect[2] - rect[0]) * emitted[0], h = (rect[3] - rect[1]) * emitted[1];
    return w < SMALL_PX || h < SMALL_PX;
}
