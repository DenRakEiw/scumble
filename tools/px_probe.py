"""K1's probes of the px instances (docs/PLAN_WASM_K1.md S8; the measurements M5 and M7 of its §3).

Start the app with a debugging port first (see tools/cdp.py; the gate form is `pxprobe:<args>` in tools/run_gates.sh,
commas for spaces), then one or more of:

    python tools/px_probe.py --cold [--rotation 1|2|3] [--size 2048]           # M5, on a fresh instance with no document
    python tools/px_probe.py --regrow [--mb 16,32,64,69,128] [--pairs 5]       # M7a
    python tools/px_probe.py --retention 15000x10000 [--keep-mb N] [--set NAME=V ...] [--wait 3]   # M7b

--cold   Where a kernel's first call runs on cold code. On the window, `rustPx().floodShape` on a flat SIZE^2 picture
         five times: W0 its first call, the median of calls 2-4 (0-based) the warm figure. Then three new workers of
         inpaint_worker.js, one after the other, each with the worker op `px_probe`:
           A  source "thread": the worker's own compile of px.wasm's URL, as every worker loads it today
           B  source "posted": the window's compiled Module, posted to it
           C  source "bytes": px.wasm with a fresh custom section (as tools/px_test.js `freshWasm` builds it), so V8
              compiles it afresh: the cold reference
         each `flood_shape` SIZE^2 three times with `pregrow` (the instance grown first, so call 0 differs from call 1
         only by the code's tier), then `mip_chain` on a 256^2 tile 200 times (pregrown too: B and C take a new
         instance per message), then terminated. The order rotates over
         the three instances of M5: rotation 1 ABC, 2 BCA, 3 CAB. Printed: call 0 against the median of the rest, per
         worker and for the window, and a hint along the design's M5 table (one instance; the verdict takes all three).
         A second --cold in the same instance is refused: its code would be warm.
--regrow In one new worker, `flood_shape` at sizes needing about the given MB (a flat picture at 5.5 bytes a pixel:
         the picture and the span pairs take 4.5, but the instance grew to 1.24-1.36x the MB at 4.5; at 5.5 it is
         the MB plus about 2 MB, measured on px.wasm in Node 2026-10-23), after a warm-up: per size PAIRS times,
         alternating, a call on a fresh
         instance of the warm module (`renew: true`) against one on the instance it grew (`renew: false`). The penalty
         per size is the difference of their medians: what a trim to below that size costs the next job. 69 MB is in the
         default list beside the design's 16 / 32 / 64 / 128 for liquify's window (the design's §5).
--retention  px_jobs.py's document at WxH (a gradient base with discs, one full-size paint layer), the PNG export as
         native_test.py's export_png row runs it (`host.saveExport` stubbed: the file stays in memory), then the px
         instances' bytes per thread right after it and WAIT seconds later: the worker op `px_stats` posted directly to
         every pool worker and the editor worker (an id of its own, which their handlers ignore), the window's
         `InpaintEditor.pxInstances()`, and their sum. `--keep-mb N` is `--set keepMB=N`; `--set` takes any route of
         px/kernels.js `ROUTE_KINDS` (a number, js, rust or inf), set before the document is built and removed after.

A timing mode (--cold, --regrow) whose window was not in front prints NOT COUNTED and exits 2 (V8's efficiency mode,
docs/PERFORMANCE.md §10). With PX_PROBE_JSON set, every mode appends its raw result as one JSON line to that file.
"""
import asyncio
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

args = [a for a in sys.argv[1:]]


def take(flag, default=None):
    """The value after `flag` (removed from args), or `default`."""
    if flag not in args:
        return default
    i = args.index(flag)
    if i + 1 >= len(args):
        raise SystemExit(f"{flag} needs a value")
    v = args[i + 1]
    del args[i:i + 2]
    return v


