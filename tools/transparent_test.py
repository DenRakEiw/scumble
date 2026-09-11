"""Transparent results: the OpenAI `background` parameter end to end.

No ComfyUI, no API key. The first step runs the OpenAI adapter's own helpers in Node (the
size rules of each model, the parameter set `common()` builds, and that a transparent JPEG
becomes a PNG). The rest drives the app against the loopback provider, which answers a run
with `background: "transparent"` with an opaque disc on a transparent ground: the result
layer has to keep that alpha instead of the selection's composite mask, an ordinary run has
to be unchanged, and "Generate new" has to put a transparent base image in.

    python tools/transparent_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555
"""
import asyncio
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NODE_CHECK = r"""
const a = require("./electron/main/providers/openai.js");
const out = {};
const fail = [];

// GPT Image 2.5: free size, multiples of 16, at most 3840 an edge, 655,360 to 8,294,400 px
out.flare_small = a._sizeFor("gpt-image-2.5-flare", 320, 240);
out.flare_plain = a._sizeFor("gpt-image-2.5-flare", 1024, 768);
out.flare_huge = a._sizeFor("gpt-image-2.5-flare", 8000, 6000);
out.flare_long = a._sizeFor("gpt-image-2.5-flare", 4000, 500);
out.two = a._sizeFor("gpt-image-2", 1600, 1200);
out.one = a._sizeFor("gpt-image-1", 1600, 1200);

const px = (s) => s.split("x").map(Number).reduce((x, y) => x * y);
const edges = (s) => s.split("x").map(Number);
for (const [k, v] of Object.entries(out)) {
    if (k === "one") continue;
    const [w, h] = edges(v);
    if (w % 16 || h % 16) fail.push(k + " not a multiple of 16: " + v);
    if (Math.max(w, h) > 3840) fail.push(k + " over 3840: " + v);
}
if (px(out.flare_small) < 655360) fail.push("a small crop was not grown to the minimum: " + out.flare_small);
if (px(out.flare_huge) > 8294400) fail.push("over the pixel budget: " + out.flare_huge);
if (Math.max(...edges(out.flare_huge)) > 3840) fail.push("over the edge limit: " + out.flare_huge);
{
    const [w, h] = edges(out.flare_long);
    if (Math.max(w, h) / Math.min(w, h) > 3) fail.push("ratio steeper than 3:1: " + out.flare_long);
}
if (Math.max(...edges(out.two)) > 2048) fail.push("gpt-image-2 over 2048: " + out.two);
if (!["1024x1024", "1536x1024", "1024x1536"].includes(out.one)) fail.push("gpt-image-1 must take a standard shape: " + out.one);

// the parameter set
out.transparent_png = a._common({ background: "transparent", output_format: "png", output_compression: 90 }, "gpt-image-2.5-flare");
out.transparent_jpeg = a._common({ background: "transparent", output_format: "jpeg" }, "gpt-image-2.5-flare");
out.webp = a._common({ background: "opaque", output_format: "webp", output_compression: 60, moderation: "low" }, "gpt-image-2");
out.fid_two = a._common({ input_fidelity: "high" }, "gpt-image-2");
out.fid_one = a._common({ input_fidelity: "high" }, "gpt-image-1.5");
out.plain = a._common({}, "gpt-image-2");

if (out.transparent_png.background !== "transparent") fail.push("background not passed on");
if ("output_compression" in out.transparent_png) fail.push("compression must not go with PNG");
if (out.transparent_jpeg.output_format !== "png") fail.push("a transparent JPEG must become a PNG: " + out.transparent_jpeg.output_format);
if (out.webp.output_compression !== 60 || out.webp.moderation !== "low") fail.push("webp options wrong: " + JSON.stringify(out.webp));
if ("input_fidelity" in out.fid_two) fail.push("gpt-image-2 must not get input_fidelity");
if (out.fid_one.input_fidelity !== "high") fail.push("gpt-image-1.5 must get input_fidelity");
if ("background" in out.plain || "quality" in out.plain) fail.push("an empty request must stay empty: " + JSON.stringify(out.plain));
if (out.plain.output_format !== "png") fail.push("the default format should be png");

if (fail.length) { console.error(JSON.stringify(fail)); process.exit(1); }
console.log(JSON.stringify(out));
"""

