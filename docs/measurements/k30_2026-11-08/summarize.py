"""K30's rows on 15000 x 10000 (grid step 4), before (DAB "map": the Map-based LiquifyField.dab) against after
(DAB "dense": the dense twin liquifyDabNodes via dab(..., kernel) and thawPlane), with IE.kernels on "rust" in both
arms: the median over the rounds of each row's own figure, with [min-max].

    python docs/measurements/k30_2026-11-08/summarize.py docs/measurements/k30_2026-11-08/ab
"""
import glob
import json
import os
import statistics
import sys


def med(xs):
    return statistics.median(xs) if xs else None


def rows(arm):
    out = {}
    for f in sorted(glob.glob(os.path.join(arm, "liquify_r*.json"))):
        j = json.load(open(f, encoding="utf-8"))
        dk = j.get("dabKernel", "?")
        out.setdefault("dabKernel", []).append(dk)
        for r in j.get("rows", []):
            name = r["row"]
            if isinstance(r.get("dab"), dict):
                out.setdefault(f"{name} dab p50 (ms)", []).append(r["dab"]["p50"])
                out.setdefault(f"{name} dab p95 (ms)", []).append(r["dab"]["p95"])
                out.setdefault(f"{name} dab worst (ms)", []).append(r["dab"]["worst"])
            elif isinstance(r.get("dab"), (int, float)):
                out.setdefault(f"{name} dab (ms)", []).append(r["dab"])
                if "midDab" in r:
                    out.setdefault(f"{name} midDab (ms)", []).append(r["midDab"])
            if isinstance(r.get("preview"), dict):
                out.setdefault(f"{name} preview p50 (ms)", []).append(r["preview"]["p50"])
            if isinstance(r.get("frame"), dict):
                out.setdefault(f"{name} frame p50 (ms)", []).append(r["frame"]["p50"])
                out.setdefault(f"{name} frame p95 (ms)", []).append(r["frame"]["p95"])
            if isinstance(r.get("tick"), dict):
                out.setdefault(f"{name} tick p50 (ms)", []).append(r["tick"]["p50"])
                out.setdefault(f"{name} tick p95 (ms)", []).append(r["tick"]["p95"])
                out.setdefault(f"{name} tick worst (ms)", []).append(r["tick"]["worst"])
            if "land" in r:
                out.setdefault(f"{name} land (ms)", []).append(r["land"])
            if "ms" in r:
                out.setdefault(f"{name} wall (ms)", []).append(r["ms"])
            if "blockedMax" in r:
                out.setdefault(f"{name} blockedMax (ms)", []).append(r["blockedMax"])
    return out


d = sys.argv[1]
b, a = rows(os.path.join(d, "before")), rows(os.path.join(d, "after"))
print(f"{'row':58} {'before (map)':>24} {'after (dense)':>24}")
for k in list(dict.fromkeys(list(b) + list(a))):
    xb, xa = b.get(k, []), a.get(k, [])
    if k == "dabKernel":
        print(f"  {k:56} {sorted(set(xb))!s:>24} {sorted(set(xa))!s:>24}")
        continue
    fb = f"{med(xb):.1f} [{min(xb):.1f}-{max(xb):.1f}]" if xb else "-"
    fa = f"{med(xa):.1f} [{min(xa):.1f}-{max(xa):.1f}]" if xa else "-"
    print(f"  {k:56} {fb:>24} {fa:>24}   n={len(xb)}/{len(xa)}")
