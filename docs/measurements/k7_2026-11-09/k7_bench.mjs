import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const PX_DIR = path.join(ROOT, "renderer", "editor", "px");

const js = await import(pathToFileURL(path.join(PX_DIR, "kernels_js.js")).href);
const P = await import(pathToFileURL(path.join(PX_DIR, "px.js")).href);
const simd = await P.loadPx(fs.readFileSync(path.join(PX_DIR, "px.wasm")));
const scalar = await P.loadPx(fs.readFileSync(path.join(PX_DIR, "px_scalar.wasm")));

const rtCanvas = new Uint8Array(65536);
for (let a = 0; a < 256; a++) {
    for (let c = 0; c < 256; c++) {
        const idx = (a << 8) | c;
        if (a === 0) rtCanvas[idx] = 0;
        else if (a === 255) rtCanvas[idx] = c;
        else {
            const p = Math.floor((c * a + 127) / 255);
            rtCanvas[idx] = Math.min(255, Math.floor((p * 255 + (a >> 1)) / a));
        }
    }
}

function makeRGBA(w, rows, seed, translucent = true) {
    const key = Buffer.alloc(16, seed & 255), iv = Buffer.alloc(16, (seed >>> 8) & 255);
    const out = new Uint8Array(crypto.createCipheriv("aes-128-ctr", key, iv).update(Buffer.alloc(w * rows * 4)));
    if (!translucent) {
        for (let i = 3; i < out.length; i += 4) out[i] = 255;
    }
    return out;
}

function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function buildLines(rgba, w, rows, prev0, firstFt, nextFtFn) {
    const rowBytes = w * 4, stride = rowBytes + 1, out = new Uint8Array(rows * stride);
    for (let y = 0; y < rows; y++) {
        const cur = rgba.subarray(y * rowBytes, (y + 1) * rowBytes);
        const up = y === 0 ? prev0 : rgba.subarray((y - 1) * rowBytes, y * rowBytes);
        const ft = y === 0 ? firstFt : nextFtFn(y);
        const dst = out.subarray(y * stride, (y + 1) * stride);
        dst[0] = ft;
        for (let i = 0; i < rowBytes; i++) {
            const a = i >= 4 ? cur[i - 4] : 0;
            const b = up ? up[i] : 0;
            const c = i >= 4 && up ? up[i - 4] : 0;
            const pred = ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : paeth(a, b, c);
            dst[1 + i] = (cur[i] - pred) & 255;
        }
    }
    return out;
}

function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    return s[s.length >> 1];
}

function fmt(n, d = 2) {
    return n.toFixed(d);
}

const runtimeLabel = process.versions.electron
    ? `Electron ${process.versions.electron} (Node ${process.versions.node}, V8 ${process.versions.v8})`
    : `Node ${process.versions.node} (V8 ${process.versions.v8})`;

console.log(`Runtime: ${runtimeLabel}`);
console.log("");

const results = { runtime: runtimeLabel, cases: [] };

