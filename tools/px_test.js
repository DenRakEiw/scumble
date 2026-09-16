// The pixel kernels of the tile engine without Electron: renderer/editor/px/kernels_js.js and
// their Rust builds px.wasm / px_scalar.wasm (docs/PLAN_BCE.md §B2, §2b).
//
//     node tools/px_test.js
//
// Every JS kernel against a plain reference written here from the documented formulas (no fast
// paths, no word tricks), byte for byte on random inputs, and against the editor's current code
// (`distanceTransform`, `floodMask` in inpaint_raster.js) and first principles (brute force
// distances, repeated halving, float source-over, PNG unfiltering, zlib inflate). Then every
// Rust kernel of both builds against its JS twin, byte for byte (the EDT as f32 bits), and the
// module's memory: alloc / free, a view that goes stale when memory grows and the fresh one that
// replaces it, pointers above 2 GB, the arena's take / reset.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.dirname(__dirname);
const PX_DIR = path.join(ROOT, "renderer", "editor", "px");

let failures = 0;
function check(name, ok, detail = "") {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
    if (!ok) failures++;
}

async function memoryCases(px, label) {
    const MB = 1 << 20;
    const a = px.alloc(MB);
    check(`${label} alloc returns an 8-aligned pointer`, a > 0 && a % 8 === 0, `ptr ${a}`);
    const stale = px.u8();
    for (let i = 0; i < 4096; i++) stale[a + i] = (i * 31) & 255;
    const before = px.byteLength;
    const big = px.alloc(256 * MB);            // forces memory.grow
    check(`${label} a large alloc grows memory`, px.byteLength > before, `${before} -> ${px.byteLength}`);
    check(`${label} the old view is detached after growth`, stale.byteLength === 0 || stale.buffer !== px.memory.buffer);
    const fresh = px.u8();
    let same = true;
    for (let i = 0; i < 4096; i++) if (fresh[a + i] !== ((i * 31) & 255)) { same = false; break; }
    check(`${label} the fresh view sees the bytes written before growth`, same);
    px.free(big, 256 * MB);
    px.free(a, MB);

    // f32 round trip through put / get
    const f = new Float32Array([1.5, -2.25, 1e20, 0]);
    const p = px.alloc(f.byteLength);
    px.put(p, f);
    const back = px.get(Float32Array, p, 4);
    check(`${label} put / get of a Float32Array`, back.every((v, i) => v === f[i]));
    px.free(p, f.byteLength);

    // the arena: two jobs of the same shape allocate once
    const arena = px.arena(64 * 1024);
    const x = arena.take(100_000), y = arena.take(50_000);
    check(`${label} arena blocks do not overlap`, y >= x + 100_000 || x >= y + 50_000);
    arena.reset();
    const x2 = arena.take(100_000), y2 = arena.take(50_000);
    arena.reset();
    const chunks = arena.chunks.length;
    const x3 = arena.take(100_000), y3 = arena.take(50_000);
    check(`${label} after a reset the job fits one kept chunk`, chunks === 1 && arena.chunks.length === 1 && x3 === x2 && y3 === y2,
        `chunks ${chunks}`);
    arena.dispose();

    // pointers above 2 GB come back as negative i32 from the export
    const GB = 1024 * MB;
    const blocks = [];
    let high = 0;
    try {
        while (px.byteLength < 2.2 * GB) blocks.push(px.alloc(512 * MB));
        high = px.alloc(MB);
        const v = px.u8();
        v[high] = 77; v[high + MB - 1] = 78;
        check(`${label} a pointer above 2 GB is usable`, high > 2 * GB && v[high] === 77 && v[high + MB - 1] === 78, `ptr ${high}`);
    } catch (e) {
        check(`${label} a pointer above 2 GB is usable`, false, String(e));
    }
    if (high) px.free(high, MB);
    for (const b of blocks) px.free(b, 512 * MB);
}

// ---- inputs ------------------------------------------------------------------------------------

function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
        return s / 4294967296;
    };
}

