/**
 * Node / Electron-as-Node explaining micro-benchmark for K10c (`docs/PLAN_WASM_K10.md` §3, §5.3, §7):
 *   1. Tile-store PSD part (15,000 x 256, 59 tiles): `tilesRowsToWasm + psdPackRowsFromPtr` (`psdPartWasm=rust`) vs `rowsOfTiles + psdPackRows` (`psdPartWasm=js`).
 *   2. Stack PSD part (15,000 x 256, base + 2 layers with clip, dissolve, mask, match): `stackRowsToWasm + psdPackRowsFromPtr` (`psdPartWasm=rust`) vs `rowsOfStack + psdPackRows` (`psdPartWasm=js`).
 *   3. Stack into buffer (`stack_into` 15,000 x 256 band): `stackRowsToWasm + p.get` (`stackIntoWasm=rust`) vs `rowsOfStack` (`stackIntoWasm=js`).
 *   4. `clip_coverage` (15,000 x 256 = 3,840,000 px, `base_mask` + `alpha` + `own`): JS `clipCoverage` vs Rust SIMD (`px.wasm`) vs Rust scalar (`px_scalar.wasm`), plus inside `stackRowsToWasm` (`clipCoverage=js` vs `rust`).
 *   5. `dissolve_rows` (15,000 x 256 = 3,840,000 px, `alpha` + `mask` + `seed`): JS dissolve loop vs Rust SIMD (`px.wasm`) vs Rust scalar (`px_scalar.wasm`), plus inside `stackRowsToWasm` (`dissolveRows=js` vs `rust`).
 */
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");

const origFetch = globalThis.fetch;
globalThis.fetch = async (u, opts) => {
    const s = String(u);
    if (s.startsWith("file:")) {
        const bytes = fs.readFileSync(fileURLToPath(s));
        return new Response(bytes, { status: 200, headers: { "content-type": "application/wasm" } });
    }
    return origFetch(u, opts);
};

const K = await import(new URL("../../../renderer/editor/px/kernels.js", import.meta.url));
const P = await import(new URL("../../../renderer/editor/px/px.js", import.meta.url));
const W = await import(new URL("../../../renderer/editor/inpaint_worker.js", import.meta.url));
const R = await import(new URL("../../../renderer/editor/inpaint_raster.js", import.meta.url));
const B = await import(new URL("../../../renderer/editor/blend_modes.js", import.meta.url));

await K.kernelsReady();

const simdBytes = fs.readFileSync(path.join(ROOT, "renderer/editor/px/px.wasm"));
const scalarBytes = fs.readFileSync(path.join(ROOT, "renderer/editor/px/px_scalar.wasm"));
const simdPx = await P.loadPx(simdBytes);
const scalarPx = await P.loadPx(scalarBytes);

const W_PX = 15000, H_PX = 256, TILE = 256;
const PX_N = W_PX * H_PX;
const ntx = Math.ceil(W_PX / TILE);

function makeTileRow(seed) {
    const row = new Array(ntx);
    const pool = [0, 1, 2, 3].map((k) => {
        const b = new Uint8Array(TILE * TILE * 4);
        let s = (seed + k * 0x9E3779B9) >>> 0;
        for (let i = 0; i < b.length; i += 4) {
            s = (Math.imul(s ^ (s >>> 15), 0x85EBCA6B) + 0xC2B2AE35) >>> 0;
            b[i] = s & 0xFF;
            b[i + 1] = (s >>> 8) & 0xFF;
            b[i + 2] = (s >>> 16) & 0xFF;
            b[i + 3] = (i & 63) === 0 ? 0 : (140 + ((s >>> 24) & 0x73));
        }
        return { data: b.buffer };
    });
    for (let tx = 0; tx < ntx; tx++) row[tx] = pool[tx & 3];
    return row;
}

const tiles0 = makeTileRow(101);
const tiles1 = makeTileRow(202);
const clipBaseTiles = { 0: makeTileRow(252), 1: makeTileRow(262) };
const clipMaskTiles = { 0: makeTileRow(272), 1: makeTileRow(282) };
const layer1Tiles = { 0: makeTileRow(303), 1: makeTileRow(404) };
const mask1Tiles = { 0: makeTileRow(505), 1: makeTileRow(606) };
const layer2Tiles = { 0: makeTileRow(707), 1: makeTileRow(808) };
const mask2Tiles = { 0: makeTileRow(818), 1: makeTileRow(909) };

