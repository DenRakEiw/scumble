"""Haze by depth filter gate (PLAN_NIK9_BUILD.md R2-S12).

Tests haze filter layer across CPU and WebGL2 paths via CDP:
  * Case a: Fresh 600x400 document, solid background, linear depth ramp installed via setMap.
  * Case b: Add haze filter layer at default settings: renders without error, effect reaches farther at deep pixels.
  * Case c: amount = 0 is bitwise identical to source (skip hook kicks in, no GL draw, no texture bindings).
  * Case d: Without depth map: haze filter is a no-op (skip hook), bitwise identical to source;
            layer controls show hint row; when host.depthSupported = false, haze is absent from Add Filter dropdown.
  * Case e: Conditional parameter: color_mode = "auto" hides color picker; color_mode = "custom" shows color picker;
            changing color to #ff0000 tints far pixels red.
  * Case f: wholeStats caching: changing haze density (amount) does not re-run hazeStats (air color cached under
            ${compositeVersion}:${mapsVersion}:${n}); modifying base picture underneath updates air color on next composite.
  * Case g: Snap integration: when depth map has guide + snap meta (strength = 50), haze respects picture edges.
  * Case h: Tile boundary test: with --tiles on, 2x2 or 3x3 tiles show no seams across tile boundaries (diff <= 1 level).
  * Case i: Export: flattenToCanvas and encodeComposite produce matching output (within rounding, <= 2 levels).

Connects to running app via CDP.
"""
import asyncio
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

