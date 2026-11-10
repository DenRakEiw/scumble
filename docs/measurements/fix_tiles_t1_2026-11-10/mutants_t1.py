"""Mutation round for fix-tiles session T-1 (`tiles/T1` and `tiles/T2` in `renderer/editor/inpaint_compositor.js`),
in `tools/mutation_round.py` format with no worktree path hard-coded.

    python tools/mutation_round.py make <scratch_tree> docs/measurements/fix_tiles_t1_2026-11-10/mutants_t1.py
    python tools/mutation_round.py run <scratch_tree> <scratch_out> docs/measurements/fix_tiles_t1_2026-11-10/mutants_t1.py --port 9643 --lock <busy_lock>
"""
TITLE = "fix-tiles T-1 (tiles/T1, tiles/T2)"
WORKING = []
GATES = ["composite"]
TILES = "on"

IC = "renderer/editor/inpaint_compositor.js"

COMP_TILES = {"gates": ["composite"], "tiles": "on"}
COMP_CANVAS = {"gates": ["composite"], "tiles": "off", "full_gates": ["composite"]}

SET_BUDGET_NEW = "        this.atlasBudget = Math.min(ATLAS_BUDGET_MAX, Math.max(ATLAS_BUDGET_MIN, Math.floor(Number(bytes)) || 0));"
SET_BUDGET_OLD = "        this.atlasBudget = Math.max(16 * 1024 * 1024, bytes | 0);"

SLOT_EVICT_NEW = "        if (this.atlasBytes >= this.atlasBudget) this._evictOther(entry);\n        if (this.atlasBytes < this.atlasBudget) {"
SLOT_EVICT_OLD = "        if (this.atlasBytes < this.atlasBudget) {"

COMP_NULL_NEW = "                if (!tiles) { this._evictAtlas(); return null; }"
COMP_NULL_OLD = "                if (!tiles) return null;"

MUTANTS = [
    # ---- tiles/T2 reversals and boundary checks
    ("t2_revert_tiles", IC, [(SET_BUDGET_NEW, SET_BUDGET_OLD)], "killed: 2048 MB wraps via | 0 to 16 MB on tiles", COMP_TILES),
    ("t2_revert_canvas", IC, [(SET_BUDGET_NEW, SET_BUDGET_OLD)], "killed: 2048 MB wraps via | 0 to 16 MB on canvas", COMP_CANVAS),
    ("t2_no_max_clamp", IC, [(
        SET_BUDGET_NEW,
        "        this.atlasBudget = Math.max(ATLAS_BUDGET_MIN, Math.floor(Number(bytes)) || 0);",
    )], "killed: 32768 MB and Infinity are not clamped to ATLAS_BUDGET_MAX", COMP_TILES),
    ("t2_no_min_clamp", IC, [(
        SET_BUDGET_NEW,
        "        this.atlasBudget = Math.min(ATLAS_BUDGET_MAX, Math.floor(Number(bytes)) || 0);",
    )], "killed: 0 and negative budgets drop below ATLAS_BUDGET_MIN", COMP_TILES),
    ("t2_no_floor", IC, [(
        "Math.floor(Number(bytes)) || 0",
        "Number(bytes) || 0",
    )], "killed: fractional byte budget is not floored", COMP_TILES),
    ("t2_no_nan_fallback", IC, [(
        "Math.floor(Number(bytes)) || 0",
        "Math.floor(Number(bytes))",
    )], "killed: NaN / undefined propagates NaN out of Math.min / Math.max", COMP_TILES),

    # ---- tiles/T1 reversals and eviction invariants
    ("t1_revert_tiles", IC, [(SLOT_EVICT_NEW, SLOT_EVICT_OLD), (COMP_NULL_NEW, COMP_NULL_OLD)],
     "killed: over-budget zoom returns null and never evicts stale levels on tiles", COMP_TILES),
    ("t1_revert_canvas", IC, [(SLOT_EVICT_NEW, SLOT_EVICT_OLD), (COMP_NULL_NEW, COMP_NULL_OLD)],
     "killed: over-budget zoom returns null and never evicts stale levels on canvas", COMP_CANVAS),
    ("t1_drop_slot_evict", IC, [(SLOT_EVICT_NEW, SLOT_EVICT_OLD)],
     "killed: mid-frame _slot fails to evict older levels when crossing 64 MB", COMP_TILES),
    ("t1_drop_null_evict", IC, [(COMP_NULL_NEW, COMP_NULL_OLD)],
     "killed: null return leaves emptied records in this.atlas", COMP_TILES),
    ("t1_evict_own_entry", IC, [(
        "                if (entry === keep) continue;\n",
        "",
    )], "killed: panning by 1 tile column evicts the entry's own 256-slot page and re-uploads all 272 tiles", COMP_TILES),
    ("t1_evict_this_frame", IC, [(
        "                    if (page.used !== this.frame) all.push({ entry, page });",
        "                    all.push({ entry, page });",
    )], "killed: deletes earlier layers' pages from the current frame and corrupts composite pixels", COMP_TILES),
    ("t1_evict_reverse_lru", IC, [(
        "        if (this.atlasBytes < this.atlasBudget) return;\n        all.sort((a, b) => a.page.used - b.page.used);",
        "        if (this.atlasBytes < this.atlasBudget) return;\n        all.sort((a, b) => b.page.used - a.page.used);",
    )], "killed: evicts newer level-2 pages ahead of older level-3 pages", COMP_TILES),
    ("t1_evict_le_boundary", IC, [(
        "        if (this.atlasBytes < this.atlasBudget) return;\n        all.sort((a, b) => a.page.used - b.page.used);\n        for (const it of all) {\n            if (this.atlasBytes < this.atlasBudget) break;",
        "        if (this.atlasBytes <= this.atlasBudget) return;\n        all.sort((a, b) => a.page.used - b.page.used);\n        for (const it of all) {\n            if (this.atlasBytes <= this.atlasBudget) break;",
    )], "killed: exact atlasBytes === atlasBudget boundary returns without freeing room for _slot", COMP_TILES),
]
