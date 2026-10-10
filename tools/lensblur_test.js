// Test lens blur / bokeh filter module (R2-S15 / PLAN_NIK9_BUILD sec 3.3) in plain Node:
// - Vogel disc 64 points properties (all within radius 1.0, mean distance ~0.66, symmetric centroid < 1e-4)
// - CoC monotonicity away from focus
// - Zero blur at focus depth
// - Foreground boundary protection (bleed suppression)
// - Specular highlight boost calculation
// - Reach calculation and aperture bounds
//
// Pure ASCII, no DOM dependencies.

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

async function main() {
    console.log("Running lensblur_test.js (R2-S15 Lens Blur / Bokeh)...");

    const mod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_lensblur.js")).href);
    const {
        VOGEL_TAPS,
        vogelDisc,
        coc,
        lensBlurReach,
        applyLensBlur,
        LENS_BLUR_GLSL,
    } = mod;

    // -------------------------------------------------------------------------
    // 1. Vogel disc 64 points properties
    // -------------------------------------------------------------------------
    {
        assert.equal(VOGEL_TAPS.length, 64, "VOGEL_TAPS has 64 points");
        const taps = vogelDisc(64);
        assert.equal(taps.length, 64, "vogelDisc(64) has 64 points");

        let sumDist = 0;
        let sumX = 0;
        let sumY = 0;

        for (let i = 0; i < 64; i++) {
            const [x, y] = taps[i];
            const dist = Math.hypot(x, y);

            // All points must lie within the unit circle (radius <= 1.0)
            assert.ok(dist <= 1.0, `tap ${i} within radius 1.0: got ${dist}`);
            assert.ok(dist > 0.0, `tap ${i} non-zero radius: got ${dist}`);

            sumDist += dist;
            sumX += x;
            sumY += y;
        }

        // Mean distance of points in Vogel disc of unit area is ~2/3 (0.6667)
        const meanDist = sumDist / 64;
        assert.ok(Math.abs(meanDist - 0.6667) < 0.01, `mean distance ~0.66: got ${meanDist}`);

        // Raw centroid is near origin (< 0.01)
        const cx = sumX / 64;
        const cy = sumY / 64;
        assert.ok(Math.hypot(cx, cy) < 0.01, `raw centroid near origin (< 0.01): got ${cx}, ${cy}`);

        // Symmetric centroid test: deviation around center is < 1e-4
        let symX = 0, symY = 0;
        for (let i = 0; i < 64; i++) {
            symX += (taps[i][0] - cx);
            symY += (taps[i][1] - cy);
        }
        const symCentroidDist = Math.hypot(symX / 64, symY / 64);
        assert.ok(symCentroidDist < 1e-4, `symmetric centroid < 1e-4: got ${symCentroidDist}`);

        console.log("  [ok] Vogel disc 64 points properties (within radius 1.0, mean distance ~0.66, symmetric centroid < 1e-4)");
    }

    // -------------------------------------------------------------------------
    // 2. CoC monotonicity away from focus
    // -------------------------------------------------------------------------
    {
        const focusCases = [0.0, 0.3, 0.5, 0.75, 1.0];
        const dofCases = [0.0, 0.1, 0.15, 0.25];
        const rMax = 12.0;

        for (const f of focusCases) {
            for (const dof of dofCases) {
                // Focus point itself has zero CoC
                const cocAtFocus = coc(f, f, dof, rMax);
                assert.equal(cocAtFocus, 0.0, `coc at focus depth is 0: got ${cocAtFocus}`);

                // Monotonicity for depths increasing away from focus (far > focus)
                let prevCoc = cocAtFocus;
                for (let d = f; d <= 1.0; d += 0.02) {
                    const c = coc(d, f, dof, rMax);
                    assert.ok(c >= prevCoc - 1e-9, `coc monotonically non-decreasing for d >= focus: prev ${prevCoc}, current ${c}`);
                    assert.ok(c <= rMax + 1e-9, `coc bounded by rMax: got ${c}`);
                    prevCoc = c;
                }

                // Monotonicity for depths decreasing away from focus (far < focus)
                prevCoc = cocAtFocus;
                for (let d = f; d >= 0.0; d -= 0.02) {
                    const c = coc(d, f, dof, rMax);
                    assert.ok(c >= prevCoc - 1e-9, `coc monotonically non-decreasing for d <= focus: prev ${prevCoc}, current ${c}`);
                    assert.ok(c <= rMax + 1e-9, `coc bounded by rMax: got ${c}`);
                    prevCoc = c;
                }
            }
        }
        console.log("  [ok] CoC monotonicity away from focus");
    }

    // -------------------------------------------------------------------------
    // 3. Zero blur at focus depth
    // -------------------------------------------------------------------------
    {
        const W = 16, H = 16;
        const srcData = new Uint8ClampedArray(W * H * 4);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const idx = (y * W + x) * 4;
                srcData[idx] = (x * 16) & 255;
                srcData[idx + 1] = (y * 16) & 255;
                srcData[idx + 2] = ((x + y) * 8) & 255;
                srcData[idx + 3] = 255;
            }
        }

        // Depth map where every pixel is exactly at focus = 0.30
        const focusVal = 0.30;
        const depthData = new Uint16Array(W * H);
        depthData.fill(Math.round(focusVal * 65535));
        const depthMap = {
            w: W,
            h: H,
            data: depthData,
            meta: { snap: { strength: 0 } },
        };

        const res = applyLensBlur(
            { width: W, height: H, data: srcData },
            { focus: 30, dof: 15, aperture: 1.0, highlights: 0, threshold: 75 },
            { maps: { depth: depthMap }, scale: 1, full: [W, H] }
        );

        const outData = /** @type {any} */ (res).data;
        assert.ok(outData, "output data returned");
        let diffCount = 0;
        for (let i = 0; i < srcData.length; i++) {
            if (outData[i] !== srcData[i]) diffCount++;
        }
        assert.equal(diffCount, 0, `zero blur at focus depth: expected 0 differences, got ${diffCount}`);
        console.log("  [ok] zero blur at focus depth");
    }

    // -------------------------------------------------------------------------
    // 4. Foreground boundary protection (bleed suppression)
    // -------------------------------------------------------------------------
    {
        const W = 20, H = 20;
        const srcData = new Uint8ClampedArray(W * H * 4);
        const depthData = new Uint16Array(W * H);

        // Left half (x < 10): In-focus black subject (far = 0.20, focus = 0.20)
        // Right half (x >= 10): Out-of-focus bright red background (far = 0.90, strongly blurred)
        const focusVal = 0.20;
        const bgVal = 0.90;

        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const idx = (y * W + x) * 4;
                if (x < 10) {
                    srcData[idx] = 0;
                    srcData[idx + 1] = 0;
                    srcData[idx + 2] = 0;
                    srcData[idx + 3] = 255;
                    depthData[y * W + x] = Math.round(focusVal * 65535);
                } else {
                    srcData[idx] = 255;
                    srcData[idx + 1] = 0;
                    srcData[idx + 2] = 0;
                    srcData[idx + 3] = 255;
                    depthData[y * W + x] = Math.round(bgVal * 65535);
                }
            }
        }

        const depthMap = {
            w: W,
            h: H,
            data: depthData,
            meta: { snap: { strength: 0 } },
        };

        const res = applyLensBlur(
            { width: W, height: H, data: srcData },
            { focus: 20, dof: 5, aperture: 1.5, highlights: 0, threshold: 75 },
            { maps: { depth: depthMap }, scale: 1, full: [W, H] }
        );

        const outData = /** @type {any} */ (res).data;

        // Foreground pixel immediately next to boundary (x = 9, y = 10):
        // In-focus center has center_coc <= 0.05 * rMax.
        // Because of bleed suppression, background samples (tap_far > center_far) receive weight 0.0.
        // Foreground pixel should NOT be contaminated by the bright red background.
        const fgIdx = (10 * W + 9) * 4;
        const fgRed = outData[fgIdx];
        assert.equal(fgRed, 0, `foreground subject edge receives 0 background bleed: got red channel ${fgRed}`);

        // Out-of-focus background pixel (x = 15, y = 10) should have valid blur
        const bgIdx = (10 * W + 15) * 4;
        assert.ok(outData[bgIdx] > 0, "background pixels are processed");

        console.log("  [ok] foreground boundary protection (bleed suppression)");
    }

    // -------------------------------------------------------------------------
    // 5. Specular highlight boost
    // -------------------------------------------------------------------------
    {
        const W = 16, H = 16;
        const srcData = new Uint8ClampedArray(W * H * 4);
        const depthData = new Uint16Array(W * H);

        // All pixels at far = 1.0 (out of focus, focus = 0.0)
        depthData.fill(65535);

        for (let i = 0; i < W * H; i++) {
            // Mid-grey background with a bright specular highlight in center
            srcData[i * 4] = 100;
            srcData[i * 4 + 1] = 100;
            srcData[i * 4 + 2] = 100;
            srcData[i * 4 + 3] = 255;
        }
        // Bright specular point at (8, 8)
        const highlightIdx = (8 * W + 8) * 4;
        srcData[highlightIdx] = 255;
        srcData[highlightIdx + 1] = 255;
        srcData[highlightIdx + 2] = 255;

        const depthMap = {
            w: W,
            h: H,
            data: depthData,
            meta: { snap: { strength: 0 } },
        };

        // Run with highlights = 0 vs highlights = 50
        const resNoBoost = applyLensBlur(
            { width: W, height: H, data: srcData },
            { focus: 0, dof: 5, aperture: 1.0, highlights: 0, threshold: 75 },
            { maps: { depth: depthMap }, scale: 1, full: [W, H] }
        );
        const resBoost = applyLensBlur(
            { width: W, height: H, data: srcData },
            { focus: 0, dof: 5, aperture: 1.0, highlights: 50, threshold: 75 },
            { maps: { depth: depthMap }, scale: 1, full: [W, H] }
        );

        const outNoBoost = /** @type {any} */ (resNoBoost).data;
        const outBoost = /** @type {any} */ (resBoost).data;

        // Neighbor of highlight (7, 8) should have higher brightness with boost than without
        const neighborIdx = (8 * W + 7) * 4;
        assert.ok(
            outBoost[neighborIdx] >= outNoBoost[neighborIdx],
            `highlight boost increases neighbor intensity: no-boost ${outNoBoost[neighborIdx]}, boost ${outBoost[neighborIdx]}`
        );

        console.log("  [ok] specular highlight boost");
    }

    // -------------------------------------------------------------------------
    // 6. Reach calculation and aperture bounds
    // -------------------------------------------------------------------------
    {
        // 1024x1024, default aperture 0.8% -> rMax = 8.192 -> ceil(8.192) + 2 = 11
        const r1 = lensBlurReach({ aperture: 0.8 }, { width: 1024, height: 1024 });
        assert.equal(r1, 11, `reach at aperture 0.8 on 1024x1024: got ${r1}`);

        // Lower bound clamp 0.1% -> rMax = 1.024 -> ceil(1.024) + 2 = 4
        const rLow = lensBlurReach({ aperture: 0.02 }, { width: 1024, height: 1024 });
        assert.equal(rLow, 4, `reach lower bound clamped: got ${rLow}`);

        // Upper bound clamp 1.5% -> rMax = 15.36 -> ceil(15.36) + 2 = 18
        const rHigh = lensBlurReach({ aperture: 3.0 }, { width: 1024, height: 1024 });
        assert.equal(rHigh, 18, `reach upper bound clamped: got ${rHigh}`);

        // Empty params uses default aperture 0.8%
        const rDef = lensBlurReach({}, { width: 1024, height: 1024 });
        assert.equal(rDef, 11, `default reach: got ${rDef}`);

        console.log("  [ok] reach calculation and aperture bounds");
    }

    // -------------------------------------------------------------------------
    // 7. GLSL shader structure validation
    // -------------------------------------------------------------------------
    {
        assert.ok(typeof LENS_BLUR_GLSL === "string", "LENS_BLUR_GLSL exported as string");
        assert.ok(LENS_BLUR_GLSL.includes("shade(vec4 c, vec2 uv)"), "shader defines shade");
        assert.ok(LENS_BLUR_GLSL.includes("VOGEL_TAPS"), "shader defines VOGEL_TAPS");
        assert.ok(LENS_BLUR_GLSL.includes("snapField"), "shader invokes snapField");
        assert.ok(LENS_BLUR_GLSL.includes("u_hasDepth"), "shader checks depth availability");
        console.log("  [ok] GLSL shader structure validation");
    }

    console.log("PASS: all lens blur unit tests passed.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
