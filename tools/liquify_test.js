// Liquify of renderer/editor/inpaint_liquify.js without Electron (PLAN_0_1_31 §5 step 5).
//
//     node tools/liquify_test.js
//
// The bake against 23b's resampler (a constant fractional field is a translation: resampleStore's bytes, every phase,
// every grid step, both edges, with and without a round trip), whole-pixel fields as exact byte shifts that no round
// trip touches, random smooth fields against a per-pixel reference written here from the module's contract (the field
// sum in integers, the tap and phase floors, resampleBlock's integer bicubic, the verbatim copy at phase 0 / 0), the
// tile walk (splits, shared tiles, counts, changedTiles), the edges, the field's interpolation, the brushes (advection,
// restore, thaw, `before`, no fold under the editor's caps, the swirl's direction) and the preview's geometry.
"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.dirname(__dirname);

let failures = 0;
function check(name, ok, detail = "") {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
    if (!ok) failures++;
}

// a deterministic pseudo-random source (no Math.random: a failure must repeat)
function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * A W x H RGBA image of straight alpha that keeps the invariant: alpha 0 carries colour 0. Kinds: "opaque" (random
 * colours, alpha 255), "holes" (random colours, 15 % alpha 0, the rest random), "half" (random colours, alpha 40..219),
 * "clear" (all 0), "coords" (opaque, every pixel's colour its own coordinates).
 */
function image(W, H, kind, seed = 1) {
    const r = rng(seed), d = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        let a;
        if (kind === "opaque" || kind === "coords") a = 255;
        else if (kind === "half") a = 40 + Math.floor(r() * 180);
        else if (kind === "clear") a = 0;
        else a = r() < 0.15 ? 0 : Math.floor(r() * 256);
        if (kind === "coords") { d[i] = x & 255; d[i + 1] = y & 255; d[i + 2] = ((x >> 8) & 15) | ((y >> 8) << 4); }
        else { d[i] = Math.floor(r() * 256); d[i + 1] = Math.floor(r() * 256); d[i + 2] = Math.floor(r() * 256); }
        d[i + 3] = a;
        if (!a) d[i] = d[i + 1] = d[i + 2] = 0;
    }
    return { W, H, d };
}

/** A source for resampleStore / liquifyStore over an image (every pixel exists). */
function source(img) {
    return {
        width: img.W, height: img.H, has: () => true,
        copyRun: (sy, x0, x1, dst, off) => dst.set(img.d.subarray((sy * img.W + x0) * 4, (sy * img.W + x1) * 4), off),
    };
}

/** Pixels where a and b differ (the first few), as a string, or "". */
function diff(a, b, W) {
    const bad = [];
    for (let i = 0; i < a.length; i += 4) {
        if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
            if (bad.length < 3) bad.push(`${(i >> 2) % W},${Math.floor((i >> 2) / W)}: ${Array.from(a.slice(i, i + 4))} vs ${Array.from(b.slice(i, i + 4))}`);
            else { bad.push("..."); break; }
        }
    }
    return bad.join("; ");
}

/** A round-trip table like a canvas's (tools/px_test.js): premultiplied to 8 bits and back. */
function canvasRT() {
    const rt = new Uint8Array(65536);
    for (let a = 1; a < 256; a++) for (let c = 0; c < 256; c++) { const p = Math.floor((c * a + 127) / 255); rt[(a << 8) | c] = Math.min(255, Math.floor((p * 255 + (a >> 1)) / a)); }
    return rt;
}

// ---- fields by hand -----------------------------------------------------------------------------------

/** The nodes 0..ni, 0..nj of a W x H layer at step s, from fn(i, j) -> [dx, dy] (1/256 px), kept here as the truth. */
function grid(W, H, s, fn) {
    const ls = Math.log2(s), ni = ((W - 1) >> ls) + 1, nj = ((H - 1) >> ls) + 1, gw = ni + 1;
    const a = new Int32Array(gw * (nj + 1) * 2);
    for (let j = 0; j <= nj; j++) for (let i = 0; i <= ni; i++) {
        const v = fn(i, j);
        a[(j * gw + i) * 2] = v[0]; a[(j * gw + i) * 2 + 1] = v[1];
    }
    return { W, H, s, ls, ni, nj, gw, a, x: (i, j) => a[(j * gw + i) * 2], y: (i, j) => a[(j * gw + i) * 2 + 1] };
}

/** A LiquifyField holding a grid's nodes, written straight into the cells as the contract lays them out. */
function fieldOf(L, g) {
    const f = new L.LiquifyField(g.W, g.H, g.s), n = 256 / g.s;
    for (let j = 0; j <= g.nj; j++) for (let i = 0; i <= g.ni; i++) {
        const dx = g.x(i, j), dy = g.y(i, j);
        if (!dx && !dy) continue;
        const key = (((j / n) | 0) << 16) | ((i / n) | 0);
        let c = f.cells.get(key);
        if (!c) { c = new Int32Array(n * n * 2); f.cells.set(key, c); }
        const o = ((j % n) * n + (i % n)) * 2;
        c[o] = dx; c[o + 1] = dy;
    }
    return f;
}

/** A node of a field read straight from its cells (not through the module's readers). */
function nodeOf(f, i, j) {
    if (i < 0 || j < 0) return [0, 0];
    const n = 256 / f.s, c = f.cells.get((((j / n) | 0) << 16) | ((i / n) | 0));
    if (!c) return [0, 0];
    const o = ((j % n) * n + (i % n)) * 2;
    return [c[o], c[o + 1]];
}

/** D at the continuous pixel-index position (x, y) in 1/256 px, bilinear in doubles over nodeOf. */
function sampleD(f, x, y) {
    const s = f.s, gx = x / s, gy = y / s, i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j;
    const a = nodeOf(f, i, j), b = nodeOf(f, i + 1, j), c = nodeOf(f, i, j + 1), d = nodeOf(f, i + 1, j + 1);
    const w = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
    return [w[0] * a[0] + w[1] * b[0] + w[2] * c[0] + w[3] * d[0], w[0] * a[1] + w[1] * b[1] + w[2] * c[1] + w[3] * d[1]];
}

/** Every node 0..ni, 0..nj of a field as a grid-like reader (own reads). */
function denseOf(f) {
    const gw = f.ni + 1, a = new Int32Array(gw * (f.nj + 1) * 2);
    for (let j = 0; j <= f.nj; j++) for (let i = 0; i <= f.ni; i++) { const v = nodeOf(f, i, j); a[(j * gw + i) * 2] = v[0]; a[(j * gw + i) * 2 + 1] = v[1]; }
    return { gw, a };
}

