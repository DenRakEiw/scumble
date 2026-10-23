"""Phase N1 (docs/PLAN_BCE.md §3b): where the time of the rows people feel goes, split by who spends it.

No ComfyUI, no key. Start the app offline and with a debugging port, tiles on (the default):

    ./node_modules/.bin/electron . --remote-debugging-port=9555 --no-comfy
    python tools/native_test.py [15000x10000] [--no-profile] [--json out.json] [--out DIR] [--keep] [--js] [row ...]

N builds nothing: this is a measurement, not a gate, and it always ends with RESULT. Per row it prints

  wall / blocked   the operation on the main thread, and the longest time the window did not answer
  main thread      from a CPU profile of the row (CDP Profiler): idle (waiting for workers, the GPU process, I/O),
                   the garbage collector, natives of the browser by name (getImageData, texSubImage2D, ...),
                   the pixel kernels (px/), and the rest of the JS by file
  boundaries       calls into the browser, counted by wrappers in the window: milliseconds inside the call and the
                   bytes that crossed (Canvas 2D reads, writes and large draws, ImageBitmaps, blobs, messages to
                   workers with their transfers and clones), and the WebGL calls (uploads, readbacks, draws)
  workers          the `timing` parts of every worker job of the row (summed over the workers, so CPU time, not wall):
                   pixel work against the reads and writes of canvases inside the worker
  marks            the window's step marks of the row (inpaint_jobs.js `markStep`, ops tiff_open, export, layered_open,
                   save), one line per run of an op: each step the ms since the op's mark before it (a "start" opens a
                   run), the total from the start to the last mark, and the values the marks carry

The document is a picture written per tile (a diagonal gradient the wand floods as a band, discs, three bits of noise so
the PNG compresses like a photograph), encoded by the pool and opened from that file as a user's file would be. At
15000 x 10000 a full-size paint layer is added; above the canvas limit the paint layer holds a stroke only.

Rows by default: build_the_file, open_the_file, add_the_paint_layer, pan_and_zoom, stroke_and_release, grow_16,
shrink_16, invert, wand_whole_picture, wand_one_disc, provider_crop, export_png, export_psd, export_ora, close. The
export rows keep the file in memory (host.saveExport stubbed out). Naming rows runs those (with build_the_file,
open_the_file and close); these run only when named, at their place in the list:

  match_provider_crop film_provider_crop   after provider_crop: the crop under a matched layer and a film look (B item 7)
  save_png save_psd save_tiff save_ora     after export_ora: a real export through the `export` command into --out DIR
                                           (default a new temp folder), host.saveExport's read, IPC copy and write
                                           included; the file's size in the row (the PSD alone is about 0.9 GB at
                                           15000 x 10000, and its real save ends the renderer there: docs/BUGS.md)
  open_psd open_ora open_tiff              then: load_image of the file the matching save row wrote, into a new tab that
                                           is closed after the row; without that file the PSD / ORA the export row kept
                                           in memory, opened by loadFile; skipped when neither ran
  blend_* filter_* match_*                 last: the document in other states (B item 7)

The save rows' files are deleted at the end unless --keep. Name add_the_paint_layer too for a PSD / ORA with two
layers. --js switches every thread to the JS kernels after build_the_file.
"""
import asyncio
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

ARGS = sys.argv[1:]
PROFILE = "--no-profile" not in ARGS
JSON_OUT = None
if "--json" in ARGS:
    i = ARGS.index("--json")
    JSON_OUT = ARGS[i + 1]
    del ARGS[i:i + 2]
OUT_ARG = None   # the save rows' folder (default a new temp folder)
if "--out" in ARGS:
    i = ARGS.index("--out")
    OUT_ARG = ARGS[i + 1]
    del ARGS[i:i + 2]
KEEP = "--keep" in ARGS   # keep the save rows' files (deleted at the end otherwise)
SIZE = next((a for a in ARGS if "x" in a.lower() and a[0].isdigit()), "15000x10000")
ONLY = [a for a in ARGS if not a[0].isdigit() and not a.startswith("-")]
# a real export into the --out folder (K0a, docs/PLAN_WASM_BUILD.md §4.12): the row's format
SAVE_ROWS = {"save_png": "png", "save_psd": "psd", "save_tiff": "tiff", "save_ora": "ora"}
# the open of a file a save row wrote: the save row it needs
OPEN_ROWS = {"open_psd": ("save_psd", "export_psd"), "open_ora": ("save_ora", "export_ora"), "open_tiff": ("save_tiff",)}
# rows that change the document (B item 7) or write files (K0a): run only when named, after the rows they need
OPT_IN = ("match_provider_crop", "film_provider_crop", *SAVE_ROWS, *OPEN_ROWS, "blend_export_png", "blend_export_psd", "blend_wand", "filter_export_png", "filter_export_psd", "filter_wand", "match_export_png", "match_export_psd", "match_wand")

