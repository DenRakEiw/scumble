"""Oxen.ai as a provider, end to end without a key: the adapter in plain Node, then the app against tools/oxen_mock.py.

No ComfyUI and no Oxen account. The first step runs tools/oxen_test.js (the adapter, its recipes, its upsampling rows and
its assistant entry against a scripted fetch and the models' request schemas). The rest drives the running app over CDP
with settings.oxen.base pointed at the mock on 127.0.0.1 (the only base besides https://hub.oxen.ai that the adapter
accepts) and a test key in the Oxen.ai row. The key starts with "test-": the adapter sends such a key only to a loopback
base, and any other key never to one.

- the lists: the Oxen.ai key row after ModelArk and before Magnific, with "get a key", no "check balance" and "no key";
  oxen in the twenty recipes it joined, last but for Magnific, the defaults kept; "Oxen.ai (no key)" on the provider
  selects until the key is stored; the three upsampling rows listed without a key and offered by none;
- an instruction edit (Seedream 5.0 Pro) sends the crop as a data URL to /api/ai/images/edit, the preset closest to the
  crop, no watermark and no mask, and a result layer lands;
- a mask run on GPT Image 2.5 Flare sends mask_url, an RGBA PNG of the crop's size, transparent at the selection's
  centre and opaque in the corner, aspect "auto", PNG and b64_json;
- Generate new on Nano Banana 2 (16:9 at 1024): /api/ai/images/generate, no picture field, 16:9 and 1K, the base the
  answer's 1024 x 576;
- an Oxen upsampling row reaches /api/ai/chat/completions (no /v1) with the picture and changes the prompt;
- a real-looking key is never sent to the test address (Generate and the upsampling row);
- across every call of the run the key went only in Authorization, only to /api/ai/, with no attribution header.

A profile that already holds an Oxen key is refused, never overwritten; the test key, settings.oxen, the remembered
providers and the selected recipe are put back at the end whatever happens.

    python tools/oxen_test.py

Start the app first (with --no-comfy: a result is uploaded into the mirror and would be forwarded to a connected
ComfyUI): bash tools/run_gates.sh <label> --offline --tiles on oxen
"""
import asyncio
import json
import math
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402
from oxen_mock import Mock  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE_TEST = os.path.join(ROOT, "tools", "oxen_test.js")
KEY = "test-oxen-gate-0123456789"
REAL_KEY = "oxn_0123456789abcdefghijklmnopqrstuvwxyz"   # 40 characters; the real format is not documented
RECIPES = ["flux2_flex", "flux2_klein", "flux2_pro", "gpt_image_2", "gpt_image_2_5_flare", "gpt_image_2_5_sunburst", "grok_imagine", "ideogram_4", "krea_2",
           "nano_banana_2", "nano_banana_2_lite", "nano_banana_pro", "qwen_image_2_1", "qwen_image_edit", "seedream_5_lite", "seedream_5_pro",
           "topaz_creative", "topaz_generative", "topaz_precision", "z_image_turbo"]
CHAT = ["gemini-3-8-flash", "gpt-5-6-luna", "gemma-4-31b-it"]
TOUCHED = ["seedream_5_pro", "gpt_image_2_5_flare", "nano_banana_2"]
PROMPT = "a red car in the rain"


class Stop(Exception):
    """A step the rest stands on failed (its line is printed already)."""


PRE = """(async () => {
    const commands = window.__oxCmds.commands, host = window.__oxHost, shell = window.__oxShell;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const oxRow = () => Array.from(document.querySelectorAll(".shell-provider")).find((r) => /^Oxen\\.ai/.test(r.textContent));
    const fresh = async () => {
        const ed = ednow(window.__oxDoc);
        host.shell.activate(ed);
        if (ed.width !== 1200 || ed.height !== 800) await run("new_canvas", { doc: window.__oxDoc, width: 1200, height: 800, color: "#708090" });
        await run("select_rect", { doc: window.__oxDoc, x: 400, y: 250, width: 420, height: 280 });
        await run("set_prompt", { doc: window.__oxDoc, text: __PROMPT__ });
        return ed;
    };
    const generate = async (ed) => {
        const before = new Set(ed.layers.map((l) => l.id));
        let err = "";
        try { await run("generate", { doc: window.__oxDoc, timeout: 120 }); } catch (e) { err = String(e.message || e); }
        return { err, layer: ed.layers.find((l) => !before.has(l.id)) || null };
    };
    %s
})()"""

