// The helper models' own process (helpers.js, docs/PLAN_HELPERS_PROCESS.md §3): an Electron utility process in the app
// (`process.parentPort`), a forked Node process under plain Node (`process.send`, the tests). It owns the ONNX runtime
// for SAM2, the matting models, depth and Deep paint's decomposition and normals (engine.js), so their loads and runs never hold the main process, and a kill
// gives their memory and VRAM back at once. onnxruntime-node is loaded first: a process that cannot load it ends
// before its "ready" message, and main runs the engine on its own thread instead.
//
// Messages in: { id, type: "objects" | "segment" | "cutout" | "depth" | "intrinsic" | "normals" | "describe", device, model, files, ...the job },
// and { type: "cancel", jobId } (no answer: a describe job stops at its next step with "cancelled").
// Messages out: { type: "ready", pid, status } once at the start, then { id, result, ms, status } or
// { id, error, ms, status } per job: `ms` is the job's time in this process, `status` the runtime's (what is loaded on
// which provider, the failures), so main answers helpers:status without asking.
"use strict";

const { performance } = require("node:perf_hooks");
const { loadOrt } = require("./runtime");
const { engine } = require("./engine");

loadOrt();   // throws (the process ends before "ready") where onnxruntime-node cannot load
const eng = engine();
const port = process.parentPort || null;
const send = (m) => (port ? port.postMessage(m) : process.send(m));
const JOBS = new Set(["objects", "segment", "cutout", "depth", "intrinsic", "normals", "describe"]);

async function handle(msg) {
    // a control message, answered by nobody: a describe job told to stop at its next decoder step
    if (msg && msg.type === "cancel") { eng.cancel(msg.jobId); return; }
    const t = performance.now();
    try {
        if (!msg || !JOBS.has(msg.type)) throw new Error("unknown request " + (msg && msg.type));
        if (msg.device) eng.runtime.setDevice(msg.device);
        const result = await eng[msg.type](msg);
        send({ id: msg.id, result, ms: performance.now() - t, status: eng.status() });
    } catch (err) {
        send({ id: msg && msg.id, error: String((err && err.message) || err), ms: performance.now() - t, status: eng.status() });
    }
}

if (port) port.on("message", (e) => { handle(e.data); });
else {
    process.on("message", handle);
    process.on("disconnect", () => process.exit(0));   // the parent is gone
}
send({ type: "ready", pid: process.pid, status: eng.status() });
