"""Editor behaviour that is easy to break again, against the running app (tools/cdp.py).

No ComfyUI needed. Checks the New dialog (two number boxes, the ratio tie, the focus that a
button click used to steal), that a click without a drag deselects with the marquee and the
lasso, that an outline in progress is drawn black under white so it stays visible on a white
image, copy and paste of a whole layer from one tab into another, and that an erase stroke
through one strip of a zoomed-out result layer leaves the rest of the layer on screen (the
cached display level used to be wiped outside the stroke's rectangle). The steps after the C1
review cover the undo history (order, the objects its steps hold, the budget, a load that takes
it along), the selection's bounds after a restore, the selection brush's display levels, a lost
undo step, and that closed tabs are freed. The close-out's steps: an undo refused while a stroke or
a drag is held, an undo that does not run over an edit made while it loads (a decode, a grow, a
canvas redo, an upload of extend / merge, flatten), text edit steps that give their blob URLs
back, and a restored selection that getValue saves even when it was read during the restore. After
it: the undo and redo of a mask brush stroke (c6bc6a6 loaded the step's mask flag as an image).

    python tools/editor_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

async def escape_closes_the_shell_dialogs(c):
    """Settings and Generate-new are native <dialog>s; the browser closes them on Escape unless a
    keydown listener calls preventDefault. The editor's window capture handler did exactly that for
    every Escape, so the dialogs could only be closed with the mouse. A synthetic keydown checks the
    listener (defaultPrevented), a real key through CDP checks the native close."""
    out = {}
    for name, opener in (("settings", "shell.openSettings()"), ("generate_new", "host.shell.openGenerateNew(ednow(window.__t))")):
        await c.eval(PRE % ("""
const shell = await import("./shell.js");
host.shell.activate(ednow(window.__t));
await %s;
await wait(200);
const dlg = document.querySelector("dialog[open]");
if (!dlg) throw new Error("the %s dialog did not open");
const el = dlg.contains(document.activeElement) ? document.activeElement : dlg;
const evt = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
el.dispatchEvent(evt);
window.__esc = { prevented: evt.defaultPrevented, focusInside: dlg.contains(document.activeElement), target: el.tagName };
return 1;
""" % (opener, name)), timeout=60)
        for kind in ("keyDown", "keyUp"):
            await c.call("Input.dispatchKeyEvent", type=kind, key="Escape", code="Escape", windowsVirtualKeyCode=27, nativeVirtualKeyCode=27)
        r = await c.eval("(async () => { await new Promise((r) => setTimeout(r, 200)); const d = document.querySelector('dialog[open]'); return { ...window.__esc, stillOpen: !!d }; })()")
        out[name] = r
        if r["prevented"]:
            raise Exception("%s: the editor's key handler still prevents Escape (%s)" % (name, json.dumps(r)))
        if r["stillOpen"]:
            raise Exception("%s: still open after a real Escape (%s)" % (name, json.dumps(r)))
    return out


SVG_SAMPLE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect width="400" height="200" fill="#fff"/><rect width="200" height="200" fill="#f00"/><circle cx="300" cy="100" r="60" fill="#00f"/></svg>'


async def svg_import_rasterises_on_the_way_in(c):
    """An SVG has no pixel size of its own. Loading one asks for the size (prefilled: 2048 on the
    long side when the file only has a viewBox), the mirror then holds a PNG; as a layer it is
    rasterised to fit the document without a dialog; the load_image command takes width / height
    and never asks; and the mirror serves an .svg with its own type (it used to be octet-stream,
    which an <img> refuses to render)."""
    path = os.path.join(os.environ.get("TEMP", os.getcwd()), "scumble_editor_test.svg")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(SVG_SAMPLE)
    await c.eval("window.__svgPath = %s; window.__svgText = %s; 1" % (json.dumps(path), json.dumps(SVG_SAMPLE)))
    return await c.eval(PRE % """
const { api } = await import("./editor/host.js");
const ed = ednow(window.__t);
host.shell.activate(ed);
const file = new File([window.__svgText], "shapes.svg", { type: "image/svg+xml" });
const out = {};
const p = ed.loadFile(file);                     // interactive: the size dialog
await wait(300);
const box = ed.root.querySelector(".ipc-askbox");
if (!box) throw new Error("no size dialog for the SVG (" + ed.status + ")");
const inputs = Array.from(box.querySelectorAll(".ipc-askfield input"));
out.prefill = [inputs[0].value, inputs[1].value];
inputs[0].value = "800"; inputs[0].dispatchEvent(new Event("input"));
Array.from(box.querySelectorAll("button")).find((b) => b.textContent === "Import").click();
await p;
if (out.prefill[0] !== "2048" || out.prefill[1] !== "1024") throw new Error("prefill " + out.prefill);
if (ed.width !== 800 || ed.height !== 400) throw new Error("size " + ed.width + "x" + ed.height + " (" + ed.status + ")");
const px = (x, y) => Array.from(ed.basePx.readRect(x, y, 1, 1).data);   // the base's pixels (C1: basePx)
out.red = px(100, 200); out.blue = px(600, 200); out.white = px(700, 30);
if (out.red[0] < 250 || out.red[1] > 5) throw new Error("red " + out.red);
if (out.blue[2] < 250 || out.blue[0] > 5) throw new Error("blue " + out.blue);
if (out.white[1] < 250) throw new Error("white " + out.white);
out.baseFile = ed.base.ref.filename;
if (!/\\.png$/i.test(out.baseFile)) throw new Error("the mirror holds " + out.baseFile);
// a layer: rasterised to fit the document, no dialog
await ed.addImageLayers([file], "none", { place: "fit" });
const layer = ed.layers[ed.layers.length - 1];
out.layer = [layer.px.width, layer.px.height, layer.w, layer.h, layer.name];
if (layer.px.width !== 800 || layer.px.height !== 400 || layer.w !== 800) throw new Error("layer " + out.layer);
// the command: a path and a width, the aspect kept, no dialog
const r = await run("load_image", { path: window.__svgPath, width: 600, doc: window.__t });
out.command = [r.width, r.height];
if (r.width !== 600 || r.height !== 300) throw new Error("command size " + out.command);
if (ed.root.querySelector(".ipc-askbox")) throw new Error("the command opened the size dialog");
// the mirror's content type for an .svg file
const fd = new FormData();
fd.append("image", new Blob([window.__svgText], { type: "image/svg+xml" }), "editor_test_mime.svg");
fd.append("overwrite", "true");
const up = await (await fetch(api.apiURL("/upload/image"), { method: "POST", body: fd })).json();
const view = await fetch(api.apiURL("/view?filename=" + encodeURIComponent(up.name) + "&type=input&subfolder=" + encodeURIComponent(up.subfolder || "")));
out.mime = view.headers.get("content-type");
if (out.mime !== "image/svg+xml") throw new Error("the mirror serves an .svg as " + out.mime);
return out;
""", timeout=120)


async def closed_tabs_are_collected(c):
    """A closed tab gives its memory back. The export row's listener on the host held the editor
    for good, so every document ever opened stayed in memory with its layers and undo steps. Four
    tabs are made, painted on, closed, and after a forced collection none of them may be alive."""
    r = await c.eval(PRE % """
window.__closedTabs = [];
for (let i = 0; i < 4; i++) {
    const doc = await run("new_document");
    const ed = ednow(doc.id);
    await run("new_canvas", { width: 1200, height: 800, doc: doc.id });
    await run("add_paint_layer", { doc: doc.id });
    await run("select_rect", { x: 10, y: 10, w: 300, h: 200, doc: doc.id });
    ed.fillSelection();
    await wait(200);
    window.__closedTabs.push(new WeakRef(ed));
    await run("close_document", { doc: doc.id, force: true });
}
host.shell.activate(ednow(window.__t));
return host.editors().length;
""", timeout=120)
    for _ in range(4):
        await c.call("HeapProfiler.collectGarbage")
        await asyncio.sleep(0.3)
    alive = await c.eval("(async () => { await new Promise((r) => setTimeout(r, 300)); const a = window.__closedTabs.map((w) => !!w.deref()); window.__closedTabs = null; return a; })()")
    if any(alive):
        raise Exception("closed tabs still alive after a collection: %s" % json.dumps(alive))
    return {"open": r, "alive": alive}


STEPS = [
    ("new_dialog_has_two_boxes", """
const doc = await run("new_document");
window.__t = doc.id;
const ed = ednow(window.__t);
host.shell.activate(ed);
const p = ed.newCanvas();                        // not awaited: the dialog is open now
await wait(150);
const box = ed.root.querySelector(".ipc-askbox");
const inputs = Array.from(box.querySelectorAll(".ipc-askfield input"));
const labels = Array.from(box.querySelectorAll(".ipc-askfield span")).map((s) => s.textContent);
const focusedFirst = document.activeElement === inputs[0];
const link = box.querySelector(".ipc-asklink input");
link.checked = true;                             // the ratio tie
inputs[0].value = "2048";
inputs[0].dispatchEvent(new Event("input"));
const tiedHeight = inputs[1].value;
link.checked = false;
inputs[0].value = "1440"; inputs[1].value = "900";
Array.from(box.querySelectorAll("button")).find((b) => b.textContent === "Create").click();
await p;
if (inputs.length !== 2) throw new Error("not two boxes");
if (ed.width !== 1440 || ed.height !== 900) throw new Error("size " + ed.width + "x" + ed.height);
return { labels, focusedFirst, tiedHeight, size: [ed.width, ed.height] };
"""),
    ("keyboard_focus_survives_the_button_click", """
