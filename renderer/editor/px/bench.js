/**
 * The phase B benchmark (docs/PLAN_BCE.md §B3), shared by `tools/px_bench.js` (Node, and
 * Electron's own V8 through ELECTRON_RUN_AS_NODE) and `tools/px_bench.html` (Firefox).
 *
 * Every kernel row times the JS twin (kernels_js.js), the scalar and the SIMD128 build of
 * crates/px with their data **already in wasm memory** (the kernel alone), and separately
 * the copy of the inputs into wasm memory and of the result out of it. The speed-up the 3×
 * rule reads is JS ÷ (SIMD + copy). Each figure is the median of `runs` runs after
 * `warmups` warm-ups; a run repeats a fast operation until it lasts `minMs`, so a 1 ms
 * timer (Firefox without isolation) still resolves a 50 µs kernel.
 *
 * Inputs are synthetic and seeded, identical in every environment. The rule's two rows are
 * fixed before any number is seen: the mip chain of one **opaque** 256 tile (a photo base,
 * 2,352 of them in a 15k document) and the EDT of a 4,096² band.
 */

import { OPS } from "./kernels_js.js";

const MP = {
    "96": [12000, 8000],
    "150": [15000, 10000],
};

// ---- timing ------------------------------------------------------------------------------------

const clock = () => performance.now();
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

/** Median ms per call of `fn` (sync or async). */
async function measure(fn, { runs, warmups, minMs }) {
    const once = async (reps) => {
        const t0 = clock();
        for (let i = 0; i < reps; i++) { const r = fn(); if (r && r.then) await r; }
        return clock() - t0;
    };
    let reps = 1, t = await once(1);
    while (t < minMs && reps < 1 << 20) {
        reps = Math.min(1 << 20, Math.max(reps * 2, Math.ceil(reps * (minMs * 1.2) / Math.max(t, 0.01))));
        t = await once(reps);
    }
    for (let i = 0; i < warmups; i++) await once(reps);
    const samples = [];
    for (let i = 0; i < runs; i++) samples.push((await once(reps)) / reps);
    return median(samples);
}

// ---- inputs ------------------------------------------------------------------------------------

function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** A photo-like opaque RGBA image: smooth gradients, a few edges, sensor noise. */
export function photo(w, h, seed = 1, x0 = 0, y0 = 0) {
    const r = rng(seed), d = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        const Y = y + y0;
        for (let x = 0; x < w; x++) {
            const X = x + x0, i = (y * w + x) * 4, n = (r() * 9) | 0;
            const edge = ((X >> 7) + (Y >> 8)) & 1 ? 40 : 0;
            d[i] = (X * 7 / 97 + edge + n) & 255;
            d[i + 1] = (Y * 5 / 89 + n) & 255;
            d[i + 2] = ((X + Y) / 61 + edge + n) & 255;
            d[i + 3] = 255;
        }
    }
    return d;
}

/** A paint layer: transparent with soft round strokes (alpha ramps) over part of it. */
export function paint(w, h, seed = 2, cover = 0.35) {
    const r = rng(seed), d = new Uint8Array(w * h * 4);
    const dabs = Math.max(1, Math.round(cover * w * h / (Math.PI * 60 * 60) * 1.4));
    for (let k = 0; k < dabs; k++) {
        const cx = r() * w, cy = r() * h, rad = 20 + r() * 80, cr = r() * 256, cg = r() * 256, cb = r() * 256;
        const x0 = Math.max(0, cx - rad | 0), x1 = Math.min(w, cx + rad + 1 | 0), y0 = Math.max(0, cy - rad | 0), y1 = Math.min(h, cy + rad + 1 | 0);
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const t = Math.hypot(x - cx, y - cy) / rad;
            if (t >= 1) continue;
            const a = Math.round(255 * Math.min(1, (1 - t) * 2.5)), i = (y * w + x) * 4;
            if (a > d[i + 3]) { d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; d[i + 3] = a; }
        }
    }
    return d;
}

/** A feathered selection mask (one byte per pixel). */
function feathered(w, h, seed = 3) {
    const r = rng(seed), m = new Uint8Array(w * h);
    const cx = w * (0.3 + r() * 0.4), cy = h * (0.3 + r() * 0.4), rad = Math.min(w, h) * 0.45;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const t = (Math.hypot(x - cx, y - cy) - rad) / 24;
        m[y * w + x] = t <= -1 ? 255 : t >= 1 ? 0 : Math.round(127.5 * (1 - t));
    }
    return m;
}

