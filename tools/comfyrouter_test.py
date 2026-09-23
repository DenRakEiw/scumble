"""Comfy Router end to end without a key: the adapter in plain Node, then the app against tools/comfyrouter_mock.py.

No ComfyUI and no Comfy account. The first step runs tools/comfyrouter_test.js (the adapter against a scripted fetch
and the published model schemas). The rest drives the running app over CDP with settings.comfyrouter.base pointed at
the mock on 127.0.0.1 (the only base besides api.comfy.org that the adapter accepts) and a test key stored in the
Comfy Cloud row, the key Comfy Router runs on. The key starts with "test-": the adapter sends such a key only to a
loopback base, and any other key never to one.

- Settings › API providers has no Comfy Router row (it shares the Comfy Cloud key), the sixteen recipes list
  "comfyrouter" last and keep their defaults, and the provider select says "Comfy Router (no key)" until the Comfy
  Cloud key is stored, "Comfy Router" after;
- GPT Image 2 inpaints: one submit to /v2/models/openai/gpt-image-2/requests with X-API-Key, a UUID Idempotency-Key
  and Content-Type, the crop as image[0] at the emitted size and the alpha mask at the same size, then status reads
  and one result read on URLs the adapter composed (the mock's answer names another host), a result layer, and the
  log line with the request id and the credits;
- Nano Banana 2 inpaints through Gemini's shape (the crop and the mask as inlineData), FLUX.2 [pro] edits and its
  answer is fetched from the linked asset without the key;
- Magnific Precision upscales the selection through freepik/ai-image-upscaler-precision-v2 at factor 2;
- Generate new on Seedream 5.0 Lite asks for a size inside 3.7 to 9.4 MP without a picture and gets that base;
- 402 insufficient_credits reaches the status line in words and is not sent again; a 429 is sent once more after
  Retry-After under the same Idempotency-Key; a key the queue refuses (not_enabled) goes to the synchronous route; a
  run that completes with content_policy_violation says so;
- a real-looking key is never sent to the test address.

A profile that already holds a Comfy Cloud key is refused, never overwritten; the test key, settings.comfyrouter, the
remembered providers and the selected recipe are put back at the end whatever happens.

    python tools/comfyrouter_test.py

Start the app first (with --no-comfy: a result is uploaded into the mirror and would be forwarded to a connected
ComfyUI): bash tools/run_gates.sh <label> --offline --tiles on comfyrouter
"""
import asyncio
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402
from comfyrouter_mock import Mock  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE_TEST = os.path.join(ROOT, "tools", "comfyrouter_test.js")
KEY = "test-comfyrouter-gate-0123456789"
REAL_KEY = "comfyui-0f1e2d3c4b5a69788796a5b4c3d2e1f0aabbccdd"   # the shape of a Comfy key; never a real one
OTHER_RECIPES = ["hy_image_3_5"]   # put back by the cleanup too
RECIPES = ["flux1_fill", "flux2_max", "flux2_pro", "gpt_image_2", "gpt_image_2_5_flare", "gpt_image_2_5_sunburst", "grok_imagine", "ideogram_4",
           "krea_2", "magnific_precision", "nano_banana_2", "nano_banana_2_lite", "nano_banana_pro", "qwen_image_edit", "seedream_5_lite", "seedream_5_pro"]
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
PROMPT = "a red car in the rain"
TEXT_PROMPT = "a lighthouse at dusk"


class Stop(Exception):
    """A step the rest stands on failed (its line is printed already)."""


PRE = """(async () => {
    const commands = window.__crCmds.commands, host = window.__crHost, shell = window.__crShell;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const rowOf = (re) => Array.from(document.querySelectorAll(".shell-provider")).find((r) => re.test(r.textContent));
    const logMark = async () => { const l = await run("read_log", { limit: 1 }); const e = l.entries[l.entries.length - 1]; return e ? e.id : 0; };
    const logSince = async (id) => (await run("read_log", { after: id, limit: 500 })).entries;
    const fresh = async () => {
        const ed = ednow(window.__crDoc);
        host.shell.activate(ed);
        if (ed.width !== 1200 || ed.height !== 800) await run("new_canvas", { doc: window.__crDoc, width: 1200, height: 800, color: "#708090" });
        await run("select_rect", { doc: window.__crDoc, x: 400, y: 250, width: 420, height: 280 });
        return ed;
    };
    %s
})()"""