SETUP = """
const d = await run("new_document");
window.__t = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { doc: d.id, width: 1200, height: 800, color: "#808080" });
await run("select_rect", { doc: d.id, x: 400, y: 250, width: 400, height: 300 });
// no context and no feather: the region is exactly the selection and the composite mask is
// 1 inside it, so a pixel near its corner tells the two paths apart
window.__keep = { params: { ...host.nodeParams }, crop: { ...ed.cropSettings } };
host.nodeParams.padding = 0;
host.nodeParams.feather = 0;
ed.cropSettings.context = 0;
ed.cropSettings.feather = 0;
ed.cropSettings.colorMatch = true;
window.__loop = { id: "loopback_alpha", kind: "provider", provider: "loopback", providerLabel: "Loopback", model: "loopback", input: "fill", text: { model: "loopback" }, name: "Loopback", settings: [], limits: { min: 256, max: 1024, step: 16, pixels: 0, minPixels: 0 } };
return { size: [ed.width, ed.height] };
"""

RUN_ALPHA = """
const ed = ednow(window.__t);
const prev = host.recipe;
const before = ed.layers.length;
host.setRecipe(window.__loop);
let out;
try { out = await host.runProvider(ed, { background: "transparent" }); } finally { host.setRecipe(prev); }
if (ed.layers.length !== before + 1) throw new Error("no result layer");
const l = ed.layers[ed.layers.length - 1];
const g = l.canvas.getContext("2d", { willReadFrequently: true });
const at = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data);
const centre = at(l.canvas.width >> 1, l.canvas.height >> 1);
const corner = at(2, 2);
if (centre[3] < 250) throw new Error("the disc should be opaque in the middle, alpha " + centre[3]);
if (corner[3] !== 0) throw new Error("the ground should be fully transparent, alpha " + corner[3]);
if (!out.transparent) throw new Error("the run did not report itself transparent");
if (!out.cutout) throw new Error("the run did not see the transparency it got back");
if (!/cut-out/.test(ed.status)) throw new Error("the status line says nothing about the cut-out: " + ed.status);
return { region: [out.w, out.h], centre, corner, status: ed.status.slice(0, 140) };
"""

RUN_OPAQUE = """
const ed = ednow(window.__t);
const prev = host.recipe;
const before = ed.layers.length;
host.setRecipe(window.__loop);
let out;
try { out = await host.runProvider(ed); } finally { host.setRecipe(prev); }
if (ed.layers.length !== before + 1) throw new Error("no result layer");
const l = ed.layers[ed.layers.length - 1];
const g = l.canvas.getContext("2d", { willReadFrequently: true });
const at = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data);
const centre = at(l.canvas.width >> 1, l.canvas.height >> 1);
const corner = at(2, 2);
if (centre[3] < 250 || corner[3] < 250) throw new Error("an ordinary run must fill the whole region: " + centre[3] + " / " + corner[3]);
if (out.transparent) throw new Error("an ordinary run must not report itself transparent");
return { centre, corner, status: ed.status.slice(0, 140) };
"""

GENERATE_NEW = """
const ed = ednow(window.__t);
const prev = host.recipe;
host.setRecipe(window.__loop);
let out;
try { out = await run("generate_new", { doc: window.__t, prompt: "a paper crane", width: 512, height: 512, seed: 7, background: "transparent" }); }
finally { host.setRecipe(prev); }
if (!ed.base) throw new Error("no base image");
if (!out.transparent) throw new Error("the new base was not reported transparent");
const c = ed.flattenToCanvas({ forRun: true });
const g = c.getContext("2d", { willReadFrequently: true });
const corner = Array.from(g.getImageData(2, 2, 1, 1).data);
const centre = Array.from(g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data);
if (corner[3] !== 0) throw new Error("the base should be transparent in the corner, alpha " + corner[3]);
if (centre[3] < 250) throw new Error("the disc should be opaque in the middle, alpha " + centre[3]);
return { size: [ed.width, ed.height], corner, centre };
"""

LOCAL_REFUSES = """
const prev = host.recipe;
host.setRecipe({ id: "local_alpha", kind: "comfy", name: "Local", prompt: {}, canvas: "1", settings: [] });
let msg = "";
try { await run("generate_new", { doc: window.__t, prompt: "x", width: 256, height: 256, background: "transparent" }); }
catch (err) { msg = String(err.message || err); }
finally { host.setRecipe(prev); }
if (!/local ComfyUI recipe/.test(msg)) throw new Error("wrong error: " + msg);
return { error: msg };
"""

