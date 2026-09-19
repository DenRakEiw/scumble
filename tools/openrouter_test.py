"""OpenRouter end to end without a key: the adapter in plain Node, then the app against tools/openrouter_mock.py.

No ComfyUI and no OpenRouter account. The first step runs tools/openrouter_test.js (the adapter against a scripted
fetch) when that file exists, and is skipped, not failed, when it does not. The rest drives the running app over CDP
with settings.openrouter.base pointed at the mock on 127.0.0.1 (the only base besides https://openrouter.ai that the
adapter accepts) and a test key stored under the name "openrouter". The key starts with "test-": the adapter sends
such a key only to a loopback base, and any other key never to one.

- ToAPIs stays first in Settings › API providers, OpenRouter has its row with "get a key" and a balance query, every
  recipe with an OpenRouter variant lists it last and keeps its home provider as the default, and no OpenRouter
  upsampling row shows without the key;
- the key row's "check balance" answers from GET /api/v1/key: the key's own limit, and "no spending limit" for a key
  without one;
- the shipped Nano Banana 2 variant inpaints: one POST /api/v1/images with the crop as the first picture (a PNG of
  the emitted size), the mask as the second (white in the selection), a resolution tier, no aspect_ratio, the hosts in
  China in provider.ignore, the key as a Bearer, and no attribution header on any request of the whole test;
- an "edit" variant (FLUX.2 [pro]) sends no mask, output_format png and a seed;
- Generate new asks for 16:9 without a picture and gets a 16:9 base;
- the four OpenRouter upsampling rows appear with the key, after the ToAPIs rows, and one of them upsamples with the
  image, its reasoning switch and the routing object that denies data collection and leaves out the hosts in China;
- a 402 puts "credits too low" and the server's words in the status line and the log, never the key, and is not sent
  again; a 429 is sent once more after Retry-After; a 502 says nothing was charged;
- a real-looking key is never sent to the test address (edit, balance and upsampling refuse, the mock sees nothing).

A profile that already holds an OpenRouter key is refused, never overwritten; the test key, settings.openrouter, the
remembered providers and the selected recipe are put back at the end whatever happens.

    python tools/openrouter_test.py

Start the app first (with --no-comfy: a result is uploaded into the mirror and would be forwarded to a connected
ComfyUI): bash tools/run_gates.sh <label> --offline --tiles on openrouter
"""
import asyncio
import glob
import io
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402
from openrouter_mock import CHAT_MODELS, CN_SLUGS, NOT_CN_SLUGS, Mock  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE_TEST = os.path.join(ROOT, "tools", "openrouter_test.js")
KEY = "test-openrouter-gate-0123456789"
REAL_KEY = "sk-or-v1-" + "0" * 64
KEY_URL = "https://openrouter.ai/settings/keys"
DATED_CN = ["alibaba", "baidu", "deepseek", "nex-agi", "streamlake", "tencent", "xiaomi"]   # openrouter.js CHINA_HOSTS
ATTRIBUTION = ("http-referer", "referer", "x-title")                                      # and every x-openrouter-*
UPSAMPLE_ROW = "app:openrouter:google/gemini-3.8-flash"
PROMPT = "a red car in the rain"


def recipes_with_openrouter():
    """{ id: { default, providers: [...], variant } } for every shipped recipe with an openrouter variant."""
    out = {}
    for f in sorted(glob.glob(os.path.join(ROOT, "recipes", "*.json"))):
        with open(f, encoding="utf-8") as fh:
            r = json.load(fh)
        p = r.get("providers") or {}
        if "openrouter" in p:
            out[r["id"]] = {"default": r.get("default"), "providers": list(p), "variant": p["openrouter"]}
    return out


RECIPES = recipes_with_openrouter()


class Stop(Exception):
    """A step the rest stands on failed (its line is printed already)."""


PRE = """(async () => {
    const commands = window.__orCmds.commands, host = window.__orHost, shell = window.__orShell;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (f, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await wait(100); } return null; };
    const orRow = () => Array.from(document.querySelectorAll(".shell-provider")).find((r) => /^OpenRouter/.test(r.textContent));
    %s
})()"""

