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

/**
 * The model's files on disk (or not), for one folder: the registry name in the folder and
 * its known subfolders first, else a link a scan made (`links[id][role]`: the same file
 * under another name or in another place, see `scanFolder` / `matchScan`).
 */
function locate(model, dir, links = null) {
    const linked = (links && links[model.id]) || null;
    const files = model.files.map((f) => {
        let hit = findFile(dir, f.name);
        let isLink = false;
        if (!hit && linked && linked[f.role]) {
            try {
                const st = fs.statSync(linked[f.role]);
                if (st.isFile() && st.size > 0) { hit = { path: linked[f.role], bytes: st.size }; isLink = true; }
            } catch (_) { /* the linked file is gone: not present */ }
        }
        let partial = 0;
        try { partial = fs.statSync(path.join(downloadDir(dir), f.name + ".part")).size; } catch (_) { partial = 0; }
        return {
            name: f.name, role: f.role, size: f.size, path: hit ? hit.path : null,
            rel: hit ? path.relative(dir, hit.path).split(path.sep).join("/") : null,
            bytes: hit ? hit.bytes : 0, present: !!hit, linked: isLink, partial,
        };
    });
    return { files, present: files.every((f) => f.present), linked: files.some((f) => f.linked), bytes: files.reduce((a, f) => a + f.bytes, 0), size: files.reduce((a, f) => a + f.size, 0) };
}

function describeAll(dir, links = null, elsewhere = null) {
    return MODELS.map((m) => ({ id: m.id, kind: m.kind, label: m.label, note: m.note, source: m.source, sourceUrl: m.sourceUrl, license: m.license, gated: !!m.gated, ...locate(m, dir, links), elsewhere: (elsewhere && elsewhere[m.id]) || [] }));
}

/** Paths keyed by role for a present model, or null. */
function paths(model, dir, links = null) {
    const loc = locate(model, dir, links);
    if (!loc.present) return null;
    const out = {};
    for (const f of loc.files) out[f.role] = f.path;
    return out;
}

// ---- scanning a folder: the same files under other names, and weights in other formats ---
//
// A ComfyUI models folder rarely holds our file names. The ONNX exports arrive as Hugging
// Face snapshots (`RMBG-2.0/onnx/model.onnx`) or under the exporter's names, and the
// ComfyUI nodes themselves keep PyTorch weights (`sam2/sam2_hiera_tiny.safetensors`,
// `RMBG/RMBG-2.0/model.safetensors`), which ONNX Runtime cannot load. The scan walks the
// folder once, links every ONNX file it can attribute to a registry entry (by exact name,
// by the exact byte size the registry carries, or by the snapshot layout), and reports the
// other formats per model, so the settings row can say why a model is not usable.

const WEIGHT_EXT = new Set([".onnx", ".safetensors", ".pt", ".pth", ".bin", ".ckpt"]);
const SKIP_DIRS = new Set(["__pycache__", "node_modules"]);
const SCAN_MAX_FILES = 50000;
const SCAN_MAX_DEPTH = 6;

/** Where the same ONNX file sits in a Hugging Face snapshot (relative path, lower case, `/`). */
const ONNX_ALIASES = {
    birefnet_lite: /birefnet[^/]*lite[^/]*\/onnx\/model\.onnx$/,
    birefnet: /birefnet(?![^/]*lite)[^/]*\/onnx\/model\.onnx$/,
    rmbg14: /rmbg[_-]?1\.4[^/]*\/onnx\/model\.onnx$/,
    rmbg2: /rmbg[_-]?2\.0[^/]*\/onnx\/model\.onnx$/,
};

