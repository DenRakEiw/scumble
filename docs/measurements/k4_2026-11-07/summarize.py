"""K4's before / after rows: the median over the rounds of each row's own median (w0_bench `time`), with the spread.

    python summarize.py <dir> [<dir> ...]   each dir holds bench_r<N>.json from k4_chain.sh; prints one block per dir
"""
import glob
import json
import os
import statistics
import sys


def rows(d):
    out = {}
    for f in sorted(glob.glob(os.path.join(d, "bench_r*.json"))):
        j = json.load(open(f, encoding="utf-8"))
        s = j.get("stitch_masks_2048", {})
        b = j.get("box_blurs_k4", {})
        if not (b.get("visibility") == "visible" and b.get("focus")):
            print(f"  {os.path.basename(f)}: the window was not in front ({b.get('visibility')}, focus {b.get('focus')}): left out")
            continue
        out.setdefault("stitch gaussBlur 2048^2 sigma 8 (whole function)", []).append(s["gauss"]["median"])
        out.setdefault("  its mask build mk (not K4's)", []).append(s["mk"]["median"])
        for k, v in (b.get("rows") or {}).items():
            out.setdefault(f"{k} rust", []).append(v["rust"]["median"])
            if v.get("twin"):
                out.setdefault(f"{k} twin", []).append(v["twin"]["median"])
            out.setdefault(f"{k} sum", []).append(v.get("sum"))
            if "same" in v and v["same"] is not None:
                out.setdefault(f"{k} same as twin", []).append(v["same"])
    return out


for d in sys.argv[1:]:
    print(f"== {d}")
    for k, xs in rows(d).items():
        if k.endswith(" sum") or k.endswith("same as twin"):
            print(f"  {k:52} {sorted(set(map(str, xs)))}")
        else:
            print(f"  {k:52} median {statistics.median(xs):8.2f} ms  [{min(xs):.2f} - {max(xs):.2f}]  n={len(xs)}")
