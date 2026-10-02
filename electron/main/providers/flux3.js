// FLUX 3 Image on Black Forest Labs' own API, the request shape only (bfl.js sends it and polls; this file is a helper
// like refs.js, not a provider of its own). Written from docs.bfl.ai/flux_3 and api.bfl.ai/openapi.json (FLUX 3 Image,
// released 2026-10-01; read the same day, docs/PLAN_FLUX3.md).
//
//   POST {FLUX3_BASE}/v1/flux-3-image  header x-key
//        { prompt (not blank), images: [base64, ..] (1 to 10; an edit sends the crop first),
//          aspect_ratio ("auto" | one of 15 presets), resolution ("1k" | "2k" | "4k"), safety_tolerance (0 to 4),
//          grounding (the model may search the web and images for the prompt first; the API's default is true) }
//     -> { id, polling_url, cost, input_mp, output_mp }, then GET polling_url until status "Ready" (Pending, Reasoning
//        and Generating come before it); result.sample is a signed URL, result.prompt the prompt as the model expanded it
//   The schema is strict: an unknown field answers 422. There is no seed, mask, width / height, mode, negative prompt or
//   output format. Each picture is 256 x 256 px to 16 MP and at most 20 MB of base64. The prompt names the pictures
//   "image 1", "image 2" .. in the order of `images`. Bounding-box rows go into the prompt itself: boxes.js writes
//   them (a JSON array after the text, `<ref_image_k>` naming the pictures) and index.js applies them before body().
//
// The body carries only prompt, the pictures, the shape and the fields the variant's `options.accepts` names.
"use strict";

const { b64, closestAspect } = require("./util");
const { layoutOf, refRoles } = require("./refs");

/** The host FLUX 3 is served from (the only one the docs name). The endpoint path is the recipe's `model`. */
const FLUX3_BASE = "https://api.bfl.ai";

/** The optional body fields sent when the variant names none (`options.accepts`); prompt, pictures and shape always go. */
const FLUX3_ACCEPTS = ["safety_tolerance", "grounding"];

/** Settings-panel parameters that may go into the body (and only when `accepts` names them as well). */
const FLUX3_PARAMS = new Set(["safety_tolerance", "grounding", "resolution"]);

/** Pictures per request (the crop included on an edit) where the variant sets no `options.max_images`. */
const FLUX3_MAX_IMAGES = 10;

/** The picture list's field where the variant sets no `options.images_field`. */
const FLUX3_IMAGES_FIELD = "images";

/** The aspect presets of `aspect_ratio` ("auto" besides them). */
const FLUX3_ASPECTS = ["21:9", "2:1", "16:9", "3:2", "7:5", "4:3", "5:4", "1:1", "4:5", "3:4", "5:7", "2:3", "9:16", "1:2", "9:21"];

/** The resolution tiers by pixel area (1k about 1 MP, 2k about 4 MP, 4k about 16 MP); 768sq and 1.5k are never sent. */
const FLUX3_TIERS = [["1k", 1024 * 1024], ["2k", 2048 * 2048], ["4k", 4096 * 4096]];
const TIER_SLACK = 1.15;   // a size up to 15 % over a tier's area still takes that tier

/** The input rules of one picture (the stricter reading of "16 MP" and "20 MB"). */
const FLUX3_PICTURE = { minSide: 256, maxPixels: 16000000, maxBase64: 20000000 };

/** |ln(crop aspect / preset aspect)| up to this sends the preset (the answer then stretches onto the crop exactly). */
const FIT_SLACK = 0.03;
/** A preset the crop was planned at (`req.cropAspect`) is sent while the emitted size is within this of it. */
const PLANNED_SLACK = 0.08;

const JPEG_QUALITY = 92;

/** Whether a BFL request is a FLUX 3 one: the variant says so (`options.schema: "flux3"`), or its endpoint does. */
function isFlux3(req, endpoint) {
    const o = (req && req.options) || {};
    if (o.schema === "flux3") return true;
    return /^flux-3(?![0-9])/.test(String(endpoint || ""));
}

