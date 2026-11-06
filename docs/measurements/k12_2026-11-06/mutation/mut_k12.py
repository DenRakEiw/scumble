"""K12's small mutation round (the cancel / ticket logic and the stripes; docs/PLAN_WASM_BUILD.md §1.3) on a copy of the
tree, never on F:/canvas.

    python mut_k12.py make TREE                TREE = the tracked files of HEAD (git archive) plus K12's working files,
                                               node_modules as a junction to F:/canvas/node_modules (memory note
                                               scumble-mutation-copy-tree)
    python mut_k12.py run TREE OUT [names...]  orig first (the untouched copy: px_test and the relight gate must PASS),
                                               then each mutant: px_test in TREE for the modules it loads (inpaint_relight.js,
                                               px.js), and the relight gate (RELIGHT_GATE_SKIP_NODE=1, `--offline --tiles
                                               on`, a fresh instance from TREE) for the window's code and for any mutant
                                               px_test leaves green; then the files restored and px_test run once more.
                                               Writes OUT/results.txt and OUT/logs/<name>.txt (tails).
"""
import os
import shutil
import subprocess
import sys
import time

REPO = r"F:\canvas"
WORKING = ["renderer/editor/inpaint_canvas.js", "renderer/editor/inpaint_relight.js", "renderer/editor/inpaint_worker.js",
           "renderer/editor/px/kernels.js", "renderer/editor/px/px.js", "tools/px_test.js", "tools/relight_test.py", "tools/perf_test.py"]
C, R, X = "renderer/editor/inpaint_canvas.js", "renderer/editor/inpaint_relight.js", "renderer/editor/px/px.js"

# (name, file, [(old, new)], expected)
MUTANTS = [
    ("supersede without the cancel", C, [("            const pool = editorPool();\n            if (pool && !pool.off) pool.cancel(m.group);\n        };", "        };")], "killed"),
    ("no supersede before a new full march", C, [("            if (!quick) supersede(i);\n            cache.pending.add(pendingKey);", "            cache.pending.add(pendingKey);")], "killed"),
    ("no supersede when the channel holds the key", C, [("                if (!quick && fullMarches[i] && fullMarches[i].pendingKey !== pendingKey) supersede(i);\n", "")], "killed"),
    ("a superseded march frees its key again at its end", C, [("if (!march.superseded) cache.pending.delete(pendingKey);", "cache.pending.delete(pendingKey);")], "killed"),
    ("quick marches superseded too", C, [("            if (!quick) supersede(i);\n            cache.pending.add(pendingKey);", "            supersede(i);\n            cache.pending.add(pendingKey);"),
                                          ("            if (!quick) fullMarches[chan] = march;", "            fullMarches[chan] = march;")], "killed"),
    ("a cancelled march warns", C, [("if (!(err && err.cancelled)) console.warn(`relight_shadow channel", "console.warn(`relight_shadow channel")], "killed"),
    ("the route ignored (always stripes)", C, [("stripes: stripes === undefined ? STRIPES_PER_WORKER * pool.size : stripes", "stripes: STRIPES_PER_WORKER * pool.size")], "killed"),
    ("one group for every march of a channel", C, [("group: `relight:${layer.id}:${chan}:${targetW}x${targetH}:${ticket}`", "group: `relight:${layer.id}:${chan}`")], "killed"),
    ("marchOnPool: no cancel when a stripe fails", R, [("        if (group !== null && group !== undefined) pool.cancel(group);\n        throw err;", "        throw err;")], "killed"),
    ("marchOnPool: the rows not checked", R, [("if (!r || r.row0 !== plan[i][0] || r.rows !== plan[i][1]) {", "if (!r) {")], "killed"),
    ("marchOnPool: stripes without a SharedArrayBuffer", R, [("    if (!shared || !(stripes > 1)) {", "    if (!(stripes > 1)) {")], "killed"),
    ("stripePlan: stripes under the minimum", R, [("Math.floor(rows / Math.max(1, minRows)) || 1", "Math.ceil(rows / Math.max(1, minRows)) || 1")], "killed"),
    ("stripePlan: a stripe a row short", R, [("        if (b > a) plan.push([a, b - a]);", "        if (b > a) plan.push([a, Math.max(1, b - a - (i === 1 ? 1 : 0))]);")], "killed"),
    ("_slot: the key ignored", X, [("if (s && s.key === key && s.bytes === bytes) return s.ptr;", "if (s && s.bytes === bytes) return s.ptr;")], "killed"),
    ("_slot: the size ignored", X, [("if (s && s.key === key && s.bytes === bytes) return s.ptr;", "if (s && s.key === key) return s.ptr;")], "killed"),
    ("shadowMarch: the key never used", X, [("const pd = key !== null && key !== undefined ? this._slot(\"relight_depth\", String(key), depth, n * 2) : this._in(a, depth, n * 2);", "const pd = this._in(a, depth, n * 2);")], "killed"),
]


