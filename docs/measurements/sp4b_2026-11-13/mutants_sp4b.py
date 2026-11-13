TITLE = "SP4b: strokes on the Deep paint layer"
WORKING = [
    "renderer/editor/inpaint_ed_filters.js",
    "renderer/editor/inpaint_ed_pointer.js",
    "tools/deeppaint_test.py",
]
GATES = ["deeppaint"]
TILES = "on"

F = "renderer/editor/inpaint_ed_filters.js"
P = "renderer/editor/inpaint_ed_pointer.js"
K = {"gates": ["deeppaint"]}
KC = {"gates": ["deeppaint"], "tiles": "off"}

MUTANTS = [
    ("pointer_refuses_own", P,
     [("if (layer && layer.kind === \"filter\" && !this.hasOwnPixels(layer)) { this.setStatus(\"Filter layers have no pixels. Add a mask",
       "if (layer && layer.kind === \"filter\") { this.setStatus(\"Filter layers have no pixels. Add a mask")],
     "killed: the brush refused on Deep paint", K),
    ("own_pixels_any_filter", F,
     [("return !!(layer && layer.kind === \"filter\" && layer.px && FILTERS[layer.filter] && FILTERS[layer.filter].ownPixels);",
       "return !!(layer && layer.kind === \"filter\" && layer.px);")],
     "killed: grain takes the brush", K),
    ("no_live_stroke_tiles", F,
     [("if (p) this.drawStrokeInto(ctx, { x: 0, y: 0, w: W, h: H }, layer.px, op, vp, [0, 0, w, h]);",
       "if (false) this.drawStrokeInto(ctx, { x: 0, y: 0, w: W, h: H }, layer.px, op, vp, [0, 0, w, h]);")],
     "killed: the live stroke does not show", K),
    ("no_live_stroke_canvas", F,
     [("            } else if (p) {\n                ctx.drawImage(this.layerWithStroke(layer)",
       "            } else if (false) {\n                ctx.drawImage(this.layerWithStroke(layer)")],
     "killed: the live stroke does not show (canvas)", KC),
    ("key_without_stroke", F,
     [("if (!forRun && this.liveStrokeOn(layer)) baseKey.push(\"stroke\", this.pixelVersion);",
       "if (!forRun && this.liveStrokeOn(layer)) baseKey.push(\"stroke\");")],
     "killed: the cached pass hides the stroke", K),
    ("live_stroke_in_runs", F,
     [("const p = !pass.forRun && this.liveStrokeOn(layer) && this.pointer.kind === \"layerpaint\" ? this.pointer : null;",
       "const p = this.liveStrokeOn(layer) && this.pointer.kind === \"layerpaint\" ? this.pointer : null;")],
     "killed: a run's picture has the uncommitted stroke", K),
    ("live_erase_paints", F,
     [("const op = p ? (p.erase ? \"destination-out\" : (layer.alphaLock ? \"source-atop\" : \"source-over\")) : null;",
       "const op = p ? \"source-over\" : null;")],
     "killed: the live erase paints", K),
    ("key_without_px_version", F,
     [("            baseKey.push(layer.px ? layer.px.version : -1);\n",
       "            baseKey.push(0);\n")],
     "unknown: a commit and an undo also move compositeVersion", K),
]
