// Plain-Node test suite for pure weights module (F3 / PLAN_NIK9_BUILD §3.1)
// Run with: node tools/weights_test.js
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

let passed = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`[ok] ${name}`);
        passed++;
    } catch (err) {
        console.error(`[FAIL] ${name}:`, err);
        process.exit(1);
    }
}

async function main() {
    const weightsMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_weights.js")).href);
    const {
        LUMA,
        sstep,
        rangeWeight,
        opp,
        colourSimilarity,
        hexToRgb,
        sourceValue,
        limitWeight,
        weightTable,
        normalizeLimit,
        u16Bilinear,
        WEIGHTS_GLSL,
    } = weightsMod;

    // ---------------------------------------------------------------------------
    // 1. sstep & rangeWeight: test requirements from PLAN_NIK9_BUILD §3.1
    // "With lo .3, hi .6, f .1: w(.3) = 1, w(.2) = 0, w(.25) = .5, w(.6) = 1,
    //  w(.65) = .5, w(.7) = 0; invert gives 1 - w; fLo 0 gives 0 at .2999 and 1 at .3."
    // ---------------------------------------------------------------------------

    test("rangeWeight: lo .3, hi .6, f .1 test values", () => {
        const r = { lo: 0.3, hi: 0.6, fLo: 0.1, fHi: 0.1, invert: false };

        assert.equal(rangeWeight(0.3, r), 1, "w(.3) must be 1");
        assert.equal(rangeWeight(0.2, r), 0, "w(.2) must be 0");
        assert.ok(Math.abs(rangeWeight(0.25, r) - 0.5) < 1e-12, "w(.25) must be 0.5");
        assert.equal(rangeWeight(0.6, r), 1, "w(.6) must be 1");
        assert.ok(Math.abs(rangeWeight(0.65, r) - 0.5) < 1e-12, "w(.65) must be 0.5");
        assert.equal(rangeWeight(0.7, r), 0, "w(.7) must be 0");

        // Inside plateau [0.3 .. 0.6]
        assert.equal(rangeWeight(0.45, r), 1, "w(.45) must be 1");

        // Outside (< 0.2 or > 0.7)
        assert.equal(rangeWeight(0.1, r), 0, "w(.1) must be 0");
        assert.equal(rangeWeight(0.8, r), 0, "w(.8) must be 0");

        // Invert gives 1 - w
        const rInv = { ...r, invert: true };
        assert.equal(rangeWeight(0.3, rInv), 0, "invert w(.3) must be 0");
        assert.equal(rangeWeight(0.2, rInv), 1, "invert w(.2) must be 1");
        assert.ok(Math.abs(rangeWeight(0.25, rInv) - 0.5) < 1e-12, "invert w(.25) must be 0.5");
        assert.equal(rangeWeight(0.6, rInv), 0, "invert w(.6) must be 0");
        assert.ok(Math.abs(rangeWeight(0.65, rInv) - 0.5) < 1e-12, "invert w(.65) must be 0.5");
        assert.equal(rangeWeight(0.7, rInv), 1, "invert w(.7) must be 1");
    });

    test("rangeWeight: fLo = 0 gives hard step (0 at .2999, 1 at .3)", () => {
        const rHard = { lo: 0.3, hi: 0.6, fLo: 0, fHi: 0.1, invert: false };
        assert.equal(rangeWeight(0.2999, rHard), 0, "fLo 0 gives 0 at .2999");
        assert.equal(rangeWeight(0.3, rHard), 1, "fLo 0 gives 1 at .3");
    });

    test("rangeWeight: fHi = 0 gives hard step (1 at .6, 0 at .6001)", () => {
        const rHardHi = { lo: 0.3, hi: 0.6, fLo: 0.1, fHi: 0, invert: false };
        assert.equal(rangeWeight(0.6, rHardHi), 1, "fHi 0 gives 1 at .6");
        assert.equal(rangeWeight(0.6001, rHardHi), 0, "fHi 0 gives 0 at .6001");
    });

    // ---------------------------------------------------------------------------
    // 2. colourSimilarity: equals points.js on 10,000 random pairs to 1e-12
    // ---------------------------------------------------------------------------

    test("colourSimilarity: matches points.js formula on 10,000 random pairs (< 1e-12)", () => {
        // Pseudo-random deterministic LCG for reproducible 10k tests
        let seed = 42;
        const rand = () => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 4294967296;
        };

        // Reference formula from plugins/film/points.js:43-44, 149-151
        const refOpp = (r, g, b) => {
            const L = 0.299 * r + 0.587 * g + 0.114 * b;
            return [L, r - L, b - L];
        };
        const refSimilarity = (r, g, b, targetOpp, tol) => {
            const o3 = refOpp(r, g, b);
            const d0 = o3[0] - targetOpp[0];
            const d1 = o3[1] - targetOpp[1];
            const d2 = o3[2] - targetOpp[2];
            const dd = d0 * d0 + 4 * (d1 * d1 + d2 * d2);
            const s = 0.04 + Math.max(0, Math.min(1, tol / 100)) * 0.6;
            return Math.exp(-dd / (2 * s * s));
        };

        let maxDiff = 0;
        for (let i = 0; i < 10000; i++) {
            const r = rand();
            const g = rand();
            const b = rand();
            const refR = rand();
            const refG = rand();
            const refB = rand();
            const tol = rand() * 100;

            const targetOpp = refOpp(refR, refG, refB);

            const expected = refSimilarity(r, g, b, targetOpp, tol);
            const actual = colourSimilarity(r, g, b, targetOpp, tol);

            const diff = Math.abs(expected - actual);
            if (diff > maxDiff) maxDiff = diff;
        }

        assert.ok(maxDiff < 1e-12, `max difference ${maxDiff} must be < 1e-12`);
    });

    // ---------------------------------------------------------------------------
    // 3. normalizeLimit: validation, clamping, swapping and immutability
    // ---------------------------------------------------------------------------

    test("normalizeLimit: handles null/false and validates source", () => {
        assert.equal(normalizeLimit(null), null);
        assert.equal(normalizeLimit(undefined), null);
        assert.equal(normalizeLimit(false), null);

        assert.throws(() => {
            normalizeLimit({ source: "x", lo: 0.2, hi: 0.5 });
        }, /limit\.source must be depth, luma or color/);

        assert.throws(() => {
            normalizeLimit({ lo: 0.2, hi: 0.5 });
        }, /limit\.source must be depth, luma or color/);
    });

    test("normalizeLimit: swaps lo > hi, clamps to 0..1 and returns fresh object", () => {
        const input = { source: "depth", lo: 0.8, hi: 0.2, fLo: -0.1, fHi: 1.5, invert: true };
        const norm = normalizeLimit(input);

        assert.notEqual(norm, input, "must return a new object");
        assert.equal(norm.source, "depth");
        assert.equal(norm.lo, 0.2, "lo and hi swapped");
        assert.equal(norm.hi, 0.8, "lo and hi swapped");
        assert.equal(norm.fLo, 0, "fLo clamped to 0");
        assert.equal(norm.fHi, 1, "fHi clamped to 1");
        assert.equal(norm.invert, true);

        // For source "color"
        const colNorm = normalizeLimit({ source: "color", lo: 0.1, hi: 0.9, color: "#ff8800", tol: 45 });
        assert.equal(colNorm.source, "color");
        assert.equal(colNorm.color, "#ff8800");
        assert.equal(colNorm.tol, 45);

        // Color defaults when missing
        const colDef = normalizeLimit({ source: "color", lo: 0.1, hi: 0.9 });
        assert.equal(colDef.color, "#ffffff");
        assert.equal(colDef.tol, 30);
    });

    // ---------------------------------------------------------------------------
    // 4. u16Bilinear: 3 x 2 map tests (corners exact, edges clamped, centre = mean)
    // ---------------------------------------------------------------------------

    test("u16Bilinear: 3 x 2 map corners exact, edges clamped, centre equal to mean", () => {
        const w = 3, h = 2;
        // 3x2 grid with known linear values:
        // Row 0: 10000, 20000, 30000
        // Row 1: 30000, 40000, 50000
        const data = new Uint16Array([
            10000, 20000, 30000,
            30000, 40000, 50000,
        ]);

        const meanVal = (10000 + 20000 + 30000 + 30000 + 40000 + 50000) / 6 / 65535;

        // 1. Corners exact: pixel centers at (x + 0.5, y + 0.5)
        assert.equal(u16Bilinear(data, w, h, 0.5, 0.5), 10000 / 65535, "top-left corner exact");
        assert.equal(u16Bilinear(data, w, h, 2.5, 0.5), 30000 / 65535, "top-right corner exact");
        assert.equal(u16Bilinear(data, w, h, 0.5, 1.5), 30000 / 65535, "bottom-left corner exact");
        assert.equal(u16Bilinear(data, w, h, 2.5, 1.5), 50000 / 65535, "bottom-right corner exact");

        // 2. Edges clamped: outside coordinates clamp to nearest border pixel center
        assert.equal(u16Bilinear(data, w, h, -5, -5), 10000 / 65535, "negative coordinates clamp to top-left");
        assert.equal(u16Bilinear(data, w, h, 10, 10), 50000 / 65535, "large coordinates clamp to bottom-right");
        assert.equal(u16Bilinear(data, w, h, -1, 0.5), 10000 / 65535, "left edge clamped");
        assert.equal(u16Bilinear(data, w, h, 5, 0.5), 30000 / 65535, "right edge clamped");

        // 3. Centre of 3x2 image: px = 1.5, py = 1.0
        // Horizontal: x = 1.5 is exactly column 1 (center of column 1).
        // Vertical: y = 1.0 is halfway between row 0 (0.5) and row 1 (1.5).
        // Bilinear sample is: 0.5 * row0[col1] + 0.5 * row1[col1] = 0.5 * 20000 + 0.5 * 40000 = 30000 / 65535.
        // This is mathematically equal to the mean of the entire map!
        const centreSample = u16Bilinear(data, w, h, 1.5, 1.0);
        assert.ok(Math.abs(centreSample - meanVal) < 1e-12, `centre sample (${centreSample}) must equal mean (${meanVal})`);
    });

    // ---------------------------------------------------------------------------
    // 5. weightTable: 256-entry table for 8-bit luma
    // ---------------------------------------------------------------------------

    test("weightTable: generates 256-byte Uint8Array matching rangeWeight", () => {
        const r = { lo: 0.2, hi: 0.8, fLo: 0.1, fHi: 0.1, invert: false };
        const table = weightTable(r);

        assert.ok(table instanceof Uint8Array, "must be Uint8Array");
        assert.equal(table.length, 256, "must have 256 entries");

        for (let i = 0; i < 256; i++) {
            const expected = Math.round(255 * rangeWeight(i / 255, r));
            assert.equal(table[i], expected, `table[${i}] must match expected weight`);
        }
    });

    // ---------------------------------------------------------------------------
    // 6. sourceValue & limitWeight
    // ---------------------------------------------------------------------------

    test("sourceValue & limitWeight: luma, depth, and color evaluation", () => {
        // Luma
        const lumaLimit = { source: "luma", lo: 0.4, hi: 0.8, fLo: 0.1, fHi: 0.1, invert: false };
        const lumaVal = sourceValue(lumaLimit, 1, 1, 1, 0);
        assert.equal(Math.round(lumaVal * 1000) / 1000, 1.0);
        assert.equal(limitWeight(lumaLimit, 1, 1, 1, 0), 0); // 1.0 is > 0.9 (hi + fHi)

        // Depth
        const depthLimit = { source: "depth", lo: 0.2, hi: 0.6, fLo: 0.05, fHi: 0.05, invert: false };
        assert.equal(sourceValue(depthLimit, 0, 0, 0, 0.4), 0.4);
        assert.equal(limitWeight(depthLimit, 0, 0, 0, 0.4), 1.0); // 0.4 is in plateau

        // Color
        const colorLimit = { source: "color", lo: 0.5, hi: 1.0, fLo: 0.1, fHi: 0.1, invert: false, color: "#ff0000", tol: 30 };
        const simSame = sourceValue(colorLimit, 1, 0, 0, 0); // pure red
        assert.ok(Math.abs(simSame - 1.0) < 1e-6, "pure red similarity must be 1.0");
        assert.equal(limitWeight(colorLimit, 1, 0, 0, 0), 1.0);

        const simDiff = sourceValue(colorLimit, 0, 0, 1, 0); // pure blue vs red
        assert.ok(simDiff < 0.1, "blue similarity against red must be low");
        assert.equal(limitWeight(colorLimit, 0, 0, 1, 0), 0);
    });

    // ---------------------------------------------------------------------------
    // 7. WEIGHTS_GLSL syntax & structure check
    // ---------------------------------------------------------------------------

    test("WEIGHTS_GLSL: defines w_sstep, w_range, w_opp, w_colour, w_limit", () => {
        assert.ok(typeof WEIGHTS_GLSL === "string");
        assert.ok(WEIGHTS_GLSL.includes("float w_sstep("), "w_sstep present");
        assert.ok(WEIGHTS_GLSL.includes("float w_range("), "w_range present");
        assert.ok(WEIGHTS_GLSL.includes("vec3 w_opp("), "w_opp present");
        assert.ok(WEIGHTS_GLSL.includes("float w_colour("), "w_colour present");
        assert.ok(WEIGHTS_GLSL.includes("float w_limit("), "w_limit present");
    });

    console.log(`\nAll ${passed} tests passed!`);
}

main().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});
