"""K23 mutation round config for tools/mutation_round.py (docs/PLAN_WASM_BUILD.md §4.8)."""

TITLE = "K23 (range_tiles_rgba: luma, colour)"

WORKING = [
    "crates/px/src/range.rs",
    "crates/px/src/lib.rs",
    "renderer/editor/px/px.wasm",
    "renderer/editor/px/px_scalar.wasm",
    "renderer/editor/px/px.js",
    "renderer/editor/px/kernels_js.js",
    "renderer/editor/px/kernels.js",
    "renderer/editor/inpaint_weights.js",
    "renderer/editor/inpaint_worker.js",
    "tools/px_test.js",
    "tools/weights_test.js",
    "tools/px_jobs.py",
    "tools/ab_median.py",
    "tools/selection_test.py",
]

GATES = ["selection"]
TILES = "on"

RG = "crates/px/src/range.rs"
PJ = "renderer/editor/px/px.js"
KJ = "renderer/editor/px/kernels_js.js"
KR = "renderer/editor/px/kernels.js"
WT = "renderer/editor/inpaint_weights.js"
WK = "renderer/editor/inpaint_worker.js"

MUTANTS = [
    # ---- range.rs: luma & colour tables, opponent weights, sstep_f64x2 early exits, out-of-bounds zeroing, guards
    (
        "range.rs: range_tiles_rgba luma_r 0.299 mutated to 0.333",
        RG,
        [(
            "            luma_r[i] = 0.299 * x;\n            luma_g[i] = 0.587 * x;\n            luma_b[i] = 0.114 * x;",
            "            luma_r[i] = 0.333 * x;\n            luma_g[i] = 0.587 * x;\n            luma_b[i] = 0.114 * x;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: range_tiles_rgba opp_g 0.587 mutated to 0.500",
        RG,
        [(
            "            opp_r[i] = 0.299 * u;\n            opp_g[i] = 0.587 * u;\n            opp_b[i] = 0.114 * u;",
            "            opp_r[i] = 0.299 * u;\n            opp_g[i] = 0.500 * u;\n            opp_b[i] = 0.114 * u;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: range_tiles_rgba colour s = 0.04 + ... * 0.6 mutated to 0.08 + ... * 0.5",
        RG,
        [(
            "    let s = 0.04 + (if tol == 0.0 { 0.0 } else { tol / 100.0 }).max(0.0).min(1.0) * 0.6;",
            "    let s = 0.08 + (if tol == 0.0 { 0.0 } else { tol / 100.0 }).max(0.0).min(1.0) * 0.5;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: range_tiles_rgba colour opponent chroma weight 4.0 mutated to 2.0 in SIMD and scalar",
        RG,
        [
            (
                "                    let four_v = f64x2_splat(4.0);\n                    let two_s2_v = f64x2_splat(two_s2);",
                "                    let four_v = f64x2_splat(2.0);\n                    let two_s2_v = f64x2_splat(two_s2);",
            ),
            (
                "                    let dd = d0 * d0 + 4.0 * (d1 * d1 + d2 * d2);\n                    let v = (-dd / two_s2).exp();",
                "                    let dd = d0 * d0 + 2.0 * (d1 * d1 + d2 * d2);\n                    let v = (-dd / two_s2).exp();",
            ),
        ],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: range_tiles_rgba top py_start > 0 out-of-bounds zeroing dropped",
        RG,
        [(
            "        if py_start > 0 {\n            buf[..py_start * tile].fill(0);\n            zeros += py_start * tile;\n        }\n        if py_end < tile {\n            buf[py_end * tile..tile_bytes].fill(0);\n            zeros += (tile - py_end) * tile;\n        }\n\n        for py in py_start..py_end {\n            let y_rel = (tile_y0 + py) - ry0;",
            "        if py_start > 0 {\n            zeros += py_start * tile;\n        }\n        if py_end < tile {\n            buf[py_end * tile..tile_bytes].fill(0);\n            zeros += (tile - py_end) * tile;\n        }\n\n        for py in py_start..py_end {\n            let y_rel = (tile_y0 + py) - ry0;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: range_tiles_rgba bottom py_end < tile out-of-bounds zeroing dropped",
        RG,
        [(
            "        if py_end < tile {\n            buf[py_end * tile..tile_bytes].fill(0);\n            zeros += (tile - py_end) * tile;\n        }\n\n        for py in py_start..py_end {\n            let y_rel = (tile_y0 + py) - ry0;",
            "        if py_end < tile {\n            zeros += (tile - py_end) * tile;\n        }\n\n        for py in py_start..py_end {\n            let y_rel = (tile_y0 + py) - ry0;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: range_tiles_rgba right vw < tile out-of-bounds zeroing dropped",
        RG,
        [(
            "            let row_rgba = &rgba[(y_rel * w + tile_x0) * 4..(y_rel * w + tile_x1) * 4];\n            let row_buf = &mut buf[py * tile..(py + 1) * tile];\n            if vw < tile {\n                row_buf[vw..tile].fill(0);\n                zeros += tile - vw;\n            }",
            "            let row_rgba = &rgba[(y_rel * w + tile_x0) * 4..(y_rel * w + tile_x1) * 4];\n            let row_buf = &mut buf[py * tile..(py + 1) * tile];\n            if vw < tile {\n                zeros += tile - vw;\n            }",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: range_tiles_rgba mode > 1 and ry0..ry1 row bounds guard dropped",
        RG,
        [(
            "    if ry0 >= ry1 || ry0 < tile_y0 || ry1 > tile_y1 || mode > 1 {\n        return 0;\n    }",
            "    if ry0 >= ry1 {\n        return 0;\n    }",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: range_tiles_rgba full-tile check mutated from fulls == tile_bytes to any_nonzero",
        RG,
        [(
            "                    px += 1;\n                }\n            }\n        }\n\n        if zeros == tile_bytes || !any_nonzero {\n            status_out[tx] = 0;\n        } else if fulls == tile_bytes && vw == tile && vh == tile {\n            status_out[tx] = 2;\n            b_x0 = b_x0.min(tile_x0);",
            "                    px += 1;\n                }\n            }\n        }\n\n        if zeros == tile_bytes || !any_nonzero {\n            status_out[tx] = 0;\n        } else if any_nonzero && vw == tile && vh == tile {\n            status_out[tx] = 2;\n            b_x0 = b_x0.min(tile_x0);",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: sstep_f64x2 i64x2_all_true(le_a) early return mutated from zero_v to one_v",
        RG,
        [(
            "    let le_a = f64x2_le(x_v, a_v);\n    if i64x2_all_true(le_a) {\n        return zero_v;\n    }",
            "    let le_a = f64x2_le(x_v, a_v);\n    if i64x2_all_true(le_a) {\n        return one_v;\n    }",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: sstep_f64x2 i64x2_all_true(ge_b) early return mutated from one_v to zero_v",
        RG,
        [(
            "    let ge_b = f64x2_ge(x_v, b_v);\n    if i64x2_all_true(ge_b) {\n        return one_v;\n    }",
            "    let ge_b = f64x2_ge(x_v, b_v);\n    if i64x2_all_true(ge_b) {\n        return zero_v;\n    }",
        )],
        "killed",
        {"px": ["range"]},
    ),
    # ---- px.js, kernels_js.js, kernels.js
    (
        "px.js: rangeTilesRgba 1-tile-row copy reverted to copying the whole band",
        PJ,
        [(
            "        const rowStart = (ry0 - y0) * W * 4;\n        const rowBytes = (ry1 - ry0) * W * 4;\n        const rowSlice = u8.subarray(rowStart, rowStart + rowBytes);",
            "        const rowStart = (ry0 - y0) * W * 4;\n        const rowBytes = u8.byteLength;\n        const rowSlice = u8;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "px.js: rangeTilesRgba jobInvert flag bit (invert ? 2 : 0) dropped",
        PJ,
        [(
            "        const mode = isColor ? 1 : 0;\n        const flags = (limit.invert ? 1 : 0) | (invert ? 2 : 0);",
            "        const mode = isColor ? 1 : 0;\n        const flags = (limit.invert ? 1 : 0);",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "px.js: rangeHexToRgb01 3-char #rgb hex expansion broken",
        PJ,
        [(
            "    if (clean.length === 3) {\n        return [\n            parseInt(clean[0] + clean[0], 16) / 255,",
            "    if (clean.length === 3) {\n        return [\n            parseInt(clean[0], 16) / 255,",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "kernels_js.js: rangeTilesRgba colour libmExp(-dd / twoS2) reverted to Math.exp(-dd / twoS2)",
        KJ,
        [(
            "                    const dd = d0 * d0 + 4 * (d1 * d1 + d2 * d2);\n                    v = libmExp(-dd / twoS2);",
            "                    const dd = d0 * d0 + 4 * (d1 * d1 + d2 * d2);\n                    v = Math.exp(-dd / twoS2);",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "kernels_js.js: rangeTilesRgba luma product table sum divided by 256 instead of 255",
        KJ,
        [(
            "                if (!isColor) {\n                    v = (RANGE_LUMA_R[rb] + RANGE_LUMA_G[gb] + RANGE_LUMA_B[bb]) / 255;",
            "                if (!isColor) {\n                    v = (RANGE_LUMA_R[rb] + RANGE_LUMA_G[gb] + RANGE_LUMA_B[bb]) / 256;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "kernels_js.js: rangeTilesRgba colour twoS2 = 2 * s * s mutated to s * s",
        KJ,
        [(
            "    const s = 0.04 + Math.max(0, Math.min(1, (tol || 0) / 100)) * 0.6;\n    const twoS2 = 2 * s * s;",
            "    const s = 0.04 + Math.max(0, Math.min(1, (tol || 0) / 100)) * 0.6;\n    const twoS2 = s * s;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "kernels.js: rangeTilesRgba route selection swapped between rangeColor and rangeLuma",
        KR,
        [(
            "    const isColor = limit && (limit.source === \"color\" || (limit.source !== \"luma\" && limit.color != null));\n    const p = rustPx(isColor ? \"rangeColor\" : \"rangeLuma\");",
            "    const isColor = limit && (limit.source === \"color\" || (limit.source !== \"luma\" && limit.color != null));\n    const p = rustPx(isColor ? \"rangeLuma\" : \"rangeColor\");",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "kernels.js: rangeTilesRgba catch trap recovery dropped",
        KR,
        [(
            "        } catch (err) {\n            if (!recovered(p, err, \"range_tiles_rgba\")) throw err;\n        } finally { releaseIfLarge(); }",
            "        } catch (err) {\n            throw err;\n        } finally { releaseIfLarge(); }",
        )],
        "killed",
        {"px": ["retouchRoute"]},
    ),
    (
        "kernels_js.js: RANGE_OPP_R[i] = 0.299 * u mutated to (0.299 * i) / 255",
        KJ,
        [(
            "    RANGE_INV255[i] = u;\n    RANGE_OPP_R[i] = 0.299 * u;\n    RANGE_OPP_G[i] = 0.587 * u;",
            "    RANGE_INV255[i] = u;\n    RANGE_OPP_R[i] = (0.299 * i) / 255;\n    RANGE_OPP_G[i] = 0.587 * u;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "inpaint_worker.js: rangeSelectJob luma/color alphaSum += res.alphaSum mutated to alphaSum = res.alphaSum",
        WK,
        [(
            "        for (let ty = startTileY; ty < endTileY; ty++) {\n            const res = rangeTilesRgba(buf, W, H, ty, y0, y1, rowLimit, invert, TILE);\n            alphaSum += res.alphaSum;",
            "        for (let ty = startTileY; ty < endTileY; ty++) {\n            const res = rangeTilesRgba(buf, W, H, ty, y0, y1, rowLimit, invert, TILE);\n            alphaSum = res.alphaSum;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "inpaint_worker.js: rangeSelectJob luma/color bY0 = Math.min(bY0, res.bounds[1]) mutated to bY0 = res.bounds[1]",
        WK,
        [(
            "        for (let ty = startTileY; ty < endTileY; ty++) {\n            const res = rangeTilesRgba(buf, W, H, ty, y0, y1, rowLimit, invert, TILE);\n            alphaSum += res.alphaSum;\n            for (const t of res.tiles) {\n                tiles.push(t);\n                if (t.alpha) transfer.push(t.alpha);\n            }\n            if (res.bounds) {\n                bX0 = Math.min(bX0, res.bounds[0]);\n                bY0 = Math.min(bY0, res.bounds[1]);",
            "        for (let ty = startTileY; ty < endTileY; ty++) {\n            const res = rangeTilesRgba(buf, W, H, ty, y0, y1, rowLimit, invert, TILE);\n            alphaSum += res.alphaSum;\n            for (const t of res.tiles) {\n                tiles.push(t);\n                if (t.alpha) transfer.push(t.alpha);\n            }\n            if (res.bounds) {\n                bX0 = Math.min(bX0, res.bounds[0]);\n                bY0 = res.bounds[1];",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "inpaint_worker.js: rangeSelectJob luma/color bX0 = Math.min(bX0, res.bounds[0]) mutated to bX0 = res.bounds[0]",
        WK,
        [(
            "            if (res.bounds) {\n                bX0 = Math.min(bX0, res.bounds[0]);\n                bY0 = Math.min(bY0, res.bounds[1]);",
            "            if (res.bounds) {\n                bX0 = res.bounds[0];\n                bY0 = Math.min(bY0, res.bounds[1]);",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "inpaint_weights.js: normalizeLimit #rgb / #rrggbb hex validation dropped",
        WT,
        [(
            "        if (v.color != null) {\n            if (typeof v.color !== \"string\" || !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.color)) {\n                throw new Error(`limit.color must be #rgb or #rrggbb (got ${JSON.stringify(v.color)})`);\n            }\n            res.color = v.color;\n        }",
            "        if (v.color != null) {\n            res.color = String(v.color);\n        }",
        )],
        "killed",
        {"px": ["range"]},
    ),
]