PROBES = r"""
(() => {
    if (window.__n1) return "probes already in";
    const S = { calls: {} };
    const add = (name, ms, bytes) => { const e = S.calls[name] || (S.calls[name] = { n: 0, ms: 0, bytes: 0 }); e.n++; e.ms += ms; e.bytes += bytes || 0; };
    const dims = (s) => (s ? (s.naturalWidth || s.videoWidth || s.width || 0) * (s.naturalHeight || s.videoHeight || s.height || 0) * 4 : 0);
    const wrap = (proto, name, label, bytesOf) => {
        if (!proto || typeof proto[name] !== "function") return;
        const orig = proto[name];
        const f = { [`__n1_${name}`]: function (...a) {
            const t0 = performance.now();
            let r;
            try { r = orig.apply(this, a); } finally {
                let bytes = 0;
                try { bytes = bytesOf ? bytesOf.call(this, a) : 0; } catch (_) { /* ignore */ }
                const l = typeof label === "function" ? label.call(this, a, bytes) : label;
                add(l, performance.now() - t0, bytes);
                if (r && typeof r.then === "function") { const l2 = l + " (until settled)"; r.then(() => add(l2, performance.now() - t0, 0), () => 0); }
            }
            return r;
        } }[`__n1_${name}`];
        proto[name] = f;
    };
    // what a message to a worker carries: transfers move, everything else is cloned
    const messageBytes = (msg, transfer) => {
        let moved = 0, cloned = 0;
        const t = new Set(transfer || []);
        for (const x of t) moved += x instanceof ArrayBuffer ? x.byteLength : dims(x);
        const seen = new Set();
        const walk = (v, depth) => {
            if (!v || typeof v !== "object" || depth > 4 || seen.has(v)) return;
            seen.add(v);
            if (v instanceof ArrayBuffer) { if (!t.has(v)) cloned += v.byteLength; return; }
            if (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer) return;
            if (ArrayBuffer.isView(v)) { if (!t.has(v.buffer) && !(typeof SharedArrayBuffer !== "undefined" && v.buffer instanceof SharedArrayBuffer)) cloned += v.byteLength; return; }
            if (v instanceof Blob) return;
            if (typeof ImageBitmap !== "undefined" && v instanceof ImageBitmap) { if (!t.has(v)) cloned += dims(v); return; }
            if (Array.isArray(v)) { for (let i = 0; i < v.length && i < 4096; i++) walk(v[i], depth + 1); return; }
            for (const k of Object.keys(v)) walk(v[k], depth + 1);
        };
        walk(msg, 0);
        return { moved, cloned };
    };
    for (const C of [window.CanvasRenderingContext2D, window.OffscreenCanvasRenderingContext2D]) {
        if (!C) continue;
        wrap(C.prototype, "getImageData", "2d getImageData", (a) => Math.abs(a[2] * a[3]) * 4);
        wrap(C.prototype, "putImageData", "2d putImageData", (a) => (a.length >= 7 ? Math.abs(a[5] * a[6]) * 4 : a[0].data.length));
        wrap(C.prototype, "drawImage", (a, bytes) => (bytes >= 4e6 ? "2d drawImage >= 1 MP" : "2d drawImage < 1 MP"), (a) => (a.length >= 9 ? Math.abs(a[3] * a[4]) * 4 : dims(a[0])));
    }
    wrap(window, "createImageBitmap", "createImageBitmap", (a) => (a[0] instanceof Blob ? a[0].size : a.length >= 5 ? Math.abs(a[3] * a[4]) * 4 : a[0] && a[0].data ? a[0].data.length : dims(a[0])));
    if (window.OffscreenCanvas) {
        wrap(OffscreenCanvas.prototype, "transferToImageBitmap", "transferToImageBitmap", function () { return this.width * this.height * 4; });
        wrap(OffscreenCanvas.prototype, "convertToBlob", "convertToBlob", function () { return this.width * this.height * 4; });
    }
    wrap(HTMLCanvasElement.prototype, "toBlob", "canvas toBlob", function () { return this.width * this.height * 4; });
    wrap(HTMLCanvasElement.prototype, "toDataURL", "canvas toDataURL", function () { return this.width * this.height * 4; });
    wrap(Blob.prototype, "arrayBuffer", "blob arrayBuffer", function () { return this.size; });
    {
        const orig = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function __n1_postMessage(msg, transfer) {
            const t0 = performance.now();
            try { return orig.call(this, msg, transfer); } finally {
                const ms = performance.now() - t0;
                const list = Array.isArray(transfer) ? transfer : transfer && transfer.transfer;
                const b = messageBytes(msg, list);
                add("worker postMessage (moved)", b.cloned ? 0 : ms, b.moved);
                if (b.cloned) add("worker postMessage (cloned)", ms, b.cloned);
            }
        };
    }
    const GL = window.WebGL2RenderingContext;
    if (GL) {
        const texBytes = (a) => { const s = a[a.length - 1], s2 = a[a.length - 2]; const v = ArrayBuffer.isView(s) ? s : ArrayBuffer.isView(s2) ? s2 : null; return v ? v.byteLength : dims(s); };
        wrap(GL.prototype, "texImage2D", "gl texImage2D", texBytes);
        wrap(GL.prototype, "texSubImage2D", "gl texSubImage2D", texBytes);
        wrap(GL.prototype, "texSubImage3D", "gl texSubImage3D", texBytes);
        wrap(GL.prototype, "readPixels", "gl readPixels", (a) => Math.abs(a[2] * a[3]) * 4);
        wrap(GL.prototype, "bufferData", "gl bufferData", (a) => (a[1] && a[1].byteLength) || 0);
        wrap(GL.prototype, "drawArrays", "gl draw", null);
        wrap(GL.prototype, "drawElements", "gl draw", null);
        wrap(GL.prototype, "drawArraysInstanced", "gl draw", null);
        wrap(GL.prototype, "finish", "gl finish", null);
        wrap(GL.prototype, "getError", "gl getError", null);
    }
    window.__n1 = {
        reset() { S.calls = {}; },
        read() { const out = {}; for (const [k, v] of Object.entries(S.calls)) out[k] = { n: v.n, ms: +v.ms.toFixed(1), MB: +(v.bytes / 1048576).toFixed(1) }; return out; },
    };
    return "probes in";
})()
"""

