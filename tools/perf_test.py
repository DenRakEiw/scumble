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

With --filter=relight (and its depth map, --map=WxH, 4096x2731 by default) the run ends with relight's own rows
(docs/PLAN_WASM_BUILD.md §4.5, K0b), after every row above so they stay comparable with runs before them: one light
moved and three lights moved as a release does them, a drag step's quick map, a pan at 1:1 while the full march of a
moved light runs, and the first march of the document (the one the setup starts; cold only for the first size of a
fresh instance, and the rows above ran meanwhile). Each is timed from the window's relight_maps marks of its kind (full,
or quick for the drag step; start to the end of the last march, InpaintEditor.stepMarks) and waits on
ed.relightMarching(), with a 120 s limit:

    python tools/perf_test.py 15000x10000 --filter=relight --map=4096x2731

K12 (docs/PLAN_WASM_BUILD.md §4.5) adds to a relight run: the stripes of each row's marches [stripes, workers], their
kernel ms, each worker's first stripe against its later ones, the other pool jobs and mip chains of the row, and the
parallel efficiency of the named row and of the same march again [the one-job route's summed kernel ms / (workers x the
stripes' wall), the stripes' summed kernel ms / (workers x the wall)]; the same marches on the route `relightStripes` 0
(one job a light, as before K12; skipped by a build without the route); a whole change at 1:1 with no march in flight
against the same change while a three-light march runs (the mips the frame asks for wait behind the marches' jobs);
eight small NORMAL jobs posted during a three-light march (what a transform's rows wait for); and a light made a sun
(the Rust sun, its depth map resident in the workers). The whole-change rows above run with the paint layer active and
the paint tool once the setup's marches have landed (their state printed with them), and the lights overlay's read of
the picture below after a whole change has a row of its own. A run whose window was not focused and visible at its
start or end prints NOT COUNTED and exits 2.
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
    const focusAtStart = [document.hasFocus(), document.visibilityState];
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
        const l = ed.addLayer({ name: `Paint ${i + 1}`, kind: "paint", px: LayerPixels.fromCanvas(c), x: 0, y: 0, w: W, h: H, dirty: true });
        if (%(blend_id)s) l.blend = %(blend_id)s;
    }
    // a result layer with colour match, like an inpaint result over the selection
    const rw = Math.min(2048, Math.round(W / 3)), rh = Math.min(2048, Math.round(H / 3));
    const res = paint(mk(rw, rh), 20, 20);
    const resLayer = ed.addLayer({ name: "Result", kind: "result", px: LayerPixels.fromCanvas(res), x: Math.round(W / 4), y: Math.round(H / 4), w: rw, h: rh, dirty: true });
    resLayer.match = { strength: 60, source: "surroundings" };
    const mapW = %(map_w)d, mapH = %(map_h)d;
    if (mapW > 0 && mapH > 0) {
        const { makeMap } = await import("./editor/inpaint_maps.js");
        const ramp = new Uint16Array(mapW * mapH);
        for (let i = 0; i < ramp.length; i++) ramp[i] = Math.round(i * 65535 / ramp.length);
        await ed.setMap("depth", makeMap("depth", mapW, mapH, ramp, [W, 0, 0, H, 0, 0]));
    }
    // a film look on top (the plugin's filter when it is loaded, else grain, or chosen --filter)
    const { FILTERS } = await import("./editor/inpaint_filters.js");
    const chosenFilter = %(filter_id)s;
    const fx = ed.addFilterLayer(FILTERS[chosenFilter] ? chosenFilter : (FILTERS["film.look"] ? "film.look" : "grain"));
    if (%(limit_obj)s) {
        fx.params = { ...fx.params, limit: %(limit_obj)s };
        ed.markFilterChanged(fx);
    }
    // relight without lights renders nothing (the filter skips it; N3's 15k rows were taken so): two point lights and a
    // spot, the "Cyberpunk neon" preset placed on this picture, so the shadow march and the shading run (W0, 2026-10-23).
    // The relight rows at the end read the marks of the march this starts (the first one of the document) from here on.
    const relightSince = performance.now();
    if (chosenFilter === "relight" && fx && fx.filter === "relight") {
        const { applyLightPreset } = await import("./editor/inpaint_relight.js");
        fx.params = { ...fx.params, lights: applyLightPreset("cyberpunk_neon", { width: W, height: H }) };
        ed.markFilterChanged(fx);
    }
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
            if ("ambient" in p) p.ambient = 10 + (i %% 5) * 5;
            else if ("amount" in p) p.amount = 20 + (i %% 5) * 6;
            else p.strength = 20 + (i %% 5) * 6;
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
        // K12 (docs/PLAN_WASM_BUILD.md §7 K0c, "Rows to pin"): in a relight run addFilterLayer leaves the relight layer
        // active with the lights tool, so every draw runs drawLightsOverlay -> ownLightPos -> belowStats, which after a
        // whole change of a layer below reads the whole picture at 256 px on this thread (2,360 mip chains, about 420 ms
        // at 15k). Whether that read fell into the timed frame or into a draw during the 30 ms wait before it (a march's
        // landing asks for one) decided the rows: 62 / 60 / 483 ms and 16 / 16 / 2,376 chains in W0b, the 192 px rows
        // 422 / 0.4 / 425. So in a relight run these rows run as in any other run: the paint layer active, the paint tool,
        // and only once the setup's marches have landed (marches in flight and below stats redone printed per row); the
        // overlay's read has a row of its own (whole_1to1_lights) that always pays it.
        const relightRun = fxId === "relight";
        const toolWas = ed.tool, activeWas = ed.activeLayerId;
        const marchesNow = () => (typeof ed.relightMarching === "function" ? ed.relightMarching() : 0);
        if (relightRun) {
            const q0 = performance.now();
            while (marchesNow() > 0 && performance.now() - q0 < 120000) await new Promise((r) => setTimeout(r, 20));
            out.whole_quiet = [+(performance.now() - q0).toFixed(1), marchesNow()];   // [waited for the setup's marches, still in flight]
            ed.setTool("paint");
            ed.activeLayerId = target.id;
        }
        const belowNow = () => ed.layers.map((l) => l._bstats);
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
        // K12: the change and its frame in one task. With the 30 ms wait between them (before K12) a draw queued by the row
        // before (a landing's drawSoon) could run in the wait, see the new pixels first and ask for their chains, so the
        // timed frame asked none (0 of 2,344 in a debug run of the during-a-march row): the wait now comes before the change
        const T = await import("./editor/inpaint_tiles.js");
        const replaced = async (label, before = null) => {
            await ed.mipsSettled(); ed.sceneSig = null; ed.draw(); settleNow();
            await new Promise((r) => setTimeout(r, 30));
            ed.pushUndo({ kind: "layerfull", id: target.id });
            if (ed.tileMode) target.px = ed.turnedTilePixels(target.px, "h");
            else { const c = target.px.toCanvas(), f = document.createElement("canvas"); f.width = c.width; f.height = c.height; const x = f.getContext("2d"); x.translate(c.width, 0); x.scale(-1, 1); x.drawImage(c, 0, 0); target.px = ed.pixels.Layer.fromCanvas(f); f.width = 1; c.width = 1; }
            if (before) before();
            const b0 = belowNow(), m0 = marchesNow();
            T.chainStats(true);
            const t0 = performance.now();
            ed.markLayerChanged(target);
            ed.renderLayers();
            ed.draw();
            out[label] = [+(performance.now() - t0).toFixed(1), +(performance.now() - t0).toFixed(1)];
            out[label + "_state"] = [ed.layers.filter((l, i) => l._bstats !== b0[i]).length, m0];   // [below stats redone in the frame, marches in flight]
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
        // C6 (c3): a 192 px picture of the whole document right after a whole change - what the film looks panel
        // makes for its thumbnails 500 ms after every change. [blocked, wall]: before slice 3 it built a mip chain
        // for every tile of every layer on this thread, 510 ms in one task at 15000 x 10000, and kept 185 MB of them.
        {
            const T = await import("./editor/inpaint_tiles.js");
            const sample = async (label, fn) => {
                await ed.mipsSettled(); ed.sceneSig = null; ed.draw(); settleNow();
                ed.pushUndo({ kind: "layerfull", id: target.id });
                if (ed.tileMode) target.px = ed.turnedTilePixels(target.px, "h");
                ed.markLayerChanged(target);
                ed.renderLayers();
                await new Promise((r) => setTimeout(r, 30));
                ed.clearUndo();
                const chainsAt = () => { const t = ed.memoryReport().tiles; return t ? t.chainBytes : 0; };
                const c0 = chainsAt();
                T.chainStats(true);
                const held = gaps();
                const t0 = performance.now();
                await fn();
                const wall = performance.now() - t0;
                // a synchronous read runs in one task, so the 1 ms timer never fires inside it: its own time is the block
                const blocked = Math.max(held(), label.endsWith("sync") ? wall : 0);
                const cs = T.chainStats();
                out[label] = [+blocked.toFixed(1), +wall.toFixed(1)];
                out[label + "_chains"] = [cs.main, cs.primed];
                out[label + "_keptMB"] = [+((chainsAt() - c0) / 1048576).toFixed(1), 0];
                await ed.mipsSettled();
                await new Promise((r) => setTimeout(r, 50));
            };
            const scale = 192 / Math.max(W, H);
            await sample("panel_flatten_sync", async () => ed.sampleRegion("image", [0, 0, W, H], scale, { forRun: true }));
            await sample("panel_flatten_settled", async () => ed.sampleRegionSettled("image", [0, 0, W, H], scale, { forRun: true }));
        }
        // the lights overlay's read (see relightRun above), always in the frame: the relight layer active with the lights
        // tool, as addFilterLayer leaves it, and its below stats dropped right before the frame (a draw during the wait
        // would have taken them)
        if (relightRun && fxLayer) {
            ed.setTool("lights");
            ed.activeLayerId = fxLayer.id;
            await replaced("whole_1to1_lights", () => { fxLayer._bstats = null; });
        }
        if (relightRun) { ed.setTool(toolWas); ed.activeLayerId = activeWas; }
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
    const dabsMs = performance.now() - strokeStart;
    // The 60 frames above were issued in a tight loop, so the GPU still holds their work; a
    // real stroke is paced by the display. Drain it, so the rows from the commit on measure their
    // own cost and not that backlog (a readback of one pixel waits for a canvas's queue). The canvases
    // read are the ones the frames drew into (the live stroke's region scratch `strokeView` among them:
    // since 0.1.14 every dab's frame rebuilds the scene again) and the pixels' display canvases: on
    // tiles a readRect reads renderer memory and waits for nothing, so the drain cannot go through the
    // pixels (C2 step b). Before the commit the display canvases are only read if they exist: making
    // the paint layer's mirror there would change what the commit costs.
    const { canvasOf, displayCanvasIfMade } = window.__perf.pixels;
    const settle = (make = true) => {
        const disp = make ? canvasOf : displayCanvasIfMade;
        for (const c of [disp(ed.sel), disp(paintLayer.px), ed.strokeView, ed.viewCanvas, ed.sceneCanvas, ed.canvas]) {
            try { if (c) c.getContext("2d").getImageData(0, 0, 1, 1); } catch (_) { /* no 2D context */ }
        }
        try { const comp = ed.compositor(); if (comp) comp.gl.finish(); } catch (_) { /* no compositor */ }
    };
    settle(false);
    await new Promise((r) => setTimeout(r, 300));
    const commitAt = performance.now();
    const strokeBox = ed.strokeRect(p, paintLayer.px);   // what the real pointer-up passes on
    ed.commitStroke(p);
    ed.pointer = null;
    ed.markLayerChanged(paintLayer, strokeBox);
    // [the commit, the dabs and their frames plus the commit] (the drain and the rest between them not counted)
    out.stroke_commit = [+(performance.now() - commitAt).toFixed(1), +(dabsMs + performance.now() - commitAt).toFixed(1)];
    out.undo_bytes = ed.undoBytes;
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
    for (const [name, slotOf] of [["sampledMatchStats", () => "_mstatsSample"], ["filteredCanvas", () => "_fcacheView"]]) {
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

    // --- C6 (c1): readers of a small box at level 0, after every row above so they move none of them ---------------
    {
        const cmds = (await import("./commands.js")).commands;
        const docId = ed.node.id;
        const box1000 = () => {
            const x0 = Math.round(W * 0.55), y0 = Math.round(H * 0.55);
            ed.sel.clear();
            ed.sel.fill([x0, y0, x0 + 1000, y0 + 1000], "#ff0000");
            ed.markSelectionChanged([x0, y0, x0 + 1000, y0 + 1000]);
            ed.getBounds();
        };
        // a control point with the film look under it: its colour is what the points layer takes as its input there
        if (cmds.names().includes("film.add_point")) {
            out.point_add = await op(() => cmds.run("film.add_point", { x: Math.round(W * 0.6), y: Math.round(H * 0.6), radius: 300, exposure: 0.5, doc: docId }));
            const pl = ed.layers.find((l) => l.kind === "filter" && l.filter === "film.points");
            if (pl) { ed.removeLayer(pl.id); ed.renderLayers(); }
            // the same with the filter layers and the matched result hidden: the film look's halation depends on the whole
            // picture, so above it is the whole flatten below the points layer; without it one box of the picture
            const hide = ed.layers.filter((l) => l.visible && (l.kind === "filter" || (l.match && l.match.strength > 0)));
            for (const l of hide) l.visible = false;
            ed.uploaded.baseHash = null; ed.sceneSig = null; ed.draw();
            out.point_add_plain = await op(() => cmds.run("film.add_point", { x: Math.round(W * 0.6), y: Math.round(H * 0.6), radius: 300, exposure: 0.5, doc: docId }));
            const pl2 = ed.layers.find((l) => l.kind === "filter" && l.filter === "film.points");
            if (pl2) { ed.removeLayer(pl2.id); ed.renderLayers(); }
            for (const l of hide) l.visible = true;
            ed.uploaded.baseHash = null; ed.sceneSig = null; ed.draw();
        }
        if (cmds.names().includes("sample.mean_color")) {
            box1000();
            out.mean_color = await op(() => cmds.run("sample.mean_color", { doc: docId }));   // the film look and the matched result shown
            const hide = ed.layers.filter((l) => l.visible && (l.kind === "filter" || (l.match && l.match.strength > 0)));
            for (const l of hide) l.visible = false;
            ed.uploaded.baseHash = null; ed.sceneSig = null; ed.draw();
            out.mean_color_plain = await op(() => cmds.run("sample.mean_color", { doc: docId }));
            for (const l of hide) l.visible = true;
            ed.uploaded.baseHash = null; ed.sceneSig = null; ed.draw();
        }
        // the bucket inside one of the base's discs (the wand's object above) with a 1000 px selection around it: a bounded
        // region, flooded box by box, each box clipped to its part of the selection
        ed.sel.clear();
        ed.sel.fill([477, 113, 1477, 1113], "#ff0000");
        ed.markSelectionChanged([477, 113, 1477, 1113]);
        ed.getBounds();
        ed.activeLayerId = paintLayer.id;
        out.bucket_sel = await op(() => ed.bucketFill(977, 613));
        // C6 (c5): the screenshot an agent takes after most steps, and the picture a language model is shown for
        // upsampling. Both were a full-resolution flatten plus the display mirrors of the selection (and a layer).
        // Each row starts from released mirrors; [MB] is what the row itself made of them.
        {
            const mirrorsNow = () => { const t = ed.memoryReport().tiles; return t ? t.mirrorBytes : 0; };
            const shot = async (key, fn) => {
                ed.releaseCaches({ mirrors: true });
                let made = 0;
                out[key] = await op(async () => { const m0 = mirrorsNow(); await fn(); made = mirrorsNow() - m0; });
                out[key + "_mb"] = [+(made / 1048576).toFixed(0), 0];
            };
            rect();
            await shot("screenshot", () => cmds.run("screenshot", { max_size: 1024, doc: docId }));
            ed.sel.clear(); ed.markSelectionChanged(null);
            await shot("prompt_ctx", () => ed.promptContextCanvas());
            box1000();
            await shot("prompt_ctx_sel", () => ed.promptContextCanvas());
            // C6 (c) slice 6: the in-app helper models' inputs (1024 x 1024), the new reader and the old one in this run
            const H6 = (await import("./editor/host.js")).host;
            await shot("object_input", () => H6.objectInput(ed, null));
            await shot("object_input_old", async () => H6.modelInput(H6.sourceCanvas(ed, null), 1024, null));
            await shot("cutout_input", () => H6.cutoutInput(ed, paintLayer));
            await shot("cutout_input_old", async () => H6.modelInput(paintLayer.px.toCanvas(), 1024, "#000000"));
        }
    }

    // --- C6 (c2): region passes over a masked layer, a masked filter layer, peek and a move drag ------------------
    // Each row starts from released display caches and says how many MB of display mirrors (and whether a `_masked`
    // canvas) it made: on tiles those passes made full-size copies of the layers until C6 (c2).
    if (ed.tileMode) {
        // the display mirrors of the pixels a row is about (op()'s own GPU drain reads the selection's and a paint layer's)
        const { displayCanvasIfMade } = window.__perf.pixels;
        const mirrorMB = (...pxs) => +(pxs.reduce((a, q) => { const m = q && displayCanvasIfMade(q); return a + (m ? m.width * m.height * 4 : 0); }, 0) / 1048576).toFixed(0);
        const clean = async () => { ed.releaseCaches({ mirrors: true }); ed.sceneSig = null; ed.fitView(); ed.draw(); await ed.mipsSettled(); ed.sceneSig = null; ed.draw(); };
        const masked = ed.layers.find((l) => l.name === "Paint 3");   // not the paint layer op() reads to drain the GPU
        masked.maskPx = ed.pixels.Mask.empty(W, H);
        masked.maskPx.fill([0, 0, Math.round(W / 2), H], "#ffffff");
        ed.markMaskChanged(masked);
        // the wand on the base's disc: its coarse pass is 2048 x 1365.33 px, the fine boxes at 1:1, all over the masked layer
        await clean();
        rect();
        out.wand_masked = await op(() => ed.wandSelect(977, 613, "replace"));
        out.wand_masked_mb = [mirrorMB(masked.px, masked.maskPx), masked._masked ? 1 : 0];
        // the eyedropper and the wand with the tool bar's Sample set to the masked layer (the wand inside one of its squares)
        await clean();
        const fillWas = ed.fillOpts;
        ed.activeLayerId = masked.id;
        ed.fillOpts = { tolerance: 32, contiguous: true, sample: "layer" };
        out.pick_layer = await op(() => ed.pickColor(1100, 650));
        out.pick_layer_mb = [mirrorMB(masked.px, masked.maskPx), masked._masked ? 1 : 0];
        rect();
        out.wand_layer = await op(() => ed.wandSelect(1100, 650, "replace"));
        out.wand_layer_mb = [mirrorMB(masked.px, masked.maskPx), masked._masked ? 1 : 0];
        ed.fillOpts = fillWas;
        // pan at fit on the Canvas 2D path with the film look masked to the left half
        const fxl = ed.layers.find((l) => l.kind === "filter");
        if (fxl) {
            fxl.maskPx = ed.pixels.Mask.empty(W, H);
            fxl.maskPx.fill([0, 0, Math.round(W / 2), H], "#ffffff");
            ed.markMaskChanged(fxl);
            await clean();
            out.pan_masked_filter = bench((i) => { ed.view.x += (i %% 2 ? -7 : 9); ed.view.y += 3; ed.draw(); }, 30);
            out.pan_masked_filter_mb = [mirrorMB(fxl.maskPx), 0];
            fxl.maskPx = null; ed.markFilterChanged(fxl);
        }
        // peek at the base, first frame at fit and at 1:1
        await clean();
        {
            const t = performance.now();
            ed.peekBase = true; ed.draw();
            out.peek_fit = [+(performance.now() - t).toFixed(1), +(performance.now() - t).toFixed(1)];
            out.peek_fit_mb = [mirrorMB(ed._basePx), 0];
            ed.peekBase = false; ed.sceneSig = null; ed.draw();
        }
        await clean();
        ed.view.scale = 1; ed._fitted = false;
        ed.view.x = Math.round(ed.canvas.width / 2 - W / 2); ed.view.y = Math.round(ed.canvas.height / 2 - H / 2);
        ed.sceneSig = null; ed.draw(); await ed.mipsSettled(); ed.sceneSig = null; ed.draw();
        {
            const t = performance.now();
            ed.peekBase = true; ed.draw();
            out.peek_1to1 = [+(performance.now() - t).toFixed(1), +(performance.now() - t).toFixed(1)];
            out.peek_1to1_mb = [mirrorMB(ed._basePx), 0];
            ed.peekBase = false; ed.sceneSig = null; ed.draw();
        }
        // a move drag of a full-size paint layer at fit: its first frame, then five more
        await clean();
        {
            const M = ed.layers.find((l) => l.name === "Paint 1");
            const x0 = M.x;
            ed.pointer = { kind: "move", layer: M, start: [0, 0], orig: { x: M.x, y: M.y } };
            const ts = [];
            for (let i = 1; i <= 6; i++) { const t = performance.now(); M.x = x0 + i * 7; ed.draw(); ts.push(performance.now() - t); }
            out.move_first = [+ts[0].toFixed(1), +Math.max(...ts.slice(1)).toFixed(1)];
            out.move_mb = [mirrorMB(M.px), 0];
            ed.pointer = null; M.x = x0; ed.markLayerChanged(M); ed.sceneSig = null; ed.draw();
        }
        // C6 (c) 7b: the masked full-size paint layer colour-matched. The first frame after a change of its match at fit and
        // at 1:1 [that frame, the frame after its chains settled], a pan at 1:1, the eyedropper and the wand over it; each
        // with the display mirrors of the layer and its mask it made [_masked]. Before 7b the match was made on the layer's
        // `_masked` canvas and two display mirrors, and on a Skia pyramid of it below half size.
        masked.match = { strength: 60, source: "underneath" };
        ed.markMatchChanged(masked);
        const matchedMB = () => [mirrorMB(masked.px, masked.maskPx), masked._masked ? 1 : 0];
        const firstFrame = async (key, oneToOne) => {
            await clean();
            if (oneToOne) {
                ed.view.scale = 1; ed._fitted = false;
                ed.view.x = Math.round(ed.canvas.width / 2 - W / 2); ed.view.y = Math.round(ed.canvas.height / 2 - H / 2);
                ed.sceneSig = null; ed.draw(); await ed.mipsSettled(); ed.sceneSig = null; ed.draw();
                ed.releaseCaches({ mirrors: true });
            }
            ed.markMatchChanged(masked);
            let t = performance.now();
            ed.sceneSig = null; ed.draw();
            const a = performance.now() - t;
            await ed.mipsSettled();
            t = performance.now();
            ed.sceneSig = null; ed.draw();
            out[key] = [+a.toFixed(1), +(performance.now() - t).toFixed(1)];
            out[key + "_mb"] = matchedMB();
        };
        await firstFrame("match_full_fit", false);
        await firstFrame("match_full_1to1", true);
        out.match_full_pan = bench((i) => { ed.view.x += (i %% 2 ? -7 : 9); ed.view.y += 3; ed.draw(); }, 30);
        out.match_full_pan_mb = matchedMB();
        await clean();
        {
            const fillWas2 = ed.fillOpts;
            ed.fillOpts = { tolerance: 32, contiguous: true, sample: "image" };
            out.match_full_pick = await op(() => ed.pickColor(1100, 650));
            out.match_full_pick_mb = matchedMB();
            rect();
            out.match_full_wand = await op(() => ed.wandSelect(1100, 650, "replace"));
            out.match_full_wand_mb = matchedMB();
            ed.fillOpts = fillWas2;
        }
        masked.match = null; ed.markMatchChanged(masked);
        masked.maskPx = null; ed.markLayerChanged(masked);
    }

    // read before the relight rows below, so a relight run's figures stay comparable with the runs before K0b
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

    // --- K0b (docs/PLAN_WASM_BUILD.md 4.5): relight's shadow march, after every row above so it moves none of them --------
    // Only with --filter=relight. A row moves lights as a release (or a drag step) does and waits until the layer's last
    // march has answered: [the longest block of the window from the change on, its own frame included; the shadows landed:
    // the relight_maps marks of the row's kind (full, or quick for the drag step) from start to the end of the last march,
    // its write included]; "_marches" [marches posted, the slowest one's post to answer]. The pan row pans at 1:1, paced
    // like a display, while the full march of a moved light runs. The first-march row reads the marks of the march the
    // setup started (cold for the first size of a fresh instance); the rows above ran meanwhile and nothing probed the
    // window, so it has no block. A build without the marks gets the window's own poll as the wall (a note says so).
    if (fxId === "relight") {
        const E = ed.constructor;
        const notes = [];
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const LIMIT = 120000;
        const hasMarks = typeof E.stepMarks === "function";
        const marksIn = (since, until = Infinity) => (hasMarks ? E.stepMarks(false) : []).filter((m) => m.op === "relight_maps" && m.t >= since && m.t <= until);
        // the relight_shadow marches in flight (a build without the counter: every relight job the editor waits for)
        const marching = () => (typeof ed.relightMarching === "function" ? ed.relightMarching() : (ed._relightPending ? ed._relightPending.size : 0));
        // when no march was on its way, seen twice 50 ms apart (a landing's redraw may ask for another): that first time,
        // or null at the limit
        const quiet = async (t0 = performance.now()) => {
            for (;;) {
                if (marching() === 0) {
                    const at = performance.now();
                    await sleep(50);
                    if (marching() === 0) return at;
                } else if (performance.now() - t0 > LIMIT) return null;
                else await sleep(5);
            }
        };
        // one run of the marches of one kind (quick or full) since `since`: from its first start to the end of its last
        // march. A march ends at its landing, or at the idle mark right after it when it was the last one in flight (the
        // idle comes after the channel's write, which is most of a landing at 15k). `own` takes only the first start's
        // marches (its first `lights` landings of that kind). `other`: the marches of the other kind that started
        // meanwhile (a pass of the other kind during the row; not counted, a note says so); `again`: later starts of the
        // same kind before the run's last landing.
        const runOf = (since, quick, { own = false } = {}) => {
            const marks = marksIn(since);
            const start = marks.find((m) => m.step === "start" && !!m.quick === quick);
            if (!start) return null;
            const after = marks.filter((m) => m.t >= start.t);
            let landed = after.filter((m) => m.step === "landed" && !!m.quick === quick);
            if (own) landed = landed.slice(0, Number(start.lights) || 0);
            const last = landed[landed.length - 1];
            const next = last ? after[after.indexOf(last) + 1] : null;
            const end = last ? (next && next.step === "idle" ? next.t : last.t) : null;
            const starts = after.filter((m) => m.step === "start" && (!last || m.t <= last.t));
            const same = starts.filter((m) => !!m.quick === quick);
            const lights = (ms) => ms.reduce((a, m) => a + (Number(m.lights) || 0), 0);
            return {
                ms: end != null ? +(end - start.t).toFixed(1) : null,
                posted: own ? Number(start.lights) || 0 : lights(same),
                slowest: landed.length ? +Math.max(...landed.map((m) => Number(m.ms) || 0)).toFixed(1) : null,
                other: lights(starts.filter((m) => !!m.quick !== quick)),
                again: same.length - 1,
            };
        };
        // the wall of a row: its marks, else the poll from the change until no march was on its way
        const wallOf = (key, run, since, at) => {
            if (run && run.ms != null) return run.ms;
            if (at == null) { notes.push(`${key}: still marching after ${LIMIT / 1000} s`); return null; }
            notes.push(!hasMarks ? `${key}: no step marks in this build: the poll's wall`
                : run ? `${key}: no landing mark: the poll's wall` : `${key}: no relight_maps start mark (no march posted?): the poll's wall`);
            return +(at - since).toFixed(1);
        };
        const otherNote = (key, run, quick) => {
            if (run && run.other) notes.push(`${key}: ${run.other} ${quick ? "full" : "quick"} march(es) started meanwhile, not counted (the block and the poll include them)`);
        };
        // the first march of the document: the setup's full march, from its start to the end of its own landings. The
        // filter slider row above sets the preview, so quick marches of the same lights run beside it (not counted).
        {
            const run = runOf(relightSince, false, { own: true });
            out.relight_first = run && run.ms != null ? [null, run.ms] : null;
            out.relight_first_marches = run ? [run.posted, run.slowest] : null;
            if (!run) notes.push("first march: no full relight_maps start since the setup");
            else if (run.ms == null) notes.push("first march: none of its marches landed");
            else if (run.again > 0) notes.push("first march: another full march started before its own had landed (the wall may hold its landings)");
        }
        const lightsNow = () => (fx.params && Array.isArray(fx.params.lights) ? fx.params.lights : []);
        const dx = Math.max(8, Math.round(W / 50)), dy = Math.max(8, Math.round(H / 50));
        // the lights `which` moved by (mx, my), their aim with them (a move drag's step), as a new params object
        const moved = (which, mx, my) => {
            fx.params = { ...fx.params, lights: lightsNow().map((l, i) => (which.includes(i)
                ? { ...l, x: l.x + mx, y: l.y + my, ...(Array.isArray(l.aim) ? { aim: [l.aim[0] + mx, l.aim[1] + my] } : {}) } : l)) };
        };
        // what a light drag's pointer-up runs, and what one of its steps runs
        const release = () => { ed.filterPreview = null; ed.ensureRelightMaps(fx, { quick: false }); ed.markFilterChanged(fx); ed.renderLayers(); ed.draw(); };
        const dragStep = () => { ed.filterPreview = fx.id; ed.ensureRelightMaps(fx, { quick: true }); ed.markFilterChanged(fx, { soon: true }); };
        const calm = async () => {   // the row before has landed: its marches, its chains, its GPU work
            await ed.mipsSettled();
            if ((await quiet()) == null) notes.push("a march was still on its way before a row, after the limit");
            await ed.mipsSettled();
            await sleep(60);
            settle(false);   // the canvases there are; no display mirror made for it
            await sleep(30);
        };
        // K12: the route `relightStripes` (px/kernels.js), when this build has it; 0 is one job a light (before K12)
        const hasStripes = !!(E.routes && Object.prototype.hasOwnProperty.call(E.routes, "relightStripes")) || (() => {
            try { E.setRoute("relightStripes", null); return true; } catch (_) { return false; }
        })();
        const relightJobs = await import("./editor/inpaint_jobs.js");
        const relightTiles = await import("./editor/inpaint_tiles.js");
        const relightPool = () => relightJobs.editorPool();
        const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
        const relightRow = async (key, quick, fn, stripes = undefined) => {
            await calm();
            if (stripes !== undefined) E.setRoute("relightStripes", stripes);
            try {
                if (typeof E.jobTimings === "function") E.jobTimings(true);
                const runs0 = relightPool().stats().run;
                relightTiles.chainStats(true);
                const since = performance.now();
                const done = probe();
                fn();
                const at = await quiet(since);
                const blocked = done();
                const run = runOf(since, quick);
                const wall = wallOf(key, run, since, at);
                out[key] = [blocked, wall];
                out[key + "_marches"] = run ? [run.posted, run.slowest] : null;
                otherNote(key, run, quick);
                // the marches' jobs (a K12 worker answers each with its timing; an older one with none): [jobs, workers],
                // and [the summed kernel ms, the kernel ms of the slowest job]
                const tm = (typeof E.jobTimings === "function" ? E.jobTimings(true) : []).filter((t) => t && t.op === "relight_shadow");
                // what else ran meanwhile (K12's review: the named rows' stripes ran slower than the same march again):
                // [other pool jobs queued in the row, mip chains built on this thread, mip chains asked of the workers]
                const cs = relightTiles.chainStats();
                out[key + "_others"] = [relightPool().stats().run - runs0 - tm.length, cs.main + cs.thumb, cs.requested];
                if (tm.length) {
                    const workers = new Set(tm.map((t) => (t.pool ? t.pool.worker : 0))).size;
                    const busy = tm.reduce((a, t) => a + (Number(t.kernel) || 0), 0);
                    out[key + "_stripes"] = [tm.length, workers];
                    out[key + "_kernel"] = [+busy.toFixed(1), +Math.max(...tm.map((t) => Number(t.kernel) || 0)).toFixed(1)];
                    // busy share: the summed kernel ms over the workers' time across the row's wall
                    if (wall) out[key + "_busy"] = +(busy / (workers * wall)).toFixed(3);
                    out[key + "_workers"] = workers;
                    // [the median kernel ms of each worker's first stripe in the row, of its later ones] (a warm-up shows as
                    // a first stripe slower than the rest; a slowdown of the whole row as both)
                    const byWorker = new Map();
                    for (const t of tm) {
                        const n = t.pool ? t.pool.worker : 0;
                        if (!byWorker.has(n)) byWorker.set(n, []);
                        byWorker.get(n).push(Number(t.kernel) || 0);
                    }
                    const firsts = [...byWorker.values()].map((a) => a[0]), later = [...byWorker.values()].flatMap((a) => a.slice(1));
                    out[key + "_first"] = [+median(firsts).toFixed(1), later.length ? +median(later).toFixed(1) : null];
                    // the kernels the stripes ran (the worker's timing: "js" for the twin, the Rust build for a sun)
                    const kinds = [...new Set(tm.map((t) => String(t.kernels)))];
                    if (kinds.some((k) => k !== "js")) notes.push(`${key}: its jobs ran ${kinds.join(", ")}`);
                }
            } finally {
                if (stripes !== undefined) E.setRoute("relightStripes", null);
            }
        };
        // the parallel efficiency of the stripes: [the serial work (the one-job route's summed kernel ms) / (the stripes'
        // workers x the stripes' wall), the stripes' busy share], and the stripes' summed kernel ms over the one-job
        // route's (their overhead in compute; above 1 also when the workers slow each other down)
        const efficiency = (key, jobKey) => {
            const a = out[key], wk = out[key + "_workers"], ka = out[key + "_kernel"], kb = out[jobKey + "_kernel"];
            if (!a || !a[1] || !wk || !kb || !kb[0]) return;
            out[key + "_eff"] = [+(kb[0] / (wk * a[1])).toFixed(3), out[key + "_busy"] ?? null];
            if (ka) out[key + "_overhead"] = +(ka[0] / kb[0]).toFixed(3);
        };
        ed.activeLayerId = fx.id;   // the layer whose lights a user drags, its handles shown
        ed.renderLayers();
        ed.fitView(); ed.sceneSig = null; ed.draw();
        const all = lightsNow().map((_, i) => i);
        // K12's A/B of the same work: the channels' keys dropped, so the lights march again where the row before left them,
        // once on the route relightStripes 0 (one job a light) and once on the build's own stripes, in that order
        const again = (which) => () => {
            const vis = fx._relight && fx._relight.vis;
            if (vis && Array.isArray(vis.keys)) for (const i of which) vis.keys[i] = null;
            release();
        };
        // the efficiency of both stripes rows against the same one-job march: the named row (the light moved: what a release
        // waits for, the figure Stop 5's q6.7 reads) and the row that marches the same light again unchanged (the march alone)
        await relightRow("relight_one", false, () => { moved([0], dx, 0); release(); });
        if (hasStripes) {
            await relightRow("relight_one_job", false, again([0]), 0);
            await relightRow("relight_one_rep", false, again([0]));
            efficiency("relight_one", "relight_one_job");
            efficiency("relight_one_rep", "relight_one_job");
        }
        await relightRow("relight_three", false, () => { moved(all.slice(0, 3), 0, dy); release(); });
        if (hasStripes) {
            await relightRow("relight_three_job", false, again(all.slice(0, 3)), 0);
            await relightRow("relight_three_rep", false, again(all.slice(0, 3)));
            efficiency("relight_three", "relight_three_job");
            efficiency("relight_three_rep", "relight_three_job");
        }
        await relightRow("relight_quick", true, () => { moved([Math.min(1, all.length - 1)], -dx, 0); dragStep(); });
        release();   // the drag's end: the full march of where it left the light, not timed
        // pan at 1:1 while a full march runs: [median frame, worst frame]; frames [start..idle]; the longest block of the
        // window meanwhile (the landings and their redraws between the frames) [mip chains built on this thread]. The light
        // moved is a point light: a spot's march ends in a sixth of the time (33 against 200 ms at 2048 x 1152, a 1024 map).
        {
            await calm();
            ed.view.scale = 1; ed.view.angle = 0; ed._fitted = false;
            ed.view.x = Math.round(ed.canvas.width / 2 - W / 2); ed.view.y = Math.round(ed.canvas.height / 2 - H / 2);
            ed.sceneSig = null; ed.draw();
            await calm();
            ed.sceneSig = null; ed.draw(); ed.draw();
            const T = await import("./editor/inpaint_tiles.js");
            T.chainStats(true);
            const since = performance.now();
            const done = probe();
            moved([Math.max(0, lightsNow().findIndex((l) => l.type === "point"))], dx, 0);
            release();   // the change's own frame, not a pan frame
            const ts = [];
            let at = null;
            for (let i = 0; performance.now() - since < LIMIT; i++) {
                await sleep(16);   // paced like a display: the march's answers and their landings run between the frames
                const a = performance.now();
                ed.view.x += (i %% 2 ? -7 : 9); ed.view.y += 3; ed.draw();
                ts.push(performance.now() - a);
                if (marching() === 0) { at = performance.now(); break; }
            }
            const held = done();
            const cs = T.chainStats();
            const run = runOf(since, false);
            otherNote("pan", run, false);
            ts.sort((x, y) => x - y);
            out.relight_pan = ts.length ? [+ts[Math.floor(ts.length / 2)].toFixed(1), +ts[ts.length - 1].toFixed(1)] : null;
            out.relight_pan_frames = [ts.length, wallOf("pan", run, since, at)];
            out.relight_pan_held = [held, cs.main + cs.thumb];
            await calm();
            ed.fitView(); ed.sceneSig = null; ed.draw();
        }
        // K12: what a whole change's mips wait for while a full march runs (INTERACTIVE mips behind NORMAL marches: before
        // K12 each light holds one worker for its whole march, with stripes every worker is busy and a mip waits at most
        // one stripe). The frame after a whole change at 1:1 with no march in flight, then the same with a three-light march
        // posted right before it: [the frame, the mips settled]; held [the longest block from the frame's end until the
        // mips settled, chains built here, chains asked, marches in flight at the frame]. As whole_1to1_gl: the GPU stack
        // (the relight layer and the colour-matched result hidden), the paint layer active, tiles only.
        if (ed.tileMode) {
            await calm();
            const target = ed.layers.find((l) => l.kind === "paint");
            const hidden = ed.layers.filter((l) => l.visible && (l === fx || (l.match && l.match.strength > 0)));
            for (const l of hidden) l.visible = false;
            const activeWas = ed.activeLayerId;
            ed.activeLayerId = target.id;
            ed.view.scale = 1; ed.view.angle = 0; ed._fitted = false;
            ed.view.x = Math.round(ed.canvas.width / 2 - W / 2); ed.view.y = Math.round(ed.canvas.height / 2 - H / 2);
            ed.sceneSig = null; ed.draw();
            const T = await import("./editor/inpaint_tiles.js");
            const whole = async (key, before) => {
                await calm();
                ed.sceneSig = null; ed.draw(); settle(false);
                await sleep(30);   // before the change: the change, the march and the frame in one task (see `replaced`)
                ed.pushUndo({ kind: "layerfull", id: target.id });
                target.px = ed.turnedTilePixels(target.px, "h");
                if (before) before();
                const marchingAt = marching();
                T.chainStats(true);
                const t0 = performance.now();
                const done = probe();
                ed.markLayerChanged(target); ed.renderLayers(); ed.draw();
                const frame = performance.now() - t0;
                const cs = T.chainStats();
                const s0 = performance.now();
                await ed.mipsSettled();
                const settled = performance.now() - s0;
                await sleep(50);
                out[key] = [+frame.toFixed(1), +settled.toFixed(1)];
                out[key + "_held"] = [done(s0), cs.main + cs.thumb, cs.requested, marchingAt];
                ed.clearUndo();
            };
            await whole("relight_whole_calm", null);
            await whole("relight_whole_march", () => { moved(all.slice(0, 3), dx, 0); ed.ensureRelightMaps(fx, { quick: false }); });
            await calm();   // its marches land before anything after this
            for (const l of hidden) l.visible = true;
            ed.activeLayerId = activeWas;
            ed.fitView(); ed.sceneSig = null; ed.draw();
        }
        // K12 (its review): what any other NORMAL pool job (a transform's resample rows, a PSD read, ...) waits for while a
        // full march runs. Within NORMAL the pool is first come, first served: before K12 a light held one worker and a job
        // after it ran on an idle one; now each light's stripes are queued ahead of it. Eight small NORMAL jobs (a crc of
        // 1 KB) posted right after a three-light move: [the slowest one's queue wait, its answer] ms from the post; calm:
        // no march; job: on the route relightStripes 0 (one job a light, as before K12)
        {
            const P = await import("./editor/inpaint_pool.js");
            const normalRow = async (key, fn, stripes = undefined) => {
                await calm();
                if (stripes !== undefined) E.setRoute("relightStripes", stripes);
                try {
                    const pool = relightPool();
                    if (fn) fn();
                    const marchingAt = marching();
                    const t0 = performance.now();
                    const got = await Promise.all(Array.from({ length: pool.size }, () => pool.run("crc", { blob: new Blob([new Uint8Array(1024)]) }, [], { priority: P.NORMAL })
                        .then((r) => [r.timing && r.timing.pool ? r.timing.pool.queueMs : 0, performance.now() - t0])));
                    out[key] = [+Math.max(...got.map((g) => g[0])).toFixed(1), +Math.max(...got.map((g) => g[1])).toFixed(1)];
                    out[key + "_marching"] = marchingAt;
                    if ((await quiet()) == null) notes.push(`${key}: still marching after ${LIMIT / 1000} s`);
                } finally {
                    if (stripes !== undefined) E.setRoute("relightStripes", null);
                }
            };
            await normalRow("relight_normal_calm", null);
            await normalRow("relight_normal_march", () => { moved(all.slice(0, 3), 0, -dy); release(); });
            if (hasStripes) await normalRow("relight_normal_job", () => { moved(all.slice(0, 3), 0, dy); release(); }, 0);
        }
        // K12 (its review): a sun, the Rust sun (no row above marches one: the preset's lights run the twin), its depth map
        // resident in each worker (px.js `_slot`, kind relight_depth): light 0 made a sun (its first striped march copies
        // the map once into each worker), then the same march as one job and on stripes again, as the rows above
        const type0 = lightsNow()[0] ? lightsNow()[0].type : "point";
        {
            const sunned = () => { fx.params = { ...fx.params, lights: lightsNow().map((l, i) => (i === 0 ? { ...l, type: "sun" } : l)) }; release(); };
            if (lightsNow()[0] && lightsNow()[0].type === "sun") notes.push("sun: light 0 is a sun already; its row marches nothing");
            await relightRow("relight_sun", false, sunned);
            if (hasStripes) {
                await relightRow("relight_sun_job", false, again([0]), 0);
                await relightRow("relight_sun_rep", false, again([0]));
                efficiency("relight_sun", "relight_sun_job");
                efficiency("relight_sun_rep", "relight_sun_job");
            }
        }
        // K12 (its review): why the named one-light row's stripes run slower than the same march again. Light 0 back to its
        // own kind, moved and marched with the window left alone (no markFilterChanged, renderLayers or draw until the row
        // has landed), then moved and released as relight_one does; each against the same march as one job
        if (hasStripes) {
            const back = (mx) => { fx.params = { ...fx.params, lights: lightsNow().map((l, i) => (i === 0 ? { ...l, type: type0, x: l.x + mx } : l)) }; };
            await relightRow("relight_nodraw", false, () => { back(dx); ed.filterPreview = null; ed.ensureRelightMaps(fx, { quick: false }); });
            ed.markFilterChanged(fx); ed.renderLayers(); ed.draw();
            await relightRow("relight_nodraw_job", false, again([0]), 0);
            efficiency("relight_nodraw", "relight_nodraw_job");
            await relightRow("relight_draw", false, () => { back(-dx); release(); });
            await relightRow("relight_draw_job", false, again([0]), 0);
            efficiency("relight_draw", "relight_draw_job");
        }
        out.relight_notes = notes;
    }

    const focus = [...focusAtStart, document.hasFocus(), document.visibilityState];   // [focused, visibility] at the start and the end
    shell.closeDocument(ed, { force: true });
    if (before) shell.activate(before);
    return JSON.stringify({ size: `${W}x${H}`, mp: +(W * H / 1e6).toFixed(1), filter: fxId, setBase: Math.round(setBaseMs), memMB: mem, view, display, focus, ...out });
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
    ("  below stats redone [marches]", "whole_1to1_gl_state"),
    ("  (relight: waited [in flight])", "whole_quiet"),
    ("192 px picture after a whole change, the old way", "panel_flatten_sync"),
    ("  chains built here [taken from the worker]", "panel_flatten_sync_chains"),
    ("  chains it left on the tiles, MB", "panel_flatten_sync_keptMB"),
    ("192 px picture after a whole change, settled", "panel_flatten_settled"),
    ("  chains built here [taken from the worker]", "panel_flatten_settled_chains"),
    ("  chains it left on the tiles, MB", "panel_flatten_settled_keptMB"),
    ("the same, lights overlay (relight)", "whole_1to1_lights"),
    ("  mips settled [longest block]", "whole_1to1_lights_settled"),
    ("  chains built here [asked]", "whole_1to1_lights_chains"),
    ("  below stats redone [marches]", "whole_1to1_lights_state"),
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
    ("film point add (look under it)", "point_add"),
    ("  the same, stack without filter/match", "point_add_plain"),
    ("sample.mean_color, 1000 px sel.", "mean_color"),
    ("  the same, stack without filter/match", "mean_color_plain"),
    ("bucket in a 1000 px selection", "bucket_sel"),
    ("screenshot 1024 (MCP)", "screenshot"),
    ("  mirrors made MB", "screenshot_mb"),
    ("prompt context, no selection", "prompt_ctx"),
    ("  mirrors made MB", "prompt_ctx_mb"),
    ("prompt context, 1000 px selection", "prompt_ctx_sel"),
    ("  mirrors made MB", "prompt_ctx_sel_mb"),
    ("object map input (1024 from levels)", "object_input"),
    ("  mirrors made MB", "object_input_mb"),
    ("  the same the old way (a flatten)", "object_input_old"),
    ("  mirrors made MB", "object_input_old_mb"),
    ("cutout input (1024 from levels)", "cutout_input"),
    ("  the same the old way (toCanvas)", "cutout_input_old"),
    ("magic wand, a masked layer", "wand_masked"),
    ("  mirrors made MB [_masked]", "wand_masked_mb"),
    ("eyedropper, Sample: the masked layer", "pick_layer"),
    ("  mirrors made MB [_masked]", "pick_layer_mb"),
    ("magic wand, Sample: the masked layer", "wand_layer"),
    ("  mirrors made MB [_masked]", "wand_layer_mb"),
]

# C6 (c2): frames, [median or first, max of the rest]; and the display mirrors each left behind
C2_ROWS = [
    ("pan at fit, masked filter layer", "pan_masked_filter"),
    ("  mirrors made MB", "pan_masked_filter_mb"),
    ("peek at fit, first frame", "peek_fit"),
    ("  mirrors made MB", "peek_fit_mb"),
    ("peek at 1:1, first frame", "peek_1to1"),
    ("  mirrors made MB", "peek_1to1_mb"),
    ("move drag at fit: first [worst of 5]", "move_first"),
    ("  mirrors made MB", "move_mb"),
    ("matched masked layer, fit: first [settled]", "match_full_fit"),
    ("  mirrors made MB [_masked]", "match_full_fit_mb"),
    ("the same at 1:1: first [settled]", "match_full_1to1"),
    ("  mirrors made MB [_masked]", "match_full_1to1_mb"),
    ("pan at 1:1 over it", "match_full_pan"),
    ("  mirrors made MB [_masked]", "match_full_pan_mb"),
    ("eyedropper over it", "match_full_pick"),
    ("  mirrors made MB [_masked]", "match_full_pick_mb"),
    ("magic wand over it", "match_full_wand"),
    ("  mirrors made MB [_masked]", "match_full_wand_mb"),
]

# K0b (docs/PLAN_WASM_BUILD.md §4.5), --filter=relight only: [the longest block, the shadows landed (the relight_maps
# marks of the row's kind, start to the last march's end)]; "marches" [posted, the slowest one's post to answer]; the pan
# row [median frame, worst frame]
RELIGHT_ROWS = [
    ("one light moved: landed", "relight_one"),
    ("  marches [slowest landed]", "relight_one_marches"),
    ("  stripes [workers]", "relight_one_stripes"),
    ("  kernel ms [slowest job]", "relight_one_kernel"),
    ("  first stripe ms [later]", "relight_one_first"),
    ("  others [built, asked]", "relight_one_others"),
    ("  efficiency [busy share]", "relight_one_eff"),
    ("  stripes' kernel / one job's", "relight_one_overhead"),
    ("  again, one job (stripes 0)", "relight_one_job"),
    ("    kernel ms [slowest job]", "relight_one_job_kernel"),
    ("    others [built, asked]", "relight_one_job_others"),
    ("  again, stripes", "relight_one_rep"),
    ("    stripes [workers]", "relight_one_rep_stripes"),
    ("    kernel ms [slowest job]", "relight_one_rep_kernel"),
    ("    first stripe ms [later]", "relight_one_rep_first"),
    ("    others [built, asked]", "relight_one_rep_others"),
    ("    efficiency [busy share]", "relight_one_rep_eff"),
    ("    stripes' kernel / one job's", "relight_one_rep_overhead"),
    ("three lights moved", "relight_three"),
    ("  marches [slowest landed]", "relight_three_marches"),
    ("  stripes [workers]", "relight_three_stripes"),
    ("  kernel ms [slowest job]", "relight_three_kernel"),
    ("  first stripe ms [later]", "relight_three_first"),
    ("  others [built, asked]", "relight_three_others"),
    ("  efficiency [busy share]", "relight_three_eff"),
    ("  stripes' kernel / one job's", "relight_three_overhead"),
    ("  again, one job a light", "relight_three_job"),
    ("    kernel ms [slowest job]", "relight_three_job_kernel"),
    ("    others [built, asked]", "relight_three_job_others"),
    ("  again, stripes", "relight_three_rep"),
    ("    stripes [workers]", "relight_three_rep_stripes"),
    ("    kernel ms [slowest job]", "relight_three_rep_kernel"),
    ("    first stripe ms [later]", "relight_three_rep_first"),
    ("    others [built, asked]", "relight_three_rep_others"),
    ("    efficiency [busy share]", "relight_three_rep_eff"),
    ("    stripes' kernel / one job's", "relight_three_rep_overhead"),
    ("a drag step's quick map", "relight_quick"),
    ("  marches [slowest landed]", "relight_quick_marches"),
    ("pan at 1:1 during a march", "relight_pan"),
    ("  frames [shadows landed]", "relight_pan_frames"),
    ("  block [chains built here]", "relight_pan_held"),
    ("the first march after start", "relight_first"),
    ("  marches [slowest landed]", "relight_first_marches"),
    ("whole change 1:1: frame [mips settled]", "relight_whole_calm"),
    ("  block [built, asked, marching]", "relight_whole_calm_held"),
    ("  during a 3-light march", "relight_whole_march"),
    ("  block [built, asked, marching]", "relight_whole_march_held"),
    ("8 NORMAL jobs: wait [answer]", "relight_normal_calm"),
    ("  during a 3-light march", "relight_normal_march"),
    ("  the same, one job a light", "relight_normal_job"),
    ("a light made a sun: landed", "relight_sun"),
    ("  stripes [workers]", "relight_sun_stripes"),
    ("  kernel ms [slowest job]", "relight_sun_kernel"),
    ("  first stripe ms [later]", "relight_sun_first"),
    ("  efficiency [busy share]", "relight_sun_eff"),
    ("  again, one job (stripes 0)", "relight_sun_job"),
    ("    kernel ms [slowest job]", "relight_sun_job_kernel"),
    ("  again, stripes", "relight_sun_rep"),
    ("    kernel ms [slowest job]", "relight_sun_rep_kernel"),
    ("    first stripe ms [later]", "relight_sun_rep_first"),
    ("    efficiency [busy share]", "relight_sun_rep_eff"),
    ("    stripes' kernel / one job's", "relight_sun_rep_overhead"),
    ("a light moved, no redraw", "relight_nodraw"),
    ("  kernel ms [slowest job]", "relight_nodraw_kernel"),
    ("  first stripe ms [later]", "relight_nodraw_first"),
    ("  efficiency [busy share]", "relight_nodraw_eff"),
    ("  stripes' kernel / one job's", "relight_nodraw_overhead"),
    ("  one job (stripes 0)", "relight_nodraw_job"),
    ("a light moved, released", "relight_draw"),
    ("  kernel ms [slowest job]", "relight_draw_kernel"),
    ("  first stripe ms [later]", "relight_draw_first"),
    ("  efficiency [busy share]", "relight_draw_eff"),
    ("  stripes' kernel / one job's", "relight_draw_overhead"),
    ("  one job (stripes 0)", "relight_draw_job"),
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
    filter_id = next((x.split("=", 1)[1] for x in sys.argv if x.startswith("--filter=")), "film.look")
    blend_id = next((x.split("=", 1)[1] for x in sys.argv if x.startswith("--blend=")), None)
    limit_arg = next((x.split("=", 1)[1] for x in sys.argv if x.startswith("--limit=")), None)
    map_arg = next((x.split("=", 1)[1] for x in sys.argv if x.startswith("--map=")), "4096x2731")
    limit_obj = None
    map_w, map_h = 0, 0
    if limit_arg:
        parts = limit_arg.split(":")
        limit_obj = {
            "source": parts[0],
            "lo": float(parts[1]),
            "hi": float(parts[2]),
            "fLo": float(parts[3]),
            "fHi": float(parts[4]),
            "invert": len(parts) > 5 and parts[5] in ("inv", "true", "1"),
        }
        if limit_obj["source"] == "depth":
            mw, mh = map_arg.lower().split("x")
            map_w, map_h = int(mw), int(mh)
    if filter_id in ("relight", "haze", "lens_blur") and map_w == 0:
        mw, mh = map_arg.lower().split("x")
        map_w, map_h = int(mw), int(mh)

    async def run(c):
        await c.call("Page.bringToFront")   # a timing run counts only with the window in front (as px_jobs.py does)
        await c.eval(SETUP)
        results = []
        for size in SIZES:
            w, h = (int(v) for v in size.lower().split("x"))
            print(f"== {size} ({w * h / 1e6:.1f} MP) ...", flush=True)
            js = BENCH % {
                "w": w,
                "h": h,
                "filter_id": json.dumps(filter_id),
                "limit_obj": json.dumps(limit_obj),
                "map_w": map_w,
                "map_h": map_h,
                "blend_id": json.dumps(blend_id),
            }
            results.append(json.loads(await c.eval(js, timeout=900)))
        return results

    results = await session(run)
    json_out = next((x.split("=", 1)[1] for x in sys.argv if x.startswith("--json=")), None) or os.environ.get("PERF_JSON")
    if json_out:   # every row of every size, as the BENCH body returned them
        with open(json_out, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=1)
    head = "%-28s" % "" + "".join("%22s" % r["size"] for r in results)
    print()
    print(head)
    print("-" * len(head))
    for label, key in ROWS:
        cells = []
        for r in results:
            v = r.get(key)
            if v and key.endswith("_state"):
                cells.append("%22s" % f"{v[0]}  [{v[1]}]")
                continue
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
            if v and key.endswith("_mb"):
                cells.append("%22s" % f"{v[0]:.0f} MB  [{v[1]}]")
                continue
            cells.append("%22s" % ("-" if not v else f"{v[0]:.0f} ms  [{v[1]:.0f}]"))
        print("%-28s%s" % (label, "".join(cells)))
    print()
    print("%-28s%s" % ("C6 (c2), tiles only", ""))
    print("-" * len(head))
    for label, key in C2_ROWS:
        cells = []
        for r in results:
            v = r.get(key)
            if v and key.endswith("_mb"):
                cells.append("%22s" % f"{v[0]:.0f} MB")
                continue
            cells.append("%22s" % ("-" if not v else f"{v[0]:.1f} ms  [{v[1]:.1f}]"))
        print("%-28s%s" % (label, "".join(cells)))
    if any("relight_notes" in r for r in results):
        def ms0(x):
            return "-" if x is None else f"{x:.0f}"
        print()
        print("%-28s%s" % ("relight, blocked [landed]", ""))
        print("-" * len(head))
        for label, key in RELIGHT_ROWS:
            cells = []
            for r in results:
                v = r.get(key)
                if not v:
                    cells.append("%22s" % "-")
                elif key.endswith("_overhead"):
                    cells.append("%22s" % f"{v:.3f}")
                elif key.endswith(("_marches", "_frames")):
                    cells.append("%22s" % f"{v[0]}  [{ms0(v[1])} ms]")
                elif key.endswith("_stripes"):
                    cells.append("%22s" % f"{v[0]}  [{v[1]}]")
                elif key.endswith("_others"):
                    cells.append("%22s" % f"{v[0]}  [{v[1]}, {v[2]}]")
                elif key.endswith("_eff"):
                    cells.append("%22s" % f"{v[0]:.3f}  [{'-' if v[1] is None else f'{v[1]:.3f}'}]")
                elif key in ("relight_pan", "relight_whole_calm", "relight_whole_march"):
                    cells.append("%22s" % f"{v[0]:.1f} ms  [{v[1]:.1f}]")
                elif key.endswith("_held") and len(v) > 2:
                    cells.append("%22s" % f"{ms0(v[0])} ms [{', '.join(str(x) for x in v[1:])}]")
                elif key.endswith("_held"):
                    cells.append("%22s" % f"{ms0(v[0])} ms  [{v[1]}]")
                else:
                    cells.append("%22s" % f"{ms0(v[0])} ms  [{ms0(v[1])}]")
            print("%-28s%s" % (label, "".join(cells)))
        for r in results:
            for note in r.get("relight_notes") or []:
                print("%-28s%s" % (r["size"], note))
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
    uncounted = False
    for r in results:
        f = r.get("focus") or []
        ok = len(f) == 4 and f[0] and f[2] and f[1] == "visible" and f[3] == "visible"
        print("%-28s%s" % (r["size"], f"focus at start {f[:2]}, at the end {f[2:]}" + ("" if ok else ": NOT COUNTED")))
        uncounted = uncounted or not ok
    if uncounted:
        print("\nNOT COUNTED (the window was not focused and visible)")
        sys.exit(2)


if __name__ == "__main__":
    asyncio.run(chain_main() if CHAIN else main())
