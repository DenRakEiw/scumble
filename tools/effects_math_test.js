// @ts-check
// Unit tests for Effects pack mathematics foundation (PLAN_NIK9_BUILD.md R3-S9).
// Tests pure math exports in plain Node with no DOM or browser dependencies.

"use strict";

const { offsets } = require("../plugins/effects/chromatic.js");
const { glassField } = require("../plugins/effects/glass.js");
const { bilinAt } = require("../plugins/effects/common.js");

let failed = 0;
const results = [];

function check(name, ok, msg) {
    if (ok) {
        results.push(`[ok] ${name}`);
    } else {
        failed++;
        results.push(`[FAIL] ${name}: ${msg || "assertion failed"}`);
    }
}

// -----------------------------------------------------------------------------
// 1. Plates offsets sum to (0, 0)
// -----------------------------------------------------------------------------
{
    const angles = [0, 30, 45, 60, 90, 120, 137, 180, 240, -45, -90, -180];
    const amounts = [1, 6, 15, 60];
    let allPlatesSumZero = true;
    let maxPlatesError = 0;

    for (const angle of angles) {
        for (const amount of amounts) {
            const { oR, oG, oB } = offsets({ style: "plates", amount, angle });
            const sumX = oR[0] + oG[0] + oB[0];
            const sumY = oR[1] + oG[1] + oB[1];
            const err = Math.hypot(sumX, sumY);
            if (err > maxPlatesError) maxPlatesError = err;
            if (err > 1e-11) {
                allPlatesSumZero = false;
            }
        }
    }
    check("plates offsets sum to (0, 0)", allPlatesSumZero, `max error = ${maxPlatesError}`);
}

// -----------------------------------------------------------------------------
// 2. Linear offsets sum to (0, 0)
// -----------------------------------------------------------------------------
{
    const angles = [0, 30, 45, 90, -60];
    let allLinearSumZero = true;
    for (const angle of angles) {
        const { oR, oG, oB } = offsets({ style: "linear", amount: 10, angle });
        const sumX = oR[0] + oG[0] + oB[0];
        const sumY = oR[1] + oG[1] + oB[1];
        if (Math.hypot(sumX, sumY) > 1e-12) allLinearSumZero = false;
    }
    check("linear offsets sum to (0, 0)", allLinearSumZero);
}

// -----------------------------------------------------------------------------
// 3. Lateral is 0 at the centre and amount at a corner
// -----------------------------------------------------------------------------
{
    const pw = 600, ph = 400;
    const amount = 12;

    // Centre test
    const centre = offsets({ style: "lateral", amount }, 1, pw / 2, ph / 2, pw, ph);
    const centreLen = Math.hypot(centre.oR[0], centre.oR[1]);
    check("lateral is 0 at the centre", centreLen < 1e-12, `centre length = ${centreLen}`);

    // Default call without position returns 0 offset
    const defCall = offsets({ style: "lateral", amount }, 1);
    check("lateral default position is 0", Math.hypot(defCall.oR[0], defCall.oR[1]) < 1e-12);

    // Corners test
    const corners = [
        [0, 0],
        [pw, 0],
        [0, ph],
        [pw, ph],
    ];
    let allCornersAmount = true;
    let maxCornerErr = 0;

    for (const [cx, cy] of corners) {
        const cOff = offsets({ style: "lateral", amount }, 1, cx, cy, pw, ph);
        const len = Math.hypot(cOff.oR[0], cOff.oR[1]);
        const err = Math.abs(len - amount);
        if (err > maxCornerErr) maxCornerErr = err;
        if (err > 1e-11) allCornersAmount = false;
        // Verify blue is opposite and green is zero
        if (Math.hypot(cOff.oG[0], cOff.oG[1]) > 1e-12) allCornersAmount = false;
        if (Math.hypot(cOff.oR[0] + cOff.oB[0], cOff.oR[1] + cOff.oB[1]) > 1e-12) allCornersAmount = false;
    }
    check("lateral is amount at corners", allCornersAmount, `max corner error = ${maxCornerErr}`);

    // Scale test: scale 0.5 halves offset
    const scaledCorner = offsets({ style: "lateral", amount }, 0.5, pw, ph, pw, ph);
    const scaledLen = Math.hypot(scaledCorner.oR[0], scaledCorner.oR[1]);
    check("lateral scale 0.5 halves offset", Math.abs(scaledLen - amount * 0.5) < 1e-11, `scaledLen = ${scaledLen}`);

    // Normalized coordinates corner test
    const normCorner = offsets({ style: "lateral", amount }, 1, 1, 1);
    const normLen = Math.hypot(normCorner.oR[0], normCorner.oR[1]);
    check("lateral normalized corner is amount", Math.abs(normLen - amount) < 1e-11, `normLen = ${normLen}`);
}

