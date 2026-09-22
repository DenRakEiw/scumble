"""Upscale: the selection and the whole picture through an upscale recipe, against the loopback provider.

No ComfyUI, no API key. First `node tools/upscale_test.js` (the recipe format, the fal and Magnific request
bodies, the task poll, the dispatch, the assistant's policy), then the app: the loopback upscaler answers the
picture N times larger with a 4 px magenta frame as its marker (electron/main/providers/loopback.js).

- the selection: the box goes out at its own size and comes back fitted into it as a result layer;
- the whole picture: the answer becomes the base at N times the size, a paint layer and
  the selection are scaled along, and one Ctrl+Z puts all of it back;
- the refusals: a picture above the variant's limits.max, no selection, a factor the model does not offer, a
  recipe that is no upscaler;
- Generate with an upscale recipe selected upscales the selection;
- the Upscale button in the top bar opens the dialog, which lists the shipped upscale recipes, offers each one's
  factors and refuses a picture above the model's limit before anything is sent;
- list_recipes names the task and the factors; the shipped recipes' settings reach the Settings panel; the
  Magnific key row exists.

    python tools/upscale_test.py

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

LOOP = """{ id: "loopback_up", kind: "provider", task: "upscale", provider: "loopback", providerLabel: "Loopback", model: "loopback", name: "Loopback upscale",
    factor: { default: 2, min: 1, max: 4, steps: null, fixed: false }, limits: { min: 32, max: 4096, step: 1, pixels: 0, minPixels: 0, ratio: 0 },
    settings: [], usesPrompt: false, input: "fill" }"""

STEPS = [
    ("setup", """
const d = await run("new_document");
window.__u = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
window.__uPrev = host.recipe ? host.recipe.id : null;
window.__uPrevProvider = host.recipe && host.recipe.kind === "provider" ? host.recipe.provider : null;
// a base with something in it: a ramp, so a stretched or shifted answer shows
const c = document.createElement("canvas");
c.width = 640; c.height = 480;
const g = c.getContext("2d");
for (let x = 0; x < 640; x += 8) { g.fillStyle = `rgb(${(x * 255 / 640) | 0}, 90, ${255 - ((x * 255 / 640) | 0)})`; g.fillRect(x, 0, 8, 480); }
await ed.setBaseFromCanvas(c);
if (ed.width !== 640 || ed.height !== 480) throw new Error("base not set: " + ed.width + "x" + ed.height);
return { doc: d.id, size: [ed.width, ed.height] };
"""),
    ("the_selection_comes_back_as_a_layer_in_its_box", """
