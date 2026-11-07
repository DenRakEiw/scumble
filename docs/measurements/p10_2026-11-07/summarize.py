"""P10's A/B table from p10_chain.sh's JSON (ab/before, ab/after): the median of the rounds per row, the spread beside it.

    python summarize.py [ab_dir]          prints the table (summary.txt is this output)
"""
import json
import os
import statistics
import sys

AB = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "ab")


def rounds(arm, kind):
    out = []
    d = os.path.join(AB, arm)
    for name in sorted(os.listdir(d)):
        if name.startswith(kind + "_r") and name.endswith(".json"):
            with open(os.path.join(d, name), encoding="utf-8") as f:
                out.append((name, json.load(f)))
    return out


def native_rows(j):
    r = j["rows"]["pan_and_zoom"]
    row, prof = r["row"], r.get("profile") or {}
    fx = row["extra"]
    put = sum(v for k, v in (prof.get("fn") or {}).items() if k.startswith("put "))
    tex = (row.get("calls") or {}).get("gl texSubImage2D", {})
    return {
        "native pan_and_zoom wall (ms)": row["wall"],
        "  frame pan at 1:1 far, median (ms)": fx["pan_1to1_far"]["median"],
        "  frame pan at 1:1 far, max (ms)": fx["pan_1to1_far"]["max"],
        "  frame pan at 1:1, max (ms)": fx["pan_1to1"]["max"],
        "  frame zoom, max (ms)": fx["zoom"]["max"],
        "  profile: put self time (ms)": round(put, 1),
        "  profile: inpaint_tiles.js self time (ms)": round((prof.get("js") or {}).get("inpaint_tiles.js", 0), 1),
        "  texSubImage2D calls [MB]": f"{tex.get('n', 0)} [{tex.get('MB', 0)}]",
    }


PERF = [
    ("perf pan at 1:1 (30 frames), median (ms)", "pan_1to1", 0),
    ("perf pan at 1:1 (30 frames), max (ms)", "pan_1to1", 1),
    ("perf pan (60 frames), median (ms)", "pan", 0),
    ("perf wheel zoom (10), median (ms)", "zoom", 0),
    ("perf first frame fit -> 1:1, GPU (ms)", "first_1to1_gl", 0),
    ("perf frame after a whole change, fit (ms)", "whole_fit_gl", 0),
    ("perf frame after a whole change, 1:1 (ms)", "whole_1to1_gl", 0),
    ("perf frame after a whole touch, fit (ms)", "touch_fit_gl", 0),
]


def perf_rows(j):
    x = j[0] if isinstance(j, list) else j
    out = {}
    for label, key, i in PERF:
        v = x.get(key)
        out[label] = v[i] if isinstance(v, list) else v
    return out


def med(vals):
    nums = [v for v in vals if isinstance(v, (int, float))]
    if not nums:
        return vals[0] if vals else None, ""
    return round(statistics.median(nums), 2), f"{min(nums)}-{max(nums)}"


def main():
    table = {}
    n = {}
    for arm in ("before", "after"):
        per = {}
        for _, j in rounds(arm, "native"):
            for k, v in native_rows(j).items():
                per.setdefault(k, []).append(v)
        for _, j in rounds(arm, "perf"):
            for k, v in perf_rows(j).items():
                per.setdefault(k, []).append(v)
        table[arm] = per
        n[arm] = (len(rounds(arm, "native")), len(rounds(arm, "perf")))
    print(f"P10 A/B at 15000 x 10000, tiles, a fresh instance per run; rounds (native, perf): before {n['before']}, after {n['after']}")
    print(f"{'row':48s} {'before':>10s} {'(spread)':>14s} {'after':>10s} {'(spread)':>14s}")
    for k in table["before"]:
        b, bs = med(table["before"][k])
        a, as_ = med(table["after"].get(k, []))
        print(f"{k:48s} {str(b):>10s} {bs:>14s} {str(a):>10s} {as_:>14s}")


if __name__ == "__main__":
    main()