/** RGBA with a mix of transparent, opaque and partial alpha, plus flat patches. */
function randomRGBA(w, h, seed, { opaque = false } = {}) {
    const r = rng(seed), d = new Uint8Array(w * h * 4);
    for (let i = 0; i < d.length; i += 4) {
        d[i] = r() * 256; d[i + 1] = r() * 256; d[i + 2] = r() * 256;
        const k = r();
        d[i + 3] = opaque ? 255 : k < 0.3 ? 0 : k < 0.6 ? 255 : r() * 256;
    }
    // flat rows so the opaque / transparent fast paths get whole SIMD blocks
    if (!opaque) for (let y = 0; y < h; y += 5) for (let x = 0; x < w; x++) d[(y * w + x) * 4 + 3] = y % 10 ? 255 : 0;
    if (!opaque && h === 1) for (let x = 0; x < w; x += 40) d.fill(255, x * 4 + 3, x * 4 + 4), d.fill(0, Math.min(w - 1, x + 20) * 4 + 3, Math.min(w - 1, x + 20) * 4 + 4);
    return d;
}

/** One row of pixels with real partial alpha (20 % clear, 20 % opaque, the rest anything) and flat 16 px runs of 0, 255 and 128 alpha. */
function pixelRow(n, seed, { opaque = false } = {}) {
    const r = rng(seed), d = new Uint8Array(n * 4);
    for (let i = 0; i < d.length; i += 4) {
        d[i] = r() * 256; d[i + 1] = r() * 256; d[i + 2] = r() * 256;
        const k = r();
        d[i + 3] = opaque ? 255 : k < 0.2 ? 0 : k < 0.4 ? 255 : r() * 256;
    }
    if (!opaque) for (let p = 0, k = 0; p + 16 <= n; p += 64, k++) for (let q = p; q < p + 16; q++) d[q * 4 + 3] = [0, 255, 128][k % 3];
    return d;
}

function randomMask(n, seed) {
    const r = rng(seed), m = new Uint8Array(n);
    for (let i = 0; i < n; i++) { const k = r(); m[i] = k < 0.3 ? 0 : k < 0.6 ? 255 : r() * 256; }
    for (let i = 0; i < n; i += 97) m.fill(i % 2 ? 255 : 0, i, Math.min(n, i + 32));
    return m;
}

function blobs(w, h, seed, count = 6) {
    const r = rng(seed), f = new Uint8Array(w * h);
    for (let b = 0; b < count; b++) {
        const cx = r() * w, cy = r() * h, rx = 1 + r() * w / 4, ry = 1 + r() * h / 4;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const u = (x - cx) / rx, v = (y - cy) / ry;
            if (u * u + v * v < 1 + 0.3 * Math.sin(x * 0.7 + y * 0.3)) f[y * w + x] = 1;
        }
    }
    for (let i = 0; i < w * h; i += 1 + Math.floor(r() * 400)) f[i] = 1;   // stray pixels
    return f;
}

/** Quantised colours in regions, so a flood has shapes to follow. */
function regions(w, h, seed) {
    const r = rng(seed), d = new Uint8Array(w * h * 4);
    const cells = 7, pal = Array.from({ length: 5 }, () => [r() * 256 | 0, r() * 256 | 0, r() * 256 | 0, r() < 0.2 ? 0 : 255]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const k = (Math.floor(x / cells + Math.sin(y / 5) * 2) * 7 + Math.floor(y / cells) * 3) % 5;
        const c = pal[(k + 5) % 5], i = (y * w + x) * 4;
        const n = r() * 12 | 0;
        d[i] = Math.min(255, c[0] + n); d[i + 1] = Math.min(255, c[1] + n); d[i + 2] = c[2]; d[i + 3] = c[3];
    }
    return d;
}

const eqBytes = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;

function firstDiff(a, b) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return `at ${i}: ${a[i]} vs ${b[i]}`;
    return a.length !== b.length ? `length ${a.length} vs ${b.length}` : "";
}

// ---- kernels -----------------------------------------------------------------------------------

