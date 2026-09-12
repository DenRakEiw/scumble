"""Custom brush tips (.abr) against the running app (see tools/cdp.py for the setup).

Runs `node tools/brush_test.js` first (the reader on synthetic files of every version and on
the Photoshop packs of this machine when present), then drives the app: import of a synthetic
.abr through the editor's own path (names, spacing, the skipped computed tip in the status
line), a stroke with a ring tip against the round dab through the real pointer handlers, an
erase with a tip, the ring drawn as the tip's box, the thumbnail, the list_brush_tips /
set_brush commands, persistence across a reload, and removal.

    python tools/brush_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555
"""
import asyncio
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(tempfile.gettempdir(), "scumble_brush_test")

PRE = """(async () => {
    const raw = await import('./commands.js'); const c = (n, a) => raw.commands.run(n, a || {});
    const host = (await import('./editor/host.js')).host;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const ednow = () => host.editors().find((e) => e.node.id === window.__bDoc) || window.editor;
    %s
})()"""

STEPS = [
    ("document", """
const d = await c("new_document");
window.__bDoc = d.id;
host.shell.activate(ednow());
await c("new_canvas", { width: 600, height: 400, doc: d.id });
// leftovers of an earlier run that failed before its own cleanup
const stale = host.brushLibrary.filter((t) => t.source === "synthetic_v6.abr");
for (const t of stale) ednow().removeBrushTip(t.id);
if (stale.length) await host.saveBrushTips();
window.__bBefore = host.brushLibrary.length;
return { width: 600, library: host.brushLibrary.length };
"""),
    ("import_abr_through_the_editor", """
const ed = ednow();
const r = await window.scumble.file.read(window.__abrPath);
const file = new File([r.data], "synthetic_v6.abr");
const added = await ed.importBrushFiles([file]);
const names = added.map((t) => t.name);
if (JSON.stringify(names) !== JSON.stringify(["Ring Brush", "Bar Brush", "Bar Brush (dual)"])) throw new Error("names " + names);
if (Math.abs(added[0].spacing - 0.3) > 1e-9 || Math.abs(added[1].spacing - 0.15) > 1e-9) throw new Error("spacing " + added.map((t) => t.spacing));
if (!/3 brush tips imported, 1 computed \\(round\\) tip skipped/.test(ed.status)) throw new Error("status: " + ed.status);
if (ed.brushTipId !== added[0].id) throw new Error("the first tip is not active");
if (host.brushLibrary.length !== window.__bBefore + 3) throw new Error("library " + host.brushLibrary.length);
const options = Array.from(ed.tipSel.options).map((o) => o.textContent);
if (!options.includes("Ring Brush")) throw new Error("select " + options);
window.__bIds = added.map((t) => t.id);
await host.saveBrushTips();
return { names, spacing: added.map((t) => t.spacing), status: ed.status };
"""),
    ("stroke_with_the_ring_tip", """
const ed = ednow();
const L = await c("add_paint_layer", { doc: window.__bDoc });
ed.setTool("paint");
ed.color = "#ff0000"; ed.brushSize = 80; ed.brushOpacity = 1; ed.hardness = 1;
ed.setBrushTip(window.__bIds[0]);
if (ed.tipOnlyEls.some((e) => e.style.display === "none")) throw new Error("the spacing row is hidden while a tip is active");
if (ed.tipRemoveBtn.style.display === "none") throw new Error("the Remove button is hidden while a tip is active");
const rect = ed.canvas.getBoundingClientRect();
const client = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
const ev = (type, ix, iy) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 7, pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy)));
const stroke = async (y) => {
    ed.canvas.dispatchEvent(ev("pointerdown", 100, y));
    for (let i = 1; i <= 10; i++) { ed.canvas.dispatchEvent(ev("pointermove", 100 + 40 * i, y)); await wait(16); }
    ed.canvas.dispatchEvent(ev("pointerup", 500, y));
    await wait(100);
};
await stroke(100);                               // the ring tip along y = 100
ed.setBrushTip("");
await stroke(300);                               // the round dab along y = 300
const layer = ed.layers.find((l) => l.id === L.id);
const d = layer.canvas.getContext("2d").getImageData(0, 0, 600, 400).data;
const alpha = (x, y) => d[(y * 600 + x) * 4 + 3];
const cover = (y0, y1) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < 600; x++) if (alpha(x, y) > 0) n++; return n; };
const out = { ringCentre: alpha(300, 100), ringBand: alpha(300, 100 - 30), roundCentre: alpha(300, 300), ringCover: cover(60, 140), roundCover: cover(260, 340) };
if (out.roundCentre < 250) throw new Error("the round dab did not paint: " + JSON.stringify(out));
if (out.ringBand < 250) throw new Error("the ring tip's band did not land: " + JSON.stringify(out));
if (out.ringCentre > 5) throw new Error("the ring tip filled its hollow centre (stamped like a round dab?): " + JSON.stringify(out));
if (out.ringCover >= out.roundCover) throw new Error("a hollow ring covers less than a full dab: " + JSON.stringify(out));
window.__bLayer = L.id;
return out;
"""),
    ("erase_with_a_tip", """
const ed = ednow();
const layer = ed.layers.find((l) => l.id === window.__bLayer);
const g = layer.canvas.getContext("2d");
g.globalCompositeOperation = "source-over"; g.fillStyle = "#00ff00"; g.fillRect(0, 0, 600, 400);
layer.dirty = true; ed.touchSource(layer.canvas); ed.draw();
ed.setTool("erase");
ed.brushSize = 80; ed.eraseHardness = 1;
ed.setBrushTip(window.__bIds[0]);
const rect = ed.canvas.getBoundingClientRect();
const client = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
const ev = (type, ix, iy) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 8, pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy)));
ed.canvas.dispatchEvent(ev("pointerdown", 100, 200));
for (let i = 1; i <= 10; i++) { ed.canvas.dispatchEvent(ev("pointermove", 100 + 40 * i, 200)); await wait(16); }
ed.canvas.dispatchEvent(ev("pointerup", 500, 200));
await wait(100);
const d = layer.canvas.getContext("2d").getImageData(0, 0, 600, 400).data;
const alpha = (x, y) => d[(y * 600 + x) * 4 + 3];
const out = { centre: alpha(300, 200), band: alpha(300, 170), far: alpha(300, 60) };
if (out.band > 5) throw new Error("the ring band was not erased: " + JSON.stringify(out));
if (out.centre < 250 || out.far < 250) throw new Error("the eraser with a tip cleared outside the tip: " + JSON.stringify(out));
ed.setTool("paint");
return out;
"""),
    ("ring_is_the_tips_box_and_the_thumbnail_shows_it", """
const ed = ednow();
ed.setTool("paint"); ed.brushSize = 60; ed.setBrushTip(window.__bIds[1]);   // the 24 x 12 bar: a 60 x 30 box
ed.hover = [50, 50];
const cv = document.createElement("canvas"); cv.width = 100; cv.height = 100;
const x = cv.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, 100, 100);
ed.drawBrushRing(x, 1);
const d = x.getImageData(0, 0, 100, 100).data;
const dark = (px, py) => d[(py * 100 + px) * 4 + 1] < 128;   // the green channel: the paint colour is red, the halo black, the ground white
const near = (px, py) => dark(px, py) || dark(px, py - 1) || dark(px, py + 1) || dark(px - 1, py) || dark(px + 1, py);   // the coloured line sits on the dark halo
const out = { top: near(50, 35), side: near(20, 50), inside: near(50, 50), circleTop: near(50, 20) };
ed.hover = null;
if (!out.top || !out.side) throw new Error("no box edge at 15 / 30 px from the centre: " + JSON.stringify(out));
if (out.inside || out.circleTop) throw new Error("the ring is still a circle: " + JSON.stringify(out));
const td = ed.tipThumb.getContext("2d").getImageData(0, 0, 48, 24).data;
let lit = 0; for (let i = 3; i < td.length; i += 4) if (td[i] > 0) lit++;
if (lit < 50) throw new Error("the thumbnail is empty");
return { ...out, thumbPixels: lit };
"""),
    ("commands", """
const ed = ednow();
const before = await c("list_brush_tips", { doc: window.__bDoc });
if (before.tips.length < 4 || !before.tips.some((t) => t.name === "Ring Brush")) throw new Error("list " + JSON.stringify(before.tips.map((t) => t.name)));
const r = await c("set_brush", { tip: "Bar Brush", size: 66, spacing: 50, follow: true, opacity: 80, doc: window.__bDoc });
if (r.active !== window.__bIds[1] || r.size !== 66 || r.opacity !== 80 || !r.follow) throw new Error("set_brush " + JSON.stringify(r));
const bar = ed.brushTip();
if (Math.abs(bar.spacing - 0.5) > 1e-9 || ed.spacingCtl.value !== "50") throw new Error("spacing " + bar.spacing + " slider " + ed.spacingCtl.value);
let err = null;
try { await c("set_brush", { tip: "nothing like this", doc: window.__bDoc }); } catch (e) { err = String(e.message || e); }
if (!err || !/no brush tip/.test(err)) throw new Error("unknown tip accepted: " + err);
const back = await c("set_brush", { tip: "round", follow: false, opacity: 100, doc: window.__bDoc });
if (back.active !== "round" || ed.brushTip()) throw new Error("round not restored");
return { listed: before.tips.length, set: [r.active === window.__bIds[1], r.size, r.opacity], spacing: bar.spacing };
"""),
]

