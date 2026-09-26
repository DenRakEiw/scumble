"""Magnific as a full provider, end to end without a key: the adapter in plain Node, then the app against
tools/magnific_mock.py.

No ComfyUI and no Magnific account. The first step runs tools/magnific_test.js (the adapter against a scripted fetch and
the routes' request schemas). The rest drives the running app over CDP with settings.magnific.base pointed at the mock
on 127.0.0.1 (the only base besides api.magnific.com that the adapter accepts) and a test key in the Magnific row. The
key starts with "test-": the adapter sends such a key only to a loopback base, and any other key never to one.

- the lists: one Magnific key row without "check balance", "(no key)" on its option until the key is stored, magnific
  the last provider of every recipe it joined with the defaults kept, the six new recipes on it, Generate new offering
  Mystic and the text variants, the upscale list as it was;
- an instruction edit on Seedream 5.0 Pro widens the crop to a preset shape: the picture sent is within 1 % of the
  aspect_ratio it names, the prompt starts "Edit the first image", no mask goes out, a result layer lands;
- Ideogram Inpaint sends the mask inverted (black at the selection's centre, white in the corner) at the picture's
  size, and the answer is stretched onto the crop;
- Image Expand after Extend canvas: the kept picture with the four margins and no mask goes out, and an answer 1.024
  times wider (mock-aspect) is stretched, not centre-cropped (the marker column still at the result's right edge);
- Image Expand refuses a selection that is not a border before anything is sent;
- Generate new through Mystic (16:9 at 2048: 2k, widescreen_16_9, the base at the answer's size) and Z-Image;
- a real-looking key is never sent to the test address (generate, Generate new, upscale);
- across every call of the run the key went only to /v1/ai/, never to a download.

A profile that already holds a Magnific key is refused, never overwritten; the test key, settings.magnific, the
remembered providers and the selected recipe are put back at the end whatever happens.

    python tools/magnific_test.py

Start the app first (with --no-comfy: a result is uploaded into the mirror and would be forwarded to a connected
ComfyUI): bash tools/run_gates.sh <label> --offline --tiles on magnific
"""
import asyncio
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402
from magnific_mock import Mock  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE_TEST = os.path.join(ROOT, "tools", "magnific_test.js")
KEY = "test-magnific-gate-0123456789"
REAL_KEY = "FPSX0123456789abcdef0123456789ab"   # the shape of a Magnific key; never a real one
VARIANTS = ["flux2_flex", "flux2_pro", "gpt_image_2", "gpt_image_2_5_flare", "gpt_image_2_5_sunburst", "seedream_5_lite", "seedream_5_pro", "z_image_turbo"]
NEW = ["expand_flux_pro", "expand_ideogram", "expand_seedream_4_5", "ideogram_inpaint", "mystic", "seedream_4_5"]
UPSCALERS = ["magnific_creative", "magnific_precision"]
TEXT = ["flux2_flex", "flux2_pro", "gpt_image_2", "gpt_image_2_5_flare", "gpt_image_2_5_sunburst", "mystic", "seedream_4_5", "seedream_5_lite", "seedream_5_pro", "z_image_turbo"]
TOUCHED = ["seedream_5_pro", "ideogram_inpaint", "expand_flux_pro", "mystic", "z_image_turbo", "magnific_precision"]
PROMPT = "a red car in the rain"
TEXT_PROMPT = "a lighthouse at dusk"


class Stop(Exception):
    """A step the rest stands on failed (its line is printed already)."""


PRE = """(async () => {
    const commands = window.__mgCmds.commands, host = window.__mgHost, shell = window.__mgShell;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const rowOf = (re) => Array.from(document.querySelectorAll(".shell-provider")).find((r) => re.test(r.textContent));
    const logMark = async () => { const l = await run("read_log", { limit: 1 }); const e = l.entries[l.entries.length - 1]; return e ? e.id : 0; };
    const logSince = async (id) => (await run("read_log", { after: id, limit: 500 })).entries;
    const fresh = async () => {
        const ed = ednow(window.__mgDoc);
        host.shell.activate(ed);
        if (ed.width !== 1200 || ed.height !== 800) await run("new_canvas", { doc: window.__mgDoc, width: 1200, height: 800, color: "#708090" });
        await run("select_rect", { doc: window.__mgDoc, x: 400, y: 250, width: 420, height: 280 });
        await run("set_prompt", { doc: window.__mgDoc, text: __PROMPT__ });
        return ed;
    };
    const generate = async (ed) => {
        const before = new Set(ed.layers.map((l) => l.id));
        let err = "";
        try { await run("generate", { doc: window.__mgDoc, timeout: 120 }); } catch (e) { err = String(e.message || e); }
        return { err, layer: ed.layers.find((l) => !before.has(l.id)) || null };
    };
    %s
})()"""

