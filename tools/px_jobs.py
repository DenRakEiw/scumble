"""Phase R: the worker jobs with a pixel kernel, JS against Rust, where they run (docs/PLAN_BCE.md §2b).

Start the app with a debugging port first (see tools/cdp.py), then:

    python tools/px_jobs.py                        # equality at 2048x1152, then timings at 15000x10000
    python tools/px_jobs.py --rounds 5 12000x8000  # timings only, one size
    python tools/px_jobs.py --check 2048x1152 --only range_depth,fill_limit   # bytes and timings of some rows
    python tools/px_jobs.py --ab flood=js:rust --only wand_object,flood_ladder --split 15000x10000   # one route's arms

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
  flood_ladder_<s>  the wand inside a black square of s x s (256 to 8192, the sizes that fit), each square in a white
                frame of 2 px so the region stops at it whatever lies below; the squares lie apart on one top paint
                layer, added before each step and removed after it, outside the clock. The row's `key` is its box job's
                box in pixels (the row's last flood job, the fine pass's final box), the size a numeric `flood` route
                compares (docs/PLAN_WASM_K1.md S7). Above 2048 px on the long side (`FLOOD_COARSE_PX`) the wand first
                floods a coarse picture of the whole document as a job of its own: its box is the row's `coarsePx`,
                and the report prints its times apart from the box job's

The depth rows use a map made here as the app keeps one (docs/PLAN_WASM_BUILD.md K0b): at the work size (the long
side up to 4096), the picture at that size as its guide; the depth a slope with the base's discs standing nearer, so
no model is downloaded.

The worker replies with the milliseconds of each part of a job (`timing`), which the table splits into the
kernel's part and the rest; "wall" is the operation on the main thread. Each row also prints the px module's calls by
export (px.js counters): on the window, and in the row's jobs (`timing.pxCalls`); "-" in a build without them. With
`--check` (the default for the first, small size) the two kernel sets must give the same bytes: every chain and edge
chain of the mips job, the selection after grow, shrink, both wands, wand_add, invert and the range rows, the depth
map of depth_guide and the rows of fill_limit. Restart the app before a timing run.

K1's switches (docs/PLAN_WASM_K1.md S7):

  --ab NAME=A:B   one per run: A runs in the "js" column and B in the "rust" column, so the table keeps its columns.
                  NAME is `kernels` (the whole kernel set, the default without --ab), `stacks` (off / on: the window's
                  stack route of the wand and the range rows, `InpaintEditor.stacks`) or a route of px/kernels.js
                  (`flood`, `mips`, `releaseMB`, `keepMB`), with the kernel set on Rust in both arms; the values `js`,
                  `rust`, a number or `inf`
  --set NAME=V    repeatable: a route or `stacks`, for both arms and the whole run
  --split         the px calls timed by part, on the window and in each job (implied by --check): one more line per
                  row with the copies in and out, the allocations, the memory grown, the instances renewed, each
                  export's ms and first call on a thread, and the pool's queue and trip
  --fresh-pool    the pool's workers stopped before each row, so each row starts on new ones

Every row starts on a settled document (no chain and no job pending) and counts only the jobs of its own generation,
so a job queued before the row cannot land in it. A row of the wand or the mips says when its route did not run
(ROUTE NOT TAKEN), and an instance renewed after a trap or out of memory fails the run: in a row's split (the window's,
and its jobs' with --split), and on every thread over the whole run, read with the worker op `px_stats` from the editor
worker and each pool worker (as tools/px_probe.py posts it) and the window's `pxInstances` at the start of the rounds,
before each fresh pool and after the rounds, together with every job's error reply that names a trap
(inpaint_worker.js `reply.trap`). With --check the first size first checks that the window replaces a grown instance
(`window release: sync` or `async`). A timing run whose window was not focused and visible prints NOT COUNTED, leaves
PX_JOBS_JSON alone and exits with 2. PX_JOBS_JSON names a file each size's result is appended to as a line of JSON
(tools/ab_median.py reads them), with `check` true for a run that checked bytes; a size that failed is not written.
"""
import asyncio
import json
import math
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


def arm_value(name, raw):
    """A value of --ab or --set as JS source: kernels js / rust, stacks off / on, a route's js / rust, a number or inf."""
    if name == "kernels":
        ok = raw in ("js", "rust")
    elif name == "stacks":
        ok = raw in ("off", "on")
    elif raw in ("js", "rust"):
        ok = True
    elif raw == "inf":
        return "Infinity"
    else:
        try:
            v = float(raw)
        except ValueError:
            v = -1.0
        if v >= 0 and math.isfinite(v):
            return json.dumps(int(v) if v.is_integer() else v)
        ok = False
    if not ok:
        sys.exit(f"px_jobs.py: {name} does not take {raw!r} (js, rust, a number or inf; kernels js / rust; stacks off / on)")
    return json.dumps(raw)


AB = None   # --ab NAME=A:B: (NAME, A, B) as typed, A for the "js" column, B for the "rust" column
if "--ab" in args:
    i = args.index("--ab")
    name, _, vals = args[i + 1].partition("=")
    a, sep, b = vals.partition(":")
    del args[i:i + 2]
    if "--ab" in args:
        sys.exit("px_jobs.py: one --ab per run")
    if not name or not sep or not a or not b:
        sys.exit("px_jobs.py: --ab takes NAME=A:B, e.g. flood=js:rust")
    AB = (name, a, b)
SETS = []   # --set NAME=V, repeatable: (NAME, V) as typed, for both arms
while "--set" in args:
    i = args.index("--set")
    name, sep, v = args[i + 1].partition("=")
    del args[i:i + 2]
    if not name or not sep or not v:
        sys.exit("px_jobs.py: --set takes NAME=V, e.g. keepMB=64")
    if name == "kernels":
        sys.exit("px_jobs.py: the arms set the kernel set; --set takes a route or stacks")
    if (AB and name == AB[0]) or name in (n for n, _ in SETS):
        sys.exit(f"px_jobs.py: {name} is set twice")
    SETS.append((name, v))
