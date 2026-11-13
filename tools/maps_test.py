"""Maps and picture input gate (PLAN_NIK9_BUILD.md §F5, §F8).

First group "picture_input":
  * pictureInput(ed, 512, 341, { skipFilters: true }) equals the same call with the filter layer hidden,
    byte for byte, and differs with skipFilters: false.
  * passStores with skipFilters names no store the pass does not draw.
  * A layer clipped to a filter layer is skipped with its base when skipFilters is true.
  * Tested on both tiles and canvas backends.

Second group "maps":
  * Synthetic ramp setMap("depth", makeMap(...)) and no model.
  * rotate_canvas 90 and undo (xf turns and turns back, data untouched, sampleMap at a document point follows the turn).
  * Crop, then extend (points outside the footprint read the edge value).
  * setMap, undo and redo swap the object.
  * .scumble save and open returns map's bytes exactly (unpack equals original) and its xf.
  * Autosave restore (the quit gate's restart pattern) returns map's bytes and xf.
  * referencedFileKeys: map file is tracked; removed, it leaves the saved state but stays referenced while the
    removal's undo step holds it, and drops out once no step does.
  * Document with map writes version 2 / minReader 1, one without writes 1 / 1.
  * load_image / setBaseFromCanvas clears maps.
  * mapStale check.

Third group "colour maps" (PLAN_SURFACE_PAINT.md SP1):
  * rgb16 (every 16-bit value in each channel) and rgba8 (every alpha) beside a depth map: set, undo, redo.
  * A quarter turn and its undo move xf only; samples follow the turn.
  * .scumble save and open and the autosave restore give every value back exactly, with encoding and xf;
    the header says version 2 / minReader 7 and the stored encodings u16rg / rgb16 / rgba8.

Fourth group "surface maps" (PLAN_SURFACE_PAINT.md SP3), on a stand-in for host.surfaceAnalysis:
  * the two missing-model sentences, no maps; one run for two calls; the sizes, encodings, xf, the identity
    within one level, the normals' bytes; a fresh set kept, force recomputes; the command's views; one undo step
    per set; the autosave restore keeps the meta; a turn during the analysis drops the maps.

Runs Node test tools/maps_test.js first, then connects to running app via CDP if available.
"""
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

JS_PICTURE_INPUT = r"""
(async () => {
    const shell = await import("./shell.js");
    const hostModule = await import("./editor/host.js");
    const host = hostModule.default || hostModule.host;
    const fails = [];
    const check = (name, ok, info) => {
        if (!ok) fails.push(name + (info !== undefined ? ": " + JSON.stringify(info).slice(0, 400) : ""));
    };
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const settle = async (ed) => { await ed.mipsSettled(); await new Promise((r) => setTimeout(r, 100)); };
    const diff = (a, b) => {
        if (!a || !b) return null;
        if (a.length !== b.length) return { max: 999, n: -1 };
        let m = 0, n = 0;
        for (let i = 0; i < a.length; i++) {
            const d = Math.abs(a[i] - b[i]);
            if (d) { n++; if (d > m) m = d; }
        }
        return { max: m, n };
    };

    const W = 600, H = 400;
    const ed = shell.newDocument();
    shell.activate(ed);
    await new Promise((r) => setTimeout(r, 300));
    ed.resizeCanvas();

    const base = mk(W, H);
    {
        const x = base.getContext("2d");
        const g = x.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "#1a3a6a"); g.addColorStop(1, "#d8c8a0");
        x.fillStyle = g; x.fillRect(0, 0, W, H);
        for (let i = 0; i < 8; i++) {
            x.fillStyle = `hsl(${i * 45},60%,45%)`;
            x.fillRect(10 + i * 70, H - 100, 60, 80);
        }
    }
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBaseFromCanvas(base, { keepLayers: false });

    // Add strong filter layer (fill or levels)
    const fl = ed.addFilterLayer("fill");
    if (fl) {
        fl.params = { ...fl.params, color: "#ff0080" };
        ed.markFilterChanged(fl);
    }
    // Add a paint layer clipped to the filter layer
    const { Layer: LP } = ed.pixels;
    const clCanvas = mk(200, 200);
    {
        const cx = clCanvas.getContext("2d");
        cx.fillStyle = "#00ff00";
        cx.fillRect(0, 0, 200, 200);
    }
    const clippedLayer = ed.addLayer({
        name: "clippedToFilter",
        kind: "paint",
        clip: true,
        px: LP.fromCanvas(clCanvas),
        x: 50, y: 50, w: 200, h: 200, dirty: true,
    });

    await settle(ed);

    // 1. pictureInput with skipFilters: true vs filter hidden
    const resSkip = await host.pictureInput(ed, 512, 341, { skipFilters: true });
    check("resSkip returned dimensions", resSkip && resSkip.width === 512 && resSkip.height === 341, resSkip && [resSkip.width, resSkip.height]);

    // Hide the filter layer
    fl.visible = false;
    ed.renderLayers();
    await settle(ed);

    const resHidden = await host.pictureInput(ed, 512, 341, { skipFilters: true });
    const diffSkipVsHidden = diff(resSkip.image, resHidden.image);
    check("pictureInput with skipFilters: true equals filter layer hidden byte for byte", diffSkipVsHidden && diffSkipVsHidden.max === 0, diffSkipVsHidden);

    // Show the filter layer again and test skipFilters: false
    fl.visible = true;
    ed.renderLayers();
    await settle(ed);

    const resWithFilters = await host.pictureInput(ed, 512, 341, { skipFilters: false });
    const diffWithFilters = diff(resSkip.image, resWithFilters.image);
    check("pictureInput differs with skipFilters: false", diffWithFilters && diffWithFilters.max > 0, diffWithFilters);

    // 2. passStores with skipFilters names no store the pass does not draw
    if (ed.tileMode) {
        const s = Math.min(1, Math.max(512 / W, 341 / H));
        const storesSkip = ed.passStores("image", [0, 0, W, H], s, { forRun: true, skipFilters: true });
        fl.visible = false;
        const storesHidden = ed.passStores("image", [0, 0, W, H], s, { forRun: true, skipFilters: false });
        fl.visible = true;

        check("passStores store count with skipFilters skips both filter and clipped layer", storesSkip.length === 1 && storesHidden.length === 2, { skip: storesSkip.length, hidden: storesHidden.length });

        // Verify neither fl's mask nor clippedLayer's px are in storesSkip
        const hasFlStore = storesSkip.some((st) => st.px === ed.liveMask(fl));
        const hasClippedStore = storesSkip.some((st) => st.px === clippedLayer.px);
        check("passStores omits filter mask", !hasFlStore, hasFlStore);
        check("passStores omits layer clipped to filter", !hasClippedStore, hasClippedStore);
    }

    // 3. Memory check at 15k if memoryReport is available
    if (typeof ed.memoryReport === "function") {
        const rep = ed.memoryReport();
        const over64 = rep && rep.mirrors && Object.values(rep.mirrors).some((bytes) => bytes > 64 * 1024 * 1024);
        check("no mirror over 64 MB", !over64, rep);
    }

    shell.closeDocument && shell.closeDocument(ed, { force: true });
    return { fails, tiles: !!ed.tileMode };
})()
"""