SETUP = """
window.__mg = null;
window.__mgDoc = null;
const had = await window.scumble.keys.list();
if ((had.keys || {}).magnific && had.keys.magnific.set) throw new Error("this profile holds a Magnific key; the test never overwrites a key");
const s = await window.scumble.settings.get();
window.__mg = { saved: { magnific: s.magnific, recipeProviders: s.recipeProviders || {}, recipe: s.recipe, recipeByMode: s.recipeByMode }, recipe: host.recipe, stored: false };
await window.scumble.settings.set({ magnific: { base: __MOCK__ } });
const d = await run("new_document");
window.__mgDoc = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { doc: d.id, width: 1200, height: 800, color: "#708090" });
// colour match off in this document only: the Image Expand step reads the answer's own colours back
ed.cropSettings.colorMatch = false;
return { size: [ed.width, ed.height], recipe: host.recipe && host.recipe.id };
"""

LISTS = """
const list = await window.scumble.providers.list();
const row = list.find((p) => p.id === "magnific");
if (!row || row.label !== "Magnific" || row.balance !== false || row.sharesKey !== null || (row.key && row.key.set)) throw new Error("the Magnific provider entry: " + JSON.stringify(row));
const remembered = (await window.scumble.settings.get()).recipeProviders || {};
const rl = await run("list_recipes");
const on = rl.recipes.filter((r) => (r.providers || []).includes("magnific"));
const edits = on.filter((r) => r.task !== "upscale").map((r) => r.id).sort();
const ups = on.filter((r) => r.task === "upscale").map((r) => r.id).sort();
if (JSON.stringify(edits) !== JSON.stringify(__EDITS__)) throw new Error("recipes that list magnific: " + edits.join(", "));
if (JSON.stringify(ups) !== JSON.stringify(__UPSCALERS__)) throw new Error("upscalers that list magnific: " + ups.join(", "));
for (const r of on.filter((x) => x.task !== "upscale")) {
    if (r.providers[r.providers.length - 1] !== "magnific") throw new Error(r.id + ": magnific is not last: " + r.providers.join(", "));
    const raw = host.shell.recipes().find((x) => x.id === r.id);
    if (__NEW__.includes(r.id) ? raw.default !== "magnific" : raw.default === "magnific") throw new Error(r.id + ": the file's default is " + raw.default);
    if (!remembered[r.id] && r.provider !== raw.default) throw new Error(r.id + ": the default moved to " + r.provider);
}
const text = host.shell.recipes().filter((r) => r.providers && r.providers.magnific && r.providers.magnific.text).map((r) => r.id).sort();
if (JSON.stringify(text) !== JSON.stringify(__TEXT__)) throw new Error("Generate new on Magnific: " + text.join(", "));
await shell.openSettings();
await wait(300);
const options = {};
let keyRow = "";
try {
    const rows = Array.from(document.querySelectorAll(".shell-provider")).filter((x) => /^Magnific/.test(x.textContent));
    keyRow = rows.length ? rows[0].textContent : "";
    if (rows.length !== 1 || !/no key/.test(keyRow) || /check balance/.test(keyRow)) throw new Error("the Magnific key rows: " + rows.map((x) => x.textContent).join(" | "));
    for (const id of ["seedream_5_pro", "gpt_image_2", "mystic"]) {
        const sel = document.querySelector('.shell-recipe[data-id="' + id + '"] select');
        if (!sel) throw new Error("no provider select for " + id);
        const last = sel.options[sel.options.length - 1];
        options[id] = last.value + " / " + last.textContent;
        if (last.value !== "magnific" || last.textContent !== "Magnific (no key)") throw new Error(id + ": the last option is " + options[id]);
    }
} finally {
    document.getElementById("shell-settings").close();
}
await window.scumble.keys.set("magnific", __KEY__);
window.__mg.stored = true;
await shell.openSettings();
await wait(300);
const sel = document.querySelector('.shell-recipe[data-id="seedream_5_pro"] select');
const after = sel && sel.options[sel.options.length - 1].textContent;
const withKey = (rowOf(/^Magnific/) || {}).textContent || "";
document.getElementById("shell-settings").close();
if (after !== "Magnific" || !/key set/.test(withKey)) throw new Error("with the key: the option " + after + ", the row " + withKey);
return { keyRow: keyRow.slice(0, 60), options, after, edits: edits.length, text: text.length };
"""

