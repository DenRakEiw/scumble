"""Exports written in bands (docs/PLAN_BCE.md §E2 to §E4): no canvas of the picture, the worker pool encodes.

No ComfyUI, no API key. A 6000 x 4000 document on the tile engine with paint layers (one with a blend mode and an
opacity, one masked), a pointwise filter layer and a blur, exported the new way and the old way and compared pixel by
pixel through the stream reader (inpaint_png.js `readPng`), which is itself held against the browser's decoder.

    python tools/export_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555 (tiles on, the default).
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

HELPERS = """
const PNG = await import("./editor/inpaint_png.js");
const T = await import("./editor/inpaint_tiles.js");
const Editor = (ed) => ed.constructor;
// every pixel of a PNG through the stream reader
const decode = async (blob) => {
    let out = null, W = 0, H = 0;
    const info = await PNG.readPng(blob, {
        onHeader: (h) => { W = h.width; H = h.height; out = new Uint8Array(W * H * 4); },
        onRows: (rgba, y0) => { out.set(rgba, y0 * W * 4); },
    });
    return { data: out, width: W, height: H, texts: info.texts };
};
// the same through the browser's decoder, in strips (a canvas per strip, read on the CPU)
const decodeByBrowser = async (blob) => {
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const W = bmp.width, H = bmp.height, out = new Uint8Array(W * H * 4);
    const c = document.createElement("canvas");
    c.width = W; c.height = Math.min(H, 512);
    const x = c.getContext("2d", { willReadFrequently: true });
    for (let y = 0; y < H; y += 512) {
        const h = Math.min(512, H - y);
        x.clearRect(0, 0, W, 512);
        x.drawImage(bmp, 0, y, W, h, 0, 0, W, h);
        out.set(x.getImageData(0, 0, W, h).data, y * W * 4);
    }
    bmp.close(); c.width = 1; c.height = 1;
    return { data: out, width: W, height: H };
};
const diff = (a, b, W) => {
    if (a.length !== b.length) return { bytes: -1, why: a.length + " against " + b.length + " bytes" };
    let n = 0, worst = 0, first = -1;
    for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { n++; if (d > worst) worst = d; if (first < 0) first = i; } }
    return { bytes: n, worst, first: first < 0 ? null : [(first >> 2) % W, Math.floor((first >> 2) / W), first & 3] };
};
const seamRows = (a, b, W, H) => {   // rows where the two pictures differ, as multiples of 256 or not
    const rows = new Set();
    for (let y = 0; y < H; y++) { const o = y * W * 4; for (let i = o; i < o + W * 4; i++) if (a[i] !== b[i]) { rows.add(y); break; } }
    const list = Array.from(rows);
    return { rows: list.length, nearSeams: list.filter((y) => (y % 256) < 2 || (y % 256) > 253).length, sample: list.slice(0, 8) };
};
"""

STEPS = [
    ("reader_matches_the_browser", """
// every colour type the reader takes, written by the browser's encoder or by hand, against the browser's decoder
const c = document.createElement("canvas");
c.width = 301; c.height = 777;
const x = c.getContext("2d");
const g = x.createLinearGradient(0, 0, 301, 777);
g.addColorStop(0, "rgba(255,40,20,0.05)"); g.addColorStop(0.5, "rgba(20,200,90,0.5)"); g.addColorStop(1, "rgba(30,60,250,1)");
x.fillStyle = g; x.fillRect(0, 0, 301, 777);
x.fillStyle = "rgba(250,250,0,0.3)"; x.beginPath(); x.arc(120, 400, 90, 0, 7); x.fill();
const blob = await new Promise((r) => c.toBlob(r, "image/png"));
const mine = await decode(blob), theirs = await decodeByBrowser(blob);
const d = diff(mine.data, theirs.data, 301);
if (d.bytes) throw new Error("RGBA: the stream reader differs from the browser: " + JSON.stringify(d));
// opaque: the browser writes RGB (colour type 2)
x.globalCompositeOperation = "destination-over"; x.fillStyle = "#123456"; x.fillRect(0, 0, 301, 777);
const blob2 = await new Promise((r) => c.toBlob(r, "image/png"));
const head = PNG.pngHeader(new Uint8Array(await blob2.slice(0, 33).arrayBuffer()));
const m2 = await decode(blob2), t2 = await decodeByBrowser(blob2);
const d2 = diff(m2.data, t2.data, 301);
if (d2.bytes) throw new Error("colour type " + head.colorType + ": the stream reader differs from the browser: " + JSON.stringify(d2));
return { rgba: d, second: { colorType: head.colorType, ...d2 } };
"""),
    ("tile_pixels_as_png_parts", """
