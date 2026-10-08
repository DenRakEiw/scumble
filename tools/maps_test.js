"use strict";
/* global document */

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

if (typeof window === "undefined") {
    global.window = {
        scumble: {
            comfy: { onEvent: () => {} },
            helpers: { free: async () => {} },
        },
        addEventListener: () => {},
        removeEventListener: () => {},
    };
}

if (typeof document === "undefined") {
    global.document = {
        createElement: (tag) => {
            if (tag === "canvas") {
                return {
                    width: 0,
                    height: 0,
                    getContext: () => ({
                        fillStyle: "",
                        globalAlpha: 1,
                        globalCompositeOperation: "source-over",
                        fillRect: () => {},
                        clearRect: () => {},
                        setTransform: () => {},
                        save: () => {},
                        restore: () => {},
                        drawImage: () => {},
                        getImageData: (x, y, w, h) => ({
                            data: new Uint8ClampedArray(w * h * 4),
                        }),
                    }),
                };
            }
            return {};
        },
    };
}

async function main() {
    console.log("Running maps_test.js...");

    const hostModule = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "host.js")).href);
    const host = hostModule.default || hostModule.host;
    const canvasModule = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_canvas.js")).href);
    const InpaintEditor = canvasModule.InpaintEditor;

    // 1. host.pictureInput interface and call paths
    assert.strictEqual(typeof host.pictureInput, "function", "host.pictureInput is a function");

    let flattenOpts = null;
    let sampleRegionSettledOpts = null;
    const mockCanvas = document.createElement("canvas");

    const fakeCanvasEd = {
        width: 1200,
        height: 800,
        tileMode: false,
        flattenToCanvas: (opts) => {
            flattenOpts = opts;
            return mockCanvas;
        },
    };

    // Test on canvas backend with skipFilters: true (default)
    flattenOpts = null;
    const res1 = await host.pictureInput(fakeCanvasEd, 512, 341);
    assert.strictEqual(res1.width, 512);
    assert.strictEqual(res1.height, 341);
    assert.strictEqual(res1.image.length, 512 * 341 * 4);
    assert.ok(flattenOpts, "flattenToCanvas was called");
    assert.strictEqual(flattenOpts.forRun, true);
    assert.strictEqual(flattenOpts.skipFilters, true);

    // Test on canvas backend with skipFilters: false
    flattenOpts = null;
    await host.pictureInput(fakeCanvasEd, 512, 341, { skipFilters: false });
    assert.ok(flattenOpts, "flattenToCanvas was called");
    assert.strictEqual(flattenOpts.skipFilters, false);

    // Test on tiles backend
    const fakeTilesEd = {
        width: 1200,
        height: 800,
        tileMode: true,
        sampleRegionSettled: async (source, box, scale, opts) => {
            sampleRegionSettledOpts = { source, box, scale, opts };
            return mockCanvas;
        },
    };

    sampleRegionSettledOpts = null;
    const res2 = await host.pictureInput(fakeTilesEd, 512, 341, { skipFilters: true, background: "#000000" });
    assert.strictEqual(res2.width, 512);
    assert.strictEqual(res2.height, 341);
    assert.ok(sampleRegionSettledOpts, "sampleRegionSettled was called");
    assert.strictEqual(sampleRegionSettledOpts.source, "image");
    assert.deepStrictEqual(sampleRegionSettledOpts.box, [0, 0, 1200, 800]);
    assert.strictEqual(sampleRegionSettledOpts.opts.forRun, true);
    assert.strictEqual(sampleRegionSettledOpts.opts.skipFilters, true);

    console.log("  [ok] host.pictureInput works on both canvas and tiles backends with options");

    const tilesModule = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_tiles.js")).href);
    const { TileLayerPixels, TileMaskPixels } = tilesModule;

    // 2. passStores, clipTargetOf and skipFilters branch consistency
    const makeTileLayerPx = (w, h) => TileLayerPixels.empty(w, h);
    const makeTileMaskPx = (w, h) => TileMaskPixels.empty(w, h);

    const basePx = makeTileLayerPx(1000, 800);
    const layer1Px = makeTileLayerPx(1000, 800);
    const filterMaskPx = makeTileMaskPx(1000, 800);
    const clippedPx = makeTileLayerPx(400, 400);

    const layer1 = { id: 1, name: "baseLayer", kind: "paint", px: layer1Px, x: 0, y: 0, w: 1000, h: 800, visible: true };
    const filterLayer = { id: 2, name: "levelsFilter", kind: "filter", filter: "levels", maskPx: filterMaskPx, px: makeTileLayerPx(1000, 800), x: 0, y: 0, w: 1000, h: 800, visible: true };
    const clippedLayer = { id: 3, name: "clippedLayer", kind: "paint", clip: true, px: clippedPx, x: 10, y: 10, w: 400, h: 400, visible: true };

    const ed = {
        width: 1000,
        height: 800,
        tileMode: true,
        basePx,
        tileLevel: () => 0,
        shown: (l) => l.visible !== false,
        isControl: () => false,
        isReference: () => false,
        matchActive: () => false,
        liveStrokeOn: () => false,
        liveMask: (l) => l.maskPx,
        tileMaskOf: () => true,
        matchFromTiles: () => false,
        clipTargetOf: InpaintEditor.prototype.clipTargetOf,
        clipBaseOf: InpaintEditor.prototype.clipBaseOf,
        passStores: InpaintEditor.prototype.passStores,
        layers: [layer1, filterLayer, clippedLayer],
    };

    // Check clipTargetOf and clipBaseOf
    assert.strictEqual(ed.clipTargetOf(layer1), null, "unclipped layer has no clip target");
    assert.strictEqual(ed.clipTargetOf(clippedLayer), filterLayer, "clipped layer targets filterLayer");
    assert.strictEqual(ed.clipBaseOf(clippedLayer), null, "clipBaseOf returns null for filter target (no-clip effect)");

    // Test passStores with skipFilters: false
    const storesAll = ed.passStores("image", [0, 0, 1000, 800], 1, { forRun: true, skipFilters: false });
    // Should have: basePx, layer1Px, filterMaskPx, clippedPx
    const hasFilterStore = storesAll.some((s) => s.px === filterMaskPx);
    const hasClippedStore = storesAll.some((s) => s.px === clippedPx);
    assert.ok(hasFilterStore, "stores with skipFilters: false includes filter mask store");
    assert.ok(hasClippedStore, "stores with skipFilters: false includes layer clipped to filter");

    // Test passStores with skipFilters: true
    const storesSkip = ed.passStores("image", [0, 0, 1000, 800], 1, { forRun: true, skipFilters: true });
    const hasFilterStoreSkipped = storesSkip.some((s) => s.px === filterMaskPx);
    const hasClippedStoreSkipped = storesSkip.some((s) => s.px === clippedPx);
    assert.strictEqual(hasFilterStoreSkipped, false, "stores with skipFilters: true omits filter mask store");
    assert.strictEqual(hasClippedStoreSkipped, false, "stores with skipFilters: true omits layer clipped to skipped filter");

    // Compare with filterLayer hidden (visible: false)
    filterLayer.visible = false;
    const storesHidden = ed.passStores("image", [0, 0, 1000, 800], 1, { forRun: true, skipFilters: false });
    filterLayer.visible = true; // restore

    assert.strictEqual(storesSkip.length, storesHidden.length, "skipFilters store count matches filter hidden store count");
    for (let i = 0; i < storesSkip.length; i++) {
        assert.strictEqual(storesSkip[i].px, storesHidden[i].px, `store ${i} matches`);
    }

    console.log("  [ok] passStores with skipFilters: true names no store the pass does not draw");

    // 3. drawComposite hasFilters calculation
    let drawLayersOpts = null;
    const drawCompositeEd = {
        base: true,
        width: 500,
        height: 400,
        viewPass: null,
        layers: [layer1, filterLayer],
        shown: (l) => l.visible !== false,
        matchActive: () => false,
        drawComposite: InpaintEditor.prototype.drawComposite,
        drawLayersInto: (ctx, opts) => { drawLayersOpts = opts; },
    };

    // When only filter layer is present, skipFilters: true sets hasFilters to false -> direct drawLayersInto without flatCanvas
    drawLayersOpts = null;
    drawCompositeEd.flatCanvas = null;
    drawCompositeEd.drawComposite({}, { skipFilters: true });
    assert.ok(drawLayersOpts, "drawLayersInto called directly without flatCanvas when skipFilters is true");
    assert.strictEqual(drawCompositeEd.flatCanvas, null, "flatCanvas is null when only filter layer is present with skipFilters: true");

    // When colour match is active, hasFilters remains true even with skipFilters: true
    drawCompositeEd.matchActive = (l) => l.id === 1;
    drawCompositeEd.drawComposite({ drawImage: () => {} }, { skipFilters: true });
    assert.ok(drawCompositeEd.flatCanvas !== null, "colour-matched layers still trigger offscreen flatCanvas when skipFilters: true");

    console.log("  [ok] drawComposite ignores filter layers for hasFilters when skipFilters is set, keeping colour-matched layers");

    console.log("ALL MAPS TESTS PASSED!");
}

main().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});
