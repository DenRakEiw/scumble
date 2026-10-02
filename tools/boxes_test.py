"""Boxes plugin test against the running app (see tools/cdp.py for the setup; the gate `boxes`).

No ComfyUI and no key needed. Item 28 S3a (docs/PLAN_BOXES.md §10): the commands boxes.add / set / remove / list /
from_selection / clear with their refusals, one undo step per change (the "data" snapshot kind), the selection as a
box (a From box when the prompt names a reference with @img1), the document's boxes through the core's collectBoxes
(image pixels into fractions of a stated frame, an @img token as the layer's picture, a box outside the frame noted,
a from box of a layer the run does not send refusing), the panel's rows in the Generate pane, the boxes following a
crop of the whole picture (and its undo), and a .scumble save and open carrying them. S3b: the Boxes tool through
the pointer and key hooks (draw, move, resize, a click that changes nothing, nudge, duplicate, Alt+click through
stacked boxes, Delete, Escape; one undo step per gesture; the panel row lit) and the overlay on the screen canvas.
S3c: the crop frame (host.cropFrame against the run's prepareCrop, the picture outside it dimmed while the tool is
active) and the panel's warnings (a box outside the crop, one across its edge, one outside the selection, the button
that sets Paste to the whole crop), under FLUX 3 Image, the recipe put back.

    python tools/boxes_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555 --no-comfy
"""
import asyncio
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

OUT = os.path.join(tempfile.gettempdir(), "scumble_boxes_test")

PRE = """(async () => {
    const raw = await import('./commands.js'); const c = (n, a) => raw.commands.run(n, a || {});
    const host = (await import('./editor/host.js')).host;
    const P = await import('./plugins.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const ednow = () => host.editors().find((e) => e.node.id === window.__bDoc) || window.editor;
    const D = () => ({ doc: window.__bDoc });
    const boxes = async () => (await c("boxes.list", D())).boxes;
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const fails = async (fn, re) => { try { await fn(); } catch (e) { if (re.test(String(e.message || e))) return; throw new Error("wrong refusal: " + (e.message || e)); } throw new Error("no refusal for " + re); };
    %s
})()"""

