"""K22 mutation round config for tools/mutation_round.py (docs/PLAN_WASM_BUILD.md §4.8)."""

TITLE = "K22 (range_tiles_depth, snap route)"

WORKING = [
    "crates/px/src/range.rs",
    "crates/px/src/lib.rs",
    "renderer/editor/px/px.wasm",
    "renderer/editor/px/px_scalar.wasm",
    "renderer/editor/px/px.js",
    "renderer/editor/px/kernels_js.js",
    "renderer/editor/px/kernels.js",
    "renderer/editor/inpaint_worker.js",
    "tools/px_test.js",
    "tools/px_jobs.py",
    "tools/ab_median.py",
]

GATES = ["selection", "edges"]
TILES = "on"

RG = "crates/px/src/range.rs"
PJ = "renderer/editor/px/px.js"
KJ = "renderer/editor/px/kernels_js.js"
KR = "renderer/editor/px/kernels.js"

MUTANTS = [
    # ---- range.rs: rounding, hard-step 1e-12, sstep 1e-14, bilinear 0.5, snap_field, partial zeroing, wy0 check
    (
        "range.rs: js_round_byte and SIMD round mutated from ties-up (>= 0.5) to ties-to-even",
        RG,
        [
            (
                "    let f = x.floor();\n    if x - f >= 0.5 {\n        (f as u8).wrapping_add(1)\n    } else {\n        f as u8\n    }",
                "    x.round_ties_even() as u8",
            ),
            (
                "    let fl_v = f64x2_floor(scaled_v);\n    let ge_half = f64x2_ge(f64x2_sub(scaled_v, fl_v), f64x2_splat(0.5));\n    let rounded_v = f64x2_add(fl_v, v128_and(ge_half, one_v));",
                "    let rounded_v = f64x2_nearest(scaled_v);",
            ),
        ],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: js_round_byte and SIMD round >= 0.5 mutated to > 0.5 (ties-down)",
        RG,
        [
            (
                "    if x - f >= 0.5 {",
                "    if x - f > 0.5 {",
            ),
            (
                "    let ge_half = f64x2_ge(f64x2_sub(scaled_v, fl_v), f64x2_splat(0.5));",
                "    let ge_half = f64x2_gt(f64x2_sub(scaled_v, fl_v), f64x2_splat(0.5));",
            ),
        ],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: hard-step 1e-12 tolerance dropped on lo in scalar and SIMD",
        RG,
        [
            (
                "    } else if v >= lo - 1e-12 {",
                "    } else if v >= lo {",
            ),
            (
                "        v128_and(f64x2_ge(val_v, f64x2_splat(lo - 1e-12)), one_v)",
                "        v128_and(f64x2_ge(val_v, f64x2_splat(lo)), one_v)",
            ),
        ],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: sstep and sstep_f64x2 1e-14 clamp widened to 0.05",
        RG,
        [
            (
                "    if t <= 1e-14 {\n        return 0.0;\n    }",
                "    if t <= 0.05 {\n        return 0.0;\n    }",
            ),
            (
                "    let eps_v = f64x2_splat(1e-14);",
                "    let eps_v = f64x2_splat(0.05);",
            ),
        ],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: u16_bilinear 0.5 texel-center offset dropped",
        RG,
        [
            (
                "    let u = px - 0.5;\n    let v = py - 0.5;",
                "    let u = px;\n    let v = py;",
            ),
            (
                "                    let u_v = f64x2_sub(mx_v, half_v);\n                    let v_v = f64x2_sub(my_v, half_v);",
                "                    let u_v = mx_v;\n                    let v_v = my_v;",
            ),
        ],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: snap_field 2.0 * tau upper smoothstep bound mutated to 1.5 * tau",
        RG,
        [(
            "    let k = sstep(tau, 2.0 * tau, range);",
            "    let k = sstep(tau, 1.5 * tau, range);",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: snap_field inv_2_sigma_r2 0.5 / sigma_r^2 mutated to 1.0 / sigma_r^2",
        RG,
        [(
            "    let inv_2_sigma_r2 = 0.5 / (sigma_r * sigma_r);",
            "    let inv_2_sigma_r2 = 1.0 / (sigma_r * sigma_r);",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: snap_field den > 1e-6 fallback threshold mutated to 1e-12",
        RG,
        [(
            "    if !(den > 1e-6) {",
            "    if !(den > 1e-12) {",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: partial tile out-of-bounds right column clearing dropped",
        RG,
        [(
            "            if vw < tile {\n                row_buf[vw..tile].fill(0);\n                zeros += tile - vw;\n            }",
            "            if vw < tile {\n                zeros += tile - vw;\n            }",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: range_tiles_depth wy0 window bounds check dropped",
        RG,
        [(
            "            if iy0 < wy0 || iy1 >= wy1 {\n                return 0;\n            }",
            "            if false {\n                return 0;\n            }",
        )],
        "killed",
        {"px": ["range"]},
    ),
    # ---- px.js, kernels_js.js, kernels.js
    (
        "px.js: rangeTilesDepth wy0 halo 2 -> 0",
        PJ,
        [(
            "        const ry11 = m1 * rx1 + m3 * ry1 + m5;\n        const wy0 = Math.max(0, Math.min(mh - 1, Math.floor(Math.min(ry00, ry10, ry01, ry11) - 2)));",
            "        const ry11 = m1 * rx1 + m3 * ry1 + m5;\n        const wy0 = Math.max(0, Math.min(mh - 1, Math.floor(Math.min(ry00, ry10, ry01, ry11))));",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "px.js: rangeTilesDepth turned-map [minTx..maxTx] x window reverted to [0..W]",
        PJ,
        [(
            "        const rx0 = minTx * tile;\n        const rx1 = Math.min((maxTx + 1) * tile, W);",
            "        const rx0 = 0;\n        const rx1 = W;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "px.js: rangeTilesDepth short classes check dropped",
        PJ,
        [(
            "        if (classes && classes.length < cols) throw new Error(\"rangeTilesDepth: short classes\");",
            "        if (false) throw new Error(\"rangeTilesDepth: short classes\");",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "kernels_js.js: rangeSnapField den > 1e-6 mutated to den > 1e-12",
        KJ,
        [(
            "    if (!(den > 1e-6)) return bil;",
            "    if (!(den > 1e-12)) return bil;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "kernels_js.js: libmExp P1 polynomial term sign flipped",
        KJ,
        [(
            "    const c = x - xx * (EXP_P1 + xx * (EXP_P2 + xx * (EXP_P3 + xx * (EXP_P4 + xx * EXP_P5))));",
            "    const c = x + xx * (EXP_P1 + xx * (EXP_P2 + xx * (EXP_P3 + xx * (EXP_P4 + xx * EXP_P5))));",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "kernels.js: rangeTilesDepth split-route sort order reversed",
        KR,
        [(
            "    const tiles = [...rPlain.tiles, ...rSnap.tiles].sort((a, b) => a.tx - b.tx);",
            "    const tiles = [...rPlain.tiles, ...rSnap.tiles].sort((a, b) => b.tx - a.tx);",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "kernels.js: rangeTilesDepth unified catch trap recovery dropped",
        KR,
        [(
            "        } catch (err) {\n            if (!recovered(pPlain, err, \"range_tiles_depth\")) throw err;\n        }",
            "        } catch (err) {\n            throw err;\n        }",
        )],
        "killed",
        {"px": ["retouchRoute"]},
    ),
    (
        "kernels.js: rangeTilesDepth split runSide catch trap recovery dropped",
        KR,
        [(
            "            } catch (err) {\n                if (!recovered(p, err, \"range_tiles_depth\")) throw err;\n            }",
            "            } catch (err) {\n                throw err;\n            }",
        )],
        "killed",
        {"px": ["retouchRoute"]},
    ),
]