AB_JS = "null" if not AB else (
    f"{{ name: {json.dumps(AB[0])}, js: {arm_value(AB[0], AB[1])}, rust: {arm_value(AB[0], AB[2])}, raw: {json.dumps([AB[1], AB[2]])} }}")
SETS_JS = "[" + ", ".join(f"[{json.dumps(n)}, {arm_value(n, v)}]" for n, v in SETS) + "]"
SPLIT = "--split" in args
FRESH = "--fresh-pool" in args
SIZES = [a for a in args if not a.startswith("-")]
RUNS = [(s, False) for s in SIZES] if SIZES else [("2048x1152", True), ("15000x10000", False)]
if "--check" in args:
    RUNS = [(s, True) for s, _ in RUNS]

BODY = """
(async () => {
    const W = %(w)d, H = %(h)d, ROUNDS = %(rounds)d, CHECK = %(check)s;
    const ONLY = %(only)s;
    // K1: the A/B (null: the kernel sets as before), the --set switches, --split, --fresh-pool, the window's release check
    const AB = %(ab)s, SETS = %(sets)s, SPLIT = %(split)s, FRESH = %(fresh)s, RELEASE = %(release)s;
    // "flood_ladder" in --only asks for every step of the ladder
    const wanted = (job) => !ONLY || ONLY.includes(job) || (job.startsWith("flood_ladder_") && ONLY.includes("flood_ladder"));
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
    // what K1 adds to the class (docs/PLAN_WASM_K1.md §1.5); a build without it runs the rows as before K1
    const has = (name) => typeof E[name] === "function";
    const GENS = has("measureGen") && has("pendingJobs");    // a row counts only its own jobs
    const SPLITS = (SPLIT || CHECK) && has("pxTimed") && has("pxSplit");
    // the run's switches checked before the document is built: a route --ab or --set names that this build refuses (an
    // unknown name, a bad value) throws here, and the tab goes again; set for real below, in the rounds' try
    const routed = (n) => n !== "kernels" && n !== "stacks";
    const touched = [...(AB && routed(AB.name) ? [AB.name] : []), ...SETS.map(([n]) => n).filter(routed)];
    try {
        if (touched.length && !has("setRoute")) throw new Error("px_jobs: --ab or --set of a route needs a build with the routes (K1)");
        if (SPLIT && !SPLITS) throw new Error("px_jobs: --split needs a build with the split (K1)");
        if (FRESH && !has("resetPool")) throw new Error("px_jobs: --fresh-pool needs a build with InpaintEditor.resetPool (K1)");
        const tries = [...(AB && routed(AB.name) ? [[AB.name, AB.js], [AB.name, AB.rust]] : []), ...SETS.filter(([n]) => routed(n))];
        for (const [n, v] of tries) { E.setRoute(n, v); E.setRoute(n, null); }
    } catch (err) {
        shell.closeDocument(ed, { force: true });
        throw err;
    }

    // K1: the px instances renewed after a trap or out of memory on every thread, over the whole run (the design wants
    // their sum 0 in every mode). The window's `pxInstances`, and the worker op `px_stats` of the editor worker and of each
    // pool worker (posted with an id of its own, as tools/px_probe.py does; the pool's `_reply` and the editor worker's
    // handler ignore it), read at the start of the rounds (`traps.take(true)`: the baseline), before each fresh pool
    // (its workers go) and after the rounds; a worker first seen after the baseline counts from 0. Beside them every
    // error reply that names a trap (inpaint_worker.js `reply.trap`: the instance is renewed only at that thread's next
    // call, so the counters can miss the last one), seen through the pool's `onTiming` (every reply, inpaint_pool.js)
    // and a listener on the editor worker; both are taken off again in the rounds' finally. The mips worker of
    // `mipsOnPool = false` is not reachable from here (the pool runs the mips by default). null in a build without them.
    const JOBS = await import("./editor/inpaint_jobs.js");
    const traps = (() => {
        if (!has("pxInstances") || !E.parts || typeof E.parts.pool !== "function" || typeof JOBS.editorWorker !== "function") return null;
        const seen = new Map();   // a thread (the window, or its Worker) -> its last { trap, oom }
        const out = { trap: 0, oom: 0, threads: {}, unread: [], replies: [] };
        const watched = [];       // [pool, its own onTiming] and [the editor worker, the listener], put back by `unwatch`
        let seq = 0, pools = 0;
        const reply = (where) => (msg) => {
            if (msg && msg.ok === false && msg.trap) out.replies.push({ where, trap: msg.trap, error: String(msg.error || "").slice(0, 200) });
        };
        const ask = (w) => new Promise((resolve) => {
            const id = "px_jobs_stats_" + (++seq);
            const done = (v) => { clearTimeout(timer); w.removeEventListener("message", onMsg); resolve(v); };
            const onMsg = (e) => { const m = e.data || {}; if (m.id === id) done(m.ok ? m : { error: String(m.error || "failed") }); };
            const timer = setTimeout(() => done({ error: "px_stats timed out" }), 15000);
            w.addEventListener("message", onMsg);
            try { w.postMessage({ id, op: "px_stats" }); } catch (err) { done({ error: String((err && err.message) || err) }); }
        });
        const watch = () => {
            const pool = E.parts.pool();
            if (pool && !watched.some(([p]) => p === pool)) {
                const own = pool.onTiming;
                pools++;
                pool.__pxjobsName = pools > 1 ? `pool #${pools}` : "pool";
                pool.onTiming = (msg) => { reply(pool.__pxjobsName)(msg); if (own) own(msg); };
                watched.push([pool, own, null]);
            }
            const ew = JOBS.editorWorker();
            if (ew && !watched.some(([w]) => w === ew)) {
                const fn = (e) => reply("editor worker")(e.data || {});
                ew.addEventListener("message", fn);
                watched.push([ew, null, fn]);
            }
            return pool;
        };
        const take = async (baseline = false) => {
            const pool = watch();
            const list = [{ key: "window", name: "window", s: E.pxInstances() }];
            const ew = JOBS.editorWorker();
            if (ew) list.push({ key: ew, name: "editor worker", s: await ask(ew) });
            for (const w of pool ? pool.workers.slice() : []) list.push({ key: w.w, name: `${pool.__pxjobsName} ${w.n}`, s: await ask(w.w) });
            for (const { key, name, s } of list) {
                if (s.error) { out.unread.push(`${name}: ${s.error}`); continue; }
                const now = { trap: s.trap || 0, oom: s.oom || 0 };
                const last = seen.get(key) || { trap: 0, oom: 0 };
                seen.set(key, now);
                if (baseline) continue;
                const t = (out.threads[name] = out.threads[name] || { trap: 0, oom: 0 });
                for (const k of ["trap", "oom"]) { const d = Math.max(0, now[k] - last[k]); t[k] += d; out[k] += d; }
            }
        };
        const unwatch = () => {
            for (const [x, own, fn] of watched.splice(0)) {
                if (fn) x.removeEventListener("message", fn);
                else { x.onTiming = own; delete x.__pxjobsName; }
            }
        };
        return { take, watch, unwatch, out };
    })();
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
    // the numbers of the jobs summed by name (`kernels`, `source`, the px calls, K1's `pxSplit` and `pool` are not numbers,
    // and the generation is no part); a job of an op after the first of `ops` sums under "<op>.<name>", so a range row
    // keeps its stack_into jobs' kernel apart from its own
    const parts = (list, ops = null) => {
        const out = {};
        for (const t of list) {
            const pre = ops && t.op !== ops[0] ? t.op + "." : "";
            for (const [k, v] of Object.entries(t)) if (typeof v === "number" && k !== "gen") out[pre + k] = (out[pre + k] || 0) + v;
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

    // K1: an arm of the run. Without --ab, or with `kernels`, the kernel set; otherwise the kernel set stays Rust and the
    // arm sets the window's stack route (`stacks`) or a route of px/kernels.js, which every job message carries
    const useArm = (k) => {
        if (!AB || AB.name === "kernels") { E.kernels = AB ? AB[k] : k; return; }
        E.kernels = "rust";
        if (AB.name === "stacks") E.stacks = AB[k] === "off" ? false : undefined;
        else E.setRoute(AB.name, AB[k]);
    };
    // before a row's clock: the chains built, no job pending anywhere (polled, at most 10 s: then the row says
    // `settleTimeout`), a short rest, with --fresh-pool new workers (the old ones' trap counters read first, the new
    // pool's replies watched), and a new job generation, so a job queued before the row (it carries the generation it
    // was queued in) is not the row's
    const settle = async () => {
        await ed.mipsSettled();
        let timeout = false;
        const until = performance.now() + 10000;
        while ((has("pendingJobs") && E.pendingJobs() !== 0) || T.chainStats().pending !== 0) {
            if (performance.now() > until) { timeout = true; break; }
            await sleep(20);
        }
        await sleep(50);
        if (FRESH) {
            if (traps) await traps.take();
            E.resetPool();
            if (traps) traps.watch();
        }
        return { gen: GENS ? E.measureGen(true) : null, timeout };
    };
    const ofGen = (list, gen) => (gen === null ? list : list.filter((t) => t.gen === gen));
    // a row's clock starts on a settled document with the timings, the marks and the window's px calls cleared, and the
    // window's split taken right after its laps were (`pxCalls(true)` clears them too); `rowEnd` reads the window's split
    // before the closing `pxCalls` clears it again
    const rowStart = async () => {
        const s = await settle();
        E.jobTimings(true);
        stepMarks();
        pxCalls();
        return { ...s, w0: has("pxSplit") ? E.pxSplit() : null };
    };
    const rowEnd = (r0) => {
        const ws = r0.w0 ? E.pxSplit(r0.w0) : null;
        return { ws, onWindow: pxCalls() };
    };
    // the split's laps (px.js `pxLaps`): copies in and out (ms, MB, and the MB copied in from shared memory), the
    // allocations' ms and the memory they grew
    const LAPS = ["copyIn", "copyInMB", "copyInSharedMB", "copyOut", "copyOutMB", "alloc", "grewMB"];
    const addTo = (out, ...srcs) => {
        for (const s of srcs) if (s) for (const [k, v] of Object.entries(s)) if (typeof v === "number") out[k] = (out[k] || 0) + v;
        return out;
    };
    // the union of exports' first calls; where one's first call fell on several threads, the slowest
    const firstOf = (out, src) => {
        if (src) for (const [k, v] of Object.entries(src)) {
            if (!(k in out)) out[k] = v;
            else if (typeof v === "number" && (typeof out[k] !== "number" || v > out[k])) out[k] = v;
        }
        return out;
    };
    // the jobs' split (`timing.pxSplit`, with --split) and the pool's times (`timing.pool`) summed over a row's
    // timings: the jobs' own ms, the laps, the ms by export, the first calls, the renewals by cause, the smallest and
    // largest instance a job started on (bytes), the queue and trip ms and the distinct pool workers; null without any
    const jobSplit = (list) => {
        let out = null;
        const workers = new Set();
        for (const t of list) {
            const s = t.pxSplit, q = t.pool;
            if (!s && !q) continue;
            if (!out) out = { jobs: 0, job: 0, ms: {}, first: {}, renewed: {}, bytes0Min: null, bytes0Max: null, queueMs: 0, tripMs: 0, workers: 0 };
            if (s) {
                out.jobs++;
                out.job += s.job || 0;
                for (const k of LAPS) out[k] = (out[k] || 0) + (s[k] || 0);
                addTo(out.ms, s.ms);
                firstOf(out.first, s.first);
                addTo(out.renewed, s.renewed);
                if (typeof s.bytes0 === "number") {
                    out.bytes0Min = out.bytes0Min === null ? s.bytes0 : Math.min(out.bytes0Min, s.bytes0);
                    out.bytes0Max = out.bytes0Max === null ? s.bytes0 : Math.max(out.bytes0Max, s.bytes0);
                }
            }
            if (q) {
                out.queueMs += q.queueMs || 0;
                out.tripMs += q.tripMs || 0;
                if (q.worker != null) workers.add(q.worker);
            }
        }
        if (out) out.workers = workers.size;
        return out;
    };
    // a row's split: the laps and the ms by export of the window and the jobs together, the first calls of both, the
    // jobs' own ms, the pool's times and the largest instance a job started on; the two sides as they came in `window`
    // and `jobs`
    const splitOf = (ws, js) => {
        const out = { ms: addTo({}, ws && ws.ms, js && js.ms), first: firstOf(firstOf({}, ws && ws.first), js && js.first) };
        for (const k of LAPS) out[k] = ((ws && ws[k]) || 0) + ((js && js[k]) || 0);
        out.job = js ? js.job : 0;
        out.queueMs = js ? js.queueMs : 0;
        out.tripMs = js ? js.tripMs : 0;
        out.workers = js ? js.workers : 0;
        out.bytes0 = js ? js.bytes0Max : null;
        out.window = ws;
        out.jobs = js;
        return out;
    };
    // what K1 adds to a row: its generation, a settle that ran out, the instances renewed on the window and in its jobs
    // (by cause; the jobs' only with the split), and with the split the row's split
    const k1 = (r0, ws, timings) => {
        const js = jobSplit(timings);
        const out = {};
        if (r0.gen !== null) out.gen = r0.gen;
        if (r0.timeout) out.settleTimeout = true;
        if (ws || (js && js.jobs)) out.renewed = addTo({}, ws && ws.renewed, js && js.renewed);
        if (SPLITS) out.split = splitOf(ws, js);
        return out;
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
        useArm(kernels);
        const list = tileList(ed.basePx);
        const r0 = await rowStart();
        const chains = [];
        const t0 = performance.now();
        for (let i = 0; i < list.length; i += 128) {   // one flight at a time, as the scheduler sends them
            const batch = list.slice(i, i + 128).map((e) => ({ data: e.t.data.slice().buffer, vw: e.vw, vh: e.vh }));
            chains.push(await transport(batch));
        }
        const wall = performance.now() - t0;
        const { ws, onWindow } = rowEnd(r0);
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
        const timings = ofGen(E.jobTimings(true), r0.gen).filter((t) => t.op === "mips");
        return { wall, ...parts(timings), digest, tilesSent: list.length, px: { window: onWindow, workers: callsOf(timings) }, ...k1(r0, ws, timings) };
    };
    const bandJob = async (kernels) => {
        useArm(kernels);
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
        const r0 = await rowStart();
        const t0 = performance.now();
        const r = await E.workerJob("band", { columns, ops: [0, 0, 1, 2], alphas: [255, 200, 64, 255] }, transfer);
        const wall = performance.now() - t0;
        const { ws, onWindow } = rowEnd(r0);
        let digest = null;
        if (CHECK) {
            const all = new Uint8Array(r.dsts.length * 256 * 256 * 4);
            r.dsts.forEach((d, i) => all.set(new Uint8Array(d), i * 256 * 256 * 4));
            digest = await hex(all);
        }
        const timings = ofGen(E.jobTimings(true), r0.gen).filter((t) => t.op === "band");
        return { wall, ...parts(timings), digest, px: { window: onWindow, workers: callsOf(timings) }, ...k1(r0, ws, timings) };
    };
    const mipsWhole = async (kernels) => {
        useArm(kernels);
        const r0 = await rowStart();
        T.chainStats(true);
        const t0 = performance.now();
        paint.px = ed.turnedTilePixels(paint.px, "h");
        ed.markLayerChanged(paint);
        ed.renderLayers();
        ed.draw();
        await ed.mipsSettled();
        const wall = performance.now() - t0;
        const { ws, onWindow } = rowEnd(r0);
        const cs = T.chainStats();
        const timings = ofGen(E.jobTimings(true), r0.gen).filter((t) => t.op === "mips");
        // flipped back, so every kernel set's selection jobs see the same picture
        paint.px = ed.turnedTilePixels(paint.px, "h");
        ed.markLayerChanged(paint);
        ed.renderLayers();
        ed.draw();
        await ed.mipsSettled();
        E.jobTimings(true);
        return { wall, ...parts(timings), main: cs.main, requested: cs.requested, px: { window: onWindow, workers: callsOf(timings) }, ...k1(r0, ws, timings) };
    };
    // an operation on the document: `want` the op (or ops, the first the row's own) of the jobs it posts, null for one
    // on the window; `marks` the op of the window's step marks it keeps; `sel` false for a row whose bytes are not the
    // selection. A row with flood jobs keeps their boxes in pixels (`floodPx`), for the route check and the ladder's key,
    // and each one's own times (`floodJobs`), both in the order the replies came: the wand's coarse pass answers before
    // its box job is posted, so above FLOOD_COARSE_PX the first is the coarse job and the last the final box
    const FLOOD_PARTS = ["total", "read", "flood", "clip", "bounds", "shape"];
    const op = async (kernels, fn, want, { marks = null, sel = true } = {}) => {
        useArm(kernels);
        const r0 = await rowStart();
        const t0 = performance.now();
        await fn();
        const wall = performance.now() - t0;
        const { ws, onWindow } = rowEnd(r0);
        const ops = want === null ? [] : [].concat(want);
        const timings = ofGen(E.jobTimings(true), r0.gen).filter((t) => ops.includes(t.op));
        const out = { wall, ...parts(timings, ops), px: { window: onWindow, workers: callsOf(timings) }, ...k1(r0, ws, timings) };
        if (ops.includes("flood")) {
            const floods = timings.filter((t) => t.op === "flood");
            out.floodPx = floods.map((t) => t.pixels || 0);
            out.floodJobs = floods.map((t) => {
                const j = { pixels: t.pixels || 0, kernels: t.kernels || null };
                for (const k of FLOOD_PARTS) if (typeof t[k] === "number") j[k] = t[k];
                return j;
            });
        }
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
            useArm(kernels);
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
        useArm(kernels);
        snapTo(EDG.SNAP_DEFAULT);
        const r0 = await rowStart();
        const map = ed.maps.depth, limit = LIMITS.range_depth[0], p = { color: "#3080c0" };
        let fill = 0, lim = 0, bands = 0;
        const digests = [];
        for (let y0 = 0; y0 < H; y0 += 256) {
            const y1 = Math.min(H, y0 + 256);
            const a = performance.now();
            const rows = FIL.fillPixels("fill", p, [W, H], [0, y0], W, y1 - y0);
            const b = performance.now();
            LIM.limitAlphaRows(rows, 0, y0, W, y1 - y0, limit, map);
            fill += b - a; lim += performance.now() - b; bands++;
            if (CHECK) digests.push(new Uint8Array(await crypto.subtle.digest("SHA-256", rows)));   // per band, outside the times
        }
        const { ws, onWindow } = rowEnd(r0);
        const out = { wall: fill + lim, fill, limit: lim, bands, jobs: 0, px: { window: onWindow, workers: null }, ...k1(r0, ws, []) };
        if (CHECK) {
            const all = new Uint8Array(digests.length * 32);
            digests.forEach((d, i) => all.set(d, i * 32));
            out.digest = await hex(all);
        }
        return out;
    };

    // the flood ladder (K1, the `flood` route's threshold): the sizes that fit, the largest first, in columns 16 px apart
    const LADDER = [];
    {
        const gap = 16;
        let x = gap, y = gap, colW = 0;
        for (const s of [8192, 4096, 2048, 1024, 512, 256]) {
            const f = s + 4;   // the square in its frame
            if (f + 2 * gap > W || f + 2 * gap > H) continue;
            if (y + f + gap > H) { x += colW + gap; y = gap; colW = 0; }
            if (x + f + gap > W) continue;
            LADDER.push({ s, x, y });
            y += f + gap;
            colW = Math.max(colW, f);
        }
        LADDER.reverse();   // the smallest step first
    }
    // the ladder's layer: white frames and black squares filled on tiles once (no canvas of the picture's size), each
    // step's layer a copy-on-write clone of them, so the steps add no tiles (a removed layer's go back to the arena only
    // when they are collected)
    let ladderPx = null;
    const ladderLayer = () => {
        if (!ladderPx) {
            ladderPx = ed.pixels.Layer.empty(W, H);
            for (const { s, x, y } of LADDER) {
                ladderPx.fill([x, y, x + s + 4, y + s + 4], "#ffffff");
                ladderPx.fill([x + 2, y + 2, x + 2 + s, y + 2 + s], "#000000");
            }
        }
        const layer = ed.addLayer({ name: "Flood ladder", kind: "paint", ref: null, px: ladderPx.clone(), x: 0, y: 0, w: W, h: H, dirty: true }, { activate: false });
        ed.markLayerChanged(layer);
        ed.renderLayers();
        ed.draw();
        return layer;
    };
    // one step: the layer added, the wand at the square's centre (the row's settle comes after the add), the layer
    // removed; the row's key the box job's box (its last flood job), the coarse pass's apart (its first, when there are
    // two or more: at 15000 x 10000 the coarse job floods 2048 x 1365, more than the 256-1024 steps' boxes)
    const ladderRow = async (k, { s, x, y }) => {
        const layer = ladderLayer();
        try {
            rect();
            const out = await op(k, () => ed.wandSelect(x + 2 + s / 2, y + 2 + s / 2, "replace"), "flood");
            const fp = out.floodPx || [];
            return { ...out, square: s, key: fp.slice(-1)[0] || 0, coarsePx: fp.length > 1 ? fp[0] : null };
        } finally {
            ed.removeLayer(layer.id);
            ed.clearUndo();
        }
    };

    // did a row run the route it was set to (critic A5)? `flood`: the row's flood jobs whose box is at or above the
    // route (all of them with "rust", none with "js", none with the twins' kernel set) call flood_shape once each, and
    // with "js" no flood export runs, in the jobs or on the window; `mips`: with "js" no mip export runs anywhere,
    // otherwise the jobs build at least a chain per tile. [] when it ran, else what went wrong; null for a row of no
    // route, and in a build without job generations (its rows may hold jobs of the row before)
    const routeOf = (name) => {
        if (E.kernels !== "rust") return "js";
        const r = has("setRoute") ? E.routes[name] : undefined;
        return r === undefined ? "rust" : r;
    };
    const routeRan = (row) => {
        if (!GENS) return null;
        const jobs = (row.px && row.px.workers) || {}, win = (row.px && row.px.window) || {};
        const bad = [];
        if (row.floodPx) {
            const r = routeOf("flood");
            const want = r === "js" ? 0 : r === "rust" ? row.floodPx.length : row.floodPx.filter((n) => n >= r).length;
            const got = jobs.flood_shape || 0;
            if (got !== want) bad.push(`flood=${r}: the jobs called flood_shape ${got} times, for ${want} of the row's ${row.floodPx.length} flood jobs`);
            if (r === "js") {
                if (jobs.flood) bad.push(`flood=js: the jobs called flood ${jobs.flood} times`);
                for (const n of ["flood", "flood_shape"]) if (win[n]) bad.push(`flood=js: the window called ${n} ${win[n]} times`);
            }
            return bad;
        }
        if (row.job === "mips_direct" || row.job === "mips_whole") {
            const r = routeOf("mips");
            if (r === "js") {
                for (const n of ["mip_chain", "clamp_extend", "mip_half"]) {
                    if (jobs[n]) bad.push(`mips=js: the jobs called ${n} ${jobs[n]} times`);
                    if (win[n]) bad.push(`mips=js: the window called ${n} ${win[n]} times`);
                }
            } else if ((jobs.mip_chain || 0) < (row.tiles || 0)) {
                bad.push(`mips=${r}: the jobs called mip_chain ${jobs.mip_chain || 0} times for the row's ${row.tiles} tiles`);
            }
            return bad;
        }
        return null;
    };

    const rows = [];
    const step = async (job, k, round, fn) => {
        if (!wanted(job)) return;
        window.__pxjobs = `${job} ${k} round ${round}`;
        const row = { job, kernels: k, round, ...(await fn()) };
        const ran = routeRan(row);   // the arm is still the row's
        if (ran) row.routeRan = ran;
        rows.push(row);
    };

    // the window's release of a grown instance (K1, M8; with --check, the first size, before the rows and the run's
    // switches): an instance grown past 256 MB, then a wrapper that releases after its call. "sync" when the next
    // rustPx() is already a new instance, "async" when the new one came from the asynchronous instantiation, "none"
    // (a failure) when the grown one stayed; either way the call's bytes are the twin's
    const windowRelease = async () => {
        const K = await import("./editor/px/kernels.js"), J = await import("./editor/px/kernels_js.js");
        if (typeof K.pxSettled !== "function") return { how: "skipped", why: "a build without K1's instance lifecycle" };
        E.kernels = "rust";
        await K.kernelsReady();
        await K.pxSettled();
        const p0 = K.rustPx();
        if (!p0) return { how: "none", why: "no Rust kernels on the window" };
        const big = 300 * 1048576;
        const ptr = p0.alloc(big);
        const n = 64, mask = new Float32Array(n * n);
        for (let i = 0; i < mask.length; i++) mask[i] = ((i * 37) & 255) / 255;
        const got = K.dilateMask(mask, n, n, 3);
        let how = "none", p1 = K.rustPx();
        if (p1 && p1 !== p0) how = "sync";
        else if (!p1) {
            await K.pxSettled();
            p1 = K.rustPx();
            if (p1 && p1 !== p0) how = "async";
        }
        if (how === "none") p0.free(ptr, big);
        const want = J.dilateMask(mask, n, n, 3);
        const a = new Uint8Array(got.buffer, got.byteOffset, got.byteLength), b = new Uint8Array(want.buffer, want.byteOffset, want.byteLength);
        const bytes = p1 && p1 !== p0 ? p1.byteLength : 0;
        return { how, same: a.length === b.length && a.every((v, i) => v === b[i]), grown: p0.byteLength, bytes, small: bytes > 0 && bytes < 256 * 1048576 };
    };
    const release = RELEASE ? await windowRelease() : null;

    // the run's switches (checked above, before the document): the --set values for both arms, the split's clocks; the
    // finally puts every one of them back, takes the trap watch off and closes the run's tab, whatever a row threw
    try {
        if (traps) await traps.take(true);
        if (has("pxTimed")) E.pxTimed(SPLITS);
        for (const [n, v] of SETS) {
            if (n === "stacks") E.stacks = v === "off" ? false : undefined;
            else E.setRoute(n, v);
        }
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
            // K1's ladder last, so the rows before run in the order and state they ran in K0b
            for (const k of order) for (const rung of LADDER) await step(`flood_ladder_${rung.s}`, k, round, () => ladderRow(k, rung));
            // the next round's mips_direct starts, as in W0, with no selection and nothing pending
            ed.sel.clear();
            ed.markSelectionChanged();
            await ed.mipsSettled();
        }
        // the rounds' last jobs answered (at most 10 s, as a row's settle): every thread's counters once more
        if (traps) {
            const until = performance.now() + 10000;
            while (has("pendingJobs") && E.pendingJobs() !== 0 && performance.now() < until) await sleep(20);
            await traps.take();
        }
        window.__pxjobs = "done";
    } finally {
        // the defaults again ("js" here once left every later gate of the instance on the twins)
        E.kernels = "rust";
        E.stacks = undefined;
        for (const n of touched) { try { E.setRoute(n, null); } catch (_) { /* a name the build refused above */ } }
        if (has("pxTimed")) E.pxTimed(false);
        if (traps) traps.unwatch();
        shell.closeDocument(ed, { force: true });
    }
    return JSON.stringify({
        size: `${W}x${H}`, check: CHECK, rows, focused: document.hasFocus(), visibility: document.visibilityState, cores: navigator.hardwareConcurrency,
        ab: AB ? { name: AB.name, js: AB.raw[0], rust: AB.raw[1] } : null, sets: Object.fromEntries(SETS.map(([n, v]) => [n, v === Infinity ? "inf" : v])),
        split: SPLITS, freshPool: FRESH, release, instances: traps ? traps.out : null,
    });
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
# K1's flood ladder: the wand's parts, one row per square that fits (the body's LADDER)
for _s in (256, 512, 1024, 2048, 4096, 8192):
    PARTS[f"flood_ladder_{_s}"] = PARTS["wand_object"]
    KERNEL[f"flood_ladder_{_s}"] = KERNEL["wand_object"]


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


# ---- K1's split (docs/PLAN_WASM_K1.md S7): a row's `split` is the window's and its jobs' px time by part, the jobs'
# own ms, the pool's queue and trip, the largest instance a job started on (`bytes0`); `window` and `jobs` as they came

def split_of(row, *path):
    """A value of the row's split along `path` ({} or None where it has none)."""
    v = row.get("split") or {}
    for k in path:
        v = (v or {}).get(k)
    return v