PRE = r"""(async () => {
    const commands = window.__cmds.commands, host = window.__host, shell = window.__shell;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const T = await import("./editor/inpaint_tiles.js");
    const A = await import("./editor/inpaint_arena.js");
    const [W, H] = [__W__, __H__];
    const HUGE = W * H > 268e6 || W > 32767 || H > 32767;
    const ed = window.__n1doc ? ednow(window.__n1doc) : null;
    const E = (ed || host.editors()[0]).constructor;
    const FILES = __FILES__;   // the save rows' files by format (null without a save row)
    // the window's step marks (inpaint_jobs.js `markStep`; a build without them has none)
    const stepMarks = () => (typeof E.stepMarks === "function" ? E.stepMarks(true) : []);
    // the marks as durations: per op a list of runs, a "start" opens a run, each step the time since the op's previous
    // mark (a step seen twice in a run sums), total the last mark against the start; the marks' own values in `extra`.
    // A mark of an op with no run open opens one at its time (`nostart`).
    const markRuns = (marks) => {
        const out = {}, open = {};
        for (const { op, step, t, ...more } of marks) {
            let r = open[op];
            if (step === "start" || !r) {
                r = open[op] = { t0: t, last: t, steps: {}, extra: {}, nostart: step !== "start" };
                (out[op] || (out[op] = [])).push(r);
                if (step !== "start") r.steps[step] = 0;
            } else {
                r.steps[step] = +((r.steps[step] || 0) + t - r.last).toFixed(1);
                r.last = t;
            }
            Object.assign(r.extra, more);
        }
        const runOf = (r) => ({ ...r.steps, total: +(r.last - r.t0).toFixed(1), ...(Object.keys(r.extra).length ? { extra: r.extra } : {}), ...(r.nostart ? { nostart: true } : {}) });
        return Object.fromEntries(Object.entries(out).map(([op, runs]) => [op, runs.map(runOf)]));
    };
    // a row: probes, worker timings and step marks reset, the longest block of the main thread, then what the probes saw
    const row = async (fn) => {
        if (ed) { try { await ed.mipsSettled(); } catch (_) { /* ignore */ } }
        await wait(80);
        window.__n1.reset();
        E.jobTimings(true);
        stepMarks();
        let held = 0, last = performance.now(), on = true;
        const beat = () => { const n = performance.now(); held = Math.max(held, n - last); last = n; if (on) setTimeout(beat, 0); };
        setTimeout(beat, 0);
        const t0 = performance.now();
        let extra = null, error = null;
        try { extra = await fn(); } catch (err) { error = String((err && err.message) || err).slice(0, 300); }
        on = false;
        held = Math.max(held, performance.now() - last);
        const wall = performance.now() - t0;
        const calls = window.__n1.read();
        const jobs = {};
        for (const t of E.jobTimings(true)) {
            const key = t.op + (t.kind ? ":" + t.kind : "");
            const j = jobs[key] || (jobs[key] = { jobs: 0 });
            j.jobs++;
            for (const [k, v] of Object.entries(t)) if (typeof v === "number") j[k] = +((j[k] || 0) + v).toFixed(1);
        }
        const marks = markRuns(stepMarks());
        return { wall: Math.round(wall), blocked: Math.round(held), calls, jobs, marks, extra, error, status: ed ? ed.status : null, focused: document.hasFocus(), visibility: document.visibilityState };
    };
    const saveTo = async (format) => {
        let saved = null;
        const was = host.saveExport;
        host.saveExport = async (blob, name) => { saved = { blob, name }; return { path: "memory:" + name }; };
        try { ed.saveFormatSel.value = format; await ed.exportImage({ download: false }); } finally { host.saveExport = was; ed.saveFormatSel.value = "png"; }
        if (!saved) throw new Error("the export saved nothing: " + ed.status);
        (window.__n1kept || (window.__n1kept = {}))[format] = saved.blob;   // an open row's file when its save row did not run
        return { MB: +(saved.blob.size / 1048576).toFixed(1) };
    };
    // a real export into the --out folder through the export command: host.saveExport's read, IPC copy and write included
    const saveFile = async (format) => {
        if (!FILES || !FILES[format]) throw new Error("no --out file for " + format);
        const name = ed.saveNameInput ? ed.saveNameInput.value : null;
        try {
            const r = await run("export", { doc: window.__n1doc, format, path: FILES[format] });
            (window.__n1saved || (window.__n1saved = {}))[format] = true;
            return { MB: +(r.file.bytes / 1048576).toFixed(1), file: r.file.path };
        } finally { ed.saveFormatSel.value = "png"; if (name != null) ed.saveNameInput.value = name; }
    };
    // the file a save row wrote, opened by load_image into a new tab inside the row; the tab is closed after it. Without
    // that file, the blob its export row kept, opened by loadFile (no disk: a real save of the 0.9 GB PSD ends the
    // renderer at 15k, docs/BUGS.md)
    const openFile = async (format) => {
        const fromFile = !!(window.__n1saved && window.__n1saved[format]);
        const kept = window.__n1kept && window.__n1kept[format];
        if (!fromFile && !kept) throw new Error("neither save_" + format + " nor export_" + format + " ran");
        const d = await run("new_document");
        const ed2 = ednow(d.id);
        shell.activate(ed2);
        await wait(300);
        ed2.resizeCanvas();
        try {
            return await row(async () => {
                const t0 = performance.now();
                if (fromFile) await run("load_image", { doc: d.id, path: FILES[format] });
                else await ed2.loadFile(new File([kept], "n1." + (format === "tiff" ? "tif" : format)));
                const loaded = Math.round(performance.now() - t0);
                ed2.fitView(); ed2.draw();
                await ed2.mipsSettled();
                return { loadImageMs: loaded, from: fromFile ? "file" : "blob", size: [ed2.width, ed2.height], layers: ed2.layers.length, status: ed2.status };
            });
        } finally {
            await run("close_document", { doc: d.id, force: true });
            if (ed) shell.activate(ed);
        }
    };
    const rect40 = () => {
        ed.sel.clear();
        ed.sel.fill([Math.round(W * 0.2), Math.round(H * 0.2), Math.round(W * 0.6), Math.round(H * 0.6)], "#ff0000");
        ed.markSelectionChanged();
        ed.getBounds();
    };
    __BODY__
})()"""

