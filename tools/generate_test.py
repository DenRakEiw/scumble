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
    # docs/PLAN_0_1_42.md R1: the shipped Realism Pass recipe through Generate, the prompt caught before it leaves (nothing
    # is queued on any server; the server is stubbed as a Windows ComfyUI with an RTX 5090 and the pack's nodes): the box
    # at its own size (multiple_of 2 whatever nodeParams says; no fill, Original, references or refine whatever the tab
    # holds), the shipped presets and a user's own in the Settings row, Style and Strength from settings.realism, the
    # refusals before anything is serialized or uploaded (the server, the size, the selection), the pack's error as a
    # sentence (the event, and the generate command that stops its wait on it), list_recipes and generate_new
    ("the_realism_pass_recipe_queues_the_box_as_it_is", """
const LABEL = "Realism Pass (Windows only, RTX only)";
const { api } = await import("./editor/host.js");
const r0 = host.shell.recipes().find((x) => x.id === "realism_pass");
if (!r0) throw new Error("the shipped Realism Pass recipe is not listed");
if (r0.task !== "pass" || r0.kind === "provider" || r0.name !== LABEL) throw new Error("not the pass: " + JSON.stringify({ task: r0.task, kind: r0.kind, name: r0.name }));
const presetM = (r0.presets || []).find((p) => p.name === "M");
if (!presetM) throw new Error("the recipe ships no preset M: " + JSON.stringify(r0.presets));
const prev = host.recipe ? host.recipe.id : null;
const prevProvider = host.recipe && host.recipe.kind === "provider" ? host.recipe.provider : undefined;
// selectRecipe also stores the local mode's last recipe (recipeByMode): that one goes back first
let prevLocal = null;
try { prevLocal = ((await window.scumble.settings.get()).recipeByMode || {}).local || null; } catch (_) { /* none */ }
const saved = { connected: host.connected, objectInfo: host.objectInfo, ensure: host.ensureOnServer, queue: api.queuePrompt, fetchApi: api.fetchApi, server: { ...(host.server || {}) }, realism: host.realismStored, multiple: host.nodeParams.multiple_of };
const nodeInfo = () => ({ input: { required: {} } });
const OI = { InpaintCanvas: nodeInfo(), ImageFromBatch: nodeInfo(), DLSS5Settings: nodeInfo(), DLSS5EnhanceImages: nodeInfo() };
const GOOD = { state: "connected", os: "win32", gpus: ["cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync"] };
let sent = null, uploads = 0, doc = null, ed = null, crop0 = null, refine0 = false, failure = null, restored = true;
// the prompt id the stubbed queue answers, and a callback it runs about 1 s after a prompt was queued
let nextId = "rp-test-1", onQueued = null;
const out = {};
const presetSel = () => ed.settingsList.querySelector(".ipc-preset-row select");
const presetDel = () => Array.from(ed.settingsList.querySelectorAll(".ipc-preset-row button")).find((b) => b.textContent === "Delete");
const modelSel = () => {
    const lab = Array.from(ed.settingsList.children).find((l) => l.tagName === "LABEL" && /^DLSS model preset/.test((l.childNodes[0] && l.childNodes[0].textContent) || ""));
    return lab ? lab.querySelector("select") : null;
};
const pickPreset = (name) => { const s = presetSel(); s.value = name; s.dispatchEvent(new Event("change")); };
const sorted = (o) => JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, o[k]]));
try {
    host.connected = true;
    host.objectInfo = OI;
    host.setServerStatus(GOOD);
    host.ensureOnServer = async () => { uploads++; return null; };
    api.queuePrompt = async (n, body) => {
        sent = body;
        const id = nextId;
        if (onQueued) { const f = onQueued; onQueued = null; setTimeout(() => f(id), 1000); }
        return { prompt_id: id };
    };
    // the generate command asks ComfyUI's /queue while it waits: busy with this run (nothing leaves the app)
    api.fetchApi = (path, init) => String(path).startsWith("/queue")
        ? Promise.resolve(new Response(JSON.stringify({ queue_running: [[0, nextId]], queue_pending: [] }), { status: 200, headers: { "Content-Type": "application/json" } }))
        : saved.fetchApi.call(api, path, init);
    const d = await run("new_document");
    doc = d.id;
    ed = ednow(doc);
    host.shell.activate(ed);
    await run("load_image", { doc, filename: "test_base.png", subfolder: "inpaint_canvas", type: "input" });
    host.shell.selectRecipe("realism_pass");
    if (!host.recipe || host.recipe.id !== "realism_pass") throw new Error("the recipe was not selected");
    if (ed.genSettings.mode !== "local") throw new Error("the pass runs in mode " + ed.genSettings.mode);
    const sup = host.realismSupport();
    if (!sup.ok || sup.generation !== 50 || sup.note) throw new Error("the stubbed server: " + JSON.stringify(sup));
    // ComfyUI's torch devices decide: no CUDA device listed (CPU, DirectML) is left to the pack, a mix runs on its RTX
    for (const [gpus, gen] of [[["cpu"], 0], [["privateuseone:0 AMD Radeon RX 7900"], 0], [["cuda:0 NVIDIA GeForce RTX 2080 : cudaMallocAsync", "cuda:1 NVIDIA GeForce RTX 4090 : cudaMallocAsync"], 40]]) {
        host.setServerStatus({ ...GOOD, gpus });
        const s = host.realismSupport();
        if (!s.ok || s.generation !== gen) throw new Error("devices " + JSON.stringify(gpus) + ": " + JSON.stringify(s));
    }
    host.setServerStatus(GOOD);
    // (1) the Settings section: the shipped presets L and M in the Preset row (not deletable), the model preset row reads L
    if (!presetSel()) throw new Error("no Preset row in the Settings section");
    const opts = Array.from(presetSel().options).map((o) => o.value);
    if (!opts.includes("L") || !opts.includes("M")) throw new Error("the Preset row holds " + JSON.stringify(opts));
    if (!presetDel() || !presetDel().disabled) throw new Error("a shipped preset can be deleted");
    if (!modelSel() || modelSel().value !== "L" || presetSel().value !== "L") throw new Error("before a pick: the row reads " + (modelSel() && modelSel().value) + ", the preset " + presetSel().value);
    pickPreset("M");
    if (!modelSel() || modelSel().value !== "M" || presetSel().value !== "M" || !ed.settings["1"] || ed.settings["1"].value !== "M") throw new Error("preset M: the row reads " + (modelSel() && modelSel().value) + ", the stored value " + JSON.stringify(ed.settings["1"]));
    out.presets = opts;
    // a user's own preset with M's values: the row names it (the user's first, not the shipped M), and it can be deleted
    const own0 = ((host.presets || {}).realism_pass || []).filter((p) => p.name !== "mine");
    try {
        await host.savePresets("realism_pass", own0.concat([{ name: "mine", values: { ...presetM.values } }]));
        ed.renderSettings();
        pickPreset("L");
        if (presetSel().value !== "L" || modelSel().value !== "L") throw new Error("preset L beside mine: the select shows " + presetSel().value + ", the row " + modelSel().value);
        pickPreset("mine");
        const del = presetDel();
        if (presetSel().value !== "mine" || modelSel().value !== "M" || !del || del.disabled) throw new Error("the user's preset: the select shows " + presetSel().value + ", the row " + modelSel().value + ", Delete " + (del ? (del.disabled ? "disabled" : "enabled") : "missing"));
        out.mine = { shown: presetSel().value, row: modelSel().value };
    } finally {
        await host.savePresets("realism_pass", own0);
        ed.renderSettings();
    }
    if (presetSel().value !== "M" || modelSel().value !== "M" || !presetDel() || !presetDel().disabled) throw new Error("mine removed: the select shows " + presetSel().value + ", the row " + modelSel().value);
    // (2) Generate: the box at its own size; what the tab holds does not go along (a multiple_of of 7, the green fill, the
    // Original, a refine pass, references); the row's model preset M, Style and Strength from settings.realism (its
    // preset K is the switch routes' and does not go), every other input as the recipe has it
    await run("select_rect", { doc, x: 64, y: 64, w: 200, h: 150 });
    crop0 = { fill: ed.cropSettings.fill, withOriginal: ed.cropSettings.withOriginal };
    refine0 = ed.genSettings.refine;
    ed.cropSettings.fill = "green";
    ed.cropSettings.withOriginal = true;
    ed.genSettings.refine = true;
    host.nodeParams.multiple_of = 7;
    host.realismStored = { style: "Cinematic", intensity: 0.4, preset: "K", timeout: 300 };
    sent = null; uploads = 0;
    const res = await ed.generate();
    if (res && res.error) throw new Error("Generate refused: " + res.error.message);
    if (!sent) throw new Error("nothing was queued: " + ed.status);
    if (uploads !== 1) throw new Error("ensureOnServer ran " + uploads + " times");
    const P = sent.output, cv = P.canvas.inputs, st = JSON.parse(cv.canvas_state);
    if (cv.target_size !== 0) throw new Error("the crop is scaled before the pass: target_size " + cv.target_size);
    if (cv.multiple_of !== 2) throw new Error("multiple_of " + cv.multiple_of + " (nodeParams says 7, the pass sends 2)");
    if (cv.result_source_local !== "rp_enhance:0" || cv.result_source !== undefined) throw new Error("the result input: " + JSON.stringify({ local: cv.result_source_local, api: cv.result_source }));
    if (!st.crop || st.crop.fill !== "none" || st.crop.withOriginal !== false) throw new Error("the crop goes out filled: " + JSON.stringify(st.crop));
    if (!Array.isArray(st.references) || st.references.length) throw new Error("references went along: " + JSON.stringify(st.references));
    if (!st.gen || st.gen.refine !== false) throw new Error("a refine pass went along: " + JSON.stringify(st.gen && st.gen.refine));
    if (ed.cropSettings.fill !== "green" || ed.cropSettings.withOriginal !== true || ed.genSettings.refine !== true) throw new Error("the run changed the tab's own settings");
    const want = { ...r0.prompt.rp_settings.inputs, dlss_model_preset: "M", nr_style: "Cinematic", nr_intensity: 0.4 };
    if (sorted(P.rp_settings.inputs) !== sorted(want)) throw new Error("rp_settings: " + JSON.stringify(P.rp_settings.inputs) + " want " + JSON.stringify(want));
    if (sorted(P.rp_one.inputs) !== sorted(r0.prompt.rp_one.inputs) || sorted(P.rp_enhance.inputs) !== sorted(r0.prompt.rp_enhance.inputs)) throw new Error("the pack's nodes changed: " + JSON.stringify([P.rp_one.inputs, P.rp_enhance.inputs]));
    if (r0.prompt.rp_settings.inputs.dlss_model_preset !== "L" || r0.prompt.rp_settings.inputs.nr_style !== "Default") throw new Error("the run wrote into the recipe: " + JSON.stringify(r0.prompt.rp_settings.inputs));
    if (ed.lastPromptId !== "rp-test-1") throw new Error("lastPromptId " + ed.lastPromptId);
    out.sent = { target_size: cv.target_size, multiple_of: cv.multiple_of, fill: st.crop.fill, withOriginal: st.crop.withOriginal, refine: st.gen.refine, preset: P.rp_settings.inputs.dlss_model_preset, style: P.rp_settings.inputs.nr_style, intensity: P.rp_settings.inputs.nr_intensity };
    // an RTX 30 card runs, with the note about the pack's experimental runtime pair after the queueing
    host.setServerStatus({ ...GOOD, gpus: ["cuda:0 NVIDIA GeForce RTX 3090 : cudaMallocAsync"] });
    sent = null;
    const res30 = await ed.generate();
    host.setServerStatus(GOOD);
    if ((res30 && res30.error) || !sent) throw new Error("an RTX 3090 did not run: " + ed.status);
    if (!String(ed.status).includes("experimental runtime pair") || !String(ed.status).includes(LABEL)) throw new Error("no RTX 30 note: " + ed.status);
    // (3) five refusals, each before the tab is serialized, anything uploaded or queued, each naming the pass
    const refused = async (what, re, setup, teardown) => {
        sent = null; uploads = 0;
        let serials = 0;
        const ownSer = Object.prototype.hasOwnProperty.call(ed, "serializeForPrompt");
        const ser0 = ed.serializeForPrompt;
        ed.serializeForPrompt = function (...a) { serials++; return ser0.apply(this, a); };
        setup();
        let r;
        try { r = await ed.generate(); } finally {
            teardown();
            if (ownSer) ed.serializeForPrompt = ser0; else delete ed.serializeForPrompt;
        }
        const msg = r && r.error ? String(r.error.message) : "";
        if (!msg) throw new Error(what + ": not refused (" + ed.status + ")");
        if (!msg.includes(LABEL) || !String(ed.status).includes(LABEL) || !re.test(msg)) throw new Error(what + ": " + msg + " / status " + ed.status);
        if (sent || uploads || serials) throw new Error(what + ": refused after " + (sent ? "queueing" : uploads ? "an upload" : serials + " serializeForPrompt call(s)"));
        return msg;
    };
    out.linux = await refused("os linux", /on Windows; this one runs on linux/, () => host.setServerStatus({ ...GOOD, os: "linux" }), () => host.setServerStatus(GOOD));
    out.rtx20 = await refused("an RTX 2080", /it shows NVIDIA GeForce RTX 2080\\./, () => host.setServerStatus({ ...GOOD, gpus: ["cuda:0 NVIDIA GeForce RTX 2080 : cudaMallocAsync"] }), () => host.setServerStatus(GOOD));
    out.nodes = await refused("no DLSS5Settings", /lacks its nodes .DLSS5Settings/, () => { const o = { ...OI }; delete o.DLSS5Settings; host.objectInfo = o; }, () => { host.objectInfo = OI; });
    // the size check reads the crop the node makes (the box with its context): a 40 x 60 crop is too small
    const ownCrop = Object.prototype.hasOwnProperty.call(ed, "cropRect"), crop1 = ed.cropRect;
    out.size = await refused("a 40 x 60 crop", /needs at least 64 px a side; this is 40 \\u00d7 60\\./, () => { ed.cropRect = () => [0, 0, 40, 60]; }, () => { if (ownCrop) ed.cropRect = crop1; else delete ed.cropRect; });
    await run("select_none", { doc });
    out.noSelection = await refused("no selection", /^Select an area first/, () => {}, () => {});
    // (4) a failure inside the pack comes back as the sentence, not "Error in DLSS5EnhanceImages: ..."
    ed.lastPassError = null;
    api.dispatch("execution_error", { prompt_id: "rp-test-1", node_id: "rp_enhance", node_type: "DLSS5EnhanceImages", exception_message: "No DLSS 5 runtime was found. Searched:\\n  x" });
    if (!String(ed.status).includes("runtime is not installed") || !String(ed.status).includes(LABEL)) throw new Error("the pack's error reads: " + ed.status);
    if (ed.lastPassError !== ed.status) throw new Error("lastPassError: " + ed.lastPassError);
    if (ed._localRuns && ed._localRuns.has("rp-test-1")) throw new Error("the run stays open after its error");
    out.hint = ed.status;
    // (4b) the generate command waits for the run and stops on the pack's error, long before its timeout: the error
    // comes about 1 s after the prompt was queued (from the stubbed queue's setTimeout), while the command waits
    await run("select_rect", { doc, x: 64, y: 64, w: 200, h: 150 });
    nextId = "rp-test-cmd";
    let dispatchedAt = 0;
    onQueued = (id) => { dispatchedAt = Date.now(); api.dispatch("execution_error", { prompt_id: id, node_id: "rp_enhance", node_type: "DLSS5EnhanceImages", exception_message: "No DLSS 5 runtime was found. Searched:\\n  x" }); };
    sent = null;
    const n0 = ed.history.length, tc = Date.now();
    let cmdErr = "";
    try { await run("generate", { doc, timeout: 30 }); cmdErr = "it resolved"; } catch (err) { cmdErr = String(err.message || err); }
    const tEnd = Date.now();
    onQueued = null;
    if (!sent || !dispatchedAt) throw new Error("the command queued nothing or the error never came: " + cmdErr);
    if (!cmdErr.includes("runtime is not installed") || !cmdErr.includes(LABEL)) throw new Error("the command ended with: " + cmdErr);
    if (tEnd - tc > 5000) throw new Error("the command took " + (tEnd - tc) + " ms to stop on the error (timeout 30 s)");
    if (ed.history.length !== n0) throw new Error("the failed run left a result");
    if (ed._localRuns && ed._localRuns.has("rp-test-cmd")) throw new Error("the command's run stays open after its error");
    out.command = { ms: tEnd - tc, afterError: tEnd - dispatchedAt, error: cmdErr.slice(0, 80) };
    // (5) the commands: list_recipes reports the pass as it is, generate_new refuses it and leaves the tab alone
    const listed = await run("list_recipes");
    const rp = (listed.recipes || []).find((x) => x.id === "realism_pass");
    if (!rp || rp.task !== "pass" || rp.mode !== "local" || rp.name !== LABEL || rp.textRefs !== undefined || rp.factor !== undefined) throw new Error("list_recipes: " + JSON.stringify(rp));
    if (listed.selected !== "realism_pass") throw new Error("list_recipes selected " + listed.selected);
    const w0 = ed.width, h0 = ed.height, ln0 = ed.layers.length;
    sent = null;
    let gn = "";
    try { await run("generate_new", { doc, prompt: "a portrait", width: 512, height: 512 }); } catch (err) { gn = String(err.message || err); }
    if (!gn.includes(LABEL) || ed.width !== w0 || ed.height !== h0 || ed.layers.length !== ln0 || sent) throw new Error("generate_new: " + (gn || "not refused") + ", " + ed.width + "x" + ed.height);
    out.generateNew = gn;
    out.list = { task: rp.task, mode: rp.mode, name: rp.name };
    return out;
} catch (err) {
    failure = err;
    throw err;
} finally {
    host.connected = saved.connected; host.objectInfo = saved.objectInfo; host.ensureOnServer = saved.ensure; api.queuePrompt = saved.queue; api.fetchApi = saved.fetchApi;
    host.realismStored = saved.realism;
    host.nodeParams.multiple_of = saved.multiple;
    onQueued = null;
    if (ed) {
        if (crop0) { ed.cropSettings.fill = crop0.fill; ed.cropSettings.withOriginal = crop0.withOriginal; ed.genSettings.refine = refine0; }
        try { if (presetSel() && presetSel().value !== "L") pickPreset("L"); } catch (_) { /* gone */ }
        if (ed._localRuns) ed._localRuns.clear();
    }
    host.setServerStatus({ state: saved.server.state || "disconnected", os: saved.server.os || "", gpus: saved.server.gpus || [], remote: !!saved.server.remote });
    // the window's recipes back through the shell (a gate that leaves it changed makes the next one red). selectRecipe
    // writes recipeByMode from the window's copy of the settings, which its own write updates only later: two calls in a
    // row left recipeByMode.local = realism_pass on disk, so each one waits until the stored settings show it
    const localOf = (s) => (s && s.recipeByMode && s.recipeByMode.local) || null;
    const settled = async (pred) => {
        for (let k = 0; k < 100; k++) {
            let s = null;
            try { s = await window.scumble.settings.get(); } catch (_) { /* again */ }
            if (s && pred(s)) return true;
            await wait(50);
        }
        return false;
    };
    const known = (id) => host.shell.recipes().find((x) => x.id === id) || null;
    const localBack = prevLocal && prevLocal !== "realism_pass" && known(prevLocal) ? prevLocal
        : (host.shell.recipes().find((x) => x.id !== "realism_pass" && host.shell.modeOf(x) === "local") || {}).id || null;
    if (localBack) {
        host.shell.selectRecipe(localBack);
        restored = await settled((s) => localOf(s) === localBack);
        await wait(100);   // the shell's copy takes the write's answer
    } else restored = false;
    if (prev && known(prev)) {
        host.shell.selectRecipe(prev, prevProvider);
        const wantLocal = host.shell.modeOf(known(prev)) === "local" ? prev : localBack;
        restored = (await settled((s) => s.recipe === prev && localOf(s) === wantLocal)) && restored;
    }
    if (doc) { try { await run("close_document", { doc, force: true }); } catch (_) { /* gone */ } }
    if (!restored && !failure) {
        let s = null;
        try { s = await window.scumble.settings.get(); } catch (_) { /* none */ }
        throw new Error("the recipes were not restored: recipe " + (s && s.recipe) + ", recipeByMode " + JSON.stringify(s && s.recipeByMode) + " (want " + prev + " / local " + localBack + ")");
    }
}
"""),
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
