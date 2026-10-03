"""Generate new: a base image from the prompt alone, against the loopback provider.

No ComfyUI, no API key. Checks the API path end to end (the answer becomes the base image,
the aspect ratio and the free size are honoured, a model without a text shape is refused)
and that the dialog opens and computes the size it will ask for. The local path needs a
real ComfyUI and is exercised by hand; `python tools/generate_test.py` is the gate.

    python tools/generate_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

LOOP_REFS = """{ id: "loopback_refs", kind: "provider", provider: "loopback", providerLabel: "Loopback", model: "loopback", input: "edit", text: { model: "loopback", refs: {} }, refs: { name: "image {n}" }, name: "Loopback refs", settings: [] }"""

# a recipe the dialog lists: a loopback variant whose text shape takes reference pictures (26f)
FAKE = """{ id: "loopback_refs_dialog", kind: "provider", name: "Loopback refs", family: "test", default: "loopback", providerIds: ["loopback"], providers: { loopback: { model: "loopback", input: "edit", settings: [], fields: null, options: null, fixed: null, note: "", edit: true, refs: { name: "image {n}" }, limits: { min: 64, max: 2048, step: 16, pixels: 0, minPixels: 0, ratio: 0, aspects: [] }, text: { model: "loopback", sizes: [512, 1024], fixed: null, settings: [], note: "", refs: { max: null, field: null, model: null, options: null, name: null } } } } }"""

STEPS_26F = [
    # 26f: a reference layer can start an empty tab; the white canvas under it is what Generate new replaces
    ("refs_in_an_empty_tab", """
const d = await run("new_document");
window.__r = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
if (ed.width) throw new Error("a new tab has a picture: " + ed.width);
if (!ed.refContext().canAdd) throw new Error("canAdd is false in an empty tab (host.refTokens)");
const l = await run("add_image_layer", { doc: d.id, filename: "test_base.png", subfolder: "inpaint_canvas", type: "input", role: "reference" });
if (ed.width !== 1024 || ed.height !== 1024) throw new Error("the empty tab got " + ed.width + "x" + ed.height + ", not a 1024 x 1024 canvas");
const refs = ed.referenceLayers();
if (refs.length !== 1 || refs[0].id !== l.id) throw new Error("the reference: " + JSON.stringify(refs.map((x) => x.name)));
const px = ed.basePx.readRect(5, 5, 1, 1).data;
if (px[0] < 250 || px[1] < 250 || px[2] < 250) throw new Error("the canvas under the reference is not white: " + [px[0], px[1], px[2]]);
// a picture layer still needs a picture
const d2 = await run("new_document");
let msg = "";
try { await run("add_image_layer", { doc: d2.id, filename: "test_base.png", subfolder: "inpaint_canvas", type: "input", role: "none" }); }
catch (err) { msg = String(err.message || err); }
try { await run("close_document", { doc: d2.id, force: true }); } catch (_) { /* gone */ }
if (!/no image loaded/.test(msg)) throw new Error("role none in an empty tab: " + msg);
host.shell.activate(ed);
return { size: [ed.width, ed.height], ref: l.id, refused: msg };
"""),
    # 26f: the shown references go along to a text shape that takes them, named "image 1" (no crop before them); the
    # reference layers stay with their ids, order and pixels, every other layer goes with the old base
    ("text_with_references", """
const ed = ednow(window.__r);
const prev = host.recipe;
const A = ed.referenceLayers()[0].id;
const b = await run("add_image_layer", { doc: window.__r, filename: "test_base.png", subfolder: "inpaint_canvas", type: "input", role: "reference" });
const B = b.id;
const paint = await run("add_paint_layer", { doc: window.__r, name: "paint" });
if (ed.refSnapshot().refIds.join() !== [A, B].join()) throw new Error("the references before: " + ed.refSnapshot().refIds);
const layerOf = (id) => ed.layers.find((l) => l.id === id);
const pxBefore = [layerOf(A).px, layerOf(B).px];
const sample = (id) => Array.from(layerOf(id).px.readRect(3, 3, 1, 1).data).join();
const sampleBefore = [sample(A), sample(B)];
host.setRecipe(__LOOP_REFS__);
let out;
try { out = await run("generate_new", { doc: window.__r, prompt: "the jacket of @img2 on the person of @img1", aspect: "16:9", resolution: 1024, seed: 7 }); }
finally { host.setRecipe(prev); }
if (!out.info || out.info.references !== 2) throw new Error("the loopback got " + JSON.stringify(out.info));
if (out.prompt_sent !== "the jacket of image 2 on the person of image 1" || out.info.prompt !== out.prompt_sent) throw new Error("sent: " + JSON.stringify([out.prompt_sent, out.info.prompt]));
const want = [{ label: "img1", id: A, sentAs: "image 1" }, { label: "img2", id: B, sentAs: "image 2" }];
if (JSON.stringify(out.references) !== JSON.stringify(want)) throw new Error("references: " + JSON.stringify(out.references));
if (out.kept !== 2 || out.dropped !== 1) throw new Error("kept / dropped: " + out.kept + " / " + out.dropped);
if (ed.width !== 1024 || ed.height !== 576) throw new Error("16:9 at 1024: " + ed.width + "x" + ed.height);
if (layerOf(paint.id)) throw new Error("the paint layer stayed");
if (ed.refSnapshot().refIds.join() !== [A, B].join()) throw new Error("the references after: " + ed.refSnapshot().refIds);
if (ed.promptText !== "the jacket of @img2 on the person of @img1") throw new Error("the tab's prompt: " + ed.promptText);
for (const l of ed.referenceLayers()) if (l.x < 0 || l.y < 0 || l.x + l.w > 1024 || l.y + l.h > 576) throw new Error("a reference outside the new canvas: " + JSON.stringify([l.x, l.y, l.w, l.h]));
if (layerOf(A).px !== pxBefore[0] || layerOf(B).px !== pxBefore[1]) throw new Error("a reference's pixels were replaced");
if (sample(A) !== sampleBefore[0] || sample(B) !== sampleBefore[1]) throw new Error("a reference's pixels changed");
if (!/@img2 . image 2/.test(ed.status) || !/The reference layers stay, 1 other layer was replaced/.test(ed.status)) throw new Error("the status: " + ed.status);
if (ed._refDrift) throw new Error("the reference labels drifted " + ed._refDrift + " times without a remap");
return { sent: out.prompt_sent, refs: out.references.length, kept: out.kept, dropped: out.dropped, status: ed.status };
""".replace("__LOOP_REFS__", LOOP_REFS)),
    ("hidden_reference_not_sent", """
