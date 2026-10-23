"""W0 of docs/PLAN_WASM.md: the JS paths no other harness times, measured in the running app (2026-10-23).

No ComfyUI. Start the app offline with a debugging port and keep its window in front (V8's efficiency mode slows JS,
not wasm, in a window behind: docs/PERFORMANCE.md section 10):

    ./node_modules/.bin/electron . --remote-debugging-port=9555 --user-data-dir=<scratch> --no-comfy
    python tools/w0_bench.py [--json out.json] [--image=path/to/15k.jpg] [--rows=name,name]

Each row runs the module's own function on synthetic data of a stated size (a median of several runs where it is cheap)
or, for the 15k rows, the editor's command on the picture. It never fails the caller: a row that throws prints its
error and the rest go on. Rows:

  freqsep_15k         the 15k picture: load_image of the JPEG, export a 15k PNG, load_image of it (wall each), then
                      frequency_separation of a 4000 x 4000 box (its limit is 16 MP)
  edgefit_2048        edgefit.fitLayerRGBA on a 2048^2 base and a shifted copy; warpRGBA alone
  stitch_masks_2048   stitch.js gaussBlur (sigma 8) and dilate (8 px) on a 2048^2 mask, and the JS max / clamp around them
  crc32_64mb          inpaint_png.crc32 over 64 MB (ms per MB)
  dabs_256            inpaint_stroke blurRGBA / sharpenRGBA / toneRGBA / spongeRGBA on a 256^2 dab
  match_loop_4096     matchCanvas's CPU loop (the fallback when the shader is not there) on 4096^2
  histogram_depth     the editor's mapHistogram("depth") on a 4096 x 2731 depth map
"""
import asyncio
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMAGE = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--image=")), os.path.join(ROOT, "dist", "daily", "adobe_15000x10000.jpg"))
JSON_OUT = next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--json" and i + 1 < len(sys.argv)), None)
TMP = tempfile.mkdtemp(prefix="w0_bench_")

PRE = """(async () => {
    const commands = (await import('./commands.js')).commands;
    const host = (await import('./editor/host.js')).host;
    const run = (n, a) => commands.run(n, a || {});
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return +s[Math.floor(s.length / 2)].toFixed(2); };
    const time = async (fn, n = 5) => { const ts = []; for (let i = 0; i < n; i++) { const a = performance.now(); await fn(i); ts.push(performance.now() - a); } return { median: median(ts), max: +Math.max(...ts).toFixed(2), n }; };
    const noise = (n, seed = 7) => { const a = new Uint8ClampedArray(n); let s = seed >>> 0; for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; a[i] = s >>> 24; } return a; };
    const out = { visibility: document.visibilityState, focus: document.hasFocus() };
    try {
        %s
    } catch (e) { out.error = String((e && e.stack) || e).slice(0, 600); }
    return JSON.stringify(out);
})()"""