const psdTileMsg = {
    w: W_PX,
    rows: H_PX,
    r0: 0,
    tiles: tiles1,
};

const stackSpec = {
    base: { x: 0, y: 0, w: W_PX, h: H_PX * 2, tiles: { 0: tiles0, 1: tiles1 } },
    layers: [
        {
            x: 0, y: 0, w: W_PX, h: H_PX * 2,
            tiles: layer1Tiles,
            mask: mask1Tiles,
            alpha: 210,
            op: 0,
            clip: {
                x: 0, y: 0, w: W_PX, h: H_PX * 2,
                tiles: clipBaseTiles,
                mask: clipMaskTiles,
                alpha: 225,
            },
        },
        {
            x: 0, y: 0, w: W_PX, h: H_PX * 2,
            tiles: layer2Tiles,
            mask: mask2Tiles,
            alpha: 190,
            op: 0,
            dissolve: 0x13579BDF,
            match: [0.42, 0.02, -0.01, 0.45, 0.01, 0.02, 1.04, 0.96, 1.02, 0.6],
        },
    ],
};

const psdStackMsg = {
    w: W_PX,
    rows: H_PX,
    x0: 0,
    y0: 0,
    y: H_PX,
    stack: stackSpec,
};

function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

function sameBytes(a, b) {
    if (a.byteLength !== b.byteLength) return false;
    const ua = new Uint8Array(a.buffer || a, a.byteOffset || 0, a.byteLength);
    const ub = new Uint8Array(b.buffer || b, b.byteOffset || 0, b.byteLength);
    for (let i = 0; i < ua.length; i++) {
        if (ua[i] !== ub[i]) return false;
    }
    return true;
}

async function benchPsdRoute(label, msg, routeName, routeVal, iters = 7) {
    K.setRoute(routeName, routeVal);
    P.pxTimed(true);
    const warm = await W.psdPart(msg);
    const walls = [], kernels = [], composes = [], rowsArr = [], packs = [], copyInMBs = [], copyOutMBs = [];
    for (let i = 0; i < iters; i++) {
        P.pxCalls(true);
        const t0 = performance.now();
        const r = await W.psdPart(msg);
        const dt = performance.now() - t0;
        const laps = P.pxLaps();
        walls.push(dt);
        kernels.push(r.timing.kernel);
        composes.push(r.timing.compose || 0);
        rowsArr.push(r.timing.rows || 0);
        packs.push(r.timing.pack || 0);
        copyInMBs.push(laps.copyInMB);
        copyOutMBs.push(laps.copyOutMB);
    }
    K.setRoute(routeName, null);
    return {
        res: warm,
        summary: {
            label,
            route: routeVal || "rust",
            composeWasm: warm.timing.composeWasm,
            wallMed: +median(walls).toFixed(2),
            wallMin: +Math.min(...walls).toFixed(2),
            wallMax: +Math.max(...walls).toFixed(2),
            kernelMed: +median(kernels).toFixed(2),
            composeMed: +median(composes).toFixed(2),
            rowsMed: +median(rowsArr).toFixed(2),
            packMed: +median(packs).toFixed(2),
            copyInMB: +median(copyInMBs).toFixed(2),
            copyOutMB: +median(copyOutMBs).toFixed(2),
        },
    };
}