const ed = ednow(window.__t);
const btn = Array.from(ed.root.querySelectorAll("button")).find((b) => (b.title || "").startsWith("New:"));
btn.click();                                     // the real button, so the root click handler runs too
await wait(180);
const inp = ed.root.querySelector(".ipc-askfield input");
const focused = document.activeElement === inp;
Array.from(ed.root.querySelectorAll(".ipc-askbox button")).find((b) => b.textContent === "Cancel").click();
await wait(80);
if (!focused) throw new Error("the focus left the size box: " + (document.activeElement && document.activeElement.className));
return { focusedAfterButtonClick: focused };
"""),
    ("click_deselects_marquee_and_lasso", """
const ed = ednow(window.__t);
const out = {};
await run("select_rect", { x: 100, y: 100, w: 300, h: 200, doc: window.__t });
out.before = !!ed.getBounds();
// a click inside an existing selection with the rectangle tool: selmove, released without moving
const orig = ed.sel.clone();   // the gesture keeps the outline as pixels (C1 step d)
ed.pointer = { kind: "selmove", start: [200, 150], orig, origBounds: ed.getBounds() };
ed.onPointerUp({ pointerId: 1 });
out.afterClickInside = !!ed.getBounds();
// the lasso, a click without a drag
await run("select_rect", { x: 100, y: 100, w: 300, h: 200, doc: window.__t });
ed.lassoPoints = [[50, 50]];
ed.pointer = { kind: "lasso", mode: "replace" };
ed.onPointerUp({ pointerId: 2 });
out.afterLassoClick = !!ed.getBounds();
// the rectangle tool *outside* the selection, a click whose hand wobbled by one screen
// pixel. Zoomed far out that pixel is many image pixels, and it used to leave a small
// selection right under the cursor instead of deselecting.
await run("select_rect", { x: 100, y: 100, w: 300, h: 200, doc: window.__t });
ed.view.scale = 0.087;   // a 15k image fitted into the window
ed.pointer = { kind: "rect", ellipse: false, start: [600, 500], cur: [611, 509], startPx: [400, 300], mode: "replace" };
ed.onPointerUp({ pointerId: 3, pointerType: "mouse" });
out.afterWobbleClick = !!ed.getBounds();
// a real drag still selects
await run("select_none", { doc: window.__t });
ed.pointer = { kind: "rect", ellipse: false, start: [100, 100], cur: [400, 300], startPx: [400, 300], moved: true, mode: "replace" };
ed.onPointerUp({ pointerId: 4, pointerType: "mouse" });
const b = ed.getBounds();
out.afterRealDrag = b ? [b[0], b[1], b[2] - b[0], b[3] - b[1]] : null;
ed.view.scale = 1;
if (!out.before || out.afterClickInside || out.afterLassoClick || out.afterWobbleClick) throw new Error(JSON.stringify(out));
if (!out.afterRealDrag || out.afterRealDrag[2] < 290) throw new Error("a real drag must still select: " + JSON.stringify(out));
return out;
"""),
    ("brush_ring_visible_over_its_own_colour", """
const ed = ednow(window.__t);
// the ring used to be a one pixel line in the paint colour, so it vanished over its own
// paint and a brush wider than the layer looked like a tool that fills rectangles
ed.setTool("paint");
ed.color = "#ff0000";
ed.brushSize = 120;
ed.hardness = 1;
ed.hover = [50, 50];
const c = document.createElement("canvas"); c.width = 100; c.height = 100;
const x = c.getContext("2d");
x.fillStyle = ed.color; x.fillRect(0, 0, 100, 100);
ed.drawBrushRing(x, 1);
const d = x.getImageData(0, 0, 100, 100).data;
let dark = 0;
for (let i = 0; i < d.length; i += 4) if (d[i] < 128 && d[i + 1] < 128) dark++;
ed.hover = null;
if (!dark) throw new Error("the brush ring is invisible over its own paint colour");
return { darkPixels: dark };
"""),
    ("outline_visible_on_white", """
const ed = ednow(window.__t);
const c = document.createElement("canvas"); c.width = 100; c.height = 100;
const x = c.getContext("2d");
x.fillStyle = "#fff"; x.fillRect(0, 0, 100, 100);
ed.antsStroke(x, () => x.strokeRect(20.5, 20.5, 60, 60), 1);
const d = x.getImageData(0, 0, 100, 100).data;
let dark = 0;
for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
if (!dark) throw new Error("nothing dark was drawn: the outline stays invisible on white");
return { darkPixels: dark };
"""),
    ("copy_paste_a_layer_into_another_tab", """
const a = ednow(window.__t);
host.shell.activate(a);
await run("add_paint_layer", { name: "Source layer", doc: window.__t });
const l = a.activeLayer();
l.px.drawInto(null, (lc) => { lc.fillStyle = "#ff3300"; lc.fillRect(10, 10, 120, 60); });   // writes go through the layer's pixels
a.markLayerChanged(l);
a.clearSelection();
const copied = a.copySelection({});               // nothing selected: the whole layer
if (!copied) throw new Error("nothing copied: " + a.status);
const d2 = await run("new_document");
window.__t2 = d2.id;
const b = ednow(d2.id);
host.shell.activate(b);
await run("new_canvas", { width: 512, height: 384, doc: d2.id });
const pasted = b.pasteClipboard();
if (!pasted) throw new Error("nothing pasted: " + b.status);
return { copiedFrom: copied.source, size: [copied.canvas.width, copied.canvas.height], layerName: pasted.name, layersInTab2: b.layers.length };
"""),
    ("duplicate_button_in_the_layer_row", """
const b = ednow(window.__t2);
host.shell.activate(b);
b.renderLayers();
const btn = Array.from(b.root.querySelectorAll("button")).find((x) => (x.title || "").startsWith("Duplicate layer"));
if (!btn) throw new Error("no duplicate button in the layer row");
const before = b.layers.length;
btn.click();
await wait(80);
if (b.layers.length !== before + 1) throw new Error("the button did not duplicate: " + b.status);
return { before, after: b.layers.length };
"""),
    ("erase_stroke_keeps_the_rest_of_the_layer_on_screen", """
// A result layer on a large document, viewed zoomed out, so the screen is drawn from the
// layer's cached display level. One erase stroke through a strip of it used to wipe the
// level everywhere except the strip: the pixels survived, the picture lost the whole
// layer. The real pointer handlers are driven, because the gesture builds the stroke
// buffer and the clip from the selection, and the report had a selection.
const d3 = await run("new_document");
window.__t3 = d3.id;
const ed = ednow(d3.id);
host.shell.activate(ed);
await run("new_canvas", { width: 4000, height: 3000, doc: d3.id });
const LX = 1000, LY = 700, LW = 2236, LH = 1853;   // over 1 MP, so the layer gets display levels
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const lc = mk(LW, LH);
const g = lc.getContext("2d");
g.fillStyle = "#20c040";
g.fillRect(730, 100, 800, 200);   // the strip the stroke runs through
g.fillRect(930, 780, 370, 300);   // the block 580 px below it, which has to stay
const { LayerPixels } = await import("./editor/inpaint_pixels.js");
const layer = ed.addLayer({ name: "Result", kind: "result", ref: null, px: LayerPixels.fromCanvas(lc), x: LX, y: LY, w: LW, h: LH, dirty: true });
ed.markLayerChanged(layer);
await run("select_rect", { x: LX, y: LY, w: LW, h: LH, doc: d3.id });   // the eraser is clipped to it
ed._fitted = false;
ed.view.scale = 0.2;
ed.view.x = ed.canvas.width / 2 - (LX + LW / 2) * 0.2;
ed.view.y = ed.canvas.height / 2 - (LY + LH / 2) * 0.2;
ed.setTool("erase");
ed.brushSize = 400; ed.eraseHardness = 0.43; ed.brushOpacity = 1;
ed.draw(); await wait(200); ed.draw(); await wait(200);   // the level chain is built one level per frame
const screenAt = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); return Array.from(ed.canvas.getContext("2d").getImageData(Math.round(sx), Math.round(sy), 1, 1).data); };
// the strip is sampled 100 px into the stroke, clear of the brush ring drawn at its end
const block = [LX + 930 + 185, LY + 780 + 150], strip = [LX + 1030, LY + 200];
const green = (p) => p[0] < 100 && p[1] > 150, white = (p) => p[0] > 200 && p[1] > 200 && p[2] > 200;
const before = { block: screenAt(...block), strip: screenAt(...strip) };
if (!green(before.block) || !green(before.strip)) throw new Error("the green is not on screen before the stroke: " + JSON.stringify(before));
const rect = ed.canvas.getBoundingClientRect();
const client = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
const ev = (type, ix, iy) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 9, pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy)));
const y = LY + 200, x0 = LX + 930, x1 = LX + 1330;
ed.canvas.dispatchEvent(ev("pointerdown", x0, y));
const kind = ed.pointer && ed.pointer.kind, clipped = !!(ed.pointer && ed.pointer.clip);
for (let i = 1; i <= 10; i++) { ed.canvas.dispatchEvent(ev("pointermove", x0 + (x1 - x0) * i / 10, y)); await wait(16); }
ed.canvas.dispatchEvent(ev("pointerup", x1, y));
ed.hover = null;
await wait(100); ed.draw(); await wait(100);
const d = layer.px.readRect(0, 0, LW, LH).data;
let alpha = 0;
for (let i = 3; i < d.length; i += 4) if (d[i] > 0) alpha++;
const after = { block: screenAt(...block), strip: screenAt(...strip), alpha, kind, clipped };
if (kind !== "layerpaint" || !clipped) throw new Error("the gesture did not become a clipped erase stroke: " + JSON.stringify(after));
if (alpha < 111000 || alpha >= 271000) throw new Error("the layer's own pixels are wrong: " + JSON.stringify(after));
if (!white(after.strip)) throw new Error("the erase did not reach the screen: " + JSON.stringify(after));
if (!green(after.block)) throw new Error("the block 580 px from the stroke vanished from the screen: " + JSON.stringify(after));
return { before, after };
"""),
    ("normalise_filter_moves_colours_to_the_mean_on_both_paths", """
