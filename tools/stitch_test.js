// The mask maths of renderer/editor/stitch.js in plain Node, no Electron:
//   node tools/stitch_test.js
// `dilate`, `gaussBlur` and the K32 mask kernels (`maskFromAlpha`, `maskMaxClamped`, `erode`, `1 - x`, `maskToCanvas`
// white and luminance, `alphaMask`, `selectionBbox`) against the loops they replaced (docs/PLAN_BCE.md 3b, B item 4;
// docs/PLAN_WASM_BUILD.md §4.10 K32). The results must be the same floats bit for bit (`Object.is`), the same RGBA
// bytes byte for byte, and the same bounds: a run's masks decide which pixels of a result are kept.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");

const ROOT = path.join(__dirname, "..");

// A stand-in OffscreenCanvas for Node so maskToCanvas and alphaMask can run through stitch.js directly
globalThis.OffscreenCanvas = class OffscreenCanvas {
    constructor(w, h) {
        this.width = w;
        this.height = h;
        this._data = new Uint8ClampedArray(w * h * 4);
    }
    getContext() {
        const self = this;
        return {
            imageSmoothingEnabled: true,
            imageSmoothingQuality: "high",
            createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
            putImageData(img) { self._data.set(img.data); },
            getImageData() { return { width: self.width, height: self.height, data: self._data.slice() }; },
            drawImage(src) { self._data.set(src._data); },
        };
    }
};

function maskFromAlphaRef(img) {
    const w = img.width, h = img.height, d = img.data;
    const m = { data: new Float32Array(w * h), w, h };
    for (let i = 0, j = 3; i < w * h; i++, j += 4) m.data[i] = d[j] / 255;
    return m;
}

function maskMaxRef(a, b) {
    const out = { data: new Float32Array(a.w * a.h), w: a.w, h: a.h };
    for (let i = 0; i < out.data.length; i++) out.data[i] = Math.max(a.data[i], b.data[i]);
    return out;
}

function maskClampRef(m) {
    const out = { data: new Float32Array(m.w * m.h), w: m.w, h: m.h };
    for (let i = 0; i < out.data.length; i++) out.data[i] = Math.min(1, Math.max(0, m.data[i]));
    return out;
}

function maskMaxClampedRef(a, b) {
    return maskClampRef(maskMaxRef(a, b));
}

function oneMinusRef(data) {
    const out = new Float32Array(data.length);
    for (let i = 0; i < out.length; i++) out[i] = 1 - data[i];
    return out;
}

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

function erodeRef(m, px) {
    px = Math.floor(px);
    if (px <= 0) return m;
    const inv = { data: new Float32Array(m.w * m.h), w: m.w, h: m.h };
    for (let i = 0; i < inv.data.length; i++) inv.data[i] = 1 - m.data[i];
    const d = dilateRef(inv, px);
    for (let i = 0; i < d.data.length; i++) d.data[i] = 1 - d.data[i];
    return d;
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

function denoiseMaskRef(sel, grow, feather) {
    let m = dilateRef(sel, grow);
    m = gaussBlurRef(m, feather / 2.5);
    return maskMaxClampedRef(m, sel);
}

function compositeMaskRef(sel, grow, feather, blend) {
    let m = denoiseMaskRef(sel, grow, feather);
    m = erodeRef(m, Math.floor(blend / 2));
    m = gaussBlurRef(m, blend / 2.5);
    return maskMaxClampedRef(m, sel);
}

function maskToCanvasRef(m, { luminance = false } = {}) {
    const d = new Uint8ClampedArray(m.w * m.h * 4);
    for (let i = 0, j = 0; i < m.data.length; i++, j += 4) {
        const v = Math.round(Math.min(1, Math.max(0, m.data[i])) * 255);
        if (luminance) { d[j] = v; d[j + 1] = v; d[j + 2] = v; d[j + 3] = 255; }
        else { d[j] = 255; d[j + 1] = 255; d[j + 2] = 255; d[j + 3] = v; }
    }
    return d;
}

function alphaMaskRef(m) {
    const d = new Uint8ClampedArray(m.w * m.h * 4);
    for (let i = 0, j = 0; i < m.data.length; i++, j += 4) { d[j] = 0; d[j + 1] = 0; d[j + 2] = 0; d[j + 3] = m.data[i] > 0.5 ? 0 : 255; }
    return d;
}

function selectionBboxRef(m, padding) {
    if (m.bounds) {
        const [bx0, by0, bx1, by1] = m.bounds;
        return { has: true, x0: Math.max(0, bx0 - padding), y0: Math.max(0, by0 - padding), x1: Math.min(m.fullW, bx1 + padding), y1: Math.min(m.fullH, by1 + padding) };
    }
    const { w, h, data } = m;
    const ox = m.ox | 0, oy = m.oy | 0, W = m.fullW || w, H = m.fullH || h;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            if (data[row + x] > 0.5) {
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
            }
        }
    }
    if (x1 < 0) return { has: false, x0: 0, y0: 0, x1: W, y1: H };
    return { has: true, x0: Math.max(0, ox + x0 - padding), y0: Math.max(0, oy + y0 - padding), x1: Math.min(W, ox + x1 + 1 + padding), y1: Math.min(H, oy + y1 + 1 + padding) };
}