async function benchStackIntoRoute(label, routeName, routeVal, iters = 7) {
    const intoBuf = new Uint8Array(PX_N * 4);
    const msg = {
        w: W_PX,
        rows: H_PX,
        x0: 0,
        y0: H_PX,
        y: H_PX,
        clear: true,
        sab: intoBuf.buffer,
        stack: stackSpec,
    };
    K.setRoute(routeName, routeVal);
    P.pxTimed(true);
    const warm = await W.stackInto(msg);
    const saved = new Uint8Array(intoBuf);
    const walls = [], kernels = [], copyInMBs = [], copyOutMBs = [];
    for (let i = 0; i < iters; i++) {
        P.pxCalls(true);
        const t0 = performance.now();
        const r = await W.stackInto(msg);
        const dt = performance.now() - t0;
        const laps = P.pxLaps();
        walls.push(dt);
        kernels.push(r.timing.kernel);
        copyInMBs.push(laps.copyInMB);
        copyOutMBs.push(laps.copyOutMB);
    }
    K.setRoute(routeName, null);
    return {
        bytes: saved,
        summary: {
            label,
            route: routeVal || "rust",
            composeWasm: warm.timing.composeWasm,
            wallMed: +median(walls).toFixed(2),
            wallMin: +Math.min(...walls).toFixed(2),
            wallMax: +Math.max(...walls).toFixed(2),
            kernelMed: +median(kernels).toFixed(2),
            copyInMB: +median(copyInMBs).toFixed(2),
            copyOutMB: +median(copyOutMBs).toFixed(2),
        },
    };
}

// 4. Direct kernel micro-benchmark: clip_coverage (15,000 x 256 = 3,840,000 bytes)
function benchClipCoverageDirect(iters = 15) {
    const covInit = new Uint8Array(PX_N);
    const baseMask = new Uint8Array(PX_N);
    const ownMask = new Uint8Array(PX_N);
    for (let i = 0; i < PX_N; i++) {
        covInit[i] = (i * 73 + 19) & 0xFF;
        baseMask[i] = (i * 41 + 7) & 0xFF;
        ownMask[i] = (i * 97 + 3) & 0xFF;
    }
    const alpha = 213;

    // JS reference
    const jsOut = new Uint8Array(covInit);
    R.clipCoverage(jsOut, baseMask, alpha, ownMask);
    const jsTimes = [];
    for (let i = 0; i < iters; i++) {
        const work = new Uint8Array(covInit);
        const t0 = performance.now();
        R.clipCoverage(work, baseMask, alpha, ownMask);
        jsTimes.push(performance.now() - t0);
    }

    function runWasm(pxInst) {
        const a = pxInst.job;
        const pcov = a.take(PX_N, 16);
        const pbm = a.take(PX_N, 16);
        const pown = a.take(PX_N, 16);
        pxInst.put(pbm, baseMask);
        pxInst.put(pown, ownMask);
        pxInst.put(pcov, covInit);
        pxInst.exports.clip_coverage(pcov, PX_N, pbm, alpha, pown);
        const out = pxInst.get(Uint8Array, pcov, PX_N);
        if (!sameBytes(out, jsOut)) {
            throw new Error(`clip_coverage mismatch on ${pxInst.simd ? "simd" : "scalar"}`);
        }
        const times = [];
        for (let i = 0; i < iters; i++) {
            pxInst.put(pcov, covInit);
            const t0 = performance.now();
            pxInst.exports.clip_coverage(pcov, PX_N, pbm, alpha, pown);
            times.push(performance.now() - t0);
        }
        pxInst._reset(a);
        return times;
    }

    const simdTimes = runWasm(simdPx);
    const scalarTimes = runWasm(scalarPx);
    return {
        px: PX_N,
        jsMedMs: +median(jsTimes).toFixed(3),
        simdMedMs: +median(simdTimes).toFixed(3),
        scalarMedMs: +median(scalarTimes).toFixed(3),
        speedupSimdVsJs: +(median(jsTimes) / median(simdTimes)).toFixed(2),
        speedupSimdVsScalar: +(median(scalarTimes) / median(simdTimes)).toFixed(2),
    };
}

