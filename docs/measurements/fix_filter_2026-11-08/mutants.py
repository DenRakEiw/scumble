"""Mutation round for fix-filter (filters/filter-layer-over-its-own-input):
every changed site in renderer/editor/inpaint_canvas.js tested against the composite gate on both backends (--tiles on and --tiles off).

    python tools/mutation_round.py make TREE docs/measurements/fix_filter_2026-11-08/mutants.py
    python tools/mutation_round.py run TREE OUT docs/measurements/fix_filter_2026-11-08/mutants.py --port 9627
"""
TITLE = "fix-filter (plain filter layer replaces its input)"
WORKING = [
    "renderer/editor/inpaint_canvas.js",
    "tools/composite_test.py",
]
GATES = ["composite"]
TILES = "on"

IC = "renderer/editor/inpaint_canvas.js"
KILL_ON = {"gates": ["composite"], "tiles": "on"}
KILL_OFF = {"gates": ["composite"], "tiles": "off"}

APPLY_CLEAR = [
    (
        '            ctx.globalCompositeOperation = limitView ? "source-over" : canvasOp(layer.blend);\n            if (plain) ctx.clearRect(rx, ry, rw, rh);\n            ctx.drawImage(src, rx, ry, rw, rh);',
        '            ctx.globalCompositeOperation = limitView ? "source-over" : canvasOp(layer.blend);\n            ctx.drawImage(src, rx, ry, rw, rh);',
    )
]

FLUSH_CLEAR = [
    (
        '    flushFilterChain(ctx, chain) {\n        if (!chain) return null;\n        ctx.globalAlpha = 1;\n        ctx.globalCompositeOperation = "source-over";\n        ctx.clearRect(chain.x, chain.y, chain.w, chain.h);\n        if (!drawSurfaceTo(ctx, chain.surface, chain.x, chain.y, chain.w, chain.h)) {',
        '    flushFilterChain(ctx, chain) {\n        if (!chain) return null;\n        ctx.globalAlpha = 1;\n        ctx.globalCompositeOperation = "source-over";\n        if (!drawSurfaceTo(ctx, chain.surface, chain.x, chain.y, chain.w, chain.h)) {',
    )
]

LIMIT_OVER = [
    (
        "        info.limitOver = !plain;\n        beginScope();",
        "        info.limitOver = !keepSurface;\n        beginScope();",
    )
]

LIMIT_MISSING_GUARD = [
    (
        "        if (info.limitMissing && canvas === input && !(keepSurface && isGLSurface(canvas))) canvas = null;",
        "        if (info.limitMissing && canvas === input && false) canvas = null;",
    ),
    (
        "        chain = this.flushFilterChain(ctx, chain);   // the result goes onto the canvas, so the composite has to be there\n        if (!out || (plain && out === ctx.canvas)) return null;",
        "        chain = this.flushFilterChain(ctx, chain);   // the result goes onto the canvas, so the composite has to be there\n        if (!out) return null;",
    ),
]

MUTANTS = [
    ("applyFilterLayer clear reversed (tiles=on)", IC, APPLY_CLEAR, "killed", KILL_ON),
    ("applyFilterLayer clear reversed (tiles=off)", IC, APPLY_CLEAR, "killed", KILL_OFF),
    ("flushFilterChain clear reversed (tiles=on)", IC, FLUSH_CLEAR, "killed", KILL_ON),
    ("flushFilterChain clear reversed (tiles=off)", IC, FLUSH_CLEAR, "killed", KILL_OFF),
    ("filteredCanvas limitOver=!keepSurface (tiles=on)", IC, LIMIT_OVER, "killed", KILL_ON),
    ("filteredCanvas limitOver=!keepSurface (tiles=off)", IC, LIMIT_OVER, "killed", KILL_OFF),
    ("limitMissing self-clear guard reversed (tiles=on)", IC, LIMIT_MISSING_GUARD, "killed", KILL_ON),
    ("limitMissing self-clear guard reversed (tiles=off)", IC, LIMIT_MISSING_GUARD, "killed", KILL_OFF),
]