function optionsOf(req) {
    const o = (req && req.options) || {};
    return {
        accepts: new Set(Array.isArray(o.accepts) ? o.accepts.map(String) : FLUX3_ACCEPTS),
        max: Number.isInteger(o.max_images) && o.max_images > 0 ? o.max_images : FLUX3_MAX_IMAGES,
        // the schema has one picture field; another name would be an unknown field (422), so a recipe cannot set it
        field: FLUX3_IMAGES_FIELD,
    };
}

/** safety_tolerance as the schema takes it: an integer 0 to 4; null for a value that is no number (the API's 2 then). */
function safetyOf(v) {
    const n = Math.round(+v);
    return Number.isFinite(n) && String(v).trim() !== "" ? Math.max(0, Math.min(4, n)) : null;
}

/** grounding as a JSON boolean; a Settings checkbox gives one, an agent may give "on" / "no" .. Throws on anything else. */
function groundingOf(v) {
    if (v === true || v === 1) return true;
    if (v === false || v === 0) return false;
    if (/^(true|1|yes|on)$/i.test(String(v).trim())) return true;
    if (/^(false|0|no|off)$/i.test(String(v).trim())) return false;
    throw new Error(`FLUX 3 Image: Grounding is on or off, not "${String(v).slice(0, 40)}". Nothing was sent.`);
}

/** How many pictures one request may carry, the crop included. */
function maxOf(req) {
    return optionsOf(req).max;
}

/** The resolution tier for an output of w x h: the smallest whose area holds it (15 % slack), else 4k. */
function tierOf(w, h) {
    const area = Math.max(1, +w || 1024) * Math.max(1, +h || 1024);
    const hit = FLUX3_TIERS.find(([, px]) => area <= px * TIER_SLACK);
    return (hit || FLUX3_TIERS[FLUX3_TIERS.length - 1])[0];
}

/** The shape a text run asks for: `aspect` when it reads as W:H, else the size. */
function textShape(req) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(String(req.aspect || ""));
    if (m && +m[1] > 0 && +m[2] > 0) return [+m[1], +m[2]];
    return [Math.max(1, +req.width || 1024), Math.max(1, +req.height || 1024)];
}

/** "stretch" when the preset is within FIT_SLACK of w:h, else null. */
function fitFor(ratio, w, h) {
    return withinOf(ratio, w, h, FIT_SLACK) ? "stretch" : null;
}

/** Whether the preset "a:b" is within `slack` (|ln| of the ratios) of w:h. */
function withinOf(ratio, w, h, slack) {
    const [a, b] = String(ratio).split(":").map(Number);
    if (!(a > 0 && b > 0 && w > 0 && h > 0)) return false;
    return Math.abs(Math.log(w / h) - Math.log(a / b)) <= slack;
}

/**
 * The size a request asks for: { aspect, resolution, fit }. An edit sends the preset the crop was widened to
 * (`req.cropAspect`, renderer/editor/stitch.js planFrame by the recipe's limits.aspects; the emitted size's rounding to
 * 16 px can put it a few % off), else the preset nearest the emitted crop when it is within 3 %, and "auto" otherwise,
 * which follows image 1, the crop; a text run always sends the nearest preset. The tier follows the size, or the
 * `resolution` row where the variant accepts one.
 */
function shapeOf(req) {
    const p = req.params || {};
    const o = optionsOf(req);
    let aspect, fit = null;
    if (req.kind === "text") {
        const [w, h] = textShape(req);
        aspect = closestAspect(w, h, FLUX3_ASPECTS);
    } else {
        const w = +req.width || 1, h = +req.height || 1;
        // IPC input is never trusted: a preset of the list, near the size
        const planned = FLUX3_ASPECTS.includes(String(req.cropAspect)) && withinOf(String(req.cropAspect), w, h, PLANNED_SLACK) ? String(req.cropAspect) : null;
        const near = planned || closestAspect(w, h, FLUX3_ASPECTS);
        fit = planned ? "stretch" : fitFor(near, w, h);
        aspect = fit ? near : "auto";
    }
    const row = o.accepts.has("resolution") && ["1k", "2k", "4k"].includes(p.resolution) ? p.resolution : null;
    return { aspect, resolution: row || tierOf(req.width, req.height), fit };
}

