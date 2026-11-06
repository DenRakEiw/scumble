// CorridorKey 2.0 spike (I0b): the utility process. It owns the ONNX sessions of one provider and runs the five graphs;
// main.js measures it from outside. onnxruntime-node comes from the module dir in CK_ORT_DIR (`--ort`), never from the
// app's node_modules (utilityProcess.fork resolves modules from this script's place, docs/PLAN_CORRIDORKEY.md §2.4).
// Messages { id, type, ... } -> { id, result } or { id, error }; the processing is ckio.js's table.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const io = require("./ckio");

const ORT_DIR = process.env.CK_ORT_DIR;
const ort = require(path.join(ORT_DIR, "onnxruntime-node"));
if (process.env.CK_ORT_LOG) ort.env.logLevel = process.env.CK_ORT_LOG;
const port = process.parentPort;
const GRAPHS = ["cradio", "moge", "rvm", "stage1", "stage2"];

const S = { sessions: {}, provider: null, bucket: null, pic: null, feats: null, set: null };

const now = () => Number(process.hrtime.bigint()) / 1e6;

function sessionOptions(provider, log, opt = "all", dmlNoFusion = false) {
    const o = { graphOptimizationLevel: opt, logSeverityLevel: log, logVerbosityLevel: 0 };
    if (provider === "dml") {
        o.executionProviders = [{ name: "dml", deviceId: 0 }]; o.executionMode = "sequential"; o.enableMemPattern = false;
        if (dmlNoFusion) o.extra = { ep: { dml: { disable_graph_fusion: "1" } } };   // session config ep.dml.disable_graph_fusion
    }
    else if (provider === "webgpu") o.executionProviders = [{ name: "webgpu" }];
    else { o.executionProviders = ["cpu"]; o.enableCpuMemArena = false; }
    return o;
}

function graphFile(set, g, bucket) {
    return path.join(set, g === "stage1" ? `stage1_${bucket}_t1.onnx` : `${g}_${bucket}.onnx`);
}

function meta(session) {
    const ins = session.inputMetadata || [];
    return { inputs: session.inputNames.map((n, i) => ({ name: n, ...(ins[i] ? { type: ins[i].type, dims: ins[i].shape } : {}) })),
        outputs: session.outputNames };
}

/** Each graph's session; a graph that fails is recorded with its error and the others go on (`failed`). */
async function load({ set, bucket, provider, graphs = GRAPHS, log = 3, opt = "all", dmlNoFusion = false }) {
    S.set = set; S.provider = provider; S.bucket = bucket;
    const rows = {}, failed = {};
    for (const g of graphs) {
        const file = graphFile(set, g, bucket);
        const c0 = process.cpuUsage(), t0 = now();
        try {
            const s = await ort.InferenceSession.create(file, sessionOptions(provider, log, opt, dmlNoFusion));
            const ms = now() - t0, cu = process.cpuUsage(c0);
            S.sessions[g] = s;
            rows[g] = { ms, cpu_ms: (cu.user + cu.system) / 1000, ...meta(s) };
        } catch (err) {
            failed[g] = { ms: now() - t0, error: String(err && err.message || err).slice(0, 1500) };
        }
    }
    return { graphs: rows, failed, mem: process.memoryUsage() };
}

async function release() {
    const n = Object.keys(S.sessions).length;
    for (const s of Object.values(S.sessions)) { try { await s.release(); } catch (_) { /* gone */ } }
    S.sessions = {}; S.feats = null;
    return { released: n, mem: process.memoryUsage() };
}

function T(data, dims) { return new ort.Tensor("float32", data, dims); }

function bad(a) { let nan = 0, inf = 0; for (let i = 0; i < a.length; i++) { const v = a[i]; if (v !== v) nan++; else if (v === Infinity || v === -Infinity) inf++; } return { nan, inf }; }

function picture({ png, bf16 = false }) {
    const t0 = now();
    const p = io.readPng(fs.readFileSync(png));
    S.pic = io.prepare(p, { bf16 });
    S.feats = null;
    return { ms: now() - t0, W: S.pic.W, H: S.pic.H, channels: p.channels };
}

async function run(g, feeds) {
    const c0 = process.cpuUsage(), t0 = now();
    const out = await S.sessions[g].run(feeds);
    const ms = now() - t0, cu = process.cpuUsage(c0);
    return { out, ms, cpu_ms: (cu.user + cu.system) / 1000 };
}

function save(dir, name, t) {
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    let dims = t.dims.slice();
    while (dims.length > 3 && dims[0] === 1) dims.shift();   // CHW as I0a's arrays
    io.npyWrite(path.join(dir, name + ".npy"), t.data, dims);
}

