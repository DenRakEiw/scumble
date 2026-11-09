"""K24 mutation round config for tools/mutation_round.py (docs/PLAN_WASM_BUILD.md §4.8)."""

TITLE = "K24 (guided_far & depth_guide worker job)"

WORKING = [
    "crates/px/src/guided.rs",
    "crates/px/src/lib.rs",
    "renderer/editor/px/px.wasm",
    "renderer/editor/px/px_scalar.wasm",
    "renderer/editor/px/px.js",
    "renderer/editor/px/kernels_js.js",
    "renderer/editor/px/kernels.js",
    "renderer/editor/inpaint_worker.js",
    "renderer/editor/inpaint_canvas.js",
    "tools/px_test.js",
    "tools/px_jobs.py",
    "tools/ab_median.py",
    "tools/edges_test.py",
]

GATES = ["edges"]
TILES = "on"

GD = "crates/px/src/guided.rs"
LB = "crates/px/src/lib.rs"
PJ = "renderer/editor/px/px.js"
KJ = "renderer/editor/px/kernels_js.js"
KR = "renderer/editor/px/kernels.js"
WK = "renderer/editor/inpaint_worker.js"
CV = "renderer/editor/inpaint_canvas.js"

MUTANTS = [
    # ---- guided.rs: precision & algorithmic invariants (brief.md points 18 & 37)
    (
        "guided.rs: b computed from f32-rounded a[i] (plane_ip[i] as f64) instead of unrounded f64 av",
        GD,
        [(
            "        let av = cov_ip / (var_i + eps);\n        plane_ip[i] = av as f32;\n        plane_ii[i] = (mp - av * mi) as f32;",
            "        let av = cov_ip / (var_i + eps);\n        plane_ip[i] = av as f32;\n        plane_ii[i] = (mp - (plane_ip[i] as f64) * mi) as f32;",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    (
        "guided.rs: I computed with f32 1.0/255.0 instead of f64 grey[i] * (1.0 / 255.0) stored as f32",
        GD,
        [(
            "    let inv255 = 1.0_f64 / 255.0_f64;\n    for i in 0..n_work {\n        let iv_f32 = ((grey[i] as f64) * inv255) as f32;",
            "    let inv255 = 1.0_f32 / 255.0_f32;\n    for i in 0..n_work {\n        let iv_f32 = (grey[i] as f32) * inv255;",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    (
        "guided.rs: Ip and II formed from unrounded f64 grey * (1/255) instead of f32-rounded plane_i",
        GD,
        [(
            "        let iv = iv_f32 as f64;\n        plane_ip[i] = (iv * (pv_f32 as f64)) as f32;\n        plane_ii[i] = (iv * iv) as f32;",
            "        let iv = (grey[i] as f64) * inv255;\n        plane_ip[i] = (iv * (pv_f32 as f64)) as f32;\n        plane_ii[i] = (iv * iv) as f32;",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    (
        "guided.rs: Ip and II formed after in-place box_pass on plane_mi and plane_p instead of before",
        GD,
        [(
            "    box_pass::<1>(plane_mi, tmp_work, sums, gw, gh, r_work, norm);\n    box_pass::<1>(plane_p, tmp_work, sums, gw, gh, r_work, norm);\n    box_pass::<1>(plane_ip, tmp_work, sums, gw, gh, r_work, norm);",
            "    box_pass::<1>(plane_mi, tmp_work, sums, gw, gh, r_work, norm);\n    box_pass::<1>(plane_p, tmp_work, sums, gw, gh, r_work, norm);\n    for i in 0..n_work { let iv = plane_i[i] as f64; plane_ip[i] = (iv * (plane_p[i] as f64)) as f32; plane_ii[i] = (iv * iv) as f32; }\n    box_pass::<1>(plane_ip, tmp_work, sums, gw, gh, r_work, norm);",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    (
        "guided.rs: bilinear_resize fx kept as f64 instead of round-tripping through f32 wx[x]",
        GD,
        [(
            "        for x in 0..w2 {\n            let ix0 = x0[x] as usize;\n            let ix1 = x1[x] as usize;\n            let fx = wx[x] as f64;",
            "        for x in 0..w2 {\n            let ix0 = x0[x] as usize;\n            let ix1 = x1[x] as usize;\n            let sx = (x as f64 + 0.5) * x_ratio - 0.5;\n            let fx = (sx - sx.floor()).clamp(0.0, 1.0);",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    (
        "guided.rs: bilinear_resize fy truncated to f32 instead of kept as f64",
        GD,
        [(
            "        let row0 = (iy as usize) * w;\n        let row1 = (iy1 as usize) * w;\n        let out_row = y * w2;\n        let inv_fy = 1.0 - fy;",
            "        let row0 = (iy as usize) * w;\n        let row1 = (iy1 as usize) * w;\n        let out_row = y * w2;\n        let fy = (fy as f32) as f64;\n        let inv_fy = 1.0 - fy;",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    (
        "guided.rs: bilinear_resize pixel-centre +0.5 offset dropped on sx",
        GD,
        [(
            "        let sx = (x as f64 + 0.5) * x_ratio - 0.5;",
            "        let sx = (x as f64) * x_ratio;",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    (
        "guided.rs: work_radius gw / rw scale omitted",
        GD,
        [(
            "    let scale = (gw as f64) / (rw as f64);\n    let scaled = r * scale;",
            "    let scale = 1.0;\n    let scaled = r * scale;",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    (
        "guided.rs: js_round_pos half-way tie >= 0.5 mutated to > 0.5",
        GD,
        [(
            "fn js_round_pos(x: f64) -> f64 {\n    let f = x.floor();\n    if x - f >= 0.5 {",
            "fn js_round_pos(x: f64) -> f64 {\n    let f = x.floor();\n    if x - f > 0.5 {",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    (
        "guided.rs: normalise_far range > 1e-12 flat-range guard mutated to range > 0.0",
        GD,
        [(
            "    let range = hi - lo;\n    let inv_range = if range > 1e-12 { 1.0 / range } else { 0.0 };",
            "    let range = hi - lo;\n    let inv_range = if range > 0.0 { 1.0 / range } else { 0.0 };",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    (
        "guided.rs: normalise_far far inversion (1.0 - t) dropped",
        GD,
        [(
            "        *d = (1.0 - t) as f32;",
            "        *d = t as f32;",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    (
        "guided.rs: final q = clamp01(mean_a * I + mean_b) f32 round-trip before * 65535.0 dropped",
        GD,
        [(
            "        let q = v as f32;\n        out[i] = js_round_u16((q as f64) * 65535.0);",
            "        out[i] = js_round_u16(v * 65535.0);",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    (
        "guided.rs: js_round_u16 half-way tie >= 0.5 mutated to > 0.5",
        GD,
        [(
            "fn js_round_u16(x: f64) -> u16 {\n    let f = x.floor();\n    if x - f >= 0.5 {",
            "fn js_round_u16(x: f64) -> u16 {\n    let f = x.floor();\n    if x - f > 0.5 {",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    (
        "lib.rs: guided_far eps > 0.0 guard dropped",
        LB,
        [(
            "        || !eps.is_finite()\n        || !(eps > 0.0)\n        || !lo.is_finite()",
            "        || !eps.is_finite()\n        || !lo.is_finite()",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    # ---- px.js, kernels_js.js, kernels.js, inpaint_worker.js, inpaint_canvas.js
    (
        "px.js: guidedFar disparityRange fallback when lo or hi is null dropped",
        PJ,
        [(
            "        if (lo == null || hi == null) {\n            const bounds = disparityRange(raw);\n            if (lo == null) lo = bounds.lo;\n            if (hi == null) hi = bounds.hi;\n        }",
            "        if (lo == null) lo = 0;\n        if (hi == null) hi = 1;",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    (
        "px.js: guidedFar disparityRange called on raw.subarray(0, nRaw) instead of whole raw",
        PJ,
        [(
            "        if (lo == null || hi == null) {\n            const bounds = disparityRange(raw);\n            if (lo == null) lo = bounds.lo;\n            if (hi == null) hi = bounds.hi;\n        }",
            "        if (lo == null || hi == null) {\n            const bounds = disparityRange(raw.subarray(0, nRaw));\n            if (lo == null) lo = bounds.lo;\n            if (hi == null) hi = bounds.hi;\n        }",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    (
        "px.js: guidedFar options object unpacking dropped",
        PJ,
        [(
            "        if (raw && typeof raw === \"object\" && !ArrayBuffer.isView(raw) && !(raw instanceof ArrayBuffer)) {\n            const msg = raw;\n            out = rw instanceof Uint16Array ? rw : null;\n            ({ raw, rw, rh, grey, gw, gh, r, eps, lo, hi } = msg);\n        }",
            "        if (false) {}",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    (
        "px.js: guidedFar short grey.length < nWork guard dropped",
        PJ,
        [(
            "        if (raw.length < nRaw || grey.length < nWork) return null;",
            "        if (raw.length < nRaw) return null;",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    (
        "px.js: guidedFar caller-supplied out buffer ignored",
        PJ,
        [(
            "            return ok === 1 ? this._out(Uint16Array, pOut, nWork, out) : null;",
            "            return ok === 1 ? this._out(Uint16Array, pOut, nWork, null) : null;",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    (
        "kernels_js.js: guidedFar caller-supplied out buffer ignored",
        KJ,
        [(
            "    if (out) {\n        out.set(res);\n        return out;\n    }",
            "    void out;",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    (
        "kernels_js.js: guidedFar returns zeroed Uint16Array instead of guidedFarDepth",
        KJ,
        [(
            "    const res = guidedFarDepth(msg, boxBlurs);",
            "    const res = new Uint16Array(msg.gw * msg.gh);",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    (
        "kernels.js: guidedFar route name mutated from guidedFar to rangeDepth",
        KR,
        [(
            "export function guidedFar(raw, rw, rh, grey, gw, gh, r, eps, lo, hi, out = null) {\n    const p = rustPx(\"guidedFar\");",
            "export function guidedFar(raw, rw, rh, grey, gw, gh, r, eps, lo, hi, out = null) {\n    const p = rustPx(\"rangeDepth\");",
        )],
        "killed",
        {"px": ["guided"]},
    ),
    (
        "kernels.js: guidedFar catch trap recovery dropped",
        KR,
        [(
            "        } catch (err) {\n            if (!recovered(p, err, \"guided_far\")) throw err;\n        } finally { releaseIfLarge(); }",
            "        } catch (err) {\n            throw err;\n        } finally { releaseIfLarge(); }",
        )],
        "killed",
        {"px": ["retouchRoute"]},
    ),
    (
        "inpaint_worker.js: depthGuide grey luma weights 0.299/0.587/0.114 mutated to equal average",
        WK,
        [(
            "        for (let i = 0, j = 0; j < n; i += 4, j++) {\n            grey[j] = Math.round(bytes[i] * 0.299 + bytes[i + 1] * 0.587 + bytes[i + 2] * 0.114);\n        }",
            "        for (let i = 0, j = 0; j < n; i += 4, j++) {\n            grey[j] = (bytes[i] + bytes[i + 1] + bytes[i + 2]) >> 2;\n        }",
        )],
        "killed",
        {"gates": ["edges"]},
    ),
    (
        "inpaint_worker.js: depthGuide grey Math.round dropped",
        WK,
        [(
            "        for (let i = 0, j = 0; j < n; i += 4, j++) {\n            grey[j] = Math.round(bytes[i] * 0.299 + bytes[i + 1] * 0.587 + bytes[i + 2] * 0.114);\n        }",
            "        for (let i = 0, j = 0; j < n; i += 4, j++) {\n            grey[j] = bytes[i] * 0.299 + bytes[i + 1] * 0.587 + bytes[i + 2] * 0.114;\n        }",
        )],
        "killed",
        {"gates": ["edges"]},
    ),
    (
        "inpaint_worker.js: depthGuide disparityRange(raw, 0.005, 0.995) omitted when lo or hi is null",
        WK,
        [(
            "    if (lo == null || hi == null) {\n        const bounds = disparityRange(raw, 0.005, 0.995);\n        if (lo == null) lo = bounds.lo;\n        if (hi == null) hi = bounds.hi;\n    }",
            "    if (lo == null) lo = 0;\n    if (hi == null) hi = 1;",
        )],
        "killed",
        {"gates": ["edges"]},
    ),
    (
        "inpaint_worker.js: depthGuide bypasses routed guidedFar and calls inpaint_depth.js guidedFar directly",
        WK,
        [
            (
                "import { disparityRange } from \"./inpaint_depth.js\";",
                "import { disparityRange, guidedFar as guidedFarJS } from \"./inpaint_depth.js\";",
            ),
            (
                "    const u16 = guidedFar(raw, rw, rh, grey, gw, gh, r, eps, lo, hi);",
                "    const u16 = guidedFarJS({ raw, rw, rh, grey, gw, gh, r, eps, lo, hi }, boxBlurs);",
            ),
        ],
        "killed",
        {"gates": ["edges"]},
    ),
    (
        "inpaint_canvas.js: depthFromLayer poolRes.gd replaced with zeroed Uint8ClampedArray",
        CV,
        [(
            "        const u16 = new Uint16Array(poolRes.u16);\n        const gd = new Uint8ClampedArray(poolRes.gd);\n\n        const fpInp = await host.pictureInput(this, 64, 64, { skipFilters: true, background: \"#808080\" });",
            "        const u16 = new Uint16Array(poolRes.u16);\n        const gd = new Uint8ClampedArray(poolRes.gd.byteLength);\n\n        const fpInp = await host.pictureInput(this, 64, 64, { skipFilters: true, background: \"#808080\" });",
        )],
        "killed",
        {"gates": ["edges"]},
    ),
]
