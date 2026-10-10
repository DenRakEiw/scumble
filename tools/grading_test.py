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

    // 3b. set_filter { params: { nope: 1 } } error message names the 14 valid keys
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

    // 3c. filter_types lists color_grade with 14 parameters
    const ftypesRes = await commands.run("filter_types", {});
    const ftypesList = Array.isArray(ftypesRes) ? ftypesRes : (ftypesRes.types || ftypesRes.filters || []);
    const gradeType = ftypesList.find((t) => t.id === "color_grade");
    check("3c. filter_types includes color_grade", !!gradeType, ftypesList.map((t) => t.id));
    check("3c. filter_types color_grade has 14 parameters", gradeType && gradeType.params && gradeType.params.length === 14, gradeType?.params?.length);
    const reportedKeys = (gradeType?.params || []).map((p) => p.key);
    const missingParamKeys = valid14Keys.filter((k) => !reportedKeys.includes(k));
    check("3c. filter_types parameters match all 14 keys exactly", missingParamKeys.length === 0 && reportedKeys.length === 14, { reportedKeys, missingParamKeys });

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
            check(`4. param ${k} preserved in document round trip`, openedFilter.params[k] === v, {
                key: k, expected: v, actual: openedFilter.params[k]
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
