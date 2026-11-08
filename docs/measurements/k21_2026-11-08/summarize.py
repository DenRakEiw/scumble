"""K21's rows, before (a tree at 29f6749, wasm-kernels) against after (map_tile_stats, rangeTileClass,
rangeRowBookkeeping, cut picture span): the median over the 3 alternating rounds with [min-max] spread.

    python summarize.py <dir>
"""
import glob
import json
import os
import re
import statistics
import sys


def med(xs):
    return statistics.median(xs) if xs else None


def fmt(xs):
    if not xs:
        return "-"
    return f"{med(xs):.1f} [{min(xs):.1f}-{max(xs):.1f}]"


def load_arm(arm):
    out = {}
    for f in sorted(glob.glob(os.path.join(arm, "pxjobs_r*.jsonl"))):
        for line in open(f, encoding="utf-8"):
            j = json.loads(line)
            if not (j.get("visibility") == "visible" and j.get("focused")):
                continue
            for r in j.get("rows", []):
                job = r["job"]
                k = r["kernels"]
                out.setdefault(f"{job} ({k}) wall", []).append(r["wall"])
                if "ms" in r:
                    out.setdefault(f"{job} ({k}) worker job", []).append(r["ms"])
                elif "total" in r:
                    out.setdefault(f"{job} ({k}) worker job", []).append(r["total"])
                if job == "range_depth_snap":
                    out.setdefault(f"{job} ({k}) rmax", []).append(r["rmax"])
                    out.setdefault(f"{job} ({k}) edges", []).append(r["edges"])
                marks = (r.get("marks") or [{}])[0]
                steps = marks.get("steps") or {}
                extra = marks.get("extra") or {}
                if job in ("range_depth", "range_depth_snap"):
                    if "edges" in steps:
                        out.setdefault(f"{job} ({k}) mark.edges", []).append(steps["edges"])
                    if "combined" in steps:
                        out.setdefault(f"{job} ({k}) mark.combined", []).append(steps["combined"])
                    if "readMs" in extra:
                        out.setdefault(f"{job} ({k}) readMs", []).append(extra["readMs"])
                    if "pictureTiles" in extra:
                        out.setdefault(f"{job} ({k}) pictureTiles", []).append(extra["pictureTiles"])
                calls = (r.get("px") or {}).get("window") or {}
                out.setdefault(f"{job} ({k}) window px calls", []).append(
                    ", ".join(f"{ck} {cv}" for ck, cv in sorted(calls.items())) or "none"
                )
    for f in sorted(glob.glob(os.path.join(arm, "selection_r*.log"))):
        txt = open(f, encoding="utf-8", errors="replace").read()
        m = re.search(r"range depth 15000x10000: selectRange ([\d.]+) ms \(wall ([\d.]+) ms\)", txt)
        if m:
            out.setdefault("selection_test 15k depth ramp wall", []).append(float(m.group(2)))
        m2 = re.search(r"range luma 15000x10000: selectRange ([\d.]+) ms \(wall ([\d.]+) ms\)", txt)
        if m2:
            out.setdefault("selection_test 15k luma wall", []).append(float(m2.group(2)))
    for f in sorted(glob.glob(os.path.join(arm, "app_r*.log"))):
        txt = open(f, encoding="utf-8", errors="replace").read()
        m = re.search(r"15k select_range: ([\d.]+) ms", txt)
        if m:
            out.setdefault("edges_test 15k select_range wall", []).append(float(m.group(1)))
    return out


if __name__ == "__main__":
    d = sys.argv[1]
    b = load_arm(os.path.join(d, "before"))
    a = load_arm(os.path.join(d, "after"))
    print(f"{'row':48} {'before (29f6749)':>24} {'after (K21)':>24}")
    for k in list(dict.fromkeys(list(b) + list(a))):
        xb, xa = b.get(k, []), a.get(k, [])
        if k.endswith("px calls"):
            print(f"  {k:46} {sorted(set(xb))!s:>24} {sorted(set(xa))!s:>24}")
            continue
        print(f"  {k:46} {fmt(xb):>24} {fmt(xa):>24}   n={len(xb)}/{len(xa)}")
