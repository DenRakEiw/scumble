"""Phase R: the worker jobs with a pixel kernel, JS against Rust, where they run (docs/PLAN_BCE.md §2b).

Start the app with a debugging port first (see tools/cdp.py), then:

    python tools/px_jobs.py                        # equality at 2048x1152, then timings at 15000x10000
    python tools/px_jobs.py --rounds 5 12000x8000  # timings only, one size
    python tools/px_jobs.py --check 2048x1152 --only range_depth,fill_limit   # bytes and timings of some rows

Each size builds a document in its own tab (a gradient base with discs, one full-size paint layer) and runs,
per round and per kernel set (`InpaintEditor.kernels` "js" or "rust", the order alternating by round):

  mips          the mips worker job on every tile of the base, in the scheduler's batches of 128 (copies of the
                tiles through the editor's own transport), and the same after a whole change of the paint layer
                (a flip) until the scheduler has settled
  grow / shrink the selection job for grow +16 / shrink -16 on a rectangle of 40 % of each side
  wand          a whole-picture region (a band across the gradient) and a bounded one (inside a disc)
  band          the kernel of phase E's band export, which has no caller yet: one row of tiles across the image
                in the editor's worker, four layers over the base tile (over, over at 200 with a mask, erase at 64,
                atop), the paint layer's tiles as every source and its alpha as the mask
  wand_add      the band's wand in add mode over the rectangle: the flood job, then the window's combine
  invert        invert of the rectangle on the window (no job: the wall, and the window's px calls)
  range_depth   select by range on the depth map, edge snap off (the range_select jobs, the window's "range" marks)
  range_depth_snap  the same with snap at the default strength; beside it, cold and outside the row's wall, the
                edge rows' two steps selectRange caches: the rows' max ("rmax", a kernel) and the edge tiles ("edges")
  range_luma / range_color  select by range on the picture's luma, on a colour (the picture read through the
                held stack: the range_select jobs and their stack_into jobs; with the twins the stack is not held
                (`partsUsable` wants Rust) and the window reads the picture). The range_select job itself is the same JS
                in both sets so far: its time is the "worker job" column, summed over jobs that run side by side
  depth_guide   a depth map from the paint layer (`depthFromLayer`: the window's reads, the depth_guide job, the map
                stored); the document's own map is put back after it
  fill_limit    a fill layer's rows with a depth limit as the layered export reads them (`fillLayerRows`): per band
                of 256 rows `fillPixels`, then `limitAlphaRows`, on the window

The depth rows use a map made here as the app keeps one (docs/PLAN_WASM_BUILD.md K0b): at the work size (the long
side up to 4096), the picture at that size as its guide; the depth a slope with the base's discs standing nearer, so
no model is downloaded.

The worker replies with the milliseconds of each part of a job (`timing`), which the table splits into the
kernel's part and the rest; "wall" is the operation on the main thread. Each row also prints the px module's calls by
export (px.js counters): on the window, and in the row's jobs (`timing.pxCalls`); "-" in a build without them. With
`--check` (the default for the first, small size) the two kernel sets must give the same bytes: every chain and edge
chain of the mips job, the selection after grow, shrink, both wands, wand_add, invert and the range rows, the depth
map of depth_guide and the rows of fill_limit. Restart the app before a timing run.
"""
import asyncio
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

args = [a for a in sys.argv[1:]]
ROUNDS = 3
if "--rounds" in args:
    i = args.index("--rounds")
    ROUNDS = int(args[i + 1])
    del args[i:i + 2]
ONLY = None
if "--only" in args:   # one job or a comma list, e.g. --only wand_object
    i = args.index("--only")
    ONLY = args[i + 1].split(",")
    del args[i:i + 2]
SIZES = [a for a in args if not a.startswith("-")]
RUNS = [(s, False) for s in SIZES] if SIZES else [("2048x1152", True), ("15000x10000", False)]
if "--check" in args:
    RUNS = [(s, True) for s, _ in RUNS]

