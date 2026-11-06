// Key green / blue screen (item 49, docs/PLAN_CORRIDORKEY.md §4.5-4.8): the pure half of the feature. App-only: not in
// tools/build_node.py FILES (as realism.js and comfyprompt.js), imported by renderer/editor/host.js, by the Key dialog
// (renderer/keydialog.js) and by the app-only worker renderer/editor/keyworker.js. No canvas, no DOM, no window:
// tools/keying_test.js runs every function here under plain Node.
//
//   the box        boxPlan: the selection's bounds grown by context and to the nearest bucket's aspect, or the whole
//                  picture; the bucket the engine keys at (its long side is the working size) and where the picture
//                  sits in it (padRect: reflect-101 only for what the picture's edge leaves short)
//   the screen     screenFromRing: green or blue from the box's border ring, outside the hint
//   the matte      matteBox (the layer is trimmed to it), bilinearRows (the bucket's float alpha and sRGB foreground
//                  back to the box in bands, in floats, never through a canvas)
//   the loop       KeyQueue: one engine run in flight, one pending, the newest hint replacing the pending one, tickets
//   the texts      the readiness sentences of §4.8 and the status line of §4.5 step 6
//   the refine     refineOp: a scaled matte's alpha refined against the full-resolution picture (keymatte.js, I6), the
//                  steps keyworker.js and RowsClient's in-thread path run alike

import { prepareRefine, noteSample, refineBand } from "./keymatte.js";

/** The feature's name in the menu, the dialog, the status line and the undo history. */
export const LABEL = "Key screen";
/** The new layer's name (§4.5 step 5). */
export const LAYER_NAME = "Key";
/** The mid-grey Fill layer under a key of the base (the user's answer 4, 2026-10-24). */
export const GREY = "#808080";
export const GREY_NAME = "Grey";
/** The engine's name where a text is about running it. */
export const ENGINE = "CorridorKey 2.0";

/** The hint's trust (CK2's hint_quality), the dialog's Hint row: §4.6. */
export const TRUSTS = Object.freeze([
    { id: "rough", label: "Rough", value: 0.5 },
    { id: "automatic", label: "Automatic", value: 0.75 },
    { id: "clean", label: "Clean", value: 0.95 },
]);
export const SCREENS = Object.freeze(["auto", "green", "blue"]);
export const HINTS = Object.freeze(["selection", "mask", "none"]);

/** The working sizes a set may offer (the long side of the live bucket); Stop A picks 1,024 or 768 (§4.7 point 2). */
export const WORKING_SIZES = Object.freeze([512, 768, 1024, 1536, 2048]);

/**
 * settings.key (electron/main/settings.js DEFAULTS.key, §4.8). `workingSize` is Stop A's bucket; the engine's own list
 * (keyEngine.status().workingSizes) narrows what the dialog offers.
 */
export const keyDefaults = Object.freeze({ screen: "auto", trust: 0.5, despill: 0.5, preview: true, workingSize: 1024, greyUnderBase: true, timeout: 300 });

/** settings.key filled per key from the defaults (settings.get() merges only the top level, as realism.fillValues). */
export function fillValues(stored) {
    const s = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
    const d = keyDefaults;
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
    const trust = num(s.trust), despill = num(s.despill), timeout = num(s.timeout), ws = num(s.workingSize);
    return {
        screen: SCREENS.includes(s.screen) ? s.screen : d.screen,
        trust: TRUSTS.some((t) => t.value === trust) ? trust : d.trust,
        despill: despill >= 0 && despill <= 1 ? despill : d.despill,
        preview: typeof s.preview === "boolean" ? s.preview : d.preview,
        workingSize: WORKING_SIZES.includes(ws) ? ws : d.workingSize,
        greyUnderBase: typeof s.greyUnderBase === "boolean" ? s.greyUnderBase : d.greyUnderBase,
        timeout: timeout >= 30 && timeout <= 3600 ? timeout : d.timeout,
    };
}

/** The trust row's entry for a value (the nearest of the three), or the default's. */
export function trustOf(v) {
    const n = +v;
    if (!Number.isFinite(n)) return TRUSTS[0];
    let best = TRUSTS[0];
    for (const t of TRUSTS) if (Math.abs(t.value - n) < Math.abs(best.value - n)) best = t;
    return best;
}

// ---- the box and the bucket -----------------------------------------------------------------------------------------

/**
 * The buckets at a working size: `long` on one side, the other side every multiple of 128 from half of it (at least
 * 256) up to `long`, both ways round. Upstream pads to a multiple of 128; a set's own list (its manifest, the buckets
 * at every size it holds) replaces this one where it has buckets of that long side (bucketsAt).
 * -> [{ w, h }], the square first
 */
