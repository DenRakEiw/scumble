"""The editor gate in shards: plan the groups and check what the shards ran (docs/TESTING.md "The editor gate in shards").

    python tools/editor_shards.py units                      # the steps that must stay together, and why
    python tools/editor_shards.py plan N --backend tiles|canvas [--logs DIR] [--out PLAN.json]
    python tools/editor_shards.py check PLAN.json LOG [LOG ...]

No app is needed. tools/run_gates_both.sh --shards N calls `plan` once per backend, runs each group as the editor gate
with SCUMBLE_EDITOR_ONLY on its own instance, then `check` on the groups' logs.

**plan** splits the gate's steps (tools/editor_test.py's STEPS, in their order) into N groups of consecutive steps with
about equal time. Every group runs the gate's first step (it opens the test document, `window.__t`) and its cleanup as
well, as SCUMBLE_EDITOR_ONLY does. The groups are runs of consecutive steps on purpose: each step keeps the step before it
that it has in the full run, except the first step of a group, which follows the gate's first step instead. Steps that
share state are never split (see `units`). The step times come from the newest editor gate logs under DIR (the
`[ok] name: ... [12.3 s]` lines and the `backend:` line, so a tiles plan reads tiles runs); a step without a time gets
the median, and with no timed log at all the groups get equal counts. One line per group goes to stdout (the step names,
comma-separated, without the first step and the cleanup), the reasoning to stderr, the plan as JSON to --out.

**units**: a step that reads a `window.__name` global it does not write itself depends on the last step before it that
writes it, and the two and every step between them form one unit that stays in one group (`window.__t2` of
copy_paste_a_layer_into_another_tab, read by duplicate_button_in_the_layer_row, for example). Found by reading the steps'
sources: a JS step's string, a Python step's functions and the module strings they use, nested code included. EXEMPT
lists the globals every group has anyway; EXTRA_CHAINS takes a dependency the rule does not show: a step that reads an
earlier step's global and then resets it (61-63, window.__droppedPixels), or one that no global shows at all (none known
on 2026-11-08: the steps that change settings, localStorage or a recipe put them back, and every other step opens a
document of its own or starts with new_canvas on the test document). The cleanup reads the documents of earlier steps
but closes only those that exist, so it depends on none.

**check** reads each group's log and passes only when every group passed, every step of the gate ran exactly once over
all groups (the first step and the cleanup once in each), and each group ran exactly the steps it was planned with, on
the plan's backend; it names every step that is missing, ran twice, failed, or ran in another group than planned, and
every group on another backend or without a backend: line. (run_gates_both.sh adds each group's exit code.)
"""
import glob
import json
import os
import re
import statistics
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# globals every group has: the first step opens the test document and runs in every group; run_all sets the others
EXEMPT = {
    "__t": "the first step opens the test document; every group runs the first step",
    "__exportPath": "run_all sets it before the first step",
    "__host": "run_all", "__cmds": "run_all", "__log": "tools/cdp.py's console hook",
}
# (first step, last step, why): a dependency the rule in units() does not show; the steps from first to last stay in one
# group. The rule links a read only to a global the reading step does not write itself, so a step that reads an earlier
# step's global and then resets it is not found by it (counting every read-then-write would tie the prompt field steps
# 108-117 together, which each set window.__pf / __pfPane themselves before they read them)
EXTRA_CHAINS = [
    ("pixels_nothing_draws_get_no_display_mirror", "the_screen_draws_no_cpu_mirror_and_stale_textures_leave",
     "window.__droppedPixels / __heldDisplay: the first writes them, the second reads them (deref) and then sets them "
     "to null, a read-then-reset the rule does not count (window.__dc ties the two as well today)"),
]
ALWAYS_LAST = "cleanup"

OK = re.compile(r"^\[ok\] ([A-Za-z0-9_]+): .*?(?: \[(\d+(?:\.\d+)?) s\])?$")
BAD = re.compile(r"^\[FAIL\] ([A-Za-z0-9_]+)\b")
BACKEND = re.compile(r"^backend: (tiles|canvas|unknown)\b")
VERDICT = re.compile(r"^(PASS|FAIL)\b")
STEP_SECONDS = re.compile(r"^backend: \w+, (\d+(?:\.\d+)?) s in the steps")


def load_steps():
    import editor_test
    return editor_test.STEPS