/** Sums of Gaussian bumps (count, amplitude up to amp px on each axis), rounded to integer nodes (to multiples of quant). */
function bumpFn(seed, W, H, s, count, amp, quant = 1) {
    const r = rng(seed), list = [];
    for (let b = 0; b < count; b++) list.push({ x: r() * W, y: r() * H, sg: 40 + r() * 140, ax: (r() * 2 - 1) * amp, ay: (r() * 2 - 1) * amp });
    return (i, j) => {
        let dx = 0, dy = 0;
        for (const b of list) {
            const e = Math.exp(-((i * s - b.x) ** 2 + (j * s - b.y) ** 2) / (2 * b.sg * b.sg));
            dx += b.ax * e; dy += b.ay * e;
        }
        return [Math.round(dx * 256 / quant) * quant, Math.round(dy * 256 / quant) * quant];
    };
}

// ---- the bake and its references ----------------------------------------------------------------------

function tileKeys(W, H) {
    const keys = [];
    for (let ty = 0; ty * 256 < H; ty++) for (let tx = 0; tx * 256 < W; tx++) keys.push([tx, ty]);
    return keys;
}

/** liquifyStore over a whole image: a shared tile is the source's own tile. */
function bake(L, img, field, clamp, rt, blockMax, kernel) {
    const W = img.W, H = img.H, out = new Uint8Array(W * H * 4);
    const shared = [], done = [], tiled = [];
    const target = {
        share: (tx, ty) => {
            shared.push(`${tx},${ty}`);
            const vw = Math.min(256, W - tx * 256), vh = Math.min(256, H - ty * 256);
            for (let y = 0; y < vh; y++) {
                const o = ((ty * 256 + y) * W + tx * 256) * 4;
                out.set(img.d.subarray(o, o + vw * 4), o);
            }
        },
        tile: (tx, ty, vw, vh) => { tiled.push(`${tx},${ty}`); return [out, (ty * 256 * W + tx * 256) * 4, W * 4]; },
        done: (tx, ty, count) => done.push([tx, ty, count]),
    };
    const stats = L.liquifyStore(source(img), field.s, (tx, ty) => field.tileNodes(tx, ty), tileKeys(W, H), clamp, rt, target, blockMax, kernel);
    return { d: out, W, H, shared, done, tiled, stats };
}

/** resampleStore of the same image through an index map. */
function resampled(R, img, map, clamp, rt) {
    const out = new Uint8Array(img.W * img.H * 4);
    R.resampleStore(source(img), map, img.W, img.H, R.resampleOptions(clamp ? { edge: "clamp" } : {}, false), rt, {
        tile: (tx, ty) => [out, (ty * 256 * img.W + tx * 256) * 4, img.W * 4], done: () => {},
    });
    return out;
}

/**
 * The bake, pixel by pixel, straight from the contract (no tiles, no blocks, no boxes, no dense node arrays): D as the
 * integer sum of the four nodes weighed (s - fx)(s - fy) .., SX = X 2^k + DX, the tap floor(SX / 2^k), the phase
 * floor(SX / 2^(k - 8)) mod 256; phase 0 / 0 copies the tap's four bytes; else resampleBlock's integer bicubic.
 */
function referenceBake(img, g, clamp, rt, table) {
    const W = img.W, H = img.H, d = img.d, s = g.s, out = new Uint8Array(W * H * 4);
    const k = 8 + 2 * g.ls, K = 2 ** k, KP = 2 ** (k - 8);
    const at = (x, y) => {
        if (x < 0 || y < 0 || x >= W || y >= H) {
            if (!clamp) return -1;
            x = x < 0 ? 0 : x >= W ? W - 1 : x; y = y < 0 ? 0 : y >= H ? H - 1 : y;
        }
        return (y * W + x) * 4;
    };
    const clip = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
    for (let Y = 0; Y < H; Y++) {
        const j = Math.floor(Y / s), fy = Y - j * s, gy = s - fy;
        for (let X = 0; X < W; X++) {
            const i = Math.floor(X / s), fx = X - i * s, gx = s - fx;
            const w00 = gx * gy, w10 = fx * gy, w01 = gx * fy, w11 = fx * fy;
            const DX = w00 * g.x(i, j) + w10 * g.x(i + 1, j) + w01 * g.x(i, j + 1) + w11 * g.x(i + 1, j + 1);
            const DY = w00 * g.y(i, j) + w10 * g.y(i + 1, j) + w01 * g.y(i, j + 1) + w11 * g.y(i + 1, j + 1);
            const SX = X * K + DX, SY = Y * K + DY;
            const tx = Math.floor(SX / K), ty = Math.floor(SY / K);
            const phx = Math.floor(SX / KP) & 255, phy = Math.floor(SY / KP) & 255;
            const o = (Y * W + X) * 4;
            if (!phx && !phy) {
                const q = at(tx, ty);
                if (q >= 0) { out[o] = d[q]; out[o + 1] = d[q + 1]; out[o + 2] = d[q + 2]; out[o + 3] = d[q + 3]; }
                continue;
            }
            let SA = 0, SR = 0, SG = 0, SB = 0;
            for (let r = 0; r < 4; r++) for (let t = 0; t < 4; t++) {
                const q = at(tx - 1 + t, ty - 1 + r);
                if (q < 0) continue;
                const a = d[q + 3];
                if (!a) continue;
                const w = table[phx * 4 + t] * table[phy * 4 + r];
                SA += w * a; SR += w * a * d[q]; SG += w * a * d[q + 1]; SB += w * a * d[q + 2];
            }
            let a = Math.floor((SA + 134217728) / 268435456);
            if (a <= 0) continue;
            if (a > 255) a = 255;
            let cr = clip(Math.floor((2 * SR + SA) / (2 * SA))), cg = clip(Math.floor((2 * SG + SA) / (2 * SA))), cb = clip(Math.floor((2 * SB + SA) / (2 * SA)));
            if (rt && a < 255) { cr = rt[(a << 8) | cr]; cg = rt[(a << 8) | cg]; cb = rt[(a << 8) | cb]; }
            out[o] = cr; out[o + 1] = cg; out[o + 2] = cb; out[o + 3] = a;
        }
    }
    return out;
}

/** Every done() count equals the pixels above alpha 0 in its tile; "" or the first mismatch. */
function countsWrong(res) {
    for (const [tx, ty, count] of res.done) {
        let n = 0;
        const vw = Math.min(256, res.W - tx * 256), vh = Math.min(256, res.H - ty * 256);
        for (let y = 0; y < vh; y++) for (let x = 0; x < vw; x++) if (res.d[((ty * 256 + y) * res.W + tx * 256 + x) * 4 + 3]) n++;
        if (n !== count) return `tile ${tx},${ty}: done ${count}, pixels ${n}`;
    }
    return "";
}

/**
 * The smallest Jacobian determinant of x -> x + D(x) over every node cell (its four corners), in (256 s)^2 units;
 * `border` leaves out that many cells along each edge of the layer.
 */