def make(tree):
    if os.path.exists(tree):
        subprocess.run(["cmd", "/c", "rmdir", os.path.join(tree, "node_modules")], capture_output=True)
        shutil.rmtree(tree)
    os.makedirs(tree)
    arch = subprocess.run(["git", "-C", REPO, "archive", "--format=tar", "HEAD"], capture_output=True, check=True).stdout
    subprocess.run(["tar", "-x", "-f", "-", "-C", tree.replace("\\", "/")], input=arch, check=True)
    for rel in WORKING:
        shutil.copyfile(os.path.join(REPO, rel), os.path.join(tree, rel))
    subprocess.run(["powershell", "-NoProfile", "-Command", f"New-Item -ItemType Junction -Path '{os.path.join(tree, 'node_modules')}' -Target '{os.path.join(REPO, 'node_modules')}' | Out-Null"], check=True)
    print("tree made:", tree)


def run(cmd, cwd, log, timeout, env=None):
    t = time.time()
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, env=env)
        out, rc = (r.stdout or "") + (r.stderr or ""), r.returncode
    except subprocess.TimeoutExpired as e:
        out, rc = f"TIMEOUT after {timeout} s\n{e.stdout or ''}", 124
    with open(log, "a", encoding="utf-8") as f:
        f.write(f"$ {' '.join(cmd)}  (rc {rc}, {time.time() - t:.0f} s)\n")
        lines = out.splitlines()
        keep = [ln for ln in lines if ln.startswith(("FAIL", "not ok", "PASS", "error", "[FAIL]"))] + lines[-12:]
        f.write("\n".join(keep[:80]) + "\n")
    return rc, out


def safe(name):
    return "".join(ch if ch.isalnum() else "_" for ch in name)


def gate(tree, out, name):
    env = dict(os.environ, SCUMBLE_GATES=os.path.join(out, "gates"), RELIGHT_GATE_SKIP_NODE="1")
    label = "mut-" + safe(name)[:60]
    rc, _ = run(["bash", "tools/run_gates.sh", label, "--offline", "--tiles", "on", "relight"], tree, os.path.join(out, "logs", safe(name) + ".txt"), 1800, env)
    gdir = os.path.join(out, "gates", "gates", label)
    summ = os.path.join(gdir, "summary.txt")
    body = open(summ, encoding="utf-8", errors="replace").read() if os.path.exists(summ) else ""
    fails = []
    lg = os.path.join(gdir, "relight.log")
    if os.path.exists(lg):
        txt = open(lg, encoding="utf-8", errors="replace").read()
        fails = [ln.strip()[:160] for ln in txt.splitlines() if "nk" in ln and ("FAIL" in ln or "fail" in ln)][:2]
    shutil.rmtree(os.path.join(out, "gates", "profiles"), ignore_errors=True)
    return rc == 0 and "FAIL" not in body, (fails or body.strip().splitlines()[-1:] or ["no summary"])


def go(tree, out, only):
    os.makedirs(os.path.join(out, "logs"), exist_ok=True)
    res = open(os.path.join(out, "results.txt"), "a", encoding="utf-8")

    def line(s):
        print(s, flush=True)
        res.write(s + "\n")
        res.flush()

    def pxtest(name):
        rc, txt = run(["node", "tools/px_test.js"], tree, os.path.join(out, "logs", safe(name) + ".txt"), 1200)
        fails = [ln for ln in txt.splitlines() if ln.startswith("FAIL")]
        return rc == 0, fails

    line(f"== K12 mutation round {time.strftime('%Y-%m-%d %H:%M')} on {tree}")
    if not only or "orig" in only:
        ok1, f1 = pxtest("orig")
        ok2, f2 = gate(tree, out, "orig")
        line(f"orig (the untouched copy): px_test {'PASS' if ok1 else 'FAIL ' + str(f1[:1])}, relight gate {'PASS' if ok2 else 'FAIL ' + str(f2)}")
        if not (ok1 and ok2):
            line("the untouched copy is not green: no mutant is believed; stopping")
            return
    kills = surv = 0
    for name, rel, edits, expected in MUTANTS:
        if only and name not in only:
            continue
        p = os.path.join(tree, rel)
        orig = open(p, encoding="utf-8").read()
        s = orig
        for old, new in edits:
            assert s.count(old) == 1, (name, old[:60], s.count(old))
            s = s.replace(old, new)
        with open(p, "wb") as f:
            f.write(s.encode("utf-8"))
        t = time.time()
        try:
            verdict = None
            if rel != C:
                ok, fails = pxtest(name)
                if not ok:
                    verdict = f"red: px_test ({len(fails)} failing; first: {fails[0][:150] if fails else '?'})"
            if verdict is None:
                ok, tail = gate(tree, out, name)
                verdict = "green: px_test and the relight gate" if ok and rel != C else "green: the relight gate" if ok else f"red: the relight gate ({tail})"
        finally:
            with open(p, "wb") as f:
                f.write(orig.encode("utf-8"))
        red = verdict.startswith("red")
        kills += red
        surv += not red
        flag = "" if red == (expected == "killed") else "  <-- NOT AS EXPECTED"
        line(f"{'KILLED  ' if red else 'SURVIVED'} {name} ({rel.split('/')[-1]}): {verdict}; {time.time() - t:.0f} s; expected {expected}{flag}")
    ok, fails = pxtest("restored copy")
    line(f"restored copy: px_test {'PASS' if ok else 'FAIL'}")
    line(f"mutants: {kills} killed, {surv} survived of {kills + surv}")


if __name__ == "__main__":
    if sys.argv[1] == "make":
        make(sys.argv[2])
    else:
        go(sys.argv[2], sys.argv[3], sys.argv[4:])
