// What a split ("Split into layers", kind "layers") needs on the hosts beside BytePlus ModelArk: WaveSpeedAI's
// bytedance/seedream-v5.5/layer-decomposition (wavespeed.js) and Oxen.ai's bytedance-seedream-5-5-layers (oxen.js).
// ModelArk's own split is ark.js `layers`; the answer every adapter returns is its shape:
//   { bytes (the base's), mime, seed: undefined, layers: [{ bytes, mime, z_index, base, bounding_box, full, name,
//     description, size }] (the base first, then bottom to top), missing: the names of the layers whose download
//     failed, info }
// `full: true` marks a layer that came without a position: renderer/editor/splitlayers.js lays it over the whole source
// (the request's rule for a host whose docs name no box). A variant's `options.layers` (renderer/editor/splitlayers.js
// reads the same): { max (layers besides the base), options (count and Text recognition), count, text (each on its
// own, defaulting to `options`), tiers (false: the host takes no size), model (the host's split route), price }.
"use strict";

const ark = require("./ark");
const { pngSize } = require("./util");

/** The tiers a split's `size` may be (the command's and the dialog's). */
const TIERS = ["auto", "1K", "1.5K", "2K"];
/** The count a split asks for when nothing says otherwise (renderer/editor/splitlayers.js SPLIT_COUNT_DEFAULT). */
const COUNT_DEFAULT = 16;

/** A variant's layer mode, or null. */
function specOf(o) {
    const s = o && o.layers;
    if (!s || typeof s !== "object" || !(+s.max > 0)) return null;
    const options = !!s.options;
    return {
        max: Math.floor(+s.max), options,
        count: s.count != null ? !!s.count : options,
        text: s.text != null ? !!s.text : options,
        tiers: s.tiers !== false,
        model: typeof s.model === "string" ? s.model.trim() : "",
    };
}

/**
 * What a split asks for, every refusal before any upload or request: one picture, inside the model's documented input
 * (the same rule as ModelArk's, ark.js layerSizeRefusal; the hosts state none of their own), the tier, the count, the
 * switch. -> { tier, count, textRecognition, prompt }.
 */
function askOf(req, who, spec) {
    if (!req.image) throw new Error(`${who}: no picture to split.`);
    if ((req.references || []).length) throw new Error(`${who} splits exactly one picture; this run has ${req.references.length + 1}.`);
    const dims = pngSize(Buffer.from(req.image));
    if (dims) {
        const no = ark._layerSizeRefusal(dims[0], dims[1], who);
        if (no) throw new Error(no);
    }
    const p = req.params || {};
    const tier = p.size == null || p.size === "" ? "auto" : String(p.size);
    if (!TIERS.includes(tier)) throw new Error(`${who}: the size of a split is a tier (${TIERS.join(", ")}), not "${p.size}".`);
    if (!spec.tiers && tier !== "auto") throw new Error(`${who} takes no size for a split: it answers at its own size (Size Auto).`);
    let count = null;
    if (spec.count) {
        const n = p.count == null || p.count === "" ? Math.min(COUNT_DEFAULT, spec.max) : +p.count;
        if (!Number.isInteger(n) || n < 1 || n > spec.max) throw new Error(`${who}: the number of layers is a whole number from 1 to ${spec.max}, not "${p.count}".`);
        count = n;
    } else if (p.count != null && p.count !== "" && +p.count !== spec.max) {
        throw new Error(`${who} finds its own number of layers, up to ${spec.max}: it takes no count.`);
    }
    if (p.text_recognition && !spec.text) throw new Error(`${who} has no Text recognition switch for a split.`);
    return { tier, count, textRecognition: !!p.text_recognition && spec.text, prompt: String(req.prompt || "").trim() };
}

const finite4 = (b) => Array.isArray(b) && b.length === 4 && b.every((n) => Number.isFinite(+n));

/**
 * A layer's box as the renderer reads it ({ absolute: [l, t, r, b] } and / or { normalized } on 0..1000, ModelArk's
 * shape), from whichever form an answer gives: that shape, a bare [l, t, r, b], { x, y, width, height } or { left, top,
 * right, bottom } in the base's pixels. null without one.
 */
function boxOf(item) {
    const b = item && (item.bounding_box || item.bbox || item.box || item.position);
    if (!b) return null;
    if (finite4(b)) return { absolute: b.map(Number) };
    if (typeof b !== "object") return null;
    const out = {};
    if (finite4(b.absolute)) out.absolute = b.absolute.map(Number);
    if (finite4(b.normalized)) out.normalized = b.normalized.map(Number);
    if (!out.absolute && [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(+n) && n !== null && n !== "")) out.absolute = [+b.x, +b.y, +b.x + +b.width, +b.y + +b.height];
    if (!out.absolute && [b.left, b.top, b.right, b.bottom].every((n) => Number.isFinite(+n) && n !== null && n !== "")) out.absolute = [+b.left, +b.top, +b.right, +b.bottom];
    return out.absolute || out.normalized ? out : null;
}

const hasZ = (d) => d && typeof d === "object" && d.z_index !== null && d.z_index !== undefined && d.z_index !== "" && Number.isFinite(+d.z_index);

/**
 * The answer's entries in stacking order, the base first: `items` in the host's order (its docs: the base first, then
 * the layers), each a URL string or an object. Objects that carry z_index are sorted by it after the base; a base is the
 * first entry, or an object that says `base` / z_index 0 when there is one.
 */
function ordered(items) {
    const rows = items.map((d, i) => ({ d, i, z: hasZ(d) ? +d.z_index : i }));
    let at = rows.findIndex((x) => x.d && typeof x.d === "object" && (x.d.base === true || x.d.type === "base"));
    if (at < 0 && rows.every((x) => hasZ(x.d))) at = rows.findIndex((x) => x.z === 0);
    if (at < 0) at = 0;
    const base = rows[at];
    const rest = rows.filter((_, k) => k !== at).sort((a, b) => a.z - b.z || a.i - b.i);
    return [base, ...rest];
}

/**
 * The pictures of an answer, fetched one after another: `get(item)` -> { bytes, mime }. The base must come (it is the
 * frame every layer is in): its failure fails the run, in words that say the job is charged; a layer that does not
 * come is left out and named. -> { out (the adapter's `layers`), missing }.
 */
async function collect(items, get, ctx, who) {
    const rows = ordered(items);
    const out = [], missing = [];
    for (let k = 0; k < rows.length; k++) {
        const d = rows[k].d;
        const obj = d && typeof d === "object" ? d : {};
        const name = obj.name == null ? "" : String(obj.name);
        let got;
        try { got = await get(d); }
        catch (err) {
            if (ctx.signal && ctx.signal.aborted) throw err;
            const why = String((err && err.message) || err);
            if (k === 0) throw new Error(`${who}: the job finished and is charged, but its base picture could not be downloaded (${why}); nothing landed.`);
            if (typeof ctx.log === "function") ctx.log(`layer "${name || k}" left out, its download failed: ${why}`);
            missing.push(name || `Layer ${k}`);
            continue;
        }
        const box = k === 0 ? null : boxOf(obj);
        out.push({
            bytes: got.bytes, mime: got.mime, z_index: k === 0 ? 0 : rows[k].z, base: k === 0, bounding_box: box, full: k > 0 && !box,
            name, description: obj.description == null ? "" : String(obj.description), size: obj.size || null,
        });
    }
    return { out, missing };
}

module.exports = { TIERS, COUNT_DEFAULT, specOf, askOf, boxOf, ordered, collect };