// -----------------------------------------------------------------------------
// 4. bilinAt at whole positions copies exactly and at (0.5, 0) gives the mean
// -----------------------------------------------------------------------------
{
    // Build a 4x4 test buffer
    const W = 4, H = 4;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const idx = (y * W + x) * 4;
            data[idx] = (x * 50) & 255;          // R varies by x: 0, 50, 100, 150
            data[idx + 1] = (y * 60) & 255;      // G varies by y: 0, 60, 120, 180
            data[idx + 2] = ((x + y) * 30) & 255;
            data[idx + 3] = 255;
        }
    }

    // Whole positions
    let wholeExact = true;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const sample = bilinAt(data, W, H, x, y);
            const idx = (y * W + x) * 4;
            const expR = data[idx] / 255;
            const expG = data[idx + 1] / 255;
            const expB = data[idx + 2] / 255;
            const expA = data[idx + 3] / 255;
            if (Math.abs(sample[0] - expR) > 1e-7 ||
                Math.abs(sample[1] - expG) > 1e-7 ||
                Math.abs(sample[2] - expB) > 1e-7 ||
                Math.abs(sample[3] - expA) > 1e-7) {
                wholeExact = false;
            }
        }
    }
    check("bilinAt at whole positions copies exactly", wholeExact);

    // At (0.5, 0): mean of (0, 0) and (1, 0)
    const midX = bilinAt(data, W, H, 0.5, 0);
    const p0 = [data[0] / 255, data[1] / 255, data[2] / 255, data[3] / 255];
    const p1 = [data[4] / 255, data[5] / 255, data[6] / 255, data[7] / 255];
    const expMidR = (p0[0] + p1[0]) * 0.5;
    const expMidG = (p0[1] + p1[1]) * 0.5;
    const expMidB = (p0[2] + p1[2]) * 0.5;
    const diffMid = Math.hypot(midX[0] - expMidR, midX[1] - expMidG, midX[2] - expMidB);
    check("bilinAt at (0.5, 0) gives the mean", diffMid < 1e-7, `diff = ${diffMid}`);

    // Boundary clamp test: (-1, -1) clamps to (0, 0)
    const clampSample = bilinAt(data, W, H, -1, -1);
    const clampDiff = Math.hypot(clampSample[0] - p0[0], clampSample[1] - p0[1], clampSample[2] - p0[2]);
    check("bilinAt clamps out of bounds coordinates", clampDiff < 1e-7);

    // Premultiplied alpha interpolation test
    const semiData = new Uint8ClampedArray(2 * 1 * 4);
    // Pixel 0: red, alpha 1.0 (255, 0, 0, 255)
    semiData[0] = 255; semiData[1] = 0; semiData[2] = 0; semiData[3] = 255;
    // Pixel 1: transparent (0, 0, 0, 0)
    semiData[4] = 0; semiData[5] = 0; semiData[6] = 0; semiData[7] = 0;

    const midAlpha = bilinAt(semiData, 2, 1, 0.5, 0);
    // Un-premultiplied color should still be red (1, 0, 0) with alpha 0.5
    check("bilinAt preserves color during premultiplied alpha blend",
        Math.abs(midAlpha[0] - 1.0) < 1e-6 && Math.abs(midAlpha[3] - 0.5) < 1e-6,
        `got [${midAlpha.map((v) => v.toFixed(3)).join(", ")}]`);
}

// -----------------------------------------------------------------------------
// 5. glassField |d| <= 1 on 100,000 samples per style
// -----------------------------------------------------------------------------
{
    const styles = ["ribbed", "reeded", "wavy", "blocks"];
    for (const style of styles) {
        let maxLen = 0;
        let withinBound = true;
        // Deterministic pseudo-random sequence
        let state = 123456789;
        const rnd = () => {
            state = (state * 1664525 + 1013904223) >>> 0;
            return state / 4294967296;
        };

        for (let i = 0; i < 100000; i++) {
            const Px = (rnd() - 0.5) * 4000;
            const Py = (rnd() - 0.5) * 4000;
            const size = 4 + rnd() * 396;
            const angle = (rnd() - 0.5) * 180;
            const seed = Math.floor(rnd() * 100);
            const [dx, dy] = glassField(style, Px, Py, size, angle, seed);
            const len = Math.hypot(dx, dy);
            if (len > maxLen) maxLen = len;
            if (len > 1.00001) {
                withinBound = false;
                break;
            }
        }
        check(`glassField ${style} |d| <= 1 on 100,000 samples`, withinBound, `max |d| = ${maxLen}`);
    }
}

