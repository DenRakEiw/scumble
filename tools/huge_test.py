"""The gate of phase E (docs/PLAN_BCE.md §E5): a document larger than any canvas (above 268 MP).

No ComfyUI, no API key; run the instance with --no-comfy (run_gates.sh --offline), or every upload of this test, a PNG of
hundreds of megabytes among them, is forwarded to the connected server.

    python tools/huge_test.py [30000x20000]

A synthetic picture is written per tile (never through a canvas), encoded to a PNG by the pool, and opened from that
file through the stream reader, as a user's file would be. Then what the plan lists: the screen (pan, zoom, a stroke
and its release), the selection (grow, invert), the exports (PNG, PSD), a loopback provider run on a 1024 px selection,
and what a document has to survive besides: undo, the autosave's getValue, a restore.

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555 --no-comfy (tiles on, the default).
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

HELPERS = """
const PNG = await import("./editor/inpaint_png.js");
const T = await import("./editor/inpaint_tiles.js");
const A = await import("./editor/inpaint_arena.js");
const [W, H] = [__W__, __H__];
const timed = async (fn) => {
    let held = 0, last = performance.now(), on = true;
    const beat = () => { const n = performance.now(); held = Math.max(held, n - last); last = n; if (on) setTimeout(beat, 0); };
    setTimeout(beat, 0);
    const t0 = performance.now();
    const r = await fn();
    on = false;
    held = Math.max(held, performance.now() - last);   // a call that never yields is one block
    return { ms: Math.round(performance.now() - t0), blocked: Math.round(held), r };
};
// the picture at (x, y): a gradient, a grid every 1000 px, a block pattern; computed, so any tile can be checked
const colourAt = (x, y) => {
    if (x % 1000 < 6 || y % 1000 < 6) return [250, 250, 250, 255];
    const bx = Math.floor(x / 512), by = Math.floor(y / 512);
    const k = ((bx * 73 + by * 151) % 7) * 12;
    // three bits of noise, so the file compresses like a photograph and not like a test card
    let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) >>> 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0;
    return [((x * 247 / W) | 0) + (n >>> 29), ((y * 247 / H) | 0) + ((n >>> 26) & 7), 80 + k + ((n >>> 23) & 7), 255];
};
const fillTiles = (px, fn) => {
    for (let ty = 0; ty * 256 < px.height; ty++) for (let tx = 0; tx * 256 < px.width; tx++) {
        const t = px.writable(tx, ty), d = t.data;
        const w = Math.min(256, px.width - tx * 256), h = Math.min(256, px.height - ty * 256);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = fn(tx * 256 + x, ty * 256 + y), o = (y * 256 + x) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = c[3]; }
    }
};
const checkTile = (px, tx, ty, what, tolerance = 0) => {
    const w = Math.min(256, W - tx * 256), h = Math.min(256, H - ty * 256);
    const got = px.readRect(tx * 256, ty * 256, w, h).data;
    for (let y = 0; y < h; y += 7) for (let x = 0; x < w; x += 5) {
        const c = colourAt(tx * 256 + x, ty * 256 + y), o = (y * w + x) * 4;
        for (let k = 0; k < 4; k++) if (Math.abs(got[o + k] - c[k]) > tolerance) throw new Error(`${what}: tile ${tx},${ty} pixel ${x},${y} is ${Array.from(got.subarray(o, o + 4))}, the picture has ${c}`);
    }
};
const sampleTiles = [[0, 0], [Math.floor(W / 512), Math.floor(H / 512)], [Math.ceil(W / 256) - 1, Math.ceil(H / 256) - 1], [7, Math.ceil(H / 256) - 1]];
"""

STEPS = [
    ("write_the_png_from_tiles", """
