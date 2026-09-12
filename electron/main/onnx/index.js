// The helpers facade the main process exposes over IPC: model folder and downloads,
// the ONNX runtime with its device choice, and the two jobs the editor asks for
// (objects for the hover tool, cutout for a layer). Settings live in settings.json
// under `helpers`; the Hugging Face token in keys.js under "hf-token".
"use strict";

const path = require("node:path");
const fsp = require("node:fs/promises");
const { app, dialog, shell } = require("electron");
const settings = require("../settings");
const keys = require("../keys");
const models = require("./models");
const { Runtime } = require("./runtime");
const { Sam2, logitsToMask, SIZE } = require("./sam2");
const { Matting } = require("./matting");

const HF_TOKEN = "hf-token";
const DEFAULTS = { device: "auto", dir: null, sam2: "sam2_base_plus", matting: "birefnet_lite" };

const runtime = new Runtime();
let progressSink = null;
const sam2Instances = new Map();     // model id -> Sam2
const mattingInstances = new Map();  // model id -> Matting
const busy = new Set();              // running jobs, for the status line

function conf() {
    return { ...DEFAULTS, ...(settings.get().helpers || {}) };
}

function modelsDir() {
    return conf().dir || path.join(app.getPath("userData"), "models");
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

const downloader = new models.Downloader(modelsDir, () => keys.get(HF_TOKEN), (ev) => {
    if (progressSink) progressSink(ev);
});

function setProgressSink(fn) { progressSink = fn; }

function status() {
    const c = conf();
    runtime.setDevice(c.device);
    const dir = modelsDir();
    const sc = lastScan(dir);
    return {
        dir, isDefaultDir: !c.dir, downloadDir: models.downloadDir(dir), isComfyDir: models.isComfyModelsDir(dir),
        device: c.device, sam2: c.sam2, matting: c.matting,
        models: models.describeAll(dir, links(), sc ? sc.elsewhere : null),
        scan: sc,
        downloads: downloader.running(),
        runtime: runtime.status(),
        hfToken: keys.describe(HF_TOKEN),
        busy: Array.from(busy),
    };
}

async function configure(patch) {
    const before = conf();
    const next = { ...before, ...(patch || {}) };
    if (patch && "device" in patch && next.device !== before.device) { runtime.setDevice(next.device); await free(); }
    const dirChanged = !!(patch && "dir" in patch && patch.dir !== before.dir);
    if (dirChanged) { sam2Instances.clear(); mattingInstances.clear(); await free(); }
    settings.set({ helpers: next });
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
    sam2Instances.clear(); mattingInstances.clear();
    return status();
}

async function browseDir(win) {
    const r = await dialog.showOpenDialog(win, { title: "Model folder (the app's own, or a ComfyUI models folder)", defaultPath: modelsDir(), properties: ["openDirectory", "createDirectory"] });
    if (r.canceled || !r.filePaths.length) return null;
    return configure({ dir: r.filePaths[0] });
}

async function openFolder() {
    const d = models.downloadDir(modelsDir());
    await fsp.mkdir(d, { recursive: true });
    return shell.openPath(d);
}

async function download(id) {
    const loc = await downloader.download(id);
    return loc ? status() : null;
}

function cancel(id) { return downloader.cancel(id); }

async function remove(id) {
    const dir = modelsDir();
    const model = models.byId(id);
    if (!model) throw new Error("unknown model " + id);
    const loc = models.locate(model, dir, links());
    if (loc.present && loc.linked) {
        // a linked file belongs to the user's folder (a ComfyUI models folder, mostly):
        // forget the link, never delete the file
        const l = { ...links() };
        delete l[id];
        settings.set({ helpers: { ...conf(), links: l } });
    } else {
        await free();
        await models.remove(id, dir);
    }
    sam2Instances.delete(id);
    mattingInstances.delete(id);
    return status();
}

async function free() {
    for (const s of sam2Instances.values()) s.cache.clear();
    return runtime.free();
}

function presentOf(kind, wanted) {
    const dir = modelsDir();
    const all = models.MODELS.filter((m) => m.kind === kind);
    const pick = all.find((m) => m.id === wanted && models.paths(m, dir, links())) || all.find((m) => models.paths(m, dir, links()));
    if (!pick) throw new Error(kind === "sam2" ? "No SAM2 model is downloaded (Settings › Helpers)." : "No background removal model is downloaded (Settings › Helpers).");
    return pick;
}

function sam2For(id) {
    const model = presentOf("sam2", id || conf().sam2);
    if (!sam2Instances.has(model.id)) sam2Instances.set(model.id, new Sam2(runtime, models.paths(model, modelsDir(), links())));
    return { model, sam: sam2Instances.get(model.id) };
}

function mattingFor(id) {
    const model = presentOf("matting", id || conf().matting);
    if (!mattingInstances.has(model.id)) mattingInstances.set(model.id, new Matting(runtime, model, models.paths(model, modelsDir(), links()).model));
    return { model, matting: mattingInstances.get(model.id) };
}

function checkImage(req) {
    const image = req && req.image;
    if (!image || image.length !== SIZE * SIZE * 4) throw new Error(`the helper needs an RGBA image of ${SIZE} × ${SIZE} pixels`);
    return image;
}

/**
 * Objects for the hover tool. req: { model?, key, image (RGBA 1024²), outWidth, outHeight, params? }
 * -> { ids: Uint16Array(outWidth * outHeight), width, height, count, seconds, provider, model }
 */
async function objects(req) {
    const image = checkImage(req);
    const { model, sam } = sam2For(req.model);
    const outW = Math.max(1, Math.min(4096, Math.round(req.outWidth || SIZE)));
    const outH = Math.max(1, Math.min(4096, Math.round(req.outHeight || SIZE)));
    const t0 = Date.now();
    busy.add("objects");
    try {
        const emb = await sam.encode(image, req.key || null);
        const res = await sam.automask(emb, outW, outH, req.params || {});
        return { ids: res.ids, width: outW, height: outH, count: res.count, candidates: res.candidates, seconds: (Date.now() - t0) / 1000, encodeMs: emb.encodeMs, provider: emb.provider, model: model.id, label: model.label };
    } finally {
        busy.delete("objects");
    }
}

/**
 * One prompt on an already encoded image (or the given one). req: { model?, key, image?,
 * points: [{x, y, label}] in 1024 space, box?, outWidth, outHeight } -> { mask: Uint8Array, score }
 */
async function segment(req) {
    const { model, sam } = sam2For(req.model);
    let emb = req.key ? sam.cache.get(req.key) : null;
    if (!emb) emb = await sam.encode(checkImage(req), req.key || null);
    const outW = Math.max(1, Math.min(4096, Math.round(req.outWidth || SIZE)));
    const outH = Math.max(1, Math.min(4096, Math.round(req.outHeight || SIZE)));
    busy.add("segment");
    try {
        const { logits, score } = await sam.predict(emb, req.points || [], req.box || null);
        return { mask: logitsToMask(logits, outW, outH), width: outW, height: outH, score, provider: emb.provider, model: model.id, label: model.label };
    } finally {
        busy.delete("segment");
    }
}

/** Cutout: req { model?, image (RGBA 1024²) } -> { alpha: Uint8Array(1024²), size, seconds, provider, model } */
async function cutout(req) {
    const image = checkImage(req);
    const { model, matting } = mattingFor(req.model);
    const t0 = Date.now();
    busy.add("cutout");
    try {
        const res = await matting.run(image);
        return { alpha: res.alpha, size: res.size, seconds: (Date.now() - t0) / 1000, provider: res.provider, model: model.id, label: model.label };
    } finally {
        busy.delete("cutout");
    }
}

module.exports = { status, configure, scan, browseDir, openFolder, download, cancel, remove, free, objects, segment, cutout, setProgressSink, HF_TOKEN, DEFAULTS };
