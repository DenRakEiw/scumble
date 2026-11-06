// @ts-check
/**
 * The key's matte brought from the working size (the bucket the engine keyed at) up to the matte's box at full
 * resolution, refined against the full-resolution picture (docs/PLAN_CORRIDORKEY.md §4.7 point 3, session I6).
 *
 * Pure and app-only: no DOM, no editor, imported by no shipped file. It runs under plain Node (tools/keymatte_test.js),
 * in the app-only key worker (renderer/editor/keyworker.js) and in the window. It imports `boxBlurs` from
 * px/kernels.js (Rust once loaded in a window or worker, the JS twin in Node) and `guidedFilter` from inpaint_depth.js;
 * neither is changed. docs/ck2/refine_notes.md has the measurement that chose the method and the guide, and the call
 * the integration makes.
 *
 * The geometry, in three frames:
 *   - the bucket: `alpha` (aw x ah) and `small`, the RGBA picture the engine keyed (the same grid, the reflect-101
 *     padding included); `src` is the region of the bucket that covers the key box (default: all of it);
 *   - the key box at full resolution, `full` (W x H): the box the engine keyed, in picture pixels;
 *   - the matte's box `out` inside the key box (x, y, w, h): the layer, trimmed to the matte (§4.5 step 1). Rows and
 *     the `read` callback's boxes are in `out`'s own coordinates (0..w, 0..h); the caller adds the layer's position.
 *   A pixel X of the key box samples the bucket at u = src.x + (X + 0.5) * src.w / W - 0.5 (the half-pixel centres of
 *   inpaint_depth.js `bilinearResize`, which this equals for the default `src`), clamped to the bucket.
 *
 * Methods (`method`):
 *   - "fast" (the default, chosen by the measurement): the guided filter's linear model fitted at the bucket, where
 *     the matte and the picture it was keyed from agree, then applied at full resolution (He and Sun's fast guided
 *     filter): q = A . I + B + (1 - C) p, with A, B, C the window-averaged coefficients upsampled bilinearly, I the
 *     guide of the full-resolution pixel, p the bilinear matte. Each window's fit is weighted by its confidence
 *     c = var / (var + flat), so a window with no edge in the guide passes the matte through as it is (a flat picture
 *     leaves the matte alone). The engine's matte is softer than the picture it was keyed from, and a regression of
 *     a softer matte on a sharper guide comes out too shallow (a halo of a few tens of levels either side of the
 *     edge); the model is linear, so the fit runs against the bucket guide blurred by the engine's own softness
 *     (`soft`: [1 2 1] passes; "auto" picks the count whose fit predicts the matte best over its transition) and the
 *     coefficients then apply to the sharp full-resolution guide.
 *     Two guards keep the full-resolution apply from adding what the bucket cannot know (docs/ck2/refine_notes.md):
 *       - the zone: the correction q - p acts only where the engine's matte is in transition, dilated by `gate` bucket
 *         pixels (a smooth weight from the bucket alpha, upsampled); where the engine is sure (p near 0 or 1 over the
 *         whole neighbourhood) the answer is the bilinear matte exactly, whatever the full-resolution pixels hold;
 *       - the noise: the fit's gain is fitted at the bucket, where averaging removed the sensor noise, and applied to
 *         the full-resolution pixels with it. The noise of the guide at full resolution is estimated once per matte from
 *         a strip of the picture (`sampleRows`, `noteSample`: the median within-bucket-pixel variance), the noise the
 *         apply would add per pixel is |A sigma|, and where that exceeds `tau` the correction is box-smoothed over up to
 *         rhoMax = min(REFINE.rhoMax, floor(factor / 2)) full-resolution pixels (an exact integer box, so banded equals
 *         unbanded), then shrunk by 1 / x^2 when even that is not enough. A band reads a halo of rhoMax rows for it.
 *     **The picture read at full resolution must be the picture the bucket was read from** (the same source, the same
 *     filter flags, the same background under transparent pixels; only the scale differs): the coefficients are a map
 *     from the bucket's colours to the matte. The strip checks it: the median difference between the full-resolution
 *     pixels averaged over each bucket pixel and the bucket pixel; above `guideTol` levels the matte falls back to the
 *     bilinear upsample and the answer says so (`fallback`).
 *   - "full": the plan's first design, kept as the measured baseline: the matte upsampled, then the guided filter of
 *     inpaint_depth.js at full resolution with r from the upscale factor, a band read with a halo of 2r rows above and
 *     below (the filter's whole reach: means of means), the halo trimmed; grey guides only.
 *   - "bilinear": the upsample alone (the unrefined path, PLAN §4.5 step 2 "until I6 lands").
 * Guides (`guide`): "rgb" (three channels, the colour guided filter; the default), "chroma" (the distance to the
 * screen colour in the CbCr plane), "dist" (the RGB distance to the screen colour), "luma" (relative luminance; the
 * measurement's foil: it finds no edge between green and a skin tone of equal luminance). On the sRGB bytes by default;
 * `linear` decodes them first. A camera mixes subject and screen in linear light, but the bucket picture is a byte
 * average of the full-resolution one (the tile levels), so only in sRGB is the bucket guide the area average of the
 * full-resolution guide that the fit's transfer from one scale to the other assumes; sRGB measured better on the mean
 * of every condition, edges mixed in linear light and sensor noise included (docs/ck2/refine_notes.md).
 */

import { boxBlurs } from "./px/kernels.js";
import { guidedFilter } from "./inpaint_depth.js";

/** The defaults the measurement chose (docs/ck2/refine_notes.md). */
export const REFINE = Object.freeze({
    method: "fast",
    guide: "rgb",
    linear: false,    // the guide on the sRGB bytes: the bucket picture is a byte average (the tile levels)
    r: 4,             // "fast": the fit's radius in bucket pixels
    eps: 3e-6,        // the fit's regularisation, on guides normalised to [0, 1] (1e-6 measured best, a margin kept)
    flat: 2e-5,       // a window whose guide variance is well below this has no edge: its fit passes the matte through
    soft: "auto",     // "fast": the engine's softness at the bucket, in [1 2 1] passes over the guide, or "auto"
    softs: [0, 1, 2, 3, 4],   // the pass counts "auto" chooses among (by the fit's residual over the transition)
    gate: 1,          // "fast": the correction acts within this many bucket pixels of the matte's transition (false: everywhere)
    tau: 0.04,        // "fast": the most noise (alpha 0..1, one sigma) the apply may add per pixel before it smooths and shrinks
    rhoMax: 8,        // "fast": the largest smoothing radius, full-resolution pixels (and at most half the upscale factor)
    guideTol: 3,      // "fast": levels; a full-resolution read further than this from the bucket's picture falls back
    fullK: 1.5,       // "full": r = round(fullK * upscale factor) full-resolution pixels
    bandPx: 4 << 20,  // a band's rows hold about this many pixels (plus the halo)
    unbandedPx: 16 << 20,   // a box up to this size runs as one band (PLAN §4.7 point 3: about 16 MP)
});

