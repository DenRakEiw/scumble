"""Colour grading filter gate (PLAN_NIK9_BUILD.md R3-S2).

Tests the colour grading filter layer (color_grade) across CPU and WebGL2:
  1. GPU against CPU: GL.compareFilterPaths for 5 parameter sets, max <= 2;
     color_balance recorded as baseline in the same step.
  2. Expected pixels on a 640x400 grey 128:
     - mid_hue: 0, mid_sat: 100 -> (191, 101, 101) +- 1 on both paths
     - hi_sat: 100 alone leaves 128 exactly on both paths
     - glob_lum: 36 -> 151 +- 1 on both paths
  3. Commands:
     - add_filter { type: "color_grade", params: { mid_sat: 40, mid_hue: 200 } }
       then list_layers shows presence and params
     - set_filter { params: { nope: 1 } } error message names the 14 valid keys
     - filter_types lists color_grade with 14 parameters
  4. Document round trip: save_document to scratch path, open_document preserves all 14 parameters.

Runs tools/grade_test.js under plain Node first, then connects to running app via CDP.
"""
import asyncio
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

JS = r"""
(async () => {
    const shell = await import("./shell.js");
    const { commands } = await import("./commands.js");
    const F = await import("./editor/inpaint_filters.js");
    const GL = await import("./editor/inpaint_filters_gl.js");
    const { host } = await import("./editor/host.js");

    const fails = [];
    const check = (name, ok, info) => {
        if (!ok) fails.push(name + (info !== undefined ? ": " + JSON.stringify(info).slice(0, 400) : ""));
    };
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const px = (cv, x, y) => Array.from(cv.getContext("2d", { willReadFrequently: true }).getImageData(x, y, 1, 1).data);

    const out = {};

    // -------------------------------------------------------------------------
    // 1. GPU against CPU parity (PLAN section 3.4 item 1)
    // -------------------------------------------------------------------------
    const src = mk(360, 240);
    {
        const ctx = src.getContext("2d");
        const grad = ctx.createLinearGradient(0, 0, 360, 240);
        grad.addColorStop(0, "#0a1428");
        grad.addColorStop(0.5, "#808080");
        grad.addColorStop(1, "#f2f6fa");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 360, 240);
        for (let i = 0; i < 8; i++) {
            ctx.fillStyle = `hsl(${i * 45}, 65%, 50%)`;
            ctx.fillRect(15 + i * 42, 160, 34, 60);
        }
    }

    // Baseline: color_balance
    const cbBaseline = GL.compareFilterPaths(
        (s, p, i) => F.FILTERS.color_balance.apply(s, p, i),
        "color_balance",
        src,
        { shadows_cr: 25, mid_mg: -20, high_yb: 30, preserve: false },
        {}
    );
    out.color_balance_baseline = cbBaseline;
    check("1. color_balance baseline GL available", cbBaseline.gl === true, cbBaseline);
    check("1. color_balance baseline max <= 2", cbBaseline.max <= 2, cbBaseline);

    // 5 parameter sets for color_grade
    const gradeSets = [
        // 1. Shadows only
        { sh_hue: 220, sh_sat: 80, sh_lum: 15 },
        // 2. Midtones only
        { mid_hue: 45, mid_sat: 70, mid_lum: -10, blending: 60 },
        // 3. Highlights only
        { hi_hue: 180, hi_sat: 90, hi_lum: 20, balance: 20 },
        // 4. Global only
        { glob_hue: 300, glob_sat: 50, glob_lum: 10 },
        // 5. Combined with non-default balance and blending
        {
            sh_hue: 200, sh_sat: 40, sh_lum: -10,
            mid_hue: 30, mid_sat: 50, mid_lum: 5,
            hi_hue: 60, hi_sat: 30, hi_lum: 15,
            glob_hue: 120, glob_sat: 20, glob_lum: -5,
            balance: -15, blending: 70
        }
    ];

    out.color_grade_gl_vs_cpu = [];
    for (let idx = 0; idx < gradeSets.length; idx++) {
        const p = gradeSets[idx];
        const r = GL.compareFilterPaths(
            (s, p, i) => F.FILTERS.color_grade.apply(s, p, i),
            "color_grade",
            src,
            p,
            {}
        );
        out.color_grade_gl_vs_cpu.push(r);
        check(`1. color_grade set ${idx + 1} GL available`, r.gl === true, r);
        check(`1. color_grade set ${idx + 1} max <= 2`, r.max <= 2, r);
    }

    // -------------------------------------------------------------------------
    // 1b. HSL: GPU against CPU parity (PLAN R3-S4)
    // -------------------------------------------------------------------------
    const hslSets = [
        { red_h: 50, red_s: -30, red_l: 20 },
        { aqua_h: -40, aqua_s: 60, blue_h: 30, blue_s: -80, purple_l: -30 },
        { orange_s: 50, yellow_h: -20, yellow_l: 30, green_h: 40, green_s: -50 },
        { red_s: -100, orange_s: -100, yellow_s: -100, green_s: -100, aqua_s: -100, blue_s: -100, purple_s: -100, magenta_s: -100 },
        { red_l: 50, green_l: -50, blue_l: 40, yellow_l: -30 },
        { red_h: 40, blue_s: -60, green_l: 30, yellow_s: 40, purple_h: -30, magenta_l: 20 }
    ];

    out.hsl_gl_vs_cpu = [];
    for (let idx = 0; idx < hslSets.length; idx++) {
        const p = hslSets[idx];
        const r = GL.compareFilterPaths(
            (s, p, i) => F.FILTERS.hsl.apply(s, p, i),
            "hsl",
            src,
            p,
            {}
        );
        out.hsl_gl_vs_cpu.push(r);
        check(`1b. hsl set ${idx + 1} GL available`, r.gl === true, r);
        check(`1b. hsl set ${idx + 1} max <= 2`, r.max <= 2, r);
        check(`1b. hsl set ${idx + 1} over2 == 0`, r.over2 === 0, r);
    }

    // Identity returns exact input bytes
    const hslId = GL.compareFilterPaths(
        (s, p, i) => F.FILTERS.hsl.apply(s, p, i),
        "hsl",
        src,
        {},
        {}
    );
    check("1b. hsl identity max === 0", hslId.max === 0, hslId);

    // -------------------------------------------------------------------------
    // 2. Expected pixel values on 640x400 grey 128 (PLAN section 3.4 item 2)
    // -------------------------------------------------------------------------
    const greyCanvas = mk(640, 400);
    {
        const gctx = greyCanvas.getContext("2d");
        gctx.fillStyle = "rgb(128, 128, 128)";
        gctx.fillRect(0, 0, 640, 400);
    }

    // 2a: mid_hue: 0, mid_sat: 100 gives (191, 101, 101) +- 1 on both paths
    {
        const pA = { mid_hue: 0, mid_sat: 100 };
        const cpuA = F.FILTERS.color_grade.apply(greyCanvas, pA, {});
        const glA = GL.glToCanvas(GL.applyFilterGL("color_grade", greyCanvas, pA, {}));
        const pxCpu = px(cpuA, 320, 200);
        const pxGl = glA ? px(glA, 320, 200) : null;
        out.case2a_cpu = pxCpu;
        out.case2a_gl = pxGl;
        check("2a. CPU mid_hue: 0 mid_sat: 100 gives (191, 101, 101) +- 1",
            Math.abs(pxCpu[0] - 191) <= 1 && Math.abs(pxCpu[1] - 101) <= 1 && Math.abs(pxCpu[2] - 101) <= 1,
            pxCpu
        );
        check("2a. GL mid_hue: 0 mid_sat: 100 gives (191, 101, 101) +- 1",
            pxGl && Math.abs(pxGl[0] - 191) <= 1 && Math.abs(pxGl[1] - 101) <= 1 && Math.abs(pxGl[2] - 101) <= 1,
            pxGl
        );
    }

    // 2b: hi_sat: 100 alone leaves 128 exactly on both paths
    {
        const pB = { hi_sat: 100 };
        const cpuB = F.FILTERS.color_grade.apply(greyCanvas, pB, {});
        const glB = GL.glToCanvas(GL.applyFilterGL("color_grade", greyCanvas, pB, {}));
        const pxCpu = px(cpuB, 320, 200);
        const pxGl = glB ? px(glB, 320, 200) : null;
        out.case2b_cpu = pxCpu;
        out.case2b_gl = pxGl;
        check("2b. CPU hi_sat: 100 alone leaves 128 exactly",
            pxCpu[0] === 128 && pxCpu[1] === 128 && pxCpu[2] === 128,
            pxCpu
        );
        check("2b. GL hi_sat: 100 alone leaves 128 exactly",
            pxGl && pxGl[0] === 128 && pxGl[1] === 128 && pxGl[2] === 128,
            pxGl
        );
    }

    // 2c: glob_lum: 36 gives 151 +- 1 on both paths
    {
        const pC = { glob_lum: 36 };
        const cpuC = F.FILTERS.color_grade.apply(greyCanvas, pC, {});
        const glC = GL.glToCanvas(GL.applyFilterGL("color_grade", greyCanvas, pC, {}));
        const pxCpu = px(cpuC, 320, 200);
        const pxGl = glC ? px(glC, 320, 200) : null;
        out.case2c_cpu = pxCpu;
        out.case2c_gl = pxGl;
        check("2c. CPU glob_lum: 36 gives 151 +- 1",
            Math.abs(pxCpu[0] - 151) <= 1 && Math.abs(pxCpu[1] - 151) <= 1 && Math.abs(pxCpu[2] - 151) <= 1,
            pxCpu
        );
        check("2c. GL glob_lum: 36 gives 151 +- 1",
            pxGl && Math.abs(pxGl[0] - 151) <= 1 && Math.abs(pxGl[1] - 151) <= 1 && Math.abs(pxGl[2] - 151) <= 1,
            pxGl
        );
    }

    // 2d: picture with sky-blue half and red half (PLAN R3-S4)
    {
        const halfCanvas = mk(200, 100);
        const hctx = halfCanvas.getContext("2d");
        // Left half: sky blue (hue 240, 80% sat, 75% lightness)
        hctx.fillStyle = "hsl(240, 80%, 75%)";
        hctx.fillRect(0, 0, 100, 100);
        // Right half: red (hue 0, 80% sat, 50% lightness)
        hctx.fillStyle = "hsl(0, 80%, 50%)";
        hctx.fillRect(100, 0, 100, 100);

        const redBefore = px(halfCanvas, 150, 50);
        const filtered = GL.glToCanvas(GL.applyFilterGL("hsl", halfCanvas, { blue_s: -100 }, {}));
        const skyPx = filtered ? px(filtered, 50, 50) : [0, 0, 0];
        const redAfter = filtered ? px(filtered, 150, 50) : [0, 0, 0];
        const skyChroma = Math.max(skyPx[0], skyPx[1], skyPx[2]) - Math.min(skyPx[0], skyPx[1], skyPx[2]);
        const redDiff = Math.max(
            Math.abs(redBefore[0] - redAfter[0]),
            Math.abs(redBefore[1] - redAfter[1]),
            Math.abs(redBefore[2] - redAfter[2])
        );
        out.case2d_sky_chroma = skyChroma;
        out.case2d_red_diff = redDiff;
        check("2d. blue_s: -100 brings sky chroma < 3", skyChroma < 3, { skyPx, skyChroma });
        check("2d. blue_s: -100 leaves red half within 1 level", redDiff <= 1, { redBefore, redAfter, redDiff });
    }


    // -------------------------------------------------------------------------
    // 3. Command surface (PLAN section 3.4 item 3)
    // -------------------------------------------------------------------------
    const ed = shell.newDocument();
    shell.activate(ed);
    await new Promise((r) => setTimeout(r, 200));
    ed.resizeCanvas();
    const baseCanvas = mk(640, 400);
    baseCanvas.getContext("2d").fillStyle = "#808080";
    baseCanvas.getContext("2d").fillRect(0, 0, 640, 400);
    await ed.setBaseFromCanvas(baseCanvas, { keepLayers: false });

    // 3a. add_filter { type: "color_grade", params: { mid_sat: 40, mid_hue: 200 } }
    const added = await commands.run("add_filter", {
        type: "color_grade",
        params: { mid_sat: 40, mid_hue: 200 },
        doc: ed.node.id
    });
    const layersRes = await commands.run("list_layers", { doc: ed.node.id });
    const layersList = layersRes.layers || layersRes;
    const filterLayer = layersList.find((l) => l.id === added.id);
    check("3a. add_filter created color_grade layer", !!filterLayer && filterLayer.kind === "filter" && filterLayer.filter === "color_grade", filterLayer);
    check("3a. list_layers shows mid_sat = 40 and mid_hue = 200", filterLayer && filterLayer.params && filterLayer.params.mid_sat === 40 && filterLayer.params.mid_hue === 200, filterLayer?.params);

    // 3b. set_filter { params: { nope: 1 } } error message names the valid keys
    let setFilterError = null;
    try {
        await commands.run("set_filter", {
            layer: added.id,
            params: { nope: 1 },
            doc: ed.node.id
        });
    } catch (e) {
        setFilterError = String((e && e.message) || e);
    }
    check("3b. set_filter with unknown param throws", !!setFilterError, setFilterError);
    const valid14Keys = [
        "sh_hue", "sh_sat", "sh_lum",
        "mid_hue", "mid_sat", "mid_lum",
        "hi_hue", "hi_sat", "hi_lum",
        "glob_hue", "glob_sat", "glob_lum",
        "balance", "blending"
    ];
    const missingInError = valid14Keys.filter((k) => !setFilterError || !setFilterError.includes(k));
    check("3b. set_filter error names all 14 keys", missingInError.length === 0, { missing: missingInError, error: setFilterError });

    // 3c. filter_types lists color_grade with 15 parameters (wheels custom + 14 keys)
    const ftypesRes = await commands.run("filter_types", {});
    const ftypesList = Array.isArray(ftypesRes) ? ftypesRes : (ftypesRes.types || ftypesRes.filters || []);
    const gradeType = ftypesList.find((t) => t.id === "color_grade");
    check("3c. filter_types includes color_grade", !!gradeType, ftypesList.map((t) => t.id));
    check("3c. filter_types color_grade has 15 parameters", gradeType && gradeType.params && gradeType.params.length === 15, gradeType?.params?.length);
    const reportedKeys = (gradeType?.params || []).map((p) => p.key);
    const missingParamKeys = ["wheels", ...valid14Keys].filter((k) => !reportedKeys.includes(k));
    check("3c. filter_types parameters match all 15 keys exactly", missingParamKeys.length === 0 && reportedKeys.length === 15, { reportedKeys, missingParamKeys });
    check("3c. filter_types wheels is custom", gradeType?.params?.find((p) => p.key === "wheels")?.type === "custom");
    const hidden12 = ["sh_hue", "sh_sat", "sh_lum", "mid_hue", "mid_sat", "mid_lum", "hi_hue", "hi_sat", "hi_lum", "glob_hue", "glob_sat", "glob_lum"];
    const allHiddenMarked = hidden12.every((k) => gradeType?.params?.find((p) => p.key === k)?.hidden === true);
    check("3c. 12 wheel parameters are marked hidden: true", allHiddenMarked);

    // -------------------------------------------------------------------------
    // 3d. R3-S3 Wheel control in DOM and interactions (PLAN section 3.4)
    // -------------------------------------------------------------------------
    ed.activeLayerId = added.id;
    ed.renderLayers();
    const layerRow = ed.layerList.querySelector(`[data-layer="${added.id}"]`);
    check("3d. layerRow found in DOM", !!layerRow, { addedId: added.id });

    const fxBox = layerRow ? layerRow.querySelector(".ipc-fx") : null;
    check("3d. fxBox found in layer row", !!fxBox);

    const wheelCanvases = fxBox ? fxBox.querySelectorAll(".ipc-wheels canvas") : [];
    check("3d. exactly 4 .ipc-wheels canvas", wheelCanvases.length === 4, wheelCanvases.length);

    const rangeInputs = fxBox ? fxBox.querySelectorAll("input[type=range]") : [];
    check("3d. exactly 6 input[type=range] in fx row", rangeInputs.length === 6, rangeInputs.length);

    const wheelsRangeInputs = fxBox ? fxBox.querySelectorAll(".ipc-wheels input[type=range]") : [];
    check("3d. exactly 4 brightness sliders in wheels", wheelsRangeInputs.length === 4, wheelsRangeInputs.length);

    // Check no standard slider rows for the 12 hidden keys
    const nonWheelsRangeInputs = fxBox ? Array.from(rangeInputs).filter((r) => !r.closest(".ipc-wheels")) : [];
    check("3d. exactly 2 non-wheels sliders (balance and blending)", nonWheelsRangeInputs.length === 2, nonWheelsRangeInputs.length);

    // Midtones canvas interaction
    const midCanvas = fxBox ? fxBox.querySelector('canvas[data-wheel-range="mid"]') : null;
    check("3d. midtones canvas found", !!midCanvas);

    if (midCanvas) {
        const targetLayer = ed.layers.find((l) => l.id === added.id);
        targetLayer.params.mid_sat = 0;
        targetLayer.params.mid_hue = 30;
        ed.renderLayers();

        const curMidCanvas = ed.layerList.querySelector(`[data-layer="${added.id}"] canvas[data-wheel-range="mid"]`);
        const rect = curMidCanvas.getBoundingClientRect();
        const cx = rect.left + (rect.width || 72) / 2;
        const cy = rect.top + (rect.height || 72) / 2;
        const targetY = cy - 16; // R/2 = 32/2 = 16 CSS px upwards (mathematical +y)

        const undoBefore = ed.undo.length;

        // Pointer drag from centre to (0, -R/2)
        curMidCanvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
        curMidCanvas.dispatchEvent(new PointerEvent("pointermove", { clientX: cx, clientY: targetY, bubbles: true, cancelable: true }));
        curMidCanvas.dispatchEvent(new PointerEvent("pointerup", { clientX: cx, clientY: targetY, bubbles: true, cancelable: true }));

        check("3d. mid_hue is 90 +- 1", Math.abs((targetLayer.params.mid_hue ?? 0) - 90) <= 1, targetLayer.params.mid_hue);
        check("3d. mid_sat is 50 +- 1", Math.abs((targetLayer.params.mid_sat ?? 0) - 50) <= 1, targetLayer.params.mid_sat);
        check("3d. undo.length increased by 1", ed.undo.length === undoBefore + 1, { before: undoBefore, after: ed.undo.length });
        const lastUndo = ed.undo[ed.undo.length - 1];
        check("3d. undo step labelled 'Colour grading: Wheels'", lastUndo && lastUndo.label === "Colour grading: Wheels", lastUndo?.label);

        // Calling undo restores sat = 0
        await ed.undoStep();
        check("3d. undo restores mid_sat = 0", targetLayer.params.mid_sat === 0, targetLayer.params.mid_sat);

        // Double-click resets
        targetLayer.params.mid_sat = 50;
        const postUndoCanvas = ed.layerList.querySelector(`[data-layer="${added.id}"] canvas[data-wheel-range="mid"]`) || curMidCanvas;
        postUndoCanvas.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
        check("3d. double-click resets sat to 0", targetLayer.params.mid_sat === 0, targetLayer.params.mid_sat);

        // set_filter with sh_hue: 10 still works
        await commands.run("set_filter", {
            layer: added.id,
            params: { sh_hue: 10 },
            doc: ed.node.id
        });
        check("3d. set_filter { sh_hue: 10 } updates param", targetLayer.params.sh_hue === 10, targetLayer.params.sh_hue);
    }

    // -------------------------------------------------------------------------
    // 3e. HSL: command surface (PLAN R3-S4)
    // -------------------------------------------------------------------------
    const addedHsl = await commands.run("add_filter", {
        type: "hsl",
        params: { red_h: 40, blue_s: -60 },
        doc: ed.node.id
    });
    const layersRes2 = await commands.run("list_layers", { doc: ed.node.id });
    const layersList2 = layersRes2.layers || layersRes2;
    const hslLayer = layersList2.find((l) => l.id === addedHsl.id);
    check("3e. add_filter created hsl layer", !!hslLayer && hslLayer.kind === "filter" && hslLayer.filter === "hsl", hslLayer);
    check("3e. list_layers shows red_h = 40 and blue_s = -60", hslLayer && hslLayer.params && hslLayer.params.red_h === 40 && hslLayer.params.blue_s === -60, hslLayer?.params);

    // 3f. filter_types lists hsl with 25 parameters (channels custom + 24 hidden)
    const hslType = ftypesList.find((t) => t.id === "hsl");
    check("3f. filter_types includes hsl", !!hslType, ftypesList.map((t) => t.id));
    check("3f. filter_types hsl has 25 parameters", hslType && hslType.params && hslType.params.length === 25, hslType?.params?.length);
    const hslParams = hslType?.params || [];
    check("3f. filter_types channels is custom", hslParams.find((p) => p.key === "channels")?.type === "custom");
    const hidden24 = hslParams.filter((p) => p.key !== "channels");
    check("3f. exactly 24 hidden parameters in hsl", hidden24.length === 24 && hidden24.every((p) => p.hidden === true));

    // 3g. HSL control in DOM and interactions (PLAN R3-S4)
    ed.activeLayerId = addedHsl.id;
    ed.renderLayers();
    const hslLayerRow = ed.layerList.querySelector(`[data-layer="${addedHsl.id}"]`);
    check("3g. hslLayerRow found in DOM", !!hslLayerRow, { addedHslId: addedHsl.id });

    const hslFxBox = hslLayerRow ? hslLayerRow.querySelector(".ipc-fx") : null;
    check("3g. fxBox found in HSL layer row", !!hslFxBox);

    const hslControl = hslFxBox ? hslFxBox.querySelector(".ipc-hsl") : null;
    check("3g. .ipc-hsl found in fxBox", !!hslControl);

    const modeButtons = hslControl ? hslControl.querySelectorAll(".ipc-hsl-head button") : [];
    check("3g. 4 buttons in head (3 mode buttons + Reset)", modeButtons.length === 4, modeButtons.length);

    const hslSliders = hslControl ? hslControl.querySelectorAll("input[type=range]") : [];
    check("3g. exactly 8 input[type=range] in HSL control", hslSliders.length === 8, hslSliders.length);

    // Red channel slider interaction (first row)
    const redSlider = hslSliders[0];
    check("3g. red channel slider found", !!redSlider);
    if (redSlider) {
        const targetHslLayer = ed.layers.find((l) => l.id === addedHsl.id);
        const undoBefore = ed.undo.length;
        redSlider.value = "35";
        redSlider.dispatchEvent(new Event("input", { bubbles: true }));
        redSlider.dispatchEvent(new Event("change", { bubbles: true }));

        check("3g. red_h updated to 35", targetHslLayer.params.red_h === 35, targetHslLayer.params.red_h);
        check("3g. undo step pushed", ed.undo.length === undoBefore + 1);
        const lastUndo = ed.undo[ed.undo.length - 1];
        check("3g. undo step labelled 'HSL: Red Hue'", lastUndo && lastUndo.label === "HSL: Red Hue", lastUndo?.label);

        // Click Reset button (non-shift: resets current mode Hue)
        const resetBtn = Array.from(modeButtons).find((b) => b.textContent === "Reset");
        check("3g. reset button found", !!resetBtn);
        if (resetBtn) {
            resetBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: false }));
            check("3g. reset clears red_h to 0", targetHslLayer.params.red_h === 0, targetHslLayer.params.red_h);
            check("3g. reset preserves blue_s = -60", targetHslLayer.params.blue_s === -60, targetHslLayer.params.blue_s);
        }
    }

    // -------------------------------------------------------------------------
    // 4. Document round trip (PLAN section 3.4 item 4)
    // -------------------------------------------------------------------------
    const full14Params = {
        sh_hue: 215, sh_sat: 45, sh_lum: -12,
        mid_hue: 35, mid_sat: 55, mid_lum: 14,
        hi_hue: 50, hi_sat: 65, hi_lum: -25,
        glob_hue: 140, glob_sat: 30, glob_lum: 18,
        balance: -20, blending: 75
    };
    await commands.run("set_filter", {
        layer: added.id,
        params: full14Params,
        doc: ed.node.id
    });

    const fullHslParams = {
        red_h: 25, red_s: -35, red_l: 15,
        orange_h: -15, orange_s: 40, orange_l: -10,
        yellow_h: 10, yellow_s: -20, yellow_l: 30,
        green_h: -30, green_s: 50, green_l: -25,
        aqua_h: 20, aqua_s: -40, aqua_l: 15,
        blue_h: -45, blue_s: 60, blue_l: -35,
        purple_h: 30, purple_s: -50, purple_l: 20,
        magenta_h: -25, magenta_s: 45, magenta_l: -15
    };
    await commands.run("set_filter", {
        layer: addedHsl.id,
        params: fullHslParams,
        doc: ed.node.id
    });

    const docPath = window.__gradeDocPath;
    const saveRes = await commands.run("save_document", {
        path: docPath,
        doc: ed.node.id
    });
    check("4. save_document succeeded", !!saveRes && !!saveRes.path, saveRes);

    await commands.run("close_document", { doc: ed.node.id, force: true });

    const openRes = await commands.run("open_document", { path: docPath });
    check("4. open_document succeeded", !!openRes, openRes);

    const openedEd = host.editors().find((e) => e.docFile && e.docFile.path && e.docFile.path.replace(/\\/g, "/") === docPath.replace(/\\/g, "/")) || host.editor;
    const openedLayers = openedEd ? openedEd.layers : [];
    const openedFilter = openedLayers.find((l) => l.kind === "filter" && l.filter === "color_grade");
    check("4. reopened document has color_grade layer", !!openedFilter, openedLayers.map((l) => l.filter || l.kind));

    if (openedFilter && openedFilter.params) {
        for (const [k, v] of Object.entries(full14Params)) {
            check(`4. color_grade param ${k} preserved in document round trip`, openedFilter.params[k] === v, {
                key: k, expected: v, actual: openedFilter.params[k]
            });
        }
    }

    const openedHslFilter = openedLayers.find((l) => l.kind === "filter" && l.filter === "hsl");
    check("4. reopened document has hsl layer", !!openedHslFilter, openedLayers.map((l) => l.filter || l.kind));

    if (openedHslFilter && openedHslFilter.params) {
        for (const [k, v] of Object.entries(fullHslParams)) {
            check(`4. hsl param ${k} preserved in document round trip`, openedHslFilter.params[k] === v, {
                key: k, expected: v, actual: openedHslFilter.params[k]
            });
        }
    }


    if (openedEd) {
        try { await commands.run("close_document", { doc: openedEd.node.id, force: true }); } catch (_) {}
    }

    out.tiles = !!ed.tileMode;
    out.fails = fails;
    return out;
})()
"""


