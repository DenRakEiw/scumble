// CorridorKey 2.0 spike (docs/PLAN_CORRIDORKEY.md §4.2, session I0b): measurement only, no app code. An Electron entry
// that forks one utility process (key_process.js) running Nucito/corridorkey-web's five ONNX graphs on one execution
// provider and one onnxruntime-node build, measures it from outside (Windows' GPU counters and private bytes through
// sampler.ps1 every 250 ms, nvidia-smi's card total beside it) and prints / appends one JSON row per measurement.
//
//   ./node_modules/.bin/electron tools/ck_spike/main.js --set <dir> --provider dml|webgpu|cpu --ort <node_modules dir>
//       --out <dir> --label <name> --task bench|parity|placement|stagesref --bucket 1024x1024 [--ref dist/ck_ref]
//       [--stills a,b] [--input <png> --hint <png>] [--refcase <I0a case dir>] [--reps 5] [--loop 10] [--bf16-inputs]
//       [--opt all|extended|basic|disabled] [--dml-nofusion]
//
// bench: load (fresh process), the picture, features / stages cold and warm, with and without the hint, the live loop
//        (post -> answer in this process and the model time), memory checkpoints, release, a second load, kill().
// parity: per still and case of I0a's reference (dist/ck_ref/<still>/b<side>_<hint|nohint>/), the input PNG fed byte for
//        byte; the chained run (own features -> stage 1 -> stage 2) and the isolated rows (stage 1 on I0a's features,
//        stage 2 on I0a's baton) saved as float32 .npy for tools/ck_spike/parity.py.
// placement: each graph's session made with ORT's verbose log (the node placement) into <out>/<label>.stderr.log.
// stagesref: stage 1 + 2 alone on I0a's features of one case, one timed run (a provider too slow for bench).
// The results of 2026-11-06 and how they were run: docs/measurements/ck_i0b_2026-11-06/ (summary.txt, scripts/).
// Every row carries ort_node (`ort.env.versions.node` of the utility process).
"use strict";

const { app, utilityProcess } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const io = require("./ckio");

function args() {
    const a = {}, v = process.argv;
    for (let i = 0; i < v.length; i++) {
        if (!v[i].startsWith("--") || v[i] === "--") continue;
        const k = v[i].slice(2), nx = v[i + 1];
        if (nx === undefined || nx.startsWith("--")) a[k] = true; else { a[k] = nx; i++; }
    }
    return a;
}
const A = args();
const OUT = path.resolve(A.out || ".");
const LABEL = A.label || `${A.task}_${A.provider}`;
const OPT = A.opt || "all";
const NOFUSE = !!A["dml-nofusion"];   // DirectML: the session config ep.dml.disable_graph_fusion = 1   // graphOptimizationLevel: all (Scumble's runtime.js) | extended | basic | disabled
fs.mkdirSync(OUT, { recursive: true });
app.disableHardwareAcceleration();   // Electron's own GPU process makes no D3D device beside the one measured
app.setPath("userData", path.join(OUT, ".electron_profile"));

const t0 = Date.now();
const rowsFile = path.join(OUT, "rows.jsonl");
let common = { label: LABEL, task: A.task, provider: A.provider, bucket: A.bucket, opt: OPT, dml_nofusion: NOFUSE, bf16_inputs: !!A["bf16-inputs"] };
function row(r) {
    const o = { ...common, t_ms: Date.now() - t0, ...r };
    const line = JSON.stringify(o);
    fs.appendFileSync(rowsFile, line + "\n");
    console.log(line.length > 600 ? line.slice(0, 600) + " ..." : line);
    return o;
}

// ------------------------------------------------------------------------------------------------- the child process
let child = null, seq = 0;
const pending = new Map();
function ask(type, msg = {}) {
    return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        child.postMessage({ id, type, ...msg });
    });
}

