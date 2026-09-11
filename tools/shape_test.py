"""The shape tool: rectangle, ellipse, polygon, polyline, Bezier and freehand.

No ComfyUI, no API key. Drives the tool the way the pointer handler does (image coordinates
in, one gesture per step) and reads the pixels back: the fill lands inside and not outside,
the outline uses its own colour and width, an open line is stroked and not filled, the
selection clips the shape, and one shape is one undo step.

    python tools/shape_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

# One drag gesture, the way onPointerDown / onPointerMove / onPointerUp run it.
DRAG = """
const drag = (ed, x0, y0, x1, y1, e = {}) => {
    ed.shapePointerDown(x0, y0, e, false);
    if (!ed.pointer) throw new Error("the tool refused the gesture: " + ed.status);
    ed.shapeDab(ed.pointer, x1, y1, e);
    const p = ed.pointer;
    const box = ed.strokeRect(p, p.layer.canvas);
    ed.commitStroke(p);
    ed.markLayerChanged(p.layer, box);
    ed.pointer = null;
    return p.layer;
};
const clickPoints = (ed, pts, close) => {
    for (const [x, y] of pts) { ed.shapePointerDown(x, y, { detail: 1 }, false); ed.pointer = null; }
    ed.finishShape(close);
};
const px = (ed, l, x, y) => Array.from(l.canvas.getContext("2d").getImageData(Math.round(x - l.x), Math.round(y - l.y), 1, 1).data);
"""

STEPS = [
    ("setup", """
const d = await run("new_document");
window.__sh = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { doc: d.id, width: 800, height: 600, color: "#ffffff" });
ed.setTool("shape");
if (ed.tool !== "shape") throw new Error("the shape tool is not selectable");
const bar = ed.optsBar;
if (!bar || bar.hidden) throw new Error("the options bar stays hidden for the shape tool");
const kinds = Array.from(bar.querySelectorAll("select")).map((s) => Array.from(s.options).map((o) => o.value).join("|"));
if (!kinds.some((k) => k.includes("bezier"))) throw new Error("the kind select is missing: " + kinds.join(" / "));
return { tool: ed.tool, kinds: kinds.find((k) => k.includes("bezier")).split("|") };
"""),
    ("rectangle_fills_inside_only", """
const ed = ednow(window.__sh);
%(drag)s
ed.color = "#ff0000";
ed.shapeOpts = { kind: "rectangle", fill: true, stroke: false, width: 4, radius: 0, color: "#000000" };
const l = drag(ed, 100, 100, 300, 250);
const inside = px(ed, l, 200, 175), outside = px(ed, l, 400, 400), corner = px(ed, l, 102, 102);
if (inside[0] < 200 || inside[1] > 60 || inside[3] < 250) throw new Error("the fill did not land: " + inside);
if (outside[3] !== 0) throw new Error("it painted outside the rectangle: " + outside);
if (corner[3] < 250) throw new Error("the corner is not filled: " + corner);
return { inside, outside, layer: l.name };
"""),
    ("rounded_corner_stays_empty", """
const ed = ednow(window.__sh);
%(drag)s
await run("undo", { doc: window.__sh });
ed.shapeOpts = { kind: "rectangle", fill: true, stroke: false, width: 4, radius: 60, color: "#000000" };
const l = drag(ed, 100, 100, 300, 250);
const corner = px(ed, l, 104, 104), middle = px(ed, l, 200, 175);
if (corner[3] > 40) throw new Error("the radius did not round the corner: " + corner);
if (middle[3] < 250) throw new Error("the middle is not filled: " + middle);
await run("undo", { doc: window.__sh });
return { corner, middle };
"""),
    ("ellipse_is_round", """
const ed = ednow(window.__sh);
%(drag)s
ed.shapeOpts = { kind: "ellipse", fill: true, stroke: false, width: 4, radius: 0, color: "#000000" };
const l = drag(ed, 100, 100, 300, 250);
const middle = px(ed, l, 200, 175), corner = px(ed, l, 105, 105);
if (middle[3] < 250) throw new Error("the ellipse is not filled: " + middle);
if (corner[3] > 40) throw new Error("the corner of the box should stay empty: " + corner);
await run("undo", { doc: window.__sh });
return { middle, corner };
"""),
    ("outline_has_its_own_colour_and_width", """
const ed = ednow(window.__sh);
%(drag)s
ed.color = "#ff0000";
ed.shapeOpts = { kind: "rectangle", fill: false, stroke: true, width: 20, radius: 0, color: "#0000ff" };
const l = drag(ed, 100, 100, 300, 250);
const onEdge = px(ed, l, 200, 100), inside = px(ed, l, 200, 175);
if (onEdge[2] < 200 || onEdge[0] > 60) throw new Error("the outline is not the outline colour: " + onEdge);
if (inside[3] !== 0) throw new Error("fill was off but the inside is painted: " + inside);
const above = px(ed, l, 200, 93), far = px(ed, l, 200, 130);
if (above[3] < 200) throw new Error("a width of 20 should reach about 10 px outwards: " + above);
if (far[3] !== 0) throw new Error("the outline is far too wide: " + far);
await run("undo", { doc: window.__sh });
return { onEdge, inside, above, far };
"""),
    ("polygon_closes_and_fills", """