ROWS = [
    # name, profiled, body (returns row(...) or a plain object)
    ("build_the_file", False, r"""
const d = await run("new_document");
window.__n1doc = d.id;
const ed0 = ednow(d.id);
shell.activate(ed0);
await wait(300);
ed0.resizeCanvas();
if (!ed0.tileMode) throw new Error("N1 measures the tile engine: start the app with tiles on");
if (!E.parts.usable()) throw new Error("no PNG parts here");
let px = T.TileLayerPixels.empty(W, H);
const t0 = performance.now();
const CELL = 2500, R = Math.round(W / 40), R2 = R * R;
for (let ty = 0; ty * 256 < H; ty++) for (let tx = 0; tx * 256 < W; tx++) {
    const d8 = px.writable(tx, ty).data;
    const w = Math.min(256, W - tx * 256), h = Math.min(256, H - ty * 256);
    for (let y = 0; y < h; y++) {
        const Y = ty * 256 + y, cyc = Math.floor(Y / CELL), dy = Y - (cyc * CELL + CELL / 2);
        for (let x = 0; x < w; x++) {
            const X = tx * 256 + x, o = (y * 256 + x) * 4;
            let n = (Math.imul(X, 374761393) + Math.imul(Y, 668265263)) >>> 0;
            n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0;
            const cxc = Math.floor(X / CELL), dx = X - (cxc * CELL + CELL / 2);
            if (dx * dx + dy * dy < R2) {
                const k = (cxc * 73 + cyc * 151) % 7;
                d8[o] = 60 + k * 25 + (n >>> 29); d8[o + 1] = 220 - k * 22 + ((n >>> 26) & 7); d8[o + 2] = 40 + k * 9 + ((n >>> 23) & 7);
            } else {
                const t = (X / W + Y / H) * 0.5;   // 0 .. 1 along the diagonal
                d8[o] = ((30 + 190 * t) | 0) + (n >>> 29); d8[o + 1] = ((70 + 60 * t) | 0) + ((n >>> 26) & 7); d8[o + 2] = ((200 - 150 * t) | 0) + ((n >>> 23) & 7);
            }
            d8[o + 3] = 255;
        }
    }
}
const fillMs = Math.round(performance.now() - t0);
const t1 = performance.now();
const enc = await E.parts.encodeTilePixels(px, { hash: true });
if (!enc) throw new Error("the encode gave nothing");
window.__n1blob = enc.blob;
px.release(); px = null;
return { size: [W, H], MP: Math.round(W * H / 1e6), fillMs, encodeMs: Math.round(performance.now() - t1), MB: +(enc.blob.size / 1048576).toFixed(1), arena: A.arenaStats() };
"""),
    ("open_the_file", True, r"""
const file = new File([window.__n1blob], "n1.png", { type: "image/png" });
const r = await row(async () => {
    const t0 = performance.now();
    await ed.loadFile(file);
    const loaded = Math.round(performance.now() - t0);
    if (ed.width !== W || ed.height !== H) throw new Error("the document is " + ed.width + " x " + ed.height + ": " + ed.status);
    ed.fitView(); ed.draw();
    await ed.mipsSettled();
    return { loadFileMs: loaded, tiles: ed.basePx.tileCount };
});
window.__n1blob = null;
return r;
"""),
    ("add_the_paint_layer", False, r"""
if (HUGE) return { skipped: "above the canvas limit the paint layer is the stroke's" };
const pc = document.createElement("canvas"); pc.width = W; pc.height = H;
{
    const x = pc.getContext("2d");
    x.fillStyle = "hsla(60,80%,50%,0.35)";
    x.fillRect(40, 40, W - 120, H - 120);
    for (let k = 0; k < 20; k++) { x.fillStyle = `hsl(${(k * 53) % 360},70%,60%)`; x.fillRect((k * 811) % W, (k * 457) % H, W / 25, H / 25); }
}
const r = await row(async () => {
    const paint = ed.addLayer({ name: "Paint", kind: "paint", px: ed.pixels.Layer.fromCanvas(pc), x: 0, y: 0, w: W, h: H, dirty: true });
    ed.renderLayers(); ed.fitView(); ed.draw();
    await ed.mipsSettled();
    return { tiles: paint.px.tileCount };
});
pc.width = 1;
return r;
"""),
    ("pan_and_zoom", True, r"""
ed.fitView(); ed.draw();
await ed.mipsSettled();
ed.sceneSig = null; ed.draw();
const frames = {};
const frame = (key, fn, n) => { const ts = []; for (let i = 0; i < n; i++) { const a = performance.now(); fn(i); ts.push(performance.now() - a); } ts.sort((x, y) => x - y); frames[key] = { median: +ts[ts.length >> 1].toFixed(2), max: +ts[ts.length - 1].toFixed(2), n }; };
return row(async () => {
    frame("pan_fit", (i) => { ed.view.x += (i % 2 ? -7 : 9); ed.view.y += 3; ed.draw(); }, 60);
    ed.view.scale = 1; ed._fitted = false;
    ed.view.x = Math.round(ed.canvas.width / 2 - W / 2); ed.view.y = Math.round(ed.canvas.height / 2 - H / 2);
    ed.draw(); ed.draw();
    frame("pan_1to1", (i) => { ed.view.x += (i % 2 ? -7 : 9); ed.view.y += 3; ed.draw(); }, 60);
    // a pan that brings new tiles onto the screen every frame
    frame("pan_1to1_far", (i) => { ed.view.x -= 300; ed.view.y -= 150; ed.draw(); }, 20);
    frame("zoom", (i) => {
        const ns = Math.min(4, Math.max(0.02, ed.view.scale * (i % 2 ? 1.25 : 0.8)));
        ed.view.x = ed.canvas.width / 2 - (ed.canvas.width / 2 - ed.view.x) * (ns / ed.view.scale);
        ed.view.y = ed.canvas.height / 2 - (ed.canvas.height / 2 - ed.view.y) * (ns / ed.view.scale);
        ed.view.scale = ns; ed.draw();
    }, 20);
    return frames;
});
"""),
    ("stroke_and_release", True, r"""
let layer = ed.layers.find((l) => l.kind === "paint");
if (!layer) layer = ed.addPaintLayer();
if (!layer) throw new Error("no paint layer: " + ed.status);
ed.view.scale = 1; ed._fitted = false;
ed.view.x = Math.round(ed.canvas.width / 2 - W / 2); ed.view.y = Math.round(ed.canvas.height / 2 - H / 2);
ed.setTool("paint"); ed.activeLayerId = layer.id; ed.brushSize = 40; ed.color = "#ff2080";
ed.draw();
const cx = Math.round(W / 2), cy = Math.round(H / 2);
return row(async () => {
    ed.pushUndo({ kind: "layer", id: layer.id });
    const p = { kind: "layerpaint", layer, stroke: ed.newStrokeBuffer(layer.px), clip: null, erase: false, last: [cx, cy], pressure: 1 };
    ed.pointer = p;
    const ts = [];
    for (let i = 0; i < 60; i++) { const a = performance.now(); const x = cx + (i + 1) * 10, y = cy + (i % 5) * 6; ed.layerDab(p, p.last[0], p.last[1], x, y); p.last = [x, y]; ed.draw(); ts.push(performance.now() - a); }
    ts.sort((a, b) => a - b);
    const t0 = performance.now();
    const box = ed.strokeRect(p, layer.px);
    ed.commitStroke(p);
    ed.pointer = null;
    ed.markLayerChanged(layer, box);
    ed.draw();
    const release = +(performance.now() - t0).toFixed(1);
    await ed.mipsSettled();
    return { frame_median: +ts[30].toFixed(2), frame_max: +ts[59].toFixed(2), release };
});
"""),
    ("grow_16", True, r"""
ed.clearUndo(); rect40();
return row(async () => { await ed.growSelection(16); return { bounds: ed.getBounds() }; });
"""),
    ("shrink_16", True, r"""
return row(async () => { await ed.growSelection(-16); return { bounds: ed.getBounds() }; });
"""),
    ("invert", True, r"""
return row(async () => { await ed.invertSelection(); return { bounds: ed.getBounds(), selTiles: ed.sel.tileCount }; });
"""),
    ("wand_whole_picture", True, r"""
ed.clearUndo(); rect40(); await run("select_none", { doc: window.__n1doc });
// a corner of the discs' cells: the gradient, which a tolerance of 32 floods as a band across the picture
return row(async () => { await ed.wandSelect(2500, 2500, "replace"); return { bounds: ed.getBounds(), status: ed.status }; });
"""),
    ("wand_one_disc", True, r"""
await run("select_none", { doc: window.__n1doc });
return row(async () => { await ed.wandSelect(1250, 1250, "replace"); return { bounds: ed.getBounds() }; });
"""),
    ("provider_crop", True, r"""
const S = await import("./editor/stitch.js");
const cx = Math.round(W / 2), cy = Math.round(H / 2);
ed.clearUndo();
await run("select_rect", { doc: window.__n1doc, x: cx - 512, y: cy - 512, w: 1024, h: 1024 });
// the provider's answer as file bytes, made before the row (a 1024 px square: what the row's crop is emitted at)
const answer = await (async () => { const c = document.createElement("canvas"); c.width = 1024; c.height = 1024; const x = c.getContext("2d"); x.fillStyle = "#20c060"; x.fillRect(0, 0, 1024, 1024); const b = await new Promise((r) => c.toBlob(r, "image/png")); return new Uint8Array(await b.arrayBuffer()); })();
return row(async () => {
    const t0 = performance.now();
    // a provider run's two steps as `host.runProvider` takes them (the stitch worker, the box from the tile workers)
    const prep = await S.prepareCropAsync(ed, host.nodeParams, host.cropLimits());
    const prepMs = +(performance.now() - t0).toFixed(1);
    const fin = await S.finishResultAsync(ed, prep.info, prep.sel, answer, "image/png");
    const bmp = await createImageBitmap(fin.blob);
    fin.patch = { width: bmp.width, height: bmp.height }; bmp.close();
    return { prepMs, bbox: prep.info.bbox, emitted: prep.info.emitted, window: [prep.sel.w, prep.sel.h], patch: [fin.patch.width, fin.patch.height], how: [prep.how, fin.how] };
});
"""),
    ("match_provider_crop", True, r"""
// the provider crop on the user's usual document: a result layer of 5000 x 3500 at (5000, 3000), matched 80 % to its
// surroundings, under the selection (`readBox` takes the whole flatten for a matched stack, docs/BUGS.md). Kept for
// `film_provider_crop`; removed by `close`.
const S = await import("./editor/stitch.js");
if (!ed.layers.some((l) => l.name === "Matched")) {
    const w = 5000, h = 3500, c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, "hsl(20,70%,55%)"); g.addColorStop(1, "hsl(60,60%,35%)");
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    for (let k = 0; k < 40; k++) { x.fillStyle = `hsl(${(k * 41) % 360},60%,50%)`; x.fillRect((k * 613) % w, (k * 389) % h, w / 20, h / 20); }
    const l = ed.addLayer({ name: "Matched", kind: "result", px: ed.pixels.Layer.fromCanvas(c), x: 5000, y: 3000, w, h, dirty: true });
    c.width = 1;
    l.match = { strength: 80, source: "surroundings" };
    ed.markMatchChanged(l);
    ed.renderLayers(); ed.draw();
    await ed.mipsSettled();
}
const cx = Math.round(W / 2), cy = Math.round(H / 2);
ed.clearUndo();
await run("select_rect", { doc: window.__n1doc, x: cx - 512, y: cy - 512, w: 1024, h: 1024 });
// the provider's answer as file bytes, made before the row (a 1024 px square: what the row's crop is emitted at)
const answer = await (async () => { const c = document.createElement("canvas"); c.width = 1024; c.height = 1024; const x = c.getContext("2d"); x.fillStyle = "#20c060"; x.fillRect(0, 0, 1024, 1024); const b = await new Promise((r) => c.toBlob(r, "image/png")); return new Uint8Array(await b.arrayBuffer()); })();
return row(async () => {
    const t0 = performance.now();
    // a provider run's two steps as `host.runProvider` takes them (the stitch worker, the box from the tile workers)
    const prep = await S.prepareCropAsync(ed, host.nodeParams, host.cropLimits());
    const prepMs = +(performance.now() - t0).toFixed(1);
    const fin = await S.finishResultAsync(ed, prep.info, prep.sel, answer, "image/png");
    const bmp = await createImageBitmap(fin.blob);
    fin.patch = { width: bmp.width, height: bmp.height }; bmp.close();
    return { prepMs, bbox: prep.info.bbox, emitted: prep.info.emitted, patch: [fin.patch.width, fin.patch.height], how: [prep.how, fin.how] };
});
"""),
    ("film_provider_crop", True, r"""
// the same with a film look over the stack
const S = await import("./editor/stitch.js");
if (!ed.layers.some((l) => l.kind === "filter")) await run("add_filter", { doc: window.__n1doc, type: "film.look", params: { preset: "portra400" } });
ed.renderLayers(); ed.draw();
await ed.mipsSettled();
// the provider's answer as file bytes, made before the row (a 1024 px square: what the row's crop is emitted at)
const answer = await (async () => { const c = document.createElement("canvas"); c.width = 1024; c.height = 1024; const x = c.getContext("2d"); x.fillStyle = "#20c060"; x.fillRect(0, 0, 1024, 1024); const b = await new Promise((r) => c.toBlob(r, "image/png")); return new Uint8Array(await b.arrayBuffer()); })();
return row(async () => {
    const t0 = performance.now();
    // a provider run's two steps as `host.runProvider` takes them (the stitch worker, the box from the tile workers)
    const prep = await S.prepareCropAsync(ed, host.nodeParams, host.cropLimits());
    const prepMs = +(performance.now() - t0).toFixed(1);
    const fin = await S.finishResultAsync(ed, prep.info, prep.sel, answer, "image/png");
    const bmp = await createImageBitmap(fin.blob);
    fin.patch = { width: bmp.width, height: bmp.height }; bmp.close();
    return { prepMs, bbox: prep.info.bbox, emitted: prep.info.emitted, patch: [fin.patch.width, fin.patch.height], how: [prep.how, fin.how] };
});
"""),
    ("export_png", True, r"""
await run("select_none", { doc: window.__n1doc });
return row(() => saveTo("png"));
"""),
    ("export_psd", True, r"""
return row(() => saveTo("psd"));
"""),
    ("export_ora", True, r"""
return row(() => saveTo("ora"));
"""),
    ("save_png", True, r"""
await run("select_none", { doc: window.__n1doc });
return row(() => saveFile("png"));
"""),
    ("save_psd", True, r"""
return row(() => saveFile("psd"));
"""),
    ("save_tiff", True, r"""
return row(() => saveFile("tiff"));
"""),
    ("save_ora", True, r"""
return row(() => saveFile("ora"));
"""),
    ("open_psd", True, r"""
return openFile("psd");
"""),
    ("open_ora", True, r"""
return openFile("ora");
"""),
    ("open_tiff", True, r"""
return openFile("tiff");
"""),
    ("blend_export_png", True, r"""
// B item 7: the paint layer in a blend mode (multiply), which `stackPlan` used to turn away
const paint = ed.layers.find((l) => l.kind === "paint");
if (!paint) return { skipped: "no paint layer" };
await run("select_none", { doc: window.__n1doc });
await run("set_layer", { doc: window.__n1doc, layer: paint.id, blend: "multiply" });
ed.renderLayers(); ed.draw();
return row(() => saveTo("png"));
"""),
    ("blend_export_psd", True, r"""
return row(() => saveTo("psd"));
"""),
    ("blend_wand", True, r"""
ed.clearUndo(); await run("select_none", { doc: window.__n1doc });
const r = await row(async () => { await ed.wandSelect(2500, 2500, "replace"); return { bounds: ed.getBounds(), status: ed.status }; });
await run("select_none", { doc: window.__n1doc });
const paint = ed.layers.find((l) => l.kind === "paint");
if (paint) await run("set_layer", { doc: window.__n1doc, layer: paint.id, blend: "normal" });
return r;
"""),
    ("filter_export_png", True, r"""
// B item 7: a levels layer over the stack
await run("select_none", { doc: window.__n1doc });
if (!ed.layers.some((l) => l.kind === "filter")) await run("add_filter", { doc: window.__n1doc, type: "levels", params: { gamma: 1.2 } });
ed.renderLayers(); ed.draw();
return row(() => saveTo("png"));
"""),
    ("filter_export_psd", True, r"""
return row(() => saveTo("psd"));
"""),
    ("filter_wand", True, r"""
ed.clearUndo(); await run("select_none", { doc: window.__n1doc });
const r = await row(async () => { await ed.wandSelect(2500, 2500, "replace"); return { bounds: ed.getBounds(), status: ed.status }; });
await run("select_none", { doc: window.__n1doc });
return r;
"""),
    ("match_export_png", True, r"""
// B item 7 part 3: the user's usual document: a result layer of 5000 x 3500 at (5000, 3000) with a soft edge, matched
// 80 % to its surroundings. Added here and removed by `match_wand`.
await run("select_none", { doc: window.__n1doc });
if (!ed.layers.some((l) => l.name === "Matched")) {
    const w = 5000, h = 3500, c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, "hsl(20,70%,55%)"); g.addColorStop(1, "hsl(60,60%,35%)");
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    for (let k = 0; k < 40; k++) { x.fillStyle = `hsl(${(k * 41) % 360},60%,50%)`; x.fillRect((k * 613) % w, (k * 389) % h, w / 20, h / 20); }
    x.globalCompositeOperation = "destination-in";
    const rg = x.createRadialGradient(w / 2, h / 2, w * 0.3, w / 2, h / 2, w * 0.5); rg.addColorStop(0, "rgba(0,0,0,1)"); rg.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = rg; x.fillRect(0, 0, w, h);
    const l = ed.addLayer({ name: "Matched", kind: "result", px: ed.pixels.Layer.fromCanvas(c), x: 5000, y: 3000, w, h, dirty: true });
    c.width = 1;
    l.match = { strength: 80, source: "surroundings" };
    ed.markMatchChanged(l);
    ed.renderLayers(); ed.draw();
    await ed.mipsSettled();
}
return row(() => saveTo("png"));
"""),
    ("match_export_psd", True, r"""
return row(() => saveTo("psd"));
"""),
    ("match_wand", True, r"""
ed.clearUndo(); await run("select_none", { doc: window.__n1doc });
const r = await row(async () => { await ed.wandSelect(2500, 2500, "replace"); return { bounds: ed.getBounds(), status: ed.status }; });
await run("select_none", { doc: window.__n1doc });
const m = ed.layers.find((l) => l.name === "Matched");
if (m) { ed.removeLayer(m.id); ed.renderLayers(); ed.draw(); }
return r;
"""),
    ("close", False, r"""
const id = window.__n1doc;
window.__n1doc = null; window.__n1blob = null; window.__n1kept = null; window.__n1saved = null;
await run("close_document", { doc: id, force: true });
return { closed: id, arena: A.arenaStats() };
"""),
]