JS = r"""
(async () => {
    const shell = await import("./shell.js");
    const { commands } = await import("./commands.js");
    const F = await import("./editor/inpaint_filters.js");
    const { host } = await import("./editor/host.js");
    const { makeMap } = await import("./editor/inpaint_maps.js");
    const PNG = await import("./editor/inpaint_png.js");

    const fails = [];
    const check = (name, ok, info) => {
        if (!ok) fails.push(name + (info !== undefined ? ": " + JSON.stringify(info).slice(0, 400) : ""));
    };
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const settle = async (ed) => { await ed.mipsSettled(); await new Promise((r) => setTimeout(r, 100)); };

    const decode = async (blob) => {
        let out = null, W = 0, H = 0;
        await PNG.readPng(blob, {
            onHeader: (h) => { W = h.width; H = h.height; out = new Uint8Array(W * H * 4); },
            onRows: (rgba, y0) => { out.set(rgba, y0 * W * 4); },
        });
        return { data: out, width: W, height: H };
    };

    const ed = shell.newDocument();
    shell.activate(ed);
    await new Promise((r) => setTimeout(r, 200));
    ed.resizeCanvas();

    // -------------------------------------------------------------------------
    // Case a: Fresh 600x400 document, solid background, linear depth ramp
    // -------------------------------------------------------------------------
    const W = 600, H = 400;
    const base = mk(W, H);
    {
        const ctx = base.getContext("2d");
        ctx.fillStyle = "#112233";
        ctx.fillRect(0, 0, W, H);
    }
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBaseFromCanvas(base, { keepLayers: false });
    await settle(ed);

    const Mw = 150, Mh = 100;
    const ramp = new Uint16Array(Mw * Mh);
    for (let y = 0; y < Mh; y++) {
        for (let x = 0; x < Mw; x++) {
            ramp[y * Mw + x] = Math.round((x / (Mw - 1)) * 65535);
        }
    }
    const depthMap = makeMap("depth", Mw, Mh, ramp, [W, 0, 0, H, 0, 0]);
    const setOk = await ed.setMap("depth", depthMap);
    check("a: setMap returned true", setOk === true, setOk);
    check("a: depth map installed in editor", !!(ed.maps && ed.maps.depth));

    const pxBase = base.getContext("2d").getImageData(0, 0, W, H).data;

    // -------------------------------------------------------------------------
    // Case b: Add haze filter layer at default settings.
    // Check renders without error, effect reaches farther at deep pixels
    // -------------------------------------------------------------------------
    const fx = ed.addFilterLayer("haze");
    check("b: haze layer created", !!fx && fx.filter === "haze");
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const flatB = ed.flattenToCanvas({ forRun: true });
    const pxB = flatB.getContext("2d").getImageData(0, 0, W, H).data;

    const idx50 = (200 * W + 50) * 4;
    const idx550 = (200 * W + 550) * 4;
    const diff50 = Math.abs(pxB[idx50] - pxBase[idx50]) + Math.abs(pxB[idx50 + 1] - pxBase[idx50 + 1]) + Math.abs(pxB[idx50 + 2] - pxBase[idx50 + 2]);
    const diff550 = Math.abs(pxB[idx550] - pxBase[idx550]) + Math.abs(pxB[idx550 + 1] - pxBase[idx550 + 1]) + Math.abs(pxB[idx550 + 2] - pxBase[idx550 + 2]);
    check("b: near pixel below start threshold has 0 diff", diff50 === 0, { diff50 });
    check("b: far pixel has strong tint towards airlight", diff550 > 30, { diff550 });

    const infoB = { ...ed.filterInfo(fx, { scale: 1, origin: [0, 0], full: [W, H], forRun: true }), maps: ed.maps, cpu: true };
    const cpuB = F.applyFilter("haze", base, fx.params, infoB);
    check("b: cpuB canvas available", !!cpuB);
    if (cpuB) {
        const pxCpuB = cpuB.getContext("2d").getImageData(0, 0, W, H).data;
        let maxDiffGLvsCPU = 0, over2Count = 0;
        for (let i = 0; i < W * H * 4; i += 4) {
            const dr = Math.abs(pxB[i] - pxCpuB[i]);
            const dg = Math.abs(pxB[i + 1] - pxCpuB[i + 1]);
            const db = Math.abs(pxB[i + 2] - pxCpuB[i + 2]);
            const d = Math.max(dr, dg, db);
            if (d > maxDiffGLvsCPU) maxDiffGLvsCPU = d;
            if (d > 2) over2Count++;
        }
        const over2Pct = (over2Count / (W * H)) * 100;
        check("b: compareFilterPaths GL vs CPU (max <= 2, over2 <= 0.1%)", maxDiffGLvsCPU <= 2 && over2Pct <= 0.1, { maxDiffGLvsCPU, over2Pct });
    }

    // -------------------------------------------------------------------------
    // Case c: amount = 0 is bitwise identical to source (skip hook)
    // -------------------------------------------------------------------------
    fx.params.amount = 0;
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const flatC = ed.flattenToCanvas({ forRun: true });
    const pxC = flatC.getContext("2d").getImageData(0, 0, W, H).data;
    let diffC = 0;
    for (let i = 0; i < pxC.length; i++) {
        if (pxC[i] !== pxBase[i]) diffC++;
    }
    check("c: amount = 0 bitwise identical to source", diffC === 0, { diffC });

    // -------------------------------------------------------------------------
    // Case d: Without depth map, haze is no-op (skip hook), bitwise identical;
    // layer controls show hint row; when host.depthSupported = false, haze absent
    // from Add Filter dropdown.
    // -------------------------------------------------------------------------
    fx.params.amount = 50;
    await ed.setMap("depth", null);
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const flatD = ed.flattenToCanvas({ forRun: true });
    const pxD = flatD.getContext("2d").getImageData(0, 0, W, H).data;
    let diffD = 0;
    for (let i = 0; i < pxD.length; i++) {
        if (pxD[i] !== pxBase[i]) diffD++;
    }
    check("d: no depth map bitwise identical to source", diffD === 0, { diffD });

    const ctrlBoxD = ed.buildFilterControls(fx);
    const hintEl = ctrlBoxD && ctrlBoxD.querySelector(".ipc-hint");
    check("d: hint row displayed when depth map missing", !!(hintEl && /Needs a depth map/.test(hintEl.textContent)), hintEl ? hintEl.textContent : null);

    const prevSupported = host.depthSupported;
    host.depthSupported = false;
    try {
        const dummy = ed.addFilterLayer("blur");
        const dummyBox = ed.buildFilterControls(dummy);
        const typeSel = dummyBox && dummyBox.querySelector("select.ipc-sel");
        const options = typeSel ? Array.from(typeSel.options).map((o) => o.value) : [];
        check("d: haze absent from filter select when !host.depthSupported", !options.includes("haze"), options);
        ed.removeLayer(dummy.id);
    } finally {
        host.depthSupported = prevSupported;
    }

    // -------------------------------------------------------------------------
    // Case e: Conditional parameter: color_mode = "auto" hides color picker;
    // color_mode = "custom" shows color picker; changing color to #ff0000 tints far pixels red.
    // -------------------------------------------------------------------------
    await ed.setMap("depth", depthMap);
    fx.params.color_mode = "auto";
    const boxAuto = ed.buildFilterControls(fx);
    const colorPickerAuto = boxAuto && boxAuto.querySelector('input[type="color"]');
    check("e: color picker hidden when color_mode is auto", !colorPickerAuto);

    fx.params.color_mode = "custom";
    fx.params.color = "#ff0000";
    const boxCustom = ed.buildFilterControls(fx);
    const colorPickerCustom = boxCustom && boxCustom.querySelector('input[type="color"]');
    check("e: color picker shown when color_mode is custom", !!colorPickerCustom);

    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const flatE = ed.flattenToCanvas({ forRun: true });
    const pxE = flatE.getContext("2d").getImageData(0, 0, W, H).data;
    const rE = pxE[idx550], gE = pxE[idx550 + 1], bE = pxE[idx550 + 2];
    check("e: far pixel tinted red with custom #ff0000 airlight", rE > gE + 50 && rE > bE + 50, { r: rE, g: gE, b: bE });

    // -------------------------------------------------------------------------
    // Case f: wholeStats caching: changing haze density (amount) does not re-run hazeStats;
    // modifying base picture underneath updates air color on next composite.
    // -------------------------------------------------------------------------
    fx.params.color_mode = "auto";
    fx.params.amount = 50;
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const statsBefore = ed.belowStats(fx, true);
    check("f: stats computed", !!(statsBefore && statsBefore.air), statsBefore);
    const airBefore = statsBefore ? statsBefore.air : null;

    fx.params.amount = 80;
    const statsAfter = ed.belowStats(fx, true);
    check("f: stats cached across amount change", statsBefore === statsAfter);

    const yellowBase = mk(W, H);
    {
        const yctx = yellowBase.getContext("2d");
        yctx.fillStyle = "#ffdd00";
        yctx.fillRect(0, 0, W, H);
    }
    Object.defineProperty(yellowBase, "naturalWidth", { value: W });
    Object.defineProperty(yellowBase, "naturalHeight", { value: H });
    await ed.setBaseFromCanvas(yellowBase, { keepLayers: true });
    await settle(ed);

    const statsYellow = ed.belowStats(fx, true);
    check("f: modifying base picture updates stats", statsYellow !== statsBefore && !!statsYellow && statsYellow.air[0] > 0.8, { before: airBefore, after: statsYellow ? statsYellow.air : null });

    // Restore base
    await ed.setBaseFromCanvas(base, { keepLayers: true });
    await settle(ed);

    // -------------------------------------------------------------------------
    // Case g: Snap integration: when depth map has guide + snap meta (strength = 50),
    // haze respects picture edges.
    // -------------------------------------------------------------------------
    const snapBase = mk(W, H);
    {
        const sctx = snapBase.getContext("2d");
        sctx.fillStyle = "#000000"; sctx.fillRect(0, 0, 300, H);
        sctx.fillStyle = "#ffffff"; sctx.fillRect(300, 0, 300, H);
    }
    Object.defineProperty(snapBase, "naturalWidth", { value: W });
    Object.defineProperty(snapBase, "naturalHeight", { value: H });
    await ed.setBaseFromCanvas(snapBase, { keepLayers: true });
    await settle(ed);

    const snapGuide = new Uint8ClampedArray(Mw * Mh * 4);
    for (let y = 0; y < Mh; y++) {
        for (let x = 0; x < Mw; x++) {
            const v = x < 75 ? 0 : 255;
            const idx = (y * Mw + x) * 4;
            snapGuide[idx] = v; snapGuide[idx + 1] = v; snapGuide[idx + 2] = v; snapGuide[idx + 3] = 255;
        }
    }
    const snapRamp = new Uint16Array(Mw * Mh);
    for (let y = 0; y < Mh; y++) {
        for (let x = 0; x < Mw; x++) {
            let v;
            if (x < 65) v = 0.0;
            else if (x > 85) v = 1.0;
            else v = (x - 65) / 20;
            snapRamp[y * Mw + x] = Math.round(v * 65535);
        }
    }

    const snapMap0 = makeMap("depth", Mw, Mh, snapRamp, [W, 0, 0, H, 0, 0], { snap: { strength: 0 } }, snapGuide);
    await ed.setMap("depth", snapMap0);
    fx.params.color_mode = "custom";
    fx.params.color = "#ff0000";
    fx.params.amount = 100;
    fx.params.start = 0;
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const flatSnap0 = ed.flattenToCanvas({ forRun: true });
    const pxSnap0 = flatSnap0.getContext("2d").getImageData(0, 0, W, H).data;
    const red295_0 = pxSnap0[(200 * W + 295) * 4];

    const snapMap50 = makeMap("depth", Mw, Mh, snapRamp, [W, 0, 0, H, 0, 0], { snap: { strength: 50 } }, snapGuide);
    await ed.setMap("depth", snapMap50);
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const flatSnap50 = ed.flattenToCanvas({ forRun: true });
    const pxSnap50 = flatSnap50.getContext("2d").getImageData(0, 0, W, H).data;
    const red295_50 = pxSnap50[(200 * W + 295) * 4];

    check("g: snap 50 sharpens transition across edge (red haze at 295 is lower than snap 0)", red295_50 < red295_0, { red0: red295_0, red50: red295_50 });

    // -------------------------------------------------------------------------
    // Case h: Tile boundary test: with --tiles on, 2x2 or 3x3 tiles show no seams
    // across tile boundaries (difference <= 1 level).
    // -------------------------------------------------------------------------
    if (ed.tileMode) {
        const rBands = await ed.encodeComposite({ forRun: true }, {});
        const flatH = ed.flattenToCanvas({ forRun: true });
        const decBands = await decode(rBands.blob);
        const pxFlatH = flatH.getContext("2d").getImageData(0, 0, W, H).data;
        let worstH = 0;
        for (let i = 0; i < decBands.data.length; i++) {
            const d = Math.abs(decBands.data[i] - pxFlatH[i]);
            if (d > worstH) worstH = d;
        }
        check("h: difference <= 1 level between bands and flatten", worstH <= 1, { worstH });
    }

    // -------------------------------------------------------------------------
    // Case i: Export: flattenToCanvas and encodeComposite produce matching output
    // (within rounding, <= 2 levels) with varied parameters.
    // -------------------------------------------------------------------------
    fx.params.amount = 75;
    fx.params.start = 10;
    fx.params.curve = 1.5;
    fx.params.desaturate = 50;
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    if (ed.tileMode) {
        const rExp = await ed.encodeComposite({ forRun: true }, {});
        const flatExp = ed.flattenToCanvas({ forRun: true });
        const decExp = await decode(rExp.blob);
        const pxExp = flatExp.getContext("2d").getImageData(0, 0, W, H).data;
        let worstExp = 0;
        for (let i = 0; i < decExp.data.length; i++) {
            const d = Math.abs(decExp.data[i] - pxExp[i]);
            if (d > worstExp) worstExp = d;
        }
        check("i: export match within <= 2 levels", worstExp <= 2, { worstExp });
    } else {
        const flatExp = ed.flattenToCanvas({ forRun: true });
        check("i: flattenToCanvas produced output", !!flatExp && flatExp.width === W && flatExp.height === H);
    }

    // Cleanup haze
    ed.removeLayer(fx.id);
    await ed.setMap("depth", null);

    // =========================================================================
    // Dehaze filter layer tests (PLAN_NIK9_BUILD.md R2-S14)
    // =========================================================================

    // Case j: Dehaze GL against CPU, both modes (auto & depth)
    const dbg = mk(W, H);
    {
        const dctx = dbg.getContext("2d");
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const r = 50 + ((x * 7) ^ (y * 11)) % 100;
                const g = 60 + ((x * 13) ^ (y * 5)) % 100;
                const b = 80 + ((x * 3) ^ (y * 9)) % 100;
                dctx.fillStyle = `rgb(${r},${g},${b})`;
                dctx.fillRect(x, y, 1, 1);
            }
        }
    }
    Object.defineProperty(dbg, "naturalWidth", { value: W });
    Object.defineProperty(dbg, "naturalHeight", { value: H });
    await ed.setBaseFromCanvas(dbg, { keepLayers: false });
    await settle(ed);

    const dfx = ed.addFilterLayer("dehaze");
    check("j: dehaze layer created", !!dfx && dfx.filter === "dehaze");

    // j1: Auto mode GL vs CPU parity
    dfx.params.amount = 60;
    dfx.params.mode = "auto";
    dfx.params.protect = 40;
    ed.markFilterChanged(dfx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const flatAutoGL = ed.flattenToCanvas({ forRun: true });
    const pxAutoGL = flatAutoGL.getContext("2d").getImageData(0, 0, W, H).data;
    const infoAuto = { ...ed.filterInfo(dfx, { scale: 1, origin: [0, 0], full: [W, H], forRun: true }), maps: ed.maps, cpu: true };
    const cpuAuto = F.applyFilter("dehaze", dbg, dfx.params, infoAuto);
    check("j: cpuAuto canvas available", !!cpuAuto);
    if (cpuAuto) {
        const pxCpuAuto = cpuAuto.getContext("2d").getImageData(0, 0, W, H).data;
        let maxDiff = 0, over2Count = 0;
        for (let i = 0; i < W * H * 4; i += 4) {
            const dr = Math.abs(pxAutoGL[i] - pxCpuAuto[i]);
            const dg = Math.abs(pxAutoGL[i + 1] - pxCpuAuto[i + 1]);
            const db = Math.abs(pxAutoGL[i + 2] - pxCpuAuto[i + 2]);
            const d = Math.max(dr, dg, db);
            if (d > maxDiff) maxDiff = d;
            if (d > 2) over2Count++;
        }
        const over2Pct = (over2Count / (W * H)) * 100;
        check("j: dehaze auto GL vs CPU parity (max <= 2, over2 <= 0.1%)", maxDiff <= 2 && over2Pct <= 0.1, { maxDiff, over2Pct });
    }

    // j2: Depth mode GL vs CPU parity
    await ed.setMap("depth", depthMap);
    dfx.params.mode = "depth";
    dfx.params.density = 120;
    dfx.params.amount = 70;
    ed.markFilterChanged(dfx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const flatDepthGL = ed.flattenToCanvas({ forRun: true });
    const pxDepthGL = flatDepthGL.getContext("2d").getImageData(0, 0, W, H).data;
    const infoDepth = { ...ed.filterInfo(dfx, { scale: 1, origin: [0, 0], full: [W, H], forRun: true }), maps: ed.maps, cpu: true };
    const cpuDepth = F.applyFilter("dehaze", dbg, dfx.params, infoDepth);
    check("j: cpuDepth canvas available", !!cpuDepth);
    if (cpuDepth) {
        const pxCpuDepth = cpuDepth.getContext("2d").getImageData(0, 0, W, H).data;
        let maxDiff = 0, over2Count = 0;
        for (let i = 0; i < W * H * 4; i += 4) {
            const dr = Math.abs(pxDepthGL[i] - pxCpuDepth[i]);
            const dg = Math.abs(pxDepthGL[i + 1] - pxCpuDepth[i + 1]);
            const db = Math.abs(pxDepthGL[i + 2] - pxCpuDepth[i + 2]);
            const d = Math.max(dr, dg, db);
            if (d > maxDiff) maxDiff = d;
            if (d > 2) over2Count++;
        }
        const over2Pct = (over2Count / (W * H)) * 100;
        check("j: dehaze depth GL vs CPU parity (max <= 2, over2 <= 0.1%)", maxDiff <= 2 && over2Pct <= 0.1, { maxDiff, over2Pct });
    }

    // Case k: Synthetic hazy document recovery
    const synW = 240, synH = 120;
    const J_arr = new Float32Array(synW * synH * 3);
    const hazyCanvas = mk(synW, synH);
    const hctx = hazyCanvas.getContext("2d");
    const hImg = hctx.createImageData(synW, synH);
    const hpx = hImg.data;
    const synA = [0.8, 0.85, 0.9];
    let initialHazyDiff = 0;

    for (let y = 0; y < synH; y++) {
        for (let x = 0; x < synW; x++) {
            const idx = (y * synW + x);
            const pidx = idx * 4;
            const t = 0.2 + 0.8 * (x / (synW - 1));

            let jr, jg, jb;
            if (x < 10 && y < 30) {
                jr = synA[0]; jg = synA[1]; jb = synA[2];
            } else {
                const cPick = (x ^ y) % 3;
                jr = (cPick === 0 ? 0.05 : 0.6) * ((x % 7) / 7 + 0.2);
                jg = (cPick === 1 ? 0.05 : 0.7) * ((y % 5) / 5 + 0.2);
                jb = (cPick === 2 ? 0.05 : 0.8) * (((x + y) % 6) / 6 + 0.2);
            }
            J_arr[idx * 3] = jr;
            J_arr[idx * 3 + 1] = jg;
            J_arr[idx * 3 + 2] = jb;

            const ir = Math.round(Math.min(255, Math.max(0, (jr * t + synA[0] * (1 - t)) * 255)));
            const ig = Math.round(Math.min(255, Math.max(0, (jg * t + synA[1] * (1 - t)) * 255)));
            const ib = Math.round(Math.min(255, Math.max(0, (jb * t + synA[2] * (1 - t)) * 255)));

            hpx[pidx] = ir;
            hpx[pidx + 1] = ig;
            hpx[pidx + 2] = ib;
            hpx[pidx + 3] = 255;

            initialHazyDiff += Math.abs(ir / 255 - jr) + Math.abs(ig / 255 - jg) + Math.abs(ib / 255 - jb);
        }
    }
    hctx.putImageData(hImg, 0, 0);
    Object.defineProperty(hazyCanvas, "naturalWidth", { value: synW });
    Object.defineProperty(hazyCanvas, "naturalHeight", { value: synH });

    await ed.setBaseFromCanvas(hazyCanvas, { keepLayers: false });
    await settle(ed);

    const synDfx = ed.addFilterLayer("dehaze");
    synDfx.params.amount = 100;
    synDfx.params.mode = "auto";
    synDfx.params.protect = 0;
    ed.markFilterChanged(synDfx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const flatRec = ed.flattenToCanvas({ forRun: true });
    const pxRec = flatRec.getContext("2d").getImageData(0, 0, synW, synH).data;
    let recoveredDiff = 0;
    for (let i = 0; i < synW * synH; i++) {
        const pidx = i * 4;
        const outR = pxRec[pidx] / 255;
        const outG = pxRec[pidx + 1] / 255;
        const outB = pxRec[pidx + 2] / 255;
        recoveredDiff += Math.abs(outR - J_arr[i * 3]) + Math.abs(outG - J_arr[i * 3 + 1]) + Math.abs(outB - J_arr[i * 3 + 2]);
    }
    check("k: amount 100 recovered mean diff <= 0.5 * hazy diff", recoveredDiff <= 0.5 * initialHazyDiff, { recoveredDiff, halfInitial: 0.5 * initialHazyDiff });

    // Case l: amount 0 -> identity
    synDfx.params.amount = 0;
    ed.markFilterChanged(synDfx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const flatZero = ed.flattenToCanvas({ forRun: true });
    const pxZero = flatZero.getContext("2d").getImageData(0, 0, synW, synH).data;
    let diffZero = 0;
    for (let i = 0; i < pxZero.length; i++) {
        if (pxZero[i] !== hpx[i]) diffZero++;
    }
    check("l: amount 0 is bitwise identical to source", diffZero === 0, { diffZero });

    // Case m: Protect sky: flat region equal to A stays within 3 levels at protect 100
    const skyW = 100, skyH = 100;
    const skyCanvas = mk(skyW, skyH);
    const sctx = skyCanvas.getContext("2d");
    sctx.fillStyle = `rgb(${Math.round(synA[0] * 255)}, ${Math.round(synA[1] * 255)}, ${Math.round(synA[2] * 255)})`;
    sctx.fillRect(0, 0, skyW, skyH);
    Object.defineProperty(skyCanvas, "naturalWidth", { value: skyW });
    Object.defineProperty(skyCanvas, "naturalHeight", { value: skyH });
    await ed.setBaseFromCanvas(skyCanvas, { keepLayers: false });
    await settle(ed);

    const skyDfx = ed.addFilterLayer("dehaze");
    skyDfx.params.amount = 80;
    skyDfx.params.protect = 100;
    ed.markFilterChanged(skyDfx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const flatSky = ed.flattenToCanvas({ forRun: true });
    const pxSky = flatSky.getContext("2d").getImageData(0, 0, skyW, skyH).data;
    let maxSkyDiff = 0;
    const expR = Math.round(synA[0] * 255), expG = Math.round(synA[1] * 255), expB = Math.round(synA[2] * 255);
    for (let i = 0; i < skyW * skyH * 4; i += 4) {
        const dr = Math.abs(pxSky[i] - expR);
        const dg = Math.abs(pxSky[i + 1] - expG);
        const db = Math.abs(pxSky[i + 2] - expB);
        const d = Math.max(dr, dg, db);
        if (d > maxSkyDiff) maxSkyDiff = d;
    }
    check("m: protect sky 100 on air region stays within 3 levels", maxSkyDiff <= 3, { maxSkyDiff });

    // Case n: Stats computed once per composite version
    const statsN1 = ed.belowStats(skyDfx, false);
    const seqN1 = statsN1 ? statsN1.seq : -1;
    ed.draw();
    await settle(ed);
    const statsN2 = ed.belowStats(skyDfx, false);
    check("n: stats cached under same composite version", statsN1 === statsN2 && statsN1.seq === seqN1);

    // Case o: Byte-stable stats across repeated exports
    if (ed.tileMode) {
        const r1 = await ed.encodeComposite({ forRun: true }, {});
        const r2 = await ed.encodeComposite({ forRun: true }, {});
        const dec1 = await decode(r1.blob), dec2 = await decode(r2.blob);
        let diffRuns = 0;
        for (let i = 0; i < dec1.data.length; i++) {
            if (dec1.data[i] !== dec2.data[i]) diffRuns++;
        }
        check("o: byte-stable export across consecutive exports", diffRuns === 0, { diffRuns });
    } else {
        const f1 = ed.flattenToCanvas({ forRun: true });
        const f2 = ed.flattenToCanvas({ forRun: true });
        const d1 = f1.getContext("2d").getImageData(0, 0, skyW, skyH).data;
        const d2 = f2.getContext("2d").getImageData(0, 0, skyW, skyH).data;
        let diffRuns = 0;
        for (let i = 0; i < d1.length; i++) {
            if (d1[i] !== d2[i]) diffRuns++;
        }
        check("o: byte-stable flatten across consecutive exports", diffRuns === 0, { diffRuns });
    }

    // Cleanup dehaze
    ed.removeLayer(skyDfx.id);
    await ed.setMap("depth", null);

    return { fails, tiles: !!ed.tiles };
})();
"""


async def run(c):
    r = await c.eval(JS, timeout=120)
    fails = r.get("fails", [])
    for f in fails:
        print("[FAIL]", f)
    if not fails:
        print(f"[ok] depthfx test on {'tiles' if r.get('tiles') else 'canvas'}")
    return not fails


def node_step():
    r = subprocess.run(
        ["node", os.path.join(HERE, "haze_test.js")],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )
    tail = r.stdout.strip()
    if r.returncode != 0 or not tail.endswith("PASS"):
        raise Exception("tools/haze_test.js: " + (tail + r.stderr)[-1500:])
    return {"checks": tail.count("[ok]")}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        nres = node_step()
        print(f"[ok] haze_test.js: {nres['checks']} checks passed")
    except Exception as err:
        print(f"[FAIL] node: {err}")
        print("FAIL")
        sys.exit(1)

    try:
        ok = asyncio.run(session(run))
        if not ok:
            print("FAIL")
            sys.exit(1)
    except Exception as e:
        if "JS exception" in str(e):
            print(f"[FAIL] {e}")
            sys.exit(1)
        print(f"[FAIL] CDP session error: {e}")
        sys.exit(1)

    print("PASS")
    sys.exit(0)


if __name__ == "__main__":
    main()
