"""Editor performance benchmark (docs/PERFORMANCE.md §7) against the running app.

Start the app with a debugging port first (see tools/cdp.py), then:

    python tools/perf_test.py                 # 2048x1152 and 6000x4000
    python tools/perf_test.py 12000x8000      # one size
    python tools/perf_test.py 2048x1152 6000x4000 12000x8000
    python tools/perf_test.py --chain         # the GPU filter chain, on against off

For every size it builds a synthetic document in its own tab (base image, three paint
layers, one result layer with colour match, one film look filter layer) and measures the
interactive paths: opacity / match / filter slider ticks, pan, wheel zoom, fit, a brush
stroke, the cached scene redraw (hover, marching ants), the full-resolution composite,
getValue after a selection change, and the undo step of a stroke. Times are milliseconds,
median of the repeats, max in brackets. No ComfyUI needed; nothing is uploaded.
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

CHAIN = "--chain" in sys.argv
SIZES = [a for a in sys.argv[1:] if not a.startswith("-")] or ["2048x1152", "6000x4000"]

SETUP = """
(async () => {
    window.__perf = { shell: await import("./shell.js"), host: (await import("./editor/host.js")).host };
    return 1;
})()
"""

# one JS body per size; `W` and `H` are substituted
BENCH = """
(async () => {
    const W = %(w)d, H = %(h)d;
    const shell = window.__perf.shell;
    const before = window.editor;
    const ed = shell.newDocument();
    shell.activate(ed);
    await new Promise((r) => setTimeout(r, 300));   // not requestAnimationFrame: it never fires while the window is hidden
    ed.resizeCanvas();
    if (ed.canvas.width < 400) throw new Error("the editor canvas has no size: " + ed.canvas.width + "x" + ed.canvas.height);

    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const paint = (c, hue, n) => {
        const x = c.getContext("2d");
        const g = x.createLinearGradient(0, 0, c.width, c.height);
        g.addColorStop(0, `hsl(${hue},70%%,45%%)`);
        g.addColorStop(1, `hsl(${(hue + 90) %% 360},70%%,25%%)`);
        x.fillStyle = g;
        x.fillRect(0, 0, c.width, c.height);
        x.globalAlpha = 0.7;
        for (let i = 0; i < n; i++) {
            x.fillStyle = `hsl(${(i * 37) %% 360},80%%,55%%)`;
            x.beginPath();
            x.arc((i * 977) %% c.width, (i * 613) %% c.height, Math.max(8, c.width / 40), 0, Math.PI * 2);
            x.fill();
        }
        x.globalAlpha = 1;
        return c;
    };

    // base: a canvas that looks like an <img> to the editor (no upload, no PNG encode)
    const base = paint(mk(W, H), 210, 60);
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    const t0 = performance.now();
    await ed.setBase({ filename: "perf.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
    const setBaseMs = performance.now() - t0;

    // three paint layers over the whole canvas
    for (let i = 0; i < 3; i++) {
        const c = mk(W, H);
        const x = c.getContext("2d");
        x.globalAlpha = 0.5;
        x.fillStyle = `hsla(${i * 60},80%%,50%%,0.35)`;
        x.fillRect(i * 40, i * 40, W - i * 120, H - i * 120);
        for (let k = 0; k < 20; k++) {
            x.fillStyle = `hsl(${(k * 53 + i * 90) %% 360},70%%,60%%)`;
            x.fillRect((k * 811) %% W, (k * 457) %% H, W / 25, H / 25);
        }
        ed.addLayer({ name: `Paint ${i + 1}`, kind: "paint", canvas: c, x: 0, y: 0, w: W, h: H, dirty: true });
    }
    // a result layer with colour match, like an inpaint result over the selection
    const rw = Math.min(2048, Math.round(W / 3)), rh = Math.min(2048, Math.round(H / 3));
    const res = paint(mk(rw, rh), 20, 20);
    const resLayer = ed.addLayer({ name: "Result", kind: "result", canvas: res, x: Math.round(W / 4), y: Math.round(H / 4), w: rw, h: rh, dirty: true });
    resLayer.match = { strength: 60, source: "surroundings" };
    // a film look on top (the plugin's filter when it is loaded, else grain)
    const { FILTERS } = await import("./editor/inpaint_filters.js");
    const fx = ed.addFilterLayer(FILTERS["film.look"] ? "film.look" : "grain");   // the film pack's look when the plugin is loaded
    const fxId = fx && fx.filter;
    ed.markMatchChanged(resLayer);
    ed.uploaded.baseHash = null;
    ed.renderLayers();
    ed.fitView();
    ed.draw();

    const bench = (fn, n) => {
        const ts = [];
        for (let i = 0; i < n; i++) {
            const a = performance.now();
            fn(i);
            ts.push(performance.now() - a);
        }
        ts.sort((x, y) => x - y);
        return [+ts[Math.floor(ts.length / 2)].toFixed(1), +ts[ts.length - 1].toFixed(1)];
    };
    const out = {};

    // --- slider ticks -----------------------------------------------------------
    const paintLayer = ed.layers[1];
    out.opacity_tick = bench((i) => {
        paintLayer.opacity = 0.5 + (i %% 5) * 0.08;
        ed.filterPreview = "*";
        ed.uploaded.baseHash = null;
        ed.uploaded.controlHash = null;
        ed.draw();
    }, 7);
    ed.filterPreview = null;
    out.match_tick = bench((i) => {
        resLayer.match = { strength: 40 + (i %% 5) * 8, source: "surroundings" };
        ed.markMatchChanged(resLayer);
        ed.uploaded.baseHash = null;
        ed.draw();
    }, 7);
    if (fx) {
        out.filter_tick = bench((i) => {
            const p = fx.params || {};
            if ("amount" in p) p.amount = 20 + (i %% 5) * 6; else p.strength = 20 + (i %% 5) * 6;
            ed.filterPreview = fx.id;
            fx._fcache = null;
            fx._fcacheView = null;
            ed.uploaded.baseHash = null;
            ed.draw();
        }, 7);
        ed.filterPreview = null;
    }

    // --- view gestures ----------------------------------------------------------
    out.pan = bench((i) => { ed.view.x += (i %% 2 ? -7 : 9); ed.view.y += 3; ed.draw(); }, 60);
    out.zoom = bench((i) => {
        const ns = Math.min(4, Math.max(0.05, ed.view.scale * (i %% 2 ? 1.25 : 0.8)));
        ed.view.x = ed.canvas.width / 2 - (ed.canvas.width / 2 - ed.view.x) * (ns / ed.view.scale);
        ed.view.y = ed.canvas.height / 2 - (ed.canvas.height / 2 - ed.view.y) * (ns / ed.view.scale);
        ed.view.scale = ns;
        ed.draw();
    }, 10);
    ed.fitView();
    out.fit = bench(() => ed.fitView(), 3);
    out.redraw_cached = bench(() => ed.draw(), 10);   // hover / marching ants: nothing changed

    // --- a brush stroke on a paint layer ---------------------------------------
    ed.setTool("paint");
    ed.activeLayerId = paintLayer.id;
    ed.brushSize = 40;
    const p = { kind: "layerpaint", layer: paintLayer, stroke: mk(W, H), clip: null, erase: false, last: [10, 10], pressure: 1 };
    ed.pointer = p;
    const strokeStart = performance.now();
    const dab = bench((i) => {
        const x = 100 + i * Math.max(4, W / 200), y = 100 + (i %% 7) * 20;
        ed.layerDab(p, p.last[0], p.last[1], x, y);
        p.last = [x, y];
        ed.draw();
    }, 60);
    out.stroke_frame = dab;
    const commitAt = performance.now();
    ed.commitStroke(p);
    ed.pointer = null;
    ed.markLayerChanged(paintLayer);
    out.stroke_commit = [+(performance.now() - commitAt).toFixed(1), +(performance.now() - strokeStart).toFixed(1)];
    out.undo_bytes = ed.undoBytes;
    const undoAt = performance.now();
    await ed.undoStep();
    out.undo_step = [+(performance.now() - undoAt).toFixed(1), 0];

    // --- selection, autosave, full composite ------------------------------------
    const selAt = performance.now();
    ed.selection.getContext("2d").fillStyle = "#ff0000";
    ed.selection.getContext("2d").fillRect(Math.round(W / 5), Math.round(H / 5), Math.round(W / 3), Math.round(H / 3));
    ed.markSelectionChanged([Math.round(W / 5), Math.round(H / 5), Math.round(W / 5 + W / 3), Math.round(H / 5 + H / 3)]);
    out.selection_change = [+(performance.now() - selAt).toFixed(1), 0];
    out.get_value = bench(() => ed.getValue(), 3);
    out.bounds_scan = bench(() => { ed.selectionDirty = true; ed.getBounds(); }, 3);
    out.draw_with_ants = bench(() => { ed.pixelVersion++; ed.draw(); }, 10);
    out.full_composite = bench(() => { ed.flatCache = null; ed.flattenToCanvas({ forRun: true }); }, 3);

    // --- operations that are not per frame: how long do they hold the main thread? -----
    // (sample it every millisecond and take the longest gap; wall time and blocking are
    // very different things once the worker does the work)
    const probe = () => {
        let last = performance.now(), worst = 0, stop = false;
        const tick = () => { const now = performance.now(); if (now - last > worst) worst = now - last; last = now; if (!stop) setTimeout(tick, 0); };
        setTimeout(tick, 0);
        return () => { stop = true; return +worst.toFixed(1); };
    };
    const op = async (fn) => {
        await new Promise((r) => setTimeout(r, 60));
        const done = probe();
        const t0 = performance.now();
        await fn();
        const wall = +(performance.now() - t0).toFixed(1);
        await new Promise((r) => setTimeout(r, 30));
        return [done(), wall];   // [blocked, wall]
    };
    const rect = () => {
        const s = ed.selection.getContext("2d");
        s.globalCompositeOperation = "source-over";
        s.clearRect(0, 0, W, H);
        s.fillStyle = "#ff0000";
        s.fillRect(Math.round(W * 0.2), Math.round(H * 0.2), Math.round(W * 0.4), Math.round(H * 0.4));
        ed.markSelectionChanged();
        ed.getBounds();
    };
    rect();
    out.grow = await op(() => ed.growSelection(16));
    out.shrink = await op(() => ed.growSelection(-16));
    out.invert = await op(() => ed.invertSelection());
    rect();
    out.feather = await op(() => ed.featherSelection(8));
    rect();
    out.wand = await op(() => ed.wandSelect(Math.round(W * 0.1), Math.round(H * 0.1), "replace"));
    rect();
    ed.activeLayerId = paintLayer.id;
    out.bucket = await op(() => ed.bucketFill(Math.round(W * 0.25), Math.round(H * 0.25)));
    const flat = ed.flattenToCanvas({ forRun: true });
    // the editor's own path (the worker when there is one), and the plain main-thread encode
    out.png = await op(async () => { const u = await ed.snapUrl(flat); URL.revokeObjectURL(u); });
    out.png_main = await op(() => new Promise((r) => flat.toBlob(r, "image/png")));

    let mem = null;
    try { mem = Math.round((await performance.measureUserAgentSpecificMemory()).bytes / 1048576); } catch (_) { /* needs isolation */ }

    const view = `${ed.canvas.width}x${ed.canvas.height}`;
    shell.closeDocument(ed, { force: true });
    if (before) shell.activate(before);
    return JSON.stringify({ size: `${W}x${H}`, mp: +(W * H / 1e6).toFixed(1), filter: fxId, setBase: Math.round(setBaseMs), memMB: mem, view, ...out });
})()
"""

ROWS = [
    ("opacity slider tick", "opacity_tick"),
    ("colour match tick", "match_tick"),
    ("filter slider tick", "filter_tick"),
    ("pan (60 frames)", "pan"),
    ("wheel zoom (10)", "zoom"),
    ("fit view", "fit"),
    ("redraw, nothing changed", "redraw_cached"),
    ("redraw with ants", "draw_with_ants"),
    ("brush dab + frame", "stroke_frame"),
    ("stroke commit (undo copy)", "stroke_commit"),
    ("undo step", "undo_step"),
    ("selection change", "selection_change"),
    ("getValue (autosave)", "get_value"),
    ("selection bounds scan", "bounds_scan"),
    ("full composite", "full_composite"),
]

# operations, not frames: [main thread blocked, wall time]
OP_ROWS = [
    ("grow +16", "grow"),
    ("shrink -16", "shrink"),
    ("invert", "invert"),
    ("feather 8", "feather"),
    ("magic wand", "wand"),
    ("bucket fill", "bucket"),
    ("PNG of the composite", "png"),
    ("the same without the worker", "png_main"),
]


# --- the GPU filter chain (docs/PERFORMANCE.md, phase 5 step 2) --------------------------
#
# One document, one stack of filter layers, panned once with the chain on and once with it
# off (ed.filterChainOff), plus the round trip counters from the GL module: `uploads` are
# canvas -> texture, `readbacks` texture -> canvas, and those are what the chain removes.
CHAIN_BENCH = """
(async () => {
    const W = %(w)d, H = %(h)d;
    const shell = window.__perf.shell;
    const GL = await import("./editor/inpaint_filters_gl.js");
    const { FILTERS } = await import("./editor/inpaint_filters.js");
    const before = window.editor;
    const ed = shell.newDocument();
    shell.activate(ed);
    await new Promise((r) => setTimeout(r, 300));
    ed.resizeCanvas();
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const base = mk(W, H);
    {
        const x = base.getContext("2d");
        const g = x.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "hsl(210,70%%,45%%)"); g.addColorStop(1, "hsl(300,70%%,25%%)");
        x.fillStyle = g; x.fillRect(0, 0, W, H);
        for (let i = 0; i < 60; i++) { x.fillStyle = `hsl(${(i * 37) %% 360},80%%,55%%)`; x.beginPath(); x.arc((i * 977) %% W, (i * 613) %% H, Math.max(8, W / 40), 0, Math.PI * 2); x.fill(); }
    }
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "perf.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });

    const bench = (fn, n) => { const ts = []; for (let i = 0; i < n; i++) { const a = performance.now(); fn(i); ts.push(performance.now() - a); } ts.sort((x, y) => x - y); return [+ts[Math.floor(ts.length / 2)].toFixed(1), +ts[ts.length - 1].toFixed(1)]; };
    const out = [];
    for (const stack of %(stacks)s) {
        const fx = [];
        for (const id of stack) if (FILTERS[id]) fx.push(ed.addFilterLayer(id));
        if (!fx.length) continue;
        ed.renderLayers(); ed.fitView(); ed.draw();
        const measure = (off) => {
            ed.filterChainOff = off;
            ed.draw();                       // warm this path (programs, pooled surfaces)
            GL.glChainStats(true);
            const n = 30;
            const pan = bench((i) => { ed.view.x += (i %% 2 ? -7 : 9); ed.view.y += 3; ed.draw(); }, n);
            const st = GL.glChainStats(true);
            return { pan, up: +(st.uploads / n).toFixed(1), down: +(st.readbacks / n).toFixed(1), passes: +(st.passes / n).toFixed(1) };
        };
        const chain = measure(false), plain = measure(true);
        ed.filterChainOff = false;
        out.push({ stack: fx.map((f) => f && f.filter), chain, plain });
        for (const f of fx) ed.removeLayer(f.id);
        ed.renderLayers();
    }
    const view = `${ed.canvas.width}x${ed.canvas.height}`;
    shell.closeDocument(ed, { force: true });
    if (before) shell.activate(before);
    return JSON.stringify({ size: `${W}x${H}`, view, rows: out });
})()
"""

STACKS = ("["
          '["invert"],'
          '["invert","invert","invert"],'
          '["invert","invert","invert","invert","invert"],'
          '["film.look"],'
          '["film.look","film.halation","grain"]'
          "]")


async def chain_main():
    async def run(c):
        await c.eval(SETUP)
        res = []
        for size in SIZES:
            w, h = (int(v) for v in size.lower().split("x"))
            print(f"== {size} ...", flush=True)
            res.append(json.loads(await c.eval(CHAIN_BENCH % {"w": w, "h": h, "stacks": STACKS}, timeout=900)))
        return res

    for r in await session(run):
        print()
        print(f"{r['size']} in a {r['view']} view - pan, milliseconds per frame (median [worst])")
        print("%-34s %-20s %-20s %s" % ("filter layers", "chain", "chain off", "round trips/frame"))
        print("-" * 96)
        for row in r["rows"]:
            name = "+".join(x.replace("film.", "") for x in row["stack"])
            c, p = row["chain"], row["plain"]
            print("%-34s %-20s %-20s %s" % (
                name,
                f"{c['pan'][0]:.1f} [{c['pan'][1]:.1f}]",
                f"{p['pan'][0]:.1f} [{p['pan'][1]:.1f}]",
                f"{c['up']:.0f} up {c['down']:.0f} down  vs  {p['up']:.0f} up {p['down']:.0f} down"))


async def main():
    async def run(c):
        await c.eval(SETUP)
        results = []
        for size in SIZES:
            w, h = (int(v) for v in size.lower().split("x"))
            print(f"== {size} ({w * h / 1e6:.1f} MP) ...", flush=True)
            js = BENCH % {"w": w, "h": h}
            results.append(json.loads(await c.eval(js, timeout=900)))
        return results

    results = await session(run)
    head = "%-28s" % "" + "".join("%22s" % r["size"] for r in results)
    print()
    print(head)
    print("-" * len(head))
    for label, key in ROWS:
        cells = []
        for r in results:
            v = r.get(key)
            cells.append("%22s" % ("-" if not v else f"{v[0]:.1f} ms  [{v[1]:.1f}]"))
        print("%-28s%s" % (label, "".join(cells)))
    print()
    print("%-28s%s" % ("operations, blocked [wall]", ""))
    print("-" * len(head))
    for label, key in OP_ROWS:
        cells = []
        for r in results:
            v = r.get(key)
            cells.append("%22s" % ("-" if not v else f"{v[0]:.0f} ms  [{v[1]:.0f}]"))
        print("%-28s%s" % (label, "".join(cells)))
    print()
    for r in results:
        print("%-28s%s" % (r["size"], f"view {r['view']}, filter {r['filter']}, undo {r['undo_bytes'] / 1048576:.1f} MB"
              + (f", renderer {r['memMB']} MB" if r.get("memMB") else "")))


if __name__ == "__main__":
    asyncio.run(chain_main() if CHAIN else main())