# natives of the browser as V8's profile names them (a frame without a URL)
GPU_NATIVES = ("tex", "readPixels", "draw", "bufferData", "finish", "getError", "bindTexture", "useProgram", "uniform", "clear", "viewport", "bindFramebuffer", "framebuffer", "activeTexture", "blend", "scissor", "enable", "disable", "bindVertexArray", "createTexture", "deleteTexture", "getParameter")


def profile_split(profile):
    nodes = {n["id"]: n for n in profile["nodes"]}
    self_us = {}
    for nid, dt in zip(profile["samples"], profile["timeDeltas"]):
        self_us[nid] = self_us.get(nid, 0) + max(0, dt)
    out = {"idle": 0.0, "gc": 0.0, "program": 0.0, "natives": {}, "px": 0.0, "js": {}, "fn": {}}
    for nid, us in self_us.items():
        cf = nodes[nid]["callFrame"]
        name, url = cf.get("functionName", ""), cf.get("url", "")
        ms = us / 1000.0
        if name == "(idle)":
            out["idle"] += ms
        elif name == "(garbage collector)":
            out["gc"] += ms
        elif name in ("(program)", "(root)"):
            out["program"] += ms
        elif not url:
            out["natives"][name or "(anonymous)"] = out["natives"].get(name or "(anonymous)", 0) + ms
        elif "/px/" in url or url.endswith("inpaint_raster.js") or name.startswith("wasm-function") or url.startswith("wasm://"):
            out["px"] += ms
        else:
            f = url.rsplit("/", 1)[-1].split("?")[0]
            out["js"][f] = out["js"].get(f, 0) + ms
            key = f"{name or '(anonymous)'} [{f}:{cf.get('lineNumber', 0) + 1}]"
            out["fn"][key] = out["fn"].get(key, 0) + ms
    return out


