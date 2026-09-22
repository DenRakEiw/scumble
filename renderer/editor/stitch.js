// Crop and stitch in the app, for recipes that render through an API provider instead
// of the user's ComfyUI. A port of the InpaintCanvas / InpaintCanvasStitch maths in the
// node's nodes.py (same formulas, same order), on Canvas 2D and typed arrays:
//
//   prepareCrop(editor, params)  -> { crop, mask, maskAlpha, references, info }
//   finishResult(editor, info, resultImage) -> { patch (RGBA canvas), x, y, w, h, align }
//
// A run goes through `prepareCropAsync` / `finishResultAsync`: the same steps, the pixels in a worker of their own
// (stitch_worker.js) and the composite of the box from the tile workers (`readBoxBytes`), so the window is not held for
// the crop and the stitch (docs/BUGS.md: 0.6 s at 15000 x 10000, 1.5 s with a colour-matched layer and 6.3 s with a
// film look over it, through the whole flatten). The synchronous pair stays: it is the fallback and what tests read.
//
// Differences from the node: resizing is the browser's bilinear/bicubic instead of
// Lanczos, the gaussian blur is a triple box blur, the "border" fill mode has no
// Navier-Stokes inpainting (it behaves like "blur"), and the ECC alignment of the
// result to its surroundings is not implemented (reported as not aligned).

import { dilateMask, boxBlurs, kernelsMode } from "./px/kernels.js";

const MIN_AUTO_CROP = 512;

/** A 2D canvas: a <canvas> in the window, an OffscreenCanvas in a worker (stitch_worker.js runs this module too). */
function makeCanvas(w, h) {
    w = Math.max(1, w | 0); h = Math.max(1, h | 0);
    if (typeof document === "undefined") return new OffscreenCanvas(w, h);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
}

/** Context padding, grow, feather and blend from the selection size (nodes.py _auto_selection_params). */
export function autoSelectionParams(selW, selH, strength = 1) {
    const diag = Math.hypot(selW, selH);
    strength = Math.min(1, Math.max(0.05, strength));
    const feather = Math.max(Math.floor(0.10 * diag * strength), Math.round(32 * strength));
    const grow = 4 + Math.floor(feather / 2);
    const blend = Math.min(25, grow + Math.floor(feather / 2));
    const pad = feather + 4 + Math.floor(0.06 * diag);
    return { pad, grow, feather, blend };
}

function ensureMinSpan(a0, a1, limit, minSize) {
    const size = a1 - a0;
    if (size >= minSize || minSize <= 0) return [a0, a1];
    const target = Math.min(minSize, limit);
    const extra = target - size;
    a0 -= Math.floor(extra / 2);
    a1 = a0 + target;
    if (a0 < 0) { a1 -= a0; a0 = 0; }
    if (a1 > limit) { a0 -= a1 - limit; a1 = limit; }
    return [Math.max(0, a0), a1];
}

function fitSpanToMultiple(a0, a1, limit, m) {
    const size = a1 - a0;
    let target = Math.ceil(size / m) * m;
    if (target > limit) { target = Math.floor(limit / m) * m; if (target <= 0) return [a0, a1]; }
    const extra = target - size;
    a0 -= Math.floor(extra / 2);
    a1 = a0 + target;
    if (a0 < 0) { a1 -= a0; a0 = 0; }
    if (a1 > limit) { a0 -= a1 - limit; a1 = limit; }
    return [Math.max(0, a0), a1];
}

// ---- float masks ------------------------------------------------------------------------

/** { data: Float32Array (0..1), w, h } */
function maskOf(w, h, fill = 0) { const data = new Float32Array(w * h); if (fill) data.fill(fill); return { data, w, h }; }

function maskFromCanvasAlpha(canvas, x0, y0, w, h) {
    return maskFromAlpha(canvas.getContext("2d").getImageData(x0, y0, w, h));
}

/** The box w x h at (x, y) of the full-resolution composite a run sees, as a canvas of the box. */
function regionOf(editor, x, y, w, h) {
    if (editor.tileMode && typeof editor.readBox === "function") return editor.readBox([x, y, x + w, y + h], { forRun: true });
    const c = makeCanvas(w, h);
    c.getContext("2d").drawImage(editor.flattenToCanvas({ forRun: true }), x, y, w, h, 0, 0, w, h);
    return c;
}

/** The alpha channel of ImageData (a readRect of the selection, say) as a 0..1 mask. */
function maskFromAlpha(img) {
    const w = img.width, h = img.height, d = img.data;
    const m = maskOf(w, h);
    for (let i = 0, j = 3; i < w * h; i++, j += 4) m.data[i] = d[j] / 255;
    return m;
}

function maskMax(a, b) { const o = maskOf(a.w, a.h); for (let i = 0; i < o.data.length; i++) o.data[i] = Math.max(a.data[i], b.data[i]); return o; }
function maskClamp(m) { for (let i = 0; i < m.data.length; i++) m.data[i] = Math.min(1, Math.max(0, m.data[i])); return m; }

/** Square dilation by px (max filter, separable). */
export function dilate(m, px) {
    px = Math.floor(px);
    if (px <= 0) return m;
    return { data: dilateMask(m.data, m.w, m.h, px), w: m.w, h: m.h };
}