// 5. Direct kernel micro-benchmark: dissolve_rows (15,000 x 256 = 3,840,000 px, 15.36 MB RGBA)
function benchDissolveRowsDirect(iters = 11) {
    const srcInit = new Uint8Array(PX_N * 4);
    const mask = new Uint8Array(PX_N);
    for (let i = 0; i < PX_N; i++) {
        const j = i * 4;
        srcInit[j] = (i * 53 + 11) & 0xFF;
        srcInit[j + 1] = (i * 89 + 23) & 0xFF;
        srcInit[j + 2] = (i * 131 + 37) & 0xFF;
        srcInit[j + 3] = (i & 31) === 0 ? 0 : ((i & 63) === 1 ? 255 : ((i * 37 + 101) & 0xFF));
        mask[i] = (i & 63) === 1 ? 255 : ((i * 61 + 17) & 0xFF);
    }
    const alpha = 255;
    const seed = 0x13579BDF;
    const x0 = -17, y0 = 256;

    function runJsDissolve(buf) {
        const hash32 = B.hash32;
        const mul255 = R.mul255;
        for (let r = 0; r < H_PX; r++) {
            const imgY = y0 + r;
            const rowP = r * W_PX;
            const rowOff = rowP * 4;
            for (let col = 0; col < W_PX; col++) {
                const i = rowOff + col * 4;
                const srcA = buf[i + 3];
                if (srcA === 0) continue;
                const m = mask[rowP + col];
                const cVal = mul255(srcA, mul255(alpha, m));
                if (cVal === 0) {
                    buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 0;
                } else if (cVal === 255) {
                    buf[i + 3] = 255;
                } else if ((hash32(x0 + col, imgY, seed) >>> 24) < cVal) {
                    buf[i + 3] = 255;
                } else {
                    buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 0;
                }
            }
        }
    }

    const jsOut = new Uint8Array(srcInit);
    runJsDissolve(jsOut);
    const jsTimes = [];
    for (let i = 0; i < iters; i++) {
        const work = new Uint8Array(srcInit);
        const t0 = performance.now();
        runJsDissolve(work);
        jsTimes.push(performance.now() - t0);
    }

    function runWasm(pxInst) {
        const a = pxInst.job;
        const psrc = a.take(PX_N * 4, 16);
        const pmsk = a.take(PX_N, 16);
        pxInst.put(pmsk, mask);
        pxInst.put(psrc, srcInit);
        pxInst.exports.dissolve_rows(psrc, W_PX, H_PX, x0, y0, alpha, pmsk, seed >>> 0);
        const out = pxInst.get(Uint8Array, psrc, PX_N * 4);
        if (!sameBytes(out, jsOut)) {
            throw new Error(`dissolve_rows mismatch on ${pxInst.simd ? "simd" : "scalar"}`);
        }
        const times = [];
        for (let i = 0; i < iters; i++) {
            pxInst.put(psrc, srcInit);
            const t0 = performance.now();
            pxInst.exports.dissolve_rows(psrc, W_PX, H_PX, x0, y0, alpha, pmsk, seed >>> 0);
            times.push(performance.now() - t0);
        }
        pxInst._reset(a);
        return times;
    }

    const simdTimes = runWasm(simdPx);
    const scalarTimes = runWasm(scalarPx);
    return {
        px: PX_N,
        jsMedMs: +median(jsTimes).toFixed(3),
        simdMedMs: +median(simdTimes).toFixed(3),
        scalarMedMs: +median(scalarTimes).toFixed(3),
        speedupSimdVsJs: +(median(jsTimes) / median(simdTimes)).toFixed(2),
        speedupSimdVsScalar: +(median(scalarTimes) / median(simdTimes)).toFixed(2),
    };
}

const psdTileJs = await benchPsdRoute("psd_tile_part_15000x256", psdTileMsg, "psdPartWasm", "js");
const psdTileRust = await benchPsdRoute("psd_tile_part_15000x256", psdTileMsg, "psdPartWasm", "rust");
for (let ch = 0; ch < 4; ch++) {
    if (!sameBytes(psdTileJs.res.channels[ch].lens, psdTileRust.res.channels[ch].lens) ||
        !sameBytes(psdTileJs.res.channels[ch].data, psdTileRust.res.channels[ch].data)) {
        throw new Error(`PSD tile part mismatch on ch ${ch}`);
    }
}

