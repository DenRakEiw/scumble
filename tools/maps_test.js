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
                const canvas = {
                    width: 0,
                    height: 0,
                    _imgData: null,
                    getContext: () => ({
                        fillStyle: "",
                        globalAlpha: 1,
                        globalCompositeOperation: "source-over",
                        imageSmoothingEnabled: true,
                        imageSmoothingQuality: "high",
                        fillRect: () => {},
                        clearRect: () => {},
                        setTransform: () => {},
                        save: () => {},
                        restore: () => {},
                        drawImage: () => {},
                        createImageData: (w, h) => ({
                            width: w,
                            height: h,
                            data: new Uint8ClampedArray(w * h * 4),
                        }),
                        putImageData: (imgData) => {
                            canvas._imgData = imgData;
                        },
                        getImageData: (x, y, w, h) => {
                            if (canvas._imgData && canvas._imgData.width === w && canvas._imgData.height === h) {
                                return canvas._imgData;
                            }
                            return {
                                width: w,
                                height: h,
                                data: new Uint8ClampedArray(w * h * 4),
                            };
                        },
                    }),
                };
                return canvas;
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
    const mapsModule = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_maps.js")).href);
    const {
        makeMap, packRG16, unpackRG16, rg8View, mapToJSON, mapFromJSON, passToMap, sampleMap,
        fingerprint, fingerprintDiff, snapXf,
    } = mapsModule;
    const resampleModule = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_resample.js")).href);
    const { xfMul, xfInv, xfScale, xfTranslate, xfRotate, xfApply } = resampleModule;

    // =========================================================================
    // 1. host.pictureInput interface and call paths (F5)
    // =========================================================================
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

    // =========================================================================
    // 2. passStores, clipTargetOf and skipFilters branch consistency (F5)
    // =========================================================================
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

    assert.strictEqual(ed.clipTargetOf(layer1), null, "unclipped layer has no clip target");
    assert.strictEqual(ed.clipTargetOf(clippedLayer), filterLayer, "clipped layer targets filterLayer");
    assert.strictEqual(ed.clipBaseOf(clippedLayer), null, "clipBaseOf returns null for filter target (no-clip effect)");

    const storesAll = ed.passStores("image", [0, 0, 1000, 800], 1, { forRun: true, skipFilters: false });
    const hasFilterStore = storesAll.some((s) => s.px === filterMaskPx);
    const hasClippedStore = storesAll.some((s) => s.px === clippedPx);
    assert.ok(hasFilterStore, "stores with skipFilters: false includes filter mask store");
    assert.ok(hasClippedStore, "stores with skipFilters: false includes layer clipped to filter");

    const storesSkip = ed.passStores("image", [0, 0, 1000, 800], 1, { forRun: true, skipFilters: true });
    const hasFilterStoreSkipped = storesSkip.some((s) => s.px === filterMaskPx);
    const hasClippedStoreSkipped = storesSkip.some((s) => s.px === clippedPx);
    assert.strictEqual(hasFilterStoreSkipped, false, "stores with skipFilters: true omits filter mask store");
    assert.strictEqual(hasClippedStoreSkipped, false, "stores with skipFilters: true omits layer clipped to skipped filter");

    filterLayer.visible = false;
    const storesHidden = ed.passStores("image", [0, 0, 1000, 800], 1, { forRun: true, skipFilters: false });
    filterLayer.visible = true;

    // Per Must Fix 2: clipped layer whose base is a hidden filter layer is drawn unclipped in normal composite (length 3),
    // but skipped when skipFilters is true (length 2).
    assert.strictEqual(storesSkip.length, 2, "skipFilters skips both filter and clipped layer");
    assert.strictEqual(storesHidden.length, 3, "hidden filter draws clipped layer unclipped");


    console.log("  [ok] passStores with skipFilters: true names no store the pass does not draw");

    // =========================================================================
    // 3. drawComposite hasFilters calculation (F5)
    // =========================================================================
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

    drawLayersOpts = null;
    drawCompositeEd.flatCanvas = null;
    drawCompositeEd.drawComposite({}, { skipFilters: true });
    assert.ok(drawLayersOpts, "drawLayersInto called directly without flatCanvas when skipFilters is true");
    assert.strictEqual(drawCompositeEd.flatCanvas, null, "flatCanvas is null when only filter layer is present with skipFilters: true");

    drawCompositeEd.matchActive = (l) => l.id === 1;
    drawCompositeEd.drawComposite({ drawImage: () => {} }, { skipFilters: true });
    assert.ok(drawCompositeEd.flatCanvas !== null, "colour-matched layers still trigger offscreen flatCanvas when skipFilters: true");

    console.log("  [ok] drawComposite ignores filter layers for hasFilters when skipFilters is set, keeping colour-matched layers");

    // =========================================================================
    // 4. inpaint_maps.js: packRG16 and unpackRG16 round trip of 65,536 values (F8)
    // =========================================================================
    const w65k = 256, h65k = 256;
    const u16ramp = new Uint16Array(65536);
    for (let i = 0; i < 65536; i++) u16ramp[i] = i;

    const map65k = makeMap("depth", w65k, h65k, u16ramp);
    assert.strictEqual(map65k.w, 256);
    assert.strictEqual(map65k.h, 256);
    assert.strictEqual(map65k.kind, "depth");
    assert.strictEqual(map65k.data.length, 65536);

    const canvas65k = packRG16(map65k);
    assert.strictEqual(canvas65k.width, 256);
    assert.strictEqual(canvas65k.height, 256);

    const ctx65k = canvas65k.getContext("2d");
    const imgData65k = ctx65k.getImageData(0, 0, 256, 256);
    const unpacked65k = unpackRG16(imgData65k.data, 256, 256);

    assert.strictEqual(unpacked65k.length, 65536, "unpacked length matches");
    let matchFail = -1;
    for (let i = 0; i < 65536; i++) {
        if (unpacked65k[i] !== i) { matchFail = i; break; }
    }
    assert.strictEqual(matchFail, -1, `all 65,536 values match exactly on pack/unpack roundtrip (failed at ${matchFail})`);
    console.log("  [ok] packRG16 / unpackRG16 round trip 65,536 values exact");

    // =========================================================================
    // 5. inpaint_maps.js: passToMap against direct composition (scale 1 and 0.25)
    // =========================================================================
    const mapW = 800, mapH = 600;
    // Map placed under a 90-degree clockwise rotation and crop offset [100, 50]
    const testXf = snapXf(xfMul(xfTranslate(100, 50), xfMul(xfRotate(90), xfScale(mapW, mapH))));
    const testMap = makeMap("depth", mapW, mapH, new Uint16Array(mapW * mapH), testXf);

    for (const sc of [1, 0.25]) {
        const mPass = passToMap(testMap, sc);
        // Direct composition: S(w, h) * xfInv(map.xf) * S(1 / sc)
        const directM = snapXf(xfMul(xfScale(mapW, mapH), xfMul(xfInv(testXf), xfScale(1 / sc))));

        for (let i = 0; i < 6; i++) {
            assert.ok(Math.abs(mPass[i] - directM[i]) < 1e-5, `passToMap scale ${sc} element ${i} matches direct composition`);
        }

        // Verify coordinate transformation consistency on test points
        const testPoints = [[0, 0], [100 * sc, 50 * sc], [400 * sc, 300 * sc], [799 * sc, 599 * sc]];
        for (const [px, py] of testPoints) {
            const p1 = xfApply(mPass, px, py);
            const docPt = [px / sc, py / sc];
            const unitPt = xfApply(xfInv(testXf), docPt[0], docPt[1]);
            const p2 = [unitPt[0] * mapW, unitPt[1] * mapH];
            assert.ok(Math.abs(p1[0] - p2[0]) < 1e-4, `pass point X matches direct point for scale ${sc}`);
            assert.ok(Math.abs(p1[1] - p2[1]) < 1e-4, `pass point Y matches direct point for scale ${sc}`);
        }
    }
    console.log("  [ok] passToMap against direct composition for scale 1 and 0.25 under 90° xf and crop offset");

    // =========================================================================
    // 6. inpaint_maps.js: sampleMap at corners (exact), edges (clamp), centres (mean)
    // =========================================================================
    const gridW = 4, gridH = 4;
    const gridData = new Uint16Array(gridW * gridH);
    for (let y = 0; y < gridH; y++) {
        for (let x = 0; x < gridW; x++) {
            gridData[y * gridW + x] = (y * gridW + x + 1) * 1000;
        }
    }
    // Unit square maps to doc pixels [0, 4] x [0, 4]
    const gridXf = [gridW, 0, 0, gridH, 0, 0];
    const gridMap = makeMap("depth", gridW, gridH, gridData, gridXf);

    // Corners (pixel centers at 0.5, 0.5; 3.5, 0.5; etc.) are exact
    const c00 = sampleMap(gridMap, 0.5, 0.5);
    assert.strictEqual(c00, gridData[0] / 65535, "corner (0,0) exact");
    const c30 = sampleMap(gridMap, 3.5, 0.5);
    assert.strictEqual(c30, gridData[3] / 65535, "corner (3,0) exact");
    const c03 = sampleMap(gridMap, 0.5, 3.5);
    assert.strictEqual(c03, gridData[12] / 65535, "corner (0,3) exact");
    const c33 = sampleMap(gridMap, 3.5, 3.5);
    assert.strictEqual(c33, gridData[15] / 65535, "corner (3,3) exact");

    // Outside bounds clamp to edge value
    const clampLeft = sampleMap(gridMap, -10.0, 0.5);
    assert.strictEqual(clampLeft, c00, "sample outside left edge clamps to corner/edge value");
    const clampFarRight = sampleMap(gridMap, 20.0, 3.5);
    assert.strictEqual(clampFarRight, c33, "sample outside right edge clamps to corner/edge value");

    // Centre between 4 pixels (e.g. at integer coordinate docX=1.0, docY=1.0, between (0,0), (1,0), (0,1), (1,1))
    const centre = sampleMap(gridMap, 1.0, 1.0);
    const meanExpected = (gridData[0] + gridData[1] + gridData[4] + gridData[5]) / (4 * 65535);
    assert.ok(Math.abs(centre - meanExpected) < 1e-6, "centre between 4 pixels equals their mean");

    console.log("  [ok] sampleMap at corners (exact), edges (clamp) and centres (mean)");

    // =========================================================================
    // 7. inpaint_maps.js: fingerprint and fingerprintDiff
    // =========================================================================
    const fpCanvasW = 128, fpCanvasH = 128;
    const flatGrey = new Uint8ClampedArray(fpCanvasW * fpCanvasH * 4);
    for (let i = 0; i < flatGrey.length; i += 4) {
        flatGrey[i] = 128;
        flatGrey[i + 1] = 128;
        flatGrey[i + 2] = 128;
        flatGrey[i + 3] = 255;
    }
    const fp1 = fingerprint(flatGrey, fpCanvasW, fpCanvasH);
    const fp2 = fingerprint(flatGrey, fpCanvasW, fpCanvasH);
    assert.ok(typeof fp1 === "string" && fp1.length > 0, "fingerprint returned non-empty string");
    assert.strictEqual(fp1, fp2, "fingerprint of constant picture is constant");
    assert.strictEqual(fingerprintDiff(fp1, fp2), 0, "fingerprintDiff of two equal is 0");

    const whiteData = new Uint8ClampedArray(fpCanvasW * fpCanvasH * 4);
    whiteData.fill(255);
    const blackData = new Uint8ClampedArray(fpCanvasW * fpCanvasH * 4);
    for (let i = 3; i < blackData.length; i += 4) blackData[i] = 255; // opaque black

    const fpWhite = fingerprint(whiteData, fpCanvasW, fpCanvasH);
    const fpBlack = fingerprint(blackData, fpCanvasW, fpCanvasH);
    const diffMax = fingerprintDiff(fpWhite, fpBlack);
    assert.strictEqual(Math.round(diffMax), 255, "diff between black and white fingerprints is 255");
    console.log("  [ok] fingerprint of constant picture is constant, fingerprintDiff of equal is 0");

    // =========================================================================
    // 8. inpaint_maps.js: rg8View and mapToJSON
    // =========================================================================
    const view = rg8View(map65k);
    assert.strictEqual(view.width, 256);
    assert.strictEqual(view.height, 256);
    assert.strictEqual(view.channels, 2);
    assert.strictEqual(view.static, true);
    assert.strictEqual(view.key, `depth:${map65k.dataVersion}`);
    assert.strictEqual(view.data.byteLength, 65536 * 2);

    const json = mapToJSON(testMap);
    assert.strictEqual(json.w, mapW);
    assert.strictEqual(json.h, mapH);
    assert.strictEqual(json.enc, "u16rg");
    assert.deepStrictEqual(json.xf, testXf);
    const nullMap = await mapFromJSON("depth", json, async () => null);
    assert.strictEqual(nullMap, null, "mapFromJSON returns null when loader returns null");
    console.log("  [ok] rg8View and mapToJSON / mapFromJSON serialization");

    // =========================================================================
    // 9. InpaintEditor integration: store, geometryToken, setMap, undo/redo (F8a)
    // =========================================================================
    const editor = {
        width: 800,
        height: 600,
        tileMode: false,
        maps: {},
        mapsVersion: 0,
        geometrySeq: 0,
        undo: [],
        redo: [],
        layers: [],
        _destroyed: false,
        geometryToken: InpaintEditor.prototype.geometryToken,
        setMap: InpaintEditor.prototype.setMap,
        pushUndoSnapshot(snap) { this.undo.push(snap); },
        markFilterChanged() {},
        renderHistory() {},
        draw() {},
        notifyChanged() {},
        mapExtras: InpaintEditor.prototype.mapExtras,
        followGeometry: InpaintEditor.prototype.followGeometry,
        mapGuides: () => {},
        docXf: [1, 0, 0, 1, 0, 0],
        memoryReport: InpaintEditor.prototype.memoryReport,
        filterKey: InpaintEditor.prototype.filterKey,
        effectViewOf: InpaintEditor.prototype.effectViewOf,
        applySnapshot: InpaintEditor.prototype.applySnapshot,
        snapshot: InpaintEditor.prototype.snapshot,
        snapshotOf: InpaintEditor.prototype.snapshotOf,
    };

    assert.strictEqual(editor.geometryToken(), 0, "initial geometryToken is 0");

    const depthMap1 = makeMap("depth", 800, 600, new Uint16Array(800 * 600), [800, 0, 0, 600, 0, 0]);
    const okSet = await editor.setMap("depth", depthMap1, { token: editor.geometryToken() });
    assert.strictEqual(okSet, true, "setMap succeeds with matching token");
    assert.strictEqual(editor.maps.depth, depthMap1, "maps.depth stored");
    assert.strictEqual(editor.mapsVersion, 1, "mapsVersion bumped to 1");
    assert.strictEqual(editor.undo.length, 1, "undo step pushed");
    assert.strictEqual(editor.undo[0].kind, "maps");
    assert.strictEqual(editor.undo[0].prev, null);

    // Test rejection on mismatched geometryToken
    const depthMap2 = makeMap("depth", 800, 600, new Uint16Array(800 * 600), [800, 0, 0, 600, 0, 0]);
    const badSet = await editor.setMap("depth", depthMap2, { token: 999 });
    assert.strictEqual(badSet, false, "setMap rejects mismatched token");
    assert.strictEqual(editor.maps.depth, depthMap1, "map untouched after rejected token");

    // Second valid setMap
    await editor.setMap("depth", depthMap2);
    assert.strictEqual(editor.maps.depth, depthMap2);
    assert.strictEqual(editor.mapsVersion, 2);
    assert.strictEqual(editor.undo.length, 2);
    assert.strictEqual(editor.undo[1].prev, depthMap1, "second undo step holds depthMap1 as prev");

    // Test undo restore and redo swap
    const undoSnap = editor.undo.pop();
    const redoSnap = editor.snapshot(undoSnap);
    assert.strictEqual(redoSnap.prev, depthMap2, "redo snapshot holds depthMap2");
    editor.applySnapshot(undoSnap);
    assert.strictEqual(editor.maps.depth, depthMap1, "undo restored previous map");
    assert.strictEqual(editor.mapsVersion, 3, "undo bumped mapsVersion");
    editor.applySnapshot(redoSnap);
    assert.strictEqual(editor.maps.depth, depthMap2, "redo restored depthMap2");
    assert.strictEqual(editor.mapsVersion, 4, "redo bumped mapsVersion");
    editor.applySnapshot(undoSnap);
    assert.strictEqual(editor.maps.depth, depthMap1, "undo back to depthMap1");
    assert.strictEqual(editor.mapsVersion, 5);

    // =========================================================================
    // 10. InpaintEditor geometry following (mapExtras and followGeometry)
    // =========================================================================
    const xfBefore = depthMap1.xf.slice();
    const rotXf = snapXf(xfRotate(90, 400, 300));
    editor.mapExtras(rotXf, "turn");
    assert.strictEqual(editor.mapsVersion, 6, "mapExtras bumped mapsVersion");
    assert.deepStrictEqual(editor.maps.depth.xf, snapXf(xfMul(rotXf, xfBefore)), "mapExtras composed rotation into map.xf");

    // followGeometry bumps geometrySeq and mapsVersion
    const seqBefore = editor.geometrySeq;
    editor.followGeometry("crop", [1, 0, 0, 1, -50, -50], { width: 800, height: 600 }, { width: 700, height: 500 });
    assert.strictEqual(editor.geometrySeq, seqBefore + 1, "followGeometry bumped geometrySeq");

    // =========================================================================
    // 11. InpaintEditor memoryReport and filterKey
    // =========================================================================
    const rep = editor.memoryReport();
    assert.ok(rep.maps, "memoryReport includes maps section");
    assert.strictEqual(rep.maps.count, 1, "maps count is 1");
    assert.strictEqual(rep.maps.bytes, 800 * 600 * 2, "maps bytes calculated correctly");

    const normalLayer = { filter: "grain", params: { amount: 10 } };
    const k1 = editor.filterKey(normalLayer, { width: 800, height: 600 }, false, false);
    const depthLimitLayer = { filter: "grain", params: { amount: 10, limit: { source: "depth" } } };
    const k2 = editor.filterKey(depthLimitLayer, { width: 800, height: 600 }, false, false);
    assert.notStrictEqual(k1, k2, "filterKey differs when limit source is depth");
    assert.ok(k2.includes(String(editor.mapsVersion)), "filterKey includes mapsVersion for depth limit layer");

    console.log("  [ok] InpaintEditor maps store, geometryToken, undo/redo, geometry following, memoryReport, and filterKey");

    console.log("ALL MAPS TESTS PASSED!");
    process.exit(0);
}

main().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});
