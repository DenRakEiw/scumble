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
const panel = Array.from(editor.root.querySelectorAll("details > summary")).find((s) => s.textContent === "Sample");
if (!panel) throw new Error("the Sample panel is missing");
const grp = editor.toolsEl.querySelector(".ipc-grp:last-of-type");
return { status: editor.status, panel: !!panel, group: grp && grp.textContent };
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
if (Array.from(editor.root.querySelectorAll("details > summary")).some((x) => x.textContent === "Sample")) throw new Error("panel still there");
await P.setEnabled("sample", true);
list = await c("list_plugins"); s = list.plugins.find((p) => p.id === "sample");
if (!s.loaded) throw new Error("not loaded again: " + s.error);
if (!editor.toolButtons["sample.probe"]) throw new Error("tool button not back");
if ((await c("list_layers")).layers.length !== n0) throw new Error("layer count changed");
return { loaded: s.loaded, registered: s.registered };
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