export const METHODS = ["fast", "full", "bilinear"];
export const GUIDES = ["rgb", "chroma", "dist", "luma"];

// ---- colour --------------------------------------------------------------------------------------------------------

const LIN = new Float32Array(256);
const SRGB = new Float32Array(256);
for (let i = 0; i < 256; i++) {
    const v = i / 255;
    SRGB[i] = v;
    LIN[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

// full-range BT.601 chroma rows; applied to linear values when `linear` (a linear map, so a blend of two colours stays
// the same blend of their chroma, which is what makes the distance linear in alpha)
const CB = [-0.168736, -0.331264, 0.5];
const CR = [0.5, -0.418688, -0.081312];
const LUMA = [0.2126, 0.7152, 0.0722];

/** sRGB bytes [r, g, b] to linear or plain [0, 1] values. */
function decode(rgb, linear) {
    const T = linear ? LIN : SRGB;
    return [T[rgb[0] | 0], T[rgb[1] | 0], T[rgb[2] | 0]];
}

/**
 * The guide's setup: how many planes, the per-byte tables, the normalisation to [0, 1].
 * @param {string} guide
 * @param {number[] | null} screen the screen colour as sRGB bytes (needed by "chroma" and "dist")
 * @param {boolean} linear
 */
export function guideSetup(guide, screen, linear = REFINE.linear) {
    if (!GUIDES.includes(guide)) throw new Error(`keymatte: unknown guide "${guide}"`);
    const T = linear ? LIN : SRGB;
    // noiseGain: a guide plane's noise (one sigma, guide units) per level of noise on each byte, about (the slope at
    // mid grey in sRGB), for a `noise` the caller gives instead of the sample's estimate
    if (guide === "rgb") return { guide, planes: 3, T, noiseGain: 1 / 255 };
    if (guide === "luma") {
        const t = [0, 1, 2].map((c) => Float32Array.from(T, (v) => v * LUMA[c]));
        return { guide, planes: 1, T, t, noiseGain: Math.hypot(...LUMA) / 255 };
    }
    if (!screen || screen.length < 3) throw new Error(`keymatte: the "${guide}" guide needs the screen colour`);
    const s = decode(screen, linear);
    const corners = [];
    for (let i = 0; i < 8; i++) corners.push([i & 1, (i >> 1) & 1, (i >> 2) & 1]);
    if (guide === "chroma") {
        const s0 = CB[0] * s[0] + CB[1] * s[1] + CB[2] * s[2], s1 = CR[0] * s[0] + CR[1] * s[1] + CR[2] * s[2];
        let max = 0;
        for (const k of corners) max = Math.max(max, Math.hypot(CB[0] * k[0] + CB[1] * k[1] + CB[2] * k[2] - s0, CR[0] * k[0] + CR[1] * k[1] + CR[2] * k[2] - s1));
        const tb = [0, 1, 2].map((c) => Float32Array.from(T, (v) => v * CB[c]));
        const tr = [0, 1, 2].map((c) => Float32Array.from(T, (v) => v * CR[c]));
        const norm = max > 0 ? 1 / max : 0;
        return { guide, planes: 1, T, tb, tr, s0, s1, norm, noiseGain: norm * Math.sqrt((Math.hypot(...CB) ** 2 + Math.hypot(...CR) ** 2) / 2) / 255 };
    }
    let max = 0;
    for (const k of corners) max = Math.max(max, Math.hypot(k[0] - s[0], k[1] - s[1], k[2] - s[2]));
    const norm = max > 0 ? 1 / max : 0;
    return { guide, planes: 1, T, s, norm, noiseGain: norm / 255 };
}

/**
 * The guide planes of `n` RGBA pixels from `off` (bytes, straight; A is ignored), written at `at` into `planes`.
 * @param {*} g guideSetup's answer
 * @param {ArrayLike<number>} rgba
 * @param {number} off first pixel
 * @param {number} n pixels
 * @param {Float32Array[]} planes 1 or 3 planes
 * @param {number} at first index written
 */
export function guidePlanes(g, rgba, off, n, planes, at = 0) {
    const p0 = planes[0];
    if (g.guide === "rgb") {
        const T = g.T, p1 = planes[1], p2 = planes[2];
        for (let i = 0, o = off * 4; i < n; i++, o += 4) { p0[at + i] = T[rgba[o]]; p1[at + i] = T[rgba[o + 1]]; p2[at + i] = T[rgba[o + 2]]; }
    } else if (g.guide === "luma") {
        const [t0, t1, t2] = g.t;
        for (let i = 0, o = off * 4; i < n; i++, o += 4) p0[at + i] = t0[rgba[o]] + t1[rgba[o + 1]] + t2[rgba[o + 2]];
    } else if (g.guide === "chroma") {
        const [b0, b1, b2] = g.tb, [r0, r1, r2] = g.tr, s0 = g.s0, s1 = g.s1, k = g.norm;
        for (let i = 0, o = off * 4; i < n; i++, o += 4) {
            const R = rgba[o], G = rgba[o + 1], B = rgba[o + 2];
            const db = b0[R] + b1[G] + b2[B] - s0, dr = r0[R] + r1[G] + r2[B] - s1;
            p0[at + i] = Math.sqrt(db * db + dr * dr) * k;
        }
    } else {
        const T = g.T, [s0, s1, s2] = g.s, k = g.norm;
        for (let i = 0, o = off * 4; i < n; i++, o += 4) {
            const d0 = T[rgba[o]] - s0, d1 = T[rgba[o + 1]] - s1, d2 = T[rgba[o + 2]] - s2;
            p0[at + i] = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2) * k;
        }
    }
}

/**
 * The screen colour from the bucket: the mean of the pixels the matte calls screen (alpha below 0.02), averaged in
 * linear light, as sRGB bytes; null when fewer than 0.5 % of the pixels are screen (the caller then passes the colour
 * of the screen kind it detected, keying.js `screenFromRing`). Only the "chroma" and "dist" guides need it.
 * @param {{ data: ArrayLike<number>, width: number, height: number }} small
 * @param {ArrayLike<number>} alpha at the bucket, 0..1 floats (toFloatAlpha)
 */
export function screenColor(small, alpha) {
    const n = small.width * small.height, d = small.data;
    let s0 = 0, s1 = 0, s2 = 0, k = 0;
    for (let i = 0; i < n; i++) {
        if (alpha[i] >= 0.02) continue;
        s0 += LIN[d[i * 4]]; s1 += LIN[d[i * 4 + 1]]; s2 += LIN[d[i * 4 + 2]]; k++;
    }
    if (k < n * 0.005 || k === 0) return null;
    const enc = (v) => {
        const x = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
        return Math.max(0, Math.min(255, Math.round(x * 255)));
    };
    return [enc(s0 / k), enc(s1 / k), enc(s2 / k)];
}

// ---- the matte at the bucket ----------------------------------------------------------------------------------------

/**
 * The engine's alpha as floats 0..1: a Float32Array is clamped (a copy), a Uint16Array is read as 0..65535, a
 * Uint8Array or Uint8ClampedArray as 0..255.
 * @param {Float32Array | Uint16Array | Uint8Array | Uint8ClampedArray | number[]} alpha
 */
export function toFloatAlpha(alpha) {
    const n = alpha.length, out = new Float32Array(n);
    const k = alpha instanceof Uint16Array ? 1 / 65535 : (alpha instanceof Uint8Array || alpha instanceof Uint8ClampedArray) ? 1 / 255 : 1;
    for (let i = 0; i < n; i++) {
        let v = alpha[i] * k;
        if (!(v > 0)) v = 0; else if (v > 1) v = 1;
        out[i] = v;
    }
    return out;
}

/**
 * The geometry checked and filled in, with the column tables of the bilinear upsample.
 * @param {{ aw: number, ah: number, src?: { x: number, y: number, w: number, h: number }, full?: { w: number, h: number },
 *   out?: { x: number, y: number, w: number, h: number } }} o
 */
export function geometry(o) {
    const aw = o.aw | 0, ah = o.ah | 0;
    if (!(aw > 0 && ah > 0)) throw new Error("keymatte: an empty bucket");
    const src = o.src || { x: 0, y: 0, w: aw, h: ah };
    if (!(src.w > 0 && src.h > 0)) throw new Error("keymatte: an empty source region");
    const full = o.full || { w: Math.round(src.w), h: Math.round(src.h) };
    const W = full.w | 0, H = full.h | 0;
    if (!(W > 0 && H > 0)) throw new Error("keymatte: an empty key box");
    const out = o.out || { x: 0, y: 0, w: W, h: H };
    const ox = out.x | 0, oy = out.y | 0, w = out.w | 0, h = out.h | 0;
    if (!(w > 0 && h > 0) || ox < 0 || oy < 0 || ox + w > W || oy + h > H) throw new Error("keymatte: the matte's box is not inside the key box");
    const kx = src.w / W, ky = src.h / H;
    const i0 = new Int32Array(w), i1 = new Int32Array(w), fx = new Float32Array(w);
    for (let x = 0; x < w; x++) {
        const u = src.x + (ox + x + 0.5) * kx - 0.5;
        let a = Math.floor(u), f = u - a;
        if (a < 0) { a = 0; f = 0; } else if (a >= aw - 1) { a = aw - 1; f = 0; }
        i0[x] = a; i1[x] = Math.min(aw - 1, a + 1); fx[x] = f;
    }
    // the upscale factor: full-resolution pixels per bucket pixel along the longer side of the source region
    const scale = Math.max(W / src.w, H / src.h);
    return { aw, ah, src, W, H, ox, oy, w, h, kx, ky, i0, i1, fx, scale };
}

/** The bucket row lerp for out row y: [j0, j1, fy]. */
function rowAt(geo, y) {
    const v = geo.src.y + (geo.oy + y + 0.5) * geo.ky - 0.5;
    let j = Math.floor(v), f = v - j;
    if (j < 0) { j = 0; f = 0; } else if (j >= geo.ah - 1) { j = geo.ah - 1; f = 0; }
    return [j, Math.min(geo.ah - 1, j + 1), f];
}

/**
 * Rows y0..y1 (out coordinates) of a bucket-sized float plane upsampled bilinearly to the matte's box, as floats.
 * @param {Float32Array} plane aw x ah
 * @param {*} geo geometry()
 * @param {number} y0
 * @param {number} y1
 * @param {Float32Array} [out] (y1 - y0) * w
 */
export function upsampleRows(plane, geo, y0, y1, out = new Float32Array((y1 - y0) * geo.w)) {
    const { aw, w, i0, i1, fx } = geo;
    const row = new Float32Array(aw);
    for (let y = y0; y < y1; y++) {
        const [j0, j1, fy] = rowAt(geo, y), a = j0 * aw, b = j1 * aw, gy = 1 - fy;
        for (let i = 0; i < aw; i++) row[i] = gy * plane[a + i] + fy * plane[b + i];
        const o = (y - y0) * w;
        for (let x = 0; x < w; x++) { const l = row[i0[x]]; out[o + x] = l + fx[x] * (row[i1[x]] - l); }
    }
    return out;
}

// ---- the parameters and the bands ------------------------------------------------------------------------------------

/**
 * The radius, eps and halo for an upscale factor (full-resolution pixels per bucket pixel).
 * "fast": r in bucket pixels (REFINE.r; a window must hold both sides of the matte's transition, which at the bucket
 * is about the same width whatever the factor); the halo is the noise smoothing's largest radius, rhoMax, at most half
 * the factor (a fraction of a bucket pixel: beyond it the bilinear matte is as good). "full": r = round(fullK * factor)
 * full-resolution pixels (the bilinear transition is about two factors wide), at least 1, halo 2r. "bilinear": no
 * filter, halo 0.
 * @param {number} scale
 * @param {{ method?: string, r?: number, eps?: number, flat?: number, fullK?: number, rhoMax?: number }} [o]
 */
export function refineParams(scale, o = {}) {
    const method = o.method || REFINE.method;
    if (!METHODS.includes(method)) throw new Error(`keymatte: unknown method "${method}"`);
    const eps = o.eps != null ? o.eps : REFINE.eps, flat = o.flat != null ? o.flat : REFINE.flat;
    if (method === "bilinear") return { method, r: 0, eps, flat, halo: 0 };
    if (method === "fast") {
        const rho = Math.max(0, Math.min(Math.floor(o.rhoMax != null ? o.rhoMax : REFINE.rhoMax), Math.floor(scale / 2)));
        return { method, r: Math.max(1, Math.round(o.r != null ? o.r : REFINE.r)), eps, flat, halo: rho };
    }
    const k = o.fullK != null ? o.fullK : REFINE.fullK;
    const r = Math.max(1, Math.round(o.r != null ? o.r : k * Math.max(1, scale)));
    return { method, r, eps, flat, halo: 2 * r };
}

/**
 * The bands of a w x h matte: rows [y0, y1) answered, rows [ry0, ry1) read (the halo above and below, clamped to the
 * box). A box of at most `unbandedPx` pixels is one band; else bands of about `bandPx` pixels, at least 4 halos and 16
 * rows tall, or exactly `bandRows` when given.
 * @param {number} w
 * @param {number} h
 * @param {{ halo?: number, bandRows?: number, bandPx?: number, unbandedPx?: number }} [o]
 * @returns {{ y0: number, y1: number, ry0: number, ry1: number }[]}
 */
export function bandPlan(w, h, o = {}) {
    const halo = Math.max(0, o.halo | 0);
    const unbanded = o.unbandedPx != null ? o.unbandedPx : REFINE.unbandedPx;
    let rows = o.bandRows | 0;
    if (!(rows > 0)) rows = w * h <= unbanded ? h : Math.max(16, 4 * halo, Math.floor((o.bandPx || REFINE.bandPx) / Math.max(1, w)));
    const bands = [];
    for (let y0 = 0; y0 < h; y0 += rows) {
        const y1 = Math.min(h, y0 + rows);
        bands.push({ y0, y1, ry0: Math.max(0, y0 - halo), ry1: Math.min(h, y1 + halo) });
    }
    return bands;
}

// ---- the fit at the bucket (method "fast") --------------------------------------------------------------------------

/** The part of `flat` a window's variance must exceed before it counts at all (a quarter of a level at the default). */
const FLOOR = 0.05;

/** Means over (2r + 1)^2 windows, the box blur clamped at the edges (px/kernels.js). */
function mean(box, a, w, h, r) { return box(a, w, h, [r]); }

/**
 * The window-averaged coefficients of the confidence-weighted linear model, one-channel guide.
 * @returns {Float32Array[]} [A, B, C]
 */
function fitGrey(I, p, w, h, r, eps, flat, box) {
    const n = w * h, Ip = new Float32Array(n), II = new Float32Array(n);
    for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
    const mI = mean(box, I, w, h, r), mP = mean(box, p, w, h, r), mIp = mean(box, Ip, w, h, r), mII = mean(box, II, w, h, r);
    const ca = new Float32Array(n), cb = new Float32Array(n), cc = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        let v = mII[i] - mI[i] * mI[i] - flat * FLOOR;   // the rounding of a flat window's means is not an edge
        if (!(v > 0)) v = 0;
        const a = (mIp[i] - mI[i] * mP[i]) / (v + eps), c = v / (v + flat);
        ca[i] = c * a; cb[i] = c * (mP[i] - a * mI[i]); cc[i] = c;
    }
    return [mean(box, ca, w, h, r), mean(box, cb, w, h, r), mean(box, cc, w, h, r)];
}