// a layer's PNG straight from its tiles: the pixels of readRect, byte for byte, at a size that is no multiple of 256,
// with empty tiles, wider than one part
const E = Editor(host.editors()[0] || (await (async () => { const d = await run("new_document"); return ednow(d.id); })()));
if (!E.parts.usable()) throw new Error("PNG parts are not usable here (no pool, or no Rust kernels)");
const W = 9001, H = 1301;
const c = document.createElement("canvas");
c.width = W; c.height = H;
const x = c.getContext("2d");
const g = x.createLinearGradient(0, 0, W, H);
g.addColorStop(0, "rgba(255,40,20,0.02)"); g.addColorStop(0.5, "rgba(20,200,90,0.5)"); g.addColorStop(1, "rgba(30,60,250,1)");
x.fillStyle = g; x.fillRect(0, 0, 5000, 900);
x.fillStyle = "rgba(250,250,0,0.3)"; x.beginPath(); x.arc(7000, 1100, 180, 0, 7); x.fill();
const px = T.TileLayerPixels.fromCanvas(c);
c.width = 1; c.height = 1;
const want = px.readRect(0, 0, W, H).data;
const t0 = performance.now();
const r = await E.parts.encodeTilePixels(px, { hash: true, texts: { note: "hello" } });
const ms = Math.round(performance.now() - t0);
if (!r) throw new Error("encodeTilePixels gave nothing");
if (!/^[0-9a-f]{12}$/.test(r.hash)) throw new Error("no hash: " + r.hash);
const got = await decode(r.blob);
if (got.width !== W || got.height !== H) throw new Error("the file is " + got.width + " x " + got.height);
if (got.texts.note !== "hello") throw new Error("the tEXt chunk did not come back: " + JSON.stringify(got.texts));
const d = diff(got.data, want, W);
if (d.bytes) throw new Error("the PNG from the tiles differs from readRect: " + JSON.stringify(d));
// and the browser reads the file as the same picture (a file only this reader can read would be no PNG)
const b = await decodeByBrowser(r.blob);
const viaCanvas = await decodeByBrowser(await new Promise((res) => px.toCanvas().toBlob(res, "image/png")));
const d2 = diff(b.data, viaCanvas.data, W);
if (d2.bytes) throw new Error("the browser decodes the parts file differently from the canvas's own PNG: " + JSON.stringify(d2));
// the clone that held the tiles is released: a write afterwards copies nothing
const frozen = px.tileList().filter((t) => t.frozen > 0).length;
if (frozen) throw new Error(frozen + " tiles are still frozen after the encode");
return { ms, tiles: px.tileCount, bytes: r.blob.size, ratio: +(r.blob.size / (W * H * 4)).toFixed(3) };
"""),
    ("setup_document", """
