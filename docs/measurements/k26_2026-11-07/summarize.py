"""K26's rows, before (the twins on the window, a tree at 2c912d8) against after (blur_rgba / sharpen_rgba): the median over
the rounds of each row's own median, with the spread.

    python summarize.py <ab dir>     the dir k26_chain.sh wrote (before/ and after/ inside)
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
    for f in sorted(glob.glob(os.path.join(arm, "brush_*_r*.json"))):
        j = json.load(open(f, encoding="utf-8"))
        if not (j.get("visible") == "visible" and j.get("focused")):
            print(f"  {f}: the window was not in front: left out")
            continue
        for r in j.get("rows", []):
            if r.get("cold"):
                continue
            key = f"{r['tool']} {r['size']} px {r['view']}"
            out.setdefault(key + " move", []).append(r["move"]["med"])
            out.setdefault(key + " dab", []).append(r["dab"]["med"])
            out.setdefault(key + " blocked max", []).append(r["blocked"]["max"])
            calls = r.get("pxCalls") or {}
            out.setdefault(key + " px calls", []).append(", ".join(f"{k} {v}" for k, v in sorted(calls.items()) if k in ("blur_rgba", "sharpen_rgba", "smudge_dab")))
    for f in sorted(glob.glob(os.path.join(arm, "freqsep_r*.json"))):
        j = json.load(open(f, encoding="utf-8")).get("freqsep_4000", {})
        if not (j.get("visibility") == "visible" and j.get("focus")):
            print(f"  {f}: the window was not in front: left out")
            continue
        out.setdefault("freqsep 4000^2 r 40 wall", []).append(j["wall"])
        out.setdefault("freqsep 4000^2 r 40 blocked", []).append(j["blocked"])
        steps = {s["step"]: s["ms"] for m in j.get("marks", []) for s in m.get("steps", [])}
        for k in ("blur", "split", "read", "written"):
            if k in steps:
                out.setdefault(f"freqsep  its {k}", []).append(steps[k])
    return out


d = sys.argv[1]
b, a = rows(os.path.join(d, "before")), rows(os.path.join(d, "after"))
print(f"{'row':44} {'before':>22} {'after':>22}")
for k in list(dict.fromkeys(list(b) + list(a))):
    xb, xa = b.get(k, []), a.get(k, [])
    if k.endswith("px calls"):
        print(f"  {k:42} {sorted(set(xb))!s:>22} {sorted(set(xa))!s:>22}")
        continue
    fb = f"{med(xb):.1f} [{min(xb):.1f}-{max(xb):.1f}]" if xb else "-"
    fa = f"{med(xa):.1f} [{min(xa):.1f}-{max(xa):.1f}]" if xa else "-"
    print(f"  {k:42} {fb:>22} {fa:>22}   n={len(xb)}/{len(xa)}")
