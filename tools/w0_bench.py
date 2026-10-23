"""W0 of docs/PLAN_WASM.md: the JS paths no other harness times, measured in the running app (2026-10-23).

No ComfyUI. Start the app offline with a debugging port and keep its window in front (V8's efficiency mode slows JS,
not wasm, in a window behind: docs/PERFORMANCE.md section 10):

    ./node_modules/.bin/electron . --remote-debugging-port=9555 --user-data-dir=<scratch> --no-comfy
    python tools/w0_bench.py [--json out.json] [--image=path/to/15k.jpg] [--files DIR] [--rows=name,name] [--size=WxH]

Each row runs the module's own function on synthetic data of a stated size (a median of several runs where it is cheap)
or, for the 15k rows, the editor's command on the picture. It never fails the caller: a row that throws prints its
error and the rest go on. Rows:

  freqsep_15k         the 15k picture: load_image of the JPEG, export a 15k PNG, load_image of it (wall each), then
                      frequency_separation of a 4000 x 4000 box (its limit is 16 MP)
  edgefit_2048        edgefit.fitLayerRGBA on a 2048^2 base and a shifted copy, with its laps (shrink, ring, fit);
                      warpRGBA and warpCoverage alone (the same matrix); `split` puts them side by side (its `fitEdges` is
                      fitEdges alone, the laps' `fit`; the row's `fit` is the whole fitLayerRGBA call)
  stitch_masks_2048   stitch.js gaussBlur (sigma 8) and dilate (8 px) on a 2048^2 mask, and the JS max / clamp around them
  crc32_64mb          inpaint_png.crc32 over 64 MB (ms per MB)
  dabs_256            inpaint_stroke blurRGBA / sharpenRGBA / toneRGBA / spongeRGBA on a 256^2 dab
  match_loop_4096     matchCanvas's CPU loop (the fallback when the shader is not there) on 4096^2
  histogram_depth     the editor's mapHistogram("depth") on a 4096 x 2731 depth map

The K0a rows (docs/PLAN_WASM_BUILD.md section 5) read Scumble's own files of the 15k photo, kept in --files (default
dist/w0_files) and made once by the app: load_image of --image, then the export command (PNG without metadata, TIFF).
They need the worker op `inflate_bench` and the `tiff_read` split of K0a; tiff_inflate_15k needs tifffile.

  files_15k           writes photo_15k.png and photo_15k.tif anew: the wall of each export, its step marks (export,
                      save) and its job sums; the rows below make a missing file first and print that as `made`
  jpeg_open_15k       load_image of the JPEG into a new document: the wall, image_read's decode / draw / read / kernel,
                      the sums of every job (during the call, and 3 s after it), the step marks
  png_inflate_15k     photo_15k.png's chunks read with 8-byte header reads, Scumble's layout checked (a 2-byte header
                      IDAT, the parts, a 4-byte Adler IDAT); inflate_bench three ways: whole (one zlib stream over every
                      IDAT), the parts in one worker (deflate-raw, 03 00 after every part but the file's last) and the
                      parts across the pool (pool.size contiguous jobs at once)
  png_filter_types    the filter type of every row of photo_15k.png (inflate_bench whole, the row stride): counts, shares
  tiff_inflate_15k    photo_15k.tif's strips (offsets and byte counts from tifffile), each its own zlib stream: all in
                      one worker, then across the pool
  tiff_rows_256       one tiff_read job straight on the pool (the bands are dropped, no window writes): its split (parse,
                      wait, decode, copy, unpredict, convert, deliver) and each per 256-row band; median of 3

An inflate way is three runs: `wall` (the window, from the jobs sent to the last reply) is their median; `read` and
`inflate` are the jobs' own times summed (CPU time across the pool), `inflate_max` the slowest job's inflate.
`in_MBps` / `out_MBps` are compressed / inflated bytes over the wall, `inflate_in_MBps` / `inflate_out_MBps` over
`inflate_max` (the file reads left out). MB is 2^20 bytes.

The K0b rows (docs/PLAN_WASM_BUILD.md sections 4.3, 4.9-4.11). `--size=WxH` runs each of them at that size instead of
its own (a smoke run; the stitch rows take the largest multiple of 64 that fits in it as their crop's side). `blocked`
is the longest time the window did not answer during the call (tools/native_test.py's probe), `pxCalls` the window's
px kernel calls by export name (px/kernels.js `pxCalls`), `laps` the step times the module reports.

  freqsep_4000        frequency_separation (radius 40, the 15k picture's default) of a 4000 x 4000 box of the 15k
                      picture at (5500, 3000), as freqsep_15k's freqsep_16mp (`wall` is the same total), with the
                      "freqsep" step marks; with --size, or without the JPEG, a box of a synthetic picture (centred)
  stitch_align_2048   stitch.finishResultAsync with align and colour match (a new document's crop settings) on a 2048^2
                      crop: a synthetic picture with a box selection, a fixed context of 1/8 of the side, no target
                      size (the crop is the box and comes back at that size); the answer is the crop scaled by 1 %
                      about its centre and moved by (3, 2) px. The stitch worker's route and the window's
                      (setStitchInWorker(false)), each the median of 3 with its laps, `laps_sum` and `rest` (the wall
                      less the laps per run, the median of those: the posts to the worker and what no lap names); prepareCropAsync's wall and laps
                      once (the setup). `workerPx` the stitch worker's kernel calls (from the result, worker route
                      only), `windowPx` the window's
  stitch_align_4096   the same at 4096^2
  match_fallback_16k  inpaint_filters.matchCanvas on a 4096^2 canvas with its WebGL2 path refused: the harness lowers the
                      WebGL context's max side (`G.max`, inpaint_filters_gl.js `glContext()`) below the canvas for the
                      timed calls and puts it back after, so applyMatchGL returns null and matchCanvas runs its CPU loop
                      (the whole function: the canvas, the read, the loop, the write; `gl_refused` checks it);
                      renderer files unchanged. Median of 3
  grow_fallback_15k   inpaint_raster.growMask (the window's fallback when both worker routes return null: JS scans, the
                      distance transform through kernels.js) and growMaskBounds (all of it in Rust, K39's candidate) on
                      a 15000 x 10000 mask (an ellipse over 70 % of each side) grown by 20 px; the mask is made in the
                      row, so the fallback's readRect / writeRect of the selection are not in it. A ladder of 1/4, 1/2
                      and the whole area, each run (3 per route and size) its own page script with a garbage
                      collection after it, each size printed as it ends: a size too large for the window leaves the
                      smaller ones measured, `largest_ok` per route. Last in the order, since a renderer that runs out
                      of memory takes every row after it along
"""
import asyncio
import json
import os
import statistics
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMAGE = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--image=")), os.path.join(ROOT, "dist", "daily", "adobe_15000x10000.jpg"))
JSON_OUT = next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--json" and i + 1 < len(sys.argv)), None)
FILES = os.path.abspath(next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--files=")), None)
                        or next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--files" and i + 1 < len(sys.argv)), None)
                        or os.path.join(ROOT, "dist", "w0_files"))
