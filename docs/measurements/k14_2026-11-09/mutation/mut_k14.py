TITLE = "K14 shadow_march_f64 f64x2 SIMD + sun route"
TILES = "on"
GATES = []
WORKING = [
    "crates/px/src/relight.rs",
    "crates/px/src/lib.rs",
    "renderer/editor/px/px.js",
    "renderer/editor/px/kernels.js",
    "renderer/editor/px/px.wasm",
    "renderer/editor/px/px_scalar.wasm",
    "renderer/editor/inpaint_worker.js",
    "tools/px_test.js",
    "tools/relight_test.py",
]

MUTANTS = [
    (
        "simd_f64_drop_exit_sky_rdz_ge",
        "crates/px/src/relight.rs",
        [
            (
                "                    let v_sky_limit = v128_bitselect(v_scale, v_inf, f64x2_ge(rdz, v_zero));",
                "                    let v_sky_limit = v_scale;",
            )
        ],
        "killed by 16x4 rdz < 0 with sz > scale in relightCases",
        {"px": ["relight"]},
    ),
    (
        "simd_f64_disable_exit_sky",
        "crates/px/src/relight.rs",
        [
            (
                "                    let v_sky_limit = v128_bitselect(v_scale, v_inf, f64x2_ge(rdz, v_zero));",
                "                    let v_sky_limit = v_inf;",
            )
        ],
        "killed by 16x4 f64x2 exit_sky rdz >= 0 && sz > scale (-50) in relightCases",
        {"px": ["relight"]},
    ),
    (
        "simd_f64_cx_gt_zero",
        "crates/px/src/relight.rs",
        [
            (
                "                        let in_x = v128_and(f64x2_ge(cx, v_zero), f64x2_lt(cx, v_wf));",
                "                        let in_x = v128_and(f64x2_gt(cx, v_zero), f64x2_lt(cx, v_wf));",
            )
        ],
        "killed by 16x4 cx == 0.0 boundary wall in relightCases",
        {"px": ["relight"]},
    ),
    (
        "simd_f64_cx_le_wf",
        "crates/px/src/relight.rs",
        [
            (
                "                        let in_x = v128_and(f64x2_ge(cx, v_zero), f64x2_lt(cx, v_wf));",
                "                        let in_x = v128_and(f64x2_ge(cx, v_zero), f64x2_le(cx, v_wf));",
            )
        ],
        "killed by 16x4 cx == wf boundary out-of-bounds in relightCases",
        {"px": ["relight"]},
    ),
    (
        "simd_f64_hit_without_active_mask",
        "crates/px/src/relight.rs",
        [
            (
                "                        blocked = v128_or(blocked, v128_and(active, hit));",
                "                        blocked = v128_or(blocked, hit);",
            )
        ],
        "killed by 16x4 f64x2 lane 0 exits cx < 0, lane 1 blocked at ix=0 in relightCases",
        {"px": ["relight"]},
    ),
    (
        "simd_f64_mapz_ge_bias",
        "crates/px/src/relight.rs",
        [
            (
                "                        let hit = f64x2_gt(map_z, f64x2_add(sz, v_z_bias));",
                "                        let hit = f64x2_ge(map_z, f64x2_add(sz, v_z_bias));",
            )
        ],
        "killed by 16x4 map_z == sz + z_bias tie in relightCases",
        {"px": ["relight"]},
    ),
    (
        "simd_f64_break_both_lanes_when_one_inactive",
        "crates/px/src/relight.rs",
        [
            (
                "                        blocked = v128_or(blocked, v128_and(active, hit));\n                        active = v128_andnot(active, hit);\n                        if !v128_any_true(active) {",
                "                        blocked = v128_or(blocked, v128_and(active, hit));\n                        active = v128_andnot(active, hit);\n                        if !i64x2_all_true(active) {",
            )
        ],
        "killed by 16x4 f64x2 lane 0 blocked at s=0 (ix=2), lane 1 blocked at s=1 (ix=5) and smoothDepth in relightCases",
        {"px": ["relight"]},
    ),
    (
        "simd_f64_drop_odd_width_tail",
        "crates/px/src/relight.rs",
        [
            (
                "            if pairs < w {",
                "            if false && pairs < w {",
            )
        ],
        "killed by 3x4 odd width w=3 sun in relightCases",
        {"px": ["relight"]},
    ),
    (
        "simd_f64_fold_sun_rdx",
        "crates/px/src/relight.rs",
        [
            (
                "                    let rdx = f64x2_sub(tx, px);",
                "                    let rdx = if is_sun { v_cx_t } else { f64x2_sub(tx, px) };",
            )
        ],
        "killed by 16x4 sun tx - px rounding tie in relightCases",
        {"px": ["relight"]},
    ),
    (
        "scalar_f64_flip_mapz_gt_ge",
        "crates/px/src/relight.rs",
        [
            (
                "            if map_z > sz + z_bias {\n                blocked = true;",
                "            if map_z >= sz + z_bias {\n                blocked = true;",
            )
        ],
        "killed by 16x4 map_z == sz + z_bias tie on px_scalar.wasm in relightCases",
        {"px": ["relight"]},
    ),
    (
        "scalar_f64_drop_rdz_nonneg",
        "crates/px/src/relight.rs",
        [
            (
                "            if rdz >= 0.0 && sz > scale {\n                break;\n            }",
                "            if sz > scale {\n                break;\n            }",
            )
        ],
        "killed by 16x4 rdz < 0 with sz > scale on px_scalar.wasm in relightCases",
        {"px": ["relight"]},
    ),
    (
        "kernels_js_route_sun_to_twin",
        "renderer/editor/px/kernels.js",
        [
            (
                '    const p = rustPx("shadowMarch", w * h);',
                '    const p = Number(light[3]) === 1 ? null : rustPx("shadowMarch", w * h);',
            )
        ],
        "killed by K.shadowMarch sun routes to shadow_march_f64 in relightBench",
        {"px": ["relightBench"]},
    ),
    (
        "kernels_js_ignore_route_name",
        "renderer/editor/px/kernels.js",
        [
            (
                '    const p = rustPx("shadowMarch", w * h);',
                "    const p = rustPx();",
            )
        ],
        "killed by K.shadowMarch route check in relightBench",
        {"px": ["relightBench"]},
    ),
    (
        "kernels_js_drop_march_guard",
        "renderer/editor/px/kernels.js",
        [
            (
                "        if (!Number.isFinite(n) || !(Math.abs(n) < MARCH_MAX)) return false;",
                "        if (!Number.isFinite(n)) return false;",
            )
        ],
        "killed by K.shadowMarch guard check in relightBench",
        {"px": ["relightBench"]},
    ),
    (
        "px_js_ignore_slot_key",
        "renderer/editor/px/px.js",
        [
            (
                '            const pd = key !== null && key !== undefined ? this._slot("relight_depth", String(key), depth, n * 2) : this._in(a, depth, n * 2);\n            const pt = a.take(nTaps * 24);',
                "            const pd = this._in(a, depth, n * 2);\n            const pt = a.take(nTaps * 24);",
            )
        ],
        "killed by resident depth slot check in relightCases",
        {"px": ["relight"]},
    ),
]