def top(d, n=8, floor=1.0):
    items = sorted(d.items(), key=lambda kv: -kv[1])
    return ", ".join(f"{k} {v:.0f}" for k, v in items[:n] if v >= floor) or "-"


def report(name, r, prof):
    if "wall" not in r:
        print(f"[ok] {name}: {json.dumps(r)[:600]}")
        return
    print(f"\n== {name}: wall {r['wall']} ms, longest block {r['blocked']} ms" + (f"   ERROR {r['error']}" if r.get("error") else ""))
    if r.get("extra"):
        print(f"   {json.dumps(r['extra'])[:500]}")
    if prof:
        natives = sum(prof["natives"].values())
        js = sum(prof["js"].values())
        print(f"   main thread ms: idle {prof['idle']:.0f} | browser natives {natives:.0f} | px kernels {prof['px']:.0f} | other JS {js:.0f} | GC {prof['gc']:.0f} | (program) {prof['program']:.0f}")
        print(f"     natives: {top(prof['natives'])}")
        print(f"     JS by file: {top(prof['js'])}")
        print(f"     JS by function (self time; a typed-array copy counts for the function that makes it): {top(prof['fn'], 8, 5.0)}")
    calls = r.get("calls") or {}
    if calls:
        print("   boundaries (calls, ms inside the call, MB):")
        for k, v in sorted(calls.items(), key=lambda kv: -kv[1]["ms"]):
            if v["ms"] >= 0.5 or v["MB"] >= 1:
                print(f"     {k:34s} {v['n']:7d} {v['ms']:9.1f} ms {v['MB']:10.1f} MB")
    for op, j in (r.get("jobs") or {}).items():
        rest = {k: v for k, v in j.items() if k not in ("jobs", "pixels", "tiles")}
        print(f"   worker {op}: {j['jobs']} jobs, {json.dumps(rest)}")
    # the window's step marks: one line per run of an op, each step the ms since the op's mark before it
    for op, runs in (r.get("marks") or {}).items():
        for run in runs:
            steps = ", ".join(f"{k} {v:.1f}" for k, v in run.items() if k not in ("total", "extra", "nostart"))
            print(f"   marks {op}: {steps or '-'} | total {run['total']:.1f} ms" + (" (no start mark)" if run.get("nostart") else "")
                  + (f"  {json.dumps(run['extra'])}" if run.get("extra") else ""))


