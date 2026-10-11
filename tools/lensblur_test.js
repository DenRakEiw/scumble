// Test lens blur / bokeh filter module (R2-S15 / PLAN_NIK9_BUILD sec 3.3) in plain Node:
// - Vogel disc 64 points properties (all within radius 1.0, mean distance ~0.66, symmetric centroid < 1e-4)
// - CoC monotonicity away from focus
// - Zero blur at focus depth
// - Foreground boundary protection (bleed suppression)
// - Specular highlight boost calculation
// - Reach calculation and aperture bounds
// - The radius is the same in document pixels at every pass scale (info.full is in the input's pixels already)
// - A blurred foreground over an in-focus background falls off softly (the centre counts as a self tap)
// - The centre's weight: 1 in focus against 1/64 per tap spread over the whole disc
// - Premultiplied averaging: transparent neighbours do not darken opaque pixels, the alpha is blurred
// - A subject edge just out of focus is not eaten by the background (the in-focus test is a ramp)
// - The reach holds the radius at every pass scale
// - The GL twins of haze, dehaze and lens blur are registered when the modules load in the app's order
//
// Pure ASCII, no DOM dependencies (section 13 stands a recording stub in for document and WebGL2).

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

async function main() {
    console.log("Running lensblur_test.js (R2-S15 Lens Blur / Bokeh)...");

    // The app's order: inpaint_filters.js (and through it inpaint_filters_gl.js) loads before the depth filters'
    // modules, the order in which their GL twins' registration failed inside the import cycle (section 13).
    const editorUrl = (name) => pathToFileURL(path.join(ROOT, "renderer", "editor", name)).href;
    await import(editorUrl("inpaint_filters.js"));
    const GL = await import(editorUrl("inpaint_filters_gl.js"));
    const mod = await import(editorUrl("inpaint_lensblur.js"));
    const {
        VOGEL_TAPS,
        vogelDisc,
        coc,
        lensBlurReach,
        lensRadius,
        LENS_CELL,
        LENS_RAMP,
        LENS_BEHIND_EPS,
        applyLensBlur,
        LENS_BLUR_GLSL,
    } = mod;

    // A W x H picture from rgba(x, y) -> [r, g, b, a], a depth map at the picture's size from far(x, y) (0..1,
    // no transform: the map maps onto info.full), and one row of a result as [r, a] pairs.
    const picture = (W, H, rgba) => {
        const data = new Uint8ClampedArray(W * H * 4);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) data.set(rgba(x, y), (y * W + x) * 4);
        }
        return { width: W, height: H, data };
    };
    const depthOf = (W, H, far) => {
        const data = new Uint16Array(W * H);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) data[y * W + x] = Math.round(far(x, y) * 65535);
        }
        return { w: W, h: H, data, meta: { snap: { strength: 0 } } };
    };
    const rowOf = (res, W, y) => {
        const d = /** @type {any} */ (res).data, r = [], a = [];
        for (let x = 0; x < W; x++) { r.push(d[(y * W + x) * 4]); a.push(d[(y * W + x) * 4 + 3]); }
        return { r, a };
    };

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
        // the twin's rules, kept in step with applyLensBlur: the self tap, the weights, the ramp, premultiplied sums
        assert.ok(LENS_BLUR_GLSL.includes(`u_rMax * ${LENS_CELL.toFixed(4)}`), "shader uses LENS_CELL");
        assert.ok(LENS_BLUR_GLSL.includes(`w_sstep(${LENS_RAMP[0].toFixed(4)} * u_rMax, ${LENS_RAMP[1].toFixed(4)} * u_rMax, center_coc)`), "shader uses LENS_RAMP");
        assert.ok(LENS_BLUR_GLSL.includes("float w0 = lensWeight(center_coc, cell) * lensBoost(c.rgb);"), "shader counts the centre as a self tap");
        assert.ok(LENS_BLUR_GLSL.includes("lensWeight(max(tap_coc, center_coc), cell)"), "shader caps a tap at the centre's share");
        assert.ok(LENS_BLUR_GLSL.includes("if (tap_coc < deltaLen) continue;"), "shader keeps the scatter-as-gather rule");
        assert.ok(LENS_BLUR_GLSL.includes("vec2 tap_uv = uv + floor(delta + 0.5) / u_size;"), "shader reads whole-pixel offsets, as the CPU twin's Math.round");
        assert.ok(LENS_BLUR_GLSL.includes(`if (tap_far > center_far + ${LENS_BEHIND_EPS.toFixed(6)}) weight *= behind;`), "shader uses LENS_BEHIND_EPS");
        assert.ok(LENS_BLUR_GLSL.includes("sumC += tap_c.rgb * wa;") && LENS_BLUR_GLSL.includes("return vec4(rgb, sumA / sumW);"), "shader averages premultiplied and blurs the alpha");
        assert.ok(!/u_rMax[^;\n]*u_scale|u_scale[^;\n]*u_rMax/.test(LENS_BLUR_GLSL), "shader does not scale the radius again");
        assert.ok(!/[^\x00-\x7F]/.test(LENS_BLUR_GLSL), "shader source is pure ASCII");
        console.log("  [ok] GLSL shader structure validation");
    }

    // -------------------------------------------------------------------------
    // 8. The same blur in document pixels at every pass scale
    // -------------------------------------------------------------------------
    {
        // A step edge, blurred everywhere (far 1, focus 0: coc = rMax). A pass at scale s gets the picture at s and
        // info.full in its own pixels; the blur's spread, measured in document pixels, must not depend on s (it was
        // scale^2 when the radius was multiplied by info.scale once more).
        const DW = 1600, DH = 16;
        const params = { focus: 0, dof: 0, aperture: 1.5, highlights: 0, threshold: 75 };
        const R = DW * 1.5 / 100;   // 24 document pixels
        const flat = depthOf(4, 4, () => 1);
        const spreadAt = (s) => {
            const W = Math.round(DW * s), H = Math.max(1, Math.round(DH * s));
            const src = picture(W, H, (x) => (x >= W / 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
            const res = applyLensBlur(src, params, { maps: { depth: flat }, scale: s, full: [W, H], origin: [0, 0] });
            const { r } = rowOf(res, W, H >> 1);
            let e = 0, first = -1, last = -1;
            for (let x = 0; x < W; x++) {
                const ref = x >= W / 2 ? 255 : 0;
                e += Math.abs(r[x] - ref) / 255;
                if (r[x] !== ref) { if (first < 0) first = x; last = x; }
            }
            return { spread: e / s, left: (W / 2 - first) / s, right: (last + 1 - W / 2) / s };
        };
        const ref = spreadAt(1);
        // a uniform disc of radius R spreads a step by 2 R * 2 / (3 pi) = 0.424 R in total
        assert.ok(Math.abs(ref.spread - 0.4244 * R) <= 1.0, `scale 1 spread ~0.424 R = ${(0.4244 * R).toFixed(2)}: got ${ref.spread}`);
        for (const s of [0.25, 0.5, 2]) {
            const got = spreadAt(s);
            assert.ok(Math.abs(got.spread - ref.spread) <= 0.1 * ref.spread,
                `scale ${s} spreads as far as scale 1 in document pixels: ${got.spread.toFixed(2)} vs ${ref.spread.toFixed(2)}`);
            for (const side of [got.left, got.right]) {
                assert.ok(side <= R + 1 / s + 0.5 && side >= R - 3, `scale ${s}: the blur reaches ~${R} document pixels: got ${side}`);
            }
        }
        console.log("  [ok] the same blur in document pixels at scale 0.25, 0.5, 1 and 2");
    }

    // -------------------------------------------------------------------------
    // 9. A blurred foreground over an in-focus background falls off softly
    // -------------------------------------------------------------------------
    {
        // White foreground (far 0) left of x = 500, black background in focus (far 1, focus 100) to the right,
        // rMax = 15. A background pixel keeps itself as the self tap (weight 1) and takes the foreground's taps at
        // 1/64 each: about a third at the edge, down to nothing at rMax, without the old opaque band and hard step.
        const W = 1000, H = 8, E = 500, rMax = 15;
        const src = picture(W, H, (x) => (x < E ? [255, 255, 255, 255] : [0, 0, 0, 255]));
        const depth = depthOf(W, 1, (x) => (x < E ? 0 : 1));
        const res = applyLensBlur(src, { focus: 100, dof: 0, aperture: 1.5, highlights: 0 }, { maps: { depth }, scale: 1, full: [W, H] });
        const { r } = rowOf(res, W, H >> 1);
        assert.ok(r[E - 1] >= 245, `the blurred foreground keeps its colour at its edge: got ${r[E - 1]}`);
        // where the map interpolates the depth edge a tap reads a sharper depth than the blurred centre; capped at
        // the centre's own share it does not draw a dark line into the foreground
        for (let x = E - rMax; x < E; x++) assert.ok(r[x] >= 240, `no dark line inside the blurred foreground at x = ${x}: got ${r[x]}`);
        assert.ok(r[E] >= 0.15 * 255 && r[E] <= 0.5 * 255, `the first background pixel blends (15..50 % foreground): got ${r[E]}`);
        for (let x = E; x < E + rMax; x++) {
            assert.ok(r[x + 1] <= r[x] + 8, `the falloff does not climb at x = ${x + 1}: ${r[x]} -> ${r[x + 1]}`);
            assert.ok(r[x] - r[x + 1] <= 40, `no hard step at x = ${x + 1}: ${r[x]} -> ${r[x + 1]}`);
        }
        for (let x = E + rMax + 1; x < E + rMax + 8; x++) assert.equal(r[x], 0, `nothing past rMax at x = ${x}`);
        // the same edge with the depth ramping over 4 pixels (as an upscaled map does): the ramp's sharper depths
        // weigh no more than the blurred centre's own share, so the foreground gets no darker band before the ramp
        const ramp = depthOf(W, 1, (x) => Math.max(0, Math.min(1, (x + 0.5 - E) / 4 + 0.5)));
        const rr = rowOf(applyLensBlur(src, { focus: 100, dof: 0, aperture: 1.5, highlights: 0 }, { maps: { depth: ramp }, scale: 1, full: [W, H] }), W, H >> 1).r;
        for (let x = E - rMax; x < E - 2; x++) assert.ok(rr[x] >= 240, `no darker band before a ramped depth edge at x = ${x}: got ${rr[x]}`);
        console.log("  [ok] a blurred foreground over an in-focus background falls off softly");
    }

    // -------------------------------------------------------------------------
    // 10. The centre's weight
    // -------------------------------------------------------------------------
    {
        const W = 1000, H = 40, cx = 500, cy = 20;   // rMax = 15; no tap rounds onto the centre pixel
        // (a) an in-focus pixel inside a blurred foreground that covers the whole disc: itself (1) against 64 taps
        // at 1/64 each, half and half (it was replaced completely)
        {
            const src = picture(W, H, (x, y) => (x === cx && y === cy ? [0, 0, 0, 255] : [255, 0, 0, 255]));
            const depth = depthOf(W, H, (x, y) => (x === cx && y === cy ? 1 : 0));
            const res = applyLensBlur(src, { focus: 100, dof: 0, aperture: 1.5, highlights: 0 }, { maps: { depth }, scale: 1, full: [W, H] });
            const v = /** @type {any} */ (res).data[(cy * W + cx) * 4];
            assert.ok(Math.abs(v - 127.5) <= 3, `an in-focus centre under a blurred foreground keeps half: got ${v}`);
        }
        // (b) a blurred pixel inside a uniformly blurred area: itself and the 64 taps alike, 1/65 each (it did not count)
        {
            const src = picture(W, H, (x, y) => (x === cx && y === cy ? [255, 255, 255, 255] : [0, 0, 0, 255]));
            const depth = depthOf(4, 4, () => 1);
            const res = applyLensBlur(src, { focus: 0, dof: 0, aperture: 1.5, highlights: 0 }, { maps: { depth }, scale: 1, full: [W, H] });
            const v = /** @type {any} */ (res).data[(cy * W + cx) * 4];
            assert.equal(v, Math.round(255 / 65), `a blurred centre counts once among 65 samples: got ${v}`);
        }
        // (c) the same at a smaller blur: coc 0.3 rMax everywhere reaches the 6 taps within 0.3 rMax, and each of
        // them weighs what the centre weighs, so the centre is one of 7 equal samples
        {
            const src = picture(W, H, (x, y) => (x === cx && y === cy ? [255, 255, 255, 255] : [0, 0, 0, 255]));
            const depth = depthOf(4, 4, () => 1);
            const res = applyLensBlur(src, { focus: 70, dof: 0, aperture: 1.5, highlights: 0 }, { maps: { depth }, scale: 1, full: [W, H] });
            const v = /** @type {any} */ (res).data[(cy * W + cx) * 4];
            assert.equal(v, Math.round(255 / 7), `at coc 0.3 rMax the centre is one of 7 equal samples: got ${v}`);
        }
        console.log("  [ok] the centre counts: 1 in focus, 1/64 when spread over the whole disc");
    }

    // -------------------------------------------------------------------------
    // 11. Premultiplied averaging: no dark fringe, the alpha is blurred
    // -------------------------------------------------------------------------
    {
        // transparent (0, 0, 0, 0) left of x = 500 and opaque white to the right, all blurred (rMax = 15)
        const W = 1000, H = 8, E = 500;
        const src = picture(W, H, (x) => (x < E ? [0, 0, 0, 0] : [255, 255, 255, 255]));
        const depth = depthOf(4, 4, () => 1);
        const res = applyLensBlur(src, { focus: 0, dof: 0, aperture: 1.5, highlights: 0 }, { maps: { depth }, scale: 1, full: [W, H] });
        const { r, a } = rowOf(res, W, H >> 1);
        for (let x = E - 20; x < E + 20; x++) {
            if (a[x] > 0) assert.equal(r[x], 255, `no dark fringe from transparent taps at x = ${x}: got ${r[x]} (alpha ${a[x]})`);
        }
        assert.ok(a[E] > 100 && a[E] < 200, `the alpha is blurred at the edge: got ${a[E]}`);
        assert.ok(a[E - 1] > 50 && a[E - 1] < 160, `the alpha spreads over the transparent side: got ${a[E - 1]}`);
        for (let x = E - 16; x < E + 16; x++) assert.ok(a[x + 1] >= a[x], `the alpha climbs across the edge at x = ${x + 1}: ${a[x]} -> ${a[x + 1]}`);
        assert.equal(a[E - 17], 0, "fully transparent beyond rMax");
        assert.equal(a[E + 17], 255, "fully opaque beyond rMax");
        console.log("  [ok] premultiplied averaging: transparent taps add no black, the alpha is blurred");
    }

    // -------------------------------------------------------------------------
    // 12. A subject edge just out of focus is not eaten by the background
    // -------------------------------------------------------------------------
    {
        // A black subject left of x = 500 with a white background far behind it (far 1, coc 0.7 rMax). At coc
        // 0.08 rMax (above the old 0.05 rMax cut) the background's taps fade in along the ramp instead of
        // replacing the subject's edge; in focus (coc 0) the subject takes nothing from behind at all.
        const W = 1000, H = 8, E = 500;
        const src = picture(W, H, (x) => (x < E ? [0, 0, 0, 255] : [255, 255, 255, 255]));
        const params = { focus: 30, dof: 0, aperture: 1.5, highlights: 0 };
        const soft = applyLensBlur(src, params, { maps: { depth: depthOf(W, 1, (x) => (x < E ? 0.38 : 1.0)) }, scale: 1, full: [W, H] });
        const sharp = applyLensBlur(src, params, { maps: { depth: depthOf(W, 1, (x) => (x < E ? 0.30 : 1.0)) }, scale: 1, full: [W, H] });
        const rs = rowOf(soft, W, H >> 1).r, r0 = rowOf(sharp, W, H >> 1).r;
        for (let x = E - 10; x < E; x++) {
            assert.ok(rs[x] <= 64, `subject pixel x = ${x} at coc 0.08 rMax keeps its colour: got ${rs[x]}`);
            assert.equal(r0[x], 0, `subject pixel x = ${x} in focus takes nothing from behind: got ${r0[x]}`);
        }
        console.log("  [ok] a subject edge just out of focus is not eaten (the in-focus test is a ramp)");
    }

    // -------------------------------------------------------------------------
    // 13. The reach holds the radius at every pass scale
    // -------------------------------------------------------------------------
    {
        // lensBlurReach is in document pixels; a pass at scale s pads reach * s of its own pixels, and its radius
        // is lensRadius(params, info.full) with info.full = the document at s. The farthest tap sits at 0.996 rMax
        // and rounds to the nearest pixel (+0.5), which the reach's +2 covers from scale 0.25 up.
        for (const [DW, DH] of [[1024, 768], [600, 4000], [15000, 10000]]) {
            for (const ap of [0.1, 0.8, 1.5]) {
                const reach = lensBlurReach({ aperture: ap }, { width: DW, height: DH });
                for (const s of [0.1, 0.25, 0.5, 1, 2, 4]) {
                    const rMax = lensRadius({ aperture: ap }, [DW * s, DH * s]);
                    const need = rMax + (s >= 0.25 ? 0.5 : 0);
                    assert.ok(reach * s >= need, `${DW}x${DH} aperture ${ap} scale ${s}: reach ${reach} * ${s} >= ${need.toFixed(3)}`);
                }
            }
        }
        console.log("  [ok] the reach holds the radius at every pass scale");
    }

    // -------------------------------------------------------------------------
    // 14. The GL twins of haze, dehaze and lens blur are registered
    // -------------------------------------------------------------------------
    {
        // The modules were loaded in the app's order (inpaint_filters.js first). A recording stand-in for document
        // and WebGL2 lets applyFilterGL run as far as compiling and drawing: a twin that never registered returns
        // null at once (registerHazeGL / registerLensBlurGL used to set their flag before registerGLFilter threw
        // inside the import cycle, so the CPU path ran instead: 70-96 s per 24 MP lens blur pass).
        const { makeMap } = await import(editorUrl("inpaint_maps.js"));
        const sources = [];
        const consts = new Map();
        const constOf = (name) => {
            if (name === "NO_ERROR") return 0;
            if (!consts.has(name)) consts.set(name, 0x8000 + consts.size);
            return consts.get(name);
        };
        const nothing = () => ({});
        const special = {
            shaderSource: (_, src) => { sources.push(src); },
            getShaderParameter: () => true,
            getProgramParameter: () => true,
            getError: () => 0,
            isContextLost: () => false,
            getParameter: (p) => (p === constOf("MAX_VIEWPORT_DIMS") ? [16384, 16384] : 16384),
            drawingBufferWidth: 4096,
            drawingBufferHeight: 4096,
        };
        const gl = new Proxy({}, { get: (_, k) => (k in special ? special[k] : typeof k === "string" && /^[A-Z0-9_]+$/.test(k) ? constOf(k) : nothing) });
        const ctx2d = new Proxy({}, { get: () => nothing });
        const canvas = () => ({ width: 1, height: 1, getContext: (kind) => (kind === "webgl2" ? gl : ctx2d), addEventListener() {} });
        const hadDocument = "document" in globalThis, prevDocument = globalThis.document;
        globalThis.document = { createElement: canvas };
        try {
            const W = 16, H = 16;
            const src = canvas();
            src.width = W;
            src.height = H;
            const depth = makeMap("depth", 4, 4, new Uint16Array(16).fill(40000), [W, 0, 0, H, 0, 0], { snap: { strength: 0 } });
            const info = { maps: { depth }, scale: 1, full: [W * 64, H * 64], origin: [0, 0] };
            const cases = [
                ["haze", { amount: 50 }, "u_desat"],
                ["dehaze", { amount: 50, mode: "depth" }, "u_protect"],
                ["lens_blur", { aperture: 1.0 }, "lensWeight("],
            ];
            for (const [id, params, marker] of cases) {
                const before = sources.length;
                const out = GL.applyFilterGL(id, src, params, info);
                assert.ok(out, `applyFilterGL("${id}") runs the GL twin: it returned null (the twin is not registered)`);
                assert.ok(sources.slice(before).some((s) => s.includes(marker)), `applyFilterGL("${id}") compiled its own shader`);
            }
        } finally {
            if (hadDocument) globalThis.document = prevDocument;
            else delete globalThis.document;
        }
        console.log("  [ok] the GL twins of haze, dehaze and lens blur are registered (modules loaded in the app's order)");
    }

    console.log("PASS: all lens blur unit tests passed.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
