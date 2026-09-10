"""Pixel reference test for the editor's compositing (docs/PERFORMANCE.md §7).

The acceptance gate for phase 5: the GPU paths have to produce the same picture Canvas 2D
does. The test builds a deterministic document with every blend mode, a masked layer, a
colour-matched layer, a filter layer and text, renders the full-resolution composite and
the on-screen view and compares both against stored references, then compares the two GPU
paths against their Canvas 2D twin in the same run: the filter chain (step 2, a stack of
filter layers that hand their result on as a texture) and the compositor (step 1).

    python tools/composite_test.py                # compare against tools/refs/
    python tools/composite_test.py --update       # write the references (do this on a
                                                  # known-good build, and look at them)
    python tools/composite_test.py --tolerance 3  # allow that many levels of difference

Needs the app on the debugging port (see tools/cdp.py). No ComfyUI, nothing is uploaded.
The references are PNGs in tools/refs/, small enough to keep in git.
"""
import argparse
import asyncio
import base64
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

REFS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "refs")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "dist", "composite")

# One deterministic document, rendered two ways. Everything is drawn from fixed numbers:
# no Math.random, no fonts beyond the editor's default, no time-dependent values.
BUILD = """
(async () => {
    const shell = await import("./shell.js");
    const W = 900, H = 600;
    window.__cmpBefore = window.editor;
    const ed = shell.newDocument();
    shell.activate(ed);
    await new Promise((r) => setTimeout(r, 300));
    ed.resizeCanvas();
    window.__cmp = ed;

    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    // base: a gradient with hard shapes, so blend modes have something to bite on
    const base = mk(W, H);
    {
        const x = base.getContext("2d");
        const g = x.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "#12305a"); g.addColorStop(0.5, "#8a6a3a"); g.addColorStop(1, "#d8d0c0");
        x.fillStyle = g; x.fillRect(0, 0, W, H);
        for (let i = 0; i < 12; i++) {
            x.fillStyle = `hsl(${i * 30},70%,${30 + (i % 4) * 12}%)`;
            x.fillRect(20 + i * 70, 40 + (i % 3) * 90, 60, 120);
        }
        x.fillStyle = "#000"; x.fillRect(0, H - 60, W, 30);
        x.fillStyle = "#fff"; x.fillRect(0, H - 30, W, 30);
    }
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "composite_ref.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });

    // one small layer per blend mode, laid out in a row, each half opaque
    const modes = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "soft-light", "hard-light", "difference"];
    modes.forEach((mode, i) => {
        const w = 90, h = 200;
        const c = mk(w, h);
        const x = c.getContext("2d");
        const g = x.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, "#ff5020"); g.addColorStop(0.5, "#20ff80"); g.addColorStop(1, "#3050ff");
        x.fillStyle = g; x.fillRect(0, 0, w, h);
        x.fillStyle = "rgba(255,255,255,0.85)"; x.fillRect(10, 20, 30, 60);
        x.fillStyle = "rgba(0,0,0,0.85)"; x.fillRect(50, 120, 30, 60);
        const l = ed.addLayer({ name: "blend " + mode, kind: "paint", canvas: c, x: 10 + i * 98, y: 30, w, h, dirty: true });
        l.blend = mode;
        l.opacity = 0.75;
    });

    // a masked layer: the mask is a gradient, so partial alpha is covered
    {
        const c = mk(300, 200);
        const x = c.getContext("2d");
        x.fillStyle = "#ffcc33"; x.fillRect(0, 0, 300, 200);
        x.fillStyle = "#33224a"; x.fillRect(20, 20, 120, 160);
        const l = ed.addLayer({ name: "masked", kind: "paint", canvas: c, x: 60, y: 300, w: 300, h: 200, dirty: true });
        // the mask works through its alpha (drawn with destination-in), not its luminance
        const m = mk(300, 200);
        const mx = m.getContext("2d");
        const mg = mx.createLinearGradient(0, 0, 300, 0);
        mg.addColorStop(0, "rgba(255,255,255,0)"); mg.addColorStop(1, "rgba(255,255,255,1)");
        mx.fillStyle = mg; mx.fillRect(0, 0, 300, 200);
        mx.fillStyle = "rgba(255,255,255,1)"; mx.fillRect(200, 140, 80, 50);
        l.mask = m;
        l.maskDirty = true;
        ed.markMaskChanged(l);
    }

    // a colour-matched result layer, like an inpaint result over its surroundings
    {
        const c = mk(260, 180);
        const x = c.getContext("2d");
        const g = x.createRadialGradient(130, 90, 10, 130, 90, 130);
        g.addColorStop(0, "#f0e0b0"); g.addColorStop(1, "#204020");
        x.fillStyle = g; x.fillRect(0, 0, 260, 180);
        const l = ed.addLayer({ name: "matched", kind: "result", canvas: c, x: 430, y: 320, w: 260, h: 180, dirty: true });
        l.match = { strength: 70, source: "surroundings" };
        ed.markMatchChanged(l);
    }

    // a text layer (the editor's default font, fixed size)
    {
        const c = mk(320, 90);
        const x = c.getContext("2d");
        x.fillStyle = "#ffffff";
        x.font = "600 56px system-ui, sans-serif";
        x.textBaseline = "top";
        x.fillText("Scumble", 6, 6);
        ed.addLayer({ name: "text", kind: "paint", canvas: c, x: 540, y: 60, w: 320, h: 90, dirty: true });
    }

    // A filter layer on top. Grain seeds its noise field from the layer id, which differs
    // per session, so the id is pinned here: without that no two runs match.
    const fx = ed.addFilterLayer("grain");
    if (fx) {
        fx.params = { ...(fx.params || {}), amount: 35, size: 2, speckle: 25, chroma: 0 };
        fx.opacity = 0.9;
        fx.id = "composite-ref-grain";
        fx._fcache = null;
        fx._fcacheView = null;
        ed.activeLayerId = fx.id;
    }

    // a selection, so its overlay and the crop frame are part of the view reference.
    // Tint, not marching ants: the ants walk with the clock and would never compare equal.
    const sctx = ed.selection.getContext("2d");
    sctx.fillStyle = "#ff0000";
    sctx.fillRect(120, 120, 400, 260);
    ed.markSelectionChanged([120, 120, 520, 380]);
    ed.selectionDisplay = "tint";

    ed.uploaded.baseHash = null;
    ed.filterPreview = null;
    ed.flatCache = null;
    ed.sceneSig = null;
    ed.renderLayers();
    ed.view = { scale: 1, x: 40, y: 30, angle: 0 };
    ed.draw();
    return { w: ed.width, h: ed.height, layers: ed.layers.length };
})()
"""