const d = await run("new_document");
window.__ex = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
if (!ed.tileMode) throw new Error("this test needs the tile engine");
const W = 6000, H = 4000;
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const paint = (c, hue, n) => {
    const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, c.width, c.height);
    g.addColorStop(0, `hsl(${hue},70%,45%)`); g.addColorStop(1, `hsl(${(hue + 90) % 360},70%,25%)`);
    x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
    x.globalAlpha = 0.7;
    for (let i = 0; i < n; i++) { x.fillStyle = `hsl(${(i * 37) % 360},80%,55%)`; x.beginPath(); x.arc((i * 977) % c.width, (i * 613) % c.height, Math.max(8, c.width / 40), 0, Math.PI * 2); x.fill(); }
    x.globalAlpha = 1;
    return c;
};
const base = paint(mk(W, H), 210, 60);
Object.defineProperty(base, "naturalWidth", { value: W });
Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "export_test.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
const L = ed.pixels.Layer, M = ed.pixels.Mask;
// a paint layer with soft alpha, multiplied at 60 %
{
    const c = mk(W, H), x = c.getContext("2d");
    for (let k = 0; k < 24; k++) { x.fillStyle = `hsla(${k * 53},70%,60%,${0.2 + (k % 5) * 0.15})`; x.fillRect((k * 811) % W, (k * 457) % H, W / 9, H / 9); }
    const l = ed.addLayer({ name: "Multiply", kind: "paint", px: L.fromCanvas(c), x: 0, y: 0, w: W, h: H, dirty: true });
    l.blend = "multiply"; l.opacity = 0.6;
}
// a smaller layer at whole coordinates with a transparency mask
{
    const w = 2048, h = 1536;
    const c = paint(mk(w, h), 20, 25);
    const m = mk(w, h), mx = m.getContext("2d");
    const g = mx.createRadialGradient(w / 2, h / 2, 50, w / 2, h / 2, w / 2);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(1, "rgba(255,255,255,0)");
    mx.fillStyle = g; mx.fillRect(0, 0, w, h);
    const l = ed.addLayer({ name: "Masked", kind: "result", px: L.fromCanvas(c), x: 1700, y: 1100, w, h, dirty: true });
    l.maskPx = M.fromCanvas(m); l.maskDirty = true;
    window.__exMasked = l.id;
}
const fx = ed.addFilterLayer("levels");
ed.uploaded.baseHash = null;
ed.renderLayers(); ed.fitView(); ed.draw();
await ed.mipsSettled();
return { doc: d.id, layers: ed.layers.map((l) => l.name + ":" + l.kind), filter: fx && fx.filter };
"""),
    ("composite_in_bands_equals_the_flatten", """
const ed = ednow(window.__ex);
const E = Editor(ed);
const plan = ed.bandPlan({ forRun: true });
if (!plan) throw new Error("no band plan for a document of pointwise layers");
const t0 = performance.now();
let held = 0, last = performance.now(), on = true;
const beat = () => { const n = performance.now(); held = Math.max(held, n - last); last = n; if (on) setTimeout(beat, 0); };
setTimeout(beat, 0);
const r = await ed.encodeComposite({ forRun: true }, { hash: true, texts: { probe: "1" } });
on = false;
const ms = Math.round(performance.now() - t0);
if (!r) throw new Error("encodeComposite gave nothing");
const flat = ed.flattenToCanvas({ forRun: true });
const t1 = performance.now();
const old = await E.parts.encodeCanvas(flat, { hash: false });
const oldMs = Math.round(performance.now() - t1);
flat.width = 1; flat.height = 1;
const a = await decode(r.blob), b = await decode(old.blob);
const d = diff(a.data, b.data, ed.width);
const seams = d.bytes ? seamRows(a.data, b.data, ed.width, ed.height) : null;
window.__exRef = a.data;
// Measured: 862 of 96,000,000 bytes one level apart, on the multiplied layer's soft rectangles, none of them on a band
// seam more often than chance: the whole flatten blends on one GPU canvas of 24 MP, a band on one of 1.5 MP, and Skia
// rounds the two differently (CLAUDE.md, traps). More than one level, or more than 0.01 % of the bytes, is a bug.
if (d.worst > 1 || d.bytes > a.data.length / 10000) throw new Error("the composite in bands differs from the flatten: " + JSON.stringify({ d, seams }));
if (seams && seams.rows > 8 && seams.nearSeams > seams.rows / 4) throw new Error("the differences sit on the band seams: " + JSON.stringify(seams));
return { diff: d, seams, reach: plan.reach, ms, blocked: Math.round(held), oldMs, MB: +(r.blob.size / 1048576).toFixed(1), oldMB: +(old.blob.size / 1048576).toFixed(1) };
"""),
    ("a_blur_in_the_stack_shows_no_seam", """
