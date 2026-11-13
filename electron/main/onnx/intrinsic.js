// Deep paint's decomposition (docs/PLAN_SURFACE_PAINT.md SP2): Marigold-IID-Lighting v1.1 as Scumble's ONNX export
// (tools/deeppaint/export_onnx.py), one DDIM step, three graphs on one Runtime:
//
//   vae_encoder.onnx  image  [1, 3, H, W] float32 in [-1, 1]   -> latent [1, 4, H/8, W/8] (scaled)
//   unet.onnx         sample [1, 16, h, w] (the image latent, then the three targets' noise), timestep int64 [1]
//                     -> v [1, 12, h, w] (v-prediction; the empty-prompt embedding is baked in)
//   vae_decoder.onnx  latent [3, 4, h, w] (albedo, shading, residual) -> image [3, 3, H, W] float32 in [0, 1], linear
//
// fp16 inside, float32 in and out (onnxruntime-node under Node 24 reads a Float16Array as 0 bytes, SP0). H and W are
// padded to multiples of 64 by repeating the last row and column (odd latent sides break the UNet's skip concats, SP0)
// and cut back after the decode. The targets' starting noise comes from a seeded generator, so the same picture and
// seed give the same bytes wherever the job runs. scheduler.json holds the step: { timestep, alpha_t, alpha_prev }.
"use strict";

const fs = require("node:fs");

/** The longest side the model is meant for (Marigold's processing resolution); a job may send less. */
const MAX_SIDE = 768;
const PAD = 64;

/** A small seeded generator (mulberry32) and normal deviates from it by Box-Muller: the same seed, the same noise. */
function gaussian(n, seed) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += 2) {
        const u = 1 - next(), v = next();
        const r = Math.sqrt(-2 * Math.log(u));
        out[i] = r * Math.cos(2 * Math.PI * v);
        if (i + 1 < n) out[i + 1] = r * Math.sin(2 * Math.PI * v);
    }
    return out;
}

/** RGBA w × h (sRGB bytes) -> planar [3, PH, PW] in [-1, 1], the last row and column repeated into the padding. */
function padNormalise(rgba, w, h, PW, PH) {
    const plane = PW * PH;
    const out = new Float32Array(3 * plane);
    for (let y = 0; y < PH; y++) {
        const sy = y < h ? y : h - 1;
        for (let x = 0; x < PW; x++) {
            const sx = x < w ? x : w - 1;
            const s = (sy * w + sx) * 4, d = y * PW + x;
            out[d] = rgba[s] / 127.5 - 1;
            out[plane + d] = rgba[s + 1] / 127.5 - 1;
            out[2 * plane + d] = rgba[s + 2] / 127.5 - 1;
        }
    }
    return out;
}

/** Target t of the decoder's [3, 3, PH, PW] answer, cut to w × h, as interleaved RGB (what an rgb16 map holds). */
function targetRGB(img, t, w, h, PW, PH) {
    const plane = PW * PH, base = t * 3 * plane;
    const out = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const s = base + y * PW + x, d = (y * w + x) * 3;
            out[d] = img[s];
            out[d + 1] = img[s + plane];
            out[d + 2] = img[s + 2 * plane];
        }
    }
    return out;
}

const asF32 = (t) => (t.data instanceof Float32Array ? t.data : Float32Array.from(t.data));

class Intrinsic {
    /**
     * @param {import("./runtime").Runtime} runtime
     * @param {{ encoder: string, unet: string, decoder: string, scheduler: string }} files the set's paths by role
     */
    constructor(runtime, files) {
        this.runtime = runtime;
        this.files = files;
        this.step = null;
    }

    schedule() {
        if (!this.step) {
            const s = JSON.parse(fs.readFileSync(this.files.scheduler, "utf8"));
            if (!Number.isFinite(s.timestep) || !(s.alpha_t >= 0 && s.alpha_t <= 1) || !(s.alpha_prev > 0 && s.alpha_prev <= 1)) {
                throw new Error("the decomposition's scheduler.json is not readable");
            }
            this.step = { timestep: Math.round(s.timestep), at: s.alpha_t, ap: s.alpha_prev };
        }
        return this.step;
    }

    /**
     * RGBA w × h (long side at most 768) -> { albedo, shading, residual: Float32Array(w * h * 3) interleaved RGB,
     * linear 0..1, provider, ms: { load, encode, unet, decode } }. `seed` picks the noise (0 by default).
     */
    async run(rgba, w, h, { seed = 0 } = {}) {
        const { timestep, at, ap } = this.schedule();
        const r = this.runtime;
        const t0 = Date.now();
        const enc = await r.session(this.files.encoder);
        const unet = await r.session(this.files.unet);
        const dec = await r.session(this.files.decoder);
        const t1 = Date.now();
        const PW = Math.ceil(w / PAD) * PAD, PH = Math.ceil(h / PAD) * PAD;
        const lw = PW / 8, lh = PH / 8, lp = lw * lh;
        const image = padNormalise(rgba, w, h, PW, PH);
        const lat = asF32((await enc.session.run({ [enc.session.inputNames[0]]: r.tensor("float32", image, [1, 3, PH, PW]) }))[enc.session.outputNames[0]]);
        if (lat.length !== 4 * lp) throw new Error(`unexpected latent of ${lat.length} values from the decomposition's encoder`);
        const t2 = Date.now();
        const noise = gaussian(12 * lp, seed);
        const sample = new Float32Array(16 * lp);
        sample.set(lat, 0);
        sample.set(noise, 4 * lp);
        const feeds = {
            sample: r.tensor("float32", sample, [1, 16, lh, lw]),
            timestep: r.tensor("int64", BigInt64Array.from([BigInt(timestep)]), [1]),
        };
        const v = asF32((await unet.session.run(feeds))[unet.session.outputNames[0]]);
        if (v.length !== 12 * lp) throw new Error(`unexpected prediction of ${v.length} values from the decomposition's UNet`);
        // one DDIM step on the v-prediction: x0 = sqrt(a_t) x - sqrt(1 - a_t) v, eps = sqrt(a_t) v + sqrt(1 - a_t) x,
        // prev = sqrt(a_prev) x0 + sqrt(1 - a_prev) eps (diffusers' DDIMScheduler with one step, SP0's check)
        const sa = Math.sqrt(at), sb = Math.sqrt(1 - at), pa = Math.sqrt(ap), pb = Math.sqrt(1 - ap);
        const prev = new Float32Array(v.length);
        for (let i = 0; i < v.length; i++) {
            const x = noise[i];
            prev[i] = pa * (sa * x - sb * v[i]) + pb * (sa * v[i] + sb * x);
        }
        const t3 = Date.now();
        const img = asF32((await dec.session.run({ [dec.session.inputNames[0]]: r.tensor("float32", prev, [3, 4, lh, lw]) }))[dec.session.outputNames[0]]);
        if (img.length !== 9 * PW * PH) throw new Error(`unexpected picture of ${img.length} values from the decomposition's decoder`);
        const t4 = Date.now();
        return {
            albedo: targetRGB(img, 0, w, h, PW, PH),
            shading: targetRGB(img, 1, w, h, PW, PH),
            residual: targetRGB(img, 2, w, h, PW, PH),
            width: w, height: h, provider: unet.provider,
            ms: { load: t1 - t0, encode: t2 - t1, unet: t3 - t2, decode: t4 - t3 },
        };
    }
}

module.exports = { Intrinsic, gaussian, padNormalise, targetRGB, MAX_SIDE, PAD };
