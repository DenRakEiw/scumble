TITLE = "K30"
WORKING = [
    "renderer/editor/inpaint_liquify.js",
    "renderer/editor/px/kernels.js",
    "renderer/editor/inpaint_canvas.js",
    "tools/liquify_perf.js",
    "tools/liquify_test.js",
    "tools/px_test.js",
    "tools/editor_test.py",
]
GATES = ["editor"]
TILES = "on"

PX_LIQ = {"px": ["liquify"]}
PX_ROUTE = {"px": ["retouchRoute"]}
ED_BAKE = {"editor": ["liquify_bakes_each_stroke_from_the_session_source"]}
ED_FREEZE = {"editor": ["liquify_freeze_holds_what_it_covers"]}

MUTANTS = [
    (
        "thaw_plane_cy0_shift",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "const a = new Uint8Array(ow * oh);\n    const cx0 = Math.max(0, i0 >> sh), cx1 = (i0 + ow - 1) >> sh, cy0 = Math.max(0, j0 >> sh), cy1 = (j0 + oh - 1) >> sh;",
                "const a = new Uint8Array(ow * oh);\n    const cx0 = Math.max(0, i0 >> sh), cx1 = (i0 + ow - 1) >> sh, cy0 = Math.max(0, (j0 >> sh) + 1), cy1 = (j0 + oh - 1) >> sh;",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "thaw_plane_src_offset",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "const so = (j - cy * n) * n + (a0 - cx * n);\n                a.set(c.subarray(so, so + (a1 - a0)), (j - j0) * ow + (a0 - i0));",
                "const so = (j - cy * n) * n;\n                a.set(c.subarray(so, so + (a1 - a0)), (j - j0) * ow + (a0 - i0));",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "thaw_plane_dst_offset",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "a.set(c.subarray(so, so + (a1 - a0)), (j - j0) * ow + (a0 - i0));",
                "a.set(c.subarray(so, so + (a1 - a0)), (j - j0) * ow);",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "dab_nodes_mode_grow",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "export function liquifyDabNodes(mode, src, sw, si0, sj0, s, ni, nj, cx, cy, r, h, amount, dxStep, dyStep, sel, freeze, i0, j0, ow, oh, out, box) {\n    const restore = mode === \"restore\", push = mode === \"push\";\n    const grow = mode === \"grow\" ? -1 : mode === \"shrink\" ? 1 : 0;",
                "export function liquifyDabNodes(mode, src, sw, si0, sj0, s, ni, nj, cx, cy, r, h, amount, dxStep, dyStep, sel, freeze, i0, j0, ow, oh, out, box) {\n    const restore = mode === \"restore\", push = mode === \"push\";\n    const grow = mode === \"grow\" ? 1 : mode === \"shrink\" ? -1 : 0;",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "dab_nodes_mode_turn",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "const grow = mode === \"grow\" ? -1 : mode === \"shrink\" ? 1 : 0;\n    const turn = mode === \"swirlcw\" ? -1 : mode === \"swirlccw\" ? 1 : 0;\n    if (!restore && !push && !grow && !turn) throw new Error(`Inpaint Canvas: no liquify mode \"${mode}\"`);\n    if (!(ow > 0)",
                "const grow = mode === \"grow\" ? -1 : mode === \"shrink\" ? 1 : 0;\n    const turn = mode === \"swirlcw\" ? 1 : mode === \"swirlccw\" ? -1 : 0;\n    if (!restore && !push && !grow && !turn) throw new Error(`Inpaint Canvas: no liquify mode \"${mode}\"`);\n    if (!(ow > 0)",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "dab_nodes_guard_short_out",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "if (!src || !out || !box || box.length < 4 || out.length < ow * oh * 2) return 0;",
                "if (!src || !out || !box) return 0;",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "dab_nodes_guard_short_src",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "if (i0 < si0 || j0 < sj0 || i1 - si0 >= sw || src.length < ((j1 - sj0) * sw + (i1 - si0) + 1) * 2) return 0;",
                "if (i0 < si0 || j0 < sj0) return 0;",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "dab_nodes_guard_short_thaw",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "if ((sel && sel.length < ow * oh) || (freeze && freeze.length < ow * oh)) return 0;",
                "if (false && ((sel && sel.length < ow * oh) || (freeze && freeze.length < ow * oh))) return 0;",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "dab_nodes_outside_radius_copy",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "if (!(t < 1)) { out[o] = ox; out[o + 1] = oy; continue; }",
                "if (!(t < 1)) { continue; }",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "dab_nodes_thaw_both",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "if (sel && freeze) w *= (sel[q] / 255) * (1 - freeze[q] / 255);",
                "if (sel && freeze) w *= sel[q] / 255;",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "dab_nodes_thaw_sel",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "else if (sel) w *= sel[q] / 255;",
                "else if (sel) w *= 1 - sel[q] / 255;",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "dab_nodes_thaw_freeze",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "else if (freeze) w *= 1 - freeze[q] / 255;",
                "else if (freeze) w *= freeze[q] / 255;",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "dab_nodes_restore_trunc",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "if (!(w > 0)) { out[o] = ox; out[o + 1] = oy; continue; }\n            let vx, vy;\n            if (restore) {\n                const f = 1 - w * LIQUIFY_RATES.restore;\n                vx = Math.trunc(ox * f); vy = Math.trunc(oy * f);",
                "if (!(w > 0)) { out[o] = ox; out[o + 1] = oy; continue; }\n            let vx, vy;\n            if (restore) {\n                const f = 1 - w * LIQUIFY_RATES.restore;\n                vx = Math.round(ox * f); vy = Math.round(oy * f);",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "dab_nodes_push_sign",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "if (push) { nx = -w * dxStep; ny = -w * dyStep; }",
                "if (push) { nx = w * dxStep; ny = -w * dyStep; }",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "dab_nodes_swirl_ny",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "const a = turn * w * LIQUIFY_RATES.swirl * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);\n                    nx = dx * c - dy * sn - dx; ny = dx * sn + dy * c - dy;\n                }\n                let x = i * s + nx, y = j * s + ny;\n                x = x < 0 ? 0 : x > xmax ? xmax : x;\n                y = y < 0 ? 0 : y > ymax ? ymax : y;\n                const gx = x / s",
                "const a = turn * w * LIQUIFY_RATES.swirl * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);\n                    nx = dx * c - dy * sn - dx; ny = dx * sn - dy * c - dy;\n                }\n                let x = i * s + nx, y = j * s + ny;\n                x = x < 0 ? 0 : x > xmax ? xmax : x;\n                y = y < 0 ? 0 : y > ymax ? ymax : y;\n                const gx = x / s",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "dab_nodes_clamp_xmax",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "let x = i * s + nx, y = j * s + ny;\n                x = x < 0 ? 0 : x > xmax ? xmax : x;\n                y = y < 0 ? 0 : y > ymax ? ymax : y;\n                const gx = x / s",
                "let x = i * s + nx, y = j * s + ny;\n                x = x < 0 ? 0 : x;\n                y = y < 0 ? 0 : y > ymax ? ymax : y;\n                const gx = x / s",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "dab_nodes_bilinear_d0",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "const d0 = ex * ey * src[o00] + fx * ey * src[o10] + ex * fy * src[o01] + fx * fy * src[o11];",
                "const d0 = ex * ey * src[o00] + fx * ey * src[o10] + ex * fy * src[o01];",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "dab_nodes_round_half",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "vx = clampD(Math.floor(nx * 256 + d0 + 0.5));",
                "vx = clampD(Math.floor(nx * 256 + d0));",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "dab_nodes_unchanged_skip",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "out[o] = vx; out[o + 1] = vy;\n            if (vx === ox && vy === oy) continue;",
                "out[o] = vx; out[o + 1] = vy;\n            if (false && vx === ox && vy === oy) continue;",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "write_dense_unchanged_check",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "if (!changed) continue;\n                const lc = this._writable(key, before);",
                "if (false && !changed) continue;\n                const lc = this._writable(key, before);",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "write_dense_prune_delete",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "if (prune) {\n                    let zero = true;\n                    for (let q = 0; q < lc.length; q++) if (lc[q]) { zero = false; break; }\n                    if (zero) this.cells.delete(key);\n                }",
                "if (prune) {\n                    let zero = true;\n                    for (let q = 0; q < lc.length; q++) if (lc[q]) { zero = false; break; }\n                    if (false && zero) this.cells.delete(key);\n                }",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "dab_kernel_box_return",
        "renderer/editor/inpaint_liquify.js",
        [
            (
                "this._writeDense(out, i0, j0, ow, box[0], box[1], box[2], box[3], before, restore);\n            return this._pixelBox(box[0], box[1], box[2], box[3]);",
                "this._writeDense(out, i0, j0, ow, box[0], box[1], box[2], box[3], before, restore);\n            return this._pixelBox(i0, j0, i1, j1);",
            )
        ],
        "killed",
        PX_LIQ,
    ),
    (
        "kernels_liquify_dab_route",
        "renderer/editor/px/kernels.js",
        [
            (
                "export function liquifyDab(mode, src, sw, si0, sj0, s, ni, nj, cx, cy, r, h, amount, dxStep, dyStep, sel, freeze, i0, j0, ow, oh, out, box) {\n    return liquifyDabNodes(mode, src, sw, si0, sj0, s, ni, nj, cx, cy, r, h, amount, dxStep, dyStep, sel, freeze, i0, j0, ow, oh, out, box);\n}",
                "export function liquifyDab(mode, src, sw, si0, sj0, s, ni, nj, cx, cy, r, h, amount, dxStep, dyStep, sel, freeze, i0, j0, ow, oh, out, box) {\n    void mode; void src; void sw; void si0; void sj0; void s; void ni; void nj; void cx; void cy; void r; void h; void amount; void dxStep; void dyStep; void sel; void freeze; void i0; void j0; void ow; void oh; void out; void box;\n    return 0;\n}",
            )
        ],
        "killed",
        PX_ROUTE,
    ),
    (
        "canvas_sel_thaw_planes",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                "fn.planes = (i0, j0, ow, oh) => ({ sel: thawPlane(cellOf, n, sh, i0, j0, ow, oh), freeze: null });",
                "fn.planes = () => ({ sel: null, freeze: null });",
            )
        ],
        "killed",
        ED_FREEZE,
    ),
    (
        "canvas_both_thaw_planes",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                "both.planes = (i0, j0, ow, oh) => ({ sel: sel.planes(i0, j0, ow, oh).sel, freeze: thawPlane(fCell, n, sh, i0, j0, ow, oh) });",
                "both.planes = (i0, j0, ow, oh) => ({ sel: sel.planes(i0, j0, ow, oh).sel, freeze: null });",
            )
        ],
        "killed",
        ED_FREEZE,
    ),
    (
        "canvas_liquify_dab_kernel_static",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                "static liquifyDabKernel = liquifyDab;",
                "static liquifyDabKernel = null;",
            )
        ],
        "killed",
        ED_BAKE,
    ),
]
