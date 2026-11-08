"""K36 15000x10000 before/after measurement runner (3 alternating rounds under w1_lock.py)."""
import asyncio
import json
import os
import shutil
import statistics
import subprocess
import sys
import time

AFTER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
BEFORE_DIR = r"C:\Users\schoeneberg\AppData\Local\Temp\claude\F--canvas\k36_before"
OUT_DIR = os.path.dirname(os.path.abspath(__file__))
LOCK_SCRIPT = os.path.join(AFTER_DIR, "docs", "measurements", "w1_2026-11-06", "w1_lock.py")
PORT = "9619"

sys.path.insert(0, os.path.join(AFTER_DIR, "tools"))
import cdp  # noqa: E402


def acquire_lock(who):
    r = subprocess.run([sys.executable, LOCK_SCRIPT, "acquire", who], cwd=AFTER_DIR, capture_output=True, text=True, check=True)
    token = (r.stdout or "").strip()
    if not token:
        raise RuntimeError(f"failed to parse lock token from: {r.stdout} {r.stderr}")
    return token


def release_lock(token):
    subprocess.run([sys.executable, LOCK_SCRIPT, "release", token], cwd=AFTER_DIR, capture_output=True, text=True)


def wait_http(port, timeout=90):
    import urllib.request
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            time.sleep(1)
    return False


def close_app(cwd, port):
    env = dict(os.environ, SCUMBLE_CDP_PORT=str(port))
    subprocess.run([sys.executable, "tools/close_app.py"], cwd=cwd, env=env, capture_output=True)
    time.sleep(3)


