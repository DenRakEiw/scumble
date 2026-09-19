"""BytePlus ModelArk end to end without a key: the adapter in plain Node, then the app against tools/ark_mock.py.

No ComfyUI and no BytePlus account. The first step runs tools/ark_test.js (the adapter against a scripted fetch)
when that file exists, and is skipped, not failed, when it does not. The rest drives the running app over CDP with
settings.ark.base pointed at the mock on 127.0.0.1 (the only base besides the two regional hosts that the adapter
accepts) and a test key stored under the name "ark". The key starts with "test-": the adapter sends such a key only
to a loopback base, and any other key never to one.

- ToAPIs stays first in Settings › API providers, ModelArk has its row with "get a key" and no balance query, the
  two Seedream 5.0 recipes list "ark" right after "toapis" and keep fal as their default, and the provider select
  says "(no key)" until a key is stored;
- Seedream 5.0 Lite inpaints: one POST /api/v3/images/generations with the crop as image[0] (a PNG data URL of the
  emitted size), size "WxH" in the crop's shape inside the model's pixel range (at least 3,686,400), watermark false,
  response_format b64_json, output_format png, no mask, the key as a Bearer;
- the Region row reaches the adapter: set to eu-west, the run still goes to the test base and the log says eu-west;
- Seedream 5.0 Pro inpaints with its own model id and a size inside [921,600, 4,624,220];
- Generate new asks for 2560x1440 without a picture and gets a 16:9 base of that size;
- a QuotaExceeded puts "free quota" and the server's words in the status line and the log, never the key, and is
  not sent again; a ModelAccountIpmRateLimitExceeded is sent once more after Retry-After; a ModelNotOpen says the
  model is not activated;
- a real-looking key is never sent to the test address (edit and Generate new refuse, the mock sees nothing).

A profile that already holds a ModelArk key is refused, never overwritten; the test key, settings.ark, the
remembered providers and the selected recipe are put back at the end whatever happens.

    python tools/ark_test.py

Start the app first (with --no-comfy: a result is uploaded into the mirror and would be forwarded to a connected
ComfyUI): bash tools/run_gates.sh <label> --offline --tiles on ark
"""
import asyncio
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402
from ark_mock import PATH, Mock  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE_TEST = os.path.join(ROOT, "tools", "ark_test.js")
KEY = "test-ark-gate-0123456789"
REAL_KEY = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0"   # the shape of a ModelArk API key (a UUID); never a real one
LABEL = "BytePlus ModelArk (Seedream)"
KEY_URL = "https://ai.byteplus.com/ark/region:ap-southeast-1/apiKey"
LITE, PRO = "seedream-5-0-260128", "dola-seedream-5-0-pro-260628"
LITE_PIXELS, PRO_PIXELS = (3686400, 16777216), (921600, 4624220)
BODY_KEYS = {"model", "prompt", "image", "size", "watermark", "response_format", "output_format"}
EDIT_PREFIX = "Edit the first image and keep its size and framing."
PROMPT = "a red car in the rain"
TEXT_PROMPT = "a lighthouse at dusk"


class Stop(Exception):
    """A step the rest stands on failed (its line is printed already)."""


PRE = """(async () => {
    const commands = window.__arkCmds.commands, host = window.__arkHost, shell = window.__arkShell;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const arkRow = () => Array.from(document.querySelectorAll(".shell-provider")).find((r) => /^BytePlus ModelArk/.test(r.textContent));
    const logMark = async () => { const l = await run("read_log", { limit: 1 }); const e = l.entries[l.entries.length - 1]; return e ? e.id : 0; };
    const logSince = async (id) => (await run("read_log", { after: id, limit: 500 })).entries;
    const fresh = async () => {
        const ed = ednow(window.__arkDoc);
        host.shell.activate(ed);
        if (ed.width !== 1200 || ed.height !== 800) await run("new_canvas", { doc: window.__arkDoc, width: 1200, height: 800, color: "#708090" });
        await run("select_rect", { doc: window.__arkDoc, x: 400, y: 250, width: 420, height: 280 });
        return ed;
    };
    %s
})()"""