const d = await run("new_document");
window.__hg = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
if (!ed.tileMode) throw new Error("this test needs the tile engine");
const E = ed.constructor;
if (!E.parts.usable()) throw new Error("no PNG parts here");
let px = T.TileLayerPixels.empty(W, H);
const fill = await timed(async () => fillTiles(px, colourAt));
const enc = await timed(() => E.parts.encodeTilePixels(px, { hash: true }));
if (!enc.r) throw new Error("the encode gave nothing");
window.__hgBlob = enc.r.blob;
px.release(); px = null;
return { size: [W, H], MP: Math.round(W * H / 1e6), fillMs: fill.ms, encodeMs: enc.ms, encodeBlocked: enc.blocked, MB: +(enc.r.blob.size / 1048576).toFixed(1), arena: A.arenaStats() };
"""),
    ("open_through_the_stream_reader", """
const ed = ednow(window.__hg);
const file = new File([window.__hgBlob], "huge_test.png", { type: "image/png" });
const o = await timed(() => ed.loadFile(file));
if (ed.width !== W || ed.height !== H) throw new Error("the document is " + ed.width + " x " + ed.height + ": " + ed.status);
for (const [tx, ty] of sampleTiles) checkTile(ed.basePx, tx, ty, "after the stream reader");
return { ms: o.ms, blocked: o.blocked, tiles: ed.basePx.tileCount, status: ed.status };
"""),
    ("the_screen_pan_zoom_and_a_stroke", """
const ed = ednow(window.__hg);
ed.fitView(); ed.draw();
await ed.mipsSettled();
ed.sceneSig = null; ed.draw();
const frame = (fn, n) => { const ts = []; for (let i = 0; i < n; i++) { const a = performance.now(); fn(i); ts.push(performance.now() - a); } ts.sort((x, y) => x - y); return [+ts[ts.length >> 1].toFixed(1), +ts[ts.length - 1].toFixed(1)]; };
const out = {};
out.pan_fit = frame((i) => { ed.view.x += (i % 2 ? -7 : 9); ed.view.y += 3; ed.draw(); }, 30);
ed.view.scale = 1; ed._fitted = false;
ed.view.x = Math.round(ed.canvas.width / 2 - W / 2); ed.view.y = Math.round(ed.canvas.height / 2 - H / 2);
ed.draw(); ed.draw();
out.pan_1to1 = frame((i) => { ed.view.x += (i % 2 ? -7 : 9); ed.view.y += 3; ed.draw(); }, 30);
out.zoom = frame((i) => {
    const ns = Math.min(4, Math.max(0.02, ed.view.scale * (i % 2 ? 1.25 : 0.8)));
    ed.view.x = ed.canvas.width / 2 - (ed.canvas.width / 2 - ed.view.x) * (ns / ed.view.scale);
    ed.view.y = ed.canvas.height / 2 - (ed.canvas.height / 2 - ed.view.y) * (ns / ed.view.scale);
    ed.view.scale = ns; ed.draw();
}, 10);
// a paint layer (sparse: only the tiles a stroke touches exist) and a 400 px stroke on it
const layer = ed.addPaintLayer();
if (!layer) throw new Error("no paint layer: " + ed.status);
ed.setTool("paint"); ed.activeLayerId = layer.id; ed.brushSize = 40; ed.color = "#ff2080";
const cx = Math.round(W / 2), cy = Math.round(H / 2);
ed.pushUndo({ kind: "layer", id: layer.id });
const p = { kind: "layerpaint", layer, stroke: ed.newStrokeBuffer(layer.px), clip: null, erase: false, last: [cx, cy], pressure: 1 };
ed.pointer = p;
out.stroke_frame = frame((i) => { const x = cx + (i + 1) * 10, y = cy + (i % 5) * 6; ed.layerDab(p, p.last[0], p.last[1], x, y); p.last = [x, y]; ed.draw(); }, 40);
const t0 = performance.now();
const box = ed.strokeRect(p, layer.px);
ed.commitStroke(p);
ed.pointer = null;
ed.markLayerChanged(layer, box);
ed.draw();
out.stroke_release = +(performance.now() - t0).toFixed(1);
out.layer_tiles = layer.px.tileCount;
const mid = layer.px.readRect(cx + 200, cy + 12, 1, 1).data;
if (!(mid[3] > 0)) throw new Error("the stroke left no paint at its middle: " + Array.from(mid));
window.__hgLayer = layer.id;
// the plan's bound is a frame; a software-rendered CI machine is slower, so the gate is generous and the numbers are printed
for (const k of ["pan_fit", "pan_1to1", "zoom", "stroke_frame"]) if (out[k][0] > 50) throw new Error(k + " takes " + out[k][0] + " ms a frame");
if (out.stroke_release > 100) throw new Error("the stroke's release took " + out.stroke_release + " ms");
return out;
"""),
    ("undo_and_redo_of_the_stroke", """
