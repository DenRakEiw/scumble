TITLE = "K32"
WORKING = [
    "crates/px/src/maskf.rs",
    "crates/px/src/lib.rs",
    "renderer/editor/px/px.wasm",
    "renderer/editor/px/px_scalar.wasm",
    "renderer/editor/px/kernels_js.js",
    "renderer/editor/px/px.js",
    "renderer/editor/px/kernels.js",
    "renderer/editor/stitch.js",
    "tools/px_test.js",
    "tools/stitch_test.js",
    "tools/editor_test.py",
    "tools/w0_bench.py",
]
GATES = []
TILES = "on"

PX_MASK = {"px": ["mask"]}

MUTANTS = [
    (
        "alpha_inv255_scalar",
        "crates/px/src/maskf.rs",
        [("dst[i] = (rgba[i * 4 + 3] as f64 / 255.0) as f32;", "dst[i] = rgba[i * 4 + 3] as f32 * (1.0 / 255.0);")],
        "killed: f32 multiplication by 1/255 differs from division by 255 at 126 alpha values (3, 6, 7, ...)",
        PX_MASK,
    ),
    (
        "alpha_inv255_simd",
        "crates/px/src/maskf.rs",
        [(
            "let lo = f64x2_div(f64x2_promote_low_f32x4(q), v255);\n                let hi = f64x2_div(high(q), v255);\n                v128_store(d.add(i) as *mut v128, pack(lo, hi));",
            "v128_store(d.add(i) as *mut v128, f32x4_mul(q, f32x4_splat(1.0 / 255.0)));",
        )],
        "killed: SIMD f32x4_mul by 1/255 differs from division by 255 at 126 alpha values (3, 6, 7, ...)",
        PX_MASK,
    ),
    (
        "js_max_zero_sign",
        "crates/px/src/maskf.rs",
        [("else if a == 0.0 && b == 0.0 {\n        f32::from_bits(a.to_bits() & b.to_bits())\n    } ", "")],
        "killed: Math.max(-0.0, +0.0) is +0.0, not -0.0",
        PX_MASK,
    ),
    (
        "js_clamp_neg_zero",
        "crates/px/src/maskf.rs",
        [("else if !(v > 0.0) {\n        0.0", "else if v < 0.0 {\n        0.0")],
        "killed: Math.max(0, -0.0) is +0.0, not -0.0",
        PX_MASK,
    ),
    (
        "js_max_nan_sign_scalar",
        "crates/px/src/maskf.rs",
        [("if a.is_nan() || b.is_nan() {\n        f32::from_bits(0xffc0_0000)", "if a.is_nan() || b.is_nan() {\n        f32::from_bits(0x7fc0_0000)")],
        "killed: V8 Float32Array store of Math.max NaN is 0xffc00000",
        PX_MASK,
    ),
    (
        "nan_sign_simd",
        "crates/px/src/maskf.rs",
        [("v128_or(m, v128_and(f32x4_ne(m, m), u32x4_splat(0x8000_0000)))", "m")],
        "killed: SIMD f32x4_max canonicalises NaN to 0x7fc00000 without nan_sign",
        PX_MASK,
    ),
    (
        "erode_skip_second_invert",
        "crates/px/src/maskf.rs",
        [(
            "mask_one_minus(&mut data[..n]);\n    dilate(&mut data[..n], w, h, r);\n    mask_one_minus(&mut data[..n]);",
            "mask_one_minus(&mut data[..n]);\n    dilate(&mut data[..n], w, h, r);",
        )],
        "killed: erode must invert back after dilate",
        PX_MASK,
    ),
    (
        "mask_byte_trunc",
        "crates/px/src/maskf.rs",
        [("(c * 255.0 + 0.5) as u8", "(c * 255.0) as u8")],
        "killed: mask_to_rgba rounds with Math.round, not truncation",
        PX_MASK,
    ),
    (
        "mask_to_rgba_mode2_ge_scalar",
        "crates/px/src/maskf.rs",
        [("let a = if x > 0.5 { 0 } else { 255 };", "let a = if x >= 0.5 { 0 } else { 255 };")],
        "killed: mode 2 threshold is strictly > 0.5",
        PX_MASK,
    ),
    (
        "mask_to_rgba_mode2_ge_simd",
        "crates/px/src/maskf.rs",
        [("let px = v128_andnot(opaque, f32x4_gt(q, half));", "let px = v128_andnot(opaque, f32x4_ge(q, half));")],
        "killed: SIMD mode 2 threshold is strictly > 0.5",
        PX_MASK,
    ),
    (
        "mask_to_rgba_f32_mul_simd",
        "crates/px/src/maskf.rs",
        [(
            "let lo = i32x4_trunc_sat_f64x2_zero(f64x2_add(f64x2_mul(f64x2_promote_low_f32x4(q), v255), vhalf));",
            "let lo = i32x4_trunc_sat_f64x2_zero(f64x2_add(f64x2_promote_low_f32x4(f32x4_mul(q, f32x4_splat(255.0))), vhalf));",
        )],
        "killed: f32 * 255.0 before rounding differs from f64 * 255.0 at 2059957 / 2^24",
        PX_MASK,
    ),
    (
        "bounds_ge_scalar",
        "crates/px/src/maskf.rs",
        [("let first = row.iter().position(|&v| v > 0.5)?;", "let first = row.iter().position(|&v| v >= 0.5)?;")],
        "killed: mask_bounds_f32 threshold is strictly > 0.5",
        PX_MASK,
    ),
    (
        "bounds_ge_simd",
        "crates/px/src/maskf.rs",
        [(
            "if v128_any_true(f32x4_gt(q, half)) {\n                    for k in i..i + 4 {\n                        if *p.add(k) > 0.5 {",
            "if v128_any_true(f32x4_ge(q, half)) {\n                    for k in i..i + 4 {\n                        if *p.add(k) >= 0.5 {",
        )],
        "killed: SIMD mask_bounds_f32 threshold is strictly > 0.5",
        PX_MASK,
    ),
    (
        "bounds_right_inclusive",
        "crates/px/src/maskf.rs",
        [("x1 = x1.max(last + 1);", "x1 = x1.max(last);")],
        "killed: mask_bounds_f32 x1 is exclusive (last + 1)",
        PX_MASK,
    ),
    (
        "bounds_simd_skip_tail",
        "crates/px/src/maskf.rs",
        [(
            "for k in (n4.max(first)..n).rev() {\n            if row[k] > 0.5 {\n                return Some((first, k));\n            }\n        }",
            "",
        )],
        "killed: SIMD row_bounds must scan the tail n4..n for the rightmost pixel",
        PX_MASK,
    ),
    (
        "route_stitch_mask_ignored",
        "renderer/editor/px/kernels.js",
        [(
            'export function alphaToMask(rgba, out = null) {\n    const p = rustPx("stitchMask");',
            "export function alphaToMask(rgba, out = null) {\n    const p = rustPx();",
        )],
        "killed: stitchMask route must switch the K32 mask wrappers to the twins when set to js",
        PX_MASK,
    ),
    (
        "stitch_keep_not_inverted",
        "renderer/editor/stitch.js",
        [(
            "const keep = { data: maskOneMinus(blend.data), w, h };",
            "const keep = { data: blend.data, w, h };",
        )],
        "killed: finishPixels must invert blend.data via maskOneMinus for colorMatch keep weights (first killed by the export counter only; now killed on pixels by stitch_test)",
        PX_MASK,
    ),
    (
        "stitch_keep_double_invert",
        "renderer/editor/stitch.js",
        [(
            "const keep = { data: maskOneMinus(blend.data), w, h };",
            "const keep = { data: maskOneMinus(maskOneMinus(blend.data)), w, h };",
        )],
        "killed: finishPixels colour-match keep weights must be 1 - blend, not 1 - (1 - blend) (still calls mask_one_minus, dies on pixels)",
        PX_MASK,
    ),
    (
        "fill_masked_clamp_into_hard",
        "renderer/editor/stitch.js",
        [(
            "maskMaxClamp(soft.data, hard.data, true, soft.data);",
            "maskMaxClamp(soft.data, hard.data, true, hard.data);",
        )],
        "killed: fillMasked must write the clamped soft mask into soft.data, not hard.data (still calls mask_max_clamp, dies on pixels)",
        PX_MASK,
    ),
    (
        "fill_masked_inv_double_invert",
        "renderer/editor/stitch.js",
        [(
            "const inv = { data: maskOneMinus(hard.data), w, h };",
            "const inv = { data: maskOneMinus(maskOneMinus(hard.data)), w, h };",
        )],
        "killed: fillMasked blur mode must invert hard.data once for inv (still calls mask_one_minus, dies on pixels)",
        PX_MASK,
    ),
]
