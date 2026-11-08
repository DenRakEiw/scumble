"""K9 mutation round config for tools/mutation_round.py (docs/PLAN_WASM_BUILD.md §4.3 K9)."""

TITLE = "K9 (flood_shape out_kind / cells, the alpha-tile cut, the grow / shrink cut)"

WORKING = [
    "crates/px/src/jobs.rs",
    "crates/px/src/lib.rs",
    "renderer/editor/px/px.wasm",
    "renderer/editor/px/px_scalar.wasm",
    "renderer/editor/px/px.js",
    "renderer/editor/px/kernels_js.js",
    "renderer/editor/px/kernels.js",
    "renderer/editor/inpaint_raster.js",
    "renderer/editor/inpaint_worker.js",
    "tools/px_test.js",
    "tools/combine_test.js",
    "tools/editor_test.py",
]

GATES = []
TILES = "on"

JR = "crates/px/src/jobs.rs"
PJ = "renderer/editor/px/px.js"
KJS = "renderer/editor/px/kernels_js.js"
KJ = "renderer/editor/px/kernels.js"
IR = "renderer/editor/inpaint_raster.js"
IW = "renderer/editor/inpaint_worker.js"

PX_KILL = {"px": ["relightBench", "route", "trap", "job"]}

MUTANTS = [
    # ---- crates/px/src/jobs.rs: grow_mask margins & cells, flood_shape out_kind & cells
    (
        "jobs.rs: grow_mask does not clear right margin bx1..w",
        JR,
        [(
            "        fill_red_clear(&mut d[row_start..row_start + bx0 * 4]);\n        fill_red_clear(&mut d[row_start + bx1 * 4..row_start + w * 4]);",
            "        fill_red_clear(&mut d[row_start..row_start + bx0 * 4]);",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "jobs.rs: grow_mask marks unchanged occupied cell as 1 instead of 2",
        JR,
        [(
            "                    if same[ci] as usize == cw * ch {\n                        c[ci] = 2;\n                    }",
            "                    if same[ci] as usize == cw * ch {\n                        c[ci] = 1;\n                    }",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "jobs.rs: grow_mask uses 256*256 instead of cw*ch for partial edge cell",
        JR,
        [(
            "                    let cw = (w - tx * 256).min(256);\n                    if same[ci] as usize == cw * ch {",
            "                    let cw = 256usize;\n                    if same[ci] as usize == cw * 256 {",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "jobs.rs: grow_mask no-cells branch writes alpha 254 instead of 255",
        JR,
        [(
            "                p.copy_from_slice(&[255, 0, 0, if inside { 255 } else { 0 }]);",
            "                p.copy_from_slice(&[255, 0, 0, if inside { 254 } else { 0 }]);",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "jobs.rs: flood_shape out_kind == 1 writes 254 instead of 255",
        JR,
        [(
            "                if m != 0 {\n                    *o = 255;",
            "                if m != 0 {\n                    *o = 254;",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "jobs.rs: flood_shape out_kind == 1 does not mark cells[row_c + (x >> 8)] = 1",
        JR,
        [(
            "                    *o = 255;\n                    count += 1;\n                    if let Some(c) = cells.as_deref_mut() {\n                        c[row_c + (x >> 8)] = 1;\n                    }",
            "                    *o = 255;\n                    count += 1;",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "jobs.rs: flood_shape out_kind == 4 does not mark cells[row_c + (x >> 8)] = 1",
        JR,
        [(
            "                    o.copy_from_slice(&px);\n                    count += 1;\n                    if let Some(c) = cells.as_deref_mut() {\n                        c[row_c + (x >> 8)] = 1;\n                    }",
            "                    o.copy_from_slice(&px);\n                    count += 1;",
        )],
        "killed",
        PX_KILL,
    ),
    # ---- renderer/editor/px/px.js: growMask cells copy-out, floodShape outKind & cells
    (
        "px.js: growMask does not copy cells out from wasm memory",
        PJ,
        [(
            "            this._out(Uint8Array, pd, bytes, new Uint8Array(d.buffer, d.byteOffset, bytes));\n            if (cells && nCells > 0) this._out(Uint8Array, pc, nCells, new Uint8Array(cells.buffer, cells.byteOffset, nCells));",
            "            this._out(Uint8Array, pd, bytes, new Uint8Array(d.buffer, d.byteOffset, bytes));",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "px.js: floodShape forces kind = 4 even when outKind === 1",
        PJ,
        [(
            "        const kind = outKind === 1 ? 1 : 4;",
            "        const kind = 4;",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "px.js: floodShape does not pass cells to use",
        PJ,
        [(
            "            return use(view, info[0], bounds, cells);",
            "            return use(view, info[0], bounds);",
        )],
        "killed",
        PX_KILL,
    ),
    # ---- renderer/editor/px/kernels_js.js: floodShape outKind === 1 and cells
    (
        "kernels_js.js: floodShape outKind === 1 writes 254 instead of 255",
        KJS,
        [(
            "                out[p] = 255;\n                cells[rowC + (x >> 8)] = 1;",
            "                out[p] = 254;\n                cells[rowC + (x >> 8)] = 1;",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "kernels_js.js: floodShape outKind === 1 does not mark cells",
        KJS,
        [(
            "                out[p] = 255;\n                cells[rowC + (x >> 8)] = 1;",
            "                out[p] = 255;",
        )],
        "killed",
        PX_KILL,
    ),
    # ---- renderer/editor/px/kernels.js: floodShape outKind forwarding
    (
        "kernels.js: floodShape does not forward outKind to p.floodShape",
        KJ,
        [(
            "        try { return p.floodShape(rgba, w, h, sx, sy, tolerance, contiguous, sel, rgb, once, outKind); }",
            "        try { return p.floodShape(rgba, w, h, sx, sy, tolerance, contiguous, sel, rgb, once); }",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "kernels.js: floodShape does not forward outKind to J.floodShape",
        KJ,
        [(
            "    return J.floodShape(rgba, w, h, sx, sy, tolerance, contiguous, sel, rgb, use, outKind);",
            "    return J.floodShape(rgba, w, h, sx, sy, tolerance, contiguous, sel, rgb, use);",
        )],
        "killed",
        PX_KILL,
    ),
    # ---- renderer/editor/inpaint_raster.js: growMask cells and growMaskBounds fallback
    (
        "inpaint_raster.js: growMask marks unchanged occupied cell as 1 instead of 2",
        IR,
        [(
            "                    if (same[ci] === cw * ch) cells[ci] = 2;",
            "                    if (same[ci] === cw * ch) cells[ci] = 1;",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "inpaint_raster.js: growMaskBounds does not pass cells to fallback growMask",
        IR,
        [(
            "    growMask(d, W, H, n, { ms, cells });",
            "    growMask(d, W, H, n, { ms });",
        )],
        "killed",
        PX_KILL,
    ),
    # ---- renderer/editor/inpaint_worker.js: selectionOverTiles and floodOverTiles
    (
        "inpaint_worker.js: selectionOverTiles does not skip c === 2 unchanged cells",
        IW,
        [(
            "            const c = cells[ty * cols + tx];\n            if (c === 2) continue;",
            "            const c = cells[ty * cols + tx];\n            if (false && c === 2) continue;",
        )],
        "killed",
        {"editor": ["grow_shrink_and_feather_over_tiles_are_the_canvases"]},
    ),
    (
        "inpaint_worker.js: selectionOverTiles does not emit empty: true when !c and name present",
        IW,
        [(
            "            if (!c) { if (name) tiles.push({ tx, ty, empty: true }); continue; }",
            "            if (!c) { continue; }",
        )],
        "killed",
        {"editor": ["grow_shrink_and_feather_over_tiles_are_the_canvases"]},
    ),
    (
        "inpaint_worker.js: floodOverTiles does not skip empty cells in bounds",
        IW,
        [(
            "                if (!cells[ty * cols + tx]) continue;",
            "                if (false && !cells[ty * cols + tx]) continue;",
        )],
        "killed",
        {"editor": ["the_flood_over_tiles_is_the_flood_over_canvases"]},
    ),
]
