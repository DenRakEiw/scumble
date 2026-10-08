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

    console.log(failures ? `${failures} FAILED` : "all ok");
    process.exit(failures ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
