"""K27's mutation round (docs/PLAN_WASM_BUILD.md §1.3, §1.4: full on the kernels and on the call sites), run by
tools/mutation_round.py on a copy of the tree (docs/TESTING.md "Faster runs without less coverage"):

    python tools/mutation_round.py make TREE docs/measurements/k27_2026-11-08/mutation/mut_k27.py
    python tools/mutation_round.py run TREE OUT docs/measurements/k27_2026-11-08/mutation/mut_k27.py --port 9605

Kill sets: px_test's groups `tone` (tone_rgba, sponge_rgba on both builds against inpaint_stroke.js), `freq`
(freq_split and freqSeparate), `dab` (blur_rgba / sharpen_rgba, for clamp8, which they share), `retouchRoute`
(kernels.js' wrappers: routes, refusals, traps); the editor gate's tone / sponge step and frequency separation (each
asserting the Rust exports ran and replaying on the route "js"). A survivor runs the full px_test and the editor gate.
"""
TITLE = "K27"
WORKING = ["tools/px_test.js", "docs/measurements/k27_2026-11-08/mutation/mut_k27.py"]
GATES = ["editor"]
TILES = "on"

ST = "crates/px/src/stroke.rs"
LB = "crates/px/src/lib.rs"
PJ = "renderer/editor/px/px.js"
KJ = "renderer/editor/px/kernels.js"
IC = "renderer/editor/inpaint_canvas.js"

TONE = {"px": ["tone"]}
FREQ = {"px": ["freq"]}
STEP_TONE = "dodge_burn_and_sponge_through_the_real_handlers"
STEP_FREQ = "frequency_separation_gives_the_picture_back_on_every_path"
CALL = {"px": ["retouchRoute"], "editor": [STEP_TONE, STEP_FREQ]}