def route_value(text):
    """A route's value as the window's `setRoute` takes it: js, rust, inf (Infinity, sent as the string) or a number."""
    t = text.strip().lower()
    if t in ("js", "rust", "inf"):
        return t
    try:
        v = float(t)
    except ValueError:
        raise SystemExit(f"route value {text!r}: js, rust, inf or a number")
    return int(v) if v.is_integer() else v


ROTATION = int(take("--rotation", "1"))
if ROTATION not in (1, 2, 3):
    raise SystemExit("--rotation is 1, 2 or 3")
ORDER = ["ABC", "BCA", "CAB"][ROTATION - 1]
COLD_SIZE = int(take("--size", "2048"))
REGROW_MB = [float(v) for v in take("--mb", "16,32,64,69,128").split(",") if v.strip()]
PAIRS = int(take("--pairs", "5"))
WAIT = float(take("--wait", "3"))
ROUTES = {}
keep = take("--keep-mb")
if keep is not None:
    ROUTES["keepMB"] = route_value(keep)
while "--set" in args:
    name, _, value = take("--set").partition("=")
    if not name or not value:
        raise SystemExit("--set NAME=V")
    ROUTES[name.strip()] = route_value(value)
MODES = []
for m in ("--cold", "--regrow", "--retention"):   # always in this order: --cold wants the instance untouched
    if m in args:
        MODES.append(m[2:])
        args.remove(m)
SIZES = [a for a in args if not a.startswith("-") and "x" in a.lower()]
RETENTION_SIZE = SIZES[0] if SIZES else "15000x10000"
left = [a for a in args if a not in SIZES]
if left:
    raise SystemExit(f"unknown arguments {left}\n\n{__doc__}")
if not MODES:
    raise SystemExit(__doc__)

# shared by the bodies: a message to a worker and its reply, matched by an id no editor job uses (a string), so the
# pool's and the editor worker's own handlers ignore the reply (inpaint_pool.js `_reply`, inpaint_jobs.js
# `editorWorker`); and a new worker of the editor's module, as the pool starts one
COMMON = r"""
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let seq = 0;
    const ask = (w, msg, transfer = [], timeout = 600000) => new Promise((resolve, reject) => {
        const id = "px_probe_" + (++seq);
        const done = (fn, v) => { clearTimeout(timer); w.removeEventListener("message", onMsg); w.removeEventListener("error", onErr); fn(v); };
        const onMsg = (e) => {
            const m = e.data || {};
            if (m.id !== id || m.progress) return;
            if (m.ok) done(resolve, m); else done(reject, new Error(msg.op + ": " + (m.error || "failed")));
        };
        const onErr = (e) => done(reject, new Error(msg.op + ": the worker failed: " + ((e && e.message) || e)));
        const timer = setTimeout(() => done(reject, new Error(msg.op + " timed out")), timeout);
        w.addEventListener("message", onMsg);
        w.addEventListener("error", onErr);
        try { w.postMessage({ id, ...msg }, transfer); } catch (err) { done(reject, err); }
    });
    const newWorker = () => new Worker(new URL("./editor/inpaint_worker.js", location.href), { type: "module" });
    // a probe reply's numbers, without the reply's own fields
    const pick = (r) => ({ ms: r.ms || [], compile: r.compile ?? null, instantiate: r.instantiate ?? null, bytes: r.bytes ?? null });
"""

