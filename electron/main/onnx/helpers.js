// Main's side of the helper models' process (docs/PLAN_HELPERS_PROCESS.md §3, U1): SAM2, the matting models and depth
// run in one process of their own (helpers_process.js; an Electron utility process in the app, a forked Node process
// under plain Node), on LaMa's pattern (lama.js). onnxruntime-node runs `InferenceSession.create`, `run` and `release`
// as synchronous native calls on the thread that calls them, so on main's thread a first SAM2 call held every IPC
// channel 1.1 s in one piece, an object map 0.2 s sixteen times, a CPU cutout its whole 4.8 s (U0's numbers); in a
// utility process main never blocked.
//
// `HelperProcess.call(type, job)` posts a job and answers what the engine answers there (engine.js, the same code as
// before U1). The process:
//   - starts with the first job and posts "ready" once it has loaded onnxruntime;
//   - ends at `kill()` (Free VRAM, the device switch, a folder change, a scan, a model's removal, the quit), where it
//     stands: its jobs are refused with one plain sentence and the next job starts a new one;
//   - ends by itself `idleMs` after the last job answered (5 minutes, §6 Q1), so SAM2's RAM and VRAM go back;
//   - that dies before "ready" (it could not start or load onnxruntime) leaves the engine to main's thread, and the
//     jobs that waited run there (today's behaviour, with its blocks); one that dies after it refuses its jobs, and a
//     second such death within a minute (§6 Q5) falls back to main's thread for the session.
// `status(device)` answers the runtime's part of helpers:status from the process's last answer (`lastStatus`), never
// asking it: what is loaded where, the failures, `process: { pid, state }`.
"use strict";

const path = require("node:path");
const { engine } = require("./engine");
const { providerCandidates, PROVIDER_LABELS } = require("./runtime");

const IDLE_MS = 5 * 60 * 1000;
const DEATH_WINDOW_MS = 60 * 1000;
const STOPPED = "The helper models' process stopped; try again.";
const KILLED = "The helper models were stopped (Free VRAM or a settings change); try again.";

/** The process: an Electron utility process where there is one, else a forked Node process (plain Node, the tests). */
function spawn(script, name) {
    try {
        const electron = require("electron");
        if (electron && typeof electron === "object" && electron.utilityProcess) {
            const p = electron.utilityProcess.fork(script, [], { serviceName: name });
            return { post: (m) => p.postMessage(m), kill: () => p.kill(), on: (ev, fn) => p.on(ev, fn), kind: "utility", child: p };
        }
    } catch (_) { /* not in Electron's main process */ }
    const p = require("node:child_process").fork(script, [], { serialization: "advanced", stdio: ["ignore", "inherit", "inherit", "ipc"] });
    return { post: (m) => p.send(m), kill: () => p.kill(), on: (ev, fn) => p.on(ev, fn), kind: "fork", child: p };
}

/** onnxruntime-node's version without loading its binary on main (Settings' runtime line before the first job). */
function ortVersion() {
    try { return require("onnxruntime-node/package.json").version; } catch (_) { return null; }
}

class HelperProcess {
    /**
     * @param {{ script?: string, idleMs?: number, name?: string }} [opts] `script` the process's entry (tests pass one
     *   that exits at once), `idleMs` 0 for no idle unload
     */
    constructor(opts = {}) {
        this.script = opts.script || path.join(__dirname, "helpers_process.js");
        this.idleMs = opts.idleMs == null ? IDLE_MS : opts.idleMs;
        this.name = opts.name || "Scumble helpers";
        this.proc = null;
        this.state = "off";         // "off" | "starting" | "ready" | "fallback"
        this.pid = null;
        this.local = null;          // the engine on this thread, once the process could not start or died twice
        this.pending = new Map();   // id -> { resolve, reject, type, job, t }
        this.seq = 0;
        this.lastStatus = null;     // the runtime's status from the process's last message
        this.deaths = [];           // when a process died after its "ready" (the last minute's)
        this.idleTimer = null;
        this.starts = 0;            // processes started (the tests, the measurement)
        this.onJob = null;          // optional hook: ({ type, ms, wallMs, error, pid }) per answered job (tools/helpers_perf.py)
    }