const F = await import("./editor/inpaint_filters.js");
const GL = await import("./editor/inpaint_filters_gl.js");
const ed = ednow(window.__t);
host.shell.activate(ed);
await run("new_canvas", { width: 640, height: 400, doc: window.__t });   // the halves must cover the whole picture
// a two-colour picture: a warm left half, a cold right half
const L = await run("add_paint_layer", { doc: window.__t });
const lay = ed.layers.find((l) => l.id === L.id);
lay.px.drawInto(null, (g) => {
    g.fillStyle = "#c86432"; g.fillRect(0, 0, 320, 400);
    g.fillStyle = "#3264c8"; g.fillRect(320, 0, 320, 400);
});
lay.dirty = true; ed.touchSource(lay.px); ed.draw();
const src = ed.flattenToCanvas({ forRun: true });
const out = {};
for (const mode of ["colour", "all", "levels"]) {
    const r = GL.compareFilterPaths((s, p, i) => F.FILTERS.normalize.apply(s, p, i), "normalize", src, { mode, amount: 100 }, {});
    out[mode] = { gl: r.gl, max: r.max, mean: r.mean };
    if (!r.gl) throw new Error("no GPU path for normalize (" + mode + ")");
    if (r.max > 2) throw new Error(mode + ": GPU and CPU differ by " + r.max + " levels");
}
// "all" at 100 %: everything becomes the mean of the two halves
const all = F.FILTERS.normalize.apply(src, { mode: "all", amount: 100 }, {});
const px = (cv, x, y) => Array.from(cv.getContext("2d").getImageData(x, y, 1, 1).data);
const left = px(all, 100, 200), right = px(all, 540, 200);
if (Math.abs(left[0] - right[0]) > 2 || Math.abs(left[2] - right[2]) > 2) throw new Error("not the same after 'all': " + left + " / " + right);
if (Math.abs(left[0] - 125) > 3 || Math.abs(left[2] - 125) > 3) throw new Error("the mean is off: " + left);
// "colour": the tint evens out, the luma of each half stays
const col = F.FILTERS.normalize.apply(src, { mode: "colour", amount: 100 }, {});
const luma = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const cl = px(col, 100, 200), cr = px(col, 540, 200), sl = px(src, 100, 200), sr = px(src, 540, 200);
if (Math.abs(luma(cl) - luma(sl)) > 3 || Math.abs(luma(cr) - luma(sr)) > 3) throw new Error("colour mode changed the luma: " + cl + " vs " + sl);
if (Math.abs((cl[0] - cl[2]) - (cr[0] - cr[2])) > 4) throw new Error("colour mode left different tints: " + cl + " / " + cr);
// as a filter layer through the command core
const fl = await run("add_filter", { type: "normalize", params: { mode: "all", amount: 50 }, doc: window.__t });
const flat = ed.flattenToCanvas({ forRun: true });
const hl = px(flat, 100, 200);
if (Math.abs(hl[0] - (200 + 125) / 2) > 4) throw new Error("the filter layer at 50 % is off: " + hl);
await run("remove_layer", { layer: fl.id, doc: window.__t });
await run("remove_layer", { layer: L.id, doc: window.__t });
return { ...out, all: left, colour: [cl, cr], half: hl };
"""),
    ("export_canvas_frames_the_picture", """
const ed = ednow(window.__t);
host.shell.activate(ed);
const L = await run("add_paint_layer", { doc: window.__t });
const lay = ed.layers.find((l) => l.id === L.id);
lay.px.drawInto(null, (g) => { g.fillStyle = "#ff0000"; g.fillRect(0, 0, ed.width, ed.height); });
lay.dirty = true; ed.touchSource(lay.px); ed.draw();
const path = window.__exportPath;
const r = await run("export", { format: "png", path, width: 320, canvas_width: 400, canvas_height: 300, anchor: "br", fill: "white", doc: window.__t });
const f = await window.scumble.file.read(path);
const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(new Blob([f.data], { type: "image/png" })); });
if (img.naturalWidth !== 400 || img.naturalHeight !== 300) throw new Error("frame " + img.naturalWidth + "x" + img.naturalHeight);
const c = document.createElement("canvas"); c.width = 400; c.height = 300;
const x = c.getContext("2d"); x.drawImage(img, 0, 0);
const px = (a, b) => Array.from(x.getImageData(a, b, 1, 1).data);
const tl = px(2, 2), br = px(397, 297);
// 320 wide at the picture's aspect: the red picture sits bottom right, the white fill top left
if (br[0] < 250 || br[1] > 5) throw new Error("bottom right is not the picture: " + br);
if (tl[0] < 250 || tl[1] < 250) throw new Error("top left is not the white fill: " + tl);
// the row's state was restored after the command
const e = host.exportState(ed);
if (e.canvasW || e.canvasH) throw new Error("the export command left the frame set: " + JSON.stringify(e));
// the row itself: type a frame, the state follows, layered formats disable it
const row = ed._exportRow;
row.cw.value = "800"; row.cw.dispatchEvent(new Event("change"));
const after = host.exportState(ed);
if (after.canvasW !== 800 || !(after.canvasH > 0)) throw new Error("the row did not set the frame: " + JSON.stringify(after));
host.setExportSize(ed, { canvasWidth: 0, canvasHeight: 0 });
await run("remove_layer", { layer: L.id, doc: window.__t });
return { frame: [img.naturalWidth, img.naturalHeight], tl, br, rowFrame: [after.canvasW, after.canvasH] };
"""),
    ("scale_snaps_to_the_canvas_edges", """
const ed = ednow(window.__t);
host.shell.activate(ed);
await run("new_canvas", { width: 1000, height: 800, doc: window.__t });
const L = await run("add_paint_layer", { doc: window.__t });
const l = ed.layers.find((x) => x.id === L.id);
l.x = 100; l.y = 100; l.w = 400; l.h = 300;
ed.view.scale = 1;
const gesture = (handle, keepAspect) => ({ kind: "scale", layer: l, handle, start: [0, 0], orig: { x: 100, y: 100, w: 400, h: 300 }, keepAspect });
const out = {};
// the bottom-right corner dragged to 6 px short of the right edge and 5 px past the bottom: both snap
let p = gesture("se", false);
ed.applyScale(p, 994, 805); ed.snapGuides = null; ed.snapScale(p, 994, 805);
out.corner = [l.x + l.w, l.y + l.h, ed.snapGuides];
if (l.x + l.w !== 1000 || l.y + l.h !== 800) throw new Error("the corner did not snap: " + JSON.stringify(out.corner));
// too far away: no snap
l.x = 100; l.y = 100; l.w = 400; l.h = 300;
ed.applyScale(p, 970, 760); ed.snapGuides = null; ed.snapScale(p, 970, 760);
out.far = [l.x + l.w, l.y + l.h];
if (l.x + l.w !== 970 || l.y + l.h !== 760) throw new Error("snapped from too far: " + out.far);
// the left edge to the canvas centre (500) with the west handle; the anchor is the right edge at 900
l.x = 600; l.y = 100; l.w = 300; l.h = 300;
p = gesture("w", false); p.orig = { x: 600, y: 100, w: 300, h: 300 };
ed.applyScale(p, 504, 200); ed.snapGuides = null; ed.snapScale(p, 504, 200);
out.centre = [l.x, l.w, ed.snapGuides && ed.snapGuides.x];
if (l.x !== 500 || l.w !== 400) throw new Error("the west edge did not snap to the centre: " + l.x + " w " + l.w);
// a kept aspect: the dragged right edge snaps to the canvas edge, the height follows the ratio
l.x = 0; l.y = 0; l.w = 400; l.h = 300;
p = gesture("se", true); p.orig = { x: 0, y: 0, w: 400, h: 300 };
ed.applyScale(p, 994, 600); ed.snapGuides = null; ed.snapScale(p, 994, 600);
out.aspect = [l.w, l.h, ed.snapGuides];
if (l.x + l.w !== 1000 || Math.abs(l.h - 750) > 1) throw new Error("kept aspect: " + out.aspect);
if (!ed.snapGuides || !ed.snapGuides.x.includes(1000) || ed.snapGuides.y.length) throw new Error("guide lines: " + JSON.stringify(ed.snapGuides));
ed.snapGuides = null;
await run("remove_layer", { layer: L.id, doc: window.__t });
return out;
"""),
    ("escape_closes_the_shell_dialogs", lambda c: escape_closes_the_shell_dialogs(c)),
    ("svg_import_rasterises_on_the_way_in", lambda c: svg_import_rasterises_on_the_way_in(c)),
    ("selection_undo_copies_its_extent_and_bounds_come_by_strips", """
