"""BytePlus ModelArk end to end without a key: the adapter in plain Node, then the app against tools/ark_mock.py.

No ComfyUI and no BytePlus account. The first step runs tools/ark_test.js (the adapter against a scripted fetch)
when that file exists, and is skipped, not failed, when it does not. The rest drives the running app over CDP with
settings.ark.base pointed at the mock on 127.0.0.1 (the only base besides the two regional hosts that the adapter
accepts) and a test key stored under the name "ark". The key starts with "test-": the adapter sends such a key only
to a loopback base, and any other key never to one.

- ToAPIs stays first in Settings › API providers, ModelArk has its row with "get a key" and no balance query, the
  two Seedream 5.0 recipes list "ark" right after "toapis" and keep fal as their default, Seedream 5.5 lists "ark"
  alone as its default, and the provider select says "(no key)" until a key is stored;
- Seedream 5.0 Lite inpaints: one POST /api/v3/images/generations with the crop as image[0] (a PNG data URL of the
  emitted size), size "WxH" in the crop's shape inside the model's pixel range (at least 3,686,400), watermark false,
  response_format b64_json, output_format png, no mask, the key as a Bearer;
- the Region row reaches the adapter: set to eu-west, the run still goes to the test base and the log says eu-west;
- Seedream 5.0 Pro inpaints with its own model id and a size inside [921,600, 4,624,220];
- Generate new asks for 2560x1440 without a picture and gets a 16:9 base of that size;
- Seedream 5.5 (early access) inpaints with its own model id, a size inside [921,600, 4,624,220] and its Background
  row: on Auto no `background` goes and the layer is opaque; set to Transparent, `background: "transparent"` and png
  go, the mock answers a disc on a transparent ground, and the result layer keeps that alpha inside the selection
  (opaque in the middle, transparent beside the disc) and the status line says cut-out; Generate new with
  `background: "transparent"` gets a base with the same alpha;
- a QuotaExceeded puts "free quota" and the server's words in the status line and the log, never the key, and is
  not sent again; a ModelAccountIpmRateLimitExceeded is sent once more after Retry-After; a ModelNotOpen says the
  model is not activated;
- a real-looking key is never sent to the test address (edit and Generate new refuse, the mock sees nothing);
- Split into layers (split_layers) against the mock's base and three layers: the request's shape, the layers above the
  existing ones in one group, bottom to top by z_index, named (duplicates numbered), placed from their boxes, baked to
  their size in the document, one undo step for all, kept by a saved and reopened document; the tier below the picture's
  size says "lower resolution"; a layer as the source; a failing answer, an answer with a broken picture and a Cancel
  leave nothing behind; a picture out of range and a model without a layer mode are refused before anything is sent.

A profile that already holds a ModelArk key is refused, never overwritten; the test key, settings.ark, the
remembered providers and the selected recipe are put back at the end whatever happens.

    python tools/ark_test.py

Start the app first (with --no-comfy: a result is uploaded into the mirror and would be forwarded to a connected
ComfyUI): bash tools/run_gates.sh <label> --offline --tiles on ark
"""
import asyncio
import io
import json
import os
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402
from ark_mock import PATH, Mock  # noqa: E402
from PIL import Image  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE_TEST = os.path.join(ROOT, "tools", "ark_test.js")
KEY = "test-ark-gate-0123456789"
REAL_KEY = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0"   # the shape of a ModelArk API key (a UUID); never a real one
LABEL = "BytePlus ModelArk (Seedream)"
KEY_URL = "https://ai.byteplus.com/ark/region:ap-southeast-1/apiKey"
LITE, PRO, S55 = "seedream-5-0-260128", "dola-seedream-5-0-pro-260628", "dola-seedream-5-5-261028"
LITE_PIXELS, PRO_PIXELS = (3686400, 16777216), (921600, 4624220)
S55_PIXELS = PRO_PIXELS   # Seedream 5.5's range is 5.0 pro's (BytePlus's preview docs, 2026-11-08)
BODY_KEYS = {"model", "prompt", "image", "size", "watermark", "response_format", "output_format"}
# refs.instruction under the Seedream recipes' refs.name "Image {n}": the crop is Image 1
EDIT_PREFIX = "Edit Image 1 and keep its size and framing."
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
if (JSON.stringify(ids) !== JSON.stringify(["seedream_5_5", "seedream_5_lite", "seedream_5_pro"])) throw new Error("recipes that list ark: " + ids.join(", "));
// Seedream 5.5 (early access) runs on ModelArk alone; the 5.0 recipes keep fal as their default
const ONLY = "seedream_5_5";
const order = {};
for (const r of withArk) {
    const raw = host.shell.recipes().find((x) => x.id === r.id);
    if (r.id === ONLY) {
        if (JSON.stringify(r.providers) !== JSON.stringify(["ark"]) || r.provider !== "ark" || raw.default !== "ark") throw new Error(r.id + ": providers " + r.providers.join(", ") + ", provider " + r.provider + ", the file's default " + raw.default);
        if (r.background !== true) throw new Error(r.id + ": list_recipes says background " + r.background);
    } else {
        const i = r.providers.indexOf("toapis");
        if (i < 0 || r.providers[i + 1] !== "ark") throw new Error(r.id + ": ark does not come right after toapis: " + r.providers.join(", "));
        if (!remembered[r.id] && r.provider !== "fal") throw new Error(r.id + ": the default moved to " + r.provider);
        if (raw.default !== "fal") throw new Error(r.id + ": the file's default is " + raw.default);
    }
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
        if (id === ONLY ? JSON.stringify(values) !== JSON.stringify(["ark"]) : (i < 0 || values[i - 1] !== "toapis")) throw new Error(id + ": the select's options are " + values.join(", "));
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

# select_recipe through the commands core, the settings rows through set_settings (__VALUES__, by label; null: leave
# them), then a Generate on the document's selection; the size the crop is emitted at is computed beforehand by the
# same function the run uses. __FLAT__: no context and no feather for the run (put back after it), so the result layer
# is exactly the selection and its alpha at a point says what the answer's alpha was there (tools/transparent_test.py);
# `alpha` samples the result layer at the selection's middle and 20 px inside its left edge, on the middle row
EDIT = """
const ed = await fresh();
const sel = await run("select_recipe", { id: __ID__, provider: "ark" });
const r = host.recipe;
if (!r || r.id !== __ID__ || r.provider !== "ark" || r.model !== __MODEL__) throw new Error("select_recipe gave " + JSON.stringify(sel) + " / " + (r && [r.id, r.provider, r.model].join(" ")));
const values = __VALUES__;
if (values) await run("set_settings", { doc: window.__arkDoc, values });
const targets = host.settingTargets(ed).map((t) => ({ index: t.index, label: t.node.title, key: t.inputName, choices: Array.isArray(t.spec && t.spec[0]) ? t.spec[0] : null, value: (ed.settings[String(t.index)] || {}).value }));
const flat = __FLAT__;
const keep = flat ? { params: { ...host.nodeParams }, crop: { ...ed.cropSettings } } : null;
let info, params, mark, out, before;
try {
    if (flat) { host.nodeParams.padding = 0; host.nodeParams.feather = 0; ed.cropSettings.context = 0; ed.cropSettings.feather = 0; }
    const stitch = await import("./editor/stitch.js");
    info = stitch.prepareCrop(ed, host.nodeParams, host.cropLimits()).info;
    params = host.providerParams(ed);
    mark = await logMark();
    before = ed.layers.length;
    out = await run("generate", { doc: window.__arkDoc, timeout: 120 });
} finally {
    if (keep) { Object.assign(host.nodeParams, keep.params); Object.assign(ed.cropSettings, keep.crop); }
}
if (ed.layers.length !== before + 1) throw new Error("no result layer: " + ed.status);
const log = (await logSince(mark)).filter((e) => e.source === "ark");
const l = ed.layers.find((x) => out && out.layer && x.id === out.layer.id) || ed.layers[ed.layers.length - 1];
const at = (dx, dy) => {
    const px = l.px;
    const lx = Math.min(px.width - 1, Math.max(0, Math.floor((dx - l.x) * px.width / l.w)));
    const ly = Math.min(px.height - 1, Math.max(0, Math.floor((dy - l.y) * px.height / l.h)));
    return px.readRect(lx, ly, 1, 1).data[3];
};
const [sx, sy, sw, sh] = info.bbox;
const alpha = { middle: at(sx + sw / 2, sy + sh / 2), beside: at(sx + 20, sy + sh / 2), layer: [l.x, l.y, l.w, l.h], disc: Math.min(l.w, l.h) / 4, besideFromMiddle: sw / 2 - 20 };
return { emitted: info.emitted, bbox: info.bbox, input: r.input, limits: r.limits, status: ed.status, params, targets, log, layer: out && out.layer ? [out.layer.w, out.layer.h] : null, alpha };
"""

BACKGROUND_BACK = """
const ed = ednow(window.__arkDoc);
await run("set_settings", { doc: window.__arkDoc, values: { Background: "auto" } });
return { background: host.providerParams(ed).background };
"""

REGION_BACK = """
const ed = ednow(window.__arkDoc);
await run("set_settings", { doc: window.__arkDoc, values: { Region: "ap-southeast" } });
return { region: host.providerParams(ed).region };
"""

# __BG__: generate_new's background (null: none); `alpha` reads the new base's corner and middle
GENERATE_NEW = """
const ed = ednow(window.__arkDoc);
host.shell.activate(ed);
await run("select_recipe", { id: __ID__, provider: "ark" });
const t = host.recipe.text;
if (!t || t.model !== __MODEL__) throw new Error("the ModelArk variant's text shape: " + JSON.stringify(t));
const mark = await logMark();
const bg = __BG__;
const out = await run("generate_new", { doc: window.__arkDoc, prompt: __TEXT__, aspect: "16:9", resolution: __LONG__, timeout: 120, ...(bg ? { background: bg } : {}) });
const log = (await logSince(mark)).filter((e) => e.source === "ark");
const c = ed.flattenToCanvas({ forRun: true });
const g = c.getContext("2d", { willReadFrequently: true });
const alpha = { corner: g.getImageData(2, 2, 1, 1).data[3], middle: g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data[3] };
return { size: [ed.width, ed.height], model: out.model, transparent: !!out.transparent, status: ed.status, sizes: t.sizes, log, alpha };
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

# one split on the document: what it added, what it left alone, where the undo step stands. __SETUP__: runs first
SPLIT = """
const ed = ednow(window.__arkDoc);
host.shell.activate(ed);
const W = __W__, H = __H__;
if (ed.width !== W || ed.height !== H) await run("new_canvas", { doc: window.__arkDoc, width: W, height: H, color: "#708090" });
__SETUP__
const keep = (l) => [l.id, l.name, l.x, l.y, l.w, l.h, l.visible, l.opacity, l.group || null];
const before = ed.layers.map(keep), g0 = ed.groups.length, u0 = ed.undo.length, ids = new Set(ed.layers.map((l) => l.id));
const mark = await logMark();
let out = null, err = "";
try { out = await run("split_layers", { doc: window.__arkDoc, ...__ARGS__ }); } catch (e) { err = String(e.message || e); }
const added = ed.layers.filter((l) => !ids.has(l.id));
const alphaAt = (l, fx, fy) => l.px.readRect(Math.floor(l.px.width * fx), Math.floor(l.px.height * fy), 1, 1).data[3];
const stack = ed.layers.map((l) => l.id);
const log = (await logSince(mark)).filter((e) => e.source === "ark");
const flat = (() => { const c = ed.flattenToCanvas({ forRun: true }); const g = c.getContext("2d", { willReadFrequently: true }); return [[150, 150], [1000, 700]].map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data)); })();
return {
    flatBefore: window.__splitFlat || null, flatNow: flat, err, out, status: ed.status, kind: ed.statusKind, undoDelta: ed.undo.length - u0, groupDelta: ed.groups.length - g0, undoLabel: (ed.undo[ed.undo.length - 1] || {}).label || null,
    old: JSON.stringify(ed.layers.filter((l) => ids.has(l.id)).map(keep)) === JSON.stringify(before), oldCount: before.length, onTop: added.length ? stack.slice(-added.length).join() === added.map((l) => l.id).join() : null,
    added: added.map((l) => ({ id: l.id, name: l.name, x: l.x, y: l.y, w: l.w, h: l.h, pw: l.px.width, ph: l.px.height, kind: l.kind, group: l.group, ref: !!l.ref, middle: alphaAt(l, 0.5, 0.5), corner: alphaAt(l, 0.02, 0.02) })),
    groups: ed.groups.map((g) => ({ id: g.id, name: g.name })), active: ed.activeLayerId, picture: [ed.width, ed.height], docName: host.documentName(ed), log: log.map((e) => e.message), logDetail: log.map((e) => e.detail),
};
"""

SPLIT_UNDO_REDO = """
const ed = ednow(window.__arkDoc);
const n0 = ed.layers.length, g0 = ed.groups.length;
await run("undo", { doc: window.__arkDoc });
const undone = { layers: ed.layers.length, groups: ed.groups.length, names: ed.layers.map((l) => l.name) };
await run("redo", { doc: window.__arkDoc });
return { n0, g0, undone, redone: { layers: ed.layers.length, groups: ed.groups.length, names: ed.layers.slice(-4).map((l) => l.name) } };
"""

SPLIT_SAVE = """
const ed = ednow(window.__arkDoc);
const want = ed.layers.slice(-4).map((l) => [l.name, l.x, l.y, l.w, l.h]);
const pixelsOf = (e) => e.layers.slice(-4).map((l) => [[0.5, 0.5], [0.02, 0.02], [0.3, 0.6]].map(([fx, fy]) => Array.from(l.px.readRect(Math.floor(l.px.width * fx), Math.floor(l.px.height * fy), 1, 1).data)));
const wantPixels = pixelsOf(ed);
const wantGroup = ed.groups[ed.groups.length - 1].name;
await run("save_document", { doc: window.__arkDoc, path: __PATH__, copy: true });
const o = await run("open_document", { path: __PATH__ });
const doc = o.id !== undefined ? o.id : o.doc;
let same = null;
try {
    const ed2 = ednow(doc);
    const deadline = Date.now() + 20000;
    while ((ed2._loading || ed2.layers.length < ed.layers.length) && Date.now() < deadline) await wait(100);
    const got = ed2.layers.slice(-4).map((l) => [l.name, l.x, l.y, l.w, l.h]);
    same = { got, want, group: ed2.groups.map((g) => g.name), wantGroup, count: [ed2.layers.length, ed.layers.length], baked: ed2.layers.slice(-4).map((l) => l.px.width === l.w && l.px.height === l.h), gotPixels: pixelsOf(ed2), wantPixels, sameGroup: new Set(ed2.layers.slice(-4).map((l) => l.group)).size };
} finally {
    await run("close_document", { doc, force: true });
    host.shell.activate(ed);
}
return same;
"""

SPLIT_DIALOG = """
const ed = ednow(window.__arkDoc);
host.shell.activate(ed);
const { openSplitDialog } = await import("./splitdialog.js");
const n0 = ed.layers.length;
const opening = openSplitDialog(ed);
await wait(50);
const box = ed.askOpen && ed.askOpen.querySelector(".ipc-askbox");
if (!box) throw new Error("the dialog did not open: " + ed.status);
const q = (k) => box.querySelector(`[data-key="${k}"]`);
const prompt = box.querySelector('input[type="text"]'), sw = box.querySelector('input[type="checkbox"]');
const line = () => box.querySelector(".ipc-asknote").textContent;
const pick = (id) => { q("model").value = id; q("model").dispatchEvent(new Event("change")); };
pick("seedream_5_pro");
const pro = { count: q("count").value, off: q("count").disabled, hidden: sw.closest("label").hidden, line: line() };
pick("seedream_5_5");
const s55 = { count: q("count").value, off: q("count").disabled, hidden: sw.closest("label").hidden, line: line() };
q("count").value = "5"; q("count").dispatchEvent(new Event("input"));
const five = line();
prompt.value = "the dog"; sw.checked = true;
box.querySelector(".ipc-primary").click();
await opening;
const added = ed.layers.length - n0;
// (dialog-empty-count) the bug: an emptied box asks for the model's most layers
const again = openSplitDialog(ed);
await wait(50);
const box2 = ed.askOpen.querySelector(".ipc-askbox");
const m2 = box2.querySelector('[data-key="model"]');
m2.value = "seedream_5_5"; m2.dispatchEvent(new Event("change"));
const c2 = box2.querySelector('[data-key="count"]');
c2.value = ""; c2.dispatchEvent(new Event("input"));
const emptied = box2.querySelector(".ipc-asknote").textContent;
box2.querySelector(".ipc-primary").click();
await again;
return { pro, s55, five, added, emptied, status: ed.status };
"""

SPLIT_DIALOG_CANCEL = """
const ed = ednow(window.__arkDoc);
const { openSplitDialog } = await import("./splitdialog.js");
const n0 = ed.layers.length;
const opening = openSplitDialog(ed);
await wait(50);
ed.askOpen.querySelector(".ipc-askrow .ipc-ib:not(.ipc-primary)").click();
await opening;
return { added: ed.layers.length - n0, status: ed.status };
"""

SPLIT_NO_KEY = """
const ed = ednow(window.__arkDoc);
const n0 = ed.layers.length;
await shell.openSettings(); document.getElementById("shell-settings").close();
let msg = "";
try { await run("split_layers", { doc: window.__arkDoc, recipe: "seedream_5_5" }); } catch (e) { msg = String(e.message || e); }
return { msg, added: ed.layers.length - n0 };
"""

# a layer of known pixels: the left half red (the layer's own pixels), the right half empty, a mask over a strip of the left
SPLIT_LAYER_SETUP = """
const made = await run('add_paint_layer', { doc: window.__arkDoc });
const paint = ed.layers.find((l) => l.id === made.id);
const red = new Uint8ClampedArray(600 * 800 * 4);
for (let i = 0; i < red.length; i += 4) { red[i] = 200; red[i + 1] = 30; red[i + 2] = 30; red[i + 3] = 255; }
paint.px.writeRect(new ImageData(red, 600, 800), 0, 0);
ed.markLayerChanged(paint);
await run('set_layer', { doc: window.__arkDoc, layer: made.id, x: 50, y: 40, w: 700, h: 500, name: 'Portrait' });
await run('select_rect', { doc: window.__arkDoc, x: 50, y: 390, width: 700, height: 150 });
await run('set_mask', { doc: window.__arkDoc, layer: made.id, op: 'hide_selection' });
await run('select_none', { doc: window.__arkDoc });
await run('set_active_layer', { doc: window.__arkDoc, layer: made.id });
"""

# a green patch on a paint layer, the marker the visible picture has to carry
SPLIT_PICTURE_SETUP = """
await run('add_paint_layer', { doc: window.__arkDoc });
const mark0 = ed.layers[ed.layers.length - 1];
const green = new Uint8ClampedArray(100 * 100 * 4);
for (let i = 0; i < green.length; i += 4) { green[i] = 20; green[i + 1] = 220; green[i + 2] = 60; green[i + 3] = 255; }
mark0.px.writeRect(new ImageData(green, 100, 100), 100, 100);
ed.markLayerChanged(mark0);
ed.draw();
window.__splitFlat = (() => { const c = ed.flattenToCanvas({ forRun: true }); const g = c.getContext("2d", { willReadFrequently: true }); return [[150, 150], [1000, 700]].map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data)); })();
"""

# (land-1) the bug: flattening before relight's full maps are in. The stand-in for a march still going: relightSettled ends 150 ms later
SPLIT_RELIGHT = """
const ed = ednow(window.__arkDoc);
host.shell.activate(ed);
let settled = false, flatSawSettled = null;
const realSettled = ed.relightSettled, realFlat = ed.flattenToCanvas;
ed.relightSettled = async function (...a) { await wait(150); const r = await realSettled.apply(ed, a); settled = true; return r; };
ed.flattenToCanvas = function (o) { if (o && o.forRun && flatSawSettled === null) flatSawSettled = settled; return realFlat.call(ed, o); };
try { await run("split_layers", { doc: window.__arkDoc, recipe: "seedream_5_5", timeout: 60 }); }
finally { delete ed.relightSettled; delete ed.flattenToCanvas; }
return { flatSawSettled };
"""

# (land-4) the bug: the landing cancels a transform in progress on one of the user's layers
SPLIT_PENDING = """
const ed = ednow(window.__arkDoc);
host.shell.activate(ed);
const p0 = await run('add_paint_layer', { doc: window.__arkDoc });
await run('set_active_layer', { doc: window.__arkDoc, layer: p0.id });
ed.startPending('rotate');
const had = ed.pending && ed.pending.layer && ed.pending.layer.id;
const n0 = ed.layers.length;
let err = "";
try { await run("split_layers", { doc: window.__arkDoc, recipe: "seedream_5_5", timeout: 60 }); } catch (e) { err = String(e.message || e); }
const still = ed.pending && ed.pending.layer && ed.pending.layer.id;
const active = ed.activeLayerId;
if (ed.pending) ed.cancelPending();
return { had, still, active, id: p0.id, added: ed.layers.length - n0, err };
"""

# (mcp-timeout-during-landing) the bug: the command's timeout still fires after the answer is in; the landing is held 6 s, the timeout is 5 s
SPLIT_SLOW_LANDING = """
const ed = ednow(window.__arkDoc);
host.shell.activate(ed);
const n0 = ed.layers.length;
const real = host.uploadResult;
let first = true;
host.uploadResult = async function (...a) { if (first) { first = false; await wait(6000); } return real.apply(host, a); };
let err = "";
try { await run("split_layers", { doc: window.__arkDoc, recipe: "seedream_5_5", timeout: 5 }); } catch (e) { err = String(e.message || e); }
finally { host.uploadResult = real; }
return { err, added: ed.layers.length - n0 };
"""

# (land-5) the bug: one rebuild of the layer list per new layer
SPLIT_RENDERS = """
const ed = ednow(window.__arkDoc);
host.shell.activate(ed);
const real = ed.renderLayers;
let renders = 0;
ed.renderLayers = function (...a) { renders++; return real.apply(ed, a); };
const n0 = ed.layers.length;
try { await run("split_layers", { doc: window.__arkDoc, recipe: "seedream_5_5", timeout: 60 }); }
finally { delete ed.renderLayers; }
return { renders, added: ed.layers.length - n0 };
"""

SPLIT_GONE = """
const ed = ednow(window.__arkDoc);
host.shell.activate(ed);
const n0 = ed.layers.length;
const out = await run("split_layers", { doc: window.__arkDoc, recipe: "seedream_5_5", count: 40, prompt: "MOCK_GONE", timeout: 90 });
return { added: ed.layers.length - n0, leftOut: out.left_out, names: out.layers.map((l) => l.name), status: ed.status, kind: ed.statusKind };
"""

SPLIT_CANCEL = """
const ed = ednow(window.__arkDoc);
host.shell.activate(ed);
const n0 = ed.layers.length, g0 = ed.groups.length, u0 = ed.undo.length;
let msg = "";
const p = run("split_layers", { doc: window.__arkDoc, prompt: "MOCK_SLOW and stop", timeout: 60 }).catch((e) => { msg = String(e.message || e); });
await wait(900);
const c = await run("cancel_run", { doc: window.__arkDoc });
await p;
return { msg, status: ed.status, cancelled: (c.cancelled || []).length, layers: ed.layers.length - n0, groups: ed.groups.length - g0, undo: ed.undo.length - u0, pending: !!ed.providerPending };
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


