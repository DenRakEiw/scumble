"""Summarize K3's 3-round alternating before/after native_test.py runs at 15000 x 10000 and w0_bench crc32_64mb runs."""
import glob
import json
import os
import statistics

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
    return f"{v:,.1f} [{lo:,.1f}-{hi:,.1f}]" + ("" if n == 3 else f" (n={n})")


def gather_native(arm):
    out = {}
    put = lambda k, v: out.setdefault(k, []).append(v)
    for f in sorted(glob.glob(os.path.join(HERE, arm, "native", "r*.json"))):
        j = json.load(open(f, encoding="utf-8"))
        rows = j.get("rows") or {}
        b = (rows.get("build_the_file") or {}).get("row") or {}
        put("build_the_file encodeMs", b.get("encodeMs"))
        for name in ("open_the_file", "add_the_paint_layer", "export_png", "export_ora"):
            r = (rows.get(name) or {}).get("row") or {}
            if not r:
                continue
            put(f"{name} wall", r.get("wall"))
            put(f"{name} longest block", r.get("blocked"))
            jobs = r.get("jobs") or {}
            pp = jobs.get("png_part") or {}
            for k in ("jobs", "kernel", "filter", "deflate", "adler", "chunk", "compose", "wait", "copy"):
                if k in pp:
                    put(f"{name} png_part {k}", pp.get(k))
            cj = jobs.get("crc") or {}
            for k in ("jobs", "kernel", "wait", "copy"):
                if k in cj:
                    put(f"{name} crc {k}", cj.get(k))
            wpx = (r.get("pxCalls") or {}).get("workers") or {}
            for k in ("png_filter_rows", "deflate_zlib", "adler32", "png_chunk_frame", "crc32"):
                if k in wpx:
                    put(f"{name} worker {k} calls", wpx.get(k))
            winpx = (r.get("pxCalls") or {}).get("window") or {}
            if "crc32" in winpx:
                put(f"{name} window crc32 calls", winpx.get("crc32"))
    return out


def gather_crc_bench():
    out = {}
    put = lambda k, v: out.setdefault(k, []).append(v)
    for f in sorted(glob.glob(os.path.join(HERE, "after", "bench", "crc32_r*.json"))):
        j = json.load(open(f, encoding="utf-8"))
        c = j.get("crc32_64mb") or ((j.get("rows") or {}).get("crc32_64mb")) or {}
        if "crc" in c and isinstance(c["crc"], dict):
            put("crc32_64mb rust median (ms)", c["crc"].get("median"))
        if "msPerMB" in c:
            put("crc32_64mb rust (ms/MB)", c.get("msPerMB"))
        if "js" in c and isinstance(c["js"], dict):
            put("crc32_64mb js median (ms)", c["js"].get("median"))
        if "jsMsPerMB" in c:
            put("crc32_64mb js (ms/MB)", c.get("jsMsPerMB"))
        if "speedup" in c:
            put("crc32_64mb speedup (js/rust)", c.get("speedup"))
    return out


def main():
    b = gather_native("before")
    a = gather_native("after")
    keys = list(dict.fromkeys(list(b) + list(a)))
    w = max(len(k) for k in keys) + 2
    print("=== 15000 x 10000 native_test.py (3 alternating rounds, median [min-max] ms) ===")
    print("row".ljust(w) + "before (ad148e2e)".ljust(28) + "after (K3)".ljust(28) + "before / after (medians)")
    for k in keys:
        mb = med(b.get(k, []))
        ma = med(a.get(k, []))
        ratio = ""
        if mb and ma and ma[0]:
            ratio = f"{mb[0] / ma[0]:.2f}x"
        print(k.ljust(w) + fmt(mb).ljust(28) + fmt(ma).ljust(28) + ratio)

    print("\n=== w0_bench.py --rows=crc32_64mb (3 rounds in live Electron renderer) ===")
    cb = gather_crc_bench()
    for k, vals in cb.items():
        m = med(vals)
        if m:
            v, lo, hi, n = m
            print(f"{k.ljust(24)} {v:,.3f} [{lo:,.3f}-{hi:,.3f}] (n={n})")


if __name__ == "__main__":
    main()