/**
 * The same for the three-channel guide (He et al.'s colour guided filter: a = (Sigma + eps U)^-1 cov(I, p)); the
 * confidence from the trace of Sigma.
 * @returns {Float32Array[]} [A0, A1, A2, B, C]
 */
function fitColour(I0, I1, I2, p, w, h, r, eps, flat, box) {
    const n = w * h;
    const prod = (x, y) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = x[i] * y[i]; return o; };
    const m0 = mean(box, I0, w, h, r), m1 = mean(box, I1, w, h, r), m2 = mean(box, I2, w, h, r), mP = mean(box, p, w, h, r);
    const m0p = mean(box, prod(I0, p), w, h, r), m1p = mean(box, prod(I1, p), w, h, r), m2p = mean(box, prod(I2, p), w, h, r);
    const v00 = mean(box, prod(I0, I0), w, h, r), v01 = mean(box, prod(I0, I1), w, h, r), v02 = mean(box, prod(I0, I2), w, h, r);
    const v11 = mean(box, prod(I1, I1), w, h, r), v12 = mean(box, prod(I1, I2), w, h, r), v22 = mean(box, prod(I2, I2), w, h, r);
    const ca0 = new Float32Array(n), ca1 = new Float32Array(n), ca2 = new Float32Array(n), cb = new Float32Array(n), cc = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const a0 = m0[i], a1 = m1[i], a2 = m2[i], mp = mP[i];
        const s00 = v00[i] - a0 * a0, s01 = v01[i] - a0 * a1, s02 = v02[i] - a0 * a2;
        const s11 = v11[i] - a1 * a1, s12 = v12[i] - a1 * a2, s22 = v22[i] - a2 * a2;
        const tr = s00 + s11 + s22 - flat * FLOOR;
        if (!(tr > 0)) continue;   // a flat window: no fit, the matte passes (the planes start at 0)
        const q0 = m0p[i] - a0 * mp, q1 = m1p[i] - a1 * mp, q2 = m2p[i] - a2 * mp;
        // (Sigma + eps I)^-1 by cofactors (symmetric)
        const e00 = s00 + eps, e11 = s11 + eps, e22 = s22 + eps;
        const c00 = e11 * e22 - s12 * s12, c01 = s02 * s12 - s01 * e22, c02 = s01 * s12 - e11 * s02;
        const c11 = e00 * e22 - s02 * s02, c12 = s01 * s02 - e00 * s12, c22 = e00 * e11 - s01 * s01;
        const det = e00 * c00 + s01 * c01 + s02 * c02;
        const k = det !== 0 ? 1 / det : 0;
        const x0 = (c00 * q0 + c01 * q1 + c02 * q2) * k, x1 = (c01 * q0 + c11 * q1 + c12 * q2) * k, x2 = (c02 * q0 + c12 * q1 + c22 * q2) * k;
        const c = tr / (tr + flat);
        ca0[i] = c * x0; ca1[i] = c * x1; ca2[i] = c * x2; cb[i] = c * (mp - x0 * a0 - x1 * a1 - x2 * a2); cc[i] = c;
    }
    return [mean(box, ca0, w, h, r), mean(box, ca1, w, h, r), mean(box, ca2, w, h, r), mean(box, cb, w, h, r), mean(box, cc, w, h, r)];
}

