"""Phase R: the worker jobs with a pixel kernel, JS against Rust, where they run (docs/PLAN_BCE.md §2b).

Start the app with a debugging port first (see tools/cdp.py), then:

    python tools/px_jobs.py                        # equality at 2048x1152, then timings at 15000x10000
    python tools/px_jobs.py --rounds 5 12000x8000  # timings only, one size

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

The worker replies with the milliseconds of each part of a job (`timing`), which the table splits into the
kernel's part and the rest; "wall" is the operation on the main thread. With `--check` (the default for the
first, small size) the two kernel sets must give the same bytes: every chain and edge chain of the mips job,
the selection after grow, shrink and both wands. Restart the app before a timing run.
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

    const hex = async (u8) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", u8))).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
    const selHash = async () => hex(ed.sel.readRect(0, 0, W, H).data);
    const rect = () => {
        ed.sel.clear();
        ed.sel.fill([Math.round(W * 0.2), Math.round(H * 0.2), Math.round(W * 0.6), Math.round(H * 0.6)], "#ff0000");
        ed.markSelectionChanged();
        ed.getBounds();
    };
    const parts = (list) => {
        const out = {};
        for (const t of list) for (const [k, v] of Object.entries(t)) if (typeof v === "number") out[k] = (out[k] || 0) + v;
        out.jobs = list.length;
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
        E.kernels = kernels;
        const list = tileList(ed.basePx);
        E.jobTimings(true);
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
        return { wall, ...parts(timings), digest, tilesSent: list.length };
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
        return { wall, ...parts(timings), digest };
    };
    const mipsWhole = async (kernels) => {
        E.kernels = kernels;
        await ed.mipsSettled();
        await sleep(50);
        E.jobTimings(true);
        T.chainStats(true);
        const t0 = performance.now();
        paint.px = ed.turnedTilePixels(paint.px, "h");
        ed.markLayerChanged(paint);
        ed.renderLayers();
        ed.draw();
        await ed.mipsSettled();
        const wall = performance.now() - t0;
        const cs = T.chainStats();
        const timings = E.jobTimings(true).filter((t) => t.op === "mips");
        // flipped back, so every kernel set's selection jobs see the same picture
        paint.px = ed.turnedTilePixels(paint.px, "h");
        ed.markLayerChanged(paint);
        ed.renderLayers();
        ed.draw();
        await ed.mipsSettled();
        E.jobTimings(true);
        return { wall, ...parts(timings), main: cs.main, requested: cs.requested };
    };
    const op = async (kernels, fn, want) => {
        E.kernels = kernels;
        await ed.mipsSettled();
        await sleep(50);
        E.jobTimings(true);
        const t0 = performance.now();
        await fn();
        const wall = performance.now() - t0;
        const timings = E.jobTimings(true).filter((t) => t.op === want);
        const out = { wall, ...parts(timings) };
        if (CHECK) out.digest = await selHash();
        await ed.mipsSettled();
        return out;
    };

    const rows = [];
    const ONLY = %(only)s;
    const step = async (job, k, round, fn) => {
        if (ONLY && !ONLY.includes(job)) return;
        window.__pxjobs = `${job} ${k} round ${round}`;
        rows.push({ job, kernels: k, round, ...(await fn()) });
    };
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
            ed.clearUndo();
        }
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
}
# the pixel work a kernel set does after the job has read its pixels: with Rust the grow job is one call ("kernel"),
# the flood job one call ("flood") between reading the selection ("clip") and drawing the shape ("shape")
PIXEL_WORK = ["kernel", "edt", "bounds", "feature", "write", "resultBounds"]
KERNEL = {"mips_direct": ["kernel"], "mips_whole": ["kernel"], "band": ["kernel"], "grow": PIXEL_WORK, "shrink": PIXEL_WORK,
          "wand_band": ["flood", "clip", "bounds", "shape"], "wand_object": ["flood", "clip", "bounds", "shape"]}


def med(rows, key):
    vals = [r.get(key, 0) for r in rows]
    return statistics.median(vals) if vals else 0


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
            print(f"  {job:12s} {'same bytes' if same else 'DIFFERENT BYTES ' + str(sorted(d or '-' for d in digests))}")
        kj = sum(med(js, k) for k in KERNEL[job])
        kr = sum(med(rs, k) for k in KERNEL[job])
        tj, tr = med(js, "total") or med(js, "kernel"), med(rs, "total") or med(rs, "kernel")
        wj, wr = med(js, "wall"), med(rs, "wall")
        extra = ""
        if job.startswith("mips") or job == "band":
            extra = f"  tiles {med(js, 'tiles'):.0f} in {med(js, 'jobs'):.0f} jobs"
            if job == "mips_whole":
                extra += f", built on the main thread js {med(js, 'main'):.0f} / rust {med(rs, 'main'):.0f}"
        else:
            extra = f"  {med(js, 'pixels') / 1e6:.1f} MP in {med(js, 'jobs'):.0f} jobs"
        print(f"  {job:12s} kernel js {kj:8.1f}  rust {kr:8.1f}  ({kj / kr if kr else 0:4.2f}x) | worker job js {tj:8.1f}  rust {tr:8.1f}"
              f"  ({tj / tr if tr else 0:4.2f}x) | wall js {wj:8.1f}  rust {wr:8.1f}  ({wj / wr if wr else 0:4.2f}x){extra}")
        detail = "  ".join(f"{k} {med(js, k):.1f}/{med(rs, k):.1f}" for k in PARTS[job] if med(js, k) or med(rs, k))
        if detail:
            print(f"  {'':12s} parts js/rust: {detail}")
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