function erode(m, px) {
    if (px <= 0) return m;
    const inv = maskOf(m.w, m.h);
    for (let i = 0; i < inv.data.length; i++) inv.data[i] = 1 - m.data[i];
    const d = dilate(inv, px);
    for (let i = 0; i < d.data.length; i++) d.data[i] = 1 - d.data[i];
    return d;
}

/** Gaussian blur with standard deviation sigma (three box blurs), clamped edges like PIL's. */
export function gaussBlur(m, sigma) {
    if (sigma <= 0) return m;
    const { w, h } = m;
    // box radii approximating a gaussian (W. Peter Kovesi's method, 3 boxes)
    const wIdeal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
    let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
    const wu = wl + 2;
    const mIdeal = (12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4);
    const mm = Math.round(mIdeal);
    const radii = [0, 1, 2].map((i) => ((i < mm ? wl : wu) - 1) / 2);
    return { data: boxBlurs(m.data, w, h, radii), w, h };
}

/** Selection -> dilate(grow) -> blur(feather / 2.5); always opaque inside the selection. */
function denoiseMask(sel, grow, feather) {
    let m = dilate(sel, grow);
    m = gaussBlur(m, feather / 2.5);
    return maskClamp(maskMax(m, sel));
}

/** Denoise mask -> erode(blend / 2) -> blur(blend / 2.5); opaque inside the selection. */
function compositeMask(sel, grow, feather, blend) {
    let m = denoiseMask(sel, grow, feather);
    m = erode(m, Math.floor(blend / 2));
    m = gaussBlur(m, blend / 2.5);
    return maskClamp(maskMax(m, sel));
}

/** The part w x h at (x0, y0) of a mask, in image coordinates; outside a window mask (`selectionWindow`) it is 0. */
function cropMask(m, x0, y0, w, h) {
    const o = maskOf(w, h);
    const ox = m.ox | 0, oy = m.oy | 0;
    const sx0 = Math.max(x0, ox), sx1 = Math.min(x0 + w, ox + m.w);
    if (sx1 <= sx0) return o;
    for (let y = Math.max(y0, oy), y1 = Math.min(y0 + h, oy + m.h); y < y1; y++) {
        const row = (y - oy) * m.w;
        o.data.set(m.data.subarray(row + sx0 - ox, row + sx1 - ox), (y - y0) * w + (sx0 - x0));
    }
    return o;
}

/** Above this many pixels the selection is read in a window around its bounds, not over the whole image (E2). */
let SEL_WINDOW_PIXELS = 16 * 1024 * 1024;
const SEL_WINDOW_MARGIN = 2048;

/** Tests: the image size above which the selection is read in a window (Infinity: always the whole image). Returns the old value. */
export function setSelectionWindowPixels(n) {
    const was = SEL_WINDOW_PIXELS;
    SEL_WINDOW_PIXELS = n;
    return was;
}

/**
 * The box of the selection a run reads, `[x0, y0, x1, y1]`: the whole image, or (E2) on a large image a window around
 * the selection's bounds. A whole mask of a 15000 x 10000 image is a 600 MB read and 600 MB of floats, and no ImageData
 * holds one of 30000 x 20000.
 */
function selectionWindowBox(editor) {
    const W = editor.width, H = editor.height;
    // on tiles the box of the mask's pixels that are not zero, soft tails and all; else the bounds of the selected
    // pixels (alpha of a half and more) with a margin for the tails
    let b = null, margin = SEL_WINDOW_MARGIN;
    if (W * H > SEL_WINDOW_PIXELS) {
        const ext = editor.tileMode && typeof editor.sel.bounds === "function" ? editor.sel.bounds() : null;
        if (ext) { b = ext; margin = 0; } else if (typeof editor.getBounds === "function") b = editor.getBounds();
    }
    if (!b) return [0, 0, W, H];
    return [Math.max(0, b[0] - margin), Math.max(0, b[1] - margin), Math.min(W, b[2] + margin), Math.min(H, b[3] + margin)];
}

/** The selection's window as ImageData and where it lies: `{ img, ox, oy, fullW, fullH }`. */
function selectionWindowPixels(editor) {
    const [x0, y0, x1, y1] = selectionWindowBox(editor);
    return { img: editor.sel.readRect(x0, y0, x1 - x0, y1 - y0), ox: x0, oy: y0, fullW: editor.width, fullH: editor.height };
}

/** A window read (`selectionWindowPixels`) as the 0..1 mask a run works with, `{ data, w, h, ox, oy, fullW, fullH }`. */
function windowMask(win) {
    const m = maskFromAlpha(win.img);
    m.ox = win.ox; m.oy = win.oy; m.fullW = win.fullW; m.fullH = win.fullH;
    return m;
}

/** The selection as a 0..1 mask for a run: of the whole image, or (E2) on a large image of a window around it. */
function selectionWindow(editor) {
    return windowMask(selectionWindowPixels(editor));
}

function resizeMask(m, w, h) {
    if (m.w === w && m.h === h) return m;
    const c = maskToCanvas(m);
    const out = makeCanvas(w, h);
    const ctx = out.getContext("2d");
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(c, 0, 0, w, h);
    return maskFromCanvasAlpha(out, 0, 0, w, h);
}