const ed = ednow(window.__u);
host.setRecipe(%(LOOP)s);
// a green fill and a reference layer, which a Generate would send and an upscale must not
await run("set_crop", { doc: window.__u, context: 0, feather: 0, fill: "green" });
const ref = await run("add_paint_layer", { doc: window.__u, name: "a reference" });
await run("set_layer", { doc: window.__u, layer: ref.id, role: "reference" });
if (!ed.referenceLayers().length) throw new Error("the reference layer is not one");
await run("select_rect", { doc: window.__u, x: 0, y: 0, w: 300, h: 200 });
const n = ed.layers.length;
let out;
try { out = await run("upscale", { doc: window.__u, scope: "selection", factor: 3 }); }
finally { await run("set_crop", { doc: window.__u, fill: "none" }); }
if (ed.layers.length !== n + 1) throw new Error("no result layer: " + ed.layers.length);
if (!out.info || out.info.references !== 0 || out.info.mask !== false) throw new Error("the upscaler got references or a mask: " + JSON.stringify(out.info));
if (out.info.from[0] !== out.box.w || out.info.from[1] !== out.box.h) throw new Error("the crop did not go out at its own size: " + JSON.stringify(out.info) + " box " + JSON.stringify(out.box));
if (out.info.width !== out.box.w * 3) throw new Error("the factor did not reach the upscaler: " + JSON.stringify(out.info));
if (!out.layer) throw new Error("the command named no layer: " + JSON.stringify(out));
const l = ed.layers.find((x) => x.id === out.layer.id);
const b = out.box;
// the crop box: the selection plus the node's context (padding), inside the picture
if (!(b.x === 0 && b.y === 0 && b.x + b.w >= 300 && b.y + b.h >= 200 && b.x >= 0 && b.y >= 0 && b.x + b.w <= 640 && b.y + b.h <= 480)) throw new Error("the box does not hold the selection: " + JSON.stringify(b));
if (!l || l.x !== b.x || l.y !== b.y || l.w !== b.w || l.h !== b.h) throw new Error("the layer is not in the box: " + JSON.stringify(l && { x: l.x, y: l.y, w: l.w, h: l.h }) + " vs " + JSON.stringify(b));
if (ed.width !== 640 || ed.height !== 480) throw new Error("the selection's upscale changed the picture's size");
if (out.factor !== 3) throw new Error("wrong answer: " + JSON.stringify(out));
// the marker frame came back (the loopback's magenta, 4 px in the answer, a pixel and a third once fitted back) where the
// selection reaches the box's edge (the picture's corner); inside it the ramp, outside the selection nothing
const px = l.px.readRect(0, 60, 1, 1).data;
if (!(px[0] > 180 && px[1] < 60 && px[2] > 200 && px[3] > 250)) throw new Error("the answer is not the upscaler's (left edge " + Array.from(px) + ")");
const mid = l.px.readRect(150, 100, 1, 1).data;
if (mid[0] > 200 && mid[1] < 80 && mid[2] > 200) throw new Error("the middle is the marker: the answer was not fitted back");
// the ramp at x 150 is about (60, 90, 196): the green fill would pull G up and B down
if (Math.abs(mid[1] - 90) > 20 || mid[2] < 160) throw new Error("the crop went out with the green fill: " + Array.from(mid));
await run("remove_layer", { doc: window.__u, layer: ref.id });
if (mid[3] < 250) throw new Error("the selection is not painted (alpha " + mid[3] + ")");
const edge = l.px.readRect(b.w - 2, b.h - 2, 1, 1).data;
if (b.w > 310 && edge[3] > 5) throw new Error("the context outside the selection is painted (alpha " + edge[3] + ")");
return { layer: out.layer.id, box: out.box, edge: Array.from(px), middle: Array.from(mid), outside: Array.from(edge) };
""" % {"LOOP": LOOP}),
    ("the_whole_picture_is_upscaled_with_every_layer_and_one_undo", """
const ed = ednow(window.__u);
host.setRecipe(%(LOOP)s);
// a paint layer and a selection, both to be scaled along
const paint = await run("add_paint_layer", { doc: window.__u, name: "paint" });
await run("set_layer", { doc: window.__u, layer: paint.id, x: 10, y: 20, w: 100, h: 50 });
await run("select_rect", { doc: window.__u, x: 300, y: 200, w: 60, h: 40 });
const before = { size: [ed.width, ed.height], layers: ed.layers.map((l) => ({ id: l.id, x: l.x, y: l.y, w: l.w, h: l.h })), sel: ed.getBounds(), undo: ed.undo.length };
const out = await run("upscale", { doc: window.__u, scope: "document", factor: 2 });
if (ed.width !== 1280 || ed.height !== 960) throw new Error("not 2x: " + ed.width + "x" + ed.height);
if (out.width !== 1280 || out.height !== 960 || out.from[0] !== 640) throw new Error("the answer says otherwise: " + JSON.stringify(out));
const p = ed.layers.find((l) => l.id === paint.id);
if (p.x !== 20 || p.y !== 40 || p.w !== 200 || p.h !== 100) throw new Error("the paint layer was not scaled along: " + JSON.stringify({ x: p.x, y: p.y, w: p.w, h: p.h }));
const sb = ed.getBounds();
if (!sb || Math.abs(sb[0] - 600) > 2 || Math.abs(sb[1] - 400) > 2 || Math.abs(sb[2] - 720) > 2 || Math.abs(sb[3] - 480) > 2) throw new Error("the selection was not scaled along: " + JSON.stringify(sb));
// the new base is the upscaler's answer: its magenta frame, not the old ramp resampled
const corner = ed.basePx.readRect(1, 1, 1, 1).data;
if (!(corner[0] > 200 && corner[1] < 80 && corner[2] > 200)) throw new Error("the base is not the answer (corner " + Array.from(corner) + ")");
if (ed.undo.length !== before.undo + 1) throw new Error("not one undo step: " + (ed.undo.length - before.undo));
await ed.undoStep();
if (ed.width !== 640 || ed.height !== 480) throw new Error("Ctrl+Z did not bring the size back: " + ed.width + "x" + ed.height);
const back = ed.layers.find((l) => l.id === paint.id);
if (back.x !== 10 || back.y !== 20 || back.w !== 100 || back.h !== 50) throw new Error("Ctrl+Z did not bring the layer back");
const sb2 = ed.getBounds();
if (JSON.stringify(sb2) !== JSON.stringify(before.sel)) throw new Error("Ctrl+Z did not bring the selection back: " + JSON.stringify(sb2) + " vs " + JSON.stringify(before.sel));
const c2 = ed.basePx.readRect(1, 1, 1, 1).data;
if (c2[0] > 200 && c2[1] < 80 && c2[2] > 200) throw new Error("the old base did not come back");
await ed.redoStep();
if (ed.width !== 1280) throw new Error("redo did not upscale again");
await ed.undoStep();
return { answered: out.answered, undo: ed.undo.length - before.undo, size: [ed.width, ed.height] };
""" % {"LOOP": LOOP}),
    ("refusals", """