RELOAD_CHECK = """
const ed = window.editor;
const names = host.brushLibrary.map((t) => t.name);
const ids = host.brushLibrary.map((t) => t.id);
const bar = host.brushLibrary.find((t) => t.id === window.__bId1);
const options = Array.from(ed.tipSel.options).map((o) => o.textContent);
if (!window.__bIds0.every((id) => ids.includes(id))) throw new Error("tips lost over the reload: " + JSON.stringify(names));
if (!bar || Math.abs(bar.spacing - 0.5) > 1e-9) throw new Error("the spacing change did not persist: " + (bar && bar.spacing));
if (!bar.saved) throw new Error("a loaded tip is not marked saved");
if (!options.includes("Ring Brush")) throw new Error("the select does not list the stored tips: " + options);
// alpha survived the PNG round trip: the ring's hollow centre
const ringTip = host.brushLibrary.find((t) => t.id === window.__bIds0[0]);
const px = ringTip.canvas.getContext("2d").getImageData(16, 16, 1, 1).data[3];
if (px !== 0) throw new Error("the ring's centre is not transparent after the reload: " + px);
return { names, restored: window.__bIds0.length, barSpacing: bar.spacing };
"""

REMOVE = """
const ed = window.editor;
const before = host.brushLibrary.length;
ed.setBrushTip(window.__bIds0[0]);
const ok = ed.removeBrushTip(window.__bIds0[0]);
if (!ok || ed.brushTip()) throw new Error("remove failed");
for (const id of window.__bIds0.slice(1)) ed.removeBrushTip(id);
await host.saveBrushTips();
if (host.brushLibrary.length !== before - 3) throw new Error("library after remove " + host.brushLibrary.length);
return { before, after: host.brushLibrary.length };
"""

