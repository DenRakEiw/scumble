"""D0's mutation round, on a copy of the tree in the session's scratch folder (F:/canvas is never patched).

    python mutate.py module [name ...]    the reader (inpaint_layered.js): `node tools/layered_test.js` in a copy of
                                          renderer/editor and tools/layered_test.js
    python mutate.py wiring [name ...]    the job and the window (inpaint_worker.js, inpaint_canvas.js): the `layered`
                                          gate (tiles, offline) on a fresh instance of an app copy (electron, renderer,
                                          tools, plugins, recipes, build, prompts, package.json; node_modules a junction)

The untouched copy runs first and must PASS; every mutant must turn its test red. Before each app start the main
session's machine_busy.lock is waited for. Results in module_round.txt / wiring_round.txt beside this file.
"""
import os
import shutil
import subprocess
import sys
import time

ROOT = r"F:\canvas"
HERE = os.path.dirname(os.path.abspath(__file__))
SCRATCH = r"C:\Users\SCHOEN~1\AppData\Local\Temp\claude\F--canvas\543d44fb-4d2d-4818-8804-974916d10a44\scratchpad"
LOCK = os.path.join(SCRATCH, "machine_busy.lock")
LY = "renderer/editor/inpaint_layered.js"
WK = "renderer/editor/inpaint_worker.js"
PL = "renderer/editor/inpaint_pool.js"
CV = "renderer/editor/inpaint_canvas.js"

MODULE = [
    ("stream_gray", LY, "const index = stream.next++, per = stream.rows, sp = stream.sp;\n    const R = ch[0], G = gray ? ch[0] : ch[1],",
     "const index = stream.next++, per = stream.rows, sp = stream.sp;\n    const R = ch[0], G = ch[1],"),
    ("stream_alpha_default", LY, "out[o + 3] = A ? A[i] : 255;\n        }\n        sp.interleave", "out[o + 3] = A ? A[i] : 0;\n        }\n        sp.interleave"),
    ("band_start", LY, "        const out = new Uint8ClampedArray(n * w * 4);\n        for (let i = y0 * w, end = (y0 + n) * w, o = 0; i < end; i++, o += 4) {\n            out[o] = R",
     "        const out = new Uint8ClampedArray(n * w * 4);\n        for (let i = y0 * w + w, end = (y0 + n) * w + w, o = 0; i < end && i < w * h; i++, o += 4) {\n            out[o] = R"),
    ("last_band", LY, "    for (let y0 = 0; y0 < h; y0 += per) {\n        const n = Math.min(per, h - y0), t = clock();\n        const out = new Uint8ClampedArray(n * w * 4);\n        for (let i = y0 * w, end = (y0 + n) * w, o = 0; i < end; i++, o += 4) {\n            out[o] = R",
     "    for (let y0 = 0; y0 < h - 1; y0 += per) {\n        const n = Math.min(per, h - 1 - y0), t = clock();\n        const out = new Uint8ClampedArray(n * w * 4);\n        for (let i = y0 * w, end = (y0 + n) * w, o = 0; i < end; i++, o += 4) {\n            out[o] = R"),
    ("mask_white", LY, "{ out[o] = 255; out[o + 1] = 255; out[o + 2] = 255; out[o + 3] = maskData[i]; }", "{ out[o] = 0; out[o + 1] = 255; out[o + 2] = 255; out[o + 3] = maskData[i]; }"),
    ("mask_skip", LY, "    if (maskData) {\n        for (let y0 = 0;", "    if (false) {\n        for (let y0 = 0;"),
    ("mask_row_offset", LY, "            for (let i = y0 * w, end = (y0 + n) * w, o = 0; i < end; i++, o += 4) { out[o] = 255;", "            for (let i = 0, end = n * w, o = 0; i < end; i++, o += 4) { out[o] = 255;"),
    ("mask_meta_disabled", LY, "mask: mask ? { defaultColor: mask.defaultColor, disabled: mask.disabled } : null };", "mask: mask ? { defaultColor: mask.defaultColor, disabled: false } : null };"),
    ("composite_beside_layers", LY, "    if (stream && !layers.length && width > 0", "    if (stream && width > 0"),
    ("composite_never", LY, "        if (ch) composite = streamPixels(stream, ch, width, height, gray, null);\n", ""),
    ("composite_pos", LY, "merged picture to send\n        r.p = lmEnd;", "merged picture to send\n        r.p = lmEnd + 2;"),
    ("record_adjustment", LY, "    if (Object.keys(L.info).some((k) => ADJUSTMENTS.has(k))) return false;\n    return w > 0", "    return w > 0"),
    ("record_empty", LY, "    return w > 0 && h > 0 && !!L.ch[0];\n}", "    return w > 0 && h > 0;\n}"),
    ("header_hook", LY, "    if (stream && stream.onHeader) stream.onHeader({ width, height, depth, mode, channels });\n", ""),
    ("index_assign", LY, "layer.index = L.streamed.index; }", "layer.index = 0; }"),
    ("rgba_kept", LY, "        if (stream) { delete layer.rgba; layer.index", "        if (stream) { layer.index"),
    ("has_composite", LY, "    const hasComposite = composite != null;", "    const hasComposite = !!composite;"),
    ("merged_alpha", LY, "    const n = Math.min(channels, gray ? 2 : 4);\n    if (comp === 1) {", "    const n = Math.min(channels, gray ? 2 : 3);\n    if (comp === 1) {"),
    ("merged_raw", LY, "        for (let c = 0; c < n; c++) planes[c] = r.bytes(width * height * depth / 8).slice();", "        for (let c = 0; c < n; c++) planes[c] = r.bytes(width * height * depth / 8 - 1).slice();"),
    ("zero_area_merged", LY, "    if (stream && !layers.length && width > 0 && height > 0) {", "    if (stream && !layers.length) {"),
    ("merged_window", LY, "            if (ch) composite = interleave(ch, width, height, gray);", "            if (ch) composite = interleave(ch, width, height, false);"),
]