    _start() {
        if (this.proc || this.local) return;
        let proc;
        try { proc = spawn(this.script, this.name); }
        catch (err) { this._fallBack(err); return; }
        this.starts++;
        this.proc = proc;
        this.state = "starting";
        this.pid = null;
        let ready = false;
        proc.exited = new Promise((resolve) => { proc.onExit = resolve; });
        proc.on("message", (msg) => {
            if (this.proc !== proc || !msg) return;
            if (msg.type === "ready" && msg.id == null) {
                ready = true;
                this.state = "ready";
                this.pid = msg.pid;
                this.lastStatus = msg.status || this.lastStatus;
                return;
            }
            const job = this.pending.get(msg.id);
            if (!job) return;
            this.pending.delete(msg.id);
            if (msg.status) this.lastStatus = msg.status;
            if (this.onJob) { try { this.onJob({ type: job.type, ms: msg.ms, wallMs: Date.now() - job.t, error: msg.error || null, pid: this.pid }); } catch (_) { /* a probe's own fault */ } }
            if (msg.error) job.reject(new Error(msg.error)); else job.resolve(msg.result);
            this._armIdle();
        });
        proc.on("exit", (code) => {
            proc.onExit(code);
            if (this.proc !== proc) return;   // killed on purpose (`kill`): its jobs were refused there
            this.proc = null;
            this.pid = null;
            this.state = "off";
            this._clearIdle();
            this.lastStatus = this._offStatus();
            // dead before "ready": it could not start or load onnxruntime, so the engine runs here from now on
            if (!ready) { this._fallBack(new Error(`the helpers' process ended at its start (${code})`)); return; }
            const now = Date.now();
            this.deaths = this.deaths.filter((t) => now - t < DEATH_WINDOW_MS);
            this.deaths.push(now);
            const jobs = Array.from(this.pending.values());
            this.pending.clear();
            for (const job of jobs) job.reject(new Error(STOPPED));
            console.warn(`onnx: the helpers' process stopped (${code})`);
            if (this.deaths.length >= 2) this._fallBack(new Error("the helpers' process stopped twice within a minute"));
        });
        if (proc.kind === "fork") proc.on("error", (err) => console.warn("onnx: the helpers' process:", (err && err.message) || err));
    }

    /** The engine on this thread, and the jobs that waited for the process run on it. */
    _fallBack(err) {
        console.warn("onnx: the helper models run on the main thread:", (err && err.message) || err);
        this.local = engine();
        this.state = "fallback";
        this.pid = null;
        const jobs = Array.from(this.pending.values());
        this.pending.clear();
        for (const job of jobs) this._runLocal(job.type, job.job).then(job.resolve, job.reject);
    }

    _runLocal(type, job) {
        if (job && job.device) this.local.runtime.setDevice(job.device);
        return this.local[type](job);
    }

    /** What is left of the last status once the process is gone: no sessions, the failures kept for Settings. */
    _offStatus() {
        const s = this.lastStatus || {};
        return { ...s, active: {}, loaded: 0, failures: s.failures || {} };
    }

    _clearIdle() {
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    }

    /** The idle unload: restarted at every answer, never while a job is pending. */
    _armIdle() {
        this._clearIdle();
        if (!this.idleMs || !this.proc || this.pending.size) return;
        this.idleTimer = setTimeout(() => { this.idleTimer = null; if (!this.pending.size) this.kill(); }, this.idleMs);
        if (typeof this.idleTimer.unref === "function") this.idleTimer.unref();
    }

    /** One job (`objects`, `segment`, `cutout`, `depth`) -> what the engine answers. */
    call(type, job) {
        this._clearIdle();
        this._start();
        if (this.local) return this._runLocal(type, job);
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, type, job, t: Date.now() });
            try { this.proc.post({ ...job, id, type }); }
            catch (err) { this.pending.delete(id); reject(err); this._armIdle(); }
        });
    }

    /** Whether a job is under way. */
    busy() {
        return this.pending.size > 0;
    }

    /**
     * The process ended where it stands (its memory and VRAM back), its jobs refused; the next job starts a new one.
     * Resolves once it has exited (at most 2 s), so a model file it held can be deleted then, with the number of
     * sessions it held. In the fallback the engine here frees its sessions instead (`clear`: and drops its instances).
     * @param {{ clear?: boolean }} [opts]
     */
    async kill(opts = {}) {
        this._clearIdle();
        if (this.local) {
            const n = await this.local.free();
            if (opts.clear) this.local.clear();
            return n;
        }
        const p = this.proc;
        const loaded = (this.lastStatus && this.lastStatus.loaded) || 0;
        this.proc = null;
        this.pid = null;
        this.state = "off";
        this.lastStatus = this._offStatus();
        const jobs = Array.from(this.pending.values());
        this.pending.clear();
        for (const job of jobs) job.reject(new Error(KILLED));
        if (!p) return 0;
        try { p.kill(); } catch (_) { /* gone already */ }
        let timer = null;
        await Promise.race([p.exited, new Promise((resolve) => { timer = setTimeout(resolve, 2000); })]);
        clearTimeout(timer);
        return loaded;
    }

    /** The runtime's part of helpers:status for the device in the settings. */
    status(device) {
        const base = this.local ? this.local.status() : (this.lastStatus || {});
        return {
            device,
            candidates: providerCandidates(device),
            labels: PROVIDER_LABELS,
            active: base.active || {},
            failures: base.failures || {},
            loaded: base.loaded || 0,
            version: base.version || ortVersion(),
            process: { pid: this.pid, state: this.state },
        };
    }
}

module.exports = { HelperProcess, IDLE_MS, DEATH_WINDOW_MS, STOPPED, KILLED };
