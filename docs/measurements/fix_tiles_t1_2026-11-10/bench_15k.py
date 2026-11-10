"""15000 x 10000 before / after measurement for fix-tiles session T-1 (`tiles/T1`, `tiles/T2`).

Measures three rows on a plain 15000 x 10000 stack (base + 3 whole-picture paint layers, 3840 x 2160 viewport) across
fresh Electron instances (--no-comfy, --tiles on):
  1. `under_budget_512mb`: fit view (level 2, ~170 MB <= 512 MB default budget) — first composite and 5 cached redraws.
  2. `over_budget_zoom_512mb` (`tiles/T1` scenario): fit (level 2) then zoom to scale 0.26 (level 1, ~416 MB on top of
     fit's ~170 MB, crossing 512 MB on the 4th store) — first zoom frame and median/worst of 5 subsequent pan frames
     through `drawViewComposite` (GPU compositor vs Canvas 2D fallback when `glViewComposite` returns null).
  3. `budget_2048mb_fit` (`tiles/T2` scenario): `setAtlasBudget(2048 * 1048576)` then fit view — first frame and
     median/worst of 5 subsequent pan frames through `drawViewComposite`.

Usage (hold `w1_lock.py` around each batch):
    python docs/measurements/fix_tiles_t1_2026-11-10/bench_15k.py --label after --runs 3 --port 9643 --out docs/measurements/fix_tiles_t1_2026-11-10/after.json
"""
import argparse
import asyncio
import json
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import cdp  # noqa: E402
from cdp import session  # noqa: E402

JS_BENCH = r"""
(async () => {
    const shell = await import("./shell.js");
    const W = 15000, H = 10000;
    const MB = 1048576;
    const focusStart = [document.hasFocus(), document.visibilityState];
    const ed = shell.newDocument();
    shell.activate(ed);
    await new Promise((r) => setTimeout(r, 300));
    ed.resizeCanvas();
    const { Layer: LayerPixels } = ed.pixels;
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const paint = (hue) => {
        const c = mk(W, H), x = c.getContext("2d");
        x.fillStyle = `hsl(${hue}, 65%, 42%)`;
        x.fillRect(0, 0, W, H);
        for (let i = 0; i < 40; i++) {
            x.fillStyle = `hsl(${(hue + i * 29) % 360}, 75%, 55%)`;
            x.fillRect((i * 1733) % (W - 600), (i * 1103) % (H - 600), 600, 600);
        }
        return c;
    };
    const base = paint(205);
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "t1_15k.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
    const modes = ["normal", "multiply", "screen"];
    for (let i = 0; i < 3; i++) {
        const lc = paint(30 + i * 85);
        ed.addLayer({ name: "L" + (i + 1), kind: "paint", px: LayerPixels.fromCanvas(lc), x: 0, y: 0, w: W, h: H, dirty: true, blend: modes[i], opacity: 0.85 });
    }
    ed.renderLayers();
    // Warm exact mip chains for all 4 stores at fit and level 1 so we time compositing, not background worker mip builds
    ed.canvas.width = 3840; ed.canvas.height = 2160;
    ed.view = { scale: 0.24, x: 120, y: 80, angle: 0 };
    ed.draw();
    await ed.mipsSettled();
    ed.view = { scale: 0.26, x: 0, y: 0, angle: 0 };
    ed.draw();
    await ed.mipsSettled();

    const comp = ed.compositor();
    const outCtx = mk(3840, 2160).getContext("2d");
    const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

    const timeFrames = (scale, n) => {
        ed.canvas.width = 3840; ed.canvas.height = 2160;
        ed.view = { scale, x: 0, y: 0, angle: 0 };
        const reg0 = ed.viewportRegion();
        const vw0 = Math.max(1, Math.round(reg0.w * reg0.scale)), vh0 = Math.max(1, Math.round(reg0.h * reg0.scale));
        const tFirst0 = performance.now();
        ed.sceneSig = null;
        ed.drawViewComposite(outCtx, {});
        const firstMs = +(performance.now() - tFirst0).toFixed(2);
        const probeFirst = ed.glViewComposite(reg0, vw0, vh0, {}) !== null;
        const times = [];
        let gpuCount = 0;
        for (let i = 0; i < n; i++) {
            ed.view.x = -(i * 4);
            ed.sceneSig = null;
            const t0 = performance.now();
            ed.drawViewComposite(outCtx, {});
            times.push(+(performance.now() - t0).toFixed(2));
        }
        const regLast = ed.viewportRegion();
        const vwL = Math.max(1, Math.round(regLast.w * regLast.scale)), vhL = Math.max(1, Math.round(regLast.h * regLast.scale));
        const gpuLast = ed.glViewComposite(regLast, vwL, vhL, {}) !== null;
        if (gpuLast) gpuCount++;
        const st = comp.stats().atlas;
        return {
            firstMs,
            medianMs: +median(times).toFixed(2),
            worstMs: +Math.max(...times).toFixed(2),
            samplesMs: times,
            gpuFirst: probeFirst,
            gpuSteady: gpuLast,
            atlasMB: +(st.bytes / MB).toFixed(2),
            budgetMB: +(st.budget / MB).toFixed(2),
            pages: st.pages,
        };
    };

    // Row 1: under_budget_512mb (fit, scale 0.144 -> level 2, ~170 MB <= 512 MB)
    comp.clear();
    comp.setAtlasBudget(512 * MB);
    const under = timeFrames(0.24, 5);

    // Row 2: over_budget_zoom_512mb (fit level 2 warm in atlas, then zoom to scale 0.26 -> level 1, crosses 512 MB on 4th store)
    comp.clear();
    comp.setAtlasBudget(512 * MB);
    ed.view = { scale: 0.24, x: 120, y: 80, angle: 0 };
    ed.drawViewComposite(outCtx, {});
    const overZoom = timeFrames(0.26, 5);

    // Row 3: budget_2048mb_fit (setAtlasBudget(2048 MB), fit scale 0.24)
    comp.clear();
    comp.setAtlasBudget(2048 * MB);
    const b2048 = timeFrames(0.24, 5);

    const focusEnd = [document.hasFocus(), document.visibilityState];
    shell.closeDocument(ed, { force: true });
    return { tiles: !!ed.tileMode, focusStart, focusEnd, under_budget_512mb: under, over_budget_zoom_512mb: overZoom, budget_2048mb_fit: b2048 };
})()
"""


