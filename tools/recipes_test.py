"""The recipe files and the recipe importer: plain Node first, then the app over CDP.

No ComfyUI and no API key. The first step runs tools/recipes_test.js (the shipped recipes' settings slots and
electron/main/recipes.js importFile against a scratch userData folder). The rest drives the running app:

- FLUX.2 [flex] on fal shows three settings rows on three slots and sends three values (until 2026-09-20 the
  safety tolerance shared slot 1 with the step count and went out as both);
- a copy of a shipped recipe with a variant of the user's own imports through the Settings dialog, is served by
  the list as a user recipe, says so in the dialog's note, and its own variant can be chosen and reaches host;
- a provider recipe that names no provider is refused with its own message and writes nothing.
- the shipped local recipes (Qwen Image Edit 2.1, Flux.2 Klein) write each @img token as their graph numbers its
  picture in the node's batch, leave out the encoder inputs the batch does not fill and refuse a token past their slots
  (docs/PLAN_REFS.md 26e); ComfyUI is stubbed, nothing is queued on any server.

The imported recipe is removed again whatever happens, and the recipe select is put back where it was.

    python tools/recipes_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MINE = "flux2_flex_mine"
MY_MODEL = "black-forest-labs/flux.2-flex:free"

PRE = """(async () => {
    const commands = window.__cmds.commands, host = window.__host;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const note = () => document.getElementById("set-recipe-note").textContent;
    %s
})()"""


def node_step():
    r = subprocess.run(["node", os.path.join(ROOT, "tools", "recipes_test.js")], cwd=ROOT,
                       capture_output=True, text=True, encoding="utf-8", timeout=120)
    tail = (r.stdout + r.stderr).strip()
    if r.returncode != 0 or not tail.endswith("PASS"):
        raise Exception("tools/recipes_test.js: " + tail[-1500:])
    # tools/comfyrefs_test.js (item 26 step 26e): stderr carries Node's note that it read comfyrefs.js as an ES module
    c = subprocess.run(["node", os.path.join(ROOT, "tools", "comfyrefs_test.js")], cwd=ROOT,
                       capture_output=True, text=True, encoding="utf-8", timeout=120)
    ctail = c.stdout.strip()
    if c.returncode != 0 or not ctail.endswith("PASS"):
        raise Exception("tools/comfyrefs_test.js: " + (ctail + c.stderr)[-1500:])
    last = lambda t: (t.splitlines()[-2:-1] or [""])[0]  # noqa: E731  the "N of M checks passed" line
    return {"checks": tail.count("[ok]"), "comfyrefs_checks": ctail.count("[ok]"), "tails": [last(tail), last(ctail)]}


def write_files(dirname):
    """A copy of the shipped FLUX.2 [flex] recipe with an OpenRouter model the app does not ship, and a broken one."""
    with open(os.path.join(ROOT, "recipes", "flux2_flex.json"), encoding="utf-8") as fh:
        mine = json.load(fh)
    mine["id"] = MINE
    mine["name"] = "FLUX.2 [flex] (mine)"
    mine["providers"]["openrouter"] = dict(mine["providers"]["openrouter"], model=MY_MODEL)
    good = os.path.join(dirname, MINE + ".json")
    with open(good, "w", encoding="utf-8", newline=chr(10)) as fh:
        json.dump(mine, fh, indent=2)
    bad = os.path.join(dirname, "no_provider.json")
    with open(bad, "w", encoding="utf-8", newline=chr(10)) as fh:
        json.dump({"kind": "provider", "id": "no_provider", "name": "No provider"}, fh, indent=2)
    return good, bad


SETUP = """
const d = await run("new_document");
window.__r = d.id;
host.shell.activate(ednow(d.id));
window.__shell = await import("./shell.js");
window.__prev = document.getElementById("shell-recipe").value;
return { doc: d.id, recipe: window.__prev };
"""

THREE_SLOTS = """
const ed = ednow(window.__r);
window.__shell.selectRecipe("flux2_flex", "fal");
const keys = Object.keys(ed.settings).sort();
const labels = keys.map((k) => ed.settings[k].label);
if (keys.length !== 3) throw new Error("expected three settings slots, got " + JSON.stringify(ed.settings));
if (new Set(labels).size !== 3) throw new Error("two rows share a slot: " + JSON.stringify(labels));
const params = host.providerParams(ed);
if (params.num_inference_steps !== 50) throw new Error("steps went out as " + JSON.stringify(params.num_inference_steps));
if (params.guidance_scale !== 2.5) throw new Error("guidance went out as " + JSON.stringify(params.guidance_scale));
if (String(params.safety_tolerance) !== "2") throw new Error("safety tolerance went out as " + JSON.stringify(params.safety_tolerance));
if (Object.keys(params).length !== 3) throw new Error("the request carries " + JSON.stringify(params));
return { slots: keys, labels, params };
"""

IMPORT_MINE = """
const r = await window.__shell.importRecipe(%s);
if (!r) throw new Error("the import was refused: " + note());
if (r.id !== "%s" || r.kind !== "provider") throw new Error("imported " + JSON.stringify({ id: r.id, kind: r.kind }));
if (!(r.providerIds || []).includes("openrouter")) throw new Error("the variants came back as " + JSON.stringify(r.providerIds));
const text = note();
if (!/provider/.test(text) || /undefined/.test(text)) throw new Error("the dialog says: " + text);
const list = await window.scumble.recipes.list();
const mine = list.filter((x) => x.id === "%s");
if (mine.length !== 1 || mine[0].source !== "user") throw new Error("the list serves " + JSON.stringify(mine.map((x) => x.source)));
if (mine[0].providers.openrouter.model !== "%s") throw new Error("the model is " + mine[0].providers.openrouter.model);
window.__shell.selectRecipe("%s", "openrouter");
if (host.recipe.id !== "%s" || host.recipe.model !== "%s") throw new Error("host took " + JSON.stringify({ id: host.recipe.id, model: host.recipe.model }));
if (host.recipe.limits.max !== 1440) throw new Error("the limits did not come through: " + JSON.stringify(host.recipe.limits));
return { note: text, model: host.recipe.model, providers: r.providerIds };
"""

IMPORT_BAD = """
const before = (await window.scumble.recipes.list()).length;
const r = await window.__shell.importRecipe(%s);
if (r) throw new Error("a recipe with no provider was imported: " + JSON.stringify(r.id));
const text = note();
if (!/^This provider recipe names no provider/.test(text)) throw new Error("the dialog says: " + text);
const after = (await window.scumble.recipes.list()).length;
if (after !== before) throw new Error("the list grew from " + before + " to " + after);
return { note: text, recipes: after };
"""

LOCAL_REFS = """
// 26e: the shipped local recipes write each @img token as their graph numbers its picture in the node's batch, and
// leave out the encoder inputs the batch does not fill; the prompt is caught before it leaves (nothing is queued on
// any server)
const ed = ednow(window.__r);
const doc = window.__r;
const { api } = await import("./editor/host.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const saved = { connected: host.connected, objectInfo: host.objectInfo, ensure: host.ensureOnServer, queue: api.queuePrompt, helper: ed.helperUsed };
const QWEN = "qwen_image_edit_2_1_local", KLEIN = "flux2_klein_local";
let sent = null, queued = 0;
const ids = [];
const out = {};
const pick = (id) => {
    window.__shell.selectRecipe(id);
    if (!host.recipe || host.recipe.id !== id) throw new Error(id + " was not selected");
};
const go = async (id) => {
    pick(id);
    sent = null;
    await host.queueGenerate(ed);
    if (!sent) throw new Error(id + ": nothing was queued");
    const P_ = sent.output;
    return { P_, st: JSON.parse(P_.canvas.inputs.canvas_state) };
};
const refused = async (id, re, what) => {
    pick(id);
    sent = null;
    let msg = null;
    try { await host.queueGenerate(ed); } catch (err) { msg = String(err.message || err); }
    if (!msg || !re.test(msg)) throw new Error(what + " was not refused as expected: " + msg);
    if (sent) throw new Error(what + ": a refused run queued a prompt");
    return msg;
};
const qwenKeys = (P_) => Object.keys(P_.encode.inputs).filter((k) => /^images[.]image_/.test(k)).sort((a, b) => +a.slice(13) - +b.slice(13)).map((k) => k.slice(13) + ":" + P_.encode.inputs[k][0]).join(",");
const kleinLatents = (P_) => [0, 1, 2, 3].map((i) => ["pos", "neg"].map((s) => ("latent" in P_["ref_" + s + i].inputs ? "1" : "0")).join("")).join(",");
try {
    const oi = {};
    for (const r of host.shell.recipes().filter((x) => x.id === QWEN || x.id === KLEIN)) for (const n of r.needs || []) oi[n] = { input: { required: {} } };
    host.objectInfo = oi;
    host.connected = true;
    host.ensureOnServer = async () => null;
    api.queuePrompt = async (n, body) => { queued++; sent = body; return { prompt_id: "gate-26e" }; };
    ed.helperUsed = false;
    await run("new_canvas", { doc, width: 512, height: 384 });
    await run("select_rect", { doc, x: 64, y: 64, w: 200, h: 150 });
    await run("set_crop", { doc, fill: "none", withOriginal: false });
    await run("set_generation", { doc, refine: false });
    await run("set_prompt", { doc, text: "a red hat", negative: "" });
    // 1. no reference, no token: the texts as they are, every encoder input but the crop's left out
    let q = await go(QWEN);
    if (q.st.prompt !== "a red hat" || "named_refs" in q.st || q.st.hasSelection !== true) throw new Error("Qwen without references: " + JSON.stringify({ p: q.st.prompt, named: q.st.named_refs, sel: q.st.hasSelection }));
    if (qwenKeys(q.P_) !== "1:img0") throw new Error("Qwen's inputs without references: " + qwenKeys(q.P_));
    let k = await go(KLEIN);
    if (kleinLatents(k.P_) !== "11,00,00,00") throw new Error("Klein's latents without references: " + kleinLatents(k.P_));
    if (k.P_.ref_pos3.inputs.conditioning.join() !== "ref_pos2,0" || k.P_.guider.inputs.positive.join() !== "ref_pos3,0") throw new Error("Klein's chain was cut: " + JSON.stringify([k.P_.ref_pos3.inputs, k.P_.guider.inputs]));
    out.none = { qwen: qwenKeys(q.P_), klein: kleinLatents(k.P_) };
    // both load from nodes "unet", "clip" and "vae": each run keeps its own recipe's files after the other (Klein was
    // queued with Qwen's files, docs/BUGS.md)
    const own = (id, P_) => {
        const r = host.shell.recipes().find((x) => x.id === id);
        const bad = (r.settings || []).filter((s) => P_[s.node].inputs[s.input] !== (s.default !== undefined ? s.default : r.prompt[s.node].inputs[s.input]));
        if (bad.length) throw new Error(id + " after the other recipe sent " + bad.map((s) => s.input + "=" + P_[s.node].inputs[s.input]).join(", "));
        return P_.unet.inputs.unet_name;
    };
    own(KLEIN, k.P_);
    q = await go(QWEN);
    out.ownFiles = [own(QWEN, q.P_), own(KLEIN, (await go(KLEIN)).P_)];
    // three references; a new one goes below the others, so r1 is img1
    for (const name of ["r1", "r2", "r3"]) {
        const l = await run("add_paint_layer", { doc, name });
        await run("set_layer", { doc, layer: l.id, role: "reference" });
        ids.push(l.id);
    }
    if (ed.refSnapshot().refIds.join() !== ids.join()) throw new Error("the references' order: " + ed.referenceLayers().map((l) => l.name));
    // 2. one shown reference, a green fill with the Original: the crop <image1>, the Original <image2>, img1 <image3>
    await run("set_layer", { doc, layer: ids[1], visible: false });
    await run("set_layer", { doc, layer: ids[2], visible: false });
    await run("set_crop", { doc, fill: "green", withOriginal: true });
    await run("set_prompt", { doc, text: "the hat of @img1" });
    q = await go(QWEN);
    if (q.st.prompt !== "the hat of <image3>" || q.st.named_refs !== true || q.st.references.length !== 1) throw new Error("Qwen with the Original: " + JSON.stringify({ p: q.st.prompt, named: q.st.named_refs, refs: q.st.references.length }));
    if (qwenKeys(q.P_) !== "1:img0,2:img1,3:img2") throw new Error("Qwen's inputs with the Original: " + qwenKeys(q.P_));
    if (ed.promptText !== "the hat of @img1") throw new Error("the run changed the document's prompt: " + ed.promptText);
    if (!/@img1 . <image3>/.test(ed.status)) throw new Error("the status names no mapping: " + ed.status);
    if (ed.lastSentPrompt !== "the hat of <image3>") throw new Error("lastSentPrompt: " + ed.lastSentPrompt);
    k = await go(KLEIN);
    if (k.st.prompt !== "the hat of image 3" || kleinLatents(k.P_) !== "11,11,11,00") throw new Error("Klein with the Original: " + JSON.stringify({ p: k.st.prompt, l: kleinLatents(k.P_) }));
    out.original = { qwen: q.st.prompt, klein: k.st.prompt };
    // the same through the Generate button's path (the click's snapshot)
    pick(QWEN);
    sent = null;
    const g = await ed.generate();
    if (g && g.error) throw g.error;
    if (!sent || JSON.parse(sent.output.canvas.inputs.canvas_state).prompt !== "the hat of <image3>") throw new Error("ed.generate() sent " + (sent && JSON.parse(sent.output.canvas.inputs.canvas_state).prompt));
    // 3. a refine pass fills nothing, so no Original: img1 is <image2>
    await run("set_generation", { doc, refine: true });
    q = await go(QWEN);
    if (q.st.prompt !== "the hat of <image2>" || qwenKeys(q.P_) !== "1:img0,2:img1") throw new Error("Qwen on a refine pass: " + JSON.stringify({ p: q.st.prompt, k: qwenKeys(q.P_) }));
    await run("set_generation", { doc, refine: false });
    out.refine = q.st.prompt;
    // 4. three references, no Original, tokens in the prompt and the negative (Qwen reads the negative)
    await run("set_layer", { doc, layer: ids[1], visible: true });
    await run("set_layer", { doc, layer: ids[2], visible: true });
    await run("set_crop", { doc, withOriginal: false });
    await run("set_prompt", { doc, text: "@img3 and @img1", negative: "no @img2" });
    q = await go(QWEN);
    if (q.st.prompt !== "<image4> and <image2>" || q.st.negative !== "no <image3>") throw new Error("Qwen with three references: " + JSON.stringify([q.st.prompt, q.st.negative]));
    if (qwenKeys(q.P_) !== "1:img0,2:img1,3:img2,4:img3") throw new Error("Qwen's inputs with three references: " + qwenKeys(q.P_));
    if (ed.negativeText !== "no @img2") throw new Error("the run changed the document's negative: " + ed.negativeText);
    out.three = [q.st.prompt, q.st.negative];
    // 5. Klein with three references and the Original reads four pictures: @img3 cannot be named; without it the run
    // goes with two references and says the third is not sent
    await run("set_crop", { doc, withOriginal: true });
    await run("set_prompt", { doc, text: "@img3 and @img1", negative: "" });
    out.slots = await refused(KLEIN, /@img3 cannot be named: .* reads 4 pictures [(]the crop, the Original, img1 and img2[)][.] Hide a reference, turn Original off, or take @img3 out[.]/, "a token past Klein's four pictures");
    await run("set_prompt", { doc, text: "@img1 and @img2" });
    k = await go(KLEIN);
    if (k.st.references.length !== 2 || k.st.prompt !== "image 3 and image 4" || kleinLatents(k.P_) !== "11,11,11,11") throw new Error("Klein past its slots: " + JSON.stringify({ refs: k.st.references.length, p: k.st.prompt, l: kleinLatents(k.P_) }));
    if (!/img3 is not sent/.test(ed.status)) throw new Error("the status does not say what was left out: " + ed.status);
    // 6. a hidden reference's token refuses, before anything is queued
    await run("set_prompt", { doc, text: "the coat of @img2" });
    await run("set_layer", { doc, layer: ids[1], visible: false });
    if (ed.promptText !== "the coat of @img?" + ids[1]) throw new Error("the hidden reference's token was not parked: " + ed.promptText);
    out.hidden = await refused(QWEN, /hidden reference/, "a hidden reference's token");
    await run("set_layer", { doc, layer: ids[1], visible: true });
    // 7. the Info panel names what each shown reference goes as
    await run("set_prompt", { doc, text: "@img1" });
    pick(QWEN);
    ed.renderInfo();
    await wait(500);
    const info = ed.infoEl ? ed.infoEl.textContent : "";
    if (!info.includes("img1 → <image3>") || !info.includes("img3 → <image5>")) throw new Error("the Info panel: " + info);
    const bar = ed.refContext();
    if (bar.cap !== 8 || bar.refs.map((d) => d.sentAs).join() !== "<image3>,<image4>,<image5>") throw new Error("the prompt field's context: " + JSON.stringify({ cap: bar.cap, sent: bar.refs.map((d) => d.sentAs) }));
    out.info = info.slice(info.indexOf("References"), info.indexOf("References") + 80);
    out.queued = queued;
    return out;
} finally {
    host.connected = saved.connected; host.objectInfo = saved.objectInfo; host.ensureOnServer = saved.ensure; api.queuePrompt = saved.queue; ed.helperUsed = saved.helper;
    for (const id of ids) { try { await run("remove_layer", { doc, layer: id }); } catch (_) { /* gone */ } }
    try { await run("set_crop", { doc, fill: "none", withOriginal: false }); } catch (_) { /* gone */ }
    try { await run("set_generation", { doc, refine: false }); } catch (_) { /* gone */ }
    try { await run("set_prompt", { doc, text: "", negative: "" }); } catch (_) { /* gone */ }
    if (window.__prev) window.__shell.selectRecipe(window.__prev);
}
"""

CLEANUP = """
const out = {};
try { await window.scumble.recipes.remove("%s"); out.removed = true; } catch (err) { out.removed = String(err.message || err); }
await window.__shell.loadRecipes();
const list = await window.scumble.recipes.list();
out.left = list.filter((x) => x.id === "%s").length;
if (window.__prev) window.__shell.selectRecipe(window.__prev);
out.recipe = document.getElementById("shell-recipe").value;
try { await run("close_document", { doc: window.__r, force: true }); } catch (_) { /* gone */ }
window.__r = null;
if (out.left) throw new Error("the imported recipe is still served");
return out;
"""


async def run_all(c):
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); window.__host = (await import('./editor/host.js')).host; await import('./shell.js'); return 1; })()")
    tmp = tempfile.mkdtemp(prefix="scumble-recipes-")
    good, bad = write_files(tmp)
    ok = True

    async def js(name, body, timeout=120):
        res = await c.eval(PRE % body, timeout=timeout)
        print("[ok] %s: %s" % (name, json.dumps(res)[:280]))
        return res

    try:
        print("[ok] the_recipes_and_the_importer_in_plain_node: %s" % json.dumps(node_step()))
        await js("setup", SETUP)
        await js("flux2_flex_on_fal_has_three_slots_and_sends_three_values", THREE_SLOTS)
        await js("a_copy_with_an_own_variant_imports_and_is_served",
                 IMPORT_MINE % (json.dumps(good), MINE, MINE, MY_MODEL, MINE, MINE, MY_MODEL))
        await js("a_provider_recipe_without_a_provider_is_refused_and_writes_nothing", IMPORT_BAD % json.dumps(bad))
        await js("local_recipes_name_the_batch_pictures_and_trim_the_unused_slots", LOCAL_REFS)
    except Exception as err:  # noqa: BLE001
        ok = False
        print("[FAIL]", err)
    finally:
        try:
            await js("cleanup", CLEANUP % (MINE, MINE))
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] cleanup:", err)
        shutil.rmtree(tmp, ignore_errors=True)
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:220])
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