MUTANTS = [
    # ---- tone_rgba
    ("tone: kt divided by v + 1", ST, [("            kt[v] = (lut[v] as f64 - of) / v as f64;", "            kt[v] = (lut[v] as f64 - of) / (v + 1) as f64;")], "killed", TONE),
    ("tone: kt short of 255", ST, [("        for v in 1..256 {\n            kt[v] =", "        for v in 1..255 {\n            kt[v] =")], "killed", TONE),
    ("tone: a transparent pixel's colour not kept", ST, [("        if a == 0 {\n            d[0] = r;\n            d[1] = g;\n            d[2] = b;\n            continue;\n        }\n        if !protect {", "        if a == 0 {\n            d[0] = 0;\n            d[1] = g;\n            d[2] = b;\n            continue;\n        }\n        if !protect {")], "killed", TONE),
    ("tone: the alpha through the table", ST, [("        d[3] = a;\n        if a == 0 {", "        d[3] = lut[a as usize];\n        if a == 0 {")], "killed", TONE),
    ("tone: green from red's entry", ST, [("            d[1] = lut[g as usize];", "            d[1] = lut[r as usize];")], "killed", TONE),
    ("tone: protect on the smallest channel", ST, [("        let v = r.max(g).max(b);", "        let v = r.min(g).min(b);")], "killed", TONE),
    ("tone: protect's black to 0, not the floor", ST, [("        if v == 0 {\n            d[0] = o;", "        if v == 0 {\n            d[0] = 0;")], "killed", TONE),
    ("tone: protect without the floor", ST, [("        d[0] = clamp8(of + r as f64 * k);", "        d[0] = clamp8(r as f64 * k);")], "killed", TONE),
    ("lib.rs: protect inverted", LB, [("lut, protect != 0);", "lut, protect == 0);")], "killed", TONE),
    # ---- clamp8 (shared with K26's blur and sharpen)
    ("clamp8: truncated, not rounded", ST, [("        v.round_ties_even() as i32 as u8", "        v as i32 as u8")], "killed", {"px": ["tone", "dab"]}),
    ("clamp8: ties away from zero", ST, [("        v.round_ties_even() as i32 as u8", "        v.round() as i32 as u8")], "killed", {"px": ["tone", "dab"]}),
    # ---- sponge_rgba, the scalar loop (the scalar build, and the SIMD build's last pixels)
    ("sponge scalar: the luma rounded with 127", ST, [("        let y = (77 * r + 150 * g + 29 * b + 128) >> 8;\n        let t = if saturate {", "        let y = (77 * r + 150 * g + 29 * b + 127) >> 8;\n        let t = if saturate {")], "killed", TONE),
    ("sponge scalar: down as y / (y - mn + 1)", ST, [("            let down = if mn < y { y as f64 / (y - mn) as f64 } else { f64::INFINITY };", "            let down = if mn < y { y as f64 / (y - mn + 1) as f64 } else { f64::INFINITY };")], "killed", TONE),
    ("sponge scalar: up's Infinity as 1", ST, [("            let up = if mx > y { (255 - y) as f64 / (mx - y) as f64 } else { f64::INFINITY };", "            let up = if mx > y { (255 - y) as f64 / (mx - y) as f64 } else { 1.0 };")], "killed", TONE),
    ("sponge scalar: lim without max(1, lim)", ST, [("                t = if lim > 1.0 { lim } else { 1.0 };", "                t = lim;")], "equivalent: lim is at least 1 (255 - y >= mx - y and y >= y - mn)", TONE),
    ("sponge scalar: vibrance always on", ST, [("            let mut t = 1.0 + k * (if vibrance { 1.0 - (mx - mn) as f64 / mx as f64 } else { 1.0 });", "            let mut t = 1.0 + k * (1.0 - (mx - mn) as f64 / mx as f64);")], "killed", TONE),
    ("sponge scalar: transparent pixels moved", ST, [("        if s[3] == 0 || mx == mn {\n            continue;", "        if mx == mn {\n            continue;")], "killed", TONE),
    ("sponge scalar: grey pixels moved", ST, [("        if s[3] == 0 || mx == mn {\n            continue;", "        if s[3] == 0 {\n            continue;")], "equivalent: a grey pixel's luma is its value, so y + 0 * t gives it back (0 * NaN at black stores 0, black's byte)", TONE),
    ("sponge scalar: desaturate by 1 + k", ST, [("        } else {\n            1.0 - k\n        };", "        } else {\n            1.0 + k\n        };")], "killed", TONE),
    # ---- sponge_rgba, the SIMD lanes
    ("sponge lanes: the luma rounded with 127", ST, [("i32x4_splat(29), i32x4_splat(128));", "i32x4_splat(29), i32x4_splat(127));")], "killed", TONE),
    ("sponge lanes: up without its mask", ST, [("        let up = v128_bitselect(f64x2_div(f64x2_sub(c.f255, y), f64x2_sub(mx, y)), c.inf, f64x2_gt(mx, y));", "        let up = f64x2_div(f64x2_sub(c.f255, y), f64x2_sub(mx, y));")], "killed: y = mx = 255 divides 0 by 0", TONE),
    ("sponge lanes: lim as the larger side", ST, [("        f64x2_pmin(t0, f64x2_pmax(c.one, f64x2_pmin(up, down)))", "        f64x2_pmin(t0, f64x2_pmax(c.one, f64x2_pmax(up, down)))")], "killed", TONE),
    ("sponge lanes: t without max(1, lim)", ST, [("        f64x2_pmin(t0, f64x2_pmax(c.one, f64x2_pmin(up, down)))", "        f64x2_pmin(t0, f64x2_pmin(up, down))")], "equivalent: lim is at least 1", TONE),
    ("sponge lanes: vibrance's ratio by mn", ST, [("f64x2_div(f64x2_sub(mx, mn), mx))))", "f64x2_div(f64x2_sub(mx, mn), mn))))")], "killed", TONE),
    ("sponge lanes: transparent pixels moved", ST, [("        let keep = v128_or(i32x4_eq(a, i32x4_splat(0)), i32x4_eq(mx, mn));", "        let keep = i32x4_eq(mx, mn);")], "killed", TONE),
    ("sponge lanes: all kept, nothing stored", ST, [("                unsafe { v128_store(out.as_mut_ptr().add(i) as *mut v128, px) };\n                i += 16;\n                continue;", "                i += 16;\n                continue;")], "killed (the arena is reused, never zeroed)", TONE),
    ("sponge lanes: kept pixels computed", ST, [("v128_bitselect(px, packed, keep)) };", "packed) };")], "killed", TONE),
    ("sponge lanes: the store at least 1", ST, [("f64x2_pmin(f64x2_pmax(v, c.zero), c.f255))", "f64x2_pmin(f64x2_pmax(v, c.one), c.f255))")], "killed", TONE),
    ("sponge lanes: the high half with the low half's gain", ST, [("store(y_hi, hi(v), t_hi, &c))", "store(y_hi, hi(v), t_lo, &c))")], "killed", TONE),
    ("sponge lanes: steps of 32 bytes", ST, [("        let n = src.len() / 16 * 16;\n        assert!(out.len() >= n);", "        let n = src.len() / 32 * 32;\n        assert!(out.len() >= n);")], "equivalent: the scalar loop takes the rest with the same bytes", TONE),
    ("lib.rs: sponge's switches swapped", LB, [("k, flags & 1 != 0, flags & 2 != 0);", "k, flags & 2 != 0, flags & 1 != 0);")], "killed", TONE),
    # ---- freq_split
    ("split scalar: L at 255 down to 253", ST, [("            l[c] = (lv + odd - 2 * top) as u8;", "            l[c] = (lv + odd - 3 * top) as u8;")], "killed", FREQ),
    ("split scalar: H without top", ST, [("            h[c] = ((t >> 1) + top) as u8;", "            h[c] = (t >> 1) as u8;")], "killed", FREQ),
    ("split scalar: L's alpha the blur's", ST, [("        l[3] = s[3];\n        h[3] = s[3];", "        h[3] = s[3];")], "killed", FREQ),
    ("split lanes: the rounding average", ST, [("                let half = u8x16_sub(u8x16_avgr(s, nl), odd);", "                let half = u8x16_avgr(s, nl);")], "killed", FREQ),
    ("split lanes: top without L = 255", ST, [("                let top = v128_and(odd, u8x16_eq(l, ff));", "                let top = odd;")], "killed", FREQ),
    ("split lanes: the alpha mask a byte off", ST, [("        let alpha = u32x4_splat(0xff00_0000);", "        let alpha = u32x4_splat(0x00ff_0000);")], "killed", FREQ),
    ("split lanes: L' without -2 top", ST, [("                let l2 = u8x16_sub(u8x16_add(l, odd), u8x16_add(top, top));", "                let l2 = u8x16_add(l, odd);")], "killed", FREQ),
    # ---- px.js
    ("px.js: the sponge's amount not clamped", PJ, [("        const k = Math.max(0, Math.min(1, +amount || 0));", "        const k = +amount || 0;")], "killed", TONE),
    ("px.js: the sponge's amount NaN not 0", PJ, [("        const k = Math.max(0, Math.min(1, +amount || 0));", "        const k = Math.max(0, Math.min(1, +amount));")], "killed", TONE),
    ("px.js: vibrance off by default", PJ, [("    spongeRGBA(src, amount, saturate = false, vibrance = true) {", "    spongeRGBA(src, amount, saturate = false, vibrance = false) {")], "killed", TONE),
    ("px.js: protect passed as it is", PJ, [("this.exports.tone_rgba(ps, po, n, pl, protect ? 1 : 0)", "this.exports.tone_rgba(ps, po, n, pl, protect)")], "killed: \"yes\" is truthy and converts to 0", TONE),
    ("px.js: the table's first 255 bytes", PJ, [("pl = this._in(a, lut, 256), po = a.take(n);", "pl = this._in(a, lut, 255), po = a.take(n);")], "killed", TONE),
    ("px.js: a part pixel not refused", PJ, [("const rgbaBytes = (src) => (isBytes(src) && src.length > 0 && src.length % 4 === 0 ? src.length : 0);", "const rgbaBytes = (src) => (isBytes(src) && src.length > 0 ? src.length : 0);")], "equivalent: the exports refuse a part pixel too (rgba_len), so Px answers null either way", TONE),
    ("px.js: freqSplit's L not written back", PJ, [("            this._out(Uint8Array, pl, n, new Uint8Array(low.buffer, low.byteOffset, n));\n", "")], "killed", FREQ),
    ("px.js: freqSeparate's detail from the blur's block", PJ, [("high: this._out(Uint8ClampedArray, pt, n, null) };", "high: this._out(Uint8ClampedArray, po, n, null) };")], "killed", FREQ),
    ("px.js: freqSeparate without the split", PJ, [("if (this.exports.blur_rgba(ps, po, pt, w, h, ri) !== 1 || this.exports.freq_split(ps, po, pt, n) !== 1) return null;", "if (this.exports.blur_rgba(ps, po, pt, w, h, ri) !== 1) return null;")], "killed", FREQ),
    # ---- the call sites: kernels.js and inpaint_canvas.js
    ("kernels.js: tone always the twin", KJ, [("    const p = rustPx(\"dabTone\");", "    const p = null;")], "killed: the editor gate and retouchRoute assert tone_rgba ran", CALL),
    ("kernels.js: the sponge's route ignored", KJ, [("    const p = rustPx(\"dabSponge\");", "    const p = rustPx();")], "killed: the route js still runs sponge_rgba", CALL),
    ("kernels.js: freqSeparate on the blur's route alone", KJ, [("    const p = rustPx(\"dabBlur\") && rustPx(\"freqSplit\");", "    const p = rustPx(\"dabBlur\");")], "killed: retouchRoute's freqSplit js case still runs freq_split", CALL),
    ("kernels.js: freqSplit's twin on a fresh L", KJ, [("    return freqSplitTwin(I, L);\n}", "    return freqSplitTwin(I, L.slice());\n}")], "killed: the caller's L is never split", CALL),
    ("inpaint_canvas.js: the tone dabs on the twins again", IC, [
        ("distTransform, blurRGBA, sharpenRGBA, toneRGBA, spongeRGBA, freqSeparate } from \"./px/kernels.js\";", "distTransform, blurRGBA, sharpenRGBA, freqSeparate } from \"./px/kernels.js\";"),
        ("import { pressureCurve, Stabiliser, toneLUT } from \"./inpaint_stroke.js\";", "import { pressureCurve, Stabiliser, toneLUT, toneRGBA, spongeRGBA } from \"./inpaint_stroke.js\";"),
    ], "killed: the editor gate asserts tone_rgba / sponge_rgba ran", {"editor": [STEP_TONE]}),
    ("inpaint_canvas.js: no split", IC, [("        const { low: L, high: Hi } = freqSeparate(I, w, h, r);", "        const L = blurRGBA(I, w, h, r), Hi = new Uint8ClampedArray(w * h * 4);")], "killed: the picture does not come back", {"editor": [STEP_FREQ]}),
]
