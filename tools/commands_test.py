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
    ("layer_flip_and_refusals", """
// docs/PLAN_0_1_42.md F1: flip_layer axis x mirrors left to right (it reached the editor as a vertical flip), y top to
// bottom, one undo step each. remove_layer, flip_layer and center_layer refuse a locked layer (its own lock or its
// group's), flip_layer and center_layer a filter layer, with the reason and before the editor is called (it only set
// its status line, and the commands answered as if done)
const P = await import("./plugins.js");
const doc = new P.Document(editor);
const W = 40, H = 20;
const img = new ImageData(W, H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // the left 10 columns red, the top 5 rows of the rest green, the rest blue; small ramps in green and blue, opaque
    const i = (y * W + x) * 4, c = x < 10 ? [255, 0, 0] : y < 5 ? [0, 255, 0] : [0, 0, 255];
    img.data[i] = c[0]; img.data[i + 1] = c[1] ^ (x & 7); img.data[i + 2] = c[2] ^ (y & 7); img.data[i + 3] = 255;
}
const made = doc.addLayer(img, { name: "Flip probe", x: 30, y: 40 });
const L = () => editor.layers.find((l) => l.id === made.id);
const read = () => Array.from(L().px.readRect(0, 0, W, H).data);
const mirror = (d, axis) => {
    const o = new Array(d.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const sx = axis === "x" ? W - 1 - x : x, sy = axis === "y" ? H - 1 - y : y;
        for (let k = 0; k < 4; k++) o[(y * W + x) * 4 + k] = d[(sy * W + sx) * 4 + k];
    }
    return o;
};
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const p0 = read();
if (same(p0, mirror(p0, "x")) || same(p0, mirror(p0, "y"))) throw new Error("the probe is symmetric: it proves nothing");
const out = {};
const u0 = editor.undo.length;
await c("flip_layer", { layer: made.id, axis: "x" });
const px = read();
if (!same(px, mirror(p0, "x"))) throw new Error("flip_layer axis x is not a left to right mirror" + (same(px, mirror(p0, "y")) ? " (it flipped vertically)" : ""));
await c("flip_layer", { layer: made.id, axis: "y" });
if (!same(read(), mirror(mirror(p0, "x"), "y"))) throw new Error("flip_layer axis y is not a top to bottom mirror");
await c("flip_layer", { layer: made.id });   // the default axis is x
if (!same(read(), mirror(p0, "y"))) throw new Error("flip_layer's default axis is not x");
const labels = editor.undo.slice(-3).map((s) => s.label);
if (JSON.stringify(labels) !== JSON.stringify(["Flip horizontally", "Flip vertically", "Flip horizontally"])) throw new Error("the three flips' undo steps: " + JSON.stringify(labels) + " (" + (editor.undo.length - u0) + " pushed)");
out.flips = labels;
// locked: each command refuses with the reason, and nothing changes (pixels, place, the stack, the undo steps)
await c("set_layer", { layer: made.id, locked: true });
const refused = async (name, args, re) => {
    const p1 = read(), u1 = editor.undo.length, n1 = editor.layers.length, at = [L().x, L().y];
    let msg = "";
    try { await c(name, args); } catch (e) { msg = String(e.message || e); }
    if (!re.test(msg)) throw new Error(`${name} on a locked layer was not refused with the reason: ${msg || "it answered as done"}`);
    const now = L() && { layers: editor.layers.length - n1, pixels: same(read(), p1), at: [L().x - at[0], L().y - at[1]], undo: editor.undo.length - u1, last: editor.undo.slice(-2).map((s) => s.label + "/" + s.kind) };
    if (!now || now.layers || !now.pixels || now.at[0] || now.at[1] || now.undo) throw new Error(`${name} refused but changed the layer: ${JSON.stringify(now)}`);
    return msg;
};
out.locked = {
    remove: await refused("remove_layer", { layer: made.id }, /^layer Flip probe is locked: unlock it first/),
    flip: await refused("flip_layer", { layer: made.id, axis: "x" }, /^layer Flip probe is locked/),
    center: await refused("center_layer", { layer: made.id }, /^layer Flip probe is locked/),
};
// a group's lock counts too
await c("set_layer", { layer: made.id, locked: false });
const g = await c("group_layers", { layers: [made.id], name: "Probe group" });
await c("set_group", { group: g.id, locked: true });
out.groupLocked = await refused("remove_layer", { layer: made.id }, /^layer Flip probe is locked by its group: unlock the group first/);
await c("set_group", { group: g.id, locked: false });
await c("ungroup_layers", { group: g.id });
// a filter layer has no pixels to flip and no place to centre
const fl = await c("add_filter", { type: "curves", name: "Probe filter" });
for (const [name, word] of [["flip_layer", "flipped"], ["center_layer", "centred"]]) {
    let msg = "";
    try { await c(name, { layer: fl.id }); } catch (e) { msg = String(e.message || e); }
    if (msg !== `layer Probe filter is a filter layer: it cannot be ${word}`) throw new Error(`${name} on a filter layer: ${msg || "it answered as done"}`);
    out[name + "_filter"] = msg;
}
await c("remove_layer", { layer: fl.id });
// unlocked again: centre and remove go through
const ce = await c("center_layer", { layer: made.id });
if (ce.x !== Math.round((editor.width - W) / 2) || ce.y !== Math.round((editor.height - H) / 2)) throw new Error("center_layer: " + JSON.stringify(ce));
const rm = await c("remove_layer", { layer: made.id });
if (rm.removed !== made.id || L()) throw new Error("remove_layer after the unlock: " + JSON.stringify(rm));
return out;
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
    # docs/PLAN_0_1_42.md R3b: realism_pass. Under --no-comfy it refuses with the server's reason and adds nothing; with
    # the server stood in for and the pass answering the picture it got (host.passPicture stubbed: nothing is queued
    # or sent) it answers the layer, its deadline from `timeout`, and one undo takes it back; generate_new on the pass
    # recipe names both routes
    ("realism_pass", """
const { host } = await import("./editor/host.js");
const LABEL = "Realism Pass (Windows only, RTX only)";
const doc = window.__testDoc;
await c("activate_document", { doc });
const ed = host.editors().find((e) => e.node.id === doc);
const n0 = ed.layers.length;
const nodeInfo = () => ({ input: { required: {} } });
const OI = { InpaintCanvas: nodeInfo(), InpaintCanvasLoadRef: nodeInfo(), DLSS5Settings: nodeInfo(), DLSS5EnhanceImages: nodeInfo() };
const GOOD = { state: "connected", os: "win32", gpus: ["cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync"], url: "http://127.0.0.1:8188", version: "0.38.0" };
const saved = { server: { ...(host.server || {}) }, objectInfo: host.objectInfo, connected: host.connected, pass: host.passPicture, recipe: host.recipe };
const refused = async (args, test) => { try { await c("realism_pass", { doc, ...args }); } catch (e) { const m = String(e.message || e); if (!test(m)) throw new Error("wrong refusal: " + m); return m; } throw new Error("not refused: " + JSON.stringify(args)); };
const out = {};
try {
    host.setServerStatus({ state: "disconnected" });
    out.offline = await refused({ timeout: 10 }, (m) => m.startsWith(LABEL + " needs your own ComfyUI: connect it under Settings › ComfyUI"));
    if (ed.layers.length !== n0 || ed.providerPending) throw new Error("a refusal added a layer or left the document busy");
    // R4: list_recipes (the server) and status (the server and the document) say beforehand whether it can run, and
    // status the app's values it sends
    const readiness = async () => {
        const rec = (await c("list_recipes")).recipes.find((x) => x.id === "realism_pass");
        const st = (await c("status", { doc })).realism;
        // F2a: every recipe has its readiness now (the step list_recipes_readiness checks the others)
        const other = (await c("list_recipes")).recipes.find((x) => x.id !== "realism_pass");
        if (!rec || !st || typeof other.ready !== "boolean") throw new Error("readiness missing: " + JSON.stringify({ rec, st, other: other && other.id }));
        return { rec, st };
    };
    const v0 = host.realismValues();
    const off = await readiness();
    if (off.rec.ready !== false || off.rec.reason !== out.offline || off.st.ready !== false || off.st.reason !== out.offline
        || off.st.style !== v0.style || off.st.strength !== v0.intensity || off.st.preset !== v0.preset) throw new Error("offline readiness: " + JSON.stringify(off));
    host.connected = true; host.objectInfo = OI; host.setServerStatus(GOOD);
    const on = await readiness();
    if (on.rec.ready !== true || on.rec.reason !== null || on.rec.note !== null || on.st.ready !== true || on.st.reason !== null) throw new Error("ready readiness: " + JSON.stringify(on));
    // a local render still on the server (it never takes providerPending) or the document still loading: status says
    // not ready with realism_pass's own sentence, list_recipes (the server alone) stays ready
    const RUNNING = LABEL + ": a run is still going on this document.";
    // nothing may reach a server if the refusal broke (the finally below puts the real one back)
    host.passPicture = async () => { throw new Error("the pass ran during a local render"); };
    (ed._localRuns || (ed._localRuns = new Set())).add("user-render");
    let renderSt, localRec;
    try {
        renderSt = (await c("status", { doc })).realism;
        localRec = (await c("list_recipes")).recipes.find((x) => x.id === "realism_pass");
        out.localRender = await refused({ timeout: 10 }, (m) => m === RUNNING);
    } finally { ed._localRuns.delete("user-render"); }
    if (renderSt.ready !== false || renderSt.reason !== RUNNING || localRec.ready !== true) throw new Error("readiness during a local render: " + JSON.stringify({ renderSt, localRec }));
    ed._loading = true;
    let loading;
    try { loading = (await c("status", { doc })).realism; } finally { ed._loading = false; }
    if (loading.ready !== false || loading.reason !== LABEL + ": the document is still loading.") throw new Error("readiness while loading: " + JSON.stringify(loading));
    if ((await c("status", { doc })).realism.ready !== true) throw new Error("not ready again after the render and the load");
    host.setServerStatus({ ...GOOD, gpus: ["cuda:0 NVIDIA GeForce RTX 3090 : cudaMallocAsync"] });
    const ampere = await readiness();
    if (ampere.rec.ready !== true || !/RTX 30 cards need the pack's experimental runtime pair/.test(ampere.rec.note || "") || ampere.st.note !== ampere.rec.note) throw new Error("RTX 30 note: " + JSON.stringify(ampere));
    host.setServerStatus({ ...GOOD, os: "linux" });
    const linux = await readiness();
    if (linux.rec.ready !== false || linux.rec.reason !== LABEL + " runs only on a ComfyUI on Windows; this one runs on linux." || linux.st.reason !== linux.rec.reason) throw new Error("linux readiness: " + JSON.stringify(linux));
    host.setServerStatus(GOOD);
    out.readiness = { offline: off.st.reason.slice(0, 60), linux: linux.st.reason.slice(0, 60), values: [on.st.style, on.st.strength, on.st.preset] };
    const calls = [];
    host.passPicture = async (e, bytes, mime, o) => { calls.push({ e, n: bytes.length, mime, deadline: o && o.deadline, busy: !!e.providerPending }); return { bytes, mime, width: e.width, height: e.height, seconds: 2.34, note: "a note of the run" }; };
    const t0 = Date.now();
    const r = await c("realism_pass", { doc, timeout: 90 });
    const t1 = Date.now();
    if (calls.length !== 1 || calls[0].e !== ed || !calls[0].busy || calls[0].mime !== "image/png" || !(calls[0].n > 1000)) throw new Error("the pass got: " + JSON.stringify(calls.map((x) => ({ n: x.n, mime: x.mime, busy: x.busy }))));
    if (!(calls[0].deadline >= t0 + 90000 && calls[0].deadline <= t1 + 90000)) throw new Error("the deadline: " + (calls[0].deadline - t0) + " ms after the call");
    const L = r.layer;
    if (!L || L.name !== LABEL || L.kind !== "image" || L.role !== "none" || L.x !== 0 || L.y !== 0 || L.w !== ed.width || L.h !== ed.height || L.match) throw new Error("the layer: " + JSON.stringify(L));
    if (r.seconds !== 2.3 || JSON.stringify(r.notes) !== JSON.stringify(["a note of the run"]) || r.changed !== false || !r.status.startsWith(LABEL + " ran on your ComfyUI in 2 s: a new layer above the picture") || !r.status.endsWith("a note of the run")) throw new Error("the answer: " + JSON.stringify({ seconds: r.seconds, notes: r.notes, changed: r.changed, status: r.status }));
    if (ed.layers.length !== n0 + 1 || !ed.layers.some((l) => l.id === L.id)) throw new Error("the layer is not in the document");
    out.layer = { name: L.name, w: L.w, h: L.h, status: r.status.slice(0, 90) };
    await c("undo", { doc });
    if (ed.layers.length !== n0 || ed.layers.some((l) => l.id === L.id)) throw new Error("one undo did not take the pass layer back");
    // the default timeout is 570 s (inside the bridge's own 600 s), a larger one is held to 3600
    calls.length = 0;
    const t2 = Date.now();
    await c("realism_pass", { doc });
    const t3 = Date.now();
    if (!(calls[0].deadline >= t2 + 570000 && calls[0].deadline <= t3 + 570000)) throw new Error("the default deadline: " + (calls[0].deadline - t2));
    await c("undo", { doc });
    calls.length = 0;
    const t4 = Date.now();
    await c("realism_pass", { doc, timeout: 99999 });
    if (!(calls[0].deadline <= Date.now() + 3600000 && calls[0].deadline >= t4 + 3600000)) throw new Error("the clamped deadline: " + (calls[0].deadline - t4));
    await c("undo", { doc });
    if (ed.layers.length !== n0) throw new Error("the runs left layers behind");
    // a run going on the document: refused, nothing read
    calls.length = 0;
    ed.providerPending = { provider: "loopback", label: "Loopback", started: Date.now() };
    try { out.busy = await refused({ timeout: 10 }, (m) => m === LABEL + ": a run is still going on this document."); } finally { ed.providerPending = null; }
    if (calls.length) throw new Error("a refused pass ran");
    // R-U: factor 2 makes the document twice as large and the layer comes at the new size (the pass stubbed: it answers
    // a picture of twice the size), one undo takes both back; a factor no mode has is refused before anything is read
    const w0 = ed.width, h0 = ed.height, u0 = ed.undo.length;
    const ups = [];
    host.passPicture = async (e, bytes, mime, o) => {
        ups.push({ factor: o && o.factor, busy: !!e.providerPending });
        const cv = document.createElement("canvas"); cv.width = w0 * 2; cv.height = h0 * 2;
        cv.getContext("2d").fillRect(0, 0, cv.width, cv.height);
        const b = new Uint8Array(await (await new Promise((r) => cv.toBlob(r, "image/png"))).arrayBuffer());
        cv.width = cv.height = 0;
        return { bytes: b, mime: "image/png", width: w0 * 2, height: h0 * 2, seconds: 1.2, note: "" };
    };
    const r2 = await c("realism_pass", { doc, factor: 2, timeout: 60 });
    if (ups.length !== 1 || ups[0].factor !== 2 || !ups[0].busy || r2.factor !== 2 || JSON.stringify(r2.from) !== JSON.stringify([w0, h0]) || r2.width !== w0 * 2 || r2.height !== h0 * 2) throw new Error("factor 2: " + JSON.stringify({ ups, factor: r2.factor, from: r2.from, width: r2.width, height: r2.height }));
    if (ed.width !== w0 * 2 || ed.height !== h0 * 2 || !r2.layer || r2.layer.name !== LABEL || r2.layer.w !== w0 * 2 || r2.layer.h !== h0 * 2 || ed.undo.length !== u0 + 1) throw new Error("factor 2's landing: " + JSON.stringify({ size: [ed.width, ed.height], layer: r2.layer, steps: ed.undo.length - u0 }));
    if (!r2.status.includes(" s at 2×: " + w0 + " × " + h0 + " is now " + (w0 * 2) + " × " + (h0 * 2) + ", every layer scaled along")) throw new Error("factor 2's status: " + r2.status);
    await c("undo", { doc });
    if (ed.width !== w0 || ed.height !== h0 || ed.layers.length !== n0) throw new Error("one undo did not take factor 2 back: " + JSON.stringify({ size: [ed.width, ed.height], layers: ed.layers.length - n0 }));
    out.factor2 = { from: r2.from, to: [r2.width, r2.height] };
    out.badFactor = await refused({ factor: 2.5, timeout: 10 }, (m) => m === LABEL + " takes the factors 1, 1.5, 1.7, 2 and 3, not 2.5.");
    if (ups.length !== 1 || ed.layers.length !== n0) throw new Error("a refused factor ran");
    // generate_new with a local recipe while a run holds the document (or a render of it is queued): refused before its
    // new canvas would wipe the layers, the results history and the undo steps
    const local = host.shell.recipes().find((x) => x.id === "flux2_klein_local");
    if (!local) throw new Error("no local recipe to try");
    host.setRecipe(local);
    const before = { layers: ed.layers.map((l) => l.id).join(), history: ed.history.length, undo: ed.undo.length, w: ed.width, h: ed.height, prompt: ed.promptText };
    const gnRefused = async (setup, teardown, want) => {
        setup();
        let m = "";
        try { await c("generate_new", { doc, prompt: "a new picture", width: 256, height: 256 }); } catch (e) { m = String(e.message || e); } finally { teardown(); }
        const now = { layers: ed.layers.map((l) => l.id).join(), history: ed.history.length, undo: ed.undo.length, w: ed.width, h: ed.height, prompt: ed.promptText };
        if (m !== want || JSON.stringify(now) !== JSON.stringify(before)) throw new Error("generate_new on a busy document: " + (m || "not refused") + " / " + JSON.stringify(now));
        return m;
    };
    out.newWhileRun = await gnRefused(() => { ed.providerPending = { provider: "comfyui", label: LABEL, started: Date.now() }; }, () => { ed.providerPending = null; }, "Wait for the running job to finish: it would land in the picture Generate new replaces.");
    out.newWhileRender = await gnRefused(() => { (ed._localRuns || (ed._localRuns = new Set())).add("user-render"); }, () => { ed._localRuns.delete("user-render"); }, "A render on your ComfyUI is still running: its result would land in the picture Generate new replaces. Try again when it is in.");
    // generate_new on the pass recipe names both routes
    const rp = host.realismRecipe();
    if (!rp) throw new Error("the pass recipe is not listed");
    host.setRecipe(rp);
    let gn = "";
    try { await c("generate_new", { doc, prompt: "x", width: 256, height: 256 }); } catch (e) { gn = String(e.message || e); }
    if (gn !== LABEL + " works on a picture: over the whole picture with Upscale › " + LABEL + " (realism_pass), or select an area and Generate (generate).") throw new Error("generate_new: " + gn);
    out.generateNew = gn.slice(0, 60);
    return out;
} finally {
    host.passPicture = saved.pass;
    host.connected = saved.connected; host.objectInfo = saved.objectInfo;
    host.setServerStatus({ state: saved.server.state || "disconnected", os: saved.server.os || "", gpus: saved.server.gpus || [], remote: !!saved.server.remote, url: saved.server.url || "", version: saved.server.version || "" });
    host.setRecipe(saved.recipe);
}
"""),
    # docs/PLAN_0_1_42.md F2a: the six commands of high value for agents
    ("transform_layer", """
// the move tool's Rotate / Distort / Warp and its quarter turns as one command, each baked in one undo step; a text layer's
// rotation stays its angle; a locked or a filter layer, a wrong argument or a shape past one canvas refused before
// anything changes
const d = await c("new_document");
await c("new_canvas", { width: 400, height: 300, doc: d.id });
const ed = window.editor;
const P = await import("./plugins.js");
const doc = new P.Document(ed);
const W = 40, H = 20;
const img = new ImageData(W, H);
const RED = [230, 30, 30], GREEN = [30, 200, 40], BLUE = [30, 40, 220];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // the left 10 columns red, the top 5 rows of the rest green, the rest blue, opaque
    const i = (y * W + x) * 4, k = x < 10 ? RED : y < 5 ? GREEN : BLUE;
    img.data[i] = k[0]; img.data[i + 1] = k[1]; img.data[i + 2] = k[2]; img.data[i + 3] = 255;
}
const made = doc.addLayer(img, { name: "Turn probe", x: 100, y: 100 });
const L = () => ed.layers.find((l) => l.id === made.id);
const read = () => { const l = L(); return { w: l.px.width, h: l.px.height, d: Array.from(l.px.readRect(0, 0, l.px.width, l.px.height).data) }; };
const same = (a, b) => a.w === b.w && a.h === b.h && a.d.every((v, i) => v === b.d[i]);
// the layer's pixel at image (ix, iy) (its own resolution is 1 here)
const at = (ix, iy) => { const l = L(); const lx = Math.floor(ix - l.x), ly = Math.floor(iy - l.y); if (lx < 0 || ly < 0 || lx >= l.px.width || ly >= l.px.height) return [0, 0, 0, 0]; return Array.from(l.px.readRect(lx, ly, 1, 1).data); };
const near = (p, k) => p[3] > 200 && Math.abs(p[0] - k[0]) + Math.abs(p[1] - k[1]) + Math.abs(p[2] - k[2]) < 60;
const lastLabel = () => ed.undo[ed.undo.length - 1].label;
const p0 = read();
const out = {};
try {
    // a quarter turn clockwise: no resampling, the middle kept
    const r90 = await c("transform_layer", { doc: d.id, layer: made.id, mode: "rotate90" });
    const q = read();
    let off = 0;
    for (let y = 0; y < q.h; y++) for (let x = 0; x < q.w; x++) for (let k = 0; k < 4; k++) if (q.d[(y * q.w + x) * 4 + k] !== p0.d[((H - 1 - x) * W + y) * 4 + k]) off++;
    if (q.w !== H || q.h !== W || off) throw new Error("rotate90 is no clockwise quarter turn: " + JSON.stringify({ w: q.w, h: q.h, off }));
    if (r90.x !== 110 || r90.y !== 90 || r90.w !== 20 || r90.h !== 40 || !r90.changed || lastLabel() !== "Rotate 90° clockwise") throw new Error("rotate90: " + JSON.stringify({ r90, label: lastLabel() }));
    await c("undo", { doc: d.id });
    if (!same(read(), p0) || L().x !== 100 || L().w !== 40) throw new Error("one undo did not take the quarter turn back");
    const ccw = await c("transform_layer", { doc: d.id, layer: made.id, mode: "rotate90", dir: "ccw" });
    if (!near(at(ccw.x + 10, ccw.y + 37), RED) || lastLabel() !== "Rotate 90° counter-clockwise") throw new Error("rotate90 ccw: the red band is not at the bottom: " + JSON.stringify(at(ccw.x + 10, ccw.y + 37)));
    await c("undo", { doc: d.id });
    // 30 degrees clockwise about the middle (120, 110): the box grows to the turned rectangle's, the red band's middle
    // (15 px left of the middle) goes up-left, a point the other way round stays empty
    const r30 = await c("transform_layer", { doc: d.id, layer: made.id, mode: "rotate", angle: 30 });
    const cx = r30.x + r30.w / 2, cy = r30.y + r30.h / 2;
    if (r30.w < 44 || r30.w > 47 || r30.h < 37 || r30.h > 40 || Math.abs(cx - 120) > 1 || Math.abs(cy - 110) > 1 || lastLabel() !== "Rotate") throw new Error("rotate 30: " + JSON.stringify({ x: r30.x, y: r30.y, w: r30.w, h: r30.h, label: lastLabel() }));
    const cw = at(120 - 15 * Math.cos(Math.PI / 6), 110 - 15 * Math.sin(Math.PI / 6)), wrong = at(107, 117.5), blue = at(121, 116.3);
    if (!near(cw, RED) || wrong[3] > 40 || !near(blue, BLUE)) throw new Error("rotate 30 is not clockwise: " + JSON.stringify({ cw, wrong, blue }));
    out.rotate = { w: r30.w, h: r30.h, cw, blue };
    await c("undo", { doc: d.id });
    if (!same(read(), p0)) throw new Error("one undo did not take the rotation back");
    // an angle of 0 changes nothing and pushes no step
    const u0 = ed.undo.length;
    const r0 = await c("transform_layer", { doc: d.id, layer: made.id, mode: "rotate", angle: 0 });
    if (r0.changed || ed.undo.length !== u0 || !same(read(), p0)) throw new Error("rotate by 0 changed something");
    // distort: the corners twice as wide is a stretch
    const dr = await c("transform_layer", { doc: d.id, layer: made.id, mode: "distort", corners: [[100, 100], [180, 100], [180, 120], [100, 120]] });
    if (dr.x !== 100 || dr.y !== 100 || dr.w !== 80 || dr.h !== 20 || lastLabel() !== "Distort") throw new Error("distort: " + JSON.stringify({ x: dr.x, y: dr.y, w: dr.w, h: dr.h, label: lastLabel() }));
    if (!near(at(110, 112), RED) || !near(at(160, 102), GREEN) || !near(at(160, 115), BLUE)) throw new Error("distort's pixels: " + JSON.stringify([at(110, 112), at(160, 102), at(160, 115)]));
    await c("undo", { doc: d.id });
    // warp: the 2 x 2 grid moved by (10, 5) moves the layer
    const pts = [];
    for (let j = 0; j <= 2; j++) for (let i = 0; i <= 2; i++) pts.push([100 + 20 * i + 10, 100 + 10 * j + 5]);
    const wr = await c("transform_layer", { doc: d.id, layer: made.id, mode: "warp", n: 2, points: pts });
    if (wr.x !== 110 || wr.y !== 105 || wr.w !== 40 || wr.h !== 20 || lastLabel() !== "Warp") throw new Error("warp: " + JSON.stringify({ x: wr.x, y: wr.y, w: wr.w, h: wr.h, label: lastLabel() }));
    if (!near(at(115, 117), RED) || !near(at(140, 107), GREEN) || !near(at(140, 120), BLUE)) throw new Error("warp's pixels: " + JSON.stringify([at(115, 117), at(140, 107), at(140, 120)]));
    await c("undo", { doc: d.id });
    if (!same(read(), p0) || L().x !== 100 || L().y !== 100) throw new Error("undo did not take the warp back");
    // a text layer stays text: its angle grows; undo takes it back
    const t = await c("add_text", { doc: d.id, text: "Hi", x: 220, y: 40, size: 32, name: "Turn text" });
    const tr = await c("transform_layer", { doc: d.id, layer: t.id, mode: "rotate", angle: 20 });
    if (tr.kind !== "text" || !tr.text || tr.text.angle !== 20 || !tr.changed) throw new Error("a text's rotation: " + JSON.stringify(tr.text));
    await c("undo", { doc: d.id });
    if ((await c("list_layers", { doc: d.id })).layers.find((l) => l.id === t.id).text.angle) throw new Error("undo did not take the text's angle back");
    out.text = tr.text.angle;
    // refused before anything changes
    const refused = async (args, re) => {
        const u1 = ed.undo.length, before = read();
        let msg = "";
        try { await c("transform_layer", { doc: d.id, layer: made.id, ...args }); } catch (e) { msg = String(e.message || e); }
        if (!re.test(msg)) throw new Error("transform_layer " + JSON.stringify(args).slice(0, 80) + ": " + (msg || "not refused"));
        if (ed.undo.length !== u1 || !same(read(), before) || ed.pending) throw new Error("a refused transform changed something: " + msg);
        return msg;
    };
    out.refused = [
        await refused({ mode: "spin" }, /^mode must be one of rotate, rotate90, distort, warp/),
        await refused({ mode: "rotate" }, /^rotate needs angle/),
        await refused({ mode: "rotate90", dir: "left" }, /^dir must be cw or ccw/),
        await refused({ mode: "distort", corners: [[0, 0], [1, 0], [1, 1]] }, /^distort needs four corners/),
        await refused({ mode: "distort", corners: [[0, 0], [1, 0], [1, "x"], [0, 1]] }, /^corners.2. is no .x, y. point/),
        await refused({ mode: "warp", n: 2, points: pts.slice(1) }, /^warp with n 2 needs 9 points/),
        await refused({ mode: "distort", corners: [[0, 0], [70000, 0], [70000, 20], [0, 20]] }, /more than one canvas holds/),
    ];
    // a layer whose own pixels are past one canvas (a full-size layer of a document over 268 MP; its size stood in for
    // here) is refused before anything changes, however small the shape it would make (release review 2026-10-05)
    {
        const Lp = ed.layers.find((l) => l.id === made.id), px0 = Lp.px, u2 = ed.undo.length, sel0 = ed.selectedLayers ? ed.selectedLayers().map((l) => l.id) : null;
        let big = "";
        Lp.px = Object.create(px0, { width: { value: 70000 }, height: { value: 5000 } });
        try { await c("transform_layer", { doc: d.id, layer: made.id, mode: "distort", corners: [[0, 0], [20, 0], [20, 20], [0, 20]] }); } catch (e) { big = String(e.message || e); } finally { Lp.px = px0; }
        if (!/^layer Turn probe is 70000 × 5000 px, more than one canvas holds \\(65,535 px a side, 268 megapixels\\): distort needs its pixels as one canvas$/.test(big) || ed.undo.length !== u2 || ed.pending) throw new Error("a layer past one canvas: " + (big || "not refused") + " / steps " + (ed.undo.length - u2));
        if (sel0 && JSON.stringify(ed.selectedLayers().map((l) => l.id)) !== JSON.stringify(sel0)) throw new Error("the refusal changed the selected layers");
        out.bigLayer = big;
    }
    await c("set_layer", { doc: d.id, layer: made.id, locked: true });
    out.locked = await refused({ mode: "rotate90" }, /^layer Turn probe is locked/);
    await c("set_layer", { doc: d.id, layer: made.id, locked: false });
    const fl = await c("add_filter", { doc: d.id, type: "curves", name: "Turn filter" });
    let fm = "";
    try { await c("transform_layer", { doc: d.id, layer: fl.id, mode: "rotate", angle: 5 }); } catch (e) { fm = String(e.message || e); }
    if (fm !== "layer Turn filter is a filter layer: it cannot be transformed") throw new Error("a filter layer: " + (fm || "not refused"));
    out.tiles = !!ed.tileMode;
    return out;
} finally {
    await c("close_document", { doc: d.id });
    await c("activate_document", { doc: window.__testDoc });
}
"""),
    ("copy_to_layer", """
// Ctrl+C / Ctrl+Shift+C / Ctrl+X then Ctrl+V as one command: the selected pixels of a layer or of the picture as a new layer
// at the same place, one undo step; the user's clipboard stays; a cut clears the pixels; another tab takes the paste
const { host } = await import("./editor/host.js");
const d = await c("new_document");
await c("new_canvas", { width: 300, height: 200, doc: d.id });
const d2 = await c("new_document", { activate: false });
const ed = host.editorById(d.id), ed2 = host.editorById(d2.id);
const P = await import("./plugins.js");
const doc = new P.Document(ed);
const W = 60, H = 40;
const img = new ImageData(W, H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; img.data[i] = 4 * x; img.data[i + 1] = 6 * y; img.data[i + 2] = 200 - 3 * x; img.data[i + 3] = 255; }
const made = doc.addLayer(img, { name: "Copy probe", x: 50, y: 40 });
const layer = (e, id) => e.layers.find((l) => l.id === id);
const px = (e, id, x, y, w, h) => Array.from(layer(e, id).px.readRect(x, y, w, h).data);
const diff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return a.length === b.length ? m : 999; };
const sentinel = { canvas: document.createElement("canvas"), x: 1, y: 2, source: "sentinel" };
const out = {};
try {
    await c("select_rect", { doc: d.id, x: 60, y: 50, w: 30, h: 20 });
    ed.clipboard = sentinel;
    const n0 = ed.layers.length;
    // a layer's selected pixels
    const cp = await c("copy_to_layer", { doc: d.id, layer: made.id });
    if (ed.clipboard !== sentinel) throw new Error("the user's clipboard was replaced");
    if (cp.x !== 60 || cp.y !== 50 || cp.w !== 30 || cp.h !== 20 || cp.name !== "Copy probe copy" || !cp.active || cp.doc !== d.id || ed.layers.length !== n0 + 1) throw new Error("the copy: " + JSON.stringify(cp));
    const dc = diff(px(ed, cp.id, 0, 0, 30, 20), px(ed, made.id, 10, 10, 30, 20));
    if (dc > 2 || ed.undo[ed.undo.length - 1].label !== "Paste") throw new Error("the copy's pixels differ by " + dc + " levels, or its step is " + ed.undo[ed.undo.length - 1].label);
    await c("undo", { doc: d.id });
    if (layer(ed, cp.id) || ed.layers.length !== n0) throw new Error("one undo did not take the paste back");
    // the visible picture in the selection's box, as the whole flatten has it
    const flat = Array.from(ed.flattenToCanvas({ forRun: true }).getContext("2d").getImageData(60, 50, 30, 20).data);
    const mg = await c("copy_to_layer", { doc: d.id, merged: true, name: "Lifted" });
    const dm = diff(px(ed, mg.id, 0, 0, 30, 20), flat);
    if (mg.name !== "Lifted" || mg.x !== 60 || mg.y !== 50 || mg.w !== 30 || mg.h !== 20 || mg.source !== "merged" || dm > 2) throw new Error("merged: " + JSON.stringify({ name: mg.name, x: mg.x, y: mg.y, w: mg.w, h: mg.h, dm }));
    await c("undo", { doc: d.id });
    // a cut: the pixels leave the layer, the new one holds them; the cut and the paste are a step each
    const before = px(ed, made.id, 0, 0, W, H);
    const want = [];
    for (let y = 10; y < 30; y++) for (let x = 10; x < 40; x++) for (let k = 0; k < 4; k++) want.push(before[(y * W + x) * 4 + k]);
    const ct = await c("copy_to_layer", { doc: d.id, layer: made.id, cut: true });
    const hole = px(ed, made.id, 10, 10, 30, 20);
    const dcut = diff(px(ed, ct.id, 0, 0, 30, 20), want);
    if (!ct.cut || hole.some((v, i) => i % 4 === 3 && v !== 0) || dcut > 2) throw new Error("the cut: " + JSON.stringify({ cut: ct.cut, holeAlpha: hole.filter((v, i) => i % 4 === 3 && v).length, dcut }));
    await c("undo", { doc: d.id });
    await c("undo", { doc: d.id });
    if (diff(px(ed, made.id, 0, 0, W, H), before) || ed.layers.length !== n0) throw new Error("two undos did not take the cut back");
    // into another tab, at the same place
    await c("new_canvas", { width: 300, height: 200, doc: d2.id });
    const td = await c("copy_to_layer", { doc: d.id, layer: made.id, to_doc: d2.id });
    if (td.doc !== d2.id || !layer(ed2, td.id) || layer(ed, td.id) || td.x !== 60 || td.y !== 50 || ed.layers.length !== n0) throw new Error("to_doc: " + JSON.stringify(td));
    // nothing selected: the whole layer
    await c("select_none", { doc: d.id });
    const wl = await c("copy_to_layer", { doc: d.id, layer: made.id });
    if (wl.x !== 50 || wl.y !== 40 || wl.w !== W || wl.h !== H || diff(px(ed, wl.id, 0, 0, W, H), before) > 2) throw new Error("the whole layer: " + JSON.stringify({ x: wl.x, y: wl.y, w: wl.w, h: wl.h }));
    await c("undo", { doc: d.id });
    // refused
    const refused = async (args, re) => { let m = ""; try { await c("copy_to_layer", { doc: d.id, ...args }); } catch (e) { m = String(e.message || e); } if (!re.test(m)) throw new Error("copy_to_layer " + JSON.stringify(args) + ": " + (m || "not refused")); return m; };
    const fl = await c("add_filter", { doc: d.id, type: "curves", name: "Copy filter" });
    await c("set_layer", { doc: d.id, layer: made.id, locked: true });
    const d3 = await c("new_document", { activate: false });
    out.refused = [
        await refused({ merged: true, cut: true }, /^cut takes pixels out of one layer/),
        await refused({ layer: made.id, cut: true }, /^layer Copy probe is locked/),
        await refused({ layer: fl.id }, /^layer Copy filter is a filter layer: it has no pixels to copy/),
        await refused({ layer: made.id, to_doc: 9999 }, /^no document with id 9999/),
        await refused({ layer: made.id, to_doc: d3.id }, /has no picture to paste into/),
    ];
    await c("close_document", { doc: d3.id });
    if (ed.layers.length !== n0 + 1 || ed.clipboard !== sentinel) throw new Error("a refusal changed the layers or the clipboard");
    out.tiles = !!ed.tileMode; out.diffs = { layer: dc, merged: dm };
    return out;
} finally {
    ed.clipboard = null;
    await c("close_document", { doc: d.id });
    await c("close_document", { doc: d2.id });
    await c("activate_document", { doc: window.__testDoc });
}
"""),
    ("resize_image", """
