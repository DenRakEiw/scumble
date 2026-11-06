"""K5's mutation round on a copy of the tree (docs/PLAN_WASM_BUILD.md §1.3; memory note scumble-mutation-copy-tree).

Each mutant: apply (its `old` must occur once), rebuild both wasm builds for a Rust mutant, then the kill set in order,
stopping at the first red: node tools/combine_test.js, node tools/px_test.js, then the gates selection pixels editor
pxjobs on tiles (offline, a fresh instance per run_gates call). Restore after each (the file, and for Rust the two
wasm files from the backup), so every mutant runs on the untouched tree plus itself.

    python mutate_k5.py baseline        # the untouched copy must PASS the whole kill set first
    python mutate_k5.py run [names]     # all mutants (or the named ones); results appended to results.jsonl
    python mutate_k5.py restored        # the restored copy: build --check identical and the Node tests PASS
"""
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.join(HERE, "tree")
LOGS = os.path.join(HERE, "logs")
GATES = os.path.join(HERE, "gates")
RESULTS = os.path.join(HERE, "results.jsonl")
BASH = r"C:\Program Files\Git\bin\bash.exe"
os.makedirs(LOGS, exist_ok=True)

SEL = "crates/px/src/sel.rs"
KJ = "renderer/editor/px/kernels_js.js"
KS = "renderer/editor/px/kernels.js"
PXJ = "renderer/editor/px/px.js"
RAS = "renderer/editor/inpaint_raster.js"
TIL = "renderer/editor/inpaint_tiles.js"

