"""15000 x 10000 before / after measurement for fix-tiles session T-2 (`tiles/T4`: a selection combine that keeps every
alpha rewrote every existing tile in the source's box).

On a fresh Electron instance per run (--no-comfy, --tiles), a 15000 x 10000 document; for each row the selection is
set to the left half (`fill([0, 0, 7500, 10000])`, 30 x 40 = 1200 tiles), its display chains settled, the undo step
taken as the editor takes it (`snapshotSelection()`: the copy shares every tile), then:
  1. `add_none`:       add of a tile source with one full tile far right, its box the whole image: 1200 tiles SEL_NONE
                       (the scenario of the finding: a range or wand band adding a few tiles).
  2. `subtract_none`:  subtract of the same source.
  3. `intersect_full`: intersect with a source full on every tile of the left half (box [0, 0, 7680, 10000]).
  4. `add_none_last_px_off` (the new check's worst case, a row that may lose): as 1, but every tile's last pixel inside
                       the image is green, so the check scans each tile whole and the kernel runs after it anyway.
Per row: `combineMs` (the combine alone) and `wholeMs` (combine + markSelectionChanged + draw + mipsSettled, the
display's chains rebuilt), `rewritten` (tiles the selection no longer shares with the step: the copies the step holds
alone), and `tiles`.

Usage (hold w1_lock.py around each batch):
    python docs/measurements/fix_tiles_t2_2026-11-11/bench_15k.py --label after --runs 3 --port 9643 --out docs/measurements/fix_tiles_t2_2026-11-11/after.json
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
    const { tilesSource } = await import("./editor/inpaint_raster.js");
    const W = 15000, H = 10000;
    const ed = shell.newDocument();
    shell.activate(ed);
    await new Promise((r) => setTimeout(r, 300));
    ed.resizeCanvas();
    const base = document.createElement("canvas"); base.width = W; base.height = H;
    const bx = base.getContext("2d"); bx.fillStyle = "#58708a"; bx.fillRect(0, 0, W, H);
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "t2_15k.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
    base.width = 1; base.height = 1;
    ed.canvas.width = 3840; ed.canvas.height = 2160;
    ed.view = { scale: 0.24, x: 0, y: 0, angle: 0 };
    ed.draw();
    await ed.mipsSettled();
    const far = () => tilesSource([{ tx: 58, ty: 38, full: true }], [0, 0], [0, 0, W, H]);
    const left = [];
    for (let ty = 0; ty < 40; ty++) for (let tx = 0; tx < 30; tx++) left.push({ tx, ty, full: true });
    const ROWS = [
        ["add_none", "add", far, false],
        ["subtract_none", "subtract", far, false],
        ["intersect_full", "intersect", () => tilesSource(left, [0, 0], [0, 0, 7680, H]), false],
        ["add_none_last_px_off", "add", far, true],
    ];
    const out = { tiles: !!ed.tileMode };
    for (const [name, mode, src, offPx] of ROWS) {
        ed.sel.clear();
        ed.sel.fill([0, 0, 7500, H], "#ff0000");
        if (offPx) {
            for (const key of ed.sel.tileKeys()) {
                const tx = key & 0xFFFF, ty = key >>> 16, t = ed.sel.writable(tx, ty);
                const bw = Math.min(256, 7500 - tx * 256), bh = Math.min(256, H - ty * 256);
                new Uint32Array(t.data.buffer, t.data.byteOffset, 65536)[(bh - 1) * 256 + bw - 1] = 0xFF00FF00;
            }
        }
        ed.markSelectionChanged(undefined);
        ed.draw();
        await ed.mipsSettled();
        await new Promise((r) => setTimeout(r, 200));
        const step = ed.snapshotSelection();
        const tilesBefore = ed.sel.tileCount;
        const s = src();
        const t0 = performance.now();
        ed.sel.combine(s, mode);
        const combineMs = performance.now() - t0;
        ed.markSelectionChanged({ within: [0, 0, W, H] }, [0, 0, W, H]);
        ed.draw();
        await ed.mipsSettled();
        const wholeMs = performance.now() - t0;
        let rewritten = 0;
        for (const key of ed.sel.tileKeys()) {
            const tx = key & 0xFFFF, ty = key >>> 16, a = step.px ? step.px.tileAt(tx - step.x / 256, ty - step.y / 256) : null;
            if (a && a !== ed.sel.tileAt(tx, ty)) rewritten++;
        }
        out[name] = { combineMs: +combineMs.toFixed(2), wholeMs: +wholeMs.toFixed(2), rewritten, tilesBefore, tiles: ed.sel.tileCount, stepPx: !!step.px };
        if (step.px) step.px.release();
    }
    shell.closeDocument(ed, { force: true });
    return out;
})()
"""

ROWS = ("add_none", "subtract_none", "intersect_full", "add_none_last_px_off")


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
        return await c.eval(JS_BENCH, timeout=600)
    return await session(body)


def one_instance_run(repo, port):
    import urllib.request
    prof = tempfile.mkdtemp(prefix="scumble_t2_15k_")
    env = dict(os.environ, SCUMBLE_CDP_PORT=str(port), SCUMBLE_TILES="1")
    proc = subprocess.Popen(
        [electron_bin(repo), repo, f"--remote-debugging-port={port}", f"--user-data-dir={prof}",
         "--use-fake-device-for-media-stream", "--tiles", "--no-comfy"],
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
    out = {}
    for r in ROWS:
        c = [x[r]["combineMs"] for x in runs]
        w = [x[r]["wholeMs"] for x in runs]
        out[r] = {
            "combineMs_median": round(statistics.median(c), 2), "combineMs_runs": c,
            "combineMs_spread": round(max(c) - min(c), 2),
            "wholeMs_median": round(statistics.median(w), 2), "wholeMs_runs": w,
            "wholeMs_spread": round(max(w) - min(w), 2),
            "rewritten_runs": [x[r]["rewritten"] for x in runs],
            "tiles_runs": [[x[r]["tilesBefore"], x[r]["tiles"]] for x in runs],
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
        runs.append(r)
        print(f"[{args.label} run {i + 1}/{args.runs}, {time.time() - t0:.1f}s] tiles={r['tiles']} "
              + ", ".join(f"{k}={r[k]['combineMs']}/{r[k]['wholeMs']}ms rw={r[k]['rewritten']}" for k in ROWS), flush=True)
    payload = {"label": args.label, "runs": runs, "summary": summarize_runs(runs)}
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, indent=2)


if __name__ == "__main__":
    main()