// Phase A item 1 (docs/PLAN_TILES.md): a selection undo step is a copy of the selection's extent
// (a feathered tail included), not a PNG of the whole canvas; the bounding box is scanned for in
// strips from the edges of a known superset, and a subtract keeps the old box as that superset.
await run("new_canvas", { width: 1440, height: 900, doc: window.__t });   // an earlier step left the tab at 600 x 300
const ed = ednow(window.__t);
host.shell.activate(ed);
const W = ed.width, H = ed.height;
const out = { size: [W, H] };
const pixels = () => ed.sel.readRect(0, 0, W, H).data;
const same = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
ed.sel.clear();
ed.markSelectionChanged(null);
// an ellipse drawn straight into the selection's pixels: nothing is known about its box
ed.sel.drawInto(null, (s) => { s.fillStyle = "#ff0000"; s.beginPath(); s.ellipse(700, 450, 300, 200, 0, 0, Math.PI * 2); s.fill(); });
ed.markSelectionChanged();
out.ellipse = ed.getBounds();
const full = ed.scanBounds(0, 0, W, H);
if (!eq(out.ellipse, full)) throw new Error("strip scan " + JSON.stringify(out.ellipse) + " differs from the full scan " + JSON.stringify(full));
// feather: the extent reaches past the bounds, the bounds stay the alpha >= 128 box
await ed.featherSelection(20);
out.feathered = ed.getBounds();
out.extent = ed.selectionExtent();
if (!eq(out.feathered, ed.scanBounds(0, 0, W, H))) throw new Error("bounds after feather: " + JSON.stringify(out.feathered));
if (!(out.extent[0] < out.feathered[0] - 8 && out.extent[2] > out.feathered[2] + 8)) throw new Error("the extent does not cover the feathered tail: " + JSON.stringify([out.extent, out.feathered]));
const before = pixels();
// a subtract from the middle: the old box is kept as a superset and made exact by strips
ed.pushUndo({ kind: "selection" });
const snap = ed.undo[ed.undo.length - 1];
out.snap = { kind: snap.kind, px: !!snap.px, pw: snap.px && snap.px.width, ph: snap.px && snap.px.height, w: snap.w, h: snap.h, bytes: snap.bytes };
if (snap.kind !== "selection" || !snap.px || snap.px.width !== snap.w || snap.px.height !== snap.h || snap.w >= W || snap.bytes !== snap.w * snap.h * 4) throw new Error("the undo step is not a copy of the extent: " + JSON.stringify(out.snap));
ed.sel.drawInto(null, (s) => { s.globalCompositeOperation = "destination-out"; s.fillRect(400, 250, 300, 400); });   // the left half of the ellipse
// the info rows ask for the bounds at once, so the superset is resolved inside the mark: watch
// that it is the old box that is scanned by strips, and that the extent is never scanned for
const calls = [];
const oStrips = ed.scanBoundsIn.bind(ed), oExtent = ed.selectionExtent.bind(ed);
ed.scanBoundsIn = (box) => { calls.push(["strips", box]); return oStrips(box); };
ed.selectionExtent = () => { calls.push(["extent"]); return oExtent(); };
ed.markSelectionChanged(ed.boundsAfter("subtract", [400, 250, 700, 650]), [400, 250, 700, 650]);
out.afterSubtract = ed.getBounds();
ed.scanBoundsIn = oStrips; ed.selectionExtent = oExtent;
out.calls = calls;
if (!calls.some((c) => c[0] === "strips" && eq(c[1], out.feathered)) || calls.some((c) => c[0] === "extent")) throw new Error("a subtract should be scanned inside the old box: " + JSON.stringify(calls));
if (ed.selectionLoose || !eq(out.afterSubtract, ed.scanBounds(0, 0, W, H))) throw new Error("bounds after subtract: " + JSON.stringify(out.afterSubtract));
await ed.undoStep();
const restored = pixels();
out.restoredExact = same(before, restored);
if (!out.restoredExact) throw new Error("the undo did not restore the selection's pixels exactly");
if (!eq(ed.getBounds(), out.feathered)) throw new Error("bounds after undo: " + JSON.stringify(ed.getBounds()));
// an empty selection is a step without pixels, and undoing back to it leaves nothing selected
ed.clearSelection();
await ed.undoStep();
if (!eq(ed.getBounds(), out.feathered)) throw new Error("clear + undo: " + JSON.stringify(ed.getBounds()));
ed.clearSelection();
ed.pushUndo({ kind: "selection" });
out.emptySnap = ed.undo[ed.undo.length - 1].empty === true;
ed.sel.drawInto(null, (s) => { s.fillStyle = "#ff0000"; s.fillRect(10, 10, 50, 50); });
ed.markSelectionChanged([10, 10, 60, 60], [10, 10, 60, 60]);
await ed.undoStep();
out.emptyAgain = ed.getBounds() === null;
if (!out.emptySnap || !out.emptyAgain) throw new Error("empty step: " + JSON.stringify(out));
return out;
"""),
    ("wand_and_bucket_flood_a_region_not_the_image", """