SEEDREAM_EDIT = """
const ed = await fresh();
await run("select_recipe", { id: "seedream_5_pro", provider: "magnific" });
const r = host.recipe;
if (!r || r.provider !== "magnific" || r.model !== "text-to-image/seedream-v5-pro-edit") throw new Error("select_recipe gave " + (r && [r.id, r.provider, r.model].join(" ")));
const stitch = await import("./editor/stitch.js");
const lim = host.cropLimits();
const info = stitch.prepareCrop(ed, host.nodeParams, lim).info;
const plain = stitch.prepareCrop(ed, host.nodeParams, { ...lim, aspects: [] }).info;
const mark = await logMark();
const out = await generate(ed);
const log = (await logSince(mark)).filter((e) => e.source === "magnific");
return { aspect: info.aspect, bbox: info.bbox, plain: plain.bbox, emitted: info.emitted, err: out.err, layer: out.layer && [out.layer.x, out.layer.y, out.layer.w, out.layer.h], status: ed.status, log };
"""

IDEOGRAM = """
const ed = await fresh();
await run("select_recipe", { id: "ideogram_inpaint", provider: "magnific" });
const r = host.recipe;
if (!r || r.provider !== "magnific" || r.input !== "fill") throw new Error("select_recipe gave " + (r && [r.id, r.provider, r.input].join(" ")));
const stitch = await import("./editor/stitch.js");
const info = stitch.prepareCrop(ed, host.nodeParams, host.cropLimits()).info;
const mark = await logMark();
const out = await generate(ed);
const log = (await logSince(mark)).filter((e) => e.source === "magnific");
return { bbox: info.bbox, emitted: info.emitted, err: out.err, layer: out.layer && [out.layer.x, out.layer.y, out.layer.w, out.layer.h], status: ed.status, log };
"""

EXPAND = """
const ed = ednow(window.__mgDoc);
host.shell.activate(ed);
await run("new_canvas", { doc: window.__mgDoc, width: 640, height: 480, color: "#708090" });
await run("extend_canvas", { doc: window.__mgDoc, left: 64, top: 64, right: 64, bottom: 64 });
if (ed.width !== 768 || ed.height !== 608) throw new Error("extend_canvas gave " + ed.width + " x " + ed.height);
await run("set_prompt", { doc: window.__mgDoc, text: "more sky mock-aspect" });
await run("select_recipe", { id: "expand_flux_pro", provider: "magnific" });
ed.cropSettings.colorMatch = false;   // the answer's own colours are read back below
const stitch = await import("./editor/stitch.js");
const info = stitch.prepareCrop(ed, host.nodeParams, host.cropLimits()).info;
const mark = await logMark();
const out = await generate(ed);
const log = (await logSince(mark)).filter((e) => e.source === "magnific");
let edge = null, inner = null;
if (out.layer) {
    const c = ed.layerPixels(out.layer);
    const g = c.getContext("2d");
    edge = Array.from(g.getImageData(c.width - 2, Math.floor(c.height / 2), 1, 1).data);
    inner = Array.from(g.getImageData(Math.floor(c.width / 2), 20, 1, 1).data);
}
return { bbox: info.bbox, emitted: info.emitted, err: out.err, layer: out.layer && [out.layer.x, out.layer.y, out.layer.w, out.layer.h], edge, inner, status: ed.status, log };
"""

NOT_A_BORDER = """
const ed = await fresh();
await run("select_rect", { doc: window.__mgDoc, x: 500, y: 320, width: 200, height: 150 });
await run("select_recipe", { id: "expand_flux_pro", provider: "magnific" });
const out = await generate(ed);
return { err: out.err, layers: out.layer ? 1 : 0, status: ed.status };
"""

