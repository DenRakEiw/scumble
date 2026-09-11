// Test provider: hands the crop straight back. The stitched layer then equals the base
// inside the selection, which lets the smoke test check crop, placement and mask
// without an API key. Not listed in the settings dialog.
//
// generate() answers a "Generate new" run with a PNG it writes itself (a colour ramp with
// a border), which is how the text-to-image path is tested without any provider key.
//
// params.background = "transparent" answers with an RGBA PNG instead: an opaque disc on a
// fully transparent ground, which is what tools/transparent_test.py checks survives the
// stitch. That is the loopback stand-in for gpt-image's `background` parameter.
"use strict";

const zlib = require("node:zlib");

function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return ~c >>> 0;
}

function chunk(type, data) {
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
    return out;
}

/** A w x h RGB PNG: a diagonal ramp with a dark border, so a wrong size or a flip shows. */
function rampPng(w, h, seed) {
    const raw = Buffer.alloc(h * (1 + w * 3));
    const s = (seed >>> 0) % 256;
    for (let y = 0; y < h; y++) {
        const row = y * (1 + w * 3);
        raw[row] = 0;                                  // filter type 0
        for (let x = 0; x < w; x++) {
            const i = row + 1 + x * 3;
            const edge = x < 4 || y < 4 || x >= w - 4 || y >= h - 4;
            raw[i] = edge ? 20 : (x * 255 / Math.max(1, w - 1)) | 0;
            raw[i + 1] = edge ? 20 : (y * 255 / Math.max(1, h - 1)) | 0;
            raw[i + 2] = edge ? 20 : s;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8 bit, truecolour
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

/** A w x h RGBA PNG: an opaque disc on a transparent ground, the loopback cut-out. */
function discPng(w, h, seed) {
    const raw = Buffer.alloc(h * (1 + w * 4));
    const s = (seed >>> 0) % 256;
    const cx = (w - 1) / 2, cy = (h - 1) / 2, r = Math.min(w, h) * 0.4;
    for (let y = 0; y < h; y++) {
        const row = y * (1 + w * 4);
        raw[row] = 0;                                  // filter type 0
        for (let x = 0; x < w; x++) {
            const i = row + 1 + x * 4;
            const inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
            raw[i] = inside ? 230 : 0;
            raw[i + 1] = inside ? 90 : 0;
            raw[i + 2] = inside ? s : 0;
            raw[i + 3] = inside ? 255 : 0;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8 bit, truecolour + alpha
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

function transparent(req) {
    return String(req.params.background || "").toLowerCase() === "transparent";
}

module.exports = {
    label: "Loopback (test)",
    needsKey: false,
    async edit(req, ctx) {
        const delay = Math.max(0, +req.params.delay_ms || 0);
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (req.params.fail) throw new Error("loopback failure requested");
        const info = { width: req.width, height: req.height, references: req.references.length, mask: !!req.mask, background: transparent(req) ? "transparent" : "auto" };
        if (transparent(req)) return { bytes: discPng(req.width, req.height, req.seed || 0), mime: "image/png", seed: req.seed, info };
        return { bytes: req.image, mime: "image/png", seed: req.seed, info };
    },
    async generate(req, ctx) {
        const delay = Math.max(0, +req.params.delay_ms || 0);
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (req.params.fail) throw new Error("loopback failure requested");
        const w = Math.max(16, Math.min(4096, req.width | 0)), h = Math.max(16, Math.min(4096, req.height | 0));
        const bytes = transparent(req) ? discPng(w, h, req.seed || 0) : rampPng(w, h, req.seed || 0);
        return { bytes, mime: "image/png", seed: req.seed, info: { width: w, height: h, prompt: req.prompt || "", aspect: req.aspect || null, background: transparent(req) ? "transparent" : "auto" } };
    },
};
