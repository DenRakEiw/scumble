"""Film pack plugin test against the running app (see tools/cdp.py for the setup).

No ComfyUI needed: loads the test image from the local mirror, then checks every film filter
on the GPU and the CPU path (same maths, at most two levels apart), the film look presets,
the commands film.looks / film.apply_look / film.add_point, the control point tool through
the pointer and key hooks (place, resize, move, delete, undo), the layer-row control, the
Film looks panel thumbnails and the exports. Writes one PNG per filter to out_dir/film.

    python tools/film_test.py [out_dir]
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "dist", "smoke"))
os.makedirs(os.path.join(OUT, "film"), exist_ok=True)
FILM_DIR = json.dumps(os.path.join(OUT, "film").replace(os.sep, "/"))

STEPS = [
    ("plugin_loaded", """
const P = await import("./plugins.js");
const list = await P.pluginHost.list();
const film = list.find((p) => p.id === "film");
if (!film) throw new Error("film plugin not listed: " + list.map((p) => p.id));
if (film.error) throw new Error("film plugin error: " + film.error);
const types = await c("filter_types");
const ids = types.filters.filter((f) => f.plugin === "film").map((f) => f.id);
const want = ["film.look", "film.halation", "film.glow", "film.tonal_contrast", "film.structure", "film.bleach_bypass", "film.cross_process", "film.split_tone", "film.light_leak", "film.frame", "film.bw", "film.points"];
const missing = want.filter((w) => !ids.includes(w));
if (missing.length) throw new Error("filters missing: " + missing);
const cmds = (await c("list_commands")).commands.map((x) => x.name);
for (const n of ["film.looks", "film.apply_look", "film.add_point"]) if (!cmds.includes(n)) throw new Error("command missing: " + n);
return { filters: ids.length, commands: 3 };
"""),
    ("document", """
const d = await c("new_document");
window.__filmDoc = d.id;
const r = await fetch("/comfy/view?filename=test_base.png&subfolder=inpaint_canvas&type=input");
if (r.status !== 200) throw new Error("test image " + r.status + " (run the smoke test once so it is in the mirror)");
const s = await c("load_image", { filename: "test_base.png", subfolder: "inpaint_canvas", type: "input", doc: d.id });
return { width: s.width, height: s.height };
"""),
    ("gpu_vs_cpu", """