SETUP = """
window.__or = null;
window.__orDoc = null;
const had = await window.scumble.keys.list();
if ((had.keys || {}).openrouter && had.keys.openrouter.set) throw new Error("this profile holds an OpenRouter key; the test never overwrites a key");
const s = await window.scumble.settings.get();
window.__or = { saved: { openrouter: s.openrouter, recipeProviders: s.recipeProviders || {}, recipe: s.recipe, recipeByMode: s.recipeByMode }, recipe: host.recipe, stored: false, realKey: false };
await window.scumble.settings.set({ openrouter: { base: __MOCK__ } });
const d = await run("new_document");
window.__orDoc = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { doc: d.id, width: 1200, height: 800, color: "#708090" });
await run("select_rect", { doc: d.id, x: 400, y: 250, width: 420, height: 280 });
return { size: [ed.width, ed.height], remembered: Object.keys(s.recipeProviders || {}), recipe: host.recipe && host.recipe.id };
"""

LISTS_BEFORE_THE_KEY = """
const list = await window.scumble.providers.list();
if (!list[0] || list[0].id !== "toapis") throw new Error("Settings › API providers does not start with ToAPIs: " + list.map((p) => p.id).join(", "));
const row = list.find((p) => p.id === "openrouter");
if (!row || row.label !== "OpenRouter" || row.keyUrl !== __KEYURL__ || row.balance !== true) throw new Error("the OpenRouter provider row: " + JSON.stringify(row));
if (row.key && row.key.set) throw new Error("the OpenRouter key is set before the test stored one");
const remembered = (await window.scumble.settings.get()).recipeProviders || {};
const rl = await run("list_recipes");
const files = __RECIPES__;
const served = [];
for (const r of rl.recipes) {
    if (!(r.providers || []).includes("openrouter")) continue;
    if (r.providers[r.providers.length - 1] !== "openrouter") throw new Error(r.id + ": openrouter is not the last provider: " + r.providers.join(", "));
    const f = files[r.id];
    if (!f) throw new Error(r.id + " lists openrouter but no shipped recipe file has that variant");
    if (!remembered[r.id] && r.provider !== f.default) throw new Error(r.id + ": the default moved to " + r.provider + " (the file says " + f.default + ")");
    if (f.default === "openrouter") throw new Error(r.id + ": the file makes openrouter the default");
    served.push(r.id);
}
const missing = Object.keys(files).filter((id) => !served.includes(id));
if (missing.length) throw new Error("recipes with an openrouter variant that list_recipes does not offer on it: " + missing.join(", "));
// the Settings dialog: the key row and each served recipe's provider select
await shell.openSettings();
await wait(300);
const keyRow = orRow();
const rowText = keyRow ? keyRow.textContent : "";
if (!/get a key/.test(rowText) || /check balance/.test(rowText) || !/no key/.test(rowText)) throw new Error("the OpenRouter key row without a key: " + rowText);
const options = {};
for (const id of served) {
    const sel = document.querySelector('.shell-recipe[data-id="' + id + '"] select');
    if (!sel) throw new Error("no provider select for " + id);
    const last = sel.options[sel.options.length - 1];
    options[id] = last.textContent;
    if (last.value !== "openrouter" || last.textContent !== "OpenRouter (no key)") throw new Error(id + ": the last option is " + last.value + " / " + last.textContent);
}
document.getElementById("shell-settings").close();
// no upsampling row without the key, and in the whole list the four rows come after ToAPIs'
await host.refreshLLMs();
const ups = host.upsampleBackends().map((b) => b.id);
if (ups.some((id) => id.startsWith("app:openrouter:"))) throw new Error("OpenRouter upsampling rows without a key: " + ups.join(", "));
const all = (await window.scumble.llm.list()).map((l) => l.id);
const orIds = all.filter((id) => id.startsWith("openrouter:"));
if (JSON.stringify(orIds) !== JSON.stringify(__CHAT__.map((m) => "openrouter:" + m))) throw new Error("the OpenRouter rows of llm.list(): " + orIds.join(", "));
const lastToapis = all.reduce((n, id, i) => (id.startsWith("toapis:") ? i : n), -1);
if (all.indexOf(orIds[0]) < lastToapis) throw new Error("an OpenRouter row comes before a ToAPIs row: " + all.join(", "));
return { providers: list.map((p) => p.id), keyRow: rowText.slice(0, 80), served: served.length, option: options.nano_banana_2, llmRows: orIds.length };
"""

KEY_AND_BALANCE = """
await window.scumble.keys.set("openrouter", __KEY__);
window.__or.stored = true;
await shell.openSettings();
await wait(300);
const row = orRow();
const link = row && Array.from(row.querySelectorAll("a")).find((a) => a.textContent === "check balance");
if (!link) throw new Error("no check balance link on the OpenRouter row with a key: " + (row && row.textContent));
link.click();
const text = await until(() => { const o = row.querySelector(".shell-balance-out"); return o && !/checking/.test(o.textContent) && o.textContent.trim() ? o.textContent : null; }, 15000);
const sel = document.querySelector('.shell-recipe[data-id="nano_banana_2"] select');
const option = sel && sel.options[sel.options.length - 1].textContent;
document.getElementById("shell-settings").close();
if (!text || !text.includes("$12.50 left") || !text.includes("$20.00")) throw new Error("the balance reads " + text);
if (option !== "OpenRouter") throw new Error("with a key the option still reads " + option);
return { balance: text.trim(), option };
"""

