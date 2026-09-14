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
    const { Layer: LayerPixels, Mask: MaskPixels } = ed.pixels;   // the editor's backend (tiles or canvases)

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
        const l = ed.addLayer({ name: "blend " + mode, kind: "paint", px: LayerPixels.fromCanvas(c), x: 10 + i * 98, y: 30, w, h, dirty: true });
        l.blend = mode;
        l.opacity = 0.75;
    });

    // a masked layer: the mask is a gradient, so partial alpha is covered
    {
        const c = mk(300, 200);
        const x = c.getContext("2d");
        x.fillStyle = "#ffcc33"; x.fillRect(0, 0, 300, 200);
        x.fillStyle = "#33224a"; x.fillRect(20, 20, 120, 160);
        const l = ed.addLayer({ name: "masked", kind: "paint", px: LayerPixels.fromCanvas(c), x: 60, y: 300, w: 300, h: 200, dirty: true });
        // the mask works through its alpha (drawn with destination-in), not its luminance
        const m = mk(300, 200);
        const mx = m.getContext("2d");
        const mg = mx.createLinearGradient(0, 0, 300, 0);
        mg.addColorStop(0, "rgba(255,255,255,0)"); mg.addColorStop(1, "rgba(255,255,255,1)");
        mx.fillStyle = mg; mx.fillRect(0, 0, 300, 200);
        mx.fillStyle = "rgba(255,255,255,1)"; mx.fillRect(200, 140, 80, 50);
        l.maskPx = MaskPixels.fromCanvas(m);
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
        const l = ed.addLayer({ name: "matched", kind: "result", px: LayerPixels.fromCanvas(c), x: 430, y: 320, w: 260, h: 180, dirty: true });
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
        ed.addLayer({ name: "text", kind: "paint", px: LayerPixels.fromCanvas(c), x: 540, y: 60, w: 320, h: 90, dirty: true });
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
    ed.sel.drawInto(null, (sctx) => {
        sctx.fillStyle = "#ff0000";
        sctx.fillRect(120, 120, 400, 260);
    });
    ed.markSelectionChanged([120, 120, 520, 380]);
    ed.selectionDisplay = "tint";

    ed.uploaded.baseHash = null;
    ed.filterPreview = null;
    ed.flatCache = null;
    ed.sceneSig = null;
    ed.renderLayers();
    ed.view = { scale: 1, x: 40, y: 30, angle: 0 };
    ed.draw();
    await ed.mipsSettled();   // C6 b: no mip chain of the whole changes above still on its way to the screen
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
    await ed.mipsSettled();
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
# Two things the step is careful about, both of which hid a bug until 2026-09-10: the colour
# match's statistics are dropped before every shot, so each path takes them off its own
# backdrop instead of inheriting the other's cache, and a layer is erased into beforehand
# the way the eraser commits a stroke (a rectangle touch that keeps the cached levels), so a
# stale texture in the compositor's cache shows up as a difference.
GL_VS_2D = """
(async () => {
    const ed = window.__cmp;
    await ed.mipsSettled();
    const fx = ed.layers.find((l) => l.kind === "filter");
    if (fx) fx.visible = false;
    const shot = () => {
        for (const l of ed.layers) ed.markMatchChanged(l);
        ed.sceneSig = null;
        ed.flatCache = null;
        ed.draw();
        const c = document.createElement("canvas");
        c.width = ed.canvas.width; c.height = ed.canvas.height;
        c.getContext("2d").drawImage(ed.canvas, 0, 0);
        return c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    };
    // the GPU path first, so its textures are uploaded, then the erase
    ed.compositorOff = false;
    ed.sceneSig = null;
    ed.draw();
    const victim = ed.layers.find((l) => l.kind === "paint" && !l.maskPx && l.visible && !l.maskEdit);
    if (victim) {
        const w = Math.max(4, Math.round(victim.px.width * 0.5));
        const h = Math.max(4, Math.round(victim.px.height * 0.5));
        victim.px.drawInto([2, 2, 2 + w, 2 + h], (cx) => {
            cx.globalCompositeOperation = "destination-out";
            cx.fillStyle = "#000";
            cx.fillRect(2, 2, w, h);
        });
        ed.markLayerChanged(victim, [2, 2, 2 + w, 2 + h]);
    }
    const round = () => {
        ed.compositorOff = true;
        const cpu = shot();
        ed.compositorOff = false;
        const used = ed.glCompositeUsable({});
        const t0 = performance.now();
        const gpu = shot();
        const ms = +(performance.now() - t0).toFixed(2);
        if (!used) return null;
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
    };
    const view = round();
    // and at 1:1, where neither path resamples: the tile compositor draws level 0 texel for texel,
    // so it has to agree with Canvas 2D there whatever the mips do at a zoom (C3)
    const was = { scale: ed.view.scale, x: ed.view.x, y: ed.view.y };
    ed.view.scale = 1;
    ed.view.x = Math.round(ed.canvas.width / 2 - ed.width / 2);
    ed.view.y = Math.round(ed.canvas.height / 2 - ed.height / 2);
    for (let i = 0; i < 4; i++) shot();
    const atOne = round();
    ed.view.scale = was.scale; ed.view.x = was.x; ed.view.y = was.y;
    if (fx) fx.visible = true;
    ed.compositorOff = false;
    if (!view || !atOne) return { skipped: "the compositor would not take this stack" };
    return { ...view, atOne, tiles: !!ed.tileMode, erased: !!victim };
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
    const { Mask: MaskPixels } = ed.pixels;
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
        added[1].maskPx = MaskPixels.fromCanvas(m);
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



# Phase A item 4 (docs/PLAN_TILES.md): a source above 16 MP is not uploaded whole. The
# compositor keeps a window of it around what the view shows; the picture has to agree with
# Canvas 2D at 1:1, after a pan beyond the window's margin, after a dab into the layer (a
# new version of the same window) and at the picture's corner (the window clamped), and a
# pan inside the margin must not upload anything.
WINDOW = """
(async () => {
    const shell = await import("./shell.js");
    const W = 6000, H = 4000;   // 24 MP: above the compositor's WINDOW_PX
    const before = window.editor;
    const ed = shell.newDocument();
    shell.activate(ed);
    await new Promise((r) => setTimeout(r, 300));
    ed.resizeCanvas();
    const { pixelsOptions } = await import("./editor/inpaint_pixels.js");
    const { Layer: LayerPixels } = ed.pixels;
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const base = mk(W, H);
    { const x = base.getContext("2d"); const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#1c4f8a"); g.addColorStop(1, "#8a1c4f"); x.fillStyle = g; x.fillRect(0, 0, W, H); for (let i = 0; i < 300; i++) { x.fillStyle = `hsl(${(i * 37) % 360},70%,55%)`; x.fillRect((i * 977) % W, (i * 613) % H, 120, 90); } }
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "window.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
    const lc = mk(W, H);
    { const x = lc.getContext("2d"); x.globalAlpha = 0.6; for (let k = 0; k < 200; k++) { x.fillStyle = `hsl(${(k * 53) % 360},80%,60%)`; x.beginPath(); x.arc((k * 811) % W, (k * 457) % H, 80, 0, Math.PI * 2); x.fill(); } }
    const layer = ed.addLayer({ name: "Dots", kind: "paint", px: LayerPixels.fromCanvas(lc), x: 0, y: 0, w: W, h: H, dirty: true, blend: "screen", opacity: 0.9 });
    ed.renderLayers();
    if (!ed.compositor()) { shell.closeDocument(ed, { force: true }); if (before) shell.activate(before); return { skipped: "no compositor" }; }
    ed.view.scale = 1; ed.view.angle = 0;
    ed.view.x = Math.round(ed.canvas.width / 2 - W / 2); ed.view.y = Math.round(ed.canvas.height / 2 - H / 2);
    const shot = () => { ed.sceneSig = null; ed.flatCache = null; ed.draw(); const c = mk(ed.canvas.width, ed.canvas.height); c.getContext("2d").drawImage(ed.canvas, 0, 0); return c.getContext("2d").getImageData(0, 0, c.width, c.height).data; };
    const diff = (a, b) => { let max = 0, sum = 0, over = 0; for (let i = 0; i < a.length; i += 4) { const aa = a[i + 3], ba = b[i + 3]; let d = Math.abs(aa - ba); for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i + k] * aa / 255 - b[i + k] * ba / 255)); if (d > max) max = d; if (d > 2) over++; sum += d; } return { max: +max.toFixed(2), mean: +(sum / (a.length / 4)).toFixed(4), over }; };
    const out = { view: [ed.canvas.width, ed.canvas.height], pixelsCopy: !!pixelsOptions().copy };
    const compare = async (label) => {
        // C6 b: both paths read the exact mips, not whatever is still on its way from the mips worker
        await ed.mipsSettled(); shot(); await ed.mipsSettled();
        ed.compositorOff = true; const cpu = shot();
        ed.compositorOff = false; const used = ed.glCompositeUsable({}); const gpu = shot();
        out[label] = { ...diff(cpu, gpu), used };
    };
    const stats = () => ed.compositor().stats();
    // the uploads of either path: a window of a source canvas, or the tiles of an atlas slot
    const up = () => { const s = stats(); return s.windowUploads + s.atlas.uploads; };
    out.tiles = !!ed.tileMode;
    await compare("at1to1");
    const st0 = stats();
    out.stats = { entries: st0.entries, windows: st0.windows, MB: +(st0.bytes / 1048576).toFixed(1), windowMB: +(st0.windowBytes / 1048576).toFixed(1), uploads: st0.windowUploads, wholeMB: +(W * H * 4 * 2 / 1048576).toFixed(1) };
    out.atlas = { pages: st0.atlas.pages, slots: st0.atlas.slots, sources: st0.atlas.sources, MB: +(st0.atlas.bytes / 1048576).toFixed(1) };
    const u0 = up();
    const panned = Math.round(ed.canvas.width * 0.3);
    ed.view.x += panned; shot();
    out.uploadsAfterSmallPan = up() - u0;
    // and back: a window still holds it, and so does every atlas slot the pan did not push out
    const ub = up();
    ed.view.x -= panned; shot();
    out.uploadsAfterPanBack = up() - ub;
    const u1 = up();
    ed.view.x -= Math.round(ed.canvas.width * 1.5); ed.view.y += Math.round(ed.canvas.height * 0.8);
    await compare("afterPan");
    out.uploadsAfterBigPan = up() - u1;
    const u2 = up();
    { const ix = Math.round(-ed.view.x + ed.canvas.width / 2), iy = Math.round(-ed.view.y + ed.canvas.height / 2); layer.px.drawInto([ix - 60, iy - 60, ix + 60, iy + 60], (x) => { x.globalAlpha = 0.6; /* what the dots left on lc's context, which this dab used to draw with */ x.fillStyle = "#ffffff"; x.fillRect(ix - 60, iy - 60, 120, 120); }); ed.markLayerChanged(layer, [ix - 60, iy - 60, ix + 60, iy + 60]); }
    await compare("afterDab");
    out.uploadsAfterDab = up() - u2;
    ed.view.x = Math.round(ed.canvas.width * 0.6); ed.view.y = Math.round(ed.canvas.height * 0.6);
    await compare("atCorner");
    ed.fitView();
    for (let i = 0; i < 6; i++) shot();   // the display levels come one per frame; both paths have to draw from the same ones
    await compare("fit");
    // exactly half: the source itself, drawn 2:1 by both paths. (At a fractional zoom-out, fit
    // for one, the two paths resample a level differently, up to 50 levels on a hard edge; that
    // is the same with and without the windows and is reported, not gated.)
    ed.view.scale = 0.5; ed.view.x = 0; ed.view.y = 0; for (let i = 0; i < 4; i++) shot();
    await compare("half");
    shell.closeDocument(ed, { force: true });
    if (before) shell.activate(before);
    return out;
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
        else:
            one = gl["atOne"]
            # At 1:1 both paths must agree. At the fit zoom they resample: on canvases both take the
            # same Skia pyramid level and agree too, on tiles the compositor draws the tiles' own
            # alpha-weighted box mips and Canvas 2D the Skia level, which is tens of levels apart on a
            # hard edge (docs/PERFORMANCE.md 10, C3). That row is reported there, not gated, as the
            # "fit" row of the window step already is.
            gated = one["max"] if gl.get("tiles") else max(one["max"], gl["max"])
            line = (f"gpu vs 2d: 1:1 max {one['max']} levels, mean {one['mean']}, "
                    f"{one['pixelsOver2']} of {one['pixels']} pixels over 2; "
                    f"at the view's zoom max {gl['max']} mean {gl['mean']}"
                    f"{' (tiles: reported, not gated)' if gl.get('tiles') else ''}, draw {gl['ms']} ms"
                    f"{'' if gl.get('erased') else ' (no layer to erase into)'}")
            if gated <= args.tolerance:
                print(f"[ok] {line}")
            else:
                ok = False
                print(f"[FAIL] {line}")
        # the compositor's windows of a large source (phase A item 4), a document of its own
        win = await c.eval(WINDOW, timeout=600)
        if win.get("skipped"):
            print(f"[skip] source windows: {win['skipped']}")
        else:
            shots = {k: v for k, v in win.items() if isinstance(v, dict) and "max" in v}
            worst = max(v["max"] for k, v in shots.items() if k != "fit")
            unused = [k for k, v in shots.items() if not v["used"]]
            st = win["stats"]
            problems = []
            if worst > args.tolerance:
                problems.append("max %s levels" % worst)
            if unused:
                problems.append("compositor not used for %s" % ",".join(unused))
            at = win.get("atlas") or {}
            if win.get("tiles"):
                # on tiles the atlas replaces the windows: the pages hold the visible tiles of the two
                # sources at level 0 and nothing else, and no source canvas is uploaded at all (C3)
                if at.get("pages", 0) < 1 or at.get("sources", 0) < 2:
                    problems.append("atlas %s pages for %s sources" % (at.get("pages"), at.get("sources")))
                if at.get("MB", 0) * 2 > st["wholeMB"]:
                    problems.append("atlas pages %s MB against %s MB whole" % (at.get("MB"), st["wholeMB"]))
                if st["windows"] or st["entries"]:
                    problems.append("%s source textures (%s windows) beside the atlas" % (st["entries"], st["windows"]))
            elif st["windows"] < 2 or st["windowMB"] * 2 > st["wholeMB"]:
                problems.append("windows %s holding %s MB against %s MB whole" % (st["windows"], st["windowMB"], st["wholeMB"]))
            # The compositor keys a source window on the canvas it is handed. Since C2 step (b) the display
            # draws the pixels' display canvas (canvasOf: the canvas itself, or the tile store's mirror),
            # never a toCanvas() copy, so this holds with --pixels-copy and on tiles too (C1 skipped it in
            # copy mode, where every frame handed the compositor a new copy).
            if win.get("tiles"):
                # a pan brings new tiles into view, so it uploads; panning back must not, the slots are held
                if win.get("uploadsAfterPanBack") != 0:
                    problems.append("a pan back re-uploaded %s tiles" % win.get("uploadsAfterPanBack"))
            elif win["uploadsAfterSmallPan"] != 0:
                problems.append("a pan inside the margin uploaded %s windows" % win["uploadsAfterSmallPan"])
            if win["uploadsAfterBigPan"] < 2:
                problems.append("a pan beyond the margin uploaded %s windows" % win["uploadsAfterBigPan"])
            if win["uploadsAfterDab"] < 1:
                problems.append("a dab did not re-upload the layer's window")
            held = (f"{at.get('pages')} atlas pages {at.get('MB')} MB, {at.get('slots')} slots"
                    if win.get("tiles") else f"{st['windows']} windows {st['windowMB']} MB")
            line = ("source windows: " + ", ".join(f"{k} max {v['max']}" for k, v in shots.items())
                    + f"; {held} for {st['wholeMB']} MB of sources, "
                    + f"uploads small pan {win['uploadsAfterSmallPan']} / back {win.get('uploadsAfterPanBack')} / big pan {win['uploadsAfterBigPan']} / dab {win['uploadsAfterDab']}")
            if problems:
                ok = False
                print(f"[FAIL] {line}: " + "; ".join(problems))
            else:
                print(f"[ok] {line}")
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