def smed(rows, *path):
    """The median over rows of a number of their split (0 where a row has none)."""
    vals = [split_of(r, *path) for r in rows]
    return statistics.median([v if isinstance(v, (int, float)) else 0 for v in vals]) if vals else 0


def by_export(rows):
    """The medians over rows of the split's ms by export (0 where a row has none)."""
    names = sorted({k for r in rows for k in (split_of(r, "ms") or {})})
    return {k: statistics.median([(split_of(r, "ms") or {}).get(k) or 0 for r in rows]) for k in names}


def firsts(rows):
    """The exports whose first call on a thread fell in these rows: {export: (rows, the slowest such call or None)}."""
    out = {}
    for r in rows:
        for k, v in (split_of(r, "first") or {}).items():
            n, worst = out.get(k, (0, None))
            out[k] = (n + 1, v if worst is None or (v is not None and v > worst) else worst)
    return out


def renewed(rows):
    """The instances renewed in these rows, summed by cause (the window's, and the jobs' with the split)."""
    out = {}
    for r in rows:
        for k, v in (r.get("renewed") or {}).items():
            out[k] = out.get(k, 0) + v
    return out


def flood_jobs(rows, which):
    """Each row's coarse job (its first flood job, when it has two or more) or box job (its last), as op() keeps them."""
    out = []
    for r in rows:
        fj = r.get("floodJobs") or []
        if which == "coarse":
            if len(fj) > 1:
                out.append(fj[0])
        elif fj:
            out.append(fj[-1])
    return out


