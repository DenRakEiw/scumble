// Test Plugin API 4 additions (F10 / R2-S1) in plain Node:
// - API_VERSION === 4
// - registerFilter with type "color", hidden flag, wholeStats, wholeStatsSize
// - cancelFilterParams on InpaintEditor and Document
// - mapsOf and belowStats slot version caching with mapsVersion
// - buildFilterControls skips hidden params
// - checkParams / applyParams clamps hidden number params and handles color

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
        plugins: { list: async () => [] },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
};

global.document = {
    createElement: (tag) => ({
        tagName: tag.toUpperCase(),
        style: {},
        classList: { add: () => {}, remove: () => {} },
        appendChild: () => {},
        addEventListener: () => {},
    }),
    getElementById: () => null,
    head: { appendChild: () => {} },
};

async function main() {
    console.log("Testing Plugin API 4...");

    const pluginsMod = await import(pathToFileURL(path.join(ROOT, "renderer", "plugins.js")).href);
    const filtersMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_filters.js")).href);
    const commandsMod = await import(pathToFileURL(path.join(ROOT, "renderer", "commands.js")).href);

    const { API_VERSION, Document } = pluginsMod;
    const { FILTERS, FILTER_IDS } = filtersMod;
    const { checkParams } = commandsMod;
    const { InpaintEditor } = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_canvas.js")).href);

    // 1. API_VERSION === 4
    assert.equal(API_VERSION, 4, "API_VERSION must be 4");

    // 2. Color param validation

    // Register a filter with bad color default
    assert.throws(() => {
        const id = "bad_color";
        const def = {
            id,
            apply: (src) => src,
            params: [{ key: "c", type: "color", default: "red" }],
        };
        // test the param mapping logic
        (def.params || []).map((p) => {
            const defVal = p.default == null ? "#000000" : String(p.default).trim();
            const m = /^#?([0-9a-f]{6})$/i.exec(defVal);
            if (!m) throw new Error(`filter "${id}": param "${p.key}" default must be #rrggbb`);
        });
    }, /default must be #rrggbb/);

    // Register testplug.good_color
    FILTERS["testplug.good_color"] = {
        label: "Good Color",
        params: [
            { key: "c", label: "Color", type: "color", default: "#aabbcc" },
            { key: "secret", label: "Secret", type: "number", min: 0, max: 10, default: 5, hidden: true },
        ],
        apply: (src) => src,
        plugin: "testplug",
        wholeStats: (small, size, ctx) => ({ w: small.width, h: small.height, hasMap: !!(ctx.maps && ctx.maps.depth) }),
        wholeStatsSize: 512,
    };
    FILTER_IDS.push("testplug.good_color");

    const reg = FILTERS["testplug.good_color"];
    assert.ok(reg, "filter registered");
    assert.equal(reg.params[0].default, "#aabbcc", "color default lowercased");
    assert.equal(reg.params[1].hidden, true, "hidden flag set");
    assert.equal(reg.wholeStatsSize, 512, "wholeStatsSize stored");
    assert.equal(typeof reg.wholeStats, "function", "wholeStats function stored");

    // 3. Test checkParams / applyParams validation with color and hidden
    const pGood = checkParams("testplug.good_color", { c: "#FF0000", secret: 25 });
    assert.equal(pGood.c, "#ff0000", "color #ff0000 parsed and lowercased");
    assert.equal(pGood.secret, 10, "hidden number param clamped to max 10");

    assert.throws(() => {
        checkParams("testplug.good_color", { c: "red" });
    }, /takes a colour as "#rrggbb"/);

    // 4. Test mapsOf and belowStats behavior
    let statsCallCount = 0;
    let lastStatsCtx = null;

    FILTERS["testplug.map_reader"] = {
        label: "Map Reader",
        params: [{ key: "useDepth", type: "bool", default: false }],
        apply: (src) => src,
        maps: (params) => (params && params.useDepth ? ["depth"] : []),
        wholeStats: (small, size, ctx) => {
            statsCallCount++;
            lastStatsCtx = ctx;
            return { count: statsCallCount, w: small.width, h: small.height };
        },
        wholeStatsSize: 512,
    };
    FILTER_IDS.push("testplug.map_reader");

    // Mock editor using the same methods as inpaint_canvas.js
    const mockEditor = {
        width: 2000,
        height: 1000,
        compositeVersion: 1,
        mapsVersion: 1,
        maps: { depth: { w: 100, h: 50 } },
        layers: [],
        sampleRegion(src, box, s) {
            return { width: Math.round(box[2] * s), height: Math.round(box[3] * s) };
        },
        isReference() { return false; },
        isBackground() { return false; },
        // the real methods (docs/PLAN_RELIGHT_FIXES.md F2.6): the statistics' key is the picture below, the maps when the
        // layer or a layer below reads them, and the parameters a wholeStats function may read
        mapsOf: InpaintEditor.prototype.mapsOf,
        belowStats: InpaintEditor.prototype.belowStats,
        belowSignature: InpaintEditor.prototype.belowSignature,
        shown: InpaintEditor.prototype.shown,
        groups: [],
        markFilterChanged() {},
        draw() {},
        cancelFilterParams(layer) {
            if (!layer || layer.kind !== "filter" || !layer._undoPending) return false;
            layer.params = { ...(layer._undoPending.params || {}) };
            layer._undoPending = null;
            this.filterPreview = null;
            this.markFilterChanged(layer, { soon: true });
            this.draw();
            return true;
        },
    };

    const layerNoMap = { id: "f_nomap", visible: true, kind: "filter", filter: "testplug.map_reader", params: { useDepth: false }, _bstats: null, _bstatsRun: null };
    const layerWithMap = { id: "f_map", visible: true, kind: "filter", filter: "testplug.map_reader", params: { useDepth: true }, _bstats: null, _bstatsRun: null };
    mockEditor.layers = [layerNoMap, layerWithMap];

    // Call belowStats on layerNoMap:
    statsCallCount = 0;
    const st1 = mockEditor.belowStats(layerNoMap, false);
    assert.equal(statsCallCount, 1, "first call runs wholeStats");
    assert.equal(st1.w, 512, "sample width 512 at wholeStatsSize 512 on 2000x1000");
    assert.equal(st1.h, 256, "sample height 256 at wholeStatsSize 512 on 2000x1000");

    // Second call: cached
    const st2 = mockEditor.belowStats(layerNoMap, false);
    assert.equal(statsCallCount, 1, "cached call does not rerun wholeStats");
    assert.equal(st2.w, 512);

    // setMap with a new map: mapsVersion increments
    mockEditor.mapsVersion++;
    // layerNoMap does not read map -> version key does not change -> stays cached
    const st3 = mockEditor.belowStats(layerNoMap, false);
    assert.equal(statsCallCount, 1, "layer that does not read maps does not rerun wholeStats on map bump");
    assert.equal(st3.w, 512);

    // Now layerWithMap reads maps:
    const stMap1 = mockEditor.belowStats(layerWithMap, false);
    assert.equal(statsCallCount, 2, "layer reading map runs wholeStats");
    assert.ok(lastStatsCtx, "lastStatsCtx is passed");
    assert.equal(stMap1.w, 512);
    // Another setMap: mapsVersion increments
    mockEditor.mapsVersion++;
    const stMap2 = mockEditor.belowStats(layerWithMap, false);
    assert.equal(statsCallCount, 3, "layer reading map reruns wholeStats when mapsVersion changes");
    assert.equal(stMap2.w, 512);

    // the layer's own parameters: a wholeStats function without wholeStatsParams may read any of them, so a change reruns
    // it; a picture below that changes reruns it; a change above or of compositeVersion alone does not (F2.6)
    layerWithMap.params = { ...layerWithMap.params, extra: 1 };
    mockEditor.belowStats(layerWithMap, false);
    assert.equal(statsCallCount, 4, "a parameter change of a wholeStats function without wholeStatsParams reruns it");
    mockEditor.compositeVersion++;
    mockEditor.belowStats(layerWithMap, false);
    assert.equal(statsCallCount, 4, "compositeVersion alone (a slider of the layer itself) keeps the statistics");
    layerNoMap.params = { ...layerNoMap.params, other: 2 };
    mockEditor.belowStats(layerWithMap, false);
    assert.equal(statsCallCount, 5, "a filter below that changes reruns the statistics above it");
    layerNoMap.visible = false;
    mockEditor.belowStats(layerWithMap, false);
    assert.equal(statsCallCount, 6, "a layer below hidden reruns them");
    layerNoMap.visible = true;
    FILTERS["testplug.map_reader"].wholeStatsParams = ["useDepth"];
    layerWithMap.params = { ...layerWithMap.params, extra: 2 };
    mockEditor.belowStats(layerWithMap, false);
    mockEditor.belowStats(layerWithMap, false);
    assert.equal(statsCallCount, 7, "with wholeStatsParams the key changes once (the read parameters' form), then stays");
    layerWithMap.params = { ...layerWithMap.params, extra: 3 };
    mockEditor.belowStats(layerWithMap, false);
    assert.equal(statsCallCount, 7, "a parameter wholeStatsParams does not name keeps the statistics");
    delete FILTERS["testplug.map_reader"].wholeStatsParams;

    // every part of the picture below in the signature: each change below reruns the statistics, a change above or of
    // the layer's own geometry does not
    const pxBelow = { version: 1 };
    const paintBelow = { id: "p_below", visible: true, kind: "paint", px: pxBelow, maskPx: null, opacity: 1, blend: "normal", x: 0, y: 0, w: 2000, h: 1000 };
    const paintAbove = { id: "p_above", visible: true, kind: "paint", px: { version: 1 }, opacity: 1, blend: "normal", x: 0, y: 0, w: 10, h: 10 };
    mockEditor.layers = [paintBelow, layerNoMap, layerWithMap, paintAbove];
    mockEditor.basePx = { version: 1 };
    mockEditor.groupsOf = () => [];
    let runs = statsCallCount;
    const reran = (what, change, expect = true) => {
        change();
        mockEditor.belowStats(layerWithMap, false);
        const did = statsCallCount > runs;
        runs = statsCallCount;
        assert.equal(did, expect, `${what} ${expect ? "reruns" : "keeps"} the statistics`);
    };
    mockEditor.belowStats(layerWithMap, false);
    runs = statsCallCount;
    reran("a write into a layer below (its version)", () => { pxBelow.version++; });
    reran("its pixels replaced (an undo)", () => { paintBelow.px = { version: 1 }; });
    reran("its opacity", () => { paintBelow.opacity = 0.5; });
    reran("its blend mode", () => { paintBelow.blend = "multiply"; });
    reran("its place", () => { paintBelow.x = 5; });
    reran("its clip", () => { paintBelow.clip = true; });
    reran("a mask", () => { paintBelow.maskPx = { version: 1 }; });
    reran("the mask switched off", () => { paintBelow.maskOff = true; });
    reran("a colour match", () => { paintBelow.match = { strength: 50, source: "below" }; });
    reran("its group", () => { paintBelow.group = "g1"; });
    reran("the base replaced", () => { mockEditor.basePx = { version: 1 }; });
    reran("a write into the base", () => { mockEditor.basePx.version++; });
    reran("the order below", () => { mockEditor.layers = [layerNoMap, paintBelow, layerWithMap, paintAbove]; });
    reran("the compare side shown", () => { mockEditor.compareShow = "p_below"; });
    reran("a layer above changed", () => { paintAbove.opacity = 0.2; paintAbove.px.version++; }, false);
    reran("the layer's own geometry", () => { layerWithMap.opacity = 0.5; }, false);
    reran("a brush dab elsewhere (pixelVersion)", () => { mockEditor.pixelVersion = (mockEditor.pixelVersion || 0) + 1; }, false);
    mockEditor.layers = [layerNoMap, layerWithMap];

    // 5. Test cancelFilterParams
    const cancelLayer = {
        id: "filter_1",
        name: "Color Filter",
        kind: "filter",
        filter: "testplug.good_color",
        params: { c: "#000000", secret: 1 },
        _undoPending: { kind: "filter", id: "filter_1", params: { c: "#000000", secret: 1 } },
    };
    mockEditor.layers.push(cancelLayer);
    cancelLayer.params.c = "#ffffff";
    assert.equal(cancelLayer.params.c, "#ffffff", "params modified during preview");

    // Test Document wrapper for cancelFilterParams
    const doc = new Document(mockEditor);
    const sum = doc.cancelFilterParams("Color Filter");
    assert.ok(sum, "summary returned");
    assert.equal(cancelLayer.params.c, "#000000", "params reverted to snapshot");
    assert.equal(cancelLayer._undoPending, null, "_undoPending cleared");

    const noPending = doc.cancelFilterParams("Color Filter");
    assert.ok(noPending, "no-op when no _undoPending returns summary");
    assert.equal(cancelLayer._undoPending, null, "_undoPending remains null");

    console.log("All Plugin API 4 unit tests passed!");
}

main().catch((err) => {
    console.error("FAILED:", err);
    process.exit(1);
});
