"""Each area separately (CLAUDE.md item 54, issue #9), against the loopback provider.

No ComfyUI, no API key. A selection of three separate areas and a speck: the count (the speck left out, areas whose
crops would overlap joined), the Each area button shown only while there are two or more, the hint in a Generate's
status line when one crop of all of them goes out at under half its size, each area run on its own (one result layer
per area at that area's crop, the user's selection back after every run, the speck left out), the question before an
API run and its No, a Cancel during the second run (the third never goes), the cap of 8 and the one-area refusal, and
the generate command's each_area with status's areas.

    python tools/areas_test.py

SCUMBLE_AREAS_PERF=15000x10000 adds the count's measurement at that size (a few areas, then a selection over the whole
picture): the window's own milliseconds, the worker's, and the longest gap of a 4 ms timer while the count runs.

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
const meets = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
const selectedAt = (x, y) => ed.sel.readRect(x, y, 1, 1).data[3] >= 128;
const btnState = () => { const b = ed.eachAreaBtn; return b ? { hidden: b.hidden, disabled: b.disabled, label: (b.querySelector("span") || {}).textContent || "" } : null; };
const waitBtn = async (want) => { for (let i = 0; i < 40; i++) { const s = btnState(); if (s && want(s)) return s; await wait(100); } return btnState(); };
const resultsSince = (h0) => ed.history.slice(h0).map((h) => ed.layers.find((l) => l.id === h.layerId)).filter(Boolean);
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
if (!e.eachAreaBtn.hidden) throw new Error("the button shows without a selection");
return { doc: d.id, tiles: !!e.tileMode };
""" % LOOP),
    # the count: three areas, the speck left out; the button shows "Each area · 3"
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
if (ed.history.length !== h0 || out.done !== 0 || ed.status !== "Each area: nothing was sent.") throw new Error("a No: " + JSON.stringify({ out, status: ed.status, landed: ed.history.length - h0 }));
return { message: asked.message };
"""),
    # each area its own run: three result layers, each at its own area's crop, the user's selection back after each
    ("each_area_runs", THREE + """
