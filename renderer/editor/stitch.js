// Crop and stitch in the app, for recipes that render through an API provider instead
// of the user's ComfyUI. A port of the InpaintCanvas / InpaintCanvasStitch maths in the
// node's nodes.py (same formulas, same order), on Canvas 2D and typed arrays:
//
//   prepareCrop(editor, params)  -> { crop, mask, maskAlpha, references, info }
//   finishResult(editor, info, resultImage) -> { patch (RGBA canvas), x, y, w, h, align }
//
// Differences from the node: resizing is the browser's bilinear/bicubic instead of
// Lanczos, the gaussian blur is a triple box blur, the "border" fill mode has no
// Navier-Stokes inpainting (it behaves like "blur"), and the ECC alignment of the
// result to its surroundings is not implemented (reported as not aligned).

const MIN_AUTO_CROP = 512;

function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0);
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
    const d = canvas.getContext("2d").getImageData(x0, y0, w, h).data;
    const m = maskOf(w, h);
    for (let i = 0, j = 3; i < w * h; i++, j += 4) m.data[i] = d[j] / 255;
    return m;
}

function maskMax(a, b) { const o = maskOf(a.w, a.h); for (let i = 0; i < o.data.length; i++) o.data[i] = Math.max(a.data[i], b.data[i]); return o; }
function maskClamp(m) { for (let i = 0; i < m.data.length; i++) m.data[i] = Math.min(1, Math.max(0, m.data[i])); return m; }

