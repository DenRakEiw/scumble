// @ts-check
// The LoRA hint's source on this machine (item 50, docs/PLAN_LORAS.md §3.4, LR3): a LoRA file's safetensors header,
// read from the ComfyUI models folder Settings › Helpers points at, and reduced to what the renderer's familyOf
// (renderer/editor/loras.js) reads: the module paths, the block indices, the hidden width, a few metadata fields and
// the most frequent caption tags. Never the raw header: an SDXL LoRA lists about 3,000 tensors with dtype, shape and
// offsets, and its ss_tag_frequency can run to megabytes, so the answer is a few KB whatever the file.
//
// Taken only when the ComfyUI server is this machine (a loopback address or the machine's own name): for a remote
// server a local file of the same name would speak for another file. The name is the server's lora_name ("klein\x");
// it is resolved under <dir>/loras and refused outside it. Read-only: the file is opened for reading, 8 bytes and the
// header are read, nothing else; nothing is ever written.
//
// Pure (no Electron): main.js answers the IPC `loras:header` with headerFor(); tools/loraheader_test.js requires this
// file. The metadata's reduction has a twin in renderer/editor/loras.js (loraMeta, for ComfyUI's /view_metadata answer
// when the file cannot be read here); the test holds the two to the same answers.
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

/** A header longer than this is refused (ComfyUI's own /view_metadata stops at 1 MB). */
const MAX_HEADER = 16 * 1024 * 1024;
/** At most this many module paths in the answer (they carry N for every index, so a real file has a few dozen). */
const MAX_MODULES = 2000;
/** At most this many distinct out-features per block prefix (a real LoRA has two to six). */
const MAX_OUTS = 16;
/** The metadata part of the answer, as JSON, at most this long. */
const MAX_METADATA = 16 * 1024;
/** The caption tags kept: the five most frequent, each shorter than 40 characters. */
const TAGS = 5, TAG_LEN = 40;
/** The metadata fields kept (safetensors metadata values are strings). */
const META_KEYS = ["ss_base_model_version", "ss_sd_model_name", "modelspec.architecture", "modelspec.trigger_phrase", "modelspec.title"];
/** One field at most this long before the 16 KB cap is applied. */
const META_FIELD = 4000;

/** The adapter's own part of a tensor name: what is left is the module the LoRA patches. */
const SUFFIX = /(?:\.lora_(?:up|down|A|B|mid)(?:\.default)?(?:\.weight)?|_lora\.(?:up|down)\.weight|\.lora\.(?:up|down)\.weight|\.lora_linear_layer\.(?:up|down)\.weight|\.alpha|\.diff_b|\.diff|\.dora_scale|\.hada_[wt]\d(?:_[ab])?|\.lokr_[wt]\d(?:_[ab])?|\.set_weight|\.reshape_weight|\.oft_(?:blocks|diag)|\.[wb]_norm)$/;
/** The tensors whose first dimension is a patched module's out-features (the up / B half, a full weight or bias diff). */
const UP = /(?:\.lora_B(?:\.default)?(?:\.weight)?|\.lora_up\.weight|\.lora\.up\.weight|_lora\.up\.weight|\.lora_linear_layer\.up\.weight|\.diff|\.diff_b)$/;
/** Text-encoder tensors: no block or width of the diffusion model. */
const TEXT_ENCODER = /^(?:lora_te\d?_|text_encoders?\.|te\d?\.|text_model\.)/;
/**
 * The block a module sits in: double_blocks / single_blocks (FLUX), transformer_blocks / single_transformer_blocks
 * (Qwen, FLUX in the diffusers names), layers (MOSS-Image, Z-Image, Ideogram), content_mode_blocks.<mode> (FLUX 3);
 * "." or "_" around (kohya writes lora_unet_double_blocks_0_...).
 */
const BLOCK = /(?:^|[._])(content_mode_blocks)[._][a-z][a-z_]*[._](\d+)(?=[._]|$)|(?:^|[._])((?:single_)?transformer_blocks|double_blocks|single_blocks|layers)[._](\d+)(?=[._]|$)/;