const ed = ednow(window.__u);
const out = {};
const refused = async (args, re, recipe) => {
    host.setRecipe(recipe || %(LOOP)s);
    try { await run("upscale", { doc: window.__u, ...args }); } catch (err) { const m = String(err.message || err); if (!re.test(m)) throw new Error("wrong refusal for " + JSON.stringify(args) + ": " + m); return m; }
    throw new Error("not refused: " + JSON.stringify(args));
};
const small = { ...%(LOOP)s, limits: { min: 32, max: 512, step: 1, pixels: 0, minPixels: 0, ratio: 0 } };
out.tooLarge = await refused({ scope: "document" }, /640 × 480.*at most 512 px/, small);
if (ed.width !== 640) throw new Error("a refused run changed the picture");
out.factor = await refused({ scope: "document", factor: 5 }, /1 to 4, not 5/);
out.steps = await refused({ scope: "document", factor: 3 }, /2, 4, 8, 16, not 3/, { ...%(LOOP)s, factor: { default: 2, min: 2, max: 16, steps: [2, 4, 8, 16], fixed: false } });
await run("select_none", { doc: window.__u });
out.noSelection = await refused({ scope: "selection" }, /Select an area first/);
const editRecipe = { id: "loopback_edit", kind: "provider", provider: "loopback", providerLabel: "Loopback", model: "loopback", input: "edit", name: "Loopback", settings: [], task: "edit" };
out.noUpscaler = await refused({ scope: "document" }, /no upscaler/, editRecipe);
// the host refuses too, for a caller that is not the command (the dialog, Generate)
host.setRecipe(editRecipe);
try { await host.runUpscale(ed, { scope: "document" }); throw new Error("the host upscaled with an edit recipe"); }
catch (err) { if (!/Pick an upscale recipe first/.test(String(err.message))) throw err; out.hostRefuses = err.message; }
if (ed.providerPending) throw new Error("a refusal left the document busy");
return out;
""" % {"LOOP": LOOP}),
    ("generate_with_an_upscale_recipe_upscales_the_selection", """
const ed = ednow(window.__u);
host.setRecipe(%(LOOP)s);
await run("select_rect", { doc: window.__u, x: 40, y: 40, w: 96, h: 64 });
const n = ed.layers.length;
const out = await run("generate", { doc: window.__u, timeout: 60 });
if (ed.layers.length !== n + 1) throw new Error("no layer from Generate");
const L = out.layer;
if (!L || L.kind !== "result" || !(L.x <= 40 && L.y <= 40 && L.x + L.w >= 136 && L.y + L.h >= 104)) throw new Error("Generate did not upscale the selection: " + JSON.stringify(L));
if (!/upscaled the selection/.test(ed.status)) throw new Error("the status is not the upscale's: " + ed.status);
if (ed.width !== 640) throw new Error("Generate changed the picture's size");
return { layer: out.layer.id, status: ed.status };
""" % {"LOOP": LOOP}),
    ("the_shipped_recipes_are_listed_with_their_task_and_factors", """