def check_edit(mock, res, model, pixels, region, background=None):
    """One POST with the crop as image[0] and the request shape of ark.js; the log line names the region.
    `background`: the value the body must carry (None: the body has no such field)."""
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
    if b.get("background") != background:
        raise Exception("background %r, wanted %r" % (b.get("background"), background))
    extra = sorted(set(b) - BODY_KEYS - {"image_type"} - ({"background"} if background else set()))
    if extra:
        raise Exception("fields ark.js does not send (a mask among them?): %s" % extra)
    prompt = str(b.get("prompt") or "")
    if not prompt.startswith(EDIT_PREFIX) or PROMPT not in prompt:
        raise Exception("the prompt: %s" % prompt[:200])
    # the pictures after the crop are reference images, or the Original ("Image 2 is Image 1 before ...")
    if len(refs) > 1 and "reference image" not in prompt and "before the selected area was filled" not in prompt:
        raise Exception("%d pictures, but the prompt does not say what the others are" % len(refs))
    if posts[0]["auth"] != "Bearer " + KEY:
        raise Exception("the request's Authorization: %r" % posts[0]["auth"])
    if not str(posts[0]["headers"].get("content-type") or "").startswith("application/json"):
        raise Exception("Content-Type %r" % posts[0]["headers"].get("content-type"))
    entry, info = ok_entry(res, "edit")
    if info.get("region") != region or info.get("size") != b["size"] or info.get("model") != model or info.get("background") != background:
        raise Exception("the log line's info: %s (wanted region %s, size %s, background %s)" % (info, region, b["size"], background))
    check_key_absent([json.dumps(res["log"]), res["status"]], "the log or the status line")
    return {"crop": [ew, eh], "size": b["size"], "same_as_crop": [w, h] == [ew, eh], "pictures": len(refs), "region": info.get("region"),
            "params": res["params"], "log": entry.get("message"), "status": res["status"][:120]}


