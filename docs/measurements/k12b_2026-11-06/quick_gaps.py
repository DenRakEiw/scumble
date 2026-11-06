"""K12b (b): the drag step's rows per run from k12b_chain.sh's folders: [blocked, landed], the window's three longest gaps
[start from the step, length] and the quick landings' times from the step, for the row itself (relight_quick), the same
step again on one job (relight_quick_job, the route relightStripes 0) and on stripes (relight_quick_rep).

    python quick_gaps.py before [after ...] [--keys=relight_three,relight_three_mv_nofeed,...]

Every relight row has the gaps and landings since K12b's second after run (after2); the default keys are the quick rows.
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    keys = next((a.split("=", 1)[1].split(",") for a in sys.argv[1:] if a.startswith("--keys=")), None) or ["relight_quick", "relight_quick_job", "relight_quick_rep"]
    for d in [a for a in sys.argv[1:] if not a.startswith("--")] or ["before"]:
        d = d if os.path.isabs(d) else os.path.join(HERE, d)
        print(f"== {os.path.basename(d)}")
        for f in sorted(glob.glob(os.path.join(d, "perf", "r*.json"))):
            r = json.load(open(f, encoding="utf-8"))[0]
            print(f"  {os.path.basename(f)}")
            for key in keys:
                v = r.get(key)
                if v is None:
                    continue
                gaps = " ".join(f"{g[1]:.1f}@{g[0]:.1f}" for g in (r.get(key + "_gaps") or []))
                lands = " ".join(f"{x:.1f}" for x in (r.get(key + "_landings") or []))
                print(f"    {key:<24} blocked {v[0]:>6} landed {v[1]:>6}   gaps (ms@from step) {gaps:<40} landings {lands}")


if __name__ == "__main__":
    main()
