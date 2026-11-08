"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

// In Node, provide minimal canvas creation and ImageData for probeColor and readRect
const ImageData = globalThis.ImageData || class ImageData {
    constructor(...args) {
        if (args[0] instanceof Uint8ClampedArray || args[0] instanceof Uint8Array) {
            this.data = args[0] instanceof Uint8ClampedArray ? args[0] : new Uint8ClampedArray(args[0].buffer, args[0].byteOffset, args[0].byteLength);
            this.width = args[1];
            this.height = args[2];
        } else {
            this.width = args[0];
            this.height = args[1];
            this.data = new Uint8ClampedArray(this.width * this.height * 4);
        }
    }
};
globalThis.ImageData = ImageData;

if (typeof document === "undefined") {
    globalThis.document = {
        createElement(tag) {
            if (tag === "canvas") {
                return {
                    width: 1,
                    height: 1,
                    getContext() {
                        let style = "#000000";
                        return {
                            set fillStyle(s) { style = s; },
                            get fillStyle() { return style; },
                            fillRect() {},
                            getImageData() {
                                if (style === "#ff0000") return { data: new Uint8Array([255, 0, 0, 255]) };
                                if (style === "#ffffff") return { data: new Uint8Array([255, 255, 255, 255]) };
                                return { data: new Uint8Array([0, 0, 0, 255]) };
                            }
                        };
                    }
                };
            }
            return {};
        }
    };
}

async function main() {
    const rasterMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_raster.js")).href);
    const {
        SEL_MODES, mul255, combineAlpha, combineRows, selModeOf, selectionGco,
        rectSource, bytesSource, tilesSource
    } = rasterMod;
    const tilesMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_tiles.js")).href);
    const { TileMaskPixels } = tilesMod;
    const pixelsMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_pixels.js")).href);
    const { MaskPixels } = pixelsMod;

    console.log("Running combine_test.js...");

// 1. Check SEL_MODES
assert.deepEqual(SEL_MODES, ["replace", "add", "subtract", "intersect"]);

// 2. Check mul255
assert.equal(mul255(0, 0), 0);
assert.equal(mul255(255, 255), 255);
assert.equal(mul255(255, 0), 0);
assert.equal(mul255(0, 255), 0);
assert.equal(mul255(255, 128), 128);
assert.equal(mul255(128, 128), 64);
for (let x = 0; x < 256; x++) {
    for (let y = 0; y < 256; y++) {
        const expected = Math.round((x * y) / 255);
        const actual = mul255(x, y);
        assert.equal(actual, expected, `mul255 mismatch at ${x},${y}`);
    }
}
console.log("  [ok] mul255 matches Math.round(x*y/255) for all 65,536 pairs");

// 3. Check combineAlpha & Spot checks
assert.equal(combineAlpha(128, 128, "add"), 192);
assert.equal(combineAlpha(255, 128, "subtract"), 127);
assert.equal(combineAlpha(255, 128, "intersect"), 128);
assert.equal(combineAlpha(0, 128, "replace"), 128);
assert.equal(combineAlpha(255, 128, "replace"), 128);

// Identity check: combineAlpha(a, 255 - w, "subtract") === combineAlpha(a, w, "intersect")
for (let a = 0; a < 256; a++) {
    for (let w = 0; w < 256; w++) {
        const sub = combineAlpha(a, 255 - w, "subtract");
        const inter = combineAlpha(a, w, "intersect");
        assert.equal(sub, inter, `identity failed at a=${a}, w=${w}`);
    }
}
console.log("  [ok] combineAlpha spot checks and identity hold for all 65,536 pairs");

// 4. Check selModeOf
assert.equal(selModeOf({ shiftKey: true, altKey: true }), "intersect");
assert.equal(selModeOf({ altKey: true }), "subtract");
assert.equal(selModeOf({ shiftKey: true }), "add");
assert.equal(selModeOf({}), "replace");
assert.equal(selModeOf(null), "replace");
assert.equal(selModeOf(null, "add"), "add");
console.log("  [ok] selModeOf maps modifiers correctly");

// 5. Check selectionGco
assert.deepEqual(selectionGco("replace"), { op: "source-over", clearOutside: true });
assert.deepEqual(selectionGco("add"), { op: "source-over", clearOutside: false });
assert.deepEqual(selectionGco("subtract"), { op: "destination-out", clearOutside: false });
assert.deepEqual(selectionGco("intersect"), { op: "destination-in", clearOutside: true });
console.log("  [ok] selectionGco returns correct ops and clearOutside flags");

// 6. Check rectSource
const rSrc = rectSource([10, 20, 30, 40]);
assert.deepEqual(rSrc.box, [10, 20, 30, 40]);
const rRead = rSrc.read(5, 15, 30, 30);
assert.equal(rRead.length, 900);
for (let y = 15; y < 45; y++) {
    for (let x = 5; x < 35; x++) {
        const expected = (x >= 10 && x < 30 && y >= 20 && y < 40) ? 255 : 0;
        assert.equal(rRead[(y - 15) * 30 + (x - 5)], expected);
    }
}
console.log("  [ok] rectSource fills box and zeroes outside");

// 7. Check bytesSource
const bData = new Uint8Array([10, 20, 30, 40]);
const bSrc = bytesSource(bData, 5, 5, 2, 2);
assert.deepEqual(bSrc.box, [5, 5, 7, 7]);
const bRead = bSrc.read(4, 4, 4, 4);
assert.equal(bRead[0], 0);
assert.equal(bRead[1 * 4 + 1], 10);
assert.equal(bRead[1 * 4 + 2], 20);
assert.equal(bRead[2 * 4 + 1], 30);
assert.equal(bRead[2 * 4 + 2], 40);
console.log("  [ok] bytesSource copies bytes accurately");

// 8. Check tilesSource (including full: true without allocation)
const tSrc = tilesSource([
    { tx: 0, ty: 0, full: true },
    { tx: 1, ty: 0, empty: true },
    { tx: 0, ty: 1, alpha: new Uint8Array(65536).fill(77) }
], [0, 0]);
assert.equal(tSrc.read(0, 0, 1, 1)[0], 255);
assert.equal(tSrc.read(256, 0, 1, 1)[0], 0);
assert.equal(tSrc.read(0, 256, 1, 1)[0], 77);
assert.equal(tSrc.read(512, 512, 1, 1)[0], 0);
console.log("  [ok] tilesSource handles full, empty, and alpha tiles");

// 9. Check combineRows
{
    const dst = new Uint8Array([255, 0, 0, 128, 255, 0, 0, 64]);
    const src = new Uint8Array([128, 0]);
    combineRows(dst, 0, 8, src, 0, 2, 2, 1, "add", [255, 0, 0]);
    assert.equal(dst[3], 192); // 128 + 128 - 64 = 192
    assert.equal(dst[0], 255);
    assert.equal(dst[7], 64);   // sa=0 in add keeps da: 64 + 0 - 0 = 64
}
{
    const dst = new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255]);
    const src = new Uint8Array([0, 128]);
    combineRows(dst, 0, 8, src, 0, 2, 2, 1, "replace", [0, 255, 0]);
    // pixel 0: sa = 0 -> cleared to [0, 0, 0, 0]
    assert.equal(dst[0], 0);
    assert.equal(dst[1], 0);
    assert.equal(dst[2], 0);
    assert.equal(dst[3], 0);
    // pixel 1: sa = 128 -> [0, 255, 0, 128]
    assert.equal(dst[4], 0);
    assert.equal(dst[5], 255);
    assert.equal(dst[6], 0);
    assert.equal(dst[7], 128);
}
console.log("  [ok] combineRows updates pixels and clears zero alpha");

