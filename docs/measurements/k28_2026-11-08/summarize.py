"""K28's rows on 15000 x 10000 (grid step 4), before (KERNELS "js": the JS twin liquifyBlock in the window and in the
pool) against after (KERNELS "rust": Rust liquify_block): the median over the rounds of each row's own figure, with
[min-max].

    python docs/measurements/k28_2026-11-08/summarize.py docs/measurements/k28_2026-11-08/ab
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
        for r in j.get("rows", []):
            name = r["row"]
            if "land" in r:
                out.setdefault(f"{name} land (ms)", []).append(r["land"])
            if "ms" in r:
                out.setdefault(f"{name} wall (ms)", []).append(r["ms"])
            if "blockedMax" in r:
                out.setdefault(f"{name} blockedMax (ms)", []).append(r["blockedMax"])
            if "dab" in r and r["dab"]:
                out.setdefault(f"{name} dab p50 (ms)", []).append(r["dab"]["p50"])
            if "preview" in r and r["preview"]:
                out.setdefault(f"{name} preview p50 (ms)", []).append(r["preview"]["p50"])
            if "frame" in r and r["frame"]:
                out.setdefault(f"{name} frame p50 (ms)", []).append(r["frame"]["p50"])
            if "tick" in r and r["tick"]:
                out.setdefault(f"{name} tick p50 (ms)", []).append(r["tick"]["p50"])
            liq_job = (r.get("jobs") or {}).get("liquify")
            if liq_job and "total" in liq_job:
                out.setdefault(f"{name} pool job total sum (ms)", []).append(liq_job["total"])
            w_calls = (r.get("pxCalls") or {}).get("liquify_block", 0)
            p_calls = ((liq_job or {}).get("pxCalls") or {}).get("liquify_block", 0)
            out.setdefault(f"{name} liquify_block calls (win/pool)", []).append(f"{w_calls}/{p_calls}")
    return out


d = sys.argv[1]
b, a = rows(os.path.join(d, "before")), rows(os.path.join(d, "after"))
print(f"{'row':58} {'before (js)':>24} {'after (rust)':>24}")
for k in list(dict.fromkeys(list(b) + list(a))):
    xb, xa = b.get(k, []), a.get(k, [])
    if k.endswith("(win/pool)"):
        print(f"  {k:56} {sorted(set(xb))!s:>24} {sorted(set(xa))!s:>24}")
        continue
    fb = f"{med(xb):.1f} [{min(xb):.1f}-{max(xb):.1f}]" if xb else "-"
    fa = f"{med(xa):.1f} [{min(xa):.1f}-{max(xa):.1f}]" if xa else "-"
    print(f"  {k:56} {fb:>24} {fa:>24}   n={len(xb)}/{len(xa)}")
