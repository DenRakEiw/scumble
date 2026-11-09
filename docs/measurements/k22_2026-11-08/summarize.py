"""K22's rows, before (a tree at 548c7f4, wasm-kernels before K22) against after (range_tiles_depth):
the median over the 3 alternating rounds with [min-max] spread.

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
                sp = (r.get("split") or {}).get("ms") or {}
                if "range_tiles_depth" in sp:
                    out.setdefault(f"{job} ({k}) split.range_tiles_depth", []).append(sp["range_tiles_depth"])
                if job == "range_depth_snap":
                    out.setdefault(f"{job} ({k}) rmax", []).append(r["rmax"])
                    out.setdefault(f"{job} ({k}) edges", []).append(r["edges"])
                calls_w = (r.get("px") or {}).get("window") or {}
                calls_j = (r.get("px") or {}).get("workers") or {}
                out.setdefault(f"{job} ({k}) window px calls", []).append(
                    ", ".join(f"{ck} {cv}" for ck, cv in sorted(calls_w.items())) or "none"
                )
                out.setdefault(f"{job} ({k}) worker px calls", []).append(
                    ", ".join(f"{ck} {cv}" for ck, cv in sorted(calls_j.items())) or "none"
                )
    for f in sorted(glob.glob(os.path.join(arm, "selection_r*.log"))):
        txt = open(f, encoding="utf-8", errors="replace").read()
        m = re.search(r"range depth 15000x10000: selectRange ([\d.]+) ms \(wall ([\d.]+) ms\)", txt)
        if m:
            out.setdefault("selection_test 15k depth ramp wall", []).append(float(m.group(2)))
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
    print(f"{'row':52} {'before (548c7f4)':>24} {'after (K22)':>24}")
    for k in list(dict.fromkeys(list(b) + list(a))):
        xb, xa = b.get(k, []), a.get(k, [])
        if k.endswith("px calls"):
            print(f"  {k:50} {sorted(set(xb))!s:>24} {sorted(set(xa))!s:>24}")
            continue
        print(f"  {k:50} {fmt(xb):>24} {fmt(xa):>24}   n={len(xb)}/{len(xa)}")
