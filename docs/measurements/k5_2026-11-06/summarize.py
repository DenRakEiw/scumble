"""K5's rows from one chain folder (k5_chain.sh): medians of three runs and their spread (max - min).

    python docs/measurements/k5_2026-11-06/summarize.py docs/measurements/k5_2026-11-06/before

native_test (profiled): wall, longest block and the window's functions of the combine by self time; selection_test:
selectRange's ms and the window's combine (the "range" marks); the perf gate's selection rows (blocked [wall]);
px_jobs: tools/ab_median.py over the runs' JSON lines (both arms of the run's flip).
"""
import glob
import json
import os
import re
import statistics
import subprocess
import sys

D = sys.argv[1]
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def med(vals):
    vals = [v for v in vals if v is not None]
    if not vals:
        return "-"
    m = statistics.median(vals)
    return f"{m:,.0f} ({min(vals):,.0f}-{max(vals):,.0f})" if len(vals) > 1 else f"{m:,.0f}"


def runs(pattern):
    return sorted(glob.glob(os.path.join(D, pattern)))


print(f"== {D}")
# the window's functions of the combine and the selection's bounds, by name (self time, ms)
FNS = [("combineRows", r"^combineRows \["), ("read", r"^read \[inpaint_raster"), ("view", r"^view \[inpaint_raster"),
       ("mul255", r"^mul255 \["), ("selCombine (twin)", r"^selCombine \[kernels_js"), ("alphaAny", r"^alphaAny \["),
       ("px.js selCombine", r"^selCombine \[px\.js"), ("sel_combine (wasm)", r"sel_combine"), ("combine", r"^combine \[inpaint_tiles"),
       ("tileExtent", r"^tileExtent \[|^\(anonymous\) \[inpaint_tiles\.js:618\]"), ("tileEmpty", r"^tileEmpty \["),
       ("writable", r"^writable \["), ("allocTileBytes", r"^allocTileBytes \["), ("_in", r"^_in \[px"), ("_out", r"^_out \[px")]
native = [json.load(open(p, encoding="utf-8")) for p in runs("native/r*.json")]
print(f"\nnative_test, {len(native)} runs: wall | longest block | window self time of the combine's functions")
for row in ("grow_16", "shrink_16", "invert", "wand_whole_picture", "wand_whole_add", "wand_one_disc"):
    rs = [n["rows"].get(row) for n in native if n["rows"].get(row)]
    walls = [r["row"].get("wall") for r in rs if isinstance(r.get("row"), dict)]
    blks = [r["row"].get("blocked") for r in rs if isinstance(r.get("row"), dict)]
    parts = []
    for label, rx in FNS:
        vals = []
        for r in rs:
            p = r.get("profile") or {}
            both = {**(p.get("pxfn") or {}), **(p.get("fn") or {})}
            vals.append(sum(v for k, v in both.items() if re.search(rx, k)))
        if any(vals):
            parts.append(f"{label} {med(vals)}")
    print(f"  {row:20s} wall {med(walls)} | blk {med(blks)}")
    if parts:
        print("     " + "; ".join(parts))

print("\nselection_test 15k range cases: selectRange ms | the window's combine (marks' combineMs) | readMs")
sel = {"depth": ([], [], []), "luma": ([], [], [])}
for p in runs("selection/r*.log"):
    for line in open(p, encoding="utf-8", errors="replace"):
        m = re.search(r'marks range: .*\(source "(\w+)"', line)
        cm, ms, rm = (re.search(r"(?<![A-Za-z])" + k + r" ([\d.]+)", line) for k in ("combineMs", "ms", "readMs"))
        if m and m.group(1) in sel and cm and ms:
            sel[m.group(1)][0].append(float(ms.group(1)))
            sel[m.group(1)][1].append(float(cm.group(1)))
            sel[m.group(1)][2].append(float(rm.group(1)) if rm else None)
for k, (ms, cm, rd) in sel.items():
    print(f"  range {k:5s} ms {med(ms)} | combine {med(cm)} | read {med(rd)}")

print("\nperf gate (blocked [wall], ms)")
ROWS = ["grow +16", "shrink -16", "invert", "magic wand (whole-image band)", "magic wand (an object)", "magic wand, a masked layer"]
vals = {r: ([], []) for r in ROWS}
for p in runs("gates/gates/k5-perf-r*/perf.log"):
    for line in open(p, encoding="utf-8", errors="replace"):
        for r in ROWS:
            m = re.match(re.escape(r) + r"\s+([\d.]+) ms\s+\[([\d.]+)\]", line.strip())
            if m:
                vals[r][0].append(float(m.group(1)))
                vals[r][1].append(float(m.group(2)))
for r, (b, w) in vals.items():
    print(f"  {r:32s} {med(b)} [{med(w)}]")

print("\npx_jobs (tools/ab_median.py over json/pxjobs_r*.jsonl)")
out = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "ab_median.py"), *runs("json/pxjobs_r*.jsonl")],
                     capture_output=True, text=True)
print(out.stdout.rstrip() or out.stderr.rstrip())
