// CorridorKey spike (I0b): does one ONNX file build a session on a provider? Plain Node, for onnx_prefix.py's bisection.
//   node tools/ck_spike/try_load.js <node_modules dir> <graph.onnx> dml|webgpu|cpu [nofusion]   -> "OK <ms>" or "FAIL <error>"
"use strict";
const path = require("node:path");
const ort = require(path.join(path.resolve(process.argv[2]), "onnxruntime-node"));
const [file, provider, flag] = process.argv.slice(3);
const o = { graphOptimizationLevel: "all", logSeverityLevel: 3 };
if (provider === "dml") {
    o.executionProviders = [{ name: "dml", deviceId: 0 }]; o.executionMode = "sequential"; o.enableMemPattern = false;
    if (flag === "nofusion") o.extra = { ep: { dml: { disable_graph_fusion: "1" } } };
} else if (provider === "webgpu") o.executionProviders = [{ name: "webgpu" }];
else { o.executionProviders = ["cpu"]; o.enableCpuMemArena = false; }
const t0 = Date.now();
ort.InferenceSession.create(file, o).then(async (s) => { console.log("OK " + (Date.now() - t0)); await s.release(); process.exit(0); },
    (e) => { console.log("FAIL " + String(e && e.message || e).split("\n")[0].slice(0, 300)); process.exit(1); });