def check_text(mock, res, want_size, model=LITE, background=None):
    snap = mock.snapshot()
    posts = image_posts(snap)
    if len(posts) != 1 or len(snap["calls"]) != 1:
        raise Exception("expected one POST %s, the mock saw %s" % (PATH, [(c["method"], c["path"]) for c in snap["calls"]]))
    b = snap["images"][0]["body"]
    if "image" in b or snap["images"][0]["refs"]:
        raise Exception("a text request carried pictures")
    if b.get("model") != model or b.get("size") != want_size or b.get("prompt") != TEXT_PROMPT:
        raise Exception("the text request: %s" % json.dumps(b))
    if b.get("watermark") is not False or b.get("response_format") != "b64_json" or b.get("output_format") != "png":
        raise Exception("watermark / response_format / output_format: %s" % json.dumps(b))
    if b.get("background") != background:
        raise Exception("background %r, wanted %r" % (b.get("background"), background))
    extra = sorted(set(b) - BODY_KEYS - ({"background"} if background else set()))
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
            res = await ev(EDIT, __ID__=json.dumps("seedream_5_lite"), __MODEL__=json.dumps(LITE), __VALUES__="null", __FLAT__="false")
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
                res = await ev(EDIT, __ID__=json.dumps("seedream_5_lite"), __MODEL__=json.dumps(LITE), __VALUES__=json.dumps({"Region": "eu-west"}), __FLAT__="false")
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
            res = await ev(EDIT, __ID__=json.dumps("seedream_5_pro"), __MODEL__=json.dumps(PRO), __VALUES__="null", __FLAT__="false")
            if res["input"] != "edit" or res["targets"]:
                raise Exception("the Seedream 5.0 Pro variant: input %s, settings %s" % (res["input"], res["targets"]))
            done("edit_on_seedream_5_pro", check_edit(mock, res, PRO, PRO_PIXELS, "ap-southeast"))
        await step("edit_on_seedream_5_pro", pro)

        # Seedream 5.5 (early access): its Background row, Auto then Transparent on the same selection (before the
        # Generate new steps, which leave the document's prompt at theirs), and a transparent Generate new
        def background_row(res):
            rows = [t for t in res["targets"] if t["key"] == "background"]
            if len(res["targets"]) != 1 or len(rows) != 1 or rows[0]["label"] != "Background" or rows[0]["choices"] != ["auto", "transparent", "opaque"]:
                raise Exception("the Seedream 5.5 settings rows: %s" % res["targets"])
            return rows[0]

        async def s55_auto():
            mock.reset()
            res = await ev(EDIT, __ID__=json.dumps("seedream_5_5"), __MODEL__=json.dumps(S55), __VALUES__="null", __FLAT__="true")
            if res["input"] != "edit" or background_row(res)["value"] != "auto":
                raise Exception("the Seedream 5.5 variant: input %s, rows %s" % (res["input"], res["targets"]))
            out = check_edit(mock, res, S55, S55_PIXELS, "ap-southeast")
            a = res["alpha"]
            # the mock echoes the crop (opaque): the layer is opaque inside the selection, at both points
            if a["middle"] < 250 or a["beside"] < 250:
                raise Exception("an Auto run should land opaque inside the selection: %s" % a)
            if "cut-out" in res["status"]:
                raise Exception("an Auto run speaks of a cut-out: %s" % res["status"][:200])
            done("edit_on_seedream_5_5_background_auto", {**out, "alpha": a})
        await step("edit_on_seedream_5_5_background_auto", s55_auto)

        async def s55_transparent():
            mock.reset()
            try:
                res = await ev(EDIT, __ID__=json.dumps("seedream_5_5"), __MODEL__=json.dumps(S55), __VALUES__=json.dumps({"Background": "transparent"}), __FLAT__="true")
            finally:
                back = await ev(BACKGROUND_BACK)
            if res["params"].get("background") != "transparent" or background_row(res)["value"] != "transparent":
                raise Exception("the Background row did not reach the run: %s / %s" % (res["params"], res["targets"]))
            out = check_edit(mock, res, S55, S55_PIXELS, "ap-southeast", background="transparent")
            a = res["alpha"]
            if a["besideFromMiddle"] < 1.3 * a["disc"]:
                raise Exception("the point beside the disc lies on it, the step proves nothing: %s" % a)
            # the answer's own alpha inside the selection: the disc opaque, its ground transparent
            if a["middle"] < 250 or a["beside"] != 0:
                raise Exception("the transparent answer's alpha did not survive the landing: %s" % a)
            if "cut-out on a transparent ground" not in res["status"]:
                raise Exception("the status line says nothing about the cut-out: %s" % res["status"][:220])
            if back.get("background") != "auto":
                raise Exception("the Background row did not go back: %s" % back)
            done("edit_on_seedream_5_5_background_transparent", {**out, "alpha": a})
        await step("edit_on_seedream_5_5_background_transparent", s55_transparent)

        async def text():
            mock.reset()
            res = await ev(GENERATE_NEW, __ID__=json.dumps("seedream_5_lite"), __MODEL__=json.dumps(LITE), __TEXT__=json.dumps(TEXT_PROMPT), __LONG__="2560", __BG__="null")
            done("generate_new_on_ark", {**check_text(mock, res, "2560x1440"), "sizes": res["sizes"]})
        await step("generate_new_on_ark", text)

        async def s55_text():
            mock.reset()
            res = await ev(GENERATE_NEW, __ID__=json.dumps("seedream_5_5"), __MODEL__=json.dumps(S55), __TEXT__=json.dumps(TEXT_PROMPT), __LONG__="1280", __BG__=json.dumps("transparent"))
            out = check_text(mock, res, "1280x720", model=S55, background="transparent")
            a = res["alpha"]
            if not res["transparent"] or a["corner"] != 0 or a["middle"] < 250:
                raise Exception("the new base should be a disc on a transparent ground: transparent %s, alpha %s" % (res["transparent"], a))
            done("generate_new_on_seedream_5_5_transparent", {**out, "sizes": res["sizes"], "alpha": a, "status": res["status"][:160]})
        await step("generate_new_on_seedream_5_5_transparent", s55_text)

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

        # 4. Split into layers
        def split_args(args):
            return json.dumps(args)

        def split_body(mock):
            posts = image_posts(mock.snapshot())
            if len(posts) != 1:
                raise Exception("expected one POST, the mock saw %d" % len(posts))
            return mock.snapshot()["images"][0]

        def expected(rect, base, box):
            sx, sy = rect[2] / base[0], rect[3] / base[1]
            def rnd(v):  # as Math.round
                return int(v + 0.5)
            x, y = rnd(box[0] * sx), rnd(box[1] * sy)
            return [rect[0] + x, rect[1] + y, max(1, rnd(box[2] * sx) - x), max(1, rnd(box[3] * sy) - y)]

        def check_stack(res, rect, base, names):
            """The base, then z 1, 2, 3 of the mock's answer, placed from its boxes and baked to their size."""
            bw, bh = base
            if res["err"]:
                raise Exception("the run failed: %s" % res["err"][:300])
            got = res["added"]
            if [a["name"] for a in got] != names:
                raise Exception("names / order: %s" % [a["name"] for a in got])
            boxes = [[0, 0, bw, bh], [0, 0, bw, bh // 2], [bw // 4, bh // 3, bw // 2, bh * 3 // 4], [bw // 2, bh // 4, bw * 3 // 4, bh // 2]]
            for a, box in zip(got, boxes):
                want = expected(rect, base, box) if box[2:] != [bw, bh] else [rect[0], rect[1], rect[2], rect[3]]
                if [a["x"], a["y"], a["w"], a["h"]] != want:
                    raise Exception("%s at %s, wanted %s" % (a["name"], [a["x"], a["y"], a["w"], a["h"]], want))
                if a["pw"] != a["w"] or a["ph"] != a["h"]:
                    raise Exception("%s is not baked to its size: px %dx%d, layer %dx%d" % (a["name"], a["pw"], a["ph"], a["w"], a["h"]))
                if not a["ref"]:
                    raise Exception("%s has no file in the mirror" % a["name"])
            for a in got[2:]:
                if a["middle"] < 250 or a["corner"] != 0:
                    raise Exception("%s lost its alpha: middle %d, corner %d" % (a["name"], a["middle"], a["corner"]))
            if len({a["group"] for a in got}) != 1 or got[0]["group"] is None or res["groupDelta"] != 1:
                raise Exception("not in one new group: %s (groups added %d)" % ([a["group"] for a in got], res["groupDelta"]))
            if res["undoDelta"] != 1 or res["undoLabel"] != "Split into layers":
                raise Exception("undo steps added %d, label %s" % (res["undoDelta"], res["undoLabel"]))
            if not res["old"] or not res["onTop"]:
                raise Exception("the old layers changed (%s) or the new ones are not on top (%s)" % (res["old"], res["onTop"]))
            if res["active"] != got[-1]["id"]:
                raise Exception("the active layer is not the top new one")

        async def split_first():
            mock.reset()
            res = await ev(SPLIT, __W__="1200", __H__="800", __SETUP__=SPLIT_PICTURE_SETUP, __ARGS__=split_args({"recipe": "seedream_5_5", "timeout": 120}))
            pic = split_body(mock)
            # (source-pixels-never-checked) the bug: a request that carries anything but the flattened picture
            sent = Image.open(io.BytesIO(mock.ref_bytes(0, 0))).convert("RGBA")
            for (x, y), want in zip([(150, 150), (1000, 700)], res["flatBefore"]):
                if any(abs(a - b) > 2 for a, b in zip(sent.getpixel((x, y)), want)):
                    raise Exception("the picture sent at %d, %d is %s, the visible picture %s" % (x, y, sent.getpixel((x, y)), want))
            if not sent.getpixel((150, 150))[1] > 200:
                raise Exception("the green marker is not in the picture sent: %s" % (sent.getpixel((150, 150)),))
            b = pic["body"]
            if b.get("model") != S55 or b.get("layer_decomposition") is not True or b.get("size") != "auto" or "prompt" in b or b.get("image_type") != "str":
                raise Exception("the request: %s" % json.dumps(b)[:500])
            if b.get("layer_decomposition_options") != {"max_images": 16, "text_recognition": False}:
                raise Exception("the options: %s" % b.get("layer_decomposition_options"))
            if pic["refs"][0]["dims"] != [1200, 800] or pic["refs"][0]["mime"] != "image/png":
                raise Exception("the one picture: %s" % pic["refs"])
            check_stack(res, (0, 0, 1200, 800), (1200, 800), ["Base", "Sky", "Dog", "Dog 2"])
            if res["out"]["group"]["name"] != res["docName"]:
                raise Exception("the group's name: %s, the document's %s" % (res["out"]["group"], res["docName"]))
            if "lower resolution" in res["status"] or res["kind"] or "and a base" not in res["status"]:
                raise Exception("the line of a run at the picture's own size: %s (kind %s)" % (res["status"][:200], res["kind"]))
            if res["out"]["scaled_up"] or res["out"]["answered"] != [1200, 800] or res["out"]["layers"][1]["z_index"] != 1 or res["out"]["layers"][1]["description"] != "a sky at z 1":
                raise Exception("the command's answer: %s" % json.dumps(res["out"])[:500])
            details = json.dumps(res["logDetail"])
            if "a dog at z 2" not in details:
                raise Exception("the descriptions are not in the log: %s" % details[:300])
            check_key_absent([json.dumps(res["log"]), res["status"]], "the log or the status line")
            done("split_lands_above_the_existing_layers", {"names": [a["name"] for a in res["added"]], "group": res["out"]["group"]["name"], "status": res["status"][:200]})
        ran_split = await step("split_lands_above_the_existing_layers", split_first)

        async def split_undo():
            res = await ev(SPLIT_UNDO_REDO)
            if res["undone"]["layers"] != res["n0"] - 4 or res["undone"]["groups"] != res["g0"] - 1 or any(n in ("Sky", "Dog", "Dog 2") for n in res["undone"]["names"]):
                raise Exception("one undo: %s" % res)
            if res["redone"]["layers"] != res["n0"] or res["redone"]["groups"] != res["g0"] or res["redone"]["names"] != ["Base", "Sky", "Dog", "Dog 2"]:
                raise Exception("the redo: %s" % res)
            done("one_undo_takes_every_new_layer_back", res["undone"])
        if ran_split:
            await step("one_undo_takes_every_new_layer_back", split_undo)

        async def split_save():
            path = os.path.join(tempfile.mkdtemp(prefix="ark_split_"), "split.scumble")
            res = await ev(SPLIT_SAVE, __PATH__=json.dumps(path))
            if res["got"] != res["want"] or res["count"][0] != res["count"][1] or not all(res["baked"]) or res["sameGroup"] != 1 or res["wantGroup"] not in res["group"]:
                raise Exception("the reopened document: %s" % json.dumps(res)[:600])
            # (reopened-layers-pixels-vacuous) the bug: a stored PNG that is not the baked layer (the raw answer, a blank one)
            for g, w in zip(res["gotPixels"], res["wantPixels"]):
                for a, b in zip(g, w):
                    if any(abs(p - q) > 2 for p, q in zip(a, b)):
                        raise Exception("a reopened layer's pixels: %s, before the save %s" % (g, w))
            if not any(s[3] == 255 for layer in res["gotPixels"][2:] for s in layer) or not any(s[3] == 0 for layer in res["gotPixels"][2:] for s in layer):
                raise Exception("the compared samples are all one alpha, they prove nothing: %s" % res["gotPixels"][2:])
            done("a_saved_and_reopened_document_keeps_them", {"layers": res["count"], "group": res["wantGroup"]})
        if ran_split:
            await step("a_saved_and_reopened_document_keeps_them", split_save)

        async def split_low_res():
            mock.reset()
            res = await ev(SPLIT, __W__="1200", __H__="800", __SETUP__="", __ARGS__=split_args({"recipe": "seedream_5_5", "size": "1K", "count": 3, "text_recognition": True, "prompt": "the dogs", "timeout": 120}))
            b = split_body(mock)["body"]
            if b.get("size") != "1K" or b.get("prompt") != "the dogs" or b.get("layer_decomposition_options") != {"max_images": 3, "text_recognition": True}:
                raise Exception("the request: %s" % json.dumps(b)[:400])
            check_stack(res, (0, 0, 1200, 800), (1024, 683), ["Base 2", "Sky 2", "Dog 3", "Dog 4"])
            if not res["out"]["scaled_up"] or "lower resolution than the picture" not in res["status"] or res["kind"] != "warn":
                raise Exception("the line of a scaled-up landing: %s (kind %s)" % (res["status"][:300], res["kind"]))
            done("a_tier_below_the_picture_says_lower_resolution", {"answered": res["out"]["answered"], "status": res["status"][-120:]})
        await step("a_tier_below_the_picture_says_lower_resolution", split_low_res)

        async def split_layer():
            mock.reset()
            res = await ev(SPLIT, __W__="1200", __H__="800", __SETUP__=SPLIT_LAYER_SETUP, __ARGS__=split_args({"recipe": "seedream_5_5", "source": "active", "size": "1K", "timeout": 120}))
            pic = split_body(mock)
            if pic["refs"][0]["dims"] != [700, 500]:
                raise Exception("the layer's picture went out at %s" % pic["refs"][0]["dims"])
            # (source-pixels-never-checked) the bugs: no draw at all (empty), the flattened picture drawn instead, the mask ignored
            sent = Image.open(io.BytesIO(mock.ref_bytes(0, 0))).convert("RGBA")
            red, empty, masked = sent.getpixel((100, 100)), sent.getpixel((600, 100)), sent.getpixel((100, 450))
            if not (red[0] > 180 and red[1] < 60 and red[3] > 250) or empty[3] != 0 or masked[3] != 0:
                raise Exception("the layer's own pixels did not go: red %s, the empty half %s, under the mask %s" % (red, empty, masked))
            check_stack(res, (50, 40, 700, 500), (1024, 731), ["Base 3", "Sky 3", "Dog 5", "Dog 6"])
            if res["out"]["group"]["name"] != "Portrait" or res["out"]["scaled_up"]:
                raise Exception("the group of a layer's split: %s, scaled_up %s" % (res["out"]["group"], res["out"]["scaled_up"]))
            done("a_layer_as_the_source", {"group": res["out"]["group"]["name"], "positions": [[a["x"], a["y"]] for a in res["added"]]})
        await step("a_layer_as_the_source", split_layer)

        async def split_pro():
            mock.reset()
            res = await ev(SPLIT, __W__="1200", __H__="800", __SETUP__="", __ARGS__=split_args({"recipe": "seedream_5_pro", "timeout": 120}))
            pic = split_body(mock)
            if pic["body"].get("model") != PRO or "layer_decomposition_options" in pic["body"]:
                raise Exception("5.0 pro's request: %s" % json.dumps(pic["body"])[:400])
            if res["err"] or len(res["added"]) != 4:
                raise Exception("5.0 pro's landing: %s" % (res["err"] or res["added"]))
            done("seedream_5_0_pro_has_no_options", {"keys": sorted(pic["body"].keys())})
        await step("seedream_5_0_pro_has_no_options", split_pro)

        async def split_list():
            res = await ev("const rl = await run('list_recipes'); return Object.fromEntries(rl.recipes.filter((r) => r.layers).map((r) => [r.id, r.layers]));")
            if res != {"seedream_5_5": {"max": 100, "options": True}, "seedream_5_pro": {"max": 16, "options": False}}:
                raise Exception("list_recipes layers: %s" % res)
            done("list_recipes_says_which_can_split", res)
        await step("list_recipes_says_which_can_split", split_list)

        def nothing_left(res, what):
            if res["added"] or res["groupDelta"] or res["undoDelta"] or not res["old"]:
                raise Exception("%s left something: %s" % (what, json.dumps({k: res[k] for k in ("added", "groupDelta", "undoDelta", "old")})[:400]))

        async def split_fails():
            mock.reset()
            res = await ev(SPLIT, __W__="1200", __H__="800", __SETUP__="", __ARGS__=split_args({"recipe": "seedream_5_5", "prompt": "MOCK_FAIL", "timeout": 120}))
            if "InternalServiceError" not in res["err"] or len(image_posts(mock.snapshot())) != 1:
                raise Exception("a failed request: %s" % res["err"][:300])
            nothing_left(res, "a failed request")
            if "InternalServiceError" not in res["status"] or res["kind"] != "error":
                raise Exception("the status line of a failed request: %s (kind %s)" % (res["status"][:200], res["kind"]))
            mock.reset()
            res2 = await ev(SPLIT, __W__="1200", __H__="800", __SETUP__="", __ARGS__=split_args({"recipe": "seedream_5_5", "prompt": "MOCK_BROKEN", "timeout": 120}))
            if "could not be decoded" not in res2["err"] or "Nothing was added" not in res2["err"]:
                raise Exception("a broken picture: %s" % res2["err"][:300])
            nothing_left(res2, "a broken picture")
            done("a_failing_answer_leaves_nothing_behind", {"failed": res["err"][:160], "broken": res2["err"][:160]})
        await step("a_failing_answer_leaves_nothing_behind", split_fails)

        async def split_cancel():
            mock.reset()
            res = await ev(SPLIT_CANCEL)
            if res["cancelled"] != 1 or res["layers"] or res["groups"] or res["undo"] or res["pending"] or "Cancelled" not in res["msg"] or not res["status"].startswith("Cancelled"):
                raise Exception("a Cancel: %s" % json.dumps(res)[:400])
            done("a_cancel_stops_it_like_any_provider_run", {"said": res["msg"][:160]})
        await step("a_cancel_stops_it_like_any_provider_run", split_cancel)

        async def split_dialog():
            mock.reset()
            res = await ev(SPLIT_DIALOG)
            if len(image_posts(mock.snapshot())) != 2:
                raise Exception("the dialog's two runs: %d requests" % len(image_posts(mock.snapshot())))
            b = mock.snapshot()["images"][0]["body"]
            if res["pro"]["count"] != "16" or not res["pro"]["off"] or not res["pro"]["hidden"] or "finds its own layers, up to 16" not in res["pro"]["line"]:
                raise Exception("the dialog on 5.0 pro: %s" % res["pro"])
            if res["s55"]["count"] != "16" or res["s55"]["off"] or res["s55"]["hidden"] or "Seedream 5.5 on BytePlus ModelArk asks for up to 16 layers" not in res["s55"]["line"] or "not on BytePlus's public list" not in res["s55"]["line"]:
                raise Exception("the dialog on 5.5: %s" % res["s55"])
            if "up to 5 layers" not in res["five"]:
                raise Exception("the line does not follow the count: %s" % res["five"])
            if b.get("prompt") != "the dog" or b.get("layer_decomposition_options") != {"max_images": 5, "text_recognition": True} or res["added"] != 4:
                raise Exception("what the dialog sent: %s, %d layers" % (json.dumps(b)[:300], res["added"]))
            b2 = mock.snapshot()["images"][1]["body"]
            if b2.get("layer_decomposition_options", {}).get("max_images") != 16 or "up to 16 layers" not in res["emptied"]:
                raise Exception("an emptied Layers box: %s, the line %s" % (b2.get("layer_decomposition_options"), res["emptied"][:100]))
            mock.reset()
            none = await ev(SPLIT_DIALOG_CANCEL)
            if none["added"] or mock.snapshot()["calls"] or "nothing was sent" not in none["status"]:
                raise Exception("the dialog's Cancel: %s" % none)
            done("the_dialog_says_what_runs_and_sends_it", {"line": res["s55"]["line"][:120]})
        await step("the_dialog_says_what_runs_and_sends_it", split_dialog)

        async def split_relight():
            mock.reset()
            res = await ev(SPLIT_RELIGHT)
            if res["flatSawSettled"] is not True:
                raise Exception("the picture was flattened before relight settled: %s" % res)
            done("the_picture_waits_for_relights_shadow_maps", res)
        await step("the_picture_waits_for_relights_shadow_maps", split_relight)

        async def split_pending():
            mock.reset()
            res = await ev(SPLIT_PENDING)
            if res["err"] or not res["had"] or res["still"] != res["had"] or res["active"] != res["id"] or res["added"] != 4:
                raise Exception("a transform in progress: %s" % res)
            done("a_transform_in_progress_survives_the_landing", res)
        await step("a_transform_in_progress_survives_the_landing", split_pending)

        async def split_slow():
            mock.reset()
            res = await ev(SPLIT_SLOW_LANDING)
            if res["err"] or res["added"] != 4:
                raise Exception("a timeout during the landing: %s" % res)
            done("the_timeout_ends_once_the_answer_is_in", res)
        await step("the_timeout_ends_once_the_answer_is_in", split_slow)

        async def split_renders():
            mock.reset()
            res = await ev(SPLIT_RENDERS)
            if res["added"] != 4 or res["renders"] > 2:
                raise Exception("the landing rebuilt the layer list %d times for %d layers" % (res["renders"], res["added"]))
            done("the_landing_rebuilds_the_layer_list_once", res)
        await step("the_landing_rebuilds_the_layer_list_once", split_renders)

        async def split_gone():
            mock.reset()
            res = await ev(SPLIT_GONE)
            if res["added"] != 3 or res["leftOut"] != ["Sky"] or "Sky" in " ".join(n for n in res["names"] if n == "Sky") or "could not be downloaded: Sky" not in res["status"] or res["kind"] != "warn":
                raise Exception("a link that stays away: %s" % json.dumps(res)[:500])
            done("a_lost_link_leaves_that_layer_out_and_lands_the_rest", {"left_out": res["leftOut"], "names": res["names"]})
        await step("a_lost_link_leaves_that_layer_out_and_lands_the_rest", split_gone)

        async def split_refused():
            for w, h, want in ((400, 400, "512 × 512 to 6000 × 6000"), (6400, 300, "no steeper than 16:1")):
                mock.reset()
                res = await ev(SPLIT, __W__=str(w), __H__=str(h), __SETUP__="", __ARGS__=split_args({"recipe": "seedream_5_5"}))
                if want not in res["err"] or mock.snapshot()["calls"]:
                    raise Exception("%dx%d: %s, the mock saw %d calls" % (w, h, res["err"][:300], len(mock.snapshot()["calls"])))
                nothing_left(res, "a refusal")
            for args, want in (({"recipe": "seedream_5_lite"}, "has no layer mode"), ({"recipe": "seedream_5_5", "count": 101}, "1 to 100 layers"), ({"recipe": "seedream_5_pro", "count": 5}, "finds its own number"), ({"recipe": "seedream_5_5", "size": "4K"}, "a tier")):
                mock.reset()
                res = await ev(SPLIT, __W__="1200", __H__="800", __SETUP__="", __ARGS__=split_args(args))
                if want not in res["err"] or mock.snapshot()["calls"]:
                    raise Exception("%s: %s, the mock saw %d calls" % (args, res["err"][:300], len(mock.snapshot()["calls"])))
                nothing_left(res, "a refusal")
            done("a_split_out_of_range_is_refused_before_anything_goes", {"checked": 6})
        await step("a_split_out_of_range_is_refused_before_anything_goes", split_refused)

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

        async def split_no_key():
            mock.reset()
            res = await ev(SPLIT_NO_KEY)
            if "no BytePlus ModelArk (Seedream) key yet" not in res["msg"] or res["added"] or mock.snapshot()["calls"]:
                raise Exception("without a key: %s" % res)
            done("a_split_without_a_key_says_so", {"msg": res["msg"][:160]})
        await step("a_split_without_a_key_says_so", split_no_key)
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