/** `k` passes of a [1 2 1] / 4 blur along rows and columns (clamped at the edges); new planes. */
function blur121(planes, w, h, k) {
    return planes.map((P) => {
        let a = Float32Array.from(P);
        const b = new Float32Array(w * h);
        for (let pass = 0; pass < k; pass++) {
            for (let y = 0; y < h; y++) {
                const o = y * w;
                for (let x = 0; x < w; x++) b[o + x] = (a[o + (x > 0 ? x - 1 : 0)] + 2 * a[o + x] + a[o + (x < w - 1 ? x + 1 : w - 1)]) * 0.25;
            }
            for (let y = 0; y < h; y++) {
                const o = y * w, u = (y > 0 ? y - 1 : 0) * w, d = (y < h - 1 ? y + 1 : h - 1) * w;
                for (let x = 0; x < w; x++) a[o + x] = (b[u + x] + 2 * b[o + x] + b[d + x]) * 0.25;
            }
        }
        return a;
    });
}

/** The mean squared error of a fit's prediction of the matte over its transition (0.02 < p < 0.98), at the bucket. */
function fitResidual(coef, planes, p) {
    const three = planes.length === 3, n = p.length;
    let e = 0, m = 0;
    for (let i = 0; i < n; i++) {
        const v = p[i];
        if (!(v > 0.02 && v < 0.98)) continue;
        const q = three
            ? coef[0][i] * planes[0][i] + coef[1][i] * planes[1][i] + coef[2][i] * planes[2][i] + coef[3][i] + (1 - coef[4][i]) * v
            : coef[0][i] * planes[0][i] + coef[1][i] + (1 - coef[2][i]) * v;
        const d = (q < 0 ? 0 : q > 1 ? 1 : q) - v;
        e += d * d; m++;
    }
    return m ? e / m : 0;
}