MIN_PIXELS = """
const ed = ednow(window.__t);
const stitch = await import("./editor/stitch.js");
// the generate_new step above replaced the document, so start from a known canvas again
await run("new_canvas", { doc: window.__t, width: 1200, height: 800, color: "#808080" });
await run("select_rect", { doc: window.__t, x: 500, y: 400, width: 200, height: 150 });
const base = { min: 256, max: 3840, step: 16, pixels: 8294400, mode: "crop" };
const small = stitch.prepareCrop(ed, host.nodeParams, base).info;
const grown = stitch.prepareCrop(ed, host.nodeParams, { ...base, minPixels: 655360 }).info;
if (small.emitted[0] * small.emitted[1] >= 655360) throw new Error("the plain crop was already big enough, the step proves nothing: " + small.emitted.join("x"));
if (grown.emitted[0] * grown.emitted[1] < 655360) throw new Error("minPixels did not grow the crop: " + grown.emitted.join("x"));
if (Math.max(...grown.emitted) > 3840) throw new Error("minPixels broke the edge limit: " + grown.emitted.join("x"));
const r0 = small.emitted[0] / small.emitted[1], r1 = grown.emitted[0] / grown.emitted[1];
if (Math.abs(r0 - r1) > 0.06) throw new Error("the aspect ratio moved: " + small.emitted.join("x") + " -> " + grown.emitted.join("x"));
await run("select_rect", { doc: window.__t, x: 400, y: 250, width: 400, height: 300 });
return { plain: small.emitted, grown: grown.emitted, pixels: grown.emitted[0] * grown.emitted[1] };
"""

REAL_RECIPES = """
const list = await window.scumble.recipes.list();
const out = {};
for (const id of ["gpt_image_2", "gpt_image_2_5_flare", "gpt_image_2_5_sunburst"]) {
    const r = list.find((x) => x.id === id);
    if (!r) throw new Error("recipe missing: " + id);
    const v = r.providers.openai;
    const keys = v.settings.map((s) => s.key);
    if (!keys.includes("background")) throw new Error(id + " has no background row: " + keys.join(", "));
    if (keys.includes("input_fidelity")) throw new Error(id + " still sends input_fidelity");
    const bg = v.settings.find((s) => s.key === "background");
    if (!bg.spec[0].includes("transparent")) throw new Error(id + " background row has no transparent option");
    if (!v.text || !v.text.settings.some((s) => s.key === "background")) throw new Error(id + " cannot do it from the prompt alone");
    out[id] = { keys, limits: [v.limits.max, v.limits.step, v.limits.pixels, v.limits.minPixels], sizes: v.text.sizes.length };
}
for (const id of ["gpt_image_2_5_flare", "gpt_image_2_5_sunburst"]) {
    const [max, , , minPixels] = out[id].limits;
    if (max !== 3840) throw new Error(id + " should reach 3840, has " + max);
    if (minPixels !== 655360) throw new Error(id + " needs the 655,360 pixel floor, has " + minPixels);
}
if (out.gpt_image_2.limits[0] !== 2048) throw new Error("gpt_image_2 should stay at 2048: " + out.gpt_image_2.limits[0]);
// a provider without the row must not show the switch
const nb = list.find((x) => x.id === "nano_banana_2");
if (nb.providers[nb.default].settings.some((s) => s.key === "background")) throw new Error("nano banana must not claim transparency");
return out;
"""

CLEANUP = """
const ed = ednow(window.__t);
if (ed && window.__keep) { Object.assign(host.nodeParams, window.__keep.params); Object.assign(ed.cropSettings, window.__keep.crop); }
try { await run("close_document", { doc: window.__t, force: true }); } catch (_) { /* gone */ }
return "ok";
"""

STEPS = [
    ("setup", SETUP),
    ("a_transparent_run_keeps_the_models_alpha", RUN_ALPHA),
    ("an_ordinary_run_is_unchanged", RUN_OPAQUE),
    ("generate_new_makes_a_transparent_base", GENERATE_NEW),
    ("a_local_recipe_refuses_it", LOCAL_REFUSES),
    ("the_pixel_floor_grows_a_small_crop", MIN_PIXELS),
    ("the_gpt_image_recipes_offer_it", REAL_RECIPES),
    ("cleanup", CLEANUP),
]

PRE = """(async () => {
    const commands = window.__cmds.commands, host = window.__host;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    %s
})()"""


def node_step():
    """The adapter's helpers, checked in Node: no app and no window needed."""
    try:
        out = subprocess.run([("node"), "-e", NODE_CHECK], cwd=ROOT, capture_output=True, text=True, timeout=60)
    except Exception as err:  # noqa: BLE001
        print("[FAIL] openai_adapter_rules: %s" % err)
        return False
    if out.returncode != 0:
        print("[FAIL] openai_adapter_rules: %s" % (out.stderr or out.stdout).strip()[:400])
        return False
    print("[ok] openai_adapter_rules: %s" % out.stdout.strip()[:280])
    return True


async def run_all(c):
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); window.__host = (await import('./editor/host.js')).host; await import('./shell.js'); return 1; })()")
    ok = True
    for name, body in STEPS:
        try:
            res = await c.eval(PRE % body, timeout=240)
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
    if not node_step():
        print("FAIL")
        sys.exit(1)
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
