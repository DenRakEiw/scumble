"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

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

// Mock Canvas for MaskPixels in Node
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

async function main() {
    const rasterMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_raster.js")).href);
    const {
        rectSource, bytesSource, tilesSource, combineAlpha
    } = rasterMod;
    const tilesMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_tiles.js")).href);
    const { TileMaskPixels } = tilesMod;
    const pixelsMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_pixels.js")).href);
    const { MaskPixels } = pixelsMod;

    console.log("Running selection_test.js...");

    // 1. Rectangle intersect of [0, 0, 400, 400] with [200, 200, 600, 600]
    // Expect bounds [200, 200, 400, 400]
    for (const backend of ["tiles", "canvas"]) {
        const W = 800, H = 600;
        const sel = backend === "tiles" ? new TileMaskPixels(W, H) : new MaskPixels(new MockCanvas(W, H));

        // Initial rect [0, 0, 400, 400]
        sel.fill([0, 0, 400, 400], "#ff0000");
        assert.equal(sel.readRect(100, 100, 1, 1).data[3], 255, "inside initial rect");
        assert.equal(sel.readRect(500, 500, 1, 1).data[3], 0, "outside initial rect");

        // Intersect with [200, 200, 600, 600] via rectSource
        sel.combine(rectSource([200, 200, 600, 600]), "intersect");

        // Inside intersection [200, 200, 400, 400]
        assert.equal(sel.readRect(250, 250, 1, 1).data[3], 255, `${backend}: inside intersection`);
        assert.equal(sel.readRect(399, 399, 1, 1).data[3], 255, `${backend}: at edge of intersection`);

        // Outside intersection
        assert.equal(sel.readRect(100, 100, 1, 1).data[3], 0, `${backend}: outside (was in first rect only)`);
        assert.equal(sel.readRect(500, 500, 1, 1).data[3], 0, `${backend}: outside (in second rect only)`);
        assert.equal(sel.readRect(10, 10, 1, 1).data[3], 0, `${backend}: outside both`);

        // Compute actual bounds from readRect
        const data = sel.readRect(0, 0, W, H).data;
        let minX = W, minY = H, maxX = -1, maxY = -1;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                if (data[(y * W + x) * 4 + 3] > 0) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        assert.equal(minX, 200, `${backend}: minX should be 200`);
        assert.equal(minY, 200, `${backend}: minY should be 200`);
        assert.equal(maxX, 399, `${backend}: maxX should be 399`);
        assert.equal(maxY, 399, `${backend}: maxY should be 399`);
    }
    console.log("  [ok] rect intersect [0,0,400,400] with [200,200,600,600] gives [200,200,400,400] on both backends");

    // 2. Soft wand add over feathered selection keeping >= 200
    // If destination has a = 200, adding any source w in [0..255] must result in >= 200.
    for (let w = 0; w <= 255; w++) {
        const added = combineAlpha(200, w, "add");
        assert.ok(added >= 200, `soft add dropped: combineAlpha(200, ${w}, 'add') = ${added} < 200`);
    }

    // Now test with TileMaskPixels and MaskPixels
    for (const backend of ["tiles", "canvas"]) {
        const W = 100, H = 100;
        const sel = backend === "tiles" ? new TileMaskPixels(W, H) : new MaskPixels(new MockCanvas(W, H));

        // Set feathered pixel with alpha 200
        const initialAlpha = new Uint8Array(W * H);
        initialAlpha[50 * W + 50] = 200;
        sel.combine(bytesSource(initialAlpha, 0, 0, W, H), "replace");
        assert.equal(sel.readRect(50, 50, 1, 1).data[3], 200);

        // Wand source with lower alpha (e.g. 128)
        const wandAlpha = new Uint8Array(W * H);
        wandAlpha[50 * W + 50] = 128;
        sel.combine(bytesSource(wandAlpha, 0, 0, W, H), "add");

        const resultA = sel.readRect(50, 50, 1, 1).data[3];
        // 200 + 128 - 200*128/255 = 328 - 100 = 228
        assert.equal(resultA, 228, `${backend}: soft add should be 228, got ${resultA}`);
        assert.ok(resultA >= 200, `${backend}: soft add must not drop below 200`);
    }
    console.log("  [ok] soft wand add over feathered selection (alpha 200 + 128) yields 228 >= 200");

    // 3. Wand tilesSource in combine
    {
        const W = 512, H = 512;
        const tm = new TileMaskPixels(W, H);
        tm.fill([0, 0, 256, 256], "#ff0000");

        // Wand tile at tx=0, ty=0 with soft alpha
        const tileAlpha = new Uint8Array(256 * 256).fill(128);
        const tiles = [{ tx: 0, ty: 0, alpha: tileAlpha }];
        const src = tilesSource(tiles, [0, 0], [0, 0, 256, 256]);

        tm.combine(src, "intersect");
        const aVal = tm.readRect(100, 100, 1, 1).data[3];
        // 255 * 128 / 255 = 128
        assert.equal(aVal, 128, `intersect alpha: expected 128, got ${aVal}`);
    }
    console.log("  [ok] tilesSource combine with intersect works as expected");

    console.log("ALL SELECTION TESTS PASSED!");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
