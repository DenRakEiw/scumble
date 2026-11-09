"""30,000 x 20,000 before/after probe for K8 review findings K8-T1 and K8-T8.

Runs on fresh offline instances on port 9621 (tiles on) for both 9fd93524 (before) and the branch (after):
  1. write_the_png_from_tiles
  2. open_through_the_stream_reader
  3. the_screen_pan_zoom_and_a_stroke
  4. a_matched_layer_a_film_look_and_what_is_refused (printing the sampled pixel, the base pixel, and L1 distance)
  5. the_state_for_the_autosave
  6. a_restore_from_the_state
  7. close
"""
import asyncio
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from cdp import session  # noqa: E402
import huge_test  # noqa: E402

MATCHED_DIAG = """
const ed = ednow(window.__hg);
const { FILTERS } = await import("./editor/inpaint_filters.js");
const c = document.createElement("canvas"); c.width = 2048; c.height = 2048;
const x = c.getContext("2d"); const g = x.createLinearGradient(0, 0, 2048, 2048); g.addColorStop(0, "#c08040"); g.addColorStop(1, "#4060c0"); x.fillStyle = g; x.fillRect(0, 0, 2048, 2048);
const res = ed.addLayer({ name: "Result", kind: "result", px: ed.pixels.Layer.fromCanvas(c), x: Math.round(W / 4), y: Math.round(H / 4), w: 2048, h: 2048, dirty: true });
res.match = { strength: 60, source: "surroundings" };
ed.markMatchChanged(res);
const fx = ed.addFilterLayer(FILTERS["film.look"] ? "film.look" : "grain");
const plan = ed.bandPlan({ forRun: true });
if (!plan || !plan.inexact) throw new Error("the plan for a matched layer on a huge document is " + JSON.stringify(plan));
let saved = null;
const was = host.saveExport;
host.saveExport = async (blob, name) => { saved = { blob, name }; return { path: "memory:" + name }; };
const out = { plan, filterUsed: fx.filter };
try {
    ed.saveFormatSel.value = "png";
    const t = await timed(() => ed.exportImage({ download: false }));
    if (!saved) throw new Error("the export saved nothing: " + ed.status);
    out.png = { ms: t.ms, blocked: t.blocked, MB: +(saved.blob.size / 1048576).toFixed(1) };
    const ty = Math.floor((H / 4 + 1024) / 256);
    let band = null;
    await PNG.readPng(saved.blob, { onRows: (rgba, y0) => { if (y0 / 256 === ty) band = rgba; } });
    const X = Math.round(W / 4) + 1024, o = (X) * 4, base = colourAt(X, ty * 256);
    const sample = Array.from(band.subarray(o, o + 4));
    const l1 = Math.abs(sample[0] - base[0]) + Math.abs(sample[1] - base[1]) + Math.abs(sample[2] - base[2]);
    const resRaw = Array.from(res.px.readRect(X - res.x, ty * 256 - res.y, 1, 1).data);
    const st = ed.sampledMatchStats(res, true, false, false);
    out.sample = sample;
    out.base = base;
    out.l1 = l1;
    out.passedGate = l1 >= 12;
    out.resRaw = resRaw;
    out.matchStats = st;
} finally {
    host.saveExport = was;
    ed.saveFormatSel.value = "png";
    ed.removeLayer(fx.id);
    ed.removeLayer(res.id);
}
return out;
"""

STEP_NAMES = [
    "write_the_png_from_tiles",
    "open_through_the_stream_reader",
    "the_screen_pan_zoom_and_a_stroke",
    "a_matched_layer_a_film_look_and_what_is_refused",
    "the_state_for_the_autosave",
    "a_restore_from_the_state",
    "close",
]


async def run_probe(c):
    arm = sys.argv[1] if len(sys.argv) > 1 else "after"
    out_json = sys.argv[2] if len(sys.argv) > 2 else None
    helpers = huge_test.HELPERS.replace("__W__", "30000").replace("__H__", "20000")
    step_map = dict(huge_test.STEPS)
    step_map["a_matched_layer_a_film_look_and_what_is_refused"] = MATCHED_DIAG
    results = {"arm": arm, "steps": {}}
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); window.__host = (await import('./editor/host.js')).host; await import('./shell.js'); return 1; })()")
    for name in STEP_NAMES:
        body = step_map[name]
        res = await c.eval(huge_test.PRE % (helpers, body), timeout=1800)
        results["steps"][name] = res
        print(f"[{arm}] {name}: {json.dumps(res)}", flush=True)
    if out_json:
        with open(out_json, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2)
    return True


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_probe)) else 1)
