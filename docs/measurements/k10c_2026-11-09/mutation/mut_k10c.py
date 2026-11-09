"""Mutation round for K10c (clip_coverage, dissolve_rows, psdPackRowsFromPtr, psdPart, stackInto, compositeBox, stackPoints)."""
import json
import os
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
OUT_DIR = os.path.dirname(os.path.abspath(__file__))

MUTANTS = [
    # 1. Rust clip_coverage & dissolve_rows (crates/px/src/composite.rs)
    {
        "id": "R01_rust_clip_drop_own",
        "file": "crates/px/src/composite.rs",
        "rust": True,
        "test": "px_test",
        "find": "    if let Some(o) = own {\n        for i in start..px {\n            cov[i] = mul255(cov[i] as u32, o[i] as u32) as u8;\n        }\n    }",
        "replace": "    let _ = own;",
        "find2": "                if let Some(o) = own {\n                    v = mul255(v, v128_load(o.as_ptr().add(i) as *const v128));\n                }",
        "replace2": "                let _ = own;",
        "expect": "killed",
        "note": "K10c mutant 1a: drop own-mask multiplication in Rust clip_coverage (SIMD and scalar)",
    },
    {
        "id": "R02_rust_clip_drop_alpha",
        "file": "crates/px/src/composite.rs",
        "rust": True,
        "test": "px_test",
        "find": "    if alpha < 255 {\n        let a = alpha as u32;\n        for i in start..px {\n            cov[i] = mul255(cov[i] as u32, a) as u8;\n        }\n    }",
        "replace": "    let _ = alpha;",
        "find2": "                if alpha < 255 {\n                    v = mul255(v, av);\n                }",
        "replace2": "                let _ = av;",
        "expect": "killed",
        "note": "K10c mutant 1b: drop alpha < 255 multiplication in Rust clip_coverage (SIMD and scalar)",
    },
    {
        "id": "R03_rust_dissolve_drop_cval_255",
        "file": "crates/px/src/composite.rs",
        "rust": True,
        "test": "px_test",
        "find": "            let keep = (c_val == 255) || ((hash32(img_x, img_y, seed) >> 24) < c_val);",
        "replace": "            let keep = (hash32(img_x, img_y, seed) >> 24) < c_val;",
        "find2": "                let keep = v128_or(u32x4_eq(c_val, full), u32x4_lt(h_hi, c_val));",
        "replace2": "                let keep = u32x4_lt(h_hi, c_val); let _ = full;",
        "expect": "killed",
        "note": "K10c mutant 1c: remove c_val == 255 short-circuit in Rust dissolve_rows (SIMD and scalar)",
    },
    {
        "id": "R04_rust_dissolve_shift_16",
        "file": "crates/px/src/composite.rs",
        "rust": True,
        "test": "px_test",
        "find": "            let keep = (c_val == 255) || ((hash32(img_x, img_y, seed) >> 24) < c_val);",
        "replace": "            let keep = (c_val == 255) || ((hash32(img_x, img_y, seed) >> 16) < c_val);",
        "find2": "                let h_hi = u32x4_shr(h, 24);",
        "replace2": "                let h_hi = u32x4_shr(h, 16);",
        "expect": "killed",
        "note": "K10c mutant 1d: change >> 24 to >> 16 in Rust dissolve_rows (SIMD and scalar)",
    },
    {
        "id": "R05_rust_dissolve_zero_srca0_rgb",
        "file": "crates/px/src/composite.rs",
        "rust": True,
        "test": "px_test",
        "find": "            if src_a == 0 {\n                continue;\n            }",
        "replace": "            let _ = src_a;",
        "find2": "                let out = v128_bitselect(p, dissolved, is_zero);",
        "replace2": "                let out = dissolved; let _ = is_zero;",
        "expect": "killed",
        "note": "K10c mutant 1e: zero RGB instead of preserving pixel untouched when srcA == 0 in Rust dissolve_rows",
    },
    # 2. Shared JS clipCoverage (inpaint_raster.js) & hash32 (blend_modes.js)
    {
        "id": "J01_shared_clip_coverage_drop_own",
        "file": "renderer/editor/inpaint_raster.js",
        "rust": False,
        "test": "both",
        "find": "    if (own) for (let i = 0; i < n; i++) cov[i] = mul255(cov[i], own[i]);",
        "replace": "    void own;",
        "expect": "killed",
        "note": "K10c mutant 2a: drop own-mask loop in shared clipCoverage (inpaint_raster.js) - killed by px_test and boxstack_test",
    },
    {
        "id": "J02_shared_hash32_mutate_const",
        "file": "renderer/editor/blend_modes.js",
        "rust": False,
        "test": "both",
        "find": "    return lowbias32(((Math.imul(x >>> 0, 0x9E3779B1) ^ Math.imul(y >>> 0, 0x85EBCA77) ^ (seed >>> 0))) >>> 0);",
        "replace": "    return lowbias32(((Math.imul(x >>> 0, 0x9E3779B3) ^ Math.imul(y >>> 0, 0x85EBCA77) ^ (seed >>> 0))) >>> 0);",
        "expect": "killed",
        "note": "K10c mutant 2b: mutate 0x9E3779B1 in shared hash32 (blend_modes.js) - killed by px_test and boxstack_test",
    },
    # 3. Main-thread compositeBox (renderer/editor/inpaint_boxstack.js)
    {
        "id": "J03_boxstack_dissolve_le_cval",
        "file": "renderer/editor/inpaint_boxstack.js",
        "rust": False,
        "test": "boxstack",
        "find": "                    const keep = (cVal === 255) || ((hash32(imgX, imgY, l.dissolve) >>> 24) < cVal);",
        "replace": "                    const keep = (cVal === 255) || ((hash32(imgX, imgY, l.dissolve) >>> 24) <= cVal);",
        "expect": "killed",
        "note": "K10c mutant 3a: mutate < cVal to <= cVal in compositeBox dissolve loop (inpaint_boxstack.js)",
    },
    {
        "id": "J04_boxstack_dissolve_drop_cval_255",
        "file": "renderer/editor/inpaint_boxstack.js",
        "rust": False,
        "test": "boxstack",
        "find": "                    const keep = (cVal === 255) || ((hash32(imgX, imgY, l.dissolve) >>> 24) < cVal);",
        "replace": "                    const keep = ((hash32(imgX, imgY, l.dissolve) >>> 24) < cVal);",
        "expect": "killed",
        "note": "K10c mutant 3b: remove cVal === 255 short-circuit in compositeBox dissolve loop (inpaint_boxstack.js)",
    },
    {
        "id": "J05_boxstack_clip_skip_coverage",
        "file": "renderer/editor/inpaint_boxstack.js",
        "rust": False,
        "test": "boxstack",
        "find": "            mask = clipCoverage(cov, bm, c.alpha, mask);",
        "replace": "            mask = cov;",
        "expect": "killed",
        "note": "K10c mutant 3c: skip clipCoverage in compositeBox (inpaint_boxstack.js)",
    },
    # 4. Worker stackRowsToWasm inline JS fallback & into / l.sab handling (renderer/editor/inpaint_worker.js)
    {
        "id": "J06_worker_wasm_dissolve_js_shift_16",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "test": "px_test",
        "find": "                        const keep = (cVal === 255) || ((hash32(imgX, imgY, l.dissolve) >>> 24) < cVal);",
        "replace": "                        const keep = (cVal === 255) || ((hash32(imgX, imgY, l.dissolve) >>> 16) < cVal);",
        "expect": "killed",
        "note": "K10c mutant 4a: mutate >>> 24 to >>> 16 in stackRowsToWasm 'js' route dissolve fallback",
    },
    {
        "id": "J07_worker_wasm_clip_js_skip",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "test": "px_test",
        "find": "                clipCoverage(covView, bmView, c.alpha, ownView);",
        "replace": "                void covView;",
        "expect": "killed",
        "note": "K10c mutant 4b: skip clipCoverage in stackRowsToWasm 'js' route fallback",
    },
    {
        "id": "J08_worker_wasm_into_drop_backdrop_copy",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "test": "px_test",
        "find": "    } else if (into && !msg.clear) {\n        const c0 = timed ? now() : 0;\n        p.u8().set(into, pd);\n        if (timed) pxLapAdd(\"copyIn\", now() - c0, byteLen, true);\n    } else {",
        "replace": "    } else {",
        "expect": "killed",
        "note": "K10c mutant 4c: drop into && !msg.clear backdrop copy into pd in stackRowsToWasm",
    },
    {
        "id": "J09_worker_wasm_sab_wrong_offset",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "test": "px_test",
        "find": "            const sabView = new Uint8Array(l.sab, (Y0 - (msg.y0 | 0)) * W * 4, byteLen);",
        "replace": "            const sabView = new Uint8Array(l.sab, 0, byteLen);",
        "expect": "killed",
        "note": "K10c mutant 4d: ignore (Y0 - msg.y0) * W * 4 offset when reading l.sab in stackRowsToWasm",
    },
    # 5. Worker rowsOfStack dissolve loop (renderer/editor/inpaint_worker.js)
    {
        "id": "J10_worker_rowsofstack_dissolve_shift_16",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "test": "both",
        "find": "                    const keep = (cVal === 255) || ((hash32(imgX, imgY, l.dissolve) >>> 24) < cVal);\n                    if (keep) {\n                        rowSrc[idx + 3] = 255;",
        "replace": "                    const keep = (cVal === 255) || ((hash32(imgX, imgY, l.dissolve) >>> 16) < cVal);\n                    if (keep) {\n                        rowSrc[idx + 3] = 255;",
        "expect": "killed",
        "note": "K10c mutant 5: mutate >>> 24 to >>> 16 in rowsOfStack dissolve loop",
    },
    # 6. Worker stackPoints dissolve loop (renderer/editor/inpaint_worker.js)
    {
        "id": "J11_worker_stackpoints_dissolve_shift_16",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "test": "px_test",
        "find": "                    const keep = (cVal === 255) || ((hash32(imgX, imgY, l.dissolve) >>> 24) < cVal);\n                    if (keep) {\n                        src[idx + 3] = 255;",
        "replace": "                    const keep = (cVal === 255) || ((hash32(imgX, imgY, l.dissolve) >>> 16) < cVal);\n                    if (keep) {\n                        src[idx + 3] = 255;",
        "expect": "killed",
        "note": "K10c mutant 6: mutate >>> 24 to >>> 16 in stackPoints dissolve loop",
    },
    # 7. Worker psdPart, stackInto & Px.psdPackRowsFromPtr (inpaint_worker.js, px.js)
    {
        "id": "J12_psdpart_composewasm_flag_0",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "test": "px_test",
        "find": "                    op: \"psd_part\", kernels: \"rust\", composeWasm: 1,",
        "replace": "                    op: \"psd_part\", kernels: \"rust\", composeWasm: 0,",
        "expect": "killed",
        "note": "Report composeWasm: 0 instead of 1 on the pointer path in psdPart",
    },
    {
        "id": "J13_psdpart_drop_reset",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "test": "px_test",
        "find": "        } catch (err) {\n            if (!recovered(p, err, \"psd_part\")) throw err;\n        } finally {\n            p._reset(a);\n            releaseIfLarge();\n        }",
        "replace": "        } catch (err) {\n            if (!recovered(p, err, \"psd_part\")) throw err;\n        } finally {\n            releaseIfLarge();\n        }",
        "expect": "killed",
        "note": "Drop p._reset(a) from psdPart finally block",
    },
    {
        "id": "J14_psdpart_drop_release_if_large",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "test": "px_test",
        "find": "        } catch (err) {\n            if (!recovered(p, err, \"psd_part\")) throw err;\n        } finally {\n            p._reset(a);\n            releaseIfLarge();\n        }",
        "replace": "        } catch (err) {\n            if (!recovered(p, err, \"psd_part\")) throw err;\n        } finally {\n            p._reset(a);\n        }",
        "expect": "killed",
        "note": "Drop releaseIfLarge() from psdPart finally block",
    },
    {
        "id": "J15_psdpart_partptrof_outside_try",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "test": "px_test",
        "find": "        let packed = null, t1 = 0, t2 = 0;\n        try {\n            const ptrs = partPtrOf(p, a, msg, false);",
        "replace": "        let packed = null, t1 = 0, t2 = 0;\n        const ptrs = partPtrOf(p, a, msg, false);\n        try {",
        "expect": "killed",
        "note": "Move partPtrOf(p, a, msg, false) outside psdPart try block",
    },
    {
        "id": "J16_stackinto_composewasm_flag_0",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "test": "px_test",
        "find": "                    op: \"stack_into\", kernels: \"rust\", composeWasm: 1,",
        "replace": "                    op: \"stack_into\", kernels: \"rust\", composeWasm: 0,",
        "expect": "killed",
        "note": "Report composeWasm: 0 instead of 1 on the pointer path in stackInto",
    },
    {
        "id": "J17_stackinto_drop_layers_len_guard",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "test": "px_test",
        "find": "    if (p && msg.stack.layers.length > 0 && route(\"stackIntoWasm\") !== \"js\") {",
        "replace": "    if (p && route(\"stackIntoWasm\") !== \"js\") {",
        "expect": "killed",
        "note": "Drop msg.stack.layers.length > 0 guard in stackInto so base-only bands take wasm round-trip",
    },
    {
        "id": "J18_stackinto_drop_reset",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "test": "px_test",
        "find": "        } catch (err) {\n            if (!recovered(p, err, \"stack_into\")) throw err;\n        } finally {\n            p._reset(a);\n        }",
        "replace": "        } catch (err) {\n            if (!recovered(p, err, \"stack_into\")) throw err;\n        } finally {\n        }",
        "expect": "killed",
        "note": "Drop p._reset(a) from stackInto finally block",
    },
    {
        "id": "J19_psdpackrowsfromptr_wrong_ch_count",
        "file": "renderer/editor/px/px.js",
        "rust": False,
        "test": "px_test",
        "find": "    psdPackRowsFromPtr(a, pr, w, rows) {\n        const cap = this.exports.psd_pack_rows_cap(w, rows), po = a.take(cap), pl = a.take(rows * 2);\n        const out = [];\n        for (let ch = 0; ch < 4; ch++) {",
        "replace": "    psdPackRowsFromPtr(a, pr, w, rows) {\n        const cap = this.exports.psd_pack_rows_cap(w, rows), po = a.take(cap), pl = a.take(rows * 2);\n        const out = [];\n        for (let ch = 0; ch < 3; ch++) {",
        "expect": "killed",
        "note": "Pack 3 channels instead of 4 in psdPackRowsFromPtr",
    },
]


