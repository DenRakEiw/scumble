"""K19's summary: medians and [min-max] of <dir>/<arm>_<variant>_r<n>.json (k19_bench.py), each arm against native.

    python summarize.py [results_dir ...] > summary_rows.txt

Arms: rust (deflate_part level 2, the app's default), rust6 (deflate_part level 6, the harness route tiffDeflateLevel),
native (CompressionStream("deflate") per strip, the harness route tiffDeflate "js"). Each directory is its own set of
alternated rounds; its arms are compared only with each other.
"""
import glob
import json
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DIRS = sys.argv[1:] or [os.path.join(HERE, "results")]
ARMS = ("rust", "rust6", "native")
LABEL = {"rust": "deflate_part level 2", "rust6": "deflate_part level 6", "native": "CompressionStream"}
COUNTS = ("tiff_part jobs", "tiff_part nativeDeflate", "strips")


def rows_of(r):
    row, fl = r["row"] or {}, r["file"]
    ex = (row.get("exportSteps") or {}).get("export") or {}
    tp = (row.get("exportJobs") or {}).get("tiff_part") or {}
    return {
        "exportMs (whole export, wall)": row.get("exportMs"),
        "exportSteps encoded": ex.get("encoded"),
        "exportSteps saved": ex.get("saved"),
        "tiff_part jobs": tp.get("jobs"),
        "tiff_part nativeDeflate": tp.get("nativeDeflate", 0),
        "tiff_part kernel (sum)": tp.get("kernel"),
        "tiff_part predict (sum)": tp.get("predict"),
        "tiff_part deflate (sum)": tp.get("deflate"),
        "file bytes": fl.get("fileBytes"),
        "file MB": round(fl["fileBytes"] / 1048576, 1) if fl.get("fileBytes") else None,
        "strips": fl.get("strips"),
        "openMs (reopen of that file, wall)": row.get("openMs"),
    }


def fmt(v):
    return "-" if v is None else ("{:,.1f}".format(v) if isinstance(v, float) else "{:,}".format(v))


def stat(vals):
    vals = [v for v in vals if isinstance(v, (int, float))]
    return (statistics.median(vals), min(vals), max(vals)) if vals else (None, None, None)


def cell(s):
    m, lo, hi = s
    return "-" if m is None else "%s [%s-%s]" % (fmt(m), fmt(lo), fmt(hi))


def verdict(key, a, b):
    (ma, la, ha), (mb, lb, hb) = a, b
    if ma is None or mb is None or not mb:
        return ""
    v = "%.2fx" % (ma / mb)
    if key in COUNTS:
        return v
    if not (ha < lb or hb < la):
        return v + " (spreads overlap: tie)"
    return v + (" (lower than native, non-overlapping)" if ma < mb else " (native lower, non-overlapping)")


out, checks = [], []
for d in DIRS:
    runs = {}
    for p in sorted(glob.glob(os.path.join(d, "*_r*.json"))):
        with open(p, encoding="utf-8") as f:
            r = json.load(f)
        runs.setdefault((r["variant"], r["arm"]), []).append((os.path.basename(p), r))
    out.append("#### %s" % os.path.relpath(d, HERE))
    for variant in ("own", "noise"):
        arms = [a for a in ARMS if runs.get((variant, a))]
        if not arms:
            continue
        rows = {a: [rows_of(r) for _, r in runs[(variant, a)]] for a in arms}
        out.append("== %s: %s" % (variant, ", ".join("%s (%s, n=%d)" % (a, LABEL[a], len(rows[a])) for a in arms)))
        others = [a for a in arms if a != "native"]
        head = "%-36s " % "row" + " ".join("%-36s" % ("%s median [min-max]" % a) for a in arms)
        if "native" in arms:
            head += " " + " | ".join("%s / native" % a for a in others)
        out.append(head)
        for key in rows[arms[0]][0]:
            s = {a: stat([x[key] for x in rows[a]]) for a in arms}
            line = "%-36s " % key + " ".join("%-36s" % cell(s[a]) for a in arms)
            if "native" in arms:
                line += " " + " | ".join(verdict(key, s[a], s["native"]) for a in others)
            out.append(line)
        allr = [x for a in arms for x in runs[(variant, a)]]
        out.append("runs: " + "; ".join("%s %s exportMs=%s fileBytes=%s" % (n, r["arm"], (r["row"] or {}).get("exportMs"), r["file"].get("fileBytes"))
                                        for n, r in sorted(allr)))
        hashes = {r["file"].get("decodedSha256") for _, r in allr}
        pics = {(r["row"] or {}).get("picHash") for _, r in allr}
        good = all(r["ok"] and (r["row"] or {}).get("picMatch") is True and (r["row"] or {}).get("rowsOff") == 0 for _, r in allr)
        nat = all(((rows_of(r)["tiff_part nativeDeflate"] or 0) == rows_of(r)["tiff_part jobs"]) == (r["arm"] == "native") for _, r in allr)
        checks.append("%s / %s: every run ok, picMatch true, rowsOff 0: %s; one decoded-strip SHA-256 over all runs and arms: %s (%s); one reopened picture hash: %s; nativeDeflate on every strip of native runs and on none of the others: %s"
                      % (os.path.relpath(d, HERE), variant, good, len(hashes) == 1, ", ".join(sorted(h[:16] for h in hashes if h)), len(pics) == 1, nat))
        out.append("")
out.append("checks:")
out.extend("  " + c for c in checks)
print("\n".join(out))
