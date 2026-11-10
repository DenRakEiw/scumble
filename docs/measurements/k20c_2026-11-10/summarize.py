"""K20c: medians and spreads of every native_test row (wall, blocked) and of open_ora's marks, before (8fde9fb0) and
after (K20c), from pass1/ and pass2/ (three alternating rounds each, k20c_chain.sh) <arm>/native/r*.json. python summarize.py > summary.txt"""
import glob
import json
import os
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))


def runs(arm):
    out = []
    for f in sorted(glob.glob(os.path.join(HERE, "pass*", arm, "native", "r*.json"))):
        with open(f, encoding="utf-8") as fh:
            out.append(json.load(fh)["rows"])
    return out


def stat(vals):
    vals = [v for v in vals if v is not None]
    if not vals:
        return "n/a"
    return "%8.1f [%.1f..%.1f]" % (statistics.median(vals), min(vals), max(vals))


before, after = runs("before"), runs("after")
print("K20c 15000x10000, %d before runs (8fde9fb0), %d after runs (K20c), tiles on, offline, port 9621" % (len(before), len(after)))
print("row / field: median [min..max] ms, before | after")
for name in before[0]:
    for field in ("wall", "blocked"):
        b = [r[name]["row"].get(field) for r in before]
        a = [r[name]["row"].get(field) for r in after]
        print("%-22s %-8s %s | %s" % (name, field, stat(b), stat(a)))


def mark(rows, key):
    m = rows["open_ora"]["row"].get("marks", {}).get("layered_open") or [{}]
    v = m[-1].get(key)
    if v is None:
        v = (m[-1].get("extra") or {}).get(key)
    return v


print("open_ora marks (layered_open)")
for key in ("read", "parsed", "layers", "stored", "base", "added", "total", "streamMs", "bitmapMs", "fromImageMs"):
    print("%-22s %s | %s" % (key, stat([mark(r, key) for r in before]), stat([mark(r, key) for r in after])))


def calls(rows, key, what):
    c = rows["open_ora"]["row"].get("calls", {}).get(key)
    return c.get(what) if c else 0


print("open_ora window calls")
for key in ("2d getImageData", "createImageBitmap", "blob arrayBuffer"):
    for what in ("n", "ms", "MB"):
        print("%-30s %-3s %s | %s" % (key, what, stat([calls(r, key, what) for r in before]), stat([calls(r, key, what) for r in after])))