SETUP = """
window.__ox = null;
window.__oxDoc = null;
const had = await window.scumble.keys.list();
if ((had.keys || {}).oxen && had.keys.oxen.set) throw new Error("this profile holds an Oxen.ai key; the test never overwrites a key");
const s = await window.scumble.settings.get();
window.__ox = { saved: { oxen: s.oxen, recipeProviders: s.recipeProviders || {}, recipe: s.recipe, recipeByMode: s.recipeByMode }, recipe: host.recipe, stored: false };
await window.scumble.settings.set({ oxen: { base: __MOCK__ } });
const d = await run("new_document");
window.__oxDoc = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { doc: d.id, width: 1200, height: 800, color: "#708090" });
await run("select_rect", { doc: d.id, x: 400, y: 250, width: 420, height: 280 });
return { size: [ed.width, ed.height], recipe: host.recipe && host.recipe.id };
"""

LISTS = """
const list = await window.scumble.providers.list();
const ids = list.map((p) => p.id);
const row = list.find((p) => p.id === "oxen");
if (!row || row.label !== "Oxen.ai" || row.balance !== false || row.sharesKey !== null || (row.key && row.key.set)) throw new Error("the Oxen.ai provider entry: " + JSON.stringify(row));
if (ids.indexOf("oxen") !== ids.indexOf("ark") + 1 || ids.indexOf("magnific") !== ids.indexOf("oxen") + 1) throw new Error("the order of the key rows: " + ids.join(", "));
const remembered = (await window.scumble.settings.get()).recipeProviders || {};
const rl = await run("list_recipes");
const on = rl.recipes.filter((r) => (r.providers || []).includes("oxen"));
if (JSON.stringify(on.map((r) => r.id).sort()) !== JSON.stringify(__RECIPES__)) throw new Error("recipes that list oxen: " + on.map((r) => r.id).join(", "));
for (const r of on) {
    const upTo = r.providers.filter((x) => x !== "magnific");
    if (upTo[upTo.length - 1] !== "oxen") throw new Error(r.id + ": oxen is not last before magnific: " + r.providers.join(", "));
    const raw = host.shell.recipes().find((x) => x.id === r.id);
    if (r.id === "qwen_image_2_1" ? raw.default !== "oxen" : raw.default === "oxen") throw new Error(r.id + ": the file's default is " + raw.default);
    if (!remembered[r.id] && r.provider !== raw.default) throw new Error(r.id + ": the default moved to " + r.provider);
}
await host.refreshLLMs();
const llms = (await window.scumble.llm.list()).filter((l) => l.provider === "oxen");
if (JSON.stringify(llms.map((l) => l.model)) !== JSON.stringify(__CHAT__) || llms.some((l) => l.key)) throw new Error("the Oxen rows of llm.list(): " + JSON.stringify(llms));
if (host.upsampleBackends().some((b) => b.id.startsWith("app:oxen:"))) throw new Error("an Oxen upsampling row is offered without a key");
await shell.openSettings();
await wait(300);
const options = {};
let keyRow = "";
try {
    keyRow = (oxRow() || {}).textContent || "";
    if (!/get a key/.test(keyRow) || /check balance/.test(keyRow) || !/no key/.test(keyRow)) throw new Error("the Oxen.ai key row without a key: " + keyRow);
    for (const id of ["seedream_5_pro", "nano_banana_2", "topaz_precision"]) {
        const sel = document.querySelector('.shell-recipe[data-id="' + id + '"] select');
        if (!sel) throw new Error("no provider select for " + id);
        const opts = Array.from(sel.options).filter((o) => o.value !== "magnific");
        const last = opts[opts.length - 1];
        options[id] = last.value + " / " + last.textContent;
        if (last.value !== "oxen" || last.textContent !== "Oxen.ai (no key)") throw new Error(id + ": the last option is " + options[id]);
    }
} finally {
    document.getElementById("shell-settings").close();
}
await window.scumble.keys.set("oxen", __KEY__);
window.__ox.stored = true;
await shell.openSettings();
await wait(300);
const sel = document.querySelector('.shell-recipe[data-id="nano_banana_2"] select');
const after = sel && sel.options[sel.options.length - 1].textContent;
const withKey = (oxRow() || {}).textContent || "";
document.getElementById("shell-settings").close();
if (after !== "Oxen.ai" || !/key set/.test(withKey)) throw new Error("with the key: the option " + after + ", the row " + withKey);
return { keyRow: keyRow.slice(0, 80), options, after, recipes: on.length };
"""

