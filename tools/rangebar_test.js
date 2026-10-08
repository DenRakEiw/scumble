// Range bar control and whole-picture histograms test suite (R1-S4)
// Run with: node tools/rangebar_test.js
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

// Set up minimal browser globals for importing renderer modules in Node
global.window = {
    devicePixelRatio: 1,
    scumble: {
        comfy: { onEvent: () => {} },
        helpers: { status: async () => ({ models: [] }) },
        log: { list: async () => [], file: async () => "" },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
};

function createMockElement(tag) {
    const listeners = {};
    let _w = 256, _h = 256;
    let px = new Uint8ClampedArray(_w * _h * 4);
    const el = {
        tagName: tag.toUpperCase(),
        className: "",
        style: {},
        get width() { return _w; },
        set width(v) { _w = Math.max(1, v | 0); px = new Uint8ClampedArray(_w * _h * 4); },
        get height() { return _h; },
        set height(v) { _h = Math.max(1, v | 0); px = new Uint8ClampedArray(_w * _h * 4); },
        get data() { return px; },
        classList: {
            add: () => {},
            remove: () => {},
            toggle: () => {},
        },
        appendChild: () => {},
        addEventListener: (ev, fn) => { listeners[ev] = fn; },
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 26 }),
        getContext: () => ({
            drawImage: (src) => {
                if (src && src.data) px.set(src.data.subarray(0, px.length));
            },
            getImageData: (x, y, gw, gh) => {
                const w = gw || _w, h = gh || _h;
                if (px.length === w * h * 4) return { data: px };
                return { data: px.subarray(0, w * h * 4) };
            },
            clearRect: () => {},
            save: () => {},
            restore: () => {},
            scale: () => {},
            fillRect: () => {},
            beginPath: () => {},
            moveTo: () => {},
            lineTo: () => {},
            closePath: () => {},
            stroke: () => {},
            fill: () => {},
            setLineDash: () => {},
            createLinearGradient: () => ({ addColorStop: () => {} }),
        }),
    };
    return el;
}

global.document = {
    createElement: createMockElement,
    getElementById: () => null,
    head: { appendChild: () => {} },
};

let passed = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`[ok] ${name}`);
        passed++;
    } catch (err) {
        console.error(`[FAIL] ${name}:`, err);
        process.exit(1);
    }
}

