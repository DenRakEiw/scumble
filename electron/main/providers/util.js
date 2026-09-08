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

function num(v, fallback) {
    const n = +v;
    return Number.isFinite(n) ? n : fallback;
}

module.exports = { dataUri, b64, fetchImage, readError, sleep, closestSize, num };