BALANCE_UNLIMITED = """
await shell.openSettings();
await wait(300);
const row = orRow();
const link = row && Array.from(row.querySelectorAll("a")).find((a) => a.textContent === "check balance");
if (!link) throw new Error("no check balance link: " + (row && row.textContent));
link.click();
const text = await until(() => { const o = row.querySelector(".shell-balance-out"); return o && !/checking/.test(o.textContent) && o.textContent.trim() ? o.textContent : null; }, 15000);
document.getElementById("shell-settings").close();
if (!text || !text.includes("no spending limit on this key")) throw new Error("a key without a limit reads " + text);
return { balance: text.trim() };
"""

# select_recipe through the commands core, then a Generate on the document's selection; the size the crop is
# emitted at is computed beforehand by the same function the run uses
EDIT = """
const ed = ednow(window.__orDoc);
host.shell.activate(ed);
const sel = await run("select_recipe", { id: __ID__, provider: "openrouter" });
const r = host.recipe;
if (!r || r.id !== __ID__ || r.provider !== "openrouter" || r.model !== __MODEL__) throw new Error("select_recipe gave " + JSON.stringify(sel) + " / " + (r && [r.id, r.provider, r.model].join(" ")));
await run("select_rect", { doc: window.__orDoc, x: 400, y: 250, width: 420, height: 280 });
const stitch = await import("./editor/stitch.js");
const info = stitch.prepareCrop(ed, host.nodeParams, host.cropLimits()).info;
const before = ed.layers.length;
const out = await run("generate", { doc: window.__orDoc, timeout: 120 });
if (ed.layers.length !== before + 1) throw new Error("no result layer: " + ed.status);
return { emitted: info.emitted, bbox: info.bbox, input: r.input, status: ed.status, params: host.providerParams(ed), layer: out && out.layer ? [out.layer.width, out.layer.height] : null };
"""

GENERATE_NEW = """
const ed = ednow(window.__orDoc);
await run("select_recipe", { id: "nano_banana_2", provider: "openrouter" });
if (!host.recipe.text || !host.recipe.text.model) throw new Error("the OpenRouter variant has no text shape: " + JSON.stringify(host.recipe.text));
const out = await run("generate_new", { doc: window.__orDoc, prompt: "a lighthouse at dusk", aspect: "16:9", resolution: 1024, timeout: 120 });
const ratio = ed.width / ed.height;
if (Math.abs(ratio - 16 / 9) > 0.02) throw new Error("the new base is " + ed.width + " x " + ed.height);
return { size: [ed.width, ed.height], model: out.model, status: ed.status };
"""

UPSAMPLE = """
const ed = ednow(window.__orDoc);
await host.refreshLLMs();
const ids = host.upsampleBackends().map((b) => b.id);
const want = __CHAT__.map((m) => "app:openrouter:" + m);
const mine = ids.filter((id) => id.startsWith("app:openrouter:"));
if (JSON.stringify(mine) !== JSON.stringify(want)) throw new Error("the OpenRouter rows with the key: " + ids.join(", "));
const lastToapis = ids.reduce((n, id, i) => (id.startsWith("app:toapis:") ? i : n), -1);
if (ids.indexOf(want[0]) < lastToapis) throw new Error("an OpenRouter row comes before a ToAPIs row: " + ids.join(", "));
await run("set_prompt", { doc: window.__orDoc, text: __PROMPT__ });
ed.refreshSegmentBackends();
ed.upBackendSel.value = __ROW__;
if (ed.upBackendSel.value !== __ROW__) throw new Error("the editor's select has no such row: " + Array.from(ed.upBackendSel.options).map((o) => o.value).join(", "));
const r = await run("upsample_prompt", { doc: window.__orDoc });
return { rows: mine.length, toapisRows: ids.filter((id) => id.startsWith("app:toapis:")).length, prompt: r.prompt || ed.promptText, status: ed.status };
"""

