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

module.exports = { dataUri, b64, fetchImage, readError, sleep, closestSize, closestAspect, fitPixels, num };
