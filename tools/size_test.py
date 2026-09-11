"""The emitted crop size for an API run: the provider limits and the app's size modes.

No ComfyUI, no API key. Checks that prepareCrop() honours a provider variant's `limits`
(the cap that keeps FLUX.2 under 1440 and gpt-image under its pixel budget), that the five
API size modes compute what they promise, that a local recipe is left alone, and that a
text-to-image-only recipe refuses the Generate button. One real loopback run proves the
bigger crop still stitches back over the selection.

    python tools/size_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

STEPS = [
    ("setup", """
const d = await run("new_document");
window.__s = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { doc: d.id, width: 3000, height: 2000, color: "#808080" });
await run("select_rect", { doc: d.id, x: 900, y: 700, width: 300, height: 200 });
window.__stitch = await import("./editor/stitch.js");
return { size: [ed.width, ed.height] };
"""),
    ("mode_max_reaches_the_provider_ceiling", """
const ed = ednow(window.__s);
const lim = { min: 256, max: 1440, step: 32, pixels: 0, mode: "max" };
const info = window.__stitch.prepareCrop(ed, host.nodeParams, lim).info;
const [ew, eh] = info.emitted;
if (Math.max(ew, eh) !== 1440) throw new Error("long side should be 1440, got " + ew + "x" + eh);
if (ew % 32 || eh % 32) throw new Error("not a multiple of 32: " + ew + "x" + eh);
return { crop: info.bbox.slice(2), emitted: info.emitted };
"""),
    ("x2_and_x4_are_the_high_res_fix", """
const ed = ednow(window.__s);
const base = { min: 256, max: 1440, step: 32, pixels: 0 };
const out = {};
for (const mode of ["crop", "x2", "x4"]) {
    const info = window.__stitch.prepareCrop(ed, host.nodeParams, { ...base, mode }).info;
    out[mode] = { crop: info.bbox.slice(2), emitted: info.emitted };
}
const cropLong = Math.max(out.crop.crop[0], out.crop.crop[1]);
const want = (f) => Math.min(1440, Math.round(cropLong * f));
for (const [mode, f] of [["x2", 2], ["x4", 4]]) {
    const got = Math.max(out[mode].emitted[0], out[mode].emitted[1]);
    if (Math.abs(got - want(f)) > 32) throw new Error(mode + " should be about " + want(f) + ", got " + got);
}
if (Math.max(out.crop.emitted[0], out.crop.emitted[1]) > 1440) throw new Error("crop mode broke the ceiling");
return out;
"""),
    ("target_mode_keeps_the_node_number", """
const ed = ednow(window.__s);
const lim = { min: 256, max: 2048, step: 16, pixels: 0, mode: "target" };
const info = window.__stitch.prepareCrop(ed, { ...host.nodeParams, target_size: 1024 }, lim).info;
if (Math.max(info.emitted[0], info.emitted[1]) !== 1024) throw new Error("target ignored: " + info.emitted.join("x"));
return { emitted: info.emitted };
"""),
    ("the_pixel_budget_holds", """
const ed = ednow(window.__s);
await run("select_rect", { doc: window.__s, x: 200, y: 200, width: 2400, height: 1600 });
const lim = { min: 256, max: 4096, step: 16, pixels: 8294400, mode: "max" };
const info = window.__stitch.prepareCrop(ed, host.nodeParams, lim).info;
const [ew, eh] = info.emitted;
if (ew * eh > 8294400) throw new Error("over the budget: " + ew + "x" + eh + " = " + (ew * eh));
if (ew * eh < 8294400 * 0.8) throw new Error("way under the budget, the cap overshot: " + ew + "x" + eh);
if (Math.max(ew, eh) >= 4096) throw new Error("the pixel cap never bit: " + ew + "x" + eh);
await run("select_rect", { doc: window.__s, x: 900, y: 700, width: 300, height: 200 });
return { emitted: [ew, eh], pixels: ew * eh };
"""),
    ("a_local_recipe_is_left_alone", """
const ed = ednow(window.__s);
const prev = host.recipe;
host.setRecipe({ id: "local_test", kind: "comfy", name: "Local", prompt: {}, canvas: "1", settings: [] });
const lim = host.cropLimits();
host.setRecipe(prev);
if (lim !== null) throw new Error("a comfy recipe must not get API limits: " + JSON.stringify(lim));
const info = window.__stitch.prepareCrop(ed, host.nodeParams, null).info;
if (Math.max(info.emitted[0], info.emitted[1]) !== 1024) throw new Error("target_size 1024 not honoured: " + info.emitted.join("x"));
return { limits: lim, emitted: info.emitted };
"""),
    ("the_real_recipes_carry_their_ceiling", """
const list = await window.scumble.recipes.list();
const out = {};
for (const id of ["flux2_pro", "flux2_max", "flux1_fill", "gpt_image_2", "nano_banana_2"]) {
    const r = list.find((x) => x.id === id);
    if (!r) throw new Error("recipe missing: " + id);
    const v = r.providers[r.default];
    out[id] = [v.limits.max, v.limits.step, v.limits.pixels];
}
for (const id of ["flux2_pro", "flux2_max", "flux1_fill"]) {
    if (out[id][0] !== 1440) throw new Error(id + " should cap at 1440, has " + out[id][0]);
}
if (out.gpt_image_2[0] !== 2048 || out.gpt_image_2[2] !== 8294400) throw new Error("gpt_image_2 limits wrong: " + out.gpt_image_2);
return out;
"""),
    ("a_text_only_recipe_refuses_generate", """
const prev = host.recipe;
host.setRecipe({ id: "krea_test", kind: "provider", provider: "loopback", providerLabel: "Loopback", model: "loopback", input: "edit", edit: false, name: "Krea 2", settings: [] });
let msg = "";
try { await host.runProvider(ednow(window.__s)); } catch (err) { msg = String(err.message || err); }
finally { host.setRecipe(prev); }
if (!/Generate new/.test(msg)) throw new Error("wrong error: " + msg);
return { error: msg };
"""),
    ("a_capped_run_still_stitches_back", """
const ed = ednow(window.__s);
const prev = host.recipe;
const before = ed.layers.length;
host.setRecipe({ id: "loopback_lim", kind: "provider", provider: "loopback", providerLabel: "Loopback", model: "loopback", input: "fill", name: "Loopback", settings: [], limits: { min: 256, max: 1440, step: 32, pixels: 0 } });
host.setApiSize("max");
let out;
try { out = await host.runProvider(ed); } finally { host.setRecipe(prev); }
if (ed.layers.length !== before + 1) throw new Error("no result layer");
const l = ed.layers[ed.layers.length - 1];
if (!l || !l.canvas) throw new Error("the result layer has no pixels");
if (l.w !== out.w || l.h !== out.h) throw new Error("the result is not the region's size: " + l.w + "x" + l.h + " vs " + out.w + "x" + out.h);
if (l.canvas.width !== out.w || l.canvas.height !== out.h) throw new Error("the patch was not scaled back: " + l.canvas.width + "x" + l.canvas.height);
return { region: [out.w, out.h], layer: [l.w, l.h, l.canvas.width, l.canvas.height], status: ed.status.slice(0, 120) };
"""),
    ("cleanup", """
try { await run("close_document", { doc: window.__s, force: true }); } catch (_) { /* gone */ }
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
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
