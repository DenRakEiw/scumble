"""Build renderer/easteregg/logo.bf: the Scumble mascot and wordmark as a Brainfuck program.

The mascot is drawn from build/icon.png (one character per cell, a coverage ramp for the paint, '=' for the cream
stripe), the wordmark is a block-letter "SCUMBLE"; the program prints both (renderer/easteregg.js runs it and the
window prints the result to the DevTools console at start).

    python tools/bf_logo.py            write renderer/easteregg/logo.bf
    python tools/bf_logo.py --check    fail when the committed file differs from a fresh build
    python tools/bf_logo.py --show     print the picture the program prints
"""
import argparse
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON = os.path.join(ROOT, "build", "icon.png")
OUT = os.path.join(ROOT, "renderer", "easteregg", "logo.bf")

COLS = 96          # characters across the icon's 1024 px
CROP = (0, 100, 1024, 920)   # the rows of the icon that hold the mascot, its stripe and the drips
ASPECT = 2.1       # a console character is about this many times as tall as it is wide
PAINT = (196, 102, 59)
CREAM = (238, 231, 220)
RAMP = " .:-=+*#%@"    # paint coverage, empty to full
CREAM_RAMP = " .-="     # stripe coverage

WORDMARK = r"""
 ____    ____  _   _  __  __  ____   _      _____
/ ___|  / ___|| | | ||  \/  || __ ) | |    | ____|
\___ \ | |    | | | || |\/| ||  _ \ | |    |  _|
 ___) || |___ | |_| || |  | || |_) || |___ | |___
|____/  \____| \___/ |_|  |_||____/ |_____||_____|
"""


def near(px, ref, tol=60):
    return abs(px[0] - ref[0]) + abs(px[1] - ref[1]) + abs(px[2] - ref[2]) < tol


def picture():
    img = Image.open(ICON).convert("RGB").crop(CROP)
    w, h = img.size
    cw = w / COLS
    ch = cw * ASPECT
    rows = int(h / ch)
    px = img.load()
    lines = []
    for r in range(rows):
        line = ""
        for c in range(COLS):
            paint = cream = n = 0
            # 4 x 8 samples per cell
            for sy in range(8):
                y = min(h - 1, int(r * ch + (sy + 0.5) * ch / 8))
                for sx in range(4):
                    x = min(w - 1, int(c * cw + (sx + 0.5) * cw / 4))
                    p = px[x, y]
                    n += 1
                    if near(p, PAINT):
                        paint += 1
                    elif near(p, CREAM):
                        cream += 1
            if paint >= cream:
                line += RAMP[round(paint / n * (len(RAMP) - 1))]
            else:
                line += CREAM_RAMP[round(cream / n * (len(CREAM_RAMP) - 1))]
        lines.append(line.rstrip())
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    word = [l.rstrip() for l in WORDMARK.strip("\n").split("\n")]
    width = max(len(l) for l in word)
    pad = " " * max(0, (COLS - width) // 2)
    return "\n".join(lines + [""] + [(pad + l).rstrip() for l in word]) + "\n"


WRAP = 96         # the program's line width


def compile_bf(text):
    """The plain style: one cell, each character reached from the one before by + or -, then printed.

    A multi-cell compiler writes about a quarter of this (5 KB); the plain one is kept on purpose, so that GitHub's
    language bar, which leaves out languages below about 0.1 % of the repository, shows Brainfuck."""
    prev = 0
    code = ""
    for ch in text:
        d = ord(ch) - prev
        code += ("+" * d if d > 0 else "-" * -d) + "."
        prev = ord(ch)
    head = ("Scumble logo in Brainfuck\n"
            "Built by tools/bf_logo py from build/icon png and a block letter wordmark\n"
            "Run it with runBrainfuck in renderer/easteregg js\n\n")
    return head + "\n".join(code[i:i + WRAP] for i in range(0, len(code), WRAP)) + "\n"


def run_bf(code):
    mem, ptr, pc, out, stack, jump = [0] * 300, 0, 0, [], [], {}
    for i, c in enumerate(code):
        if c == "[":
            stack.append(i)
        elif c == "]":
            j = stack.pop()
            jump[i], jump[j] = j, i
    while pc < len(code):
        c = code[pc]
        if c == ">":
            ptr += 1
        elif c == "<":
            ptr -= 1
        elif c == "+":
            mem[ptr] = (mem[ptr] + 1) & 255
        elif c == "-":
            mem[ptr] = (mem[ptr] - 1) & 255
        elif c == ".":
            out.append(chr(mem[ptr]))
        elif c == "[" and mem[ptr] == 0:
            pc = jump[pc]
        elif c == "]" and mem[ptr] != 0:
            pc = jump[pc]
        pc += 1
    return "".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--show", action="store_true")
    a = ap.parse_args()
    text = picture()
    code = compile_bf(text)
    assert run_bf(code) == text, "the program does not print the picture"
    if a.show:
        sys.stdout.write(text)
        print(f"{len(code)} bytes of Brainfuck, {len(text)} characters printed")
        return 0
    if a.check:
        with open(OUT, encoding="utf-8") as f:
            ok = f.read() == code
        print("bf_logo: " + ("ok" if ok else "logo.bf differs from a fresh build (run python tools/bf_logo.py)"))
        return 0 if ok else 1
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline=chr(10)) as f:
        f.write(code)
    print(f"wrote {os.path.relpath(OUT, ROOT)}: {len(code)} bytes, prints {len(text)} characters")
    return 0


if __name__ == "__main__":
    sys.exit(main())