const F = await import("./editor/inpaint_filters.js");
const GL = await import("./editor/inpaint_filters_gl.js");
const src = editor.flattenToCanvas({ forRun: true });
const W = src.width, H = src.height;
const cases = {
  "film.look": [{ preset: "portra400" }, { preset: "velvia50", push: 1 }, { preset: "trix400" }, { preset: "cinestill800t" }, { preset: "custom", contrast: 20, warmth: 20 }],
  "film.halation": [{ strength: 80, radius: 20, threshold: 55 }],
  "film.glow": [{ mode: "soft", amount: 80 }, { mode: "screen", amount: 60, threshold: 50 }, { mode: "lighten", amount: 60 }],
  "film.tonal_contrast": [{ highlights: 60, midtones: 70, shadows: 60 }],
  "film.structure": [{ amount: 100, radius: 4 }, { amount: -100, radius: 6, luminance: false }],
  "film.bleach_bypass": [{}],
  "film.cross_process": [{ style: "e6c41" }, { style: "c41e6", shift: 40 }, { style: "lomo" }, { style: "cool" }],
  "film.split_tone": [{ hi_sat: 70, sh_sat: 70 }, { preserve: false, balance: 40 }],
  "film.light_leak": [{ style: "edge" }, { style: "streak" }, { style: "corner" }, { style: "double" }, { style: "bars", seed: 5 }],
  "film.frame": [{ style: "line" }, { style: "matte" }, { style: "rebate", radius: 6 }, { style: "slide", colour: "cream" }, { style: "instant" }, { style: "rough", roughness: 80 }, { style: "oval", softness: 30 }],
  "film.bw": [{ preset: "red", filter_hue: 10, filter_strength: 90, structure: 50 }, { tone: "sepia", tone_strength: 80, grain: 40 }, { tone: "split", tone_strength: 100, structure: -50 }],
  "film.points": [{ points: [{ id: 1, x: 130, y: 120, r: 110, tol: 60, ev: 1.2, contrast: 10, sat: 40, warmth: 40, structure: 30, color: [0.4, -0.2, 0.3] }, { id: 2, x: 380, y: 250, r: 120, tol: 60, ev: -1, contrast: 30, sat: -60, warmth: -40, structure: 0, color: [0.5, 0.3, -0.1] }] }],
};
const out = {}, bad = [];
for (const [id, list] of Object.entries(cases)) {
  for (const over of list) {
    const p = { ...F.filterDefaults(id), ...over };
    const a = F.applyFilter(id, src, p, { cpu: true, scale: 1, seed: 7, cache: {} });
    const b = F.applyFilter(id, src, p, { scale: 1, seed: 7, cache: {} });
    const pa = a.getContext("2d").getImageData(0, 0, W, H).data, pb = b.getContext("2d").getImageData(0, 0, W, H).data, ps = src.getContext("2d").getImageData(0, 0, W, H).data;
    let max = 0, over2 = 0, n = 0, changed = 0;
    for (let i = 0; i < pa.length; i++) { if ((i & 3) === 3) continue; const df = Math.abs(pa[i] - pb[i]); if (df > max) max = df; if (df > 2) over2++; if (pa[i] !== ps[i]) changed++; n++; }
    const key = id + " " + JSON.stringify(over).slice(0, 40);
    out[key] = { max, over2: +(over2 / n * 100).toFixed(3), changed: +(changed / n * 100).toFixed(1) };
    if (GL.glFiltersAvailable() && (max > 4 || over2 / n > 0.001)) bad.push(key + " " + JSON.stringify(out[key]));
    if (changed === 0) bad.push(key + " changed nothing");
  }
}
const warn = (window.__log || []).filter((l) => /WebGL2 filter film|plugin film/.test(l[1]));
if (warn.length) bad.push("console: " + warn.map((l) => l[1].slice(0, 120)).join(" | "));
if (bad.length) throw new Error(bad.join("; "));
return { cases: Object.keys(out).length, gl: GL.glFiltersAvailable(), worst: Math.max(...Object.values(out).map((o) => o.max)) };
"""),
    ("look_commands", """
const looks = await c("film.looks");
if (!looks.stocks || looks.stocks.length < 40) throw new Error("film.looks: " + JSON.stringify(looks).slice(0, 100));
const bw = await c("film.looks", { group: "Black & white" });
if (!bw.stocks.length || bw.stocks.some((s) => s.group !== "Black & white")) throw new Error("group filter");
const l1 = await c("film.apply_look", { preset: "portra400", strength: 80 });
if (l1.filter !== "film.look" || l1.params.preset !== "portra400" || l1.params.strength !== 80) throw new Error("apply_look add: " + JSON.stringify(l1));
await c("set_active_layer", { layer: l1.id });
const l2 = await c("film.apply_look", { preset: "velvia50" });
if (l2.id !== l1.id || l2.params.preset !== "velvia50") throw new Error("apply_look should change the active look layer: " + JSON.stringify(l2));
const layers = (await c("list_layers")).layers;
const lk = layers.find((l) => l.id === l1.id);
if (!lk || !/Velvia/.test(lk.name)) throw new Error("layer not renamed: " + (lk && lk.name));
let bad = null;
try { await c("film.apply_look", { preset: "nope" }); } catch (e) { bad = e.message; }
if (!bad) throw new Error("unknown stock accepted");
// undo takes the preset change back
await c("undo");
const back = (await c("list_layers")).layers.find((l) => l.id === l1.id);
if (!back || back.params.preset !== "portra400") throw new Error("undo: " + JSON.stringify(back && back.params));
await c("remove_layer", { layer: l1.id });
return { stocks: looks.stocks.length, bw: bw.stocks.length };
"""),
    ("add_point_command", """
