"""Summarize K18's 3-round alternating 15000 x 10000 runs (tiffperf 7 variants: before c36840d8 vs after K18)."""
import glob
import json
import os
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
ALL_VARIANTS = ("own", "lzw", "packbits", "raw_strips", "zlib1", "raw", "noise")


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
                            for k in ("jobs", "composeWasm", "kernel", "rows", "predict", "adler", "deflate"):
                                if k in tp:
                                    put(f"{vname} export tiff_part {k}", tp.get(k))
                        put(f"{vname} openMs", j.get("openMs"))
                        os_steps = j.get("openSteps") or {}
                        for mk in ("info", "pixels", "writeMs", "stored", "base", "settled", "total"):
                            if mk in os_steps:
                                put(f"{vname} openSteps {mk}", os_steps.get(mk))
                        tb = j.get("tiff_band")
                        tr = j.get("tiff_read")
                        active = tb or tr or {}
                        put(f"{vname} reader jobs", (tb or {}).get("jobs", 1 if tr else 0))
                        put(f"{vname} reader workers", (tb or {}).get("workers", 1 if tr else 0))
                        for k in ("kernel", "wait", "decode", "copy", "unpredict", "convert", "pieces"):
                            if k in active:
                                put(f"{vname} reader {k}", active.get(k))
                        oj = ((j.get("openJobs") or {}).get("png_part")) or {}
                        for k in ("jobs", "composeWasm", "kernel", "rows", "filter", "adler", "deflate"):
                            if k in oj:
                                put(f"{vname} open png_part {k}", oj.get(k))
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
        if mb and ma and ma[0] and ma[0] > 0:
            ratio = f"{mb[0] / ma[0]:.2f}x"
        print(k.ljust(w) + fmt(mb).ljust(32) + fmt(ma).ljust(32) + ratio)


def main():
    b_tp = gather_tiffperf("before")
    a_tp = gather_tiffperf("after")
    print_table(
        "15000 x 10000 tiff_test.py --size (7 variants, 1 variant/instance, 3 alternating rounds, median [min-max] ms)",
        "before (c36840d8)",
        "after (K18)",
        b_tp,
        a_tp,
    )


if __name__ == "__main__":
    main()