SETUP = """
window.__cr = null;
window.__crDoc = null;
const had = await window.scumble.keys.list();
if ((had.keys || {}).comfycloud && had.keys.comfycloud.set) throw new Error("this profile holds a Comfy Cloud key; the test never overwrites a key");
const s = await window.scumble.settings.get();
window.__cr = { saved: { comfyrouter: s.comfyrouter, recipeProviders: s.recipeProviders || {}, recipe: s.recipe, recipeByMode: s.recipeByMode }, recipe: host.recipe, stored: false };
await window.scumble.settings.set({ comfyrouter: { base: __MOCK__ } });
const d = await run("new_document");
window.__crDoc = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { doc: d.id, width: 1200, height: 800, color: "#708090" });
await run("select_rect", { doc: d.id, x: 400, y: 250, width: 420, height: 280 });
await run("set_prompt", { doc: d.id, text: __PROMPT__ });
return { size: [ed.width, ed.height], recipe: host.recipe && host.recipe.id };
"""

LISTS_BEFORE_THE_KEY = """
const list = await window.scumble.providers.list();
const row = list.find((p) => p.id === "comfyrouter");
if (!row || row.label !== "Comfy Router" || row.sharesKey !== "comfycloud" || (row.key && row.key.set)) throw new Error("the Comfy Router provider entry: " + JSON.stringify(row));
const shared = list.filter((p) => p.sharesKey).map((p) => p.id + ":" + p.sharesKey).sort();
if (JSON.stringify(shared) !== JSON.stringify(["comfypartner:comfycloud", "comfyrouter:comfycloud"])) throw new Error("the entries that share a key: " + shared);
const remembered = (await window.scumble.settings.get()).recipeProviders || {};
const rl = await run("list_recipes");
const withIt = rl.recipes.filter((r) => (r.providers || []).includes("comfyrouter"));
const ids = withIt.map((r) => r.id).sort();
if (JSON.stringify(ids) !== JSON.stringify(__RECIPES__)) throw new Error("recipes that list comfyrouter: " + ids.join(", "));
for (const r of withIt) {
    if (r.providers[r.providers.length - 1] !== "comfyrouter") throw new Error(r.id + ": comfyrouter is not last: " + r.providers.join(", "));
    const raw = host.shell.recipes().find((x) => x.id === r.id);
    if (raw.default === "comfyrouter") throw new Error(r.id + ": the file's default is comfyrouter");
    if (!remembered[r.id] && r.provider !== raw.default) throw new Error(r.id + ": the default moved to " + r.provider);
}
await shell.openSettings();
await wait(300);
const rows = Array.from(document.querySelectorAll(".shell-provider")).map((x) => x.textContent);
const cloud = rowOf(/^Comfy Cloud/);
const options = {};
try {
    if (rows.some((t) => /^Comfy (Router|Partner)/.test(t))) throw new Error("a Comfy Router or Partner API key row: " + rows.filter((t) => /^Comfy/.test(t)));
    if (!cloud || !/no key/.test(cloud.textContent) || !/Comfy Router/.test(cloud.querySelector("input").placeholder)) throw new Error("the Comfy Cloud row: " + (cloud ? cloud.textContent + " / " + cloud.querySelector("input").placeholder : "missing"));
    for (const id of ids) {
        const sel = document.querySelector('.shell-recipe[data-id="' + id + '"] select');
        if (!sel) throw new Error("no provider select for " + id);
        const o = Array.from(sel.options).find((x) => x.value === "comfyrouter");
        options[id] = o && o.textContent;
        if (options[id] !== "Comfy Router (no key)") throw new Error(id + ": the option reads " + options[id]);
    }
} finally {
    document.getElementById("shell-settings").close();
}
return { rows: rows.length, cloudHint: cloud.querySelector("input").placeholder, option: options.gpt_image_2 };
"""

KEY_STORED = """
await window.scumble.keys.set("comfycloud", __KEY__);
window.__cr.stored = true;
await shell.openSettings();
await wait(300);
const sel = document.querySelector('.shell-recipe[data-id="gpt_image_2"] select');
const option = sel && Array.from(sel.options).find((o) => o.value === "comfyrouter");
const label = option ? option.textContent : null;
const cloud = rowOf(/^Comfy Cloud/);
const text = cloud ? cloud.textContent : "";
document.getElementById("shell-settings").close();
if (!/key set/.test(text)) throw new Error("the Comfy Cloud row with a key: " + text);
if (label !== "Comfy Router") throw new Error("with the Comfy Cloud key the option reads " + label);
const list = await window.scumble.providers.list();
const row = list.find((p) => p.id === "comfyrouter");
if (!row.key || !row.key.set) throw new Error("the Comfy Router entry does not see the Comfy Cloud key: " + JSON.stringify(row.key));
return { option: label, cloudRow: text.slice(0, 60) };
"""