function fillMaskedRef(cropBytes, w, h, fillMask, mode) {
    const d = new Uint8ClampedArray(cropBytes);
    if (!mode || mode === "none") return d;
    const hard = { data: new Float32Array(w * h), w, h };
    let count = 0;
    for (let i = 0; i < w * h; i++) { hard.data[i] = fillMask.data[i] > 0.5 ? 1 : 0; count += hard.data[i]; }
    if (!count) return d;
    if (mode === "green") {
        for (let i = 0, j = 0; i < w * h; i++, j += 4) if (hard.data[i]) { d[j] = 0; d[j + 1] = 255; d[j + 2] = 0; d[j + 3] = 255; }
        return d;
    }
    const soft = gaussBlurRef(hard, 4);
    for (let i = 0; i < soft.data.length; i++) soft.data[i] = Math.max(Math.min(1, soft.data[i]), hard.data[i]);
    if (mode === "neutral") {
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0, j = 0; i < w * h; i++, j += 4) if (!hard.data[i]) { r += d[j]; g += d[j + 1]; b += d[j + 2]; n++; }
        const col = n ? [r / n, g / n, b / n] : [128, 128, 128];
        for (let i = 0, j = 0; i < w * h; i++, j += 4) {
            const s = soft.data[i];
            d[j] = d[j] * (1 - s) + col[0] * s; d[j + 1] = d[j + 1] * (1 - s) + col[1] * s; d[j + 2] = d[j + 2] * (1 - s) + col[2] * s;
        }
        return d;
    }
    const sigma = Math.max(8, 0.05 * Math.max(w, h));
    const inv = { data: new Float32Array(w * h), w, h };
    for (let i = 0; i < w * h; i++) inv.data[i] = 1 - hard.data[i];
    const den = gaussBlurRef(inv, sigma);
    const chans = [0, 1, 2].map((c) => {
        const m = { data: new Float32Array(w * h), w, h };
        for (let i = 0, j = c; i < w * h; i++, j += 4) m.data[i] = d[j] * inv.data[i];
        return gaussBlurRef(m, sigma);
    });
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
        const s = soft.data[i];
        if (s <= 0) continue;
        const dn = den.data[i];
        for (let c = 0; c < 3; c++) {
            const sm = dn > 1e-4 ? chans[c].data[i] / Math.max(dn, 1e-4) : d[j + c];
            d[j + c] = d[j + c] * (1 - s) + sm * s;
        }
    }
    return d;
}

function cropMaskRef(m, x0, y0, w, h) {
    const o = { data: new Float32Array(w * h), w, h };
    const ox = m.ox | 0, oy = m.oy | 0;
    const sx0 = Math.max(x0, ox), sy0 = Math.max(y0, oy);
    const sx1 = Math.min(x0 + w, ox + m.w), sy1 = Math.min(y0 + h, oy + m.h);
    if (sx1 <= sx0 || sy1 <= sy0) return o;
    for (let y = sy0; y < sy1; y++) {
        const row = (y - oy) * m.w;
        o.data.set(m.data.subarray(row + sx0 - ox, row + sx1 - ox), (y - y0) * w + (sx0 - x0));
    }
    return o;
}