def flood_job_text(js, rs, which):
    """A row's coarse or box job, js/rust medians over the rounds: its box, the kernels it ran on (the route picks them
    by the box), its total and parts; None when neither arm has one."""
    a, b = flood_jobs(js, which), flood_jobs(rs, which)
    if not a and not b:
        return None

    def m(jobs, k, scale=1.0, f=".1f"):
        vals = [j[k] for j in jobs if isinstance(j.get(k), (int, float))]
        return format(statistics.median(vals) / scale, f) if vals else "-"

    def ran(jobs):
        return "+".join(sorted({j.get("kernels") or "?" for j in jobs})) or "-"

    keys = [k for k in ("total", "read", "flood", "clip", "bounds", "shape") if any(isinstance(j.get(k), (int, float)) for j in a + b)]
    times = "  ".join(f"{k} {m(a, k)}/{m(b, k)}" for k in keys)
    return f"{which} job js/rust: {m(a, 'pixels', 1e6, '.2f')}/{m(b, 'pixels', 1e6, '.2f')} MP, ran {ran(a)}/{ran(b)}: {times}"


def show(d):
    """{name: number} as "{a 1.2, b 3}"."""
    return "{" + ", ".join(f"{k} {v:.1f}" if isinstance(v, float) else f"{k} {v}" for k, v in d.items()) + "}"


