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
//   - is retired (`retire`: Free VRAM and the free before a local ComfyUI run, the device switch, a folder change, a
//     scan): new jobs go to a new process at once, and the old one ends as soon as the jobs it has answered, at most
//     `drainMs` (8 s) later; what it has not answered by then is refused with a sentence naming the cause. Before U1
//     a free released the sessions and a job under way went on (its next decode loaded them again), so a cutout on
//     another tab or an agent's second call lands as it did then;
//   - is killed where it stands (`kill`: a model's removal, the quit), its jobs refused with the cause;
//   - ends by itself `idleMs` after the last job answered (5 minutes, §6 Q1), so SAM2's RAM and VRAM go back;
//   - that dies before "ready" (it could not start or load onnxruntime) leaves the engine to main's thread, and the
//     jobs that waited run there (today's behaviour, with its blocks); one that dies after it refuses its jobs, and a
//     second such death within a minute (§6 Q5) falls back to main's thread for the session.
// `status(device)` answers the runtime's part of helpers:status from the process's last answer (`lastStatus`), never
// asking it: what is loaded where, the failures, `process: { pid, state, retiring }`.
"use strict";

const path = require("node:path");
const { engine } = require("./engine");
const { providerCandidates, PROVIDER_LABELS } = require("./runtime");

const IDLE_MS = 5 * 60 * 1000;
const DEATH_WINDOW_MS = 60 * 1000;
const DRAIN_MS = 8000;
const STOPPED = "The helper models' process stopped; try again.";
/** A job's refusal when main ended its process, by the cause main gave (`retire` / `kill`). */
const REASONS = {
    free: "The helper models were unloaded to free VRAM (Free VRAM, or a local ComfyUI run starting) before this job finished; try again.",
    folder: "The helper models' folder changed (a scan, or another folder in Settings › Helpers) before this job finished; try again.",
    device: "The helper models' device changed (Settings › Helpers) before this job finished; try again.",
    remove: "A helper model was removed (Settings › Helpers) while this job ran; try again.",
    quit: "Scumble is closing.",
    idle: STOPPED,
};