WIRING = [
    ("pool_off", CV, "    return InpaintEditor.psdOnPool !== false && typeof Worker", "    return false && typeof Worker"),
    ("band_y", CV, "e[key].writeRect({ data: new Uint8ClampedArray(m.rgba), width: m.w, height: m.rows }, 0, m.y0);", "e[key].writeRect({ data: new Uint8ClampedArray(m.rgba), width: m.w, height: m.rows }, 0, 0);"),
    ("mask_as_layer", CV, "if (!e[key]) e[key] = (m.mask ? Mask : Layer).empty(m.w, m.h);", "if (!e[key]) e[key] = Layer.empty(m.w, m.h);"),
    ("mask_into_layer", CV, "const key = m.mask ? \"maskPx\" : \"px\";", "const key = \"px\";"),
    ("window_header_check", CV, "(depth === 8 || depth === 16)) this.checkLayeredSize(v.getUint32(18), v.getUint32(14));", "(depth === 8 || depth === 16)) void 0;"),
    ("refused_fallback", CV, "            if (refused) throw refused;\n", ""),
    ("failed_fallback", CV, "if (r && r.failed) { drop(); throw new Error(r.failed); }", "if (r && r.failed) { drop(); return null; }"),
    ("mask_off", CV, "                    L.maskOff = !!L.mask.disabled;\n", "                    L.maskOff = false;\n"),
    ("take_index", CV, "const e = take(L.index, `layer \"${L.name}\"`);", "const e = take(0, `layer \"${L.name}\"`);"),
    ("composite_base", CV, "        else if (!layers.length && doc.compositePx) basePx = doc.compositePx;   // D0's pool route: already pixels\n", ""),
    ("worker_inflate", WK, "pipeThrough(new DecompressionStream(\"deflate\"));\n    return new Uint8Array(await new Response(stream).arrayBuffer());\n}\n\n/**\n * A PSD read",
     "pipeThrough(new DecompressionStream(\"deflate-raw\"));\n    return new Uint8Array(await new Response(stream).arrayBuffer());\n}\n\n/**\n * A PSD read"),
    ("worker_throws", WK, "        return { failed: String((err && err.message) || err), timing: timing() };", "        throw err;"),
    ("worker_mask_flag", WK, "progress: true, index, mask: kind === \"mask\", rgba", "progress: true, index, mask: false, rgba"),
    # the review round (2026-11-06): the stop of an open that is over, the pool's stopped count, no fallback after bands
    ("stop_ignored", CV, "                    if (later()) { stopped = true; throw new CancelledError(\"psd_read\"); }\n", ""),
    ("stop_pre_job", CV, "        if (later()) throw new CancelledError(\"psd_read\");\n        const Layer = this.pixels.Layer", "        const Layer = this.pixels.Layer"),
    ("stop_as_fallback", CV, "            if (stopped) throw new CancelledError(\"psd_read\");\n", ""),
    ("stop_counted_lost", PL, "job.cancelled = true; job.reject(err); this._lost(s, err, true); }", "job.cancelled = true; job.reject(err); this._lost(s, err); }"),
    ("later_not_destroyed", CV, "const later = () => this._destroyed || this._openToken !== token;", "const later = () => this._openToken !== token;"),
    ("later_not_passed", CV, "try { doc = await this.readLayered(file, kind, later); }", "try { doc = await this.readLayered(file, kind); }"),
    ("superseded_loud", CV, "try { doc = await this.readLayered(file, kind, later); } catch (err) { if (later()) return; throw err; }", "try { doc = await this.readLayered(file, kind, later); } catch (err) { throw err; }"),
    ("bands_fallback", CV, "            if (bands) throw new Error(`reading ${name} failed in its worker: ${(err && err.message) || err}`);\n", ""),
    ("no_doc_guard", CV, "        if (!r || !r.doc) { drop(); throw new Error(`reading ${name} failed in its worker: no answer`); }\n", ""),
]


def patch(text, old, new, name):
    assert text.count(old) == 1, "%s: the text occurs %d times" % (name, text.count(old))
    return text.replace(old, new)