async function mipCases(ref, label, js) {
    // the weighting itself: one opaque red over three transparent pixels stays red
    const tiny = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const t = js.mipHalf(tiny, 2, 2);
    check(`js mip keeps the colour of the one opaque sample`, t[0] === 255 && t[1] === 0 && t[2] === 0 && t[3] === 64, Array.from(t).join(","));
    let ok = true, detail = "";
    for (const [w, h, seed] of [[256, 256, 1], [37, 23, 2], [2, 2, 3], [3, 3, 4], [64, 18, 5], [512, 7, 6], [1024, 1024, 7]]) {
        for (const opaque of [false, true]) {
            const src = randomRGBA(w, h, seed * 17 + (opaque ? 1 : 0), { opaque });
            const a = js.mipHalf(src, w, h), b = ref.mipHalf(src, w, h);
            if (!eqBytes(a, b)) { ok = false; detail = `${w}x${h}${opaque ? " opaque" : ""} ${firstDiff(a, b)}`; }
        }
    }
    check(`js mipHalf equals the ${label}`, ok, detail);
    {
        // the byte path (a buffer that does not start on a word boundary) and ImageData-style input
        const src = randomRGBA(256, 256, 91), words = js.mipHalf(src, 256, 256);
        const shifted = new Uint8Array(src.length + 1); shifted.set(src, 1);
        const bytes = js.mipHalf(shifted.subarray(1), 256, 256);
        const clamped = js.mipChain(new Uint8ClampedArray(src.buffer), 256, 5), plain = js.mipChain(src, 256, 5);
        check(`js mip byte path equals the word path; Uint8ClampedArray input gives the same chain`, eqBytes(words, bytes) && eqBytes(new Uint8Array(clamped.buffer), plain));
    }
    ok = true; detail = "";
    for (const [size, levels] of [[256, 5], [512, 5], [512, 6], [64, 3]]) {
        const src = randomRGBA(size, size, size + levels);
        const a = js.mipChain(src, size, levels), b = ref.mipChain(src, size, levels);
        let chained = [], prev = src, s = size;
        for (let l = 0; l < levels; l++) { prev = js.mipHalf(prev, s, s); chained.push(prev); s >>= 1; }
        const halved = Buffer.concat(chained.map((c) => Buffer.from(c)));
        if (!eqBytes(a, b) || !eqBytes(a, new Uint8Array(halved))) { ok = false; detail = `${size}/${levels} ${firstDiff(a, b) || "chain differs from halving"}`; }
    }
    check(`js mipChain equals the ${label} and repeated halving`, ok, detail);
    ok = true; detail = "";
    if (ref.clampExtend) {
        for (const [size, vw, vh] of [[256, 256, 256], [256, 1, 1], [256, 37, 256], [256, 256, 200], [256, 100, 3], [64, 63, 1]]) {
            const src = randomRGBA(size, size, size + vw * 7 + vh);
            const a = js.clampExtend(src.slice(), size, vw, vh), b = ref.clampExtend(src.slice(), size, vw, vh);
            let edge = true;
            for (let y = 0; y < size && edge; y++) for (let x = 0; x < size; x++) {
                const sy = Math.min(y, vh - 1), sx = Math.min(x, vw - 1), i = (y * size + x) * 4, j = (sy * size + sx) * 4;
                if (a[i] !== src[j] || a[i + 1] !== src[j + 1] || a[i + 2] !== src[j + 2] || a[i + 3] !== src[j + 3]) { edge = false; break; }
            }
            if (!eqBytes(a, b) || !edge) { ok = false; detail = `${size} ${vw}x${vh} ${firstDiff(a, b) || "not the clamped edge"}`; }
        }
        check(`js clampExtend equals the ${label} and repeats the valid edge`, ok, detail);
    }
}

async function edtCases(ref, label, js, raster) {
    let ok = true, detail = "";
    const cases = [[1, 1, 0], [1, 50, 1], [50, 1, 2], [300, 200, 3], [257, 129, 4], [64, 64, -1], [64, 64, -2], [640, 480, 5]];
    for (const [w, h, seed] of cases) {
        let feature;
        if (seed === -1) feature = new Uint8Array(w * h);                 // nothing set
        else if (seed === -2) feature = new Uint8Array(w * h).fill(1);    // everything set
        else feature = blobs(w, h, seed + 11);
        const a = js.distTransform(feature, w, h), b = ref.distTransform(feature, w, h);
        if (!eqBytes(a, b)) { ok = false; detail = `${w}x${h} ${firstDiff(a, b)}`; }
    }
    check(`js distTransform equals the ${label} bit for bit`, ok, detail);
    // brute force on a small case: the exact squared distance
    const w = 41, h = 29, feature = blobs(w, h, 99, 2), d = js.distTransform(feature, w, h);
    let exact = true;
    for (let y = 0; y < h && exact; y++) for (let x = 0; x < w; x++) {
        let best = Infinity;
        for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) if (feature[v * w + u]) best = Math.min(best, (u - x) ** 2 + (v - y) ** 2);
        if (best === Infinity ? d[y * w + x] < 1e19 : d[y * w + x] !== best) { exact = false; break; }
    }
    check(`js twin is the exact squared distance (brute force 41x29)`, exact);
}