EDIT = """
const ed = await fresh();
await run("select_recipe", { id: __ID__, provider: "comfyrouter" });
const r = host.recipe;
if (!r || r.id !== __ID__ || r.provider !== "comfyrouter" || r.model !== __MODEL__) throw new Error("select_recipe gave " + (r && [r.id, r.provider, r.model].join(" ")));
const stitch = await import("./editor/stitch.js");
const info = stitch.prepareCrop(ed, host.nodeParams, host.cropLimits()).info;
const mark = await logMark();
const before = ed.layers.length;
await run("generate", { doc: window.__crDoc, timeout: 120 });
if (ed.layers.length !== before + 1) throw new Error("no result layer: " + ed.status);
const log = (await logSince(mark)).filter((e) => e.source === "comfyrouter");
return { emitted: info.emitted, input: r.input, status: ed.status, log };
"""

UPSCALE = """
const ed = await fresh();
await run("select_recipe", { id: "magnific_precision", provider: "comfyrouter" });
if (host.recipe.provider !== "comfyrouter") throw new Error("not on comfyrouter: " + host.recipe.provider);
const mark = await logMark();
const before = ed.layers.length;
const out = await run("upscale", { doc: window.__crDoc, scope: "selection", factor: 2, timeout: 120 });
if (ed.layers.length !== before + 1) throw new Error("no result layer: " + ed.status);
const log = (await logSince(mark)).filter((e) => e.source === "comfyrouter");
return { status: ed.status, log, out: out && { factor: out.factor, scope: out.scope } };
"""

GENERATE_NEW = """
const ed = ednow(window.__crDoc);
host.shell.activate(ed);
await run("select_recipe", { id: "seedream_5_lite", provider: "comfyrouter" });
const t = host.recipe.text;
if (!t || t.model !== "byteplus/seedream-5-0-260128") throw new Error("the Router variant's text shape: " + JSON.stringify(t));
const mark = await logMark();
await run("generate_new", { doc: window.__crDoc, prompt: __TEXT__, aspect: "16:9", resolution: 3072, timeout: 120 });
const log = (await logSince(mark)).filter((e) => e.source === "comfyrouter");
return { size: [ed.width, ed.height], status: ed.status, log };
"""

# a synthetic variant of the shipped GPT Image 2 one, resolved like a recipe
SYNTHETIC = """
const ed = await fresh();
const raw = host.shell.recipes().find((x) => x.id === "gpt_image_2");
const v = { ...raw.providers.comfyrouter, model: __MODEL__ };
const r = host.shell.resolveRecipe({ ...raw, id: "cr_test", default: "comfyrouter", providers: { ...raw.providers, comfyrouter: v } });
if (r.provider !== "comfyrouter" || r.model !== __MODEL__) throw new Error("resolved to " + r.provider + " / " + r.model);
host.setRecipe(r);
const mark = await logMark();
const before = ed.layers.length;
let msg = "";
const t0 = Date.now();
try { await run("generate", { doc: window.__crDoc, timeout: 120 }); } catch (err) { msg = String(err.message || err); }
const all = await logSince(mark);
return { error: msg, status: ed.status, layers: ed.layers.length - before, seconds: (Date.now() - t0) / 1000, log: all.filter((e) => e.source === "comfyrouter"), logText: JSON.stringify(all) };
"""

# HY Image 3.5 through the Partner API: an edit on the selection, then Generate new
HY_EDIT = """
const ed = await fresh();
await run("set_prompt", { doc: window.__crDoc, text: __PROMPT__ });
await run("select_recipe", { id: "hy_image_3_5", provider: "comfypartner" });
const r = host.recipe;
if (!r || r.provider !== "comfypartner" || r.model !== "hy-image-v3.5-preview") throw new Error("select_recipe gave " + (r && [r.id, r.provider, r.model].join(" ")));
const stitch = await import("./editor/stitch.js");
const info = stitch.prepareCrop(ed, host.nodeParams, host.cropLimits()).info;
const mark = await logMark();
const before = ed.layers.length;
let err = "";
try { await run("generate", { doc: window.__crDoc, timeout: 120 }); } catch (e) { err = String(e.message || e); }
const log = (await logSince(mark)).filter((e) => e.source === "comfypartner");
await run("set_prompt", { doc: window.__crDoc, text: __BASEPROMPT__ });
return { emitted: info.emitted, err, status: ed.status, layers: ed.layers.length - before, log };
"""

