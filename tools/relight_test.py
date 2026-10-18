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
  * Case q: Over a box: the drag shows the quick shadow map at the light's new position, every reader of a
            run's picture (crop read, screenshot, a plugin's settled flatten) waits for the full map, and the
            drag reads the picture below back no time (docs/PLAN_RELIGHT_FIXES.md F2.5-F2.7).
  * Case r: the light handles are drawn on the screen under the lights tool, the H key hides all of them, and they are never
            in a run's flatten (shown / hidden and lights / select tool bitwise; F4).
  * Case fit: The fitted original light follows the picture below (a new base lit from the other side, F2.6).
  * Case route: an edit without route keeps the layer's route and renders nothing; a route goes in its own undo step
            (F3.4, inside case t).
  * Case z (F3.5): a fresh layer has no Bria light type ("From the lights"), a pick is kept and forgotten again.
  * Case undo: a relight nudge or wheel burst and a slider are two undo steps; no undo record holds an edit in
            progress (F3.1, F3.2).
  * Case cl: close() closes the tip popover and drops a pending nudge whole (F3.3).
  * Case u: a Magnific render through the loopback mock: the sent and answered sizes, the base's top/bottom ratio kept
            (a low-res read with the wrong row width breaks it), a second render sends the picture under the first
            one's relit layer (F4).
  * Case w2: a sun on the map's centre with dist 0, GL against CPU (both frontal, F4).
  * Case sh: the highlight shoulder: a strong light on a bright gradient rolls off towards white in both twins (no
            plateau at 255), also at Original light under 100 (sh2).

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
    const { commands, shotCanvas } = await import("./commands.js");
    const F = await import("./editor/inpaint_filters.js");
    const GLM = await import("./editor/inpaint_filters_gl.js");
    const { host } = await import("./editor/host.js");
    const { makeMap } = await import("./editor/inpaint_maps.js");
    const PNG = await import("./editor/inpaint_png.js");
    const RL = await import("./editor/inpaint_relight.js");
    const { defaultLight, applyLightPreset, LIGHT_PRESETS, SPOT_GOBOS } = RL;

    const fails = [];
    const notes = {};   // measured values the run prints, for judging margins and flakes
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
    const guide = new Uint8ClampedArray(Mw * Mh * 4);
    for (let y = 0; y < Mh; y++) {
        for (let x = 0; x < Mw; x++) {
            const idx = (y * Mw + x) * 4;
            const isLeft = x < 75;
            ramp[y * Mw + x] = isLeft ? 10000 : 50000;
            guide[idx + 0] = isLeft ? 220 : 40;
            guide[idx + 1] = isLeft ? 40 : 40;
            guide[idx + 2] = isLeft ? 40 : 220;
            guide[idx + 3] = 255;
        }
    }
    const depthMap = makeMap("depth", Mw, Mh, ramp, [W, 0, 0, H, 0, 0], { snap: { strength: 50 } }, guide);
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

    fx.params.lights = [{
        id: "light_0",
        on: true,
        type: "point",
        x: 100,
        y: 200,
        intensity: 0,
    }];
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);
    const flatZero = ed.flattenToCanvas({ forRun: true });
    const pxZero = flatZero.getContext("2d").getImageData(0, 0, W, H).data;
    let diffZero = 0;
    for (let i = 0; i < pxZero.length; i++) {
        if (pxZero[i] !== pxBase[i]) diffZero++;
    }
    check("a: identity with light at intensity 0", diffZero === 0, { diffZero });

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

    // Snap test: test that snap on vs off, and an r/b-swapped guide, differ in the band across the step
    const snapBase = mk(W, H);
    {
        const sctx = snapBase.getContext("2d");
        sctx.fillStyle = "#dc2828"; sctx.fillRect(0, 0, 300, H); // red on left
        sctx.fillStyle = "#2828dc"; sctx.fillRect(300, 0, 300, H); // blue on right
    }
    Object.defineProperty(snapBase, "naturalWidth", { value: W });
    Object.defineProperty(snapBase, "naturalHeight", { value: H });
    await ed.setBaseFromCanvas(snapBase, { keepLayers: true });
    await settle(ed);

    const snapGuide = new Uint8ClampedArray(Mw * Mh * 4);
    const snapGuideSwap = new Uint8ClampedArray(Mw * Mh * 4);
    for (let y = 0; y < Mh; y++) {
        for (let x = 0; x < Mw; x++) {
            const idx = (y * Mw + x) * 4;
            const isLeft = x < 75;
            snapGuide[idx + 0] = isLeft ? 220 : 40;
            snapGuide[idx + 1] = 40;
            snapGuide[idx + 2] = isLeft ? 40 : 220;
            snapGuide[idx + 3] = 255;

            snapGuideSwap[idx + 0] = snapGuide[idx + 2];
            snapGuideSwap[idx + 1] = 40;
            snapGuideSwap[idx + 2] = snapGuide[idx + 0];
            snapGuideSwap[idx + 3] = 255;
        }
    }
    fx.params.original = 50;
    fx.params.shadows = 80;
    fx.params.lights = [{
        id: "light_snap",
        on: true,
        type: "point",
        x: 450,
        y: 200,
        dist: -30,
        kelvin: 5500,
        color: "#ffffff",
        intensity: 100,
        diffusion: 30,
        range: 600,
        shadows: true,
    }];

    ed.releaseCaches({ deep: true });
    const mapSnapOff = makeMap("depth", Mw, Mh, ramp, [W, 0, 0, H, 0, 0], { snap: { strength: 0 } }, snapGuide);
    fx._relight = null;
    await ed.setMap("depth", mapSnapOff);
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);
    const pxSnapOff = ed.flattenToCanvas({ forRun: true }).getContext("2d").getImageData(0, 0, W, H).data;

    ed.releaseCaches({ deep: true });
    const mapSnapOn = makeMap("depth", Mw, Mh, ramp, [W, 0, 0, H, 0, 0], { snap: { strength: 80 } }, snapGuide);
    fx._relight = null;
    await ed.setMap("depth", mapSnapOn);
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);
    const pxSnapOn = ed.flattenToCanvas({ forRun: true }).getContext("2d").getImageData(0, 0, W, H).data;

    ed.releaseCaches({ deep: true });
    const mapSnapSwap = makeMap("depth", Mw, Mh, ramp, [W, 0, 0, H, 0, 0], { snap: { strength: 80 } }, snapGuideSwap);
    fx._relight = null;
    await ed.setMap("depth", mapSnapSwap);
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);
    const pxSnapSwap = ed.flattenToCanvas({ forRun: true }).getContext("2d").getImageData(0, 0, W, H).data;

    let diffSnapOnOff = 0, diffSnapSwap = 0;
    for (let y = 150; y < 250; y++) {
        for (let x = 280; x < 320; x++) {
            const idx = (y * W + x) * 4;
            const dOnOff = Math.max(Math.abs(pxSnapOn[idx] - pxSnapOff[idx]), Math.abs(pxSnapOn[idx + 2] - pxSnapOff[idx + 2]));
            const dSwap = Math.max(Math.abs(pxSnapOn[idx] - pxSnapSwap[idx]), Math.abs(pxSnapOn[idx + 2] - pxSnapSwap[idx + 2]));
            if (dOnOff > 2) diffSnapOnOff++;
            if (dSwap > 2) diffSnapSwap++;
        }
    }
    check("snap: snap on vs off differs in band", diffSnapOnOff > 0, { diffSnapOnOff });
    check("snap: r/b swapped guide differs in band", diffSnapSwap > 0, { diffSnapSwap });

    // Restore base and depthMap for subsequent cases
    delete fx.params.original;
    delete fx.params.shadows;
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
    ed.releaseCaches({ deep: true });
    await ed.setBaseFromCanvas(base, { keepLayers: true });
    await ed.setMap("depth", depthMap);
    ed.markFilterChanged(fx);
    ed.renderLayers();
    ed.draw();
    await settle(ed);

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
    // Case q (docs/PLAN_RELIGHT_FIXES.md F2.5 / F2.7): over a box that casts its shadow behind it, a drag shows the
    // quick map at the light's new position in the view (not a run's picture); every reader of the picture a run sees
    // (a crop read, a screenshot, a plugin's settled flatten) waits for the full map instead of reading the map of where
    // the light was or the quick map; the drag reads the picture below back no time at all (F2.6). The light moves
    // between the box's two sides, so a reader that does not wait shows the other side's shadow.
    // -------------------------------------------------------------------------
    ed._lastDown = null;
    await settle(ed);
    const qBox = new Uint16Array(Mw * Mh).fill(50000);
    for (let y = 35; y < 65; y++) for (let x = 60; x < 90; x++) qBox[y * Mw + x] = 10000;   // the box: doc 240..360 x 140..260
    const qUndo0 = ed.undo.length;
    check("q: the box depth map is installed", (await ed.setMap("depth", makeMap("depth", Mw, Mh, qBox, [W, 0, 0, H, 0, 0], {}))) === true);
    await settle(ed);
    check("q: the light starts left of the box", fx.params.lights[0].x === 150 && fx.params.lights[0].y === 200, fx.params.lights[0]);
    check("q: initially vis is full resolution", fx._relight?.vis?.w === Mw, { visW: fx._relight?.vis?.w, Mw });

    const qPx = (c) => c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const qView = () => qPx(ed.sampleRegion("image", [0, 0, W, H], 1, { forRun: false }));
    // mean luminance left of the box (doc x 100..220) and right of it (380..440), rows 176..224
    const qBands = (d) => {
        const band = (x0, x1) => {
            let s = 0, n = 0;
            for (let y = 176; y < 224; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 4; s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
            return Math.round((s / n) * 10) / 10;
        };
        return { left: band(100, 220), right: band(380, 440) };
    };
    const qDiff = (a, b) => {
        if (!a || !b || a.length !== b.length) return { max: 999, mean: 999 };
        let max = 0, sum = 0;
        for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > max) max = d; sum += d; }
        return { max, mean: Math.round((sum / a.length) * 1000) / 1000 };
    };
    const qFullCurrent = () => RL.relightVisCurrent(fx._relight?.vis, fx.params.lights, RL.relightDepthScale(fx.params), RL.relightMapKey(ed.maps.depth), false);
    const qShadowSide = (b, lightX) => (lightX < 300 ? b.right < b.left - 20 : b.left < b.right - 20);

    const qPre = qBands(qView());
    check("q: with the light on the left the box's shadow falls right of it", qShadowSide(qPre, 150), qPre);

    // the drag: five moves to the right side, a frame drawn after each; the statistics below are not read back
    let qReads = 0;
    const qIndex = ed.layers.indexOf(fx);
    const qProtoSample = Object.getPrototypeOf(ed).sampleRegion;
    ed.sampleRegion = function (source, box, scale, opts = {}) {
        if (opts && opts.upTo === qIndex) qReads++;
        return qProtoSample.call(this, source, box, scale, opts);
    };
    let qDuring = null, qDuringBands = null;
    try {
        firePointer("pointerdown", 150, 200);
        for (const x of [210, 270, 330, 390, 450]) { firePointer("pointermove", x, 200); ed.draw(); }
        while (ed._relightPending.size) await Promise.all(Array.from(ed._relightPending));
        ed.draw();
        check("q: the drag reads the picture below back no time (the fit's statistics stay)", qReads === 0, { qReads });
    } finally {
        delete ed.sampleRegion;
    }
    check("q: the light is at 450, 200 during the drag", fx.params.lights[0].x === 450 && fx.params.lights[0].y === 200, fx.params.lights[0]);
    check("q: during the drag the quick map is a quarter of the full one", fx._relight?.visQuick?.w === Math.floor(Mw / 4), { w: fx._relight?.visQuick?.w });
    check("q: the full map is still the one from before the drag", !qFullCurrent());
    check("q: the view reads the quick map", RL.pickVis(fx._relight, { quick: true }, fx.params, ed.maps.depth) === fx._relight.visQuick);
    check("q: and that quick map is current for the light at 450",
        RL.relightVisCurrent(fx._relight?.visQuick, fx.params.lights, RL.relightDepthScale(fx.params), RL.relightMapKey(ed.maps.depth), true));
    check("q: a run's picture never reads the quick map", RL.pickVis(fx._relight, { forRun: true }, fx.params, ed.maps.depth) === fx._relight.vis);
    qDuring = qView();
    qDuringBands = qBands(qDuring);

    // every reader of a run's picture, with the full map stale when it starts, against the same reader after a settle
    const PL = await import("./plugins.js");
    const qDoc = new PL.Document(ed);
    const readers = [
        ["readBoxBytes (a run's crop)", 450, async () => (await ed.readBoxBytes([0, 0, W, H])).data],
        ["screenshot", 150, async () => qPx((await shotCanvas(ed, { what: "image", show_selection: false })).canvas)],
        ["a plugin's settled flatten of a box", 450, async () => qPx(await qDoc.flatten({ box: [0, 0, W, H], maxSize: W, settled: true }))],
        ["a plugin's settled flatten", 150, async () => qPx(await qDoc.flatten({ settled: true }))],
        ["a plugin's exact settled flatten of a box", 450, async () => qPx(await qDoc.flatten({ box: [0, 0, W, H], exact: true, settled: true }))],
    ];
    let qAt = 450;
    for (const [name, x, read] of readers) {
        if (x !== qAt) {
            firePointer("pointermove", x, 200);
            qAt = x;
        }
        check(`q: ${name} starts with the full map of the other side`, !qFullCurrent());
        const a = await read();
        await settle(ed);
        const b = await read();
        const d = qDiff(a, b);
        (notes.qReaders = notes.qReaders || []).push({ name, x, ...d });
        check(`q: ${name} waits for the full map (equal to the same read after a settle)`, d.max <= 2 && d.mean <= 0.2, d);
        check(`q: ${name} shows the shadow on the side away from the light`, qShadowSide(qBands(b), x), { x, bands: qBands(b) });
    }

    // a run's pass of the filter goes with forRun (filterInfo), which is what keeps pickVis from the quick map
    firePointer("pointermove", 390, 200);
    ed._lastFilterInfoBySite = {};
    ed.flattenToCanvas({ forRun: true });
    const qRunInfos = Object.values(ed._lastFilterInfoBySite || {}).filter((i) => i && i.layer === fx);
    check("q: a run's pass of the relight filter is marked forRun", qRunInfos.length > 0 && qRunInfos.every((i) => i.forRun === true),
        qRunInfos.map((i) => i.forRun));
    qView();
    const qViewInfos = Object.values(ed._lastFilterInfoBySite || {}).filter((i) => i && i.layer === fx && i.forRun === false);
    check("q: the view's pass is not", qViewInfos.length > 0);

    // back to 450 and let go: the quick view of the drag matches the settled picture there
    firePointer("pointermove", 450, 200);
    firePointer("pointerup", 450, 200);
    await settle(ed);
    check("q: after pointerup vis.w is full resolution Mw", fx._relight?.vis?.w === Mw, { w: fx._relight?.vis?.w, Mw });
    check("q: the full map is current after the drag", qFullCurrent());
    check("q: the quick map is dropped once the full one is current", !fx._relight?.visQuick);
    const qAfter = qView();
    const qAfterBands = qBands(qAfter);
    notes.q = { pre: qPre, during: qDuringBands, after: qAfterBands, reads: qReads };
    check("q: with the light on the right the box's shadow falls left of it", qShadowSide(qAfterBands, 450), qAfterBands);
    check("q: the drag's quick view shows the shadows where the settled picture has them (within 6 levels in each band)",
        Math.abs(qDuringBands.left - qAfterBands.left) <= 6 && Math.abs(qDuringBands.right - qAfterBands.right) <= 6,
        { during: qDuringBands, after: qAfterBands, pre: qPre });

    // Restore light position and the step map
    await ed.undoStep();
    check("q: undo restores position to 150, 200", fx.params.lights[0].x === 150 && fx.params.lights[0].y === 200);
    await ed.undoStep();
    check("q: undo restores the step map", ed.maps.depth === depthMap && ed.undo.length === qUndo0, { undo: ed.undo.length, qUndo0 });
    await settle(ed);

    // the landing rule (the review of F2): a march for the key a channel wants now lands even when an older march was
    // stamped later, and one for a key the light has left never lands in the full map. Only the jobs already on their
    // way when the change ends are awaited first: the march that was running has to do it, not one started after it.
    {
        const qL = fx.params.lights[0];
        const qFull = () => RL.relightVisCurrent(fx._relight?.vis, fx.params.lights, RL.relightDepthScale(fx.params), RL.relightMapKey(ed.maps.depth), false);
        const drain = async () => { while (ed._relightPending.size) await Promise.all(Array.from(ed._relightPending)); };
        const running = async () => { await Promise.all(Array.from(ed._relightPending)); };
        check("q: the full map is current before the landing steps", qFull());
        const d0 = qL.diffusion;
        qL.diffusion = d0 + 7;                       // another key: its march starts
        ed.markFilterChanged(fx);
        qL.on = false; ed.markFilterChanged(fx);     // off and on again while it runs
        qL.on = true; ed.markFilterChanged(fx);
        await running();
        check("q: a light turned off and on while its march ran gets its shadows from that march", qFull(), fx._relight?.vis?.keys);
        await drain();
        const x0 = qL.x;
        qL.x = x0 + 60; ed.markFilterChanged(fx);     // B: its march starts
        qL.x = x0; ed.markFilterChanged(fx);          // back to A, whose full map is still there
        const seqA = fx._relight?.vis?.seq;
        await running();
        check("q: a march for a position the light has left does not land in the full map", qFull() && fx._relight?.vis?.seq === seqA,
            { keys: fx._relight?.vis?.keys, seq: fx._relight?.vis?.seq, seqA });
        await drain();
        qL.diffusion = d0;
        ed.markFilterChanged(fx);
        await settle(ed);
    }

    // -------------------------------------------------------------------------
    // Case r (docs/PLAN_RELIGHT_FIXES.md F4): the handles are drawn on the screen and never in a run's picture. No
    // brush ring: ed.hover is left at case q's last pointermove, and the select tool's ring there was the whole
    // difference of the old screen check (1450 px with drawLightsOverlay returning at once, review round 3).
    // drawLightsOverlay does not look at the tool (only its callers in drawOverlays do), so a run's flatten is also
    // compared with one where it returns at once (hideLightHandles).
    // -------------------------------------------------------------------------
    ed.hover = null;
    ed.selectLayers([fx.id]);
    ed.setTool("lights");
    ed.hideLightHandles = false;
    await settle(ed);
    ed.hover = null;   // a real pointer over the window during the settle sets it again
    check("r: the relight layer is active under the lights tool and nothing hovers", ed.tool === "lights" && ed.isRelightActive() && ed.hover === null);
    const rFlat = () => ed.flattenToCanvas({ forRun: true }).getContext("2d").getImageData(0, 0, W, H).data;
    const rScreen = () => {
        ed.draw();
        const w = ed.canvas.width, h = ed.canvas.height;
        return { w, h, d: ed.canvas.getContext("2d").getImageData(0, 0, w, h).data };
    };
    // screen pixels whose colour differs; `near[k]` of them within `reach` canvas px of anchors[k], `far` near none
    const rDiff = (a, b, anchors = [], reach = 48) => {
        if (a.w !== b.w || a.h !== b.h) return { n: -1, sizes: [a.w, a.h, b.w, b.h] };
        let n = 0, far = 0;
        const near = anchors.map(() => 0);
        for (let i = 0; i < a.d.length; i += 4) {
            if (a.d[i] === b.d[i] && a.d[i + 1] === b.d[i + 1] && a.d[i + 2] === b.d[i + 2]) continue;
            n++;
            const x = (i >> 2) % a.w, y = Math.floor((i >> 2) / a.w);
            let hit = false;
            anchors.forEach(([ax, ay], k) => { if (Math.hypot(x - ax, y - ay) <= reach) { near[k]++; hit = true; } });
            if (!hit) far++;
        }
        return { n, near, far };
    };
    const rBytes = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };

    const pxFlatShown = rFlat();          // the lights tool, the handles shown
    const scrShown = rScreen();
    ed.onKey({ key: "h", preventDefault: () => {} });   // H under the lights tool hides the handles (and keeps the tool)
    check("r: H hides the handles and keeps the lights tool", ed.hideLightHandles === true && ed.tool === "lights", { hidden: ed.hideLightHandles, tool: ed.tool });
    ed.hover = null;
    const scrHidden = rScreen();
    const pxFlatHidden = rFlat();         // drawLightsOverlay returns at once
    ed.onKey({ key: "h", preventDefault: () => {} });
    check("r: H again shows them", ed.hideLightHandles === false && ed.tool === "lights", { hidden: ed.hideLightHandles, tool: ed.tool });
    ed.hideLightHandles = false;
    ed.setTool("select");
    await settle(ed);
    ed.hover = null;
    const scrSelect = rScreen();          // the select tool, the handles not hidden: drawOverlays does not call it
    const pxFlatSelect = rFlat();

    const rLeak = { hidden: rBytes(pxFlatShown, pxFlatHidden), select: rBytes(pxFlatShown, pxFlatSelect) };
    check("r: the handles are not in a run's flatten (shown and hidden equal, bitwise)", rLeak.hidden === 0, rLeak);
    check("r: the handles are not in a run's flatten (lights and select tool equal, bitwise)", rLeak.select === 0, rLeak);

    const rAnchors = fx.params.lights.filter((l) => l).map((l) => ed.imageToScreen(l.x, l.y));
    const [rOx, rOy] = ed.ownLightPos(fx);
    rAnchors.push(ed.imageToScreen(rOx, rOy));
    const rHandles = rDiff(scrShown, scrHidden, rAnchors);
    const rPlain = rDiff(scrHidden, scrSelect);
    notes.r = { handles: rHandles, plain: rPlain, anchors: rAnchors.map(([x, y]) => [Math.round(x), Math.round(y)]) };
    check("r: the lights tool draws the handles on the screen (shown and hidden differ)", rHandles.n > 200, rHandles);
    check("r: every light and the own light have their handle where they are", rHandles.n > 0 && rHandles.near.every((k) => k > 20), rHandles);
    check("r: hiding the handles changes nothing else on the screen", rHandles.n > 0 && rHandles.far === 0, rHandles);
    check("r: the lights tool with the handles hidden draws what the select tool draws", rPlain.n === 0, rPlain);

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

    // docs/PLAN_RELIGHT_FIXES.md F1.3: a nudge begun while an undo waits (here for a tracked edit) is an edit made
    // during the wait: that undo stops and leaves it, the next undo takes it back
    {
        const xWait = fx.params.lights[0].x;
        let release = null;
        ed.trackEdit(new Promise((r) => { release = r; }));
        const u = ed.undoStep();
        ed.onKey({ key: "ArrowRight", shiftKey: false, preventDefault: () => {} });
        const xNudged = fx.params.lights[0].x;
        release();
        await u;
        const xAfterWait = fx.params.lights[0].x;
        check("l2: a nudge made while an undo waits is not undone by it", xNudged === xWait + 1 && xAfterWait === xWait + 1,
            { xWait, xNudged, xAfterWait, status: ed.status });
        check("l2: the waiting undo says it did nothing", /^Nothing undone/.test(ed.status || ""), ed.status);
        await ed.undoStep();
        check("l2: the next undo takes that nudge back", fx.params.lights[0].x === xWait, { x: fx.params.lights[0].x, xWait });
    }

    // F2.7: a reader of a run's picture waits for the full shadow map (relightIdle) and leaves a pending nudge pending:
    // a read pushes no undo step (relightSettled would commit it). The nudge's timer is stopped so the check cannot race it.
    {
        const xN = fx.params.lights[0].x;
        const undoN = ed.undo.length;
        ed.onKey({ key: "ArrowRight", shiftKey: false, preventDefault: () => {} });
        if (fx._nudgeRelightTimer) { clearTimeout(fx._nudgeRelightTimer); fx._nudgeRelightTimer = null; }
        check("l2: a nudge is pending", !!fx._nudgePending && typeof fx._flushNudge === "function" && fx.params.lights[0].x === xN + 1);
        await ed.readBoxBytes([0, 0, 16, 16]);
        check("l2: a read leaves the pending nudge pending (no undo step)", !!fx._nudgePending && ed.undo.length === undoN, { undo: ed.undo.length, undoN });
        ed.flushPendingDebounces();
        check("l2: the nudge commits as one step afterwards", !fx._nudgePending && ed.undo.length === undoN + 1, { undo: ed.undo.length, undoN });
        await ed.undoStep();
        check("l2: undo takes the nudge back", fx.params.lights[0].x === xN, { x: fx.params.lights[0].x, xN });
    }

    // -------------------------------------------------------------------------
    // Case s: relight command on a document without a depth map computes the map
    //         through the helperCall stand-in and lands the layer.
    // -------------------------------------------------------------------------
    const doc2 = await commands.run("new_document");
    const ed2 = host.editorById(doc2.id);
    const W2 = 400, H2 = 300;
    const baseSphere = mk(W2, H2);
    const ctxSphere = baseSphere.getContext("2d");
    const idSphere = ctxSphere.createImageData(W2, H2);
    const cx2 = 200, cy2 = 150, R2 = 100;
    const lx2 = -0.8, ly2 = -0.1, lz2 = 0.59;
    for (let y = 0; y < H2; y++) {
        for (let x = 0; x < W2; x++) {
            const idx = (y * W2 + x) * 4;
            const dx = (x - cx2) / R2;
            const dy = (y - cy2) / R2;
            const r2 = dx * dx + dy * dy;
            if (r2 <= 1.0) {
                const nz = Math.sqrt(1.0 - r2);
                const nx = dx, ny = dy;
                const ndl = Math.max(0, nx * lx2 + ny * ly2 + nz * lz2);
                const Y = Math.min(1.0, 0.15 + 0.8 * ndl);
                const val = Math.round(Y * 255);
                idSphere.data[idx] = val; idSphere.data[idx + 1] = val; idSphere.data[idx + 2] = val; idSphere.data[idx + 3] = 255;
            } else {
                idSphere.data[idx] = 40; idSphere.data[idx + 1] = 40; idSphere.data[idx + 2] = 40; idSphere.data[idx + 3] = 255;
            }
        }
    }
    ctxSphere.putImageData(idSphere, 0, 0);
    Object.defineProperty(baseSphere, "naturalWidth", { value: W2 });
    Object.defineProperty(baseSphere, "naturalHeight", { value: H2 });
    await ed2.setBaseFromCanvas(baseSphere, { keepLayers: false });
    await settle(ed2);

    const origHelperCall = host.helperCall;
    const origDepthModel = host.depthModel;
    let depthHelperCalled = false;
    host.depthModel = () => ({ id: "mock_depth", label: "Mock Depth Anything V2 Small", kind: "depth" });
    host.helperCall = async (name, args) => {
        if (name === "depth") {
            depthHelperCalled = true;
            const n = args.width * args.height;
            const f32 = new Float32Array(n);
            const cxM = args.width / 2, cyM = args.height / 2, rM = (100 / 400) * args.width;
            for (let y = 0; y < args.height; y++) {
                for (let x = 0; x < args.width; x++) {
                    const dx = (x - cxM) / rM;
                    const dy = (y - cyM) / rM;
                    const r2 = dx * dx + dy * dy;
                    if (r2 <= 1.0) {
                        const nz = Math.sqrt(1.0 - r2);
                        f32[y * args.width + x] = 4.0 + 6.0 * nz;
                    } else {
                        f32[y * args.width + x] = 4.0;
                    }
                }
            }
            return { depth: f32, width: args.width, height: args.height, min: 4.0, max: 10.0, provider: "mock", ms: 1 };
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
    check("s: kd > 0.2", sRes && sRes.fit && sRes.fit.kd > 0.2, sRes && sRes.fit);
    check("s: direction[0] < -0.3 (lit from left)", sRes && sRes.fit && sRes.fit.direction && sRes.fit.direction[0] < -0.3, sRes && sRes.fit);
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

    // Case route (docs/PLAN_RELIGHT_FIXES.md F3.4): an edit without route keeps the layer's route and renders nothing; a
    // route given goes in an undo step of its own and the row follows it. At 4192a6a every edit wrote route "app" after
    // its step (no step, no rebuild): the row kept showing Magnific and Render sent provider "app".
    {
        ed2.selectLayers([sRes.layer.id]);
        const rLayer = () => ed2.layers.find((l) => l.id === sRes.layer.id);
        const rRow = () => ed2.layerList && ed2.layerList.querySelector(`.ipc-layer[data-layer="${CSS.escape(sRes.layer.id)}"]`);
        const rSel = () => { const r = rRow(); const s = r && r.querySelector(".ipc-relight-route-sel"); return s ? s.value : null; };
        const rBtn = () => { const r = rRow(); return r ? r.querySelector(".ipc-relight-render") : null; };
        const rSends = [];
        const rStop = "relight gate route: stopped at the send";
        const rSaved = host.relightSend;
        try {
            host.relightSend = async (req) => { rSends.push(req.provider); throw new Error(rStop); };
            await commands.run("set_filter", { doc: doc2.id, layer: sRes.layer.id, params: { route: "magnific" } });
            ed2.renderLayers();
            check("route: set_filter put the layer on magnific, its row shows it with Render", rLayer().params.route === "magnific" && rSel() === "magnific" && !!rBtn(),
                { route: rLayer().params.route, sel: rSel(), btn: !!rBtn() });
            const l0 = { ...rLayer().params.lights[0] };
            let n0 = ed2.undo.length;
            const rA = await commands.run("relight", { doc: doc2.id, layer: sRes.layer.id, lights: [{ ...l0, x: l0.x + 37, y: 61 }] });
            check("route: lights alone keep the layer's route and say it", rLayer().params.route === "magnific" && rA.route === "magnific",
                { route: rLayer().params.route, answer: rA.route });
            check("route: lights alone are one undo step", ed2.undo.length === n0 + 1, { undo: ed2.undo.length, n0 });
            check("route: the row shows the layer's route", rSel() === rLayer().params.route, { sel: rSel(), route: rLayer().params.route });
            check("route: an edit without route renders nothing", rSends.length === 0, rSends);
            const btn = rBtn();
            if (btn) btn.click();
            for (let i = 0; i < 200 && (!rSends.length || ed2.providerPending); i++) await new Promise((r) => setTimeout(r, 50));
            check("route: Render sends the layer's route (magnific)", rSends.length === 1 && rSends[0] === "magnific", rSends);
            await ed2.undoStep();
            check("route: undo takes the lights back and keeps the route", rLayer().params.lights[0].x === l0.x && rLayer().params.route === "magnific",
                { x: rLayer().params.lights[0].x, x0: l0.x, route: rLayer().params.route });
            const rB = await commands.run("relight", { doc: doc2.id, layer: sRes.layer.id, original: 63 });
            check("route: a value alone keeps the route", rLayer().params.original === 63 && rLayer().params.route === "magnific" && rB.route === "magnific",
                { original: rLayer().params.original, route: rLayer().params.route });
            await ed2.undoStep();
            n0 = ed2.undo.length;
            await commands.run("relight", { doc: doc2.id, layer: sRes.layer.id });
            check("route: nothing given changes nothing", rLayer().params.route === "magnific" && ed2.undo.length === n0, { route: rLayer().params.route, undo: ed2.undo.length, n0 });
            const rC = await commands.run("relight", { doc: doc2.id, layer: sRes.layer.id, route: "app" });
            check("route: route app alone is one step, the row follows", rLayer().params.route === "app" && rC.route === "app" && ed2.undo.length === n0 + 1
                && ed2.undo[ed2.undo.length - 1].label === "Relight route" && rSel() === "app" && !rBtn(),
                { route: rLayer().params.route, undo: ed2.undo.length, n0, label: (ed2.undo[ed2.undo.length - 1] || {}).label, sel: rSel(), btn: !!rBtn() });
            await commands.run("relight", { doc: doc2.id, layer: sRes.layer.id, route: "app" });
            check("route: the same route again pushes no empty step", ed2.undo.length === n0 + 1, { undo: ed2.undo.length, n0 });
            await ed2.undoStep();
            check("route: undo puts magnific back, the row with it", rLayer().params.route === "magnific" && rSel() === "magnific" && !!rBtn(),
                { route: rLayer().params.route, sel: rSel(), btn: !!rBtn() });
            let rErr = null;
            try { await commands.run("relight", { doc: doc2.id, layer: sRes.layer.id, route: "bogus" }); } catch (e) { rErr = String(e && e.message); }
            check("route: an unknown route is refused", /relight route/i.test(rErr || ""), rErr);
            check("route: no command call sent anything", rSends.length === 1, rSends);
        } finally {
            host.relightSend = rSaved;
        }
    }

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

    // A 1-pixel checkerboard, 2400 x 600 (over 2048: the send goes at 2048 x 512, the mock answers at half that), with a
    // darker top half (30 / 100 over 60 / 200, the same contrast): low-frequency variation that a low-res read with the
    // wrong row width (e1ebe65: the send's 2048-wide rows read as the answer's 1024) turns into a wrong top/bottom ratio.
    const uW = 2400, uH = 600;
    const cU = mk(uW, uH);
    const ctxU = cU.getContext("2d");
    const idU = ctxU.createImageData(uW, uH);
    for (let y = 0; y < uH; y++) {
        const top = y < uH / 2;
        for (let x = 0; x < uW; x++) {
            const idx = (y * uW + x) * 4;
            const v = ((x + y) % 2 === 0) ? (top ? 30 : 60) : (top ? 100 : 200);
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
    check("u: initial relight filter layer is visible", uFx.visible !== false);

    // Measure original base checkerboard contrast
    let initCount = 0, initContrastSum = 0;
    const basePxU = idU.data;
    for (let y = 10; y < uH - 10; y += 5) {
        for (let x = 10; x < 400; x += 2) {
            const i0 = (y * uW + x) * 4;
            const i1 = (y * uW + (x + 1)) * 4;
            initContrastSum += Math.max(basePxU[i0], basePxU[i1]) / Math.max(1, Math.min(basePxU[i0], basePxU[i1]));
            initCount++;
        }
    }
    const initAvgContrast = initContrastSum / initCount;

    // channel 0's mean over rows [y0, y1) and columns [x0, x1) of an RGBA picture w wide
    const bandMean = (px, w, y0, y1, x0 = 0, x1 = w) => {
        let s = 0, n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += px[(y * w + x) * 4]; n++; }
        return s / Math.max(1, n);
    };
    // top half / bottom half, 40 px (in the document) clear of the edge at uH / 2, on a picture h high
    const topBottom = (px, w, h) => {
        const k = h / uH;
        return bandMean(px, w, Math.round(20 * k), Math.round(260 * k)) / Math.max(1e-6, bandMean(px, w, Math.round(340 * k), Math.round(580 * k)));
    };
    // what host sends (magnific.js puts these bytes into the body's image unchanged) and what the mock answers
    const uSent = [];
    const uSend0 = host.relightSend;
    host.relightSend = async (req, token) => {
        const image = req && req.image ? req.image.slice() : null;
        const out = await uSend0.call(host, req, token);
        uSent.push({ image, answer: out && out.bytes ? out.bytes.slice() : null });
        return out;
    };

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
    check("u: landed layer has relightOf", landedLayer && landedLayer.relightOf === uFx.id);

    // Verify filter layer is now hidden
    const uFxAfter = docU.layers.find((l) => l.id === uFx.id);
    check("u: filter layer is hidden after render", !!uFxAfter && uFxAfter.visible === false);

    // Verify landed layer is under top filter run
    const landedIdx = docU.layers.findIndex((l) => l.id === landedId);
    const filterIdx = docU.layers.findIndex((l) => l.id === uFx.id);
    check("u: pixel layer is positioned under filter layer", landedIdx < filterIdx);

    // The sizes: the picture as sent, the mock's answer as host got it (half the send: the low-res read must be drawn at
    // the answer's size, or its rows go with the wrong width), the landed layer at the document's size
    check("u: one picture went to the mock", uSent.length === 1, uSent.length);
    const uS1 = uSent[0] && uSent[0].image ? await decode(new Blob([uSent[0].image])) : null;
    const uA1 = uSent[0] && uSent[0].answer ? await decode(new Blob([uSent[0].answer])) : null;
    check("u: the picture went at 2048 x 512", !!uS1 && uS1.width === 2048 && uS1.height === 512, uS1 && [uS1.width, uS1.height]);
    check("u: the mock answered at 1024 x 256 (half the send)", !!uA1 && uA1.width === 1024 && uA1.height === 256, uA1 && [uA1.width, uA1.height]);
    check("u: the landed layer is 2400 x 600", !!landedLayer && landedLayer.w === uW && landedLayer.h === uH && !!landedLayer.px && landedLayer.px.width === uW && landedLayer.px.height === uH,
        landedLayer && { w: landedLayer.w, h: landedLayer.h, pw: landedLayer.px && landedLayer.px.width, ph: landedLayer.px && landedLayer.px.height });
    const tbBase = topBottom(idU.data, uW, uH);
    check("u: the picture sent keeps the base's top/bottom ratio within 3 %", !!uS1 && Math.abs(topBottom(uS1.data, uS1.width, uS1.height) / tbBase - 1) <= 0.03,
        uS1 && { tbBase, tbSent: topBottom(uS1.data, uS1.width, uS1.height) });
    // and its levels where the layer's light falls (the light sits at the centre, on the line topBottom splits at, so a read
    // that took the relight layer's own picture in would keep the ratio; it lifts these bands by about 7 %)
    const uLit = uS1 ? [bandMean(uS1.data, uS1.width, 17, 222, 850, 1200), bandMean(uS1.data, uS1.width, 290, 495, 850, 1200)] : [];
    check("u: the picture sent has the base's levels under the light (65 and 130 within 1.5)", uLit.length === 2 && Math.abs(uLit[0] - 65) <= 1.5 && Math.abs(uLit[1] - 130) <= 1.5, uLit);
    // the landed layer's pixels: it is opaque and covers the picture, so the stack up to it shows only it
    const landedCanvas = docU.flattenToCanvas({ forRun: true, upTo: landedIdx + 1 });
    const landedPx = landedCanvas.getContext("2d").getImageData(0, 0, uW, uH).data;
    let landedCount = 0, landedContrastSum = 0;
    for (let y = 10; y < uH - 10; y += 5) {
        for (let x = 10; x < 400; x += 2) {
            const i0 = (y * uW + x) * 4;
            const i1 = (y * uW + (x + 1)) * 4;
            landedContrastSum += Math.max(landedPx[i0], landedPx[i1]) / Math.max(1, Math.min(landedPx[i0], landedPx[i1]));
            landedCount++;
        }
    }
    const landedAvgContrast = landedContrastSum / landedCount;
    const contrastDiff = Math.abs(landedAvgContrast - initAvgContrast) / initAvgContrast;
    check("u: high-frequency texture contrast preserved within 10%", contrastDiff <= 0.10, { contrastDiff, initAvgContrast, landedAvgContrast });

    // Verify left/right brightness > 1.2
    let leftSum = 0, rightSum = 0, nLeft = 0, nRight = 0;
    for (let y = 10; y < uH - 10; y += 5) {
        for (let x = 10; x < 400; x += 2) {
            const idx = (y * uW + x) * 4;
            leftSum += landedPx[idx];
            nLeft++;
        }
        for (let x = uW - 400; x < uW - 10; x += 2) {
            const idx = (y * uW + x) * 4;
            rightSum += landedPx[idx];
            nRight++;
        }
    }
    const leftMean = leftSum / Math.max(1, nLeft);
    const rightMean = rightSum / Math.max(1, nRight);
    const ratioLR = leftMean / Math.max(1, rightMean);
    check("u: left/right brightness > 1.2", ratioLR > 1.2, { ratioLR, leftMean, rightMean });
    // the mock's light varies along x only: the landed layer keeps the base's top/bottom ratio
    const tbLand = topBottom(landedPx, uW, uH);
    check("u: the landed layer keeps the base's top/bottom ratio within 5 %", Math.abs(tbLand / tbBase - 1) <= 0.05, { tbBase, tbLand });

    // Verify 1 undo step restores the stack
    await docU.undoStep();
    const layersAfterUndo = docU.layers.map((l) => l.id);
    check("u: 1 undo step removes landed pixel layer", !layersAfterUndo.includes(landedId));
    const uFxUndone = docU.layers.find((l) => l.id === uFx.id);
    check("u: 1 undo step unhides relight filter layer", !!uFxUndone && uFxUndone.visible !== false);

    // Redo step restores the landed layer for subsequent checks
    await docU.redoStep();

    // Verify relightOf round-trip through getValue -> setValue and second read skipping result
    const valU = docU.getValue();
    await docU.setValue(valU);
    await settle(docU);
    const restoredLanded = docU.layers.find((l) => l.id === landedId);
    check("u: relightOf restored after getValue -> setValue", restoredLanded && restoredLanded.relightOf === uFx.id);

    // the relit layer shows again after the round trip (else a read that took it in would look like the base)
    const shownPx = docU.flattenToCanvas({ forRun: true }).getContext("2d").getImageData(0, 0, uW, uH).data;
    const leftBaseU = bandMean(idU.data, uW, 0, uH, 0, 300), leftShownU = bandMean(shownPx, uW, 0, uH, 0, 300);
    check("u: after the round trip the relit layer shows (its left band over 1.1 x the base's)", leftShownU > leftBaseU * 1.1, { leftBaseU, leftShownU });
    // a second render reads the picture under the first one's relit layer (host's own skip, through the mock): the same
    // picture as the first send, not the relit one
    let uRes2 = null;
    try {
        uRes2 = await commands.run("relight", { doc: docU.id, layer: uFx.id, route: "magnific", timeout: 60 });
    } finally {
        host.relightSend = uSend0;
    }
    check("u: the second render ran and landed a new layer", !!uRes2 && !!uRes2.layer && uRes2.layer.id !== landedId && uSent.length === 2,
        { layer: uRes2 && uRes2.layer && uRes2.layer.id, sends: uSent.length });
    const uS2 = uSent[1] && uSent[1].image ? await decode(new Blob([uSent[1].image])) : null;
    const quadU = (p) => (p ? [[0, 128, 0, 300], [0, 128, 1748, 2048], [384, 512, 0, 300], [384, 512, 1748, 2048]].map(([y0, y1, x0, x1]) => bandMean(p.data, p.width, y0, y1, x0, x1)) : []);
    const q1 = quadU(uS1), q2 = quadU(uS2);
    const qOff = q1.length === 4 && q2.length === 4 ? Math.max(...q1.map((v, i) => Math.abs(v - q2[i]))) : Infinity;
    check("u: the second render sent the picture under the relit layer (four band means within 1.5 levels of the first send)",
        !!uS2 && uS2.width === 2048 && uS2.height === 512 && qOff <= 1.5, { q1, q2 });
    check("u: the first render's relit layer is shown again after the second read", docU.layers.some((l) => l.id === landedId && l.visible));
    notes.u = { tbBase, tbLand, sent: uS1 && [uS1.width, uS1.height], answer: uA1 && [uA1.width, uA1.height], q1, q2, leftBaseU, leftShownU };

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

    // Case w2 (F4): a sun on the map's centre with dist 0 has no direction of its own; the shader lights it from the
    // front, and so must the CPU twin (at 2f9aa60 it kept the zero vector: diffusion / (1 + diffusion) for every normal)
    const centreSun = { id: "light_1", type: "sun", x: W / 2, y: H / 2, dist: 0, intensity: 40, color: 5500, diffusion: 30, on: true };
    const w2Base = mk(W, H);
    {
        const g = w2Base.getContext("2d"), grad = g.createLinearGradient(0, 0, W, H);
        grad.addColorStop(0, "#203040");
        grad.addColorStop(1, "#e0c0a0");
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
    }
    glVsCpu("w2: sun at the centre with dist 0, GL vs CPU", "relight", w2Base, { lights: [centreSun], original: 100, ambient: 10, shadows: 0 }, infoV, { max: 2, over2Pct: 0.2, mean: 1.0 });

    // Case sh (the user, 2026-10-13): the highlight shoulder. A strong light on a bright gradient rolls off towards white
    // in both twins instead of a plateau at 255 (at 8213449 the picture plus the light clipped hard: 113,988 of the
    // 240,000 pixels at 255; with the shoulder none, the brightest 254).
    const shBase = mk(W, H);
    {
        const g = shBase.getContext("2d"), grad = g.createLinearGradient(0, 0, W, 0);
        grad.addColorStop(0, "#b4b4b4");
        grad.addColorStop(1, "#f0f0f0");
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
    }
    const shLight = { id: "light_1", type: "point", x: W / 2, y: H / 2, dist: -30, intensity: 120, color: 5500, diffusion: 30, on: true };
    const shParams = { lights: [shLight], original: 100, ambient: 15, shadows: 0 };
    glVsCpu("sh: the highlight shoulder, GL vs CPU", "relight", shBase, shParams, infoV, { max: 2, over2Pct: 0.2, mean: 1.0 });
    {
        const shOut = F.applyFilter("relight", shBase, shParams, { ...infoV, cpu: true }).getContext("2d").getImageData(0, 0, W, H).data;
        const shIn = shBase.getContext("2d").getImageData(0, 0, W, H).data;
        let at255 = 0, brighter = 0;
        for (let i = 0; i < W * H * 4; i += 4) {
            if (shOut[i] === 255) at255++;
            if (shOut[i] > shIn[i] + 8) brighter++;
        }
        notes.sh = { at255, brighter };
        check("sh: the light brightens a good part of the picture", brighter > W * H * 0.05, notes.sh);
        check("sh: and leaves almost none of it at 255 (under 0.5 % of the lit part)", at255 < brighter * 0.005, notes.sh);
    }
    // the same with Original light under 100: the Ambient fill is part of the picture without the lights in both twins
    glVsCpu("sh2: the shoulder at Original 60, Ambient 60, GL vs CPU", "relight", shBase, { ...shParams, original: 60, ambient: 60 }, infoV, { max: 2, over2Pct: 0.2, mean: 1.0 });

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

    // -------------------------------------------------------------------------
    // Case z: a fresh relight layer sends the relight LoRA at full strength (docs/PLAN_RELIGHT_FIXES.md F1.4): the
    // 0..100 % strength becomes strength_model 1.0 on comfyui (the graph's lora_relight) and comfycloud (10:118)
    // -------------------------------------------------------------------------
    const docZ = shell.newDocument();
    shell.activate(docZ);
    await new Promise((r) => setTimeout(r, 150));
    docZ.resizeCanvas();
    const zW = 320, zH = 200;
    const cZ = mk(zW, zH);
    const ctxZ = cZ.getContext("2d");
    ctxZ.fillStyle = "#808080";
    ctxZ.fillRect(0, 0, zW, zH);
    Object.defineProperty(cZ, "naturalWidth", { value: zW });
    Object.defineProperty(cZ, "naturalHeight", { value: zH });
    await docZ.setBaseFromCanvas(cZ, { keepLayers: false });
    await settle(docZ);
    const zRamp = new Uint16Array(32 * 32);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) zRamp[y * 32 + x] = 10000 + x * 1000;
    await docZ.setMap("depth", makeMap("depth", 32, 32, zRamp, [zW, 0, 0, zH, 0, 0]));
    const zFx = docZ.addFilterLayer("relight");
    zFx.params.lights = [defaultLight(0, { width: zW, height: zH })];
    docZ.markFilterChanged(zFx);
    await settle(docZ);
    check("z: a fresh relight layer keeps the LoRA strength in percent (100)", zFx.params.lora_strength === 100, zFx.params.lora_strength);
    const zStop = "relight gate z: stopped at the send";
    const zSaved = { connected: host.connected, objectInfo: host.objectInfo, models: host.checkComfyRelightModels,
        upload: host.uploadInput, run: host.comfyPictureRun, send: host.relightSend };
    let zLocal = null, zCloud = null, zErrLocal = null, zErrCloud = null;
    try {
        host.connected = true;
        if (!host.objectInfo) host.objectInfo = {};
        host.checkComfyRelightModels = () => {};
        host.uploadInput = async (blob, name) => ({ filename: name, subfolder: "", type: "input" });
        host.comfyPictureRun = async (editor, graph) => { zLocal = JSON.parse(JSON.stringify(graph)); throw new Error(zStop); };
        host.relightSend = async (req) => { zCloud = { provider: req.provider, params: { ...(req.params || {}) } }; throw new Error(zStop); };
        try { await host.relightWhole(docZ, zFx, { route: "comfyui" }); } catch (e) { zErrLocal = String(e && e.message); }
        try { await host.relightWhole(docZ, zFx, { route: "comfycloud" }); } catch (e) { zErrCloud = String(e && e.message); }
        // 1.0 is also the local graph's own value: a strength the slider set (55 %) must reach both routes as 0.55
        const zFresh = { local: zLocal, cloud: zCloud };
        zFx.params.lora_strength = 55;
        zLocal = null; zCloud = null;
        try { await host.relightWhole(docZ, zFx, { route: "comfyui" }); } catch (_) { /* the stub stops it */ }
        try { await host.relightWhole(docZ, zFx, { route: "comfycloud" }); } catch (_) { /* the stub stops it */ }
        const z55 = { local: zLocal && zLocal.lora_relight && zLocal.lora_relight.inputs.strength_model, cloud: zCloud && zCloud.params["10:118|strength_model"] };
        check("z: a 55 % LoRA strength goes as 0.55 on comfyui and comfycloud", z55.local === 0.55 && z55.cloud === 0.55, z55);
        zLocal = zFresh.local; zCloud = zFresh.cloud;
    } finally {
        host.connected = zSaved.connected;
        host.objectInfo = zSaved.objectInfo;
        host.checkComfyRelightModels = zSaved.models;
        host.uploadInput = zSaved.upload;
        host.comfyPictureRun = zSaved.run;
        host.relightSend = zSaved.send;
    }
    const zLora = zLocal && zLocal.lora_relight && zLocal.lora_relight.inputs;
    check("z: comfyui reached the send", !!zLocal && (zErrLocal || "").includes(zStop), { zErrLocal });
    check("z: comfyui sends lora_relight strength_model 1.0", !!zLora && zLora.strength_model === 1, zLora);
    check("z: comfycloud reached the send", !!zCloud && zCloud.provider === "comfycloud" && (zErrCloud || "").includes(zStop), { zErrCloud });
    check("z: comfycloud sends 10:118 strength_model 1.0", !!zCloud && zCloud.params["10:118|strength_model"] === 1, zCloud);

    // Case p (QW4, docs/PLAN_COMFY_SDK.md S8): an agent picks one of the panel's light presets by name; its lights land
    // placed on this picture as the panel would place them; refused beside lights, and by an unknown name with the names
    {
        const pRes = await commands.run("relight", { doc: docZ.node.id, preset: "golden_hour" });
        const pl = docZ.layers.find((l) => l.id === (pRes && pRes.layer && pRes.layer.id));
        const want = applyLightPreset("golden_hour", { width: docZ.width, height: docZ.height });
        const got = (pl && pl.params && pl.params.lights) || [];
        check("p: preset golden_hour gives that preset's lights at this picture's size (count, places, colours)",
            !!pl && got.length === want.length && got.every((l, i) => l.x === want[i].x && l.y === want[i].y && l.color === want[i].color && l.type === want[i].type),
            { got: got.map((l) => [l.type, l.x, l.y, l.color]), want: want.map((l) => [l.type, l.x, l.y, l.color]) });
        let both = null, unknown = null;
        try { await commands.run("relight", { doc: docZ.node.id, preset: "film_noir", lights: [] }); } catch (e) { both = String(e.message || e); }
        try { await commands.run("relight", { doc: docZ.node.id, preset: "moonlight" }); } catch (e) { unknown = String(e.message || e); }
        check("p: preset beside lights is refused; an unknown preset is refused with the names", /either preset or lights/.test(both || "")
            && /Unknown light preset "moonlight"/.test(unknown || "") && LIGHT_PRESETS.every((x) => (unknown || "").includes(x.id)), { both, unknown });
        if (pl) docZ.removeLayer(pl.id);
    }

    // Case z, F3.5: the Bria light type is "From the lights" until the user picks one. At 4192a6a every new layer took
    // "soft overcast daylight lighting" from host's defaults, so Bria never got the type the lights give (a spot here;
    // the default point light gives that same string, so it would prove nothing).
    {
        check("z: a fresh relight layer has no light type", zFx.params.light_type === undefined, zFx.params.light_type);
        zFx.params.lights = [{ ...defaultLight(0, { width: zW, height: zH }), type: "spot" }];
        docZ.markFilterChanged(zFx);
        await settle(docZ);
        const zbSaved = host.relightSend;
        const zBria = [];
        const zbStop = "relight gate z: stopped at the Bria send";
        const sendBria = async () => { try { await host.relightWhole(docZ, zFx, { route: "fal-bria" }); } catch (_) { /* the stub stops it */ } };
        try {
            host.relightSend = async (req) => { zBria.push({ top: req.light_type, param: req.params && req.params.light_type }); throw new Error(zbStop); };
            await sendBria();
            check("z: Bria gets the type a spot gives", zBria.length === 1 && zBria[0].top === "spotlight on subject" && zBria[0].param === "spotlight on subject", zBria);
            zFx.params.route = "fal-bria";
            const ltSel = () => docZ.buildRelightBlock(zFx).querySelector(".ipc-relight-bria-row select");
            const s1 = ltSel();
            check("z: the Bria row starts on From the lights", !!s1 && s1.value === "" && !!s1.options[0] && s1.options[0].textContent === "From the lights",
                s1 && { value: s1.value, first: s1.options[0] && s1.options[0].textContent });
            if (s1) { s1.value = "moonlight lighting"; s1.dispatchEvent(new Event("change")); }
            check("z: a picked type is the layer's and remembered", zFx.params.light_type === "moonlight lighting" && host.getRelightSettings().light_type === "moonlight lighting",
                { layer: zFx.params.light_type, kept: host.getRelightSettings().light_type });
            await sendBria();
            check("z: Bria gets the picked type", zBria.length === 2 && zBria[1].top === "moonlight lighting", zBria);
            const zNew = docZ.addFilterLayer("relight");
            check("z: a new relight layer takes the picked type", !!zNew && zNew.params.light_type === "moonlight lighting", zNew && zNew.params.light_type);
            const s2 = ltSel();
            if (s2) { s2.value = ""; s2.dispatchEvent(new Event("change")); }
            await new Promise((r) => setTimeout(r, 150));   // the settings write is not awaited by the panel
            const zStored = await window.scumble.settings.get();
            check("z: From the lights forgets the pick on the layer and in the stored settings",
                !("light_type" in zFx.params) && host.getRelightSettings().light_type === undefined && !(zStored.relight && "light_type" in zStored.relight),
                { layer: zFx.params.light_type, kept: host.getRelightSettings().light_type, stored: zStored.relight });
            await docZ.undoStep();
            check("z: undo brings the picked type back", zFx.params.light_type === "moonlight lighting", zFx.params.light_type);
        } finally {
            host.relightSend = zbSaved;
            host.setRelightSettings({ light_type: undefined });   // the profile ends as it began: no pick
        }
    }
    await commands.run("close_document", { doc: docZ.id, force: true });

    // -------------------------------------------------------------------------
    // Case fit (docs/PLAN_RELIGHT_FIXES.md F2.6): the fitted original light follows the picture below. A ball lit from
    // the left fits a light on the left; the same document over the ball lit from the right (a new base, the layer and
    // the map kept) fits one on the right. At 77da63f the fit stayed on the left: its cache ignored the picture.
    // -------------------------------------------------------------------------
    const docF = shell.newDocument();
    shell.activate(docF);
    await new Promise((r) => setTimeout(r, 150));
    docF.resizeCanvas();
    const fS = 256, fM = 64;
    const fBall = (lx) => {
        const c = mk(fS, fS), g = c.getContext("2d"), img = g.createImageData(fS, fS);
        for (let y = 0; y < fS; y++) {
            for (let x = 0; x < fS; x++) {
                const dx = (x + 0.5 - fS / 2) / (fS * 0.4), dy = (y + 0.5 - fS / 2) / (fS * 0.4), r2 = dx * dx + dy * dy, i = (y * fS + x) * 4;
                let v = 50;
                if (r2 <= 1) v = Math.round(Math.min(1, 0.2 + 0.8 * Math.max(0, dx * lx - dy * 0.5 + Math.sqrt(1 - r2) * 0.707)) * 255);
                img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
                img.data[i + 3] = 255;
            }
        }
        g.putImageData(img, 0, 0);
        Object.defineProperty(c, "naturalWidth", { value: fS });
        Object.defineProperty(c, "naturalHeight", { value: fS });
        return c;
    };
    const fDepth = new Uint16Array(fM * fM);
    for (let y = 0; y < fM; y++) {
        for (let x = 0; x < fM; x++) {
            const dx = (x + 0.5 - fM / 2) / (fM * 0.4), dy = (y + 0.5 - fM / 2) / (fM * 0.4), r2 = dx * dx + dy * dy;
            fDepth[y * fM + x] = r2 <= 1 ? Math.round(30000 - Math.sqrt(1 - r2) * 15000) : 45000;
        }
    }
    await docF.setBaseFromCanvas(fBall(-0.5), { keepLayers: false });
    await settle(docF);
    await docF.setMap("depth", makeMap("depth", fM, fM, fDepth, [fS, 0, 0, fS, 0, 0]));
    const fFx = docF.addFilterLayer("relight");
    fFx.params.lights = [defaultLight(0, { width: fS, height: fS })];
    docF.markFilterChanged(fFx);
    await settle(docF);
    const fLeft = docF.belowStats(fFx, false)?.fit?.l0;
    check("fit: a ball lit from the left fits a light on the left", !!fLeft && fLeft[0] < -0.2, fLeft);
    // a run's statistics too: made after the layer's cache exists, so the fit is cached there as in a working document
    const fLeftRun = docF.belowStats(fFx, true)?.fit?.l0;
    check("fit: a run's statistics fit the left too", !!fLeftRun && fLeftRun[0] < -0.2, fLeftRun);
    check("fit: the fit is cached on the layer", !!(fFx._relight && fFx._relight._fitKey));
    await docF.setBaseFromCanvas(fBall(0.5), { keepLayers: true });
    await settle(docF);
    check("fit: the layer and the map stay over the new base", docF.layers.includes(fFx) && !!(docF.maps && docF.maps.depth));
    const fRight = docF.belowStats(fFx, false)?.fit?.l0;
    check("fit: the same document over the ball lit from the right fits a light on the right", !!fRight && fRight[0] > 0.2, fRight);
    const fRun = docF.belowStats(fFx, true)?.fit?.l0;
    notes.fit = { left: fLeft, right: fRight, run: fRun };

    // the fit reads the layer's depth_scale and sigma (wholeStatsParams): a change refits, a light move does not
    const fStats0 = docF.belowStats(fFx, false), fKey0 = fFx._relight && fFx._relight._fitKey, fDs0 = fFx.params.depth_scale;
    fFx.params.lights[0].x += 20;
    docF.markFilterChanged(fFx);
    check("fit: a light move keeps the statistics", docF.belowStats(fFx, false) === fStats0);
    fFx.params.depth_scale = 90;
    docF.markFilterChanged(fFx);
    const fStats1 = docF.belowStats(fFx, false);
    check("fit: a depth_scale change refits", !!fStats1 && fStats1 !== fStats0 && !!fFx._relight && fFx._relight._fitKey !== fKey0,
        { key0: fKey0, key1: fFx._relight && fFx._relight._fitKey });
    fFx.params.depth_scale = fDs0;
    docF.markFilterChanged(fFx);
    await settle(docF);

    // statistics above a relight layer follow its shadow maps as they land (the review of F2): a Normalise over it, the
    // light moved to the other side of a box, the Normalise's statistics read before and after the march lands
    const fBox = new Uint16Array(fM * fM).fill(50000);
    for (let y = 24; y < 40; y++) for (let x = 24; x < 40; x++) fBox[y * fM + x] = 10000;
    await docF.setMap("depth", makeMap("depth", fM, fM, fBox, [fS, 0, 0, fS, 0, 0]));
    fFx.params.lights = [{ ...defaultLight(0, { width: fS, height: fS }), x: 40, y: 128, dist: -30, range: 400 }];
    fFx.params.shadows = 100;
    docF.markFilterChanged(fFx);
    docF.selectLayers([fFx.id]);
    const fNorm = docF.addFilterLayer("normalize");
    check("fit: the Normalise sits over the relight layer", docF.layers.indexOf(fNorm) > docF.layers.indexOf(fFx));
    await settle(docF);
    docF.belowStats(fNorm, false);
    fFx.params.lights[0].x = 216;   // the other side of the box
    docF.markFilterChanged(fFx);
    const nPre = docF.belowStats(fNorm, false);   // before the march lands: the shadow of the old side
    while (docF._relightPending.size) await Promise.all(Array.from(docF._relightPending));
    const nPost = docF.belowStats(fNorm, false);
    fNorm._bstats = null;
    const nFresh = docF.belowStats(fNorm, false);
    const fMeanDiff = (a, b) => (a && b && a.mean && b.mean) ? Math.max(...a.mean.map((v, i) => Math.abs(v - b.mean[i]))) : 999;
    notes.norm = { pre: nPre && nPre.mean, post: nPost && nPost.mean, fresh: nFresh && nFresh.mean };
    check("fit: the box's shadow moves the statistics above (so the next check can fail)", fMeanDiff(nPre, nFresh) > 1e-6, notes.norm);
    check("fit: a Normalise over the relight layer re-reads the picture when the shadow map lands", fMeanDiff(nPost, nFresh) < 1e-9, notes.norm);
    check("fit: a run's statistics fit the right too", !!fRun && fRun[0] > 0.2, fRun);
    await commands.run("close_document", { doc: docF.id, force: true });

    // -------------------------------------------------------------------------
    // Case undo (docs/PLAN_RELIGHT_FIXES.md F3.1 / F3.2): a relight nudge or wheel burst is an undo step of its own. A
    // slider moved within the burst's 300 ms is a second step: at 4192a6a both used `_undoPending`, so the same snapshot
    // was pushed twice (the slider's undo took the nudge back too, the next undo did nothing). And no undo record holds an
    // edit still in progress: a nudge pending at Ctrl+J came back with the undo, its flush and its snapshot included.
    // -------------------------------------------------------------------------
    {
        const docH = shell.newDocument();
        shell.activate(docH);
        await new Promise((r) => setTimeout(r, 150));
        docH.resizeCanvas();
        await docH.setBaseFromCanvas(fBall(-0.5), { keepLayers: false });
        await settle(docH);
        await docH.setMap("depth", makeMap("depth", fM, fM, fDepth, [fS, 0, 0, fS, 0, 0]));
        const hFx = docH.addFilterLayer("relight");
        hFx.params.lights = [{ ...defaultLight(0, { width: fS, height: fS }), x: 60, y: 128 }];
        docH.markFilterChanged(hFx);
        docH.selectLayers([hFx.id]);
        docH.setTool("lights");
        await settle(docH);
        const hId = hFx.id;
        const cur = () => docH.layers.find((l) => l.id === hId);
        const lt = () => cur().params.lights[0];
        cur()._selectedLightId = lt().id;
        const nudge = () => docH.onKey({ key: "ArrowRight", shiftKey: false, preventDefault: () => {} });
        const wheel = () => {
            const rect = docH.canvas.getBoundingClientRect();
            const [sx, sy] = docH.imageToScreen(lt().x, lt().y);
            docH.onWheel({ clientX: rect.left + sx * rect.width / docH.canvas.width, clientY: rect.top + sy * rect.height / docH.canvas.height,
                deltaY: -100, shiftKey: false, preventDefault: () => {} });
        };
        // a relight block slider of the layer as it is now (an undo may have put another object in its place)
        const slider = (title, v, { input = true, change = true } = {}) => {
            const s = Array.from(docH.buildRelightBlock(cur()).querySelectorAll(".ipc-relight-controls input[type='range']")).find((x) => x.title === title);
            if (!s) return false;
            s.value = String(v);
            if (input) s.dispatchEvent(new Event("input"));
            if (change) s.dispatchEvent(new Event("change"));
            return true;
        };
        const steps = (n0) => docH.undo.slice(n0).map((s) => s.label);
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const state = () => ({ x: lt().x, i: lt().intensity, d: lt().diffusion, shadows: cur().params.shadows });

        // a1: a nudge, then the Intensity slider (no wait between: the nudge's 300 ms have not run out)
        let s0 = state(), n0 = docH.undo.length;
        nudge();
        const a1Slid = slider("Intensity", 150);
        const a1 = { slid: a1Slid, labels: steps(n0), distinct: docH.undo[n0] !== docH.undo[n0 + 1] };
        check("undo: a nudge and a slider within its 300 ms are two steps", a1.slid && a1.labels.length === 2 && a1.distinct
            && a1.labels[0] === "Move light" && a1.labels[1] === "Relight: Intensity", a1);
        await docH.undoStep();
        const a1u1 = state();
        await docH.undoStep();
        const a1u2 = state();
        await docH.redoStep();
        const a1r1 = state();
        await docH.redoStep();
        const a1r2 = state();
        check("undo: the slider's undo keeps the nudge", a1u1.x === s0.x + 1 && a1u1.i === s0.i, { a1u1, s0 });
        check("undo: the next undo takes the nudge back", a1u2.x === s0.x && a1u2.i === s0.i, { a1u2, s0 });
        check("undo: redo brings the nudge back alone", a1r1.x === s0.x + 1 && a1r1.i === s0.i, { a1r1, s0 });
        check("undo: the next redo brings the slider back", a1r2.x === s0.x + 1 && a1r2.i === 150, { a1r2 });

        // a2: a wheel burst (diffusion), then the Intensity slider
        s0 = state(); n0 = docH.undo.length;
        wheel();
        const a2d = lt().diffusion;
        slider("Intensity", 120);
        const a2labels = steps(n0);
        check("undo: a wheel burst and a slider within its 300 ms are two steps", a2d !== s0.d && a2labels.length === 2
            && a2labels[0] === "Relight: Diffusion" && a2labels[1] === "Relight: Intensity", { a2labels, d: a2d, d0: s0.d });
        await docH.undoStep();
        const a2u1 = state();
        check("undo: the slider's undo keeps the wheel's diffusion", a2u1.d === a2d && a2u1.i === s0.i, { a2u1, a2d, s0 });
        await docH.undoStep();
        check("undo: the next undo takes the diffusion back", lt().diffusion === s0.d, { d: lt().diffusion, s0 });

        // a3: a slider drag that outlives the nudge's 300 ms: its step still begins where the drag began
        s0 = state();
        nudge();
        slider("Intensity", 160, { change: false });
        await sleep(350);   // the nudge's timer pushes its step mid-drag
        slider("Intensity", 170);
        await docH.undoStep();
        const a3 = state();
        check("undo: a slider drag across the nudge's timer undoes to where the drag began", a3.x === s0.x + 1 && a3.i === s0.i, { a3, s0 });
        await docH.undoStep();

        // a5: the generic sliders (here Shadows) share the rule
        s0 = state(); n0 = docH.undo.length;
        nudge();
        const shRange = Array.from(docH.buildFilterControls(cur()).children).find((x) => x.type === "range" && x.title === "Shadows");
        if (shRange) {
            shRange.value = String((s0.shadows || 60) === 30 ? 40 : 30);
            shRange.dispatchEvent(new Event("input"));
            shRange.dispatchEvent(new Event("change"));
        }
        check("undo: a nudge and a generic slider are two steps", !!shRange && steps(n0).length === 2 && docH.undo[n0] !== docH.undo[n0 + 1], steps(n0));
        await docH.undoStep();
        check("undo: the generic slider's undo keeps the nudge", lt().x === s0.x + 1 && cur().params.shadows === s0.shadows, { s: state(), s0 });
        await docH.undoStep();

        // a4: nudge, wheel, nudge: three steps in their order, and undoing them all ends where it began
        s0 = state(); n0 = docH.undo.length;
        nudge();
        wheel();
        nudge();
        await sleep(350);
        let guard = 0;
        while (docH.undo.length > n0 && guard++ < 6) await docH.undoStep();
        check("undo: nudge, wheel, nudge undone step by step end at the start", lt().x === s0.x && lt().diffusion === s0.d, { s: state(), s0, guard });

        // b: a nudge pending at Ctrl+J, then undo: the record holds no edit in progress
        s0 = state(); n0 = docH.undo.length;
        nudge();
        docH.duplicateLayer(cur());
        const bLabels = steps(n0);
        check("undo: a pending nudge is its own step before the duplicate", bLabels.length === 2 && bLabels[0] === "Move light" && bLabels[1] === "Duplicate layer", bLabels);
        const dup = docH.undo[docH.undo.length - 1];
        const inProgress = ["_flushNudge", "_undoPending", "_nudgePending", "_nudgeRelightTimer", "_undoLabel"];
        const carried = ((dup && dup.layers) || []).flatMap((r) => inProgress.filter((k) => r[k] != null).map((k) => `${r.name}.${k}`));
        check("undo: the duplicate's undo record holds no nudge in progress", carried.length === 0, carried);
        await docH.undoStep();
        const held = docH.layers.flatMap((l) => ["_flushNudge", "_undoPending", "_nudgePending"].filter((k) => l[k] != null).map((k) => `${l.name}.${k}`));
        check("undo: after the undo no layer holds a nudge in progress", held.length === 0, held);
        const seen = [];
        const hadOwn = Object.prototype.hasOwnProperty.call(docH, "ensureRelightMaps"), ensure0 = docH.ensureRelightMaps;
        docH.ensureRelightMaps = function (layer, o) { seen.push(layer); return ensure0.call(this, layer, o); };
        try { docH.flushPendingDebounces(); } finally { if (hadOwn) docH.ensureRelightMaps = ensure0; else delete docH.ensureRelightMaps; }
        check("undo: a flush touches no layer that left the document", seen.every((l) => docH.layers.includes(l)), seen.map((l) => l && l.name));
        const bx = lt().x, bi = lt().intensity;
        slider("Intensity", 150);
        await docH.undoStep();
        check("undo: a slider after that undo takes only itself back", lt().x === bx && lt().intensity === bi, { s: state(), bx, bi });
        nudge();
        docH.flushPendingDebounces();
        await docH.undoStep();
        check("undo: a nudge after that undo takes only itself back", lt().x === bx, { x: lt().x, bx });

        // c (the review of F3): the Intensity slider of the layer list itself, grabbed within a nudge's 300 ms and still
        // held when the nudge's timer pushes its step: the list is not rebuilt under it (that ends the drag without its
        // change, and its "before" stayed behind), so letting go pushes its own step
        const listRange = () => docH.layerList && docH.layerList.querySelector(`.ipc-layer[data-layer="${CSS.escape(hId)}"] .ipc-relight-controls input[type='range'][title='Intensity']`);
        s0 = state(); n0 = docH.undo.length;
        nudge();
        const lr = listRange();
        if (lr) { lr.value = "140"; lr.dispatchEvent(new Event("input")); }
        await sleep(350);   // the nudge's timer: its step, and (at 4192a6a + F3) a rebuild of the list
        const lrHeld = !!lr && lr.isConnected;
        if (lr) lr.dispatchEvent(new Event("change"));
        const cLabels = steps(n0);
        check("undo: a list slider held across the nudge's timer stays in the list", lrHeld, { found: !!lr });
        check("undo: letting it go pushes its own step after the nudge's", cLabels.length === 2 && cLabels[0] === "Move light" && cLabels[1] === "Relight: Intensity"
            && !cur()._undoPending, { cLabels, pending: !!cur()._undoPending });
        await docH.undoStep();
        check("undo: its undo keeps the nudge", lt().x === s0.x + 1 && lt().intensity === s0.i, { s: state(), s0 });
        await docH.undoStep();
        // d: a slider the list was rebuilt under (no change ever comes) leaves its "before" behind; an undo does not put
        // that back over the edits made since (the redo then lost them, nudges and the slider's own value)
        s0 = state();
        const dr = listRange();
        if (dr) { dr.value = "135"; dr.dispatchEvent(new Event("input")); }
        docH.renderLayers();   // what an agent's command or a flush did to the list mid-drag
        for (let i = 0; i < 5; i++) nudge();
        docH.flushPendingDebounces();
        const dMid = state();
        await docH.undoStep();
        await docH.redoStep();
        const dRedo = state();
        check("undo: an undo and a redo after a slider cut off keep the edits made since", !!dr && dMid.x === s0.x + 5 && dMid.i === 135
            && dRedo.x === s0.x + 5 && dRedo.i === 135, { s0, dMid, dRedo });
        await docH.undoStep();
        // e: a nudge's flush whose layer an undo replaced pushes nothing and renders nothing for it (defence in depth: no
        // record carries a flush since LAYER_PENDING_KEYS, so this calls the kept closure by hand)
        const eX = lt().x, eI = lt().intensity;
        nudge();
        const fKept = cur()._flushNudge, eLayer = cur();
        clearTimeout(cur()._nudgeRelightTimer);
        const eStep = docH.snapshot({ kind: "layers" });
        docH.applySnapshot(eStep);   // the same layers as new objects: eLayer leaves the document
        // the record held the nudged light (a nudge's preview is no slider's: the "before" left at d is not taken for it)
        check("undo: a layers record taken while a nudge waits holds the nudged light", lt().x === eX + 1 && lt().intensity === eI, { s: state(), eX, eI });
        const eN = docH.undo.length;
        const eSeen = [];
        const eHad = Object.prototype.hasOwnProperty.call(docH, "ensureRelightMaps"), eEnsure = docH.ensureRelightMaps;
        docH.ensureRelightMaps = function (layer, o) { eSeen.push(layer); return eEnsure.call(this, layer, o); };
        try { if (typeof fKept === "function") fKept(); } finally { if (eHad) docH.ensureRelightMaps = eEnsure; else delete docH.ensureRelightMaps; }
        check("undo: a flush of a layer that left the document pushes and maps nothing", typeof fKept === "function" && !docH.layers.includes(eLayer)
            && docH.undo.length === eN && eSeen.length === 0, { kept: typeof fKept, gone: !docH.layers.includes(eLayer), undo: docH.undo.length, eN, seen: eSeen.length });
        await commands.run("close_document", { doc: docH.id, force: true });
    }

    // -------------------------------------------------------------------------
    // Case cl (docs/PLAN_RELIGHT_FIXES.md F3.3): close() closes the tip popover (its window listener and preview slices
    // went on with a closed editor since 77da63f) and drops a relight nudge still in its 300 ms whole: its snapshot (the
    // layer's next edit took it as its own "before"), its flush and its preview.
    // -------------------------------------------------------------------------
    {
        const docC = shell.newDocument();
        shell.activate(docC);
        await new Promise((r) => setTimeout(r, 150));
        docC.resizeCanvas();
        await docC.setBaseFromCanvas(fBall(0.5), { keepLayers: false });
        await settle(docC);
        await docC.setMap("depth", makeMap("depth", fM, fM, fDepth, [fS, 0, 0, fS, 0, 0]));
        const cFx = docC.addFilterLayer("relight");
        cFx.params.lights = [{ ...defaultLight(0, { width: fS, height: fS }), x: 90, y: 100 }];
        docC.markFilterChanged(cFx);
        docC.selectLayers([cFx.id]);
        docC.setTool("lights");
        cFx._selectedLightId = cFx.params.lights[0].id;
        await settle(docC);
        const pk = docC.openTipPicker();
        check("cl: the tip popover is open", !!pk && pk.isOpen);
        const x0 = cFx.params.lights[0].x, n0 = docC.undo.length;
        const cNudge = () => docC.onKey({ key: "ArrowRight", shiftKey: false, preventDefault: () => {} });
        cNudge();
        check("cl: a nudge is pending", typeof cFx._flushNudge === "function" && !!(cFx._nudgePending || cFx._undoPending)
            && docC.filterPreview === cFx.id && cFx.params.lights[0].x === x0 + 1);
        docC.close();
        check("cl: close() closes the tip popover and lets go of its window listener", !pk.isOpen && !pk._outside, { open: pk.isOpen });
        check("cl: close() drops the pending nudge (no snapshot, no flush, no preview left)",
            !cFx._nudgePending && !cFx._undoPending && !cFx._flushNudge && docC.filterPreview === null,
            { pending: !!(cFx._nudgePending || cFx._undoPending), flush: typeof cFx._flushNudge, preview: docC.filterPreview });
        check("cl: the dropped nudge pushed no step and kept its move", docC.undo.length === n0 && cFx.params.lights[0].x === x0 + 1,
            { undo: docC.undo.length, n0, x: cFx.params.lights[0].x, x0 });
        // the layer's next edit (here a nudge on the closed editor: onKey reads neither isOpen nor the page) is a step of
        // its own: its undo takes back only itself, not the dropped nudge as well
        cNudge();
        docC.flushPendingDebounces();
        check("cl: the next nudge is one step", docC.undo.length === n0 + 1 && cFx.params.lights[0].x === x0 + 2, { undo: docC.undo.length, n0, x: cFx.params.lights[0].x });
        await docC.undoStep();
        check("cl: its undo takes back only the new nudge", cFx.params.lights[0].x === x0 + 1, { x: cFx.params.lights[0].x, x0 });
        await commands.run("close_document", { doc: docC.id, force: true });
    }

    // Keep lights tool active for visual screenshot
    ed.setTool("lights");
    ed.selectLayers([fx.id]);
    ed.draw();
    await settle(ed);

    return { fails, notes, checks: checkCount - fails.length, tiles: !!ed.tileMode };
})
"""


async def run_cdp(cdp, doc_path, mock, scratch_dir=None):
    escaped_path = doc_path.replace("\\", "\\\\")
    expr = f"({JS})('{escaped_path}', '{mock.url}')"
    val = await cdp.eval(expr, timeout=120)
    if not val:
        print("[FAIL] no result from JS evaluate")
        return False
    fails = val.get("fails", [])
    # case u from the mock's side: the render and the second render each sent the picture at 2048 x 512
    sent = [[p.get("dims") for p in (c.get("pictures") or []) if p.get("field") == "image"]
            for c in mock.all_calls() if c.get("method") == "POST" and c.get("path", "").split("?")[0] == "/v1/ai/image-relight"]
    if sent != [[[2048, 512]], [[2048, 512]]]:
        fails.append(f"u: the mock's record of relight requests: {sent} (expected two, each picture 2048 x 512)")
    for f in fails:
        print(f"[FAIL] {f}")
    if val.get("notes"):
        print(f"[info] measured: {json.dumps(val['notes'])}")
    if not fails:
        backend = "tiles" if val.get("tiles") else "canvas"
        print(f"[ok] relight test on {backend}: {val.get('checks', 0)} in-app checks passed")

    out_dir = scratch_dir or os.path.join(ROOT, "scratch")
    os.makedirs(out_dir, exist_ok=True)
    shot_path = os.path.join(out_dir, "shot_l1b.png")
    shot_l2 = os.path.join(out_dir, "shot_l2.png")
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
    if os.environ.get("RELIGHT_GATE_SKIP_NODE") == "1":
        # a mutation round of the in-app checks alone: a mutated module fails the node tests first and hides them
        print("[skip] relight node tests (RELIGHT_GATE_SKIP_NODE=1)")
    else:
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
        ok = asyncio.run(session(lambda c: run_cdp(c, doc_path, mock, scratch_dir)))
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
