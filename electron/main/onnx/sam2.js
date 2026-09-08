// SAM2 through ONNX Runtime: the image encoder once per image, then the prompt decoder
// for point prompts, and the automatic mask generator (a port of SAM2's
// SAM2AutomaticMaskGenerator with crop_n_layers = 0, as the ComfyUI helper node
// InpaintCanvasObjectMap runs it) that turns every object into a label map for the
// editor's object hover tool.
//
// Model files: the samexporter exports (vietanhdev/segment-anything-2-onnx-models).
//   encoder: image [1,3,1024,1024] (ImageNet mean/std)
//         -> high_res_feats_0 [1,32,256,256], high_res_feats_1 [1,64,128,128], image_embed [1,256,64,64]
//   decoder: image_embed, high_res_feats_0, high_res_feats_1, point_coords [B,N,2] (1024 space),
//            point_labels [B,N] (1 fg, 0 bg, 2/3 box corners, -1 pad), mask_input [B,1,256,256],
//            has_mask_input [B] -> masks [B,3,256,256] logits (clamped ±32), iou_predictions [B,3]
// The input image is squashed to 1024 × 1024 like SAM2's own transform; the renderer
// resizes, this module only normalises.
"use strict";

const SIZE = 1024;
const LOW = 256;            // low-res mask side
const LOW2 = LOW * LOW;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

const AUTOMASK_DEFAULTS = {
    pointsPerSide: 32, pointsPerBatch: 64, predIouThresh: 0.8, stabilityScoreThresh: 0.92,
    stabilityScoreOffset: 1.0, boxNmsThresh: 0.7, minArea: 0.0002, maxObjects: 1000,
};

/** RGBA 1024 × 1024 -> float32 CHW tensor data with ImageNet normalisation. */
function normalise(rgba, mean = MEAN, std = STD, size = SIZE) {
    const n = size * size;
    const out = new Float32Array(3 * n);
    const m0 = mean[0], m1 = mean[1], m2 = mean[2], s0 = 1 / std[0], s1 = 1 / std[1], s2 = 1 / std[2];
    for (let i = 0, j = 0; i < n; i++, j += 4) {
        out[i] = (rgba[j] / 255 - m0) * s0;
        out[n + i] = (rgba[j + 1] / 255 - m1) * s1;
        out[2 * n + i] = (rgba[j + 2] / 255 - m2) * s2;
    }
    return out;
}

class Sam2 {
    /**
     * @param {import("./runtime").Runtime} runtime
     * @param {{encoder: string, decoder: string}} files
     */
    constructor(runtime, files) {
        this.runtime = runtime;
        this.files = files;
        this.cache = new Map();   // key -> embedding (last few images)
    }

    /** Encode an RGBA 1024 × 1024 image; cached by key. */
    async encode(rgba, key) {
        if (key && this.cache.has(key)) { const e = this.cache.get(key); this.cache.delete(key); this.cache.set(key, e); return e; }
        const { session, provider } = await this.runtime.session(this.files.encoder);
        const input = this.runtime.tensor("float32", normalise(rgba), [1, 3, SIZE, SIZE]);
        const t0 = Date.now();
        const out = await session.run({ [session.inputNames[0]]: input });
        const emb = {
            image_embed: out.image_embed, high_res_feats_0: out.high_res_feats_0, high_res_feats_1: out.high_res_feats_1,
            provider, encodeMs: Date.now() - t0, key,
        };
        if (key) {
            this.cache.set(key, emb);
            while (this.cache.size > 3) this.cache.delete(this.cache.keys().next().value);
        }
        return emb;
    }