SETUP = """
window.__ark = null;
window.__arkDoc = null;
const had = await window.scumble.keys.list();
if ((had.keys || {}).ark && had.keys.ark.set) throw new Error("this profile holds a ModelArk key; the test never overwrites a key");
const s = await window.scumble.settings.get();
window.__ark = { saved: { ark: s.ark, recipeProviders: s.recipeProviders || {}, recipe: s.recipe, recipeByMode: s.recipeByMode }, recipe: host.recipe, stored: false, realKey: false };
await window.scumble.settings.set({ ark: { base: __MOCK__ } });
const d = await run("new_document");
window.__arkDoc = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { doc: d.id, width: 1200, height: 800, color: "#708090" });
await run("select_rect", { doc: d.id, x: 400, y: 250, width: 420, height: 280 });
await run("set_prompt", { doc: d.id, text: __PROMPT__ });
return { size: [ed.width, ed.height], remembered: Object.keys(s.recipeProviders || {}), recipe: host.recipe && host.recipe.id, arkSetting: s.ark || null };
"""

LISTS_BEFORE_THE_KEY = """
const list = await window.scumble.providers.list();
if (!list[0] || list[0].id !== "toapis") throw new Error("Settings › API providers does not start with ToAPIs: " + list.map((p) => p.id).join(", "));
const row = list.find((p) => p.id === "ark");
if (!row || row.label !== __LABEL__ || row.keyUrl !== __KEYURL__ || row.balance !== false) throw new Error("the ModelArk provider row: " + JSON.stringify(row));
if (row.key && row.key.set) throw new Error("the ModelArk key is set before the test stored one");
let balance = "";
try { await window.scumble.providers.balance("ark"); balance = "no error"; } catch (err) { balance = String(err.message || err); }
if (!/cannot report a balance/.test(balance)) throw new Error("providers.balance(ark) answered " + balance);
const remembered = (await window.scumble.settings.get()).recipeProviders || {};
const rl = await run("list_recipes");
const withArk = rl.recipes.filter((r) => (r.providers || []).includes("ark"));
const ids = withArk.map((r) => r.id).sort();
if (JSON.stringify(ids) !== JSON.stringify(["seedream_5_lite", "seedream_5_pro"])) throw new Error("recipes that list ark: " + ids.join(", "));
const order = {};
for (const r of withArk) {
    const i = r.providers.indexOf("toapis");
    if (i < 0 || r.providers[i + 1] !== "ark") throw new Error(r.id + ": ark does not come right after toapis: " + r.providers.join(", "));
    if (!remembered[r.id] && r.provider !== "fal") throw new Error(r.id + ": the default moved to " + r.provider);
    const raw = host.shell.recipes().find((x) => x.id === r.id);
    if (raw.default !== "fal") throw new Error(r.id + ": the file's default is " + raw.default);
    order[r.id] = r.providers.join(",");
}
await shell.openSettings();
await wait(300);
const keyRow = arkRow();
const rowText = keyRow ? keyRow.textContent : "";
const options = {};
try {
    if (!/get a key/.test(rowText) || /check balance/.test(rowText) || !/no key/.test(rowText)) throw new Error("the ModelArk key row without a key: " + rowText);
    for (const id of ids) {
        const sel = document.querySelector('.shell-recipe[data-id="' + id + '"] select');
        if (!sel) throw new Error("no provider select for " + id);
        const values = Array.from(sel.options).map((o) => o.value);
        const i = values.indexOf("ark");
        if (i < 0 || values[i - 1] !== "toapis") throw new Error(id + ": the select's options are " + values.join(", "));
        options[id] = sel.options[i].textContent;
        if (options[id] !== __LABEL__ + " (no key)") throw new Error(id + ": the ark option reads " + options[id]);
    }
} finally {
    document.getElementById("shell-settings").close();
}
return { providers: list.map((p) => p.id), row: { label: row.label, keyUrl: row.keyUrl, balance: row.balance }, keyRow: rowText.slice(0, 90), order, options, balance: balance.slice(0, 120) };
"""