/**
 * A module path with every index written as N ("diffusion_model.double_blocks.N.img_attn.qkv"): the block indices are
 * in `blocks`, and a file's modules then come to a few dozen patterns.
 * @param {string} mod
 */
function modulePattern(mod) {
    return mod.replace(/([._])\d+(?=[._]|$)/g, "$1N");
}

/**
 * The header of a safetensors file held in `buf`: `{ raw }` (the header object, tensors and `__metadata__`), or
 * `{ raw: null, reason }` when the bytes are no safetensors header (too short, a length of 0 or past the buffer, not a
 * JSON object) or the header is longer than MAX_HEADER.
 * @param {Buffer | Uint8Array} buf the file's first bytes (8 + the header at least)
 * @returns {{ raw: Record<string, any> | null, reason: string | null }}
 */
function parseHeader(buf) {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
    if (b.length < 8) return { raw: null, reason: "not a safetensors file (shorter than 8 bytes)" };
    const n = Number(b.readBigUInt64LE(0));
    if (n > MAX_HEADER) return { raw: null, reason: `the header is ${n} bytes, past the cap of ${MAX_HEADER}` };
    if (n < 2 || 8 + n > b.length) return { raw: null, reason: "not a safetensors file (its length field does not fit)" };
    return parseJson(b.subarray(8, 8 + n));
}

