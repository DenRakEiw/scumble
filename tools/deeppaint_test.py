"""Deep paint's layer gate (docs/PLAN_SURFACE_PAINT.md SP4): the filter layer `surface` whose own pixels are the paint.

On synthetic maps (the light a ramp across, 0.3 .. 1.2 after sScale; the reflections a ramp down, 0 .. 0.08), a
640 x 400 gradient picture, paint in two rectangles (opaque, half transparent):
  * with no paint the picture goes through byte for byte; where nothing is painted it stays byte for byte;
  * painted pixels are mix(B, P S + k R, a) in linear light within one level (k = Keep reflections), the maps sampled
    bilinear at the pixel's centre (an own bilinear here, not the filter's);
  * the GPU path ran, the CPU twin within one level of it, the program (the export's bands) the same bytes as the pass;
  * Keep reflections 0, a layer mask (the masked half is the picture), opacity, a hidden layer, no maps (the picture);
  * a quarter turn turns the paint with the picture (the turned result within one level) and its undo gives the bytes
    back; a crop keeps the paint in place; a resize remakes it at the new size; undo of each;
  * the brush and the eraser on the layer (SP4b): the live stroke on the screen before the release with nothing in the
    layer yet, the committed stroke by the formula with no explicit cache reset, its undo (the bytes back) and redo;
    another filter layer still refuses the brush;
  * SP5: the eyedropper on the layer picks the surface's own colour ((B - k R) / (S sScale)) and painted back it gives
    the picture; a selection limits a stroke; Fill and the bucket paint the layer; a luma limit keeps the paint off the
    lighter picture; Layer › New Deep Paint Layer and MCP add_surface_layer (color fills the selection, k, refusals);
  * the type picker: set_filter and add_filter refuse to turn anything into or out of Deep paint;
  * .scumble save and open and the autosave restore give the same bytes; the header asks for reader 7.

Gate `deeppaint` (tools/run_gates.sh runs tools/deeppaint_test.py against the instance on SCUMBLE_CDP_PORT).
"""
import asyncio
import json
import os
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

