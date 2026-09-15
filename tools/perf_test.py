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

The operation rows ("blocked [wall]") time an operation, not a frame. On tiles with the mips worker
(C6 b) an operation starts only once no mip chain of the rows before it is on its way
(`ed.mipsSettled()`), so a row is not charged with their landings, and its probe of the main thread
runs until the chains the operation itself asked for have landed: "blocked" is the longest the window
was held by the operation or by the landings and redraws it caused. "wall" stays the operation's own
time. "its landings" under invert counts the colour matches and filter passes the screen ran again
while those chains landed; its bracket is the longest block from the end of the operation until they
had landed, whatever held the window: it includes the selection's background encode and any other
timer of that window, not only the landings and their draws.
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
    window.__perf = { shell: await import("./shell.js"), host: (await import("./editor/host.js")).host, pixels: await import("./editor/inpaint_pixels.js") };
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
    const { Layer: LayerPixels } = ed.pixels;   // the editor's backend (tiles or canvases)
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
        ed.addLayer({ name: `Paint ${i + 1}`, kind: "paint", px: LayerPixels.fromCanvas(c), x: 0, y: 0, w: W, h: H, dirty: true });
    }
    // a result layer with colour match, like an inpaint result over the selection
    const rw = Math.min(2048, Math.round(W / 3)), rh = Math.min(2048, Math.round(H / 3));
    const res = paint(mk(rw, rh), 20, 20);
    const resLayer = ed.addLayer({ name: "Result", kind: "result", px: LayerPixels.fromCanvas(res), x: Math.round(W / 4), y: Math.round(H / 4), w: rw, h: rh, dirty: true });
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
    // C6 (b): the chains of this first frame are in the mips worker; the rows below start from the exact picture, as
    // they did when that frame built all of them itself
    await ed.mipsSettled();
    ed.sceneSig = null;
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
    // 1:1, no display levels: the stack (with its filter layer, so on Canvas 2D) draws the layers' own display
    // canvases; on tiles a CPU mirror drawn there moved all of it every frame (C2 step b's review)
    ed.view.scale = 1; ed.view.angle = 0; ed._fitted = false;
    ed.view.x = Math.round(ed.canvas.width / 2 - W / 2); ed.view.y = Math.round(ed.canvas.height / 2 - H / 2);
    ed.draw(); ed.draw();
    out.pan_1to1 = bench((i) => { ed.view.x += (i %% 2 ? -7 : 9); ed.view.y += 3; ed.draw(); }, 30);
    // The same two pans with the filter layer hidden, so the GPU compositor takes the stack: since C3
    // it draws a tile store's own tiles from its atlas, with no display mirror and no GPU copy of one.
    {
        const fxLayer = ed.layers.find((l) => l.kind === "filter");
        if (fxLayer) fxLayer.visible = false;
        ed.sceneSig = null; ed.draw(); ed.draw();
        out.gl_stack = ed.glCompositeUsable({}) ? 1 : 0;
        out.pan_1to1_gl = bench((i) => { ed.view.x += (i %% 2 ? -7 : 9); ed.view.y += 3; ed.draw(); }, 30);
        ed.fitView(); ed.draw(); await ed.mipsSettled(); ed.draw(); ed.draw();   // C6 (b): the fit level's chains, if any were asked for
        out.pan_fit_gl = bench((i) => { ed.view.x += (i %% 2 ? -7 : 9); ed.view.y += 3; ed.draw(); }, 30);
        // and the first frame after a zoom from fit back to 1:1: what the level the screen needs costs
        ed.fitView(); ed.draw(); ed.draw();
        const zt = performance.now();
        ed.view.scale = 1; ed._fitted = false;
        ed.view.x = Math.round(ed.canvas.width / 2 - W / 2); ed.view.y = Math.round(ed.canvas.height / 2 - H / 2);
        ed.draw();
        out.first_1to1_gl = [+(performance.now() - zt).toFixed(1), +(performance.now() - zt).toFixed(1)];
        const cst = ed.compositor() ? ed.compositor().stats() : null;
        out.glMB = cst && cst.atlas ? { atlas: +(cst.atlas.bytes / 1048576).toFixed(1), pages: cst.atlas.pages, slots: cst.atlas.slots, textures: +(cst.bytes / 1048576).toFixed(1) } : null;
        if (fxLayer) fxLayer.visible = true;
    }
    // --- C6 (b): whole changes on the GPU stack (the filter layer and the colour-matched result hidden). They replace a
    // paint layer twice and clear the undo steps, so every row after this block runs on that document; a run with the
    // block moved after the last row (the C6 b review) is the A/B of those rows against the log before C6 b ----------
    {
        const fxLayer = ed.layers.find((l) => l.kind === "filter");
        if (fxLayer) fxLayer.visible = false;
        // the colour-matched result above the replaced layer hidden too: a whole change under it invalidates its match,
        // which is not a mips cost (the build's rows were 29 to 33 ms with it against 18 to 25 in the two-layer measurement)
        const matched = ed.layers.filter((l) => l.visible && l.match && l.match.strength > 0);
        for (const l of matched) l.visible = false;
        // C6 (b): the first frame after a whole change of a paint layer (its pixels replaced, as a flip or a turn does),
        // what a whole touch after a small write costs, and how long the mips worker takes until the screen is exact
        // again. The operation itself (the band copies of a flip) is not timed: the rows are the frame after it, which
        // markLayerChanged, the layer list and the draw make, as flipLayer runs them.
        const target = ed.layers.find((l) => l.kind === "paint");
        const settleNow = () => {   // the benchmark's settle, without the paint layer's canvasOf (a mirror on tiles)
            const { canvasOf } = window.__perf.pixels;
            for (const c of [canvasOf(ed.sel), ed.viewCanvas, ed.sceneCanvas, ed.canvas]) { try { if (c) c.getContext("2d").getImageData(0, 0, 1, 1); } catch (_) { /* no 2D context */ } }
            try { const comp = ed.compositor(); if (comp) comp.gl.finish(); } catch (_) { /* no compositor */ }
        };
        const gaps = () => {
            let last = performance.now(), most = 0, stop = false;
            const tick = () => { const now = performance.now(); if (now - last > most) most = now - last; last = now; if (!stop) setTimeout(tick, 1); };
            setTimeout(tick, 1);
            return () => { stop = true; return +most.toFixed(1); };
        };
        const replaced = async (label) => {
            await ed.mipsSettled(); ed.sceneSig = null; ed.draw(); settleNow();
            ed.pushUndo({ kind: "layerfull", id: target.id });
            if (ed.tileMode) target.px = ed.turnedTilePixels(target.px, "h");
            else { const c = target.px.toCanvas(), f = document.createElement("canvas"); f.width = c.width; f.height = c.height; const x = f.getContext("2d"); x.translate(c.width, 0); x.scale(-1, 1); x.drawImage(c, 0, 0); target.px = ed.pixels.Layer.fromCanvas(f); f.width = 1; c.width = 1; }
            await new Promise((r) => setTimeout(r, 30));
            const T = await import("./editor/inpaint_tiles.js");
            T.chainStats(true);
            const t0 = performance.now();
            ed.markLayerChanged(target);
            ed.renderLayers();
            ed.draw();
            out[label] = [+(performance.now() - t0).toFixed(1), +(performance.now() - t0).toFixed(1)];
            const cs = T.chainStats();
            out[label + "_chains"] = [cs.main + cs.thumb, cs.requested];   // built on this thread in the frame (kept + thumbnail scratch), asked of the worker
            // settled: from the end of the frame until no chain is on its way (the landings' own tasks and frames
            // included); [1] the longest the main thread was held meanwhile (the gaps of a 1 ms timer: a landing, the
            // thumbnails it redraws, a frame), which a timer around draw() alone did not see
            const s0 = performance.now();
            const held = gaps();
            await ed.mipsSettled();
            const settledMs = performance.now() - s0;
            await new Promise((r) => setTimeout(r, 50));   // drained: the last landing's frame is not the next row's
            out[label + "_settled"] = [+settledMs.toFixed(1), held()];
            const cs2 = T.chainStats();
            out[label + "_landed"] = [cs2.landed, cs2.handed];
            ed.clearUndo();
        };
        ed.fitView(); ed.sceneSig = null; ed.draw();
        out.whole_level = ed.tileLevel(ed.view.scale);
        out.whole_level_row = [out.whole_level, ed.glCompositeUsable({}) ? 1 : 0];   // [level, GPU stack]
        await replaced("whole_fit_gl");
        {
            await ed.mipsSettled(); ed.sceneSig = null; ed.draw(); settleNow();
            target.px.fill([Math.round(W / 2), Math.round(H / 2), Math.round(W / 2) + 100, Math.round(H / 2) + 100], "#123456");
            await new Promise((r) => setTimeout(r, 30));
            const t0 = performance.now();
            ed.markLayerChanged(target);
            ed.renderLayers();
            ed.draw();
            out.touch_fit_gl = [+(performance.now() - t0).toFixed(1), +(performance.now() - t0).toFixed(1)];
        }
        ed.view.scale = 1; ed._fitted = false;
        ed.view.x = Math.round(ed.canvas.width / 2 - W / 2); ed.view.y = Math.round(ed.canvas.height / 2 - H / 2);
        ed.sceneSig = null; ed.draw();
        await replaced("whole_1to1_gl");
        if (fxLayer) fxLayer.visible = true;
        for (const l of matched) l.visible = true;
    }

    ed.fitView();
    ed.sceneSig = null;
    ed.draw();

    // --- a brush stroke on a paint layer ---------------------------------------
    ed.setTool("paint");
    ed.activeLayerId = paintLayer.id;
    ed.brushSize = 40;
    const p = { kind: "layerpaint", layer: paintLayer, stroke: ed.newStrokeBuffer(paintLayer.px), clip: null, erase: false, last: [10, 10], pressure: 1 };
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
    const strokeBox = ed.strokeRect(p, paintLayer.px);   // what the real pointer-up passes on
    ed.commitStroke(p);
    ed.pointer = null;
    ed.markLayerChanged(paintLayer, strokeBox);
    out.stroke_commit = [+(performance.now() - commitAt).toFixed(1), +(performance.now() - strokeStart).toFixed(1)];
    out.undo_bytes = ed.undoBytes;
    // The 60 frames above were issued in a tight loop, so the GPU still holds their work; a
    // real stroke is paced by the display. Drain it, so the rows below measure their own cost
    // and not that backlog (a readback of one pixel waits for a canvas's queue). The canvases read
    // are the ones the frames drew into and the pixels' display canvases: on tiles a readRect reads
    // renderer memory and waits for nothing, so the drain cannot go through the pixels (C2 step b).
    const { canvasOf } = window.__perf.pixels;
    const settle = () => {
        for (const c of [canvasOf(ed.sel), canvasOf(paintLayer.px), ed.viewCanvas, ed.sceneCanvas, ed.canvas]) {
            try { if (c) c.getContext("2d").getImageData(0, 0, 1, 1); } catch (_) { /* no 2D context */ }
        }
        try { const comp = ed.compositor(); if (comp) comp.gl.finish(); } catch (_) { /* no compositor */ }
    };
    ed.draw();
    settle();
    const undoAt = performance.now();
    await ed.undoStep();
    out.undo_step = [+(performance.now() - undoAt).toFixed(1), 0];

    // --- selection, autosave, full composite ------------------------------------
    settle();
    const selAt = performance.now();
    // a fill of the rectangle, not a drawInto of the whole selection: on tiles that is a full-size scratch, and the row would time the harness
    ed.sel.fill([Math.round(W / 5), Math.round(H / 5), Math.round(W / 5) + Math.round(W / 3), Math.round(H / 5) + Math.round(H / 3)], "#ff0000");
    ed.markSelectionChanged([Math.round(W / 5), Math.round(H / 5), Math.round(W / 5 + W / 3), Math.round(H / 5 + H / 3)]);
    out.selection_change = [+(performance.now() - selAt).toFixed(1), 0];
    out.get_value = bench(() => ed.getValue(), 3);
    out.bounds_scan = bench(() => { ed.selectionDirty = true; ed.getBounds(); }, 3);
    out.draw_with_ants = bench(() => { ed.pixelVersion++; ed.draw(); }, 10);
    out.full_composite = bench(() => { ed.flatCache = null; ed.flattenToCanvas({ forRun: true }); }, 3);

    // --- operations that are not per frame: how long do they hold the main thread? -----
    // (sample it every millisecond and take the longest gap; wall time and blocking are
    // very different things once the worker does the work)
    // `since`: the longest gap that started at or after that time (whatever ran after an operation: its landings, its
    // selection encode, any other timer)
    const probe = () => {
        let last = performance.now(), worst = 0, stop = false;
        const gaps = [];
        const tick = () => { const now = performance.now(); if (now - last > worst) worst = now - last; if (now - last > 4) gaps.push([last, now - last]); last = now; if (!stop) setTimeout(tick, 0); };
        setTimeout(tick, 0);
        return (since = -Infinity) => { stop = true; return since === -Infinity ? +worst.toFixed(1) : +Math.max(0, ...gaps.filter((q) => q[0] >= since).map((q) => q[1])).toFixed(1); };
    };
    // the screen's colour matches and filter passes run again (a cache miss of a screen pass), counted while `on`
    const reruns = { on: false, n: 0 };
    for (const [name, slotOf] of [["matchStats", () => "_mstatsView"], ["filteredCanvas", () => "_fcacheView"]]) {
        const f = ed[name];
        ed[name] = function (layer, ...a) {
            if (!reruns.on || !(this.viewPass && this.viewPass.screen)) return f.call(this, layer, ...a);
            const was = layer[slotOf()];
            try { return f.call(this, layer, ...a); } finally { if (layer[slotOf()] !== was) reruns.n++; }
        };
    }
    let landings = null;
    const op = async (fn) => {
        // C6 (b): the chains the rows before asked for land first, so this row is not charged with them
        await ed.mipsSettled();
        await new Promise((r) => setTimeout(r, 60));
        settle();   // the row before may have left GPU work queued; this row measures its own
        await new Promise((r) => setTimeout(r, 30));
        const done = probe();
        const t0 = performance.now();
        await fn();
        const t1 = performance.now();
        const wall = +(t1 - t0).toFixed(1);
        // ... and the probe runs on until the chains this operation asked for have landed and been drawn
        reruns.n = 0; reruns.on = true;
        await ed.mipsSettled();
        await new Promise((r) => setTimeout(r, 30));
        reruns.on = false;
        landings = [reruns.n, done(t1)];
        return [done(), wall];   // [blocked, wall]
    };
    const rect = () => {
        ed.sel.clear();
        ed.sel.fill([Math.round(W * 0.2), Math.round(H * 0.2), Math.round(W * 0.2) + Math.round(W * 0.4), Math.round(H * 0.2) + Math.round(H * 0.4)], "#ff0000");
        ed.markSelectionChanged();
        ed.getBounds();
    };
    rect();
    out.grow = await op(() => ed.growSelection(16));
    out.shrink = await op(() => ed.growSelection(-16));
    out.invert = await op(() => ed.invertSelection());
    // C6 (b2): with the filter layer and the colour-matched result visible, the landings of the inverted selection's
    // chains redraw the overlays only; they used to run the match and the filter again per batch of chains
    out.invert_landings = landings;
    rect();
    out.feather = await op(() => ed.featherSelection(8));
    rect();
    out.wand = await op(() => ed.wandSelect(Math.round(W * 0.1), Math.round(H * 0.1), "replace"));   // on the gradient: a band across the whole picture
    rect();
    out.wand_object = await op(() => ed.wandSelect(977, 613, "replace"));   // inside one of the base's discs: a bounded region
    rect();
    ed.activeLayerId = paintLayer.id;
    out.bucket = await op(() => ed.bucketFill(Math.round(W * 0.25), Math.round(H * 0.25)));
    // a fill and a clear of a 100 px selection on the paint layer, and the undo of the fill: on tiles each was a
    // whole-layer write and a whole-layer undo copy until C2's final review
    const small = () => {
        ed.sel.clear();
        ed.sel.fill([Math.round(W * 0.5), Math.round(H * 0.5), Math.round(W * 0.5) + 100, Math.round(H * 0.5) + 100], "#ff0000");
        ed.markSelectionChanged();
        ed.getBounds();
    };
    small();
    ed.activeLayerId = paintLayer.id;
    ed.color = "#00ff00"; ed.brushOpacity = 1;
    out.fill_small = await op(() => ed.fillSelection());
    out.undo_fill = await op(() => ed.undoStep());
    out.clear_small = await op(() => ed.clearSelectedPixels());
    // A stroke right across the picture, clipped to a selection: the stroke buffer's box is then the
    // whole picture while the dabs touch a few per cent of it. Until C5 every frame of it made a
    // clipped copy of the whole box (two canvases of 561 MB at 15k) and the commit was one drawInto
    // of that box; both go band by band over the cells a dab drew into now. The undo copy is left
    // out of the commit row (it is the whole box, and C4's to fix), so the row is C5's part alone.
    ed.sel.clear();
    ed.sel.fill([0, 0, W, H], "#ff0000");
    ed.markSelectionChanged();
    ed.getBounds();
    ed.activeLayerId = paintLayer.id;
    ed.brushSize = 60; ed.brushOpacity = 1;
    const lp = { kind: "layerpaint", layer: paintLayer, stroke: ed.newStrokeBuffer(paintLayer.px),
                 clip: ed.strokeClip(paintLayer, paintLayer.px), erase: false, last: [200, 200], pressure: 1, noUndo: true };
    ed.pointer = lp;
    out.long_stroke = await op(() => {
        for (let i = 1; i <= 40; i++) {
            const x = 200 + i * (W - 400) / 40, y = 200 + i * (H - 400) / 40;
            ed.layerDab(lp, lp.last[0], lp.last[1], x, y);
            lp.last = [x, y];
            ed.draw();
        }
    });
    out.long_buffer = [lp.stroke.w, lp.stroke.h, lp.stroke.cells ? lp.stroke.cells.size : 0];
    const lbox = ed.strokeRect(lp, paintLayer.px);
    out.long_commit = await op(() => { ed.commitStroke(lp); ed.pointer = null; ed.markLayerChanged(paintLayer, lbox); ed.releaseStrokeScratch(); });
    const flat = ed.flattenToCanvas({ forRun: true });
    // the editor's own path (the worker when there is one), and the plain main-thread encode
    out.png = await op(async () => { const u = await ed.snapUrl(flat); URL.revokeObjectURL(u); });
    out.png_main = await op(() => new Promise((r) => flat.toBlob(r, "image/png")));

    let mem = null;
    try { mem = Math.round((await performance.measureUserAgentSpecificMemory()).bytes / 1048576); } catch (_) { /* needs isolation */ }

    const view = `${ed.canvas.width}x${ed.canvas.height}`;
    // what the display costs on tiles: the mirrors C3 has not taken away yet, the region canvases it
    // introduced (the selection's overlay) and the Skia pyramids still built for the Canvas 2D path
    const rep = ed.memoryReport();
    const display = rep.tiles ? {
        mirrors: rep.tiles.mirrors, mirrorMB: +(rep.tiles.mirrorBytes / 1048576).toFixed(1),
        regions: rep.tiles.regions || 0, regionMB: +((rep.tiles.regionBytes || 0) / 1048576).toFixed(1),
        pyramidMB: +(rep.pyramid.bytes / 1048576).toFixed(1),
    } : null;
    shell.closeDocument(ed, { force: true });
    if (before) shell.activate(before);
    return JSON.stringify({ size: `${W}x${H}`, mp: +(W * H / 1e6).toFixed(1), filter: fxId, setBase: Math.round(setBaseMs), memMB: mem, view, display, ...out });
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
    ("pan at 1:1 (30 frames)", "pan_1to1"),
    ("pan at 1:1, GPU stack", "pan_1to1_gl"),
    ("pan at fit, GPU stack", "pan_fit_gl"),
    ("first frame fit -> 1:1, GPU", "first_1to1_gl"),
    ("frame after a whole change, fit", "whole_fit_gl"),
    ("  mips settled [longest block]", "whole_fit_gl_settled"),
    ("  chains built here [asked]", "whole_fit_gl_chains"),
    ("  chains landed [handed]", "whole_fit_gl_landed"),
    ("frame after a whole change, 1:1", "whole_1to1_gl"),
    ("  mips settled [longest block]", "whole_1to1_gl_settled"),
    ("  chains built here [asked]", "whole_1to1_gl_chains"),
    ("  chains landed [handed]", "whole_1to1_gl_landed"),
    ("frame after a whole touch, fit", "touch_fit_gl"),
    ("  (the level of fit, whole-change rows)", "whole_level_row"),
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
    ("  its landings: re-runs [longest block until settled]", "invert_landings"),
    ("feather 8", "feather"),
    ("magic wand (whole-image band)", "wand"),
    ("magic wand (an object)", "wand_object"),
    ("bucket fill", "bucket"),
    ("fill selection (100 px)", "fill_small"),
    ("undo of that fill", "undo_fill"),
    ("clear selected pixels (100 px)", "clear_small"),
    ("stroke across the picture (40 dabs)", "long_stroke"),
    ("its commit, band by band", "long_commit"),
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
            if v and key.endswith("_landings"):
                cells.append("%22s" % f"{v[0]}  [{v[1]:.0f} ms]")
                continue
            cells.append("%22s" % ("-" if not v else f"{v[0]:.0f} ms  [{v[1]:.0f}]"))
        print("%-28s%s" % (label, "".join(cells)))
    print()
    for r in results:
        gl = r.get("glMB")
        print("%-28s%s" % (r["size"], f"view {r['view']}, filter {r['filter']}, undo {r['undo_bytes'] / 1048576:.1f} MB"
              + (f", renderer {r['memMB']} MB" if r.get("memMB") else "")
              + (f", compositor {gl['atlas']} MB in {gl['pages']} atlas pages ({gl['slots']} slots)"
                 f" + {gl['textures']} MB of source textures" if gl else "")
              + ("" if r.get("gl_stack") else ", the GPU stack row: the compositor would not take it")
              + (f"; tile display: {r['display']['mirrors']} mirrors {r['display']['mirrorMB']} MB,"
                 f" {r['display']['regions']} region canvases {r['display']['regionMB']} MB,"
                 f" pyramids {r['display']['pyramidMB']} MB" if r.get("display") else "")))


if __name__ == "__main__":
    asyncio.run(chain_main() if CHAIN else main())