// ---- the zone and the noise (method "fast") -------------------------------------------------------------------------

/**
 * The engine counts as sure of a pixel below GATE_LO from 0 or 1, and as in transition above GATE_HI. At full
 * resolution the upsampled weight counts from GATE_CUT up (rescaled to 0..1): the zone ends half a bucket pixel past the
 * dilated cells instead of a whole one, which the measurement asked for (the noise left at its tail).
 */
const GATE_LO = 0.02, GATE_HI = 0.06, GATE_CUT = 0.5;

/**
 * The zone weight at the bucket: 1 where the matte is in transition (min(p, 1 - p) above GATE_HI, smoothly from
 * GATE_LO), dilated by `m` bucket pixels (a max filter); 0 where the engine is sure over the whole neighbourhood.
 */
function gatePlane(p, aw, ah, m) {
    const n = aw * ah, ind = new Float32Array(n), span = GATE_HI - GATE_LO;
    for (let i = 0; i < n; i++) {
        const d = p[i] < 1 - p[i] ? p[i] : 1 - p[i], t = (d - GATE_LO) / span;
        ind[i] = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
    }
    if (!(m > 0)) return ind;
    const tmp = new Float32Array(n), out = new Float32Array(n);
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
        let v = 0;
        for (let i = Math.max(0, x - m), e = Math.min(aw - 1, x + m); i <= e; i++) if (ind[y * aw + i] > v) v = ind[y * aw + i];
        tmp[y * aw + x] = v;
    }
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
        let v = 0;
        for (let j = Math.max(0, y - m), e = Math.min(ah - 1, y + m); j <= e; j++) if (tmp[j * aw + x] > v) v = tmp[j * aw + x];
        out[y * aw + x] = v;
    }
    return out;
}

/** 1 within `m` bucket pixels of a cell whose zone weight is above 0, else 0. */
function reachPlane(G, aw, ah, m) {
    const n = aw * ah, out = new Float32Array(n), tmp = new Uint8Array(n);
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
        let v = 0;
        for (let i = Math.max(0, x - m), e = Math.min(aw - 1, x + m); i <= e && !v; i++) if (G[y * aw + i] > 0) v = 1;
        tmp[y * aw + x] = v;
    }
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
        let v = 0;
        for (let j = Math.max(0, y - m), e = Math.min(ah - 1, y + m); j <= e && !v; j++) if (tmp[j * aw + x]) v = 1;
        out[y * aw + x] = v;
    }
    return out;
}

/**
 * The rows of the matte's box the noise sample reads: a strip across the middle, at least 48 rows and four bucket
 * pixels tall, the whole box when it is smaller. A function of the geometry alone, so every band plan reads the same.
 * @param {*} geo geometry()
 * @returns {[number, number]} [y0, y1) in the matte box's own rows
 */
export function sampleRows(geo) {
    const rows = Math.min(geo.h, Math.max(48, Math.ceil(4 / geo.ky)));
    const y0 = Math.floor((geo.h - rows) / 2);
    return [y0, y0 + rows];
}

function median(a) {
    if (!a.length) return 0;
    const s = Float64Array.from(a).sort(), k = s.length >> 1;
    return s.length & 1 ? s[k] : (s[k - 1] + s[k]) / 2;
}

/**
 * The noise sample: `rgba`, the full-resolution rows `st.sample` of the matte's box (straight RGBA, w wide), sorted into
 * the bucket pixels they average into. Sets, on `st`: `sigma` (per guide plane, guide units: the median within-bucket-
 * pixel standard deviation, which is the sensor noise wherever most of the strip is screen or plain subject, and the
 * sub-bucket texture the fit cannot see where it is not), `noise` (the same in levels per RGB channel, for the record),
 * `guideDiff` (levels: the largest per-channel median of |the pixels' mean - the bucket pixel| over the bucket pixels the
 * strip covers whole) and `fallback` (a reason when guideDiff exceeds `guideTol`: the read is not the bucket's picture).
 * @param {*} st prepareRefine()
 * @param {ArrayLike<number>} rgba
 */