GENERATE_NEW = """
const ed = ednow(window.__mgDoc);
host.shell.activate(ed);
const out = {};
for (const [id, res] of [["mystic", 2048], ["z_image_turbo", 1024]]) {
    await run("select_recipe", { id, provider: "magnific" });
    const t = host.recipe.text;
    if (!t || !t.model) throw new Error(id + ": no text shape on magnific");
    await run("generate_new", { doc: window.__mgDoc, prompt: __TEXTPROMPT__, aspect: "16:9", resolution: res, timeout: 120 });
    out[id] = { model: t.model, size: [ed.width, ed.height], status: ed.status };
}
return out;
"""

REAL_KEY_REFUSED = """
const ed = await fresh();
await window.scumble.keys.set("magnific", __REALKEY__);
const out = {};
try {
    await run("select_recipe", { id: "seedream_5_pro", provider: "magnific" });
    const g = await generate(ed);
    out.generate = g.err || "no error";
    out.layers = g.layer ? 1 : 0;
    await run("select_recipe", { id: "mystic", provider: "magnific" });
    try { await run("generate_new", { doc: window.__mgDoc, prompt: __TEXTPROMPT__, aspect: "1:1", resolution: 1024, timeout: 60 }); out.generateNew = "no error"; } catch (err) { out.generateNew = String(err.message || err); }
    await fresh();
    await run("select_recipe", { id: "magnific_precision", provider: "magnific" });
    try { await run("upscale", { doc: window.__mgDoc, scope: "selection", factor: 2, timeout: 60 }); out.upscale = "no error"; } catch (err) { out.upscale = String(err.message || err); }
} finally {
    await window.scumble.keys.set("magnific", __KEY__);
}
return out;
"""