def electron_bin(repo):
    p = os.path.join(repo, "node_modules", "electron", "dist", "electron.exe")
    if not os.path.exists(p):
        sys.exit(f"electron binary not found: {p}")
    return p


async def run_once(port):
    async def body(c):
        await c.call("Page.bringToFront")
        await c.call("Emulation.setFocusEmulationEnabled", enabled=True)
        await asyncio.sleep(0.3)
        return await c.eval(JS_BENCH, timeout=300)
    return await session(body)


def one_instance_run(repo, port):
    import urllib.request
    prof = tempfile.mkdtemp(prefix="scumble_t1_15k_")
    env = dict(os.environ, SCUMBLE_CDP_PORT=str(port), SCUMBLE_TILES="1")
    proc = subprocess.Popen(
        [
            electron_bin(repo), repo,
            f"--remote-debugging-port={port}",
            f"--user-data-dir={prof}",
            "--use-fake-device-for-media-stream",
            "--tiles",
            "--no-comfy",
        ],
        cwd=repo, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.time() + 60
        ready = False
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2) as r:
                    if r.status == 200:
                        ready = True
                        break
            except Exception:
                time.sleep(0.5)
        if not ready:
            raise RuntimeError(f"DevTools on port {port} did not come up within 60s")
        time.sleep(6.0)
        os.environ["SCUMBLE_CDP_PORT"] = str(port)
        cdp.PORT = int(port)
        return asyncio.run(run_once(port))
    finally:
        subprocess.run([sys.executable, os.path.join(repo, "tools", "close_app.py")],
                       env=dict(os.environ, SCUMBLE_CDP_PORT=str(port)), capture_output=True)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(prof, ignore_errors=True)


def summarize_runs(runs):
    rows = ("under_budget_512mb", "over_budget_zoom_512mb", "budget_2048mb_fit")
    out = {}
    for r in rows:
        firsts = [x[r]["firstMs"] for x in runs]
        meds = [x[r]["medianMs"] for x in runs]
        worsts = [x[r]["worstMs"] for x in runs]
        out[r] = {
            "firstMs_median": round(statistics.median(firsts), 2),
            "firstMs_runs": firsts,
            "steady_medianMs": round(statistics.median(meds), 2),
            "steady_median_runs": meds,
            "worstMs": round(max(worsts), 2),
            "gpuSteady_all": all(x[r]["gpuSteady"] for x in runs),
            "gpuSteady_runs": [x[r]["gpuSteady"] for x in runs],
            "atlasMB_median": round(statistics.median(x[r]["atlasMB"] for x in runs), 2),
            "budgetMB": runs[0][r]["budgetMB"],
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=ROOT)
    ap.add_argument("--label", required=True)
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--port", type=int, default=9643)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    runs = []
    for i in range(args.runs):
        t0 = time.time()
        r = one_instance_run(os.path.abspath(args.repo), args.port)
        dt = time.time() - t0
        runs.append(r)
        print(f"[{args.label} run {i + 1}/{args.runs}, {dt:.1f}s] "
              f"under={r['under_budget_512mb']['medianMs']}ms (gpu={r['under_budget_512mb']['gpuSteady']}), "
              f"overZoom={r['over_budget_zoom_512mb']['medianMs']}ms (first={r['over_budget_zoom_512mb']['firstMs']}ms, gpu={r['over_budget_zoom_512mb']['gpuSteady']}, atlas={r['over_budget_zoom_512mb']['atlasMB']}MB), "
              f"b2048={r['budget_2048mb_fit']['medianMs']}ms (gpu={r['budget_2048mb_fit']['gpuSteady']}, budget={r['budget_2048mb_fit']['budgetMB']}MB)",
              flush=True)

    payload = {"label": args.label, "runs": runs, "summary": summarize_runs(runs)}
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, indent=2)


if __name__ == "__main__":
    main()
