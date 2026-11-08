"""K28's mutation round (docs/PLAN_WASM_BUILD.md §1.3, §1.4, §4.9: full on the kernel and on the call sites), run by
tools/mutation_round.py on a copy of the tree:

    python tools/mutation_round.py make TREE docs/measurements/k28_2026-11-08/mutation/mut_k28.py
    python tools/mutation_round.py run TREE OUT docs/measurements/k28_2026-11-08/mutation/mut_k28.py --port 9617

Kill sets: px_test's groups `liquify` (liquify_block on both builds against inpaint_liquify.js across all grid steps,
phases, alphas, round-trip tables, strides and brush modes) and `retouchRoute` (kernels.js' wrapper: route, refusal
fallback, trap recovery); the editor gate's `liquify_bakes_each_stroke_from_the_session_source` on tiles (pool and
window) and on canvas (asserting liquify_block ran and replaying on the route "js").
"""
TITLE = "K28"
WORKING = [
    "crates/px/src/resample.rs",
    "crates/px/src/lib.rs",
    "renderer/editor/px/px.js",
    "renderer/editor/px/kernels.js",
    "renderer/editor/px/px.wasm",
    "renderer/editor/px/px_scalar.wasm",
    "renderer/editor/inpaint_worker.js",
    "renderer/editor/inpaint_tiles.js",
    "renderer/editor/inpaint_pixels.js",
    "tools/px_test.js",
    "tools/editor_test.py",
    "docs/measurements/k28_2026-11-08/mutation/mut_k28.py",
]
GATES = ["editor"]
TILES = "on"

RS = "crates/px/src/resample.rs"
LB = "crates/px/src/lib.rs"
PJ = "renderer/editor/px/px.js"
KJ = "renderer/editor/px/kernels.js"
IW = "renderer/editor/inpaint_worker.js"
IT = "renderer/editor/inpaint_tiles.js"
IP = "renderer/editor/inpaint_pixels.js"

LIQ = {"px": ["liquify"]}
LIQ_ROUTE = {"px": ["liquify", "retouchRoute"]}
STEP = "liquify_bakes_each_stroke_from_the_session_source"
CALL = {"px": ["retouchRoute"], "editor": [STEP]}
STEP_TILES = {"editor": [STEP]}
STEP_CANVAS = {"editor": [STEP], "tiles": "off"}

