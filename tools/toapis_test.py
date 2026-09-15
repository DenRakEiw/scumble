"""ToAPIs end to end without a key: the adapter in plain Node, then the app against tools/toapis_mock.py.

No ComfyUI and no ToAPIs account. The first step runs tools/toapis_test.js (the adapter against a scripted fetch).
The rest drives the running app over CDP with settings.toapis.base pointed at the mock on 127.0.0.1 (an address
the adapter's allowlist accepts) and a test key stored under the name "toapis":

- every provider list puts ToAPIs first (Settings › API providers with its referral link, each served recipe's
  provider select, Generate new, list_recipes), and every recipe keeps its home provider as the default;
- the key row's "check balance" answers from GET /v1/balance;
- the shipped gpt_image_2 variant inpaints on its official channel: the crop and the alpha mask go up as
  uploads, the request names the model, the crop's ratio and the tier, the key goes to the API and never to the
  file host, and the answer becomes a result layer; the standard channel sends no mask;
- Generate new makes a base image of the asked aspect without an upload;
- a failed task puts its message in the status line, and the log holds the task id but not the key;
- a submit answered 429 is sent again after Retry-After.

A profile that already holds a ToAPIs key is refused, never overwritten; the test key and the setting are removed
at the end whatever happens.

    python tools/toapis_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555
"""
import asyncio
import io
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402
from toapis_mock import Mock  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY = "sk-toapistest-0123456789"
REFERRAL = "https://toapis.com/login?aff=vfR1"
HOMES = {"gpt_image_2": "openai", "gpt_image_2_5_flare": "openai", "gpt_image_2_5_sunburst": "openai", "nano_banana_2": "gemini", "nano_banana_2_lite": "gemini", "nano_banana_pro": "gemini",
         "flux2_pro": "bfl", "flux2_flex": "bfl", "seedream_5_lite": "fal", "seedream_5_pro": "fal", "qwen_image_edit": "fal"}

PRE = """(async () => {
    const commands = window.__cmds.commands, host = window.__host, shell = window.__shell;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (f, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await wait(100); } return null; };
    %s
})()"""

SETUP = """
const had = await window.scumble.keys.list();
if ((had.keys || {}).toapis && had.keys.toapis.set) throw new Error("this profile holds a ToAPIs key; the test never overwrites a key");
const s = await window.scumble.settings.get();
window.__tp = { toapis: s.toapis, recipe: host.recipe, stored: false, recipeProviders: s.recipeProviders || {} };
await window.scumble.settings.set({ toapis: { base: __MOCK__ } });
const d = await run("new_document");
window.__tpDoc = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { doc: d.id, width: 1200, height: 800, color: "#708090" });
await run("select_rect", { doc: d.id, x: 400, y: 250, width: 420, height: 280 });
return { size: [ed.width, ed.height], remembered: Object.keys(s.recipeProviders || {}) };
"""

