"""K13's rows (a copy of ../k12b_2026-11-06/summarize.py) from k13_chain.sh's folders: medians [min-max] of the counted runs (perf/r*.json), and before -> after.

    python summarize.py before            one folder
    python summarize.py before after      both, side by side

Every row at 15000 x 10000 with --filter=relight --map=4096x2731 (tools/perf_test.py). A pair [a, b] is printed as two
rows: "<row> [0]" and "<row> [1]" (the row's own meaning is in perf_test.py: [blocked, landed] for the march rows,
[frame, mips settled] for the whole-change rows, ...).
"""
import glob
import json
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

ROWS = [
    # the chain rows (pinned in K12)
    ("whole_fit_gl", "frame after a whole change, fit"),
    ("whole_fit_gl_settled", "  mips settled [longest block]"),
    ("whole_fit_gl_chains", "  chains built here [asked]"),
    ("whole_1to1_gl", "frame after a whole change, 1:1"),
    ("whole_1to1_gl_settled", "  mips settled [longest block]"),
    ("whole_1to1_gl_chains", "  chains built here [asked]"),
    ("whole_1to1_gl_state", "  below stats redone [marches in flight]"),
    ("whole_quiet", "  (waited for the setup's marches [in flight])"),
    ("panel_flatten_sync", "192 px picture, the old way [wall]"),
    ("panel_flatten_sync_chains", "  chains built here [from the worker]"),
    ("panel_flatten_settled", "192 px picture, settled [wall]"),
    ("panel_flatten_settled_chains", "  chains built here [from the worker]"),
    ("whole_1to1_lights", "the frame with the lights overlay"),
    ("whole_1to1_lights_chains", "  chains built here [asked]"),
    ("whole_1to1_lights_state", "  below stats redone [marches]"),
    # relight's march rows: [blocked, landed]
    ("relight_one", "one light moved [blocked, landed]"),
    ("relight_one_marches", "  marches [slowest landed]"),
    ("relight_one_stripes", "  stripes [workers]"),
    ("relight_one_kernel", "  kernel ms summed [slowest job]"),
    ("relight_one_first", "  first stripe a worker ms [later ones]"),
    ("relight_one_others", "  others [mips built here, asked]"),
    ("relight_one_busy", "  busy share"),
    ("relight_one_eff", "  parallel efficiency [busy share]"),
    ("relight_one_overhead", "  stripes' kernel / one job's"),
    ("relight_one_job", "  again, one job (stripes 0) [blocked, landed]"),
    ("relight_one_job_kernel", "    kernel ms summed [slowest job]"),
    ("relight_one_job_others", "    others [mips built here, asked]"),
    ("relight_one_rep", "  again, stripes [blocked, landed]"),
    ("relight_one_rep_stripes", "    stripes [workers]"),
    ("relight_one_rep_kernel", "    kernel ms summed [slowest job]"),
    ("relight_one_rep_first", "    first stripe a worker ms [later ones]"),
    ("relight_one_rep_others", "    others [mips built here, asked]"),
    ("relight_one_rep_eff", "    parallel efficiency [busy share]"),
    ("relight_one_rep_overhead", "    stripes' kernel / one job's"),
    # K12b (c): 64 stripes (STRIPES_PER_WORKER 8); (a): every stripe posted at once (the route relightFeed 0, K12)
    ("relight_one_s64", "  again, 64 stripes [blocked, landed]"),
    ("relight_one_s64_kernel", "    kernel ms summed [slowest job]"),
    ("relight_one_s64_eff", "    parallel efficiency [busy share]"),
    ("relight_one_s64_overhead", "    stripes' kernel / one job's"),
    ("relight_one_nofeed", "  again, every stripe posted [blocked, landed]"),
    ("relight_one_nofeed_eff", "    parallel efficiency [busy share]"),
    ("relight_three", "three lights moved [blocked, landed]"),
    ("relight_three_marches", "  marches [slowest landed]"),
    ("relight_three_stripes", "  stripes [workers]"),
    ("relight_three_kernel", "  kernel ms summed [slowest job]"),
    ("relight_three_first", "  first stripe a worker ms [later ones]"),
    ("relight_three_others", "  others [mips built here, asked]"),
    ("relight_three_busy", "  busy share"),
    ("relight_three_eff", "  parallel efficiency [busy share]"),
    ("relight_three_overhead", "  stripes' kernel / one job's"),
    ("relight_three_job", "  again, one job a light [blocked, landed]"),
    ("relight_three_job_kernel", "    kernel ms summed [slowest job]"),
    ("relight_three_job_others", "    others [mips built here, asked]"),
    ("relight_three_rep", "  again, stripes [blocked, landed]"),
    ("relight_three_rep_stripes", "    stripes [workers]"),
    ("relight_three_rep_kernel", "    kernel ms summed [slowest job]"),
    ("relight_three_rep_first", "    first stripe a worker ms [later ones]"),
    ("relight_three_rep_others", "    others [mips built here, asked]"),
    ("relight_three_rep_eff", "    parallel efficiency [busy share]"),
    ("relight_three_rep_overhead", "    stripes' kernel / one job's"),
    ("relight_three_s64", "  again, 64 stripes a light [blocked, landed]"),
    ("relight_three_s64_kernel", "    kernel ms summed [slowest job]"),
    ("relight_three_s64_eff", "    parallel efficiency [busy share]"),
    ("relight_three_s64_overhead", "    stripes' kernel / one job's"),
    ("relight_three_nofeed", "  again, every stripe posted [blocked, landed]"),
    ("relight_three_nofeed_eff", "    parallel efficiency [busy share]"),
    ("relight_three_mv_nofeed", "  moved, every stripe posted [blocked, landed]"),
    ("relight_three_mv_feed", "  moved, fed again [blocked, landed]"),
    ("relight_quick", "a drag step's quick map [blocked, landed]"),
    ("relight_quick_marches", "  marches [slowest landed]"),
    ("relight_quick_stripes", "  stripes [workers]"),
    # K12b (b): the drag step again on one job (stripes 0) and on stripes, in the same run
    ("relight_quick_job", "  again, one job (stripes 0) [blocked, landed]"),
    ("relight_quick_rep", "  again, stripes [blocked, landed]"),
    ("relight_pan", "pan at 1:1 during a march [median, worst frame]"),
    ("relight_pan_frames", "  frames [shadows landed]"),
    ("relight_pan_held", "  block [chains built here]"),
    ("relight_first", "the first march after start [-, landed]"),
    ("relight_first_marches", "  marches [slowest landed]"),
    ("relight_whole_calm", "whole change 1:1, no march [frame, mips settled]"),
    ("relight_whole_calm_held", "  [block, built, asked, marching]"),
    ("relight_whole_march", "  during a three-light march [frame, mips settled]"),
    ("relight_whole_march_held", "  [block, built, asked, marching]"),
    ("relight_whole_nofeed", "  the same, every stripe posted [frame, mips settled]"),
    ("relight_whole_nofeed_held", "  [block, built, asked, marching]"),
    ("relight_whole_march2", "  fed again [frame, mips settled]"),
    ("relight_whole_march2_held", "  [block, built, asked, marching]"),
    # K12's review: eight small NORMAL jobs during a three-light march, and a light made a sun (the Rust sun)
    ("relight_normal_calm", "8 NORMAL jobs, no march [slowest wait, answer]"),
    ("relight_normal_march", "  during a three-light march [wait, answer]"),
    ("relight_normal_job", "  the same, one job a light [wait, answer]"),
    ("relight_normal_nofeed", "  the same, every stripe posted [wait, answer]"),
    # K12b's review: eight NORMAL jobs of about 60 ms each (a crc of one blob sized on a calm pool): what work that takes
    # real time waits for during a march, [the first job's wait, the last one's], [the first answer, the last]
    ("relight_heavy_size", "8 NORMAL ~60 ms jobs: crc [MB, one job ms]"),
    ("relight_heavy_calm", "  no march [first wait, last wait]"),
    ("relight_heavy_calm_answer", "    [first answer, last answer]"),
    ("relight_heavy_calm_job", "    one job's ms (median)"),
    ("relight_heavy_march", "  during a three-light march [first, last wait]"),
    ("relight_heavy_march_answer", "    [first answer, last answer]"),
    ("relight_heavy_march_job", "    one job's ms (median)"),
    ("relight_heavy_job", "  the same, one job a light [first, last wait]"),
    ("relight_heavy_job_answer", "    [first answer, last answer]"),
    ("relight_heavy_nofeed", "  the same, every stripe posted [first, last wait]"),
    ("relight_heavy_nofeed_answer", "    [first answer, last answer]"),
    ("relight_heavy_nofeed_job", "    one job's ms (median)"),
    ("relight_sun", "a light made a sun [blocked, landed]"),
    ("relight_sun_stripes", "  stripes [workers]"),
    ("relight_sun_kernel", "  kernel ms summed [slowest job]"),
    ("relight_sun_first", "  first stripe a worker ms [later ones]"),
    ("relight_sun_eff", "  parallel efficiency [busy share]"),
    ("relight_sun_overhead", "  stripes' kernel / one job's"),
    ("relight_sun_job", "  again, one job (stripes 0) [blocked, landed]"),
    ("relight_sun_job_kernel", "    kernel ms summed [slowest job]"),
    ("relight_sun_rep", "  again, stripes [blocked, landed]"),
    ("relight_sun_rep_kernel", "    kernel ms summed [slowest job]"),
    ("relight_sun_rep_first", "    first stripe a worker ms [later ones]"),
    ("relight_sun_rep_eff", "    parallel efficiency [busy share]"),
    ("relight_sun_rep_overhead", "    stripes' kernel / one job's"),
    ("relight_sun_s64", "  again, 64 stripes [blocked, landed]"),
    ("relight_sun_s64_kernel", "    kernel ms summed [slowest job]"),
    ("relight_sun_s64_eff", "    parallel efficiency [busy share]"),
    ("relight_sun_s64_overhead", "    stripes' kernel / one job's"),
    ("relight_sun_nofeed", "  again, every stripe posted [blocked, landed]"),
    ("relight_sun_nofeed_eff", "    parallel efficiency [busy share]"),
    ("relight_sun_feed2", "  again, fed after the unfed one [blocked, landed]"),
    ("relight_sun_feed2_eff", "    parallel efficiency [busy share]"),
    # the review's diagnosis: light 0 moved and marched with no redraw, then moved and released (each against one job)
    ("relight_nodraw", "a light moved, no redraw [blocked, landed]"),
    ("relight_nodraw_kernel", "  kernel ms summed [slowest job]"),
    ("relight_nodraw_first", "  first stripe a worker ms [later ones]"),
    ("relight_nodraw_others", "  others [mips built here, asked]"),
    ("relight_nodraw_eff", "  parallel efficiency [busy share]"),
    ("relight_nodraw_overhead", "  stripes' kernel / one job's"),
    ("relight_nodraw_job", "  one job (stripes 0) [blocked, landed]"),
    ("relight_draw", "a light moved, released [blocked, landed]"),
    ("relight_draw_kernel", "  kernel ms summed [slowest job]"),
    ("relight_draw_first", "  first stripe a worker ms [later ones]"),
    ("relight_draw_others", "  others [mips built here, asked]"),
    ("relight_draw_eff", "  parallel efficiency [busy share]"),
    ("relight_draw_overhead", "  stripes' kernel / one job's"),
    ("relight_draw_job", "  one job (stripes 0) [blocked, landed]"),
]