COLD = r"""
(async () => {
    const SIZE = __SIZE__, ORDER = __ORDER__, WINDOW_CALLS = 5, FLOOD_CALLS = 3, MIP_CALLS = 200;
    __COMMON__
    if (window.__pxProbeCold) throw new Error("this instance ran --cold before: its code is warm, start a fresh instance");
    window.__pxProbeCold = true;
    const K = await import("./editor/px/kernels.js");
    await K.kernelsReady();
    if (typeof K.pxSettled === "function") await K.pxSettled();
    const p = K.rustPx();
    if (!p) throw new Error("no Rust kernels on the window (kernels mode " + K.kernelsMode() + ")");
    // the worker op's input and pregrow (inpaint_worker.js `pxProbe`), so W0 and a worker's call 0 time the same work:
    // a flat picture (the region all of it), built outside the clock, and the instance grown first by what a call
    // takes (the picture, the arena's 1 MB chunk, the span stack), so call 0 differs from call 1 only by the code's tier
    const rgba = new Uint8Array(SIZE * SIZE * 4).fill(128);
    const need = SIZE * SIZE * 4 + Math.max(4096, (SIZE * SIZE) >> 4) * 8 + (2 << 20);
    {
        const ptr = p.alloc(need);
        p.u8().fill(1, ptr, ptr + need);
        p.free(ptr, need);
    }
    const win = [];
    let count = -1;
    for (let i = 0; i < WINDOW_CALLS; i++) {
        const t0 = performance.now();
        count = p.floodShape(rgba, SIZE, SIZE, SIZE >> 1, SIZE >> 1, 32, true, null, 0xff0000, (v, n) => n);
        win.push(performance.now() - t0);
    }
    // C's bytes: px.wasm (the build kernels.js loads) with a custom section of its own appended (ignored by the
    // module, it makes the bytes new: section id 0, both lengths below 128, one LEB byte each)
    const raw = new Uint8Array(await (await fetch(new URL("./editor/px/px.wasm", location.href))).arrayBuffer());
    const enc = new TextEncoder(), name = enc.encode("px_probe_cold"), payload = enc.encode(`${Date.now()}-${ORDER}`);
    const body = new Uint8Array(1 + name.length + payload.length);
    body[0] = name.length;
    body.set(name, 1);
    body.set(payload, 1 + name.length);
    const fresh = new Uint8Array(raw.length + 2 + body.length);
    fresh.set(raw);
    fresh[raw.length] = 0;
    fresh[raw.length + 1] = body.length;
    fresh.set(body, raw.length + 2);
    const SOURCES = { A: "thread", B: "posted", C: "bytes" };
    const workers = {};
    for (const letter of ORDER) {
        const source = SOURCES[letter];
        const extra = source === "posted" ? { module: p.module } : source === "bytes" ? { bytes: fresh } : {};
        const base = { op: "px_probe", source, kernels: "rust", routes: {}, ...extra };
        const w = newWorker();
        try {
            const t0 = performance.now();
            const flood = await ask(w, { ...base, kernel: "flood_shape", size: SIZE, calls: FLOOD_CALLS, pregrow: true });
            const firstReplyMs = performance.now() - t0;   // the worker's start, its own load of px.wasm, the probe
            // pregrow here too: B and C answer each message on a new instance, A on the one the flood grew
            const mip = await ask(w, { ...base, kernel: "mip_chain", size: 256, calls: MIP_CALLS, pregrow: true });
            workers[letter] = { source, firstReplyMs, flood: pick(flood), mip: pick(mip) };
        } finally { w.terminate(); }
    }
    return JSON.stringify({
        mode: "cold", size: SIZE, order: ORDER, window: { ms: win, count, bytes: p.byteLength }, workers,
        focused: document.hasFocus(), visibility: document.visibilityState, cores: navigator.hardwareConcurrency,
    });
})()
"""