BENCH_JS = r"""(async () => {
    const T = await import("./editor/inpaint_tiles.js");
    const K = await import("./editor/px/kernels.js");
    await K.kernelsReady();
    const W = 15000, H = 10000;
    const hasRoute = Object.prototype.hasOwnProperty.call(K.ROUTE_KINDS || {}, "compositeMaskedTile");

    // Build a 24-tile horizontal stroke across row ty=20, tx=10..33 (as a 15000x10000 brush stroke does)
    const baseLayer = T.TileLayerPixels.empty(W, H);
    const strokePaint = T.TileLayerPixels.empty(W, H);
    const strokeErase = T.TileLayerPixels.empty(W, H);
    const covMap = new Map();

    for (let i = 0; i < 24; i++) {
        const tx = 10 + i, ty = 20;
        // Populate existing paint layer tile (opaque & translucent pixels, including low-alpha pixels)
        const d = baseLayer.writable(tx, ty).data;
        for (let p = 0; p < 65536; p++) {
            const o = p * 4;
            d[o] = (p * 37 + i * 13) & 255;
            d[o + 1] = (p * 73 + i * 29) & 255;
            d[o + 2] = (p * 19 + i * 53) & 255;
            d[o + 3] = (i < 8 && (p < 8192 || p >= 57344)) ? 0 : ((p % 7 === 0) ? 2 : 255);
        }
        // For the first 8 tiles, make dst non-empty ONLY inside the middle dab band (8192..57344) so full erase empties them
        if (i < 8) {
            d.fill(0, 0, 8192 * 4);
            d.fill(0, 57344 * 4, 65536 * 4);
        }

        // Paint stroke tile: a dab band covering ~35% of the tile (pixels 16384..39321)
        const sp = strokePaint.writable(tx, ty).data;
        for (let p = 16384; p < 39321; p++) {
            const o = p * 4;
            sp[o] = 255;
            sp[o + 1] = 32;
            sp[o + 2] = 128;
            sp[o + 3] = (p & 3) === 0 ? 0 : ((p * 11) & 255) || 200;
        }

        // Erase stroke tile: full alpha in 8192..57344 (empties tiles i=0..7, partially erases i=8..23)
        const se = strokeErase.writable(tx, ty).data;
        for (let p = 8192; p < 57344; p++) {
            se[p * 4 + 3] = 255;
        }

        // Selection coverage mask for clipped stroke
        const cov = new Uint8Array(65536);
        cov.fill(200, 12000, 44000);
        covMap.set((ty << 16) | tx, cov);
    }

    const covFn = (tx, ty) => covMap.get((ty << 16) | tx) || null;

    const median = (arr) => {
        const s = [...arr].sort((a, b) => a - b);
        return +(s[s.length >> 1]).toFixed(3);
    };

    const runBench = (routeMode) => {
        if (hasRoute) K.setRoute("compositeMaskedTile", routeMode);
        const runPaint = () => {
            const target = baseLayer.clone();
            const snap = target.clone(); // freezes target's tiles (frozen = 1, as pushUndo does before commitStroke)
            const t0 = performance.now();
            const w = target.compositeStroke(strokePaint, 0, 220, null);
            const dt = performance.now() - t0;
            snap.release();
            return { dt, w, target };
        };
        const runClipped = () => {
            const target = baseLayer.clone();
            const snap = target.clone();
            const t0 = performance.now();
            const w = target.compositeStroke(strokePaint, 0, 200, covFn);
            const dt = performance.now() - t0;
            snap.release();
            return { dt, w, target };
        };
        const runErase = () => {
            const target = baseLayer.clone();
            const snap = target.clone();
            const t0 = performance.now();
            const w = target.compositeStroke(strokeErase, 1, 255, null);
            const dt = performance.now() - t0;
            snap.release();
            return { dt, w, target };
        };

        // Warmup
        for (let k = 0; k < 2; k++) {
            runPaint().target.release();
            runClipped().target.release();
            runErase().target.release();
        }
        K.pxCalls(true);
        const paintTimes = [], clipTimes = [], eraseTimes = [];
        let lastPaint = null, lastClip = null, lastErase = null;
        for (let r = 0; r < 9; r++) {
            if (lastPaint) lastPaint.target.release();
            if (lastClip) lastClip.target.release();
            if (lastErase) lastErase.target.release();
            lastPaint = runPaint(); paintTimes.push(lastPaint.dt);
            lastClip = runClipped(); clipTimes.push(lastClip.dt);
            lastErase = runErase(); eraseTimes.push(lastErase.dt);
        }
        const calls = K.pxCalls(true);
        // Compute FNV-1a hashes of the 24 tiles to verify byte-for-byte identity across before, after(js), after(rust)
        const hashLayer = (px) => {
            let h = 2166136261 >>> 0;
            for (let i = 0; i < 24; i++) {
                const t = px.tileAt(10 + i, 20);
                if (!t) {
                    h = Math.imul(h ^ 0xff, 16777619) >>> 0;
                    continue;
                }
                const d = t.data;
                for (let j = 0; j < d.length; j += 16) {
                    h = Math.imul(h ^ d[j], 16777619) >>> 0;
                }
            }
            return h >>> 0;
        };
        const out = {
            paint_ms: median(paintTimes),
            clipped_ms: median(clipTimes),
            erase_ms: median(eraseTimes),
            paint_tiles: lastPaint.target.tileCount,
            erase_tiles: lastErase.target.tileCount,
            paint_hash: hashLayer(lastPaint.target),
            clipped_hash: hashLayer(lastClip.target),
            erase_hash: hashLayer(lastErase.target),
            calls,
        };
        lastPaint.target.release();
        lastClip.target.release();
        lastErase.target.release();
        if (hasRoute) K.setRoute("compositeMaskedTile", null);
        return out;
    };

    try {
        const res = hasRoute
            ? { rust: runBench("rust"), js: runBench("js") }
            : { before: runBench(null) };
        return res;
    } finally {
        baseLayer.release();
        strokePaint.release();
        strokeErase.release();
    }
})()"""


async def eval_bench(port):
    cdp.PORT = int(port)
    res = None

    async def _go(c):
        nonlocal res
        await c.call("Page.bringToFront")
        res = await c.eval(BENCH_JS, timeout=120)
        return True

    await cdp.session(_go)
    return res


