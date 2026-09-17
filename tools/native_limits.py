"""Phase N1 (docs/PLAN_BCE.md §3b): the memory limits of the renderer, measured on this machine.

A measurement, not a gate. Every mode can end the renderer, so each one runs on a fresh offline instance:

    ./node_modules/.bin/electron . --remote-debugging-port=9555 --no-comfy --user-data-dir=<scratch profile>
    python tools/native_limits.py alloc sab [--cap-gb 24]     # SharedArrayBuffers of 64 MB (the tile arena's chunks)
    python tools/native_limits.py alloc ab [--cap-gb 24]      # plain ArrayBuffers of 64 MB
    python tools/native_limits.py alloc wasm                  # one WebAssembly.Memory grown until it refuses
    python tools/native_limits.py layers 15000x10000 10       # one document, full-size paint layers one by one
    python tools/native_limits.py docs 15000x10000 4          # documents with a base and one full paint layer each

Every step is its own call, printed at once: when the renderer dies the last line is the limit. `alloc` touches a byte
per page so the memory is committed, and stops at `--cap-gb` (this machine also runs the user's ComfyUI).
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

ARGS = sys.argv[1:]
CAP_GB = 24
if "--cap-gb" in ARGS:
    i = ARGS.index("--cap-gb")
    CAP_GB = float(ARGS[i + 1])
    del ARGS[i:i + 2]

METRICS = """
const metricsNow = async () => {
    const m = await window.scumble.metrics();
    let gpu = 0, renderer = 0;
    for (const p of m.processes || []) {
        const kb = p.privateKB || p.workingSetKB || 0;
        if (p.type === "GPU") gpu += kb;
        if (p.type === "Tab" || p.type === "renderer" || p.type === "Renderer") renderer = Math.max(renderer, kb);
    }
    const rp = m.renderer && m.renderer.process;
    if (rp && rp.private) renderer = rp.private;
    return { rendererMB: Math.round(renderer / 1024), gpuMB: Math.round(gpu / 1024) };
};
"""

ALLOC = """(async () => {
    %s
    const kind = "%s", n = %d, CH = 64 * 1048576;
    const keep = window.__lim || (window.__lim = []);
    let made = 0, error = null;
    for (let i = 0; i < n; i++) {
        try {
            const b = kind === "sab" ? new SharedArrayBuffer(CH) : new ArrayBuffer(CH);
            const u = new Uint8Array(b);
            for (let o = 0; o < CH; o += 4096) u[o] = 1;
            keep.push(b);
            made++;
        } catch (err) { error = String((err && err.message) || err); break; }
    }
    return JSON.stringify({ made, heldGB: +(keep.length * 64 / 1024).toFixed(2), error, ...(await metricsNow()) });
})()"""

WASM = """(async () => {
    %s
    const m = new WebAssembly.Memory({ initial: 1, maximum: 65536 });
    let pages = 1, error = null;
    const step = 4096;   // 256 MB
    while (pages + step <= 65536) {
        try { m.grow(step); pages += step; new Uint8Array(m.buffer, (pages - step) * 65536, step * 65536).fill(1); } catch (err) { error = String((err && err.message) || err); break; }
    }
    window.__limWasm = m;
    return JSON.stringify({ wasmGB: +(pages * 65536 / 2 ** 30).toFixed(2), error, ...(await metricsNow()) });
})()"""

DOC = """(async () => {
    %s
    const [W, H] = [%d, %d];
    const shell = await import("./shell.js");
    const T = await import("./editor/inpaint_tiles.js");
    const A = await import("./editor/inpaint_arena.js");
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const full = (seed) => {
        const px = T.TileLayerPixels.empty(W, H);
        for (let ty = 0; ty * 256 < H; ty++) for (let tx = 0; tx * 256 < W; tx++) {
            const d = px.writable(tx, ty).data;
            // every tile differs, so nothing can be shared or dropped as empty
            const v = (tx * 31 + ty * 17 + seed * 7) & 255;
            for (let o = 0; o < d.length; o += 4) { d[o] = v; d[o + 1] = (o >> 4) & 255; d[o + 2] = seed; d[o + 3] = 160; }
        }
        return px;
    };
    const what = "%s";
    let ed;
    const t0 = performance.now();
    if (what === "document") {
        ed = shell.newDocument();
        shell.activate(ed);
        await wait(300);
        ed.resizeCanvas();
        if (!ed.tileMode) throw new Error("tiles are off");
        let base = full(0);
        for (const [, t] of base._tiles) { const d = t.data; for (let o = 3; o < d.length; o += 4) d[o] = 255; }
        if (typeof ed.setBasePixels === "function") await ed.setBasePixels({ filename: "limits.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
        else {
            const E = ed.constructor;
            const enc = await E.parts.encodeTilePixels(base, { hash: false });
            base.release(); base = null;
            await ed.loadFile(new File([enc.blob], "limits.png", { type: "image/png" }));
        }
        (window.__limDocs || (window.__limDocs = [])).push(ed);
    } else {
        ed = window.__limDocs[window.__limDocs.length - 1];
        const seed = ed.layers.length + 1;
        ed.addLayer({ name: "Paint " + seed, kind: "paint", px: full(seed), x: 0, y: 0, w: W, h: H, dirty: true });
    }
    ed.renderLayers(); ed.fitView(); ed.draw();
    await ed.mipsSettled();
    const built = Math.round(performance.now() - t0);
    ed.view.scale = 1; ed._fitted = false;
    ed.view.x = Math.round(ed.canvas.width / 2 - W / 2); ed.view.y = Math.round(ed.canvas.height / 2 - H / 2);
    ed.draw(); ed.draw();
    const ts = [];
    for (let i = 0; i < 30; i++) { const a = performance.now(); ed.view.x += (i %% 2 ? -7 : 9); ed.view.y += 3; ed.draw(); ts.push(performance.now() - a); }
    ts.sort((a, b) => a - b);
    await wait(1500);
    const arena = A.arenaStats();
    return JSON.stringify({ docs: window.__limDocs.length, layers: ed.layers.length, builtMs: built, pan1to1: +ts[15].toFixed(2), arenaGB: +(arena.bytes / 2 ** 30).toFixed(2), refused: arena.refused, status: ed.status, ...(await metricsNow()) });
})()"""


async def main(c):
    mode = ARGS[0] if ARGS else ""
    connected = await c.eval("(async () => { const s = await window.scumble.comfy.status(); return s && s.state; })()")
    if connected in ("connected", "missing-node"):
        print("this instance is connected to ComfyUI: start it with --no-comfy")
        return
    try:
        if mode == "alloc" and ARGS[1] in ("sab", "ab"):
            held = 0.0
            while held < CAP_GB:
                r = json.loads(await c.eval(ALLOC % (METRICS, ARGS[1], 16), timeout=600))
                print(json.dumps(r), flush=True)
                held = r["heldGB"]
                if r["error"] or not r["made"]:
                    break
            else:
                print(f"stopped at the cap of {CAP_GB} GB without a refusal")
        elif mode == "alloc" and ARGS[1] == "wasm":
            print(await c.eval(WASM % METRICS, timeout=600))
        elif mode in ("layers", "docs"):
            w, h = (int(v) for v in ARGS[1].lower().split("x"))
            n = int(ARGS[2])
            for i in range(n):
                if mode == "docs" or i == 0:
                    print("document", await c.eval(DOC % (METRICS, w, h, "document"), timeout=1800), flush=True)
                print("layer   ", await c.eval(DOC % (METRICS, w, h, "layer"), timeout=1800), flush=True)
        else:
            raise SystemExit(__doc__)
    except Exception as err:  # noqa: BLE001
        print("ENDED:", str(err)[:600])
    print("RESULT measured")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(session(main))