const ed = ednow(window.__r);
const prev = host.recipe;
const [A, B] = ed.refSnapshot().refIds;
await run("set_layer", { doc: window.__r, layer: B, visible: false });
host.setRecipe(__LOOP_REFS__);
let out;
try { out = await run("generate_new", { doc: window.__r, prompt: "a portrait after @img1", aspect: "1:1", resolution: 768 }); }
finally { host.setRecipe(prev); }
if (out.info.references !== 1 || out.kept !== 2) throw new Error("a hidden reference: sent " + out.info.references + ", kept " + out.kept);
const bl = ed.layers.find((l) => l.id === B);
if (!bl || bl.visible) throw new Error("the hidden reference was not kept hidden");
await run("set_layer", { doc: window.__r, layer: B, visible: true });
if (ed.refSnapshot().refIds.join() !== [A, B].join()) throw new Error("the references after showing it again: " + ed.refSnapshot().refIds);
return { sent: out.info.references, kept: out.kept };
""".replace("__LOOP_REFS__", LOOP_REFS)),
    ("refuses", """
const ed = ednow(window.__r);
const prev = host.recipe;
const base = __LOOP_REFS__;
const w0 = ed.width, ids0 = ed.layers.map((l) => l.id).join();
const refused = async (recipe, args, re, what) => {
    host.setRecipe(recipe);
    let msg = "";
    try { await run("generate_new", { doc: window.__r, aspect: "1:1", resolution: 512, ...args }); }
    catch (err) { msg = String(err.message || err); }
    finally { host.setRecipe(prev); }
    if (!re.test(msg)) throw new Error(what + ": " + msg);
    if (ed.width !== w0 || ed.layers.map((l) => l.id).join() !== ids0) throw new Error(what + ": the refused run changed the tab");
    return msg;
};
const out = {};
out.cap = await refused({ ...base, text: { model: "loopback", refs: { max: 1 } } }, { prompt: "the two of them" }, /takes at most 1 reference picture for a new image; this run has 2: hide reference layers/, "past text.refs.max");
out.alone = await refused({ ...base, text: { model: "loopback" } }, { prompt: "a room like @img1" }, /makes new images from the prompt alone/, "a token on a text shape without refs");
// without a token such a model runs, sends no picture and keeps the references
host.setRecipe({ ...base, text: { model: "loopback" } });
let o;
try { o = await run("generate_new", { doc: window.__r, prompt: "a quiet lake", aspect: "1:1", resolution: 512 }); }
finally { host.setRecipe(prev); }
if (o.info.references !== 0 || o.kept !== 2 || ed.referenceLayers().length !== 2) throw new Error("prompt alone: sent " + o.info.references + ", kept " + o.kept);
out.alone_runs = [o.width, o.height];
return out;
""".replace("__LOOP_REFS__", LOOP_REFS)),
    # generate_new's local path checks the run's tokens and the server before the canvas replaces the picture (the
    # review of 26f: it used to wipe the tab first)
    ("local_refuses_before_the_wipe", """
