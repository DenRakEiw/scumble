// The helpers facade the main process exposes over IPC: model folder and downloads,
// the ONNX runtime with its device choice, and the jobs the editor asks for (objects
// for the hover tool, segment for a click, cutout for a layer, inpaint for Remove). Settings live in settings.json
// under `helpers`; the Hugging Face token in keys.js under "hf-token".
// SAM2, the matting models and depth run in the helpers' process (helpers.js, helpers_process.js; engine.js holds the
// jobs), LaMa in its own (lama.js): this module resolves the model files from the settings and sends them with each
// job, and never loads onnxruntime itself unless that process could not start (docs/PLAN_HELPERS_PROCESS.md §3).
"use strict";

const path = require("node:path");
const fsp = require("node:fs/promises");
const { app, dialog, shell } = require("electron");
const settings = require("../settings");
const keys = require("../keys");
const models = require("./models");
const { checkImage, checkDepth, checkIntrinsic, checkNormals, modelInfo } = require("./engine");
const { HelperProcess } = require("./helpers");
const { Lama, SIZE: LAMA_SIZE } = require("./lama");

const HF_TOKEN = "hf-token";
const DEFAULTS = { device: "auto", dir: null, sam2: "sam2_base_plus", matting: "birefnet_lite", inpaint: "lama", depth: "da2_small", intrinsic: "intrinsic", normals: "moge2_vitb_normal" };

const helperProcess = new HelperProcess();
let progressSink = null;
const inpaintInstances = new Map();  // model id -> Lama
const busy = new Set();              // running jobs, for the status line

function conf() {
    return { ...DEFAULTS, ...(settings.get().helpers || {}) };
}

function modelsDir() {
    return conf().dir || (app && app.getPath ? path.join(app.getPath("userData"), "models") : path.join(process.env.APPDATA || ".", "Scumble", "models"));
}

/** Files a scan linked under other names, `{ modelId: { role: path } }`. */
function links() {
    return conf().links || {};
}

/** The last scan, when it was of the current folder. */
function lastScan(dir) {
    const s = conf().scan;
    return s && s.dir === dir ? s : null;
}

/**
 * Whether the user accepted a model's licence terms in their current version (the pre-download dialog of Settings ›
 * Helpers: `helpers.terms[id]` = the version accepted). A new version of the terms asks again.
 */
function termsAccepted(model) {
    const t = conf().terms || {};
    return !!(model && model.terms && t[model.id] != null && t[model.id] === model.terms.version);
}

const downloader = new models.Downloader(modelsDir, () => keys.get(HF_TOKEN), (ev) => {
    if (progressSink) progressSink(ev);
}, { termsAccepted });

function setProgressSink(fn) { progressSink = fn; }

function status() {
    const c = conf();
    const dir = modelsDir();
    const sc = lastScan(dir);
    return {
        dir, isDefaultDir: !c.dir, downloadDir: models.downloadDir(dir), isComfyDir: models.isComfyModelsDir(dir),
        device: c.device, sam2: c.sam2, matting: c.matting, inpaint: c.inpaint, depth: c.depth, intrinsic: c.intrinsic, normals: c.normals,
        models: models.describeAll(dir, links(), sc ? sc.elsewhere : null).map((r) => (r.terms ? { ...r, termsAccepted: termsAccepted(models.byId(r.id)) } : r)),
        scan: sc,
        downloads: downloader.running(),
        // from the helpers' process's last answer (nothing loaded while it is off): never a call into it
        runtime: helperProcess.status(c.device),
        hfToken: keys.describe(HF_TOKEN),
        busy: Array.from(busy),
    };
}

async function configure(patch) {
    const before = conf();
    const next = { ...before, ...(patch || {}) };
    const deviceChanged = !!(patch && "device" in patch && next.device !== before.device);
    const dirChanged = !!(patch && "dir" in patch && patch.dir !== before.dir);
    // the settings first, so a job that comes in meanwhile is sent with the new device and the new folder's files
    settings.set({ helpers: next });
    // the helpers' process retires (its sessions were made on the old device, or from the old folder's files): the next
    // job starts one on the new device, a job under way still lands (helpers.js `retire`)
    if (dirChanged) await clearInstances();
    else if (deviceChanged) await helperProcess.retire({ reason: "device" });
    // a new folder is scanned at once, so a ComfyUI models folder links what it can
    return dirChanged ? scan() : status();
}

/**
 * Walk the model folder once: link the ONNX files found under other names or in a
 * Hugging Face layout, and record the weights in other formats per model so the settings
 * row can say why a model is not usable. The result is kept in the settings until the
 * next scan or folder change.
 */
async function scan() {
    const dir = modelsDir();
    const walk = await models.scanFolder(dir);
    const m = models.matchScan(walk);
    settings.set({ helpers: { ...conf(), links: m.links, scan: { dir, time: Date.now(), files: walk.files.length, dirs: walk.dirs, truncated: walk.truncated, elsewhere: m.elsewhere } } });
    await clearInstances();
    return status();
}