/**
 * A selection as a feature byte map: large ragged ellipses over about a third of the area,
 * computed per row span so 150 MP builds in a second.
 */
export function selection(w, h, seed = 4, count = 9) {
    const r = rng(seed), f = new Uint8Array(w * h);
    const shapes = Array.from({ length: count }, () => ({ cx: r() * w, cy: r() * h, rx: w * (0.06 + r() * 0.16), ry: h * (0.06 + r() * 0.16), ph: r() * 6 }));
    for (const s of shapes) {
        const y0 = Math.max(0, Math.floor(s.cy - s.ry * 1.2)), y1 = Math.min(h, Math.ceil(s.cy + s.ry * 1.2));
        for (let y = y0; y < y1; y++) {
            const v = (y - s.cy) / s.ry, k = 1 + 0.12 * Math.sin(y / 23 + s.ph) - v * v;
            if (k <= 0) continue;
            const half = s.rx * Math.sqrt(k), xa = Math.max(0, Math.floor(s.cx - half)), xb = Math.min(w, Math.ceil(s.cx + half));
            if (xb > xa) f.fill(1, y * w + xa, y * w + xb);
        }
    }
    for (let i = 0; i < f.length; i += 1 + ((r() * 5000) | 0)) f[i] ^= 1;   // specks and holes
    return f;
}

/** A 4,096² scene for the wand: a sky within tolerance, broken by poles and wires. */
function floodScene(w, h, seed = 5) {
    const d = photo(w, h, seed);
    const r = rng(seed + 1);
    for (let y = 0; y < h * 0.7; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, n = (r() * 10) | 0;
        d[i] = 110 + n + (y >> 9); d[i + 1] = 160 + n; d[i + 2] = 220 + (n >> 1); d[i + 3] = 255;
    }
    // poles from the ground up into the sky, and short wire segments: obstacles the scanline
    // fill has to split its spans around, while the sky stays one connected region
    for (let p = 0; p < 40; p++) {
        const px = (r() * w) | 0, pw = 3 + ((r() * 20) | 0), top = (h * (0.25 + r() * 0.4)) | 0;
        for (let y = top; y < h; y++) for (let x = px; x < Math.min(w, px + pw); x++) d[(y * w + x) * 4] = 20;
    }
    for (let k = 0; k < 60; k++) {
        const y0 = (r() * h * 0.65) | 0, x0 = (r() * w) | 0, len = (w * (0.05 + r() * 0.2)) | 0, slope = (r() - 0.5) * 0.3;
        for (let x = x0; x < Math.min(w, x0 + len); x++) { const y = (y0 + (x - x0) * slope) | 0; if (y >= 0 && y < h) d[(y * w + x) * 4 + 1] = 0; }
    }
    return d;
}

// ---- rows --------------------------------------------------------------------------------------

/**
 * Run the benchmark. `impls`: { js, scalar, simd } where js is the kernels_js module and
 * scalar / simd are loaded Px instances. `extras`: { distanceTransform, floodMask } from
 * inpaint_raster.js, timed once for the notes. Returns { rows, notes, env }.
 */
