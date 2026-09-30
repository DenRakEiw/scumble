"""Opening PSD and ORA files with their layers (renderer/editor/inpaint_layered.js, the editor's loadLayered).

No ComfyUI, no key. First `node tools/layered_test.js` (the reader on files built byte by byte), then the app:

- the round trip: a document with a base and three layers (offset, multiply at half opacity, hidden, a half
  transparent edge) saved as PSD and as ORA through the `export` command, then opened with `load_image`: the same
  size, the base's bytes, every layer's name, box, opacity, visibility, blend and bytes;
- a file whose bottom layer does not cover the picture opens over a transparent base, its mask kept as a mask (the
  pixels untouched) and its hidden group a hidden folder (its layer's own eye on), with the notes in the status line;
- layer masks (docs/PLAN_0_1_31.md 3e): a painted layer with a feathered mask from a selection and an image layer whose
  mask is switched off, saved as PSD by the band writer (on tiles) and by the canvas writers (`bands` off), opened
  again: the pixels raw, the masks byte for byte, the switch kept, the note; the worker's layers equal the main
  thread's PsdWriter's and the band writer's; an ORA of it bakes the enabled mask and leaves the switched-off one;
- a PSD dropped on an open document adds its layers (the bottom one included) where the file has them;
- a file named .png that is a PSD is still read as one (the first bytes decide); the layers reach the local store
  (`syncLayers`), so autosave keeps them.

    python tools/layered_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555 --no-comfy
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="scumble_layered_")
J = lambda p: json.dumps(os.path.join(TMP, p).replace("\\", "/"))  # noqa: E731

# the layers' bytes, read through the backend, and how far two sets of them are apart
HELP = """
const bytesOf = (px, w, h) => Array.from(px.readRect(0, 0, w, h).data);
const alphaOf = (a) => a.filter((_, i) => i % 4 === 3);
const far = (a, b) => { if (a.length !== b.length) return 999; let m = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; } return m; };
const shape = (l) => ({ name: l.name, x: l.x, y: l.y, w: l.w, h: l.h, opacity: Math.round((l.opacity ?? 1) * 255), visible: l.visible !== false, blend: l.blend || "normal" });
"""

STEPS = [
    ("setup_a_document_with_layers", """
const d = await run("new_document");
window.__l = { src: d.id, more: [] };
const ed = ednow(d.id);
host.shell.activate(ed);
const c = document.createElement("canvas");
c.width = 160; c.height = 100;
const g = c.getContext("2d");
for (let x = 0; x < 160; x += 4) { g.fillStyle = `rgb(${x}, ${255 - x}, 80)`; g.fillRect(x, 0, 4, 100); }
await ed.setBaseFromCanvas(c);
const mk = (w, h, draw) => { const k = document.createElement("canvas"); k.width = w; k.height = h; draw(k.getContext("2d")); return ed.pixels.Layer.fromCanvas(k); };
const a = ed.addLayer({ name: "Offset opaque", kind: "image", ref: null, px: mk(30, 20, (x) => { x.fillStyle = "#c83214"; x.fillRect(0, 0, 30, 20); x.fillStyle = "#1464c8"; x.fillRect(10, 5, 10, 10); }), x: 12, y: 7, w: 30, h: 20, dirty: true });
const b = ed.addLayer({ name: "Multiply half", kind: "image", ref: null, px: mk(40, 30, (x) => { x.fillStyle = "#80ff40"; x.fillRect(0, 0, 40, 30); }), x: 100, y: 60, w: 40, h: 30, opacity: 128 / 255, blend: "multiply", dirty: true });
const h = ed.addLayer({ name: "Hidden \\u00e4\\u00f6\\u00fc", kind: "image", ref: null, px: mk(20, 20, (x) => { x.fillStyle = "#ffffff"; x.fillRect(0, 0, 20, 10); }), x: 60, y: 40, w: 20, h: 20, visible: false, dirty: true });
window.__l.layers = ed.layers.map((l) => ({ ...shape(l), bytes: bytesOf(l.px, l.w, l.h) }));
window.__l.base = bytesOf(ed.basePx, 160, 100);
await run("export", { doc: d.id, format: "psd", path: %(PSD)s });
await run("export", { doc: d.id, format: "ora", path: %(ORA)s });
return { layers: window.__l.layers.map((l) => l.name) };
"""),
    ("a_psd_opens_with_its_layers", """