BODY = """
(async () => {
    const W = %(w)d, H = %(h)d, ROUNDS = %(rounds)d, CHECK = %(check)s;
    const ONLY = %(only)s;
    const wanted = (job) => !ONLY || ONLY.includes(job);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const shell = await import("./shell.js");
    const T = await import("./editor/inpaint_tiles.js");
    window.__pxjobs = "document";
    const ed = shell.newDocument();
    shell.activate(ed);
    await sleep(300);
    ed.resizeCanvas();
    if (!ed.tileMode) throw new Error("phase R measures the tile engine: start the app with tiles on");
    const E = ed.constructor;
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const base = mk(W, H);
    {
        const x = base.getContext("2d");
        const g = x.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "hsl(210,70%%,45%%)");
        g.addColorStop(1, "hsl(300,70%%,25%%)");
        x.fillStyle = g;
        x.fillRect(0, 0, W, H);
        for (let i = 0; i < 60; i++) {
            x.fillStyle = `hsl(${(i * 37) %% 360},80%%,55%%)`;
            x.beginPath();
            x.arc((i * 977) %% W, (i * 613) %% H, Math.max(8, W / 40), 0, Math.PI * 2);
            x.fill();
        }
    }
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "pxjobs.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
    base.width = 1;
    const pc = mk(W, H);
    {
        const x = pc.getContext("2d");
        x.fillStyle = "hsla(60,80%%,50%%,0.35)";
        x.fillRect(40, 40, W - 120, H - 120);
        for (let k = 0; k < 20; k++) { x.fillStyle = `hsl(${(k * 53) %% 360},70%%,60%%)`; x.fillRect((k * 811) %% W, (k * 457) %% H, W / 25, H / 25); }
    }
    const paint = ed.addLayer({ name: "Paint", kind: "paint", px: ed.pixels.Layer.fromCanvas(pc), x: 0, y: 0, w: W, h: H, dirty: true });
    pc.width = 1;
    ed.renderLayers(); ed.fitView(); ed.draw();
    await ed.mipsSettled();

    const EDG = await import("./editor/inpaint_edges.js");
    const MAPS = await import("./editor/inpaint_maps.js");
    const FIL = await import("./editor/inpaint_filters.js");
    const LIM = await import("./editor/inpaint_limit.js");
    const { host } = await import("./editor/host.js");
    // the depth rows' map, as the app keeps one: at the work size, the picture at that size as its guide, edge snap at
    // the default strength. The depth a slope from far at the top left to near at the bottom right, the base's discs
    // standing nearer than the slope around them: a range cuts a band across the picture with the discs as holes, and
    // the discs' rims are the edges snap works on.
    if (["range_depth", "range_depth_snap", "depth_guide", "fill_limit"].some(wanted)) {
        const DEP = await import("./editor/inpaint_depth.js");
        const [gw, gh] = DEP.workSize(W, H);
        const sx = gw / W, sy = gh / H;
        const depth = new Uint16Array(gw * gh);
        for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) depth[y * gw + x] = Math.round((0.15 + 0.5 * x / gw + 0.2 * y / gh) * 65535);
        const r = Math.max(8, W / 40);
        for (let i = 0; i < 60; i++) {
            const cx = ((i * 977) %% W) * sx, cy = ((i * 613) %% H) * sy, rx = r * sx, ry = r * sy;
            const v = Math.round((0.9 - (i %% 5) * 0.03) * 65535);
            for (let y = Math.max(0, Math.floor(cy - ry)); y < Math.min(gh, Math.ceil(cy + ry)); y++) {
                for (let x = Math.max(0, Math.floor(cx - rx)); x < Math.min(gw, Math.ceil(cx + rx)); x++) {
                    const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
                    if (dx * dx + dy * dy <= 1) depth[y * gw + x] = v;
                }
            }
        }
        const guide = await host.pictureInput(ed, gw, gh, { skipFilters: true, background: "#808080" });
        await ed.setMap("depth", MAPS.makeMap("depth", gw, gh, depth, [W, 0, 0, H, 0, 0], { snap: { strength: EDG.SNAP_DEFAULT } }, guide.image));
        ed.clearUndo();
    }

    const hex = async (u8) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", u8))).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
    const selHash = async () => hex(ed.sel.readRect(0, 0, W, H).data);
    const rect = () => {
        ed.sel.clear();
        ed.sel.fill([Math.round(W * 0.2), Math.round(H * 0.2), Math.round(W * 0.6), Math.round(H * 0.6)], "#ff0000");
        ed.markSelectionChanged();
        ed.getBounds();
    };
    // the numbers of the jobs summed by name (`kernels`, `source` and the px calls are not numbers); a job of an op after
    // the first of `ops` sums under "<op>.<name>", so a range row keeps its stack_into jobs' kernel apart from its own
    const parts = (list, ops = null) => {
        const out = {};
        for (const t of list) {
            const pre = ops && t.op !== ops[0] ? t.op + "." : "";
            for (const [k, v] of Object.entries(t)) if (typeof v === "number") out[pre + k] = (out[pre + k] || 0) + v;
            out[pre + "jobs"] = (out[pre + "jobs"] || 0) + 1;
        }
        if (!out.jobs) out.jobs = 0;
        return out;
    };
    // the px module's calls by export (px.js counters, K0b): the window's read and cleared, a job's in its `timing.pxCalls`;
    // null in a build without them
    const pxCalls = () => (typeof E.pxCalls === "function" ? E.pxCalls(true) : null);
    const callsOf = (list) => {
        let out = null;
        for (const t of list) if (t.pxCalls && typeof t.pxCalls === "object") {
            out = out || {};
            for (const [k, n] of Object.entries(t.pxCalls)) if (typeof n === "number") out[k] = (out[k] || 0) + n;
        }
        return out;
    };
    // the window's step marks (inpaint_jobs.js `markStep`) as durations, as native_test.py takes them: per op a list of
    // runs, a "start" opens a run, each step the ms since the op's mark before it (a step seen twice in a run sums),
    // total the last mark against the start, the marks' own values in `extra`
    const stepMarks = () => (typeof E.stepMarks === "function" ? E.stepMarks(true) : []);
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

    // the base's tiles, as the scheduler hands them over (copies: the transport transfers its buffers)
    const tileList = (px) => {
        const list = [];
        for (const [key, t] of px._tiles) {
            const tx = key & 0xffff, ty = key >>> 16, ox = tx << 8, oy = ty << 8;
            const vw = Math.min(256, px._w - ox), vh = Math.min(256, px._h - oy);
            if (vw > 0 && vh > 0) list.push({ t, vw, vh });
        }
        return list;
    };
    const transport = T.chainScheduler().transport;
    if (!transport) throw new Error("no mips transport (no worker)");
    const mipsDirect = async (kernels) => {
        E.kernels = kernels;
        const list = tileList(ed.basePx);
        E.jobTimings(true);
        pxCalls();
        const chains = [];
        const t0 = performance.now();
        for (let i = 0; i < list.length; i += 128) {   // one flight at a time, as the scheduler sends them
            const batch = list.slice(i, i + 128).map((e) => ({ data: e.t.data.slice().buffer, vw: e.vw, vh: e.vh }));
            chains.push(await transport(batch));
        }
        const wall = performance.now() - t0;
        let digest = null;
        if (CHECK) {
            let total = 0;
            for (const r of chains) for (let k = 0; k < r.chains.length; k++) { total += r.chains[k].byteLength + (r.exts[k] ? r.exts[k].byteLength : 0); }
            const all = new Uint8Array(total);
            let o = 0;
            for (const r of chains) for (let k = 0; k < r.chains.length; k++) {
                all.set(new Uint8Array(r.chains[k]), o); o += r.chains[k].byteLength;
                if (r.exts[k]) { all.set(new Uint8Array(r.exts[k]), o); o += r.exts[k].byteLength; }
            }
            digest = await hex(all);
        }
        const timings = E.jobTimings(true).filter((t) => t.op === "mips");
        return { wall, ...parts(timings), digest, tilesSent: list.length, px: { window: pxCalls(), workers: callsOf(timings) } };
    };
    const bandJob = async (kernels) => {
        E.kernels = kernels;
        const ty = Math.floor(H / 512);   // the middle tile row
        const columns = [];
        for (let tx = 0; tx * 256 < W; tx++) {
            const b = ed.basePx._tiles.get((ty << 16) | tx), q = paint.px._tiles.get((ty << 16) | tx);
            const dst = b ? b.data.slice().buffer : new ArrayBuffer(256 * 256 * 4);
            const src = q ? q.data : new Uint8Array(256 * 256 * 4);
            const mask = new Uint8Array(256 * 256);
            for (let i = 0; i < mask.length; i++) mask[i] = src[i * 4 + 3];
            columns.push({ dst, srcs: [0, 1, 2, 3].map(() => src.slice().buffer), masks: [null, mask.buffer, null, null] });
        }
        const transfer = [];
        for (const c of columns) transfer.push(c.dst, ...c.srcs, c.masks[1]);
        E.jobTimings(true);
        pxCalls();
        const t0 = performance.now();
        const r = await E.workerJob("band", { columns, ops: [0, 0, 1, 2], alphas: [255, 200, 64, 255] }, transfer);
        const wall = performance.now() - t0;
        let digest = null;
        if (CHECK) {
            const all = new Uint8Array(r.dsts.length * 256 * 256 * 4);
            r.dsts.forEach((d, i) => all.set(new Uint8Array(d), i * 256 * 256 * 4));
            digest = await hex(all);
        }
        const timings = E.jobTimings(true).filter((t) => t.op === "band");
        return { wall, ...parts(timings), digest, px: { window: pxCalls(), workers: callsOf(timings) } };
    };
    const mipsWhole = async (kernels) => {
        E.kernels = kernels;
        await ed.mipsSettled();
        await sleep(50);
        E.jobTimings(true);
        pxCalls();
        T.chainStats(true);
        const t0 = performance.now();
        paint.px = ed.turnedTilePixels(paint.px, "h");
        ed.markLayerChanged(paint);
        ed.renderLayers();
        ed.draw();
        await ed.mipsSettled();
        const wall = performance.now() - t0;
        const onWindow = pxCalls();
        const cs = T.chainStats();
        const timings = E.jobTimings(true).filter((t) => t.op === "mips");
        // flipped back, so every kernel set's selection jobs see the same picture
        paint.px = ed.turnedTilePixels(paint.px, "h");
        ed.markLayerChanged(paint);
        ed.renderLayers();
        ed.draw();
        await ed.mipsSettled();
        E.jobTimings(true);
        return { wall, ...parts(timings), main: cs.main, requested: cs.requested, px: { window: onWindow, workers: callsOf(timings) } };
    };
    // an operation on the document: `want` the op (or ops, the first the row's own) of the jobs it posts, null for one
    // on the window; `marks` the op of the window's step marks it keeps; `sel` false for a row whose bytes are not the
    // selection
    const op = async (kernels, fn, want, { marks = null, sel = true } = {}) => {
        E.kernels = kernels;
        await ed.mipsSettled();
        await sleep(50);
        E.jobTimings(true);
        stepMarks();
        pxCalls();
        const t0 = performance.now();
        await fn();
        const wall = performance.now() - t0;
        const onWindow = pxCalls();
        const ops = want === null ? [] : [].concat(want);
        const timings = E.jobTimings(true).filter((t) => ops.includes(t.op));
        const out = { wall, ...parts(timings, ops), px: { window: onWindow, workers: callsOf(timings) } };
        if (marks) out.marks = markRuns(stepMarks())[marks] || [];
        if (CHECK && sel) out.digest = await selHash();
        await ed.mipsSettled();
        return out;
    };
    // the map's edge snap (the panel's Edges slider): 0 for the plain depth rows, the default for the snapped ones
    const snapTo = (strength) => {
        const m = ed.maps && ed.maps.depth;
        if (m && (m.meta && m.meta.snap && m.meta.snap.strength != null ? m.meta.snap.strength : EDG.SNAP_DEFAULT) !== strength) {
            ed.setMapMeta("depth", { snap: { ...((m.meta && m.meta.snap) || {}), strength } });
        }
    };
    const LIMITS = {   // [the limit, the snap strength (null: not a depth row)]
        range_depth: [{ source: "depth", lo: 0.3, hi: 0.6, fLo: 0.05, fHi: 0.05 }, 0],
        range_depth_snap: [{ source: "depth", lo: 0.3, hi: 0.6, fLo: 0.05, fHi: 0.05 }, EDG.SNAP_DEFAULT],
        range_luma: [{ source: "luma", lo: 0.35, hi: 0.65, fLo: 0.1, fHi: 0.1 }, null],
        range_color: [{ source: "color", color: "#c040a0", tol: 30, lo: 0.5, hi: 1, fLo: 0.1, fHi: 0 }, null],
    };
    const rangeRow = async (kernels, job) => {
        const [limit, strength] = LIMITS[job];
        if (strength !== null) snapTo(strength);
        const extra = {};
        if (strength) {
            // the edge rows' two steps, cold and outside the row's wall (selectRange keeps the rows' max per map)
            E.kernels = kernels;
            const map = ed.maps.depth;
            const a = performance.now();
            const rmax = EDG.rangeMax(map);
            const b = performance.now();
            const flags = EDG.edgeTiles(map, rmax, MAPS.passToMap(map, 1), W, H, EDG.snapParams(strength)[1], 256);
            const c = performance.now();
            extra.rmax = b - a;
            extra.edges = c - b;
            extra.edgeTiles = flags.reduce((s, f) => s + f, 0);
        }
        let res = null;
        const out = await op(kernels, async () => { res = await ed.selectRange(limit, "replace"); }, ["range_select", "stack_into"], { marks: "range" });
        return { ...out, ...extra, ...(res && res.ms != null ? { selMs: res.ms } : {}) };   // selectRange's own ms (K0b)
    };
    const depthGuideRow = async (kernels) => {
        const keep = ed.maps && ed.maps.depth;
        let map = null;
        const out = await op(kernels, async () => { map = await ed.depthFromLayer(paint); }, "depth_guide", { sel: false });
        if (CHECK) out.digest = map ? await hex(new Uint8Array(map.data.slice().buffer)) : null;
        if (keep) await ed.setMap("depth", keep);
        return out;
    };
    // a fill layer with a depth limit as the layered export reads it (`fillLayerRows`, inpaint_canvas.js): per band of
    // 256 rows (bandRows' default) the fill's pixels, then `limitAlphaRows` over them, the map snapped at the default
    const fillLimitRow = async (kernels) => {
        E.kernels = kernels;
        snapTo(EDG.SNAP_DEFAULT);
        await ed.mipsSettled();
        await sleep(50);
        const map = ed.maps.depth, limit = LIMITS.range_depth[0], p = { color: "#3080c0" };
        let fill = 0, lim = 0, bands = 0;
        const digests = [];
        pxCalls();
        for (let y0 = 0; y0 < H; y0 += 256) {
            const y1 = Math.min(H, y0 + 256);
            const a = performance.now();
            const rows = FIL.fillPixels("fill", p, [W, H], [0, y0], W, y1 - y0);
            const b = performance.now();
            LIM.limitAlphaRows(rows, 0, y0, W, y1 - y0, limit, map);
            fill += b - a; lim += performance.now() - b; bands++;
            if (CHECK) digests.push(new Uint8Array(await crypto.subtle.digest("SHA-256", rows)));   // per band, outside the times
        }
        const out = { wall: fill + lim, fill, limit: lim, bands, jobs: 0, px: { window: pxCalls(), workers: null } };
        if (CHECK) {
            const all = new Uint8Array(digests.length * 32);
            digests.forEach((d, i) => all.set(d, i * 32));
            out.digest = await hex(all);
        }
        return out;
    };

    const rows = [];
    const step = async (job, k, round, fn) => {
        if (!wanted(job)) return;
        window.__pxjobs = `${job} ${k} round ${round}`;
        rows.push({ job, kernels: k, round, ...(await fn()) });
    };
    if (wanted("range_depth_snap")) {
        // selectRange keeps the rows' max per map: one select before the rounds, so every snapped row finds it there
        // (the row's own `rmax` times it cold)
        snapTo(EDG.SNAP_DEFAULT);
        await ed.selectRange(LIMITS.range_depth_snap[0], "replace");
        ed.sel.clear();
        ed.markSelectionChanged();
        ed.clearUndo();
    }
    for (let round = 0; round < ROUNDS; round++) {
        const order = round %% 2 ? ["rust", "js"] : ["js", "rust"];
        for (const k of order) {
            await step("mips_direct", k, round, () => mipsDirect(k));
            await step("mips_whole", k, round, () => mipsWhole(k));
            await step("band", k, round, () => bandJob(k));
            ed.clearUndo();
            rect();
            await step("grow", k, round, () => op(k, () => ed.growSelection(16), "selection"));
            await step("shrink", k, round, () => op(k, () => ed.growSelection(-16), "selection"));
            rect();
            await step("wand_band", k, round, () => op(k, () => ed.wandSelect(Math.round(W * 0.1), Math.round(H * 0.1), "replace"), "flood"));
            rect();
            await step("wand_object", k, round, () => op(k, () => ed.wandSelect(977 %% W, 613 %% H, "replace"), "flood"));
        }
        // K0b's rows after both sets' rows of before, so those run in the order and state they ran in W0
        for (const k of order) {
            rect();
            await step("wand_add", k, round, () => op(k, () => ed.wandSelect(Math.round(W * 0.1), Math.round(H * 0.1), "add"), "flood"));
            rect();
            await step("invert", k, round, () => op(k, async () => { await ed.invertSelection(); ed.getBounds(); }, null));
            ed.clearUndo();
            for (const job of ["range_depth", "range_depth_snap", "range_luma", "range_color"]) await step(job, k, round, () => rangeRow(k, job));
            await step("depth_guide", k, round, () => depthGuideRow(k));
            await step("fill_limit", k, round, () => fillLimitRow(k));
            ed.clearUndo();
        }
        // the next round's mips_direct starts, as in W0, with no selection and nothing pending
        ed.sel.clear();
        ed.markSelectionChanged();
        await ed.mipsSettled();
    }
    window.__pxjobs = "done";
    E.kernels = "rust";   // the default since phase R; "js" here left every later gate of the instance on the twins
    shell.closeDocument(ed, { force: true });
    return JSON.stringify({ size: `${W}x${H}`, rows, focused: document.hasFocus(), visibility: document.visibilityState, cores: navigator.hardwareConcurrency });
})()
"""