AFTER_REMOVE = """
const gone = window.__bIds0.every((id) => !host.brushLibrary.some((t) => t.id === id));
if (!gone) throw new Error("removed tips came back after the reload");
return { library: host.brushLibrary.length };
"""


async def main():
    sys.stdout.reconfigure(encoding="utf-8")
    print("== reader (node)")
    r = subprocess.run(["node", os.path.join(HERE, "brush_test.js"), OUT], capture_output=True, text=True, encoding="utf-8")
    print(r.stdout.strip())
    if r.returncode != 0:
        print(r.stderr.strip())
        print("RESULT FAIL (reader)")
        return False
    abr = os.path.join(OUT, "synthetic_v6.abr")

    async def run(cdp):
        ev = cdp.eval
        await ev("(() => { window.__log = window.__log || []; return 1; })()")
        await ev("window.__abrPath = %s; 1" % json.dumps(abr))
        failed = 0
        print("== app")
        for name, body in STEPS:
            try:
                res = await ev(PRE % body, timeout=120)
                print(f"PASS {name}: {json.dumps(res)[:300]}")
            except Exception as err:  # noqa: BLE001
                failed += 1
                print(f"FAIL {name}: {err}")
                try:
                    print("  console:", (await ev("JSON.stringify((window.__log || []).slice(-8))"))[:1200])
                except Exception:  # noqa: BLE001
                    pass
                break
        if failed:
            print("RESULT FAIL")
            return False
        # persistence: the ids survive a reload of the renderer (the main process keeps the files)
        ids = await ev("JSON.stringify(window.__bIds)")
        await ev("location.reload(), 1")
        await asyncio.sleep(6)
        try:
            await ev("window.__bIds0 = %s; window.__bId1 = window.__bIds0[1]; 1" % ids)
            res = await ev(PRE % RELOAD_CHECK, timeout=60)
            print(f"PASS persistence_over_reload: {json.dumps(res)[:300]}")
            res = await ev(PRE % REMOVE, timeout=60)
            print(f"PASS remove: {json.dumps(res)}")
            await ev("location.reload(), 1")
            await asyncio.sleep(6)
            await ev("window.__bIds0 = %s; 1" % ids)
            res = await ev(PRE % AFTER_REMOVE, timeout=60)
            print(f"PASS removed_stays_removed: {json.dumps(res)}")
        except Exception as err:  # noqa: BLE001
            print(f"FAIL persistence: {err}")
            print("RESULT FAIL")
            return False
        print("RESULT PASS")
        return True

    return await session(run)


if __name__ == "__main__":
    sys.exit(0 if asyncio.run(main()) else 1)
