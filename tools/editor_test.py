"""Editor behaviour that is easy to break again, against the running app (tools/cdp.py).

No ComfyUI needed. Checks the New dialog (two number boxes, the ratio tie, the focus that a
button click used to steal), that a click without a drag deselects with the marquee and the
lasso, that an outline in progress is drawn black under white so it stays visible on a white
image, and copy and paste of a whole layer from one tab into another.

    python tools/editor_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

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
if (!out.before || out.afterClickInside || out.afterLassoClick) throw new Error(JSON.stringify(out));
return out;
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
    ("cleanup", """
for (const id of [window.__t2, window.__t]) { try { await run("close_document", { doc: id }); } catch (_) { /* gone */ } }
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
            res = await c.eval(PRE % body, timeout=180)
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
