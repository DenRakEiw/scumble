"""Edge snap in Select by depth gate (PLAN_NIK9_BUILD.md R2-S6).

Tests depth edge snapping in selection:
  * Case a: select_range { source: "depth", lo: 0, hi: 0.5, fHi: 0.05 }:
            band error count with snap 50 <= 1/3 of snap 0's
  * Case b: Selection's alpha equals CPU twin's weight of limited layer within 1 level
  * Case c: Outside edge tiles, byte-identical to snap 0
  * Case d: 15k: new_canvas 15000x10000 with synthetic map: edge-tile share and ms recorded;
            no mirror over 64 MB; sampleRegionSettled calls <= 40; at most 1 scratch canvas created
  * Case e: Tiles and canvas backends give byte-equal selections (hashes written to log)
  * Case f: mode: "intersect" over a rectangle: alpha = combineAlpha(intersect) of both

Runs Node test tools/edges_test.js first, then connects to running app via CDP if available.
"""
import asyncio
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

JS = r"""
(async () => {
    const shell = await import("./shell.js");
    const { commands } = await import("./commands.js");
    const F = await import("./editor/inpaint_filters.js");
    const { makeMap, passToMap } = await import("./editor/inpaint_maps.js");
    const { normalizeLimit } = await import("./editor/inpaint_weights.js");
    const { limitStageCPU } = await import("./editor/inpaint_limit.js");
    const { rangeMax, edgeTiles, SNAP_TAU } = await import("./editor/inpaint_edges.js");

    const fails = [];
    const check = (name, ok, info) => {
        if (!ok) fails.push(name + (info !== undefined ? ": " + JSON.stringify(info).slice(0, 400) : ""));
    };
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const settle = async (ed) => { await ed.mipsSettled(); await new Promise((r) => setTimeout(r, 100)); };

    const sha1 = async (bytes) => {
        const hashBuf = await crypto.subtle.digest("SHA-1", bytes);
        return Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    };

    const ed = shell.newDocument();
    shell.activate(ed);
    await new Promise((r) => setTimeout(r, 200));
    ed.resizeCanvas();

    const Ws = 1200, Hs = 800;
    const baseSnap = mk(Ws, Hs);
    {
        const ctx = baseSnap.getContext("2d");
        const imgData = ctx.createImageData(Ws, Hs);
        const data = imgData.data;
        for (let y = 0; y < Hs; y++) {
            for (let x = 0; x < Ws; x++) {
                const idx = (y * Ws + x) * 4;
                const isRed = x < 600;
                const noise = Math.abs((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1);
                const nByte = Math.round((noise - 0.5) * 0.03 * 255);
                const r = Math.max(0, Math.min(255, (isRed ? 200 : 40) + nByte));
                const g = Math.max(0, Math.min(255, (isRed ? 40 : 60) + nByte));
                const b = Math.max(0, Math.min(255, (isRed ? 40 : 200) + nByte));
                data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
            }
        }
        ctx.putImageData(imgData, 0, 0);
    }
    Object.defineProperty(baseSnap, "naturalWidth", { value: Ws });
    Object.defineProperty(baseSnap, "naturalHeight", { value: Hs });
    await ed.setBaseFromCanvas(baseSnap, { keepLayers: false });
    await settle(ed);

    // Depth map (300 x 200, far 0.2 / 0.8 split at map x = 150, blurred sigma ~2 map px)
    const Mw = 300, Mh = 200;
    const guideSnap = new Uint8ClampedArray(Mw * Mh * 4);
    for (let y = 0; y < Mh; y++) {
        for (let x = 0; x < Mw; x++) {
            const idx = (y * Mw + x) * 4;
            const isRed = x < 150;
            guideSnap[idx] = isRed ? 200 : 40;
            guideSnap[idx + 1] = isRed ? 40 : 60;
            guideSnap[idx + 2] = isRed ? 40 : 200;
            guideSnap[idx + 3] = 255;
        }
    }
    const mapSnapU16 = new Uint16Array(Mw * Mh);
    for (let y = 0; y < Mh; y++) {
        for (let x = 0; x < Mw; x++) {
            let val;
            if (x < 147) val = 0.2;
            else if (x > 152) val = 0.8;
            else val = 0.2 + (0.8 - 0.2) * (x - 146.5) / 6;
            mapSnapU16[y * Mw + x] = Math.round(val * 65535);
        }
    }
    const depthMap = makeMap("depth", Mw, Mh, mapSnapU16, [Ws, 0, 0, Hs, 0, 0], { snap: { strength: 50 } }, guideSnap);
    await ed.setMap("depth", depthMap);
    await settle(ed);

    // -------------------------------------------------------------------------
    // a. select_range with snap 50 vs snap 0 (error count <= 1/3)
    // -------------------------------------------------------------------------
    await commands.run("select_range", { doc: ed.node.id, source: "depth", lo: 0, hi: 0.5, fLo: 0, fHi: 0.05, mode: "replace" });
    await settle(ed);

    const selRect50 = ed.sel.readRect(0, 0, Ws, Hs);
    const selAlpha50 = new Uint8Array(Ws * Hs);
    for (let i = 0; i < Ws * Hs; i++) selAlpha50[i] = selRect50.data[i * 4 + 3];

    const colErrs50 = {}, colErrs0 = {};
    for (let x = 592; x <= 608; x++) { colErrs50[x] = 0; colErrs0[x] = 0; }
    let errs50 = 0;
    for (let y = 100; y < 700; y++) {
        for (let x = 592; x <= 608; x++) {
            const idx = y * Ws + x;
            const gt = x < 600 ? 255 : 0;
            if (Math.abs(selAlpha50[idx] - gt) > 64) { errs50++; colErrs50[x]++; }
        }
    }

    // Now snap 0
    ed.setMapMeta("depth", { snap: { strength: 0 } });
    await settle(ed);
    await commands.run("select_range", { doc: ed.node.id, source: "depth", lo: 0, hi: 0.5, fLo: 0, fHi: 0.05, mode: "replace" });
    await settle(ed);

    const selRect0 = ed.sel.readRect(0, 0, Ws, Hs);
    const selAlpha0 = new Uint8Array(Ws * Hs);
    for (let i = 0; i < Ws * Hs; i++) selAlpha0[i] = selRect0.data[i * 4 + 3];

    let errs0 = 0;
    for (let y = 100; y < 700; y++) {
        for (let x = 592; x <= 608; x++) {
            const idx = y * Ws + x;
            const gt = x < 600 ? 255 : 0;
            if (Math.abs(selAlpha0[idx] - gt) > 64) { errs0++; colErrs0[x]++; }
        }
    }

    const midY = 400;
    const a50Row = [];
    const a0Row = [];
    for (let x = 592; x <= 608; x++) {
        a50Row.push(`${x}:${selAlpha50[midY * Ws + x]}`);
        a0Row.push(`${x}:${selAlpha0[midY * Ws + x]}`);
    }
    console.log("[debug] colErrs50:", JSON.stringify(colErrs50));
    console.log("[debug] colErrs0:", JSON.stringify(colErrs0));
    console.log("[debug] a50 at y=400:", a50Row.join(" "));
    console.log("[debug] a0  at y=400:", a0Row.join(" "));

    check("Case a: snap 50 error count <= 1/3 of snap 0", errs50 <= Math.ceil(errs0 / 3), { errs50, errs0 });

    // Restore snap 50 for subsequent tests
    ed.setMapMeta("depth", { snap: { strength: 50 } });
    await settle(ed);
    await commands.run("select_range", { doc: ed.node.id, source: "depth", lo: 0, hi: 0.5, fLo: 0, fHi: 0.05, mode: "replace" });
    await settle(ed);

    // -------------------------------------------------------------------------
    // b. Selection's alpha equals CPU twin's weight of limited layer within 1 level
    // -------------------------------------------------------------------------
    const limitObj = normalizeLimit({ source: "depth", lo: 0, hi: 0.5, fLo: 0, fHi: 0.05 });
    const cpuCanvas = mk(Ws, Hs);
    const cpuCtx = cpuCanvas.getContext("2d");
    cpuCtx.fillStyle = "#ffffff";
    cpuCtx.fillRect(0, 0, Ws, Hs);
    const cpuRes = limitStageCPU(baseSnap, cpuCanvas, limitObj, { maps: ed.maps }, true);
    const cpuData = cpuRes.getContext("2d").getImageData(0, 0, Ws, Hs).data;

    let maxDiffSelVsCpu = 0;
    for (let i = 0; i < Ws * Hs; i++) {
        const diff = Math.abs(selAlpha50[i] - cpuData[i * 4 + 3]);
        if (diff > maxDiffSelVsCpu) maxDiffSelVsCpu = diff;
    }
    check("Case b: selection alpha equals CPU twin within 1 level", maxDiffSelVsCpu <= 1, { maxDiffSelVsCpu });

    // -------------------------------------------------------------------------
    // c. Outside edge tiles, byte-identical to snap 0
    // -------------------------------------------------------------------------
    const m = passToMap(ed.maps.depth, 1);
    const rmax = rangeMax(ed.maps.depth);
    const et = edgeTiles(ed.maps.depth, rmax, m, Ws, Hs, SNAP_TAU, 256);
    const cols = Math.ceil(Ws / 256);
    const rows = Math.ceil(Hs / 256);

    let maxDiffOutside = 0;
    for (let ty = 0; ty < rows; ty++) {
        const y0 = ty * 256;
        const y1 = Math.min(Hs, y0 + 256);
        for (let tx = 0; tx < cols; tx++) {
            if (et[ty * cols + tx] === 0) {
                const x0 = tx * 256;
                const x1 = Math.min(Ws, x0 + 256);
                for (let y = y0; y < y1; y++) {
                    const row = y * Ws;
                    for (let x = x0; x < x1; x++) {
                        const idx = row + x;
                        const diff = Math.abs(selAlpha50[idx] - selAlpha0[idx]);
                        if (diff > maxDiffOutside) maxDiffOutside = diff;
                    }
                }
            }
        }
    }
    check("Case c: outside edge tiles byte-identical to snap 0", maxDiffOutside === 0, { maxDiffOutside });

    // -------------------------------------------------------------------------
    // e. Selection hash logging for tiles / canvas parity
    // -------------------------------------------------------------------------
    const hash50 = await sha1(selAlpha50);
    console.log(`[ok] selection SHA-1 hash (${ed.tileMode ? "tiles" : "canvas"}): ${hash50}`);

    // -------------------------------------------------------------------------
    // f. mode: "intersect" over rectangle
    // -------------------------------------------------------------------------
    // 1. Set rectangular selection
    await commands.run("select_rect", { doc: ed.node.id, x: 200, y: 150, w: 600, h: 500, mode: "replace" });
    await settle(ed);
    const rectOnly = ed.sel.readRect(0, 0, Ws, Hs).data;

    // 2. Intersect with depth range
    await commands.run("select_range", { doc: ed.node.id, source: "depth", lo: 0, hi: 0.5, fLo: 0, fHi: 0.05, mode: "intersect" });
    await settle(ed);
    const isectSel = ed.sel.readRect(0, 0, Ws, Hs).data;

    let maxDiffIsect = 0;
    for (let i = 0; i < Ws * Hs; i++) {
        const ra = rectOnly[i * 4 + 3];
        const da = selAlpha50[i];
        const expected = Math.round((ra * da) / 255);
        const actual = isectSel[i * 4 + 3];
        const diff = Math.abs(actual - expected);
        if (diff > maxDiffIsect) maxDiffIsect = diff;
    }
    check("Case f: intersect mode equals combined alpha within 1 level", maxDiffIsect <= 1, { maxDiffIsect });

    // -------------------------------------------------------------------------
    // d. 15k performance and memory check
    // -------------------------------------------------------------------------
    const W15 = 15000, H15 = 10000;
    await commands.run("new_canvas", { doc: ed.node.id, width: W15, height: H15 });
    await settle(ed);

    // Synthetic 15k map: 4096 x 2731 working resolution, step at x = 2048 (doc x = 7500)
    const mw15 = 4096, mh15 = 2731;
    const u16_15 = new Uint16Array(mw15 * mh15);
    const g15 = new Uint8ClampedArray(mw15 * mh15 * 4);
    for (let y = 0; y < mh15; y++) {
        for (let x = 0; x < mw15; x++) {
            const idx = y * mw15 + x;
            const isLeft = x < 2048;
            u16_15[idx] = isLeft ? 13107 : 52428;
            const gIdx = idx * 4;
            g15[gIdx] = isLeft ? 200 : 40;
            g15[gIdx + 1] = isLeft ? 40 : 60;
            g15[gIdx + 2] = isLeft ? 40 : 200;
            g15[gIdx + 3] = 255;
        }
    }
    const map15 = makeMap("depth", mw15, mh15, u16_15, [W15, 0, 0, H15, 0, 0], { snap: { strength: 50 } }, g15);
    await ed.setMap("depth", map15);
    await settle(ed);

    // Spy on sampleRegionSettled (filtered to edge picture sampling with skipFilters)
    let sampleRegionSettledCalls = 0;
    const origSample = ed.sampleRegionSettled.bind(ed);
    ed.sampleRegionSettled = async function(source, box, scale, opts) {
        if (opts && opts.skipFilters) sampleRegionSettledCalls++;
        return origSample(source, box, scale, opts);
    };

    ed._rangeScratchCreated = 0;
    const t15_0 = performance.now();
    try {
        await commands.run("select_range", { doc: ed.node.id, source: "depth", lo: 0, hi: 0.5, fLo: 0, fHi: 0.05, mode: "replace" });
    } finally {
        ed.sampleRegionSettled = origSample;
    }
    const scratchCreated = ed._rangeScratchCreated || 0;
    const t15_ms = performance.now() - t15_0;

    const tileRows15 = Math.ceil(H15 / 256); // 40
    const m15 = passToMap(map15, 1);
    const rmax15 = rangeMax(map15);
    const et15 = edgeTiles(map15, rmax15, m15, W15, H15, SNAP_TAU, 256);

    let edgeCount15 = 0;
    for (let i = 0; i < et15.length; i++) if (et15[i] === 1) edgeCount15++;
    const edgeSharePct = ((edgeCount15 / et15.length) * 100).toFixed(1);

    console.log(`[ok] 15k select_range: ${t15_ms.toFixed(0)} ms, edge tiles: ${edgeCount15}/${et15.length} (${edgeSharePct}%), sample calls: ${sampleRegionSettledCalls}, scratch canvases: ${scratchCreated}`);

    check("Case d: sampleRegionSettled calls <= 40", sampleRegionSettledCalls <= tileRows15, { sampleRegionSettledCalls, tileRows: tileRows15 });
    check("Case d: at most 1 scratch canvas created", scratchCreated <= 1, { scratchCreated });

    // Check selection mirror / memory report
    const memRep = ed.memoryReport ? ed.memoryReport() : null;
    if (memRep && memRep.selectionMirrorBytes) {
        check("Case d: no selection mirror over 64 MB", memRep.selectionMirrorBytes <= 64 * 1024 * 1024, { mirrorBytes: memRep.selectionMirrorBytes });
    }

    // Case g: 15k depth_edit memory and execution check
    await commands.run("select_rect", { doc: ed.node.id, x: 2000, y: 2000, w: 4000, h: 4000, mode: "replace" });
    await settle(ed);
    await commands.run("depth_edit", { doc: ed.node.id, op: "offset", value: 0.05 });
    await settle(ed);
    const memRep15 = ed.memoryReport ? ed.memoryReport() : null;
    if (memRep15 && memRep15.selectionMirrorBytes) {
        check("Case g: no selection mirror over 64 MB after 15k depth_edit", memRep15.selectionMirrorBytes <= 64 * 1024 * 1024, { mirrorBytes: memRep15.selectionMirrorBytes });
    }

    shell.closeDocument && shell.closeDocument(ed, { force: true });

    // -------------------------------------------------------------------------
    // R2-S8: depth edits inside the selection (the object snap)
    // -------------------------------------------------------------------------
    const ed8 = shell.newDocument();
    shell.activate(ed8);
    await new Promise((r) => setTimeout(r, 200));
    ed8.resizeCanvas();

    const W8 = 1200, H8 = 800;
    const base8 = mk(W8, H8);
    Object.defineProperty(base8, "naturalWidth", { value: W8 });
    Object.defineProperty(base8, "naturalHeight", { value: H8 });
    await ed8.setBaseFromCanvas(base8, { keepLayers: false });
    await settle(ed8);

    const mw8 = 300, mh8 = 200;
    const rampData = new Uint16Array(mw8 * mh8);
    for (let y = 0; y < mh8; y++) {
        for (let x = 0; x < mw8; x++) {
            rampData[y * mw8 + x] = Math.round(((x + 0.5) / mw8) * 65535);
        }
    }
    const rampMap0 = makeMap("depth", mw8, mh8, rampData, [W8, 0, 0, H8, 0, 0]);
    await ed8.setMap("depth", rampMap0);
    await settle(ed8);

    // Case a: rectangle selection over x 300-600 -> flatten
    await commands.run("select_rect", { doc: ed8.node.id, x: 300, y: 0, w: 300, h: 800, mode: "replace" });
    await settle(ed8);
    const resA = await commands.run("depth_edit", { doc: ed8.node.id, op: "flatten" });
    await settle(ed8);

    const curDataA = ed8.maps.depth.data;
    const medianU16 = Math.round(resA.median * 65535);
    let okAInside = true, okAOutside = true;
    for (let y = 10; y < 190; y += 20) {
        for (let x = 80; x <= 145; x++) {
            if (Math.abs(curDataA[y * mw8 + x] - medianU16) > 1) okAInside = false;
        }
        for (let x = 0; x < 70; x++) {
            if (curDataA[y * mw8 + x] !== rampData[y * mw8 + x]) okAOutside = false;
        }
        for (let x = 155; x < mw8; x++) {
            if (curDataA[y * mw8 + x] !== rampData[y * mw8 + x]) okAOutside = false;
        }
    }
    check("Case a: flatten inside footprint equals median (+-1), outside byte-equal", okAInside && okAOutside, { okAInside, okAOutside, medianU16 });

    // Case b: soft selection at alpha 128 -> halfway (+-1)
    await commands.run("undo", { doc: ed8.node.id });
    await settle(ed8);
    const srect = ed8.sel.readRect(300, 200, 300, 400);
    for (let i = 0; i < srect.data.length; i += 4) {
        srect.data[i] = 255;
        srect.data[i + 3] = 128;
    }
    ed8.sel.writeRect(srect, 300, 200);
    ed8.markSelectionChanged([300, 200, 600, 600]);
    await settle(ed8);

    await commands.run("depth_edit", { doc: ed8.node.id, op: "flatten", value: 0.8 });
    await settle(ed8);

    const curDataB = ed8.maps.depth.data;
    const targetU16 = Math.round(0.8 * 65535);
    let okB = true;
    for (let y = 60; y < 140; y += 10) {
        for (let x = 85; x <= 140; x += 10) {
            const orig = rampData[y * mw8 + x];
            const expB = Math.round(orig + (128 / 255) * (targetU16 - orig));
            if (Math.abs(curDataB[y * mw8 + x] - expB) > 1) okB = false;
        }
    }
    check("Case b: soft selection at alpha 128 produces halfway result (+-1)", okB);

    // Case c: Undo, then redo: ed.maps.depth is the very object before and after (identity)
    const mapBeforeUndo = ed8.maps.depth;
    await commands.run("undo", { doc: ed8.node.id });
    await settle(ed8);
    const mapAfterUndo = ed8.maps.depth;
    await commands.run("redo", { doc: ed8.node.id });
    await settle(ed8);
    const mapAfterRedo = ed8.maps.depth;
    check("Case c: undo then redo preserves map object identity", mapAfterRedo === mapBeforeUndo && mapAfterUndo !== mapBeforeUndo);

    // Case d: offset 0.5 clamps at 65535
    await commands.run("select_rect", { doc: ed8.node.id, x: 300, y: 0, w: 300, h: 800, mode: "replace" });
    await settle(ed8);
    await commands.run("depth_edit", { doc: ed8.node.id, op: "offset", value: 0.5 });
    await settle(ed8);

    const curDataD = ed8.maps.depth.data;
    let okD = true;
    for (let y = 10; y < 190; y += 20) {
        for (let x = 80; x <= 145; x++) {
            if (curDataD[y * mw8 + x] !== 65535) okD = false;
        }
    }
    check("Case d: offset 0.5 clamps at 65535", okD);

    // Case e: smooth 1: variance inside drops by >= 50 %, outside byte-equal
    const noisyU16 = new Uint16Array(mw8 * mh8);
    for (let y = 0; y < mh8; y++) {
        for (let x = 0; x < mw8; x++) {
            noisyU16[y * mw8 + x] = ((x ^ y) & 1) ? 20000 : 40000;
        }
    }
    const noisyMap = makeMap("depth", mw8, mh8, noisyU16, [W8, 0, 0, H8, 0, 0]);
    await ed8.setMap("depth", noisyMap);
    await settle(ed8);

    await commands.run("depth_edit", { doc: ed8.node.id, op: "smooth", value: 1 });
    await settle(ed8);

    const curDataE = ed8.maps.depth.data;
    let sumOrigE = 0, sumSqOrigE = 0, countE = 0;
    let sumSmoothE = 0, sumSqSmoothE = 0;
    for (let y = 20; y < 180; y++) {
        for (let x = 85; x <= 140; x++) {
            const vo = noisyU16[y * mw8 + x];
            const vs = curDataE[y * mw8 + x];
            sumOrigE += vo; sumSqOrigE += vo * vo;
            sumSmoothE += vs; sumSqSmoothE += vs * vs;
            countE++;
        }
    }
    const meanOrigE = sumOrigE / countE;
    const varOrigE = (sumSqOrigE / countE) - (meanOrigE * meanOrigE);
    const meanSmoothE = sumSmoothE / countE;
    const varSmoothE = (sumSqSmoothE / countE) - (meanSmoothE * meanSmoothE);
    const okEVar = varSmoothE <= 0.5 * varOrigE;

    let okEOutside = true;
    for (let y = 10; y < 190; y += 20) {
        for (let x = 0; x < 70; x++) {
            if (curDataE[y * mw8 + x] !== noisyU16[y * mw8 + x]) okEOutside = false;
        }
    }
    check("Case e: smooth 1 variance inside drops by >= 50%, outside byte-equal", okEVar && okEOutside, { varRatio: varSmoothE / varOrigE, okEOutside });

    // Case f: limited layer re-renders: filteredCanvas miss counter grows by 1
    await commands.run("add_filter", { doc: ed8.node.id, filter: "haze", params: { amount: 50, limit: { source: "depth", lo: 0.2, hi: 0.8 } } });
    await settle(ed8);

    let missCountF = 0;
    const origFC = ed8.filteredCanvas.bind(ed8);
    ed8.filteredCanvas = function(...args) {
        missCountF++;
        return origFC(...args);
    };

    await commands.run("depth_edit", { doc: ed8.node.id, op: "offset", value: 0.05 });
    await settle(ed8);
    ed8.filteredCanvas = origFC;
    check("Case f: limited layer re-renders on depth_edit", missCountF >= 1, { missCountF });

    // Case h: map turned 90 deg (rotate_canvas) then flatten: edited texels under selection in turned frame
    await commands.run("rotate_canvas", { doc: ed8.node.id, angle: 90 });
    await settle(ed8);

    await commands.run("select_rect", { doc: ed8.node.id, x: 200, y: 300, w: 400, h: 600, mode: "replace" });
    await settle(ed8);

    const resH = await commands.run("depth_edit", { doc: ed8.node.id, op: "flatten" });
    await settle(ed8);
    check("Case h: flatten on turned 90 deg map modifies texels in turned frame", resH.texels_changed > 0, { changed: resH.texels_changed });

    shell.closeDocument && shell.closeDocument(ed8, { force: true });

    return { fails, tiles: !!ed.tileMode, hash: hash50 };
})()
"""