// --------------------------------------------------------------------------------------------- sampler and nvidia-smi
let last = null;
const samples = [];
function startSampler(childPid) {
    const ps = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "sampler.ps1"),
        "-ChildPid", String(childPid), "-MainPid", String(process.pid), "-IntervalMs", "250"], { windowsHide: true });
    const out = fs.createWriteStream(path.join(OUT, LABEL + ".samples.jsonl"));
    let buf = "";
    ps.stdout.on("data", (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
            const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!ln) continue;
            out.write(ln + "\n");
            try { const s = JSON.parse(ln); s.card_total = Object.values(s.card_ded || {}).reduce((x, y) => x + y, 0); last = s; samples.push(s); } catch (_) { /* partial */ }
        }
    });
    const smi = spawn("nvidia-smi", ["--query-gpu=timestamp,memory.used,utilization.gpu", "--format=csv,noheader,nounits", "-lms", "250"], { windowsHide: true });
    smi.stdout.pipe(fs.createWriteStream(path.join(OUT, LABEL + ".smi.csv")));
    return { stop: () => { try { ps.kill(); } catch (_) { /* gone */ } try { smi.kill(); } catch (_) { /* gone */ } out.end(); } };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function snap(tag) {
    await wait(800);   // three samples after the step
    const m = await ask("mem").catch(() => null);
    const metric = app.getAppMetrics().find((x) => x.pid === child.pid);
    const s = last || {};
    return row({ kind: "mem", tag, child_private: s.child_private, child_gpu_ded: s.child_gpu_ded, child_gpu_shared: s.child_gpu_shared,
        card_ded: s.card_total, main_private: s.main_private, child_private_metrics_kb: metric && metric.memory && metric.memory.privateBytes,
        child_rss: m && m.mem && m.mem.rss, child_heap: m && m.mem && m.mem.heapUsed, child_external: m && m.mem && m.mem.external,
        child_cpu_ms: m && (m.cpu.user + m.cpu.system) / 1000 });
}

const median = (a) => { const b = a.slice().sort((x, y) => x - y); const n = b.length; return n ? (n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2) : null; };
const strip = (r) => { const o = { ...r }; delete o.alpha; return o; };

// ---------------------------------------------------------------------------------------------------------- the tasks
async function bench() {
    const reps = Number(A.reps || 5), loopN = Number(A.loop || 10);
    await snap("forked");
    const ld = await ask("load", { set: A.set, bucket: A.bucket, provider: A.provider, opt: OPT, dmlNoFusion: NOFUSE });
    for (const [g, r] of Object.entries(ld.graphs)) row({ kind: "load", phase: "first", graph: g, ms: r.ms, cpu_ms: r.cpu_ms, io: { inputs: r.inputs, outputs: r.outputs } });
    for (const [g, r] of Object.entries(ld.failed)) row({ kind: "load_failed", phase: "first", graph: g, ms: r.ms, error: r.error });
    row({ kind: "load_total", phase: "first", ms: Object.values(ld.graphs).reduce((x, r) => x + r.ms, 0), failed: Object.keys(ld.failed) });
    await snap("after load");
    if (Object.keys(ld.failed).length) throw new Error("graphs failed to load: " + Object.keys(ld.failed).join(", "));
    const pic = await ask("picture", { png: A.input, bf16: !!A["bf16-inputs"] });
    row({ kind: "picture", ms: pic.ms, input: A.input, W: pic.W, H: pic.H, channels: pic.channels });
    for (let i = 0; i <= reps; i++) {
        const f = await ask("features");
        row({ kind: "features", run: i, cold: i === 0, ...f });
        if (i === 0) await snap("after first features");
    }
    for (const withHint of [false, true]) {
        for (let i = 0; i <= reps; i++) {
            const r = await ask("stages", withHint ? { hint: A.hint, quality: 0.75 } : { quality: -1 });
            row({ kind: "stages", hint: withHint, run: i, cold: i === 0, ...strip(r) });
            if (i === 0 && !withHint) await snap("after first stages");
        }
    }
    await snap("after runs");
    // the live loop: a hint plane posted, stage 1 + 2 on the cached features, the clamped alpha posted back
    const hp = io.readPng(fs.readFileSync(A.hint));
    const plane = new Uint8Array(hp.width * hp.height);
    for (let i = 0; i < plane.length; i++) plane[i] = hp.data[i * hp.channels];
    const e2e = [], model = [], s12 = [];
    for (let i = 0; i < loopN; i++) {
        const tp = performance.now();
        const r = await ask("stages", { hint: plane, quality: 0.75, answer: "alpha" });
        const ta = performance.now();
        e2e.push(ta - tp); model.push(r.total_ms); s12.push(r.stage1_ms + r.stage2_ms);
        row({ kind: "loop", run: i, post_to_answer_ms: ta - tp, model_ms: r.total_ms, stage1_ms: r.stage1_ms, stage2_ms: r.stage2_ms, alpha_bytes: r.alpha.byteLength });
    }
    row({ kind: "loop_median", n: loopN, post_to_answer_ms: median(e2e), model_ms: median(model), stage12_ms: median(s12),
        ipc_ms: median(e2e.map((x, i) => x - model[i])) });
    await snap("after loop");
    const rel = await ask("release");
    row({ kind: "release", released: rel.released });
    await snap("after release");
    const ld2 = await ask("load", { set: A.set, bucket: A.bucket, provider: A.provider, opt: OPT, dmlNoFusion: NOFUSE });
    for (const [g, r] of Object.entries(ld2.graphs)) row({ kind: "load", phase: "second (same process, after release)", graph: g, ms: r.ms, cpu_ms: r.cpu_ms });
    row({ kind: "load_total", phase: "second", ms: Object.values(ld2.graphs).reduce((x, r) => x + r.ms, 0) });
    await ask("picture", { png: A.input });
    const f2 = await ask("features");
    const s2 = await ask("stages", { hint: A.hint, quality: 0.75 });
    row({ kind: "after_reload_run", features: f2, stages: strip(s2) });
    await snap("after reload and a run");
}

