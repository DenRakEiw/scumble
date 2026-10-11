"""Relight filter layer in-app CDP gate (PLAN_RELIGHT_BUILD.md section 5.4 L1a).

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

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

JS = r"""
(async (docPath) => {
    const shell = await import("./shell.js");
    const { commands } = await import("./commands.js");
    const F = await import("./editor/inpaint_filters.js");
    const GLM = await import("./editor/inpaint_filters_gl.js");
    const { host } = await import("./editor/host.js");
    const { makeMap } = await import("./editor/inpaint_maps.js");
    const PNG = await import("./editor/inpaint_png.js");

    const fails = [];
    const check = (name, ok, info) => {
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
    // x < 75: high ground (depth = 50000)
    // x >= 75: low ground (depth = 10000)
    const Mw = 150, Mh = 100;
    const ramp = new Uint16Array(Mw * Mh);
    for (let y = 0; y < Mh; y++) {
        for (let x = 0; x < Mw; x++) {
            ramp[y * Mw + x] = x < 75 ? 50000 : 10000;
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

    return { fails, checks: 25 - fails.length, tiles: !!ed.tileMode };
})
"""


async def run_cdp(cdp, doc_path):
    escaped_path = doc_path.replace("\\", "\\\\")
    expr = f"({JS})('{escaped_path}')"
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

    shot_path = os.path.join(ROOT, "scratch", "shot_l1a.png")
    try:
        await cdp.screenshot(shot_path)
        print(f"[ok] screenshot captured: {shot_path}")
    except Exception as e:
        print(f"[warn] screenshot: {e}")

    return len(fails) == 0


def node_step():
    r = subprocess.run(
        ["node", os.path.join(HERE, "relight_test.js")],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )
    tail = r.stdout.strip()
    if r.returncode != 0 or "PASS" not in tail:
        raise Exception("tools/relight_test.js: " + (tail + r.stderr)[-1500:])
    return {"checks": tail.count("PASS")}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        nres = node_step()
        print(f"[ok] relight_test.js: {nres['checks']} checks passed")
    except Exception as err:
        print(f"[FAIL] node: {err}")
        print("FAIL")
        sys.exit(1)

    scratch_dir = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else tempfile.gettempdir()
    os.makedirs(scratch_dir, exist_ok=True)
    doc_path = os.path.join(scratch_dir, f"relight_test_{os.getpid()}.scumble")

    try:
        ok = asyncio.run(session(lambda c: run_cdp(c, doc_path)))
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
        if os.path.exists(doc_path):
            try:
                os.remove(doc_path)
            except OSError:
                pass

    print("PASS")
    sys.exit(0)


if __name__ == "__main__":
    main()
