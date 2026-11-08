/**
 * K3 kernel benchmark (docs/PLAN_WASM_BUILD.md §4.3 K3):
 *   1. crc32 across sizes 16 B .. 64 MB (Rust slice-by-16 px.crc32 vs px_scalar.crc32 vs JS twin js.crc32),
 *      measuring the JS->wasm boundary crossover and the 64 MB throughput (ms/MB).
 *   2. pngPart + png_chunk_frame (after, in-place framing + slice-by-16 CRC in wasm) vs
 *      pngPart + pngChunk("IDAT", bytes) (before, extra allocation/copy + JS byte-wise CRC)
 *      on 256-row RGBA bands at 4096 px and 15000 px.
 *   3. crc32Combine + header/trailer fold across 40 IDAT parts (~150 MB PNG) vs full-file crc32.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const PX_DIR = path.join(ROOT, "renderer", "editor", "px");

const { loadPx } = await import(pathToFileURL(path.join(PX_DIR, "px.js")).href);
const js = await import(pathToFileURL(path.join(PX_DIR, "kernels_js.js")).href);
const pngMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_png.js")).href);

const simdBytes = fs.readFileSync(path.join(PX_DIR, "px.wasm"));
const scalarBytes = fs.readFileSync(path.join(PX_DIR, "px_scalar.wasm"));
const simd = await loadPx(simdBytes);
const scalar = await loadPx(scalarBytes);

function med(xs) {
    const s = [...xs].sort((a, b) => a - b);
    return s[s.length >> 1];
}

// 1. CRC-32 size sweep (16 B .. 64 MB), rotating rounds
const sizes = [16, 32, 48, 64, 96, 128, 256, 1024, 4096, 65536, 262144, 1048576, 67108864];
const crcSweep = [];
console.log("=== 1. CRC-32 size sweep (including JS -> wasm copy-in) ===");
for (const sz of sizes) {
    const buf = new Uint8Array(sz);
    for (let i = 0; i < sz; i++) buf[i] = (i * 131 + 17) & 0xff;
    const iters = sz <= 256 ? 20000 : sz <= 4096 ? 5000 : sz <= 65536 ? 500 : sz <= 1048576 ? 40 : 1;
    const rounds = sz >= 67108864 ? 7 : 9;

    const cSimd = simd.crc32(buf, 0);
    const cScalar = scalar.crc32(buf, 0);
    const cJs = js.crc32(buf, 0);
    if (cSimd !== cJs || cScalar !== cJs) throw new Error(`crc32 mismatch at ${sz}`);

    for (let w = 0; w < Math.min(iters, 50); w++) {
        simd.crc32(buf, 0);
        scalar.crc32(buf, 0);
        js.crc32(buf, 0);
    }

    const tSimd = [], tScalar = [], tJs = [];
    for (let r = 0; r < rounds; r++) {
        const order = r % 3 === 0 ? ["simd", "scalar", "js"] : r % 3 === 1 ? ["scalar", "js", "simd"] : ["js", "simd", "scalar"];
        for (const arm of order) {
            const t0 = performance.now();
            if (arm === "simd") {
                for (let i = 0; i < iters; i++) simd.crc32(buf, 0);
                tSimd.push(((performance.now() - t0) * 1000) / iters);
            } else if (arm === "scalar") {
                for (let i = 0; i < iters; i++) scalar.crc32(buf, 0);
                tScalar.push(((performance.now() - t0) * 1000) / iters);
            } else {
                for (let i = 0; i < iters; i++) js.crc32(buf, 0);
                tJs.push(((performance.now() - t0) * 1000) / iters);
            }
        }
    }
    const simdUs = +med(tSimd).toFixed(3);
    const scalarUs = +med(tScalar).toFixed(3);
    const jsUs = +med(tJs).toFixed(3);
    const mb = sz / 1048576;
    const rec = {
        bytes: sz,
        simd_us: simdUs,
        scalar_us: scalarUs,
        js_us: jsUs,
        simd_ms_per_mb: sz >= 65536 ? +(simdUs / 1000 / mb).toFixed(3) : null,
        js_ms_per_mb: sz >= 65536 ? +(jsUs / 1000 / mb).toFixed(3) : null,
        speedup_vs_js: +(jsUs / simdUs).toFixed(2),
    };
    crcSweep.push(rec);
    console.log(
        `size=${String(sz).padStart(8)} B | simd=${String(simdUs).padStart(9)} us | scalar=${String(scalarUs).padStart(9)} us | js=${String(jsUs).padStart(9)} us | simd/js=${rec.speedup_vs_js}x` +
            (rec.simd_ms_per_mb !== null ? ` (${rec.simd_ms_per_mb} vs ${rec.js_ms_per_mb} ms/MB)` : "")
    );
}

// 2. png_chunk_frame in-place vs JS pngChunk("IDAT", bytes) on compressed IDAT payloads
console.log("\n=== 2. IDAT chunk framing + CRC (png_chunk_frame in wasm vs JS pngChunk) ===");
const chunkBench = [];
for (const [label, payloadLen, runs] of [["256 KB IDAT", 262144, 31], ["1 MB IDAT", 1048576, 15], ["4 MB IDAT", 4194304, 9]]) {
    const payload = new Uint8Array(payloadLen);
    for (let i = 0; i < payloadLen; i++) payload[i] = (i * 73 + 19) & 0xff;

    // Legacy JS pngChunk("IDAT", payload): allocates len+12, sets type + payload, runs JS crc32 over len+4
    const legacyPngChunk = (data) => {
        const len = data.byteLength;
        const out = new Uint8Array(len + 12);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, len);
        out[4] = 0x49; out[5] = 0x44; out[6] = 0x41; out[7] = 0x54;
        out.set(data, 8);
        dv.setUint32(8 + len, js.crc32(out.subarray(4, 8 + len), 0));
        return out;
    };

    // Pre-stage payload into wasm heap at offset + 8 (as pngPart does after deflate)
    const cap = payloadLen + 12;
    const ptr = simd.job.take(cap);
    try {
    simd.u8().set(payload, ptr + 8);
    const frameInWasm = () => {
        const crc = simd.exports.png_chunk_frame(ptr, payloadLen, 0x49444154) >>> 0;
        const chunk = simd.u8().slice(ptr, ptr + payloadLen + 12);
        return { chunk, crc };
    };

    const ref = legacyPngChunk(payload);
    const got = frameInWasm();
    if (Buffer.compare(ref, got.chunk) !== 0) throw new Error(`chunk mismatch at ${label}`);

    const tAfter = [], tBefore = [];
    for (let r = 0; r < runs; r++) {
        if (r % 2 === 0) {
            let t0 = performance.now();
            frameInWasm();
            tAfter.push(performance.now() - t0);
            t0 = performance.now();
            legacyPngChunk(payload);
            tBefore.push(performance.now() - t0);
        } else {
            let t0 = performance.now();
            legacyPngChunk(payload);
            tBefore.push(performance.now() - t0);
            t0 = performance.now();
            frameInWasm();
            tAfter.push(performance.now() - t0);
        }
    }
    const beforeMs = +med(tBefore).toFixed(3);
    const afterMs = +med(tAfter).toFixed(3);
    const rec = {
        label,
        payload_bytes: payloadLen,
        before_js_pngChunk_ms: beforeMs,
        after_wasm_chunk_frame_ms: afterMs,
        speedup: +(beforeMs / afterMs).toFixed(2),
    };
    chunkBench.push(rec);
    console.log(`${label.padEnd(14)} | before (JS pngChunk): ${String(beforeMs).padStart(7)} ms | after (wasm png_chunk_frame + slice): ${String(afterMs).padStart(7)} ms | ${rec.speedup}x`);
    } finally { simd._reset(simd.job); }
}

// 3. ORA entry CRC: PngStreamWriter crc32Combine fold across 40 IDAT parts (150 MB PNG) vs full-file crc32
console.log("\n=== 3. ORA PNG entry CRC: crc32Combine fold (40 parts, 150 MB) vs full-file CRC-32 ===");
const numParts = 40;
const partPayloadLen = 3932160; // ~3.75 MB x 40 = 150 MB
const partChunk = new Uint8Array(partPayloadLen + 12);
for (let i = 0; i < partChunk.length; i++) partChunk[i] = (i * 41 + 7) & 0xff;
const partCrc = simd.crc32(partChunk.subarray(4, 8 + partPayloadLen), 0);
const hdr = new Uint8Array(35);
const ftr = new Uint8Array(18);
for (let i = 0; i < hdr.length; i++) hdr[i] = i;
for (let i = 0; i < ftr.length; i++) ftr[i] = i + 50;

const combineFold = () => {
    let crc = js.crc32(hdr, 0);
    for (let p = 0; p < numParts; p++) {
        crc = js.crc32(partChunk.subarray(0, 4), crc);
        crc = pngMod.crc32Combine(crc, partCrc, partPayloadLen + 4);
        crc = js.crc32(partChunk.subarray(partChunk.byteLength - 4), crc);
    }
    return js.crc32(ftr, crc);
};

// Verify against streaming crc32 over all 40 parts
let expectedFullCrc = simd.crc32(hdr, 0);
for (let p = 0; p < numParts; p++) expectedFullCrc = simd.crc32(partChunk, expectedFullCrc);
expectedFullCrc = simd.crc32(ftr, expectedFullCrc);
if (combineFold() !== expectedFullCrc) throw new Error("combineFold mismatch");

const tCombine = [], tSimdFull = [], tJsFull = [];
for (let r = 0; r < 5; r++) {
    let t0 = performance.now();
    for (let k = 0; k < 100; k++) combineFold();
    tCombine.push((performance.now() - t0) / 100);

    t0 = performance.now();
    let c1 = simd.crc32(hdr, 0);
    for (let p = 0; p < numParts; p++) c1 = simd.crc32(partChunk, c1);
    c1 = simd.crc32(ftr, c1);
    tSimdFull.push(performance.now() - t0);

    t0 = performance.now();
    let c2 = js.crc32(hdr, 0);
    for (let p = 0; p < numParts; p++) c2 = js.crc32(partChunk, c2);
    c2 = js.crc32(ftr, c2);
    tJsFull.push(performance.now() - t0);
}
const combineRec = {
    total_mb: +((numParts * partChunk.byteLength) / 1048576).toFixed(1),
    parts: numParts,
    combine_fold_ms: +med(tCombine).toFixed(4),
    rust_full_crc_ms: +med(tSimdFull).toFixed(2),
    js_full_crc_ms: +med(tJsFull).toFixed(2),
};
console.log(
    `150 MB PNG (40 parts) | combineFold: ${combineRec.combine_fold_ms} ms | Rust full crc32: ${combineRec.rust_full_crc_ms} ms | JS full crc32: ${combineRec.js_full_crc_ms} ms`
);

const outPath = process.argv[2];
if (outPath) {
    fs.writeFileSync(
        outPath,
        JSON.stringify(
            {
                runtime: process.versions.electron ? "electron" : "node",
                v8: process.versions.v8,
                crcSweep,
                chunkBench,
                combineRec,
            },
            null,
            2
        ) + "\n"
    );
}
process.exit(0);
