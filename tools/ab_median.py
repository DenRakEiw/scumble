"""The A/B verdict over several runs of tools/px_jobs.py (docs/PLAN_WASM_K1.md S8; the rule of
docs/PLAN_WASM_BUILD.md §1.1).

Each run of px_jobs.py appends one JSON line per size to the file named by PX_JOBS_JSON (K1's chain gives every run a
file of its own); this reads any number of them:

    python tools/ab_median.py k1-m3-r1.jsonl k1-m3-r2.jsonl k1-m3-r3.jsonl
    python tools/ab_median.py --only wand_object,wand_band --route flood docs/measurements/k1_<date>/m3_*.jsonl
    python tools/ab_median.py --key kernel run1.jsonl run2.jsonl run3.jsonl

Every line is one run of its size. The arms are px_jobs.py's two columns: "js" holds the --ab's first value (A),
"rust" its second (B), so with --ab flood=js:rust (K1's M2-M4) "rust" is the Rust arm and "js" the twin. Per row and
arm it prints the median of each run's rounds (round 0 included: all rounds decide), the median of those per-run
medians, and the spread: max - min of the per-run medians, the larger of the two arms'. Round 0 is printed apart as the
cold figure.

The verdict (§1.1):
  rust   its median is lower than the twin's by more than the spread
  twin   the twin's is lower by more than the spread
  inside the spread: rust only when its kernel row is strictly faster than the twin's, else the twin.
The kernel row of both arms is the same: px_jobs.py's kernel parts of the row (its KERNEL columns, read from its
source; for the wand and the ladder the jobs' flood + clip + bounds + shape, the laps every flood job times the same
way on either branch, from the picture read to the shape drawn), as px_jobs.py's own report compares them. The split,
where the runs have one (px_jobs.py --split), only explains it: per arm the route's exports' `ms` and `copyIn`, the
jobs' (`split.jobs`) and the window's (`split.window`) apart. The route (whose exports the split line names) is
--route, else the run's own `ab`, else guessed from the rows: the wand and ladder rows are flood's, the mips rows mips';
for the legacy kernels flip every export counts.

Left out, each named: a run with `check` (one round, the split's clocks and the hashes on), a `failed` run, one whose
window was behind, one whose threads renewed an instance after a trap or out of memory (px_jobs.py's `instances`); and
a row whose route did not run (`routeRan`) or whose split renewed an instance after a trap or out of memory.

The flood ladder's rows (flood_ladder_<s>) also get the threshold: the smallest step from which the verdict is rust at
every larger step (the conservative end, the design's §3 "Thresholds"), with that step's box in pixels (the row's
`key`: its box job's box, not the wand's coarse pass; lines written before that fix carry the largest flood job's).
Fewer than three runs kept decide nothing (§1.1): the verdicts are printed, marked so.
"""
import ast
import json
import os
import statistics
import sys

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


KEY = take("--key", "wall")
ROUTE = take("--route")
ONLY = take("--only")
ONLY = [j for j in ONLY.split(",") if j] if ONLY else None
PATHS = [a for a in args if not a.startswith("-")]
if [a for a in args if a.startswith("-")] or not PATHS:
    raise SystemExit(__doc__)

ARMS = ("js", "rust")
# the exports a route sends to the twin (px/kernels.js: `rustPx("flood", size)` in floodShape and floodMask,
# `rustPx("mips")` in mipHalf, mipChain and clampExtend); a route not named here counts every export
ROUTE_EXPORTS = {"flood": ("flood_shape", "flood"), "mips": ("mip_chain", "clamp_extend", "mip_half")}