const psdStackJs = await benchPsdRoute("psd_stack_part_15000x256", psdStackMsg, "psdPartWasm", "js");
const psdStackRust = await benchPsdRoute("psd_stack_part_15000x256", psdStackMsg, "psdPartWasm", "rust");
for (let ch = 0; ch < 4; ch++) {
    if (!sameBytes(psdStackJs.res.channels[ch].lens, psdStackRust.res.channels[ch].lens) ||
        !sameBytes(psdStackJs.res.channels[ch].data, psdStackRust.res.channels[ch].data)) {
        throw new Error(`PSD stack part mismatch on ch ${ch}`);
    }
}

const intoJs = await benchStackIntoRoute("stack_into_15000x256", "stackIntoWasm", "js");
const intoRust = await benchStackIntoRoute("stack_into_15000x256", "stackIntoWasm", "rust");
if (!sameBytes(intoJs.bytes, intoRust.bytes)) {
    throw new Error("stack_into 15000x256 byte mismatch between js and rust");
}

const intoClipJs = await benchStackIntoRoute("stack_into_clipCoverage_15000x256", "clipCoverage", "js");
const intoClipRust = await benchStackIntoRoute("stack_into_clipCoverage_15000x256", "clipCoverage", "rust");
if (!sameBytes(intoClipJs.bytes, intoClipRust.bytes)) {
    throw new Error("stack_into clipCoverage byte mismatch between js and rust");
}

const intoDisJs = await benchStackIntoRoute("stack_into_dissolveRows_15000x256", "dissolveRows", "js");
const intoDisRust = await benchStackIntoRoute("stack_into_dissolveRows_15000x256", "dissolveRows", "rust");
if (!sameBytes(intoDisJs.bytes, intoDisRust.bytes)) {
    throw new Error("stack_into dissolveRows byte mismatch between js and rust");
}

const clipDirect = benchClipCoverageDirect();
const dissolveDirect = benchDissolveRowsDirect();

const out = {
    runtime: process.versions.electron ? `electron ${process.versions.electron} (v8 ${process.versions.v8})` : `node ${process.version} (v8 ${process.versions.v8})`,
    psd_tile_part_15000x256: {
        before_js_gather: psdTileJs.summary,
        after_wasm_compose: psdTileRust.summary,
        speedupWall: +(psdTileJs.summary.wallMed / psdTileRust.summary.wallMed).toFixed(2),
        speedupKernel: +(psdTileJs.summary.kernelMed / psdTileRust.summary.kernelMed).toFixed(2),
    },
    psd_stack_part_15000x256: {
        before_js_gather: psdStackJs.summary,
        after_wasm_compose: psdStackRust.summary,
        speedupWall: +(psdStackJs.summary.wallMed / psdStackRust.summary.wallMed).toFixed(2),
        speedupKernel: +(psdStackJs.summary.kernelMed / psdStackRust.summary.kernelMed).toFixed(2),
    },
    stack_into_15000x256: {
        before_js_gather: intoJs.summary,
        after_wasm_compose: intoRust.summary,
        speedupWall: +(intoJs.summary.wallMed / intoRust.summary.wallMed).toFixed(2),
        speedupKernel: +(intoJs.summary.kernelMed / intoRust.summary.kernelMed).toFixed(2),
    },
    stack_into_clipCoverage_15000x256: {
        before_js_route: intoClipJs.summary,
        after_rust_route: intoClipRust.summary,
        speedupWall: +(intoClipJs.summary.wallMed / intoClipRust.summary.wallMed).toFixed(2),
        speedupKernel: +(intoClipJs.summary.kernelMed / intoClipRust.summary.kernelMed).toFixed(2),
    },
    stack_into_dissolveRows_15000x256: {
        before_js_route: intoDisJs.summary,
        after_rust_route: intoDisRust.summary,
        speedupWall: +(intoDisJs.summary.wallMed / intoDisRust.summary.wallMed).toFixed(2),
        speedupKernel: +(intoDisJs.summary.kernelMed / intoDisRust.summary.kernelMed).toFixed(2),
    },
    clip_coverage_direct_15000x256: clipDirect,
    dissolve_rows_direct_15000x256: dissolveDirect,
};

console.log(JSON.stringify(out, null, 2));
if (process.argv[2]) {
    fs.mkdirSync(path.dirname(path.resolve(process.argv[2])), { recursive: true });
    fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");
}
