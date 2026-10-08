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
                    width: 100,
                    height: 100,
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
                        putImageData: () => {},
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
    console.log("Running limit_test.js (Foundation F6)...");

    const hostModule = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "host.js")).href);
    const host = hostModule.default || hostModule.host;

    const weightsModule = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_weights.js")).href);
    const {
        normalizeLimit,
        sstep,
        rangeWeight,
        limitWeight,
        sourceValue,
        WEIGHTS_GLSL,
    } = weightsModule;

    const filtersModule = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_filters.js")).href);
    const {
        applyFilter,
        setLimitStage,
        FILTERS,
    } = filtersModule;

    const canvasModule = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_canvas.js")).href);
    const { InpaintEditor } = canvasModule;

    const commandsModule = await import(pathToFileURL(path.join(ROOT, "renderer", "commands.js")).href);
    const { commands } = commandsModule;

    // -------------------------------------------------------------------------
    // 1. normalizeLimit behavior
    // -------------------------------------------------------------------------
    console.log("  1. normalizeLimit verification...");
    assert.strictEqual(normalizeLimit(null), null);
    assert.strictEqual(normalizeLimit(false), null);
    assert.strictEqual(normalizeLimit(undefined), null);

    assert.throws(() => normalizeLimit("string"), /limit must be an object/);
    assert.throws(() => normalizeLimit({ source: "invalid" }), /limit\.source must be depth, luma or color/);

    const norm1 = normalizeLimit({ source: "depth", lo: 0.8, hi: 0.2, fLo: 0.1, fHi: 0.15, invert: true });
    assert.deepStrictEqual(norm1, {
        source: "depth",
        lo: 0.2,
        hi: 0.8,
        fLo: 0.1,
        fHi: 0.15,
        invert: true,
    });

    const normColor = normalizeLimit({ source: "color", color: "#112233", tol: 40 });
    assert.strictEqual(normColor.source, "color");
    assert.strictEqual(normColor.color, "#112233");
    assert.strictEqual(normColor.tol, 40);

    const normClamp = normalizeLimit({ source: "luma", lo: -0.5, hi: 1.5 });
    assert.strictEqual(normClamp.lo, 0);
    assert.strictEqual(normClamp.hi, 1);
    console.log("     [ok] normalizeLimit validates and clamps correctly");

    // -------------------------------------------------------------------------
    // 2. filterKey cache key parity and limit invalidation
    // -------------------------------------------------------------------------
    console.log("  2. filterKey cache key parity...");
    const dummyEditor = {
        viewPass: null,
        filterKey: InpaintEditor.prototype.filterKey,
    };
    const belowMock = { width: 800, height: 600 };
    const layerPlain = {
        filter: "invert",
        params: {},
        lut: null,
        plate: null,
    };

    // For layer without limit, key must match the legacy literal
    const legacyKey = JSON.stringify([
        layerPlain.filter,
        layerPlain.params,
        null,
        null,
        false,
        false,
        800,
        600,
        0,
    ]);
    const computedKey = dummyEditor.filterKey(layerPlain, belowMock, false, false);
    assert.strictEqual(computedKey, legacyKey, "filterKey must produce byte-for-byte identical string without limit");

    // Adding params.limit changes the key
    const layerWithLimit = {
        filter: "invert",
        params: { limit: norm1 },
        lut: null,
        plate: null,
    };
    const keyWithLimit = dummyEditor.filterKey(layerWithLimit, belowMock, false, false);
    assert.notStrictEqual(keyWithLimit, legacyKey, "filterKey must change when limit is added");

    // Changing limit parameter changes the key
    const layerLimitChanged = {
        filter: "invert",
        params: { limit: { ...norm1, lo: 0.3 } },
        lut: null,
        plate: null,
    };
    const keyChanged = dummyEditor.filterKey(layerLimitChanged, belowMock, false, false);
    assert.notStrictEqual(keyChanged, keyWithLimit, "filterKey must change when limit values change");
    console.log("     [ok] filterKey preserves legacy key and responds to limit changes");

    // -------------------------------------------------------------------------
    // 3. filterInfo builder and test hook agreement
    // -------------------------------------------------------------------------
    console.log("  3. filterInfo call sites agreement...");
    const fakeCanvasInstance = {
        width: 1000,
        height: 800,
        compositeVersion: 1,
        maps: { depth: "fakeDepthMap" },
        belowStats: () => ({ mean: [0.5, 0.5, 0.5] }),
        filterInfo: InpaintEditor.prototype.filterInfo,
        _lastFilterInfoBySite: {},
    };

    const filterLayer = {
        id: "layer_42",
        filter: "levels",
        params: { in_min: 10 },
        _lutData: null,
        _plateImg: null,
        plate: null,
    };

    // Simulate filteredCanvas full-resolution pass
    const fxCacheFC = {};
    const infoFC = fakeCanvasInstance.filterInfo(filterLayer, {
        scale: 1,
        origin: [0, 0],
        full: [1000, 800],
        forRun: false,
        cache: fxCacheFC,
        chain: true,
        site: "filteredCanvas",
    });

    // Simulate bandFilter pass
    const fxCacheBF = {};
    const infoBF = fakeCanvasInstance.filterInfo(filterLayer, {
        scale: 1,
        origin: [0, 0],
        full: [1000, 800],
        forRun: false,
        cache: fxCacheBF,
        chain: "bands",
        site: "bandFilter",
    });

    // Check test hook recorded both
    assert.strictEqual(fakeCanvasInstance._lastFilterInfoBySite.filteredCanvas, infoFC);
    assert.strictEqual(fakeCanvasInstance._lastFilterInfoBySite.bandFilter, infoBF);

    // Verify they agree apart from cache and chain
    for (const k of Object.keys(infoFC)) {
        if (k === "cache" || k === "chain") continue;
        assert.deepStrictEqual(infoFC[k], infoBF[k], `infoFC and infoBF must agree on field ${k}`);
    }
    assert.strictEqual(infoFC.maps, fakeCanvasInstance.maps);
    assert.strictEqual(infoFC.seed, "layer_42");
    console.log("     [ok] filterInfo produces consistent pass context for both call sites");

    // -------------------------------------------------------------------------
    // 4. setFilterType keeps prev.limit
    // -------------------------------------------------------------------------
    console.log("  4. setFilterType preserves limit...");
    const edFilterType = {
        pushUndo: () => {},
        filterCounter: 1,
        color: "#ffffff",
        markFilterChanged: () => {},
        renderLayers: () => {},
        setFilterType: InpaintEditor.prototype.setFilterType,
    };

    const sampleLayer = {
        id: "fx_1",
        filter: "grain",
        params: {
            amount: 25,
            limit: { source: "depth", lo: 0.1, hi: 0.9, fLo: 0, fHi: 0, invert: false },
        },
        name: "Grain 1",
    };

    edFilterType.setFilterType(sampleLayer, "invert");
    assert.strictEqual(sampleLayer.filter, "invert");
    assert.strictEqual(sampleLayer.params.amount, undefined, "old filter params should be reset");
    assert.deepStrictEqual(sampleLayer.params.limit, {
        source: "depth",
        lo: 0.1,
        hi: 0.9,
        fLo: 0,
        fHi: 0,
        invert: false,
    }, "prev.limit must be preserved on filter type switch");
    console.log("     [ok] setFilterType keeps limit across filter type switch");

    // -------------------------------------------------------------------------
    // 5. commands.js: filter_types schema and writeParams immutability
    // -------------------------------------------------------------------------
    console.log("  5. commands.js filter_types & parameter immutability...");
    const typesRes = await commands.run("filter_types");
    assert.ok(typesRes.common && typesRes.common.limit, "filter_types must describe common.limit");
    assert.deepStrictEqual(typesRes.common.limit.source, ["depth", "luma", "color"]);
    assert.strictEqual(typesRes.common.limit.lo, "0..1");
    assert.strictEqual(typesRes.common.limit.hi, "0..1");

    // Test writeParams immutability rule:
    // Snapshot is shallow: l.params must be replaced, not mutated in-place
    const testLayer = {
        id: "layer_test_fx",
        name: "TestFilter",
        kind: "filter",
        filter: "invert",
        params: {},
    };

    let capturedUndoSnap = null;
    const testEd = {
        node: { id: 99 },
        layers: [testLayer],
        activeLayerId: testLayer.id,
        activeLayer: () => testLayer,
        shown: () => true,
        isReference: () => false,
        refLabels: () => new Map(),
        pushUndo: () => {
            capturedUndoSnap = { kind: "filter", id: testLayer.id, params: { ...testLayer.params } };
        },
        markFilterChanged: () => {},
        uploaded: { baseHash: null, controlHash: null },
        renderLayers: () => {},
        renderInfo: () => {},
        draw: () => {},
        drawThumb: () => {},
        notifyChanged: () => {},
    };

    // Install mock editor into host
    const origEditor = host.editor;
    const origEditors = host.editors;
    const origEditorById = host.editorById;
    try {
        host.editor = testEd;
        host.editors = () => [testEd];
        host.editorById = (id) => (id === 99 ? testEd : null);

        // Verify invalid limit.source is rejected before modifying anything
        let badSourceError = "";
        try {
            await commands.run("set_filter", {
                doc: 99,
                layer: "layer_test_fx",
                params: { limit: { source: "bogus" } },
            });
        } catch (e) {
            badSourceError = e.message || String(e);
        }
        assert.match(badSourceError, /limit\.source must be depth, luma or color/);

        // Apply a valid limit
        await commands.run("set_filter", {
            doc: 99,
            layer: "layer_test_fx",
            params: { limit: { source: "depth", lo: 0.25, hi: 0.75 } },
        });

        assert.deepStrictEqual(testLayer.params.limit, {
            source: "depth",
            lo: 0.25,
            hi: 0.75,
            fLo: 0,
            fHi: 0,
            invert: false,
        });

        // The captured undo snapshot taken before writeParams must NOT have limit
        assert.strictEqual(capturedUndoSnap.params.limit, undefined, "Undo snapshot must not be mutated in-place");

        // Remove limit by setting it to null
        await commands.run("set_filter", {
            doc: 99,
            layer: "layer_test_fx",
            params: { limit: null },
        });
        assert.strictEqual(testLayer.params.limit, undefined, "limit: null should delete limit from params");
    } finally {
        host.editor = origEditor;
        host.editors = origEditors;
        host.editorById = origEditorById;
    }

    console.log("     [ok] commands.js validates limit, preserves immutability, and supports removal");

    // -------------------------------------------------------------------------
    // 6. inpaint_filters.js setLimitStage hook
    // -------------------------------------------------------------------------
    console.log("  6. inpaint_filters limitStage execution...");
    let stageCalled = false;
    let stageArgs = null;
    const testStage = (src, out, limit, info, def) => {
        stageCalled = true;
        stageArgs = { src, out, limit, info, def };
        return "stageResult";
    };

    setLimitStage(testStage);
    const mockSrc = document.createElement("canvas");
    const testInfo = { cpu: true };
    const limitObj = { source: "luma", lo: 0.2, hi: 0.8 };

    const outWithStage = applyFilter("invert", mockSrc, { limit: limitObj }, testInfo);
    assert.strictEqual(stageCalled, true, "limitStage must be called when params.limit is present");
    assert.strictEqual(stageArgs.limit, limitObj);
    assert.strictEqual(stageArgs.def, FILTERS.invert);
    assert.strictEqual(outWithStage, "stageResult");

    // Clean up limitStage
    setLimitStage(null);
    stageCalled = false;
    const outWithoutStage = applyFilter("invert", mockSrc, { limit: limitObj }, testInfo);
    assert.strictEqual(stageCalled, false, "limitStage must not be called when null");
    assert.notStrictEqual(outWithoutStage, "stageResult");
    console.log("     [ok] setLimitStage intercepts filter output when params.limit is set");

    // -------------------------------------------------------------------------
    // 7. WEIGHTS_GLSL & ramp check
    // -------------------------------------------------------------------------
    console.log("  7. WEIGHTS_GLSL ramp check...");
    assert.ok(WEIGHTS_GLSL.includes("float w_sstep"));
    assert.ok(WEIGHTS_GLSL.includes("float w_range"));
    assert.ok(WEIGHTS_GLSL.includes("vec3 w_opp"));
    assert.ok(WEIGHTS_GLSL.includes("float w_colour"));
    assert.ok(WEIGHTS_GLSL.includes("float w_limit"));

    // Function checks
    assert.strictEqual(sstep(0.2, 0.4, 0.1), 0);
    assert.strictEqual(sstep(0.2, 0.4, 0.5), 1);
    assert.ok(Math.abs(sourceValue({ source: "luma" }, 1, 1, 1) - 1) < 1e-9);
    assert.strictEqual(limitWeight({ source: "luma", lo: 0.2, hi: 0.8, fLo: 0, fHi: 0, invert: false }, 0.5, 0.5, 0.5), 1);

    // Ramp check on JS rangeWeight
    const r = { lo: 0.4, hi: 0.6, fLo: 0.1, fHi: 0.1, invert: false };
    assert.strictEqual(rangeWeight(0.2, r), 0, "below lo - fLo gives 0");
    assert.strictEqual(rangeWeight(0.3, r), 0, "at lo - fLo gives 0");
    const wRampUp = rangeWeight(0.35, r);
    assert.ok(wRampUp > 0 && wRampUp < 1, "ramp up between 0.3 and 0.4");
    assert.strictEqual(rangeWeight(0.4, r), 1, "at lo gives 1");
    assert.strictEqual(rangeWeight(0.5, r), 1, "inside plateau gives 1");
    assert.strictEqual(rangeWeight(0.6, r), 1, "at hi gives 1");
    const wRampDown = rangeWeight(0.65, r);
    assert.ok(wRampDown > 0 && wRampDown < 1, "ramp down between 0.6 and 0.7");
    assert.strictEqual(rangeWeight(0.7, r), 0, "at hi + fHi gives 0");
    assert.strictEqual(rangeWeight(0.8, r), 0, "above hi + fHi gives 0");

    // Invert check
    const rInv = { ...r, invert: true };
    assert.strictEqual(rangeWeight(0.2, rInv), 1);
    assert.strictEqual(rangeWeight(0.5, rInv), 0);

    console.log("     [ok] WEIGHTS_GLSL exports required symbols and JS ramp math is verified");

    console.log("ALL LIMIT TESTS PASSED!");
}

main().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});