const list = await run("list_recipes");
const ups = list.recipes.filter((r) => r.task === "upscale");
const want = ["clarity_upscaler", "magnific_creative", "magnific_precision", "recraft_creative", "recraft_crisp", "seedvr2", "topaz_creative", "topaz_generative", "topaz_precision"];
const ids = ups.map((r) => r.id).sort();
if (JSON.stringify(ids) !== JSON.stringify(want)) throw new Error("upscale recipes: " + ids.join(", "));
const mc = ups.find((r) => r.id === "magnific_creative");
if (JSON.stringify(mc.factor.steps) !== "[2,4,8,16]" || mc.provider !== "magnific") throw new Error("Magnific Creative: " + JSON.stringify(mc));
if (list.recipes.some((r) => r.task !== "upscale" && r.factor !== undefined)) throw new Error("an edit recipe carries a factor");
const gen = list.recipes.filter((r) => r.task === "edit").length;
const provs = await window.scumble.providers.list();
if (!provs.some((p) => p.id === "magnific")) throw new Error("no Magnific key row");
return { upscale: ids.length, edit: gen, magnificRow: provs.find((p) => p.id === "magnific").label };
"""),
    ("a_shipped_recipe_fills_the_settings_panel", """
const ed = ednow(window.__u);
host.shell.selectRecipe("topaz_precision");
const t = host.settingTargets(ed);
const labels = t.map((x) => x.node.title);
if (JSON.stringify(labels) !== JSON.stringify(["Model", "Face enhancement", "Sharpen", "Denoise", "Fix compression"])) throw new Error("rows: " + labels.join(", "));
if (host.recipe.task !== "upscale" || !host.recipe.factor || host.recipe.factor.max !== 4) throw new Error("the resolved recipe lacks its task or factor: " + JSON.stringify({ task: host.recipe.task, factor: host.recipe.factor }));
// a variant's own factor wins over the recipe's: Magnific Precision takes 2 to 16 on Magnific, 2/4/8/16 on Comfy Cloud
host.shell.selectRecipe("magnific_precision", "comfycloud");
const ccSteps = JSON.stringify(host.recipe.factor && host.recipe.factor.steps);
host.shell.selectRecipe("magnific_precision", "magnific");
const mgSteps = JSON.stringify(host.recipe.factor && host.recipe.factor.steps);
host.shell.selectRecipe("topaz_precision");
if (ccSteps !== "[2,4,8,16]" || mgSteps !== "null") throw new Error("the variant's factor did not reach the host: " + ccSteps + " / " + mgSteps);
if (ed.genSettings.mode !== "api") throw new Error("an upscale recipe did not switch to api");
const params = host.providerParams(ed);
if (params.model !== "Standard V2" || params.sharpen !== "auto") throw new Error("params: " + JSON.stringify(params));
// the recipe select lists it under its family
const opt = Array.from(document.querySelectorAll("#shell-recipe optgroup")).find((g) => g.label === "Upscale");
if (!opt || !Array.from(opt.children).some((o) => o.value === "topaz_precision")) throw new Error("no Upscale group in the recipe select");
return { rows: labels, params };
"""),
    ("the_upscale_button_opens_the_dialog", """
const ed = ednow(window.__u);
const btn = ed.root.querySelector(".ipc-upscale");
if (!btn) throw new Error("no Upscale button in the top bar");
const prevBtn = btn.previousElementSibling;
if (!prevBtn || !/^Generate new/.test(prevBtn.title || "")) throw new Error("the button is not next to Generate new: " + (prevBtn && prevBtn.title));
await run("select_rect", { doc: window.__u, x: 10, y: 10, w: 50, h: 50 });
btn.click();
await wait(60);
const dlg = document.getElementById("up-dialog");
if (!dlg.open) throw new Error("the dialog did not open");
const recs = Array.from(document.getElementById("up-recipe").options).map((o) => o.value);
if (recs.length !== 9) throw new Error("the dialog lists " + recs.length + " recipes: " + recs.join(", "));
if (document.getElementById("up-recipe").value !== "topaz_precision") throw new Error("the selected upscale recipe is not preselected");
if (!document.getElementById("up-scope-sel").checked) throw new Error("with a selection the dialog does not start on it");
const pick = (id) => { const s = document.getElementById("up-recipe"); s.value = id; s.dispatchEvent(new Event("change")); };
pick("magnific_creative");
const factors = Array.from(document.getElementById("up-factor").options).map((o) => +o.value);
if (JSON.stringify(factors) !== "[2,4,8,16]") throw new Error("Magnific Creative factors: " + factors);
pick("recraft_crisp");
if (!document.getElementById("up-factor-row").hidden) throw new Error("a model that picks its own factor shows a factor");
pick("seedvr2");
const sv = Array.from(document.getElementById("up-factor").options).map((o) => +o.value);
if (JSON.stringify(sv) !== "[1,2,3,4,5,6,7,8]") throw new Error("SeedVR2 factors: " + sv);
// the whole picture of a document above the model's 4096: refused before anything is sent
document.getElementById("up-scope-doc").checked = true;
document.getElementById("up-scope-doc").dispatchEvent(new Event("change"));
const okNote = document.getElementById("up-size-note").textContent;
if (document.getElementById("up-go").disabled || !/640 × 480 goes out, about 1280 × 960/.test(okNote)) throw new Error("the note for 640 x 480: " + okNote);
const w0 = ed.width, h0 = ed.height;
ed.width = 5000; ed.height = 3000;
document.getElementById("up-scope-doc").dispatchEvent(new Event("change"));
const tooBig = document.getElementById("up-size-note").textContent;
const disabled = document.getElementById("up-go").disabled;
ed.width = w0; ed.height = h0;
if (!disabled || !/at most 4096 px/.test(tooBig)) throw new Error("a picture above the limit is not refused in the dialog: " + tooBig);
document.getElementById("up-cancel").click();
await wait(80);
if (dlg.open) throw new Error("Cancel did not close the dialog");
return { recipes: recs.length, factors, refused: tooBig };
"""),
    ("the_dialog_runs_the_command", """