def show_first(d):
    return "{" + ", ".join(f"{k} {'-' if v is None else round(v, 1)}" + (f" in {n} rows" if n > 1 else "")
                           for k, (n, v) in sorted(d.items())) + "}"


def split_lines(job, js, rs):
    """The split line of a row (medians over the rounds; renewals summed) and round 0's first calls apart."""
    def pair(*path, f=".1f"):
        return f"{smed(js, *path):{f}}/{smed(rs, *path):{f}}"

    def mb(rows, *path):
        return smed(rows, *path) / 1048576

    def later(rows):
        return [r for r in rows if r.get("round")]

    def outside(rows):   # the row's wall less its jobs' own time: the transport, the scheduling, the window
        return statistics.median([r.get("wall", 0) - (split_of(r, "job") or 0) for r in rows])

    cols = [f"job {pair('job')}",
            f"copyIn {pair('copyIn')} ({pair('copyInMB')} MB, shared {pair('copyInSharedMB')} MB)",
            f"copyOut {pair('copyOut')} ({pair('copyOutMB')} MB)",
            f"alloc {pair('alloc')}",
            f"grew MB {pair('grewMB')}",
            f"bytes0 MB {mb(js, 'bytes0'):.0f}/{mb(rs, 'bytes0'):.0f} (window {mb(js, 'window', 'bytes0'):.0f}/{mb(rs, 'window', 'bytes0'):.0f})",
            f"renewed js {show(renewed(js))} rust {show(renewed(rs))}",
            f"kernel js {show(by_export(js))} rust {show(by_export(rs))}",
            f"first js {show_first(firsts(later(js)))} rust {show_first(firsts(later(rs)))}",
            f"queue {pair('queueMs')}",
            f"trip {pair('tripMs')}",
            f"workers {pair('workers', f='.0f')}"]
    if job == "mips_direct":
        cols.append(f"outside jobs {outside(js):.1f}/{outside(rs):.1f}")
    lines = [f"  {'':16s} split js/rust: " + "  ".join(cols)]
    f0 = [firsts([r for r in rows if not r.get("round")]) for rows in (js, rs)]
    if f0[0] or f0[1]:
        lines.append(f"  {'':16s} round 0 first js {show_first(f0[0])} rust {show_first(f0[1])}")
    return lines


