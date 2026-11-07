// U0 of docs/PLAN_WASM_BUILD.md §7 ("The user's answers after K4"): the in-app ONNX helpers' own engine
// (electron/main/onnx/runtime.js, sam2.js, matting.js, depth.js, which import no Electron) in an Electron utility
// process, as U1 would run it. tools/helpers_perf.py forks this script from the main process through the main
// process's inspector (`utilityProcess.fork`); the app never loads it.
//
// Messages in (one at a time or several; each answers with its id):
//   { id, type: "init", device }                         the Runtime's device ("auto" | "gpu" | "cpu")
//   { id, type: "objects", encoder, decoder, image, key, outWidth, outHeight }   SAM2 encode (cached by key) + automask
//   { id, type: "segment", encoder, decoder, key, image?, points }               SAM2 predict on the cached embedding
//   { id, type: "cutout", file, model, image }            a matting model (registry entry fields: input, mean, std, label)
//   { id, type: "depth", file, model, image, width, height }
//   { id, type: "free" }                                  every session released, the embedding cache cleared
//   { id, type: "echo", data }                            the bytes back as they came (the message port's copy cost)
//   { id, type: "mem" }                                   this process's memory
// Messages out: { id, result, ms } or { id, error, ms }; `ms` is the job's time inside this process.
"use strict";

const path = require("node:path");
const { performance } = require("node:perf_hooks");

const ONNX = path.join(__dirname, "..", "electron", "main", "onnx");
const t0 = performance.now();
const { Runtime } = require(path.join(ONNX, "runtime.js"));
const { Sam2 } = require(path.join(ONNX, "sam2.js"));
const { Matting } = require(path.join(ONNX, "matting.js"));
const { Depth } = require(path.join(ONNX, "depth.js"));

const runtime = new Runtime();
const sams = new Map();   // "encoder|decoder" -> Sam2
const port = process.parentPort;
const send = (m) => port.postMessage(m);

function sam(msg) {
    const k = msg.encoder + "|" + msg.decoder;
    if (!sams.has(k)) sams.set(k, new Sam2(runtime, { encoder: msg.encoder, decoder: msg.decoder }));
    return sams.get(k);
}

/** A Uint8Array view whatever form the bytes arrived in (a typed array, a Buffer, an ArrayBuffer). */
function bytes(x) {
    if (!x) return null;
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    return null;
}

async function memory() {
    const m = process.memoryUsage();
    let priv = null;
    try { priv = (await process.getProcessMemoryInfo()).private / 1024; } catch (_) { /* not in this process type */ }
    return { pid: process.pid, rssMB: m.rss / 1048576, privMB: priv, heapMB: m.heapUsed / 1048576, abMB: m.arrayBuffers / 1048576 };
}

async function handle(msg) {
    const s = performance.now();
    try {
        let result;
        if (msg.type === "init") {
            runtime.setDevice(msg.device || "auto");
            let ortMs = null;
            const a = performance.now();
            const ort = require(path.join(ONNX, "runtime.js")).loadOrt();
            ortMs = performance.now() - a;
            result = { pid: process.pid, device: runtime.device, ortMs, startMs: t0, version: ort.env && ort.env.versions ? ort.env.versions.node : null };
        } else if (msg.type === "objects") {
            const sm = sam(msg);
            const a = performance.now();
            const emb = await sm.encode(bytes(msg.image), msg.key || null);
            const b = performance.now();
            const res = await sm.automask(emb, msg.outWidth, msg.outHeight, msg.params || {});
            result = { ids: res.ids, count: res.count, candidates: res.candidates, provider: emb.provider, encodeMs: b - a, automaskMs: performance.now() - b, encodeRunMs: emb.encodeMs };
        } else if (msg.type === "segment") {
            const sm = sam(msg);
            let emb = msg.key ? sm.cache.get(msg.key) : null;
            if (!emb) emb = await sm.encode(bytes(msg.image), msg.key || null);
            const r = await sm.predict(emb, msg.points || [], msg.box || null);
            result = { logits: r.logits, score: r.score, provider: emb.provider };
        } else if (msg.type === "cutout") {
            const m = new Matting(runtime, msg.model, msg.file);
            const r = await m.run(bytes(msg.image));
            result = { alpha: r.alpha, size: r.size, provider: r.provider, runMs: r.ms };
        } else if (msg.type === "depth") {
            const d = new Depth(runtime, msg.model, msg.file);
            const r = await d.run(bytes(msg.image), msg.width, msg.height);
            result = { depth: r.depth, width: r.width, height: r.height, provider: r.provider, runMs: r.ms };
        } else if (msg.type === "free") {
            for (const sm of sams.values()) sm.cache.clear();
            result = { released: await runtime.free() };
        } else if (msg.type === "echo") {
            result = { data: msg.data };
        } else if (msg.type === "mem") {
            result = { ...(await memory()), runtime: runtime.status() };
        } else {
            throw new Error("unknown request " + msg.type);
        }
        send({ id: msg.id, result, ms: performance.now() - s });
    } catch (err) {
        send({ id: msg.id, error: String((err && err.stack) || err).slice(0, 800), ms: performance.now() - s });
    }
}

if (!port) {
    console.error("helpers_process_probe.js runs as an Electron utility process (tools/helpers_perf.py forks it)");
    process.exit(2);
}
port.on("message", (e) => { handle(e.data); });
