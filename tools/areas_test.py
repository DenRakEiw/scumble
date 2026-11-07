"""Each area separately (CLAUDE.md item 54, issue #9), against the loopback provider and a stubbed local queue.

No ComfyUI, no API key. A selection of three separate areas and a speck: the count (the speck left out, areas whose
crops would overlap joined), the Each area button shown only while there are two or more, the hint in a Generate's
status line when one crop of all of them goes out at under half its size (an API recipe and a local one), each area
run on its own (one result layer per area at that area's crop, the document's selection never touched, the speck left
out), the question before an API run and its No, a selection edit and its undo while the areas run (the user's history
stays the user's), a Cancel while the second area is at the provider (the third never goes, the second counts as sent),
a failure before an area was sent, a local recipe one area at a time and its Stop, the recipe switched mid-run, the cap
of 8 and the one-area refusal, and the generate command's each_area with status's areas.

    python tools/areas_test.py

SCUMBLE_AREAS_PERF=15000x10000 adds the count's measurement at that size (a few areas, then a selection over the whole
picture): the window's own milliseconds, the worker's, and the longest gap between two tasks while the count runs.

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555 --no-comfy
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

# the loopback provider, its crop at most 512 px a side: a crop of the whole 1600 x 1000 picture goes at 32 %
LOOP = """{ id: "loopback_areas", kind: "provider", provider: "loopback", providerLabel: "Loopback", model: "loopback", input: "edit", name: "Loopback areas", settings: [], limits: { min: 64, max: 512, step: 16, pixels: 0, minPixels: 0, ratio: 0, aspects: [] } }"""
LOOP_SLOW = """{ id: "loopback_areas_slow", kind: "provider", provider: "loopback", providerLabel: "Loopback", model: "loopback", input: "edit", name: "Loopback areas (slow)", settings: [], fixed: { delay_ms: 1500 }, limits: { min: 64, max: 512, step: 16, pixels: 0, minPixels: 0, ratio: 0, aspects: [] } }"""

# three areas apart (their crops of 512 px do not overlap) and a speck of 8 x 8 px outside all of them
THREE = """
const three = async () => {
    await run("select_rect", { doc, x: 100, y: 100, w: 150, h: 150 });
    await run("select_rect", { doc, x: 1300, y: 120, w: 160, h: 140, mode: "add" });
    await run("select_rect", { doc, x: 700, y: 780, w: 180, h: 150, mode: "add" });
    await run("select_rect", { doc, x: 900, y: 300, w: 8, h: 8, mode: "add" });
};
const RECTS = [[100, 100, 150, 150], [1300, 120, 160, 140], [700, 780, 180, 150]];
// each area's crop as a run makes it (the auto context's 512 px, held to the picture)
const CROPS = [[0, 0, 512, 512], [1088, 0, 512, 512], [534, 488, 512, 512]];
const meets = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
const selectedAt = (x, y) => ed.sel.readRect(x, y, 1, 1).data[3] >= 128;
const btnState = () => { const b = ed.eachAreaBtn; return b ? { hidden: b.hidden, disabled: b.disabled, label: (b.querySelector("span") || {}).textContent || "" } : null; };
const waitBtn = async (want) => { for (let i = 0; i < 40; i++) { const s = btnState(); if (s && want(s)) return s; await wait(100); } return btnState(); };
const until = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(25); } return false; };
const resultsSince = (h0) => ed.history.slice(h0).map((h) => ed.layers.find((l) => l.id === h.layerId)).filter(Boolean);
const boxesOf = (layers) => layers.map((l) => [l.x, l.y, l.w, l.h]);
"""

# the user's ComfyUI stood in for: /prompt answered here, each queued prompt's result landed `L.land` ms later unless
# `L.hold(i)` keeps it running; nothing reaches a server
LOCAL = """
const klein = host.shell.recipes().find((r) => r.id === "flux3_klein_local");
if (!klein) throw new Error("flux3_klein_local is not listed");
const saved = { connected: host.connected, objectInfo: host.objectInfo, ensure: host.ensureOnServer, missing: host.missingFilesRefusal, recipe: host.recipe, fetch: window.fetch, ask: ed.ask, np: host.nodeParams };
const posts = [];
window.__areasIds = window.__areasIds || 0;
const hapi = (await import('./editor/host.js')).api;
// `onEnsure(i)`: called as the i-th prompt's pictures go up (before it is queued)
const L = { hold: () => false, land: 150, landed: [], onEnsure: null };
// a prompt's result as the server sends it: through the real `executed` listener (which keeps its prompt id), then its end
const landPrompt = async (id, i) => {
    const ref = await resultFor(i);
    hapi.dispatch("executed", { prompt_id: id, output: { inpaint_result: [{ ...ref, x: 0, y: 0, width: 64, height: 64, canvas_node: ed.node.id }] } });
    await wait(150);
    hapi.dispatch("execution_success", { prompt_id: id });
};
// a result of its own per prompt (the editor takes a result it has seen once only)
const resultFor = async (i) => {
    const png = await new Promise((r) => { const c = document.createElement("canvas"); c.width = 64; c.height = 64; const x = c.getContext("2d"); x.fillStyle = "rgb(" + (10 + i * 20) + ",40,90)"; x.fillRect(0, 0, 64, 64); c.toBlob(r, "image/png"); });
    return host.uploadResult(png, "areas_local_" + Date.now() + "_" + i + ".png");
};
let made = 0;
const install = () => {
    host.connected = true;
    host.objectInfo = Object.fromEntries(klein.needs.map((n) => [n, { input: { required: {} } }]));
    host.missingFilesRefusal = () => null;
    host.ensureOnServer = async () => { if (L.onEnsure) await L.onEnsure(posts.length); return null; };
    window.fetch = async (url, init) => {
        if (/\\/prompt$/.test(String(url)) && init && init.method === "POST") {
            // an id never used before in this page: a landed one is kept by id (host.js markLanded)
            const i = posts.length, id = "areas-" + Date.now() + "-" + (++window.__areasIds);
            const prev = posts[i - 1];
            posts.push({ body: JSON.parse(init.body), at: performance.now(), id, prevLanded: !prev || !!(ed._landedPrompts && ed._landedPrompts.has(prev.id)) });
            if (!L.hold(i)) setTimeout(async () => {
                await landPrompt(id, made++);
                L.landed.push(performance.now());
            }, L.land);
            return new Response(JSON.stringify({ prompt_id: id, number: posts.length, node_errors: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return saved.fetch.call(window, url, init);
    };
    host.setRecipe(klein);
};
const uninstall = () => {
    host.connected = saved.connected; host.objectInfo = saved.objectInfo; host.ensureOnServer = saved.ensure; host.missingFilesRefusal = saved.missing; window.fetch = saved.fetch; ed.ask = saved.ask; host.nodeParams = saved.np;
    host.setRecipe(saved.recipe);
    if (ed._localRuns) ed._localRuns.clear();
    if (ed.runProgress) for (const p of posts) ed.runProgress.done(p.id);
};
const stateOf = (p) => JSON.parse(p.body.prompt[klein.canvas].inputs.canvas_state);
"""

STEPS = [
    ("setup", """
const d = await run("new_document");
window.__a = d.id;
const e = ednow(d.id);
host.shell.activate(e);
await run("new_canvas", { doc: d.id, width: 1600, height: 1000 });
e.cropSettings.fill = "none";
e.cropSettings.colorMatch = false;
e.cropSettings.context = "auto";
window.__prevRecipe = host.recipe;
host.setRecipe(%s);
if (!e.eachAreaBtn) throw new Error("no Each area button in the top bar");
return { doc: d.id, tiles: !!e.tileMode };
""" % LOOP),
    # the count: three areas, the speck left out; the button shows "Each area · 3", and goes with the selection
    ("count_three", THREE + """
await three();
const st = await host.selectionAreas(ed);
if (st.count !== 3 || st.specks !== 1 || !st.each_area || st.cap !== 8) throw new Error("the count: " + JSON.stringify(st));
// each area's box holds its rectangle (the boxes are on the grid's cells: up to a cell larger)
for (const r of RECTS) {
    const hits = st.areas.filter((a) => meets([a.x, a.y, a.w, a.h], r));
    if (hits.length !== 1 || hits[0].x > r[0] || hits[0].y > r[1] || hits[0].x + hits[0].w < r[0] + r[2] || hits[0].y + hits[0].h < r[1] + r[3]) throw new Error("an area's box: " + JSON.stringify({ r, areas: st.areas }));
}
const b = await waitBtn((s) => !s.hidden && s.label === "Each area · 3");
if (b.hidden || b.label !== "Each area · 3") throw new Error("the button: " + JSON.stringify(b));
const s = await run("status", { doc });
if (!s.areas || s.areas.count !== 3 || !s.areas.each_area) throw new Error("status areas: " + JSON.stringify(s.areas));
await run("select_none", { doc });
const gone = await waitBtn((x) => x.hidden);
if (!gone.hidden) throw new Error("the button stays without a selection: " + JSON.stringify(gone));
return { areas: st.areas, specks: st.specks, button: b.label };
"""),
    # two rectangles 40 px apart: their crops overlap, so they are one area and the button goes
    ("close_areas_are_one", THREE + """
await run("select_rect", { doc, x: 300, y: 300, w: 120, h: 120 });
await run("select_rect", { doc, x: 460, y: 300, w: 120, h: 120, mode: "add" });
const st = await host.selectionAreas(ed);
if (st.count !== 1 || st.each_area) throw new Error("two close rectangles: " + JSON.stringify(st));
const b = await waitBtn((s) => s.hidden);
if (!b.hidden) throw new Error("the button shows for one area: " + JSON.stringify(b));
let msg = "";
try { await host.generateEachArea(ed); } catch (err) { msg = String(err.message || err); }
if (msg !== "The selection is one area: use Generate.") throw new Error("one area: " + msg);
return { count: st.count, refused: msg };
"""),
    # a Generate of all three as one crop: the status line and the run's notes say each area on its own is sharper
    ("hint_in_status", THREE + """
await three();
await host.selectionAreas(ed);
const h0 = ed.history.length;
const g = await run("generate", { doc, timeout: 60 });
const want = /^3 separate areas; the crop goes at (\\d+) % of its size; generating each area on its own gives sharper results \\(Each area\\)\\.$/;
const note = (g.notes || []).find((n) => want.test(n));
if (!note || !ed.status.includes(note)) throw new Error("the hint: " + JSON.stringify({ notes: g.notes, status: ed.status }));
const pct = +note.match(want)[1];
if (pct < 25 || pct > 40) throw new Error("the crop's share: " + pct);
if (ed.statusKind === "error" || ed.statusKind === "warn") throw new Error("the hint made the line " + ed.statusKind);
if (ed.history.length !== h0 + 1) throw new Error("the Generate landed " + (ed.history.length - h0));
// one area: no hint
await run("select_rect", { doc, x: 100, y: 100, w: 150, h: 150 });
await host.selectionAreas(ed);
const g2 = await run("generate", { doc, timeout: 60 });
if ((g2.notes || []).some((n) => /separate areas/.test(n))) throw new Error("a hint for one area: " + JSON.stringify(g2.notes));
return { note, pct };
"""),
    # the API run asks first; No sends nothing
    ("ask_no_sends_nothing", THREE + """
await three();
await host.selectionAreas(ed);
const h0 = ed.history.length;
const ask0 = ed.ask;
let asked = null;
ed.ask = async (o) => { asked = o; return null; };
let out;
try { out = await host.generateEachArea(ed); } finally { ed.ask = ask0; }
if (!asked || !/^3 areas, 3 runs on Loopback \\(Loopback areas\\): .*charges each run as one/.test(asked.message) || asked.ok !== "Generate 3") throw new Error("the question: " + JSON.stringify(asked));
if (ed.history.length !== h0 || out.done !== 0 || out.sent !== 0 || ed.status !== "Each area: nothing was sent.") throw new Error("a No: " + JSON.stringify({ out, status: ed.status, landed: ed.history.length - h0 }));
return { message: asked.message };
"""),
    # each area its own run: three result layers, each at its own area's crop; the document's selection is never touched
    ("each_area_runs", THREE + """
await three();
await host.selectionAreas(ed);
const before = ed.getBounds().slice(), sel0 = ed.sel, seq0 = ed.selectionSeq;
const h0 = ed.history.length, undo0 = ed.undo.length;
const ask0 = ed.ask;
ed.ask = async () => true;
// the selection the user has while an area's answer is in: the one of the click, the same object, never changed
const upload0 = host.uploadResult;
const seen = [];
host.uploadResult = async function (...a) { seen.push({ bounds: ed.getBounds().slice(), same: ed.sel === sel0, seq: ed.selectionSeq }); return upload0.apply(this, a); };
let out;
try { out = await host.generateEachArea(ed); } finally { ed.ask = ask0; host.uploadResult = upload0; }
if (out.done !== 3 || out.sent !== 3 || out.notSent !== 0 || out.cancelled || out.failed || out.leftOut !== 1) throw new Error("the run: " + JSON.stringify(out));
const layers = resultsSince(h0);
if (layers.length !== 3) throw new Error("layers: " + layers.length);
const boxes = boxesOf(layers);
if (JSON.stringify(boxes) !== JSON.stringify(CROPS)) throw new Error("the results are not the areas' crops: " + JSON.stringify(boxes));
if (JSON.stringify(ed.getBounds()) !== JSON.stringify(before) || ed.sel !== sel0 || ed.selectionSeq !== seq0) throw new Error("the selection was changed: " + JSON.stringify({ before, after: ed.getBounds(), same: ed.sel === sel0, seq: [seq0, ed.selectionSeq] }));
for (const r of RECTS) if (!selectedAt(r[0] + 5, r[1] + 5)) throw new Error("an area is no longer selected: " + r);
if (!selectedAt(902, 302)) throw new Error("the speck is no longer selected");
if (ed._eachArea) throw new Error("the run's state stayed");
if (ed.status !== "Each area: 3 areas generated, each its own layer. 1 small speck of the selection outside the areas was left out.") throw new Error("the status: " + ed.status);
if (ed.undo.length !== undo0) throw new Error("the run pushed undo steps: " + (ed.undo.length - undo0));
const prompts = ed.history.slice(h0).map((h) => h.prompt);
if (new Set(prompts).size !== 1) throw new Error("the prompts: " + JSON.stringify(prompts));
if (seen.length !== 3 || seen.some((s) => !s.same || s.seq !== seq0 || JSON.stringify(s.bounds) !== JSON.stringify(before))) throw new Error("the selection during the runs: " + JSON.stringify({ seen, before }));
const b = await waitBtn((s) => !s.hidden && !s.disabled && s.label === "Each area · 3");
if (b.hidden || b.disabled) throw new Error("the button after: " + JSON.stringify(b));
return { boxes, status: ed.status };
"""),
    # the user edits the selection while an area is at the provider, and undoes it: the runs keep the click's areas, the
    # user's history keeps the user's steps (undo and redo of that edit work after the run)
    ("edit_and_undo_while_the_areas_run", THREE + """
host.setRecipe(%s);
await three();
await host.selectionAreas(ed);
const sel0 = ed.sel;
const h0 = ed.history.length;
const ask0 = ed.ask;
ed.ask = async () => true;
let out, during = null;
try {
    const p = host.generateEachArea(ed);
    if (!(await until(() => /^Sending crop/.test(ed.status) && !!ed.providerPending))) throw new Error("the first area did not go: " + ed.status);
    during = { label: btnState().label };
    // a square inside the third area's crop: had a run read the document's selection, the third crop would grow
    await run("select_rect", { doc, x: 560, y: 520, w: 60, h: 60, mode: "add" });
    during.edited = selectedAt(565, 525);
    await run("undo", { doc });
    during.undone = !selectedAt(565, 525);
    await run("redo", { doc });
    during.redone = selectedAt(565, 525);
    out = await p;
} finally { ed.ask = ask0; host.setRecipe(%s); }
if (!during.edited || !during.undone || !during.redone || during.label !== "Stop · 1/3") throw new Error("the edit during the run: " + JSON.stringify(during));
if (out.done !== 3 || out.stopped) throw new Error("the run: " + JSON.stringify(out));
const boxes = boxesOf(resultsSince(h0));
if (JSON.stringify(boxes) !== JSON.stringify(CROPS)) throw new Error("an area read the edited selection: " + JSON.stringify(boxes));
// the user's own history: the edit is there, and undo takes it back
if (ed.sel !== sel0 || !selectedAt(565, 525)) throw new Error("the edit is gone after the run");
await run("undo", { doc });
if (selectedAt(565, 525) || !RECTS.every((r) => selectedAt(r[0] + 5, r[1] + 5))) throw new Error("undo after the run did not take the edit back");
return { during, boxes };
""" % (LOOP_SLOW, LOOP)),
    # a Cancel while the second area is at the provider: the first stays, the second counts as sent with the provider's
    # words, the third never goes
    ("cancel_stops_the_rest", THREE + """
host.setRecipe(%s);
await three();
await host.selectionAreas(ed);
const before = ed.getBounds().slice();
const h0 = ed.history.length;
const ask0 = ed.ask;
ed.ask = async () => true;
let calls = 0;
const runProvider0 = host.runProvider;
host.runProvider = function (...a) { calls++; return runProvider0.apply(this, a); };
let out, label = null, cancel = null;
try {
    const p = host.generateEachArea(ed);
    if (!(await until(() => ed.history.length === h0 + 1 && /^Sending crop/.test(ed.status) && !!ed.providerPending))) throw new Error("the second area did not go: " + JSON.stringify({ landed: ed.history.length - h0, status: ed.status }));
    label = btnState().label;
    cancel = await run("cancel_run", { doc });
    out = await p;
} finally { ed.ask = ask0; host.runProvider = runProvider0; host.setRecipe(%s); }
await wait(2500);
if (!out.cancelled || out.done !== 1 || out.sent !== 2 || out.notSent !== 1 || calls !== 2 || !/^Cancelled after /.test(out.said || "")) throw new Error("the cancel: " + JSON.stringify({ out, calls }));
if (ed.history.length !== h0 + 1) throw new Error("landed after the cancel: " + (ed.history.length - h0));
if (!/^Each area cancelled: 1 of 3 areas generated; area 2 was cancelled after it was sent \\(Cancelled after .+\\); 1 was not sent\\.$/.test(ed.status) || ed.statusKind) throw new Error("the status: " + JSON.stringify([ed.status, ed.statusKind]));
if (!String(cancel.note || "").includes("Each area: the areas not yet sent do not go.")) throw new Error("cancel_run's note: " + JSON.stringify(cancel.note));
if (label !== "Stop · 2/3") throw new Error("the button during the run: " + label);
if (JSON.stringify(ed.getBounds()) !== JSON.stringify(before)) throw new Error("the selection after a cancel: " + JSON.stringify(ed.getBounds()));
return { status: ed.status, said: out.said };
""" % (LOOP_SLOW, LOOP)),
    # a run refused before anything was sent stops the rest: the first area's layer stays, the refused one is not a run
    ("failure_stops_the_rest", THREE + """
await three();
await host.selectionAreas(ed);
const h0 = ed.history.length;
const ask0 = ed.ask;
ed.ask = async () => true;
let calls = 0;
const runProvider0 = host.runProvider;
host.runProvider = function (...a) { calls++; return calls === 2 ? Promise.reject(new Error("The provider refused the crop")) : runProvider0.apply(this, a); };
let out;
try { out = await host.generateEachArea(ed); } finally { ed.ask = ask0; host.runProvider = runProvider0; }
if (out.done !== 1 || out.sent !== 1 || out.notSent !== 2 || out.cancelled || out.failed !== "The provider refused the crop" || calls !== 2) throw new Error("the failure: " + JSON.stringify({ out, calls }));
if (ed.history.length !== h0 + 1) throw new Error("landed: " + (ed.history.length - h0));
if (ed.status !== "Each area stopped before area 2 of 3 was sent: The provider refused the crop. 1 of 3 areas generated, 2 not sent." || ed.statusKind !== "error") throw new Error("the status: " + JSON.stringify([ed.status, ed.statusKind]));
return { status: ed.status };
"""),
    # the recipe switched while the areas run: the areas after it do not go on another recipe; the same recipe selected
    # again (a new object, as the shell makes one after a key is saved) is no switch
    ("recipe_switch_stops_the_rest", THREE + """
host.setRecipe(%s);
await three();
await host.selectionAreas(ed);
const h0 = ed.history.length;
const ask0 = ed.ask;
ed.ask = async () => true;
let out;
try {
    const p = host.generateEachArea(ed);
    if (!(await until(() => /^Sending crop/.test(ed.status) && !!ed.providerPending))) throw new Error("the first area did not go");
    host.setRecipe(%s);
    if (!(await until(() => ed.history.length === h0 + 1 && /^Sending crop/.test(ed.status) && !!ed.providerPending))) throw new Error("the second area did not go after the same recipe was selected again: " + ed.status);
    host.setRecipe(%s);
    out = await p;
} finally { ed.ask = ask0; host.setRecipe(%s); }
if (out.stopped !== "recipe" || out.done !== 2 || out.notSent !== 1) throw new Error("the switch: " + JSON.stringify(out));
if (ed.status !== "Each area stopped: the recipe changed while the areas ran; 2 of 3 areas generated; the last was not sent.") throw new Error("the status: " + ed.status);
return { status: ed.status };
""" % (LOOP_SLOW, LOOP_SLOW, LOOP, LOOP)),
    # while the areas run, nothing changes the picture they were cut from: a turn, a resize, Generate new and a Generate
    # of the whole selection are refused with a plain line, and every area lands where the click's picture had it
    ("geometry_refused_while_areas_run", THREE + """
host.setRecipe(%s);
await three();
await host.selectionAreas(ed);
const h0 = ed.history.length, W0 = ed.width, H0 = ed.height;
const ask0 = ed.ask;
ed.ask = async () => true;
let out, said = {};
const msgOf = async (f) => { try { await f(); return "ran"; } catch (e) { return String((e && e.message) || e); } };
try {
    const p = host.generateEachArea(ed);
    if (!(await until(() => /^Sending crop/.test(ed.status) && !!ed.providerPending))) throw new Error("the first area did not go");
    said.turn = await msgOf(() => run("rotate_canvas", { doc, angle: 90 }));
    said.resize = await msgOf(() => run("resize_image", { doc, percent: 50 }));
    said.generateNew = host.generateNewBlocked(ed);
    const g = await ed.generate();
    said.generate = g && g.error ? g.error.message : "ran";
    out = await p;
} finally { ed.ask = ask0; host.setRecipe(%s); }
const EA = /^Each area is running on this document/;
if (!EA.test(said.turn) || !EA.test(said.resize) || !EA.test(said.generateNew) || said.generate !== "Each area is running on this document: wait for it, or stop it.") throw new Error("refusals: " + JSON.stringify(said));
if (ed.width !== W0 || ed.height !== H0 || out.done !== 3 || out.stopped) throw new Error("the run: " + JSON.stringify({ out, size: [ed.width, ed.height] }));
if (JSON.stringify(boxesOf(resultsSince(h0))) !== JSON.stringify(CROPS)) throw new Error("the results: " + JSON.stringify(boxesOf(resultsSince(h0))));
// after the run the turn works again (and is taken back)
await run("rotate_canvas", { doc, angle: 90 });
if (ed.width !== H0) throw new Error("no turn after the run");
await run("undo", { doc });
return said;
""" % (LOOP_SLOW, LOOP)),
    # the in-app models are free and offline: no question; the command's time: no area starts that the time left would
    # not hold (an area took 1.5 s, so with 0.5 s left after it none follows)
    ("free_and_timed", THREE + """
await three();
await host.selectionAreas(ed);
const prev = host.recipe, ask0 = ed.ask, runProvider0 = host.runProvider, keyState0 = host.shell.keyState;
let asked = 0, calls = 0, timed;
try {
    ed.ask = async () => { asked++; return true; };
    // a provider without a usable key is refused before the question (nothing counted as sent)
    host.shell.keyState = () => ({ ok: false, text: "no Loopback key yet: Settings (Ctrl+,) › API providers" });
    let noKey = "";
    try { await host.generateEachArea(ed); } catch (e) { noKey = String(e.message || e); }
    if (noKey !== "Each area cannot run on Loopback: no Loopback key yet: Settings (Ctrl+,) › API providers." || asked) throw new Error("no key: " + JSON.stringify({ noKey, asked }));
    // the in-app model, its file present (as keyState says for a downloaded LaMa)
    host.shell.keyState = () => ({ ok: true });
    host.setRecipe({ id: "inapp_areas", kind: "provider", provider: "inapp", providerLabel: "In-app", model: "lama", input: "edit", name: "Remove (LaMa)", settings: [], limits: { min: 64, max: 512, step: 8, pixels: 0, minPixels: 0, ratio: 0, aspects: [] } });
    host.runProvider = async () => { calls++; return {}; };
    const free = await host.generateEachArea(ed);
    if (asked || calls !== 3 || free.done !== 3) throw new Error("the in-app run: " + JSON.stringify({ asked, calls, free }));
    host.runProvider = runProvider0;
    host.shell.keyState = keyState0;
    host.setRecipe(%s);
    const h0 = ed.history.length;
    timed = await host.generateEachArea(ed, { confirm: false, deadline: Date.now() + 500 });
    if (timed.stopped !== "time" || timed.done !== 1 || timed.notSent !== 2 || ed.history.length !== h0 + 1) throw new Error("the deadline: " + JSON.stringify(timed));
    if (ed.status !== "Each area stopped: the command's time ran out; 1 of 3 areas generated; the other 2 were not sent.") throw new Error("the status: " + ed.status);
} finally { ed.ask = ask0; host.runProvider = runProvider0; host.shell.keyState = keyState0; host.setRecipe(prev); }
return { asked, timed: timed.stopped };
""" % LOOP_SLOW),
    # a recipe on the user's ComfyUI (a stubbed /prompt, nothing reaches a server): the hint on a plain Generate, then
    # each area queued only once the one before landed, each with its own mask, no question asked
    ("local_one_area_at_a_time", THREE + LOCAL + """
try {
    install();
    host.nodeParams = { ...saved.np, target_size: 512 };   // the node scales a crop to 512: all three go at 32 %
    await three();
    await host.selectionAreas(ed);
    const h00 = ed.history.length;
    const g = await ed.generate();
    if (g && g.error) throw g.error;
    if (!(ed.lastRunNotes || []).some((n) => /^3 separate areas; the crop goes at 32 % of its size/.test(n))) throw new Error("the local hint: " + JSON.stringify(ed.lastRunNotes));
    if (!(await until(() => ed.history.length === h00 + 1 && !(ed._localRuns && ed._localRuns.size)))) throw new Error("the plain local run did not land");
    host.nodeParams = saved.np;
    posts.length = 0;
    L.landed.length = 0;
    let asked = 0;
    ed.ask = async () => { asked++; return true; };
    const before = ed.getBounds().slice(), h0 = ed.history.length;
    const out = await host.generateEachArea(ed);
    if (out.areas !== 3 || out.done !== 3 || out.sent !== 3 || out.stopped || out.failed || asked) throw new Error("the local run: " + JSON.stringify({ out, asked }));
    if (posts.length !== 3 || ed.history.length !== h0 + 3) throw new Error("prompts / results: " + posts.length + " / " + (ed.history.length - h0));
    // one at a time: each prompt went after the one before had landed
    if (posts.some((p) => !p.prevLanded)) throw new Error("queued before the one before landed: " + JSON.stringify(posts.map((p) => p.prevLanded)));
    const states = posts.map(stateOf);
    const masks = states.map((s) => s.mask && s.mask.filename);
    if (new Set(masks).size !== 3 || states.some((s) => !s.hasSelection) || new Set(states.map((s) => s.prompt)).size !== 1) throw new Error("the queued states: " + JSON.stringify({ masks }));
    if (JSON.stringify(ed.getBounds()) !== JSON.stringify(before)) throw new Error("the selection after: " + JSON.stringify(ed.getBounds()));
    // the areas' run notes (here the recipe's upsampler note, the same for every area) once each, after the line
    const head = "Each area: 3 areas generated on your ComfyUI, each its own layer. 1 small speck of the selection outside the areas was left out.";
    const note = (out.notes || []).find((n) => /prompt upsampler/.test(n));
    if (!ed.status.startsWith(head) || !note || out.notes.length !== new Set(out.notes).size || ed.status.split(note).length !== 2) throw new Error("the status: " + JSON.stringify({ status: ed.status, notes: out.notes }));
    return { masks, status: ed.status, kind: ed.statusKind };
} finally { uninstall(); }
"""),
    # the Stop while the second area runs on the user's ComfyUI: it finishes there, the third is never queued
    ("local_stop_keeps_the_rest_off_the_queue", THREE + LOCAL + """
try {
    install();
    L.hold = (i) => i === 1;
    await three();
    await host.selectionAreas(ed);
    const h0 = ed.history.length;
    const p = host.generateEachArea(ed);
    if (!(await until(() => posts.length === 2))) throw new Error("the second area was not queued: " + posts.length);
    const label = btnState().label;
    ed.eachAreaBtn.click();
    const out = await p;
    await wait(500);
    if (out.done !== 1 || out.sent !== 2 || out.running !== 2 || out.notSent !== 1 || !out.cancelled || posts.length !== 2) throw new Error("the stop: " + JSON.stringify({ out, posts: posts.length }));
    if (!ed.status.startsWith("Each area cancelled: 1 of 3 areas landed; area 2 is still running on your ComfyUI and lands when it is done; 1 was not sent.")) throw new Error("the status: " + ed.status);
    if (label !== "Stop · 2/3") throw new Error("the button during the run: " + label);
    return { status: ed.status };
} finally { uninstall(); }
"""),
    # the Stop while the second area's pictures go up: nothing more is queued, so it counts as not sent
    ("local_stop_before_it_is_queued", THREE + LOCAL + """
try {
    install();
    L.onEnsure = (i) => { if (i === 1) ed.eachAreaBtn.click(); };
    await three();
    await host.selectionAreas(ed);
    const out = await host.generateEachArea(ed);
    await wait(500);
    if (out.done !== 1 || out.sent !== 1 || out.running !== null || out.notSent !== 2 || !out.cancelled || posts.length !== 1) throw new Error("the stop: " + JSON.stringify({ out, posts: posts.length }));
    if (!ed.status.startsWith("Each area cancelled: 1 of 3 areas landed; the other 2 were not sent.")) throw new Error("the status: " + ed.status);
    return { status: ed.status };
} finally { uninstall(); }
"""),
    # another render on the document: one still on the server refuses Each area; while the areas run, a Generate of the
    # whole selection is refused, and a result of another prompt that lands in the document is not taken for an area's,
    # so the next area waits for its own
    ("local_other_renders_are_not_areas", THREE + LOCAL + """
try {
    install();
    await three();
    await host.selectionAreas(ed);
    // a plain render still on the server
    L.hold = (i) => i === 0;
    const g0 = await ed.generate();
    if (g0 && g0.error) throw g0.error;
    let refused = "";
    try { await host.generateEachArea(ed); } catch (e) { refused = String(e.message || e); }
    if (refused !== "A render on your ComfyUI is still running on this document: run Each area when it is in.") throw new Error("a render going: " + refused);
    await landPrompt(posts[0].id, made++);
    if (!(await until(() => !(ed._localRuns && ed._localRuns.size)))) throw new Error("the plain render did not end");
    // the run, its first area held on the server
    posts.length = 0;
    L.hold = (i) => i === 0;
    const h0 = ed.history.length;
    const p = host.generateEachArea(ed);
    if (!(await until(() => posts.length === 1))) throw new Error("the first area was not queued");
    const g1 = await ed.generate();
    const plain = g1 && g1.error ? g1.error.message : "ran";
    // a result of another prompt lands in the document (the tab in front takes it)
    const ref = await resultFor(made++);
    hapi.dispatch("executed", { prompt_id: "other-" + Date.now(), output: { inpaint_result: [{ ...ref, x: 0, y: 0, width: 64, height: 64, canvas_node: ed.node.id }] } });
    await wait(1200);
    const queuedWhileHeld = posts.length;
    await landPrompt(posts[0].id, made++);
    const out = await p;
    if (plain !== "Each area is running on this document: wait for it, or stop it.") throw new Error("a plain Generate during the run: " + plain);
    if (queuedWhileHeld !== 1) throw new Error("the next area went before the first one's own result: " + queuedWhileHeld);
    if (out.done !== 3 || posts.length !== 3 || posts.some((x) => !x.prevLanded) || ed.history.length !== h0 + 4) throw new Error("the run: " + JSON.stringify({ out, posts: posts.length, landed: ed.history.length - h0 }));
    return { plain, queuedWhileHeld };
} finally { uninstall(); }
"""),
    # more than 8 areas: refused plainly, nothing sent
    ("cap_of_eight", THREE + """
const ctx0 = ed.cropSettings.context;
ed.cropSettings.context = "manual";
try {
    await run("select_rect", { doc, x: 40, y: 40, w: 60, h: 60 });
    for (let i = 1; i < 9; i++) await run("select_rect", { doc, x: 40 + (i % 5) * 300, y: 40 + Math.floor(i / 5) * 500, w: 60, h: 60, mode: "add" });
    const st = await host.selectionAreas(ed);
    if (st.count !== 9 || st.each_area) throw new Error("nine areas: " + JSON.stringify(st));
    const b = await waitBtn((s) => !s.hidden && s.label === "Each area · 9");
    if (b.hidden || b.label !== "Each area · 9") throw new Error("the button: " + JSON.stringify(b));
    const h0 = ed.history.length;
    let err = null;
    try { await host.generateEachArea(ed); } catch (e) { err = e; }
    if (!err || err.message !== "The selection has 9 separate areas; Each area runs at most 8: select fewer, or use Generate for all of them in one crop." || (err.statusKind && err.statusKind !== "info")) throw new Error("the cap: " + (err && err.message));
    if (ed.history.length !== h0) throw new Error("something ran");
    return { refused: err.message };
} finally { ed.cropSettings.context = ctx0; }
"""),
    # the command: generate each_area, and an upscaler takes none
    ("command_each_area", THREE + """
await three();
const h0 = ed.history.length;
const g = await run("generate", { doc, each_area: true, timeout: 120 });
if (g.areas !== 3 || g.generated !== 3 || g.layers.length !== 3 || g.sent !== 3 || g.not_sent !== 0 || g.cancelled || g.failed || g.left_out !== 1 || !Array.isArray(g.notes)) throw new Error("generate each_area: " + JSON.stringify(g));
if (ed.history.length !== h0 + 3) throw new Error("landed " + (ed.history.length - h0));
await run("select_rect", { doc, x: 100, y: 100, w: 150, h: 150 });
let msg = "";
try { await run("generate", { doc, each_area: true }); } catch (err) { msg = String(err.message || err); }
if (msg !== "The selection is one area: use Generate.") throw new Error("one area through the command: " + msg);
const prev = host.recipe;
host.setRecipe({ id: "loopback_areas_up", kind: "provider", task: "upscale", provider: "loopback", providerLabel: "Loopback", model: "loopback", name: "Loopback upscale", factor: { default: 2, min: 1, max: 4, steps: null, fixed: false }, limits: { min: 32, max: 4096, step: 1, pixels: 0, minPixels: 0, ratio: 0 }, settings: [], usesPrompt: false, input: "fill" });
await three();
let up = "";
try { await host.generateEachArea(ed); } catch (err) { up = String(err.message || err); } finally { host.setRecipe(prev); }
if (up !== "Each area runs an edit recipe; Loopback upscale is not one: use Upscale for it.") throw new Error("an upscaler: " + up);
return { generated: g.generated, status: g.status, refused: [msg, up] };
"""),
]

PERF = """
const d = await run("new_document");
const big = ednow(d.id);
host.shell.activate(big);
const [W, H] = [%d, %d];
await run("new_canvas", { doc: d.id, width: W, height: H });
const probe = async (fn) => {
    // the longest gap between two tasks of a message loop while fn runs: what the window was held for at most (timers
    // are throttled in a window behind others, messages are not)
    const ch = new MessageChannel();
    let last = performance.now(), worst = 0, on = true, ticks = 0;
    ch.port1.onmessage = () => { const t = performance.now(); worst = Math.max(worst, t - last); last = t; ticks++; if (on) ch.port2.postMessage(0); };
    ch.port2.postMessage(0);
    const t0 = performance.now();
    let out;
    try { out = await fn(); } finally { on = false; }
    const ms = performance.now() - t0;
    await wait(20);
    ch.port1.close();
    return { ms: Math.round(ms * 10) / 10, worstGap: Math.round(worst * 10) / 10, ticks, out };
};
const rows = {};
const r1 = (v) => Math.round(v * 10) / 10;
const job = (e) => e.timing ? { tiles: e.timing.tiles, cells: e.timing.cells, count: r1(e.timing.count), label: r1(e.timing.label), trip: e.timing.pool ? r1(e.timing.pool.tripMs) : null } : null;
// a few areas: four squares of 900 px and a speck
const a = Math.round(W / 16);
await run("select_rect", { doc: d.id, x: a, y: a, w: 900, h: 900 });
await run("select_rect", { doc: d.id, x: W - a - 900, y: a, w: 900, h: 900, mode: "add" });
await run("select_rect", { doc: d.id, x: a, y: H - a - 900, w: 900, h: 900, mode: "add" });
await run("select_rect", { doc: d.id, x: W - a - 1200, y: H - a - 700, w: 1200, h: 700, mode: "add" });
await run("select_rect", { doc: d.id, x: W >> 1, y: H >> 1, w: 20, h: 20, mode: "add" });
big.getBounds();
// the same wait without a count: what the window does anyway after the selection changed
rows.idle_few = await probe(() => wait(30)); delete rows.idle_few.out;
// one pixel of the selection read back first: on the canvas backend what the GPU still owes the selection's canvas
{ const t = performance.now(); big.sel.readRect(0, 0, 1, 1); rows.first_pixel_ms = Math.round((performance.now() - t) * 10) / 10; }
for (let k = 0; k < 3; k++) {
    // a fresh count each time: the selection's change counter moves, the pixels stay
    big.selectionSeq++;
    const r = await probe(() => host.selectionAreas(big));
    const e = big._areas;
    rows["few_" + k] = { ms: r.ms, worstGap: r.worstGap, ticks: r.ticks, count: r.out.count, specks: r.out.specks, how: e.how, window: Math.round(e.window * 10) / 10, worker: job(e) };
}
// the whole picture selected but for a hole: every tile allocated, one area
await run("select_all", { doc: d.id });
await run("select_rect", { doc: d.id, x: W >> 2, y: H >> 2, w: W >> 1, h: H >> 1, mode: "subtract" });
big.getBounds();
rows.idle_whole = await probe(() => wait(30)); delete rows.idle_whole.out;
for (let k = 0; k < 3; k++) {
    big.selectionSeq++;
    const r = await probe(() => host.selectionAreas(big));
    const e = big._areas;
    rows["whole_" + k] = { ms: r.ms, worstGap: r.worstGap, ticks: r.ticks, count: r.out.count, how: e.how, window: Math.round(e.window * 10) / 10, worker: job(e) };
}
try { await run("close_document", { doc: d.id, force: true }); } catch (_) { /* gone */ }
host.shell.activate(ednow(window.__a));
return rows;
"""

CLEANUP = """
host.setRecipe(window.__prevRecipe || null);
try { await run("close_document", { doc: window.__a, force: true }); } catch (_) { /* gone */ }
return "ok";
"""

PRE = """(async () => {
    const commands = window.__cmds.commands, host = window.__host;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const doc = window.__a;
    const ed = doc != null ? ednow(doc) : null;
    %s
})()"""


async def run_all(c):
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); window.__host = (await import('./editor/host.js')).host; window.__a = null; await import('./shell.js'); return 1; })()")
    ok = True
    steps = list(STEPS)
    perf = os.environ.get("SCUMBLE_AREAS_PERF", "")
    if perf:
        w, h = (int(v) for v in perf.lower().split("x"))
        steps.append(("perf_%dx%d" % (w, h), PERF % (w, h)))
    # SCUMBLE_AREAS_ONLY=name,name: the setup, those steps and the cleanup, for iterating on a few
    only = set(filter(None, os.environ.get("SCUMBLE_AREAS_ONLY", "").split(",")))
    steps.append(("cleanup", CLEANUP))
    for name, body in steps:
        if only and name not in only and name not in ("setup", "cleanup"):
            continue
        try:
            res = await c.eval(PRE % body, timeout=600)
            text = json.dumps(res)
            print("[ok] %s: %s" % (name, text if name.startswith("perf_") else text[:600]))
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] %s: %s" % (name, err))
            if name != "cleanup":
                try:
                    await c.eval(PRE % CLEANUP, timeout=60)
                except Exception:  # noqa: BLE001
                    pass
            break
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:220])
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