    /**
     * Run the decoder for B prompts. coords: Float32Array(B*N*2) in 1024 space, labels:
     * Float32Array(B*N). Returns { masks: Float32Array(B*3*LOW2), iou: Float32Array(B*3) }.
     */
    async decode(emb, coords, labels, B, N) {
        const { session } = await this.runtime.session(this.files.decoder);
        const feeds = {
            image_embed: emb.image_embed, high_res_feats_0: emb.high_res_feats_0, high_res_feats_1: emb.high_res_feats_1,
            point_coords: this.runtime.tensor("float32", coords, [B, N, 2]),
            point_labels: this.runtime.tensor("float32", labels, [B, N]),
            mask_input: this.runtime.tensor("float32", new Float32Array(B * LOW2), [B, 1, LOW, LOW]),
            has_mask_input: this.runtime.tensor("float32", new Float32Array(B), [B]),
        };
        const out = await session.run(feeds);
        return { masks: out.masks.data, iou: out.iou_predictions.data };
    }

    /**
     * One prompt: points [{x, y, label}] in 1024 space (label 1 = foreground, 0 =
     * background) and an optional box [x0, y0, x1, y1]. Returns the best of the three
     * masks as { logits: Float32Array(LOW2), score }.
     */
    async predict(emb, points, box) {
        const pts = points.slice();
        if (box) { pts.push({ x: box[0], y: box[1], label: 2 }); pts.push({ x: box[2], y: box[3], label: 3 }); }
        if (!pts.length) throw new Error("no prompt");
        const N = pts.length;
        const coords = new Float32Array(N * 2), labels = new Float32Array(N);
        pts.forEach((p, i) => { coords[2 * i] = p.x; coords[2 * i + 1] = p.y; labels[i] = p.label; });
        const { masks, iou } = await this.decode(emb, coords, labels, 1, N);
        let best = 0;
        for (let k = 1; k < 3; k++) if (iou[k] > iou[best]) best = k;
        return { logits: masks.slice(best * LOW2, (best + 1) * LOW2), score: iou[best] };
    }