PNG_FILE = os.path.join(FILES, "photo_15k.png")
TIF_FILE = os.path.join(FILES, "photo_15k.tif")
MB = 1024 * 1024
TMP = tempfile.mkdtemp(prefix="w0_bench_")


def _size(s):
    """`WxH` as (W, H), or None."""
    if not s:
        return None
    w, h = s.lower().split("x")
    return int(w), int(h)


# --size=WxH: the K0b rows at this size instead of their own
SIZE = _size(next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--size=")), None)
             or next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--size" and i + 1 < len(sys.argv)), None))

PRE = """(async () => {
    const commands = (await import('./commands.js')).commands;
    const host = (await import('./editor/host.js')).host;
    const run = (n, a) => commands.run(n, a || {});
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return +s[Math.floor(s.length / 2)].toFixed(2); };
    const time = async (fn, n = 5) => { const ts = []; for (let i = 0; i < n; i++) { const a = performance.now(); await fn(i); ts.push(performance.now() - a); } return { median: median(ts), max: +Math.max(...ts).toFixed(2), n }; };
    const noise = (n, seed = 7) => { const a = new Uint8ClampedArray(n); let s = seed >>> 0; for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; a[i] = s >>> 24; } return a; };
    // the median of each numeric key over several runs' laps objects (a key missing from a run is left out of its median)
    const lapsMedian = (list) => {
        const o = {};
        for (const k of [...new Set(list.flatMap((l) => Object.keys(l || {})))]) {
            const xs = list.map((l) => l && l[k]).filter((v) => typeof v === "number");
            if (xs.length) o[k] = median(xs);
        }
        return o;
    };
    // this thread's px kernel calls by export name (px/kernels.js, K0b); null where this build has no counters
    const pxc = async (reset = false) => { const K = await import('./editor/px/kernels.js'); return typeof K.pxCalls === "function" ? K.pxCalls(reset) : null; };
    const out = { visibility: document.visibilityState, focus: document.hasFocus() };
    try {
        %s
    } catch (e) { out.error = String((e && e.stack) || e).slice(0, 600); }
    return JSON.stringify(out);
})()"""

ROWS = {
    "edgefit_2048": """
        const E = await import('./editor/edgefit.js');
        const w = 2048, h = 2048;
        const base = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; base[i] = (x * 7 + y * 3) & 255; base[i + 1] = (x ^ y) & 255; base[i + 2] = ((x * y) >> 6) & 255; base[i + 3] = 255; }
        const layer = new Uint8ClampedArray(base.length);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const sx = Math.min(w - 1, x + 3), sy = Math.min(h - 1, y + 2); const s = (sy * w + sx) * 4, d = (y * w + x) * 4; layer[d] = base[s]; layer[d + 1] = base[s + 1]; layer[d + 2] = base[s + 2]; layer[d + 3] = (x > 200 && x < w - 200 && y > 200 && y < h - 200) ? 255 : 0; }
        // the fit's own laps (K0b): shrink (the working planes at 512), ring (edgeRing), fit (fitEdges)
        const fitLaps = [];
        let fitR = null;
        await pxc(true);
        out.fit = await time(() => { const laps = {}; fitR = E.fitLayerRGBA({ baseRGBA: base, layerRGBA: layer, w, h, laps }); fitLaps.push(laps); }, 3);
        out.fit_laps = lapsMedian(fitLaps);
        out.aligned = fitR ? { aligned: fitR.aligned, reason: fitR.reason, scale: fitR.scale, shift: fitR.shift } : null;
        const M = [1, 0, 3, 0, 1, 2];
        out.warp = await time(() => E.warpRGBA(layer, w, h, M), 3);
        out.coverage = await time(() => E.warpCoverage(w, h, M), 3);
        out.pxCalls = await pxc(true);
        out.split = { shrink: out.fit_laps.shrink, ring: out.fit_laps.ring, fitEdges: out.fit_laps.fit, warp: out.warp.median, coverage: out.coverage.median };
    """,
    "stitch_masks_2048": """
        const S = await import('./editor/stitch.js');
        const w = 2048, h = 2048, n = w * h;
        const mk = () => { const d = new Float32Array(n); for (let i = 0; i < n; i++) d[i] = ((i % w) > 512 && (i % w) < 1536 && i > n / 4 && i < 3 * n / 4) ? 1 : 0; return { data: d, w, h }; };
        out.gauss = await time(() => S.gaussBlur(mk(), 8), 3);
        out.dilate = await time(() => S.dilate(mk(), 8), 3);
        // the per-pixel JS around them (stitch.js maskMax + maskClamp, copied: they are not exported)
        const a = mk(), b = mk();
        out.max_clamp = await time(() => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = Math.max(a.data[i], b.data[i]); for (let i = 0; i < n; i++) o[i] = Math.min(1, Math.max(0, o[i])); return o; }, 3);
        out.mk = await time(() => mk(), 3);
        out.note = "gaussBlur and dilate run Rust (box_blurs, dilate_mask) and include the mask's build (mk, also timed); max_clamp is the JS loop of denoiseMask";
    """,
    "crc32_64mb": """
        const P = await import('./editor/inpaint_png.js');
        const buf = noise(64 * 1024 * 1024);
        const t = await time(() => P.crc32(buf), 3);
        out.crc = t; out.msPerMB = +(t.median / 64).toFixed(3);
    """,
    "dabs_256": """
        const K = await import('./editor/inpaint_stroke.js');
        const w = 256, h = 256, src = noise(w * h * 4, 11);
        const lut = new Uint8Array(256); for (let i = 0; i < 256; i++) lut[i] = Math.min(255, Math.round(i * 1.1));
        out.blur = await time(() => K.blurRGBA(src, w, h, 6), 20);
        out.sharpen = await time(() => K.sharpenRGBA(src, w, h, 6, 1), 20);
        out.tone = await time(() => K.toneRGBA(src, lut, false), 20);
        out.sponge = await time(() => K.spongeRGBA(src, 0.5, true, true), 20);
    """,
    "match_loop_4096": """
        const W = 4096, H = 4096, d = noise(W * H * 4, 5);
        const meanS = [120, 110, 100], meanT = [100, 105, 110], scale = [1.05, 0.95, 1.0], k = 0.6;
        const loop = () => { for (let i = 0; i < d.length; i += 4) { if (!d[i + 3]) continue; for (let ch = 0; ch < 3; ch++) { const v = (d[i + ch] - meanT[ch]) * scale[ch] + meanS[ch]; d[i + ch] = Math.max(0, Math.min(255, d[i + ch] + (v - d[i + ch]) * k)); } } };
        out.loop = await time(loop, 3);
        out.note = "matchCanvas's CPU loop body, copied (the function itself takes the shader path first); 16.8 MP";
    """,
    "histogram_depth": """
        const ed = host.editor;
        if (!ed) throw new Error("no editor");
        const { makeMap } = await import('./editor/inpaint_maps.js');
        const mw = 4096, mh = 2731, ramp = new Uint16Array(mw * mh);
        for (let i = 0; i < ramp.length; i++) ramp[i] = (i * 2654435761 >>> 16) & 65535;
        await ed.setMap("depth", makeMap("depth", mw, mh, ramp, [ed.width, 0, 0, ed.height, 0, 0]));
        out.hist = await time(() => ed.mapHistogram("depth"), 5);
    """,
    "freqsep_15k": """
        const doc = (await run("new_document")).id;
        const ed = host.editors().find((e) => e.node.id === doc);
        host.shell.activate(ed);
        let t = performance.now();
        await run("load_image", { doc, path: %(image)s });
        out.load_jpg = +(performance.now() - t).toFixed(0);
        out.size = [ed.width, ed.height];
        await wait(3000);
        // a 15k PNG of the composite, then opened again as a user's file
        t = performance.now();
        await run("export", { doc, format: "png", path: %(png)s });
        out.png_export = +(performance.now() - t).toFixed(0);
        const doc2 = (await run("new_document")).id;
        t = performance.now();
        await run("load_image", { doc: doc2, path: %(png)s });
        out.png_open = +(performance.now() - t).toFixed(0);
        try { await run("close_document", { doc: doc2, force: true }); } catch (_) {}
        host.shell.activate(ed);
        // frequency separation works on up to 16 MP: a 4000 x 4000 box of the 15k picture
        await run("select_rect", { doc, x: 5500, y: 3000, w: 4000, h: 4000 });
        t = performance.now();
        const r = await run("frequency_separation", { doc });
        out.freqsep_16mp = +(performance.now() - t).toFixed(0);
        out.freqsep_result = r ? Object.keys(r).slice(0, 6) : null;
        try { await run("close_document", { doc, force: true }); } catch (_) {}
    """,
}

# ---- K0a: the readers' rows on Scumble's own files ----------------------------------------------------------------
# A K0a row is a Python coroutine (it may prepare the files or read a TIFF's strips first); its JS gets ARGS (JSON) and
# the helpers below after PRE's.

HELPERS = r"""
        const E = (await import('./editor/inpaint_canvas.js')).InpaintEditor;
        const MB = 1048576;
        const r1 = (x) => (typeof x === "number" ? +x.toFixed(1) : x);
        const ms = (t) => +(performance.now() - t).toFixed(1);
        const rate = (bytes, t) => (t > 0 ? +((bytes / MB) / (t / 1000)).toFixed(1) : null);
        const fileBlob = async (path, type) => new Blob([(await window.scumble.file.read(path)).data], { type });
        // the sums of every numeric field per op, as tools/native_test.py prints them
        const sumOps = (ts) => {
            const o = {};
            for (const x of ts || []) {
                if (!x || !x.op) continue;
                const s = o[x.op] || (o[x.op] = { jobs: 0 });
                s.jobs++;
                for (const [k, v] of Object.entries(x)) if (typeof v === "number") s[k] = (s[k] || 0) + v;
            }
            for (const s of Object.values(o)) for (const k of Object.keys(s)) s[k] = r1(s[k]);
            return o;
        };
        // step marks to durations: per op, each mark's t minus the previous mark's of the same op; "start" opens a run
        const marksOf = (marks) => {
            const runs = [], open = {};
            for (const m of marks || []) {
                const { op, step, t, ...extra } = m;
                let r = open[op];
                if (step === "start" || !r) { r = open[op] = { op, t0: t, last: t, steps: [] }; runs.push(r); }
                r.steps.push({ step, ms: r1(t - r.last), ...extra });
                r.last = t;
            }
            return runs.map((r) => ({ op: r.op, total: r1(r.last - r.t0), steps: r.steps }));
        };
        const takeMarks = () => (typeof E.stepMarks === "function" ? E.stepMarks(true) : null);
        const pool = () => E.parts.pool();
        const bench = (args) => pool().run("inflate_bench", args, [], { timeout: 600000 });
        // pool.size workers started before a way is timed (a job that finds every worker busy starts one): an empty zlib stream each
        const EMPTY_ZLIB = new Blob([new Uint8Array([0x78, 0x9C, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])]);
        const warm = async () => {
            try { await Promise.all(Array.from({ length: pool().size }, () => bench({ blob: EMPTY_ZLIB, ranges: [[0, 8]], format: "deflate", whole: true, stride: 0 }))); return true; } catch (e) { return String((e && e.message) || e); }
        };
        // `xs` in `k` contiguous runs of about equal length
        const split = (xs, k) => {
            k = Math.max(1, Math.min(k, xs.length));
            const g = [];
            for (let i = 0; i < k; i++) g.push(xs.slice(Math.floor(i * xs.length / k), Math.floor((i + 1) * xs.length / k)));
            return g;
        };
        // one inflate way: the jobs (each one inflate_bench's args) sent at once, `n` times; medians and rates
        const way = async (jobs, n = 3) => {
            const runs = [];
            for (let i = 0; i < n; i++) {
                const t = performance.now();
                const replies = await Promise.all(jobs.map((a) => bench(a)));
                const wall = performance.now() - t, ts = replies.map((r) => r.timing || {});
                const sum = (k) => ts.reduce((s, x) => s + (+x[k] || 0), 0);
                runs.push({ wall, bytes: sum("bytes"), out: replies.reduce((s, r) => s + (r.out || 0), 0), streams: sum("streams"), read: sum("read"), inflate: sum("inflate"), inflateMax: Math.max(...ts.map((x) => +x.inflate || 0)) });
            }
            const m = (k) => median(runs.map((r) => r[k]));
            const wall = m("wall"), inflateMax = m("inflateMax"), bytes = runs[0].bytes, out = runs[0].out;
            return {
                jobs: jobs.length, streams: runs[0].streams, n, wall, walls: runs.map((r) => r1(r.wall)),
                bytes, out_bytes: out, same_out: runs.every((r) => r.out === out), MB_in: +(bytes / MB).toFixed(1), MB_out: +(out / MB).toFixed(1),
                read: m("read"), inflate: m("inflate"), inflate_max: inflateMax,
                in_MBps: rate(bytes, wall), out_MBps: rate(out, wall), inflate_in_MBps: rate(bytes, inflateMax), inflate_out_MBps: rate(out, inflateMax),
            };
        };
        // a PNG's chunks from 8-byte header reads, its IHDR, and whether the IDATs are Scumble's parted layout
        const pngLayout = async (blob) => {
            const at = async (o, n) => new Uint8Array(await blob.slice(o, o + n).arrayBuffer());
            const sig = await at(0, 8);
            if ([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A].some((b, i) => sig[i] !== b)) throw new Error("not a PNG");
            const chunks = [];
            for (let p = 8; p + 12 <= blob.size;) {
                const h = await at(p, 8);
                const len = new DataView(h.buffer).getUint32(0);
                const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
                chunks.push({ type, off: p + 8, len, i: chunks.length });
                p += 12 + len;
                if (type === "IEND") break;
            }
            if (!chunks.length || chunks[0].type !== "IHDR") throw new Error("the PNG does not start with IHDR");
            const ih = new DataView((await at(chunks[0].off, 13)).buffer);
            const width = ih.getUint32(0), height = ih.getUint32(4), depth = ih.getUint8(8), colour = ih.getUint8(9), interlace = ih.getUint8(12);
            const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour] || 0;
            const stride = 1 + Math.ceil(width * channels * depth / 8);
            const idat = chunks.filter((c) => c.type === "IDAT");
            const together = idat.every((c, k) => k === 0 || c.i === idat[k - 1].i + 1);
            const scumble = idat.length >= 3 && together && idat[0].len === 2 && idat[idat.length - 1].len === 4 && depth === 8 && colour === 6 && interlace === 0;
            const parts = scumble ? idat.slice(1, -1) : [];
            const lens = parts.map((c) => c.len);
            const summary = {
                width, height, depth, colour, interlace, chunks: chunks.length, types: [...new Set(chunks.map((c) => c.type))],
                idat: idat.length, together, first: idat.length ? idat[0].len : null, last: idat.length ? idat[idat.length - 1].len : null,
                head: idat.length ? Array.from(await at(idat[0].off, Math.min(2, idat[0].len)), (b) => b.toString(16).padStart(2, "0")).join(" ") : null,
                scumble, parts: parts.length, MB_idat: +(idat.reduce((s, c) => s + c.len, 0) / MB).toFixed(1),
                part_KB: lens.length ? { min: Math.round(Math.min(...lens) / 1024), max: Math.round(Math.max(...lens) / 1024) } : null,
            };
            return { width, height, stride, idat, parts, scumble, summary };
        };
"""

MAKE_FILES = r"""
        const doc = (await run("new_document")).id;
        const ed = host.editors().find((e) => e.node.id === doc);
        host.shell.activate(ed);
        try {
            let t = performance.now();
            await run("load_image", { doc, path: ARGS.image });
            out.load_jpg = ms(t);
            out.size = [ed.width, ed.height];
            await wait(3000);
            for (const f of ARGS.make) {
                try {
                    takeMarks(); E.jobTimings(true);
                    t = performance.now();
                    await run("export", { doc, format: f.format, path: f.path, ...(f.format === "png" ? { metadata: false } : {}) });
                    out[f.format] = { wall: ms(t), marks: marksOf(takeMarks()), ops: sumOps(E.jobTimings(true)) };
                } catch (e) { out[f.format] = { error: String((e && e.message) || e).slice(0, 400) }; }
            }
        } finally { try { await run("close_document", { doc, force: true }); } catch (_) {} }
"""

JPEG_OPEN = r"""
        const doc = (await run("new_document")).id;
        const ed = host.editors().find((e) => e.node.id === doc);
        host.shell.activate(ed);
        try {
            E.jobTimings(true); takeMarks();
            const t = performance.now();
            await run("load_image", { doc, path: ARGS.image });
            out.wall = ms(t);
            out.size = [ed.width, ed.height];
            const ts = E.jobTimings(true);
            out.image_read = ts.filter((x) => x.op === "image_read").map((x) => ({ decode: r1(x.decode), draw: r1(x.draw), read: r1(x.read), kernel: r1(x.kernel), pixels: x.pixels }));
            out.ops = sumOps(ts);
            out.marks = marksOf(takeMarks());
            // what the open left running after load_image answered (the store, the mips)
            await wait(3000);
            out.ops_after_3s = sumOps(E.jobTimings(true));
            out.marks_after_3s = marksOf(takeMarks());
        } finally { try { await run("close_document", { doc, force: true }); } catch (_) {} }
"""

PNG_INFLATE = r"""
        const blob = await fileBlob(ARGS.png, "image/png");
        const L = await pngLayout(blob);
        out.layout = L.summary;
        out.pool_size = pool().size;
        out.warm = await warm();
        out.expected_out = L.height * L.stride;
        out.whole = await way([{ blob, ranges: L.idat.map((c) => [c.off, c.len]), format: "deflate", whole: true, stride: 0 }]);
        if (!L.scumble) out.parts = "skipped: not Scumble's parted layout (a 2-byte IDAT, the parts, a 4-byte IDAT; 8-bit RGBA)";
        else {
            const last = L.parts.length - 1;
            const ranges = L.parts.map((c, i) => (i === last ? [c.off, c.len] : [c.off, c.len, [3, 0]]));
            out.parts_1_worker = await way([{ blob, ranges, format: "deflate-raw", whole: false, stride: 0 }]);
            out.parts_pool = await way(split(ranges, pool().size).map((r) => ({ blob, ranges: r, format: "deflate-raw", whole: false, stride: 0 })));
            out.same_out = out.whole.out_bytes === out.parts_1_worker.out_bytes && out.whole.out_bytes === out.parts_pool.out_bytes;
        }
"""

PNG_FILTERS = r"""
        const blob = await fileBlob(ARGS.png, "image/png");
        const L = await pngLayout(blob);
        out.layout = L.summary;
        const t = performance.now();
        const r = await bench({ blob, ranges: L.idat.map((c) => [c.off, c.len]), format: "deflate", whole: true, stride: L.stride });
        out.wall = ms(t);
        const f = r.filters || [];
        const rows = f.reduce((s, n) => s + n, 0);
        out.rows = rows;
        out.height = L.height;
        out.counts = {}; out.shares_pct = {};
        ["None", "Sub", "Up", "Average", "Paeth", "other"].forEach((name, i) => { out.counts[name] = f[i] || 0; out.shares_pct[name] = rows ? +(100 * (f[i] || 0) / rows).toFixed(2) : null; });
        out.timing = r.timing;
"""

TIFF_INFLATE = r"""
        const blob = await fileBlob(ARGS.tif, "image/tiff");
        out.pool_size = pool().size;
        out.warm = await warm();
        const strips = ARGS.strips;
        out.one_worker = await way([{ blob, ranges: strips, format: "deflate", whole: false, stride: 0 }]);
        out.pool = await way(split(strips, pool().size).map((r) => ({ blob, ranges: r, format: "deflate", whole: false, stride: 0 })));
"""

TIFF_ROWS = r"""
        const blob = await fileBlob(ARGS.tif, "image/tiff");
        out.warm = await warm();
        const runs = [];
        for (let i = 0; i < 3; i++) {
            const t = performance.now();
            const r = await pool().run("tiff_read", { blob }, [], { onProgress: () => {}, timeout: 600000 });
            runs.push({ wall: performance.now() - t, timing: r.timing || {}, info: r.info || {} });
        }
        const tm = runs.map((r) => r.timing), t0 = tm[0];
        const keys = ["parse", "wait", "decode", "copy", "unpredict", "convert", "deliver", "kernel"];
        out.wall = median(runs.map((r) => r.wall));
        out.walls = runs.map((r) => r1(r.wall));
        out.bands = t0.bands; out.pieces = t0.pieces; out.codec = t0.codec;
        out.split = {}; out.per_band = {};
        for (const k of keys) {
            out.split[k] = median(tm.map((x) => +x[k] || 0));
            out.per_band[k] = t0.bands > 0 ? +(out.split[k] / t0.bands).toFixed(3) : null;
        }
        out.missing = keys.concat(["bands", "pieces", "codec"]).filter((k) => !(k in t0));   // fields this build's reader does not report
        const i0 = runs[0].info;
        out.info = { width: i0.width, height: i0.height, bits: i0.bits, samples: i0.samples, compression: i0.compression, predictor: i0.predictor, planar: i0.planar, tiled: i0.tiled };
"""


def script(body, **args):
    """The page script of a K0a row: PRE around HELPERS, `const ARGS` (JSON) and the row's body."""
    return PRE % (HELPERS + "        const ARGS = " + json.dumps(args) + ";\n" + body)


async def js(c, body, timeout=1800, **args):
    raw = await c.eval(script(body, **args), timeout=timeout)
    return json.loads(raw) if isinstance(raw, str) else raw


def making(path):
    root, ext = os.path.splitext(path)
    return root + ".making" + ext


async def make_files(c, force=False):
    """photo_15k.png and photo_15k.tif in FILES, exported by the app from IMAGE; only the missing ones unless `force`.
    Each is written under a `.making` name and renamed once its export answered, so a broken export leaves no file
    that a later run would take. Returns the page's report, or None when nothing was made."""
    want = [(fmt, path) for fmt, path in (("png", PNG_FILE), ("tiff", TIF_FILE)) if force or not os.path.exists(path)]
    if not want:
        return None
    os.makedirs(FILES, exist_ok=True)
    val = await js(c, MAKE_FILES, image=IMAGE, make=[{"format": fmt, "path": making(path)} for fmt, path in want])
    for fmt, path in want:
        r = val.get(fmt) if isinstance(val, dict) else None
        if isinstance(r, dict) and "wall" in r and os.path.exists(making(path)):
            os.replace(making(path), path)
            r["MB"] = round(os.path.getsize(path) / MB, 1)
    return val


async def need_files(c, *paths):
    """Make the missing files; the report of what was made (or None), and the first path still missing."""
    made = await make_files(c)
    return made, next((p for p in paths if not os.path.exists(p)), None)


async def row_files_15k(c):
    return await make_files(c, force=True)


async def row_jpeg_open_15k(c):
    return await js(c, JPEG_OPEN, image=IMAGE)


async def row_png_inflate_15k(c):
    made, missing = await need_files(c, PNG_FILE)
    if missing:
        return {"error": "no " + missing, "made": made}
    val = await js(c, PNG_INFLATE, png=PNG_FILE)
    if made:
        val["made"] = made
    return val


async def row_png_filter_types(c):
    made, missing = await need_files(c, PNG_FILE)
    if missing:
        return {"error": "no " + missing, "made": made}
    val = await js(c, PNG_FILTERS, png=PNG_FILE)
    if made:
        val["made"] = made
    return val


async def row_tiff_inflate_15k(c):
    made, missing = await need_files(c, TIF_FILE)
    if missing:
        return {"error": "no " + missing, "made": made}
    import tifffile
    with tifffile.TiffFile(TIF_FILE) as tf:
        page = tf.pages[0]
        offsets = [int(x) for x in page.dataoffsets]
        counts = [int(x) for x in page.databytecounts]
        layout = {"shape": list(page.shape), "compression": int(page.compression), "predictor": int(page.predictor),
                  "tiled": bool(page.is_tiled), "rowsperstrip": int(page.rowsperstrip), "strips": len(offsets),
                  "MB_strips": round(sum(counts) / MB, 1), "MB_file": round(os.path.getsize(TIF_FILE) / MB, 1)}
    if layout["compression"] not in (8, 32946):
        return {"error": "the strips are not deflate (compression %d)" % layout["compression"], "layout": layout, "made": made}
    val = await js(c, TIFF_INFLATE, tif=TIF_FILE, strips=[[o, n] for o, n in zip(offsets, counts)])
    val["layout"] = layout
    if made:
        val["made"] = made
    return val


async def row_tiff_rows_256(c):
    made, missing = await need_files(c, TIF_FILE)
    if missing:
        return {"error": "no " + missing, "made": made}
    val = await js(c, TIFF_ROWS, tif=TIF_FILE)
    if made:
        val["made"] = made
    return val


ROWS.update({
    "files_15k": row_files_15k,
    "jpeg_open_15k": row_jpeg_open_15k,
    "png_inflate_15k": row_png_inflate_15k,
    "png_filter_types": row_png_filter_types,
    "tiff_inflate_15k": row_tiff_inflate_15k,
    "tiff_rows_256": row_tiff_rows_256,
})

# ---- K0b: frequency separation, stitch, the match and grow fallbacks ------------------------------------------------
# Python coroutines like the K0a rows; their page scripts get HELPERS, then K0B, then the body.

K0B = r"""
        // the call's wall and the longest time the window did not answer during it (tools/native_test.py's probe)
        const timed = async (fn) => {
            let held = 0, last = performance.now(), on = true;
            const beat = () => { const n = performance.now(); held = Math.max(held, n - last); last = n; if (on) setTimeout(beat, 0); };
            setTimeout(beat, 0);
            const t0 = performance.now();
            let value;
            try { value = await fn(); } finally { on = false; held = Math.max(held, performance.now() - last); }
            return { wall: performance.now() - t0, blocked: held, value };
        };
        // a picture with structure at several scales (separable waves and a ramp), so a blur and an edge fit see real
        // gradients, not noise; drawn here, encoded as a JPEG and opened through loadFile as load_image opens a file
        const synthDoc = async (W, H) => {
            const doc = (await run("new_document")).id;
            const ed = host.editors().find((e) => e.node.id === doc);
            host.shell.activate(ed);
            const c = document.createElement("canvas");
            c.width = W; c.height = H;
            const ctx = c.getContext("2d");
            const img = ctx.createImageData(W, H), d = img.data;
            const wave = (n, f, p) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = Math.sin(i * f + p); return a; };
            const x1 = wave(W, 0.011, 0), x2 = wave(W, 0.047, 1), y1 = wave(H, 0.013, 2), y2 = wave(H, 0.041, 3);
            for (let y = 0, j = 0; y < H; y++) {
                for (let x = 0; x < W; x++, j += 4) {
                    const a = x1[x] * y1[y];
                    d[j] = 128 + 70 * a + 25 * (x2[x] + y2[y]);
                    d[j + 1] = 128 + 50 * x2[x] * y1[y] + 40 * x1[x];
                    d[j + 2] = 96 + 60 * y2[y] + 30 * a + 64 * x / W;
                    d[j + 3] = 255;
                }
            }
            ctx.putImageData(img, 0, 0);
            const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.95));
            c.width = 1; c.height = 1;
            await ed.loadFile(new File([blob], `synthetic_${W}x${H}.jpg`, { type: "image/jpeg" }), { size: null, ask: false });
            if (!ed.base || ed.width !== W || ed.height !== H) throw new Error(ed.status || "the synthetic picture did not open");
            ed.history = []; if (ed.renderHistory) ed.renderHistory();
            return { doc, ed };
        };
        const closeDoc = async (doc) => { try { await run("close_document", { doc, force: true }); } catch (_) {} };
"""

FREQSEP = r"""
        let doc, ed;
        if (ARGS.synthetic) {
            ({ doc, ed } = await synthDoc(ARGS.w, ARGS.h));
            out.picture = `synthetic ${ARGS.w} x ${ARGS.h}`;
        } else {
            doc = (await run("new_document")).id;
            ed = host.editors().find((e) => e.node.id === doc);
            host.shell.activate(ed);
            const t = performance.now();
            await run("load_image", { doc, path: ARGS.image });
            out.load = ms(t);
            out.picture = ARGS.image;
        }
        try {
            out.size = [ed.width, ed.height];
            await wait(3000);
            const side = Math.min(ARGS.side, ed.width, ed.height);
            const x = ARGS.x != null ? ARGS.x : Math.floor((ed.width - side) / 2), y = ARGS.y != null ? ARGS.y : Math.floor((ed.height - side) / 2);
            await run("select_rect", { doc, x, y, w: side, h: side });
            takeMarks(); await pxc(true);
            const r = await timed(() => run("frequency_separation", { doc, radius: ARGS.radius }));
            out.wall = r1(r.wall);
            out.blocked = r1(r.blocked);
            out.box = r.value && r.value.box; out.radius = r.value && r.value.radius;
            out.marks = marksOf(takeMarks());
            out.pxCalls = await pxc(true);
        } finally { await closeDoc(doc); }
"""

STITCH_ALIGN = r"""
        const S = await import('./editor/stitch.js');
        const side = ARGS.side, pad = ARGS.pad, margin = ARGS.margin, P = side + 2 * margin;
        const { doc, ed } = await synthDoc(P, P);
        try {
            out.picture = [P, P];
            await wait(1500);
            await run("select_rect", { doc, x: margin + pad, y: margin + pad, w: side - 2 * pad, h: side - 2 * pad });
            // a new document's crop settings (auto feather, colour match, align) but a fixed context of `pad` and no
            // target size: the crop is the box side x side and is sent at that size (a local recipe's way)
            const params = { padding: pad, target_size: 0, feather: 0, multiple_of: 64 };
            await pxc(true);
            const p0 = await timed(() => S.prepareCropAsync(ed, params, null, { references: false, crop: { context: "manual" } }));
            const prep = p0.value;
            out.prepare = { wall: r1(p0.wall), blocked: r1(p0.blocked), how: prep.how, laps: prep.laps ? lapsMedian([prep.laps]) : null, ...(prep.pxCalls ? { workerPx: prep.pxCalls } : {}), windowPx: await pxc(true) };
            const inf = prep.info;
            out.bbox = inf.bbox; out.emitted = inf.emitted;
            out.info = { align: inf.align, color_match: inf.color_match, auto_feather: inf.auto_feather, feather: inf.feather, grow: inf.grow, blend: inf.blend, paste: inf.paste };
            if (inf.bbox[2] !== side || inf.bbox[3] !== side) out.note = `the crop is ${inf.bbox[2]} x ${inf.bbox[3]}, not ${side}^2`;
            // the answer: the crop scaled by 1 % about its centre and moved by (3, 2) px, as an edit model returns one
            const bmp = await createImageBitmap(new Blob([prep.image], { type: "image/png" }));
            const ac = document.createElement("canvas");
            ac.width = bmp.width; ac.height = bmp.height;
            const actx = ac.getContext("2d");
            const k = 1.01;
            actx.setTransform(k, 0, 0, k, (1 - k) * bmp.width / 2 + 3, (1 - k) * bmp.height / 2 + 2);
            actx.drawImage(bmp, 0, 0);
            bmp.close();
            const answer = new Uint8Array(await (await new Promise((r) => ac.toBlob(r, "image/png"))).arrayBuffer());
            ac.width = 1; ac.height = 1;
            out.answer_MB = +(answer.length / MB).toFixed(1);
            const finish = async () => {
                const runs = [];
                for (let i = 0; i < ARGS.runs; i++) {
                    await pxc(true);
                    const r = await timed(() => S.finishResultAsync(ed, inf, prep.sel, answer, "image/png"));
                    const v = r.value || {};
                    const sum = Object.values(v.laps || {}).reduce((s, x) => s + (typeof x === "number" ? x : 0), 0);
                    runs.push({ wall: r.wall, blocked: r.blocked, laps: v.laps || null, sum, how: v.how, align: v.align, pxCalls: v.pxCalls || null, windowPx: await pxc(true) });
                    await wait(300);
                }
                const wall = median(runs.map((x) => x.wall)), sum = median(runs.map((x) => x.sum));
                const a = runs[0].align || {};
                return {
                    wall, walls: runs.map((x) => r1(x.wall)), blocked: median(runs.map((x) => x.blocked)),
                    laps: lapsMedian(runs.map((x) => x.laps)), laps_sum: sum, rest: median(runs.map((x) => x.wall - x.sum)), how: runs[0].how,
                    align: { aligned: a.aligned, reason: a.reason, scale: a.scale, shift: a.shift },
                    ...(runs[0].pxCalls ? { workerPx: runs[0].pxCalls } : {}), windowPx: runs[0].windowPx,
                };
            };
            out.worker = await finish();
            const was = S.setStitchInWorker(false);
            try { out.window = await finish(); } finally { S.setStitchInWorker(was); }
        } finally { await closeDoc(doc); }
"""

MATCH_FALLBACK = r"""
        const F = await import('./editor/inpaint_filters.js');
        const GL = await import('./editor/inpaint_filters_gl.js');
        const W = ARGS.w, H = ARGS.h;
        out.size = [W, H];
        const src = document.createElement("canvas");
        src.width = W; src.height = H;
        src.getContext("2d").putImageData(new ImageData(noise(W * H * 4, 5), W, H), 0, 0);
        // the statistics of the old match_loop_4096 row (its copy of the loop) and its strength
        const stats = { meanS: [120, 110, 100], meanT: [100, 105, 110], scale: [1.05, 0.95, 1.0] }, k = 0.6;
        const g = GL.glContext();
        out.webgl2 = !!g;
        // applyMatchGL refuses a source larger than the context's max side: lowered below the canvas for the timed calls
        // (null here means no WebGL2 at all, and matchCanvas takes its CPU loop anyway)
        const was = g ? g.max : 0;
        const runs = [];
        if (g) g.max = Math.min(W, H) - 1;
        try {
            out.gl_refused = GL.applyMatchGL(src, stats, k) === null;
            for (let i = 0; i < ARGS.runs; i++) {
                await pxc(true);
                const r = await timed(() => F.matchCanvas(src, stats, k));
                if (r.value) { r.value.width = 1; r.value.height = 1; }
                runs.push({ wall: r.wall, blocked: r.blocked, pxCalls: await pxc(true) });
            }
        } finally { if (g) g.max = was; }
        src.width = 1; src.height = 1;
        out.cpu = { median: median(runs.map((x) => x.wall)), walls: runs.map((x) => r1(x.wall)), blocked: median(runs.map((x) => x.blocked)), n: runs.length };
        out.pxCalls = runs.length ? runs[0].pxCalls : null;
"""

# one run of one grow route at one size; its own page script, so the mask and the kernel's grown memory are garbage when it answers
GROW_STEP = r"""
        const R = await import('./editor/inpaint_raster.js');
        const K = await import('./editor/px/kernels.js');
        const W = ARGS.w, H = ARGS.h;
        let d = new Uint8ClampedArray(W * H * 4);
        // the selection's layout (inpaint_raster.js): red with alpha 255 where selected, red with alpha 0 elsewhere
        const word = (b) => new Uint32Array(new Uint8Array(b).buffer)[0];
        const SEL = word([255, 0, 0, 255]), CLEAR = word([255, 0, 0, 0]);
        const u = new Uint32Array(d.buffer);
        u.fill(CLEAR);
        // an ellipse over 70 % of each side
        const cx = W / 2, cy = H / 2, rx = 0.35 * W, ry = 0.35 * H;
        for (let y = 0; y < H; y++) {
            const t = (y + 0.5 - cy) / ry;
            if (t * t >= 1) continue;
            const half = rx * Math.sqrt(1 - t * t);
            const x0 = Math.max(0, Math.ceil(cx - half)), x1 = Math.min(W, Math.floor(cx + half));
            if (x1 > x0) u.fill(SEL, y * W + x0, y * W + x1);
        }
        out.kernels = K.kernelsInUse();
        await pxc(true);
        const parts = {};
        const t = performance.now();
        const r = ARGS.route === "growMaskBounds" ? R.growMaskBounds(d, W, H, ARGS.n, { ms: parts }) : R.growMask(d, W, H, ARGS.n, { ms: parts });
        out.wall = ms(t);
        out.parts = Object.fromEntries(Object.entries(parts).map(([key, v]) => [key, r1(v)]));
        if (ARGS.route === "growMaskBounds") out.bounds = r;
        out.pxCalls = await pxc(true);
        d = null;
"""


async def collect(c):
    """A full garbage collection in the page, so one run's dead buffers (a 600 MB mask, a released wasm instance of a
    GB or more) are not the next run's memory."""
    try:
        await c.call("HeapProfiler.collectGarbage")
    except Exception:  # noqa: BLE001 - the measurement goes on without it
        pass


async def row_freqsep_4000(c):
    synthetic = SIZE is not None or not os.path.exists(IMAGE)
    w, h = SIZE or (4512, 4512)
    args = {"synthetic": synthetic, "w": w, "h": h, "image": IMAGE, "side": 4000, "radius": 40,
            "x": None if synthetic else 5500, "y": None if synthetic else 3000}
    return await js(c, K0B + FREQSEP, **args)


async def stitch_align(c, side):
    if SIZE:
        side = max(256, min(SIZE) // 64 * 64)
    return await js(c, K0B + STITCH_ALIGN, side=side, pad=side // 8, margin=256, runs=3)


async def row_stitch_align_2048(c):
    return await stitch_align(c, 2048)


async def row_stitch_align_4096(c):
    return await stitch_align(c, 4096)


async def row_match_fallback_16k(c):
    w, h = SIZE or (4096, 4096)
    return await js(c, K0B + MATCH_FALLBACK, w=w, h=h, runs=3)


GROW_N = 20
GROW_RUNS = 3


async def row_grow_fallback_15k(c):
    W, H = SIZE or (15000, 10000)
    ladder = [(max(16, round(W / k)), max(16, round(H / k))) for k in (2, 2 ** 0.5, 1)]
    out = {"n": GROW_N, "runs": GROW_RUNS, "ladder": [list(s) for s in ladder], "steps": [], "largest_ok": {}, "stopped": {}}
    gone = None
    for w, h in ladder:
        step = {"size": [w, h], "MP": round(w * h / 1e6, 1)}
        for route in ("growMask", "growMaskBounds"):
            if route in out["stopped"]:
                continue
            runs = []
            for _ in range(GROW_RUNS):
                try:
                    v = await js(c, GROW_STEP, timeout=300, w=w, h=h, n=GROW_N, route=route)
                except Exception as e:  # noqa: BLE001 - the page did not answer: the renderer is gone or hangs
                    gone = "%s at %d x %d: %s" % (route, w, h, str(e)[:300])
                    break
                if not isinstance(v, dict) or v.get("error"):
                    out["stopped"][route] = "%d x %d: %s" % (w, h, (v or {}).get("error", v) if isinstance(v, dict) else v)
                    break
                runs.append(v)
                await collect(c)
            if runs and len(runs) == GROW_RUNS:
                walls = [r["wall"] for r in runs]
                parts = {}
                for r in runs:
                    for k, x in (r.get("parts") or {}).items():
                        parts.setdefault(k, []).append(x)
                step[route] = {"wall": round(statistics.median(walls), 1), "walls": walls,
                               "parts": {k: round(statistics.median(x), 1) for k, x in parts.items()},
                               "kernels": runs[0].get("kernels"), "pxCalls": runs[0].get("pxCalls")}
                if route == "growMaskBounds":
                    step[route]["bounds"] = runs[0].get("bounds")
                out["largest_ok"][route] = [w, h]
            elif runs:
                step[route] = {"partial": [r["wall"] for r in runs]}
            if gone:
                break
        print("   step %d x %d: %s" % (w, h, json.dumps(step)), flush=True)
        out["steps"].append(step)
        if gone:
            out["renderer"] = "no answer (gone or hung; the rows after this one cannot run): " + gone
            break
    return out


ROWS.update({
    "freqsep_4000": row_freqsep_4000,
    "stitch_align_2048": row_stitch_align_2048,
    "stitch_align_4096": row_stitch_align_4096,
    "match_fallback_16k": row_match_fallback_16k,
    "grow_fallback_15k": row_grow_fallback_15k,   # last: see the module's docstring
})


async def main():
    results = {}

    async def go(c):
        await c.call("Page.bringToFront")
        await c.eval("(async () => { await import('./shell.js'); return 1; })()")
        only = next((a.split("=", 1)[1].split(",") for a in sys.argv if a.startswith("--rows=")), None)
        for name, body in ROWS.items():
            if only and name not in only:
                continue
            print(f"== {name} ...", flush=True)
            try:
                if callable(body):   # a K0a row: Python around its own page scripts
                    val = await body(c)
                else:
                    src = PRE % (body % {"image": json.dumps(IMAGE), "png": json.dumps(os.path.join(TMP, "w0_15k.png"))} if "%(" in body else body)
                    raw = await c.eval(src, timeout=1800)
                    val = json.loads(raw) if isinstance(raw, str) else raw
            except Exception as e:  # noqa: BLE001 - a row never stops the rest
                val = {"error": str(e)[:600]}
            results[name] = val
            print(f"   {json.dumps(val)}", flush=True)
    await session(go)
    if JSON_OUT:
        with open(JSON_OUT, "w", encoding="utf-8", newline=chr(10)) as f:
            json.dump(results, f, indent=1)
    print("RESULT")


if __name__ == "__main__":
    asyncio.run(main())
