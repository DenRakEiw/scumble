TITLE = "K14 shadow_march_f64 y-precompute + sun route + f32 removal"
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
        "y_precompute_cy_le_zero",
        "crates/px/src/relight.rs",
        [
            (
                "                if cy < 0.0 || cy >= hf {",
                "                if cy <= 0.0 || cy >= hf {",
            )
        ],
        "killed by 16x4 cy == 0.0 boundary wall in relightCases",
        {"px": ["relight"]},
    ),
    (
        "y_precompute_cy_gt_hf",
        "crates/px/src/relight.rs",
        [
            (
                "                if cy < 0.0 || cy >= hf {",
                "                if cy < 0.0 || cy > hf {",
            )
        ],
        "killed by 16x4 cy == hf boundary out-of-bounds in relightCases",
        {"px": ["relight"]},
    ),
    (
        "y_precompute_short_step_count",
        "crates/px/src/relight.rs",
        [
            (
                "            for s in 0..steps {",
                "            for s in 0..steps.saturating_sub(1) {",
            )
        ],
        "killed by 16x4 final step s == steps wall in relightCases",
        {"px": ["relight"]},
    ),
    (
        "y_precompute_fold_sun_rdy",
        "crates/px/src/relight.rs",
        [
            (
                "            let rdy = ty - py;",
                "            let rdy = if is_sun { cy_t } else { ty - py };",
            )
        ],
        "killed by 4x16 sun ty - py rounding tie in relightCases",
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
        "killed by 16x4 rdz < 0 with sz > scale in relightCases",
        {"px": ["relight"]},
    ),
    (
        "scalar_f64_disable_exit_sky",
        "crates/px/src/relight.rs",
        [
            (
                "            if rdz >= 0.0 && sz > scale {\n                break;\n            }",
                "            if false && rdz >= 0.0 && sz > scale {\n                break;\n            }",
            )
        ],
        "killed by 16x4 exit_sky rdz >= 0 && sz > scale (-50) in relightCases",
        {"px": ["relight"]},
    ),
    (
        "scalar_f64_cx_le_zero",
        "crates/px/src/relight.rs",
        [
            (
                "            if cx < 0.0 || cx >= wf {",
                "            if cx <= 0.0 || cx >= wf {",
            )
        ],
        "killed by 16x4 cx == 0.0 boundary wall in relightCases",
        {"px": ["relight"]},
    ),
    (
        "scalar_f64_cx_gt_wf",
        "crates/px/src/relight.rs",
        [
            (
                "            if cx < 0.0 || cx >= wf {",
                "            if cx < 0.0 || cx > wf {",
            )
        ],
        "killed by 16x4 cx == wf boundary out-of-bounds in relightCases",
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
        "killed by 16x4 map_z == sz + z_bias tie in relightCases",
        {"px": ["relight"]},
    ),
    (
        "scalar_f64_fold_sun_rdx",
        "crates/px/src/relight.rs",
        [
            (
                "        let rdx = tx - px;",
                "        let rdx = if is_sun { cx_t } else { tx - px };",
            )
        ],
        "killed by 16x4 sun tx - px rounding tie in relightCases",
        {"px": ["relight"]},
    ),
    (
        "kernels_js_default_route_js",
        "renderer/editor/px/kernels.js",
        [
            (
                "const DEFAULT_ROUTES = Object.freeze({ releaseMB: 256, keepMB: 16, crc32: 64 });",
                'const DEFAULT_ROUTES = Object.freeze({ releaseMB: 256, keepMB: 16, crc32: 64, shadowMarch: "js" });',
            )
        ],
        "killed by shadow_march as routed default route check in relightBench",
        {"px": ["relightBench"]},
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