REGROW = r"""
(async () => {
    const MB = __MB__, PAIRS = __PAIRS__, WARM = 3;
    __COMMON__
    // the size whose flood grows an instance of about `mb`: 5.5 bytes a pixel (the picture's 4 and the span pairs' half
    // a byte, the rest the instance's growth beyond them; measured, see the docstring)
    const sizes = MB.map((mb) => Math.floor(Math.sqrt(mb * 1048576 / 5.5)));
    const w = newWorker();
    const call = async (size, renew) => {
        const r = await ask(w, { op: "px_probe", kernel: "flood_shape", size, calls: 1, source: "thread", renew, pregrow: false, kernels: "rust", routes: {} });
        return { ms: (r.ms || [])[0], bytes: r.bytes ?? null };
    };
    const rows = [];
    try {
        // the code warmed first (a long first call stays on the baseline tier), then a pause for the tier-up
        const warm = [];
        for (let i = 0; i < WARM; i++) warm.push(await call(sizes[0], false));
        await sleep(300);
        for (let k = 0; k < MB.length; k++) {
            const size = sizes[k];
            await call(size, false);   // the instance grown to this size, so a "grown" call never grows it
            const fresh = [], grown = [];
            for (let i = 0; i < PAIRS; i++) {
                for (const renew of i % 2 ? [false, true] : [true, false]) (renew ? fresh : grown).push(await call(size, renew));
            }
            rows.push({ mb: MB[k], size, fresh, grown });
        }
        return JSON.stringify({ mode: "regrow", pairs: PAIRS, warm, rows, focused: document.hasFocus(), visibility: document.visibilityState });
    } finally { w.terminate(); }
})()
"""

RETENTION = r"""
(async () => {
    const W = __W__, H = __H__, WAIT = __WAIT__, ROUTES = __ROUTES__;
    __COMMON__
    const shell = await import("./shell.js");
    const { host } = await import("./editor/host.js");
    const JOBS = await import("./editor/inpaint_jobs.js");
    const K = await import("./editor/px/kernels.js");
    const ed = shell.newDocument();
    shell.activate(ed);
    await sleep(300);
    ed.resizeCanvas();
    const E = ed.constructor;
    const set = [];
    // the bytes of every thread's px instance: the window's here, each worker's through `px_stats`
    const one = async (thread, w) => {
        try {
            const { id, ok, op, ...rest } = await ask(w, { op: "px_stats" }, [], 15000);
            return { thread, ...rest };
        } catch (err) { return { thread, error: String((err && err.message) || err) }; }
    };
    const stats = async () => {
        const out = [{ thread: "window", ...(typeof E.pxInstances === "function" ? E.pxInstances() : K.pxInstances()) }];
        const ew = JOBS.editorWorker();
        if (ew) out.push(await one("editor worker", ew));
        const pool = E.parts.pool();
        for (let i = 0; i < pool.workers.length; i++) out.push(await one(`pool ${i + 1}`, pool.workers[i].w));
        return out;
    };
    try {
        if (!ed.tileMode) throw new Error("the retention probe measures the tile engine: start the app with tiles on");
        for (const [name, v] of Object.entries(ROUTES)) { E.setRoute(name, v === "inf" ? Infinity : v); set.push(name); }
        // px_jobs.py's document: a gradient base with discs, one full-size paint layer
        const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
        const base = mk(W, H);
        {
            const x = base.getContext("2d");
            const g = x.createLinearGradient(0, 0, W, H);
            g.addColorStop(0, "hsl(210,70%,45%)");
            g.addColorStop(1, "hsl(300,70%,25%)");
            x.fillStyle = g;
            x.fillRect(0, 0, W, H);
            for (let i = 0; i < 60; i++) {
                x.fillStyle = `hsl(${(i * 37) % 360},80%,55%)`;
                x.beginPath();
                x.arc((i * 977) % W, (i * 613) % H, Math.max(8, W / 40), 0, Math.PI * 2);
                x.fill();
            }
        }
        Object.defineProperty(base, "naturalWidth", { value: W });
        Object.defineProperty(base, "naturalHeight", { value: H });
        await ed.setBase({ filename: "pxprobe.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
        base.width = 1;
        const pc = mk(W, H);
        {
            const x = pc.getContext("2d");
            x.fillStyle = "hsla(60,80%,50%,0.35)";
            x.fillRect(40, 40, W - 120, H - 120);
            for (let k = 0; k < 20; k++) { x.fillStyle = `hsl(${(k * 53) % 360},70%,60%)`; x.fillRect((k * 811) % W, (k * 457) % H, W / 25, H / 25); }
        }
        ed.addLayer({ name: "Paint", kind: "paint", px: ed.pixels.Layer.fromCanvas(pc), x: 0, y: 0, w: W, h: H, dirty: true });
        pc.width = 1;
        ed.renderLayers(); ed.fitView(); ed.draw();
        await ed.mipsSettled();
        ed.sel.clear();
        ed.markSelectionChanged();
        const before = await stats();
        // the PNG export as native_test.py's export_png row runs it: host.saveExport stubbed, the file kept in memory
        let saved = null;
        const was = host.saveExport;
        host.saveExport = async (blob, name) => { saved = { blob, name }; return { path: "memory:" + name }; };
        const t0 = performance.now();
        try { ed.saveFormatSel.value = "png"; await ed.exportImage({ download: false }); } finally { host.saveExport = was; ed.saveFormatSel.value = "png"; }
        const exportMs = performance.now() - t0;
        if (!saved) throw new Error("the export saved nothing: " + ed.status);
        const after = await stats();
        await sleep(WAIT * 1000);
        const later = await stats();
        const routes = Object.fromEntries(Object.entries(E.routes).map(([k, v]) => [k, v === Infinity ? "inf" : v]));   // JSON has no Infinity
        return JSON.stringify({
            mode: "retention", size: `${W}x${H}`, routes, wait: WAIT, exportMs, MB: saved.blob.size / 1048576,
            before, after, later, focused: document.hasFocus(), visibility: document.visibilityState,
        });
    } finally {
        for (const name of set) { try { E.setRoute(name, null); } catch (_) { /* ignore */ } }
        shell.closeDocument(ed, { force: true });
    }
})()
"""