def write(p, text):
    with open(p, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def read(p):
    with open(p, encoding="utf-8", newline="") as f:
        return f.read()


def wait_lock():
    t0 = time.time()
    while os.path.exists(LOCK) and time.time() - t0 < 45 * 60:
        time.sleep(60)
    return time.time() - t0


def copy_files(tree, rels):
    for rel in rels:
        dst = os.path.join(tree, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(os.path.join(ROOT, rel), dst)


def run_module(names):
    tree = os.path.join(SCRATCH, "d0", "mtree_module")
    shutil.rmtree(tree, ignore_errors=True)
    rels = [f for f in subprocess.run(["git", "ls-files", "renderer/editor"], cwd=ROOT, capture_output=True, text=True).stdout.split("\n") if f]
    rels += [LY, "tools/layered_test.js"]   # the working copies (uncommitted) win over the listed ones
    copy_files(tree, sorted(set(rels)))
    out = []

    def test():
        r = subprocess.run(["node", os.path.join(tree, "tools", "layered_test.js")], capture_output=True, text=True, encoding="utf-8", timeout=600)
        lines = r.stdout.strip().splitlines()
        fails = [l for l in lines if l.startswith("[FAIL]")]
        return r.returncode == 0 and lines and lines[-1] == "PASS", (fails[0][:220] if fails else (lines[-1] if lines else r.stderr[-200:]))

    ok, why = test()
    out.append(f"untouched copy: {'PASS' if ok else 'FAIL ' + why}")
    print(out[-1], flush=True)
    if not ok:
        return out
    orig = read(os.path.join(tree, LY))
    for name, rel, old, new in MODULE:
        if names and name not in names:
            continue
        p = os.path.join(tree, rel)
        base = read(p)
        write(p, patch(base, old, new, name))
        try:
            ok, why = test()
        except subprocess.TimeoutExpired:
            ok, why = False, "timed out"
        finally:
            write(p, base)
        out.append(f"{name:<26} {'SURVIVED' if ok else 'red'}  {why}")
        print(out[-1], flush=True)
    write(os.path.join(tree, LY), orig)
    ok, why = test()
    out.append(f"restored copy: {'PASS' if ok else 'FAIL ' + why}")
    print(out[-1], flush=True)
    return out


def run_wiring(names):
    tree = os.path.join(SCRATCH, "d0", "mtree_app")
    gates = os.path.join(SCRATCH, "d0", "mtree_gates")
    if not os.path.exists(os.path.join(tree, "package.json")):
        rels = [f for f in subprocess.run(["git", "ls-files", "electron", "renderer", "tools", "plugins", "recipes", "build", "prompts", "package.json"], cwd=ROOT, capture_output=True, text=True).stdout.split("\n") if f]
        copy_files(tree, rels)
        subprocess.run(["powershell", "-NoProfile", "-Command", f"New-Item -ItemType Junction -Path '{os.path.join(tree, 'node_modules')}' -Target '{os.path.join(ROOT, 'node_modules')}' | Out-Null"], check=True)
    # the working copies of the files this step changed
    copy_files(tree, [LY, WK, CV, PL, "tools/layered_test.js", "tools/layered_test.py", "tools/native_test.py"])
    out = []

    def test(label):
        w = wait_lock()
        env = dict(os.environ, SCUMBLE_GATES=gates)
        shutil.rmtree(os.path.join(gates, "gates", label), ignore_errors=True)
        r = subprocess.run(["bash", os.path.join(tree, "tools", "run_gates.sh"), label, "--offline", "--tiles", "on", "layered"], cwd=tree, env=env, capture_output=True, text=True, timeout=1200)
        log = os.path.join(gates, "gates", label, "layered.log")
        text = open(log, encoding="utf-8", errors="replace").read() if os.path.exists(log) else ""
        fails = [l for l in text.splitlines() if l.startswith("[FAIL]")]
        ok = "ALL PASS" in r.stdout
        return ok, (fails[0][:240] if fails else r.stdout.strip().splitlines()[-1] if r.stdout.strip() else "?") + (f" (waited {w:.0f} s for the lock)" if w > 1 else "")

    ok, why = test("mut-untouched")
    out.append(f"untouched copy: {'PASS' if ok else 'FAIL ' + why}")
    print(out[-1], flush=True)
    if not ok:
        return out
    for name, rel, old, new in WIRING:
        if names and name not in names:
            continue
        p = os.path.join(tree, rel)
        base = read(p)
        write(p, patch(base, old, new, name))
        try:
            ok, why = test("mut-" + name)
        finally:
            write(p, base)
        out.append(f"{name:<22} {'SURVIVED' if ok else 'red'}  {why}")
        print(out[-1], flush=True)
    ok, why = test("mut-restored")
    out.append(f"restored copy: {'PASS' if ok else 'FAIL ' + why}")
    print(out[-1], flush=True)
    return out


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    kind, names = sys.argv[1], sys.argv[2:]
    lines = run_module(names) if kind == "module" else run_wiring(names)
    with open(os.path.join(HERE, f"{kind}_round.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