JS_MAPS = r"""
(async () => {
    const shell = await import("./shell.js");
    const { host } = await import("./editor/host.js");
    const { makeMap, sampleMap, fingerprint } = await import("./editor/inpaint_maps.js");
    const fails = [];
    const check = (name, ok, info) => {
        if (!ok) fails.push(name + (info !== undefined ? ": " + JSON.stringify(info).slice(0, 400) : ""));
    };
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const settle = async (ed) => { await ed.mipsSettled(); await new Promise((r) => setTimeout(r, 100)); };

    const W = 400, H = 300;
    const ed = shell.newDocument();
    shell.activate(ed);
    await new Promise((r) => setTimeout(r, 200));
    ed.resizeCanvas();

    const base = mk(W, H);
    {
        const x = base.getContext("2d");
        const g = x.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "#204060"); g.addColorStop(1, "#f0b080");
        x.fillStyle = g; x.fillRect(0, 0, W, H);
    }
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBaseFromCanvas(base, { keepLayers: false });
    await settle(ed);

    check("initial maps empty", !ed.maps || Object.keys(ed.maps).length === 0, ed.maps);

    // 1. Synthetic ramp setMap("depth", makeMap(...)) without model
    const mapW = 100, mapH = 75;
    const rampData = new Uint16Array(mapW * mapH);
    for (let y = 0; y < mapH; y++) {
        for (let x = 0; x < mapW; x++) {
            rampData[y * mapW + x] = Math.round((y * mapW + x) * 65535 / (mapW * mapH));
        }
    }
    const initXf = [W, 0, 0, H, 0, 0];
    const initialFpImg = (await host.pictureInput(ed, 64, 64, { skipFilters: true })).image;
    const initialFp = fingerprint(initialFpImg, 64, 64);
    const mapA = makeMap("depth", mapW, mapH, rampData, initXf, { label: "Ramp A", model: "synthetic", fp: initialFp });
    const setOk = await ed.setMap("depth", mapA);
    check("setMap returned true", setOk === true, setOk);
    check("ed.maps.depth is mapA", ed.maps && ed.maps.depth === mapA);

    // 2. rotate_canvas 90 and undo (xf turns and turns back, data untouched, sampleMap follows turn)
    const pt0 = [100, 60];
    const s0 = sampleMap(ed.maps.depth, pt0[0], pt0[1]);
    const dataRef0 = ed.maps.depth.data;

    await shell.commands.call("rotate_canvas", { doc: ed.node.id, angle: 90 });
    await settle(ed);
    check("rotate_canvas 90 width/height swapped", ed.width === H && ed.height === W, [ed.width, ed.height]);
    check("data untouched on rotate_canvas", ed.maps.depth.data === dataRef0);

    // (x, y) rotates to (H - y, x) = (300 - 60, 100) = (240, 100)
    const turnedPt = [H - pt0[1], pt0[0]];
    const sTurn = sampleMap(ed.maps.depth, turnedPt[0], turnedPt[1]);
    check("sampleMap at document point follows turn", Math.abs(sTurn - s0) < 1e-4, { s0, sTurn });

    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);
    check("undo restored width/height", ed.width === W && ed.height === H, [ed.width, ed.height]);
    check("data untouched after undo", ed.maps.depth.data === dataRef0);
    const sUndo = sampleMap(ed.maps.depth, pt0[0], pt0[1]);
    check("sampleMap at document point follows undo", Math.abs(sUndo - s0) < 1e-4, { s0, sUndo });

    // 3. Crop then extend (points outside footprint read edge value)
    await shell.commands.call("extend_canvas", { doc: ed.node.id, left: -50, top: -50, right: 0, bottom: 0 });
    await settle(ed);
    check("canvas cropped", ed.width === W - 50 && ed.height === H - 50, [ed.width, ed.height]);

    await shell.commands.call("extend_canvas", { doc: ed.node.id, left: 100, top: 100, right: 0, bottom: 0 });
    await settle(ed);
    check("canvas extended", ed.width === W + 50 && ed.height === H + 50, [ed.width, ed.height]);

    // Top-left of original footprint is now at (50, 50).
    // Point (10, 10) is outside the map's original footprint -> sampleMap clamps to (50, 50).
    const edgeVal = sampleMap(ed.maps.depth, 50, 50);
    const outsideVal = sampleMap(ed.maps.depth, 10, 10);
    check("points outside footprint read edge value", Math.abs(outsideVal - edgeVal) < 1e-4, { edgeVal, outsideVal });

    // Undo extend and crop
    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);
    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);
    check("restored after undo crop/extend", ed.width === W && ed.height === H);

    // 4. setMap, undo and redo swap the object
    const mapB = makeMap("depth", mapW, mapH, new Uint16Array(mapW * mapH).fill(42000), [W, 0, 0, H, 0, 0], { label: "Const B", fp: initialFp });
    await ed.setMap("depth", mapB);
    check("ed.maps.depth is mapB", ed.maps.depth === mapB);

    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);
    check("undo swaps back to mapA", ed.maps.depth === mapA);

    await shell.commands.call("redo", { doc: ed.node.id });
    await settle(ed);
    check("redo swaps back to mapB", ed.maps.depth === mapB);

    // 5. Persistence: .scumble save and open returns map bytes exactly (unpack equals original) and xf
    const scumblePath = __PATH_WITH_MAP__;
    const saveRes = await host.saveDocument(ed, { path: scumblePath, copy: true, history: false });
    check("saveDocument succeeded", saveRes && saveRes.bytes > 0, saveRes);

    const openRes = await host.openDocument(scumblePath);
    check("openDocument succeeded", openRes && openRes.editor, openRes);
    const edOpen = openRes ? openRes.editor : null;
    if (edOpen) {
        await settle(edOpen);
        check("opened document has maps.depth", edOpen.maps && edOpen.maps.depth);
        if (edOpen.maps && edOpen.maps.depth) {
            check("opened map w matches", edOpen.maps.depth.w === mapB.w);
            check("opened map h matches", edOpen.maps.depth.h === mapB.h);
            check("opened map xf matches", JSON.stringify(edOpen.maps.depth.xf) === JSON.stringify(mapB.xf));
            let byteMismatches = 0;
            for (let i = 0; i < mapB.data.length; i++) {
                if (edOpen.maps.depth.data[i] !== mapB.data[i]) byteMismatches++;
            }
            check("opened map unpack bytes exactly equal original", byteMismatches === 0, { byteMismatches });
        }
        shell.closeDocument && shell.closeDocument(edOpen, { force: true });
    }

    // 6. Autosave restore (the quit gate's restart pattern)
    const stateJson = ed.getValue();
    const edRestore = shell.newDocument();
    check("autosave restore created editor", !!edRestore);
    if (edRestore) {
        await edRestore.setValue(stateJson);
        await settle(edRestore);
        check("restored editor has maps.depth", edRestore.maps && edRestore.maps.depth);
        if (edRestore.maps && edRestore.maps.depth) {
            check("restored map w matches", edRestore.maps.depth.w === mapB.w);
            check("restored map h matches", edRestore.maps.depth.h === mapB.h);
            check("restored map xf matches", JSON.stringify(edRestore.maps.depth.xf) === JSON.stringify(mapB.xf));
            let byteMismatches = 0;
            for (let i = 0; i < mapB.data.length; i++) {
                if (edRestore.maps.depth.data[i] !== mapB.data[i]) byteMismatches++;
            }
            check("restored map unpack bytes exactly equal original", byteMismatches === 0, { byteMismatches });
        }
        shell.closeDocument && shell.closeDocument(edRestore, { force: true });
    }

    // 7. referencedFileKeys and removal
    host.closed = [];
    const refKeysWithMap = host.referencedFileKeys();
    const mapBKey = mapB.ref ? `${mapB.ref.type || "input"}/${mapB.ref.subfolder || ""}/${mapB.ref.filename}` : null;
    if (mapBKey) {
        check("referencedFileKeys includes mapB file", refKeysWithMap.includes(mapBKey), mapBKey);
    }

    // Remove map and save to scumbleWithoutMap
    await ed.setMap("depth", null);
    check("map removed from ed", !ed.maps || !ed.maps.depth);
    const scumbleNoMapPath = __PATH_WITHOUT_MAP__;
    await host.saveDocument(ed, { path: scumbleNoMapPath, copy: true, history: false });
    const refKeysWithoutMap = host.referencedFileKeys();
    if (mapBKey) {
        // the removal's undo step holds the map, and Ctrl+Z puts it back with its file: the clean-up keeps the file while
        // the step lives (review 2026-11-07 documents/D2+canvas-c/F1), the saved state no longer names it
        const st = JSON.parse(ed.getValue());
        check("the saved state no longer names the removed map", !(st.maps && st.maps.depth), st.maps);
        check("a removed map's file stays referenced while its undo step holds it", refKeysWithoutMap.includes(mapBKey), mapBKey);
        ed.clearUndo();
        check("removed map file drops out of referencedFileKeys once no undo step holds it", !host.referencedFileKeys().includes(mapBKey), mapBKey);
    }

    // 8. mapStale check
    await ed.setMap("depth", mapA);
    const staleFresh = await ed.mapStale("depth");
    check("mapStale returns false for unchanged picture", staleFresh.stale === false && staleFresh.diff <= 5, staleFresh);

    // Modify image to induce staleness
    const alteredCanvas = mk(W, H);
    {
        const ax = alteredCanvas.getContext("2d");
        ax.fillStyle = "#00ff00";
        ax.fillRect(0, 0, W, H);
    }
    const { Layer } = ed.pixels;
    const lAlert = ed.addLayer({ name: "Cover", kind: "paint", px: Layer.fromCanvas(alteredCanvas), x: 0, y: 0, w: W, h: H, dirty: true });
    await settle(ed);
    const staleModified = await ed.mapStale("depth");
    check("mapStale returns true when picture changes substantially", staleModified.stale === true && staleModified.diff > 10, staleModified);
    ed.removeLayer(lAlert.id);
    await settle(ed);

    // 9. load_image / setBaseFromCanvas clears maps
    Object.defineProperty(alteredCanvas, "naturalWidth", { value: W });
    Object.defineProperty(alteredCanvas, "naturalHeight", { value: H });
    await ed.setBaseFromCanvas(alteredCanvas, { keepLayers: false });
    await settle(ed);
    check("load_image / setBaseFromCanvas clears maps", !ed.maps || Object.keys(ed.maps).length === 0, ed.maps);

    shell.closeDocument && shell.closeDocument(ed, { force: true });
    return { fails, tiles: !!ed.tileMode };
})()
"""

