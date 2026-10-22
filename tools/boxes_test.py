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
that sets Paste to the whole crop), under FLUX 3 Image, the recipe put back. S3d: the Boxes switch under the prompt
(the row hidden under a recipe that takes no boxes, the first box turning it on, the label's count, a loopback run
with it on and off, the panel's note and the overlay's dashed outline while off, a box the crop leaves out keeping the
selection from going as a box, the selection as one box with none, the switch carried by a .scumble file). S3e: ids
from the description (a default id only, not one the prompt names), the warnings for a New box without a description
and for a small box, a run's caption with the places in words and its notes, the smallest box under a click, a box
turned into Move stepping aside. A local recipe (flux3_klein_local, its `boxes`): the row shows, the canvas state carries
the boxes, a run takes the declared input from the Inpaint Canvas node's box_prompt (found by name), the switch off keeps
the plain prompt, an older node refuses before anything is uploaded (generate_new before its fresh canvas wipes the
picture), a recipe without the declaration is unchanged (the node's box notes of its runs ignored), an @img token in a
description goes as the recipe's name for its picture, a From box whose layer does not go and boxes stored while the
Boxes plugin is off do not count, and Generate new scales the boxes to the fresh canvas, leaves out Keep, Move and Remove
boxes and measures From boxes before the wipe (the queue and the node list stubbed in the page).

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
for (const n of ["boxes.list", "boxes.check", "boxes.add", "boxes.set", "boxes.remove", "boxes.from_selection", "boxes.clear"]) if (!cmds.includes(n)) throw new Error("command missing: " + n);
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
// the document's first box turns its Boxes switch on (S3d) and says so
// no id given: the id is made from the description's words (S3e)
if (!eq(a, { id: "dog_1", kind: "new", rect: [100, 100, 400, 300], src: null, layer: null, desc: "a dog", text: null, colour: 0, switched_on: true })) throw new Error("add: " + JSON.stringify(a));
if (!ednow().genSettings.boxes) throw new Error("the first box did not turn the switch on");
// the note says what is true under the selected recipe: a recipe that takes no boxes hides the switch
const takes0 = (await c("boxes.list", D())).recipe.takes;
if (!(takes0 ? /under the prompt is on now/ : /Boxes switch is on for this document/).test(ednow().status)) throw new Error("the switch's note under this recipe (takes " + takes0 + "): " + ednow().status);
const k = await c("boxes.add", { id: "log_1", kind: "keep", rect: { x: 800, y: 600, w: 200, h: 100 }, src: [800, 600, 1000, 700], desc: "a log", doc: window.__bDoc });
if (!eq(k.rect, [800, 600, 1000, 700]) || !eq(k.src, [800, 600, 1000, 700])) throw new Error("keep: " + JSON.stringify(k));
const m = await c("boxes.add", { kind: "move", rect: [600, 100, 900, 400], src: [200, 500, 500, 800], doc: window.__bDoc });
if (m.id !== "move_1") throw new Error("the default id of a move box: " + m.id);
const f = await c("boxes.add", { kind: "from", rect: [900, 500, 1100, 700], layer: "Lamp", desc: "the lamp", doc: window.__bDoc });
if (f.id !== "lamp_1" || f.layer !== ref.id || f.src !== null) throw new Error("from: " + JSON.stringify(f));
const t = await c("boxes.add", { id: "sign_1", rect: [50, 700, 400, 780], text: "OPEN", desc: "red neon", doc: window.__bDoc });
if (t.kind !== "new" || t.text !== "OPEN") throw new Error("text box: " + JSON.stringify(t));
if ((await boxes()).length !== 5) throw new Error("count " + (await boxes()).length);
// the refusals: nothing is added by any of them
await fails(() => c("boxes.add", { id: "dog_1", rect: [0, 0, 10, 10], doc: window.__bDoc }), /already used/);
await fails(() => c("boxes.add", { id: "Box1", rect: [0, 0, 10, 10], doc: window.__bDoc }), /lowercase words/);
await fails(() => c("boxes.add", { rect: [10, 10, 10, 20], doc: window.__bDoc }), /empty/);
await fails(() => c("boxes.add", { kind: "from", rect: [0, 0, 10, 10], doc: window.__bDoc }), /needs layer/);
await fails(() => c("boxes.add", { kind: "from", rect: [0, 0, 10, 10], layer: "Plain", doc: window.__bDoc }), /not a reference layer/);
await fails(() => c("boxes.add", { kind: "keep", rect: [0, 0, 10, 10], doc: window.__bDoc }), /needs src/);
await fails(() => c("boxes.add", { kind: "keep", rect: [0, 0, 10, 10], src: [0, 0, 10, 10], text: "x", doc: window.__bDoc }), /only a New box renders text/);
await fails(() => c("boxes.add", { kind: "giant", rect: [0, 0, 10, 10], doc: window.__bDoc }), /kind "giant"/);
await fails(() => c("boxes.set", { id: "nope_1", desc: "x", doc: window.__bDoc }), /no box nope_1/);
await fails(() => c("boxes.remove", { id: "nope_1", doc: window.__bDoc }), /no box nope_1/);
if ((await boxes()).length !== 5) throw new Error("a refusal changed the list");
// set: a field alone (an id made from words stays when the description changes), a kind change (a New box turned
// Keep takes its rect as the source), a rename
const s1 = await c("boxes.set", { id: "dog_1", desc: "a brown dog", doc: window.__bDoc });
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
if (!/Add box dog_1/.test(names) || !/Remove box move_1/.test(names) || !/Change box dog_1/.test(names)) throw new Error("the steps are not named: " + names);
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
if (!eq({ ...b, colour: undefined }, { id: "red_door_1", kind: "new", rect: [300, 200, 500, 350], src: null, layer: null, desc: "a red door", text: null })) throw new Error("from selection: " + JSON.stringify(b));
// the prompt names the reference: a From box of that layer into the selection
const lamp = (await c("list_layers", D())).layers.find((l) => l.id === window.__bRef);
if (!lamp || lamp.label !== "img1") throw new Error("the lamp is not @img1: " + JSON.stringify(lamp));
await c("set_prompt", { text: "put @img1 on the table", doc: window.__bDoc });
const f = await c("boxes.from_selection", { desc: undefined, doc: window.__bDoc });
if (f.id !== "table_1" || f.kind !== "from" || f.layer !== window.__bRef || f.desc !== "put @img1 on the table") throw new Error("from selection with a token: " + JSON.stringify(f));
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
if (by.lamp_1.kind !== "from" || by.lamp_1.ref !== 2 || !eq(by.lamp_1.src, [0, 0, 1, 1])) throw new Error("lamp_1: " + JSON.stringify(by.lamp_1));
if (by.sign_1.desc !== "red neon" || by.sign_1.text !== "OPEN") throw new Error("sign_1 desc / text: " + JSON.stringify(by.sign_1));
if ("text" in by.dog_1) throw new Error("a box without words got text: " + JSON.stringify(by.dog_1));
if (by.table_1.desc !== "put {@ref:2} on the table" || by.table_1.kind !== "from") throw new Error("table_1: " + JSON.stringify(by.table_1));
// a smaller frame (a crop at 0, 0, 600 x 400): the boxes outside it are noted, the ones inside clamped
const small = await P.collectBoxes(ed, { ...ctx, frame: { x: 0, y: 0, w: 600, h: 400 } }, []);
if (!small.notes.some((n) => /log_1/.test(n)) || small.boxes.some((b) => b.id === "log_1")) throw new Error("the box outside the crop went: " + JSON.stringify(small));
if (!eq(small.boxes.find((b) => b.id === "dog_1").rect, [100 / 600, 100 / 400, 400 / 600, 300 / 400])) throw new Error("dog_1 in the small frame: " + JSON.stringify(small.boxes[0]));
// the lamp not sent: the from boxes refuse the run
let err = null;
try { await P.collectBoxes(ed, { ...ctx, references: [] }, []); } catch (e) { err = e; }
if (!err || err.code !== "layer" || !/"Lamp"/.test(err.message)) throw new Error("no refusal for an unsent layer: " + (err && err.message));
// a box the run already holds named red_door_1 (collectBoxes' `taken`): the plugin's red_door_1 gets the next number
const taken = await P.collectBoxes(ed, ctx, [{ id: "red_door_1" }]);
if (!taken.boxes.some((b) => b.id === "red_door_2")) throw new Error("duplicate id not numbered on: " + JSON.stringify(taken.boxes.map((b) => b.id)));
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
if (!/lowercase words/.test(ed.status)) throw new Error("no status for the bad id: " + ed.status);
// the kind select of the first row: New -> Move takes the rect as the source, the target steps aside by a fifth of
// the picture (S3e: 1200 / 5 to the right), and shows a From row
// the rows were rebuilt by the rename: query the first row again
const sel = details.querySelector(".boxes-row .boxes-select");
sel.value = "move"; sel.dispatchEvent(new Event("change"));
await wait(50);
const hound = (await boxes()).find((b) => b.id === "hound_1");
if (hound.kind !== "move" || !eq(hound.src, [100, 100, 400, 300]) || !eq(hound.rect, [340, 100, 640, 300])) throw new Error("the panel's kind change: " + JSON.stringify(hound));
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
// the overlay: the box's own colour (its panel row's border) on the screen canvas while the tool is active, nothing once
// another tool is and the panel is closed
const g = ed.canvas.getContext("2d");
const own = ed.panes.gen.querySelector(`.boxes-row[data-box="${made.id}"]`).style.borderLeftColor.match(/\\d+/g).map(Number);
const green = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); const d = g.getImageData(Math.round(sx) - 3, Math.round(sy), 7, 1).data; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - own[0]) < 40 && Math.abs(d[i + 1] - own[1]) < 40 && Math.abs(d[i + 2] - own[2]) < 40) return true; return false; };
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
    if (!/spill_1/.test(spill) || !/edge_1/.test(spill) || /far_1|red_door_1/.test(spill)) throw new Error("the boxes outside the selection: " + JSON.stringify(w1));
    const note = details.querySelector(".boxes-note").textContent;
    if (!note.includes(`${f.w} × ${f.h} px at ${f.x}, ${f.y}`)) throw new Error("the note does not name the crop: " + note);
    // docs/PLAN_0_1_50.md Q7: boxes.check says what the panel warns of, without a run: the same lines, the ids, the crop
    const k1 = await c("boxes.check", D());
    if (!k1.sent || k1.note !== note || k1.warnings.length !== w1.length || !w1.every((t, i) => t.startsWith(k1.warnings[i]))
        || !k1.out.includes("far_1") || k1.out.includes("edge_1") || !k1.cut.includes("edge_1") || k1.cut.includes("spill_1") || !k1.spill.includes("spill_1") || !k1.spill.includes("edge_1") || k1.spill.includes("far_1")
        || !eq([k1.crop.x, k1.crop.y, k1.crop.w, k1.crop.h], [f.x, f.y, f.w, f.h]) || k1.crop.paste !== "selection") throw new Error("boxes.check against the panel: " + JSON.stringify({ k1, w1, note }));
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
    const k2 = await c("boxes.check", D());
    if (k2.spill.length || !k2.out.includes("far_1") || k2.warnings.length !== w2.length || k2.crop.paste !== "crop") throw new Error("boxes.check after the paste: " + JSON.stringify(k2));
    // a recipe without boxes shows no warnings
    if (was && was.id !== "flux3") {
        await c("select_recipe", was);
        await wait(50);
        if (rows().length) throw new Error("warnings under a recipe that takes no boxes: " + JSON.stringify(rows()));
        const k3 = await c("boxes.check", D());
        if (k3.sent || k3.warnings.length || k3.out.length || k3.note !== details.querySelector(".boxes-note").textContent) throw new Error("boxes.check under a recipe that takes no boxes: " + JSON.stringify(k3));
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
    ("ids_warnings_caption_and_hit_order", """
// S3e: a box named after its description while its id is a default one, the panel's warnings for a New box without a
// description and for a small box, a run's caption with the places in words and its notes (a loopback recipe that
// takes boxes, no key), the tool's hit order (the smallest box under the pointer) and a box turned into Move stepping
// aside from its source. A document of its own; the recipe put back.
const main = window.__bDoc;
const prev = host.recipe;
const LOOP = { id: "loopback_boxes", kind: "provider", provider: "loopback", providerLabel: "Loopback", model: "loopback", input: "edit", name: "Loopback", settings: [], options: { boxes: "flux3" } };
const out = {};
try {
    const d = await c("new_document");
    window.__bDoc = d.id;
    const ed = ednow();
    host.shell.activate(ed);
    await c("new_canvas", { width: 1200, height: 800, doc: d.id });
    host.setRecipe(LOOP);
    const details = Array.from(ed.panes.gen.querySelectorAll("details")).find((x) => x.querySelector("summary") && x.querySelector("summary").textContent.trim() === "Boxes");
    if (!details) throw new Error("no Boxes section in the new document's Generate pane");
    details.open = true;
    const warns = () => Array.from(details.querySelectorAll(".boxes-warn-row")).map((r) => r.textContent);
    const selId = () => { const row = ed.panes.gen.querySelector(".boxes-row.boxes-row-sel"); return row ? row.dataset.box : null; };
    const fake = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, pressure: 0.5, pointerType: "mouse" };
    const ptr = (phase, x, y, extra) => { host.pluginPointer(ed, phase, { ...fake, ...(extra || {}), type: "pointer" + phase }, x, y, ed.pointer); if (phase === "up") ed.pointer = null; };
    const drag = (pts) => { ptr("down", pts[0][0], pts[0][1]); for (const p of pts.slice(1)) ptr("move", p[0], p[1]); const l = pts[pts.length - 1]; ptr("up", l[0], l[1]); };
    const click = (x, y, extra) => { ptr("down", x, y, extra); ptr("up", x, y, extra); };
    const key = (k) => host.pluginKey(ed, { key: k, shiftKey: false, preventDefault() {} }, k.toLowerCase());
    // a drawn box is box_1; described, it is named after its first two telling words and stays selected
    ed.setTool("boxes.box");
    drag([[100, 100], [250, 200], [400, 300]]);
    if ((await boxes()).map((b) => b.id).join() !== "box_1") throw new Error("the drawn box: " + JSON.stringify(await boxes()));
    // the panel warns of a New box without a description
    await wait(50);
    if (!warns().some((t) => /^Box box_1 has no description/.test(t))) throw new Error("no warning for the box without a description: " + JSON.stringify(warns()));
    const r1 = await c("boxes.set", { id: "box_1", desc: "A red scarf", doc: d.id });
    if (r1.id !== "red_scarf_1" || !/Box box_1 is called red_scarf_1 now/.test(ed.status)) throw new Error("named after its description: " + JSON.stringify(r1) + " / " + ed.status);
    await wait(50);
    if (selId() !== "red_scarf_1") throw new Error("the renamed box is not selected: " + selId());
    if (warns().some((t) => /no description/.test(t))) throw new Error("the warning stayed after the description: " + JSON.stringify(warns()));
    // an id once made from words stays when the description changes again
    if ((await c("boxes.set", { id: "red_scarf_1", desc: "a blue hat", doc: d.id })).id !== "red_scarf_1") throw new Error("a made id changed");
    // a default id the prompt names as <box_1> stays; one added with a description is named at once
    const b1 = await c("boxes.add", { rect: [700, 100, 1000, 400], doc: d.id });
    if (b1.id !== "box_1") throw new Error("the next default id: " + b1.id);
    await c("set_prompt", { text: "put <box_1> on the left", doc: d.id });
    if ((await c("boxes.set", { id: "box_1", desc: "a green lamp", doc: d.id })).id !== "box_1") throw new Error("a box the prompt names was renamed");
    await c("set_prompt", { text: "", doc: d.id });
    const t1 = await c("boxes.add", { rect: [500, 500, 700, 700], desc: "the old tree", doc: d.id });
    if (t1.id !== "old_tree_1") throw new Error("added with a description: " + t1.id);
    // the tool's hit order: a click on a small box inside bigger ones takes the small one, though a bigger one lies on
    // top of it (cloth_1, added after it); Alt+click goes on by size
    await c("boxes.add", { id: "pin_1", rect: [150, 150, 250, 250], desc: "a pin", doc: d.id });
    await c("boxes.add", { id: "cloth_1", rect: [120, 120, 300, 280], desc: "a cloth", doc: d.id });
    key("Escape");
    click(200, 200);
    await wait(20);
    if (selId() !== "pin_1") throw new Error("the click took " + selId() + ", not the smaller box");
    click(200, 200, { altKey: true });
    await wait(20);
    if (selId() !== "cloth_1") throw new Error("Alt+click did not go on to the next bigger box: " + selId());
    ed.setTool("select");
    await c("boxes.remove", { id: "cloth_1", doc: d.id });
    // turned into Move, the target steps aside by a fifth of the picture: right, or left at the right edge
    const m1 = await c("boxes.set", { id: "old_tree_1", kind: "move", doc: d.id });
    if (!eq(m1.src, [500, 500, 700, 700]) || !eq(m1.rect, [740, 500, 940, 700])) throw new Error("a New box turned Move: " + JSON.stringify(m1));
    const m2 = await c("boxes.set", { id: "box_1", kind: "move", doc: d.id });
    if (!eq(m2.src, [700, 100, 1000, 400]) || !eq(m2.rect, [460, 100, 760, 400])) throw new Error("a box at the right edge turned Move: " + JSON.stringify(m2));
    // turned Keep with a rect given (and text: null, as the panel's kind select sends it): the rect is where the element
    // is, and a kind change is no new description, so a default id stays
    await c("boxes.add", { id: "box_7", rect: [900, 600, 1000, 700], desc: "a stone", doc: d.id });
    const k7 = await c("boxes.set", { id: "box_7", kind: "keep", text: null, rect: [880, 580, 1000, 700], doc: d.id });
    if (k7.id !== "box_7" || !eq(k7.src, [880, 580, 1000, 700]) || !eq(k7.rect, [880, 580, 1000, 700])) throw new Error("a New box turned Keep with a rect: " + JSON.stringify(k7));
    await c("boxes.remove", { id: "box_7", doc: d.id });
    // a selection and its crop: a small box warned of in the panel, a run's caption and notes
    await c("boxes.add", { id: "dot_1", rect: [110, 110, 118, 118], desc: "a dot", doc: d.id });
    await c("boxes.add", { rect: [300, 150, 380, 250], doc: d.id });
    await c("select_rect", { x: 100, y: 100, w: 300, h: 200, doc: d.id });
    await wait(50);
    const w = warns();
    if (!w.some((t) => /dot_1 (is|are) small/.test(t))) throw new Error("no warning for the small box: " + JSON.stringify(w));
    if (!w.some((t) => /box_2 has no description/.test(t))) throw new Error("no warning for box_2: " + JSON.stringify(w));
    const g = await c("generate", { timeout: 60 });
    const sent = String(g.prompt_sent || "");
    if (!/[Pp]lace a blue hat <red_scarf_1> (at|on|in) the [a-z ]+\\./.test(sent)) throw new Error("the caption does not place the hat: " + sent);
    if (!/Fill the area <box_2> /.test(sent) || !sent.includes("Leave the rest of the picture as it is. [")) throw new Error("the caption: " + sent);
    const notes = (g.notes || []).join(" ");
    if (!/dot_1 (is|are) small/.test(notes) || !/box_2 went without a description/.test(notes)) throw new Error("the run's notes: " + notes);
    out.caption = sent.slice(0, sent.indexOf(" [{"));
    out.notes = g.notes;
    return out;
} finally {
    if (window.__bDoc !== main) { try { await c("close_document", { doc: window.__bDoc, force: true }); } catch (_) { /* gone */ } }
    window.__bDoc = main;
    host.setRecipe(prev);
    host.shell.activate(ednow());
}
"""),
    ("the_boxes_switch", """
// S3d: one switch under the prompt field. A document of its own (the main one keeps its boxes), a loopback recipe
// that takes boxes (no key), the core's collectBoxes counted through a wrapped host.plugins; all put back.
const main = window.__bDoc;
const prev = host.recipe;
const orig = host.plugins;
const path = window.__bPath.replace(/boxes[.]scumble$/, "switch.scumble");
const LOOP = { id: "loopback_boxes", kind: "provider", provider: "loopback", providerLabel: "Loopback", model: "loopback", input: "edit", name: "Loopback", settings: [] };
let calls = 0;
const out = {};
try {
    const d = await c("new_document");
    window.__bDoc = d.id;
    const ed = ednow();
    host.shell.activate(ed);
    await c("new_canvas", { width: 1200, height: 800, doc: d.id });
    if (ed.genSettings.boxes) throw new Error("a new document starts with the switch on");
    // the row: shown under a recipe that takes boxes, hidden again under one that does not, then shown for the step
    host.setRecipe({ ...LOOP, options: { boxes: "flux3" } });
    if (!ed.boxesRow || ed.boxesRow.hidden || ed.boxesLabel.textContent !== "Boxes" || ed.boxesCheck.checked) throw new Error("the row under a recipe that takes boxes: " + JSON.stringify([ed.boxesRow && ed.boxesRow.hidden, ed.boxesLabel.textContent, ed.boxesCheck.checked]));
    if (!ed.promptInput.closest(".ipc-prompt").nextElementSibling || ed.promptInput.closest(".ipc-prompt").nextElementSibling !== ed.boxesRow) throw new Error("the row is not right under the prompt field");
    host.setRecipe(LOOP);
    if (!ed.boxesRow.hidden) throw new Error("the Boxes row shows under a recipe that takes no boxes");
    host.setRecipe({ ...LOOP, options: { boxes: "flux3" } });
    if (ed.boxesRow.hidden) throw new Error("the Boxes row did not come back");
    // the first box turns it on with a note, the second does not; the label counts them
    const a = await c("boxes.add", { id: "dog_1", rect: [100, 100, 400, 300], desc: "a dog", doc: d.id });
    if (!a.switched_on || !ed.genSettings.boxes || !ed.boxesCheck.checked) throw new Error("the first box did not turn the switch on: " + JSON.stringify(a));
    if (!/Boxes switch under the prompt is on/.test(ed.status)) throw new Error("no note in the status: " + ed.status);
    const b = await c("boxes.add", { id: "cat_1", rect: [600, 400, 800, 600], desc: "a cat", doc: d.id });
    if (b.switched_on) throw new Error("the second box reported the switch");
    if (ed.boxesLabel.textContent !== "Boxes \u00b7 2" || ed.boxesHint.textContent !== "") throw new Error("the label: " + ed.boxesLabel.textContent + " / " + ed.boxesHint.textContent);
    if (!(await c("boxes.list", D())).switch) throw new Error("boxes.list does not say the switch is on");
    // on: a run sends both boxes, asking the sources once
    host.plugins = { ...orig, boxes: (...x) => { calls++; return orig.boxes(...x); } };
    await c("set_prompt", { text: "a garden", doc: d.id });
    await c("select_rect", { x: 100, y: 100, w: 700, h: 500, doc: d.id });
    let g = await c("generate", { timeout: 60 });
    if (g.boxes !== 2 || calls !== 1 || !String(g.prompt_sent).endsWith("]")) throw new Error("a run with the switch on: " + JSON.stringify({ boxes: g.boxes, calls, prompt: g.prompt_sent }));
    // off (set_generation): no box goes and the sources are not asked, the boxes stay, a note says so
    const off = await c("set_generation", { boxes: false, doc: d.id });
    if (off.boxes !== false || ed.boxesCheck.checked || ed.boxesHint.textContent !== "not sent") throw new Error("set_generation boxes false: " + JSON.stringify(off) + " " + ed.boxesHint.textContent);
    if ((await c("status", D())).generation.boxes !== false) throw new Error("status does not report the switch");
    g = await c("generate", { timeout: 60 });
    if (g.boxes !== 0 || calls !== 1 || String(g.prompt_sent).includes("dog_1")) throw new Error("a run with the switch off: " + JSON.stringify({ boxes: g.boxes, calls, prompt: g.prompt_sent }));
    if (!(g.notes || []).some((n) => /2 boxes did not go: the Boxes switch under the prompt is off/.test(n))) throw new Error("no note for the boxes left home: " + JSON.stringify(g.notes));
    if ((await boxes()).length !== 2) throw new Error("switching off took boxes away");
    // the panel says it, the overlay draws the boxes dashed and paler (a recording context: the outline's dash and alpha)
    const details = Array.from(ed.panes.gen.querySelectorAll("details")).find((x) => x.querySelector("summary") && x.querySelector("summary").textContent.trim() === "Boxes");
    const note = details ? details.querySelector(".boxes-note").textContent : "";
    if (!/Not sent: the Boxes switch under the prompt is off/.test(note)) throw new Error("the panel's note while off: " + note);
    const outlineOf = () => {
        const cv = new OffscreenCanvas(64, 64), real = cv.getContext("2d"), rec = [];
        const ctx = new Proxy(real, {
            get(t, k) { const v = t[k]; if (typeof v !== "function") return v; return (...x) => { if (k === "strokeRect" && x[0] === 100 && x[1] === 100 && x[2] === 300) rec.push({ dash: t.getLineDash().length > 0, alpha: t.globalAlpha }); return v.apply(t, x); }; },
            set(t, k, v) { t[k] = v; return true; },
        });
        host.plugins.overlay(ed, ctx);
        return rec;
    };
    ed.setTool("boxes.box");
    const dim = outlineOf();
    await c("set_generation", { boxes: true, doc: d.id });
    const lit = outlineOf();
    ed.setTool("select");
    if (!dim.length || !dim.every((r) => r.dash && r.alpha < 1)) throw new Error("the outline while off is not dashed and paler: " + JSON.stringify(dim));
    if (!lit.length || !lit.every((r) => !r.dash && r.alpha === 1)) throw new Error("the outline while on: " + JSON.stringify(lit));
    out.overlay = { dim: dim[0], lit: lit[0] };
    // a box the crop leaves out is still the document's: the selection does not go as a box in its place
    await c("boxes.remove", { id: "cat_1", doc: d.id });
    await c("select_rect", { x: 950, y: 600, w: 150, h: 120, doc: d.id });
    g = await c("generate", { timeout: 60 });
    if (g.boxes !== 0 || String(g.prompt_sent).includes('"id":')) throw new Error("the selection went in place of a box the crop left out: " + JSON.stringify({ boxes: g.boxes, prompt: g.prompt_sent, notes: g.notes }));
    // no boxes at all, the switch on: the selection goes as one box (S1's, named after the prompt: garden_1), the
    // prompt as it is, the box's sentence saying only where
    await c("boxes.clear", D());
    if (ed.boxesLabel.textContent !== "Boxes" || ed.boxesHint.textContent !== "the selection goes as one box" || !ed.genSettings.boxes) throw new Error("the row with no boxes: " + ed.boxesLabel.textContent + " / " + ed.boxesHint.textContent);
    g = await c("generate", { timeout: 60 });
    if (g.boxes !== 1 || !String(g.prompt_sent).includes('"id":"garden_1"') || !/^a garden\\. In <ref_image_0>, the change goes in <garden_1> /.test(String(g.prompt_sent))) throw new Error("the selection as one box: " + JSON.stringify({ boxes: g.boxes, prompt: g.prompt_sent }));
    out.selection = g.prompt_sent;
    // the switch rides in the file; an open with boxes is no first box
    const again = await c("boxes.add", { id: "dog_1", rect: [100, 100, 400, 300], desc: "a dog", doc: d.id });
    if (again.switched_on || (await boxes()).length !== 1 || !ed.genSettings.boxes) throw new Error("a box with the switch already on: " + JSON.stringify(again));
    await c("set_generation", { boxes: false, doc: d.id });
    await c("save_document", { path, doc: d.id });
    await c("close_document", { doc: d.id, force: true });
    let o = await c("open_document", { path });
    window.__bDoc = o.id;
    if (ednow().genSettings.boxes !== false || (await boxes()).length !== 1) throw new Error("after the open with the switch off: " + JSON.stringify([ednow().genSettings.boxes, await boxes()]));
    if (ednow().boxesLabel.textContent !== "Boxes \u00b7 1" || ednow().boxesCheck.checked) throw new Error("the row after the open: " + ednow().boxesLabel.textContent);
    await c("set_generation", { boxes: true, doc: o.id });
    await c("save_document", { path, doc: o.id });
    await c("close_document", { doc: o.id, force: true });
    o = await c("open_document", { path });
    window.__bDoc = o.id;
    if (ednow().genSettings.boxes !== true || !ednow().boxesCheck.checked) throw new Error("the switch on did not come back from the file");
    out.calls = calls;
    return out;
} finally {
    host.plugins = orig;
    if (window.__bDoc !== main) { try { await c("close_document", { doc: window.__bDoc, force: true }); } catch (_) { /* gone */ } }
    window.__bDoc = main;
    host.setRecipe(prev);
    host.shell.activate(ednow());
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
    ("ideogram4_caption", """
// S5: a recipe whose variant takes boxes as Ideogram 4's caption (the loopback, no key): the prompt goes as the JSON
// caption, a Text box as a text element with its words, a Move box left out with the run's note and the panel's line.
// A document of its own; the recipe put back.
const main = window.__bDoc;
const prev = host.recipe;
const LOOP = { id: "loopback_ideogram", kind: "provider", provider: "loopback", providerLabel: "Loopback", model: "loopback", input: "edit", name: "Loopback", settings: [], options: { boxes: "ideogram4" } };
try {
    const d = await c("new_document");
    window.__bDoc = d.id;
    const ed = ednow();
    host.shell.activate(ed);
    await c("new_canvas", { width: 1200, height: 800, doc: d.id });
    host.setRecipe(LOOP);
    const sw = host.boxSwitch(ed);
    if (!sw.takes || sw.schema !== "ideogram4") throw new Error("boxSwitch under the Ideogram loopback: " + JSON.stringify(sw));
    await c("boxes.add", { id: "sign_1", rect: [200, 200, 600, 400], text: "SAUNA", desc: "carved letters", doc: d.id });
    await c("boxes.add", { id: "ox_1", kind: "move", rect: [700, 100, 900, 300], src: [700, 400, 900, 600], desc: "an ox", doc: d.id });
    const list = await c("boxes.list", D());
    if (list.recipe.schema !== "ideogram4") throw new Error("boxes.list's recipe: " + JSON.stringify(list.recipe));
    await c("set_prompt", { text: "a sauna in the woods", doc: d.id });
    await c("select_rect", { x: 0, y: 0, w: 1200, h: 800, doc: d.id });
    const details = Array.from(ed.panes.gen.querySelectorAll("details")).find((x) => x.querySelector("summary") && x.querySelector("summary").textContent.trim() === "Boxes");
    if (!details) throw new Error("no Boxes section");
    details.open = true;
    await wait(150);
    const warns = Array.from(details.querySelectorAll(".boxes-warn-row")).map((r) => r.textContent);
    if (!warns.some((w) => /^Box ox_1 does not go with Loopback: Ideogram 4 places New, Text and Keep boxes only/.test(w))) throw new Error("the panel's line for the Move box: " + JSON.stringify(warns));
    const g = await c("generate", { timeout: 60 });
    let cap = null;
    try { cap = JSON.parse(String(g.prompt_sent)); } catch (_) { throw new Error("prompt_sent is not the JSON caption: " + g.prompt_sent); }
    const els = cap.compositional_deconstruction && cap.compositional_deconstruction.elements;
    if (Object.keys(cap).join() !== "high_level_description,compositional_deconstruction" || cap.high_level_description !== "a sauna in the woods" || cap.compositional_deconstruction.background !== "") throw new Error("the caption: " + g.prompt_sent);
    if (!Array.isArray(els) || els.length !== 1 || Object.keys(els[0]).join() !== "type,bbox,text,desc" || els[0].type !== "text" || els[0].text !== "SAUNA" || els[0].desc !== "carved letters") throw new Error("the elements: " + JSON.stringify(els));
    if (g.boxes !== 1 || !(g.notes || []).some((n) => /^Box ox_1 \\(Move\\) was not sent: Ideogram 4 places/.test(n))) throw new Error("boxes / notes: " + JSON.stringify({ boxes: g.boxes, notes: g.notes }));
    return { prompt: g.prompt_sent, bbox: els[0].bbox };
} finally {
    if (window.__bDoc !== main) { try { await c("close_document", { doc: window.__bDoc, force: true }); } catch (_) { /* gone */ } }
    window.__bDoc = main;
    host.setRecipe(prev);
    host.shell.activate(ednow());
}
"""),
    ("each_box_its_own_colour_and_a_double_click_describes_it", """
// 0.1.38: every box its own colour, kept through a change; a double click on a box opens its description on the canvas
const d = await c("new_document");
window.__bDoc = d.id;
host.shell.activate(ednow());
await c("new_canvas", { width: 1200, height: 800, doc: d.id });
const ed = ednow();
const add = (a) => c("boxes.add", { ...D(), ...a });
await add({ kind: "new", rect: [20, 20, 220, 220], desc: "a lamp" });
const b2 = await add({ kind: "new", rect: [300, 20, 500, 220], desc: "a chair" });
await add({ kind: "keep", rect: [600, 20, 800, 220], src: [600, 20, 800, 220] });
let list = await boxes();
if (!eq(list.map((b) => b.colour), [0, 1, 2])) throw new Error("three boxes, three colours: " + JSON.stringify(list.map((b) => b.colour)));
await c("boxes.remove", { ...D(), id: b2.id });
const b4 = await add({ kind: "new", rect: [300, 300, 500, 500], desc: "a vase" });
if (b4.colour !== 1) throw new Error("a new box takes the free colour: " + b4.colour);
const moved = await c("boxes.set", { ...D(), id: list[0].id, rect: [30, 30, 230, 230] });
if (moved.colour !== 0) throw new Error("a change keeps the colour: " + moved.colour);
await wait(60);
const borders = [...ed.panes.gen.querySelectorAll(".boxes-row")].map((r) => r.style.borderLeftColor);
if (new Set(borders).size !== 3) throw new Error("the panel rows' colours: " + JSON.stringify(borders));
// an undo and a redo keep the colours
const before = await boxes();
await c("undo", D()); await c("redo", D());
if (!eq((await boxes()).map((b) => b.colour), before.map((b) => b.colour))) throw new Error("undo / redo changed the colours");
// the double click: the tool's pointer hooks, two clicks within half a second
ed.setTool("boxes.box");
const fake = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, pressure: 0.5, pointerType: "mouse", clientX: 400, clientY: 300 };
const ptr = (phase, x, y) => { host.pluginPointer(ed, phase, { ...fake, type: "pointer" + phase }, x, y, ed.pointer); if (phase === "up") ed.pointer = null; };
const dbl = (x, y) => { ptr("down", x, y); ptr("up", x, y); ptr("down", x, y); ptr("up", x, y); };
dbl(400, 400);
let dlg = document.querySelector("dialog.boxes-inline[open]");
if (!dlg) throw new Error("no field after a double click");
let area = dlg.querySelector("textarea");
if (area.value !== "a vase") throw new Error("the field holds " + JSON.stringify(area.value));
if (document.activeElement !== area) throw new Error("the field has no focus");
area.value = "a small brass bell";
area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
await wait(50);
if (document.querySelector("dialog.boxes-inline")) throw new Error("Enter left the field open");
list = await boxes();
const bell = list.find((b) => b.desc === "a small brass bell");
if (!bell || bell.colour !== 1) throw new Error("Enter: " + JSON.stringify(list));
// Escape cancels; the editor's own Escape does not see the key
dbl(400, 400);
area = document.querySelector("dialog.boxes-inline[open] textarea");
area.value = "nothing";
area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
await wait(50);
if (document.querySelector("dialog.boxes-inline")) throw new Error("Escape left the field open");
if ((await boxes()).some((b) => b.desc === "nothing")) throw new Error("Escape kept the text");
// two clicks far apart in time are no double click
ptr("down", 400, 400); ptr("up", 400, 400); await wait(600); ptr("down", 400, 400); ptr("up", 400, 400);
if (document.querySelector("dialog.boxes-inline")) throw new Error("a slow second click opened the field");
// a tool change closes an open field and keeps what it holds
dbl(400, 400);
document.querySelector("dialog.boxes-inline[open] textarea").value = "a bronze bell";
ed.setTool("brush");
await wait(50);
if (document.querySelector("dialog.boxes-inline")) throw new Error("the tool change left the field open");
if (!(await boxes()).some((b) => b.desc === "a bronze bell")) throw new Error("the tool change dropped the text");
await c("close_document", { doc: window.__bDoc, force: true });
return { colours: list.map((b) => b.id + ":" + b.colour).join(" ") };
"""),
    # a local ComfyUI recipe that declares its boxes input (flux3_klein_local): the row, the canvas state, the input taken
    # from the node's box_prompt by name, the switch off, an older node refused, a recipe without it unchanged, Generate new
    ("local_recipe_box_prompt", """
// boxes in the prompt on the user's ComfyUI: flux3_klein_local declares the input FLUX 3's rows go to (boxes { schema,
// input }); the Boxes row shows for it, the canvas state carries the boxes, and a run that sends boxes takes that input
// from the Inpaint Canvas node's box_prompt (found by name in the node list); the switch off keeps the plain prompt, an
// older node refuses before anything is uploaded or queued (generate_new before its fresh canvas wipes the picture), a
// recipe without the declaration is as before (the node's box notes of its runs are not shown), Generate new scales the
// boxes to the fresh canvas and sends New, Text and From boxes only. Nothing reaches a server: the queue, the ensure and
// /object_info/InpaintCanvas are caught in the page.
const { api } = await import("./editor/host.js");
const main = window.__bDoc;
const prev = host.recipe;
const klein = host.shell.recipes().find((r) => r.id === "flux3_klein_local");
const klein2 = host.shell.recipes().find((r) => r.id === "flux2_klein_local");
if (!klein || !klein2) throw new Error("flux3_klein_local / flux2_klein_local are not among the recipes");
if (!eq(klein.boxes, { schema: "flux3", input: "say_in|string_b" })) throw new Error("the recipe's boxes as served: " + JSON.stringify(klein.boxes));
const OUTS = ["crop_image", "crop_mask", "image", "mask", "stitch_info", "crop_width", "crop_height", "prompt", "control_image", "denoise", "seed", "mode", "negative",
    "setting_1", "setting_2", "setting_3", "setting_4", "setting_5", "setting_6", "setting_7", "setting_8"];
const node = (outs) => ({ input: { required: {} }, output: outs.map(() => "*"), output_name: outs });
const NEW = node([...OUTS, "box_prompt", "elements"]), OLD = node(OUTS);
// a node whose box_prompt is not at 21: the slot is found by name
const LATER = node([...OUTS, "extra", "box_prompt", "elements"]);
const OI = Object.fromEntries([...klein.needs, ...klein2.needs].map((n) => [n, { input: { required: {} } }]));
const saved = { connected: host.connected, objectInfo: host.objectInfo, ensure: host.ensureOnServer, queue: api.queuePrompt, fetchApi: api.fetchApi, missing: host.missingFilesRefusal, count: host.plugins.countBoxes, queueGenerate: host.queueGenerate };
const T = { queued: [], ensured: 0, fetched: 0, answer: OLD };
const out = {};
try {
    host.connected = true;
    host.objectInfo = { ...OI, InpaintCanvas: NEW };
    host.missingFilesRefusal = () => null;
    host.ensureOnServer = async () => { T.ensured++; return null; };
    api.queuePrompt = async (n, body) => { const id = "f3k-boxes-" + (T.queued.length + 1); T.queued.push({ id, body }); return { prompt_id: id }; };
    api.fetchApi = (path, init) => {
        if (String(path) === "/object_info/InpaintCanvas") { T.fetched++; return Promise.resolve(new Response(JSON.stringify({ InpaintCanvas: T.answer }), { status: 200, headers: { "Content-Type": "application/json" } })); }
        return saved.fetchApi.call(api, path, init);
    };
    const d = await c("new_document");
    window.__bDoc = d.id;
    const ed = ednow();
    host.shell.activate(ed);
    await c("new_canvas", { width: 1200, height: 800, doc: d.id });
    // the row: hidden under the recipe without the declaration, shown under the one with it
    host.setRecipe(klein2);
    if (!ed.boxesRow || !ed.boxesRow.hidden) throw new Error("the Boxes row shows under flux2_klein_local");
    host.setRecipe(klein);
    if (ed.boxesRow.hidden) throw new Error("the Boxes row is hidden under flux3_klein_local");
    if (!eq(host.boxSwitch(ed), { takes: true, count: 0, schema: "flux3" })) throw new Error("boxSwitch: " + JSON.stringify(host.boxSwitch(ed)));
    const a = await c("boxes.add", { id: "apple_1", rect: [700, 120, 900, 320], desc: "a red apple", doc: d.id });
    if (!a.switched_on || !ed.genSettings.boxes || !/under the prompt is on now/.test(ed.status)) throw new Error("the first box under the local recipe: " + JSON.stringify(a) + " " + ed.status);
    await c("set_prompt", { text: "a bowl of fruit", doc: d.id });
    await c("select_rect", { x: 600, y: 60, w: 400, h: 340, doc: d.id });
    const end = (id) => api.dispatch("execution_success", { prompt_id: id });
    const queue = async () => { const n = T.queued.length; await host.queueGenerate(ed); if (T.queued.length !== n + 1) throw new Error("nothing was queued"); const q = T.queued[n]; end(q.id); return { p: q.body.output, st: JSON.parse(q.body.output.canvas.inputs.canvas_state), id: q.id }; };
    // the log's last id, and its entries for a prompt's box notes after it (the log is written over IPC: a moment later)
    const lastLog = async () => { const g = await c("read_log", { limit: 1 }); return g.entries.length ? g.entries[g.entries.length - 1].id : 0; };
    const boxLog = async (after, id) => { await wait(400); return (await c("read_log", { after })).entries.filter((e) => e.message === `local run ${id}: boxes`); };
    // the node's notes for a prompt that took no box_prompt: not the run's, not held for its result, not logged
    const notesIgnored = async (id, what) => {
        const l0 = await lastLog();
        api.dispatch("executed", { prompt_id: id, node: "canvas", output: { inpaint_boxes: ["Box edit_1 went without a description: the model guesses what goes there."] } });
        const logged = await boxLog(l0, id);
        if (ed.lastRunNotes.some((n) => /edit_1/.test(n)) || (ed._boxNotes && ed._boxNotes.has(String(id))) || logged.length) throw new Error(what + ": the node's box notes of a run without box_prompt were taken: " + JSON.stringify({ notes: ed.lastRunNotes, logged: logged.length }));
    };
    // on, with a box: say_in.string_b from box_prompt (21), the rest of the graph as the recipe has it; the state carries the box
    let q = await queue();
    if (!eq(q.p.say_in.inputs.string_b, ["canvas", 21]) || !eq(q.p.say_keep.inputs.string_a, ["say_in", 0]) || !eq(q.p.pos.inputs.text, ["say_keep", 0])) throw new Error("on, a box: " + JSON.stringify([q.p.say_in.inputs, q.p.say_keep.inputs, q.p.pos.inputs.text]));
    if (!eq(klein.prompt.say_in.inputs.string_b, ["canvas", 7])) throw new Error("the run changed the recipe's own graph");
    if (!q.st.gen.boxes || !Array.isArray(q.st.boxes) || q.st.boxes.length !== 1 || q.st.boxes[0].id !== "apple_1" || !eq(q.st.boxes[0].rect, [700, 120, 900, 320]) || q.st.boxes[0].desc !== "a red apple" || q.st.prompt !== "a bowl of fruit") throw new Error("the canvas state: " + JSON.stringify({ gen: q.st.gen.boxes, boxes: q.st.boxes, prompt: q.st.prompt }));
    if (ed.lastSentBoxes !== 1 || !/Sent with 1 box[.]/.test(ed.status)) throw new Error("the count / the status: " + ed.lastSentBoxes + " / " + ed.status);
    out.on = { input: q.p.say_in.inputs.string_b, status: ed.status };
    // the node's notes on a box it left out (its executed ui): in the run's notes and kept for the result's line
    api.dispatch("executed", { prompt_id: q.id, node: "canvas", output: { inpaint_boxes: ["Box apple_1 lies outside the crop and was not sent."] } });
    if (!ed.lastRunNotes.includes("Box apple_1 lies outside the crop and was not sent.") || !(ed._boxNotes && ed._boxNotes.get(q.id))) throw new Error("the node's box notes: " + JSON.stringify(ed.lastRunNotes));
    if ((await boxLog(0, q.id)).length !== 1) throw new Error("the node's box notes are not in the log");
    ed._boxNotes.delete(q.id);
    // the slot by name: a node whose box_prompt sits later
    host.objectInfo = { ...OI, InpaintCanvas: LATER };
    q = await queue();
    if (!eq(q.p.say_in.inputs.string_b, ["canvas", 22])) throw new Error("box_prompt at 22: " + JSON.stringify(q.p.say_in.inputs.string_b));
    host.objectInfo = { ...OI, InpaintCanvas: NEW };
    // off: the plain prompt, no boxes in the state, a note that the box stayed home
    await c("set_generation", { boxes: false, doc: d.id });
    q = await queue();
    if (!eq(q.p.say_in.inputs.string_b, ["canvas", 7]) || "boxes" in q.st || ed.lastSentBoxes !== 0) throw new Error("off: " + JSON.stringify([q.p.say_in.inputs.string_b, q.st.boxes, ed.lastSentBoxes]));
    if (!ed.lastRunNotes.some((n) => /1 box did not go: the Boxes switch under the prompt is off/.test(n))) throw new Error("no note for the box left home: " + JSON.stringify(ed.lastRunNotes));
    // an older node (no box_prompt; its own entry read again says the same): refused before the upload and the queue
    host.objectInfo = { ...OI, InpaintCanvas: OLD };
    T.answer = OLD;
    q = await queue();
    if (!eq(q.p.say_in.inputs.string_b, ["canvas", 7])) throw new Error("off with an older node: " + JSON.stringify(q.p.say_in.inputs.string_b));
    await c("set_generation", { boxes: true, doc: d.id });
    const n0 = T.queued.length, e0 = T.ensured, f0 = T.fetched;
    let refused = "";
    try { await host.queueGenerate(ed); } catch (err) { refused = String(err.message || err); }
    const OLD_NODE = /does not have: update the Inpaint Canvas node to its current GitHub version [(]a git clone: git pull in its folder under custom_nodes; installed through the Comfy Registry or the Manager: replace that folder with a git clone of https:..github[.]com.DenRakEiw.ComfyUI-InpaintCanvas[)], then restart ComfyUI, or turn the Boxes switch under the prompt off[.]$/;
    if (!OLD_NODE.test(refused) || T.queued.length !== n0 || T.ensured !== e0 || T.fetched !== f0 + 1) throw new Error("an older node: " + JSON.stringify({ refused, queued: T.queued.length - n0, ensured: T.ensured - e0, fetched: T.fetched - f0 }));
    out.refused = refused;
    // the node updated since the connect: its entry read again has box_prompt, and the run goes
    T.answer = NEW;
    q = await queue();
    if (!eq(q.p.say_in.inputs.string_b, ["canvas", 21]) || !(host.objectInfo.InpaintCanvas.output_name || []).includes("box_prompt")) throw new Error("the node read again: " + JSON.stringify(q.p.say_in.inputs.string_b));
    // an @img token in a box's description goes as the name the recipe gives its picture, the one the prompt has
    // (<ref_image_N>), not the node's "image n"; the document's box keeps its token
    const shelfRef = await c("add_paint_layer", { name: "Shelf", doc: d.id });
    await c("set_layer", { layer: shelfRef.id, role: "reference", x: 100, y: 500, w: 200, h: 200, doc: d.id });
    await c("boxes.add", { id: "shelf_1", rect: [620, 80, 760, 200], desc: "@img1 on the shelf", doc: d.id });
    await c("set_prompt", { text: "a bowl of fruit, @img1 beside it", doc: d.id });
    q = await queue();
    const pname = (/(<ref_image_[0-9]+>) beside it$/.exec(q.st.prompt) || [])[1];
    const shelf = (q.st.boxes || []).find((b) => b.id === "shelf_1");
    if (!pname || !shelf || shelf.desc !== `${pname} on the shelf` || !eq(q.st.referenceLabels, ["img1"]) || !eq(q.p.say_in.inputs.string_b, ["canvas", 21])) throw new Error("@img1 in a description: " + JSON.stringify({ prompt: q.st.prompt, shelf, labels: q.st.referenceLabels }));
    if ((await c("boxes.list", D())).boxes.find((b) => b.id === "shelf_1").desc !== "@img1 on the shelf") throw new Error("the run changed the document's box");
    out.named = shelf.desc;
    await c("boxes.remove", { id: "shelf_1", doc: d.id });
    await c("set_prompt", { text: "a bowl of fruit", doc: d.id });
    // a From box whose reference layer does not go (hidden) is all the document holds: no box goes, so an older node is
    // no reason to refuse, and the state's empty list keeps the node from sending the selection as a box
    await c("boxes.clear", D());
    await c("boxes.add", { id: "shelf_from_1", kind: "from", layer: shelfRef.id, rect: [620, 80, 760, 200], doc: d.id });
    await c("set_layer", { layer: shelfRef.id, visible: false, doc: d.id });
    host.objectInfo = { ...OI, InpaintCanvas: OLD };
    T.answer = OLD;
    q = await queue();
    if (!eq(q.p.say_in.inputs.string_b, ["canvas", 7]) || !eq(q.st.boxes, []) || ed.lastSentBoxes !== 0) throw new Error("a From box that does not go, with an older node: " + JSON.stringify([q.p.say_in.inputs.string_b, q.st.boxes, ed.lastSentBoxes]));
    await c("boxes.clear", D());
    await c("remove_layer", { layer: shelfRef.id, doc: d.id });
    host.objectInfo = { ...OI, InpaintCanvas: NEW };
    T.answer = NEW;
    // the Boxes plugin off (no source counts the boxes): its stored boxes stay home and the selection goes as one box,
    // as on an API run
    await c("boxes.add", { id: "apple_1", rect: [700, 120, 900, 320], desc: "a red apple", doc: d.id });
    host.plugins.countBoxes = () => 0;
    q = await queue();
    host.plugins.countBoxes = saved.count;
    if ("boxes" in q.st || q.st.selectionBoxId !== "bowl_1" || !eq(q.p.say_in.inputs.string_b, ["canvas", 21]) || ed.lastSentBoxes !== 1) throw new Error("the Boxes plugin off: " + JSON.stringify([q.st.boxes, q.st.selectionBoxId, q.p.say_in.inputs.string_b, ed.lastSentBoxes]));
    await c("boxes.clear", D());
    // no box, the switch on: the selection goes as one box (the node's own), so box_prompt takes the prompt
    await c("boxes.clear", D());
    q = await queue();
    if (!eq(q.p.say_in.inputs.string_b, ["canvas", 21]) || "boxes" in q.st || q.st.selectionBoxId !== "bowl_1" || ed.lastSentBoxes !== 1) throw new Error("the selection as one box: " + JSON.stringify([q.p.say_in.inputs.string_b, q.st.boxes, q.st.selectionBoxId, ed.lastSentBoxes]));
    // a recipe without the declaration: no row, no boxes in the state, no rewiring and no refusal with an older node
    await c("boxes.add", { id: "apple_1", rect: [700, 120, 900, 320], desc: "a red apple", doc: d.id });
    host.objectInfo = { ...OI, InpaintCanvas: OLD };
    T.answer = OLD;
    host.setRecipe(klein2);
    q = await queue();
    if ("boxes" in q.st || "selectionBoxId" in q.st || JSON.stringify(q.p).includes('"canvas",21') || ed.lastSentBoxes !== 0 || ed.lastRunNotes.some((n) => /box/.test(n))) throw new Error("flux2_klein_local: " + JSON.stringify({ st: Object.keys(q.st), sent: ed.lastSentBoxes, notes: ed.lastRunNotes }));
    await notesIgnored(q.id, "flux2_klein_local");
    host.setRecipe(klein);
    host.objectInfo = { ...OI, InpaintCanvas: NEW };
    // Generate new (generate_new's local path marks the run): the boxes scaled from the picture they were drawn on to the
    // fresh canvas, stretched with a note when the shape differs; no selection's box without boxes
    await c("select_all", D());
    ed._newBoxes = { from: [2400, 1600], aspect: null };
    q = await queue();
    if (!eq(q.p.say_in.inputs.string_b, ["canvas", 21]) || !eq(q.st.boxes[0].rect, [350, 60, 450, 160]) || ed._newBoxes !== undefined || ed.lastRunNotes.some((n) => /stretched/.test(n))) throw new Error("Generate new, the same shape: " + JSON.stringify([q.st.boxes, ed.lastRunNotes]));
    // a Move box has no source in a new picture: left out with an API new image's note, the New box goes
    await c("boxes.add", { id: "lamp_1", kind: "move", rect: [100, 100, 200, 200], src: [300, 300, 400, 400], desc: "the lamp", doc: d.id });
    ed._newBoxes = { from: [1200, 800], aspect: null };
    q = await queue();
    if (!eq((q.st.boxes || []).map((b) => b.id), ["apple_1"]) || ed.lastSentBoxes !== 1 || !ed.lastRunNotes.includes("lamp_1: a new image has no source to keep, move or remove (move).") || !eq(q.p.say_in.inputs.string_b, ["canvas", 21])) throw new Error("Generate new with a Move box: " + JSON.stringify([q.st.boxes, ed.lastSentBoxes, ed.lastRunNotes]));
    // the Move box alone: none goes, so an older node does not refuse, and the selection is no box either
    await c("boxes.remove", { id: "apple_1", doc: d.id });
    host.objectInfo = { ...OI, InpaintCanvas: OLD };
    T.answer = OLD;
    ed._newBoxes = { from: [1200, 800], aspect: null };
    q = await queue();
    if (!eq(q.p.say_in.inputs.string_b, ["canvas", 7]) || !eq(q.st.boxes, []) || ed.lastSentBoxes !== 0 || !ed.lastRunNotes.some((n) => /^lamp_1: a new image/.test(n))) throw new Error("Generate new with a Move box alone: " + JSON.stringify([q.p.say_in.inputs.string_b, q.st.boxes, ed.lastRunNotes]));
    host.objectInfo = { ...OI, InpaintCanvas: NEW };
    T.answer = NEW;
    await c("boxes.remove", { id: "lamp_1", doc: d.id });
    await c("boxes.add", { id: "apple_1", rect: [700, 120, 900, 320], desc: "a red apple", doc: d.id });
    ed._newBoxes = { from: [1200, 1200], aspect: "3:2" };
    q = await queue();
    const near = (u, v) => u.length === v.length && u.every((x, i) => Math.abs(x - v[i]) < 1e-6);
    if (!near(q.st.boxes[0].rect, [700, 80, 900, 320 * 800 / 1200]) || !ed.lastRunNotes.some((n) => /drawn on .*; at 3:2 they go stretched/.test(n))) throw new Error("Generate new, another shape: " + JSON.stringify([q.st.boxes, ed.lastRunNotes]));
    await c("boxes.clear", D());
    ed._newBoxes = { from: [1200, 800], aspect: null };
    q = await queue();
    if (!eq(q.p.say_in.inputs.string_b, ["canvas", 7]) || ed.lastSentBoxes !== 0) throw new Error("Generate new without boxes sent the selection as one: " + JSON.stringify(q.p.say_in.inputs.string_b));
    await notesIgnored(q.id, "Generate new without boxes");
    // generate_new with an older node and a box: refused before its fresh canvas replaces the picture, the layers and the
    // history (nothing wiped, uploaded or queued)
    await c("boxes.add", { id: "apple_1", rect: [700, 120, 900, 320], desc: "a red apple", doc: d.id });
    const lamp = await c("add_paint_layer", { name: "Lamp", doc: d.id });
    await c("set_layer", { layer: lamp.id, role: "reference", x: 500, y: 350, w: 200, h: 100, doc: d.id });
    await c("add_paint_layer", { name: "Kept", doc: d.id });
    host.objectInfo = { ...OI, InpaintCanvas: OLD };
    T.answer = OLD;
    const was = { w: ed.width, h: ed.height, layers: ed.layers.map((l) => l.id).join(","), hist: ed.history.length, queued: T.queued.length, ensured: T.ensured };
    let gnErr = "";
    try { await c("generate_new", { prompt: "a bowl of fruit", width: 1024, height: 1024, doc: d.id, timeout: 5 }); } catch (err) { gnErr = String(err.message || err); }
    const now = { w: ed.width, h: ed.height, layers: ed.layers.map((l) => l.id).join(","), hist: ed.history.length, queued: T.queued.length, ensured: T.ensured };
    if (!OLD_NODE.test(gnErr) || !eq(now, was)) throw new Error("generate_new with an older node: " + JSON.stringify({ gnErr, was, now }));
    out.generateNew = gnErr.slice(0, 60);
    // generate_new's own plan, made before the wipe: a From box measured on its reference layer as it was drawn on (the
    // fresh canvas places the layer again), a Move box left out with its note, the boxes' size the picture they were
    // drawn on; the run then sends that plan (queueGenerate stubbed for the call, the plan queued after it)
    host.objectInfo = { ...OI, InpaintCanvas: NEW };
    T.answer = NEW;
    await c("boxes.add", { id: "lamp_from_1", kind: "from", layer: lamp.id, src: [550, 375, 650, 425], rect: [100, 100, 300, 300], doc: d.id });
    await c("boxes.add", { id: "old_lamp_1", kind: "move", rect: [100, 500, 200, 600], src: [300, 500, 400, 600], desc: "the old lamp", doc: d.id });
    let mark = null;
    host.queueGenerate = async (e) => { mark = e._newBoxes; e._newBoxes = undefined; throw new Error("stub: not queued"); };
    try { await c("generate_new", { prompt: "a bowl of fruit", width: 1024, height: 1024, doc: d.id, timeout: 5 }); } catch (_) { /* the stub's */ }
    host.queueGenerate = saved.queueGenerate;
    const fromBox = mark && mark.plan && (mark.plan.boxes || []).find((b) => b.id === "lamp_from_1");
    if (!mark || !eq(mark.from, [1200, 800]) || !fromBox || !eq(fromBox.src, [0.25, 0.25, 0.75, 0.75]) || fromBox.ref !== 0 || !eq(mark.plan.boxes.map((b) => b.id), ["apple_1", "lamp_from_1"]) || !eq(mark.plan.dropped, ["old_lamp_1: a new image has no source to keep, move or remove (move)."]) || !mark.plan.goes || ed.width !== 1024) throw new Error("generate_new's plan: " + JSON.stringify({ mark, w: ed.width }));
    ed._newBoxes = mark;
    q = await queue();
    const sentFrom = (q.st.boxes || []).find((b) => b.id === "lamp_from_1");
    if (!eq(q.p.say_in.inputs.string_b, ["canvas", 21]) || !sentFrom || !eq(sentFrom.src, [0.25, 0.25, 0.75, 0.75]) || !near(sentFrom.rect, [100 * 1024 / 1200, 100 * 1024 / 800, 300 * 1024 / 1200, 300 * 1024 / 800]) || ed.lastSentBoxes !== 2 || !ed.lastRunNotes.some((n) => /^old_lamp_1: a new image/.test(n))) throw new Error("generate_new's plan as sent: " + JSON.stringify({ boxes: q.st.boxes, sent: ed.lastSentBoxes, notes: ed.lastRunNotes }));
    out.queued = T.queued.length;
    return out;
} finally {
    host.connected = saved.connected; host.objectInfo = saved.objectInfo; host.ensureOnServer = saved.ensure;
    api.queuePrompt = saved.queue; api.fetchApi = saved.fetchApi; host.missingFilesRefusal = saved.missing;
    host.plugins.countBoxes = saved.count; host.queueGenerate = saved.queueGenerate;
    for (const q of T.queued) api.dispatch("execution_success", { prompt_id: q.id });
    if (window.__bDoc !== main) { try { await c("close_document", { doc: window.__bDoc, force: true }); } catch (_) { /* gone */ } }
    window.__bDoc = main;
    host.setRecipe(prev);
}
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
