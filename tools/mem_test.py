"""Memory walk for the running app (docs/PERFORMANCE.md phase 6, docs/PHASE6_PLAN.md).

Start the app with a debugging port first (see tools/cdp.py), then:

    python tools/mem_test.py                  # 12000x8000, four rounds
    python tools/mem_test.py 6000x4000 --rounds 3
    python tools/mem_test.py --keep           # variant B: the tabs stay open

Every round builds one film-look document, benchmarks it, closes it and forces a
collection, and reports after each of those phases: the private bytes of the renderer
and of the GPU process, the canvases that are still alive (the test wraps
document.createElement before anything is built), what the editors say they hold
(InpaintEditor.memoryReport), the compositor's texture cache, the filter chain's surface
pool, and three timings - a pan frame, a levels slider tick, and a plain
canvas -> texture upload with its own context, which is the probe for an unaccelerated
canvas. `--keep` builds every round without closing anything and does the close / GC /
free columns once at the end.

Nothing is uploaded and no ComfyUI is needed. Start the app fresh for every run: the
whole point of the phase is that the numbers drift within a session.
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

ARGS = sys.argv[1:]
KEEP = "--keep" in ARGS
SIZE = next((a for a in ARGS if not a.startswith("-")), "12000x8000")
ROUNDS = 4
for i, a in enumerate(ARGS):
    if a == "--rounds" and i + 1 < len(ARGS):
        ROUNDS = int(ARGS[i + 1])

# The census hook has to be in place before anything is built, so this runs first and
# only once per page. `__mem.canvases` is a list of WeakRefs; the registry counts the
# ones the collector took.
SETUP = r"""
(async () => {
    if (!window.__mem) {
        const M = {
            shell: await import("./shell.js"),
            host: (await import("./editor/host.js")).host,
            GL: await import("./editor/inpaint_filters_gl.js"),
            docs: [],
            made: 0,
            collected: 0,
            canvases: [],
        };
        M.registry = new FinalizationRegistry(() => { M.collected++; });
        // where a canvas was made: the first frame of the stack that is not the hook
        // itself. A leaked canvas is worth nothing without the line that allocated it.
        const site = () => {
            const lines = String(new Error().stack || "").split(/\r?\n/).slice(2);
            for (const l of lines) {
                const m = l.match(/at\s+(?:async\s+)?([^\s(]+)?\s*\(?([^\s()]+:\d+:\d+)\)?/);
                if (!m) continue;
                const where = (m[2] || "").split("/").pop();
                if (/mem_test|<anonymous>/.test(where)) continue;
                return (m[1] || "?") + " " + where;
            }
            return "?";
        };
        // listeners on window / document that outlive the document that added them:
        // one of them is enough to keep a whole editor and its layer stack alive.
        M.listeners = [];
        const addL = EventTarget.prototype.addEventListener;
        const removeL = EventTarget.prototype.removeEventListener;
        EventTarget.prototype.addEventListener = function (type, fn, opts) {
            if (this === window || this === document) {
                M.listeners.push({ type, target: this === window ? "window" : "document", fn: new WeakRef(fn), site: site(), live: true });
            }
            return addL.call(this, type, fn, opts);
        };
        EventTarget.prototype.removeEventListener = function (type, fn, opts) {
            if (this === window || this === document) {
                for (let i = M.listeners.length - 1; i >= 0; i--) {
                    const e = M.listeners[i];
                    if (e.live && e.type === type && e.fn.deref() === fn) { e.live = false; break; }
                }
            }
            return removeL.call(this, type, fn, opts);
        };
        const orig = document.createElement.bind(document);
        document.createElement = function (tag, ...rest) {
            const el = orig(tag, ...rest);
            if (String(tag).toLowerCase() === "canvas") {
                M.made++;
                M.canvases.push({ ref: new WeakRef(el), site: site() });
                try { M.registry.register(el); } catch (_) { /* ignore */ }
            }
            return el;
        };
        window.__mem = M;
    }
    return 1;
})()
"""

# One round's document: the film-look stack of perf_test.py's BENCH, plus a levels
# filter layer on top - that is the layer whose slider tick is the symptom's own number.
BUILD = """
(async () => {
    const W = %(w)d, H = %(h)d;
    const M = window.__mem;
    const ed = M.shell.newDocument();
    M.shell.activate(ed);
    await new Promise((r) => setTimeout(r, 300));   // never requestAnimationFrame: a hidden window has none
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

    const base = paint(mk(W, H), 210, 60);
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "mem.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });

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
    const rw = Math.min(2048, Math.round(W / 3)), rh = Math.min(2048, Math.round(H / 3));
    const res = paint(mk(rw, rh), 20, 20);
    const resLayer = ed.addLayer({ name: "Result", kind: "result", canvas: res, x: Math.round(W / 4), y: Math.round(H / 4), w: rw, h: rh, dirty: true });
    resLayer.match = { strength: 60, source: "surroundings" };
    const { FILTERS } = await import("./editor/inpaint_filters.js");
    ed.addFilterLayer(FILTERS["film.look"] ? "film.look" : "grain");
    const lv = ed.addFilterLayer("levels");
    ed.markMatchChanged(resLayer);
    ed.renderLayers();
    ed.fitView();
    ed.draw();
    M.docs.push({ ed, levels: lv && lv.id });
    return JSON.stringify({ view: `${ed.canvas.width}x${ed.canvas.height}`, levels: !!lv, docs: M.docs.length });
})()
"""

# pan / levels: the interactive numbers of the newest document. Both are medians.
BENCH = """
(async () => {
    const M = window.__mem;
    const d = M.docs[M.docs.length - 1];
    const ed = d.ed;
    const bench = (fn, n) => {
        const ts = [];
        for (let i = 0; i < n; i++) { const a = performance.now(); fn(i); ts.push(performance.now() - a); }
        ts.sort((x, y) => x - y);
        return +ts[Math.floor(ts.length / 2)].toFixed(2);
    };
    ed.draw();
    const pan = bench((i) => { ed.view.x += (i % 2 ? -7 : 9); ed.view.y += 3; ed.draw(); }, 30);
    let levels = null;
    const lv = ed.layers.find((l) => l.id === d.levels);
    if (lv) {
        levels = bench((i) => {
            lv.params = { ...(lv.params || {}), gamma: 0.8 + (i % 5) * 0.1 };
            ed.filterPreview = lv.id;
            lv._fcache = null;
            lv._fcacheView = null;
            ed.uploaded.baseHash = null;
            ed.draw();
        }, 7);
        ed.filterPreview = null;
    }
    return JSON.stringify({ pan, levels });
})()
"""

# The upload probe (its own context, so nothing the editor caches can hide the cost):
# a fresh 2048x2048 canvas, painted, uploaded, gl.finish(). Well under a millisecond
# while Chromium accelerates 2D canvases; tens of milliseconds once it stops.
PROBE = """
(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 2048;
    const x = c.getContext("2d");
    x.fillStyle = "#3080c0";
    x.fillRect(0, 0, 2048, 2048);
    x.fillStyle = "#c04020";
    x.fillRect(100, 100, 800, 800);
    const g = document.createElement("canvas").getContext("webgl2");
    if (!g) return JSON.stringify({ upload: null });
    const tex = g.createTexture();
    g.bindTexture(g.TEXTURE_2D, tex);
    const t0 = performance.now();
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, c);
    g.finish();
    const ms = performance.now() - t0;
    g.deleteTexture(tex);
    const ext = g.getExtension("WEBGL_lose_context");
    if (ext) ext.loseContext();
    c.width = c.height = 0;
    return JSON.stringify({ upload: +ms.toFixed(2) });
})()
"""

# the two numbers the settle loop watches: the GPU process and the live canvases
SETTLE = """
(async () => {
    const m = await window.scumble.metrics();
    let kb = 0;
    for (const p of m.processes || []) if (p.type === "GPU") kb += p.privateKB || p.workingSetKB || 0;
    const M = window.__mem;
    const kept = [];
    let live = 0;
    for (const e of M.canvases) { const c = e.ref.deref(); if (!c) continue; kept.push(e); if (c.width) live++; }
    M.canvases = kept;
    return JSON.stringify({ gpuMB: Math.round(kb / 1024), live });
})()
"""

REPORT = """
(async () => {
    const M = window.__mem;
    const metrics = await window.scumble.metrics();
    let gpuKB = 0, rendererKB = 0, totalKB = 0;
    for (const p of metrics.processes || []) {
        const kb = p.privateKB || p.workingSetKB || 0;
        totalKB += kb;
        if (p.type === "GPU") gpuKB += kb;
        if (p.type === "Tab" || p.type === "renderer" || p.type === "Renderer") rendererKB = Math.max(rendererKB, kb);
    }
    const rp = metrics.renderer && metrics.renderer.process;
    if (rp && rp.private) rendererKB = rp.private;

    // the census: live canvases, their bytes, the ten biggest
    const kept = [];
    let live = 0, bytes = 0, zeroed = 0;
    const big = [];
    const bySite = new Map();
    for (const e of M.canvases) {
        const c = e.ref.deref();
        if (!c) continue;
        kept.push(e);
        if (!c.width || !c.height) { zeroed++; continue; }
        live++;
        const b = c.width * c.height * 4;
        bytes += b;
        big.push([c.width, c.height, b, e.site]);
        const s = bySite.get(e.site) || [0, 0];
        s[0]++; s[1] += b;
        bySite.set(e.site, s);
    }
    M.canvases = kept;
    big.sort((a, b) => b[2] - a[2]);
    const sites = [...bySite.entries()].map(([k, v]) => [k, v[0], v[1]]).sort((a, b) => b[2] - a[2]).slice(0, 12);

    const editors = M.host.editors();
    const reports = editors.map((ed) => (ed.memoryReport ? ed.memoryReport() : null)).filter(Boolean);
    const sumOf = (f) => reports.reduce((a, r) => a + (f(r) || 0), 0);
    const pool = M.GL.glPoolStats ? M.GL.glPoolStats() : null;
    // listeners still registered, grouped by the line that added them
    const byL = new Map();
    for (const e of M.listeners) {
        if (!e.live || !e.fn.deref()) continue;
        const k = e.target + " " + e.type + "  " + e.site;
        byL.set(k, (byL.get(k) || 0) + 1);
    }
    const listeners = [...byL.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    return JSON.stringify({
        gpuKB, rendererKB, totalKB,
        heapKB: metrics.renderer && metrics.renderer.heap ? metrics.renderer.heap.usedHeapSize : null,
        blinkKB: metrics.renderer && metrics.renderer.blink ? metrics.renderer.blink.allocated : null,
        resources: metrics.renderer && metrics.renderer.resources ? metrics.renderer.resources.images : null,
        census: { made: M.made, collected: M.collected, live, zeroed, bytes, big: big.slice(0, 8), sites },
        editors: editors.length,
        docs: M.docs.length,
        layerBytes: sumOf((r) => r.layers.bytes),
        pyramidBytes: sumOf((r) => r.pyramid.bytes),
        scratchBytes: sumOf((r) => r.scratch.bytes),
        undoBytes: sumOf((r) => r.undo.undo.rectBytes + r.undo.redo.rectBytes),
        undoHeldBytes: sumOf((r) => r.undo.undo.heldLayerBytes + r.undo.redo.heldLayerBytes),
        compositorBytes: sumOf((r) => r.compositor ? r.compositor.bytes + r.compositor.targetBytes : 0),
        compositorEntries: sumOf((r) => r.compositor ? r.compositor.entries : 0),
        objectBytes: sumOf((r) => r.objects ? r.objects.bytes : 0),
        poolBytes: pool ? pool.bytes : 0,
        poolHeldBytes: pool ? pool.heldBytes : 0,
        poolForeign: pool ? pool.foreign : 0,
        listeners,
        reports,
    });
})()
"""

CLOSE_LAST = """
(() => {
    const M = window.__mem;
    const d = M.docs.pop();
    if (d) M.shell.closeDocument(d.ed, { force: true });
    return JSON.stringify({ docs: M.docs.length, editors: M.host.editors().length });
})()
"""

CLOSE_ALL = """
(() => {
    const M = window.__mem;
    let n = 0;
    while (M.docs.length) { const d = M.docs.pop(); M.shell.closeDocument(d.ed, { force: true }); n++; }
    return JSON.stringify({ closed: n, editors: M.host.editors().length });
})()
"""

# Free VRAM: today a no-op for the caches (it only drops the ONNX sessions); after
# step 3 of the plan it is the escape hatch, so the column exists from the start.
FREE = """
(async () => {
    const M = window.__mem;
    let freed = 0;
    for (const ed of M.host.editors()) {
        if (ed.releaseCaches) freed += (await ed.releaseCaches({ deep: true })) || 0;
    }
    try { await M.host.editors()[0].freeHelperModels(); } catch (_) { /* no helpers */ }
    return JSON.stringify({ freed });
})()
"""

COLUMNS = [
    ("round", 6), ("phase", 9), ("rend MB", 9), ("GPU MB", 8), ("canvas n", 9), ("canvas MB", 10),
    ("comp MB", 8), ("pool MB", 8), ("undo MB", 8), ("pan ms", 8), ("levels ms", 10), ("upload ms", 10),
]


def mb(kb_or_bytes, kb=False):
    v = kb_or_bytes / 1024.0 if kb else kb_or_bytes / 1048576.0
    return f"{v:.0f}" if v >= 100 else f"{v:.1f}"


def head():
    line = "".join(f"%-{w}s" % name for name, w in COLUMNS)
    return line + "\n" + "-" * len(line)


def row(rnd, phase, r, bench):
    cells = [
        str(rnd), phase,
        mb(r["rendererKB"], kb=True), mb(r["gpuKB"], kb=True),
        str(r["census"]["live"]), mb(r["census"]["bytes"]),
        mb(r["compositorBytes"]), mb(r["poolBytes"]), mb(r["undoBytes"] + r["undoHeldBytes"]),
        f"{bench['pan']:.2f}" if bench.get("pan") is not None else "-",
        f"{bench['levels']:.2f}" if bench.get("levels") is not None else "-",
        f"{bench['upload']:.2f}" if bench.get("upload") is not None else "-",
    ]
    return "".join(f"%-{w}s" % c for c, (_, w) in zip(cells, COLUMNS))


async def collect(c):
    """
    A forced collection, then time for the GPU side of it. Releasing the shared image
    behind a collected canvas is asynchronous and the GPU process takes its time about
    it: measured on 2026-09-10, the same run reported 1.3 GB after one second and 8 GB
    after another, so the number is read until it stops falling.
    """
    try:
        await c.call("HeapProfiler.enable")
    except Exception:
        pass
    for _ in range(2):
        await c.call("HeapProfiler.collectGarbage")
        await asyncio.sleep(0.3)
    last = None
    for _ in range(12):
        await asyncio.sleep(1.0)
        now = json.loads(await c.eval(SETTLE))
        if last is not None and now["gpuMB"] >= last["gpuMB"] - 32 and now["live"] >= last["live"]:
            break
        last = now
        await c.call("HeapProfiler.collectGarbage")


async def probe(c):
    return json.loads(await c.eval(PROBE))


async def report(c, bench=None):
    """A report line: the metrics twice, one second apart, and the second one kept."""
    await c.eval(REPORT)
    await asyncio.sleep(1.0)
    r = json.loads(await c.eval(REPORT))
    b = dict(bench or {})
    b.update(await probe(c))
    return r, b


async def main():
    sys.stdout.reconfigure(encoding="utf-8")
    w, h = (int(v) for v in SIZE.lower().split("x"))
    lines = []
    detail = []
    benches = []

    async def run(c):
        await c.eval(SETUP)
        print(f"== {SIZE} ({w * h / 1e6:.0f} MP), {ROUNDS} rounds{', tabs kept open' if KEEP else ''}", flush=True)
        print(head())
        base_r, base_b = await report(c)
        print(row(0, "start", base_r, base_b), flush=True)
        lines.append(row(0, "start", base_r, base_b))

        for rnd in range(1, ROUNDS + 1):
            print(f"-- round {rnd}: building ...", flush=True)
            await c.eval(BUILD % {"w": w, "h": h}, timeout=900)
            bench = json.loads(await c.eval(BENCH, timeout=900))
            r, b = await report(c, bench)
            benches.append((rnd, b))
            out = row(rnd, "built", r, b)
            print(out, flush=True)
            lines.append(out)
            detail.append((rnd, "built", r))
            if KEEP:
                continue
            await c.eval(CLOSE_LAST)
            r, b = await report(c)
            out = row(rnd, "closed", r, b)
            print(out, flush=True)
            lines.append(out)
            await collect(c)
            r, b = await report(c)
            out = row(rnd, "gc", r, b)
            print(out, flush=True)
            lines.append(out)
            detail.append((rnd, "gc", r))

        if KEEP:
            await c.eval(CLOSE_ALL)
            r, b = await report(c)
            print(row(ROUNDS, "closed", r, b), flush=True)
            lines.append(row(ROUNDS, "closed", r, b))
            await collect(c)
            r, b = await report(c)
            print(row(ROUNDS, "gc", r, b), flush=True)
            lines.append(row(ROUNDS, "gc", r, b))
            detail.append((ROUNDS, "gc", r))

        await c.eval(FREE, timeout=300)
        await collect(c)
        r, b = await report(c)
        print(row(ROUNDS, "free", r, b), flush=True)
        lines.append(row(ROUNDS, "free", r, b))
        detail.append((ROUNDS, "free", r))
        logs = await c.logs()
        return base_r, r, detail, logs

    base_r, last, detail, logs = await session(run)

    print()
    print("what is still live at the end")
    print(f"  editors {last['editors']}, canvases made {last['census']['made']}, collected {last['census']['collected']}, "
          f"live {last['census']['live']} ({mb(last['census']['bytes'])} MB), zeroed {last['census']['zeroed']}")
    for w0, h0, b, where in last["census"]["big"]:
        print(f"    {w0} x {h0}  {mb(b)} MB   {where}")
    print("  listeners still on window / document, by the line that added them")
    for where, n in last["listeners"]:
        print(f"    {n:>4}  {where}")
    print("  live canvases by the line that made them")
    for where, n, b in last["census"]["sites"]:
        print(f"    {n:>4}  {mb(b):>7} MB  {where}")
    print(f"  layers {mb(last['layerBytes'])} MB, pyramid {mb(last['pyramidBytes'])} MB, scratch {mb(last['scratchBytes'])} MB, "
          f"undo {mb(last['undoBytes'])} MB (+{mb(last['undoHeldBytes'])} MB held), objects {mb(last['objectBytes'])} MB")
    print(f"  compositor {last['compositorEntries']} textures {mb(last['compositorBytes'])} MB, "
          f"pool {mb(last['poolBytes'])} MB (+{mb(last['poolHeldBytes'])} MB in scopes, {last['poolForeign']} foreign)")
    if last.get("resources"):
        img = last["resources"]
        print(f"  blink images {img.get('count')} live {mb(img.get('liveSize', 0))} MB of {mb(img.get('size', 0))} MB")

    print()
    print("targets (docs/PHASE6_PLAN.md §0)")
    dg = (last["gpuKB"] - base_r["gpuKB"]) / 1024.0
    print(f"  GPU process back within 300 MB of the baseline: {dg:+.0f} MB  {'PASS' if dg <= 300 else 'FAIL'}")
    if len(benches) > 1:
        first, last_b = benches[0][1], benches[-1][1]
        for key, label in (("pan", "pan"), ("levels", "levels tick"), ("upload", "canvas upload")):
            a, b = first.get(key), last_b.get(key)
            if not a or not b:
                continue
            drift = (b - a) / a * 100.0
            print(f"  {label} in the last round against the first: {a:.2f} -> {b:.2f} ms ({drift:+.0f} %)  "
                  f"{'PASS' if drift <= 20 else 'FAIL'}")

    interesting = [m for k, m in logs if "WebGL" in m or "context" in m or "memory watch" in m]
    if interesting:
        print()
        print("console lines about WebGL, contexts and the memory watch")
        for m in interesting[:20]:
            print("  " + m[:300])


if __name__ == "__main__":
    asyncio.run(main())
