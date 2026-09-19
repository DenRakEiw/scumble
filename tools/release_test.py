"""The release of a stroke on the user's usual document, with real mouse events (docs/BUGS.md: "Releasing an erase
stroke is its own stutter"). A measurement like native_test.py, not a gate: it always ends with RESULT.

No ComfyUI, no key. Start the app offline, tiles on (the default), the window in front and no real mouse over it:

    ./node_modules/.bin/electron . --remote-debugging-port=9555 --no-comfy
    python tools/release_test.py [15000x10000] [--rounds 2] [row ...]

The document is native_test.py's (a picture written per tile, opened from its PNG through the pool reader, a full-size
paint layer), plus a 5,000 x 3,500 result layer matched 80 % to its surroundings and a film look over everything: what
the user works on. Each row drives a stroke through Input.dispatchMouseEvent (press, 60 moves 8 ms apart, a rest of
0.4 s with the button down, release) and reports, from the release until the picture has settled (the chains landed
and no gap above 8 ms for a second):

  release    the longest time the window did not answer (a MessageChannel heartbeat), the gaps above 16 ms, and the
             pointer-up task itself (`onPointerUp`), split into commitStroke / markLayerChanged / draw
  stroke     the longest gap while the button was down (the dabs and their frames), for comparison
  settle     how long until settled, the frames drawn, the chain landings
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402
import native_test as N  # noqa: E402

ARGS = sys.argv[1:]
ROUNDS = 2
if "--rounds" in ARGS:
    i = ARGS.index("--rounds")
    ROUNDS = int(ARGS[i + 1])
    del ARGS[i:i + 2]
JSON_OUT = None
if "--json" in ARGS:
    i = ARGS.index("--json")
    JSON_OUT = ARGS[i + 1]
    del ARGS[i:i + 2]
SIZE = next((a for a in ARGS if "x" in a.lower() and a[0].isdigit()), "15000x10000")
ONLY = [a for a in ARGS if not a[0].isdigit() and not a.startswith("-")]

# name, the layer, the tool, the view ("fit" or a scale), the brush size in image pixels, the stroke from/to in image pixels
ROWS = [
    ("erase_matched_fit", "Matched", "erase", "fit", 400, (6000, 4600), (9500, 5200)),
    ("erase_matched_1to1", "Matched", "erase", 1.0, 120, (7200, 4700), (7700, 4900)),
    ("paint_matched_fit", "Matched", "paint", "fit", 400, (6000, 4600), (9500, 5200)),
    ("erase_paint_fit", "Paint", "erase", "fit", 400, (1500, 1500), (12000, 8000)),
]

SETUP = r"""
// the user's usual document on top of native_test's: a matched result layer and a film look
if (!ed.layers.some((l) => l.name === "Matched")) {
    const w = 5000, h = 3500, c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, "hsl(20,70%,55%)"); g.addColorStop(1, "hsl(60,60%,35%)");
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    for (let k = 0; k < 40; k++) { x.fillStyle = `hsl(${(k * 41) % 360},60%,50%)`; x.fillRect((k * 613) % w, (k * 389) % h, w / 20, h / 20); }
    x.globalCompositeOperation = "destination-in";
    const rg = x.createRadialGradient(w / 2, h / 2, w * 0.3, w / 2, h / 2, w * 0.5); rg.addColorStop(0, "rgba(0,0,0,1)"); rg.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = rg; x.fillRect(0, 0, w, h);
    const l = ed.addLayer({ name: "Matched", kind: "result", px: ed.pixels.Layer.fromCanvas(c), x: 5000, y: 3000, w, h, dirty: true });
    c.width = 1;
    l.match = { strength: 80, source: "surroundings" };
    ed.markMatchChanged(l);
}
if (!ed.layers.some((l) => l.kind === "filter")) await run("add_filter", { doc: window.__n1doc, type: "film.look", params: { preset: "portra400" } });
await run("select_none", { doc: window.__n1doc });
ed.clearUndo();
ed.renderLayers(); ed.fitView(); ed.draw();
await ed.mipsSettled();
return { layers: ed.layers.map((l) => [l.name, l.kind, l.w, l.h]) };
"""

PREP = r"""
const o = __O__;
const L = ed.layers.find((l) => l.name === o.layer);
if (!L) throw new Error("no layer " + o.layer);
ed.activeLayerId = L.id;
ed.renderLayers();
ed.setTool(o.tool);
ed.brushSize = o.size; ed.hardness = 0.43; ed.eraseHardness = 0.43; ed.brushOpacity = 1; ed.color = "#20a0ff"; ed.brushTipId = null;
if (o.view === "fit") ed.fitView();
else {
    const cx = (o.a[0] + o.b[0]) / 2, cy = (o.a[1] + o.b[1]) / 2;
    ed.view.angle = 0; ed.view.scale = o.view; ed._fitted = false;
    ed.view.x = Math.round(ed.canvas.width / 2 - cx * o.view);
    ed.view.y = Math.round(ed.canvas.height / 2 - cy * o.view);
}
ed.drawSoon();
await wait(200);
await ed.mipsSettled();
await wait(500);
const raf = await new Promise((r) => { const t = setTimeout(() => r(false), 3000); requestAnimationFrame(() => { clearTimeout(t); r(true); }); });
if (!raf) throw new Error("requestAnimationFrame does not fire: the window is hidden; bring it to the front");
const rect = ed.canvas.getBoundingClientRect();
const k = rect.width / ed.canvas.width;
const pts = [];
for (let i = 0; i <= o.moves; i++) {
    const [sx, sy] = ed.imageToScreen(o.a[0] + (o.b[0] - o.a[0]) * i / o.moves, o.a[1] + (o.b[1] - o.a[1]) * i / o.moves);
    pts.push([rect.left + sx * k, rect.top + sy * k]);
}
// the probes: a heartbeat on a MessageChannel (no 4 ms clamp), frames, the pointer-up and the release's own calls
const P = window.__rel = { gaps: [], frames: [], up: null, calls: [], on: true, last: performance.now() };
const ch = new MessageChannel();
ch.port1.onmessage = () => { const t = performance.now(); const g = t - P.last; if (g > 4) P.gaps.push([P.last, g]); P.last = t; if (P.on) setTimeout(() => ch.port2.postMessage(0), 1); };
ch.port2.postMessage(0);
const frame = (t) => { P.frames.push(performance.now()); if (P.on) requestAnimationFrame(frame); };
requestAnimationFrame(frame);
const upL = (e) => { if (P.up == null) P.up = performance.now(); };
window.addEventListener("pointerup", upL, true);
P.unhook = [() => window.removeEventListener("pointerup", upL, true)];
for (const name of ["onPointerUp", "commitStroke", "markLayerChanged", "draw", "sampledMatchStats", "filteredCanvas"]) {
    const orig = ed[name];
    if (typeof orig !== "function") continue;
    ed[name] = function (...a) { const t0 = performance.now(); try { return orig.apply(this, a); } finally { P.calls.push([name, t0, performance.now() - t0]); } };
    P.unhook.push(() => { delete ed[name]; });
}
const S = (await import("./editor/inpaint_tiles.js")).chainScheduler;
P.chains0 = S && S().stats ? S().stats(true) : null;
return { pts, scale: ed.view.scale, layer: [L.x, L.y, L.w, L.h], active: ed.activeLayerId === L.id };
"""

MEASURE = r"""
const P = window.__rel;
const upAt = P.up;
// settled: the chains in and no gap above 8 ms for a second
await ed.mipsSettled();
let quietSince = performance.now();
const t0 = performance.now();
while (performance.now() - t0 < 20000) {
    await wait(100);
    const recent = P.gaps.filter(([at, g]) => at + g > quietSince && g > 8);
    if (recent.length) quietSince = performance.now();
    else if (performance.now() - quietSince > 1000) break;
}
P.on = false;
for (const u of P.unhook) u();
const settledAt = quietSince;
const after = P.gaps.filter(([at, g]) => at + g >= upAt - 1 && at <= settledAt);
const during = P.gaps.filter(([at, g]) => at + g < upAt - 1);
const longest = (list) => list.reduce((m, [, g]) => Math.max(m, g), 0);
const calls = {};
for (const [n, at, ms] of P.calls) { if (at < upAt - 1) continue; const c = calls[n] || (calls[n] = { n: 0, ms: 0, max: 0 }); c.n++; c.ms += ms; c.max = Math.max(c.max, ms); }
for (const c of Object.values(calls)) { c.ms = +c.ms.toFixed(1); c.max = +c.max.toFixed(1); }
const up = P.calls.find(([n, at]) => n === "onPointerUp" && at >= upAt - 1);
const inUp = (name) => +P.calls.filter(([n, at, ms]) => n === name && up && at >= up[1] && at + ms <= up[1] + up[2] + 0.01).reduce((s, [, , ms]) => s + ms, 0).toFixed(1);
const framesAfter = P.frames.filter((t) => t >= upAt && t <= settledAt);
let frameGap = 0;
for (let i = 1; i < framesAfter.length; i++) frameGap = Math.max(frameGap, framesAfter[i] - framesAfter[i - 1]);
return {
    release: { longest: Math.round(longest(after)), over16: after.filter(([, g]) => g > 16).map(([at, g]) => [Math.round(at - upAt), Math.round(g)]).slice(0, 12), pointerUp: up ? Math.round(up[2]) : null, commit: inUp("commitStroke"), markChanged: inUp("markLayerChanged"), draw: inUp("draw") },
    stroke: { longest: Math.round(longest(during)) },
    settle: { ms: Math.round(settledAt - upAt), frames: framesAfter.length, longestFrameGap: Math.round(frameGap) },
    calls,
    active: ed.activeLayer() && ed.activeLayer().name,
    status: ed.status,
};
"""


def pre(w, h, body):
    return N.PRE.replace("__W__", w).replace("__H__", h).replace("__BODY__", body)


async def run_all(c):
    w, h = SIZE.lower().split("x")
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); const h = await import('./editor/host.js'); window.__host = h.host; window.__shell = await import('./shell.js'); return 1; })()")
    connected = await c.eval("(async () => { const s = await window.scumble.comfy.status(); return s && s.state; })()")
    if connected in ("connected", "missing-node"):
        print("this instance is connected to ComfyUI: start it with --no-comfy")
        print("RESULT refused")
        return False
    print(await c.eval(N.PROBES))
    rows = dict((n, b) for n, _, b in N.ROWS)
    for name in ("build_the_file", "open_the_file", "add_the_paint_layer"):
        r = await c.eval(pre(w, h, rows[name]), timeout=3600)
        print("[ok]", name, json.dumps(r)[:300])
    print("[ok] setup", json.dumps(await c.eval(pre(w, h, SETUP), timeout=600)))
    results = {}
    for name, layer, tool, view, size, a, b in ROWS:
        if ONLY and name not in ONLY:
            continue
        results[name] = []
        for rnd in range(ROUNDS):
            o = {"layer": layer, "tool": tool, "view": view, "size": size, "a": a, "b": b, "moves": 60}
            info = await c.eval(pre(w, h, PREP.replace("__O__", json.dumps(o))), timeout=300)
            pts = info["pts"]
            await c.call("Page.bringToFront")
            await c.call("Input.dispatchMouseEvent", type="mouseMoved", x=pts[0][0], y=pts[0][1], button="none", buttons=0, pointerType="mouse")
            await asyncio.sleep(0.3)
            await c.call("Input.dispatchMouseEvent", type="mousePressed", x=pts[0][0], y=pts[0][1], button="left", buttons=1, clickCount=1, pointerType="mouse")
            for p in pts[1:]:
                await asyncio.sleep(0.008)
                await c.call("Input.dispatchMouseEvent", type="mouseMoved", x=p[0], y=p[1], button="left", buttons=1, pointerType="mouse")
            await asyncio.sleep(0.4)
            await c.call("Input.dispatchMouseEvent", type="mouseReleased", x=pts[-1][0], y=pts[-1][1], button="left", buttons=0, clickCount=1, pointerType="mouse")
            m = await c.eval(pre(w, h, MEASURE), timeout=120)
            m["scale"] = round(info["scale"], 4)
            results[name].append(m)
            print(f"== {name} #{rnd + 1}: release longest {m['release']['longest']} ms (pointer-up {m['release']['pointerUp']}: commit {m['release']['commit']}, markChanged {m['release']['markChanged']}, draw {m['release']['draw']}), stroke longest {m['stroke']['longest']} ms, settled after {m['settle']['ms']} ms ({m['settle']['frames']} frames, longest frame gap {m['settle']['longestFrameGap']} ms), active {m['active']}")
            print("   gaps over 16 ms after the release [ms after, ms long]:", m["release"]["over16"])
            print("   calls:", json.dumps(m["calls"]))
            # the next round starts from the same pixels
            await c.eval(pre(w, h, "await ed.undoStep(); await ed.mipsSettled(); await wait(300); return 1;"), timeout=120)
    await c.eval(pre(w, h, "const id = window.__n1doc; window.__n1doc = null; await run('close_document', { doc: id, force: true }); return 1;"), timeout=120)
    if JSON_OUT:
        with open(JSON_OUT, "w", encoding="utf-8", newline=chr(10)) as f:
            json.dump(results, f, indent=1)
    print("\nRESULT measured")
    return True


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