// 10. TileMaskPixels combine on 601 x 501
{
    const W = 601, H = 501;
    const m = new TileMaskPixels(W, H);
    // Fill initial area
    m.fill([50, 50, 550, 450], "#ff0000");

    // Soft source crossing tile edge at x = 256
    const sw = 150, sh = 150, sx0 = 230, sy0 = 210;
    const srcAlpha = new Uint8Array(sw * sh);
    const steps = [0, 37, 128, 200, 255];
    for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
            const stepIdx = Math.floor((x / sw) * steps.length);
            srcAlpha[y * sw + x] = steps[Math.min(steps.length - 1, stepIdx)];
        }
    }
    const softSrc = bytesSource(srcAlpha, sx0, sy0, sw, sh);

    for (const mode of ["replace", "add", "subtract", "intersect"]) {
        const testMask = new TileMaskPixels(W, H);
        testMask.fill([50, 50, 550, 450], "#ff0000");
        const before = testMask.readRect(0, 0, W, H).data.slice();

        testMask.combine(softSrc, mode);
        const after = testMask.readRect(0, 0, W, H).data;

        let worst = 0;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const idx = (y * W + x) * 4;
                const da = before[idx + 3];
                let sa = 0;
                if (x >= sx0 && x < sx0 + sw && y >= sy0 && y < sy0 + sh) {
                    sa = srcAlpha[(y - sy0) * sw + (x - sx0)];
                }
                const expectedA = combineAlpha(da, sa, mode);
                const actualA = after[idx + 3];
                const diff = Math.abs(actualA - expectedA);
                if (diff > worst) worst = diff;
                if (actualA > 0) {
                    assert.equal(after[idx], 255);
                    assert.equal(after[idx + 1], 0);
                    assert.equal(after[idx + 2], 0);
                } else {
                    assert.equal(after[idx], 0);
                    assert.equal(after[idx + 1], 0);
                    assert.equal(after[idx + 2], 0);
                }
            }
        }
        assert.equal(worst, 0, `mode ${mode} worst diff ${worst}`);
    }
    console.log("  [ok] TileMaskPixels combine matches combineAlpha exactly on 601x501 across tile edges");

    // Intersect with empty source leaves tileCount 0
    const mEmpty = new TileMaskPixels(W, H);
    mEmpty.fill([100, 100, 400, 400], "#ff0000");
    assert.ok(mEmpty.tileCount > 0);
    mEmpty.combine(rectSource([0, 0, 0, 0]), "intersect");
    assert.equal(mEmpty.tileCount, 0, "intersect with empty source did not leave tileCount 0");
    console.log("  [ok] TileMaskPixels intersect with empty source leaves tileCount 0");

    // Box starting at x = 256 drops every tile to its left for intersect and keeps them for add
    const mLeft = new TileMaskPixels(W, H);
    mLeft.fill([0, 0, 500, 400], "#ff0000");
    const box256 = [256, 0, W, H];
    mLeft.combine(rectSource(box256), "intersect");
    for (const key of mLeft.tileKeys()) {
        const tx = key & 0xFFFF;
        assert.ok(tx * 256 >= 256, `intersect kept tile to left of x=256: tx=${tx}`);
    }
    console.log("  [ok] TileMaskPixels intersect drops all tiles left of x=256");

    const mAdd = new TileMaskPixels(W, H);
    mAdd.fill([50, 50, 150, 150], "#ff0000"); // tile tx=0
    mAdd.combine(rectSource(box256), "add");
    let hasLeft = false;
    for (const key of mAdd.tileKeys()) {
        const tx = key & 0xFFFF;
        if (tx === 0) hasLeft = true;
    }
    assert.ok(hasLeft, "add dropped tile left of x=256");
    console.log("  [ok] TileMaskPixels add keeps tiles left of x=256");

    // Colour [255, 255, 255] works for a layer mask
    const mWhite = new TileMaskPixels(300, 200);
    mWhite.combine(rectSource([50, 50, 250, 150]), "replace", [255, 255, 255]);
    const wData = mWhite.readRect(50, 50, 1, 1).data;
    assert.deepEqual(Array.from(wData), [255, 255, 255, 255]);
    console.log("  [ok] TileMaskPixels layer mask color [255, 255, 255] works");
}