/** Mask as a canvas: white with alpha = value (usable both as luminance and as alpha). */
function maskToCanvas(m, { luminance = false } = {}) {
    const c = makeCanvas(m.w, m.h);
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(m.w, m.h);
    const d = img.data;
    for (let i = 0, j = 0; i < m.data.length; i++, j += 4) {
        const v = Math.round(Math.min(1, Math.max(0, m.data[i])) * 255);
        if (luminance) { d[j] = v; d[j + 1] = v; d[j + 2] = v; d[j + 3] = 255; }
        else { d[j] = 255; d[j + 1] = 255; d[j + 2] = 255; d[j + 3] = v; }
    }
    ctx.putImageData(img, 0, 0);
    return c;
}

function selectionBbox(m, padding) {
    const { w, h } = m;
    const ox = m.ox | 0, oy = m.oy | 0, W = m.fullW || w, H = m.fullH || h;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            if (m.data[row + x] > 0.5) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
    }
    if (x1 < 0) return { has: false, x0: 0, y0: 0, x1: W, y1: H };
    return { has: true, x0: Math.max(0, ox + x0 - padding), y0: Math.max(0, oy + y0 - padding), x1: Math.min(W, ox + x1 + 1 + padding), y1: Math.min(H, oy + y1 + 1 + padding) };
}

// ---- fill modes ---------------------------------------------------------------------------

/** Fill the selected area of an RGB(A) crop before it goes to the model (nodes.py _fill_masked). */
function fillMasked(crop, fillMask, mode) {
    if (!mode || mode === "none") return crop;
    const w = crop.width, h = crop.height;
    const ctx = crop.getContext("2d");
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const hard = maskOf(w, h);
    let count = 0;
    for (let i = 0; i < w * h; i++) { hard.data[i] = fillMask.data[i] > 0.5 ? 1 : 0; count += hard.data[i]; }
    if (!count) return crop;
    if (mode === "green") {
        for (let i = 0, j = 0; i < w * h; i++, j += 4) if (hard.data[i]) { d[j] = 0; d[j + 1] = 255; d[j + 2] = 0; d[j + 3] = 255; }
        ctx.putImageData(img, 0, 0);
        return crop;
    }
    const soft = gaussBlur(hard, 4);
    for (let i = 0; i < soft.data.length; i++) soft.data[i] = Math.max(Math.min(1, soft.data[i]), hard.data[i]);
    if (mode === "neutral") {
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0, j = 0; i < w * h; i++, j += 4) if (!hard.data[i]) { r += d[j]; g += d[j + 1]; b += d[j + 2]; n++; }
        const col = n ? [r / n, g / n, b / n] : [128, 128, 128];
        for (let i = 0, j = 0; i < w * h; i++, j += 4) {
            const s = soft.data[i];
            d[j] = d[j] * (1 - s) + col[0] * s; d[j + 1] = d[j + 1] * (1 - s) + col[1] * s; d[j + 2] = d[j + 2] * (1 - s) + col[2] * s;
        }
        ctx.putImageData(img, 0, 0);
        return crop;
    }
    // blur / border: smear the surroundings into the hole with a normalized convolution
    const sigma = Math.max(8, 0.05 * Math.max(w, h));
    const inv = maskOf(w, h);
    for (let i = 0; i < w * h; i++) inv.data[i] = 1 - hard.data[i];
    const den = gaussBlur(inv, sigma);
    const chans = [0, 1, 2].map((c) => {
        const m = maskOf(w, h);
        for (let i = 0, j = c; i < w * h; i++, j += 4) m.data[i] = d[j] * inv.data[i];
        return gaussBlur(m, sigma);
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
    ctx.putImageData(img, 0, 0);
    return crop;
}

// ---- prepare ------------------------------------------------------------------------------

function drawResized(src, w, h, { crop = "disabled" } = {}) {
    const out = makeCanvas(w, h);
    const ctx = out.getContext("2d");
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight;
    if (crop === "center") {
        // keep the aspect ratio by center-cropping the source
        const scale = Math.max(w / sw, h / sh);
        const cw = w / scale, ch = h / scale;
        ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, w, h);
    } else {
        ctx.drawImage(src, 0, 0, sw, sh, 0, 0, w, h);
    }
    return out;
}

/**
 * The long side the crop is emitted at. Without `limits` (a local ComfyUI run) that is the
 * node's own target_size, 0 meaning "keep the crop's size". With them (an API run) the app
 * picks the size the provider will take: `mode` "max" asks for the provider's maximum, "x2"
 * and "x4" are the high-res fix (the crop's own size times the factor), "target" keeps the
 * node's number and "crop" sends the crop as it is; every one of them is held inside the
 * variant's min and max.
 */
function emitTarget(limits, fixedSize, cw, ch) {
    if (!limits) return fixedSize;
    const long = Math.max(cw, ch);
    const mode = limits.mode || "max";
    const want = mode === "crop" ? long
        : mode === "target" ? (fixedSize > 0 ? fixedSize : long)
        : mode === "x2" ? long * 2
        : mode === "x4" ? long * 4
        : limits.max;
    return Math.min(limits.max, Math.max(limits.min, Math.round(want)));
}