JS = r"""
(async () => {
    const shell = await import("./shell.js");
    const { host } = await import("./editor/host.js");
    const { makeMap } = await import("./editor/inpaint_maps.js");
    const { applyFilter } = await import("./editor/inpaint_filters.js");
    const { applyFilterGL, glToCanvas } = await import("./editor/inpaint_filters_gl.js");
    const fails = [];
    const check = (name, ok, info) => { if (!ok) fails.push(name + (info !== undefined ? ": " + JSON.stringify(info).slice(0, 400) : "")); };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const settle = async (ed) => { await ed.mipsSettled(); await wait(150); };
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const diff = (a, b) => { if (!a || !b || a.length !== b.length) return { max: 999, n: -1 }; let m = 0, n = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { n++; if (d > m) m = d; } } return { max: m, n }; };
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const srgb = (v) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

    const W = 640, H = 400;
    const ed = shell.newDocument();
    shell.activate(ed);
    await wait(250);
    ed.resizeCanvas();
    ed.maxUndo = 200;   // the gate counts undo steps over many blocks: the default 30 would drop the early ones
    const base = mk(W, H);
    {
        const x = base.getContext("2d");
        const g = x.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "#284868"); g.addColorStop(1, "#e8b080");
        x.fillStyle = g; x.fillRect(0, 0, W, H);
    }
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBaseFromCanvas(base, { keepLayers: false });
    await settle(ed);
    const bd = base.getContext("2d").getImageData(0, 0, W, H).data;
    const all = async (e = ed) => (await e.readBoxBytes([0, 0, e.width, e.height], { forRun: true })).data;

    // no maps: refused
    check("no layer without the maps", ed.addSurfaceLayer() === null && /surface maps/i.test(ed.status), ed.status);
    const nm = await shell.commands.call("add_surface_layer", { doc: ed.node.id });
    check("add_surface_layer refuses without the maps", !nm.ok && /surface_maps/.test(JSON.stringify(nm)), nm);

    // the maps: S ramps across (stored 0.25 .. 1 of sScale 1.2), R ramps down (0 .. 0.08); smaller than the picture
    const mw = 80, mh = 50, n = mw * mh;
    const sd = new Uint16Array(n * 3), rd = new Uint16Array(n * 3), nd = new Uint8Array(n * 4).fill(255);
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
        const i = y * mw + x;
        for (let c = 0; c < 3; c++) {
            sd[3 * i + c] = Math.round(65535 * (0.25 + 0.75 * x / (mw - 1)) * (c === 1 ? 0.9 : 1));
            rd[3 * i + c] = Math.round(65535 * 0.08 * y / (mh - 1));
        }
    }
    const xf = [W, 0, 0, H, 0, 0];
    const sScale = 1.2;
    await ed.setMaps({
        shading: makeMap("shading", mw, mh, sd, xf, { sScale, fp: "t" }, null, "rgb16"),
        residual: makeMap("residual", mw, mh, rd, xf, { fp: "t" }, null, "rgb16"),
        normals: makeMap("normals", mw, mh, nd, xf, { fp: "t" }, null, "rgba8"),
    });
    const bil = (d, x, y, c) => {   // the map at map pixel (x, y), centres at + 0.5, edge clamp
        const qx = x - 0.5, qy = y - 0.5, x0 = Math.floor(qx), y0 = Math.floor(qy), fx = qx - x0, fy = qy - y0;
        const cl = (v, m) => Math.max(0, Math.min(m - 1, v));
        const at = (xx, yy) => d[3 * (cl(yy, mh) * mw + cl(xx, mw)) + c] / 65535;
        return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
    };
    const expect = (paint, k = 1, mask = null) => {
        const out = new Uint8ClampedArray(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = y * W + x;
            const a = (paint[4 * i + 3] / 255) * (mask ? mask(x, y) : 1);
            const mx = (x + 0.5) * mw / W, my = (y + 0.5) * mh / H;
            for (let c = 0; c < 3; c++) {
                if (!a) { out[4 * i + c] = bd[4 * i + c]; continue; }
                const b = lin(bd[4 * i + c]);
                const t = lin(paint[4 * i + c]) * bil(sd, mx, my, c) * sScale + k * bil(rd, mx, my, c);
                out[4 * i + c] = Math.round(srgb(Math.max(0, Math.min(1, b + (t - b) * a))));
            }
            out[4 * i + 3] = 255;
        }
        return out;
    };

    const L = ed.addSurfaceLayer();
    check("the layer", L && L.kind === "filter" && L.filter === "surface" && L.px && L.px.width === W && L.px.height === H, L && [L.kind, L.filter]);
    check("nothing painted: the picture byte for byte", diff(await all(), bd).max === 0, diff(await all(), bd));

    const paintC = mk(W, H);
    {
        const x = paintC.getContext("2d");
        x.fillStyle = "rgb(192,48,32)"; x.fillRect(100, 100, 120, 100);
        x.fillStyle = "rgba(32,96,192,0.5)"; x.fillRect(330, 140, 150, 110);
    }
    const pd = paintC.getContext("2d").getImageData(0, 0, W, H).data;
    L.px = ed.pixels.Layer.fromCanvas(paintC);
    L.dirty = true;
    ed.markFilterChanged(L); ed.uploaded.baseHash = null; ed.renderLayers(); ed.draw();
    await settle(ed);
    const ref = await all();
    const exp = expect(pd);
    const painted = (d, e) => { let m = 0, out = 0; for (let i = 0; i < W * H; i++) for (let c = 0; c < 4; c++) { const v = Math.abs(d[4 * i + c] - e[4 * i + c]); if (pd[4 * i + 3]) m = Math.max(m, v); else if (v) out++; } return { inMax: m, outN: out }; };
    const r1 = painted(ref, exp);
    check("painted: the formula within a level, the rest byte for byte", r1.inMax <= 1 && r1.outN === 0, r1);
    check("the paint takes the light: left darker than right", (() => { const a = ref[4 * (150 * W + 105)], b = ref[4 * (150 * W + 215)]; return a < b; })());

    // the GPU ran, the twin, the program
    const below = mk(W, H);
    ed.drawLayersInto(below.getContext("2d"), { forRun: true, upTo: ed.layers.indexOf(L) });
    const info = () => ed.filterInfo(L, { scale: 1, origin: [0, 0], full: [W, H], forRun: true, cache: {} });
    const gl = applyFilterGL("surface", below, L.params, info());
    check("the GPU path ran", !!gl);
    if (gl) {
        const g = glToCanvas(gl).getContext("2d").getImageData(0, 0, W, H).data;
        const cpu = applyFilter("surface", below, L.params, { ...info(), cpu: true }).getContext("2d").getImageData(0, 0, W, H).data;
        check("the CPU twin within a level of the GPU", diff(g, cpu).max <= 1, diff(g, cpu));
        check("the CPU twin: the formula within a level", painted(cpu, exp).inMax <= 1 && painted(cpu, exp).outN === 0, painted(cpu, exp));
    }
    if (ed.tileMode) {   // the program is the tiles backend's
        const plan = ed.stackPlan({ forRun: true, filters: true });
        check("the export's plan has the layer as a filter step", !!plan && plan.some((e) => e.filter === L), plan && plan.length);
        const prog = plan && await ed.holdStack(plan, { forRun: true });
        if (prog) {
            const pb = await ed.programBand(prog, [0, 0, W, H]);
            check("the program (bands) gives the pass's bytes", diff(pb, ref).max <= 1, diff(pb, ref));
            prog.release();
        } else check("the program held", false);
    }

    // a light in stripes, one map pixel wide: half a pixel off in the sample position is several levels
    {
        const ss = new Uint16Array(n * 3);
        for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) for (let c = 0; c < 3; c++) ss[3 * (y * mw + x) + c] = x % 2 ? 60000 : 15000;
        const keep = sd.slice();
        await ed.setMaps({ shading: makeMap("shading", mw, mh, ss, xf, { sScale, fp: "t" }, null, "rgb16") });
        await settle(ed);
        sd.set(ss);
        const e2 = expect(pd);
        const got = painted(await all(), e2);
        check("striped light: the formula within a level (the pixel's centre)", got.inMax <= 1 && got.outN === 0, got);
        const b2 = mk(W, H);
        ed.drawLayersInto(b2.getContext("2d"), { forRun: true, upTo: ed.layers.indexOf(L) });
        const cpu2 = applyFilter("surface", b2, L.params, { ...info(), cpu: true }).getContext("2d").getImageData(0, 0, W, H).data;
        check("striped light: the CPU twin within a level", painted(cpu2, e2).inMax <= 1, painted(cpu2, e2));
        sd.set(keep);
        await shell.commands.call("undo", { doc: ed.node.id });
        await settle(ed);
        check("the stripes' undo", diff(await all(), ref).max <= 1);
    }

    // Keep reflections 0
    await shell.commands.call("set_filter", { doc: ed.node.id, layer: L.id, params: { reflections: 0 } });
    await settle(ed);
    const k0 = painted(await all(), expect(pd, 0));
    check("Keep reflections 0: the formula with k = 0", k0.inMax <= 1 && k0.outN === 0, k0);
    await shell.commands.call("set_filter", { doc: ed.node.id, layer: L.id, params: { reflections: 100 } });
    await settle(ed);

    // a mask: the left half of the first rectangle hidden
    await shell.commands.call("select_rect", { doc: ed.node.id, x: 160, y: 0, w: W - 160, h: H });
    await shell.commands.call("set_mask", { doc: ed.node.id, layer: L.id, op: "from_selection" });
    await shell.commands.call("select_none", { doc: ed.node.id });
    await settle(ed);
    const masked = await all();
    let hiddenSame = true, shownSame = true;
    for (let y = 100; y < 200; y++) {
        for (let x = 100; x < 155; x++) for (let c = 0; c < 3; c++) if (masked[4 * (y * W + x) + c] !== bd[4 * (y * W + x) + c]) hiddenSame = false;
        for (let x = 165; x < 220; x++) for (let c = 0; c < 3; c++) if (Math.abs(masked[4 * (y * W + x) + c] - ref[4 * (y * W + x) + c]) > 1) shownSame = false;
    }
    check("the masked half is the picture", hiddenSame);
    check("the unmasked half keeps the paint", shownSame);
    await shell.commands.call("set_mask", { doc: ed.node.id, layer: L.id, op: "remove" });
    await settle(ed);
    check("without the mask the paint again", diff(await all(), ref).max <= 1, diff(await all(), ref));

    // opacity and visibility
    await shell.commands.call("set_layer", { doc: ed.node.id, layer: L.id, opacity: 0.5 });
    await settle(ed);
    const half = await all();
    const q = 4 * (150 * W + 150);
    check("opacity 0.5: between the picture and the paint", half[q] > Math.min(bd[q], ref[q]) && half[q] < Math.max(bd[q], ref[q]), [bd[q], half[q], ref[q]]);
    await shell.commands.call("set_layer", { doc: ed.node.id, layer: L.id, opacity: 1, visible: false });
    await settle(ed);
    check("hidden: the picture", diff(await all(), bd).max === 0);
    await shell.commands.call("set_layer", { doc: ed.node.id, layer: L.id, visible: true });
    await settle(ed);

    // a part of the picture: the pass's corner is not the picture's
    const part = (await ed.readBoxBytes([90, 95, 230, 210], { forRun: true })).data;
    let pmax = 0;
    for (let y = 95; y < 210; y++) for (let x = 90; x < 230; x++) for (let c = 0; c < 4; c++) pmax = Math.max(pmax, Math.abs(part[4 * ((y - 95) * 140 + x - 90) + c] - ref[4 * (y * W + x) + c]));
    check("a part of the picture: the paint in its place", pmax <= 1, pmax);

    // SP4b: the brush and the eraser on the layer, the live stroke on the screen, the stroke's undo; no
    // markFilterChanged here (what the release does has to reach the filter's caches by itself)
    {
        const cur = () => ed.layers.find((l) => l.filter === "surface");
        ed.activeLayerId = cur().id;
        ed.fitView(); ed.sceneSig = null; ed.draw(); await wait(60);
        const rect = ed.canvas.getBoundingClientRect();
        const client = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
        const ev = (type, ix, iy) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 21, pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy)));
        const screenAt = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); return Array.from(ed.canvas.getContext("2d").getImageData(Math.round(sx), Math.round(sy), 1, 1).data); };
        const redraw = () => { ed.sceneSig = null; ed.draw(); };
        // a stroke whose middle is drawn and looked at before the release
        const stroke = async (x0, y, x1, mid) => {
            ed.canvas.dispatchEvent(ev("pointerdown", x0, y));
            for (let i = 1; i <= 10; i++) { ed.canvas.dispatchEvent(ev("pointermove", x0 + (x1 - x0) * i / 10, y)); await wait(16); }
            redraw(); await wait(30);
            const seen = mid ? await mid() : null;
            ed.canvas.dispatchEvent(ev("pointerup", x1, y));
            await wait(60);
            return seen;
        };
        const before = await all();
        const scr0 = (redraw(), screenAt(160, 330));
        ed.setTool("paint");
        ed.color = "#28c83c"; ed.brushSize = 40; ed.hardness = 1; ed.brushOpacity = 1;
        const live = await stroke(60, 330, 260, async () => ({ screen: screenAt(160, 330), layer: Array.from(cur().px.readRect(160, 330, 1, 1).data), run: await all() }));
        await settle(ed);
        const stepK = ed.undo[ed.undo.length - 1];
        check("the brush on Deep paint: one stroke step", stepK && stepK.kind === "layerrect", stepK && stepK.kind);
        const lp = Array.from(cur().px.readRect(160, 330, 1, 1).data);
        check("the brush wrote the paint into the layer", lp[3] === 255 && Math.abs(lp[0] - 0x28) <= 1 && Math.abs(lp[1] - 0xc8) <= 1 && Math.abs(lp[2] - 0x3c) <= 1, lp);
        check("the live stroke: nothing in the layer before the release", live && live.layer[3] === 0, live && live.layer);
        check("the live stroke: a run's picture does not have it", live && diff(live.run, before).max === 0, live && diff(live.run, before));
        const after = await all();
        // the formula with the layer's paint as it is now (the first two rectangles and the stroke)
        const pd2 = (await cur().px.readRect(0, 0, W, H)).data;
        const exp2 = expect(pd2);
        let smax = 0, sout = 0;
        for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) {
            const v = Math.abs(after[4 * i + c] - exp2[4 * i + c]);
            if (pd2[4 * i + 3]) smax = Math.max(smax, v); else if (v) sout++;
        }
        check("the stroke: the formula within a level, the rest byte for byte", smax <= 1 && sout === 0, { smax, sout });
        const q2 = 4 * (330 * W + 160);
        const v = Array.from(after.slice(q2, q2 + 3));
        check("the stroke changed the picture there", Math.abs(v[1] - before[q2 + 1]) > 20, [v, Array.from(before.slice(q2, q2 + 3))]);
        const near = (a, b, t) => a && b && Math.abs(a[0] - b[0]) <= t && Math.abs(a[1] - b[1]) <= t && Math.abs(a[2] - b[2]) <= t;
        check("the live stroke shows on the screen, under the light", live && near(live.screen, v, 8) && !near(scr0, v, 20), { live: live && live.screen, v, scr0 });
        redraw(); await wait(30);
        check("after the release the screen shows the stroke", near(screenAt(160, 330), v, 8), [screenAt(160, 330), v]);
        await shell.commands.call("undo", { doc: ed.node.id });
        await settle(ed);
        check("the stroke's undo: the bytes back", diff(await all(), before).max === 0 && cur().px.readRect(160, 330, 1, 1).data[3] === 0, diff(await all(), before));
        redraw(); await wait(30);
        check("the stroke's undo on the screen", near(screenAt(160, 330), scr0, 2), [screenAt(160, 330), scr0]);
        await shell.commands.call("redo", { doc: ed.node.id });
        await settle(ed);
        check("its redo", diff(await all(), after).max === 0, diff(await all(), after));
        await shell.commands.call("undo", { doc: ed.node.id });
        await settle(ed);

        // the eraser through the first rectangle: the picture comes back there
        ed.setTool("erase");
        ed.brushSize = 30;
        const liveE = await stroke(90, 150, 230, () => screenAt(160, 150));
        await settle(ed);
        const erased = await all();
        let eq = true;
        for (let y = 140; y < 160; y++) for (let x = 105; x < 215; x++) for (let c = 0; c < 3; c++) if (erased[4 * (y * W + x) + c] !== bd[4 * (y * W + x) + c]) eq = false;
        check("the eraser: the picture byte for byte where it went", eq && cur().px.readRect(160, 150, 1, 1).data[3] === 0);
        check("the eraser leaves the rest of the paint", Math.abs(erased[4 * (120 * W + 160)] - ref[4 * (120 * W + 160)]) <= 1);
        const pb = bd.slice(4 * (150 * W + 160), 4 * (150 * W + 160) + 3);
        check("the live erase shows on the screen", near(liveE, Array.from(pb), 8), [liveE, Array.from(pb)]);
        await shell.commands.call("undo", { doc: ed.node.id });
        await settle(ed);
        check("the eraser's undo: the paint back", diff(await all(), ref).max === 0, diff(await all(), ref));

        // SP5: the eyedropper on the layer picks the surface's own colour, (B - k R) / (S sScale); painted back it is the picture
        const undoTo = async (n) => { while (ed.undo.length > n) { await shell.commands.call("undo", { doc: ed.node.id }); } await settle(ed); };
        const at = (d, x, y) => Array.from(d.slice(4 * (y * W + x), 4 * (y * W + x) + 3));
        const hexOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
        {
            const px = 40, py = 60, mx = (px + 0.5) * mw / W, my = (py + 0.5) * mh / H;
            const want = [0, 1, 2].map((c) => Math.round(srgb(Math.max(0, Math.min(1, (lin(bd[4 * (py * W + px) + c]) - bil(rd, mx, my, c)) / (bil(sd, mx, my, c) * sScale))))));
            ed.fillOpts = { ...(ed.fillOpts || {}), sample: "image" };
            ed.eyedropperSize = 1;
            ed.pickColor(px, py);
            const got = hexOf(ed.color);
            check("the eyedropper on Deep paint: the surface's own colour", got.every((v, c) => Math.abs(v - want[c]) <= 1) && /Surface colour/.test(ed.status), { got, want, status: ed.status });
            const plain = at(bd, px, py);
            check("the surface colour is not the picture's", got.some((v, c) => Math.abs(v - plain[c]) > 10), { got, plain });
            const n1 = ed.undo.length;
            ed.setTool("paint"); ed.brushSize = 24; ed.hardness = 1; ed.brushOpacity = 1;
            await stroke(px - 20, py, px + 20);
            await settle(ed);
            const back = at(await all(), px, py);
            check("painted back it gives the picture", back.every((v, c) => Math.abs(v - plain[c]) <= 2), { back, plain });
            await undoTo(n1);
        }

        // the selection limits the brush; Fill and the bucket paint the layer
        {
            const n1 = ed.undo.length;
            await shell.commands.call("select_rect", { doc: ed.node.id, x: 60, y: 300, w: 100, h: 60 });
            ed.color = "#28c83c"; ed.brushSize = 40;
            await stroke(40, 330, 280);
            await settle(ed);
            check("the selection limits the stroke", cur().px.readRect(100, 330, 1, 1).data[3] === 255 && cur().px.readRect(220, 330, 1, 1).data[3] === 0);
            await shell.commands.call("select_rect", { doc: ed.node.id, x: 520, y: 280, w: 80, h: 80 });
            ed.color = "#3070d0"; ed.brushOpacity = 1;
            ed.fillSelection();
            await settle(ed);
            const fp = Array.from(cur().px.readRect(560, 320, 1, 1).data);
            check("Fill paints the selection on the layer", fp[3] === 255 && Math.abs(fp[2] - 0xd0) <= 1 && cur().px.readRect(510, 320, 1, 1).data[3] === 0, fp);
            const fd = (await cur().px.readRect(0, 0, W, H)).data;
            const ef = expect(fd), gf = await all();
            check("the fill by the formula", Math.abs(gf[4 * (320 * W + 560) + 2] - ef[4 * (320 * W + 560) + 2]) <= 1, [gf[4 * (320 * W + 560) + 2], ef[4 * (320 * W + 560) + 2]]);
            ed.clearSelectedPixels();
            await settle(ed);
            check("Delete clears the selected paint on the layer", cur().px.readRect(560, 320, 1, 1).data[3] === 0 && at(await all(), 560, 320).every((v, c) => v === bd[4 * (320 * W + 560) + c]), ed.status);
            await shell.commands.call("select_none", { doc: ed.node.id });
            ed.color = "#c0c020";
            await ed.bucketFill(30, 380);
            await settle(ed);
            check("the bucket paints the layer", cur().px.readRect(30, 380, 1, 1).data[3] > 0, ed.status);
            await undoTo(n1);
            check("their undo: the paint as before", diff(await all(), ref).max === 0, diff(await all(), ref));
        }

        // a luminosity limit keeps the paint off the lighter picture, as any filter layer's
        {
            const n1 = ed.undo.length;
            const { limitWeight, normalizeStoredLimit } = await import("./editor/inpaint_weights.js");
            const lim = { source: "luma", lo: 0, hi: 0.45, fLo: 0, fHi: 0 };
            await shell.commands.call("set_filter", { doc: ed.node.id, layer: cur().id, params: { limit: lim } });
            await settle(ed);
            const nl = normalizeStoredLimit(lim), got = await all();
            let zero = 0, one = 0, bad = 0;
            for (let i = 0; i < W * H; i++) {
                if (!pd[4 * i + 3]) continue;
                const w = limitWeight(nl, bd[4 * i] / 255, bd[4 * i + 1] / 255, bd[4 * i + 2] / 255);
                for (let c = 0; c < 3; c++) {
                    if (w === 0) { if (got[4 * i + c] !== bd[4 * i + c]) bad++; }
                    else if (w === 1) { if (Math.abs(got[4 * i + c] - ref[4 * i + c]) > 1) bad++; }
                }
                if (w === 0) zero++; else if (w === 1) one++;
            }
            check("a luma limit: the picture where it is 0, the paint where it is 1", bad === 0 && zero > 1000 && one > 1000, { bad, zero, one });
            await undoTo(n1);
            check("the limit's undo", diff(await all(), ref).max === 0);
        }

        // the menu's New Deep Paint Layer and MCP's add_surface_layer
        {
            const nl = await ed.newDeepPaintLayer();
            check("New Deep Paint Layer: active, the brush", nl && nl.filter === "surface" && ed.activeLayerId === nl.id && ed.tool === "paint", nl && [ed.tool]);
            if (nl) await shell.commands.call("remove_layer", { doc: ed.node.id, layer: nl.id });   // adding a layer is no undo step
            const r0 = await shell.commands.call("add_surface_layer", { doc: ed.node.id, color: "#3070d0" });
            check("add_surface_layer with color refuses without a selection", !r0.ok && /select/i.test(JSON.stringify(r0)), r0);
            await shell.commands.call("select_rect", { doc: ed.node.id, x: 520, y: 280, w: 80, h: 80 });
            const r1 = await shell.commands.call("add_surface_layer", { doc: ed.node.id, color: "#3070d0", reflections: 50, name: "Blue" });
            await settle(ed);
            const nb = r1.ok && ed.layers.find((l) => l.id === r1.result.id);
            check("add_surface_layer: the layer, its name, k, active", nb && nb.filter === "surface" && nb.name === "Blue" && nb.params.reflections === 50 && ed.activeLayerId === nb.id, r1);
            const bp = nb && Array.from(nb.px.readRect(560, 320, 1, 1).data);
            check("add_surface_layer: color fills the selection", bp && bp[3] === 255 && Math.abs(bp[2] - 0xd0) <= 1 && nb.px.readRect(510, 320, 1, 1).data[3] === 0, bp);
            const one = new Uint8ClampedArray(W * H * 4);
            if (nb) one.set((await nb.px.readRect(0, 0, W, H)).data);
            const eb = expect(one, 0.5), gb = await all();
            check("add_surface_layer: by the formula with k 0.5", [0, 1, 2].every((c) => Math.abs(gb[4 * (320 * W + 560) + c] - eb[4 * (320 * W + 560) + c]) <= 1), [at(gb, 560, 320), at(eb, 560, 320)]);
            await shell.commands.call("select_none", { doc: ed.node.id });
            if (nb) await shell.commands.call("remove_layer", { doc: ed.node.id, layer: nb.id });
            await settle(ed);
            check("after the menu and the command: the paint as before", ed.layers.filter((l) => l.filter === "surface").length === 1 && diff(await all(), ref).max === 0, { layers: ed.layers.map((l) => l.name), d: diff(await all(), ref), undo: ed.undo.slice(-4).map((u) => u.kind + ":" + (u.label || "")) });
        }

        // SP6: relight lit from the surface maps, and the light brush layer (a relight layer whose mask hides all)
        {
            const doc = ed.node.id;
            const ramp = new Uint16Array(mw * mh);
            for (let i = 0; i < ramp.length; i++) ramp[i] = Math.round(i * 65535 / ramp.length);
            await ed.setMap("depth", makeMap("depth", mw, mh, ramp, xf));
            // MoGe-2's frame: a surface facing the viewer is (0, 0, -1), packed (128, 128, 0)
            const keepNormals = ed.maps.normals;
            const flatN = new Uint8Array(mw * mh * 4);
            for (let i = 0; i < mw * mh; i++) flatN.set([128, 128, 0, 255], 4 * i);
            await ed.setMaps({ normals: makeMap("normals", mw, mh, flatN, xf, { fp: "t" }, null, "rgba8") });
            await settle(ed);
            const rr = await shell.commands.call("relight", { doc, original: 0, ambient: 0, lights: [] });
            const RL = rr.ok && ed.layers.find((l) => l.id === rr.result.layer.id);
            check("a new relight layer lights the surface maps' colour", RL && RL.params.surface === true, rr);
            if (ed.relightSettled) await ed.relightSettled();
            await settle(ed);
            // Original 0, Ambient 0 and no light: what stays is the reflections R alone
            const g0 = await all();
            let rmax = 0;
            // from x 90 on: the light's luma there is past RELIGHT_SURFACE_TRUST's upper end (0.35 at about x 55)
            for (let y = 0; y < H; y += 3) for (let x = 90; x < W; x += 3) {
                const mx = (x + 0.5) * mw / W, my = (y + 0.5) * mh / H;
                for (let c = 0; c < 3; c++) rmax = Math.max(rmax, Math.abs(g0[4 * (y * W + x) + c] - Math.round(srgb(bil(rd, mx, my, c)))));
            }
            check("surface relight, no light, Original 0: the reflections alone", rmax <= 1, rmax);
            await shell.commands.call("set_filter", { doc, layer: RL.id, params: { surface: false } });
            await settle(ed);
            const g1 = await all();
            let bmax = 0;
            for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) bmax = Math.max(bmax, g1[4 * i + c]);
            check("surface off: relight as before (Original 0, no light: black)", bmax <= 1, bmax);
            // a light: the GPU and the CPU twin of the surface branch agree, and it differs from the fitted colour
            const sun = { id: "s", type: "sun", x: 120, y: 60, dist: -30, intensity: 150, color: 4500, diffusion: 30, on: true };
            await shell.commands.call("relight", { doc, layer: RL.id, lights: [sun], original: 100, surface: true });
            if (ed.relightSettled) await ed.relightSettled();
            await settle(ed);
            const lit = await all();
            await shell.commands.call("set_filter", { doc, layer: RL.id, params: { surface: false } });
            if (ed.relightSettled) await ed.relightSettled();
            await settle(ed);
            const litFit = await all();
            check("the surface branch differs from the fitted colour", diff(lit, litFit).max > 3, diff(lit, litFit));
            await shell.commands.call("set_filter", { doc, layer: RL.id, params: { surface: true } });
            if (ed.relightSettled) await ed.relightSettled();
            await settle(ed);
            const rb = mk(W, H);
            ed.drawLayersInto(rb.getContext("2d"), { forRun: true, upTo: ed.layers.indexOf(RL) });
            const rinfo = () => ed.filterInfo(RL, { scale: 1, origin: [0, 0], full: [W, H], forRun: true, cache: {} });
            const rgl = applyFilterGL("relight", rb, RL.params, rinfo());
            check("surface relight: the GPU path ran", !!rgl);
            if (rgl) {
                const a1 = glToCanvas(rgl).getContext("2d").getImageData(0, 0, W, H).data;
                const a2 = applyFilter("relight", rb, RL.params, { ...rinfo(), cpu: true }).getContext("2d").getImageData(0, 0, W, H).data;
                check("surface relight: the CPU twin within 2 levels of the GPU", diff(a1, a2).max <= 2, diff(a1, a2));
            }
            // a dark light map is not divided by (RELIGHT_SURFACE_TRUST): the left half's S at 0.024 and tinted (red 1.6
            // times the others) gives the fitted route there (surface off), the lit right half stays as it was, and the
            // CPU twin follows the GPU through the blend. The depth flat for it (its normals face the viewer as the flat
            // MoGe normals do, so the two routes differ only by the surface branch); maps set without an undo step (big
            // steps would push the earlier ones out of the undo budget)
            {
                const putMaps = async (m) => { Object.assign(ed.maps, m); ed.mapsVersion++; ed.markFilterChanged(RL); ed.sceneSig = null; ed.draw(); if (ed.relightSettled) await ed.relightSettled(); await settle(ed); };
                const keepS = ed.maps.shading, keepD = ed.maps.depth;
                await putMaps({ depth: makeMap("depth", mw, mh, new Uint16Array(mw * mh).fill(32768), xf) });
                const refOn = await all();
                const sdk = new Uint16Array(sd);
                for (let y = 0; y < mh; y++) for (let x = 0; x < mw / 2; x++) {
                    const i = y * mw + x;
                    sdk[3 * i] = Math.round(65535 * 0.036 / sScale); sdk[3 * i + 1] = Math.round(65535 * 0.0225 / sScale); sdk[3 * i + 2] = Math.round(65535 * 0.0225 / sScale);
                }
                await putMaps({ shading: makeMap("shading", mw, mh, sdk, xf, { sScale, fp: "t" }, null, "rgb16") });
                const darkOn = await all();
                await shell.commands.call("set_filter", { doc, layer: RL.id, params: { surface: false } });
                if (ed.relightSettled) await ed.relightSettled();
                await settle(ed);
                const darkOff = await all();
                await shell.commands.call("set_filter", { doc, layer: RL.id, params: { surface: true } });
                if (ed.relightSettled) await ed.relightSettled();
                await settle(ed);
                const half = (a, b, x0, x1) => { let m = 0; for (let y = 0; y < H; y++) for (let x = x0; x < x1; x++) for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(a[4 * (y * W + x) + c] - b[4 * (y * W + x) + c])); return m; };
                check("a dark light map: the fitted route there, no division", half(darkOn, darkOff, 0, W / 2 - 16) <= 2, half(darkOn, darkOff, 0, W / 2 - 16));
                check("a dark light map: the lit half as before", half(darkOn, refOn, W / 2 + 16, W) <= 1, half(darkOn, refOn, W / 2 + 16, W));
                const rb2 = mk(W, H);
                ed.drawLayersInto(rb2.getContext("2d"), { forRun: true, upTo: ed.layers.indexOf(RL) });
                const ri2 = () => ed.filterInfo(RL, { scale: 1, origin: [0, 0], full: [W, H], forRun: true, cache: {} });
                const g2 = applyFilterGL("relight", rb2, RL.params, ri2());
                if (g2) {
                    const a1 = glToCanvas(g2).getContext("2d").getImageData(0, 0, W, H).data;
                    const a2 = applyFilter("relight", rb2, RL.params, { ...ri2(), cpu: true }).getContext("2d").getImageData(0, 0, W, H).data;
                    check("a dark light map: the CPU twin within 2 levels of the GPU", diff(a1, a2).max <= 2, diff(a1, a2));
                }
                await putMaps({ shading: keepS, depth: keepD });
            }
            // MoGe-2's normals give the facing: the left half turned to face left takes more of a sun from the left; with
            // the switch off the normals map changes nothing
            {
                const sunL = { id: "l", type: "sun", x: 0, y: H / 2, dist: -10, intensity: 150, color: 5500, diffusion: 0, on: true };
                await shell.commands.call("relight", { doc, layer: RL.id, lights: [sunL], original: 100, shadows: 0 });
                if (ed.relightSettled) await ed.relightSettled();
                await settle(ed);
                const flatLit = await all();
                const tilt = new Uint8Array(mw * mh * 4);
                const s2 = Math.SQRT1_2;
                for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) tilt.set(x < mw / 2 ? [Math.round((1 - s2) / 2 * 255), 128, Math.round((1 - s2) / 2 * 255), 255] : [128, 128, 0, 255], 4 * (y * mw + x));
                await ed.setMaps({ normals: makeMap("normals", mw, mh, tilt, xf, { fp: "t" }, null, "rgba8") });
                if (ed.relightSettled) await ed.relightSettled();
                await settle(ed);
                const tiltLit = await all();
                const lum = (d, x0, x1) => { let s = 0, n = 0; for (let y = 20; y < H - 20; y += 4) for (let x = x0; x < x1; x += 4) { s += d[4 * (y * W + x)] + d[4 * (y * W + x) + 1]; n++; } return s / n; };
                check("MoGe normals: the left half facing the sun gets more light", lum(tiltLit, 20, W / 2 - 20) > lum(flatLit, 20, W / 2 - 20) + 3, [lum(tiltLit, 20, W / 2 - 20), lum(flatLit, 20, W / 2 - 20)]);
                check("MoGe normals: the right half as before", Math.abs(lum(tiltLit, W / 2 + 40, W - 20) - lum(flatLit, W / 2 + 40, W - 20)) < 0.5, [lum(tiltLit, W / 2 + 40, W - 20), lum(flatLit, W / 2 + 40, W - 20)]);
                const rb2 = mk(W, H);
                ed.drawLayersInto(rb2.getContext("2d"), { forRun: true, upTo: ed.layers.indexOf(RL) });
                const ri2 = () => ed.filterInfo(RL, { scale: 1, origin: [0, 0], full: [W, H], forRun: true, cache: {} });
                const g2 = applyFilterGL("relight", rb2, RL.params, ri2());
                if (g2) {
                    const b1 = glToCanvas(g2).getContext("2d").getImageData(0, 0, W, H).data;
                    const b2 = applyFilter("relight", rb2, RL.params, { ...ri2(), cpu: true }).getContext("2d").getImageData(0, 0, W, H).data;
                    check("MoGe normals: the CPU twin within 2 levels of the GPU", diff(b1, b2).max <= 2, diff(b1, b2));
                } else check("MoGe normals: the GPU path ran", false);
                await shell.commands.call("set_filter", { doc, layer: RL.id, params: { surface: false } });
                if (ed.relightSettled) await ed.relightSettled();
                await settle(ed);
                const offTilt = await all();
                await ed.setMaps({ normals: makeMap("normals", mw, mh, flatN, xf, { fp: "t" }, null, "rgba8") });
                if (ed.relightSettled) await ed.relightSettled();
                await settle(ed);
                check("the switch off: the normals map changes nothing", diff(offTilt, await all()).max === 0, diff(offTilt, await all()));
            }
            await shell.commands.call("remove_layer", { doc, layer: RL.id });
            const nmaps = ed.maps.shading;
            await ed.setMaps({ shading: null, residual: null });
            const rx = await shell.commands.call("relight", { doc, surface: true });
            check("relight surface true refused without the maps", !rx.ok && /surface_maps/.test(JSON.stringify(rx)), rx);
            await shell.commands.call("undo", { doc });
            check("the maps back", ed.maps.shading === nmaps);
            await settle(ed);

            // the light brush: nothing changes until the mask is painted, then the light only there
            const LB = ed.newLightBrushLayer();
            if (ed.relightSettled) await ed.relightSettled();
            await settle(ed);
            check("the light brush layer: relight, surface, its mask in edit, the brush", LB && LB.filter === "relight" && LB.params.surface === true && LB.maskPx && LB.maskEdit && ed.tool === "paint" && LB.params.lights.length === 1, LB && [LB.params.surface, !!LB.maskPx, LB.maskEdit, ed.tool]);
            check("the light brush before painting: the picture as it was", diff(await all(), ref).max === 0, diff(await all(), ref));
            ed.brushSize = 40; ed.hardness = 1; ed.brushOpacity = 1;
            await stroke(380, 320, 600);
            if (ed.relightSettled) await ed.relightSettled();
            await settle(ed);
            const lb = await all();
            let inside = 0, outside = 0;
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                const d = Math.abs(lb[4 * (y * W + x)] - ref[4 * (y * W + x)]) + Math.abs(lb[4 * (y * W + x) + 1] - ref[4 * (y * W + x) + 1]);
                const inStroke = x >= 360 && x <= 620 && y >= 300 && y <= 340;
                if (inStroke) { if (d > 6) inside++; } else if (d) outside++;
            }
            check("the light brush: light where it was painted, nowhere else", inside > 500 && outside === 0, { inside, outside });
            await shell.commands.call("remove_layer", { doc, layer: LB.id });
            await ed.setMaps({ normals: keepNormals });
            await settle(ed);
        }

        // SP7: a layer wrapped onto the surface (a cylinder's normals at the picture's size, axis at x 320, radius 200)
        {
            const doc = ed.node.id;
            const n0 = ed.undo.length;
            const before = await all();
            const Rc = 200, X0 = 320, pk = (v) => Math.round((v + 1) / 2 * 255);
            const nd2 = new Uint8Array(W * H * 4);
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                const dx = (x + 0.5 - X0) / Rc, i = 4 * (y * W + x);
                if (Math.abs(dx) < 1) { nd2[i] = pk(dx); nd2[i + 1] = 128; nd2[i + 2] = pk(-Math.sqrt(1 - dx * dx)); nd2[i + 3] = 255; }
                else { nd2[i] = 128; nd2[i + 1] = 128; nd2[i + 2] = 0; nd2[i + 3] = 255; }
            }
            await ed.setMaps({ normals: makeMap("normals", W, H, nd2, xf, { fp: "t" }, null, "rgba8") });
            // the decal: 240 x 20, white lines two pixels wide centred at its columns 120 + o
            const offs = [-120, -80, -40, 0, 40, 80];
            const dcv = mk(240, 20);
            { const x = dcv.getContext("2d"); x.fillStyle = "#ffffff"; for (const o of offs) x.fillRect(120 + o - 1, 0, 2, 20); }
            const D = ed.addLayer({ name: "Decal", kind: "image", ref: null, dirty: true, px: ed.pixels.Layer.fromCanvas(dcv), x: X0 - 120, y: 300, w: 240, h: 20 });
            await settle(ed);
            const placed = await all();
            const n1 = ed.undo.length;
            const rw = await shell.commands.call("wrap_layer", { doc, layer: D.id });
            await settle(ed);
            const WL = rw.ok && ed.layers.find((l) => l.id === rw.result.id);
            check("wrap_layer: a Deep paint layer just above, the source hidden and active with the Transform tool, one step", WL && WL.filter === "surface" && WL.name === "Wrap: Decal" && ed.layers.indexOf(WL) === ed.layers.indexOf(D) + 1 && D.visible === false && ed.activeLayerId === D.id && ed.tool === "transform" && ed.undo.length === n1 + 1, rw);
            const lineCentres = (px, y) => {
                const row = px.readRect(0, y, W, 1).data, found = [];
                let s = 0, n = 0;
                for (let x = 0; x < W; x++) { const a = row[4 * x + 3]; if (a) { s += a * (x + 0.5); n += a; } else if (n) { found.push(s / n); s = 0; n = 0; } }
                return found;
            };
            const want = offs.map((o) => X0 + Rc * Math.sin(o / Rc));
            const got = WL ? lineCentres(WL.px, 310) : [];
            const werr = got.length === want.length ? Math.max(...got.map((g, i) => Math.abs(g - want[i]))) : 99;
            check("wrap: each line at c + R sin(d / R) within a pixel", werr <= 1, { got: got.map((g) => +g.toFixed(2)), want: want.map((g) => +g.toFixed(2)) });
            check("wrap: the rows stay", WL && lineCentres(WL.px, 299).length === 0 && lineCentres(WL.px, 300).length === 6 && lineCentres(WL.px, 319).length === 6 && lineCentres(WL.px, 320).length === 0);
            const wa = await all();
            let rowsSame = true;
            for (let y = 0; y < H; y++) { if (y >= 296 && y < 324) continue; for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) if (wa[4 * (y * W + x) + c] !== ref[4 * (y * W + x) + c]) rowsSame = false; }
            check("wrap: the picture outside the decal's rows byte for byte", rowsSame);
            const q = 4 * (310 * W + Math.round(want[3] - 0.5));
            check("wrap: the line takes the light (not the flat white of the decal)", wa[q] !== placed[q] && wa[q] < 250, [wa[q], placed[q]]);
            check("wrap: the link is stored", JSON.parse(ed.getValue()).layers.some((l) => l.wrap && l.wrap.source === D.id && l.wrap.x === D.x), "");
            // the live wrap: the hidden source dragged 40 px to the right with the Transform tool (Alt: no snapping)
            {
                const rect2 = ed.canvas.getBoundingClientRect();
                ed.fitView(); ed.sceneSig = null; ed.draw(); await wait(60);
                const cl = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect2.left + sx * rect2.width / ed.canvas.width, clientY: rect2.top + sy * rect2.height / ed.canvas.height }; };
                const pe = (type, ix, iy) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 23, pointerType: "mouse", isPrimary: true, altKey: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, cl(ix, iy)));
                const scr = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); return Array.from(ed.canvas.getContext("2d").getImageData(Math.round(sx), Math.round(sy), 1, 1).data); };
                const x0 = X0, y0 = 310, n2 = ed.undo.length;
                ed.canvas.dispatchEvent(pe("pointerdown", x0, y0));
                for (let i = 1; i <= 8; i++) { ed.canvas.dispatchEvent(pe("pointermove", x0 + 5 * i, y0)); await wait(20); }
                await wait(120);
                ed.sceneSig = null; ed.draw(); await wait(40);
                const midCentres = lineCentres(WL.px, 310);
                // the decal's middle now 40 px right of the axis: arc lengths from there, s_c = R asin(40 / R)
                const sc = Rc * Math.asin(40 / Rc);
                const want2 = offs.map((o) => X0 + Rc * Math.sin((sc + o) / Rc));
                const near1 = (a, b) => a.length === b.length && a.every((g, i) => Math.abs(g - b[i]) <= 1);
                // the middle line at x0 + 40 on the screen: the wrap is drawn during the drag, not the picture without it
                const mx2 = Math.round(midCentres[3] || 0);
                const scrMid = scr(mx2, 312), plainMid = Array.from(placed.slice(4 * (312 * W + mx2), 4 * (312 * W + mx2) + 3));
                ed.canvas.dispatchEvent(pe("pointerup", x0 + 40, y0));
                await settle(ed);
                check("live wrap: the source moved 40 px", D.x === X0 - 120 + 40, D.x);
                check("live wrap: during the drag the lines already followed, each at x0 + R sin((s_c + d) / R) within a pixel", near1(midCentres, want2), { midCentres: midCentres.map((g) => +g.toFixed(2)), want2: want2.map((g) => +g.toFixed(2)) });
                check("live wrap: the screen shows the wrap during the drag", Math.abs(scrMid[0] - plainMid[0]) + Math.abs(scrMid[1] - plainMid[1]) > 6, { scrMid, plainMid });
                const after2 = lineCentres(WL.px, 310);
                check("live wrap: after the release the link and the pixels follow the source, one step (the move's)", WL.wrap && WL.wrap.x === D.x && near1(after2, want2) && ed.undo.length === n2 + 1, { after2, wrap: WL.wrap });
                await shell.commands.call("undo", { doc });
                await settle(ed);
                const WLu = ed.layers.find((l) => l.name === "Wrap: Decal"), Du = ed.layers.find((l) => l.id === D.id);
                const back = WLu ? lineCentres(WLu.px, 310) : [];
                check("live wrap: the move's undo puts the wrap back", Du && Du.x === X0 - 120 && back.length === 6 && back.every((g, i) => Math.abs(g - got[i]) < 0.01), { back, got });
                await shell.commands.call("redo", { doc });
                await settle(ed);
                const WLr = ed.layers.find((l) => l.name === "Wrap: Decal");
                const fwd = WLr ? lineCentres(WLr.px, 310) : [];
                check("live wrap: its redo moves it again", fwd.length === 6 && fwd.every((g, i) => Math.abs(g - after2[i]) < 0.01), { fwd, after2 });
                await shell.commands.call("undo", { doc });
                await settle(ed);
            }
            await shell.commands.call("undo", { doc });
            await settle(ed);
            const Dn = ed.layers.find((l) => l.id === D.id);   // an undo puts the step's copies in place
            check("the wrap's undo: the layer gone, the source shown, the bytes back", !ed.layers.some((l) => l.name === "Wrap: Decal") && Dn && Dn.visible !== false && diff(await all(), placed).max === 0, { d: diff(await all(), placed), names: ed.layers.map((l) => l.name), vis: Dn && Dn.visible });
            // within a selection: the right half only
            await shell.commands.call("select_rect", { doc, x: X0, y: 0, w: W - X0, h: H });
            const rs = await shell.commands.call("wrap_layer", { doc, layer: D.id });
            const WS = rs.ok && ed.layers.find((l) => l.id === rs.result.id);
            const gs = WS ? lineCentres(WS.px, 310) : [];
            check("wrap within the selection: the lines right of it only", gs.length === 3 && gs.every((g) => g > X0), gs);
            const rf = await shell.commands.call("wrap_layer", { doc, layer: L.id });
            check("wrap_layer refuses a filter layer", !rf.ok, rf);
            await undoTo(n0);
            check("the normals back", ed.maps.normals && ed.maps.normals.w === mw);
            await shell.commands.call("remove_layer", { doc, layer: D.id });
            await settle(ed);
            check("after the wraps: the picture as before", diff(await all(), before).max === 0, diff(await all(), before));
        }

        // the layer list's Deep paint button: three actions, the first adds the layer
        {
            const btn = ed.root.querySelector(".ipc-deeppaint-btn");
            check("the layer list has the Deep paint button", !!btn);
            if (btn) {
                btn.click();
                const rows = Array.from(ed.root.querySelectorAll(".ipc-flyout .ipc-choice-row")).map((r) => r.textContent);
                check("its three actions", rows.join("|") === "New Deep Paint Layer|New Light Brush Layer|Wrap onto Surface", rows);
                const n = ed.layers.length;
                const first = ed.root.querySelector(".ipc-flyout .ipc-choice-row");
                if (first) first.click();
                await settle(ed);
                const added = ed.layers.length === n + 1 && ed.layers[ed.layers.length - 1].filter === "surface";
                check("New Deep Paint Layer from the button", added && !ed.root.querySelector(".ipc-flyout"), ed.layers.map((l) => l.name));
                if (added) await shell.commands.call("remove_layer", { doc: ed.node.id, layer: ed.layers[ed.layers.length - 1].id });
                await settle(ed);
            }
        }

        // a filter layer without pixels of its own still refuses the brush
        const g = ed.addFilterLayer("grain");
        ed.activeLayerId = g.id;
        ed.setTool("paint");
        const n0 = ed.undo.length;
        await stroke(60, 330, 260);
        check("another filter layer refuses the brush", ed.undo.length === n0 && /no pixels/i.test(ed.status), [ed.undo.length - n0, ed.status]);
        await shell.commands.call("remove_layer", { doc: ed.node.id, layer: g.id });
        await settle(ed);
        check("after the strokes: the paint as before", diff(await all(), ref).max === 0, diff(await all(), ref));
    }

    // an undo puts the step's copies of the layers in place: the layer is found again
    const cur = () => ed.layers.find((l) => l.filter === "surface");
    // a copy has its own paint and stores it
    const dc = await shell.commands.call("duplicate_layer", { doc: ed.node.id, layer: L.id });
    const copyL = dc.ok && ed.layers.find((l) => l.id === dc.result.id);
    check("a copy: its own pixels, to be stored", copyL && copyL.px !== L.px && copyL.dirty === true, copyL && [copyL.dirty]);
    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);

    // the type picker
    const rt =await shell.commands.call("set_filter", { doc: ed.node.id, layer: cur().id, type: "grain" });
    check("set_filter refuses another type", !rt.ok && cur().filter === "surface", rt);
    const af = await shell.commands.call("add_filter", { doc: ed.node.id, type: "surface" });
    check("add_filter refuses Deep paint", !af.ok, af);

    // a quarter turn and its undo
    const px0 = cur().px;
    await shell.commands.call("rotate_canvas", { doc: ed.node.id, angle: 90 });
    await settle(ed);
    const turned = await all();
    const nw = ed.width, nh = ed.height;
    let tmax = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const j = 4 * (x * nw + (H - 1 - y));   // (x, y) -> (H - 1 - y, x) for a clockwise quarter turn
        for (let c = 0; c < 3; c++) tmax = Math.max(tmax, Math.abs(turned[j + c] - ref[4 * (y * W + x) + c]));
    }
    check("a quarter turn turns the paint with the picture", nw === H && nh === W && cur().px !== px0 && cur().px.width === H && tmax <= 1, { nw, nh, tmax });
    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);
    check("its undo: the bytes back", cur().px === px0 && diff(await all(), ref).max === 0, diff(await all(), ref));

    // a crop keeps the paint in place
    await ed.cropCanvasNow({ left: -40, top: -30 });
    await settle(ed);
    const cr = await all();
    let cmax = 0;
    for (let y = 0; y < ed.height; y++) for (let x = 0; x < ed.width; x++) for (let c = 0; c < 3; c++) cmax = Math.max(cmax, Math.abs(cr[4 * (y * ed.width + x) + c] - ref[4 * ((y + 30) * W + x + 40) + c]));
    check("a crop keeps the paint in place", ed.width === W - 40 && cur().px.width === W - 40 && cmax <= 1, { w: ed.width, pw: cur().px.width, cmax });
    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);
    check("the crop's undo", ed.width === W && cur().px === px0 && diff(await all(), ref).max === 0);

    // a resize remakes the paint at the new size
    await ed.resizeImageNow(320, 200);
    await settle(ed);
    const rs = await all();
    const rq = 4 * (75 * 320 + 80);
    check("a resize remakes the paint at the new size", cur().px.width === 320 && cur().px.height === 200 && Math.abs(rs[rq] - ref[4 * (150 * W + 160)]) <= 12, { pw: cur().px.width, v: rs[rq], r: ref[4 * (150 * W + 160)] });
    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);
    check("the resize's undo", ed.width === W && cur().px === px0 && diff(await all(), ref).max === 0);

    // a straighten resamples the paint onto the new frame
    await shell.commands.call("straighten_canvas", { doc: ed.node.id, angle: 3 });
    await settle(ed);
    check("a straighten: the paint at the new frame's size", cur().px.width === ed.width && cur().px.height === ed.height && cur().px !== px0 && ed.width < W, [cur().px.width, ed.width]);
    const st = await all();
    // the first rectangle's middle (160, 150), turned 3 degrees clockwise about the centre, in the centred frame
    const th = 3 * Math.PI / 180, dx = 160 - W / 2, dy = 150 - H / 2;
    const sq = 4 * (Math.round(ed.height / 2 + dx * Math.sin(th) + dy * Math.cos(th)) * ed.width + Math.round(ed.width / 2 + dx * Math.cos(th) - dy * Math.sin(th)));
    check("a straighten: the red still there", st[sq] > st[sq + 2] + 60, Array.from(st.slice(sq, sq + 4)));
    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);
    check("the straighten's undo", ed.width === W && cur().px === px0 && diff(await all(), ref).max === 0);

    // without the maps the layer passes the picture through
    const mapsNow = { shading: ed.maps.shading, residual: ed.maps.residual, normals: ed.maps.normals };
    await ed.setMaps({ shading: null, residual: null, normals: null });
    await settle(ed);
    check("no maps: the picture", diff(await all(), bd).max === 0);
    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);
    check("the maps back: the paint", ed.maps.shading === mapsNow.shading && diff(await all(), ref).max <= 1);

    // .scumble and the autosave restore
    const path = __PATH__;
    const saved = await host.saveDocument(ed, { path, copy: true, history: false });
    check("saved", saved && saved.bytes > 0 && cur().ref && cur().ref.filename, saved);
    const opened = await host.openDocument(path);
    const e2 = opened && opened.editor;
    check("opened", !!e2);
    if (e2) {
        await settle(e2);
        const l2 = e2.layers.find((l) => l.filter === "surface");
        check("opened: the layer with its paint", l2 && l2.px.width === W && !!l2.ref, l2 && [l2.px.width, l2.ref]);
        check("opened: the same bytes", diff(await all(e2), ref).max === 0, diff(await all(e2), ref));
        shell.closeDocument && shell.closeDocument(e2, { force: true });
    }
    const e3 = shell.newDocument();
    await e3.setValue(ed.getValue());
    await settle(e3);
    check("restored: the same bytes", diff(await all(e3), ref).max === 0, diff(await all(e3), ref));
    shell.closeDocument && shell.closeDocument(e3, { force: true });

    // without Depth Anything the depth map comes from the surface maps' points, so the light brush works after
    // Compute Surface Maps alone: a wall at z 2 on the left, z 4 on the right, the top fifth the sky (masked)
    {
        const e4 = shell.newDocument();
        shell.activate(e4);
        await wait(250);
        e4.resizeCanvas();
        await e4.setBaseFromCanvas(base, { keepLayers: false });
        await settle(e4);
        const pd = new Uint16Array(n * 3), pn = new Uint8Array(n * 4);
        for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
            const i = y * mw + x;
            pn.set([128, 128, 0, y < mh / 5 ? 0 : 255], 4 * i);
            if (y < mh / 5) continue;
            pd.set([32768, 32768, x < mw / 2 ? 0 : 65535], 3 * i);
        }
        await e4.setMaps({
            shading: makeMap("shading", mw, mh, sd, xf, { sScale, fp: "t" }, null, "rgb16"),
            residual: makeMap("residual", mw, mh, rd, xf, { fp: "t" }, null, "rgb16"),
            normals: makeMap("normals", mw, mh, pn, xf, { fp: "t" }, null, "rgba8"),
            points: makeMap("points", mw, mh, pd, xf, { fp: "t", lo: [-1, -1, 2], hi: [1, 1, 4], f: 100 }, null, "rgb16"),
        });
        const keepModel = host.depthModel;
        host.depthModel = () => null;
        try {
            const LB = e4.newLightBrushLayer();
            check("light brush without Depth Anything: the layer is made", !!LB, e4.status);
            for (let t = 0; t < 100 && (e4.depthPending || !(e4.maps && e4.maps.depth)); t++) await wait(100);
            const dm = e4.maps && e4.maps.depth;
            check("depth from points: a depth map, its source the points", !!dm && dm.meta && dm.meta.source === "points", dm && dm.meta && { source: dm.meta.source, status: e4.status });
            if (dm) {
                const at = (fx, fy) => dm.data[Math.floor(fy * dm.h) * dm.w + Math.floor(fx * dm.w)];
                check("depth from points: the near wall nearer than the far one, the sky farthest", at(0.2, 0.6) < at(0.8, 0.6) && at(0.5, 0.05) >= at(0.8, 0.6) - 2000, [at(0.2, 0.6), at(0.8, 0.6), at(0.5, 0.05)]);
                check("depth from points: the status names the points", /points/i.test(e4.status), e4.status);
            }
            if (LB) {
                const before = await all(e4);
                e4.fillLayerMask(LB, true);
                e4.markFilterChanged(LB);
                if (e4.relightSettled) await e4.relightSettled();
                await settle(e4);
                const after = await all(e4);
                check("light brush on the points' depth: the painted mask brings the light in", diff(before, after).max > 3, diff(before, after));
            }
            // a second ask with the same picture keeps the map
            const again = await e4.ensureDepthMap().catch((e) => String(e));
            check("depth from points: kept while the picture is the same", again === e4.maps.depth && again === dm);
            // no points and no model: the download is named, as before
            await e4.setMaps({ points: null });
            let err = null;
            try { await e4.ensureDepthMap({ force: true }); } catch (e) { err = e; }
            check("no points and no depth model: the download is named", !!err && /Depth Anything/.test(e4.status), e4.status);
        } finally {
            host.depthModel = keepModel;
        }
        shell.closeDocument && shell.closeDocument(e4, { force: true });
    }

    shell.closeDocument && shell.closeDocument(ed, { force: true });
    return { fails, tiles: !!ed.tileMode };
})()
"""


