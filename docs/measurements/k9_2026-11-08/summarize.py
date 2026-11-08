"""K9's rows, before (a tree at 0117ba14, wasm-kernels) against after (K9: flood_shape out_kind / cells, the alpha-tile
cut, the grow / shrink cut): the median over the 3 alternating rounds with [min-max] spread.

    python summarize.py <dir>
"""
import glob
import json
import os
import re
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
            for job in ("wand_band", "wand_object", "wand_add", "grow", "shrink", "invert"):
                for k in ("js", "rust"):
                    rs = [r for r in rows if r.get("job") == job and r.get("kernels") == k]
                    if not rs:
                        continue
                    out.setdefault(f"px_jobs {job} ({k}) wall", []).append(med([r["wall"] for r in rs]))
                    if any("shape" in r for r in rs):
                        out.setdefault(f"px_jobs {job} ({k}) shape ms", []).append(med([r.get("shape", 0.0) for r in rs]))
                    if any("cut" in r for r in rs):
                        out.setdefault(f"px_jobs {job} ({k}) cut ms", []).append(med([r.get("cut", 0.0) for r in rs]))
                    if any("combine" in r and r.get("combineN") for r in rs):
                        out.setdefault(f"px_jobs {job} ({k}) combine ms", []).append(med([r["combine"] for r in rs]))
                    if any("kernel" in r for r in rs):
                        out.setdefault(f"px_jobs {job} ({k}) kernel ms", []).append(med([r.get("kernel", 0.0) for r in rs]))
    for f in sorted(glob.glob(os.path.join(arm, "native_r*.json"))):
        j = json.load(open(f, encoding="utf-8"))
        rows = j.get("rows") or {}
        for job in ("grow_16", "shrink_16", "wand_whole_picture", "wand_whole_add", "wand_one_disc"):
            r = (rows.get(job) or {}).get("row")
            if not isinstance(r, dict):
                continue
            if "wall" in r:
                out.setdefault(f"native {job} wall", []).append(r["wall"])
            if "blocked" in r:
                out.setdefault(f"native {job} blocked", []).append(r["blocked"])
    for f in sorted(glob.glob(os.path.join(arm, "perf_r*.log"))):
        text = open(f, encoding="utf-8", errors="replace").read()
        if "NOT COUNTED" in text:
            continue
        for m in re.finditer(r"^(grow \+16|shrink -16|invert|magic wand [^\n]*?)\s+(\d+(?:\.\d+)?)\s*ms\s*\[(\d+(?:\.\d+)?)\]", text, re.M):
            label = re.sub(r"\s+", " ", m.group(1).strip())
            out.setdefault(f"perf {label} blocked", []).append(float(m.group(2)))
            out.setdefault(f"perf {label} wall", []).append(float(m.group(3)))
    return out


if __name__ == "__main__":
    d = sys.argv[1]
    b = load_arm(os.path.join(d, "before"))
    a = load_arm(os.path.join(d, "after"))
    print(f"{'row':52} {'before (0117ba14)':>24} {'after (K9)':>24}")
    for k in list(dict.fromkeys(list(b) + list(a))):
        xb, xa = b.get(k, []), a.get(k, [])
        print(f"  {k:50} {fmt(xb):>24} {fmt(xa):>24}   n={len(xb)}/{len(xa)}")
