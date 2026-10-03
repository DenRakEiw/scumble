"""Command core and plugin test against the running app (see tools/cdp.py for the setup).

No ComfyUI needed: loads the test image from the local mirror (or the server when
connected), then runs the command core (renderer/commands.js) through its public
`commands.run`: documents, selection, layers, filters (the sample plugin's Posterize on
the GPU and CPU paths), text, plugin actions / tools / commands, export to a fixed path,
screenshot, plugin reload and disable / enable.

    python tools/commands_test.py [out_dir]
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "dist", "smoke"))
os.makedirs(OUT, exist_ok=True)


def out_path(name):
    return json.dumps(os.path.join(OUT, name).replace(os.sep, "/"))


# docs/PLAN_REFS.md 26b2: a loopback edit recipe that names its pictures "image {n}" (the crop is image 1, then the
# Original when it goes along, then the references top first), and a loopback upscaler that takes a prompt
LOOP_EDIT = """{ id: "loopback_refs", kind: "provider", provider: "loopback", providerLabel: "Loopback", model: "loopback", input: "edit", name: "Loopback", settings: [], refs: { name: "image {n}" } }"""
LOOP_UP = """{ id: "loopback_up_refs", kind: "provider", task: "upscale", provider: "loopback", providerLabel: "Loopback", model: "loopback", name: "Loopback upscale",
    factor: { default: 2, min: 1, max: 4, steps: null, fixed: false }, limits: { min: 32, max: 4096, step: 1, pixels: 0, minPixels: 0, ratio: 0 },
    settings: [], usesPrompt: true, input: "fill" }"""


# every step is a JS async function body; `c` is commands.run, `raw` the module
STEPS = [
    ("ping", """
const p = await c("ping");
if (p.app !== "scumble") throw new Error("ping");
return { documents: p.documents.length, plugins: p.plugins, commands: raw.commands.names().length };
"""),
    ("new_document", """
const d = await c("new_document");
window.__testDoc = d.id;
const l = await c("list_documents");
if (!l.documents.some((x) => x.id === d.id && x.active)) throw new Error("the new document is not active");
return d;
"""),
    ("load", """
const r = await fetch("/comfy/view?filename=test_base.png&subfolder=inpaint_canvas&type=input");
if (r.status !== 200) throw new Error("test image " + r.status + " (run the smoke test once so it is in the mirror)");
const s = await c("load_image", { filename: "test_base.png", subfolder: "inpaint_canvas", type: "input", doc: window.__testDoc });
if (!s.width) throw new Error("not loaded");
return s;
"""),
    ("status_and_docs", """
const s = await c("status");
if (s.doc !== window.__testDoc || !s.loaded) throw new Error("status is not about the test document: " + JSON.stringify(s).slice(0, 200));
const cmds = await c("list_commands");
const missing = ["select_rect", "generate", "add_filter", "export", "screenshot", "sample.mean_color"].filter((n) => !cmds.commands.some((x) => x.name === n));
if (missing.length) throw new Error("commands missing: " + missing);
return { width: s.width, height: s.height, layers: s.layers.length, commands: cmds.commands.length, recipe: s.recipe && s.recipe.id };
"""),
    ("selection", """
const a = await c("select_rect", { x: 100, y: 80, w: 200, h: 120 });
if (!a.selection || a.selection.w !== 200 || a.selection.h !== 120) throw new Error("rect: " + JSON.stringify(a));
const g = await c("select_grow", { px: 10 });
if (g.selection.w !== 220) throw new Error("grow: " + JSON.stringify(g));
const inv = await c("select_invert");
const none = await c("select_none");
if (none.selection) throw new Error("select_none left a selection");
const m = new Uint8Array(editor.width * editor.height);
for (let y = 10; y < 60; y++) m.fill(1, y * editor.width + 20, y * editor.width + 120);
const sm = await c("select_mask", { mask: Array.from(m) });
if (!sm.selection || sm.selection.w !== 100 || sm.selection.h !== 50) throw new Error("select_mask: " + JSON.stringify(sm));
// C6 (c1): sample.mean_color with a selection reads the selection's bounds (exactly, as the whole flatten has them), and
// Document.selection() reads only the bounds too; neither flattens the picture or makes a display mirror
const P = await import("./plugins.js");
const W = editor.width, H = editor.height;
const flatRef = editor.flattenToCanvas({ forRun: true }).getContext("2d").getImageData(0, 0, W, H).data;
const selRef = editor.sel.readRect(0, 0, W, H).data;
const spy = { flatten: 0, read: [] };
const f0 = editor.flattenToCanvas, rr0 = editor.sel.readRect, ownRead = Object.prototype.hasOwnProperty.call(editor.sel, "readRect");
editor.releaseCaches({ mirrors: true });
editor.flattenToCanvas = function (...q) { spy.flatten++; return f0.apply(this, q); };
editor.sel.readRect = function (x, y, w, h) { spy.read.push([x, y, w, h]); return rr0.call(this, x, y, w, h); };
let mean, docSel, docBox;
try {
    mean = await c("sample.mean_color");
    const doc = new P.Document(editor);
    docSel = doc.selection();
    docBox = doc.selection({ box: true });
} finally { editor.flattenToCanvas = f0; if (ownRead) editor.sel.readRect = rr0; else delete editor.sel.readRect; }
if (spy.flatten) throw new Error("mean_color with a selection flattened the picture " + spy.flatten + " times");
if (editor.tileMode && editor.memoryReport().tiles.mirrors) throw new Error("mean_color made " + editor.memoryReport().tiles.mirrors + " display mirrors");
const bArea = sm.selection.w * sm.selection.h;
if (spy.read.some((q) => q[2] * q[3] > bArea)) throw new Error("the selection was read beyond its bounds: " + JSON.stringify(spy.read));
let sr = 0, sg = 0, sb = 0, sn = 0;
for (let p = 0, i = 0; p < W * H; p++, i += 4) { if (selRef[i + 3] <= 127) continue; sr += flatRef[i]; sg += flatRef[i + 1]; sb += flatRef[i + 2]; sn++; }
const meanRef = [sr, sg, sb].map((v) => Math.round(v / sn));
if (mean.pixels !== sn || JSON.stringify(mean.rgb) !== JSON.stringify(meanRef)) throw new Error("mean_color " + JSON.stringify(mean) + " is not the whole flatten's " + JSON.stringify({ pixels: sn, rgb: meanRef }));
let bad = 0;
for (let p = 0; p < W * H; p++) if (docSel.mask[p] !== (selRef[p * 4 + 3] > 127 ? 1 : 0)) bad++;
const bb = docBox.bounds;
for (let y = 0; y < bb.h; y++) for (let x = 0; x < bb.w; x++) if (docBox.mask[y * bb.w + x] !== docSel.mask[(bb.y + y) * W + bb.x + x]) bad++;
if (bad || docSel.width !== W || docBox.width !== bb.w || docBox.x !== bb.x) throw new Error("Document.selection() differs from the selection in " + bad + " pixels");
// C6 (c1) review: `pad` with `maxSize` pads by whole pixels of the smaller picture, so the box's picture stays where the
// unpadded box has it (the margin was drawn back rounded, up to half a pixel of the smaller picture off)
const pads = [];
{
    const doc = new P.Document(editor);
    const px = (cv) => cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
    for (const [box, maxSize, pad] of [[[101, 101, 301, 251], 100, 7], [[3, 5, 203, 155], 74, 9], [[240, 150, 440, 300], 60, 5]]) {
        const a0 = doc.flatten({ box, maxSize }), a1 = doc.flatten({ box, maxSize, pad });
        const d0 = px(a0), d1 = px(a1);
        let m = 0, n = 0;
        for (let i = 0; i < d0.length; i++) { const q = Math.abs(d0[i] - d1[i]); if (q > m) m = q; if (q > 1) n++; }
        pads.push([box, maxSize, pad, [a0.width, a0.height], m, n]);
        if (a0.width !== a1.width || a0.height !== a1.height || m > 1) throw new Error(`flatten of ${JSON.stringify(box)} at maxSize ${maxSize} with pad ${pad} differs from the unpadded box by ${m} levels on ${n} bytes`);
    }
}
await c("select_rect", { x: 100, y: 80, w: 200, h: 120 });
return { rect: a.selection, grown: g.selection, inverted: inv.selection, mask: sm.selection, mean, reads: spy.read, pads };
"""),
    ("layers", """
const before = (await c("list_layers")).layers.length;
const p = await c("add_paint_layer", { name: "Test paint" });
const t = await c("add_text", { text: "Scumble", x: 40, y: 40, size: 48, color: "#ff8800", name: "Title" });
if (t.kind !== "text" || t.text.content !== "Scumble") throw new Error("add_text: " + JSON.stringify(t));
const t2 = await c("set_text", { layer: "Title", text: "Plugins", bold: true });
if (t2.text.content !== "Plugins") throw new Error("set_text");
const moved = await c("set_layer", { layer: "Title", x: 60, y: 70, opacity: 0.8 });
if (moved.x !== 60 || moved.opacity !== 0.8) throw new Error("set_layer: " + JSON.stringify(moved));
// match_source "below" is the editor's "underneath" (it was stored as it came and read as surroundings)
const matched = await c("set_layer", { layer: "Title", match: 50, match_source: "below" });
if (!matched.match || matched.match.strength !== 50 || matched.match.source !== "underneath") throw new Error("set_layer match_source below: " + JSON.stringify(matched.match));
await c("set_layer", { layer: "Title", match: 0, match_source: "surroundings" });
const dup = await c("duplicate_layer", { layer: "Title" });
const mv = await c("move_layer", { layer: dup.id, to: "bottom" });
if (mv.index !== 0) throw new Error("move_layer: " + JSON.stringify(mv));
const rm = await c("remove_layer", { layer: dup.id });
const after = (await c("list_layers")).layers.length;
if (after !== before + 2) throw new Error(`layer count ${after}, expected ${before + 2}`);
return { paint: p.id, text: t2.id, layers: after };
"""),
    ("posterize_filter", """
