"""K26's mutation round (docs/measurements/k26_2026-11-07/mutation/mut_k26.py) in tools/mutation_round.py's format, with
focused kill sets: the kernel's mutants on px_test's `mask` and `dab` groups (box_blurs, height_normals' blur through
box_pass in `relight` for the shared Div code; blur_rgba / sharpen_rgba in `dab`), px.js's on `dab`, the call site's on
the editor gate's blur and sharpen step and its frequency separation step. A survivor of its focused set re-runs the
full px_test and the whole editor gate.

    python tools/mutation_round.py make TREE docs/measurements/testspeed_2026-11-07/mutants_k26.py
    python tools/mutation_round.py run TREE OUT docs/measurements/testspeed_2026-11-07/mutants_k26.py [names...] --port 9586

`expected` is the full round's verdict on today's code (k26_2026-11-07/mutation/results.txt with its rerun of the two
faint-alpha mutants after px_test's "faint" cases came in).
"""
TITLE = "K26 (focused kill sets)"
WORKING = []
GATES = ["editor"]
TILES = "on"

ST = "crates/px/src/stroke.rs"
MF = "crates/px/src/maskf.rs"
PJ = "renderer/editor/px/px.js"
KJ = "renderer/editor/px/kernels.js"
IC = "renderer/editor/inpaint_canvas.js"

DAB = {"px": ["mask", "dab"]}                       # stroke.rs: blur_rgba / sharpen_rgba, and box_blurs beside them
BOX = {"px": ["mask", "dab", "relight"]}            # maskf.rs: box_pass's users (box_blurs, the dab filters, height_normals)
WRAP = {"px": ["dab"]}                              # px.js's blurRGBA / sharpenRGBA wrapper
SITE = {"editor": ["blur_and_sharpen_modes_soften_and_crisp_an_edge", "frequency_separation_gives_the_picture_back_on_every_path"]}