export async function runBench({ impls, extras = {}, sizes = ["96", "150"], runs = 5, warmups = 2, minMs = 25, only = null, log = () => {} }) {
    const { js, scalar, simd } = impls;
    const opts = { runs, warmups, minMs };
    const bigOpts = { runs, warmups, minMs: 0 };
    const rows = [], notes = [];
    const want = (k) => !only || only.includes(k);
    const rust = [["scalar", scalar], ["simd", simd]];

    const row = (r) => { rows.push(r); log(fmtRow(r)); };

    /**
     * Time a kernel three ways. `place(px)` puts the inputs into px memory and returns
     * { call, copy, release }: `call()` runs the export on data already there, `copy()` does
     * what a caller with JS-side data pays around it (inputs in, result out).
     */
    async function kernelRow(kernel, input, jsFn, place, opt = opts, extra = {}) {
        const r = { kernel, input, ...extra };
        r.js = await measure(jsFn, opt);
        for (const [label, px] of rust) {
            const p = place(px);
            r[label] = await measure(p.call, opt);
            if (label === "simd") r.copy = await measure(p.copy, opt);
            p.release();
        }
        r.speedup = r.js / (r.simd + r.copy);
        r.speedupNoCopy = r.js / r.simd;
        row(r);
        return r;
    }

    // one opaque 256 tile, and one with alpha
    const TILE = 256, LEVELS = 5;
    const chainBytes = js.mipChainBytes(TILE, LEVELS);
    const placeChain = (src, size = TILE, levels = LEVELS) => (px) => {
        const n = size * size * 4, nOut = px.exports.mip_chain_bytes(size, levels);
        const ps = px.alloc(n), po = px.alloc(nOut), back = new Uint8Array(nOut);
        px.u8().set(src, ps);
        return {
            call: () => px.exports.mip_chain(ps, size, levels, po),
            copy: () => { px.u8().set(src, ps); back.set(px.view(Uint8Array, po, nOut)); },
            release: () => { px.free(ps, n); px.free(po, nOut); },
        };
    };

    if (want("mip")) {
        const opaqueTile = photo(TILE, TILE, 11), alphaTile = paint(TILE, TILE, 12, 0.5), out = new Uint8Array(chainBytes);
        const rule = await kernelRow("mip chain", "one 256² tile, opaque (photo base)", () => js.mipChain(opaqueTile, TILE, LEVELS, out), placeChain(opaqueTile), opts, { rule: true });
        await kernelRow("mip chain", "one 256² tile, paint layer (soft alpha)", () => js.mipChain(alphaTile, TILE, LEVELS, out), placeChain(alphaTile));

        for (const s of sizes) {
            const [W, H] = MP[s];
            const tiles = Math.ceil(H / TILE);
            const column = Array.from({ length: tiles }, (_, k) => photo(TILE, TILE, 100 + k, 0, k * TILE));
            await kernelRow("mip chain", `a tile column at ${s} MP (${tiles} tiles)`,
                () => { for (const t of column) js.mipChain(t, TILE, LEVELS, out); },
                (px) => {
                    const places = column.map((t) => placeChain(t)(px));
                    return { call: () => { for (const p of places) p.call(); }, copy: () => { for (const p of places) p.copy(); }, release: () => { for (const p of places) p.release(); } };
                });
        }
        for (const s of sizes) {
            const [W, H] = MP[s];
            log(`building a ${s} MP layer...`);
            let src = photo(W, H, 13);
            let dst = new Uint8Array((W >> 1) * (H >> 1) * 4);
            await kernelRow("mip halving", `whole layer at ${s} MP (${W} × ${H} → level 1)`, () => js.mipHalf(src, W, H, dst), (px) => {
                const n = W * H * 4, nOut = (W >> 1) * (H >> 1) * 4, ps = px.alloc(n), po = px.alloc(nOut);
                px.u8().set(src, ps);
                return {
                    call: () => px.exports.mip_half(ps, W, H, po),
                    copy: () => { px.u8().set(src, ps); dst.set(px.view(Uint8Array, po, nOut)); },
                    release: () => { px.free(ps, n); px.free(po, nOut); },
                };
            }, bigOpts);
            src = dst = null;
        }
    }

    const placeEdt = (feature, w, h) => (px) => {
        const n = w * h, pf = px.alloc(n), po = px.alloc(n * 4), sb = px.exports.dist_scratch_bytes(w, h), pt = px.alloc(sb), back = new Float32Array(n);
        px.u8().set(feature, pf);
        return {
            call: () => px.exports.dist_transform(pf, w, h, po, pt),
            copy: () => { px.u8().set(feature, pf); back.set(px.view(Float32Array, po, n)); },
            release: () => { px.free(pf, n); px.free(po, n * 4); px.free(pt, sb); },
        };
    };

    if (want("edt")) {
        const B = 4096, feature = selection(B, B, 21, 5), out = new Float32Array(B * B), scratch = js.distScratch(B, B);
        await kernelRow("distance transform", "4,096² band (grow / shrink / feather)", () => js.distTransform(feature, B, B, out, scratch), placeEdt(feature, B, B), { runs, warmups, minMs: 0 }, { rule: true });
        if (extras.distanceTransform) {
            const t = await measure(() => extras.distanceTransform(feature, B, B), { runs, warmups, minMs: 0 });
            notes.push({ key: "edt-original", ms: t, text: `distanceTransform (inpaint_raster.js, today's grow / shrink) on the 4,096² band` });
            log(`  note: today's distanceTransform on the band ${t.toFixed(1)} ms`);
        }
        for (const s of sizes) {
            const [W, H] = MP[s];
            log(`building a ${s} MP selection...`);
            let f = selection(W, H, 22), o = new Float32Array(W * H);
            const sc = js.distScratch(W, H);
            await kernelRow("distance transform", `whole selection at ${s} MP (${W} × ${H})`, () => js.distTransform(f, W, H, o, sc), placeEdt(f, W, H), bigOpts);
            f = o = null;
        }
    }

    if (want("flood")) {
        const F = 4096, scene = floodScene(F, F), out = new Uint8Array(F * F);
        const sx = 1000, sy = 200;
        const probe = js.flood(scene, F, F, sx, sy, 32, true, out);
        const filled = probe.count;
        await kernelRow("flood fill", `4,096² region, contiguous, tolerance 32 (${(filled / 1e6).toFixed(1)} MP filled)`, () => js.flood(scene, F, F, sx, sy, 32, true, out), (px) => {
            const n = F * F, pr = px.alloc(n * 4), po = px.alloc(n), pairs = n >> 3, ps = px.alloc(pairs * 8), back = new Uint8Array(n);
            px.u8().set(scene, pr);
            return {
                call: () => { if (px.exports.flood(pr, F, F, sx, sy, 32, 1, po, ps, pairs) < 0) throw new Error("stack"); },
                copy: () => { px.u8().set(scene, pr); back.set(px.view(Uint8Array, po, n)); },
                release: () => { px.free(pr, n * 4); px.free(po, n); px.free(ps, pairs * 8); },
            };
        }, { runs, warmups, minMs: 0 });
        if (extras.floodMask) {
            const t = await measure(() => extras.floodMask(scene, F, F, sx, sy, 32, true), { runs, warmups, minMs: 0 });
            notes.push({ key: "flood-original", ms: t, text: `floodMask (inpaint_raster.js, today's wand) on the same region` });
            log(`  note: today's floodMask ${t.toFixed(1)} ms`);
        }
    }

    // a 4-layer stack over one tile
    const placeComposite = (base, srcs, ops, alphas, masks, size = TILE) => (px) => {
        const pxs = size * size, n = srcs.length;
        const pd = px.alloc(pxs * 4), ptab = px.alloc(8 * n + 2 * n);
        const ps = srcs.map((s) => { const p = px.alloc(pxs * 4); px.u8().set(s, p); return p; });
        const pm = masks.map((m) => { if (!m) return 0; const p = px.alloc(pxs); px.u8().set(m, p); return p; });
        const u32 = px.u32(), u8 = px.u8();
        for (let i = 0; i < n; i++) { u32[(ptab >>> 2) + i] = ps[i]; u32[(ptab >>> 2) + n + i] = pm[i]; u8[ptab + 8 * n + i] = ops[i]; u8[ptab + 9 * n + i] = alphas[i]; }
        const back = new Uint8Array(pxs * 4);
        return {
            call: () => { px.u8().set(base, pd); px.exports.composite_tile(pd, pxs, n, ptab, ptab + 8 * n, ptab + 9 * n, ptab + 4 * n); },
            // the stack's sources and masks in, the tile out (the base refill is inside `call`
            // for both builds, the kernel writes in place)
            copy: () => { const v = px.u8(); for (let i = 0; i < n; i++) { v.set(srcs[i], ps[i]); if (masks[i]) v.set(masks[i], pm[i]); } back.set(px.view(Uint8Array, pd, pxs * 4)); },
            release: () => { px.free(pd, pxs * 4); px.free(ptab, 8 * n + 2 * n); ps.forEach((p) => px.free(p, pxs * 4)); pm.forEach((p) => p && px.free(p, pxs)); },
        };
    };

    if (want("composite")) {
        const base = photo(TILE, TILE, 31), l1 = paint(TILE, TILE, 32, 0.6), l2 = paint(TILE, TILE, 33, 0.8), l3 = paint(TILE, TILE, 34, 0.2), l4 = photo(TILE, TILE, 35);
        const srcs = [l1, l2, l3, l4], ops = [OPS["source-over"], OPS["source-over"], OPS["destination-out"], OPS["source-atop"]], alphas = [255, 180, 255, 128];
        const masks = [null, feathered(TILE, TILE, 36), null, null];
        const work = new Uint8Array(TILE * TILE * 4);
        await kernelRow("composite", "4-layer stack over one 256² tile (over, over+mask, erase, atop)", () => { work.set(base); js.compositeTile(work, srcs, ops, alphas, masks); }, placeComposite(base, srcs, ops, alphas, masks));
    }

    if (want("png")) {
        const PW = 4096, PR = 256, band = photo(PW, PR, 41), prev = photo(PW, 1, 42), out = new Uint8Array(PR * (1 + 4 * PW));
        await kernelRow("PNG rows (filter)", "4,096 × 256 band", () => js.pngFilterRows(band, PW, PR, prev, out), (px) => {
            const n = PW * PR * 4, nOut = PR * (1 + 4 * PW), pb = px.alloc(n), pp = px.alloc(PW * 4), po = px.alloc(nOut);
            px.u8().set(band, pb); px.u8().set(prev, pp);
            return {
                call: () => px.exports.png_filter_rows(pb, PW, PR, pp, po),
                copy: () => { px.u8().set(band, pb); out.set(px.view(Uint8Array, po, nOut)); },
                release: () => { px.free(pb, n); px.free(pp, PW * 4); px.free(po, nOut); },
            };
        }, opts, { info: true });
    }

    if (want("tiles")) {
        // 256 against 512: the mip chain per tile and a 400 px dab's composite cost
        const t512 = photo(512, 512, 51), out512 = new Uint8Array(js.mipChainBytes(512, 5));
        await kernelRow("tile size", "mip chain of one 512² tile (5 levels, to 16²)", () => js.mipChain(t512, 512, 5, out512), placeChain(t512, 512, 5), opts, { tiles: 512 });
        const dab = 400, trials = 20000, rr = rng(52);
        const tilesPerDab = (T) => { let sum = 0, lo = Infinity, hi = 0; for (let i = 0; i < trials; i++) { const x = rr() * 8192, y = rr() * 8192; const n = (Math.floor((x + dab) / T) - Math.floor(x / T) + 1) * (Math.floor((y + dab) / T) - Math.floor(y / T) + 1); sum += n; lo = Math.min(lo, n); hi = Math.max(hi, n); } return { mean: sum / trials, lo, hi }; };
        for (const T of [256, 512]) {
            const base = photo(T, T, 60 + T), stroke = paint(T, T, 61 + T, 0.4), work = new Uint8Array(T * T * 4);
            const per = tilesPerDab(T);
            const r = await kernelRow("tile size", `one stroke tile over a layer tile, ${T}² (a 400 px dab touches ${per.lo} to ${per.hi} tiles, ${per.mean.toFixed(2)} on average)`,
                () => { work.set(base); js.compositeTile(work, [stroke], [OPS["source-over"]], [255], null); }, placeComposite(base, [stroke], [OPS["source-over"]], [255], [null], T), opts, { tiles: T });
            r.perDab = { tiles: per.mean, js: r.js * per.mean, simd: (r.simd + r.copy) * per.mean };
            notes.push({ key: `dab-${T}`, text: `400 px dab at ${T}² tiles: ${per.mean.toFixed(2)} tiles on average → JS ${r.perDab.js.toFixed(3)} ms, SIMD + copy ${r.perDab.simd.toFixed(3)} ms per dab`, ...r.perDab });
        }
    }

    if (want("copy")) {
        // the boundary: one 256² tile copied into wasm memory and back out, against nothing
        const tile = photo(TILE, TILE, 71), back = new Uint8Array(TILE * TILE * 4);
        const p = simd.alloc(TILE * TILE * 4);
        const inOut = await measure(() => { simd.u8().set(tile, p); back.set(simd.view(Uint8Array, p, TILE * TILE * 4)); }, opts);
        const viewOnly = await measure(() => simd.view(Uint8Array, p, TILE * TILE * 4), opts);
        simd.free(p, TILE * TILE * 4);
        const r = { kernel: "boundary copy", input: "one 256² tile (256 KB) into wasm memory and back out, against a tile that lives there (a view)", copyInOut: inOut, viewOnly, info: true };
        row(r);
    }

    return { rows, notes };
}

export function fmtMs(v) {
    if (v == null || Number.isNaN(v)) return "–";
    if (v >= 100) return v.toFixed(0);
    if (v >= 10) return v.toFixed(1);
    if (v >= 1) return v.toFixed(2);
    return v.toFixed(3);
}

export function fmtRow(r) {
    if (r.copyInOut != null) return `${r.kernel} | ${r.input} | in+out ${fmtMs(r.copyInOut)} ms | view ${fmtMs(r.viewOnly)} ms`;
    return `${r.kernel} | ${r.input} | JS ${fmtMs(r.js)} | scalar ${fmtMs(r.scalar)} | SIMD ${fmtMs(r.simd)} | copy ${fmtMs(r.copy)} | ×${r.speedup.toFixed(2)} (×${r.speedupNoCopy.toFixed(2)} without copy)`;
}