// C6 (c1): a point's colour is the 3 x 3 mean under it of the points layer's input (everything below that layer) at
// full resolution, read as one small box: no whole flatten, no mirror, and not the picture the last full-resolution
// render left (it went stale), not the points' own effect, not the layers above.
const P = await import("./plugins.js");
const ed = editor;
const opp = (r, g, b) => { const L = 0.299 * r + 0.587 * g + 0.114 * b; return [L, r - L, b - L]; };
const colourBelow = (layerId, x, y) => {
    const idx = ed.layers.findIndex((l) => l.id === layerId);
    const flat = ed.flattenToCanvas({ forRun: true, upTo: idx });
    const d = flat.getContext("2d").getImageData(x - 1, y - 1, 3, 3).data;
    let r = 0, g = 0, b = 0; for (let i = 0; i < 36; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    return opp(r / 9 / 255, g / 9 / 255, b / 9 / 255);
};
const same = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 1e-6);
const counted = async (fn) => {
    const f0 = ed.flattenToCanvas, d0 = P.Document.prototype.flatten;
    const n = { flatten: 0, whole: 0 };
    ed.flattenToCanvas = function (...a) { n.flatten++; return f0.apply(this, a); };
    P.Document.prototype.flatten = function (o) { if (!o || (!o.maxSize && !o.box)) n.whole++; return d0.call(this, o); };
    try { return [await fn(), n]; } finally { ed.flattenToCanvas = f0; P.Document.prototype.flatten = d0; }
};
const T = await import("./editor/inpaint_tiles.js");
ed.releaseCaches({ mirrors: true });
const [r, n1] = await counted(() => c("film.add_point", { x: 130, y: 120, radius: 100, exposure: 1, saturation: 30 }));
if (!r.layer || r.points !== 1 || r.point.r !== 100 || !Array.isArray(r.point.color)) throw new Error("add_point: " + JSON.stringify(r));
if (n1.flatten || n1.whole) throw new Error("placing a point flattened the picture: " + JSON.stringify(n1));
if (ed.tileMode && ed.memoryReport().tiles.mirrors) throw new Error("placing a point made " + ed.memoryReport().tiles.mirrors + " display mirrors");
const want1 = colourBelow(r.layer, 130, 120);
if (!same(r.point.color, want1)) throw new Error("point 1's colour " + JSON.stringify(r.point.color) + " is not the picture below it " + JSON.stringify(want1));
// what the last full-resolution render leaves (the export, a run): the colour must not come from it after a change below
ed.flattenToCanvas({ forRun: true });
const under = await c("add_paint_layer", { name: "Under the points" });
await c("move_layer", { layer: under.id, to: "bottom" });
{   // a hard edge through x = 400 around the second point's place: red left of it, green from it on
    const U = ed.layers.find((l) => l.id === under.id);
    const img = new ImageData(120, 120);
    for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) { const i = (y * 120 + x) * 4; if (x < 60) { img.data[i] = 220; img.data[i + 1] = 30; img.data[i + 2] = 40; } else { img.data[i] = 30; img.data[i + 1] = 200; img.data[i + 2] = 60; } img.data[i + 3] = 255; }
    U.px.writeRect(img, 340, 200);
    ed.markLayerChanged(U, [340, 200, 460, 320]);
}
const [r2, n2] = await counted(() => c("film.add_point", { x: 400, y: 260, exposure: -1 }));
if (r2.layer !== r.layer || r2.points !== 2) throw new Error("second point went elsewhere: " + JSON.stringify(r2));
if (n2.flatten || n2.whole) throw new Error("the second point flattened the picture: " + JSON.stringify(n2));
const want2 = colourBelow(r.layer, 400, 260);
if (!same(r2.point.color, want2)) throw new Error("point 2 on the edge painted below took " + JSON.stringify(r2.point.color) + ", the picture below is " + JSON.stringify(want2));
// a point where point 1 already acts, under a layer above the points layer: still the colour below both
const over = await c("add_paint_layer", { name: "Over the points" });
{
    const O = ed.layers.find((l) => l.id === over.id);
    const img = new ImageData(40, 40); for (let i = 0; i < img.data.length; i += 4) { img.data[i] = 10; img.data[i + 1] = 10; img.data[i + 2] = 250; img.data[i + 3] = 255; }
    O.px.writeRect(img, 110, 100);
    ed.markLayerChanged(O, [110, 100, 150, 140]);
}
const pl = P.Document ? new P.Document(ed) : null;
const layerObj = ed.layers.find((l) => l.id === r.layer);
const [r3] = await counted(() => c("film.add_point", { x: 132, y: 121, exposure: 0.5 }));
const want3 = colourBelow(r.layer, 132, 121);
if (!same(r3.point.color, want3)) throw new Error("point 3 took " + JSON.stringify(r3.point.color) + " with the points' own effect or the layer above in it; the picture below is " + JSON.stringify(want3));
const flatNow = ed.flattenToCanvas({ forRun: true }).getContext("2d").getImageData(131, 120, 3, 3).data;
const whole3 = (() => { let a = 0, b = 0, cc = 0; for (let i = 0; i < 36; i += 4) { a += flatNow[i]; b += flatNow[i + 1]; cc += flatNow[i + 2]; } return opp(a / 9 / 255, b / 9 / 255, cc / 9 / 255); })();
if (same(whole3, want3)) throw new Error("the test cannot tell the picture below from the whole picture at point 3");
// back to the two points the steps after this one expect, and the helper layers gone
await c("remove_layer", { layer: over.id });
await c("remove_layer", { layer: under.id });
pl.setFilterParams(r.layer, { points: layerObj.params.points.slice(0, 2) });
// the picture changed near point 1 and not far away from both
const flat = editor.flattenToCanvas({ forRun: true }).getContext("2d");
const bc = document.createElement("canvas"); bc.width = editor.width; bc.height = editor.height; editor.basePx.drawTo(bc.getContext("2d"), 0, 0);
const at = (ctx, x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
const near = at(flat, 130, 120), nearBase = at(bc.getContext("2d"), 130, 120);
if (near.join() === nearBase.join()) throw new Error("point 1 changed nothing at its centre: " + near + " vs " + nearBase);
const far = at(flat, 20, 370), farBase = at(bc.getContext("2d"), 20, 370);
if (far.join() !== farBase.join()) throw new Error("pixels far from the points changed: " + far + " vs " + farBase);
window.__pointsLayer = r.layer;
return { layer: r.layer, near, nearBase, far };
"""),
    ("points_in_a_box_away_from_the_origin", """
// C6 (c1) review: the control points are placed in the image, whatever part of it a pass composites. Their shader and
// CPU path measured a point from the pass's own corner, so a box read over a point (the sample plugin's exact reads, a
// region pass on the screen at zoom) returned the picture without the point's effect. And a point's colour is the
// points layer's input even under a filter no box of its surroundings can give (a vignette): the whole flatten below.
// Its own document, closed at the end; the film document is active again after it.
const P = await import("./plugins.js");
const H0 = (await import("./editor/host.js")).host;
const d = await c("new_document");
const ed = H0.editors().find((e) => e.node.id === d.id);
H0.shell.activate(ed);
await c("new_canvas", { width: 1600, height: 1200, doc: d.id });
const W = 1600, H = 1200;
const base = document.createElement("canvas"); base.width = W; base.height = H;
{
    const x = base.getContext("2d");
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#506070"); g.addColorStop(1, "#907860");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 120; i++) { x.fillStyle = `hsl(${(i * 53) % 360},45%,${35 + (i * 11) % 30}%)`; x.fillRect((i * 331) % (W - 60), (i * 197) % (H - 60), 60, 60); }
}
Object.defineProperty(base, "naturalWidth", { value: W });
Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "pointsbox.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
const doc = new P.Document(ed);
const read = (cv, x = 0, y = 0, w = cv.width, h = cv.height) => cv.getContext("2d").getImageData(x, y, w, h).data;
const diff = (a, b) => { let m = 0, n = 0; for (let i = 0; i < a.length; i++) { const q = Math.abs(a[i] - b[i]); if (q > m) m = q; if (q > 1) n++; } return [m, n]; };
const out = { tiles: ed.tileMode };
const r = await c("film.add_point", { x: 1100, y: 800, radius: 250, tolerance: 100, exposure: 1, doc: d.id });
const idx = ed.layers.findIndex((l) => l.id === r.layer);
// (1) an exact box over the point at full resolution, clear of the origin
const box = [1000, 700, 1200, 900];
if (ed.boxReach(box) !== 0) throw new Error("the stack's reach is " + ed.boxReach(box) + ": the step would not read a box");
const whole = ed.flattenToCanvas({ forRun: true });
const belowPts = ed.flattenToCanvas({ forRun: true, upTo: idx });
const want = read(whole, box[0], box[1], 200, 200);
const [acts] = diff(want, read(belowPts, box[0], box[1], 200, 200));
if (acts < 40) throw new Error("the point barely changes the picture around it (" + acts + " levels): the step proves nothing");
const [bm, bn] = diff(read(doc.flatten({ box, exact: true })), want);
out.box = { acts, max: bm, over1: bn };
if (bm > 1) throw new Error("an exact box over the point differs from the whole flatten by " + bm + " levels on " + bn + " bytes: the point is not where the image has it");
// (2) mean_color of a selection at the point: the whole flatten's mean there
await c("select_rect", { x: 1050, y: 750, w: 100, h: 100, doc: d.id });
const mean = await c("sample.mean_color", { doc: d.id });
await c("select_none", { doc: d.id });
{
    const px = read(whole, 1050, 750, 100, 100); let s = [0, 0, 0];
    for (let i = 0; i < px.length; i += 4) { s[0] += px[i]; s[1] += px[i + 1]; s[2] += px[i + 2]; }
    const m = s.map((v) => Math.round(v / 10000));
    out.mean = [mean.rgb, m];
    if (JSON.stringify(mean.rgb) !== JSON.stringify(m)) throw new Error("mean_color at the point " + JSON.stringify(mean.rgb) + " is not the whole flatten's " + JSON.stringify(m));
}
// (3) a pass at 0.5 over a region that does not start at the origin: the pass over the whole image there
{
    const reg = ed.sampleRegion("image", [800, 600, 1400, 1000], 0.5, { forRun: true });
    const all = ed.sampleRegion("image", [0, 0, W, H], 0.5, { forRun: true });
    const [hm, hn] = diff(read(reg), read(all, 400, 300, 300, 200));
    out.half = { max: hm, over1: hn };
    if (hm > 2) throw new Error("a pass at 0.5 over the point's region differs from the pass over the whole image by " + hm + " levels on " + hn + " bytes");
    // the CPU path places the points by the origin as the shader does
    const F = await import("./editor/inpaint_filters.js");
    const GL = await import("./editor/inpaint_filters_gl.js");
    const layer = ed.layers.find((l) => l.id === r.layer);
    const src = ed.sampleRegion("image", [800, 600, 1400, 1000], 1, { forRun: true, upTo: idx });
    const info = { scale: 1, origin: [800, 600], seed: 7, cache: {} };
    const cpu = read(F.applyFilter("film.points", src, layer.params, { ...info, cpu: true }));
    const gpu = read(F.applyFilter("film.points", src, layer.params, { ...info, cache: {} }));
    const [cm, cn] = diff(cpu, read(src));
    const [gm, gn] = diff(cpu, gpu);
    out.cpu = { acts: cm, vsGpu: gm, gl: GL.glFiltersAvailable() };
    if (cm < 40) throw new Error("the CPU path over the point's region changed " + cm + " levels: the point is not where the image has it");
    if (GL.glFiltersAvailable() && gm > 2) throw new Error("the points' CPU and GPU paths with an origin differ by " + gm + " levels on " + gn + " bytes");
}
// (4) a vignette under the points layer: its picture depends on the whole image, so no margin around a box gives the
// input under a point near the corner; the point's colour is the whole flatten below the points layer there
const vig = await c("add_filter", { type: "vignette", doc: d.id });
await c("move_layer", { layer: vig.id, to: "bottom", doc: d.id });
const f0 = ed.flattenToCanvas; let flats = 0;
ed.flattenToCanvas = function (...q) { flats++; return f0.apply(this, q); };
let r2;
try { r2 = await c("film.add_point", { x: 1500, y: 1120, radius: 80, tolerance: 10, exposure: 1, doc: d.id }); } finally { ed.flattenToCanvas = f0; }
const pts = ed.layers.findIndex((l) => l.id === r.layer);
const opp = (rr, gg, bb) => { const L = 0.299 * rr + 0.587 * gg + 0.114 * bb; return [L, rr - L, bb - L]; };
const mean9 = (cv, x0, y0) => { const q = read(cv, x0, y0, 3, 3); let a = 0, b = 0, e = 0; for (let i = 0; i < 36; i += 4) { a += q[i]; b += q[i + 1]; e += q[i + 2]; } return opp(a / 9 / 255, b / 9 / 255, e / 9 / 255); };
const want2 = mean9(ed.flattenToCanvas({ forRun: true, upTo: pts }), 1499, 1119);
const padded = mean9(doc.flatten({ box: [1499, 1119, 1502, 1122], below: r.layer, pad: 128 }), 0, 0);
out.vignette = { got: r2.point.color, want: want2, padded, flats };
if (Math.abs(padded[0] - want2[0]) < 0.02) throw new Error("the vignette's picture in a padded box is the whole picture's under the point: the step proves nothing " + JSON.stringify(out.vignette));
if (!r2.point.color.every((v, k) => Math.abs(v - want2[k]) < 1e-6)) throw new Error("the point under a vignette took " + JSON.stringify(r2.point.color) + ", the picture below the points layer is " + JSON.stringify(want2));
await c("close_document", { doc: d.id, force: true });
await c("activate_document", { doc: window.__filmDoc });
return out;
"""),
    ("point_tool", """
const H = (await import("./editor/host.js")).host;
const layer = editor.layers.find((l) => l.id === window.__pointsLayer);
await c("set_active_layer", { layer: layer.id });
editor.setTool("film.point");
if (editor.tool !== "film.point") throw new Error("tool not selected");
const fake = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, pressure: 0.5, pointerType: "mouse", type: "pointerdown" };
const undo0 = editor.undo.length;
// place a third point with a drag that sets its size
H.pluginPointer(editor, "down", fake, 250, 300);
H.pluginPointer(editor, "move", { ...fake, type: "pointermove" }, 250 + 60, 300);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 310, 300, editor.pointer); editor.pointer = null;
let pts = layer.params.points;
if (pts.length !== 3 || pts[2].x !== 250 || pts[2].r !== 60) throw new Error("place + size: " + JSON.stringify(pts.map((q) => [q.x, q.y, q.r])));
if (editor.undo.length !== undo0 + 1) throw new Error("placing a point should be one undo step: " + (editor.undo.length - undo0));
if (layer._fpSel !== pts[2].id) throw new Error("new point not selected");
// drag the centre of point 3 to move it
H.pluginPointer(editor, "down", fake, 250, 300);
if (!editor.pointer || editor.pointer.kind !== "plugin") throw new Error("down on a centre not routed");
H.pluginPointer(editor, "move", { ...fake, type: "pointermove" }, 280, 320);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 280, 320, editor.pointer); editor.pointer = null;
pts = layer.params.points;
if (pts[2].x !== 280 || pts[2].y !== 320) throw new Error("move: " + JSON.stringify(pts[2]));
// drag the ring to resize
H.pluginPointer(editor, "down", fake, 280 + 60, 320);
H.pluginPointer(editor, "move", { ...fake, type: "pointermove" }, 280 + 90, 320);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 370, 320, editor.pointer); editor.pointer = null;
pts = layer.params.points;
if (pts[2].r !== 90) throw new Error("resize: " + JSON.stringify(pts[2]));
// a click on the centre of point 1 selects it without an undo step
const undo1 = editor.undo.length;
H.pluginPointer(editor, "down", fake, 130, 120);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 130, 120, editor.pointer); editor.pointer = null;
if (layer._fpSel !== pts[0].id) throw new Error("click did not select point 1");
if (editor.undo.length !== undo1) throw new Error("selecting pushed an undo step");
// Delete removes the selected point, undo brings it back
const del = H.pluginKey(editor, { key: "Delete", shiftKey: false, preventDefault() {} }, "delete");
if (!del || layer.params.points.length !== 2) throw new Error("Delete: " + layer.params.points.length);
await c("undo");
if (layer.params.points.length !== 3) throw new Error("undo after delete: " + layer.params.points.length);
// the layer row shows chips and sliders for the selected point
const row = editor.root.querySelector(".film-points");
if (!row || row.querySelectorAll(".film-chip").length !== 3) throw new Error("layer-row control missing or wrong chip count");
if (!row.querySelector(".film-chip-on")) throw new Error("no selected chip");
if (row.querySelectorAll("input[type=range]").length < 7) throw new Error("point sliders missing");
// the overlay draw hook runs for the tool (no exception, canvas repainted)
editor.draw();
editor.setTool("select");
return { points: layer.params.points.map((q) => ({ x: q.x, y: q.y, r: q.r })), undoSteps: editor.undo.length - undo0 };
"""),
    ("panel_thumbnails", """
