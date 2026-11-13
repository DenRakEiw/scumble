// SP0 step 4: MoGe-2 ViT-S / ViT-B normal (Microsoft's ONNX, fp32) on the app's onnxruntime-node: DirectML against CPU,
// timings, and the normal maps written as raw f32 for a look (moge_out/<model>_<pic>_normal.f32, [H,W,3]).
"use strict";
const fs = require("fs");
const path = require("path");
const ort = require("F:/canvas/node_modules/onnxruntime-node");

const HERE = __dirname;
const meta = JSON.parse(fs.readFileSync(path.join(HERE, "ref", "meta.json"), "utf8"));
fs.mkdirSync(path.join(HERE, "moge_out"), { recursive: true });
function readF32(file) { const b = fs.readFileSync(file); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); }
const opts = (p) => Object.assign({ executionProviders: [p], graphOptimizationLevel: "all", logSeverityLevel: 3 },
    p === "dml" ? { executionMode: "sequential", enableMemPattern: false } : {});

(async () => {
    for (const m of ["vits", "vitb"]) {
        const ses = {};
        for (const p of ["dml", "cpu"]) ses[p] = await ort.InferenceSession.create(path.join(HERE, "models", "moge", m + ".onnx"), opts(p));
        for (const name of ["portrait", "cafe_car"]) {
            const { PH, PW } = meta[name];
            const x = readF32(path.join(HERE, "ref", name + "_image.f32")).map((v) => (v + 1) / 2);
            const feeds = { image: new ort.Tensor("float32", x, [1, 3, PH, PW]), num_tokens: new ort.Tensor("int64", BigInt64Array.from([1800n]), []) };
            const out = {}, ms = {};
            for (const p of ["dml", "cpu"]) {
                await ses[p].run(feeds);
                const t0 = Date.now(); out[p] = await ses[p].run(feeds); ms[p] = Date.now() - t0;
            }
            const a = out.dml.normal.data, b = out.cpu.normal.data;
            let maxDeg = 0, sumDeg = 0;
            const n = a.length / 3;
            for (let i = 0; i < n; i++) {
                const d = Math.min(1, a[3 * i] * b[3 * i] + a[3 * i + 1] * b[3 * i + 1] + a[3 * i + 2] * b[3 * i + 2]);
                const deg = Math.acos(d) * 180 / Math.PI; sumDeg += deg; if (deg > maxDeg) maxDeg = deg;
            }
            fs.writeFileSync(path.join(HERE, "moge_out", `${m}_${name}_normal.f32`), Buffer.from(a.buffer, a.byteOffset, a.byteLength));
            console.log(JSON.stringify({ model: m, name, normal_dims: out.dml.normal.dims, ms, dml_vs_cpu_mean_deg: +(sumDeg / n).toFixed(3), max_deg: +maxDeg.toFixed(2) }));
        }
    }
})().catch((e) => { console.error("FAILED", e && e.message || e); process.exit(1); });
