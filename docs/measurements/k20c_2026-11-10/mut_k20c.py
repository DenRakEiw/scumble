"""K20c mutation round for tools/mutation_round.py (docs/PLAN_WASM_K20.md §4.2): readOraBlob's offsets and budgets, the
shared reader's limits, the routes in readLayered, the read's cleanup, and the base's own PNG. Every mutant has the
layered gate as its focused kill set (it runs tools/layered_test.js first); the canvas backend where the mutant is about
it. Written while the machine was busy: not run yet (chain-p's status.md says when).

    python tools/mutation_round.py make TREE docs/measurements/k20c_2026-11-10/mut_k20c.py
    python tools/mutation_round.py run TREE OUT docs/measurements/k20c_2026-11-10/mut_k20c.py orig ... --port 9621 --lock LOCK
"""
TITLE = "K20c"
GATES = ["layered"]
TILES = "on"

LAYERED = "renderer/editor/inpaint_layered.js"
CANVAS = "renderer/editor/inpaint_canvas.js"
KILL = {"gates": ["layered"]}
KILL_CANVAS = {"gates": ["layered"], "tiles": "off"}

MUTANTS = [
    ("tail_short_by_one", LAYERED, [("blob.slice(Math.max(0, blob.size - 65557))", "blob.slice(Math.max(0, blob.size - 65556))")], "killed: the longest comment", KILL),
    ("directory_from_one_later", LAYERED, [("zipDirectory(await read(blob.slice(p)), 0, count, blob.size)", "zipDirectory(await read(blob.slice(p + 1)), 0, count, blob.size)")], "killed: damaged directory", KILL),
    ("directory_step_without_comment", LAYERED, [("p += 46 + nameLen + extra + comment;", "p += 46 + nameLen + extra;")], "killed: the comment moves the next record", KILL),
    ("directory_step_without_extra", LAYERED, [("p += 46 + nameLen + extra + comment;", "p += 46 + nameLen + comment;")], "killed: the extra moves the next record", KILL),
    ("local_bound_one_tighter", LAYERED, [("if (local + 30 > fileSize)", "if (local + 31 > fileSize)")], "killed: a header that just fits", KILL),
    ("local_bound_gone", LAYERED, [("if (local + 30 > fileSize) throw new Error(\"the ORA file's zip directory is damaged\");", "")], "killed: the header past the file", KILL),
    ("local_offset_without_extra", LAYERED, [("const at = e.local + 30 + local.getUint16(26, true) + local.getUint16(28, true);", "const at = e.local + 30 + local.getUint16(26, true);")], "killed: the local extra field", KILL),
    ("local_offset_without_name", LAYERED, [("const at = e.local + 30 + local.getUint16(26, true) + local.getUint16(28, true);", "const at = e.local + 30 + local.getUint16(28, true);")], "killed: the local name", KILL),
    ("slice_one_short", LAYERED, [('e.blob = blob.slice(at, at + e.csize, "image/png");', 'e.blob = blob.slice(at, at + e.csize - 1, "image/png");')], "killed: the PNG bytes", KILL),
    ("slice_untyped", LAYERED, [('e.blob = blob.slice(at, at + e.csize, "image/png");', "e.blob = blob.slice(at, at + e.csize);")], "killed: the twin's type check", KILL),
    ("head_short", LAYERED, [("await read(png.slice(0, 24))", "await read(png.slice(0, 23))")], "killed: crafted_png.ora opens", KILL),
    ("head_not_cached", LAYERED, [("if (!heads.has(png)) heads.set(png,", "heads.set(png,")], "killed: one entry named many times", KILL),
    ("entry_not_cached", LAYERED, [("        if (e.blob) return e.blob;\n", "")], "killed: one entry named many times", KILL),
    ("deflated_kept_as_bytes", LAYERED, [('keep: (png) => ({ pngBlob: png instanceof Uint8Array ? new Blob([png], { type: "image/png" }) : png }),', "keep: (png) => ({ pngBlob: png }),")], "killed: the twin's Blob check", KILL),
    ("xml_cap_gone", LAYERED, [('if (name === "stack.xml" && e.size > ORA_XML_MAX) throw', 'if (false) throw')], "killed: crafted_xml.ora", KILL),
    ("budget_gone", LAYERED, [("if (unpacked + e.size > budget) throw", "if (false) throw")], "killed: crafted_declared.ora", KILL),
    ("budget_counts_nothing", LAYERED, [("const budget = ORA_INFLATE_BASE + ORA_INFLATE_RATIO * fileSize;", "const budget = Infinity;")], "killed: crafted_declared.ora", KILL),
    ("layer_cap_gone", LAYERED, [("checkRect(label, size.w, size.h, ORA_LAYER_MAX_PIXELS);", ";")], "killed: crafted_decode.ora", KILL),
    ("pixel_budget_gone", LAYERED, [("if (pixels > pixelBudget) throw", "if (false) throw")], "killed: crafted_many.ora", KILL),
    ("onheader_after_the_layers", LAYERED, [("    if (onHeader) onHeader({ width, height });\n", ""), ('    if (missing.length) notes.push(`${missing.length} layer', '    if (onHeader) onHeader({ width, height });\n    if (missing.length) notes.push(`${missing.length} layer')], "killed: onHeader before the layers", KILL),

    ("stream_on_the_canvas_backend", CANVAS, [("if (this.tileMode && InpaintEditor.oraParted !== false && pngReaderUsable()) {", "if (InpaintEditor.oraParted !== false && pngReaderUsable()) {")], "killed: the canvas backend's bitmaps", KILL_CANVAS),
    ("toggle_ignored", CANVAS, [("if (this.tileMode && InpaintEditor.oraParted !== false && pngReaderUsable()) {", "if (this.tileMode && pngReaderUsable()) {")], "killed: oraParted = false took the pool", KILL),
    ("sixteen_bits_on_the_stream", CANVAS, [("if (h && h.bitDepth === 8 && !h.interlace) {", "if (h && !h.interlace) {")], "killed: deep.ora's bitmap", KILL),
    ("interlaced_on_the_stream", CANVAS, [("if (h && h.bitDepth === 8 && !h.interlace) {", "if (h && h.bitDepth === 8) {")], "equivalent: readPng refuses interlaced files and the fall-through decodes them", KILL),
    ("parted_refusal_falls_through", CANVAS, [("if ((err && err.partedRefused) || h.width * h.height > CANVAS_MAX_PIXELS) throw err;", "if (h.width * h.height > CANVAS_MAX_PIXELS) throw err;")], "killed: the damaged layer's partedRefused", KILL),
    ("no_release_on_failure", CANVAS, [("if (x.px) { x.px.release(); x.px = null; }", "if (x.px) { x.px = null; }")], "killed: tiles held after the failure", KILL),
    ("no_cancel_before_a_layer", CANVAS, [('                const L = doc.layers[i];\n                if (later()) throw new CancelledError("layered_open");\n', "                const L = doc.layers[i];\n")], "killed: the cancelled read", KILL),
    ("base_always_encoded", CANVAS, [("const raw = kind === \"ora\" && basePx === b?.px ? await this.oraBaseUpload(doc, file) : null;", "const raw = null;")], "killed: the stored file's name", KILL),
    ("base_with_gamma_uploaded", CANVAS, [("        if (!(await pngIsPlainSrgb(b.pngBlob))) return null;\n", "")], "killed: gamma.ora", KILL),
    ("base_upload_ignores_the_toggle", CANVAS, [("if (!b || !b.pngBlob || InpaintEditor.oraParted === false) return null;", "if (!b || !b.pngBlob) return null;")], "killed: oraParted = false encodes", KILL),
]