MUTANTS = [
    # ---- stroke.rs: the premultiply, the passes, the unpremultiply, sharpen
    ("premultiply by 1/256", ST, [("        let al = src[i + 3] as f64 / 255.0;", "        let al = src[i + 3] as f64 / 256.0;")], "killed", DAB),
    ("premultiply: green from red", ST, [("        a[i + 1] = (src[i + 1] as f64 * al) as f32;", "        a[i + 1] = (src[i] as f64 * al) as f32;")], "killed", DAB),
    ("premultiply: the alpha premultiplied too", ST, [("        a[i + 3] = src[i + 3] as f32;", "        a[i + 3] = (src[i + 3] as f64 * al) as f32;")], "killed", DAB),
    ("two passes, not three", ST, [("        for _ in 0..3 {", "        for _ in 0..2 {")], "killed", DAB),
    ("the passes' factor as a divisor", ST, [("        let k = Norm::Mul(1.0 / (2 * r + 1) as f64);", "        let k = Norm::Div((2 * r + 1) as f64);")],
     "equivalent on this kernel's inputs: the last f64 bit never reaches a byte (survived the full round)", DAB),
    ("unpremultiply: transparent below 1, not 0.5", ST, [("        if al < 0.5 {", "        if al < 1.0 {")], "killed (by the faint cases)", DAB),
    ("unpremultiply: a transparent pixel's bytes not written", ST, [("            out[i] = 0;\n            out[i + 1] = 0;\n            out[i + 2] = 0;\n            out[i + 3] = 0;\n            continue;", "            continue;")], "killed (the arena is reused, never zeroed)", DAB),
    ("unpremultiply by 256 / alpha", ST, [("        let k = 255.0 / al;", "        let k = 256.0 / al;")], "killed", DAB),
    ("the alpha truncated", ST, [("        out[i + 3] = clamp8(al);", "        out[i + 3] = al as u8;")], "killed", DAB),
    ("clamp8: 254 the top", ST, [("    } else if v >= 255.0 {\n        255", "    } else if v >= 254.0 {\n        254")], "killed", DAB),
    ("sharpen: a transparent blur not kept", ST, [("        if sa == 0 || ba == 0 {", "        if sa == 0 {")], "killed (by the faint cases)", DAB),
    ("sharpen: the difference reversed", ST, [("                out[i + c] = clamp8(s + amount * (s - out[i + c] as f64));", "                out[i + c] = clamp8(s + amount * (out[i + c] as f64 - s));")], "killed", DAB),
    ("sharpen: the blur's alpha kept", ST, [("        out[i + 3] = sa;\n    }", "        out[i + 3] = ba;\n    }")], "killed", DAB),
    # ---- maskf.rs: the four-channel lanes and Mul (reachable since K26), the shared Div
    ("rows4: channels 2-3 from 0-1", MF, [("                hi = f64x2_add(hi, high(q));", "                hi = f64x2_add(hi, f64x2_promote_low_f32x4(q));")], "killed", BOX),
    ("rows4: enter and leave swapped", MF, [("                lo = f64x2_add(lo, f64x2_sub(f64x2_promote_low_f32x4(qa), f64x2_promote_low_f32x4(qs)));", "                lo = f64x2_add(lo, f64x2_sub(f64x2_promote_low_f32x4(qs), f64x2_promote_low_f32x4(qa)));")], "killed", BOX),
    ("rows4: the sum moved as (sum + enter) - leave", MF, [("                hi = f64x2_add(hi, f64x2_sub(high(qa), high(qs)));", "                hi = f64x2_sub(f64x2_add(hi, high(qa)), high(qs));")],
     "equivalent on this kernel's inputs: premultiplied byte values keep the window sums exact in f64 (survived the full round)", BOX),
    ("rows4: four channels left to the scalar loop", MF, [("                (4, Norm::Mul(k)) => rows4::<false>(s, d, w, h, r, f64x2_splat(k)),", "                (4, Norm::Mul(_)) => 0,")],
     "equivalent: the scalar loop gives the same values (survived the full round)", BOX),
    ("apply: multiply as divide", MF, [("        if DIV { f64x2_div(s, v) } else { f64x2_mul(s, v) }", "        if DIV { f64x2_div(s, v) } else { f64x2_div(s, v) }")], "killed", BOX),
    ("Norm::of: multiply as divide", MF, [("            Norm::Mul(k) => s * k,", "            Norm::Mul(k) => s / k,")], "killed", BOX),
    ("Norm::of: divide by a reciprocal", MF, [("            Norm::Div(n) => s / n,", "            Norm::Div(n) => s * (1.0 / n),")],
     "equivalent where the last bit never reaches an f32 (survived K26's full round)", BOX),
    # ---- px.js: the wrapper
    ("px.js: the radius floored", PJ, [("        r = Math.max(0, Math.round(r));\n        const ri = r > 0 ? r : 0;", "        r = Math.max(0, Math.floor(r));\n        const ri = r > 0 ? r : 0;")], "killed", WRAP),
    ("px.js: a short source not refused", PJ, [("ri > 0x3fffffff || !(src && src.length >= n)) return null;", "ri > 0x3fffffff) return null;")], "killed", WRAP),
    ("px.js: sharpen's amount dropped", PJ, [("this.exports.sharpen_rgba(ps, po, pt, w, h, ri, amount)", "this.exports.sharpen_rgba(ps, po, pt, w, h, ri, 1)")], "killed", WRAP),
    # ---- the call site: kernels.js and inpaint_canvas.js (the editor gate's two steps)
    ("kernels.js: blur always the twin", KJ, [("    const p = rustPx(\"dabBlur\");\n    if (p) {\n        try { const out = p.blurRGBA(src, w, h, r); if (out) return out; }", "    const p = null;\n    if (p) {\n        try { const out = p.blurRGBA(src, w, h, r); if (out) return out; }")], "killed: the editor gate asserts blur_rgba ran", SITE),
    ("kernels.js: the route ignored", KJ, [("    const p = rustPx(\"dabBlur\");\n    if (p) {\n        try { const out = p.blurRGBA(src, w, h, r); if (out) return out; }", "    const p = rustPx();\n    if (p) {\n        try { const out = p.blurRGBA(src, w, h, r); if (out) return out; }")], "killed: the editor gate's twin arm asserts no blur_rgba ran", SITE),
    ("kernels.js: sharpen's amount dropped", KJ, [("try { const out = p.sharpenRGBA(src, w, h, r, amount); if (out) return out; }", "try { const out = p.sharpenRGBA(src, w, h, r); if (out) return out; }")], "killed in the full round (the editor gate went red)", SITE),
    ("inpaint_canvas.js: the dabs on the twins again", IC, [("compositeTile, poissonBlend as poissonBlendKernel, distTransform, blurRGBA, sharpenRGBA } from \"./px/kernels.js\";", "compositeTile, poissonBlend as poissonBlendKernel, distTransform } from \"./px/kernels.js\";\nimport { blurRGBA, sharpenRGBA } from \"./inpaint_stroke.js\";")], "killed: the editor gate asserts blur_rgba / sharpen_rgba ran", SITE),
]
