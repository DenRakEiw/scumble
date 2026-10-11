// Test adjustment filters module (Vibrance, Gradient Map, Threshold, Posterize) in plain Node:
// - math bounds: all output channels remain in [0, 1] across parameter ranges
// - skin protection: vibrance boost is halved for skin tones where r > g > b, the share rising smoothly over
//   SKIN_SOFT from r == g and g == b (no contour where a ramp crosses either border); greys stay bit-identical
// - gradient interpolation: 2-stop, 3-stop, and 4-stop gradients interpolate correctly, reverse and opacity work;
//   an Opacity or Reverse change through add_filter / set_filter keeps the preset; the preset select has its own title
// - threshold step: binary cutoff at the level on Rec. 601 luma, grey == level white for every level on the CPU
//   path and in a float32 emulation of the GLSL, both agreeing with the integer rule at every boundary byte triple
// - posterize quantization: step-based quantization to exactly the specified number of levels, a fractional level
//   giving the same picture from the GLSL formula as from the CPU path
//
// The CPU twins run on a stand-in canvas (FakeCanvas); the commands path on a stand-in editor. Pure ASCII.

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

// A canvas holding RGBA bytes: enough for the CPU twins, which draw a same-size source at 0, 0, read and put back.
// Its bytes follow width and height, as a canvas made by document.createElement gets its size after it is made.
class FakeCanvas {
    constructor(w = 1, h = 1) {
        this._w = w;
        this._h = h;
        this.data = new Uint8ClampedArray(w * h * 4);
    }
    get width() { return this._w; }
    set width(v) { this._w = v; this.data = new Uint8ClampedArray(this._w * this._h * 4); }
    get height() { return this._h; }
    set height(v) { this._h = v; this.data = new Uint8ClampedArray(this._w * this._h * 4); }
    getContext() {
        const c = this;
        return {
            drawImage(src) { c.data.set(src.data); },
            getImageData(x, y, w, h) { return { width: w, height: h, data: new Uint8ClampedArray(c.data) }; },
            putImageData(img) { c.data.set(img.data); },
        };
    }
}