def derive(r):
    """The named rows' efficiency for a run of the first harness (it computed it for the *_rep rows only): the one-job
    route's summed kernel ms / (the stripes' workers x the named row's wall), as perf_test.py's `efficiency` does now."""
    for key in ("relight_one", "relight_three", "relight_sun"):
        a, wk, ka, kb = r.get(key), r.get(key + "_workers"), r.get(key + "_kernel"), r.get(key + "_job_kernel")
        if key + "_eff" in r or not (a and a[1] and wk and kb and kb[0]):
            continue
        r[key + "_eff"] = [round(kb[0] / (wk * a[1]), 3), r.get(key + "_busy")]
        if ka:
            r[key + "_overhead"] = round(ka[0] / kb[0], 3)
    return r


def runs(d):
    out = []
    for f in sorted(glob.glob(os.path.join(d, "perf", "r*.json"))):
        out.append(derive(json.load(open(f, encoding="utf-8"))[0]))
    return out


def cell(vals):
    vals = [v for v in vals if isinstance(v, (int, float))]
    if not vals:
        return "-"
    m = statistics.median(vals)
    if all(float(v).is_integer() for v in vals) and float(m).is_integer():
        return f"{m:,.0f} [{min(vals):,.0f}-{max(vals):,.0f}]" + ("" if len(vals) == 3 else f" (n={len(vals)})")
    f = (lambda x: f"{x:,.3f}") if max(abs(v) for v in vals) < 2 else (lambda x: f"{x:,.1f}") if max(abs(v) for v in vals) < 100 else (lambda x: f"{x:,.0f}")
    return f"{f(m)} [{f(min(vals))}-{f(max(vals))}]" + ("" if len(vals) == 3 else f" (n={len(vals)})")