export function bucketsFor(long) {
    const L = Math.max(128, Math.round(+long || 1024));
    const out = [{ w: L, h: L }];
    const lo = Math.max(256, Math.ceil(L / 2 / 128) * 128);
    for (let s = L - 128; s >= lo; s -= 128) { out.push({ w: L, h: s }); out.push({ w: s, h: L }); }
    return out;
}

/**
 * The buckets a key at `workingSize` picks from (§4.7 point 2: the nearest aspect among those whose long side is the
 * working size): the set's own list (`buckets`, every size it holds) narrowed to that long side, else bucketsFor.
 */
export function bucketsAt(workingSize, buckets = null) {
    const L = Math.round(+workingSize || 1024);
    const own = Array.isArray(buckets) ? buckets.filter((b) => b && Math.max(+b.w, +b.h) === L).map((b) => ({ w: +b.w, h: +b.h })) : [];
    return own.length ? own : bucketsFor(L);
}

/** The bucket of `list` whose aspect is nearest w / h (in log space; the first of equals). */
export function nearestBucket(w, h, list) {
    const a = Math.log(Math.max(1e-9, w) / Math.max(1e-9, h));
    let best = list[0], bd = Infinity;
    for (const b of list) {
        const d = Math.abs(Math.log(b.w / b.h) - a);
        if (d < bd - 1e-12) { bd = d; best = b; }
    }
    return best;
}

/**
 * The box the engine keys and the bucket it keys it at (§4.7 points 1-2). `sel` ([x0, y0, x1, y1], the selection's
 * bounds in image pixels, or null): its bounds grown by half its longer side (the longer side times 1.5), at least
 * `minSide` a side, then grown to the nearest bucket's aspect (more picture around it, as Generate's crop plan
 * does), centred on the selection and moved inside the picture, cut to it along a side the picture is shorter than.
 * Without a selection: the whole picture, or `within` (a layer's own rect) cut to it (`layerBox`). The box is read into the
 * bucket at one scale (`sx`, `sy` within a rounding of each other) at its top left (`content`); what the picture's edge
 * leaves short of the bucket is padding (`padded`), filled by reflect-101 (padRect), never a mirrored stretch of picture
 * to fill an aspect. `buckets`: the set's own, at every size it holds (bucketsAt narrows them to the working size).
 * -> { box: [x0, y0, x1, y1], bucket: { w, h }, content: [0, 0, cw, ch], sx, sy, padded, whole, layerBox }
 */
export function boxPlan(W, H, sel, { workingSize = 1024, buckets = null, minSide = null, within = null } = {}) {
    W = Math.max(1, Math.round(W)); H = Math.max(1, Math.round(H));
    const list = bucketsAt(workingSize, buckets);
    const min = minSide == null ? Math.min(768, Math.max(...list.map((b) => Math.max(b.w, b.h)))) : minSide;
    let box;
    const s0 = sel && sel[2] > sel[0] && sel[3] > sel[1] ? sel.map((v) => +v) : null;
    if (!s0) box = within ? [Math.max(0, Math.floor(within[0])), Math.max(0, Math.floor(within[1])), Math.min(W, Math.ceil(within[2])), Math.min(H, Math.ceil(within[3]))] : [0, 0, W, H];
    else {
        const w0 = s0[2] - s0[0], h0 = s0[3] - s0[1];
        const grow = Math.max(w0, h0) * 0.5;
        let gw = Math.max(w0 + grow, min), gh = Math.max(h0 + grow, min);
        const b = nearestBucket(gw, gh, list);
        if (gw / gh < b.w / b.h) gw = gh * (b.w / b.h); else gh = gw * (b.h / b.w);
        const place = (c, side, n) => {
            const s = Math.min(n, Math.ceil(side - 1e-9));
            const lo = Math.max(0, Math.min(n - s, Math.round(c - s / 2)));
            return [lo, lo + s];
        };
        const [x0, x1] = place((s0[0] + s0[2]) / 2, gw, W), [y0, y1] = place((s0[1] + s0[3]) / 2, gh, H);
        box = [x0, y0, x1, y1];
    }
    const bw = box[2] - box[0], bh = box[3] - box[1];
    const bucket = nearestBucket(bw, bh, list);
    const s = Math.min(bucket.w / bw, bucket.h / bh);
    let cw = Math.max(1, Math.min(bucket.w, Math.round(bw * s))), ch = Math.max(1, Math.min(bucket.h, Math.round(bh * s)));
    // a box grown to the bucket's aspect lands a pixel or two short of it by rounding: the content fills the bucket then
    // (sx and sy differ by that rounding), and only a box the picture's edge cut is padded
    if (bucket.w - cw <= 2) cw = bucket.w;
    if (bucket.h - ch <= 2) ch = bucket.h;
    return { box, bucket: { w: bucket.w, h: bucket.h }, content: [0, 0, cw, ch], sx: cw / bw, sy: ch / bh, padded: cw < bucket.w || ch < bucket.h, whole: !s0 && !within, layerBox: !s0 && !!within };
}