async def run_all(c):
    w, h = SIZE.lower().split("x")
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); const h = await import('./editor/host.js'); window.__host = h.host; window.__shell = await import('./shell.js'); return 1; })()")
    connected = await c.eval("(async () => { const s = await window.scumble.comfy.status(); return s && s.state; })()")
    if connected in ("connected", "missing-node"):
        print("this instance is connected to ComfyUI: start it with --no-comfy, or the uploads are forwarded to the server")
        print("RESULT refused")
        return False
    print(await c.eval(PROBES))
    if PROFILE:
        await c.call("Profiler.enable")
        await c.call("Profiler.setSamplingInterval", interval=500)
    results = {"size": SIZE, "profiled": PROFILE, "rows": {}}
    # the save rows' folder, made only when one of them is named
    out_dir, made, files = None, False, None
    if any(n in ONLY for n in SAVE_ROWS):
        if OUT_ARG:
            out_dir = os.path.abspath(OUT_ARG)
            os.makedirs(out_dir, exist_ok=True)
        else:
            out_dir, made = tempfile.mkdtemp(prefix="native_test_"), True
        files = {fmt: os.path.join(out_dir, "n1." + ("tif" if fmt == "tiff" else fmt)) for fmt in SAVE_ROWS.values()}
        results["out"] = out_dir
        print(f"the save rows write into {out_dir}" + (" (kept)" if KEEP else " (deleted at the end)"))
    try:
        await run_rows(c, w, h, files, results)
    finally:
        if files and not KEEP:
            gone = 0
            for p in files.values():
                if os.path.exists(p):
                    os.remove(p)
                    gone += 1
            if made:
                try:
                    os.rmdir(out_dir)
                except OSError:
                    pass
            print(f"deleted {gone} file(s) the save rows wrote")
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:300])
    if JSON_OUT:
        with open(JSON_OUT, "w", encoding="utf-8", newline=chr(10)) as f:
            json.dump(results, f, indent=1)
    print("\nRESULT measured")
    return True


