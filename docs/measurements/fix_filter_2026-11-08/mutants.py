"""Mutation round for fix-filter (filters/filter-layer-over-its-own-input):
every changed site in renderer/editor/inpaint_canvas.js and renderer/editor/inpaint_filters_gl.js tested against the composite gate on both backends (--tiles on and --tiles off).

    python tools/mutation_round.py make TREE docs/measurements/fix_filter_2026-11-08/mutants.py
    python tools/mutation_round.py run TREE OUT docs/measurements/fix_filter_2026-11-08/mutants.py --port 9627
"""
TITLE = "fix-filter (plain filter layer replaces its input)"
WORKING = [
    "renderer/editor/inpaint_canvas.js",
    "renderer/editor/inpaint_filters_gl.js",
    "tools/composite_test.py",
]
GATES = ["composite"]
TILES = "on"

IC = "renderer/editor/inpaint_canvas.js"
FG = "renderer/editor/inpaint_filters_gl.js"
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
        '    flushFilterChain(ctx, chain) {\n        if (!chain) return null;\n        ctx.globalAlpha = 1;\n        ctx.globalCompositeOperation = "source-over";\n        if (!drawSurfaceTo(ctx, chain.surface, chain.x, chain.y, chain.w, chain.h, true)) {\n            const flat = surfaceToCanvas(chain.surface);\n            if (flat) {\n                ctx.clearRect(chain.x, chain.y, chain.w, chain.h);\n                ctx.drawImage(flat, chain.x, chain.y, chain.w, chain.h);\n            }\n        }',
        '    flushFilterChain(ctx, chain) {\n        if (!chain) return null;\n        ctx.globalAlpha = 1;\n        ctx.globalCompositeOperation = "source-over";\n        if (!drawSurfaceTo(ctx, chain.surface, chain.x, chain.y, chain.w, chain.h, false)) {\n            const flat = surfaceToCanvas(chain.surface);\n            if (flat) {\n                ctx.drawImage(flat, chain.x, chain.y, chain.w, chain.h);\n            }\n        }',
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
    )
]

NOOP_SELF_CLEAR_GUARD = [
    (
        "        chain = this.flushFilterChain(ctx, chain);   // the result goes onto the canvas, so the composite has to be there\n        if (!out || (plain && out === ctx.canvas)) return null;",
        "        chain = this.flushFilterChain(ctx, chain);   // the result goes onto the canvas, so the composite has to be there\n        if (!out) return null;",
    )
]

FILTER_KEY_PLAIN = [
    (
        "        if (isEffectView) baseKey.push(true);\n        if (layer.params && layer.params.limit) baseKey.push(!!plain);",
        "        if (isEffectView) baseKey.push(true);\n        if (false && layer.params && layer.params.limit) baseKey.push(!!plain);",
    )
]

VIEW_MARGIN_CROP = [
    (
        "        const margin = !!(vp && (rx < 0 || ry < 0 || rx + rw > this.width || ry + rh > this.height));\n        let fvp = vp;\n        if (margin && !this.isFillLayer(layer)) {",
        "        const margin = !!(vp && (rx < 0 || ry < 0 || rx + rw > this.width || ry + rh > this.height));\n        let fvp = vp;\n        if (false && margin && !this.isFillLayer(layer)) {",
    )
]

FLUSH_FALLBACK_GUARD = [
    (
        '        if (!drawSurfaceTo(ctx, chain.surface, chain.x, chain.y, chain.w, chain.h, true)) {\n            const flat = surfaceToCanvas(chain.surface);\n            if (flat) {\n                ctx.clearRect(chain.x, chain.y, chain.w, chain.h);\n                ctx.drawImage(flat, chain.x, chain.y, chain.w, chain.h);\n            }\n        }',
        '        if (!drawSurfaceTo(ctx, chain.surface, chain.x, chain.y, chain.w, chain.h, true)) {\n            const flat = surfaceToCanvas(chain.surface);\n            ctx.clearRect(chain.x, chain.y, chain.w, chain.h);\n            if (flat) ctx.drawImage(flat, chain.x, chain.y, chain.w, chain.h);\n        }',
    )
]