def kernel_table():
    """px_jobs.py's KERNEL (the twin's kernel parts per row), read from its source without running it: the script parses
    its own arguments when it is imported."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "px_jobs.py")
    try:
        with open(path, encoding="utf-8") as f:
            tree = ast.parse(f.read())
    except (OSError, SyntaxError) as err:
        print(f"px_jobs.py not read ({err}): no kernel parts, the tie goes to the twin")
        return {}
    # every plain top-level constant in order (KERNEL names PIXEL_WORK); one that needs the script's state (its
    # arguments, imports) fails and is left out
    ns = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
            try:
                ns[name] = eval(compile(ast.Expression(node.value), path, "eval"), {"__builtins__": {}, **ns})
            except Exception as err:  # noqa: BLE001
                if name == "KERNEL":
                    print(f"px_jobs.py's KERNEL not read ({err}): no kernel parts, the tie goes to the twin")
    return ns.get("KERNEL") if isinstance(ns.get("KERNEL"), dict) else {}


KERNEL = kernel_table()


def num(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def med(vals):
    vals = [v for v in vals if v is not None]
    return statistics.median(vals) if vals else None


def fmt(v, width=8):
    return f"{v:{width}.1f}" if v is not None else f"{'-':>{width}s}"


def load(paths):
    """Every JSON line with rows, as (label, result); a line that is no px_jobs.py result is named and skipped."""
    runs = []
    for p in paths:
        with open(p, encoding="utf-8") as f:
            for n, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except ValueError as err:
                    print(f"{p}:{n}: not JSON ({err}), skipped")
                    continue
                if isinstance(r, dict) and isinstance(r.get("rows"), list):
                    runs.append((f"{os.path.basename(p)}:{n}", r))
                else:
                    print(f"{p}:{n}: no rows, skipped")
    return runs


def route_of(results, jobs):
    """The route whose exports make the kernel row: --route, the runs' own `ab` ("name=A:B" or { name }), or a guess
    from the rows; None (every export) for the kernels flip and the stacks switch."""
    name = ROUTE
    if not name:
        for r in results:
            ab = r.get("ab")
            if isinstance(ab, dict):
                name = ab.get("name")
            elif isinstance(ab, str):
                name = ab.split("=", 1)[0]
            if name:
                break
    if not name:
        if jobs and all(j.startswith("mips") for j in jobs):
            name = "mips"
        elif jobs and all(j.startswith(("wand", "flood_ladder")) for j in jobs):
            name = "flood"
    return name if name in ROUTE_EXPORTS else None


def split_side(row, side, exports):
    """One side of a row's split ("jobs" or "window", px_jobs.py `splitOf`): (the route's exports' ms, copyIn), None
    where the row has no such side."""
    s = (row.get("split") or {}).get(side)
    if not isinstance(s, dict) or not isinstance(s.get("ms"), dict):
        return None
    ms = sum(num(v) or 0.0 for k, v in s["ms"].items() if exports is None or k in exports)
    return ms, num(s.get("copyIn")) or 0.0


def left_out_run(r):
    """Why a run does not count, or None when it does."""
    if r.get("check"):
        return "a --check run (one round, the split's clocks and the hashes on)"
    if r.get("failed"):
        return "a failed run"
    if r.get("focused") is False or r.get("visibility") not in (None, "visible"):
        return f"the window was behind (focused {r.get('focused')}, {r.get('visibility')})"
    inst = r.get("instances") or {}
    traps = (num(inst.get("trap")) or 0) + (num(inst.get("oom")) or 0)
    replies = len(inst.get("replies") or [])
    if traps or replies:
        return f"instances renewed after a trap or out of memory on its threads ({traps:.0f}; {replies} error replies naming a trap)"
    return None


def left_out_row(x):
    """Why a row does not count, or None when it does."""
    if x.get("routeRan"):
        return "route not taken: " + "; ".join(str(v) for v in x["routeRan"])
    rn = x.get("renewed") or {}
    traps = (num(rn.get("trap")) or 0) + (num(rn.get("oom")) or 0)
    if traps:
        return f"{traps:.0f} instance(s) renewed after a trap or out of memory"
    return None


def kernel_cols(job):
    """px_jobs.py's kernel parts of a row; a ladder step takes its own entry, else the wand's."""
    if job in KERNEL:
        return KERNEL[job]
    if job.startswith("flood_ladder"):
        return KERNEL.get("flood_ladder") or KERNEL.get("wand_object")
    return None


def parts_kernel(row, job):
    cols = kernel_cols(job)
    if not cols:
        return None
    return sum(num(row.get(k)) or 0.0 for k in cols)


def verdict(mj, mr, spread, kj, kr):
    """§1.1: the wall decides beyond the spread; inside it, Rust only with a strictly faster kernel row."""
    if mj is None or mr is None:
        return "-", "an arm has no rows"
    if mj - mr > spread:
        return "rust", f"its median lower by {mj - mr:.1f}, beyond the spread {spread:.1f}"
    if mr - mj > spread:
        return "twin", f"its median lower by {mr - mj:.1f}, beyond the spread {spread:.1f}"
    if kj is not None and kr is not None:
        if kr < kj:
            return "rust", f"inside the spread {spread:.1f}; the kernel row faster ({kr:.1f} against {kj:.1f})"
        return "twin", f"inside the spread {spread:.1f}; the kernel row not faster ({kr:.1f} against {kj:.1f})"
    return "twin", f"inside the spread {spread:.1f}; no kernel row to break the tie"


def in_scope(job):
    return bool(job) and (not ONLY or job in ONLY or any(job.startswith(o + "_") for o in ONLY))


def report_size(size, runs):
    # the runs and rows that do not count, each named (§1.1: a window behind, a check, a failure; a route not taken or
    # a trap in a row)
    kept, dropped = [], []
    for lbl, r in runs:
        why = left_out_run(r)
        (dropped if why else kept).append((lbl, r, why))
    rows_of, dropped_rows = {}, []
    for lbl, r, _ in kept:
        rows_of[lbl] = []
        for x in r["rows"]:
            why = left_out_row(x) if in_scope(x.get("job")) else None
            if why:
                dropped_rows.append(f"{lbl} {x.get('job')} {x.get('kernels')} round {x.get('round')}: {why}")
            else:
                rows_of[lbl].append(x)
    results = [r for _, r, _ in kept]
    jobs = []
    for lbl, _, _ in kept:
        for row in rows_of[lbl]:
            j = row.get("job")
            if j not in jobs and in_scope(j):
                jobs.append(j)
    route = route_of(results, jobs)
    exports = ROUTE_EXPORTS.get(route) if route else None
    print(f"\n== {size}  ({len(kept)} run{'s' if len(kept) != 1 else ''} kept: {', '.join(lbl for lbl, _, _ in kept) or '-'}; key {KEY}; "
          f"kernel row px_jobs.py's kernel parts, both arms; split {'the ' + route + ' route: ' + ' + '.join(exports) if exports else 'every export'} + copyIn)")
    for lbl, _, why in dropped:
        print(f"  left out {lbl}: {why}")
    for text in dropped_rows:
        print(f"  left out the row {text}")
    if len(kept) < 3:
        print(f"  fewer than three runs kept ({len(kept)}): one run decides nothing (§1.1), the verdicts below are not decisions")
    ladder = []
    for job in jobs:
        per = {}
        for arm in ARMS:
            meds, cold, kern, flags = [], [], [], 0
            jside, wside = [], []   # the split's sides, per run: (the route's exports' ms, copyIn) medians
            for lbl, _, _ in kept:
                rows = [x for x in rows_of[lbl] if x.get("job") == job and x.get("kernels") == arm]
                if not rows:
                    continue
                meds.append(med([num(x.get(KEY)) for x in rows]))
                cold += [num(x.get(KEY)) for x in rows if x.get("round") == 0]
                flags += sum(1 for x in rows if x.get("settleTimeout"))
                kern.append(med([parts_kernel(x, job) for x in rows]))
                for side, acc in (("jobs", jside), ("window", wside)):
                    got = [split_side(x, side, exports) for x in rows]
                    got = [g for g in got if g is not None]
                    if got:
                        acc.append((med([g[0] for g in got]), med([g[1] for g in got])))
            meds = [m for m in meds if m is not None]
            per[arm] = {"runs": meds, "median": med(meds), "spread": (max(meds) - min(meds)) if meds else 0.0,
                        "cold": med(cold), "kernel": med(kern), "flags": flags,
                        "jobs": (med([s[0] for s in jside]), med([s[1] for s in jside])) if jside else None,
                        "window": (med([s[0] for s in wside]), med([s[1] for s in wside])) if wside else None}
        js, rs = per["js"], per["rust"]
        if not js["runs"] and not rs["runs"]:
            continue
        spread = max(js["spread"], rs["spread"])
        kj, kr = js["kernel"], rs["kernel"]
        v, why = verdict(js["median"], rs["median"], spread, kj, kr)
        print(f"  {job}")
        for arm in ARMS:
            a = per[arm]
            runs_txt = " ".join(fmt(m, 0) for m in a["runs"]) or "-"
            print(f"    {arm:4s} per run {runs_txt:30s} | median {fmt(a['median'])} | spread {fmt(a['spread'])}"
                  + (f"  ({a['flags']} row(s) whose settle timed out)" if a["flags"] else ""))
        cols = " + ".join(kernel_cols(job) or []) or "no kernel parts in px_jobs.py"
        print(f"    round 0 (cold) js {fmt(js['cold']).strip()} / rust {fmt(rs['cold']).strip()}; "
              f"kernel row js {fmt(kj).strip()} / rust {fmt(kr).strip()} ({cols})")
        if any(per[arm][side] for arm in ARMS for side in ("jobs", "window")):
            def side_text(arm, side):
                s = per[arm][side]
                return f"{side} -" if not s else f"{side} {s[0]:.1f} + copyIn {s[1]:.1f}"
            print(f"    split (explains, does not decide; {' + '.join(exports) if exports else 'every export'}): "
                  + " | ".join(f"{arm} {side_text(arm, 'jobs')}, {side_text(arm, 'window')}" for arm in ARMS))
        print(f"    verdict: {v} ({why})")
        if job.startswith("flood_ladder_"):
            step = job.rsplit("_", 1)[1]
            # px_jobs.py's `key`: the row's box job's box (its `pixels` sums every flood job of the row, the coarse
            # pass's included)
            pixels = med([num(x.get("key")) if num(x.get("key")) is not None else num(x.get("pixels"))
                          for lbl, _, _ in kept for x in rows_of[lbl] if x.get("job") == job])
            if step.isdigit():
                ladder.append((int(step), pixels, v))
    if ladder:
        ladder.sort()
        print("  flood ladder: " + ", ".join(f"{s} {v}" for s, _, v in ladder))
        tail = len(ladder)
        while tail > 0 and ladder[tail - 1][2] == "rust":
            tail -= 1
        if tail == len(ladder):
            print("    no threshold: the twin at the largest step")
        elif tail == 0:
            print(f"    rust at every step from {ladder[0][0]}: no flood entry")
        else:
            s, px, _ = ladder[tail]
            print(f"    threshold: rust from step {s} at every larger step: flood = {px:.0f} pixels" if px is not None
                  else f"    threshold: rust from step {s} at every larger step (the rows carry no pixels)")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    runs = load(PATHS)
    if not runs:
        raise SystemExit("no px_jobs.py results in " + ", ".join(PATHS))
    by_size = {}
    for label, r in runs:
        by_size.setdefault(r.get("size", "?"), []).append((label, r))
    for size, rs in by_size.items():
        report_size(size, rs)


if __name__ == "__main__":
    main()
