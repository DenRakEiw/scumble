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
window.__exRef = a.data;
// B item 7 part 2: a levels layer over a multiplied and a masked layer is a stack program: the workers composite the
// bands, the GPU filters their bytes. The multiplied layer's soft rectangles are then the kernel's, rounded once, where
// the compositor's shader reads its source back from a premultiplied texture: one level apart on 1.1 % of the bytes
// (measured; 4.9 % before the kernel rounded once), and the levels layer at its defaults passes that on. More than one
// level, or more than 2 % of the bytes, is a bug.
if (!(r.program > 0)) throw new Error("the bands did not come from the stack program: " + JSON.stringify({ program: r.program }));
if (d.worst > 1 || d.bytes > a.data.length / 50) throw new Error("the composite of the stack program differs from the flatten: " + JSON.stringify({ d }));
// the region pass, which the program replaced and falls back to, against the same flatten. Measured: 862 of 96,000,000
// bytes one level apart, on the multiplied layer's soft rectangles, none of them on a band seam more often than chance:
// the whole flatten blends on one GPU canvas of 24 MP, a band on one of 1.5 MP, and Skia rounds the two differently
// (CLAUDE.md, traps). More than one level, or more than 0.01 % of the bytes, is a bug.
E.stackFilters = false;
let viaPass;
try { viaPass = await ed.encodeComposite({ forRun: true }, {}); } finally { E.stackFilters = true; }
if (!viaPass || viaPass.program) throw new Error("with stackFilters off the bands still came from the program");
const p = await decode(viaPass.blob);
const dp = diff(p.data, b.data, ed.width);
const seams = dp.bytes ? seamRows(p.data, b.data, ed.width, ed.height) : null;
if (dp.worst > 1 || dp.bytes > p.data.length / 10000) throw new Error("the composite in bands differs from the flatten: " + JSON.stringify({ dp, seams }));
if (seams && seams.rows > 8 && seams.nearSeams > seams.rows / 4) throw new Error("the differences sit on the band seams: " + JSON.stringify(seams));
return { program: r.program, timing: r.programTiming, diff: d, share: +(d.bytes / a.data.length).toFixed(5), pass: dp, seams, reach: plan.reach, ms, blocked: Math.round(held), oldMs, MB: +(r.blob.size / 1048576).toFixed(1), oldMB: +(old.blob.size / 1048576).toFixed(1) };
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
    ("filters_of_the_whole_picture_in_bands", """
// E3: a vignette, a normalise, a frame, a light leak and a film look with halation belong to the whole picture. Each
// of them over the document, in bands against the whole flatten: no line at a band's edge, and within what a blur of
// a smaller canvas gives (3 levels); the pointwise ones within 1.
const ed = ednow(window.__ex);
const E = Editor(ed);
const { FILTERS } = await import("./editor/inpaint_filters.js");
// every filter there is, at its defaults, plus the ones whose picture depends on the whole image with settings that show
const special = {
    vignette: [{ amount: 70, size: 40, softness: 40 }, 1],
    normalize: [{ mode: "levels", amount: 80 }, 2],   // a stretch of the levels doubles the one level the composite below differs by
    "film.frame": [{ width: 6 }, 1],
    "film.light_leak": [{ strength: 80 }, 1],
    "film.look": [{ preset: "portra400", halation: 100, grain: 0 }, 3],
};
const cases = [];
for (const id of Object.keys(FILTERS)) {
    if (id === "lut" || id === "film.points" || id.startsWith("sample.")) continue;   // need a LUT file / points; the sample plugin is the commands gate's
    const sp = special[id];
    cases.push([id, sp ? sp[0] : {}, sp ? sp[1] : null]);
}
const out = {};
for (const [id, params, tolerance] of cases) {
    const fx = ed.addFilterLayer(id);
    Object.assign(fx.params, params);
    ed.markFilterChanged(fx);
    const plan = ed.bandPlan({ forRun: true });
    if (!plan) { ed.removeLayer(fx.id); throw new Error(id + ": no band plan"); }
    // the bands of the region pass (what E3 built, and what the stack program falls back to) ...
    E.stackFilters = false;
    let r;
    try { r = await ed.encodeComposite({ forRun: true }, {}); } finally { E.stackFilters = true; }
    if (r.program) { ed.removeLayer(fx.id); throw new Error(id + ": with stackFilters off the bands came from the program"); }
    // ... and the bands of the stack program (B item 7 part 2): two filter layers over the workers' composite
    const rp = await ed.encodeComposite({ forRun: true }, {});
    const flat = ed.flattenToCanvas({ forRun: true });
    const old = await E.parts.encodeCanvas(flat, {});
    flat.width = 1; flat.height = 1;
    const a = await decode(r.blob), b = await decode(old.blob), ap = await decode(rp.blob);
    const d = diff(a.data, b.data, ed.width), dn = diff(ap.data, b.data, ed.width);
    const seams = d.bytes ? seamRows(a.data, b.data, ed.width, ed.height) : null;
    const seamsP = dn.bytes ? seamRows(ap.data, b.data, ed.width, ed.height) : null;
    ed.removeLayer(fx.id);
    out[id] = [plan.reach, d.bytes, d.worst, rp.program || 0, dn.bytes, dn.worst];
    const allowed = tolerance != null ? tolerance : plan.reach > 0 ? 3 : 2;   // a blur of a smaller canvas: up to 3 levels (C6 c1); a contrast curve doubles the one level of the composite below
    if (d.worst > allowed) throw new Error(id + " in bands is " + d.worst + " levels off the whole flatten: " + JSON.stringify({ d, seams, plan }));
    // The program's composite below the filters is a level from the flatten's on 1 % of the bytes (the step before), and
    // the filter rounds once more, so a level above the pass's tolerance; a filter that steepens the picture doubles it
    if (!(rp.program > 0)) throw new Error(id + ": the bands did not come from the stack program");
    const allowedP = allowed + 1;   // measured over all 23 filters: never more than a level above what the pass itself shows
    if (dn.worst > allowedP) throw new Error(id + " over the stack program is " + dn.worst + " levels off the whole flatten: " + JSON.stringify({ dn, seamsP, plan }));
    if (seamsP && seamsP.rows > 64 && seamsP.nearSeams === seamsP.rows) throw new Error(id + ": the program's differences sit on the band seams only: " + JSON.stringify(seamsP));
    // does the filter do anything at all here? (a filter that is skipped would pass everything above)
    if (special[id]) {
        const plain = window.__exRef;
        let moved = 0;
        for (let i = 0; i < plain.length; i += 4001) if (plain[i] !== a.data[i]) moved++;
        if (!moved) throw new Error(id + " changed nothing in the picture");
    }
}
return out;
"""),
    ("a_matched_layer_is_composited_by_the_workers", """
// B item 7 part 3 (docs/PLAN_BCE.md 3b): a colour-matched layer takes the worker path. Its statistics are point samples
// of the tiles (the layer through its mask, and the composite below it, at 256 px) in place of the whole flatten drawn
// small (the user's decision (b) of C6 (c) 7c), and the match runs in the worker before the layer is composited. Against
// the whole flatten (its own statistics) the matched layer moves by a few levels; with the flatten's statistics handed to
// the worker path, the two are within the kernels' rounding. The setup document: the masked result layer under a levels
// layer (the program), the multiply layer below it.
const ed = ednow(window.__ex);
host.shell.activate(ed);
const E = Editor(ed);
const W = ed.width, H = ed.height;
const l = ed.layers.find((x) => x.id === window.__exMasked);
const fx = ed.layers.find((x) => x.kind === "filter");
const box = [l.x, l.y, l.x + l.w, l.y + l.h];
const inBox = (a, b) => {   // the differences on the matched layer's box: mean, p99, max, and the share over 4 levels
    const hist = new Uint32Array(256);
    let n = 0, sum = 0, max = 0;
    for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) {
        const i = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) { const e = Math.abs(a[i + c] - b[i + c]); hist[e]++; sum += e; n++; if (e > max) max = e; }
    }
    let acc = 0, p99 = 0;
    for (let e = 0; e < 256; e++) { acc += hist[e]; if (acc >= n * 0.99) { p99 = e; break; } }
    let over4 = 0;
    for (let e = 5; e < 256; e++) over4 += hist[e];
    return { mean: +(sum / n).toFixed(3), p99, max, over4: +(over4 / n).toFixed(5) };
};
const outside = (a, b) => { let worst = 0; for (let y = 0; y < H; y += 7) for (let x = 0; x < W; x += 5) { if (x >= box[0] && x < box[2] && y >= box[1] && y < box[3]) continue; const i = (y * W + x) * 4; for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs(a[i + c] - b[i + c])); } return worst; };
const flatten = async () => { const flat = ed.flattenToCanvas({ forRun: true }); const old = await E.parts.encodeCanvas(flat, { hash: false }); flat.width = 1; flat.height = 1; return (await decode(old.blob)).data; };
const out = {};
try {
// unmatched, to prove the match is in the picture
const plain = (await decode((await ed.encodeComposite({ forRun: true }, { hash: false })).blob)).data;
for (const [source, strength] of [["surroundings", 60], ["underneath", 100]]) {
    l.match = { strength, source };
    ed.markMatchChanged(l);
    const plan = ed.stackPlan({ forRun: true, filters: true });
    if (!plan || !plan.some((s) => s && s.match === l)) throw new Error(source + ": the stack plan does not carry the matched layer: " + JSON.stringify(plan && plan.map((s) => (s && s.filter ? "f" : s && s.match ? "m" : "l"))));
    const bp = ed.bandPlan({ forRun: true });
    if (!bp || !bp.stackOnly) throw new Error(source + ": the band plan of a matched document is " + JSON.stringify(bp));
    const r = await ed.encodeComposite({ forRun: true }, { hash: false });
    if (!r || !r.program) throw new Error(source + ": the composite did not come through the program: " + JSON.stringify(r && { stack: r.stack, program: r.program }));
    const a = (await decode(r.blob)).data;
    const b = await flatten();
    const d = inBox(a, b);
    d.outside = outside(a, b);
    // the layer is matched: far from the unmatched picture on a good part of its box
    let moved = 0, seen = 0;
    for (let y = box[1]; y < box[3]; y += 3) for (let x = box[0]; x < box[2]; x += 3) { const i = (y * W + x) * 4; seen++; if (Math.abs(a[i] - plain[i]) > 8 || Math.abs(a[i + 1] - plain[i + 1]) > 8 || Math.abs(a[i + 2] - plain[i + 2]) > 8) moved++; }
    d.moved = +(moved / seen).toFixed(3);
    if (d.moved < 0.2) throw new Error(source + ": the matched layer is not matched in the workers' picture (moved on " + d.moved + " of its box)");
    // the whole flatten's statistics through the worker path: the same picture but for the kernels' rounding
    const st = l._mstats;
    if (!st || !st.stats) throw new Error(source + ": the flatten left no statistics");
    l._mstatsStackRun = { version: ed.compositeVersion, key: JSON.stringify([source, l.x, l.y, l.w, l.h]), stats: st.stats };
    const same = (await decode((await ed.encodeComposite({ forRun: true }, { hash: false })).blob)).data;
    l._mstatsStackRun = null;
    d.sameStats = inBox(same, b);
    if (d.sameStats.max > 3) throw new Error(source + ": with the flatten's statistics the worker path is " + d.sameStats.max + " levels off the flatten: " + JSON.stringify(d.sameStats));
    if (source === "surroundings") {
        // a provider run's crop reads its box through `readBox` (the whole flatten's statistics): within the statistics bound of the export's box
        const [cx0, cy0, cw, ch] = [2000, 1400, 800, 600];
        const rb = ed.readBox([cx0, cy0, cx0 + cw, cy0 + ch], { forRun: true });
        if (rb.width !== cw || rb.height !== ch) throw new Error("readBox gave " + rb.width + " x " + rb.height);
        const crop = rb.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, cw, ch).data;
        let cn = 0, csum = 0, cmax = 0;
        for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const i = (y * cw + x) * 4, j = ((cy0 + y) * W + cx0 + x) * 4; for (let c = 0; c < 3; c++) { const e = Math.abs(crop[i + c] - a[j + c]); csum += e; cn++; if (e > cmax) cmax = e; } }
        d.crop = { mean: +(csum / cn).toFixed(3), max: cmax };
        if (cmax > 16 || csum / cn > 2) throw new Error("a run's crop of the matched document is far from the export: " + JSON.stringify(d.crop));
    }
    out[source] = d;
    // point samples against the flatten's statistics: a few levels on a smooth picture (the photos measured mean 0.56, max 9)
    if (d.mean > 2 || d.p99 > 8 || d.max > 16 || d.outside > 2) throw new Error(source + ": the matched layer moved too far from the whole flatten: " + JSON.stringify(d));
}
// a second matched layer above the first: matched in the first one's matched backdrop, in order
{
    const c = document.createElement("canvas"); c.width = 900; c.height = 600;
    const x = c.getContext("2d"); x.fillStyle = "hsl(120,60%,50%)"; x.fillRect(0, 0, 900, 600);
    for (let k = 0; k < 12; k++) { x.fillStyle = `hsla(${k * 31},70%,60%,0.6)`; x.fillRect((k * 211) % 900, (k * 137) % 600, 120, 90); }
    // over the picture's right and bottom edges: its own samples outside the picture count, as the flatten's do
    const l2 = ed.addLayer({ name: "Second", kind: "result", px: ed.pixels.Layer.fromCanvas(c), x: 5400, y: 3700, w: 900, h: 600, dirty: true });
    await run("move_layer", { doc: window.__ex, layer: l2.id, delta: -1 });   // below the filter layer
    l2.match = { strength: 100, source: "surroundings" };
    ed.markMatchChanged(l2);
    ed.renderLayers();
    await ed.mipsSettled();
    const plan = ed.stackPlan({ forRun: true, filters: true });
    const marks = plan ? plan.map((s) => (s && s.filter ? "f" : s && s.match ? "m" : "l")).join("") : null;
    if (marks !== "llmmf") throw new Error("the plan with two matched layers is " + marks);
    const r = await ed.encodeComposite({ forRun: true }, { hash: false });
    if (!r || !r.program) throw new Error("two matched layers: the composite did not come through the program");
    const a = (await decode(r.blob)).data, b = await flatten();
    const d2 = inBox(a, b);
    let n = 0, sum = 0, max = 0;
    for (let y = 3700; y < H; y++) for (let x = 5400; x < W; x++) { const i = (y * W + x) * 4; for (let c = 0; c < 3; c++) { const e = Math.abs(a[i + c] - b[i + c]); sum += e; n++; if (e > max) max = e; } }
    out.second = { first: d2, second: { mean: +(sum / n).toFixed(3), max } };
    if (d2.max > 16 || max > 16 || sum / n > 2) throw new Error("two matched layers moved too far from the whole flatten: " + JSON.stringify(out.second));
    ed.removeLayer(l2.id);
}
// without the filter layer: the plain stack, composited row by row by the workers that pack them
fx.visible = false;
ed.renderLayers();
{
    const r = await ed.encodeComposite({ forRun: true }, { hash: false });
    if (!r || !(r.stack >= 2)) throw new Error("without the filter the matched document was not written from the stack: " + JSON.stringify(r && { stack: r.stack, program: r.program }));
    const a = (await decode(r.blob)).data, b = await flatten();
    out.plainStack = inBox(a, b);
    if (out.plainStack.max > 16 || out.plainStack.mean > 2) throw new Error("the plain matched stack moved too far from the whole flatten: " + JSON.stringify(out.plainStack));
    // and the PSD's merged picture comes the same way
    const psd = await ed.exportLayeredBands("psd");
    if (!psd || psd.layers !== 3) throw new Error("the PSD of the matched stack: " + JSON.stringify(psd && { layers: psd.layers }));
    out.psdMB = +(psd.blob.size / 1048576).toFixed(1);
}
fx.visible = true;
ed.renderLayers();
// the filter below the matched layer: turned away (its statistics would need the filtered picture), the whole flatten as before
await run("move_layer", { doc: window.__ex, layer: fx.id, delta: -1 });
if (ed.layers.indexOf(fx) !== ed.layers.indexOf(l) - 1) throw new Error("the filter did not move below the matched layer: " + ed.layers.map((x) => x.name));
const below = ed.stackPlan({ forRun: true, filters: true }), bpBelow = ed.bandPlan({ forRun: true });
const rBelow = await ed.encodeComposite({ forRun: true }, { hash: false });
await run("move_layer", { doc: window.__ex, layer: fx.id, delta: 1 });
if (below || bpBelow || rBelow) throw new Error("a matched layer above a filter still took the worker path: " + JSON.stringify({ plan: !!below, bandPlan: bpBelow, encoded: !!rBelow }));
// the A/B switch
E.stackMatch = false;
let off;
try { off = ed.stackPlan({ forRun: true, filters: true }); } finally { E.stackMatch = true; }
if (off) throw new Error("stackMatch = false still gave a plan");
} finally {
    // the steps after this one expect the document as it was: unmatched, the filter on top, nothing selected
    l.match = { strength: 0, source: "surroundings" };
    ed.markMatchChanged(l);
    fx.visible = true;
    if (ed.layers.indexOf(fx) !== ed.layers.length - 1) await run("move_layer", { doc: window.__ex, layer: fx.id, to: "top" });
    for (const x of ed.layers.filter((y) => y.name === "Second")) ed.removeLayer(x.id);
    ed.renderLayers();
    await run("select_none", { doc: window.__ex });
}
if (ed.layers.indexOf(fx) !== ed.layers.length - 1) throw new Error("the filter layer is not back on top: " + ed.layers.map((x) => x.name));
return out;
"""),
    ("stack_points_gathers_the_samples_it_names", """
// B item 7 part 3: the samples a matched layer's statistics are made from (`stackSamples`, worker job `stack_points`),
// byte for byte against the tiles read here: the integer grid, the layer's own samples through its mask (hanging over
// the picture's bottom edge: those count, as the flatten's statistics count the whole layer), and the composite below
// with a lower matched layer's match in it, in multiply at 70 % (the same kernels on this thread, in the same order).
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const K = await import("./editor/px/kernels.js");
const W = 1400, H = 700;
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const base = mk(W, H), bx = base.getContext("2d");
const g = bx.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#c04020"); g.addColorStop(1, "#2040c0"); bx.fillStyle = g; bx.fillRect(0, 0, W, H);
Object.defineProperty(base, "naturalWidth", { value: W }); Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "stack_points.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
const L = ed.pixels.Layer, M = ed.pixels.Mask;
const lc = mk(700, 400), lx = lc.getContext("2d");
for (let y = 0; y < 400; y++) { lx.fillStyle = `rgba(${(y * 7) % 256},${(y * 3) % 256},${200 - (y % 100)},${0.3 + (y % 5) * 0.14})`; lx.fillRect(0, y, 700, 1); }
const lower = ed.addLayer({ name: "Lower", kind: "result", px: L.fromCanvas(lc), x: 300, y: 150, w: 700, h: 400, dirty: true });
lower.blend = "multiply"; lower.opacity = 0.7; lower.match = { strength: 100, source: "surroundings" };
const uc = mk(1000, 300), ux = uc.getContext("2d");
for (let x = 0; x < 1000; x++) { ux.fillStyle = `rgb(${(x * 13) % 256},${(x * 29) % 256},${(x * 7) % 256})`; ux.fillRect(x, 0, 1, 300); }
ux.clearRect(0, 100, 1000, 20);
const mc = mk(1000, 300), mx = mc.getContext("2d");
for (let y = 0; y < 300; y += 2) { mx.fillStyle = `rgba(255,255,255,${(y % 3) === 0 ? 1 : 0.5})`; mx.fillRect(0, y, 1000, 1); }
const upper = ed.addLayer({ name: "Upper", kind: "result", px: L.fromCanvas(uc), x: 200, y: 500, w: 1000, h: 300, dirty: true });
upper.maskPx = M.fromCanvas(mc); upper.maskDirty = true;
upper.match = { strength: 100, source: "underneath" };
ed.renderLayers(); ed.draw();
await ed.mipsSettled();
const plan = ed.stackPlan({ forRun: true });
if (!plan || plan.length !== 3 || plan[1].match !== lower || plan[2].match !== upper) throw new Error("the plan is " + JSON.stringify(plan && plan.map((s) => (s.match ? "m" : "l"))));
const held = await ed.holdStack(plan, { forRun: true });
let out;
try {
    if (!held.stores[1].match || !held.stores[2].match) throw new Error("a matched layer got no parameters: " + JSON.stringify([!!held.stores[1].match, !!held.stores[2].match]));
    const s = await ed.stackSamples(held.stores[2], held.stores.slice(0, 2), {});
    const { g: geo, xs, ys, ld, bd } = s;
    let gridOk = xs.length === geo.pw && ys.length === geo.ph;
    for (let i = 0; i < geo.pw && gridOk; i++) if (xs[i] !== upper.x + Math.floor(((2 * (i - geo.pad) + 1) * upper.w) / (2 * geo.sw))) gridOk = false;
    for (let j = 0; j < geo.ph && gridOk; j++) if (ys[j] !== upper.y + Math.floor(((2 * (j - geo.pad) + 1) * upper.h) / (2 * geo.sh))) gridOk = false;
    if (!gridOk) throw new Error("the grid is not the integer grid: " + JSON.stringify({ pw: geo.pw, ph: geo.ph, pad: geo.pad, x0: xs[0], y0: ys[0] }));
    const n = geo.pw * geo.ph;
    const at = (x0, y0, w, h, X, Y) => { const i = X - x0, j = Y - y0; return i >= 0 && j >= 0 && i < w && j < h ? (j * w + i) * 4 : -1; };
    const baseD = ed.basePx.readRect(0, 0, W, H).data, lowD = lower.px.readRect(0, 0, 700, 400).data, upD = upper.px.readRect(0, 0, 1000, 300).data, mD = upper.maskPx.readRect(0, 0, 1000, 300).data;
    const bel = new Uint8Array(n * 4), low = new Uint8Array(n * 4), lay = new Uint8Array(n * 4);
    let outside = 0, masked = 0;
    for (let j = 0; j < geo.ph; j++) for (let i = 0; i < geo.pw; i++) {
        const X = xs[i], Y = ys[j], o = (j * geo.pw + i) * 4;
        const inImage = X >= 0 && Y >= 0 && X < W && Y < H;
        let k = inImage ? at(0, 0, W, H, X, Y) : -1;
        if (k >= 0) { bel[o] = baseD[k]; bel[o + 1] = baseD[k + 1]; bel[o + 2] = baseD[k + 2]; bel[o + 3] = baseD[k + 3]; }
        k = inImage ? at(300, 150, 700, 400, X, Y) : -1;
        if (k >= 0) { low[o] = lowD[k]; low[o + 1] = lowD[k + 1]; low[o + 2] = lowD[k + 2]; low[o + 3] = lowD[k + 3]; }
        k = at(200, 500, 1000, 300, X, Y);
        if (k >= 0) { lay[o] = upD[k]; lay[o + 1] = upD[k + 1]; lay[o + 2] = upD[k + 2]; const t = upD[k + 3] * mD[k + 3] + 128; lay[o + 3] = (t + (t >> 8)) >> 8; if (Y >= H && lay[o + 3]) outside++; if (mD[k + 3] && mD[k + 3] < 255) masked++; }
    }
    const lowPlain = low.slice();
    K.matchPixels(low, held.stores[1].match);
    K.compositeTile(bel, [low], [K.OPS.multiply], [Math.round(0.7 * 255)], [null]);
    const eq = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i; return -1; };
    const dl = eq(lay, ld), db = eq(bel, bd);
    if (!(outside > 100) || !(masked > 100)) throw new Error("the layer's samples below the picture's edge or through the half mask were not seen: " + JSON.stringify({ outside, masked }));
    if (dl >= 0) throw new Error("the layer's samples differ from the tiles at byte " + dl + ": " + [lay[dl], ld[dl]]);
    if (db >= 0) throw new Error("the composite below differs from the tiles at byte " + db + ": " + [bel[db], bd[db]]);
    // the lower layer's match is in the backdrop: composited unmatched, many bytes differ
    const belPlain = new Uint8Array(n * 4);
    for (let j = 0; j < geo.ph; j++) for (let i = 0; i < geo.pw; i++) { const X = xs[i], Y = ys[j], o = (j * geo.pw + i) * 4; const k = X >= 0 && Y >= 0 && X < W && Y < H ? (Y * W + X) * 4 : -1; if (k >= 0) { belPlain[o] = baseD[k]; belPlain[o + 1] = baseD[k + 1]; belPlain[o + 2] = baseD[k + 2]; belPlain[o + 3] = baseD[k + 3]; } }
    K.compositeTile(belPlain, [lowPlain], [K.OPS.multiply], [Math.round(0.7 * 255)], [null]);
    let differ = 0;
    for (let i = 0; i < n * 4; i++) if (Math.abs(belPlain[i] - bd[i]) > 2) differ++;
    if (differ < n / 20) throw new Error("the lower layer's match is not in the backdrop samples (" + differ + " bytes differ from the unmatched composite)");
    out = { grid: [geo.pw, geo.ph], pad: geo.pad, outside, masked, lowerMatchDiffers: differ };
} finally { held.release(); }
await run("close_document", { doc: d.id, force: true });
return out;
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
    ("layered_files_from_rows", """
// E4: PSD and ORA written from the layers' tiles and the composite's bands, against the canvas writers
// (inpaint_export.js): the same structure, the same layer records, the same pixels.
const ed = ednow(window.__ex);
const E = Editor(ed);
const X = await import("./editor/inpaint_export.js");
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const i32 = (b, o) => u32(b, o) | 0;
const unpack = (b, o, lens, w) => {   // PackBits rows -> one plane
    const out = new Uint8Array(lens.length * w);
    lens.forEach((len, y) => {
        let p = o, q = y * w;
        const end = o + len;
        while (p < end) { const n = b[p++]; if (n < 128) { for (let k = 0; k <= n; k++) out[q++] = b[p++]; } else if (n > 128) { const v = b[p++]; for (let k = 0; k < 257 - n; k++) out[q++] = v; } }
        if (q !== (y + 1) * w) throw new Error("a PackBits row of " + (q - y * w) + " pixels for " + w);
        o = end;
    });
    return { plane: out, end: o };
};
const parsePsd = (b) => {
    if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== "8BPS") throw new Error("not a PSD");
    const H = u32(b, 14), W = u32(b, 18);
    let o = 26;
    o += 4 + u32(b, o);            // colour mode data
    o += 4 + u32(b, o);            // image resources
    const lmEnd = o + 4 + u32(b, o);
    o += 4;
    o += 4;                        // layer info length
    const count = u16(b, o); o += 2;
    const layers = [];
    for (let i = 0; i < count; i++) {
        const top = i32(b, o), left = i32(b, o + 4), bottom = i32(b, o + 8), right = i32(b, o + 12); o += 16;
        const nch = u16(b, o); o += 2;
        const channels = [];
        for (let c = 0; c < nch; c++) { channels.push([(u16(b, o) << 16) >> 16, u32(b, o + 2)]); o += 6; }
        const blend = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]), opacity = b[o + 8], flags = b[o + 10]; o += 12;
        const extra = u32(b, o); o += 4;
        const nameLen = b[o + 8];
        const name = String.fromCharCode(...b.subarray(o + 9, o + 9 + nameLen));
        o += extra;
        layers.push({ rect: [left, top, right, bottom], channels, blend, opacity, flags, name });
    }
    for (const L of layers) {
        const w = L.rect[2] - L.rect[0], h = L.rect[3] - L.rect[1];
        L.planes = {};
        for (const [id, len] of L.channels) {
            if (u16(b, o) !== 1) throw new Error("a channel that is not PackBits");
            const lens = []; for (let y = 0; y < h; y++) lens.push(u16(b, o + 2 + y * 2));
            const r = unpack(b, o + 2 + 2 * h, lens, w);
            if (r.end !== o + len) throw new Error(`layer ${L.name} channel ${id}: the record says ${len} bytes, the rows are ${r.end - o}`);
            L.planes[id] = r.plane;
            o = r.end;
        }
    }
    o = lmEnd;
    if (u16(b, o) !== 1) throw new Error("the merged image is not PackBits");
    const lens = []; for (let y = 0; y < 3 * H; y++) lens.push(u16(b, o + 2 + y * 2));
    const merged = unpack(b, o + 2 + 6 * H, lens, W);
    if (merged.end !== b.length) throw new Error("bytes left after the merged image: " + (b.length - merged.end));
    return { W, H, layers, merged: merged.plane };
};
const worstOf = (a, b) => { if (a.length !== b.length) return Infinity; let w = 0, n = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { n++; if (d > w) w = d; } } return [w, n]; };
const out = {};
// -- PSD --
let t0 = performance.now();
const mine = await ed.exportLayeredBands("psd");
if (!mine) throw new Error("exportLayeredBands gave nothing");
out.psdMs = Math.round(performance.now() - t0);
t0 = performance.now();
const { layers } = ed.exportLayerStack();
const flat = ed.flattenToCanvas({ forRun: true });
const oldBlob = X.buildPsd({ width: ed.width, height: ed.height, layers, composite: flat });
out.psdOldMs = Math.round(performance.now() - t0);
const a = parsePsd(new Uint8Array(await mine.blob.arrayBuffer())), b = parsePsd(new Uint8Array(await oldBlob.arrayBuffer()));
if (a.W !== b.W || a.H !== b.H || a.layers.length !== b.layers.length) throw new Error("the PSDs differ in size or layer count");
out.psd = [];
a.layers.forEach((L, i) => {
    const M = b.layers[i];
    for (const k of ["rect", "blend", "opacity", "flags", "name"]) if (JSON.stringify(L[k]) !== JSON.stringify(M[k])) throw new Error(`layer ${i} ${k}: ${JSON.stringify(L[k])} against ${JSON.stringify(M[k])}`);
    const row = { name: L.name };
    for (const id of [-1, 0, 1, 2]) {
        const [worst, n] = worstOf(L.planes[id], M.planes[id]);
        row[id] = [worst, n];
        // the canvas writers read a GPU canvas, whose first read un-premultiplies a few hundred (value, alpha) pairs one
        // level differently from the tiles' own bytes (inpaint_tiles.js, roundTripTable); alpha itself is exact
        if (worst > (id === -1 ? 0 : 1)) throw new Error(`layer ${L.name} channel ${id} is ${worst} levels off the canvas writer's on ${n} bytes`);
    }
    out.psd.push(row);
});
const [mw, mn] = worstOf(a.merged, b.merged);
out.psdMerged = [mw, mn];
if (mw > 1) throw new Error("the PSD's merged image is " + mw + " levels off on " + mn + " bytes");
// -- ORA --
t0 = performance.now();
const ora = await ed.exportLayeredBands("ora");
out.oraMs = Math.round(performance.now() - t0);
const z = new Uint8Array(await ora.blob.arrayBuffer());
const le32 = (o) => (z[o] | (z[o + 1] << 8) | (z[o + 2] << 16) | (z[o + 3] << 24)) >>> 0, le16 = (o) => z[o] | (z[o + 1] << 8);
let eo = z.length - 22;
if (le32(eo) !== 0x06054b50) throw new Error("no end of central directory");
const n = le16(eo + 10);
let co = le32(eo + 16);
const files = {};
for (let i = 0; i < n; i++) {
    if (le32(co) !== 0x02014b50) throw new Error("central entry " + i);
    const crc = le32(co + 16), size = le32(co + 20), nl = le16(co + 28), lo = le32(co + 42);
    const name = new TextDecoder().decode(z.subarray(co + 46, co + 46 + nl));
    if (le32(lo) !== 0x04034b50) throw new Error("local header of " + name);
    const data = z.subarray(lo + 30 + le16(lo + 26) + le16(lo + 28), lo + 30 + le16(lo + 26) + le16(lo + 28) + size);
    if (PNG.crc32(data) !== crc) throw new Error("the CRC of " + name + " is wrong");
    files[name] = data;
    co += 46 + nl;
}
if (new TextDecoder().decode(files.mimetype) !== "image/openraster" || Object.keys(files)[0] !== "mimetype") throw new Error("mimetype is not the first entry");
const xml = new TextDecoder().decode(files["stack.xml"]);
const srcs = Array.from(xml.matchAll(/src="([^"]+)"/g)).map((m) => m[1]);
if (srcs.length !== a.layers.length) throw new Error("stack.xml names " + srcs.length + " layers");
out.ora = [];
for (let i = 0; i < srcs.length; i++) {
    const L = a.layers[a.layers.length - 1 - i];   // top first
    const img = await decode(new Blob([files[srcs[i]]]));
    const w = L.rect[2] - L.rect[0];
    if (img.width !== w || img.height !== L.rect[3] - L.rect[1]) throw new Error(srcs[i] + " is " + img.width + " x " + img.height);
    let worst = 0;
    for (let p = 0; p < img.width * img.height; p++) for (const [id, c] of [[0, 0], [1, 1], [2, 2], [-1, 3]]) { const d = Math.abs(img.data[p * 4 + c] - L.planes[id][p]); if (d > worst) worst = d; }
    out.ora.push([srcs[i], worst]);
    if (worst) throw new Error(srcs[i] + " differs from the PSD's layer " + L.name + " by " + worst);
}
const merged = await decode(new Blob([files["mergedimage.png"]]));
let mworst = 0;
for (let p = 0; p < merged.width * merged.height; p++) for (let c = 0; c < 3; c++) { const d = Math.abs(merged.data[p * 4 + c] - a.merged[c * ed.width * ed.height + p]); if (d > mworst) mworst = d; }
if (mworst) throw new Error("mergedimage.png differs from the PSD's merged image by " + mworst);
if (!files["Thumbnails/thumbnail.png"]) throw new Error("no thumbnail");
const th = await decode(new Blob([files["Thumbnails/thumbnail.png"]]));
out.thumbnail = [th.width, th.height];
for (const L of layers) { L.canvas.width = 1; L.canvas.height = 1; }
flat.width = 1; flat.height = 1;
return out;
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
    ("a_plain_stack_is_composited_by_the_workers", """
// B item 1 (docs/PLAN_BCE.md 3b): no filter, no blend mode, no match: the workers composite the rows from the arena.
// A layer with soft alpha at 60 %, a masked one off the tile grid, a sparse one hanging over two edges of the picture.
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const E = Editor(ed);
const W = 3100, H = 2050;
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const paint = (c, hue) => { const x = c.getContext("2d"); const g = x.createLinearGradient(0, 0, c.width, c.height); g.addColorStop(0, `hsl(${hue},70%,45%)`); g.addColorStop(1, `hsl(${(hue + 120) % 360},80%,30%)`); x.fillStyle = g; x.fillRect(0, 0, c.width, c.height); return c; };
const base = paint(mk(W, H), 200);
Object.defineProperty(base, "naturalWidth", { value: W });
Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "export_stack.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
const L = ed.pixels.Layer, M = ed.pixels.Mask;
{
    const c = mk(W, H), x = c.getContext("2d");
    for (let k = 0; k < 30; k++) { x.fillStyle = `hsla(${k * 47},75%,55%,${0.15 + (k % 6) * 0.15})`; x.fillRect((k * 811) % W, (k * 457) % H, W / 7, H / 7); }
    ed.addLayer({ name: "Soft", kind: "paint", px: L.fromCanvas(c), x: 0, y: 0, w: W, h: H, dirty: true }).opacity = 0.6;
}
{
    const w = 1111, h = 777;
    const m = mk(w, h), mx = m.getContext("2d");
    const g = mx.createRadialGradient(w / 2, h / 2, 20, w / 2, h / 2, w / 2);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(1, "rgba(255,255,255,0)");
    mx.fillStyle = g; mx.fillRect(0, 0, w, h);
    const l = ed.addLayer({ name: "Masked", kind: "result", px: L.fromCanvas(paint(mk(w, h), 20)), x: 701, y: 333, w, h, dirty: true });
    l.maskPx = M.fromCanvas(m); l.maskDirty = true;
}
{
    const w = 900, h = 600, c = mk(w, h), x = c.getContext("2d");
    x.fillStyle = "#30e080"; x.beginPath(); x.arc(450, 300, 280, 0, Math.PI * 2); x.fill();
    ed.addLayer({ name: "Over the corner", kind: "paint", px: L.fromCanvas(c), x: W - 500, y: H - 310, w, h, dirty: true }).opacity = 0.85;
    const c2 = mk(400, 300); c2.getContext("2d").fillStyle = "rgba(240,40,40,0.5)"; c2.getContext("2d").fillRect(0, 0, 400, 300);
    ed.addLayer({ name: "Over the origin", kind: "paint", px: L.fromCanvas(c2), x: -150, y: -120, w: 400, h: 300, dirty: true });
}
ed.renderLayers(); ed.fitView(); ed.draw();
await ed.mipsSettled();
const plan = ed.stackPlan({ forRun: true });
if (!plan || plan.length !== 5) throw new Error("the stack plan of a plain document is " + JSON.stringify(plan && plan.length));
const r = await ed.encodeComposite({ forRun: true }, { hash: true });
if (!r || r.stack !== 4) throw new Error("the composite was not written from the stack: " + JSON.stringify(r && { stack: r.stack }));
const flat = ed.flattenToCanvas({ forRun: true });
const old = await E.parts.encodeCanvas(flat, { hash: false });
flat.width = 1; flat.height = 1;
const a = await decode(r.blob), b = await decode(old.blob);
const dd = diff(a.data, b.data, W);
// Integer premultiplied maths in the worker against Skia's floats on a GPU canvas, rounded once per layer. Measured per
// layer kind: the same bytes for an opaque layer at an opacity, a masked one and a flat half-transparent one, one level
// on 3 to 10 % of the bytes under soft alpha, never two; a GPU and a CPU canvas of the same stack differ by more (two
// levels on some bytes of a single layer). Four partial layers over each other here: two levels on a few bytes.
const twos = (() => { let n = 0; for (let i = 0; i < a.data.length; i++) if (Math.abs(a.data[i] - b.data[i]) > 1) n++; return n; })();
if (dd.bytes < 0 || dd.worst > 2 || twos > a.data.length / 1000) throw new Error("the stack composited by the workers differs from the flatten: " + JSON.stringify({ dd, twos }));
// the same through the bands of the region pass, which the stack replaced
E.stacks = false;
let viaBands;
try { viaBands = await ed.encodeComposite({ forRun: true }, { hash: false }); } finally { E.stacks = true; }
if (!viaBands || viaBands.stack != null) throw new Error("with stacks off the composite still came from the stack");
const db = diff(a.data, (await decode(viaBands.blob)).data, W);
if (db.bytes < 0 || db.worst > 2) throw new Error("the stack differs from the bands: " + JSON.stringify(db));
// a PSD's merged picture comes the same way, and the file is whole
const psd = await ed.exportLayeredBands("psd");
if (!psd || psd.layers !== 5) throw new Error("the PSD of the plain stack: " + JSON.stringify(psd && { layers: psd.layers }));
// what the stack cannot draw falls back: a filter layer, a blend mode the kernel does not know
ed.layers[0].blend = "no-such-mode";
const p2 = ed.stackPlan({ forRun: true });
ed.layers[0].blend = "normal";
const fx = ed.addFilterLayer("levels");
const p3 = ed.stackPlan({ forRun: true });
ed.removeLayer(fx.id);
if (p2 || p3) throw new Error("an unknown blend mode or a filter layer still gave a stack plan");
window.__exStack = d.id;
return { flatten: dd, twos, bands: db, fraction: +(dd.bytes / a.data.length).toFixed(5), psdMB: +(psd.blob.size / 1048576).toFixed(1) };
"""),
    ("blend_modes_are_composited_by_the_workers", """
// B item 7, part 1: the eight blend modes in `composite_tile`. The same document, every layer in the mode, against the
// flatten (the compositor's shader in floats, rounded once per layer) and against the bands of the region pass.
const ed = ednow(window.__exStack);
host.shell.activate(ed);
const E = Editor(ed);
const W = ed.width;
const out = {};
let worstOf = 0;
for (const mode of ["multiply", "screen", "overlay", "darken", "lighten", "soft-light", "hard-light", "difference"]) {
    for (const l of ed.layers) l.blend = mode;
    ed.renderLayers();
    const plan = ed.stackPlan({ forRun: true });
    if (!plan || plan.length !== 5 || plan.slice(1).some((s) => !(s.op >= 5))) throw new Error(mode + ": the stack plan is " + JSON.stringify(plan && plan.map((s) => s.op)));
    const r = await ed.encodeComposite({ forRun: true }, { hash: false });
    if (!r || r.stack !== 4) throw new Error(mode + ": the composite was not written from the stack");
    const flat = ed.flattenToCanvas({ forRun: true });
    const old = await E.parts.encodeCanvas(flat, { hash: false });
    flat.width = 1; flat.height = 1;
    const a = await decode(r.blob), b = await decode(old.blob);
    let worst = 0, over2 = 0, sum = 0;
    for (let i = 0; i < a.data.length; i++) { const e = Math.abs(a.data[i] - b.data[i]); if (e > worst) worst = e; if (e > 2) over2++; sum += e; }
    out[mode] = { worst, over2, mean: +(sum / a.data.length).toFixed(4) };
    worstOf = Math.max(worstOf, worst);
    // and the mode is really drawn: the picture is not the one of normal layers
    if (mode === "multiply") {
        for (const l of ed.layers) l.blend = "normal";
        const n = await decode((await ed.encodeComposite({ forRun: true }, { hash: false })).blob);
        let differs = 0;
        for (let i = 0; i < a.data.length; i += 4) if (Math.abs(a.data[i] - n.data[i]) > 8) differs++;
        if (differs < a.data.length / 40) throw new Error("multiply gave the picture of normal layers");
    }
}
for (const l of ed.layers) l.blend = "normal";
// four layers over each other in one mode, each rounded to 8 bits on both sides. Measured: two levels at most in five modes; three levels on
// 66 to 382 of 25 million bytes in overlay, soft-light and hard-light, whose B has a slope of 2 to 4 (an error below it is doubled)
const bad = Object.entries(out).filter(([, v]) => v.worst > 3 || v.over2 > W * ed.height * 4 / 10000);
if (bad.length) throw new Error("a blend mode composited by the workers differs from the flatten: " + JSON.stringify(out));
// with the blends switched off the plan turns the document away again (the A/B switch of the benchmark)
ed.layers[0].blend = "screen";
E.stackBlends = false;
let off;
try { off = ed.stackPlan({ forRun: true }); } finally { E.stackBlends = true; ed.layers[0].blend = "normal"; }
if (off) throw new Error("stackBlends = false still gave a plan");
await run("close_document", { doc: window.__exStack, force: true });
window.__exStack = null;
return out;
"""),
    ("a_stack_program_runs_filters_between_the_layers", """
// B item 7 part 2 (docs/PLAN_BCE.md 3b): filter layers in an otherwise plain stack. The workers composite what is below
// a filter into a shared buffer, the GPU filters those bytes, and what is above goes over the result in the workers
// again. Here: a soft layer, a levels layer, a masked layer above it, a blur at 70 % in screen through a mask of its
// own (so its result is composited over its input by the workers), a multiplied layer over the corner, grain on top.
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const E = Editor(ed);
const W = 3100, H = 2050;
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const paint = (c, hue) => { const x = c.getContext("2d"); const g = x.createLinearGradient(0, 0, c.width, c.height); g.addColorStop(0, `hsl(${hue},70%,45%)`); g.addColorStop(1, `hsl(${(hue + 120) % 360},80%,30%)`); x.fillStyle = g; x.fillRect(0, 0, c.width, c.height); return c; };
const base = paint(mk(W, H), 200);
Object.defineProperty(base, "naturalWidth", { value: W });
Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "export_program.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
const L = ed.pixels.Layer, M = ed.pixels.Mask;
{
    const c = mk(W, H), x = c.getContext("2d");
    for (let k = 0; k < 30; k++) { x.fillStyle = `hsla(${k * 47},75%,55%,${0.15 + (k % 6) * 0.15})`; x.fillRect((k * 811) % W, (k * 457) % H, W / 7, H / 7); }
    ed.addLayer({ name: "Soft", kind: "paint", px: L.fromCanvas(c), x: 0, y: 0, w: W, h: H, dirty: true }).opacity = 0.6;
}
const levels = ed.addFilterLayer("levels");
levels.params.gamma = 1.3; ed.markFilterChanged(levels);
{
    const w = 1111, h = 777;
    const m = mk(w, h), mx = m.getContext("2d");
    const g = mx.createRadialGradient(w / 2, h / 2, 20, w / 2, h / 2, w / 2);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(1, "rgba(255,255,255,0)");
    mx.fillStyle = g; mx.fillRect(0, 0, w, h);
    const l = ed.addLayer({ name: "Masked", kind: "result", px: L.fromCanvas(paint(mk(w, h), 20)), x: 701, y: 333, w, h, dirty: true });
    l.maskPx = M.fromCanvas(m); l.maskDirty = true;
}
const blur = ed.addFilterLayer("blur");
blur.params.radius = 5; blur.opacity = 0.7; blur.blend = "screen";
{
    const m = mk(W, H), mx = m.getContext("2d");
    const g = mx.createRadialGradient(W * 0.4, H * 0.5, 100, W * 0.4, H * 0.5, W * 0.45);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(1, "rgba(255,255,255,0)");
    mx.fillStyle = g; mx.fillRect(0, 0, W, H);
    blur.maskPx = M.fromCanvas(m); blur.maskDirty = true;
}
ed.markFilterChanged(blur);
{
    const w = 900, h = 600, c = mk(w, h), x = c.getContext("2d");
    x.fillStyle = "#30e080"; x.beginPath(); x.arc(450, 300, 280, 0, Math.PI * 2); x.fill();
    const l = ed.addLayer({ name: "Over the corner", kind: "paint", px: L.fromCanvas(c), x: W - 500, y: H - 310, w, h, dirty: true });
    l.opacity = 0.85; l.blend = "multiply";
}
const grain = ed.addFilterLayer("grain");
ed.renderLayers(); ed.fitView(); ed.draw();
await ed.mipsSettled();
const plan = ed.stackPlan({ forRun: true, filters: true });
const kinds = plan && plan.map((s) => (s.filter ? "f" : "l")).join("");
if (kinds !== "llflflf") throw new Error("the stack plan with filters is " + JSON.stringify(kinds));
if (ed.stackPlan({ forRun: true })) throw new Error("without `filters` a filter layer still gave a plan");
const reach = plan.reduce((n, s) => n + (s.reach || 0), 0);
if (!(reach >= 15)) throw new Error("the blur's reach is not in the plan: " + reach);
const r = await ed.encodeComposite({ forRun: true }, {});
if (!r || !(r.program > 0)) throw new Error("the composite did not come from the stack program: " + JSON.stringify(r && { program: r.program }));
E.stackFilters = false;
let viaPass;
try { viaPass = await ed.encodeComposite({ forRun: true }, {}); } finally { E.stackFilters = true; }
if (!viaPass || viaPass.program) throw new Error("with stackFilters off the bands still came from the program");
const flat = ed.flattenToCanvas({ forRun: true });
const old = await E.parts.encodeCanvas(flat, {});
flat.width = 1; flat.height = 1;
const a = await decode(r.blob), p = await decode(viaPass.blob), b = await decode(old.blob);
const stats = (x, y) => { let worst = 0, over2 = 0, sum = 0; for (let i = 0; i < x.length; i++) { const e = Math.abs(x[i] - y[i]); if (e > worst) worst = e; if (e > 2) over2++; sum += e; } return { worst, over2, mean: +(sum / x.length).toFixed(4) }; };
const out = { program: r.program, reach, againstFlatten: stats(a.data, b.data), againstPass: stats(a.data, p.data), passAgainstFlatten: stats(p.data, b.data), seams: seamRows(a.data, b.data, W, H) };
// every layer of the program is in the picture: without the mask of the blur, the multiplied corner or the grain it is another one
const probe = async (layer, change, undo, what) => {
    await run("set_layer", { doc: d.id, layer: layer.id, ...change });
    const q = await decode((await ed.encodeComposite({ forRun: true }, {})).blob);
    await run("set_layer", { doc: d.id, layer: layer.id, ...undo });
    let moved = 0;
    for (let i = 0; i < q.data.length; i += 4) if (Math.abs(q.data[i] - a.data[i]) > 3 || Math.abs(q.data[i + 1] - a.data[i + 1]) > 3) moved++;
    out[what] = moved;
    if (moved < 2000) throw new Error(what + " is not in the program's picture: " + moved + " pixels moved");
};
const cornerLayer = ed.layers.find((l) => l.name === "Over the corner");
await probe(cornerLayer, { visible: false }, { visible: true }, "theLayerAboveTheFilters");
await probe(blur, { opacity: 0.05 }, { opacity: 0.7 }, "theBlurAtItsOpacity");
await probe(grain, { visible: false }, { visible: true }, "theGrainOnTop");
// Measured against the flatten: 4 levels at most, more than 2 on 1,872 of 25 million bytes, mean 0.24; the region pass
// is within 2 (mean 0.004). Taken apart (one variant at a time): the layers and the plain filters leave 4 % of the bytes
// a level apart (the kernel's soft alpha, B item 1), a blur 3 levels as in every band (Skia's blur of another canvas),
// and the blur at 70 % through its mask 18 %: the kernel rounds the blend and then the mask's coverage, the canvas
// multiplies the two alphas first. More than 4 levels, or more than 2 on 0.02 % of the bytes, is a bug.
if (out.againstFlatten.worst > 4 || out.againstFlatten.over2 > a.data.length / 5000 || out.againstFlatten.mean > 0.3) throw new Error("the stack program differs from the flatten: " + JSON.stringify(out));
if (out.seams.rows > 64 && out.seams.nearSeams === out.seams.rows) throw new Error("the program's differences sit on the band seams only: " + JSON.stringify(out.seams));
// a PSD's merged picture comes the same way, and a flatten writes its new base from the program's bands
const psd = await ed.exportLayeredBands("psd");
if (!psd) throw new Error("no PSD of the document with filters");
await run("close_document", { doc: d.id, force: true });
return out;
"""),
    ("close", """
const id = window.__ex;
window.__exRef = null;
await run("close_document", { doc: id, force: true });
return { closed: id };
"""),
]

