// The box composite of renderer/editor/inpaint_boxstack.js without Electron (PLAN_0_1_31 §4 step 2).
//
//     node tools/boxstack_test.js
//
// `compositeBox` reads a stack of tile stores under a box and composites it in one kernel call; here the stores are
// sparse stand-ins with `tileAt`, and the reference is written without `storeBox`: every store laid out as a whole
// image, pixel by pixel, the whole image composited by the same kernel (the JS twin: no wasm in Node), and the box cut
// out of it. The kernel works per pixel, so the box of the whole equals the composite of the box. Boxes on tile edges,
// across them, outside the picture, layers at offsets, missing tiles, masks with holes, alpha 0, blend modes, a match.
"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.dirname(__dirname);
const T = 256;

let failures = 0;
function check(name, ok, detail = "") {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
    if (!ok) failures++;
}

function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** Sparse tile pixels of w x h: a tile exists where `has(tx, ty)` says so, filled by `fill(x, y)` -> [r, g, b, a]. */
function store(w, h, has, fill) {
    const tiles = new Map();
    for (let ty = 0; ty * T < h; ty++) for (let tx = 0; tx * T < w; tx++) {
        if (!has(tx, ty)) continue;
        // an edge tile's bytes past the store's side are junk here: a read must never reach them
        const data = new Uint8Array(T * T * 4).fill(201);
        for (let y = 0; y < T && ty * T + y < h; y++) for (let x = 0; x < T && tx * T + x < w; x++) {
            const p = fill(tx * T + x, ty * T + y), i = (y * T + x) * 4;
            data[i] = p[0]; data[i + 1] = p[1]; data[i + 2] = p[2]; data[i + 3] = p[3];
        }
        tiles.set(ty * 65536 + tx, { data });
    }
    return { width: w, height: h, tileAt: (tx, ty) => tiles.get(ty * 65536 + tx) || null, _fill: fill, _has: has };
}

/** A store laid out over the whole W x H image at (sx, sy), pixel by pixel from its definition, not from its tiles' reading. */
function whole(s, sx, sy, W, H, alphaOnly) {
    const out = new Uint8Array(W * H * (alphaOnly ? 1 : 4));
    for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
        const x = X - sx, y = Y - sy;
        if (x < 0 || y < 0 || x >= s.width || y >= s.height || !s._has(x >> 8, y >> 8)) continue;
        const p = s._fill(x, y);
        if (alphaOnly) out[Y * W + X] = p[3];
        else out.set(p, (Y * W + X) * 4);
    }
    return out;
}

