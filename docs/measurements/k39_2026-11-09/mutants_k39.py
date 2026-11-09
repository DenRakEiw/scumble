TITLE = "K39"
WORKING = [
    "renderer/editor/inpaint_canvas.js",
    "renderer/editor/inpaint_raster.js",
    "renderer/editor/px/kernels.js",
    "tools/px_test.js",
    "tools/editor_test.py",
]
GATES = []
TILES = "on"

MUTANTS = [
    (
        "canvas_drop_returned_bounds",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                "            bounds = growMaskBounds(img.data, W, H, n);",
                "            growMaskBounds(img.data, W, H, n);",
            )
        ],
        "killed: growSelectionNow discards the bounds returned by growMaskBounds and forces a selectionBounds rescan",
        {"editor": ["grow_selection_fallback_routes_through_grow_mask_bounds"]},
    ),
    (
        "canvas_negate_grow_radius",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                "            bounds = growMaskBounds(img.data, W, H, n);",
                "            bounds = growMaskBounds(img.data, W, H, -n);",
            )
        ],
        "killed: growSelectionNow negates n when calling growMaskBounds on the fallback path",
        {"editor": ["grow_selection_fallback_routes_through_grow_mask_bounds"]},
    ),
    (
        "canvas_skip_write_rect",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                "            bounds = growMaskBounds(img.data, W, H, n);\n            this.sel.writeRect(img, 0, 0);",
                "            bounds = growMaskBounds(img.data, W, H, n);",
            )
        ],
        "killed: growSelectionNow fails to write the grown ImageData back into this.sel",
        {"editor": ["grow_selection_fallback_routes_through_grow_mask_bounds"]},
    ),
    (
        "raster_ignore_grow_mask_route",
        "renderer/editor/inpaint_raster.js",
        [
            (
                '    const p = rustPx("growMask");',
                "    const p = rustPx();",
            )
        ],
        "killed: growMaskBounds ignores the growMask route override",
        {"px": ["route"]},
    ),
    (
        "raster_skip_release_if_large",
        "renderer/editor/inpaint_raster.js",
        [
            (
                "        finally { if (ms) ms.kernel = (ms.kernel || 0) + performance.now() - t; releaseIfLarge(); }",
                "        finally { if (ms) ms.kernel = (ms.kernel || 0) + performance.now() - t; }",
            )
        ],
        "killed: growMaskBounds fails to call releaseIfLarge after growing wasm memory",
        {"editor": ["grow_selection_fallback_routes_through_grow_mask_bounds"]},
    ),
    (
        "raster_js_fallback_drop_bounds",
        "renderer/editor/inpaint_raster.js",
        [
            (
                "    const bounds = maskBounds(d, W, H);",
                "    const bounds = null;",
            )
        ],
        "killed: growMaskBounds JS fallback returns null instead of maskBounds(d, W, H)",
        {"px": ["route"]},
    ),
]
