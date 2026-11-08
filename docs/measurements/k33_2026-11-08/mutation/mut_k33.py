"""K33 mutation round: color_match_rgba and blend_alpha (Rust scalar & SIMD, kernels.js routes, stitch.js wiring)."""

TITLE = "K33 (color_match_rgba, blend_alpha, routes, stitch.js call sites)"

WORKING = [
    "crates/px/src/lib.rs",
    "crates/px/src/maskf.rs",
    "renderer/editor/px/px.wasm",
    "renderer/editor/px/px_scalar.wasm",
    "renderer/editor/px/kernels_js.js",
    "renderer/editor/px/px.js",
    "renderer/editor/px/kernels.js",
    "renderer/editor/stitch.js",
    "tools/px_test.js",
    "tools/stitch_test.js",
    "tools/editor_test.py",
]

GATES = ["editor"]

KILL_MASK = {"px": ["mask"], "editor": ["an_aligned_answer_shows_no_repeated_edge"]}

MUTANTS = [
    (
        "cm_total_clamp_hi",
        "crates/px/src/maskf.rs",
        [("        } else if w > 0.0 {\n            w.min(1.0) as f64", "        } else if w > 0.0 {\n            w as f64")],
        "killed: total weight must clamp weights > 1.0 to 1.0 before the < 64 check",
        KILL_MASK,
    ),
    (
        "cm_threshold_le",
        "crates/px/src/maskf.rs",
        [("    if total < 64.0 {\n        return 0;\n    }", "    if total <= 64.0 {\n        return 0;\n    }")],
        "killed: total == 64.0 must colour-match rather than returning 0",
        KILL_MASK,
    ),
    (
        "cm_variance_floor",
        "crates/px/src/maskf.rs",
        [("    let floor = 1e-6 * 255.0 * 255.0;", "    let floor = 1e-3 * 255.0 * 255.0;")],
        "killed: variance floor must be 1e-6 * 255 * 255",
        KILL_MASK,
    ),
    (
        "cm_scale_clamp_lo",
        "crates/px/src/maskf.rs",
        [("        } else if q < 0.5 {\n            0.5", "        } else if q < 0.25 {\n            0.25")],
        "killed: std ratio scale lower clamp is 0.5",
        KILL_MASK,
    ),
    (
        "cm_scale_clamp_hi",
        "crates/px/src/maskf.rs",
        [("        } else if q > 2.0 {\n            2.0", "        } else if q > 4.0 {\n            4.0")],
        "killed: std ratio scale upper clamp is 2.0",
        KILL_MASK,
    ),
    (
        "cm_scalar_ties",
        "crates/px/src/maskf.rs",
        [
            (
                "        for c in 0..3 {\n            p[c] = clamp8((p[c] as f64 - t_mean[c]) * scale[c] + r_mean[c]);\n        }",
                "        for c in 0..3 {\n            p[c] = ((p[c] as f64 - t_mean[c]) * scale[c] + r_mean[c] + 0.5).clamp(0.0, 255.0) as u8;\n        }",
            )
        ],
        "killed: scalar colour match output must round ties-to-even (Uint8ClampedArray) rather than half-up",
        KILL_MASK,
    ),
    (
        "cm_simd_ties",
        "crates/px/src/maskf.rs",
        [
            (
                "                let r_lo = f64x2_nearest(f64x2_add(f64x2_mul(f64x2_sub(lo, tm), sc), rm));",
                "                let r_lo = f64x2_floor(f64x2_add(f64x2_add(f64x2_mul(f64x2_sub(lo, tm), sc), rm), f64x2_splat(0.5)));",
            )
        ],
        "killed: SIMD colour match output must round ties-to-even (f64x2_nearest)",
        KILL_MASK,
    ),
    (
        "cm_simd_stats_wt",
        "crates/px/src/maskf.rs",
        [
            (
                "                let vw = f64x2_splat(wt as f64);\n                let j = i * 4;\n                m0 = f64x2_add",
                "                let vw = f64x2_splat(wt.min(1.0) as f64);\n                let j = i * 4;\n                m0 = f64x2_add",
            )
        ],
        "killed: SIMD stats loop must use unclamped positive weight wt",
        KILL_MASK,
    ),
    (
        "cm_scalar_stats_wt",
        "crates/px/src/maskf.rs",
        [
            (
                "                let w = wt as f64;\n                let j = i * 4;\n                mean[0] += d[j] as f64 * w;",
                "                let w = wt.min(1.0) as f64;\n                let j = i * 4;\n                mean[0] += d[j] as f64 * w;",
            )
        ],
        "killed: scalar stats loop must use unclamped positive weight wt",
        KILL_MASK,
    ),
    (
        "cm_simd_alpha_keep",
        "crates/px/src/maskf.rs",
        [
            (
                "                let out = v128_or(v128_or(r, u32x4_shl(g, 8)), v128_or(u32x4_shl(b, 16), v128_and(px, a_mask)));",
                "                let out = v128_or(v128_or(r, u32x4_shl(g, 8)), v128_or(u32x4_shl(b, 16), a_mask));",
            )
        ],
        "killed: colour match must preserve the patch alpha channel",
        KILL_MASK,
    ),
    (
        "ba_scalar_keep_round",
        "crates/px/src/maskf.rs",
        [
            (
                "            let c = if x > 0.0 { x.min(1.0) as f64 } else { 0.0 };\n            p[3] = (c * (p[3] as f64) + 0.5) as u8;",
                "            let c = if x > 0.0 { x.min(1.0) as f64 } else { 0.0 };\n            p[3] = (c * (p[3] as f64)).round_ties_even() as u8;",
            )
        ],
        "killed: blend_alpha keep_alpha=true uses Math.round (+0.5 floor), not ties-to-even",
        KILL_MASK,
    ),
    (
        "ba_simd_keep_round",
        "crates/px/src/maskf.rs",
        [
            (
                "                    let lo = i32x4_trunc_sat_f64x2_zero(f64x2_add(\n                        f64x2_mul(f64x2_promote_low_f32x4(q), f64x2_promote_low_f32x4(a)),\n                        vhalf,\n                    ));",
                "                    let lo = i32x4_trunc_sat_f64x2_zero(\n                        f64x2_mul(f64x2_promote_low_f32x4(q), f64x2_promote_low_f32x4(a)),\n                    );",
            )
        ],
        "killed: SIMD blend_alpha keep_alpha=true must add 0.5 before truncating",
        KILL_MASK,
    ),
    (
        "ba_simd_replace_clamp",
        "crates/px/src/maskf.rs",
        [
            (
                "                    let q = f32x4_pmin(one, f32x4_pmax(zero, v128_load(m.add(i) as *const v128)));\n                    let lo = i32x4_trunc_sat_f64x2_zero(f64x2_add(f64x2_mul(f64x2_promote_low_f32x4(q), v255), vhalf));",
                "                    let q = f32x4_pmax(zero, v128_load(m.add(i) as *const v128));\n                    let lo = i32x4_trunc_sat_f64x2_zero(f64x2_add(f64x2_mul(f64x2_promote_low_f32x4(q), v255), vhalf));",
            )
        ],
        "killed: SIMD blend_alpha keep_alpha=false must clamp mask values above 1.0 to 1.0",
        KILL_MASK,
    ),
    (
        "route_color_match_off",
        "renderer/editor/px/kernels.js",
        [("export function colorMatchRgba(patch, reference, weight) {\n    const p = rustPx(\"colorMatch\");", "export function colorMatchRgba(patch, reference, weight) {\n    const p = null; // rustPx(\"colorMatch\");")],
        "killed: colorMatch route must dispatch to Rust when enabled",
        KILL_MASK,
    ),
    (
        "route_blend_alpha_off",
        "renderer/editor/px/kernels.js",
        [("export function blendAlpha(rgba, mask, keepAlpha = false, out = null) {\n    const p = rustPx(\"blendAlpha\");", "export function blendAlpha(rgba, mask, keepAlpha = false, out = null) {\n    const p = null; // rustPx(\"blendAlpha\");")],
        "killed: blendAlpha route must dispatch to Rust when enabled",
        KILL_MASK,
    ),
    (
        "stitch_color_match_skip",
        "renderer/editor/stitch.js",
        [("    if (!colorMatchRgba(pd.data, rd, weight.data)) return patch;", "    if (colorMatchRgba(pd.data, rd, weight.data)) return patch;")],
        "killed: stitch.js colorMatch must write matched pixels when colorMatchRgba returns true and return patch untouched when false",
        KILL_MASK,
    ),
    (
        "stitch_align_copy_keep_alpha",
        "renderer/editor/stitch.js",
        [("            const layRGBA = blendAlpha(pdata.data, blend.data, false);", "            const layRGBA = blendAlpha(pdata.data, blend.data, true);")],
        "killed: stitch.js alignCopy must replace alpha with blend mask (keepAlpha=false) rather than multiplying patch alpha",
        KILL_MASK,
    ),
    (
        "stitch_final_alpha_ignore_keep",
        "renderer/editor/stitch.js",
        [("    blendAlpha(pd.data, blend.data, !!info.keepAlpha, pd.data);", "    blendAlpha(pd.data, blend.data, false, pd.data);")],
        "killed: stitch.js finalAlpha must pass !!info.keepAlpha to blendAlpha",
        KILL_MASK,
    ),
]