def run_side(label, round_idx, cwd, port):
    profile = os.path.join(AFTER_DIR, "dist", "gates", "profiles", f"k36-{label}-r{round_idx}")
    shutil.rmtree(profile, ignore_errors=True)
    os.makedirs(os.path.join(profile, "files", "input", "inpaint_canvas"), exist_ok=True)
    shutil.copyfile(
        r"F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\input\inpaint_canvas\test_base.png",
        os.path.join(profile, "files", "input", "inpaint_canvas", "test_base.png"),
    )
    close_app(cwd, port)
    exe = os.path.join(cwd, "node_modules", "electron", "dist", "electron.exe")
    app_log = open(os.path.join(OUT_DIR, f"app_{label}_r{round_idx}.log"), "w", encoding="utf-8")
    env = dict(os.environ, SCUMBLE_CDP_PORT=str(port), SCUMBLE_TILES="1", SCUMBLE_STRICT="0")
    proc = subprocess.Popen(
        [
            exe,
            ".",
            f"--remote-debugging-port={port}",
            f"--user-data-dir={profile}",
            "--use-fake-device-for-media-stream",
            "--tiles",
            "--no-comfy",
        ],
        cwd=cwd,
        env=env,
        stdout=app_log,
        stderr=subprocess.STDOUT,
    )
    try:
        if not wait_http(port, 90):
            raise RuntimeError(f"Electron did not listen on {port}")
        time.sleep(6)
        json_out = os.path.join(OUT_DIR, f"native_{label}_r{round_idx}.json")
        log_out = os.path.join(OUT_DIR, f"native_{label}_r{round_idx}.txt")
        r = subprocess.run(
            [
                sys.executable,
                "tools/native_test.py",
                "15000x10000",
                "--json",
                json_out,
                "add_the_paint_layer",
                "stroke_and_release",
            ],
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=600,
        )
        with open(log_out, "w", encoding="utf-8", newline="\n") as f:
            f.write((r.stdout or "") + (r.stderr or ""))
        if r.returncode != 0:
            raise RuntimeError(f"native_test.py failed ({label} r{round_idx}): rc={r.returncode}\n{r.stdout[-500:]}")
        bench = asyncio.run(eval_bench(port))
        with open(os.path.join(OUT_DIR, f"bench_{label}_r{round_idx}.json"), "w", encoding="utf-8", newline="\n") as f:
            json.dump(bench, f, indent=2)
        native_data = json.load(open(json_out, encoding="utf-8"))
        sr = native_data["rows"]["stroke_and_release"]["row"]
        print(
            f"  [r{round_idx} {label}] stroke_and_release: wall={sr['wall']} ms, blocked={sr['blocked']} ms, "
            f"release={sr['extra']['release']} ms, pxCalls={sr['pxCalls']['window']} | bench={json.dumps(bench)}",
            flush=True,
        )
        return {"native": sr, "bench": bench}
    finally:
        close_app(cwd, port)
        try:
            proc.kill()
        except Exception:
            pass
        app_log.close()
        shutil.rmtree(profile, ignore_errors=True)


def main():
    rounds = {1: [("before", BEFORE_DIR), ("after", AFTER_DIR)], 2: [("after", AFTER_DIR), ("before", BEFORE_DIR)], 3: [("before", BEFORE_DIR), ("after", AFTER_DIR)]}
    all_res = {"before": [], "after": []}
    for r_idx in (1, 2, 3):
        token = acquire_lock(f"chain-f K36 15k r{r_idx}")
        try:
            print(f"=== Round {r_idx} (lock {token}) ===", flush=True)
            for label, cwd in rounds[r_idx]:
                res = run_side(label, r_idx, cwd, PORT)
                all_res[label].append(res)
        finally:
            release_lock(token)
    with open(os.path.join(OUT_DIR, "raw_all.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(all_res, f, indent=2)
    print("ALL 3 ROUNDS DONE", flush=True)


if __name__ == "__main__":
    main()