EDIT = """
const ed = await fresh();
await run("select_recipe", { id: "seedream_5_pro", provider: "oxen" });
const r = host.recipe;
if (!r || r.provider !== "oxen" || r.model !== "bytedance-seedream-5-pro") throw new Error("select_recipe gave " + (r && [r.id, r.provider, r.model].join(" ")));
const stitch = await import("./editor/stitch.js");
const info = stitch.prepareCrop(ed, host.nodeParams, host.cropLimits()).info;
const out = await generate(ed);
return { emitted: info.emitted, err: out.err, layer: out.layer && [out.layer.x, out.layer.y, out.layer.w, out.layer.h], status: ed.status };
"""

MASK = """
const ed = await fresh();
await run("select_recipe", { id: "gpt_image_2_5_flare", provider: "oxen" });
const r = host.recipe;
if (!r || r.provider !== "oxen" || r.input !== "fill") throw new Error("select_recipe gave " + (r && [r.id, r.provider, r.input].join(" ")));
const stitch = await import("./editor/stitch.js");
const info = stitch.prepareCrop(ed, host.nodeParams, host.cropLimits()).info;
const out = await generate(ed);
return { emitted: info.emitted, err: out.err, layer: out.layer && [out.layer.x, out.layer.y, out.layer.w, out.layer.h], status: ed.status };
"""

GENERATE_NEW = """
const ed = ednow(window.__oxDoc);
host.shell.activate(ed);
await run("select_recipe", { id: "nano_banana_2", provider: "oxen" });
const t = host.recipe.text;
if (!t || t.model !== "nano-banana-2") throw new Error("no text shape on oxen: " + JSON.stringify(t));
await run("generate_new", { doc: window.__oxDoc, prompt: "a lighthouse at dusk", aspect: "16:9", resolution: 1024, timeout: 120 });
return { size: [ed.width, ed.height], status: ed.status };
"""

UPSAMPLE = """
const ed = await fresh();
await host.refreshLLMs();
const ids = host.upsampleBackends().map((b) => b.id);
const mine = ids.filter((id) => id.startsWith("app:oxen:"));
if (JSON.stringify(mine) !== JSON.stringify(__CHAT__.map((m) => "app:oxen:" + m))) throw new Error("the Oxen rows with the key: " + ids.join(", "));
ed.refreshSegmentBackends();
ed.upBackendSel.value = "app:oxen:gemini-3-8-flash";
if (ed.upBackendSel.value !== "app:oxen:gemini-3-8-flash") throw new Error("the editor's select has no Oxen row: " + Array.from(ed.upBackendSel.options).map((o) => o.value).join(", "));
const r = await run("upsample_prompt", { doc: window.__oxDoc });
return { rows: mine.length, prompt: r.prompt || ed.promptText, status: ed.status };
"""

REAL_KEY_REFUSED = """
const ed = await fresh();
await window.scumble.keys.set("oxen", __REALKEY__);
const out = {};
try {
    await run("select_recipe", { id: "nano_banana_2", provider: "oxen" });
    const g = await generate(ed);
    out.generate = g.err || "no error";
    out.layers = g.layer ? 1 : 0;
    ed.refreshSegmentBackends();
    ed.upBackendSel.value = "app:oxen:gemini-3-8-flash";
    try { await run("upsample_prompt", { doc: window.__oxDoc, timeout: 60 }); out.upsample = "no error"; } catch (err) { out.upsample = String(err.message || err); }
} finally {
    await window.scumble.keys.set("oxen", __KEY__);
}
return out;
"""