KEY_STORED = """
await window.scumble.keys.set("ark", __KEY__);
window.__ark.stored = true;
await shell.openSettings();
await wait(300);
const row = arkRow();
const text = row ? row.textContent : "";
const sel = document.querySelector('.shell-recipe[data-id="seedream_5_lite"] select');
const option = sel && Array.from(sel.options).find((o) => o.value === "ark");
const label = option ? option.textContent : null;
document.getElementById("shell-settings").close();
if (!/key set/.test(text) || /check balance/.test(text)) throw new Error("the ModelArk key row with a key: " + text);
if (label !== __LABEL__) throw new Error("with a key the option reads " + label);
return { keyRow: text.slice(0, 90), option: label };
"""

# select_recipe through the commands core, the Region row through set_settings (null: leave it), then a Generate on
# the document's selection; the size the crop is emitted at is computed beforehand by the same function the run uses
EDIT = """
const ed = await fresh();
const sel = await run("select_recipe", { id: __ID__, provider: "ark" });
const r = host.recipe;
if (!r || r.id !== __ID__ || r.provider !== "ark" || r.model !== __MODEL__) throw new Error("select_recipe gave " + JSON.stringify(sel) + " / " + (r && [r.id, r.provider, r.model].join(" ")));
const region = __REGION__;
if (region) await run("set_settings", { doc: window.__arkDoc, values: { Region: region } });
const targets = host.settingTargets(ed).map((t) => ({ index: t.index, label: t.node.title, key: t.inputName, choices: Array.isArray(t.spec && t.spec[0]) ? t.spec[0] : null, value: (ed.settings[String(t.index)] || {}).value }));
const stitch = await import("./editor/stitch.js");
const info = stitch.prepareCrop(ed, host.nodeParams, host.cropLimits()).info;
const params = host.providerParams(ed);
const mark = await logMark();
const before = ed.layers.length;
const out = await run("generate", { doc: window.__arkDoc, timeout: 120 });
if (ed.layers.length !== before + 1) throw new Error("no result layer: " + ed.status);
const log = (await logSince(mark)).filter((e) => e.source === "ark");
return { emitted: info.emitted, bbox: info.bbox, input: r.input, limits: r.limits, status: ed.status, params, targets, log, layer: out && out.layer ? [out.layer.width, out.layer.height] : null };
"""

REGION_BACK = """
const ed = ednow(window.__arkDoc);
await run("set_settings", { doc: window.__arkDoc, values: { Region: "ap-southeast" } });
return { region: host.providerParams(ed).region };
"""

GENERATE_NEW = """
const ed = ednow(window.__arkDoc);
host.shell.activate(ed);
await run("select_recipe", { id: "seedream_5_lite", provider: "ark" });
const t = host.recipe.text;
if (!t || t.model !== __MODEL__) throw new Error("the ModelArk variant's text shape: " + JSON.stringify(t));
const mark = await logMark();
const out = await run("generate_new", { doc: window.__arkDoc, prompt: __TEXT__, aspect: "16:9", resolution: __LONG__, timeout: 120 });
const log = (await logSince(mark)).filter((e) => e.source === "ark");
return { size: [ed.width, ed.height], model: out.model, status: ed.status, sizes: t.sizes, log };
"""