/** What `planCrop` reads of the editor and the recipe: numbers and strings only, so a worker can have them too. */
function cropSettingsOf(editor, params, limits, cropOver = null) {
    const gen = editor.genSettings || {};
    return {
        width: editor.width, height: editor.height,
        gen: { mode: gen.mode, denoise: gen.denoise, refine: gen.refine },
        // `cropOver`: settings a run holds fixed whatever the panel says (an upscale sends no fill)
        crop: { ...(editor.cropSettings || {}), ...(cropOver || {}) },
        params: { padding: params.padding, target_size: params.target_size, feather: params.feather, multiple_of: params.multiple_of },
        limits: limits ? { ...limits } : null,
        base: editor.base && editor.base.ref ? { ...editor.base.ref } : null,
    };
}

/**
 * The geometry of a crop, exactly like the node's `run`: selection bbox plus context, the
 * mask parameters, and the size it is emitted at (both sides rounded to the multiple).
 * `s` is `cropSettingsOf`, `sel` the selection's window mask. Pure: no editor, no canvas.
 */
export function planCrop(s, sel) {
    const { width, height, params, limits } = s;
    const gen = s.gen || {};
    const mode = gen.mode === "local" ? "local" : "api";
    const denoise = Math.min(1, Math.max(0, +gen.denoise || 0));
    const refine = !!gen.refine && mode === "local";
    const strength = mode === "local" ? denoise : 1;
    const cs = s.crop || {};
    const autoContext = cs.context === "auto";
    const autoFeather = cs.feather === "auto";
    let fillMode = cs.fill || "none";
    const withOriginal = !!cs.withOriginal;
    const m = Math.max(1, Math.round((limits && limits.step) || +params.multiple_of || 64));
    const fixedSize = Math.max(0, Math.round(+params.target_size || 0));

    const bb0 = selectionBbox(sel, 0);
    const hasSelection = bb0.has;
    let { pad, grow, feather, blend } = autoSelectionParams(bb0.x1 - bb0.x0, bb0.y1 - bb0.y0, strength);
    if (!hasSelection) { pad = 0; grow = 0; feather = 0; blend = 0; }
    const padUsed = autoContext ? pad : Math.round(+params.padding || 0);
    let growUsed, featherUsed, blendUsed;
    if (autoFeather) { growUsed = grow; featherUsed = feather; blendUsed = blend; }
    else { growUsed = 0; featherUsed = Math.round(+params.feather || 0); blendUsed = 0; }
    if (refine) {
        growUsed = 0; featherUsed = 0; fillMode = "none";
        if (!autoFeather) blendUsed = Math.round(+params.feather || 0);
    }

    const bb = selectionBbox(sel, padUsed);
    let x0 = bb.x0, y0 = bb.y0, x1 = bb.x1, y1 = bb.y1;
    if (autoContext && hasSelection) {
        [x0, x1] = ensureMinSpan(x0, x1, width, MIN_AUTO_CROP);
        [y0, y1] = ensureMinSpan(y0, y1, height, MIN_AUTO_CROP);
    }
    if (limits && limits.ratio >= 1) {
        // a model with an input ratio limit (Seedream on ToAPIs: 3:1): a thin selection gets more
        // context on its short side instead of a refused crop; an image itself steeper than the limit
        // cannot be widened, and the adapter refuses that one before any upload
        const need = (long) => Math.ceil(long / limits.ratio);
        if (x1 - x0 > (y1 - y0) * limits.ratio) [y0, y1] = ensureMinSpan(y0, y1, height, need(x1 - x0));
        else if (y1 - y0 > (x1 - x0) * limits.ratio) [x0, x1] = ensureMinSpan(x0, x1, width, need(y1 - y0));
    }
    if (!limits && fixedSize <= 0) {
        [x0, x1] = fitSpanToMultiple(x0, x1, width, m);
        [y0, y1] = fitSpanToMultiple(y0, y1, height, m);
    }
    const cw = x1 - x0, ch = y1 - y0;
    const targetSize = emitTarget(limits, fixedSize, cw, ch);

    let ew = cw, eh = ch;
    if (targetSize > 0) {
        const scale = targetSize / Math.max(cw, ch);
        ew = Math.max(m, Math.round(cw * scale / m) * m);
        eh = Math.max(m, Math.round(ch * scale / m) * m);
        if (limits && limits.pixels && ew * eh > limits.pixels) {
            const k = Math.sqrt(limits.pixels / (ew * eh));
            ew = Math.max(m, Math.floor(ew * k / m) * m);
            eh = Math.max(m, Math.floor(eh * k / m) * m);
        }
        // an area *floor* (GPT Image 2.5 refuses anything under 655,360 pixels): grow the
        // emitted size until it is met, but never past the provider's own side limit
        if (limits && limits.minPixels && ew * eh < limits.minPixels) {
            const k = Math.min(Math.sqrt(limits.minPixels / (ew * eh)), limits.max / Math.max(ew, eh));
            ew = Math.min(limits.max, Math.max(m, Math.ceil(ew * k / m) * m));
            eh = Math.min(limits.max, Math.max(m, Math.ceil(eh * k / m) * m));
        }
        // rounding both sides to the step can tip a crop at the ratio limit just past it: widen the short side
        if (limits && limits.ratio >= 1 && cw * limits.ratio >= ch && ch * limits.ratio >= cw) {
            if (ew > eh * limits.ratio) eh = Math.min(limits.max, Math.ceil(ew / limits.ratio / m) * m);
            else if (eh > ew * limits.ratio) ew = Math.min(limits.max, Math.ceil(eh / limits.ratio / m) * m);
        }
    }

    const info = {
        base: s.base, bbox: [x0, y0, cw, ch], emitted: [ew, eh],
        align: cs.align !== false, paste: cs.paste === "crop" ? "crop" : "selection",
        feather: featherUsed, grow: growUsed, blend: blendUsed,
        auto_feather: !!((autoFeather || refine) && hasSelection), color_match: !!cs.colorMatch,
        width, height, has_selection: hasSelection,
    };
    return { x0, y0, cw, ch, ew, eh, resize: targetSize > 0, growUsed, featherUsed, fillMode, withOriginal, autoFeather, hasSelection, info };
}

