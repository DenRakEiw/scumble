// The helper model registry: which ONNX files exist, where they come from, where they
// are looked for on disk, and the downloader (resumable, with progress, every file checked
// by its sha256 where the registry knows it, the Hugging Face token for gated repos sent to
// Hugging Face's own hosts only). No Electron here: the model folder is passed in, so the
// module also runs under plain Node for tests (tools/helpers_test.js, tools/download_test.js).
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const HF = "https://huggingface.co";
const IMAGENET = { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] };

// Every Hugging Face URL below is pinned to the commit its sha256 was read at (the HF tree API's
// LFS oid, which is the file's sha256; read 2026-11-06), so the hash stays right when the repo moves on.
// RMBG-2.0 is gated: the API masks its oid without a token, so it keeps `main` and the size check alone.
const SAM2_REPO = "vietanhdev/segment-anything-2-onnx-models";
const SAM2_REV = "071f58077599431edd0e5d2ac52ecca4c78f1cab";

/** `enc` / `dec`: [size, sha256]. The large decoder is 24 bytes longer than the other three (read 2026-11-06). */
function sam2(id, variant, label, enc, dec, note) {
    const file = (name) => `${HF}/${SAM2_REPO}/resolve/${SAM2_REV}/${name}`;
    return {
        id, kind: "sam2", label, note,
        source: SAM2_REPO, sourceUrl: `${HF}/${SAM2_REPO}`, license: "Apache-2.0",
        files: [
            { name: `sam2_hiera_${variant}.encoder.onnx`, role: "encoder", size: enc[0], sha256: enc[1], url: file(`sam2_hiera_${variant}.encoder.onnx`) },
            { name: `sam2_hiera_${variant}.decoder.onnx`, role: "decoder", size: dec[0], sha256: dec[1], url: file(`sam2_hiera_${variant}.decoder.onnx`) },
        ],
    };
}

/**
 * A set of many files that must sit together in one folder (an ONNX graph finds its external data by the name inside
 * the graph, beside the `.onnx`), from its catalogue (`corridorkey2.json`, written by tools/ck2_catalogue.js). Its
 * files keep their own names in `subdir` under the model folder and are looked for there and nowhere else; every file
 * needs a size and a sha256, and the set is offered for download only when every file has a URL (`base` + its name,
 * or its own `url`). A catalogue that breaks a rule is kept in the registry as not offered, never thrown at start.
 */
