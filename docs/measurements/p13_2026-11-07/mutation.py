"""P13's mutation round: each mutant of the hoisted mean, the scratch products and the carried blur in keymatte.js must
turn tools/keymatte_test.js's case 12 (the old code's floats, bit for bit) red."""
import subprocess
import sys

ROOT = r"F:\canvas\.claude\worktrees\agent-a24fab290e0ea66b6"
FILE = ROOT + r"\renderer\editor\keymatte.js"

MUTANTS = [
    ("carry one pass too many", "blur121(lastP, aw, ah, k - lastK)", "blur121(lastP, aw, ah, k - lastK + 1)"),
    ("carry from the planes' count", "blur121(lastP, aw, ah, k - lastK)", "blur121(lastP, aw, ah, k)"),
    ("carry kept for a smaller k", "whole && k >= lastK ?", "whole ?"),
    ("a fractional k carried", "const whole = Number.isInteger(k) && k > 0;", "const whole = k > 0;"),
    ("mP of the first guide plane", "const mP = mean(box, p, aw, ah, prm.r);", "const mP = mean(box, planes[0], aw, ah, prm.r);"),
    ("products not stored as f32", "function prodMean(box, s, x, y, w, h, r) {\n    for (let i = 0, n = s.length; i < n; i++) s[i] = x[i] * y[i];",
     "function prodMean(box, s, x, y, w, h, r) {\n    s = new Float64Array(s.length);\n    for (let i = 0, n = s.length; i < n; i++) s[i] = x[i] * y[i];"),
    ("grey fit: II from I * p", "mII = prodMean(box, s, I, I, w, h, r)", "mII = prodMean(box, s, I, p, w, h, r)"),
]


def run():
    r = subprocess.run(["node", "keymatte_test.js"], capture_output=True, text=True, cwd=ROOT + r"\tools")
    return r.returncode == 0 and "all PASS" in r.stdout, [l for l in r.stdout.splitlines() if l.startswith("FAIL")][:2]


def main():
    with open(FILE, "rb") as f:
        orig = f.read()
    text = orig.decode("utf-8")
    killed = 0
    try:
        ok, _ = run()
        if not ok:
            print("the untouched file does not pass")
            return 1
        for name, old, new in MUTANTS:
            assert text.count(old) == 1, f"{name}: {text.count(old)} matches"
            with open(FILE, "wb") as f:
                f.write(text.replace(old, new).encode("utf-8"))
            ok, fails = run()
            killed += not ok
            print(f"{'killed ' if not ok else 'SURVIVED'}  {name}: {fails[0][:150] if fails else ''}")
    finally:
        with open(FILE, "wb") as f:
            f.write(orig)
    print(f"{killed} of {len(MUTANTS)} killed")
    return 0 if killed == len(MUTANTS) else 2


if __name__ == "__main__":
    sys.exit(main())
