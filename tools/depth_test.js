// Plain Node unit tests for Depth Anything V2 Small helper (R1-S1), no real model:
//
//     node tools/depth_test.js
//
// Checks:
// - normaliseRect(rgba, n, n) is byte-equal to normalise(rgba, mean, std, n) for n = 64
// - Depth.run picks [1, h, w] over decoy outputs and throws naming dims when none fits
// - depth() facade validation (multiples of 14, buffer size, bounds)
"use strict";

const { normalise, normaliseRect } = require("../electron/main/onnx/sam2");
const { Depth } = require("../electron/main/onnx/depth");
const onnx = require("../electron/main/onnx/index");

let failures = 0;
function check(name, ok, detail = "") {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
    if (!ok) failures++;
}

// 1. normaliseRect vs normalise byte-equality
{
    const n = 64;
    const rgba = new Uint8Array(n * n * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + 13) & 0xff;
    const a = normaliseRect(rgba, n, n);
    const b = normalise(rgba, undefined, undefined, n);
    let same = a.length === b.length;
    if (same) {
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) { same = false; break; }
        }
    }
    check("normaliseRect(rgba, n, n) byte-equal to normalise(rgba, ...)", same);
}

// 2. Depth.run with fake runtime
(async () => {
    const w = 28, h = 14;
    const n = w * h;
    const expectedData = new Float32Array(n);
    for (let i = 0; i < n; i++) expectedData[i] = (i % 100) * 0.1;

    // Fake runtime returning decoy [1, 1] and valid [1, h, w]
    const fakeRuntime = {
        tensor(type, data, dims) { return { type, data, dims }; },
        async session() {
            return {
                provider: "cpu",
                session: {
                    inputNames: ["pixel_values"],
                    outputNames: ["decoy", "predicted_depth"],
                    async run() {
                        return {
                            decoy: { data: new Float32Array([99]), dims: [1, 1] },
                            predicted_depth: { data: expectedData, dims: [1, h, w] },
                        };
                    },
                },
            };
        },
    };

    const model = { id: "da2_small", label: "Depth Anything V2 Small", mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] };
    const depthHelper = new Depth(fakeRuntime, model, "fake.onnx");
    const rgba = new Uint8Array(w * h * 4);
    const res = await depthHelper.run(rgba, w, h);
    check("Depth.run picks output matching w*h elements", res && res.depth.length === n && res.depth === expectedData);
    check("Depth.run reports dimensions and provider", res.width === w && res.height === h && res.provider === "cpu");
    check("Depth.run calculates min and max correctly", Math.abs(res.min - 0) < 1e-5 && Math.abs(res.max - 9.9) < 1e-4);

    // Fake runtime returning no fitting output: must throw naming the dims
    const badRuntime = {
        tensor(type, data, dims) { return { type, data, dims }; },
        async session() {
            return {
                provider: "cpu",
                session: {
                    inputNames: ["pixel_values"],
                    outputNames: ["decoy"],
                    async run() {
                        return {
                            decoy: { data: new Float32Array([42]), dims: [1, 1] },
                        };
                    },
                },
            };
        },
    };
    const badHelper = new Depth(badRuntime, model, "fake.onnx");
    let caught = null;
    try {
        await badHelper.run(rgba, w, h);
    } catch (err) {
        caught = err;
    }
    check("Depth.run throws naming output dims when no output matches", caught && caught.message.includes("1×1") && caught.message.includes("Depth Anything V2 Small"), caught ? caught.message : "none");

    // 3. depth() facade validation
    // refuses 518 x 777 (777 % 14 !== 0)
    let caught777 = null;
    try {
        await onnx.depth({ image: new Uint8Array(518 * 777 * 4), width: 518, height: 777 });
    } catch (err) {
        caught777 = err;
    }
    check("depth() refuses 518 x 777 with 'multiples of 14'", caught777 && caught777.message.includes("multiples of 14"), caught777 ? caught777.message : "none");

    // refuses short buffer
    let caughtShort = null;
    try {
        await onnx.depth({ image: new Uint8Array(100), width: 28, height: 28 });
    } catch (err) {
        caughtShort = err;
    }
    check("depth() refuses short buffer", caughtShort && caughtShort.message.includes("length 100"), caughtShort ? caughtShort.message : "none");

    // refuses out of bounds
    let caughtBounds = null;
    try {
        await onnx.depth({ image: new Uint8Array(2072 * 14 * 4), width: 2072, height: 14 });
    } catch (err) {
        caughtBounds = err;
    }
    check("depth() refuses dimensions > 2058", caughtBounds && caughtBounds.message.includes("multiples of 14"), caughtBounds ? caughtBounds.message : "none");

    // 4. Depth map maths & guided filter (R1-S3a)
    const fs = require("node:fs");
    const path = require("node:path");
    const DepthMath = await import("../renderer/editor/inpaint_depth.js");
    const { boxBlurs } = await import("../renderer/editor/px/kernels_js.js");

    // roundHalfEven
    check("roundHalfEven(54.5) = 54", DepthMath.roundHalfEven(54.5) === 54);
    check("roundHalfEven(55.5) = 56", DepthMath.roundHalfEven(55.5) === 56);

    // modelSize table of R1-S2
    const table = [
        [[6000, 4000], [784, 518]],
        [[2000, 1125], [924, 518]],
        [[1500, 2000], [518, 686]],
        [[400, 300], [518, 392]],
        [[763, 518], [756, 518]],
        [[15000, 10000], [784, 518]],
        [[6000, 1000], [3108, 518]],
        [[300, 1000], [154, 518]],
        [[1000, 300], [518, 154]],
    ];
    for (const [[w, h], [ew, eh]] of table) {
        const [mw, mh] = DepthMath.modelSize(w, h, { cap: null });
        check(`modelSize(${w}, ${h}) -> [${mw}, ${mh}]`, mw === ew && mh === eh);
    }
    const [capW, capH] = DepthMath.modelSize(6000, 1000);
    check("modelSize(6000, 1000) capped at LONG_CAP (2058)", capW === 2058 && capH === 336 && capW % 14 === 0 && capH % 14 === 0);

    // workSize
    const [gw, gh] = DepthMath.workSize(15000, 10000, DepthMath.WORK_MAX);
    check("workSize(15000, 10000, 2048) -> [2048, 1365]", gw === 2048 && gh === 1365);

    // disparityRange on a 1..1000 ramp gives lo ≈ 5.995 and hi ≈ 995.005 (±1 bin)
    const nRamp = 100000;
    const ramp = new Float32Array(nRamp);
    for (let i = 0; i < nRamp; i++) ramp[i] = 1 + (999 * i) / (nRamp - 1);
    const { lo, hi } = DepthMath.disparityRange(ramp);
    check("disparityRange on 1..1000 ramp gives lo ≈ 5.995 and hi ≈ 995.005",
        Math.abs(lo - 5.995) < 0.25 && Math.abs(hi - 995.005) < 0.25,
        `lo=${lo.toFixed(3)}, hi=${hi.toFixed(3)}`);

    // farU16: d = hi -> 0, d = lo -> 65535, monotonic
    const dVals = new Float32Array([100, 55, 10]);
    const far = DepthMath.farU16(dVals, 10, 100);
    check("farU16: d = hi -> 0", far[0] === 0);
    check("farU16: d = lo -> 65535", far[2] === 65535);
    check("farU16: monotonic", far[0] < far[1] && far[1] < far[2]);

    // guidedFilter: constant p gives p (|Δ| ≤ 1e-6)
    const cw = 64, ch = 64;
    const I_const = new Float32Array(cw * ch);
    const p_const = new Float32Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) {
        I_const[i] = (i % 64) / 64;
        p_const[i] = 0.42;
    }
    const q_const = DepthMath.guidedFilter(I_const, p_const, cw, ch, 4, 1e-3, boxBlurs);
    let maxConstDelta = 0;
    for (let i = 0; i < cw * ch; i++) {
        const diff = Math.abs(q_const[i] - 0.42);
        if (diff > maxConstDelta) maxConstDelta = diff;
    }
    check("guidedFilter: constant p gives p (|Δ| ≤ 1e-6)", maxConstDelta <= 1e-6, `delta=${maxConstDelta.toExponential(2)}`);

    // guidedFilter: eps = 1e6 approaches double box mean (mean of local means)
    const p_rand = new Float32Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) p_rand[i] = ((i * 37 + 13) & 0xff) / 255;
    const q_box = DepthMath.guidedFilter(I_const, p_rand, cw, ch, 4, 1e6, boxBlurs);
    const b_mean = boxBlurs(boxBlurs(p_rand, cw, ch, [4]), cw, ch, [4]);
    let maxMeanDelta = 0;
    for (let i = 0; i < cw * ch; i++) {
        const diff = Math.abs(q_box[i] - b_mean[i]);
        if (diff > maxMeanDelta) maxMeanDelta = diff;
    }
    check("guidedFilter: eps = 1e6 equals double box mean (≤ 1e-5)", maxMeanDelta <= 1e-5, `delta=${maxMeanDelta.toExponential(2)}`);

    // guidedFilter: edge-preserving smoothing of a step edge in I (r = 8, eps = 1e-4) preserves sharp step ≤ 2 px vs box blur ≥ 8 px
    const sw = 100, sh = 20;
    const I_step = new Float32Array(sw * sh);
    const p_noisy = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
            const idx = y * sw + x;
            I_step[idx] = x < 50 ? 0.1 : 0.9;
            const noise = (((idx * 17) % 100) / 100 - 0.5) * 0.05;
            p_noisy[idx] = (x < 50 ? 0.1 : 0.9) + noise;
        }
    }
    const b_step = boxBlurs(p_noisy, sw, sh, [8]);
    const q_guided = DepthMath.guidedFilter(I_step, p_noisy, sw, sh, 8, 1e-4, boxBlurs);

    function transitionWidth(arr, rowY, W) {
        const row = arr.subarray(rowY * W, (rowY + 1) * W);
        const minV = row[0], maxV = row[W - 1];
        const v10 = minV + 0.1 * (maxV - minV);
        const v90 = minV + 0.9 * (maxV - minV);
        let x10 = -1, x90 = -1;
        for (let x = 0; x < W; x++) {
            if (x10 < 0 && row[x] >= v10) x10 = x;
            if (x90 < 0 && row[x] >= v90) { x90 = x; break; }
        }
        return x90 - x10;
    }
    const w_box = transitionWidth(b_step, 10, sw);
    const w_guided = transitionWidth(q_guided, 10, sw);
    check("guidedFilter: step edge in I preserves sharp transition (≤ 2 px vs ≥ 8)",
        w_guided <= 2 && w_box >= 8, `guided width=${w_guided} px, box width=${w_box} px`);

    // guidedFar against R1-S2's numpy reference on scene.jpg's 2048 map within 64/65535
    const refPath = path.join(__dirname, "../dist/depth_checkpoint/scene/ref_py.u16");
    const rawPath = path.join(__dirname, "../dist/depth_checkpoint/scene/raw.f32");
    const greyPath = path.join(__dirname, "../dist/depth_checkpoint/scene/grey.u8");
    if (fs.existsSync(refPath) && fs.existsSync(rawPath) && fs.existsSync(greyPath)) {
        const rawBuf = fs.readFileSync(rawPath);
        const raw = new Float32Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength / 4);
        const greyBuf = fs.readFileSync(greyPath);
        const grey = new Uint8Array(greyBuf.buffer, greyBuf.byteOffset, greyBuf.byteLength);
        const refBuf = fs.readFileSync(refPath);
        const ref = new Uint16Array(refBuf.buffer, refBuf.byteOffset, refBuf.byteLength / 2);

        const u16 = DepthMath.guidedFar({
            raw, rw: 924, rh: 518,
            grey, gw: 2000, gh: 1125,
            r: 2, eps: 1e-3,
            lo: 0.0, hi: 7.497405529022217,
        }, boxBlurs);

        let maxRefDiff = 0;
        for (let i = 0; i < u16.length; i++) {
            const d = Math.abs(u16[i] - ref[i]);
            if (d > maxRefDiff) maxRefDiff = d;
        }
        check("guidedFar against R1-S2 numpy reference within 64/65535", maxRefDiff <= 64, `maxDiff=${maxRefDiff}/65535`);
    } else {
        check("guidedFar against R1-S2 numpy reference", true, "(skipped: run tools/depth_probe.py first)");
    }

    console.log(failures ? `${failures} FAILED` : "all ok");
    process.exit(failures ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
