"""Medians [min-max] of before.json / after.json per file and route (ctrlo.py's rows)."""
import json
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def table(name):
    rows = json.load(open(os.path.join(HERE, name), encoding="utf-8"))
    out = {}
    for r in rows:
        out.setdefault((os.path.basename(r["file"]), r["route"]), []).append(r)
    lines = []
    for (f, route), rs in out.items():
        errs = [r.get("err") for r in rs if r.get("err")]
        cells = []
        for k in ("transfer", "xblock", "wall", "block"):
            v = [r[k] for r in rs if r.get(k) is not None]
            cells.append("%6d [%d-%d]" % (statistics.median(v), min(v), max(v)) if v else "     -")
        lines.append("  %-7s %-6s %s%s" % (f, route, "  ".join(c.ljust(20) for c in cells), ("  errors: %s" % errs) if errs else ""))
    return lines


for n in sys.argv[1:] or ["before.json", "after.json"]:
    print(n)
    print("  file    route  transfer              xblock                wall                  block")
    print("\n".join(table(n)))