# a synthetic variant of the shipped Seedream 5.0 Lite one, resolved like a recipe
SYNTHETIC = """
const ed = await fresh();
const raw = host.shell.recipes().find((x) => x.id === "seedream_5_lite");
const v = { ...raw.providers.ark, model: __MODEL__ };
const r = host.shell.resolveRecipe({ ...raw, id: "ark_" + __MODEL__ + "_test", default: "ark", providers: { ...raw.providers, ark: v } });
if (r.provider !== "ark" || r.model !== __MODEL__) throw new Error("resolved to " + r.provider + " / " + r.model);
host.setRecipe(r);
const mark = await logMark();
const before = ed.layers.length;
const t0 = Date.now();
let msg = "";
try { await run("generate", { doc: window.__arkDoc, timeout: 120 }); } catch (err) { msg = String(err.message || err); }
const seconds = (Date.now() - t0) / 1000;
const all = await logSince(mark);
return { error: msg, status: ed.status, layers: ed.layers.length - before, seconds, log: all.filter((e) => e.source === "ark"), logText: JSON.stringify(all) };
"""

REAL_KEY_REFUSED = """
const ed = await fresh();
await window.scumble.keys.set("ark", __REALKEY__);
window.__ark.realKey = true;
const out = {};
try {
    await run("select_recipe", { id: "seedream_5_lite", provider: "ark" });
    const before = ed.layers.length;
    try { await run("generate", { doc: window.__arkDoc, timeout: 60 }); out.generate = "no error"; } catch (err) { out.generate = String(err.message || err); }
    out.status = ed.status;
    out.layers = ed.layers.length - before;
    const size = [ed.width, ed.height];
    try { await run("generate_new", { doc: window.__arkDoc, prompt: __TEXT__, aspect: "16:9", resolution: 2560, timeout: 60 }); out.generateNew = "no error"; } catch (err) { out.generateNew = String(err.message || err); }
    out.baseKept = ed.width === size[0] && ed.height === size[1];
} finally {
    // back to no key: the later steps need none
    await window.scumble.keys.clear("ark");
    window.__ark.realKey = false;
    window.__ark.stored = false;
}
const k = await window.scumble.keys.list();
out.cleared = !((k.keys || {}).ark && k.keys.ark.set);
return out;
"""

CLEANUP = """
const out = {};
const t = window.__ark;
if (t && (t.stored || t.realKey)) { await window.scumble.keys.clear("ark"); out.keyCleared = true; }
for (const d of document.querySelectorAll("dialog[open]")) d.close();
if (t) {
    const s = t.saved;
    await window.scumble.settings.set({ ark: s.ark, recipeProviders: s.recipeProviders, recipe: s.recipe, recipeByMode: s.recipeByMode });
    // the shell keeps its own copy of the settings (the remembered providers among them): openSettings re-reads it
    await shell.openSettings();
    document.getElementById("shell-settings").close();
    if (t.recipe && t.recipe.id === s.recipe) host.shell.selectRecipe(t.recipe.id);
    else if (t.recipe) host.setRecipe(t.recipe);
}
if (window.__arkDoc) { try { await run("close_document", { doc: window.__arkDoc, force: true }); } catch (_) { /* gone */ } }
const k = await window.scumble.keys.list();
out.keyLeft = !!((k.keys || {}).ark && k.keys.ark.set);
if (t) {
    if (out.keyLeft) throw new Error("the test key is still stored");
    const now = await window.scumble.settings.get();
    const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
    out.restored = same(now.ark, t.saved.ark) && same(now.recipeProviders, t.saved.recipeProviders) && same(now.recipe, t.saved.recipe) && same(now.recipeByMode, t.saved.recipeByMode);
    if (!out.restored) throw new Error("the settings are not back: " + JSON.stringify({ ark: now.ark, recipeProviders: now.recipeProviders, recipe: now.recipe }));
    out.recipe = host.recipe && host.recipe.id;
}
window.__ark = null; window.__arkDoc = null;
return out;
"""


