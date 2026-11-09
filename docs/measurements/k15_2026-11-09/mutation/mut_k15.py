"""K15 mutation round config for tools/mutation_round.py (docs/PLAN_WASM_BUILD.md §4.6)."""

TITLE = "K15 (tiff_unpredict, tiff_predict_rgba, tiff_to_rgba, Question 6.4 sub-byte palette+alpha, tiffStrip / tiffStripFromPtr, tiffKernels)"

WORKING = [
    "crates/px/src/tiff.rs",
    "crates/px/src/lib.rs",
    "renderer/editor/px/px.wasm",
    "renderer/editor/px/px_scalar.wasm",
    "renderer/editor/px/px.js",
    "renderer/editor/px/kernels_js.js",
    "renderer/editor/px/kernels.js",
    "renderer/editor/inpaint_tiff.js",
    "renderer/editor/inpaint_worker.js",
    "renderer/editor/inpaint_canvas.js",
    "tools/px_test.js",
    "tools/tiff_test.js",
    "tools/tiff_test.py",
]

GATES = []
TILES = "on"

TF = "crates/px/src/tiff.rs"
LB = "crates/px/src/lib.rs"
IT = "renderer/editor/inpaint_tiff.js"
PJ = "renderer/editor/px/px.js"
KR = "renderer/editor/px/kernels.js"
WK = "renderer/editor/inpaint_worker.js"