/**
 * The pixels of a planned crop: the crop box of the composite (`region`, anything `drawImage` takes, at the box's size)
 * with the fill mode, scaled to the emitted size, the denoise mask at that size, the original as a reference when the
 * fill asks for one. Canvases of the thread it runs in.
 */
export function cropPixels(p, sel, region, { own = false } = {}) {
    const { x0, y0, cw, ch, ew, eh } = p;
    // `own`: the region is a canvas made for this crop (the stitch worker's) and becomes the crop itself
    let crop = own ? region : makeCanvas(cw, ch);
    if (!own) crop.getContext("2d").drawImage(region, 0, 0);
    const selCrop = cropMask(sel, x0, y0, cw, ch);
    let denoise_mask = p.autoFeather && p.hasSelection ? denoiseMask(selCrop, p.growUsed, p.featherUsed) : selCrop;
    const references = [];
    if (p.hasSelection && p.fillMode !== "none") {
        if (p.withOriginal) {
            const cropOrig = makeCanvas(cw, ch);
            cropOrig.getContext("2d").drawImage(crop, 0, 0);
            references.push(cropOrig);
        }
        const fillPx = Math.max(p.growUsed - Math.floor(p.featherUsed / 2), 0);
        crop = fillMasked(crop, dilate(selCrop, fillPx), p.fillMode);
    }
    if (p.resize) {
        crop = drawResized(crop, ew, eh);
        denoise_mask = resizeMask(denoise_mask, ew, eh);
        for (let i = 0; i < references.length; i++) references[i] = drawResized(references[i], ew, eh);
    }
    return { crop, mask: maskToCanvas(denoise_mask, { luminance: true }), maskAlpha: alphaMask(denoise_mask), references };
}

/**
 * The crop the model gets, exactly like the node's `run`: selection bbox plus context,
 * fill mode, scaling to target_size (both sides rounded to the multiple), the denoise
 * mask at the emitted size, references. `params` = { padding, target_size, feather,
 * multiple_of } (the app's node params).
 */
export function prepareCrop(editor, params, limits, opts = {}) {
    const sel = selectionWindow(editor);
    const p = planCrop(cropSettingsOf(editor, params, limits, opts.crop), sel);
    // E2: the crop box composited on its own (`readBox`: a region pass at full resolution, or the box cut out of the
    // whole flatten when no margin gives those pixels), never the whole image for a box of it
    const { crop, mask, maskAlpha, references } = cropPixels(p, sel, regionOf(editor, p.x0, p.y0, p.cw, p.ch));
    if (opts.references !== false) for (const l of editor.referenceLayers()) references.push(editor.layerPixels(l));
    return { crop, mask, maskAlpha, references, info: p.info, sel };
}

/** RGBA mask with alpha 0 where the model should repaint (OpenAI's convention). */
function alphaMask(m) {
    const c = makeCanvas(m.w, m.h);
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(m.w, m.h);
    const d = img.data;
    for (let i = 0, j = 0; i < m.data.length; i++, j += 4) { d[j] = 0; d[j + 1] = 0; d[j + 2] = 0; d[j + 3] = m.data[i] > 0.5 ? 0 : 255; }
    ctx.putImageData(img, 0, 0);
    return c;
}

// ---- stitch ---------------------------------------------------------------------------------

function blurMask(m, radius) { return radius > 0 ? gaussBlur(m, radius) : m; }

/** Weighted per-channel mean / std match of the patch to the reference (nodes.py _color_match). */
function colorMatch(patch, region, weight) {
    const w = patch.width, h = patch.height;
    let total = 0;
    for (let i = 0; i < weight.data.length; i++) total += Math.min(1, Math.max(0, weight.data[i]));
    if (total < 64) return patch;
    const pd = patch.getContext("2d").getImageData(0, 0, w, h);
    const rd = region.getContext("2d").getImageData(0, 0, w, h).data;
    const p = pd.data;
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
    pd.data.set(p);
    const out = makeCanvas(w, h);
    out.getContext("2d").putImageData(pd, 0, 0);
    return out;
}

/** Does the stitch read the composite of the region? Only for the colour match of an answer that is not a cut-out. */
export function finishNeedsRegion(info) {
    return !!(info.color_match && !info.keepAlpha);
}