CLEANUP = """
const out = {};
const t = window.__mg;
if (t && t.stored) { await window.scumble.keys.clear("magnific"); out.keyCleared = true; }
for (const d of document.querySelectorAll("dialog[open]")) d.close();
if (t) {
    const s = t.saved;
    // every recipe goes back through selectRecipe first (the window's own view of the providers); selectRecipe writes
    // the settings file without waiting, so the saved settings are written last, after those writes have landed, and
    // openSettings then re-reads the shell's copy
    for (const id of __TOUCHED__) { const want = (s.recipeProviders || {})[id]; if (want) host.shell.selectRecipe(id, want); }
    if (t.recipe && t.recipe.id === s.recipe) host.shell.selectRecipe(t.recipe.id);
    else if (t.recipe) host.setRecipe(t.recipe);
    await wait(800);
    await window.scumble.settings.set({ magnific: s.magnific, recipeProviders: s.recipeProviders, recipe: s.recipe, recipeByMode: s.recipeByMode });
    await shell.openSettings();
    document.getElementById("shell-settings").close();
}
if (window.__mgDoc) { try { await run("close_document", { doc: window.__mgDoc, force: true }); } catch (_) { /* gone */ } }
const k = await window.scumble.keys.list();
out.keyLeft = !!((k.keys || {}).magnific && k.keys.magnific.set);
if (t) {
    if (out.keyLeft) throw new Error("the test key is still stored");
    const now = await window.scumble.settings.get();
    const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
    out.restored = same(now.magnific, t.saved.magnific) && same(now.recipeProviders, t.saved.recipeProviders) && same(now.recipe, t.saved.recipe);
    if (!out.restored) throw new Error("the settings are not back: " + JSON.stringify({ magnific: now.magnific, recipeProviders: now.recipeProviders, recipe: now.recipe }));
}
window.__mg = null; window.__mgDoc = null;
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
        raise Exception("tools/magnific_test.js (rc %d):\n    %s" % (r.returncode, shown))
    return {"checks": tail.count("[ok]")}


def log_detail(entry):
    d = entry.get("detail")
    if isinstance(d, dict):
        return d
    try:
        return json.loads(d) if d else {}
    except ValueError:
        return {}


def ok_info(res, verb):
    ok = [e for e in res.get("log") or [] if e.get("level") == "info" and ("Magnific %s ok" % verb) in str(e.get("message"))]
    if len(ok) != 1:
        raise Exception("expected one 'Magnific %s ok' line in the log, found %s" % (verb, [e.get("message") for e in res.get("log") or []]))
    return log_detail(ok[0]).get("info") or {}


def check_key_absent(texts, what):
    for t in texts:
        if KEY in str(t) or REAL_KEY in str(t):
            raise Exception("a key is in %s" % what)


def task_calls(snap, route):
    """The POST, the status reads, the downloads and anything else of one run."""
    out = {"post": [], "status": [], "asset": [], "other": []}
    for cl in snap["calls"]:
        p = cl["path"].split("?")[0]
        if cl["method"] == "POST" and p == "/v1/ai/" + route:
            out["post"].append(cl)
        elif cl["method"] == "GET" and p.startswith("/v1/ai/" + route + "/"):
            out["status"].append(cl)
        elif cl["method"] == "GET" and p.startswith("/asset/"):
            out["asset"].append(cl)
        else:
            out["other"].append(cl)
    return out


def check_run(mock, route):
    """One task: one POST with the key, status reads with the key, one download without it, nothing else."""
    q = task_calls(mock.snapshot(), route)
    if len(q["post"]) != 1 or not q["status"] or len(q["asset"]) != 1 or q["other"]:
        raise Exception("the mock saw %s" % {k: [(c["method"], c["path"][:80]) for c in v] for k, v in q.items() if v})
    for cl in q["post"] + q["status"]:
        if cl["headers"].get("x-magnific-api-key") != KEY or "authorization" in cl["headers"]:
            raise Exception("a call without the test key: %s" % cl["path"])
    if "x-magnific-api-key" in q["asset"][0]["headers"]:
        raise Exception("the download carried the key")
    return q


def ratio_of(value):
    m = re.search(r"_(\d+)_(\d+)$", str(value or ""))
    return int(m.group(1)) / int(m.group(2)) if m else None


async def run_all(c):
    mock = Mock().start()
    print("mock Magnific on", mock.url)
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

        await c.eval("(async () => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); window.__mgCmds = await import('./commands.js'); window.__mgHost = (await import('./editor/host.js')).host; window.__mgShell = await import('./shell.js'); return 1; })()")

        async def setup():
            done("setup", await ev(SETUP, __MOCK__=json.dumps(mock.url)))
        if not await step("setup", setup):
            raise Stop()

        async def lists():
            done("lists_before_and_after_the_key", await ev(LISTS, __EDITS__=json.dumps(sorted(VARIANTS + NEW)), __UPSCALERS__=json.dumps(UPSCALERS),
                                                              __NEW__=json.dumps(NEW), __TEXT__=json.dumps(TEXT), __KEY__=json.dumps(KEY)))
        if not await step("lists_before_and_after_the_key", lists):
            raise Stop()

        async def seedream():
            mock.reset()
            res = await ev(SEEDREAM_EDIT)
            if res["err"] or not res["layer"]:
                raise Exception("no result layer: %s / %s" % (res["err"], res["status"]))
            q = check_run(mock, "text-to-image/seedream-v5-pro-edit")
            body, pics = q["post"][0]["json"], q["post"][0]["pictures"]
            want = ratio_of(body.get("aspect_ratio"))
            x, y, w, h = res["bbox"]
            if not res["aspect"] or not want or abs(w / h / want - 1) > 0.01:
                raise Exception("the crop %s against the preset %s (info.aspect %s)" % (res["bbox"], body.get("aspect_ratio"), res["aspect"]))
            pw, ph = pics[0]["dims"]
            if pics[0]["field"] != "reference_images" or abs(pw / ph / want - 1) > 0.01:
                raise Exception("the picture sent %s against %s" % (pics[0], body.get("aspect_ratio")))
            if not str(body.get("prompt", "")).startswith("Edit the first image") or "mask" in body:
                raise Exception("the body: %s" % {k: v for k, v in body.items() if k != "reference_images"})
            px, py, pw2, ph2 = res["plain"]
            if not (x <= px and y <= py and x + w >= px + pw2 and y + h >= py + ph2):
                raise Exception("the crop %s does not hold the plain crop %s" % (res["bbox"], res["plain"]))
            lx, ly, lw, lh = res["layer"]
            if not (lx <= 400 and ly <= 250 and lx + lw >= 820 and ly + lh >= 530):
                raise Exception("the result layer %s does not cover the selection" % res["layer"])
            info = ok_info(res, "edit")
            if info.get("fit") != "stretch" or info.get("route") != "text-to-image/seedream-v5-pro-edit":
                raise Exception("the log line's info: %s" % info)
            check_key_absent([json.dumps(res["log"]), res["status"]], "the log or the status line")
            done("an_instruction_edit_widens_the_crop_to_a_preset", {"crop": res["bbox"], "plain": res["plain"], "preset": body["aspect_ratio"], "sent": [pw, ph], "layer": res["layer"]})
        await step("an_instruction_edit_widens_the_crop_to_a_preset", seedream)

        async def ideogram():
            mock.reset()
            res = await ev(IDEOGRAM)
            if res["err"] or not res["layer"]:
                raise Exception("no result layer: %s / %s" % (res["err"], res["status"]))
            q = check_run(mock, "ideogram-image-edit")
            body = q["post"][0]["json"]
            pics = {p["field"]: p for p in q["post"][0]["pictures"]}
            ew, eh = res["emitted"]
            if "image" not in pics or "mask" not in pics or pics["mask"]["dims"] != pics["image"]["dims"] or pics["mask"]["dims"] != [ew, eh] or pics["mask"]["format"] != "png":
                raise Exception("the pictures %s, the emitted crop %dx%d" % (list(pics.values()), ew, eh))
            if pics["mask"].get("centre") != 0 or pics["mask"].get("corner") != 255:
                raise Exception("the mask is not inverted (black = edit): centre %s, corner %s" % (pics["mask"].get("centre"), pics["mask"].get("corner")))
            if body.get("prompt") != PROMPT or body.get("magic_prompt") != "OFF" or body.get("rendering_speed") != "DEFAULT":
                raise Exception("the body: %s" % {k: v for k, v in body.items() if k not in ("image", "mask")})
            info = ok_info(res, "edit")
            if info.get("fit") != "stretch":
                raise Exception("the answer is not stretched: %s" % info)
            done("ideogram_inpaint_sends_an_inverted_mask", {"crop": [ew, eh], "mask": pics["mask"], "fit": info.get("fit")})
        await step("ideogram_inpaint_sends_an_inverted_mask", ideogram)

        async def expand():
            mock.reset()
            res = await ev(EXPAND)
            if res["err"] or not res["layer"]:
                raise Exception("no result layer: %s / %s" % (res["err"], res["status"]))
            q = check_run(mock, "image-expand/flux-pro")
            body = q["post"][0]["json"]
            pics = q["post"][0]["pictures"]
            ew, eh = res["emitted"]
            if [p["field"] for p in pics] != ["image"] or "mask" in body or any(k not in body for k in ("left", "right", "top", "bottom")):
                raise Exception("the body: %s, pictures %s" % ({k: v for k, v in body.items() if k != "image"}, pics))
            kw, kh = pics[0]["dims"]
            if kw + body["left"] + body["right"] != ew or kh + body["top"] + body["bottom"] != eh:
                raise Exception("kept %dx%d and margins %s do not make the emitted %dx%d" % (kw, kh, {k: body[k] for k in ("left", "right", "top", "bottom")}, ew, eh))
            # the kept part is the old picture less the band the auto feather grows the selection by (the model redraws
            # that band too, and the stitch blends it), centred
            if not (0.5 < kw / ew <= 640 / 768 + 0.01 and 0.5 < kh / eh <= 480 / 608 + 0.01) or abs(body["left"] - body["right"]) > 2 or abs(body["top"] - body["bottom"]) > 2:
                raise Exception("the kept part %dx%d of %dx%d is not the old picture: %s" % (kw, kh, ew, eh, {k: v for k, v in body.items() if k != "image"}))
            if res["layer"] != [0, 0, 768, 608]:
                raise Exception("the result layer %s is not the whole canvas" % res["layer"])
            e = res["edge"] or [0, 0, 0, 0]
            if not (e[3] > 0 and e[0] > 180 and e[1] < 80 and e[2] > 180):
                raise Exception("the result's right edge %s is not the marker: the answer was centre-cropped, not stretched" % e)
            info = ok_info(res, "edit")
            if info.get("fit") != "stretch" or info.get("margins") != {k: body[k] for k in ("left", "top", "right", "bottom")}:
                raise Exception("the log line's info: %s" % info)
            done("image_expand_fills_the_border_after_extend_canvas", {"emitted": [ew, eh], "kept": [kw, kh], "margins": info.get("margins"), "edge": e, "answer": [info.get("width"), info.get("height")]})
        await step("image_expand_fills_the_border_after_extend_canvas", expand)

        async def not_a_border():
            mock.reset()
            res = await ev(NOT_A_BORDER)
            calls = mock.snapshot()["calls"]
            words = res["err"] + " " + res["status"]
            if "not a border" not in words or "Extend canvas" not in words or res["layers"] or calls:
                raise Exception("not refused: %s, the mock saw %d calls" % (json.dumps(res)[:400], len(calls)))
            done("image_expand_refuses_a_selection_that_is_not_a_border", {"error": (res["err"] or res["status"])[:220], "requests": 0})
        await step("image_expand_refuses_a_selection_that_is_not_a_border", not_a_border)

        async def generate_new():
            mock.reset()
            res = await ev(GENERATE_NEW, __TEXTPROMPT__=json.dumps(TEXT_PROMPT))
            posts = [cl for cl in mock.snapshot()["calls"] if cl["method"] == "POST"]
            if len(posts) != 2 or posts[0]["path"] != "/v1/ai/mystic" or posts[1]["path"] != "/v1/ai/text-to-image/z-image":
                raise Exception("the POSTs: %s" % [cl["path"] for cl in posts])
            m, z = posts[0]["json"], posts[1]["json"]
            if m.get("resolution") != "2k" or m.get("aspect_ratio") != "widescreen_16_9" or m.get("prompt") != TEXT_PROMPT or "seed" in m or posts[0]["pictures"]:
                raise Exception("the Mystic body: %s" % m)
            if res["mystic"]["size"] != [2048, 1152]:
                raise Exception("the base after Mystic is %s, not the answer's 2048 x 1152" % res["mystic"]["size"])
            if z.get("image_size") != "landscape_16_9" or res["z_image_turbo"]["size"] != [1024, 576]:
                raise Exception("Z-Image: %s, the base %s" % (z, res["z_image_turbo"]["size"]))
            done("generate_new_through_mystic_and_z_image", {"mystic": {k: m.get(k) for k in ("resolution", "aspect_ratio", "model")}, "z_image": z.get("image_size"), "bases": [res["mystic"]["size"], res["z_image_turbo"]["size"]]})
        await step("generate_new_through_mystic_and_z_image", generate_new)

        async def real_key():
            mock.reset()
            res = await ev(REAL_KEY_REFUSED, __REALKEY__=json.dumps(REAL_KEY), __KEY__=json.dumps(KEY), __TEXTPROMPT__=json.dumps(TEXT_PROMPT))
            calls = mock.snapshot()["calls"]
            bad = [k for k in ("generate", "generateNew", "upscale") if "test address" not in res.get(k, "")]
            if bad or res.get("layers") or calls:
                raise Exception("not refused: %s, the mock saw %d calls" % (res, len(calls)))
            check_key_absent([res.get(k) for k in ("generate", "generateNew", "upscale")], "the messages")
            done("a_real_key_never_reaches_the_mock", {"generate": res["generate"][:120], "requests": 0})
        await step("a_real_key_never_reaches_the_mock", real_key)

        # every call of the run: the test key only, on /v1/ai/ only, never on a download
        seen = mock.all_calls()
        wrong = [cl["path"] for cl in seen if cl["headers"].get("x-magnific-api-key") not in (None, KEY)]
        keyed_off_api = [cl["path"] for cl in seen if cl["headers"].get("x-magnific-api-key") and not cl["path"].startswith("/v1/ai/")]
        unkeyed_api = [cl["path"] for cl in seen if cl["path"].startswith("/v1/ai/") and not cl["headers"].get("x-magnific-api-key")]
        if wrong or keyed_off_api or unkeyed_api or not seen:
            ok = False
            print("[FAIL] no_key_off_the_api: another key %s, keyed off the API %s, the API without it %s" % (wrong[:3], keyed_off_api[:3], unkeyed_api[:3]))
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
