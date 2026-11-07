"""P10's mutation round: each mutant of the new word paths in inpaint_tiles.js must turn tools/gutter_words_test.js red."""
import subprocess
import sys

ROOT = r"F:\canvas\.claude\worktrees\agent-a24fab290e0ea66b6"
FILE = ROOT + r"\renderer\editor\inpaint_tiles.js"

MUTANTS = [
    ("opaque test widened", "if (a === 255) {\n                        // a run of opaque", "if (a >= 254) {\n                        // a run of opaque"),
    ("opaque run scan widened", "while (r < end && s32[r] >>> 24 === 255) r++;", "while (r < end && s32[r] >>> 24 >= 254) r++;"),
    ("opaque run's last word left out", "o32.set(s32.subarray(j, r), q);", "o32.set(s32.subarray(j, r - 1), q);"),
    ("opaque run: q not advanced", "o32.set(s32.subarray(j, r), q);\n                        q += r - j; j = r;", "o32.set(s32.subarray(j, r), q);\n                        j = r; q += r - j;"),
    ("short opaque run copies a neighbour", "while (j < r) o32[q++] = s32[j++]; continue; }", "while (j < r) { o32[q++] = s32[j + 1]; j++; } continue; }"),
    ("transparent test widened", "if (!a) {\n                        // a run of transparent", "if (a < 2) {\n                        // a run of transparent"),
    ("transparent run scan widened", "while (r < end && s32[r] < ALPHA) r++;", "while (r < end && s32[r] < 0x2000000) r++;"),
    ("transparent run filled with 1", "o32.fill(0, q, q + r - j);", "o32.fill(1, q, q + r - j);"),
    ("short transparent run keeps the colour", "while (j < r) { o32[q++] = 0; j++; } continue; }", "while (j < r) { o32[q++] = s32[j]; j++; } continue; }"),
    ("soft alpha forced", "<< 8) | (w & 0xFF000000);", "<< 8) | 0xFF000000;"),
    ("soft R / B rounding: +128 in the high half only", "Math.imul(w & 0xFF00FF, a) + 0x800080", "Math.imul(w & 0xFF00FF, a) + 0x800000"),
    ("soft R / B: the low half's x >> 8 dropped", "(rb + ((rb >>> 8) & 0xFF00FF))", "(rb + ((rb >>> 8) & 0xFF0000))"),
    ("soft R / B mask keeps G's bits", "(((rb + ((rb >>> 8) & 0xFF00FF)) >>> 8) & 0xFF00FF)", "(((rb + ((rb >>> 8) & 0xFF00FF)) >>> 8) & 0xFFFFFF)"),
    ("soft G rounding 127", "((w >>> 8) & 255) * a + 128", "((w >>> 8) & 255) * a + 127"),
    ("soft G without the x >> 8 term", "(((g + (g >> 8)) >> 8) << 8)", "((g >> 8) << 8)"),
    ("soft G from B", "g = ((w >>> 8) & 255) * a", "g = ((w >>> 16) & 255) * a"),
    ("RUN_MIN 1 (every run by set / fill: same bytes, a check that the set path is right)", "const RUN_MIN = 16;", "const RUN_MIN = 1; const __X = 0;"),
    ("coarse opaque threshold", "                        if (w >= 0xFF000000) { o32[o >> 2] = w; continue; }\n                        if (w < ALPHA)", "                        if (w >= 0xFE000000) { o32[o >> 2] = w; continue; }\n                        if (w < ALPHA)"),
    ("coarse transparent copies the word", "                        if (w < ALPHA) { o32[o >> 2] = 0; continue; }\n                    }",
     "                        if (w < ALPHA) { o32[o >> 2] = w; continue; }\n                    }"),
    ("coarse word index", "                        const w = s32[j];\n                        if (w >= 0xFF000000)", "                        const w = s32[j + 1];\n                        if (w >= 0xFF000000)"),
    ("off ignored", "info.off & 3 ? null : words(info.data)", "words(info.data)"),
    ("output offset ignored", "const o32 = words(out);", "const o32 = LITTLE ? new Uint32Array(out.buffer, 0, out.length >> 2) : null;"),
]
# a mutant that keeps the bytes (RUN_MIN 1) is expected to survive: it shows the set / fill path alone is right
EQUIVALENT = {"RUN_MIN 1 (every run by set / fill: same bytes, a check that the set path is right)"}


def main():
    with open(FILE, "rb") as f:
        orig = f.read()
    text = orig.decode("utf-8")
    killed = 0
    try:
        base = subprocess.run(["node", ROOT + r"\tools\gutter_words_test.js"], capture_output=True, text=True, cwd=ROOT)
        if "RESULT PASS" not in base.stdout:
            print("the untouched file does not pass:", base.stdout[-500:], base.stderr[-500:])
            return 1
        for name, old, new in MUTANTS:
            n = text.count(old)
            assert n == 1, f"{name}: {n} matches"
            with open(FILE, "wb") as f:
                f.write(text.replace(old, new).encode("utf-8"))
            r = subprocess.run(["node", ROOT + r"\tools\gutter_words_test.js"], capture_output=True, text=True, cwd=ROOT)
            red = "RESULT PASS" not in r.stdout
            eq = name in EQUIVALENT
            killed += red != eq
            last = (r.stdout.strip().splitlines() or [""])[-1]
            err = [l for l in (r.stderr + r.stdout).splitlines() if "Error" in l][:1]
            tag = ("passes (equivalent)" if not red else "RED on an equivalent!") if eq else ("killed " if red else "SURVIVED")
            print(f"{tag}  {name}: {last} {err[0][:160] if err else ''}")
    finally:
        with open(FILE, "wb") as f:
            f.write(orig)
    print(f"{killed} of {len(MUTANTS)} as expected")
    return 0 if killed == len(MUTANTS) else 2


if __name__ == "__main__":
    sys.exit(main())