// Image › Canvas › Resize as a command: the base resampled, the layers scaled in place at their own pixels, the selection
// along, one undo step; refused while a job would land in the old geometry, and on sizes no canvas holds
const { host } = await import("./editor/host.js");
const d = await c("new_document");
await c("load_image", { filename: "test_base.png", subfolder: "inpaint_canvas", type: "input", doc: d.id });
const ed = host.editorById(d.id);
const P = await import("./plugins.js");
const doc = new P.Document(ed);
const img = new ImageData(40, 20);
img.data.fill(255);
const made = doc.addLayer(img, { name: "Resize probe", x: 30, y: 20 });
await c("select_rect", { doc: d.id, x: 10, y: 10, w: 100, h: 50 });
const W0 = ed.width, H0 = ed.height;
const mean = () => { const c2 = ed.flattenToCanvas({ forRun: true }); const g = c2.getContext("2d").getImageData(0, 0, c2.width, c2.height).data; const s = [0, 0, 0]; for (let i = 0; i < g.length; i += 4) { s[0] += g[i]; s[1] += g[i + 1]; s[2] += g[i + 2]; } return s.map((v) => v / (g.length / 4)); };
const m0 = mean();
const out = {};
try {
    const r = await c("resize_image", { doc: d.id, percent: 50 });
    const L = ed.layers.find((l) => l.id === made.id);
    const sel = (await c("status", { doc: d.id })).selection;
    if (r.width !== Math.round(W0 / 2) || r.height !== Math.round(H0 / 2) || ed.width !== r.width || JSON.stringify(r.from) !== JSON.stringify([W0, H0])) throw new Error("percent 50: " + JSON.stringify(r));
    if (L.x !== 15 || L.y !== 10 || L.w !== 20 || L.h !== 10 || L.px.width !== 40 || L.px.height !== 20) throw new Error("the layer: " + JSON.stringify({ x: L.x, y: L.y, w: L.w, h: L.h, px: [L.px.width, L.px.height] }));
    if (!sel || Math.abs(sel.x - 5) > 1 || Math.abs(sel.y - 5) > 1 || Math.abs(sel.w - 50) > 1 || Math.abs(sel.h - 25) > 1) throw new Error("the selection: " + JSON.stringify(sel));
    const m1 = mean();
    if (m0.some((v, i) => Math.abs(v - m1[i]) > 3)) throw new Error("the picture's mean colour moved: " + JSON.stringify({ m0, m1 }));
    if (ed.undo[ed.undo.length - 1].label !== "Resize image") throw new Error("the step: " + ed.undo[ed.undo.length - 1].label);
    await c("undo", { doc: d.id });
    // the canvas step puts its own copy of the layers back
    const L1 = ed.layers.find((l) => l.id === made.id);
    if (ed.width !== W0 || ed.height !== H0 || !L1 || L1.x !== 30 || L1.w !== 40) throw new Error("one undo did not take the resize back: " + JSON.stringify({ w: ed.width, h: ed.height, layer: L1 && [L1.x, L1.w] }));
    const wOnly = await c("resize_image", { doc: d.id, width: 200 });
    if (wOnly.width !== 200 || wOnly.height !== Math.round(H0 * 200 / W0)) throw new Error("width alone: " + JSON.stringify(wOnly));
    await c("undo", { doc: d.id });
    const ls = await c("resize_image", { doc: d.id, long_side: 300 });
    if (Math.max(ls.width, ls.height) !== 300) throw new Error("long_side: " + JSON.stringify(ls));
    await c("undo", { doc: d.id });
    const both = await c("resize_image", { doc: d.id, width: 333, height: 111 });
    if (both.width !== 333 || both.height !== 111) throw new Error("both: " + JSON.stringify(both));
    await c("undo", { doc: d.id });
    const refused = async (args, re, setup, teardown) => {
        if (setup) setup();
        let m = "";
        try { await c("resize_image", { doc: d.id, ...args }); } catch (e) { m = String(e.message || e); } finally { if (teardown) teardown(); }
        if (!re.test(m) || ed.width !== W0 || ed.height !== H0) throw new Error("resize_image " + JSON.stringify(args) + ": " + (m || "not refused") + " at " + ed.width + " x " + ed.height);
        return m;
    };
    out.refused = [
        await refused({}, /^give width and . or height, percent or long_side/),
        await refused({ width: 100, percent: 50 }, /^give width . height, percent or long_side, one of them/),
        await refused({ percent: 0.5 }, /^percent must be 1..1000/),
        await refused({ width: 4 }, /is too small/),
        await refused({ width: 70000, height: 10 }, /more than one canvas holds/),
        await refused({ width: W0, height: H0 }, /already/),
        await refused({ percent: 50 }, /^Wait for the running job to finish/, () => { ed.providerPending = { provider: "loopback", label: "Loopback", started: Date.now() }; }, () => { ed.providerPending = null; }),
        await refused({ percent: 50 }, /^A render on your ComfyUI is still running/, () => { (ed._localRuns || (ed._localRuns = new Set())).add("user-render"); }, () => { ed._localRuns.delete("user-render"); }),
    ];
    out.tiles = !!ed.tileMode;
    return out;
} finally {
    await c("close_document", { doc: d.id });
    await c("activate_document", { doc: window.__testDoc });
}
"""),
    ("cancel_run", """