LISTS_BEFORE_THE_KEY = """
const list = await window.scumble.providers.list();
const first = list[0];
if (!first || first.id !== "toapis") throw new Error("Settings › API providers does not start with ToAPIs: " + list.map((p) => p.id).join(", "));
if (first.keyUrl !== __REFERRAL__ || !first.balance || first.label !== "ToAPIs") throw new Error("the ToAPIs row: " + JSON.stringify(first));
const remembered = (await window.scumble.settings.get()).recipeProviders || {};
const rl = await run("list_recipes");
const homes = __HOMES__;
const served = {};
for (const [id, home] of Object.entries(homes)) {
    const r = rl.recipes.find((x) => x.id === id);
    if (!r) throw new Error("recipe missing: " + id);
    if (r.providers[0] !== "toapis") throw new Error(id + ": list_recipes providers start with " + r.providers[0]);
    if (!remembered[id] && r.provider !== home) throw new Error(id + ": the default moved to " + r.provider + " (home " + home + ")");
    served[id] = r.provider;
}
// the Settings dialog: the key rows and each served recipe's provider select
await shell.openSettings();
await wait(300);
const rows = Array.from(document.querySelectorAll("#set-providers .shell-provider, .shell-provider"));
const firstRow = rows[0];
const rowText = firstRow ? firstRow.textContent : "";
if (!/^ToAPIs/.test(rowText) || !/get a key/.test(rowText) || /check balance/.test(rowText)) throw new Error("the first key row: " + rowText);
const selects = {};
for (const id of Object.keys(homes)) {
    const row = document.querySelector('.shell-recipe[data-id="' + id + '"]');
    const sel = row && row.querySelector("select");
    if (!sel) throw new Error("no provider select for " + id);
    selects[id] = sel.options[0].textContent;
    if (sel.options[0].value !== "toapis" || sel.options[0].textContent !== "ToAPIs (no key)") throw new Error(id + ": the first option is " + sel.options[0].value + " / " + sel.options[0].textContent);
}
document.getElementById("shell-settings").close();
// Generate new: the provider select of a served model
await host.shell.openGenerateNew(ednow(window.__tpDoc));
await wait(200);
const mode = document.getElementById("gen-mode"), rec = document.getElementById("gen-recipe"), prov = document.getElementById("gen-provider");
mode.value = "api"; mode.dispatchEvent(new Event("change"));
rec.value = "nano_banana_2"; rec.dispatchEvent(new Event("change"));
const genFirst = prov.options[0] && prov.options[0].value;
const genDefault = prov.value;
document.getElementById("gen-dialog").close();
if (genFirst !== "toapis") throw new Error("Generate new lists " + genFirst + " first");
if (!remembered.nano_banana_2 && genDefault !== "gemini") throw new Error("Generate new preselects " + genDefault + " for Nano Banana 2");
return { providers: list.slice(0, 3).map((p) => p.id), keyRow: rowText.slice(0, 80), served, generateNew: [genFirst, genDefault], select: selects.gpt_image_2 };
"""

STORE_KEY_AND_BALANCE = """
await window.scumble.keys.set("toapis", __KEY__);
window.__tp.stored = true;
await shell.openSettings();
await wait(300);
const row = Array.from(document.querySelectorAll(".shell-provider"))[0];
const link = row && Array.from(row.querySelectorAll("a")).find((a) => a.textContent === "check balance");
if (!link) throw new Error("no check balance link on the ToAPIs row with a key: " + (row && row.textContent));
link.click();
const text = await until(() => { const o = row.querySelector(".shell-balance-out"); return o && !/checking/.test(o.textContent) && o.textContent.trim() ? o.textContent : null; }, 15000);
const sel = document.querySelector('.shell-recipe[data-id="gpt_image_2"] select');
const option = sel && sel.options[0].textContent;
document.getElementById("shell-settings").close();
if (!text || !/\\$10\\.50 left/.test(text)) throw new Error("the balance reads " + text);
if (option !== "ToAPIs") throw new Error("with a key the option still reads " + option);
return { balance: text.trim(), option };
"""

USE_VARIANT = """
const raw = host.shell.recipes().find((x) => x.id === "gpt_image_2");
// a copy with its own id and ToAPIs as default: no remembered choice is touched
const r = host.shell.resolveRecipe({ ...raw, id: "gpt_image_2__toapis_test", default: "toapis" });
if (r.provider !== "toapis" || r.model !== "gpt-image-2-official") throw new Error("resolved to " + r.provider + " / " + r.model);
host.setRecipe(r);
const ed = ednow(window.__tpDoc);
host.shell.activate(ed);
const chan = Object.values(ed.settings).find((e) => /channel$/.test(e.target || ""));
if (!chan || chan.value !== "official") throw new Error("the Channel row does not start on official: " + JSON.stringify(ed.settings));
__CHANNEL__
return { channel: chan.value, settings: Object.values(ed.settings).map((e) => [e.target, e.value]) };
"""