async function features({ saveDir = null } = {}) {
    const P = S.pic, H = P.H, W = P.W, h = H / 64, w = W / 64;
    const r = {};
    const a = await run("cradio", { x: T(P.cradioIn, [1, 3, H / 4, W / 4]) });
    const b = await run("moge", { x: T(P.mogeIn, [1, 3, P.mogeHW[0], P.mogeHW[1]]) });
    const c = await run("rvm", { frame: T(P.rvmIn, [1, 3, H / 4, W / 4]), state: T(new Float32Array((1 + h * w) * 384), [1, 1 + h * w, 384]) });
    const fc = a.out.feat, fm = b.out.feat, fr = c.out.feat;
    S.feats = { cradio: fc.data, moge: fm.data, rvm: fr.data, dims: { cradio: fc.dims, moge: fm.dims, rvm: fr.dims } };
    r.cradio_ms = a.ms; r.moge_ms = b.ms; r.rvm_ms = c.ms; r.cpu_ms = a.cpu_ms + b.cpu_ms + c.cpu_ms;
    r.bad = { cradio: bad(fc.data), moge: bad(fm.data), rvm: bad(fr.data) };
    save(saveDir, "feat_cradio", fc); save(saveDir, "feat_moge", fm); save(saveDir, "feat_rvm", fr);
    return r;
}

function refFeats(refDir) {
    const f = {};
    for (const k of ["cradio", "moge", "rvm"]) f[k] = io.npyRead(path.join(refDir, `feat_${k}.npy`)).data;
    return f;
}

function hintPlane(hint) {
    const n = S.pic.H * S.pic.W;
    if (!hint) return new Float32Array(n);
    if (typeof hint === "string") return io.hintHW(io.readPng(fs.readFileSync(hint)));
    const out = new Float32Array(n);   // a Uint8Array plane (the live loop's message)
    for (let i = 0; i < n; i++) out[i] = hint[i] / 255;
    return out;
}

/** stage 1 + stage 2 on the cached picture: feats "own" (features() first) or "ref" (I0a's arrays: stage 1 alone). */
async function stages({ hint = null, quality = -1, feats = "own", refDir = null, saveDir = null, answer = "none", bf16Hint = false, prefix = "" }) {
    const P = S.pic, H = P.H, W = P.W, h = H / 64, w = W / 64;
    const F = feats === "ref" ? refFeats(refDir) : S.feats;
    if (!F) throw new Error("no features cached");
    const t0 = now();
    const hp = hintPlane(hint);
    if (bf16Hint) io.roundBf16(hp);
    const s1 = await run("stage1", {
        rgb: T(P.code, [1, 1, 3, H, W]), hint: T(hp, [1, 1, 1, H, W]), hint_quality: T(new Float32Array([quality]), [1, 1]),
        moge: T(F.moge, [1, 1, 768, h, w]), cradio: T(F.cradio, [1, 1, 1152, h, w]), rvm: T(F.rvm, [1, 1, 384, h, w]) });
    const baton = s1.out.baton, aux = s1.out.aux;
    const s2 = await run("stage2", { rgb: T(P.code, [1, 3, H, W]), baton: T(baton.data, [1, 512, H / 16, W / 16]) });
    const lg = s2.out.logits;
    const r = { stage1_ms: s1.ms, stage2_ms: s2.ms, cpu_ms: s1.cpu_ms + s2.cpu_ms, bad: { baton: bad(baton.data), aux: bad(aux.data), logits: bad(lg.data) } };
    save(saveDir, prefix + "baton", baton); save(saveDir, prefix + "aux", aux); save(saveDir, prefix + "logits", lg);
    if (answer === "alpha") {
        const n = H * W, a = new Float32Array(n), d = lg.data;
        for (let i = 0; i < n; i++) { const v = d[i]; a[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
        r.alpha = a;
    }
    r.total_ms = now() - t0;
    return r;
}

/** stage 2 alone on I0a's baton (the isolated row of stage 2). */
async function stage2Ref({ refDir, saveDir }) {
    const P = S.pic, H = P.H, W = P.W;
    const b = io.npyRead(path.join(refDir, "baton.npy")).data;
    const s2 = await run("stage2", { rgb: T(P.code, [1, 3, H, W]), baton: T(b, [1, 512, H / 16, W / 16]) });
    save(saveDir, "s2ref_logits", s2.out.logits);
    return { stage2_ms: s2.ms, bad: bad(s2.out.logits.data) };
}

const handlers = {
    versions: () => ({ ort: ort.env.versions, node: process.versions.node, electron: process.versions.electron, pid: process.pid,
        ortDir: ORT_DIR, ortVersion: require(path.join(ORT_DIR, "onnxruntime-node", "package.json")).version, mem: process.memoryUsage() }),
    load, release, picture, features, stages, stage2Ref,
    mem: () => ({ mem: process.memoryUsage(), cpu: process.cpuUsage() }),
};

port.on("message", async (e) => {
    const m = e.data;
    try {
        const h = handlers[m.type];
        if (!h) throw new Error("unknown request " + m.type);
        const result = await h(m);
        port.postMessage({ id: m.id, result });
    } catch (err) {
        port.postMessage({ id: m.id, error: String(err && err.stack || err) });
    }
});