const d = await run("new_document");
window.__l.psd = d.id;
await run("load_image", { doc: d.id, path: %(PSD)s });
const ed = ednow(d.id);
if (ed.width !== 160 || ed.height !== 100) throw new Error("size " + ed.width + "x" + ed.height);
const bf = far(bytesOf(ed.basePx, 160, 100), window.__l.base);
if (bf > 0) throw new Error("the base is not the Background's bytes (" + bf + " levels off)");
if (ed.layers.length !== 3) throw new Error("layers: " + ed.layers.map((l) => l.name).join(", "));
const out = [];
for (let i = 0; i < 3; i++) {
    const want = window.__l.layers[i], got = ed.layers[i];
    const a = JSON.stringify({ ...want, bytes: undefined }), b = JSON.stringify(shape(got));
    if (a !== b) throw new Error("layer " + i + ": " + b + " instead of " + a);
    const f = far(bytesOf(got.px, got.w, got.h), want.bytes);
    if (f > 0) throw new Error(`the pixels of ${got.name} are ${f} levels off`);
    if (got.kind !== "image" || !got.dirty) throw new Error("an opened layer is not a dirty image layer: " + got.kind);
    out.push(got.name);
}
if (ed.activeLayerId !== ed.layers[2].id) throw new Error("the top layer is not the active one");
if (!/Opened .*3 layers over "Background" as the base/.test(ed.status)) throw new Error("status: " + ed.status);
if (ed.undo.length) throw new Error("opening left undo steps: " + ed.undo.length);
// the layers reach the local store, so autosave and a restart keep them
await ed.syncLayers();
if (ed.layers.some((l) => !l.ref)) throw new Error("a layer has no file in the local store after syncLayers");
return { layers: out, status: ed.status };
"""),
    ("an_ora_opens_with_its_layers", """
const d = await run("new_document");
window.__l.ora = d.id;
await run("load_image", { doc: d.id, path: %(ORA)s });
const ed = ednow(d.id);
if (ed.width !== 160 || ed.height !== 100) throw new Error("size " + ed.width + "x" + ed.height);
const bf = far(bytesOf(ed.basePx, 160, 100), window.__l.base);
if (bf > 0) throw new Error("the base is " + bf + " levels off");
if (ed.layers.length !== 3) throw new Error("layers: " + ed.layers.map((l) => l.name).join(", "));
for (let i = 0; i < 3; i++) {
    const want = window.__l.layers[i], got = ed.layers[i];
    const w = { ...want, bytes: undefined, opacity: undefined }, s = { ...shape(got), opacity: undefined };
    if (JSON.stringify(w) !== JSON.stringify(s)) throw new Error("layer " + i + ": " + JSON.stringify(s) + " instead of " + JSON.stringify(w));
    // ORA writes the opacity with three decimals
    if (Math.abs(got.opacity * 255 - want.opacity) > 0.5) throw new Error("opacity of " + got.name + ": " + got.opacity);
    const f = far(bytesOf(got.px, got.w, got.h), want.bytes);
    if (f > 0) throw new Error(`the pixels of ${got.name} are ${f} levels off`);
}
return { layers: ed.layers.map((l) => l.name), status: ed.status };
"""),
    ("a_file_without_a_covering_bottom_opens_over_a_transparent_base", """
