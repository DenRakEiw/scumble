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
        "killed: source-atop over missing tile allocates and fills instead of skipping",
        {"px": ["compositeSha"]},
    ),
    (
        "composite_fill_edge_clamp_skip",
        "renderer/editor/inpaint_tiles.js",
        [
            (
                "if (bw < TILE_SIZE || bh < TILE_SIZE) {",
                "if (false && (bw < TILE_SIZE || bh < TILE_SIZE)) {",
            )
        ],
        "killed: partial right/bottom edge tile is not clamped to layer width/height",
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
                "target.compositeFill(r.tiles, this.color, OPS[op], Math.round(Math.max(0, Math.min(1, opacity)) * 255), [r.x - layer.x, r.y - layer.y]);",
                "target.compositeFill(r.tiles, this.color, OPS[op], 255, [r.x - layer.x, r.y - layer.y]);",
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
                "target.compositeFill(r.tiles, this.color, OPS[op], Math.round(Math.max(0, Math.min(1, opacity)) * 255), [r.x - layer.x, r.y - layer.y]);",
                "target.compositeFill(r.tiles, this.color, OPS[op], Math.round(Math.max(0, Math.min(1, opacity)) * 255), [0, 0]);",
            )
        ],
        "killed: bucketFill ignores selection/flood origin offset when calling compositeFill",
        {"editor": ["the_bucket_fills_through_the_kernel_on_tiles"]},
    ),
]