STEPS = [
    ("plugin_loaded", """
const p = (await P.pluginHost.list()).find((x) => x.id === "boxes");
if (!p) throw new Error("boxes plugin not listed");
if (p.error) throw new Error("boxes plugin error: " + p.error);
const cmds = (await c("list_commands")).commands.map((x) => x.name);
for (const n of ["boxes.list", "boxes.add", "boxes.set", "boxes.remove", "boxes.from_selection", "boxes.clear"]) if (!cmds.includes(n)) throw new Error("command missing: " + n);
if (!p.registered.generate.includes("boxes.document")) throw new Error("the generate source is not registered: " + JSON.stringify(p.registered));
const d = await c("new_document");
window.__bDoc = d.id;
host.shell.activate(ednow());
await c("new_canvas", { width: 1200, height: 800, doc: d.id });
const l = await c("boxes.list", D());
if (l.count !== 0 || !("takes" in l.recipe)) throw new Error("empty list: " + JSON.stringify(l));
return { recipe: l.recipe, version: P.API_VERSION };
"""),
    ("add_set_remove_and_refusals", """
// a reference layer for the from boxes: a small paint layer with the role reference
const ref = await c("add_paint_layer", { name: "Lamp", doc: window.__bDoc });
await c("set_layer", { layer: ref.id, role: "reference", x: 500, y: 350, w: 200, h: 100, doc: window.__bDoc });
const plain = await c("add_paint_layer", { name: "Plain", doc: window.__bDoc });
const a = await c("boxes.add", { rect: [100, 100, 400, 300], desc: "a dog", doc: window.__bDoc });
if (!eq(a, { id: "box_1", kind: "new", rect: [100, 100, 400, 300], src: null, layer: null, desc: "a dog", text: null })) throw new Error("add: " + JSON.stringify(a));
const k = await c("boxes.add", { id: "log_1", kind: "keep", rect: { x: 800, y: 600, w: 200, h: 100 }, src: [800, 600, 1000, 700], desc: "a log", doc: window.__bDoc });
if (!eq(k.rect, [800, 600, 1000, 700]) || !eq(k.src, [800, 600, 1000, 700])) throw new Error("keep: " + JSON.stringify(k));
const m = await c("boxes.add", { kind: "move", rect: [600, 100, 900, 400], src: [200, 500, 500, 800], doc: window.__bDoc });
if (m.id !== "move_1") throw new Error("the default id of a move box: " + m.id);
const f = await c("boxes.add", { kind: "from", rect: [900, 500, 1100, 700], layer: "Lamp", desc: "the lamp", doc: window.__bDoc });
if (f.id !== "ref_1" || f.layer !== ref.id || f.src !== null) throw new Error("from: " + JSON.stringify(f));
const t = await c("boxes.add", { id: "sign_1", rect: [50, 700, 400, 780], text: "OPEN", desc: "red neon", doc: window.__bDoc });
if (t.kind !== "new" || t.text !== "OPEN") throw new Error("text box: " + JSON.stringify(t));
if ((await boxes()).length !== 5) throw new Error("count " + (await boxes()).length);
// the refusals: nothing is added by any of them
await fails(() => c("boxes.add", { id: "box_1", rect: [0, 0, 10, 10], doc: window.__bDoc }), /already used/);
await fails(() => c("boxes.add", { id: "Box1", rect: [0, 0, 10, 10], doc: window.__bDoc }), /lowercase name/);
await fails(() => c("boxes.add", { rect: [10, 10, 10, 20], doc: window.__bDoc }), /empty/);
await fails(() => c("boxes.add", { kind: "from", rect: [0, 0, 10, 10], doc: window.__bDoc }), /needs layer/);
await fails(() => c("boxes.add", { kind: "from", rect: [0, 0, 10, 10], layer: "Plain", doc: window.__bDoc }), /not a reference layer/);
await fails(() => c("boxes.add", { kind: "keep", rect: [0, 0, 10, 10], doc: window.__bDoc }), /needs src/);
await fails(() => c("boxes.add", { kind: "keep", rect: [0, 0, 10, 10], src: [0, 0, 10, 10], text: "x", doc: window.__bDoc }), /only a New box renders text/);
await fails(() => c("boxes.add", { kind: "giant", rect: [0, 0, 10, 10], doc: window.__bDoc }), /kind "giant"/);
await fails(() => c("boxes.set", { id: "nope_1", desc: "x", doc: window.__bDoc }), /no box nope_1/);
await fails(() => c("boxes.remove", { id: "nope_1", doc: window.__bDoc }), /no box nope_1/);
if ((await boxes()).length !== 5) throw new Error("a refusal changed the list");
// set: a rename, a kind change (a New box turned Keep takes its rect as the source), a field alone
const s1 = await c("boxes.set", { id: "box_1", new_id: "dog_1", desc: "a brown dog", doc: window.__bDoc });
if (s1.id !== "dog_1" || s1.desc !== "a brown dog" || !eq(s1.rect, [100, 100, 400, 300])) throw new Error("set: " + JSON.stringify(s1));
const s2 = await c("boxes.set", { id: "dog_1", kind: "keep", doc: window.__bDoc });
if (s2.kind !== "keep" || !eq(s2.src, [100, 100, 400, 300])) throw new Error("new to keep: " + JSON.stringify(s2));
const s3 = await c("boxes.set", { id: "dog_1", kind: "new", doc: window.__bDoc });
if (s3.kind !== "new" || s3.src !== null) throw new Error("keep to new: " + JSON.stringify(s3));
await fails(() => c("boxes.set", { id: "dog_1", new_id: "log_1", doc: window.__bDoc }), /already used/);
const r = await c("boxes.remove", { id: "move_1", doc: window.__bDoc });
if (r.count !== 4 || (await boxes()).some((b) => b.id === "move_1")) throw new Error("remove: " + JSON.stringify(r));
window.__bRef = ref.id;
return { ids: (await boxes()).map((b) => b.id) };
"""),
    ("one_undo_step_per_change", """
// every change is one step of the history (the "data" snapshot kind); undo and redo put the data back as it was
const ed = ednow();
const before = JSON.stringify(await boxes());
const h0 = await c("list_history", D());
const names = h0.rows.map((r) => r.label || r.name || "").join("|");
if (!/Add box box_1/.test(names) || !/Remove box move_1/.test(names) || !/Change box dog_1/.test(names)) throw new Error("the steps are not named: " + names);
await c("undo", D());
let now = await boxes();
if (now.length !== 5 || !now.some((b) => b.id === "move_1")) throw new Error("undo of the remove: " + JSON.stringify(now.map((b) => b.id)));
await c("undo", D());
now = await boxes();
if (now.find((b) => b.id === "dog_1").kind !== "keep") throw new Error("undo of the kind change: " + JSON.stringify(now.find((b) => b.id === "dog_1")));
await c("redo", D()); await c("redo", D());
if (JSON.stringify(await boxes()) !== before) throw new Error("redo did not bring the state back");
// undo past every box: the data is empty, the layers untouched
const undos = h0.undo;
for (let i = 0; i < undos; i++) await c("undo", D());
if ((await boxes()).length !== 0) throw new Error("not empty after every undo: " + (await boxes()).length);
for (let i = 0; i < undos; i++) await c("redo", D());
if (JSON.stringify(await boxes()) !== before) throw new Error("redo all did not bring the state back");
return { steps: undos };
"""),
    ("from_selection", """
await c("select_rect", { x: 300, y: 200, w: 200, h: 150, doc: window.__bDoc });
await c("set_prompt", { text: "a red\\ndoor", doc: window.__bDoc });
const b = await c("boxes.from_selection", D());
if (!eq(b, { id: "edit_1", kind: "new", rect: [300, 200, 500, 350], src: null, layer: null, desc: "a red door", text: null })) throw new Error("from selection: " + JSON.stringify(b));
// the prompt names the reference: a From box of that layer into the selection
const lamp = (await c("list_layers", D())).layers.find((l) => l.id === window.__bRef);
if (!lamp || lamp.label !== "img1") throw new Error("the lamp is not @img1: " + JSON.stringify(lamp));
await c("set_prompt", { text: "put @img1 on the table", doc: window.__bDoc });
const f = await c("boxes.from_selection", { desc: undefined, doc: window.__bDoc });
if (f.id !== "edit_2" || f.kind !== "from" || f.layer !== window.__bRef || f.desc !== "put @img1 on the table") throw new Error("from selection with a token: " + JSON.stringify(f));
await c("select_none", D());
await fails(() => c("boxes.from_selection", D()), /Nothing is selected/);
await c("set_prompt", { text: "", doc: window.__bDoc });
return { edit: b.rect, from: f.layer };
"""),
    ("the_generate_source_through_the_core", """
// what a run of a recipe that takes boxes gets: the document's boxes mapped into the frame (the crop) by the core,
// the @img token of a desc as the layer's picture marker, a box outside the frame noted, a from box of a layer the
// run does not send refusing the run
const ed = ednow();
const frame = { x: 0, y: 0, w: 1200, h: 800 };
const refs = [{ index: 2, layerId: window.__bRef, name: "Lamp", frame: { x: 500, y: 350, w: 200, h: 100 } }];
const ctx = { mode: "edit", recipe: "flux3", provider: "bfl", model: "flux-3-image", schema: "flux3", frame, selection: null, references: refs };
const got = await P.collectBoxes(ed, ctx, []);
const by = Object.fromEntries(got.boxes.map((b) => [b.id, b]));
if (got.boxes.length !== 6 || got.notes.length) throw new Error("mapped: " + JSON.stringify(got));
if (!eq(by.dog_1.rect, [100 / 1200, 100 / 800, 400 / 1200, 300 / 800]) || by.dog_1.src !== null) throw new Error("dog_1: " + JSON.stringify(by.dog_1));
if (by.log_1.kind !== "keep" || !eq(by.log_1.src, by.log_1.rect)) throw new Error("log_1: " + JSON.stringify(by.log_1));
if (by.ref_1.kind !== "from" || by.ref_1.ref !== 2 || !eq(by.ref_1.src, [0, 0, 1, 1])) throw new Error("ref_1: " + JSON.stringify(by.ref_1));
if (by.sign_1.desc !== 'text reading "OPEN", red neon') throw new Error("sign_1 desc: " + by.sign_1.desc);
if (by.edit_2.desc !== "put {@ref:2} on the table" || by.edit_2.kind !== "from") throw new Error("edit_2: " + JSON.stringify(by.edit_2));
// a smaller frame (a crop at 0, 0, 600 x 400): the boxes outside it are noted, the ones inside clamped
const small = await P.collectBoxes(ed, { ...ctx, frame: { x: 0, y: 0, w: 600, h: 400 } }, []);
if (!small.notes.some((n) => /log_1/.test(n)) || small.boxes.some((b) => b.id === "log_1")) throw new Error("the box outside the crop went: " + JSON.stringify(small));
if (!eq(small.boxes.find((b) => b.id === "dog_1").rect, [100 / 600, 100 / 400, 400 / 600, 300 / 400])) throw new Error("dog_1 in the small frame: " + JSON.stringify(small.boxes[0]));
// the lamp not sent: the from boxes refuse the run
let err = null;
try { await P.collectBoxes(ed, { ...ctx, references: [] }, []); } catch (e) { err = e; }
if (!err || err.code !== "layer" || !/"Lamp"/.test(err.message)) throw new Error("no refusal for an unsent layer: " + (err && err.message));
// the S1 selection box already holds edit_1: the plugin's edit_1 gets the next number
const taken = await P.collectBoxes(ed, ctx, [{ id: "edit_1" }]);
if (!taken.boxes.some((b) => b.id === "edit_3")) throw new Error("duplicate id not numbered on: " + JSON.stringify(taken.boxes.map((b) => b.id)));
return { ids: got.boxes.map((b) => b.id), notes: small.notes };
"""),
    ("panel_rows_in_the_generate_pane", """
const ed = ednow();
const details = Array.from(ed.panes.gen.querySelectorAll("details")).find((d) => d.querySelector("summary") && d.querySelector("summary").textContent.trim() === "Boxes");
if (!details) throw new Error("no Boxes section in the Generate pane");
details.open = true;
await wait(50);
const rows = details.querySelectorAll(".boxes-row");
if (rows.length !== 6) throw new Error("rows " + rows.length);
const note = details.querySelector(".boxes-note").textContent;
if (!/boxes/.test(note)) throw new Error("no recipe note: " + note);
// the id field of the first row renames through the panel (one undo step)
const idField = rows[0].querySelector(".boxes-id");
idField.value = "hound_1"; idField.dispatchEvent(new Event("change"));
await wait(50);
if (!(await boxes()).some((b) => b.id === "hound_1")) throw new Error("the panel's rename did not land");
if (details.querySelectorAll(".boxes-row").length !== 6) throw new Error("rows after the rename " + details.querySelectorAll(".boxes-row").length);
// a bad value is refused and the field shows the box as it is
const bad = details.querySelector(".boxes-row .boxes-id");
bad.value = "Hound"; bad.dispatchEvent(new Event("change"));
await wait(50);
if (!(await boxes()).some((b) => b.id === "hound_1") || details.querySelector(".boxes-row .boxes-id").value !== "hound_1") throw new Error("a bad id was taken or the field not restored");
if (!/lowercase name/.test(ed.status)) throw new Error("no status for the bad id: " + ed.status);
// the kind select of the first row: New -> Move takes the rect as the source and shows a From row
// the rows were rebuilt by the rename: query the first row again
const sel = details.querySelector(".boxes-row .boxes-select");
sel.value = "move"; sel.dispatchEvent(new Event("change"));
await wait(50);
const hound = (await boxes()).find((b) => b.id === "hound_1");
if (hound.kind !== "move" || !eq(hound.src, hound.rect)) throw new Error("the panel's kind change: " + JSON.stringify(hound));
if (details.querySelector(".boxes-row").querySelectorAll(".boxes-geo").length !== 2) throw new Error("a move box shows one geometry row");
await c("undo", D()); await c("undo", D());
await wait(50);
if ((await boxes()).find((b) => b.id === "dog_1").kind !== "new") throw new Error("the two panel changes were not two undo steps: " + JSON.stringify(await boxes()));
if (details.querySelector(".boxes-row .boxes-id").value !== "dog_1") throw new Error("the panel did not follow the undo");
window.__bNote = note;
return { rows: rows.length, note };
"""),
    ("the_tool_draws_moves_resizes_and_keys", """
// S3b: the Boxes tool through the pointer and key hooks, one undo step per gesture, the panel row lit, the overlay drawn
const ed = ednow();
const before = await boxes();
for (const b of before) for (const r of [b.rect, b.src]) if (r && r[2] > 880 && r[1] < 360) throw new Error("the test's corner is taken by " + b.id);
const undo0 = ed.undo.length;
ed.setTool("boxes.box");
if (ed.tool !== "boxes.box") throw new Error("the tool was not selected: " + ed.tool);
const fake = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, pressure: 0.5, pointerType: "mouse" };
const ptr = (phase, x, y, extra) => { host.pluginPointer(ed, phase, { ...fake, ...(extra || {}), type: "pointer" + phase }, x, y, ed.pointer); if (phase === "up") ed.pointer = null; };
const drag = (pts, extra) => { ptr("down", pts[0][0], pts[0][1], extra); for (const p of pts.slice(1)) ptr("move", p[0], p[1], extra); const l = pts[pts.length - 1]; ptr("up", l[0], l[1], extra); };
const key = (k, shift) => host.pluginKey(ed, { key: k, shiftKey: !!shift, preventDefault() {} }, k.toLowerCase());
const P2 = P.pluginHost.entries().get("boxes");
const selId = () => { const row = ed.panes.gen.querySelector(".boxes-row.boxes-row-sel"); return row ? row.dataset.box : null; };
// draw a New box on empty canvas
drag([[900, 60], [1000, 150], [1100, 250]]);
let now = await boxes();
const made = now.find((b) => !before.some((x) => x.id === b.id));
if (!made || made.kind !== "new" || !eq(made.rect, [900, 60, 1100, 250])) throw new Error("draw: " + JSON.stringify(made));
if (ed.undo.length !== undo0 + 1) throw new Error("drawing should be one undo step: " + (ed.undo.length - undo0));
await wait(50);
if (selId() !== made.id) throw new Error("the new box's row is not lit: " + selId());
// a drag inside moves it, the south-east handle resizes it
drag([[1000, 150], [1030, 180], [1050, 200]]);
now = await boxes();
if (!eq(now.find((b) => b.id === made.id).rect, [950, 110, 1150, 300])) throw new Error("move: " + JSON.stringify(now.find((b) => b.id === made.id)));
drag([[1150, 300], [1160, 315], [1170, 330]]);
now = await boxes();
if (!eq(now.find((b) => b.id === made.id).rect, [950, 110, 1170, 330])) throw new Error("resize: " + JSON.stringify(now.find((b) => b.id === made.id)));
if (ed.undo.length !== undo0 + 3) throw new Error("three gestures, " + (ed.undo.length - undo0) + " undo steps");
// a click without a drag changes nothing
ptr("down", 1000, 200); ptr("up", 1000, 200);
if (ed.undo.length !== undo0 + 3) throw new Error("a click made an undo step");
// Shift+arrow nudges by 10, D duplicates (the copy selected), Delete removes the copy
if (!key("ArrowRight", true)) throw new Error("the arrow was not taken");
if (!eq((await boxes()).find((b) => b.id === made.id).rect, [960, 110, 1180, 330])) throw new Error("nudge: " + JSON.stringify((await boxes()).find((b) => b.id === made.id)));
key("d");
now = await boxes();
const copy = now[now.length - 1];
if (copy.id === made.id || !eq(copy.rect, [970, 120, 1190, 340]) || copy.kind !== "new") throw new Error("duplicate: " + JSON.stringify(copy));
await wait(50);
if (selId() !== copy.id) throw new Error("the copy is not selected: " + selId());
// Alt+click goes through the two boxes under the pointer
ptr("down", 1050, 200, { altKey: true }); ptr("up", 1050, 200, { altKey: true });
await wait(20);
if (selId() !== made.id) throw new Error("alt+click did not pick the box below: " + selId());
ptr("down", 1050, 200, { altKey: true }); ptr("up", 1050, 200, { altKey: true });
await wait(20);
if (selId() !== copy.id) throw new Error("the second alt+click did not come round: " + selId());
key("Delete");
if ((await boxes()).some((b) => b.id === copy.id)) throw new Error("Delete did not remove the copy");
if (ed.undo.length !== undo0 + 6) throw new Error("nudge, duplicate and delete should be three undo steps: " + (ed.undo.length - undo0));
// Escape lets go of the selection, a key with nothing selected is the editor's
ptr("down", 1000, 200); ptr("up", 1000, 200);
if (!key("Escape") || selId() !== null) throw new Error("Escape did not deselect");
if (key("Delete")) throw new Error("Delete with nothing selected was taken");
// the overlay: the box's green on the screen canvas while the tool is active, nothing once another tool is and the panel is closed
const g = ed.canvas.getContext("2d");
const green = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); const d = g.getImageData(Math.round(sx) - 3, Math.round(sy), 7, 1).data; for (let i = 0; i < d.length; i += 4) if (d[i + 1] - d[i] > 90 && d[i + 1] > 150) return true; return false; };
ed.draw();
if (!green(960, 220)) throw new Error("no box drawn on the canvas while the tool is active");
const details = Array.from(ed.panes.gen.querySelectorAll("details")).find((d) => d.querySelector("summary") && d.querySelector("summary").textContent.trim() === "Boxes");
details.open = false;
ed.setTool("select");
await wait(30);
ed.draw();
if (green(960, 220)) throw new Error("the box is drawn with another tool and the panel closed");
details.open = true;
await wait(30);
ed.draw();
const shown = details.getClientRects().length > 0;
if (shown && !green(960, 220)) throw new Error("the panel is open and shown, but the box is not drawn");
// back to the boxes as they were: six steps undone
for (let i = 0; i < 6; i++) await c("undo", D());
if (JSON.stringify(await boxes()) !== JSON.stringify(before)) throw new Error("the undo did not put the boxes back: " + JSON.stringify(await boxes()));
return { made: made.id, copy: copy.id, panelShown: shown, plugin: !!P2 };
"""),
    ("the_crop_frame_and_the_paste_warning", """
// S3c: the crop Generate sends, as the run plans it, drawn while the tool is active; the panel's warnings for a box the
// crop leaves out, one its edge cuts, one outside the selection while Paste keeps the selection only, and the button
// that sets Paste to the whole crop. FLUX 3 Image is selected for the step (it takes boxes) and the recipe put back.
const ed = ednow();
const was = host.recipe ? { id: host.recipe.id, provider: host.recipe.kind === "provider" ? host.recipe.provider : undefined } : null;
const before = await boxes();
const S = await import('./editor/stitch.js');
try {
    await c("select_recipe", { id: "flux3", provider: "bfl" });
    await c("select_rect", { x: 300, y: 200, w: 200, h: 150, doc: window.__bDoc });
    await c("set_crop", { paste: "selection", doc: window.__bDoc });
    // the frame is the run's crop: planCrop on the selection's mask (prepareCrop) gives the same box
    const f = host.cropFrame(ed);
    const run = S.prepareCrop(ed, host.nodeParams, host.cropLimits(), { references: false });
    if (!f || !eq([f.x, f.y, f.w, f.h], run.info.bbox) || !eq(f.emitted, run.info.emitted)) throw new Error("the frame is not the run's crop: " + JSON.stringify([f, run.info.bbox, run.info.emitted]));
    const F = [f.x, f.y, f.x + f.w, f.y + f.h];
    if (F[0] < 30 || F[2] > 1100 || F[3] > 720) throw new Error("the test's boxes need room around the crop: " + JSON.stringify(F));
    // three boxes: outside the crop, across its left edge, inside it but outside the selection
    await c("boxes.add", { id: "far_1", rect: [1120, 730, 1180, 790], doc: window.__bDoc });
    await c("boxes.add", { id: "edge_1", rect: [F[0] - 20, F[1] + 10, F[0] + 40, F[1] + 60], doc: window.__bDoc });
    await c("boxes.add", { id: "spill_1", rect: [F[0] + 5, F[3] - 40, F[0] + 45, F[3] - 5], doc: window.__bDoc });
    const details = Array.from(ed.panes.gen.querySelectorAll("details")).find((d) => d.querySelector("summary") && d.querySelector("summary").textContent.trim() === "Boxes");
    details.open = true;
    await wait(50);
    const rows = () => Array.from(details.querySelectorAll(".boxes-warn-row")).map((r) => r.textContent);
    const w1 = rows();
    const line = (re) => w1.find((t) => re.test(t)) || "";
    if (!/far_1/.test(line(/left out/)) || /edge_1|spill_1/.test(line(/left out/))) throw new Error("the box outside the crop: " + JSON.stringify(w1));
    if (!/edge_1/.test(line(/past the crop's edge/)) || /spill_1/.test(line(/past the crop's edge/))) throw new Error("the box across the crop's edge: " + JSON.stringify(w1));
    const spill = line(/outside the selection/);
    if (!/spill_1/.test(spill) || !/edge_1/.test(spill) || /far_1|edit_1/.test(spill)) throw new Error("the boxes outside the selection: " + JSON.stringify(w1));
    const note = details.querySelector(".boxes-note").textContent;
    if (!note.includes(`${f.w} × ${f.h} px at ${f.x}, ${f.y}`)) throw new Error("the note does not name the crop: " + note);
    // the overlay: the picture outside the crop dimmed while the tool is active, not with another tool
    const g = ed.canvas.getContext("2d");
    const lum = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); const d = g.getImageData(Math.round(sx), Math.round(sy), 1, 1).data; return d[0] + d[1] + d[2]; };
    details.open = false;
    ed.setTool("select"); await wait(30); ed.draw();
    // two points no box covers: one outside the crop, one inside it near its top right corner
    const pin = [F[2] - 15, F[1] + 15];
    for (const b of await boxes()) for (const r of [b.rect, b.src]) if (r && pin[0] >= r[0] && pin[0] <= r[2] && pin[1] >= r[1] && pin[1] <= r[3]) throw new Error("the inside point lies in " + b.id);
    const plain = lum(1150, 40), inside = lum(pin[0], pin[1]);
    ed.setTool("boxes.box"); await wait(30); ed.draw();
    const dim = lum(1150, 40), inside2 = lum(pin[0], pin[1]);
    if (!(dim < plain * 0.85) || Math.abs(inside2 - inside) > 6) throw new Error("the crop's frame: outside " + plain + " -> " + dim + ", inside " + inside + " -> " + inside2);
    ed.setTool("select");
    // the button sets Paste to the whole crop for this document; the selection's warning goes, the others stay
    details.open = true;
    await wait(30);
    const btn = Array.from(details.querySelectorAll(".boxes-warn-row button")).find((b) => /whole crop/.test(b.textContent));
    if (!btn) throw new Error("no button in the selection's warning");
    btn.click();
    await wait(80);
    if (ed.cropSettings.paste !== "crop" || ed.cropPasteSel.value !== "whole crop") throw new Error("paste was not set: " + JSON.stringify(ed.cropSettings) + " / " + ed.cropPasteSel.value);
    const w2 = rows();
    if (w2.some((t) => /outside the selection/.test(t)) || !w2.some((t) => /far_1/.test(t))) throw new Error("the warnings after the paste: " + JSON.stringify(w2));
    // a recipe without boxes shows no warnings
    if (was && was.id !== "flux3") {
        await c("select_recipe", was);
        await wait(50);
        if (rows().length) throw new Error("warnings under a recipe that takes no boxes: " + JSON.stringify(rows()));
    }
    return { frame: [f.x, f.y, f.w, f.h], emitted: f.emitted, warnings: w1, dim: [plain, dim] };
} finally {
    ed.setTool("select");
    await c("set_crop", { paste: "selection", doc: window.__bDoc });
    while ((await boxes()).length > before.length) await c("undo", D());
    await c("select_none", D());
    if (was) await c("select_recipe", was);
    if (JSON.stringify(await boxes()) !== JSON.stringify(before)) throw new Error("the test's boxes were not taken back");
}
"""),
    ("boxes_follow_a_crop_and_its_undo", """
const before = await boxes();
await c("extend_canvas", { left: -100, top: -50, doc: window.__bDoc });
const ed = ednow();
if (ed.width !== 1100 || ed.height !== 750) throw new Error("the crop made " + ed.width + " x " + ed.height);
const after = await boxes();
const dog = after.find((b) => b.id === "dog_1"), log = after.find((b) => b.id === "log_1");
if (!eq(dog.rect, [0, 50, 300, 250]) || !eq(log.src, [700, 550, 900, 650]) || !eq(log.rect, [700, 550, 900, 650])) throw new Error("the boxes did not follow the crop: " + JSON.stringify([dog, log]));
await c("undo", D());
if (JSON.stringify(await boxes()) !== JSON.stringify(before) || ed.width !== 1200) throw new Error("the crop's undo did not put the boxes back");
await c("redo", D());
if (!eq((await boxes()).find((b) => b.id === "dog_1").rect, [0, 50, 300, 250])) throw new Error("the crop's redo did not move the boxes again");
await c("undo", D());
return { dog: dog.rect };
"""),
    ("a_scumble_file_carries_the_boxes", """
const before = await boxes();
const path = window.__bPath;
await c("save_document", { path, doc: window.__bDoc });
await c("close_document", { doc: window.__bDoc, force: true });
const o = await c("open_document", { path });
window.__bDoc = o.id;
const after = await boxes();
if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error("the boxes after the open differ: " + JSON.stringify(after));
const n = await c("boxes.clear", D());
if (n.removed !== 6 || (await boxes()).length) throw new Error("clear: " + JSON.stringify(n));
await c("undo", D());
if ((await boxes()).length !== 6) throw new Error("the clear's undo");
await c("close_document", { doc: window.__bDoc, force: true });
return { boxes: after.length };
"""),
]


async def main():
    sys.stdout.reconfigure(encoding="utf-8")
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "boxes.scumble")
    if os.path.exists(path):
        os.remove(path)

    async def run(cdp):
        ev = cdp.eval
        await ev("window.__bPath = %s; 1" % json.dumps(path))
        for name, body in STEPS:
            try:
                res = await ev(PRE % body, timeout=180)
                print(f"PASS {name}: {json.dumps(res)[:300]}")
            except Exception as err:  # noqa: BLE001
                print(f"FAIL {name}: {err}")
                try:
                    await ev(PRE % 'if (window.__bDoc) await c("close_document", { doc: window.__bDoc, force: true }); return 1;')
                except Exception:  # noqa: BLE001
                    pass
                print("RESULT FAIL")
                return False
        print("RESULT PASS")
        return True

    return await session(run)


if __name__ == "__main__":
    sys.exit(0 if asyncio.run(main()) else 1)
