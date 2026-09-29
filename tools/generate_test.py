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