const types = await c("filter_types");
const f = types.filters.find((x) => x.id === "sample.posterize");
if (!f || f.plugin !== "sample") throw new Error("the sample plugin's filter is not listed");
const layer = await c("add_filter", { type: "sample.posterize", params: { levels: 4 }, name: "Poster" });
if (layer.filter !== "sample.posterize" || layer.params.levels !== 4) throw new Error("add_filter: " + JSON.stringify(layer));
const set = await c("set_filter", { layer: "Poster", params: { mono: true } });
if (set.params.mono !== true) throw new Error("set_filter");
// GPU vs CPU path of the plugin filter
const fl = (await import("./editor/inpaint_filters.js"));
const gl = (await import("./editor/inpaint_filters_gl.js"));
const src = editor.flattenToCanvas({ forRun: true });
const cpu = fl.FILTERS["sample.posterize"].apply;
const cmp = gl.compareFilterPaths(cpu, "sample.posterize", src, { levels: 4, mono: false }, {});
if (gl.glFiltersAvailable() && !cmp.gl) throw new Error("the plugin filter did not run on the GPU (shader error?)");
if (cmp.gl && cmp.max > 2) throw new Error("GPU and CPU posterize differ: " + JSON.stringify(cmp));
const shot = await c("screenshot", { max_size: 512 });
window.__posterShot = shot.data;
return { filter: f, layer: layer.id, compare: cmp, screenshot: [shot.width, shot.height] };
"""),
    ("plugin_action_and_undo", """
await c("set_active_layer", { layer: "Test paint" });
// paint something into the paint layer through the plugin API, then desaturate it via the action
const P = await import("./plugins.js");
const doc = new P.Document(editor);
const px = doc.getPixels("Test paint");
for (let i = 0; i < px.data.data.length; i += 4) { px.data.data[i] = 200; px.data.data[i + 1] = 40; px.data.data[i + 2] = 40; px.data.data[i + 3] = 255; }
doc.setPixels("Test paint", px.data);
const before = editor.undo.length;
const r = await c("run_action", { id: "sample.desaturate" });
const after = doc.getPixels("Test paint").data.data;
if (!(after[0] === after[1] && after[1] === after[2])) throw new Error("not desaturated: " + after.slice(0, 3));
if (editor.undo.length !== before + 1) throw new Error("no undo step");
await c("undo");
const back = doc.getPixels("Test paint").data.data;
if (back[0] !== 200) throw new Error("undo did not restore the pixels: " + back.slice(0, 3));
// C6 (c1): selection to layer reads the selection's bounds of the picture, exactly as the whole flatten has them. Clear
// of the text layer the stack is pixel by pixel (the Poster filter declares reach 0): a box read, no flatten, no display
// mirror. Over the text layer (drawn at half its pixels' size) a box read cannot be exact: the whole flatten, cropped.
const W = editor.width, H = editor.height;
const copies = {};
for (const [name, rect, flatsWanted] of [["clear of the text", { x: 260, y: 180, w: 200, h: 120 }, 0], ["over the text", { x: 100, y: 80, w: 200, h: 120 }, 1]]) {
    await c("select_rect", rect);
    const flatRef = editor.flattenToCanvas({ forRun: true }).getContext("2d").getImageData(0, 0, W, H).data;
    const selRef = editor.sel.readRect(0, 0, W, H).data;
    editor.releaseCaches({ mirrors: true });
    const f0 = editor.flattenToCanvas; let flats = 0, lastFlat = null;
    editor.flattenToCanvas = function (...q) { flats++; return (lastFlat = f0.apply(this, q)); };
    try { await c("run_action", { id: "sample.selection_layer" }); } finally { editor.flattenToCanvas = f0; }
    // C6 (c1) review: the whole flatten a box read fell back to is let go once the composite changes (the copy the action
    // added is such a change); it stayed, 572 MB of canvas at 15000 x 10000, until the next whole flatten replaced it
    const kept = !!(lastFlat && editor.flatCache && editor.flatCache.canvas === lastFlat);
    const copy = (await c("list_layers")).layers.filter((l) => l.name === "Selection copy").find((l) => l.x === rect.x && l.y === rect.y);
    if (!copy || copy.w !== 200 || copy.h !== 120) throw new Error("selection copy " + name + ": " + JSON.stringify(copy));
    if (flats !== flatsWanted) throw new Error(`selection to layer ${name} flattened the picture ${flats} times, ${flatsWanted} expected`);
    if (!flatsWanted && editor.tileMode && editor.memoryReport().tiles.mirrors) throw new Error("selection to layer made " + editor.memoryReport().tiles.mirrors + " display mirrors");
    const got = doc.getPixels(copy.id).data.data;
    let wrong = 0, max = 0;
    for (let y = 0; y < copy.h; y++) for (let x = 0; x < copy.w; x++) {
        const i = (y * copy.w + x) * 4, j = ((copy.y + y) * W + copy.x + x) * 4;
        const on = selRef[j + 3] > 127;
        for (let k = 0; k < 4; k++) { const want = on ? flatRef[j + k] : 0; const d = Math.abs(got[i + k] - want); if (d) wrong++; if (d > max) max = d; }
    }
    if (wrong) throw new Error(`the selection copy ${name} differs from the whole flatten in ${wrong} bytes (max ${max})`);
    copies[name] = { x: copy.x, y: copy.y, flats, kept };
    if (kept) throw new Error(`the whole flatten of the box read ${name} is still kept after the composite changed`);
    await c("remove_layer", { layer: copy.id });
}
await c("select_rect", { x: 100, y: 80, w: 200, h: 120 });
await c("run_action", { id: "sample.selection_layer" });
const copy = (await c("list_layers")).layers.find((l) => l.name === "Selection copy");
if (!copy || copy.w !== 200 || copy.h !== 120) throw new Error("selection copy: " + JSON.stringify(copy));
return { action: r, copy: { w: copy.w, h: copy.h, x: copy.x, y: copy.y }, copies };
"""),
    ("plugin_tool_and_panel", """