// 11. Cross-backend equivalence between MaskPixels and TileMaskPixels
{
    // A mock canvas for MaskPixels in Node
    function MockCanvas(w, h) {
        this.width = w;
        this.height = h;
        this._buf = new Uint8ClampedArray(w * h * 4);
        const self = this;
        this.getContext = () => ({
            canvas: self,
            save() {},
            restore() {},
            setTransform() {},
            setLineDash() {},
            beginPath() {},
            globalAlpha: 1,
            globalCompositeOperation: "source-over",
            fillStyle: "#000000",
            strokeStyle: "#000000",
            lineWidth: 1,
            lineCap: "butt",
            lineJoin: "miter",
            miterLimit: 10,
            lineDashOffset: 0,
            shadowBlur: 0,
            shadowColor: "rgba(0, 0, 0, 0)",
            shadowOffsetX: 0,
            shadowOffsetY: 0,
            filter: "none",
            imageSmoothingEnabled: true,
            imageSmoothingQuality: "low",
            font: "10px sans-serif",
            textAlign: "start",
            clearRect(x, y, cw, ch) {
                const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
                const x1 = Math.min(w, (x + cw) | 0), y1 = Math.min(h, (y + ch) | 0);
                for (let row = y0; row < y1; row++) {
                    self._buf.fill(0, (row * w + x0) * 4, (row * w + x1) * 4);
                }
            },
            fillRect(x, y, cw, ch) {
                const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
                const x1 = Math.min(w, (x + cw) | 0), y1 = Math.min(h, (y + ch) | 0);
                for (let row = y0; row < y1; row++) {
                    for (let col = x0; col < x1; col++) {
                        const o = (row * w + col) * 4;
                        self._buf[o] = 255; self._buf[o + 1] = 0; self._buf[o + 2] = 0; self._buf[o + 3] = 255;
                    }
                }
            },
            getImageData(x, y, cw, ch) {
                const data = new Uint8ClampedArray(cw * ch * 4);
                const x0 = Math.max(0, x), y0 = Math.max(0, y);
                const x1 = Math.min(w, x + cw), y1 = Math.min(h, y + ch);
                if (x0 < x1 && y0 < y1) {
                    const rowW = (x1 - x0) * 4;
                    for (let row = y0; row < y1; row++) {
                        const sOff = (row * w + x0) * 4;
                        const dOff = ((row - y) * cw + (x0 - x)) * 4;
                        data.set(self._buf.subarray(sOff, sOff + rowW), dOff);
                    }
                }
                return new ImageData(data, cw, ch);
            },
            putImageData(img, x, y) {
                const cw = img.width, ch = img.height;
                const x0 = Math.max(0, x), y0 = Math.max(0, y);
                const x1 = Math.min(w, x + cw), y1 = Math.min(h, y + ch);
                if (x0 < x1 && y0 < y1) {
                    const rowW = (x1 - x0) * 4;
                    for (let row = y0; row < y1; row++) {
                        const sOff = ((row - y) * cw + (x0 - x)) * 4;
                        const dOff = (row * w + x0) * 4;
                        self._buf.set(img.data.subarray(sOff, sOff + rowW), dOff);
                    }
                }
            }
        });
    }

    const W = 601, H = 501;
    const sw = 150, sh = 150, sx0 = 230, sy0 = 210;
    const srcAlpha = new Uint8Array(sw * sh);
    const steps = [0, 37, 128, 200, 255];
    for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
            const stepIdx = Math.floor((x / sw) * steps.length);
            srcAlpha[y * sw + x] = steps[Math.min(steps.length - 1, stepIdx)];
        }
    }
    const softSrc = bytesSource(srcAlpha, sx0, sy0, sw, sh);

    for (const mode of ["replace", "add", "subtract", "intersect"]) {
        const c = new MockCanvas(W, H);
        const cm = new MaskPixels(c);
        cm.fill([50, 50, 550, 450], "#ff0000");

        const tm = new TileMaskPixels(W, H);
        tm.fill([50, 50, 550, 450], "#ff0000");

        cm.combine(softSrc, mode);
        tm.combine(softSrc, mode);

        const cBytes = cm.readRect(0, 0, W, H).data;
        const tBytes = tm.readRect(0, 0, W, H).data;

        assert.equal(cBytes.length, tBytes.length);
        for (let i = 0; i < cBytes.length; i++) {
            if (cBytes[i] !== tBytes[i]) {
                const px = i >> 2;
                const x = px % W, y = Math.floor(px / W);
                throw new Error(`Backend mismatch in mode ${mode} at ${x},${y} channel ${i%4}: canvas=${cBytes[i]}, tiles=${tBytes[i]}`);
            }
        }
    }
    console.log("  [ok] Canvas and Tiles backends are 100% byte-equal across all combine modes!");
}

