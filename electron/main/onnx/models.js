// The helper model registry: which ONNX files exist, where they come from, where they
// are looked for on disk, and the downloader (resumable, with progress, Hugging Face
// token for gated repos). No Electron here: the model folder is passed in, so the
// module also runs under plain Node for tests (tools/helpers_test.js).
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const HF = "https://huggingface.co";
const IMAGENET = { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] };

function sam2(id, variant, label, encSize, note) {
    const repo = "vietanhdev/segment-anything-2-onnx-models";
    return {
        id, kind: "sam2", label, note,
        source: repo, sourceUrl: `${HF}/${repo}`, license: "Apache-2.0",
        files: [
            { name: `sam2_hiera_${variant}.encoder.onnx`, role: "encoder", size: encSize, url: `${HF}/${repo}/resolve/main/sam2_hiera_${variant}.encoder.onnx` },
            { name: `sam2_hiera_${variant}.decoder.onnx`, role: "decoder", size: 20640886, url: `${HF}/${repo}/resolve/main/sam2_hiera_${variant}.decoder.onnx` },
        ],
    };
}

const MODELS = [
    sam2("sam2_tiny", "tiny", "SAM2 tiny", 134261315, "fastest, coarser objects"),
    sam2("sam2_small", "small", "SAM2 small", 162703493, ""),
    sam2("sam2_base_plus", "base_plus", "SAM2 base+", 339781223, "same weights the ComfyUI helper uses"),
    sam2("sam2_large", "large", "SAM2 large", 889361980, "best masks, slowest"),
    {
        id: "birefnet_lite", kind: "matting", label: "BiRefNet lite", note: "fast, good general cutouts",
        source: "onnx-community/BiRefNet_lite-ONNX", sourceUrl: `${HF}/onnx-community/BiRefNet_lite-ONNX`, license: "MIT",
        input: 1024, ...IMAGENET,
        files: [{ name: "birefnet_lite.onnx", role: "model", size: 224005088, url: `${HF}/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx` }],
    },
    {
        id: "birefnet", kind: "matting", label: "BiRefNet", note: "finer edges (hair, fur), 4× the size",
        source: "onnx-community/BiRefNet-ONNX", sourceUrl: `${HF}/onnx-community/BiRefNet-ONNX`, license: "MIT",
        input: 1024, ...IMAGENET,
        files: [{ name: "birefnet.onnx", role: "model", size: 972666916, url: `${HF}/onnx-community/BiRefNet-ONNX/resolve/main/onnx/model.onnx` }],
    },
    {
        id: "rmbg14", kind: "matting", label: "RMBG-1.4", note: "BRIA, non-commercial licence",
        source: "briaai/RMBG-1.4", sourceUrl: `${HF}/briaai/RMBG-1.4`, license: "bria-rmbg-1.4 (non-commercial)",
        input: 1024, mean: [0.5, 0.5, 0.5], std: [1, 1, 1],
        files: [{ name: "rmbg14.onnx", role: "model", size: 176153355, url: `${HF}/briaai/RMBG-1.4/resolve/main/onnx/model.onnx` }],
    },
    {
        id: "rmbg2", kind: "matting", label: "RMBG-2.0", note: "BRIA, non-commercial; gated: accept the licence on Hugging Face and save a token below",
        source: "briaai/RMBG-2.0", sourceUrl: `${HF}/briaai/RMBG-2.0`, license: "CC BY-NC 4.0 (BRIA)", gated: true,
        input: 1024, ...IMAGENET,
        files: [{ name: "rmbg2.onnx", role: "model", size: 1024331469, url: `${HF}/briaai/RMBG-2.0/resolve/main/onnx/model.onnx` }],
    },
];

const byId = (id) => MODELS.find((m) => m.id === id) || null;

/** Subfolders of the model folder that are searched too (a linked ComfyUI models folder). */
const SUBDIRS = ["", "onnx", "sam2", "RMBG", "BiRefNet", "rembg"];

function isComfyModelsDir(dir) {
    return fs.existsSync(path.join(dir, "checkpoints")) || fs.existsSync(path.join(dir, "diffusion_models"));
}

/** Where downloads land: the folder itself, or its onnx/ subfolder when it is a ComfyUI models folder. */
function downloadDir(dir) {
    return isComfyModelsDir(dir) ? path.join(dir, "onnx") : dir;
}

function findFile(dir, name) {
    for (const sub of SUBDIRS) {
        const p = path.join(dir, sub, name);
        try { const st = fs.statSync(p); if (st.isFile() && st.size > 0) return { path: p, bytes: st.size }; } catch (_) { /* next */ }
    }
    return null;
}

/** The model's files on disk (or not), for one folder. */
function locate(model, dir) {
    const files = model.files.map((f) => {
        const hit = findFile(dir, f.name);
        let partial = 0;
        try { partial = fs.statSync(path.join(downloadDir(dir), f.name + ".part")).size; } catch (_) { partial = 0; }
        return { name: f.name, role: f.role, size: f.size, path: hit ? hit.path : null, bytes: hit ? hit.bytes : 0, present: !!hit, partial };
    });
    return { files, present: files.every((f) => f.present), bytes: files.reduce((a, f) => a + f.bytes, 0), size: files.reduce((a, f) => a + f.size, 0) };
}