const d = await run("new_document");
await run("load_image", { doc: d.id, path: %(LOOSE_PSD)s });
const ed = ednow(d.id);
if (ed.width !== 40 || ed.height !== 30) throw new Error("size " + ed.width + "x" + ed.height);
const base = bytesOf(ed.basePx, 40, 30);
if (base.some((v, i) => i %% 4 === 3 && v !== 0)) throw new Error("the base is not transparent");
const names = ed.layers.map((l) => l.name);
if (JSON.stringify(names) !== JSON.stringify(["Corner", "Hidden inside", "Masked"])) throw new Error("layers: " + names.join(", "));
const [corner, hidden, masked] = ed.layers;
if (corner.x !== 3 || corner.y !== 2 || corner.w !== 10 || corner.h !== 8) throw new Error("Corner's box: " + JSON.stringify(shape(corner)));
// the hidden group comes back as a hidden folder (PLAN_0_1_31 §6.5): its layer keeps its own eye and is not drawn
const grp = ed.groups.length === 1 ? ed.groups[0] : null;
if (!grp || grp.name !== "Group" || grp.visible !== false || hidden.group !== grp.id || corner.group || masked.group) throw new Error("the group: " + JSON.stringify(ed.groups) + " " + JSON.stringify(ed.layers.map((l) => l.group)));
if (hidden.visible !== true || ed.shown(hidden) || !ed.shown(corner)) throw new Error("the hidden group did not hide its layer only");
// the mask (255 over the left half of the layer, default 0 elsewhere) comes back as a mask, the pixels untouched
const m = bytesOf(masked.px, 20, 30);
const alpha = (x, y) => m[(y * 20 + x) * 4 + 3];
if (alpha(2, 5) !== 255 || alpha(15, 5) !== 255) throw new Error("the mask went into the pixels: " + alpha(2, 5) + " / " + alpha(15, 5));
if (!masked.maskPx || masked.maskPx.width !== 20 || masked.maskPx.height !== 30) throw new Error("the mask did not come back as a mask of the layer's size");
const mm = bytesOf(masked.maskPx, 20, 30);
const ma = (x, y) => mm[(y * 20 + x) * 4 + 3];
if (ma(2, 5) !== 255 || ma(9, 29) !== 255 || ma(10, 0) !== 0 || ma(15, 5) !== 0 || masked.maskOff) throw new Error(`the mask: ${ma(2, 5)} ${ma(9, 29)} ${ma(10, 0)} ${ma(15, 5)}, off ${masked.maskOff}`);
if (corner.maskPx || hidden.maskPx) throw new Error("a layer without a mask came back with one");
if (!/1 layer mask kept as a mask/.test(ed.status) || /applied/.test(ed.status) || !/1 group kept as folder/.test(ed.status) || /as the base/.test(ed.status)) throw new Error("status: " + ed.status);
// the ORA of the same shape: its bottom layer does not cover the picture either; screen at half opacity comes back
await run("load_image", { doc: d.id, path: %(LOOSE_ORA)s });
const o = ednow(d.id);
const on = o.layers.map((l) => `${l.name}@${l.x},${l.y} ${l.w}x${l.h} ${l.blend} ${Math.round(l.opacity * 100)}`);
if (JSON.stringify(on) !== JSON.stringify(["Corner@3,2 10x8 normal 100", "Right@25,4 6x7 screen 50"])) throw new Error("ORA layers: " + on.join(" | "));
if (bytesOf(o.basePx, 40, 30).some((v, i) => i %% 4 === 3 && v !== 0)) throw new Error("the ORA's base is not transparent");
const red = bytesOf(o.layers[0].px, 10, 8).slice(0, 4);
if (red.join() !== "255,0,0,255") throw new Error("the ORA layer's pixels: " + red);
await run("close_document", { doc: d.id });
return { psd: names, ora: on, status: ed.status };
"""),
    ("layer_masks_survive_a_psd_round_trip", """
