// API rendering providers. Each adapter turns one edit request into one image:
//
//   edit(request, ctx) -> { bytes: Buffer, mime, width?, height?, seed?, info? }
//
//   request: { model, kind ("fill" = image + mask, "edit" = instruction on the image),
//              prompt, negative, seed, image (PNG bytes of the crop), mask (PNG, white =
//              repaint), width, height (of the crop), references: [PNG bytes], params }
//   ctx:     { key, fetch, log }
//
// The crop and the stitch happen in the renderer (renderer/editor/stitch.js); the
// adapters only speak HTTP. Keys come from keys.js by the provider's name.
"use strict";

const keys = require("../keys");

const PROVIDERS = {
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
    return Object.entries(PROVIDERS).filter(([id]) => id !== "loopback" && id !== "compat").map(([id, p]) => ({ id, label: p.label, keyUrl: p.keyUrl, keyHint: p.keyHint || "", key: keys.describe(id) }));
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
    const ctx = { key, fetch: globalThis.fetch, log: (...a) => console.log(`[${id}]`, ...a) };
    const out = text ? await p.generate(req, ctx) : await p.edit(req, ctx);
    if (!out || !out.bytes) throw new Error(p.label + " returned no image.");
    const bytes = toBuffer(out.bytes);
    return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), mime: out.mime || "image/png", seed: out.seed, info: out.info || null, seconds: (Date.now() - t0) / 1000 };
}

module.exports = { edit, describeAll, textProviders, PROVIDERS };
