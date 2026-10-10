// Test adjustment filters module (Vibrance, Gradient Map, Threshold, Posterize) in plain Node:
// - math bounds: all output channels remain in [0, 1] across parameter ranges
// - skin protection: vibrance boost is halved for skin tones where r > g && g > b
// - gradient interpolation: 2-stop, 3-stop, and 4-stop gradients interpolate correctly, reverse and opacity work
// - threshold step: sharp binary cutoff at level / 255.0 using Rec. 601 luma
// - posterize quantization: step-based quantization to exactly the specified number of levels
//
// Pure ASCII, no DOM dependencies.

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

async function main() {
    console.log("Running adjustments_test.js (Quick-Wins Adjustments)...");

    const mod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_adjustments.js")).href);
    const {
        LUMA_601,
        GRADIENT_MAP_PRESETS,
        hexToRgb,
        vibrancePixel,
        vibranceIdentity,
        vibranceUniforms,
        VIBRANCE_GLSL,
        VIBRANCE_UNIFORMS,
        sampleGradient,
        gradientMapPixel,
        gradientMapIdentity,
        gradientMapUniforms,
        GRADIENT_MAP_GLSL,
        GRADIENT_MAP_UNIFORMS,
        thresholdPixel,
        thresholdUniforms,
        THRESHOLD_GLSL,
        THRESHOLD_UNIFORMS,
        posterizePixel,
        posterizeUniforms,
        POSTERIZE_GLSL,
        POSTERIZE_UNIFORMS,
    } = mod;

    // 1. Constants and hexToRgb
    assert.deepEqual(LUMA_601, [0.299, 0.587, 0.114], "LUMA_601 matches Rec. 601");
    assert.ok(GRADIENT_MAP_PRESETS.cyberpunk, "cyberpunk preset exists");
    assert.ok(GRADIENT_MAP_PRESETS.sunset, "sunset preset exists");
    assert.ok(GRADIENT_MAP_PRESETS.teal_orange, "teal_orange preset exists");
    assert.ok(GRADIENT_MAP_PRESETS.sepia, "sepia preset exists");
    assert.ok(GRADIENT_MAP_PRESETS.infrared, "infrared preset exists");
    assert.ok(GRADIENT_MAP_PRESETS.bw_contrast, "bw_contrast preset exists");

    assert.deepEqual(hexToRgb("#ffffff"), [1, 1, 1], "hexToRgb white");
    assert.deepEqual(hexToRgb("#000000"), [0, 0, 0], "hexToRgb black");
    assert.deepEqual(hexToRgb("#ff0000"), [1, 0, 0], "hexToRgb red");
    console.log("  [ok] constants and hex conversion");

    // 2. Vibrance: identity
    assert.equal(vibranceIdentity({}), true, "empty params is identity");
    assert.equal(vibranceIdentity({ vibrance: 0, saturation: 0 }), true, "0/0 is identity");
    assert.equal(vibranceIdentity({ vibrance: 10 }), false, "vibrance 10 is not identity");
    assert.equal(vibranceIdentity({ saturation: -5 }), false, "sat -5 is not identity");

    const testColors = [
        [0.0, 0.0, 0.0],
        [1.0, 1.0, 1.0],
        [0.5, 0.5, 0.5],
        [0.8, 0.2, 0.1],
        [0.2, 0.7, 0.3],
        [0.1, 0.4, 0.9],
        [0.75, 0.55, 0.35], // skin-like
    ];

    for (const c of testColors) {
        const idPix = vibrancePixel(c[0], c[1], c[2], 0, 0);
        assert.ok(Math.abs(idPix[0] - c[0]) < 1e-9, "identity preserves red");
        assert.ok(Math.abs(idPix[1] - c[1]) < 1e-9, "identity preserves green");
        assert.ok(Math.abs(idPix[2] - c[2]) < 1e-9, "identity preserves blue");
    }
    console.log("  [ok] vibrance identity preserves input");

    // 3. Vibrance: skin protection
    // When r > g && g > b, vFactor is halved.
    // Compare skin-tone [0.8, 0.5, 0.2] with non-skin [0.2, 0.5, 0.8] having same mx, mn, sat
    const skinTone = [0.8, 0.5, 0.2]; // r > g && g > b
    const nonSkin = [0.2, 0.5, 0.8];  // r < g < b, same sat (0.6)

    // With vibrance = 80, saturation = 0:
    const skinRes = vibrancePixel(skinTone[0], skinTone[1], skinTone[2], 80, 0);
    const nonSkinRes = vibrancePixel(nonSkin[0], nonSkin[1], nonSkin[2], 80, 0);

    // Calculate expected factor for skin:
    // sat = 0.6, vAmt = 0.8, vFactor = 0.8 * (1 - 0.6) = 0.32
    // skin halves vFactor to 0.16 -> factor = 0.16
    // non-skin keeps vFactor = 0.32 -> factor = 0.32
    const skinExpectedK = 1.0 + 0.16;
    const nonSkinExpectedK = 1.0 + 0.32;

    const skinLuma = 0.299 * 0.8 + 0.587 * 0.5 + 0.114 * 0.2;
    const nonSkinLuma = 0.299 * 0.2 + 0.587 * 0.5 + 0.114 * 0.8;

    assert.ok(Math.abs(skinRes[0] - (skinLuma + (0.8 - skinLuma) * skinExpectedK)) < 1e-6, "skin protection applied");
    assert.ok(Math.abs(nonSkinRes[2] - (nonSkinLuma + (0.8 - nonSkinLuma) * nonSkinExpectedK)) < 1e-6, "non-skin full factor");
    console.log("  [ok] vibrance skin tone protection (halved boost when r > g > b)");

    // 4. Vibrance: math bounds
    for (let vib = -100; vib <= 100; vib += 50) {
        for (let sat = -100; sat <= 100; sat += 50) {
            for (const c of testColors) {
                const res = vibrancePixel(c[0], c[1], c[2], vib, sat);
                assert.ok(res[0] >= 0 && res[0] <= 1, `vibrance red bounded at vib=${vib}, sat=${sat}`);
                assert.ok(res[1] >= 0 && res[1] <= 1, `vibrance green bounded at vib=${vib}, sat=${sat}`);
                assert.ok(res[2] >= 0 && res[2] <= 1, `vibrance blue bounded at vib=${vib}, sat=${sat}`);
            }
        }
    }
    console.log("  [ok] vibrance math bounds in [0, 1]");

    // 5. Gradient Map: interpolation
    // 2-stop custom
    const stop2 = [[0, 0, 0], [1, 1, 1]];
    assert.deepEqual(sampleGradient(stop2, 0), [0, 0, 0], "2-stop at 0");
    assert.deepEqual(sampleGradient(stop2, 1), [1, 1, 1], "2-stop at 1");
    assert.deepEqual(sampleGradient(stop2, 0.5), [0.5, 0.5, 0.5], "2-stop at 0.5");

    // 3-stop cyberpunk: #051026 -> #00e5ff -> #ff0077
    const cbStops = GRADIENT_MAP_PRESETS.cyberpunk.map(hexToRgb);
    assert.deepEqual(sampleGradient(cbStops, 0), cbStops[0], "3-stop at 0");
    assert.deepEqual(sampleGradient(cbStops, 0.5), cbStops[1], "3-stop at 0.5");
    assert.deepEqual(sampleGradient(cbStops, 1), cbStops[2], "3-stop at 1");

    const cbQuarter = sampleGradient(cbStops, 0.25);
    const cbExpectedMid01 = [
        cbStops[0][0] * 0.5 + cbStops[1][0] * 0.5,
        cbStops[0][1] * 0.5 + cbStops[1][1] * 0.5,
        cbStops[0][2] * 0.5 + cbStops[1][2] * 0.5,
    ];
    assert.ok(Math.abs(cbQuarter[0] - cbExpectedMid01[0]) < 1e-6, "3-stop quarter red");
    assert.ok(Math.abs(cbQuarter[1] - cbExpectedMid01[1]) < 1e-6, "3-stop quarter green");
    assert.ok(Math.abs(cbQuarter[2] - cbExpectedMid01[2]) < 1e-6, "3-stop quarter blue");

    // 4-stop sunset
    const sunsetStops = GRADIENT_MAP_PRESETS.sunset.map(hexToRgb);
    assert.deepEqual(sampleGradient(sunsetStops, 0), sunsetStops[0], "4-stop at 0");
    assert.ok(Math.abs(sampleGradient(sunsetStops, 1 / 3)[0] - sunsetStops[1][0]) < 1e-6, "4-stop at 1/3");
    assert.ok(Math.abs(sampleGradient(sunsetStops, 2 / 3)[0] - sunsetStops[2][0]) < 1e-6, "4-stop at 2/3");
    assert.deepEqual(sampleGradient(sunsetStops, 1), sunsetStops[3], "4-stop at 1");

    // Reverse test
    const fwd = gradientMapPixel(0, 0, 0, { preset: "custom", shadow: "#000000", highlight: "#ffffff", reverse: false });
    const rev = gradientMapPixel(0, 0, 0, { preset: "custom", shadow: "#000000", highlight: "#ffffff", reverse: true });
    assert.deepEqual(fwd, [0, 0, 0], "custom fwd at black gives shadow");
    assert.deepEqual(rev, [1, 1, 1], "custom rev at black gives highlight");

    // Opacity test
    const halfOp = gradientMapPixel(0, 0, 0, { preset: "custom", shadow: "#ffffff", highlight: "#ffffff", opacity: 50 });
    assert.deepEqual(halfOp, [0.5, 0.5, 0.5], "opacity 50 mixes 50/50");

    assert.equal(gradientMapIdentity({ opacity: 0 }), true, "opacity 0 is identity");
    assert.equal(gradientMapIdentity({ opacity: 100 }), false, "opacity 100 is not identity");
    console.log("  [ok] gradient map interpolation, reverse, and opacity");

    // 6. Threshold step
    const lvl128 = 128;
    const threshVal = 128 / 255.0;

    // Pure green luma = 0.587 >= 128/255 -> 1.0
    const greenThresh = thresholdPixel(0, 1, 0, lvl128);
    assert.deepEqual(greenThresh, [1, 1, 1], "green (luma 0.587) >= threshold 128/255");

    // Pure blue luma = 0.114 < 128/255 -> 0.0
    const blueThresh = thresholdPixel(0, 0, 1, lvl128);
    assert.deepEqual(blueThresh, [0, 0, 0], "blue (luma 0.114) < threshold 128/255");

    // Pixel just below threshold vs just above
    const justBelow = thresholdPixel((threshVal - 0.001) / 0.299, 0, 0, lvl128);
    const justAbove = thresholdPixel((threshVal + 0.001) / 0.299, 0, 0, lvl128);
    assert.deepEqual(justBelow, [0, 0, 0], "just below threshold");
    assert.deepEqual(justAbove, [1, 1, 1], "just above threshold");
    console.log("  [ok] threshold step and Rec. 601 luma discrimination");

    // 7. Posterize quantization
    // 4 levels -> step = 3 -> values 0, 1/3, 2/3, 1
    const pLevels4 = [
        [0.0, 0.0],
        [0.1, 0.0],          // 0.1 * 3 + 0.5 = 0.8 -> floor 0 / 3 = 0
        [0.2, 1.0 / 3.0],    // 0.2 * 3 + 0.5 = 1.1 -> floor 1 / 3 = 0.333...
        [0.5, 2.0 / 3.0],    // 0.5 * 3 + 0.5 = 2.0 -> floor 2 / 3 = 0.666...
        [0.8, 2.0 / 3.0],    // 0.8 * 3 + 0.5 = 2.9 -> floor 2 / 3 = 0.666...
        [0.9, 1.0],          // 0.9 * 3 + 0.5 = 3.2 -> floor 3 / 3 = 1
        [1.0, 1.0],
    ];

    for (const [input, expected] of pLevels4) {
        const out = posterizePixel(input, input, input, 4);
        assert.ok(Math.abs(out[0] - expected) < 1e-6, `posterize(4) for ${input}: got ${out[0]}, expected ${expected}`);
    }

    // 2 levels -> step = 1 -> values 0, 1
    assert.deepEqual(posterizePixel(0.3, 0.3, 0.3, 2), [0, 0, 0], "posterize(2) 0.3 -> 0");
    assert.deepEqual(posterizePixel(0.7, 0.7, 0.7, 2), [1, 1, 1], "posterize(2) 0.7 -> 1");

    // Bounds checking for posterize levels parameter clamp 2..32
    const u1 = posterizeUniforms({ levels: 1 });
    assert.equal(u1.u_levels, 2, "levels clamped to min 2");
    const u50 = posterizeUniforms({ levels: 50 });
    assert.equal(u50.u_levels, 32, "levels clamped to max 32");

    console.log("  [ok] posterize quantization and levels bounds");

    // 8. Uniform definitions and GLSL code presence
    assert.ok(VIBRANCE_GLSL.includes("shade(vec4 c, vec2 uv)"), "VIBRANCE_GLSL defines shade");
    assert.ok(GRADIENT_MAP_GLSL.includes("shade(vec4 c, vec2 uv)"), "GRADIENT_MAP_GLSL defines shade");
    assert.ok(THRESHOLD_GLSL.includes("shade(vec4 c, vec2 uv)"), "THRESHOLD_GLSL defines shade");
    assert.ok(POSTERIZE_GLSL.includes("shade(vec4 c, vec2 uv)"), "POSTERIZE_GLSL defines shade");

    assert.ok(VIBRANCE_UNIFORMS.u_vibrance === "float");
    assert.ok(GRADIENT_MAP_UNIFORMS.u_opacity === "float");
    assert.ok(THRESHOLD_UNIFORMS.u_level === "float");
    assert.ok(POSTERIZE_UNIFORMS.u_levels === "float");

    const vu = vibranceUniforms({ vibrance: 25, saturation: -10 });
    assert.equal(vu.u_vibrance, 25, "vibrance uniforms vibrance");
    assert.equal(vu.u_saturation, -10, "vibrance uniforms saturation");

    const gmu = gradientMapUniforms({ preset: "cyberpunk", opacity: 75, reverse: true });
    assert.equal(gmu.u_opacity, 75, "gradient map uniforms opacity");
    assert.equal(gmu.u_reverse, true, "gradient map uniforms reverse");
    assert.equal(gmu.u_numStops, 3, "gradient map uniforms numStops");

    const tu = thresholdUniforms({ level: 200 });
    assert.equal(tu.u_level, 200, "threshold uniforms level");
    console.log("  [ok] GLSL shader twins and uniform signatures");

    console.log("PASS");
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
