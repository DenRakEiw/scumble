// Object removal with LaMa (Suvorov et al., "Resolution-robust Large Mask Inpainting with
// Fourier Convolutions", the Big-LaMa weights) through ONNX Runtime.
//
// Model file: the Carve export (Carve/LaMa-ONNX, lama_fp32.onnx, Apache-2.0), fixed size:
//   image [1,3,512,512] float32 RGB in 0..1, mask [1,1,512,512] float32 (1 = fill)
//   -> output [1,3,512,512] float32 in 0..255; outside the mask it is the input times 255.
// The graph blanks the masked pixels itself (image * (1 - mask)), so the bytes go in as they
// are. The renderer crops and scales the region to 512 x 512 and samples the answer back
// (renderer/editor/inpaint_remove.js).
//
// CPU only: DirectML (onnxruntime-node 1.29) fails at the first run on a MatMul of the
// Fourier unit's inverse transform (`fu/rttn/MatMul_5`, 0x80070057) at every optimisation
// level and with the batch dimension fixed (measured 2026-09-28). On the CPU the session
// takes about 9 s to load (the graph has 17k nodes) and a run 1.5 s.
//
// A process of its own (lama_process.js: an Electron utility process in the app, a forked
// Node process under plain Node): onnxruntime-node runs `InferenceSession.create` and `run`
// as synchronous native calls on the thread that calls them, so on the main thread its ten
// seconds would hold every IPC channel, the ComfyUI events, MCP and the autosave. A worker
// thread cannot be stopped inside such a call: `terminate()` during a load or a run, or a
// quit meanwhile, ended the whole process with 0xC0000409 when the call returned (measured
// 2026-09-28). A process is killed where it stands. Where the process dies before its first
// answer (it could not start or load onnxruntime), the same engine runs here instead,
// blocking, as SAM2 and the matting models do.
"use strict";

const path = require("node:path");
const { normalise } = require("./sam2");

const SIZE = 512;

/** Load and run the model with the given onnxruntime module; shared by LaMa's process and the fallback here. */
function engine(ort) {
    let session = null, loading = null;
    return {
        /** The session, created once; a second request while it loads waits for the same load. */
        load(file) {
            if (session) return Promise.resolve({ provider: "cpu", loadMs: 0 });
            if (!loading) {
                const t0 = Date.now();
                loading = ort.InferenceSession.create(file, { executionProviders: ["cpu"], graphOptimizationLevel: "all", logSeverityLevel: 3 })
                    .then((s) => { session = s; return { provider: "cpu", loadMs: Date.now() - t0 }; })
                    .finally(() => { loading = null; });
            }
            return loading;
        },
        /** RGBA 512² and a 512² mask (not 0 = fill) -> RGBA 512², alpha 255; outside the mask the input's bytes. */
        async run(file, rgba, mask) {
            await this.load(file);
            const n = SIZE * SIZE;
            const m = new Float32Array(n);
            let holes = 0;
            for (let i = 0; i < n; i++) if (mask[i]) { m[i] = 1; holes++; }
            const feeds = {
                image: new ort.Tensor("float32", normalise(rgba, [0, 0, 0], [1, 1, 1], SIZE), [1, 3, SIZE, SIZE]),
                mask: new ort.Tensor("float32", m, [1, 1, SIZE, SIZE]),
            };
            const t0 = Date.now();
            const out = await session.run(feeds);
            const t = out[session.outputNames[0]];
            if (!t || !t.data || t.data.length !== 3 * n) throw new Error(`unexpected output shape ${t ? t.dims.join("×") : "none"} from LaMa`);
            const d = t.data;
            const res = new Uint8Array(4 * n);
            const byte = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));
            for (let i = 0, j = 0; i < n; i++, j += 4) {
                if (m[i]) { res[j] = byte(d[i]); res[j + 1] = byte(d[n + i]); res[j + 2] = byte(d[2 * n + i]); }
                else { res[j] = rgba[j]; res[j + 1] = rgba[j + 1]; res[j + 2] = rgba[j + 2]; }
                res[j + 3] = 255;
            }
            return { rgba: res, size: SIZE, provider: "cpu", ms: Date.now() - t0, holes };
        },
    };
}