/**
 * The pictures of a request in the order sent, each { bytes, what }: an edit (and a fill, which sends no mask here) the
 * crop first, then the Original and the reference layers; a text run (Generate new) the reference layers alone.
 */
function picturesOf(req) {
    const refsGiven = req.references || [];
    const roles = refRoles(req);
    let refN = 0;
    const named = refsGiven.map((bytes, i) => ({ bytes, what: roles[i] && roles[i][0] === "original" ? "the Original" : `reference picture ${++refN}` }));
    const pics = req.kind === "text" ? named : [{ bytes: req.image, what: "the crop" }, ...named];
    // a missing picture would shift every later one's number against the layout, so it refuses rather than drops
    for (const p of pics) if (!p.bytes || !p.bytes.length) throw new Error(`FLUX 3 Image: ${p.what} is empty. Nothing was sent.`);
    return pics;
}

/** [width, height] from a PNG's IHDR, or null for anything else. */
function pngSize(b) {
    if (!b || b.length < 24) return null;
    if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
    const v = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    return [v(16), v(20)];
}

const base64Length = (n) => Math.ceil(n / 3) * 4;

/**
 * The size a reference picture is scaled to so it meets the input rules (at least 256 px a side, at most 16 MP), or null
 * when it already does; throws when no scale can (a strip both too thin and too long).
 */
