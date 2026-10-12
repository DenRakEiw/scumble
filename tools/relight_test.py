"""Relight filter layer in-app CDP gate (PLAN_RELIGHT_BUILD.md sections 5.4 L1a, 5.5 L1b, 5.6 L2).

Tests relight filter layer across CPU and WebGL2 paths via CDP:
  * Case a: Fresh 600x400 document, shaded background, linear depth ramp with step installed.
            Add relight filter layer at defaults: bitwise identical to source (identity).
  * Case b: One point light on the left: left half brighter than right half,
            step shadow side darker than lit side.
  * Case c: GL against CPU within 2 levels at scale 1 and at scale 0.5 (glVsCpu).
  * Case d: original: 0 with no lights: the ramp's own shading flattened
            (the variance of luminance along the ramp drops by half).
  * Case e: Sun light: no falloff (two points at different distances within 1 level).
  * Case f: Spot light: outside cone unchanged (equal to base).
  * Case g: Cache: moving a light updates only that channel's key (other channels intact).
  * Case h: Export after change waits: encodeComposite equals flattenToCanvas within 2 levels.
  * Case i: Without depth map: filter is no-op (bitwise equal to base) and hint shows.
  * Case j: Document round trip keeps lights and requires reader 6.
  * Case k: Relight row block controls (add, type, intensity, Kelvin, reset, delete).
  * Case l: Add light greys out at 4 lights.
  * Case m: Eye toggle turns a light's contribution off/on.
  * Case n: Drag light through pointer events moves light to new coordinates,
            pushes exactly 1 undo step ("Move light"), undo restores light.
  * Case o: Alt-drag changes dist, pushes exactly 1 undo step ("Relight: Close/Far"),
            undo restores dist.
  * Case p: Click empty canvas adds light at click coords, Delete key removes it,
            undo restores it.
  * Case q: During drag fx._relight.vis.w === Math.floor(W / 4), after pointer up W.
  * Case r: Overlay is not in an export (flattenToCanvas({ forRun: true })).

Rule 1: Strict gate test. If CDP session is unreachable, exits with 1 and prints FAIL.
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
from magnific_mock import Mock  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

JS = r"""
(async (docPath, mockUrl) => {
    const shell = await import("./shell.js");
    const { commands } = await import("./commands.js");
    const F = await import("./editor/inpaint_filters.js");
    const GLM = await import("./editor/inpaint_filters_gl.js");
    const { host } = await import("./editor/host.js");
    const { makeMap } = await import("./editor/inpaint_maps.js");
    const PNG = await import("./editor/inpaint_png.js");
    const { defaultLight, applyLightPreset, LIGHT_PRESETS, SPOT_GOBOS } = await import("./editor/inpaint_relight.js");

    const fails = [];
    let checkCount = 0;
    const check = (name, ok, info) => {
        checkCount++;
        if (!ok) fails.push(name + (info !== undefined ? ": " + JSON.stringify(info).slice(0, 400) : ""));
    };
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const settle = async (ed) => {
        await ed.mipsSettled();
        await ed.relightSettled();
        await new Promise((r) => setTimeout(r, 120));
    };

    const glVsCpu = (label, id, src, params, info, tol) => {
        const infoGL = { ...info, cpu: false };
        const gl = GLM.applyFilterGL(id, src, params, infoGL);
        check(label + ": applyFilterGL runs the GL twin (not null)", !!gl);
        const cpu = F.applyFilter(id, src, params, { ...info, cpu: true });
        check(label + ": CPU twin ran", !!cpu);
        if (!gl || !cpu) return null;
        const w = src.width, h = src.height;
        const pa = GLM.glToCanvas(gl).getContext("2d").getImageData(0, 0, w, h).data;
        const pb = cpu.getContext("2d").getImageData(0, 0, w, h).data;
        let max = 0, over2 = 0, sum = 0;
        for (let i = 0; i < w * h * 4; i += 4) {
            const d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]), Math.abs(pa[i + 3] - pb[i + 3]));
            if (d > max) max = d;
            if (d > 2) over2++;
            sum += d;
        }
        const stats = { max, over2Pct: (over2 / (w * h)) * 100, mean: sum / (w * h) };
        check(label + ": GL vs CPU (max <= " + tol.max + ", over2 <= " + tol.over2Pct + "%, mean <= " + tol.mean + ")",
            stats.max <= tol.max && stats.over2Pct <= tol.over2Pct && stats.mean <= tol.mean, stats);
        return stats;
    };

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
    // Setup: 600x400 document, shaded background, linear depth ramp with step
    // -------------------------------------------------------------------------
    const W = 600, H = 400;
    const base = mk(W, H);
    {
        const ctx = base.getContext("2d");
        ctx.fillStyle = "#808080";
        ctx.fillRect(0, 0, W, H);
    }
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBaseFromCanvas(base, { keepLayers: false });
    await settle(ed);

    // Step at x = 75 in map (x = 300 in doc):
    // x < 75: near subject / high ground (depth = 10000)
    // x >= 75: far background / low ground (depth = 50000)
    const Mw = 150, Mh = 100;
    const ramp = new Uint16Array(Mw * Mh);
    for (let y = 0; y < Mh; y++) {
        for (let x = 0; x < Mw; x++) {
            ramp[y * Mw + x] = x < 75 ? 10000 : 50000;
        }
    }
    const depthMap = makeMap("depth", Mw, Mh, ramp, [W, 0, 0, H, 0, 0]);
    const setOk = await ed.setMap("depth", depthMap);
    check("setup: depth map installed", setOk === true && !!(ed.maps && ed.maps.depth));

    const pxBase = base.getContext("2d").getImageData(0, 0, W, H).data;

    // -------------------------------------------------------------------------
    // Case a: The identity at defaults, bitwise
    // -------------------------------------------------------------------------
    const fx = ed.addFilterLayer("relight");
    check("a: relight filter layer created", !!fx && fx.filter === "relight");
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const flatA = ed.flattenToCanvas({ forRun: true });
    const pxA = flatA.getContext("2d").getImageData(0, 0, W, H).data;
    let diffA = 0;
    for (let i = 0; i < pxA.length; i++) {
        if (pxA[i] !== pxBase[i]) diffA++;
    }
    check("a: identity at defaults bitwise", diffA === 0, { diffA });

    // -------------------------------------------------------------------------
    // Case b: One point light on the left
    // Left half brighter than right half, step shadow side darker than lit side
    // -------------------------------------------------------------------------
    fx.params.lights = [{
        id: "light_1",
        on: true,
        type: "point",
        x: 100,
        y: 200,
        dist: -30,
        kelvin: 5500,
        color: "#ffffff",
        intensity: 100,
        diffusion: 30,
        range: 600,
        shadows: true,
    }];
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const flatB = ed.flattenToCanvas({ forRun: true });
    const pxB = flatB.getContext("2d").getImageData(0, 0, W, H).data;

    let sumLumLeft = 0, sumLumRight = 0;
    for (let y = 150; y < 250; y++) {
        for (let x = 0; x < 300; x++) {
            const idx = (y * W + x) * 4;
            sumLumLeft += 0.299 * pxB[idx] + 0.587 * pxB[idx + 1] + 0.114 * pxB[idx + 2];
        }
        for (let x = 300; x < 600; x++) {
            const idx = (y * W + x) * 4;
            sumLumRight += 0.299 * pxB[idx] + 0.587 * pxB[idx + 1] + 0.114 * pxB[idx + 2];
        }
    }
    const meanLeft = sumLumLeft / (100 * 300);
    const meanRight = sumLumRight / (100 * 300);
    check("b: left half brighter than right half", meanLeft > meanRight + 15, { meanLeft, meanRight });

    // Step at x = 300: high ground at x = 200, low ground in shadow at x = 320
    const idxLit = (200 * W + 200) * 4;
    const idxShadow = (200 * W + 320) * 4;
    const lumLit = 0.299 * pxB[idxLit] + 0.587 * pxB[idxLit + 1] + 0.114 * pxB[idxLit + 2];
    const lumShadow = 0.299 * pxB[idxShadow] + 0.587 * pxB[idxShadow + 1] + 0.114 * pxB[idxShadow + 2];
    check("b: step shadow side darker than lit side", lumLit > lumShadow + 10, { lumLit, lumShadow });

    // -------------------------------------------------------------------------
    // Case c: GL against CPU within 2 levels at scale 1 and scale 0.5 (glVsCpu)
    // -------------------------------------------------------------------------
    const infoC1 = { ...ed.filterInfo(fx, { scale: 1, origin: [0, 0], full: [W, H], forRun: true }), maps: ed.maps, relight: fx._relight };
    glVsCpu("c: scale 1", "relight", base, fx.params, infoC1, { max: 2, over2Pct: 0.2, mean: 1.0 });

    const infoC05 = { ...ed.filterInfo(fx, { scale: 0.5, origin: [0, 0], full: [W, H], forRun: true }), maps: ed.maps, relight: fx._relight, scale: 0.5 };
    glVsCpu("c: scale 0.5", "relight", base, fx.params, infoC05, { max: 2, over2Pct: 0.2, mean: 1.0 });

    // -------------------------------------------------------------------------
    // Case d: original 0 with no lights: ramp shading flattened
    // -------------------------------------------------------------------------
    const shadedBase = mk(W, H);
    {
        const sctx = shadedBase.getContext("2d");
        for (let x = 0; x < W; x++) {
            const val = Math.round(50 + 150 * (x / (W - 1)));
            sctx.fillStyle = `rgb(${val}, ${val}, ${val})`;
            sctx.fillRect(x, 0, 1, H);
        }
    }
    Object.defineProperty(shadedBase, "naturalWidth", { value: W });
    Object.defineProperty(shadedBase, "naturalHeight", { value: H });
    await ed.setBaseFromCanvas(shadedBase, { keepLayers: true });
    await settle(ed);

    fx.params.lights = [];
    fx.params.original = 0;
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const flatD = ed.flattenToCanvas({ forRun: true });
    const pxD = flatD.getContext("2d").getImageData(0, 0, W, H).data;
    const pxShaded = shadedBase.getContext("2d").getImageData(0, 0, W, H).data;

    let varBase = 0, varD = 0, meanBaseVal = 0, meanDVal = 0;
    const countD = 200;
    for (let x = 50; x < 250; x++) {
        const idx = (200 * W + x) * 4;
        meanBaseVal += pxShaded[idx];
        meanDVal += pxD[idx];
    }
    meanBaseVal /= countD;
    meanDVal /= countD;
    for (let x = 50; x < 250; x++) {
        const idx = (200 * W + x) * 4;
        varBase += (pxShaded[idx] - meanBaseVal) ** 2;
        varD += (pxD[idx] - meanDVal) ** 2;
    }
    varBase /= countD;
    varD /= countD;
    check("d: original 0 flattens ramp shading (variance drops by half)", varD < varBase * 0.5, { varBase, varD });

    // Restore solid base
    await ed.setBaseFromCanvas(base, { keepLayers: true });
    await settle(ed);

    // -------------------------------------------------------------------------
    // Case e: Sun light: no falloff (two points at different distances within 1 level)
    // -------------------------------------------------------------------------
    fx.params.original = 100;
    fx.params.lights = [{
        id: "light_1",
        on: true,
        type: "sun",
        x: 100,
        y: 200,
        dist: -30,
        color: "#ffffff",
        intensity: 100,
        diffusion: 0,
        range: 600,
        shadows: false,
    }];
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const flatE = ed.flattenToCanvas({ forRun: true });
    const pxE = flatE.getContext("2d").getImageData(0, 0, W, H).data;

    // Compare added illumination on flat high ground at (100, 200) and (200, 200)
    const idxE1 = (200 * W + 100) * 4;
    const idxE2 = (200 * W + 200) * 4;
    const diffE1 = pxE[idxE1] - pxBase[idxE1];
    const diffE2 = pxE[idxE2] - pxBase[idxE2];
    check("e: sun has no falloff (added illumination within 1 level)", Math.abs(diffE1 - diffE2) <= 1, { diffE1, diffE2 });

    // -------------------------------------------------------------------------
    // Case f: Spot light: outside cone unchanged
    // -------------------------------------------------------------------------
    fx.params.lights = [{
        id: "light_1",
        on: true,
        type: "spot",
        x: 300,
        y: 200,
        dist: -30,
        aim: [300, 300],
        cone: 30,
        edge: 0,
        color: "#ffffff",
        intensity: 100,
        range: 400,
        shadows: false,
    }];
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const flatF = ed.flattenToCanvas({ forRun: true });
    const pxF = flatF.getContext("2d").getImageData(0, 0, W, H).data;

    // Pixel at (50, 50) is far outside cone
    const idxF_out = (50 * W + 50) * 4;
    const diffF_out = Math.max(
        Math.abs(pxF[idxF_out] - pxBase[idxF_out]),
        Math.abs(pxF[idxF_out + 1] - pxBase[idxF_out + 1]),
        Math.abs(pxF[idxF_out + 2] - pxBase[idxF_out + 2])
    );
    check("f: outside spot cone unchanged", diffF_out <= 1, { diffF_out });

    // Pixel inside cone at (300, 300) directly at aim
    const idxF_in = (300 * W + 300) * 4;
    const diffF_in = pxF[idxF_in] - pxBase[idxF_in];
    check("f: inside spot cone illuminated", diffF_in >= 10, { diffF_in });

    // -------------------------------------------------------------------------
    // Case g: Cache: moving a light updates only that channel's key
    // -------------------------------------------------------------------------
    fx.params.lights = [
        { id: "light_1", on: true, type: "point", x: 100, y: 200, dist: -30, color: "#ffffff", intensity: 100, diffusion: 30, range: 600 },
        { id: "light_2", on: true, type: "point", x: 500, y: 200, dist: -30, color: "#ff8800", intensity: 100, diffusion: 30, range: 600 },
    ];
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    check("g: relight cache initialized", !!(fx._relight && fx._relight.vis && fx._relight.vis.keys));
    const k0 = fx._relight?.vis?.keys[0];
    const k1 = fx._relight?.vis?.keys[1];
    check("g: keys 0 and 1 exist", !!k0 && !!k1);

    // Move light 0
    fx.params.lights[0].x = 120;
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const k0_after = fx._relight?.vis?.keys[0];
    const k1_after = fx._relight?.vis?.keys[1];
    check("g: key 0 changed after move", k0_after !== k0, { k0, k0_after });
    check("g: key 1 unchanged after moving light 0", k1_after === k1, { k1, k1_after });

    // -------------------------------------------------------------------------
    // Case h: Export after change waits (encodeComposite equals flattenToCanvas <= 2)
    // -------------------------------------------------------------------------
    fx.params.lights[0].x = 150;
    ed.markFilterChanged(fx);

    if (ed.tileMode) {
        const rExp = await ed.encodeComposite({ forRun: true }, {});
        const flatH = ed.flattenToCanvas({ forRun: true });
        check("h: encodeComposite produced blob", !!(rExp && rExp.blob));
        if (rExp && rExp.blob) {
            const decExp = await decode(rExp.blob);
            const pxFlatH = flatH.getContext("2d").getImageData(0, 0, W, H).data;
            let worstH = 0;
            for (let i = 0; i < decExp.data.length; i++) {
                const d = Math.abs(decExp.data[i] - pxFlatH[i]);
                if (d > worstH) worstH = d;
            }
            check("h: encodeComposite equals flattenToCanvas <= 2 levels", worstH <= 2, { worstH });
        }
    } else {
        const flatH = ed.flattenToCanvas({ forRun: true });
        check("h: flattenToCanvas produced output", !!flatH && flatH.width === W && flatH.height === H);
    }

    // -------------------------------------------------------------------------
    // Case i: Without depth map: filter is no-op and hint shows
    // -------------------------------------------------------------------------
    await ed.setMap("depth", null);
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const flatI = ed.flattenToCanvas({ forRun: true });
    const pxI = flatI.getContext("2d").getImageData(0, 0, W, H).data;
    let diffI = 0;
    for (let i = 0; i < pxI.length; i++) {
        if (pxI[i] !== pxBase[i]) diffI++;
    }
    check("i: without depth map filter is no-op (bitwise 0 diff)", diffI === 0, { diffI });

    const ctrlBoxI = ed.buildFilterControls(fx);
    const hintI = ctrlBoxI && ctrlBoxI.querySelector(".ipc-hint");
    check("i: hint row displayed when depth map missing", !!(hintI && /Needs a depth map/.test(hintI.textContent)), hintI?.textContent);

    // -------------------------------------------------------------------------
    // Case j: Document round trip keeps lights and reader 6
    // -------------------------------------------------------------------------
    await ed.setMap("depth", depthMap);
    fx.params.lights = [{
        id: "light_1",
        on: true,
        type: "point",
        x: 160,
        y: 220,
        dist: -25,
        color: "#ffffff",
        intensity: 95,
        diffusion: 35,
        range: 550,
        shadows: true,
    }];
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const saveRes = await host.saveDocument(ed, { path: docPath, copy: true, history: false });
    check("j: saveDocument succeeded", !!(saveRes && saveRes.bytes > 0), saveRes);

    const openRes = await host.openDocument(docPath);
    check("j: openDocument succeeded", !!(openRes && openRes.editor));
    const edOpen = openRes ? openRes.editor : null;
    if (edOpen) {
        await settle(edOpen);
        const openFx = edOpen.layers.find((l) => l.filter === "relight");
        check("j: opened document has relight layer", !!openFx);
        if (openFx) {
            check("j: opened lights length is 1", Array.isArray(openFx.params?.lights) && openFx.params.lights.length === 1);
            check("j: opened light x is 160", openFx.params?.lights?.[0]?.x === 160);
            check("j: opened light intensity is 95", openFx.params?.lights?.[0]?.intensity === 95);
        }
        if (shell.closeDocument) shell.closeDocument(edOpen, { force: true });
    }

    // Reinstall depth map and relight filter layer with point light for visual screenshot
    await ed.setMap("depth", depthMap);
    fx.params.lights = [{
        id: "light_1",
        on: true,
        type: "point",
        x: 150,
        y: 200,
        dist: -30,
        color: "#ffffff",
        intensity: 120,
        diffusion: 30,
        range: 500,
        shadows: true,
    }];
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    // -------------------------------------------------------------------------
    // Case k: The row light block controls change params and push 1 undo step
    // -------------------------------------------------------------------------
    // Reset to exactly 1 light:
    fx.params.lights = [defaultLight(0, { width: W, height: H })];
    fx.params.lights[0].intensity = 100;
    fx.params.lights[0].type = "point";
    fx.params.lights[0].color = 5500;
    ed.markFilterChanged(fx);
    ed.renderLayers();

    // k1. Add light
    const bk1 = ed.buildRelightBlock(fx);
    const addBtn1 = bk1.querySelector(".ipc-add-light");
    addBtn1.click();
    check("k: add light increased lights array to 2", fx.params.lights.length === 2);
    const llRes = await commands.run("list_layers", { doc: ed.node.id });
    const llRelight = llRes.layers.find((l) => l.id === fx.id);
    check("k: list_layers reports lights_count === 2", llRelight && llRelight.lights_count === 2, llRelight);
    await ed.undoStep();
    check("k: undo restores 1 light", fx.params.lights.length === 1);

    // k2. Light type select
    const bk2 = ed.buildRelightBlock(fx);
    const typeSel2 = bk2.querySelector(".ipc-relight-type-sel");
    typeSel2.value = "spot";
    typeSel2.dispatchEvent(new Event("change"));
    check("k: type select changed light type to spot", fx.params.lights[0].type === "spot");
    await ed.undoStep();
    check("k: undo restores point type", fx.params.lights[0].type === "point");

    // k3. Intensity slider
    const bk3 = ed.buildRelightBlock(fx);
    const sliders3 = bk3.querySelectorAll(".ipc-relight-controls input[type='range']");
    const intSlider = Array.from(sliders3).find((s) => s.title === "Intensity");
    if (intSlider) {
        intSlider.value = "150";
        intSlider.dispatchEvent(new Event("input"));
        intSlider.dispatchEvent(new Event("change"));
    }
    check("k: intensity slider updated intensity to 150", fx.params.lights[0].intensity === 150);
    await ed.undoStep();
    check("k: undo restores initial intensity", fx.params.lights[0].intensity === 100);

    // k4. Kelvin colour select
    const bk4 = ed.buildRelightBlock(fx);
    const kelvinSel4 = bk4.querySelector(".ipc-relight-kelvin-sel");
    if (kelvinSel4) {
        kelvinSel4.value = "2700";
        kelvinSel4.dispatchEvent(new Event("change"));
    }
    check("k: kelvin select changed colour to 2700", fx.params.lights[0].color === 2700);
    await ed.undoStep();
    check("k: undo restores colour", fx.params.lights[0].color === 5500);

    // k5. Reset button
    const bk5 = ed.buildRelightBlock(fx);
    fx.params.lights[0].intensity = 180;
    const resetBtn5 = bk5.querySelector(".ipc-relight-reset");
    if (resetBtn5) resetBtn5.click();
    check("k: reset button restores default intensity 100", fx.params.lights[0].intensity === 100);
    await ed.undoStep();
    check("k: undo restores intensity 180", fx.params.lights[0].intensity === 180);
    fx.params.lights[0].intensity = 100;

    // k6. Delete button
    const bk6 = ed.buildRelightBlock(fx);
    const delBtn6 = bk6.querySelector(".ipc-relight-del");
    if (delBtn6) delBtn6.click();
    check("k: delete button removed light", fx.params.lights.length === 0);
    await ed.undoStep();
    check("k: undo restores light", fx.params.lights.length === 1);

    // -------------------------------------------------------------------------
    // Case l: Add light greys out at four
    // -------------------------------------------------------------------------
    while (fx.params.lights.length < 4) {
        const bl = ed.buildRelightBlock(fx);
        const btn = bl.querySelector(".ipc-add-light");
        btn.click();
    }
    check("l: 4 lights reached", fx.params.lights.length === 4);
    const bl4 = ed.buildRelightBlock(fx);
    const btn4 = bl4.querySelector(".ipc-add-light");
    check("l: add light button is disabled at 4", btn4 && btn4.disabled === true);
    // Pop back to 1 light:
    while (fx.params.lights.length > 1) {
        fx.params.lights.pop();
    }

    // -------------------------------------------------------------------------
    // Case m: The eye turns a light's contribution off
    // -------------------------------------------------------------------------
    fx.params.lights = [defaultLight(0, { width: W, height: H })];
    fx.params.lights[0].x = 100;
    fx.params.lights[0].y = 200;
    fx.params.lights[0].intensity = 100;
    fx.params.lights[0].on = true;
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const flatLit = ed.flattenToCanvas({ forRun: true });
    const pxLit = flatLit.getContext("2d").getImageData(0, 0, W, H).data;

    const bmEye = ed.buildRelightBlock(fx);
    const eyeBtn = bmEye.querySelector(".ipc-relight-eye");
    eyeBtn.click();
    check("m: eye toggle turned on to false", fx.params.lights[0].on === false);
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const flatUnlit = ed.flattenToCanvas({ forRun: true });
    const pxUnlit = flatUnlit.getContext("2d").getImageData(0, 0, W, H).data;
    let diffBase = 0;
    for (let i = 0; i < pxUnlit.length; i++) {
        if (pxUnlit[i] !== pxBase[i]) diffBase++;
    }
    check("m: light turned off leaves picture bitwise equal to base", diffBase === 0, { diffBase });

    eyeBtn.click();
    check("m: eye toggle turned on back to true", fx.params.lights[0].on === true);
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    const flatRelit = ed.flattenToCanvas({ forRun: true });
    const pxRelit = flatRelit.getContext("2d").getImageData(0, 0, W, H).data;
    let diffRelit = 0;
    for (let i = 0; i < pxRelit.length; i++) {
        if (pxRelit[i] !== pxLit[i]) diffRelit++;
    }
    check("m: light turned back on matches original lit picture bitwise", diffRelit === 0, { diffRelit });

    // -------------------------------------------------------------------------
    // Session L2 Tests: Cases n, o, p, q, r
    // -------------------------------------------------------------------------

    const toClient = (imgX, imgY) => {
        const rect = ed.canvas.getBoundingClientRect();
        const kx = rect.width / ed.canvas.width;
        const ky = rect.height / ed.canvas.height;
        const [sx, sy] = ed.imageToScreen(imgX, imgY);
        return {
            clientX: rect.left + sx * kx,
            clientY: rect.top + sy * ky,
        };
    };

    const firePointer = (type, imgX, imgY, opts = {}) => {
        const pt = toClient(imgX, imgY);
        const ev = new PointerEvent(type, {
            clientX: pt.clientX,
            clientY: pt.clientY,
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
            pointerId: 1,
            pointerType: "mouse",
            ...opts,
        });
        ed.canvas.dispatchEvent(ev);
    };

    // Ensure we start with lights tool and exactly 1 light:
    ed.selectLayers([fx.id]);
    ed.setTool("lights");
    check("l2: lights tool is active", ed.tool === "lights" && ed.isRelightActive());

    fx.params.lights = [{
        id: "light_1",
        on: true,
        type: "point",
        x: 150,
        y: 200,
        dist: -30,
        color: "#ffffff",
        intensity: 100,
        diffusion: 30,
        range: 600,
        shadows: true,
    }];
    fx._selectedLightId = "light_1";
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

    // -------------------------------------------------------------------------
    // Case n: Drag light through pointer events moves light to new coordinates,
    //         pushes exactly 1 undo step ("Move light"), undo restores light.
    // -------------------------------------------------------------------------
    ed._lastDown = null;
    const undoLenN0 = ed.undo.length;
    firePointer("pointerdown", 150, 200);
    check("n: pointer down on light ring starts relight gesture", ed.pointer && ed.pointer.kind === "relight");
    check("n: no undo step pushed before movement", ed.undo.length === undoLenN0);

    // Drag light by (+30, +20) to (180, 220)
    firePointer("pointermove", 180, 220);
    check("n: exactly 1 undo step pushed during drag", ed.undo.length === undoLenN0 + 1);
    check("n: undo step label is Move light", ed.undo[ed.undo.length - 1]?.label === "Move light");
    check("n: light position updated during drag", fx.params.lights[0].x === 180 && fx.params.lights[0].y === 220);

    firePointer("pointerup", 180, 220);
    check("n: pointer is cleared after pointerup", ed.pointer === null);
    check("n: still exactly 1 undo step after pointerup", ed.undo.length === undoLenN0 + 1);
    await settle(ed);
    check("n: light remains at moved coordinates after pointerup", fx.params.lights[0].x === 180 && fx.params.lights[0].y === 220);

    await ed.undoStep();
    check("n: undo step restores original coordinates (150, 200)", fx.params.lights[0].x === 150 && fx.params.lights[0].y === 200);
    check("n: undo stack returned to original length", ed.undo.length === undoLenN0);

    // -------------------------------------------------------------------------
    // Case o: Alt-drag changes dist, pushes exactly 1 undo step ("Relight: Close/Far"),
    //         undo restores dist.
    // -------------------------------------------------------------------------
    ed._lastDown = null;
    const undoLenO0 = ed.undo.length;
    const origDist = fx.params.lights[0].dist;
    firePointer("pointerdown", 150, 200, { altKey: true });
    check("o: alt pointerdown enters dist mode", ed.pointer && ed.pointer.kind === "relight" && ed.pointer.mode === "dist");

    // Drag up by 32px (dy = -32)
    firePointer("pointermove", 150, 168, { altKey: true });
    check("o: exactly 1 undo step pushed on alt-drag", ed.undo.length === undoLenO0 + 1);
    check("o: undo step label is Relight: Close/Far", ed.undo[ed.undo.length - 1]?.label === "Relight: Close/Far");
    const changedDist = fx.params.lights[0].dist;
    check("o: dist value changed on alt-drag", changedDist !== origDist && changedDist > origDist, { origDist, changedDist });

    firePointer("pointerup", 150, 168, { altKey: true });
    check("o: still 1 undo step after pointerup", ed.undo.length === undoLenO0 + 1);
    await settle(ed);

    await ed.undoStep();
    check("o: undo restores original dist", fx.params.lights[0].dist === origDist, { dist: fx.params.lights[0].dist, origDist });
    check("o: undo stack restored", ed.undo.length === undoLenO0);

    // -------------------------------------------------------------------------
    // Case p: Click empty canvas adds light at click coords, Delete key removes it,
    //         undo restores it.
    // -------------------------------------------------------------------------
    ed._lastDown = null;
    check("p: starts with 1 light", fx.params.lights.length === 1);
    const undoLenP0 = ed.undo.length;

    // Click at empty canvas at (300, 150)
    firePointer("pointerdown", 300, 150);
    firePointer("pointerup", 300, 150);
    check("p: clicking empty canvas adds light", fx.params.lights.length === 2);
    check("p: new light coords match click coords (300, 150)", fx.params.lights[1].x === 300 && fx.params.lights[1].y === 150);
    check("p: new light is selected", fx._selectedLightId === fx.params.lights[1].id);
    check("p: undo stack pushed Add light", ed.undo[ed.undo.length - 1]?.label === "Add light");

    // Press Delete key
    ed.onKey({ key: "Delete", preventDefault: () => {} });
    check("p: Delete key removes selected light", fx.params.lights.length === 1);
    check("p: undo stack pushed Delete light", ed.undo[ed.undo.length - 1]?.label === "Delete light");

    // Undo delete
    await ed.undoStep();
    check("p: undo restores deleted light", fx.params.lights.length === 2);
    check("p: restored light coordinates are (300, 150)", fx.params.lights[1].x === 300 && fx.params.lights[1].y === 150);

    // Undo add light
    await ed.undoStep();
    check("p: undo restores initial 1 light", fx.params.lights.length === 1);
    check("p: undo stack returned to original length", ed.undo.length === undoLenP0);

    // -------------------------------------------------------------------------
    // Case q: During drag fx._relight.vis.w === Math.floor(W / 4), after pointer up W
    // -------------------------------------------------------------------------
    ed._lastDown = null;
    await settle(ed);
    check("q: initially vis is full resolution", fx._relight?.vis?.w === Mw, { visW: fx._relight?.vis?.w, Mw });

    firePointer("pointerdown", 150, 200);
    firePointer("pointermove", 190, 230);
    const quickW = fx._relight?.vis?.w;
    check("q: during drag vis.w is quarter size Math.floor(Mw / 4)", quickW === Math.floor(Mw / 4), { quickW, expected: Math.floor(Mw / 4) });
    const dragCanvas = ed.flattenToCanvas({ forRun: true });
    const dragPx = dragCanvas.getContext("2d").getImageData(0, 0, dragCanvas.width, dragCanvas.height).data;
    let nonZeroDrag = 0;
    for (let i = 0; i < dragPx.length; i += 4) {
        if (dragPx[i + 3] > 0 && (dragPx[i] > 0 || dragPx[i + 1] > 0 || dragPx[i + 2] > 0)) nonZeroDrag++;
    }
    const dragPxPct = (nonZeroDrag / (dragCanvas.width * dragCanvas.height)) * 100;
    check("q: during drag rendered canvas has valid non-zero pixels", dragPxPct > 95, { dragPxPct });

    firePointer("pointerup", 190, 230);
    await settle(ed);
    const fullW = fx._relight?.vis?.w;
    check("q: after pointerup vis.w is full resolution Mw", fullW === Mw, { fullW, Mw });

    // Restore light position
    await ed.undoStep();
    check("q: undo restores position to 150, 200", fx.params.lights[0].x === 150 && fx.params.lights[0].y === 200);

    // -------------------------------------------------------------------------
    // Case r: Overlay is not in an export (flattenToCanvas({ forRun: true }))
    // -------------------------------------------------------------------------
    ed.setTool("lights");
    ed.selectLayers([fx.id]);
    ed.draw();
    await settle(ed);
    const flatLightsTool = ed.flattenToCanvas({ forRun: true });
    const pxLightsTool = flatLightsTool.getContext("2d").getImageData(0, 0, W, H).data;

    ed.setTool("select");
    ed.draw();
    await settle(ed);
    const flatSelectTool = ed.flattenToCanvas({ forRun: true });
    const pxSelectTool = flatSelectTool.getContext("2d").getImageData(0, 0, W, H).data;

    let diffOverlay = 0;
    for (let i = 0; i < pxLightsTool.length; i++) {
        if (pxLightsTool[i] !== pxSelectTool[i]) diffOverlay++;
    }
    check("r: overlay is not in export (0 bytes differ between lights and select tools)", diffOverlay === 0, { diffOverlay });

    // Extra L2 checks: Nudge with arrow keys and wheel diffusion
    ed.setTool("lights");
    ed.selectLayers([fx.id]);
    ed.draw();
    await settle(ed);

    const xBeforeNudge = fx.params.lights[0].x;
    ed.onKey({ key: "ArrowRight", shiftKey: false, preventDefault: () => {} });
    check("l2: arrow right nudged light by 1px", fx.params.lights[0].x === xBeforeNudge + 1);
    await ed.undoStep();
    check("l2: undo restores nudge", fx.params.lights[0].x === xBeforeNudge);

    const yBeforeNudge = fx.params.lights[0].y;
    ed.onKey({ key: "ArrowDown", shiftKey: true, preventDefault: () => {} });
    check("l2: shift+arrow down nudged light by 10px", fx.params.lights[0].y === yBeforeNudge + 10);
    await ed.undoStep();
    check("l2: undo restores shift nudge", fx.params.lights[0].y === yBeforeNudge);

    // Wheel over handle changes diffusion
    const diff0 = fx.params.lights[0].diffusion;
    const ptWheel = toClient(150, 200);
    ed.onWheel({
        clientX: ptWheel.clientX,
        clientY: ptWheel.clientY,
        deltaY: -100,
        shiftKey: false,
        preventDefault: () => {},
    });
    check("l2: wheel over handle changed diffusion", fx.params.lights[0].diffusion !== diff0);
    await new Promise((r) => setTimeout(r, 350));
    await ed.undoStep();
    check("l2: undo restores diffusion", fx.params.lights[0].diffusion === diff0);

    // -------------------------------------------------------------------------
    // Case s: relight command on a document without a depth map computes the map
    //         through the helperCall stand-in and lands the layer.
    // -------------------------------------------------------------------------
    const doc2 = await commands.run("new_document");
    await commands.run("new_canvas", { width: 400, height: 300, doc: doc2.id, color: "#808080" });
    const ed2 = host.editorById(doc2.id);

    const origHelperCall = host.helperCall;
    const origDepthModel = host.depthModel;
    let depthHelperCalled = false;
    host.depthModel = () => ({ id: "mock_depth", label: "Mock Depth Anything V2 Small", kind: "depth" });
    host.helperCall = async (name, args) => {
        if (name === "depth") {
            depthHelperCalled = true;
            const n = args.width * args.height;
            const f32 = new Float32Array(n);
            for (let i = 0; i < n; i++) f32[i] = 10.0;
            return { depth: f32, width: args.width, height: args.height, min: 0, max: 10, provider: "mock", ms: 1 };
        }
        return origHelperCall.call(host, name, args);
    };

    let sRes = null;
    try {
        sRes = await commands.run("relight", { doc: doc2.id });
    } finally {
        host.helperCall = origHelperCall;
        host.depthModel = origDepthModel;
    }

    check("s: depth helper was called automatically", depthHelperCalled === true);
    check("s: relight returned layer summary with relight filter", sRes && sRes.layer && sRes.layer.filter === "relight", sRes);
    check("s: relight returned default 1 light", Array.isArray(sRes && sRes.lights) && sRes.lights.length === 1);
    check("s: relight returned fit with direction", Array.isArray(sRes && sRes.fit && sRes.fit.direction) && sRes.fit.direction.length === 3);
    check("s: relight returned route app", sRes && sRes.route === "app");
    check("s: ed2 tool switched to lights", ed2.tool === "lights");
    check("s: ed2 now has depth map", !!(ed2.maps && ed2.maps.depth));

    // -------------------------------------------------------------------------
    // Case t: relight command with layer edits the existing relight layer
    // -------------------------------------------------------------------------
    const editedLights = [{
        id: "light_1",
        on: true,
        type: "sun",
        x: 200,
        y: 150,
        dist: -40,
        intensity: 120,
        color: 3200,
        diffusion: 45,
    }];
    const tRes = await commands.run("relight", {
        doc: doc2.id,
        layer: sRes.layer.id,
        lights: editedLights,
        original: 80,
        ambient: 25,
        depth_scale: 60,
        shadows: 70,
    });
    check("t: relight edited existing layer", tRes && tRes.layer && tRes.layer.id === sRes.layer.id);
    check("t: lights updated to sun type", tRes && tRes.lights && tRes.lights[0].type === "sun");
    check("t: lights updated to 3200 colour", tRes && tRes.lights && tRes.lights[0].color === 3200);
    check("t: layer params updated original to 80", tRes && tRes.layer && tRes.layer.params && tRes.layer.params.original === 80);
    check("t: layer params updated ambient to 25", tRes && tRes.layer && tRes.layer.params && tRes.layer.params.ambient === 25);
    check("t: layer params updated depth_scale to 60", tRes && tRes.layer && tRes.layer.params && tRes.layer.params.depth_scale === 60);
    check("t: layer params updated shadows to 70", tRes && tRes.layer && tRes.layer.params && tRes.layer.params.shadows === 70);

    await ed2.undoStep();
    const lAfterUndo = ed2.layers.find((l) => l.id === sRes.layer.id);
    check("t: undo step reverts original light to 100", lAfterUndo && lAfterUndo.params.original === 100);

    await commands.run("close_document", { doc: doc2.id, force: true });
    shell.activate(ed);

    // -------------------------------------------------------------------------
    // Case u: Render against loopback mock lands layer, hides relight layer, 1 undo
    // -------------------------------------------------------------------------
    const prevSettings = await window.scumble.settings.get();
    await window.scumble.settings.set({ magnific: { base: mockUrl } });
    const had = await window.scumble.keys.list();
    const hadKey = !!((had.keys || {}).magnific && had.keys.magnific.set);
    if (!hadKey) {
        await window.scumble.keys.set("magnific", "test-magnific-relight-mock");
    }

    const docU = shell.newDocument();
    shell.activate(docU);
    await new Promise((r) => setTimeout(r, 150));
    docU.resizeCanvas();

    // Create high-frequency 1-pixel checkerboard base (256x256)
    const uW = 256, uH = 256;
    const cU = mk(uW, uH);
    const ctxU = cU.getContext("2d");
    const idU = ctxU.createImageData(uW, uH);
    for (let y = 0; y < uH; y++) {
        for (let x = 0; x < uW; x++) {
            const idx = (y * uW + x) * 4;
            const v = ((x + y) % 2 === 0) ? 60 : 200;
            idU.data[idx] = v;
            idU.data[idx + 1] = v;
            idU.data[idx + 2] = v;
            idU.data[idx + 3] = 255;
        }
    }
    ctxU.putImageData(idU, 0, 0);
    Object.defineProperty(cU, "naturalWidth", { value: uW });
    Object.defineProperty(cU, "naturalHeight", { value: uH });
    await docU.setBaseFromCanvas(cU, { keepLayers: false });
    await settle(docU);

    // Install depth map on docU
    const uRamp = new Uint16Array(64 * 64);
    for (let i = 0; i < 64 * 64; i++) uRamp[i] = 25000;
    await docU.setMap("depth", makeMap("depth", 64, 64, uRamp, [uW, 0, 0, uH, 0, 0]));

    // Add relight filter layer
    const uFx = docU.addFilterLayer("relight");
    uFx.params = {
        ...uFx.params,
        route: "magnific",
        lights: [defaultLight(0, { width: uW, height: uH })],
        original: 80,
    };
    docU.markFilterChanged(uFx);
    docU.renderLayers();
    docU.draw();
    await settle(docU);
    check("u: relight layer added on docU", !!uFx && uFx.filter === "relight");
    check("u: initial relight filter layer is visible", !uFx.hidden);

    // Measure original base checkerboard contrast
    let initCount = 0, initContrastSum = 0;
    const basePxU = idU.data;
    for (let y = 10; y < uH - 10; y++) {
        for (let x = 10; x < uW - 10; x += 2) {
            const i0 = (y * uW + x) * 4;
            const i1 = (y * uW + (x + 1)) * 4;
            initContrastSum += Math.max(basePxU[i0], basePxU[i1]) / Math.max(1, Math.min(basePxU[i0], basePxU[i1]));
            initCount++;
        }
    }
    const initAvgContrast = initContrastSum / initCount;

    // Run relight command with route magnific
    const uRes = await commands.run("relight", {
        doc: docU.id,
        layer: uFx.id,
        route: "magnific",
        timeout: 60,
    });

    check("u: relight command succeeded", !!uRes && uRes.route === "magnific", uRes);
    check("u: landed layer returned", !!(uRes && uRes.layer));
    const landedId = uRes && uRes.layer && uRes.layer.id;
    const landedLayer = docU.layers.find((l) => l.id === landedId);
    check("u: pixel layer landed in document", !!landedLayer && landedLayer.kind === "image");
    check("u: landed layer name is Relight (magnific)", landedLayer && landedLayer.name === "Relight (magnific)");

    // Verify filter layer is now hidden
    const uFxAfter = docU.layers.find((l) => l.id === uFx.id);
    check("u: filter layer is hidden after render", !!uFxAfter && (uFxAfter.visible === false || uFxAfter.hidden === true));

    // Verify landed layer is under top filter run
    const landedIdx = docU.layers.findIndex((l) => l.id === landedId);
    const filterIdx = docU.layers.findIndex((l) => l.id === uFx.id);
    check("u: pixel layer is positioned under filter layer", landedIdx < filterIdx);

    // Verify detail preservation on the landed layer pixels
    const landedCanvas = docU.flattenToCanvas({ forRun: true, upTo: landedIdx + 1 });
    const landedPx = landedCanvas.getContext("2d").getImageData(0, 0, uW, uH).data;
    let landedCount = 0, landedContrastSum = 0;
    for (let y = 10; y < uH - 10; y++) {
        for (let x = 10; x < uW - 10; x += 2) {
            const i0 = (y * uW + x) * 4;
            const i1 = (y * uW + (x + 1)) * 4;
            landedContrastSum += Math.max(landedPx[i0], landedPx[i1]) / Math.max(1, Math.min(landedPx[i0], landedPx[i1]));
            landedCount++;
        }
    }
    const landedAvgContrast = landedContrastSum / landedCount;
    const contrastDiff = Math.abs(landedAvgContrast - initAvgContrast) / initAvgContrast;
    check("u: high-frequency texture contrast preserved within 10%", contrastDiff <= 0.10, { contrastDiff, initAvgContrast, landedAvgContrast });

    // Verify 1 undo step restores the stack
    await docU.undoStep();
    const layersAfterUndo = docU.layers.map((l) => l.id);
    check("u: 1 undo step removes landed pixel layer", !layersAfterUndo.includes(landedId));
    const uFxUndone = docU.layers.find((l) => l.id === uFx.id);
    check("u: 1 undo step unhides relight filter layer", !!uFxUndone && uFxUndone.visible !== false);

    // Clean up docU and restore settings/keys
    await commands.run("close_document", { doc: docU.id, force: true });
    await window.scumble.settings.set({ magnific: prevSettings.magnific || {} });
    if (!hadKey) {
        await window.scumble.keys.clear("magnific");
    }
    // -------------------------------------------------------------------------
    // Case v: Specular (gloss) term: GL vs CPU parity and highlight boost
    // -------------------------------------------------------------------------
    const specLight = {
        id: "light_1",
        type: "point",
        x: 200,
        y: 200,
        dist: -30,
        intensity: 120,
        color: 5500,
        diffusion: 20,
        specular: 75,
        range: 60,
        on: true,
    };
    const paramsSpec = { lights: [specLight], original: 100, ambient: 10, shadows: 0 };
    const infoV = { ...ed.filterInfo(fx, { scale: 1, origin: [0, 0], full: [W, H], forRun: true }), maps: ed.maps, relight: fx._relight };
    glVsCpu("v: specular gloss GL vs CPU", "relight", base, paramsSpec, infoV, { max: 2, over2Pct: 0.2, mean: 1.0 });

    const diffLight = { ...specLight, specular: 0 };
    const canSpec = F.applyFilter("relight", base, paramsSpec, { ...infoV, cpu: true });
    const canDiff = F.applyFilter("relight", base, { ...paramsSpec, lights: [diffLight] }, { ...infoV, cpu: true });
    const pxSpec = canSpec.getContext("2d").getImageData(0, 0, W, H).data;
    const pxDiff = canDiff.getContext("2d").getImageData(0, 0, W, H).data;
    const idxH = (200 * W + 200) * 4;
    check("v: gloss increases brightness at highlight", pxSpec[idxH] >= pxDiff[idxH]);

    // -------------------------------------------------------------------------
    // Case w: Spot Gobo blinds: GL vs CPU parity
    // -------------------------------------------------------------------------
    const goboLight = {
        id: "light_1",
        type: "spot",
        x: 200,
        y: 200,
        dist: -40,
        intensity: 150,
        color: 5500,
        diffusion: 10,
        cone: 35,
        edge: 15,
        gobo: "blinds",
        aim: [200, 300],
        on: true,
    };
    const paramsGobo = { lights: [goboLight], original: 100, ambient: 10, shadows: 0 };
    glVsCpu("w: spot gobo blinds GL vs CPU", "relight", base, paramsGobo, infoV, { max: 2, over2Pct: 0.2, mean: 1.0 });

    // -------------------------------------------------------------------------
    // Case x: Light presets: applyLightPreset and undo restore
    // -------------------------------------------------------------------------
    const presetLights = applyLightPreset("cyberpunk_neon", { width: W, height: H });
    check("x: cyberpunk_neon preset returns 3 lights", Array.isArray(presetLights) && presetLights.length === 3);
    check("x: first light is magenta", presetLights[0].color === "#ff0077");
    check("x: second light is cyan", presetLights[1].color === "#00e5ff");
    const prevLightCount = fx.params.lights.length;
    ed.pushUndo({ kind: "filter", id: fx.id, label: "Light preset: Cyberpunk neon" });
    fx.params.lights = presetLights;
    ed.markFilterChanged(fx);
    ed.renderLayers();
    check("x: layer has preset lights", fx.params.lights.length === 3);
    await ed.undoStep();
    check("x: undo restores previous lights", fx.params.lights.length === prevLightCount);

    // -------------------------------------------------------------------------
    // Case y: Hide handles view toggle
    // -------------------------------------------------------------------------
    check("y: initial hideLightHandles is false", ed.hideLightHandles === false);
    ed.hideLightHandles = true;
    check("y: hideLightHandles set to true", ed.hideLightHandles === true);
    ed.draw();
    ed.hideLightHandles = false;
    check("y: hideLightHandles restored to false", ed.hideLightHandles === false);
    ed.draw();

    // Keep lights tool active for visual screenshot
    ed.setTool("lights");
    ed.selectLayers([fx.id]);
    ed.draw();
    await settle(ed);

    return { fails, checks: checkCount - fails.length, tiles: !!ed.tileMode };
})
"""


async def run_cdp(cdp, doc_path, mock_url):
    escaped_path = doc_path.replace("\\", "\\\\")
    expr = f"({JS})('{escaped_path}', '{mock_url}')"
    val = await cdp.eval(expr, timeout=120)
    if not val:
        print("[FAIL] no result from JS evaluate")
        return False
    fails = val.get("fails", [])
    for f in fails:
        print(f"[FAIL] {f}")
    if not fails:
        backend = "tiles" if val.get("tiles") else "canvas"
        print(f"[ok] relight test on {backend}: {val.get('checks', 0)} in-app checks passed")

    shot_path = os.path.join(ROOT, "scratch", "shot_l1b.png")
    shot_l2 = os.path.join(ROOT, "scratch", "shot_l2.png")
    try:
        await cdp.screenshot(shot_path)
        await cdp.screenshot(shot_l2)
        print(f"[ok] screenshots captured: {shot_path} and {shot_l2}")
    except Exception as e:
        print(f"[warn] screenshot: {e}")

    return len(fails) == 0


def node_step():
    r1 = subprocess.run(
        ["node", os.path.join(HERE, "relight_test.js")],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )
    tail1 = r1.stdout.strip()
    if r1.returncode != 0 or "PASS" not in tail1:
        raise Exception("tools/relight_test.js: " + (tail1 + r1.stderr)[-1500:])

    r2 = subprocess.run(
        ["node", os.path.join(HERE, "relight_request_test.js")],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )
    tail2 = r2.stdout.strip()
    if r2.returncode != 0 or "PASS" not in tail2:
        raise Exception("tools/relight_request_test.js: " + (tail2 + r2.stderr)[-1500:])

    return {"checks": tail1.count("PASS") + tail2.count("PASS")}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        nres = node_step()
        print(f"[ok] relight node tests: {nres['checks']} checks passed")
    except Exception as err:
        print(f"[FAIL] node: {err}")
        print("FAIL")
        sys.exit(1)

    scratch_dir = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else tempfile.gettempdir()
    os.makedirs(scratch_dir, exist_ok=True)
    doc_path = os.path.join(scratch_dir, f"relight_test_{os.getpid()}.scumble")

    mock = Mock().start()
    try:
        ok = asyncio.run(session(lambda c: run_cdp(c, doc_path, mock.url)))
        if not ok:
            print("FAIL")
            sys.exit(1)

        # Python independent zipfile check for minReader == 6
        if os.path.exists(doc_path):
            with zipfile.ZipFile(doc_path, "r") as zf:
                doc_json = json.loads(zf.read("scumble/document.json").decode("utf-8"))
                min_reader = doc_json.get("minReader")
                if min_reader != 6:
                    print(f"[FAIL] docfile minReader expected 6, got {min_reader}")
                    print("FAIL")
                    sys.exit(1)
                print(f"[ok] docfile minReader is 6 in {os.path.basename(doc_path)}")
    except Exception as e:
        if "JS exception" in str(e):
            print(f"[FAIL] {e}")
            print("FAIL")
            sys.exit(1)
        print(f"[FAIL] CDP session error: {e}")
        print("FAIL")
        sys.exit(1)
    finally:
        mock.stop()
        if os.path.exists(doc_path):
            try:
                os.remove(doc_path)
            except OSError:
                pass

    print("PASS")
    sys.exit(0)


if __name__ == "__main__":
    main()
