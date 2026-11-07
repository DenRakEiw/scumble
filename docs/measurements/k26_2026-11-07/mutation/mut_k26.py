"""K26's mutation round (docs/PLAN_WASM_BUILD.md §1.3, §1.4: full on the kernel and on the call site) on a copy of the
tree, never on F:/canvas.

    python mut_k26.py make TREE                 TREE = the tracked files of HEAD (git archive) plus K26's working files,
                                                node_modules as a junction to F:/canvas/node_modules
    python mut_k26.py run TREE OUT [names...]   orig first (the untouched copy must PASS and build F:/canvas's bytes),
                                                then each mutant: a Rust one rebuilt on both builds; the kill set
                                                `node tools/px_test.js` in TREE (blur_rgba / sharpen_rgba against
                                                inpaint_stroke.js on both builds, the refusals); a mutant px_test leaves
                                                green (and every call-site mutant) runs the `editor` gate on a fresh
                                                instance from TREE (`--offline --tiles on`: the blur and sharpen steps
                                                and frequency separation, each asserting Rust ran and the twins' route
                                                gives the same bytes); then every file restored, rebuilt, both builds
                                                compared with F:/canvas's and px_test once more ("restored copy").
"""
import hashlib
import os
import shutil
import subprocess
import sys
import time

REPO = r"F:\canvas"
WORKING = ["crates/px/src/maskf.rs", "crates/px/src/stroke.rs", "crates/px/src/lib.rs", "renderer/editor/px/px.wasm", "renderer/editor/px/px_scalar.wasm",
           "renderer/editor/px/px.js", "renderer/editor/px/kernels.js", "renderer/editor/inpaint_canvas.js", "tools/px_test.js", "tools/editor_test.py"]
ST = "crates/px/src/stroke.rs"
MF = "crates/px/src/maskf.rs"
PJ = "renderer/editor/px/px.js"
KJ = "renderer/editor/px/kernels.js"
IC = "renderer/editor/inpaint_canvas.js"