export function noteSample(st, rgba) {
    if (st.method !== "fast") return st;
    const { geo, g } = st, { w, aw, ah, src, W, H, ox, oy, kx, ky } = geo, [sy0, sy1] = st.sample, rows = sy1 - sy0;
    if (!rgba || rgba.length < rows * w * 4) throw new Error(`keymatte: the noise sample holds ${rgba ? rgba.length : 0} bytes, not ${rows * w * 4}`);
    const cell = (u, n) => { const c = Math.floor(u); return c < 0 ? 0 : c >= n ? n - 1 : c; };
    // how many key-box pixels each bucket column and row averages (a bucket pixel is whole when the strip saw them all)
    const colAll = new Int32Array(aw), rowAll = new Int32Array(ah), colCell = new Int32Array(w);
    for (let X = 0; X < W; X++) colAll[cell(src.x + (X + 0.5) * kx, aw)]++;
    for (let Y = 0; Y < H; Y++) rowAll[cell(src.y + (Y + 0.5) * ky, ah)]++;
    for (let x = 0; x < w; x++) colCell[x] = cell(src.x + (ox + x + 0.5) * kx, aw);
    const rowCell = (y) => cell(src.y + (oy + y + 0.5) * ky, ah);
    const cy0 = rowCell(sy0), ncy = rowCell(sy1 - 1) - cy0 + 1, nc = ncy * aw, P = g.planes;
    const cnt = new Int32Array(nc), s1 = new Float64Array(nc * 3), s2 = new Float64Array(nc * 3), g1 = new Float64Array(nc * P), g2 = new Float64Array(nc * P);
    const planes = Array.from({ length: P }, () => new Float32Array(w));
    for (let y = 0; y < rows; y++) {
        const base = (rowCell(sy0 + y) - cy0) * aw;
        guidePlanes(g, rgba, y * w, w, planes, 0);
        for (let x = 0, o = y * w * 4; x < w; x++, o += 4) {
            const c = base + colCell[x];
            cnt[c]++;
            for (let k = 0; k < 3; k++) { const v = rgba[o + k]; s1[c * 3 + k] += v; s2[c * 3 + k] += v * v; }
            for (let k = 0; k < P; k++) { const v = planes[k][x]; g1[c * P + k] += v; g2[c * P + k] += v * v; }
        }
    }
    const whole = [], some = [];
    for (let c = 0; c < nc; c++) {
        const n = cnt[c];
        if (n < 4) continue;
        some.push(c);
        if (n === colAll[c % aw] * rowAll[cy0 + Math.floor(c / aw)]) whole.push(c);
    }
    const use = whole.length >= 8 ? whole : some;
    const vars = (S1, S2, k, K) => use.map((c) => { const n = cnt[c], m = S1[c * K + k] / n, v = (S2[c * K + k] - m * S1[c * K + k]) / (n - 1); return v > 0 ? v : 0; });
    // the median of a sample variance of n values is below sigma^2 by about (1 - 2 / (9 (n - 1)))^3
    const nMean = use.length ? use.reduce((a, c) => a + cnt[c], 0) / use.length : 2, k1 = Math.max(1, nMean - 1);
    const fix = 1 / Math.pow(1 - 2 / (9 * k1), 3);
    const sigma = new Float64Array(P), noise = [0, 0, 0];
    if (use.length >= 8) {
        for (let k = 0; k < P; k++) sigma[k] = Math.sqrt(median(vars(g1, g2, k, P)) * fix);
        for (let k = 0; k < 3; k++) noise[k] = Math.round(Math.sqrt(median(vars(s1, s2, k, 3)) * fix) * 100) / 100;
    }
    let guideDiff = null;
    if (whole.length >= 8) {
        const d = st.small.data;
        guideDiff = 0;
        for (let k = 0; k < 3; k++) {
            const m = median(whole.map((c) => { const at = ((cy0 + Math.floor(c / aw)) * aw + (c % aw)) * 4 + k; return Math.abs(s1[c * 3 + k] / cnt[c] - d[at]); }));
            if (m > guideDiff) guideDiff = m;
        }
        guideDiff = Math.round(guideDiff * 100) / 100;
    }
    st.sigma = sigma; st.noise = noise; st.guideDiff = guideDiff; st.cells = whole.length;
    st.fallback = guideDiff != null && guideDiff > st.guideTol
        ? `the picture read at full resolution is not the bucket's picture (a median difference of ${guideDiff} levels per bucket pixel): the matte is the bilinear upsample`
        : null;
    return st;
}

// ---- prepare, one band, the whole matte -----------------------------------------------------------------------------

/**
 * Everything a band needs, made once per matte (in the key worker: on its first message).
 * @param {{
 *   alpha: Float32Array | Uint16Array | Uint8Array | Uint8ClampedArray, aw: number, ah: number,
 *   small?: { data: ArrayLike<number>, width: number, height: number } | null,
 *   src?: { x: number, y: number, w: number, h: number }, full?: { w: number, h: number },
 *   out?: { x: number, y: number, w: number, h: number },
 *   method?: string, guide?: string, linear?: boolean, screen?: number[] | null,
 *   r?: number, eps?: number, flat?: number, fullK?: number, soft?: number | "auto", softs?: number[],
 *   gate?: number | false, tau?: number, rhoMax?: number, guideTol?: number, noise?: number | number[] | null, reach?: number,
 *   box?: (data: Float32Array, w: number, h: number, radii: number[]) => Float32Array
 * }} o `noise` (levels of sensor noise per RGB channel, one sigma) skips the sample and its check (tests, a caller that
 *   knows the noise); without it "fast" needs `noteSample` on `st.sample` before its first band.
 */
export function prepareRefine(o) {
    const geo = geometry(o);
    const p = toFloatAlpha(o.alpha);
    if (p.length !== geo.aw * geo.ah) throw new Error(`keymatte: the alpha holds ${p.length} values, not ${geo.aw} x ${geo.ah}`);
    const prm = refineParams(geo.scale, o);
    const guide = o.guide || REFINE.guide, linear = o.linear != null ? o.linear : REFINE.linear;
    const box = o.box || boxBlurs;
    const st = {
        geo, p, ...prm, guide, linear, box, g: null, coef: null, soft: 0, residual: 0, fitMs: 0, small: o.small || null,
        gate: o.gate !== undefined ? o.gate : REFINE.gate, gateP: null, tau: o.tau != null ? o.tau : REFINE.tau,
        guideTol: o.guideTol != null ? o.guideTol : REFINE.guideTol,
        sample: null, sigma: null, noise: null, guideDiff: null, cells: 0, fallback: null, sat: null,
    };
    if (prm.method === "bilinear") return st;
    if (prm.method === "full" && guide === "rgb") throw new Error('keymatte: the "full" method takes a grey guide');
    let screen = o.screen || null;
    if (!screen && (guide === "chroma" || guide === "dist") && o.small) screen = screenColor(o.small, p);
    st.g = guideSetup(guide, screen, linear);
    if (prm.method === "fast") {
        const s = o.small;
        if (!s || s.width !== geo.aw || s.height !== geo.ah) throw new Error('keymatte: the "fast" method needs the bucket picture (small) at the alpha\'s size');
        const t0 = Date.now(), n = geo.aw * geo.ah, { aw, ah } = geo;
        const planes = Array.from({ length: st.g.planes }, () => new Float32Array(n));
        guidePlanes(st.g, s.data, 0, n, planes, 0);
        const fit = (P) => P.length === 3
            ? fitColour(P[0], P[1], P[2], p, aw, ah, prm.r, prm.eps, prm.flat, box)
            : fitGrey(P[0], p, aw, ah, prm.r, prm.eps, prm.flat, box);
        const soft = o.soft != null ? o.soft : REFINE.soft;
        const softs = soft === "auto" ? (o.softs || REFINE.softs) : [Math.max(0, soft | 0)];
        let best = null;
        for (const k of softs) {
            const P = k ? blur121(planes, aw, ah, k) : planes, coef = fit(P);
            const res = softs.length > 1 ? fitResidual(coef, P, p) : 0;
            if (!best || res < best.res) best = { k, coef, res };
        }
        st.coef = best.coef; st.soft = best.k; st.residual = best.res;
        st.gateP = st.gate === false || st.gate == null ? new Float32Array(n).fill(1) : gatePlane(p, aw, ah, Math.max(0, st.gate | 0));
        // where the correction is needed at all: the zone and two bucket pixels around it, the smoothing's box reaching
        // at most half a bucket pixel out of it (so the skipped pixels never enter a box: the answer is the same)
        st.reachP = reachPlane(st.gateP, aw, ah, o.reach != null ? o.reach : 2);
        st.sample = sampleRows(geo);
        if (o.noise != null) {
            const lv = Array.isArray(o.noise) ? o.noise : [o.noise, o.noise, o.noise];
            st.noise = lv.map(Number);
            st.sigma = Float64Array.from({ length: st.g.planes }, (_, k) => (st.g.planes === 3 ? st.noise[k] : Math.hypot(...st.noise) / Math.sqrt(3)) * st.g.noiseGain);
        }
        st.fitMs = Date.now() - t0;
    }
    return st;
}