RECIPE_SWITCH = """
// review F1: every provider recipe's Channel row is index 1 with the key "channel"; the editor keeps a
// stored value while the setting's target is the same, so the target has to name the recipe and provider
const R = (id) => {
    const raw = host.shell.recipes().find((x) => x.id === id);
    return host.shell.resolveRecipe({ ...raw, id: id + "__toapis_switch", default: "toapis" });
};
const ed = ednow(window.__tpDoc);
host.shell.activate(ed);
const row = (key) => { const s = host.recipe.settings.find((x) => x.key === key); return s ? ed.settings[String(s.index)] : null; };
const seen = [];
host.setRecipe(R("qwen_image_edit"));
seen.push(["qwen", row("channel").value]);
if (row("channel").value !== "standard") throw new Error("Qwen via ToAPIs does not start on its standard channel: " + row("channel").value);
host.setRecipe(R("gpt_image_2"));
seen.push(["gpt_image_2", row("channel").value, row("quality").value]);
if (row("channel").value !== "official") throw new Error("after Qwen, GPT Image 2 via ToAPIs kept the channel " + row("channel").value + " instead of its default official");
const params = host.providerParams(ed);
if (params.channel !== "official") throw new Error("the run would ask for channel " + params.channel);
host.setRecipe(R("gpt_image_2_5_flare"));
row("quality").value = "xhigh";
host.setRecipe(R("gpt_image_2"));
seen.push(["gpt_image_2 after flare xhigh", row("quality").value]);
if (row("quality").value !== "high") throw new Error("after GPT Image 2.5 on xhigh, GPT Image 2's quality is " + row("quality").value + " instead of its default high");
row("channel").value = "vip";
host.setRecipe(host.recipe);
seen.push(["the same recipe again", row("channel").value]);
if (row("channel").value !== "vip") throw new Error("setting the same recipe again lost the chosen channel: " + row("channel").value);
return seen;
"""

GENERATE = """
const ed = ednow(window.__tpDoc);
await run("select_rect", { doc: window.__tpDoc, x: 400, y: 250, width: 420, height: 280 });
const before = ed.layers.length;
const out = await run("generate", { doc: window.__tpDoc, timeout: 120 });
if (ed.layers.length !== before + 1) throw new Error("no result layer: " + ed.status);
return { status: ed.status, layer: out.layer && [out.layer.width, out.layer.height] };
"""

GENERATE_NEW = """
const ed = ednow(window.__tpDoc);
const out = await run("generate_new", { doc: window.__tpDoc, prompt: "a lighthouse at dusk", aspect: "16:9", resolution: 1024, timeout: 120 });
const ratio = ed.width / ed.height;
if (Math.abs(ratio - 16 / 9) > 0.02) throw new Error("the new base is " + ed.width + " x " + ed.height);
return { size: [ed.width, ed.height], status: ed.status };
"""

GENERATE_NEW_DIALOG = """
// review app F2: the dialog itself (not the command) has to send the chosen aspect, or a ratio channel gets
// the reduced ratio of the rounded size (3:2 at 1024 is 1024 x 688, "64:43")
const ed = ednow(window.__tpDoc);
await host.shell.openGenerateNew(ed);
await wait(200);
const $ = (id) => document.getElementById(id);
const set = (id, v) => { $(id).value = v; $(id).dispatchEvent(new Event("change")); };
set("gen-mode", "api");
set("gen-recipe", "gpt_image_2");
set("gen-provider", "toapis");
if ($("gen-provider").value !== "toapis") throw new Error("Generate new has no ToAPIs provider for GPT Image 2");
set("gen-aspect", "3:2");
set("gen-resolution", "1024");
$("gen-prompt").value = "a lighthouse at dusk";
const note = $("gen-size-note").textContent;
$("gen-go").click();
const closed = await until(() => !$("gen-dialog").open, 120000);
if (!closed) throw new Error("the dialog did not finish: " + $("gen-state").textContent);
return { note, size: [ed.width, ed.height], recipe: host.recipe.id, provider: host.recipe.provider };
"""

CROP_RATIO = """
// review F4: Seedream takes no image longer than 3:1; a thin selection gets more context on its short side
const stitch = await import("./editor/stitch.js");
const ed = ednow(window.__tpDoc);
const raw = host.shell.recipes().find((x) => x.id === "seedream_5_lite");
const lim = raw.providers.toapis.limits;
if (!lim || lim.ratio !== 3) throw new Error("the Seedream ToAPIs variant has no ratio limit: " + JSON.stringify(lim));
await run("new_canvas", { doc: window.__tpDoc, width: 6000, height: 2000, color: "#708090" });
await run("select_rect", { doc: window.__tpDoc, x: 1500, y: 980, width: 3000, height: 40 });
const withRatio = stitch.prepareCrop(ed, host.nodeParams, { ...lim, mode: "max" }).info;
const without = stitch.prepareCrop(ed, host.nodeParams, { ...lim, ratio: 0, mode: "max" }).info;
const r = (i) => Math.max(i.emitted[0], i.emitted[1]) / Math.min(i.emitted[0], i.emitted[1]);
if (r(without) <= 3) throw new Error("the thin selection is not steeper than 3:1 without the limit, so the step proves nothing: " + without.emitted.join("x"));
if (r(withRatio) > 3) throw new Error("with the limit the crop is still " + withRatio.emitted.join(" x ") + " (bbox " + withRatio.bbox.join(",") + ")");
if (withRatio.bbox[2] !== without.bbox[2]) throw new Error("the long side changed: " + withRatio.bbox + " / " + without.bbox);
// the adapter takes it: a run on the mock goes through
const R = host.shell.resolveRecipe({ ...raw, id: "seedream_5_lite__toapis_ratio", default: "toapis" });
host.setRecipe(R);
const before = ed.layers.length;
await run("generate", { doc: window.__tpDoc, timeout: 120 });
if (ed.layers.length !== before + 1) throw new Error("no result layer: " + ed.status);
return { with: withRatio.emitted, bbox: withRatio.bbox, without: without.emitted };
"""