async def run(c):
    tmp = os.path.join(tempfile.gettempdir(), f"deeppaint_{os.getpid()}").replace("\\", "/")
    os.makedirs(tmp, exist_ok=True)
    path = f"{tmp}/deeppaint.scumble"
    fails = []
    r = {}
    try:
        r = await c.eval(JS.replace("__PATH__", json.dumps(path)), timeout=300)
        fails = list(r.get("fails", []))
        if os.path.exists(path):
            with zipfile.ZipFile(path, "r") as z:
                hdr = json.loads(z.read("scumble/document.json").decode("utf-8"))
                if hdr.get("minReader") != 7:
                    fails.append(f"the header: minReader {hdr.get('minReader')}, expected 7")
                layers = (hdr.get("document") or {}).get("layers") or []
                surf = [l for l in layers if l.get("filter") == "surface"]
                if not surf or not (surf[0].get("ref") or {}).get("filename"):
                    fails.append(f"the stored layer has no file: {surf}")
        else:
            fails.append("no .scumble was written")
    finally:
        if os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass
        try:
            os.rmdir(tmp)
        except OSError:
            pass
    for f in fails:
        print("[FAIL deeppaint]", f)
    if not fails:
        print(f"[ok] deeppaint on {'tiles' if r.get('tiles') else 'canvas'}")
    return not fails


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        ok = asyncio.run(session(run))
    except Exception as e:
        print(f"[FAIL] CDP test failed: {e}")
        ok = False
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