/** The process: an Electron utility process where there is one, else a forked Node process (plain Node, the tests). */
function spawn(script, name) {
    try {
        const electron = require("electron");
        if (electron && typeof electron === "object" && electron.utilityProcess) {
            const p = electron.utilityProcess.fork(script, [], { serviceName: name });
            let spawned = false;
            p.once("spawn", () => { spawned = true; });
            // UtilityProcess.kill() does nothing before "spawn" (no pid yet): a kill that early is done at the spawn, or
            // the process would load its models for the queued job and live on without anyone holding it
            const kill = () => {
                try { p.kill(); } catch (_) { /* gone already */ }
                if (!spawned) p.once("spawn", () => { try { p.kill(); } catch (_) { /* gone already */ } });
            };
            return { post: (m) => p.postMessage(m), kill, on: (ev, fn) => p.on(ev, fn), kind: "utility", child: p };
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
     * @param {{ script?: string, idleMs?: number, drainMs?: number, name?: string }} [opts] `script` the process's entry
     *   (tests pass one that exits at once), `idleMs` 0 for no idle unload, `drainMs` how long a retired process may
     *   take to answer its jobs
     */
    constructor(opts = {}) {
        this.script = opts.script || path.join(__dirname, "helpers_process.js");
        this.idleMs = opts.idleMs == null ? IDLE_MS : opts.idleMs;
        this.drainMs = opts.drainMs == null ? DRAIN_MS : opts.drainMs;
        this.name = opts.name || "Scumble helpers";
        this.proc = null;           // the process new jobs go to; each holds its own `pending` (id -> job)
        this.retiring = new Set();  // retired processes still answering their jobs
        this.state = "off";         // "off" | "starting" | "ready" | "fallback"
        this.pid = null;
        this.local = null;          // the engine on this thread, once the process could not start or died twice
        this.seq = 0;
        this.lastStatus = null;     // the runtime's status from the current process's last message
        this.deaths = [];           // when a process died after its "ready" (the last minute's)
        this.idleTimer = null;
        this.starts = 0;            // processes started (the tests, the measurement)
        this.onJob = null;          // optional hook: ({ type, ms, wallMs, error, pid }) per answered job (tools/helpers_perf.py)
    }

    _start() {
        if (this.proc || this.local) return;
        let proc;
        try { proc = spawn(this.script, this.name); }
        catch (err) { this._fallBack(err, []); return; }
        this.starts++;
        proc.pending = new Map();
        proc.ready = false;
        proc.pid = null;
        proc.exited = new Promise((resolve) => { proc.onExit = resolve; });
        this.proc = proc;
        this.state = "starting";
        this.pid = null;
        proc.on("message", (msg) => this._message(proc, msg));
        proc.on("exit", (code) => this._exit(proc, code));
        if (proc.kind === "fork") proc.on("error", (err) => console.warn("onnx: the helpers' process:", (err && err.message) || err));
    }

    _message(proc, msg) {
        if (!msg) return;
        const current = this.proc === proc;
        if (msg.type === "ready" && msg.id == null) {
            proc.ready = true;
            proc.pid = msg.pid;
            if (current) { this.state = "ready"; this.pid = msg.pid; this.lastStatus = msg.status || this.lastStatus; }
            return;
        }
        const job = proc.pending.get(msg.id);
        if (!job) return;
        proc.pending.delete(msg.id);
        if (current && msg.status) this.lastStatus = msg.status;
        if (this.onJob) { try { this.onJob({ type: job.type, ms: msg.ms, wallMs: Date.now() - job.t, error: msg.error || null, pid: proc.pid }); } catch (_) { /* a probe's own fault */ } }
        if (msg.error) job.reject(new Error(msg.error)); else job.resolve(msg.result);
        if (current) this._armIdle();
        else if (!proc.pending.size && proc.drained) proc.drained();
    }

    _exit(proc, code) {
        proc.onExit(code);
        this.retiring.delete(proc);
        const jobs = Array.from(proc.pending.values());
        proc.pending.clear();
        if (this.proc !== proc) {
            // a retired process that died before it answered all (main refuses with the cause when it ends one itself)
            for (const job of jobs) job.reject(new Error(STOPPED));
            return;
        }
        this.proc = null;
        this.pid = null;
        this.state = "off";
        this._clearIdle();
        this.lastStatus = this._offStatus();
        // dead before "ready": it could not start or load onnxruntime, so the engine runs here from now on
        if (!proc.ready) { this._fallBack(new Error(`the helpers' process ended at its start (${code})`), jobs); return; }
        const now = Date.now();
        this.deaths = this.deaths.filter((t) => now - t < DEATH_WINDOW_MS);
        this.deaths.push(now);
        for (const job of jobs) job.reject(new Error(STOPPED));
        console.warn(`onnx: the helpers' process stopped (${code})`);
        if (this.deaths.length >= 2) this._fallBack(new Error("the helpers' process stopped twice within a minute"), []);
    }

    /** The engine on this thread, and the jobs that waited for the process run on it. */
    _fallBack(err, jobs) {
        console.warn("onnx: the helper models run on the main thread:", (err && err.message) || err);
        this.local = engine();
        this.state = "fallback";
        this.pid = null;
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
        if (!this.idleMs || !this.proc || this.proc.pending.size) return;
        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            const p = this.proc;
            if (!p || p.pending.size) return;
            this._detach();
            this._end(p, "idle");
        }, this.idleMs);
        if (typeof this.idleTimer.unref === "function") this.idleTimer.unref();
    }

    /** New jobs no longer go to the current process (the next one starts another). */
    _detach() {
        this.proc = null;
        this.pid = null;
        this.state = "off";
        this.lastStatus = this._offStatus();
    }

    /** One process ended where it stands, what it has not answered refused with the cause; resolves at its exit (at most 2 s). */
    _end(p, reason) {
        this.retiring.add(p);
        const jobs = Array.from(p.pending.values());
        p.pending.clear();
        for (const job of jobs) job.reject(new Error(REASONS[reason] || STOPPED));
        try { p.kill(); } catch (_) { /* gone already */ }
        let timer = null;
        return Promise.race([p.exited, new Promise((resolve) => { timer = setTimeout(resolve, 2000); })])
            .then(() => { clearTimeout(timer); this.retiring.delete(p); });
    }

    /** One job (`objects`, `segment`, `cutout`, `depth`) -> what the engine answers. */
    call(type, job) {
        this._clearIdle();
        this._start();
        if (this.local) return this._runLocal(type, job);
        const proc = this.proc;
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            proc.pending.set(id, { resolve, reject, type, job, t: Date.now() });
            try { proc.post({ ...job, id, type }); }
            catch (err) { proc.pending.delete(id); reject(err); this._armIdle(); }
        });
    }

    /** Whether a job is under way (in the current process or a retired one). */
    busy() {
        if (this.proc && this.proc.pending.size) return true;
        for (const p of this.retiring) if (p.pending.size) return true;
        return false;
    }

    /**
     * The process retired (Free VRAM, a local ComfyUI run's free, the device switch, a folder change, a scan): new jobs
     * start a new process at once; this one ends once it has answered its jobs, at most `drainMs` later (then what is
     * left is refused with `reason`'s sentence). Resolves at its exit with the number of sessions it held. In the
     * fallback the engine here frees its sessions instead (`clear`: and drops its instances), as before U1: a job under
     * way loads the sessions it needs again.
     * @param {{ reason?: string, clear?: boolean, drainMs?: number }} [opts]
     */
    async retire(opts = {}) {
        const reason = opts.reason || "free";
        this._clearIdle();
        if (this.local) {
            const n = await this.local.free();
            if (opts.clear) this.local.clear();
            return n;
        }
        const p = this.proc;
        const loaded = (this.lastStatus && this.lastStatus.loaded) || 0;
        this._detach();
        if (!p) return 0;
        this.retiring.add(p);
        if (p.pending.size) {
            let timer = null;
            await Promise.race([
                new Promise((resolve) => { p.drained = resolve; }),
                p.exited,
                new Promise((resolve) => { timer = setTimeout(resolve, opts.drainMs == null ? this.drainMs : opts.drainMs); }),
            ]);
            clearTimeout(timer);
        }
        await this._end(p, reason);
        return loaded;
    }

    /**
     * The process ended where it stands (its memory and VRAM back), its jobs refused with `reason`'s sentence, and so
     * is every retired one still answering (a model's removal: no process may hold the file; the quit). Resolves once
     * they have exited (at most 2 s), with the number of sessions the current one held. In the fallback the engine here
     * frees its sessions instead (`clear`: and drops its instances).
     * @param {{ reason?: string, clear?: boolean }} [opts]
     */
    async kill(opts = {}) {
        const reason = opts.reason || "remove";
        this._clearIdle();
        if (this.local) {
            const n = await this.local.free();
            if (opts.clear) this.local.clear();
            return n;
        }
        const p = this.proc;
        const loaded = (this.lastStatus && this.lastStatus.loaded) || 0;
        this._detach();
        const all = [p, ...this.retiring].filter(Boolean);
        await Promise.all(all.map((x) => this._end(x, reason)));
        return p ? loaded : 0;
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
            process: { pid: this.pid, state: this.state, retiring: this.retiring.size },
        };
    }
}

module.exports = { HelperProcess, IDLE_MS, DEATH_WINDOW_MS, DRAIN_MS, STOPPED, REASONS };
