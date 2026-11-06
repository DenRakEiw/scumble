"""W1's rows from w1_chain.sh's folders: medians [min-max] of the counted runs, and before -> after when two are given.

    python summarize.py before            one folder
    python summarize.py before after      both, side by side

Rows (every one at 15000 x 10000): native_test's build_the_file encode, export_png, export_ora, save_png (wall, longest
block, the export marks, the png_part jobs' laps summed over the workers: filter, deflate, adler, compose, kernel),
tiffperf own (the open, its store's png_part laps, the TIFF export), w0_bench files_15k (the photo's PNG export: wall,
encoded, the png_part laps; the TIFF export beside it), and the Node kernel row of px_bench.js (explains only).
"""
import glob
import json
import os
import re
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def med(vals):
    vals = [v for v in vals if v is not None]
    if not vals:
        return None
    return (statistics.median(vals), min(vals), max(vals), len(vals))


def fmt(m):
    if m is None:
        return "-"
    v, lo, hi, n = m
    return f"{v:,.0f} [{lo:,.0f}-{hi:,.0f}]" + ("" if n == 3 else f" (n={n})")


def native_rows(d):
    out = {}
    for f in sorted(glob.glob(os.path.join(d, "native", "r*.json"))):
        j = json.load(open(f, encoding="utf-8"))
        rows = j["rows"]
        put = lambda k, v: out.setdefault(k, []).append(v)
        b = rows.get("build_the_file", {}).get("row", {})
        put("build_the_file encodeMs", b.get("encodeMs"))
        for name in ("export_png", "export_ora", "save_png"):
            r = rows.get(name, {}).get("row")
            if not r:
                continue
            put(f"{name} wall", r.get("wall"))
            put(f"{name} longest block", r.get("blocked"))
            ex = (r.get("marks") or {}).get("export") or [{}]
            put(f"{name} encoded", ex[0].get("encoded"))
            if name == "save_png":
                put(f"{name} saved", ex[0].get("saved"))
            pp = (r.get("jobs") or {}).get("png_part")
            if pp:
                for k in ("filter", "deflate", "adler", "compose", "kernel"):
                    put(f"{name} png_part {k} (summed)", pp.get(k))
    return out


def tiff_rows(d):
    out = {}
    for f in sorted(glob.glob(os.path.join(d, "gates", "gates", "w1-tiff-own-r*", "tiffperf.log"))):
        txt = open(f, encoding="utf-8").read()
        m = re.search(r"\[ok\] variant own: (\{.*\})", txt)
        if not m:
            continue
        j = json.loads(m.group(1))
        put = lambda k, v: out.setdefault(k, []).append(v)
        put("tiff own open", j.get("openMs"))
        put("tiff own open: stored", (j.get("openSteps") or {}).get("stored"))
        pp = (j.get("openJobs") or {}).get("png_part") or {}
        put("tiff own store png_part filter (summed)", pp.get("filter"))
        put("tiff own store png_part deflate (summed)", pp.get("deflate"))
        put("tiff own export", j.get("exportMs"))
    return out


def files_rows(d):
    out = {}
    for f in sorted(glob.glob(os.path.join(d, "bench", "files_r*.json"))):
        j = json.load(open(f, encoding="utf-8")).get("files_15k") or {}
        put = lambda k, v: out.setdefault(k, []).append(v)
        p = j.get("png") or {}
        put("photo png export wall", p.get("wall"))
        enc = next((s.get("ms") for m in p.get("marks") or [] if m.get("op") == "export" for s in m.get("steps") or [] if s.get("step") == "encoded"), None)
        put("photo png export encoded", enc)
        pp = (p.get("ops") or {}).get("png_part") or {}
        for k in ("filter", "deflate", "adler", "kernel"):
            put(f"photo png png_part {k} (summed)", pp.get(k))
        t = j.get("tiff") or {}
        put("photo tiff export wall", t.get("wall"))
    return out


def node_rows(d):
    out = {}
    for tag in ("node", "electron"):
        f = os.path.join(d, "node", f"px_bench_{tag}.log")
        if not os.path.exists(f):
            continue
        for line in open(f, encoding="utf-8"):
            if line.startswith("PNG rows (filter)"):
                m = re.search(r"JS ([\d.]+) \| scalar ([\d.]+) \| SIMD ([\d.]+)", line)
                if m:
                    out[f"px_bench {tag}: JS / scalar / SIMD ms (4,096 x 256 band)"] = [f"{m.group(1)} / {m.group(2)} / {m.group(3)}"]
    return out


def gather(d):
    rows = {}
    for f in (native_rows, tiff_rows, files_rows, node_rows):
        rows.update(f(d))
    return rows


def main():
    dirs = [os.path.join(HERE, a) if not os.path.isabs(a) else a for a in sys.argv[1:]] or [os.path.join(HERE, "before")]
    sets = [gather(d) for d in dirs]
    keys = list(dict.fromkeys(k for s in sets for k in s))
    width = max(len(k) for k in keys) + 2
    print("row".ljust(width) + "  ".join(os.path.basename(d).ljust(26) for d in dirs) + ("  after / before (medians)" if len(dirs) == 2 else ""))
    for k in keys:
        cells, ms = [], []
        for s in sets:
            v = s.get(k)
            if v and isinstance(v[0], str):
                cells.append(v[0].ljust(26)); ms.append(None)
            else:
                m = med(v or [])
                cells.append(fmt(m).ljust(26)); ms.append(m)
        ratio = ""
        if len(ms) == 2 and ms[0] and ms[1] and ms[0][0]:
            ratio = f"{ms[1][0] / ms[0][0]:.2f}x"
        print(k.ljust(width) + "  ".join(cells) + ("  " + ratio if ratio else ""))


if __name__ == "__main__":
    main()
