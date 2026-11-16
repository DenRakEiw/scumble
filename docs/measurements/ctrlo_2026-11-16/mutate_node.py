"""The lean mutation round on electron/main/grantedfiles.js (the token check, the grant, the range handling): each
mutant of mutants.py whose file is grantedfiles.js, applied in the checkout, killed by `node tools/grantedfiles_test.js`
alone (plain Node, no app), the file restored byte for byte after each. The window-side and main.js mutants of
mutants.py need the openfile gate on an app (tools/mutation_round.py) and were not run (2026-11-16, the weekly limit).

    python docs/measurements/ctrlo_2026-11-16/mutate_node.py
"""
import os
import runpy
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
M = runpy.run_path(os.path.join(HERE, "mutants.py"))
G = "electron/main/grantedfiles.js"
path = os.path.join(ROOT, G)
orig = open(path, "rb").read()
killed = survived = 0
try:
    for name, file, pairs, expected, _kill in M["MUTANTS"]:
        if file != G:
            continue
        s = orig.decode("utf-8")
        for old, new in pairs:
            assert s.count(old) == 1, (name, old[:60])
            s = s.replace(old, new)
        open(path, "wb").write(s.encode("utf-8"))
        r = subprocess.run(["node", os.path.join(ROOT, "tools", "grantedfiles_test.js")], capture_output=True, text=True, timeout=120)
        fails = [ln for ln in r.stdout.splitlines() if ln.startswith("[FAIL]")]
        ok = r.returncode != 0
        killed += ok
        survived += not ok
        print("%-40s %s%s" % (name, "killed: " + (fails[0][7:90] if fails else (r.stdout + r.stderr).strip().splitlines()[-1][:90]) if ok else "SURVIVED", "" if ok == expected.startswith("killed") else "  <-- NOT AS EXPECTED"))
finally:
    open(path, "wb").write(orig)
r = subprocess.run(["node", os.path.join(ROOT, "tools", "grantedfiles_test.js")], capture_output=True, text=True, timeout=120)
print("restored:", r.stdout.strip().splitlines()[-1], "| killed %d, survived %d" % (killed, survived))
sys.exit(0 if r.returncode == 0 else 1)