ROWS = {
    "edgefit_2048": """
        const E = await import('./editor/edgefit.js');
        const w = 2048, h = 2048;
        const base = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; base[i] = (x * 7 + y * 3) & 255; base[i + 1] = (x ^ y) & 255; base[i + 2] = ((x * y) >> 6) & 255; base[i + 3] = 255; }
        const layer = new Uint8ClampedArray(base.length);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const sx = Math.min(w - 1, x + 3), sy = Math.min(h - 1, y + 2); const s = (sy * w + sx) * 4, d = (y * w + x) * 4; layer[d] = base[s]; layer[d + 1] = base[s + 1]; layer[d + 2] = base[s + 2]; layer[d + 3] = (x > 200 && x < w - 200 && y > 200 && y < h - 200) ? 255 : 0; }
        out.fit = await time(() => E.fitLayerRGBA({ baseRGBA: base, layerRGBA: layer, w, h }), 3);
        out.warp = await time(() => E.warpRGBA(layer, w, h, [1, 0, 3, 0, 1, 2]), 3);
    """,
    "stitch_masks_2048": """
        const S = await import('./editor/stitch.js');
        const w = 2048, h = 2048, n = w * h;
        const mk = () => { const d = new Float32Array(n); for (let i = 0; i < n; i++) d[i] = ((i % w) > 512 && (i % w) < 1536 && i > n / 4 && i < 3 * n / 4) ? 1 : 0; return { data: d, w, h }; };
        out.gauss = await time(() => S.gaussBlur(mk(), 8), 3);
        out.dilate = await time(() => S.dilate(mk(), 8), 3);
        // the per-pixel JS around them (stitch.js maskMax + maskClamp, copied: they are not exported)
        const a = mk(), b = mk();
        out.max_clamp = await time(() => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = Math.max(a.data[i], b.data[i]); for (let i = 0; i < n; i++) o[i] = Math.min(1, Math.max(0, o[i])); return o; }, 3);
        out.mk = await time(() => mk(), 3);
        out.note = "gaussBlur and dilate run Rust (box_blurs, dilate_mask) and include the mask's build (mk, also timed); max_clamp is the JS loop of denoiseMask";
    """,
    "crc32_64mb": """
        const P = await import('./editor/inpaint_png.js');
        const buf = noise(64 * 1024 * 1024);
        const t = await time(() => P.crc32(buf), 3);
        out.crc = t; out.msPerMB = +(t.median / 64).toFixed(3);
    """,
    "dabs_256": """
        const K = await import('./editor/inpaint_stroke.js');
        const w = 256, h = 256, src = noise(w * h * 4, 11);
        const lut = new Uint8Array(256); for (let i = 0; i < 256; i++) lut[i] = Math.min(255, Math.round(i * 1.1));
        out.blur = await time(() => K.blurRGBA(src, w, h, 6), 20);
        out.sharpen = await time(() => K.sharpenRGBA(src, w, h, 6, 1), 20);
        out.tone = await time(() => K.toneRGBA(src, lut, false), 20);
        out.sponge = await time(() => K.spongeRGBA(src, 0.5, true, true), 20);
    """,
    "match_loop_4096": """
        const W = 4096, H = 4096, d = noise(W * H * 4, 5);
        const meanS = [120, 110, 100], meanT = [100, 105, 110], scale = [1.05, 0.95, 1.0], k = 0.6;
        const loop = () => { for (let i = 0; i < d.length; i += 4) { if (!d[i + 3]) continue; for (let ch = 0; ch < 3; ch++) { const v = (d[i + ch] - meanT[ch]) * scale[ch] + meanS[ch]; d[i + ch] = Math.max(0, Math.min(255, d[i + ch] + (v - d[i + ch]) * k)); } } };
        out.loop = await time(loop, 3);
        out.note = "matchCanvas's CPU loop body, copied (the function itself takes the shader path first); 16.8 MP";
    """,
    "histogram_depth": """
        const ed = host.editor;
        if (!ed) throw new Error("no editor");
        const { makeMap } = await import('./editor/inpaint_maps.js');
        const mw = 4096, mh = 2731, ramp = new Uint16Array(mw * mh);
        for (let i = 0; i < ramp.length; i++) ramp[i] = (i * 2654435761 >>> 16) & 65535;
        await ed.setMap("depth", makeMap("depth", mw, mh, ramp, [ed.width, 0, 0, ed.height, 0, 0]));
        out.hist = await time(() => ed.mapHistogram("depth"), 5);
    """,
    "freqsep_15k": """
        const doc = (await run("new_document")).id;
        const ed = host.editors().find((e) => e.node.id === doc);
        host.shell.activate(ed);
        let t = performance.now();
        await run("load_image", { doc, path: %(image)s });
        out.load_jpg = +(performance.now() - t).toFixed(0);
        out.size = [ed.width, ed.height];
        await wait(3000);
        // a 15k PNG of the composite, then opened again as a user's file
        t = performance.now();
        await run("export", { doc, format: "png", path: %(png)s });
        out.png_export = +(performance.now() - t).toFixed(0);
        const doc2 = (await run("new_document")).id;
        t = performance.now();
        await run("load_image", { doc: doc2, path: %(png)s });
        out.png_open = +(performance.now() - t).toFixed(0);
        try { await run("close_document", { doc: doc2, force: true }); } catch (_) {}
        host.shell.activate(ed);
        // frequency separation works on up to 16 MP: a 4000 x 4000 box of the 15k picture
        await run("select_rect", { doc, x: 5500, y: 3000, w: 4000, h: 4000 });
        t = performance.now();
        const r = await run("frequency_separation", { doc });
        out.freqsep_16mp = +(performance.now() - t).toFixed(0);
        out.freqsep_result = r ? Object.keys(r).slice(0, 6) : null;
        try { await run("close_document", { doc, force: true }); } catch (_) {}
    """,
}


async def main():
    results = {}

    async def go(c):
        await c.call("Page.bringToFront")
        await c.eval("(async () => { await import('./shell.js'); return 1; })()")
        only = next((a.split("=", 1)[1].split(",") for a in sys.argv if a.startswith("--rows=")), None)
        for name, body in ROWS.items():
            if only and name not in only:
                continue
            js = PRE % (body % {"image": json.dumps(IMAGE), "png": json.dumps(os.path.join(TMP, "w0_15k.png"))} if "%(" in body else body)
            print(f"== {name} ...", flush=True)
            try:
                raw = await c.eval(js, timeout=1800)
                val = json.loads(raw) if isinstance(raw, str) else raw
            except Exception as e:  # noqa: BLE001 - a row never stops the rest
                val = {"error": str(e)[:600]}
            results[name] = val
            print(f"   {json.dumps(val)}", flush=True)
    await session(go)
    if JSON_OUT:
        with open(JSON_OUT, "w", encoding="utf-8", newline=chr(10)) as f:
            json.dump(results, f, indent=1)
    print("RESULT")


if __name__ == "__main__":
    asyncio.run(main())