for (const [shapeName, w, rows] of [
    ["15000x139 (8.34 MB part)", 15000, 139],
    ["4096x256 (4.19 MB part)", 4096, 256],
]) {
    const rowBytes = w * 4, stride = rowBytes + 1;
    const rgbaTrans = makeRGBA(w, rows, 101, true);
    const rgbaOpaque = makeRGBA(w, rows, 102, false);
    const prev0 = makeRGBA(w, 1, 103, true);
    const outBuf = new Uint8Array(rows * rowBytes);
    const prevWork = prev0.slice();

    const configs = [
        { name: "Sub first + mixed 1..4, translucent + rt", lines: buildLines(rgbaTrans, w, rows, prev0, 1, (y) => (y % 4) + 1), rt: rtCanvas, prev: prev0 },
        { name: "Paeth all rows, translucent + rt (with prev)", lines: buildLines(rgbaTrans, w, rows, prev0, 4, () => 4), rt: rtCanvas, prev: prev0 },
        { name: "Paeth all rows, opaque + rt (with prev)", lines: buildLines(rgbaOpaque, w, rows, prev0, 4, () => 4), rt: rtCanvas, prev: prev0 },
        { name: "Paeth all rows, translucent, no rt (with prev)", lines: buildLines(rgbaTrans, w, rows, prev0, 4, () => 4), rt: null, prev: prev0 },
        { name: "Paeth all rows, needsPrev (null prev) + finish + rt", lines: buildLines(rgbaTrans, w, rows, prev0, 4, () => 4), rt: rtCanvas, prev: null },
    ];

    // Warm up resident rtCanvas and arenas
    simd.pngPartDecode(configs[0].lines, w, prevWork, rtCanvas, outBuf);
    scalar.pngPartDecode(configs[0].lines, w, prevWork, rtCanvas, outBuf);
    js.pngPartDecode(configs[0].lines, w, prevWork, rtCanvas, outBuf);

    console.log(`=== ${shapeName} (${configs[0].lines.byteLength} B lines -> ${outBuf.byteLength} B RGBA) ===`);
    const ROUNDS = 21;
    for (const cfg of configs) {
        const simdTotal = [], simdCopyIn = [], simdDecode = [], simdFinish = [], simdCopyOut = [];
        const scalarTotal = [], jsTotal = [];
        for (let r = 0; r < ROUNDS; r++) {
            if (cfg.prev) {
                const l = { copyIn: 0, decode: 0, copyOut: 0 };
                prevWork.set(cfg.prev);
                const t0 = performance.now();
                simd.pngPartDecode(cfg.lines, w, prevWork, cfg.rt, outBuf, l);
                simdTotal.push(performance.now() - t0);
                simdCopyIn.push(l.copyIn);
                simdDecode.push(l.decode);
                simdFinish.push(0);
                simdCopyOut.push(l.copyOut);

                prevWork.set(cfg.prev);
                const t1 = performance.now();
                scalar.pngPartDecode(cfg.lines, w, prevWork, cfg.rt, outBuf);
                scalarTotal.push(performance.now() - t1);

                prevWork.set(cfg.prev);
                const t2 = performance.now();
                js.pngPartDecode(cfg.lines, w, prevWork, cfg.rt, outBuf);
                jsTotal.push(performance.now() - t2);
            } else {
                const l1 = { copyIn: 0, decode: 0, copyOut: 0 };
                const l2 = { copyIn: 0, finish: 0, copyOut: 0 };
                prevWork.set(prev0);
                const t0 = performance.now();
                simd.pngPartDecode(cfg.lines, w, null, cfg.rt, outBuf, l1);
                simd.pngPartFinish(cfg.lines, rows, w, prevWork, cfg.rt, outBuf, l2);
                simdTotal.push(performance.now() - t0);
                simdCopyIn.push(l1.copyIn + l2.copyIn);
                simdDecode.push(l1.decode);
                simdFinish.push(l2.finish);
                simdCopyOut.push(l1.copyOut + l2.copyOut);

                prevWork.set(prev0);
                const t1 = performance.now();
                scalar.pngPartDecode(cfg.lines, w, null, cfg.rt, outBuf);
                scalar.pngPartFinish(cfg.lines, rows, w, prevWork, cfg.rt, outBuf);
                scalarTotal.push(performance.now() - t1);

                prevWork.set(prev0);
                const t2 = performance.now();
                js.pngPartDecode(cfg.lines, w, null, cfg.rt, outBuf);
                js.pngPartFinish(cfg.lines, rows, w, prevWork, cfg.rt, outBuf);
                jsTotal.push(performance.now() - t2);
            }
        }
        const row = {
            shape: shapeName,
            config: cfg.name,
            linesBytes: cfg.lines.byteLength,
            outBytes: outBuf.byteLength,
            simdMs: median(simdTotal),
            simdCopyInMs: median(simdCopyIn),
            simdDecodeMs: median(simdDecode),
            simdFinishMs: median(simdFinish),
            simdCopyOutMs: median(simdCopyOut),
            scalarMs: median(scalarTotal),
            jsMs: median(jsTotal),
            speedupVsJs: median(jsTotal) / median(simdTotal),
            speedupVsScalar: median(scalarTotal) / median(simdTotal),
        };
        results.cases.push(row);
        if (cfg.prev) {
            console.log(`  ${cfg.name}:`);
            console.log(`    simd ${fmt(row.simdMs)} ms (copyIn ${fmt(row.simdCopyInMs)} ms, decode ${fmt(row.simdDecodeMs)} ms, copyOut ${fmt(row.simdCopyOutMs)} ms) | scalar ${fmt(row.scalarMs)} ms | twin ${fmt(row.jsMs)} ms | simd/twin ${fmt(row.speedupVsJs)}x`);
        } else {
            console.log(`  ${cfg.name}:`);
            console.log(`    simd ${fmt(row.simdMs)} ms (copyIn 2x=${fmt(row.simdCopyInMs)} ms, decode(adler) ${fmt(row.simdDecodeMs)} ms, finish ${fmt(row.simdFinishMs)} ms, copyOut ${fmt(row.simdCopyOutMs)} ms) | scalar ${fmt(row.scalarMs)} ms | twin ${fmt(row.jsMs)} ms | simd/twin ${fmt(row.speedupVsJs)}x`);
        }
    }
    console.log("");
}

const outPath = process.argv[2];
if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
}
process.exit(0);