/** The whole-job kernels (grow_mask, flood_shape) against the editor's JS for the same jobs. */
async function jobCases(px, label, raster) {
    let ok = true, detail = "";
    const selection = (w, h, seed, empty = false) => {
        const f = empty ? new Uint8Array(w * h) : blobs(w, h, seed, 4), d = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) { d[i * 4] = 255; d[i * 4 + 3] = f[i] ? (seed & 1 ? 255 : 200) : (i % 7 ? 0 : 90); }
        return d;
    };
    for (const [w, h, seed, n, empty] of [[1, 1, 1, 3, false], [64, 64, 2, 5, false], [300, 200, 3, -4, false], [257, 129, 4, 16, false], [120, 90, 5, -40, false], [80, 60, 6, 2, true], [400, 300, 7, 1, false]]) {
        const src = selection(w, h, seed, empty);
        const a = src.slice();
        raster.growMask(a, w, h, n);
        const ab = raster.maskBounds(a, w, h);
        const b = src.slice(), bb = px.growMask(b, w, h, n);
        if (!eqBytes(a, b) || JSON.stringify(ab) !== JSON.stringify(bb)) { ok = false; detail = `${w}x${h} n ${n} ${firstDiff(a, b) || `bounds ${ab} vs ${bb}`}`; }
    }
    check(`${label} grow_mask equals growMask + maskBounds (grow, shrink, empty, partial alpha)`, ok, detail);

    ok = true; detail = "";
    for (const [w, h, seed] of [[1, 1, 1], [97, 61, 2], [256, 256, 3], [640, 480, 5]]) {
        const data = regions(w, h, seed), r = rng(seed + 9);
        for (let k = 0; k < 6; k++) {
            const sx = r() * w | 0, sy = r() * h | 0, tol = [0, 8, 32, 80, 255, 12][k], contiguous = k % 2 === 0;
            const sel = k % 3 ? selection(w, h, seed + k) : null;
            const mask = raster.floodMask(data, w, h, sx, sy, tol, contiguous);
            if (sel) for (let p = 0; p < w * h; p++) if (sel[p * 4 + 3] < 128) mask[p] = 0;
            const want = new Uint8Array(w * h * 4);
            let count = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
            for (let p = 0; p < w * h; p++) {
                if (!mask[p]) continue;
                want.set([18, 52, 86, 255], p * 4);
                count++;
                const x = p % w, y = (p / w) | 0;
                x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = y;
            }
            const wantBounds = x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
            const got = px.floodShape(data, w, h, sx, sy, tol, contiguous, sel, 0x123456, (view, n, bounds) => ({ bytes: new Uint8Array(view), n, bounds }));
            if (!eqBytes(got.bytes, want) || got.n !== count || JSON.stringify(got.bounds) !== JSON.stringify(wantBounds)) {
                ok = false; detail = `${w}x${h} seed ${sx},${sy} tol ${tol} ${contiguous} sel ${!!sel} ${firstDiff(got.bytes, want) || `count ${got.n} vs ${count}, bounds ${got.bounds} vs ${wantBounds}`}`;
            }
        }
    }
    check(`${label} flood_shape equals floodMask, the selection clip, the count, the bounds and the shape`, ok, detail);
}

