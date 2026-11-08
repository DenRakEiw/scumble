"""K27's rows, before (the twins of tone, sponge and the split on the window, a tree at 8729426) against after
(tone_rgba, sponge_rgba, freq_split): the median over the rounds of each row's own median, with the spread.

    python summarize.py <ab dir>     the dir k27_chain.sh wrote (before/ and after/ inside)

Frequency separation's marks: before, "blur" (K26's blur_rgba) and "split" (the JS loop); after, "split" is the one call
of px/kernels.js freqSeparate (the blur and the split): the row "blur + split" sets the two side by side. The kernel rows
of dabs_k27 (after only) give Rust and the twin in one instance.
"""
import glob
import json
import os
import statistics
import sys


def med(xs):
    return statistics.median(xs) if xs else None


def front(j, f):
    if (j.get("visible") == "visible" and j.get("focused")) or (j.get("visibility") == "visible" and j.get("focus")):
        return True
    print(f"  {f}: the window was not in front: left out")
    return False


def rows(arm):
    out = {}
    for f in sorted(glob.glob(os.path.join(arm, "brush_*_r*.json"))):
        j = json.load(open(f, encoding="utf-8"))
        if not front(j, f):
            continue
        for r in j.get("rows", []):
            if r.get("cold"):
                continue
            key = f"{r['tool']} {r['size']} px {r['view']}"
            out.setdefault(key + " move", []).append(r["move"]["med"])
            out.setdefault(key + " dab", []).append(r["dab"]["med"])
            out.setdefault(key + " blocked max", []).append(r["blocked"]["max"])
            calls = r.get("pxCalls") or {}
            out.setdefault(key + " px calls", []).append(", ".join(f"{k} {v}" for k, v in sorted(calls.items()) if k in ("tone_rgba", "sponge_rgba", "smudge_dab")))
    for f in sorted(glob.glob(os.path.join(arm, "freqsep_r*.json"))):
        j = json.load(open(f, encoding="utf-8")).get("freqsep_4000", {})
        if not front(j, f):
            continue
        out.setdefault("freqsep 4000^2 r 40 wall", []).append(j["wall"])
        out.setdefault("freqsep 4000^2 r 40 blocked", []).append(j["blocked"])
        steps = {s["step"]: s["ms"] for m in j.get("marks", []) for s in m.get("steps", [])}
        for k in ("read", "blur", "split", "written"):
            if k in steps:
                out.setdefault(f"freqsep  its {k}", []).append(steps[k])
        out.setdefault("freqsep  its blur + split", []).append(steps.get("blur", 0) + steps.get("split", 0))
        for k, v in (j.get("pxMs") or {}).items():
            if k in ("blur_rgba", "freq_split"):
                out.setdefault(f"freqsep  {k} (kernel)", []).append(v)
        ib, ia = j.get("instBefore") or {}, j.get("instAfter") or {}
        if ia:
            out.setdefault("freqsep  window instance MB after", []).append(round(ia.get("bytes", 0) / 1048576, 1))
            out.setdefault("freqsep  window releases during it", []).append(ia.get("release", 0) - ib.get("release", 0))
    for f in sorted(glob.glob(os.path.join(arm, "dabs_r*.json"))):
        j = json.load(open(f, encoding="utf-8")).get("dabs_k27", {})
        if not front(j, f):
            continue
        for name, v in (j.get("rows") or {}).items():
            out.setdefault(f"kernel {name} rust", []).append(v["rust"])
            out.setdefault(f"kernel {name} twin", []).append(v["twin"])
    return out


d = sys.argv[1]
b, a = rows(os.path.join(d, "before")), rows(os.path.join(d, "after"))
print(f"{'row':52} {'before':>24} {'after':>24}")
for k in list(dict.fromkeys(list(b) + list(a))):
    xb, xa = b.get(k, []), a.get(k, [])
    if k.endswith("px calls"):
        print(f"  {k:50} {sorted(set(xb))!s:>24} {sorted(set(xa))!s:>24}")
        continue
    fb = f"{med(xb):.1f} [{min(xb):.1f}-{max(xb):.1f}]" if xb else "-"
    fa = f"{med(xa):.1f} [{min(xa):.1f}-{max(xa):.1f}]" if xa else "-"
    print(f"  {k:50} {fb:>24} {fa:>24}   n={len(xb)}/{len(xa)}")