CLEANUP = """
const out = {};
const t = window.__ox;
if (t && t.stored) { await window.scumble.keys.clear("oxen"); out.keyCleared = true; }
for (const d of document.querySelectorAll("dialog[open]")) d.close();
if (t) {
    const s = t.saved;
    // every recipe goes back through selectRecipe first (the window's own view of the providers); selectRecipe writes
    // the settings file without waiting, so the saved settings are written last, and openSettings re-reads the shell's copy
    for (const id of __TOUCHED__) { const want = (s.recipeProviders || {})[id]; if (want) host.shell.selectRecipe(id, want); }
    if (t.recipe && t.recipe.id === s.recipe) host.shell.selectRecipe(t.recipe.id);
    else if (t.recipe) host.setRecipe(t.recipe);
    await wait(800);
    await window.scumble.settings.set({ oxen: s.oxen, recipeProviders: s.recipeProviders, recipe: s.recipe, recipeByMode: s.recipeByMode });
    await shell.openSettings();
    document.getElementById("shell-settings").close();
    await host.refreshLLMs();
}
if (window.__oxDoc) { try { await run("close_document", { doc: window.__oxDoc, force: true }); } catch (_) { /* gone */ } }
const k = await window.scumble.keys.list();
out.keyLeft = !!((k.keys || {}).oxen && k.keys.oxen.set);
if (t) {
    if (out.keyLeft) throw new Error("the test key is still stored");
    out.rowsLeft = host.upsampleBackends().some((b) => b.id.startsWith("app:oxen:"));
    if (out.rowsLeft) throw new Error("Oxen upsampling rows stay after the key was cleared");
    const now = await window.scumble.settings.get();
    const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
    out.restored = same(now.oxen, t.saved.oxen) && same(now.recipeProviders, t.saved.recipeProviders) && same(now.recipe, t.saved.recipe);
    if (!out.restored) throw new Error("the settings are not back: " + JSON.stringify({ oxen: now.oxen, recipeProviders: now.recipeProviders, recipe: now.recipe }));
}
window.__ox = null; window.__oxDoc = null;
return out;
"""


def node_step():
    r = subprocess.run(["node", NODE_TEST], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=300)
    tail = (r.stdout + r.stderr).strip()
    if r.returncode != 0 or not tail.endswith("PASS"):
        lines = tail.splitlines()
        failed = [ln for ln in lines if ln.startswith("[FAIL]")]
        counted = [ln for ln in lines if " checks passed" in ln]
        shown = "\n    ".join([ln[:400] for ln in failed] + counted[-1:]) if failed else tail[-1500:]
        raise Exception("tools/oxen_test.js (rc %d):\n    %s" % (r.returncode, shown))
    return {"checks": tail.count("[ok]")}


def image_posts(mock, route):
    calls = mock.snapshot()["calls"]
    posts = [cl for cl in calls if cl["method"] == "POST" and cl["path"].startswith("/api/ai/images/")]
    if len(posts) != 1 or posts[0]["path"] != "/api/ai/images/" + route or len(calls) != 1:
        raise Exception("the mock saw %s" % [(cl["method"], cl["path"]) for cl in calls])
    cl = posts[0]
    if cl["headers"].get("authorization") != "Bearer " + KEY:
        raise Exception("the call did not carry the test key")
    return cl


def covers_selection(layer):
    lx, ly, lw, lh = layer
    return lx <= 400 and ly <= 250 and lx + lw >= 820 and ly + lh >= 530