// Phase A item 3 (docs/PLAN_TILES.md): on an image over 2048 px the wand floods a coarse composite
// first, then only the region's box at full resolution, and widens the box where the region reaches
// its edge. The result has to be the pixel-exact region a flood over the whole image gives, also
// across a one pixel bridge the coarse pass cannot see; the bucket fills the same region with a
// rect undo step; the eyedropper composites one pixel.
await run("new_canvas", { width: 5000, height: 3000, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
const W = ed.width, H = ed.height;
const { floodMask } = await import("./editor/inpaint_raster.js");
const out = {};
// the base: white, a blue blob left, a blue blob right, joined by a one pixel blue line
const base = document.createElement("canvas"); base.width = W; base.height = H;
const bx = base.getContext("2d");
bx.fillStyle = "#ffffff"; bx.fillRect(0, 0, W, H);
bx.fillStyle = "#2040c0";
bx.beginPath(); bx.arc(1000, 1500, 400, 0, Math.PI * 2); bx.fill();
bx.beginPath(); bx.arc(4000, 1500, 400, 0, Math.PI * 2); bx.fill();
bx.fillRect(1000, 1500, 3000, 1);   // the bridge: 1 px high, invisible at the coarse scale
bx.fillStyle = "#c02020"; bx.fillRect(2200, 400, 600, 300);   // a red block the region must not include
Object.defineProperty(base, "naturalWidth", { value: W });
Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "flood.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
ed.fillOpts = { tolerance: 32, contiguous: true, sample: "image" };
// the reference: a flood over the whole composite on the main thread
const flat = ed.flattenToCanvas({ forRun: true });
const ref = floodMask(flat.getContext("2d").getImageData(0, 0, W, H).data, W, H, 1000, 1400, 32, true);
let refCount = 0; for (let i = 0; i < ref.length; i++) refCount += ref[i];
out.refCount = refCount;
if (refCount < 2 * Math.PI * 400 * 400 * 0.95) throw new Error("the reference region is not both blobs: " + refCount);
// the wand, clicked in the left blob: both blobs and the bridge, nothing else
const spy = { rounds: null };
const oFlood = ed.floodRegion.bind(ed);
ed.floodRegion = async (x, y, o) => { const r = await oFlood(x, y, o); spy.rounds = r.rounds; spy.box = [r.x, r.y, r.w, r.h]; return r; };
await ed.wandSelect(1000, 1400, "replace");
ed.floodRegion = oFlood;
out.rounds = spy.rounds; out.box = spy.box;
if (!(spy.rounds >= 2)) throw new Error("the box should have been widened across the bridge, rounds " + spy.rounds);
const sel = ed.sel.readRect(0, 0, W, H).data;
let wrong = 0, selCount = 0;
for (let p = 0, i = 3; p < ref.length; p++, i += 4) { const on = sel[i] > 127 ? 1 : 0; selCount += on; if (on !== ref[p]) wrong++; }
out.selCount = selCount; out.wrong = wrong;
if (wrong) throw new Error(wrong + " pixels differ from the whole-image flood");
out.bounds = ed.getBounds();
if (JSON.stringify(out.bounds) !== JSON.stringify([600, 1100, 4400, 1900])) throw new Error("bounds " + JSON.stringify(out.bounds));
// the bucket on a new layer, clipped to nothing (no selection), with a rect undo step
ed.clearSelection();
const layer = ed.addPaintLayer();
ed.activeLayerId = layer.id;
ed.color = "#00ff00"; ed.brushOpacity = 1;
const undoBefore = ed.undo.length;
await ed.bucketFill(4000, 1600);
const step = ed.undo[ed.undo.length - 1];
out.bucketUndo = { kind: step.kind, w: step.w, h: step.h, px: !!step.px };
if (ed.undo.length !== undoBefore + 1 || step.kind !== "layerrect" || !step.px || step.w >= W) throw new Error("the bucket's undo step is not a rect copy: " + JSON.stringify(out.bucketUndo));
const at = (x, y) => Array.from(layer.px.readRect(x, y, 1, 1).data);
out.filled = { left: at(1000, 1400), right: at(4000, 1600), red: at(2500, 500), white: at(100, 100) };
if (out.filled.left[1] !== 255 || out.filled.right[1] !== 255 || out.filled.red[3] !== 0 || out.filled.white[3] !== 0) throw new Error("bucket pixels: " + JSON.stringify(out.filled));
await ed.undoStep();
if (at(4000, 1600)[3] !== 0) throw new Error("the bucket's undo did not clear the fill");
// the eyedropper composites one pixel: the red block through the (empty) layer
ed.pickColor(2500, 500);
out.picked = ed.color;
if (ed.color !== "#c02020") throw new Error("eyedropper picked " + ed.color);
// the active layer alone as the sample source: the layer is empty, so the region is everything transparent
ed.fillOpts = { tolerance: 32, contiguous: true, sample: "layer" };
await ed.wandSelect(100, 100, "replace");
out.layerSample = ed.getBounds();
if (JSON.stringify(out.layerSample) !== JSON.stringify([0, 0, W, H])) throw new Error("layer sample: " + JSON.stringify(out.layerSample));
ed.clearSelection();
await run("remove_layer", { layer: layer.id, doc: window.__t });
return out;
"""),
    ("stroke_buffers_cover_the_gesture_not_the_layer", """
// Phase A item 2 (docs/PLAN_TILES.md): a stroke's buffer and its selection clip cover what the
// gesture touched, not the layer; the live preview is refreshed inside the dab's rectangle; the
// committed pixels and the preview are the same as with a buffer the size of the layer, with a
// soft brush at an opacity and clipped to a selection, painting and erasing; and the preview
// canvases of a large layer are given back after the gesture.
await run("new_canvas", { width: 5000, height: 4000, doc: window.__t });   // 20 MP: above the keep limit
const ed = ednow(window.__t);
host.shell.activate(ed);
const W = ed.width, H = ed.height;
const out = {};
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const layer = ed.addPaintLayer();
layer.px.drawInto(null, (x) => { x.fillStyle = "#3060c0"; x.fillRect(200, 200, 2000, 1500); x.fillStyle = "#c06030"; x.fillRect(1500, 1000, 2000, 1500); });
ed.activeLayerId = layer.id;
ed.sel.drawInto(null, (s) => { s.clearRect(0, 0, W, H); s.fillStyle = "#ff0000"; s.fillRect(600, 500, 2200, 1600); });
ed.markSelectionChanged([600, 500, 2800, 2100]);
ed.brushSize = 90; ed.hardness = 0.4; ed.eraseHardness = 0.4; ed.brushOpacity = 0.6; ed.color = "#20c040";
const path = []; for (let i = 0; i <= 24; i++) path.push([500 + i * 90, 700 + Math.round(Math.sin(i / 3) * 300)]);
// premultiplied, like the compositor gate: at alpha 1 or 2 the stored colour is noise, and a
// canvas copy (the buffer growing) may change it without changing what is drawn
const same = (a, b, tol) => { let max = 0; for (let i = 0; i < a.length; i += 4) { const aa = a[i + 3], ba = b[i + 3]; let d = Math.abs(aa - ba); for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i + k] * aa / 255 - b[i + k] * ba / 255)); if (d > max) max = d; } return max <= tol ? null : +max.toFixed(1); };
// a full-size buffer that answers the same interface: the reference is the old way, a canvas the size of the layer
const fullBuffer = (target) => { const c = mk(target.width, target.height); return { tw: target.width, th: target.height, canvas: c, x: 0, y: 0, w: target.width, h: target.height, ensure() { const ctx = c.getContext("2d"); ctx.setTransform(1, 0, 0, 1, 0, 0); return ctx; }, all() { return this.ensure(); } }; };
const paintRef = (erase) => {
    const ref = mk(W, H); layer.px.drawTo(ref.getContext("2d"), 0, 0);
    const q = { kind: "layerpaint", layer, stroke: fullBuffer(layer.px), clip: true, erase, last: path[0], pressure: 1 };
    ed.layerDab(q, path[0][0], path[0][1], path[0][0], path[0][1]);   // the pointer-down dab
    for (let i = 1; i < path.length; i++) ed.layerDab(q, path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    const clip = mk(W, H); { const c = clip.getContext("2d"); c.setTransform(layer.px.width / layer.w, 0, 0, layer.px.height / layer.h, 0, 0); ed.sel.drawTo(c, -layer.x, -layer.y); }
    const st = mk(W, H); { const c = st.getContext("2d"); c.drawImage(q.stroke.canvas, 0, 0); c.globalCompositeOperation = "destination-in"; c.drawImage(clip, 0, 0); }
    const r = ref.getContext("2d"); r.globalAlpha = ed.brushOpacity; r.globalCompositeOperation = erase ? "destination-out" : "source-over"; r.drawImage(st, 0, 0);
    return ref;
};
for (const erase of [false, true]) {
    const before = mk(W, H); layer.px.drawTo(before.getContext("2d"), 0, 0);
    const ref = paintRef(erase);
    // the real gesture: the buffer grows with the dabs, the preview follows inside the dab's box
    const p = { kind: "layerpaint", layer, stroke: ed.newStrokeBuffer(layer.px), clip: ed.strokeClip(layer, layer.px), erase, last: path[0], pressure: 1 };
    ed.pointer = p;
    ed.layerDab(p, path[0][0], path[0][1], path[0][0], path[0][1]);
    let previewChecked = 0;
    for (let i = 1; i < path.length; i++) {
        ed.layerDab(p, path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
        if (i % 6 === 0) {
            // the incremental preview against a preview built whole from the same buffer
            const live = ed.layerPixels(layer);
            const whole = mk(W, H); { const c = whole.getContext("2d"); layer.px.drawTo(c, 0, 0); const cs = ed.clippedStroke(p); c.globalAlpha = ed.brushOpacity; c.globalCompositeOperation = erase ? "destination-out" : "source-over"; c.drawImage(cs, p.stroke.x, p.stroke.y); }
            const box = [Math.max(0, p.stroke.x - 4), Math.max(0, p.stroke.y - 4), Math.min(W, p.stroke.x + p.stroke.w + 4), Math.min(H, p.stroke.y + p.stroke.h + 4)];
            const a = live.getContext("2d").getImageData(box[0], box[1], box[2] - box[0], box[3] - box[1]).data;
            const b = whole.getContext("2d").getImageData(box[0], box[1], box[2] - box[0], box[3] - box[1]).data;
            const d = same(a, b, 1);
            if (d) throw new Error((erase ? "erase" : "paint") + ": the live preview differs from a whole one by " + d + " levels after dab " + i);
            previewChecked++;
        }
    }
    out[(erase ? "erase" : "paint") + "Buffer"] = { w: p.stroke.w, h: p.stroke.h, share: +((p.stroke.w * p.stroke.h) / (W * H)).toFixed(3), clip: p.clipCanvas ? [p.clipCanvas.width, p.clipCanvas.height] : null, previewChecked };
    if (p.stroke.w * p.stroke.h > 0.25 * W * H) throw new Error("the stroke buffer is not much smaller than the layer: " + JSON.stringify(out));
    if (!p.clipCanvas || p.clipCanvas.width !== p.stroke.w || p.clipCanvas.height !== p.stroke.h) throw new Error("the clip is not the buffer's size");
    ed.onPointerUp({ pointerId: 1 });
    // the 20 MP preview is given back; the clip scratch is the buffer's size and may stay
    if (ed.strokePreview) throw new Error("the preview canvas of a 20 MP layer was kept after the gesture");
    if (ed.clipScratch && ed.clipScratch.width * ed.clipScratch.height > 0.25 * W * H) throw new Error("the clip scratch is not the buffer's size: " + ed.clipScratch.width + "x" + ed.clipScratch.height);
    // the committed pixels against the reference, inside the selection and outside it
    const got = layer.px.readRect(0, 0, W, H).data;
    const want = ref.getContext("2d").getImageData(0, 0, W, H).data;
    // a small buffer starts as a software canvas and grows onto the GPU; Skia's CPU and GPU
    // blending of twenty overlapping soft dabs round differently by a few levels (measured 4
    // premultiplied at most), which no eye sees and which the old 600 MB buffer did not get
    // to show because it was on the GPU from the first dab
    const d = same(got, want, 8);
    if (d) throw new Error((erase ? "erase" : "paint") + ": the committed stroke differs from the reference by " + d + " levels");
    const step = ed.undo[ed.undo.length - 1];
    out[(erase ? "erase" : "paint") + "Undo"] = { kind: step.kind, w: step.w, h: step.h, px: !!step.px };
    if (step.kind !== "layerrect" || !step.px || step.px.width !== step.w || step.w >= W) throw new Error("the undo step is not a rect copy: " + JSON.stringify(out[(erase ? "erase" : "paint") + "Undo"]));
    await ed.undoStep();
    const back = layer.px.readRect(0, 0, W, H).data;
    if (same(back, before.getContext("2d").getImageData(0, 0, W, H).data, 0)) throw new Error("undo did not restore the layer");
    // paint it for real for the erase round
    ed.pointer = null;
}
ed.clearSelection();
await run("remove_layer", { layer: layer.id, doc: window.__t });
return out;
"""),
    ("undo_puts_a_flipped_turned_or_merged_layer_back", """
// docs/PLAN_BCE.md C1 rule 11: 0.1.11 drew an undo step's saved pixels with whatever a flip, a turn
// or a merge had left on the layer's own context, so undoing a fill brought the layer back mirrored,
// turned or see-through. Every write goes through the layer's pixels from a fresh state now: fill +
// undo has to give the pixels from before the fill on each such layer.
await run("new_canvas", { width: 600, height: 400, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
const paint = (l, a, b) => l.px.drawInto(null, (x) => {
    x.fillStyle = a; x.fillRect(20, 30, 260, 120);
    x.fillStyle = b; x.beginPath(); x.arc(420, 250, 90, 0, Math.PI * 2); x.fill();
});
const all = (l) => l.px.readRect(0, 0, l.px.width, l.px.height).data;
// premultiplied: the undo step is a PNG, which rounds the colour of nearly transparent pixels
const worst = (a, b) => { if (a.length !== b.length) return 255; let m = 0; for (let i = 0; i < a.length; i += 4) { const aa = a[i + 3], ba = b[i + 3]; let d = Math.abs(aa - ba); for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i + k] * aa / 255 - b[i + k] * ba / 255)); if (d > m) m = d; } return +m.toFixed(1); };
const out = {};
for (const make of ["flip", "turn", "merge"]) {
    const l = ed.addPaintLayer();
    ed.activeLayerId = l.id;
    paint(l, "#e03020", "rgba(20, 60, 220, 0.6)");
    ed.markLayerChanged(l);
    if (make === "flip") ed.flipLayer("h");
    else if (make === "turn") ed.rotateLayer90(1);
    else {
        const top = ed.addPaintLayer();
        paint(top, "rgba(40, 200, 90, 0.8)", "#f0d020");
        top.blend = "multiply"; top.opacity = 0.5;
        ed.markLayerChanged(top);
        await ed.mergeDown(top);
        ed.activeLayerId = l.id;
    }
    const target = ed.layers.find((x) => x.id === l.id);
    if (!target || ed.activeLayer() !== target) throw new Error(make + ": the layer is gone (" + ed.status + ")");
    const before = all(target);
    await run("select_rect", { x: 100, y: 80, w: 300, h: 200, doc: window.__t });
    ed.brushOpacity = 0.66; ed.color = "#ff8000";
    ed.fillSelection();
    const fill = worst(all(target), before);
    if (fill < 50) throw new Error(make + ": the fill did not land (" + fill + ", " + ed.status + ")");
    await ed.undoStep();
    const back = worst(all(target), before);
    out[make] = { fill, back, size: [target.px.width, target.px.height] };
    if (back > 1) throw new Error(make + ": the undo did not put the layer back, " + back + " levels off: " + JSON.stringify(out));
    ed.clearSelection();
    await run("remove_layer", { layer: target.id, doc: window.__t });
}
ed.brushOpacity = 1;
return out;
"""),
    ("history_steps_run_in_order_and_keep_their_own_state", """
// C1 review (docs/PLAN_BCE.md, C1 as built): undo and redo run one after the other, an edit that
// writes after an await is waited for, a mask fill replaces the mask like its restore does, an
// older layers step keeps its own filter parameters and text, the redo steps leave the budget
// before it trims, and a new image of the same size takes the history with it.
await run("new_canvas", { width: 400, height: 300, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
const out = {};
const band = (x0, x1) => { const m = new Uint8Array(400 * 300); for (let y = 0; y < 300; y++) for (let x = x0; x < x1; x++) m[y * 400 + x] = 1; return m; };
const find = (id) => ed.layers.find((l) => l.id === id);
ed.brushOpacity = 1;
// two undos in a row while the first restore still decodes its PNG (key repeat, a double click)
const L = ed.addPaintLayer();
const at = (x) => { const d = find(L.id).px.readRect(x, 150, 1, 1).data; return d[3] ? d[0] + "," + d[1] : "clear"; };
ed.applyMaskToSelection(band(0, 200), "replace");
ed.color = "#ff0000"; ed.fillSelection();
ed.color = "#00ff00"; ed.fillSelection();
const u1 = ed.undoStep(), u2 = ed.undoStep();
await Promise.all([u1, u2]);
out.race = [at(100)];
await ed.redoStep(); out.race.push(at(100));
await ed.redoStep(); out.race.push(at(100));
if (out.race.join("|") !== "clear|255,0|0,255") throw new Error("undo / redo out of order (clear, red, green expected): " + JSON.stringify(out.race));
// an undo right after a grow that runs in the worker takes the grow back, not the step below it
ed.applyMaskToSelection(band(100, 200), "replace");
const grow = ed.growSelection(20);
await ed.undoStep();
await grow;
out.grow = ed.getBounds();
if (!out.grow || out.grow[0] !== 100 || out.grow[2] !== 200) throw new Error("undo during a grow left " + JSON.stringify(out.grow));
// a fill on a layer mask, with an older layers step holding that mask: undoing both gives the mask from before
const M = ed.addPaintLayer();
M.px.fill(null, "#ff0000"); ed.markLayerChanged(M);
ed.activeLayerId = M.id;
ed.applyMaskToSelection(band(0, 200), "replace");
ed.maskFromSelection(M);
const ma = (x) => { const l = find(M.id); return l.maskPx ? l.maskPx.readRect(x, 150, 1, 1).data[3] : -1; };
const created = [ma(100), ma(300)];
ed.duplicateLayer(M);
ed.activeLayerId = M.id;
find(M.id).maskEdit = true;
ed.applyMaskToSelection(band(200, 400), "replace");
ed.fillSelection();
const filled = [ma(100), ma(300)];
await ed.undoStep(); await ed.undoStep(); await ed.undoStep();   // the fill, the selection, the duplicate
out.maskFill = { created, filled, back: [ma(100), ma(300)] };
if (filled[1] !== 255 || out.maskFill.back.join() !== created.join()) throw new Error("the undone mask fill came back: " + JSON.stringify(out.maskFill));
// filter parameters and text changed in place by their controls, under an older layers step
const F = ed.addFilterLayer("grain");
const key = Object.keys(F.params).find((k) => typeof F.params[k] === "number");
const v0 = F.params[key];
const T = await ed.addTextLayer(20, 20);
T.text.size = 40; await ed.renderTextLayer(T);
if (document.activeElement && document.activeElement.tagName === "TEXTAREA") document.activeElement.blur();
const P = ed.addPaintLayer();
ed.removeLayer(P.id);                                                   // the layers step
ed.pushUndo({ kind: "filter", id: F.id }); find(F.id).params[key] = v0 + 1;   // what the slider does
ed.pushUndo({ kind: "text", id: T.id }); find(T.id).text.size = 80; await ed.renderTextLayer(find(T.id));   // what the Size field does
await ed.undoStep(); await ed.undoStep(); await ed.undoStep();         // text, filter, the removal
out.nested = { param: [v0, find(F.id).params[key]], size: find(T.id).text.size, layers: ed.layers.length };
if (out.nested.param[1] !== v0 || out.nested.size !== 40) throw new Error("an older layers step brought undone values back: " + JSON.stringify(out.nested));
// the budget: 24 steps of 16 MB fill it; 10 undone, then a new step must keep 15 (the redo steps go first)
ed.clearUndo();
const MB16 = 16 * 1048576;
for (let i = 0; i < 24; i++) ed.pushUndoSnapshot({ kind: "transform", id: -1, bytes: MB16 });
for (let i = 0; i < 10; i++) ed.redo.push(ed.undo.pop());            // what undoStep leaves on the budget
ed.pushUndoSnapshot({ kind: "transform", id: -1, bytes: MB16 });
out.budget = { undo: ed.undo.length, redo: ed.redo.length, mb: ed.undoBytes / 1048576 };
if (out.budget.undo !== 15 || out.budget.redo !== 0 || out.budget.mb !== 240) throw new Error("the redo steps trimmed the undo steps: " + JSON.stringify(out.budget));
ed.clearUndo();
// a new image of the same size: no step of the old document survives, and its bytes leave the budget
const S = ed.addPaintLayer();
ed.pushUndoSnapshot(ed.snapshotRect(S, { x: 0, y: 0, w: 400, h: 300 }));
const heldBefore = ed.undoBytes;
await ed.setBase(ed.base.ref, ed.base.img, { keepLayers: false });
out.load = { heldBefore, undo: ed.undo.length, redo: ed.redo.length, bytes: ed.undoBytes, layers: ed.layers.length };
if (!heldBefore || out.load.undo || out.load.redo || out.load.bytes) throw new Error("the history survived a same-size load: " + JSON.stringify(out.load));
return out;
"""),
    ("undo_is_refused_while_a_stroke_or_a_drag_is_held", """
// C1 close-out: Ctrl+Z (or an agent's undo) while the button was down took back the gesture's own
// step, pushed at pointer down (a marquee, a lasso, a move, a smudge), or the step that made the mask
// a stroke paints on, and the finished gesture had no step of its own. It is refused until the
// button comes up.
await run("new_canvas", { width: 800, height: 600, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
await wait(200);
const r = () => ed.canvas.getBoundingClientRect();
const client = (ix, iy) => { const b = r(); const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: b.left + sx * b.width / ed.canvas.width, clientY: b.top + sy * b.height / ed.canvas.height }; };
const ev = (type, ix, iy) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 14, pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy)));
const ctrlZ = () => ed.onKey(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
const fails = [], out = {};
const errors = [];
const onErr = (e) => errors.push(String(e.message || e.error));
window.addEventListener("error", onErr);
try {
    // a stroke on a layer mask whose mask step is on top: the undo removed the mask under the stroke
    await run("add_paint_layer", { doc: window.__t });
    const l = ed.activeLayer();
    await run("select_rect", { x: 100, y: 100, w: 300, h: 200, doc: window.__t });
    ed.maskFromSelection(l);          // a mask step with no mask before it
    ed.clearSelection();
    await ed.undoStep();              // the selection is back, the mask step is on top
    ed.toggleMaskEdit(l);
    ed.setTool("paint");
    const n0 = ed.undo.length;
    ed.canvas.dispatchEvent(ev("pointerdown", 150, 150));
    ed.canvas.dispatchEvent(ev("pointermove", 200, 180));
    await wait(20);
    ctrlZ();
    await wait(80);
    const kept = !!l.maskPx, said = ed.status;
    ed.canvas.dispatchEvent(ev("pointermove", 260, 220));
    await wait(30);
    ed.canvas.dispatchEvent(ev("pointerup", 300, 240));
    await wait(100);
    out.mask = { kept, steps: ed.undo.length - n0, said, pointer: ed.pointer ? ed.pointer.kind : null };
    if (!kept || out.mask.steps !== 1 || out.mask.pointer) fails.push("mask stroke: " + JSON.stringify(out.mask));
    if (l.maskPx) ed.toggleMaskEdit(l);
    // a marquee drag: its step is pushed at pointer down
    ed.setTool("rect");
    await run("select_none", { doc: window.__t });
    const n1 = ed.undo.length;
    ed.canvas.dispatchEvent(ev("pointerdown", 500, 100));
    ed.canvas.dispatchEvent(ev("pointermove", 600, 200));
    await wait(20);
    ctrlZ();
    await wait(50);
    ed.canvas.dispatchEvent(ev("pointermove", 700, 300));
    await wait(20);
    ed.canvas.dispatchEvent(ev("pointerup", 700, 300));
    await wait(50);
    const drawn = ed.getBounds(), steps = ed.undo.length - n1;
    await ed.undoStep();
    out.marquee = { drawn, steps, afterUndo: ed.getBounds() };
    if (steps !== 1 || !drawn || out.marquee.afterUndo) fails.push("marquee: " + JSON.stringify(out.marquee));
    out.errors = errors;
    if (errors.length) fails.push("errors: " + JSON.stringify(errors));
} finally {
    window.removeEventListener("error", onErr);
    ed.setTool("select");
}
if (fails.length) throw new Error(fails.join(" | "));
return out;
"""),
    ("undo_does_not_run_over_edits_made_while_it_loads", """
// C1 close-out: a restore took its step off the stack and then awaited the step's PNG, so an edit
// made in that window was overwritten when the restore landed (and the history then held a step for
// pixels that never existed); an undo that waited for a grow took back the edit made during the wait
// instead; extend, crop, resize and merge into the base pushed their step after the upload without
// being waited for; flatten kept the history and had no step of its own.
await run("new_canvas", { width: 800, height: 600, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
await wait(200);
const fails = [], out = {};
const find = (id) => ed.layers.find((l) => l.id === id);
const pix = (L, x, y) => { const l = find(L.id); return l ? Array.from(l.px.readRect(x, y, 1, 1).data).join(",") : "gone"; };
const stroke = (L, rect, color) => {   // what commitStroke does: the rectangle's step first, then the write
    const l = find(L.id);
    ed.pushUndoSnapshot(ed.snapshotRect(l, { x: rect[0], y: rect[1], w: rect[2] - rect[0], h: rect[3] - rect[1] }));
    l.px.fill(rect, color);
    ed.markLayerChanged(l, rect);
};
const reset = async () => {
    await run("select_none", { doc: window.__t });
    ed.layers = []; ed.activeLayerId = null;
    ed.clearUndo();
    ed.renderLayers(); ed.draw();
};
ed.brushOpacity = 1;
// 1. a stroke while an undo decodes the PNG of a fill
try {
    await reset();
    const L = ed.addPaintLayer();
    ed.activeLayerId = L.id;
    await run("select_rect", { x: 100, y: 100, w: 400, h: 300, doc: window.__t });
    ed.color = "#ff0000"; ed.fillSelection();
    const u = ed.undoStep();
    stroke(L, [200, 200, 260, 260], "#0000ff");
    await u;
    const a = { afterUndo: pix(L, 230, 230), said: ed.status };
    await ed.undoStep(); a.strokeUndone = [pix(L, 230, 230), pix(L, 300, 300)];
    await ed.undoStep(); a.fillUndone = [pix(L, 230, 230), pix(L, 300, 300)];
    out.fillDecode = a;
    if (a.afterUndo !== "0,0,255,255" || a.strokeUndone.join("|") !== "255,0,0,255|255,0,0,255" || a.fillUndone.join("|") !== "0,0,0,0|0,0,0,0") fails.push("a stroke during an undo's decode: " + JSON.stringify(a));
} catch (err) { fails.push("1 threw: " + (err && err.message)); }
// 2. a stroke while an undo waits for a grow in the worker
try {
    await reset();
    const L = ed.addPaintLayer();
    ed.activeLayerId = L.id;
    await run("select_rect", { x: 300, y: 200, w: 100, h: 100, doc: window.__t });
    const g = ed.growSelection(20);
    const u = ed.undoStep();
    stroke(L, [50, 50, 90, 90], "#00ff00");
    await Promise.all([g, u]);
    const b = { afterUndo: pix(L, 70, 70), bounds: ed.getBounds(), said: ed.status };
    out.growWait = b;
    if (b.afterUndo !== "0,255,0,255" || !b.bounds || b.bounds[0] !== 280 || b.bounds[2] !== 420) fails.push("a stroke during an undo's wait for a grow: " + JSON.stringify(b));
} catch (err) { fails.push("2 threw: " + (err && err.message)); }
// 3. a layer added while a canvas redo decodes its selection
try {
    await reset();
    await run("extend_canvas", { right: 200, doc: window.__t });
    await ed.undoStep();
    const p = ed.redoStep();
    const P = ed.addPaintLayer();
    await p;
    const c = { size: [ed.width, ed.height], layer: !!find(P.id), said: ed.status };
    out.canvasRedo = c;
    if (!c.layer || c.size[0] !== 800) fails.push("a layer added during a canvas redo: " + JSON.stringify(c));
} catch (err) { fails.push("3 threw: " + (err && err.message)); }
// 4. an undo pressed while an extended canvas uploads
try {
    await reset();
    const L = ed.addPaintLayer();
    ed.activeLayerId = L.id;
    stroke(L, [10, 10, 40, 40], "#ff00ff");
    const W0 = ed.width;
    const e = ed.extendCanvas({ right: 100 });
    const u = ed.undoStep();
    await Promise.all([e, u]);
    const top = ed.undo[ed.undo.length - 1];
    const d = { size: [ed.width, ed.height], pixel: pix(L, 20, 20), top: top ? top.kind : null, said: ed.status };
    out.extendUpload = d;
    if (d.size[0] !== W0 || d.pixel !== "255,0,255,255" || d.top !== "layerrect") fails.push("an undo during the extension's upload: " + JSON.stringify(d));
} catch (err) { fails.push("4 threw: " + (err && err.message)); }
// 5. an undo pressed while a merge into the base uploads, a layers step below it
try {
    await reset();
    const M = ed.addPaintLayer();
    find(M.id).px.fill(null, "#00ffff"); ed.markLayerChanged(find(M.id));
    const copy = ed.duplicateLayer(find(M.id));      // a layers step; the copy above M
    const baseRef = JSON.stringify(ed.base.ref);
    const m = ed.mergeDown(find(M.id));              // the bottom layer: into the base
    const u = ed.undoStep();
    await Promise.all([m, u]);
    const e = { layers: ed.layers.map((l) => l.id), want: [M.id, copy.id], base: JSON.stringify(ed.base.ref) === baseRef, said: ed.status };
    out.mergeUpload = e;
    if (e.layers.join() !== e.want.join() || !e.base) fails.push("an undo during a merge into the base: " + JSON.stringify(e));
} catch (err) { fails.push("5 threw: " + (err && err.message)); }
// 6. flatten, then undo, with a layers step below
try {
    await reset();
    const baseRef = JSON.stringify(ed.base.ref);
    const F = ed.addPaintLayer();
    find(F.id).px.fill([0, 0, 400, 300], "#ff0000"); find(F.id).opacity = 0.5; find(F.id).blend = "multiply"; ed.markLayerChanged(find(F.id));
    const D = ed.duplicateLayer(find(F.id));         // a layers step holding F
    await ed.flatten();
    const flat = { layers: ed.layers.length, base: JSON.stringify(ed.base.ref) !== baseRef };
    await ed.undoStep();
    const f = { flat, layers: ed.layers.map((l) => l.id), want: [F.id, D.id], base: JSON.stringify(ed.base.ref) === baseRef, said: ed.status };
    out.flatten = f;
    if (flat.layers !== 0 || !flat.base || f.layers.join() !== f.want.join() || !f.base) fails.push("undo after flatten: " + JSON.stringify(f));
} catch (err) { fails.push("6 threw: " + (err && err.message)); }
await reset();
if (fails.length) throw new Error(fails.join(" | "));
return out;
"""),
    ("text_edit_steps_give_their_blob_urls_back", """
// C1 close-out: a text edit takes a step with a PNG of the layer when it starts. A cancelled or
// unchanged edit dropped that step without revoking its blob URL, and closing a tab with a changed
// edit open pushed it after the history had been cleared: a PNG of the layer left behind each time.
const live = new Set();
const oc = URL.createObjectURL, orv = URL.revokeObjectURL;
URL.createObjectURL = (b) => { const u = oc.call(URL, b); live.add(u); return u; };
URL.revokeObjectURL = (u) => { live.delete(u); return orv.call(URL, u); };
const out = {};
try {
    const d = await run("new_document");
    const ed = ednow(d.id);
    await run("new_canvas", { width: 800, height: 600, doc: d.id });
    const T = await ed.addTextLayer(20, 20);
    if (ed.textEdit) ed.endTextEdit(true);
    await wait(400);
    live.clear();
    for (let i = 0; i < 3; i++) { ed.beginTextEdit(T); await wait(120); ed.endTextEdit(false); await wait(120); }
    ed.beginTextEdit(T); await wait(120); ed.endTextEdit(true);     // Enter without a change
    await wait(600);
    out.cancelled = { live: live.size, undo: ed.undo.length };
    live.clear();
    ed.beginTextEdit(T); await wait(200);
    ed.textEdit.ta.value = "changed"; T.text.content = "changed";
    await run("close_document", { doc: d.id, force: true });
    await wait(600);
    out.closed = { live: live.size, undo: ed.undo.length };
} finally {
    URL.createObjectURL = oc; URL.revokeObjectURL = orv;
}
host.shell.activate(ednow(window.__t));
if (out.cancelled.live || out.closed.live || out.closed.undo) throw new Error("text edit steps left blob URLs behind: " + JSON.stringify(out));
return out;
"""),
    ("selection_keeps_its_bounds_through_a_restore_above_1mp", """
// C1 review: above 1 MP the bounds come from the selection's display levels. A saved document
// restored with setValue, and a canvas undo with a frame drawn while it decoded, wrote the
// selection after levels of the empty one had been cached under the same version: no bounds.
await run("new_canvas", { width: 2400, height: 1600, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
await run("select_rect", { x: 300, y: 200, w: 600, h: 400, doc: window.__t });
const want = JSON.stringify([300, 200, 900, 600]);
const out = { before: ed.getBounds() };
const state = ed.getValue();
const d2 = await run("new_document");
const ed2 = ednow(d2.id);
// a getValue while the layers load (the autosave, ComfyUI serializing the graph) sees the empty
// selection setBase left; the restored one has to be encoded again after it is written (close-out)
const setBase = ed2.setBase;
ed2.setBase = async function (...a) { const r = await setBase.apply(this, a); this.getValue(); return r; };
try { await ed2.setValue(state); } finally { delete ed2.setBase; }
for (let i = 0; i < 200 && (ed2._loading || !ed2.base); i++) await wait(50);
out.restored = ed2.getBounds();
const selected = async (url) => {
    if (!url) return null;
    const img = new Image(); img.src = url; await img.decode();
    const k = document.createElement("canvas"); k.width = img.naturalWidth; k.height = img.naturalHeight;
    const g = k.getContext("2d"); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, k.width, k.height).data; let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 127) n++;
    return n;
};
out.saved = await selected(JSON.parse(ed2.getValue()).selection);
await run("close_document", { doc: d2.id, force: true });
host.shell.activate(ed);
if (JSON.stringify(out.restored) !== want) throw new Error("the restored selection lost its bounds: " + JSON.stringify(out));
if (out.saved !== 240000) throw new Error("getValue after the restore saves another selection: " + JSON.stringify(out));
await run("extend_canvas", { right: 400, bottom: 400, doc: window.__t });
ed.view.scale = 0.25;
const u = ed.undoStep();
ed.draw();                                  // a frame while the canvas step decodes its selection
await u;
out.undone = { size: [ed.width, ed.height], bounds: ed.getBounds() };
if (JSON.stringify(out.undone.bounds) !== want) throw new Error("the canvas undo lost the selection's bounds: " + JSON.stringify(out));
ed.fitView();
return out;
"""),
    ("selection_brush_levels_follow_each_dab", """
// C1 review: the selection brush refreshed the display levels before it drew the dab, so a fast
// stroke zoomed out showed only parts of itself until the button came up.
await run("new_canvas", { width: 3000, height: 2000, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
await run("select_none", { doc: window.__t });
ed.view.scale = 0.25;
ed._pyramidBudget = Infinity;
ed.displaySource(ed.sel, 0.25);                 // the levels exist, as after a zoomed-out frame
const size = ed.brushSize;
ed.brushSize = 20;
ed.pointer = { kind: "selpaint", last: [200, 1000], path: [[200, 1000]], subtract: false };
let last = [200, 1000];
ed.selectionDab(200, 1000, 200, 1000);
for (let x = 280; x <= 2600; x += 80) { ed.selectionDab(last[0], last[1], x, 1000); ed.pointer.last = [x, 1000]; last = [x, 1000]; }
ed.pointer = null;
const litOn = (lvl) => {
    const f = lvl.width / 3000, row = Math.round(1000 * f);
    const d = lvl.getContext("2d").getImageData(0, row, lvl.width, 1).data;
    let n = 0; for (let x = Math.round(220 * f); x < Math.round(2560 * f); x++) if (d[x * 4 + 3] > 128) n++;
    return n;
};
const shown = litOn(ed.displaySource(ed.sel, 0.25));
ed.touchSource(ed.sel);
const fresh = litOn(ed.displaySource(ed.sel, 0.25));
ed.brushSize = size;
ed.markSelectionChanged();
await run("select_none", { doc: window.__t });
ed.fitView();
const out = { shown, fresh };
if (fresh < 500 || shown < fresh - 2) throw new Error("the levels lag behind the dabs: " + JSON.stringify(out));
return out;
"""),
    ("undo_step_whose_encode_failed_says_so", """
// C1 review: a whole-layer undo step is a PNG of the layer as it was. When the worker could not
// encode it, the fallback encoded the canvas after the edit, and the undo silently put the edit
// back. Such a step fails now and the status line says so.
await run("new_canvas", { width: 400, height: 300, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
const L = ed.addPaintLayer();
ed.activeLayerId = L.id;
await run("select_rect", { x: 50, y: 50, w: 200, h: 100, doc: window.__t });
ed.color = "#ff0000"; ed.brushOpacity = 1;
const cib = window.createImageBitmap;
window.createImageBitmap = () => Promise.reject(new Error("editor_test: no bitmap"));
try { ed.fillSelection(); } finally { window.createImageBitmap = cib; }
await wait(300);
await ed.undoStep();
const d = L.px.readRect(100, 100, 1, 1).data;
const out = { status: ed.status, pixel: Array.from(d) };
if (!/could not be restored/.test(ed.status)) throw new Error("the lost undo step went unnoticed: " + JSON.stringify(out));
return out;
"""),
    ("mask_brush_stroke_undo_and_redo", """
// c6bc6a6 (the C1 close-out) decodes a step's images before it takes the step off its stack, and read
// a "layerrect" step's `mask` (the flag of a mask stroke) as an image: every undo of a mask brush stroke
// failed with "could not load true" and the stroke stayed. A real stroke with the brush on a layer mask,
// through the pointer handlers: undo gives the mask from before to the byte, redo gives the stroke back,
// the layer's own pixels are never touched, and neither the status line nor the console says "could not".
await run("new_canvas", { width: 1200, height: 900, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
ed.fitView();
const out = {};
const errors = [];
const consoleError = console.error;
console.error = function (...a) { errors.push(a.map((x) => String((x && x.message) || x)).join(" ")); return consoleError.apply(this, a); };
const onRejection = (e) => errors.push("unhandled rejection: " + String((e.reason && e.reason.message) || e.reason));
window.addEventListener("unhandledrejection", onRejection);
const all = (p) => p.readRect(0, 0, p.width, p.height).data.slice();
const exact = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const worst = (a, b) => { if (a.length !== b.length) return 255; let m = 0; for (let i = 0; i < a.length; i += 4) { const aa = a[i + 3], ba = b[i + 3]; let v = Math.abs(aa - ba); for (let k = 0; k < 3; k++) v = Math.max(v, Math.abs(a[i + k] * aa / 255 - b[i + k] * ba / 255)); if (v > m) m = v; } return +m.toFixed(1); };
const find = (id) => ed.layers.find((l) => l.id === id);
let id = null;
try {
    const M = ed.addPaintLayer();
    id = M.id;
    M.px.fill(null, "#ff0000"); ed.markLayerChanged(M);
    await run("select_rect", { x: 200, y: 200, w: 800, h: 500, doc: window.__t });
    ed.maskFromSelection(M);
    ed.clearSelection();
    const layer0 = all(M.px), mask0 = all(M.maskPx);
    ed.toggleMaskEdit(M);
    ed.brushSize = 60; ed.hardness = 1; ed.brushOpacity = 1;
    ed.draw(); await wait(50);
    const rect = ed.canvas.getBoundingClientRect();
    const client = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
    const ev = (type, ix, iy) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 21, pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy)));
    // below the mask's rectangle, where it hides the layer: the brush reveals there
    ed.canvas.dispatchEvent(ev("pointerdown", 300, 800));
    out.kind = ed.pointer && ed.pointer.kind;
    for (let i = 1; i <= 8; i++) { ed.canvas.dispatchEvent(ev("pointermove", 300 + 75 * i, 800)); await wait(16); }
    ed.canvas.dispatchEvent(ev("pointerup", 900, 800));
    await wait(80);
    const step = ed.undo[ed.undo.length - 1];
    const mask1 = all(find(id).maskPx);
    out.stroke = { tool: ed.tool, maskEdit: M.maskEdit, step: step && step.kind, flag: step && step.mask, revealed: find(id).maskPx.readRect(600, 800, 1, 1).data[3], hiddenBefore: mask0[(800 * 1200 + 600) * 4 + 3], size: [M.maskPx.width, M.maskPx.height] };
    if (out.kind !== "maskpaint" || !step || step.kind !== "layerrect" || step.mask !== true) throw new Error("the gesture did not become a mask stroke with its rect step: " + JSON.stringify(out));
    if (out.stroke.revealed < 250 || out.stroke.hiddenBefore !== 0 || exact(mask1, mask0)) throw new Error("the stroke did not reach the mask: " + JSON.stringify(out));
    const u = await run("undo", { doc: window.__t });
    const maskU = all(find(id).maskPx);
    out.undo = { status: ed.status, redo: u.redo, exact: exact(maskU, mask0), worst: worst(maskU, mask0) };
    if (/could not/i.test(ed.status) || !out.undo.exact || u.redo < 1) throw new Error("the undo of the mask stroke failed: " + JSON.stringify(out) + " " + JSON.stringify(errors));
    const r = await run("redo", { doc: window.__t });
    const maskR = all(find(id).maskPx);
    out.redo = { status: ed.status, undo: r.undo, exact: exact(maskR, mask1), worst: worst(maskR, mask1) };
    if (/could not/i.test(ed.status) || out.redo.worst > 1) throw new Error("the redo did not give the mask stroke back: " + JSON.stringify(out) + " " + JSON.stringify(errors));
    out.layerUntouched = exact(all(find(id).px), layer0);
    if (!out.layerUntouched) throw new Error("the mask stroke, its undo or its redo changed the layer's own pixels: " + JSON.stringify(out));
    await wait(100);
    if (errors.length) throw new Error("console errors: " + JSON.stringify(errors));
} finally {
    console.error = consoleError;
    window.removeEventListener("unhandledrejection", onRejection);
    const L = id != null && find(id);
    if (L && L.maskEdit) ed.toggleMaskEdit(L);
    if (L) await run("remove_layer", { layer: id, doc: window.__t });
    ed.setTool("select");
}
return out;
"""),
    ("closed_tabs_are_collected", lambda c: closed_tabs_are_collected(c)),
    ("cleanup", """
for (const id of [window.__t3, window.__t2, window.__t]) { try { await run("close_document", { doc: id }); } catch (_) { /* gone */ } }
return "ok";
"""),
]

PRE = """(async () => {
    const commands = window.__cmds.commands, host = window.__host;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    %s
})()"""


async def run_all(c):
    # a modal <dialog> left open makes everything outside it inert, and the focus steps
    # below would fail for a reason that has nothing to do with the editor
    await c.eval("(async () => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); window.__cmds = await import('./commands.js'); window.__host = (await import('./editor/host.js')).host; return 1; })()")
    await c.eval("window.__exportPath = %s; 1" % json.dumps(os.path.join(os.environ.get("TEMP", os.getcwd()), "scumble_editor_test_export.png")))
    ok = True
    for name, body in STEPS:
        try:
            res = await (body(c) if callable(body) else c.eval(PRE % body, timeout=180))
            print("[ok] %s: %s" % (name, json.dumps(res)[:280]))
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] %s: %s" % (name, err))
            break
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:200])
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