# a synthetic variant of the shipped Nano Banana 2 one, resolved like a recipe; the canvas is fresh again
# (Generate new replaced the base) and the selection the one of the edit steps
SYNTHETIC = """
const ed = ednow(window.__orDoc);
host.shell.activate(ed);
if (ed.width !== 1200 || ed.height !== 800) await run("new_canvas", { doc: window.__orDoc, width: 1200, height: 800, color: "#708090" });
await run("select_rect", { doc: window.__orDoc, x: 400, y: 250, width: 420, height: 280 });
const raw = host.shell.recipes().find((x) => x.id === "nano_banana_2");
const v = { ...raw.providers.openrouter, model: __MODEL__ };
const r = host.shell.resolveRecipe({ ...raw, id: "openrouter_" + __MODEL__ + "_test", default: "openrouter", providers: { ...raw.providers, openrouter: v } });
if (r.provider !== "openrouter" || r.model !== __MODEL__) throw new Error("resolved to " + r.provider + " / " + r.model);
host.setRecipe(r);
const before = ed.layers.length;
const t0 = Date.now();
let msg = "";
try { await run("generate", { doc: window.__orDoc, timeout: 120 }); } catch (err) { msg = String(err.message || err); }
const seconds = (Date.now() - t0) / 1000;
const log = await run("read_log", { level: "error", limit: 50 });
const mine = log.entries.filter((e) => e.source === "openrouter" && String(e.message || "").includes(__MODEL__));
return { error: msg, status: ed.status, layers: ed.layers.length - before, seconds, log: mine.slice(-1), logText: JSON.stringify(log.entries) };
"""

REAL_KEY_REFUSED = """
const ed = ednow(window.__orDoc);
host.shell.activate(ed);
await window.scumble.keys.set("openrouter", __REALKEY__);
window.__or.realKey = true;
const out = {};
try {
    await run("select_recipe", { id: "nano_banana_2", provider: "openrouter" });
    if (ed.width !== 1200 || ed.height !== 800) await run("new_canvas", { doc: window.__orDoc, width: 1200, height: 800, color: "#708090" });
    await run("select_rect", { doc: window.__orDoc, x: 400, y: 250, width: 420, height: 280 });
    const before = ed.layers.length;
    try { await run("generate", { doc: window.__orDoc, timeout: 60 }); out.generate = "no error"; } catch (err) { out.generate = String(err.message || err); }
    out.status = ed.status;
    out.layers = ed.layers.length - before;
    try { await window.scumble.providers.balance("openrouter"); out.balance = "no error"; } catch (err) { out.balance = String(err.message || err); }
    await host.refreshLLMs();
    await run("set_prompt", { doc: window.__orDoc, text: __PROMPT__ });
    ed.refreshSegmentBackends();
    ed.upBackendSel.value = __ROW__;
    if (ed.upBackendSel.value !== __ROW__) throw new Error("the editor's select has no OpenRouter row with the second key");
    try { await run("upsample_prompt", { doc: window.__orDoc, timeout: 60 }); out.upsample = "no error"; } catch (err) { out.upsample = String(err.message || err); }
} finally {
    // back to no key: the test key is not stored again, the later steps need none
    await window.scumble.keys.clear("openrouter");
    window.__or.realKey = false;
    window.__or.stored = false;
}
const k = await window.scumble.keys.list();
out.cleared = !((k.keys || {}).openrouter && k.keys.openrouter.set);
return out;
"""

CLEANUP = """
const out = {};
const t = window.__or;
if (t && (t.stored || t.realKey)) { await window.scumble.keys.clear("openrouter"); out.keyCleared = true; }
for (const d of document.querySelectorAll("dialog[open]")) d.close();
if (t) {
    const s = t.saved;
    await window.scumble.settings.set({ openrouter: s.openrouter, recipeProviders: s.recipeProviders, recipe: s.recipe, recipeByMode: s.recipeByMode });
    // the shell keeps its own copy of the settings (the remembered providers among them): openSettings re-reads it
    await shell.openSettings();
    document.getElementById("shell-settings").close();
    if (t.recipe && t.recipe.id === s.recipe) host.shell.selectRecipe(t.recipe.id);
    else if (t.recipe) host.setRecipe(t.recipe);
    await host.refreshLLMs();
}
if (window.__orDoc) { try { await run("close_document", { doc: window.__orDoc, force: true }); } catch (_) { /* gone */ } }
const k = await window.scumble.keys.list();
out.keyLeft = !!((k.keys || {}).openrouter && k.keys.openrouter.set);
if (t) {
    if (out.keyLeft) throw new Error("the test key is still stored");
    out.rowsLeft = host.upsampleBackends().some((b) => b.id.startsWith("app:openrouter:"));
    if (out.rowsLeft) throw new Error("OpenRouter upsampling rows stay after the key was cleared");
    const now = await window.scumble.settings.get();
    const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
    out.restored = same(now.openrouter, t.saved.openrouter) && same(now.recipeProviders, t.saved.recipeProviders) && same(now.recipe, t.saved.recipe) && same(now.recipeByMode, t.saved.recipeByMode);
    if (!out.restored) throw new Error("the settings are not back: " + JSON.stringify({ openrouter: now.openrouter, recipeProviders: now.recipeProviders, recipe: now.recipe }));
    out.recipe = host.recipe && host.recipe.id;
}
window.__or = null; window.__orDoc = null;
return out;
"""


