"""Summarize the K20b review's 15,000 x 10,000 runs (chain.sh): before 764fdffe / unpaced (psdWindow=0) / paced (default)."""
import glob
import json
import os
import statistics
import sys

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
ARMS = ("before", "unpaced", "paced")


def med(vals):
    vals = [v for v in vals if isinstance(v, (int, float))]
    return (statistics.median(vals), min(vals), max(vals), len(vals)) if vals else None


def fmt(m):
    if m is None:
        return "-"
    v, lo, hi, n = m
    return f"{v:,.1f} [{lo:,.1f}..{hi:,.1f}]" + ("" if n == 3 else f" (n={n})")


def verdict(mb, ma):
    """ma against mb (lower is better): win / LOSS when the medians differ by more than the larger spread, else tie."""
    if mb is None or ma is None:
        return ""
    vb, lob, hib, _ = mb
    va, loa, hia, _ = ma
    spread = max(hib - lob, hia - loa)
    d = va - vb
    if abs(d) <= spread:
        return f"tie (|d|={abs(d):.1f} <= spread {spread:.1f})"
    ratio = f"{vb / va:.2f}x" if va else ""
    return (f"win {ratio}" if d < 0 else f"LOSS {ratio}") + f" (d={d:+.1f}, spread {spread:.1f})"


def native(arm):
    out = {}
    put = lambda k, v: out.setdefault(k, []).append(v)
    for f in sorted(glob.glob(os.path.join(HERE, arm, "native", "r*.json"))):
        rows = json.load(open(f, encoding="utf-8")).get("rows") or {}
        for name in ("open_the_file", "add_the_paint_layer", "export_psd", "open_psd"):
            rr = (rows.get(name) or {}).get("row") or {}
            if not rr or rr.get("error"):
                continue
            put(f"{name} wall", rr.get("wall"))
            put(f"{name} blocked", rr.get("blocked"))
            if name != "open_psd":
                continue
            pr = (rr.get("jobs") or {}).get("psd_read") or {}
            for k in ("kernel", "channels", "interleave", "deliver", "wait", "bands", "window"):
                if k in pr:
                    put(f"open_psd psd_read.{k}", pr.get(k))
            lo = (rr.get("marks") or {}).get("layered_open")
            lo = lo[0] if isinstance(lo, list) and lo else (lo or {})
            for k in ("parsed", "stored", "total"):
                if isinstance(lo.get(k), (int, float)):
                    put(f"open_psd layered_open.{k}", lo.get(k))
            if "rgbaMs" in (lo.get("extra") or {}):
                put("open_psd layered_open.rgbaMs", lo["extra"]["rgbaMs"])
    return out


def soft(arm):
    out = {}
    put = lambda k, v: out.setdefault(k, []).append(v)
    for f in sorted(glob.glob(os.path.join(HERE, arm, "soft", "r*.json"))):
        reps = json.load(open(f, encoding="utf-8")).get("reps") or []
        for i, r in enumerate(reps):
            if r.get("error"):
                continue
            tag = "first" if i == 0 else "warm"
            j = (r.get("jobs") or [{}])[0]
            put(f"{tag} wall", r.get("wall"))
            put(f"{tag} blocked", r.get("blocked"))
            put(f"{tag} longest band run without a beat (ms)", (r.get("bandRun") or {}).get("ms"))
            put(f"{tag} longest band run without a beat (bands)", (r.get("bandRun") or {}).get("bands"))
            for k in ("kernel", "wait", "bands", "window"):
                if k in j:
                    put(f"{tag} psd_read.{k}", j.get(k))
            lo = next((m for m in (r.get("marks") or []) if m.get("rgbaMs") is not None), None)
            if lo:
                put(f"{tag} layered_open.rgbaMs", lo.get("rgbaMs"))
    return out


def table(title, data):
    keys = list(dict.fromkeys(k for a in ARMS for k in data[a]))
    if not keys:
        return
    w = max(len(k) for k in keys) + 2
    print(f"\n=== {title} ===")
    print("row".ljust(w) + "".join(a.ljust(30) for a in ARMS) + "paced vs unpaced".ljust(44) + "paced vs before")
    for k in keys:
        m = {a: med(data[a].get(k, [])) for a in ARMS}
        print(k.ljust(w) + "".join(fmt(m[a]).ljust(30) for a in ARMS) + verdict(m["unpaced"], m["paced"]).ljust(44) + verdict(m["before"], m["paced"]))


if __name__ == "__main__":
    table("15,000 x 10,000 native_test.py (2-layer file: Background + soft-alpha Paint), median [min..max] of 3 alternating rounds, ms",
          {a: native(a) for a in ARMS})
    table("15,000 x 10,000 psd_open.py (Background + 3 full-size soft-alpha layers), first and warm open per instance, median [min..max] of 3 alternating rounds, ms",
          {a: soft(a) for a in ARMS})