(async () => {
    const B = await import(pathToFileURL(path.join(ROOT, "renderer/editor/inpaint_boxstack.js")).href);
    const J = await import(pathToFileURL(path.join(ROOT, "renderer/editor/px/kernels_js.js")).href);
    const W = 700, H = 600;
    const r = rng(7);
    const noise = (seed) => { const q = rng(seed); const cache = new Map(); return (x, y) => { const k = y * 4096 + x; if (!cache.has(k)) { const a = q() < 0.1 ? 0 : Math.floor(q() * 256); cache.set(k, a ? [Math.floor(q() * 256), Math.floor(q() * 256), Math.floor(q() * 256), a] : [0, 0, 0, 0]); } return cache.get(k); }; };
    const base = store(W, H, () => true, (x, y) => [x & 255, y & 255, (x + y) & 255, 255]);
    const l1 = store(300, 280, (tx, ty) => !(tx === 1 && ty === 0), noise(1));                 // a tile missing
    const m1 = store(300, 280, (tx, ty) => !(tx === 0 && ty === 1), (x, y) => [0, 0, 0, (x * 3 + y) & 255]);   // a mask with a hole
    const l2 = store(W, H, (tx, ty) => (tx + ty) % 2 === 0, noise(2));                          // a checkerboard of tiles
    const l3 = store(120, 90, () => true, noise(3));
    const l4 = store(200, 200, () => true, noise(4));
    const l5 = store(300, 300, () => true, noise(5));   // reaches past the picture's left and bottom edges
    const l6 = store(260, 120, () => true, noise(6));   // past the right edge
    const match = [120, 90, 60, 100, 110, 140, 1.2, 0.9, 1.1, 0.7];
    const stacks = {
        "base only": [{ px: base, x: 0, y: 0, alpha: 255, op: 0 }],
        "layers without a base": [null, { px: l1, mask: m1, x: 40, y: 250, alpha: 255, op: 0 }, { px: l3, x: 500, y: 20, alpha: 200, op: 0 }],
        "a full stack": [
            { px: base, x: 0, y: 0, alpha: 255, op: 0 },
            { px: l1, mask: m1, x: 40, y: 250, alpha: 230, op: 5 },
            { px: l2, x: 0, y: 0, alpha: 128, op: 10 },
            { px: l3, x: 500, y: 20, alpha: 0, op: 0 },                    // alpha 0: left out
            { px: l4, x: 430, y: 330, alpha: 255, op: 12, match },
            { px: l5, x: -120, y: 420, alpha: 255, op: 0 },
            { px: l6, x: 560, y: 60, alpha: 210, op: 6 },
        ],
    };
    // the reference: every store over the whole image, composited whole, the box cut out
    const reference = (stack) => {
        const [b, ...ls] = stack;
        const dst = b ? whole(b.px, b.x, b.y, W, H, false) : new Uint8Array(W * H * 4);
        const srcs = [], ops = [], alphas = [], masks = [];
        for (const l of ls) {
            if (!(l.alpha > 0)) continue;
            const src = whole(l.px, l.x, l.y, W, H, false);
            if (l.match) J.matchPixels(src, l.match);
            srcs.push(src); ops.push(l.op); alphas.push(l.alpha); masks.push(l.mask ? whole(l.mask, l.x, l.y, W, H, true) : null);
        }
        if (srcs.length) J.compositeTile(dst, srcs, ops, alphas, masks);
        return dst;
    };
    const boxes = [
        [0, 0, 256, 256], [255, 255, 2, 2], [250, 240, 30, 40], [30, 240, 330, 60], [600, 500, 150, 150],
        [-20, -30, 60, 70], [680, 590, 50, 50], [-10, 100, W + 20, 5], [440, 320, 1, 1], [800, 700, 20, 20],
    ];
    for (let i = 0; i < 12; i++) boxes.push([Math.floor(r() * W) - 40, Math.floor(r() * H) - 40, 1 + Math.floor(r() * 300), 1 + Math.floor(r() * 300)]);
    for (const [name, stack] of Object.entries(stacks)) {
        const ref = reference(stack);
        let bad = 0, first = null;
        for (const [x0, y0, w, h] of boxes) {
            const got = B.compositeBox(stack, x0, y0, w, h, W, H);
            if (got.length !== w * h * 4) { bad++; first = first || `box ${[x0, y0, w, h]}: ${got.length} bytes`; continue; }
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                const X = x0 + x, Y = y0 + y, o = (y * w + x) * 4;
                const inside = X >= 0 && Y >= 0 && X < W && Y < H;
                for (let c = 0; c < 4; c++) {
                    const want = inside ? ref[(Y * W + X) * 4 + c] : 0;
                    if (got[o + c] !== want) { bad++; if (!first) first = `box ${[x0, y0, w, h]} at ${X},${Y} channel ${c}: ${got[o + c]} want ${want}`; }
                }
            }
        }
        check(`${name}: ${boxes.length} boxes equal the whole composite cut out`, bad === 0, first || "");
    }
    // a read reuses its buffers: a second box does not carry the first one's bytes
    const a = B.compositeBox(stacks["a full stack"], 10, 10, 64, 64).slice();
    B.compositeBox(stacks["layers without a base"], 0, 0, 64, 64);
    const again = B.compositeBox(stacks["a full stack"], 10, 10, 64, 64);
    check("a repeated read gives the same bytes after another stack's", a.every((v, i) => v === again[i]));
    // storeBox reports whether a tile lay under the box
    const out = new Uint8Array(20 * 20 * 4);
    check("storeBox: no tile under the box is false", B.storeBox(l1, 40, 250, 40 + 256 + 5, 250 + 5, 20, 20, out) === false);
    check("storeBox: a box outside the store is false", B.storeBox(l3, 500, 20, 0, 0, 20, 20, out) === false);
    check("storeBox: a tile under the box is true", B.storeBox(l3, 500, 20, 505, 25, 20, 20, out) === true);
    // a large box is not kept (and still right)
    const big = B.compositeBox(stacks["base only"], 0, 0, W, H);
    const bigRef = reference(stacks["base only"]);
    check("a box larger than the kept buffers is right", big.length === bigRef.length && big.every((v, i) => v === bigRef[i]));
    B.releaseBoxBuffers();
    console.log(failures ? `${failures} FAILED` : "PASS");
    process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