async function floodCases(ref, label, js, raster) {
    let ok = true, detail = "";
    for (const [w, h, seed] of [[1, 1, 1], [97, 61, 2], [256, 256, 3], [300, 17, 4], [640, 480, 5]]) {
        const data = regions(w, h, seed);
        const r = rng(seed + 5);
        for (let k = 0; k < 6; k++) {
            const sx = r() * w | 0, sy = r() * h | 0, tol = [0, 8, 32, 80, 255, 12][k];
            for (const contiguous of [true, false]) {
                const a = js.flood(data, w, h, sx, sy, tol, contiguous);
                const b = ref.flood(data, w, h, sx, sy, tol, contiguous);
                if (!eqBytes(a, b) || a.count !== b.count) { ok = false; detail = `${w}x${h} seed ${sx},${sy} tol ${tol} ${contiguous} ${firstDiff(a, b) || `count ${a.count} vs ${b.count}`}`; }
                let n = 0; for (const v of a) n += v;
                if (n !== a.count) { ok = false; detail = "count does not match the mask"; }
            }
        }
    }
    check(`js flood equals the ${label}, with the count`, ok, detail);
}

async function compositeCases(ref, label, js) {
    let ok = true, detail = "";
    for (const pixels of [65536, 7, 16, 1000, 1003]) {
        for (let trial = 0; trial < 15; trial++) {
            const n = 1 + (trial % 4);
            const dst = pixelRow(pixels, 1000 + trial + pixels, { opaque: trial % 3 === 0 });
            const srcs = [], ops = [], alphas = [], masks = [];
            for (let l = 0; l < n; l++) {
                srcs.push(pixelRow(pixels, 2000 + trial * 10 + l + pixels));
                ops.push((trial + l) % 5);
                alphas.push([255, 0, 128, 200, 1][(trial + 2 * l) % 5]);
                masks.push((trial + l) % 3 === 0 ? null : randomMask(pixels, 3000 + trial * 10 + l));
            }
            const a = js.compositeTile(dst.slice(), srcs, ops, alphas, masks);
            const b = ref.compositeTile(dst.slice(), srcs, ops, alphas, masks);
            if (!eqBytes(a, b)) { ok = false; detail = `${pixels}px trial ${trial} ops ${ops} alphas ${alphas} ${firstDiff(a, b)}`; }
        }
    }
    check(`js compositeTile equals the ${label} (5 ops, partial alpha, opacity, masks, tails)`, ok, detail);

    // the same bytes from Uint8ClampedArray inputs (ImageData.data)
    const clamp = (u) => new Uint8ClampedArray(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength));
    const d0 = pixelRow(4096, 77), s0 = pixelRow(4096, 78), m0 = randomMask(4096, 79);
    const viaBytes = js.compositeTile(d0.slice(), [s0, s0], [0, 2], [200, 255], [m0, null]);
    const viaClamped = js.compositeTile(clamp(d0), [clamp(s0), s0], [0, 2], [200, 255], [m0, null]);
    check(`js composite gives the same bytes for Uint8ClampedArray inputs`, eqBytes(viaBytes, new Uint8Array(viaClamped.buffer)));

    // against float compositing (W3C straight-alpha source-over). Over an opaque destination the
    // 8-bit premultiplied maths stays within 1.5 levels; over a translucent one the storage error
    // is divided by the result's alpha, so the bound is per pixel: 2.5 · 255 / alpha + 0.6.
    let worst = 0, worstRatio = 0, alphaOff = 0, seen = 0;
    for (const o of [255, 200]) {
        const dst = pixelRow(8192, 5 + o, { opaque: true }), src = pixelRow(8192, 6 + o);
        const out = js.compositeTile(dst.slice(), [src], [0], [o], null);
        for (let p = 0; p < 8192; p++) {
            const i = p * 4, sa = src[i + 3] / 255 * o / 255;
            for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(src[i + c] * sa + dst[i + c] * (1 - sa) - out[i + c]));
        }
        const dst2 = pixelRow(8192, 7 + o), out2 = js.compositeTile(dst2.slice(), [src], [0], [o], null);
        for (let p = 0; p < 8192; p++) {
            const i = p * 4, sa = src[i + 3] / 255 * o / 255, da = dst2[i + 3] / 255, oa = sa + da * (1 - sa);
            alphaOff = Math.max(alphaOff, Math.abs(oa * 255 - out2[i + 3]));
            if (oa < 0.5 || da === 1 || da === 0) continue;
            seen++;
            const bound = 2.5 * 255 / out2[i + 3] + 0.6;
            for (let c = 0; c < 3; c++) worstRatio = Math.max(worstRatio, Math.abs((src[i + c] * sa + dst2[i + c] * da * (1 - sa)) / oa - out2[i + c]) / bound);
        }
    }
    check(`js source-over over an opaque tile within 1.5 levels of float maths`, worst <= 1.5, `worst ${worst.toFixed(2)}`);
    check(`js source-over over translucent pixels within 2.5·255/alpha + 0.6 levels, alpha within 1`, worstRatio <= 1 && alphaOff <= 1 && seen > 1000,
        `worst at ${(worstRatio * 100).toFixed(0)} % of the bound over ${seen} translucent pixels, alpha off by ${alphaOff.toFixed(2)}`);
}