function colorMatchRef(patchBytes, regionBytes, w, h, weight) {
    const p = new Uint8ClampedArray(patchBytes);
    let total = 0;
    for (let i = 0; i < weight.data.length; i++) total += Math.min(1, Math.max(0, weight.data[i]));
    if (total < 64) return p;
    const rd = regionBytes;
    const stats = (d) => {
        const mean = [0, 0, 0], v = [0, 0, 0];
        for (let i = 0, j = 0; i < w * h; i++, j += 4) { const wt = weight.data[i]; if (wt <= 0) continue; mean[0] += d[j] * wt; mean[1] += d[j + 1] * wt; mean[2] += d[j + 2] * wt; }
        for (let c = 0; c < 3; c++) mean[c] /= total;
        for (let i = 0, j = 0; i < w * h; i++, j += 4) { const wt = weight.data[i]; if (wt <= 0) continue; for (let c = 0; c < 3; c++) { const dd = d[j + c] - mean[c]; v[c] += dd * dd * wt; } }
        return { mean, std: v.map((x) => Math.sqrt(Math.max(x / total, 1e-6 * 255 * 255))) };
    };
    const r = stats(rd), t = stats(p);
    const scale = [0, 1, 2].map((c) => Math.min(2, Math.max(0.5, r.std[c] / t.std[c])));
    for (let j = 0; j < p.length; j += 4) for (let c = 0; c < 3; c++) p[j + c] = Math.min(255, Math.max(0, (p[j + c] - t.mean[c]) * scale[c] + r.mean[c]));
    return p;
}