MUTANTS = [
    # ---- stroke.rs: the premultiply, the passes, the unpremultiply, sharpen
    ("premultiply by 1/256", ST, [("        let al = src[i + 3] as f64 / 255.0;", "        let al = src[i + 3] as f64 / 256.0;")], "killed"),
    ("premultiply: green from red", ST, [("        a[i + 1] = (src[i + 1] as f64 * al) as f32;", "        a[i + 1] = (src[i] as f64 * al) as f32;")], "killed"),
    ("premultiply: the alpha premultiplied too", ST, [("        a[i + 3] = src[i + 3] as f32;", "        a[i + 3] = (src[i + 3] as f64 * al) as f32;")], "killed"),
    ("two passes, not three", ST, [("        for _ in 0..3 {", "        for _ in 0..2 {")], "killed"),
    ("the passes' factor as a divisor", ST, [("        let k = Norm::Mul(1.0 / (2 * r + 1) as f64);", "        let k = Norm::Div((2 * r + 1) as f64);")], "equivalent on this kernel's inputs: the last f64 bit never reaches a byte (K26's review)"),
    ("unpremultiply: transparent below 1, not 0.5", ST, [("        if al < 0.5 {", "        if al < 1.0 {")], "killed"),
    ("unpremultiply: a transparent pixel's bytes not written", ST, [("            out[i] = 0;\n            out[i + 1] = 0;\n            out[i + 2] = 0;\n            out[i + 3] = 0;\n            continue;", "            continue;")], "killed (the arena is reused, never zeroed)"),
    ("unpremultiply by 256 / alpha", ST, [("        let k = 255.0 / al;", "        let k = 256.0 / al;")], "killed"),
    ("the alpha truncated", ST, [("        out[i + 3] = clamp8(al);", "        out[i + 3] = al as u8;")], "killed"),
    ("clamp8: 254 the top", ST, [("    } else if v >= 255.0 {\n        255", "    } else if v >= 254.0 {\n        254")], "killed"),
    ("sharpen: a transparent blur not kept", ST, [("        if sa == 0 || ba == 0 {", "        if sa == 0 {")], "killed"),
    ("sharpen: the difference reversed", ST, [("                out[i + c] = clamp8(s + amount * (s - out[i + c] as f64));", "                out[i + c] = clamp8(s + amount * (out[i + c] as f64 - s));")], "killed"),
    ("sharpen: the blur's alpha kept", ST, [("        out[i + 3] = sa;\n    }", "        out[i + 3] = ba;\n    }")], "killed"),
    # ---- maskf.rs: the four-channel lanes and Mul (reachable since K26)
    ("rows4: channels 2-3 from 0-1", MF, [("                hi = f64x2_add(hi, high(q));", "                hi = f64x2_add(hi, f64x2_promote_low_f32x4(q));")], "killed"),
    ("rows4: enter and leave swapped", MF, [("                lo = f64x2_add(lo, f64x2_sub(f64x2_promote_low_f32x4(qa), f64x2_promote_low_f32x4(qs)));", "                lo = f64x2_add(lo, f64x2_sub(f64x2_promote_low_f32x4(qs), f64x2_promote_low_f32x4(qa)));")], "killed"),
    ("rows4: the sum moved as (sum + enter) - leave", MF, [("                hi = f64x2_add(hi, f64x2_sub(high(qa), high(qs)));", "                hi = f64x2_sub(f64x2_add(hi, high(qa)), high(qs));")], "equivalent on this kernel's inputs: premultiplied byte values keep the window sums exact in f64 (K26's review; no float user of four channels is planned)"),
    ("rows4: four channels left to the scalar loop", MF, [("                (4, Norm::Mul(k)) => rows4::<false>(s, d, w, h, r, f64x2_splat(k)),", "                (4, Norm::Mul(_)) => 0,")], "equivalent: the scalar loop gives the same values"),
    ("apply: multiply as divide", MF, [("        if DIV { f64x2_div(s, v) } else { f64x2_mul(s, v) }", "        if DIV { f64x2_div(s, v) } else { f64x2_div(s, v) }")], "killed"),
    ("Norm::of: multiply as divide", MF, [("            Norm::Mul(k) => s * k,", "            Norm::Mul(k) => s / k,")], "killed"),
    ("Norm::of: divide by a reciprocal (K4's, rerun on the whole test)", MF, [("            Norm::Div(n) => s / n,", "            Norm::Div(n) => s * (1.0 / n),")], "killed: the last bit on the wide-range floats, or equivalent where it never reaches an f32"),
    # ---- px.js: the wrapper
    ("px.js: the radius floored", PJ, [("        r = Math.max(0, Math.round(r));\n        const ri = r > 0 ? r : 0;", "        r = Math.max(0, Math.floor(r));\n        const ri = r > 0 ? r : 0;")], "killed"),
    ("px.js: a short source not refused", PJ, [("ri > 0x3fffffff || !(src && src.length >= n)) return null;", "ri > 0x3fffffff) return null;")], "killed"),
    ("px.js: sharpen's amount dropped", PJ, [("this.exports.sharpen_rgba(ps, po, pt, w, h, ri, amount)", "this.exports.sharpen_rgba(ps, po, pt, w, h, ri, 1)")], "killed"),
    # ---- the call site: kernels.js and inpaint_canvas.js (the editor gate)
    ("kernels.js: blur always the twin", KJ, [("    const p = rustPx(\"dabBlur\");\n    if (p) {\n        try { const out = p.blurRGBA(src, w, h, r); if (out) return out; }", "    const p = null;\n    if (p) {\n        try { const out = p.blurRGBA(src, w, h, r); if (out) return out; }")], "killed: the editor gate asserts blur_rgba ran"),
    ("kernels.js: the route ignored", KJ, [("    const p = rustPx(\"dabBlur\");\n    if (p) {\n        try { const out = p.blurRGBA(src, w, h, r); if (out) return out; }", "    const p = rustPx();\n    if (p) {\n        try { const out = p.blurRGBA(src, w, h, r); if (out) return out; }")], "killed: the editor gate's twin arm asserts no blur_rgba ran"),
    ("kernels.js: sharpen's amount dropped", KJ, [("try { const out = p.sharpenRGBA(src, w, h, r, amount); if (out) return out; }", "try { const out = p.sharpenRGBA(src, w, h, r); if (out) return out; }")], "survives on px_test (it calls px.js), killed only if the editor's amount is not 1: the brush passes 1, so equivalent there"),
    ("inpaint_canvas.js: the dabs on the twins again", IC, [("compositeTile, poissonBlend as poissonBlendKernel, distTransform, blurRGBA, sharpenRGBA } from \"./px/kernels.js\";", "compositeTile, poissonBlend as poissonBlendKernel, distTransform } from \"./px/kernels.js\";\nimport { blurRGBA, sharpenRGBA } from \"./inpaint_stroke.js\";")], "killed: the editor gate asserts blur_rgba / sharpen_rgba ran"),
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
        os.makedirs(os.path.dirname(os.path.join(tree, rel)), exist_ok=True)
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
    env = dict(os.environ, SCUMBLE_GATES=os.path.join(out, "gates"), SCUMBLE_CDP_PORT="9555")
    label = "mut-" + safe(name)[:60]
    rc, txt = run(["bash", "tools/run_gates.sh", label, "--offline", "--tiles", "on", "editor"], tree, os.path.join(out, "logs", safe(name) + ".txt"), 2400, env)
    summ = os.path.join(out, "gates", "gates", label, "summary.txt")
    body = open(summ, encoding="utf-8", errors="replace").read() if os.path.exists(summ) else ""
    shutil.rmtree(os.path.join(out, "gates", "profiles"), ignore_errors=True)
    return rc == 0 and "FAIL" not in body, body.strip().splitlines()[-1:] if body else ["no summary"]


def go(tree, out, only):
    os.makedirs(os.path.join(out, "logs"), exist_ok=True)
    origs = {rel: open(os.path.join(tree, rel), encoding="utf-8").read() for rel in {m[1] for m in MUTANTS}}
    want = {n: sha(os.path.join(REPO, "renderer", "editor", "px", n)) for n in ("px.wasm", "px_scalar.wasm")}
    res = open(os.path.join(out, "results.txt"), "a", encoding="utf-8")

    def line(s):
        print(s, flush=True)
        res.write(s + "\n")
        res.flush()

    def test(name, rust, gate_too):
        log = os.path.join(out, "logs", safe(name) + ".txt")
        hashes = None
        if rust:
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
        return ("green: px_test and the editor gate" if ok else f"red: the editor gate ({tail})"), hashes

    line(f"== K26 mutation round {time.strftime('%Y-%m-%d %H:%M')} on {tree}")
    if not only or "orig" in only:
        verdict, h = test("orig (the untouched copy)", True, True)
        same = all(sha(os.path.join(tree, "renderer", "editor", "px", n)) == want[n] for n in want)
        line(f"orig (the untouched copy): {verdict}; both builds identical to F:/canvas's: {same}")
        if not verdict.startswith("green") or not same:
            line("the untouched copy is not green: no mutant is believed; stopping")
            return
    kills = surv = 0
    for name, rel, edits, expected in MUTANTS:
        if only and name not in only:
            continue
        s = origs[rel]
        for old, new in edits:
            assert s.count(old) == 1, (name, old[:60], s.count(old))
            s = s.replace(old, new)
        open(os.path.join(tree, rel), "w", encoding="utf-8", newline=chr(10)).write(s)
        t = time.time()
        rust = rel.endswith(".rs")
        verdict, h = test(name, rust, False)
        if verdict == "green: px_test":
            ok, tail = gate(tree, out, name)
            verdict = "green: px_test and the editor gate" if ok else f"red: the editor gate ({tail})"
        open(os.path.join(tree, rel), "w", encoding="utf-8", newline=chr(10)).write(origs[rel])
        red = verdict.startswith("red") or verdict == "build failed"
        kills += red
        surv += not red
        flag = "" if red == expected.startswith("killed") else "  <-- NOT AS EXPECTED"
        line(f"{'KILLED  ' if red else 'SURVIVED'} {name}: {verdict}; builds {h}; {time.time() - t:.0f} s; expected {expected}{flag}")
        if rust:
            run([sys.executable, "tools/build_px.py"], tree, os.path.join(out, "logs", safe(name) + ".txt"), 900)
    verdict, h = test("restored copy", True, False)
    same = all(sha(os.path.join(tree, "renderer", "editor", "px", n)) == want[n] for n in want)
    line(f"restored copy: {verdict}; both builds identical to F:/canvas's: {same}")
    line(f"mutants: {kills} killed, {surv} survived of {kills + surv}")


if __name__ == "__main__":
    if sys.argv[1] == "make":
        make(sys.argv[2])
    else:
        go(sys.argv[2], sys.argv[3], sys.argv[4:])