function fromSetCatalogue(cat) {
    const c = cat || {};
    const base = typeof c.base === "string" && c.base ? c.base.replace(/\/*$/, "/") : null;
    const subdir = typeof c.subdir === "string" ? c.subdir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") : "";
    const parts = subdir.split("/");
    // under onnx/ only: a ComfyUI models folder's top-level folders belong to its nodes (a bare corridorkey2/ there
    // is a ComfyUI pack's fp32 weights, docs/PLAN_CORRIDORKEY.md §4.4)
    let invalid = parts.length < 2 || parts[0] !== "onnx" || parts.some((p) => !p || p === "." || p === "..") ? "the set's folder must lie under onnx/" : null;
    const names = new Set();
    const files = (Array.isArray(c.files) ? c.files : []).map((f) => {
        const name = String((f && f.name) || "");
        if (!name || /[\\/:*?"<>|]/.test(name) || name === "." || name === ".." || names.has(name.toLowerCase())) invalid = invalid || `bad file name in the set: "${name}"`;
        names.add(name.toLowerCase());
        const sha = f && typeof f.sha256 === "string" && /^[0-9a-f]{64}$/i.test(f.sha256) ? f.sha256.toLowerCase() : null;
        const size = f && Number.isSafeInteger(f.size) && f.size > 0 ? f.size : null;
        return {
            name, role: (f && f.role) || name, size, sha256: sha, estimate: (f && f.estimate) || null,
            url: (f && f.url) || (base && name ? base + encodeURIComponent(name) : null),
        };
    });
    return {
        id: c.id, kind: c.kind || "key", label: c.label || c.id, note: c.note || "",
        source: c.source || "", sourceUrl: c.sourceUrl || "", license: c.license || "",
        subdir, strict: true, placeholder: !!c.placeholder, invalid, version: c.version || null,
        approxBytes: Number(c.approxBytes) || files.reduce((a, f) => a + (f.size || f.estimate || 0), 0),
        terms: c.terms || null, files,
    };
}

const MODELS = [
    sam2("sam2_tiny", "tiny", "SAM2 tiny",
        [134261315, "4cc015ee18520e93f8c7ddfeaca7436039daaaaf19721b4b96a8810a805e82f7"],
        [20640886, "f5a4bd656c143899fb7f52d64ed81e6f6aeb37d477a0b6da50146ac7cf2187bf"], "fastest, coarser objects"),
    sam2("sam2_small", "small", "SAM2 small",
        [162703493, "f6a7c74dee5b2e71cce3f0475b778f0f28fa3e6c3646c79027302123d2197f40"],
        [20640886, "e07f799d2afe8640ef21f47096ad154d9289bb53041191499ebbea8933ef047b"], ""),
    sam2("sam2_base_plus", "base_plus", "SAM2 base+",
        [339781223, "53b79cec15f2078b3c7410f00f00950a09ef02007dccf238859fec156e42cc8d"],
        [20640886, "666f00ce2664de31211a71068b6b74c3fc5aeee089ebeb2fc9c37834b9ce03b4"], "same weights the ComfyUI helper uses"),
    sam2("sam2_large", "large", "SAM2 large",
        [889361980, "cb252d7b59fdeb2567f7134ed9f23d712e4f24584628913bbcb0ea72ba72b617"],
        [20640910, "2b5a3d40a017e61d2cb4fac7147ebf899d24b082753fb5049be3810d2318ca07"], "best masks, slowest"),
    {
        id: "birefnet_lite", kind: "matting", label: "BiRefNet lite", note: "fast, good general cutouts",
        source: "onnx-community/BiRefNet_lite-ONNX", sourceUrl: `${HF}/onnx-community/BiRefNet_lite-ONNX`, license: "MIT",
        input: 1024, ...IMAGENET,
        files: [{ name: "birefnet_lite.onnx", role: "model", size: 224005088, sha256: "5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333",
            url: `${HF}/onnx-community/BiRefNet_lite-ONNX/resolve/de15b22ba131738a16dff04aab8bdf8dc32e3ac1/onnx/model.onnx` }],
    },
    {
        id: "birefnet", kind: "matting", label: "BiRefNet", note: "finer edges (hair, fur), 4× the size",
        source: "onnx-community/BiRefNet-ONNX", sourceUrl: `${HF}/onnx-community/BiRefNet-ONNX`, license: "MIT",
        input: 1024, ...IMAGENET,
        files: [{ name: "birefnet.onnx", role: "model", size: 972666916, sha256: "58f621f00f5d756097615970a88a791584600dcf7c45b18a0a6267535a1ebd3c",
            url: `${HF}/onnx-community/BiRefNet-ONNX/resolve/534d3c82d3bb8b2f0867db6dfbc3a525b8e42f67/onnx/model.onnx` }],
    },
    {
        id: "rmbg14", kind: "matting", label: "RMBG-1.4", note: "BRIA, non-commercial licence",
        source: "briaai/RMBG-1.4", sourceUrl: `${HF}/briaai/RMBG-1.4`, license: "bria-rmbg-1.4 (non-commercial)",
        input: 1024, mean: [0.5, 0.5, 0.5], std: [1, 1, 1],
        files: [{ name: "rmbg14.onnx", role: "model", size: 176153355, sha256: "8cafcf770b06757c4eaced21b1a88e57fd2b66de01b8045f35f01535ba742e0f",
            url: `${HF}/briaai/RMBG-1.4/resolve/2ceba5a5efaec153162aedea169f76caf9b46cf8/onnx/model.onnx` }],
    },
    {
        // gated: the HF API shows its oid only with a token, so no sha256 is known here (size check alone)
        id: "rmbg2", kind: "matting", label: "RMBG-2.0", note: "BRIA, non-commercial; gated: accept the licence on Hugging Face and save a token below",
        source: "briaai/RMBG-2.0", sourceUrl: `${HF}/briaai/RMBG-2.0`, license: "CC BY-NC 4.0 (BRIA)", gated: true,
        input: 1024, ...IMAGENET,
        files: [{ name: "rmbg2.onnx", role: "model", size: 1024331469, sha256: null, url: `${HF}/briaai/RMBG-2.0/resolve/main/onnx/model.onnx` }],
    },
    {
        // pinned to the commit the app was tested with
        id: "lama", kind: "inpaint", label: "LaMa", note: "Big-LaMa, removes objects (Remove tool, the in-app LaMa recipe); runs on the CPU",
        source: "Carve/LaMa-ONNX", sourceUrl: `${HF}/Carve/LaMa-ONNX`, license: "Apache-2.0",
        input: 512,
        files: [{ name: "lama_fp32.onnx", role: "model", size: 208044816, sha256: "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6",
            url: `${HF}/Carve/LaMa-ONNX/resolve/c3c0c9e468934d62e79c329e35d82dd09ff8c444/lama_fp32.onnx` }],
    },
    {
        // pinned to commit 4472b736...; the single-file repo is deprecated, and its successor -ONNX uses external data
        id: "da2_small", kind: "depth", label: "Depth Anything V2 Small", note: "depth maps (Select by depth, Limit by depth)",
        source: "onnx-community/depth-anything-v2-small", sourceUrl: `${HF}/onnx-community/depth-anything-v2-small`, license: "Apache-2.0",
        input: 518, multiple: 14, ...IMAGENET,
        files: [{ name: "depth_anything_v2_small.onnx", role: "model", size: 99060839, sha256: "afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c",
            url: `${HF}/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model.onnx` }],
    },
    // CorridorKey 2.0 (item 49, docs/PLAN_CORRIDORKEY.md §4.4): a placeholder, not offered until the set is hosted
    fromSetCatalogue(require("./corridorkey2.json")),
];

const byId = (id) => MODELS.find((m) => m.id === id) || null;

/**
 * Whether the model can be downloaded: every file has a URL, a set also a size and a sha256 per file. A placeholder
 * (the CorridorKey set before it is hosted) or a set whose catalogue broke a rule is not offered.
 */
function offered(model) {
    if (!model || model.placeholder || model.invalid || !model.files.length) return false;
    return model.files.every((f) => !!f.url && (!model.strict || (!!f.size && !!f.sha256)));
}

/** Subfolders of the model folder that are searched too (a linked ComfyUI models folder). Sets never use these. */
const SUBDIRS = ["", "onnx", "sam2", "RMBG", "BiRefNet", "rembg", "inpaint", "lama", "depth"];

function isComfyModelsDir(dir) {
    return fs.existsSync(path.join(dir, "checkpoints")) || fs.existsSync(path.join(dir, "diffusion_models"));
}

/** Where downloads land: the folder itself, or its onnx/ subfolder when it is a ComfyUI models folder. */
function downloadDir(dir) {
    return isComfyModelsDir(dir) ? path.join(dir, "onnx") : dir;
}

/** The folder a model's files are written to: a set's own `subdir` under the model folder, else `downloadDir`. */
function targetDir(model, dir) {
    return model.subdir ? path.join(dir, ...model.subdir.split("/")) : downloadDir(dir);
}

function findFile(dir, name) {
    for (const sub of SUBDIRS) {
        const p = path.join(dir, sub, name);
        try { const st = fs.statSync(p); if (st.isFile() && st.size > 0) return { path: p, bytes: st.size }; } catch (_) { /* next */ }
    }
    return null;
}

/** A file of the model on disk: a set's file only in its own folder and (strict) only at its registry size. */
function fileHit(model, dir, f) {
    if (!model.subdir) return findFile(dir, f.name);
    const p = path.join(targetDir(model, dir), f.name);
    try {
        const st = fs.statSync(p);
        if (st.isFile() && st.size > 0 && (!model.strict || !f.size || st.size === f.size)) return { path: p, bytes: st.size };
    } catch (_) { /* not there */ }
    return null;
}

function partPath(model, dir, f) {
    return path.join(targetDir(model, dir), f.name + ".part");
}

/**
 * The model's files on disk (or not), for one folder: the registry name in the folder and
 * its known subfolders first, else a link a scan made (`links[id][role]`: the same file
 * under another name or in another place, see `scanFolder` / `matchScan`). A set is looked
 * for in its own folder only and is never linked.
 */
function locate(model, dir, links = null) {
    const linked = (!model.subdir && links && links[model.id]) || null;
    const files = model.files.map((f) => {
        let hit = fileHit(model, dir, f);
        let isLink = false;
        if (!hit && linked && linked[f.role]) {
            try {
                const st = fs.statSync(linked[f.role]);
                if (st.isFile() && st.size > 0) { hit = { path: linked[f.role], bytes: st.size }; isLink = true; }
            } catch (_) { /* the linked file is gone: not present */ }
        }
        let partial = 0;
        try { partial = fs.statSync(partPath(model, dir, f)).size; } catch (_) { partial = 0; }
        return {
            name: f.name, role: f.role, size: f.size, path: hit ? hit.path : null,
            rel: hit ? path.relative(dir, hit.path).split(path.sep).join("/") : null,
            bytes: hit ? hit.bytes : 0, present: !!hit, linked: isLink, partial,
        };
    });
    const present = !model.placeholder && files.length > 0 && files.every((f) => f.present);
    return { files, present, linked: files.some((f) => f.linked), bytes: files.reduce((a, f) => a + f.bytes, 0), size: files.reduce((a, f) => a + (f.size || 0), 0) };
}

function rowOf(m, dir, links, elsewhere) {
    const row = { id: m.id, kind: m.kind, label: m.label, note: m.note, source: m.source, sourceUrl: m.sourceUrl, license: m.license, gated: !!m.gated, offered: offered(m), ...locate(m, dir, links), elsewhere: (elsewhere && elsewhere[m.id]) || [] };
    if (m.subdir) Object.assign(row, { set: true, subdir: m.subdir, folder: targetDir(m, dir), version: m.version, approxBytes: m.approxBytes, terms: m.terms, termsText: termsText(m), placeholder: m.placeholder, invalid: m.invalid });
    return row;
}

/**
 * One row per model for Settings › Helpers. A model that is not offered (the CorridorKey set before it is hosted) is
 * left out unless `all`, so the row and its Download button stay hidden until there is something to download.
 */
function describeAll(dir, links = null, elsewhere = null, { all = false } = {}) {
    return MODELS.filter((m) => all || offered(m)).map((m) => rowOf(m, dir, links, elsewhere));
}

/** The row of one model (offered or not): what a feature's readiness line reads, e.g. the Key dialog's. */
function describe(id, dir, links = null, elsewhere = null) {
    const m = byId(id);
    return m ? rowOf(m, dir, links, elsewhere) : null;
}

/** Paths keyed by role for a present model, or null. */
function paths(model, dir, links = null) {
    const loc = locate(model, dir, links);
    if (!loc.present) return null;
    const out = {};
    for (const f of loc.files) out[f.role] = f.path;
    return out;
}

/**
 * A set's terms paragraph for the pre-download dialog with `{size}` ("2.4 GB") and `{host}` (where the files come
 * from: "Hugging Face" for huggingface.co, else the host) filled in; "" for a model without terms.
 */
function termsText(model) {
    if (!model || !model.terms || !model.terms.text) return "";
    const url = (model.files.find((f) => f.url) || {}).url || null;
    let host = "its host";
    try { if (url) { const h = new URL(url).hostname; host = h === "huggingface.co" || h === "hf.co" ? "Hugging Face" : h; } } catch (_) { /* keep */ }
    const bytes = model.approxBytes || model.files.reduce((a, f) => a + (f.size || 0), 0);
    return model.terms.text.replace(/\{size\}/g, (bytes / 1e9).toFixed(1) + " GB").replace(/\{host\}/g, host);
}

/** The folder of a present set (what the key process loads from), or null. */
function setFolder(model, dir) {
    return model && model.subdir && locate(model, dir).present ? targetDir(model, dir) : null;
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
    da2_small: /depth[-_]anything[-_]v2[-_]small(?![-_]onnx)[^/]*\/onnx\/model\.onnx$/,
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
    lama: /(?:^|\/)big[_-]?lama[^/]*\.(?:safetensors|pt|pth|ckpt)$/,
    da2_small: /depth[_-]anything[_-]v2[_-]vits[^/]*\.(?:safetensors|pth|pt|bin)$/,
    // a ComfyUI CorridorKey 2.0 pack's fp32 checkpoint (models/corridorkey2/, docs/PLAN_CORRIDORKEY.md §3.2)
    corridorkey2: /(?:^|\/)corridorkey2\/corridorkey_v2\.safetensors$/,
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
 * size the registry carries (only when that size is unique in the registry: three of the
 * SAM2 decoders share one size and must not be swapped), or by the snapshot layout. A set
 * is never linked (its files must sit together in its own folder).
 */
function matchScan(walk) {
    const links = {}, elsewhere = {};
    const onnx = walk.files.filter((f) => f.ext === ".onnx");
    const other = walk.files.filter((f) => f.ext !== ".onnx");
    const sizeCount = new Map();
    for (const m of MODELS) if (!m.subdir) for (const f of m.files) sizeCount.set(f.size, (sizeCount.get(f.size) || 0) + 1);
    for (const m of MODELS) {
        if (!m.subdir) {
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
        }
        const re = OTHER_WEIGHTS[m.id];
        const hits = re ? other.filter((c) => re.test(c.rel.toLowerCase())).map((c) => c.rel) : [];
        if (hits.length) elsewhere[m.id] = hits;
    }
    return { links, elsewhere };
}

// ---- downloads ----------------------------------------------------------------------------

/**
 * The hosts the Hugging Face token is sent to: Hugging Face's own (`huggingface.co`, `hf.co`), over https, on the
 * default port, with no user info in the URL. Every other host gets no token, Hugging Face's storage hops included
 * (`us.aws.cdn.hf.co`, `cdn-lfs.hf.co`, `cas-bridge.xethub.hf.co`): their URLs carry their own signature, and the
 * gated downloads worked without a token there before (undici drops `Authorization` on a cross-origin redirect).
 */
const HF_TOKEN_HOSTS = new Set(["huggingface.co", "hf.co"]);

function hfTokenAllowed(url) {
    let u;
    try { u = new URL(url); } catch (_) { return false; }
    return u.protocol === "https:" && HF_TOKEN_HOSTS.has(u.hostname) && !u.port && !u.username && !u.password;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;
/** Kept free on the disk beyond what a download writes. */
const FREE_MARGIN = 64 * 1024 * 1024;

async function freeSpace(dir) {
    try { const s = await fsp.statfs(dir); return Number(s.bavail) * Number(s.bsize); } catch (_) { return Infinity; }
}

function fmtBytes(n) {
    return n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : n >= 1e3 ? (n / 1e3).toFixed(0) + " KB" : n + " B";
}

async function rmQuiet(p) {
    try { await fsp.unlink(p); } catch (_) { /* not there */ }
}

/** The sha256 of a file (hex), or, with `into`, the file's bytes fed into that hash. */
async function hashFile(p, into = null) {
    const h = into || crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(p, { highWaterMark: 1 << 20 })) h.update(chunk);
    return into ? null : h.digest("hex");
}

async function drain(r) {
    try { if (r.body) await r.body.cancel(); } catch (_) { /* gone */ }
}

class Downloader {
    /**
     * @param {() => string} dirProvider   the model folder (may change between downloads)
     * @param {() => string} tokenProvider Hugging Face token ("" when none); asked only for a request to a token host
     * @param {(ev) => void} onProgress    { id, file, received, total, index, count, setReceived, setTotal, done, error, cancelled }
     * @param {object} [opts]
     * @param {(url: string) => boolean} [opts.tokenAllowed] which URLs get the token (default `hfTokenAllowed`)
     * @param {(model) => boolean} [opts.termsAccepted] whether a model with `terms` may be downloaded (default: never)
     * @param {(dir: string) => Promise<number>} [opts.freeSpace] free bytes on the folder's disk (default `statfs`)
     * @param {(id: string) => object} [opts.lookup] the registry (default `byId`)
     * @param {typeof fetch} [opts.fetch]
     */
    constructor(dirProvider, tokenProvider, onProgress, opts = {}) {
        this.dirProvider = dirProvider;
        this.tokenProvider = tokenProvider || (() => "");
        this.onProgress = onProgress || (() => {});
        this.tokenAllowed = opts.tokenAllowed || hfTokenAllowed;
        this.termsAccepted = opts.termsAccepted || (() => false);
        this.freeSpace = opts.freeSpace || freeSpace;
        this.lookup = opts.lookup || byId;
        this.fetch = opts.fetch || ((url, init) => fetch(url, init));
        this.active = new Map();   // id -> { controller, file, received, total, index, count, base, setTotal }
    }

    running() {
        const out = {};
        for (const [id, a] of this.active) out[id] = { file: a.file, received: a.received, total: a.total, index: a.index, count: a.count, setReceived: a.base + a.received, setTotal: a.setTotal };
        return out;
    }

    /**
     * Download every missing file of the model. Refused before any request: an unknown model, one that is not
     * offered, one with terms not accepted, one already downloading, and (reported as the download's error) too
     * little free disk for what is left to fetch. -> the model's `locate()`, or null when cancelled.
     */
    async download(id) {
        const model = this.lookup(id);
        if (!model) throw new Error("unknown model " + id);
        if (!offered(model)) throw new Error(`${model.label} is not available for download yet.`);
        if (model.terms && !this.termsAccepted(model)) throw new Error(`${model.label}: its licence terms have to be accepted before the download.`);
        if (this.active.has(id)) throw new Error(model.label + " is already downloading");
        const root = this.dirProvider();
        const controller = new AbortController();
        const setTotal = model.files.reduce((a, f) => a + (f.size || 0), 0);
        const state = { controller, file: "", received: 0, total: 0, index: 0, count: model.files.length, base: 0, setTotal };
        this.active.set(id, state);
        try {
            const dir = targetDir(model, root);
            await fsp.mkdir(dir, { recursive: true });
            const todo = model.files.filter((f) => !fileHit(model, root, f));
            let need = 0;
            for (const f of todo) {
                let have = 0;
                try { have = (await fsp.stat(partPath(model, root, f))).size; } catch (_) { have = 0; }
                need += Math.max(0, (f.size || 0) - (f.size && have <= f.size ? have : 0));
            }
            const free = await this.freeSpace(dir);
            if (need > 0 && need + FREE_MARGIN > free) {
                throw new Error(`Not enough free disk space for ${model.label}: the download needs ${fmtBytes(need + FREE_MARGIN)} in ${dir}, ${fmtBytes(free)} are free.`);
            }
            state.base = model.files.reduce((a, f) => a + (todo.includes(f) ? 0 : (f.size || 0)), 0);
            for (let i = 0; i < model.files.length; i++) {
                const f = model.files[i];
                if (!todo.includes(f)) continue;
                if (fileHit(model, root, f)) { state.base += f.size || 0; continue; }   // put there meanwhile
                state.file = f.name; state.index = i + 1; state.received = 0; state.total = f.size || 0;
                const got = await this._file(f, path.join(dir, f.name), model, state, 0);
                state.base += f.size || got;
                state.received = 0;
            }
            this.onProgress({ id, done: true, count: state.count, setReceived: setTotal, setTotal });
            return locate(model, this.dirProvider());
        } catch (err) {
            const cancelled = controller.signal.aborted;
            this.onProgress({ id, file: state.file, index: state.index, count: state.count, error: cancelled ? null : String(err.message || err), cancelled });
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

    /**
     * One GET with the redirects followed by hand, so the token goes on each hop only when that hop's URL is a token
     * host, and an https URL is never followed to http. A Range header goes on every hop.
     */
    async _get(url, have, signal, label) {
        let u = url;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            const headers = { "user-agent": "scumble/0.1" };
            if (have > 0) headers.range = `bytes=${have}-`;
            if (this.tokenAllowed(u)) {
                const token = this.tokenProvider();
                if (token) headers.authorization = "Bearer " + token;
            }
            const r = await this.fetch(u, { headers, signal, redirect: "manual" });
            if (!REDIRECTS.has(r.status)) return { r, url: u };
            const loc = r.headers.get("location");
            await drain(r);
            if (!loc) throw new Error(`download of ${label} failed: a redirect (HTTP ${r.status}) without a target`);
            const next = new URL(loc, u);
            if (next.protocol !== "https:" && next.protocol !== "http:") throw new Error(`download of ${label} failed: redirected to ${next.protocol}`);
            if (new URL(u).protocol === "https:" && next.protocol !== "https:") throw new Error(`download of ${label} refused: redirected from https to ${next.protocol}`);
            u = next.href;
        }
        throw new Error(`download of ${label} failed: more than ${MAX_REDIRECTS} redirects`);
    }

    /** One file into `dest` through `dest.part`: resumed with Range, checked by size and sha256, then renamed. -> bytes. */
    async _file(f, dest, model, state, attempt) {
        const part = dest + ".part";
        const onProgress = this.onProgress;
        const id = model.id;
        const emit = () => onProgress({ id, file: f.name, received: state.received, total: state.total, index: state.index, count: state.count, setReceived: state.base + state.received, setTotal: state.setTotal });
        let have = 0;
        try { have = (await fsp.stat(part)).size; } catch (_) { have = 0; }
        if (f.size && have > f.size) { await rmQuiet(part); have = 0; }   // a stale .part larger than the file: start over
        if (f.size && have === f.size) {
            // a whole .part an earlier run left (a crash before the rename, a size the registry had wrong): kept if it checks
            if (!f.sha256 || (await hashFile(part)) === f.sha256) {
                await fsp.rename(part, dest);
                state.received = have; state.total = have; emit();
                return have;
            }
            await rmQuiet(part); have = 0;
        }
        const { r, url } = await this._get(f.url, have, state.controller.signal, f.name);
        const host = (() => { try { return new URL(url).host; } catch (_) { return "the server"; } })();
        const isHF = hfTokenAllowed(url);
        if (r.status === 401 || r.status === 403) {
            await drain(r);
            throw new Error(model.gated && isHF
                ? `${model.label} is gated on Hugging Face (${r.status}): accept its licence at ${model.sourceUrl} and save your Hugging Face token in the settings.`
                : `${isHF ? "Hugging Face" : host} refused the download of ${f.name} (${r.status}).`);
        }
        if (r.status === 416) {
            await drain(r);
            await rmQuiet(part);
            if (attempt < 1) return this._file(f, dest, model, state, attempt + 1);
            throw new Error(`download of ${f.name} failed: HTTP 416`);
        }
        if (!r.ok) { await drain(r); throw new Error(`download of ${f.name} failed: HTTP ${r.status}`); }
        let append = false;
        if (r.status === 206 && have > 0) {
            const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(r.headers.get("content-range") || "");
            if (!m || Number(m[1]) !== have) {
                // the server answered another range than the one asked for: start the file over
                await drain(r);
                await rmQuiet(part);
                if (attempt < 1) return this._file(f, dest, model, state, attempt + 1);
                throw new Error(`download of ${f.name} failed: the server answered another byte range`);
            }
            append = true;
        }
        if (!append) have = 0;
        if (!r.body) throw new Error(`download of ${f.name} failed: an empty answer`);
        const len = Number(r.headers.get("content-length")) || 0;
        const hash = f.sha256 ? crypto.createHash("sha256") : null;
        if (append && hash) await hashFile(part, hash);   // the bytes already on disk count for the checksum
        state.received = have;
        state.total = f.size || (append ? have + len : len);
        let last = 0;
        const counter = new Transform({
            transform(chunk, _enc, cb) {
                if (hash) hash.update(chunk);
                state.received += chunk.length;
                const now = Date.now();
                if (now - last > 200) { last = now; emit(); }
                cb(null, chunk);
            },
        });
        try {
            await pipeline(Readable.fromWeb(r.body), counter, fs.createWriteStream(part, { flags: append ? "a" : "w" }));
        } catch (err) {
            if (state.controller.signal.aborted) throw err;
            // the .part keeps what arrived: the next Download asks for the rest
            throw new Error(`${f.name}: the download broke off at ${fmtBytes(state.received)}${state.total ? " of " + fmtBytes(state.total) : ""} (${err && err.message || err}); Download again resumes it.`);
        }
        const got = (await fsp.stat(part)).size;
        if (f.size && got < f.size) throw new Error(`${f.name}: the download stopped at ${fmtBytes(got)} of ${fmtBytes(f.size)}; Download again resumes it.`);
        if (f.size && got > f.size) {
            await rmQuiet(part);
            throw new Error(`${f.name}: got ${got} bytes, expected ${f.size}; the download was deleted (the file on the server changed?).`);
        }
        if (hash) {
            const sum = hash.digest("hex");
            if (sum !== f.sha256) {
                await rmQuiet(part);
                throw new Error(`${f.name} does not match its checksum (sha256 ${sum.slice(0, 12)}… instead of ${f.sha256.slice(0, 12)}…); the download was deleted, try again.`);
            }
        }
        await fsp.rename(part, dest);
        state.received = got; state.total = got; emit();
        return got;
    }
}

/**
 * Hash the model's present files against the registry. -> { id, ok, files: [{ name, path, ok }] }, `ok` null for a
 * file without a known sha256 or not present; the whole `ok` is true only when every file is present and none failed.
 */
async function verify(id, dir, lookup = byId) {
    const model = lookup(id);
    if (!model) throw new Error("unknown model " + id);
    const loc = locate(model, dir);
    const files = [];
    for (let i = 0; i < model.files.length; i++) {
        const f = model.files[i], l = loc.files[i];
        if (!l.present || !f.sha256) { files.push({ name: f.name, path: l.path, ok: null }); continue; }
        files.push({ name: f.name, path: l.path, ok: (await hashFile(l.path)) === f.sha256 });
    }
    return { id, ok: loc.present && files.every((x) => x.ok !== false), files };
}

/** Delete a model's files (and any .part) from the folder; a set's folder goes too once it is empty. */
async function remove(id, dir, lookup = byId) {
    const model = lookup(id);
    if (!model) throw new Error("unknown model " + id);
    let n = 0;
    for (const f of model.files) {
        if (model.subdir) {
            const p = path.join(targetDir(model, dir), f.name);
            try { await fsp.unlink(p); n++; } catch (_) { /* none */ }
        } else {
            const hit = findFile(dir, f.name);
            if (hit) { await fsp.unlink(hit.path); n++; }
        }
        await rmQuiet(partPath(model, dir, f));
    }
    if (model.subdir) { try { await fsp.rmdir(targetDir(model, dir)); } catch (_) { /* not empty, or not there */ } }
    return n;
}

module.exports = {
    MODELS, byId, offered, locate, describeAll, describe, paths, setFolder, termsText, downloadDir, targetDir, isComfyModelsDir,
    Downloader, remove, verify, hashFile, hfTokenAllowed, fromSetCatalogue, IMAGENET, scanFolder, matchScan,
};
