"""K29's rows on 15000 x 10000 (grid step 4), before (ROUTES {"liquifyPreview":"js"}: the JS twin previewBlock) against
after (ROUTES {"liquifyPreview":"rust"}: Rust liquify_preview with the window in px.alloc memory): the median over the
rounds of each row's own figure, with [min-max].

    python docs/measurements/k29_2026-11-08/summarize.py docs/measurements/k29_2026-11-08/ab
"""
import glob
import json
import os
import statistics
import sys


def med(xs):
    return statistics.median(xs) if xs else None


def rows(arm):
    out = {}
    for f in sorted(glob.glob(os.path.join(arm, "liquify_r*.json"))):
        j = json.load(open(f, encoding="utf-8"))
        for r in j.get("rows", []):
            name = r["row"]
            if "window" in r and r["window"] is not None:
                out.setdefault(f"{name} window (ms)", []).append(r["window"])
            if "preview" in r and isinstance(r["preview"], dict):
                out.setdefault(f"{name} preview p50 (ms)", []).append(r["preview"]["p50"])
                out.setdefault(f"{name} preview p95 (ms)", []).append(r["preview"]["p95"])
                out.setdefault(f"{name} preview worst (ms)", []).append(r["preview"]["worst"])
            elif "preview" in r and isinstance(r["preview"], (int, float)):
                out.setdefault(f"{name} preview (ms)", []).append(r["preview"])
            if "frame" in r and isinstance(r["frame"], dict):
                out.setdefault(f"{name} frame p50 (ms)", []).append(r["frame"]["p50"])
                out.setdefault(f"{name} frame p95 (ms)", []).append(r["frame"]["p95"])
                out.setdefault(f"{name} frame worst (ms)", []).append(r["frame"]["worst"])
            elif "frame" in r and isinstance(r["frame"], (int, float)):
                out.setdefault(f"{name} frame (ms)", []).append(r["frame"])
            if "dab" in r and isinstance(r["dab"], dict):
                out.setdefault(f"{name} dab p50 (ms)", []).append(r["dab"]["p50"])
            elif "dab" in r and isinstance(r["dab"], (int, float)):
                out.setdefault(f"{name} dab (ms)", []).append(r["dab"])
            for k in ("pxMB0", "pxMBTrimmed", "pxMBGrown", "idleTrimmed", "midIdleTrimmed", "midWindow", "midDab", "midPreview", "midFrame", "land", "ms", "blockedMax"):
                if k in r and r[k] is not None:
                    unit = "MB" if k.startswith("pxMB") else ("n" if "Trimmed" in k else "ms")
                    out.setdefault(f"{name} {k} ({unit})", []).append(r[k])
            if "tick" in r and isinstance(r["tick"], dict):
                out.setdefault(f"{name} tick p50 (ms)", []).append(r["tick"]["p50"])
            w_prev = (r.get("pxCalls") or {}).get("liquify_preview", 0)
            out.setdefault(f"{name} liquify_preview calls (win)", []).append(f"{w_prev}")
    return out


d = sys.argv[1]
b, a = rows(os.path.join(d, "before")), rows(os.path.join(d, "after"))
print(f"{'row':60} {'before (js)':>24} {'after (rust)':>24}")
for k in list(dict.fromkeys(list(b) + list(a))):
    xb, xa = b.get(k, []), a.get(k, [])
    if k.endswith("calls (win)"):
        print(f"  {k:58} {sorted(set(xb))!s:>24} {sorted(set(xa))!s:>24}")
        continue
    fb = f"{med(xb):.1f} [{min(xb):.1f}-{max(xb):.1f}]" if xb else "-"
    fa = f"{med(xa):.1f} [{min(xa):.1f}-{max(xa):.1f}]" if xa else "-"
    print(f"  {k:58} {fb:>24} {fa:>24}   n={len(xb)}/{len(xa)}")