def med(vals):
    vals = [v for v in vals if isinstance(v, (int, float))]
    return statistics.median(vals) if vals else 0.0


def mb(b):
    return f"{b / 1048576:7.1f}" if isinstance(b, (int, float)) else "      -"


def first_and_rest(ms, rest_from=1, rest_to=None):
    """Call 0 and the median of the calls from `rest_from` (to `rest_to`, exclusive), with their ratio."""
    ms = [v for v in (ms or []) if isinstance(v, (int, float))]
    if not ms:
        return None, None, None
    rest = ms[rest_from:rest_to]
    warm = med(rest) if rest else None
    return ms[0], warm, (ms[0] / warm if warm else None)


def ratio_text(first, warm, ratio, what="rest median"):
    if first is None:
        return "no calls"
    if warm is None:
        return f"call 0 {first:.1f} ms, no further calls"
    return f"call 0 {first:.1f} ms, {what} {warm:.1f} ms ({ratio:.2f}x)"


def hint(ratios):
    """M5's table from one instance: A and B are nearer the warm figure or C's cold call 0 (a ratio of 1 is warm)."""
    rc = ratios.get("C")
    ra, rb = ratios.get("A"), ratios.get("B")
    if rc is None or ra is None or rb is None:
        return "no hint: a worker gave no figure"
    if rc < 1.15:
        return f"no hint: C's call 0 is {rc:.2f}x its warm calls, so cold code does not show at this size"
    mid = (1 + rc) / 2
    a_warm, b_warm = ra < mid, rb < mid
    if a_warm and b_warm:
        row = "A0 ~ B0 ~ warm: V8 shares code across isolates (posting a module saves only compile; no warm-up needed)"
    elif b_warm:
        row = "A0 ~ C0 (cold), B0 ~ warm: sharing only when the Module is posted (candidate: post the window's Module)"
    elif not a_warm:
        row = "B0 ~ C0: not shared even when posted (candidates: a warm-up per worker, or flags, M6)"
    else:
        row = "A0 ~ warm but B0 ~ cold: in no row of the table; look at the numbers"
    return f"A {ra:.2f}x, B {rb:.2f}x, C {rc:.2f}x of their warm calls -> {row}"


