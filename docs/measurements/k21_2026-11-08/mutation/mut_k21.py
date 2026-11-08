"""K21 mutation round config for tools/mutation_round.py (docs/PLAN_WASM_BUILD.md §4.8)."""

TITLE = "K21 (map_tile_stats, rangeTileClass, rangeRowBookkeeping, cut picture span)"

WORKING = [
    "crates/px/src/range.rs",
    "crates/px/src/lib.rs",
    "renderer/editor/px/px.wasm",
    "renderer/editor/px/px_scalar.wasm",
    "renderer/editor/px/px.js",
    "renderer/editor/px/kernels_js.js",
    "renderer/editor/px/kernels.js",
    "renderer/editor/inpaint_weights.js",
    "renderer/editor/inpaint_edges.js",
    "renderer/editor/inpaint_worker.js",
    "renderer/editor/inpaint_canvas.js",
    "tools/px_test.js",
    "tools/weights_test.js",
    "tools/edges_test.js",
    "tools/selection_test.py",
    "tools/edges_test.py",
]

GATES = ["selection", "edges"]
TILES = "on"

RG = "crates/px/src/range.rs"
PJ = "renderer/editor/px/px.js"
KJ = "renderer/editor/px/kernels.js"
IW = "renderer/editor/inpaint_weights.js"
IC = "renderer/editor/inpaint_canvas.js"

