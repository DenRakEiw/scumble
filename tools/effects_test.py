"""Effects plugin and chromatic shift filter gate (PLAN_NIK9_BUILD.md R3-S9).

Tests the Effects pack plugin and chromatic shift filter across CPU and WebGL2:
  1. Node pre-step: tools/effects_math_test.js passes all checks.
  2. GPU against CPU parity (gpu_vs_cpu):
     - Plates, Lateral, Linear styles across multiple parameter sets (max <= 2).
  3. amount: 0 returns the input's bytes on both paths (and strength: 0 identity).
  4. Linear angle 0 amount 3 on black with 1px white column at x = 100:
     - Red at x = 97, Green at x = 100, Blue at x = 103, exactly.
  5. Scale 0.5 offsets halve against downscaled full-resolution result (mean <= 2).
  6. Commands and Document round-trip:
     - filter_types lists effects.chromatic_shift with its 4 parameters.
     - add_filter { type: "effects.chromatic_shift" } and action effects.add_chromatic.
     - Save and open .scumble document preserves all parameters.
     - Undo/redo cycle for filter layer.
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
    // 0. Verify plugin registration
    // -------------------------------------------------------------------------
    check("0. chromatic_shift registered in FILTERS", !!F.FILTERS["effects.chromatic_shift"]);
    const filterDef = F.FILTERS["effects.chromatic_shift"];
    check("0. filter reach defined", typeof filterDef.reach === "function");
    if (filterDef && filterDef.reach) {
        check("0. reach > 0 for amount 6", filterDef.reach({ amount: 6, strength: 100 }) === 8);
        check("0. reach 0 for amount 0", filterDef.reach({ amount: 0, strength: 100 }) === 0);
    }

    // -------------------------------------------------------------------------
    // 1. GPU against CPU parity (gpu_vs_cpu for all three styles, max <= 2)
    // -------------------------------------------------------------------------
    const src1 = mk(360, 240);
    {
        const ctx = src1.getContext("2d");
        const grad = ctx.createLinearGradient(0, 0, 360, 240);
        grad.addColorStop(0, "#102040");
        grad.addColorStop(0.5, "#808080");
        grad.addColorStop(1, "#f0f5fa");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 360, 240);
        for (let i = 0; i < 8; i++) {
            ctx.fillStyle = `hsl(${i * 45}, 70%, 50%)`;
            ctx.fillRect(15 + i * 42, 140, 34, 80);
        }
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(180, 80, 40, 0, Math.PI * 2);
        ctx.fill();
    }

    const testSets = [
        { name: "plates_default", params: { style: "plates", amount: 6, angle: 30, strength: 100 } },
        { name: "plates_large", params: { style: "plates", amount: 15, angle: -45, strength: 80 } },
        { name: "lateral_default", params: { style: "lateral", amount: 8, strength: 100 } },
        { name: "lateral_scaled", params: { style: "lateral", amount: 14, strength: 75 } },
        { name: "linear_angle60", params: { style: "linear", amount: 10, angle: 60, strength: 100 } },
        { name: "linear_angle_minus30", params: { style: "linear", amount: 12, angle: -30, strength: 85 } },
    ];

    out.gpu_vs_cpu = {};
    for (const ts of testSets) {
        const info = { scale: 1, full: [360, 240], origin: [0, 0], cache: {} };
        const cpuCanvas = F.applyFilter("effects.chromatic_shift", src1, ts.params, { ...info, cpu: true });
        const gpuRaw = F.applyFilter("effects.chromatic_shift", src1, ts.params, { ...info, cpu: false });
        const gpuCanvas = GL.glToCanvas(gpuRaw);

        const cpuData = cpuCanvas.getContext("2d").getImageData(0, 0, 360, 240).data;
        const gpuData = gpuCanvas.getContext("2d").getImageData(0, 0, 360, 240).data;

        let maxDiff = 0, sumDiff = 0, count = 0, over2 = 0;
        for (let i = 0; i < cpuData.length; i++) {
            if ((i & 3) === 3) continue; // skip alpha
            const d = Math.abs(cpuData[i] - gpuData[i]);
            if (d > maxDiff) maxDiff = d;
            if (d > 2) over2++;
            sumDiff += d;
            count++;
        }
        const meanDiff = +(sumDiff / count).toFixed(4);
        out.gpu_vs_cpu[ts.name] = { max: maxDiff, mean: meanDiff, over2 };
        check(`1. gpu_vs_cpu ${ts.name} max <= 2`, maxDiff <= 2, { maxDiff, meanDiff, over2 });
    }

    // -------------------------------------------------------------------------
    // 2. amount: 0 returns the input's bytes on both paths
    // -------------------------------------------------------------------------
    {
        const srcOrig = src1.getContext("2d").getImageData(0, 0, 360, 240).data;
        for (const [mode, p] of [["amount_0", { amount: 0, strength: 100 }], ["strength_0", { amount: 10, strength: 0 }]]) {
            const cpuZero = F.applyFilter("effects.chromatic_shift", src1, p, { cpu: true });
            const gpuZeroRaw = F.applyFilter("effects.chromatic_shift", src1, p, { cpu: false });
            const gpuZero = GL.glToCanvas(gpuZeroRaw);

            const cData = cpuZero.getContext("2d").getImageData(0, 0, 360, 240).data;
            const gData = gpuZero.getContext("2d").getImageData(0, 0, 360, 240).data;

            let cDiff = 0, gDiff = 0;
            for (let i = 0; i < srcOrig.length; i++) {
                if (Math.abs(srcOrig[i] - cData[i]) > cDiff) cDiff = Math.abs(srcOrig[i] - cData[i]);
                if (Math.abs(srcOrig[i] - gData[i]) > gDiff) gDiff = Math.abs(srcOrig[i] - gData[i]);
            }
            check(`2. ${mode} CPU bitwise identity`, cDiff === 0, { cDiff });
            check(`2. ${mode} GPU bitwise identity`, gDiff === 0, { gDiff });
        }
    }

    // -------------------------------------------------------------------------
    // 3. Linear angle 0 amount 3 on black with 1px white column at x = 100
    // -------------------------------------------------------------------------
    {
        const W3 = 200, H3 = 40;
        const cv3 = mk(W3, H3);
        const ctx3 = cv3.getContext("2d");
        ctx3.fillStyle = "#000000";
        ctx3.fillRect(0, 0, W3, H3);
        ctx3.fillStyle = "#ffffff";
        ctx3.fillRect(100, 0, 1, H3);

        const params3 = { style: "linear", angle: 0, amount: 3, strength: 100 };
        const cpu3 = F.applyFilter("effects.chromatic_shift", cv3, params3, { cpu: true, scale: 1 });
        const gpu3Raw = F.applyFilter("effects.chromatic_shift", cv3, params3, { cpu: false, scale: 1 });
        const gpu3 = GL.glToCanvas(gpu3Raw);

        for (const [name, cv] of [["CPU", cpu3], ["GPU", gpu3]]) {
            const data3 = cv.getContext("2d").getImageData(0, 0, W3, H3).data;
            // Sample line at y = 20
            const ySample = 20;
            const getPix = (x) => {
                const idx = (ySample * W3 + x) * 4;
                return [data3[idx], data3[idx + 1], data3[idx + 2], data3[idx + 3]];
            };

            const p97 = getPix(97);
            const p100 = getPix(100);
            const p103 = getPix(103);
            const p96 = getPix(96);
            const p104 = getPix(104);

            check(`3. ${name} red at x=97`, p97[0] === 255 && p97[1] === 0 && p97[2] === 0, { p97 });
            check(`3. ${name} green at x=100`, p100[0] === 0 && p100[1] === 255 && p100[2] === 0, { p100 });
            check(`3. ${name} blue at x=103`, p103[0] === 0 && p103[1] === 0 && p103[2] === 255, { p103 });
            check(`3. ${name} black at x=96`, p96[0] === 0 && p96[1] === 0 && p96[2] === 0, { p96 });
            check(`3. ${name} black at x=104`, p104[0] === 0 && p104[1] === 0 && p104[2] === 0, { p104 });
        }
    }

    // -------------------------------------------------------------------------
    // 4. Scale 0.5 offsets halve against downscaled full-resolution result
    // -------------------------------------------------------------------------
    {
        const W4 = 400, H4 = 300;
        const cv4 = mk(W4, H4);
        const ctx4 = cv4.getContext("2d");
        const g4 = ctx4.createRadialGradient(200, 150, 20, 200, 150, 180);
        g4.addColorStop(0, "#ffeedd");
        g4.addColorStop(0.5, "#4488aa");
        g4.addColorStop(1, "#112233");
        ctx4.fillStyle = g4;
        ctx4.fillRect(0, 0, W4, H4);

        // Full resolution shift at amount 10
        const fullShift = F.applyFilter("effects.chromatic_shift", cv4, { style: "plates", amount: 10, angle: 30, strength: 100 }, { scale: 1 });
        const fullShiftCanvas = GL.glToCanvas(fullShift);

        // Downscale full-resolution result to 200x150
        const downOfFull = mk(200, 150);
        const dfCtx = downOfFull.getContext("2d");
        dfCtx.drawImage(fullShiftCanvas, 0, 0, 200, 150);
        const dfData = dfCtx.getImageData(0, 0, 200, 150).data;

        // Downscale input to 200x150 first
        const downInput = mk(200, 150);
        downInput.getContext("2d").drawImage(cv4, 0, 0, 200, 150);

        // Run chromatic shift at scale 0.5 on downscaled input
        const halfShift = F.applyFilter("effects.chromatic_shift", downInput, { style: "plates", amount: 10, angle: 30, strength: 100 }, { scale: 0.5 });
        const halfShiftCanvas = GL.glToCanvas(halfShift);
        const hsData = halfShiftCanvas.getContext("2d").getImageData(0, 0, 200, 150).data;

        // Compute mean difference (ignoring 4px boundary due to reach)
        let sumDiff = 0, count = 0;
        for (let y = 6; y < 144; y++) {
            for (let x = 6; x < 194; x++) {
                const idx = (y * 200 + x) * 4;
                sumDiff += Math.abs(dfData[idx] - hsData[idx]);
                sumDiff += Math.abs(dfData[idx + 1] - hsData[idx + 1]);
                sumDiff += Math.abs(dfData[idx + 2] - hsData[idx + 2]);
                count += 3;
            }
        }
        const meanDiff = +(sumDiff / count).toFixed(4);
        out.scale_half = { mean: meanDiff };
        check("4. scale 0.5 offsets halve against downscaled full-res mean <= 2", meanDiff <= 2.0, { meanDiff });
    }

    // -------------------------------------------------------------------------
    // 5. Commands and Document round-trip
    // -------------------------------------------------------------------------
    const typesRes = await commands.run("filter_types");
    const filtersList = (typesRes && typesRes.filters) || typesRes;
    const chromType = filtersList.find((t) => t.id === "effects.chromatic_shift");
    check("5. filter_types lists effects.chromatic_shift", !!chromType, filtersList.map((t) => t.id));
    if (chromType) {
        check("5. filter_types params count is 4", chromType.params && chromType.params.length === 4, chromType.params);
        check("5. style param exists", chromType.params.some((p) => p.key === "style"));
        check("5. amount param exists", chromType.params.some((p) => p.key === "amount"));
        check("5. angle param exists", chromType.params.some((p) => p.key === "angle"));
        check("5. strength param exists", chromType.params.some((p) => p.key === "strength"));
    }

    // Document test
    const d = await commands.run("new_document");
    const ed = host.editors().find((e) => e.node.id === d.id);
    shell.activate(ed);
    await commands.run("new_canvas", { width: 300, height: 200, doc: d.id });

    // Add filter via command
    const addRes = await commands.run("add_filter", {
        type: "effects.chromatic_shift",
        params: { style: "lateral", amount: 14, angle: 45, strength: 85 },
        doc: d.id,
    });
    check("5. add_filter returned layer id", !!addRes && !!(addRes.id || addRes.layer));
    const addedId = addRes.id || addRes.layer;

    let layerRes = await commands.run("list_layers", { doc: d.id });
    let layers = (layerRes && layerRes.layers) || layerRes;
    const layer = layers.find((l) => l.id === addedId);
    check("5. layer present in list_layers", !!layer);
    check("5. layer is filter", layer && layer.kind === "filter");
    check("5. layer filter is effects.chromatic_shift", layer && layer.filter === "effects.chromatic_shift");
    check("5. layer params style is lateral", layer && layer.params && layer.params.style === "lateral");
    check("5. layer params amount is 14", layer && layer.params && layer.params.amount === 14);
    check("5. layer params angle is 45", layer && layer.params && layer.params.angle === 45);
    check("5. layer params strength is 85", layer && layer.params && layer.params.strength === 85);

    // Test set_filter and undo / redo
    await commands.run("set_filter", {
        doc: d.id,
        layer: addedId,
        params: { amount: 20 },
    });
    layerRes = await commands.run("list_layers", { doc: d.id });
    layers = (layerRes && layerRes.layers) || layerRes;
    let curLayer = layers.find((l) => l.id === addedId);
    check("5. set_filter updated amount to 20", curLayer && curLayer.params && curLayer.params.amount === 20);

    await ed.undoStep();
    layerRes = await commands.run("list_layers", { doc: d.id });
    layers = (layerRes && layerRes.layers) || layerRes;
    curLayer = layers.find((l) => l.id === addedId);
    check("5. undo restores amount 14", curLayer && curLayer.params && curLayer.params.amount === 14);

    await ed.redoStep();
    layerRes = await commands.run("list_layers", { doc: d.id });
    layers = (layerRes && layerRes.layers) || layerRes;
    curLayer = layers.find((l) => l.id === addedId);
    check("5. redo restores amount 20", curLayer && curLayer.params && curLayer.params.amount === 20);

    // Save and re-open document
    const savePath = window.__effectsDocPath;
    if (savePath) {
        await commands.run("save_document", { doc: d.id, path: savePath });
        await commands.run("close_document", { doc: d.id, force: true });

        const openRes = await commands.run("open_document", { path: savePath });
        const edOpen = host.editors().find((e) => e.node.id === openRes.id);
        check("5. opened document editor exists", !!edOpen);

        const openLayerRes = await commands.run("list_layers", { doc: openRes.id });
        const openLayers = (openLayerRes && openLayerRes.layers) || openLayerRes;
        const openFilter = openLayers.find((l) => l.filter === "effects.chromatic_shift");
        check("5. open document has effects.chromatic_shift", !!openFilter);
        if (openFilter) {
            check("5. open style is lateral", openFilter.params && openFilter.params.style === "lateral");
            check("5. open amount is 20", openFilter.params && openFilter.params.amount === 20);
            check("5. open angle is 45", openFilter.params && openFilter.params.angle === 45);
            check("5. open strength is 85", openFilter.params && openFilter.params.strength === 85);
        }

        // Test action effects.add_chromatic
        const { runAction } = await import("./plugins.js");
        await runAction("effects.add_chromatic", edOpen);
        const postActRes = await commands.run("list_layers", { doc: openRes.id });
        const postActLayers = (postActRes && postActRes.layers) || postActRes;
        const chromCount = postActLayers.filter((l) => l.filter === "effects.chromatic_shift").length;
        check("5. action effects.add_chromatic added second chromatic shift layer", chromCount === 2);

        await commands.run("close_document", { doc: openRes.id, force: true });
    }

    out.tiles = !!ed.tileMode;
    out.fails = fails;
    return out;
})()
"""