/**
 * The models' files may have moved: LaMa's process ends, the helpers' process retires (a job under way still lands;
 * resolves once it exited).
 */
function clearInstances() {
    for (const l of inpaintInstances.values()) l.kill();
    inpaintInstances.clear();
    return helperProcess.retire({ reason: "folder", clear: true });
}

// LaMa's process and the helpers' end with the app (a utility process would too; the forked one of plain Node would not)
if (app && typeof app.on === "function") {
    app.on("will-quit", () => {
        for (const l of inpaintInstances.values()) l.kill();
        helperProcess.kill({ reason: "quit" });
    });
}

async function browseDir(win) {
    const r = await dialog.showOpenDialog(win, { title: "Model folder (the app's own, or a ComfyUI models folder)", defaultPath: modelsDir(), properties: ["openDirectory", "createDirectory"] });
    if (r.canceled || !r.filePaths.length) return null;
    return configure({ dir: r.filePaths[0] });
}

async function openFolder() {
    const d = models.downloadDir(modelsDir());
    await fsp.mkdir(d, { recursive: true });
    return shell.openPath(require("../msix").forExplorer(d));
}

/**
 * Download a model. `opts.acceptTerms`: the version of the model's terms the user just accepted in the window's
 * dialog; it is stored (only when it is the current version) before the download starts, and the Downloader refuses a
 * model with terms that were not accepted.
 */
async function download(id, opts = null) {
    const model = models.byId(id);
    if (model && model.terms && opts && opts.acceptTerms != null && opts.acceptTerms === model.terms.version) {
        const c = conf();
        settings.set({ helpers: { ...c, terms: { ...(c.terms || {}), [id]: model.terms.version } } });
    }
    const loc = await downloader.download(id);
    return loc ? status() : null;
}

function cancel(id) { return downloader.cancel(id); }

async function remove(id) {
    const dir = modelsDir();
    const model = models.byId(id);
    if (!model) throw new Error("unknown model " + id);
    const loc = models.locate(model, dir, links());
    // the helpers' processes end where they stand first (resolved once they exited, so the file one held can go on
    // Windows); a LaMa model leaves them alone, as Free VRAM does
    if (model.kind !== "inpaint") await helperProcess.kill({ reason: "remove", clear: true });
    if (loc.present && loc.linked) {
        // a linked file belongs to the user's folder (a ComfyUI models folder, mostly):
        // forget the link, never delete the file
        const l = { ...links() };
        delete l[id];
        settings.set({ helpers: { ...conf(), links: l } });
    }
    const lama = inpaintInstances.get(id);
    if (lama) { lama.kill(); inpaintInstances.delete(id); }
    if (!(loc.present && loc.linked)) await models.remove(id, dir);
    return status();
}

/**
 * The GPU sessions let go (the Free VRAM button and the free before a local ComfyUI run come here alike): the helpers'
 * process retires, its VRAM and memory back once it has answered the jobs it has (at most 8 s; a job then still open is
 * refused, naming the cause), and the next job starts a new one at once. Before U1 a free released the sessions and a
 * job under way went on, so a cutout on another tab still lands. LaMa stays: it runs on the CPU in its own process,
 * holds no VRAM, and a Remove under way would lose its answer. -> the number of sessions it held
 */
async function free() {
    return helperProcess.retire({ reason: "free" });
}

const MISSING = {
    sam2: "No SAM2 model is downloaded (Settings › Helpers).",
    matting: "No background removal model is downloaded (Settings › Helpers).",
    inpaint: "The LaMa model is not downloaded (Settings › Helpers).",
    depth: "No depth model is downloaded (Settings › Helpers).",
    intrinsic: "Deep paint needs the Marigold IID Lighting model: download it in Settings › Helpers.",
    normals: "Deep paint needs a MoGe-2 normal model: download it in Settings › Helpers.",
};

function presentOf(kind, wanted) {
    const dir = modelsDir();
    const all = models.MODELS.filter((m) => m.kind === kind);
    const pick = all.find((m) => m.id === wanted && models.paths(m, dir, links())) || all.find((m) => models.paths(m, dir, links()));
    if (!pick) throw new Error(MISSING[kind] || "The helper model is not downloaded (Settings › Helpers).");
    return pick;
}

/** The model a job runs and its files, as the helpers' process gets them. */
function jobModel(kind, id) {
    const model = presentOf(kind, id);
    return { model: modelInfo(model), files: models.paths(model, modelsDir(), links()) };
}

function inpaintFor(id) {
    const model = presentOf("inpaint", id || conf().inpaint);
    if (!inpaintInstances.has(model.id)) inpaintInstances.set(model.id, new Lama(model, models.paths(model, modelsDir(), links()).model));
    return { model, lama: inpaintInstances.get(model.id) };
}

/** One job in the helpers' process (or, where it could not start, on this thread), sent with the settings' device. */
async function job(type, payload) {
    busy.add(type);
    try {
        return await helperProcess.call(type, { device: conf().device, ...payload });
    } finally {
        busy.delete(type);
    }
}

