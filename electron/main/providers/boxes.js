// Boxes in the prompt, the main process's half (item 28, docs/PLAN_BOXES.md §4 and §8): the geometry the renderer
// sends (`req.boxes`, fractions of the frame, renderer/editor/boxes.js) written as the rows the model reads, after
// index.js resolved the reference names and before the adapter builds its body. Only here is the final layout of the
// pictures known (which slot is ref_image_k), so only here can a row name a picture. Plain Node, no Electron:
// tools/boxes_test.js requires this file.
//
// FLUX 3 Image (docs.bfl.ai/flux_3, read 2026-10-01): the rows are a JSON array appended to the prompt after a space,
// every box `[top, left, bottom, right]` on a 0 to 1000 grid of the frame. An edit's row is { id, from, src_bbox,
// tgt_bbox, desc }: Keep (from the frame, the same box twice), Move (a new tgt_bbox), New (from and src_bbox null),
// Remove (tgt_bbox null), From (from "ref_image_k", src_bbox in that picture); a new image's row is { id, bbox, desc }.
// The pictures are <ref_image_0> (the first of `images`, the crop on an edit), <ref_image_1> ..; the text names each
// element as <id>. The docs: the instruction and the rows should agree, so a sentence is added for every box the
// prompt does not mention by its <id>.
"use strict";

const { resolveMarkers, validRefName, REF_NAME_DEFAULT } = require("./refs");

/** The schemas this file writes rows for, by the variant's `options.boxes`. */
const SCHEMAS = new Set(["flux3"]);

/** The kinds a box may have. */
const KINDS = new Set(["new", "keep", "move", "remove", "from"]);

/** The shape of a box id (the same as the renderer's BOX_ID). */
const BOX_ID = /^[a-z][a-z0-9]*_[1-9][0-9]*$/;

/** The longest description a row carries (the renderer folds to the same). */
const DESC_MAX = 400;

/** The schema the variant declares for boxes (`options.boxes`), or null when the route takes none. */
function schemaOf(req) {
    const s = req && req.options && req.options.boxes;
    return typeof s === "string" && SCHEMAS.has(s) ? s : null;
}

const fracs = (v) => Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1) && v[0] < v[2] && v[1] < v[3];

/**
 * The boxes of a request held to their shape: an array, each box an object with a well-formed and unique id, a known
 * kind, `rect` fractions in 0..1 with l < r and t < b, `src` the same for keep / move / remove / from and null for new,
 * `ref` an integer for from only, `desc` a string. Throws naming the box ("Box edit_1: ..: nothing was sent.").
 */
function checkBoxes(boxes) {
    if (boxes == null) return [];
    if (!Array.isArray(boxes)) throw new Error("The request's boxes are not a list: nothing was sent.");
    const seen = new Set();
    boxes.forEach((b, i) => {
        const who = `Box ${b && typeof b.id === "string" ? b.id : "#" + (i + 1)}`;
        const bad = (why) => new Error(`${who}: ${why}: nothing was sent.`);
        if (!b || typeof b !== "object") throw bad("not an object");
        if (typeof b.id !== "string" || !BOX_ID.test(b.id)) throw bad("the id is not a lowercase name, an underscore and a number (knight_1)");
        if (seen.has(b.id)) throw bad("the id is used twice");
        seen.add(b.id);
        if (!KINDS.has(b.kind)) throw bad(`the kind "${String(b.kind).slice(0, 20)}" is not new, keep, move, remove or from`);
        if (!fracs(b.rect)) throw bad("rect is not [l, t, r, b] in fractions 0..1 with l < r and t < b");
        if (b.kind === "new") { if (b.src != null) throw bad("a new box has no src"); }
        else if (!fracs(b.src)) throw bad("src is not [l, t, r, b] in fractions 0..1 with l < r and t < b");
        if (b.kind === "from") { if (!Number.isInteger(b.ref) || b.ref < 0) throw bad("a from box needs ref, the reference's index"); }
        else if (b.ref != null) throw bad("only a from box has a ref");
        if (b.desc != null && typeof b.desc !== "string") throw bad("desc is not a string");
    });
    return boxes;
}

/** A rectangle in fractions ([l, t, r, b]) on the 0 to 1000 grid as [top, left, bottom, right], at least 1 apart. */
function grid(rect) {
    const g = (v) => Math.max(0, Math.min(1000, Math.round(v * 1000)));
    let t = g(rect[1]), l = g(rect[0]), b = g(rect[3]), r = g(rect[2]);
    if (b <= t) { if (t >= 1000) t = 999; b = t + 1; }
    if (r <= l) { if (l >= 1000) l = 999; r = l + 1; }
    return [t, l, b, r];
}

/**
 * The name the model knows a picture of the layout by: `ref_image_k`, k the picture's place in the order sent, from
 * 0 (the layout's `n` is that place from 1; FLUX 3 sends them as `images[k]`). Null for a picture in a field of its
 * own (n null: a mask), which has no place in the order.
 */
function nameOfPicture(p) {
    return p && Number.isInteger(p.n) && p.n >= 1 ? `ref_image_${p.n - 1}` : null;
}

/** The frame's name on an edit (the crop's slot, `ref_image_0`), or null on a text run. */
function frameName(lay) {
    const crop = (lay.pictures || []).find((p) => p.role === "crop");
    return crop ? nameOfPicture(crop) : null;
}

