"""EU AI label plugin test against the running app (see tools/cdp.py for the setup).

No ComfyUI and no key needed: a white 1600 x 1000 canvas, then ailabel.add through the command
core, the layer's size and anchor position against the percentages, a pixel of a letter and
one of the pill in the layer and in the flattened picture, the translucent ground's alpha,
the bare mark at the top left with a layer opacity, that adding again replaces instead of
stacking, ailabel.remove, and the panel in the tab.

    python tools/ailabel_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555
"""
import asyncio
import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

# viewBox 0 0 1789.84 566.93: the "I" of "AI" spans x 465..498, y 212..341; x 550 is the gap before "GENERATED"
WORDMARK = (1789.84, 566.93)
I_GLYPH = (481, 276)
GAP = (550, 277)

STEPS = [
    ("plugin_loaded", """
const P = await import("./plugins.js");
const list = await P.pluginHost.list();
const p = list.find((x) => x.id === "ailabel");
if (!p) throw new Error("ailabel plugin not listed: " + list.map((x) => x.id));
if (p.error) throw new Error("ailabel plugin error: " + p.error);
const cmds = (await c("list_commands")).commands.map((x) => x.name);
for (const n of ["ailabel.add", "ailabel.remove", "ailabel.info"]) if (!cmds.includes(n)) throw new Error("command missing: " + n);
const info = await c("ailabel.info");
return { labels: info.labels, anchors: Object.keys(info.anchors).length, source: info.source };
"""),
    ("document", """
const d = await c("new_document");
window.__aiDoc = d.id;
const s = await c("new_canvas", { width: 1600, height: 1000, doc: d.id });
return { width: s.width, height: s.height };
"""),
    ("add_wordmark_bottom_right", """
const r = await c("ailabel.add", { label: "generated", style: "dark", ground: "solid", size: 50, anchor: "br", margin: 4, opacity: 100, doc: window.__aiDoc });
const L = r.layer;
const w = 800, h = Math.round(800 * %(vh)s / %(vw)s), m = 40;
if (L.w !== w || L.h !== h) throw new Error("size " + L.w + "x" + L.h + ", wanted " + w + "x" + h);
if (L.x !== 1600 - w - m || L.y !== 1000 - h - m) throw new Error("position " + L.x + "," + L.y);
if (L.name !== "AI label") throw new Error("name " + L.name);
const lay = editor.layers.find((l) => l.id === L.id);
const k = w / %(vw)s;
const px = (cv, x, y) => Array.from(cv.getContext("2d").getImageData(Math.round(x), Math.round(y), 1, 1).data);
const letter = px(lay.canvas, %(ix)s * k, %(iy)s * k), pill = px(lay.canvas, %(gx)s * k, %(gy)s * k), corner = px(lay.canvas, 2, 2);
if (letter[3] !== 255 || letter[0] < 250) throw new Error("the letter is not white: " + letter);
if (pill[3] !== 255 || pill[0] > 5) throw new Error("the pill is not black: " + pill);
if (corner[3] !== 0) throw new Error("the corner outside the pill is not transparent: " + corner);
// the flattened picture: the label sits where the layer says
const flat = editor.flattenToCanvas({ forRun: true });
const fl = px(flat, L.x + %(ix)s * k, L.y + %(iy)s * k), fp = px(flat, L.x + %(gx)s * k, L.y + %(gy)s * k), fw = px(flat, 20, 20);
if (fl[0] < 250 || fp[0] > 5 || fw[0] < 250) throw new Error("flattened: letter " + fl + " pill " + fp + " outside " + fw);
window.__aiLayer = L.id;
return { size: [L.w, L.h], at: [L.x, L.y], letter, pill, corner, file: r.file };
""" % { "vw": WORDMARK[0], "vh": WORDMARK[1], "ix": I_GLYPH[0], "iy": I_GLYPH[1], "gx": GAP[0], "gy": GAP[1] }),
    ("translucent_light_replaces", """
const r = await c("ailabel.add", { style: "light", ground: "translucent", size: 50, anchor: "br", margin: 4, doc: window.__aiDoc });   // command args never change the panel's stored settings
if (!r.replaced) throw new Error("the second add did not replace");
const labels = editor.layers.filter((l) => l.name === "AI label");
if (labels.length !== 1) throw new Error(labels.length + " label layers");
if (labels[0].id === window.__aiLayer) throw new Error("the old layer is still there");
const L = r.layer;
const k = L.w / %(vw)s;
const px = (cv, x, y) => Array.from(cv.getContext("2d").getImageData(Math.round(x), Math.round(y), 1, 1).data);
const letter = px(labels[0].canvas, %(ix)s * k, %(iy)s * k), pill = px(labels[0].canvas, %(gx)s * k, %(gy)s * k);
if (letter[3] !== 255 || letter[0] > 40) throw new Error("the letter is not dark: " + letter);
if (pill[0] < 250 || Math.abs(pill[3] - 128) > 3) throw new Error("the pill is not white at half opacity: " + pill);
if (L.w !== 800 || L.x !== 760 || L.opacity !== 1) throw new Error("size / anchor / default opacity: " + L.w + " at " + L.x + ", " + L.opacity);
return { layers: labels.length, letter, pill, file: r.file };
""" % { "vw": WORDMARK[0], "ix": I_GLYPH[0], "iy": I_GLYPH[1], "gx": GAP[0], "gy": GAP[1] }),
    ("mark_top_left_with_opacity", """
const r = await c("ailabel.add", { label: "mark", anchor: "tl", size: 10, opacity: 50, doc: window.__aiDoc });
const L = r.layer;
if (L.w !== 160 || L.h !== 160) throw new Error("mark size " + L.w + "x" + L.h);
if (L.x !== 30 || L.y !== 30) throw new Error("mark position " + L.x + "," + L.y + " (default margin 3 % of 1000)");
if (Math.abs(L.opacity - 0.5) > 0.01) throw new Error("opacity " + L.opacity);
if (editor.layers.filter((l) => l.name === "AI label").length !== 1) throw new Error("stacked");
const undoBefore = editor.undo.length;
return { size: [L.w, L.h], at: [L.x, L.y], opacity: L.opacity, file: r.file, undo: undoBefore };
"""),
    ("remove", """
const r = await c("ailabel.remove", { doc: window.__aiDoc });
if (!r.removed) throw new Error("not removed");
if (editor.layers.some((l) => l.name === "AI label")) throw new Error("still there");
const again = await c("ailabel.remove", { doc: window.__aiDoc });
if (again.removed) throw new Error("removed twice");
return r;
"""),
    ("panel_and_actions", """
const summary = Array.from(editor.root.querySelectorAll("details > summary")).find((s) => s.textContent === "AI label");
if (!summary) throw new Error("the AI label panel is missing");
const details = summary.parentElement;
const selects = details.querySelectorAll("select").length, sliders = details.querySelectorAll("input[type=range]").length;
const buttons = Array.from(details.querySelectorAll("button")).map((b) => b.textContent);
if (selects !== 4 || sliders !== 3) throw new Error("panel: " + selects + " selects, " + sliders + " sliders");
if (!buttons.includes("Add label") || !buttons.includes("Remove label")) throw new Error("buttons " + buttons);
// the button places a layer with the last settings (the mark at the top left, from the step before)
details.open = true;
Array.from(details.querySelectorAll("button")).find((b) => b.textContent === "Add label").click();
await new Promise((r) => setTimeout(r, 400));
const L = editor.layers.find((l) => l.name === "AI label");
if (!L) throw new Error("the button did not add a label (" + editor.status + ")");
const plugins = await c("list_plugins");
const me = plugins.plugins.find((p) => p.id === "ailabel");
const actions = (me.registered && me.registered.actions || me.actions || []).map((a) => a.id || a);
if (!actions.some((a) => String(a).includes("ailabel.add"))) throw new Error("actions " + JSON.stringify(actions));
return { selects, sliders, buttons, layerAt: [L.x, L.y, L.w, L.h], actions };
"""),
    ("close", """
await c("close_document", { doc: window.__aiDoc, force: true });
return { closed: true };
"""),
]


async def main():
    sys.stdout.reconfigure(encoding="utf-8")

    async def run(cdp):
        ev = cdp.eval
        await ev("(() => { window.__log = window.__log || []; return 1; })()")
        failed = 0
        for name, body in STEPS:
            js = "(async () => { const raw = await import('./commands.js'); const c = (n, a) => raw.commands.run(n, a || {}); const editor = window.editor; " + body + " })()"
            try:
                res = await ev(js, timeout=120)
                print(f"PASS {name}: {json.dumps(res)[:300]}")
            except Exception as err:  # noqa: BLE001
                failed += 1
                print(f"FAIL {name}: {err}")
                try:
                    log = await ev("JSON.stringify((window.__log || []).slice(-8))")
                    print("  console:", str(log)[:1200])
                except Exception:  # noqa: BLE001
                    pass
                break
        print("RESULT", "PASS" if not failed else f"FAIL ({failed})")
        return not failed

    return await session(run)


if __name__ == "__main__":
    sys.exit(0 if asyncio.run(main()) else 1)