function finishPixelsRef(info, sel, resultBytes, regionBytes, EF = null) {
    const [x, y, w, h] = info.bbox;
    const width = info.width, height = info.height;
    const feather = info.feather | 0;
    let pd = new Uint8ClampedArray(resultBytes);
    const margin = Math.ceil(Math.max(feather, info.grow | 0, info.blend | 0) * 2 + 3 * Math.max(feather, info.blend | 0) / 2.5) + 8;
    const wx0 = Math.max(0, x - margin), wy0 = Math.max(0, y - margin);
    const wx1 = Math.min(width, x + w + margin), wy1 = Math.min(height, y + h + margin);
    const ww = wx1 - wx0, wh = wy1 - wy0;
    const selWin = cropMaskRef(sel, wx0, wy0, ww, wh);
    const full = info.auto_feather ? compositeMaskRef(selWin, info.grow | 0, feather, info.blend | 0) : (feather > 0 ? gaussBlurRef(selWin, feather) : selWin);
    const blend = cropMaskRef(full, x - wx0, y - wy0, w, h);
    if (info.align && regionBytes && !info.keepAlpha && EF) {
        const layRGBA = new Uint8ClampedArray(pd);
        for (let i = 0, j = 3; i < w * h; i++, j += 4) {
            layRGBA[j] = Math.round(Math.min(1, Math.max(0, blend.data[i])) * 255);
        }
        const r = EF.fitLayerRGBA({ baseRGBA: regionBytes, layerRGBA: layRGBA, w, h });
        if (r.aligned && r.matrix) {
            pd = EF.warpRGBA(pd, w, h, r.matrix);
            const cov = EF.warpCoverage(w, h, r.matrix);
            for (let i = 0; i < cov.length; i++) blend.data[i] *= cov[i];
        }
    }
    if (info.color_match && regionBytes && !info.keepAlpha) {
        const keep = { data: new Float32Array(w * h), w, h };
        for (let i = 0; i < keep.data.length; i++) keep.data[i] = 1 - blend.data[i];
        pd = colorMatchRef(pd, regionBytes, w, h, keep);
    }
    for (let i = 0, j = 3; i < w * h; i++, j += 4) {
        const a = Math.min(1, Math.max(0, blend.data[i]));
        pd[j] = Math.round(info.keepAlpha ? a * pd[j] : a * 255);
    }
    return pd;
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

function sameFloats(a, b) {
    if (a.length !== b.length) return `lengths differ (${a.length} vs ${b.length})`;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return `index ${i} is ${a[i]}, was ${b[i]}`;
    return null;
}

function sameBytes(a, b) {
    if (a.length !== b.length) return `lengths differ (${a.length} vs ${b.length})`;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `byte ${i} is ${a[i]}, was ${b[i]}`;
    return null;
}

function sameBbox(a, b) {
    return JSON.stringify(a) === JSON.stringify(b) ? null : `${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

(async () => {
    const K = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "px", "kernels.js")).href);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u, ...rest) => {
        const s = String(u && u.href ? u.href : u);
        return s.startsWith("file:") ? new Response(fs.readFileSync(fileURLToPath(s))) : realFetch(u, ...rest);
    };
    try { await K.kernelsReady(); } finally { globalThis.fetch = realFetch; }
    const S = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "stitch.js")).href);
    const EF = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "edgefit.js")).href);
    let bad = 0;
    const check = (what, diff) => { if (diff) { bad++; console.log(`[FAIL] ${what}: ${diff}`); } else console.log(`[ok] ${what}`); };
    const sizes = [[1, 1], [7, 3], [3, 97], [64, 64], [131, 77], [300, 211]];
    for (const mode of ["js", "rust"]) {
        K.setKernels(mode);
        check(`kernels.js mode ${mode} active`, K.kernelsInUse() === mode ? null : `got ${K.kernelsInUse()}`);
        for (const [w, h] of sizes) {
            const m = mask(w, h, w * 31 + h);
            const m2 = mask(w, h, w * 53 + h + 7);
            const rgba = new Uint8ClampedArray(w * h * 4);
            for (let i = 0; i < w * h; i++) {
                rgba[i * 4] = (i * 29) & 255;
                rgba[i * 4 + 1] = (i * 73) & 255;
                rgba[i * 4 + 2] = (i * 151) & 255;
                rgba[i * 4 + 3] = w * h >= 256 && i < 256 ? i : Math.round(m.data[i] * 255);
            }
            const img = { width: w, height: h, data: rgba };
            check(`[${mode}] maskFromAlpha ${w} x ${h}`, same(S.maskFromAlpha(img), maskFromAlphaRef(img)));
            check(`[${mode}] maskMaxClamped ${w} x ${h}`, same(S.maskMaxClamped({ data: m.data.slice(), w, h }, m2), maskMaxClampedRef(m, m2)));
            check(`[${mode}] maskMaxClamped aliased (a === b) ${w} x ${h}`, same(S.maskMaxClamped(m, m), maskMaxClampedRef(m, m)));
            check(`[${mode}] 1 - x (maskOneMinus) ${w} x ${h}`, sameFloats(K.maskOneMinus(m.data), oneMinusRef(m.data)));
            for (const px of [0, 1, 2, 5, 40, 500]) {
                check(`[${mode}] dilate ${w} x ${h} by ${px}`, same(S.dilate(m, px), dilateRef(m, px)));
                check(`[${mode}] erode ${w} x ${h} by ${px}`, same(S.erode(m, px), erodeRef(m, px)));
            }
            const inv = { data: m.data.map((v) => 1 - v), w, h };
            check(`[${mode}] dilate of the inverse ${w} x ${h} by 9 (erode)`, same(S.dilate(inv, 9), dilateRef(inv, 9)));
            for (const sigma of [0.4, 1, 3.3, 12, 60]) check(`[${mode}] gaussBlur ${w} x ${h} sigma ${sigma}`, same(S.gaussBlur(m, sigma), gaussBlurRef(m, sigma)));
            check(`[${mode}] denoiseMask ${w} x ${h}`, same(S.denoiseMask(m, 9, 16), denoiseMaskRef(m, 9, 16)));
            check(`[${mode}] compositeMask ${w} x ${h}`, same(S.compositeMask(m, 9, 16, 12), compositeMaskRef(m, 9, 16, 12)));
            check(`[${mode}] maskToCanvas white ${w} x ${h}`, sameBytes(S.maskToCanvas(m)._data, maskToCanvasRef(m)));
            check(`[${mode}] maskToCanvas luminance ${w} x ${h}`, sameBytes(S.maskToCanvas(m, { luminance: true })._data, maskToCanvasRef(m, { luminance: true })));
            check(`[${mode}] alphaMask ${w} x ${h}`, sameBytes(S.alphaMask(m)._data, alphaMaskRef(m)));
            for (const pad of [0, 8, 32]) {
                check(`[${mode}] selectionBbox ${w} x ${h} pad ${pad}`, sameBbox(S.selectionBbox(m, pad), selectionBboxRef(m, pad)));
                const win = { data: m.data, w, h, ox: 17, oy: 23, fullW: w + 40, fullH: h + 50 };
                check(`[${mode}] selectionBbox window ${w} x ${h} pad ${pad}`, sameBbox(S.selectionBbox(win, pad), selectionBboxRef(win, pad)));
            }
            const empty = { data: new Float32Array(w * h).fill(0.5), w, h };
            check(`[${mode}] selectionBbox empty (<= 0.5) ${w} x ${h}`, sameBbox(S.selectionBbox(empty, 8), selectionBboxRef(empty, 8)));
            for (const fillMode of ["neutral", "blur"]) {
                const c = new globalThis.OffscreenCanvas(w, h);
                c._data.set(rgba);
                check(`[${mode}] fillMasked ${fillMode} ${w} x ${h}`, sameBytes(S.fillMasked(c, m, fillMode)._data, fillMaskedRef(rgba, w, h, m, fillMode)));
            }
            if (w * h >= 256) {
                const resBytes = new Uint8ClampedArray(w * h * 4);
                const regBytes = new Uint8ClampedArray(w * h * 4);
                for (let i = 0; i < w * h; i++) {
                    resBytes[i * 4] = (i * 53 + 40) & 255;
                    resBytes[i * 4 + 1] = (i * 97 + 80) & 255;
                    resBytes[i * 4 + 2] = (i * 193 + 120) & 255;
                    resBytes[i * 4 + 3] = 255;
                    regBytes[i * 4] = ((i * 23 + 10) & 127) + 30;
                    regBytes[i * 4 + 1] = ((i * 61 + 50) & 127) + 40;
                    regBytes[i * 4 + 2] = ((i * 113 + 90) & 127) + 20;
                    regBytes[i * 4 + 3] = 255;
                }
                const resCv = new globalThis.OffscreenCanvas(w, h);
                resCv._data.set(resBytes);
                const regCv = new globalThis.OffscreenCanvas(w, h);
                regCv._data.set(regBytes);
                const info = {
                    bbox: [0, 0, w, h],
                    width: w,
                    height: h,
                    emitted: [w, h],
                    fit: "stretch",
                    paste: "selection",
                    auto_feather: true,
                    feather: 6,
                    grow: 3,
                    blend: 6,
                    align: false,
                    color_match: true,
                    keepAlpha: false,
                };
                const fin = S.finishPixels(info, m, resCv, regCv);
                check(`[${mode}] finishPixels colour-match ${w} x ${h}`, sameBytes(fin.patch._data, finishPixelsRef(info, m, resBytes, regBytes, EF)));
                // keepAlpha: true with partial alpha in resBytes
                const cutBytes = resBytes.slice();
                for (let i = 0; i < w * h; i++) cutBytes[i * 4 + 3] = (i * 41 + 17) & 255;
                const cutCv = new globalThis.OffscreenCanvas(w, h);
                cutCv._data.set(cutBytes);
                const cutInfo = { ...info, keepAlpha: true };
                const finCut = S.finishPixels(cutInfo, m, cutCv, regCv);
                check(`[${mode}] finishPixels keepAlpha ${w} x ${h}`, sameBytes(finCut.patch._data, finishPixelsRef(cutInfo, m, cutBytes, regBytes, EF)));
                // Direct colorMatch checks: select-all-shaped blend (total == 0 < 64), total == 63.5 < 64, total == 64, total > 64
                const wtSelectAll = { data: new Float32Array(w * h), w, h }; // blend = 1 everywhere -> keep = 1 - blend = 0, total = 0 < 64
                K.pxCalls(true);
                const cmSelAll = S.colorMatch(resCv, regCv, wtSelectAll);
                const cmSelAllCalls = K.pxCalls().color_match_rgba || 0;
                check(`[${mode}] colorMatch select-all skip (total < 64, no px call) ${w} x ${h}`,
                    cmSelAll !== resCv ? "returned new canvas when total < 64" : cmSelAllCalls !== 0 ? `expected 0 color_match_rgba calls, got ${cmSelAllCalls}` : sameBytes(cmSelAll._data, resBytes));
                const selAll = { data: new Float32Array(w * h).fill(1), w, h };
                K.pxCalls(true);
                const finSelAll = S.finishPixels(info, selAll, resCv, regCv);
                const finSelAllCmCalls = K.pxCalls().color_match_rgba || 0;
                check(`[${mode}] finishPixels select-all skip (total < 64, no color_match_rgba call) ${w} x ${h}`,
                    finSelAllCmCalls !== 0 ? `expected 0 color_match_rgba calls, got ${finSelAllCmCalls}` : sameBytes(finSelAll.patch._data, finishPixelsRef(info, selAll, resBytes, regBytes, EF)));
                const wt63 = { data: new Float32Array(w * h), w, h };
                wt63.data.fill(0.5, 0, 127); // sum = 63.5 < 64
                K.pxCalls(true);
                const cmLow = S.colorMatch(resCv, regCv, wt63);
                const cmLowCalls = K.pxCalls().color_match_rgba || 0;
                check(`[${mode}] colorMatch untouched below 64 ${w} x ${h}`,
                    cmLow !== resCv ? "returned new canvas when total < 64" : cmLowCalls !== 0 ? `expected 0 color_match_rgba calls, got ${cmLowCalls}` : sameBytes(cmLow._data, resBytes));
                const wt64 = { data: new Float32Array(w * h), w, h };
                wt64.data.fill(0.5, 0, 128); // sum = 64.0
                for (let i = 128; i < Math.min(w * h, 160); i++) wt64.data[i] = i % 2 ? -0.5 : 0; // <= 0 weights ignored
                const cm64 = S.colorMatch(resCv, regCv, wt64);
                check(`[${mode}] colorMatch at total == 64 ${w} x ${h}`, sameBytes(cm64._data, colorMatchRef(resBytes, regBytes, w, h, wt64)));
                const wtFull = { data: m2.data.map((v, i) => (i % 9 === 0 ? -0.25 : i % 11 === 0 ? 1.5 : v)), w, h };
                const cmFull = S.colorMatch(resCv, regCv, wtFull);
                check(`[${mode}] colorMatch with out-of-range weights ${w} x ${h}`, sameBytes(cmFull._data, colorMatchRef(resBytes, regBytes, w, h, wtFull)));
                if (w > 64 && h > 64) {
                    // Aligned finishPixels: base has a soft pattern, result is shifted by (+2, +1) with non-255 alpha
                    const baseB = new Uint8ClampedArray(w * h * 4);
                    const shiftB = new Uint8ClampedArray(w * h * 4);
                    const pat = (px, py) => {
                        const v0 = Math.round(128 + 80 * Math.sin(px * 0.15) * Math.cos(py * 0.15));
                        const v1 = Math.round(128 + 70 * Math.cos(px * 0.11 - py * 0.09));
                        const v2 = Math.round(128 + 60 * Math.sin((px + py) * 0.12));
                        return [v0, v1, v2];
                    };
                    for (let py = 0; py < h; py++) {
                        for (let px = 0; px < w; px++) {
                            const idx = (py * w + px) * 4;
                            const [r0, g0, b0] = pat(px, py);
                            baseB[idx] = r0; baseB[idx + 1] = g0; baseB[idx + 2] = b0; baseB[idx + 3] = 255;
                            const [r1, g1, b1] = pat(px - 1.5, py - 1.0);
                            shiftB[idx] = Math.min(255, r1 + 15);
                            shiftB[idx + 1] = Math.max(0, g1 - 10);
                            shiftB[idx + 2] = b1;
                            shiftB[idx + 3] = 180; // < 255 so alignCopy's keepAlpha=false vs true differs!
                        }
                    }
                    const bCv = new globalThis.OffscreenCanvas(w, h); bCv._data.set(baseB);
                    const sCv = new globalThis.OffscreenCanvas(w, h); sCv._data.set(shiftB);
                    const alignInfo = { ...info, align: true, color_match: true, keepAlpha: false };
                    const finAlign = S.finishPixels(alignInfo, m, sCv, bCv);
                    const wantAlign = finishPixelsRef(alignInfo, m, shiftB, baseB, EF);
                    check(`[${mode}] finishPixels align + colour-match ${w} x ${h} (aligned=${finAlign.align.aligned})`,
                        !finAlign.align.aligned ? `expected aligned=true, got ${finAlign.align.reason}` : sameBytes(finAlign.patch._data, wantAlign));
                }
            }
        }
    }
    // the size of a real crop's mask, and what it costs now
    K.setKernels("rust");
    const big = mask(1492, 1492, 5);
    const t0 = performance.now();
    const d = S.dilate(big, 47);
    const t1 = performance.now();
    const g = S.gaussBlur(d, 35);
    const t2 = performance.now();
    const e = S.erode(g, 12);
    const t3 = performance.now();
    const dr = dilateRef(big, 47);
    const t4 = performance.now();
    const gr = gaussBlurRef(dr, 35);
    const t5 = performance.now();
    const er = erodeRef(gr, 12);
    const t6 = performance.now();
    check("dilate 1492 x 1492 by 47", same(d, dr));
    check("gaussBlur 1492 x 1492 sigma 35", same(g, gr));
    check("erode 1492 x 1492 by 12", same(e, er));
    console.log(`1492 x 1492: dilate ${(t1 - t0).toFixed(0)} ms (was ${(t4 - t3).toFixed(0)}), gaussBlur ${(t2 - t1).toFixed(0)} ms (was ${(t5 - t4).toFixed(0)}), erode ${(t3 - t2).toFixed(0)} ms (was ${(t6 - t5).toFixed(0)})`);
    console.log(bad ? "FAIL" : "PASS");
    process.exit(bad ? 1 : 0);
})();
