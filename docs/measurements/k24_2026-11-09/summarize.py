"""K24's rows, before (a tree at 3fd8bda7, wasm-kernels before K24) against after (guided_far & depth_guide worker job):
the median over the 3 alternating rounds with [min-max] spread, plus 2048x1152 digest comparison.

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
            for r in j.get("rows", []):
                job = r["job"]
                k = r["kernels"]
                out.setdefault(f"{job} ({k}) wall", []).append(r["wall"])
                if "total" in r:
                    out.setdefault(f"{job} ({k}) worker job", []).append(r["total"])
                sp = (r.get("split") or {}).get("ms") or {}
                if "guided_far" in sp:
                    out.setdefault(f"{job} ({k}) split.guided_far", []).append(sp["guided_far"])
                calls_w = (r.get("px") or {}).get("window") or {}
                calls_j = (r.get("px") or {}).get("workers") or {}
                out.setdefault(f"{job} ({k}) window px calls", []).append(
                    ", ".join(f"{ck} {cv}" for ck, cv in sorted(calls_w.items())) or "none"
                )
                out.setdefault(f"{job} ({k}) worker px calls", []).append(
                    ", ".join(f"{ck} {cv}" for ck, cv in sorted(calls_j.items())) or "none"
                )
    return out


def load_digests(arm):
    out = {}
    p = os.path.join(arm, "pxjobs_check.jsonl")
    if not os.path.exists(p):
        return out
    for line in open(p, encoding="utf-8"):
        j = json.loads(line)
        for r in j.get("rows", []):
            out[(r["job"], r["kernels"])] = (r.get("digest"), r.get("guideDigest"))
    return out


if __name__ == "__main__":
    d = sys.argv[1]
    b = load_arm(os.path.join(d, "before"))
    a = load_arm(os.path.join(d, "after"))
    print(f"{'row':52} {'before (3fd8bda7)':>24} {'after (K24)':>24}")
    for k in list(dict.fromkeys(list(b) + list(a))):
        xb, xa = b.get(k, []), a.get(k, [])
        if k.endswith("px calls"):
            print(f"  {k:50} {sorted(set(xb))!s:>24} {sorted(set(xa))!s:>24}")
            continue
        print(f"  {k:50} {fmt(xb):>24} {fmt(xa):>24}   n={len(xb)}/{len(xa)}")
    db = load_digests(os.path.join(d, "before"))
    da = load_digests(os.path.join(d, "after"))
    if db or da:
        print("\n2048x1152 digests (before vs after):")
        for key in sorted(set(db) | set(da)):
            b_dig, b_gdig = db.get(key, (None, None))
            a_dig, a_gdig = da.get(key, (None, None))
            same = b_dig == a_dig and b_gdig == a_gdig and b_dig is not None
            print(f"  {key[0]} ({key[1]}): data={a_dig} guide={a_gdig} match_before={same}")
