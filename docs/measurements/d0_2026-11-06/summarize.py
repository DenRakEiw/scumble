"""Medians of d0_chain.py's counted runs: open_psd's wall, longest block, marks, the window's top functions, the jobs.

    python summarize.py DIR [DIR ...]

A run counts when its open_psd row ran with the window in front (`focused`); the others are listed as NOT COUNTED.
"""
import glob
import json
import os
import statistics
import sys

FNS = ("unpackRows", "interleave", "readChannel", "readPsd", "canvasRoundTrip", "_putBlock", "readPsdOnPool", "writeRect")


def med(xs):
    xs = [x for x in xs if x is not None]
    return (statistics.median(xs), min(xs), max(xs)) if xs else (None, None, None)


def fmt(t):
    m, lo, hi = t
    return "-" if m is None else f"{m:,.0f}  [{lo:,.0f}-{hi:,.0f}]"


for d in sys.argv[1:]:
    runs, skipped = [], []
    for js in sorted(glob.glob(os.path.join(d, "*.json"))):
        try:
            data = json.load(open(js, encoding="utf-8"))
        except Exception:
            continue
        r = data.get("rows", {}).get("open_psd")
        if not r or not r.get("row"):
            continue
        (runs if r["row"].get("focused") else skipped).append((os.path.basename(js), r, data))
    print(f"== {d}: {len(runs)} counted runs ({', '.join(n for n, _, _ in runs)}); NOT COUNTED: {', '.join(n for n, _, _ in skipped) or 'none'}")
    if not runs:
        continue
    print(f"   open_psd wall           {fmt(med([r['row']['wall'] for _, r, _ in runs]))}")
    print(f"   open_psd longest block  {fmt(med([r['row']['blocked'] for _, r, _ in runs]))}")
    print(f"   loadImageMs             {fmt(med([(r['row'].get('extra') or {}).get('loadImageMs') for _, r, _ in runs]))}")
    steps = []
    for _, r, _ in runs:
        for m in (r["row"].get("marks") or {}).get("layered_open", []):
            for k in m:
                if k not in ("extra",) and k not in steps:
                    steps.append(k)
    for k in steps:
        print(f"   mark {k:<18} {fmt(med([((r['row'].get('marks') or {}).get('layered_open') or [{}])[0].get(k) for _, r, _ in runs]))}")
    for k in ("rgbaMs", "maskMs", "inflateMs", "route"):
        vals = [(((r['row'].get('marks') or {}).get('layered_open') or [{}])[0].get('extra') or {}).get(k) for _, r, _ in runs]
        if any(isinstance(v, (int, float)) for v in vals):
            print(f"   mark extra {k:<12} {fmt(med([v for v in vals if isinstance(v, (int, float))]))}")
        elif any(vals):
            print(f"   mark extra {k:<12} {sorted(set(map(str, vals)))}")
    if all(r.get("profile") for _, r, _ in runs):
        for k in ("idle", "gc", "program"):
            print(f"   main thread {k:<11} {fmt(med([r['profile'].get(k) for _, r, _ in runs]))}")
        for fn in FNS:
            vals = []
            for _, r, _ in runs:
                vals.append(sum(v for name, v in r["profile"].get("fn", {}).items() if name.startswith(fn + " [")))
            if any(vals):
                print(f"   window fn {fn:<14} {fmt(med(vals))}")
    ops = []
    for _, r, _ in runs:
        for op in (r["row"].get("jobs") or {}):
            if op not in ops:
                ops.append(op)
    for op in ops:
        keys = []
        for _, r, _ in runs:
            for k, v in (r["row"]["jobs"].get(op) or {}).items():
                if isinstance(v, (int, float)) and k not in keys and k not in ("gen", "pixels"):
                    keys.append(k)
        parts = ", ".join(f"{k} {med([(r['row']['jobs'].get(op) or {}).get(k) for _, r, _ in runs])[0]:,.0f}" for k in keys)
        print(f"   worker {op}: {parts}")
    print()
