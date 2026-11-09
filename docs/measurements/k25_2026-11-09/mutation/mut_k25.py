"""K25 mutation round config for tools/mutation_round.py (docs/PLAN_WASM_BUILD.md §4.8)."""

TITLE = "K25 (limit_alpha_rows and the export / screen snap)"

WORKING = [
    "crates/px/src/range.rs",
    "crates/px/src/lib.rs",
    "renderer/editor/px/px.wasm",
    "renderer/editor/px/px_scalar.wasm",
    "renderer/editor/px/px.js",
    "renderer/editor/px/kernels_js.js",
    "renderer/editor/px/kernels.js",
    "renderer/editor/inpaint_limit.js",
    "tools/px_test.js",
    "tools/limit_test.js",
    "tools/limit_test.py",
    "tools/px_jobs.py",
    "tools/ab_median.py",
]

GATES = ["limit"]
TILES = "on"

RG = "crates/px/src/range.rs"
PJ = "renderer/editor/px/px.js"
KJ = "renderer/editor/px/kernels_js.js"
KR = "renderer/editor/px/kernels.js"
LM = "renderer/editor/inpaint_limit.js"

MUTANTS = [
    # ---- range.rs: limit_alpha_rows SIMD & scalar math, snap reference colour, window bounds
    (
        "range.rs: limit_alpha_rows [iy0..iy1] vs [wy0..wy1) window bounds guard dropped",
        RG,
        [(
            "    let iy0 = (my0 - 2.0).floor().max(0.0).min(max_y) as usize;\n    let iy1 = (my1 + 2.0).ceil().max(0.0).min(max_y) as usize;\n    if iy0 < wy0 || iy1 >= wy1 {\n        return 0;\n    }",
            "    let _iy0 = (my0 - 2.0).floor().max(0.0).min(max_y) as usize;\n    let _iy1 = (my1 + 2.0).ceil().max(0.0).min(max_y) as usize;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: limit_alpha_rows snap_on disabled (sigma_r > 0.0 && guide.is_some() -> false)",
        RG,
        [(
            "    let snap_on = sigma_r > 0.0 && guide.is_some();\n    let row_bytes = w * 4;",
            "    let snap_on = false;\n    let row_bytes = w * 4;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: limit_alpha_rows col=None guide sampling gx mutated from mx.floor() to 0",
        RG,
        [(
            "                    let gx = mx.floor().max(0.0).min(max_x) as usize;\n                    let gy = (my.floor().max(0.0).min(max_y) as usize) - wy0;",
            "                    let gx = 0usize;\n                    let gy = (my.floor().max(0.0).min(max_y) as usize) - wy0;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: limit_alpha_rows explicit col reference colour pr mutated to 0.0",
        RG,
        [(
            "                let (pr, pg, pb) = if let Some(c_slice) = col {\n                    let c_off = row_byte_off + off;\n                    (\n                        c_slice[c_off] as f64 / 255.0,",
            "                let (pr, pg, pb) = if let Some(c_slice) = col {\n                    let c_off = row_byte_off + off;\n                    (\n                        0.0,",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: limit_alpha_rows col_from_rgba reference colour pr mutated to 0.0",
        RG,
        [(
            "                } else if col_from_rgba {\n                    (\n                        row_rgba[off] as f64 / 255.0,",
            "                } else if col_from_rgba {\n                    (\n                        0.0,",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: limit_alpha_rows SIMD half-way rounding f64x2_ge(scaled - fl, 0.5) mutated to f64x2_gt",
        RG,
        [(
            "                let fl_v = f64x2_floor(scaled_v);\n                let ge_half = f64x2_ge(f64x2_sub(scaled_v, fl_v), half_v);\n                let rounded_v = f64x2_add(fl_v, v128_and(ge_half, one_v));",
            "                let fl_v = f64x2_floor(scaled_v);\n                let ge_half = f64x2_gt(f64x2_sub(scaled_v, fl_v), half_v);\n                let rounded_v = f64x2_add(fl_v, v128_and(ge_half, one_v));",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: limit_alpha_rows scalar js_round_byte mutated to floor truncation",
        RG,
        [(
            "            let w_val = range_weight(v, lo, hi, f_lo, f_hi, limit_invert);\n            row_rgba[off + 3] = js_round_byte((row_rgba[off + 3] as f64) * w_val);",
            "            let w_val = range_weight(v, lo, hi, f_lo, f_hi, limit_invert);\n            row_rgba[off + 3] = ((row_rgba[off + 3] as f64) * w_val) as u8;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: range_weight_f64x2 limit_invert branch dropped",
        RG,
        [(
            "    let w_v = f64x2_mul(w_lo_v, w_hi_v);\n    if limit_invert {\n        f64x2_sub(one_v, w_v)\n    } else {\n        w_v\n    }",
            "    let w_v = f64x2_mul(w_lo_v, w_hi_v);\n    let _ = limit_invert;\n    w_v",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: range_weight_f64x2 hard-step 1e-12 tolerance mutated to 0.0",
        RG,
        [(
            "    let w_lo_v = if f_lo > 0.0 {\n        sstep_f64x2(lo - f_lo, lo, val_v)\n    } else {\n        v128_and(f64x2_ge(val_v, f64x2_splat(lo - 1e-12)), one_v)\n    };",
            "    let w_lo_v = if f_lo > 0.0 {\n        sstep_f64x2(lo - f_lo, lo, val_v)\n    } else {\n        v128_and(f64x2_ge(val_v, f64x2_splat(lo)), one_v)\n    };",
        )],
        "killed",
        {"px": ["range"]},
    ),
    # ---- px.js: 256-row chunking, flags, snap validation
    (
        "px.js: limitAlphaRows 256-row chunking cap removed (ch = h - cy)",
        PJ,
        [(
            "        for (let cy = 0; cy < h; cy += 256) {\n            const ch = Math.min(256, h - cy);",
            "        for (let cy = 0; cy < h; cy += h) {\n            const ch = h - cy;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "px.js: limitAlphaRows limit.invert flag bit dropped",
        PJ,
        [(
            "        const snapOn = !!(sigmaR > 0 && gBytes);\n        const colIsRgba = !!(cBytes && cBytes.buffer === u8.buffer && cBytes.byteOffset === u8.byteOffset);\n        const flags = limit.invert ? 1 : 0;",
            "        const snapOn = !!(sigmaR > 0 && gBytes);\n        const colIsRgba = !!(cBytes && cBytes.buffer === u8.buffer && cBytes.byteOffset === u8.byteOffset);\n        const flags = 0;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "px.js: limitAlphaRows short snap validation dropped",
        PJ,
        [(
            "        if (snap != null) {\n            if ((!Array.isArray(snap) && !ArrayBuffer.isView(snap)) || snap.length < 2) {\n                throw new Error(\"limitAlphaRows: snap must have 2 elements\");\n            }\n            sigmaR = snap[0] == null ? 0 : +snap[0];\n            tau = snap[1] == null ? 0 : +snap[1];\n        }",
            "        if (snap != null) {\n            sigmaR = snap[0] == null ? 0 : +snap[0];\n            tau = snap[1] == null ? 0 : +snap[1];\n        }",
        )],
        "killed",
        {"px": ["range"]},
    ),
    # ---- kernels_js.js: twin guide sampling, rounding, libmExp
    (
        "kernels_js.js: limitAlphaRows col=null guide sampling gx mutated from Math.floor(mx) to 0",
        KJ,
        [(
            "                        const gx = Math.max(0, Math.min(maxX, Math.floor(mx)));\n                        const gy = Math.max(0, Math.min(maxY, Math.floor(my)));",
            "                        const gx = 0;\n                        const gy = Math.max(0, Math.min(maxY, Math.floor(my)));",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "kernels_js.js: limitAlphaRows Math.round(u8[off + 3] * wVal) mutated to Math.floor",
        KJ,
        [(
            "                const wVal = rangeWeightScalar(v, lo, hi, fLo, fHi, limitInvert);\n                u8[off + 3] = Math.max(0, Math.min(255, Math.round(u8[off + 3] * wVal)));",
            "                const wVal = rangeWeightScalar(v, lo, hi, fLo, fHi, limitInvert);\n                u8[off + 3] = Math.max(0, Math.min(255, Math.floor(u8[off + 3] * wVal)));",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "kernels_js.js: rangeSnapField wSpatial libmExp reverted to Math.exp",
        KJ,
        [(
            "            const wSpatial = libmExp(-0.5 * distSpatial2);\n            const wColor = libmExp(-distColor2 * inv2SigmaR2);",
            "            const wSpatial = Math.exp(-0.5 * distSpatial2);\n            const wColor = libmExp(-distColor2 * inv2SigmaR2);",
        )],
        "killed",
        {"px": ["range"]},
    ),
    # ---- kernels.js: route key, trap recovery, partial-chunk OOM recovery
    (
        "kernels.js: limitAlphaRows route key mutated from limitAlphaRows to rangeDepth",
        KR,
        [(
            "export function limitAlphaRows(rgba, map, mw, mh, xf, x0, y0, w, h, limit, snap = null, guide = null, col = null) {\n    const p = rustPx(\"limitAlphaRows\");",
            "export function limitAlphaRows(rgba, map, mw, mh, xf, x0, y0, w, h, limit, snap = null, guide = null, col = null) {\n    const p = rustPx(\"rangeDepth\");",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "kernels.js: limitAlphaRows catch trap recovery dropped",
        KR,
        [(
            "        } catch (err) {\n            if (!recovered(p, err, \"limit_alpha_rows\")) throw err;",
            "        } catch (err) {\n            throw err;",
        )],
        "killed",
        {"px": ["retouchRoute"]},
    ),
    (
        "kernels.js: limitAlphaRows partial-chunk OOM recovery doneRows resume dropped (re-multiplies rows 0..done)",
        KR,
        [(
            "            if (!recovered(p, err, \"limit_alpha_rows\")) throw err;\n            done = (err && typeof err === \"object\" && err.doneRows > 0) ? err.doneRows : 0;",
            "            if (!recovered(p, err, \"limit_alpha_rows\")) throw err;\n            done = 0;",
        )],
        "killed",
        {"px": ["retouchRoute"]},
    ),
    # ---- inpaint_limit.js: stored-limit safety & map.guide snap reference colour
    (
        "inpaint_limit.js: limitAlphaRows normalizeStoredLimit reverted to strict normalizeLimit (throws on stored non-finite fields)",
        LM,
        [(
            "export function limitAlphaRows(rgba, x0, y0, w, h, limit, map, col = null) {\n    if (!rgba || !limit || w <= 0 || h <= 0) return;\n    const lim = normalizeStoredLimit(limit);",
            "export function limitAlphaRows(rgba, x0, y0, w, h, limit, map, col = null) {\n    if (!rgba || !limit || w <= 0 || h <= 0) return;\n    const lim = normalizeLimit(limit);",
        )],
        "killed",
        {"px": ["range"], "gates": ["limit"]},
    ),
    (
        "inpaint_limit.js: limitAlphaRows col=null reverted to passing rgba as snap reference colour (old K25 bug)",
        LM,
        [(
            "        limitAlphaRowsKernel(rgba, map.data, map.w, map.h, m, x0, y0, w, h, lim, snap, gRaw, col);\n        return;",
            "        limitAlphaRowsKernel(rgba, map.data, map.w, map.h, m, x0, y0, w, h, lim, snap, gRaw, col || rgba);\n        return;",
        )],
        "killed",
        {"px": ["range"], "gates": ["limit"]},
    ),
]