/**
 * Objects for the hover tool. req: { model?, key, image (RGBA 1024²), outWidth, outHeight, params? }
 * -> { ids: Uint16Array(outWidth * outHeight), width, height, count, seconds, provider, model }
 */
async function objects(req) {
    const image = checkImage(req);
    const m = jobModel("sam2", req.model || conf().sam2);
    return job("objects", { ...m, key: req.key || null, image, outWidth: req.outWidth, outHeight: req.outHeight, params: req.params || {} });
}

/**
 * One prompt on an already encoded image (or the given one). req: { model?, key, image?,
 * points: [{x, y, label}] in 1024 space, box?, outWidth, outHeight } -> { mask: Uint8Array, score }
 * (with raw: true { logits: Float32Array(256²), n, score }). Without the image for a key the process does not hold (a
 * Free VRAM, a new process) it refuses, and host.segmentLogits sends the picture.
 */
async function segment(req) {
    const m = jobModel("sam2", req.model || conf().sam2);
    return job("segment", { ...m, key: req.key || null, image: req.image || null, points: req.points || [], box: req.box || null, raw: req.raw === true, outWidth: req.outWidth, outHeight: req.outHeight });
}

/** Cutout: req { model?, image (RGBA 1024²) } -> { alpha: Uint8Array(1024²), size, seconds, provider, model } */
async function cutout(req) {
    const image = checkImage(req);
    const m = jobModel("matting", req.model || conf().matting);
    return job("cutout", { ...m, image });
}

/**
 * Remove: req { model?, image (RGBA 512²), mask (512² bytes, not 0 = fill) }
 * -> { image: Uint8Array RGBA 512² (alpha 255), size, seconds, runMs, provider, model, label }.
 * Outside the mask the answer holds the input's bytes.
 */
async function inpaint(req) {
    const n = LAMA_SIZE * LAMA_SIZE;
    const image = req && req.image;
    const mask = req && req.mask;
    if (!image || image.length !== n * 4) throw new Error(`Remove needs an RGBA image of ${LAMA_SIZE} × ${LAMA_SIZE} pixels`);
    if (!mask || mask.length !== n) throw new Error(`Remove needs a mask of ${LAMA_SIZE} × ${LAMA_SIZE} bytes`);
    const { model, lama } = inpaintFor(req.model);
    const t0 = Date.now();
    busy.add("inpaint");
    try {
        const res = await lama.run(image, mask);
        return { image: res.rgba, size: res.size, seconds: (Date.now() - t0) / 1000, runMs: res.ms, holes: res.holes, provider: res.provider, model: model.id, label: model.label };
    } finally {
        busy.delete("inpaint");
    }
}

/**
 * Load the inpaint model's session ahead of a run (about 9 s on the CPU): the Remove tool
 * asks when it is picked. -> { ready, provider, model, seconds } or { ready: false, error }
 * when the model is missing; never throws.
 */
async function warmInpaint(req) {
    const t0 = Date.now();
    try {
        const { model, lama } = inpaintFor(req && req.model);
        const { provider } = await lama.warm();
        return { ready: true, provider, model: model.id, label: model.label, seconds: (Date.now() - t0) / 1000 };
    } catch (err) {
        return { ready: false, error: String(err && err.message || err) };
    }
}

/**
 * Depth map: req { model?, image (Uint8Array RGBA w*h*4), width, height }
 * -> { depth: Float32Array, width, height, min, max, seconds, runMs, provider, model, label }.
 * Both width and height must be multiples of 14 in [14, 2058].
 */
async function depth(req) {
    const { w, h, image } = checkDepth(req);
    const m = jobModel("depth", req.model || conf().depth);
    return job("depth", { ...m, image, width: w, height: h });
}

/**
 * Deep paint's decomposition: req { model?, image (Uint8Array RGBA w*h*4), width, height, seed? } -> { albedo, shading,
 * residual: Float32Array(w*h*3) interleaved RGB, linear 0..1, width, height, seconds, ms, provider, model, label }.
 * Both sides in [16, 768]; the same picture and seed give the same bytes.
 */
async function intrinsic(req) {
    const { w, h, image } = checkIntrinsic(req);
    const m = jobModel("intrinsic", req.model || conf().intrinsic);
    return job("intrinsic", { ...m, image, width: w, height: h, seed: req.seed | 0 });
}

/**
 * Deep paint's normals: req { model?, image (Uint8Array RGBA w*h*4), width, height, tokens? } -> { normal, points:
 * Float32Array(w*h*3), mask: Float32Array(w*h), scale, tokens, width, height, seconds, runMs, provider, model, label }.
 * Both sides in [14, 2048].
 */
async function normals(req) {
    const { w, h, image } = checkNormals(req);
    const m = jobModel("normals", req.model || conf().normals);
    return job("normals", { ...m, image, width: w, height: h, tokens: req.tokens || undefined });
}

module.exports = { status, configure, scan, browseDir, openFolder, download, cancel, remove, free, objects, segment, cutout, inpaint, warmInpaint, depth, intrinsic, normals, setProgressSink, helperProcess, HF_TOKEN, DEFAULTS, LAMA_SIZE };
