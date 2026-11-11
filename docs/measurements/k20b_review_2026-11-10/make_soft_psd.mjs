// K20b review (K20b-T1): a deterministic 15,000 x 10,000 PSD with an opaque Background and SOFT soft-alpha layers
// (default 3), each full size with alpha varying between 40 and 230, so every band of every soft layer takes the
// window's soft-alpha writeRect path. Written with PsdBandWriter + px.wasm psdPackRows (PackBits, as Scumble writes).
//   node make_soft_psd.mjs <out.psd> [soft layers] [width height]
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const outPath = process.argv[2];
const SOFT = Math.max(1, parseInt(process.argv[3] || "3", 10));
if (!outPath) {
    console.error("usage: node make_soft_psd.mjs <out.psd> [soft layers]");
    process.exit(2);
}

const { loadPx } = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "px", "px.js")).href);
const { PsdBandWriter, bandRows } = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_bands.js")).href);
const px = await loadPx(fs.readFileSync(path.join(ROOT, "renderer", "editor", "px", "px.wasm")));

const W = parseInt(process.argv[4] || "15000", 10), H = parseInt(process.argv[5] || "10000", 10);   // a smaller size for a smoke run
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
const fillSoft = (k) => (y0, y1) => {
    const rows = y1 - y0, out = new Uint8Array(rows * W * 4);
    for (let r = 0; r < rows; r++) {
        const y = y0 + r, rowOff = r * W * 4;
        for (let x = 0; x < W; x++) {
            const o = rowOff + (x << 2), v = ((x >>> (5 + k)) ^ (y >>> 4)) & 255;
            out[o] = (v + 40 * k) & 255;
            out[o + 1] = (v + 85) & 255;
            out[o + 2] = (v * 3 + 170) & 255;
            out[o + 3] = 40 + ((((x >>> 6) + (y >>> 5) + 37 * k) & 255) * 190 >> 8);   // 40..229
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
for (let k = 1; k <= SOFT; k++) {
    await writer.layer({ name: `Soft ${k}`, x: 0, y: 0, opacity: 1, visible: true, blend: "normal" }, bandRows(W, H, fillSoft(k), 256));
}
const blob = await writer.finish(bandRows(W, H, fillBg, 256));
await pipeline(Readable.fromWeb(blob.stream()), fs.createWriteStream(outPath));
console.log(`wrote ${outPath} (${(blob.size / 1048576).toFixed(1)} MB, Background + ${SOFT} soft-alpha layers)`);
process.exit(0);