M = [
    # ---- Rust (sel.rs): both builds rebuilt
    ("R01 scalar mul255 without its correction", SEL, "    let t = x * y + 128;\n    (t + (t >> 8)) >> 8\n}", "    let t = x * y + 128;\n    t >> 8\n}"),
    ("R02 SIMD mul255 without its correction", SEL, "u32x4_shr(i32x4_add(t, u32x4_shr(t, 8)), 8)", "u32x4_shr(t, 8)"),
    ("R03 SIMD subtract without its clamp (equivalent: mul255(d, s) <= d)", SEL, "2 => i32x4_max(i32x4_sub(d, mul255(d, s)), u32x4_splat(0)),", "2 => i32x4_sub(d, mul255(d, s)),"),
    ("R04 SIMD subtract clamped at 1", SEL, "2 => i32x4_max(i32x4_sub(d, mul255(d, s)), u32x4_splat(0)),", "2 => i32x4_max(i32x4_sub(d, mul255(d, s)), u32x4_splat(1)),"),
    ("R05 scalar subtract takes one more", SEL, "2 => d.saturating_sub(mul255(d, s)),", "2 => d.saturating_sub(mul255(d, s) + 1),"),
    ("R06 SIMD first pixel from the lane group's start", SEL, "first = x + bits.trailing_zeros() as usize;", "first = x;"),
    ("R07 SIMD last pixel the group's end", SEL, "last = x + (31 - bits.leading_zeros()) as usize;", "last = x + 3;"),
    ("R08 FRESH ignored", SEL, "let fresh = mode & FRESH != 0;", "let fresh = false;"),
    ("R09 a fresh tile's rest not zeroed", SEL, "            row[from * 4..].fill(0);", "            rest_of_row(row, from, size, &mut first, &mut last);"),
    ("R10 rest_of_row's last pixel its first", SEL, "    let mut e = size - 1;", "    let mut e = x;"),
    ("R11 rest_of_row's first pixel at `from`", SEL, "    if *first == usize::MAX {\n        *first = x;\n    }", "    if *first == usize::MAX {\n        *first = from;\n    }"),
    ("R12 SIMD RGBA alpha from the third byte", SEL, "_ => u32x4_shr(v128_load(s.add(x * 4) as *const v128), 24),", "_ => u32x4_shr(v128_load(s.add(x * 4) as *const v128), 16),"),
    ("R13 scalar alpha source halved", SEL, "KIND_ALPHA => s[x] as u32,", "KIND_ALPHA => s[x] as u32 / 2,"),
    ("R14 scalar add is max", SEL, "1 => d + s - mul255(d, s),", "1 => d.max(s),"),
    ("R15 extent's x1 not exclusive", SEL, "ext[2] = (x1 + 1) as i32;", "ext[2] = x1 as i32;"),
    ("R16 SIMD colour's red and blue swapped", SEL, "let colour = (r as u32) | ((g as u32) << 8) | ((b as u32) << 16);", "let colour = (b as u32) | ((g as u32) << 8) | ((r as u32) << 16);"),
    # ---- the twin and alphaAny (kernels_js.js)
    ("J01 twin table's mul255 without its correction", KJ, "const mul255 = (x, y) => { const t = x * y + 128; return (t + (t >> 8)) >> 8; };", "const mul255 = (x, y) => { const t = x * y + 128; return t >> 8; };"),
    ("J02 twin words path drops the colour", KJ, "d32[o] = ((a << 24) | RGB) >>> 0;", "d32[o] = (a << 24) >>> 0;"),
    ("J03 twin bytes path red and blue swapped", KJ, "d8[o] = r; d8[o + 1] = g; d8[o + 2] = b; d8[o + 3] = a;", "d8[o] = b; d8[o + 1] = g; d8[o + 2] = r; d8[o + 3] = a;"),
    ("J04 twin rest of row's last its first", KJ, "            let e = size - 1;\n            while (e > x && !d8[at + e * 4]) e--;", "            let e = x;\n            while (e > x && !d8[at + e * 4]) e--;"),
    ("J05 twin extent's x1 not exclusive", KJ, "return y0 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];", "return y0 < 0 ? null : [x0, y0, x1, y1 + 1];"),
    ("J06 twin source length unchecked", KJ, "if (!(stride >= bw) || !(off >= 0) || !src || src.length < (off + (bh - 1) * stride + bw) * bpp) return \"a source too small\";", "if (!src) return \"a source too small\";"),
    ("J07 twin reads the source with no pixel to combine", KJ, "(kind === SEL_ALPHA || kind === SEL_RGBA) && bw > 0 && bh > 0 ? bytesOf(src) : null;", "kind === SEL_ALPHA || kind === SEL_RGBA ? bytesOf(src) : null;"),
    ("J08 alphaAny above 128 only", KJ, "p += bpp) if (s[p]) return true;", "p += bpp) if (s[p] > 128) return true;"),
    ("J09 alphaAny full is nothing", KJ, "    if (kind === SEL_FULL) return true;\n    if (kind !== SEL_ALPHA", "    if (kind === SEL_FULL) return false;\n    if (kind !== SEL_ALPHA"),
    ("J10 alphaAny reads RGBA's red", KJ, "a = kind === SEL_RGBA ? 3 : 0;", "a = 0;"),
    # ---- the route (kernels.js)
    ("K01 the route read under another name", KS, "const p = rustPx(\"selCombine\");", "const p = rustPx(\"mips\");"),
    ("K02 a missing tile made without alphaAny", KS, "if (!dst && (mode >= 2 || !J.alphaAny(src, off, stride, kind, bw, bh))) return null;", "if (!dst && mode >= 2) return null;"),
    # ---- px.js
    ("P01 a missing tile not FRESH", PXJ, "mode | (dst ? 0 : 8)", "mode"),
    ("P02 packed rows keep the long stride", PXJ, "                    sStride = bw;", "                    sStride = stride;"),
    ("P03 packed rows all at the first row", PXJ, "u8.set(new Uint8Array(src.buffer, at, row), ps + y * row);", "u8.set(new Uint8Array(src.buffer, at, row), ps);"),
    ("P04 a short tile view unchecked", PXJ, "if (dst && !(dst.length >= n)) throw new Error(\"px: sel_combine: a tile too small\");", ""),
    ("P05 a short source view unchecked", PXJ, "if (bpp && bw > 0 && bh > 0 && (!src || !(stride >= bw) || !(off >= 0) || src.length < (off + (bh - 1) * stride + bw) * bpp)) {", "if (bpp && bw > 0 && bh > 0 && !src) {"),
    ("P06 write() called for an empty result", PXJ, "            if (!r) return null;\n            const e = this.view(Int32Array, pe, 4)", "            if (!r) { write(); return null; }\n            const e = this.view(Int32Array, pe, 4)"),
    ("P07 the extent's y1 read as x1", PXJ, "ext = [e[0], e[1], e[2], e[3]];", "ext = [e[0], e[1], e[2], e[2]];"),
    # ---- the views (inpaint_raster.js)
    ("V01 bytesSource view's offset without its rows", RAS, "off: (ry - y0) * w + (rx - x0), stride: w", "off: (rx - x0), stride: w"),
    ("V02 bytesSource view across the source's edge", RAS, "if (rx < x0 || ry < y0 || rx + rw > x0 + w || ry + rh > y0 + h) return null;", "if (false) return null;"),
    ("V03 tilesSource view across two source tiles", RAS, "if (rw <= 0 || rh <= 0 || rx + rw > tileX + 256 || ry + rh > tileY + 256) return null;", "if (rw <= 0 || rh <= 0) return null;"),
    ("V04 tilesSource view's offset without its rows", RAS, "const off = (ry - tileY) * 256 + (rx - tileX);", "const off = (rx - tileX);"),
    ("V05 tilesSource view at a fractional origin", RAS, "if ((ox | 0) !== ox || (oy | 0) !== oy || (rx | 0) !== rx || (ry | 0) !== ry) return null;", ""),
    ("V06 rectSource full when it starts inside", RAS, "if (rx >= bx0 && ry >= by0 && rx + rw <= bx1 && ry + rh <= by1) return VIEW_FULL;", "if (rx >= bx0 && ry >= by0) return VIEW_FULL;"),
    ("V07 tilesSource full tile covers nothing", RAS, "if (t.full) return VIEW_FULL;", "if (t.full) return VIEW_NONE;"),
    ("V08 tilesSource RGBA tile read as alpha", RAS, "return d.length >= 262144 ? { kind: 4, data: d, off, stride: 256 } : null;", "return d.length >= 262144 ? { kind: 1, data: d, off, stride: 256 } : null;"),
    # ---- the call site (inpaint_tiles.js combine, invert)
    ("C01 fill: a new edge tile's extent the whole tile", TIL, "const ext = !had ? [0, 0, bw, bh] :", "const ext = !had ? [0, 0, TILE_SIZE, TILE_SIZE] :"),
    ("C02 fill path under subtract too", TIL, "if (v.kind === SEL_FULL && m <= 1 && LITTLE) {", "if (v.kind === SEL_FULL && m <= 2 && LITTLE) {"),
    ("C03 kernel path's extent the whole tile", TIL, "if (!ext) { this._dropTile(key); continue; }\n                t.ext = ext;", "if (!ext) { this._dropTile(key); continue; }\n                t.ext = [0, 0, TILE_SIZE, TILE_SIZE];"),
    ("C04 kernel path's extent never fresh", TIL, "                t.ext = ext;\n                t.extVersion = t.version;", "                t.ext = ext;"),
    ("C05 fill path's extent never fresh", TIL, "if (ext) { t.ext = ext; t.extVersion = t.version; }", "if (ext) { t.ext = ext; }"),
    ("C06 the old tile not given to the kernel", TIL, "const ext = selCombine(had ? had.data : null,", "const ext = selCombine(null,"),
    ("C07 combine's colour unclamped", TIL, "        const [cr, cg, cb] = Uint8ClampedArray.of(color[0], color[1], color[2]);\n        const rgb", "        const [cr, cg, cb] = color;\n        const rgb"),
    ("C08 invert's colour unclamped", TIL, "        const [cr, cg, cb] = Uint8ClampedArray.of(color[0], color[1], color[2]);\n        // the colour without alpha", "        const [cr, cg, cb] = color;\n        // the colour without alpha"),
    ("C09 an empty result's tile kept", TIL, "if (!ext) { this._dropTile(key); continue; }", "if (!ext) { continue; }"),
    ("C10 fill: an edge tile filled beyond the image", TIL, "else for (let y = 0; y < bh; y++) w.fill(SEL, y * TILE_SIZE, y * TILE_SIZE + bw);\n                    // a new tile is 0", "else w.fill(SEL, 0, bh * TILE_SIZE);\n                    // a new tile is 0"),
]