const ed = ednow(window.__sh);
%(drag)s
ed.color = "#00aa00";
ed.shapeOpts = { kind: "polygon", fill: true, stroke: false, width: 4, radius: 0, color: "#000000" };
clickPoints(ed, [[400, 100], [600, 100], [500, 300]], true);
const l = ed.activeLayer();
const middle = px(ed, l, 500, 160), outside = px(ed, l, 410, 280);
if (middle[1] < 120 || middle[3] < 250) throw new Error("the triangle is not filled: " + middle);
if (outside[3] !== 0) throw new Error("it filled outside the triangle: " + outside);
await run("undo", { doc: window.__sh });
if (px(ed, l, 500, 160)[3] !== 0) throw new Error("one shape should be one undo step");
return { middle, outside, status: ed.status };
"""),
    ("polyline_is_stroked_not_filled", """
const ed = ednow(window.__sh);
%(drag)s
ed.shapeOpts = { kind: "polyline", fill: true, stroke: true, width: 10, radius: 0, color: "#000000" };
clickPoints(ed, [[400, 100], [600, 100], [500, 300]], false);
const l = ed.activeLayer();
const onLine = px(ed, l, 500, 100), insideTriangle = px(ed, l, 500, 160);
if (onLine[3] < 200) throw new Error("the line was not drawn: " + onLine);
if (insideTriangle[3] > 20) throw new Error("an open line must not be filled: " + insideTriangle);
await run("undo", { doc: window.__sh });
return { onLine, insideTriangle };
"""),
    ("bezier_bulges_where_the_handle_points", """
const ed = ednow(window.__sh);
%(drag)s
ed.shapeOpts = { kind: "bezier", fill: true, stroke: false, width: 4, radius: 0, color: "#000000" };
// three points, the middle one with a handle that pulls the curve upwards
ed.shapePointerDown(400, 300, { detail: 1 }, false);
ed.shapePointerDown(500, 300, { detail: 1 }, false);
if (!ed.shapeDrag) throw new Error("a Bezier point does not take a handle");
ed.onPointerMove({ clientX: 0, clientY: 0, pointerType: "mouse" });   // ignored without a drag target
const q = ed.shapePoints[ed.shapeDrag.index];
q.hx = 60; q.hy = -60;
ed.shapeDrag = null;
ed.shapePointerDown(600, 300, { detail: 1 }, false);
ed.finishShape(true);
const l = ed.activeLayer();
const bulge = px(ed, l, 520, 285);
if (bulge[3] < 200) throw new Error("the curve did not bulge towards the handle: " + bulge);
await run("undo", { doc: window.__sh });
return { bulge, status: ed.status };
"""),
    ("freehand_follows_the_path", """
const ed = ednow(window.__sh);
%(drag)s
ed.shapeOpts = { kind: "freehand", fill: false, stroke: true, width: 12, radius: 0, color: "#111111" };
ed.shapePointerDown(120, 400, {}, false);
const p = ed.pointer;
for (let x = 120; x <= 320; x += 4) ed.shapeDab(p, x, 400 + Math.round(Math.sin((x - 120) / 30) * 30), {});
const box = ed.strokeRect(p, p.layer.canvas);
ed.commitStroke(p); ed.markLayerChanged(p.layer, box); ed.pointer = null;
const l = p.layer;
const onPath = px(ed, l, 120, 400), off = px(ed, l, 220, 500);
if (onPath[3] < 200) throw new Error("the freehand path is not there: " + onPath);
if (off[3] !== 0) throw new Error("it painted where the path never went: " + off);
await run("undo", { doc: window.__sh });
return { onPath, off, points: p.path.length };
"""),
    ("the_selection_clips_the_shape", """
const ed = ednow(window.__sh);
%(drag)s
await run("select_rect", { doc: window.__sh, x: 100, y: 100, width: 100, height: 150 });
ed.color = "#ff00ff";
ed.shapeOpts = { kind: "rectangle", fill: true, stroke: false, width: 4, radius: 0, color: "#000000" };
const l = drag(ed, 100, 100, 300, 250);
const inSel = px(ed, l, 150, 175), outSel = px(ed, l, 250, 175);
if (inSel[3] < 250) throw new Error("nothing inside the selection: " + inSel);
if (outSel[3] !== 0) throw new Error("the shape ran past the selection: " + outSel);
await run("undo", { doc: window.__sh });
await run("select_none", { doc: window.__sh });
return { inSel, outSel };
"""),
    ("escape_and_backspace_take_points_back", """
const ed = ednow(window.__sh);
ed.shapeOpts = { kind: "polygon", fill: true, stroke: false, width: 4, radius: 0, color: "#000000" };
ed.shapePointerDown(400, 100, { detail: 1 }, false); ed.pointer = null;
ed.shapePointerDown(600, 100, { detail: 1 }, false); ed.pointer = null;
if (ed.shapePoints.length !== 2) throw new Error("points not collected: " + JSON.stringify(ed.shapePoints));
ed.onKey({ key: "Backspace", preventDefault() {}, target: ed.root });
if (ed.shapePoints.length !== 1) throw new Error("Backspace did not remove a point");
ed.cancelShape();
if (ed.shapePoints) throw new Error("Escape did not cancel the shape");
ed.setTool("paint");
return { cancelled: true };
"""),
    ("cleanup", """
try { await run("close_document", { doc: window.__sh, force: true }); } catch (_) { /* gone */ }
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
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); window.__host = (await import('./editor/host.js')).host; await import('./shell.js'); return 1; })()")
    ok = True
    for name, body in STEPS:
        try:
            res = await c.eval(PRE % (body % {"drag": DRAG}), timeout=240)
            print("[ok] %s: %s" % (name, json.dumps(res)[:280]))
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] %s: %s" % (name, err))
            break
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:220])
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
