// ONNX Runtime sessions for the in-app helper models (SAM2, background removal).
// One session per model file, created on first use with the best execution provider
// the machine offers: DirectML on Windows, CUDA on Linux, CoreML on macOS, CPU as the
// fallback everywhere. The provider that worked is remembered for the settings dialog.
// onnxruntime-node is loaded lazily so the app starts even when its binary is missing.
"use strict";

let ort = null;

function loadOrt() {
    if (!ort) ort = require("onnxruntime-node");
    return ort;
}

/**
 * Execution providers to try, in order, for the requested device ("auto" | "gpu" | "cpu"). `auto` is a model's own
 * list for the "auto" device (background removal: the CPU, docs/BUGS.md B5), else the GPU first.
 */
function providerCandidates(device, auto = null) {
    const gpu = process.platform === "win32" ? ["dml"] : process.platform === "linux" ? ["cuda"] : ["coreml"];
    if (device === "cpu") return ["cpu"];
    if (device === "gpu") return [...gpu, "cpu"];
    return Array.isArray(auto) && auto.length ? auto : [...gpu, "cpu"];
}

const PROVIDER_LABELS = { dml: "DirectML (GPU)", cuda: "CUDA (GPU)", coreml: "CoreML", cpu: "CPU", webgpu: "WebGPU" };

class Runtime {
    constructor() {
        this.device = "auto";
        this.sessions = new Map();   // file -> { session, provider }
        this.failures = {};          // provider -> last error message
        this.loading = new Map();    // file -> promise (no double loads)
    }

    setDevice(device) {
        if (device !== this.device) { this.device = device; this.free().catch(() => {}); }
    }

    /** The session for a model file, created on first use; `auto` the providers it prefers on the "auto" device. */
    session(file, { auto = null } = {}) {
        const have = this.sessions.get(file);
        if (have) return Promise.resolve(have);
        if (this.loading.has(file)) return this.loading.get(file);
        const p = this._create(file, auto).finally(() => this.loading.delete(file));
        this.loading.set(file, p);
        return p;
    }

    async _create(file, auto = null) {
        const o = loadOrt();
        let last = null;
        for (const provider of providerCandidates(this.device, auto)) {
            const opts = { executionProviders: [provider], graphOptimizationLevel: "all", logSeverityLevel: 3 };
            if (provider === "dml") { opts.executionMode = "sequential"; opts.enableMemPattern = false; }
            // the CPU arena keeps its peak for the session's life and never gives it back: BiRefNet lite at 1024 x 1024
            // held 18.2 GB of main's private bytes with it, 0.37 GB without, at the same speed (measured 2026-10-07, B5)
            if (provider === "cpu") opts.enableCpuMemArena = false;
            try {
                const session = await o.InferenceSession.create(file, opts);
                const entry = { session, provider, file };
                this.sessions.set(file, entry);
                return entry;
            } catch (err) {
                last = err;
                this.failures[provider] = String(err && err.message || err).split("\n")[0].slice(0, 300);
                console.warn(`onnx: ${provider} failed for ${file}: ${this.failures[provider]}`);
            }
        }
        throw new Error("No execution provider could load the model: " + (last && last.message || last));
    }

    /** Release one model file's session (the next use loads it again). */
    async release(file) {
        const e = this.sessions.get(file);
        if (!e) return false;
        this.sessions.delete(file);
        try { await e.session.release(); } catch (_) { /* already gone */ }
        return true;
    }

    /** Release every session (VRAM back to the renderer / ComfyUI). */
    async free() {
        const entries = Array.from(this.sessions.values());
        this.sessions.clear();
        for (const e of entries) { try { await e.session.release(); } catch (_) { /* already gone */ } }
        return entries.length;
    }

    tensor(type, data, dims) {
        const o = loadOrt();
        return new o.Tensor(type, data, dims);
    }

    status() {
        const active = {};
        for (const e of this.sessions.values()) active[e.file] = e.provider;
        return {
            device: this.device,
            candidates: providerCandidates(this.device),
            labels: PROVIDER_LABELS,
            active,
            failures: this.failures,
            loaded: this.sessions.size,
            version: (() => { try { return loadOrt().env.versions.node; } catch (_) { return null; } })(),
        };
    }
}

module.exports = { Runtime, providerCandidates, PROVIDER_LABELS, loadOrt };