const ed = ednow(window.__ex);
const E = Editor(ed);
const fx = ed.addFilterLayer("blur");
fx.params.radius = 6;
ed.markFilterChanged(fx);
const plan = ed.bandPlan({ forRun: true });
if (!plan || !(plan.reach >= 18)) throw new Error("the blur's reach is not in the band plan: " + JSON.stringify(plan));
const r = await ed.encodeComposite({ forRun: true }, {});
const flat = ed.flattenToCanvas({ forRun: true });
const old = await E.parts.encodeCanvas(flat, {});
flat.width = 1; flat.height = 1;
const a = await decode(r.blob), b = await decode(old.blob);
const d = diff(a.data, b.data, ed.width);
const seams = seamRows(a.data, b.data, ed.width, ed.height);
ed.removeLayer(fx.id);
// Skia's blur of a smaller canvas comes out up to 1 to 3 levels apart (docs/PLAN_BCE.md §C6 c1); a wrong margin is a
// line at every 256th row, far above that
if (d.worst > 3) throw new Error("the blurred composite in bands is " + d.worst + " levels off: " + JSON.stringify({ d, seams }));
if (seams.rows && seams.nearSeams === seams.rows) throw new Error("the differences sit on the band seams only: " + JSON.stringify(seams));
return { reach: plan.reach, d, seams };
"""),
    ("a_matched_layer_keeps_the_whole_flatten", """
const ed = ednow(window.__ex);
const l = ed.layers.find((x) => x.id === window.__exMasked);
l.match = { strength: 60, source: "surroundings" };
ed.markMatchChanged(l);
const plan = ed.bandPlan({ forRun: true });
l.match = { strength: 0, source: "surroundings" };
ed.markMatchChanged(l);
if (plan) throw new Error("a colour-matched layer got a band plan: its statistics are the whole flatten's");
return { plan };
"""),
    ("a_run_reads_its_box_and_a_window_of_the_selection", """
// E2: a provider run composites its crop box only and reads the selection in a window around its bounds (the image is
// 24 MP, above the 16 MP where the window starts). Crop, masks and the stitched patch against the whole-image way.
const ed = ednow(window.__ex);
const S = await import("./editor/stitch.js");
await run("select_rect", { doc: window.__ex, x: 2100, y: 1300, width: 900, height: 700 });
await run("select_feather", { doc: window.__ex, radius: 12 });
const bytes = (c) => c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
const answer = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, "#d04010"); g.addColorStop(1, "#1060d0"); x.fillStyle = g; x.fillRect(0, 0, w, h); return c; };
const once = () => {
    const prep = S.prepareCrop(ed, host.nodeParams, host.cropLimits());
    const fin = S.finishResult(ed, prep.info, prep.sel, answer(prep.info.emitted[0], prep.info.emitted[1]));
    return { prep, fin };
};
const a = once();
if (!(a.prep.sel.w < ed.width) || !(a.prep.sel.ox > 0)) throw new Error("the selection was read over the whole image: " + [a.prep.sel.w, a.prep.sel.h, a.prep.sel.ox]);
const was = S.setSelectionWindowPixels(Infinity);
let b;
try { b = once(); } finally { S.setSelectionWindowPixels(was); }
if (b.prep.sel.w !== ed.width) throw new Error("the switch did not give the whole mask");
if (JSON.stringify(a.prep.info) !== JSON.stringify(b.prep.info)) throw new Error("the crop differs: " + JSON.stringify(a.prep.info.bbox) + " against " + JSON.stringify(b.prep.info.bbox));
const out = {};
for (const [what, x, y] of [["crop", a.prep.crop, b.prep.crop], ["mask", a.prep.mask, b.prep.mask], ["maskAlpha", a.prep.maskAlpha, b.prep.maskAlpha], ["patch", a.fin.patch, b.fin.patch]]) {
    const d = diff(bytes(x), bytes(y), x.width);
    out[what] = d.bytes;
    if (d.bytes) throw new Error("the run's " + what + " differs between the window and the whole selection: " + JSON.stringify(d));
}
// the crop is the box of the composite the export writes
const [bx, by, bw, bh] = a.prep.info.bbox;
if (a.prep.crop.width === bw && a.prep.crop.height === bh) {
    const got = bytes(a.prep.crop), ref = window.__exRef;
    let n = 0, worst = 0;
    for (let y = 0; y < bh; y++) for (let i = 0; i < bw * 4; i++) { const d = Math.abs(got[y * bw * 4 + i] - ref[((by + y) * ed.width + bx) * 4 + i]); if (d) { n++; if (d > worst) worst = d; } }
    out.cropAgainstExport = [n, worst];
    if (worst > 1) throw new Error("the run's crop is " + worst + " levels off the exported composite on " + n + " bytes");
}
await run("select_none", { doc: window.__ex });
return { bbox: a.prep.info.bbox, window: [a.prep.sel.ox, a.prep.sel.oy, a.prep.sel.w, a.prep.sel.h], ...out };
"""),
    ("export_png_through_the_editor", """
