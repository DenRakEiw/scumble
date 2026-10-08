/**
 * Selection combine test (PLAN_NIK9_BUILD.md §F4a).
 * Tests SEL_MODES, mul255, combineAlpha, combineRows, selModeOf, selectionGco,
 * rectSource, bytesSource, tilesSource, and MaskPixels / TileMaskPixels combine.
 *
 * Usage: node tools/combine_test.js
 */
import assert from "node:assert/strict";

// In Node, provide minimal canvas creation and ImageData for probeColor and readRect
if (typeof ImageData === "undefined") {
    globalThis.ImageData = class ImageData {
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
}

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

import {
    SEL_MODES, mul255, combineAlpha, combineRows, selModeOf, selectionGco,
    rectSource, bytesSource, tilesSource
} from "../renderer/editor/inpaint_raster.js";
import { TileMaskPixels } from "../renderer/editor/inpaint_tiles.js";
import { MaskPixels } from "../renderer/editor/inpaint_pixels.js";

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

console.log("ALL TESTS PASSED!");