// Minimal browser globals for importing renderer modules (commands.js) in Node, as plugin_api4_test.js sets them
global.window = {
    devicePixelRatio: 1,
    scumble: {
        comfy: { onEvent: () => {} },
        helpers: { status: async () => ({ models: [] }) },
        log: { list: async () => [], file: async () => "" },
        plugins: { list: async () => [] },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
};
global.document = {
    createElement: (tag) => (String(tag).toLowerCase() === "canvas" ? new FakeCanvas() : {
        tagName: String(tag).toUpperCase(),
        style: {},
        classList: { add: () => {}, remove: () => {} },
        appendChild: () => {},
        addEventListener: () => {},
    }),
    getElementById: () => null,
    head: { appendChild: () => {} },
};

/** A one-row canvas of [r, g, b] bytes (opaque). */
function canvasOf(pixels) {
    const c = new FakeCanvas(pixels.length, 1);
    for (let i = 0; i < pixels.length; i++) {
        c.data[i * 4] = pixels[i][0];
        c.data[i * 4 + 1] = pixels[i][1];
        c.data[i * 4 + 2] = pixels[i][2];
        c.data[i * 4 + 3] = 255;
    }
    return c;
}

/** The pixel at index i of a canvas as [r, g, b]. */
function px(c, i) {
    return [c.data[i * 4], c.data[i * 4 + 1], c.data[i * 4 + 2]];
}

// float32 emulation of the GLSL twins: inputs as a unorm8 texture gives them, every operation rounded to float32;
// the dot product either as three products and two sums, or fused (one rounding), as drivers differ
const f = Math.fround;
function glDot(w, r, g, b, fused) {
    if (fused) return f(w[0] * r + w[1] * g + w[2] * b);
    return f(f(f(w[0] * r) + f(w[1] * g)) + f(w[2] * b));
}
function glSmooth(e0, e1, x) {
    const t = f(Math.max(0, Math.min(1, f(f(x - e0) / f(e1 - e0)))));
    return f(f(t * t) * f(3 - f(2 * t)));
}
function toByte(v) {
    return Math.round(Math.max(0, Math.min(1, v)) * 255);
}

async function main() {
    console.log("Running adjustments_test.js (Quick-Wins Adjustments)...");

    const mod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_adjustments.js")).href);
    const {
        LUMA_601,
        GRADIENT_MAP_PRESETS,
        hexToRgb,
        SKIN_SOFT,
        vibranceSkinWeight,
        applyVibrance,
        THRESHOLD_EPS,
        applyThreshold,
        applyPosterize,
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
    // When r > g > b by SKIN_SOFT or more, vFactor is halved.
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

    // 3b. Vibrance: the protection is a smooth weight, so a ramp crossing r == g or g == b gets no contour
    assert.equal(SKIN_SOFT, 0.1, "skin protection width");
    for (let v = 0; v <= 255; v += 15) assert.equal(vibranceSkinWeight(v / 255, v / 255, v / 255), 0, `grey ${v} has no skin weight`);
    assert.equal(vibranceSkinWeight(0.6, 0.6, 0.2), 0, "r == g: no skin weight");
    assert.equal(vibranceSkinWeight(0.6, 0.4, 0.4), 0, "g == b: no skin weight");
    assert.equal(vibranceSkinWeight(0.8, 0.5, 0.2), 1, "r > g > b by more than SKIN_SOFT: full weight");
    {
        let prev = -1;
        for (let d = 0; d <= 30; d++) {
            const w = vibranceSkinWeight(0.5 + d / 255, 0.5, 0.2);
            assert.ok(w >= prev && w >= 0 && w <= 1, `skin weight rises monotonically (r - g = ${d} levels)`);
            prev = w;
        }
        assert.ok(vibranceSkinWeight(0.5 + 1 / 255, 0.5, 0.2) < 0.03, "one level past r == g weighs almost nothing");
    }
    // every 1-level step across r == g ((x, x, y) -> (x + 1, x, y)) and across g == b ((y, x, x) -> (y, x + 1, x)),
    // through the CPU twin: no channel moves by more than 2 levels (the hard switch moved one by 28 at vibrance 100)
    {
        const pairs = [];
        for (let x = 0; x < 255; x++) for (let y = 0; y < 256; y++) {
            pairs.push([x, x, y], [x + 1, x, y]);
            pairs.push([y, x, x], [y, x + 1, x]);
        }
        const src = canvasOf(pairs);
        for (const vib of [100, 50, 30, -50, -100]) {
            const out = applyVibrance(src, { vibrance: vib, saturation: 0 });
            let worst = 0, at = null;
            for (let i = 0; i < pairs.length; i += 2) {
                const a = px(out, i), b = px(out, i + 1);
                for (let ch = 0; ch < 3; ch++) {
                    const d = Math.abs(a[ch] - b[ch]);
                    if (d > worst) { worst = d; at = [pairs[i], pairs[i + 1], a, b]; }
                }
            }
            assert.ok(worst <= 2, `vibrance ${vib}: a 1-level step across r == g or g == b moves a channel by ${worst} (${JSON.stringify(at)})`);
        }
        // the same pairs catch the hard switch (a copy of the old rule, so the check above is not vacuous)
        const hard = (c, vib) => {
            const [r, g, b] = c.map((v) => v / 255);
            const luma = LUMA_601[0] * r + LUMA_601[1] * g + LUMA_601[2] * b;
            const sat = Math.max(r, g, b) - Math.min(r, g, b);
            let vf = (vib / 100) * (1 - sat);
            if (r > g && g > b) vf *= 0.5;
            const k = 1 + Math.max(-1, Math.min(3, vf));
            return [r, g, b].map((v) => toByte(luma + (v - luma) * k));
        };
        let hardWorst = 0;
        for (let i = 0; i < pairs.length; i += 2) {
            const a = hard(pairs[i], 100), b = hard(pairs[i + 1], 100);
            for (let ch = 0; ch < 3; ch++) hardWorst = Math.max(hardWorst, Math.abs(a[ch] - b[ch]));
        }
        assert.ok(hardWorst > 10, `the hard switch shows on these pairs (${hardWorst})`);
    }
    // neutral greys stay bit-identical at any setting; vibrance 0 / saturation 0 leaves every byte as it was
    {
        const greys = [];
        for (let v = 0; v < 256; v++) greys.push([v, v, v]);
        const src = canvasOf(greys);
        for (const [vib, sat] of [[100, 0], [-100, 0], [0, 100], [0, -100], [100, 100], [-100, -100], [37, -63]]) {
            const out = applyVibrance(src, { vibrance: vib, saturation: sat });
            assert.deepEqual(Array.from(out.data), Array.from(src.data), `greys unchanged at vibrance ${vib}, saturation ${sat}`);
        }
        const mixed = [];
        let seed = 12345;
        const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 24; };
        for (let i = 0; i < 4096; i++) mixed.push([rnd(), rnd(), rnd()]);
        const msrc = canvasOf(mixed);
        assert.deepEqual(Array.from(applyVibrance(msrc, { vibrance: 0, saturation: 0 }).data), Array.from(msrc.data), "vibrance 0 / saturation 0 is identity");
        // the CPU twin is vibrancePixel, and the GLSL twin (float32) is within a level of it
        const vsrc = applyVibrance(msrc, { vibrance: 80, saturation: -20 });
        const fl = LUMA_601.map(f);
        const glVibrance = (R, G, B, uV, uS) => {
            const r = f(R / 255), g = f(G / 255), b = f(B / 255);
            const luma = glDot(fl, r, g, b, false);
            const sat = f(Math.max(r, g, b) - Math.min(r, g, b));
            const vAmt = f(f(uV) / 100), sAmt = f(f(uS) / 100);
            let vF = vAmt > 0 ? f(vAmt * f(1 - sat)) : f(vAmt * sat);
            const skin = f(glSmooth(0, f(SKIN_SOFT), f(r - g)) * glSmooth(0, f(SKIN_SOFT), f(g - b)));
            vF = f(vF * f(1 - f(0.5 * skin)));
            const k = f(1 + Math.max(-1, Math.min(3, f(vF + sAmt))));
            return [r, g, b].map((c) => toByte(f(f(luma * f(1 - k)) + f(c * k))));
        };
        const u = vibranceUniforms({ vibrance: 80, saturation: -20 });
        let glWorst = 0;
        for (let i = 0; i < mixed.length; i++) {
            const [r, g, b] = mixed[i];
            const want = vibrancePixel(r / 255, g / 255, b / 255, 80, -20).map(toByte);
            assert.deepEqual(px(vsrc, i), want, `applyVibrance equals vibrancePixel at ${mixed[i]}`);
            const gl = glVibrance(r, g, b, u.u_vibrance, u.u_saturation);
            for (let ch = 0; ch < 3; ch++) glWorst = Math.max(glWorst, Math.abs(gl[ch] - want[ch]));
        }
        assert.ok(glWorst <= 1, `GLSL vibrance (float32) within 1 level of the CPU twin (${glWorst})`);
        assert.ok(VIBRANCE_GLSL.includes(`smoothstep(0.0, ${SKIN_SOFT.toFixed(3)}, c.r - c.g)`), "VIBRANCE_GLSL weighs r - g smoothly");
        assert.ok(VIBRANCE_GLSL.includes(`smoothstep(0.0, ${SKIN_SOFT.toFixed(3)}, c.g - c.b)`), "VIBRANCE_GLSL weighs g - b smoothly");
        assert.ok(!/c\.r\s*>\s*c\.g/.test(VIBRANCE_GLSL), "VIBRANCE_GLSL has no hard r > g switch");
    }
    console.log("  [ok] vibrance skin weight is smooth (no seam across r == g / g == b), greys and identity bit-exact, twins agree");

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

    // 7b. Threshold at the boundary: grey == level is white for every level, on the CPU twin, thresholdPixel and a
    // float32 emulation of THRESHOLD_GLSL (the float sum sent grey 100 at level 100 black on the CPU, 84 levels in all)
    {
        const fl = LUMA_601.map(f);
        const glThreshold = (R, G, B, uLevel, fused) => {
            const luma = f(glDot(fl, f(R / 255), f(G / 255), f(B / 255), fused) * 255);
            return luma >= f(f(uLevel) - f(THRESHOLD_EPS)) ? 255 : 0;
        };
        const greys = [];
        for (let v = 0; v < 256; v++) greys.push([v, v, v]);
        const gsrc = canvasOf(greys);
        let boundary = 0;
        for (let level = 1; level <= 254; level++) {
            const out = applyThreshold(gsrc, { level });
            assert.deepEqual(px(out, level), [255, 255, 255], `CPU: grey ${level} at level ${level} is white`);
            assert.deepEqual(px(out, level - 1), [0, 0, 0], `CPU: grey ${level - 1} at level ${level} is black`);
            const t = level / 255;
            assert.deepEqual(thresholdPixel(t, t, t, level), [1, 1, 1], `thresholdPixel: grey ${level} at level ${level} is white`);
            const tb = (level - 1) / 255;
            assert.deepEqual(thresholdPixel(tb, tb, tb, level), [0, 0, 0], `thresholdPixel: grey ${level - 1} at level ${level} is black`);
            const u = thresholdUniforms({ level }).u_level;
            for (const fused of [false, true]) {
                assert.equal(glThreshold(level, level, level, u, fused), 255, `GLSL (float32${fused ? ", fused" : ""}): grey ${level} at level ${level} is white`);
                assert.equal(glThreshold(level - 1, level - 1, level - 1, u, fused), 0, `GLSL (float32${fused ? ", fused" : ""}): grey ${level - 1} at level ${level} is black`);
            }
            // every byte triple next to the cut (the last one below it and the first one at or above it): the CPU
            // twin follows the integer rule 299 R + 587 G + 114 B >= level * 1000, and the float twins agree with it
            const cut = level * 1000;
            const near = [];
            for (let R = 0; R < 256; R++) for (let G = 0; G < 256; G++) {
                const b0 = Math.ceil((cut - 299 * R - 587 * G) / 114);
                for (const B of [b0 - 1, b0]) if (B >= 0 && B <= 255) near.push([R, G, B]);
            }
            const nout = applyThreshold(canvasOf(near), { level });
            for (let i = 0; i < near.length; i++) {
                const [R, G, B] = near[i];
                const want = 299 * R + 587 * G + 114 * B >= cut ? 255 : 0;
                if (nout.data[i * 4] !== want) assert.fail(`CPU threshold ${level} at ${near[i]}: ${nout.data[i * 4]}, integer rule ${want}`);
                if (thresholdPixel(R / 255, G / 255, B / 255, level)[0] * 255 !== want) assert.fail(`thresholdPixel ${level} at ${near[i]} disagrees with the integer rule`);
                if (glThreshold(R, G, B, u, false) !== want || glThreshold(R, G, B, u, true) !== want) assert.fail(`GLSL threshold ${level} at ${near[i]} disagrees with the integer rule`);
            }
            boundary += near.length;
        }
        assert.ok(boundary > 1000000, `boundary triples checked (${boundary})`);
        // a fractional level cuts at the rounded one on both paths
        assert.equal(thresholdUniforms({ level: 100.4 }).u_level, 100, "level 100.4 rounds to 100");
        assert.equal(thresholdUniforms({ level: 100.6 }).u_level, 101, "level 100.6 rounds to 101");
        assert.equal(thresholdUniforms({ level: 0 }).u_level, 1, "level clamped to 1");
        assert.equal(thresholdUniforms({ level: 300 }).u_level, 254, "level clamped to 254");
        assert.deepEqual(px(applyThreshold(gsrc, { level: 100.6 }), 100), [0, 0, 0], "CPU: level 100.6 cuts at 101");
        assert.deepEqual(px(applyThreshold(gsrc, { level: 100.6 }), 101), [255, 255, 255], "CPU: level 100.6 cuts at 101");
        assert.ok(THRESHOLD_GLSL.includes(`u_level - ${THRESHOLD_EPS}`), "THRESHOLD_GLSL compares against the level less THRESHOLD_EPS");
    }
    console.log("  [ok] threshold: grey == level is white for every level, CPU / thresholdPixel / GLSL agree at every boundary triple");

    // 7c. Posterize with a fractional level (an agent may send 4.5): the GLSL formula with its uniforms gives the CPU
    // twin's bytes for every grey (the unrounded uniform differed on 223 of 256 greys, by up to 64 levels)
    {
        const glPosterize = (C, uLevels) => {
            const stepVal = f(Math.max(2, f(uLevels)) - 1);
            return toByte(f(Math.floor(f(f(f(C / 255) * stepVal) + 0.5)) / stepVal));
        };
        const greys = [];
        for (let v = 0; v < 256; v++) greys.push([v, v, v]);
        const gsrc = canvasOf(greys);
        assert.equal(posterizeUniforms({ levels: 4.5 }).u_levels, 5, "levels 4.5 round to 5, as the CPU path rounds");
        // exact where every output k / (levels - 1) is exact in float32 (2, 3, 5, 9, 17 levels and 4.5 -> 5); within a
        // level elsewhere: an output of exactly x.5 levels (5/6 * 255 = 212.5 at 7 levels) is a hair below it in float32
        for (const [levels, exact] of [[4.5, true], [4, false], [2.4, true], [2.5, true], [7.49, false], [12.5, false], [31.6, false], [8.5, true]]) {
            const out = applyPosterize(gsrc, { levels });
            const u = posterizeUniforms({ levels }).u_levels;
            assert.ok(Number.isInteger(u), `posterize uniform for ${levels} is whole (${u})`);
            for (let v = 0; v < 256; v++) {
                const cpu = px(out, v)[0];
                const gl = glPosterize(v, u);
                if (exact) assert.equal(gl, cpu, `posterize ${levels}: GLSL formula equals CPU at grey ${v}`);
                else assert.ok(Math.abs(gl - cpu) <= 1, `posterize ${levels}: GLSL formula within 1 of CPU at grey ${v} (${gl}, ${cpu})`);
                assert.equal(toByte(posterizePixel(v / 255, v / 255, v / 255, levels)[0]), cpu, `posterize ${levels}: posterizePixel equals CPU at grey ${v}`);
            }
            const distinct = new Set(greys.map((g, i) => px(out, i)[0]));
            assert.equal(distinct.size, u, `posterize ${levels} keeps ${u} levels`);
        }
        // the unrounded uniform (as it was) is caught by the same comparison
        let unrounded = 0;
        const out45 = applyPosterize(gsrc, { levels: 4.5 });
        for (let v = 0; v < 256; v++) unrounded = Math.max(unrounded, Math.abs(glPosterize(v, 4.5) - px(out45, v)[0]));
        assert.ok(unrounded > 1, `an unrounded 4.5 would differ (${unrounded})`);
    }
    console.log("  [ok] posterize: fractional levels give the same picture from the GLSL formula as from the CPU twin");

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

    // 9. Gradient map through the commands path (add_filter / set_filter run on a stand-in editor): Opacity and
    // Reverse are offsets on the preset, so a preset at an opacity other than 100 stays that preset (writeParams
    // turned it to Custom, whose black-to-white stops then hid the look)
    {
        const { FILTERS, filterDefaults } = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_filters.js")).href);
        const { commands } = await import(pathToFileURL(path.join(ROOT, "renderer", "commands.js")).href);
        const { host } = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "host.js")).href);
        const ed = {
            base: {}, width: 64, height: 64, filterCounter: 0, layers: [], activeLayerId: null, uploaded: {},
            addFilterLayer(type) {
                this.filterCounter += 1;
                const l = { id: `f${this.filterCounter}`, name: `${FILTERS[type].label} ${this.filterCounter}`, kind: "filter", filter: type, params: filterDefaults(type), visible: true, opacity: 1, x: 0, y: 0, w: 64, h: 64 };
                this.layers.push(l);
                this.activeLayerId = l.id;
                return l;
            },
            activeLayer() { return this.layers.find((l) => l.id === this.activeLayerId) || null; },
            setFilterType() { throw new Error("not used"); },
            markFilterChanged() {}, pushUndo() {}, renderLayers() {}, renderInfo() {}, draw() {}, drawThumb() {}, notifyChanged() {},
            isReference() { return false; }, refLabels() { return new Map(); }, isLocked() { return false; },
        };
        const prevEditor = host.editor;
        host.editor = ed;
        const spec = FILTERS.gradient_map.params;
        // the layer row's rule (inpaint_canvas.js range input): a slider without keepPreset turns the preset to Custom
        for (const p of spec) {
            if (!p.type || p.type === "number") assert.equal(p.keepPreset, true, `gradient_map ${p.key} is an offset on the preset (keepPreset)`);
        }
        const presetP = spec.find((p) => p.key === "preset");
        assert.ok(typeof presetP.title === "string" && presetP.title.length > 0, "the gradient map's preset select has its own title");
        assert.ok(!/film|trademark|grain/i.test(presetP.title), "the preset title is about gradients, not film stocks");

        const s = await commands.run("add_filter", { type: "gradient_map", params: { preset: "sunset", opacity: 50 } });
        const l = ed.layers.find((x) => x.id === s.id);
        assert.equal(l.params.preset, "sunset", "add_filter {preset: sunset, opacity: 50} keeps sunset");
        assert.equal(l.params.opacity, 50, "add_filter stores the opacity");
        const grey = 128 / 255;
        const want = gradientMapPixel(grey, grey, grey, { preset: "sunset", opacity: 50 }).map(toByte);
        assert.deepEqual(gradientMapPixel(grey, grey, grey, l.params).map(toByte), want, "the layer renders sunset at 50 %");
        assert.notDeepEqual(want, [128, 128, 128], "sunset at 50 % is not the grey a Custom black-to-white gives");
        await commands.run("set_filter", { layer: l.id, params: { opacity: 30 } });
        assert.equal(l.params.preset, "sunset", "set_filter {opacity: 30} keeps sunset");
        assert.equal(l.params.opacity, 30, "set_filter stores the opacity");
        await commands.run("set_filter", { layer: l.id, params: { reverse: true } });
        assert.equal(l.params.preset, "sunset", "set_filter {reverse: true} keeps sunset");
        const ft = await commands.run("filter_types", {});
        const listed = ft.filters.find((x) => x.id === "gradient_map").params.find((x) => x.key === "opacity");
        assert.equal(listed.offset, true, "filter_types lists the gradient map's opacity as an offset");
        // control: the same path does turn a preset to Custom for a slider that is no offset (the grain's amount)
        const stock = FILTERS.grain.params[0].options.map((o) => (o && typeof o === "object" ? o.id : o)).find((id) => id !== "custom");
        const gs = await commands.run("add_filter", { type: "grain", params: { preset: stock } });
        const gl = ed.layers.find((x) => x.id === gs.id);
        assert.equal(gl.params.preset, stock, "grain stock set");
        await commands.run("set_filter", { layer: gl.id, params: { amount: gl.params.amount === 3 ? 4 : 3 } });
        assert.equal(gl.params.preset, "custom", "control: the grain's amount turns its stock to Custom on the same path");
        host.editor = prevEditor;
    }
    console.log("  [ok] gradient map: opacity and reverse keep the preset through add_filter / set_filter; own preset title");

    console.log("PASS");
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
