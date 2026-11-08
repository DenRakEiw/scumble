"""K29's mutation round (docs/PLAN_WASM_BUILD.md §1.3, §1.4, §4.9: normal tier, mutation round on the kernel and call sites),
run by tools/mutation_round.py on a copy of the tree:

    python tools/mutation_round.py make TREE docs/measurements/k29_2026-11-08/mutation/mut_k29.py
    python tools/mutation_round.py run TREE OUT docs/measurements/k29_2026-11-08/mutation/mut_k29.py --port 9617

Kill sets: px_test's groups `liquify` (liquify_preview on both builds against inpaint_liquify.js `previewBlock` across
all grid steps, levels, scales, negative/out-of-layer margins, opaque/translucent/faint/zero windows, held and plain
windows, and refusal contracts) and `retouchRoute` (kernels.js' allocLiquifyWindow, freeLiquifyWindow, liquifyPreview on
win.px after dropPx, detached win.data refresh on mid-stroke route/mode switch, refusal fallback, trap recovery); the
editor gate's `liquify_bakes_each_stroke_from_the_session_source` on tiles (asserting liquify_preview ran, mid-stroke
route switch after growing win.px.memory, and window release on pointer up, Escape, error, tool switch, and tab close).
"""
TITLE = "K29"
WORKING = [
    "crates/px/src/resample.rs",
    "crates/px/src/lib.rs",
    "renderer/editor/px/px.js",
    "renderer/editor/px/kernels.js",
    "renderer/editor/px/px.wasm",
    "renderer/editor/px/px_scalar.wasm",
    "renderer/editor/inpaint_liquify.js",
    "renderer/editor/inpaint_canvas.js",
    "tools/px_test.js",
    "tools/editor_test.py",
    "tools/liquify_perf.js",
    "docs/measurements/k29_2026-11-08/mutation/mut_k29.py",
]
GATES = ["editor"]
TILES = "on"

RS = "crates/px/src/resample.rs"
LB = "crates/px/src/lib.rs"
PJ = "renderer/editor/px/px.js"
KJ = "renderer/editor/px/kernels.js"
IL = "renderer/editor/inpaint_liquify.js"
IC = "renderer/editor/inpaint_canvas.js"

LIQ = {"px": ["liquify"]}
ROUTE = {"px": ["retouchRoute"]}
LIQ_ROUTE = {"px": ["liquify", "retouchRoute"]}
STEP = "liquify_bakes_each_stroke_from_the_session_source"
FREEZE_STEP = "liquify_freeze_holds_what_it_covers"
CALL = {"px": ["retouchRoute"], "editor": [STEP]}
STEP_TILES = {"editor": [STEP]}
FREEZE_TILES = {"editor": [FREEZE_STEP]}