const H = (await import("./editor/host.js")).host;
editor.setTool("sample.probe");
if (editor.tool !== "sample.probe") throw new Error("tool not set");
const btn = editor.toolButtons["sample.probe"];
if (!btn || !btn.classList.contains("ipc-active")) throw new Error("tool button missing or not active");
const fake = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, pressure: 0.5, pointerType: "mouse", type: "pointermove" };
// C6 (c1): the probe reads one box of 256 px per square the cursor enters, exactly as the whole flatten has it: no
// flatten, no mirror, and no readback per hover (a canvas per pixel would count toward Chromium's acceleration latch)
const W = editor.width, H2 = editor.height;
const flatRef = editor.flattenToCanvas({ forRun: true }).getContext("2d").getImageData(0, 0, W, H2).data;
editor.releaseCaches({ mirrors: true });
const f0 = editor.flattenToCanvas, gid = CanvasRenderingContext2D.prototype.getImageData;
let flats = 0; const readCanvases = new Set();
editor.flattenToCanvas = function (...q) { flats++; return f0.apply(this, q); };
CanvasRenderingContext2D.prototype.getImageData = function (...q) { readCanvases.add(this.canvas); return gid.apply(this, q); };
const hovers = [];
let handled;
try {
    editor.setTool("select");
    editor.setTool("sample.probe");   // a new tool selection starts with no squares read
    for (let k = 0; k < 20; k++) {
        const [x, y] = [[300, 100], [400, 300], [40, 300]][k % 3];   // three squares clear of the text layer
        const hx = x + (k % 5), hy = y + (k % 7);
        handled = H.pluginPointer(editor, "move", fake, hx, hy);
        const i = (hy * W + hx) * 4;
        hovers.push([hx, hy, editor.status, [flatRef[i], flatRef[i + 1], flatRef[i + 2]]]);
    }
} finally { editor.flattenToCanvas = f0; CanvasRenderingContext2D.prototype.getImageData = gid; }
if (!handled || !/rgb\\(/.test(editor.status)) throw new Error("hover did not probe: " + editor.status);
for (const [hx, hy, st, want] of hovers) if (!st.includes(`${hx}, ${hy}: rgb(${want[0]}, ${want[1]}, ${want[2]})`)) throw new Error(`the probe at ${hx}, ${hy} said "${st}", the whole flatten has rgb(${want})`);
if (flats) throw new Error("the probe flattened the picture " + flats + " times");
if (readCanvases.size > 3) throw new Error("20 hovers over 3 squares read back " + readCanvases.size + " canvases");
if (editor.tileMode && editor.memoryReport().tiles.mirrors) throw new Error("the probe made " + editor.memoryReport().tiles.mirrors + " display mirrors");
// the square with the text layer in it (drawn at half its pixels' size): the whole flatten, once, and exact
H.pluginPointer(editor, "move", fake, 150, 100);
{ const i = (100 * W + 150) * 4; if (!editor.status.includes(`150, 100: rgb(${flatRef[i]}, ${flatRef[i + 1]}, ${flatRef[i + 2]})`)) throw new Error("the probe over the text layer said " + editor.status); }
const down = H.pluginPointer(editor, "down", { ...fake, type: "pointerdown" }, 150, 100);
if (!down || !editor.pointer || editor.pointer.kind !== "plugin") throw new Error("down not routed");
H.pluginPointer(editor, "up", fake, 150, 100, editor.pointer); editor.pointer = null;
// the key shortcut K selects the tool
editor.setTool("select");
const keyHandled = H.pluginKey(editor, { shiftKey: false }, "k");
if (!keyHandled || editor.tool !== "sample.probe") throw new Error("key K did not select the tool");
editor.setTool("select");
// the sample has no side panel since 2026-10-03 (the user); the Boxes plugin's panel stands for the panel API below
if (Array.from(editor.root.querySelectorAll("details > summary")).some((s) => s.textContent === "Sample")) throw new Error("the Sample panel is back");
const grp = editor.toolsEl.querySelector(".ipc-grp:last-of-type");
return { status: editor.status, group: grp && grp.textContent };
"""),
    ("export", """
const r = await c("export", { format: "png", path: %s });
const l = await c("export_layer", { layer: "Title", path: %s });
const m = await c("export_mask", { path: %s });
const st = await c("get_state");
// a scaled export: half the size by percent, a free width, and the full size again
const host = (await import("./editor/host.js")).host;
const ed = host.editor;
const half = await c("export", { format: "png", path: %s, scale: 50 });
if (!/256 . 192/.test(half.status)) throw new Error("scale 50 did not halve it: " + half.status);
const wide = await c("export", { format: "jpg", path: %s, width: 300, quality: 0.6 });
if (!/300 . 225/.test(wide.status)) throw new Error("width 300 did not keep the aspect: " + wide.status);
if (host.exportState(ed).percent !== 100 || host.exportState(ed).width) throw new Error("the command changed the document's own export size");
const full = await c("export", { format: "png", path: %s });
if (!/512 . 384/.test(full.status)) throw new Error("the plain export is not full size: " + full.status);
return { image: r.file, layer: l.file, mask: m.file, state_layers: (st.layers || []).length, half: half.file.bytes, wide: wide.file.bytes, full: full.file.bytes };
""" % (out_path("commands_image.png"), out_path("commands_layer.png"), out_path("commands_mask.png"),
       out_path("commands_half.png"), out_path("commands_wide.jpg"), out_path("commands_full.png"))),
    ("reload_and_toggle", """
const P = await import("./plugins.js");
const n0 = (await c("list_layers")).layers.length;
await P.reloadPlugins();
let list = await c("list_plugins");
let s = list.plugins.find((p) => p.id === "sample");
if (!s || !s.loaded) throw new Error("sample not loaded after reload: " + JSON.stringify(s));
const poster = (await c("list_layers")).layers.find((l) => l.name === "Poster");
if (!poster || poster.filter !== "sample.posterize") throw new Error("the poster layer lost its filter across the reload");
await P.setEnabled("sample", false);
list = await c("list_plugins"); s = list.plugins.find((p) => p.id === "sample");
if (s.loaded || s.enabled) throw new Error("still enabled");
if (editor.toolButtons["sample.probe"]) throw new Error("tool button still there");
if ((await c("filter_types")).filters.some((f) => f.id === "sample.posterize")) throw new Error("filter still registered");
await P.setEnabled("sample", true);
list = await c("list_plugins"); s = list.plugins.find((p) => p.id === "sample");
if (!s.loaded) throw new Error("not loaded again: " + s.error);
if (!editor.toolButtons["sample.probe"]) throw new Error("tool button not back");
if ((await c("list_layers")).layers.length !== n0) throw new Error("layer count changed");
// a plugin's side panel goes with the plugin and comes back with it (the Boxes plugin's, in the Generate pane)
const boxesPanel = () => Array.from(editor.root.querySelectorAll("details > summary")).some((x) => x.textContent === "Boxes");
if (!boxesPanel()) throw new Error("the Boxes panel is missing");
await P.setEnabled("boxes", false);
if (boxesPanel()) throw new Error("the Boxes panel is still there with the plugin off");
await P.setEnabled("boxes", true);
if (!boxesPanel()) throw new Error("the Boxes panel did not come back");
return { loaded: s.loaded, registered: s.registered };
"""),
    # item 28 S2 (docs/PLAN_BOXES.md §9): a plugin's box source through the core's collectBoxes. The loopback provider
    # declares no options.boxes, so a run cannot carry them here: the source is called with a fake context instead,
    # off by default, one box on, mapped into fractions of the frame, a duplicate id suffixed, switched off again.
    ("generate_boxes", """
const P = await import("./plugins.js");
if (P.API_VERSION < 3) throw new Error("API " + P.API_VERSION);
const ctx = { mode: "edit", recipe: "x", provider: "bfl", model: "flux-3-image", schema: "flux3", frame: { x: 100, y: 50, w: 800, h: 600 }, selection: null, references: [] };
if ((await c("sample.box")).on) throw new Error("the sample's box source is on by default");
let got = await P.collectBoxes(editor, ctx, []);
if (got.boxes.length !== 0 || got.notes.length !== 0) throw new Error("boxes with the flag off: " + JSON.stringify(got));
await c("sample.box", { on: true });
try {
    got = await P.collectBoxes(editor, ctx, []);
    const want = [{ id: "sample_1", kind: "new", rect: [0.25, 0.25, 0.75, 0.75], src: null, ref: null, desc: "a sample box in the middle of the frame" }];
    if (JSON.stringify(got.boxes) !== JSON.stringify(want)) throw new Error("mapped box: " + JSON.stringify(got));
    got = await P.collectBoxes(editor, ctx, [{ id: "sample_1" }]);
    if (got.boxes.length !== 1 || got.boxes[0].id !== "sample_2") throw new Error("duplicate id not suffixed: " + JSON.stringify(got.boxes));
    const s = (await c("list_plugins")).plugins.find((p) => p.id === "sample");
    if (!s.registered.generate || !s.registered.generate.includes("sample.box")) throw new Error("the source is not listed: " + JSON.stringify(s.registered));
} finally { await c("sample.box", { on: false }); }
if ((await c("sample.box")).on) throw new Error("still on");
if ((await P.collectBoxes(editor, ctx, [])).boxes.length) throw new Error("boxes after switching off");
return { box: got.boxes[0], version: P.API_VERSION };
"""),
    # Files above 64 MB take the editor's streaming upload route. That route has to land in
    # the local mirror like every other upload: proxied to ComfyUI instead, loading a large
    # image answered 502 with the server down, and the view found nothing afterwards.
    ("large_upload_route", """
const name = "commands_test_raw.png";
const png = async (w, h, noisy) => {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const cx = cv.getContext("2d");
    cx.fillStyle = "#2277cc"; cx.fillRect(0, 0, w, h);
    if (noisy) {   // noise does not compress: the second upload is clearly larger
        const img = cx.getImageData(0, 0, w, h);
        for (let off = 0; off < img.data.length; off += 65536) crypto.getRandomValues(img.data.subarray(off, Math.min(img.data.length, off + 65536)));
        for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
        cx.putImageData(img, 0, 0);
    }
    return new Promise((r) => cv.toBlob(r, "image/png"));
};
const send = (blob) => fetch("/comfy/inpaint_canvas/upload?" + new URLSearchParams({
    filename: name, subfolder: "inpaint_canvas", type: "input", overwrite: "true",
}), { method: "POST", body: blob, headers: { "Content-Type": "application/octet-stream" } });

const small = await png(64, 48, false), big = await png(400, 300, true);
if (big.size <= small.size) throw new Error("the test blobs are the wrong way round");
let up = await send(small);
if (up.status !== 200) throw new Error("raw upload answered " + up.status + " " + (await up.text()).slice(0, 120));
// replace it with the larger one and watch the local store: only a mirrored upload changes
// it. A proxied one puts the file on the server alone, and with the server down (or with a
// stale connection state) nothing finds it again, which is what broke loading large images.
const before = await window.scumble.files.stats();
up = await send(big);
if (up.status !== 200) throw new Error("second raw upload answered " + up.status);
const info = await up.json();
if (info.name !== name) throw new Error("wrong name back: " + JSON.stringify(info));
const after = await window.scumble.files.stats();
if (after.bytes - before.bytes < big.size - small.size) {
    throw new Error(`the local store grew by ${after.bytes - before.bytes} bytes, expected ${big.size - small.size}: the upload was proxied instead of mirrored`);
}
const back = await fetch("/comfy/view?filename=" + name + "&subfolder=inpaint_canvas&type=input");
if (back.status !== 200) throw new Error("view answered " + back.status + ": the file did not reach the local store");
const got = (await back.arrayBuffer()).byteLength;
if (got !== big.size) throw new Error(`view returned ${got} bytes, uploaded ${big.size}`);
const img = await c("load_image", { filename: name, subfolder: "inpaint_canvas", type: "input", doc: window.__testDoc });
if (img.width !== 400 || img.height !== 300) throw new Error("loading it back gave " + img.width + "x" + img.height);
return { bytes: got, grew: after.bytes - before.bytes };
"""),
    ("screenshot_reads_levels", """
// C6 (c5): `screenshot` was a full-resolution flatten, and the display mirrors of a layer and of the selection:
// at 15000 x 10000 about 3.4 GB made and 2.9 GB kept for a 1024 px JPEG, on a command an agent calls after most
// steps. On tiles the image is a region pass at the output's level, a layer comes from its own tiles and the tint
// from the selection's, with the chains built in the mips worker. On canvases the picture is the old one, byte for byte.
const d = await c("new_document");
await c("new_canvas", { width: 3000, height: 2000, doc: d.id });
const ed = window.editor;
const P = await import("./editor/inpaint_pixels.js");
const W = ed.width, H = ed.height;
const base = document.createElement("canvas"); base.width = W; base.height = H;
{
    const x = base.getContext("2d");
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#305080"); g.addColorStop(1, "#d0a060");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 5; i++) { x.fillStyle = `hsl(${i * 72},60%,50%)`; x.beginPath(); x.arc(450 + i * 520, 900 + (i % 2) * 400, 330, 0, Math.PI * 2); x.fill(); }
}
Object.defineProperty(base, "naturalWidth", { value: W });
Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "shot.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
const paint = document.createElement("canvas"); paint.width = 2400; paint.height = 1600;
{ const x = paint.getContext("2d"); x.fillStyle = "#20c060"; x.fillRect(200, 200, 1400, 900); x.fillStyle = "rgba(200,40,40,0.6)"; x.fillRect(900, 600, 1300, 900); }
const L = ed.addLayer({ name: "Shot layer", kind: "paint", px: ed.pixels.Layer.fromCanvas(paint), x: 300, y: 200, w: 2400, h: 1600, dirty: true });
ed.sel.drawInto(null, (s) => { s.fillStyle = "#ff0000"; s.beginPath(); s.ellipse(1500.5, 1000.5, 900, 600, 0, 0, Math.PI * 2); s.fill(); });
ed.markSelectionChanged();
ed.renderLayers(); ed.fitView(); ed.draw();
await ed.mipsSettled();

// the function as it was before C6 (c5)
const oldShot = (a) => {
    const max = a.max_size;
    const src = a.what === "layer" ? { px: L.px, w: L.px.width, h: L.px.height } : { canvas: ed.flattenToCanvas({ forRun: a.what !== "editor" }), w: ed.width, h: ed.height };
    const s = Math.min(1, max / Math.max(src.w, src.h));
    const w = Math.max(1, Math.round(src.w * s)), h = Math.max(1, Math.round(src.h * s));
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#202020"; ctx.fillRect(0, 0, w, h);
    if (src.px) src.px.drawTo(ctx, 0, 0, w, h); else ctx.drawImage(src.canvas, 0, 0, w, h);
    const b = raw.bounds(ed);
    if (a.show_selection !== false && b && ed.sel && a.what !== "layer") {
        ctx.globalAlpha = 0.35; ed.sel.drawTo(ctx, 0, 0, w, h); ctx.globalAlpha = 1;
        ctx.strokeStyle = "#ff40ff"; ctx.lineWidth = 2; ctx.strokeRect(b.x * s, b.y * s, b.w * s, b.h * s);
    }
    return cv;
};
// primed cells a read holds until it releases them; another reader's (the film panel renders 500 ms after a change)
// may hold some for a moment, so a leak is cells that never drain
const primedDrained = async (ed) => { for (let i = 0; i < 60; i++) { const t = ed.memoryReport().tiles; if (!t || !t.primedBytes) return 0; await new Promise((r) => setTimeout(r, 50)); } return ed.memoryReport().tiles.primedBytes; };
const bytesOf = (cv) => cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
const cases = [
    { what: "image", max_size: 1024 },                     // level 1
    { what: "image", max_size: 256 },                      // level 3
    { what: "editor", max_size: 512, show_selection: false },
    { what: "layer", layer: L.id, max_size: 300 },         // level 3 of the layer's own pixels
    { what: "layer", layer: L.id, max_size: 4096 },        // scale 1: level 0
];
const out = { tiles: !!ed.tileMode, cases: [] };
try {
    for (const a of cases) {
        await ed.mipsSettled();
        ed.releaseCaches({ mirrors: true, deep: true });
        const f0 = ed.flattenToCanvas;
        let flats = 0;
        ed.flattenToCanvas = function (...q) { flats++; return f0.apply(this, q); };
        let got;
        try { got = await raw.shotCanvas(ed, a); } finally { ed.flattenToCanvas = f0; }
        const rep = ed.memoryReport();
        const row = { what: a.what, max_size: a.max_size, size: [got.w, got.h], scale: +got.s.toFixed(4), flats };
        if (ed.tileMode) {
            row.mirrors = rep.tiles.mirrors;
            if (flats) throw new Error(`${a.what} ${a.max_size}: the screenshot flattened the picture ${flats} times`);
            if (rep.tiles.mirrors) throw new Error(`${a.what} ${a.max_size}: the screenshot made ${rep.tiles.mirrors} display mirrors (${(rep.tiles.mirrorBytes / 1048576).toFixed(1)} MB)`);
            if (P.displayCanvasIfMade(ed.sel) || P.displayCanvasIfMade(L.px)) throw new Error(`${a.what} ${a.max_size}: a display mirror of the selection or the layer was made`);
            const leftP = await primedDrained(ed);
            if (leftP) throw new Error(`${a.what} ${a.max_size}: ${leftP} bytes of primed cells were left behind`);
        }
        const x = bytesOf(got.canvas), refC = oldShot(a), y = bytesOf(refC);
        if (got.canvas.width !== refC.width || got.canvas.height !== refC.height) throw new Error(`${a.what} ${a.max_size}: ${got.canvas.width}x${got.canvas.height} against the old ${refC.width}x${refC.height}`);
        let max = 0, far = 0, sum = 0;
        for (let i = 0; i < x.length; i++) { const dd = Math.abs(x[i] - y[i]); sum += dd; if (dd > max) max = dd; if (dd > 4) far++; }
        row.max = max; row.far = far; row.mean = +(sum / x.length).toFixed(3);
        if (!ed.tileMode) {
            if (max) throw new Error(`${a.what} ${a.max_size}: the canvas backend's picture changed by ${max} levels on ${far} bytes`);
        } else {
            // box-filtered levels against a bilinear draw of the whole flatten, which steps along every edge: the
            // edges differ (at 256 px about 2 % of the bytes), the rest agrees
            if (far > x.length * 0.05 || row.mean > 2) throw new Error(`${a.what} ${a.max_size}: ${far} of ${x.length} bytes differ by more than 4 levels from the old picture (max ${max}, mean ${row.mean})`);
            if (got.s === 1 && max > 1) throw new Error(`${a.what} ${a.max_size}: a read at scale 1 differs by ${max} levels`);
        }
        // the layer is in the picture: its green block, over the fill or the base
        const gx = Math.round((a.what === "layer" ? 600 : 650) * got.s), gy = Math.round((a.what === "layer" ? 400 : 450) * got.s);
        const gi = (gy * got.w + gx) * 4;
        row.green = [x[gi], x[gi + 1], x[gi + 2]];
        if (!(x[gi + 1] > x[gi] + 60 && x[gi + 1] > x[gi + 2] + 60)) throw new Error(`${a.what} ${a.max_size}: the layer's green block is not at ${gx}, ${gy}: rgb(${row.green})`);
        out.cases.push(row);
    }
    // the tint: inside the ellipse brighter red than outside, as in the old picture
    const cv = (await raw.shotCanvas(ed, { what: "image", max_size: 512 })).canvas;
    const t = bytesOf(cv), s = 512 / W;
    const at = (px, py) => { const i = (Math.round(py * s) * cv.width + Math.round(px * s)) * 4; return [t[i], t[i + 1], t[i + 2]]; };
    out.tint = { inside: at(1500, 300 + 150), outside: at(100, 1900) };
} finally {
    await c("close_document", { doc: d.id, force: true });
    await c("activate_document", { doc: window.__testDoc });
}
return out;
"""),
    # docs/PLAN_REFS.md 26b1: @img1, @img2 name the shown reference layers top first; a new one takes the next number,
    # and every change of the shown references rewrites the prompt's tokens by layer id
    ("refs_labels", """
const d = await c("new_document");
window.__refsDoc = d.id;
const file = { filename: "test_base.png", subfolder: "inpaint_canvas", type: "input" };
await c("load_image", { ...file, doc: d.id });
const ed = window.editor;
if (ed.node.id !== d.id) throw new Error("the new document is not the active editor");
const A = await c("add_image_layer", { ...file, role: "reference", name: "refA" });
const B = await c("add_image_layer", { ...file, role: "reference", name: "refB" });
const names = () => ed.referenceLayers().map((l) => l.name);
if (names().join() !== "refA,refB") throw new Error("a new reference did not go below the others: " + names());
const dup = await c("duplicate_layer", { layer: "refA" });
if (names().join() !== "refA,refB,refA copy") throw new Error("the copy of a reference is not the last: " + names());
if (!/@img3/.test(ed.status)) throw new Error("the duplicate's status names no label: " + ed.status);
const p = await c("add_paint_layer", { name: "paintRef" });
await c("set_layer", { layer: p.id, role: "reference" });
if (names().join() !== "refA,refB,refA copy,paintRef") throw new Error("a role change to reference did not take the next number: " + names());
const labels = [...ed.refLabels()].map(([id, n]) => n + ":" + ed.layers.find((l) => l.id === id).name);
const badges = ed.refList ? [...ed.refList.querySelectorAll(".ipc-kind.ipc-ref")].map((e) => e.textContent) : null;
if (badges && badges.join() !== "img1,img2,img3,img4") throw new Error("the list badges: " + badges);
await c("remove_layer", { layer: dup.id });
await c("remove_layer", { layer: p.id });
window.__refA = A.id; window.__refB = B.id;
return { labels, badges, drift: ed._refDrift || 0 };
"""),
    ("refs_remap", """
const ed = window.editor;
const A = window.__refA, B = window.__refB;
const same = (what, want) => {
    if (ed.promptText !== want.p || ed.negativeText !== want.n) throw new Error(what + ": " + JSON.stringify([ed.promptText, ed.negativeText]) + " not " + JSON.stringify([want.p, want.n]));
    if (ed.promptInput && ed.promptInput.value !== ed.promptText) throw new Error(what + ": the field shows " + JSON.stringify(ed.promptInput.value));
};
const start = { p: "jacket from @img2, style of @img1", n: "no @img2" };
await c("set_prompt", { text: start.p, negative: start.n });
same("start", start);
await c("set_layer", { layer: A, visible: false });
same("A hidden", { p: "jacket from @img1, style of @img?" + A, n: "no @img1" });
await c("set_layer", { layer: A, visible: true });
same("A shown", start);
ed.moveReference(ed.layers.find((l) => l.id === B), +1);
same("B up", { p: "jacket from @img1, style of @img2", n: "no @img1" });
await c("undo");
same("undo of B up", start);
await c("remove_layer", { layer: A });
same("A deleted", { p: "jacket from @img1, style of @img?" + A, n: "no @img1" });
await c("undo");
same("undo of the delete", start);
await c("set_layer", { layer: A, role: "none" });
same("A no reference", { p: "jacket from @img1, style of @img?" + A, n: "no @img1" });
await c("set_layer", { layer: A, role: "reference" });
same("A a reference again, below B", { p: "jacket from @img1, style of @img2", n: "no @img1" });
await c("undo");
same("undo of the role change", { p: "jacket from @img1, style of @img?" + A, n: "no @img1" });
await c("undo");
same("undo of both role changes", start);
// A (right above B in the stack) into B: the absorbed reference's tokens name the survivor
const order = ed.layers.map((l) => l.id);
if (order.indexOf(A) !== order.indexOf(B) + 1) throw new Error("refA is not right above refB: " + ed.layers.map((l) => l.name));
await c("merge_down", { layer: A });
same("A merged into B", { p: "jacket from @img1, style of @img1", n: "no @img1" });
await c("undo");
if (ed.refLabels().size !== 2) throw new Error("the merge's undo did not bring A back");
// the merge's undo does not split the tokens again (docs/PLAN_REFS.md 26b edge cases): both follow B, now img2
same("undo of the merge", { p: "jacket from @img2, style of @img2", n: "no @img2" });
if (ed._refDrift) throw new Error("the reference labels drifted " + ed._refDrift + " times without a remap");
await c("set_prompt", { text: start.p, negative: start.n });
return { prompt: ed.promptText, drift: ed._refDrift || 0 };
"""),
    # 26b2: a provider run sends markers that main names by the route's own pattern; what cannot be sent is refused at
    # once (no request, no 30 s wait); a ComfyUI recipe names them in the renderer (26e)
    ("refs_send", """
const ed = window.editor;
const { host, api } = await import("./editor/host.js");
const A = window.__refA, B = window.__refB;
const P0 = "jacket from @img2, style of @img1", N0 = "no @img2";
if (ed.promptText !== P0 || ed.negativeText !== N0) throw new Error("the prompt the step starts from: " + JSON.stringify([ed.promptText, ed.negativeText]));
const prev = host.recipe, mode0 = ed.genSettings.mode, refine0 = !!ed.genSettings.refine;
const crop0 = { fill: ed.cropSettings.fill, withOriginal: ed.cropSettings.withOriginal };
const newLayers = async (before) => { for (const l of ed.layers.filter((x) => !before.has(x.id))) await c("remove_layer", { layer: l.id }); };
// a refused Generate: the message, fast, nothing added
const refused = async (re, what) => {
    const h0 = ed.history.length, n0 = ed.layers.length, t0 = Date.now();
    let msg = null;
    try { await c("generate", { timeout: 60 }); } catch (err) { msg = String(err.message || err); }
    const ms = Date.now() - t0;
    if (!msg || !re.test(msg)) throw new Error(what + " was not refused as expected: " + msg);
    if (ms > 5000) throw new Error(what + ": the refusal took " + ms + " ms (a wait for a result that never comes)");
    if (ed.history.length !== h0 || ed.layers.length !== n0) throw new Error(what + ": a refused run added a result");
    if (!ed.lastRunError || !re.test(ed.lastRunError.message)) throw new Error(what + ": lastRunError is " + (ed.lastRunError && ed.lastRunError.message));
    return { msg, ms };
};
const out = {};
try {
    host.setRecipe(__LOOP_EDIT__);
    await c("set_crop", { fill: "none", withOriginal: false });
    await c("select_rect", { x: 40, y: 40, w: 120, h: 90 });
    // the click snapshot: the shown references top first, their labels, both texts
    const snap = ed.refSnapshot();
    if (snap.prompt !== P0 || snap.negative !== N0 || snap.refIds.join() !== [A, B].join() || snap.labels.get(A) !== 1 || snap.labels.get(B) !== 2) throw new Error("the snapshot: " + JSON.stringify({ ...snap, labels: [...snap.labels] }));
    if (ed.predictOriginal() !== 0) throw new Error("predictOriginal without a fill: " + ed.predictOriginal());
    // 1. no Original: the crop is image 1, refA (img1) image 2, refB (img2) image 3
    let before = new Set(ed.layers.map((l) => l.id));
    let g = await c("generate", { timeout: 60 });
    if (g.prompt_sent !== "jacket from image 3, style of image 2") throw new Error("sent without the Original: " + JSON.stringify(g.prompt_sent));
    if (ed.lastSentPrompt !== g.prompt_sent) throw new Error("lastSentPrompt: " + JSON.stringify(ed.lastSentPrompt));
    if (ed.lastRunError) throw new Error("a run that went through left lastRunError: " + ed.lastRunError.message);
    if (!/@img2 . image 3/.test(g.status) || !/@img1 . image 2/.test(g.status)) throw new Error("the status names no mapping: " + g.status);
    if (!g.layer || g.layer.role !== "none" || "label" in g.layer) throw new Error("the result layer: " + JSON.stringify(g.layer));
    if (ed.promptText !== P0 || ed.negativeText !== N0) throw new Error("the run changed the document's prompt: " + JSON.stringify([ed.promptText, ed.negativeText]));
    await newLayers(before);
    out.plain = g.prompt_sent;
    // 2. a green fill with the Original: the Original is image 2, the references image 3 and image 4
    await c("set_crop", { fill: "green", withOriginal: true });
    if (ed.predictOriginal() !== 1) throw new Error("predictOriginal with a green fill and the Original on: " + ed.predictOriginal());
    await c("set_generation", { refine: true });
    const withRefine = [ed.predictOriginal(), ed.predictOriginal({ local: true })];
    await c("set_generation", { refine: refine0 });
    if (withRefine.join() !== "1,0") throw new Error("predictOriginal with refine on (api, local): " + withRefine);
    before = new Set(ed.layers.map((l) => l.id));
    g = await c("generate", { timeout: 60 });
    if (g.prompt_sent !== "jacket from image 4, style of image 3") throw new Error("sent with the Original: " + JSON.stringify(g.prompt_sent));
    if (!/@img2 . image 4/.test(g.status) || !/@img1 . image 3/.test(g.status)) throw new Error("the status with the Original: " + g.status);
    await newLayers(before);
    out.original = g.prompt_sent;
    // the run helper called directly (no snapshot passed): the Original goes along as the first reference
    before = new Set(ed.layers.map((l) => l.id));
    const rp = await host.runProvider(ed);
    if (!rp.info || rp.info.original !== 1 || rp.info.references !== 3) throw new Error("the loopback got " + JSON.stringify(rp.info));
    if (rp.info.prompt !== "jacket from image 4, style of image 3" || rp.info.negative !== "no image 4") throw new Error("the texts the loopback got: " + JSON.stringify([rp.info.prompt, rp.info.negative]));
    if (rp.prompt !== rp.info.prompt) throw new Error("runProvider's prompt: " + JSON.stringify(rp.prompt));
    const byRef = Object.fromEntries((rp.refs || []).map((r) => [r.ref, r.name]));
    if (byRef[1] !== "image 3" || byRef[2] !== "image 4") throw new Error("runProvider's refs: " + JSON.stringify(rp.refs));
    await newLayers(before);
    // 3. a parked token (refA hidden) is refused, fast, before anything is sent
    await c("set_layer", { layer: A, visible: false });
    if (ed.promptText !== "jacket from @img1, style of @img?" + A) throw new Error("A hidden: " + ed.promptText);
    const hid = await refused(/hidden reference/, "a hidden reference's token");
    if (!hid.msg.includes('"refA"') || !hid.msg.includes("@img?" + A)) throw new Error("the refusal names neither the layer nor the token: " + hid.msg);
    await c("set_layer", { layer: A, visible: true });
    if (ed.promptText !== P0 || ed.negativeText !== N0) throw new Error("A shown again: " + JSON.stringify([ed.promptText, ed.negativeText]));
    out.parked = hid;
    // 4. a number no reference holds, and the marker syntax typed by hand
    await c("set_prompt", { text: "a hat from @img3" });
    out.unknown = await refused(/@img3 names no reference image/, "@img3 with two references");
    if (!/@img1 to @img2/.test(out.unknown.msg)) throw new Error("the refusal does not say which tokens exist: " + out.unknown.msg);
    await c("set_prompt", { text: "x {@ref:1}" });
    out.literal = await refused(/keeps for itself/, "a literal marker");
    await c("set_prompt", { text: P0, negative: N0 });
    // 5. a ComfyUI recipe names the tokens itself (26e): a graph it cannot trace names them by the batch's order (the
    //    crop, the Original, the references; a guess, and the status says so); past the recipe's declared slots a token
    //    refuses before anything is queued
    const saved = { connected: host.connected, objectInfo: host.objectInfo, ensure: host.ensureOnServer, queue: api.queuePrompt, helper: ed.helperUsed };
    let queued = 0, sent = null;
    try {
        host.connected = true;
        host.objectInfo = {};
        host.ensureOnServer = async () => null;
        api.queuePrompt = async (n, body) => { queued++; sent = body; return { prompt_id: "gate-refs" }; };
        ed.helperUsed = false;
        const stub = { id: "comfy_refs_stub", kind: "comfy", name: "Comfy stub", mode: "local", result: ["9", 0], canvas: "1", prompt: { "1": { class_type: "InpaintCanvas", inputs: {} } }, settings: [], needs: [] };
        host.setRecipe(stub);
        await host.queueGenerate(ed);
        if (queued !== 1) throw new Error("the ComfyUI run queued " + queued + " prompts");
        const st = JSON.parse(sent.output["1"].inputs.canvas_state);
        if (st.prompt !== "jacket from image 4, style of image 3" || st.negative !== "no image 4") throw new Error("the ComfyUI state's texts: " + JSON.stringify([st.prompt, st.negative]));
        if (st.named_refs !== true || st.hasSelection !== true || (st.references || []).length !== 2) throw new Error("the ComfyUI state: " + JSON.stringify({ named: st.named_refs, sel: st.hasSelection, refs: (st.references || []).length }));
        if (!/@img2 . image 4/.test(ed.status) || !/wording guessed from the graph/.test(ed.status)) throw new Error("the ComfyUI status: " + ed.status);
        if (ed.lastSentPrompt !== st.prompt) throw new Error("lastSentPrompt of the ComfyUI run: " + JSON.stringify(ed.lastSentPrompt));
        if (ed.promptText !== P0 || ed.negativeText !== N0) throw new Error("the ComfyUI run changed the document's prompt: " + JSON.stringify([ed.promptText, ed.negativeText]));
        out.comfy = st.prompt;
        // three pictures: the crop, the Original, img1 (Original on from 2.)
        host.setRecipe({ ...stub, id: "comfy_refs_stub3", refs: { name: "image {n}", slots: 3 } });
        out.slots = await refused(/@img2 cannot be named: Comfy stub reads 3 pictures \\(the crop, the Original and img1\\)\\. Hide a reference, turn Original off, or take @img2 out\\./, "a token past the recipe's slots");
        if (queued !== 1) throw new Error("the refused run queued a prompt");
    } finally {
        host.connected = saved.connected; host.objectInfo = saved.objectInfo; host.ensureOnServer = saved.ensure; api.queuePrompt = saved.queue; ed.helperUsed = saved.helper;
    }
} finally {
    host.setRecipe(prev);
    if (ed.genSettings.mode !== mode0) { ed.genSettings.mode = mode0; if (ed.syncGenControls) ed.syncGenControls(); }
    if (!!ed.genSettings.refine !== refine0) await c("set_generation", { refine: refine0 });
    await c("set_crop", crop0);
    await c("select_none");
    if (ed.promptText !== P0 || ed.negativeText !== N0) await c("set_prompt", { text: P0, negative: N0 });
}
if (ed.referenceLayers().map((l) => l.id).join() !== [A, B].join()) throw new Error("the references after the step: " + ed.referenceLayers().map((l) => l.name));
if (ed._refDrift) throw new Error("the reference labels drifted " + ed._refDrift + " times without a remap");
return out;
""".replace("__LOOP_EDIT__", LOOP_EDIT)),
    # 26b2: a route that sends no pictures writes the tokens as the layers' names, cleaned (no @, quotes or braces), in
    # the request only; the Upscale dialog is prefilled the same way (Generate new keeps the tokens since 26f)
    ("refs_names", """
const ed = window.editor;
const { host } = await import("./editor/host.js");
const rt = await import("./editor/reftokens.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const A = window.__refA, B = window.__refB;
const P0 = "jacket from @img2, style of @img1", N0 = "no @img2";
if (ed.promptText !== P0 || ed.negativeText !== N0) throw new Error("the prompt the step starts from: " + JSON.stringify([ed.promptText, ed.negativeText]));
const prev = host.recipe;
const odd = "@img2 {@ref:1} coat", clean = rt.clean(odd);
if (clean !== "img2 ref:1 coat") throw new Error("clean(): " + JSON.stringify(clean));
const out = {};
try {
    await c("set_layer", { layer: A, name: odd });
    if (ed.promptText !== P0) throw new Error("a rename changed the prompt: " + ed.promptText);
    // 1. an upscaler that takes a prompt: the token goes out as the cleaned name, and the status says so
    host.setRecipe(__LOOP_UP__);
    await c("select_rect", { x: 40, y: 40, w: 120, h: 90 });
    const u = await c("upscale", { scope: "selection", prompt: "crisp @img1" });
    const got = u.info && u.info.prompt;
    if (got !== "crisp " + clean) throw new Error("the upscaler got " + JSON.stringify(got));
    if (got.includes("@img") || got.includes("{@ref")) throw new Error("a token or a marker reached the upscaler: " + got);
    if (u.info.references !== 0) throw new Error("the upscale sent reference pictures: " + u.info.references);
    if (!/Upscale sends no reference images/.test(u.status) || !/written as/.test(u.status) || !u.status.includes(clean)) throw new Error("the status: " + u.status);
    if (ed.promptText !== P0 || ed.negativeText !== N0) throw new Error("the names were written into the document's prompt: " + JSON.stringify([ed.promptText, ed.negativeText]));
    if (u.layer) await c("remove_layer", { layer: u.layer.id });
    out.upscale = got;
    host.setRecipe(prev);
    // 2. the helper the dialogs use: live and parked tokens of existing layers get the names
    const rn = await host.refNames(ed, "the coat of @img1");
    if (rn.text !== "the coat of " + clean) throw new Error("refNames: " + JSON.stringify(rn));
    if (typeof rn.note !== "string" || !rn.note) throw new Error("refNames wrote a name and gave no note: " + JSON.stringify(rn));
    const plain = await host.refNames(ed, "plain words");
    if (plain.text !== "plain words") throw new Error("refNames without a token: " + JSON.stringify(plain));
    const parked = await host.refNames(ed, "no @img?" + B);
    if (parked.text !== "no refB") throw new Error("refNames of a parked token whose layer exists: " + JSON.stringify(parked));
    // 3. the Upscale dialog's field holds the names; Generate new keeps the tokens since 26f (it sends the references
    // where the model takes them); the document's prompt keeps its tokens
    const want = "jacket from refB, style of " + clean;
    await host.shell.openGenerateNew(ed);
    const gen = document.getElementById("gen-prompt").value;
    document.getElementById("gen-cancel").click();
    await wait(80);
    if (gen !== P0) throw new Error("the Generate new prefill: " + JSON.stringify(gen));
    host.shell.openUpscale(ed);
    const up = document.getElementById("up-prompt").value;
    document.getElementById("up-cancel").click();
    await wait(80);
    if (up !== want) throw new Error("the Upscale prefill: " + JSON.stringify(up));
    if (ed.promptText !== P0 || ed.negativeText !== N0) throw new Error("a prefill changed the document's prompt: " + ed.promptText);
    out.prefill = gen;
} finally {
    host.setRecipe(prev);
    for (const id of ["gen-dialog", "up-dialog"]) { const d = document.getElementById(id); if (d && d.open) d.close(); }
    await c("set_layer", { layer: A, name: "refA" });
    await c("select_none");
}
if (ed.promptText !== P0) throw new Error("the prompt after the step: " + ed.promptText);
if (ed._refDrift) throw new Error("the reference labels drifted " + ed._refDrift + " times without a remap");
return out;
""".replace("__LOOP_UP__", LOOP_UP)),
    # 26b2: what an agent sees and writes: labels in the layer summaries, status.references with sent_as, set_prompt
    # with the agent's own numbers (refs), read by layer id and written as the labels of now
    ("refs_agents", """
const ed = window.editor;
const { host } = await import("./editor/host.js");
const A = window.__refA, B = window.__refB;
const P0 = "jacket from @img2, style of @img1", N0 = "no @img2";
if (ed.promptText !== P0 || ed.negativeText !== N0) throw new Error("the prompt the step starts from: " + JSON.stringify([ed.promptText, ed.negativeText]));
const prev = host.recipe;
const crop0 = { fill: ed.cropSettings.fill, withOriginal: ed.cropSettings.withOriginal };
const layer = (ls, id) => ls.find((l) => l.id === id) || {};
const ref = (st, id) => (st.references || []).find((r) => r.id === id) || {};
const out = {};
try {
    host.setRecipe(__LOOP_EDIT__);
    await c("set_crop", { fill: "none", withOriginal: false });
    await c("select_none");
    // 1. the layer summaries: a shown reference names its token, other layers carry no label
    let ls = (await c("list_layers")).layers;
    if (layer(ls, A).label !== "img1" || layer(ls, B).label !== "img2") throw new Error("list_layers labels: " + JSON.stringify(ls.map((l) => [l.name, l.label])));
    const stray = ls.filter((l) => l.role !== "reference" && "label" in l);
    if (stray.length) throw new Error("a layer that is no reference has a label: " + stray.map((l) => l.name));
    let st = await c("status");
    if ((st.references || []).map((r) => r.id).join() !== [A, B].join()) throw new Error("status.references, top first: " + JSON.stringify(st.references));
    if (ref(st, A).label !== "img1" || ref(st, A).name !== "refA" || ref(st, A).visible !== true) throw new Error("status.references for refA: " + JSON.stringify(ref(st, A)));
    if (layer(st.layers, B).label !== "img2") throw new Error("status.layers label of refB: " + JSON.stringify(layer(st.layers, B)));
    // sent_as: the loopback's picture names; no selection, so no Original: refA image 2, refB image 3
    if (ref(st, A).sent_as !== "image 2" || ref(st, B).sent_as !== "image 3") throw new Error("sent_as without the Original: " + JSON.stringify(st.references));
    // 2. refB hidden: no label, no picture name, and the descriptors agree
    await c("set_layer", { layer: B, visible: false });
    ls = (await c("list_layers")).layers;
    if (layer(ls, B).label !== null || layer(ls, A).label !== "img1") throw new Error("list_layers with refB hidden: " + JSON.stringify(ls.map((l) => [l.name, l.label])));
    st = await c("status");
    const rb = ref(st, B);
    if (rb.label !== null || rb.visible !== false || rb.sent_as !== null) throw new Error("status.references for the hidden refB: " + JSON.stringify(rb));
    if (ref(st, A).sent_as !== "image 2") throw new Error("sent_as of refA with refB hidden: " + JSON.stringify(ref(st, A)));
    const desc = ed.refDescriptors().map((d) => [d.id, d.label, d.visible]);
    if (JSON.stringify(desc) !== JSON.stringify([[A, 1, true], [B, null, false]])) throw new Error("refDescriptors: " + JSON.stringify(desc));
    // the agent's img1 is the hidden refB: its token waits as @img?<id> and comes back when refB is shown
    let r = await c("set_prompt", { text: "coat of @img1", refs: { img1: B } });
    if (r.prompt !== "coat of @img?" + B || !(r.parked || []).includes("@img?" + B)) throw new Error("set_prompt refs to a hidden reference: " + JSON.stringify(r));
    await c("set_layer", { layer: B, visible: true });
    if (ed.promptText !== "coat of @img2") throw new Error("refB shown again: " + ed.promptText);
    await c("set_prompt", { text: P0, negative: N0 });
    // 3. a selection, a green fill and the Original: the references move one picture on
    await c("select_rect", { x: 40, y: 40, w: 120, h: 90 });
    await c("set_crop", { fill: "green", withOriginal: true });
    st = await c("status");
    if (ref(st, A).sent_as !== "image 3" || ref(st, B).sent_as !== "image 4") throw new Error("sent_as with the Original: " + JSON.stringify(st.references));
    const lay = await host.refLayout(ed);
    if (!lay || lay.local !== false || lay.names.get(A) !== "image 3" || lay.names.get(B) !== "image 4" || lay.over.size) throw new Error("refLayout: " + JSON.stringify(lay && { names: [...lay.names], over: [...lay.over], local: lay.local, none: lay.none }));
    out.sent_as = st.references.map((x) => x.sent_as);
    await c("set_crop", crop0);
    await c("select_none");
    // 4. set_prompt with the agent's numbers: its img1 is refB, written as refB's label now (the negative too)
    r = await c("set_prompt", { text: "the coat of @img1", negative: "no @img1", refs: { img1: B } });
    if (r.prompt !== "the coat of @img2" || r.negative !== "no @img2" || ed.promptText !== r.prompt) throw new Error("set_prompt refs: " + JSON.stringify(r));
    if (!r.labels || r.labels.img1 !== A || r.labels.img2 !== B || Object.keys(r.labels).length !== 2 || (r.parked || []).length) throw new Error("set_prompt's labels: " + JSON.stringify(r));
    // after a reorder (refB up: refB img1, refA img2) the agent's img1 = refA is written as @img2
    ed.moveReference(ed.layers.find((l) => l.id === B), +1);
    if (ed.promptText !== "the coat of @img1") throw new Error("refB up: " + ed.promptText);
    r = await c("set_prompt", { text: "sleeves of @img1", refs: { img1: A } });
    if (r.prompt !== "sleeves of @img2" || r.labels.img1 !== B || r.labels.img2 !== A) throw new Error("set_prompt refs after the reorder: " + JSON.stringify(r));
    // the undo puts refA back to img1, and the token follows it
    await c("undo");
    if (ed.promptText !== "sleeves of @img1") throw new Error("the undo of the reorder: " + ed.promptText);
    if (ed.refLabels().get(A) !== 1) throw new Error("the undo did not put refA back on top");
    // the key forms: "@img2", and a number the document does not have
    r = await c("set_prompt", { text: "belt of @img2", refs: { "@img2": B } });
    if (r.prompt !== "belt of @img2") throw new Error("the key @img2: " + JSON.stringify(r));
    r = await c("set_prompt", { text: "hat of @img7", refs: { img7: A } });
    if (r.prompt !== "hat of @img1") throw new Error("the key img7: " + JSON.stringify(r));
    // refused, and the prompt left as it was: an unknown layer id, keys that are no token
    const kept = ed.promptText;
    out.refused = [];
    for (const bad of [{ img1: "Lnope" }, { foo: A }, { img0: A }]) {
        let m = null;
        try { await c("set_prompt", { text: "x @img1", refs: bad }); } catch (err) { m = String(err.message || err); }
        if (!m) throw new Error("set_prompt took refs " + JSON.stringify(bad));
        if (ed.promptText !== kept) throw new Error("a refused set_prompt changed the prompt: " + ed.promptText);
        out.refused.push(m);
    }
} finally {
    host.setRecipe(prev);
    await c("set_crop", crop0);
    await c("select_none");
    await c("set_prompt", { text: P0, negative: N0 });
}
if (ed.promptText !== P0 || ed.negativeText !== N0) throw new Error("the prompt after the step: " + JSON.stringify([ed.promptText, ed.negativeText]));
if (ed.referenceLayers().map((l) => l.id).join() !== [A, B].join()) throw new Error("the references after the step: " + ed.referenceLayers().map((l) => l.name));
if (ed._refDrift) throw new Error("the reference labels drifted " + ed._refDrift + " times without a remap");
return out;
""".replace("__LOOP_EDIT__", LOOP_EDIT)),
    # 26a2: a route that declares a drop gets neither the Original nor a reference (main strips them), the run goes and
    # says so in the status and in generate's notes; a prompt that names a reference there is refused at once
    ("refs_declared_drop", """
const ed = window.editor;
const { host } = await import("./editor/host.js");
const A = window.__refA, B = window.__refB;
const P0 = "jacket from @img2, style of @img1", N0 = "no @img2";
if (ed.promptText !== P0 || ed.negativeText !== N0) throw new Error("the prompt the step starts from: " + JSON.stringify([ed.promptText, ed.negativeText]));
const prev = host.recipe;
const crop0 = { fill: ed.cropSettings.fill, withOriginal: ed.cropSettings.withOriginal };
const newLayers = async (before) => { for (const l of ed.layers.filter((x) => !before.has(x.id))) await c("remove_layer", { layer: l.id }); };
const WHO = "Loopback (test) loopback";
const NOTE = WHO + ": test drop; the Original and 2 reference layers not sent.";
const out = {};
try {
    host.setRecipe({ ...__LOOP_EDIT__, options: { drops: "test drop" } });
    await c("select_rect", { x: 40, y: 40, w: 120, h: 90 });
    await c("set_crop", { fill: "green", withOriginal: true });
    if (ed.predictOriginal() !== 1) throw new Error("predictOriginal with a green fill and the Original on: " + ed.predictOriginal());
    // the preview says it before the click: no reference gets a picture name, and why
    const lay = await host.refLayout(ed);
    if (!lay || lay.none !== "test drop" || lay.names.get(A) !== null || lay.names.get(B) !== null || lay.over.size) throw new Error("refLayout of a drop: " + JSON.stringify(lay && { names: [...lay.names], over: [...lay.over], none: lay.none }));
    // 1. the prompt names references this route does not send: refused at once, nothing added
    const h0 = ed.history.length, n0 = ed.layers.length, t0 = Date.now();
    let msg = null;
    try { await c("generate", { timeout: 60 }); } catch (err) { msg = String(err.message || err); }
    if (!msg || !msg.includes(WHO + ": test drop, so the prompt cannot name a reference image")) throw new Error("tokens on a route that drops the references: " + msg);
    if (Date.now() - t0 > 5000) throw new Error("the refusal took " + (Date.now() - t0) + " ms");
    if (ed.history.length !== h0 || ed.layers.length !== n0) throw new Error("a refused run added a result");
    out.named = msg;
    // 2. no token: the run goes with the crop alone and says what it left out
    await c("set_prompt", { text: "a red door", negative: "" });
    let before = new Set(ed.layers.map((l) => l.id));
    const g = await c("generate", { timeout: 60 });
    if (!g.layer) throw new Error("no result layer: " + g.status);
    if (JSON.stringify(g.notes) !== JSON.stringify([NOTE])) throw new Error("generate's notes: " + JSON.stringify(g.notes));
    if (!g.status.includes("not sent") || !g.status.includes(NOTE)) throw new Error("the status says nothing of the drop: " + g.status);
    if (JSON.stringify(ed.lastRunNotes) !== JSON.stringify([NOTE])) throw new Error("lastRunNotes: " + JSON.stringify(ed.lastRunNotes));
    await newLayers(before);
    out.notes = g.notes;
    // the run helper called directly: the loopback got neither the Original nor a reference
    before = new Set(ed.layers.map((l) => l.id));
    const rp = await host.runProvider(ed);
    if (!rp.info || rp.info.references !== 0 || rp.info.original !== 0) throw new Error("the loopback got " + JSON.stringify(rp.info));
    if (JSON.stringify(rp.notes) !== JSON.stringify([NOTE])) throw new Error("runProvider's notes: " + JSON.stringify(rp.notes));
    if (!ed.status.includes(NOTE)) throw new Error("the status after runProvider: " + ed.status);
    await newLayers(before);
    out.info = { references: rp.info.references, original: rp.info.original };
} finally {
    host.setRecipe(prev);
    await c("set_crop", crop0);
    await c("select_none");
    await c("set_prompt", { text: P0, negative: N0 });
}
if (ed.promptText !== P0 || ed.negativeText !== N0) throw new Error("the prompt after the step: " + JSON.stringify([ed.promptText, ed.negativeText]));
if (ed.referenceLayers().map((l) => l.id).join() !== [A, B].join()) throw new Error("the references after the step: " + ed.referenceLayers().map((l) => l.name));
if (ed._refDrift) throw new Error("the reference labels drifted " + ed._refDrift + " times without a remap");
return out;
""".replace("__LOOP_EDIT__", LOOP_EDIT)),
    # docs/PLAN_0_1_38.md A2.1: generate reports the seed the model got, null when the route sends none (FLUX 3 Image;
    # the loopback's options.no_seed stands in), and the result's history row says so; a route that sends one reports it
    ("generate_reports_the_seed_the_model_got", """
const ed = window.editor;
const { host } = await import("./editor/host.js");
const prev = host.recipe;
const P0 = ed.promptText, N0 = ed.negativeText;
const g0 = { seed: ed.genSettings.seed, seedRandom: ed.genSettings.seedRandom };
const newLayers = async (before) => { for (const l of ed.layers.filter((x) => !before.has(x.id))) await c("remove_layer", { layer: l.id }); };
const rowText = () => { const row = ed.historyList && ed.historyList.querySelector(".ipc-htext"); return row ? row.textContent : ""; };
const out = {};
try {
    await c("set_prompt", { text: "a red door", negative: "" });
    await c("set_generation", { seed: 4242 });
    await c("select_rect", { x: 40, y: 40, w: 120, h: 90 });
    host.setRecipe({ ...__LOOP_EDIT__, options: { no_seed: true } });
    let before = new Set(ed.layers.map((l) => l.id));
    const none = await c("generate", { timeout: 60 });
    const h1 = ed.history[ed.history.length - 1];
    if (none.seed !== null || h1.seed !== null) throw new Error("a route without a seed reports " + JSON.stringify({ answer: none.seed, history: h1.seed }));
    if (!/api · no seed sent/.test(rowText()) || /seed 4242/.test(rowText())) throw new Error("the history row: " + rowText());
    await newLayers(before);
    out.none = rowText();
    host.setRecipe(__LOOP_EDIT__);
    before = new Set(ed.layers.map((l) => l.id));
    const sent = await c("generate", { timeout: 60 });
    const h2 = ed.history[ed.history.length - 1];
    if (sent.seed !== 4242 || h2.seed !== 4242 || !/seed 4242/.test(rowText())) throw new Error("a route with a seed reports " + JSON.stringify({ answer: sent.seed, history: h2.seed, row: rowText() }));
    await newLayers(before);
    out.sent = sent.seed;
} finally {
    host.setRecipe(prev);
    await c("select_none");
    await c("set_prompt", { text: P0, negative: N0 });
    ed.genSettings.seed = g0.seed;
    ed.genSettings.seedRandom = g0.seedRandom;
    ed.syncGenControls();
}
if (ed.promptText !== P0 || ed.negativeText !== N0) throw new Error("the prompt after the step: " + JSON.stringify([ed.promptText, ed.negativeText]));
return out;
""".replace("__LOOP_EDIT__", LOOP_EDIT)),
    # 26a2: a run with more pictures than the route takes is refused by main before the adapter runs, at once, with
    # nothing added; one reference fewer goes
    ("refs_over_cap", """
const ed = window.editor;
const { host } = await import("./editor/host.js");
const A = window.__refA, B = window.__refB;
const P0 = "jacket from @img2, style of @img1", N0 = "no @img2";
if (ed.promptText !== P0 || ed.negativeText !== N0) throw new Error("the prompt the step starts from: " + JSON.stringify([ed.promptText, ed.negativeText]));
const prev = host.recipe;
const crop0 = { fill: ed.cropSettings.fill, withOriginal: ed.cropSettings.withOriginal };
const newLayers = async (before) => { for (const l of ed.layers.filter((x) => !before.has(x.id))) await c("remove_layer", { layer: l.id }); };
const MSG = "Loopback (test) loopback takes at most 2 pictures; this run has 3 (the crop, 2 reference layers): hide reference layers or turn Original off.";
const out = {};
try {
    host.setRecipe({ ...__LOOP_EDIT__, options: { max_images: 2 } });
    await c("set_crop", { fill: "none", withOriginal: false });
    await c("select_rect", { x: 40, y: 40, w: 120, h: 90 });
    if (ed.predictOriginal() !== 0) throw new Error("predictOriginal without a fill: " + ed.predictOriginal());
    // the preview marks the reference past the cap (the lower one) before the click
    const lay = await host.refLayout(ed);
    if (!lay || lay.over.size !== 1 || !lay.over.has(B) || lay.names.get(A) !== "image 2" || lay.names.get(B) !== "image 3") throw new Error("refLayout over the cap: " + JSON.stringify(lay && { names: [...lay.names], over: [...lay.over], none: lay.none }));
    // 1. the crop and both references are 3 pictures: refused at once, nothing added, the loopback never ran
    const mark = await c("read_log", { limit: 1 });
    const after = mark.entries.length ? mark.entries[mark.entries.length - 1].id : 0;
    const h0 = ed.history.length, n0 = ed.layers.length, t0 = Date.now();
    let msg = null;
    try { await c("generate", { timeout: 60 }); } catch (err) { msg = String(err.message || err); }
    const ms = Date.now() - t0;
    if (!msg || !msg.includes(MSG)) throw new Error("over the cap was not refused as expected: " + msg);
    if (ms > 5000) throw new Error("the refusal took " + ms + " ms (a wait for a result that never comes)");
    if (ed.history.length !== h0 || ed.layers.length !== n0) throw new Error("a refused run added a result");
    if (!ed.lastRunError || !ed.lastRunError.message.includes("at most 2 pictures; this run has 3")) throw new Error("lastRunError: " + (ed.lastRunError && ed.lastRunError.message));
    const recs = (await c("read_log", { after })).entries.filter((e) => e.source === "loopback");
    if (recs.length !== 1 || recs[0].level !== "error" || !recs[0].message.includes("at most 2 pictures; this run has 3")) throw new Error("the loopback's log records: " + JSON.stringify(recs.map((e) => [e.level, e.message])));
    out.refused = { msg, ms };
    // 2. refB hidden (a prompt without tokens first): the crop and refA are 2 pictures, and the run goes
    await c("set_prompt", { text: "a red door", negative: "" });
    await c("set_layer", { layer: B, visible: false });
    const before = new Set(ed.layers.map((l) => l.id));
    const g = await c("generate", { timeout: 60 });
    if (!g.layer || JSON.stringify(g.notes) !== "[]") throw new Error("at the cap: " + JSON.stringify({ layer: !!g.layer, notes: g.notes, status: g.status }));
    await newLayers(before);
    out.atCap = g.status;
} finally {
    host.setRecipe(prev);
    await c("set_layer", { layer: B, visible: true });
    await c("set_crop", crop0);
    await c("select_none");
    await c("set_prompt", { text: P0, negative: N0 });
}
if (ed.promptText !== P0 || ed.negativeText !== N0) throw new Error("the prompt after the step: " + JSON.stringify([ed.promptText, ed.negativeText]));
if (ed.referenceLayers().map((l) => l.id).join() !== [A, B].join()) throw new Error("the references after the step: " + ed.referenceLayers().map((l) => l.name));
if (ed._refDrift) throw new Error("the reference labels drifted " + ed._refDrift + " times without a remap");
return out;
""".replace("__LOOP_EDIT__", LOOP_EDIT)),
    ("refs_restore", """
const ed = window.editor;
const A = window.__refA, B = window.__refB;
const P0 = "jacket from @img2, style of @img1";
if (ed.promptText !== P0) throw new Error("the prompt the step starts from: " + ed.promptText);
// 1. save and open: the prompt comes back byte for byte
const path = __OUT__;
await c("save_document", { path });
await c("close_document", { doc: window.__refsDoc, force: true });
const opened = await c("open_document", { path });
window.__refsDoc = opened.id;
let e2 = window.editor;
if (e2.promptText !== P0) throw new Error("the reopened prompt: " + JSON.stringify(e2.promptText));
if (e2.referenceLayers().map((l) => l.id).join() !== [A, B].join()) throw new Error("the reopened references: " + e2.referenceLayers().map((l) => l.name));
// 2. a reference whose file is gone: its tokens wait as @img?<id>, the others are renumbered
const state = JSON.parse(e2.getValue());
const la = state.layers.find((l) => l.id === A);
if (!la || !la.ref) throw new Error("the saved state holds no file for refA");
la.ref = { ...la.ref, filename: "refs_missing_file.png" };
const d2 = await c("new_document");
const e3 = window.editor;
await e3.setValue(JSON.stringify(state));
const missing = "jacket from @img1, style of @img?" + A;
if (e3.promptText !== missing) throw new Error("a missing reference: " + JSON.stringify(e3.promptText) + " not " + JSON.stringify(missing));
if (e3.referenceLayers().length !== 1) throw new Error("the missing reference loaded after all");
await c("close_document", { doc: d2.id, force: true });
await c("activate_document", { doc: window.__refsDoc });
e2 = window.editor;
// 3. a named snapshot holds the prompt with its layers; Revert's text follows the restore
let snap = "tiles only";
if (e2.tileMode) {
    e2.upsamplePending = { previous: e2.promptText, useCase: "edit" };
    e2.applyTextResult({ text: "Dress her in the jacket from @img2, in the style of @img1." });
    const P1 = e2.promptText;
    await c("take_snapshot", { name: "refs" });
    e2.moveReference(e2.layers.find((l) => l.id === B), +1);
    if (e2.promptText !== "Dress her in the jacket from @img1, in the style of @img2.") throw new Error("the move: " + e2.promptText);
    await c("set_layer", { layer: A, visible: false });
    await c("restore_snapshot", { name: "refs" });
    if (e2.promptText !== P1) throw new Error("the restored prompt: " + JSON.stringify(e2.promptText));
    if (e2.referenceLayers().map((l) => l.id).join() !== [A, B].join()) throw new Error("the restored references");
    e2.revertPrompt();
    if (e2.promptText !== P0) throw new Error("Revert after the restore names the wrong pictures: " + JSON.stringify(e2.promptText));
    snap = "ok";
}
if (e2._refDrift) throw new Error("the reference labels drifted " + e2._refDrift + " times without a remap");
await c("close_document", { doc: window.__refsDoc, force: true });
await c("activate_document", { doc: window.__testDoc });
return { reopened: P0, missing, snapshot: snap };
""".replace("__OUT__", out_path("refs_restore.scumble"))),
    ("close", """
const before = (await c("list_documents")).documents.length;
const r = await c("close_document", { doc: window.__testDoc });
if (r.documents.length !== before - 1) throw new Error("close_document");
return r;
"""),
]


async def run(c):
    ok = True
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); return 1; })()")
    for name, body in STEPS:
        js = "(async () => { const raw = window.__cmds; const c = (n, a) => raw.commands.run(n, a); %s })()" % body
        try:
            res = await c.eval(js, timeout=300)
            print(f"[ok] {name}: {json.dumps(res)[:300]}")
        except Exception as err:  # noqa: BLE001
            ok = False
            print(f"[FAIL] {name}: {err}")
            break
    try:
        data = await c.eval("window.__posterShot || null")
        if data:
            import base64
            with open(os.path.join(OUT, "commands_posterize.jpg"), "wb") as f:
                f.write(base64.b64decode(data))
    except Exception:  # noqa: BLE001
        pass
    await c.screenshot(os.path.join(OUT, "commands_window.png"))
    for level, text in (await c.logs())[-20:]:
        if level == "error":
            print("  console error:", text[:300])
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run)) else 1)