/**
 * The model's answer back into the canvas: resize to the region (stretch when the
 * aspect matches the emitted size, else center-crop), the composite mask (selection
 * with soft edge, or the whole rectangle), colour match, and the RGBA patch the editor
 * adds as a result layer. `sel` is the full-size selection mask from prepareCrop; `region`
 * a 2D canvas of the box's composite when `finishNeedsRegion(info)`, else null.
 * `info.keepAlpha` (set by the caller for a run that asked the model for a transparent
 * background) keeps the answer's own alpha channel instead of replacing it with the composite mask.
 */
export function finishPixels(info, sel, resultImage, region) {
    const [x, y, w, h] = info.bbox;
    const width = info.width, height = info.height;
    const feather = info.feather | 0;
    const sw = resultImage.width || resultImage.naturalWidth, sh = resultImage.height || resultImage.naturalHeight;
    const emitted = info.emitted;
    const sameAspect = !!emitted && Math.abs(sw / sh - emitted[0] / emitted[1]) < 0.01;
    let patch = drawResized(resultImage, w, h, { crop: sameAspect ? "disabled" : "center" });

    // full-size composite mask, computed on a window around the region (the blur tails end there)
    const margin = Math.ceil(Math.max(feather, info.grow | 0, info.blend | 0) * 2 + 3 * Math.max(feather, info.blend | 0) / 2.5) + 8;
    const wx0 = Math.max(0, x - margin), wy0 = Math.max(0, y - margin);
    const wx1 = Math.min(width, x + w + margin), wy1 = Math.min(height, y + h + margin);
    const ww = wx1 - wx0, wh = wy1 - wy0;
    const selWin = cropMask(sel, wx0, wy0, ww, wh);
    let full;
    if (info.paste === "crop") {
        const rect = maskOf(ww, wh);
        for (let yy = y - wy0; yy < y - wy0 + h; yy++) rect.data.fill(1, yy * ww + (x - wx0), yy * ww + (x - wx0) + w);
        const f = Math.max(8, feather, info.blend | 0);
        full = blurMask(erode(rect, Math.floor(f / 2)), f / 2.5);
        for (let i = 0; i < full.data.length; i++) full.data[i] *= rect.data[i];
    } else if (info.auto_feather) {
        full = compositeMask(selWin, info.grow | 0, feather, info.blend | 0);
    } else {
        full = blurMask(selWin, feather);
    }
    const blend = cropMask(full, x - wx0, y - wy0, w, h);

    const align = { aligned: false, reason: "not available in the app" };
    // A cut-out (the model was asked for a transparent background) is never colour matched:
    // the statistics would read the transparent pixels' black, and the asset was never meant
    // to sit on the backdrop the region shows.
    if (finishNeedsRegion(info)) {
        const keep = maskOf(w, h);
        for (let i = 0; i < keep.data.length; i++) keep.data[i] = 1 - blend.data[i];
        patch = colorMatch(patch, region, keep);
    }

    // RGBA patch: the model's pixels with the blend mask as alpha. With `keepAlpha` the
    // model's own alpha is kept and the blend mask only multiplies it, so a clean cut-out
    // keeps its edges and a model that ignored the request still blends in as before.
    const pd = patch.getContext("2d").getImageData(0, 0, w, h);
    for (let i = 0, j = 3; i < w * h; i++, j += 4) {
        const a = Math.min(1, Math.max(0, blend.data[i]));
        pd.data[j] = Math.round(info.keepAlpha ? a * pd.data[j] : a * 255);
    }
    const out = makeCanvas(w, h);
    out.getContext("2d").putImageData(pd, 0, 0);
    return { patch: out, x, y, w, h, align };
}

/** The box of the composite a run sees as a 2D canvas of the box (a copy: `readBox` may hand out a GL pass canvas). */
function regionCanvas(editor, x, y, w, h) {
    const region = makeCanvas(w, h);
    region.getContext("2d").drawImage(regionOf(editor, x, y, w, h), 0, 0);
    return region;
}

/**
 * The provider's answer stitched into an RGBA patch for the region `info.bbox`. `info` is
 * what prepareCrop returned; `info.keepAlpha` (set by the caller for a run that asked the
 * model for a transparent background) keeps the answer's own alpha channel instead of
 * replacing it with the composite mask.
 */
export function finishResult(editor, info, sel, resultImage) {
    const [x, y, w, h] = info.bbox;
    return finishPixels(info, sel, resultImage, finishNeedsRegion(info) ? regionCanvas(editor, x, y, w, h) : null);
}

/**
 * Does this canvas carry real transparency? Sampled on a grid of at most 128 x 128 points,
 * which is enough to tell a cut-out from an opaque picture and costs nothing on a big one.
 * Used to say in the status line whether the model honoured a transparent background.
 */
export function transparentPixels(canvas, threshold = 250) {
    const w = canvas.width | 0, h = canvas.height | 0;
    if (!w || !h) return false;
    const stepX = Math.max(1, Math.floor(w / 128)), stepY = Math.max(1, Math.floor(h / 128));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    for (let y = 0; y < h; y += stepY) {
        const row = ctx.getImageData(0, y, w, 1).data;
        for (let x = 0; x < w; x += stepX) if (row[x * 4 + 3] < threshold) return true;
    }
    return false;
}

