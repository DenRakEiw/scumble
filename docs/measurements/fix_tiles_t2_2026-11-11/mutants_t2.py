"""Mutation round for fix-tiles session T-2 (`tiles/T4` in `renderer/editor/inpaint_tiles.js`), in
`tools/mutation_round.py` format with no worktree path hard-coded.

    python tools/mutation_round.py make <scratch_tree> docs/measurements/fix_tiles_t2_2026-11-11/mutants_t2.py
    python tools/mutation_round.py run <scratch_tree> <scratch_out> docs/measurements/fix_tiles_t2_2026-11-11/mutants_t2.py orig <names...> --port 9643 --lock <busy_lock>

Kill sets: px_test's `sel` group first (tools/px_test.js `selCases` runs tools/combine_test.js, check "combine_test.js in
js and rust modes": its block 12b on both selCombine routes), then the `pixels` gate on the tile backend
(tools/pixels_test.js `mask_combine_keeps_unchanged_tiles`, both backends inside the one instance); a survivor runs the
full px_test and GATES (the re-check).
"""
TITLE = "fix-tiles T-2 (tiles/T4)"
WORKING = []
GATES = ["pixels"]
TILES = "on"

IT = "renderer/editor/inpaint_tiles.js"
PIX = {"px": ["sel"], "gates": ["pixels"], "tiles": "on"}

SKIP_NEW = ("                if (had && LITTLE && ((v.kind === SEL_NONE && (m === 1 || m === 2)) || (v.kind === SEL_FULL && m === 3))\n"
            "                    && selUnchanged(had, bw, bh, SEL & 0xFFFFFF)) continue;\n")

MUTANTS = [
    # the fix's reversal: every tile goes through the kernel again (bytes the same, the tiles rewritten)
    ("t4_revert", IT, [(SKIP_NEW, "")], "killed: canonical tiles are rewritten (new object / version, snapshot no longer shares them)", PIX),
    # skips a tile it must change
    ("t4_no_canonical_check", IT, [(" && selUnchanged(had, bw, bh, SEL & 0xFFFFFF)) continue;", ") continue;")],
     "killed: a green patch / colour at alpha 0 / an empty tile kept as it was", PIX),
    ("t4_skip_replace_none", IT, [("(v.kind === SEL_NONE && (m === 1 || m === 2))", "(v.kind === SEL_NONE && m <= 2)")],
     "killed: replace of nothing keeps tiles it must clear", PIX),
    ("t4_skip_intersect_none", IT, [("(v.kind === SEL_NONE && (m === 1 || m === 2))", "(v.kind === SEL_NONE && m >= 1)")],
     "killed: intersect with nothing keeps tiles it must drop", PIX),
    ("t4_skip_subtract_full", IT, [("(v.kind === SEL_FULL && m === 3)", "(v.kind === SEL_FULL && m >= 2)")],
     "killed: subtract of everything keeps tiles it must clear", PIX),
    ("t4_no_alpha0_check", IT, [("if (w < ALPHA || ((w ^ rgb24) & 0xFFFFFF) !== 0) return false;", "if (((w ^ rgb24) & 0xFFFFFF) !== 0) return false;")],
     "killed: a pixel with the colour at alpha 0 is kept (the combine zeroes it)", PIX),
    ("t4_no_colour_check", IT, [("if (w < ALPHA || ((w ^ rgb24) & 0xFFFFFF) !== 0) return false;", "if (w < ALPHA) return false;")],
     "killed: a green pixel is kept (the combine paints it red)", PIX),
    ("t4_empty_skipped", IT, [("    return any;\n}\n\n/** The exact non-transparent extent", "    return true;\n}\n\n/** The exact non-transparent extent")],
     "killed: an existing empty tile is kept (the combine drops it)", PIX),
    ("t4_short_rows", IT, [("for (let i = y * TILE_SIZE, e = i + bw; i < e; i++) {", "for (let i = y * TILE_SIZE, e = i + bw - 1; i < e; i++) {")],
     "killed: the last column of each tile is not checked", PIX),
    ("t4_short_cols", IT, [("    for (let y = 0; y < bh; y++) {\n        for (let i = y * TILE_SIZE, e = i + bw;", "    for (let y = 0; y < bh - 1; y++) {\n        for (let i = y * TILE_SIZE, e = i + bw;")],
     "killed: the last row of each tile is not checked", PIX),
    ("t4_wrong_colour", IT, [("selUnchanged(had, bw, bh, SEL & 0xFFFFFF)", "selUnchanged(had, bw, bh, 0x0000FF)")],
     "killed: a white combine (a layer mask) keeps red tiles", PIX),
]
