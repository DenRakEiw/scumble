"""Phase N1 (docs/PLAN_BCE.md §3b): where the time of the rows people feel goes, split by who spends it.

No ComfyUI, no key. Start the app offline and with a debugging port, tiles on (the default):

    ./node_modules/.bin/electron . --remote-debugging-port=9555 --no-comfy
    python tools/native_test.py [15000x10000] [--no-profile] [--json out.json] [row ...]

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

The document is a picture written per tile (a diagonal gradient the wand floods as a band, discs, three bits of noise so
the PNG compresses like a photograph), encoded by the pool and opened from that file as a user's file would be. At
15000 x 10000 a full-size paint layer is added; above the canvas limit the paint layer holds a stroke only.
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

ARGS = sys.argv[1:]
PROFILE = "--no-profile" not in ARGS
JSON_OUT = None
if "--json" in ARGS:
    i = ARGS.index("--json")
    JSON_OUT = ARGS[i + 1]
    del ARGS[i:i + 2]
SIZE = next((a for a in ARGS if "x" in a.lower() and a[0].isdigit()), "15000x10000")
ONLY = [a for a in ARGS if not a[0].isdigit() and not a.startswith("-")]

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
    // a row: probes and worker timings reset, the longest block of the main thread, then what the probes saw
    const row = async (fn) => {
        if (ed) { try { await ed.mipsSettled(); } catch (_) { /* ignore */ } }
        await wait(80);
        window.__n1.reset();
        E.jobTimings(true);
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
        return { wall: Math.round(wall), blocked: Math.round(held), calls, jobs, extra, error, status: ed ? ed.status : null, focused: document.hasFocus(), visibility: document.visibilityState };
    };
    const saveTo = async (format) => {
        let saved = null;
        const was = host.saveExport;
        host.saveExport = async (blob, name) => { saved = { blob, name }; return { path: "memory:" + name }; };
        try { ed.saveFormatSel.value = format; await ed.exportImage({ download: false }); } finally { host.saveExport = was; ed.saveFormatSel.value = "png"; }
        if (!saved) throw new Error("the export saved nothing: " + ed.status);
        return { MB: +(saved.blob.size / 1048576).toFixed(1) };
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
const answer = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.fillStyle = "#20c060"; x.fillRect(0, 0, w, h); return c; };
return row(async () => {
    const t0 = performance.now();
    const prep = S.prepareCrop(ed, host.nodeParams, host.cropLimits());
    const prepMs = +(performance.now() - t0).toFixed(1);
    const fin = S.finishResult(ed, prep.info, prep.sel, answer(prep.info.emitted[0], prep.info.emitted[1]));
    return { prepMs, bbox: prep.info.bbox, emitted: prep.info.emitted, window: [prep.sel.w, prep.sel.h], patch: [fin.patch.width, fin.patch.height] };
});
"""),
    ("export_png", True, r"""
await run("select_none", { doc: window.__n1doc });
return row(() => saveTo("png"));
"""),
    ("export_psd", True, r"""
return row(() => saveTo("psd"));
"""),
    ("close", False, r"""
const id = window.__n1doc;
window.__n1doc = null; window.__n1blob = null;
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
        elif "/px/" in url or url.endswith("inpaint_raster.js"):
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
    for name, profiled, body in ROWS:
        if ONLY and name not in ONLY and name not in ("build_the_file", "open_the_file", "close"):
            continue
        expr = PRE.replace("__W__", w).replace("__H__", h).replace("__BODY__", body)
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
        results["rows"][name] = {"row": r, "profile": prof}
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:300])
    if JSON_OUT:
        with open(JSON_OUT, "w", encoding="utf-8", newline=chr(10)) as f:
            json.dump(results, f, indent=1)
    print("\nRESULT measured")
    return True


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