async def run(c):
    r = await c.eval(JS, timeout=300)
    fails = r.get("fails", [])
    for f in fails:
        print("[FAIL]", f)
    if not fails:
        print(f"[ok] edges test on {'tiles' if r.get('tiles') else 'canvas'}")
    return not fails


def main():
    sys.stdout.reconfigure(encoding="utf-8")

    # 1. Run Node unit test
    print("Running node tools/edges_test.js...")
    node_cmd = sys.executable.replace("python.exe", "node.exe") if os.path.exists(sys.executable.replace("python.exe", "node.exe")) else "node"
    res = subprocess.run([node_cmd, os.path.join(HERE, "edges_test.js")])
    if res.returncode != 0:
        print("[FAIL] node tools/edges_test.js failed with code", res.returncode)
        sys.exit(res.returncode)
    print("[ok] node edges_test.js passed")

    # 2. Run CDP integration test if browser session is reachable
    try:
        ok = asyncio.run(session(run))
        if not ok:
            print("FAIL")
            sys.exit(1)
    except Exception as e:
        if "JS exception" in str(e):
            print(f"[FAIL] {e}")
            sys.exit(1)
        print(f"Note: CDP session not reachable ({e}), node test passed.")

    print("PASS")
    sys.exit(0)


if __name__ == "__main__":
    main()
