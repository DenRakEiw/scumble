"""K4's mutation round (docs/PLAN_WASM_BUILD.md §1.3, §1.4 full tier) on a copy of the tree, never on F:/canvas.

    python mut_k4.py make TREE                 TREE = the tracked files of HEAD (git archive) plus K4's working files,
                                               node_modules as a junction to F:/canvas/node_modules (memory note
                                               scumble-mutation-copy-tree)
    python mut_k4.py run TREE OUT [names...]   orig first (the untouched copy must PASS and build F:/canvas's bytes),
                                               then each mutant of crates/px/src/maskf.rs: rebuilt on both builds
                                               (tools/build_px.py in TREE), the kill set `node tools/px_test.js` in TREE
                                               (box_blurs against its twin on both builds, height_normals' twin, which
                                               blurs through box_blurs inside Rust); a mutant px_test leaves green also
                                               runs the `edges` gate on a fresh instance from TREE (`--offline --tiles
                                               on`); then maskf.rs restored, rebuilt, both builds compared with
                                               F:/canvas's files and px_test run once more ("restored copy").
                                               Writes OUT/results.txt and OUT/logs/<name>.txt (tails).
The mutants: the SIMD lanes of K4 (rows1, apply, high, pack, add_line, col), the dispatch `lanes::rows`, the scalar
code the scalar build runs whole and the SIMD build for an odd height's last row and the column tails (rows_scalar,
box_cols, clamp, Norm::of), and box_blurs' divisor. The four-channel lanes (rows4) and `Norm::Mul` are not reachable
from any export until K26 (the dab blur) and are left out: their mutants would survive by construction.
"""
import hashlib
import os
import shutil
import subprocess
import sys
import time

REPO = r"F:\canvas"
WORKING = ["crates/px/src/maskf.rs", "renderer/editor/px/px.wasm", "renderer/editor/px/px_scalar.wasm", "tools/px_test.js", "tools/w0_bench.py"]

