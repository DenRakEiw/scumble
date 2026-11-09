TITLE = "K38"
WORKING = [
    "renderer/editor/inpaint_filters.js",
    "renderer/editor/px/kernels.js",
    "renderer/editor/px/px.js",
    "tools/px_test.js",
    "tools/editor_test.py",
]
GATES = []
TILES = "on"

MUTANTS = [
    (
        "match_params_swap_means",
        "renderer/editor/inpaint_filters.js",
        [
            (
                "        meanS[0], meanS[1], meanS[2],\n        meanT[0], meanT[1], meanT[2],",
                "        meanT[0], meanT[1], meanT[2],\n        meanS[0], meanS[1], meanS[2],",
            )
        ],
        "killed: matchCanvas swaps source and target means in matchPixels params",
        {"px": ["match"]},
    ),
    (
        "match_params_channel_order",
        "renderer/editor/inpaint_filters.js",
        [
            (
                "        scale[0], scale[1], scale[2],",
                "        scale[2], scale[1], scale[0],",
            )
        ],
        "killed: matchCanvas reverses scale channel order in matchPixels params",
        {"px": ["match"]},
    ),
    (
        "match_strength_clamp_low",
        "renderer/editor/inpaint_filters.js",
        [
            (
                "    const k = Math.max(0, Math.min(1, strength));",
                "    const k = Math.min(1, strength);",
            )
        ],
        "killed: matchCanvas fails to clamp negative strength to 0",
        {"px": ["match"]},
    ),
    (
        "match_strength_clamp_high",
        "renderer/editor/inpaint_filters.js",
        [
            (
                "    const k = Math.max(0, Math.min(1, strength));",
                "    const k = Math.max(0, strength);",
            )
        ],
        "killed: matchCanvas fails to clamp strength > 1 to 1",
        {"px": ["match"]},
    ),
    (
        "match_chunk_single_only",
        "renderer/editor/inpaint_filters.js",
        [
            (
                "    for (let off = 0; off < d.length; off += MATCH_CHUNK_BYTES) {",
                "    for (let off = 0; off < Math.min(d.length, MATCH_CHUNK_BYTES); off += MATCH_CHUNK_BYTES) {",
            )
        ],
        "killed: matchCanvas stops after the first 4 MP chunk",
        {"px": ["match"]},
    ),
    (
        "match_chunk_zero_offset",
        "renderer/editor/inpaint_filters.js",
        [
            (
                "        matchPixels(d.subarray(off, off + MATCH_CHUNK_BYTES), params);",
                "        matchPixels(d.subarray(0, MATCH_CHUNK_BYTES), params);",
            )
        ],
        "killed: matchCanvas passes subarray at offset 0 on every chunk",
        {"px": ["match"]},
    ),
    (
        "match_chunk_unbounded",
        "renderer/editor/inpaint_filters.js",
        [
            (
                "        matchPixels(d.subarray(off, off + MATCH_CHUNK_BYTES), params);",
                "        if (off === 0) matchPixels(d, params);",
            )
        ],
        "killed: matchCanvas passes the full unchunked buffer to matchPixels",
        {"px": ["match"]},
    ),
    (
        "kernels_route_ignore",
        "renderer/editor/px/kernels.js",
        [
            (
                '    const p = rustPx("matchPixels");',
                "    const p = rustPx();",
            )
        ],
        "killed: kernels.js matchPixels ignores the matchPixels route override",
        {"px": ["match"]},
    ),
    (
        "px_subarray_offset_drop",
        "renderer/editor/px/px.js",
        [
            (
                "            this._out(Uint8Array, pd, px * 4, rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, px * 4));",
                "            this._out(Uint8Array, pd, px * 4, rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, 0, px * 4));",
            )
        ],
        "killed: Px.matchPixels drops byteOffset when writing back to a Uint8ClampedArray subarray",
        {"px": ["match"]},
    ),
]
