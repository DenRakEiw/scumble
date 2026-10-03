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
// element as <id>. The docs: the instruction and the rows should agree and the caption should say where each element
// goes, so a sentence is added for every box the prompt does not mention by its <id>, with its description and its
// place in words (S3e: "Place a red scarf <red_scarf_1> at the top left.").
//
// Ideogram 4 (S5, `options.boxes: "ideogram4"`): the boxes become its JSON caption, the whole prompt (captionIdeogram4).
"use strict";

const { resolveMarkers, validRefName, REF_NAME_DEFAULT } = require("./refs");

/** The schemas this file writes rows for, by the variant's `options.boxes`. */
const SCHEMAS = new Set(["flux3", "ideogram4"]);

/** The kinds a box may have. */
const KINDS = new Set(["new", "keep", "move", "remove", "from"]);

/**
 * The shape of a box id (the same as the renderer's BOX_ID): lowercase words joined by underscores, then a number; not
 * a picture's name (ref_image_1), which the caption and the rows use for the pictures.
 */
const BOX_ID = /^(?!ref_image_[0-9]+$)[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)*_[1-9][0-9]*$/;

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
 * `ref` an integer for from only, `desc` a string, `text` (the words a Text box renders; its desc then says how they
 * look) a string on a new box only. Throws naming the box ("Box edit_1: ..: nothing was sent.").
 */
