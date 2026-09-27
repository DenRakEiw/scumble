// The resampler of renderer/editor/inpaint_resample.js without Electron (PLAN_0_1_31 §7, 23b).
//
//     node tools/resample_test.js
//
// The weight tables (every phase sums to 2^14, phase 0 copies), the exact cases (the identity, a whole-pixel shift, the
// quarter turns and a mirror copy the bytes, also at coordinates near 60,000), the edges (transparent, clamp), the
// sparse walk, the mask mode, and arbitrary angles against a reference written here in doubles from the formulas
// (Catmull-Rom / bilinear over premultiplied alpha at the exact position, no phases, no integers): the kernel may differ
// from it only by what its 1/256 px phases and 2^14 weights cost.
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

/** A W x H RGBA image of straight alpha that keeps the invariant: alpha 0 carries colour 0. */
function image(W, H, kind, seed = 1) {
    const r = rng(seed), d = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        let a;
        if (kind === "opaque") a = 255;
        else if (kind === "soft") a = Math.round(127.5 + 127.5 * Math.sin(x / 9) * Math.cos(y / 13));
        else a = r() < 0.15 ? 0 : Math.floor(r() * 256);
        if (kind === "noise" || kind === "mixed") {
            d[i] = Math.floor(r() * 256); d[i + 1] = Math.floor(r() * 256); d[i + 2] = Math.floor(r() * 256);
        } else {
            d[i] = Math.round(127.5 + 127.5 * Math.sin(x / 7 + y / 11)); d[i + 1] = (x * 3 + y) & 255; d[i + 2] = Math.round(127.5 + 127.5 * Math.cos(y / 5));
        }
        d[i + 3] = a;
        if (!a) d[i] = d[i + 1] = d[i + 2] = 0;
    }
    return { W, H, d };
}

/** A source for resampleStore over an image (every pixel exists). */
function source(img, has = () => true) {
    return {
        width: img.W, height: img.H, has,
        copyRun: (sy, x0, x1, dst, off) => dst.set(img.d.subarray((sy * img.W + x0) * 4, (sy * img.W + x1) * 4), off),
    };
}