def step_names():
    return [n for n, _ in load_steps()]


# --- the steps' sources --------------------------------------------------------------------------------------------

OWN_MODULES = {"editor_test", "prompt_field_steps", "ref_picker_steps"}


def _code_names(code):
    names = set(code.co_names)
    for k in code.co_consts:
        if isinstance(k, types.CodeType):
            names |= _code_names(k)
    return names


def _source_of(fn, seen):
    """A Python step's text: its own source, and that of every function and module string of the gate's modules it
    reaches (through its names, nested functions' names and its closure)."""
    import inspect
    if id(fn) in seen:
        return ""
    seen.add(id(fn))
    try:
        parts = [inspect.getsource(fn)]
    except (OSError, TypeError):
        parts = []
    reach = [fn.__globals__.get(n) for n in _code_names(fn.__code__)]
    reach += [c.cell_contents for c in (fn.__closure__ or ())]
    for v in reach:
        if isinstance(v, types.FunctionType) and v.__module__ in OWN_MODULES:
            parts.append(_source_of(v, seen))
        elif isinstance(v, str) and id(v) not in seen and "window." in v:
            seen.add(id(v))
            parts.append(v)
    return "\n".join(parts)


def step_sources():
    return [(n, _source_of(b, set()) if callable(b) else b) for n, b in load_steps()]


WRITE = re.compile(r"window\.(__[A-Za-z0-9_]+)\s*=(?!=)")
READ = re.compile(r"window\.(__[A-Za-z0-9_]+)")


def units():
    """[(first index, last index, [reasons])]: consecutive steps that must stay in one group."""
    src = step_sources()
    names = [n for n, _ in src]
    writes = [set(WRITE.findall(s)) for _, s in src]
    reads = [set(READ.findall(s)) for _, s in src]
    links = {}   # (writer, global) -> [readers]
    for j, (name, _) in enumerate(src):
        if j == 0 or name == ALWAYS_LAST:
            continue
        for g in sorted(reads[j] - writes[j]):
            if g in EXEMPT:
                continue
            ws = [i for i in range(j) if g in writes[i]]
            if not ws:
                raise SystemExit("editor_shards: %s reads window.%s, which no earlier step writes: add it to EXEMPT "
                                 "with the reason every group has it, or fix the step" % (name, g))
            links.setdefault((ws[-1], g), []).append(j)
    spans = [(i, max(rs), "window.%s: %s writes it, %s read%s it" % (g, names[i], ", ".join(names[r] for r in rs), "" if len(rs) > 1 else "s"))
             for (i, g), rs in links.items()]
    for first, last, why in EXTRA_CHAINS:
        spans.append((names.index(first), names.index(last), why))
    # merge overlapping spans into units
    out = []
    for i, j, why in sorted(spans):
        if out and i <= out[-1][1]:
            a, b, ws = out[-1]
            out[-1] = (a, max(b, j), ws + [why])
        else:
            out.append((i, j, [why]))
    return out


# --- the step times from earlier logs ------------------------------------------------------------------------------

def read_log(path):
    """{"backend", "ok": [(name, secs|None)], "failed": [names], "verdict", "steps_s", "lines"}"""
    out = {"backend": None, "ok": [], "failed": [], "verdict": None, "steps_s": None}
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except OSError:
        return None
    for line in lines:
        m = OK.match(line)
        if m:
            out["ok"].append((m.group(1), float(m.group(2)) if m.group(2) else None))
            continue
        m = BAD.match(line)
        if m:
            out["failed"].append((m.group(1), line[:300]))
            continue
        m = BACKEND.match(line)
        if m:
            out["backend"] = m.group(1)
            s = STEP_SECONDS.match(line)
            out["steps_s"] = float(s.group(1)) if s else None
            continue
        m = VERDICT.match(line)
        if m:
            out["verdict"] = line.strip()
    return out


def step_times(logs_dir, backend, names, newest=40):
    """{name: seconds} from the newest timed editor logs of that backend under logs_dir (each step's newest time)."""
    if not logs_dir or not os.path.isdir(logs_dir):
        return {}, []
    paths = glob.glob(os.path.join(logs_dir, "*", "editor.log"))
    paths.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    times, used = {}, []
    for p in paths[:newest * 3]:
        log = read_log(p)
        if not log or log["backend"] != backend:
            continue
        got = 0
        for name, secs in log["ok"]:
            if secs is not None and name in names and name not in times:
                times[name] = secs
                got += 1
        if got:
            used.append(p)
        if len(used) >= newest or len(times) == len(names):
            break
    return times, used