async function parity() {
    const side = A.bucket.split("x")[0];
    const stills = String(A.stills).split(",");
    const ld = await ask("load", { set: A.set, bucket: A.bucket, provider: A.provider, opt: OPT, dmlNoFusion: NOFUSE });
    for (const [g, r] of Object.entries(ld.failed)) row({ kind: "load_failed", graph: g, ms: r.ms, error: r.error });
    row({ kind: "load_total", ms: Object.values(ld.graphs).reduce((x, r) => x + r.ms, 0), failed: Object.keys(ld.failed) });
    const ok = (g) => !ld.failed[g];   // a provider that cannot build a graph: the rows of the others still go
    if (!ok("cradio") || !ok("moge") || !ok("rvm")) throw new Error("feature graphs failed to load: " + Object.keys(ld.failed).join(", "));
    for (const still of stills) {
        for (const c of ["nohint", "hint"]) {
            const refDir = path.join(A.ref, still, `b${side}_${c}`);
            const info = JSON.parse(fs.readFileSync(path.join(refDir, "case.json"), "utf8"));
            const saveDir = path.join(OUT, "arrays", LABEL, still, `b${side}_${c}`);
            const pic = await ask("picture", { png: path.join(refDir, "in", "input.png"), bf16: !!A["bf16-inputs"] });
            const f = await ask("features", { saveDir });
            const hint = info.hint ? path.join(refDir, info.hint) : null;
            const both = ok("stage1") && ok("stage2");
            const s = both ? await ask("stages", { hint, quality: info.hint_quality, saveDir, bf16Hint: !!A["bf16-inputs"] }) : null;
            const s1r = both ? await ask("stages", { hint, quality: info.hint_quality, feats: "ref", refDir, saveDir, prefix: "s1ref_", bf16Hint: !!A["bf16-inputs"] }) : null;
            const s2r = ok("stage2") ? await ask("stage2Ref", { refDir, saveDir }) : null;
            row({ kind: "parity_run", still, case: `b${side}_${c}`, quality: info.hint_quality, picture_ms: pic.ms, features: f, stages: s, stage1_on_ref: s1r, stage2_on_ref: s2r, saveDir });
        }
    }
}