function minJacobian(f, border = 0) {
    const { gw, a } = denseOf(f), U = 256 * f.s;
    let min = Infinity, where = "";
    const P = (i, j) => [i * U + a[(j * gw + i) * 2], j * U + a[(j * gw + i) * 2 + 1]];
    const cross = (u, v) => u[0] * v[1] - u[1] * v[0];
    const sub = (u, v) => [u[0] - v[0], u[1] - v[1]];
    for (let j = border; j < f.nj - border; j++) for (let i = border; i < f.ni - border; i++) {
        const p00 = P(i, j), p10 = P(i + 1, j), p01 = P(i, j + 1), p11 = P(i + 1, j + 1);
        const ex0 = sub(p10, p00), ex1 = sub(p11, p01), ey0 = sub(p01, p00), ey1 = sub(p11, p10);
        const m = Math.min(cross(ex0, ey0), cross(ex0, ey1), cross(ex1, ey0), cross(ex1, ey1)) / (U * U);
        if (m < min) { min = m; where = `${i},${j}`; }
    }
    return { min, where };
}

async function main() {
    const t0 = Date.now();
    const L = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_liquify.js")).href);
    const R = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_resample.js")).href);
    const CUBIC = R.resampleWeights(R.RESAMPLE.bicubic).table;
    const RT = canvasRT();

    // ---- 1. tables and constants -----------------------------------------------------------------------
    {
        const own = R.resampleTable(R.RESAMPLE.bicubic).table;
        const same = own.length === CUBIC.length && CUBIC.every((v, i) => v === own[i]);
        let bad = 0;
        for (let p = 0; p < 256; p++) if (CUBIC[p * 4] + CUBIC[p * 4 + 1] + CUBIC[p * 4 + 2] + CUBIC[p * 4 + 3] !== 16384) bad++;
        const zero = Array.from(CUBIC.slice(0, 4)).join();
        check("tables: resampleWeights(1) is the table the kernel imports (resampleTable(1)), every phase sums to 2^14, phase 0 copies", same && !bad && zero === "0,16384,0,0", `same ${same}, bad ${bad}, phase 0 ${zero}`);

        // every phase through the kernel: a constant field of phase p on x (then on y) equals resampleStore's shift
        const img = image(40, 30, "holes", 3);
        let bad2 = "";
        for (let p = 0; p < 256 && !bad2; p++) {
            for (const [dx, dy] of [[p - 512, 0], [0, 3 * 256 + p], [p, 255 - p]]) {
                const f = fieldOf(L, grid(img.W, img.H, 1, () => [dx, dy]));
                const got = bake(L, img, f, false, null).d, want = resampled(R, img, [1, 0, 0, 1, dx / 256, dy / 256], false, null);
                const dd = diff(got, want, img.W);
                if (dd) { bad2 = `(${dx}, ${dy}): ${dd}`; break; }
            }
        }
        check("tables: all 256 phases on x, on y and mixed equal resampleStore's shift (the kernel weighs with that table)", !bad2, bad2);

        check("gridStep: 1 up to 4 MP, 2 up to 16 MP, 4 up to 256 MP, 8 above",
            L.gridStep(2048, 2048) === 1 && L.gridStep(2049, 2048) === 2 && L.gridStep(4096, 4096) === 2 && L.gridStep(4097, 4096) === 4
            && L.gridStep(16384, 16384) === 4 && L.gridStep(16385, 16384) === 8);
        let fall = true, slope = 0;
        for (const h of [0, 0.4, 0.8]) {
            if (L.liquifyFalloff(0, h) !== 1 || L.liquifyFalloff(h, h) !== 1 || L.liquifyFalloff(1, h) !== 0 || L.liquifyFalloff(1.3, h) !== 0) fall = false;
            for (let t = 0; t < 1; t += 1e-4) {
                const v = L.liquifyFalloff(t, h), u = L.liquifyFalloff(t + 1e-4, h);
                if (u > v + 1e-12 || v < 0 || v > 1) fall = false;
                slope = Math.max(slope, (v - u) / 1e-4 * (1 - h));
            }
        }
        check("liquifyFalloff: 1 in the core, 0 from the rim, falling, steepest slope within 1.54 / (1 - h)", fall && slope <= 1.54, `slope ${slope.toFixed(4)} (1 - h)`);
        const f8 = new L.LiquifyField(1000, 700, 8), f1 = new L.LiquifyField(1000, 700, 1);
        check("LiquifyField: n = 256 / s, ni / nj the last node a pixel reads", f8.n === 32 && f1.n === 256 && f1.ni === 1000 && f1.nj === 700 && f8.ni === 125 && f8.nj === 88 && f1.empty,
            `n ${f8.n}/${f1.n}, ni ${f1.ni}/${f8.ni}, nj ${f1.nj}/${f8.nj}`);
        let refused = false;
        try { new L.LiquifyField(10, 10, 3); } catch { refused = true; }
        check("LiquifyField: a grid step outside 1, 2, 4, 8 is refused; LIQUIFY_MODES lists the six modes", refused && L.LIQUIFY_MODES.join() === "push,grow,shrink,swirlcw,swirlccw,restore");
    }

    // ---- 2. against 23b's kernel: a constant fractional field is a translation --------------------------
    {
        const fields = [[1, 0], [128, 128], [255, -1], [-129, 300], [0, 255], [7 * 256 + 1, -3 * 256 + 128]];
        for (const s of [1, 2, 4, 8]) {
            let bad = "", runs = 0;
            for (const kind of ["opaque", "holes"]) {
                const img = image(300, 270, kind, 20 + s);
                for (const [dx, dy] of fields) {
                    const f = fieldOf(L, grid(img.W, img.H, s, () => [dx, dy]));
                    for (const clamp of [false, true]) for (const rt of [null, RT]) {
                        const got = bake(L, img, f, clamp, rt).d;
                        const want = resampled(R, img, [1, 0, 0, 1, dx / 256, dy / 256], clamp, rt);
                        runs++;
                        const dd = diff(got, want, img.W);
                        if (dd && !bad) bad = `${kind} (${dx}, ${dy}) clamp ${clamp} rt ${!!rt}: ${dd}`;
                    }
                }
            }
            check(`constant fractional fields at s = ${s} equal resampleStore's translation byte for byte (${runs} runs: opaque / holes, rt null / canvas, transparent / clamp)`, !bad, bad);
        }
    }

    // ---- 3. whole pixels: exact byte shifts, untouched by the round trip --------------------------------
    {
        const img = image(300, 270, "half", 5);
        let touched = 0;
        for (let q = 0; q < img.d.length; q += 4) for (let c = 0; c < 3; c++) if (RT[(img.d[q + 3] << 8) | img.d[q + c]] !== img.d[q + c]) touched++;
        check("whole pixels: the round-trip table changes bytes of the half-transparent source (else the next checks prove nothing)", touched > 1000, `${touched} bytes`);
        const shift = (dx, dy, clamp) => {
            const want = new Uint8Array(img.d.length);
            for (let y = 0; y < img.H; y++) for (let x = 0; x < img.W; x++) {
                let sx = x + dx, sy = y + dy;
                if (sx < 0 || sy < 0 || sx >= img.W || sy >= img.H) {
                    if (!clamp) continue;
                    sx = Math.min(img.W - 1, Math.max(0, sx)); sy = Math.min(img.H - 1, Math.max(0, sy));
                }
                want.set(img.d.subarray((sy * img.W + sx) * 4, (sy * img.W + sx) * 4 + 4), (y * img.W + x) * 4);
            }
            return want;
        };
        for (const s of [1, 2, 4, 8]) {
            let bad = "";
            for (const [dx, dy] of [[7, -3], [-40, 25]]) {
                const f = fieldOf(L, grid(img.W, img.H, s, () => [dx * 256, dy * 256]));
                for (const clamp of [false, true]) {
                    const dd = diff(bake(L, img, f, clamp, RT).d, shift(dx, dy, clamp), img.W);
                    if (dd && !bad) bad = `(${dx}, ${dy}) px clamp ${clamp}: ${dd}`;
                }
            }
            check(`whole pixels at s = ${s}: (7, -3) and (-40, 25) px are exact byte shifts with a round trip that changes bytes (both edges)`, !bad, bad);
        }
        // D = 0 inside a tile that has a bump elsewhere: the source's bytes, whatever the round trip does
        for (const s of [1, 4]) {
            const g = grid(img.W, img.H, s, (i, j) => (i * s < 90 && j * s < 80 ? [Math.round(300 * Math.sin(i * s / 13)), 517] : [0, 0]));
            const got = bake(L, img, fieldOf(L, g), false, RT).d;
            let bad = 0, n = 0;
            for (let y = 0; y < img.H; y++) for (let x = 0; x < img.W; x++) {
                const i = Math.floor(x / s), j = Math.floor(y / s);
                if (g.x(i, j) || g.y(i, j) || g.x(i + 1, j) || g.y(i + 1, j) || g.x(i, j + 1) || g.y(i, j + 1) || g.x(i + 1, j + 1) || g.y(i + 1, j + 1)) continue;
                n++;
                const q = (y * img.W + x) * 4;
                for (let c = 0; c < 4; c++) if (got[q + c] !== img.d[q + c]) { bad++; break; }
            }
            check(`whole pixels at s = ${s}: D = 0 beside a bump in the same tile gives the source's bytes with the round trip on`, !bad && n > 10000, `${bad} of ${n} pixels off`);
        }
    }

    // ---- 4. random smooth fields against the per-pixel reference ---------------------------------------
    {
        const W = 560, H = 300;
        const imgs = { opaque: image(W, H, "opaque", 31), holes: image(W, H, "holes", 32) };
        for (const s of [1, 2, 4, 8]) {
            let bad = "", runs = 0, counts = "";
            for (const [quant, label] of [[1, "fine"], [64, "coarse"]]) {
                const g = grid(W, H, s, bumpFn(100 + s * 7 + quant, W, H, s, 2 + (s % 3), 300, quant));
                const f = fieldOf(L, g);
                for (const [kind, clamp, rt] of [["opaque", true, null], ["opaque", false, RT], ["holes", false, RT], ["holes", true, null], ["holes", true, RT]]) {
                    const img = imgs[kind];
                    const got = bake(L, img, f, clamp, rt);
                    const want = referenceBake(img, g, clamp, rt, CUBIC);
                    runs++;
                    const dd = diff(got.d, want, W);
                    if (dd && !bad) bad = `${label} ${kind} clamp ${clamp} rt ${!!rt}: ${dd}`;
                    const cw = countsWrong(got);
                    if (cw && !counts) counts = `${label} ${kind}: ${cw}`;
                }
            }
            check(`smooth fields (2 to 4 bumps up to 300 px) at s = ${s} equal the reference byte for byte (${runs} runs; opaque with clamp is the opaque path, coarse nodes hit phase 0 / 0)`, !bad, bad);
            check(`smooth fields at s = ${s}: every done() count is the tile's pixels above alpha 0`, !counts, counts);
        }
    }

    // ---- 5. the walk --------------------------------------------------------------------------------------
    {
        // a tiny blockMax splits down to small regions: the same bytes
        const W = 560, H = 300, img = image(W, H, "holes", 41);
        const g = grid(W, H, 2, bumpFn(55, W, H, 2, 3, 250));
        const f = fieldOf(L, g);
        const def = bake(L, img, f, false, RT), tiny = bake(L, img, f, false, RT, 64);
        const dd = diff(tiny.d, def.d, W);
        check("walk: blockMax 64 gives the default's bytes", !dd && tiny.stats.splits > 0, `${dd} splits ${tiny.stats.splits}, maxBlock ${tiny.stats.maxBlock}`);
    }
    {
        // tiles whose nodes are all zero are shared, the kernel runs only for the others. s = 2 and nodes only in cells
        // x >= 2, y >= 1: tiles (1, 1), (2, 0) and (1, 0) have empty cells of their own but read the first column, row
        // or corner node of a neighbour cell (their last pixel column / row interpolates towards it)
        const W = 1100, H = 700, s = 2, n = 128, img = image(W, H, "holes", 42);
        const g = grid(W, H, s, (i, j) => {
            if (i < 2 * n || j < n) return [0, 0];
            const e = Math.exp(-((i * s - 600) ** 2 + (j * s - 330) ** 2) / 12000);
            return [Math.round(30 * 256 * e), Math.round(-12 * 256 * e)];
        });
        const f = fieldOf(L, g);
        const called = new Set();
        const kernel = function (...args) { called.add(`${args[14] >> 8},${args[15] >> 8}`); return L.liquifyBlock(...args); };
        const res = bake(L, img, f, false, RT, undefined, kernel);
        const zero = new Set();
        for (const [tx, ty] of tileKeys(W, H)) {
            let any = false;
            for (let j = ty * n; j <= Math.min(g.nj, ty * n + n) && !any; j++) for (let i = tx * n; i <= Math.min(g.ni, tx * n + n); i++) if (g.x(i, j) || g.y(i, j)) { any = true; break; }
            if (!any) zero.add(`${tx},${ty}`);
        }
        const neighbours = ["1,1", "2,0", "1,0"].every((k) => !zero.has(k)) && !f.cells.has((1 << 16) | 1) && !f.cells.has(2) && !f.cells.has(1);
        check("walk: the case holds tiles that read only a neighbour cell's first column, row or corner node", neighbours);
        const sh = [...res.shared].sort().join(" "), zs = [...zero].sort().join(" ");
        const overlap = [...called].filter((k) => zero.has(k)).length + res.tiled.filter((k) => zero.has(k)).length;
        const all = res.shared.length + res.tiled.length === tileKeys(W, H).length && called.size === res.tiled.length;
        check("walk: tiles whose nodes are all zero call share() and no kernel; the others call tile(), the kernel and done()", sh === zs && !overlap && all && zero.size > 0 && called.size > 0,
            `shared [${sh}], zero [${zs}], kernel [${[...called].sort().join(" ")}]`);
        const want = referenceBake(img, g, false, RT, CUBIC);
        check("walk: the shared and baked tiles together equal the reference", !diff(res.d, want, W), diff(res.d, want, W));
    }
    {
        // transparent outputs: count 0
        const W = 600, H = 400;
        const far = fieldOf(L, grid(W, H, 2, () => [5000 * 256, 77]));
        const a = bake(L, image(W, H, "holes", 43), far, false, RT);
        const clear = bake(L, image(W, H, "clear"), fieldOf(L, grid(W, H, 1, bumpFn(9, W, H, 1, 3, 40))), true, RT);
        const zeros = (d) => d.every((v) => v === 0);
        check("walk: a field reading only outside (transparent) and a clear source give done() counts of 0 and zero bytes",
            a.done.every((t) => t[2] === 0) && zeros(a.d) && a.stats.blocks === 0 && clear.done.every((t) => t[2] === 0) && zeros(clear.d) && clear.stats.blocks > 0,
            `far counts ${a.done.map((t) => t[2])} blocks ${a.stats.blocks}; clear counts ${clear.done.map((t) => t[2])}`);
    }
    {
        // changedTiles: a changed cell reaches its own tile and its left, upper and upper-left neighbours, inside tw x th
        const W = 1024, H = 700, tw = 4, th = 3;
        const f = new L.LiquifyField(W, H, 1);
        const keys = (set) => [...set].map((k) => `${k & 0xFFFF},${k >>> 16}`).sort().join(" ");
        let before = new Map(f.cells);
        f.dab("push", 600, 400, 30, 0.5, 1, [3, 2], null, before);
        const c1 = keys(f.changedTiles(before, tw, th));
        before = new Map(f.cells);
        f.dab("push", 10, 10, 8, 0.5, 1, [1, 1], null, before);
        const c2 = keys(f.changedTiles(before, tw, th));
        before = new Map(f.cells);
        f.dab("push", 1020, 10, 12, 0.5, 1, [2, 1], null, before);
        const c3 = keys(f.changedTiles(before, tw, th));
        const cells3 = keys(new Set([...f.cells.keys()].filter((k) => before.get(k) !== f.cells.get(k))));
        before = new Map(f.cells);
        f.restoreAll(null, before);
        const c4 = keys(f.changedTiles(before, tw, th));
        check("changedTiles: cell (2, 1) reaches 1,0 1,1 2,0 2,1; cell (0, 0) only 0,0", c1 === "1,0 1,1 2,0 2,1" && c2 === "0,0", `[${c1}] [${c2}]`);
        check("changedTiles: cells (3, 0) and (4, 0) at the right edge stay inside the 4 x 3 tiles", cells3 === "3,0 4,0" && c3 === "2,0 3,0", `cells [${cells3}] tiles [${c3}]`);
        check("changedTiles: cells a restore dropped count as changed", c4 === "0,0 1,0 1,1 2,0 2,1 3,0" && f.empty, `[${c4}]`);

        // the tiles whose bytes change are among them (s = 2: a tile's last row and column interpolate towards the next cell)
        const W2 = 1100, H2 = 700, g = new L.LiquifyField(W2, H2, 2), img = image(W2, H2, "holes", 44), r = rng(45);
        for (let q = 0; q < 6; q++) g.dab("push", 200 + r() * 700, 100 + r() * 500, 80, 0.5, 1, [5, -4], null, null);
        const b2 = new Map(g.cells);
        const old = bake(L, img, new L.LiquifyField(W2, H2, 2, b2), false, RT);
        g.dab("push", 512, 256, 20, 0.5, 1, [-3, 2], null, b2);
        g.dab("swirlcw", 768, 512, 40, 0.3, 1, null, null, b2);
        const now = bake(L, img, g, false, RT);
        const ct = g.changedTiles(b2, 5, 3), missed = [];
        for (const [tx, ty] of tileKeys(W2, H2)) {
            let changed = false;
            for (let y = ty * 256; y < Math.min(H2, ty * 256 + 256) && !changed; y++) {
                const o = (y * W2 + tx * 256) * 4, e = (y * W2 + Math.min(W2, tx * 256 + 256)) * 4;
                for (let q = o; q < e; q++) if (old.d[q] !== now.d[q]) { changed = true; break; }
            }
            if (changed && !ct.has((ty << 16) | tx)) missed.push(`${tx},${ty}`);
        }
        const outside = [...ct].filter((k) => (k & 0xFFFF) >= 5 || k >>> 16 >= 3);
        check("changedTiles: every tile whose bake changed is listed, none outside tw x th", !missed.length && !outside.length && ct.size > 0, `missed [${missed}] outside [${outside}] listed [${keys(ct)}]`);
    }
    {
        // a heavy Shrink: the source box of a tile grows past blockMax, the regions split, the bytes stay
        const W = 768, H = 768, s = 2, f = new L.LiquifyField(W, H, s);
        for (let q = 0; q < 60; q++) f.dab("shrink", 384, 384, 370, 0.8, 1, null, null, null);
        const img = image(W, H, "holes", 46), lim = 1 << 14;
        const split = bake(L, img, f, false, RT, lim), whole = bake(L, img, f, false, RT, 2 ** 40);
        check(`a heavy Shrink field: splits > 0 and maxBlock <= blockMax (${lim}); unsplit it reads ${whole.stats.maxBlock} px in one block`,
            split.stats.splits > 0 && split.stats.maxBlock <= lim && whole.stats.splits === 0 && whole.stats.maxBlock > lim, JSON.stringify(split.stats));
        check("a heavy Shrink field: the split bake has the unsplit bake's bytes", !diff(split.d, whole.d, W), diff(split.d, whole.d, W));
        const g = grid(W, H, s, (i, j) => nodeOf(f, i, j));
        check("a heavy Shrink field: the bake equals the reference", !diff(whole.d, referenceBake(img, g, false, RT, CUBIC), W), diff(whole.d, referenceBake(img, g, false, RT, CUBIC), W));
    }

    // ---- 6. edges -----------------------------------------------------------------------------------------
    for (const s of [1, 4]) {
        const W = 500, H = 400, img = image(W, H, "opaque", 50);
        // every edge pulls from outside: left and top read further left / up, right and bottom further right / down
        const g = grid(W, H, s, (i, j) => {
            const x = i * s, y = j * s, e = (d) => Math.exp(-(d * d) / 7200);
            return [Math.round(256 * (-130.3 * e(x) + 110.7 * e(W - 1 - x))), Math.round(256 * (-120.6 * e(y) + 140.2 * e(H - 1 - y)))];
        });
        const f = fieldOf(L, g);
        const cl = bake(L, img, f, true, RT), tr = bake(L, img, f, false, RT);
        let notOpaque = 0;
        for (let q = 3; q < cl.d.length; q += 4) if (cl.d[q] !== 255) notOpaque++;
        const k = 8 + 2 * Math.log2(s), K = 2 ** k;
        let outside = 0, outsideBad = 0, inside = 0, insideBad = 0;
        for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
            const i = Math.floor(X / s), j = Math.floor(Y / s), fx = X - i * s, fy = Y - j * s, gx = s - fx, gy = s - fy;
            const SX = X * K + gx * gy * g.x(i, j) + fx * gy * g.x(i + 1, j) + gx * fy * g.x(i, j + 1) + fx * fy * g.x(i + 1, j + 1);
            const SY = Y * K + gx * gy * g.y(i, j) + fx * gy * g.y(i + 1, j) + gx * fy * g.y(i, j + 1) + fx * fy * g.y(i + 1, j + 1);
            const tx = Math.floor(SX / K), ty = Math.floor(SY / K);
            const a = tr.d[(Y * W + X) * 4 + 3];
            if (tx + 2 < 0 || tx - 1 >= W || ty + 2 < 0 || ty - 1 >= H) { outside++; if (a !== 0) outsideBad++; }
            else if (tx - 1 >= 0 && tx + 2 < W && ty - 1 >= 0 && ty + 2 < H) { inside++; if (a !== 255) insideBad++; }
        }
        check(`edges at s = ${s}: clamp pulls no transparency in (every pixel opaque on an opaque source)`, !notOpaque, `${notOpaque} not opaque`);
        check(`edges at s = ${s}: transparent gives alpha 0 where every tap is outside, 255 where every tap is inside`, outside > 1000 && !outsideBad && !insideBad,
            `all outside ${outside} (${outsideBad} not clear), all inside ${inside} (${insideBad} not opaque)`);
    }

    // ---- 7. the field's interpolation ------------------------------------------------------------------
    for (const s of [1, 2, 4, 8]) {
        const W = 700, H = 500, r = rng(70 + s);
        const g = grid(W, H, s, () => [Math.floor((r() * 2 - 1) * 20000), Math.floor((r() * 2 - 1) * 20000)]);
        const f = fieldOf(L, g), rd = L.fieldReader(f), out = [0, 0];
        let badNode = 0, badMid = 0, badInt = 0, worstMid = 0;
        for (let j = 0; j <= g.nj; j++) for (let i = 0; i <= g.ni; i++) {
            rd.sample(i * s, j * s, out);
            if (out[0] !== g.x(i, j) || out[1] !== g.y(i, j)) badNode++;
        }
        for (let q = 0; q < 20000; q++) {
            const x = r() * (W - 1), y = r() * (H - 1);
            rd.sample(x, y, out);
            const i = Math.floor(x / s), j = Math.floor(y / s), fx = x / s - i, fy = y / s - j;
            for (const [c, v] of [[0, g.x], [1, g.y]]) {
                const ref = (1 - fx) * (1 - fy) * v(i, j) + fx * (1 - fy) * v(i + 1, j) + (1 - fx) * fy * v(i, j + 1) + fx * fy * v(i + 1, j + 1);
                const e = Math.abs(out[c] - ref);
                worstMid = Math.max(worstMid, e);
                if (e > 1e-6) badMid++;
            }
        }
        // at pixels: the contract's integer sum is the double bilinear times s^2 (negative nodes included)
        for (let Y = 0; Y < H; Y += 3) for (let X = 0; X < W; X++) {
            const i = Math.floor(X / s), j = Math.floor(Y / s), fx = X - i * s, fy = Y - j * s, gx = s - fx, gy = s - fy;
            const DX = gx * gy * g.x(i, j) + fx * gy * g.x(i + 1, j) + gx * fy * g.x(i, j + 1) + fx * fy * g.x(i + 1, j + 1);
            const DY = gx * gy * g.y(i, j) + fx * gy * g.y(i + 1, j) + gx * fy * g.y(i, j + 1) + fx * fy * g.y(i + 1, j + 1);
            rd.sample(X, Y, out);
            if (Math.abs(out[0] * s * s - DX) > 1e-6 || Math.abs(out[1] * s * s - DY) > 1e-6) badInt++;
        }
        check(`fieldReader at s = ${s}: nodes exact, between nodes the double bilinear, at pixels the contract's integer sum / s^2`, !badNode && !badMid && !badInt,
            `nodes ${badNode}, between ${badMid} (worst ${worstMid}), integer ${badInt}`);
        // the module's own node readers against the cells
        let badNodes = "";
        const probe = [[0, 0, 5, 4], [250, 3, 20, 9], [g.ni - 7, g.nj - 5, 8, 6], [-3, -2, 6, 5]];
        for (const [i0, j0, nw, nh] of probe) {
            const a = f.nodes(i0, j0, nw, nh);
            for (let j = 0; j < nh && !badNodes; j++) for (let i = 0; i < nw; i++) {
                const v = nodeOf(f, i0 + i, j0 + j), q = (j * nw + i) * 2;
                if (a[q] !== v[0] || a[q + 1] !== v[1]) { badNodes = `nodes(${i0}, ${j0}) at ${i},${j}: ${a[q]},${a[q + 1]} vs ${v}`; break; }
            }
        }
        const nd = f.node(3, 4);
        if (nd[0] !== g.x(3, 4) || nd[1] !== g.y(3, 4)) badNodes += ` node(3, 4) ${nd}`;
        const n = 256 / s, tn = f.tileNodes(1, 0);
        if (tn) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { const v = nodeOf(f, n + i, j); if (tn[(j * (n + 1) + i) * 2] !== v[0] || tn[(j * (n + 1) + i) * 2 + 1] !== v[1]) { badNodes += " tileNodes"; j = n + 1; break; } }
        const empty = new L.LiquifyField(W, H, s);
        empty.cells.set(1, new Int32Array(n * n * 2));
        check(`node / nodes / tileNodes at s = ${s} read the cells; tileNodes is null over zero cells`, !badNodes && tn && empty.tileNodes(0, 0) === null && empty.tileNodes(1, 0) === null, badNodes);
        // the kernel's integer interpolation: nodes on multiples of s^2 whole pixels put every position on a whole pixel,
        // so the bake copies the source pixel at X + (sum of weights times nodes) / s^2 exactly, negative nodes included
        const coords = image(W, H, "coords");
        const gc = grid(W, H, s, () => [Math.round((r() * 2 - 1) * 6) * 256 * s * s, Math.round((r() * 2 - 1) * 6) * 256 * s * s]);
        const got = bake(L, coords, fieldOf(L, gc), false, RT).d;
        let badC = 0, neg = 0;
        for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
            const i = Math.floor(X / s), j = Math.floor(Y / s), fx = X - i * s, fy = Y - j * s, gx = s - fx, gy = s - fy;
            const m = (v) => (gx * gy * v(i, j) + fx * gy * v(i + 1, j) + gx * fy * v(i, j + 1) + fx * fy * v(i + 1, j + 1)) / (256 * s * s);
            const sx = X + m(gc.x), sy = Y + m(gc.y);
            if (sx < X) neg++;
            const o = (Y * W + X) * 4;
            const want = sx < 0 || sy < 0 || sx >= W || sy >= H ? [0, 0, 0, 0] : Array.from(coords.d.subarray((sy * W + sx) * 4, (sy * W + sx) * 4 + 4));
            for (let c = 0; c < 4; c++) if (got[o + c] !== want[c]) { badC++; break; }
        }
        check(`the kernel's integer interpolation at s = ${s}: whole-pixel positions from integer sums, negative nodes included`, !badC && neg > 1000, `${badC} pixels off, ${neg} read to the left`);
    }

    // ---- 8. the brushes --------------------------------------------------------------------------------
    for (const s of [1, 4]) {
        // two pushes in one core: D at the twice-moved spot is -(a + b)
        {
            const f = new L.LiquifyField(800, 800, s), c = [400.3, 380.7], a = [12.4, 5.2], b = [-3.3, 13.1];
            f.dab("push", c[0], c[1], 200, 0.5, 1, a, null, null);
            f.dab("push", c[0] + a[0], c[1] + a[1], 200, 0.5, 1, b, null, null);
            const D = sampleD(f, c[0] + a[0] + b[0], c[1] + a[1] + b[1]);
            const ex = Math.abs(D[0] / 256 + a[0] + b[0]), ey = Math.abs(D[1] / 256 + a[1] + b[1]);
            check(`push at s = ${s}: two pushes carry the mark by their sum (D = -(a + b) within 0.5 px)`, ex <= 0.5 && ey <= 0.5, `off ${ex.toFixed(3)}, ${ey.toFixed(3)} px`);
        }
        // the second push where the first moved the content, its end outside the first dab: an additive update is off by |a|
        {
            const f = new L.LiquifyField(1000, 1000, s), c = [400.3, 380.7], a = [1.6, 1.6], b = [50, 40];
            f.dab("push", c[0], c[1], 60, 0.8, 1, a, null, null);             // step 2.26 <= 0.2 * 60 * 0.2
            f.dab("push", c[0] + a[0], c[1] + a[1], 700, 0.5, 1, b, null, null);   // step 64 <= 0.2 * 700 * 0.5
            const D = sampleD(f, c[0] + a[0] + b[0], c[1] + a[1] + b[1]);
            const ex = Math.abs(D[0] / 256 + a[0] + b[0]), ey = Math.abs(D[1] / 256 + a[1] + b[1]);
            check(`push at s = ${s}: advected, not additive (the end lies outside the first dab; additive would be off by 2.26 px)`, ex <= 0.5 && ey <= 0.5, `off ${ex.toFixed(3)}, ${ey.toFixed(3)} px`);
            // restore brings it back to exactly zero and drops the cells
            let n = 0, grew = false;
            while (!f.empty && n < 300) {
                const snap = new Map([...f.cells].map(([k, v]) => [k, v.slice()]));
                f.dab("restore", 500, 500, 1000, 0.8, 1, null, null, null);
                for (const [k, v] of f.cells) { const o = snap.get(k); if (!o) { grew = true; continue; } for (let q = 0; q < v.length; q++) if (Math.abs(v[q]) > Math.abs(o[q]) || v[q] * o[q] < 0) grew = true; }
                n++;
            }
            check(`restore at s = ${s}: D shrinks towards 0 without changing sign, reaches exactly 0, the cells are dropped (empty)`, f.empty && !grew, `${n} dabs, ${f.cells.size} cells left`);
        }
        // a thaw of 0 leaves every node as it was
        {
            const f = new L.LiquifyField(600, 400, s);
            f.dab("push", 300, 200, 100, 0.3, 1, [8, 3], null, null);
            const snap = new Map([...f.cells].map(([k, v]) => [k, v.slice()]));
            let moved = 0;
            for (const mode of L.LIQUIFY_MODES) if (f.dab(mode, 300, 200, 120, 0.3, 1, [5, 5], () => 0, null) !== null) moved++;
            const r = f.restoreAll(() => 0, null);
            for (const [k, v] of f.cells) if (!snap.has(k) || v.some((x, q) => x !== snap.get(k)[q])) moved++;
            check(`thaw at s = ${s}: a thaw of 0 leaves the nodes untouched (every mode, restoreAll)`, !moved && r === null && f.cells.size === snap.size, `${moved} moved`);
            const half = f.restoreAll(() => 0.5, null);
            let off = 0;
            for (const [k, v] of snap) for (let q = 0; q < v.length; q++) { const now = f.cells.get(k); if ((now ? now[q] : 0) !== Math.trunc(v[q] * 0.5)) off++; }
            const all = f.restoreAll(() => 1, null);
            check(`restoreAll at s = ${s}: a thaw of 0.5 halves every node (truncated), a thaw of 1 empties the field`, !off && half && all && f.empty, `${off} off`);
        }
        // swirlcw turns clockwise on screen (y down): a point right of the centre moves down
        for (const [mode, sign] of [["swirlcw", 1], ["swirlccw", -1]]) {
            const f = new L.LiquifyField(600, 600, s), c = [300, 300];
            for (let q = 0; q < 10; q++) f.dab(mode, c[0], c[1], 100, 0.8, 1, null, null, null);
            const p0 = [c[0] + 40, c[1]];
            let X = p0.slice();
            for (let it = 0; it < 80; it++) { const D = sampleD(f, X[0], X[1]); X = [p0[0] - D[0] / 256, p0[1] - D[1] / 256]; }
            const want = [c[0] + 40 * Math.cos(Math.PI / 6), c[1] + sign * 40 * Math.sin(Math.PI / 6)];
            const e = Math.hypot(X[0] - want[0], X[1] - want[1]);
            check(`${mode} at s = ${s}: ten dabs turn a mark 40 px right of the centre by 30 degrees ${sign > 0 ? "down (clockwise)" : "up (counter-clockwise)"}`,
                sign * (X[1] - p0[1]) > 15 && e < 0.5, `mark at ${X.map((v) => v.toFixed(2))}, want ${want.map((v) => v.toFixed(2))}`);
        }
    }
    // no fold: 500 random dabs of every mode within the editor's caps keep det J > 0 at every node (brushes may overlap
    // the layer's edge, as a stroke dragged past it does; the second line leaves the 20 cells along the edges out)
    for (const [s, W, H, rmin, rmax] of [[1, 400, 300, 6, 150], [4, 1600, 1200, 20, 600]]) {
        const f = new L.LiquifyField(W, H, s), r = rng(90 + s), used = {};
        for (let q = 0; q < 500; q++) {
            const mode = L.LIQUIFY_MODES[Math.floor(r() * L.LIQUIFY_MODES.length)];
            used[mode] = (used[mode] || 0) + 1;
            const rad = rmin + r() * (rmax - rmin), h = r() * 0.8, amount = 0.05 + r() * 0.95;
            const ang = r() * 2 * Math.PI, step = r() * 0.2 * rad * (1 - h);
            f.dab(mode, -0.1 * W + r() * 1.2 * W, -0.1 * H + r() * 1.2 * H, rad, h, amount, [step * Math.cos(ang), step * Math.sin(ang)], null, null);
        }
        const j = minJacobian(f), jin = minJacobian(f, 20);
        check(`no fold at s = ${s}: after 500 random dabs (every mode, within the caps) det J > 0 at every node`, j.min > 0 && Object.keys(used).length === 6,
            `min det ${j.min.toFixed(4)} at node ${j.where}, reach ${f.maxReach().toFixed(1)} px, modes ${JSON.stringify(used)}`);
        check(`no fold at s = ${s}: the same field 20 cells in from the layer's edges`, jin.min > 0, `min det ${jin.min.toFixed(4)} at node ${jin.where}`);
    }
    // `before`: a cell the press holds is never written in place
    {
        const f = new L.LiquifyField(500, 400, 1), r = rng(81);
        for (let q = 0; q < 20; q++) f.dab("push", 100 + r() * 300, 100 + r() * 200, 60, 0.5, 1, [4, -3], null, null);
        const before = new Map(f.cells), snap = new Map([...before].map(([k, c]) => [k, c.slice()]));
        for (let q = 0; q < 150; q++) {
            const mode = L.LIQUIFY_MODES[q % 6], rad = 30 + r() * 150, h = r() * 0.8;
            f.dab(mode, r() * 500, r() * 400, rad, h, 1, [0.1 * rad * (1 - h), -0.05 * rad * (1 - h)], null, before);
        }
        f.restoreAll(() => 0.3, before);
        let written = 0, sharedAfter = 0;
        for (const [k, c] of before) { const o = snap.get(k); for (let q = 0; q < c.length; q++) if (c[q] !== o[q]) { written++; break; } }
        for (const [k, c] of f.cells) if (before.get(k) === c) sharedAfter++;
        check("before: 150 dabs of every mode and a partial restoreAll never write into a cell the press holds", !written && before.size > 0, `${written} of ${before.size} written, ${sharedAfter} still shared`);
        // a copy's dabs leave the original alone
        const g = f.copy(), held = new Map(f.cells), snap2 = new Map([...held].map(([k, c]) => [k, c.slice()]));
        g.dab("swirlcw", 250, 200, 150, 0.3, 1, null, null, held);
        g.dab("restore", 250, 200, 150, 0.3, 1, null, null, held);
        let bad = f.cells.size !== held.size ? 1 : 0;
        for (const [k, c] of f.cells) { if (held.get(k) !== c) bad++; else if (c.some((v, q) => v !== snap2.get(k)[q])) bad++; }
        const differs = [...g.cells].some(([k, c]) => held.get(k) !== c);
        check("before: dabs on a copy with the original's cells as `before` leave the original's map and bytes alone", !bad && differs, `${bad} cells of the original changed`);
    }
    // the box a dab returns holds every pixel whose bake changed
    {
        const W = 600, H = 400, img = image(W, H, "holes", 85), r = rng(86);
        let f = new L.LiquifyField(W, H, 2);
        for (let q = 0; q < 4; q++) f.dab("push", 100 + r() * 400, 100 + r() * 200, 70, 0.4, 1, [6, 2], null, null);
        let old = bake(L, img, f, false, RT), bad = "";
        for (let q = 0; q < 12; q++) {
            const g = f.copy(), mode = L.LIQUIFY_MODES[q % 6], rad = 20 + r() * 80, h = r() * 0.8;
            const box = g.dab(mode, r() * W, r() * H, rad, h, 1, [0.2 * rad * (1 - h), 0], null, f.cells);
            const now = bake(L, img, g, false, RT);
            for (let y = 0; y < H && !bad; y++) for (let x = 0; x < W; x++) {
                const o = (y * W + x) * 4;
                if (old.d[o] === now.d[o] && old.d[o + 1] === now.d[o + 1] && old.d[o + 2] === now.d[o + 2] && old.d[o + 3] === now.d[o + 3]) continue;
                if (!box || x < box[0] || y < box[1] || x >= box[2] || y >= box[3]) { bad = `${mode}: pixel ${x},${y} changed outside ${box}`; break; }
            }
            f = g; old = now;
        }
        check("dab: the returned box holds every pixel whose bake changed (12 dabs of every mode, s = 2)", !bad, bad);
    }

    // ---- 9. the preview ----------------------------------------------------------------------------------
    for (const s of [1, 4]) {
        const W = 530, H = 300, img = image(W, H, "opaque", 95), r = rng(96 + s);
        // a constant whole-pixel field, and one whose nodes sit on multiples of s^2 px (every pixel's D a whole pixel)
        for (const [label, fn] of [["constant (7, -3) px", () => [7 * 256, -3 * 256]],
            ["varying whole-pixel", () => [Math.round((r() * 2 - 1) * 5) * 256 * s * s, Math.round((r() * 2 - 1) * 5) * 256 * s * s]]]) {
            const f = fieldOf(L, grid(W, H, s, fn));
            const baked = bake(L, img, f, true, RT).d;
            const out = new Uint8Array(W * H * 4);
            L.previewBlock({ data: img.d, w: W, h: H, x0: 0, y0: 0, L: 0 }, f, 0, 0, 1, out, W, H);
            check(`previewBlock at s = ${s}: inv 1, level 0, a ${label} field on an opaque source gives the bake's bytes (clamped edge)`, !diff(out, baked, W), diff(out, baked, W));
        }
    }

    console.log(failures ? `\n${failures} FAILED (${((Date.now() - t0) / 1000).toFixed(1)} s)` : `\nall ok (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    process.exitCode = failures ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