# Third group "colour maps" (PLAN_SURFACE_PAINT.md SP1): an rgb16 map with every 16-bit value in each channel and an
# rgba8 map with every alpha, beside a depth map; set, undo, redo; a quarter turn and its undo; .scumble save and open
# and the autosave restore give every value back exactly, with the encoding and xf; the header asks for reader 7.
JS_COLOR = r"""
(async () => {
    const shell = await import("./shell.js");
    const { host } = await import("./editor/host.js");
    const { makeMap, sampleMapPx } = await import("./editor/inpaint_maps.js");
    const fails = [];
    const check = (name, ok, info) => {
        if (!ok) fails.push(name + (info !== undefined ? ": " + JSON.stringify(info).slice(0, 400) : ""));
    };
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const settle = async (ed) => { await ed.mipsSettled(); await new Promise((r) => setTimeout(r, 100)); };
    const same = (a, b) => {
        if (!a || !b || a.length !== b.length || a.constructor !== b.constructor) return { len: [a && a.length, b && b.length], type: [a && a.constructor.name, b && b.constructor.name] };
        let n = 0;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
        return n === 0 ? true : { mismatches: n };
    };

    const W = 512, H = 384;
    const ed = shell.newDocument();
    shell.activate(ed);
    await new Promise((r) => setTimeout(r, 200));
    ed.resizeCanvas();
    const base = mk(W, H);
    {
        const x = base.getContext("2d");
        const g = x.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "#305070"); g.addColorStop(1, "#e0a070");
        x.fillStyle = g; x.fillRect(0, 0, W, H);
    }
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBaseFromCanvas(base, { keepLayers: false });
    await settle(ed);

    // 256 x 256: each channel takes every 16-bit value once
    const sw = 256, shh = 256, sn = sw * shh;
    const rgb = new Uint16Array(sn * 3);
    for (let i = 0; i < sn; i++) { rgb[i * 3] = i; rgb[i * 3 + 1] = 65535 - i; rgb[i * 3 + 2] = (i * 7919) & 65535; }
    const shading = makeMap("shading", sw, shh, rgb, [W, 0, 0, H, 0, 0], { fp: "sp1" }, null, "rgb16");
    const nw = 128, nh = 96, nn = nw * nh;
    const nrm = new Uint8Array(nn * 4);
    for (let i = 0; i < nn; i++) { nrm[i * 4] = i & 255; nrm[i * 4 + 1] = (i >> 4) & 255; nrm[i * 4 + 2] = 255 - (i & 255); nrm[i * 4 + 3] = (i * 37) & 255; }
    const normals = makeMap("normals", nw, nh, nrm, [W, 0, 0, H, 0, 0], {}, null, "rgba8");
    const dep = new Uint16Array(64 * 48);
    for (let i = 0; i < dep.length; i++) dep[i] = (i * 21) & 65535;
    const depth = makeMap("depth", 64, 48, dep, [W, 0, 0, H, 0, 0], { fp: "d" });

    check("setMap depth", await ed.setMap("depth", depth) === true);
    check("setMap shading", await ed.setMap("shading", shading, { label: "Surface maps" }) === true);
    check("setMap normals", await ed.setMap("normals", normals, { label: "Surface maps" }) === true);
    check("the colour map has its file", !!(shading.ref && shading.ref.filename), shading.ref);
    check("the normal map has its file", !!(normals.ref && normals.ref.filename), normals.ref);

    // undo / redo swap the object, values untouched
    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);
    check("undo removes the normal map", !ed.maps.normals && ed.maps.shading === shading, Object.keys(ed.maps));
    await shell.commands.call("redo", { doc: ed.node.id });
    await settle(ed);
    check("redo puts it back", ed.maps.normals === normals);

    // a quarter turn turns xf, never the values; its undo turns it back
    const p0 = [130, 70];
    const v0 = sampleMapPx(ed.maps.shading, p0[0], p0[1]).slice();
    const n0 = sampleMapPx(ed.maps.normals, p0[0], p0[1]).slice();
    await shell.commands.call("rotate_canvas", { doc: ed.node.id, angle: 90 });
    await settle(ed);
    check("turn keeps the colour values", ed.maps.shading.data === shading.data && ed.maps.normals.data === normals.data);
    const vT = sampleMapPx(ed.maps.shading, H - p0[1], p0[0]);
    check("a colour map samples the turned point", vT.every((x, i) => Math.abs(x - v0[i]) < 1e-6), { v0, vT });
    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);
    const nU = sampleMapPx(ed.maps.normals, p0[0], p0[1]);
    check("the turn's undo brings the normal map's samples back", nU.every((x, i) => Math.abs(x - n0[i]) < 1e-6), { n0, nU });

    const compare = (label, e2) => {
        for (const [k, orig, enc] of [["shading", shading, "rgb16"], ["normals", normals, "rgba8"], ["depth", depth, "u16"]]) {
            const m = e2.maps && e2.maps[k];
            check(`${label}: ${k} is there`, !!m, Object.keys(e2.maps || {}));
            if (!m) continue;
            check(`${label}: ${k} encoding`, m.enc === enc, m.enc);
            check(`${label}: ${k} size`, m.w === orig.w && m.h === orig.h, [m.w, m.h]);
            check(`${label}: ${k} xf`, JSON.stringify(m.xf) === JSON.stringify(orig.xf), m.xf);
            check(`${label}: ${k} values exact`, same(m.data, orig.data) === true, same(m.data, orig.data));
        }
    };

    // .scumble save and open
    const path = __PATH_COLOR__;
    const saved = await host.saveDocument(ed, { path, copy: true, history: false });
    check("saveDocument with colour maps", saved && saved.bytes > 0, saved);
    const opened = await host.openDocument(path);
    const edOpen = opened ? opened.editor : null;
    check("openDocument with colour maps", !!edOpen, opened);
    if (edOpen) {
        await settle(edOpen);
        compare("opened", edOpen);
        shell.closeDocument && shell.closeDocument(edOpen, { force: true });
    }

    // the autosave restore
    const stateJson = ed.getValue();
    const st = JSON.parse(stateJson);
    check("the state names the encodings", st.maps && st.maps.shading && st.maps.shading.enc === "rgb16" && st.maps.normals.enc === "rgba8" && st.maps.depth.enc === "u16rg", st.maps);
    const edRestore = shell.newDocument();
    if (edRestore) {
        await edRestore.setValue(stateJson);
        await settle(edRestore);
        compare("restored", edRestore);
        shell.closeDocument && shell.closeDocument(edRestore, { force: true });
    }

    shell.closeDocument && shell.closeDocument(ed, { force: true });
    return { fails, tiles: !!ed.tileMode };
})()
"""


