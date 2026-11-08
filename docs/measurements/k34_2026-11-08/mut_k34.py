TITLE = "K34 (edgefit_shrink, warp_rgba, warp_coverage)"

WORKING = [
    "crates/px/src/lib.rs",
    "crates/px/src/maskf.rs",
    "renderer/editor/px/px_scalar.wasm",
    "renderer/editor/px/px.wasm",
    "renderer/editor/px/px.js",
    "renderer/editor/px/kernels_js.js",
    "renderer/editor/px/kernels.js",
    "renderer/editor/edgefit.js",
    "tools/edgefit_test.js",
    "tools/stitch_test.js",
    "tools/px_test.js",
    "tools/editor_test.py",
]

GATES = ["editor"]
TILES = "on"

PX_MASK = {"px": ["mask"]}
PX_ROUTE = {"px": ["retouchRoute"]}
EDITOR_ALIGN = {"px": ["mask"], "editor": ["an_aligned_answer_shows_no_repeated_edge"]}

MUTANTS = [
    (
        "shrink_row_scalar_green_coeff",
        "crates/px/src/maskf.rs",
        [("0.587 * (rgba_row[j + 1] as f64)", "0.580 * (rgba_row[j + 1] as f64)")],
        "killed: scalar shrink_row green luma weight altered",
        PX_MASK,
    ),
    (
        "shrink_row_simd_green_coeff",
        "crates/px/src/maskf.rs",
        [("(f64x2_splat(0.299), f64x2_splat(0.587), f64x2_splat(0.114))", "(f64x2_splat(0.299), f64x2_splat(0.580), f64x2_splat(0.114))")],
        "killed: SIMD shrink_row green luma weight altered",
        PX_MASK,
    ),
    (
        "edgefit_shrink_alpha_floor",
        "crates/px/src/maskf.rs",
        [("gray[out_row + x] = if (as_val as f64) > 1e-4 {", "gray[out_row + x] = if (as_val as f64) > 1e-2 {")],
        "killed: edgefit_shrink 1e-4 alpha floor raised to 1e-2",
        PX_MASK,
    ),
    (
        "edgefit_shrink_1to1_alpha_floor",
        "crates/px/src/maskf.rs",
        [("gray[i] = if a > 1e-4 { ((gray[i] as f64) / a) as f32 } else { 0.0 };", "gray[i] = if a > 1e-2 { ((gray[i] as f64) / a) as f32 } else { 0.0 };")],
        "killed: edgefit_shrink 1:1 1e-4 alpha floor raised to 1e-2",
        PX_MASK,
    ),
    (
        "warp_rgba_scalar_dy",
        "crates/px/src/maskf.rs",
        [("let dy = if h > 1 { w * 4 } else { 0 };", "let dy = 0;")],
        "killed: scalar warp_rgba vertical stride zeroed",
        PX_MASK,
    ),
    (
        "warp_rgba_simd_fx",
        "crates/px/src/maskf.rs",
        [("let v1fx = f64x2_sub(vone, vfx);", "let v1fx = vfx;")],
        "killed: SIMD warp_rgba horizontal weight 1 - fx replaced with fx",
        PX_MASK,
    ),
    (
        "warp_rgba_simd_overflow_guard",
        "crates/px/src/maskf.rs",
        [
            (
                "if !(a00.abs() * cap_x + a01.abs() * cap_y + tx.abs()).is_finite()\n            || !(a10.abs() * cap_x + a11.abs() * cap_y + ty.abs()).is_finite()",
                "if false",
            )
        ],
        "killed: SIMD warp_rgba finite overflow guard bypassed",
        PX_MASK,
    ),
    (
        "warp_coverage_scalar_ramp",
        "crates/px/src/maskf.rs",
        [("let d = js_min2_f64(js_min2_f64(js_min2_f64(xx, cap_x - xx), yy), cap_y - yy) + 1.0;", "let d = js_min2_f64(js_min2_f64(js_min2_f64(xx, cap_x - xx), yy), cap_y - yy);")],
        "killed: scalar warp_coverage +1.0 ramp offset dropped",
        PX_MASK,
    ),
    (
        "warp_coverage_simd_ramp",
        "crates/px/src/maskf.rs",
        [("let d0 = f64x2_add(m0, vone);", "let d0 = m0;")],
        "killed: SIMD warp_coverage +1.0 ramp offset dropped",
        PX_MASK,
    ),
    (
        "warp_coverage_simd_overflow_guard",
        "crates/px/src/maskf.rs",
        [
            (
                "if !(a00.abs() * cap_x + a01.abs() * cap_y + tx.abs() + cap_x + 1.0).is_finite()\n            || !(a10.abs() * cap_x + a11.abs() * cap_y + ty.abs() + cap_y + 1.0).is_finite()",
                "if false",
            )
        ],
        "killed: SIMD warp_coverage finite overflow guard bypassed",
        PX_MASK,
    ),
    (
        "kernels_route_edgefit_shrink",
        "renderer/editor/px/kernels.js",
        [('const p = rustPx("edgefit") && rustPx("edgefitShrink");', "const p = null;")],
        "killed: edgefitShrink route bypassed to JS twin",
        EDITOR_ALIGN,
    ),
    (
        "kernels_route_warp_rgba",
        "renderer/editor/px/kernels.js",
        [('const p = rustPx("edgefit") && rustPx("warpRgba");', "const p = null;")],
        "killed: warpRgba route bypassed to JS twin",
        EDITOR_ALIGN,
    ),
    (
        "kernels_route_warp_coverage",
        "renderer/editor/px/kernels.js",
        [('const p = rustPx("edgefit") && rustPx("warpCoverage");', "const p = null;")],
        "killed: warpCoverage route bypassed to JS twin",
        EDITOR_ALIGN,
    ),
    (
        "kernels_trap_warp_rgba",
        "renderer/editor/px/kernels.js",
        [
            (
                'catch (err) { if (!recovered(p, err, "warp_rgba")) throw err; }',
                "catch (err) { throw err; }",
            )
        ],
        "killed: warpRgba trap recovery catch rethrows without fallback",
        PX_ROUTE,
    ),
    (
        "edgefit_call_warp_coverage",
        "renderer/editor/edgefit.js",
        [("return warpCoveragePx(w, h, M);", "return new Float32Array(w * h).fill(1);")],
        "killed: edgefit.js warpCoverage returns all-ones",
        EDITOR_ALIGN,
    ),
]
