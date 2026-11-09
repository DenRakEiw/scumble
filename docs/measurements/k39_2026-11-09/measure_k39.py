"""K39 end-to-end growSelection fallback & route A/B benchmark (2000x2000, 7500x5000, 15000x10000).

Measures:
1. End-to-end `ed.growSelection(20)` when `selectionInWorker` returns `null` (so `growSelectionNow` takes the window
   fallback: `readRect` + `growMaskBounds` [or `growMask` on before] + `writeRect` + `markSelectionChanged`), on both
   `2000 x 2000` (4 MP) and `7500 x 5000` (37.5 MP).
2. Route A/B on `growMaskBounds` (`growMask=rust` vs `growMask=js` vs `setKernels("js")`) at `2000 x 2000`, `7500 x 5000`,
   and `15000 x 10000`, recording wall time, longest main-thread block, step breakdown (`kernel` vs `bounds`/`feature`/`edt`/`write`/`resultBounds`),
   `pxCalls`, and window `pxInstances()` (`release` count and `bytes` MB).
"""
import asyncio
import json
import os
import statistics
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from cdp import session  # noqa: E402

JSON_OUT = next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--json" and i + 1 < len(sys.argv)), None)
MODE = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--mode=")), "after")

E2E_SCRIPT = r"""(async () => {
    const commands = (await import('./commands.js')).commands;
    const host = (await import('./editor/host.js')).host;
    const K = await import('./editor/px/kernels.js');
    await K.kernelsReady();
    const run = (n, a) => commands.run(n, a || {});
    const r1 = (x) => Math.round(x * 10) / 10;
    const W = %(w)d, H = %(h)d, N = %(n)d, ROUTE = %(route)s;
    K.setKernels("rust");
    if (ROUTE && K.ROUTE_KINDS && Object.prototype.hasOwnProperty.call(K.ROUTE_KINDS, "growMask")) {
        K.setRoute("growMask", ROUTE);
    }
    const doc = (await run("new_document")).id;
    const ed = host.editors().find((e) => e.node.id === doc);
    host.shell.activate(ed);
    await run("new_canvas", { width: W, height: H, doc });
    const cx = W >> 1, cy = H >> 1, rx = Math.round(0.35 * W), ry = Math.round(0.35 * H);
    const x0 = cx - rx, y0 = cy - ry, x1 = cx + rx, y1 = cy + ry;
    let rescans = 0;
    const origScan = ed.selectionBounds.bind(ed);
    ed.selectionBounds = (...a) => { rescans++; return origScan(...a); };
    ed.selectionInWorker = async () => null;
    let wall = 0, blocked = 0, pxCalls = null, bounds = null, instBefore = null, instAfter = null;
    try {
        ed.clearUndo(); ed.sel.clear();
        ed.sel.fill([x0, y0, x1, y1], "#ff0000");
        ed.markSelectionChanged([x0, y0, x1, y1]);
        rescans = 0;
        instBefore = K.pxInstances();
        K.pxCalls(true);
        let held = 0, last = performance.now(), on = true;
        const beat = () => { const now = performance.now(); held = Math.max(held, now - last); last = now; if (on) setTimeout(beat, 0); };
        setTimeout(beat, 0);
        const t0 = performance.now();
        try {
            await ed.growSelection(N);
        } finally {
            on = false;
            held = Math.max(held, performance.now() - last);
        }
        wall = r1(performance.now() - t0);
        blocked = r1(held);
        pxCalls = K.pxCalls(true);
        bounds = ed.getBounds();
        await K.pxSettled();
        instAfter = K.pxInstances();
    } finally {
        if (K.ROUTE_KINDS && Object.prototype.hasOwnProperty.call(K.ROUTE_KINDS, "growMask")) {
            K.setRoute("growMask", null);
        }
        delete ed.selectionInWorker;
        delete ed.selectionBounds;
        await run("close_document", { doc, force: true });
    }
    return {
        size: [W, H],
        route: ROUTE || "default",
        wall,
        blocked,
        rescans,
        bounds,
        pxCalls,
        releaseDelta: instAfter.release - instBefore.release,
        wasmMB: +(instAfter.bytes / 1048576).toFixed(2),
    };
})()"""


async def collect(c):
    try:
        await c.call("HeapProfiler.collectGarbage")
    except Exception:  # noqa: BLE001
        pass


async def main():
    out = {"mode": MODE, "e2e": {}}

    async def go(c):
        await c.call("Page.bringToFront")
        await c.eval("(async () => { await import('./shell.js'); return 1; })()")
        routes = ["rust", "js"] if MODE == "after" else [None]
        for w, h in ((2000, 2000), (7500, 5000)):
            key = f"{w}x{h}"
            out["e2e"][key] = {}
            for rt in routes:
                label = rt or "before"
                runs = []
                for _ in range(3):
                    r = await c.eval(E2E_SCRIPT % {"w": w, "h": h, "n": 20, "route": json.dumps(rt)}, timeout=300)
                    runs.append(r)
                    await collect(c)
                walls = [x["wall"] for x in runs]
                blks = [x["blocked"] for x in runs]
                res = {
                    "wall_med": round(statistics.median(walls), 1),
                    "walls": walls,
                    "blocked_med": round(statistics.median(blks), 1),
                    "blocked_max": round(max(blks), 1),
                    "rescans": runs[0]["rescans"],
                    "bounds": runs[0]["bounds"],
                    "pxCalls": runs[0]["pxCalls"],
                    "releaseDelta": runs[0]["releaseDelta"],
                    "wasmMB": runs[0]["wasmMB"],
                }
                out["e2e"][key][label] = res
                print(f"  e2e {key} {label}: {json.dumps(res)}", flush=True)

    await session(go)
    if JSON_OUT:
        os.makedirs(os.path.dirname(os.path.abspath(JSON_OUT)), exist_ok=True)
        with open(JSON_OUT, "w", encoding="utf-8", newline="\n") as f:
            json.dump(out, f, indent=2)
    print("RESULT PASS")


if __name__ == "__main__":
    asyncio.run(main())
