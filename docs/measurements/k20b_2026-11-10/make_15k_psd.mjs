// Build a deterministic 15,000 x 10,000 2-layer PSD (Background + Paint) via PsdBandWriter + px.wasm psdPackRows
// for `node tools/layered_test.js --twin-file <out.psd>` (docs/PLAN_WASM_K20.md §4.3).
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const outPath = process.argv[2];
if (!outPath) {
    console.error("usage: node make_15k_psd.mjs <out.psd>");
    process.exit(2);
}

const { loadPx } = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "px", "px.js")).href);
const { PsdBandWriter, bandRows } = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_bands.js")).href);
const wasmBytes = fs.readFileSync(path.join(ROOT, "renderer", "editor", "px", "px.wasm"));
const px = await loadPx(wasmBytes);

const W = 15000, H = 10000;
const fillBg = (y0, y1) => {
    const rows = y1 - y0, out = new Uint8Array(rows * W * 4);
    for (let r = 0; r < rows; r++) {
        const y = y0 + r, rowOff = r * W * 4;
        for (let x = 0; x < W; x++) {
            const o = rowOff + (x << 2), run = ((x >>> 4) + (y >>> 3)) & 255;
            out[o] = run;
            out[o + 1] = (run * 3 + (y & 63)) & 255;
            out[o + 2] = (255 - run) & 255;
            out[o + 3] = 255;
        }
    }
    return out;
};
const fillPaint = (y0, y1) => {
    const rows = y1 - y0, out = new Uint8Array(rows * W * 4);
    for (let r = 0; r < rows; r++) {
        const y = y0 + r;
        if (y < 1500 || y >= 8500) continue;
        const rowOff = r * W * 4;
        for (let x = 2000; x < 13000; x++) {
            const o = rowOff + (x << 2), v = ((x >>> 5) ^ (y >>> 4)) & 255;
            out[o] = v;
            out[o + 1] = (v + 85) & 255;
            out[o + 2] = (v + 170) & 255;
            out[o + 3] = 200;
        }
    }
    return out;
};

const run = (_op, args) => {
    const packed = px.psdPackRows(new Uint8Array(args.rgba), args.w, args.rows);
    return { channels: packed.map((c) => ({ lens: c.lens.buffer, data: c.data.buffer })) };
};

const writer = new PsdBandWriter({ width: W, height: H, run, flights: 4 });
await writer.layer({ name: "Background", x: 0, y: 0, opacity: 1, visible: true, blend: "normal" }, bandRows(W, H, fillBg, 256));
await writer.layer({ name: "Paint", x: 0, y: 0, opacity: 1, visible: true, blend: "normal" }, bandRows(W, H, fillPaint, 256));
const blob = await writer.finish(bandRows(W, H, fillBg, 256));
await pipeline(Readable.fromWeb(blob.stream()), fs.createWriteStream(outPath));
console.log(`wrote ${outPath} (${(blob.size / 1048576).toFixed(1)} MB)`);