PARTS = {
    "mips_direct": ["kernel"],
    "mips_whole": ["kernel"],
    "band": ["kernel"],
    "grow": ["kernel", "edt", "bounds", "feature", "write", "read", "put", "resultBounds"],
    "shrink": ["kernel", "edt", "bounds", "feature", "write", "read", "put", "resultBounds"],
    "wand_band": ["flood", "read", "clip", "bounds", "shape"],
    "wand_object": ["flood", "read", "clip", "bounds", "shape"],
    "wand_add": ["flood", "read", "clip", "bounds", "shape"],
    "invert": [],
    # range_select's `ms` is the job's own time; a luma or colour row reads the picture through stack_into jobs
    "range_depth": ["ms"],
    "range_depth_snap": ["ms", "rmax", "edges"],
    "range_luma": ["ms", "stack_into.kernel"],
    "range_color": ["ms", "stack_into.kernel"],
    "depth_guide": ["total"],
    "fill_limit": ["fill", "limit"],
}
# the pixel work a kernel set does after the job has read its pixels: with Rust the grow job is one call ("kernel"),
# the flood job one call ("flood") between reading the selection ("clip") and drawing the shape ("shape")
PIXEL_WORK = ["kernel", "edt", "bounds", "feature", "write", "resultBounds"]
# No kernel column where no part of the row is a kernel's own: invert and the range rows (range_select is the same JS in
# both sets, measured 2026-10-23: no px call in its jobs; its time is the "worker job" column), depth_guide (one part,
# `total`, the worker job column) and fill_limit (limitAlphaRows has no Rust kernel yet: its parts line).
KERNEL = {"mips_direct": ["kernel"], "mips_whole": ["kernel"], "band": ["kernel"], "grow": PIXEL_WORK, "shrink": PIXEL_WORK,
          "wand_band": ["flood", "clip", "bounds", "shape"], "wand_object": ["flood", "clip", "bounds", "shape"],
          "wand_add": ["flood", "clip", "bounds", "shape"], "invert": [],
          "range_depth": [], "range_depth_snap": [], "range_luma": [], "range_color": [],
          "depth_guide": [], "fill_limit": []}