/**
 * One band's answer: the u8 matte of rows [band.y0, band.y1) of the matte's box, from `rgba`, the full-resolution
 * picture rows [band.ry0, band.ry1) of the box (straight RGBA bytes, w wide; ignored by "bilinear"). The halo rows are
 * read and trimmed here: the answer holds exactly (y1 - y0) * w bytes.
 * @param {*} st prepareRefine()
 * @param {{ y0: number, y1: number, ry0: number, ry1: number }} band
 * @param {ArrayLike<number> | null} rgba
 * @param {Uint8Array} [out]
 */
export function refineBand(st, band, rgba, out = new Uint8Array((band.y1 - band.y0) * st.geo.w)) {
    const { geo } = st, { w } = geo, { y0, y1, ry0, ry1 } = band;
    if (st.method !== "bilinear" && !st.fallback && (!rgba || rgba.length < (ry1 - ry0) * w * 4)) throw new Error(`keymatte: the band's picture holds ${rgba ? rgba.length : 0} bytes, not ${(ry1 - ry0) * w * 4}`);
    if (st.method === "bilinear") {
        const p = upsampleRows(st.p, geo, y0, y1);
        for (let i = 0; i < p.length; i++) out[i] = Math.round(p[i] * 255);
        return out;
    }
    if (st.method === "full") {
        const rows = ry1 - ry0, n = rows * w;
        const p = upsampleRows(st.p, geo, ry0, ry1), I = new Float32Array(n);
        guidePlanes(st.g, rgba, 0, n, [I], 0);
        const q = guidedFilter(I, p, w, rows, st.r, st.eps, st.box);
        // the flat windows keep the matte: the confidence of the window around each pixel
        const II = new Float32Array(n);
        for (let i = 0; i < n; i++) II[i] = I[i] * I[i];
        const mI = st.box(I, w, rows, [st.r]), mII = st.box(II, w, rows, [st.r]);
        const skip = (y0 - ry0) * w;
        for (let i = 0, m = (y1 - y0) * w; i < m; i++) {
            const k = skip + i;
            let v = mII[k] - mI[k] * mI[k] - st.flat * FLOOR;
            if (!(v > 0)) v = 0;
            const c = v / (v + st.flat), a = c * q[k] + (1 - c) * p[k];
            out[i] = Math.round((a < 0 ? 0 : a > 1 ? 1 : a) * 255);
        }
        return out;
    }
    // "fast"
    if (!st.sigma) throw new Error("keymatte: the noise sample first (noteSample on st.sample), or pass `noise`");
    if (st.fallback) return refineBand({ ...st, method: "bilinear" }, band, null, out);
    return fastBand(st, band, rgba, out);
}

/** Fixed point of the correction in the smoothing's sums: integers, so a box sums the same in any band. */
const QF = 65536;

/**
 * One full-resolution row of the fast method's terms. With PP null (the box sums' pass): E, the correction q - p,
 * wherever the reach plane says a box may need it, 0 elsewhere. With PP (the answer's pass): PP the bilinear matte p
 * and WG the zone weight (from GATE_CUT up, rescaled) everywhere, E and SG (the noise the correction carries, |A sigma|
 * in alpha units) inside the zone only. The bucket rows are lerped once per row; the same float operations in either
 * pass, so a pixel's E is the same number in both.
 */
function rowTerms(st, y, rgba, src, R, gp, E, PP, WG, SG) {
    const { geo, g, sigma, applyPlanes } = st, { aw, w, i0, i1, fx } = geo, np = applyPlanes.length;
    const [j0, j1, fy] = rowAt(geo, y), a = j0 * aw, b = j1 * aw, gy = 1 - fy;
    for (let k = 0; k < np; k++) {
        const P = applyPlanes[k], Rk = R[k];
        for (let i = 0; i < aw; i++) Rk[i] = gy * P[a + i] + fy * P[b + i];
    }
    const answer = !!PP, three = g.planes === 3;
    if (!three) guidePlanes(g, rgba, src, w, gp, 0);
    const I = gp[0], T = g.T;
    const A0 = R[0], A1 = three ? R[1] : null, A2 = three ? R[2] : null, B = R[three ? 3 : 1], C = R[three ? 4 : 2];
    const Pp = R[three ? 5 : 3], G = R[three ? 6 : 4], GR = R[three ? 7 : 5];
    const z0 = sigma[0], z1 = three ? sigma[1] : 0, z2 = three ? sigma[2] : 0;
    for (let x = 0; x < w; x++) {
        const l = i0[x], r = i1[x], f = fx[x];
        if (answer) {
            PP[x] = Pp[l] + f * (Pp[r] - Pp[l]);
            const gw = G[l] + f * (G[r] - G[l]), wg = gw > GATE_CUT ? (gw - GATE_CUT) / (1 - GATE_CUT) : 0;
            WG[x] = wg;
            if (!(wg > 0)) { E[x] = 0; SG[x] = 0; continue; }
        } else if (!(GR[l] > 0 || GR[r] > 0)) { E[x] = 0; continue; }
        const p = Pp[l] + f * (Pp[r] - Pp[l]), bb = B[l] + f * (B[r] - B[l]), cc = C[l] + f * (C[r] - C[l]);
        const a0 = A0[l] + f * (A0[r] - A0[l]);
        let q, sg = 0;
        if (three) {
            const s4 = (src + x) * 4;
            const a1 = A1[l] + f * (A1[r] - A1[l]), a2 = A2[l] + f * (A2[r] - A2[l]);
            q = a0 * T[rgba[s4]] + a1 * T[rgba[s4 + 1]] + a2 * T[rgba[s4 + 2]] + bb + (1 - cc) * p;
            if (answer) { const u0 = a0 * z0, u1 = a1 * z1, u2 = a2 * z2; sg = Math.sqrt(u0 * u0 + u1 * u1 + u2 * u2); }
        } else {
            q = a0 * I[x] + bb + (1 - cc) * p;
            if (answer) sg = Math.abs(a0 * z0);
        }
        E[x] = q - p;
        if (answer) SG[x] = sg;
    }
}