function describeAll(dir) {
    return MODELS.map((m) => ({ id: m.id, kind: m.kind, label: m.label, note: m.note, source: m.source, sourceUrl: m.sourceUrl, license: m.license, gated: !!m.gated, ...locate(m, dir) }));
}

/** Paths keyed by role for a present model, or null. */
function paths(model, dir) {
    const loc = locate(model, dir);
    if (!loc.present) return null;
    const out = {};
    for (const f of loc.files) out[f.role] = f.path;
    return out;
}

// ---- downloads ----------------------------------------------------------------------------

class Downloader {
    /**
     * @param {() => string} dirProvider   the model folder (may change between downloads)
     * @param {() => string} tokenProvider Hugging Face token ("" when none)
     * @param {(ev) => void} onProgress    { id, file, received, total, done, error, cancelled }
     */
    constructor(dirProvider, tokenProvider, onProgress) {
        this.dirProvider = dirProvider;
        this.tokenProvider = tokenProvider;
        this.onProgress = onProgress || (() => {});
        this.active = new Map();   // id -> { controller, file, received, total }
    }

    running() {
        const out = {};
        for (const [id, a] of this.active) out[id] = { file: a.file, received: a.received, total: a.total };
        return out;
    }

    async download(id) {
        const model = byId(id);
        if (!model) throw new Error("unknown model " + id);
        if (this.active.has(id)) throw new Error(model.label + " is already downloading");
        const dir = downloadDir(this.dirProvider());
        await fsp.mkdir(dir, { recursive: true });
        const controller = new AbortController();
        const state = { controller, file: "", received: 0, total: 0 };
        this.active.set(id, state);
        try {
            for (const f of model.files) {
                if (findFile(this.dirProvider(), f.name)) continue;
                state.file = f.name; state.received = 0; state.total = f.size;
                await this._file(f, path.join(dir, f.name), model, state);
            }
            this.onProgress({ id, done: true });
            return locate(model, this.dirProvider());
        } catch (err) {
            const cancelled = controller.signal.aborted;
            this.onProgress({ id, file: state.file, error: cancelled ? null : String(err.message || err), cancelled });
            if (!cancelled) throw err;
            return null;
        } finally {
            this.active.delete(id);
        }
    }

    cancel(id) {
        const a = this.active.get(id);
        if (a) a.controller.abort();
        return !!a;
    }

    async _file(f, dest, model, state) {
        const part = dest + ".part";
        let have = 0;
        try { have = (await fsp.stat(part)).size; } catch (_) { have = 0; }
        if (have >= f.size && f.size) have = 0;   // a stale .part larger than the file: start over
        const headers = { "user-agent": "scumble/0.1" };
        const token = this.tokenProvider();
        if (token) headers.authorization = "Bearer " + token;
        if (have > 0) headers.range = `bytes=${have}-`;
        const r = await fetch(f.url, { headers, signal: state.controller.signal, redirect: "follow" });
        if (r.status === 401 || r.status === 403) {
            throw new Error(model.gated
                ? `${model.label} is gated on Hugging Face (${r.status}): accept its licence at ${model.sourceUrl} and save your Hugging Face token in the settings.`
                : `Hugging Face refused the download (${r.status}).`);
        }
        if (r.status === 416) { have = 0; return this._file(Object.assign({}, f), dest, model, state); }
        if (!r.ok) throw new Error(`download of ${f.name} failed: HTTP ${r.status}`);
        const append = r.status === 206 && have > 0;
        if (!append) have = 0;
        const len = Number(r.headers.get("content-length")) || 0;
        state.received = have;
        state.total = append ? have + len : (len || f.size);
        let last = 0;
        const onProgress = this.onProgress;
        const id = model.id;
        const counter = new Transform({
            transform(chunk, _enc, cb) {
                state.received += chunk.length;
                const now = Date.now();
                if (now - last > 200) { last = now; onProgress({ id, file: f.name, received: state.received, total: state.total }); }
                cb(null, chunk);
            },
        });
        await pipeline(Readable.fromWeb(r.body), counter, fs.createWriteStream(part, { flags: append ? "a" : "w" }));
        const got = (await fsp.stat(part)).size;
        if (f.size && got !== f.size) throw new Error(`${f.name}: got ${got} bytes, expected ${f.size} (the file on Hugging Face changed? delete the .part file and retry)`);
        await fsp.rename(part, dest);
        onProgress({ id, file: f.name, received: got, total: got });
    }
}

/** Delete a model's files (and any .part) from the folder. */
async function remove(id, dir) {
    const model = byId(id);
    if (!model) throw new Error("unknown model " + id);
    let n = 0;
    for (const f of model.files) {
        const hit = findFile(dir, f.name);
        if (hit) { await fsp.unlink(hit.path); n++; }
        try { await fsp.unlink(path.join(downloadDir(dir), f.name + ".part")); } catch (_) { /* none */ }
    }
    return n;
}

module.exports = { MODELS, byId, locate, describeAll, paths, downloadDir, isComfyModelsDir, Downloader, remove, IMAGENET };