/** reflect-101 of an index into [0, n): ... 2 1 | 0 1 2 ... n-1 | n-2 n-3 ... */
export function reflect101(i, n) {
    if (n <= 1) return 0;
    const p = 2 * (n - 1);
    i = ((i % p) + p) % p;
    return i < n ? i : p - i;
}

/**
 * `src` (cw × ch, `channels` per pixel) at the top left of a bucket of bw × bh, the rest reflect-101 of it (upstream's
 * pad, for what the picture's edge leaves short, §4.7 point 2). The same array when nothing is short.
 */
export function padRect(src, cw, ch, bw, bh, channels) {
    if (cw === bw && ch === bh) return src;
    const C = channels;
    const out = new (/** @type {any} */ (src.constructor))(bw * bh * C);
    for (let y = 0; y < bh; y++) {
        const sy = reflect101(y, ch);
        for (let x = 0; x < bw; x++) {
            const sxi = reflect101(x, cw);
            const si = (sy * cw + sxi) * C, di = (y * bw + x) * C;
            for (let c = 0; c < C; c++) out[di + c] = src[si + c];
        }
    }
    return out;
}

/** An RGBA picture's alpha channel as a plane (a hint drawn into a canvas: the selection's coverage in alpha). */
export function alphaPlane(rgba, n) {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = rgba[i * 4 + 3];
    return out;
}

/**
 * An RGBA picture (n pixels) over a flat colour `rgb`, opaque: a layer read with its transparent parts, put on the
 * screen's colour (the "over" a canvas fill under it gives, in straight alpha).
 */
export function overColour(rgba, n, rgb) {
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
        const o = i * 4, a = rgba[o + 3] / 255, b = 1 - a;
        out[o] = Math.round(rgba[o] * a + rgb[0] * b);
        out[o + 1] = Math.round(rgba[o + 1] * a + rgb[1] * b);
        out[o + 2] = Math.round(rgba[o + 2] * a + rgb[2] * b);
        out[o + 3] = 255;
    }
    return out;
}

/** The fill a layer source's transparent parts are read on: the screen's colour (#00b140 green, #0047bb blue). */
export const SCREEN_FILL = Object.freeze({ green: Object.freeze([0, 177, 64]), blue: Object.freeze([0, 71, 187]) });

/** Whether a hint plane holds anything (a selection outside the box sends none). */
export function planeAny(p) {
    if (!p) return false;
    for (let i = 0; i < p.length; i++) if (p[i]) return true;
    return false;
}

// ---- the screen -----------------------------------------------------------------------------------------------------

/**
 * Green or blue from the mean colour of the content's border ring (§4.8 "Screen Auto"), taken outside the hint where
 * there is one (a hint level of 128 or more is the subject): "green" when green leads both other channels by 24
 * levels, "blue" when blue does, else null (the dialog asks instead of guessing). `weight` (a plane at the bucket,
 * 0..255): each pixel counts by it, so a layer source's transparent parts (read on a fill) do not decide the screen.
 * -> { screen: "green" | "blue" | null, mean: [r, g, b], n }
 */
export function screenFromRing(rgba, bw, bh, content, hint = null, weight = null) {
    const [cx0, cy0, cx1, cy1] = content;
    const cw = cx1 - cx0, ch = cy1 - cy0;
    const r = Math.max(2, Math.round(Math.min(cw, ch) * 0.03));
    let R = 0, G = 0, B = 0, n = 0;
    const take = (x, y) => {
        const i = y * bw + x;
        if (hint && hint[i] >= 128) return;
        const k = weight ? weight[i] / 255 : 1;
        if (!k) return;
        R += rgba[i * 4] * k; G += rgba[i * 4 + 1] * k; B += rgba[i * 4 + 2] * k; n += k;
    };
    for (let y = cy0; y < cy1; y++) {
        const edgeRow = y < cy0 + r || y >= cy1 - r;
        for (let x = cx0; x < cx1; x++) if (edgeRow || x < cx0 + r || x >= cx1 - r) take(x, y);
    }
    if (n < 1) return { screen: null, mean: [0, 0, 0], n: 0 };
    const mean = [R / n, G / n, B / n];
    const lead = 24;
    const screen = mean[1] > mean[0] + lead && mean[1] > mean[2] + lead ? "green"
        : mean[2] > mean[0] + lead && mean[2] > mean[1] + lead ? "blue" : null;
    return { screen, mean: mean.map((v) => Math.round(v)), n: Math.round(n) };
}

// ---- the matte back to the box --------------------------------------------------------------------------------------