// 12. K5 (docs/PLAN_WASM_BUILD.md §4.3): TileMaskPixels.combine through px/kernels.js selCombine on both routes (the
// Rust kernel and its twin) against a plain per-pixel model, over every source and view kind: a long-row bytes source
// (views of kind 1, packed by px.js), a small one across tile edges (read), tiles of each kind at the origin (views of
// kinds 0 / 1 / 2 / 4) and off the grid (read), rects (kind 2, the fill) and partial ones (read); on an empty mask and a
// soft one; red and white. The extents the combine caches equal a fresh scan, and bounds() the model's.
{
    const fs = require("node:fs");
    const { fileURLToPath } = require("node:url");
    const PX_DIR = path.join(ROOT, "renderer", "editor", "px");
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u, ...rest) => {   // kernels.js fetches ./px.wasm; Node's fetch reads no file: URL
        const s = String(u && u.href ? u.href : u);
        return s.startsWith("file:") ? new Response(fs.readFileSync(fileURLToPath(s))) : realFetch(u, ...rest);
    };
    let K;
    try {
        K = await import(pathToFileURL(path.join(PX_DIR, "kernels.js")).href);
        assert.ok(await K.kernelsReady(), "kernels.js did not load px.wasm");
    } finally { globalThis.fetch = realFetch; }

    const W = 601, H = 501;
    let seed = 0xc0b1e;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const soft = () => (rnd() < 0.4 ? 0 : (rnd() < 0.2 ? 255 : 1 + Math.floor(rnd() * 254)));
    // the sources and their alpha at (x, y) for the model
    const whole = Uint8Array.from({ length: W * H }, soft);
    const small = Uint8Array.from({ length: 150 * 150 }, soft);
    const tileAlpha = () => Uint8Array.from({ length: 65536 }, soft).buffer;
    const tileRGBA = () => { const d = new Uint8Array(262144); for (let i = 0; i < 65536; i++) { d[i * 4] = 9; d[i * 4 + 1] = 99; d[i * 4 + 2] = 199; d[i * 4 + 3] = soft(); } return d.buffer; };
    const mixed = [
        { tx: 0, ty: 0, alpha: tileAlpha() }, { tx: 1, ty: 0, data: tileRGBA() }, { tx: 2, ty: 0, full: true },
        { tx: 0, ty: 1, empty: true }, { tx: 2, ty: 1, alpha: tileAlpha() },   // (1, 1) missing
    ];
    const tileAt = (tiles, at) => (x, y) => {
        const tx = Math.floor((x - at[0]) / 256), ty = Math.floor((y - at[1]) / 256);
        const t = tiles.find((q) => q.tx === tx && q.ty === ty);
        if (!t || t.empty) return 0;
        const i = (y - at[1] - ty * 256) * 256 + (x - at[0] - tx * 256);
        if (t.full) return 255;
        if (t.alpha) return new Uint8Array(t.alpha)[i];
        return new Uint8Array(t.data)[i * 4 + 3];
    };
    const inRect = (r) => (x, y) => (x >= r[0] && x < r[2] && y >= r[1] && y < r[3] ? 255 : 0);
    const sources = [
        ["bytes, the whole image", () => bytesSource(whole, 0, 0, W, H), (x, y) => whole[y * W + x]],
        ["bytes across tile edges", () => bytesSource(small, 230, 210, 150, 150), (x, y) => (x >= 230 && x < 380 && y >= 210 && y < 360 ? small[(y - 210) * 150 + x - 230] : 0)],
        ["tiles of every kind", () => tilesSource(mixed, [0, 0], [0, 0, W, H]), tileAt(mixed, [0, 0])],
        ["tiles off the grid", () => tilesSource(mixed, [100, 37], [100, 37, W, H]), tileAt(mixed, [100, 37])],
        ["a rect over the image", () => rectSource([0, 0, W, H]), inRect([0, 0, W, H])],
        ["a partial rect", () => rectSource([50, 60, 400, 300]), inRect([50, 60, 400, 300])],
    ];
    const starts = [
        ["an empty mask", () => {}],
        ["a soft mask", (mk) => { mk.fill([50, 50, 550, 450], "#ff0000"); mk.combine(bytesSource(whole, 0, 0, W, H), "intersect"); }],
    ];
    const plainExtent = (t) => {
        let x0 = 256, y0 = -1, x1 = -1, y1 = -1;
        for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
            if (!t.data[(y * 256 + x) * 4 + 3]) continue;
            if (y0 < 0) y0 = y;
            y1 = y; if (x < x0) x0 = x; if (x > x1) x1 = x;
        }
        return y0 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
    };
    const calls = {};
    let checked = 0;
    for (const route of ["js", "rust"]) {
        K.setKernels("rust");
        K.setRoute("selCombine", route);
        K.pxCalls(true);
        for (const [startName, start] of starts) for (const [srcName, make, alphaAt] of sources) for (const color of [[255, 0, 0], [255, 255, 255]]) for (const mode of SEL_MODES) {
            const what = `${route}: ${mode} of ${srcName} on ${startName} in ${color}`;
            const mk = new TileMaskPixels(W, H);
            start(mk);
            const before = mk.readRect(0, 0, W, H).data.slice();
            const src = make();
            mk.combine(src, mode, color);
            const after = mk.readRect(0, 0, W, H).data;
            // the model: the tiles the source's box (clamped to the image) overlaps are combined pixel by pixel
            // (combineAlpha; a covered pixel takes the colour); the others replace and intersect drop, add and subtract keep
            const cb = [Math.max(0, Math.min(W, src.box[0])), Math.max(0, Math.min(H, src.box[1])), Math.max(0, Math.min(W, src.box[2])), Math.max(0, Math.min(H, src.box[3]))];
            const visited = (x, y) => cb[0] < cb[2] && cb[1] < cb[3] && (x >> 8) >= (cb[0] >> 8) && (x >> 8) <= ((cb[2] - 1) >> 8) && (y >> 8) >= (cb[1] >> 8) && (y >> 8) <= ((cb[3] - 1) >> 8);
            let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                const o = (y * W + x) * 4;
                let want, a;
                if (visited(x, y)) {
                    a = combineAlpha(before[o + 3], alphaAt(x, y), mode);
                    want = a ? [color[0], color[1], color[2], a] : [0, 0, 0, 0];
                } else if (mode === "replace" || mode === "intersect") {
                    a = 0;
                    want = [0, 0, 0, 0];
                } else {
                    a = before[o + 3];
                    want = [before[o], before[o + 1], before[o + 2], a];
                }
                for (let c = 0; c < 4; c++) if (after[o + c] !== want[c]) assert.fail(`${what}: (${x}, ${y}) channel ${c} is ${after[o + c]}, the model has ${want[c]}`);
                if (a) { if (x < bx0) bx0 = x; if (y < by0) by0 = y; if (x > bx1) bx1 = x; if (y > by1) by1 = y; }
            }
            assert.deepEqual(mk.bounds(), bx1 < 0 ? null : [bx0, by0, bx1 + 1, by1 + 1], `${what}: bounds`);
            for (const key of mk.tileKeys()) {
                const t = mk.tileAt(key & 0xFFFF, key >>> 16);
                const ext = plainExtent(t);
                assert.ok(ext, `${what}: tile ${key} kept with nothing in it`);
                if (t.extVersion === t.version) assert.deepEqual(t.ext, ext, `${what}: tile ${key}'s cached extent`);
            }
            checked++;
        }
        calls[route] = K.pxCalls(true).sel_combine || 0;
    }
    // the colour as a tile's bytes stored it before K5 (a Uint8ClampedArray: 127.5 -> 128, 300 -> 255, -1 -> 0), on the
    // kernel's path (a bytes source), on the fill's (a rect over the image) and in invert, on both routes
    const colours = [[127.5, 0, 0], [255, 300, 0], [-1, 0, 0], [0.4, 254.6, 1e9]];
    for (const route of ["js", "rust"]) {
        K.setKernels("rust");
        K.setRoute("selCombine", route);
        const ways = [["bytes", (mk, c) => mk.combine(bytesSource(whole, 0, 0, W, H), "replace", c)],
            ["a rect", (mk, c) => mk.combine(rectSource([0, 0, W, H]), "add", c)], ["invert", (mk, c) => mk.invert(c)]];
        for (const [how, apply] of ways) for (const colour of colours) {
            const want = Array.from(Uint8ClampedArray.of(colour[0], colour[1], colour[2]));
            const mk = new TileMaskPixels(W, H);
            apply(mk, colour);
            const d = mk.readRect(0, 0, W, H).data;
            let covered = 0;
            for (let p = 0; p < W * H; p++) {
                if (!d[p * 4 + 3]) continue;
                covered++;
                for (let c = 0; c < 3; c++) if (d[p * 4 + c] !== want[c]) assert.fail(`${route}: ${how} in ${JSON.stringify(colour)}: (${p % W}, ${Math.floor(p / W)}) channel ${c} is ${d[p * 4 + c]}, a clamped tile has ${want[c]}`);
            }
            assert.ok(covered > 1000, `${route}: ${how} in ${JSON.stringify(colour)} covered ${covered} pixels`);
        }
    }
    console.log("  [ok] K5: a fractional or out-of-range colour lands clamped and rounded per channel (combine on both paths, invert)");
    // a view is whole pixels or none: a fractional origin or region start leaves the region to `read`, as bytesSource
    assert.equal(tilesSource(mixed, [0.5, 0]).view(0, 0, 16, 16), null, "tilesSource.view at a fractional origin");
    assert.equal(tilesSource(mixed, [0, 0]).view(0, 0.5, 16, 16), null, "tilesSource.view of a fractional region");
    assert.equal(bytesSource(small, 230.5, 210, 150, 150).view(256, 256, 16, 16), null, "bytesSource.view at a fractional origin");
    assert.equal(tilesSource(mixed, [0, 0]).view(0, 0, 16, 16).kind, 1, "tilesSource.view of an alpha tile");
    // inside one source tile the view starts at the region's pixel of that tile (the combine itself asks tile-aligned
    // regions only, so this is checked here)
    assert.equal(tilesSource(mixed, [0, 0]).view(16, 32, 8, 8).off, 32 * 256 + 16, "tilesSource.view's offset");
    assert.equal(tilesSource(mixed, [100, 37]).view(100 + 256 + 5, 37 + 7, 8, 8).off, 7 * 256 + 5, "tilesSource.view's offset off the grid");
    assert.equal(tilesSource(mixed, [0, 0]).view(250, 0, 8, 8), null, "tilesSource.view across two source tiles");
    console.log("  [ok] K5: views refuse a fractional origin or region and one across two source tiles (read takes them); their offsets");
    // the extent cache (K5): every tile the combine writes carries its extent (kernel path and fill path, new tiles), so
    // bounds() scans none of them
    for (const route of ["js", "rust"]) {
        K.setKernels("rust");
        K.setRoute("selCombine", route);
        for (const [how, make] of [["bytes", () => bytesSource(whole, 0, 0, W, H)], ["tiles", () => tilesSource(mixed, [0, 0], [0, 0, W, H])], ["a rect", () => rectSource([0, 0, W, H])]]) {
            const mk = new TileMaskPixels(W, H);
            mk.combine(make(), "add");
            let n = 0;
            for (const key of mk.tileKeys()) {
                const t = mk.tileAt(key & 0xFFFF, key >>> 16);
                assert.equal(t.extVersion, t.version, `${route}: add of ${how}: tile ${key} has no fresh extent`);
                n++;
            }
            assert.ok(n > 0, `${route}: add of ${how} kept no tile`);
        }
    }
    console.log("  [ok] K5: each tile the combine writes keeps a fresh extent (both routes, the kernel and the fill)");
    K.setRoute("selCombine", null);
    K.setKernels("js");
    assert.equal(calls.js, 0, "the selCombine route js called sel_combine");
    assert.ok(calls.rust > 0, "the selCombine route rust never called sel_combine");
    console.log(`  [ok] K5: TileMaskPixels.combine on the routes js and rust equals the per-pixel model (${checked} combines; sel_combine ${calls.rust} calls on rust, 0 on js), cached extents and bounds exact`);
}