# Fourth group "surface maps" (PLAN_SURFACE_PAINT.md SP3) on a stand-in for host.surfaceAnalysis (the real set is
# 1.9 GB; tools/surface_test.js runs it): the models' check, the three maps at their sizes and encodings, the identity,
# a fresh set kept, force recomputes, one undo step, the views and the command, a turn during the analysis drops the
# maps, the autosave restore keeps the set's meta.
JS_SURFACE = r"""
(async () => {
    const shell = await import("./shell.js");
    const { host } = await import("./editor/host.js");
    const { surfaceModelSize } = await import("./editor/inpaint_surface.js");
    const fails = [];
    const check = (name, ok, info) => {
        if (!ok) fails.push(name + (info !== undefined ? ": " + JSON.stringify(info).slice(0, 400) : ""));
    };
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const settle = async (ed) => { await ed.mipsSettled(); await new Promise((r) => setTimeout(r, 100)); };
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };

    const realModels = host.surfaceModels, realAnalysis = host.surfaceAnalysis;
    const stand = { calls: 0, sizes: [], gate: null, entered: null };
    const fake = { intrinsic: { id: "stand_in", label: "a stand-in" }, normals: { id: "stand_in_n", label: "a stand-in" } };
    // a decomposition the joint fit can explain: S a ramp from 0.3 to 1.2 (light above 1), R 0.02, A = (I - R) / S
    host.surfaceModels = () => fake;
    host.surfaceAnalysis = async (editor, { image, width, height }) => {
        stand.calls++;
        stand.sizes.push([width, height]);
        if (stand.entered) { stand.entered(); stand.entered = null; }
        if (stand.gate) await stand.gate;
        const n = width * height;
        const albedo = new Float32Array(n * 3), shading = new Float32Array(n * 3), residual = new Float32Array(n * 3);
        const normal = new Float32Array(n * 3), points = new Float32Array(n * 3), mask = new Float32Array(n);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const i = y * width + x, s = 0.3 + 0.9 * x / (width - 1);
            for (let c = 0; c < 3; c++) {
                const I = lin(image[4 * i + c]);
                shading[3 * i + c] = s;
                residual[3 * i + c] = Math.min(0.02, I);
                albedo[3 * i + c] = Math.max(0, Math.min(1, (I - residual[3 * i + c]) / s));
            }
            normal[3 * i + 2] = -1;   // facing the viewer (x right, y down, z away)
            mask[i] = 1;
        }
        return {
            intrinsic: { albedo, shading, residual, provider: "stand-in", model: "stand_in" },
            normals: { normal, points, mask, scale: 1, provider: "stand-in", model: "stand_in_n" },
        };
    };
    try {
        const W = 1600, H = 1000;
        const ed = shell.newDocument();
        shell.activate(ed);
        await new Promise((r) => setTimeout(r, 200));
        ed.resizeCanvas();
        const base = mk(W, H);
        {
            const x = base.getContext("2d");
            const g = x.createLinearGradient(0, 0, W, H);
            g.addColorStop(0, "#284868"); g.addColorStop(1, "#e8b080");
            x.fillStyle = g; x.fillRect(0, 0, W, H);
            for (let i = 0; i < 6; i++) { x.fillStyle = `hsl(${i * 60},55%,50%)`; x.fillRect(120 + i * 230, 200 + (i % 2) * 300, 180, 260); }
        }
        Object.defineProperty(base, "naturalWidth", { value: W });
        Object.defineProperty(base, "naturalHeight", { value: H });
        await ed.setBaseFromCanvas(base, { keepLayers: false });
        await settle(ed);

        // no models: the sentence, no maps
        host.surfaceModels = () => ({ intrinsic: null, normals: fake.normals });
        let err = null;
        try { await ed.computeSurfaceMaps(); } catch (e) { err = e; }
        check("without the decomposition model it refuses with the sentence", err && /Marigold IID Lighting/.test(err.message), err && err.message);
        host.surfaceModels = () => ({ intrinsic: fake.intrinsic, normals: null });
        err = null;
        try { await ed.computeSurfaceMaps(); } catch (e) { err = e; }
        check("without a normal model it refuses with the sentence", err && /MoGe-2/.test(err.message), err && err.message);
        check("no maps after the refusals", !ed.hasSurfaceMaps() && stand.calls === 0, { calls: stand.calls });
        host.surfaceModels = () => fake;

        // the set: sizes, encodings, xf, the identity, the normals' bytes
        const [mw, mh] = surfaceModelSize(W, H);
        const steps0 = ed.undo.length;
        const p1 = ed.computeSurfaceMaps();
        const p2 = ed.computeSurfaceMaps();
        const info = await p1;
        check("a second call during the run gets the same answer", (await p2) === info);
        check("the analysis ran once at the model's size", stand.calls === 1 && stand.sizes[0][0] === mw && stand.sizes[0][1] === mh, stand.sizes);
        check("info present", info && info.present === true, info);
        check("the light and the reflections at the work size", JSON.stringify(info.size) === JSON.stringify([W, H]), info.size);
        check("the normals at the model's size", JSON.stringify(info.normalsSize) === JSON.stringify([mw, mh]), info.normalsSize);
        const s = ed.maps.shading, r = ed.maps.residual, nm = ed.maps.normals;
        check("encodings", s.enc === "rgb16" && r.enc === "rgb16" && nm.enc === "rgba8", [s.enc, r.enc, nm.enc]);
        const xf = JSON.stringify([W, 0, 0, H, 0, 0]);
        check("every map has the document's xf", [s, r, nm].every((m) => JSON.stringify(m.xf) === xf), [s.xf, r.xf, nm.xf]);
        check("the light's scale is kept", s.meta && s.meta.sScale > 0 && s.meta.fp, s.meta);
        check("the identity within one level", info.identity && info.identity.maxLevels <= 1, info.identity);
        const k = 4 * (Math.floor(mh / 2) * mw + Math.floor(mw / 3));
        check("the normals packed as (n + 1) / 2 with the mask", [nm.data[k], nm.data[k + 1], nm.data[k + 2], nm.data[k + 3]].join() === "128,128,0,255", Array.from(nm.data.slice(k, k + 4)));
        check("the files uploaded", [s, r, nm].every((m) => m.ref && m.ref.filename), [s.ref, r.ref, nm.ref]);
        check("one undo step for the three maps", ed.undo.length === steps0 + 1, [steps0, ed.undo.length]);

        // a fresh set is kept, force recomputes
        const again = await ed.computeSurfaceMaps();
        check("a fresh set is kept", stand.calls === 1 && ed.maps.shading === s && again && again.present, { calls: stand.calls });
        const forced = await shell.commands.call("surface_maps", { doc: ed.node.id, force: true });
        check("force recomputes", stand.calls === 2 && ed.maps.shading !== s && forced.ok && forced.result.present, { calls: stand.calls, forced });
        const s2 = ed.maps.shading;

        // the views and the command
        const v = await shell.commands.call("surface_maps", { doc: ed.node.id, view: "residual" });
        check("the command's view", v.ok && v.result.view === "residual" && ed.mapView === "residual" && stand.calls === 2, [v, ed.mapView, stand.calls]);
        check("the view shows the map on the screen", ed.setSurfaceView("normals") === "normals" && !!ed.surfaceProxy("normals"));
        check("the picture again", !ed.setSurfaceView("none") && !ed.mapView, ed.mapView);

        // undo takes the recompute's three maps back at once, a second undo all of them, redo brings them
        await shell.commands.call("undo", { doc: ed.node.id });
        await settle(ed);
        check("undo brings the first set back, all three", ed.maps.shading === s && ed.maps.residual === r && ed.maps.normals === nm);
        await shell.commands.call("undo", { doc: ed.node.id });
        await settle(ed);
        check("a second undo removes the three", !ed.maps.shading && !ed.maps.residual && !ed.maps.normals, Object.keys(ed.maps || {}));
        await shell.commands.call("redo", { doc: ed.node.id });
        await shell.commands.call("redo", { doc: ed.node.id });
        await settle(ed);
        check("redo brings the recomputed set", ed.maps.shading === s2 && ed.hasSurfaceMaps());

        // the autosave restore keeps the set and its meta
        const edRestore = shell.newDocument();
        await edRestore.setValue(ed.getValue());
        await settle(edRestore);
        const rs = edRestore.maps && edRestore.maps.shading;
        check("restored: the three maps", edRestore.hasSurfaceMaps(), Object.keys(edRestore.maps || {}));
        check("restored: the light's scale and fingerprint", rs && rs.meta && rs.meta.sScale === s2.meta.sScale && rs.meta.fp === s2.meta.fp, rs && rs.meta);
        shell.closeDocument && shell.closeDocument(edRestore, { force: true });

        // a turn while the model runs drops the maps
        await shell.commands.call("undo", { doc: ed.node.id });
        await shell.commands.call("undo", { doc: ed.node.id });
        await settle(ed);
        let release;
        stand.gate = new Promise((res) => { release = res; });
        const entered = new Promise((res) => { stand.entered = res; });
        const pT = ed.computeSurfaceMaps();
        await entered;
        await shell.commands.call("rotate_canvas", { doc: ed.node.id, angle: 90 });
        release();
        stand.gate = null;
        const dropped = await pT;
        check("a turn during the analysis drops the maps", dropped === null && !ed.hasSurfaceMaps(), { dropped, maps: Object.keys(ed.maps || {}) });
        check("the status says why", /dropped/.test(String(ed.status || "")), ed.status);

        shell.closeDocument && shell.closeDocument(ed, { force: true });
        return { fails, tiles: !!ed.tileMode };
    } finally {
        host.surfaceModels = realModels;
        host.surfaceAnalysis = realAnalysis;
    }
})()
"""


