#!/usr/bin/env python3
"""A per-row comparison of two measurement runs of the W0b chain (w0b_chain.sh, three rounds plus once/).

Usage: python docs/measurements/k40_2026-11-10/compare.py  [--stdout]

Baseline: ../w0b_2026-10-23 (249d882, 2026-10-23). New: this folder (db2c39da, 2026-11-10). Reads only the raw JSON and
log files of the two folders; writes summary.txt next to this script (--stdout prints it instead).

A row's value is its median over the rounds r1-r3, with (min-max) over the three. Rows are named
"group | row | metric". Classification over the three runs of each side:
  WIN   new max < old min       LOSS  new min > old max       TIE   the spreads overlap
  N/C   not comparable: the harness or the row's meaning changed since 2026-10-23 (the reason is printed).
Rows with fewer than three runs on either side are "n<3" and are not classified.
docperf, mem and huge ran once on each side: they are printed plainly, no classification.
"""
import json
import os
import re
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
NEW = HERE
OLD = os.path.normpath(os.path.join(HERE, "..", "w0b_2026-10-23"))
ROUNDS = ("r1", "r2", "r3")
OLD_NAME, NEW_NAME = "w0b_2026-10-23", "k40_2026-11-10"


# ---------------------------------------------------------------------------------------------------- reading
def read(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def load_json(path):
    return json.loads(read(path))


def isnum(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


class Rounds:
    """One side's rows: rows[key][round] = value; focus[key][round] = bool for rows whose log says it."""

    def __init__(self):
        self.rows = {}
        self.focus = {}
        self.problems = []

    def put(self, key, rnd, value, focus=None):
        if not isnum(value):
            return
        self.rows.setdefault(key, {})[rnd] = float(value)
        if focus is not None:
            self.focus.setdefault(key, {})[rnd] = bool(focus)


# ---- native_test: wall and blocked per row, per instance
def native(side, root, rnd):
    for inst in ("default", "filter", "k0a"):
        p = os.path.join(root, rnd, "native", inst + ".json")
        if not os.path.exists(p):
            side.problems.append(f"missing {p}")
            continue
        for name, entry in load_json(p).get("rows", {}).items():
            r = entry.get("row") if isinstance(entry, dict) else None
            if not isinstance(r, dict):
                continue
            if r.get("error") or r.get("skipped"):
                side.problems.append(f"{rnd} native {inst} {name}: {r.get('error') or r.get('skipped')}")
                continue
            group = f"native/{inst}"
            f = r.get("focused")
            if name == "build_the_file":
                side.put((group, name, "fillMs"), rnd, r.get("fillMs"))
                side.put((group, name, "encodeMs"), rnd, r.get("encodeMs"))
                continue
            side.put((group, name, "wall"), rnd, r.get("wall"), f)
            side.put((group, name, "blk"), rnd, r.get("blocked"), f)


# ---- perf_test: the printed table, sections with their own meaning of "a [b]"
# label of an indented line -> (name of a or None, name of b or None); counts and MB are not time rows
SUB = [
    (re.compile(r"mips settled \[longest block\]"), ("settled", "longest block")),
    (re.compile(r"^chains "), (None, None)),
    (re.compile(r"mirrors made"), (None, None)),
    (re.compile(r"\(the level of fit"), (None, None)),
    (re.compile(r"below stats redone"), (None, None)),
    (re.compile(r"\(relight: waited"), ("waited", None)),
    (re.compile(r"its landings: re-runs"), (None, "longest block until settled")),
    (re.compile(r"marches \[slowest landed\]"), (None, "slowest landed")),
    (re.compile(r"frames \[shadows landed\]"), (None, "shadows landed")),
    (re.compile(r"block \[chains built here\]"), ("block", None)),
    (re.compile(r"block \[built, asked, marching\]"), (None, None)),
    (re.compile(r"stripes \[workers\]"), (None, None)),
    (re.compile(r"others \[built"), (None, None)),
    (re.compile(r"efficiency"), (None, None)),
    (re.compile(r"stripes' kernel"), (None, None)),
    (re.compile(r"gaps \[from the step"), (None, None)),
    (re.compile(r"landings \[from the step"), (None, None)),
    (re.compile(r"kernel ms \[slowest job\]"), ("kernel sum", "slowest job")),
    (re.compile(r"first stripe ms \[later\]"), ("first stripe", "later")),
    (re.compile(r"no march: wait first|8 NORMAL"), (None, None)),
]
SECTION_METRICS = {
    "top": ("median", "max"),
    "operations, blocked [wall]": ("blk", "wall"),
    "C6 (c2), tiles only": ("value", "[bracket]"),
    "relight, blocked [landed]": ("blk", "landed"),
}
# the rows of a section whose "a [b]" is not the section's; read in tools/perf_test.py (op() = [blocked, wall], bench() =
# [median, max], the first-frame rows = [first, settled or worst])
ROW_METRICS = [
    (re.compile(r"^(pan at fit, masked filter layer|pan at 1:1 over it)$"), ("median", "max")),
    (re.compile(r"^peek at "), ("first frame", "first frame (again)")),
    (re.compile(r"^move drag at fit"), ("first", "worst of 5")),
    (re.compile(r"^(matched masked layer, fit: first|the same at 1:1: first)"), ("first", "settled")),
    (re.compile(r"^(eyedropper over it|magic wand over it)$"), ("blk", "wall")),
    (re.compile(r"^pan at 1:1 during a march$"), ("frame median", "frame max")),
]
LINE = re.compile(r"^(?P<ind>\s*)(?P<label>\S.*?)\s+(?P<a>-|\d[\d.]*)\s*(?P<ua>ms|MB)?(?:\s+\[(?P<b>[^\]]*)\])?\s*$")


def perf_log(side, path, group, rnd):
    if not os.path.exists(path):
        side.problems.append(f"missing {path}")
        return
    lines = read(path).splitlines()
    section, stack = None, []
    for i, line in enumerate(lines):
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        if nxt.startswith("-----"):
            name = line.strip()
            section = "top" if re.fullmatch(r"\d+x\d+", name) else name
            stack = []
            continue
        if section is None or line.startswith("-----") or not line.strip():
            continue
        if re.match(r"\d+x\d+\s", line):
            section = None   # the closing lines of a table
            continue
        m = LINE.match(line)
        if not m:
            continue
        ind, label = len(m.group("ind")), m.group("label")
        names = SECTION_METRICS.get(section, ("value", "[bracket]"))
        for rx, row_names in ROW_METRICS:
            if rx.search(label):
                names = row_names
                break
        if ind:
            for rx, sub in SUB:
                if rx.search(label):
                    names = sub
                    break
        while stack and stack[-1][0] >= ind:
            stack.pop()
        path_label = " > ".join([s[1] for s in stack] + [label])
        stack.append((ind, label))
        a, b = m.group("a"), m.group("b")
        if names[0] and a != "-" and m.group("ua") != "MB":
            side.put((group, path_label, names[0]), rnd, float(a))
        if names[1] and b is not None:
            mb = re.match(r"\s*(\d[\d.]*)\s*(ms)?\s*$", b)
            if mb:
                side.put((group, path_label, names[1]), rnd, float(mb.group(1)))


# ---- export_test --perf: a JSON document on stdout
def export_log(side, path, group, rnd):
    if not os.path.exists(path):
        side.problems.append(f"missing {path}")
        return
    s = read(path)
    i = s.find("{")
    if i < 0:
        side.problems.append(f"no JSON in {path}")
        return
    d, _ = json.JSONDecoder().raw_decode(s[i:])
    focus = d.get("focused")
    for sec, keys in (("composite_bands", ("ms", "blocked")), ("layer_from_tiles", ("ms", "blocked")),
                      ("composite_canvas", ("ms", "blocked")), ("layer_canvas", ("ms", "blocked")),
                      ("psd", ("ms", "blocked")), ("psd_masked", ("ms", "blocked")),
                      ("fill_limit_rows", ("ms", "fill", "limit")),
                      ("psd_fill_limit", ("ms", "blocked", "fillRowsMs"))):
        v = d.get(sec)
        if isinstance(v, dict):
            for k in keys:
                side.put((group, sec, {"ms": "wall", "blocked": "blk"}.get(k, k)), rnd, v.get(k), focus)


# ---- tiffperf: "[ok] variant x: {json}"
def tiff_log(side, path, variant, rnd):
    if not os.path.exists(path):
        side.problems.append(f"missing {path}")
        return
    m = re.search(r"\[ok\] variant \w+: (\{.*\})\s*$", read(path), re.M)
    if not m:
        side.problems.append(f"no variant line in {path}")
        return
    d = json.loads(m.group(1))
    f = d.get("focused")
    for k, name in (("openMs", "open"), ("exportMs", "export"), ("pngOpenMs", "same picture as PNG, open"),
                    ("jpgOpenMs", "same picture as JPEG, open")):
        side.put(("tiffperf", variant, name), rnd, d.get(k), f)


# ---- px_jobs: one line per job, each its own median of three inner rounds
def pxjobs_log(side, path, rnd):
    if not os.path.exists(path):
        side.problems.append(f"missing {path}")
        return
    s = read(path)
    mf = re.search(r"window focused (\w+)", s)
    focus = mf.group(1) == "True" if mf else None
    for line in s.splitlines():
        m = re.match(r"\s{2}(\w+)\s+(kernel js|worker job js|wall js)", line)
        if not m:
            continue
        job = m.group(1)
        for label, name in (("kernel js", "kernel"), ("worker job js", "worker job"), ("wall js", "wall")):
            mm = re.search(re.escape(label) + r"\s+([\d.]+)\s+rust\s+([\d.]+)", line)
            if mm:
                side.put(("px_jobs", job, f"{name} JS"), rnd, float(mm.group(1)), focus)
                side.put(("px_jobs", job, f"{name} Rust"), rnd, float(mm.group(2)), focus)


# ---- selection_test
def selection_log(side, path, rnd):
    if not os.path.exists(path):
        side.problems.append(f"missing {path}")
        return
    for m in re.finditer(r"range (\w+) \d+x\d+: selectRange ([\d.]+) ms \(wall ([\d.]+) ms\)", read(path)):
        side.put(("selection", f"range {m.group(1)}", "selectRange"), rnd, float(m.group(2)))
        side.put(("selection", f"range {m.group(1)}", "wall"), rnd, float(m.group(3)))


# ---- edges: the gate's one timed line
def edges_log(side, path, rnd):
    if not os.path.exists(path):
        side.problems.append(f"missing {path}")
        return
    m = re.search(r"15k select_range: (\d+) ms", read(path))
    if m:
        side.put(("edges", "15k select by depth, snap 50", "wall"), rnd, float(m.group(1)))


# ---- w0_bench
def med(v):
    return v.get("median") if isinstance(v, dict) else None


def bench(side, root, rnd):
    def J(name):
        p = os.path.join(root, rnd, "bench", name + ".json")
        if not os.path.exists(p):
            side.problems.append(f"missing {p}")
            return {}
        return load_json(p)

    g = "w0_bench"
    w0 = J("w0_rows")
    for row, keys in (("edgefit_2048", ("fit", "warp", "coverage")),
                      ("stitch_masks_2048", ("gauss", "dilate", "max_clamp", "mk")),
                      ("crc32_64mb", ("crc", "js")),
                      ("dabs_256", ("blur", "sharpen", "tone", "sponge")),
                      ("match_loop_4096", ("loop",)),
                      ("histogram_depth", ("hist",))):
        d = w0.get(row)
        if not isinstance(d, dict):
            continue
        for k in keys:
            side.put((g, row, k), rnd, med(d.get(k)), d.get("focus"))
    d = w0.get("edgefit_2048") or {}
    for k, v in (d.get("fit_laps") or {}).items():
        side.put((g, "edgefit_2048", f"fit lap {k}"), rnd, v, d.get("focus"))
    d = w0.get("freqsep_15k") or {}
    for k in ("load_jpg", "png_export", "png_open", "freqsep_16mp"):
        side.put((g, "freqsep_15k", k), rnd, d.get(k), d.get("focus"))
    k0 = J("k0a_rows")
    d = k0.get("files_15k") or {}
    f = d.get("focus")
    side.put((g, "files_15k", "load_jpg"), rnd, d.get("load_jpg"), f)
    side.put((g, "files_15k", "png wall"), rnd, (d.get("png") or {}).get("wall"), f)
    side.put((g, "files_15k", "tiff wall"), rnd, (d.get("tiff") or {}).get("wall"), f)
    d = k0.get("jpeg_open_15k") or {}
    side.put((g, "jpeg_open_15k", "wall"), rnd, d.get("wall"), d.get("focus"))
    d = k0.get("png_inflate_15k") or {}
    for k in ("whole", "parts_1_worker", "parts_pool"):
        side.put((g, "png_inflate_15k", f"{k} wall"), rnd, (d.get(k) or {}).get("wall"), d.get("focus"))
    d = k0.get("png_filter_types") or {}
    side.put((g, "png_filter_types", "wall"), rnd, d.get("wall"), d.get("focus"))
    d = k0.get("tiff_inflate_15k") or {}
    for k in ("one_worker", "pool"):
        side.put((g, "tiff_inflate_15k", f"{k} wall"), rnd, (d.get(k) or {}).get("wall"), d.get("focus"))
    d = k0.get("tiff_rows_256") or {}
    side.put((g, "tiff_rows_256", "wall"), rnd, d.get("wall"), d.get("focus"))

    d = J("freqsep_4000").get("freqsep_4000") or {}
    side.put((g, "freqsep_4000", "wall"), rnd, d.get("wall"), d.get("focus"))
    side.put((g, "freqsep_4000", "blk"), rnd, d.get("blocked"), d.get("focus"))
    for size in ("2048", "4096"):
        d = J("stitch_align_" + size).get("stitch_align_" + size) or {}
        for part in ("prepare", "worker", "window"):
            v = d.get(part) or {}
            side.put((g, f"stitch_align_{size} {part}", "wall"), rnd, v.get("wall"), d.get("focus"))
            side.put((g, f"stitch_align_{size} {part}", "blk"), rnd, v.get("blocked"), d.get("focus"))
    d = J("match_fallback_16k").get("match_fallback_16k") or {}
    c = d.get("cpu") or {}
    side.put((g, "match_fallback_16k", "wall = blk"), rnd, c.get("median"), d.get("focus"))
    d = J("grow_fallback_15k").get("grow_fallback_15k") or {}
    for step in d.get("steps") or []:
        s = "x".join(str(x) for x in step.get("size") or [])
        for k in ("growMask", "growMaskBounds"):
            v = step.get(k)
            if isinstance(v, dict):
                side.put((g, f"grow_fallback {s}", k), rnd, v.get("wall"))


# ---- brush_perf
def brush(side, root, rnd):
    for tool in ("blur", "sharpen", "tone", "sponge", "smudge", "clone", "heal"):
        p = os.path.join(root, rnd, "brush", tool + ".json")
        if not os.path.exists(p):
            side.problems.append(f"missing {p}")
            continue
        d = load_json(p)
        f = d.get("focused")
        for r in d.get("rows") or []:
            if not isinstance(r, dict) or r.get("error"):
                continue
            name = f"{r.get('tool')} {r.get('sample')} {r.get('size')} px {r.get('view')}" + (" cold" if r.get("cold") else "")
            g = "brush"
            side.put((g, name, "move median"), rnd, (r.get("move") or {}).get("med"), f)
            side.put((g, name, "move worst"), rnd, (r.get("move") or {}).get("worst"), f)
            side.put((g, name, "dab median"), rnd, (r.get("dab") or {}).get("med"), f)
            side.put((g, name, "blockedMax"), rnd, (r.get("blocked") or {}).get("max"), f)


# ---- liquify_perf
def liquify(side, root, rnd):
    for k in ("rust", "js"):
        p = os.path.join(root, rnd, "liquify", k + ".json")
        if not os.path.exists(p):
            side.problems.append(f"missing {p}")
            continue
        d = load_json(p)
        for r in d.get("rows") or []:
            if not isinstance(r, dict) or not r.get("row"):
                continue
            g = f"liquify/{k}"
            name = r["row"]
            side.put((g, name, "land"), rnd, r.get("land"))
            side.put((g, name, "blockedMax"), rnd, r.get("blockedMax"))
            side.put((g, name, "ms"), rnd, r.get("ms"))
            for part in ("dab", "frame", "preview", "tick"):
                v = r.get(part)
                if isinstance(v, dict):
                    side.put((g, name, f"{part} p50"), rnd, v.get("p50"))
                    side.put((g, name, f"{part} worst"), rnd, v.get("worst"))


def read_side(root):
    side = Rounds()
    for rnd in ROUNDS:
        native(side, root, rnd)
        gates = os.path.join(root, rnd, "gates", "gates")
        perf_log(side, os.path.join(gates, "perf", "perf.log"), "perf", rnd)
        perf_log(side, os.path.join(gates, "perf-relight", "perf.log"), "perf-relight", rnd)
        export_log(side, os.path.join(gates, "exportperf-limit", "exportperf.log"), "exportperf/limit", rnd)
        export_log(side, os.path.join(gates, "exportperf-fill", "exportperf.log"), "exportperf/fill", rnd)
        edges_log(side, os.path.join(gates, "edges", "console.log"), rnd)
        for v in ("noise", "own", "lzw", "packbits", "zlib1", "raw"):
            tiff_log(side, os.path.join(gates, "tiff-" + v, "tiffperf.log"), v, rnd)
        pxjobs_log(side, os.path.join(root, rnd, "pxjobs_15k.log"), rnd)
        selection_log(side, os.path.join(root, rnd, "selection_15k.log"), rnd)
        bench(side, root, rnd)
        brush(side, root, rnd)
        liquify(side, root, rnd)
    return side


# ---------------------------------------------------------------------------------------------------- rows that do not compare
# (predicate on the key) -> reason. Each was read in the harness at 249d882 and 0d14b9eb, or in the baseline's own summary.
K12_WAIT = ("harness changed (K12, tools/perf_test.py `replaced`): the 30 ms wait now comes before the change, so the timed "
            "frame pays the chains it used to skip")
NC_RULES = [
    (lambda k: k[0] == "px_jobs" and k[1] in ("mips_direct", "mips_whole"),
     "baseline contaminated (its own summary: jobs queued before a kernel flip, JS rows counted Rust calls); K1a rebuilt the row"),
    (lambda k: k[0] in ("perf", "perf-relight") and k[1].startswith("frame after a whole change"), K12_WAIT),
    (lambda k: k[0] == "perf-relight" and k[1].startswith("192 px picture"),
     "baseline did different work per run (422 / 0.4 / 425); K12 pinned the active layer and tool in a relight run"),
    (lambda k: k[0] == "edges",
     "harness changed (tools/edges_test.py): the test's 15k depth map got a third band at x = 3500"),
    (lambda k: k[:3] == ("w0_bench", "stitch_masks_2048", "max_clamp"),
     "harness changed (tools/w0_bench.py): old = a copy of the JS loop, new = kernels.js maskMaxClamp"),
]
CONTROLS = [
    ("w0_bench", "match_loop_4096", "loop"),
]


def nc_reason(key):
    for pred, why in NC_RULES:
        if pred(key):
            return why
    return None


# ---------------------------------------------------------------------------------------------------- the numbers
def stats(rounds):
    vals = [rounds[r] for r in ROUNDS if r in rounds]
    return {"n": len(vals), "median": statistics.median(vals), "min": min(vals), "max": max(vals)} if vals else None


def classify(o, n):
    if o["n"] < 3 or n["n"] < 3:
        return "n<3"
    if n["max"] < o["min"]:
        return "WIN"
    if n["min"] > o["max"]:
        return "LOSS"
    return "TIE"


def fmt(x):
    if abs(x) >= 100:
        return f"{x:,.0f}"
    if abs(x) >= 10:
        return f"{x:.1f}"
    return f"{x:.2f}"


def span(s):
    return f"{fmt(s['median'])} ({fmt(s['min'])}-{fmt(s['max'])})"


def name(key):
    return " | ".join(key)


def ratio_text(o, n):
    return f"{n['median'] / o['median']:.2f}x" if o["median"] else "-"


def focus_flag(old, new, key):
    """'f' when the old side has an unfocused run on this row and the new side has none (a confound, see the top)."""
    of, nf = old.focus.get(key, {}), new.focus.get(key, {})
    return "f" if of and nf and any(v is False for v in of.values()) and all(nf.values()) else ""


# ---------------------------------------------------------------------------------------------------- self-check
# baseline medians as summary.txt of w0b_2026-10-23 gives them: the extraction must reproduce them
CHECK = [
    (("native/default", "open_the_file", "wall"), 3076), (("native/default", "open_the_file", "blk"), 497),
    (("native/default", "grow_16", "wall"), 491), (("native/default", "wand_whole_picture", "wall"), 1733),
    (("native/default", "bucket_fill", "wall"), 2885), (("native/default", "bucket_fill", "blk"), 1466),
    (("native/default", "export_png", "wall"), 1960), (("native/default", "export_ora", "wall"), 5028),
    (("native/k0a", "save_png", "wall"), 2560), (("native/k0a", "open_psd", "wall"), 12987),
    (("native/k0a", "open_psd", "blk"), 9796), (("native/k0a", "open_tiff", "wall"), 5906),
    (("perf", "full composite", "median"), 92), (("perf", "magic wand (whole-image band)", "wall"), 6628),
    (("perf-relight", "one light moved: landed", "landed"), 3813), (("perf-relight", "three lights moved", "landed"), 4525),
    (("exportperf/limit", "composite_bands", "wall"), 1586), (("exportperf/fill", "composite_bands", "wall"), 1658),
    (("exportperf/fill", "fill_limit_rows", "wall"), 9782), (("exportperf/fill", "psd_fill_limit", "wall"), 14287),
    (("tiffperf", "noise", "open"), 8713), (("tiffperf", "own", "export"), 2141), (("tiffperf", "lzw", "open"), 13690),
    (("px_jobs", "wand_band", "wall JS"), 3770), (("px_jobs", "wand_band", "wall Rust"), 2382),
    (("px_jobs", "band", "wall JS"), 152),
    (("selection", "range depth", "selectRange"), 1701), (("selection", "range luma", "selectRange"), 2445),
    (("w0_bench", "edgefit_2048", "fit"), 134), (("w0_bench", "crc32_64mb", "crc"), 104),
    (("w0_bench", "match_loop_4096", "loop"), 222), (("w0_bench", "freqsep_15k", "freqsep_16mp"), 2183),
    (("w0_bench", "files_15k", "png wall"), 2720), (("w0_bench", "files_15k", "tiff wall"), 1650),
    (("w0_bench", "stitch_align_2048 worker", "wall"), 938), (("w0_bench", "stitch_align_4096 worker", "wall"), 2895),
    (("w0_bench", "stitch_align_4096 window", "wall"), 3103), (("w0_bench", "match_fallback_16k", "wall = blk"), 242),
    (("w0_bench", "grow_fallback 15000x10000", "growMask"), 852),
    (("w0_bench", "grow_fallback 15000x10000", "growMaskBounds"), 665), (("w0_bench", "freqsep_4000", "wall"), 2213),
    (("brush", "blur layer 400 px fit", "move median"), 79), (("brush", "tone layer 1000 px 1:1", "move median"), 43),
    (("liquify/rust", "push fit size 1000", "land"), 142), (("liquify/rust", "push fit size 1000", "dab p50"), 18),
]


def self_check(old):
    bad, good = [], 0
    for key, want in CHECK:
        s = stats(old.rows.get(key, {}))
        got = s["median"] if s else None
        if got is None or abs(got - want) > max(1.0, want * 0.01):
            bad.append(f"  {name(key)}: summary.txt says {want}, the script read {got}")
        else:
            good += 1
    return good, bad


# ---------------------------------------------------------------------------------------------------- once/
def once_values(root):
    gates = os.path.join(root, "once", "gates", "gates")
    out = {}
    # docperf
    p = os.path.join(gates, "docperf", "docperf.log")
    if os.path.exists(p):
        for m in re.finditer(r"^(built|save|open): (\{.*\})\s*$", read(p), re.M):
            d = json.loads(m.group(2))
            for k, v in d.items():
                if isnum(v) and k.endswith("Ms"):
                    out[("docperf", m.group(1), k)] = v
    # mem: the table (rend MB, GPU MB per round / phase) and the target lines
    p = os.path.join(gates, "mem", "mem.log")
    targets = []
    if os.path.exists(p):
        s = read(p)
        for m in re.finditer(r"^(\d+)\s+(start|built|closed|gc|free)\s+([\d.]+)\s+([\d.]+)\s", s, re.M):
            out[("mem", f"round {m.group(1)} {m.group(2)}", "renderer MB")] = float(m.group(3))
            out[("mem", f"round {m.group(1)} {m.group(2)}", "GPU MB")] = float(m.group(4))
        targets = [ln.strip() for ln in s.splitlines() if re.search(r"(FAIL|PASS)\s*$", ln) and ("GPU process" in ln or "last round" in ln)]
    # huge: numeric leaves of each [ok] row
    p = os.path.join(gates, "huge", "huge.log")
    skip = re.compile(r"(arena|size|bbox|emitted|window|plan|MP$|bytes|tiles$|selTiles|closed|layers|/MB$|fileMB)")

    def leaves(o, path):
        if isinstance(o, dict):
            for k, v in o.items():
                yield from leaves(v, path + "/" + k if path else k)
        elif isinstance(o, list):
            for i, v in enumerate(o):
                yield from leaves(v, f"{path}[{i}]")
        elif isnum(o):
            yield path, o

    if os.path.exists(p):
        for m in re.finditer(r"^\[ok\] (\w+): (\{.*\})\s*$", read(p), re.M):
            for path, v in leaves(json.loads(m.group(2)), ""):
                if not skip.search(path):
                    out[("huge", m.group(1), path)] = v
    return out, targets


# ---------------------------------------------------------------------------------------------------- the report
def table_row(cls, key, o, n, flags=""):
    return f"{cls:5s} {ratio_text(o, n):>8s}  {span(o):>28s}  {span(n):>28s}  {name(key)}{('  [' + flags + ']') if flags else ''}"


def main():
    old, new = read_side(OLD), read_side(NEW)
    good, bad = self_check(old)

    matched, new_only, old_only, ncs = [], [], [], []
    for key in sorted(set(old.rows) | set(new.rows)):
        o, n = stats(old.rows.get(key, {})), stats(new.rows.get(key, {}))
        if o and n:
            why = nc_reason(key)
            if why:
                ncs.append((key, o, n, why))
            else:
                matched.append((key, o, n, classify(o, n), focus_flag(old, new, key)))
        elif o:
            old_only.append((key, o))
        else:
            new_only.append((key, n))

    losses = sorted([m for m in matched if m[3] == "LOSS"], key=lambda m: -(m[2]["median"] - m[1]["median"]))
    wins = [m for m in matched if m[3] == "WIN"]
    ties = [m for m in matched if m[3] == "TIE"]
    short = [m for m in matched if m[3] == "n<3"]

    # the largest wins: what a user waits for (wall, landing or the window blocked), one line per (row without its instance,
    # metric); worker sums, JS twins, laps and worst cases are in the full table
    def felt(m):
        k = m[0]
        if " > " in k[1] or k[2] in ("max", "move worst", "worst", "selectRange", "fill", "limit", "fillRowsMs") or k[2].endswith(" worst"):
            return False
        if k[0] == "px_jobs" and k[2] != "wall Rust":
            return False
        if k[2].startswith("fit lap"):
            return False
        return True

    felt_wins = [m for m in wins if felt(m)]
    seen, by_ms = set(), []
    for m in sorted(felt_wins, key=lambda m: -(m[1]["median"] - m[2]["median"])):
        base = (re.sub(r"^native/\w+", "native", m[0][0]), m[0][1], m[0][2])
        if base in seen:
            continue
        seen.add(base)
        by_ms.append(m)
    by_ratio = sorted([m for m in felt_wins if m[1]["median"] >= 100], key=lambda m: m[2]["median"] / m[1]["median"])

    out = []
    w = out.append
    w("K40: the W0b chain, baseline against wasm-kernels on 2026-11-10, K18 and K20b merged; K19 and K20c moved after the release.")
    w(f"New run:  {NEW_NAME}: 2026-11-10 12:47-15:13, commit db2c39da (wasm-kernels), offline, tiles, 15000 x 10000, the same")
    w("          chain script (w0b_chain.sh): three rounds r1-r3 and once/.")
    w(f"Baseline: {OLD_NAME}: 2026-10-23 13:00-14:21, commit 249d882, same chain.")
    w("The verdict on the loss rows is verdict.txt in this folder.")
    w("Written by compare.py in this folder (python compare.py); it reads only the raw JSON and log files of both folders.")
    w("")
    w("How to read a row: median of three runs (min-max), all ms. ratio = new median / old median. Row names: group | row | metric.")
    w("WIN = new max below old min; LOSS = new min above old max; TIE = the spreads overlap; N/C = not comparable (reason given).")
    w("Flags: [f] the baseline's run(s) of this row had the window unfocused and the new ones focused (V8 slows JS, not wasm, in an")
    w("unfocused window, so part of such a gain may be the focus; native_test, px_jobs and some bench / brush runs). The gates'")
    w("baseline logs carry no focus flag, so no such row can be flagged.")
    w("")
    w(f"Rows: {len(matched)} matched and classified ({len(wins)} WIN, {len(losses)} LOSS, {len(ties)} TIE, {len(short)} with fewer than three runs);")
    w(f"      {len(ncs)} present on both sides but not comparable (N/C); {len(old_only)} baseline rows with no new counterpart;")
    w(f"      {len(new_only)} new rows, no baseline.")
    flagged = [m for m in matched if m[4]]
    w(f"      {len(flagged)} matched rows carry the focus flag [f] ({sum(1 for m in flagged if m[3] == 'WIN')} of them WIN).")
    w(f"Self-check: {good} of {len(CHECK)} baseline medians as summary.txt of the baseline states them reproduced by the extraction.")
    for b in bad:
        w(b)
    probs = old.problems + new.problems
    if probs:
        w("Problems while reading:")
        for p in probs:
            w("  " + p)
    w("")
    w("Control (a JS loop copied into the harness, no app code in it; it should not move):")
    for key in CONTROLS:
        o, n = stats(old.rows[key]), stats(new.rows[key])
        w(f"  {name(key)}: {span(o)} -> {span(n)}, {ratio_text(o, n)}")
    k = ("w0_bench", "crc32_64mb", "js")
    w("  crc32 JS on the new side (the twin): " + (span(stats(new.rows[k])) if k in new.rows else "-")
      + "; the baseline's only crc row was JS: " + span(stats(old.rows[("w0_bench", "crc32_64mb", "crc")])))
    w("")
    w("px_test PX_BENCH=large (once/px_bench_large.log) is not compared: Node kernel rows, the baseline's summary says it explains and")
    w("never decides. The new run of it ended rc=1 on two checks, both 'a pointer above 2 GB is usable' (rust simd ptr 26193920,")
    w("rust scalar ptr 1983623168; the baseline passed them with ptr 2203238400): a check of px_test, not a timing row.")
    w("")

    w(f"== LOSS rows ({len(losses)}; largest ms lost first)")
    w(f"{'':5s} {'ratio':>8s}  {'old median (min-max)':>28s}  {'new median (min-max)':>28s}  row")
    for m in losses:
        w(table_row(m[3], m[0], m[1], m[2], m[4]))
    w("")
    w("== Largest wins by ms saved (felt rows only: wall, landing or blk; no worker sums, JS twins, laps; one line per row)")
    for m in by_ms[:15]:
        w(table_row(m[3], m[0], m[1], m[2], m[4]) + f"   saves {fmt(m[1]['median'] - m[2]['median'])}")
    w("")
    w("== Largest wins by ratio (felt rows with an old median of at least 100 ms)")
    for m in by_ratio[:15]:
        w(table_row(m[3], m[0], m[1], m[2], m[4]))
    w("")
    w(f"== N/C: present on both sides, not comparable ({len(ncs)}), not classified")
    last = None
    for key, o, n, why in ncs:
        if why != last:
            w("  -- " + why)
            last = why
        w(f"N/C   {ratio_text(o, n):>8s}  {span(o):>28s}  {span(n):>28s}  {name(key)}")
    w("")
    w(f"== Baseline rows that could not be matched ({len(old_only)})")
    for key, o in old_only:
        w(f"  {name(key)}: old {span(o)}")
    w("  Beyond these, the baseline summary's indented laps and worker sums (png_read, encoded / saved, tiff_read's parts, the")
    w("  jobs' CPU sums, the K0b counts) are explanations, not rows, and are not extracted; save_psd ran on neither side.")
    w("")

    w("== All matched rows, by group")
    w(f"{'':5s} {'ratio':>8s}  {'old median (min-max)':>28s}  {'new median (min-max)':>28s}  row")
    group = None
    for m in matched:
        if m[0][0] != group:
            group = m[0][0]
            w("")
            w(f"-- {group}")
        w(table_row(m[3], m[0], m[1], m[2], m[4]))
    w("")

    w(f"== New rows, no baseline ({len(new_only)})")
    group = None
    for key, n in new_only:
        if key[0] != group:
            group = key[0]
            w(f"-- {group}")
        w(f"  {name(key)}: {span(n)}")
    w("")

    oo, ot = once_values(OLD)
    no, nt = once_values(NEW)
    w("== Once: one run on each side, no classification (ms unless named)")
    w(f"{'old':>12s} {'new':>12s}  row")
    for key in sorted(set(oo) | set(no)):
        a, b = oo.get(key), no.get(key)
        w(f"{(fmt(a) if a is not None else '-'):>12s} {(fmt(b) if b is not None else '-'):>12s}  {name(key)}")
    w("mem's targets, old:")
    for t in ot:
        w("  " + t)
    w("mem's targets, new:")
    for t in nt:
        w("  " + t)
    text = "\n".join(out) + "\n"
    if "--stdout" in sys.argv:
        sys.stdout.write(text)
    else:
        with open(os.path.join(HERE, "summary.txt"), "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        print(f"wrote summary.txt: {len(matched)} matched, {len(wins)} WIN, {len(losses)} LOSS, {len(ties)} TIE; "
              f"{len(ncs)} N/C, {len(old_only)} unmatched, {len(new_only)} new; self-check {good}/{len(CHECK)}")


if __name__ == "__main__":
    main()