const ed = ednow(window.__hg);
const layer = ed.layers.find((l) => l.id === window.__hgLayer);
const cx = Math.round(W / 2), cy = Math.round(H / 2);
const at = () => layer.px.readRect(cx + 200, cy + 12, 1, 1).data[3];
const before = at();
const u = await timed(() => run("undo", { doc: window.__hg }));
const l2 = ed.layers.find((l) => l.id === window.__hgLayer);
const afterUndo = l2 ? l2.px.readRect(cx + 200, cy + 12, 1, 1).data[3] : 0;
if (afterUndo) throw new Error("undo left the stroke: alpha " + afterUndo + " (" + ed.status + ")");
const r = await timed(() => run("redo", { doc: window.__hg }));
const l3 = ed.layers.find((l) => l.id === window.__hgLayer);
const afterRedo = l3.px.readRect(cx + 200, cy + 12, 1, 1).data[3];
if (afterRedo !== before) throw new Error("redo gave alpha " + afterRedo + " for " + before);
return { undoMs: u.ms, redoMs: r.ms, blocked: [u.blocked, r.blocked] };
"""),
    ("selection_grow_and_invert", """
const ed = ednow(window.__hg);
const cx = Math.round(W / 2), cy = Math.round(H / 2);
await run("select_rect", { doc: window.__hg, x: cx - 512, y: cy - 512, w: 1024, h: 1024 });
const b0 = ed.getBounds();
if (!b0 || b0[2] - b0[0] !== 1024) throw new Error("the selection is " + JSON.stringify(b0));
const g = await timed(() => ed.growSelection(16));
const b1 = ed.getBounds();
if (b1[2] - b1[0] !== 1056) throw new Error("grown by 16 the selection is " + JSON.stringify(b1));
const i1 = await timed(() => ed.invertSelection());
const b2 = ed.getBounds();
if (!b2 || b2[0] !== 0 || b2[2] !== W) throw new Error("inverted the selection spans " + JSON.stringify(b2));
const i2 = await timed(() => ed.invertSelection());
const b3 = ed.getBounds();
if (JSON.stringify(b3) !== JSON.stringify(b1)) throw new Error("inverted twice the selection is " + JSON.stringify(b3));
await run("select_rect", { doc: window.__hg, x: cx - 512, y: cy - 512, w: 1024, h: 1024 });
const out = { grow: [g.ms, g.blocked], invert: [i1.ms, i1.blocked], invertBack: [i2.ms, i2.blocked], selTiles: ed.sel.tileCount };
if (g.blocked > 100) throw new Error("grow blocked the window for " + g.blocked + " ms");
return out;
"""),
    ("a_provider_run_on_the_selection", """