/** stage 1 + stage 2 alone on I0a's features (--refcase <dir>): one timed run, for a provider too slow for bench. */
async function stagesRef() {
    const ld = await ask("load", { set: A.set, bucket: A.bucket, provider: A.provider, graphs: ["stage1", "stage2"], opt: OPT, dmlNoFusion: NOFUSE });
    for (const [g, r] of Object.entries(ld.graphs)) row({ kind: "load", phase: "first", graph: g, ms: r.ms, cpu_ms: r.cpu_ms });
    if (Object.keys(ld.failed).length) throw new Error("graphs failed to load: " + Object.keys(ld.failed).join(", "));
    await snap("after load");
    const info = JSON.parse(fs.readFileSync(path.join(A.refcase, "case.json"), "utf8"));
    await ask("picture", { png: path.join(A.refcase, "in", "input.png") });
    const hint = info.hint ? path.join(A.refcase, info.hint) : null;
    const r = await ask("stages", { hint, quality: info.hint_quality, feats: "ref", refDir: A.refcase });
    row({ kind: "stages", hint: !!hint, run: 0, cold: true, feats: "ref", ...strip(r) });
    await snap("after stages");
}

async function placement() {
    for (const g of ["cradio", "moge", "rvm", "stage1", "stage2"]) {
        fs.appendFileSync(path.join(OUT, LABEL + ".stderr.log"), `\n===== CK_SPIKE graph ${g} ${A.bucket} ${A.provider}\n`);
        await wait(300);
        const ld = await ask("load", { set: A.set, bucket: A.bucket, provider: A.provider, graphs: [g], log: 0, opt: OPT, dmlNoFusion: NOFUSE });
        row({ kind: "placement_load", graph: g, ms: ld.graphs[g] ? ld.graphs[g].ms : null, error: ld.failed[g] ? ld.failed[g].error : undefined });
        await wait(500);
        await ask("release");
    }
    await wait(500);
}

async function main() {
    const stderrLog = fs.createWriteStream(path.join(OUT, LABEL + ".stderr.log"), { flags: "a" });
    const env = { ...process.env, CK_ORT_DIR: path.resolve(A.ort) };
    if (A.task === "placement") env.CK_ORT_LOG = "verbose";
    const tf = performance.now();
    child = utilityProcess.fork(path.join(__dirname, "key_process.js"), [], { stdio: "pipe", serviceName: "CK spike " + A.provider, env });
    child.stdout.on("data", (d) => stderrLog.write(d));
    child.stderr.on("data", (d) => stderrLog.write(d));
    child.on("message", (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result); });
    let exited = null;
    child.on("exit", (code) => { exited = { code, t: performance.now() }; for (const p of pending.values()) p.reject(new Error("child exited " + code)); pending.clear(); });
    await new Promise((r) => child.once("spawn", r));
    const sampler = startSampler(child.pid);
    let ok = true;
    try {
        const v = await ask("versions");
        common = { ...common, ort_node: v.ort && v.ort.node, ort_common: v.ort && v.ort.common, ort_pkg: v.ortVersion, electron: v.electron, node: v.node };
        row({ kind: "versions", spawn_ms: performance.now() - tf, ...v });
        await wait(1500);   // the sampler's first lines
        if (A.task === "bench") await bench();
        else if (A.task === "parity") await parity();
        else if (A.task === "placement") await placement();
        else if (A.task === "stagesref") await stagesRef();
        else throw new Error("unknown task " + A.task);
    } catch (err) {
        ok = false;
        row({ kind: "error", error: String(err && err.stack || err).slice(0, 4000) });
    }
    // kill(): the time to the exit event, then when the counters show the GPU memory and the process gone
    if (!exited) {
        const before = last || {};
        const tk = performance.now(), tkWall = Date.now();
        child.kill();
        for (let i = 0; i < 100 && !exited; i++) await wait(20);
        await wait(4000);
        const after = samples.filter((s) => s.t >= tkWall);
        const gpu0 = after.find((s) => !s.child_gpu_ded);
        const gone = after.find((s) => s.child_private === -1);
        row({ kind: "kill", exit_ms: exited ? exited.t - tk : null, exit_code: exited && exited.code,
            gpu_before: before.child_gpu_ded, private_before: before.child_private, card_before: before.card_total,
            gpu_zero_after_ms: gpu0 ? gpu0.t - tkWall : null, process_gone_after_ms: gone ? gone.t - tkWall : null,
            card_after: after.length ? after[after.length - 1].card_total : null, main_private_after: after.length ? after[after.length - 1].main_private : null });
    }
    sampler.stop();
    row({ kind: "done", ok });
    setTimeout(() => app.exit(ok ? 0 : 1), 300);
}

app.whenReady().then(main);
app.on("window-all-closed", () => { /* no windows */ });