// ---------------------------------------------------------------------------
// 13. K11: TileMaskPixels.invert on both routes of maskInvert and deferred writable copy
// ---------------------------------------------------------------------------
{
    const K = await import("../renderer/editor/px/kernels.js");
    const W = 540, H = 530;   // 3 x 3 tiles, with 28 px right and 18 px bottom partial edge tiles
    const invModel = (m, color = [255, 0, 0]) => {
        const [cr, cg, cb] = Uint8ClampedArray.of(color[0], color[1], color[2]);
        for (let i = 0; i < m.length; i += 4) {
            const a = 255 - m[i + 3];
            if (a) { m[i] = cr; m[i + 1] = cg; m[i + 2] = cb; m[i + 3] = a; }
            else { m[i] = 0; m[i + 1] = 0; m[i + 2] = 0; m[i + 3] = 0; }
        }
    };
    const modelBounds = (m) => {
        let x0 = W, y0 = H, x1 = -1, y1 = -1;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            if (!m[(y * W + x) * 4 + 3]) continue;
            if (x < x0) x0 = x;
            if (y < y0) y0 = y;
            if (x > x1) x1 = x;
            if (y > y1) y1 = y;
        }
        return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
    };
    const soft = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        soft[y * W + x] = (x >= 256 && x < 512 && y >= 256 && y < 512) ? 255
            : (x < 256 && y < 256) ? 0
            : ((x * 13 + y * 29) % 256);
    }

    const invCalls = { js: 0, rust: 0 };
    for (const route of ["js", "rust"]) {
        K.setKernels("rust");
        K.setRoute("maskInvert", route);
        for (const color of [[255, 0, 0], [255, 255, 255], [12.4, 300, -5]]) {
            const mk = new TileMaskPixels(W, H);
            const mod = new Uint8ClampedArray(W * H * 4);
            // 1) empty -> full
            K.pxCalls(true);
            mk.invert(color);
            invModel(mod, color);
            assert.equal(K.pxCalls(true).mask_invert || 0, 0, `${route}: empty invert has no existing tiles to call mask_invert on`);
            assert.deepEqual(Array.from(mk.readRect(0, 0, W, H).data), Array.from(mod), `${route}: empty -> full pixels`);
            assert.deepEqual(mk.bounds(), modelBounds(mod), `${route}: empty -> full bounds`);
            for (const key of mk.tileKeys()) {
                const t = mk.tileAt(key & 0xFFFF, key >>> 16);
                assert.equal(t.extVersion, t.version, `${route}: empty -> full tile ${key} fresh extent`);
            }
            // 2) full (frozen via clone, as pushUndo before invertSelectionNow does) -> empty
            const snapFull = mk.clone();
            const fullBytes = mk.readRect(0, 0, W, H).data.slice();
            let writablesOnFull = 0;
            const origWritable = mk.writable;
            mk.writable = function (...a) { writablesOnFull++; return origWritable.apply(this, a); };
            K.pxCalls(true);
            mk.invert(color);
            mk.writable = origWritable;
            invModel(mod, color);
            const cFull = K.pxCalls(true).mask_invert || 0;
            invCalls[route] += cFull;
            assert.equal(cFull, route === "rust" ? 9 : 0, `${route}: full -> empty mask_invert calls`);
            if (route === "rust") assert.equal(writablesOnFull, 0, "rust route skips writable() when an inverted tile becomes empty");
            assert.equal(mk.tileKeys().length, 0, `${route}: full -> empty drops all tiles`);
            assert.equal(mk.bounds(), null, `${route}: full -> empty bounds`);
            assert.deepEqual(Array.from(snapFull.readRect(0, 0, W, H).data), Array.from(fullBytes), `${route}: frozen clone intact after full -> empty`);

            // 3) mixed soft + full + empty tiles (frozen via clone) -> inverted, then inverted back
            mk.combine(bytesSource(soft, 0, 0, W, H), "replace", color);
            mod.set(mk.readRect(0, 0, W, H).data);
            const snapMixed = mk.clone();
            const mixedBytes = mod.slice();
            const hadCount = mk.tileKeys().length;
            let wholeArgs = [];
            mk.writable = function (tx, ty, create = true, whole = false) {
                wholeArgs.push({ tx, ty, whole: !!whole });
                return origWritable.call(this, tx, ty, create, whole);
            };
            K.pxCalls(true);
            mk.invert(color);
            mk.writable = origWritable;
            invModel(mod, color);
            const cMixed = K.pxCalls(true).mask_invert || 0;
            invCalls[route] += cMixed;
            assert.equal(cMixed, route === "rust" ? hadCount : 0, `${route}: mixed mask_invert calls`);
            if (route === "rust") {
                // tile (1, 1) was all 255 so it was dropped without calling writable; interior tiles (0, 0), (1, 0), (0, 1) had whole=true
                assert.equal(wholeArgs.some((w) => w.tx === 1 && w.ty === 1), false, "rust route did not call writable on tile (1,1) that inverted to empty");
                for (const w of wholeArgs) {
                    if (w.tx > 0 && w.tx < 2 && w.ty < 2) assert.equal(w.whole, true, `rust route passed whole=true on existing interior tile (${w.tx},${w.ty})`);
                }
            }
            assert.deepEqual(Array.from(mk.readRect(0, 0, W, H).data), Array.from(mod), `${route}: mixed invert pixels`);
            assert.deepEqual(mk.bounds(), modelBounds(mod), `${route}: mixed invert bounds`);
            assert.deepEqual(Array.from(snapMixed.readRect(0, 0, W, H).data), Array.from(mixedBytes), `${route}: frozen clone intact after mixed invert`);
            for (const key of mk.tileKeys()) {
                const t = mk.tileAt(key & 0xFFFF, key >>> 16);
                assert.equal(t.extVersion, t.version, `${route}: mixed invert tile ${key} fresh extent`);
            }
        }
    }
    K.setRoute("maskInvert", null);
    K.setKernels("js");
    assert.equal(invCalls.js, 0, "the maskInvert route js called mask_invert");
    assert.ok(invCalls.rust > 0, "the maskInvert route rust never called mask_invert");
    console.log(`  [ok] K11: TileMaskPixels.invert on the routes js and rust equals the per-pixel model (mask_invert ${invCalls.rust} calls on rust, 0 on js), frozen clones preserved, cached extents and bounds exact`);

    // (a) writable spy on a fresh invert() of a 300 x 270 mask and on combine's SEL_FULL fill:
    // tile [0,0] (256 x 256) gets whole = true; partial edge tiles [1,0] (44 x 256), [0,1] (256 x 14), [1,1] (44 x 14) get whole = false
    const W3 = 300, H3 = 270;
    const spyWhole = (apply) => {
        const mk = new TileMaskPixels(W3, H3);
        const origW = mk.writable;
        const calls = [];
        mk.writable = function (tx, ty, create = true, whole = false) {
            calls.push({ tx, ty, whole: !!whole });
            return origW.call(this, tx, ty, create, whole);
        };
        apply(mk);
        mk.writable = origW;
        return calls;
    };
    const wantWhole = [
        { tx: 0, ty: 0, whole: true },
        { tx: 1, ty: 0, whole: false },
        { tx: 0, ty: 1, whole: false },
        { tx: 1, ty: 1, whole: false },
    ];
    assert.deepEqual(spyWhole((mk) => mk.invert()), wantWhole, "fresh invert() of 300 x 270 passes whole=true only on [0,0] and false on [1,0], [0,1], [1,1]");
    assert.deepEqual(spyWhole((mk) => mk.combine(rectSource([0, 0, W3, H3]), "replace")), wantWhole, "combine SEL_FULL replace of 300 x 270 passes whole=true only on [0,0] and false on [1,0], [0,1], [1,1]");
    assert.deepEqual(spyWhole((mk) => mk.combine(rectSource([0, 0, W3, H3]), "add")), wantWhole, "combine SEL_FULL add of 300 x 270 passes whole=true only on [0,0] and false on [1,0], [0,1], [1,1]");

    // (b) a partial edge tile holding a pixel beyond the image (alpha 77), frozen by clone(), then a full-coverage
    // combine(rectSource([0, 0, W, H]), "replace"), asserting the beyond-image byte stays 77
    {
        const mk = new TileMaskPixels(W3, H3);
        const o10 = (5 * 256 + 100) * 4;    // x=100 >= bw=44 in [1,0]
        const o01 = (100 * 256 + 5) * 4;    // y=100 >= bh=14 in [0,1]
        const o11 = (100 * 256 + 100) * 4;  // x=100 >= bw=44, y=100 >= bh=14 in [1,1]
        const t10 = mk.writable(1, 0); t10.data[o10] = 255; t10.data[o10 + 3] = 77;
        const t01 = mk.writable(0, 1); t01.data[o01] = 255; t01.data[o01 + 3] = 77;
        const t11 = mk.writable(1, 1); t11.data[o11] = 255; t11.data[o11 + 3] = 77;
        const snap = mk.clone();
        mk.combine(rectSource([0, 0, W3, H3]), "replace");
        assert.equal(mk.tileAt(1, 0).data[o10 + 3], 77, "beyond-image pixel in frozen partial tile [1,0] stays 77 after full-coverage replace");
        assert.equal(mk.tileAt(0, 1).data[o01 + 3], 77, "beyond-image pixel in frozen partial tile [0,1] stays 77 after full-coverage replace");
        assert.equal(mk.tileAt(1, 1).data[o11 + 3], 77, "beyond-image pixel in frozen partial tile [1,1] stays 77 after full-coverage replace");
        assert.equal(mk.tileAt(1, 0).data[3], 255, "in-image pixel in [1,0] is filled to 255");
        assert.equal(snap.tileAt(1, 0).data[3], 0, "frozen clone's in-image pixel in [1,0] stays 0");
        assert.equal(snap.tileAt(1, 0).data[o10 + 3], 77, "frozen clone's beyond-image pixel in [1,0] stays 77");
    }

    // (c) arena reused slot zeroing (inpaint_arena.js `if (zero) bytes.fill(0)`): a reused slot is zeroed when zero=true
    // (fresh partial edge tiles) and skipped when zero=false (whole-tile overwrite)
    {
        const arenaMod = await import("../renderer/editor/inpaint_arena.js");
        const { allocTileBytes, setArenaEnabled } = arenaMod;
        const origCOI = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
        const OrigFR = globalThis.FinalizationRegistry;
        let releaseCb = null;
        const registered = [];
        globalThis.FinalizationRegistry = class {
            constructor(cb) { releaseCb = cb; }
            register(_target, held) { registered.push(held); }
        };
        Object.defineProperty(globalThis, "crossOriginIsolated", { value: true, configurable: true, writable: true });
        setArenaEnabled(true);
        try {
            // Allocate 4 slots, fill them with 99, and release them back to the arena's free stack so used_[slot] === 1
            for (let i = 0; i < 4; i++) {
                const b = allocTileBytes({}, true);
                b.fill(99);
            }
            assert.equal( typeof releaseCb, "function", "arena registered its FinalizationRegistry release callback");
            while (registered.length) releaseCb(registered.pop());

            // zero = false skips zeroing a reused slot; zero = true zeroes it
            const bKeep = allocTileBytes({}, false);
            const bZero = allocTileBytes({}, true);
            assert.equal(bKeep[0], 99, "allocTileBytes(owner, false) skips zeroing a reused arena slot");
            assert.equal(bZero[0], 0, "allocTileBytes(owner, true) zeroes a reused arena slot (first byte)");
            assert.equal(bZero[bZero.length - 1], 0, "allocTileBytes(owner, true) zeroes a reused arena slot (last byte)");
            bZero.fill(99);
            while (registered.length) releaseCb(registered.pop());

            // Fresh invert() of 300 x 270 on dirty reused arena slots: partial edge tiles [1,0], [0,1], [1,1] must be zeroed beyond bw x bh
            const mkArena = new TileMaskPixels(W3, H3);
            mkArena.invert();
            assert.equal(mkArena.tileAt(1, 0).data[(5 * 256 + 100) * 4 + 3], 0, "fresh invert() on reused arena slot zeroes [1,0] beyond bw");
            assert.equal(mkArena.tileAt(0, 1).data[(100 * 256 + 5) * 4 + 3], 0, "fresh invert() on reused arena slot zeroes [0,1] beyond bh");
            assert.equal(mkArena.tileAt(1, 1).data[(100 * 256 + 100) * 4 + 3], 0, "fresh invert() on reused arena slot zeroes [1,1] beyond bw x bh");
            while (registered.length) releaseCb(registered.pop());
        } finally {
            setArenaEnabled(false);
            globalThis.FinalizationRegistry = OrigFR;
            if (origCOI) Object.defineProperty(globalThis, "crossOriginIsolated", origCOI);
            else delete globalThis.crossOriginIsolated;
        }
    }
    console.log("  [ok] K11: whole guard on fresh invert() and combine SEL_FULL fill, frozen partial edge tile beyond-image preservation, and arena reused-slot zero guard");
}

    console.log("ALL TESTS PASSED!");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