L = "lanes "
S = "scalar "
MUTANTS = [
    # ---- the SIMD lanes
    (L + "rows1: lane 1's start window read from row a", [("                sum = f64x2_add(sum, two(a + i, b + i));", "                sum = f64x2_add(sum, two(a + i, a + i));")], "killed"),
    (L + "rows1: the lanes stored swapped", [("                *d.add(a + x) = f64x2_extract_lane::<0>(o) as f32;\n                *d.add(b + x) = f64x2_extract_lane::<1>(o) as f32;", "                *d.add(a + x) = f64x2_extract_lane::<1>(o) as f32;\n                *d.add(b + x) = f64x2_extract_lane::<0>(o) as f32;")], "killed"),
    (L + "rows1: the entering tap one short", [("    unsafe fn rows1<const DIV: bool>(s: *const f32, d: *mut f32, w: usize, h: usize, r: usize, v: v128) -> usize {\n        let ri = r as isize;\n        let two = |a: usize, b: usize| f64x2(*s.add(a) as f64, *s.add(b) as f64);\n        for p in 0..h / 2 {\n            let a = 2 * p * w;\n            let b = a + w;\n            let mut sum = f64x2_splat(0.0);\n            for k in -ri..=ri {\n                let i = clamp(k, w);\n                sum = f64x2_add(sum, two(a + i, b + i));\n            }\n            for x in 0..w {\n                let o = apply::<DIV>(sum, v);\n                *d.add(a + x) = f64x2_extract_lane::<0>(o) as f32;\n                *d.add(b + x) = f64x2_extract_lane::<1>(o) as f32;\n                let add = (x + r + 1).min(w - 1);",
                                                       "    unsafe fn rows1<const DIV: bool>(s: *const f32, d: *mut f32, w: usize, h: usize, r: usize, v: v128) -> usize {\n        let ri = r as isize;\n        let two = |a: usize, b: usize| f64x2(*s.add(a) as f64, *s.add(b) as f64);\n        for p in 0..h / 2 {\n            let a = 2 * p * w;\n            let b = a + w;\n            let mut sum = f64x2_splat(0.0);\n            for k in -ri..=ri {\n                let i = clamp(k, w);\n                sum = f64x2_add(sum, two(a + i, b + i));\n            }\n            for x in 0..w {\n                let o = apply::<DIV>(sum, v);\n                *d.add(a + x) = f64x2_extract_lane::<0>(o) as f32;\n                *d.add(b + x) = f64x2_extract_lane::<1>(o) as f32;\n                let add = (x + r).min(w - 1);")], "killed"),
    (L + "rows1: enter and leave swapped", [("                sum = f64x2_add(sum, f64x2_sub(two(a + add, b + add), two(a + sub, b + sub)));", "                sum = f64x2_add(sum, f64x2_sub(two(a + sub, b + sub), two(a + add, b + add)));")], "killed"),
    (L + "rows1: the sum moved as (sum + enter) - leave", [("                sum = f64x2_add(sum, f64x2_sub(two(a + add, b + add), two(a + sub, b + sub)));", "                sum = f64x2_sub(f64x2_add(sum, two(a + add, b + add)), two(a + sub, b + sub));")], "killed: another rounding order"),
    (L + "rows1: an odd height's last row claimed", [("        h / 2 * 2\n    }", "        (h + 1) / 2 * 2\n    }")], "killed"),
    (L + "rows: one channel left to the scalar loop", [("                (1, Norm::Div(n)) => rows1::<true>(s, d, w, h, r, f64x2_splat(n)),", "                (1, Norm::Div(_)) => 0,")],
     "equivalent: the scalar loop computes the same sums and values for every row (only slower)"),
    (L + "apply: divide as multiply", [("        if DIV { f64x2_div(s, v) } else { f64x2_mul(s, v) }", "        if DIV { f64x2_mul(s, v) } else { f64x2_mul(s, v) }")], "killed"),
    (L + "high: floats 0-1 again", [("        f64x2_promote_low_f32x4(i64x2_shuffle::<1, 1>(q, q))", "        f64x2_promote_low_f32x4(i64x2_shuffle::<0, 0>(q, q))")], "killed"),
    (L + "pack: the high pair's zero lanes", [("        i64x2_shuffle::<0, 2>(f32x4_demote_f64x2_zero(lo), f32x4_demote_f64x2_zero(hi))", "        i64x2_shuffle::<0, 3>(f32x4_demote_f64x2_zero(lo), f32x4_demote_f64x2_zero(hi))")], "killed"),
    (L + "add_line: the high pair gets the low floats", [("                v128_store(s.add(i + 2) as *mut v128, f64x2_add(s1, high(q)));", "                v128_store(s.add(i + 2) as *mut v128, f64x2_add(s1, f64x2_promote_low_f32x4(q)));")], "killed"),
    (L + "add_line: a group skipped", [("                v128_store(s.add(i + 2) as *mut v128, f64x2_add(s1, high(q)));\n                i += 4;", "                v128_store(s.add(i + 2) as *mut v128, f64x2_add(s1, high(q)));\n                i += 8;")], "killed"),
    (L + "col: the low pair's value from the high sums", [("                v128_store(o.add(i) as *mut v128, pack(apply::<DIV>(s0, v), apply::<DIV>(s1, v)));", "                v128_store(o.add(i) as *mut v128, pack(apply::<DIV>(s1, v), apply::<DIV>(s1, v)));")], "killed"),
    (L + "col: enter and leave swapped", [("f64x2_add(s0, f64x2_sub(f64x2_promote_low_f32x4(qa), f64x2_promote_low_f32x4(qb)))", "f64x2_add(s0, f64x2_sub(f64x2_promote_low_f32x4(qb), f64x2_promote_low_f32x4(qa)))")], "killed"),
    (L + "col: the high sums not moved on", [("                v128_store(s.add(i + 2) as *mut v128, f64x2_add(s1, f64x2_sub(high(qa), high(qb))));\n", "")], "killed"),
    (L + "col_line: Div as a multiply", [("            Norm::Div(n) => col::<true>(out, sums, add, sub, f64x2_splat(n)),", "            Norm::Div(n) => col::<false>(out, sums, add, sub, f64x2_splat(n)),")], "killed"),
    (L + "col: the values done a group short", [("        let n4 = out.len().min(sums.len()).min(add.len()).min(sub.len()) / 4 * 4;", "        let n4 = (out.len().min(sums.len()).min(add.len()).min(sub.len()) / 4 * 4).saturating_sub(4);")],
     "equivalent: the last group goes through the scalar tail, the same sums and values (only slower)"),
    # ---- the scalar code (the scalar build's whole pass; the SIMD build's last row of an odd height and column tails)
    (S + "rows_scalar: the start window shifted", [("                sum += src[row + clamp(k, w) * C + c] as f64;", "                sum += src[row + clamp(k + 1, w) * C + c] as f64;")], "killed"),
    (S + "rows_scalar: the leaving tap one late", [("                let sub = x.saturating_sub(r);\n                sum += src[row + add * C + c] as f64 - src[row + sub * C + c] as f64;", "                let sub = x.saturating_sub(r + 1);\n                sum += src[row + add * C + c] as f64 - src[row + sub * C + c] as f64;")], "killed"),
    (S + "box_cols: the sums not reset between radii", [("    let sums = &mut sums[..n];\n    for s in sums.iter_mut() {\n        *s = 0.0;\n    }", "    let sums = &mut sums[..n];")], "killed"),
    (S + "box_cols: the start tail not added", [("        for x in done..n {\n            sums[x] += line[x] as f64;\n        }", "")], "killed"),
    (S + "box_cols: the entering line one short", [("        let add = &src[(y + r + 1).min(h - 1) * n..][..n];", "        let add = &src[(y + r).min(h - 1) * n..][..n];")], "killed"),
    (S + "box_cols: the tail's leave and enter swapped", [("            sums[x] += add[x] as f64 - sub[x] as f64;", "            sums[x] += sub[x] as f64 - add[x] as f64;")], "killed"),
    (S + "clamp: a tap past the line's end", [("    (k.max(0) as usize).min(n - 1)", "    (k.max(0) as usize).min(n)")], "killed"),
    (S + "Norm::of: divide by a reciprocal", [("            Norm::Div(n) => s / n,", "            Norm::Div(n) => s * (1.0 / n),")], "killed: the last bit"),
    (S + "box_blurs: the divisor 2r", [("        box_pass::<1>(data, &mut tmp, &mut sums, w, h, r, Norm::Div((2 * r + 1) as f64));", "        box_pass::<1>(data, &mut tmp, &mut sums, w, h, r, Norm::Div((2 * r) as f64));")], "killed"),
]


