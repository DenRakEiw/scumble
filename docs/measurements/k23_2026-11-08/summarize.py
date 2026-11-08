"""K23's rows, before (a tree at 13d32fa8, ag-chain-m-3 before K23) against after (range_tiles_rgba):
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
                if "stackMs" in r:
                    out.setdefault(f"{job} ({k}) stack_into", []).append(r["stackMs"])
                sp = (r.get("split") or {}).get("ms") or {}
                if "range_tiles_rgba" in sp:
                    out.setdefault(f"{job} ({k}) split.range_tiles_rgba", []).append(sp["range_tiles_rgba"])
                copy_in = (r.get("split") or {}).get("copyIn")
                if isinstance(copy_in, (int, float)):
                    out.setdefault(f"{job} ({k}) split.copyIn", []).append(copy_in)
                elif isinstance(copy_in, dict) and "ms" in copy_in:
                    out.setdefault(f"{job} ({k}) split.copyIn", []).append(copy_in["ms"])
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
        m = re.search(r"range luma 15000x10000: selectRange ([\d.]+) ms \(wall ([\d.]+) ms\)", txt)
        if m:
            out.setdefault("selection_test 15k luma wall (unmatched)", []).append(float(m.group(2)))
    return out


if __name__ == "__main__":
    d = sys.argv[1]
    b = load_arm(os.path.join(d, "before"))
    a = load_arm(os.path.join(d, "after"))
    print(f"{'row':52} {'before (13d32fa8)':>24} {'after (K23)':>24}")
    for k in list(dict.fromkeys(list(b) + list(a))):
        xb, xa = b.get(k, []), a.get(k, [])
        if k.endswith("px calls"):
            print(f"  {k:50} {sorted(set(xb))!s:>24} {sorted(set(xa))!s:>24}")
            continue
        print(f"  {k:50} {fmt(xb):>24} {fmt(xa):>24}   n={len(xb)}/{len(xa)}")