# --- the plan ------------------------------------------------------------------------------------------------------

def partition(weights, n):
    """Split a list of weights into n consecutive runs, the largest run sum as small as it can be, and among those the
    most even (the smallest sum of squares): [(start, end)]."""
    k = len(weights)
    n = max(1, min(n, k))
    pre = [0.0]
    for w in weights:
        pre.append(pre[-1] + w)
    INF = float("inf")

    def solve(cost, limit):
        # best[p][i]: the cost of the first i weights in p runs, no run above limit
        best = [[INF] * (k + 1) for _ in range(n + 1)]
        cut = [[0] * (k + 1) for _ in range(n + 1)]
        best[0][0] = 0.0
        for p in range(1, n + 1):
            for i in range(p, k + 1):
                for s in range(p - 1, i):
                    run = pre[i] - pre[s]
                    if run > limit or best[p - 1][s] == INF:
                        continue
                    v = cost(best[p - 1][s], run)
                    if v < best[p][i]:
                        best[p][i], cut[p][i] = v, s
        runs, i = [], k
        for p in range(n, 0, -1):
            s = cut[p][i]
            runs.append((s, i))
            i = s
        return best[n][k], runs[::-1]

    top, _ = solve(max, INF)
    _, runs = solve(lambda acc, run: acc + run * run, top + 1e-9)
    return runs