# the full-resolution composite, exactly what an export or a run sees
FULL = """
(async () => {
    const ed = window.__cmp;
    ed.flatCache = null;
    const c = ed.flattenToCanvas({ forRun: false });
    return c.toDataURL("image/png").slice("data:image/png;base64,".length);
})()
"""

# the on-screen view: viewport composite, overlays, marching ants, crop frame
VIEW = """
(async () => {
    const ed = window.__cmp;
    ed.sceneSig = null;
    ed.draw();
    await new Promise((r) => setTimeout(r, 120));
    const c = document.createElement("canvas");
    c.width = Math.min(1200, ed.canvas.width);
    c.height = Math.min(800, ed.canvas.height);
    c.getContext("2d").drawImage(ed.canvas, 0, 0, c.width, c.height, 0, 0, c.width, c.height);
    return c.toDataURL("image/png").slice("data:image/png;base64,".length);
})()
"""

# The phase 5 gate: the same view drawn by the GPU compositor and by Canvas 2D, in one run.
# The filter layer is hidden because the filter chain still goes through Canvas 2D, and a
# stroke or a transform would too - see glCompositeUsable.
GL_VS_2D = """
(async () => {
    const ed = window.__cmp;
    const fx = ed.layers.find((l) => l.kind === "filter");
    if (fx) fx.visible = false;
    const shot = () => {
        ed.sceneSig = null;
        ed.flatCache = null;
        ed.draw();
        const c = document.createElement("canvas");
        c.width = ed.canvas.width; c.height = ed.canvas.height;
        c.getContext("2d").drawImage(ed.canvas, 0, 0);
        return c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    };
    ed.compositorOff = true;
    const cpu = shot();
    ed.compositorOff = false;
    const used = ed.glCompositeUsable({});
    const t0 = performance.now();
    const gpu = shot();
    const ms = +(performance.now() - t0).toFixed(2);
    if (fx) fx.visible = true;
    ed.compositorOff = false;
    if (!used) return { skipped: "the compositor would not take this stack" };
    // premultiplied values: that is what reaches the screen
    let max = 0, sum = 0, n = 0, over = 0;
    for (let i = 0; i < cpu.length; i += 4) {
        const aa = cpu[i + 3], ba = gpu[i + 3];
        let d = Math.abs(aa - ba);
        for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(cpu[i + k] * aa / 255 - gpu[i + k] * ba / 255));
        if (d > max) max = d;
        if (d > 2) over++;
        sum += d; n++;
    }
    return { max: +max.toFixed(2), mean: +(sum / n).toFixed(4), pixelsOver2: over, pixels: n, ms };
})()
"""

