"""K36 mutation round config for tools/mutation_round.py (docs/PLAN_WASM_BUILD.md §4.5 K36)."""

TITLE = "K36 (composite_masked_tile, compositeStroke on it)"

WORKING = [
    "crates/px/src/composite.rs",
    "crates/px/src/lib.rs",
    "renderer/editor/px/px.wasm",
    "renderer/editor/px/px_scalar.wasm",
    "renderer/editor/px/px.js",
    "renderer/editor/px/kernels_js.js",
    "renderer/editor/px/kernels.js",
    "renderer/editor/inpaint_tiles.js",
    "tools/px_test.js",
    "tools/editor_test.py",
]

GATES = []
TILES = "on"

CR = "crates/px/src/composite.rs"
PJ = "renderer/editor/px/px.js"
KJS = "renderer/editor/px/kernels_js.js"
KJ = "renderer/editor/px/kernels.js"
IT = "renderer/editor/inpaint_tiles.js"

PX_KILL = {"px": ["compositeSha"]}

MUTANTS = [
    # ---- crates/px/src/composite.rs: masked_tile and simd helpers
    (
        "composite.rs: masked_tile returns EMPTY instead of UNCHANGED for erase/atop/in without dst",
        CR,
        [(
            "    if !has_dst && matches!(op, DESTINATION_OUT | SOURCE_ATOP | DESTINATION_IN) {\n        return UNCHANGED;\n    }",
            "    if !has_dst && matches!(op, DESTINATION_OUT | SOURCE_ATOP | DESTINATION_IN) {\n        return EMPTY;\n    }",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "composite.rs: masked_tile drops any_alpha check on inactive chunk",
        CR,
        [(
            "        let Some((x0, x1)) = simd::active_span(s_chunk, m_chunk, c_px) else {\n            if has_dst {\n                if !non_empty && simd::any_alpha(d_chunk) {\n                    non_empty = true;\n                }\n            } else {\n                d_chunk.fill(0);\n            }\n            continue;\n        };",
            "        let Some((x0, x1)) = simd::active_span(s_chunk, m_chunk, c_px) else {\n            if !has_dst {\n                d_chunk.fill(0);\n            }\n            continue;\n        };",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "composite.rs: masked_tile drops chunk prefix any_alpha(&d_chunk[..x0 * 4]) check",
        CR,
        [(
            "            if !non_empty && (simd::any_alpha(&d_chunk[..x0 * 4]) || simd::any_alpha(&d_chunk[x1 * 4..])) {\n                non_empty = true;\n            }",
            "            if !non_empty && simd::any_alpha(&d_chunk[x1 * 4..]) {\n                non_empty = true;\n            }",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "composite.rs: masked_tile drops chunk suffix any_alpha(&d_chunk[x1 * 4..]) check",
        CR,
        [(
            "            if !non_empty && (simd::any_alpha(&d_chunk[..x0 * 4]) || simd::any_alpha(&d_chunk[x1 * 4..])) {\n                non_empty = true;\n            }",
            "            if !non_empty && simd::any_alpha(&d_chunk[..x0 * 4]) {\n                non_empty = true;\n            }",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "composite.rs: masked_tile skips begin(d_span) premultiply",
        CR,
        [(
            "        if has_dst {\n            orig_span.copy_from_slice(d_span);\n            begin(d_span);\n        }",
            "        if has_dst {\n            orig_span.copy_from_slice(d_span);\n        }",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "composite.rs: masked_tile skips end(d_span) unpremultiply",
        CR,
        [(
            "        apply(d_span, &layer);\n        end(d_span);",
            "        apply(d_span, &layer);",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "composite.rs: masked_tile scalar tail restores orig only when both s.a == 0 and m == 0",
        CR,
        [(
            "            if s_span[o + 3] == 0 || m == 0 {\n                d_span[o..o + 4].copy_from_slice(&orig_span[o..o + 4]);",
            "            if s_span[o + 3] == 0 && m == 0 {\n                d_span[o..o + 4].copy_from_slice(&orig_span[o..o + 4]);",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "composite.rs: masked_tile swaps WRITTEN and EMPTY outcomes",
        CR,
        [(
            "    if !changed {\n        UNCHANGED\n    } else if non_empty {\n        WRITTEN\n    } else {\n        EMPTY\n    }",
            "    if !changed {\n        UNCHANGED\n    } else if non_empty {\n        EMPTY\n    } else {\n        WRITTEN\n    }",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "composite.rs: simd::active_span drops scalar tail when first_g < n4 and tail_active",
        CR,
        [(
            "            if tail_active {\n                return Some((first_g * 4, px));\n            }",
            "            if tail_active {\n                return Some((first_g * 4, n4 * 4));\n            }",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "composite.rs: simd::finish_masked skips restoring orig on inactive pixels",
        CR,
        [(
            "                let d_final = v128_bitselect(d_after, d_orig, active);",
            "                let d_final = d_after;",
        )],
        "killed",
        PX_KILL,
    ),
    # ---- renderer/editor/px/px.js: compositeMaskedTile
    (
        "px.js: compositeMaskedTile ignores mask pointer",
        PJ,
        [(
            "            const r = this.exports.composite_masked_tile(pd, dst ? 1 : 0, ps, px, op | 0, alpha | 0, pm);",
            "            const r = this.exports.composite_masked_tile(pd, dst ? 1 : 0, ps, px, op | 0, alpha | 0, 0);",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "px.js: compositeMaskedTile calls write(false) instead of write(true)",
        PJ,
        [(
            "            if (r === 1) {\n                const into = write(true);",
            "            if (r === 1) {\n                const into = write(false);",
        )],
        "killed",
        PX_KILL,
    ),
    # ---- renderer/editor/px/kernels_js.js: compositeMaskedTile
    (
        "kernels_js.js: compositeMaskedTile ignores mask when restoring inactive pixels",
        KJS,
        [(
            "        if (s8[io + 3] === 0 || (m8 !== null && m8[i] === 0)) {",
            "        if (s8[io + 3] === 0) {",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "kernels_js.js: compositeMaskedTile calls write(false) instead of write(true)",
        KJS,
        [(
            "    if (!nonEmpty) return 2;\n    const out = bytesOf(write(true));",
            "    if (!nonEmpty) return 2;\n    const out = bytesOf(write(false));",
        )],
        "killed",
        PX_KILL,
    ),
    # ---- renderer/editor/px/kernels.js: compositeMaskedTile route
    (
        "kernels.js: compositeMaskedTile bypasses Rust route",
        KJ,
        [(
            "export function compositeMaskedTile(dst, write, src, op, alpha, mask = null, px = 65536) {\n    const p = rustPx(\"compositeMaskedTile\");",
            "export function compositeMaskedTile(dst, write, src, op, alpha, mask = null, px = 65536) {\n    const p = null;",
        )],
        "killed",
        PX_KILL,
    ),
    # ---- renderer/editor/inpaint_tiles.js: compositeStroke
    (
        "inpaint_tiles.js: compositeStroke does not drop tile when r === 2 (EMPTY)",
        IT,
        [(
            "            if (!r) continue;\n            if (r === 2) this._dropTile(key);\n            written++;",
            "            if (!r) continue;\n            written++;",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "inpaint_tiles.js: compositeStroke increments written when r === 0 (UNCHANGED)",
        IT,
        [(
            "            if (!r) continue;\n            if (r === 2) this._dropTile(key);\n            written++;",
            "            if (r === 2) this._dropTile(key);\n            written++;",
        )],
        "killed",
        PX_KILL,
    ),
    (
        "inpaint_tiles.js: compositeStroke write returns old.data on existing tile",
        IT,
        [(
            "            const r = compositeMaskedTile(old ? old.data : null, (whole) => this.writable(tx, ty, true, whole && TILE_SIZE === 256).data,\n                s.data, op, alpha, cov, TILE_SIZE * TILE_SIZE);",
            "            const r = compositeMaskedTile(old ? old.data : null, (whole) => (old ? old.data : this.writable(tx, ty, true, whole && TILE_SIZE === 256).data),\n                s.data, op, alpha, cov, TILE_SIZE * TILE_SIZE);",
        )],
        "killed",
        PX_KILL,
    ),
]
