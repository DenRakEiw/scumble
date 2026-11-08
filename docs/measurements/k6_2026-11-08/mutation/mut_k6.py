"""K6 mutation round (docs/PLAN_WASM_BUILD.md §1.3, §1.4 full tier, §4.2 K6).

    python tools/mutation_round.py make C:/Users/schoeneberg/AppData/Local/Temp/mut_k6_tree docs/measurements/k6_2026-11-08/mutation/mut_k6.py
    python tools/mutation_round.py run C:/Users/schoeneberg/AppData/Local/Temp/mut_k6_tree docs/measurements/k6_2026-11-08/mutation docs/measurements/k6_2026-11-08/mutation/mut_k6.py --port 9621
"""

TITLE = "K6 (SIMD unfilter in png_unfilter_rows)"

WORKING = [
    "crates/px/src/png.rs",
    "renderer/editor/px/px.wasm",
    "tools/px_test.js",
]

GATES = []
TILES = "on"

KILL = {"px": ["pngRead"]}

MUTANTS = [
    (
        "lanes_up_sub_instead_of_add",
        "crates/px/src/png.rs",
        [(
            "v128_store(c.add(i) as *mut v128, i8x16_add(x, b));",
            "v128_store(c.add(i) as *mut v128, i8x16_sub(x, b));",
        )],
        "killed",
        KILL,
    ),
    (
        "lanes_up_tail_dropped",
        "crates/px/src/png.rs",
        [(
            "        for i in end..n {\n            cur[i] = cur[i].wrapping_add(up[i]);\n        }",
            "        for i in end..n {\n            let _ = up[i];\n        }",
        )],
        "killed",
        KILL,
    ),
    (
        "lanes_up_end_one_group_less",
        "crates/px/src/png.rs",
        [(
            "        let end = n / 16 * 16;",
            "        let end = (n / 16).saturating_sub(1) * 16;",
        )],
        "equivalent: the dropped 16-byte group goes through the scalar tail end..n, which adds the same bytes",
        KILL,
    ),
    (
        "lanes_avg_rounded_up",
        "crates/px/src/png.rs",
        [(
            "let pred = u16x8_shr(i16x8_add(a, b), 1);",
            "let pred = u16x8_shr(i16x8_add(i16x8_add(a, b), i16x8_splat(1)), 1);",
        )],
        "killed",
        KILL,
    ),
    (
        "lanes_avg_no_mask_255",
        "crates/px/src/png.rs",
        [(
            "                let pred = u16x8_shr(i16x8_add(a, b), 1);\n                a = v128_and(i16x8_add(x, pred), mask);",
            "                let pred = u16x8_shr(i16x8_add(a, b), 1);\n                a = i16x8_add(x, pred);",
        )],
        "killed",
        KILL,
    ),
    (
        "lanes_avg_a_not_carried",
        "crates/px/src/png.rs",
        [(
            "                a = v128_and(i16x8_add(x, pred), mask);\n                store_px::<B>(cp.add(i), a);",
            "                let out = v128_and(i16x8_add(x, pred), mask);\n                let _ = &mut a;\n                store_px::<B>(cp.add(i), out);",
        )],
        "killed",
        KILL,
    ),
    (
        "lanes_choose_pa_lt_pc",
        "crates/px/src/png.rs",
        [(
            "(v128_and(i16x8_le(pa, pb), i16x8_le(pa, pc)), i16x8_le(pb, pc))",
            "(v128_and(i16x8_le(pa, pb), i16x8_lt(pa, pc)), i16x8_le(pb, pc))",
        )],
        "killed",
        KILL,
    ),
    (
        "lanes_choose_pb_lt_pc",
        "crates/px/src/png.rs",
        [(
            "(v128_and(i16x8_le(pa, pb), i16x8_le(pa, pc)), i16x8_le(pb, pc))",
            "(v128_and(i16x8_le(pa, pb), i16x8_le(pa, pc)), i16x8_lt(pb, pc))",
        )],
        "killed",
        KILL,
    ),
    (
        "lanes_choose_pa_lt_pb",
        "crates/px/src/png.rs",
        [(
            "(v128_and(i16x8_le(pa, pb), i16x8_le(pa, pc)), i16x8_le(pb, pc))",
            "(v128_and(i16x8_lt(pa, pb), i16x8_le(pa, pc)), i16x8_le(pb, pc))",
        )],
        "equivalent: pa = pb with a != b puts c midway (pc = 0 < pa), and with a = b either pick is the same byte",
        KILL,
    ),
    (
        "lanes_paeth_b_before_a",
        "crates/px/src/png.rs",
        [(
            "let pred = v128_bitselect(a, v128_bitselect(b, c, mb), ma);",
            "let pred = v128_bitselect(b, v128_bitselect(a, c, ma), mb);",
        )],
        "killed",
        KILL,
    ),
    (
        "lanes_paeth_c_not_updated",
        "crates/px/src/png.rs",
        [(
            "                a = v128_and(i16x8_add(x, pred), mask);\n                c = b;",
            "                a = v128_and(i16x8_add(x, pred), mask);\n                let _ = (&mut c, b);",
        )],
        "killed",
        KILL,
    ),
    (
        "lanes_paeth_no_mask_255",
        "crates/px/src/png.rs",
        [(
            "                let pred = v128_bitselect(a, v128_bitselect(b, c, mb), ma);\n                a = v128_and(i16x8_add(x, pred), mask);",
            "                let pred = v128_bitselect(a, v128_bitselect(b, c, mb), ma);\n                a = i16x8_add(x, pred);",
        )],
        "killed",
        KILL,
    ),
    (
        "lanes_load_px_b3_drop_byte2",
        "crates/px/src/png.rs",
        [(
            "u16x8_extend_low_u8x16(v128_load8_lane::<2>(v, p.add(2)))",
            "u16x8_extend_low_u8x16(v)",
        )],
        "killed",
        KILL,
    ),
    (
        "lanes_store_px_b3_drop_byte2",
        "crates/px/src/png.rs",
        [(
            "            v128_store16_lane::<0>(b, p as *mut u16);\n            v128_store8_lane::<2>(b, p.add(2));",
            "            v128_store16_lane::<0>(b, p as *mut u16);",
        )],
        "killed",
        KILL,
    ),
    (
        "dispatch_avg3_as_paeth3",
        "crates/px/src/png.rs",
        [(
            "(3, 3) => row_avg::<3>(cur, up),",
            "(3, 3) => row_paeth::<3>(cur, up),",
        )],
        "killed",
        KILL,
    ),
    (
        "dispatch_paeth4_as_avg4",
        "crates/px/src/png.rs",
        [(
            "(4, 4) => row_paeth::<4>(cur, up),",
            "(4, 4) => row_avg::<4>(cur, up),",
        )],
        "killed",
        KILL,
    ),
    (
        "scalar_paeth_px_pb_lt_pc",
        "crates/px/src/png.rs",
        [(
            "let pred = if pa <= pb && pa <= pc { a[k] } else if pb <= pc { ib } else { c[k] };",
            "let pred = if pa <= pb && pa <= pc { a[k] } else if pb < pc { ib } else { c[k] };",
        )],
        "killed",
        KILL,
    ),
    (
        "scalar_avg_px_rounded_up",
        "crates/px/src/png.rs",
        [(
            "for k in 0..B { x[k] = x[k].wrapping_add(((a[k] as u16 + b[k] as u16) >> 1) as u8); }",
            "for k in 0..B { x[k] = x[k].wrapping_add(((a[k] as u16 + b[k] as u16 + 1) >> 1) as u8); }",
        )],
        "killed",
        KILL,
    ),
]