def plan(n, backend, logs_dir):
    names = step_names()
    first, last = names[0], ALWAYS_LAST
    body = list(range(1, len(names)))
    body.remove(names.index(last))
    us = units()
    # the atoms: a unit, or a single step of the body
    atoms, i = [], 1
    by_start = {a: (a, b, why) for a, b, why in us}
    while i < len(names):
        if names[i] == last:
            i += 1
            continue
        if i in by_start:
            a, b, why = by_start[i]
            atoms.append(list(range(a, b + 1)))
            i = b + 1
        else:
            atoms.append([i])
            i += 1
    times, used = step_times(logs_dir, backend, set(names))
    known = [times[names[i]] for i in body if names[i] in times]
    if known:
        med = statistics.median(known)
        w = {i: times.get(names[i], med) for i in body}
        basis = "the times of %d of %d steps from %d log(s) of %s runs, the newest %s%s" % (
            len(known), len(body), len(used), backend, used[0] if used else "-",
            "; the median %.1f s for the rest" % med if len(known) < len(body) else "")
    else:
        w = {i: 1.0 for i in body}
        basis = "no timed %s log under %s: equal counts" % (backend, logs_dir)
    aw = [sum(w[i] for i in a) for a in atoms]
    runs = partition(aw, n)
    heavy = max(range(len(atoms)), key=lambda a: aw[a])
    enough = max(1, int(-(-sum(aw) // aw[heavy])))   # ceil: past this many groups the heaviest unit is the floor
    if known and n > enough:
        basis += "; %s alone takes about %.0f s, so more than %d groups gain nothing" % (
            names[atoms[heavy][0]] if len(atoms[heavy]) == 1 else "the unit from " + names[atoms[heavy][0]],
            aw[heavy], enough)
    groups = []
    for s, e in runs:
        idx = [i for a in atoms[s:e] for i in a]
        groups.append({"steps": [names[i] for i in idx], "first": idx[0], "last": idx[-1],
                       "est_s": round(sum(w[i] for i in idx), 1)})
    return {
        "n": len(groups), "backend": backend, "basis": basis,
        "first_step": first, "cleanup": last, "all": names,
        "units": [{"from": names[a], "to": names[b], "why": why} for a, b, why in us],
        "groups": groups,
    }


# --- the check -----------------------------------------------------------------------------------------------------

def check(plan_obj, logs):
    names = plan_obj["all"]
    first, last = plan_obj["first_step"], plan_obj["cleanup"]
    groups = plan_obj["groups"]
    problems = []
    if len(logs) != len(groups):
        problems.append("%d logs for %d groups" % (len(logs), len(groups)))
    runs = {}   # name -> [group numbers it ran ok in]
    secs = []
    for g, path in enumerate(logs, 1):
        log = read_log(path)
        if log is None:
            problems.append("group %d: no log at %s" % (g, path))
            secs.append(None)
            continue
        secs.append(log["steps_s"])
        for name, line in log["failed"]:
            problems.append("group %d: %s" % (g, line))
        if not log["verdict"] or not log["verdict"].startswith("PASS"):
            problems.append("group %d: the verdict is %s (%s)" % (g, json.dumps(log["verdict"]), path))
        # every group on the plan's backend (only the group with pixel_backend_is_the_one_the_flag_chose checks the
        # flag itself, and the runner's ports serve both backends)
        if log["backend"] != plan_obj["backend"]:
            problems.append("group %d ran on the %s backend, the plan is for %s (%s)" % (
                g, log["backend"] or "unnamed (no backend: line)", plan_obj["backend"], path))
        ran = [nm for nm, _ in log["ok"]]
        for nm in ran:
            runs.setdefault(nm, []).append(g)
        if g <= len(groups):
            want = [first] + groups[g - 1]["steps"] + [last]
            want_order = [nm for nm in names if nm in set(want)]
            if ran != want_order:
                extra = [nm for nm in ran if nm not in set(want)]
                lost = [nm for nm in want_order if nm not in set(ran)]
                if extra:
                    problems.append("group %d ran steps it was not planned with: %s" % (g, ", ".join(extra)))
                if lost:
                    problems.append("group %d did not run %d planned step(s), from %s on" % (g, len(lost), lost[0]))
                if not extra and not lost:
                    problems.append("group %d ran its steps in another order than the gate's" % g)
    for nm in names:
        got = runs.get(nm, [])
        if nm in (first, last):
            if len(got) != len(logs):
                problems.append("%s ran in %d of %d groups (it runs in every group)" % (nm, len(got), len(logs)))
        elif not got:
            problems.append("MISSING: %s ran in no group" % nm)
        elif len(got) > 1:
            problems.append("TWICE: %s ran in groups %s" % (nm, ", ".join(map(str, got))))
    unknown = sorted(set(runs) - set(names))
    if unknown:
        problems.append("steps that are not the gate's: %s" % ", ".join(unknown))
    return problems, secs


def selftest():
    """check() against made-up logs of a 3-group plan: a good run passes; a step missing, a step twice, a failed step,
    a red verdict, a log too few and a log not there each fail, in their own words."""
    import tempfile
    d = tempfile.mkdtemp(prefix="editor_shards_")
    p = plan(3, "tiles", None)
    names, G = p["all"], [g["steps"] for g in p["groups"]]

    def logs(groups, bad=None, backend=None):
        paths = []
        for k, g in enumerate(groups, 1):
            path = os.path.join(d, "g%d.log" % k)
            want = set([names[0]] + g + [ALWAYS_LAST])
            fail, verdict = (bad or {}).get(k, (None, "PASS (shard)"))
            with open(path, "w", encoding="utf-8") as f:
                for s in [s for s in names if s in want]:
                    if s == fail:
                        f.write("[FAIL] %s: boom [1.0 s]\n" % s)
                        break
                    f.write("[ok] %s: {\"a\": 1} [1.5 s]\n" % s)
                b = (backend or {}).get(k, "tiles")
                if b:
                    f.write("backend: %s, 12.0 s in the steps\n" % b)
                f.write(verdict + "\n")
            paths.append(path)
        return paths

    def red(problems, word):
        return bool(problems) and any(word in x for x in problems)

    cases = [
        ("a good run passes", not check(p, logs(G))[0]),
        ("a step missing", red(check(p, logs([G[0], G[1][1:], G[2]]))[0], "MISSING: " + G[1][0])),
        ("a step twice", red(check(p, logs([G[0], G[1], G[2] + [G[0][5]]]))[0], "TWICE: " + G[0][5])),
        ("a failed step", red(check(p, logs(G, {2: (G[1][3], "FAIL")}))[0], G[1][3] + ": boom")),
        ("a red verdict", red(check(p, logs(G, {3: (None, "FAIL")}))[0], "the verdict")),
        ("a log too few", red(check(p, logs(G)[:2])[0], "2 logs for 3 groups")),
        ("a group on the other backend", red(check(p, logs(G, backend={2: "canvas"}))[0], "group 2 ran on the canvas backend")),
        ("a group with no backend line", red(check(p, logs(G, backend={3: None}))[0], "group 3 ran on the unnamed")),
    ]
    paths = logs(G)
    os.remove(paths[1])
    cases.append(("a log not there", red(check(p, paths)[0], "no log")))
    # the plan: every step but the first and the cleanup once, in the gate's order, and no unit split between groups
    flat = [s for g in G for s in g]
    cases.append(("the groups hold every step once, in order", flat == [n for n in names[1:] if n != ALWAYS_LAST]))
    where = {s: k for k, g in enumerate(G) for s in g}
    us = units()
    cases.append(("no unit is split", all(len({where[names[i]] for i in range(a, b + 1)}) == 1 for a, b, _ in us)))
    cases.append(("61-63 held by the declared chain as well", any(
        names[a] == "pixels_nothing_draws_get_no_display_mirror" and names[b] == "the_screen_draws_no_cpu_mirror_and_stale_textures_leave"
        and any("read-then-reset" in w for w in why) for a, b, why in us)))
    cases.append(("the Undo history's steps are one unit", any(names[a] == "undo_history_lists_three_edits_as_labelled_rows"
                                                             and names[b] == "undo_history_commands_match_the_list" for a, b, _ in us)))
    for n in (2, 3, 4, 6):
        q = plan(n, "tiles", None)
        wq = {s: k for k, g in enumerate(q["groups"]) for s in g["steps"]}
        if not all(len({wq[names[i]] for i in range(a, b + 1)}) == 1 for a, b, _ in us):
            cases.append(("no unit is split in %d groups" % n, False))
    for name, good in cases:
        print(("[ok] " if good else "[FAIL] ") + name)
    import shutil
    shutil.rmtree(d, ignore_errors=True)
    ok = all(g for _, g in cases)
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 2
    cmd = argv[0]
    if cmd == "selftest":
        return selftest()
    if cmd == "units":
        names = step_names()
        for a, b, why in units():
            print("%s .. %s (steps %d-%d)" % (names[a], names[b], a, b))
            for w in why:
                print("    " + w)
        for first, last, why in EXTRA_CHAINS:
            print("declared: %s .. %s: %s" % (first, last, why))
        return 0
    if cmd == "plan":
        n = int(argv[1])
        opts = dict(zip(argv[2::2], argv[3::2]))
        backend = opts.get("--backend", "tiles")
        p = plan(n, backend, opts.get("--logs"))
        if "--out" in opts:
            with open(opts["--out"], "w", encoding="utf-8", newline="\n") as f:
                json.dump(p, f, indent=1)
        sys.stderr.write("editor in %d groups (%s): %s\n" % (p["n"], backend, p["basis"]))
        for u in p["units"]:
            sys.stderr.write("  kept together: %s .. %s\n" % (u["from"], u["to"]))
        timed = not p["basis"].startswith("no timed")
        for k, g in enumerate(p["groups"], 1):
            sys.stderr.write("  group %d: steps %d-%d, %d steps%s\n" % (k, g["first"], g["last"], len(g["steps"]), ", about %.0f s" % g["est_s"] if timed else ""))
        for g in p["groups"]:
            print(",".join(g["steps"]))
        return 0
    if cmd == "check":
        with open(argv[1], encoding="utf-8") as f:
            p = json.load(f)
        logs = argv[2:]
        problems, secs = check(p, logs)
        shown = ", ".join("%s s" % ("%.0f" % s if s is not None else "?") for s in secs)
        body = len(p["all"]) - 2
        if problems:
            for line in problems:
                print("[FAIL] " + line)
            print("FAIL (editor in %d shards on %s: %s; the steps' time per shard %s)" % (len(logs), p["backend"], "%d problem(s)" % len(problems), shown))
            return 1
        print("PASS (editor in %d shards on %s: all %d steps ran, %d of them exactly once and the first step and the cleanup "
              "in every shard; the steps' time per shard %s)" % (len(logs), p["backend"], len(p["all"]), body, shown))
        return 0
    print("unknown command %s" % cmd)
    return 2


if __name__ == "__main__":
    # plain LF: bash reads the group lines with mapfile
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", newline="\n")
    sys.exit(main(sys.argv[1:]))