MUTANTS = [
    # ---- resample::liquify_preview
    ("liquify_preview: step 8 refused", RS, [("    if !matches!(s, 1 | 2 | 4 | 8)\n        || ww == 0", "    if !matches!(s, 1 | 2 | 4)\n        || ww == 0")], "killed", LIQ),
    ("liquify_preview: xmax missing * s_f", RS, [("    let xmax = ((((lw - 1) >> ls) + 1) as f64) * s_f;", "    let xmax = (((lw - 1) >> ls) + 1) as f64;")], "killed", LIQ),
    ("liquify_preview: node bounds check skipped", RS, [("        if gx0 < 0 || gy0 < 0 || (gx1 as usize) + 1 >= nw || (gy1 as usize) + 1 >= nh {\n            return 0;\n        }", "        if false {\n            return 0;\n        }")], "killed", LIQ),
    ("liquify_preview: level shift l2 ignored", RS, [("    let l2 = (1u32 << level) as f64;", "    let l2 = 1.0;")], "killed", LIQ),
    ("liquify_preview: cy out-of-layer not cleared", RS, [("        if cy < 0.0 || cy >= h_f {\n            out[row_out..row_out + bw * 4].fill(0);\n            continue;\n        }", "        if false {\n            out[row_out..row_out + bw * 4].fill(0);\n            continue;\n        }")], "killed", LIQ),
    ("liquify_preview: cx out-of-layer not cleared", RS, [("            if cx < 0.0 || cx >= w_f {\n                // SAFETY: o + 4 <= need_out <= out.len()", "            if false {\n                // SAFETY: o + 4 <= need_out <= out.len()")], "killed", LIQ),
    ("liquify_preview: node weights n10 and n01 swapped", RS, [("            let n10 = fx_n * ey_n;\n            let n01 = ex_n * fy_n;", "            let n10 = ex_n * fy_n;\n            let n01 = fx_n * ey_n;")], "killed", LIQ),
    ("liquify_preview: d0 reads dy slot a + 1", RS, [("                let d0 = n00 * (*nodes.get_unchecked(a) as f64)", "                let d0 = n00 * (*nodes.get_unchecked(a + 1) as f64)")], "killed", LIQ),
    ("liquify_preview: d1 reads b + 2 instead of b + 3", RS, [("                    + n11 * (*nodes.get_unchecked(b + 3) as f64);\n                (d0, d1)", "                    + n11 * (*nodes.get_unchecked(b + 2) as f64);\n                (d0, d1)")], "killed", LIQ),
    ("liquify_preview: sx omits pixel-centre - 0.5", RS, [("            let sx = (cx + d0 / 256.0) / l2 - 0.5 - wx0_f;", "            let sx = (cx + d0 / 256.0) / l2 - wx0_f;")], "killed", LIQ),
    ("liquify_preview: sy omits wy0_f offset", RS, [("            let sy = (cy + d1 / 256.0) / l2 - 0.5 - wy0_f;", "            let sy = (cy + d1 / 256.0) / l2 - 0.5;")], "killed", LIQ),
    ("liquify_preview: x1 clamp omits + 1", RS, [("            let x1 = clamp_index(ix0 + 1, ww_max);", "            let x1 = clamp_index(ix0, ww_max);")], "killed", LIQ),
    ("liquify_preview: y1 clamp omits + 1", RS, [("            let y1 = clamp_index(iy0 + 1, wh_max);", "            let y1 = clamp_index(iy0, wh_max);")], "killed", LIQ),
    ("liquify_preview: w10 and w01 bilinear weights swapped", RS, [("                let w10 = fx * (1.0 - fy) * (*win.get_unchecked(q10 + 3) as f64);\n                let w01 = (1.0 - fx) * fy * (*win.get_unchecked(q01 + 3) as f64);", "                let w10 = (1.0 - fx) * fy * (*win.get_unchecked(q10 + 3) as f64);\n                let w01 = fx * (1.0 - fy) * (*win.get_unchecked(q01 + 3) as f64);")], "killed", LIQ),
    ("liquify_preview: a_sum < 0.5 leaves dst unwritten", RS, [("                if a_sum < 0.5 {\n                    dst.fill(0);", "                if a_sum < 0.5 {")], "killed", LIQ),
    ("liquify_preview: unpremultiply division by a_sum omitted on red", RS, [("                    dst[0] = ((w00 * (*win.get_unchecked(q00) as f64)\n                        + w10 * (*win.get_unchecked(q10) as f64)\n                        + w01 * (*win.get_unchecked(q01) as f64)\n                        + w11 * (*win.get_unchecked(q11) as f64))\n                        / a_sum\n                        + 0.5) as i32 as u8;", "                    dst[0] = ((w00 * (*win.get_unchecked(q00) as f64)\n                        + w10 * (*win.get_unchecked(q10) as f64)\n                        + w01 * (*win.get_unchecked(q01) as f64)\n                        + w11 * (*win.get_unchecked(q11) as f64))\n                        + 0.5) as i32 as u8;")], "killed", LIQ),
    ("liquify_preview: + 0.5 rounding omitted on alpha", RS, [("                    dst[3] = (a_sum + 0.5) as i32 as u8;", "                    dst[3] = a_sum as i32 as u8;")], "killed", LIQ),
    # ---- lib.rs
    ("lib.rs: liquify_preview swaps wx0 and wy0", LB, [("    resample::liquify_preview(win, ww, wh, wx0, wy0, level, lw, lh, s, nodes, nw, nx0, ny0, ox, oy, inv, out, bw, bh)", "    resample::liquify_preview(win, ww, wh, wy0, wx0, level, lw, lh, s, nodes, nw, nx0, ny0, ox, oy, inv, out, bw, bh)")], "killed", LIQ),
    ("lib.rs: liquify_preview swaps ox and oy", LB, [("    resample::liquify_preview(win, ww, wh, wx0, wy0, level, lw, lh, s, nodes, nw, nx0, ny0, ox, oy, inv, out, bw, bh)", "    resample::liquify_preview(win, ww, wh, wx0, wy0, level, lw, lh, s, nodes, nw, nx0, ny0, oy, ox, inv, out, bw, bh)")], "killed", LIQ),
    # ---- px.js
    ("px.js: foreign win.px not refused", PJ, [("        if (win.px && !held) return false;", "        if (false && win.px && !held) return false;")], "killed", LIQ_ROUTE),
    ("px.js: held win copied via _in instead of reading win.ptr in place", PJ, [("            const pwin = held ? win.ptr : this._in(a, win.data, winBytes);", "            const pwin = this._in(a, win.data, winBytes);")], "killed", ROUTE),
    # ---- kernels.js, inpaint_liquify.js and inpaint_canvas.js
    ("kernels.js: allocLiquifyWindow never uses px.alloc", KJ, [("    const p = rustPx(\"liquifyPreview\");", "    const p = null;")], "killed", CALL),
    ("kernels.js: freeLiquifyWindow does not clear win.ptr", KJ, [("    win.px = null;\n    win.ptr = 0;", "    win.px = null;")], "killed", CALL),
    ("kernels.js: freeLiquifyWindow drops p.free(ptr, bytes)", KJ, [("    try { p.free(ptr, bytes); }", "    try { }")], "killed", CALL),
    ("kernels.js: liquifyPreview uses rustPx instead of win.px", KJ, [("    const p = win && win.px;", "    const p = rustPx(\"liquifyPreview\");")], "killed", ROUTE),
    ("kernels.js: liquifyPreview ignores route", KJ, [("    if (p && win.ptr && !p.trapped && MODE === \"rust\" && route(\"liquifyPreview\") !== \"js\") {", "    if (p && win.ptr && !p.trapped && MODE === \"rust\") {")], "killed", CALL),
    ("inpaint_liquify.js: previewBlock does not refresh detached win.data", IL, [("    if (win.px && win.ptr && (!win.data || win.data.buffer !== win.px.memory.buffer)) {\n        win.data = new Uint8Array(win.px.memory.buffer, win.ptr, win.w * win.h * 4);\n    }", "    if (false) {}")], "killed", CALL),
    ("inpaint_canvas.js: liquifyWindow holds initial alloc.data view across _levelBytes", IC, [("        const view = () => (alloc.px ? alloc.px.u8().subarray(alloc.ptr, alloc.ptr + alloc.bytes) : alloc.data);", "        const view = () => alloc.data;")], "killed", STEP_TILES),
    ("inpaint_canvas.js: liquifyCommit does not free liquifyWindow", IC, [("        if (liq.ended) liq.orig.release();\n        this.freeLiquifyWindow(p);", "        if (liq.ended) liq.orig.release();")], "killed", STEP_TILES),
    ("inpaint_canvas.js: liquifyDrop does not free liquifyWindow", IC, [("        if (p.tick) { clearInterval(p.tick); p.tick = null; }\n        this.freeLiquifyWindow(p);", "        if (p.tick) { clearInterval(p.tick); p.tick = null; }")], "killed", STEP_TILES),
    ("inpaint_canvas.js: liquifyDrop does not restore freezeBefore on Escape", IC, [("        if (p.freeze && p.freezeBefore && p.freezeBefore.size) {", "        if (false && p.freeze && p.freezeBefore && p.freezeBefore.size) {")], "killed", FREEZE_TILES),
]
