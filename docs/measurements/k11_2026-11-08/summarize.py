"""K11's rows, before (a tree at dfe2f35, wasm-kernels) against after (mask_invert, deferred writable copy on frozen
tiles): the median over the 3 alternating rounds with [min-max] spread.

    python summarize.py <dir>
"""
import glob
import json
import os
import statistics
import sys


def med(xs):
    return statistics.median(xs) if xs else None


def fmt(xs):
    if not xs:
        return "-"
    return f"{med(xs):.1f} [{min(xs):.1f}-{max(xs):.1f}]"


def load_arm(arm):
    out = {}
    for f in sorted(glob.glob(os.path.join(arm, "pxjobs_r*.jsonl"))):
        for line in open(f, encoding="utf-8"):
            j = json.loads(line)
            if not (j.get("visibility") == "visible" and j.get("focused")):
                continue
            rows = j.get("rows", [])
            for job in ("invert", "wand_object", "wand_band", "wand_add"):
                for k in ("js", "rust"):
                    rs = [r for r in rows if r.get("job") == job and r.get("kernels") == k]
                    if not rs:
                        continue
                    out.setdefault(f"px_jobs {job} ({k}) wall", []).append(med([r["wall"] for r in rs]))
                    if any("invert" in r and r.get("invertN") for r in rs):
                        out.setdefault(f"px_jobs {job} ({k}) invert ms", []).append(med([r["invert"] for r in rs]))
                    if any("combine" in r and r.get("combineN") for r in rs):
                        out.setdefault(f"px_jobs {job} ({k}) combine ms", []).append(med([r["combine"] for r in rs]))
                    win_ms = [sum(((((r.get("split") or {}).get("window") or {}).get("ms") or {}).values())) for r in rs]
                    if any(win_ms):
                        out.setdefault(f"px_jobs {job} ({k}) window kernel ms", []).append(med(win_ms))
                    copy_in = [(((r.get("split") or {}).get("window") or {}).get("copyIn") or 0.0) for r in rs]
                    if any(copy_in):
                        out.setdefault(f"px_jobs {job} ({k}) window copyIn ms", []).append(med(copy_in))
                    calls = ((rs[0].get("px") or {}).get("window")) or {}
                    out.setdefault(f"px_jobs {job} ({k}) window px calls", []).append(
                        ", ".join(f"{ck} {cv}" for ck, cv in sorted(calls.items())) or "none"
                    )
    for f in sorted(glob.glob(os.path.join(arm, "native_r*.json"))):
        j = json.load(open(f, encoding="utf-8"))
        rows = j.get("rows") or {}
        for job in ("invert", "wand_whole_picture", "wand_whole_add", "wand_one_disc"):
            r = (rows.get(job) or {}).get("row")
            if not isinstance(r, dict):
                continue
            if "wall" in r:
                out.setdefault(f"native {job} wall", []).append(r["wall"])
            if "blocked" in r:
                out.setdefault(f"native {job} blocked", []).append(r["blocked"])
            px_win = ((r.get("pxCalls") or {}).get("window")) or {}
            out.setdefault(f"native {job} window px calls", []).append(
                ", ".join(f"{ck} {cv}" for ck, cv in sorted(px_win.items())) or "none"
            )
    return out


if __name__ == "__main__":
    d = sys.argv[1]
    b = load_arm(os.path.join(d, "before"))
    a = load_arm(os.path.join(d, "after"))
    print(f"{'row':52} {'before (dfe2f35)':>24} {'after (K11)':>24}")
    for k in list(dict.fromkeys(list(b) + list(a))):
        xb, xa = b.get(k, []), a.get(k, [])
        if k.endswith("px calls"):
            print(f"  {k:50} {sorted(set(xb))!s:>24} {sorted(set(xa))!s:>24}")
            continue
        print(f"  {k:50} {fmt(xb):>24} {fmt(xa):>24}   n={len(xb)}/{len(xa)}")