/** PNG bytes of a canvas (a <canvas> or an OffscreenCanvas). */
export async function canvasBytes(canvas) {
    const blob = typeof canvas.convertToBlob === "function" ? await canvas.convertToBlob({ type: "image/png" }) : await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
}

export function bytesToImage(bytes, mime = "image/png") {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("the provider's image could not be decoded")); };
        img.src = url;
    });
}

// ---- a run off the window ---------------------------------------------------------------------

/** Tests and A/B: false runs a provider run's crop and stitch on the window, as before (the synchronous pair). */
let STITCH_IN_WORKER = true;
export function setStitchInWorker(on) {
    const was = STITCH_IN_WORKER;
    STITCH_IN_WORKER = !!on;
    return was;
}

let WORKER = null, NEXT = 1;
const CALLS = new Map();

/** The stitch worker (stitch_worker.js), started on first use; null where there is none. */
function stitchWorker() {
    if (WORKER) return WORKER;
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return null;
    WORKER = new Worker(new URL("./stitch_worker.js", import.meta.url), { type: "module" });
    WORKER.onmessage = (e) => {
        const m = e.data || {};
        const c = CALLS.get(m.id);
        if (!c) return;
        CALLS.delete(m.id);
        if (m.ok) c.resolve(m); else c.reject(new Error(m.error || "the stitch worker failed"));
    };
    WORKER.onerror = (e) => {
        const err = new Error("the stitch worker failed: " + ((e && e.message) || "an error"));
        for (const c of CALLS.values()) c.reject(err);
        CALLS.clear();
        try { WORKER.terminate(); } catch (_) { /* ignore */ }
        WORKER = null;
    };
    return WORKER;
}

function stitchCall(op, args, transfer = []) {
    const w = stitchWorker();
    if (!w) return Promise.reject(new Error("no stitch worker here"));
    const id = NEXT++;
    return new Promise((resolve, reject) => {
        CALLS.set(id, { resolve, reject });
        w.postMessage({ id, op, kernels: kernelsMode(), ...args }, transfer);
    });
}

/** A plain buffer of `data` to move to the stitch worker instead of copying it (a SharedArrayBuffer is shared anyway). */
function transferable(data) {
    return data && data.buffer instanceof ArrayBuffer ? [data.buffer] : [];
}

/**
 * The box of the composite a run sees as RGBA bytes `{ data, width, height, how }`: the editor's own reader when it has
 * one, from the stack `held` earlier when given.
 */
async function regionBytes(editor, x, y, w, h, held = undefined) {
    if (typeof editor.readBoxBytes === "function") return editor.readBoxBytes([x, y, x + w, y + h], { forRun: true, held });
    const c = regionCanvas(editor, x, y, w, h);
    return { data: c.getContext("2d").getImageData(0, 0, w, h).data, width: w, height: h, how: "canvas" };
}

/**
 * `prepareCrop` for a run, without holding the window: the selection's window is read here and planned in the stitch
 * worker, the crop box is composited by the tile workers (`editor.readBoxBytes`), and the worker makes the crop, the
 * masks and their PNGs. `{ image, mask, maskAlpha, references, width, height, info, sel, how }`: PNG bytes, the emitted
 * size, `info` as `prepareCrop` gives it, `sel` for `finishResultAsync`, `how` the region's way (or "window" when it
 * ran as before). Falls back to `prepareCrop` on the window when the worker is not there or fails.
 */
export async function prepareCropAsync(editor, params, limits, opts = {}) {
    const settings = cropSettingsOf(editor, params, limits, opts.crop);
    const withRefs = opts.references !== false;
    if (STITCH_IN_WORKER && stitchWorker()) {
        // one moment, as the synchronous crop had it: the selection's window, the stack the box is composited from (its
        // clones are taken before `holdRunStack` returns) and the reference layers are read here, before any await
        let held = null, holding = null;
        try {
            const win = selectionWindowPixels(editor);
            holding = typeof editor.holdRunStack === "function" ? editor.holdRunStack({ forRun: true }) : null;
            const refs = withRefs ? editor.referenceLayers().map((l) => editor.layerPixels(l)) : [];
            const planned = await stitchCall("plan", { settings, sel: { data: win.img.data, width: win.img.width, height: win.img.height, ox: win.ox, oy: win.oy, fullW: win.fullW, fullH: win.fullH } }, [win.img.data.buffer]);
            held = holding ? await holding : null;
            const p = planned.plan;
            const region = await regionBytes(editor, p.x0, p.y0, p.cw, p.ch, holding ? held : undefined);
            const made = await stitchCall("crop", { plan: p, sel: planned.sel, region: { data: region.data, width: region.width, height: region.height } }, [planned.sel.data.buffer, ...transferable(region.data)]);
            const references = made.references.slice();
            for (const c of refs) references.push(await canvasBytes(c));
            return { image: made.image, mask: made.mask, maskAlpha: made.maskAlpha, references, width: p.ew, height: p.eh, info: p.info, sel: made.sel, how: region.how };
        } catch (err) {
            console.warn("Scumble: the crop in the stitch worker failed, cropping on the window:", (err && err.message) || err);
        } finally {
            // a stack still on its way when the crop failed is let go when it arrives
            if (held) held.release();
            else if (holding) holding.then((h) => { if (h) h.release(); }, () => {});
        }
    }
    const prep = prepareCrop(editor, params, limits, opts);
    const [image, mask, maskAlpha, ...references] = await Promise.all([canvasBytes(prep.crop), canvasBytes(prep.mask), canvasBytes(prep.maskAlpha), ...prep.references.map((c) => canvasBytes(c))]);
    return { image, mask, maskAlpha, references, width: prep.crop.width, height: prep.crop.height, info: prep.info, sel: prep.sel, how: "window" };
}

