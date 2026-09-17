// The mask maths of renderer/editor/stitch.js in plain Node, no Electron:
//   node tools/stitch_test.js
// `dilate` and `gaussBlur` against the loops they replaced (docs/PLAN_BCE.md 3b, B item 4): a max filter that walked the
// whole radius for every pixel, and a box blur that walked each column with a stride of w. The results must be the same
// floats, bit for bit: a run's masks decide which pixels of a result are kept.
"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

function dilateRef(m, px) {
    px = Math.floor(px);
    if (px <= 0) return m;
    const { w, h } = m;
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            let v = 0;
            for (let k = Math.max(0, x - px), e = Math.min(w - 1, x + px); k <= e; k++) { const s = m.data[row + k]; if (s > v) v = s; }
            tmp[row + x] = v;
        }
    }
    for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
            let v = 0;
            for (let k = Math.max(0, y - px), e = Math.min(h - 1, y + px); k <= e; k++) { const s = tmp[k * w + x]; if (s > v) v = s; }
            out[y * w + x] = v;
        }
    }
    return { data: out, w, h };
}

function boxRowRef(src, dst, w, h, r) {
    for (let y = 0; y < h; y++) {
        const row = y * w;
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += src[row + Math.min(w - 1, Math.max(0, k))];
        const n = 2 * r + 1;
        for (let x = 0; x < w; x++) {
            dst[row + x] = sum / n;
            const add = Math.min(w - 1, x + r + 1), sub = Math.max(0, x - r);
            sum += src[row + add] - src[row + sub];
        }
    }
}

function boxColRef(src, dst, w, h, r) {
    for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += src[Math.min(h - 1, Math.max(0, k)) * w + x];
        const n = 2 * r + 1;
        for (let y = 0; y < h; y++) {
            dst[y * w + x] = sum / n;
            const add = Math.min(h - 1, y + r + 1), sub = Math.max(0, y - r);
            sum += src[add * w + x] - src[sub * w + x];
        }
    }
}

function gaussBlurRef(m, sigma) {
    if (sigma <= 0) return m;
    const { w, h } = m;
    const wIdeal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
    let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
    const wu = wl + 2;
    const mIdeal = (12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4);
    const mm = Math.round(mIdeal);
    const radii = [0, 1, 2].map((i) => ((i < mm ? wl : wu) - 1) / 2);
    let a = Float32Array.from(m.data), b = new Float32Array(w * h);
    for (const r of radii) {
        if (r <= 0) continue;
        boxRowRef(a, b, w, h, r);
        boxColRef(b, a, w, h, r);
    }
    return { data: a, w, h };
}

// a selection as a run sees it: blobs with soft edges, and some plain noise so ties and plateaus both occur
function mask(w, h, seed) {
    let s = seed >>> 0;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    const data = new Float32Array(w * h);
    for (let b = 0; b < 4; b++) {
        const cx = rnd() * w, cy = rnd() * h, r = 2 + rnd() * Math.max(w, h) / 3;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const d = Math.hypot(x - cx, y - cy);
            const v = Math.min(1, Math.max(0, (r - d) / 3));
            if (v > data[y * w + x]) data[y * w + x] = Math.round(v * 255) / 255;
        }
    }
    for (let i = 0; i < w * h; i += 7) if (rnd() < 0.1) data[i] = Math.round(rnd() * 255) / 255;
    return { data, w, h };
}

function same(a, b) {
    if (a.w !== b.w || a.h !== b.h || a.data.length !== b.data.length) return "sizes differ";
    for (let i = 0; i < a.data.length; i++) if (!Object.is(a.data[i], b.data[i])) return `pixel ${i % a.w},${Math.floor(i / a.w)} is ${a.data[i]}, was ${b.data[i]}`;
    return null;
}

(async () => {
    const S = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "stitch.js")).href);
    let bad = 0;
    const check = (what, diff) => { if (diff) { bad++; console.log(`[FAIL] ${what}: ${diff}`); } else console.log(`[ok] ${what}`); };
    const sizes = [[1, 1], [7, 3], [3, 97], [64, 64], [131, 77], [300, 211]];
    for (const [w, h] of sizes) {
        const m = mask(w, h, w * 31 + h);
        for (const px of [0, 1, 2, 5, 40, 500]) check(`dilate ${w} x ${h} by ${px}`, same(S.dilate(m, px), dilateRef(m, px)));
        const inv = { data: m.data.map((v) => 1 - v), w, h };
        check(`dilate of the inverse ${w} x ${h} by 9 (erode)`, same(S.dilate(inv, 9), dilateRef(inv, 9)));
        for (const sigma of [0.4, 1, 3.3, 12, 60]) check(`gaussBlur ${w} x ${h} sigma ${sigma}`, same(S.gaussBlur(m, sigma), gaussBlurRef(m, sigma)));
    }
    // the size of a real crop's mask, and what it costs now
    const big = mask(1492, 1492, 5);
    const t0 = performance.now();
    const d = S.dilate(big, 47);
    const t1 = performance.now();
    const g = S.gaussBlur(d, 35);
    const t2 = performance.now();
    const dr = dilateRef(big, 47);
    const t3 = performance.now();
    const gr = gaussBlurRef(dr, 35);
    const t4 = performance.now();
    check("dilate 1492 x 1492 by 47", same(d, dr));
    check("gaussBlur 1492 x 1492 sigma 35", same(g, gr));
    console.log(`1492 x 1492: dilate ${(t1 - t0).toFixed(0)} ms (was ${(t3 - t2).toFixed(0)}), gaussBlur ${(t2 - t1).toFixed(0)} ms (was ${(t4 - t3).toFixed(0)})`);
    console.log(bad ? "FAIL" : "PASS");
    process.exit(bad ? 1 : 0);
})();
