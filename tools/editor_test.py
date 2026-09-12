"""Editor behaviour that is easy to break again, against the running app (tools/cdp.py).

No ComfyUI needed. Checks the New dialog (two number boxes, the ratio tie, the focus that a
button click used to steal), that a click without a drag deselects with the marquee and the
lasso, that an outline in progress is drawn black under white so it stays visible on a white
image, copy and paste of a whole layer from one tab into another, and that an erase stroke
through one strip of a zoomed-out result layer leaves the rest of the layer on screen (the
cached display level used to be wiped outside the stroke's rectangle).

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
const bc = document.createElement("canvas"); bc.width = ed.width; bc.height = ed.height;
const bctx = bc.getContext("2d"); bctx.drawImage(ed.base.img, 0, 0);
const px = (x, y) => Array.from(bctx.getImageData(x, y, 1, 1).data);
out.red = px(100, 200); out.blue = px(600, 200); out.white = px(700, 30);
if (out.red[0] < 250 || out.red[1] > 5) throw new Error("red " + out.red);
if (out.blue[2] < 250 || out.blue[0] > 5) throw new Error("blue " + out.blue);
if (out.white[1] < 250) throw new Error("white " + out.white);
out.baseFile = ed.base.ref.filename;
if (!/\\.png$/i.test(out.baseFile)) throw new Error("the mirror holds " + out.baseFile);
// a layer: rasterised to fit the document, no dialog
await ed.addImageLayers([file], "none", { place: "fit" });
const layer = ed.layers[ed.layers.length - 1];
out.layer = [layer.canvas.width, layer.canvas.height, layer.w, layer.h, layer.name];
if (layer.canvas.width !== 800 || layer.canvas.height !== 400 || layer.w !== 800) throw new Error("layer " + out.layer);
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
const orig = document.createElement("canvas");
orig.width = ed.width; orig.height = ed.height;
orig.getContext("2d").drawImage(ed.selection, 0, 0);
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
const lc = a.layerPixels(l).getContext("2d");
lc.fillStyle = "#ff3300"; lc.fillRect(10, 10, 120, 60);
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
const layer = ed.addLayer({ name: "Result", kind: "result", ref: null, canvas: lc, x: LX, y: LY, w: LW, h: LH, dirty: true });
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
const d = layer.canvas.getContext("2d").getImageData(0, 0, LW, LH).data;
let alpha = 0;
for (let i = 3; i < d.length; i += 4) if (d[i] > 0) alpha++;
const after = { block: screenAt(...block), strip: screenAt(...strip), alpha, kind, clipped };
if (kind !== "layerpaint" || !clipped) throw new Error("the gesture did not become a clipped erase stroke: " + JSON.stringify(after));
if (alpha < 111000 || alpha >= 271000) throw new Error("the layer's own pixels are wrong: " + JSON.stringify(after));
if (!white(after.strip)) throw new Error("the erase did not reach the screen: " + JSON.stringify(after));
if (!green(after.block)) throw new Error("the block 580 px from the stroke vanished from the screen: " + JSON.stringify(after));
return { before, after };
"""),
    ("escape_closes_the_shell_dialogs", lambda c: escape_closes_the_shell_dialogs(c)),
    ("svg_import_rasterises_on_the_way_in", lambda c: svg_import_rasterises_on_the_way_in(c)),
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