// -----------------------------------------------------------------------------
// 6. ribbed d = 0 at s = k/2
// -----------------------------------------------------------------------------
{
    let allZero = true;
    let maxRibbedErr = 0;
    const angles = [-90, -45, 0, 30, 45, 60, 90];
    const sizes = [10, 40, 100, 250];

    for (const angle of angles) {
        const rad = (angle * Math.PI) / 180;
        const dirX = Math.cos(rad);
        const dirY = Math.sin(rad);

        for (const size of sizes) {
            for (let k = -20; k <= 20; k++) {
                const s = k / 2;
                const Px = s * size * dirX;
                const Py = s * size * dirY;
                const [dx, dy] = glassField("ribbed", Px, Py, size, angle, 0);
                const len = Math.hypot(dx, dy);
                if (len > maxRibbedErr) maxRibbedErr = len;
                if (len > 1e-12) allZero = false;
            }
        }
    }
    check("ribbed d = 0 at s = k/2", allZero, `max error = ${maxRibbedErr}`);
}

// -----------------------------------------------------------------------------
// 7. blocks constant inside a cell
// -----------------------------------------------------------------------------
{
    let allConstant = true;
    const angles = [-60, -30, 0, 45, 80];
    const sizes = [16, 40, 64];

    for (const angle of angles) {
        const rad = (angle * Math.PI) / 180;
        const cosA = Math.cos(rad);
        const sinA = Math.sin(rad);

        for (const size of sizes) {
            for (let cx = -5; cx <= 5; cx++) {
                for (let cy = -5; cy <= 5; cy++) {
                    const offsets = [
                        [0.05, 0.05],
                        [0.2, 0.8],
                        [0.5, 0.5],
                        [0.75, 0.25],
                        [0.95, 0.95],
                    ];
                    let baseD = null;
                    for (const [fx, fy] of offsets) {
                        const rx = (cx + fx) * size;
                        const ry = (cy + fy) * size;
                        // Transform back from rotated coordinate:
                        // rx = Px * cosA + Py * sinA
                        // ry = -Px * sinA + Py * cosA
                        // Px = rx * cosA - ry * sinA
                        // Py = rx * sinA + ry * cosA
                        const Px = rx * cosA - ry * sinA;
                        const Py = rx * sinA + ry * cosA;
                        const d = glassField("blocks", Px, Py, size, angle, 42);
                        if (!baseD) {
                            baseD = d;
                        } else {
                            if (Math.abs(d[0] - baseD[0]) > 1e-12 || Math.abs(d[1] - baseD[1]) > 1e-12) {
                                allConstant = false;
                            }
                        }
                    }
                }
            }
        }
    }
    check("blocks constant inside a cell", allConstant);
}

// -----------------------------------------------------------------------------
// 8. blocks new seed changes > 90% of cells
// -----------------------------------------------------------------------------
{
    const size = 32;
    const angle = 0;
    const seedA = 0;
    const seedB = 1;
    let diffCount = 0;
    const totalCells = 1000;

    for (let i = 0; i < totalCells; i++) {
        const cx = (i % 40) - 20;
        const cy = Math.floor(i / 40) - 12;
        const Px = (cx + 0.5) * size;
        const Py = (cy + 0.5) * size;
        const dA = glassField("blocks", Px, Py, size, angle, seedA);
        const dB = glassField("blocks", Px, Py, size, angle, seedB);
        if (Math.abs(dA[0] - dB[0]) > 1e-6 || Math.abs(dA[1] - dB[1]) > 1e-6) {
            diffCount++;
        }
    }
    const diffPct = (diffCount / totalCells) * 100;
    check("blocks new seed changes > 90% of cells", diffPct > 90, `${diffPct.toFixed(1)}% changed`);
}

// -----------------------------------------------------------------------------
// Output summary
// -----------------------------------------------------------------------------
for (const line of results) console.log(line);
if (failed > 0) {
    console.error(`\nFAILED: ${failed} checks failed`);
    process.exit(1);
} else {
    console.log(`\nALL ${results.length} checks PASS`);
}