const sec = Array.from(editor.root.querySelectorAll("details")).find((d) => d.querySelector("summary") && d.querySelector("summary").textContent === "Film looks");
if (!sec) throw new Error("Film looks panel missing");
sec.open = true;
const grp = sec.querySelector("select");
grp.value = "Slide"; grp.dispatchEvent(new Event("change"));
await new Promise((r) => setTimeout(r, 1500));
const cvs = Array.from(sec.querySelectorAll(".film-cell canvas"));
const filled = cvs.filter((cv) => { const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false; });
if (cvs.length < 4 || filled.length !== cvs.length) throw new Error(`thumbnails: ${filled.length} of ${cvs.length} rendered`);
// clicking a cell adds a look layer
const before = editor.layers.length;
sec.querySelector(".film-cell").click();
await new Promise((r) => setTimeout(r, 300));
const added = editor.layers.find((l) => l.kind === "filter" && l.filter === "film.look");
if (editor.layers.length !== before + 1 || !added) throw new Error("click did not add a look layer");
await c("remove_layer", { layer: added.id });
sec.open = false;
return { thumbnails: cvs.length };
"""),
    ("exports", """
const H = (await import("./editor/host.js")).host;
const cases = [["look_portra400", "film.look", { preset: "portra400" }], ["halation", "film.halation", { strength: 80 }], ["frame_instant", "film.frame", { style: "instant" }], ["bw_red", "film.bw", { preset: "red", filter_hue: 10, filter_strength: 90 }], ["points", null, null]];
const files = [];
for (const [name, type, params] of cases) {
  let layer = null;
  if (type) layer = await c("add_filter", { type, params, name });
  const path = %s + "/" + name + ".png";
  const r = await c("export", { format: "png", path });
  if (!r || !r.file || !r.file.path) throw new Error("export " + name + ": " + JSON.stringify(r).slice(0, 120));
  files.push(r.file.name);
  if (layer) await c("remove_layer", { layer: layer.id });
}
H.exportPath = null;
return { files };
""" % FILM_DIR),
    ("close", """
await c("close_document", { doc: window.__filmDoc, force: true });
return { closed: true };
"""),
]


async def main():
    sys.stdout.reconfigure(encoding="utf-8")

    async def run(cdp):
        ev = cdp.eval
        await ev("(() => { window.__log = []; return 1; })()")
        failed = 0
        for name, body in STEPS:
            js = "(async () => { const raw = await import('./commands.js'); const c = (n, a) => raw.commands.run(n, a || {}); const editor = window.editor; " + body + " })()"
            try:
                res = await ev(js)
                print(f"PASS {name}: {json.dumps(res)[:300]}")
            except Exception as err:  # noqa: BLE001
                failed += 1
                print(f"FAIL {name}: {err}")
                try:
                    log = await ev("JSON.stringify((window.__log || []).slice(-8))")
                    print("  console:", str(log)[:1200])
                except Exception:  # noqa: BLE001
                    pass
        print("RESULT", "PASS" if not failed else f"FAIL ({failed})")
        return not failed

    return await session(run)


if __name__ == "__main__":
    sys.exit(0 if asyncio.run(main()) else 1)