const ed = ednow(window.__u);
// the loopback recipe as a shipped one would be: the dialog selects it by id through the shell
const list = host.shell.recipes();
const fake = { id: "loopback_upscale_gate", kind: "provider", task: "upscale", name: "Loopback upscale (gate)", family: "Upscale", default: "loopback", providerIds: ["loopback"],
    providers: { loopback: { model: "loopback", settings: [], factor: { default: 2, min: 1, max: 4, steps: null, fixed: false }, limits: { min: 32, max: 4096, step: 1, pixels: 0, minPixels: 0, ratio: 0 }, text: null, edit: true, usesPrompt: false } } };
list.push(fake);
try {
    await run("select_rect", { doc: window.__u, x: 200, y: 200, w: 80, h: 60 });
    host.shell.openUpscale(ed);
    const s = document.getElementById("up-recipe"); s.value = fake.id; s.dispatchEvent(new Event("change"));
    document.getElementById("up-scope-sel").checked = true;
    document.getElementById("up-factor").value = "2";
    const n = ed.layers.length;
    document.getElementById("up-go").click();
    const t0 = Date.now();
    while (ed.layers.length === n && Date.now() - t0 < 20000) await wait(100);
    if (ed.layers.length !== n + 1) throw new Error("the dialog's run added no layer: " + ed.status);
    if (document.getElementById("up-dialog").open) throw new Error("the dialog stayed open");
    const l = ed.layers[ed.layers.length - 1];
    if (!(l.x <= 200 && l.y <= 200 && l.x + l.w >= 280 && l.y + l.h >= 260)) throw new Error("the dialog's layer does not hold the selection");
    return { status: ed.status };
} finally {
    list.splice(list.indexOf(fake), 1);
}
"""),
    ("cleanup", """
try { await run("close_document", { doc: window.__u }); } catch (_) { /* gone */ }
// the window's recipe back through the shell (a gate that leaves it changed makes the next one red)
if (window.__uPrev) host.shell.selectRecipe(window.__uPrev, window.__uPrevProvider || undefined);
return { recipe: host.recipe && host.recipe.id };
"""),
]

PRE = """(async () => {
    const commands = window.__cmds.commands, host = window.__host;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    %s
})()"""


def node_step():
    r = subprocess.run(["node", os.path.join(ROOT, "tools", "upscale_test.js")], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=120)
    tail = (r.stdout + r.stderr).strip()
    if r.returncode != 0 or not tail.endswith("PASS"):
        raise Exception("tools/upscale_test.js: " + tail[-1500:])
    return {"checks": tail.count("[ok]")}


async def run_all(c):
    ok = True
    try:
        print("[ok] node: %s" % json.dumps(node_step()))
    except Exception as err:  # noqa: BLE001
        print("[FAIL] node: %s" % err)
        print("FAIL")
        return False
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); window.__host = (await import('./editor/host.js')).host; await import('./shell.js'); return 1; })()")
    for name, body in STEPS:
        try:
            res = await c.eval(PRE % body, timeout=240)
            print("[ok] %s: %s" % (name, json.dumps(res, ensure_ascii=False)[:300]))
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] %s: %s" % (name, err))
            if name != "cleanup":
                try:
                    await c.eval(PRE % STEPS[-1][1], timeout=60)
                except Exception:  # noqa: BLE001
                    pass
            break
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:220])
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
