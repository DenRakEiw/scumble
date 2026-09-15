// API rendering providers. Each adapter turns one edit request into one image:
//
//   edit(request, ctx) -> { bytes: Buffer, mime, width?, height?, seed?, info? }
//
//   request: { model, kind ("fill" = image + mask, "edit" = instruction on the image),
//              prompt, negative, seed, image (PNG bytes of the crop), mask (PNG, white =
//              repaint), width, height (of the crop), references: [PNG bytes], params }
//   ctx:     { key, fetch, log, base, toJpeg, opaque }   base: the adapter's own allowlisted host from
//            settings (ToAPIs; never from a recipe), toJpeg(png, quality): an image re-encoded by Electron's
//            nativeImage, opaque(png): whether it has no transparent pixel
//
// The crop and the stitch happen in the renderer (renderer/editor/stitch.js); the
// adapters only speak HTTP. Keys come from keys.js by the provider's name.
"use strict";

const { nativeImage } = require("electron");

const log = require("../log");

const keys = require("../keys");
const settings = require("../settings");

// The order is the order of Settings › API providers; ToAPIs first (docs/RECIPES.md "ToAPIs").
const PROVIDERS = {
    toapis: require("./toapis"),
    fal: require("./fal"),
    bfl: require("./bfl"),
    openai: require("./openai"),
    gemini: require("./gemini"),
    replicate: require("./replicate"),
    wavespeed: require("./wavespeed"),
    comfycloud: require("./comfycloud"),
    anthropic: require("./anthropic"),   // key row only: prompt upsampling (llm.js)
    compat: require("./compat"),         // key row only: the OpenAI-compatible endpoint (llm.js)
    loopback: require("./loopback"),
};

/** What the settings dialog shows: id, label, key name, where to get a key. */
function describeAll() {
    // loopback is the smoke test's own provider, compat has its own settings section (URL, model, key)
    return Object.entries(PROVIDERS).filter(([id]) => id !== "loopback" && id !== "compat").map(([id, p]) => ({ id, label: p.label, keyUrl: p.keyUrl, keyHint: p.keyHint || "", key: keys.describe(id), balance: typeof p.balance === "function" }));
}

function toBuffer(v) {
    if (!v) return null;
    if (Buffer.isBuffer(v)) return v;
    if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    if (v instanceof ArrayBuffer) return Buffer.from(v);
    return Buffer.from(v);
}

/** Which providers can make an image from the prompt alone (Generate new). */
function textProviders() {
    return Object.entries(PROVIDERS).filter(([, p]) => typeof p.generate === "function").map(([id]) => id);
}

async function edit(request) {
    const id = String(request.provider || "");
    const p = PROVIDERS[id];
    if (!p) throw new Error("Unknown provider: " + id);
    const text = request.kind === "text";
    if (text && typeof p.generate !== "function") throw new Error(`${p.label} has no text-to-image endpoint in Scumble; pick another provider for this model.`);
    const key = p.needsKey === false ? "" : keys.get(id);
    if (p.needsKey !== false && !key) throw new Error(`No API key for ${p.label}. Add it under Settings › API providers.`);
    const req = {
        ...request,
        image: toBuffer(request.image),
        mask: toBuffer(request.mask),
        maskAlpha: toBuffer(request.maskAlpha),   // RGBA mask, alpha 0 where to repaint (OpenAI's convention)
        fields: request.fields || null,           // model-specific input names (Replicate, fal)
        options: request.options || null,         // adapter switches from the recipe variant (fal: sizing)
        references: (request.references || []).map(toBuffer).filter(Boolean),
        params: request.params || {},
    };
    const t0 = Date.now();
    const ctx = contextFor(id, p, key);
    // the request's shape for the log: never the key, never the pixels
    const shape = () => ({ model: req.model, kind: text ? "text" : "edit", image: req.image ? req.image.length : 0, mask: req.mask ? req.mask.length : 0, references: req.references.length, params: req.params, fields: req.fields, options: req.options, prompt: String(req.prompt || "").slice(0, 200) });
    let out;
    try {
        out = text ? await p.generate(req, ctx) : await p.edit(req, ctx);
    } catch (err) {
        log.record({ level: "error", source: id, message: `${p.label} ${text ? "generate" : "edit"} failed after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${err && err.message || err}`, detail: { request: shape(), stack: err && err.stack } });
        throw err;
    }
    if (!out || !out.bytes) { log.record({ level: "error", source: id, message: p.label + " returned no image.", detail: shape() }); throw new Error(p.label + " returned no image."); }
    log.record({ source: id, message: `${p.label} ${text ? "generate" : "edit"} ok in ${((Date.now() - t0) / 1000).toFixed(1)} s`, detail: { model: req.model, bytes: out.bytes.length || out.bytes.byteLength, seed: out.seed, info: out.info } });
    const bytes = toBuffer(out.bytes);
    return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), mime: out.mime || "image/png", seed: out.seed, info: out.info || null, seconds: (Date.now() - t0) / 1000 };
}

/** A crop as JPEG through Electron's decoder and encoder (nativeImage); null when it cannot be decoded. */
function toJpeg(png, quality = 92) {
    const img = nativeImage.createFromBuffer(Buffer.from(png));
    if (img.isEmpty()) return null;
    return img.toJPEG(quality);
}

/**
 * Whether a PNG has no transparent pixel, so a JPEG of it loses nothing but compression detail. A
 * greyscale or RGB PNG without a tRNS chunk is opaque by its header; anything else is decoded and its
 * alpha read. False when it cannot be decoded.
 */
function opaque(png) {
    const b = Buffer.from(png);
    if (b.length > 33 && b.toString("latin1", 12, 16) === "IHDR") {
        const colourType = b[25];
        if ((colourType === 0 || colourType === 2) && b.indexOf("tRNS", 33, "latin1") < 0) return true;
    }
    const img = nativeImage.createFromBuffer(b);
    if (img.isEmpty()) return false;
    const px = img.toBitmap();   // BGRA
    for (let i = 3; i < px.length; i += 4) if (px[i] !== 255) return false;
    return true;
}

function contextFor(id, p, key) {
    return {
        key, fetch: globalThis.fetch, log: (...a) => console.log(`[${id}]`, ...a), toJpeg, opaque,
        base: typeof p.baseUrl === "function" ? p.baseUrl(settings.get()) : undefined,
    };
}

/** What a key has left (the key row's "check balance"), for adapters that can ask for free. */
async function balance(id) {
    const p = PROVIDERS[String(id || "")];
    if (!p || typeof p.balance !== "function") throw new Error(`${(p && p.label) || id} cannot report a balance.`);
    const key = keys.get(id);
    if (!key) throw new Error(`No API key for ${p.label}. Add it under Settings › API providers.`);
    try {
        return await p.balance(contextFor(id, p, key));
    } catch (err) {
        log.record({ level: "warn", source: id, message: `${p.label} balance failed: ${err && err.message || err}` });
        throw err;
    }
}

module.exports = { edit, balance, describeAll, textProviders, PROVIDERS };