def sh(cmd, log, timeout=3600, env=None):
    t0 = time.time()
    with open(log, "w", encoding="utf-8", errors="replace") as f:
        p = subprocess.run(cmd, cwd=TREE, stdout=f, stderr=subprocess.STDOUT, timeout=timeout, env=env)
    return p.returncode, time.time() - t0


def node_test(name, tag):
    return sh(["node", f"tools/{name}"], os.path.join(LOGS, f"{tag}_{name}.log"), timeout=900)


def gates(tag):
    env = dict(os.environ, SCUMBLE_GATES=GATES.replace("\\", "/"))
    label = f"mut-{tag}"
    rc, dt = sh([BASH, "tools/run_gates.sh", label, "--offline", "--tiles", "on", "selection", "pixels", "editor", "pxjobs"],
                os.path.join(LOGS, f"{tag}_gates.log"), timeout=3600, env=env)
    shutil.rmtree(os.path.join(GATES, "profiles"), ignore_errors=True)
    summ = os.path.join(GATES, "gates", label, "summary.txt")
    text = open(summ, encoding="utf-8", errors="replace").read() if os.path.exists(summ) else ""
    return rc, dt, text


def build_rust(tag):
    return sh(["python", "tools/build_px.py"], os.path.join(LOGS, f"{tag}_build.log"), timeout=1800)


