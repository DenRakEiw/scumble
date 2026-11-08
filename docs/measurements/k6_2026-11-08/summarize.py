"""Summarize K6's 3-round alternating before/after native_test.py runs at 15000 x 10000."""
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


def gather(arm):
    out = {}
    put = lambda k, v: out.setdefault(k, []).append(v)
    for f in sorted(glob.glob(os.path.join(HERE, arm, "native", "r*.json"))):
        j = json.load(open(f, encoding="utf-8"))
        rows = j.get("rows") or {}
        b = (rows.get("build_the_file") or {}).get("row") or {}
        put("build_the_file encodeMs", b.get("encodeMs"))
        for name in ("open_the_file", "open_again"):
            r = (rows.get(name) or {}).get("row") or {}
            if not r:
                continue
            put(f"{name} wall", r.get("wall"))
            put(f"{name} longest block", r.get("blocked"))
            pr = (r.get("jobs") or {}).get("png_read") or {}
            for k in ("kernel", "unfilter", "wait", "copy", "write", "read", "parse"):
                if k in pr:
                    put(f"{name} png_read {k}", pr.get(k))
            wpx = ((r.get("pxCalls") or {}).get("workers") or {}).get("png_unfilter_rows")
            put(f"{name} worker png_unfilter_rows calls", wpx)
    return out


def main():
    b = gather("before")
    a = gather("after")
    keys = list(dict.fromkeys(list(b) + list(a)))
    w = max(len(k) for k in keys) + 2
    print("row".ljust(w) + "before (5419c95a)".ljust(28) + "after (K6)".ljust(28) + "before / after (medians)")
    for k in keys:
        mb = med(b.get(k, []))
        ma = med(a.get(k, []))
        ratio = ""
        if mb and ma and ma[0]:
            ratio = f"{mb[0] / ma[0]:.2f}x"
        print(k.ljust(w) + fmt(mb).ljust(28) + fmt(ma).ljust(28) + ratio)


if __name__ == "__main__":
    main()