FAIL_RUN = """
const ed = ednow(window.__tpDoc);
await run("new_canvas", { doc: window.__tpDoc, width: 1200, height: 800, color: "#708090" });
await run("select_rect", { doc: window.__tpDoc, x: 400, y: 250, width: 420, height: 280 });
host.setRecipe({ ...host.recipe, id: "toapis_fail_test", model: "mock-fail", input: "edit", options: { size: "preset", ratios: ["1:1", "3:2"] }, settings: [] });
const logBefore = (await run("read_log", { limit: 1 })).total;
let msg = "";
try { await run("generate", { doc: window.__tpDoc, timeout: 120 }); } catch (err) { msg = String(err.message || err); }
const log = await run("read_log", { level: "error", limit: 50 });
const mine = log.entries.filter((e) => e.source === "toapis");
return { error: msg, status: ed.status, log: mine.slice(-1), logText: JSON.stringify(log.entries) };
"""

RETRY_RUN = """
const ed = ednow(window.__tpDoc);
host.setRecipe({ ...host.recipe, id: "toapis_429_test", model: "mock-429", input: "edit", options: { size: "preset", ratios: ["1:1", "3:2"] }, settings: [] });
const before = ed.layers.length;
const t0 = Date.now();
await run("generate", { doc: window.__tpDoc, timeout: 120 });
if (ed.layers.length !== before + 1) throw new Error("no result layer after the retry: " + ed.status);
return { seconds: (Date.now() - t0) / 1000, status: ed.status };
"""

CLEANUP = """
const out = {};
if (window.__tp && window.__tp.stored) { await window.scumble.keys.clear("toapis"); out.keyCleared = true; }
if (window.__tp) { await window.scumble.settings.set({ toapis: window.__tp.toapis, recipeProviders: window.__tp.recipeProviders }); if (window.__tp.recipe) host.setRecipe(window.__tp.recipe); }
for (const d of document.querySelectorAll("dialog[open]")) d.close();
if (window.__tpDoc) { try { await run("close_document", { doc: window.__tpDoc, force: true }); } catch (_) { /* gone */ } }
const k = await window.scumble.keys.list();
out.keyLeft = !!((k.keys || {}).toapis && k.keys.toapis.set);
if (out.keyLeft && window.__tp && window.__tp.stored) throw new Error("the test key is still stored");
window.__tp = null; window.__tpDoc = null;
return out;
"""


def node_step():
    r = subprocess.run(["node", os.path.join(ROOT, "tools", "toapis_test.js")], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=120)
    tail = (r.stdout + r.stderr).strip()
    if r.returncode != 0 or not tail.endswith("PASS"):
        raise Exception("tools/toapis_test.js: " + tail[-1500:])
    return {"checks": tail.count("[ok]")}


def png_alpha(data):
    from PIL import Image
    im = Image.open(io.BytesIO(data))
    im.load()
    return im


