TITLE = "K13 shadow_march_f64"
TILES = "on"
GATES = []
WORKING = [
    "crates/px/src/relight.rs",
    "crates/px/src/lib.rs",
    "renderer/editor/px/kernels_js.js",
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
        "relight_f64_drop_rdz_nonneg",
        "crates/px/src/relight.rs",
        [
            (
                "                for _ in 1..=steps {\n                    if rdz >= 0.0 && sz > scale {",
                "                for _ in 1..=steps {\n                    if sz > scale {",
            )
        ],
        "killed by 16x4 rdz < 0 with sz > scale in relightCases",
        {"px": ["relight"]},
    ),
    (
        "relight_f64_flip_mapz_gt_ge",
        "crates/px/src/relight.rs",
        [
            (
                "                    let d = unsafe { *depth.get_unchecked(iy * w + ix) } as f64;\n                    let map_z = (65535.0 - d) * inv65535;\n                    if map_z > sz + z_bias {",
                "                    let d = unsafe { *depth.get_unchecked(iy * w + ix) } as f64;\n                    let map_z = (65535.0 - d) * inv65535;\n                    if map_z >= sz + z_bias {",
            )
        ],
        "killed by 16x4 map_z == sz + z_bias tie in relightCases",
        {"px": ["relight"]},
    ),
    (
        "relight_f64_steps_off_by_one",
        "crates/px/src/relight.rs",
        [
            (
                "                for _ in 1..=steps {",
                "                for _ in 1..steps {",
            )
        ],
        "killed by 16x4 final step s == steps wall and twinCheck in relightCases",
        {"px": ["relight"]},
    ),
    (
        "relight_f64_bounds_le_zero",
        "crates/px/src/relight.rs",
        [
            (
                "                    if cx < 0.0 || cy < 0.0 || cx >= wf || cy >= hf {",
                "                    if cx <= 0.0 || cy < 0.0 || cx >= wf || cy >= hf {",
            )
        ],
        "killed by 16x4 cx == 0.0 boundary wall in relightCases",
        {"px": ["relight"]},
    ),
    (
        "relight_f64_bounds_gt_wf",
        "crates/px/src/relight.rs",
        [
            (
                "                    if cx < 0.0 || cy < 0.0 || cx >= wf || cy >= hf {",
                "                    if cx < 0.0 || cy < 0.0 || cx > wf || cy >= hf {",
            )
        ],
        "killed by 16x4 cx == wf boundary out-of-bounds in relightCases",
        {"px": ["relight"]},
    ),
    (
        "relight_f64_bounds_cy_le_zero",
        "crates/px/src/relight.rs",
        [
            (
                "                    if cx < 0.0 || cy < 0.0 || cx >= wf || cy >= hf {",
                "                    if cx < 0.0 || cy <= 0.0 || cx >= wf || cy >= hf {",
            )
        ],
        "killed by 16x4 cy == 0.0 boundary wall in relightCases",
        {"px": ["relight"]},
    ),
    (
        "relight_f64_bounds_cy_gt_hf",
        "crates/px/src/relight.rs",
        [
            (
                "                    if cx < 0.0 || cy < 0.0 || cx >= wf || cy >= hf {",
                "                    if cx < 0.0 || cy < 0.0 || cx >= wf || cy > hf {",
            )
        ],
        "killed by 16x4 cy == hf boundary out-of-bounds in relightCases",
        {"px": ["relight"]},
    ),
    (
        "relight_f64_unchecked_mul",
        "crates/px/src/relight.rs",
        [
            (
                "    let n_depth = w.checked_mul(h)?;".replace("\r\n", "\n"),
                "    let n_depth = Some(w.wrapping_mul(h))?;",
            )
        ],
        "killed by raw shadow_march_f64 w=65536, h=65536 overflow refusal check in relightCases",
        {"px": ["relight"]},
    ),
    (
        "kernels_js_hoist_fold_sun_rdx",
        "renderer/editor/px/kernels_js.js",
        [
            (
                "                const rdx = tx - px;\n                const rdy = ty - py;\n                const rdz = tz - pz;",
                "                const rdx = kind === 1 ? tapX[t] : tx - px;\n                const rdy = kind === 1 ? tapY[t] : ty - py;\n                const rdz = kind === 1 ? tapZ[t] : tz - pz;",
            )
        ],
        "killed by hoisted js.shadowMarch equals pre-hoist reference byte for byte in relightCases",
        {"px": ["relight"]},
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
        "kernels_js_drop_bias_neg_guard",
        "renderer/editor/px/kernels.js",
        [
            (
                "    if (Number(bias ?? 0) < 0) return false;\n    return true;",
                "    return true;",
            )
        ],
        "killed by K.shadowMarch sun bias < 0 guard check in relightBench",
        {"px": ["relightBench"]},
    ),
]