const ed = ednow(window.__hg);
const S = await import("./editor/stitch.js");
const answer = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.fillStyle = "#20c060"; x.fillRect(0, 0, w, h); return c; };
const t = await timed(async () => {
    const prep = S.prepareCrop(ed, host.nodeParams, host.cropLimits());
    const fin = S.finishResult(ed, prep.info, prep.sel, answer(prep.info.emitted[0], prep.info.emitted[1]));
    return { prep, fin };
});
const { prep, fin } = t.r;
const [bx, by, bw, bh] = prep.info.bbox;
if (!(prep.sel.w < W) || bw > 4096) throw new Error("the run read the whole image: window " + prep.sel.w + ", crop " + bw + " x " + bh);
// the crop is the picture there (the stroke's layer is over a part of it; a corner of the crop is plain base)
const d = prep.crop.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, 1, 1).data;
const sx = prep.crop.width / bw;
const want = colourAt(bx, by);
if (sx === 1) for (let k = 0; k < 3; k++) if (Math.abs(d[k] - want[k]) > 1) throw new Error("the crop's corner is " + Array.from(d) + ", the picture has " + want);
if (fin.patch.width !== bw || fin.patch.height !== bh) throw new Error("the patch is " + fin.patch.width + " x " + fin.patch.height + " for a box of " + bw + " x " + bh);
return { ms: t.ms, blocked: t.blocked, bbox: prep.info.bbox, emitted: prep.info.emitted, window: [prep.sel.ox, prep.sel.oy, prep.sel.w, prep.sel.h] };
"""),
    ("export_png_and_read_it_back", """
const ed = ednow(window.__hg);
await run("select_none", { doc: window.__hg });
let saved = null;
const was = host.saveExport;
host.saveExport = async (blob, name) => { saved = { blob, name }; return { path: "memory:" + name }; };
let t;
try {
    if (ed.saveFormatSel) ed.saveFormatSel.value = "png";
    t = await timed(() => ed.exportImage({ download: false }));
} finally { host.saveExport = was; }
if (!saved) throw new Error("the export saved nothing: " + ed.status);
// four tiles of the file through the stream reader (the whole file is decoded, only those rows are kept)
const keep = new Map(sampleTiles.map(([tx, ty]) => [ty, null]));
let header = null;
await PNG.readPng(saved.blob, { onHeader: (h) => { header = h; }, onRows: (rgba, y0, rows) => { const ty = y0 / 256; if (keep.has(ty)) keep.set(ty, rgba); } });
if (header.width !== W || header.height !== H) throw new Error("the file is " + header.width + " x " + header.height);
const layer = ed.layers.find((l) => l.id === window.__hgLayer);
for (const [tx, ty] of sampleTiles) {
    const band = keep.get(ty);
    if (!band) throw new Error("no rows for tile row " + ty);
    const w = Math.min(256, W - tx * 256), h = Math.min(256, H - ty * 256);
    for (let y = 0; y < h; y += 7) for (let x = 0; x < w; x += 5) {
        const X = tx * 256 + x, Y = ty * 256 + y;
        if (layer && layer.px.readRect(X, Y, 1, 1).data[3]) continue;   // under the stroke
        const c = colourAt(X, Y), o = (y * W + X) * 4;
        for (let k = 0; k < 3; k++) if (Math.abs(band[o + k] - c[k]) > 1) throw new Error(`the exported tile ${tx},${ty} pixel ${x},${y} is ${Array.from(band.subarray(o, o + 4))}, the picture has ${c}`);
    }
}
window.__hgExport = null;
return { ms: t.ms, blocked: t.blocked, MB: +(saved.blob.size / 1048576).toFixed(1), status: ed.status };
"""),
    ("export_psd", """