def sha(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


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
        keep = [l for l in lines if l.startswith(("FAIL", "not ok", "PASS", "error", "[FAIL]"))] + lines[-12:]
        f.write("\n".join(keep[:80]) + "\n")
    return rc, out


def safe(name):
    return "".join(ch if ch.isalnum() else "_" for ch in name)


def gate(tree, out, name):
    env = dict(os.environ, SCUMBLE_GATES=os.path.join(out, "gates"))
    label = "mut-" + safe(name)[:60]
    rc, txt = run(["bash", "tools/run_gates.sh", label, "--offline", "--tiles", "on", "edges"], tree, os.path.join(out, "logs", safe(name) + ".txt"), 1800, env)
    summ = os.path.join(out, "gates", "gates", label, "summary.txt")
    body = open(summ, encoding="utf-8", errors="replace").read() if os.path.exists(summ) else ""
    shutil.rmtree(os.path.join(out, "gates", "profiles"), ignore_errors=True)
    return rc == 0 and "FAIL" not in body, body.strip().splitlines()[-1:] if body else ["no summary"]


def go(tree, out, only):
    os.makedirs(os.path.join(out, "logs"), exist_ok=True)
    src = os.path.join(tree, "crates", "px", "src", "maskf.rs")
    orig = open(src, encoding="utf-8").read()
    want = {n: sha(os.path.join(REPO, "renderer", "editor", "px", n)) for n in ("px.wasm", "px_scalar.wasm")}
    res = open(os.path.join(out, "results.txt"), "a", encoding="utf-8")

    def line(s):
        print(s, flush=True)
        res.write(s + "\n")
        res.flush()

    def build_and_test(name, gate_too):
        log = os.path.join(out, "logs", safe(name) + ".txt")
        rc, txt = run([sys.executable, "tools/build_px.py"], tree, log, 900)
        if rc:
            return "build failed", None
        hashes = {n: sha(os.path.join(tree, "renderer", "editor", "px", n))[:12] for n in want}
        rc, txt = run(["node", "tools/px_test.js"], tree, log, 900)
        fails = [l for l in txt.splitlines() if l.startswith(("FAIL", "not ok"))]
        if rc:
            return f"red: px_test ({len(fails)} failing lines; first: {fails[0][:150] if fails else txt.strip().splitlines()[-1][:150]})", hashes
        if not gate_too:
            return "green: px_test", hashes
        ok, tail = gate(tree, out, name)
        return ("green: px_test and the edges gate" if ok else f"red: the edges gate ({tail})"), hashes

    line(f"== K4 mutation round {time.strftime('%Y-%m-%d %H:%M')} on {tree}")
    if not only or "orig" in only:
        verdict, h = build_and_test("orig (the untouched copy)", True)
        same = h is not None and all(sha(os.path.join(tree, "renderer", "editor", "px", n)) == want[n] for n in want)
        line(f"orig (the untouched copy): {verdict}; both builds identical to F:/canvas's: {same}")
        if not verdict.startswith("green") or not same:
            line("the untouched copy is not green: no mutant is believed; stopping")
            return
    kills = surv = 0
    for name, edits, expected in MUTANTS:
        if only and name not in only:
            continue
        s = orig
        for old, new in edits:
            assert s.count(old) == 1, (name, old[:60], s.count(old))
            s = s.replace(old, new)
        open(src, "w", encoding="utf-8", newline=chr(10)).write(s)
        t = time.time()
        verdict, h = build_and_test(name, False)
        if verdict == "green: px_test":
            ok, tail = gate(tree, out, name)
            verdict = "green: px_test and the edges gate" if ok else f"red: the edges gate ({tail})"
        red = verdict.startswith("red") or verdict == "build failed"
        kills += red
        surv += not red
        flag = "" if red == expected.startswith("killed") else "  <-- NOT AS EXPECTED"
        line(f"{'KILLED  ' if red else 'SURVIVED'} {name}: {verdict}; builds {h}; {time.time() - t:.0f} s; expected {expected}{flag}")
    open(src, "w", encoding="utf-8", newline=chr(10)).write(orig)
    verdict, h = build_and_test("restored copy", False)
    same = all(sha(os.path.join(tree, "renderer", "editor", "px", n)) == want[n] for n in want)
    line(f"restored copy: {verdict}; both builds identical to F:/canvas's: {same}")
    line(f"mutants: {kills} killed, {surv} survived of {kills + surv}")


if __name__ == "__main__":
    if sys.argv[1] == "make":
        make(sys.argv[2])
    else:
        go(sys.argv[2], sys.argv[3], sys.argv[4:])