HY_TEXT = """
const ed = ednow(window.__crDoc);
host.shell.activate(ed);
await run("select_recipe", { id: "hy_image_3_5", provider: "comfypartner" });
const mark = await logMark();
await run("generate_new", { doc: window.__crDoc, prompt: __TEXT__, aspect: "16:9", resolution: 2048, timeout: 120 });
const log = (await logSince(mark)).filter((e) => e.source === "comfypartner");
return { size: [ed.width, ed.height], status: ed.status, log };
"""

REAL_KEY_REFUSED = """
const ed = await fresh();
await window.scumble.keys.set("comfycloud", __REALKEY__);
const out = {};
try {
    await run("select_recipe", { id: "gpt_image_2", provider: "comfyrouter" });
    const before = ed.layers.length;
    try { await run("generate", { doc: window.__crDoc, timeout: 60 }); out.generate = "no error"; } catch (err) { out.generate = String(err.message || err); }
    out.layers = ed.layers.length - before;
} finally {
    await window.scumble.keys.set("comfycloud", __KEY__);
}
return out;
"""

CLEANUP = """
const out = {};
const t = window.__cr;
if (t && t.stored) { await window.scumble.keys.clear("comfycloud"); out.keyCleared = true; }
for (const d of document.querySelectorAll("dialog[open]")) d.close();
if (t) {
    const s = t.saved;
    await window.scumble.settings.set({ comfyrouter: s.comfyrouter, recipeProviders: s.recipeProviders, recipe: s.recipe, recipeByMode: s.recipeByMode });
    // the shell keeps its own copy of the settings: openSettings re-reads it, and every recipe goes back through selectRecipe
    await shell.openSettings();
    document.getElementById("shell-settings").close();
    for (const id of __RECIPES__) { const want = (s.recipeProviders || {})[id]; if (want) host.shell.selectRecipe(id, want); }
    if (t.recipe && t.recipe.id === s.recipe) host.shell.selectRecipe(t.recipe.id);
    else if (t.recipe) host.setRecipe(t.recipe);
}
if (window.__crDoc) { try { await run("close_document", { doc: window.__crDoc, force: true }); } catch (_) { /* gone */ } }
const k = await window.scumble.keys.list();
out.keyLeft = !!((k.keys || {}).comfycloud && k.keys.comfycloud.set);
if (t) {
    if (out.keyLeft) throw new Error("the test key is still stored");
    const now = await window.scumble.settings.get();
    const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
    out.restored = same(now.comfyrouter, t.saved.comfyrouter) && same(now.recipeProviders, t.saved.recipeProviders) && same(now.recipe, t.saved.recipe);
    if (!out.restored) throw new Error("the settings are not back: " + JSON.stringify({ comfyrouter: now.comfyrouter, recipeProviders: now.recipeProviders, recipe: now.recipe }));
}
window.__cr = null; window.__crDoc = null;
return out;
"""


def node_step():
    r = subprocess.run(["node", NODE_TEST], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=180)
    tail = (r.stdout + r.stderr).strip()
    if r.returncode != 0 or not tail.endswith("PASS"):
        lines = tail.splitlines()
        failed = [ln for ln in lines if ln.startswith("[FAIL]")]
        counted = [ln for ln in lines if " checks passed" in ln]
        shown = "\n    ".join([ln[:400] for ln in failed] + counted[-1:]) if failed else tail[-1500:]
        raise Exception("tools/comfyrouter_test.js (rc %d):\n    %s" % (r.returncode, shown))
    return {"checks": tail.count("[ok]")}


def log_detail(entry):
    d = entry.get("detail")
    if isinstance(d, dict):
        return d
    try:
        return json.loads(d) if d else {}
    except ValueError:
        return {}


def ok_entry(res, verb):
    ok = [e for e in res.get("log") or [] if e.get("level") == "info" and ("Comfy Router %s ok" % verb) in str(e.get("message"))]
    if len(ok) != 1:
        raise Exception("expected one 'Comfy Router %s ok' line in the log, found %s" % (verb, [e.get("message") for e in res.get("log") or []]))
    return ok[0], (log_detail(ok[0]).get("info") or {})


def check_key_absent(texts, what):
    for t in texts:
        if KEY in str(t) or REAL_KEY in str(t):
            raise Exception("a key is in %s" % what)