# The phase 5 step 2 gate: a stack of filter layers rendered with the GPU filter chain (the
# result of one filter stays a texture for the next) and with it switched off, in one run.
# The two paths must agree; where they cannot is the 8-bit premultiplied storage of a canvas
# against the straight RGBA8 of a texture, which only shows below full alpha.
FILTER_CHAIN = """
(async () => {
    const ed = window.__cmp;
    const { FILTERS } = await import("./editor/inpaint_filters.js");
    // A realistic stack on top of the reference document. Ids are pinned: grain seeds its
    // field from the layer id, so without that no two runs match.
    const want = [["film.look", "chain-look", { preset: "portra400" }], ["film.halation", "chain-hal", null], ["grain", "chain-grain", { amount: 30, size: 2 }]];
    const added = [];
    for (const [type, id, params] of want) {
        if (!FILTERS[type]) continue;
        const l = ed.addFilterLayer(type);
        if (!l) continue;
        l.id = id;
        if (params) l.params = { ...(l.params || {}), ...params };
        added.push(l);
    }
    if (added.length < 2) return { skipped: "not enough filter types for a stack" };
    const clear = () => { for (const l of ed.layers) { l._fcache = null; l._fcacheView = null; l._fxCache = null; l._fxCacheView = null; } };
    const view = (off) => {
        ed.filterChainOff = off;
        clear();
        ed.sceneSig = null;
        ed.flatCache = null;
        ed.draw();
        const c = document.createElement("canvas");
        c.width = ed.canvas.width; c.height = ed.canvas.height;
        c.getContext("2d").drawImage(ed.canvas, 0, 0);
        return c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    };
    const full = (off) => {
        ed.filterChainOff = off;
        clear();
        ed.flatCache = null;
        const c = ed.flattenToCanvas({ forRun: true });
        return c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    };
    const diff = (a, b) => {
        let max = 0, sum = 0, over = 0;
        for (let i = 0; i < a.length; i++) {
            const d = Math.abs(a[i] - b[i]);
            if (d > max) max = d;
            if (d > 2) over++;
            sum += d;
        }
        return { max, mean: +(sum / a.length).toFixed(4), over2: over, samples: a.length };
    };
    const t0 = performance.now();
    const chained = view(false);
    const msChain = +(performance.now() - t0).toFixed(2);
    const t1 = performance.now();
    const plain = view(true);
    const msPlain = +(performance.now() - t1).toFixed(2);
    const v = diff(plain, chained);
    const f = diff(full(true), full(false));

    // The same stack again with the chain broken in the middle: the first filter layer is
    // half transparent on a blend mode and the second carries a mask, so both have to be
    // composited onto the canvas and the chain has to be flushed underneath them.
    added[0].opacity = 0.6;
    added[0].blend = "multiply";
    if (added[1]) {
        const m = document.createElement("canvas");
        m.width = ed.width; m.height = ed.height;
        const mx = m.getContext("2d");
        const mg = mx.createLinearGradient(0, 0, ed.width, 0);
        mg.addColorStop(0, "rgba(255,255,255,0)"); mg.addColorStop(1, "rgba(255,255,255,1)");
        mx.fillStyle = mg; mx.fillRect(0, 0, ed.width, ed.height);
        added[1].mask = m;
        added[1].maskDirty = true;
        ed.markMaskChanged(added[1]);
    }
    ed.renderLayers();
    const mixedView = diff(view(true), view(false));
    const mixedFull = diff(full(true), full(false));

    ed.filterChainOff = false;
    for (const l of added) ed.removeLayer(l.id);
    ed.flatCache = null;
    ed.sceneSig = null;
    return { layers: added.map((l) => l.filter), view: v, full: f, mixedView, mixedFull, msChain, msPlain };
})()
"""

