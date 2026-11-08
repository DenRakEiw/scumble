"""K31's mutation round (docs/PLAN_WASM_BUILD.md §1.3, §1.4, §4.9: full tier, mutation round on the kernel and call sites),
run by tools/mutation_round.py on a copy of the tree:

    python tools/mutation_round.py make TREE docs/measurements/k31_2026-11-08/mutation/mut_k31.py
    python tools/mutation_round.py run TREE OUT docs/measurements/k31_2026-11-08/mutation/mut_k31.py --port 9617

Kill sets: px_test's groups `liquify` (liquify_dab on both builds against inpaint_liquify.js `liquifyDabNodes` across all
6 modes, s=1..8, odd/even widths, selection/freeze byte planes, saturation at +-LIQUIFY_MAX, border clamping, changed=0
windows, 120-dab three-way field parity against Map-based dab and liquifyDabNodes, fresh-instance arena growth past 1 MB
without detaching the field.nodes view, and refusal contracts) and `retouchRoute` (kernels.js' liquifyDab route switching,
call counting, refusal fallback, and trap recovery); the editor gate's `liquify_bakes_each_stroke_from_the_session_source`
and `liquify_freeze_holds_what_it_covers` on tiles (asserting three-way parity between Rust liquify_dab, dense JS twin
liquifyDabNodes, and Map-based dab).
"""
TITLE = "K31"
WORKING = [
    "crates/px/src/resample.rs",
    "crates/px/src/lib.rs",
    "renderer/editor/px/px.js",
    "renderer/editor/px/kernels.js",
    "renderer/editor/px/px.wasm",
    "renderer/editor/px/px_scalar.wasm",
    "renderer/editor/inpaint_liquify.js",
    "tools/px_test.js",
    "tools/editor_test.py",
    "tools/liquify_perf.js",
    "docs/measurements/k31_2026-11-08/mutation/mut_k31.py",
]
GATES = ["editor"]
TILES = "on"

RS = "crates/px/src/resample.rs"
LB = "crates/px/src/lib.rs"
PJ = "renderer/editor/px/px.js"
KJ = "renderer/editor/px/kernels.js"
IL = "renderer/editor/inpaint_liquify.js"

LIQ = {"px": ["liquify"]}
ROUTE = {"px": ["retouchRoute"]}
LIQ_ROUTE = {"px": ["liquify", "retouchRoute"]}
STEP = "liquify_bakes_each_stroke_from_the_session_source"
FREEZE_STEP = "liquify_freeze_holds_what_it_covers"
CALL = {"px": ["retouchRoute"], "editor": [STEP, FREEZE_STEP]}