async def run_all(c):
    mock = Mock().start()
    print("mock Oxen.ai on", mock.url)
    ok = True

    async def ev(body, **subs):
        subs.setdefault("__PROMPT__", json.dumps(PROMPT))
        for k, v in subs.items():
            body = body.replace(k, v)
        return await c.eval(PRE.replace("__PROMPT__", subs["__PROMPT__"]) % body, timeout=240)

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

    try:
        async def adapter():
            done("adapter_in_plain_node", node_step())
        await step("adapter_in_plain_node", adapter)

        await c.eval("(async () => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); window.__oxCmds = await import('./commands.js'); window.__oxHost = (await import('./editor/host.js')).host; window.__oxShell = await import('./shell.js'); return 1; })()")

        async def setup():
            done("setup", await ev(SETUP, __MOCK__=json.dumps(mock.url)))
        if not await step("setup", setup):
            raise Stop()

        async def lists():
            done("lists_before_and_after_the_key", await ev(LISTS, __RECIPES__=json.dumps(RECIPES), __CHAT__=json.dumps(CHAT), __KEY__=json.dumps(KEY)))
        if not await step("lists_before_and_after_the_key", lists):
            raise Stop()

        async def edit():
            mock.reset()
            res = await ev(EDIT)
            if res["err"] or not res["layer"] or not covers_selection(res["layer"]):
                raise Exception("no result layer over the selection: %s / %s / %s" % (res["err"], res["layer"], res["status"]))
            cl = image_posts(mock, "edit")
            b, pics = cl["json"], cl["pictures"]
            ew, eh = res["emitted"]
            if not pics or any(p["field"] != "input_image" for p in pics) or pics[0]["format"] != "png" or pics[0]["dims"] != [ew, eh]:
                raise Exception("the pictures %s, the emitted crop %dx%d" % (pics, ew, eh))
            if not str(b["input_image"][0]).startswith("data:image/png;base64,") or "mask_url" in b:
                raise Exception("the body: %s" % b)
            # "closest": the preset nearest the crop's own shape (the auto context makes that crop squarer than the
            # selection), read from the variant's own list
            with open(os.path.join(ROOT, "recipes", "seedream_5_pro.json"), encoding="utf-8") as f:
                ratios = json.load(f)["providers"]["oxen"]["options"]["ratios"]
            want = min(ratios, key=lambda s: abs(math.log(int(s.split(":")[0]) / int(s.split(":")[1]) / (ew / eh))))
            if b.get("watermark") is not False or b.get("response_format") != "b64_json" or b.get("aspect_ratio") != want or b.get("size") not in ("1K", "2K"):
                raise Exception("the body (the closest preset to %dx%d is %s): %s" % (ew, eh, want, {k: v for k, v in b.items() if k != "input_image"}))
            if not str(b.get("prompt", "")).startswith("Edit the first image"):
                raise Exception("the prompt: %r" % b.get("prompt"))
            done("an_edit_sends_the_crop_as_a_data_url", {"crop": [ew, eh], "aspect_ratio": b["aspect_ratio"], "size": b["size"], "layer": res["layer"]})
        await step("an_edit_sends_the_crop_as_a_data_url", edit)

        async def mask():
            mock.reset()
            res = await ev(MASK)
            if res["err"] or not res["layer"] or not covers_selection(res["layer"]):
                raise Exception("no result layer over the selection: %s / %s / %s" % (res["err"], res["layer"], res["status"]))
            cl = image_posts(mock, "edit")
            b = cl["json"]
            pics = {p["field"]: p for p in cl["pictures"]}
            ew, eh = res["emitted"]
            m = pics.get("mask_url")
            if not m or m["format"] != "png" or m["dims"] != [ew, eh] or not m.get("alpha") or m.get("centre") != 0 or m.get("corner") != 255:
                raise Exception("the mask %s, the emitted crop %dx%d (transparent at the centre, opaque in the corner)" % (m, ew, eh))
            if pics.get("input_image", {}).get("dims") != [ew, eh]:
                raise Exception("the picture %s" % pics.get("input_image"))
            if b.get("aspect_ratio") != "auto" or b.get("output_format") != "png" or b.get("response_format") != "b64_json" or b.get("moderation") != "low" or b.get("quality") != "high":
                raise Exception("the body: %s" % {k: v for k, v in b.items() if k not in ("input_image", "mask_url")})
            done("a_mask_run_on_a_gpt_model_sends_an_alpha_mask", {"crop": [ew, eh], "mask": m, "resolution": b.get("resolution")})
        await step("a_mask_run_on_a_gpt_model_sends_an_alpha_mask", mask)

        async def generate_new():
            mock.reset()
            res = await ev(GENERATE_NEW)
            cl = image_posts(mock, "generate")
            b = cl["json"]
            if "input_image" in b or cl["pictures"] or b.get("aspect_ratio") != "16:9" or b.get("resolution") != "1K" or b.get("model") != "nano-banana-2" or b.get("prompt") != "a lighthouse at dusk":
                raise Exception("the text request: %s" % b)
            if res["size"] != [1024, 576]:
                raise Exception("the new base is %s, the mock answered 1024 x 576" % res["size"])
            done("generate_new_on_oxen", {"body": b, "size": res["size"]})
        await step("generate_new_on_oxen", generate_new)

        async def upsample():
            mock.reset()
            res = await ev(UPSAMPLE, __CHAT__=json.dumps(CHAT))
            snap = mock.snapshot()
            if "UPSAMPLED" not in res["prompt"] or "image: yes" not in res["prompt"]:
                raise Exception("the Oxen row did not reach the endpoint with the picture: %s / %s" % (res["prompt"], res["status"]))
            if [cl["path"] for cl in snap["calls"]] != ["/api/ai/chat/completions"] or len(snap["chats"]) != 1:
                raise Exception("the mock saw %s" % [(cl["method"], cl["path"]) for cl in snap["calls"]])
            ch = snap["chats"][0]
            if ch["auth"] != "Bearer " + KEY or not ch["image"] or ch["body"].get("model") != "gemini-3-8-flash" or ch["body"].get("stream") is not False:
                raise Exception("the chat request: auth %r, image %s, body %s" % (ch["auth"], ch["image"], {k: v for k, v in ch["body"].items() if k != "messages"}))
            done("upsample_on_the_oxen_key", {"prompt": res["prompt"], "rows": res["rows"]})
        await step("upsample_on_the_oxen_key", upsample)

        async def real_key():
            mock.reset()
            res = await ev(REAL_KEY_REFUSED, __REALKEY__=json.dumps(REAL_KEY), __KEY__=json.dumps(KEY))
            calls = mock.snapshot()["calls"]
            bad = [k for k in ("generate", "upsample") if "test address" not in res.get(k, "")]
            if bad or res.get("layers") or calls:
                raise Exception("not refused: %s, the mock saw %d calls" % (res, len(calls)))
            if any(REAL_KEY in str(res.get(k)) for k in ("generate", "upsample")):
                raise Exception("the real-looking key is in a message")
            done("a_real_key_never_reaches_the_mock", {"generate": res["generate"][:120], "requests": 0})
        await step("a_real_key_never_reaches_the_mock", real_key)

        seen = mock.all_calls()
        wrong = [cl["path"] for cl in seen if cl["headers"].get("authorization") not in (None, "Bearer " + KEY)]
        keyed_off_api = [cl["path"] for cl in seen if cl["headers"].get("authorization") and not cl["path"].startswith("/api/ai/")]
        attribution = [cl["path"] for cl in seen if any(h in cl["headers"] for h in ("http-referer", "referer", "x-title"))]
        not_b64 = [cl["path"] for cl in seen if cl["path"].startswith("/api/ai/images/") and (cl.get("json") or {}).get("response_format") != "b64_json"]
        if wrong or keyed_off_api or attribution or not_b64 or not seen:
            ok = False
            print("[FAIL] no_key_off_the_api: another key %s, keyed off the API %s, attribution %s, no b64_json %s" % (wrong[:3], keyed_off_api[:3], attribution[:3], not_b64[:3]))
        else:
            print("[ok] no_key_off_the_api: %d calls" % len(seen))
    except Stop:
        pass
    except Exception as err:  # noqa: BLE001
        ok = False
        print("[FAIL]", err)
    finally:
        try:
            res = await c.eval((PRE.replace("__PROMPT__", json.dumps(PROMPT))) % CLEANUP.replace("__TOUCHED__", json.dumps(TOUCHED)), timeout=60)
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