/** The same weights in the formats the ComfyUI nodes use: reported, never loaded. */
const OTHER_WEIGHTS = {
    sam2_tiny: /(?:^|\/)sam2(?:\.1)?_hiera_tiny[^/]*\.(?:safetensors|pt|pth)$/,
    sam2_small: /(?:^|\/)sam2(?:\.1)?_hiera_small[^/]*\.(?:safetensors|pt|pth)$/,
    sam2_base_plus: /(?:^|\/)sam2(?:\.1)?_hiera_base_plus[^/]*\.(?:safetensors|pt|pth)$/,
    sam2_large: /(?:^|\/)sam2(?:\.1)?_hiera_large[^/]*\.(?:safetensors|pt|pth)$/,
    birefnet_lite: /birefnet[^/]*lite[^/]*\.(?:safetensors|pt|pth|bin)$/,
    birefnet: /birefnet(?![^/]*lite)[^/]*\.(?:safetensors|pt|pth|bin)$/,
    rmbg14: /rmbg[_-]?1\.4(?:[^/]*\.(?:safetensors|pt|pth|bin)|\/(?:model|pytorch_model)\.(?:safetensors|pth|bin))$/,
    rmbg2: /rmbg[_-]?2\.0(?:[^/]*\.(?:safetensors|pt|pth|bin)|\/(?:model|pytorch_model)\.(?:safetensors|pth|bin))$/,
};

/** Every weight file under `dir` (depth and count bounded), with its size. Never follows symlinks. */
async function scanFolder(dir, { maxDepth = SCAN_MAX_DEPTH, maxFiles = SCAN_MAX_FILES } = {}) {
    const files = [];
    let dirs = 0, truncated = false;
    async function walk(d, depth) {
        if (truncated) return;
        let entries;
        try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch (_) { return; }
        dirs++;
        for (const e of entries) {
            if (files.length >= maxFiles) { truncated = true; return; }
            const p = path.join(d, e.name);
            if (e.isDirectory()) {
                if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
                if (depth < maxDepth) await walk(p, depth + 1);
            } else if (e.isFile()) {
                const ext = path.extname(e.name).toLowerCase();
                if (!WEIGHT_EXT.has(ext)) continue;
                let size = 0;
                try { size = (await fsp.stat(p)).size; } catch (_) { continue; }
                files.push({ path: p, rel: path.relative(dir, p).split(path.sep).join("/"), name: e.name, size, ext });
            }
        }
    }
    await walk(dir, 0);
    return { dir, files, dirs, truncated };
}

/**
 * Attribute the scanned files to the registry: `links[id][role]` = path for every model
 * whose files were all found, `elsewhere[id]` = relative paths of the same weights in
 * formats the app cannot load. An ONNX file counts by its exact name, by the exact byte
 * size the registry carries (only when that size is unique in the registry: the four SAM2
 * decoders share one size and must not be swapped), or by the snapshot layout.
 */
function matchScan(walk) {
    const links = {}, elsewhere = {};
    const onnx = walk.files.filter((f) => f.ext === ".onnx");
    const other = walk.files.filter((f) => f.ext !== ".onnx");
    const sizeCount = new Map();
    for (const m of MODELS) for (const f of m.files) sizeCount.set(f.size, (sizeCount.get(f.size) || 0) + 1);
    for (const m of MODELS) {
        const found = {};
        for (const f of m.files) {
            let best = null, bestScore = 0;
            for (const c of onnx) {
                let score = 0;
                if (c.name.toLowerCase() === f.name.toLowerCase()) score += 4;
                if (f.size && c.size === f.size && sizeCount.get(f.size) === 1) score += 2;
                const alias = ONNX_ALIASES[m.id];
                if (alias && m.files.length === 1 && alias.test(c.rel.toLowerCase())) score += 1;
                if (score > bestScore) { best = c; bestScore = score; }
            }
            if (best) found[f.role] = best.path;
        }
        if (Object.keys(found).length === m.files.length) links[m.id] = found;
        const re = OTHER_WEIGHTS[m.id];
        const hits = re ? other.filter((c) => re.test(c.rel.toLowerCase())).map((c) => c.rel) : [];
        if (hits.length) elsewhere[m.id] = hits;
    }
    return { links, elsewhere };
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

module.exports = { MODELS, byId, locate, describeAll, paths, downloadDir, isComfyModelsDir, Downloader, remove, IMAGENET, scanFolder, matchScan };