function checkBoxes(boxes) {
    if (boxes == null) return [];
    if (!Array.isArray(boxes)) throw new Error("The request's boxes are not a list: nothing was sent.");
    const seen = new Set();
    boxes.forEach((b, i) => {
        const who = `Box ${b && typeof b.id === "string" ? b.id : "#" + (i + 1)}`;
        const bad = (why) => new Error(`${who}: ${why}: nothing was sent.`);
        if (!b || typeof b !== "object") throw bad("not an object");
        if (typeof b.id !== "string" || !BOX_ID.test(b.id)) throw bad("the id is not lowercase words and a number joined by underscores (knight_1, red_scarf_2)");
        if (seen.has(b.id)) throw bad("the id is used twice");
        seen.add(b.id);
        if (!KINDS.has(b.kind)) throw bad(`the kind "${String(b.kind).slice(0, 20)}" is not new, keep, move, remove or from`);
        if (!fracs(b.rect)) throw bad("rect is not [l, t, r, b] in fractions 0..1 with l < r and t < b");
        if (b.kind === "new") { if (b.src != null) throw bad("a new box has no src"); }
        else if (!fracs(b.src)) throw bad("src is not [l, t, r, b] in fractions 0..1 with l < r and t < b");
        if (b.kind === "from") { if (!Number.isInteger(b.ref) || b.ref < 0) throw bad("a from box needs ref, the reference's index"); }
        else if (b.ref != null) throw bad("only a from box has a ref");
        if (b.desc != null && typeof b.desc !== "string") throw bad("desc is not a string");
        if (b.text != null) {
            if (typeof b.text !== "string") throw bad("text is not a string");
            if (b.kind !== "new") throw bad("only a new box renders text");
        }
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

/** `s` with the {@ref:i} markers resolved to the route's names ("image 2"), folded to one line; `b` names the box. */
function resolved(req, lay, b, s) {
    const r = resolveMarkers(fold(s), lay.pictures, patternOf(req));
    if (r.left.length) throw new Error(`Box ${b.id} names reference picture ${r.left[0].ref + 1}, which this run does not send: nothing was sent.`);
    return r.text;
}

/** A box's desc as a FLUX 3 row carries it: a Text box says what it reads (`text reading "SALE", red letters`). */
function descOf(req, lay, b) {
    const own = fold(b.desc);
    return resolved(req, lay, b, b.text != null ? `text reading "${fold(b.text)}"${own ? ", " + own : ""}` : own);
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

// ---- the caption (S3e): the docs ask the caption to name each element as <id> and to say where it goes ---------------
// plugins/boxes/format.js keeps a copy of everything from here to captionFlux3 for the clipboard; tools/boxes_test.js
// holds the two to the same vectors.

/** Words that open an instruction: a description that starts with one goes into the caption as it is ("make the tiger pink"). */
const VERB = /^(?:add|bring|brighten|change|darken|draw|fill|give|insert|lighten|make|paint|place|put|recolou?r|render|replace|show|swap|turn|use|write)\b/i;

/** A description as a clause of the caption: one line, no closing stop, a capital that only opened the sentence lowered (an acronym keeps its case). */
function clauseOf(s) {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim().replace(/[\s.!;:,]+$/, "");
    return /^(?:[A-Z][a-z]|A(?=\s))/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

/** `s` without a leading verb of the kind's own ("move the lamp" -> "the lamp"), so the clause does not say it twice. */
const dropVerb = (s, re) => s.replace(re, "").trim();

/**
 * Where a box lies in the frame ([top, left, bottom, right] on the 0 to 1000 grid), in words: by thirds of the frame
 * ("at the top left", "at the bottom", "on the right", "in the middle"); a box over three quarters of the frame each way
 * is "over most of the picture".
 */
function whereWords(g) {
    if (!Array.isArray(g) || g.length !== 4) return "";
    if (g[2] - g[0] >= 750 && g[3] - g[1] >= 750) return "over most of the picture";
    const third = (mid, lo, hi) => (mid * 3 < 1000 ? lo : mid * 3 > 2000 ? hi : "");
    const v = third((g[0] + g[2]) / 2, "top", "bottom"), h = third((g[1] + g[3]) / 2, "left", "right");
    return v && h ? `at the ${v} ${h}` : v ? `at the ${v}` : h ? `on the ${h}` : "in the middle";
}

/**
 * Which way a Move box goes, from its source to its target (grids), in words: up or down and to the left or right when
 * its middle moves a tenth of the frame or more that way, else "to its new box"; ", larger" or ", smaller" when its
 * area grows or shrinks by half or more.
 */
function wayWords(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return "to its new box";
    const dy = (b[0] + b[2] - a[0] - a[2]) / 2, dx = (b[1] + b[3] - a[1] - a[3]) / 2;
    const v = dy <= -100 ? "up" : dy >= 100 ? "down" : "";
    const h = dx <= -100 ? "to the left" : dx >= 100 ? "to the right" : "";
    const way = v && h ? `${v} and ${h}` : v || h || "to its new box";
    const area = (g) => Math.max(1, (g[2] - g[0]) * (g[3] - g[1]));
    const k = area(b) / area(a);
    return k >= 1.5 ? `${way}, larger` : k <= 1 / 1.5 ? `${way}, smaller` : way;
}

/** The caption's clause for one box and its row: what happens to it, named as <id>, and where. */
function clauseFlux3(b, row) {
    const d = clauseOf(row.desc), id = `<${b.id}>`;
    switch (b.kind) {
        case "new": {
            const where = whereWords(row.tgt_bbox || row.bbox);
            return d ? `${VERB.test(d) ? d : "place " + d} ${id} ${where}` : `fill the area ${id} ${where} so it fits the picture`;
        }
        case "from": {
            const where = whereWords(row.tgt_bbox), pic = `<${row.from}>`;
            return d ? `${VERB.test(d) ? d : "place " + d} ${id} from ${pic} ${where}` : `place what ${pic} shows as ${id} ${where}`;
        }
        case "move": return `move ${dropVerb(d, /^move\b/i) || "the element"} ${id} ${wayWords(row.src_bbox, row.tgt_bbox)}`;
        case "remove": return `remove ${dropVerb(d, /^(?:remove|erase|delete)\b/i) || "the element"} ${id} ${whereWords(row.src_bbox)}`;
        case "keep": return `keep ${dropVerb(d, /^keep\b/i) || "the element"} ${id} as it is`;
        default: return "";
    }
}

/**
 * The clause of a box whose description is the prompt itself (the selection's box): the prompt, sent as it is, says
 * what happens, so the clause only says where ("the change goes in <id> at the top left"), or which picture goes there.
 */
function placeOnly(b, row) {
    const where = whereWords(row.tgt_bbox || row.bbox);
    return b.kind === "from" && row.from ? `<${row.from}> goes in <${b.id}> ${where}` : `the change goes in <${b.id}> ${where}`;
}

/**
 * The caption the rows go with: the prompt as it is, then one sentence per box it does not name by `<id>` with the
 * box's description and its place in words (the docs: the instruction and the rows should agree). `rows` are the rows
 * sent; a box without one (left out) gets no sentence. `frame` is the frame's picture name on an edit (`ref_image_0`),
 * null on a new image. A box whose description is the prompt (the selection's box; a prompt past DESC_MAX was cut in
 * its row) gets a sentence that says only where. On an edit "In <frame>, " opens the first sentence when the prompt
 * does not name the frame, and "Leave the rest of the picture as it is." closes the caption when the prompt says nothing
 * the boxes do not: empty, or one box's own description.
 */
function captionFlux3(prompt, boxes, rows, frame) {
    const text = String(prompt == null ? "" : prompt).replace(/\s+/g, " ").trim();
    const byId = new Map((rows || []).map((r) => [r.id, r]));
    const told = (boxes || []).filter((b) => b && byId.has(b.id) && !text.includes(`<${b.id}>`));
    const plain = (s) => clauseOf(s).toLowerCase();
    const whole = plain(text);
    const isPrompt = (d) => { const a = plain(d); return !!a && (a === whole || (a.length >= DESC_MAX - 10 && whole.length > a.length && whole.startsWith(a))); };
    const said = !!text && told.some((b) => isPrompt(byId.get(b.id).desc));
    const clauses = told.map((b) => (isPrompt(byId.get(b.id).desc) ? placeOnly(b, byId.get(b.id)) : clauseFlux3(b, byId.get(b.id)))).filter(Boolean);
    if (clauses.length && frame && !text.includes(`<${frame}>`)) clauses[0] = `In <${frame}>, ${clauses[0]}`;
    const sentences = clauses.map((s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}.`);
    if (frame && byId.size && (!text || said)) sentences.push("Leave the rest of the picture as it is.");
    const head = text && sentences.length && !/[.!?]$/.test(text) ? `${text}.` : text;
    return [head, ...sentences].filter(Boolean).join(" ");
}

/** The prompt with the caption's sentences for the boxes (captionFlux3), against the layout: the frame is its crop's name. */
function instructionFlux3(prompt, boxes, lay, rows) {
    return captionFlux3(prompt, boxes, rows, frameName(lay));
}

// ---- Ideogram 4 (S5): the boxes as its JSON caption ------------------------------------------------------------------
// docs/PLAN_BOXES.md §3 (Kijai's caption builder, read 2026-10-01): the whole prompt is one JSON object, its key order
// fixed: { high_level_description, compositional_deconstruction: { background, elements } }, an element { type: "obj",
// bbox, desc } or { type: "text", bbox, text, desc }, bbox [ymin, xmin, ymax, xmax] on the 0 to 1000 grid of the frame
// (FLUX 3's grid). It describes a picture, not a change: no source box, no other picture, so Move, Remove and From have
// no counterpart and stay out with a note; a Keep box is an element where it stands. No style_description: the builder
// writes one only when a style is chosen, and then every key of it. Live 2026-10-03 on fal, expansion None
// (docs/PLAN_BOXES.md §6.4): the model followed the caption, a sign's words in their box, and rendered none of the
// JSON. The background: empty on an edit (the crop is the background; a cat went into the grass), the prompt on a new
// image (an empty one painted a transparency checkerboard over the half the elements left free).

/** The kinds Ideogram 4's caption places: New and Text everywhere, Keep on an edit (a new image has nothing to keep). */
const placesIdeogram4 = (b, text) => b.kind === "new" || (b.kind === "keep" && !text);

/** One element of the caption for a box it places: a Text box with its words, else an object; desc without the words. */
function elementIdeogram4(req, lay, b) {
    const desc = resolved(req, lay, b, b.desc);
    if (b.kind === "keep") return { type: "obj", bbox: grid(b.src), desc };
    return b.text != null ? { type: "text", bbox: grid(b.rect), text: fold(b.text), desc } : { type: "obj", bbox: grid(b.rect), desc };
}

/**
 * Ideogram 4's caption of a request's boxes: { prompt, rows, notes, params }. The prompt (markers already names) is the
 * high_level_description (left out when empty, as the builder does) and, on a new image, the background too; the
 * boxes it places are the elements, in the order sent. The boxes it cannot place are named in one note. No element left: the prompt goes as written, rows
 * empty. While the caption goes, the Prompt expansion row (`expansion_model`) goes as None: an expansion rewrites the
 * prompt, the caption with it.
 */
function captionIdeogram4(req, lay) {
    const boxes = checkBoxes(req.boxes);
    const text = req.kind === "text";
    const placed = boxes.filter((b) => placesIdeogram4(b, text));
    const left = boxes.filter((b) => !placesIdeogram4(b, text));
    const notes = [];
    if (left.length) {
        const which = left.map((b) => `${b.id} (${b.kind === "from" ? "From reference" : b.kind.charAt(0).toUpperCase() + b.kind.slice(1)})`).join(", ");
        notes.push(`${left.length === 1 ? "Box" : "Boxes"} ${which} ${left.length === 1 ? "was" : "were"} not sent: Ideogram 4 places New and Text boxes${text ? " on a new image" : " and Keep boxes"} only.`);
    }
    const elements = placed.map((b) => elementIdeogram4(req, lay, b));
    if (!elements.length) return { prompt: req.prompt, rows: [], notes, params: null };
    const bare = placed.filter((b, i) => b.kind === "new" && b.text == null && !elements[i].desc).map((b) => b.id);
    if (bare.length) notes.push(`${bare.length === 1 ? "Box" : "Boxes"} ${bare.join(", ")} went without a description: the model guesses what goes there.`);
    const caption = {};
    const high = String(req.prompt == null ? "" : req.prompt).trim();
    if (high) caption.high_level_description = high;
    caption.compositional_deconstruction = { background: text ? high : "", elements };
    if (text && !high) notes.push("The prompt is empty: Ideogram 4 takes it as the new image's background, and without one it may paint a transparency checkerboard around the boxes.");
    let params = null;
    const exp = req.params && req.params.expansion_model;
    if (exp != null && exp !== "" && exp !== "None") {
        params = { expansion_model: "None" };
        notes.push(`Prompt expansion went as None (not ${exp}): an expansion would rewrite the boxes' caption.`);
    }
    return { prompt: JSON.stringify(caption), rows: elements, notes, params };
}

/**
 * The prompt a request goes out with when its variant takes boxes: for FLUX 3 the instruction, a space and the JSON
 * rows; for Ideogram 4 its JSON caption (captionIdeogram4). Returns { prompt, rows, notes, params } (`params`: values
 * that replace the request's own while the boxes go, or null). Called by index.js after resolveNames (the markers
 * already names in `req.prompt`) and only when `req.boxes` holds something; a route without a schema does not get here
 * (index.js drops the boxes with a note).
 */
function applyBoxes(req, lay) {
    const schema = schemaOf(req);
    if (schema === "ideogram4") return captionIdeogram4(req, lay);
    if (schema !== "flux3") throw new Error(`Boxes: no row format for "${String(schema)}": nothing was sent.`);
    const boxes = checkBoxes(req.boxes);
    const rows = rowsFlux3(req, lay);
    const prompt = instructionFlux3(req.prompt, boxes, lay, rows);
    // a New box without a description leaves the model to guess what goes there (the panel warns of it before)
    const bare = rows.filter((r, i) => boxes[i].kind === "new" && !r.desc).map((r) => r.id);
    const notes = bare.length ? [`${bare.length === 1 ? "Box" : "Boxes"} ${bare.join(", ")} went without a description: the model guesses what goes there.`] : [];
    return { prompt: `${prompt} ${JSON.stringify(rows)}`, rows, notes, params: null };
}

module.exports = { SCHEMAS, KINDS, BOX_ID, DESC_MAX, schemaOf, checkBoxes, grid, frameName, pictureName, rowsFlux3, instructionFlux3, captionFlux3, captionIdeogram4, whereWords, wayWords, applyBoxes, _descOf: descOf };