def node_step():
    """tools/openrouter_test.js in plain Node; None when the file does not exist."""
    if not os.path.exists(NODE_TEST):
        return None
    r = subprocess.run(["node", NODE_TEST], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=120)
    tail = (r.stdout + r.stderr).strip()
    if r.returncode != 0 or not tail.endswith("PASS"):
        lines = tail.splitlines()
        failed = [ln for ln in lines if ln.startswith("[FAIL]")]
        counted = [ln for ln in lines if " checks passed" in ln]
        shown = "\n    ".join([ln[:400] for ln in failed] + counted[-1:]) if failed else tail[-1500:]
        raise Exception("tools/openrouter_test.js (rc %d):\n    %s" % (r.returncode, shown))
    return {"checks": tail.count("[ok]")}


def png_image(data):
    from PIL import Image
    im = Image.open(io.BytesIO(data))
    im.load()
    return im


def attribution_headers(calls):
    """[(method, path, header)] for every attribution header on the given calls."""
    out = []
    for cl in calls:
        for name in (cl.get("headers") or {}):
            if name in ATTRIBUTION or name.startswith("x-openrouter"):
                out.append((cl["method"], cl["path"], name))
    return out


def tier_for(w, h, tiers):
    rows = sorted(((k, int(v)) for k, v in (tiers or {}).items() if int(v) > 0), key=lambda kv: kv[1])
    for k, v in rows:
        if v >= max(w, h):
            return k
    return rows[-1][0] if rows else None


def image_posts(snap):
    return [cl for cl in snap["calls"] if cl["method"] == "POST" and cl["path"].startswith("/api/v1/images")]


def check_routing(body, what):
    prov = body.get("provider") or {}
    ignore = prov.get("ignore") or []
    # the dated list of openrouter.js merged with the hosts the mock lists in China, and none of the others
    wrong = [s for s in DATED_CN + CN_SLUGS if s not in ignore] + [s for s in NOT_CN_SLUGS if s in ignore]
    if wrong:
        raise Exception("%s: provider.ignore %s (wrong for %s)" % (what, ignore, wrong))
    return ignore


