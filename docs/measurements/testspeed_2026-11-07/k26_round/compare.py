"""K26's full round (the first round, 27 mutants) against the focused round: verdicts and seconds per mutant."""
import re
import sys

old_p, new_p = sys.argv[1], sys.argv[2]
LINE = re.compile(r"^(KILLED  |SURVIVED) (.+?): (?:red(?: on the re-check)?|green): .*?; (\d+) s \(|^(KILLED  |SURVIVED) (.+?): (?:red(?: on the re-check)?|green): .*?; (\d+) s; expected")


def read(p, first_round_only):
    out = {}
    for ln in open(p, encoding="utf-8"):
        if first_round_only and ln.startswith("== rerun"):
            break
        m = LINE.match(ln)
        if m:
            g = [x for x in m.groups() if x is not None]
            out[g[1]] = (g[0].strip(), int(g[2]))
    return out


old = read(old_p, True)
rerun = {}
seen = False
for ln in open(old_p, encoding="utf-8"):
    if ln.startswith("== rerun"):
        seen = True
    m = LINE.match(ln) if seen else None
    if m:
        g = [x for x in m.groups() if x is not None]
        rerun[g[1]] = (g[0].strip(), int(g[2]))
new = read(new_p, False)
alias = {"Norm::of: divide by a reciprocal": "Norm::of: divide by a reciprocal (K4's, rerun on the whole test)"}
rows, cats = [], {}
for name, (v, t) in new.items():
    o = old.get(alias.get(name, name))
    r = rerun.get(name)
    final = r[0] if r else (o[0] if o else "?")
    cat = ("rust" if t and "build" else "")
    rows.append((name, final, r[1] if r else (o[1] if o else None), v, t))
same = sum(1 for r in rows if r[1] == r[3])
print(f"{'mutant':58} {'full round':>10} {'s':>5}   {'focused':>8} {'s':>5}")
for name, fv, ft, nv, nt in rows:
    print(f"{name[:58]:58} {fv:>10} {ft if ft is not None else '-':>5}   {nv:>8} {nt:>5}{'' if fv == nv else '   <- differs'}")
print(f"verdicts equal: {same} of {len(rows)}")
print(f"sum of seconds: full round {sum(r[2] or 0 for r in rows)}, focused {sum(r[4] for r in rows)}")
k = [r for r in rows if r[3] == "KILLED"]
s = [r for r in rows if r[3] == "SURVIVED"]
print(f"killed ({len(k)}): full round {sum(r[2] or 0 for r in k)} s (mean {sum(r[2] or 0 for r in k) / len(k):.0f}), focused {sum(r[4] for r in k)} s (mean {sum(r[4] for r in k) / len(k):.1f})")
print(f"survived ({len(s)}): full round {sum(r[2] or 0 for r in s)} s (mean {sum(r[2] or 0 for r in s) / len(s):.0f}), focused + re-check {sum(r[4] for r in s)} s (mean {sum(r[4] for r in s) / len(s):.0f})")