// 3e: a painted layer with a feathered mask made from a selection and an image layer whose mask is switched off, saved as
// PSD by both export paths (the band writer on tiles, then the canvas writers with the bands switched off) and opened
// again: the pixels come back raw (painted where the mask hides them), the masks byte for byte, the switch kept.
if (typeof ednow(window.__l.src).setMaskOff !== "function") throw new Error("the editor has no setMaskOff (its side of 3e is not built)");
const d = await run("new_document");
window.__l.more.push(d.id);
const ed = ednow(d.id);
host.shell.activate(ed);
const c = document.createElement("canvas");
c.width = 120; c.height = 80;
const g = c.getContext("2d");
for (let x = 0; x < 120; x += 6) { g.fillStyle = `rgb(${2 * x}, 90, ${255 - 2 * x})`; g.fillRect(x, 0, 6, 80); }
await ed.setBaseFromCanvas(c);
const base = bytesOf(ed.basePx, 120, 80);
// opaque or empty pixels only: a canvas round trip keeps them exactly, the masks carry the in-between values
await run("add_paint_layer", { doc: d.id, name: "Painted" });
const p = ed.activeLayer();
p.px.drawInto(null, (x) => { x.fillStyle = "#c83214"; x.fillRect(10, 10, 60, 40); x.fillStyle = "#1464c8"; x.fillRect(40, 30, 50, 30); });
ed.markLayerChanged(p);
await run("select_rect", { doc: d.id, x: 20, y: 15, w: 30, h: 25 });
await run("select_feather", { doc: d.id, radius: 3 });
ed.maskFromSelection(p);
const k = document.createElement("canvas");
k.width = 30; k.height = 20;
const kg = k.getContext("2d");
kg.fillStyle = "#80ff40"; kg.fillRect(0, 0, 30, 20); kg.fillStyle = "#ffffff"; kg.fillRect(5, 5, 10, 5);
const q = ed.addLayer({ name: "Switched off", kind: "image", ref: null, px: ed.pixels.Layer.fromCanvas(k), x: 70, y: 45, w: 30, h: 20, dirty: true });
ed.activeLayerId = q.id;
await run("select_rect", { doc: d.id, x: 75, y: 50, w: 12, h: 8 });
ed.maskFromSelection(q);
ed.setMaskOff(q, true);
await run("select_none", { doc: d.id });
if (!p.maskPx || !q.maskPx || q.maskOff !== true || p.maskOff) throw new Error("the masks are not set up: " + ed.status);
const want = [p, q].map((l) => ({ name: l.name, x: l.x, y: l.y, w: l.w, h: l.h, bytes: bytesOf(l.px, l.px.width, l.px.height), mask: alphaOf(bytesOf(l.maskPx, l.maskPx.width, l.maskPx.height)), off: !!l.maskOff }));
// the test means something: painted pixels the mask hides, a feathered edge, a switched-off mask that hides something
const hidden = want[0].mask.filter((v, i) => v === 0 && want[0].bytes[i * 4 + 3] === 255).length;
const soft = want[0].mask.filter((v) => v > 0 && v < 255).length;
const hiddenOff = want[1].mask.filter((v) => v === 0).length;
if (!(hidden > 100 && soft > 20 && hiddenOff > 100)) throw new Error(`hidden painted pixels ${hidden}, soft mask values ${soft}, hidden by the switched-off mask ${hiddenOff}`);
window.__l.masks = { doc: d.id, want };
// both export paths; a spy tells which one wrote the file
const E = ed.constructor;
const exportPsd = async (path) => {
    let banded = null;
    const own = ed.exportLayeredBands;
    ed.exportLayeredBands = async function (...args) { const r = await own.apply(this, args); banded = !!r; return r; };
    try { await run("export", { doc: d.id, format: "psd", path }); } finally { delete ed.exportLayeredBands; }
    return banded;
};
const banded = await exportPsd(%(MASK_BANDS)s);
if (ed.tileMode && !banded) throw new Error("on tiles the PSD was not written by the band writer");
const wasBands = E.bands;
E.bands = false;
let bandedAfter;
try { bandedAfter = await exportPsd(%(MASK_CANVAS)s); } finally { if (wasBands === undefined) delete E.bands; else E.bands = wasBands; }
if (bandedAfter) throw new Error("with the bands switched off the band writer still ran");
// the worker's layers (export_layer with a mask bitmap) are the main thread's PsdWriter's, and the band writer's
const X = await import("./editor/inpaint_export.js");
const stack = ed.exportLayerStack("psd").layers;
if (stack.filter((L) => L.mask).length !== 2 || !stack.some((L) => L.mask && L.mask.disabled)) throw new Error("exportLayerStack does not hand over both masks");
const direct = new Uint8Array(await X.buildPsd({ width: ed.width, height: ed.height, layers: stack, composite: stack[0].canvas }).arrayBuffer());
const fileBytes = async (path) => new Uint8Array((await window.scumble.file.read(path)).data);
const section = (b) => b.subarray(34, 38 + new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(34));   // the layer and mask section
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const viaWorker = await fileBytes(%(MASK_CANVAS)s), viaBands = await fileBytes(%(MASK_BANDS)s);
if (!same(section(direct), section(viaWorker))) throw new Error("the worker's layers are not the ones PsdWriter writes on the main thread");
if (!same(section(viaBands), section(viaWorker))) throw new Error("the band writer's layers are not the canvas writer's");
// open both
const out = {};
for (const [label, path] of [["bands", %(MASK_BANDS)s], ["canvas", %(MASK_CANVAS)s]]) {
    const d2 = await run("new_document");
    window.__l.more.push(d2.id);
    await run("load_image", { doc: d2.id, path });
    const e2 = ednow(d2.id);
    if (far(bytesOf(e2.basePx, 120, 80), base) > 0) throw new Error(label + ": the base is not the Background's bytes");
    if (e2.layers.length !== 2) throw new Error(label + ": layers " + e2.layers.map((l) => l.name).join(", "));
    for (let i = 0; i < 2; i++) {
        const w = want[i], got = e2.layers[i];
        const box = [got.name, got.x, got.y, got.w, got.h].join(), wbox = [w.name, w.x, w.y, w.w, w.h].join();
        if (box !== wbox) throw new Error(`${label}: layer ${i} is ${box}, not ${wbox}`);
        const f = far(bytesOf(got.px, got.px.width, got.px.height), w.bytes);
        if (f > 0) throw new Error(`${label}: the pixels of ${got.name} are ${f} levels off (the mask baked in?)`);
        if (!got.maskPx) throw new Error(`${label}: ${got.name} came back without its mask`);
        if (got.maskPx.width !== got.px.width || got.maskPx.height !== got.px.height) throw new Error(`${label}: the mask of ${got.name} is ${got.maskPx.width} x ${got.maskPx.height}`);
        const mf = far(alphaOf(bytesOf(got.maskPx, got.maskPx.width, got.maskPx.height)), w.mask);
        if (mf > 0) throw new Error(`${label}: the mask of ${got.name} is ${mf} levels off`);
        if (!!got.maskOff !== w.off) throw new Error(`${label}: ${got.name} has maskOff ${got.maskOff}`);
    }
    if (!/2 layer masks kept as masks \\(1 switched off\\)/.test(e2.status)) throw new Error(label + ": status " + e2.status);
    out[label] = e2.status;
}
return { tiles: !!ed.tileMode, banded, hidden, soft, status: out.canvas };
"""),
    ("an_ora_bakes_the_enabled_mask_and_leaves_the_switched_off_one", """
