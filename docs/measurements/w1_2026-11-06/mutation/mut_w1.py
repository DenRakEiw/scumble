"""W1's mutation round (docs/PLAN_WASM_BUILD.md §1.3, §1.4 full tier) on a copy of the tree, never on F:/canvas.

    python mut_w1.py make TREE                 TREE = the tracked files of HEAD (git archive) plus W1's working files,
                                               node_modules as a junction to F:/canvas/node_modules (memory note
                                               scumble-mutation-copy-tree)
    python mut_w1.py run TREE OUT [names...]   orig first (the untouched copy must PASS), then each mutant of
                                               crates/px/src/png.rs: rebuilt on both builds (tools/build_px.py in TREE),
                                               the kill set `node tools/px_test.js` in TREE; a mutant px_test leaves
                                               green also runs the `export` gate on a fresh instance from TREE
                                               (`--offline --tiles on`); then png.rs restored, rebuilt, both builds
                                               compared with F:/canvas's committed files and px_test run once more
                                               ("restored copy"). Writes OUT/results.txt and OUT/logs/<name>.txt (tails).
The mutants: the SIMD lanes of W1 (lanes::filter_row, sums, write, cost16, avg, paeth, choose), the dispatch
row_filter, and the scalar filter_row / cost / paeth / filtered that the scalar build runs and the SIMD build runs for
rows under 5 px and for every row's first pixel and tail.
"""
import hashlib
import os
import shutil
import subprocess
import sys
import time

REPO = r"F:\canvas"
WORKING = ["crates/px/src/png.rs", "renderer/editor/px/px.wasm", "renderer/editor/px/px_scalar.wasm", "tools/px_test.js", "tools/tiff_test.py"]