await three();
await host.selectionAreas(ed);
const before = ed.getBounds().slice();
const h0 = ed.history.length;
const ask0 = ed.ask;
ed.ask = async () => true;
// the selection the user sees once an area's answer is in (its crop was read from the area's own selection before)
const upload0 = host.uploadResult;
const seen = [];
host.uploadResult = async function (...a) { seen.push({ during: ed.getBounds().slice(), area: !!ed._eachAreaSwap }); return upload0.apply(this, a); };
let out;
try { out = await host.generateEachArea(ed); } finally { ed.ask = ask0; host.uploadResult = upload0; }
if (out.done !== 3 || out.cancelled || out.failed || out.leftOut !== 1) throw new Error("the run: " + JSON.stringify(out));
const layers = resultsSince(h0);
if (layers.length !== 3) throw new Error("layers: " + layers.length);
const boxes = layers.map((l) => [l.x, l.y, l.w, l.h]);
for (let i = 0; i < 3; i++) {
    const hits = RECTS.filter((r) => meets(boxes[i], r));
    if (hits.length !== 1) throw new Error("result " + (i + 1) + " covers " + hits.length + " areas: " + JSON.stringify(boxes));
    for (let j = i + 1; j < 3; j++) if (meets(boxes[i], boxes[j])) throw new Error("two results overlap: " + JSON.stringify(boxes));
}
// the loopback hands the crop back: each crop is the area's own (512 px with the auto context), not the picture's
if (boxes.some((b) => b[2] > 600 || b[3] > 600)) throw new Error("a crop of more than its area: " + JSON.stringify(boxes));
const after = ed.getBounds();
if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error("the selection after: " + JSON.stringify({ before, after }));
for (const r of RECTS) if (!selectedAt(r[0] + 5, r[1] + 5)) throw new Error("an area is no longer selected: " + r);
if (!selectedAt(902, 302)) throw new Error("the speck is no longer selected");
if (ed._eachArea || ed._eachAreaRun || ed._eachAreaSwap) throw new Error("the run's state stayed");
if (!/^Each area: 3 areas generated, each its own layer .* 1 small speck of the selection outside the areas was left out\\.$/.test(ed.status)) throw new Error("the status: " + ed.status);
const prompts = ed.history.slice(h0).map((h) => h.prompt);
if (new Set(prompts).size !== 1) throw new Error("the prompts: " + JSON.stringify(prompts));
// while the provider worked on an area, the user's selection was back
if (seen.length !== 3 || seen.some((s) => s.area || JSON.stringify(s.during) !== JSON.stringify(before))) throw new Error("the selection during the runs: " + JSON.stringify({ seen, before }));
const b = await waitBtn((s) => !s.hidden && !s.disabled && s.label === "Each area · 3");
if (b.hidden || b.disabled) throw new Error("the button after: " + JSON.stringify(b));
return { boxes, status: ed.status };
"""),
    # a Cancel while the second area runs: the first stays, the second stops, the third never goes
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
    for (let i = 0; i < 100 && !(ed.history.length === h0 + 1 && ed.providerPending); i++) await wait(100);
    if (ed.history.length !== h0 + 1 || !ed.providerPending) throw new Error("the second run did not start: " + JSON.stringify({ landed: ed.history.length - h0, pending: !!ed.providerPending }));
    label = btnState().label;
    cancel = await run("cancel_run", { doc });
    out = await p;
} finally { ed.ask = ask0; host.runProvider = runProvider0; host.setRecipe(%s); }
await wait(2500);
if (!out.cancelled || out.done !== 1 || calls !== 2) throw new Error("the cancel: " + JSON.stringify({ out, calls }));
if (ed.history.length !== h0 + 1) throw new Error("landed after the cancel: " + (ed.history.length - h0));
if (!/^Each area cancelled: 1 of 3 areas generated; the other 2 were not sent\\.$/.test(ed.status) || ed.statusKind) throw new Error("the status: " + JSON.stringify([ed.status, ed.statusKind]));
if (!String(cancel.note || "").includes("Each area: the areas not yet sent do not go.")) throw new Error("cancel_run's note: " + JSON.stringify(cancel.note));
if (label !== "Each area 2/3") throw new Error("the button during the run: " + label);
if (JSON.stringify(ed.getBounds()) !== JSON.stringify(before)) throw new Error("the selection after a cancel: " + JSON.stringify(ed.getBounds()));
return { status: ed.status, note: cancel.note };
""" % (LOOP_SLOW, LOOP)),
    # a run that fails stops the rest: the first area's layer stays, the status says where it stopped, red
    ("failure_stops_the_rest", THREE + """
await three();
await host.selectionAreas(ed);
const before = ed.getBounds().slice();
const h0 = ed.history.length;
const ask0 = ed.ask;
ed.ask = async () => true;
let calls = 0;
const runProvider0 = host.runProvider;
host.runProvider = function (...a) { calls++; return calls === 2 ? Promise.reject(new Error("The provider refused the crop")) : runProvider0.apply(this, a); };
let out;
try { out = await host.generateEachArea(ed); } finally { ed.ask = ask0; host.runProvider = runProvider0; }
if (out.done !== 1 || out.cancelled || out.failed !== "The provider refused the crop" || calls !== 2) throw new Error("the failure: " + JSON.stringify({ out, calls }));
if (ed.history.length !== h0 + 1) throw new Error("landed: " + (ed.history.length - h0));
if (ed.status !== "Each area stopped at area 2 of 3: The provider refused the crop. 1 area was not run." || ed.statusKind !== "error") throw new Error("the status: " + JSON.stringify([ed.status, ed.statusKind]));
if (JSON.stringify(ed.getBounds()) !== JSON.stringify(before) || ed._eachAreaSwap) throw new Error("the selection after a failure: " + JSON.stringify(ed.getBounds()));
return { status: ed.status };
"""),
    # a recipe on the user's ComfyUI (a stubbed /prompt, nothing reaches a server): every area queued at once, each prompt
    # with its own mask, no question asked, the user's selection back
    ("local_queues_each_area", THREE + """
const klein = host.shell.recipes().find((r) => r.id === "flux3_klein_local");
if (!klein) throw new Error("flux3_klein_local is not listed");
const saved = { connected: host.connected, objectInfo: host.objectInfo, ensure: host.ensureOnServer, missing: host.missingFilesRefusal, recipe: host.recipe, fetch: window.fetch, ask: ed.ask };
const posts = [];
let asked = 0;
try {
    host.connected = true;
    host.objectInfo = Object.fromEntries(klein.needs.map((n) => [n, { input: { required: {} } }]));
    host.missingFilesRefusal = () => null;
    host.ensureOnServer = async () => null;
    window.fetch = async (url, init) => {
        if (/\\/prompt$/.test(String(url)) && init && init.method === "POST") {
            posts.push(JSON.parse(init.body));
            return new Response(JSON.stringify({ prompt_id: "areas-" + posts.length, number: posts.length, node_errors: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return saved.fetch.call(window, url, init);
    };
    ed.ask = async () => { asked++; return true; };
    host.setRecipe(klein);
    await three();
    const before = ed.getBounds().slice();
    const out = await host.generateEachArea(ed);
    if (out.areas !== 3 || out.queued !== 3 || out.cancelled || out.failed || asked) throw new Error("the local run: " + JSON.stringify({ out, asked }));
    if (posts.length !== 3) throw new Error("prompts queued: " + posts.length);
    const states = posts.map((p) => JSON.parse(p.prompt[klein.canvas].inputs.canvas_state));
    const masks = states.map((s) => s.mask && s.mask.filename);
    if (new Set(masks).size !== 3 || states.some((s) => !s.hasSelection) || new Set(states.map((s) => s.prompt)).size !== 1) throw new Error("the queued states: " + JSON.stringify({ masks, has: states.map((s) => s.hasSelection) }));
    if (JSON.stringify(ed.getBounds()) !== JSON.stringify(before) || ed._eachAreaSwap) throw new Error("the selection after: " + JSON.stringify(ed.getBounds()));
    if (!/^Each area: 3 areas queued on your ComfyUI; they run one after another, each result its own layer\\. 1 small speck/.test(ed.status)) throw new Error("the status: " + ed.status);
    return { masks, status: ed.status };
} finally {
    host.connected = saved.connected; host.objectInfo = saved.objectInfo; host.ensureOnServer = saved.ensure; host.missingFilesRefusal = saved.missing; window.fetch = saved.fetch; ed.ask = saved.ask;
    host.setRecipe(saved.recipe);
    if (ed._localRuns) ed._localRuns.clear();
    if (ed.runProgress) for (let i = 1; i <= posts.length; i++) ed.runProgress.done("areas-" + i);
}
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
if (g.areas !== 3 || g.generated !== 3 || g.layers.length !== 3 || g.cancelled || g.failed || g.left_out !== 1) throw new Error("generate each_area: " + JSON.stringify(g));
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
    steps.append(("cleanup", CLEANUP))
    for name, body in steps:
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