const ed = ednow(window.__ex);
let saved = null;
const was = host.saveExport;
host.saveExport = async (blob, name) => { saved = { blob, name }; return { path: "memory:" + name }; };
try {
    if (ed.saveFormatSel) ed.saveFormatSel.value = "png";
    const out = await ed.exportImage({ download: false });
    if (!out || !saved) throw new Error("exportImage saved nothing: " + ed.status);
} finally { host.saveExport = was; }
const a = await decode(saved.blob);
if (!a.texts.workflow || !a.texts.inpaint_canvas) throw new Error("the recipe is not embedded: " + Object.keys(a.texts));
const d = diff(a.data, window.__exRef, ed.width);
if (d.bytes) throw new Error("the exported PNG differs from the flatten: " + JSON.stringify(d));
if (!/ms\\)/.test(ed.status)) throw new Error("the export did not go through the bands: " + ed.status);
return { status: ed.status };
"""),
    ("flatten_in_bands", """
const ed = ednow(window.__ex);
const n = ed.layers.length;
await ed.flatten();
if (ed.layers.length) throw new Error("the flatten kept " + ed.layers.length + " of " + n + " layers: " + ed.status);
const got = ed.basePx.readRect(0, 0, ed.width, ed.height).data;
const d = diff(got, window.__exRef, ed.width);
if (d.bytes) throw new Error("the flattened base differs from the flatten before it: " + JSON.stringify(d));
await run("undo", { doc: window.__ex });
if (ed.layers.length !== n) throw new Error("undo did not bring the layers back: " + ed.layers.length);
return { status: ed.status, layers: n };
"""),
    ("close", """
const id = window.__ex;
window.__exRef = null;
await run("close_document", { doc: id, force: true });
return { closed: id };
"""),
]

PRE = """(async () => {
    const commands = window.__cmds.commands, host = window.__host;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    %s
    %s
})()"""


async def run_all(c):
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); window.__host = (await import('./editor/host.js')).host; await import('./shell.js'); return 1; })()")
    ok = True
    tiles = await c.eval("(async () => { const h = (await import('./editor/host.js')).host; const e = h.editors()[0]; return e ? !!e.tileMode : null; })()")
    if tiles is False:
        print("[ok] skipped: the canvas backend keeps its canvas paths (bands are for the tile engine)")
        print("PASS")
        return True
    only = [a for a in sys.argv[1:] if not a.startswith("-")]
    for name, body in STEPS:
        if only and name not in only and name not in ("setup_document", "close"):
            continue
        try:
            res = await c.eval(PRE % (HELPERS, body), timeout=600)
            print("[ok] %s: %s" % (name, json.dumps(res)[:400]))
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] %s: %s" % (name, str(err)[:900]))
            if name == "setup_document":
                break
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:220])
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