# python tools/export_test.py --perf 15000x10000: the timings of a large document (printed, not gated)
PERF = """
const [W, H] = [__W__, __H__];
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const E = Editor(ed);
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const L = ed.pixels.Layer;
{
    const c = mk(W, H), x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, "hsl(210,70%,45%)"); g.addColorStop(1, "hsl(300,70%,25%)");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    x.globalAlpha = 0.7;
    for (let i = 0; i < 60; i++) { x.fillStyle = `hsl(${(i * 37) % 360},80%,55%)`; x.beginPath(); x.arc((i * 977) % W, (i * 613) % H, W / 40, 0, 7); x.fill(); }
    Object.defineProperty(c, "naturalWidth", { value: W }); Object.defineProperty(c, "naturalHeight", { value: H });
    await ed.setBase({ filename: "export_perf.png", subfolder: "inpaint_canvas", type: "input" }, c, { keepLayers: false });
    c.width = 1; c.height = 1;
}
for (let i = 0; i < 3; i++) {
    const c = mk(W, H), x = c.getContext("2d");
    x.globalAlpha = 0.5;
    x.fillStyle = `hsla(${i * 60},80%,50%,0.35)`; x.fillRect(i * 40, i * 40, W - i * 120, H - i * 120);
    for (let k = 0; k < 20; k++) { x.fillStyle = `hsl(${(k * 53 + i * 90) % 360},70%,60%)`; x.fillRect((k * 811) % W, (k * 457) % H, W / 25, H / 25); }
    ed.addLayer({ name: `Paint ${i + 1}`, kind: "paint", px: L.fromCanvas(c), x: 0, y: 0, w: W, h: H, dirty: true });
    c.width = 1; c.height = 1;
}
{ const { FILTERS } = await import("./editor/inpaint_filters.js"); ed.addFilterLayer(FILTERS[__FILTER__] ? __FILTER__ : "levels"); }
ed.renderLayers(); ed.fitView(); ed.draw();
await ed.mipsSettled();
const timed = async (fn) => {
    let held = 0, last = performance.now(), on = true;
    const beat = () => { const n = performance.now(); held = Math.max(held, n - last); last = n; if (on) setTimeout(beat, 0); };
    setTimeout(beat, 0);
    const t0 = performance.now();
    const r = await fn();
    on = false;
    held = Math.max(held, performance.now() - last);   // a call that never yields is one block
    return { ms: Math.round(performance.now() - t0), blocked: Math.round(held), r };
};
const out = { size: [W, H] };
let readMs = 0, bands = 0;
const readBand = ed.readBand.bind(ed);
ed.readBand = (...args) => { const t = performance.now(); try { return readBand(...args); } finally { readMs += performance.now() - t; bands++; } };
const a = await timed(() => ed.encodeComposite({ forRun: true }, {}));
delete ed.readBand;
out.composite_bands = { ms: a.ms, blocked: a.blocked, bands, readMs: Math.round(readMs), MB: a.r ? +(a.r.blob.size / 1048576).toFixed(1) : null };
const b = await timed(() => E.parts.encodeTilePixels(ed.layers[0].px, { hash: true }));
out.layer_from_tiles = { ms: b.ms, blocked: b.blocked, MB: b.r ? +(b.r.blob.size / 1048576).toFixed(1) : null };
if (W * H <= 268435456) {
    const c = await timed(async () => { const flat = ed.flattenToCanvas({ forRun: true }); const r = await E.parts.encodeCanvas(flat, { hash: true }); flat.width = 1; flat.height = 1; return r; });
    out.composite_canvas = { ms: c.ms, blocked: c.blocked, MB: +(c.r.blob.size / 1048576).toFixed(1) };
    const e = await timed(async () => { const cv = ed.layers[0].px.toCanvas(); const r = await E.parts.encodeCanvas(cv, { hash: true }); cv.width = 1; cv.height = 1; return r; });
    out.layer_canvas = { ms: e.ms, blocked: e.blocked, MB: +(e.r.blob.size / 1048576).toFixed(1) };
}
out.pool = E.parts.pool().stats();
await run("close_document", { doc: d.id, force: true });
return out;
"""

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
    if "--perf" in sys.argv:
        w, h = sys.argv[sys.argv.index("--perf") + 1].lower().split("x")
        res = await c.eval(PRE % (HELPERS, PERF.replace("__W__", w).replace("__H__", h).replace("__FILTER__", json.dumps(next((x.split("=")[1] for x in sys.argv if x.startswith("--filter=")), "levels")))), timeout=1800)
        print(json.dumps(res, indent=1))
        return True
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
            print("[ok] %s: %s" % (name, json.dumps(res)[:1500]))
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