def kill_set(tag, with_gates=True):
    """The first red of the kill set: (killed_by or None, details)."""
    out = {}
    for name in ("combine_test.js", "px_test.js"):
        rc, dt = node_test(name, tag)
        out[name] = [rc, round(dt)]
        if rc != 0:
            return name, out
    if not with_gates:
        return None, out
    rc, dt, text = gates(tag)
    out["gates"] = [rc, round(dt), " | ".join(l for l in text.splitlines() if l.strip())]
    if rc != 0:
        return "gates", out
    return None, out


WASM = ["renderer/editor/px/px.wasm", "renderer/editor/px/px_scalar.wasm"]


def backup_wasm():
    bk = os.path.join(HERE, "wasm_backup")
    os.makedirs(bk, exist_ok=True)
    for w in WASM:
        shutil.copy2(os.path.join(TREE, w), os.path.join(bk, os.path.basename(w)))


def restore_wasm():
    bk = os.path.join(HERE, "wasm_backup")
    for w in WASM:
        shutil.copy2(os.path.join(bk, os.path.basename(w)), os.path.join(TREE, w))


def run_one(name, path, old, new):
    tag = name.split()[0]
    full = os.path.join(TREE, path)
    src = open(full, "rb").read()
    text = src.decode("utf-8")
    n = text.count(old)
    if n != 1:
        return {"mutant": name, "error": f"`old` occurs {n} times in {path}"}
    open(full, "wb").write(text.replace(old, new).encode("utf-8"))
    rec = {"mutant": name, "file": path}
    try:
        if path.endswith(".rs"):
            rc, dt = build_rust(tag)
            rec["build"] = [rc, round(dt)]
            if rc != 0:
                rec["killed_by"] = "build (not a valid mutant)"
                return rec
        killed, details = kill_set(tag)
        rec["killed_by"] = killed
        rec["details"] = details
        return rec
    finally:
        open(full, "wb").write(src)
        if path.endswith(".rs"):
            restore_wasm()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    what = sys.argv[1] if len(sys.argv) > 1 else "run"
    if what == "baseline":
        rc, dt = sh(["python", "tools/build_px.py", "--check"], os.path.join(LOGS, "base_buildcheck.log"), timeout=1800)
        print("build --check", rc, round(dt), open(os.path.join(LOGS, "base_buildcheck.log"), encoding="utf-8").read().count("identical"), "identical")
        backup_wasm()
        killed, details = kill_set("base")
        print("baseline:", "PASS" if killed is None and rc == 0 else f"FAIL ({killed})", json.dumps(details))
        return
    if what == "restored":
        rc, dt = sh(["python", "tools/build_px.py", "--check"], os.path.join(LOGS, "restored_buildcheck.log"), timeout=1800)
        killed, details = kill_set("restored", with_gates=False)
        ident = open(os.path.join(LOGS, "restored_buildcheck.log"), encoding="utf-8").read().count("identical")
        print("restored tree:", "PASS" if killed is None and rc == 0 and ident == 2 else "FAIL", json.dumps(details), f"build --check rc {rc}, {ident} identical")
        return
    names = sys.argv[2:]
    for name, path, old, new in M:
        if names and name.split()[0] not in names:
            continue
        rec = run_one(name, path, old, new)
        with open(RESULTS, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
        print(name, "->", rec.get("killed_by") or rec.get("error") or "SURVIVED", flush=True)


if __name__ == "__main__":
    main()