async def run(c):
    # 1. picture_input group
    r1 = await c.eval(JS_PICTURE_INPUT, timeout=300)
    fails1 = r1.get("fails", [])
    for f in fails1:
        print("[FAIL picture_input]", f)
    if not fails1:
        print(f"[ok] picture_input on {'tiles' if r1.get('tiles') else 'canvas'}")

    # 2. maps group
    tmp_dir = os.path.join(tempfile.gettempdir(), f"maps_test_{os.getpid()}").replace("\\", "/")
    os.makedirs(tmp_dir, exist_ok=True)
    scumble_with_map = f"{tmp_dir}/test_with_map.scumble"
    scumble_without_map = f"{tmp_dir}/test_without_map.scumble"

    fails2 = []
    r2 = {}
    try:
        js_maps = JS_MAPS.replace("__PATH_WITH_MAP__", json.dumps(scumble_with_map)).replace("__PATH_WITHOUT_MAP__", json.dumps(scumble_without_map))
        r2 = await c.eval(js_maps, timeout=300)
        fails2 = r2.get("fails", [])
        for f in fails2:
            print("[FAIL maps]", f)

        # Check zip header versions in Python
        if os.path.exists(scumble_with_map):
            with zipfile.ZipFile(scumble_with_map, "r") as z:
                hdr = json.loads(z.read("scumble/document.json").decode("utf-8"))
                if hdr.get("version") != 2:
                    fails2.append(f"document with map: expected version 2, got {hdr.get('version')}")
                if hdr.get("minReader") != 1:
                    fails2.append(f"document with map: expected minReader 1, got {hdr.get('minReader')}")

        if os.path.exists(scumble_without_map):
            with zipfile.ZipFile(scumble_without_map, "r") as z:
                hdr = json.loads(z.read("scumble/document.json").decode("utf-8"))
                if hdr.get("version") != 1:
                    fails2.append(f"document without map: expected version 1, got {hdr.get('version')}")
                if hdr.get("minReader") != 1:
                    fails2.append(f"document without map: expected minReader 1, got {hdr.get('minReader')}")
    finally:
        for p in [scumble_with_map, scumble_without_map]:
            if os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass
        try:
            os.rmdir(tmp_dir)
        except OSError:
            pass

    if not fails2:
        print(f"[ok] maps on {'tiles' if r2.get('tiles') else 'canvas'}")

    # 3. colour maps group
    tmp3 = os.path.join(tempfile.gettempdir(), f"maps_color_{os.getpid()}").replace("\\", "/")
    os.makedirs(tmp3, exist_ok=True)
    scumble_color = f"{tmp3}/test_color_maps.scumble"
    fails3 = []
    r3 = {}
    try:
        r3 = await c.eval(JS_COLOR.replace("__PATH_COLOR__", json.dumps(scumble_color)), timeout=300)
        fails3 = list(r3.get("fails", []))
        if os.path.exists(scumble_color):
            with zipfile.ZipFile(scumble_color, "r") as z:
                hdr = json.loads(z.read("scumble/document.json").decode("utf-8"))
                if hdr.get("version") != 2 or hdr.get("minReader") != 7:
                    fails3.append(f"document with colour maps: expected version 2 / minReader 7, got {hdr.get('version')} / {hdr.get('minReader')}")
                encs = {k: (m or {}).get("enc") for k, m in ((hdr.get("document") or {}).get("maps") or {}).items()}
                if encs != {"depth": "u16rg", "shading": "rgb16", "normals": "rgba8"}:
                    fails3.append(f"the stored encodings: {encs}")
        else:
            fails3.append("no .scumble with colour maps was written")
    finally:
        if os.path.exists(scumble_color):
            try:
                os.remove(scumble_color)
            except OSError:
                pass
        try:
            os.rmdir(tmp3)
        except OSError:
            pass
    for f in fails3:
        print("[FAIL colour maps]", f)
    if not fails3:
        print(f"[ok] colour maps on {'tiles' if r3.get('tiles') else 'canvas'}")

    # 4. surface maps group
    r4 = await c.eval(JS_SURFACE, timeout=300)
    fails4 = list(r4.get("fails", []))
    for f in fails4:
        print("[FAIL surface maps]", f)
    if not fails4:
        print(f"[ok] surface maps on {'tiles' if r4.get('tiles') else 'canvas'}")

    return not fails1 and not fails2 and not fails3 and not fails4