def node_step():
    """tools/ark_test.js in plain Node; None when the file does not exist."""
    if not os.path.exists(NODE_TEST):
        return None
    r = subprocess.run(["node", NODE_TEST], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=120)
    tail = (r.stdout + r.stderr).strip()
    if r.returncode != 0 or not tail.endswith("PASS"):
        lines = tail.splitlines()
        failed = [ln for ln in lines if ln.startswith("[FAIL]")]
        counted = [ln for ln in lines if " checks passed" in ln]
        shown = "\n    ".join([ln[:400] for ln in failed] + counted[-1:]) if failed else tail[-1500:]
        raise Exception("tools/ark_test.js (rc %d):\n    %s" % (r.returncode, shown))
    return {"checks": tail.count("[ok]")}


def image_posts(snap):
    return [cl for cl in snap["calls"] if cl["method"] == "POST" and cl["path"].split("?")[0] == PATH]


def size_of(value):
    m = re.match(r"^(\d+)x(\d+)$", str(value or ""))
    return (int(m.group(1)), int(m.group(2))) if m else None


def log_detail(entry):
    """The detail of a log entry as an object (the log keeps it as JSON text), or {}."""
    d = entry.get("detail")
    if isinstance(d, dict):
        return d
    try:
        return json.loads(d) if d else {}
    except ValueError:
        return {}


def ok_entry(res, kind):
    """The adapter's success line in the log of this run, and its info object."""
    ok = [e for e in res.get("log") or [] if e.get("level") == "info" and ("%s ok" % kind) in str(e.get("message"))]
    if len(ok) != 1:
        raise Exception("expected one ark '%s ok' line in the log, found %s" % (kind, [e.get("message") for e in res.get("log") or []]))
    return ok[0], (log_detail(ok[0]).get("info") or {})


def check_key_absent(texts, what):
    for t in texts:
        if KEY in str(t) or REAL_KEY in str(t):
            raise Exception("a key is in %s" % what)


def check_edit(mock, res, model, pixels, region):
    """One POST with the crop as image[0] and the request shape of ark.js; the log line names the region."""
    snap = mock.snapshot()
    posts = image_posts(snap)
    if len(posts) != 1 or len(snap["images"]) != 1 or len(snap["calls"]) != 1:
        raise Exception("expected one POST %s, the mock saw %s" % (PATH, [(c["method"], c["path"]) for c in snap["calls"]]))
    b = snap["images"][0]["body"]
    refs = snap["images"][0]["refs"]
    ew, eh = res["emitted"]
    if b.get("model") != model:
        raise Exception("model %s, wanted %s" % (b.get("model"), model))
    if b.get("image_type") != "list" or not refs:
        raise Exception("image is a %s of %d pictures" % (b.get("image_type"), len(refs)))
    if any(r["mime"] != "image/png" for r in refs) or refs[0]["dims"] != [ew, eh]:
        raise Exception("the pictures %s, the emitted crop %dx%d" % (refs, ew, eh))
    size = size_of(b.get("size"))
    if not size:
        raise Exception("size %r is not WxH" % b.get("size"))
    w, h = size
    if not (pixels[0] <= w * h <= pixels[1]):
        raise Exception("size %s has %d pixels, outside %s" % (b["size"], w * h, pixels))
    if w % 16 or h % 16:
        raise Exception("size %s is not in 16 px steps" % b["size"])
    if abs((w / h) / (ew / eh) - 1) > 0.02:
        raise Exception("size %s is not the crop's shape (%dx%d)" % (b["size"], ew, eh))
    if b.get("watermark") is not False or b.get("response_format") != "b64_json" or b.get("output_format") != "png":
        raise Exception("watermark / response_format / output_format: %s" % json.dumps({k: b.get(k) for k in ("watermark", "response_format", "output_format")}))
    extra = sorted(set(b) - BODY_KEYS - {"image_type"})
    if extra:
        raise Exception("fields ark.js does not send (a mask among them?): %s" % extra)
    prompt = str(b.get("prompt") or "")
    if not prompt.startswith(EDIT_PREFIX) or PROMPT not in prompt:
        raise Exception("the prompt: %s" % prompt[:200])
    if len(refs) > 1 and "reference material" not in prompt:
        raise Exception("%d pictures, but the prompt does not say what the others are" % len(refs))
    if posts[0]["auth"] != "Bearer " + KEY:
        raise Exception("the request's Authorization: %r" % posts[0]["auth"])
    if not str(posts[0]["headers"].get("content-type") or "").startswith("application/json"):
        raise Exception("Content-Type %r" % posts[0]["headers"].get("content-type"))
    entry, info = ok_entry(res, "edit")
    if info.get("region") != region or info.get("size") != b["size"] or info.get("model") != model:
        raise Exception("the log line's info: %s (wanted region %s, size %s)" % (info, region, b["size"]))
    check_key_absent([json.dumps(res["log"]), res["status"]], "the log or the status line")
    return {"crop": [ew, eh], "size": b["size"], "same_as_crop": [w, h] == [ew, eh], "pictures": len(refs), "region": info.get("region"),
            "params": res["params"], "log": entry.get("message"), "status": res["status"][:120]}


