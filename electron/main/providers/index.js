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
    loopback: require("./loopback"),
};

/** What the settings dialog shows: id, label, key name, where to get a key. */
function describeAll() {
    return Object.entries(PROVIDERS).filter(([id]) => id !== "loopback").map(([id, p]) => ({ id, label: p.label, keyUrl: p.keyUrl, keyHint: p.keyHint || "", key: keys.describe(id) }));
}

function toBuffer(v) {
    if (!v) return null;
    if (Buffer.isBuffer(v)) return v;
    if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    if (v instanceof ArrayBuffer) return Buffer.from(v);
    return Buffer.from(v);
}

async function edit(request) {
    const id = String(request.provider || "");
    const p = PROVIDERS[id];
    if (!p) throw new Error("Unknown provider: " + id);
    const key = p.needsKey === false ? "" : keys.get(id);
    if (p.needsKey !== false && !key) throw new Error(`No API key for ${p.label}. Add it under Settings › API providers.`);
    const req = {
        ...request,
        image: toBuffer(request.image),
        mask: toBuffer(request.mask),
        maskAlpha: toBuffer(request.maskAlpha),   // RGBA mask, alpha 0 where to repaint (OpenAI's convention)
        references: (request.references || []).map(toBuffer).filter(Boolean),
        params: request.params || {},
    };
    const t0 = Date.now();
    const out = await p.edit(req, { key, fetch: globalThis.fetch, log: (...a) => console.log(`[${id}]`, ...a) });
    if (!out || !out.bytes) throw new Error(p.label + " returned no image.");
    const bytes = toBuffer(out.bytes);
    return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), mime: out.mime || "image/png", seed: out.seed, info: out.info || null, seconds: (Date.now() - t0) / 1000 };
}

module.exports = { edit, describeAll, PROVIDERS };