async function main() {
    const rangebarMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_rangebar.js")).href);
    const { hitTest, dragTo, buildRangeBar, RANGE_DEFAULTS } = rangebarMod;

    const filtersMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_filters.js")).href);
    const { colourStats } = filtersMod;

    const canvasMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_canvas.js")).href);
    const { InpaintEditor } = canvasMod;

    // ---------------------------------------------------------------------------
    // 1. hitTest priority and accuracy
    // ---------------------------------------------------------------------------

    test("hitTest: feather handle wins over box edge within tolerance", () => {
        // lo = 0.20, hi = 0.70, fLo = 0.05 (fLo handle at 0.15), fHi = 0.05 (fHi handle at 0.75)
        const range = { lo: 0.20, hi: 0.70, fLo: 0.05, fHi: 0.05, invert: false };
        const tol01 = 0.04;

        // x = 0.17 is dist 0.02 from fLo (0.15) and dist 0.03 from lo (0.20).
        // Both are within tol01 = 0.04. fLo MUST win over lo.
        assert.equal(hitTest(range, 0.17, tol01), "fLo", "fLo wins over lo within tolerance");

        // x = 0.73 is dist 0.02 from fHi (0.75) and dist 0.03 from hi (0.70).
        // Both are within tol01 = 0.04. fHi MUST win over hi.
        assert.equal(hitTest(range, 0.73, tol01), "fHi", "fHi wins over hi within tolerance");
    });

    test("hitTest: handles, box interior and outside detection", () => {
        const range = { lo: 0.20, hi: 0.70, fLo: 0.05, fHi: 0.05, invert: false };
        const tol01 = 0.02;

        // Direct hits on handles
        assert.equal(hitTest(range, 0.15, tol01), "fLo");
        assert.equal(hitTest(range, 0.20, tol01), "lo");
        assert.equal(hitTest(range, 0.70, tol01), "hi");
        assert.equal(hitTest(range, 0.75, tol01), "fHi");

        // Inside box
        assert.equal(hitTest(range, 0.45, tol01), "box");
        assert.equal(hitTest(range, 0.30, tol01), "box");

        // Outside
        assert.equal(hitTest(range, 0.05, tol01), null);
        assert.equal(hitTest(range, 0.90, tol01), null);
        assert.equal(hitTest(null, 0.5, tol01), null);
    });

    // ---------------------------------------------------------------------------
    // 2. dragTo invariants (lo <= hi, box width preservation, feathers >= 0)
    // ---------------------------------------------------------------------------

    test("dragTo: lo <= hi invariant is strictly preserved", () => {
        const startRange = { lo: 0.25, hi: 0.60, fLo: 0.05, fHi: 0.05, invert: false };

        // Dragging lo past hi clamps at hi
        const dragLoPastHi = dragTo(startRange, "lo", 0.85, startRange);
        assert.equal(dragLoPastHi.lo, 0.60);
        assert.equal(dragLoPastHi.hi, 0.60);
        assert.ok(dragLoPastHi.lo <= dragLoPastHi.hi);

        // Dragging lo below 0 clamps at 0
        const dragLoBelowZero = dragTo(startRange, "lo", -0.15, startRange);
        assert.equal(dragLoBelowZero.lo, 0);
        assert.equal(dragLoBelowZero.hi, 0.60);
        assert.ok(dragLoBelowZero.lo <= dragLoBelowZero.hi);

        // Dragging hi before lo clamps at lo
        const dragHiBeforeLo = dragTo(startRange, "hi", 0.10, startRange);
        assert.equal(dragHiBeforeLo.hi, 0.25);
        assert.equal(dragHiBeforeLo.lo, 0.25);
        assert.ok(dragHiBeforeLo.lo <= dragHiBeforeLo.hi);

        // Dragging hi above 1 clamps at 1
        const dragHiAboveOne = dragTo(startRange, "hi", 1.25, startRange);
        assert.equal(dragHiAboveOne.hi, 1.0);
        assert.equal(dragHiAboveOne.lo, 0.25);
        assert.ok(dragHiAboveOne.lo <= dragHiAboveOne.hi);
    });

    test("dragTo: box drag strictly preserves width (hi - lo)", () => {
        const startRange = { lo: 0.20, hi: 0.50, fLo: 0.05, fHi: 0.05, invert: false };
        const w = startRange.hi - startRange.lo; // 0.30

        // Normal box translation
        const mid = dragTo(startRange, "box", 0.45, startRange, 0.35); // dx = +0.10
        assert.equal(Math.round(mid.lo * 100) / 100, 0.30);
        assert.equal(Math.round(mid.hi * 100) / 100, 0.60);
        assert.equal(Math.round((mid.hi - mid.lo) * 1000) / 1000, w);

        // Box drag clamped at left boundary (0)
        const left = dragTo(startRange, "box", 0.10, startRange, 0.35); // dx = -0.25
        assert.equal(left.lo, 0);
        assert.equal(Math.round(left.hi * 1000) / 1000, w);
        assert.equal(Math.round((left.hi - left.lo) * 1000) / 1000, w);

        // Box drag clamped at right boundary (1)
        const right = dragTo(startRange, "box", 0.95, startRange, 0.35); // dx = +0.60
        assert.equal(right.hi, 1.0);
        assert.equal(Math.round(right.lo * 1000) / 1000, 1.0 - w);
        assert.equal(Math.round((right.hi - right.lo) * 1000) / 1000, w);
    });

    test("dragTo: feathers never go negative", () => {
        const startRange = { lo: 0.40, hi: 0.70, fLo: 0.05, fHi: 0.05, invert: false };

        // Normal fLo drag
        const fLoNormal = dragTo(startRange, "fLo", 0.25, startRange);
        assert.equal(Math.round(fLoNormal.fLo * 100) / 100, 0.15);
        assert.ok(fLoNormal.fLo >= 0);

        // Drag fLo to the right of lo (would be negative without clamp)
        const fLoPastLo = dragTo(startRange, "fLo", 0.55, startRange);
        assert.equal(fLoPastLo.fLo, 0);
        assert.ok(fLoPastLo.fLo >= 0);

        // Normal fHi drag
        const fHiNormal = dragTo(startRange, "fHi", 0.90, startRange);
        assert.equal(Math.round(fHiNormal.fHi * 100) / 100, 0.20);
        assert.ok(fHiNormal.fHi >= 0);

        // Drag fHi to the left of hi (would be negative without clamp)
        const fHiBeforeHi = dragTo(startRange, "fHi", 0.50, startRange);
        assert.equal(fHiBeforeHi.fHi, 0);
        assert.ok(fHiBeforeHi.fHi >= 0);
    });

    // ---------------------------------------------------------------------------
    // 3. colourStats alpha-weighted histogram sum
    // ---------------------------------------------------------------------------

    function makeTestCanvas(w, h, fillFn) {
        const px = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                const [r, g, b, a] = fillFn(x, y);
                px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
            }
        }
        return {
            width: w,
            height: h,
            data: px,
            getContext: () => ({
                drawImage: (src) => {
                    if (src && src.data) px.set(src.data.subarray(0, px.length));
                },
                getImageData: () => ({ data: px }),
            }),
        };
    }

    test("colourStats: returns { mean, lo, hi, hist: { r, g, b, luma }, bytes, w, h }", () => {
        let expectedWsum = 0;
        const testSrc = makeTestCanvas(64, 64, (x, y) => {
            const r = (x * 4) % 256;
            const g = (y * 4) % 256;
            const b = ((x + y) * 2) % 256;
            const a = (x + y) % 3 === 0 ? 0 : (x % 2 === 0 ? 255 : 128);
            if (a > 0) expectedWsum += a / 255;
            return [r, g, b, a];
        });

        const stats = colourStats(testSrc);
        assert.ok(stats.hist, "hist must exist");
        assert.ok(stats.hist.r instanceof Float64Array, "hist.r must be Float64Array");
        assert.ok(stats.hist.g instanceof Float64Array, "hist.g must be Float64Array");
        assert.ok(stats.hist.b instanceof Float64Array, "hist.b must be Float64Array");
        assert.ok(stats.hist.luma instanceof Float64Array, "hist.luma must be Float64Array");
        assert.equal(stats.hist.r.length, 256);
        assert.equal(stats.hist.luma.length, 256);

        // Sum of all 4 histograms must match expected alpha-weighted sum
        const sumR = stats.hist.r.reduce((a, b) => a + b, 0);
        const sumG = stats.hist.g.reduce((a, b) => a + b, 0);
        const sumB = stats.hist.b.reduce((a, b) => a + b, 0);
        const sumLuma = stats.hist.luma.reduce((a, b) => a + b, 0);

        assert.ok(Math.abs(sumR - expectedWsum) < 1e-4, `sumR (${sumR}) must equal expected (${expectedWsum})`);
        assert.ok(Math.abs(sumG - expectedWsum) < 1e-4, "sumG must equal expected");
        assert.ok(Math.abs(sumB - expectedWsum) < 1e-4, "sumB must equal expected");
        assert.ok(Math.abs(sumLuma - expectedWsum) < 1e-4, "sumLuma must equal expected");

        // Bytes and dimensions
        assert.ok(stats.bytes instanceof Uint8ClampedArray, "bytes must be Uint8ClampedArray");
        assert.equal(stats.w, 64);
        assert.equal(stats.h, 64);
        assert.equal(stats.bytes.length, 64 * 64 * 4);
    });

    // ---------------------------------------------------------------------------
    // 4. InpaintEditor: pictureHistogram, pictureSample, mapHistogram, belowHistogram
    // ---------------------------------------------------------------------------

    test("InpaintEditor: mapHistogram caches 256 bins for depth and clears in dropCompositeCaches", () => {
        const editor = Object.create(InpaintEditor.prototype);
        editor.compositeVersion = 1;
        editor.uploaded = { baseHash: "b1", controlHash: "c1" };
        editor.objectShapeCache = new Map();

        // No depth map initially
        editor.depth = null;
        assert.equal(editor.mapHistogram("depth"), null);

        // 16-bit depth map with 4 sample values
        const u16 = new Uint16Array([
            0,       // >> 8 = 0
            256,     // >> 8 = 1
            512,     // >> 8 = 2
            65535,   // >> 8 = 255
        ]);
        editor.depth = { u16, hash: "depth-hash-1", w: 2, h: 2 };

        const hist1 = editor.mapHistogram("depth");
        assert.ok(hist1 instanceof Float64Array);
        assert.equal(hist1.length, 256);
        assert.equal(hist1[0], 1);
        assert.equal(hist1[1], 1);
        assert.equal(hist1[2], 1);
        assert.equal(hist1[255], 1);
        assert.equal(hist1[3], 0);

        // Repeated call returns cached array
        const hist2 = editor.mapHistogram("depth");
        assert.equal(hist1, hist2, "mapHistogram must return cached instance");

        // dropCompositeCaches clears the cache
        editor.dropCompositeCaches();
        assert.equal(editor._mapHistCache.size, 0, "_mapHistCache should be cleared");

        // Re-evaluates after drop
        const hist3 = editor.mapHistogram("depth");
        assert.notEqual(hist1, hist3, "new histogram instance created after dropCompositeCaches");
        assert.equal(hist3[0], 1);
    });

    test("InpaintEditor: pictureHistogram and pictureSample return 256 px sampled data", () => {
        const editor = Object.create(InpaintEditor.prototype);
        editor.width = 512;
        editor.height = 512;
        editor.compositeVersion = 1;
        editor.layers = [];
        editor.uploaded = { baseHash: "b1", controlHash: "c1" };
        editor.objectShapeCache = new Map();

        const sampleCanvas = makeTestCanvas(256, 256, () => [120, 140, 160, 255]);
        editor.sampleRegion = () => sampleCanvas;

        const hist = editor.pictureHistogram(true);
        assert.ok(hist, "pictureHistogram returned value");
        assert.ok(hist.r instanceof Float64Array);
        assert.ok(hist.luma instanceof Float64Array);

        const sample = editor.pictureSample(true);
        assert.ok(sample, "pictureSample returned value");
        assert.ok(sample.bytes instanceof Uint8ClampedArray);
        assert.equal(sample.w, 256);
        assert.equal(sample.h, 256);

        // Verify caching per compositeVersion
        const statsRef = editor._picStatsRun;
        assert.ok(statsRef);
        assert.equal(editor.pictureStats(true), statsRef.stats);

        // Invalidate on dropCompositeCaches
        editor.dropCompositeCaches();
        assert.equal(editor._picStatsRun, null, "_picStatsRun must be cleared");
    });

    test("InpaintEditor: belowHistogram and belowSample return statistics below filter layer", () => {
        const editor = Object.create(InpaintEditor.prototype);
        editor.width = 256;
        editor.height = 256;
        editor.compositeVersion = 1;

        const layer1 = { id: 1, name: "Base" };
        const layer2 = { id: 2, name: "Filter", filter: "curves" };
        editor.layers = [layer1, layer2];
        editor.uploaded = { baseHash: "b1", controlHash: "c1" };
        editor.objectShapeCache = new Map();

        const sampleCanvas = makeTestCanvas(128, 128, () => [200, 100, 50, 255]);
        editor.sampleRegion = () => sampleCanvas;

        const hist = editor.belowHistogram(layer2, false);
        assert.ok(hist, "belowHistogram returned value");
        assert.ok(hist.r instanceof Float64Array);
        assert.ok(hist.luma instanceof Float64Array);

        const sample = editor.belowSample(layer2, false);
        assert.ok(sample, "belowSample returned value");
        assert.ok(sample.bytes instanceof Uint8ClampedArray);
        assert.equal(sample.w, 128);
        assert.equal(sample.h, 128);
    });

    // ---------------------------------------------------------------------------
    // 5. buildRangeBar DOM smoke test
    // ---------------------------------------------------------------------------

    test("buildRangeBar: creates DOM control with set() and refresh()", () => {
        let previewCalled = false;
        let commitCalled = false;
        const bar = buildRangeBar(RANGE_DEFAULTS, {
            gradient: "luma",
            title: "Luminosity",
            preview: () => { previewCalled = true; },
            commit: () => { commitCalled = true; },
        });

        assert.ok(bar.el, "bar.el must be created");
        assert.equal(typeof bar.set, "function", "bar.set must be a function");
        assert.equal(typeof bar.refresh, "function", "bar.refresh must be a function");

        bar.set({ lo: 0.1, hi: 0.4 });
        bar.refresh();
    });

    console.log(`\nAll ${passed} tests passed!`);
}

main().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});