const ed = ednow(window.__hg);
let saved = null;
const was = host.saveExport;
host.saveExport = async (blob, name) => { saved = { blob, name }; return { path: "memory:" + name }; };
let t;
try {
    ed.saveFormatSel.value = "psd";
    t = await timed(() => ed.exportImage({ download: false }));
} finally { host.saveExport = was; ed.saveFormatSel.value = "png"; }
if (W > 30000 || H > 30000) { if (saved) throw new Error("a PSD above 30,000 px was written"); return { refused: ed.status }; }
if (!saved) throw new Error("the export saved nothing: " + ed.status);
const head = new Uint8Array(await saved.blob.slice(0, 26).arrayBuffer());
const u32 = (o) => ((head[o] << 24) | (head[o + 1] << 16) | (head[o + 2] << 8) | head[o + 3]) >>> 0;
if (String.fromCharCode(...head.subarray(0, 4)) !== "8BPS" || u32(14) !== H || u32(18) !== W) throw new Error("the PSD's header says " + u32(18) + " x " + u32(14));
return { ms: t.ms, blocked: t.blocked, MB: +(saved.blob.size / 1048576).toFixed(1), status: ed.status };
"""),
    ("a_matched_layer_a_film_look_and_what_is_refused", """
// What an inpainting document holds: a result layer with a colour match and a film look on top. No margin gives a
// matched layer's pixels, and there is no whole flatten to take instead: the bands are what a region pass draws.
const ed = ednow(window.__hg);
const { FILTERS } = await import("./editor/inpaint_filters.js");
const c = document.createElement("canvas"); c.width = 2048; c.height = 2048;
const x = c.getContext("2d"); const g = x.createLinearGradient(0, 0, 2048, 2048); g.addColorStop(0, "#c08040"); g.addColorStop(1, "#4060c0"); x.fillStyle = g; x.fillRect(0, 0, 2048, 2048);
const res = ed.addLayer({ name: "Result", kind: "result", px: ed.pixels.Layer.fromCanvas(c), x: Math.round(W / 4), y: Math.round(H / 4), w: 2048, h: 2048, dirty: true });
res.match = { strength: 60, source: "surroundings" };
ed.markMatchChanged(res);
const fx = ed.addFilterLayer(FILTERS["film.look"] ? "film.look" : "grain");
const plan = ed.bandPlan({ forRun: true });
if (!plan || !plan.inexact) throw new Error("the plan for a matched layer on a huge document is " + JSON.stringify(plan));
let saved = null;
const was = host.saveExport;
host.saveExport = async (blob, name) => { saved = { blob, name }; return { path: "memory:" + name }; };
const out = { plan };
try {
    ed.saveFormatSel.value = "png";
    const t = await timed(() => ed.exportImage({ download: false }));
    if (!saved) throw new Error("the export saved nothing: " + ed.status);
    out.png = { ms: t.ms, blocked: t.blocked, MB: +(saved.blob.size / 1048576).toFixed(1) };
    // the matched layer is in the file: the rows through its middle differ from the base's picture there
    const ty = Math.floor((H / 4 + 1024) / 256);
    let band = null;
    await PNG.readPng(saved.blob, { onRows: (rgba, y0) => { if (y0 / 256 === ty) band = rgba; } });
    const X = Math.round(W / 4) + 1024, o = (X) * 4, base = colourAt(X, ty * 256);
    if (Math.abs(band[o] - base[0]) + Math.abs(band[o + 1] - base[1]) + Math.abs(band[o + 2] - base[2]) < 12) throw new Error("the result layer is not in the exported file: " + Array.from(band.subarray(o, o + 4)) + " against the base's " + base);
    saved = null;
    ed.saveFormatSel.value = "jpg";
    await ed.exportImage({ download: false });
    if (saved || !/larger than any canvas/.test(ed.status)) throw new Error("a JPEG of a document above the canvas limit was not refused: " + ed.status);
    out.jpg = ed.status;
    // a step that rebuilds the whole picture on one canvas says so and leaves the document as it is
    const tiles0 = ed.basePx.tileCount;
    const ext = await run("extend_canvas", { doc: window.__hg, right: 64 }).catch((e) => ({ status: String(e.message || e) }));
    if (ed.width !== W || ed.basePx.tileCount !== tiles0) throw new Error("extend changed the document: " + ed.width + " x " + ed.height);
    if (!/larger than any canvas/.test(ext.status || ed.status)) throw new Error("extend on a document above the canvas limit did not say why it cannot run: " + (ext.status || ed.status));
    out.extend = ext.status || ed.status;
} finally { host.saveExport = was; ed.saveFormatSel.value = "png"; }
ed.removeLayer(fx.id); ed.removeLayer(res.id);
return out;
"""),
    ("the_state_for_the_autosave", """
