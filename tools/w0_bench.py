"""W0 of docs/PLAN_WASM.md: the JS paths no other harness times, measured in the running app (2026-10-23).

No ComfyUI. Start the app offline with a debugging port and keep its window in front (V8's efficiency mode slows JS,
not wasm, in a window behind: docs/PERFORMANCE.md section 10):

    ./node_modules/.bin/electron . --remote-debugging-port=9555 --user-data-dir=<scratch> --no-comfy
    python tools/w0_bench.py [--json out.json] [--image=path/to/15k.jpg] [--files DIR] [--rows=name,name]

Each row runs the module's own function on synthetic data of a stated size (a median of several runs where it is cheap)
or, for the 15k rows, the editor's command on the picture. It never fails the caller: a row that throws prints its
error and the rest go on. Rows:

  freqsep_15k         the 15k picture: load_image of the JPEG, export a 15k PNG, load_image of it (wall each), then
                      frequency_separation of a 4000 x 4000 box (its limit is 16 MP)
  edgefit_2048        edgefit.fitLayerRGBA on a 2048^2 base and a shifted copy; warpRGBA alone
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
"""
import asyncio
import json
import os
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

PRE = """(async () => {
    const commands = (await import('./commands.js')).commands;
    const host = (await import('./editor/host.js')).host;
    const run = (n, a) => commands.run(n, a || {});
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return +s[Math.floor(s.length / 2)].toFixed(2); };
    const time = async (fn, n = 5) => { const ts = []; for (let i = 0; i < n; i++) { const a = performance.now(); await fn(i); ts.push(performance.now() - a); } return { median: median(ts), max: +Math.max(...ts).toFixed(2), n }; };
    const noise = (n, seed = 7) => { const a = new Uint8ClampedArray(n); let s = seed >>> 0; for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; a[i] = s >>> 24; } return a; };
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
        out.fit = await time(() => E.fitLayerRGBA({ baseRGBA: base, layerRGBA: layer, w, h }), 3);
        out.warp = await time(() => E.warpRGBA(layer, w, h, [1, 0, 3, 0, 1, 2]), 3);
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


async def js(c, body, **args):
    raw = await c.eval(script(body, **args), timeout=1800)
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