DRAW_SURFACE_CLEAR_BEFORE_BLIT = [
    (
        "    let first = clear;\n    return readSurface(g, s, (x0, y0, w, h) => {\n        if (first) { ctx.clearRect(dx, dy, dw, dh); first = false; }",
        "    if (clear) ctx.clearRect(dx, dy, dw, dh);\n    return readSurface(g, s, (x0, y0, w, h) => {",
    )
]

FILL_AFTER_CROPPED_CHAIN_FLUSH = [
    (
        "        if (chain && margin && this.isFillLayer(layer)) chain = this.flushFilterChain(ctx, chain);",
        "        if (false && chain && margin && this.isFillLayer(layer)) chain = this.flushFilterChain(ctx, chain);",
    )
]

MASK_STROKE_MVP_MARGIN = [
    (
        "                const sx = m.width / rw, sy = m.height / rh;\n                const mvp = { ...(fvp || vp), sx, sy };",
        "                const sx = m.width / rw, sy = m.height / rh;\n                const mvp = { ...vp, sx, sy };",
    )
]

MUTANTS = [
    ("applyFilterLayer clear reversed (tiles=on)", IC, APPLY_CLEAR, "killed", KILL_ON),
    ("applyFilterLayer clear reversed (tiles=off)", IC, APPLY_CLEAR, "killed", KILL_OFF),
    ("flushFilterChain clear reversed (tiles=on)", IC, FLUSH_CLEAR, "killed", KILL_ON),
    ("flushFilterChain clear reversed (tiles=off)", IC, FLUSH_CLEAR, "killed", KILL_OFF),
    ("filteredCanvas limitOver=!keepSurface (tiles=on)", IC, LIMIT_OVER, "killed", KILL_ON),
    ("filteredCanvas limitOver=!keepSurface (tiles=off)", IC, LIMIT_OVER, "killed", KILL_OFF),
    ("limitMissing non-plain guard reversed (tiles=on)", IC, LIMIT_MISSING_GUARD, "killed", KILL_ON),
    ("limitMissing non-plain guard reversed (tiles=off)", IC, LIMIT_MISSING_GUARD, "killed", KILL_OFF),
    ("applyFilterLayer no-op self-clear guard reversed (tiles=on)", IC, NOOP_SELF_CLEAR_GUARD, "killed", KILL_ON),
    ("applyFilterLayer no-op self-clear guard reversed (tiles=off)", IC, NOOP_SELF_CLEAR_GUARD, "killed", KILL_OFF),
    ("filterKey limit plain omitted (tiles=on)", IC, FILTER_KEY_PLAIN, "killed", KILL_ON),
    ("filterKey limit plain omitted (tiles=off)", IC, FILTER_KEY_PLAIN, "killed", KILL_OFF),
    ("applyFilterLayer view margin crop disabled (tiles=on)", IC, VIEW_MARGIN_CROP, "killed", KILL_ON),
    ("applyFilterLayer view margin crop disabled (tiles=off)", IC, VIEW_MARGIN_CROP, "killed", KILL_OFF),
    ("flushFilterChain fallback clear before null check (tiles=on)", IC, FLUSH_FALLBACK_GUARD, "killed", KILL_ON),
    ("flushFilterChain fallback clear before null check (tiles=off)", IC, FLUSH_FALLBACK_GUARD, "killed", KILL_OFF),
    ("drawSurfaceTo clear before readSurface blit (tiles=on)", FG, DRAW_SURFACE_CLEAR_BEFORE_BLIT, "killed", KILL_ON),
    ("drawSurfaceTo clear before readSurface blit (tiles=off)", FG, DRAW_SURFACE_CLEAR_BEFORE_BLIT, "killed", KILL_OFF),
    ("applyFilterLayer fill after cropped chain flush disabled (tiles=on)", IC, FILL_AFTER_CROPPED_CHAIN_FLUSH, "killed", KILL_ON),
    ("applyFilterLayer fill after cropped chain flush disabled (tiles=off)", IC, FILL_AFTER_CROPPED_CHAIN_FLUSH, "killed", KILL_OFF),
    ("applyFilterLayer mask stroke mvp uses uncropped vp (tiles=on)", IC, MASK_STROKE_MVP_MARGIN, "killed", KILL_ON),
]