def run_test(kind):
    env = os.environ.copy()
    env["PX_ONLY"] = "pngPart"
    if kind == "boxstack":
        r = subprocess.run(["node", "tools/boxstack_test.js"], cwd=ROOT, env=env, capture_output=True, text=True)
        return r.returncode == 0, r.stdout + r.stderr
    if kind == "both":
        r1 = subprocess.run(["node", "tools/boxstack_test.js"], cwd=ROOT, env=env, capture_output=True, text=True)
        r2 = subprocess.run(["node", "tools/px_test.js"], cwd=ROOT, env=env, capture_output=True, text=True)
        return (r1.returncode != 0 and r2.returncode != 0) is False, (r1.stdout + r1.stderr + "\n" + r2.stdout + r2.stderr)
    r = subprocess.run(["node", "tools/px_test.js"], cwd=ROOT, env=env, capture_output=True, text=True)
    return r.returncode == 0, r.stdout + r.stderr


def build_wasm():
    r = subprocess.run([sys.executable, "tools/build_px.py"], cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"build_px.py failed:\n{r.stdout}\n{r.stderr}")


def main():
    originals = {}
    for m in MUTANTS:
        p = os.path.join(ROOT, m["file"])
        if p not in originals:
            with open(p, "r", encoding="utf-8", newline="") as f:
                originals[p] = f.read()

    wasm_files = [
        os.path.join(ROOT, "renderer", "editor", "px", "px.wasm"),
        os.path.join(ROOT, "renderer", "editor", "px", "px_scalar.wasm"),
    ]
    wasm_backups = {}
    for wf in wasm_files:
        with open(wf, "rb") as f:
            wasm_backups[wf] = f.read()

    results = []
    t_start = time.time()
    need_wasm_restore = False
    try:
        for m in MUTANTS:
            p = os.path.join(ROOT, m["file"])
            src = originals[p]
            if m["find"] not in src:
                raise RuntimeError(f"Target not found for {m['id']} in {m['file']}")
            mutated = src.replace(m["find"], m["replace"], 1)
            if "find2" in m:
                if m["find2"] not in mutated:
                    raise RuntimeError(f"Target find2 not found for {m['id']} in {m['file']}")
                mutated = mutated.replace(m["find2"], m["replace2"], 1)
            with open(p, "w", encoding="utf-8", newline="") as f:
                f.write(mutated)
            t0 = time.time()
            try:
                if m["rust"]:
                    need_wasm_restore = True
                    build_wasm()
                elif need_wasm_restore:
                    for wf, data in wasm_backups.items():
                        with open(wf, "wb") as f:
                            f.write(data)
                    need_wasm_restore = False
                ok_test, test_out = run_test(m["test"])
                status = "survived" if ok_test else "killed"
                fails = [l for l in test_out.splitlines() if l.startswith("FAIL") or "Error:" in l or "PxOutOfMemory:" in l]
                detail = " | ".join(fails[:2]) if fails else "all checks passed"
            finally:
                with open(p, "w", encoding="utf-8", newline="") as f:
                    f.write(src)
            dt = round(time.time() - t0, 2)
            unexpected = status != m["expect"]
            res = {
                "id": m["id"],
                "file": m["file"],
                "rust": m["rust"],
                "test": m["test"],
                "status": status,
                "expect": m["expect"],
                "unexpected": unexpected,
                "seconds": dt,
                "detail": detail,
                "note": m["note"],
            }
            results.append(res)
            print(f"[{m['id']}] {status.upper()} (expected {m['expect']}, {dt}s): {detail}", flush=True)
    finally:
        for p, src in originals.items():
            with open(p, "w", encoding="utf-8", newline="") as f:
                f.write(src)
        for wf, data in wasm_backups.items():
            with open(wf, "wb") as f:
                f.write(data)

    killed = sum(1 for r in results if r["status"] == "killed")
    survived = sum(1 for r in results if r["status"] == "survived")
    unexpected = sum(1 for r in results if r["unexpected"])
    report = {
        "target": "K10c (clip_coverage, dissolve_rows, psdPackRowsFromPtr, psdPart, stackInto, compositeBox, stackPoints)",
        "total": len(results),
        "killed": killed,
        "survived": survived,
        "unexpected_survivors": unexpected,
        "seconds": round(time.time() - t_start, 1),
        "mutants": results,
    }
    with open(os.path.join(OUT_DIR, "report.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(report, f, indent=2)
    summary_lines = [
        f"K10c Mutation Round ({len(results)} mutants, {report['seconds']}s):",
        f"  Killed: {killed}/{len(results)}, Survived: {survived}, Unexpected survivors: {unexpected}",
        "",
    ]
    for r in results:
        summary_lines.append(f"  {r['id']}: {r['status']} (expect {r['expect']}, {r['seconds']}s) - {r['note']} [{r['detail']}]")
    with open(os.path.join(OUT_DIR, "summary.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(summary_lines) + "\n")
    with open(os.path.join(OUT_DIR, "results.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(summary_lines) + "\n")
    print("\n".join(summary_lines), flush=True)
    if unexpected:
        sys.exit(1)


if __name__ == "__main__":
    main()