# the "worker job" column: the job's whole time where it is not `total` or `kernel`; None where the row posts no job
WORKER = {"invert": None, "fill_limit": None, "depth_guide": "total",
          "range_depth": "ms", "range_depth_snap": "ms", "range_luma": "ms", "range_color": "ms"}


def med(rows, key):
    vals = [r.get(key, 0) for r in rows]
    return statistics.median(vals) if vals else 0


def calls(row, where):
    """A row's px calls on the window or in its jobs, by export; "-" in a build without the counters."""
    c = (row.get("px") or {}).get(where)
    if c is None:
        return "-"
    return ", ".join(f"{k} {v}" for k, v in sorted(c.items())) or "none"


def first_run(row):
    """The row's first run of its marks' op ({} when it has none)."""
    runs = row.get("marks") or []
    return runs[0] if runs else {}


def mark_med(rows, step):
    """The median over rows of a step of their first run (0 where a row has no such step)."""
    return statistics.median([first_run(r).get(step, 0) for r in rows])


def extra_med(rows, key):
    """The median over rows of a mark's own value in their first run (0 where a row has none)."""
    return statistics.median([(first_run(r).get("extra") or {}).get(key, 0) for r in rows])


def report(result, check):
    rows = result["rows"]
    print(f"\n== {result['size']}  (window focused {result.get('focused')}, {result.get('visibility')}, {result.get('cores')} logical cores)")
    bad = 0
    for job in PARTS:
        js = [r for r in rows if r["job"] == job and r["kernels"] == "js"]
        rs = [r for r in rows if r["job"] == job and r["kernels"] == "rust"]
        if not js or not rs:
            continue
        if check and job != "mips_whole":   # no bytes of its own: the chains land in the tile store
            digests = {r.get("digest") for r in js + rs}
            same = len(digests) == 1 and None not in digests
            bad += 0 if same else 1
            print(f"  {job:16s} {'same bytes' if same else 'DIFFERENT BYTES ' + str(sorted(d or '-' for d in digests))}")
        kj = sum(med(js, k) for k in KERNEL[job])
        kr = sum(med(rs, k) for k in KERNEL[job])
        wkey = WORKER.get(job, "")
        if wkey:
            tj, tr = med(js, wkey), med(rs, wkey)
        else:
            tj, tr = med(js, "total") or med(js, "kernel"), med(rs, "total") or med(rs, "kernel")
        wj, wr = med(js, "wall"), med(rs, "wall")
        extra = ""
        if job.startswith("mips") or job == "band":
            extra = f"  tiles {med(js, 'tiles'):.0f} in {med(js, 'jobs'):.0f} jobs"
            if job == "mips_whole":
                extra += f", built on the main thread js {med(js, 'main'):.0f} / rust {med(rs, 'main'):.0f}"
        elif job.startswith("range"):
            extra = f"  {med(js, 'tiles'):.0f} partial tiles in {med(js, 'jobs'):.0f} jobs"
            if med(js, "stack_into.jobs") or med(rs, "stack_into.jobs"):
                # the pool composites the picture only with the Rust kernels (`partsUsable`); with the twins the window
                # reads it (`readBox`), inside the marks' read
                extra += f", the picture in stack_into jobs js {med(js, 'stack_into.jobs'):.0f} / rust {med(rs, 'stack_into.jobs'):.0f}"
            if med(js, "selMs") or med(rs, "selMs"):
                extra += f", selectRange's ms js {med(js, 'selMs'):.1f} / rust {med(rs, 'selMs'):.1f}"
            if job == "range_depth_snap":
                extra += f", {med(js, 'edgeTiles'):.0f} edge tiles"
        elif job == "invert":
            extra = ""
        elif job == "depth_guide":
            extra = f"  {med(js, 'jobs'):.0f} jobs"
        elif job == "fill_limit":
            extra = f"  {med(js, 'bands'):.0f} bands of 256 rows"
        else:
            extra = f"  {med(js, 'pixels') / 1e6:.1f} MP in {med(js, 'jobs'):.0f} jobs"
        cols = []
        if KERNEL[job]:
            cols.append(f"kernel js {kj:8.1f}  rust {kr:8.1f}  ({kj / kr if kr else 0:4.2f}x)")
        if wkey is not None:
            cols.append(f"worker job js {tj:8.1f}  rust {tr:8.1f}  ({tj / tr if tr else 0:4.2f}x)")
        cols.append(f"wall js {wj:8.1f}  rust {wr:8.1f}  ({wj / wr if wr else 0:4.2f}x)")
        print(f"  {job:16s} " + " | ".join(cols) + extra)
        detail = "  ".join(f"{k} {med(js, k):.1f}/{med(rs, k):.1f}" for k in PARTS[job] if med(js, k) or med(rs, k))
        if detail:
            print(f"  {'':16s} parts js/rust: {detail}")
        # the window's step marks (range rows): each step the ms since the mark before it, medians over the rounds
        if any(first_run(r) for r in js + rs):
            steps = []
            for r in js + rs:
                steps += [k for k in first_run(r) if k not in ("total", "extra", "nostart") and k not in steps]
            marks = "  ".join(f"{k} {mark_med(js, k):.1f}/{mark_med(rs, k):.1f}" for k in steps + ["total"])
            # the marks' own ms (the picture's read summed over the bands, the window's combine), medians; the rest of
            # the first Rust run's values as they are
            timed = [k for k in ("readMs", "loopMs", "combineMs") if any(k in (first_run(r).get("extra") or {}) for r in js + rs)]
            if timed:
                marks += "; " + "  ".join(f"{k[:-2]} {extra_med(js, k):.1f}/{extra_med(rs, k):.1f}" for k in timed)
            more = {k: v for k, v in (first_run(rs[0]).get("extra") or {}).items() if k not in timed and k != "ms"}
            runs = max(len(r.get("marks") or []) for r in js + rs)
            print(f"  {'':16s} marks js/rust: {marks}" + (f"  (rust: {', '.join(f'{k} {json.dumps(v)}' for k, v in more.items())})" if more else "")
                  + (f"  ({runs} runs in a row: the first)" if runs > 1 else ""))
        print(f"  {'':16s} px calls js: window {calls(js[0], 'window')}; jobs {calls(js[0], 'workers')}"
              f" | rust: window {calls(rs[0], 'window')}; jobs {calls(rs[0], 'workers')}")
    return bad


async def main():
    sys.stdout.reconfigure(encoding="utf-8")

    async def run(c):
        bad = 0
        for size, check in RUNS:
            w, h = (int(v) for v in size.lower().split("x"))
            print(f"-- {size} ({w * h / 1e6:.1f} MP), {ROUNDS} rounds{', checking bytes' if check else ''} ...", flush=True)
            body = BODY % {"w": w, "h": h, "rounds": ROUNDS if not check or SIZES else 1, "check": "true" if check else "false", "only": json.dumps(ONLY)}
            result = json.loads(await c.eval(body, timeout=3600))
            bad += report(result, check)
            if os.environ.get("PX_JOBS_JSON"):
                with open(os.environ["PX_JOBS_JSON"], "a", encoding="utf-8") as f:
                    f.write(json.dumps(result) + "\n")
        print("\nFAIL" if bad else "\nPASS")
        return bad

    bad = await session(run)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    asyncio.run(main())