def report(result, check):
    rows = result["rows"]
    print(f"\n== {result['size']}  (window focused {result.get('focused')}, {result.get('visibility')}, {result.get('cores')} logical cores)")
    ab, sets = result.get("ab"), result.get("sets")
    if ab or sets or result.get("freshPool"):
        arms = f'the "js" column {ab["name"]}={ab["js"]}, the "rust" column {ab["name"]}={ab["rust"]}' if ab else "the kernel sets"
        print(f"  arms: {arms}" + (f"; both arms {', '.join(f'{k}={v}' for k, v in sets.items())}" if sets else "")
              + ("; a fresh pool before each row" if result.get("freshPool") else ""))
    bad = 0
    rel = result.get("release")
    if rel:
        # the window's release of a grown instance (M8): "none" fails, and so do bytes other than the twin's or a new
        # instance that is not small; "skipped" in a build without K1's lifecycle
        ok = rel.get("how") == "skipped" or (rel.get("how") in ("sync", "async") and rel.get("same") and rel.get("small"))
        bad += 0 if ok else 1
        same = "the twin's bytes" if rel.get("same") else "BYTES OTHER THAN THE TWIN'S"
        more = rel.get("why") or f"grown {rel.get('grown', 0) / 1048576:.0f} MB, the new instance {rel.get('bytes', 0) / 1048576:.1f} MB, {same}"
        print(f"  window release: {rel.get('how')} ({more})" + ("" if ok else "  FAILED"))
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
        elif job.startswith("flood_ladder_"):
            # the key is the box job's box; the coarse pass's box (above FLOOD_COARSE_PX) apart
            cj = [r["coarsePx"] for r in js if r.get("coarsePx")]
            cr = [r["coarsePx"] for r in rs if r.get("coarsePx")]
            coarse = (f", the coarse pass's js {statistics.median(cj) / 1e6 if cj else 0:.2f} / rust"
                      f" {statistics.median(cr) / 1e6 if cr else 0:.2f} MP apart") if cj or cr else ""
            extra = (f"  the square {job.rsplit('_', 1)[1]}: box js {med(js, 'key') / 1e6:.2f} / rust {med(rs, 'key') / 1e6:.2f} MP"
                     f"{coarse} in {med(js, 'jobs'):.0f} jobs")
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
        # the wand's coarse job and its box job apart (the ladder's rows always, a wand row when it has a coarse pass):
        # whether the coarse job's arm matters under an A/B of the flood route
        if job.startswith("flood_ladder_") or flood_jobs(js + rs, "coarse"):
            texts = [t for t in (flood_job_text(js, rs, "coarse"), flood_job_text(js, rs, "box")) if t]
            if texts:
                print(f"  {'':16s} " + " | ".join(texts))
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
        if any(r.get("split") for r in js + rs):
            for line in split_lines(job, js, rs):
                print(line)
        late = [r for r in js + rs if r.get("settleTimeout")]
        if late:
            print(f"  {'':16s} {len(late)} of its rows started after the settle ran out (10 s): jobs were still pending")
        # the route checks (critic A5): each row that did not run its route fails the run
        for r in js + rs:
            if r.get("routeRan"):
                bad += 1
                for v in r["routeRan"]:
                    print(f"  {'':16s} ROUTE NOT TAKEN ({r['kernels']} column, round {r['round']}): {v}")
    # an instance renewed after a trap or out of memory, in any row and either arm, fails the run
    total = renewed(rows)
    if total:
        traps = total.get("trap", 0) + total.get("oom", 0)
        bad += 1 if traps else 0
        print(f"  instances renewed over the rows: {show(total)}" + (f"  TRAPS: {traps} after a trap or out of memory" if traps else ""))
    # and on every thread over the whole run (`px_stats` and the window's pxInstances, the error replies that name a
    # trap): any increase fails the run, and so does a thread that could not be read
    inst = result.get("instances")
    if inst:
        threads = inst.get("threads") or {}
        traps = (inst.get("trap") or 0) + (inst.get("oom") or 0)
        replies, unread = inst.get("replies") or [], inst.get("unread") or []
        hit = {k: v for k, v in threads.items() if (v.get("trap") or 0) + (v.get("oom") or 0)}
        fail = bool(traps or replies or unread)
        bad += 1 if fail else 0
        print(f"  instances renewed after a trap or out of memory on the {len(threads)} threads read: {traps}"
              + (" (" + ", ".join(f"{k} trap {v.get('trap', 0)} oom {v.get('oom', 0)}" for k, v in hit.items()) + ")" if hit else "")
              + (f", {len(replies)} error replies naming a trap" if replies else "") + ("  TRAPS" if traps or replies else ""))
        for rp in replies:
            print(f"  {'':16s} TRAP in an error reply ({rp.get('where')}): {rp.get('trap')}: {rp.get('error')}")
        for u in unread:
            print(f"  {'':16s} NOT READ: {u}")
    return bad