MUTANTS = [
    # ---- crates/px/src/tiff.rs: unpredict ----
    (
        "tiff.rs: unpredict_row_8 SIMD per==4 prefix sum i8x16_add(v2, acc) mutated to i8x16_sub(v2, acc)",
        TF,
        [(
            "                let v2 = i8x16_add(v1, s2);\n                let out = i8x16_add(v2, acc);",
            "                let v2 = i8x16_add(v1, s2);\n                let out = i8x16_sub(v2, acc);",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: unpredict_row_8 SIMD per==1 prefix sum i8x16_add(v8, acc) mutated to i8x16_sub(v8, acc)",
        TF,
        [(
            "                let v8 = i8x16_add(v4, s8);\n                let out = i8x16_add(v8, acc);",
            "                let v8 = i8x16_add(v4, s8);\n                let out = i8x16_sub(v8, acc);",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: unpredict_row_8 per==3 loop c0.wrapping_add mutated to wrapping_sub",
        TF,
        [(
            "            c0 = c0.wrapping_add(row[i]);\n            c1 = c1.wrapping_add(row[i + 1]);",
            "            c0 = c0.wrapping_sub(row[i]);\n            c1 = c1.wrapping_add(row[i + 1]);",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: unpredict_row_8 scalar fallback wrapping_add mutated to wrapping_sub",
        TF,
        [(
            "#[cfg(not(target_feature = \"simd128\"))]\n#[inline(always)]\nfn unpredict_row_8(row: &mut [u8], per: usize) {\n    let n = row.len();\n    for i in per..n {\n        row[i] = row[i].wrapping_add(row[i - per]);\n    }\n}",
            "#[cfg(not(target_feature = \"simd128\"))]\n#[inline(always)]\nfn unpredict_row_8(row: &mut [u8], per: usize) {\n    let n = row.len();\n    for i in per..n {\n        row[i] = row[i].wrapping_sub(row[i - per]);\n    }\n}",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: unpredict 16-bit LE uses from_be_bytes instead of from_le_bytes",
        TF,
        [(
            "                    let prev = u16::from_le_bytes([row[(s - per) * 2], row[(s - per) * 2 + 1]]);",
            "                    let prev = u16::from_be_bytes([row[(s - per) * 2], row[(s - per) * 2 + 1]]);",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: unpredict 16-bit BE uses from_le_bytes instead of from_be_bytes",
        TF,
        [(
            "                    let prev = u16::from_be_bytes([row[(s - per) * 2], row[(s - per) * 2 + 1]]);",
            "                    let prev = u16::from_le_bytes([row[(s - per) * 2], row[(s - per) * 2 + 1]]);",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    # ---- crates/px/src/tiff.rs: predict_rgba ----
    (
        "tiff.rs: predict_row_rgba SIMD i8x16_sub(cur, prev) mutated to i8x16_add(cur, prev)",
        TF,
        [(
            "            v128_store(ptr.add(i - 16) as *mut v128, i8x16_sub(cur, prev));",
            "            v128_store(ptr.add(i - 16) as *mut v128, i8x16_add(cur, prev));",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: predict_row_rgba scalar wrapping_sub mutated to wrapping_add",
        TF,
        [(
            "#[cfg(not(target_feature = \"simd128\"))]\n#[inline(always)]\nfn predict_row_rgba(row: &mut [u8]) {\n    for k in (4..row.len()).rev() {\n        row[k] = row[k].wrapping_sub(row[k - 4]);\n    }\n}",
            "#[cfg(not(target_feature = \"simd128\"))]\n#[inline(always)]\nfn predict_row_rgba(row: &mut [u8]) {\n    for k in (4..row.len()).rev() {\n        row[k] = row[k].wrapping_add(row[k - 4]);\n    }\n}",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    # ---- crates/px/src/tiff.rs: to_rgba ----
    (
        "tiff.rs: to_rgba Fast path 1 (RGBA8 straight copy) alpha_mode == 2 mutated to alpha_mode == 1",
        TF,
        [(
            "    // Fast path 1: chunky RGBA8 straight is a direct copy.\n    if planes == 1 && bits == 8 && photometric == 2 && spp == 4 && alpha_mode == 2 {",
            "    // Fast path 1: chunky RGBA8 straight is a direct copy.\n    if planes == 1 && bits == 8 && photometric == 2 && spp == 4 && alpha_mode == 1 {",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: to_rgba Fast path 2 (RGB8 opaque) sets dst[3] = 0 instead of 255",
        TF,
        [(
            "                dst[2] = px[2];\n                dst[3] = 255;\n            }",
            "                dst[2] = px[2];\n                dst[3] = 0;\n            }",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: to_rgba Fast path 3 (RGBA8 premul) A=0 copies px instead of zeroing RGB",
        TF,
        [(
            "                } else if a == 0 {\n                    dst.fill(0);",
            "                } else if a == 0 {\n                    dst.copy_from_slice(px);",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: to_rgba Fast path 3 (RGBA8 premul) rounding bias h = a32 >> 1 mutated to h = 0",
        TF,
        [(
            "                    let a32 = a as u32;\n                    let h = a32 >> 1;\n                    dst[0] = (((px[0] as u32 * 255 + h) / a32).min(255)) as u8;",
            "                    let a32 = a as u32;\n                    let h = 0u32;\n                    dst[0] = (((px[0] as u32 * 255 + h) / a32).min(255)) as u8;",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: to_rgba Fast path 3 (RGBA8 premul) drops .min(255) clamp when sample > alpha",
        TF,
        [(
            "                    dst[0] = (((px[0] as u32 * 255 + h) / a32).min(255)) as u8;",
            "                    dst[0] = ((px[0] as u32 * 255 + h) / a32) as u8;",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: to_rgba 16-bit to 8-bit rounding ((v * 2 + 257) / 514) mutated to (v >> 8)",
        TF,
        [(
            "            let v = if le { b0 | (b1 << 8) } else { (b0 << 8) | b1 };\n            ((v * 2 + 257) / 514) as u8",
            "            let v = if le { b0 | (b1 << 8) } else { (b0 << 8) | b1 };\n            (v >> 8) as u8",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: to_rgba Question 6.4 sub-byte palette+alpha fails to scale alpha sample (photometric == 3 && c == 0 -> photometric == 3)",
        TF,
        [(
            "            if photometric == 3 && c == 0 {\n                raw\n            } else {\n                raw * scale\n            }",
            "            if photometric == 3 {\n                raw\n            } else {\n                raw * scale\n            }",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: to_rgba Question 6.4 sub-byte palette+alpha scales palette index c == 0 (photometric == 3 && c == 0 -> false)",
        TF,
        [(
            "            if photometric == 3 && c == 0 {\n                raw\n            } else {\n                raw * scale\n            }",
            "            if false {\n                raw\n            } else {\n                raw * scale\n            }",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: to_rgba WhiteIsZero (photometric == 0) does not invert v (255 - v -> v)",
        TF,
        [(
            "                let g = if photometric == 0 { 255 - v } else { v };",
            "                let g = v;",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: to_rgba drops src_len < need_src guard (T3)",
        TF,
        [(
            "    if src.is_null() || src_len < need_src {\n        return -1;\n    }",
            "    if src.is_null() {\n        return -1;\n    }",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    # ---- crates/px/src/lib.rs ----
    (
        "lib.rs: tiff_unpredict passes le == 0 instead of le != 0",
        LB,
        [(
            "    tiff::unpredict(buf, len, rows, row_bytes, pixels, per, bits, le != 0)",
            "    tiff::unpredict(buf, len, rows, row_bytes, pixels, per, bits, le == 0)",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "lib.rs: tiff_to_rgba passes le == 0 instead of le != 0",
        LB,
        [(
            "        bits,\n        le != 0,\n        photometric,",
            "        bits,\n        le == 0,\n        photometric,",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    # ---- renderer/editor/inpaint_tiff.js ----
    (
        "inpaint_tiff.js: toRgba Question 6.4 sub-byte palette+alpha fails to scale alpha sample (isIdx = palette)",
        IT,
        [(
            "                    const isIdx = palette && (planes === 1 ? i % spp === 0 : p === 0);\n                    s8[off + i * step] = isIdx ? raw : Math.round(raw * scale);",
            "                    const isIdx = palette;\n                    s8[off + i * step] = isIdx ? raw : Math.round(raw * scale);",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: paletteLut uses cm[i] >= 256 instead of !(cm[i] < 256) (K15-read-1)",
        IT,
        [(
            "        if (!(cm[i] < 256)) { all8 = false; break; }",
            "        if (cm[i] >= 256) { all8 = false; break; }",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: predictRgba adds instead of subtracts ((bytes[i] + bytes[i - 4]) & 255)",
        IT,
        [(
            "        for (let i = o + row - 1; i >= o + 4; i--) bytes[i] = (bytes[i] - bytes[i - 4]) & 255;",
            "        for (let i = o + row - 1; i >= o + 4; i--) bytes[i] = (bytes[i] + bytes[i - 4]) & 255;",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: unpredict subtracts instead of adds ((u8[i] - u8[i - per]) & 255)",
        IT,
        [(
            "            for (let i = o + per; i < end; i++) u8[i] = (u8[i] + u8[i - per]) & 255;",
            "            for (let i = o + per; i < end; i++) u8[i] = (u8[i] - u8[i - per]) & 255;",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    # ---- renderer/editor/px/px.js ----
    (
        "px.js: tiffUnpredict ignores buf.byteOffset (uses 0) (T1)",
        PJ,
        [(
            "        const u8 = new Uint8Array(buf.buffer, buf.byteOffset, need);",
            "        const u8 = new Uint8Array(buf.buffer, 0, need);",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "px.js: tiffPredictRgba ignores rgba.byteOffset (uses 0) (T1)",
        PJ,
        [(
            "        const u8 = new Uint8Array(rgba.buffer, rgba.byteOffset, n);",
            "        const u8 = new Uint8Array(rgba.buffer, 0, n);",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "px.js: tiffToRgba ignores plane b.byteOffset (uses 0) (T1)",
        PJ,
        [(
            "                this.put(ps + p * planeBytes, new Uint8Array(b.buffer, b.byteOffset, takeLen));",
            "                this.put(ps + p * planeBytes, new Uint8Array(b.buffer, 0, takeLen));",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "px.js: tiffStripFromPtr skips tiff_predict_rgba when pred === 2",
        PJ,
        [(
            "        if (pred === 2) {\n            const rc = this.exports.tiff_predict_rgba(pr, w, rows) | 0;",
            "        if (false) {\n            const rc = this.exports.tiff_predict_rgba(pr, w, rows) | 0;",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "px.js: tiffToRgba swaps premultiplied (1) and straight (2) alphaMode",
        PJ,
        [(
            "        const alphaMode = spec.alpha === \"premultiplied\" || spec.alpha === 1 ? 1\n            : spec.alpha === \"straight\" || spec.alpha === 2 ? 2",
            "        const alphaMode = spec.alpha === \"premultiplied\" || spec.alpha === 1 ? 2\n            : spec.alpha === \"straight\" || spec.alpha === 2 ? 1",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    # ---- renderer/editor/px/kernels.js ----
    (
        "kernels.js: tiffUnpredict drops trap recovery catch",
        KR,
        [(
            "        try { return p.tiffUnpredict(buf, rows, rowBytes, pixels, per, bits, le); }\n        catch (err) { if (!recovered(p, err, \"tiff_unpredict\")) throw err; }",
            "        try { return p.tiffUnpredict(buf, rows, rowBytes, pixels, per, bits, le); }",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "kernels.js: tiffKernels returns TIFF_JS instead of TIFF_RUST",
        KR,
        [(
            "export function tiffKernels() {\n    return TIFF_RUST;\n}",
            "export function tiffKernels() {\n    return J.TIFF_JS;\n}",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "kernels.js: tiffKernels pins rustPx() instance at tiffKernels() call time while consulting route (T2)",
        KR,
        [(
            "export function tiffKernels() {\n    return TIFF_RUST;\n}",
            "export function tiffKernels() {\n    const p0 = rustPx();\n    return { ...TIFF_RUST, unpredict: (b, r, rb, px, per, bits, le = true) => (rustPx(\"tiffUnpredict\") && p0 ? p0.tiffUnpredict(b, r, rb, px, per, bits, le) : J.tiffUnpredict(b, r, rb, px, per, bits, le)) };\n}",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    # ---- renderer/editor/inpaint_worker.js ----
    (
        "inpaint_worker.js: tiffPartJob skips partPtrOf / tiffStripFromPtr (composeWasm=1 path)",
        WK,
        [(
            "    if (p && !msg.rgba && route(composeRoute) !== \"js\") {",
            "    if (false && p && !msg.rgba && route(composeRoute) !== \"js\") {",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_worker.js: tiffPartJob omits p._reset(a) in finally",
        WK,
        [(
            "            if (!recovered(p, err, \"tiff_part\")) throw err;\n        } finally {\n            p._reset(a);\n            releaseIfLarge();\n        }",
            "            if (!recovered(p, err, \"tiff_part\")) throw err;\n        } finally {\n            releaseIfLarge();\n        }",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
]