    /**
     * Every object in the image: a grid of single-point prompts, three masks each,
     * filtered by predicted IoU and stability, de-duplicated with box NMS, painted large
     * to small into a label map of outW × outH (0 = no object). Returns { ids, count }.
     */
    async automask(emb, outW, outH, params = {}) {
        const p = { ...AUTOMASK_DEFAULTS, ...params };
        const n = p.pointsPerSide;
        const grid = [];
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) grid.push([(i + 0.5) / n * SIZE, (j + 0.5) / n * SIZE]);
        const cands = [];   // { score, area, x0, y0, x1, y1, q: Int8Array(LOW2) }
        const thr = p.stabilityScoreOffset;
        for (let start = 0; start < grid.length; start += p.pointsPerBatch) {
            const batch = grid.slice(start, start + p.pointsPerBatch);
            const B = batch.length;
            const coords = new Float32Array(B * 2), labels = new Float32Array(B).fill(1);
            batch.forEach((pt, i) => { coords[2 * i] = pt[0]; coords[2 * i + 1] = pt[1]; });
            const { masks, iou } = await this.decode(emb, coords, labels, B, 1);
            for (let m = 0; m < B * 3; m++) {
                const score = iou[m];
                if (score < p.predIouThresh) continue;
                const o = m * LOW2;
                let above = 0, below = 0, area = 0, x0 = LOW, y0 = LOW, x1 = -1, y1 = -1;
                for (let y = 0, i = o; y < LOW; y++) {
                    let rowHit = false;
                    for (let x = 0; x < LOW; x++, i++) {
                        const v = masks[i];
                        if (v > -thr) {
                            below++;
                            if (v > thr) above++;
                            if (v > 0) { area++; rowHit = true; if (x < x0) x0 = x; if (x > x1) x1 = x; }
                        }
                    }
                    if (rowHit) { if (y < y0) y0 = y; y1 = y; }
                }
                if (!area || below === 0 || above / below < p.stabilityScoreThresh) continue;
                if (area / LOW2 < p.minArea) continue;
                const q = new Int8Array(LOW2);
                for (let i = 0; i < LOW2; i++) { const v = masks[o + i]; q[i] = Math.round(Math.max(-31.75, Math.min(31.75, v)) * 4); }
                cands.push({ score, area, x0, y0, x1, y1, q });
            }
        }
        // box NMS by predicted IoU (torchvision batched_nms with one category)
        cands.sort((a, b) => b.score - a.score);
        const kept = [];
        for (const c of cands) {
            let dup = false;
            const ca = (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1);
            for (const k of kept) {
                const iw = Math.min(c.x1, k.x1) - Math.max(c.x0, k.x0) + 1;
                const ih = Math.min(c.y1, k.y1) - Math.max(c.y0, k.y0) + 1;
                if (iw <= 0 || ih <= 0) continue;
                const inter = iw * ih;
                const ka = (k.x1 - k.x0 + 1) * (k.y1 - k.y0 + 1);
                if (inter / (ca + ka - inter) > p.boxNmsThresh) { dup = true; break; }
            }
            if (!dup) kept.push(c);
            if (kept.length >= p.maxObjects) break;
        }
        // large objects first, small ones painted over them: the smallest under the cursor wins
        kept.sort((a, b) => b.area - a.area);
        const ids = new Uint16Array(outW * outH);
        const sx = LOW / outW, sy = LOW / outH;
        kept.forEach((c, idx) => {
            const label = idx + 1;
            const q = c.q;
            const px0 = Math.max(0, Math.floor(c.x0 / sx) - 1), px1 = Math.min(outW - 1, Math.ceil((c.x1 + 1) / sx) + 1);
            const py0 = Math.max(0, Math.floor(c.y0 / sy) - 1), py1 = Math.min(outH - 1, Math.ceil((c.y1 + 1) / sy) + 1);
            for (let py = py0; py <= py1; py++) {
                const fy = Math.min(LOW - 1, Math.max(0, (py + 0.5) * sy - 0.5));
                const iy = Math.floor(fy), ty = fy - iy, iy1 = Math.min(LOW - 1, iy + 1);
                const r0 = iy * LOW, r1 = iy1 * LOW, row = py * outW;
                for (let px = px0; px <= px1; px++) {
                    const fx = Math.min(LOW - 1, Math.max(0, (px + 0.5) * sx - 0.5));
                    const ix = Math.floor(fx), tx = fx - ix, ix1 = Math.min(LOW - 1, ix + 1);
                    const v = (q[r0 + ix] * (1 - tx) + q[r0 + ix1] * tx) * (1 - ty) + (q[r1 + ix] * (1 - tx) + q[r1 + ix1] * tx) * ty;
                    if (v > 0) ids[row + px] = label;
                }
            }
        });
        return { ids, count: kept.length, candidates: cands.length };
    }
}

/** Upsample low-res logits (LOW × LOW) to a binary Uint8 mask of outW × outH (bilinear, > 0). */
function logitsToMask(logits, outW, outH) {
    const out = new Uint8Array(outW * outH);
    const sx = LOW / outW, sy = LOW / outH;
    for (let py = 0; py < outH; py++) {
        const fy = Math.min(LOW - 1, Math.max(0, (py + 0.5) * sy - 0.5));
        const iy = Math.floor(fy), ty = fy - iy, iy1 = Math.min(LOW - 1, iy + 1);
        const r0 = iy * LOW, r1 = iy1 * LOW, row = py * outW;
        for (let px = 0; px < outW; px++) {
            const fx = Math.min(LOW - 1, Math.max(0, (px + 0.5) * sx - 0.5));
            const ix = Math.floor(fx), tx = fx - ix, ix1 = Math.min(LOW - 1, ix + 1);
            const v = (logits[r0 + ix] * (1 - tx) + logits[r0 + ix1] * tx) * (1 - ty) + (logits[r1 + ix] * (1 - tx) + logits[r1 + ix1] * tx) * ty;
            if (v > 0) out[row + px] = 1;
        }
    }
    return out;
}

module.exports = { Sam2, normalise, logitsToMask, AUTOMASK_DEFAULTS, SIZE, LOW };