# (name, [(old, new)], expected): expected "killed" or "equivalent: <why>"
L = "lanes "
S = "scalar "
MUTANTS = [
    # ---- the SIMD lanes
    (L + "block256", [("const BLOCK: usize = 255;", "const BLOCK: usize = 256;")], "killed"),
    (L + "block1024", [("const BLOCK: usize = 255;", "const BLOCK: usize = 1024;")], "killed"),
    (L + "choose pa<=pb as lt", [("(v128_and(i16x8_le(pa, pb), i16x8_le(pa, pc)), i16x8_le(pb, pc))", "(v128_and(i16x8_lt(pa, pb), i16x8_le(pa, pc)), i16x8_le(pb, pc))")],
     "equivalent: pa = pb with a != b puts c midway (pc = 0 < pa), and with a = b either pick is the same byte; 0 of 2^24 triples differ (the review's exhaustive probe)"),
    (L + "choose pa<=pc as lt", [("(v128_and(i16x8_le(pa, pb), i16x8_le(pa, pc)), i16x8_le(pb, pc))", "(v128_and(i16x8_le(pa, pb), i16x8_lt(pa, pc)), i16x8_le(pb, pc))")], "killed"),
    (L + "choose pb<=pc as lt", [("(v128_and(i16x8_le(pa, pb), i16x8_le(pa, pc)), i16x8_le(pb, pc))", "(v128_and(i16x8_le(pa, pb), i16x8_le(pa, pc)), i16x8_lt(pb, pc))")], "killed"),
    (L + "paeth order b before a", [("v128_bitselect(a, v128_bitselect(b, c, mb), ma)", "v128_bitselect(b, v128_bitselect(a, c, ma), mb)")], "killed"),
    (L + "paeth narrow halves swapped", [("let ma = i8x16_narrow_i16x8(ma0, ma1);", "let ma = i8x16_narrow_i16x8(ma1, ma0);")], "killed"),
    (L + "paeth c loaded as b", [("(v128_load(u.add(i) as *const v128), v128_load(u.add(i - 4) as *const v128))", "(v128_load(u.add(i) as *const v128), v128_load(u.add(i) as *const v128))")], "killed"),
    (L + "paeth group not stored", [("                v128_store(o.add(i) as *mut v128, f4);\n", "")], "killed"),
    (L + "best on ties the later", [("            if tot[t as usize] < tot[best as usize] {", "            if tot[t as usize] <= tot[best as usize] {")], "killed"),
    (L + "best searched backwards", [("        let mut best = 0u8;\n        for t in 1..5u8 {\n            if tot[", "        let mut best = 0u8;\n        for t in (1..5u8).rev() {\n            if tot[")], "killed"),
    (L + "avg without the rounding fix", [("i8x16_sub(u8x16_avgr(a, b), v128_and(v128_xor(a, b), u8x16_splat(1)))", "u8x16_avgr(a, b)")], "killed"),
    (L + "cost without abs", [("u16x8_extadd_pairwise_u8x16(i8x16_abs(v))", "u16x8_extadd_pairwise_u8x16(v)")], "killed"),
    (L + "a lane of the u32 sum dropped", [(" + u32x4_extract_lane::<3>(v);", ";")], "killed"),
    (L + "None's sum of a", [("s[0] = i16x8_add(s[0], cost16(x));", "s[0] = i16x8_add(s[0], cost16(a));")], "killed"),
    (L + "Up's sum against c", [("s[2] = i16x8_add(s[2], cost16(i8x16_sub(x, b)));", "s[2] = i16x8_add(s[2], cost16(i8x16_sub(x, c)));")], "killed"),
    (L + "first pixel's sums with c = b", [("tot[t as usize] += cost(filtered(t, x, 0, b, 0));", "tot[t as usize] += cost(filtered(t, x, 0, b, b));")], "killed"),
    (L + "first pixel's Paeth with c = b", [("            o[i] = filtered(4, x, 0, b, 0);", "            o[i] = filtered(4, x, 0, b, b);")], "killed"),
    (L + "first pixel three bytes", [("        // the first pixel: nothing to its left (a = c = 0)\n        for i in 0..4 {", "        // the first pixel: nothing to its left (a = c = 0)\n        for i in 0..3 {")], "killed"),
    (L + "tail's sums with c = b", [("let (x, a, b, c) = (row[i], row[i - 4], above(i), above_left(i));", "let (x, a, b, c) = (row[i], row[i - 4], above(i), above(i));")], "killed"),
    (L + "end a group more", [("let end = 4 + (n - 4) / 16 * 16;", "let end = 4 + (n - 4 + 15) / 16 * 16;")], "killed"),
    (L + "end a group less", [("let end = 4 + (n - 4) / 16 * 16;", "let end = 4 + ((n - 4) / 16).saturating_sub(1) * 16;")],
     "equivalent: the bytes of the dropped group go through the scalar tail, which computes the same sums and bytes (only slower)"),
    (L + "rewrite: Sub written as Up", [("                1 => a,\n                2 => b,", "                1 => b,\n                2 => b,")], "killed"),
    (L + "rewrite: Average written as Sub", [("                2 => b,\n                _ => avg(a, b),", "                2 => b,\n                _ => a,")], "killed"),
    (L + "rewrite: Up without the row above", [("            let b = if UP { v128_load(u.add(i) as *const v128) } else { u8x16_splat(0) };", "            let b = u8x16_splat(0);")], "killed"),
    (L + "rewrite: first pixel's a = x", [("            o[i] = filtered(best, row[i], 0, above(i), 0);", "            o[i] = filtered(best, row[i], row[i], above(i), 0);")], "killed"),
    (L + "rewrite: None not copied", [("                o.copy_from_slice(row);\n", "")], "killed"),
    (L + "dispatch: MIN 4 bytes", [("pub const MIN: usize = 4 + 16;", "pub const MIN: usize = 4;")],
     "equivalent: a row of 4..19 bytes has end = 4, so the lanes run no group and the scalar head and tail compute filter_row's sums and bytes"),
    (L + "dispatch: the row above dropped", [("Some(u) => lanes::filter_row::<true>(row, &u[..row.len()], out),", "Some(_) => lanes::filter_row::<false>(row, &[], out),")], "killed"),
    (L + "dispatch: no row above as ones", [("None => lanes::filter_row::<false>(row, &[], out),", "None => lanes::filter_row::<true>(row, &vec![1u8; row.len()], out),")], "killed"),
    # ---- the scalar code (the scalar build's whole writer; the SIMD build's rows under 5 px, first pixels, tails)
    (S + "filter_row: best on ties the later", [("        if sums[t as usize] < sums[best as usize] {", "        if sums[t as usize] <= sums[best as usize] {")], "killed"),
    (S + "filter_row: Average's sum rounded up", [("        sums[3] += cost(x.wrapping_sub(((a as u16 + b as u16) >> 1) as u8));", "        sums[3] += cost(x.wrapping_sub(((a as u16 + b as u16 + 1) >> 1) as u8));")], "killed"),
    (S + "filter_row: Paeth's sum with c = b", [("        sums[4] += cost(x.wrapping_sub(paeth(a, b, c)));", "        sums[4] += cost(x.wrapping_sub(paeth(a, b, b)));")], "killed"),
    (S + "filter_row: the sums' c of the first pixel", [("            None => (0, 0),\n        };\n        sums[0] += cost(x);", "            None => (0, 0),\n        };\n        let c = if i < 4 { b } else { c };\n        sums[0] += cost(x);")], "killed"),
    (S + "filter_row: output's a from byte 5", [("    for i in 0..n {\n        let a = if i >= 4 { row[i - 4] } else { 0 };\n        let (b, c) = match up {\n            Some(u) => (u[i], if i >= 4 { u[i - 4] } else { 0 }),\n            None => (0, 0),\n        };\n        o[i]",
                                                  "    for i in 0..n {\n        let a = if i > 4 { row[i - 4] } else { 0 };\n        let (b, c) = match up {\n            Some(u) => (u[i], if i >= 4 { u[i - 4] } else { 0 }),\n            None => (0, 0),\n        };\n        o[i]")], "killed"),
    (S + "filter_row: the type byte capped at Average", [("    out[0] = best;\n    let o = &mut out[1..1 + n];", "    out[0] = best.min(3);\n    let o = &mut out[1..1 + n];")], "killed"),
    (S + "cost: 255 - v", [("    if v < 128 { v as u32 } else { 256 - v as u32 }", "    if v < 128 { v as u32 } else { 255 - v as u32 }")], "killed"),
    (S + "paeth: pa < pb", [("    if pa <= pb && pa <= pc {\n        a", "    if pa < pb && pa <= pc {\n        a")],
     "equivalent: the same reason as the lanes' pa<=pb (and the reader's unfilter, which shares paeth, is the same function)"),
    (S + "paeth: pb < pc", [("    } else if pb <= pc {\n        b", "    } else if pb < pc {\n        b")], "killed"),
    (S + "filtered: Average rounded up", [("        3 => x.wrapping_sub(((a as u16 + b as u16) >> 1) as u8),\n        _ => x.wrapping_sub(paeth(a, b, c)),", "        3 => x.wrapping_sub(((a as u16 + b as u16 + 1) >> 1) as u8),\n        _ => x.wrapping_sub(paeth(a, b, c)),")], "killed"),
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


def gate(tree, out, name):
    env = dict(os.environ, SCUMBLE_GATES=os.path.join(out, "gates"))
    label = "mut-" + "".join(ch if ch.isalnum() else "_" for ch in name)[:60]
    rc, txt = run(["bash", "tools/run_gates.sh", label, "--offline", "--tiles", "on", "export"], tree, os.path.join(out, "logs", safe(name) + ".txt"), 1800, env)
    summ = os.path.join(out, "gates", "gates", label, "summary.txt")
    body = open(summ, encoding="utf-8", errors="replace").read() if os.path.exists(summ) else ""
    shutil.rmtree(os.path.join(out, "gates", "profiles"), ignore_errors=True)
    return rc == 0 and "FAIL" not in body, body.strip().splitlines()[-1:] if body else ["no summary"]


def safe(name):
    return "".join(ch if ch.isalnum() else "_" for ch in name)


def go(tree, out, only):
    os.makedirs(os.path.join(out, "logs"), exist_ok=True)
    png = os.path.join(tree, "crates", "px", "src", "png.rs")
    orig = open(png, encoding="utf-8").read()
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
        return ("green: px_test and the export gate" if ok else f"red: the export gate ({tail})"), hashes

    line(f"== W1 mutation round {time.strftime('%Y-%m-%d %H:%M')} on {tree}")
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
        open(png, "w", encoding="utf-8", newline=chr(10)).write(s)
        t = time.time()
        verdict, h = build_and_test(name, False)
        if verdict == "green: px_test":
            ok, tail = gate(tree, out, name)
            verdict = "green: px_test and the export gate" if ok else f"red: the export gate ({tail})"
        red = verdict.startswith("red") or verdict == "build failed"
        kills += red
        surv += not red
        flag = "" if red == (expected == "killed") else "  <-- NOT AS EXPECTED"
        line(f"{'KILLED  ' if red else 'SURVIVED'} {name}: {verdict}; builds {h}; {time.time() - t:.0f} s; expected {expected}{flag}")
    open(png, "w", encoding="utf-8", newline=chr(10)).write(orig)
    verdict, h = build_and_test("restored copy", False)
    same = all(sha(os.path.join(tree, "renderer", "editor", "px", n)) == want[n] for n in want)
    line(f"restored copy: {verdict}; both builds identical to F:/canvas's: {same}")
    line(f"mutants: {kills} killed, {surv} survived of {kills + surv}")


if __name__ == "__main__":
    if sys.argv[1] == "make":
        make(sys.argv[2])
    else:
        go(sys.argv[2], sys.argv[3], sys.argv[4:])