def check_official(mock, crop_dims_hint):
    snap = mock.snapshot()
    ups = snap["uploads"]
    subs = snap["submits"]
    if len(subs) != 1:
        raise Exception("expected one submit, the mock saw %d" % len(subs))
    b = subs[0]
    crop = next((i for i, u in enumerate(ups) if u["name"].endswith("-crop.png")), None)
    mask = next((i for i, u in enumerate(ups) if u["name"].endswith("-mask.png")), None)
    if len(ups) != 2 or crop is None or mask is None:
        raise Exception("expected the crop and the mask uploaded: %s" % [u["name"] for u in ups])
    if b.get("model") != "gpt-image-2-official" or b.get("image_urls") != [ups[crop]["url"]] or b.get("mask_url") != ups[mask]["url"]:
        raise Exception("the request does not use the uploads: %s" % json.dumps(b))
    if "channel" in b or b.get("quality") != "high" or b.get("n") != 1:
        raise Exception("the request's parameters: %s" % json.dumps(b))
    w, h = ups[crop]["dims"]
    a, c = (int(v) for v in b["size"].split(":"))
    if abs(a / c - w / h) > 0.001:
        raise Exception("size %s is not the crop's ratio %dx%d" % (b["size"], w, h))
    # the smallest tier whose output (the page's table for a preset ratio) covers the crop, else by the long side
    with open(os.path.join(ROOT, "recipes", "gpt_image_2.json"), encoding="utf-8") as f:
        opts = json.load(f)["providers"]["toapis"]["options"]
    want_tier = None
    for tier, base in sorted(opts["tiers"].items(), key=lambda kv: kv[1]):
        out = opts.get("tier_sizes", {}).get(b["size"], {}).get(tier)
        ow, oh = (int(v) for v in out.split("x")) if out else (0, 0)
        if (ow >= w and oh >= h) if out else base >= max(w, h):
            want_tier = tier
            break
    want_tier = want_tier or "4k"
    if b.get("resolution") != want_tier:
        raise Exception("resolution %s for a crop of %dx%d, wanted %s" % (b.get("resolution"), w, h, want_tier))
    im = png_alpha(mock.upload_bytes(mask))
    if im.size != (w, h) or im.mode != "RGBA":
        raise Exception("the mask is %s %s, the crop %dx%d: not the alpha mask" % (im.mode, im.size, w, h))
    alpha = im.getchannel("A")
    centre, corner = alpha.getpixel((w // 2, h // 2)), alpha.getpixel((1, 1))
    if centre != 0 or corner != 255:
        raise Exception("the mask's alpha is %d in the middle and %d in the corner: transparent has to mark the selection" % (centre, corner))
    api = [cl for cl in snap["calls"] if cl["path"].startswith("/v1/")]
    files = [cl for cl in snap["calls"] if cl["path"].startswith("/files/")]
    if not api or any(cl["auth"] != "Bearer " + KEY for cl in api):
        raise Exception("an API call without the key: %s" % [(cl["method"], cl["path"], bool(cl["auth"])) for cl in api])
    if len(files) != 1 or files[0]["auth"]:
        raise Exception("the download: %s" % files)
    return {"body": {k: v for k, v in b.items() if k not in ("prompt",)}, "crop": [w, h], "mask_alpha": [centre, corner], "calls": len(snap["calls"])}


def check_standard(mock):
    snap = mock.snapshot()
    b = snap["submits"][0]
    if len(snap["uploads"]) != 1 or "mask_url" in b or b.get("model") != "gpt-image-2" or "quality" in b:
        raise Exception("the standard channel: uploads %s, request %s" % ([u["name"] for u in snap["uploads"]], json.dumps(b)))
    ratios = ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21"]
    if b.get("size") not in ratios:
        raise Exception("the standard channel sends %s, not a preset" % b.get("size"))
    return {"body": {k: v for k, v in b.items() if k != "prompt"}}


def check_text(mock):
    snap = mock.snapshot()
    if snap["uploads"]:
        raise Exception("a text run uploaded %s" % [u["name"] for u in snap["uploads"]])
    b = snap["submits"][0]
    if b.get("size") != "16:9" or "image_urls" in b:
        raise Exception("the text request: %s" % json.dumps(b))
    return {"body": {k: v for k, v in b.items() if k != "prompt"}}


async def run_all(c):
    mock = Mock().start()
    print("mock ToAPIs on", mock.url)
    ok = True

    async def js(name, body, **subs):
        for k, v in subs.items():
            body = body.replace(k, v)
        res = await c.eval(PRE % body, timeout=240)
        print("[ok] %s: %s" % (name, json.dumps(res, ensure_ascii=False)[:400]))
        return res

    try:
        print("[ok] adapter_in_plain_node: %s" % json.dumps(node_step()))
        await c.eval("(async () => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); window.__cmds = await import('./commands.js'); window.__host = (await import('./editor/host.js')).host; window.__shell = await import('./shell.js'); return 1; })()")
        await js("setup", SETUP, __MOCK__=json.dumps(mock.url))
        await js("every_list_puts_toapis_first_and_keeps_the_defaults", LISTS_BEFORE_THE_KEY, __REFERRAL__=json.dumps(REFERRAL), __HOMES__=json.dumps(HOMES))
        await js("the_key_row_checks_the_balance", STORE_KEY_AND_BALANCE, __KEY__=json.dumps(KEY))

        await js("a_recipe_switch_starts_from_that_recipes_own_settings", RECIPE_SWITCH)
        await js("use_the_shipped_gpt_image_2_variant", USE_VARIANT, __CHANNEL__="")
        mock.reset()
        await js("official_channel_generate", GENERATE)
        print("[ok] official_channel_sends_crop_and_alpha_mask: %s" % json.dumps(check_official(mock, None))[:500])

        await js("switch_to_the_standard_channel", USE_VARIANT, __CHANNEL__='chan.value = "standard"; host.setRecipe(host.recipe);')
        # setRecipe re-reads the rows and keeps a value whose target did not change, so the switch holds
        mock.reset()
        await c.eval(PRE % 'const ed = ednow(window.__tpDoc); const e = Object.values(ed.settings).find((x) => /channel$/.test(x.target || "")); e.value = "standard"; return e.value;')
        await js("standard_channel_generate", GENERATE)
        print("[ok] standard_channel_sends_no_mask: %s" % json.dumps(check_standard(mock))[:400])

        mock.reset()
        await js("generate_new_on_toapis", GENERATE_NEW)
        print("[ok] generate_new_uploads_nothing_and_asks_the_aspect: %s" % json.dumps(check_text(mock))[:400])

        mock.reset()
        res = await js("generate_new_dialog_on_toapis", GENERATE_NEW_DIALOG)
        subs = mock.snapshot()["submits"]
        if len(subs) != 1 or subs[0].get("size") != "3:2" or subs[0].get("model") != "gpt-image-2-official" or subs[0].get("resolution") != "1k" or mock.snapshot()["uploads"]:
            raise Exception("the dialog's 3:2 at 1024 was sent as %s (the note read %s)" % (json.dumps(subs), res.get("note")))
        print("[ok] the_dialog_sends_the_chosen_aspect: %s" % json.dumps({k: v for k, v in subs[0].items() if k != "prompt"}))

        mock.reset()
        res = await js("a_failed_task", FAIL_RUN)
        tid = next((s for s in (res["error"] + " " + res["status"]).split() if s.startswith("tsk_img_mock_")), None)
        if "upstream returned status 422" not in res["error"] or "upstream returned status 422" not in res["status"] or not tid:
            raise Exception("the failure does not reach the status line with its task: %s" % json.dumps(res)[:600])
        if not res["log"] or "tsk_img_mock_" not in res["log"][-1]["message"]:
            raise Exception("the log has no ToAPIs error with the task id: %s" % json.dumps(res["log"]))
        if KEY in res["logText"] or KEY in res["error"]:
            raise Exception("the key is in the log or the error")
        print("[ok] the_failure_names_its_task_and_the_log_keeps_no_key: %s" % json.dumps({"task": tid.rstrip(").:,"), "log": res["log"][-1]["message"][:160]}))

        mock.reset()
        await js("a_submit_answered_429", RETRY_RUN)
        subs = mock.snapshot()["submits"]
        if len(subs) != 2 or any(s.get("model") != "mock-429" for s in subs):
            raise Exception("a 429 at submit should be sent once more: %d submits" % len(subs))
        print("[ok] the_429_submit_was_sent_again: 2 submits")

        mock.reset()
        res = await js("a_thin_selection_on_seedream_gets_context_up_to_3_to_1", CROP_RATIO)
        snap = mock.snapshot()
        crop = next((u for u in snap["uploads"] if u["name"].endswith("-crop.png")), None)
        if not crop or len(snap["submits"]) != 1:
            raise Exception("the Seedream run on the mock: uploads %s, %d submits" % ([u["name"] for u in snap["uploads"]], len(snap["submits"])))
        cw, ch = crop["dims"]
        if max(cw, ch) / min(cw, ch) > 3:
            raise Exception("the uploaded crop is %dx%d, steeper than 3:1" % (cw, ch))
        print("[ok] the_uploaded_seedream_crop_is_within_3_to_1: %s" % json.dumps({"crop": [cw, ch], "size": snap["submits"][0].get("size")}))
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