const ed = ednow(window.__r);
const prev = host.recipe;
const before = () => [ed.width, ed.height, ed.layers.map((l) => l.id).join(), !!ed.base].join("|");
const b0 = before();
const stub = { id: "comfy_one_slot", kind: "comfy", name: "Comfy one slot", mode: "local", result: "9:0", canvas: "1", refs: { name: "image {n}", slots: 1 }, prompt: { "1": { class_type: "InpaintCanvas", inputs: {} } }, settings: [], needs: [] };
const refused = async (args, re, what) => {
    host.setRecipe(stub);
    let msg = "";
    try { await run("generate_new", { doc: window.__r, width: 640, height: 640, ...args }); } catch (err) { msg = String(err.message || err); }
    finally { host.setRecipe(prev); }
    if (!re.test(msg)) throw new Error(what + ": " + msg);
    if (before() !== b0) throw new Error(what + ": the refused run changed the tab");
    return msg;
};
const out = {};
out.token = await refused({ prompt: "a barn in the style of @img1" }, /@img1 cannot be named: Comfy one slot reads the crop alone/, "a token past the slots");
out.offline = await refused({ prompt: "a barn" }, /Not connected to ComfyUI/, "no server");
return out;
"""),
    # generate_new's local path keeps the references on its fresh canvas (the live ComfyUI run is left out: 8188 is
    # a production machine)
    ("local_keeps_refs", """
const ed = ednow(window.__r);
const ids = ed.refSnapshot().refIds;
const w0 = ed.width;
await run("add_paint_layer", { doc: window.__r, name: "paint" });
await ed.newCanvas("1024x768", { keepRefs: true });
if (ed.width !== 1024 || ed.height !== 768 || w0 === 1024) throw new Error("the new canvas: " + ed.width + "x" + ed.height + " from " + w0);
if (ed.refSnapshot().refIds.join() !== ids.join() || ed.layers.length !== ids.length || ed.layers.some((l) => !ed.isReference(l))) throw new Error("the layers: " + ed.layers.map((l) => l.name));
// placed again for the new long side, k the place in the kept list as setBasePixels counts it
ed.layers.forEach((l, k) => { const b = ed.referenceBox(l.px, k); if (l.x !== b.x || l.y !== b.y || l.w !== b.w || l.h !== b.h) throw new Error("not placed again: " + JSON.stringify([l.x, l.y, l.w, l.h, b])); });
if (!/The reference layers stay/.test(ed.status)) throw new Error("the status: " + ed.status);
return { refs: ids.length, box: [ed.layers[0].w, ed.layers[0].h], status: ed.status };
"""),
    # the dialog: the prompt field with chips, the reference bar and what each goes as with the dialog's own model
    ("dialog_field_and_bar", """
const ed = ednow(window.__r);
host.shell.activate(ed);
const list = host.shell.recipes();
const fake = __FAKE__;
list.push(fake);
window.__genFake = fake;
await run("set_prompt", { doc: window.__r, text: "the coat of @img2 on @img1" });
await host.shell.openGenerateNew(ed);
const pick = (id, v) => { const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event("change")); };
pick("gen-mode", "api");
pick("gen-recipe", fake.id);
pick("gen-provider", "loopback");
await host.shell.genSyncRefs();
await wait(150);
const f = host.shell.genField();
if (!f || f.el.id !== "gen-prompt" || f.el.contentEditable !== "plaintext-only") throw new Error("the dialog's prompt is no prompt field");
if (f.el.value !== "the coat of @img2 on @img1") throw new Error("the prefill: " + JSON.stringify(f.el.value));
if (f.el.querySelectorAll(".ipc-chip").length !== 2) throw new Error("chips in the field: " + f.el.querySelectorAll(".ipc-chip").length);
const sent = f.fullContext().refs.filter((x) => x.label != null).map((x) => x.sentAs);
if (sent.join() !== "image 1,image 2") throw new Error("sent as: " + JSON.stringify(sent));
const chips = document.querySelectorAll("#gen-refbar .ipc-refbar-chip");
if (chips.length !== 2) throw new Error("bar chips: " + chips.length);
// a variant whose text shape takes no pictures: the bar says so
const refs0 = fake.providers.loopback.text.refs;
fake.providers.loopback.text.refs = null;
await host.shell.genSyncRefs();
await wait(150);
const count = document.querySelector("#gen-refbar .ipc-refbar-count");
const none = count ? count.textContent : "";
fake.providers.loopback.text.refs = refs0;
await host.shell.genSyncRefs();
await wait(150);
if (!/sends no reference images/.test(none)) throw new Error("the bar for a model without references: " + none);
f.focus();
return { sent, none };
""".replace("__FAKE__", FAKE)),
]


async def dialog_escape_closes_the_picker_first(c, pre):
    """A real @ opens the picker; the first Escape closes it and leaves the dialog open, the second closes the dialog."""
    from prompt_field_steps import key, typ
    state = 'await wait(200); const f = host.shell.genField(); return { picker: f.popupOpen(), dialog: document.getElementById("gen-dialog").open, text: f.el.value };'
    await c.eval(pre % 'const f = host.shell.genField(); f.setText("", { history: "reset" }); f.focus(); return 1;')
    await typ(c, "@")
    a = await c.eval(pre % state)
    if not a["picker"] or not a["dialog"]:
        raise Exception("the @ picker did not open in the dialog: %s" % a)
    await key(c, "Escape")
    b = await c.eval(pre % state)
    if b["picker"] or not b["dialog"]:
        raise Exception("the first Escape did not close only the picker: %s" % b)
    # a click on a chip's chevron (the form is method=dialog: it must not close it), the focus on another control, then
    # Escape: the dialog's cancel handler closes the swap menu and keeps the dialog open
    xy = await c.eval(pre % 'const f = host.shell.genField(); f.setText("on @img1 ", { history: "reset" }); await wait(200); document.getElementById("gen-aspect").focus(); const n = f.el.querySelector(".ipc-chip .ipc-chip-chev"); if (!n) throw new Error("no chevron in the dialog field"); const r = n.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2];')
    for kind in ("mousePressed", "mouseReleased"):
        await c.call("Input.dispatchMouseEvent", type=kind, x=xy[0], y=xy[1], button="left", clickCount=1)
    s = await c.eval(pre % 'await wait(250); const f = host.shell.genField(); return { menu: f.popupOpen(), dialog: document.getElementById("gen-dialog").open, focus: document.activeElement && document.activeElement.id };')
    if not s["menu"] or not s["dialog"]:
        raise Exception("a click on a chip's chevron in the dialog: %s" % s)
    await key(c, "Escape")
    t = await c.eval(pre % state)
    if t["picker"] or not t["dialog"]:
        raise Exception("Escape with the swap menu open closed the dialog, or not the menu: %s" % t)
    await key(c, "Escape")
    d = await c.eval(pre % state)
    if d["dialog"]:
        raise Exception("the last Escape did not close the dialog: %s" % d)
    return {"opened": a, "after_first": b, "chevron": s, "after_menu": t, "after_last": d}


STEPS_26F_AFTER = [
    ("dialog_upsample_refs", """
