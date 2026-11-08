"""K11 mutation round config for tools/mutation_round.py (docs/PLAN_WASM_BUILD.md §4.3)."""

TITLE = "K11 (mask_invert, deferred writable copy on frozen tiles)"

WORKING = [
    "crates/px/src/sel.rs",
    "crates/px/src/lib.rs",
    "renderer/editor/px/px.wasm",
    "renderer/editor/px/px_scalar.wasm",
    "renderer/editor/px/px.js",
    "renderer/editor/px/kernels_js.js",
    "renderer/editor/px/kernels.js",
    "renderer/editor/inpaint_arena.js",
    "renderer/editor/inpaint_tiles.js",
    "tools/px_test.js",
    "tools/combine_test.js",
    "tools/editor_test.py",
    "tools/px_jobs.py",
    "tools/ab_median.py",
]

GATES = []
TILES = "on"

SR = "crates/px/src/sel.rs"
PJ = "renderer/editor/px/px.js"
KJS = "renderer/editor/px/kernels_js.js"
KJ = "renderer/editor/px/kernels.js"
IA = "renderer/editor/inpaint_arena.js"
IT = "renderer/editor/inpaint_tiles.js"

MUTANTS = [
    # ---- sel.rs: mask_invert alpha, transparent zeroing, rest_of_row extent, refusal, SIMD vs scalar
    (
        "sel.rs: mask_invert alpha 255 - a mutated to 254 - a",
        SR,
        [
            ("        let a = 255 - (row[o + 3] as u32);", "        let a = 254u32.saturating_sub(row[o + 3] as u32);"),
            ("        let ff = u32x4_splat(255);", "        let ff = u32x4_splat(254);"),
        ],
        "killed",
        {"px": ["sel"]},
    ),
    (
        "sel.rs: mask_invert transparent pixel leaves RGB instead of 0, 0, 0, 0",
        SR,
        [
            (
                "                v128_store(p, v128_and(v128_or(i32x4_shl(a, 24), c), covered));",
                "                v128_store(p, v128_or(i32x4_shl(a, 24), c));",
            ),
            (
                "        } else {\n            row[o] = 0;\n            row[o + 1] = 0;\n            row[o + 2] = 0;\n            row[o + 3] = 0;\n        }\n    }\n}\n\n/// Pixels `from` to `to` of a row one at a time",
                "        } else {\n            row[o] = r;\n            row[o + 1] = g;\n            row[o + 2] = b;\n            row[o + 3] = 0;\n        }\n    }\n}\n\n/// Pixels `from` to `to` of a row one at a time",
            ),
        ],
        "killed",
        {"px": ["sel"]},
    ),
    (
        "sel.rs: mask_invert skips rest_of_row extent scan beyond bw x bh",
        SR,
        [(
            "            scalar_invert_row(row, done, bw, (r, g, b), &mut first, &mut last);\n            bw\n        } else {\n            0\n        };\n        rest_of_row(row, from, size, &mut first, &mut last);",
            "            scalar_invert_row(row, done, bw, (r, g, b), &mut first, &mut last);\n            bw\n        } else {\n            0\n        };\n        let _ = from;",
        )],
        "killed",
        {"px": ["sel"]},
    ),
    (
        "sel.rs: mask_invert refusal check bw > size || bh > size dropped",
        SR,
        [(
            "pub fn mask_invert(tile: &mut [u8], size: usize, bw: usize, bh: usize, rgb: u32, ext: &mut [i32]) -> u32 {\n    if bw > size || bh > size || ext.len() < 4 {",
            "pub fn mask_invert(tile: &mut [u8], size: usize, bw: usize, bh: usize, rgb: u32, ext: &mut [i32]) -> u32 {\n    if ext.len() < 4 {",
        )],
        "killed",
        {"px": ["sel"]},
    ),
    (
        "sel.rs: mask_invert SIMD loop bypassed to scalar tail",
        SR,
        [(
            "    pub fn invert_row(row: &mut [u8], n: usize, colour: u32) -> (usize, usize, usize) {\n        let n4 = n / 4 * 4;",
            "    pub fn invert_row(row: &mut [u8], n: usize, colour: u32) -> (usize, usize, usize) {\n        let n4 = 0 * (n / 4 * 4);",
        )],
        "equivalent: the scalar tail computes the exact same inverted pixels and extent",
        {"px": ["sel"]},
    ),
    # ---- px.js: maskInvert write(true) and refusal checks
    (
        "px.js: maskInvert passes write(false) instead of write(true)",
        PJ,
        [(
            "            const r = this.exports.mask_invert(pd, size, bw, bh, rgb >>> 0, pe);\n            if (r === 2) throw new Error(`px: mask_invert refused a tile of ${size} (${bw} x ${bh})`);\n            if (!r) return null;\n            const e = this.view(Int32Array, pe, 4), ext = [e[0], e[1], e[2], e[3]];\n            const into = write(true);",
            "            const r = this.exports.mask_invert(pd, size, bw, bh, rgb >>> 0, pe);\n            if (r === 2) throw new Error(`px: mask_invert refused a tile of ${size} (${bw} x ${bh})`);\n            if (!r) return null;\n            const e = this.view(Int32Array, pe, 4), ext = [e[0], e[1], e[2], e[3]];\n            const into = write(false);",
        )],
        "killed",
        {"px": ["sel"]},
    ),
    (
        "px.js: maskInvert calls write(true) before checking empty tile (!r)",
        PJ,
        [(
            "            const r = this.exports.mask_invert(pd, size, bw, bh, rgb >>> 0, pe);\n            if (r === 2) throw new Error(`px: mask_invert refused a tile of ${size} (${bw} x ${bh})`);\n            if (!r) return null;\n            const e = this.view(Int32Array, pe, 4), ext = [e[0], e[1], e[2], e[3]];\n            const into = write(true);",
            "            const r = this.exports.mask_invert(pd, size, bw, bh, rgb >>> 0, pe);\n            if (r === 2) throw new Error(`px: mask_invert refused a tile of ${size} (${bw} x ${bh})`);\n            const into = write(true);\n            if (!r) return null;\n            const e = this.view(Int32Array, pe, 4), ext = [e[0], e[1], e[2], e[3]];",
        )],
        "killed",
        {"px": ["sel"]},
    ),
    (
        "px.js: maskInvert short tile check dropped",
        PJ,
        [(
            "        if (!tile || !(tile.length >= n)) throw new Error(\"px: mask_invert: a tile too small\");",
            "        if (!tile) throw new Error(\"px: mask_invert: a tile too small\");",
        )],
        "killed",
        {"px": ["sel"]},
    ),
    # ---- kernels_js.js: maskInvert word path vs byte path
    (
        "kernels_js.js: maskInvert word path bypassed to byte path",
        KJS,
        [(
            "export function maskInvert(tile, size, bw, bh, rgb) {\n    if (invertRefused(tile, size, bw, bh)) {\n        throw new Error(`px: mask_invert refused a tile of ${size} (${bw} x ${bh})`);\n    }\n    const d8 = bytesOf(tile);\n    const r = (rgb >>> 16) & 255, g = (rgb >>> 8) & 255, b = rgb & 255;\n    let x0 = size, y0 = -1, x1 = -1, y1 = -1;\n    const words = LITTLE && (d8.byteOffset & 3) === 0;",
            "export function maskInvert(tile, size, bw, bh, rgb) {\n    if (invertRefused(tile, size, bw, bh)) {\n        throw new Error(`px: mask_invert refused a tile of ${size} (${bw} x ${bh})`);\n    }\n    const d8 = bytesOf(tile);\n    const r = (rgb >>> 16) & 255, g = (rgb >>> 8) & 255, b = rgb & 255;\n    let x0 = size, y0 = -1, x1 = -1, y1 = -1;\n    const words = false && LITTLE && (d8.byteOffset & 3) === 0;",
        )],
        "equivalent: the byte path computes the exact same RGBA8 bytes and extent",
        {"px": ["sel"]},
    ),
    (
        "kernels_js.js: maskInvert transparent pixel leaves RGB instead of 0",
        KJS,
        [(
            "                    const a = 255 - (d32[o] >>> 24);\n                    if (a) {\n                        d32[o] = ((a << 24) | RGB) >>> 0;\n                        if (first < 0) first = x;\n                        last = x;\n                    } else d32[o] = 0;",
            "                    const a = 255 - (d32[o] >>> 24);\n                    if (a) {\n                        d32[o] = ((a << 24) | RGB) >>> 0;\n                        if (first < 0) first = x;\n                        last = x;\n                    } else d32[o] = RGB;",
        )],
        "killed",
        {"px": ["sel"]},
    ),
    # ---- kernels.js: maskInvert route
    (
        "kernels.js: maskInvert always runs twin",
        KJ,
        [(
            "export function maskInvert(tile, write, bw, bh, rgb, size = 256) {\n    const p = rustPx(\"maskInvert\");",
            "export function maskInvert(tile, write, bw, bh, rgb, size = 256) {\n    const p = null;",
        )],
        "killed",
        {"px": ["sel"]},
    ),
    (
        "kernels.js: maskInvert ignores route",
        KJ,
        [(
            "export function maskInvert(tile, write, bw, bh, rgb, size = 256) {\n    const p = rustPx(\"maskInvert\");",
            "export function maskInvert(tile, write, bw, bh, rgb, size = 256) {\n    const p = rustPx();",
        )],
        "killed",
        {"px": ["sel"]},
    ),
    # ---- inpaint_tiles.js: deferred writable copy and TileMaskPixels.invert
    (
        "inpaint_tiles.js: writable copies frozen tile even when whole is true",
        IT,
        [(
            "            if (!whole) c.data.set(t.data);",
            "            if (true || !whole) c.data.set(t.data);",
        )],
        "killed",
        {"px": ["sel"]},
    ),
    (
        "inpaint_tiles.js: writable skips copying frozen tile when whole is false",
        IT,
        [(
            "            if (!whole) c.data.set(t.data);",
            "            if (false && !whole) c.data.set(t.data);",
        )],
        "killed",
        {"px": ["sel"]},
    ),
    (
        "inpaint_tiles.js: invert on existing tile does not drop tile when maskInvert returns null",
        IT,
        [(
            "                    const ext = maskInvert(had.data, (whole) => (t = this.writable(tx, ty, true, whole && TILE_SIZE === 256)).data, bw, bh, rgb, TILE_SIZE);\n                    if (!ext) { this._dropTile(key); continue; }",
            "                    const ext = maskInvert(had.data, (whole) => (t = this.writable(tx, ty, true, whole && TILE_SIZE === 256)).data, bw, bh, rgb, TILE_SIZE);\n                    if (!ext) { continue; }",
        )],
        "killed",
        {"px": ["sel"]},
    ),
    (
        "inpaint_tiles.js: invert on existing tile does not cache t.ext / t.extVersion",
        IT,
        [(
            "                    const ext = maskInvert(had.data, (whole) => (t = this.writable(tx, ty, true, whole && TILE_SIZE === 256)).data, bw, bh, rgb, TILE_SIZE);\n                    if (!ext) { this._dropTile(key); continue; }\n                    t.ext = ext;\n                    t.extVersion = t.version;",
            "                    const ext = maskInvert(had.data, (whole) => (t = this.writable(tx, ty, true, whole && TILE_SIZE === 256)).data, bw, bh, rgb, TILE_SIZE);\n                    if (!ext) { this._dropTile(key); continue; }",
        )],
        "killed",
        {"px": ["sel"]},
    ),
    (
        "inpaint_tiles.js: invert in editor bypasses maskInvert to JS loop",
        IT,
        [(
            "                if (LITTLE) {\n                    let t = null;\n                    const ext = maskInvert(had.data, (whole) => (t = this.writable(tx, ty, true, whole && TILE_SIZE === 256)).data, bw, bh, rgb, TILE_SIZE);",
            "                if (false && LITTLE) {\n                    let t = null;\n                    const ext = maskInvert(had.data, (whole) => (t = this.writable(tx, ty, true, whole && TILE_SIZE === 256)).data, bw, bh, rgb, TILE_SIZE);",
        )],
        "killed",
        {"editor": ["grow_feather_and_invert_are_the_answers_a_whole_image_run_gives"]},
    ),
    (
        "inpaint_tiles.js: invert fresh-tile whole guard mutated to true",
        IT,
        [(
            "                    // nothing was selected here, so all of it is now: one fill, no reading\n                    const whole = bw === TILE_SIZE && bh === TILE_SIZE;",
            "                    // nothing was selected here, so all of it is now: one fill, no reading\n                    const whole = true;",
        )],
        "killed: combine_test §13 writable spy and arena reused-slot edge-tile check",
        {"px": ["sel"]},
    ),
    (
        "inpaint_tiles.js: combine SEL_FULL whole guard mutated to true",
        IT,
        [(
            "                    // replace or add under full coverage: the colour at 255 wherever the image is, one fill\n                    const whole = bw === TILE_SIZE && bh === TILE_SIZE;",
            "                    // replace or add under full coverage: the colour at 255 wherever the image is, one fill\n                    const whole = true;",
        )],
        "killed: combine_test §13 writable spy and frozen partial edge tile beyond-image check",
        {"px": ["sel"]},
    ),
    (
        "inpaint_arena.js: allocTileBytes skips zeroing reused slot when zero is true",
        IA,
        [(
            "    if (c.used_[slot]) { if (zero) bytes.fill(0); c.used_[slot] = 0; }",
            "    if (c.used_[slot]) { if (false && zero) bytes.fill(0); c.used_[slot] = 0; }",
        )],
        "killed: combine_test §13 arena reused-slot zero guard",
        {"px": ["sel"]},
    ),
]