async function pngCases(ref, label, js) {
    const zlib = require("node:zlib");
    let ok = true, okRound = true, detail = "";
    for (const [w, rows, seed, withPrev] of [[1, 1, 1, false], [256, 16, 2, false], [333, 9, 3, true], [4096, 4, 4, true]]) {
        const src = randomRGBA(w, rows, seed);
        for (let y = 0; y < rows; y += 3) src.copyWithin(y * w * 4, 0, w * 4);  // repeated rows favour Up
        const prev = withPrev ? randomRGBA(w, 1, seed + 50) : null;
        const a = js.pngFilterRows(src, w, rows, prev), b = ref.pngFilterRows(src, w, rows, prev);
        if (!eqBytes(a, b)) { ok = false; detail = `${w}x${rows} ${firstDiff(a, b)}`; }
        if (!eqBytes(unfilter(a, w, rows, prev), src)) okRound = false;
    }
    check(`js pngFilterRows equals the ${label}`, ok, detail);
    check(`js filtered rows unfilter back to the input`, okRound);
    const bytes = randomRGBA(512, 64, 9);
    bytes.fill(7, 0, 40000);
    const n = await js.deflate(bytes);
    check(`CompressionStream("deflate") inflates back to the input`, eqBytes(new Uint8Array(zlib.inflateSync(n)), bytes), `${bytes.length} -> ${n.length}`);
}

function unfilter(f, w, rows, prev) {
    const n = w * 4, out = new Uint8Array(rows * n);
    for (let y = 0; y < rows; y++) {
        const t = f[y * (n + 1)], src = y * (n + 1) + 1, r = y * n;
        for (let i = 0; i < n; i++) {
            const a = i >= 4 ? out[r + i - 4] : 0;
            const b = y ? out[r - n + i] : prev ? prev[i] : 0;
            const c = i >= 4 ? (y ? out[r - n + i - 4] : prev ? prev[i - 4] : 0) : 0;
            const pred = t === 0 ? 0 : t === 1 ? a : t === 2 ? b : t === 3 ? (a + b) >> 1 : paeth(a, b, c);
            out[r + i] = (f[src + i] + pred) & 255;
        }
    }
    return out;
}

function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// ---- references: the formulas written out once, per pixel, with nothing clever -----------------

const mul255 = (x, y) => { const t = x * y + 128; return (t + (t >> 8)) >> 8; };