const ed = ednow(window.__hg);
const cx = Math.round(W / 2), cy = Math.round(H / 2);
await run("select_rect", { doc: window.__hg, x: cx - 300, y: cy - 200, w: 600, h: 400 });
const s = await timed(async () => { await ed.syncLayers(); return ed.getValue(); });
const state = typeof s.r === "string" ? JSON.parse(s.r) : s.r;
if (!state || !state.base) throw new Error("getValue gave no base: " + JSON.stringify(state).slice(0, 200));
// the selection's PNG is written a moment after getValue asks for it
for (let i = 0; i < 200 && !ed.selectionDataUrl && !(ed.getValue && JSON.parse(ed.getValue()).selection); i++) await wait(100);
const again = JSON.parse(ed.getValue());
if (!again.selection) throw new Error("the state holds no selection: " + ed.status);
window.__hgState = ed.getValue();
return { ms: s.ms, blocked: s.blocked, layers: (state.layers || []).length, selection: String(again.selection).slice(0, 40), bytes: window.__hgState.length };
"""),
    ("a_restore_from_the_state", """
const d2 = await run("new_document");
const ed2 = ednow(d2.id);
host.shell.activate(ed2);
const t = await timed(async () => { await ed2.setValue(window.__hgState); for (let i = 0; i < 3000 && ed2._loading; i++) await wait(100); });
if (ed2.width !== W || ed2.height !== H) throw new Error("the restored document is " + ed2.width + " x " + ed2.height + ": " + ed2.status);
for (const [tx, ty] of sampleTiles.slice(0, 2)) checkTile(ed2.basePx, tx, ty, "after the restore");
const b = ed2.getBounds();
const cx = Math.round(W / 2), cy = Math.round(H / 2);
if (!b || b[0] !== cx - 300 || b[2] !== cx + 300) throw new Error("the restored selection is " + JSON.stringify(b));
if (ed2.layers.length !== 1) throw new Error("the restored document has " + ed2.layers.length + " layers");
await run("close_document", { doc: d2.id, force: true });
return { ms: t.ms, blocked: t.blocked };
"""),
    ("close", """
const id = window.__hg;
window.__hgBlob = null; window.__hgState = null;
await run("close_document", { doc: id, force: true });
return { closed: id, arena: A.arenaStats() };
"""),
]

PRE = """(async () => {
    const commands = window.__cmds.commands, host = window.__host;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    %s
    %s
})()"""


async def run_all(c):
    size = next((a for a in sys.argv[1:] if "x" in a.lower() and a[0].isdigit()), "30000x20000")
    w, h = size.lower().split("x")
    helpers = HELPERS.replace("__W__", w).replace("__H__", h)
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); window.__host = (await import('./editor/host.js')).host; await import('./shell.js'); return 1; })()")
    connected = await c.eval("(async () => { const s = await window.scumble.comfy.status(); return s && s.state; })()")
    if connected in ("connected", "missing-node"):
        print("[FAIL] this instance is connected to ComfyUI: start it with --no-comfy (run_gates.sh --offline), or the test's uploads are forwarded to the server")
        print("FAIL")
        return False
    ok = True
    only = [a for a in sys.argv[1:] if not a[0].isdigit() and not a.startswith("-")]
    for name, body in STEPS:
        if only and name not in only:
            continue
        try:
            res = await c.eval(PRE % (helpers, body), timeout=1800)
            print("[ok] %s: %s" % (name, json.dumps(res)[:1200]))
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] %s: %s" % (name, str(err)[:1500]))
            if name in ("write_the_png_from_tiles", "open_through_the_stream_reader"):
                break
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:300])
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