def check_fill(mock, res):
    snap = mock.snapshot()
    posts = image_posts(snap)
    if len(posts) != 1 or len(snap["images"]) != 1:
        raise Exception("expected one POST /api/v1/images, the mock saw %d: %s" % (len(posts), [(c["method"], c["path"]) for c in snap["calls"]]))
    b = snap["images"][0]["body"]
    refs = snap["images"][0]["refs"]
    variant = RECIPES["nano_banana_2"]["variant"]
    ew, eh = res["emitted"]
    if b.get("model") != "google/gemini-3.1-flash-image":
        raise Exception("model %s" % b.get("model"))
    if len(refs) < 2 or any(r["mime"] != "image/png" for r in refs[:2]) or any(ref.get("type") != "image_url" for ref in b.get("input_references") or []):
        raise Exception("the pictures: %s / %s" % (refs, b.get("input_references")))
    if refs[0]["dims"] != [ew, eh]:
        raise Exception("the first picture is %s, the emitted crop %dx%d" % (refs[0]["dims"], ew, eh))
    mask = png_image(mock.ref_bytes(0, 1))
    if list(mask.size) != [ew, eh]:
        raise Exception("the mask is %s, the crop %dx%d" % (mask.size, ew, eh))
    lum = mask.convert("L")
    centre, corner = lum.getpixel((ew // 2, eh // 2)), lum.getpixel((1, 1))
    if centre < 250 or corner > 5:
        raise Exception("the mask is %d in the middle and %d in the corner: white has to mark the selection" % (centre, corner))
    want_tier = tier_for(ew, eh, variant["options"]["tiers"])
    if b.get("resolution") != want_tier:
        raise Exception("resolution %s for a crop of %dx%d, wanted %s" % (b.get("resolution"), ew, eh, want_tier))
    if "aspect_ratio" in b:
        raise Exception("an edit sent aspect_ratio %s" % b["aspect_ratio"])
    if b.get("n") != 1 or any(k in b for k in ("mask", "mask_url", "seed", "output_format")):
        raise Exception("the parameters: %s" % json.dumps({k: v for k, v in b.items() if k not in ("prompt", "input_references")}))
    if not str(b.get("prompt") or "").startswith("Edit the first image. The second image is a mask"):
        raise Exception("the prompt does not say what the second picture is: %s" % str(b.get("prompt"))[:160])
    ignore = check_routing(b, "the edit")
    if set((b.get("provider") or {}).keys()) != {"ignore"}:
        raise Exception("the Image API body's provider object: %s" % b.get("provider"))
    if posts[0]["auth"] != "Bearer " + KEY:
        raise Exception("the image request's Authorization: %r" % posts[0]["auth"])
    bad = attribution_headers(mock.all_calls())
    if bad:
        raise Exception("attribution headers went out: %s" % bad)
    return {"crop": [ew, eh], "pictures": len(refs), "mask": [centre, corner], "resolution": b.get("resolution"), "ignore": ignore, "calls": [(c["method"], c["path"]) for c in snap["calls"]]}


def check_edit(mock, res, fill_pictures):
    snap = mock.snapshot()
    posts = image_posts(snap)
    if len(posts) != 1:
        raise Exception("expected one POST /api/v1/images, the mock saw %d" % len(posts))
    b = snap["images"][0]["body"]
    refs = snap["images"][0]["refs"]
    if b.get("model") != "black-forest-labs/flux.2-pro":
        raise Exception("model %s" % b.get("model"))
    if len(refs) != fill_pictures - 1:
        raise Exception("the edit sent %d pictures, the fill %d: the mask should be the one missing" % (len(refs), fill_pictures))
    if refs[0]["dims"] != list(res["emitted"]):
        raise Exception("the first picture is %s, the emitted crop %s" % (refs[0]["dims"], res["emitted"]))
    if b.get("output_format") != "png" or not isinstance(b.get("seed"), int) or b.get("n") != 1:
        raise Exception("output_format / seed / n: %s" % json.dumps({k: v for k, v in b.items() if k not in ("prompt", "input_references")}))
    if any(k in b for k in ("aspect_ratio", "resolution", "mask", "mask_url")):
        raise Exception("fields the variant does not send: %s" % sorted(b))
    if not str(b.get("prompt") or "").startswith("Edit the first image and keep its size and framing."):
        raise Exception("the prompt: %s" % str(b.get("prompt"))[:160])
    check_routing(b, "the FLUX edit")
    if posts[0]["auth"] != "Bearer " + KEY:
        raise Exception("Authorization %r" % posts[0]["auth"])
    return {"pictures": len(refs), "body": {k: v for k, v in b.items() if k not in ("prompt", "input_references", "provider")}}


def check_text(mock, res):
    snap = mock.snapshot()
    posts = image_posts(snap)
    if len(posts) != 1:
        raise Exception("expected one POST /api/v1/images, the mock saw %d" % len(posts))
    b = snap["images"][0]["body"]
    if "input_references" in b or snap["images"][0]["refs"]:
        raise Exception("a text request carried pictures")
    if b.get("aspect_ratio") != "16:9" or b.get("resolution") != "1K" or b.get("model") != "google/gemini-3.1-flash-image":
        raise Exception("the text request: %s" % json.dumps({k: v for k, v in b.items() if k != "prompt"}))
    if b.get("prompt") != "a lighthouse at dusk":
        raise Exception("the text prompt: %r" % b.get("prompt"))
    check_routing(b, "the text request")
    if res["size"] != [1024, 576]:
        raise Exception("the new base is %s, the mock answered 1024 x 576" % res["size"])
    return {"body": {k: v for k, v in b.items() if k != "prompt"}}


def check_chat(mock, res):
    if "UPSAMPLED" not in res["prompt"] or "image: yes" not in res["prompt"]:
        raise Exception("the OpenRouter row did not reach the endpoint with the image: %s" % res["prompt"])
    snap = mock.snapshot()
    chats = [cl for cl in snap["calls"] if cl["path"] == "/api/v1/chat/completions"]
    if len(chats) != 1 or len(snap["chats"]) != 1:
        raise Exception("expected one chat request, the mock saw %s" % [(c["method"], c["path"]) for c in snap["calls"]])
    ch = snap["chats"][0]
    b = ch["body"]
    if ch["auth"] != "Bearer " + KEY or not ch["image"] or b.get("model") != "google/gemini-3.8-flash":
        raise Exception("the chat request: auth %r, image %s, model %s" % (ch["auth"], ch["image"], b.get("model")))
    if b.get("reasoning") != {"effort": "low", "exclude": True}:
        raise Exception("reasoning %s" % b.get("reasoning"))
    prov = b.get("provider") or {}
    if prov.get("data_collection") != "deny":
        raise Exception("provider %s" % prov)
    ignore = check_routing(b, "the chat request")
    if b.get("stream") is not False:
        raise Exception("stream %s" % b.get("stream"))
    return {"prompt": res["prompt"], "reasoning": b["reasoning"], "provider": {"data_collection": prov["data_collection"], "ignore": ignore}}


async def run_all(c):
    mock = Mock().start()
    print("mock OpenRouter on", mock.url)
    ok = True

    async def js(name, body, **subs):
        for k, v in subs.items():
            body = body.replace(k, v)
        res = await c.eval(PRE % body, timeout=240)
        print("[ok] %s: %s" % (name, json.dumps(res, ensure_ascii=False)[:500]))
        return res

    def done(name, res):
        print("[ok] %s: %s" % (name, json.dumps(res, ensure_ascii=False)[:600]))

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
                print("[skip] adapter_in_plain_node: tools/openrouter_test.js does not exist")
            else:
                done("adapter_in_plain_node", res)
        await step("adapter_in_plain_node", adapter)

        await c.eval("(async () => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); window.__orCmds = await import('./commands.js'); window.__orHost = (await import('./editor/host.js')).host; window.__orShell = await import('./shell.js'); return 1; })()")

        # the setup, the lists and the key are what every later step stands on: stop at their first failure
        async def setup():
            await js("setup", SETUP, __MOCK__=json.dumps(mock.url))
        if not await step("setup", setup):
            raise Stop()

        async def lists():
            await js("the_lists_before_the_key", LISTS_BEFORE_THE_KEY, __KEYURL__=json.dumps(KEY_URL), __RECIPES__=json.dumps({k: {"default": v["default"]} for k, v in RECIPES.items()}), __CHAT__=json.dumps(CHAT_MODELS))
        if not await step("the_lists_before_the_key", lists):
            raise Stop()

        async def balance():
            mock.reset()
            mock.unlimited = False
            r1 = await c.eval(PRE % KEY_AND_BALANCE.replace("__KEY__", json.dumps(KEY)), timeout=60)
            mock.unlimited = True
            try:
                r2 = await c.eval(PRE % BALANCE_UNLIMITED, timeout=60)
            finally:
                mock.unlimited = False
            keys = [cl for cl in mock.snapshot()["calls"] if cl["path"] == "/api/v1/key"]
            if len(keys) != 2 or any(cl["auth"] != "Bearer " + KEY for cl in keys):
                raise Exception("the key queries: %s" % [(cl["method"], cl["path"], cl["auth"]) for cl in keys])
            done("the_key_row_checks_the_balance", {"limited": r1["balance"], "unlimited": r2["balance"], "option": r1["option"]})
        if not await step("the_key_row_checks_the_balance", balance):
            raise Stop()

        # 2. an inpaint on the shipped Nano Banana 2 variant (input "fill": the mask as the second picture)
        fill = {}

        async def edit_fill():
            mock.reset()
            res = await c.eval(PRE % EDIT.replace("__ID__", json.dumps("nano_banana_2")).replace("__MODEL__", json.dumps("google/gemini-3.1-flash-image")), timeout=240)
            if res["input"] != "fill":
                raise Exception("the Nano Banana 2 variant's input is %s" % res["input"])
            out = check_fill(mock, res)
            fill["pictures"] = out["pictures"]
            done("edit_on_a_shipped_variant", {**out, "status": res["status"][:120]})
        await step("edit_on_a_shipped_variant", edit_fill)

        async def edit_plain():
            if "pictures" not in fill:
                raise Exception("needs the fill step's picture count")
            mock.reset()
            res = await c.eval(PRE % EDIT.replace("__ID__", json.dumps("flux2_pro")).replace("__MODEL__", json.dumps("black-forest-labs/flux.2-pro")), timeout=240)
            if res["input"] != "edit":
                raise Exception("the FLUX.2 [pro] variant's input is %s" % res["input"])
            done("an_edit_variant_sends_no_mask", check_edit(mock, res, fill["pictures"]))
        await step("an_edit_variant_sends_no_mask", edit_plain)

        async def text():
            mock.reset()
            res = await c.eval(PRE % GENERATE_NEW, timeout=240)
            done("generate_new_on_openrouter", {**check_text(mock, res), "size": res["size"]})
        await step("generate_new_on_openrouter", text)

        async def upsample():
            mock.reset()
            res = await c.eval(PRE % UPSAMPLE.replace("__CHAT__", json.dumps(CHAT_MODELS)).replace("__PROMPT__", json.dumps(PROMPT)).replace("__ROW__", json.dumps(UPSAMPLE_ROW)), timeout=240)
            done("upsample_on_the_openrouter_key", {**check_chat(mock, res), "rows": res["rows"], "toapisRows": res["toapisRows"]})
        await step("upsample_on_the_openrouter_key", upsample)

        # 3. failures
        async def e402():
            mock.reset()
            res = await c.eval(PRE % SYNTHETIC.replace("__MODEL__", json.dumps("mock-402")), timeout=240)
            words = ("credits too low", "Insufficient credits")
            if not all(w in res["error"] for w in words) or not all(w in res["status"] for w in words):
                raise Exception("the 402 does not reach the error and the status line: %s" % json.dumps({k: res[k] for k in ("error", "status")})[:600])
            if not res["log"] or "Insufficient credits" not in res["log"][-1]["message"]:
                raise Exception("the log has no OpenRouter error for mock-402: %s" % res["logText"][-600:])
            if KEY in res["logText"] or KEY in res["error"] or KEY in res["status"]:
                raise Exception("the key is in the log, the error or the status line")
            calls = mock.snapshot()["calls"]
            if len(calls) != 1 or res["layers"] != 0:
                raise Exception("a 402 is not sent again: the mock saw %s, %d layers were added" % ([(cl["method"], cl["path"]) for cl in calls], res["layers"]))
            done("a_402_reaches_the_status_line", {"status": res["status"][:200], "log": res["log"][-1]["message"][:200], "requests": len(calls)})
        await step("a_402_reaches_the_status_line", e402)

        async def e429():
            mock.reset()
            res = await c.eval(PRE % SYNTHETIC.replace("__MODEL__", json.dumps("mock-429")), timeout=240)
            posts = image_posts(mock.snapshot())
            if res["error"] or res["layers"] != 1:
                raise Exception("no result layer after the retry: %s" % json.dumps({k: res[k] for k in ("error", "status", "layers")})[:500])
            if len(posts) != 2 or any(cl["json"].get("model") != "mock-429" for cl in posts):
                raise Exception("a 429 should be sent once more: %d requests" % len(posts))
            if res["seconds"] < 1:
                raise Exception("the second request did not wait for Retry-After: 1 (%.2f s)" % res["seconds"])
            done("a_429_is_sent_again", {"requests": len(posts), "seconds": round(res["seconds"], 2)})
        await step("a_429_is_sent_again", e429)

        async def e502():
            mock.reset()
            res = await c.eval(PRE % SYNTHETIC.replace("__MODEL__", json.dumps("mock-502")), timeout=240)
            calls = mock.snapshot()["calls"]
            if "nothing was charged" not in res["error"] or "Provider returned error" not in res["error"] or len(calls) != 1 or res["layers"] != 0:
                raise Exception("a 502: %s, %d requests" % (json.dumps({k: res[k] for k in ("error", "status", "layers")})[:500], len(calls)))
            done("a_502_says_nothing_was_charged", {"error": res["error"][:200], "requests": len(calls)})
        await step("a_502_says_nothing_was_charged", e502)

        async def real_key():
            mock.reset()
            res = await c.eval(PRE % REAL_KEY_REFUSED.replace("__REALKEY__", json.dumps(REAL_KEY)).replace("__PROMPT__", json.dumps(PROMPT)).replace("__ROW__", json.dumps(UPSAMPLE_ROW)), timeout=240)
            calls = mock.snapshot()["calls"]
            where = {k: res.get(k, "") for k in ("generate", "status", "balance", "upsample")}
            refused = [k for k in ("generate", "balance", "upsample") if "test address" not in where[k]]
            if refused or res.get("layers"):
                raise Exception("not refused with the test-address message: %s" % json.dumps(where)[:700])
            if calls:
                raise Exception("the mock saw %s with a real-looking key" % [(cl["method"], cl["path"]) for cl in calls])
            if any(REAL_KEY in v for v in where.values()):
                raise Exception("the key is in a message")
            if not res.get("cleared"):
                raise Exception("the second key was not cleared")
            done("a_real_key_never_goes_to_the_test_base", {"generate": where["generate"][:160], "requests": 0})
        await step("a_real_key_never_goes_to_the_test_base", real_key)

        async def headers():
            bad = attribution_headers(mock.all_calls())
            if bad:
                raise Exception("attribution headers went out: %s" % bad)
            done("no_attribution_header_on_any_request", {"requests": len(mock.all_calls())})
        await step("no_attribution_header_on_any_request", headers)
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