function rescaleOf(w, h, what) {
    const { minSide, maxPixels } = FLUX3_PICTURE;
    let k = 1;
    if (w * h > maxPixels) k = Math.sqrt((maxPixels * 0.995) / (w * h));
    else if (Math.min(w, h) < minSide) k = minSide / Math.min(w, h);
    if (k === 1) return null;
    const out = { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
    if (Math.min(out.width, out.height) < minSide || out.width * out.height > maxPixels) {
        throw new Error(`FLUX 3 Image takes pictures of 256 × 256 px to 16 MP; ${what} is ${w} × ${h}, which no scale fits: use a less elongated layer. Nothing was sent.`);
    }
    return out;
}

/**
 * One picture as the base64 string sent, after the input rules: at least 256 px a side, at most 16 MP, at most 20 MB of
 * base64 (an opaque picture past that goes as JPEG). The crop is refused outside them (the selection decides its size);
 * a reference layer or the Original is scaled into them where the context can (ctx.resizePng). Throws, naming the
 * picture, before anything is sent.
 */
async function pictureOf(pic, ctx) {
    let bytes = Buffer.from(pic.bytes || []);
    const size = pngSize(bytes);
    if (size) {
        const [w, h] = size;
        const outside = Math.min(w, h) < FLUX3_PICTURE.minSide || w * h > FLUX3_PICTURE.maxPixels;
        if (outside && pic.what !== "the crop" && ctx && typeof ctx.resizePng === "function") {
            const to = rescaleOf(w, h, pic.what);
            const scaled = to ? await ctx.resizePng(bytes, to) : null;
            if (scaled && scaled.length) bytes = Buffer.from(scaled);
            else if (to) throw new Error(`FLUX 3 Image: ${pic.what} (${w} × ${h}) could not be scaled to ${to.width} × ${to.height}. Nothing was sent.`);
        } else if (Math.min(w, h) < FLUX3_PICTURE.minSide) {
            const fix = pic.what === "the crop" ? "select a larger area or more context around it" : "use a larger layer";
            throw new Error(`FLUX 3 Image takes pictures of at least ${FLUX3_PICTURE.minSide} px a side; ${pic.what} is ${w} × ${h}: ${fix}. Nothing was sent.`);
        } else if (w * h > FLUX3_PICTURE.maxPixels) {
            throw new Error(`FLUX 3 Image takes pictures of at most 16 MP; ${pic.what} is ${w} × ${h} (${(w * h / 1e6).toFixed(1)} MP): use a smaller layer. Nothing was sent.`);
        }
    }
    if (base64Length(bytes.length) <= FLUX3_PICTURE.maxBase64) return b64(bytes);
    const canJpeg = ctx && typeof ctx.opaque === "function" && typeof ctx.toJpeg === "function";
    const opaque = canJpeg && (await ctx.opaque(bytes));
    const jpeg = opaque ? await ctx.toJpeg(bytes, JPEG_QUALITY) : null;
    if (jpeg && base64Length(jpeg.length) <= FLUX3_PICTURE.maxBase64) return b64(jpeg);
    const why = !canJpeg ? "" : !opaque ? " and has transparent pixels, so it cannot go as JPEG" : " even as JPEG";
    throw new Error(`FLUX 3 Image takes at most 20 MB per picture; ${pic.what} is ${(base64Length(bytes.length) / 1e6).toFixed(1)} MB as sent${why}: use a smaller layer. Nothing was sent.`);
}

/** The body of a FLUX 3 request. Throws, before anything is sent, on a blank prompt, too many or unfit pictures. */
async function body(req, endpoint, ctx) {
    const p = req.params || {};
    const o = optionsOf(req);
    const prompt = typeof req.prompt === "string" ? req.prompt : "";
    if (!/\S/.test(prompt)) throw new Error("FLUX 3 Image needs a prompt: say what to make or change. Nothing was sent.");
    const pics = picturesOf(req);
    if (pics.length > o.max) {
        throw new Error(req.kind === "text"
            ? `BFL ${endpoint} takes at most ${o.max} reference picture${o.max === 1 ? "" : "s"} for a new image; this run has ${pics.length}: hide reference layers.`
            : `BFL ${endpoint} takes at most ${o.max} pictures; this run has ${pics.length}: hide reference layers or turn Original off.`);
    }
    const out = { prompt };
    if (pics.length) {
        const list = [];
        for (const pic of pics) list.push(await pictureOf(pic, ctx));
        out[o.field] = list;
    }
    const shape = shapeOf(req);
    out.aspect_ratio = shape.aspect;
    out.resolution = shape.resolution;
    for (const [k, v] of Object.entries(p)) {
        if (k === "resolution" || !FLUX3_PARAMS.has(k) || !o.accepts.has(k) || v === "" || v == null) continue;
        if (k === "grounding") out.grounding = groundingOf(v);
        else if (k === "safety_tolerance") { const s = safetyOf(v); if (s != null) out.safety_tolerance = s; }
    }
    return out;
}

/** What the stitch and the log learn about a request's size: { aspect, resolution, fit }. */
function infoOf(req) {
    return shapeOf(req);
}

/** Where body() puts each picture of an edit: the list field, the crop at [0]. */
function layout(req) {
    const o = optionsOf(req);
    return layoutOf({ seq: [["crop", `${o.field}[0]`], ...refRoles(req).map(([role, i]) => [role, `${o.field}[${i + 1}]`, i])], max: o.max });
}

/** The same for a text run: the reference layers from [0], the crop's slot being a reference's. */
function textLayout(req) {
    const o = optionsOf(req);
    return layoutOf({ seq: refRoles(req).map(([role, i]) => [role, `${o.field}[${i}]`, i]), max: o.max });
}

module.exports = {
    FLUX3_BASE, FLUX3_ACCEPTS, FLUX3_PARAMS, FLUX3_MAX_IMAGES, FLUX3_IMAGES_FIELD, FLUX3_ASPECTS, FLUX3_TIERS, FLUX3_PICTURE,
    isFlux3, maxOf, body, infoOf, layout, textLayout, _tierOf: tierOf, _shapeOf: shapeOf,
};
