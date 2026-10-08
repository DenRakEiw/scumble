// The edge fit of renderer/editor/edgefit.js without Electron (item 42).
//
//     node tools/edgefit_test.js
//
// A textured picture, a layer made from it shifted and scaled by known amounts (with a soft elliptic edge, new content
// inside and a colour drift), and the fit has to give the matrix back within a pixel at every corner of the box. A flat
// area and fits beyond the node's limits (`_align_patch`: 8 % scale, 5 % shift) refuse; an unshifted layer finds no gain.
"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.dirname(__dirname);

let failures = 0;
function check(name, ok, detail = "") {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
    if (!ok) failures++;
}

function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** A W x H opaque RGBA texture: sinusoids of several sizes and a few hard-edged discs. */
function texture(W, H, seed) {
    const r = rng(seed), waves = [], discs = [];
    for (let k = 0; k < 14; k++) { const a = r() * Math.PI * 2, f = 0.015 + r() * 0.2; waves.push([Math.cos(a) * f, Math.sin(a) * f, r() * 6.28, 8 + r() * 14, r()]); }
    for (let k = 0; k < 25; k++) discs.push([r() * W, r() * H, 6 + r() * 40, (r() - 0.5) * 120]);
    const d = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let v = 128, g = 0;
        for (const [fx, fy, ph, amp, mix] of waves) { const s = Math.sin(fx * x + fy * y + ph) * amp; v += s; g += s * (mix - 0.5); }
        for (const [cx, cy, rad, amp] of discs) if ((x - cx) ** 2 + (y - cy) ** 2 < rad * rad) v += amp;
        const i = (y * W + x) * 4;
        d[i] = v; d[i + 1] = v + g; d[i + 2] = v - g; d[i + 3] = 255;
    }
    return d;
}

function invert(M) {
    const [a, b, tx, c, d, ty] = M, det = a * d - b * c;
    const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
    return [ia, ib, -(ia * tx + ib * ty), ic, id, -(ic * tx + id * ty)];
}

/** M about the point (px, py): scale (sx, sy), then the shift (dx, dy): layer(M x) = base(x). */
function about(px, py, sx, sy, dx, dy) { return [sx, 0, px - sx * px + dx, 0, sy, py - sy * py + dy]; }

function cornerError(Mf, Mt, W, H) {
    let e = 0;
    for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [W / 2, H / 2]]) {
        e = Math.max(e, Math.hypot(Mf[0] * x + Mf[1] * y + Mf[2] - (Mt[0] * x + Mt[1] * y + Mt[2]), Mf[3] * x + Mf[4] * y + Mf[5] - (Mt[3] * x + Mt[4] * y + Mt[5])));
    }
    return e;
}

/**
 * The layer a model might give back: the base read through M^-1 (so layer(M x) = base(x)), opaque inside an ellipse
 * with a soft edge, other content deep inside (the inpainted part), `drift` levels brighter.
 */
function makeLayer(F, base, W, H, M, { drift = 10, other = null } = {}) {
    const lay = F.warpRGBA(base, W, H, invert(M));
    const cx = W / 2, cy = H / 2, rx = W * 0.42, ry = H * 0.42;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4, q = Math.hypot((x - cx) / rx, (y - cy) / ry);
        const a = Math.min(1, Math.max(0, (1.06 - q) / 0.12));
        if (other && q < 0.62) for (let c = 0; c < 3; c++) lay[i + c] = other[i + c];
        for (let c = 0; c < 3; c++) lay[i + c] = a > 0 ? lay[i + c] + drift : 0;
        lay[i + 3] = Math.round(a * 255);
    }
    return lay;
}

(async () => {
    const F = await import(pathToFileURL(path.join(ROOT, "renderer/editor/edgefit.js")).href);
    const W = 800, H = 600;
    const base = texture(W, H, 7), other = texture(W, H, 99);

    // the warp itself: a whole-pixel shift moves bytes exactly
    {
        const out = F.warpRGBA(base, W, H, [1, 0, 3, 0, 1, -2]);
        let same = true;
        for (let y = 2; y < H && same; y++) for (let x = 0; x < W - 3; x++) { const i = (y * W + x) * 4, j = ((y - 2) * W + x + 3) * 4; if (out[i] !== base[j]) { same = false; break; } }
        check("warpRGBA: a whole-pixel shift is a byte shift", same);
    }

    const cases = [
        ["shift (7.4, -5.2) and scale 1.04", about(W * 0.45, H * 0.55, 1.04, 1.04, 7.4, -5.2)],
        ["scale 0.96 / 0.97, shift (-3, 4)", about(W / 2, H / 2, 0.96, 0.97, -3, 4)],
        ["shift only (2.6, 1.3)", about(0, 0, 1, 1, 2.6, 1.3)],
    ];
    for (const [name, Mt] of cases) {
        const lay = makeLayer(F, base, W, H, Mt, { other });
        const t0 = Date.now();
        const r = F.fitLayerRGBA({ baseRGBA: base, layerRGBA: lay, w: W, h: H });
        const ms = Date.now() - t0;
        const err = r.matrix ? cornerError(r.matrix, Mt, W, H) : Infinity;
        check(`${name}: aligned within a pixel`, r.aligned && err <= 1, `err ${err.toFixed(3)} px, scale ${r.scale}, shift ${r.shift}, ${r.before} -> ${r.after}, ${ms} ms${r.reason ? ", " + r.reason : ""}`);
    }

    // the same picture: nothing to gain
    {
        const lay = makeLayer(F, base, W, H, [1, 0, 0, 0, 1, 0], { drift: 0, other });
        const r = F.fitLayerRGBA({ baseRGBA: base, layerRGBA: lay, w: W, h: H });
        check("an unshifted layer is not moved", !r.aligned && r.reason === "no gain", `${r.reason}, shift ${r.shift}`);
    }

    // a flat area refuses
    {
        const r0 = rng(3), flat = new Uint8ClampedArray(W * H * 4);
        for (let i = 0; i < flat.length; i += 4) { const v = 128 + Math.floor(r0() * 5) - 2; flat[i] = flat[i + 1] = flat[i + 2] = v; flat[i + 3] = 255; }
        const lay = makeLayer(F, flat, W, H, about(W / 2, H / 2, 1.03, 1.03, 6, 3));
        const r = F.fitLayerRGBA({ baseRGBA: flat, layerRGBA: lay, w: W, h: H });
        check("a flat area refuses", !r.aligned && r.reason === "flat area", r.reason);
    }

    // too large: beyond 5 % shift, beyond 8 % scale
    for (const [name, Mt] of [["a shift of 9 % refuses", about(0, 0, 1, 1, 72, 10)], ["a scale of 1.15 refuses", about(W / 2, H / 2, 1.15, 1.15, 0, 0)]]) {
        const lay = makeLayer(F, base, W, H, Mt, { other });
        const r = F.fitLayerRGBA({ baseRGBA: base, layerRGBA: lay, w: W, h: H });
        check(name, !r.aligned, `${r.reason}, scale ${r.scale}, shift ${r.shift}`);
    }

    // a ring too small to fit on
    {
        const tiny = F.fitEdges({ base: new Float32Array(100 * 100), layer: new Float32Array(100 * 100), ring: new Uint8Array(100 * 100), w: 100, h: 100 });
        check("an empty ring refuses", !tiny.aligned && tiny.reason === "ring too small", tiny.reason);
    }

    console.log(failures ? `${failures} FAILED` : "all ok");
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