async def main():
    sys.stdout.reconfigure(encoding="utf-8")

    async def run(c):
        await c.call("Page.bringToFront")   # a timing run counts only with the window in front (as brush_perf.py does)
        bad = 0
        uncounted = False
        for n, (size, check) in enumerate(RUNS):
            w, h = (int(v) for v in size.lower().split("x"))
            rounds = ROUNDS if not check or SIZES else 1
            print(f"-- {size} ({w * h / 1e6:.1f} MP), {rounds} rounds{', checking bytes' if check else ''} ...", flush=True)
            body = BODY % {"w": w, "h": h, "rounds": rounds, "check": "true" if check else "false", "only": json.dumps(ONLY),
                           "ab": AB_JS, "sets": SETS_JS, "split": "true" if SPLIT else "false", "fresh": "true" if FRESH else "false",
                           "release": "true" if check and n == 0 else "false"}
            result = json.loads(await c.eval(body, timeout=3600))
            failed = report(result, check)
            bad += failed
            # a timing run counts only with the window in front (V8 slows a page that is not)
            counted = check or (result.get("focused") and result.get("visibility") == "visible")
            if not counted:
                uncounted = True
                print(f"  NOT COUNTED: the window was {'focused' if result.get('focused') else 'not focused'} and {result.get('visibility')};"
                      " its numbers were not written to PX_JOBS_JSON")
            elif failed and os.environ.get("PX_JOBS_JSON"):
                # a route not taken, a trap, different bytes: no numbers for tools/ab_median.py
                print("  NOT WRITTEN to PX_JOBS_JSON: this size failed above")
            elif os.environ.get("PX_JOBS_JSON"):
                with open(os.environ["PX_JOBS_JSON"], "a", encoding="utf-8", newline=chr(10)) as f:
                    f.write(json.dumps(result) + "\n")
        print("\nFAIL" if bad else "\nNOT COUNTED" if uncounted else "\nPASS")
        return 1 if bad else 2 if uncounted else 0

    sys.exit(await session(run))


if __name__ == "__main__":
    asyncio.run(main())
