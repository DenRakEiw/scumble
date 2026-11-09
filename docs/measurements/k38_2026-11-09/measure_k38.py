"""K38 in-app A/B and step breakdown of matchCanvas CPU fallback (matchPixels=rust vs matchPixels=js) at 4096x4096 and 15000x10000."""
import asyncio
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from cdp import session  # noqa: E402

JS_AB = r"""(async () => {
    const F = await import("./editor/inpaint_filters.js");
    const GL = await import("./editor/inpaint_filters_gl.js");
    const K = await import("./editor/px/kernels.js");
    await K.kernelsReady();
    const W = __W__, H = __H__, RUNS = __RUNS__, ROUTE = __ROUTE__;
    const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return +s[Math.floor(s.length / 2)].toFixed(2); };
    const r1 = (x) => +x.toFixed(1);
    const noise = (n, seed = 5) => {
        const a = new Uint8ClampedArray(n);
        let s = seed >>> 0;
        for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; a[i] = s >>> 24; }
        return a;
    };
    const src = document.createElement("canvas");
    src.width = W; src.height = H;
    src.getContext("2d").putImageData(new ImageData(noise(W * H * 4, 5), W, H), 0, 0);
    const stats = { meanS: [120, 110, 100], meanT: [100, 105, 110], scale: [1.05, 0.95, 1.0] }, k = 0.6;
    const g = GL.glContext();
    const was = g ? g.max : 0;
    const runs = [];
    if (g) g.max = Math.min(W, H) - 1;
    K.setRoute("matchPixels", ROUTE === "js" ? "js" : null);
    try {
        const glRefused = GL.applyMatchGL(src, stats, k) === null;
        for (let i = 0; i < RUNS; i++) {
            K.pxCalls(true);
            let held = 0, last = performance.now(), on = true;
            const beat = () => { const n = performance.now(); held = Math.max(held, n - last); last = n; if (on) setTimeout(beat, 0); };
            setTimeout(beat, 0);
            const t0 = performance.now();
            const outCv = F.matchCanvas(src, stats, k);
            const wall = performance.now() - t0;
            on = false;
            held = Math.max(held, performance.now() - last);
            if (outCv) { outCv.width = 1; outCv.height = 1; }
            runs.push({ wall: r1(wall), blocked: r1(held), pxCalls: K.pxCalls(true) });
        }
        // Step breakdown on one additional pass (draw+getImageData vs matchPixels chunks vs putImageData)
        K.pxCalls(true);
        const tA = performance.now();
        const out = document.createElement("canvas");
        out.width = W; out.height = H;
        const ctx = out.getContext("2d");
        ctx.drawImage(src, 0, 0);
        const img = ctx.getImageData(0, 0, W, H);
        const tB = performance.now();
        const d = img.data;
        const params = new Float32Array([...stats.meanS, ...stats.meanT, ...stats.scale, Math.max(0, Math.min(1, k))]);
        for (let off = 0; off < d.length; off += F.MATCH_CHUNK_BYTES) {
            K.matchPixels(d.subarray(off, off + F.MATCH_CHUNK_BYTES), params);
        }
        const tC = performance.now();
        ctx.putImageData(img, 0, 0);
        const tD = performance.now();
        out.width = 1; out.height = 1;
        const splitCalls = K.pxCalls(true);
        const wasmMB = K.rustPx() ? +(K.rustPx().byteLength / 1048576).toFixed(2) : 0;
        return JSON.stringify({
            size: [W, H],
            route: ROUTE,
            gl_refused: glRefused,
            cpu: {
                median: median(runs.map((x) => x.wall)),
                walls: runs.map((x) => x.wall),
                blocked: median(runs.map((x) => x.blocked)),
                blockedMax: Math.max(...runs.map((x) => x.blocked)),
                worst: Math.max(...runs.map((x) => x.wall)),
                n: runs.length,
            },
            pxCalls: runs.length ? runs[0].pxCalls : null,
            wasmMB,
            split: {
                drawReadMs: r1(tB - tA),
                chunksMs: r1(tC - tB),
                putMs: r1(tD - tC),
                totalMs: r1(tD - tA),
                pxCalls: splitCalls,
            },
        });
    } finally {
        K.setRoute("matchPixels", null);
        if (g) g.max = was;
        src.width = 1; src.height = 1;
    }
})()"""


async def collect(c):
    try:
        await c.call("HeapProfiler.collectGarbage")
    except Exception:  # noqa: BLE001
        pass


async def main():
    round_num = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    out_json = sys.argv[2] if len(sys.argv) > 2 else None
    results = {"round": round_num, "sizes": {}}

    async def go(c):
        await c.call("Page.bringToFront")
        await c.eval("(async () => { await import('./shell.js'); return 1; })()")
        order = ["rust", "js"] if round_num % 2 == 1 else ["js", "rust"]
        for w, h, tag in [(4096, 4096, "4096x4096"), (15000, 10000, "15000x10000")]:
            results["sizes"][tag] = {}
            for route in order:
                await collect(c)
                code = (
                    JS_AB.replace("__W__", str(w))
                    .replace("__H__", str(h))
                    .replace("__RUNS__", "3")
                    .replace("__ROUTE__", json.dumps(route))
                )
                raw = await c.eval(code, timeout=600)
                val = json.loads(raw) if isinstance(raw, str) else raw
                results["sizes"][tag][route] = val
                print(f"   [{tag} {route}] {json.dumps(val)}", flush=True)
                await collect(c)

    await session(go)
    if out_json:
        with open(out_json, "w", encoding="utf-8", newline="\n") as f:
            json.dump(results, f, indent=2)


if __name__ == "__main__":
    asyncio.run(main())