async def run_cdp(c, doc_path):
    # Set document path on window
    norm_path = doc_path.replace("\\", "/")
    await c.eval(f"window.__gradeDocPath = {json.dumps(norm_path)}; 1")
    r = await c.eval(JS, timeout=120)
    fails = r.get("fails", [])
    print(json.dumps({k: v for k, v in r.items() if k != "fails"}))
    for f in fails:
        print("[FAIL]", f)
    if not fails:
        print(f"[ok] grading test on {'tiles' if r.get('tiles') else 'canvas'}")
    return not fails


def node_step():
    r = subprocess.run(
        ["node", os.path.join(HERE, "grade_test.js")],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )
    tail = r.stdout.strip()
    if r.returncode != 0 or "PASS" not in tail:
        raise Exception("tools/grade_test.js: " + (tail + r.stderr)[-1500:])
    return {"checks": tail.count("[ok]")}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        nres = node_step()
        print(f"[ok] grade_test.js: {nres['checks']} checks passed")
    except Exception as err:
        print(f"[FAIL] node: {err}")
        print("FAIL")
        sys.exit(1)

    scratch_dir = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else tempfile.gettempdir()
    os.makedirs(scratch_dir, exist_ok=True)
    doc_path = os.path.join(scratch_dir, f"grading_test_{os.getpid()}.scumble")

    try:
        ok = asyncio.run(session(lambda c: run_cdp(c, doc_path)))
        if not ok:
            print("FAIL")
            sys.exit(1)
    except Exception as e:
        if "JS exception" in str(e):
            print(f"[FAIL] {e}")
            print("FAIL")
            sys.exit(1)
        print(f"[FAIL] CDP session error: {e}")
        print("FAIL")
        sys.exit(1)
    finally:
        if os.path.exists(doc_path):
            try:
                os.remove(doc_path)
            except OSError:
                pass

    print("PASS")
    sys.exit(0)


if __name__ == "__main__":
    main()