MUTANTS = [
    # ---- resample::sample (shared tap sum for resample and liquify)
    ("sample opaque: without HALF28 on red", RS, [("*px.get_unchecked_mut(0) = clamp_byte((sr + HALF28) >> 28);", "*px.get_unchecked_mut(0) = clamp_byte(sr >> 28);")], "killed", LIQ),
    ("sample opaque: count returned as 0", RS, [("*px.get_unchecked_mut(3) = 255;\n        1", "*px.get_unchecked_mut(3) = 255;\n        0")], "killed", LIQ),
    ("sample general: a <= 0 leaves px unwritten", RS, [("        if a <= 0 {\n            px.copy_from_slice(&[0, 0, 0, 0]);\n            0", "        if a <= 0 {\n            0")], "killed", LIQ),
    ("sample general: unrounded colour division", RS, [("(clamp_byte((2 * sr + sa).div_euclid(d)), clamp_byte((2 * sg + sa).div_euclid(d)), clamp_byte((2 * sb + sa).div_euclid(d)))", "(clamp_byte((2 * sr).div_euclid(d)), clamp_byte((2 * sg).div_euclid(d)), clamp_byte((2 * sb).div_euclid(d)))")], "killed", LIQ),
    ("sample general: truncated division instead of div_euclid", RS, [("(clamp_byte((2 * sr + sa).div_euclid(d)), clamp_byte((2 * sg + sa).div_euclid(d)), clamp_byte((2 * sb + sa).div_euclid(d)))", "(clamp_byte((2 * sr + sa) / d), clamp_byte((2 * sg + sa) / d), clamp_byte((2 * sb + sa) / d))")], "equivalent: sa > 0 so d = 2 * sa > 0; when 2 * sr + sa >= 0 truncated and Euclidean division coincide, and when 2 * sr + sa < 0 both quotients are <= 0 and clamp_byte clamps both to 0", LIQ),
    ("sample general: round-trip table skipped", RS, [("            if let Some(t) = rt {\n                if a < 255 {", "            if let Some(t) = rt {\n                if false {")], "killed", LIQ),
    # ---- resample::liquify
    ("liquify: step 8 refused", RS, [("    if !matches!(s, 1 | 2 | 4 | 8) || nw < 2 || out.w == 0 || out.h == 0 || block.w < 4 || block.h < 4 {", "    if !matches!(s, 1 | 2 | 4) || nw < 2 || out.w == 0 || out.h == 0 || block.w < 4 || block.h < 4 {")], "killed", LIQ),
    ("liquify: k shift without 2 * ls", RS, [("    let k = 8 + 2 * ls;", "    let k = 8 + ls;")], "killed", LIQ),
    ("liquify: kp shift off by 1", RS, [("    let kp = k - 8;", "    let kp = k - 7;")], "killed", LIQ),
    ("liquify: opaque fast path always on", RS, [("    let opaque = src[..need_block].chunks_exact(4).all(|p| p[3] == 255);", "    let opaque = true;")], "killed", LIQ),
    ("liquify: opaque fast path never used", RS, [("    let opaque = src[..need_block].chunks_exact(4).all(|p| p[3] == 255);", "    let opaque = false;")], "equivalent: when every source alpha is 255, sa = 255 * 2^28 and (2 * sr + sa).div_euclid(2 * sa) equals (sr + HALF28) >> 28", LIQ),
    ("liquify: r1 row offset missing * 2", RS, [("        let r1 = r0 + nw * 2;", "        let r1 = r0 + nw;")], "killed", LIQ),
    ("liquify: bilinear weights w10 and w01 swapped", RS, [("            let w10 = fx * gy;\n            let w01 = gx * fy;", "            let w10 = gx * fy;\n            let w01 = fx * gy;")], "killed", LIQ),
    ("liquify: dx reads dy slot a + 1", RS, [("                let dx = w00\n                    .wrapping_mul(*nodes.get_unchecked(a))", "                let dx = w00\n                    .wrapping_mul(*nodes.get_unchecked(a + 1))")], "killed", LIQ),
    ("liquify: dy reads b + 2 instead of b + 3", RS, [(".wrapping_add(w11.wrapping_mul(*nodes.get_unchecked(b + 3)));", ".wrapping_add(w11.wrapping_mul(*nodes.get_unchecked(b + 2)));")], "killed", LIQ),
    ("liquify: whole-pixel fast path on one zero phase", RS, [("            if px_phase == 0 && py_phase == 0 {", "            if px_phase == 0 || py_phase == 0 {")], "killed", LIQ),
    ("liquify: whole-pixel fast path skipped", RS, [("            if px_phase == 0 && py_phase == 0 {", "            if false {")], "killed: at the right or bottom edge of the block, the whole-pixel branch clamps to w - 1 / h - 1 while the 4-tap branch clamps cx = x - 1 to w - 4", LIQ),
    ("liquify: whole-pixel clamp subtracts 1 like bicubic", RS, [("                let cx = clamp_index((sx >> k) as i64 - block.x, max_w1);", "                let cx = clamp_index((sx >> k) as i64 - 1 - block.x, max_w1);")], "killed", LIQ),
    ("liquify: whole-pixel transparent pixel counted", RS, [("                    if p0[3] != 0 {\n                        count += 1;\n                    }", "                    count += 1;")], "killed", LIQ),
    ("liquify: bicubic tap lead -1 omitted on cx", RS, [("                let cx = clamp_index((sx >> k) as i64 - 1 - block.x, max_x);", "                let cx = clamp_index((sx >> k) as i64 - block.x, max_x);")], "killed", LIQ),
    ("liquify: bicubic tap lead -1 omitted on cy", RS, [("                let cy = clamp_index((sy >> k) as i64 - 1 - block.y, max_y);", "                let cy = clamp_index((sy >> k) as i64 - block.y, max_y);")], "killed", LIQ),
    ("liquify: wx phase not multiplied by 4", RS, [("                let wx = px_phase * 4;", "                let wx = px_phase;")], "killed", LIQ),
    ("liquify: wy phase not multiplied by 4", RS, [("                let wy = py_phase * 4;", "                let wy = py_phase;")], "killed", LIQ),
    # ---- lib.rs
    ("lib.rs: liquify_block drops rt", LB, [("    let rt = if rt.is_null() { None } else { Some(slice::from_raw_parts(rt, 65536)) };\n    let mut out = resample::Out { data: slice::from_raw_parts_mut(out, need_out), x0: x0 as i64, y0: y0 as i64, w: vw, h: vh };\n    resample::liquify(&block, nodes, nw, nx0, ny0, s, weights, rt, &mut out)", "    let _ = rt;\n    let mut out = resample::Out { data: slice::from_raw_parts_mut(out, need_out), x0: x0 as i64, y0: y0 as i64, w: vw, h: vh };\n    resample::liquify(&block, nodes, nw, nx0, ny0, s, weights, None, &mut out)")], "killed", LIQ),
    ("lib.rs: liquify_block swaps bx and by", LB, [("    let block = resample::Block { data: slice::from_raw_parts(block, need_block), w: bw, h: bh, x: bx as i64, y: by as i64 };\n    let nodes = slice::from_raw_parts(nodes, nodes_len);", "    let block = resample::Block { data: slice::from_raw_parts(block, need_block), w: bw, h: bh, x: by as i64, y: bx as i64 };\n    let nodes = slice::from_raw_parts(nodes, nodes_len);")], "killed", LIQ),
    # ---- px.js
    ("px.js: s === 8 refused", PJ, [("        if (!(s === 1 || s === 2 || s === 4 || s === 8)) return null;", "        if (!(s === 1 || s === 2 || s === 4)) return null;")], "killed", LIQ_ROUTE),
    ("px.js: gx0 < 0 not refused", PJ, [("        if (gx0 < 0 || gx1 >= nw || gy0 < 0 || !(nodes instanceof Int32Array) || nodes.length < needNodes) return null;", "        if (gx1 >= nw || gy0 < 0 || !(nodes instanceof Int32Array) || nodes.length < needNodes) return null;")], "killed", LIQ_ROUTE),
    ("px.js: nodes instanceof Int32Array not checked", PJ, [("        if (gx0 < 0 || gx1 >= nw || gy0 < 0 || !(nodes instanceof Int32Array) || nodes.length < needNodes) return null;", "        if (gx0 < 0 || gx1 >= nw || gy0 < 0 || !nodes || nodes.length < needNodes) return null;")], "killed", LIQ_ROUTE),
    ("px.js: nodes copied as needNodes bytes instead of i32s", PJ, [("            const pn = this._in(a, nodes, needNodes * 4);", "            const pn = this._in(a, nodes, needNodes);")], "killed", LIQ),
    ("px.js: prt always 0", PJ, [("            const pw = this._resident(weights), prt = rt ? this._resident(rt) : 0;\n            const n = vw * vh * 4, po = a.take(n);\n            const count = this.exports.liquify_block", "            const pw = this._resident(weights), prt = 0;\n            const n = vw * vh * 4, po = a.take(n);\n            const count = this.exports.liquify_block")], "killed", LIQ),
    ("px.js: strided out written packed at off", PJ, [("            if (stride === row) out.set(src, off);\n            else for (let j = 0; j < vh; j++) out.set(src.subarray(j * row, j * row + row), off + j * stride);\n            if (TIMED) lapOut(t, n);\n            return count;\n        } finally { this._reset(a); }\n    }\n\n    /** One smudge dab", "            out.set(src, off);\n            if (TIMED) lapOut(t, n);\n            return count;\n        } finally { this._reset(a); }\n    }\n\n    /** One smudge dab")], "killed", LIQ),
    # ---- kernels.js and the call sites
    ("kernels.js: liquifyBlock always runs the twin", KJ, [("    const p = rustPx(\"liquifyBlock\");", "    const p = null;")], "killed: retouchRoute and editor_test assert liquify_block ran", CALL),
    ("kernels.js: liquifyBlock ignores route", KJ, [("    const p = rustPx(\"liquifyBlock\");", "    const p = rustPx();")], "killed: route js still runs liquify_block", CALL),
    ("kernels.js: liquifyBlock uses bilinear table", KJ, [("    const p = rustPx(\"liquifyBlock\");\n    if (p) {\n        const w = resampleTable(1);", "    const p = rustPx(\"liquifyBlock\");\n    if (p) {\n        const w = resampleTable(0);")], "killed", CALL),
    ("kernels.js: liquifyBlock does not fall back on null", KJ, [("            const count = p.liquifyBlock(block, bw, bh, bx, by, nodes, nw, nx0, ny0, s, rt, out, off, stride, X0, Y0, vw, vh, w.table);\n            if (count !== null) return count;", "            return p.liquifyBlock(block, bw, bh, bx, by, nodes, nw, nx0, ny0, s, rt, out, off, stride, X0, Y0, vw, vh, w.table);")], "killed", CALL),
    ("inpaint_worker.js: liquifyJob omits liquifyBlock kernel", IW, [("    }, msg.blockMax || undefined, liquifyBlock);", "    }, msg.blockMax || undefined);")], "killed: pool bake does not call liquify_block", STEP_TILES),
    ("inpaint_tiles.js: liquified omits liquifyBlock kernel", IT, [("        }, blockMax, liquifyBlock);", "        }, blockMax);")], "killed: window tile bake does not call liquify_block", STEP_TILES),
    ("inpaint_pixels.js: _liquifyRun omits liquifyBlock kernel", IP, [("            }, blockMax, liquifyBlock);", "            }, blockMax);")], "killed: canvas bake does not call liquify_block", STEP_CANVAS),
]