def series(rs, key):
    """[[run values of part 0], [part 1], ...] for a row (a scalar is one part)."""
    vals = [r.get(key) for r in rs]
    parts = max((len(v) if isinstance(v, list) else 1) for v in vals if v is not None) if any(v is not None for v in vals) else 0
    return [[(v[i] if isinstance(v, list) and i < len(v) else (v if not isinstance(v, list) and i == 0 else None)) for v in vals] for i in range(parts)]


def main():
    dirs = [os.path.join(HERE, a) if not os.path.isabs(a) else a for a in sys.argv[1:]] or [os.path.join(HERE, "before")]
    sets = [runs(d) for d in dirs]
    print("%-52s" % "row (15000 x 10000, relight, map 4096 x 2731)" + "".join("%30s" % os.path.basename(d) for d in dirs))
    for key, label in ROWS:
        cols = [series(rs, key) for rs in sets]
        parts = max(len(c) for c in cols)
        for i in range(parts):
            name = label if parts == 1 else f"{label} [{i}]"
            print("%-52s" % name + "".join("%30s" % (cell(c[i]) if i < len(c) else "-") for c in cols))
    for d, rs in zip(dirs, sets):
        print(f"{os.path.basename(d)}: {len(rs)} runs; focus {[r.get('focus') for r in rs]}")


if __name__ == "__main__":
    main()
