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
const r = await c("film.add_point", { x: 130, y: 120, radius: 100, exposure: 1, saturation: 30 });
if (!r.layer || r.points !== 1 || r.point.r !== 100 || !Array.isArray(r.point.color)) throw new Error("add_point: " + JSON.stringify(r));
const r2 = await c("film.add_point", { x: 400, y: 260, exposure: -1 });
if (r2.layer !== r.layer || r2.points !== 2) throw new Error("second point went elsewhere: " + JSON.stringify(r2));
// the picture changed near point 1 and not far away from both
const flat = editor.flattenToCanvas({ forRun: true }).getContext("2d");
const base = editor.base;
const bc = document.createElement("canvas"); bc.width = editor.width; bc.height = editor.height; bc.getContext("2d").drawImage(base.img, 0, 0);
const at = (ctx, x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
const near = at(flat, 130, 120), nearBase = at(bc.getContext("2d"), 130, 120);
if (near.join() === nearBase.join()) throw new Error("point 1 changed nothing at its centre: " + near + " vs " + nearBase);
const far = at(flat, 20, 370), farBase = at(bc.getContext("2d"), 20, 370);
if (far.join() !== farBase.join()) throw new Error("pixels far from the points changed: " + far + " vs " + farBase);
window.__pointsLayer = r.layer;
return { layer: r.layer, near, nearBase, far };
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