async def run_rows(c, w, h, files, results):
    ran = set()   # the rows that ran without an error (the open rows need their save row's file)
    for name, profiled, body in ROWS:
        if ONLY and name not in ONLY and name not in ("build_the_file", "open_the_file", "close"):
            continue
        if name in OPT_IN and name not in ONLY:
            continue
        if name in OPEN_ROWS and not any(r in ran for r in OPEN_ROWS[name]):
            need = " or ".join(OPEN_ROWS[name])
            print(f"[skip] {name}: {need} did not run (name it before {name})")
            results["rows"][name] = {"skipped": need + " did not run"}
            continue
        expr = PRE.replace("__W__", w).replace("__H__", h).replace("__FILES__", json.dumps(files)).replace("__BODY__", body)
        prof = None
        try:
            if PROFILE and profiled:
                await c.call("Profiler.start")
            r = await c.eval(expr, timeout=3600)
            if PROFILE and profiled:
                prof = profile_split((await c.call("Profiler.stop"))["profile"])
        except Exception as err:  # noqa: BLE001
            print(f"[FAIL] {name}: {str(err)[:1200]}")
            if PROFILE and profiled:
                try:
                    await c.call("Profiler.stop")
                except Exception:  # noqa: BLE001
                    pass
            results["rows"][name] = {"failed": str(err)[:1200]}
            if name in ("build_the_file", "open_the_file"):
                break
            continue
        report(name, r, prof)
        if "--js" in ARGS and name == "build_the_file":   # the JS twins in every thread, for an A/B of a kernel on its row
            print(await c.eval("(async () => { const E = (await import('./editor/inpaint_canvas.js')).InpaintEditor || window.editor.constructor; E.kernels = 'js'; return 'kernels: ' + E.kernels; })()"))
        results["rows"][name] = {"row": r, "profile": prof}
        if not (isinstance(r, dict) and (r.get("error") or r.get("skipped"))):
            ran.add(name)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
