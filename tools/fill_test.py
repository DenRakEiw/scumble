"""Fill layers gate (docs/PLAN_0_1_31.md §6 step 6): a colour fill and a gradient fill as filter layers of their own kind.

The checks:

  * a colour fill covers the picture with its colour, byte for byte, on the flatten and the PNG export
  * a gradient with a transparent end in normal mode is the gradient (`fillPixels`) over the picture, against floats
  * in multiply at its transparent end the picture is left as it is (the fill goes over as a layer, not in its place)
  * a stack with fills at an opacity, in blend modes, through a mask and under a filter layer: the paths agree (the
    full flatten, the PNG export, the box read, the region pass at 1:1)
  * a tall picture (the export's program in bands): the export against the flatten; a pixel's fill depends only on
    where it is in the picture
  * the row: the type select holds only fills, the kind reads "fill", the colour picker is one undo step
  * getValue / setValue keep the params; PSD (both writers) and ORA write a fill as a layer of pixels, PSD keeps its
    mask, ORA bakes it
  * the commands: add_filter with a gradient, a bad colour refused, filter_types marks the fills

    python tools/fill_test.py

Needs the app on the debugging port (tools/cdp.py); no ComfyUI.
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

JS = r"""
(async () => {
    const shell = await import("./shell.js");
    const { fillPixels } = await import("./editor/inpaint_filters.js");
    const fails = [];
    const check = (name, ok, info) => { if (!ok) fails.push(name + (info !== undefined ? ": " + JSON.stringify(info).slice(0, 400) : "")); };
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const settle = async (ed) => { await ed.mipsSettled(); await new Promise((r) => setTimeout(r, 100)); };
    const touch = (ed) => { ed.uploaded.baseHash = null; ed.flatCache = null; ed.sceneSig = null; ed.filterPreview = null; for (const l of ed.layers) { l._fcache = null; l._fcacheView = null; } };
    const bytes = (c) => c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
    const diff = (a, b) => { if (!a || !b) return null; if (a.length !== b.length) return { max: 999, n: -1 }; let m = 0, n = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { n++; if (d > m) m = d; } } return { max: m, n }; };
    const ok2 = (d, tol = 2) => d && d.max <= tol;

    const open = async (W, H, draw) => {
        const ed = shell.newDocument();
        shell.activate(ed);
        await new Promise((r) => setTimeout(r, 300));
        ed.resizeCanvas();
        const base = mk(W, H);
        draw(base.getContext("2d"), W, H);
        await ed.setBaseFromCanvas(base, { keepLayers: false });   // uploaded: a state names the base by its file
        return { ed, base: bytes(base) };
    };
    const reads = (ed, W, H) => ({
        full: () => { touch(ed); return bytes(ed.flattenToCanvas({ forRun: false })); },
        png: async () => {
            touch(ed);
            const r = await ed.encodeComposite({ forRun: true }, {});
            if (!r || !r.blob) { touch(ed); return bytes(ed.flattenToCanvas({ forRun: true })); }   // the canvas backend: the export is the flatten
            const bmp = await createImageBitmap(r.blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
            const c = mk(bmp.width, bmp.height); c.getContext("2d").drawImage(bmp, 0, 0); bmp.close();
            return bytes(c);
        },
        box: async () => { touch(ed); const r = await ed.readBoxBytes([0, 0, W, H], { forRun: true }); return new Uint8Array(r.data.subarray ? r.data.subarray(0, W * H * 4) : r.data); },
        region: () => { touch(ed); const c = ed.sampleRegion("image", [0, 0, W, H], 1, { forRun: false }); return c && c.width === W && c.height === H ? bytes(c) : null; },
    });
    const picture = (x, w, h) => {
        const g = x.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, "#1a3a6a"); g.addColorStop(1, "#d8c8a0");
        x.fillStyle = g; x.fillRect(0, 0, w, h);
        for (let i = 0; i < 8; i++) { x.fillStyle = `hsl(${i * 45},60%,45%)`; x.fillRect(10 + i * 44, h - 70, 36, 50); }
    };
    const out = {};

    // ---- 1. analytic ---------------------------------------------------------------------------------------------------
    const W = 360, H = 240;
    const { ed, base } = await open(W, H, picture);
    out.tiles = !!ed.tileMode;
    const R = reads(ed, W, H);
    {
        const f = ed.addFilterLayer("fill");
        f.params.color = "#3c9a5f";
        ed.markFilterChanged(f);
        const want = new Uint8ClampedArray(W * H * 4);
        for (let i = 0; i < W * H; i++) want.set([0x3c, 0x9a, 0x5f, 255], i * 4);
        out.colourFull = diff(R.full(), want);
        out.colourPng = diff(await R.png(), want);
        check("colour fill: the colour everywhere (flatten)", out.colourFull && out.colourFull.max === 0, out.colourFull);
        check("colour fill: the colour everywhere (PNG export)", out.colourPng && out.colourPng.max === 0, out.colourPng);
        ed.removeLayer(f.id);
    }
    {
        const g = ed.addFilterLayer("gradient");
        g.params = { ...g.params, shape: "linear", from: "#ff0000", from_opacity: 100, to: "#0000ff", to_opacity: 0, angle: 30, scale: 80, x: 40, y: 60 };
        ed.markFilterChanged(g);
        const fp = fillPixels("gradient", g.params, [W, H], [0, 0], W, H);
        const want = new Uint8ClampedArray(W * H * 4);
        for (let i = 0; i < W * H; i++) {
            const a = fp[i * 4 + 3] / 255;
            for (let k = 0; k < 3; k++) want[i * 4 + k] = Math.round(fp[i * 4 + k] * a + base[i * 4 + k] * (1 - a));
            want[i * 4 + 3] = 255;
        }
        out.gradFull = diff(R.full(), want);
        out.gradPng = diff(await R.png(), want);
        check("gradient (normal, a transparent end): over the picture (flatten)", ok2(out.gradFull), out.gradFull);
        check("gradient (normal, a transparent end): over the picture (PNG export)", ok2(out.gradPng), out.gradPng);
        // the ends: opaque red at one, the picture at the other
        let red = 0, same = 0;
        for (let i = 0; i < W * H; i++) { if (fp[i * 4 + 3] === 255) red++; if (fp[i * 4 + 3] === 0) same++; }
        check("gradient: both ends occur", red > 100 && same > 100, [red, same]);
        // multiply: where the fill is transparent the picture stays, where it is opaque it is the product
        g.blend = "multiply"; touch(ed);
        const m = R.full();
        let far = 0, farMax = 0, prod = 0;
        for (let i = 0; i < W * H; i++) {
            if (fp[i * 4 + 3] === 0) { far++; for (let k = 0; k < 3; k++) farMax = Math.max(farMax, Math.abs(m[i * 4 + k] - base[i * 4 + k])); }
            if (fp[i * 4 + 3] === 255) for (let k = 0; k < 3; k++) prod = Math.max(prod, Math.abs(m[i * 4 + k] - Math.round(base[i * 4 + k] * fp[i * 4 + k] / 255)));
        }
        out.multiply = { far, farMax, prod };
        check("gradient in multiply: the picture where the fill is transparent, the product where it is opaque", far > 100 && farMax <= 1 && prod <= 2, out.multiply);
        const pm = diff(m, await R.png());
        check("gradient in multiply: the export agrees", ok2(pm), pm);
        ed.removeLayer(g.id);
    }

    // ---- 2. the paths agree on a stack ------------------------------------------------------------------------------------
    const { Layer: LP, Mask: MP } = ed.pixels;
    const paint = (() => { const c = mk(200, 140), x = c.getContext("2d"); x.fillStyle = "#e03020"; x.beginPath(); x.ellipse(100, 70, 90, 60, 0, 0, Math.PI * 2); x.fill(); return ed.addLayer({ name: "paint", kind: "paint", px: LP.fromCanvas(c), x: 40, y: 30, w: 200, h: 140, dirty: true }); })();
    const radial = ed.addFilterLayer("gradient");
    radial.params = { ...radial.params, shape: "radial", from: "#ffe080", from_opacity: 90, to: "#102040", to_opacity: 30, scale: 70, x: 60, y: 40 };
    radial.blend = "multiply"; radial.opacity = 0.7;
    {
        const mc = mk(W, H), mx = mc.getContext("2d");
        const gg = mx.createLinearGradient(0, 0, W, 0);
        gg.addColorStop(0, "rgba(255,255,255,0)"); gg.addColorStop(0.12, "rgba(255,255,255,0)"); gg.addColorStop(0.6, "rgba(255,255,255,1)"); gg.addColorStop(1, "rgba(255,255,255,1)");
        mx.fillStyle = gg; mx.fillRect(0, 0, W, H);
        radial.maskPx = MP.fromCanvas(mc); radial.maskDirty = true; ed.markMaskChanged(radial);
    }
    const refl = ed.addFilterLayer("gradient");
    refl.params = { ...refl.params, shape: "reflected", from: "#20a0ff", from_opacity: 100, to: "#ff40a0", to_opacity: 60, angle: -20, scale: 60 };
    refl.blend = "screen"; refl.opacity = 0.8;
    const solid = ed.addFilterLayer("fill");
    solid.params.color = "#806040"; solid.blend = "linear-light"; solid.opacity = 0.35;
    const fx = ed.addFilterLayer("hue_sat");
    fx.params = { ...fx.params, hue: 40, saturation: 20 };
    touch(ed); ed.renderLayers();
    ed.view = { scale: 1, x: 20, y: 20, angle: 0 };
    ed.draw();
    await settle(ed);
    const f = R.full();
    out.stackPngBytes = await R.png(); out.stackBoxBytes = await R.box();
    out.stackPng = diff(f, out.stackPngBytes);
    out.stackBox = diff(f, out.stackBoxBytes);
    out.stackRegion = diff(f, R.region());
    // the same stack with each fill swapped for a paint layer of its pixels (the same blend, opacity and mask): the
    // fills must give that picture on each path, and the paths may differ as far as they do for those layers (a
    // half-transparent layer in a blend mode is a level or two apart on Canvas 2D, which keeps it premultiplied, and
    // the kernel; the hue / saturation filter above stretches that)
    {
        const fills = [radial, refl, solid];
        const twins = [];
        for (const l of fills) {
            const t = ed.addLayer({ name: "twin " + l.name, kind: "paint", px: LP.fromImageData(new ImageData(fillPixels(l.filter, l.params, [W, H], [0, 0], W, H), W, H)), x: 0, y: 0, w: W, h: H, dirty: true, blend: l.blend, opacity: l.opacity });
            if (l.maskPx) { t.maskPx = l.maskPx.clone ? l.maskPx.clone() : l.maskPx; t.maskDirty = true; }
            twins.push(t);
        }
        // each twin where its fill is, the fills hidden
        const order = ed.layers.filter((l) => !twins.includes(l));
        const at = new Map(fills.map((l, i) => [l, twins[i]]));
        ed.layers = order.flatMap((l) => (at.has(l) ? [l, at.get(l)] : [l]));
        for (const t of twins) if (t.maskPx) ed.markMaskChanged(t);
        for (const l of fills) l.visible = false;
        touch(ed); ed.renderLayers();
        await settle(ed);
        const tf = R.full(), tp = await R.png(), tb = await R.box();
        out.twinFull = diff(f, tf);
        out.twinPng = diff(out.stackPngBytes, tp);
        out.twinBox = diff(out.stackBoxBytes, tb);
        out.twinPaths = diff(tf, tp);
        for (const l of fills) l.visible = true;
        ed.layers = ed.layers.filter((l) => !twins.includes(l));
        touch(ed); ed.renderLayers();
        // the workers' path reads a fill from its canvas, which keeps it premultiplied: 2 levels where it is nearly transparent
        check("stack: the fills give their pixel twins' picture (flatten)", ok2(out.twinFull, 1), out.twinFull);
        check("stack: the fills give their pixel twins' picture (PNG export)", ok2(out.twinPng, 2), out.twinPng);
        check("stack: the fills give their pixel twins' picture (box read)", ok2(out.twinBox, 2), out.twinBox);
        check("stack: the export against the flatten no further apart than for the twins", out.stackPng.max <= out.twinPaths.max + 1 && out.stackBox.max <= out.twinPaths.max + 1, [out.stackPng, out.stackBox, out.twinPaths]);
    }
    check("stack: the region pass agrees with the flatten", ok2(out.stackRegion), out.stackRegion);
    // the fills are in the picture: hiding one changes it
    radial.visible = false; const noRadial = R.full(); radial.visible = true;
    check("stack: the masked radial fill shows", diff(f, noRadial).n > 1000, diff(f, noRadial));
    // the mask's hidden side: the radial fill leaves the picture there
    {
        let m = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < 20; x++) { const i = (y * W + x) * 4; for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(f[i + k] - noRadial[i + k])); }
        check("stack: no radial fill where its mask hides it", m <= 2, m);
    }

    // ---- 3. the row, undo, getValue / setValue ---------------------------------------------------------------------------
    ed.activeLayerId = refl.id; ed.renderLayers();
    {
        const row = ed.layerList.querySelector(`.ipc-layer[data-layer="${refl.id}"]`);
        const kind = row && row.querySelector(".ipc-kind");
        check("row: the kind reads fill", kind && kind.textContent === "fill", kind && kind.textContent);
        const sel = row && row.querySelector(".ipc-fx select.ipc-sel");
        const opts = sel ? Array.from(sel.options).map((o) => o.value) : [];
        check("row: the type select holds the fills only", opts.join(",") === "fill,gradient", opts);
        const colours = row ? row.querySelectorAll("input.ipc-fxcolor") : [];
        check("row: two colour pickers for a gradient", colours.length === 2, colours.length);
        const fxRow = ed.layerList.querySelector(`.ipc-layer[data-layer="${fx.id}"] .ipc-kind`);
        check("row: a filter layer still reads filter", fxRow && fxRow.textContent === "filter", fxRow && fxRow.textContent);
        if (colours.length) {
            const before = ed.undo.length;
            const ci = colours[0];
            ci.value = "#00ff00"; ci.dispatchEvent(new Event("input"));
            ci.value = "#00ee00"; ci.dispatchEvent(new Event("input"));
            ci.dispatchEvent(new Event("change"));
            check("colour picker: the value lands", refl.params.from === "#00ee00", refl.params.from);
            check("colour picker: one undo step", ed.undo.length === before + 1, [before, ed.undo.length]);
            await ed.undoStep();
            const back = ed.layers.find((l) => l.id === refl.id);
            check("colour picker: undo puts the colour back", back && back.params.from === "#20a0ff", back && back.params.from);
        }
        const th = row && row.querySelector("canvas.ipc-lthumb");
        if (th) { const d = bytes(th); let a = 0; for (let i = 3; i < d.length; i += 4) a = Math.max(a, d[i]); check("row: the thumbnail shows the fill", a === 255, a); }
    }
    {
        await ed.syncLayers();   // the layers' pixels reach the local store: a state names them by file
        const v = ed.getValue();
        const ed2 = shell.newDocument();
        shell.activate(ed2);
        await new Promise((r) => setTimeout(r, 300));
        await ed2.setValue(v);
        for (let t = 0; t < 100 && ed2.layers.length < ed.layers.length; t++) await new Promise((r) => setTimeout(r, 100));
        await settle(ed2);
        const r2 = ed2.layers.find((l) => l.name === radial.name);
        check("setValue: the params and the mask come back", r2 && r2.filter === "gradient" && r2.params.shape === "radial" && r2.params.from === "#ffe080" && r2.blend === "multiply" && !!r2.maskPx, r2 && { f: r2.filter, p: r2.params, b: r2.blend });
        const f2 = (() => { touch(ed2); return bytes(ed2.flattenToCanvas({ forRun: false })); })();
        const d2 = diff(f, f2);
        check("setValue: the same picture", ok2(d2), d2);
        shell.closeDocument && shell.closeDocument(ed2, { force: true });
        shell.activate(ed);
        await new Promise((r) => setTimeout(r, 200));
    }

    // ---- 4. PSD both ways, ORA -------------------------------------------------------------------------------------------
    const { readPsd, readOra } = await import("./editor/inpaint_layered.js");
    const layered = async (fmt, bands) => {
        const keep = ed.constructor.bands;
        if (bands === false) ed.constructor.bands = false;
        try {
            let blob = null;
            const r = await ed.exportLayeredBands(fmt);
            if (r) blob = r.blob;
            else {
                const { buildLayered } = await import("./editor/inpaint_jobs.js");
                const { layers } = ed.exportLayerStack(fmt);
                blob = await buildLayered(fmt, { width: W, height: H, layers, composite: ed.flattenToCanvas({ forRun: true }) });
            }
            return { bytes: new Uint8Array(await blob.arrayBuffer()), banded: !!r };
        } finally { ed.constructor.bands = keep; }
    };
    const reflP = ed.layers.find((l) => l.id === refl.id).params;
    const wantRefl = fillPixels("gradient", reflP, [W, H], [0, 0], W, H);
    const cmpFill = (rgba, want) => { let m = 0; for (let i = 0; i < W * H; i++) { const a = want[i * 4 + 3]; m = Math.max(m, Math.abs(rgba[i * 4 + 3] - a)); if (a >= 128) for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(rgba[i * 4 + k] - want[i * 4 + k])); } return m; };
    for (const bands of [true, false]) {
        const { bytes: psd, banded } = await layered("psd", bands);
        const back = await readPsd(psd);
        const tag = `PSD (${banded ? "band writer" : "canvas writers"})`;
        const names = back.layers.map((l) => l.name);
        check(`${tag}: the fills are layers, the filter is not`, names.join("|") === ["Background", "paint", radial.name, refl.name, solid.name].join("|"), names);
        const rl = back.layers.find((l) => l.name === refl.name);
        const d = rl && rl.w === W && rl.h === H ? cmpFill(rl.rgba, wantRefl) : 999;
        check(`${tag}: the reflected fill's pixels, its blend and opacity`, d <= (banded ? 0 : 2) && rl.blend === "screen" && Math.abs(rl.opacity - 0.8) < 0.01, [d, rl && rl.blend, rl && rl.opacity]);
        const ra = back.layers.find((l) => l.name === radial.name);
        check(`${tag}: the radial fill keeps its mask`, ra && ra.mask && ra.mask.data[0] < 10 && ra.mask.data[W - 1] > 245, ra && ra.mask && [ra.mask.data[0], ra.mask.data[W - 1]]);
        out[bands ? "psdBands" : "psdCanvas"] = banded;
    }
    {
        const { bytes: ora } = await layered("ora", true);
        const back = await readOra(ora, { inflateRaw: async (data) => new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer()) });
        const ra = back.layers.find((l) => l.name === radial.name);
        // the mask baked: transparent at the left edge, the fill's alpha at the right
        const want = fillPixels("gradient", radial.params, [W, H], [0, 0], W, H);
        let px = null;
        if (ra && ra.png) {
            const bmp = await createImageBitmap(new Blob([ra.png], { type: "image/png" }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
            const c = mk(bmp.width, bmp.height); c.getContext("2d").drawImage(bmp, 0, 0); bmp.close();
            px = bytes(c);
        }
        const aL = px ? px[3] : -1, aR = px ? px[(W - 1) * 4 + 3] : -1;
        check("ORA: the radial fill as a layer, its mask baked", ra && aL <= 2 && Math.abs(aR - want[(W - 1) * 4 + 3]) <= 3, [!!ra, aL, aR, want[(W - 1) * 4 + 3]]);
    }

    // ---- 5. commands -----------------------------------------------------------------------------------------------------
    const call = (name, args = {}) => shell.commands.run(name, { doc: ed.node.id, ...args });
    const types = await call("filter_types");
    const byId = Object.fromEntries(types.filters.map((t) => [t.id, t]));
    check("filter_types: the fills are marked", byId.fill && byId.fill.fill === true && byId.gradient && byId.gradient.fill === true && !byId.blur.fill && byId.fill.params[0].type === "color", [byId.fill, byId.blur && byId.blur.fill]);
    const made = await call("add_filter", { type: "gradient", params: { shape: "radial", from: "#ABCDEF", to: "112233" } });
    const ml = ed.layers.find((l) => l.id === made.id);
    check("add_filter: a gradient with its colours", ml && ml.params.from === "#abcdef" && ml.params.to === "#112233" && ml.params.shape === "radial", ml && ml.params);
    let refused = null;
    try { await call("set_filter", { layer: made.id, params: { from: "red" } }); } catch (err) { refused = String(err.message || err); }
    check("set_filter: a colour that is not #rrggbb is refused", refused && /#rrggbb/.test(refused), refused);

    delete out.stackPngBytes; delete out.stackBoxBytes;
    out.fails = fails;
    return out;
})()
"""

# the export's program in bands: a picture taller than one band (2,048 rows)
JS_BANDS = r"""
(async () => {
    const shell = await import("./shell.js");
    const fails = [];
    const W = 420, H = 2600;
    const ed = shell.newDocument();
    shell.activate(ed);
    await new Promise((r) => setTimeout(r, 300));
    ed.resizeCanvas();
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const base = mk(W, H), x = base.getContext("2d");
    const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#203050"); g.addColorStop(1, "#e0c090"); x.fillStyle = g; x.fillRect(0, 0, W, H);
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "fill_bands.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
    const a = ed.addFilterLayer("gradient");
    a.params = { ...a.params, shape: "radial", from: "#ff8000", from_opacity: 100, to: "#0040ff", to_opacity: 20, scale: 60, x: 30, y: 55 };
    const b = ed.addFilterLayer("gradient");
    b.params = { ...b.params, shape: "linear", from: "#000000", from_opacity: 0, to: "#ffffff", to_opacity: 100, angle: 80 };
    b.blend = "overlay"; b.opacity = 0.6;
    await ed.mipsSettled();
    const bytes = (c) => c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
    const touch = () => { ed.uploaded.baseHash = null; ed.flatCache = null; ed.filterPreview = null; for (const l of ed.layers) { l._fcache = null; l._fcacheView = null; } };
    touch();
    const f = bytes(ed.flattenToCanvas({ forRun: false }));
    touch();
    const r = await ed.encodeComposite({ forRun: true }, {});
    if (!r || !r.blob) { shell.closeDocument && shell.closeDocument(ed, { force: true }); return { bands: "no band export (canvas backend)", fails }; }
    const bmp = await createImageBitmap(r.blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const c = mk(W, H); c.getContext("2d").drawImage(bmp, 0, 0); bmp.close();
    const p = bytes(c);
    let m = 0, n = 0;
    for (let i = 0; i < f.length; i++) { const d = Math.abs(f[i] - p[i]); if (d) { n++; if (d > m) m = d; } }
    if (m > 2) fails.push("tall picture: the export in bands against the flatten: " + JSON.stringify({ max: m, n }));
    shell.closeDocument && shell.closeDocument(ed, { force: true });
    return { bands: { max: m, n }, fails };
})()
"""


async def run(c):
    r = await c.eval(JS, timeout=300)
    r2 = await c.eval(JS_BANDS, timeout=300)
    fails = r["fails"] + r2["fails"]
    print(json.dumps({**{k: v for k, v in r.items() if k != "fails"}, "bands": r2.get("bands")}))
    for f in fails:
        print("[FAIL]", f)
    print("PASS" if not fails else f"FAIL ({len(fails)})")
    return not fails


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run)) else 1)


if __name__ == "__main__":
    main()
