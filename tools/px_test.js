// The px kernels without Electron (docs/PLAN_BCE.md §B1, §B2).
//
//     node tools/px_test.js            # every case against px.wasm and px_scalar.wasm
//
// Kernels: every Rust kernel (both builds) against its JS twin in kernels_js.js, byte for
// byte on random inputs (the EDT as f32 bits); the twins against the editor's current code
// (`distanceTransform`, `floodMask` in inpaint_raster.js) and against first principles (brute
// force distances, repeated halving, float source-over, PNG unfiltering, zlib inflate).
// Memory: alloc / free, a view that goes stale when memory grows and the fresh one that
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

async function mipCases(px, label, js) {
    // the weighting itself: one opaque red over three transparent pixels stays red
    const tiny = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const t = js.mipHalf(tiny, 2, 2);
    check(`js mip keeps the colour of the one opaque sample`, t[0] === 255 && t[1] === 0 && t[2] === 0 && t[3] === 64, Array.from(t).join(","));
    let ok = true, detail = "";
    for (const [w, h, seed] of [[256, 256, 1], [37, 23, 2], [2, 2, 3], [3, 3, 4], [64, 18, 5], [512, 7, 6], [1024, 1024, 7]]) {
        for (const opaque of [false, true]) {
            const src = randomRGBA(w, h, seed * 17 + (opaque ? 1 : 0), { opaque });
            const a = js.mipHalf(src, w, h), b = px.mipHalf(src, w, h);
            if (!eqBytes(a, b)) { ok = false; detail = `${w}x${h}${opaque ? " opaque" : ""} ${firstDiff(a, b)}`; }
        }
    }
    check(`${label} mip_half equals the JS twin`, ok, detail);
    ok = true; detail = "";
    for (const [size, levels] of [[256, 5], [512, 5], [512, 6], [64, 3]]) {
        const src = randomRGBA(size, size, size + levels);
        const a = js.mipChain(src, size, levels), b = px.mipChain(src, size, levels);
        let chained = [], prev = src, s = size;
        for (let l = 0; l < levels; l++) { prev = js.mipHalf(prev, s, s); chained.push(prev); s >>= 1; }
        const ref = Buffer.concat(chained.map((c) => Buffer.from(c)));
        if (!eqBytes(a, b) || !eqBytes(a, new Uint8Array(ref))) { ok = false; detail = `${size}/${levels} ${firstDiff(a, b) || "chain differs from halving"}`; }
    }
    check(`${label} mip_chain equals the JS twin and repeated halving`, ok, detail);
}