def report_cold(r):
    print(f"\n== cold calls (M5, rotation {ROTATION}: {r['order']}), flood_shape {r['size']}^2, mip_chain 256^2"
          f"  (window focused {r.get('focused')}, {r.get('visibility')}, {r.get('cores')} logical cores)")
    w = r["window"]
    first, warm, ratio = first_and_rest(w["ms"], 2, 5)
    second = w["ms"][1] if len(w["ms"]) > 1 else None
    print(f"  window      flood_shape: W0 {ratio_text(first, warm, ratio, 'calls 2-4 median')}"
          + (f"; call 1 {second:.1f} ms" if second is not None else "")
          + f"; {w['count']} pixels in the region, instance {mb(w.get('bytes')).strip()} MB")
    ratios = {"flood": {}, "mip": {}}
    for letter in r["order"]:
        x = r["workers"].get(letter)
        if not x:
            print(f"  {letter}           no result")
            continue
        for kernel, label in (("flood", "flood_shape"), ("mip", "mip_chain")):
            k = x[kernel]
            first, warm, ratio = first_and_rest(k["ms"])
            ratios[kernel][letter] = ratio
            setup = []
            if isinstance(k.get("compile"), (int, float)):
                setup.append(f"compile {k['compile']:.1f}")
            if isinstance(k.get("instantiate"), (int, float)):
                setup.append(f"instantiate {k['instantiate']:.1f}")
            more = f"  ({', '.join(setup)} ms)" if setup else ""
            if kernel == "flood":
                more += f"  first reply after {x['firstReplyMs']:.0f} ms, instance {mb(k.get('bytes')).strip()} MB"
            head = f"  {letter} {x['source']:8s}" if kernel == "flood" else " " * 12
            print(f"{head}  {label}: {ratio_text(first, warm, ratio)}{more}")
    print("  hint (this instance only; M5's verdict takes the three rotations):")
    print(f"    flood_shape: {hint(ratios['flood'])}")
    print(f"    mip_chain:   {hint(ratios['mip'])}")


def report_regrow(r):
    print(f"\n== re-growth (M7a): flood_shape on a fresh instance of the warm module against the instance it grew, "
          f"{r['pairs']} pairs per size, one worker  (window focused {r.get('focused')}, {r.get('visibility')})")
    warm = ", ".join(f"{c['ms']:.1f}" for c in r.get("warm") or [] if isinstance(c.get("ms"), (int, float)))
    print(f"  warm-up calls: {warm or '-'} ms")
    print(f"  {'MB':>6s} {'size':>6s}   {'fresh median [min-max]':>24s}   {'grown median [min-max]':>24s}   {'penalty':>8s}   instance MB")
    for row in r["rows"]:
        fresh = [c["ms"] for c in row["fresh"] if isinstance(c.get("ms"), (int, float))]
        grown = [c["ms"] for c in row["grown"] if isinstance(c.get("ms"), (int, float))]
        fm, gm = med(fresh), med(grown)
        span = lambda v: f"{med(v):8.1f} [{min(v):.1f}-{max(v):.1f}]" if v else "-"  # noqa: E731
        size_mb = max((c.get("bytes") or 0) for c in row["fresh"] + row["grown"])
        print(f"  {row['mb']:6.0f} {row['size']:6d}   {span(fresh):>24s}   {span(grown):>24s}   {fm - gm:8.1f}   {mb(size_mb).strip()}")