/** An engine's alpha as floats in [0, 1] (a Uint16Array is read as 0..65535, a Uint8Array as 0..255). */
export function alphaFloats(a) {
    if (a instanceof Float32Array) return a;
    const k = a instanceof Uint16Array ? 1 / 65535 : a instanceof Uint8Array || a instanceof Uint8ClampedArray ? 1 / 255 : 1;
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] * k;
    return out;
}

/** The u8 level of an alpha value: rounded, clamped (one rule for the mask, the preview and the tests). */
export const toLevel = (a) => (a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255));

/**
 * The matte's box in image pixels (§4.5 step 1): the bucket alpha's bounding box inside `content` where it rounds to a
 * level above 0, grown by one bucket pixel, taken to the box, grown by 2 px, clamped to the box. Null when nothing is
 * kept.
 */
export function matteBox(alpha, bw, bh, content, box) {
    const [cx0, cy0, cx1, cy1] = content;
    let ux0 = Infinity, uy0 = Infinity, ux1 = -Infinity, uy1 = -Infinity;
    const t = 0.5 / 255;
    for (let y = cy0; y < cy1; y++) {
        const row = y * bw;
        for (let x = cx0; x < cx1; x++) {
            if (alpha[row + x] > t) {
                if (x < ux0) ux0 = x;
                if (x > ux1) ux1 = x;
                if (y < uy0) uy0 = y;
                if (y > uy1) uy1 = y;
            }
        }
    }
    if (!Number.isFinite(ux0)) return null;
    const sx = (cx1 - cx0) / (box[2] - box[0]), sy = (cy1 - cy0) / (box[3] - box[1]);
    const X = (u) => box[0] + (u - cx0) / sx, Y = (v) => box[1] + (v - cy0) / sy;
    const x0 = Math.max(box[0], Math.floor(X(ux0 - 1)) - 2), y0 = Math.max(box[1], Math.floor(Y(uy0 - 1)) - 2);
    const x1 = Math.min(box[2], Math.ceil(X(ux1 + 2)) + 2), y1 = Math.min(box[3], Math.ceil(Y(uy1 + 2)) + 2);
    return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

/**
 * The sampling map from a layer at `mbox` (image pixels, the matte's box) into the bucket: a layer pixel (X, Y) samples
 * the bucket at u = X·sx + u0, v = Y·sy + v0 (pixel centres: the layer pixel's centre in image space, mapped by the
 * box's scale into the content), clamped to `content`. At a scale of 1 and whole offsets every sample is a bucket
 * pixel exactly.
 */
export function sampleMap(mbox, box, content) {
    const [cx0, cy0, cx1, cy1] = content;
    const sx = (cx1 - cx0) / (box[2] - box[0]), sy = (cy1 - cy0) / (box[3] - box[1]);
    return { sx, sy, u0: (mbox[0] + 0.5 - box[0]) * sx + cx0 - 0.5, v0: (mbox[1] + 0.5 - box[1]) * sy + cy0 - 0.5, cx0, cy0, cx1, cy1 };
}

/**
 * Whether a plan's matte is keyed smaller (or larger) than its box: the content's size in the bucket differs from the
 * box's at full resolution. Then the landing refines the alpha against the picture (I6); at a scale of 1 the bilinear
 * rows are the bucket's pixels exactly.
 */
export function isScaled(plan) {
    const [cx0, cy0, cx1, cy1] = plan.content;
    return cx1 - cx0 !== plan.box[2] - plan.box[0] || cy1 - cy0 !== plan.box[3] - plan.box[1];
}

/**
 * Rows y0 .. y0 + rows of a layer outW wide, sampled bilinearly from the bucket (`alpha` floats, `fg` RGB bytes, bw
 * wide) by `map` (sampleMap): the alpha as u8 levels (`a`, outW × rows) and the foreground as opaque RGBA (`rgba`).
 * Either array may be left out (null).
 */
export function bilinearRows(alpha, fg, bw, map, outW, y0, rows) {
    const a = alpha ? new Uint8Array(outW * rows) : null;
    const rgba = fg ? new Uint8ClampedArray(outW * rows * 4) : null;
    const { sx, sy, u0, v0, cx0, cy0, cx1, cy1 } = map;
    const ux = new Int32Array(outW * 2), uw = new Float64Array(outW);
    for (let X = 0; X < outW; X++) {
        const u = Math.min(cx1 - 1, Math.max(cx0, X * sx + u0));
        const i = Math.min(cx1 - 1, Math.floor(u));
        ux[X * 2] = i; ux[X * 2 + 1] = Math.min(cx1 - 1, i + 1); uw[X] = u - i;
    }
    for (let r = 0; r < rows; r++) {
        const v = Math.min(cy1 - 1, Math.max(cy0, (y0 + r) * sy + v0));
        const j = Math.min(cy1 - 1, Math.floor(v)), j1 = Math.min(cy1 - 1, j + 1), tv = v - j;
        const r0 = j * bw, r1 = j1 * bw;
        for (let X = 0; X < outW; X++) {
            const i = ux[X * 2], i1 = ux[X * 2 + 1], tu = uw[X];
            const w00 = (1 - tu) * (1 - tv), w10 = tu * (1 - tv), w01 = (1 - tu) * tv, w11 = tu * tv;
            const o = r * outW + X;
            if (a) a[o] = toLevel(alpha[r0 + i] * w00 + alpha[r0 + i1] * w10 + alpha[r1 + i] * w01 + alpha[r1 + i1] * w11);
            if (rgba) {
                const p00 = (r0 + i) * 3, p10 = (r0 + i1) * 3, p01 = (r1 + i) * 3, p11 = (r1 + i1) * 3;
                for (let c = 0; c < 3; c++) rgba[o * 4 + c] = Math.round(fg[p00 + c] * w00 + fg[p10 + c] * w10 + fg[p01 + c] * w01 + fg[p11 + c] * w11);
                rgba[o * 4 + 3] = 255;
            }
        }
    }
    return { a, rgba };
}

/**
 * The window's side of keyworker.js: the matte kept under an id, then rows of it band by band. Off the window's thread
 * where a module worker starts; in the thread where none does (plain Node, a worker that failed to load), with the same
 * function, so the bytes are the same either way. `make` builds the worker (null: none).
 */
export class RowsClient {
    constructor(make = defaultKeyWorker) {
        this._make = make;
        this._w = undefined;
        this._calls = new Map();
        this._seq = 0;
        this._local = new Map();
        this.inThread = false;      // the last rows came from the window's thread (tests)
    }

    _worker() {
        if (this._w !== undefined) return this._w;
        let w = null;
        try { w = this._make ? this._make() : null; } catch (err) { console.warn("the key worker did not start", err); w = null; }
        if (w) {
            w.onmessage = (e) => {
                const m = e.data || {};
                const c = this._calls.get(m.id);
                if (!c) return;
                this._calls.delete(m.id);
                if (m.ok) c.resolve(m); else c.reject(new Error(m.error || "the key worker failed"));
            };
            w.onerror = (e) => {
                const err = Object.assign(new Error("the key worker failed: " + ((e && e.message) || "an error")), { workerDown: true });
                for (const c of this._calls.values()) c.reject(err);
                this._calls.clear();
                try { w.terminate(); } catch (_) { /* gone */ }
                this._w = null;
            };
        }
        this._w = w;
        return w;
    }

    _post(msg, transfer) {
        const w = this._worker();
        if (!w) return Promise.reject(Object.assign(new Error("no key worker"), { workerDown: true }));
        const id = ++this._seq;
        return new Promise((resolve, reject) => { this._calls.set(id, { resolve, reject }); w.postMessage({ ...msg, id }, transfer || []); });
    }

    /** Keep a matte (floats and RGB bytes at the bucket) under `mid`. */
    async matte(mid, alpha, fg, bw, bh) {
        this._local.set(mid, { alpha, fg, bw, bh });
        try { await this._post({ op: "matte", mid, alpha, fg, bw, bh }); } catch (err) { if (!err.workerDown) throw err; }
    }

    /** Rows y0 .. y0 + rows of a layer outW wide by `map` -> { a, rgba } (either null when not asked). */
    async rows(mid, map, outW, y0, rows, { alpha = true, fg = true } = {}) {
        try {
            const m = await this._post({ op: "rows", mid, map, outW, y0, rows, alpha, fg });
            this.inThread = false;
            return { a: m.a || null, rgba: m.rgba || null };
        } catch (err) {
            if (!err.workerDown) throw err;
            const t = this._local.get(mid);
            if (!t) throw new Error("no matte " + mid);
            this.inThread = true;
            return bilinearRows(alpha ? t.alpha : null, fg ? t.fg : null, t.bw, map, outW, y0, rows);
        }
    }

    /**
     * The refine of the matte kept under `mid` (I6, keymatte.js; refine_notes.md "What the integration has to do"):
     * `refine(mid, opts)` once (opts: prepareRefine's `small`, `src`, `full`, `out`; the alpha and its size are the
     * kept matte's) -> { halo, sample, soft, residual, fitMs, method }; `refineSample(mid, rgba)` once, the rows
     * `sample` of the matte's box at full resolution -> { noise, guideDiff, fallback }; then `refineBand(mid, band,
     * rgba)` per band of keymatte.bandPlan -> { a } (u8 rows). Off the window's thread where the worker runs, else here
     * with the same functions; a worker lost between the steps is caught up here from what was sent (the same bytes).
     */
    refine(mid, opts) { return this._refineStep(mid, { op: "refine", opts }); }
    refineSample(mid, rgba) { return this._refineStep(mid, { op: "refineSample", rgba }); }
    refineBand(mid, band, rgba) { return this._refineStep(mid, { op: "refineBand", band, rgba }); }

    async _refineStep(mid, msg) {
        const t = this._local.get(mid);
        if (t) {
            // what the in-thread path needs to catch up (a copy: the sample is small and posted, never transferred)
            if (msg.op === "refine") { t.refineOpts = msg.opts; t.refine = null; t.sampleRgba = null; }
            else if (msg.op === "refineSample") t.sampleRgba = msg.rgba;
        }
        try {
            const m = await this._post({ ...msg, mid });
            this.inThread = false;
            return m;
        } catch (err) {
            if (!err.workerDown) throw err;
            if (!t) throw new Error("no matte " + mid);
            this.inThread = true;
            if (!t.refine && msg.op !== "refine" && t.refineOpts) {
                refineOp(t, { op: "refine", opts: t.refineOpts });
                if (msg.op === "refineBand" && t.sampleRgba) refineOp(t, { op: "refineSample", rgba: t.sampleRgba });
            }
            return refineOp(t, msg).answer;
        }
    }

    drop(mid) {
        this._local.delete(mid);
        this._post({ op: "drop", mid }).catch(() => { /* nothing kept there */ });
    }
}

/**
 * One refine step on a kept matte `t` ({ alpha, bw, bh, refine }), for keyworker.js and RowsClient's in-thread path
 * (keymatte.js prepareRefine / noteSample / refineBand). -> { answer, transfer }
 */
export function refineOp(t, m) {
    if (m.op === "refine") {
        const st = prepareRefine({ ...m.opts, alpha: t.alpha, aw: t.bw, ah: t.bh });
        t.refine = st;
        return { answer: { halo: st.halo, sample: st.sample ? st.sample.slice() : null, soft: st.soft, residual: st.residual, fitMs: st.fitMs, method: st.method }, transfer: [] };
    }
    const st = t.refine;
    if (!st) throw new Error("the matte's refine was not prepared");
    if (m.op === "refineSample") {
        noteSample(st, m.rgba);
        return { answer: { noise: st.noise ? Array.from(st.noise) : null, guideDiff: st.guideDiff, fallback: st.fallback || null }, transfer: [] };
    }
    if (m.op === "refineBand") {
        const a = refineBand(st, m.band, m.rgba);
        return { answer: { a }, transfer: [a.buffer] };
    }
    throw new Error("unknown refine op " + m.op);
}

/** The app-only module worker beside this file, or null where none can start (plain Node). */
function defaultKeyWorker() {
    if (typeof Worker === "undefined") return null;
    return new Worker(new URL("./keyworker.js", import.meta.url), { type: "module" });
}

/** The share of the box the matte keeps, 0..100 (the status line's "N % of the box kept"), from the bucket alpha. */
export function keptShare(alpha, bw, content) {
    const [cx0, cy0, cx1, cy1] = content;
    let s = 0;
    for (let y = cy0; y < cy1; y++) for (let x = cx0; x < cx1; x++) s += Math.min(1, Math.max(0, alpha[y * bw + x]));
    const n = (cx1 - cx0) * (cy1 - cy0);
    return n ? (100 * s) / n : 0;
}

/** A short hash of bytes (FNV-1a over a sample of up to 64k positions plus the length): the features' cache key part. */
export function bytesHash(b) {
    let h = 0x811c9dc5 ^ b.length;
    const step = Math.max(1, Math.floor(b.length / 65536));
    for (let i = 0; i < b.length; i += step) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return (h >>> 0).toString(16).padStart(8, "0");
}

// ---- the loop's request coalescing (§4.4, §4.6) ---------------------------------------------------------------------

/**
 * At most one engine run in flight and one pending; a newer request replaces the pending one (whose promise resolves
 * `{ dropped: true, ticket }`); every request gets a ticket, and an answer whose ticket is not the newest is `stale`
 * (the dialog keeps it only while nothing newer has answered). A `pinned` request (Key's final run) is never replaced:
 * a preview asked while it waits is dropped at once instead. `run(req)` is the engine's keyRun.
 */
export class KeyQueue {
    constructor(run) {
        this._run = run;
        this._ticket = 0;
        this._flying = null;
        this._pending = null;
        this.runs = 0;           // runs started (tests)
        this.dropped = 0;        // requests replaced before they ran
    }

    /** The newest ticket handed out. */
    get ticket() { return this._ticket; }

    /** { flying, pending }: the tickets of the run in flight and of the one waiting, or null. */
    get state() { return { flying: this._flying ? this._flying.ticket : null, pending: this._pending ? this._pending.ticket : null }; }

    /** Whether `t` is older than the newest ticket. */
    isStale(t) { return t !== this._ticket; }

    /** Queue a run of `req` (its ticket filled in) -> a promise of the answer with `ticket` and `stale`. */
    submit(req, { pinned = false } = {}) {
        if (!pinned && this._pending && this._pending.pinned) {
            // a final run waits: this preview is dropped, the final keeps its slot and stays the newest ticket
            this.dropped++;
            return Promise.resolve({ dropped: true, ticket: 0 });
        }
        const ticket = ++this._ticket;
        let resolve, reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        const entry = { req: { ...req, ticket }, ticket, resolve, reject, promise, pinned };
        if (!this._flying) this._start(entry);
        else {
            if (this._pending) { this.dropped++; this._pending.resolve({ dropped: true, ticket: this._pending.ticket }); }
            this._pending = entry;
        }
        return promise;
    }

    /** Drop the waiting request (Apply, Close): its promise resolves `{ dropped: true }`; a pinned one only with `force`. */
    cancelPending({ force = false } = {}) {
        if (!this._pending || (this._pending.pinned && !force)) return false;
        this.dropped++;
        this._pending.resolve({ dropped: true, ticket: this._pending.ticket });
        this._pending = null;
        return true;
    }

    /** Resolves once nothing is in flight and nothing waits. */
    async idle() {
        while (this._flying || this._pending) {
            const f = this._flying || this._pending;
            try { await f.promise; } catch (_) { /* its caller hears it */ }
        }
    }

    _start(entry) {
        this._flying = entry;
        this.runs++;
        Promise.resolve()
            .then(() => this._run(entry.req))
            .then((res) => entry.resolve({ ...(res || {}), ticket: entry.ticket, stale: entry.ticket !== this._ticket }),
                (err) => entry.reject(err))
            .finally(() => {
                this._flying = null;
                const p = this._pending;
                this._pending = null;
                if (p) this._start(p);
            });
    }
}

/**
 * The engine's answer that it no longer holds a key's features (freed by the idle timer, by freeHelpers before a local
 * ComfyUI run, or a restarted process): the caller prepares the picture again and runs once more. I3's process rejects
 * keyRun with a message that holds FEATURES_GONE (an error's code does not cross IPC).
 */
export const FEATURES_GONE = "KEY_FEATURES_GONE";
export function isFeaturesGone(err) {
    return !!err && (err.code === FEATURES_GONE || String((err && err.message) || err).includes(FEATURES_GONE));
}

// ---- readiness and texts (§4.8, §4.5 step 6) ------------------------------------------------------------------------

export const TEXTS = Object.freeze({
    notInstalled: `${LABEL}: the ${ENGINE} engine is not part of this build yet.`,
    notOffered: `${LABEL}: the ${ENGINE} set is not available for download yet.`,
    notDownloaded: `${LABEL} needs the ${ENGINE} set (about 2.4 GB): download it in Settings › Helpers (Help › Scumble help › Key screen).`,
    runGoing: `${LABEL}: a run is still going on this document.`,
    keyGoing: `${LABEL}: a key is still running.`,
    loading: `${LABEL}: the document is still loading.`,
    noPicture: `${LABEL}: load an image first.`,
    nothingKept: `${LABEL}: the matte keeps nothing of the box; nothing was added. Select the subject roughly as a hint, or pick the screen colour.`,
    askScreen: `${LABEL}: the border of the box is neither clearly green nor clearly blue. Pick Green or Blue under Screen.`,
    cancelled: `${LABEL} cancelled.`,
    maskHint: `${LABEL}: hint "mask" needs a source layer with a mask (set_mask), or rekey on a key layer.`,
});

/** The first-run block's links (§3.3): the licence and Corridor's site. */
export const LICENCE_URL = "https://github.com/nikopueringer/CorridorKey2.0/blob/main/LICENSE";
export const CORRIDOR_URL = "https://corridorkey.com";

/**
 * The pre-download paragraph (§3.3) for the Key dialog's first-run block and I2's terms dialog: the set, its four parts
 * and their licences, its size, the host, the seat clause. `gb` and `host` from keyEngine.status() when it names them.
 */
export function termsParagraph({ gb = null, host = "" } = {}) {
    const size = Number.isFinite(+gb) && +gb > 0 ? `about ${Math.round(+gb * 10) / 10} GB` : "about 2.4 GB";
    return `${ENGINE} by Corridor Digital, Corridor Key Licence 2.0 (CC BY-NC-SA 4.0 with their terms), used with their permission in this free app; `
        + `this set is a conversion to ONNX of their weights and of C-RADIOv4 (NVIDIA Open Model License), MoGe-2 (MIT) and RVM (Google DeepMind, CC BY 4.0), ${size}`
        + `${host ? `, downloaded from ${host}` : ""}. Your keyed pictures are yours, also commercially. `
        + "Organisations with more than US $20M yearly revenue need one CorridorKey seat per user (corridorkey.com).";
}

/**
 * The engine's readiness as the dialog, `status.key` and the refusals say it (§4.8's table). `status` is
 * keyEngine.status(): { installed, offered, present, provider, gpu, cpuSeconds, error, workingSizes }.
 * -> { ok, text, kind, provider, cpu, offered }
 */
export function engineSupport(status) {
    const s = status || {};
    if (!s.installed) return { ok: false, text: TEXTS.notInstalled, kind: "info", provider: null, cpu: false, offered: false };
    if (s.offered === false) return { ok: false, text: TEXTS.notOffered, kind: "info", provider: null, cpu: false, offered: false };
    if (!s.present) return { ok: false, text: TEXTS.notDownloaded, kind: "warn", provider: null, cpu: false, offered: true };
    if (s.error) return { ok: false, text: `${LABEL} could not start ${ENGINE} on this machine (${s.error}).`, kind: "error", provider: null, cpu: false, offered: true };
    if (s.provider === "cpu" || s.gpu === false) {
        const n = Number.isFinite(+s.cpuSeconds) && +s.cpuSeconds > 0 ? Math.round(+s.cpuSeconds) : null;
        return { ok: true, text: `${LABEL} runs on the CPU on this machine${n ? `: about ${n} s per key at 768 px` : ""}, no live preview. Tested on NVIDIA RTX cards.`, kind: "warn", provider: "cpu", cpu: true, offered: true };
    }
    return { ok: true, text: "", kind: "info", provider: s.provider || "gpu", cpu: false, offered: true };
}

/** The provider's name in a sentence ("dml" -> "DirectML"). */
export function providerName(p) {
    const m = { dml: "DirectML", directml: "DirectML", webgpu: "WebGPU", cpu: "the CPU", cuda: "CUDA", stub: "a test engine" };
    return m[String(p || "").toLowerCase()] || String(p || "the GPU");
}

/** The readiness line of a ready engine: "CorridorKey 2.0 in Scumble on DirectML, working size 1,024 px". */
export function readyLine(provider, workingSize) {
    return `${ENGINE} in Scumble on ${providerName(provider)}, working size ${fmtInt(workingSize)} px.`;
}

/** 15000 -> "15,000". */
export function fmtInt(n) {
    return String(Math.round(+n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * What goes, for the dialog's box line: "the selection's box, 3,210 × 4,100, keyed at 803 × 1,024"; a Re-key adds the
 * picture it reads (`plan.from`: "Subject (hidden)", "the picture under the key").
 */
export function boxLine(plan) {
    const [x0, y0, x1, y1] = plan.box;
    const what = plan.rekey ? "the key layer's box" : plan.whole ? "the whole picture" : plan.layerBox ? "the layer's box" : "the selection's box";
    const [, , cw, ch] = plan.content;
    return `${what}, ${fmtInt(x1 - x0)} × ${fmtInt(y1 - y0)}, keyed at ${fmtInt(cw)} × ${fmtInt(ch)}${plan.from ? `, read from ${plan.from}` : ""}`;
}

/** The hint's words in the status line. */
export function hintWords(hint, trust) {
    if (hint === "none") return "no hint";
    const t = trustOf(trust);
    return hint === "mask" ? "hint from the layer's mask" : `hint from the selection (${t.label.toLowerCase()})`;
}

/**
 * The status line after a key (§4.5 step 6): "Key: 38 % of the box kept, in 2.4 s in Scumble (CorridorKey 2.0 on
 * DirectML, green screen, hint from the selection; keyed at 1,024 px)." plus where the layer went. `refined` only
 * once the refine (I6) is in.
 */
export function statusLine({ kept, seconds, provider, screen, hint, trust, keyedAt, refined = false, grey = false, hidden = "", rekey = false }) {
    const pct = kept >= 10 ? Math.round(kept) : Math.round(kept * 10) / 10;
    const secs = seconds >= 10 ? Math.round(seconds) : Math.round(seconds * 10) / 10;
    const head = `${rekey ? "Re-key" : LAYER_NAME}: ${pct} % of the box kept, in ${secs} s in Scumble (${ENGINE} on ${providerName(provider)}, ${screen} screen, ${hintWords(hint, trust)}; keyed at ${fmtInt(keyedAt)} px${refined ? ", refined" : ""}).`;
    const tail = grey ? " A grey layer sits under the Key layer: replace it with your background."
        : hidden ? ` ${hidden} is hidden; Ctrl+Z takes the key back.` : "";
    return head + tail;
}