const ed = ednow(window.__r);
const fake = window.__genFake;
const saved = { ask: host.askLLM, backends: host.upsampleBackends, pics: host.llmRefPictures };
let got = null;
try {
    host.upsampleBackends = () => [{ id: "stub", label: "Stub LLM" }];
    host.llmRefPictures = false;
    host.askLLM = async (backend, instruction, canvas, images) => { got = { instruction, images: (images || []).length }; return { text: "a long coat on @img1", seconds: 0.1, note: "" }; };
    await host.shell.openGenerateNew(ed);
    const pick = (id, v) => { const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event("change")); };
    pick("gen-mode", "api");
    pick("gen-recipe", fake.id);
    pick("gen-provider", "loopback");
    const f = host.shell.genField();
    f.setText("the coat of @img2 on @img1");
    document.getElementById("gen-upsample-go").click();
    await wait(400);
    if (!got) throw new Error("the language model was not asked");
    if (!/@img1 \\(the layer/.test(got.instruction) || !/@img2 \\(the layer/.test(got.instruction) || !/Reference tokens: keep every token/.test(got.instruction)) throw new Error("the instruction: " + got.instruction);
    if (f.el.value !== "a long coat on @img1") throw new Error("the answer: " + f.el.value);
    const note = document.getElementById("gen-upsample-note").textContent;
    if (!/dropped @img2/.test(note)) throw new Error("the check did not say @img2 was dropped: " + note);
    const revert = document.getElementById("gen-upsample-revert");
    if (!revert) throw new Error("no Revert button");
    revert.click();
    if (f.el.value !== "the coat of @img2 on @img1") throw new Error("Revert: " + f.el.value);
    return { note, images: got.images };
} finally {
    host.askLLM = saved.ask; host.upsampleBackends = saved.backends; host.llmRefPictures = saved.pics;
    const dlg = document.getElementById("gen-dialog");
    if (dlg.open) dlg.close();
    const list = host.shell.recipes();
    if (list.includes(fake)) list.splice(list.indexOf(fake), 1);
    try { await run("close_document", { doc: window.__r, force: true }); } catch (_) { /* gone */ }
}
"""),
]


STEPS = [
    ("api_text_to_image", """
const d = await run("new_document");
window.__g = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
const prev = host.recipe;
host.setRecipe({ id: "loopback_text", kind: "provider", provider: "loopback", providerLabel: "Loopback", model: "loopback", input: "edit", text: { model: "loopback" }, name: "Loopback", settings: [] });
let out;
try {
    out = await run("generate_new", { doc: d.id, prompt: "a red vintage car", aspect: "16:9", resolution: 1024, seed: 42 });
} finally { host.setRecipe(prev); }
if (!ed.base) throw new Error("no base image after the run");
if (ed.width !== out.width || ed.height !== out.height) throw new Error("size mismatch " + ed.width + "x" + ed.height);
if (ed.width !== 1024 || ed.height !== 576) throw new Error("16:9 at 1024 should be 1024x576, got " + ed.width + "x" + ed.height);
if (ed.layers.length) throw new Error("layers left over: " + ed.layers.length);
// the loopback ramp has a dark border, so the corner must not be white
const px = ed.basePx.readRect(1, 1, 1, 1).data;
if (px[0] > 60) throw new Error("the answer did not become the base image (corner " + px[0] + ")");
return { mode: out.mode, size: [ed.width, ed.height], corner: [px[0], px[1], px[2]], prompt: ed.promptText };
"""),
    ("aspect_free_size", """
const ed = ednow(window.__g);
const prev = host.recipe;
host.setRecipe({ id: "loopback_text", kind: "provider", provider: "loopback", providerLabel: "Loopback", model: "loopback", input: "edit", text: { model: "loopback" }, name: "Loopback", settings: [] });
let out;
try { out = await run("generate_new", { doc: window.__g, prompt: "x", width: 800, height: 600, seed: 1 }); }
finally { host.setRecipe(prev); }
if (ed.width !== 800 || ed.height !== 600) throw new Error("free size ignored: " + ed.width + "x" + ed.height);
return { size: [ed.width, ed.height] };
"""),
    ("refuses_without_a_text_shape", """
const prev = host.recipe;
host.setRecipe({ id: "loopback_edit", kind: "provider", provider: "loopback", providerLabel: "Loopback", model: "loopback", input: "edit", text: null, name: "Loopback", settings: [] });
let msg = "";
try { await run("generate_new", { doc: window.__g, prompt: "x", width: 256, height: 256 }); }
catch (err) { msg = String(err.message || err); }
finally { host.setRecipe(prev); }
if (!/cannot make an image from the prompt alone/i.test(msg)) throw new Error("wrong error: " + msg);
return { error: msg };
"""),
    ("dialog_opens_and_computes_the_size", """
const ed = ednow(window.__g);
await host.shell.openGenerateNew(ed);
const dlg = document.getElementById("gen-dialog");
if (!dlg.open) throw new Error("the dialog did not open");
document.getElementById("gen-aspect").value = "9:16";
document.getElementById("gen-aspect").dispatchEvent(new Event("change"));
document.getElementById("gen-resolution").value = "1536";
document.getElementById("gen-resolution").dispatchEvent(new Event("change"));
const note = document.getElementById("gen-size-note").textContent;
const modes = Array.from(document.getElementById("gen-mode").options).map((o) => o.value);
const upsample = Array.from(document.getElementById("gen-upsample").options).map((o) => o.textContent);
document.getElementById("gen-cancel").click();
await wait(80);
if (!/864 . 1536/.test(note)) throw new Error("size note wrong: " + note);
return { note, modes, upsample, closed: !dlg.open };
"""),
    ("prompt_templates", """
const list = await host.refreshPromptTemplates();
if (list.length < 4) throw new Error("built-in templates missing: " + list.length);
const broken = list.filter((t) => t.error);
if (broken.length) throw new Error("broken template: " + broken[0].id + " " + broken[0].error);
const tpl = list.find((t) => t.id === "photographic");
const filled = host.fillPromptTemplate(tpl, { prompt: "a red bicycle", aspect: "16:9", width: 2048, height: 1152, useCase: "generate" });
if (!filled.includes("a red bicycle")) throw new Error("the placeholder was not filled");
if (!/Output only the prompt text/.test(filled)) throw new Error("the app's output rule is missing");
// the editor hook: nothing chosen means the built-in rules stay in charge
host.promptTemplateIds.upsample = "";
if (host.upsampleInstruction({ useCase: "edit", prompt: "x", region: "the whole image", hint: "" }) !== null) throw new Error("the hook answered without a template");
host.promptTemplateIds.upsample = "edit-instruction";
const own = host.upsampleInstruction({ useCase: "edit", prompt: "make it blue", region: "the area inside the magenta outline", hint: "a red car" });
host.promptTemplateIds.upsample = "";
if (!own || !own.includes("a red car") || !own.includes("magenta outline")) throw new Error("the template did not get its context");
// docs/PLAN_REFS.md 26d1: {references} in every built-in body; the token rule after the output rule; names appended to a
// body without the placeholder; without references the text ends where it always did
const missing = list.filter((t) => t.source === "builtin" && !t.body.includes("{references}")).map((t) => t.id);
if (missing.length) throw new Error("no {references} in " + missing.join(", "));
if (!filled.endsWith("no explanation.")) throw new Error("without references the text changed its end: " + filled.slice(-60));
const refs = [{ id: "La", n: 1, name: "jacket" }, { id: "Lb", n: 2, name: "dress" }];
const withRefs = host.fillPromptTemplate(tpl, { prompt: "the coat from @img1 over the dress of @img2", references: refs, useCase: "generate" });
if (withRefs.split('@img1 (the layer "jacket"), @img2 (the layer "dress")').length !== 2) throw new Error("the list is not there once: " + withRefs);
const out = withRefs.indexOf("no explanation."), rule = withRefs.indexOf("Reference tokens: keep every token of the request (@img1, @img2)");
if (out < 0 || rule < out || !withRefs.endsWith('such as "image 2".')) throw new Error("the token rule does not follow the output rule: " + withRefs.slice(-400));
const bare = host.fillPromptTemplate({ body: "Rewrite: {prompt}" }, { prompt: "x from @img1", references: refs.slice(0, 1) });
if (!bare.includes('no explanation.' + String.fromCharCode(10, 10) + 'The request names this reference image by token: @img1 (the layer "jacket"). Reference tokens:')) throw new Error("a body without the placeholder: " + bare);
return { templates: list.map((t) => t.id), useOf: list.map((t) => t.use) };
"""),
    ("upsample_references", """
// docs/PLAN_REFS.md 26d1: the upsample names the references the prompt names, keeps the tokens, refuses a parked one,
// checks the answer, and carries it to the labels that hold when it comes back. A stub language model answers from a queue.
const ed = ednow(window.__g);
host.shell.activate(ed);
const ask0 = host.askLLM, llms0 = host.llms, tpl0 = host.promptTemplateIds.upsample, case0 = ed.upsampleSettings.useCase;
const calls = [], answers = [];
host.askLLM = async (backend, instruction, canvas, images) => {
    calls.push({ instruction, images: images || [] });
    const a = answers.shift();
    return { text: typeof a === "function" ? await a() : a, seconds: 0.1 };
};
host.llms = [...(llms0 || []), { id: "stub:up", label: "Stub LLM", key: true }];
ed.refreshSegmentBackends();
ed.upBackendSel.value = "app:stub:up";
host.promptTemplateIds.upsample = "";
const doc = window.__g;
const up = async (useCase, prompt, answer) => {
    ed.upsampleSettings.useCase = useCase;
    await run("set_prompt", { doc, text: prompt });
    answers.push(answer);
    return run("upsample_prompt", { doc });
};
const out = {};
try {
    const j = await run("add_paint_layer", { doc, name: "jacket" });
    await run("set_layer", { doc, layer: j.id, role: "reference" });
    const d = await run("add_paint_layer", { doc, name: "dress" });
    await run("set_layer", { doc, layer: d.id, role: "reference" });
    const labels = Object.fromEntries((await run("list_layers", { doc })).layers.filter((l) => l.label).map((l) => [l.name, l.label]));
    if (labels.jacket !== "img1" || labels.dress !== "img2") throw new Error("labels " + JSON.stringify(labels));
    // (a) no token: no line about references, no rule
    let n = calls.length;
    await up("edit", "make the coat blue", "Make the coat blue.");
    const a = calls[n].instruction;
    if (a.includes("@img") || a.includes("Reference tokens:") || !a.startsWith("You write instructions") || !a.includes("Look at the image.")) throw new Error("(a) " + a);
    // (b) the edit case names only the reference the prompt names, the rule before the output line
    n = calls.length;
    await up("edit", "put on the dress from @img2", "Dress her in the dress from @img2, keeping the rest.");
    const b = calls[n].instruction;
    if (!b.includes('@img2 (the layer "dress")') || b.includes('(the layer "jacket")') || !b.includes("the jacket from @img2")) throw new Error("(b) names: " + b);
    const rb = b.indexOf("Reference tokens: keep every token of the request (@img2)"), ob = b.indexOf("Output only the instruction.");
    if (rb < 0 || ob < rb) throw new Error("(b) rule: " + b.slice(-500));
    // (c) fill: the rule inside Rules:
    n = calls.length;
    await up("fill", "the dress from @img2", "A red dress as in @img2.");
    const c = calls[n].instruction;
    const c1 = c.indexOf("Rules:"), c2 = c.indexOf("Reference tokens:"), c3 = c.indexOf("Output only the prompt text.");
    if (!(c1 >= 0 && c1 < c2 && c2 < c3) || !c.includes("(the @img tokens are not such mentions: keep them)")) throw new Error("(c) " + c);
    // 26d2: the pictures of the references the prompt names go along, labelled, at most 512 px; none with the switch off
    n = calls.length;
    await up("edit", "the coat from @img1 over the dress of @img2", "Put the coat from @img1 over the dress of @img2.");
    const pics = calls[n].images;
    if (pics.length !== 2 || pics[0].label !== '@img1 (the layer "jacket")' || pics[1].label !== '@img2 (the layer "dress")') throw new Error("pictures: " + JSON.stringify(pics.map((p) => p.label)));
    const sizes = [];
    for (const p of pics) { const bm = await createImageBitmap(new Blob([p.png], { type: "image/png" })); sizes.push([bm.width, bm.height]); bm.close(); }
    if (sizes.some(([w, h]) => Math.max(w, h) > 512 || Math.max(w, h) < 256)) throw new Error("picture sizes " + JSON.stringify(sizes));
    out.pictures = sizes;
    host.llmRefPictures = false;
    try {
        n = calls.length;
        await up("edit", "the coat from @img1 over the dress of @img2", "Put the coat from @img1 over the dress of @img2 now.");
        if (calls[n].images.length !== 0 || !calls[n].instruction.includes('@img2 (the layer "dress")')) throw new Error("switch off: " + calls[n].images.length + " pictures");
    } finally { host.llmRefPictures = true; }
    // (d) a hidden reference's token refuses, names the layer, asks nothing
    await run("set_prompt", { doc, text: "the coat from @img1" });
    await run("set_layer", { doc, layer: j.id, visible: false });
    if (!ed.promptText.includes("@img?L")) throw new Error("(d) the token did not park: " + ed.promptText);
    n = calls.length;
    let refused = "";
    try { await run("upsample_prompt", { doc }); } catch (err) { refused = String(err.message || err); }
    await run("set_layer", { doc, layer: j.id, visible: true });
    if (!refused.includes('"jacket" is hidden') || calls.length !== n || ed.upsamplePending) throw new Error("(d) refused: " + refused + ", calls " + (calls.length - n));
    if (ed.promptText !== "the coat from @img1") throw new Error("(d) the token did not come back: " + ed.promptText);
    out.refused = refused;
    // (d) a number no shown reference holds refuses too
    await run("set_prompt", { doc, text: "the coat from @img5" });
    n = calls.length;
    refused = "";
    try { await run("upsample_prompt", { doc }); } catch (err) { refused = String(err.message || err); }
    if (!refused.includes("@img5 names none") || calls.length !== n || ed.upsamplePending) throw new Error("(d) unknown: " + refused);
    // (e) an answer that drops, adds and numbers: a note, check, Revert lit
    ed.upRevertBtn.disabled = true;
    const e = await up("edit", "the coat from @img2", "Put on the coat from @img1 as in image 3.");
    if (!e.status.includes("dropped @img2") || !e.status.includes("added @img1") || !e.status.includes('"image 3"')) throw new Error("(e) status: " + e.status);
    if (!e.check || e.check.dropped[0] !== "@img2" || e.check.invented[0] !== "@img1" || e.check.literals[0] !== "image 3") throw new Error("(e) check: " + JSON.stringify(e.check));
    if (ed.upRevertBtn.disabled) throw new Error("(e) Revert is not lit");
    const kept = await up("edit", "the coat from @img2", "Put on the coat from @img2.");
    if (kept.check || kept.status.includes("Check the tokens")) throw new Error("(e) a clean answer was flagged: " + kept.status);
    out.status = e.status;
    // (f) the references swap while the model answers: the answer and Revert's text follow them
    ed.upsampleSettings.useCase = "edit";
    await run("set_prompt", { doc, text: "the dress from @img2" });
    let release = null;
    answers.push(() => new Promise((r) => { release = r; }));
    n = calls.length;
    const pending = run("upsample_prompt", { doc });
    for (let i = 0; i < 200 && !release; i++) await wait(20);
    if (!release) throw new Error("(f) the model was not asked");
    ed.moveReference(ed.layers.find((l) => l.id === d.id), 1);
    if (ed.refLabels().get(d.id) !== 1) throw new Error("(f) the swap did not happen: " + JSON.stringify([...ed.refLabels()]));
    release("Dress her in the dress from @img2.");
    await pending;
    if (ed.promptText !== "Dress her in the dress from @img1.") throw new Error("(f) the answer was not carried: " + ed.promptText);
    ed.revertPrompt();
    if (ed.promptText !== "the dress from @img1") throw new Error("(f) Revert: " + ed.promptText);
    out.swapped = ed.promptText;
    // (f2) swapped back while the model answers, and the answer drops the token: the note and check name it as it is now
    const hold = () => { const h = { release: null }; answers.push(() => new Promise((r) => { h.release = r; })); return h; };
    await run("set_prompt", { doc, text: "the dress from @img1" });
    let h = hold();
    let running = run("upsample_prompt", { doc });
    for (let i = 0; i < 200 && !h.release; i++) await wait(20);
    ed.moveReference(ed.layers.find((l) => l.id === d.id), -1);
    if (ed.refLabels().get(d.id) !== 2) throw new Error("(f2) the swap back did not happen");
    h.release("Dress her in the dress shown in image 2.");
    const f2 = await running;
    if (!f2.status.includes("dropped @img2") || !f2.check || f2.check.dropped[0] !== "@img2" || f2.previous !== "the dress from @img2") throw new Error("(f2) " + JSON.stringify(f2));
    // (g) the upper reference is merged into the lower one while the model answers: its tokens name the survivor
    await run("set_prompt", { doc, text: "the coat from @img1 over the dress of @img2" });
    h = hold();
    running = run("upsample_prompt", { doc });
    for (let i = 0; i < 200 && !h.release; i++) await wait(20);
    await ed.mergeDown(ed.layers.find((l) => l.id === j.id));
    if (ed.layers.some((l) => l.id === j.id) || ed.refLabels().get(d.id) !== 1) throw new Error("(g) the merge did not happen: " + JSON.stringify([...ed.refLabels()]));
    if (ed.promptText !== "the coat from @img1 over the dress of @img1") throw new Error("(g) the field: " + ed.promptText);
    h.release("Put the coat from @img1 over the dress of @img2.");
    await running;
    if (ed.promptText !== "Put the coat from @img1 over the dress of @img1.") throw new Error("(g) the answer was not carried: " + ed.promptText);
    if (ed._refDrift) throw new Error("drift " + ed._refDrift);
    out.merged = ed.promptText;
} finally {
    host.askLLM = ask0;
    host.llms = llms0;
    host.promptTemplateIds.upsample = tpl0;
    ed.upsampleSettings.useCase = case0;
    ed.refreshSegmentBackends();
}
return out;
"""),
    ("template_select_in_the_dialog", """
const ed = ednow(window.__g);
await host.shell.openGenerateNew(ed);
const sel = document.getElementById("gen-template");
const ids = Array.from(sel.options).map((o) => o.value);
if (!ids.includes("photographic") || !ids.includes("rich-scene")) throw new Error("the generate templates are not offered: " + ids.join(", "));
if (ids.includes("edit-instruction")) throw new Error("an upsample-only template is offered for generating");
if (ids[0] !== "") throw new Error("the built-in entry is not first");
document.getElementById("gen-cancel").click();
await wait(120);
return { options: ids };
"""),
    ("provider_markers_over_ipc", """
// docs/PLAN_REFS.md 26a1: main turns a marker {@ref:i} into the name the route gives that picture, refuses a raw @img
// token, and provider:layout answers the names a request of that shape would carry
const c = new OffscreenCanvas(64, 64);
c.getContext("2d").fillStyle = "#808080";
c.getContext("2d").fillRect(0, 0, 64, 64);
const png = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
const base = { provider: "loopback", kind: "edit", model: "loopback", image: png, width: 64, height: 64, params: {} };
const res = await window.scumble.providers.edit({ ...base, prompt: "the coat from {@ref:1}", references: [png, png], original: 1, refName: "Image {n}" });
if (!res.info || res.info.prompt !== "the coat from Image 3") throw new Error("the loopback got " + JSON.stringify(res.info && res.info.prompt));
if (res.prompt !== "the coat from Image 3" || !res.refs || res.refs.length !== 1 || res.refs[0].name !== "Image 3" || res.refs[0].ref !== 1) throw new Error("the answer: " + JSON.stringify({ prompt: res.prompt, refs: res.refs }));
let refused = null;
try { await window.scumble.providers.edit({ ...base, prompt: "@img1", references: [png] }); } catch (err) { refused = String(err.message || err); }
if (!refused || !/@img1/.test(refused)) throw new Error("a raw @img1 was not refused: " + refused);
const lay = await window.scumble.providers.layout({ provider: "openrouter", model: "openai/gpt-image-2", kind: "fill", options: { max_images: 16 }, count: 2, original: 1, refName: "Image {n}" });
if (JSON.stringify(lay.names) !== JSON.stringify(["Image 3", "Image 4"]) || lay.sent !== 4 || lay.over) throw new Error("layout: " + JSON.stringify({ names: lay.names, sent: lay.sent, over: lay.over }));
return { prompt: res.info.prompt, refs: res.refs, refused: refused.slice(0, 80), names: lay.names, sent: lay.sent };
"""),
    *STEPS_26F,
    # the title row's Cancel: an API run that waits on its provider (the loopback, 20 s) stops when it is pressed, ends
    # with the message, and the button goes with the run
    ("cancel_a_waiting_run", """
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
await run("load_image", { doc: d.id, filename: "test_base.png", subfolder: "inpaint_canvas", type: "input" });
const prev = host.recipe;
host.setRecipe({ id: "loopback_slow", kind: "provider", provider: "loopback", providerLabel: "Loopback", model: "loopback", input: "edit", refs: { name: "image {n}" }, name: "Loopback slow", settings: [], fixed: { delay_ms: 20000 } });
const btn = document.getElementById("shell-cancel");
let msg = null, shown = false, late = null, lateMs = 0;
const t0 = Date.now();
try {
    const p = host.runProvider(ed).then(() => "finished", (e) => String(e.message || e));
    for (let k = 0; k < 50 && btn.hidden; k++) await wait(100);
    shown = !btn.hidden;
    if (shown) btn.click();
    msg = await p;
    // pressed once the request waits in main (the loopback's 20 s): main stops waiting at once
    const t1 = Date.now();
    const p2 = host.runProvider(ed).then(() => "finished", (e) => String(e.message || e));
    await wait(1500);
    btn.click();
    late = await p2;
    lateMs = Date.now() - t1;
} finally { host.setRecipe(prev); }
const ms = Date.now() - t0;
if (!/^Cancelled after [0-9.]+ s: Scumble stopped waiting for Loopback/.test(late || "") || lateMs > 5000) throw new Error("pressed while it waits: " + late + " after " + lateMs + " ms");
for (let k = 0; k < 20 && !btn.hidden; k++) await wait(100);
try { await run("close_document", { doc: d.id, force: true }); } catch (_) { /* gone */ }
if (!shown) throw new Error("no Cancel button while the run waits");
// pressed while the crop is made, nothing is sent; once sent, main stops waiting
if (!/^Cancelled (after [0-9.]+ s: Scumble stopped waiting for Loopback|before anything was sent)/.test(msg || "")) throw new Error("the run ended with: " + msg);
if (ms > 12000) throw new Error("the two cancels took " + ms + " ms");
if (!btn.hidden) throw new Error("the Cancel button stays after the run");
return { early: msg, late, lateMs };
"""),
    ("dialog_escape_closes_the_picker_first", dialog_escape_closes_the_picker_first),
    *STEPS_26F_AFTER,
    ("cleanup", """
try { await run("close_document", { doc: window.__g }); } catch (_) { /* gone */ }
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
            # a step is JS for the page, or a Python function that drives real keys (26f's Escape in the dialog)
            res = await (body(c, PRE) if callable(body) else c.eval(PRE % body, timeout=240))
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
