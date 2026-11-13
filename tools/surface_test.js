// Plain-Node check of Deep paint's surface maps (renderer/editor/inpaint_surface.js, docs/PLAN_SURFACE_PAINT.md SP3).
//
//     node tools/surface_test.js                       the synthetic checks alone
//     node tools/surface_test.js <modelsDir> <picsDir>  plus the real decomposition on pictures
//
// Synthetic: the scale fit finds a known a and b; a picture made as A * S + R comes back from the stored maps within a
// level; R stays in [0, I]; A clamps where S is dark; the normals pack. With a models folder (the set in
// onnx/intrinsic/) and a folder of pictures as raw RGBA (`<name>_model.rgba` at the model's size, `<name>_work.rgba` at
// the work size, `meta.json` with the sizes; the session's sp3_prep.py writes them), every picture through the
// decomposition (engine.js on this thread) and `surfaceMaps`: the identity within one level, the timing.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`); if (!ok) failures++; return ok; };

async function main() {
    const S = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_surface.js")).href);
    const K = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "px", "kernels_js.js")).href);
    const box = K.boxBlurs;

    // ---- synthetic -------------------------------------------------------------------------------------------
    const w = 96, h = 64, n = w * h;
    const A = new Float32Array(n * 3), Sh = new Float32Array(n * 3), R = new Float32Array(n * 3), rgba = new Uint8Array(n * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const s = 0.15 + 0.8 * (x / (w - 1));                      // a light ramp
        const alb = x < w / 2 ? [0.7, 0.2, 0.1] : [0.2, 0.4, 0.7];  // two colours
        const spec = (x - 70) ** 2 + (y - 30) ** 2 < 36 ? 0.3 : 0;  // a highlight
        for (let c = 0; c < 3; c++) {
            A[3 * i + c] = alb[c]; Sh[3 * i + c] = s; R[3 * i + c] = spec;
            const lin = Math.min(1, alb[c] * s + spec);
            rgba[4 * i + c] = Math.round(S.linToSrgb255(lin));
        }
        rgba[4 * i + 3] = 255;
    }
    // the model's view: S and R at a wrong scale
    const half = (src, k) => src.map((v) => v * k);
    const fit = S.fitScale(rgba, A, half(Sh, 0.5), half(R, 0.4), n);
    check("the scale fit finds the light's and the reflections' scale", Math.abs(fit.a - 2) < 0.05 && Math.abs(fit.b - 2.5) < 0.15, `a ${fit.a.toFixed(3)}, b ${fit.b.toFixed(3)}`);
    for (const [W2, H2] of [[w, h], [3 * w, 3 * h]]) {
        // the work size: the same scene drawn at W2 x H2
        const pic = new Uint8Array(W2 * H2 * 4);
        for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
            const sx = Math.min(w - 1, Math.floor(x * w / W2)), sy = Math.min(h - 1, Math.floor(y * h / H2));
            pic.set(rgba.subarray(4 * (sy * w + sx), 4 * (sy * w + sx) + 4), 4 * (y * W2 + x));
        }
        const t0 = Date.now();
        const res = S.surfaceMaps({ albedo: A, shading: half(Sh, 0.5), residual: half(R, 0.4), model: rgba, mw: w, mh: h, picture: pic, gw: W2, gh: H2, box });
        let rOk = true;
        for (let i = 0; i < W2 * H2 && rOk; i++) for (let c = 0; c < 3; c++) if (res.residual[3 * i + c] / 65535 > S.SRGB_TO_LIN[pic[4 * i + c]] + 1e-4) { rOk = false; break; }
        check(`synthetic ${W2} x ${H2}: the picture back from the stored maps within a level, R in [0, I]`, res.identity.maxLevels <= 1 && rOk,
            `max ${res.identity.maxLevels.toFixed(3)}, mean ${res.identity.meanLevels.toFixed(4)} levels, sScale ${res.sScale.toFixed(3)}, A clamped ${(100 * res.clampedA).toFixed(2)} %, ${Date.now() - t0} ms`);
    }
    // a black picture: S and R zero, A clamps, still the identity
    const black = new Uint8Array(n * 4).fill(0);
    const rb = S.surfaceMaps({ albedo: A, shading: Sh, residual: R, model: black, mw: w, mh: h, picture: black, gw: w, gh: h, box });
    check("a black picture: the identity holds, R zero", rb.identity.maxLevels <= 1 && rb.residual.every((v) => v === 0), `max ${rb.identity.maxLevels.toFixed(3)}`);
    const nrm = S.packNormals(Float32Array.from([1, 0, 0, 0, -1, 0, 0, 0, -1]), Float32Array.from([1, 0.5, 0]), 3);
    check("the normals pack: (n + 1) / 2 per axis, the mask in A", [...nrm].join(",") === "255,128,128,255,128,0,128,128,128,128,0,0", [...nrm].join(","));
    check("the model's size: long side 768, at least 16", S.surfaceModelSize(15000, 10000).join("x") === "768x512" && S.surfaceModelSize(500, 300).join("x") === "500x300" && S.surfaceModelSize(4000, 20).join("x") === "768x16");

    // ---- the real decomposition ------------------------------------------------------------------------------
    const [modelsDir, picsDir] = process.argv.slice(2);
    if (modelsDir && picsDir) {
        const models = require("../electron/main/onnx/models");
        const { engine, modelInfo } = require("../electron/main/onnx/engine");
        const { Runtime } = require("../electron/main/onnx/runtime");
        const set = models.byId("intrinsic"), files = models.paths(set, modelsDir);
        if (!files) { console.log("FAIL the decomposition set is not in", modelsDir); process.exit(1); }
        const eng = engine(new Runtime());
        const meta = JSON.parse(fs.readFileSync(path.join(picsDir, "meta.json"), "utf8"));
        for (const [name, m] of Object.entries(meta)) {
            const [mw, mh] = m.model, [gw, gh] = m.work;
            const model = new Uint8Array(fs.readFileSync(path.join(picsDir, `${name}_model.rgba`)));
            const picture = new Uint8Array(fs.readFileSync(path.join(picsDir, `${name}_work.rgba`)));
            const t0 = Date.now();
            const d = await eng.intrinsic({ model: modelInfo(set), files, image: model, width: mw, height: mh, seed: 0 });
            const t1 = Date.now();
            const res = S.surfaceMaps({ albedo: d.albedo, shading: d.shading, residual: d.residual, model, mw, mh, picture, gw, gh, box });
            const t2 = Date.now();
            const other = S.surfaceMaps({ albedo: d.albedo, shading: d.shading, residual: d.residual, model, mw, mh, picture, gw, gh, box, mode: "excess" });
            // zeroA (where the reflections took all the picture, so paint would add light instead of covering) is reported,
            // not judged: SP5's "Keep reflections" handles it; the excess mode's share beside it for the comparison
            check(`${name} ${gw} x ${gh}: the picture back from the stored maps within a level`, res.identity.maxLevels <= 1,
                `max ${res.identity.maxLevels.toFixed(3)}, mean ${res.identity.meanLevels.toFixed(4)}; a ${res.a.toFixed(2)}, b ${res.b.toFixed(2)}, sScale ${res.sScale.toFixed(2)}, r ${res.r}, A clamped ${(100 * res.clampedA).toFixed(2)} % (at 0: ${(100 * res.zeroA).toFixed(2)} %; excess: ${(100 * other.zeroA).toFixed(2)} %); model ${t1 - t0} ms on ${d.provider}, maps ${t2 - t1} ms`);
        }
        await eng.free();
    }
    console.log(failures ? `FAIL ${failures}` : "PASS");
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("FAIL", e && e.stack || e); process.exit(1); });
