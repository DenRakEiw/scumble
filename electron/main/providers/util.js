// Shared bits for the provider adapters.
"use strict";

function dataUri(buf, mime = "image/png") {
    return `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
}

function b64(buf) {
    return Buffer.from(buf).toString("base64");
}

/** Decode a data URI or fetch an http(s) URL into bytes. */
async function fetchImage(url, fetchFn, headers = {}) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(url));
    if (m) {
        const mime = m[1] || "application/octet-stream";
        const bytes = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "latin1");
        return { bytes, mime };
    }
    const r = await fetchFn(url, { headers });
    if (!r.ok) throw new Error(`image download answered ${r.status}`);
    return { bytes: Buffer.from(await r.arrayBuffer()), mime: r.headers.get("content-type") || "image/png" };
}

async function readError(r) {
    let text = "";
    try { text = await r.text(); } catch (_) { text = ""; }
    try {
        const j = JSON.parse(text);
        const msg = (j.error && (j.error.message || j.error)) || j.detail || j.message || j.status;
        if (msg) return typeof msg === "string" ? msg : JSON.stringify(msg);
    } catch (_) { /* not JSON */ }
    return text.slice(0, 300) || r.statusText || String(r.status);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pick from `sizes` (["WxH", ...]) the one whose aspect is closest to w:h. */
function closestSize(w, h, sizes) {
    const want = w / h;
    let best = sizes[0], bestD = Infinity;
    for (const s of sizes) {
        const [sw, sh] = s.split("x").map(Number);
        const d = Math.abs(Math.log(sw / sh) - Math.log(want));
        if (d < bestD) { best = s; bestD = d; }
    }
    return best;
}

/** The preset ("W:H") whose aspect is closest to w:h (WaveSpeed, Comfy Cloud and ToAPIs presets). */
function closestAspect(w, h, presets) {
    const want = Math.log(w / h);
    let best = presets[0], bestD = Infinity;
    for (const p of presets) {
        const [a, b] = String(p).split(":").map(Number);
        if (!a || !b) continue;
        const d = Math.abs(Math.log(a / b) - want);
        if (d < bestD) { best = p; bestD = d; }
    }
    return best;
}

/**
 * A free pixel size for a crop of w x h under a model's rules: both edges multiples of `step`,
 * at most `max` an edge, `minPixels` to `maxPixels` in all (0 = no bound) and a ratio no steeper
 * than `maxRatio` (0 = any). GPT Image 2 / 2.5 (OpenAI and ToAPIs) and Qwen Image 3.0 on ToAPIs.
 * Returns [width, height].
 */
function fitPixels(w, h, r) {
    let cw = Math.max(1, Math.round(w)), ch = Math.max(1, Math.round(h));
    if (r.maxRatio && Math.max(cw, ch) / Math.min(cw, ch) > r.maxRatio) {
        // a very long crop: keep the short edge and pull the long one back to the ratio
        if (cw > ch) cw = Math.round(ch * r.maxRatio); else ch = Math.round(cw * r.maxRatio);
    }
    const fit = (k) => { cw = Math.max(1, Math.round(cw * k)); ch = Math.max(1, Math.round(ch * k)); };
    if (Math.max(cw, ch) > r.max) fit(r.max / Math.max(cw, ch));
    if (r.maxPixels && cw * ch > r.maxPixels) fit(Math.sqrt(r.maxPixels / (cw * ch)));
    if (r.minPixels && cw * ch < r.minPixels) {
        // too few pixels for the model: grow, but never past an edge or the area ceiling
        const k = Math.min(Math.sqrt(r.minPixels / (cw * ch)), r.max / Math.max(cw, ch));
        fit(k);
    }
    const snap = (v) => Math.max(r.step, Math.min(r.max, Math.round(v / r.step) * r.step));
    cw = snap(cw); ch = snap(ch);
    // rounding can drop back under the minimum: take the next step up on both edges
    while (r.minPixels && cw * ch < r.minPixels && cw + r.step <= r.max && ch + r.step <= r.max) { cw += r.step; ch += r.step; }
    // stepping in whole multiples drifts the ratio, and 3:1 is a hard refusal: widen the
    // short edge rather than cutting the long one, which also keeps the pixel floor met
    if (r.maxRatio) {
        const need = (long) => Math.min(r.max, Math.max(r.step, Math.ceil(long / r.maxRatio / r.step) * r.step));
        if (cw > ch * r.maxRatio) ch = need(cw);
        else if (ch > cw * r.maxRatio) cw = need(ch);
    }
    if (r.maxPixels && cw * ch > r.maxPixels) {
        while (cw * ch > r.maxPixels && cw > r.step && ch > r.step) { cw -= r.step; ch -= r.step; }
    }
    return [cw, ch];
}

function num(v, fallback) {
    const n = +v;
    return Number.isFinite(n) ? n : fallback;
}

/** [width, height] from a PNG's IHDR, or null for anything else. */
function pngSize(b) {
    if (!b || b.length < 24) return null;
    if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
    const v = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    return [v(16), v(20)];
}

/**
 * The seed as a route with a cap takes it, or undefined (no seed, or the Random seed row on): the editor's seed runs up
 * to 0xffffffff, Ideogram's cap is 2147483647 (Magnific, Replicate's `options.seed_max`).
 */
function seedOf(req, max) {
    if (max == null || req.seed == null || req.seed === "" || (req.params || {}).random_seed) return undefined;
    return (Number(req.seed) >>> 0) % (max + 1);
}

/** The tier ({ name: long side }) for a long side: the smallest that holds it, else the largest (Comfy Router, Magnific, WaveSpeed). */
function tierFor(long, tiers) {
    const list = Object.entries(tiers || {}).filter(([, v]) => +v > 0).sort((a, b) => a[1] - b[1]);
    if (!list.length) return null;
    const hit = list.find(([, v]) => +v >= long);
    return (hit || list[list.length - 1])[0];
}

/**
 * Refuses a crop steeper than the variant's `options.max_ratio` (Ideogram 4.5's 1:6 .. 6:1) before the first upload; the
 * recipe's limits.ratio widens a crop to it wherever the picture allows, so this only meets a picture too narrow to widen.
 */
function checkRatio(image, o, who) {
    const size = +(o || {}).max_ratio > 0 ? pngSize(Buffer.from(image || [])) : null;
    if (size && Math.max(size[0], size[1]) > +o.max_ratio * Math.min(size[0], size[1])) throw new Error(`${who} takes pictures no steeper than ${+o.max_ratio}:1; the crop is ${size[0]} × ${size[1]}, and the picture is too narrow to widen it. Nothing was sent.`);
}

/**
 * A picture held to the variant's `options.max_bytes` (Ideogram 4.5: 25 MB each): an opaque one over it goes as JPEG,
 * one with transparency or still over it as JPEG is refused before anything is sent. Answers { bytes, mime }.
 */
function withinBytes(bytes, what, o, ctx, who) {
    const max = +(o || {}).max_bytes > 0 ? +o.max_bytes : 0;
    if (!max || bytes.length <= max) return { bytes, mime: "image/png" };
    const opaque = typeof ctx.opaque === "function" && ctx.opaque(bytes);
    const jpeg = opaque && typeof ctx.toJpeg === "function" ? ctx.toJpeg(bytes, 92) : null;
    if (!jpeg || !jpeg.length || jpeg.length > max) {
        throw new Error(`${who}: the ${what} is ${(bytes.length / 1e6).toFixed(1)} MB, more than the ${Math.round(max / 1e6)} MB a picture may have${opaque ? " even as JPEG" : " (it has transparency, so it stays PNG)"}. Set Highres fix lower or use a smaller reference layer. Nothing was sent.`);
    }
    return { bytes: Buffer.from(jpeg), mime: "image/jpeg" };
}

/** The shape a text run asks for: `aspect` when it reads as W:H, else the size. */
function textShape(req) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(String(req.aspect || ""));
    if (m && +m[1] > 0 && +m[2] > 0) return [+m[1], +m[2]];
    return [Math.max(1, +req.width || 1024), Math.max(1, +req.height || 1024)];
}

/**
 * Ideogram's mask from Scumble's: Scumble's is white where to repaint, Ideogram's black ("Black regions indicate where
 * to edit"), of the picture's own size. Channel 0 at 128 or more becomes black, the rest white; always PNG. Answers
 * { png, edits, pixels } (`edits` the black pixels); throws when the mask cannot be read or differs from the picture in
 * size. Magnific's Ideogram Inpaint sends `png` as it is; Ideogram 4.5 goes through ideogramMask below.
 */
function blackEditMask(mask, image, ctx, who) {
    if (!mask || !mask.length) throw new Error(`${who} needs the selection as a mask.`);
    if (typeof ctx.bitmap !== "function" || typeof ctx.fromBitmap !== "function") throw new Error(`${who}: this build cannot read the mask.`);
    const bm = ctx.bitmap(mask);
    if (!bm || !bm.width || !bm.height) throw new Error(`${who}: the mask could not be read.`);
    const size = pngSize(Buffer.from(image || []));
    if (size && (size[0] !== bm.width || size[1] !== bm.height)) throw new Error(`${who}: the mask is ${bm.width} × ${bm.height} and the picture ${size[0]} × ${size[1]}; Ideogram takes a mask of the picture's own size.`);
    const n = bm.width * bm.height;
    const out = Buffer.alloc(n * 4);
    let edits = 0;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
        const v = bm.data[j] >= 128 ? 0 : 255;
        if (!v) edits++;
        out[j] = v; out[j + 1] = v; out[j + 2] = v; out[j + 3] = 255;
    }
    return { png: Buffer.from(ctx.fromBitmap({ width: bm.width, height: bm.height, data: out })), edits, pixels: n };
}

/**
 * The mask an Ideogram 4.5 edit sends (Replicate and WaveSpeed under `options.mask: "black"`, Comfy Router's ideogram
 * dialect by the model id `ideogram-4-5`): Ideogram refuses
 * a mask without both colours, so a selection over the whole picture sends none (null: the whole picture is edited and
 * the stitch keeps the selection), and one with no pixel at half strength is refused before anything is sent.
 */
function ideogramMask(mask, image, ctx, who) {
    const m = blackEditMask(mask, image, ctx, who);
    if (!m.edits) throw new Error(`${who}: the selection holds no pixel at half strength or more, so the model would have nothing to edit. Select the area to change.`);
    return m.edits === m.pixels ? null : m.png;
}

module.exports = { dataUri, b64, fetchImage, readError, sleep, closestSize, closestAspect, fitPixels, num, pngSize, seedOf, tierFor, checkRatio, withinBytes, textShape, blackEditMask, ideogramMask };
