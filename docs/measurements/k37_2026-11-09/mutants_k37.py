TITLE = "K37"
WORKING = [
    "renderer/editor/inpaint_tiles.js",
    "renderer/editor/inpaint_canvas.js",
    "tools/px_test.js",
    "tools/editor_test.py",
]
GATES = []
TILES = "on"

MUTANTS = [
    (
        "fill_color_swap",
        "renderer/editor/inpaint_tiles.js",
        [
            (
                "const w = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;",
                "const w = ((255 << 24) | (r << 16) | (g << 8) | b) >>> 0;",
            )
        ],
        "killed: fillTile swaps red and blue channels",
        {"px": ["compositeSha"]},
    ),
    (
        "composite_fill_op_ignore",
        "renderer/editor/inpaint_tiles.js",
        [
            (
                "if (!old && op !== 0) return;",
                "if (!old && op !== 2) return;",
            )
        ],
        "killed: compositeFill skips missing tile on source-over (op = 0) instead of source-atop (op = 2)",
        {"px": ["compositeSha"]},
    ),
    (
        "composite_fill_edge_clamp_bw",
        "renderer/editor/inpaint_tiles.js",
        [
            (
                "if (bw < TILE_SIZE) for (let y = 0; y < bh; y++) cov.fill(0, y * TILE_SIZE + bw, (y + 1) * TILE_SIZE);",
                "if (false && bw < TILE_SIZE) for (let y = 0; y < bh; y++) cov.fill(0, y * TILE_SIZE + bw, (y + 1) * TILE_SIZE);",
            )
        ],
        "killed: partial right edge tile (bw < 256) is not clamped to layer width",
        {"px": ["compositeSha"]},
    ),
    (
        "composite_fill_edge_clamp_bh",
        "renderer/editor/inpaint_tiles.js",
        [
            (
                "if (bh < TILE_SIZE) cov.fill(0, bh * TILE_SIZE);",
                "if (false && bh < TILE_SIZE) cov.fill(0, bh * TILE_SIZE);",
            )
        ],
        "killed: partial bottom edge tile (bh < 256) is not clamped to layer height",
        {"px": ["compositeSha"]},
    ),
    (
        "composite_fill_off_grid_dtx",
        "renderer/editor/inpaint_tiles.js",
        [
            (
                "if ((ox & (TILE_SIZE - 1)) === 0 && (oy & (TILE_SIZE - 1)) === 0) {",
                "if (true || ((ox & (TILE_SIZE - 1)) === 0 && (oy & (TILE_SIZE - 1)) === 0)) {",
            )
        ],
        "killed: off-grid offset uses 256-aligned tile shift instead of tilesSource",
        {"px": ["compositeSha"]},
    ),
    (
        "bucket_fill_alpha_scale",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                "target.compositeFill(r.tiles, color, OPS[op], Math.round(Math.max(0, Math.min(1, opacity)) * 255), [r.x - layer.x, r.y - layer.y]);",
                "target.compositeFill(r.tiles, color, OPS[op], 255, [r.x - layer.x, r.y - layer.y]);",
            )
        ],
        "killed: bucketFill ignores brushOpacity when calling compositeFill",
        {"editor": ["the_bucket_fills_through_the_kernel_on_tiles"]},
    ),
    (
        "bucket_fill_offset_drop",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                "target.compositeFill(r.tiles, color, OPS[op], Math.round(Math.max(0, Math.min(1, opacity)) * 255), [r.x - layer.x, r.y - layer.y]);",
                "target.compositeFill(r.tiles, color, OPS[op], Math.round(Math.max(0, Math.min(1, opacity)) * 255), [0, 0]);",
            )
        ],
        "killed: bucketFill ignores selection/flood origin offset when calling compositeFill",
        {"editor": ["the_bucket_fills_through_the_kernel_on_tiles"]},
    ),
    (
        "bucket_fill_guard_alpha_lock",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                "const tiles = this.tileMode && InpaintEditor.bucketTiles !== false && !(alphaLocked && opacity >= 1)",
                "const tiles = this.tileMode && InpaintEditor.bucketTiles !== false",
            )
        ],
        "killed: alpha-locked fill at full opacity takes tile route and differs on semi-transparent backdrop pixels",
        {"editor": ["the_bucket_fills_through_the_kernel_on_tiles"]},
    ),
    (
        "bucket_fill_guard_no_layer",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                "&& (!layer || (isTilePixels(layer.px)",
                "&& (!!layer && (isTilePixels(layer.px)",
            )
        ],
        "killed: bucketFill with no active layer skips the tile route",
        {"editor": ["the_bucket_fills_through_the_kernel_on_tiles"]},
    ),
    (
        "bucket_fill_guard_scale_w",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                "&& layer.px.width === layer.w && layer.px.height === layer.h",
                "&& true && layer.px.height === layer.h",
            )
        ],
        "killed: horizontally scaled layer takes tile route instead of canvas path",
        {"editor": ["the_bucket_fills_through_the_kernel_on_tiles"]},
    ),
    (
        "bucket_fill_guard_scale_h",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                "&& layer.px.width === layer.w && layer.px.height === layer.h",
                "&& layer.px.width === layer.w && true",
            )
        ],
        "killed: vertically scaled layer takes tile route instead of canvas path",
        {"editor": ["the_bucket_fills_through_the_kernel_on_tiles"]},
    ),
    (
        "bucket_fill_guard_int_x",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                "&& layer.x === Math.round(layer.x) && layer.y === Math.round(layer.y)));",
                "&& true && layer.y === Math.round(layer.y)));",
            )
        ],
        "killed: layer with fractional x offset takes tile route instead of canvas path",
        {"editor": ["the_bucket_fills_through_the_kernel_on_tiles"]},
    ),
    (
        "bucket_fill_guard_int_y",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                "&& layer.x === Math.round(layer.x) && layer.y === Math.round(layer.y)));",
                "&& layer.x === Math.round(layer.x) && true));",
            )
        ],
        "killed: layer with fractional y offset takes tile route instead of canvas path",
        {"editor": ["the_bucket_fills_through_the_kernel_on_tiles"]},
    ),
    (
        "bucket_fill_color_race",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                "target.compositeFill(r.tiles, color, OPS[op], Math.round(Math.max(0, Math.min(1, opacity)) * 255), [r.x - layer.x, r.y - layer.y]);",
                "target.compositeFill(r.tiles, this.color, OPS[op], Math.round(Math.max(0, Math.min(1, opacity)) * 255), [r.x - layer.x, r.y - layer.y]);",
            )
        ],
        "killed: compositeFill reads this.color after await instead of click-time color",
        {"editor": ["the_bucket_fills_through_the_kernel_on_tiles"]},
    ),
    (
        "bucket_fill_post_await_guard",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                'if (r.tiles && (!isTilePixels(target) || typeof target.compositeFill !== "function" || target.width !== layer.w || target.height !== layer.h || layer.x !== Math.round(layer.x) || layer.y !== Math.round(layer.y))) {',
                "if (false && r.tiles) {",
            )
        ],
        "killed: layer geometry change during flood await is not caught before undo and compositeFill",
        {"editor": ["the_bucket_fills_through_the_kernel_on_tiles"]},
    ),
]