/** The resampler's output as one W x H image (tiles written into it through a stride). */
function run(R, img, map, outW, outH, opts = {}, mask = false, has) {
    const out = new Uint8Array(outW * outH * 4);
    const made = [];
    R.resampleStore(source(img, has), map, outW, outH, R.resampleOptions(opts, mask), null, {
        tile: (tx, ty) => [out, (ty * 256 * outW + tx * 256) * 4, outW * 4],
        done: (tx, ty, count) => made.push([tx, ty, count]),
    });
    return { d: out, W: outW, H: outH, made };
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

// ---- the reference in doubles ------------------------------------------------------------------------

function cubic(t) {
    return [((-t + 2) * t - 1) * t / 2, ((3 * t - 5) * t * t + 2) / 2, ((-3 * t + 4) * t + 1) * t / 2, (t - 1) * t * t / 2];
}

/** One pixel of the reference: the float position (sx, sy) of the destination pixel, interpolated as premultiplied. */
function refPixel(img, sx, sy, filter, clamp, alphaOnly) {
    const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
    const wx = filter === "bicubic" ? cubic(fx) : [1 - fx, fx], wy = filter === "bicubic" ? cubic(fy) : [1 - fy, fy];
    const lead = filter === "bicubic" ? 1 : 0;
    let A = 0, R = 0, G = 0, B = 0;
    for (let j = 0; j < wy.length; j++) for (let k = 0; k < wx.length; k++) {
        let x = ix - lead + k, y = iy - lead + j;
        if (x < 0 || y < 0 || x >= img.W || y >= img.H) {
            if (!clamp) continue;
            x = Math.min(img.W - 1, Math.max(0, x)); y = Math.min(img.H - 1, Math.max(0, y));
        }
        const i = (y * img.W + x) * 4, w = wx[k] * wy[j], a = img.d[i + 3];
        A += w * a; R += w * a * img.d[i]; G += w * a * img.d[i + 1]; B += w * a * img.d[i + 2];
    }
    const a = Math.min(255, Math.max(0, Math.round(A)));
    if (!a) return [0, 0, 0, 0];
    if (alphaOnly) return [255, 0, 0, a];
    const c = (v) => Math.min(255, Math.max(0, v / A));
    return [c(R), c(G), c(B), a];
}

/** The reference of a whole map: float positions from the float map. */
function reference(img, map, outW, outH, filter, clamp = false, alphaOnly = false) {
    const out = new Float64Array(outW * outH * 4);
    for (let Y = 0; Y < outH; Y++) for (let X = 0; X < outW; X++) {
        const sx = map[0] * X + map[2] * Y + map[4], sy = map[1] * X + map[3] * Y + map[5];
        out.set(refPixel(img, sx, sy, filter, clamp, alphaOnly), (Y * outW + X) * 4);
    }
    return out;
}

/**
 * The kernel's own arithmetic, pixel by pixel, straight from the source (no blocks, no gather, no running sums): the
 * position from the fixed-point map, the phase, the integer weights, exact sums, the same two divisions. The kernel
 * has to give these bytes exactly; what it differs from `reference` by is then only its phases and weights.
 */
function quantized(R, img, map, outW, outH, filter, clamp = false, alphaOnly = false) {
    const f = R.RESAMPLE[filter], { taps, table } = R.resampleWeights(f), lead = taps === 4 ? 1 : 0;
    const fx = R.toFixed(map, outW, outH);
    const out = new Uint8Array(outW * outH * 4);
    for (let Y = 0; Y < outH; Y++) for (let X = 0; X < outW; X++) {
        const SX = fx[0] * X + fx[2] * Y + fx[4], SY = fx[1] * X + fx[3] * Y + fx[5];
        const ix = Math.floor(SX / 4294967296), iy = Math.floor(SY / 4294967296);
        const px = Math.floor(SX / 16777216) & 255, py = Math.floor(SY / 16777216) & 255;
        let SA = 0, SR = 0, SG = 0, SB = 0;
        for (let j = 0; j < taps; j++) for (let k = 0; k < taps; k++) {
            let x = ix - lead + k, y = iy - lead + j;
            if (x < 0 || y < 0 || x >= img.W || y >= img.H) {
                if (!clamp) continue;
                x = Math.min(img.W - 1, Math.max(0, x)); y = Math.min(img.H - 1, Math.max(0, y));
            }
            const i = (y * img.W + x) * 4, w = table[px * taps + k] * table[py * taps + j], a = img.d[i + 3];
            SA += w * a; SR += w * a * img.d[i]; SG += w * a * img.d[i + 1]; SB += w * a * img.d[i + 2];
        }
        let a = Math.floor((SA + 134217728) / 268435456);
        if (a <= 0) continue;
        a = Math.min(255, a);
        const c = (s) => Math.min(255, Math.max(0, Math.floor((2 * s + SA) / (2 * SA))));
        out.set(alphaOnly ? [255, 0, 0, a] : [c(SR), c(SG), c(SB), a], (Y * outW + X) * 4);
    }
    return out;
}

/** The largest difference to the reference: alpha everywhere, colour where alpha is at least `minA`. */
function worst(got, ref, minA = 64) {
    let wa = 0, wc = 0;
    for (let i = 0; i < got.length; i += 4) {
        wa = Math.max(wa, Math.abs(got[i + 3] - ref[i + 3]));
        if (ref[i + 3] >= minA && got[i + 3] >= minA) for (let k = 0; k < 3; k++) wc = Math.max(wc, Math.abs(got[i + k] - ref[i + k]));
    }
    return { alpha: wa, colour: +wc.toFixed(2) };
}

async function main() {
    const R = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_resample.js")).href);

    // ---- the tables
    for (const [name, f] of [["bilinear", R.RESAMPLE.bilinear], ["bicubic", R.RESAMPLE.bicubic]]) {
        const { taps, table } = R.resampleWeights(f);
        let bad = 0;
        for (let p = 0; p < 256; p++) {
            let s = 0;
            for (let k = 0; k < taps; k++) s += table[p * taps + k];
            if (s !== 16384) bad++;
        }
        const zero = Array.from(table.slice(0, taps));
        const copies = taps === 4 ? zero.join() === "0,16384,0,0" : zero.join() === "16384,0";
        check(`${name}: every phase sums to 2^14, phase 0 copies`, !bad && copies, `bad ${bad}, phase 0 ${zero}`);
    }

    // ---- exact maps copy the bytes
    const img = image(601, 357, "mixed", 7);
    const id = run(R, img, R.XF_IDENTITY, img.W, img.H);
    check("the identity copies every byte (bicubic)", !diff(id.d, img.d, img.W), diff(id.d, img.d, img.W));
    const idl = run(R, img, R.XF_IDENTITY, img.W, img.H, { filter: "bilinear" });
    check("the identity copies every byte (bilinear)", !diff(idl.d, img.d, img.W), diff(idl.d, img.d, img.W));

    // a whole-pixel shift: destination (X, Y) <- source (X - 37, Y + 20)
    const sh = run(R, img, R.pixelMap(R.xfInv(R.xfTranslate(37, -20))), img.W, img.H);
    const shRef = new Uint8Array(img.d.length);
    for (let y = 0; y < img.H; y++) for (let x = 0; x < img.W; x++) {
        const sx = x - 37, sy = y + 20;
        if (sx >= 0 && sy >= 0 && sx < img.W && sy < img.H) shRef.set(img.d.subarray((sy * img.W + sx) * 4, (sy * img.W + sx) * 4 + 4), (y * img.W + x) * 4);
    }
    check("a whole-pixel shift copies the bytes, transparent outside", !diff(sh.d, shRef, img.W), diff(sh.d, shRef, img.W));

    // the quarter turns and a mirror as the tile backend's turned(op) places them
    const place = {
        1: (x, y, W, H) => [H - 1 - y, x], "-1": (x, y, W, H) => [y, W - 1 - x], 2: (x, y, W, H) => [W - 1 - x, H - 1 - y], h: (x, y, W, H) => [W - 1 - x, y],
    };
    const forward = {   // the continuous forward map of each op on a W x H picture
        1: R.xfMul(R.xfTranslate(img.H, 0), R.xfRotate(90)),
        "-1": R.xfMul(R.xfTranslate(0, img.W), R.xfRotate(-90)),
        2: R.xfRotate(180, img.W / 2, img.H / 2),
        h: [-1, 0, 0, 1, img.W, 0],
    };
    for (const op of ["1", "-1", "2", "h"]) {
        const q = op === "1" || op === "-1";
        const oW = q ? img.H : img.W, oH = q ? img.W : img.H;
        const got = run(R, img, R.pixelMap(R.xfInv(forward[op])), oW, oH);
        const want = new Uint8Array(img.d.length);
        for (let y = 0; y < img.H; y++) for (let x = 0; x < img.W; x++) {
            const [X, Y] = place[op](x, y, img.W, img.H);
            want.set(img.d.subarray((y * img.W + x) * 4, (y * img.W + x) * 4 + 4), (Y * oW + X) * 4);
        }
        check(`turn ${op} copies the bytes where turned() puts them`, !diff(got.d, want, oW), diff(got.d, want, oW));
    }

    // far from the origin: the fixed point stays exact near 60,000 px (a virtual source filled from a formula)
    const far = { W: 61000, H: 61000 };
    const px = (x, y) => [(x * 7 + y) & 255, (x ^ y) & 255, (x + y * 3) & 255, 255];
    const farSrc = {
        width: far.W, height: far.H, has: () => true,
        copyRun: (sy, x0, x1, dst, off) => { for (let x = x0; x < x1; x++) dst.set(px(x, sy), off + (x - x0) * 4); },
    };
    const farOut = new Uint8Array(300 * 300 * 4);
    R.resampleStore(farSrc, R.pixelMap(R.xfInv(R.xfTranslate(-60600, -60650))), 300, 300, R.resampleOptions({}, false), null, {
        tile: (tx, ty) => [farOut, (ty * 256 * 300 + tx * 256) * 4, 1200], done: () => {},
    });
    let farBad = 0;
    for (let y = 0; y < 300; y++) for (let x = 0; x < 300; x++) {
        const w = px(x + 60600, y + 60650), i = (y * 300 + x) * 4;
        if (w.some((v, k) => farOut[i + k] !== v)) farBad++;
    }
    check("a shift of 60,600 / 60,650 px copies the bytes", !farBad, `${farBad} pixels off`);

    // ---- arbitrary angles against the reference
    for (const [kind, deg, filter] of [["opaque", 3, "bicubic"], ["opaque", 30, "bicubic"], ["soft", 7.5, "bicubic"], ["mixed", -12, "bicubic"], ["soft", 17, "bilinear"], ["noise", 45, "bicubic"]]) {
        const src = image(333, 211, kind, 11);
        const fwd = R.xfRotate(deg, src.W / 2, src.H / 2);
        const map = R.pixelMap(R.xfInv(fwd));
        const got = run(R, src, map, src.W, src.H, { filter });
        const q = quantized(R, src, map, src.W, src.H, filter);
        check(`${deg} degrees, ${kind}, ${filter}: the kernel's arithmetic, byte for byte`, !diff(got.d, q, src.W), diff(got.d, q, src.W));
        const ref = reference(src, map, src.W, src.H, filter);
        const w = worst(got.d, ref);
        // the kernel's position is off by at most 1/512 px and its weights by 2^-15: an alpha step of 255 in one pixel
        // moves by about 1 level; random colours under random alpha move more, because a neighbour of little alpha and
        // a very different colour gains or loses its weight with the position (measured 3.6 at -12 degrees)
        const lim = kind === "noise" || kind === "mixed" ? 4 : 2;
        check(`${deg} degrees, ${kind}, ${filter}: within ${lim} levels of the reference`, w.alpha <= 2 && w.colour <= lim, JSON.stringify(w));
    }
    // the same by the direct arithmetic with clamped edges and in mask mode
    {
        const src = image(300, 190, "mixed", 4);
        const map = R.pixelMap(R.xfInv(R.xfRotate(-23, 150, 95)));
        const got = run(R, src, map, 300, 190, { edge: "clamp" });
        const q = quantized(R, src, map, 300, 190, "bicubic", true);
        check("clamped edges: the kernel's arithmetic, byte for byte", !diff(got.d, q, 300), diff(got.d, q, 300));
        const gm = run(R, src, map, 300, 190, {}, true);
        const qm = quantized(R, src, map, 300, 190, "bilinear", false, true);
        check("mask mode: the kernel's arithmetic, byte for byte", !diff(gm.d, qm, 300), diff(gm.d, qm, 300));
    }

    // a scale (a resize) and a map with a scale and a turn
    {
        const src = image(300, 200, "soft", 5);
        const map = R.pixelMap(R.xfInv(R.xfMul(R.xfRotate(9, 150, 100), R.xfScale(0.61, 0.73))));
        const got = run(R, src, map, 250, 180);
        const w = worst(got.d, reference(src, map, 250, 180, "bicubic"));
        check("a scale with a turn: within 2 levels", w.alpha <= 2 && w.colour <= 2, JSON.stringify(w));
    }

    // ---- masks: the alpha alone, bilinear, in the colour asked for
    {
        const src = image(280, 190, "soft", 3);
        const map = R.pixelMap(R.xfInv(R.xfRotate(21, 140, 95)));
        const got = run(R, src, map, 280, 190, { color: [255, 255, 255] }, true);
        const ref = reference(src, map, 280, 190, "bilinear", false, true);
        let colourBad = 0, wa = 0;
        for (let i = 0; i < got.d.length; i += 4) {
            wa = Math.max(wa, Math.abs(got.d[i + 3] - ref[i + 3]));
            const want = got.d[i + 3] ? 255 : 0;
            if (got.d[i] !== want || got.d[i + 1] !== want || got.d[i + 2] !== want) colourBad++;
        }
        check("a mask: its white where alpha > 0, colour 0 where it is 0, alpha within 1 level", !colourBad && wa <= 1, `colour ${colourBad}, alpha ${wa}`);
    }

    // ---- edges
    {
        const src = image(100, 80, "opaque", 9);
        // shifted by 30 px: the left 30 columns are outside the source
        const map = R.pixelMap(R.xfInv(R.xfTranslate(30, 0)));
        const tr = run(R, src, map, 100, 80);
        const cl = run(R, src, map, 100, 80, { edge: "clamp" });
        let trOk = true, clOk = true;
        for (let y = 0; y < 80; y++) for (let x = 0; x < 30; x++) {
            const i = (y * 100 + x) * 4;
            if (tr.d[i + 3] !== 0) trOk = false;
            const e = (y * 100) * 4;   // the source's first pixel of that row
            for (let k = 0; k < 4; k++) if (cl.d[i + k] !== src.d[e + k]) clOk = false;
        }
        check("transparent edge: nothing outside the source", trOk);
        check("clamp edge: the edge pixel repeats", clOk);
        // a turn with clamp gives an opaque picture everywhere, with transparent the corners are open
        const map2 = R.pixelMap(R.xfInv(R.xfRotate(10, 50, 40)));
        const cl2 = run(R, src, map2, 100, 80, { edge: "clamp" }), tr2 = run(R, src, map2, 100, 80);
        let open = 0, closed = 0;
        for (let i = 3; i < cl2.d.length; i += 4) { if (cl2.d[i] !== 255) closed++; if (tr2.d[i] < 255) open++; }
        check("a turn with clamp is opaque everywhere, with transparent its corners are open", !closed && open > 0, `clamp not opaque ${closed}, transparent open ${open}`);
    }

    // ---- sparse: tiles whose taps meet no source pixel are not made, empty ones are reported empty
    {
        const src = image(1500, 1100, "opaque", 2);
        const has = (x0, y0, x1, y1) => x1 > 1200 && y1 > 900;   // only the far corner exists
        const got = run(R, src, R.XF_IDENTITY, 1500, 1100, {}, false, has);
        const made = got.made.map(([tx, ty]) => tx + "," + ty).sort().join(" ");
        check("sparse: only the tiles over what exists are made", made === "4,3 4,4 5,3 5,4", made);
    }

    // ---- the range check
    let refused = false;
    try { R.toFixed([40, 0, 0, 1, 0, 0], 70000, 10); } catch { refused = true; }
    check("a map beyond the exact range is refused", refused);

    console.log(failures ? `\n${failures} FAILED` : "\nall ok");
    process.exitCode = failures ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