def queue_calls(snap, model_id):
    """The submit, the status reads, the result reads and anything else of one run, by route."""
    root = "/v2/models/" + model_id
    out = {"submit": [], "status": [], "result": [], "sync": [], "asset": [], "other": []}
    for cl in snap["calls"]:
        p = cl["path"].split("?")[0]
        if cl["method"] == "POST" and p == root + "/requests":
            out["submit"].append(cl)
        elif cl["method"] == "POST" and p == root:
            out["sync"].append(cl)
        elif cl["method"] == "GET" and p.startswith(root + "/requests/") and p.endswith("/status"):
            out["status"].append(cl)
        elif cl["method"] == "GET" and p.startswith(root + "/requests/"):
            out["result"].append(cl)
        elif cl["method"] == "GET" and p.startswith("/asset/"):
            out["asset"].append(cl)
        else:
            out["other"].append(cl)
    return out


def check_run(mock, res, model_id, verb):
    """One queued run: a submit with the three headers, status reads and one result read with the key alone."""
    q = queue_calls(mock.snapshot(), model_id)
    if len(q["submit"]) != 1 or not q["status"] or len(q["result"]) != 1 or q["other"] or q["sync"]:
        raise Exception("the mock saw %s" % {k: [(c["method"], c["path"]) for c in v] for k, v in q.items() if v})
    h = q["submit"][0]["headers"]
    if h.get("x-api-key") != KEY or not UUID.match(h.get("idempotency-key") or "") or not str(h.get("content-type") or "").startswith("application/json") or "authorization" in h:
        raise Exception("the submit's headers: %s" % {k: v for k, v in h.items() if k in ("x-api-key", "idempotency-key", "content-type", "authorization")})
    for cl in q["status"] + q["result"]:
        if cl["headers"].get("x-api-key") != KEY:
            raise Exception("a read without the key: %s" % cl["path"])
    for cl in q["asset"]:
        if "x-api-key" in cl["headers"] or "authorization" in cl["headers"]:
            raise Exception("the asset download carried a key")
    entry, info = ok_entry(res, verb)
    if info.get("model") != model_id or not UUID.match(str(info.get("request_id") or "")) or info.get("credits") != 12.5:
        raise Exception("the log line's info: %s" % info)
    check_key_absent([json.dumps(res.get("log")), res.get("status")], "the log or the status line")
    return q, entry, info