def report_retention(r):
    print(f"\n== retention (M7b): px instance bytes per thread after a PNG export of {r['size']} "
          f"({r['MB']:.0f} MB in {r['exportMs']:.0f} ms)  (window focused {r.get('focused')}, {r.get('visibility')})")
    routes = r.get("routes") or {}
    print("  routes: " + (", ".join(f"{k} {json.dumps(v)}" for k, v in routes.items()) or "-"))
    later = {s["thread"]: s for s in r["later"]}
    after = {s["thread"]: s for s in r["after"]}
    before = {s["thread"]: s for s in r["before"]}
    threads = list(dict.fromkeys([s["thread"] for s in r["before"] + r["after"] + r["later"]]))
    counted = ("serial", "release", "idle", "trap", "oom", "sync", "async")
    print(f"  {'thread':14s} {'before':>7s} {'after':>7s} {'+' + format(r['wait'], 'g') + ' s':>7s}  MB  "
          + "".join(f"{k:>8s}" for k in counted))
    total = {"before": 0, "after": 0, "later": 0}
    for t in threads:
        cols = []
        for key, src in (("before", before), ("after", after), ("later", later)):
            s = src.get(t) or {}
            b = s.get("bytes")
            if isinstance(b, (int, float)):
                total[key] += b
            cols.append(mb(b) if "error" not in s else "  error")
        s = later.get(t) or after.get(t) or {}
        if "error" in s:
            print(f"  {t:14s} {' '.join(cols)}      {s['error'][:120]}")
            continue
        print(f"  {t:14s} {' '.join(cols)}      " + "".join(f"{s.get(k, '-')!s:>8s}" for k in counted))
    print(f"  {'sum':14s} {mb(total['before'])} {mb(total['after'])} {mb(total['later'])}")


async def main():
    sys.stdout.reconfigure(encoding="utf-8")

    async def run(c):
        not_counted = False
        for mode in MODES:
            if mode == "cold":
                body = COLD.replace("__COMMON__", COMMON).replace("__SIZE__", str(COLD_SIZE)).replace("__ORDER__", json.dumps(ORDER))
                print(f"-- cold calls, rotation {ROTATION} ({ORDER}) ...", flush=True)
                r = json.loads(await c.eval(body, timeout=1800))
                report_cold(r)
            elif mode == "regrow":
                body = REGROW.replace("__COMMON__", COMMON).replace("__MB__", json.dumps(REGROW_MB)).replace("__PAIRS__", str(PAIRS))
                print(f"-- re-growth at {', '.join(f'{v:g}' for v in REGROW_MB)} MB ...", flush=True)
                r = json.loads(await c.eval(body, timeout=1800))
                report_regrow(r)
            else:
                connected = await c.eval("(async () => { const s = await window.scumble.comfy.status(); return s && s.state; })()")
                if connected in ("connected", "missing-node"):
                    print("this instance is connected to ComfyUI: start it with --no-comfy, or the uploads are forwarded to the server")
                    print("\nFAIL")
                    return 1
                w, h = (int(v) for v in RETENTION_SIZE.lower().split("x"))
                body = (RETENTION.replace("__COMMON__", COMMON).replace("__W__", str(w)).replace("__H__", str(h))
                        .replace("__WAIT__", json.dumps(WAIT)).replace("__ROUTES__", json.dumps(ROUTES)))
                print(f"-- retention after a PNG export of {RETENTION_SIZE}" + (f", routes {ROUTES}" if ROUTES else "") + " ...", flush=True)
                r = json.loads(await c.eval(body, timeout=3600))
                report_retention(r)
            if os.environ.get("PX_PROBE_JSON"):
                with open(os.environ["PX_PROBE_JSON"], "a", encoding="utf-8", newline=chr(10)) as f:
                    f.write(json.dumps({**r, "rotation": ROTATION} if mode == "cold" else r) + "\n")
            if mode != "retention" and (not r.get("focused") or r.get("visibility") != "visible"):
                print(f"  NOT COUNTED: the window was not in front (focused {r.get('focused')}, {r.get('visibility')})")
                not_counted = True
        for level, text in (await c.logs())[-15:]:
            if level == "error":
                print("  console error:", text[:300])
        # the verdict line tools/run_gates.sh reads (a probe passes when it ran; its numbers are read, not judged)
        print("\nNOT COUNTED" if not_counted else "\nPASS")
        return 2 if not_counted else 0

    sys.exit(await session(run))


if __name__ == "__main__":
    asyncio.run(main())