def main():
    sys.stdout.reconfigure(encoding="utf-8")

    # 1. Run Node unit test
    print("Running node tools/maps_test.js...")
    node_cmd = sys.executable.replace("python.exe", "node.exe") if os.path.exists(sys.executable.replace("python.exe", "node.exe")) else "node"
    res = subprocess.run([node_cmd, os.path.join(HERE, "maps_test.js")])
    if res.returncode != 0:
        print("[FAIL] node tools/maps_test.js failed with code", res.returncode)
        sys.exit(res.returncode)
    print("[ok] node maps_test.js passed")

    if "--node-only" in sys.argv:
        print("PASS")
        sys.exit(0)

    # 2. Run CDP integration test
    launch = "--launch" in sys.argv
    proc = None
    if launch:
        electron = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")
        prof = os.path.join(tempfile.gettempdir(), f"maps_prof_{os.getpid()}")
        os.makedirs(prof, exist_ok=True)
        env = dict(os.environ)
        if "--tiles" in sys.argv:
            idx = sys.argv.index("--tiles")
            if idx + 1 < len(sys.argv):
                env["SCUMBLE_TILES"] = "1" if sys.argv[idx + 1] == "on" else "0"
        proc = subprocess.Popen([electron, ".", "--remote-debugging-port=9555", f"--user-data-dir={prof}", "--no-comfy"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        import time
        for _ in range(30):
            try:
                import urllib.request
                urllib.request.urlopen("http://127.0.0.1:9555/json/version", timeout=1)
                break
            except Exception:
                time.sleep(0.5)

    try:
        ok = asyncio.run(session(run))
        if not ok:
            print("FAIL")
            sys.exit(1)
    except Exception as e:
        print(f"[FAIL] CDP test failed: {e}")
        print("FAIL")
        sys.exit(1)
    finally:
        if proc:
            try:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
            except Exception:
                pass

    print("PASS")
    sys.exit(0)


if __name__ == "__main__":
    main()