def check_text(mock, res, want_size):
    snap = mock.snapshot()
    posts = image_posts(snap)
    if len(posts) != 1 or len(snap["calls"]) != 1:
        raise Exception("expected one POST %s, the mock saw %s" % (PATH, [(c["method"], c["path"]) for c in snap["calls"]]))
    b = snap["images"][0]["body"]
    if "image" in b or snap["images"][0]["refs"]:
        raise Exception("a text request carried pictures")
    if b.get("model") != LITE or b.get("size") != want_size or b.get("prompt") != TEXT_PROMPT:
        raise Exception("the text request: %s" % json.dumps(b))
    if b.get("watermark") is not False or b.get("response_format") != "b64_json" or b.get("output_format") != "png":
        raise Exception("watermark / response_format / output_format: %s" % json.dumps(b))
    extra = sorted(set(b) - BODY_KEYS)
    if extra:
        raise Exception("fields ark.js does not send: %s" % extra)
    if posts[0]["auth"] != "Bearer " + KEY:
        raise Exception("Authorization %r" % posts[0]["auth"])
    w, h = size_of(want_size)
    if res["size"] != [w, h]:
        raise Exception("the new base is %s, the mock answered %s" % (res["size"], want_size))
    entry, info = ok_entry(res, "generate")
    if info.get("size") != want_size:
        raise Exception("the log line's info: %s" % info)
    return {"body": {k: v for k, v in b.items() if k != "prompt"}, "size": res["size"], "log": entry.get("message")}