/**
 * `finishResult` for a run, without holding the window: the answer (`bytes`, `mime`) is decoded and stitched in the
 * stitch worker; the region's composite, read only for a colour match, comes from the tile workers.
 * `{ blob, cutout, x, y, w, h, align, how }`: the patch as a PNG, whether it carries real transparency
 * (`transparentPixels`). Falls back to `finishResult` on the window.
 */
export async function finishResultAsync(editor, info, selIn, bytes, mime = "image/png") {
    let sel = selIn;
    const [x, y, w, h] = info.bbox;
    if (STITCH_IN_WORKER && stitchWorker()) {
        try {
            const region = finishNeedsRegion(info) ? await regionBytes(editor, x, y, w, h) : null;
            const answer = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
            // the window mask goes to the worker and comes back with the answer (no copy of a large selection here)
            const r = await stitchCall("finish", { info, sel, answer, mime, region: region ? { data: region.data, width: region.width, height: region.height } : null }, [answer.buffer, sel.data.buffer, ...(region ? transferable(region.data) : [])]);
            if (r.sel) sel.data = r.sel.data;
            return { blob: new Blob([r.png], { type: "image/png" }), cutout: r.cutout, x, y, w, h, align: r.align, how: region ? region.how : "none" };
        } catch (err) {
            console.warn("Scumble: the stitch in the stitch worker failed, stitching on the window:", (err && err.message) || err);
        }
        // the mask went to the worker that failed: the selection's window as it is now
        if (!sel.data || sel.data.length !== sel.w * sel.h) sel = selectionWindow(editor);
    }
    const img = await bytesToImage(bytes, mime);
    const fin = finishResult(editor, info, sel, img);
    const blob = await new Promise((resolve) => fin.patch.toBlob(resolve, "image/png"));
    return { blob, cutout: transparentPixels(fin.patch), x, y, w, h, align: fin.align, how: "window" };
}

/** The stitch worker's side (stitch_worker.js): the jobs, over this module's own steps. */
export async function stitchJob(msg) {
    const bytesOf = async (c) => canvasBytes(c);
    const canvasFrom = (r) => {
        const c = makeCanvas(r.width, r.height), ctx = c.getContext("2d");
        const shared = typeof SharedArrayBuffer !== "undefined" && r.data.buffer instanceof SharedArrayBuffer;
        if (!shared && r.data instanceof Uint8ClampedArray) { ctx.putImageData(new ImageData(r.data, r.width, r.height), 0, 0); return c; }
        // a view on a SharedArrayBuffer (the tile workers' box) makes no ImageData: copied a band of rows at a time
        const rows = Math.max(1, Math.floor((4 << 20) / (r.width * 4)));
        for (let y = 0; y < r.height; y += rows) {
            const n = Math.min(rows, r.height - y);
            ctx.putImageData(new ImageData(new Uint8ClampedArray(r.data.subarray(y * r.width * 4, (y + n) * r.width * 4)), r.width, n), 0, y);
        }
        return c;
    };
    const selOf = (s) => ({ data: s.data, w: s.w, h: s.h, ox: s.ox, oy: s.oy, fullW: s.fullW, fullH: s.fullH });
    if (msg.op === "plan") {
        const s = msg.sel;
        const sel = windowMask({ img: { data: s.data, width: s.width, height: s.height }, ox: s.ox, oy: s.oy, fullW: s.fullW, fullH: s.fullH });
        const plan = planCrop(msg.settings, sel);
        return { plan, sel: selOf(sel), transfer: [sel.data.buffer] };
    }
    if (msg.op === "crop") {
        const sel = selOf(msg.sel);
        const out = cropPixels(msg.plan, sel, canvasFrom(msg.region), { own: true });
        const [image, mask, maskAlpha, ...references] = await Promise.all([bytesOf(out.crop), bytesOf(out.mask), bytesOf(out.maskAlpha), ...out.references.map(bytesOf)]);
        return { image, mask, maskAlpha, references, sel, transfer: [image.buffer, mask.buffer, maskAlpha.buffer, ...references.map((r) => r.buffer), sel.data.buffer] };
    }
    if (msg.op === "finish") {
        const bmp = await createImageBitmap(new Blob([msg.answer], { type: msg.mime || "image/png" }));
        try {
            const fin = finishPixels(msg.info, selOf(msg.sel), bmp, msg.region ? canvasFrom(msg.region) : null);
            const png = await bytesOf(fin.patch);
            const sel = selOf(msg.sel);
            return { png, cutout: transparentPixels(fin.patch), align: fin.align, sel, transfer: [png.buffer, sel.data.buffer] };
        } finally { bmp.close(); }
    }
    throw new Error("unknown stitch job " + msg.op);
}