CLOSE = """
(async () => {
    const shell = await import("./shell.js");
    if (window.__cmp) shell.closeDocument(window.__cmp, { force: true });
    if (window.__cmpBefore) shell.activate(window.__cmpBefore);
    window.__cmp = null;
    return 1;
})()
"""


def compare(a_png, b_png):
    """Max and mean absolute difference per channel between two PNGs of the same size."""
    try:
        from PIL import Image
    except ImportError:
        return None
    a = Image.open(io.BytesIO(a_png)).convert("RGBA")
    b = Image.open(io.BytesIO(b_png)).convert("RGBA")
    if a.size != b.size:
        return {"size": (a.size, b.size), "max": 255, "mean": 255.0, "differing": -1}
    da, db = a.tobytes(), b.tobytes()
    worst = 0
    total = 0
    differing = 0
    for x, y in zip(da, db):
        d = abs(x - y)
        if d:
            differing += 1
            total += d
            if d > worst:
                worst = d
    return {"max": worst, "mean": total / max(1, len(da)), "differing": differing, "bytes": len(da)}


async def run(c, args):
    os.makedirs(REFS, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    info = await c.eval(BUILD, timeout=120)
    print("document:", info)
    ok = True
    try:
        for name, js in (("full", FULL), ("view", VIEW)):
            data = base64.b64decode(await c.eval(js, timeout=300))
            cur = os.path.join(OUT, f"{name}.png")
            with open(cur, "wb") as f:
                f.write(data)
            ref = os.path.join(REFS, f"composite_{name}.png")
            if args.update or not os.path.exists(ref):
                with open(ref, "wb") as f:
                    f.write(data)
                print(f"[ref] {name}: written ({len(data)} bytes) -> {ref}")
                continue
            with open(ref, "rb") as f:
                want = f.read()
            diff = compare(want, data)
            if diff is None:
                print(f"[skip] {name}: Pillow missing, cannot compare (wrote {cur})")
                continue
            if diff.get("differing", 0) == 0:
                print(f"[ok] {name}: identical")
            elif diff["max"] <= args.tolerance:
                print(f"[ok] {name}: max {diff['max']} levels, mean {diff['mean']:.3f} (within {args.tolerance})")
            else:
                ok = False
                print(f"[FAIL] {name}: max {diff['max']} levels, mean {diff['mean']:.3f}, "
                      f"{diff['differing']} of {diff['bytes']} bytes differ. Current: {cur}, reference: {ref}")
        # the GPU filter chain against the canvas round trips, same document, same run
        fc = await c.eval(FILTER_CHAIN, timeout=300)
        if fc.get("skipped"):
            print(f"[skip] filter chain: {fc['skipped']}")
        else:
            worst = max(fc["view"]["max"], fc["full"]["max"], fc["mixedView"]["max"], fc["mixedFull"]["max"])
            line = (f"filter chain {'+'.join(fc['layers'])}: view max {fc['view']['max']} mean {fc['view']['mean']}, "
                    f"full max {fc['full']['max']} mean {fc['full']['mean']}, "
                    f"with opacity/blend/mask max {max(fc['mixedView']['max'], fc['mixedFull']['max'])}, "
                    f"draw {fc['msChain']} ms vs {fc['msPlain']} ms")
            if worst <= args.tolerance:
                print(f"[ok] {line}")
            else:
                ok = False
                print(f"[FAIL] {line}")
        # the GPU compositor against Canvas 2D, same document, same run
        gl = await c.eval(GL_VS_2D, timeout=300)
        if gl.get("skipped"):
            print(f"[skip] gpu vs 2d: {gl['skipped']}")
        elif gl["max"] <= args.tolerance:
            print(f"[ok] gpu vs 2d: max {gl['max']} levels, mean {gl['mean']}, "
                  f"{gl['pixelsOver2']} of {gl['pixels']} pixels over 2, draw {gl['ms']} ms")
        else:
            ok = False
            print(f"[FAIL] gpu vs 2d: max {gl['max']} levels, mean {gl['mean']}, "
                  f"{gl['pixelsOver2']} of {gl['pixels']} pixels over 2 levels")
    finally:
        await c.eval(CLOSE)
    print("PASS" if ok else "FAIL")
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--update", action="store_true", help="write the references instead of comparing")
    ap.add_argument("--tolerance", type=int, default=2, help="largest allowed difference per channel (default 2)")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(lambda c: run(c, args))) else 1)


if __name__ == "__main__":
    main()