// ORA has no layer masks: the editor bakes an enabled one into the pixels and leaves a switched-off one out
const { doc, want } = window.__l.masks;
await run("export", { doc, format: "ora", path: %(MASK_ORA)s });
const d = await run("new_document");
window.__l.more.push(d.id);
await run("load_image", { doc: d.id, path: %(MASK_ORA)s });
const ed = ednow(d.id);
const [op, oq] = ed.layers;
if (ed.layers.length !== 2 || op.maskPx || oq.maskPx) throw new Error("ORA: " + ed.layers.map((l) => l.name + (l.maskPx ? " (with a mask)" : "")).join(", "));
if (far(bytesOf(oq.px, oq.px.width, oq.px.height), want[1].bytes) > 0) throw new Error("ORA: the switched-off mask was applied");
const got = bytesOf(op.px, op.px.width, op.px.height), w = want[0];
let worst = 0, gone = 0;
for (let i = 0; i < w.mask.length; i++) {
    const a = Math.round(w.bytes[i * 4 + 3] * w.mask[i] / 255);
    worst = Math.max(worst, Math.abs(got[i * 4 + 3] - a));
    if (a === 255) for (let ch = 0; ch < 3; ch++) worst = Math.max(worst, Math.abs(got[i * 4 + ch] - w.bytes[i * 4 + ch]));
    if (w.mask[i] === 0 && w.bytes[i * 4 + 3] === 255) { if (got[i * 4 + 3] !== 0) throw new Error("ORA: a hidden pixel is still there"); gone++; }
}
if (worst > 2) throw new Error(`ORA: the enabled mask is not baked in (${worst} levels off)`);
return { worst, gone };
"""),
    ("a_psd_dropped_on_a_document_adds_its_layers", """