async def run_all(c):
    mock = Mock().start()
    print("mock Comfy Router on", mock.url)
    ok = True

    async def ev(body, **subs):
        for k, v in subs.items():
            body = body.replace(k, v)
        return await c.eval(PRE % body, timeout=240)

    def done(name, res):
        print("[ok] %s: %s" % (name, json.dumps(res, ensure_ascii=False)[:700]))

    async def step(name, fn):
        nonlocal ok
        try:
            await fn()
            return True
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] %s: %s" % (name, err))
            return False

    recipes = json.dumps(RECIPES)
    try:
        async def adapter():
            done("adapter_in_plain_node", node_step())
        await step("adapter_in_plain_node", adapter)

        await c.eval("(async () => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); window.__crCmds = await import('./commands.js'); window.__crHost = (await import('./editor/host.js')).host; window.__crShell = await import('./shell.js'); return 1; })()")

        async def setup():
            done("setup", await ev(SETUP, __MOCK__=json.dumps(mock.url), __PROMPT__=json.dumps(PROMPT)))
        if not await step("setup", setup):
            raise Stop()

        async def lists():
            done("the_lists_before_the_key", await ev(LISTS_BEFORE_THE_KEY, __RECIPES__=recipes))
        if not await step("the_lists_before_the_key", lists):
            raise Stop()

        async def stored():
            done("the_comfy_cloud_key_serves_comfy_router", await ev(KEY_STORED, __KEY__=json.dumps(KEY)))
        if not await step("the_comfy_cloud_key_serves_comfy_router", stored):
            raise Stop()

        async def gpt():
            mock.reset()
            res = await ev(EDIT, __ID__=json.dumps("gpt_image_2"), __MODEL__=json.dumps("openai/gpt-image-2"))
            q, entry, info = check_run(mock, res, "openai/gpt-image-2", "edit")
            ew, eh = res["emitted"]
            pics = q["submit"][0]["pictures"]
            body = q["submit"][0]["json"]
            if [p["field"] for p in pics] != ["image", "mask"] or any(p["dims"] != [ew, eh] or p["mime"] != "image/png" for p in pics):
                raise Exception("the pictures %s, the emitted crop %dx%d" % (pics, ew, eh))
            if body.get("n") != 1 or not re.match(r"^\d+x\d+$", str(body.get("size"))) or "model" in body or body.get("prompt") != PROMPT:
                raise Exception("the body: %s" % body)
            done("inpaint_on_gpt_image_2", {"crop": [ew, eh], "size": body["size"], "status_reads": len(q["status"]), "log": entry.get("message"), "credits": info.get("credits")})
        await step("inpaint_on_gpt_image_2", gpt)

        async def gemini():
            mock.reset()
            res = await ev(EDIT, __ID__=json.dumps("nano_banana_2"), __MODEL__=json.dumps("vertexai/gemini-3.1-flash-image"))
            q, entry, _info = check_run(mock, res, "vertexai/gemini-3.1-flash-image", "edit")
            ew, eh = res["emitted"]
            pics = q["submit"][0]["pictures"]
            if len(pics) != 2 or any(p["dims"] != [ew, eh] for p in pics):
                raise Exception("the inlineData parts %s, the crop %dx%d" % (pics, ew, eh))
            gc = q["submit"][0]["json"].get("generationConfig") or {}
            if gc.get("responseModalities") != ["IMAGE"]:
                raise Exception("generationConfig %s" % gc)
            done("inpaint_on_nano_banana_2", {"parts": len(pics), "generationConfig": gc, "log": entry.get("message")})
        await step("inpaint_on_nano_banana_2", gemini)

        async def flux():
            mock.reset()
            res = await ev(EDIT, __ID__=json.dumps("flux2_pro"), __MODEL__=json.dumps("bfl/flux-2-pro"))
            q, entry, _info = check_run(mock, res, "bfl/flux-2-pro", "edit")
            b = q["submit"][0]["json"]
            ew, eh = res["emitted"]
            if len(q["asset"]) != 1 or b.get("width") != ew or b.get("height") != eh or q["submit"][0]["pictures"][0]["field"] != "input_image":
                raise Exception("FLUX.2: %s, assets %d" % ({k: b.get(k) for k in ("width", "height")}, len(q["asset"])))
            done("edit_on_flux2_pro_fetches_the_asset_without_the_key", {"size": [b["width"], b["height"]], "asset": q["asset"][0]["path"], "log": entry.get("message")})
        await step("edit_on_flux2_pro_fetches_the_asset_without_the_key", flux)

        async def upscale():
            mock.reset()
            res = await ev(UPSCALE)
            q, entry, _info = check_run(mock, res, "freepik/ai-image-upscaler-precision-v2", "upscale")
            b = q["submit"][0]["json"]
            if b.get("scale_factor") != 2 or q["submit"][0]["pictures"][0]["field"] != "image" or len(q["asset"]) != 1:
                raise Exception("the upscale body %s" % {k: v for k, v in b.items() if k != "image"})
            done("upscale_on_magnific_precision", {"factor": b["scale_factor"], "picture": q["submit"][0]["pictures"][0]["dims"], "asset": q["asset"][0]["path"], "log": entry.get("message")})
        await step("upscale_on_magnific_precision", upscale)

        async def text():
            mock.reset()
            res = await ev(GENERATE_NEW, __TEXT__=json.dumps(TEXT_PROMPT))
            q, entry, _info = check_run(mock, res, "byteplus/seedream-5-0-260128", "generate")
            b = q["submit"][0]["json"]
            m = re.match(r"^(\d+)x(\d+)$", str(b.get("size")))
            if "image" in b or not m or b.get("prompt") != TEXT_PROMPT or b.get("watermark") is not False:
                raise Exception("the text request: %s" % b)
            w, h = int(m.group(1)), int(m.group(2))
            if not (3686400 <= w * h <= 9437184) or abs(w / h - 16 / 9) > 0.02 or res["size"] != [w, h]:
                raise Exception("size %s, the new base %s" % (b["size"], res["size"]))
            done("generate_new_on_seedream_5_lite", {"size": b["size"], "base": res["size"], "log": entry.get("message")})
        await step("generate_new_on_seedream_5_lite", text)

        async def credits():
            mock.reset()
            res = await ev(SYNTHETIC, __MODEL__=json.dumps("openai/mock-credits"))
            q = queue_calls(mock.snapshot(), "openai/mock-credits")
            if "no credits left" not in res["error"] or "no credits left" not in res["status"] or len(q["submit"]) != 1 or res["layers"] != 0:
                raise Exception("insufficient_credits: %s, %d submits" % (json.dumps({k: res[k] for k in ("error", "status", "layers")})[:500], len(q["submit"])))
            check_key_absent([res["logText"], res["error"], res["status"]], "the log, the error or the status line")
            done("no_credits_reach_the_status_line", {"status": res["status"][:200], "submits": 1})
        await step("no_credits_reach_the_status_line", credits)

        async def busy():
            mock.reset()
            res = await ev(SYNTHETIC, __MODEL__=json.dumps("openai/mock-busy"))
            q = queue_calls(mock.snapshot(), "openai/mock-busy")
            keys = [cl["headers"].get("idempotency-key") for cl in q["submit"]]
            if res["error"] or res["layers"] != 1 or len(q["submit"]) != 2 or len(set(keys)) != 1 or res["seconds"] < 1:
                raise Exception("a 429: %s, submits %s, %.2f s" % (json.dumps({k: res[k] for k in ("error", "status", "layers")})[:400], keys, res["seconds"]))
            done("a_rate_limit_is_sent_again_under_the_same_key", {"submits": 2, "key": keys[0], "seconds": round(res["seconds"], 2)})
        await step("a_rate_limit_is_sent_again_under_the_same_key", busy)

        async def noqueue():
            mock.reset()
            res = await ev(SYNTHETIC, __MODEL__=json.dumps("openai/mock-noqueue"))
            q = queue_calls(mock.snapshot(), "openai/mock-noqueue")
            if res["error"] or res["layers"] != 1 or len(q["submit"]) != 1 or len(q["sync"]) != 1 or q["status"]:
                raise Exception("not_enabled: %s, %s" % (json.dumps({k: res[k] for k in ("error", "status", "layers")})[:400], {k: len(v) for k, v in q.items()}))
            if q["sync"][0]["headers"].get("idempotency-key") == q["submit"][0]["headers"].get("idempotency-key"):
                raise Exception("the synchronous route reused the queue's Idempotency-Key")
            done("a_key_the_queue_refuses_goes_to_the_synchronous_route", {"sync": 1})
        await step("a_key_the_queue_refuses_goes_to_the_synchronous_route", noqueue)

        async def refused():
            mock.reset()
            res = await ev(SYNTHETIC, __MODEL__=json.dumps("openai/mock-refused"))
            if "content filter" not in res["error"] or res["layers"] != 0:
                raise Exception("content_policy_violation: %s" % json.dumps({k: res[k] for k in ("error", "status", "layers")})[:400])
            done("a_refused_run_says_so", {"error": res["error"][:200]})
        await step("a_refused_run_says_so", refused)

        def partner_calls(snap):
            out = {"storage": [], "upload": [], "hy": [], "stored": [], "asset": [], "other": []}
            for cl in snap["calls"]:
                p = cl["path"].split("?")[0]
                if cl["method"] == "POST" and p == "/customers/storage":
                    out["storage"].append(cl)
                elif cl["method"] == "PUT" and p.startswith("/upload/"):
                    out["upload"].append(cl)
                elif cl["method"] == "POST" and p == "/proxy/tencent/v1/wand/hunyuan-image/v35-generation":
                    out["hy"].append(cl)
                elif cl["method"] == "GET" and p.startswith("/stored/"):
                    out["stored"].append(cl)
                elif cl["method"] == "GET" and p.startswith("/asset/"):
                    out["asset"].append(cl)
                else:
                    out["other"].append(cl)
            return out

        async def hy_edit():
            mock.reset()
            res = await ev(HY_EDIT, __PROMPT__=json.dumps(PROMPT), __BASEPROMPT__=json.dumps(PROMPT))
            q = partner_calls(mock.snapshot())
            if res["err"] or res["layers"] != 1:
                raise Exception("no result layer: %s" % json.dumps({k: res[k] for k in ("err", "status")})[:400])
            n = len(q["storage"])
            if n < 1 or len(q["upload"]) != n or len(q["hy"]) != 1 or q["other"] or len(q["asset"]) != 1:
                raise Exception("the mock saw %s" % {k: [(c["method"], c["path"][:60]) for c in v] for k, v in q.items() if v})
            ew, eh = res["emitted"]
            up = q["upload"][0]
            if up["pictures"][0]["dims"] != [ew, eh] or "x-api-key" in up["headers"] or q["asset"][0]["headers"].get("x-api-key"):
                raise Exception("the upload %s (the crop %dx%d), headers %s" % (up["pictures"], ew, eh, list(up["headers"])))
            for cl in q["storage"] + q["hy"]:
                if cl["headers"].get("x-api-key") != KEY:
                    raise Exception("a call without the test key: %s" % cl["path"])
            b = q["hy"][0]["json"]
            content = b["messages"][0]["content"]
            urls = [c["image_url"]["url"] for c in content if c.get("type") == "image_url"]
            if b.get("model") != "hy-image-v3.5-preview" or b.get("size") != "%dx%d" % (ew, eh) or len(urls) != n or b.get("logo_add") != 0 or b.get("resize_max_pixels") != 1048576:
                raise Exception("the HY request: %s" % json.dumps(b)[:500])
            if not content[0]["text"].startswith("Edit Image 1 and keep its size and framing.") or PROMPT not in content[0]["text"]:
                raise Exception("the text: %s" % content[0]["text"])
            ok = [e for e in res["log"] if e.get("level") == "info" and "Comfy Partner API edit ok" in str(e.get("message"))]
            if len(ok) != 1:
                raise Exception("the log: %s" % [e.get("message") for e in res["log"]])
            check_key_absent([json.dumps(res["log"]), res["status"]], "the log or the status line")
            done("hy_image_edits_through_the_partner_api", {"crop": [ew, eh], "pictures": n, "size": b["size"], "log": ok[0]["message"]})
        await step("hy_image_edits_through_the_partner_api", hy_edit)

        async def hy_text():
            mock.reset()
            res = await ev(HY_TEXT, __TEXT__=json.dumps(TEXT_PROMPT))
            q = partner_calls(mock.snapshot())
            b = q["hy"][0]["json"] if len(q["hy"]) == 1 else {}
            m = re.match(r"^(\d+)x(\d+)$", str(b.get("size")))
            if q["storage"] or q["upload"] or not m or "resize_max_pixels" in b or b["messages"][0]["content"] != [{"type": "text", "text": TEXT_PROMPT}]:
                raise Exception("the text run: %s, %s" % ({k: len(v) for k, v in q.items()}, json.dumps(b)[:300]))
            w, h = int(m.group(1)), int(m.group(2))
            if res["size"] != [w, h] or abs(w / h - 16 / 9) > 0.02:
                raise Exception("asked %s, the base is %s" % (b["size"], res["size"]))
            done("hy_image_generate_new", {"size": b["size"], "base": res["size"]})
        await step("hy_image_generate_new", hy_text)

        async def hy_retry():
            mock.reset()
            res = await ev(HY_EDIT, __PROMPT__=json.dumps(PROMPT + " mock-download-failed"), __BASEPROMPT__=json.dumps(PROMPT))
            q = partner_calls(mock.snapshot())
            if res["err"] or res["layers"] != 1 or len(q["hy"]) != 2:
                raise Exception("download image failed: %s, %d HY requests" % (json.dumps({k: res[k] for k in ("err", "status", "layers")})[:300], len(q["hy"])))
            keys = [cl["headers"].get("idempotency-key") for cl in q["hy"]]
            if len(set(keys)) != 2:
                raise Exception("the resend reused its key: %s" % keys)
            done("hy_image_sends_again_when_the_service_could_not_fetch_a_picture", {"requests": 2})
        await step("hy_image_sends_again_when_the_service_could_not_fetch_a_picture", hy_retry)

        async def real_key():
            mock.reset()
            res = await ev(REAL_KEY_REFUSED, __REALKEY__=json.dumps(REAL_KEY), __KEY__=json.dumps(KEY))
            calls = mock.snapshot()["calls"]
            if "test address" not in res.get("generate", "") or res.get("layers") or calls:
                raise Exception("not refused: %s, the mock saw %d calls" % (res, len(calls)))
            check_key_absent([res.get("generate")], "the message")
            done("a_real_key_never_goes_to_the_test_base", {"generate": res["generate"][:200], "requests": 0})
        await step("a_real_key_never_goes_to_the_test_base", real_key)

        # every call of the run: the test key only, and to the mock only (it is the only host the app could reach here)
        seen = mock.all_calls()
        wrong = [cl["path"] for cl in seen if cl["headers"].get("x-api-key") not in (None, KEY)]
        if wrong:
            ok = False
            print("[FAIL] a call with another key: %s" % wrong[:5])
    except Stop:
        pass
    except Exception as err:  # noqa: BLE001
        ok = False
        print("[FAIL]", err)
    finally:
        try:
            res = await c.eval(PRE % CLEANUP.replace("__RECIPES__", json.dumps(RECIPES + OTHER_RECIPES)), timeout=60)
            print("[ok] cleanup: %s" % json.dumps(res))
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] cleanup:", err)
        mock.stop()
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:220])
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
