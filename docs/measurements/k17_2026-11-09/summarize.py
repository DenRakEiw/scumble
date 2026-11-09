"""Summarize K17's 3-round alternating 15000 x 10000 runs (tiffperf 6 variants, tiffUnpack route A/B, w0_bench tiff_rows_256)."""
import glob
import json
import os
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
ALL_VARIANTS = ("own", "lzw", "packbits", "zlib1", "raw", "noise")


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


def gather_tiffperf(arm, variants=ALL_VARIANTS):
    out = {}
    put = lambda k, v: out.setdefault(k, []).append(v)
    for vname in variants:
        for f in sorted(glob.glob(os.path.join(HERE, arm, "tiffperf", f"{vname}_r*.log"))):
            with open(f, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    prefix = f"[ok] variant {vname}: "
                    if line.startswith(prefix):
                        j = json.loads(line[len(prefix):])
                        if "exportMs" in j:
                            put(f"{vname} exportMs", j.get("exportMs"))
                            put(f"{vname} fileMB", j.get("fileMB"))
                            es = (j.get("exportSteps") or {}).get("export") or {}
                            for mk in ("encoded", "saved", "total"):
                                if mk in es:
                                    put(f"{vname} exportSteps {mk}", es.get(mk))
                            tp = (j.get("exportJobs") or {}).get("tiff_part") or {}
                            for k in ("jobs", "composeWasm", "kernel", "rows", "predict", "adler", "deflate", "copyIn", "copyOut"):
                                if k in tp:
                                    put(f"{vname} export tiff_part {k}", tp.get(k))
                        put(f"{vname} openMs", j.get("openMs"))
                        os_steps = j.get("openSteps") or {}
                        for mk in ("info", "pixels", "stored", "base", "settled", "total"):
                            if mk in os_steps:
                                put(f"{vname} openSteps {mk}", os_steps.get(mk))
                        tr = j.get("tiff_read") or {}
                        for k in ("parse", "wait", "decode", "copy", "unpredict", "convert", "deliver", "kernel", "bands", "pieces"):
                            if k in tr:
                                put(f"{vname} tiff_read {k}", tr.get(k))
                        oj = ((j.get("openJobs") or {}).get("png_part")) or {}
                        for k in ("jobs", "composeWasm", "kernel", "rows", "filter", "adler", "deflate"):
                            if k in oj:
                                put(f"{vname} open png_part {k}", oj.get(k))
    return out


def gather_w0bench(arm):
    out = {}
    put = lambda k, v: out.setdefault(k, []).append(v)
    for f in sorted(glob.glob(os.path.join(HERE, arm, "w0bench", "r*.json"))):
        j = json.load(open(f, encoding="utf-8"))
        tr = j.get("tiff_rows_256") or {}
        if not tr or "error" in tr:
            continue
        put("tiff_rows_256 wall", tr.get("wall"))
        sp = tr.get("split") or {}
        for k in ("parse", "wait", "decode", "copy", "unpredict", "convert", "deliver", "kernel", "bands", "pieces"):
            if k in sp:
                put(f"tiff_rows_256 {k}", sp.get(k))
    return out


def print_table(title, col_b, col_a, b, a):
    keys = list(dict.fromkeys(list(b) + list(a)))
    if not keys:
        return
    w = max(len(k) for k in keys) + 2
    print(f"\n=== {title} ===")
    print("row".ljust(w) + col_b.ljust(32) + col_a.ljust(32) + f"{col_b.split()[0]} / {col_a.split()[0]} (medians)")
    for k in keys:
        mb = med(b.get(k, []))
        ma = med(a.get(k, []))
        ratio = ""
        if mb and ma and ma[0]:
            ratio = f"{mb[0] / ma[0]:.2f}x"
        print(k.ljust(w) + fmt(mb).ljust(32) + fmt(ma).ljust(32) + ratio)


def main():
    b_tp = gather_tiffperf("before")
    a_tp = gather_tiffperf("after")
    print_table(
        "15000 x 10000 tiff_test.py --size (6 variants, 1 variant/instance, 3 alternating rounds, median [min-max] ms)",
        "before (0740aeab)",
        "after (K17)",
        b_tp,
        a_tp,
    )
    js_ab = gather_tiffperf("unpack_js", ("lzw", "packbits"))
    rs_ab = gather_tiffperf("unpack_rust", ("lzw", "packbits"))
    print_table(
        "15000 x 10000 isolated tiffUnpack route A/B on K17 readTiffBand (lzw & packbits, 3 alternating rounds, median [min-max] ms)",
        "unpack_js (twin)",
        "unpack_rust (wasm)",
        js_ab,
        rs_ab,
    )
    print_table(
        "15000 x 10000 w0_bench.py tiff_rows_256 (3 alternating rounds, median [min-max] ms)",
        "before (0740aeab)",
        "after (K17)",
        gather_w0bench("before"),
        gather_w0bench("after"),
    )


if __name__ == "__main__":
    main()