const ed = ednow(window.__l.src);
host.shell.activate(ed);
const n = ed.layers.length;
const r = await window.scumble.file.read(%(PSD)s);
// named .png, typed image/png: the first bytes decide
await ed.addImageLayers([new File([r.data], "not_really.png", { type: "image/png" })], "none", { place: "at", at: [5, 5] });
const added = ed.layers.slice(n);
const names = added.map((l) => l.name);
if (JSON.stringify(names) !== JSON.stringify(["Background", "Offset opaque", "Multiply half", "Hidden \\u00e4\\u00f6\\u00fc"])) throw new Error("added: " + names.join(", "));
if (added[1].x !== 12 || added[1].y !== 7) throw new Error("the layers are not where the file has them: " + added[1].x + "," + added[1].y);
if (ed.activeLayerId !== added[3].id) throw new Error("the top added layer is not active");
if (!/4 layers of not_really.png added/.test(ed.status)) throw new Error("status: " + ed.status);
if (ed.width !== 160) throw new Error("the drop changed the document");
return { added: names, status: ed.status };
"""),
    ("a_broken_file_says_why_and_keeps_the_tab", """
const ed = ednow(window.__l.psd);
const n = ed.layers.length;
let msg = "";
try { await run("load_image", { doc: window.__l.psd, path: %(BROKEN)s }); } catch (err) { msg = String(err.message || err); }
if (!/ends early/.test(msg)) throw new Error("a truncated PSD: " + (msg || "no error"));
if (ed.width !== 160 || ed.layers.length !== n) throw new Error("the failed open changed the tab");
return { message: msg };
"""),
    ("cleanup", """
for (const k of ["psd", "ora", "src"]) { try { if (window.__l && window.__l[k]) await run("close_document", { doc: window.__l[k] }); } catch (_) { /* gone */ } }
for (const id of (window.__l && window.__l.more) || []) { try { await run("close_document", { doc: id, force: true }); } catch (_) { /* gone */ } }
return true;
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


def node_step():
    r = subprocess.run(["node", os.path.join(ROOT, "tools", "layered_test.js")], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=120)
    tail = r.stdout.strip()   # stderr carries Node's note that it read the editor file as an ES module
    if r.returncode != 0 or not tail.endswith("PASS"):
        raise Exception("tools/layered_test.js: " + (tail + r.stderr)[-1500:])
    subprocess.run(["node", os.path.join(ROOT, "tools", "layered_test.js"), "--write-fixtures", TMP], cwd=ROOT, check=True, capture_output=True, timeout=60)
    return {"checks": tail.count("[ok]")}


async def run_all(c):
    ok = True
    try:
        print("[ok] node: %s" % json.dumps(node_step()))
    except Exception as err:  # noqa: BLE001
        print("[FAIL] node: %s" % err)
        print("FAIL")
        return False
    subs = {"PSD": J("roundtrip.psd"), "ORA": J("roundtrip.ora"), "LOOSE_PSD": J("loose.psd"), "LOOSE_ORA": J("loose.ora"), "BROKEN": J("broken.psd"),
            "MASK_BANDS": J("masks_bands.psd"), "MASK_CANVAS": J("masks_canvas.psd"), "MASK_ORA": J("masks.ora")}
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); window.__host = (await import('./editor/host.js')).host; await import('./shell.js'); return 1; })()")
    for name, body in STEPS:
        if name == "a_broken_file_says_why_and_keeps_the_tab":
            with open(os.path.join(TMP, "roundtrip.psd"), "rb") as f:
                data = f.read()
            with open(os.path.join(TMP, "broken.psd"), "wb") as f:
                f.write(data[: len(data) // 3])
        try:
            res = await c.eval(PRE % (HELP, body % subs), timeout=240)
            print("[ok] %s: %s" % (name, json.dumps(res, ensure_ascii=False)[:300]))
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] %s: %s" % (name, err))
            if name != "cleanup":
                try:
                    await c.eval(PRE % (HELP, STEPS[-1][1]), timeout=60)
                except Exception:  # noqa: BLE001
                    pass
            break
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:220])
    shutil.rmtree(TMP, ignore_errors=True)
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