MUTANTS = [
    # ---- resample::liquify_dab & clamp_d
    ("clamp_d: upper bound LIQUIFY_MAX omitted", RS, [("    if v > LIQUIFY_MAX as i64 {\n        LIQUIFY_MAX", "    if false {\n        LIQUIFY_MAX")], "killed", LIQ),
    ("clamp_d: lower bound -LIQUIFY_MAX omitted", RS, [("    } else if v < -(LIQUIFY_MAX as i64) {\n        -LIQUIFY_MAX", "    } else if false {\n        -LIQUIFY_MAX")], "killed", LIQ),
    ("liquify_dab: step 8 refused", RS, [("    if mode > 5\n        || !matches!(s, 1 | 2 | 4 | 8)", "    if mode > 5\n        || !matches!(s, 1 | 2 | 4)")], "killed", LIQ),
    ("liquify_dab: xmax missing * s_f", RS, [("    let xmax = (ni as f64) * s_f;", "    let xmax = ni as f64;")], "killed", LIQ),
    ("liquify_dab: grow sign flipped", RS, [("    let grow = if mode == 1 {\n        -1.0\n    } else if mode == 2 {\n        1.0", "    let grow = if mode == 1 {\n        1.0\n    } else if mode == 2 {\n        -1.0")], "killed", LIQ),
    ("liquify_dab: swirl turn sign flipped", RS, [("    let turn = if mode == 3 {\n        -1.0\n    } else if mode == 4 {\n        1.0", "    let turn = if mode == 3 {\n        1.0\n    } else if mode == 4 {\n        -1.0")], "killed", LIQ),
    ("liquify_dab: falloff flat core t <= h skipped", RS, [("            let falloff = if t <= h {\n                1.0", "            let falloff = if false {\n                1.0")], "killed", LIQ),
    ("liquify_dab: falloff v * v replaced by v", RS, [("                let v = 1.0 - u * u;\n                v * v", "                let v = 1.0 - u * u;\n                v")], "killed", LIQ),
    ("liquify_dab: combined sel + freeze ignores freeze", RS, [("                        (Some(s_plane), Some(f_plane)) => {\n                            w *= (*s_plane.get_unchecked(q) as f64 / 255.0)\n                                * (1.0 - *f_plane.get_unchecked(q) as f64 / 255.0);\n                        }", "                        (Some(s_plane), Some(_f_plane)) => {\n                            w *= *s_plane.get_unchecked(q) as f64 / 255.0;\n                        }")], "killed", LIQ),
    ("liquify_dab: freeze plane weight not inverted", RS, [("                        (None, Some(f_plane)) => {\n                            w *= 1.0 - *f_plane.get_unchecked(q) as f64 / 255.0;\n                        }", "                        (None, Some(f_plane)) => {\n                            w *= *f_plane.get_unchecked(q) as f64 / 255.0;\n                        }")], "killed", LIQ),
    ("liquify_dab: restore SIMD uses floor instead of trunc", RS, [("                    let p = f64x2_trunc(f64x2_mul(f64x2(ox as f64, oy as f64), f64x2_splat(f)));", "                    let p = f64x2_floor(f64x2_mul(f64x2(ox as f64, oy as f64), f64x2_splat(f)));")], "killed", LIQ),
    ("liquify_dab: restore scalar uses floor instead of trunc", RS, [("                    (((ox as f64) * f).trunc() as i32, ((oy as f64) * f).trunc() as i32)", "                    (((ox as f64) * f).floor() as i32, ((oy as f64) * f).floor() as i32)")], "killed", LIQ),
    ("liquify_dab: push step sign flipped on dx_step", RS, [("                    (-w * dx_step, -w * dy_step)", "                    (w * dx_step, -w * dy_step)")], "killed", LIQ),
    ("liquify_dab: swirl nx omits - dx", RS, [("                    (dx * c - dy * sn - dx, dx * sn + dy * c - dy)", "                    (dx * c - dy * sn, dx * sn + dy * c - dy)")], "killed", LIQ),
    ("liquify_dab: advected sample bounds check skipped", RS, [("                if si < si0\n                    || sj < sj0\n                    || (si - si0) as usize + 1 >= sw\n                    || (sj - sj0) as usize + 1 >= sh\n                {\n                    return DAB_REFUSED;\n                }", "                if false {\n                    return DAB_REFUSED;\n                }")], "killed", LIQ),
    ("liquify_dab: SIMD bilinear weights w10 and w01 swapped", RS, [("                    let w10 = f64x2_splat(fx * ey);\n                    let w01 = f64x2_splat(ex * fy);", "                    let w10 = f64x2_splat(ex * fy);\n                    let w01 = f64x2_splat(fx * ey);")], "killed", LIQ),
    ("liquify_dab: SIMD + 0.5 rounding omitted", RS, [("                        f64x2_splat(0.5),", "                        f64x2_splat(0.0),")], "killed", LIQ),
    ("liquify_dab: scalar bilinear weights w10 and w01 swapped", RS, [("                    let w10 = fx * ey;\n                    let w01 = ex * fy;", "                    let w10 = ex * fy;\n                    let w01 = fx * ey;")], "killed", LIQ),
    ("liquify_dab: scalar + 0.5 rounding omitted on vx", RS, [("                        clamp_d((nx * 256.0 + d0 + 0.5).floor() as i64),", "                        clamp_d((nx * 256.0 + d0).floor() as i64),")], "killed", LIQ),
    ("liquify_dab: unchanged node skip vx == ox && vy == oy omitted", RS, [("            if vx == ox && vy == oy {\n                continue;\n            }", "            if false {\n                continue;\n            }")], "killed", LIQ),
    ("liquify_dab: box_out[2] writes bi0 instead of bi1", RS, [("        box_out[2] = bi1;", "        box_out[2] = bi0;")], "killed", LIQ),
    # ---- lib.rs
    ("lib.rs: liquify_dab swaps si0 and sj0", LB, [("        si0,\n        sj0,", "        sj0,\n        si0,")], "killed", LIQ),
    ("lib.rs: liquify_dab swaps dx_step and dy_step", LB, [("        dx_step,\n        dy_step,", "        dy_step,\n        dx_step,")], "killed", LIQ),
    # ---- px.js, kernels.js and inpaint_liquify.js
    ("px.js: liquifyDab takes sView before po/psel/pfrz/pbox arena allocations (detaches on growth)", PJ, [("                const ps = a.take(sNeed * 4), po = a.take(need * 4);\n                const psel = sel ? this._in(a, sel, planeBytes) : 0;\n                const pfrz = freeze ? this._in(a, freeze, planeBytes) : 0;\n                const pbox = a.take(16);\n                const sView = this.view(Int32Array, ps, sNeed), tIn = TIMED ? clock() : 0;", "                const ps = a.take(sNeed * 4), sView = this.view(Int32Array, ps, sNeed), po = a.take(need * 4);\n                const psel = sel ? this._in(a, sel, planeBytes) : 0;\n                const pfrz = freeze ? this._in(a, freeze, planeBytes) : 0;\n                const pbox = a.take(16);\n                const tIn = TIMED ? clock() : 0;")], "killed", LIQ),
    ("px.js: liquifyDab does not pass restore prune flag to _writeDense", PJ, [("                        field._writeDense(this.view(Int32Array, po, need), i0, j0, ow, b[0], b[1], b[2], b[3], before, restore);", "                        field._writeDense(this.view(Int32Array, po, need), i0, j0, ow, b[0], b[1], b[2], b[3], before, false);")], "killed", LIQ),
    ("px.js: liquifyDab standalone Int32Array path skips _out when count == 0", PJ, [("            this._out(Int32Array, po, need, out.length === need ? out : out.subarray(0, need));\n            if (count > 0) {\n                const b = this.view(Int32Array, pbox, 4);\n                box[0] = b[0]; box[1] = b[1]; box[2] = b[2]; box[3] = b[3];\n            }", "            if (count > 0) {\n                this._out(Int32Array, po, need, out.length === need ? out : out.subarray(0, need));\n                const b = this.view(Int32Array, pbox, 4);\n                box[0] = b[0]; box[1] = b[1]; box[2] = b[2]; box[3] = b[3];\n            }")], "killed", LIQ),
    ("kernels.js: liquifyDab ignores liquifyDab route", KJ, [("    const p = rustPx(\"liquifyDab\");", "    const p = rustPx();")], "killed", CALL),
    ("inpaint_liquify.js: LiquifyField.dab does not set _dabSh before calling kernel", IL, [("            this._dabSh = sh;\n            const count = kernel(", "            const count = kernel(")], "killed", LIQ_ROUTE),
]