/** Square dilation by px (max filter, separable). */
function dilate(m, px) {
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

function erode(m, px) {
    if (px <= 0) return m;
    const inv = maskOf(m.w, m.h);
    for (let i = 0; i < inv.data.length; i++) inv.data[i] = 1 - m.data[i];
    const d = dilate(inv, px);
    for (let i = 0; i < d.data.length; i++) d.data[i] = 1 - d.data[i];
    return d;
}

/** One box blur pass of radius r along rows (clamped edges), in place via a temp. */
function boxRow(src, dst, w, h, r) {
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

function boxCol(src, dst, w, h, r) {
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
    let a = Float32Array.from(m.data), b = new Float32Array(w * h);
    for (const r of radii) {
        if (r <= 0) continue;
        boxRow(a, b, w, h, r);
        boxCol(b, a, w, h, r);
    }
    return { data: a, w, h };
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

function cropMask(m, x0, y0, w, h) {
    const o = maskOf(w, h);
    for (let y = 0; y < h; y++) o.data.set(m.data.subarray((y0 + y) * m.w + x0, (y0 + y) * m.w + x0 + w), y * w);
    return o;
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
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            if (m.data[row + x] > 0.5) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
    }
    if (x1 < 0) return { has: false, x0: 0, y0: 0, x1: w, y1: h };
    return { has: true, x0: Math.max(0, x0 - padding), y0: Math.max(0, y0 - padding), x1: Math.min(w, x1 + 1 + padding), y1: Math.min(h, y1 + 1 + padding) };
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
 * The crop the model gets, exactly like the node's `run`: selection bbox plus context,
 * fill mode, scaling to target_size (both sides rounded to the multiple), the denoise
 * mask at the emitted size, references. `params` = { padding, target_size, feather,
 * multiple_of } (the app's node params).
 */
export function prepareCrop(editor, params) {
    const width = editor.width, height = editor.height;
    const gen = editor.genSettings || {};
    const mode = gen.mode === "local" ? "local" : "api";
    const denoise = Math.min(1, Math.max(0, +gen.denoise || 0));
    const refine = !!gen.refine && mode === "local";
    const strength = mode === "local" ? denoise : 1;
    const cs = editor.cropSettings || {};
    const autoContext = cs.context === "auto";
    const autoFeather = cs.feather === "auto";
    let fillMode = cs.fill || "none";
    const withOriginal = !!cs.withOriginal;
    const m = Math.max(1, Math.round(+params.multiple_of || 64));
    const targetSize = Math.max(0, Math.round(+params.target_size || 0));

    const base = editor.flattenToCanvas({ forRun: true });
    const sel = maskFromCanvasAlpha(editor.selection, 0, 0, width, height);
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
    if (targetSize <= 0) {
        [x0, x1] = fitSpanToMultiple(x0, x1, width, m);
        [y0, y1] = fitSpanToMultiple(y0, y1, height, m);
    }
    const cw = x1 - x0, ch = y1 - y0;

    let crop = makeCanvas(cw, ch);
    crop.getContext("2d").drawImage(base, x0, y0, cw, ch, 0, 0, cw, ch);
    const cropOrig = makeCanvas(cw, ch);
    cropOrig.getContext("2d").drawImage(crop, 0, 0);
    const selCrop = cropMask(sel, x0, y0, cw, ch);
    let denoise_mask = autoFeather && hasSelection ? denoiseMask(selCrop, growUsed, featherUsed) : selCrop;
    const references = [];
    if (hasSelection && fillMode !== "none") {
        const fillPx = Math.max(growUsed - Math.floor(featherUsed / 2), 0);
        crop = fillMasked(crop, dilate(selCrop, fillPx), fillMode);
        if (withOriginal) references.push(cropOrig);
    }

    let ew = cw, eh = ch;
    if (targetSize > 0) {
        const scale = targetSize / Math.max(cw, ch);
        ew = Math.max(m, Math.round(cw * scale / m) * m);
        eh = Math.max(m, Math.round(ch * scale / m) * m);
        crop = drawResized(crop, ew, eh);
        denoise_mask = resizeMask(denoise_mask, ew, eh);
        for (let i = 0; i < references.length; i++) references[i] = drawResized(references[i], ew, eh);
    }
    for (const l of editor.referenceLayers()) references.push(editor.layerPixels(l));

    const info = {
        base: editor.base && editor.base.ref, bbox: [x0, y0, cw, ch], emitted: [ew, eh],
        align: cs.align !== false, paste: cs.paste === "crop" ? "crop" : "selection",
        feather: featherUsed, grow: growUsed, blend: blendUsed,
        auto_feather: !!((autoFeather || refine) && hasSelection), color_match: !!cs.colorMatch,
        width, height, has_selection: hasSelection,
    };
    return { crop, mask: maskToCanvas(denoise_mask, { luminance: true }), maskAlpha: alphaMask(denoise_mask), references, info, sel };
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

/**
 * The model's answer back into the canvas: resize to the region (stretch when the
 * aspect matches the emitted size, else center-crop), the composite mask (selection
 * with soft edge, or the whole rectangle), colour match, and the RGBA patch the editor
 * adds as a result layer. `sel` is the full-size selection mask from prepareCrop.
 */
export function finishResult(editor, info, sel, resultImage) {
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

    const region = makeCanvas(w, h);
    region.getContext("2d").drawImage(editor.flattenToCanvas({ forRun: true }), x, y, w, h, 0, 0, w, h);
    const align = { aligned: false, reason: "not available in the app" };
    if (info.color_match) {
        const keep = maskOf(w, h);
        for (let i = 0; i < keep.data.length; i++) keep.data[i] = 1 - blend.data[i];
        patch = colorMatch(patch, region, keep);
    }

    // RGBA patch: the model's pixels with the blend mask as alpha
    const pd = patch.getContext("2d").getImageData(0, 0, w, h);
    for (let i = 0, j = 3; i < w * h; i++, j += 4) pd.data[j] = Math.round(Math.min(1, Math.max(0, blend.data[i])) * 255);
    const out = makeCanvas(w, h);
    out.getContext("2d").putImageData(pd, 0, 0);
    return { patch: out, x, y, w, h, align };
}

/** PNG bytes of a canvas. */
export async function canvasBytes(canvas) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
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