/**
 * The fast method's band: q = p + w g e~, with p the bilinear matte, w the zone weight, e~ the correction e = A.I + B
 * - C p smoothed by a box of radius rho = clamp((|A sigma| / tau - 1) / 2, 0, rhoMax) (lerped between whole radii, the
 * sums over e in fixed point, so they are exact), and g = min(1, 1 / x^2) with x the noise left after the box over tau.
 * Noise-free (sigma 0) it is the plain fast guided filter inside the zone and the bilinear matte outside it.
 */
function fastBand(st, band, rgba, out) {
    const { geo, tau } = st, { w, aw } = geo, { y0, y1, ry0, ry1 } = band, rows = ry1 - ry0;
    if (!st.applyPlanes) st.applyPlanes = [...st.coef, st.p, st.gateP, st.reachP];
    const R = st.applyPlanes.map(() => new Float32Array(aw)), gp = [new Float32Array(w)];
    const E = new Float32Array(w), PP = new Float32Array(w), WG = new Float32Array(w), SG = new Float32Array(w);
    const rmax = st.halo, smooth = rmax > 0 && st.sigma.some((v) => v > 0) && tau > 0;
    // the box sums: the correction of every row read (the halo included) in fixed point, summed into a table
    let S = null;
    const W1 = w + 1;
    if (smooth) {
        const need = (rows + 1) * W1;
        if (!st.sat || st.sat.length < need) st.sat = new Float64Array(need);
        S = st.sat;
        S.fill(0, 0, W1);
        for (let y = ry0; y < ry1; y++) {
            rowTerms(st, y, rgba, (y - ry0) * w, R, gp, E, null, null, null);
            const up = (y - ry0) * W1, at = up + W1;
            let run = 0;
            S[at] = 0;
            for (let x = 0; x < w; x++) { run += Math.round(E[x] * QF); S[at + x + 1] = S[up + x + 1] + run; }
        }
    }
    const boxAt = (x, yy, r) => {
        const xa = x - r < 0 ? 0 : x - r, xb = x + r + 1 > w ? w : x + r + 1, ya = yy - r < 0 ? 0 : yy - r, yb = yy + r + 1 > rows ? rows : yy + r + 1;
        return (S[yb * W1 + xb] - S[ya * W1 + xb] - S[yb * W1 + xa] + S[ya * W1 + xa]) / ((xb - xa) * (yb - ya) * QF);
    };
    for (let y = y0; y < y1; y++) {
        const yy = y - ry0, o = (y - y0) * w;
        rowTerms(st, y, rgba, yy * w, R, gp, E, PP, WG, SG);
        for (let x = 0; x < w; x++) {
            const wg = WG[x];
            let v = PP[x];
            if (wg > 0) {
                const xs = tau > 0 ? SG[x] / tau : 0;
                let rho = smooth && xs > 1 ? (xs - 1) / 2 : 0;
                if (rho > rmax) rho = rmax;
                let e = E[x];
                if (rho > 0) {
                    const r0 = Math.floor(rho), f = rho - r0;
                    const b0 = r0 > 0 ? boxAt(x, yy, r0) : Math.round(e * QF) / QF;
                    e = f > 0 ? (1 - f) * b0 + f * boxAt(x, yy, r0 + 1) : b0;
                }
                const xr = xs / (2 * rho + 1);
                v += wg * (xr > 1 ? e / (xr * xr) : e);
            }
            out[o + x] = Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255);
        }
    }
    return out;
}

/**
 * The whole matte, band by band, reading the picture through `read`. `read([x0, y0, x1, y1])` (the matte box's own
 * coordinates; x0 = 0, x1 = w: a band is whole rows) answers (or resolves to) straight RGBA bytes of that box, a typed
 * array or `{ data }`, **of the same picture the bucket was read from** at scale 1 (see the header; for the "fast"
 * method the first read is the noise sample `st.sample`, then each band with its halo). `onBand(y0, y1, bytes)` takes each band's u8 rows as they are
 * made (the caller writes them into the mask, `combine(bytesSource(...), "add", MASK_RGB)`); without it the rows are
 * collected into one w x h array, answered as `alpha`.
 * @param {Parameters<typeof prepareRefine>[0] & {
 *   read?: (box: number[]) => any, onBand?: (y0: number, y1: number, bytes: Uint8Array) => any,
 *   bandRows?: number, bandPx?: number, unbandedPx?: number, cancelled?: () => boolean }} o
 */
export async function refineMatte(o) {
    const t0 = Date.now();
    const st = prepareRefine(o);
    const { w, h } = st.geo;
    let readMs = 0;
    if (st.method === "fast" && !st.sigma) {
        // the noise sample (and the check that the read is the bucket's picture) before the first band
        if (o.cancelled && o.cancelled()) return { cancelled: true };
        if (typeof o.read !== "function") throw new Error("keymatte: no read callback for the picture");
        const r0 = Date.now();
        const got = await o.read([0, st.sample[0], w, st.sample[1]]);
        readMs += Date.now() - r0;
        noteSample(st, got && got.data ? got.data : got);
    }
    const bands = bandPlan(w, h, { halo: st.halo, bandRows: o.bandRows, bandPx: o.bandPx, unbandedPx: o.unbandedPx });
    const whole = o.onBand ? null : new Uint8Array(w * h);
    for (const band of bands) {
        if (o.cancelled && o.cancelled()) return { cancelled: true };
        let rgba = null;
        if (st.method !== "bilinear" && !st.fallback) {
            if (typeof o.read !== "function") throw new Error("keymatte: no read callback for the picture");
            const r0 = Date.now();
            const got = await o.read([0, band.ry0, w, band.ry1]);
            readMs += Date.now() - r0;
            rgba = got && got.data ? got.data : got;
        }
        if (whole) refineBand(st, band, rgba, whole.subarray(band.y0 * w, band.y1 * w));
        else await o.onBand(band.y0, band.y1, refineBand(st, band, rgba));
    }
    return {
        alpha: whole, w, h, bands: bands.length, method: st.method, guide: st.method === "bilinear" ? null : st.guide,
        r: st.r, eps: st.eps, halo: st.halo, soft: st.soft, scale: st.geo.scale,
        sample: st.sample, noise: st.noise, guideDiff: st.guideDiff, fallback: st.fallback,
        ms: { all: Date.now() - t0, fit: st.fitMs, read: readMs },
    };
}
