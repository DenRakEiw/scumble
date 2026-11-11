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
    // ten modes since linear light (0.1.32): 80 px wide, 88 apart, so the row still fits the 900 px document
    const modes = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "soft-light", "hard-light", "linear-light", "difference"];
    modes.forEach((mode, i) => {
        const w = 80, h = 200;
        const c = mk(w, h);
        const x = c.getContext("2d");
        const g = x.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, "#ff5020"); g.addColorStop(0.5, "#20ff80"); g.addColorStop(1, "#3050ff");
        x.fillStyle = g; x.fillRect(0, 0, w, h);
        x.fillStyle = "rgba(255,255,255,0.85)"; x.fillRect(10, 20, 30, 60);
        x.fillStyle = "rgba(0,0,0,0.85)"; x.fillRect(50, 120, 30, 60);
        const l = ed.addLayer({ name: "blend " + mode, kind: "paint", px: LayerPixels.fromCanvas(c), x: 10 + i * 88, y: 30, w, h, dirty: true });
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

# A switched-off mask (layer.maskOff, docs/PLAN_0_1_31.md 3e) is drawn as no mask at all: the full composite, the view
# and the PNG export the workers composite are byte for byte the ones with the mask taken away, and differ from the ones
# with the mask on (so the step cannot pass by drawing nothing). Every path reads liveMask(); a mutation there shows here.
MASK_OFF = """
(async () => {
    const ed = window.__cmp;
    const l = ed.layers.find((x) => x.name === "masked");
    if (!l || !l.maskPx) return { skipped: "no masked layer" };
    // the grain filter on top stays: its cache keys on the composite version, so a switch that does not invalidate
    // leaves it filtering the picture of before (its noise is seeded by the pinned layer id: the same in every shot)
    const settle = async () => { await ed.mipsSettled(); await new Promise((r) => setTimeout(r, 150)); };
    const flat = () => { ed.flatCache = null; const c = ed.flattenToCanvas({ forRun: false }); return c.getContext("2d").getImageData(0, 0, c.width, c.height).data; };
    const view = async () => { await settle(); ed.sceneSig = null; ed.draw(); await new Promise((r) => setTimeout(r, 150)); return ed.ctx.getImageData(0, 0, Math.min(1200, ed.canvas.width), Math.min(800, ed.canvas.height)).data; };
    const png = async () => {
        const r = await ed.encodeComposite({ forRun: true }, {});
        if (!r || !r.blob) return null;
        const bmp = await createImageBitmap(r.blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
        const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
        const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(bmp, 0, 0); bmp.close();
        return x.getImageData(0, 0, c.width, c.height).data;
    };
    const shots = async () => ({ full: flat(), view: await view(), png: await png() });
    const diff = (a, b) => { if (!a || !b) return null; if (a.length !== b.length) return { max: 999, n: -1 }; let m = 0, n = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { n++; if (d > m) m = d; } } return { max: m, n }; };
    await settle();
    const on = await shots();
    if (!ed.setMaskOff(l, true)) throw new Error("setMaskOff(true) refused");
    const off = await shots();
    const mask = l.maskPx;
    l.maskPx = null; l.maskOff = false;
    ed.markMaskChanged(l, null, { pixels: false });
    const none = await shots();
    l.maskPx = mask;
    ed.markMaskChanged(l, null, { pixels: false });
    await settle();
    const out = {};
    for (const k of ["full", "view", "png"]) out[k] = { offVsNone: diff(off[k], none[k]), onVsOff: diff(on[k], off[k]) };
    return out;
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

EVERY_MODE_NATIVE_OR_EMULATED = """
(async () => {
    const { BLENDS, EMULATED_BLENDS } = await import("./editor/blend_modes.js");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const failures = [];
    for (const row of BLENDS) {
        if (row.canvas !== null) {
            ctx.globalCompositeOperation = row.canvas;
            if (ctx.globalCompositeOperation !== row.canvas) {
                failures.push(row.id + ": assigned " + row.canvas + " but read back " + ctx.globalCompositeOperation);
            }
        } else if (!EMULATED_BLENDS.has(row.id)) {
            failures.push(row.id + ": canvas is null but not in EMULATED_BLENDS");
        }
    }
    return { count: BLENDS.length, failures };
})()
"""

# A plain filter layer stands for the picture on every path (the screen, flattenToCanvas on both
# backends, the plain PNG export, and an export with a Size row), so on a see-through document it
# replaces its input instead of compositing F(I) over I. Opaque documents and non-plain filter
# layers (a mask, an opacity, a blend mode, a limit view, or a clip) keep their exact bytes from
# base 2068af87.
SEE_THROUGH_FILTERS = """
(async () => {
    const shell = await import("./shell.js");
    const { host } = await import("./editor/host.js");
    const W = 256, H = 256;
    const before = window.editor;
    const ed = shell.newDocument();
    shell.activate(ed);
    await new Promise((r) => setTimeout(r, 200));
    ed.resizeCanvas();
    const { Layer: LayerPixels, Mask: MaskPixels } = ed.pixels;
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const sha256 = async (u8) => {
        const buf = await crypto.subtle.digest("SHA-256", u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
        return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    const clearCaches = () => {
        for (const l of ed.layers) { l._fcache = null; l._fcacheView = null; l._fcacheSample = null; l._fxCache = null; l._fxCacheView = null; }
        ed.flatCache = null;
        ed.sceneSig = null;
    };
    const flatBytes = (forRun = true, chainOff = false) => {
        ed.filterChainOff = chainOff;
        clearCaches();
        const c = ed.flattenToCanvas({ forRun });
        ed.filterChainOff = false;
        return c.getContext("2d").getImageData(0, 0, W, H).data;
    };
    const screenBytes = (chainOff = false) => {
        ed.filterChainOff = chainOff;
        clearCaches();
        const c = mk(W, H), ctx = c.getContext("2d");
        const prev = ed.viewPass;
        ed.viewPass = { x: 0, y: 0, w: W, h: H, sx: 1, sy: 1, screen: true };
        try { ed.drawComposite(ctx, {}); } finally { ed.viewPass = prev; ed.filterChainOff = false; }
        return ctx.getImageData(0, 0, W, H).data;
    };
    const decodeBlob = async (blob, w = W, h = H) => {
        const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
        const c = mk(w, h), ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
        return ctx.getImageData(0, 0, w, h).data;
    };
    const pngBytes = async () => {
        clearCaches();
        const r = await ed.encodeComposite({ forRun: true }, {});
        if (r && r.blob) return decodeBlob(r.blob, W, H);
        const c = await host.exportCanvas(ed, "png");
        return c.getContext("2d").getImageData(0, 0, W, H).data;
    };
    const sizeBytes = async (chainOff = false) => {
        ed.filterChainOff = chainOff;
        clearCaches();
        host.setExportSize(ed, { width: 128, height: 128 });
        try {
            const c = await host.exportCanvas(ed, "png");
            return c.getContext("2d").getImageData(0, 0, 128, 128).data;
        } finally {
            host.setExportSize(ed, { percent: 100 });
            ed.filterChainOff = false;
        }
    };
    const diffMax = (a, b) => {
        if (!a || !b || a.length !== b.length) return 999;
        let m = 0;
        for (let i = 0; i < a.length; i++) {
            const d = Math.abs(a[i] - b[i]);
            if (d > m) m = d;
        }
        return m;
    };
    const pxAt = (d, x, y, w = W) => { const i = (y * w + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
    const eqPx = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
    const problems = [];
    const check = (name, ok, detail) => { if (!ok) problems.push(name + (detail !== undefined ? " (" + JSON.stringify(detail) + ")" : "")); };

    // 1. Half-transparent base (edges at alpha 128, centre at alpha 255).
    // Edge channels [120, 40, 20] (bw luma 62) and [40, 120, 80] (bw luma 92) are even integers 2p with p <= 63,
    // which are exact fixed points of both Canvas 2D's 8-bit premultiply and straight RGBA8.
    const seeBase = mk(W, H);
    {
        const ctx = seeBase.getContext("2d");
        const img = ctx.createImageData(W, H), d = img.data;
        for (let y = 0; y < H; y++) {
            const inY = y >= 64 && y < 192;
            for (let x = 0; x < W; x++) {
                const inX = x >= 64 && x < 192;
                const i = (y * W + x) * 4;
                if (inX && inY) {
                    if (x < 128) { d[i] = 60; d[i + 1] = 120; d[i + 2] = 200; d[i + 3] = 255; }
                    else { d[i] = 200; d[i + 1] = 140; d[i + 2] = 60; d[i + 3] = 255; }
                } else {
                    if (x < 128) { d[i] = 120; d[i + 1] = 40; d[i + 2] = 20; d[i + 3] = 128; }
                    else { d[i] = 40; d[i + 1] = 120; d[i + 2] = 80; d[i + 3] = 128; }
                }
            }
        }
        ctx.putImageData(img, 0, 0);
    }
    Object.defineProperty(seeBase, "naturalWidth", { value: W });
    Object.defineProperty(seeBase, "naturalHeight", { value: H });
    await ed.setBase({ filename: "see_base.png", subfolder: "inpaint_canvas", type: "input" }, seeBase, { keepLayers: false });
    await ed.mipsSettled();

    const baseFlat = flatBytes(true, false);
    const baseSize = await sizeBytes(false);
    check("base edge alpha 128", eqPx(pxAt(baseFlat, 16, 16), [120, 40, 20, 128]) && eqPx(pxAt(baseFlat, 240, 16), [40, 120, 80, 128]));

    // 1a. Identity curves layer: screen, flattenToCanvas, plain PNG export, and Size-row export equal unfiltered base
    const fxCurves = ed.addFilterLayer("curves");
    ed.markFilterChanged(fxCurves);
    const curScreen = screenBytes(false), curScreenOff = screenBytes(true);
    const curFlat = flatBytes(true, false), curFlatOff = flatBytes(true, true);
    const curPng = await pngBytes();
    const curSize = await sizeBytes(false), curSizeOff = await sizeBytes(true);
    check("identity curves screen == base", diffMax(curScreen, baseFlat) === 0 && diffMax(curScreenOff, baseFlat) === 0, { on: diffMax(curScreen, baseFlat), off: diffMax(curScreenOff, baseFlat) });
    check("identity curves flatten == base", diffMax(curFlat, baseFlat) === 0 && diffMax(curFlatOff, baseFlat) === 0, { on: diffMax(curFlat, baseFlat), off: diffMax(curFlatOff, baseFlat) });
    check("identity curves png == base", diffMax(curPng, baseFlat) === 0, diffMax(curPng, baseFlat));
    check("identity curves size == baseSize", diffMax(curSize, baseSize) === 0 && diffMax(curSizeOff, baseSize) === 0 && pxAt(curSize, 8, 8, 128)[3] === 128, { on: diffMax(curSize, baseSize), off: diffMax(curSizeOff, baseSize), edge: pxAt(curSize, 8, 8, 128) });
    ed.removeLayer(fxCurves.id);

    // 1b. Black & white layer: all paths give the same bytes, pure grey at alpha 128 on the edges
    const fxBw = ed.addFilterLayer("bw");
    ed.markFilterChanged(fxBw);
    const bwScreen = screenBytes(false), bwScreenOff = screenBytes(true);
    const bwFlat = flatBytes(true, false), bwFlatOff = flatBytes(true, true);
    const bwPng = await pngBytes();
    const bwSize = await sizeBytes(false), bwSizeOff = await sizeBytes(true);
    check("bw paths agree byte-for-byte", diffMax(bwScreen, bwFlat) === 0 && diffMax(bwScreenOff, bwFlat) === 0 && diffMax(bwFlatOff, bwFlat) === 0 && diffMax(bwPng, bwFlat) === 0, {
        screen: diffMax(bwScreen, bwFlat), screenOff: diffMax(bwScreenOff, bwFlat), flatOff: diffMax(bwFlatOff, bwFlat), png: diffMax(bwPng, bwFlat),
    });
    check("bw edge pure grey alpha 128", eqPx(pxAt(bwFlat, 16, 16), [62, 62, 62, 128]) && eqPx(pxAt(bwFlat, 240, 16), [92, 92, 92, 128]), {
        left: pxAt(bwFlat, 16, 16), right: pxAt(bwFlat, 240, 16),
    });
    check("bw size export agrees and keeps edge pure grey alpha 128", diffMax(bwSize, bwSizeOff) === 0 && eqPx(pxAt(bwSize, 8, 8, 128), [62, 62, 62, 128]) && eqPx(pxAt(bwSize, 120, 8, 128), [92, 92, 92, 128]), {
        diff: diffMax(bwSize, bwSizeOff), left: pxAt(bwSize, 8, 8, 128), right: pxAt(bwSize, 120, 8, 128),
    });

    // 1c. Two-filter case that chains (bw + invert) and two-filter case that does not chain (filterChainOff + sharpen)
    const fxInv = ed.addFilterLayer("invert");
    ed.markFilterChanged(fxInv);
    const chScreen = screenBytes(false), chScreenOff = screenBytes(true);
    const chFlat = flatBytes(true, false), chFlatOff = flatBytes(true, true);
    const chPng = await pngBytes();
    const chSize = await sizeBytes(false), chSizeOff = await sizeBytes(true);
    check("chained bw+invert paths agree byte-for-byte", diffMax(chScreen, chFlat) === 0 && diffMax(chScreenOff, chFlat) === 0 && diffMax(chFlatOff, chFlat) === 0 && diffMax(chPng, chFlat) === 0 && diffMax(chSize, chSizeOff) === 0, {
        screen: diffMax(chScreen, chFlat), screenOff: diffMax(chScreenOff, chFlat), flatOff: diffMax(chFlatOff, chFlat), png: diffMax(chPng, chFlat), size: diffMax(chSize, chSizeOff),
    });
    check("chained bw+invert edge alpha 128", eqPx(pxAt(chFlat, 16, 16), [193, 193, 193, 128]) && eqPx(pxAt(chFlat, 240, 16), [163, 163, 163, 128]) && eqPx(pxAt(chPng, 16, 16), [193, 193, 193, 128]) && eqPx(pxAt(chSize, 8, 8, 128), [193, 193, 193, 128]), {
        left: pxAt(chFlat, 16, 16), right: pxAt(chFlat, 240, 16), pngLeft: pxAt(chPng, 16, 16), sizeLeft: pxAt(chSize, 8, 8, 128),
    });
    ed.removeLayer(fxInv.id);

    // Non-chaining stack 1: bw + sharpen + invert (sharpen breaks programBand on tiles so readBand runs; filterChainOff breaks GPU chain on canvas)
    const fxSharp = ed.addFilterLayer("sharpen");
    fxSharp.params = { ...fxSharp.params, amount: 80, radius: 1.5, threshold: 0 };
    ed.markFilterChanged(fxSharp);
    const fxInv2 = ed.addFilterLayer("invert");
    ed.markFilterChanged(fxInv2);
    const ncFlat = flatBytes(true, false), ncFlatOff = flatBytes(true, true);
    const ncScreen = screenBytes(false), ncPng = await pngBytes();
    check("unchained bw+sharpen+invert paths agree", diffMax(ncFlat, ncFlatOff) === 0 && diffMax(ncScreen, ncFlat) === 0 && diffMax(ncPng, ncFlat) <= 2, {
        flatOff: diffMax(ncFlat, ncFlatOff), screen: diffMax(ncScreen, ncFlat), png: diffMax(ncPng, ncFlat),
    });
    check("unchained bw+sharpen+invert edge alpha 128", eqPx(pxAt(ncFlat, 16, 16), [193, 193, 193, 128]) && eqPx(pxAt(ncFlat, 240, 16), [163, 163, 163, 128]) && eqPx(pxAt(ncFlatOff, 16, 16), [193, 193, 193, 128]), {
        left: pxAt(ncFlat, 16, 16), right: pxAt(ncFlat, 240, 16), leftOff: pxAt(ncFlatOff, 16, 16),
    });
    ed.removeLayer(fxInv2.id);
    ed.removeLayer(fxSharp.id);

    // Non-chaining stack 2: plain bw (chains onto chain.surface because nextIsFilterLayer is true) followed by a masked
    // invert (plain=false, so applyFilterLayer calls flushFilterChain(ctx, chain) without clearing ctx at the end).
    // On the left half (where the mask is 0), ctx holds purely what flushFilterChain drew.
    const fxMaskedInv = ed.addFilterLayer("invert");
    {
        const mc = mk(W, H), mx = mc.getContext("2d");
        const mimg = mx.createImageData(W, H), md = mimg.data;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4;
                md[i] = 255; md[i + 1] = 255; md[i + 2] = 255; md[i + 3] = x < 128 ? 0 : 255;
            }
        }
        mx.putImageData(mimg, 0, 0);
        fxMaskedInv.maskPx = MaskPixels.fromCanvas(mc);
        ed.markMaskChanged(fxMaskedInv);
    }
    await ed.mipsSettled();
    const flChainOn = flatBytes(true, false), flChainOff = flatBytes(true, true);
    const flScreen = screenBytes(false), flPng = await pngBytes();
    check("flushFilterChain before masked filter agrees across all paths", diffMax(flChainOn, flChainOff) === 0 && diffMax(flScreen, flChainOn) === 0 && diffMax(flPng, flChainOn) === 0, {
        off: diffMax(flChainOn, flChainOff), screen: diffMax(flScreen, flChainOn), png: diffMax(flPng, flChainOn),
    });
    check("flushFilterChain left half keeps pure grey alpha 128", eqPx(pxAt(flChainOn, 16, 16), [62, 62, 62, 128]), pxAt(flChainOn, 16, 16));
    ed.removeLayer(fxMaskedInv.id);

    // 1d. Plain filter with params.limit (limitOver = !plain mixes input where w=0 instead of zeroing alpha before clearRect)
    fxBw.params = { ...fxBw.params, limit: { source: "luma", lo: 0.3, hi: 1.0, fLo: 0, fHi: 0 } };
    ed.markFilterChanged(fxBw);
    const limFlat = flatBytes(true, false), limFlatOff = flatBytes(true, true);
    const limScreen = screenBytes(false), limPng = await pngBytes();
    check("limited plain bw agrees across all paths", diffMax(limFlat, limFlatOff) === 0 && diffMax(limScreen, limFlat) === 0 && diffMax(limPng, limFlat) === 0, {
        off: diffMax(limFlat, limFlatOff), screen: diffMax(limScreen, limFlat), png: diffMax(limPng, limFlat),
    });
    check("limited plain bw keeps unfiltered edge where w=0 and filtered edge where w=1", eqPx(pxAt(limFlat, 16, 16), [120, 40, 20, 128]) && eqPx(pxAt(limFlat, 240, 16), [92, 92, 92, 128]), {
        w0: pxAt(limFlat, 16, 16), w1: pxAt(limFlat, 240, 16),
    });

    // 1e. Filter cache keys on plain when limit is set: opacity 0.5 -> 1.0 and 1.0 -> 0.5 without compositeVersion bump
    const renderScreenKeepCache = () => {
        const c = mk(W, H), ctx = c.getContext("2d");
        const prev = ed.viewPass;
        ed.viewPass = { x: 0, y: 0, w: W, h: H, sx: 1, sy: 1, screen: true };
        try { ed.drawComposite(ctx, {}); } finally { ed.viewPass = prev; }
        return ctx.getImageData(0, 0, W, H).data;
    };
    fxBw.opacity = 0.5;
    const limScreenHalfFresh = screenBytes(false);
    fxBw.opacity = 1.0;
    const limScreenOneFromCache = renderScreenKeepCache();
    check("limited filter cache at opacity 0.5 -> 1.0 without version bump matches fresh", diffMax(limScreenOneFromCache, limScreen) === 0, diffMax(limScreenOneFromCache, limScreen));
    fxBw.opacity = 0.5;
    const limScreenHalfFromCache = renderScreenKeepCache();
    check("limited filter cache at opacity 1.0 -> 0.5 without version bump matches fresh", diffMax(limScreenHalfFromCache, limScreenHalfFresh) === 0, diffMax(limScreenHalfFromCache, limScreenHalfFresh));
    fxBw.opacity = 1.0;

    // 1f. Split no-op guards:
    // (i) plain filter with missing depth map (limitMissing=true, plain=true) AND at opacity 0.5 (limitMissing=true, plain=false)
    ed.maps = {};
    fxBw.params = { ...fxBw.params, limit: { source: "depth", lo: 0.2, hi: 0.8, fLo: 0, fHi: 0 } };
    ed.markFilterChanged(fxBw);
    const missFlat = flatBytes(true, false), missFlatOff = flatBytes(true, true);
    check("missing-depth plain filter leaves base untouched", diffMax(missFlat, baseFlat) === 0 && diffMax(missFlatOff, baseFlat) === 0, {
        on: diffMax(missFlat, baseFlat), off: diffMax(missFlatOff, baseFlat),
    });
    fxBw.opacity = 0.5;
    ed.markFilterChanged(fxBw);
    const missHalfFlat = flatBytes(true, false), missHalfScreen = screenBytes(false);
    check("missing-depth non-plain filter (opacity 0.5) leaves base untouched", diffMax(missHalfFlat, baseFlat) === 0 && diffMax(missHalfScreen, baseFlat) === 0, {
        flat: diffMax(missHalfFlat, baseFlat), screen: diffMax(missHalfScreen, baseFlat),
    });
    ed.removeLayer(fxBw.id);
    // (ii) plain filter whose apply() returns input canvas unchanged (plain=true, limitMissing=false, out === ctx.canvas)
    const fxNoop = ed.addFilterLayer("effects.chromatic_shift");
    fxNoop.params = { ...fxNoop.params, amount: 0 };
    ed.markFilterChanged(fxNoop);
    const noopFlat = flatBytes(true, false), noopScreen = screenBytes(false);
    check("no-op plain filter returning input canvas leaves base untouched", diffMax(noopFlat, baseFlat) === 0 && diffMax(noopScreen, baseFlat) === 0, {
        flat: diffMax(noopFlat, baseFlat), screen: diffMax(noopScreen, baseFlat),
    });
    ed.removeLayer(fxNoop.id);

    // 1g. flushFilterChain preserves ctx when a real GLSurface fails to blit or read back
    {
        const { glContext, isGLSurface } = await import("./editor/inpaint_filters_gl.js");
        const gc = mk(16, 16), gctx = gc.getContext("2d");
        const gimg = gctx.createImageData(16, 16), gd = gimg.data;
        for (let i = 0; i < gd.length; i += 4) { gd[i] = 120; gd[i + 1] = 40; gd[i + 2] = 20; gd[i + 3] = 128; }
        gctx.putImageData(gimg, 0, 0);
        const fxSurf = ed.addFilterLayer("bw");
        const realSurf = ed.filteredCanvas(fxSurf, gc, true, false, true, true);
        ed.removeLayer(fxSurf.id);
        const surfOk = isGLSurface(realSurf);
        const g = glContext();
        const origGetError = g.gl.getError;
        g.gl.getError = () => g.gl.INVALID_OPERATION;
        try {
            ed.flushFilterChain(gctx, { surface: realSurf, x: 0, y: 0, w: 16, h: 16 });
        } finally {
            g.gl.getError = origGetError;
        }
        const afterBlit = pxAt(gctx.getImageData(0, 0, 16, 16).data, 8, 8, 16);
        check("flushFilterChain preserves ctx when surface readback fails",
            surfOk && eqPx(afterBlit, [120, 40, 20, 128]),
            { surfOk, afterBlit });
    }

    // 1h. Real drawViewComposite at view.scale = 0.5 and after pan on see-through base
    {
        const fxViewBw = ed.addFilterLayer("bw");
        ed.markFilterChanged(fxViewBw);
        const prevScale = ed.view.scale, prevX = ed.view.x, prevY = ed.view.y;
        try {
            clearCaches();
            ed.view.scale = 0.5; ed.view.x = 40; ed.view.y = 30;
            ed.draw();
            const d1 = ed.canvas.getContext("2d").getImageData(0, 0, ed.canvas.width, ed.canvas.height).data;
            const p1L = pxAt(d1, 48, 38, ed.canvas.width), p1R = pxAt(d1, 160, 38, ed.canvas.width);
            ed.view.x = 64; ed.view.y = 48;
            ed.draw();
            const d2 = ed.canvas.getContext("2d").getImageData(0, 0, ed.canvas.width, ed.canvas.height).data;
            const p2L = pxAt(d2, 72, 56, ed.canvas.width), p2R = pxAt(d2, 184, 56, ed.canvas.width);
            check("drawViewComposite at scale 0.5 and after pan keeps pure grey alpha 128",
                eqPx(p1L, [62, 62, 62, 128]) && eqPx(p1R, [92, 92, 92, 128]) && eqPx(p2L, [62, 62, 62, 128]) && eqPx(p2R, [92, 92, 92, 128]),
                { p1L, p1R, p2L, p2R });
        } finally {
            ed.view.scale = prevScale; ed.view.x = prevX; ed.view.y = prevY;
            ed.removeLayer(fxViewBw.id);
        }
    }

    // 2. Non-plain filter layers (mask, opacity, blend mode, limitView, clip) checked byte-for-byte against frozen base 2068af87
    const halfBase = mk(W, H);
    {
        const ctx = halfBase.getContext("2d");
        const img = ctx.createImageData(W, H), d = img.data;
        for (let y = 0; y < H; y++) {
            const inY = y >= 64 && y < 192;
            for (let x = 0; x < W; x++) {
                const inX = x >= 64 && x < 192;
                const i = (y * W + x) * 4;
                if (inX && inY) {
                    if (x < 128) { d[i] = 60; d[i + 1] = 120; d[i + 2] = 200; d[i + 3] = 255; }
                    else { d[i] = 200; d[i + 1] = 140; d[i + 2] = 60; d[i + 3] = 255; }
                } else {
                    if (x < 128) { d[i] = 201; d[i + 1] = 60; d[i + 2] = 40; d[i + 3] = 128; }
                    else { d[i] = 80; d[i + 1] = 199; d[i + 2] = 120; d[i + 3] = 128; }
                }
            }
        }
        ctx.putImageData(img, 0, 0);
    }
    Object.defineProperty(halfBase, "naturalWidth", { value: W });
    Object.defineProperty(halfBase, "naturalHeight", { value: H });
    await ed.setBase({ filename: "half_base.png", subfolder: "inpaint_canvas", type: "input" }, halfBase, { keepLayers: false });
    await ed.mipsSettled();
    const fxM = ed.addFilterLayer("bw");
    {
        const mc = mk(W, H), mx = mc.getContext("2d");
        const mimg = mx.createImageData(W, H), md = mimg.data;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4;
                md[i] = 255; md[i + 1] = 255; md[i + 2] = 255; md[i + 3] = x < 128 ? 0 : 255;
            }
        }
        mx.putImageData(mimg, 0, 0);
        fxM.maskPx = MaskPixels.fromCanvas(mc);
        ed.markMaskChanged(fxM);
    }
    await ed.mipsSettled();
    const maskHash = await sha256(flatBytes(true, false));
    check("frozen non-plain mask matches 2068af87", maskHash === "8007aefef32c622927f8f28de783b5a0c2ff5f16185de157b7618e4e12d7ef4f", maskHash);
    ed.removeLayer(fxM.id);

    const fxOp = ed.addFilterLayer("bw");
    fxOp.opacity = 0.5;
    ed.markFilterChanged(fxOp);
    const opHash = await sha256(flatBytes(true, false));
    check("frozen non-plain opacity matches 2068af87", opHash === "e05bb2abc946ccd66b0d47b738a5731898ce5988af4de8ed7ba098f86551d863", opHash);
    ed.removeLayer(fxOp.id);

    const fxBl = ed.addFilterLayer("bw");
    fxBl.blend = "multiply";
    ed.markFilterChanged(fxBl);
    const blHash = await sha256(flatBytes(true, false));
    check("frozen non-plain blend matches 2068af87", blHash === "c29c232efa0b22383ece0f2483e3db1d9b257eaf7d66a7b558a0f3c1931c8efc", blHash);
    ed.removeLayer(fxBl.id);

    const fxLv = ed.addFilterLayer("bw");
    fxLv.params = { ...fxLv.params, limit: { source: "luma", lo: 0.5, hi: 1.0, fLo: 0, fHi: 0 } };
    ed.maskView = { id: fxLv.id, mode: "effect" };
    ed.markFilterChanged(fxLv);
    const lvHash = await sha256(screenBytes(false));
    ed.maskView = null;
    check("frozen non-plain limitView matches 2068af87", lvHash === "2a8e8d080370d156d555c6d451ba9bb6e43e6c6d6b7fb96b276df7500d6a62b1", lvHash);
    ed.removeLayer(fxLv.id);

    const clipBaseC = mk(192, 192);
    {
        const cx = clipBaseC.getContext("2d");
        const cimg = cx.createImageData(192, 192), cd = cimg.data;
        for (let i = 0; i < cd.length; i += 4) {
            cd[i] = 120; cd[i + 1] = 80; cd[i + 2] = 199; cd[i + 3] = 128;
        }
        cx.putImageData(cimg, 0, 0);
    }
    const clipBaseLayer = ed.addLayer({ name: "clip-base", kind: "paint", px: LayerPixels.fromCanvas(clipBaseC), x: 32, y: 32, w: 192, h: 192, dirty: true });
    const fxCl = ed.addFilterLayer("bw");
    fxCl.clip = true;
    ed.markFilterChanged(fxCl);
    await ed.mipsSettled();
    const clHash = await sha256(flatBytes(true, false));
    check("frozen non-plain clip matches 2068af87", clHash === "4aca64654377c048bfe1ec26d20d57cdea9125cd348aefe885e38a46265c3e27", clHash);
    ed.removeLayer(fxCl.id);
    ed.removeLayer(clipBaseLayer.id);

    // 3. Opaque document checked byte-for-byte against frozen base 2068af87
    const opaqueBase = mk(W, H);
    {
        const ctx = opaqueBase.getContext("2d");
        const img = ctx.createImageData(W, H), d = img.data;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4;
                d[i] = (x * 3 + y * 5) & 255;
                d[i + 1] = (x * 7 + 40) & 255;
                d[i + 2] = (y * 11 + 90) & 255;
                d[i + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
    }
    Object.defineProperty(opaqueBase, "naturalWidth", { value: W });
    Object.defineProperty(opaqueBase, "naturalHeight", { value: H });
    await ed.setBase({ filename: "opaque_base.png", subfolder: "inpaint_canvas", type: "input" }, opaqueBase, { keepLayers: false });
    await ed.mipsSettled();

    const opBaseH = await sha256(flatBytes(true, false));
    check("frozen opaque base matches 2068af87", opBaseH === "068674f7a924486deacb2c9ce958a63ed94e5be903024dba696641eb7cb4032b", opBaseH);
    const fxOC = ed.addFilterLayer("curves");
    ed.markFilterChanged(fxOC);
    const opCurH = await sha256(flatBytes(true, false));
    check("frozen opaque curves matches 2068af87", opCurH === "068674f7a924486deacb2c9ce958a63ed94e5be903024dba696641eb7cb4032b", opCurH);
    ed.removeLayer(fxOC.id);

    const fxOBw = ed.addFilterLayer("bw");
    ed.markFilterChanged(fxOBw);
    const opBwH = await sha256(flatBytes(true, false));
    check("frozen opaque bw matches 2068af87", opBwH === "11eed704af0cb278c72c7eac8994f9e1f2bcc5e6550da3beff3d1822683f76c6", opBwH);
    const fxOInv = ed.addFilterLayer("invert");
    ed.markFilterChanged(fxOInv);
    const opChH = await sha256(flatBytes(true, false));
    const opUnchH = await sha256(flatBytes(true, true));
    check("frozen opaque chained+unchained matches 2068af87", opChH === "fa53ed91b30a605292b9c896b69dfbf20f155b75beeea3888f8295164872168b" && opUnchH === "fa53ed91b30a605292b9c896b69dfbf20f155b75beeea3888f8295164872168b", { opChH, opUnchH });
    ed.removeLayer(fxOInv.id);

    const fxOSh = ed.addFilterLayer("sharpen");
    fxOSh.params = { ...fxOSh.params, amount: 80, radius: 1.5, threshold: 0 };
    ed.markFilterChanged(fxOSh);
    const fxOInv2 = ed.addFilterLayer("invert");
    ed.markFilterChanged(fxOInv2);
    const opMidH = await sha256(flatBytes(true, false));
    check("frozen opaque bw+sharpen+invert matches 2068af87", opMidH === "216770c1edbdd99893b15c31c20cdccc950185faad5c255b4a6ac33552a32af5", opMidH);
    ed.removeLayer(fxOInv2.id);
    ed.removeLayer(fxOSh.id);
    ed.removeLayer(fxOBw.id);

    // 3a. Opaque soft-limit case (last filter in stack, soft ramp 0 < w < 1 and outside w = 0 / w = 1) against frozen 2068af87
    {
        const fxOSoft = ed.addFilterLayer("bw");
        fxOSoft.params = { ...fxOSoft.params, limit: { source: "luma", lo: 0.35, hi: 0.65, fLo: 0.2, fHi: 0.2 } };
        ed.markFilterChanged(fxOSoft);
        // Reconstruct 2068af87's two-round path (plain = false -> u_over = 1 + source-over onto opaqueBase) and verify its SHA-256 against frozen 2068af87
        clearCaches();
        const overC = ed.filteredCanvas(fxOSoft, opaqueBase, true, false, null, false);
        const refC = mk(W, H), refCtx = refC.getContext("2d");
        refCtx.drawImage(opaqueBase, 0, 0);
        refCtx.drawImage(overC, 0, 0);
        const ref2068 = refCtx.getImageData(0, 0, W, H).data;
        const ref2068Hash = await sha256(ref2068);
        check("frozen opaque soft-limit 2068af87 reference hash verified", ref2068Hash === "deec60b1d3b84105e22093b65061c5a557864c985b3b4a87663172b38ec464e6", ref2068Hash);

        const softFlat = flatBytes(true, false), softFlatOff = flatBytes(true, true);
        const softScreen = screenBytes(false), softPng = await pngBytes();
        check("opaque soft-limit paths agree byte-for-byte",
            diffMax(softFlat, softFlatOff) === 0 && diffMax(softScreen, softFlat) === 0 && diffMax(softPng, softFlat) === 0,
            { flatOff: diffMax(softFlat, softFlatOff), screen: diffMax(softScreen, softFlat), png: diffMax(softPng, softFlat) });

        // Compare every pixel of the 256x256 image against verified 2068af87 reference: 0 outside the ramp, <= 2 inside
        const sstep = (a, b, x) => {
            if (x <= a) return 0;
            if (x >= b) return 1;
            const t = (x - a) / (b - a);
            return t * t * (3 - 2 * t);
        };
        const baseData = opaqueBase.getContext("2d").getImageData(0, 0, W, H).data;
        let maxOutside = 0, maxRamp = 0, minAlpha = 255;
        for (let i = 0; i < softFlat.length; i += 4) {
            const v = (0.299 * baseData[i] + 0.587 * baseData[i + 1] + 0.114 * baseData[i + 2]) / 255;
            const w = sstep(0.15, 0.35, v) * (1 - sstep(0.65, 0.85, v));
            const d = Math.max(
                Math.abs(softFlat[i] - ref2068[i]),
                Math.abs(softFlat[i + 1] - ref2068[i + 1]),
                Math.abs(softFlat[i + 2] - ref2068[i + 2]),
                Math.abs(softFlat[i + 3] - ref2068[i + 3]),
                Math.abs(softScreen[i] - ref2068[i]),
                Math.abs(softScreen[i + 1] - ref2068[i + 1]),
                Math.abs(softScreen[i + 2] - ref2068[i + 2]),
                Math.abs(softScreen[i + 3] - ref2068[i + 3]),
            );
            if (w === 0 || w === 1) { if (d > maxOutside) maxOutside = d; }
            else { if (d > maxRamp) maxRamp = d; }
            if (softFlat[i + 3] < minAlpha) minAlpha = softFlat[i + 3];
            if (softScreen[i + 3] < minAlpha) minAlpha = softScreen[i + 3];
        }
        check("opaque soft-limit matches 2068af87 (0 outside ramp, <= 2 inside ramp, alpha 255)",
            maxOutside === 0 && maxRamp >= 1 && maxRamp <= 2 && minAlpha === 255,
            { maxOutside, maxRamp, minAlpha });
        ed.removeLayer(fxOSoft.id);
    }

    // 3b. View-margin crop and rim clamping on opaque base with effects.glass (amount 25):
    // neither an explicit viewPass with margin nor a zoomed-out drawViewComposite (even at fractional zoom/pan)
    // pulls transparent margin alpha < 255 into the document rim
    {
        const fxGlass = ed.addFilterLayer("effects.glass");
        fxGlass.params = { ...fxGlass.params, amount: 25 };
        ed.markFilterChanged(fxGlass);
        const glassFlat = flatBytes(true, false);
        for (const chainOff of [false, true]) {
            ed.filterChainOff = chainOff;
            clearCaches();
            const pad = 32, vw = W + pad * 2, vh = H + pad * 2;
            const vc = mk(vw, vh), vctx = vc.getContext("2d");
            vctx.setTransform(1, 0, 0, 1, pad, pad);
            const prevVp = ed.viewPass;
            ed.viewPass = { x: -pad, y: -pad, w: vw, h: vh, sx: 1, sy: 1, screen: true };
            try { ed.drawComposite(vctx, {}); } finally { ed.viewPass = prevVp; ed.filterChainOff = false; }
            const vd = vctx.getImageData(0, 0, vw, vh).data;
            let minDocA = 255, maxMarginA = 0, maxDocDiff = 0;
            for (let y = 0; y < vh; y++) {
                const inY = y >= pad && y < pad + H;
                for (let x = 0; x < vw; x++) {
                    const inX = x >= pad && x < pad + W;
                    const vi = (y * vw + x) * 4;
                    if (inX && inY) {
                        if (vd[vi + 3] < minDocA) minDocA = vd[vi + 3];
                        const fi = ((y - pad) * W + (x - pad)) * 4;
                        for (let c = 0; c < 4; c++) {
                            const d = Math.abs(vd[vi + c] - glassFlat[fi + c]);
                            if (d > maxDocDiff) maxDocDiff = d;
                        }
                    } else if (vd[vi + 3] > maxMarginA) {
                        maxMarginA = vd[vi + 3];
                    }
                }
            }
            check(`opaque glass with view margin (chainOff=${chainOff}) keeps doc alpha 255 and matches flatten`,
                minDocA === 255 && maxMarginA === 0 && maxDocDiff === 0,
                { minDocA, maxMarginA, maxDocDiff });
        }
        // Real zoomed-out drawViewComposite at integer and fractional zoom/pan
        const prevScale = ed.view.scale, prevX = ed.view.x, prevY = ed.view.y;
        try {
            for (const [sc, vx, vy] of [[0.5, 40, 30], [0.47, 37.3, 29.7]]) {
                clearCaches();
                ed.view.scale = sc; ed.view.x = vx; ed.view.y = vy;
                ed.draw();
                const reg = ed._viewRegion || ed.viewportRegion();
                const vcw = ed.viewCanvas.width, vch = ed.viewCanvas.height;
                const sx = vcw / reg.w, sy = vch / reg.h;
                const bx0 = Math.max(0, Math.floor(-reg.x * sx));
                const by0 = Math.max(0, Math.floor(-reg.y * sy));
                const bx1 = Math.min(vcw, Math.ceil((W - reg.x) * sx));
                const by1 = Math.min(vch, Math.ceil((H - reg.y) * sy));
                const vcd = ed.viewCanvas.getContext("2d").getImageData(0, 0, vcw, vch).data;
                let minVcDocA = 255;
                for (let y = by0; y < by1; y++) {
                    for (let x = bx0; x < bx1; x++) {
                        const a = vcd[(y * vcw + x) * 4 + 3];
                        if (a < minVcDocA) minVcDocA = a;
                    }
                }
                const cd = ed.canvas.getContext("2d").getImageData(0, 0, ed.canvas.width, ed.canvas.height).data;
                const cx0 = Math.max(0, Math.ceil(vx)), cy0 = Math.max(0, Math.ceil(vy));
                const cx1 = Math.min(ed.canvas.width, Math.floor(vx + W * sc));
                const cy1 = Math.min(ed.canvas.height, Math.floor(vy + H * sc));
                let minCanvasDocA = 255;
                for (let y = cy0; y < cy1; y++) {
                    for (let x = cx0; x < cx1; x++) {
                        const a = cd[(y * ed.canvas.width + x) * 4 + 3];
                        if (a < minCanvasDocA) minCanvasDocA = a;
                    }
                }
                check(`opaque glass drawViewComposite at scale=${sc} keeps alpha 255 on viewCanvas and canvas`,
                    minVcDocA === 255 && minCanvasDocA === 255,
                    { minVcDocA, minCanvasDocA, bx0, by0, bx1, by1 });
            }
        } finally {
            ed.view.scale = prevScale; ed.view.x = prevX; ed.view.y = prevY;
            ed.removeLayer(fxGlass.id);
        }
    }

    // 3c. Fill layer after a cropped GPU filter chain at a zoomed-out margin view (with and without a Limit on the fill)
    {
        const greyBase = mk(W, H);
        {
            const ctx = greyBase.getContext("2d");
            const img = ctx.createImageData(W, H), d = img.data;
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                    const i = (y * W + x) * 4;
                    const v = (x * 3 + y * 5) & 255;
                    d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
                }
            }
            ctx.putImageData(img, 0, 0);
        }
        Object.defineProperty(greyBase, "naturalWidth", { value: W });
        Object.defineProperty(greyBase, "naturalHeight", { value: H });
        await ed.setBase({ filename: "grey_base.png", subfolder: "inpaint_canvas", type: "input" }, greyBase, { keepLayers: false });
        await ed.mipsSettled();

        const prevScale = ed.view.scale, prevX = ed.view.x, prevY = ed.view.y;
        const fxBwBelow = ed.addFilterLayer("bw");
        const fxGrad = ed.addFilterLayer("gradient");
        fxGrad.params = { ...fxGrad.params, shape: "linear", from: "#ff2040", from_opacity: 100, to: "#2060ff", to_opacity: 100, angle: 25, scale: 100, x: 50, y: 50 };
        try {
            ed.view.scale = 0.5; ed.view.x = 40; ed.view.y = 30;
            const docCrop = (chainOff = false) => {
                ed.filterChainOff = chainOff;
                clearCaches();
                ed.hover = null;
                try { ed.draw(); } finally { ed.filterChainOff = false; }
                return ed.canvas.getContext("2d").getImageData(42, 32, 124, 124).data;
            };
            fxBwBelow.visible = false;
            ed.markFilterChanged(fxBwBelow);
            ed.markFilterChanged(fxGrad);
            const gradNoFilter = docCrop(false);
            fxBwBelow.visible = true;
            ed.markFilterChanged(fxBwBelow);
            ed.markFilterChanged(fxGrad);
            const gradAfterBw = docCrop(false);
            const gradAfterBwOff = docCrop(true);
            const span = diffMax(pxAt(gradNoFilter, 4, 62, 124), pxAt(gradNoFilter, 120, 62, 124));
            check("zoomed-out linear gradient after bw (GPU chain on) matches gradient with no filter below",
                span > 100 && diffMax(gradAfterBw, gradNoFilter) <= 1 && diffMax(gradAfterBw, gradAfterBwOff) <= 1,
                { span, vsNoFilter: diffMax(gradAfterBw, gradNoFilter), vsOff: diffMax(gradAfterBw, gradAfterBwOff) });

            // Variant with a Limit on the fill layer
            fxGrad.params = { ...fxGrad.params, limit: { source: "luma", lo: 0.25, hi: 0.75, fLo: 0.1, fHi: 0.1 } };
            fxBwBelow.visible = false;
            ed.markFilterChanged(fxBwBelow);
            ed.markFilterChanged(fxGrad);
            const limGradNoFilter = docCrop(false);
            fxBwBelow.visible = true;
            ed.markFilterChanged(fxBwBelow);
            ed.markFilterChanged(fxGrad);
            const limGradAfterBw = docCrop(false);
            const limGradAfterBwOff = docCrop(true);
            check("zoomed-out limited linear gradient after bw (GPU chain on) matches limited gradient with no filter below",
                diffMax(limGradAfterBw, limGradNoFilter) <= 1 && diffMax(limGradAfterBw, limGradAfterBwOff) <= 1,
                { vsNoFilter: diffMax(limGradAfterBw, limGradNoFilter), vsOff: diffMax(limGradAfterBw, limGradAfterBwOff) });
        } finally {
            ed.view.scale = prevScale; ed.view.x = prevX; ed.view.y = prevY;
            ed.removeLayer(fxGrad.id);
            ed.removeLayer(fxBwBelow.id);
        }
    }

    // 3c2. A margin view's crop canvas: what a filter that did nothing returned (the crop canvas itself) stays the cached
    // picture across frames, and nothing of an earlier pass shows in a later one. Guards any scratch reused for the crop
    // (docs/BUGS.md: reuse measured no gain, 2026-11-10, but the idea is open): the canvas a filter returned is the result.
    {
        const texBase = mk(W, H);
        {
            const ctx = texBase.getContext("2d");
            const img = ctx.createImageData(W, H), d = img.data;
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                    const i = (y * W + x) * 4;
                    d[i] = (x * 3 + y * 5) & 255; d[i + 1] = (x * 7) & 255; d[i + 2] = (y * 9) & 255; d[i + 3] = 96 + ((x + y) & 127);
                }
            }
            ctx.putImageData(img, 0, 0);
        }
        Object.defineProperty(texBase, "naturalWidth", { value: W });
        Object.defineProperty(texBase, "naturalHeight", { value: H });
        await ed.setBase({ filename: "tex_base.png", subfolder: "inpaint_canvas", type: "input" }, texBase, { keepLayers: false });
        await ed.mipsSettled();
        const prevScale = ed.view.scale, prevX = ed.view.x, prevY = ed.view.y;
        const screen = () => { ed.sceneSig = null; ed.hover = null; ed.draw(); return ed.canvas.getContext("2d").getImageData(0, 0, ed.canvas.width, ed.canvas.height).data.slice(); };
        const fresh = () => { clearCaches(); return screen(); };
        const tint = mk(W, H);
        { const c = tint.getContext("2d"); c.fillStyle = "rgba(255, 32, 64, 0.5)"; c.fillRect(0, 0, W, H); }
        const fxDone = ed.addFilterLayer("bw");
        fxDone.filter = "no_such_filter";   // what a layer of a plugin that is off does: applyFilter hands the input back
        fxDone.opacity = 0.9;               // not plain, so no surface for the next filter: its result is cached and drawn from the cache
        const paint = ed.addLayer({ name: "tint", kind: "paint", px: LayerPixels.fromCanvas(tint), x: 0, y: 0, w: W, h: H, dirty: true });
        const fxBw = ed.addFilterLayer("bw");
        fxBw.opacity = 0.5;                 // not plain either: a plain top layer's cached picture would replace whatever lies below it
        try {
            ed.view.scale = 0.5; ed.view.x = 40; ed.view.y = 30;
            // the no-op layer's cached picture is drawn again after the bw layer's crop ran
            const first = fresh();
            const cached = fxDone._fcacheView && fxDone._fcacheView.canvas;
            const again = screen();
            check("a filter that returned its crop canvas stays cached: the second frame equals the first",
                !!cached && diffMax(first, again) === 0, { cached: !!cached, max: diffMax(first, again) });

            // what a pass left behind does not show in a later pass over a see-through picture
            fxDone.visible = false;
            ed.markFilterChanged(fxDone);
            screen();
            paint.visible = false;
            ed.markLayerChanged(paint);
            const emptied = screen();
            check("nothing of the last pass shows where the picture is see-through now", diffMax(emptied, fresh()) === 0, { max: diffMax(emptied, fresh()) });
            paint.visible = true;
            ed.markLayerChanged(paint);
            fxDone.visible = true;
            ed.markFilterChanged(fxDone);
        } finally {
            ed.view.scale = prevScale; ed.view.x = prevX; ed.view.y = prevY;
            ed.removeLayer(fxBw.id);
            ed.removeLayer(paint.id);
            ed.removeLayer(fxDone.id);
        }
    }

    // 3d. Live mask stroke preview with an active selection at a zoomed-out margin view matches the committed mask
    {
        await ed.setBase({ filename: "opaque_base.png", subfolder: "inpaint_canvas", type: "input" }, opaqueBase, { keepLayers: false });
        await ed.mipsSettled();
        const prevScale = ed.view.scale, prevX = ed.view.x, prevY = ed.view.y;
        const fxMs = ed.addFilterLayer("invert");
        fxMs.maskPx = MaskPixels.empty(W, H);
        fxMs.maskOff = false;
        fxMs.maskEdit = true;
        ed.activeLayerId = fxMs.id;
        ed.markMaskChanged(fxMs);
        ed.selectRectangle([80, 80, 176, 176], "replace");
        ed.brushSize = 48; ed.hardness = 1; ed.brushOpacity = 1;
        try {
            ed.view.scale = 0.5; ed.view.x = 40; ed.view.y = 30;
            clearCaches();
            ed.hover = null;
            ed.draw();
            const beforePx = pxAt(ed.canvas.getContext("2d").getImageData(0, 0, ed.canvas.width, ed.canvas.height).data, 104, 94, ed.canvas.width);
            const p = {
                kind: "maskpaint",
                layer: fxMs,
                stroke: ed.newStrokeBuffer(fxMs.maskPx),
                clip: ed.strokeClip(fxMs, fxMs.maskPx),
                erase: false,
                white: true,
                last: [128, 128],
                pressure: 1,
            };
            ed.pointer = p;
            ed.layerDab(p, 128, 128, 128, 128);
            ed.hover = null; ed.sceneSig = null; ed.draw();
            const duringCrop = ed.sceneCanvas.getContext("2d").getImageData(42, 32, 124, 124).data;
            const duringPx = pxAt(ed.canvas.getContext("2d").getImageData(0, 0, ed.canvas.width, ed.canvas.height).data, 104, 94, ed.canvas.width);
            const box = ed.strokeRect(p, fxMs.maskPx);
            ed.commitStroke(p);
            ed.pointer = null;
            ed.markMaskChanged(fxMs, box);
            ed.releaseStrokeScratch();
            await ed.mipsSettled();
            clearCaches();
            ed.hover = null; ed.draw();
            const afterCrop = ed.sceneCanvas.getContext("2d").getImageData(42, 32, 124, 124).data;
            const afterPx = pxAt(ed.canvas.getContext("2d").getImageData(0, 0, ed.canvas.width, ed.canvas.height).data, 104, 94, ed.canvas.width);
            check("zoomed-out live mask stroke with selection matches committed mask",
                !!p.clip && diffMax(duringPx, beforePx) > 100 && diffMax(duringCrop, afterCrop) <= 2 && diffMax(duringPx, afterPx) <= 2,
                { clip: !!p.clip, reach: diffMax(duringPx, beforePx), cropDiff: diffMax(duringCrop, afterCrop), duringPx, afterPx });
        } finally {
            ed.pointer = null;
            ed.clearSelection();
            ed.view.scale = prevScale; ed.view.x = prevX; ed.view.y = prevY;
            ed.removeLayer(fxMs.id);
        }
    }

    shell.closeDocument(ed, { force: true });
    if (before) shell.activate(before);
    return { tiles: !!ed.tileMode, problems };
})()
"""

# Tile atlas budget clamping (`tiles/T2`: no 32-bit `| 0` wrap above 2047 MB, clamped to [16 MB, 16384 MB]) and
# mid-frame / post-failure atlas eviction (`tiles/T1`: `setAtlasBudget` small, a plain stack of whole-picture tile
# layers at fit then zoomed into the next level evicts older levels' pages, returns the GPU canvas, and brings
# `stats().atlas.bytes` back under the budget).
ATLAS_BUDGET = r"""
(async () => {
    const shell = await import("./shell.js");
    const { GLCompositor } = await import("./editor/inpaint_compositor.js");
    const { TileLayerPixels } = await import("./editor/inpaint_tiles.js");
    const W = 4352, H = 4352;   // 17 x 17 = 289 tiles per store (two atlas pages per store at levels 1..3)
    const MB = 1048576;
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const fillTiles = (c, seed, alpha) => {
        const x = c.getContext("2d");
        x.clearRect(0, 0, c.width, c.height);
        for (let ty = 0; ty < 17; ty++) {
            for (let tx = 0; tx < 17; tx++) {
                const r = (tx * 37 + ty * 13 + seed * 71 + 40) & 255;
                const g = (tx * 19 + ty * 43 + seed * 113 + 70) & 255;
                const b = (tx * 53 + ty * 29 + seed * 59 + 90) & 255;
                x.fillStyle = `rgba(${r},${g},${b},${alpha})`;
                x.fillRect(tx * 256, ty * 256, 256, 256);
            }
        }
        return c;
    };
    const problems = [];
    const check = (name, ok, detail) => { if (!ok) problems.push(name + (detail !== undefined ? " (" + JSON.stringify(detail) + ")" : "")); };

    const before = window.editor;
    const ed = shell.newDocument();
    shell.activate(ed);
    await new Promise((r) => setTimeout(r, 200));
    ed.resizeCanvas();
    const tilesMode = !!ed.tileMode;
    let ownComp = null;
    let savedBudget = null;

    try {
        const cBase = fillTiles(mk(W, H), 0, 1);
        const cL1 = fillTiles(mk(W, H), 1, 1);
        const cL2 = fillTiles(mk(W, H), 2, 1);
        Object.defineProperty(cBase, "naturalWidth", { value: W });
        Object.defineProperty(cBase, "naturalHeight", { value: H });

        // Reference composite at 2176 x 2176 (level 1, exact 2:1 on 256x256 solid tiles) via Canvas 2D alone
        const refC = mk(2176, 2176), refX = refC.getContext("2d");
        refX.imageSmoothingEnabled = false;
        refX.drawImage(cBase, 0, 0, 2176, 2176);
        refX.globalCompositeOperation = "multiply";
        refX.globalAlpha = 0.8;
        refX.drawImage(cL1, 0, 0, 2176, 2176);
        refX.globalCompositeOperation = "screen";
        refX.globalAlpha = 0.75;
        refX.drawImage(cL2, 0, 0, 2176, 2176);
        refX.globalCompositeOperation = "source-over";
        refX.globalAlpha = 1;
        const refBytes = refX.getImageData(0, 0, 2176, 2176).data;

        let comp = null;
        let px0 = null, px1 = null, px2 = null;
        if (tilesMode) {
            await ed.setBase({ filename: "atlas_base.png", subfolder: "inpaint_canvas", type: "input" }, cBase, { keepLayers: false });
            ed.addLayer({ name: "paint-1", kind: "paint", px: TileLayerPixels.fromCanvas(cL1), x: 0, y: 0, w: W, h: H, dirty: true, blend: "multiply", opacity: 0.8 });
            ed.addLayer({ name: "paint-2", kind: "paint", px: TileLayerPixels.fromCanvas(cL2), x: 0, y: 0, w: W, h: H, dirty: true, blend: "screen", opacity: 0.75 });
            ed.renderLayers();
            ed.fitView();
            ed.draw();
            await ed.mipsSettled();
            comp = ed.compositor();
            savedBudget = comp ? comp.stats().atlas.budget : null;
            px0 = ed.basePx;
            px1 = ed.layers[0].px;
            px2 = ed.layers[1].px;
        } else {
            // Also exercise GLCompositor + TileLayerPixels directly when the app runs with --tiles off
            const edComp = ed.compositor();
            const prevEd = edComp ? edComp.stats().atlas.budget : null;
            if (edComp) edComp.setAtlasBudget(2048 * MB);
            check("editor compositor setAtlasBudget(2048 MB) on canvas backend", !!edComp && edComp.stats().atlas.budget === 2048 * MB, edComp ? edComp.stats().atlas.budget : null);
            if (edComp) edComp.setAtlasBudget(prevEd);
            ownComp = GLCompositor.available() ? new GLCompositor() : null;
            comp = ownComp;
            px0 = TileLayerPixels.fromCanvas(cBase);
            px1 = TileLayerPixels.fromCanvas(cL1);
            px2 = TileLayerPixels.fromCanvas(cL2);
            for (const px of [px0, px1, px2]) {
                for (let ty = 0; ty < 17; ty++) for (let tx = 0; tx < 17; tx++) px._stampAt(tx, ty, 1, false);
            }
        }
        if (!comp) { problems.push("no WebGL2 compositor"); return { tiles: tilesMode, problems }; }
        comp.clear();

        const runLevel = (level, rw = W, rh = H) => {
            const vw = rw >> level, vh = rh >> level;
            const region = { x: 0, y: 0, w: rw, h: rh };
            if (tilesMode && rw === W && rh === H) {
                return ed.glViewComposite(region, vw, vh, {});
            }
            return comp.composite({
                width: vw,
                height: vh,
                region,
                layers: [
                    { pixels: px0, mask: null, level, x: 0, y: 0, w: W, h: H, opacity: 1, blend: "normal" },
                    { pixels: px1, mask: null, level, x: 0, y: 0, w: W, h: H, opacity: 0.8, blend: "multiply" },
                    { pixels: px2, mask: null, level, x: 0, y: 0, w: W, h: H, opacity: 0.75, blend: "screen" },
                ],
            });
        };

        // 1. tiles/T2: setAtlasBudget handles >= 2048 MB without 32-bit `| 0` overflow, floors fractions, and clamps [16 MB, 16384 MB]
        const budgetCases = [
            [2048 * MB, 2048 * MB],
            [3072 * MB, 3072 * MB],
            [4096 * MB, 4096 * MB],
            [5000 * MB, 5000 * MB],
            [16384 * MB, 16384 * MB],
            [32768 * MB, 16384 * MB],
            [Infinity, 16384 * MB],
            [64 * MB + 0.75, 64 * MB],
            [0, 16 * MB],
            [-500, 16 * MB],
            [-Infinity, 16 * MB],
            [NaN, 16 * MB],
            [undefined, 16 * MB],
        ];
        for (const [inp, want] of budgetCases) {
            comp.setAtlasBudget(inp);
            const got = comp.stats().atlas.budget;
            check("setAtlasBudget(" + String(inp) + ")", got === want, { got, want });
        }

        // Live composite with 2048 MB budget holds all 3 stores at level 1 (~56.5 MB > 16 MB) with zero evictions
        comp.setAtlasBudget(2048 * MB);
        comp.clear();
        const c2048 = runLevel(1);
        const st2048 = comp.stats().atlas;
        check("2048 MB budget composites 3 whole-picture layers (> 16 MB) without evicting",
            c2048 === comp.canvas && st2048.bytes === 59217600 && st2048.pages === 6,
            { ok: c2048 === comp.canvas, bytes: st2048.bytes, pages: st2048.pages });

        // 2. tiles/T1: small budget (64 MB), plain stack of 3 whole-picture tile layers, level 3 -> fit (level 2) -> zoom (level 1)
        const budget64 = 64 * MB;
        comp.clear();
        comp.setAtlasBudget(budget64);

        const cLv3 = runLevel(3);   // frame A: level 3 (6 pages, 4,050,624 bytes)
        const stLv3 = comp.stats().atlas;
        const cFit = runLevel(2);   // frame B: fit at level 2 (6 pages, 15,263,424 bytes; total 19,314,048 bytes)
        const stFit = comp.stats().atlas;
        check("fit (level 2) composites under 64 MB budget",
            cLv3 === comp.canvas && cFit === comp.canvas && stFit.bytes === 19314048 && stFit.pages === 12,
            { lv3Bytes: stLv3.bytes, fitBytes: stFit.bytes, pages: stFit.pages });

        // Exact-boundary check (`atlasBytes === atlasBudget`): a new 1-tile layer still evicts an unused page and succeeds
        const oneTileC = mk(256, 256);
        oneTileC.getContext("2d").fillStyle = "#ff8040";
        oneTileC.getContext("2d").fillRect(0, 0, 256, 256);
        const extraPx = TileLayerPixels.fromCanvas(oneTileC);
        extraPx._stampAt(0, 0, 2, false);
        comp.setAtlasBudget(stFit.bytes);   // exact equality: atlasBytes === atlasBudget (19,314,048 >= 16 MB)
        const cExact = comp.composite({
            width: 64, height: 64, region: { x: 0, y: 0, w: 256, h: 256 },
            layers: [{ pixels: extraPx, mask: null, level: 2, x: 0, y: 0, w: 256, h: 256, opacity: 1, blend: "normal" }],
        });
        check("exact atlasBytes === atlasBudget boundary evicts an old page for a new entry",
            cExact === comp.canvas && comp.stats().atlas.bytes <= stFit.bytes,
            { ok: cExact === comp.canvas, bytes: comp.stats().atlas.bytes, budget: stFit.bytes });
        comp.forgetPixels(extraPx);

        // Re-establish clean level 3 (older) -> fit level 2 (newer), then zoom into level 1 (crosses 64 MB mid-frame on store 2)
        comp.clear();
        comp.setAtlasBudget(budget64);
        runLevel(3);
        runLevel(2);
        const cZoom = runLevel(1);
        const stZoom = comp.stats().atlas;
        let lv3Pages = 0, lv2Pages = 0, lv1Pages = 0;
        for (const rec of comp.atlas.values()) {
            if (rec.levels.get(3)) lv3Pages += rec.levels.get(3).pages.length;
            if (rec.levels.get(2)) lv2Pages += rec.levels.get(2).pages.length;
            if (rec.levels.get(1)) lv1Pages += rec.levels.get(1).pages.length;
        }
        check("zoom into level 1 over 64 MB budget evicts older pages, returns GPU canvas, and ends <= budget",
            cZoom === comp.canvas && stZoom.bytes <= budget64 && lv1Pages === 6 && lv3Pages === 0 && lv2Pages > 0,
            { ok: cZoom === comp.canvas, bytes: stZoom.bytes, budget64, lv1Pages, lv2Pages, lv3Pages });

        // Compare the whole 2176 x 2176 GPU output against the Canvas 2D reference (both Page 1 tiles and Page 2 tile (16, 16))
        if (cZoom) {
            const rd = mk(2176, 2176), rx = rd.getContext("2d");
            rx.drawImage(cZoom, 0, 0);
            const gotBytes = rx.getImageData(0, 0, 2176, 2176).data;
            let maxDiff = 0, minCh = 255, maxCh = 0;
            for (let i = 0; i < gotBytes.length; i += 4) {
                for (let k = 0; k < 4; k++) {
                    const v = gotBytes[i + k];
                    if (k < 3) { if (v < minCh) minCh = v; if (v > maxCh) maxCh = v; }
                    const d = Math.abs(v - refBytes[i + k]);
                    if (d > maxDiff) maxDiff = d;
                }
            }
            const p2Idx = (2100 * 2176 + 2100) * 4;   // inside tile (16, 16), which lives on the 2nd page of every store
            const p2Diff = Math.max(
                Math.abs(gotBytes[p2Idx] - refBytes[p2Idx]),
                Math.abs(gotBytes[p2Idx + 1] - refBytes[p2Idx + 1]),
                Math.abs(gotBytes[p2Idx + 2] - refBytes[p2Idx + 2]),
                Math.abs(gotBytes[p2Idx + 3] - refBytes[p2Idx + 3]),
            );
            check("zoom level 1 GPU composite matches Canvas 2D across whole 2176x2176 buffer (including 2nd-page tiles)",
                maxCh - minCh > 100 && maxDiff <= 2 && p2Diff <= 2,
                { span: maxCh - minCh, maxDiff, p2Diff });
        } else {
            check("zoom level 1 GPU composite produced pixels", false, "cZoom was null");
        }

        // 2b. Panning left by 1 tile column at level 1 when over budget keeps the entry's own full 256-slot page
        // even when another entry's unused page is newer, uploading only the 16 new column-0 tiles
        comp.clear();
        comp.setAtlasBudget(64 * MB);
        comp.composite({
            width: 2048, height: 2048, region: { x: 256, y: 0, w: 4096, h: 4096 },
            layers: [{ pixels: px0, mask: null, level: 1, x: 0, y: 0, w: W, h: H, opacity: 1, blend: "normal" }],
        });   // frame 1: px0 level 1 fills one 16x16 page (17,305,600 bytes, 0 free slots)
        comp.composite({
            width: 1088, height: 1088, region: { x: 0, y: 0, w: W, h: H },
            layers: [{ pixels: px1, mask: null, level: 2, x: 0, y: 0, w: W, h: H, opacity: 1, blend: "normal" }],
        });   // frame 2 (newer): px1 level 2 adds 5,087,808 bytes (total 22,393,408 bytes > 20 MB)
        comp.setAtlasBudget(20 * MB);
        const upBeforePan = comp.stats().atlas.uploads;
        const cPan = comp.composite({
            width: 2176, height: 2048, region: { x: 0, y: 0, w: W, h: 4096 },
            layers: [{ pixels: px0, mask: null, level: 1, x: 0, y: 0, w: W, h: H, opacity: 1, blend: "normal" }],
        });
        const panUploads = comp.stats().atlas.uploads - upBeforePan;
        check("panning left by 1 tile column preserves entry's own page and uploads only 16 new tiles",
            cPan === comp.canvas && panUploads === 16 && comp.stats().atlas.bytes <= 20 * MB,
            { ok: cPan === comp.canvas, panUploads, bytes: comp.stats().atlas.bytes });

        // 3. Genuinely unachievable single-frame stack under 16 MB budget returns null cleanly, drops empty records, and recovers at fit
        const budget16 = 16 * MB;
        comp.clear();
        comp.setAtlasBudget(budget16);
        comp.composite({
            width: 64, height: 64, region: { x: 0, y: 0, w: 256, h: 256 },
            layers: [{ pixels: extraPx, mask: null, level: 2, x: 0, y: 0, w: 256, h: 256, opacity: 1, blend: "normal" }],
        });
        const cOver = comp.composite({
            width: 3840, height: 3840, region: { x: 0, y: 0, w: 3840, h: 3840 },
            layers: [
                { pixels: px0, mask: null, level: 0, x: 0, y: 0, w: W, h: H, opacity: 1, blend: "normal" },
                { pixels: px1, mask: null, level: 0, x: 0, y: 0, w: W, h: H, opacity: 0.8, blend: "multiply" },
            ],
        });
        const stOver = comp.stats().atlas;
        const cRecover = runLevel(2);
        const stRecover = comp.stats().atlas;
        check("over-budget null return cleans up emptied records and next fit frame recovers under 16 MB",
            cOver === null && stOver.sources === 1 && cRecover === comp.canvas && stRecover.bytes === 15263424 && stRecover.bytes <= budget16,
            { overNull: cOver === null, overSources: stOver.sources, recovered: cRecover === comp.canvas, recoverBytes: stRecover.bytes });
    } finally {
        if (savedBudget != null && ed._compositor) ed._compositor.setAtlasBudget(savedBudget);
        if (ownComp) ownComp.dispose();
        shell.closeDocument(ed, { force: true });
        if (before) shell.activate(before);
    }
    return { tiles: tilesMode, problems };
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
        # every blend mode is native or emulated
        ne = await c.eval(EVERY_MODE_NATIVE_OR_EMULATED, timeout=30)
        if ne.get("failures"):
            ok = False
            print(f"[FAIL] every_mode_is_native_or_emulated: {'; '.join(ne['failures'])}")
        else:
            print(f"[ok] every_mode_is_native_or_emulated: {ne.get('count')} modes verified")
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
            # C6 (c) 7b / 7c: the screen takes a colour-matched layer's statistics from the entry every region pass shares
            # (the layer's whole surroundings at 256 px), the references were taken with the view's own: the matched layer
            # of the view is up to 3 levels apart on both backends, and only there (measured); the full-resolution
            # composite keeps its own statistics and stays identical
            tol = max(args.tolerance, 3) if name == "view" else args.tolerance
            # linear light (0.1.32) needs no tolerance of its own: both backends give the same bytes in its column, the grain
            # over it included (measured 2026-09-28; the 4 levels seen then were references taken before the emulation's
            # opacity moved out of its 8-bit scratch)
            if diff.get("differing", 0) == 0:
                print(f"[ok] {name}: identical")
            elif diff.get("max", 999) <= tol:
                print(f"[ok] {name}: max {diff['max']} levels, mean {diff['mean']:.3f} (within {tol})")
            else:
                ok = False
                print(f"[FAIL] {name}: max {diff.get('max')} levels, mean {diff.get('mean')}, "
                      f"{diff.get('differing')} of {diff.get('bytes')} bytes differ ({diff}). Current: {cur}, reference: {ref}")
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
        # a switched-off mask is no mask on every path, and a mask that is on is not
        mo = await c.eval(MASK_OFF, timeout=300)
        if mo.get("skipped"):
            print(f"[skip] mask off: {mo['skipped']}")
        else:
            problems = []
            for k, v in mo.items():
                if v["offVsNone"] is None and k == "png":
                    continue   # no worker export on this backend: reported below
                if v["offVsNone"] is None or v["offVsNone"]["n"] != 0:
                    problems.append(f"{k}: switched off differs from no mask ({v['offVsNone']})")
                if v["onVsOff"] is None or v["onVsOff"]["n"] == 0:
                    problems.append(f"{k}: the mask on draws the same as off ({v['onVsOff']})")
            line = "mask off: " + ", ".join(f"{k} off/none {v['offVsNone']} on/off {v['onVsOff']}" for k, v in mo.items())
            if problems:
                ok = False
                print(f"[FAIL] {line}: " + "; ".join(problems))
            else:
                print(f"[ok] {line}")
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
        # plain filter layers on see-through documents replace their input on every path, and opaque / non-plain
        # filter layers match the frozen references from base 2068af87
        stf = await c.eval(SEE_THROUGH_FILTERS, timeout=300)
        if stf.get("problems"):
            ok = False
            print(f"[FAIL] see_through_filters ({'tiles' if stf.get('tiles') else 'canvas'}): " + "; ".join(stf["problems"]))
        else:
            print(f"[ok] see_through_filters ({'tiles' if stf.get('tiles') else 'canvas'}): plain filters replace input on all paths (alpha 128); opaque and non-plain match frozen 2068af87")
        # tile atlas budget clamping (tiles/T2) and over-budget eviction across zoom levels (tiles/T1)
        ab = await c.eval(ATLAS_BUDGET, timeout=300)
        if ab.get("problems"):
            ok = False
            print(f"[FAIL] atlas_budget ({'tiles' if ab.get('tiles') else 'canvas'}): " + "; ".join(ab["problems"]))
        else:
            print(f"[ok] atlas_budget ({'tiles' if ab.get('tiles') else 'canvas'}): >= 2048 MB budgets clamped without 32-bit wrap; over-budget zoom evicts older levels and stays under 64 MB")
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