async function edtCases(px, label, js, raster) {
    let ok = true, okRef = true, detail = "", worst = 0;
    const cases = [[1, 1, 0], [1, 50, 1], [50, 1, 2], [300, 200, 3], [257, 129, 4], [64, 64, -1], [64, 64, -2], [640, 480, 5]];
    for (const [w, h, seed] of cases) {
        let feature;
        if (seed === -1) feature = new Uint8Array(w * h);                 // nothing set
        else if (seed === -2) feature = new Uint8Array(w * h).fill(1);    // everything set
        else feature = blobs(w, h, seed + 11);
        const a = js.distTransform(feature, w, h), b = px.distTransform(feature, w, h);
        if (!eqBytes(a, b)) { ok = false; detail = `${w}x${h} ${firstDiff(a, b)}`; }
        const ref = raster.distanceTransform(feature, w, h);
        for (let i = 0; i < ref.length; i++) {
            const e = Math.abs(ref[i] - a[i]) / Math.max(1, Math.abs(ref[i]));
            if (e > worst) worst = e;
            if (e > 1e-3) okRef = false;
        }
    }
    check(`${label} dist_transform equals the JS twin bit for bit`, ok, detail);
    check(`js twin within 1e-3 of distanceTransform (inpaint_raster.js)`, okRef, `worst relative ${worst}`);
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

async function floodCases(px, label, js, raster) {
    let ok = true, okRef = true, detail = "";
    for (const [w, h, seed] of [[1, 1, 1], [97, 61, 2], [256, 256, 3], [300, 17, 4], [640, 480, 5]]) {
        const data = regions(w, h, seed);
        const r = rng(seed + 5);
        for (let k = 0; k < 6; k++) {
            const sx = r() * w | 0, sy = r() * h | 0, tol = [0, 8, 32, 80, 255, 12][k];
            for (const contiguous of [true, false]) {
                const a = js.flood(data, w, h, sx, sy, tol, contiguous);
                const b = px.flood(data, w, h, sx, sy, tol, contiguous);
                const ref = raster.floodMask(data, w, h, sx, sy, tol, contiguous);
                if (!eqBytes(a, b) || a.count !== b.count) { ok = false; detail = `${w}x${h} seed ${sx},${sy} tol ${tol} ${contiguous} ${firstDiff(a, b) || `count ${a.count} vs ${b.count}`}`; }
                if (!eqBytes(a, ref)) okRef = false;
                let n = 0; for (const v of a) n += v;
                if (n !== a.count) { ok = false; detail = "count does not match the mask"; }
            }
        }
    }
    check(`${label} flood equals the JS twin`, ok, detail);
    check(`js twin equals floodMask (inpaint_raster.js)`, okRef);
    // a stack too small for the fill: the kernel says so, the wrapper retries
    const w = 512, h = 512, data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[(y * w + x) * 4 + 3] = (x % 2 || y % 64 === 0) ? 255 : 0;  // a comb: many spans
    const u8 = px.u8(), pr = px.alloc(w * h * 4), po = px.alloc(w * h), ps = px.alloc(16);
    px.u8().set(data, pr);
    const r = px.exports.flood(pr, w, h, 0, 0, 0, 1, po, ps, 2);
    check(`${label} flood reports a too-small stack with -1`, r === -1 && u8 !== undefined, `returned ${r}`);
    px.free(pr, w * h * 4); px.free(po, w * h); px.free(ps, 16);
    const full = px.flood(data, w, h, 0, 0, 0, true), ref = js.flood(data, w, h, 0, 0, 0, true);
    check(`${label} flood wrapper retries and matches`, eqBytes(full, ref) && full.count === ref.count, `count ${full.count}`);
}

async function compositeCases(px, label, js) {
    let ok = true, detail = "";
    const r = rng(123);
    for (const pixels of [65536, 7, 16, 1000]) {
        for (let trial = 0; trial < 12; trial++) {
            const n = 1 + (trial % 4);
            const dst = randomRGBA(pixels, 1, 1000 + trial + pixels, { opaque: trial % 3 === 0 });
            const srcs = [], ops = [], alphas = [], masks = [];
            for (let l = 0; l < n; l++) {
                srcs.push(randomRGBA(pixels, 1, 2000 + trial * 10 + l + pixels));
                ops.push((trial + l) % 5);
                alphas.push([255, 0, 128, 200, 1][(trial + 2 * l) % 5]);
                masks.push((trial + l) % 3 === 0 ? null : randomMask(pixels, 3000 + trial * 10 + l));
            }
            const a = js.compositeTile(dst.slice(), srcs, ops, alphas, masks);
            const b = px.compositeTile(dst.slice(), srcs, ops, alphas, masks);
            if (!eqBytes(a, b)) { ok = false; detail = `${pixels}px trial ${trial} ops ${ops} alphas ${alphas} ${firstDiff(a, b)}`; }
        }
    }
    check(`${label} composite_tile equals the JS twin (5 ops, opacity, masks)`, ok, detail);
    // against float compositing: source-over of an opaque-ish stack within 2 levels
    const pixels = 4096, dst = randomRGBA(pixels, 1, 5, { opaque: true }), src = randomRGBA(pixels, 1, 6);
    const out = js.compositeTile(dst.slice(), [src], [0], [200], null);
    let worst = 0;
    for (let p = 0; p < pixels; p++) {
        const i = p * 4, sa = src[i + 3] / 255 * 200 / 255;
        for (let c = 0; c < 3; c++) {
            const f = src[i + c] * sa + dst[i + c] * (1 - sa);
            worst = Math.max(worst, Math.abs(f - out[i + c]));
        }
    }
    check(`js source-over over an opaque tile within 1.5 levels of float maths`, worst <= 1.5, `worst ${worst.toFixed(2)}`);
    // and over a translucent tile (W3C straight-alpha source-over), where the result is at
    // least half opaque: 8-bit premultiplied storage costs precision at low alpha, as in Canvas 2D
    const dst2 = randomRGBA(pixels, 1, 7), out2 = js.compositeTile(dst2.slice(), [src], [0], [200], null);
    worst = 0;
    for (let p = 0; p < pixels; p++) {
        const i = p * 4, sa = src[i + 3] / 255 * 200 / 255, da = dst2[i + 3] / 255, oa = sa + da * (1 - sa);
        if (Math.abs(oa * 255 - out2[i + 3]) > 1) worst = Math.max(worst, 99);
        if (oa < 0.5) continue;
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs((src[i + c] * sa + dst2[i + c] * da * (1 - sa)) / oa - out2[i + c]));
    }
    check(`js source-over over a translucent tile within 1.5 levels of float maths (alpha within 1)`, worst <= 1.5, `worst ${worst.toFixed(2)}`);
}

async function pngCases(px, label, js) {
    const zlib = require("node:zlib");
    let ok = true, okRound = true, detail = "";
    for (const [w, rows, seed, withPrev] of [[1, 1, 1, false], [256, 16, 2, false], [333, 9, 3, true], [4096, 4, 4, true]]) {
        const src = randomRGBA(w, rows, seed);
        for (let y = 0; y < rows; y += 3) src.copyWithin(y * w * 4, 0, w * 4);  // repeated rows favour Up
        const prev = withPrev ? randomRGBA(w, 1, seed + 50) : null;
        const a = js.pngFilterRows(src, w, rows, prev), b = px.pngFilterRows(src, w, rows, prev);
        if (!eqBytes(a, b)) { ok = false; detail = `${w}x${rows} ${firstDiff(a, b)}`; }
        if (!eqBytes(unfilter(a, w, rows, prev), src)) okRound = false;
    }
    check(`${label} png_filter_rows equals the JS twin`, ok, detail);
    check(`${label} filtered rows unfilter back to the input`, okRound);
    const bytes = randomRGBA(512, 64, 9);
    bytes.fill(7, 0, 40000);
    const z = px.deflate(bytes, 6);
    check(`${label} deflate_zlib inflates back to the input`, eqBytes(new Uint8Array(zlib.inflateSync(z)), bytes), `${bytes.length} -> ${z.length}`);
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

async function main() {
    const { loadPx } = await import(pathToFileURL(path.join(PX_DIR, "px.js")).href);
    const js = await import(pathToFileURL(path.join(PX_DIR, "kernels_js.js")).href);
    const raster = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_raster.js")).href);
    const variants = [["simd", "px.wasm"], ["scalar", "px_scalar.wasm"]];
    for (const [label, file] of variants) {
        const px = await loadPx(fs.readFileSync(path.join(PX_DIR, file)));
        check(`${label} module reports its SIMD flag`, px.simd === (label === "simd"));
        await mipCases(px, label, js);
        await edtCases(px, label, js, raster);
        await floodCases(px, label, js, raster);
        await compositeCases(px, label, js);
        await pngCases(px, label, js);
        await memoryCases(px, label);
    }
    console.log(failures ? `FAIL (${failures})` : "PASS");
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