/**
 * The name of the reference picture with index `ref` (as the markers count: the Original at 0 when it goes). Throws
 * when that picture is not sent (checkPictures stripped it, or the index is past the list) or has no slot.
 */
function pictureName(lay, ref, who) {
    const p = (lay.pictures || []).find((x) => x.ref === ref && (x.role === "original" || x.role === "reference"));
    const name = p ? nameOfPicture(p) : null;
    if (!name) throw new Error(`${who} takes reference picture ${ref + 1}, which this run does not send: nothing was sent.`);
    return name;
}

const fold = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, DESC_MAX);

/** The pattern a request names its pictures by. */
const patternOf = (req) => (req && validRefName(req.refName) ? req.refName : REF_NAME_DEFAULT);

/** A box's desc with the {@ref:i} markers resolved to the route's names ("image 2"), folded to one line. */
function descOf(req, lay, b) {
    const r = resolveMarkers(fold(b.desc), lay.pictures, patternOf(req));
    if (r.left.length) throw new Error(`Box ${b.id} names reference picture ${r.left[0].ref + 1}, which this run does not send: nothing was sent.`);
    return r.text;
}

/**
 * The FLUX 3 rows of a request's boxes against its layout: on an edit { id, from, src_bbox, tgt_bbox, desc } per kind,
 * on a text run { id, bbox, desc } (only new boxes: a new image has no source to keep or move).
 */
function rowsFlux3(req, lay) {
    const boxes = checkBoxes(req.boxes);
    const text = req.kind === "text";
    const frame = frameName(lay);
    return boxes.map((b) => {
        const desc = descOf(req, lay, b);
        if (text) {
            if (b.kind !== "new") throw new Error(`Box ${b.id} is a ${b.kind} box, and a new image has no source to keep or move: nothing was sent.`);
            return { id: b.id, bbox: grid(b.rect), desc };
        }
        if (!frame) throw new Error(`Box ${b.id}: this route sends no crop the box could be placed in: nothing was sent.`);
        switch (b.kind) {
            case "new": return { id: b.id, from: null, src_bbox: null, tgt_bbox: grid(b.rect), desc };
            case "keep": return { id: b.id, from: frame, src_bbox: grid(b.src), tgt_bbox: grid(b.src), desc };
            case "move": return { id: b.id, from: frame, src_bbox: grid(b.src), tgt_bbox: grid(b.rect), desc };
            case "remove": return { id: b.id, from: frame, src_bbox: grid(b.src), tgt_bbox: null, desc };
            case "from": return { id: b.id, from: pictureName(lay, b.ref, `Box ${b.id}`), src_bbox: grid(b.src), tgt_bbox: grid(b.rect), desc };
            default: throw new Error(`Box ${b.id}: unknown kind: nothing was sent.`);
        }
    });
}

/**
 * The prompt with one sentence per box it does not mention by `<id>` (the docs: the instruction and the rows should
 * agree). On an edit whose prompt does not name the frame, "In <ref_image_0>, " opens the first added sentence.
 */
function instructionFlux3(prompt, boxes, lay, rows) {
    const text = String(prompt == null ? "" : prompt).trim();
    const frame = frameName(lay);
    const byId = new Map((rows || []).map((r) => [r.id, r]));
    const sentences = [];
    for (const b of boxes) {
        if (text.includes(`<${b.id}>`)) continue;
        const row = byId.get(b.id);
        switch (b.kind) {
            case "new": sentences.push(`Add <${b.id}> in its box.`); break;
            case "from": sentences.push(`Place <${b.id}> from <${row && row.from ? row.from : "ref_image_1"}> in its box.`); break;
            case "move": sentences.push(`Move <${b.id}> to its new box.`); break;
            case "remove": sentences.push(`Remove <${b.id}>.`); break;
            case "keep": sentences.push(`Keep <${b.id}> unchanged.`); break;
            default: break;
        }
    }
    if (sentences.length && frame && !text.includes(`<${frame}>`)) {
        const s = sentences[0];
        sentences[0] = `In <${frame}>, ${s.charAt(0).toLowerCase()}${s.slice(1)}`;
    }
    return [text, ...sentences].filter(Boolean).join(" ");
}

/**
 * The prompt a request goes out with when its variant takes boxes: the instruction, a space and the JSON rows.
 * Returns { prompt, rows, notes }. Called by index.js after resolveNames (the markers already names in `req.prompt`)
 * and only when `req.boxes` holds something; a route without a schema does not get here (index.js drops the boxes
 * with a note).
 */
function applyBoxes(req, lay) {
    const schema = schemaOf(req);
    if (schema !== "flux3") throw new Error(`Boxes: no row format for "${String(schema)}": nothing was sent.`);
    const boxes = checkBoxes(req.boxes);
    const rows = rowsFlux3(req, lay);
    const prompt = instructionFlux3(req.prompt, boxes, lay, rows);
    return { prompt: `${prompt} ${JSON.stringify(rows)}`, rows, notes: [] };
}

module.exports = { SCHEMAS, KINDS, BOX_ID, DESC_MAX, schemaOf, checkBoxes, grid, frameName, pictureName, rowsFlux3, instructionFlux3, applyBoxes, _descOf: descOf };