async def run_all(c):
    mock = Mock().start()
    print("mock ModelArk on", mock.url)
    ok = True

    async def js(name, body, **subs):
        for k, v in subs.items():
            body = body.replace(k, v)
        res = await c.eval(PRE % body, timeout=240)
        print("[ok] %s: %s" % (name, json.dumps(res, ensure_ascii=False)[:500]))
        return res

    async def ev(body, **subs):
        for k, v in subs.items():
            body = body.replace(k, v)
        return await c.eval(PRE % body, timeout=240)

    def done(name, res):
        print("[ok] %s: %s" % (name, json.dumps(res, ensure_ascii=False)[:700]))

    async def step(name, fn):
        """One step; a failure is printed and the next step runs."""
        nonlocal ok
        try:
            await fn()
            return True
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] %s: %s" % (name, err))
            return False

    try:
        # 1. the adapter in plain Node
        async def adapter():
            res = node_step()
            if res is None:
                print("[skip] adapter_in_plain_node: tools/ark_test.js does not exist")
            else:
                done("adapter_in_plain_node", res)
        await step("adapter_in_plain_node", adapter)

        await c.eval("(async () => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); window.__arkCmds = await import('./commands.js'); window.__arkHost = (await import('./editor/host.js')).host; window.__arkShell = await import('./shell.js'); return 1; })()")

        # the setup, the lists and the key are what every later step stands on: stop at their first failure
        async def setup():
            await js("setup", SETUP, __MOCK__=json.dumps(mock.url), __PROMPT__=json.dumps(PROMPT))
        if not await step("setup", setup):
            raise Stop()

        async def lists():
            await js("the_lists_before_the_key", LISTS_BEFORE_THE_KEY, __LABEL__=json.dumps(LABEL), __KEYURL__=json.dumps(KEY_URL))
        if not await step("the_lists_before_the_key", lists):
            raise Stop()

        async def stored():
            await js("the_key_is_stored", KEY_STORED, __KEY__=json.dumps(KEY), __LABEL__=json.dumps(LABEL))
        if not await step("the_key_is_stored", stored):
            raise Stop()

        # 2. edits and Generate new
        async def lite():
            mock.reset()
            res = await ev(EDIT, __ID__=json.dumps("seedream_5_lite"), __MODEL__=json.dumps(LITE), __REGION__="null")
            if res["input"] != "edit":
                raise Exception("the Seedream 5.0 Lite variant's input is %s" % res["input"])
            region = [t for t in res["targets"] if t["key"] == "region"]
            if len(region) != 1 or region[0]["label"] != "Region" or region[0]["choices"] != ["ap-southeast", "eu-west"] or region[0]["value"] != "ap-southeast":
                raise Exception("the Region row: %s" % res["targets"])
            ew, eh = res["emitted"]
            if ew * eh < LITE_PIXELS[0]:
                raise Exception("the crop went out at %dx%d, under the model's %d pixels" % (ew, eh, LITE_PIXELS[0]))
            done("edit_on_seedream_5_lite", check_edit(mock, res, LITE, LITE_PIXELS, "ap-southeast"))
        await step("edit_on_seedream_5_lite", lite)

        async def region():
            mock.reset()
            try:
                res = await ev(EDIT, __ID__=json.dumps("seedream_5_lite"), __MODEL__=json.dumps(LITE), __REGION__=json.dumps("eu-west"))
            finally:
                back = await ev(REGION_BACK)
            if res["params"].get("region") != "eu-west":
                raise Exception("the request's params after set_settings: %s" % res["params"])
            out = check_edit(mock, res, LITE, LITE_PIXELS, "eu-west")
            if back.get("region") != "ap-southeast":
                raise Exception("the Region row did not go back: %s" % back)
            done("the_region_row_is_honoured", {"region": out["region"], "size": out["size"], "log": out["log"], "request_to": mock.url})
        await step("the_region_row_is_honoured", region)

        async def pro():
            mock.reset()
            res = await ev(EDIT, __ID__=json.dumps("seedream_5_pro"), __MODEL__=json.dumps(PRO), __REGION__="null")
            if res["input"] != "edit" or res["targets"]:
                raise Exception("the Seedream 5.0 Pro variant: input %s, settings %s" % (res["input"], res["targets"]))
            done("edit_on_seedream_5_pro", check_edit(mock, res, PRO, PRO_PIXELS, "ap-southeast"))
        await step("edit_on_seedream_5_pro", pro)

        async def text():
            mock.reset()
            res = await ev(GENERATE_NEW, __MODEL__=json.dumps(LITE), __TEXT__=json.dumps(TEXT_PROMPT), __LONG__="2560")
            done("generate_new_on_ark", {**check_text(mock, res, "2560x1440"), "sizes": res["sizes"]})
        await step("generate_new_on_ark", text)

        # 3. failures
        async def quota():
            mock.reset()
            res = await ev(SYNTHETIC, __MODEL__=json.dumps("mock-quota"))
            if "free quota" not in res["error"] or "exhausted its free trial quota" not in res["error"] or "free quota" not in res["status"]:
                raise Exception("the QuotaExceeded does not reach the error and the status line: %s" % json.dumps({k: res[k] for k in ("error", "status")})[:600])
            errs = [e for e in res["log"] if e.get("level") == "error" and "mock-quota" in str(e.get("message")) and "free quota" in str(e.get("message"))]
            if not errs:
                raise Exception("the log has no ModelArk error for mock-quota: %s" % res["logText"][-600:])
            check_key_absent([res["logText"], res["error"], res["status"]], "the log, the error or the status line")
            calls = mock.snapshot()["calls"]
            if len(calls) != 1 or res["layers"] != 0:
                raise Exception("a QuotaExceeded is not sent again: the mock saw %s, %d layers were added" % ([(cl["method"], cl["path"]) for cl in calls], res["layers"]))
            done("a_quota_error_reaches_the_status_line", {"status": res["status"][:220], "log": errs[-1]["message"][:220], "requests": len(calls)})
        await step("a_quota_error_reaches_the_status_line", quota)

        async def ipm():
            mock.reset()
            res = await ev(SYNTHETIC, __MODEL__=json.dumps("mock-ipm"))
            posts = image_posts(mock.snapshot())
            if res["error"] or res["layers"] != 1:
                raise Exception("no result layer after the second request: %s" % json.dumps({k: res[k] for k in ("error", "status", "layers")})[:500])
            if len(posts) != 2 or any((cl.get("json") or {}).get("model") != "mock-ipm" for cl in posts):
                raise Exception("a ModelAccountIpmRateLimitExceeded should be sent once more: %d requests" % len(posts))
            if res["seconds"] < 1:
                raise Exception("the second request did not wait for Retry-After: 1 (%.2f s)" % res["seconds"])
            entry, _info = ok_entry(res, "edit")
            done("a_rate_limit_is_sent_again", {"requests": len(posts), "seconds": round(res["seconds"], 2), "log": entry.get("message")})
        await step("a_rate_limit_is_sent_again", ipm)

        async def notopen():
            mock.reset()
            res = await ev(SYNTHETIC, __MODEL__=json.dumps("mock-notopen"))
            calls = mock.snapshot()["calls"]
            if "not activated" not in res["error"] or "ModelNotOpen" not in res["error"] or "not activated" not in res["status"] or len(calls) != 1 or res["layers"] != 0:
                raise Exception("a ModelNotOpen: %s, %d requests" % (json.dumps({k: res[k] for k in ("error", "status", "layers")})[:500], len(calls)))
            check_key_absent([res["logText"], res["error"], res["status"]], "the log, the error or the status line")
            done("a_model_not_activated_says_so", {"error": res["error"][:220], "requests": len(calls)})
        await step("a_model_not_activated_says_so", notopen)

        async def real_key():
            mock.reset()
            res = await ev(REAL_KEY_REFUSED, __REALKEY__=json.dumps(REAL_KEY), __TEXT__=json.dumps(TEXT_PROMPT))
            calls = mock.snapshot()["calls"]
            where = {k: res.get(k, "") for k in ("generate", "status", "generateNew")}
            refused = [k for k in ("generate", "generateNew") if "test address" not in where[k]]
            if refused or res.get("layers") or not res.get("baseKept"):
                raise Exception("not refused with the test-address message: %s" % json.dumps({**where, "layers": res.get("layers"), "baseKept": res.get("baseKept")})[:700])
            if calls:
                raise Exception("the mock saw %s with a real-looking key" % [(cl["method"], cl["path"]) for cl in calls])
            check_key_absent(where.values(), "a message")
            if not res.get("cleared"):
                raise Exception("the second key was not cleared")
            done("a_real_key_never_goes_to_the_test_base", {"generate": where["generate"][:200], "requests": 0})
        await step("a_real_key_never_goes_to_the_test_base", real_key)
    except Stop:
        pass
    except Exception as err:  # noqa: BLE001
        ok = False
        print("[FAIL]", err)
    finally:
        try:
            res = await c.eval(PRE % CLEANUP, timeout=60)
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