/** @param {Buffer} bytes @returns {{ raw: Record<string, any> | null, reason: string | null }} */
function parseJson(bytes) {
    if (bytes[0] !== 0x7b) return { raw: null, reason: "not a safetensors file (the header is no JSON object)" };
    let raw;
    try { raw = JSON.parse(bytes.toString("utf8")); } catch (_) { return { raw: null, reason: "not a safetensors file (the header is no JSON)" }; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { raw: null, reason: "not a safetensors file (the header is no JSON object)" };
    return { raw, reason: null };
}

/**
 * The header of a safetensors file on disk, reading only its first 8 bytes and the header (never the tensors).
 * @param {string} file
 * @returns {Promise<{ raw: Record<string, any> | null, reason: string | null }>}
 */
async function readHeader(file) {
    let fh;
    try {
        fh = await fsp.open(file, "r");
        const st = await fh.stat();
        const head = Buffer.alloc(8);
        const got = (await fh.read(head, 0, 8, 0)).bytesRead;
        if (got < 8) return { raw: null, reason: "not a safetensors file (shorter than 8 bytes)" };
        const n = Number(head.readBigUInt64LE(0));
        // a length the file cannot hold is no safetensors file (a text file reads as a huge length); then the cap
        if (n < 2 || 8 + n > st.size) return { raw: null, reason: "not a safetensors file (its length field does not fit)" };
        if (n > MAX_HEADER) return { raw: null, reason: `the header is ${n} bytes, past the cap of ${MAX_HEADER}` };
        const body = Buffer.alloc(n);
        const read = (await fh.read(body, 0, n, 8)).bytesRead;
        if (read < n) return { raw: null, reason: "the header was cut short" };
        return parseJson(body);
    } catch (err) {
        return { raw: null, reason: String((err && err.code) || (err && err.message) || err) };
    } finally {
        if (fh) await fh.close().catch(() => { /* closed */ });
    }
}

/**
 * The most frequent caption tags of ss_tag_frequency (a JSON string, `{ dataset: { tag: count } }`): the counts summed
 * over the datasets, the tags trimmed, each shorter than TAG_LEN and seen at least a quarter as often as the most
 * frequent one, the TAGS most frequent (a tie by name).
 * @param {any} freq
 * @returns {string[]}
 */
function topTags(freq) {
    let d = freq;
    if (typeof d === "string") { try { d = JSON.parse(d); } catch (_) { return []; } }
    if (!d || typeof d !== "object") return [];
    /** @type {Map<string, number>} */
    const sum = new Map();
    for (const set of Object.values(d)) {
        if (!set || typeof set !== "object") continue;
        for (const [tag, count] of Object.entries(set)) {
            const t = String(tag).trim();
            const c = Number(count);
            if (!t || t.length >= TAG_LEN || !Number.isFinite(c)) continue;
            sum.set(t, (sum.get(t) || 0) + c);
        }
    }
    const top = [...sum.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    // a trigger word is in (nearly) every caption: a fragment of a sentence caption, seen a few times, is no tag
    const floor = top.length ? top[0][1] / 4 : 0;
    return top.filter((e) => e[1] >= floor).slice(0, TAGS).map((e) => e[0]);
}

/**
 * A file's `__metadata__` as the answer carries it: the fields of META_KEYS that are non-empty strings (trimmed, each
 * at most META_FIELD long) and `tags` (topTags of ss_tag_frequency); as JSON at most MAX_METADATA, the longest field
 * halved until it fits. The renderer's loraMeta is the same function (tools/loraheader_test.js holds them alike).
 * @param {any} meta
 * @returns {Record<string, any>}
 */
function reduceMetadata(meta) {
    /** @type {Record<string, any>} */
    const out = {};
    if (!meta || typeof meta !== "object") return out;
    for (const k of META_KEYS) {
        const v = meta[k];
        if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, META_FIELD);
    }
    const tags = topTags(meta.ss_tag_frequency);
    if (tags.length) out.tags = tags;
    while (JSON.stringify(out).length > MAX_METADATA) {
        let longest = "";
        for (const k of META_KEYS) if (typeof out[k] === "string" && (!longest || out[k].length > out[longest].length)) longest = k;
        if (!longest) break;
        out[longest] = out[longest].slice(0, Math.floor(out[longest].length / 2));
    }
    return out;
}

/**
 * The header reduced to what familyOf reads: `keyCount` (the tensors), `modules` (the distinct module paths, the
 * adapter's suffixes off and every index as N, sorted, at most MAX_MODULES), `blocks` ({ prefix: the distinct block
 * indices seen, sorted }), `width` ({ prefix: the smallest out-features of a module under it, which is the model's
 * hidden width: its projections give h, 3h, 4h, 6h, 7h or 9h }), `outs` ({ prefix: the distinct out-features under it,
 * sorted, at most MAX_OUTS: FLUX.1's MLP gives 4h and 7h, FLUX.2's 6h and 9h, so they tell a FLUX.1 LoRA from a FLUX.2
 * Klein 4B one of the same width }), `metadata` (reduceMetadata). Text-encoder tensors count for keyCount and modules
 * only.
 * @param {Record<string, any>} raw
 * @returns {{ keyCount: number, modules: string[], blocks: Record<string, number[]>, width: Record<string, number>, outs: Record<string, number[]>, metadata: Record<string, any> }}
 */
function reduceHeader(raw) {
    const keys = Object.keys(raw || {}).filter((k) => k !== "__metadata__");
    const modules = new Set();
    /** @type {Record<string, Set<number>>} */
    const blocks = {};
    /** @type {Record<string, number>} */
    const width = {};
    /** @type {Record<string, Set<number>>} */
    const outs = {};
    for (const k of keys) {
        const mod = k.replace(SUFFIX, "");
        modules.add(modulePattern(mod));
        if (TEXT_ENCODER.test(k)) continue;
        const m = BLOCK.exec(mod);
        if (!m) continue;
        const prefix = m[1] || m[3], index = Number(m[2] || m[4]);
        (blocks[prefix] || (blocks[prefix] = new Set())).add(index);
        const t = raw[k];
        // a `.diff` of a 1-D tensor is a norm's scale, not a layer's out-features (Comfy-Org's Qwen Image 2.1 turbo LoRA
        // carries attn.norm_q / norm_k diffs at the head's 128, which read as the width 128 until LR9's live run)
        const normDiff = /\.diff$/.test(k) && t && Array.isArray(t.shape) && t.shape.length < 2;
        if (UP.test(k) && !normDiff && t && Array.isArray(t.shape) && Number.isInteger(t.shape[0]) && t.shape[0] > 0) {
            if (!(prefix in width) || t.shape[0] < width[prefix]) width[prefix] = t.shape[0];
            (outs[prefix] || (outs[prefix] = new Set())).add(t.shape[0]);
        }
    }
    /** @type {Record<string, number[]>} */
    const outBlocks = {};
    for (const [p, s] of Object.entries(blocks)) outBlocks[p] = [...s].sort((a, b) => a - b);
    /** @type {Record<string, number[]>} */
    const outOuts = {};
    for (const [p, s] of Object.entries(outs)) outOuts[p] = [...s].sort((a, b) => a - b).slice(0, MAX_OUTS);
    return {
        keyCount: keys.length,
        modules: [...modules].sort().slice(0, MAX_MODULES),
        blocks: outBlocks,
        width,
        outs: outOuts,
        metadata: reduceMetadata(raw ? raw.__metadata__ : null),
    };
}

/**
 * Whether a ComfyUI server address names this machine: a loopback host (127.x.x.x, localhost, ::1) or the machine's
 * own name (os.hostname(), any case).
 * @param {any} url
 * @param {any} hostname
 */
function localServer(url, hostname) {
    let host;
    try { host = new URL(String(url || "")).hostname.toLowerCase(); } catch (_) { return false; }
    host = host.replace(/^\[|\]$/g, "");
    if (!host) return false;
    if (host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host)) return true;
    const own = String(hostname || "").trim().toLowerCase();
    return !!own && host === own;
}