/** LaMa's process: an Electron utility process where there is one, else a forked Node process (plain Node, the tests). */
function spawn(script) {
    try {
        const electron = require("electron");
        if (electron && typeof electron === "object" && electron.utilityProcess) {
            const p = electron.utilityProcess.fork(script, [], { serviceName: "Scumble LaMa" });
            return { post: (m) => p.postMessage(m), kill: () => p.kill(), on: (ev, fn) => p.on(ev, fn), kind: "utility" };
        }
    } catch (_) { /* not in Electron's main process */ }
    const p = require("node:child_process").fork(script, [], { serialization: "advanced", stdio: ["ignore", "inherit", "inherit", "ipc"] });
    return { post: (m) => p.send(m), kill: () => p.kill(), on: (ev, fn) => p.on(ev, fn), kind: "fork" };
}

class Lama {
    /**
     * @param {object} model registry entry
     * @param {string} file the .onnx path
     */
    constructor(model, file) {
        this.model = model;
        this.file = file;
        this.proc = null;
        this.local = null;       // the engine here, once the process could not start
        this.pending = new Map();   // id -> { resolve, reject, type, image, mask }
        this.seq = 0;
    }

    _start() {
        if (this.proc || this.local) return;
        let proc;
        try { proc = spawn(path.join(__dirname, "lama_process.js")); }
        catch (err) { this._fallBack(err); return; }
        let answered = false;
        proc.on("message", (msg) => {
            answered = true;
            const job = this.pending.get(msg && msg.id);
            if (!job) return;
            this.pending.delete(msg.id);
            if (msg.error) job.reject(new Error(msg.error)); else job.resolve(msg.result);
        });
        proc.on("exit", (code) => {
            if (this.proc !== proc) return;   // killed on purpose (`kill`): its jobs were answered there
            this.proc = null;
            // dead before it ever answered: it could not start or load onnxruntime, so the engine runs here from now on
            if (!answered) { this._fallBack(new Error(`LaMa's process ended at its start (${code})`)); return; }
            for (const job of this.pending.values()) job.reject(new Error(`LaMa's process stopped (${code})`));
            this.pending.clear();
        });
        if (proc.kind === "fork") proc.on("error", (err) => console.warn("onnx: LaMa's process:", err && err.message || err));
        this.proc = proc;
    }

    /** The engine on this thread, and the jobs that waited for the process run on it. */
    _fallBack(err) {
        console.warn("onnx: LaMa runs on the main thread:", err && err.message || err);
        this.local = engine(require("./runtime").loadOrt());
        const jobs = Array.from(this.pending.values());
        this.pending.clear();
        for (const job of jobs) this._runLocal(job.type, job).then(job.resolve, job.reject);
    }

    _runLocal(type, payload) {
        return type === "warm" ? this.local.load(this.file) : this.local.run(this.file, payload.image, payload.mask);
    }

    _call(type, payload) {
        this._start();
        if (this.local) return this._runLocal(type, payload);
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, type, ...payload });
            this.proc.post({ id, type, file: this.file, ...payload });
        });
    }

    /** The session, loaded ahead of a run (about 9 s the first time). -> { provider, loadMs } */
    warm() {
        return this._call("warm", {});
    }

    /**
     * RGBA 512 x 512 and a mask of 512 x 512 bytes (not 0 = fill) -> { rgba (RGBA 512², alpha 255), size, provider, ms,
     * holes }. The pixels outside the mask come back as they went in.
     */
    run(rgba, mask) {
        return this._call("run", { image: new Uint8Array(rgba), mask: new Uint8Array(mask) });
    }

    /** Whether a load or a run is under way (the quit waits for nothing: `kill` ends the process where it stands). */
    busy() {
        return this.pending.size > 0;
    }

    /** The process ended (its memory back), its jobs refused; the next job starts it again. The fallback here stays. */
    kill() {
        const p = this.proc;
        this.proc = null;
        for (const job of this.pending.values()) job.reject(new Error("LaMa was stopped"));
        this.pending.clear();
        if (p) { try { p.kill(); } catch (_) { /* gone already */ } }
    }
}

module.exports = { Lama, SIZE, engine };
