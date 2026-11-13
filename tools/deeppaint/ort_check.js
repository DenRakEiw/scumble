// SP0 step 3b: the exported graphs on the app's onnxruntime-node (F:/canvas/node_modules), DirectML and CPU, against
// torch's one-step prediction (ref/*_pred.f32). Session options as electron/main/onnx/runtime.js sets them.
// node ort_check.js <dml|cpu> [picture ...]
"use strict";
const fs = require("fs");
const path = require("path");
const ort = require("F:/canvas/node_modules/onnxruntime-node");

const HERE = __dirname;
const provider = process.argv[2] || "dml";
const names = process.argv.slice(3).length ? process.argv.slice(3) : ["portrait", "cafe_car", "house"];
const meta = JSON.parse(fs.readFileSync(path.join(HERE, "ref", "meta.json"), "utf8"));
const sch = JSON.parse(fs.readFileSync(path.join(HERE, "onnx", "scheduler.json"), "utf8"));

function readF32(file) { const b = fs.readFileSync(file); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); }
// float16 (Uint16) -> float32 without a library (the graphs take float32; an fp16 output is read back here)

function fromHalf(h) {
    const out = new Float32Array(h.length);
    for (let i = 0; i < h.length; i++) {
        const v = h[i], s = v & 0x8000 ? -1 : 1, e = (v >> 10) & 0x1f, m = v & 0x3ff;
        out[i] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
    }
    return out;
}
const half = (a, dims) => new ort.Tensor("float32", a, dims); // the graphs take float32 (fp16 inside)
const data32 = (t) => (t.type !== "float16" ? t.data : t.data instanceof Uint16Array ? fromHalf(t.data) : Float32Array.from(t.data));

(async () => {
    const opts = { executionProviders: [provider], graphOptimizationLevel: "all", logSeverityLevel: 3 };
    if (provider === "dml") { opts.executionMode = "sequential"; opts.enableMemPattern = false; }
    const t0 = Date.now();
    const enc = await ort.InferenceSession.create(path.join(HERE, "onnx", "vae_encoder.onnx"), opts);
    const unet = await ort.InferenceSession.create(path.join(HERE, "onnx", "unet.onnx"), opts);
    const dec = await ort.InferenceSession.create(path.join(HERE, "onnx", "vae_decoder.onnx"), opts);
    console.log(JSON.stringify({ provider, load_s: (Date.now() - t0) / 1000 }));
    const at = sch.alpha_t, ap = sch.alpha_prev;
    for (const name of names) {
        const { PH, PW } = meta[name]; const h = PH / 8, w = PW / 8;
        const img = readF32(path.join(HERE, "ref", name + "_image.f32"));
        const noise = readF32(path.join(HERE, "ref", name + "_noise.f32"));
        const ref = readF32(path.join(HERE, "ref", name + "_pred.f32"));
        const times = [];
        let pred = null;
        for (let run = 0; run < 3; run++) {
            const T = [Date.now()];
            const lat = data32((await enc.run({ image: half(img, [1, 3, PH, PW]) })).latent); T.push(Date.now());
            const sample = new Float32Array(16 * h * w); sample.set(lat, 0); sample.set(noise, 4 * h * w);
            const v = data32((await unet.run({ sample: half(sample, [1, 16, h, w]), timestep: new ort.Tensor("int64", BigInt64Array.from([BigInt(sch.timestep)]), [1]) })).v); T.push(Date.now());
            const prev = new Float32Array(v.length);
            for (let i = 0; i < v.length; i++) {
                const x = noise[i], x0 = Math.sqrt(at) * x - Math.sqrt(1 - at) * v[i], eps = Math.sqrt(at) * v[i] + Math.sqrt(1 - at) * x;
                prev[i] = Math.sqrt(ap) * x0 + Math.sqrt(1 - ap) * eps;
            }
            pred = data32((await dec.run({ latent: half(prev, [3, 4, h, w]) })).image); T.push(Date.now());
            times.push({ enc: T[1] - T[0], unet: T[2] - T[1], dec: T[3] - T[2], all: T[3] - T[0] });
        }
        let max = 0, sum = 0; const per = [0, 0, 0];
        const plane = 3 * PH * PW;
        for (let i = 0; i < ref.length; i++) {
            const d = Math.abs(pred[i] - ref[i]); sum += d; if (d > max) max = d;
            const k = Math.floor(i / plane); if (d > per[k]) per[k] = d;
        }
        console.log(JSON.stringify({ name, size: [PW, PH], max_abs: +max.toFixed(4), mean_abs: +(sum / ref.length).toFixed(5),
            max_by_target: per.map((x) => +x.toFixed(4)), ms_last: times[2], ms_first: times[0] }));
    }
})().catch((e) => { console.error("FAILED", e && e.message || e); process.exit(1); });