const reference = {
    /** 2×2 box weighted by alpha: alpha (A + 2) >> 2, colour floor((Σ c·a + A/2) / A), 0 when A is 0. */
    mipHalf(src, sw, sh) {
        const ow = sw >> 1, oh = sh >> 1, out = new Uint8Array(ow * oh * 4);
        for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
            const idx = [((2 * y) * sw + 2 * x) * 4, ((2 * y) * sw + 2 * x + 1) * 4, ((2 * y + 1) * sw + 2 * x) * 4, ((2 * y + 1) * sw + 2 * x + 1) * 4];
            const A = idx.reduce((n, i) => n + src[i + 3], 0), o = (y * ow + x) * 4;
            for (let c = 0; c < 3; c++) out[o + c] = A === 0 ? 0 : Math.floor((idx.reduce((n, i) => n + src[i + c] * src[i + 3], 0) + (A >> 1)) / A);
            out[o + 3] = (A + 2) >> 2;
        }
        return out;
    },
    mipChain(src, size, levels) {
        const parts = [];
        let prev = src, s = size;
        for (let l = 0; l < levels && s >= 2; l++) { prev = reference.mipHalf(prev, s, s); parts.push(prev); s >>= 1; }
        return new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
    },
    /** premultiply once, the five operators and the coverage lerp, unpremultiply once */
    compositeTile(dst, srcs, ops, alphas, masks) {
        const px = dst.length >> 2;
        for (let p = 0; p < px; p++) { const i = p * 4; for (let c = 0; c < 3; c++) dst[i + c] = mul255(dst[i + c], dst[i + 3]); }
        srcs.forEach((s, l) => {
            for (let p = 0; p < px; p++) {
                const i = p * 4, m = masks && masks[l] ? masks[l][p] : 255;
                const sa = mul255(s[i + 3], alphas[l]), inv = 255 - sa, d = [dst[i], dst[i + 1], dst[i + 2], dst[i + 3]], da = d[3];
                const sp = [mul255(s[i], sa), mul255(s[i + 1], sa), mul255(s[i + 2], sa), sa];
                const r = [0, 1, 2, 3].map((c) => [
                    sp[c] + mul255(d[c], inv),                  // source-over
                    mul255(d[c], inv),                          // destination-out
                    mul255(sp[c], da) + mul255(d[c], inv),      // source-atop
                    mul255(d[c], sa),                           // destination-in
                    sp[c],                                      // copy
                ][ops[l]]);
                for (let c = 0; c < 4; c++) dst[i + c] = mul255(r[c], m) + mul255(d[c], 255 - m);
            }
        });
        for (let p = 0; p < px; p++) {
            const i = p * 4, a = dst[i + 3];
            for (let c = 0; c < 3; c++) dst[i + c] = a === 0 ? 0 : Math.min(255, Math.floor((dst[i + c] * 255 + (a >> 1)) / a));
        }
        return dst;
    },
    /** all five filters per row, the smallest sum of |signed byte|, ties to the lower type */
    pngFilterRows(rgba, w, rows, prev) {
        const n = w * 4, out = new Uint8Array(rows * (n + 1));
        for (let y = 0; y < rows; y++) {
            const row = rgba.subarray(y * n, y * n + n), up = y ? rgba.subarray((y - 1) * n, y * n) : prev || new Uint8Array(n);
            const cands = [0, 1, 2, 3, 4].map((t) => Uint8Array.from(row, (x, i) => {
                const a = i >= 4 ? row[i - 4] : 0, b = up[i], c = i >= 4 ? up[i - 4] : 0;
                return (x - [0, a, b, (a + b) >> 1, paeth(a, b, c)][t]) & 255;
            }));
            const sums = cands.map((cand) => cand.reduce((acc, v) => acc + (v < 128 ? v : 256 - v), 0));
            const best = sums.indexOf(Math.min(...sums));
            out[y * (n + 1)] = best;
            out.set(cands[best], y * (n + 1) + 1);
        }
        return out;
    },
};

async function main() {
    const js = await import(pathToFileURL(path.join(PX_DIR, "kernels_js.js")).href);
    const raster = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_raster.js")).href);
    const { loadPx } = await import(pathToFileURL(path.join(PX_DIR, "px.js")).href);
    const ref = {
        ...reference,
        distTransform: (f, w, h) => raster.distanceTransform(f, w, h),
        flood: (d, w, h, sx, sy, tol, contiguous) => {
            const m = raster.floodMask(d, w, h, sx, sy, tol, contiguous);
            m.count = m.reduce((n, v) => n + v, 0);
            return m;
        },
    };
    const label = "reference (distanceTransform / floodMask for the EDT and the flood)";
    await mipCases(ref, label, js);
    await edtCases(ref, label, js, raster);
    await floodCases(ref, label, js, raster);
    await compositeCases(ref, label, js);
    await pngCases(ref, label, js);
    for (const [name, file] of [["simd", "px.wasm"], ["scalar", "px_scalar.wasm"]]) {
        const px = await loadPx(fs.readFileSync(path.join(PX_DIR, file)));
        const label = `rust ${name}`;
        check(`${label} module reports its SIMD flag`, px.simd === (name === "simd"));
        await mipCases(px, label, js);
        await edtCases(px, label, js, raster);
        await floodCases(px, label, js, raster);
        await jobCases(px, label, raster);
        await compositeCases(px, label, js);
        await pngCases(px, label, js);
        await memoryCases(px, label);
    }
    console.log(failures ? `FAIL (${failures})` : "PASS");
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