MUTANTS = [
    # ---- range.rs: 2-texel halo, thresh boundary, min/max reduction, window bounds check
    (
        "range.rs: halo 2 -> 1 on ix0/iy0",
        RG,
        [(
            "        let ix0 = (mx0 - 2.0).floor().max(0.0).min(max_x) as usize;\n        let iy0 = (my0 - 2.0).floor().max(0.0).min(max_y) as usize;",
            "        let ix0 = (mx0 - 1.0).floor().max(0.0).min(max_x) as usize;\n        let iy0 = (my0 - 1.0).floor().max(0.0).min(max_y) as usize;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: halo 2 -> 1 on ix1/iy1",
        RG,
        [(
            "        let ix1 = (mx1 + 2.0).ceil().max(0.0).min(max_x) as usize;\n        let iy1 = (my1 + 2.0).ceil().max(0.0).min(max_y) as usize;",
            "        let ix1 = (mx1 + 1.0).ceil().max(0.0).min(max_x) as usize;\n        let iy1 = (my1 + 1.0).ceil().max(0.0).min(max_y) as usize;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: thresh > mutated to >=",
        RG,
        [
            ("                if lanes[k] > thr16 {", "                if lanes[k] >= thr16 {"),
            ("            if slice[i] > thr16 {", "            if slice[i] >= thr16 {"),
            ("            if v > thr16 {", "            if v >= thr16 {"),
        ],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: row_min_max SIMD loop bypassed to scalar tail",
        RG,
        [(
            "        let mut vmax = u16x8_splat(0);\n        let ptr = slice.as_ptr();\n        while i + 8 <= n {",
            "        let mut vmax = u16x8_splat(0);\n        let ptr = slice.as_ptr();\n        while false && i + 8 <= n {",
        )],
        "equivalent: the scalar tail computes the exact same u16 min and max",
        {"px": ["range"]},
    ),
    (
        "range.rs: hi updated from r_lo instead of r_hi",
        RG,
        [(
            "            if r_hi > hi {\n                hi = r_hi;\n            }",
            "            if r_lo > hi {\n                hi = r_lo;\n            }",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "range.rs: wy0 window bounds check dropped",
        RG,
        [(
            "        if iy0 < wy0 || iy1 >= wy1 {\n            return 0;\n        }",
            "        if false {\n            return 0;\n        }",
        )],
        "killed",
        {"px": ["range"]},
    ),
    # ---- px.js: row window calculation and input validation
    (
        "px.js: wy0 halo 2 -> 0",
        PJ,
        [(
            "            const wy0 = Math.max(0, Math.min(mh - 1, Math.floor(Math.min(ry00, ry10, ry01, ry11) - 2)));",
            "            const wy0 = Math.max(0, Math.min(mh - 1, Math.floor(Math.min(ry00, ry10, ry01, ry11))));",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "px.js: short map check dropped",
        PJ,
        [(
            "        if (map.length < mw * mh) throw new Error(\"mapTileStats: short map\");",
            "        if (false) throw new Error(\"mapTileStats: short map\");",
        )],
        "killed",
        {"px": ["range"]},
    ),
    # ---- inpaint_weights.js: rangeTileClass and rangeRowBookkeeping
    (
        "inpaint_weights.js: rangeTileClass 1e-12 slack dropped on lo",
        IW,
        [(
            "    const wLoMin = fLo > 0 ? sstep(r.lo - fLo, r.lo, vMin) : (vMin >= r.lo - 1e-12 ? 1 : 0);",
            "    const wLoMin = fLo > 0 ? sstep(r.lo - fLo, r.lo, vMin) : (vMin >= r.lo ? 1 : 0);",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "inpaint_weights.js: rangeTileClass 1e-12 slack dropped on hi",
        IW,
        [(
            "    const wHiMax = fHi > 0 ? (1 - sstep(r.hi, r.hi + fHi, vMax)) : (vMax <= r.hi + 1e-12 ? 1 : 0);",
            "    const wHiMax = fHi > 0 ? (1 - sstep(r.hi, r.hi + fHi, vMax)) : (vMax <= r.hi ? 1 : 0);",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "inpaint_weights.js: rangeTileClass jobInvert ignored",
        IW,
        [(
            "    const inv = Boolean(r.invert) !== Boolean(invert);",
            "    const inv = Boolean(r.invert);",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "inpaint_weights.js: rangeRowBookkeeping full tile uses unclamped tile width",
        IW,
        [(
            "            const tw = Math.max(0, tileX1 - tileX0);",
            "            const tw = tile;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "inpaint_weights.js: rangeRowBookkeeping bounds use unclamped tileX0 + tile",
        IW,
        [(
            "            if (tileX1 > bX1) bX1 = tileX1;",
            "            if (tileX0 + tile > bX1) bX1 = tileX0 + tile;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    # ---- kernels.js & inpaint_canvas.js: routing, skipped-row bookkeeping, cut picture span
    (
        "kernels.js: mapTileStats always runs twin",
        KJ,
        [(
            "export function mapTileStats(map, rmax, mw, mh, xf, W, H, thresh = 0, tile = 256) {\n    const p = rustPx(\"mapTileStats\");",
            "export function mapTileStats(map, rmax, mw, mh, xf, W, H, thresh = 0, tile = 256) {\n    const p = null;",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "kernels.js: mapTileStats ignores route",
        KJ,
        [(
            "export function mapTileStats(map, rmax, mw, mh, xf, W, H, thresh = 0, tile = 256) {\n    const p = rustPx(\"mapTileStats\");",
            "export function mapTileStats(map, rmax, mw, mh, xf, W, H, thresh = 0, tile = 256) {\n    const p = rustPx();",
        )],
        "killed",
        {"px": ["range"]},
    ),
    (
        "inpaint_canvas.js: skipped row posts pool job anyway",
        IC,
        [(
            "                            if (!hasCompute) {\n                                bandPromises.push(Promise.resolve({ y0, y1, res: rangeRowBookkeeping(W, H, ty, rowClasses, 256) }));\n                                continue;\n                            }",
            "                            if (false && !hasCompute) {\n                                bandPromises.push(Promise.resolve({ y0, y1, res: rangeRowBookkeeping(W, H, ty, rowClasses, 256) }));\n                                continue;\n                            }",
        )],
        "killed",
        {"gates": ["selection"]},
    ),
    (
        "inpaint_canvas.js: picture span not cut to compute-class edge tiles",
        IC,
        [(
            "                            for (let tx = 0; tx < tileCols; tx++) {\n                                const idx = rowOffset + tx;\n                                const cls = rangeTileClass(stats.min[idx] / 65535, stats.max[idx] / 65535, limit, jobInvert);\n                                if (cls === \"full\") {\n                                    rowClasses[tx] = 1;\n                                } else if (cls === \"compute\") {\n                                    rowClasses[tx] = 2;\n                                    hasCompute = true;\n                                    if (snapOn && stats.edge[idx] === 1) {\n                                        if (minTx === -1) minTx = tx;\n                                        maxTx = tx;\n                                    }\n                                }\n                            }",
            "                            for (let tx = 0; tx < tileCols; tx++) {\n                                const idx = rowOffset + tx;\n                                const cls = rangeTileClass(stats.min[idx] / 65535, stats.max[idx] / 65535, limit, jobInvert);\n                                if (snapOn && stats.edge[idx] === 1) {\n                                    if (minTx === -1) minTx = tx;\n                                    maxTx = tx;\n                                }\n                                if (cls === \"full\") {\n                                    rowClasses[tx] = 1;\n                                } else if (cls === \"compute\") {\n                                    rowClasses[tx] = 2;\n                                    hasCompute = true;\n                                }\n                            }",
        )],
        "killed",
        {"gates": ["edges"]},
    ),
]
