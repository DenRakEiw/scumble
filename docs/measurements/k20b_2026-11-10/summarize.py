"""Summarize K20b's 3-round alternating 15,000 x 10,000 measurements (open_psd before/after, psdRead js/rust A/B, tiffperf noise/own)."""
import glob
import json
import os
import statistics
import sys

sys.stdout.reconfigure(encoding="utf-8")

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
    return f"{v:,.1f} [{lo:,.1f}..{hi:,.1f}]" + ("" if n == 3 else f" (n={n})")


def verdict(mb, ma):
    if mb is None or ma is None:
        return ""
    vb, lob, hib, _ = mb
    va, loa, hia, _ = ma
    spread = max(hib - lob, hia - loa)
    diff = vb - va
    if abs(diff) <= spread:
        return f"tie (|d|={abs(diff):.1f} <= spread {spread:.1f})"
    ratio = f"{vb / va:.2f}x" if va else ""
    return (f"win {ratio}" if diff > 0 else f"LOSS {ratio}") + f" (d={-diff:+.1f}, spread {spread:.1f})"


def gather_native(arm):
    out = {}
    put = lambda k, v: out.setdefault(k, []).append(v)
    for f in sorted(glob.glob(os.path.join(HERE, arm, "native", "r*.json"))):
        j = json.load(open(f, encoding="utf-8"))
        rows = j.get("rows") or {}
        for rname in ("open_the_file", "add_the_paint_layer", "export_psd", "open_psd"):
            rr = ((rows.get(rname) or {}).get("row")) or {}
            if not rr or rr.get("error"):
                continue
            put(f"{rname} wall", rr.get("wall"))
            put(f"{rname} blocked", rr.get("blocked"))
            if rname == "export_psd":
                ex = rr.get("extra") or {}
                if "MB" in ex:
                    put("export_psd MB", ex.get("MB"))
            if rname == "open_psd":
                pr = (rr.get("jobs") or {}).get("psd_read") or {}
                for k in ("kernel", "read", "channels", "interleave", "mask", "deliver", "inflate", "bands"):
                    if k in pr:
                        put(f"open_psd jobs.psd_read.{k}", pr.get(k))
                pxc = pr.get("pxCalls") or {}
                for k in ("packbits_rows", "tiff_to_rgba", "psd_mask_rgba", "tiff_unpredict"):
                    if k in pxc:
                        put(f"open_psd pxCalls.{k}", pxc.get(k))
                lo = ((rr.get("marks") or {}).get("layered_open") or [{}])[0] if isinstance((rr.get("marks") or {}).get("layered_open"), list) else ((rr.get("marks") or {}).get("layered_open") or {})
                if isinstance(lo, dict):
                    for mk in ("parsed", "stored", "base", "added", "total"):
                        if mk in lo and isinstance(lo[mk], (int, float)):
                            put(f"open_psd layered_open.{mk}", lo.get(mk))
                    ex2 = lo.get("extra") or {}
                    if "rgbaMs" in ex2:
                        put("open_psd layered_open.rgbaMs", ex2.get("rgbaMs"))
                prof = (rows.get(rname) or {}).get("profile") or {}
                if "gc" in prof:
                    put("open_psd profile.gc", prof.get("gc"))
    return out


def gather_tiffperf(arm):
    out = {}
    put = lambda k, v: out.setdefault(k, []).append(v)
    for vname in ("noise", "own"):
        for f in sorted(glob.glob(os.path.join(HERE, arm, "tiffperf", f"{vname}_r*.log"))):
            with open(f, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    prefix = f"[ok] variant {vname}: "
                    if line.startswith(prefix):
                        j = json.loads(line[len(prefix):])
                        if "exportMs" in j:
                            put(f"{vname} exportMs", j.get("exportMs"))
                        put(f"{vname} openMs", j.get("openMs"))
                        tr = j.get("tiff_read") or {}
                        for k in ("kernel", "decode", "unpredict", "convert", "deliver"):
                            if k in tr:
                                put(f"{vname} tiff_read.{k}", tr.get(k))
    return out


def print_table(title, col_b, col_a, b, a):
    keys = list(dict.fromkeys(list(b) + list(a)))
    if not keys:
        return
    w = max(len(k) for k in keys) + 2
    print(f"\n=== {title} ===")
    print("row".ljust(w) + col_b.ljust(30) + col_a.ljust(30) + "verdict (rules.md s4)")
    for k in keys:
        mb = med(b.get(k, []))
        ma = med(a.get(k, []))
        print(k.ljust(w) + fmt(mb).ljust(30) + fmt(ma).ljust(30) + verdict(mb, ma))


def main():
    print_table(
        "15,000 x 10,000 native_test.py (before 764fdffe vs after K20b, 3 alternating rounds, median [min..max] ms)",
        "before (764fdffe)",
        "after (K20b)",
        gather_native("before"),
        gather_native("after"),
    )
    print_table(
        "15,000 x 10,000 same-build psdRead route A/B (--set psdRead=js vs --set psdRead=rust, 3 alternating rounds)",
        "psdRead=js (twin)",
        "psdRead=rust (wasm)",
        gather_native("route_js"),
        gather_native("route_rust"),
    )
    print_table(
        "15,000 x 10,000 tiff_test.py --variant noise,own (before 764fdffe vs after K20b, 3 alternating rounds)",
        "before (764fdffe)",
        "after (K20b)",
        gather_tiffperf("before"),
        gather_tiffperf("after"),
    )


if __name__ == "__main__":
    main()