// the title row's Cancel as a command: an API run waiting on its provider (the loopback, 20 s) is cancelled, the generate
// waiting on it ends at once, nothing lands; another tab's cancel leaves it alone; without doc every tab's
const { host } = await import("./editor/host.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const d = await c("new_document");
await c("load_image", { filename: "test_base.png", subfolder: "inpaint_canvas", type: "input", doc: d.id });
const other = await c("new_document", { activate: false });
const ed = host.editorById(d.id);
const prev = host.recipe;
host.setRecipe({ id: "loopback_slow", kind: "provider", provider: "loopback", providerLabel: "Loopback", model: "loopback", input: "edit", refs: { name: "image {n}" }, name: "Loopback slow", settings: [], fixed: { delay_ms: 20000 } });
const out = {};
try {
    const none = await c("cancel_run", { doc: d.id });
    if (none.cancelled.length || none.ended !== true || none.note !== "Nothing was running on this document.") throw new Error("nothing running: " + JSON.stringify(none));
    await c("select_rect", { doc: d.id, x: 10, y: 10, w: 64, h: 64 });
    const n0 = ed.layers.length;
    const start = async () => {
        const t0 = Date.now();
        const g = c("generate", { doc: d.id, timeout: 60 }).then(() => "finished", (e) => String(e.message || e));
        for (let k = 0; k < 100 && !(ed.providerPending && host._providerRuns.size); k++) await wait(50);
        if (!ed.providerPending) throw new Error("the run did not start: " + ed.status);
        await wait(1000);   // the request waits in main by now
        return { g, t0 };
    };
    const run1 = await start();
    const elsewhere = await c("cancel_run", { doc: other.id });
    if (elsewhere.cancelled.length || !ed.providerPending) throw new Error("another tab's cancel reached the run: " + JSON.stringify(elsewhere));
    const r = await c("cancel_run", { doc: d.id });
    const msg = await run1.g, ms = Date.now() - run1.t0;
    if (r.cancelled.length !== 1 || r.cancelled[0].doc !== d.id || r.cancelled[0].provider !== "loopback" || r.cancelled[0].label !== "Loopback" || !(r.cancelled[0].seconds >= 0.5) || r.ended !== true || !/charge/.test(r.note)) throw new Error("the cancel: " + JSON.stringify(r));
    // once the request waits in main, main stops waiting at once; a cancel while the crop is made sends nothing
    if (!/^Cancelled (after [0-9.]+ s: Scumble stopped waiting for Loopback|before anything was sent)/.test(msg) || ms > 8000) throw new Error("the generate ended with: " + msg + " after " + ms + " ms");
    if (ed.providerPending || ed.layers.length !== n0) throw new Error("the document is still held, or a layer landed");
    // without doc: every tab's runs
    const run2 = await start();
    const all = await c("cancel_run");
    const msg2 = await run2.g;
    if (all.cancelled.length !== 1 || all.cancelled[0].doc !== d.id || !/^Cancelled/.test(msg2)) throw new Error("every tab's: " + JSON.stringify(all) + " / " + msg2);
    out.cancelled = { ms, msg: msg.slice(0, 70) };
    // a run whose answer is in has left the title row but still holds the document while its result lands: named as
    // landing (and waited for), never "Nothing was running" (release review 2026-10-05)
    const landTok = { provider: "loopback", label: "Loopback landing", started: Date.now(), editor: ed };
    ed.providerPending = landTok;
    setTimeout(() => { if (ed.providerPending === landTok) ed.providerPending = null; }, 600);
    const t1 = Date.now();
    const lr = await c("cancel_run", { doc: d.id });
    if (lr.cancelled.length || !lr.landing || lr.landing.length !== 1 || lr.landing[0].doc !== d.id || lr.landing[0].label !== "Loopback landing" || lr.ended !== true || Date.now() - t1 < 400
        || lr.note !== "A run's answer was already in and is landing: it can no longer be cancelled (Ctrl+Z takes it back once it is in).") throw new Error("a landing run: " + JSON.stringify(lr));
    if (ed.providerPending === landTok) ed.providerPending = null;
    const none2 = await c("cancel_run", { doc: d.id });
    if (none2.cancelled.length || none2.landing.length || none2.note !== "Nothing was running on this document.") throw new Error("nothing after the landing: " + JSON.stringify(none2));
    out.landing = lr.note;
    let bad = "";
    try { await c("cancel_run", { doc: 9999 }); } catch (e) { bad = String(e.message || e); }
    if (!/^no document with id 9999/.test(bad)) throw new Error("an unknown doc: " + (bad || "not refused"));
    return out;
} finally {
    host.setRecipe(prev);
    await c("close_document", { doc: d.id });
    await c("close_document", { doc: other.id });
    await c("activate_document", { doc: window.__testDoc });
}
"""),
    ("list_recipes_readiness", """
// every recipe says whether it can run now and why not; the provider key flags are booleans, never the key; the text
// route's sizes and background, an upscaler's document_max
const { host } = await import("./editor/host.js");
const L = await c("list_recipes");
const out = {};
const bad = L.recipes.filter((r) => typeof r.ready !== "boolean" || (r.ready ? r.reason !== null : typeof r.reason !== "string" || !r.reason));
if (bad.length) throw new Error("readiness: " + JSON.stringify(bad.map((r) => [r.id, r.ready, r.reason])));
if (!Array.isArray(L.provider_keys) || !L.provider_keys.length) throw new Error("provider_keys: " + JSON.stringify(L.provider_keys));
for (const p of L.provider_keys) if (typeof p.key !== "boolean" || typeof p.id !== "string" || Object.keys(p).some((k) => !["id", "label", "key", "shares_key"].includes(k))) throw new Error("a provider row: " + JSON.stringify(p));
// an API recipe: ready exactly when its chosen provider has its key, the same flag in keys and provider_keys
for (const r of L.recipes.filter((x) => x.kind === "provider")) {
    if (!r.keys || Object.keys(r.keys).join() !== r.providers.join() || Object.values(r.keys).some((v) => typeof v !== "boolean")) throw new Error(r.id + " keys: " + JSON.stringify(r.keys));
    if (r.ready !== r.keys[r.provider]) throw new Error(r.id + ": ready " + r.ready + ", its provider's key " + r.keys[r.provider]);
    const pk = L.provider_keys.find((p) => p.id === r.provider);
    if (pk && pk.key !== r.ready) throw new Error(r.id + ": provider_keys says " + pk.key);
    if (!r.ready && r.provider !== "inapp" && !/key/.test(r.reason)) throw new Error(r.id + "'s reason: " + r.reason);
}
// a recipe on the user's ComfyUI: by the connection and its node types
const flux = L.recipes.find((x) => x.id === "flux2_klein_local");
const fluxRaw = host.shell.recipes().find((x) => x.id === "flux2_klein_local");
if (!flux || !fluxRaw || !(fluxRaw.needs || []).length) throw new Error("no local recipe with node types to try");
if (flux.new_image !== true || flux.edit !== true || flux.sizes !== null || flux.background !== false || flux.keys !== undefined) throw new Error("the local recipe's fields: " + JSON.stringify(flux));
const saved = { server: { ...(host.server || {}) }, objectInfo: host.objectInfo, connected: host.connected };
try {
    host.setServerStatus({ state: "disconnected" });
    const off = (await c("list_recipes")).recipes.find((x) => x.id === "flux2_klein_local");
    if (off.ready !== false || off.reason !== "Not connected to ComfyUI: Settings › ComfyUI.") throw new Error("offline: " + JSON.stringify([off.ready, off.reason]));
    host.connected = true;
    host.objectInfo = Object.fromEntries(fluxRaw.needs.map((n) => [n, { input: { required: {} } }]));
    host.setServerStatus({ state: "connected", os: "win32", gpus: [], url: "http://127.0.0.1:1", version: "0.0.0" });
    const on = (await c("list_recipes")).recipes.find((x) => x.id === "flux2_klein_local");
    if (on.ready !== true || on.reason !== null) throw new Error("connected with its nodes: " + JSON.stringify([on.ready, on.reason]));
    delete host.objectInfo[fluxRaw.needs[0]];
    const lacks = (await c("list_recipes")).recipes.find((x) => x.id === "flux2_klein_local");
    if (lacks.ready !== false || lacks.reason !== "The server lacks these node types: " + fluxRaw.needs[0] + ".") throw new Error("a node missing: " + JSON.stringify([lacks.ready, lacks.reason]));
    out.local = { off: off.reason, lacks: lacks.reason };
} finally {
    host.connected = saved.connected; host.objectInfo = saved.objectInfo;
    host.setServerStatus({ state: saved.server.state || "disconnected", os: saved.server.os || "", gpus: saved.server.gpus || [], remote: !!saved.server.remote, url: saved.server.url || "", version: saved.server.version || "" });
}
// the text route, as the Generate new dialog offers it
for (const r of L.recipes) {
    const rr = host.shell.recipes().find((x) => x.id === r.id);
    if (r.task === "upscale" || r.task === "pass") {
        if (r.new_image !== false || r.sizes !== undefined || r.edit !== undefined) throw new Error(r.id + ": an upscaler or the pass makes no new image: " + JSON.stringify(r));
        if (r.task === "upscale" && !(r.document_max === null || r.document_max >= 64)) throw new Error(r.id + " document_max " + r.document_max);
        continue;
    }
    if (r.kind !== "provider") continue;
    const v = rr.providers[r.provider] || {};
    const t = v.text || null;
    if (r.new_image !== !!t) throw new Error(r.id + " new_image " + r.new_image + " with text route " + !!t);
    if (t && Array.isArray(t.sizes) && t.sizes.length && JSON.stringify(r.sizes) !== JSON.stringify(t.sizes.slice().sort((a, b) => a - b))) throw new Error(r.id + " sizes " + JSON.stringify(r.sizes));
    if (t && r.background !== ((t.settings || v.settings || []).some((s) => s.key === "background"))) throw new Error(r.id + " background " + r.background);
    if (r.edit !== (v.edit !== false)) throw new Error(r.id + " edit " + r.edit);
}
const withAlpha = L.recipes.filter((r) => r.background).map((r) => r.id);
const sized = L.recipes.filter((r) => Array.isArray(r.sizes)).map((r) => r.id);
const ups = L.recipes.filter((r) => r.task === "upscale").map((r) => [r.id, r.document_max]);
if (!sized.length || !ups.length) throw new Error("nothing to check: " + JSON.stringify({ sized, ups }));
out.counts = { recipes: L.recipes.length, ready: L.recipes.filter((r) => r.ready).length, keys: L.provider_keys.length, withAlpha: withAlpha.length, sized: sized.length };
out.ups = ups;
return out;
"""),
    ("screenshot_region", """
// screenshot's box (a region at up to 1:1), base (the picture without its layers) and mask (the selection, or a layer's
// mask, in black and white)
const { host } = await import("./editor/host.js");
const d = await c("new_document");
await c("new_canvas", { width: 600, height: 400, doc: d.id });
const ed = host.editorById(d.id);
const base = document.createElement("canvas"); base.width = 600; base.height = 400;
{ const x = base.getContext("2d"); x.fillStyle = "#c03020"; x.fillRect(0, 0, 300, 400); x.fillStyle = "#2040c0"; x.fillRect(300, 0, 300, 400); }
Object.defineProperty(base, "naturalWidth", { value: 600 });
Object.defineProperty(base, "naturalHeight", { value: 400 });
await ed.setBase({ filename: "region.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
const P = await import("./plugins.js");
const img = new ImageData(100, 80);
for (let i = 0; i < img.data.length; i += 4) { img.data[i] = 40; img.data[i + 1] = 210; img.data[i + 2] = 60; img.data[i + 3] = 255; }
const made = new P.Document(ed).addLayer(img, { name: "Region probe", x: 250, y: 150 });
// the layer's mask shows its left half
await c("select_rect", { doc: d.id, x: 250, y: 150, w: 50, h: 80 });
await c("set_mask", { doc: d.id, layer: made.id, op: "from_selection" });
await c("select_rect", { doc: d.id, x: 200, y: 100, w: 200, h: 200 });
if (ed.mipsSettled) await ed.mipsSettled();
const bytes = (cv) => cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
const pix = (cv, x, y) => { const b = cv.getContext("2d").getImageData(x, y, 1, 1).data; return [b[0], b[1], b[2]]; };
const close = (a, b, t) => a.every((v, i) => Math.abs(v - b[i]) <= t);
const out = {};
try {
    // the picture at 1:1 in the box, as the whole flatten has it there
    const box = [240, 140, 120, 100];
    const s1 = await raw.shotCanvas(ed, { box, show_selection: false });
    const flat = ed.flattenToCanvas({ forRun: true }).getContext("2d").getImageData(240, 140, 120, 100).data;
    const got = bytes(s1.canvas);
    let m = 0;
    for (let i = 0; i < got.length; i++) m = Math.max(m, Math.abs(got[i] - flat[i]));
    if (s1.w !== 120 || s1.h !== 100 || s1.s !== 1 || m > 2) throw new Error("the box at 1:1: " + JSON.stringify({ w: s1.w, h: s1.h, s: s1.s, max: m }));
    // the base alone: the base's colour where the layer lies
    const sb = await raw.shotCanvas(ed, { what: "base", box, show_selection: false });
    if (!close(pix(sb.canvas, 20, 30), [0xc0, 0x30, 0x20], 3) || !close(pix(sb.canvas, 80, 30), [0x20, 0x40, 0xc0], 3)) throw new Error("base: " + JSON.stringify([pix(sb.canvas, 20, 30), pix(sb.canvas, 80, 30)]));
    if (!close(pix(s1.canvas, 20, 30), [40, 210, 60], 3)) throw new Error("the picture has no layer in the box: " + JSON.stringify(pix(s1.canvas, 20, 30)));
    // the selection in black and white
    const sm = await raw.shotCanvas(ed, { what: "mask", box: [150, 50, 300, 300] });
    if (!close(pix(sm.canvas, 150, 150), [255, 255, 255], 2) || !close(pix(sm.canvas, 10, 10), [0, 0, 0], 2)) throw new Error("the selection mask: " + JSON.stringify([pix(sm.canvas, 150, 150), pix(sm.canvas, 10, 10)]));
    // the layer's mask: white where it shows, black where it hides and outside it
    const sl = await raw.shotCanvas(ed, { what: "mask", layer: made.id, box });
    const ml = [pix(sl.canvas, 20, 40), pix(sl.canvas, 80, 40), pix(sl.canvas, 5, 5)];
    if (!close(ml[0], [255, 255, 255], 2) || !close(ml[1], [0, 0, 0], 2) || !close(ml[2], [0, 0, 0], 2)) throw new Error("the layer's mask: " + JSON.stringify(ml));
    // a box larger than max_size is scaled down; one past the picture is held to it
    const ss = await raw.shotCanvas(ed, { box, max_size: 64 });
    if (ss.w !== 64 || Math.abs(ss.s - 64 / 120) > 1e-9) throw new Error("max_size: " + JSON.stringify({ w: ss.w, h: ss.h, s: ss.s }));
    // the command: the region's size, the box, the picture's size
    const r = await c("screenshot", { doc: d.id, box: [550, 350, 200, 200] });
    if (r.width !== 50 || r.height !== 50 || r.scale !== 1 || JSON.stringify(r.box) !== JSON.stringify({ x: 550, y: 350, w: 50, h: 50 }) || r.image_width !== 600 || r.image_height !== 400 || r.mime !== "image/jpeg" || !(r.data.length > 100)) throw new Error("the command: " + JSON.stringify({ ...r, data: r.data.length }));
    const whole = await c("screenshot", { doc: d.id, max_size: 300 });
    if (whole.box !== undefined || whole.width !== 300 || whole.image_width !== 600) throw new Error("without a box: " + JSON.stringify({ ...whole, data: 0 }));
    const refused = async (args, re) => { let msg = ""; try { await c("screenshot", { doc: d.id, ...args }); } catch (e) { msg = String(e.message || e); } if (!re.test(msg)) throw new Error("screenshot " + JSON.stringify(args) + ": " + (msg || "not refused")); return msg; };
    await c("set_mask", { doc: d.id, layer: made.id, op: "remove" });
    out.refused = [
        await refused({ box: [700, 0, 10, 10] }, /holds no pixel of the 600 . 400 picture/),
        await refused({ box: [1, 2, 3] }, /^box must be .x, y, w, h./),
        await refused({ what: "layer", layer: made.id, box }, /^box reads a region of the picture/),
        await refused({ what: "mask", layer: made.id }, /^Region probe has no mask/),
        await refused({ what: "bogus" }, /^what must be one of image, editor, layer, base, mask/),
    ];
    out.tiles = !!ed.tileMode; out.max = m;
    return out;
} finally {
    await c("close_document", { doc: d.id });
    await c("activate_document", { doc: window.__testDoc });
}
"""),
    # docs/PLAN_0_1_42.md F2b: set_crop stores booleans and choices, refuses the rest before changing anything, and status
    # reports the crop as the editor reads it
    ("set_crop_checks", """
const { host } = await import("./editor/host.js");
const d = await c("new_document");
await c("load_image", { filename: "test_base.png", subfolder: "inpaint_canvas", type: "input", doc: d.id });
const ed = host.editorById(d.id);
const out = {};
try {
    const r1 = await c("set_crop", { doc: d.id, colorMatch: false, align: "false", withOriginal: "true", fill: "Green", paste: "whole crop", extendFill: "black", context: "manual", feather: "auto" });
    const cs = ed.cropSettings;
    if (cs.colorMatch !== false || cs.align !== false || cs.withOriginal !== true || cs.fill !== "green" || cs.paste !== "crop" || cs.extendFill !== "black" || cs.context !== "manual" || cs.feather !== "auto") throw new Error("stored: " + JSON.stringify(cs));
    if (r1.colorMatch !== false || r1.align !== false || r1.paste !== "crop" || r1.changed.length !== 8 || typeof r1.pixels.padding !== "number") throw new Error("the answer: " + JSON.stringify(r1));
    // the controls follow: extend_canvas reads the Canvas section's fill select
    if (ed.extendFillSel && ed.extendFillSel.value !== "black") throw new Error("the extend fill select: " + ed.extendFillSel.value);
    if (ed.cropColorMatch && ed.cropColorMatch.checked) throw new Error("the colour match box is still on");
    const before = JSON.stringify(ed.cropSettings);
    const refused = async (args, re) => { let m = ""; try { await c("set_crop", { doc: d.id, ...args }); } catch (e) { m = String(e.message || e); } if (!re.test(m) || JSON.stringify(ed.cropSettings) !== before) throw new Error("set_crop " + JSON.stringify(args) + ": " + (m || "not refused") + " / " + JSON.stringify(ed.cropSettings)); return m; };
    out.refused = [
        await refused({ context: "200" }, /^context takes "auto" or "manual", not a number: manual uses set_node_params padding/),
        await refused({ feather: 12 }, /^feather takes "auto" or "manual", not a number: manual uses set_node_params feather/),
        await refused({ fill: "neutral", colorMatch: "maybe" }, /^colorMatch takes true or false/),
        await refused({ fill: "purple" }, /^fill must be one of none, neutral, blur, border, green/),
        await refused({ extendFill: "white" }, /^extendFill must be one of/),
        await refused({ paste: "all" }, /^paste must be selection or crop/),
        await refused({ zoom: 2 }, /^unknown crop setting "zoom"/),
    ];
    // an old document's raw values: status reads them as the editor does
    ed.cropSettings.context = "64"; ed.cropSettings.colorMatch = "false";
    const st = (await c("status", { doc: d.id })).crop;
    if (st.context !== "manual" || st.colorMatch !== true) throw new Error("status of raw values: " + JSON.stringify(st));
    // the whole object status gives goes back in
    await c("set_crop", { doc: d.id, ...st });
    if (ed.cropSettings.context !== "manual" || ed.cropSettings.colorMatch !== true) throw new Error("status passed back: " + JSON.stringify(ed.cropSettings));
    return out;
} finally {
    await c("close_document", { doc: d.id });
    await c("activate_document", { doc: window.__testDoc });
}
"""),
    # set_filter / add_filter apply a preset's values as the layer row does, refuse before anything changes, and set_filter
    # pushes one undo step of its own; filter_types gives the options' labels and groups
    ("filter_presets", """
const { host } = await import("./editor/host.js");
const d = await c("new_document");
await c("load_image", { filename: "test_base.png", subfolder: "inpaint_canvas", type: "input", doc: d.id });
const ed = host.editorById(d.id);
const out = {};
try {
    const types = (await c("filter_types")).filters;
    const grain = types.find((f) => f.id === "grain");
    const pp = grain.params.find((p) => p.key === "preset");
    const p400 = pp.options.find((o) => o.id === "portra400");
    if (!p400 || p400.label !== "Kodak Portra 400" || p400.group !== "Colour negative") throw new Error("the preset option: " + JSON.stringify(p400));
    if (grain.params.find((p) => p.key === "look_strength").offset !== true || grain.params.find((p) => p.key === "amount").offset !== undefined) throw new Error("offset flags: " + JSON.stringify(grain.params));
    const n0 = ed.layers.length;
    let bad = "";
    try { await c("add_filter", { doc: d.id, type: "grain", params: { preset: "portra400", amount: "lots" } }); } catch (e) { bad = String(e.message || e); }
    if (!/^amount takes a number/.test(bad) || ed.layers.length !== n0) throw new Error("a refused add_filter: " + (bad || "not refused") + ", layers " + ed.layers.length);
    const g = await c("add_filter", { doc: d.id, type: "grain", params: { preset: "portra400" } });
    const L = ed.layers.find((l) => l.id === g.id);
    if (L.params.amount !== 18 || L.params.size !== 1.5 || L.params.chroma !== 30 || !L.params.look || L.params.look.warmth !== 9 || L.name !== "Kodak Portra 400") throw new Error("the preset's values: " + JSON.stringify({ name: L.name, params: L.params }));
    // a slider that is no offset turns the preset to custom; one undo step, named as the row names it
    const u0 = ed.undo.length;
    await c("set_filter", { doc: d.id, layer: g.id, params: { amount: 30 } });
    if (L.params.amount !== 30 || L.params.preset !== "custom" || ed.undo.length !== u0 + 1 || ed.undo[ed.undo.length - 1].label !== "Film / Grain: Grain") throw new Error("amount: " + JSON.stringify({ p: L.params, steps: ed.undo.length - u0, label: ed.undo[ed.undo.length - 1].label }));
    await c("undo", { doc: d.id });
    const L1 = ed.layers.find((l) => l.id === g.id);
    if (L1.params.amount !== 18 || L1.params.preset !== "portra400") throw new Error("one undo: " + JSON.stringify(L1.params));
    // an offset keeps the preset; the same value moves nothing
    await c("set_filter", { doc: d.id, layer: g.id, params: { look_strength: 50, size: 1.5 } });
    if (L1.params.preset !== "portra400" || L1.params.look_strength !== 50) throw new Error("an offset: " + JSON.stringify(L1.params));
    // Custom drops the stock's look and names the layer after the type
    await c("set_filter", { doc: d.id, layer: g.id, params: { preset: "custom" } });
    if (L1.params.look !== null || !/^Film . Grain [0-9]+$/.test(L1.name)) throw new Error("custom: " + JSON.stringify({ name: L1.name, look: L1.params.look }));
    // refused before anything changes, and no step
    const u1 = ed.undo.length, p1 = JSON.stringify(L1.params);
    const refused = async (args, re) => { let m = ""; try { await c("set_filter", { doc: d.id, layer: g.id, ...args }); } catch (e) { m = String(e.message || e); } if (!re.test(m) || JSON.stringify(L1.params) !== p1 || ed.undo.length !== u1 || L1.filter !== "grain") throw new Error("set_filter " + JSON.stringify(args) + ": " + (m || "not refused")); return m; };
    out.refused = [
        await refused({ params: { amount: 10, size: "x" } }, /^size takes a number/),
        await refused({ params: { preset: "velvia9000" } }, /is not an option of preset/),
        await refused({ type: "nope" }, /^unknown filter "nope"/),
        await refused({ type: "fill" }, /is a filter layer: its type is one of the filters/),
        await refused({ params: { chroma: true } }, /^chroma takes a number/),
    ];
    // a new type and its params: the type's own step alone
    await c("set_filter", { doc: d.id, layer: g.id, type: "blur", params: { radius: 3 } });
    if (L1.filter !== "blur" || L1.params.radius !== 3 || ed.undo.length !== u1 + 1 || ed.undo[ed.undo.length - 1].label !== "Filter type") throw new Error("type and params: " + JSON.stringify({ f: L1.filter, p: L1.params, steps: ed.undo.length - u1 }));
    // the black-and-white film's colour filter, when the film plugin is on
    if (types.some((f) => f.id === "film.bw")) {
        const bw = await c("add_filter", { doc: d.id, type: "film.bw", params: { preset: "red" } });
        const B = ed.layers.find((l) => l.id === bw.id);
        if (B.params.filter_hue !== 10 || B.params.filter_strength !== 90 || B.name !== "Red filter" || "look" in B.params) throw new Error("film.bw red: " + JSON.stringify({ name: B.name, p: B.params }));
        await c("set_filter", { doc: d.id, layer: bw.id, params: { filter_hue: 20 } });
        if (B.params.preset !== "custom" || B.params.filter_strength !== 90) throw new Error("film.bw hue: " + JSON.stringify(B.params));
        await c("set_filter", { doc: d.id, layer: bw.id, params: { tone: "sepia" } });
        if (B.params.preset !== "custom" || B.params.tone !== "sepia") throw new Error("film.bw toning: " + JSON.stringify(B.params));
        out.bw = B.params.preset;
    }
    out.steps = ed.undo.length - u0;
    return out;
} finally {
    await c("close_document", { doc: d.id });
    await c("activate_document", { doc: window.__testDoc });
}
"""),
    # select_color: the magic wand by command (contiguous or not, add, a layer's own pixels), the tool's options left as
    # they were; select_shape: an ellipse, a polygon added, an ellipse subtracted, a feathered edge. Both backends.
    ("select_color_and_shape", """
const { host } = await import("./editor/host.js");
const d = await c("new_document");
await c("new_canvas", { width: 400, height: 300, doc: d.id });
const ed = host.editorById(d.id);
const base = document.createElement("canvas"); base.width = 400; base.height = 300;
{ const x = base.getContext("2d"); x.fillStyle = "#c03020"; x.fillRect(0, 0, 200, 300); x.fillStyle = "#2040c0"; x.fillRect(200, 0, 200, 300); x.fillStyle = "#c03020"; x.fillRect(300, 100, 40, 40); }
Object.defineProperty(base, "naturalWidth", { value: 400 });
Object.defineProperty(base, "naturalHeight", { value: 300 });
await ed.setBase({ filename: "wand.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
if (ed.mipsSettled) await ed.mipsSettled();
const eq = (b, x, y, w, h) => b && b.x === x && b.y === y && b.w === w && b.h === h;
const at = (x, y) => ed.sel.readRect(x, y, 1, 1).data[3];
const out = { tiles: !!ed.tileMode };
try {
    const opts0 = JSON.stringify(ed.fillOpts);
    const u0 = ed.undo.length;
    const a1 = await c("select_color", { doc: d.id, x: 50, y: 50, tolerance: 10 });
    if (!eq(a1.selection, 0, 0, 200, 300) || ed.undo.length !== u0 + 1 || ed.undo[ed.undo.length - 1].label !== "Magic wand") throw new Error("contiguous red: " + JSON.stringify(a1));
    if (!at(10, 10) || at(250, 50) || at(310, 110)) throw new Error("contiguous: the island or the blue is selected");
    const a2 = await c("select_color", { doc: d.id, x: 50, y: 50, tolerance: 10, contiguous: false });
    if (!eq(a2.selection, 0, 0, 340, 300) || !at(310, 110) || at(250, 50)) throw new Error("every similar pixel: " + JSON.stringify(a2.selection));
    const a3 = await c("select_color", { doc: d.id, x: 250, y: 50, tolerance: 10, mode: "add" });
    if (!eq(a3.selection, 0, 0, 400, 300) || !at(250, 50)) throw new Error("add the blue: " + JSON.stringify(a3.selection));
    const a4 = await c("select_color", { doc: d.id, x: 310, y: 110, tolerance: 10, mode: "subtract" });
    if (at(310, 110) || !at(250, 50) || !at(10, 10)) throw new Error("subtract the island");
    if (JSON.stringify(ed.fillOpts) !== opts0) throw new Error("the wand's options changed: " + JSON.stringify(ed.fillOpts));
    // a layer's own pixels: a green square on a transparent layer
    const P = await import("./plugins.js");
    const img = new ImageData(50, 50);
    for (let i = 0; i < img.data.length; i += 4) { img.data[i] = 40; img.data[i + 1] = 210; img.data[i + 2] = 60; img.data[i + 3] = 255; }
    const made = new P.Document(ed).addLayer(img, { name: "Wand probe", x: 100, y: 100 });
    const top = (await c("add_paint_layer", { doc: d.id, name: "Above" })).id;
    if (ed.activeLayerId !== top) throw new Error("the paint layer is not active");
    const a5 = await c("select_color", { doc: d.id, x: 120, y: 120, sample: "layer", layer: made.id, tolerance: 5 });
    if (!eq(a5.selection, 100, 100, 50, 50) || ed.activeLayerId !== made.id || a5.layer !== made.id) throw new Error("the layer's pixels: " + JSON.stringify(a5));
    const filt = await c("add_filter", { doc: d.id, type: "blur" });
    const refusedC = async (args, re) => { let m = ""; try { await c("select_color", { doc: d.id, ...args }); } catch (e) { m = String(e.message || e); } if (!re.test(m)) throw new Error("select_color " + JSON.stringify(args) + ": " + (m || "not refused")); return m; };
    out.refusedColor = [
        await refusedC({ x: 400, y: 10 }, /^400, 10 is outside the 400 . 300 picture/),
        await refusedC({ x: 10 }, /^pass x and y/),
        await refusedC({ x: 10, y: 10, tolerance: 300 }, /^tolerance must be 0..255/),
        await refusedC({ x: 10, y: 10, sample: "layer", layer: filt.id }, /is a filter layer/),
        await refusedC({ x: 10, y: 10, layer: made.id }, /^layer goes with sample layer/),
        await refusedC({ x: 10, y: 10, mode: "xor" }, /^mode must be replace, add, subtract or intersect/),
    ];
    // select_rect, select_mask, select_point accept "intersect", and bad mode names the four
    const refusedR = async (args, re) => { let m = ""; try { await c("select_rect", { doc: d.id, ...args }); } catch (e) { m = String(e.message || e); } if (!re.test(m)) throw new Error("select_rect " + JSON.stringify(args) + ": " + (m || "not refused")); return m; };
    const refusedM = async (args, re) => { let m = ""; try { await c("select_mask", { doc: d.id, ...args }); } catch (e) { m = String(e.message || e); } if (!re.test(m)) throw new Error("select_mask " + JSON.stringify(args) + ": " + (m || "not refused")); return m; };
    const refusedP = async (args, re) => { let m = ""; try { await c("select_point", { doc: d.id, ...args }); } catch (e) { m = String(e.message || e); } if (!re.test(m)) throw new Error("select_point " + JSON.stringify(args) + ": " + (m || "not refused")); return m; };
    await refusedR({ x: 0, y: 0, w: 10, h: 10, mode: "bad" }, /^mode must be replace, add, subtract or intersect/);
    await refusedM({ mask: new Uint8Array(400 * 300), mode: "bad" }, /^mode must be replace, add, subtract or intersect/);
    await refusedP({ x: 10, y: 10, mode: "bad" }, /^mode must be replace, add, subtract or intersect/);
    await c("select_rect", { doc: d.id, x: 20, y: 20, w: 40, h: 40, mode: "intersect" });
    const fullMask = new Uint8Array(400 * 300); fullMask.fill(1);
    await c("select_mask", { doc: d.id, mask: fullMask, mode: "intersect" });
    // shapes
    const u1 = ed.undo.length;
    const e1 = await c("select_shape", { doc: d.id, shape: "ellipse", x: 100, y: 50, w: 200, h: 100 });
    if (!eq(e1.selection, 100, 50, 200, 100) || !at(200, 100) || !at(110, 100) || at(104, 54) || at(50, 100)) throw new Error("the ellipse: " + JSON.stringify(e1.selection));
    if (ed.undo[ed.undo.length - 1].label !== "Ellipse selection") throw new Error("the ellipse's step: " + ed.undo[ed.undo.length - 1].label);
    const p1 = await c("select_shape", { doc: d.id, shape: "polygon", points: [[10, 10], [110, 10], [10, 110]], mode: "add" });
    if (!at(20, 20) || at(80, 80) || !at(200, 100) || !eq(p1.selection, 10, 10, 290, 140)) throw new Error("the polygon added: " + JSON.stringify(p1.selection));
    await c("select_shape", { doc: d.id, shape: "ellipse", x: 180, y: 80, w: 40, h: 40, mode: "subtract" });
    if (at(200, 100) || !at(150, 100) || !at(20, 20)) throw new Error("the ellipse subtracted");
    if (ed.undo.length !== u1 + 3) throw new Error("one step per shape: " + (ed.undo.length - u1));
    const lasso = await c("select_shape", { doc: d.id, shape: "lasso", points: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 }, { x: 0, y: 60 }] });
    if (!eq(lasso.selection, 0, 0, 60, 60)) throw new Error("the lasso: " + JSON.stringify(lasso.selection));
    // a soft edge: half way at the shape's edge, a tail outside it, nothing three radii out; the bounds are the editor's
    // (where the selection is more than half on), so the shape's own box
    const f1 = await c("select_shape", { doc: d.id, shape: "ellipse", x: 100, y: 50, w: 200, h: 100, feather: 8 });
    const edge = at(100, 100), tail = at(90, 100), far = at(70, 100), mid = at(200, 100);
    if (mid < 250 || edge < 70 || edge > 190 || tail < 1 || tail > 60 || far > 2 || Math.abs(f1.selection.x - 100) > 3 || Math.abs(f1.selection.w - 200) > 6) throw new Error("the feathered edge: " + JSON.stringify({ mid, edge, tail, far, sel: f1.selection }));
    const refusedS = async (args, re) => { let m = ""; try { await c("select_shape", { doc: d.id, ...args }); } catch (e) { m = String(e.message || e); } if (!re.test(m)) throw new Error("select_shape " + JSON.stringify(args) + ": " + (m || "not refused")); return m; };
    const u2 = ed.undo.length;
    out.refusedShape = [
        await refusedS({ shape: "polygon", points: [[0, 0], [5, 5]] }, /^a polygon needs at least three points/),
        await refusedS({ shape: "polygon", points: [[0, 0], [5, 5], [5]] }, /^points.2. is no .x, y. point/),
        await refusedS({ shape: "ellipse", x: 0, y: 0, w: 0, h: 10 }, /^an ellipse needs x, y, w and h/),
        await refusedS({ shape: "ellipse", x: 500, y: 0, w: 20, h: 10 }, /^the ellipse lies outside the 400 . 300 picture/),
        await refusedS({ shape: "ellipse", x: 0, y: 0, w: 20, h: 10, feather: 1000 }, /^feather must be 0..512/),
        await refusedS({ shape: "star" }, /^shape must be ellipse, polygon or lasso/),
    ];
    if (ed.undo.length !== u2) throw new Error("a refused shape pushed a step");
    out.feather = { edge, tail, far };
    return out;
} finally {
    await c("close_document", { doc: d.id });
    await c("activate_document", { doc: window.__testDoc });
}
"""),
    # list_settings: the Settings rows as data (kind, options, range, valid); apply_preset: the Preset row's presets (the
    # Realism Pass's shipped L and M, the user's own, one of theirs replacing a shipped one of its name), refused with
    # nothing changed for a file the server lacks or a name it does not have; an API recipe has none
    ("list_settings_and_presets", """
const { host } = await import("./editor/host.js");
const d = await c("new_document");
await c("load_image", { filename: "test_base.png", subfolder: "inpaint_canvas", type: "input", doc: d.id });
const ed = host.editorById(d.id);
const prev = host.recipe, prevPresets = host.presets;
const raw0 = host.shell.recipes().find((x) => x.id === "realism_pass");
if (!raw0) throw new Error("no realism_pass recipe to try the shipped presets on");
const out = {};
const KEY = "rp_settings:dlss_model_preset";
try {
    host.setRecipe(host.shell.resolveRecipe(raw0));
    const s0 = await c("list_settings", { doc: d.id });
    const row = s0.settings[0];
    if (s0.recipe !== "realism_pass" || s0.settings.length !== 1 || row.index !== 1 || row.kind !== "combo" || row.options.join() !== "Default,J,K,L,M" || row.options_total !== 5 || row.valid !== true || row.input !== "dlss_model_preset") throw new Error("the row: " + JSON.stringify(s0));
    if (s0.presets.map((p) => p.name + (p.shipped ? "*" : "")).join() !== "L*,M*" || s0.presets[0].values[0].index !== 1 || s0.presets[0].values[0].value !== "L") throw new Error("the shipped presets: " + JSON.stringify(s0.presets));
    const m = await c("apply_preset", { doc: d.id, name: "M" });
    if (m.applied !== "M" || m.shipped !== true || m.rows !== 1 || ed.settings["1"].value !== "M") throw new Error("apply M: " + JSON.stringify(m));
    const s1 = await c("list_settings", { doc: d.id });
    if (s1.preset !== "M" || !s1.presets.find((p) => p.name === "M").current || s1.settings[0].value !== "M") throw new Error("after M: " + JSON.stringify(s1));
    await c("apply_preset", { doc: d.id, name: "l" });
    if (ed.settings["1"].value !== "L") throw new Error("a name in another case: " + ed.settings["1"].value);
    // the user's own: one named L replaces the shipped L, and one naming a file the row lacks is refused
    host.presets = { ...(prevPresets || {}), realism_pass: [{ name: "Gone", values: { [KEY]: "Z" } }, { name: "L", values: { [KEY]: "J" } }, { name: "Mine", values: { [KEY]: "K" } }] };
    const s2 = await c("list_settings", { doc: d.id });
    if (s2.presets.map((p) => p.name + (p.shipped ? "*" : "")).join() !== "M*,Gone,L,Mine" || JSON.stringify(s2.presets.find((p) => p.name === "Gone").missing) !== JSON.stringify(["Z"])) throw new Error("the user's presets: " + JSON.stringify(s2.presets));
    await c("apply_preset", { doc: d.id, name: "L" });
    if (ed.settings["1"].value !== "J") throw new Error("the user's L: " + ed.settings["1"].value);
    const refused = async (args, re) => { let msg = ""; const v = ed.settings["1"].value; try { await c("apply_preset", { doc: d.id, ...args }); } catch (e) { msg = String(e.message || e); } if (!re.test(msg) || ed.settings["1"].value !== v) throw new Error("apply_preset " + JSON.stringify(args) + ": " + (msg || "not refused")); return msg; };
    out.refused = [
        await refused({ name: "Gone" }, /^the server lacks Z, which preset "Gone" names: nothing changed/),
        await refused({ name: "Q" }, /^no preset "Q" for .* .M, Gone, L, Mine./),
    ];
    // an API recipe: its rows with their kinds, ranges and options; no presets
    host.setRecipe({ id: "loopback_settings", kind: "provider", provider: "loopback", providerLabel: "Loopback", model: "loopback", input: "edit", name: "Loopback settings",
        settings: [{ index: 1, key: "steps", label: "Steps", spec: ["INT", { min: 1, max: 50, step: 1, default: 20 }] }, { index: 2, key: "quality", label: "Quality", spec: [["low", "high"], {}] }] });
    const s3 = await c("list_settings", { doc: d.id, max_options: 1 });
    const st = s3.settings.find((x) => x.label === "Steps"), q = s3.settings.find((x) => x.label === "Quality");
    if (s3.provider !== "loopback" || s3.presets.length || s3.preset !== null || st.kind !== "number" || st.integer !== true || st.min !== 1 || st.max !== 50 || st.value !== 20 || st.valid !== true) throw new Error("the API rows: " + JSON.stringify(s3));
    if (q.kind !== "combo" || q.options.join() !== "low" || q.options_total !== 2 || q.valid !== true) throw new Error("the combo row: " + JSON.stringify(q));
    // a number out of its range is not valid (the Settings section puts a combo value it lacks back on its first option)
    await c("set_settings", { doc: d.id, values: { Steps: 80 } });
    const s4 = await c("list_settings", { doc: d.id, filter: "QUAL" });
    if (s4.settings.length !== 1 || s4.settings[0].label !== "Quality") throw new Error("the filter: " + JSON.stringify(s4.settings));
    if ((await c("list_settings", { doc: d.id, filter: "steps" })).settings[0].valid !== false) throw new Error("80 steps out of range is valid");
    out.refused.push(await refused({ name: "M" }, /^Loopback settings is an API recipe: its Settings have no presets/));
    return out;
} finally {
    host.presets = prevPresets;
    host.setRecipe(prev);
    await c("close_document", { doc: d.id });
    await c("activate_document", { doc: window.__testDoc });
}
"""),
    ("cutout_and_string_params", """
// docs/PLAN_0_1_43.md B1: cutout_layer answered a failure (with the success text) after an in-app cutout, which finishes
// inside the call; and filter params sent as a JSON string were refused. The in-app model is a stub here: host's
// backend list and its cutoutInApp answer a grey mask (white left half), or throw, and are put back afterwards
const H = await import("./editor/host.js");
const P = await import("./plugins.js");
const doc = new P.Document(editor);
const W = 32, H2 = 16;
const img = new ImageData(W, H2);
for (let i = 0; i < img.data.length; i += 4) { img.data[i] = 200; img.data[i + 1] = 120; img.data[i + 2] = 40; img.data[i + 3] = 255; }
const made = doc.addLayer(img, { name: "Cutout probe", x: 10, y: 10 });
const L = () => editor.layers.find((l) => l.id === made.id);
const saved = { backends: H.host.cutoutBackends, inApp: H.host.cutoutInApp, setting: editor.cutoutSettings };
const out = {};
try {
    H.host.cutoutBackends = () => [{ id: "stub-matting", label: "Stub matting", inApp: true }];
    editor.cutoutSettings = { backend: "stub-matting" };
    let calls = 0;
    H.host.cutoutInApp = async () => {
        calls++;
        const cv = document.createElement("canvas"); cv.width = W; cv.height = H2;
        const g = cv.getContext("2d"); g.fillStyle = "#000"; g.fillRect(0, 0, W, H2); g.fillStyle = "#fff"; g.fillRect(0, 0, W / 2, H2);
        return cv;
    };
    const r = await c("cutout_layer", { layer: made.id });
    if (calls !== 1) throw new Error("the stub model ran " + calls + " times");
    if (!r || r.id !== made.id) throw new Error("cutout_layer did not answer the layer: " + JSON.stringify(r).slice(0, 200));
    if (!L().maskPx) throw new Error("no mask after the cutout");
    if (editor.cutoutPending) throw new Error("the cutout is still pending");
    out.done = editor.status;
    // the in-app model fails: an error with the reason, nothing pending
    H.host.cutoutInApp = async () => { throw new Error("stub model broke"); };
    let msg = "";
    try { await c("cutout_layer", { layer: made.id }); } catch (e) { msg = String(e.message || e); }
    if (!/Background removal failed: stub model broke/.test(msg)) throw new Error("a failing in-app model: " + (msg || "it answered as done"));
    if (editor.cutoutPending) throw new Error("pending after a failure");
    out.failed = msg;
    // no model at all: refused before anything runs
    H.host.cutoutBackends = () => [];
    msg = "";
    try { await c("cutout_layer", { layer: made.id }); } catch (e) { msg = String(e.message || e); }
    if (!/No background removal model/.test(msg)) throw new Error("no model: " + (msg || "it answered as done"));
    out.none = msg;
} finally {
    H.host.cutoutBackends = saved.backends; H.host.cutoutInApp = saved.inApp; editor.cutoutSettings = saved.setting;
}
// filter params as a JSON string: parsed when it holds an object, refused otherwise (nothing added)
const fl = await c("add_filter", { type: "fill", params: "{\\"color\\": \\"#ff2d2d\\"}", name: "String params" });
const F = () => editor.layers.find((l) => l.id === fl.id);
if (F().params.color !== "#ff2d2d") throw new Error("add_filter with a string params: color " + F().params.color);
await c("set_filter", { layer: fl.id, params: "{\\"color\\":\\"#00ff00\\"}" });
if (F().params.color !== "#00ff00") throw new Error("set_filter with a string params: color " + F().params.color);
await c("set_filter", { layer: fl.id, params: "{}" });
const n0 = editor.layers.length;
for (const bad of ["not json", "[1, 2]", "\\"#ff0000\\""]) {
    let msg = "";
    try { await c("add_filter", { type: "fill", params: bad }); } catch (e) { msg = String(e.message || e); }
    if (!/params must be an object/.test(msg)) throw new Error("params " + bad + ": " + (msg || "accepted"));
}
if (editor.layers.length !== n0) throw new Error("a refused add_filter added a layer");
out.stringParams = F().params.color;
await c("remove_layer", { layer: fl.id });
await c("remove_layer", { layer: made.id });
return out;
"""),
    ("boxes_follow_generate_new", """
// docs/PLAN_0_1_43.md B6: Generate new whose answer is another size than the document (FLUX 3's 4k tier answers
// 5456 x 3072 for 4096 x 2304) left the boxes at their old pixel rects; they follow the answer as after a resize now.
// The loopback's answer_scale stands in for the model
const d = await c("new_document");
await c("new_canvas", { width: 400, height: 300, doc: d.id });
const ed = window.editor;
const H = (await import("./editor/host.js")).host;
const saved = H.recipe;
await c("boxes.add", { doc: d.id, kind: "new", rect: [40, 30, 200, 150], desc: "a red ball" });
await c("boxes.add", { doc: d.id, kind: "new", rect: [220, 160, 380, 290], desc: "a blue cube" });
const before = (await c("boxes.list", { doc: d.id })).boxes.map((b) => b.rect);
const out = { before };
try {
    H.setRecipe({ id: "loopback_scaled", kind: "provider", provider: "loopback", providerLabel: "Loopback", model: "loopback", input: "fill", text: { model: "loopback" }, name: "Loopback scaled",
        settings: [{ index: 1, key: "answer_scale", label: "Scale", spec: ["FLOAT", { default: 1.5 }] }] });
    const r = await c("generate_new", { doc: d.id, prompt: "a ball and a cube", width: 400, height: 300 });
    if (r.width !== 600 || r.height !== 450 || ed.width !== 600 || ed.height !== 450) throw new Error("the answer's size: " + JSON.stringify({ r: [r.width, r.height], ed: [ed.width, ed.height] }));
    out.after = (await c("boxes.list", { doc: d.id })).boxes.map((b) => b.rect);
    const want = before.map((rc) => rc.map((v) => Math.round(v * 1.5)));
    if (JSON.stringify(out.after) !== JSON.stringify(want)) throw new Error("the boxes did not follow: " + JSON.stringify({ before, after: out.after, want }));
    // the same size: nothing moves
    H.setRecipe({ id: "loopback_same", kind: "provider", provider: "loopback", providerLabel: "Loopback", model: "loopback", input: "fill", text: { model: "loopback" }, name: "Loopback", settings: [] });
    await c("generate_new", { doc: d.id, prompt: "again", width: 600, height: 450 });
    const same = (await c("boxes.list", { doc: d.id })).boxes.map((b) => b.rect);
    if (JSON.stringify(same) !== JSON.stringify(out.after)) throw new Error("an answer of the same size moved the boxes: " + JSON.stringify(same));
} finally {
    H.setRecipe(saved);
    await c("close_document", { doc: d.id });
    await c("activate_document", { doc: window.__testDoc });
}
return out;
"""),
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
