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
const want = ["clarity_upscaler", "magnific_creative", "magnific_precision", "recraft_creative", "recraft_crisp", "rtx_vsr_local", "seedvr2", "topaz_creative", "topaz_generative", "topaz_precision", "upscale_model_local"];
const ids = ups.map((r) => r.id).sort();
if (JSON.stringify(ids) !== JSON.stringify(want)) throw new Error("upscale recipes: " + ids.join(", "));
const mc = ups.find((r) => r.id === "magnific_creative");
if (JSON.stringify(mc.factor.steps) !== "[2,4,8,16]" || mc.provider !== "magnific") throw new Error("Magnific Creative: " + JSON.stringify(mc));
// a ComfyUI upscaler names its factor and its limits (docs/PLAN_0_1_42.md U1); an upscale model picks its own factor and
// takes at most 2048 px (U2, Q14)
const rtx = ups.find((r) => r.id === "rtx_vsr_local"), um = ups.find((r) => r.id === "upscale_model_local");
if (rtx.mode !== "local" || rtx.provider !== null || !rtx.factor || rtx.factor.fixed !== false || rtx.factor.default !== 2 || rtx.factor.min !== 1 || rtx.factor.max !== 4 || JSON.stringify(rtx.limits) !== JSON.stringify({ min: 64, max: 4096, out: 8192 })) throw new Error("RTX Video Super Resolution: " + JSON.stringify(rtx));
if (!um.factor || um.factor.fixed !== true || JSON.stringify(um.limits) !== JSON.stringify({ picture: 2048 })) throw new Error("Upscale model: " + JSON.stringify({ factor: um.factor, limits: um.limits }));
if (mc.limits !== undefined) throw new Error("an API upscaler names ComfyUI limits: " + JSON.stringify(mc.limits));
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
// the eleven upscale recipes (RTX Video Super Resolution since U1) and the Realism Pass (task "pass", R3b)
if (recs.length !== 12 || !recs.includes("realism_pass") || !recs.includes("rtx_vsr_local")) throw new Error("the dialog lists " + recs.length + " recipes: " + recs.join(", "));
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
    ("the_dialog_sends_its_own_prompt_to_an_upscaler_that_takes_one", """
const ed = ednow(window.__u);
const list = host.shell.recipes();
const lb = (usesPrompt) => ({ model: "loopback", settings: [], factor: { default: 2, min: 1, max: 4, steps: null, fixed: false }, limits: { min: 32, max: 4096, step: 1, pixels: 0, minPixels: 0, ratio: 0 }, text: null, edit: true, usesPrompt });
const fake = { id: "loopback_upscale_prompt", kind: "provider", task: "upscale", name: "Loopback upscale with a prompt (gate)", family: "Upscale", default: "loopback", providerIds: ["loopback"], usesPrompt: true, providers: { loopback: lb(true) } };
list.push(fake);
const orig = commands.run;
const seen = [];
commands.run = async (n, a) => { const out = await orig.call(commands, n, a); if (n === "upscale") seen.push({ args: a, out }); return out; };
try {
    await run("set_prompt", { doc: window.__u, text: "tab words" });
    await run("select_rect", { doc: window.__u, x: 100, y: 100, w: 60, h: 40 });
    host.shell.openUpscale(ed);
    const row = document.getElementById("up-prompt-row"), box = document.getElementById("up-prompt");
    if (box.value !== "tab words") throw new Error("the dialog's prompt does not start as the document's: " + JSON.stringify(box.value));
    const pick = (id) => { const s = document.getElementById("up-recipe"); s.value = id; s.dispatchEvent(new Event("change")); return !row.hidden; };
    const shown = { recraft_crisp: pick("recraft_crisp"), topaz_precision: pick("topaz_precision"), clarity_upscaler: pick("clarity_upscaler"), magnific_creative: pick("magnific_creative"), gate: pick(fake.id) };
    if (JSON.stringify(shown) !== JSON.stringify({ recraft_crisp: false, topaz_precision: false, clarity_upscaler: true, magnific_creative: true, gate: true })) throw new Error("the prompt row: " + JSON.stringify(shown));
    box.value = "  dialog words  ";
    document.getElementById("up-scope-sel").checked = true;
    const n = ed.layers.length;
    document.getElementById("up-go").click();
    const t0 = Date.now();
    while (!seen.length && Date.now() - t0 < 20000) await wait(100);
    if (!seen.length) throw new Error("the dialog ran no upscale: " + ed.status);
    const got = seen[0];
    if (got.args.prompt !== "dialog words") throw new Error("the command got " + JSON.stringify(got.args.prompt));
    if (!got.out.info || got.out.info.prompt !== "dialog words") throw new Error("the upscaler got " + JSON.stringify(got.out.info));
    if (ed.layers.length !== n + 1) throw new Error("no layer came back");
    if (ed.promptText !== "tab words") throw new Error("the dialog changed the document's prompt: " + ed.promptText);
    // the command without a prompt takes the document's; an upscaler without usesPrompt gets none, whatever is passed
    const plain = await orig.call(commands, "upscale", { doc: window.__u, scope: "selection" });
    if (plain.info.prompt !== "tab words") throw new Error("without a prompt argument: " + JSON.stringify(plain.info.prompt));
    const listed = (await orig.call(commands, "list_recipes", {})).recipes || (await orig.call(commands, "list_recipes", {}));
    const arr = Array.isArray(listed) ? listed : listed.recipes;
    const flags = Object.fromEntries(arr.filter((r) => r.task === "upscale").map((r) => [r.id, r.usesPrompt]));
    if (flags.magnific_creative !== true || flags.clarity_upscaler !== true || flags.topaz_precision !== false) throw new Error("list_recipes usesPrompt: " + JSON.stringify(flags));
    fake.providers.loopback = lb(false);
    host.shell.selectRecipe(fake.id, "loopback");
    const none = await orig.call(commands, "upscale", { doc: window.__u, scope: "selection", prompt: "ignored" });
    if (none.info.prompt !== "") throw new Error("an upscaler without usesPrompt got " + JSON.stringify(none.info.prompt));
    return { shown, sent: got.out.info.prompt, plain: plain.info.prompt };
} finally {
    commands.run = orig;
    list.splice(list.indexOf(fake), 1);
    try { await run("set_prompt", { doc: window.__u, text: "" }); } catch (_) { /* gone */ }
}
"""),
    # the selection through the node (the whole picture since U2 is the next step but one)
    ("a_comfy_upscale_recipe_queues_the_crop_as_it_is", """
// the shipped ComfyUI recipe, with the prompt caught before it leaves: nothing is queued on any server
const ed = ednow(window.__u);
const { api } = await import("./editor/host.js");
const r0 = host.shell.recipes().find((x) => x.id === "upscale_model_local");
if (!r0) throw new Error("the shipped ComfyUI upscale recipe is not listed");
if (r0.task !== "upscale" || r0.kind === "provider" || !r0.factor || r0.factor.fixed !== true) throw new Error("not a ComfyUI upscaler: " + JSON.stringify({ task: r0.task, kind: r0.kind, factor: r0.factor }));
const saved = { connected: host.connected, objectInfo: host.objectInfo, ensure: host.ensureOnServer, queue: api.queuePrompt, np: host.nodeParams, crop: { ...ed.cropSettings } };
let sent = null, ref = null;
const out = {};
try {
    host.connected = true;
    const oi = {};
    for (const n of r0.needs) oi[n] = { input: { required: {} } };
    oi.UpscaleModelLoader = { input: { required: { model_name: [["4x-UltraSharp.pth", "2xESRGAN.pth"], {}] } } };
    host.objectInfo = oi;
    host.ensureOnServer = async () => null;
    api.queuePrompt = async (n, body) => { sent = body; return { prompt_id: "gate-upscale" }; };
    host.nodeParams = { ...saved.np, target_size: 1024 };
    host.shell.selectRecipe("upscale_model_local");
    if (host.recipe.id !== "upscale_model_local") throw new Error("the recipe was not selected");
    const t = host.settingTargets(ed);
    if (t.length !== 1 || t[0].node.title !== "Model" || t[0].inputName !== "model_name") throw new Error("the Settings rows: " + JSON.stringify(t.map((x) => x.node.title)));
    // what a Generate would send and an upscaler must not: a green fill with the Original after it, a reference layer
    await run("set_crop", { doc: window.__u, context: 0, feather: 0, fill: "green", withOriginal: true });
    ref = await run("add_paint_layer", { doc: window.__u, name: "a reference" });
    await run("set_layer", { doc: window.__u, layer: ref.id, role: "reference" });
    await run("select_rect", { doc: window.__u, x: 64, y: 64, w: 120, h: 90 });
    ed.settings["1"] = { value: "2xESRGAN.pth" };
    await host.queueGenerate(ed);
    if (!sent) throw new Error("nothing was queued");
    const P_ = sent.output, cv = P_.canvas.inputs, st = JSON.parse(cv.canvas_state);
    if (cv.target_size !== 0) throw new Error("the crop is scaled before the model sees it: target_size " + cv.target_size);
    if (st.crop.fill !== "none" || st.crop.withOriginal !== false) throw new Error("the crop goes out filled: " + JSON.stringify(st.crop));
    if ((st.references || []).length) throw new Error("reference layers went along: " + st.references.length);
    if (cv.result_source_local !== "up:0" || cv.result_source !== undefined) throw new Error("the result input: " + JSON.stringify({ local: cv.result_source_local, api: cv.result_source }));
    if (P_.loader.inputs.model_name !== "2xESRGAN.pth") throw new Error("the Model setting did not reach the loader: " + P_.loader.inputs.model_name);
    if (ed.cropSettings.fill !== "green" || ed.cropSettings.withOriginal !== true) throw new Error("the crop settings of the document were changed: " + JSON.stringify(ed.cropSettings));
    if (host.nodeParams.target_size !== 1024) throw new Error("the node params were changed: " + JSON.stringify(host.nodeParams));
    out.sent = { target_size: cv.target_size, crop: st.crop, model: P_.loader.inputs.model_name, result: cv.result_source_local };
    // the dialog lists it and offers no factor; with a selection it starts on the selection, the whole picture offered
    // beside it (U2)
    host.shell.openUpscale(ed);
    const pick = (id) => { const s = document.getElementById("up-recipe"); s.value = id; s.dispatchEvent(new Event("change")); };
    const recs = Array.from(document.getElementById("up-recipe").options).map((o) => o.value);
    if (!recs.includes("upscale_model_local")) throw new Error("the dialog does not list it: " + recs.join(", "));
    pick("upscale_model_local");
    const docRadio = document.getElementById("up-scope-doc"), go = document.getElementById("up-go");
    if (docRadio.disabled || docRadio.checked || !document.getElementById("up-scope-sel").checked) throw new Error("the scope: " + JSON.stringify({ docDisabled: docRadio.disabled, doc: docRadio.checked }));
    if (/whole picture is not upscaled/.test(document.getElementById("up-size-note").textContent)) throw new Error("the note still says the whole picture is not upscaled: " + document.getElementById("up-size-note").textContent);
    if (!document.getElementById("up-factor-row").hidden) throw new Error("a factor is offered for a model that picks its own");
    if (!document.getElementById("up-provider-row").hidden) throw new Error("a provider row for a ComfyUI recipe");
    if (go.disabled) throw new Error("Go is disabled with a selection and a server: " + document.getElementById("up-size-note").textContent);
    host.connected = false;
    docRadio.dispatchEvent(new Event("change"));
    const offline = document.getElementById("up-note").textContent;
    if (!go.disabled || !/Not connected to ComfyUI/.test(offline)) throw new Error("not connected, and the dialog would run: " + offline);
    host.connected = true;
    host.objectInfo = { ...oi, ImageUpscaleWithModel: undefined };
    docRadio.dispatchEvent(new Event("change"));
    const lacks = document.getElementById("up-note").textContent;
    if (!go.disabled || !/lacks these node types: ImageUpscaleWithModel/.test(lacks)) throw new Error("a missing node type is not named: " + lacks);
    host.objectInfo = oi;
    pick("topaz_precision");
    if (docRadio.disabled) throw new Error("an API upscaler lost its whole-picture mode");
    pick("upscale_model_local");
    document.getElementById("up-cancel").click();
    await wait(60);
    // the command: no selection is refused for the selection's mode
    const refused = async (args, re) => {
        try { await run("upscale", { doc: window.__u, ...args }); } catch (err) { const m = String(err.message || err); if (!re.test(m)) throw new Error("wrong refusal for " + JSON.stringify(args) + ": " + m); return m; }
        throw new Error("not refused: " + JSON.stringify(args));
    };
    sent = null;
    await run("select_none", { doc: window.__u });
    // a short timeout: a refusal that lets the call through would wait for a result that never comes
    out.noSelection = await refused({ scope: "selection", timeout: 8 }, /Select an area first/);
    try { await host.queueGenerate(ed); throw new Error("Generate queued without a selection"); }
    catch (err) { if (!/Select an area first/.test(String(err.message))) throw err; }
    if (sent) throw new Error("a refusal queued a prompt");
    if (ed.width !== 640) throw new Error("a refusal changed the picture");
    return out;
} finally {
    host.connected = saved.connected; host.objectInfo = saved.objectInfo; host.ensureOnServer = saved.ensure; api.queuePrompt = saved.queue; host.nodeParams = saved.np;
    // the caught prompt never ends on a server: it would stay an open render of the tab and block a later whole picture
    if (ed._localRuns) ed._localRuns.delete("gate-upscale");
    if (document.getElementById("up-dialog").open) document.getElementById("up-cancel").click();
    await run("set_crop", { doc: window.__u, fill: saved.crop.fill || "none", withOriginal: !!saved.crop.withOriginal });
    if (ref) { try { await run("remove_layer", { doc: window.__u, layer: ref.id }); } catch (_) { /* gone */ } }
}
"""),
    # docs/PLAN_0_1_42.md U1: RTX Video Super Resolution, a ComfyUI upscaler that takes a factor. The dialog lists 1 to 4
    # and names the box and the answer; factor 3 from the dialog reaches the RTX node's dotted input and Quality its
    # quality; the command answers with the factor; a bad factor and a box past the limits (64 short side, 4096 long
    # side, an answer of 8192) are refused with nothing uploaded or queued. The prompt is caught before it leaves (nothing
    # is queued on any server); the "result" of the dialog's run is a history entry a stub of ed.generate pushes after the
    # real one queued, so the command's wait ends.
    ("rtx_video_super_resolution_takes_a_factor", """
const ed = ednow(window.__u);
const { api } = await import("./editor/host.js");
const $ = (id) => document.getElementById(id);
const pick = (id) => { const s = $("up-recipe"); s.value = id; s.dispatchEvent(new Event("change")); };
const setFactor = (v) => { $("up-factor").value = String(v); $("up-factor").dispatchEvent(new Event("change")); };
const factors = () => Array.from($("up-factor").options).map((o) => +o.value);
const r0 = host.shell.recipes().find((x) => x.id === "rtx_vsr_local");
if (!r0) throw new Error("the shipped RTX Video Super Resolution recipe is not listed");
const f0 = r0.factor || {};
if (r0.task !== "upscale" || r0.kind === "provider" || f0.fixed !== false || f0.input !== "rtx|resize_type.scale" || f0.default !== 2 || f0.min !== 1 || f0.max !== 4) throw new Error("not a ComfyUI upscaler with a factor: " + JSON.stringify({ task: r0.task, kind: r0.kind, factor: r0.factor }));
const recipe0 = host.recipe;
const ownGenerate = Object.prototype.hasOwnProperty.call(ed, "generate") ? ed.generate : null;
const saved = { connected: host.connected, objectInfo: host.objectInfo, ensure: host.ensureOnServer, queue: api.queuePrompt, np: host.nodeParams, run: commands.run, crop: { context: ed.cropSettings.context, feather: ed.cropSettings.feather } };
let sent = [], uploads = 0, fake = null, big = null;
const pushed = [];
const out = {};
const refused = async (args, re) => {
    try { await run("upscale", args); } catch (err) { const m = String(err.message || err); if (!re.test(m)) throw new Error("wrong refusal for " + JSON.stringify(args) + ": " + m); return m; }
    throw new Error("not refused: " + JSON.stringify(args));
};
const hostRefuses = async (e, opts, re) => {
    try { await host.queueGenerate(e, opts); } catch (err) { const m = String(err.message || err); if (!re.test(m)) throw new Error("wrong refusal for " + JSON.stringify(opts) + ": " + m); return m; }
    throw new Error("the host queued: " + JSON.stringify(opts));
};
try {
    host.connected = true;
    const oi = {};
    for (const n of r0.needs) oi[n] = { input: { required: {} } };
    host.objectInfo = oi;
    host.ensureOnServer = async () => { uploads++; return null; };
    api.queuePrompt = async (n, body) => { sent.push(body); return { prompt_id: "gate-rtx" }; };
    // no context around the selection and the node's multiple of 8: the box the node cuts is the selection, rounded up
    host.nodeParams = { ...saved.np, padding: 0, multiple_of: 8 };
    host.shell.selectRecipe("rtx_vsr_local");
    if (!host.recipe || host.recipe.id !== "rtx_vsr_local" || ed.genSettings.mode !== "local") throw new Error("the recipe was not selected: " + (host.recipe && host.recipe.id) + " / " + ed.genSettings.mode);
    const t = host.settingTargets(ed);
    if (t.length !== 1 || t[0].node.title !== "Quality" || t[0].inputName !== "quality" || JSON.stringify(t[0].spec && t[0].spec[0]) !== JSON.stringify(["LOW", "MEDIUM", "HIGH", "ULTRA"])) throw new Error("the Settings rows: " + JSON.stringify(t.map((x) => [x.node.title, x.inputName, x.spec])));
    if (!ed.settings["1"] || ed.settings["1"].value !== "ULTRA") throw new Error("Quality does not start at ULTRA: " + JSON.stringify(ed.settings["1"]));
    await run("set_settings", { doc: window.__u, values: { Quality: "HIGH" } });
    await run("set_crop", { doc: window.__u, context: 0, feather: 0 });
    await run("select_rect", { doc: window.__u, x: 64, y: 64, w: 120, h: 90 });
    const [, , cw, ch] = ed.cropRect();
    const bw = Math.ceil(cw / 8) * 8, bh = Math.ceil(ch / 8) * 8;
    if (cw !== 120 || ch !== 90) throw new Error("the crop with no context: " + cw + " x " + ch);
    // the layer the dialog's "result" names (the run itself is caught before it leaves)
    fake = await run("add_paint_layer", { doc: window.__u, name: "rtx gate answer" });
    ed.generate = async function () {
        const res = await Object.getPrototypeOf(this).generate.call(this);
        if (!(res && res.error)) {
            const L = this.layers.find((l) => l.id === fake.id);
            const h = { key: "gate-rtx-" + pushed.length, name: "Result (gate)", ref: { filename: "none.png", subfolder: "", type: "input" }, x: L.x, y: L.y, w: L.w, h: L.h, prompt: "", layerId: L.id, time: Date.now() };
            pushed.push(h);
            this.history.push(h);
        }
        return res;
    };

    // the dialog: the factor row 1 to 4 (2 by default), the box and the answer in the size note, the selection chosen and
    // the whole picture offered beside it (U2)
    host.shell.openUpscale(ed);
    if (!$("up-dialog").open) throw new Error("the dialog did not open");
    if ($("up-recipe").value !== "rtx_vsr_local") throw new Error("the selected recipe is not preselected: " + $("up-recipe").value);
    pick("upscale_model_local");
    if (!$("up-factor-row").hidden) throw new Error("the upscale model shows a factor");
    pick("rtx_vsr_local");
    if ($("up-factor-row").hidden || JSON.stringify(factors()) !== "[1,2,3,4]" || $("up-factor").value !== "2") throw new Error("the factor row: " + JSON.stringify({ hidden: $("up-factor-row").hidden, factors: factors(), value: $("up-factor").value }));
    if ($("up-scope-doc").disabled || !$("up-scope-sel").checked || !$("up-provider-row").hidden || !$("up-prompt-row").hidden) throw new Error("the scope or the rows: " + JSON.stringify({ doc: $("up-scope-doc").disabled, sel: $("up-scope-sel").checked, provider: $("up-provider-row").hidden, prompt: $("up-prompt-row").hidden }));
    const note2 = $("up-size-note").textContent;
    if ($("up-go").disabled || !note2.includes("(" + bw + " × " + bh + ") comes back at about " + (bw * 2) + " × " + (bh * 2))) throw new Error("the note at 2x: " + note2);
    setFactor(3);
    const note3 = $("up-size-note").textContent;
    if ($("up-go").disabled || !note3.includes("comes back at about " + (bw * 3) + " × " + (bh * 3))) throw new Error("the note at 3x: " + note3);
    out.note = note3;

    // Upscale at 3x: the dialog runs the command, the command hands the factor to the host, the host writes it
    const seen = [];
    commands.run = async (n, a) => {
        if (n !== "upscale") return saved.run.call(commands, n, a);
        try { const r = await saved.run.call(commands, n, a); seen.push({ args: a, out: r }); return r; } catch (err) { seen.push({ args: a, error: String(err.message || err) }); throw err; }
    };
    $("up-go").click();
    for (let k = 0; k < 300 && !seen.length; k++) await wait(50);
    commands.run = saved.run;
    if (!seen.length) throw new Error("the dialog ran no upscale: " + ed.status);
    const got = seen[0];
    if (got.error) throw new Error("the dialog's run failed: " + got.error);
    if (got.args.factor !== 3 || got.args.scope !== "selection") throw new Error("the dialog sent " + JSON.stringify(got.args));
    if (got.out.factor !== 3 || got.out.recipe !== "rtx_vsr_local" || got.out.provider !== null || !got.out.layer || got.out.layer.id !== fake.id) throw new Error("the answer: " + JSON.stringify(got.out));
    if ($("up-dialog").open) throw new Error("the dialog stayed open");
    if (sent.length !== 1) throw new Error("queued " + sent.length + " prompts");
    const P_ = sent[0].output, rtx = P_.rtx.inputs, cv = P_.canvas.inputs;
    if (rtx["resize_type.scale"] !== 3 || rtx.resize_type !== "scale by multiplier" || rtx.quality !== "HIGH" || JSON.stringify(rtx.images) !== JSON.stringify(["img0", 0])) throw new Error("the RTX node got " + JSON.stringify(rtx));
    if (cv.target_size !== 0 || cv.result_source_local !== "rtx:0") throw new Error("the canvas node: " + JSON.stringify({ target_size: cv.target_size, result: cv.result_source_local }));
    if (ed._comfyUpscaleFactor !== undefined || ed.lastUpscaleFactor !== 3) throw new Error("the editor's factor fields: " + JSON.stringify({ oneShot: ed._comfyUpscaleFactor, last: ed.lastUpscaleFactor }));
    if (host.recipe.prompt.rtx.inputs["resize_type.scale"] !== 2 || host.recipe.prompt.rtx.inputs.quality !== "ULTRA") throw new Error("the run wrote into the recipe's own graph: " + JSON.stringify(host.recipe.prompt.rtx.inputs));
    out.sent = { scale: rtx["resize_type.scale"], quality: rtx.quality, uploads };
    out.answer = { factor: got.out.factor, box: got.out.box };

    // Generate (no factor asked): the recipe's default; the host's own factor argument
    sent = [];
    await host.queueGenerate(ed);
    if (sent.length !== 1 || sent[0].output.rtx.inputs["resize_type.scale"] !== 2 || ed.lastUpscaleFactor !== 2) throw new Error("Generate without a factor: " + JSON.stringify(sent[0] && sent[0].output.rtx.inputs));
    sent = [];
    await host.queueGenerate(ed, { factor: 4 });
    if (sent.length !== 1 || sent[0].output.rtx.inputs["resize_type.scale"] !== 4) throw new Error("the host's factor 4: " + JSON.stringify(sent[0] && sent[0].output.rtx.inputs));

    // a factor the recipe does not take: refused by the command and by the host before anything goes
    sent = []; uploads = 0;
    const h0 = ed.history.length;
    out.factor5 = await refused({ doc: window.__u, scope: "selection", factor: 5, timeout: 8 }, /1 to 4, not 5/);
    out.factorHalf = await refused({ doc: window.__u, scope: "selection", factor: 0.5, timeout: 8 }, /1 to 4, not 0.5/);
    out.hostFactor5 = await hostRefuses(ed, { factor: 5 }, /1 to 4, not 5/);
    if (sent.length || uploads || ed.history.length !== h0 || ed._comfyUpscaleFactor !== undefined) throw new Error("a refused factor went on: " + JSON.stringify({ sent: sent.length, uploads, history: ed.history.length - h0, oneShot: ed._comfyUpscaleFactor }));

    // the size limits, on a wide picture: refused before anything is serialized, uploaded or queued
    const d2 = await run("new_document");
    big = d2.id;
    const eb = ednow(big);
    host.shell.activate(eb);
    const c = document.createElement("canvas");
    c.width = 4400; c.height = 240;
    const g = c.getContext("2d");
    g.fillStyle = "rgb(120, 90, 60)"; g.fillRect(0, 0, 4400, 240);
    await eb.setBaseFromCanvas(c);
    if (eb.width !== 4400 || eb.height !== 240) throw new Error("the wide base: " + eb.width + "x" + eb.height);
    await run("set_crop", { doc: big, context: 0, feather: 0 });
    let serialized = 0;
    const serialize = eb.serializeForPrompt;
    eb.serializeForPrompt = async function (...a) { serialized++; return serialize.apply(this, a); };
    sent = []; uploads = 0;
    const layers0 = eb.layers.length, hist0 = eb.history.length;
    // 3000 px at 4x passes 8192: the command and the host refuse it; 3x (9000) too
    await run("select_rect", { doc: big, x: 0, y: 0, w: 3000, h: 200 });
    out.out4 = await refused({ doc: big, scope: "selection", factor: 4, timeout: 8 }, /3000 × 200; at 4× the answer would pass 8192 px on the long side. Pick a smaller factor or a smaller area/);
    out.out3 = await hostRefuses(eb, { factor: 3 }, /at 3× the answer would pass 8192 px/);
    // the dialog says the same and greys Upscale; at 2x (6000) it is let through
    host.shell.openUpscale(eb);
    pick("rtx_vsr_local");
    setFactor(4);
    const bigNote = $("up-size-note").textContent, bigGo = $("up-go").disabled;
    setFactor(2);
    const okNote = $("up-size-note").textContent, okGo = $("up-go").disabled;
    $("up-cancel").click();
    await wait(60);
    if (!bigGo || !/3000 × 200; at 4× the answer would pass 8192 px/.test(bigNote)) throw new Error("the dialog at 4x: " + bigGo + " " + bigNote);
    if (okGo || !okNote.includes("comes back at about 6000 × 400")) throw new Error("the dialog at 2x: " + okGo + " " + okNote);
    out.dialogRefusal = bigNote;
    // past the long side the node takes (4096), and short of its 64 px
    await run("select_rect", { doc: big, x: 0, y: 0, w: 4200, h: 200 });
    out.max = await hostRefuses(eb, { factor: 1 }, /4200 × 200; .* takes at most 4096 px on the long side/);
    await run("select_rect", { doc: big, x: 10, y: 10, w: 40, h: 30 });
    out.min = await hostRefuses(eb, { factor: 2 }, /40 × 32; .* needs at least 64 px a side/);
    // 2056 px at 4x is 8224: refused; 2048 at 4x is 8192 exactly: let through
    await run("select_rect", { doc: big, x: 0, y: 0, w: 2056, h: 200 });
    await hostRefuses(eb, { factor: 4 }, /at 4× the answer would pass 8192 px/);
    if (sent.length || uploads || serialized || eb.layers.length !== layers0 || eb.history.length !== hist0) throw new Error("a refusal went on: " + JSON.stringify({ sent: sent.length, uploads, serialized, layers: eb.layers.length - layers0, history: eb.history.length - hist0 }));
    await run("select_rect", { doc: big, x: 0, y: 0, w: 2048, h: 200 });
    await host.queueGenerate(eb, { factor: 4 });
    if (sent.length !== 1 || sent[0].output.rtx.inputs["resize_type.scale"] !== 4 || serialized !== 1) throw new Error("2048 at 4x (8192) was not let through: " + JSON.stringify({ sent: sent.length, serialized }));
    out.edge = "2048 at 4x queued";
    return out;
} finally {
    commands.run = saved.run;
    if (ownGenerate) ed.generate = ownGenerate; else delete ed.generate;
    for (const h of pushed) { const i = ed.history.indexOf(h); if (i >= 0) ed.history.splice(i, 1); }
    host.connected = saved.connected; host.objectInfo = saved.objectInfo; host.ensureOnServer = saved.ensure; api.queuePrompt = saved.queue; host.nodeParams = saved.np;
    // the caught prompts never end on a server: they would stay open renders of the tab and block a later whole picture
    if (ed._localRuns) ed._localRuns.delete("gate-rtx");
    if ($("up-dialog").open) $("up-cancel").click();
    if (big) { try { await run("close_document", { doc: big }); } catch (_) { /* gone */ } }
    host.shell.activate(ed);
    if (fake) { try { await run("remove_layer", { doc: window.__u, layer: fake.id }); } catch (_) { /* gone */ } }
    try { await run("set_crop", { doc: window.__u, context: saved.crop.context, feather: saved.crop.feather }); } catch (_) { /* gone */ }
    // the window's recipe as the step found it, through the shell (CLAUDE.md: a gate that switches a recipe puts it back)
    if (recipe0 && (!host.recipe || host.recipe.id !== recipe0.id)) host.shell.selectRecipe(recipe0.id, recipe0.kind === "provider" ? recipe0.provider : undefined);
}
"""),
    # docs/PLAN_0_1_42.md U2: the whole picture on a ComfyUI upscaler. The dialog offers it with what goes out, what
    # comes back and the transparency line, and greys Upscale for what refuses it; its run goes out as the recipe's graph
    # with the canvas node as a loader of the uploaded base (queued at the back, a PreviewImage on the result, the factor
    # and Quality written), the document is busy like a run while it waits (status, Generate, a turn), and ComfyUI's
    # answer (a dispatched `executed` naming a mirror file, the base at 2x with a magenta frame) becomes the new base with
    # the layers and the selection scaled along, one undo step. The upscale model (a fixed factor) runs too; Cancel takes
    # its job off the server and changes nothing. Refused before anything is uploaded or queued: a busy document, a graph
    # that reads the canvas node's mask, the 8192 px answer, the 2048 px input of the upscale model, a bad factor, no
    # server, the loader missing. Nothing reaches a server: the queue, the ensure, /queue and the job cancel are caught in
    # the page; the uploads and /view go to the gate profile's mirror.
    ("a_comfy_upscaler_upscales_the_whole_picture", """
const ed = ednow(window.__u);
const { api } = await import("./editor/host.js");
const $ = (id) => document.getElementById(id);
const pick = (id) => { const s = $("up-recipe"); s.value = id; s.dispatchEvent(new Event("change")); };
const scopeDoc = () => { $("up-scope-doc").checked = true; $("up-scope-doc").dispatchEvent(new Event("change")); };
const setFactor = (v) => { $("up-factor").value = String(v); $("up-factor").dispatchEvent(new Event("change")); };
const nodeInfo = () => ({ input: { required: {} } });
const OI = {};
for (const n of ["InpaintCanvas", "InpaintCanvasLoadRef", "ImageFromBatch", "RTXVideoSuperResolution", "UpscaleModelLoader", "ImageUpscaleWithModel", "PreviewImage"]) OI[n] = nodeInfo();
const GOOD = { state: "connected", os: "win32", gpus: ["cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync"], url: "http://127.0.0.1:8188", version: "0.38.0" };
const recipe0 = host.recipe;
const list = host.shell.recipes();
const saved = { connected: host.connected, objectInfo: host.objectInfo, server: { ...(host.server || {}) }, ensureRefs: host.ensureRefs, queue: api.queuePrompt, fetchApi: api.fetchApi, run: commands.run, model: ed.settings["1"] };
// what the page sent: queued prompts, ensured refs, uploads, job cancels; T.onQueued(id, body, n) runs 300 ms after a queueing
const T = { queued: [], ensured: [], uploads: 0, cancels: [], onQueued: null, n: 0, during: null, checked: false, err: "" };
const json = (v) => Promise.resolve(new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } }));
const viewBytes = async (ref) => new Uint8Array(await (await saved.fetchApi.call(api, "/view?" + new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder || "", type: ref.type || "input" }).toString())).arrayBuffer());
const decode = async (bytes) => {
    const img = await new Promise((res, rej) => { const u = URL.createObjectURL(new Blob([bytes], { type: "image/png" })); const i = new Image(); i.onload = () => { URL.revokeObjectURL(u); res(i); }; i.onerror = () => rej(new Error("not a picture")); i.src = u; });
    const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data; c.width = c.height = 0;
    return { w: img.naturalWidth, h: img.naturalHeight, at: (px, py) => Array.from(d.slice((py * img.naturalWidth + px) * 4, (py * img.naturalWidth + px) * 4 + 4)) };
};
const pixel = (px, x, y) => Array.from(px.readRect(x, y, 1, 1).data);
const near = (a, b, tol) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const magenta = (p) => p[0] > 200 && p[1] < 80 && p[2] > 200;
const refused = async (doc, args, re) => {
    const q0 = T.queued.length, u0 = T.uploads;
    try { await run("upscale", { doc, scope: "document", timeout: 8, ...args }); } catch (err) {
        const m = String(err.message || err);
        if (!re.test(m)) throw new Error("wrong refusal for " + JSON.stringify(args) + ": " + m);
        if (T.queued.length !== q0 || T.uploads !== u0) throw new Error("a refusal sent something: " + JSON.stringify(args) + " " + m);
        return m;
    }
    throw new Error("not refused: " + JSON.stringify(args));
};
const answerWith = (ANS) => (id, body, n) => {
    if (n !== 1 || T.checked) return;
    T.checked = true;
    (async () => {
        // while it waits: the document busy like a run (the token, the title row, status, Generate, a turn)
        const tok = ed.providerPending;
        const d = { token: tok ? { provider: tok.provider, label: tok.label } : null, row: Array.from(host._providerRuns).some((t) => t.editor === ed), turn: ed.turnBlocked(), pending: (await saved.run.call(commands, "status", { doc: window.__u })).pending };
        try { await saved.run.call(commands, "generate", { doc: window.__u, timeout: 5 }); d.generate = "ran"; } catch (err) { d.generate = String(err.message || err); }
        T.during = d;
        api.dispatch("executed", { prompt_id: id, node: "scumble_out", output: { images: [ANS] } });
    })().catch((e) => { T.err = String((e && e.message) || e); api.dispatch("execution_error", { prompt_id: id, node_id: "x", node_type: "x", exception_message: "the test's answer failed: " + T.err }); });
};
let fake = null, wide = null, paint = null;
const out = {};
try {
    host.connected = true; host.objectInfo = OI; host.setServerStatus(GOOD);
    host.ensureRefs = async (refs) => { T.ensured.push(...refs); return { checked: 0, uploaded: [], missing: [] }; };
    api.queuePrompt = async (n, body) => {
        const id = "gate-u2-" + (++T.n);
        T.queued.push({ n, body, id });
        const k = T.queued.length;
        if (T.onQueued) { const f = T.onQueued; setTimeout(() => f(id, body, k), 300); }
        return { prompt_id: id };
    };
    api.fetchApi = (path, init) => {
        const p = String(path), post = !!(init && init.method === "POST");
        if (p === "/upload/image" && post) T.uploads++;
        if (p === "/queue" && post) return json({});
        // every prompt queued here shows as running (a picture run whose job is neither queued nor running ends as dropped)
        if (p === "/queue") return json({ queue_running: T.queued.map((x, k) => [k, x.id, {}, {}, []]), queue_pending: [] });
        const job =/^\\/api\\/jobs\\/([^/]+)\\/cancel$/.exec(p);
        if (job && post) { T.cancels.push(decodeURIComponent(job[1])); return json({ cancelled: true }); }
        if (p.startsWith("/history/")) return json({});
        return saved.fetchApi.call(api, path, init);
    };
    const W0 = ed.width, H0 = ed.height;
    if (W0 !== 640 || H0 !== 480) throw new Error("the document is not 640 x 480: " + W0 + "x" + H0);
    if (ed._localRuns && ed._localRuns.size) throw new Error("an earlier step left open renders on the tab: " + Array.from(ed._localRuns).join(", "));
    // ComfyUI's answer: the base at 2x with a 4 px magenta frame, stored in the mirror (its /view serves it)
    const ac = document.createElement("canvas"); ac.width = 2 * W0; ac.height = 2 * H0;
    const ag = ac.getContext("2d");
    ed.drawBaseInto(ag, 0, 0, 2 * W0, 2 * H0);
    ag.fillStyle = "rgb(255, 0, 255)";
    ag.fillRect(0, 0, 2 * W0, 4); ag.fillRect(0, 2 * H0 - 4, 2 * W0, 4); ag.fillRect(0, 0, 4, 2 * H0); ag.fillRect(2 * W0 - 4, 0, 4, 2 * H0);
    const ablob = await new Promise((r) => ac.toBlob(r, "image/png"));
    ac.width = ac.height = 0;
    const ANS = await host.uploadResult(ablob, "u2_gate_answer.png");
    // a paint layer and a selection, to be scaled along
    paint = await run("add_paint_layer", { doc: window.__u, name: "u2 paint" });
    await run("set_layer", { doc: window.__u, layer: paint.id, x: 30, y: 40, w: 100, h: 60 });
    await run("select_rect", { doc: window.__u, x: 200, y: 100, w: 80, h: 50 });
    host.shell.selectRecipe("rtx_vsr_local");
    await run("set_settings", { doc: window.__u, values: { Quality: "HIGH" } });

    // the dialog: the whole picture offered beside the selection, the note says what goes out, what comes back, and the
    // transparency line
    host.shell.openUpscale(ed);
    pick("rtx_vsr_local");
    if ($("up-scope-doc").disabled || !$("up-scope-sel").checked) throw new Error("the whole picture is greyed, or the selection not chosen");
    scopeDoc(); setFactor(2);
    const note = $("up-size-note").textContent;
    if ($("up-go").disabled || !note.startsWith("640 × 480 (the base picture alone) goes out to your ComfyUI, about 1280 × 960 comes back and becomes the picture; every layer, mask and the selection scale along.") || !/A cut-out picture comes back opaque on this route, black where it was transparent\\./.test(note)) throw new Error("the note: " + note + " / Upscale greyed " + $("up-go").disabled);
    out.note = note;
    pick("upscale_model_local"); scopeDoc();
    const umNote = $("up-size-note").textContent;
    if ($("up-go").disabled || !/the model's larger answer comes back/.test(umNote) || !$("up-factor-row").hidden) throw new Error("the upscale model's note: " + umNote);
    // what greys it: no server, the loader missing on the server, a picture past the caps
    host.connected = false; scopeDoc();
    if (!$("up-go").disabled || !/Not connected to ComfyUI/.test($("up-note").textContent)) throw new Error("not connected: " + $("up-note").textContent);
    host.connected = true;
    host.objectInfo = { ...OI, InpaintCanvasLoadRef: undefined }; scopeDoc();
    if (!$("up-go").disabled || !/lacks these node types: InpaintCanvasLoadRef/.test($("up-note").textContent)) throw new Error("the loader missing: " + $("up-note").textContent);
    host.objectInfo = OI; scopeDoc();
    ed.width = 2100; ed.height = 100; scopeDoc();
    const capUm = $("up-size-note").textContent, capUmGo = $("up-go").disabled;
    pick("rtx_vsr_local"); scopeDoc(); setFactor(4);
    const capRtx = $("up-size-note").textContent, capRtxGo = $("up-go").disabled;
    ed.width = W0; ed.height = H0; scopeDoc();
    if (!capUmGo || capUm !== "The picture is 2100 × 100; Upscale model (ComfyUI) takes at most 2048 px on the long side. Pick a smaller picture.") throw new Error("the upscale model past 2048: " + capUm);
    if (!capRtxGo || capRtx !== "The picture is 2100 × 100; at 4× the answer would pass 8192 px on the long side. Pick a smaller factor or a smaller picture.") throw new Error("RTX past 8192: " + capRtx);
    if ($("up-go").disabled) throw new Error("Upscale stays greyed after the size came back: " + $("up-size-note").textContent);
    // a graph that reads the canvas node's mask: the whole picture refused by name, the selection still runs
    fake = JSON.parse(JSON.stringify(list.find((r) => r.id === "rtx_vsr_local")));
    fake.id = "rtx_vsr_gate_mask"; fake.name = "RTX gate (reads the mask)";
    fake.prompt.mask = { class_type: "MaskToImage", inputs: { mask: ["canvas", 1] } };
    list.push(fake);
    $("up-cancel").click(); await wait(60);
    host.shell.openUpscale(ed);
    pick(fake.id); scopeDoc();
    const maskNote = $("up-size-note").textContent;
    if (!$("up-go").disabled || maskNote !== "RTX gate (reads the mask) reads more than the picture from the canvas node (its crop_mask); it cannot upscale the whole picture.") throw new Error("the mask graph: " + maskNote);
    $("up-scope-sel").checked = true; $("up-scope-sel").dispatchEvent(new Event("change"));
    if ($("up-go").disabled) throw new Error("the mask graph's selection is greyed: " + $("up-size-note").textContent);
    $("up-cancel").click(); await wait(60);

    // Upscale from the dialog: rtx at 2x on the whole picture
    host.shell.openUpscale(ed);
    pick("rtx_vsr_local"); scopeDoc(); setFactor(2);
    const L0 = ed.layers.find((l) => l.id === paint.id);
    const before = { layer: { x: L0.x, y: L0.y, w: L0.w, h: L0.h }, sel: ed.getBounds(), undo: ed.undo.length, mid: pixel(ed.basePx, 320, 240) };
    const seen = [];
    commands.run = async (n, a) => {
        if (n !== "upscale") return saved.run.call(commands, n, a);
        try { const r = await saved.run.call(commands, n, a); seen.push({ args: a, out: r }); return r; } catch (err) { seen.push({ args: a, error: String(err.message || err) }); throw err; }
    };
    T.onQueued = answerWith(ANS);
    $("up-go").click();
    for (let k = 0; k < 400 && !seen.length; k++) await wait(50);
    commands.run = saved.run;
    T.onQueued = null;
    if (!seen.length) throw new Error("the dialog ran no upscale: " + ed.status);
    const got = seen[0];
    if (got.error) throw new Error("the dialog's run failed: " + got.error + (T.err ? " (" + T.err + ")" : ""));
    if (got.args.scope !== "document" || got.args.factor !== 2) throw new Error("the dialog sent " + JSON.stringify(got.args));
    const o = got.out;
    if (o.scope !== "document" || o.recipe !== "rtx_vsr_local" || o.provider !== null || o.factor !== 2 || JSON.stringify(o.from) !== "[640,480]" || o.width !== 1280 || o.height !== 960 || JSON.stringify(o.answered) !== "[1280,960]") throw new Error("the answer: " + JSON.stringify(o));
    // what went out: one prompt at the back of the queue, a helper; the canvas node a loader of the uploaded base; the
    // factor and Quality written; a PreviewImage on the result; the recipe's own graph untouched
    if (T.queued.length !== 1) throw new Error("queued " + T.queued.length + " prompts");
    const q = T.queued[0], P_ = q.body.output;
    if (q.n !== 0 || !(q.body.workflow && q.body.workflow.extra && q.body.workflow.extra.inpaint_canvas_helper)) throw new Error("not queued at the back as a helper: " + JSON.stringify({ n: q.n, wf: q.body.workflow }));
    const sref = JSON.parse((P_.canvas && P_.canvas.inputs && P_.canvas.inputs.ref) || "null");
    if (P_.canvas.class_type !== "InpaintCanvasLoadRef" || Object.keys(P_.canvas.inputs).length !== 1 || !sref || sref.type !== "input" || sref.subfolder !== "inpaint_canvas" || !T.ensured.some((x) => x.filename === sref.filename)) throw new Error("the loader: " + JSON.stringify({ canvas: P_.canvas, ensured: T.ensured }));
    if (P_.rtx.inputs["resize_type.scale"] !== 2 || P_.rtx.inputs.quality !== "HIGH" || JSON.stringify(P_.img0.inputs.image) !== JSON.stringify(["canvas", 0])) throw new Error("the graph: " + JSON.stringify({ rtx: P_.rtx.inputs, img0: P_.img0.inputs }));
    if (!P_.scumble_out || P_.scumble_out.class_type !== "PreviewImage" || JSON.stringify(P_.scumble_out.inputs.images) !== JSON.stringify(["rtx", 0])) throw new Error("the answer's node: " + JSON.stringify(P_.scumble_out));
    if (host.recipe.prompt.canvas.class_type !== "InpaintCanvas" || host.recipe.prompt.scumble_out) throw new Error("the run changed the recipe's own graph");
    // the picture that went out: the base at its size
    const sent = await decode(await viewBytes(sref));
    if (sent.w !== 640 || sent.h !== 480 || !near(sent.at(320, 240), before.mid, 2)) throw new Error("the picture sent: " + JSON.stringify({ w: sent.w, h: sent.h, mid: sent.at(320, 240), base: before.mid }));
    // busy like a run while it waited
    const d = T.during || {};
    if (!d.token || d.token.provider !== "comfyui" || d.token.label !== "RTX Video Super Resolution (ComfyUI)" || !d.row) throw new Error("the document was not busy like a run: " + JSON.stringify(d));
    if (!d.pending || d.pending.provider !== true || !d.turn || !/a run is still going on this document/.test(d.generate || "")) throw new Error("while it waited: " + JSON.stringify(d));
    out.during = d;
    // the landing: 2x, the layer and the selection scaled along, the base the answer, one undo step, nothing held
    if (ed.width !== 1280 || ed.height !== 960) throw new Error("not 2x: " + ed.width + "x" + ed.height);
    const L1 = ed.layers.find((l) => l.id === paint.id);
    if (L1.x !== 60 || L1.y !== 80 || L1.w !== 200 || L1.h !== 120) throw new Error("the paint layer was not scaled along: " + JSON.stringify({ x: L1.x, y: L1.y, w: L1.w, h: L1.h }));
    const sb = ed.getBounds();
    if (!sb || Math.abs(sb[0] - 400) > 2 || Math.abs(sb[1] - 200) > 2 || Math.abs(sb[2] - 560) > 2 || Math.abs(sb[3] - 300) > 2) throw new Error("the selection was not scaled along: " + JSON.stringify(sb));
    if (!magenta(pixel(ed.basePx, 1, 1)) || !near(pixel(ed.basePx, 640, 480), before.mid, 12)) throw new Error("the base is not the answer: " + JSON.stringify({ corner: pixel(ed.basePx, 1, 1), mid: pixel(ed.basePx, 640, 480), was: before.mid }));
    if (ed.undo.length !== before.undo + 1) throw new Error("not one undo step: " + (ed.undo.length - before.undo));
    if (ed.providerPending || host._providerRuns.size || (ed._localRuns && ed._localRuns.size)) throw new Error("the document stays busy after the landing");
    if (!/upscaled the picture in \\d+ s: 640 × 480 is now 1280 × 960, every layer scaled along/.test(ed.status)) throw new Error("the status: " + ed.status);
    out.status = ed.status;
    await ed.undoStep();
    const L2 = ed.layers.find((l) => l.id === paint.id);
    if (ed.width !== 640 || ed.height !== 480 || L2.x !== 30 || L2.y !== 40 || L2.w !== 100 || L2.h !== 60) throw new Error("Ctrl+Z did not bring the picture and the layer back: " + ed.width + "x" + ed.height + " " + JSON.stringify({ x: L2.x, y: L2.y, w: L2.w, h: L2.h }));
    if (JSON.stringify(ed.getBounds()) !== JSON.stringify(before.sel)) throw new Error("Ctrl+Z did not bring the selection back: " + JSON.stringify(ed.getBounds()) + " vs " + JSON.stringify(before.sel));
    if (magenta(pixel(ed.basePx, 1, 1))) throw new Error("Ctrl+Z did not bring the old base back");
    await ed.redoStep();
    if (ed.width !== 1280) throw new Error("redo did not upscale again");
    await ed.undoStep();
    if (ed.width !== 640) throw new Error("the second undo did not bring 640 back");

    // the upscale model (a fixed factor: none written) through the command: Cancel takes its job off the server and
    // changes nothing; then it runs
    host.shell.selectRecipe("upscale_model_local");
    ed.settings["1"] = { value: "2xESRGAN.pth" };
    T.queued.length = 0; T.cancels.length = 0;
    T.onQueued = () => { host.cancelProviderRuns(); };
    let cerr = null;
    try { await run("upscale", { doc: window.__u, scope: "document", timeout: 60 }); } catch (err) { cerr = String(err.message || err); }
    T.onQueued = null;
    if (!cerr || cerr !== "Upscale model (ComfyUI) cancelled.") throw new Error("Cancel: " + cerr);
    if (T.queued.length !== 1 || !T.cancels.includes(T.queued[0].id)) throw new Error("the cancelled job was not taken off: " + JSON.stringify({ queued: T.queued.map((x) => x.id), cancels: T.cancels }));
    if (ed.width !== 640 || ed.providerPending || host._providerRuns.size || (ed._localRuns && ed._localRuns.size)) throw new Error("Cancel left the document changed or busy");
    const Pm = T.queued[0].body.output;
    if (Pm.canvas.class_type !== "InpaintCanvasLoadRef" || Pm.loader.inputs.model_name !== "2xESRGAN.pth" || JSON.stringify(Pm.scumble_out.inputs.images) !== JSON.stringify(["up", 0]) || JSON.stringify(Pm.up.inputs) !== JSON.stringify({ upscale_model: ["loader", 0], image: ["img0", 0] })) throw new Error("the upscale model's prompt: " + JSON.stringify(Pm));
    out.cancel = cerr;
    T.queued.length = 0; T.checked = false;
    T.onQueued = answerWith(ANS);
    const um = await run("upscale", { doc: window.__u, scope: "document", timeout: 60 });
    T.onQueued = null;
    if (um.factor !== null || um.width !== 1280 || um.height !== 960 || ed.width !== 1280) throw new Error("the upscale model's run: " + JSON.stringify(um));
    await ed.undoStep();
    if (ed.width !== 640) throw new Error("Ctrl+Z after the upscale model");
    out.model = { factor: um.factor, width: um.width };

    // refusals, before anything is uploaded or queued: a busy document (a render, a run), the mask graph
    const q1 = T.queued.length;
    ed._localRuns = ed._localRuns || new Set();
    ed._localRuns.add("gate-u2-other");
    try { out.busyRender = await refused(window.__u, {}, /A render on your ComfyUI is still running/); } finally { ed._localRuns.delete("gate-u2-other"); }
    const fakeTok = { provider: "loopback", label: "x", editor: ed };
    ed.providerPending = fakeTok;
    try {
        out.busyRun = await refused(window.__u, {}, /a run is still going on this document/);
        try { await host.runComfyUpscale(ed, {}); throw new Error("the host ran on a busy document"); }
        catch (err) { if (!/A run is still going on this document/.test(String(err.message))) throw err; }
    } finally { if (ed.providerPending === fakeTok) ed.providerPending = null; }
    host.setRecipe(fake);
    out.mask = await refused(window.__u, {}, /reads more than the picture from the canvas node \\(its crop_mask\\); it cannot upscale the whole picture/);
    // the caps, a bad factor, no server, the loader missing: on a 2100 x 100 picture
    const d2 = await run("new_document");
    wide = d2.id;
    const ew = ednow(wide);
    host.shell.activate(ew);
    const c = document.createElement("canvas"); c.width = 2100; c.height = 100;
    const g = c.getContext("2d"); g.fillStyle = "rgb(120, 90, 60)"; g.fillRect(0, 0, 2100, 100);
    await ew.setBaseFromCanvas(c);
    host.shell.selectRecipe("rtx_vsr_local");
    out.cap8192 = await refused(wide, { factor: 4 }, /^The picture is 2100 × 100; at 4× the answer would pass 8192 px on the long side\\. Pick a smaller factor or a smaller picture\\.$/);
    out.factor5 = await refused(wide, { factor: 5 }, /1 to 4, not 5/);
    host.connected = false;
    try { out.offline = await refused(wide, {}, /Not connected to ComfyUI/); } finally { host.connected = true; }
    host.objectInfo = { ...OI, InpaintCanvasLoadRef: undefined };
    try { out.lacks = await refused(wide, {}, /lacks these node types: InpaintCanvasLoadRef/); } finally { host.objectInfo = OI; }
    host.shell.selectRecipe("upscale_model_local");
    out.cap2048 = await refused(wide, {}, /^The picture is 2100 × 100; Upscale model \\(ComfyUI\\) takes at most 2048 px on the long side\\. Pick a smaller picture\\.$/);
    // the 2048 cap is the whole picture's alone: the selection's box keeps none (an upscale model on a large box worked before)
    const umR = host.shell.recipes().find((x) => x.id === "upscale_model_local");
    if (host.upscaleSizeRefusal(umR, 3000, 3000, null, "box") !== "") throw new Error("the upscale model refused a 3000 px box: " + host.upscaleSizeRefusal(umR, 3000, 3000, null, "box"));
    out.boxUncapped = true;
    if (ew.width !== 2100 || ew.providerPending || T.queued.length !== q1) throw new Error("a refusal changed the picture or queued");
    return out;
} finally {
    commands.run = saved.run;
    T.onQueued = null;
    host.connected = saved.connected; host.objectInfo = saved.objectInfo; host.ensureRefs = saved.ensureRefs; api.queuePrompt = saved.queue; api.fetchApi = saved.fetchApi;
    host.setServerStatus({ state: saved.server.state || "disconnected", os: saved.server.os || "", gpus: saved.server.gpus || [], remote: !!saved.server.remote, url: saved.server.url || "", version: saved.server.version || "" });
    if ($("up-dialog").open) $("up-cancel").click();
    if (fake && list.includes(fake)) list.splice(list.indexOf(fake), 1);
    if (wide) { try { await run("close_document", { doc: wide, force: true }); } catch (_) { /* gone */ } }
    host.shell.activate(ed);
    if (paint) { try { await run("remove_layer", { doc: window.__u, layer: paint.id }); } catch (_) { /* gone */ } }
    // the window's recipe as the step found it, through the shell (CLAUDE.md: a gate that switches a recipe puts it back)
    if (recipe0 && (!host.recipe || host.recipe.id !== recipe0.id)) host.shell.selectRecipe(recipe0.id, recipe0.kind === "provider" ? recipe0.provider : undefined);
}
"""),
    # docs/PLAN_0_1_42.md R3b: the Realism Pass entry. 1x only, the whole picture only (the selection greyed with its
    # reason, usable again for the next entry), its Style / Strength / Preset row writing settings.realism whole, the
    # note and a greyed Upscale for a server or a size that refuses it, Upscale running realism_pass (host.realismWhole
    # stubbed: nothing is read or sent) without selecting the recipe, and the Image menu's item opening it chosen
    ("the_realism_pass_entry", """
const ed = ednow(window.__u);
const LABEL = "Realism Pass (Windows only, RTX only)";
const shell = await import("./shell.js");
const $ = (id) => document.getElementById(id);
const pick = (id) => { const s = $("up-recipe"); s.value = id; s.dispatchEvent(new Event("change")); };
const resync = () => $("up-scope-doc").dispatchEvent(new Event("change"));
const nodeInfo = () => ({ input: { required: {} } });
const OI = { InpaintCanvas: nodeInfo(), InpaintCanvasLoadRef: nodeInfo(), ImageFromBatch: nodeInfo(), DLSS5Settings: nodeInfo(), DLSS5EnhanceImages: nodeInfo() };
const GOOD = { state: "connected", os: "win32", gpus: ["cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync"], url: "http://127.0.0.1:8188", version: "0.38.0" };
const saved = { connected: host.connected, objectInfo: host.objectInfo, server: { ...(host.server || {}) }, realism: host.realismStored, whole: host.realismWhole, stored: (await window.scumble.settings.get()).realism, upscaleRecipe: (await window.scumble.settings.get()).upscaleRecipe, run: commands.run };
const recipe0 = host.recipe;
const seen = [];
const out = {};
try {
    host.connected = true; host.objectInfo = OI; host.setServerStatus(GOOD);
    await run("select_rect", { doc: window.__u, x: 20, y: 20, w: 100, h: 80 });
    host.shell.openUpscale(ed);
    if (!$("up-dialog").open) throw new Error("the dialog did not open");
    const recs = Array.from($("up-recipe").options).map((o) => [o.value, o.textContent]);
    const entry = recs.find(([id]) => id === "realism_pass");
    if (!entry || entry[1] !== LABEL) throw new Error("the pass entry: " + JSON.stringify(entry));
    if (!$("up-scope-sel").checked || !$("up-pass-row").hidden) throw new Error("before the pass: the selection is not chosen, or the pass row shows");
    // an upscaler with a prompt row and a factor other than its default before the pass: the pass hides the row itself,
    // and the upscaler shown after it keeps its own factor, not the pass's 1x
    pick("clarity_upscaler");
    if ($("up-prompt-row").hidden) throw new Error("the prompt row does not show for an upscaler that takes one");
    pick("topaz_precision");
    const topazFactors = Array.from($("up-factor").options).map((o) => +o.value);
    const topazPick = Math.max(...topazFactors);
    if (!(topazPick > 1) || topazPick === +$("up-factor").value) throw new Error("Topaz Precision's factors: " + topazFactors + " (shown " + $("up-factor").value + ")");
    $("up-factor").value = String(topazPick);
    $("up-factor").dispatchEvent(new Event("change"));
    pick("clarity_upscaler");
    pick("realism_pass");
    // 1x only, the whole picture only, no provider and no prompt, the pass row
    const factors = Array.from($("up-factor").options).map((o) => [o.value, o.textContent]);
    if (JSON.stringify(factors) !== JSON.stringify([["1", "1× (refine)"]]) || $("up-factor-row").hidden) throw new Error("the factors: " + JSON.stringify(factors));
    const selLabel = $("up-scope-sel").parentElement;
    if (!$("up-scope-sel").disabled || !$("up-scope-doc").checked || $("up-scope-doc").disabled || selLabel.title !== LABEL + " runs over the whole picture.") throw new Error("the scope: " + JSON.stringify({ sel: $("up-scope-sel").disabled, doc: $("up-scope-doc").checked, title: selLabel.title }));
    if (!$("up-provider-row").hidden || !$("up-prompt-row").hidden || $("up-pass-row").hidden) throw new Error("the rows: " + JSON.stringify({ provider: $("up-provider-row").hidden, prompt: $("up-prompt-row").hidden, pass: $("up-pass-row").hidden }));
    if ($("up-go").disabled || !/^640 × 480 goes out at 1× and comes back as a new layer above the picture/.test($("up-size-note").textContent) || !$("up-note").textContent.startsWith("DLSS 5 Neural Rendering over the whole visible picture")) throw new Error("ready: " + $("up-note").textContent + " / " + $("up-size-note").textContent);
    out.ready = $("up-size-note").textContent.slice(0, 80);
    // the row shows settings.realism as it is (a refused preset's fallback, Default, included)
    host.realismStored = { style: "Natural", intensity: 0.4, preset: "Default", timeout: 120 };
    resync();
    if ($("up-pass-style").value !== "Natural" || +$("up-pass-strength").value !== 0.4 || $("up-pass-strength-v").textContent !== "0.40" || $("up-pass-preset").value !== "Default") throw new Error("the row: " + JSON.stringify({ style: $("up-pass-style").value, strength: $("up-pass-strength").value, preset: $("up-pass-preset").value }));
    const styles = Array.from($("up-pass-style").options).map((o) => o.value), presets = Array.from($("up-pass-preset").options).map((o) => o.value);
    if (styles.join() !== "Default,Natural,Cinematic" || presets.join() !== "Default,J,K,L,M") throw new Error("the options: " + styles + " / " + presets);
    // each control writes settings.realism whole: the stored object holds all four keys after every change
    const stored = async () => (await window.scumble.settings.get()).realism;
    const set = async (el, value) => { el.value = value; el.dispatchEvent(new Event("change")); for (let k = 0; k < 20; k++) { await wait(50); } };
    await set($("up-pass-style"), "Cinematic");
    let s = await stored();
    if (JSON.stringify(s) !== JSON.stringify({ style: "Cinematic", intensity: 0.4, preset: "Default", timeout: 120 })) throw new Error("after Style: " + JSON.stringify(s));
    $("up-pass-strength").value = "0.65";
    $("up-pass-strength").dispatchEvent(new Event("input"));
    if ($("up-pass-strength-v").textContent !== "0.65") throw new Error("the strength's value: " + $("up-pass-strength-v").textContent);
    await set($("up-pass-strength"), "0.65");
    s = await stored();
    if (JSON.stringify(s) !== JSON.stringify({ style: "Cinematic", intensity: 0.65, preset: "Default", timeout: 120 })) throw new Error("after Strength: " + JSON.stringify(s));
    // the preset set back after a fallback
    await set($("up-pass-preset"), "L");
    s = await stored();
    if (JSON.stringify(s) !== JSON.stringify({ style: "Cinematic", intensity: 0.65, preset: "L", timeout: 120 }) || host.realismValues().preset !== "L") throw new Error("after Preset: " + JSON.stringify(s));
    out.stored = s;
    // a server that cannot: the reason in the note, Upscale greyed; the open dialog follows the status by itself
    host.setServerStatus({ ...GOOD, os: "linux" });
    if (!$("up-go").disabled || $("up-note").textContent !== LABEL + " runs only on a ComfyUI on Windows; this one runs on linux.") throw new Error("linux: " + $("up-note").textContent);
    out.linux = $("up-note").textContent;
    host.setServerStatus({ state: "disconnected" });
    if (!$("up-go").disabled || !$("up-note").textContent.startsWith(LABEL + " needs your own ComfyUI")) throw new Error("not connected: " + $("up-note").textContent);
    host.setServerStatus(GOOD);
    if ($("up-go").disabled) throw new Error("Upscale stays greyed after the server came back: " + $("up-note").textContent);
    // a preset written behind the dialog (a refused preset's fallback) shows in it at once
    await host.setRealismValues({ preset: "M" });
    if ($("up-pass-preset").value !== "M") throw new Error("the preset written behind the dialog: " + $("up-pass-preset").value);
    await set($("up-pass-preset"), "L");
    // a picture past the cap: the size note says so, Upscale greyed
    const w0 = ed.width, h0 = ed.height;
    ed.width = 7681; ed.height = 100;
    resync();
    const capNote = $("up-size-note").textContent, capGo = $("up-go").disabled;
    ed.width = w0; ed.height = h0;
    if (!capGo || capNote !== LABEL + " takes at most 7680 × 4320 (long × short side); this is 7681 × 100.") throw new Error("past the cap: " + capNote);
    out.cap = capNote;
    resync();
    if ($("up-go").disabled) throw new Error("Upscale stays greyed after the size came back: " + $("up-size-note").textContent);
    // another entry: the selection usable again and chosen as before the pass, the pass row gone, the factor its own
    pick("topaz_precision");
    if ($("up-scope-sel").disabled || !$("up-scope-sel").checked || selLabel.title || !$("up-pass-row").hidden) throw new Error("after the pass: " + JSON.stringify({ disabled: $("up-scope-sel").disabled, checked: $("up-scope-sel").checked, title: selLabel.title, row: $("up-pass-row").hidden }));
    if (+$("up-factor").value !== topazPick) throw new Error("the upscaler after the pass shows " + $("up-factor").value + "x, not its " + topazPick + "x");
    pick("upscale_model_local");
    if ($("up-scope-sel").disabled || !$("up-pass-row").hidden) throw new Error("a ComfyUI upscaler after the pass");
    // Upscale runs realism_pass on this document, with the dialog's long timeout; the window's recipe stays
    pick("realism_pass");
    const calls = [];
    host.realismWhole = async (e, o) => { calls.push({ e, o, at: Date.now() }); e.setStatus("stubbed pass"); return { layer: null, seconds: 0, note: "", changed: false }; };
    commands.run = async (n, a) => { seen.push({ n, a }); return saved.run.call(commands, n, a); };
    $("up-go").click();
    for (let k = 0; k < 100 && !calls.length; k++) await wait(50);
    if (calls.length !== 1 || calls[0].e !== ed) throw new Error("the pass did not run on this document: " + calls.length);
    const left = calls[0].o.deadline - calls[0].at;
    if (!(left > 1790000 && left <= 1800000)) throw new Error("the deadline: " + left + " ms");
    const ran = seen.filter((x) => x.n === "realism_pass" || x.n === "upscale");
    if (ran.length !== 1 || ran[0].n !== "realism_pass" || JSON.stringify(ran[0].a) !== JSON.stringify({ doc: window.__u, timeout: 1800 })) throw new Error("the command: " + JSON.stringify(ran));
    if ($("up-dialog").open) throw new Error("the dialog stayed open");
    if (host.recipe !== recipe0) throw new Error("the pass selected a recipe: " + (host.recipe && host.recipe.id));
    if ((await window.scumble.settings.get()).upscaleRecipe !== saved.upscaleRecipe) throw new Error("the pass was remembered as the upscaler");
    out.deadline = left;
    // the Image menu's item: the dialog with the pass chosen and its one factor, whatever the window's upscaler is; the
    // upscaler's dialog opened afterwards shows its own factor, not the pass's 1x
    host.shell.selectRecipe("topaz_precision");
    shell.menuCommand("realism-pass");
    await wait(60);
    const menuFactors = JSON.stringify(Array.from($("up-factor").options).map((o) => [o.value, o.textContent]));
    if (!$("up-dialog").open || $("up-recipe").value !== "realism_pass" || $("up-pass-row").hidden || !$("up-scope-sel").disabled || menuFactors !== JSON.stringify([["1", "1× (refine)"]]) || $("up-factor-row").hidden) throw new Error("the menu item: " + JSON.stringify({ open: $("up-dialog").open, value: $("up-recipe").value, factors: menuFactors }));
    $("up-cancel").click();
    await wait(60);
    host.shell.openUpscale(ed);
    if ($("up-recipe").value !== "topaz_precision" || +$("up-factor").value !== topazPick) throw new Error("the next Upscale after the pass: " + $("up-recipe").value + " at " + $("up-factor").value + "x");
    $("up-cancel").click();
    await wait(60);
    return out;
} finally {
    commands.run = saved.run;
    host.realismWhole = saved.whole;
    host.connected = saved.connected; host.objectInfo = saved.objectInfo;
    host.setServerStatus({ state: saved.server.state || "disconnected", os: saved.server.os || "", gpus: saved.server.gpus || [], remote: !!saved.server.remote, url: saved.server.url || "", version: saved.server.version || "" });
    if (saved.stored && typeof saved.stored === "object") await window.scumble.settings.set({ realism: saved.stored });
    host.realismStored = saved.realism;
    if ($("up-dialog").open) $("up-cancel").click();
    // the window's recipe as the step found it (the menu part selected an upscaler)
    if (recipe0 && (!host.recipe || host.recipe.id !== recipe0.id)) host.shell.selectRecipe(recipe0.id);
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
    # docs/PLAN_0_1_42.md U2: the whole picture's prompt (renderer/editor/comfyprompt.js); stderr carries Node's note that
    # it read the module as an ES module, so stdout alone is judged
    c = subprocess.run(["node", os.path.join(ROOT, "tools", "comfyprompt_test.js")], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=120)
    ctail = c.stdout.strip()
    if c.returncode != 0 or not ctail.endswith("PASS"):
        raise Exception("tools/comfyprompt_test.js: " + (ctail + c.stderr)[-1500:])
    return {"checks": tail.count("[ok]"), "comfyprompt": ctail.count("[ok]")}


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