async def run_cdp(c, doc_path):
    norm_path = doc_path.replace("\\", "/")
    await c.eval(f"window.__effectsDocPath = {json.dumps(norm_path)}; 1")
    r = await c.eval(JS, timeout=120)
    fails = r.get("fails", [])
    print(json.dumps({k: v for k, v in r.items() if k != "fails"}))
    for f in fails:
        print("[FAIL]", f)
    if not fails:
        print(f"[ok] effects test on {'tiles' if r.get('tiles') else 'canvas'}")
    return not fails


def node_step():
    r = subprocess.run(
        ["node", os.path.join(HERE, "effects_math_test.js")],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )
    tail = r.stdout.strip()
    if r.returncode != 0 or "PASS" not in tail:
        raise Exception("tools/effects_math_test.js: " + (tail + r.stderr)[-1500:])
    return {"checks": tail.count("[ok]")}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        nres = node_step()
        print(f"[ok] effects_math_test.js: {nres['checks']} checks passed")
    except Exception as err:
        print(f"[FAIL] node: {err}")
        print("FAIL")
        sys.exit(1)

    scratch_dir = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else tempfile.gettempdir()
    os.makedirs(scratch_dir, exist_ok=True)
    doc_path = os.path.join(scratch_dir, f"effects_test_{os.getpid()}.scumble")

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
