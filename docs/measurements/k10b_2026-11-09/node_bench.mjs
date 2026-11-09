/**
 * Node / Electron-as-Node explaining micro-benchmark for K10b (`docs/PLAN_WASM_K10.md` §3, §5.2):
 *   1. Tile-store PNG part (15,000 x 256, 59 tiles + prevTiles): `tilesRowsToWasm + pngPartFromPtr` vs `rowsOfTiles + pngPart`.
 *   2. Stack PNG part (15,000 x 256, base + 2 layers with mask, clip, match + above row): `stackRowsToWasm + pngPartFromPtr` vs `rowsOfStack + pngPart`.
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

await K.kernelsReady();

const W_PX = 15000, H_PX = 256, TILE = 256;
const ntx = Math.ceil(W_PX / TILE);

function makeTileRow(seed) {
    const row = new Array(ntx);
    // Reuse 4 distinct tile buffers across the row to keep bench setup fast while exercising full 15k gather/composite/filter/deflate
    const pool = [0, 1, 2, 3].map((k) => {
        const b = new Uint8Array(TILE * TILE * 4);
        let s = (seed + k * 0x9E3779B9) >>> 0;
        for (let i = 0; i < b.length; i += 4) {
            s = (Math.imul(s ^ (s >>> 15), 0x85EBCA6B) + 0xC2B2AE35) >>> 0;
            b[i] = s & 0xFF;
            b[i + 1] = (s >>> 8) & 0xFF;
            b[i + 2] = (s >>> 16) & 0xFF;
            b[i + 3] = 180 + ((s >>> 24) & 0x3F);
        }
        return { data: b.buffer };
    });
    for (let tx = 0; tx < ntx; tx++) row[tx] = pool[tx & 3];
    return row;
}

const tiles0 = makeTileRow(101);
const tiles1 = makeTileRow(202);
const layer1Tiles = { 0: makeTileRow(303), 1: makeTileRow(404) };
const mask1Tiles = { 0: makeTileRow(505), 1: makeTileRow(606) };
const layer2Tiles = { 0: makeTileRow(707), 1: makeTileRow(808) };

const tileMsg = {
    w: W_PX,
    rows: H_PX,
    r0: 0,
    tiles: tiles1,
    prevTiles: tiles0,
    level: 2,
    last: false,
};

const stackMsg = {
    w: W_PX,
    rows: H_PX,
    x0: 0,
    y0: 0,
    y: H_PX,
    level: 2,
    last: false,
    stack: {
        base: { x: 0, y: 0, w: W_PX, h: H_PX * 2, tiles: { 0: tiles0, 1: tiles1 } },
        layers: [
            {
                x: 0, y: 0, w: W_PX, h: H_PX * 2,
                tiles: layer1Tiles,
                mask: mask1Tiles,
                alpha: 210,
                op: 0,
            },
            {
                x: 0, y: 0, w: W_PX, h: H_PX * 2,
                tiles: layer2Tiles,
                alpha: 190,
                op: 3, // multiply
                match: [0.42, 0.02, -0.01, 0.45, 0.01, 0.02, 1.04, 0.96, 1.02, 0.6],
            },
        ],
    },
};

function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

async function benchRoute(label, msg, routeName, routeVal, iters = 7) {
    K.setRoute(routeName, routeVal);
    P.pxTimed(true);
    // Warmup
    const warm = await W.pngPart(msg);
    const walls = [], kernels = [], copyInMBs = [], copyOutMBs = [];
    for (let i = 0; i < iters; i++) {
        P.pxCalls(true);
        const t0 = performance.now();
        const r = await W.pngPart(msg);
        const dt = performance.now() - t0;
        const laps = P.pxLaps();
        walls.push(dt);
        kernels.push(r.timing.kernel);
        copyInMBs.push(laps.copyInMB);
        copyOutMBs.push(laps.copyOutMB);
    }
    K.setRoute(routeName, null);
    return {
        label,
        route: routeVal || "rust",
        composeWasm: warm.timing.composeWasm,
        crc: warm.crc,
        adler: warm.adler,
        wallMed: +median(walls).toFixed(2),
        wallMin: +Math.min(...walls).toFixed(2),
        wallMax: +Math.max(...walls).toFixed(2),
        kernelMed: +median(kernels).toFixed(2),
        copyInMB: +median(copyInMBs).toFixed(2),
        copyOutMB: +median(copyOutMBs).toFixed(2),
    };
}

const tileJs = await benchRoute("tile_part_15000x256", tileMsg, "composeTiles", "js");
const tileRust = await benchRoute("tile_part_15000x256", tileMsg, "composeTiles", "rust");
const stackJs = await benchRoute("stack_part_15000x256", stackMsg, "composeStack", "js");
const stackRust = await benchRoute("stack_part_15000x256", stackMsg, "composeStack", "rust");

if (tileJs.crc !== tileRust.crc || tileJs.adler !== tileRust.adler) {
    throw new Error(`Tile part CRC/Adler mismatch: ${JSON.stringify({ tileJs, tileRust })}`);
}
if (stackJs.crc !== stackRust.crc || stackJs.adler !== stackRust.adler) {
    throw new Error(`Stack part CRC/Adler mismatch: ${JSON.stringify({ stackJs, stackRust })}`);
}

const out = {
    runtime: process.versions.electron ? `electron ${process.versions.electron} (v8 ${process.versions.v8})` : `node ${process.version} (v8 ${process.versions.v8})`,
    tile_part_15000x256: {
        before_js_gather: tileJs,
        after_wasm_compose: tileRust,
        speedupWall: +(tileJs.wallMed / tileRust.wallMed).toFixed(2),
        speedupKernel: +(tileJs.kernelMed / tileRust.kernelMed).toFixed(2),
    },
    stack_part_15000x256: {
        before_js_gather: stackJs,
        after_wasm_compose: stackRust,
        speedupWall: +(stackJs.wallMed / stackRust.wallMed).toFixed(2),
        speedupKernel: +(stackJs.kernelMed / stackRust.kernelMed).toFixed(2),
    },
};

console.log(JSON.stringify(out, null, 2));
if (process.argv[2]) {
    fs.mkdirSync(path.dirname(path.resolve(process.argv[2])), { recursive: true });
    fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");
}