/** Whether `dir` is a ComfyUI models folder with a loras folder (the Helpers check: checkpoints or diffusion_models). */
function comfyModelsDir(dir) {
    try {
        if (!fs.statSync(path.join(dir, "loras")).isDirectory()) return false;
        return fs.existsSync(path.join(dir, "checkpoints")) || fs.existsSync(path.join(dir, "diffusion_models"));
    } catch (_) { return false; }
}

/**
 * The file a server name ("klein\x.safetensors", either separator) stands for under `<dir>/loras`, or null: an empty
 * or absolute name, a drive or share, a "." or ".." part, a NUL, another extension than .safetensors, or a path that
 * resolves outside `<dir>/loras`.
 * @param {any} dir
 * @param {any} name
 * @returns {string | null}
 */
function loraPath(dir, name) {
    if (typeof dir !== "string" || !dir || typeof name !== "string") return null;
    const n = name.trim();
    if (!n || n.includes("\0") || !/\.safetensors$/i.test(n)) return null;
    if (/^[\\/]/.test(n) || /^[a-zA-Z]:/.test(n) || path.isAbsolute(n)) return null;
    const parts = n.split(/[\\/]+/);
    if (parts.some((p) => p === "." || p === ".." || !p)) return null;
    const root = path.resolve(dir, "loras");
    const full = path.resolve(root, ...parts);
    const rel = path.relative(root, full);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return full;
}

/**
 * The IPC `loras:header` answer for a server name: `{ header }` (reduceHeader) read from `<dir>/loras/<name>`, or
 * `{ header: null, reason }` when the server is not this machine, `dir` is no ComfyUI models folder, the name is
 * refused, the file is missing or no safetensors file. The renderer then asks ComfyUI's /view_metadata.
 * @param {{ url?: any, hostname?: any, dir?: any, name?: any }} q
 * @returns {Promise<{ header: ReturnType<typeof reduceHeader> | null, reason: string | null }>}
 */
async function headerFor(q) {
    const { url, hostname, dir, name } = q || {};
    if (!localServer(url, hostname)) return { header: null, reason: "the ComfyUI server is not this machine" };
    if (typeof dir !== "string" || !dir || !comfyModelsDir(dir)) return { header: null, reason: "Settings › Helpers points at no ComfyUI models folder" };
    const file = loraPath(dir, name);
    if (!file) return { header: null, reason: "the name is refused" };
    try { if (!(await fsp.stat(file)).isFile()) return { header: null, reason: "no such file" }; } catch (_) { return { header: null, reason: "no such file" }; }
    const r = await readHeader(file);
    if (!r.raw) return { header: null, reason: r.reason };
    return { header: reduceHeader(r.raw), reason: null };
}

module.exports = {
    MAX_HEADER, MAX_MODULES, MAX_OUTS, MAX_METADATA, TAGS, TAG_LEN, META_KEYS,
    parseHeader, readHeader, reduceHeader, reduceMetadata, topTags, modulePattern, localServer, comfyModelsDir, loraPath, headerFor,
};
