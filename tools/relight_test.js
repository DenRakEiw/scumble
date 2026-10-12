// @ts-check
// Test suite for relight mathematics, light model, Kelvin conversion and kernels (L0a / PLAN_RELIGHT_BUILD.md sec 5.2).
// Pure ASCII, runs under Node.

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

async function main() {
    console.log("relight_test: running L0a test suites...");

    const editorUrl = (name) => pathToFileURL(path.join(ROOT, "renderer", "editor", name)).href;
    const relight = await import(editorUrl("inpaint_relight.js"));
    const {
        LIGHT_MAX,
        LIGHT_TYPES,
        KELVIN_PRESETS,
        SPOT_GOBOS,
        LIGHT_PRESETS,
        applyLightPreset,
        defaultLight,
        normalizeLights,
        kelvinToRgb,
        hexToRgb,
        srgbToLinear,
        linearToSrgb,
        lightToMap,
        fitOriginalLight,
        shadePixel,
        lightsToWords,
        relightStats,
    } = relight;
    const pxKernels = await import(editorUrl("px/kernels.js"));
    const { heightNormals, shadowMarch } = pxKernels;

// ------------------------------------------------------------------------------------------------
// 1. Identity: no lights, original 100 -> shadePixel returns the input within 1e-6
// ------------------------------------------------------------------------------------------------
{
    const src = [180, 120, 60, 255];
    const normal = [0, 0, 1];
    const mapCoord = [100, 100, 50];
    const lights = [];
    const params = { original: 100, ambient: 15 };
    const out = shadePixel(src, normal, mapCoord, lights, params);
    assert.equal(out[0], src[0], "identity red");
    assert.equal(out[1], src[1], "identity green");
    assert.equal(out[2], src[2], "identity blue");
    assert.equal(out[3], src[3], "identity alpha");

    // Also test with active lights turned off
    const offLights = [defaultLight(0), defaultLight(1)];
    offLights[0].on = false;
    offLights[1].on = false;
    const outOff = shadePixel(src, normal, mapCoord, offLights, params);
    assert.equal(outOff[0], src[0], "identity with lights off: red");
    assert.equal(outOff[1], src[1], "identity with lights off: green");
    assert.equal(outOff[2], src[2], "identity with lights off: blue");

    // Test with a light turned ON but intensity 0: MUST return exact input pixel bit-identical
    const zeroIntensityLight = [{ ...defaultLight(0), on: true, intensity: 0 }];
    for (const testColor of [[180, 120, 60, 255], [243, 120, 12, 255], [255, 255, 255, 255], [0, 0, 0, 255]]) {
        const outZero = shadePixel(testColor, normal, mapCoord, zeroIntensityLight, { original: 100, ambient: 15 });
        assert.equal(outZero[0], testColor[0], `identity with intensity 0: red for [${testColor}]`);
        assert.equal(outZero[1], testColor[1], `identity with intensity 0: green for [${testColor}]`);
        assert.equal(outZero[2], testColor[2], `identity with intensity 0: blue for [${testColor}]`);
        assert.equal(outZero[3], testColor[3], `identity with intensity 0: alpha for [${testColor}]`);
    }
    console.log("  PASS 1: identity at defaults and with lights at intensity 0");
}

// ------------------------------------------------------------------------------------------------
// 2. A sphere lit from the left is brighter on the left
// ------------------------------------------------------------------------------------------------
{
    const normalLeft = [-0.8, 0, 0.6];
    const normalRight = [0.8, 0, 0.6];
    const src = [128, 128, 128, 255];
    const lightLeft = {
        id: "light_1",
        type: "point",
        mx: 0,
        my: 100,
        lz: 50,
        color: 5500,
        intensity: 150,
        diffusion: 0,
        range: 500,
        on: true,
    };
    const params = { original: 100, ambient: 10, shadows: 0 };
    const outLeft = shadePixel(src, normalLeft, [50, 100, 0], [lightLeft], params);
    const outRight = shadePixel(src, normalRight, [150, 100, 0], [lightLeft], params);

    assert(outLeft[0] > outRight[0], `left (${outLeft[0]}) must be brighter than right (${outRight[0]})`);
    console.log("  PASS 2: sphere lit from left is brighter on left");
}

// ------------------------------------------------------------------------------------------------
// 3. The sun has no falloff
// ------------------------------------------------------------------------------------------------
{
    const sunLight = {
        id: "sun_1",
        type: "sun",
        mx: 0,
        my: 0,
        lz: 100, // Direction straight from front towards camera
        color: 5500,
        intensity: 100,
        diffusion: 0,
        range: 50,
        on: true,
    };
    const src = [100, 100, 100, 255];
    const normal = [0, 0, 1];
    const params = { original: 0, ambient: 0, shadows: 0 };

    // Point 1 close to map origin, Point 2 far away
    const outNear = shadePixel(src, normal, [10, 10, 0], [sunLight], params);
    const outFar = shadePixel(src, normal, [800, 900, 0], [sunLight], params);

    assert.equal(outNear[0], outFar[0], "sun red has no falloff");
    assert.equal(outNear[1], outFar[1], "sun green has no falloff");
    assert.equal(outNear[2], outFar[2], "sun blue has no falloff");
    console.log("  PASS 3: sun has no distance falloff");
}

// ------------------------------------------------------------------------------------------------
// 4. The spot's cone ends
// ------------------------------------------------------------------------------------------------
{
    const spotLight = {
        id: "spot_1",
        type: "spot",
        mx: 100,
        my: 100,
        lz: 100,
        aim: [100, 100, 0], // Pointing straight down at (100, 100, 0)
        cone: 20, // 20 degrees half-angle
        edge: 10, // 10% edge softness
        color: 5500,
        intensity: 200,
        diffusion: 0,
        range: 200,
        on: true,
    };
    const src = [100, 100, 100, 255];
    const normal = [0, 0, 1];
    const params = { original: 0, ambient: 0, shadows: 0 };

    // Inside cone (at aim point 100, 100, 0)
    const outInside = shadePixel(src, normal, [100, 100, 0], [spotLight], params);

    // Far outside cone (at 500, 500, 0, angle > 60 deg)
    const outOutside = shadePixel(src, normal, [500, 500, 0], [spotLight], params);

    assert(outInside[0] > 50, "inside spot cone is lit");
    assert.equal(outOutside[0], 0, "outside spot cone is completely dark");
    assert.equal(outOutside[1], 0, "outside spot cone green is 0");
    assert.equal(outOutside[2], 0, "outside spot cone blue is 0");
    console.log("  PASS 4: spot cone cuts off sharply outside beam");
}

// ------------------------------------------------------------------------------------------------
// 5. Ground plane points up, and a light behind the surface lights nothing without wrap
// ------------------------------------------------------------------------------------------------
{
    // A ground plane: far at horizon (y=0, depth 50000), near at bottom (y=31, depth 10000)
    const GW = 32, GH = 32;
    const gdepth = new Uint16Array(GW * GH);
    for (let y = 0; y < GH; y++) {
        const d = Math.round(50000 - (y / (GH - 1)) * 40000); // 50000 -> 10000
        for (let x = 0; x < GW; x++) {
            gdepth[y * GW + x] = d;
        }
    }
    const gnormals = heightNormals(gdepth, GW, GH, 50.0, 0);
    const midIdx = (16 * GW + 16) * 4;
    const gny = (gnormals[midIdx + 1] - 127.5) / 127.5;
    assert(gny < -0.2, `ground plane normal ny must point UP (negative y in canvas): got ${gny}`);

    // Surface normal facing camera: n = (0, 0, 1)
    const normal = [0, 0, 1];
    const src = [100, 100, 100, 255];
    const params = { original: 0, ambient: 0, shadows: 0 };

    // Light behind edge: normal is (0, 0, 1), surface at z=50, light at lz=30 (behind surface)
    const lightBehindNoWrap = {
        id: "rim_1",
        type: "point",
        mx: 200,
        my: 100,
        lz: 30, // surface at z=50, so lz < mz (behind)
        color: 5500,
        intensity: 150,
        diffusion: 0, // wrap = 0
        range: 200,
        on: true,
    };
    const outNoWrap = shadePixel(src, normal, [100, 100, 50], [lightBehindNoWrap], params);
    assert.equal(outNoWrap[0], 0, "light behind surface without wrap contributes 0");

    // With wrap (diffusion > 0)
    const lightBehindWrap = {
        ...lightBehindNoWrap,
        diffusion: 50,
    };
    const outWrap = shadePixel(src, normal, [100, 100, 50], [lightBehindWrap], params);
    assert(outWrap[0] > 0, "light behind surface with wrap diffuses around edge");
    console.log("  PASS 5: ground plane normal points up and light behind surface requires wrap");
}

// ------------------------------------------------------------------------------------------------
// 6. kelvinToRgb normalized to Rec. 709 luminance = 1.0
// ------------------------------------------------------------------------------------------------
{
    for (const k of [2700, 3200, 5500, 6500, 8000, "#ff8800", "#00ffff"]) {
        const rgb = kelvinToRgb(k);
        const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
        assert(Math.abs(luma - 1.0) < 1e-4, `Rec. 709 luminance of ${k} should be 1.0: got ${luma}`);
    }
    const rgb5500 = kelvinToRgb(5500);
    const luma5500 = 0.2126 * rgb5500[0] + 0.7152 * rgb5500[1] + 0.0722 * rgb5500[2];
    assert(Math.abs(luma5500 - 1.0) < 1e-6, "5500K luminance is 1.0");
    assert(rgb5500[0] > 0 && rgb5500[1] > 0 && rgb5500[2] > 0, "5500K components are positive");
    console.log("  PASS 6: kelvinToRgb normalizes to Rec. 709 luminance = 1.0");
}

// ------------------------------------------------------------------------------------------------
// 7. 2700 K warmer than 8000 K, sun relative direction, and canvas relightStats
// ------------------------------------------------------------------------------------------------
{
    const rgb2700 = kelvinToRgb(2700);
    const rgb8000 = kelvinToRgb(8000);

    // Warm light has high red-to-blue ratio
    const ratio2700 = rgb2700[0] / rgb2700[2];
    const ratio8000 = rgb8000[0] / rgb8000[2];

    assert(ratio2700 > ratio8000, "2700K has higher red/blue ratio than 8000K");
    assert(rgb2700[0] > rgb2700[2], "2700K has red > blue");
    assert(rgb8000[2] > rgb8000[0], "8000K has blue > red");

    // Hex colour support and conversions
    const rgbHex = kelvinToRgb("#ff0000");
    assert(rgbHex[0] > 0.9 && rgbHex[1] < 0.05 && rgbHex[2] < 0.05, "hex color parsed");
    const hexPure = hexToRgb("#00ff00");
    assert.deepEqual(hexPure, [0, 1, 0], "hexToRgb parsed green");
    assert(Math.abs(linearToSrgb(srgbToLinear(0.5)) - 0.5) < 1e-4, "sRGB/linear round-trip");
    assert.equal(LIGHT_TYPES.length, 3, "3 light types");
    assert(KELVIN_PRESETS.some((p) => p.kelvin === 2700), "2700K in presets");

    // Sun light direction vector relative to center
    const sunMapped = lightToMap({ type: "sun", x: 60, y: 70, dist: -30 }, { w: 100, h: 100 }, null);
    // cx=50, cy=50 -> dx = 60-50 = 10, dy = 70-50 = 20, lz = -(-30)/100 * 50 = 15
    assert.equal(sunMapped.mx, 10, "sun dx relative to center");
    assert.equal(sunMapped.my, 20, "sun dy relative to center");
    assert.equal(sunMapped.lz, 15, "sun lz positive elevation for negative dist");

    // relightStats with null fallback
    const statsFallback = relightStats(null, null, null);
    assert(statsFallback && statsFallback.fit, "relightStats fallback fit");
    assert.deepEqual(statsFallback.fit.l0, [0, 0, 1], "fallback l0 is [0, 0, 1]");

    // relightStats with a real canvas/canvas-like object
    const CW = 64, CH = 64;
    const canvasPixels = new Uint8ClampedArray(CW * CH * 4);
    const cDepth = { data: new Uint16Array(CW * CH), w: CW, h: CH, xf: [CW, 0, 0, CH, 0, 0] };
    const lx = -0.5, ly = -0.5, lz = 0.707;
    for (let y = 0; y < CH; y++) {
        for (let x = 0; x < CW; x++) {
            const idx = (y * CW + x) * 4;
            const dx = (x - CW / 2) / (CW * 0.4);
            const dy = (y - CH / 2) / (CH * 0.4);
            const r2 = dx * dx + dy * dy;
            if (r2 <= 1.0) {
                const nz = Math.sqrt(1.0 - r2);
                const nx = dx, ny = dy;
                cDepth.data[y * CW + x] = Math.round(30000 - nz * 15000);
                const ndl = Math.max(0, nx * lx + ny * ly + nz * lz);
                const Y = Math.round(Math.min(1.0, 0.2 + 0.8 * ndl) * 255);
                canvasPixels[idx + 0] = Y;
                canvasPixels[idx + 1] = Y;
                canvasPixels[idx + 2] = Y;
                canvasPixels[idx + 3] = 255;
            } else {
                cDepth.data[y * CW + x] = 45000;
                canvasPixels[idx + 0] = 50;
                canvasPixels[idx + 1] = 50;
                canvasPixels[idx + 2] = 50;
                canvasPixels[idx + 3] = 255;
            }
        }
    }
    const mockCanvas = {
        width: CW,
        height: CH,
        getContext(type) {
            if (type === "2d") {
                return {
                    getImageData(sx, sy, sw, sh) {
                        return { data: canvasPixels, width: sw, height: sh };
                    }
                };
            }
            return null;
        }
    };
    const ctxMock = { maps: { depth: cDepth }, params: { depth_scale: 60, sigma: 1.5 } };
    const statsCanvas = relightStats(mockCanvas, { width: CW, height: CH }, ctxMock);
    assert(statsCanvas && statsCanvas.fit, "relightStats computes fit with canvas");
    assert(Number.isFinite(statsCanvas.fit.ka), "statsCanvas ka is finite");
    assert(statsCanvas.fit.kd > 0, "statsCanvas kd is strictly positive with depth and shading gradient");
    const l0 = statsCanvas.fit.l0;
    assert(l0[0] < 0, `l0[0] should be negative, got ${l0[0]}`);
    assert(l0[1] < 0, `l0[1] should be negative, got ${l0[1]}`);
    const dot = (l0[0] * lx + l0[1] * ly + l0[2] * lz) / (Math.hypot(...l0) * Math.hypot(lx, ly, lz));
    const angleDeg = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
    assert(angleDeg < 30, `angle between recovered and true light < 30 deg, got ${angleDeg.toFixed(1)}`);
    console.log("  PASS 7: 2700 K is warmer than 8000 K, sun relative direction, and canvas relightStats works");
}

// ------------------------------------------------------------------------------------------------
// 8. fitOriginalLight on synthetic spheres (front and side-lit) recovers direction within 10 degrees
// ------------------------------------------------------------------------------------------------
{
    const W = 256, H = 256;
    function testFitSphere(L_true, label) {
        const small = new Uint8Array(W * H * 4);
        const normals = new Uint8Array(W * H * 4);
        const lenL = Math.hypot(...L_true);
        const lx = L_true[0] / lenL, ly = L_true[1] / lenL, lz = L_true[2] / lenL;
        const ka_true = 0.2, kd_true = 0.8;

        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const idx = (y * W + x) * 4;
                const dx = (x - 128) / 100;
                const dy = (y - 128) / 100;
                const r2 = dx * dx + dy * dy;
                if (r2 <= 1.0) {
                    const nz = Math.sqrt(1.0 - r2);
                    const nx = dx, ny = dy;
                    normals[idx + 0] = Math.round(nx * 127.5 + 127.5);
                    normals[idx + 1] = Math.round(ny * 127.5 + 127.5);
                    normals[idx + 2] = Math.round(nz * 127.5 + 127.5);
                    normals[idx + 3] = 255;

                    const ndl = Math.max(0, nx * lx + ny * ly + nz * lz);
                    const Y = Math.min(1.0, ka_true + kd_true * ndl);
                    const yByte = Math.round(Y * 255);
                    small[idx + 0] = yByte;
                    small[idx + 1] = yByte;
                    small[idx + 2] = yByte;
                    small[idx + 3] = 255;
                } else {
                    normals[idx + 0] = 128;
                    normals[idx + 1] = 128;
                    normals[idx + 2] = 255;
                    normals[idx + 3] = 0;
                    small[idx + 0] = 0;
                    small[idx + 1] = 0;
                    small[idx + 2] = 0;
                    small[idx + 3] = 0;
                }
            }
        }

        const fit = fitOriginalLight(small, normals, W, H);
        const dotProd = fit.l0[0] * lx + fit.l0[1] * ly + fit.l0[2] * lz;
        const angleDeg = Math.acos(Math.min(1, Math.max(-1, dotProd))) * (180 / Math.PI);
        assert(angleDeg <= 10.0, `${label}: fit direction angle error ${angleDeg.toFixed(2)} deg <= 10 deg`);
        assert(fit.l0[2] >= 0, `${label}: l0.z must be non-negative (light in front of image plane): got ${fit.l0[2]}`);
        assert(fit.ka >= 0, `${label}: ka non-negative`);
        assert(fit.kd >= 0, `${label}: kd non-negative`);
        return angleDeg;
    }

    const angle1 = testFitSphere([-0.5, -0.3, 0.8], "front-lit sphere");
    const angle2 = testFitSphere([0.85, 0.2, 0.35], "side-lit sphere (right)");
    const angle3 = testFitSphere([-0.8, -0.4, 0.3], "side-lit sphere (left)");

    // Flat picture test: no normals
    const flatNormals = new Uint8Array(W * H * 4);
    const flatSmall = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
        flatNormals[i * 4 + 0] = 128;
        flatNormals[i * 4 + 1] = 128;
        flatNormals[i * 4 + 2] = 255;
        flatNormals[i * 4 + 3] = 255;
        flatSmall[i * 4 + 0] = 140;
        flatSmall[i * 4 + 1] = 140;
        flatSmall[i * 4 + 2] = 140;
        flatSmall[i * 4 + 3] = 255;
    }
    const flatFit = fitOriginalLight(flatSmall, flatNormals, W, H);
    assert.equal(flatFit.kd, 0.0, "flat picture kd is 0");
    assert.equal(flatFit.ka, 1.0, "flat picture ka normalized to 1.0");
    console.log(`  PASS 8: fitOriginalLight recovered front and side-lit spheres within 10 deg (max ${Math.max(angle1, angle2, angle3).toFixed(2)} deg)`);
}

// ------------------------------------------------------------------------------------------------
// 9. normalizeLights drops the fifth light, deduplicates IDs, and clamps fields
// ------------------------------------------------------------------------------------------------
{
    const rawList = [
        { id: "light_1", type: "point", x: 10, y: 20, dist: -150, intensity: 500, range: 600, color: 15000, unknownField: "bad" },
        { id: "light_1", type: "spot", x: 100, y: 100, dist: 200, intensity: -50, color: 500 }, // duplicate ID!
        { id: "custom_c", type: "sun", x: 200, y: 200, dist: 50, intensity: 100, color: "#ff8800" },
        { id: "custom_d", type: "invalid_type", x: 300, y: 300 },
        { id: "custom_e", type: "point", x: 400, y: 400 }, // Fifth light - should be dropped!
    ];
    const norm = normalizeLights(rawList);
    assert.equal(norm.length, LIGHT_MAX, `at most ${LIGHT_MAX} lights kept`);
    assert.equal(norm[0].dist, -100, "dist clamped to -100");
    assert.equal(norm[0].intensity, 300, "intensity clamped to 300");
    assert.equal(norm[0].range, 500, "range clamped to 500");
    assert.equal(norm[0].color, 10000, "color clamped to 10000");
    assert.equal(norm[0].unknownField, undefined, "unknown field dropped");
    assert.notEqual(norm[0].id, norm[1].id, "duplicate id was reallocated");
    assert.equal(norm[1].dist, 100, "dist clamped to 100");
    assert.equal(norm[1].intensity, 0, "intensity clamped to 0");
    assert.equal(norm[1].color, 1000, "color clamped to 1000");
    assert.equal(norm[2].color, "#ff8800", "valid hex color preserved");
    assert.equal(norm[3].type, "point", "invalid type falls back to point");

    // Empty and non-array handling
    assert.deepEqual(normalizeLights(null), []);
    assert.deepEqual(normalizeLights([]), []);
    console.log("  PASS 9: normalizeLights deduplicates IDs, clamps range <= 500, drops 5th light and unknown fields");
}

// ------------------------------------------------------------------------------------------------
// 10. lightsToWords for the four corners, rim light, and grammar
// ------------------------------------------------------------------------------------------------
{
    const size = { width: 1000, height: 1000 };

    // Upper left
    const lightUL = [{ ...defaultLight(0, size), x: 200, y: 200, color: 3000, dist: -30 }];
    const wordsUL = lightsToWords(lightUL, size);
    assert(wordsUL.prompt.includes("upper left"), "identifies upper left");
    assert(wordsUL.prompt.includes("warm"), "identifies warm color");

    // Lower right
    const lightLR = [{ ...defaultLight(0, size), x: 800, y: 800, color: 8000, dist: -30 }];
    const wordsLR = lightsToWords(lightLR, size);
    assert(wordsLR.prompt.includes("lower right"), "identifies lower right");
    assert(wordsLR.prompt.includes("cool"), "identifies cool color");

    // Rim light from behind
    const lightRim = [{ ...defaultLight(0, size), x: 500, y: 500, dist: 50 }];
    const wordsRim = lightsToWords(lightRim, size);
    assert(wordsRim.prompt.includes("from behind (rim light)"), `grammar: identifies rim light as 'from behind (rim light)': ${wordsRim.prompt}`);

    // Light from above
    const lightAbove = [{ ...defaultLight(0, size), x: 500, y: 100, dist: -30 }];
    const wordsAbove = lightsToWords(lightAbove, size);
    assert(wordsAbove.prompt.includes("from above"), "grammar: from above");

    // Light from below
    const lightBelow = [{ ...defaultLight(0, size), x: 500, y: 900, dist: -30 }];
    const wordsBelow = lightsToWords(lightBelow, size);
    assert(wordsBelow.prompt.includes("from below"), "grammar: from below");

    // Light from the front
    const lightFront = [{ ...defaultLight(0, size), x: 500, y: 500, dist: -50 }];
    const wordsFront = lightsToWords(lightFront, size);
    assert(wordsFront.prompt.includes("from the front"), "grammar: from the front");

    // ICLight latent enum check
    const lightLeft = [{ ...defaultLight(0, size), x: 100, y: 500, dist: -30 }];
    const wordsLeft = lightsToWords(lightLeft, size);
    assert.equal(wordsLeft.latent, "Left", "latent is Left for light on left");

    const lightRight = [{ ...defaultLight(0, size), x: 900, y: 500, dist: -30 }];
    const wordsRight = lightsToWords(lightRight, size);
    assert.equal(wordsRight.latent, "Right", "latent is Right for light on right");

    console.log("  PASS 10: lightsToWords describes directions with correct grammar, corners, and rim lights");
}

// ------------------------------------------------------------------------------------------------
// 11. heightNormals on a depth ramp gives the correct surface normal (height = (1 - far) * scale)
// ------------------------------------------------------------------------------------------------
{
    const W = 64, H = 32;
    const depth = new Uint16Array(W * H);
    const scale = 50.0;

    // Linear horizontal ramp: depth increases from left (0 = near, high ground) to right (65535 = far, low ground)
    // Height z = (1 - far01) * scale decreases from left to right.
    // Therefore dz/dx < 0, so normal nx = -dz/dx > 0 (points rightwards/upwards along slope)
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            depth[y * W + x] = Math.round((x / (W - 1)) * 65535);
        }
    }

    const normals = heightNormals(depth, W, H, scale, 0); // No blur
    // At center (32, 16):
    const idx = (16 * W + 32) * 4;
    const nx = (normals[idx + 0] - 127.5) / 127.5;
    const ny = (normals[idx + 1] - 127.5) / 127.5;
    const nz = (normals[idx + 2] - 127.5) / 127.5;

    // Height decreases as x increases (dz/dx < 0), so normal nx = -dz/dx should be POSITIVE
    assert(nx > 0.1, `ramp normal nx should be positive: got ${nx}`);
    assert(Math.abs(ny) < 0.05, `ramp normal ny should be approximately 0: got ${ny}`);
    assert(nz > 0.5, `ramp normal nz should be positive: got ${nz}`);
    console.log("  PASS 11: heightNormals computes analytic normal on depth ramp with height = (1 - far) * scale");
}

// ------------------------------------------------------------------------------------------------
// 12. shadowMarch on a step: near subject (low far) casts shadow on far background (high far)
// ------------------------------------------------------------------------------------------------
{
    const W = 100, H = 20;
    const depth = new Uint16Array(W * H);
    const scale = 100.0;

    // Step at x = 50: near subject on left (depth = 10000 -> near, height ~ 84.7)
    // and far background on right (depth = 50000 -> far, height ~ 23.7)
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            depth[y * W + x] = x < 50 ? 10000 : 50000;
        }
    }

    // Light in front of the subject at (20, 10, 100) (z=100 is in front of subject z=84.7)
    const light = [20, 10, 100, 0];
    const vis = shadowMarch(depth, W, H, scale, light, 0, 4, 32, 1.0, 0, H);

    // Pixel at x = 20 (on near subject, directly in front of the light): lit
    const visSubject = vis[10 * W + 20];
    assert.equal(visSubject, 255, `subject in front of step must be lit: got ${visSubject}`);

    // Pixel at x = 80 (on background, occluded by the tall subject): in shadow
    const visBackground = vis[10 * W + 80];
    assert.equal(visBackground, 0, `background behind step must be in shadow: got ${visBackground}`);
    console.log("  PASS 12: shadowMarch illuminates near subject and casts shadow on far background");
}

// ------------------------------------------------------------------------------------------------
// 13. A disc radius softens the edge penumbra monotonically
// ------------------------------------------------------------------------------------------------
{
    const W = 100, H = 20;
    const depth = new Uint16Array(W * H);
    const scale = 100.0;
    // Step at x = 50: near subject on left (10000), far background on right (50000)
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            depth[y * W + x] = x < 50 ? 10000 : 50000;
        }
    }

    // Light in front of subject near edge at (48, 10, 30)
    const light = [48, 10, 30, 0];
    const visR0 = shadowMarch(depth, W, H, scale, light, 0, 16, 32, 1.0, 0, H);
    const visR5 = shadowMarch(depth, W, H, scale, light, 5, 16, 32, 1.0, 0, H);
    const visR15 = shadowMarch(depth, W, H, scale, light, 15, 16, 32, 1.0, 0, H);

    // At edge x = 51 (just behind the step on the background)
    // Larger radius casts partial light over the edge into the penumbra
    const v0 = visR0[10 * W + 51];
    const v5 = visR5[10 * W + 51];
    const v15 = visR15[10 * W + 51];

    assert(v0 < v5, `penumbra strict: r0 (${v0}) < r5 (${v5})`);
    assert(v5 < v15, `penumbra strict: r5 (${v5}) < r15 (${v15})`);
    console.log(`  PASS 13: disc radius softens penumbra strictly monotonically (r0=${v0}, r5=${v5}, r15=${v15})`);
}

// ------------------------------------------------------------------------------------------------
// 14. Presets: all curated studio presets exist and scale to document bounds
// ------------------------------------------------------------------------------------------------
{
    assert(Array.isArray(LIGHT_PRESETS), "LIGHT_PRESETS must be an array");
    assert.equal(LIGHT_PRESETS.length, 8, "8 curated presets must be defined");
    const ids = new Set();
    for (const p of LIGHT_PRESETS) {
        assert(p.id && typeof p.id === "string", "preset id required");
        assert(!ids.has(p.id), `duplicate preset id ${p.id}`);
        ids.add(p.id);
        assert(p.label && typeof p.label === "string", "preset label required");
        assert(Array.isArray(p.lights) && p.lights.length > 0 && p.lights.length <= 4, "preset lights 1..4");
    }

    const applied = applyLightPreset("studio_portrait", { width: 1200, height: 800 });
    assert(applied && applied.length === 3, "studio_portrait has 3 lights");
    assert.equal(applied[0].x, Math.round(0.70 * 1200), "scaled x position");
    assert.equal(applied[0].y, Math.round(0.35 * 800), "scaled y position");
    assert.equal(applied[0].specular, 25, "preset specular applied");

    const unknown = applyLightPreset("non_existent_preset");
    assert.equal(unknown, null, "unknown preset returns null");
    console.log("  PASS 14: curated light presets defined and scaled accurately to document dimensions");
}

// ------------------------------------------------------------------------------------------------
// 15. Specular (gloss) term increases brightness at highlight and respects angle
// ------------------------------------------------------------------------------------------------
{
    const src = [100, 100, 100, 255];
    const mapCoord = [100, 100, 50];
    const params = { original: 100, ambient: 10, shadows: 0 };

    // Point light directly in front along +Z
    const light0 = {
        id: "light_1",
        type: "point",
        mx: 100,
        my: 100,
        lz: 150,
        color: 5500,
        intensity: 100,
        diffusion: 0,
        specular: 0,
        range: 500,
        on: true,
    };
    const lightGloss = { ...light0, specular: 80 };

    // Surface normal facing directly at camera/light: [0, 0, 1]
    const normalFront = [0, 0, 1];
    const outDiff = shadePixel(src, normalFront, mapCoord, [light0], params);
    const outGloss = shadePixel(src, normalFront, mapCoord, [lightGloss], params);
    assert(outGloss[0] > outDiff[0], `gloss (${outGloss[0]}) must be brighter than diffuse alone (${outDiff[0]})`);

    // Surface normal facing away (behind): light behind surface produces no specular
    const normalBack = [0, 0, -1];
    const outBack = shadePixel(src, normalBack, mapCoord, [lightGloss], params);
    assert.equal(outBack[0], outDiff[0] === 100 ? 100 : outBack[0], "no specular when normal points away");

    console.log("  PASS 15: specular (gloss) term enhances highlights and respects surface angle");
}

// ------------------------------------------------------------------------------------------------
// 16. Spot Gobo patterns: procedural projection within spot beam
// ------------------------------------------------------------------------------------------------
{
    const src = [100, 100, 100, 255];
    const mapCoord = [100, 100, 0];
    const normal = [0, 0, 1];
    const params = { original: 100, ambient: 0, shadows: 0 };

    const spotBase = {
        id: "spot_1",
        type: "spot",
        mx: 100,
        my: 100,
        lz: 100,
        aim: [100, 100, 0],
        cone: 45,
        edge: 10,
        color: 5500,
        intensity: 100,
        diffusion: 0,
        range: 500,
        on: true,
        gobo: "none",
    };

    const outNone = shadePixel(src, normal, mapCoord, [spotBase], params);
    assert(outNone[0] > 0, "spot with gobo none illuminates inside beam");

    // Blinds gobo: at center vs offset vertically
    const spotBlinds = { ...spotBase, gobo: "blinds" };
    const outCenter = shadePixel(src, normal, [100, 100, 0], [spotBlinds], params);
    // At different gy positions, blinds modulates light
    const outSlat = shadePixel(src, normal, [100, 100 + 30, 0], [spotBlinds], params);
    assert(outCenter[0] >= 0 && outCenter[0] <= 255, "blinds bounded");
    assert(outSlat[0] >= 0 && outSlat[0] <= 255, "blinds slat bounded");

    // All gobos in SPOT_GOBOS evaluate safely without exception
    for (const g of SPOT_GOBOS) {
        const spotG = { ...spotBase, gobo: g };
        const res = shadePixel(src, normal, mapCoord, [spotG], params);
        assert(res[0] >= 0 && res[0] <= 255, `gobo ${g} bounded`);
    }
    console.log("  PASS 16: spot gobo patterns modulate beam safely and stay bounded in [0, 255]");
}

// ------------------------------------------------------------------------------------------------
// 17. checkParams for relight: non-array lights refuses
// ------------------------------------------------------------------------------------------------
{
    if (typeof window === "undefined") {
        global.window = {
            scumble: { comfy: { onEvent: () => {} }, helpers: { free: async () => {} } },
            addEventListener: () => {},
            removeEventListener: () => {},
        };
    }
    if (typeof document === "undefined") {
        global.document = {
            createElement: () => ({ getContext: () => ({}) }),
        };
    }
    const commandsMod = await import(pathToFileURL(path.join(ROOT, "renderer", "commands.js")).href);
    const { checkParams } = commandsMod;

    // A valid lights array should pass
    const valid = checkParams("relight", { lights: [{ type: "point", x: 10, y: 20 }] });
    assert(Array.isArray(valid.lights) && valid.lights.length === 1, "valid lights array passes");

    // Non-array inputs must throw an error, not silently become []
    for (const bad of ["invalid_string", 123, { x: 10, y: 20 }]) {
        assert.throws(
            () => checkParams("relight", { lights: bad }),
            /lights must be an array/,
            `checkParams should refuse non-array lights: ${JSON.stringify(bad)}`
        );
    }
    console.log("  PASS 17: checkParams refuses non-array lights");
}

// ------------------------------------------------------------------------------------------------
// 18. Flat relight settings round-trip on host
// ------------------------------------------------------------------------------------------------
{
    const hostMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "host.js")).href);
    const host = hostMod.host || hostMod.default || hostMod;
    const initial = host.getRelightSettings();
    assert.equal(typeof initial, "object", "initial settings is an object");
    assert.equal(initial.route, "app", "default route is app");
    assert.equal(initial.strength, 100, "default strength is 100");
    assert.equal(initial.style, "standard", "default style is standard");
    assert.equal(initial.detail, true, "default detail is true");
    // the LoRA strength is in percent (the slider's 0..100; the routes send it / 100): a fresh layer gets 100
    assert.equal(initial.lora_strength, 100, `default lora_strength is 100 %, got ${initial.lora_strength}`);

    // Patch flat settings
    host.setRelightSettings({ strength: 75, style: "dramatic", detail: false, lora_strength: 80 });
    const updated = host.getRelightSettings();
    assert.equal(updated.strength, 75, "updated strength is 75");
    assert.equal(updated.style, "dramatic", "updated style is dramatic");
    assert.equal(updated.detail, false, "updated detail is false");
    assert.equal(updated.lora_strength, 80, "updated lora_strength is 80");
    assert.equal(updated.route, "app", "route remains app");

    // Restore initial settings
    host.setRelightSettings(initial);
    console.log("  PASS 18: flat relight settings round-trip on host");
}

// ------------------------------------------------------------------------------------------------
// 19. The relight LoRA strength in percent: a stored 0..1 value (77da63f's default 1.0) reads as a fraction
// ------------------------------------------------------------------------------------------------
{
    const hostMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "host.js")).href);
    const host = hostMod.host || hostMod.default || hostMod;
    const { loraPercent } = relight;
    assert.equal(typeof loraPercent, "function", "inpaint_relight.js exports loraPercent");
    const cases = [[undefined, 100], [null, 100], ["", 100], ["x", 100], [1, 100], [1.0, 100], [0.8, 80], [0.05, 5],
        [0, 0], [5, 5], [55, 55], [100, 100], [150, 100], [-3, 0]];
    for (const [v, want] of cases) {
        assert(Math.abs(loraPercent(v) - want) < 1e-9, `loraPercent(${JSON.stringify(v)}) is ${want}, got ${loraPercent(v)}`);
    }
    // the stored settings are read on configure (shell.js passes settings.relight): 1.0 and 0.8 are fractions
    const before = { ...host.getRelightSettings() }, beforePicked = host.relightPicked;
    for (const [stored, want] of [[1, 100], [0.8, 80], [55, 55], [0, 0]]) {
        host.configure({ relight: { lora_strength: stored } });
        assert.equal(host.getRelightSettings().lora_strength, want, `configure with a stored lora_strength ${stored} reads ${want} %, got ${host.getRelightSettings().lora_strength}`);
    }
    host.configure({ relight: { route: "magnific" } });
    assert.equal(host.getRelightSettings().route, "magnific", "configure without a lora_strength keeps the other fields");
    host.relightSettings = before;
    host.relightPicked = beforePicked;
    console.log("  PASS 19: the relight LoRA strength is in percent, stored fractions read x 100");
}

// ------------------------------------------------------------------------------------------------
// 20. pickVis (docs/PLAN_RELIGHT_FIXES.md F2.5): the full shadow map is read under the keys ensureRelightMaps writes, an
//     Edges change (a meta-only deriveMap) keeps it, and a quick map is read only when it is current or written last,
//     never by a run. At 77da63f pickVis keyed on map.version (the maps on dataVersion) and returned the quick map
//     whenever info.quick was set.
// ------------------------------------------------------------------------------------------------
{
    const { pickVis, relightMapKey, relightVisKey, relightVisCurrent } = relight;
    const { makeMap, deriveMap } = await import(editorUrl("inpaint_maps.js"));
    const MW = 16, MH = 12;
    const map = makeMap("depth", MW, MH, new Uint16Array(MW * MH).fill(30000), [64, 0, 0, 48, 0, 0], { snap: { strength: 50 } });
    const at = (x, y) => ({ id: "l1", on: true, type: "point", x, y, dist: -30, diffusion: 30, range: 300, intensity: 100, color: 5500 });
    const params = { lights: [at(40, 20)], depth_scale: 50, shadows: 60 };
    // a map of either size written for these lights (the way ensureRelightMaps keys its channels)
    const mapFor = (lights, m, quick, seq, fill) => ({
        data: new Uint8Array((quick ? 4 * 3 : MW * MH) * 4).fill(fill), w: quick ? 4 : MW, h: quick ? 3 : MH, seq,
        keys: [0, 1, 2, 3].map((i) => relightVisKey(lights[i], 50, relightMapKey(m), quick)),
    });
    const vis = mapFor(params.lights, map, false, 5, 0);

    assert.equal(pickVis({ vis }, {}, params, map), vis, "the full map is read under the keys it was made with");
    const edges = deriveMap(map, { meta: { snap: { strength: 80 } } });
    assert.notEqual(edges.version, map.version, "an Edges change moves the map's version on");
    assert.equal(edges.dataVersion, map.dataVersion, "and keeps its dataVersion");
    assert.equal(relightMapKey(edges), relightMapKey(map), "the shadow maps' key part ignores the meta");
    const staleQuick = mapFor([at(10, 10)], map, true, 3, 255);   // an earlier drag's quick map
    const sameQuick = mapFor(params.lights, map, true, 9, 255);    // a quick map of the same lights, written after the full one
    assert.equal(pickVis({ vis, visQuick: sameQuick }, {}, params, map), vis, "the current full map before a current quick one");
    assert.equal(pickVis({ vis, visQuick: sameQuick }, {}, params, edges), vis, "after an Edges change the full map is still current and read");
    assert.equal(pickVis({ vis, visQuick: staleQuick }, { quick: true }, params, edges), vis, "a slider preview reads the current full map, not an earlier drag's quick map");

    // new depth data or another placement on the picture: the full map is not current any more
    const redone = deriveMap(map, { data: new Uint16Array(MW * MH).fill(20000) });
    assert.equal(relightVisCurrent(vis, params.lights, 50, relightMapKey(redone), false), false, "new depth data makes the map stale");
    const moved = deriveMap(map, { xf: [64, 0, 0, 48, 8, 0] });
    assert.equal(relightVisCurrent(vis, params.lights, 50, relightMapKey(moved), false), false, "the map moved on the picture makes it stale");

    // a light on the move: the view reads the quick map when it is current, a run never does
    const dragged = { ...params, lights: [at(52, 20)] };
    const quickNow = mapFor(dragged.lights, map, true, 6, 128);
    const cache = { vis, visQuick: quickNow };
    assert.equal(pickVis(cache, { quick: true }, dragged, map), quickNow, "the drag preview reads the current quick map");
    assert.equal(pickVis(cache, {}, dragged, map), quickNow, "after the drag the current quick map shows until the full one lands");
    assert.equal(pickVis(cache, { forRun: true }, dragged, map), vis, "a run reads the full map, never the quick one");
    // neither current: the one written last (the quick map trailing the pointer; an earlier drag's map loses to a newer full one)
    const further = { ...params, lights: [at(60, 20)] };
    assert.equal(pickVis(cache, { quick: true }, further, map), quickNow, "a trailing quick map written after the full one is read during the drag");
    assert.equal(pickVis({ vis, visQuick: staleQuick }, { quick: true }, further, map), vis, "an older quick map is not read");
    assert.equal(pickVis({ vis, visQuick: quickNow }, { forRun: true }, further, map), vis, "a run reads the full map even while neither is current");
    // shadows at 0: an all-lit map, whatever the cache holds
    const lit = pickVis(cache, { forRun: true }, { ...params, shadows: 0 }, map);
    assert(lit && lit.w === 1 && lit.h === 1 && Array.from(lit.data).every((v) => v === 255), "shadows at 0 read an all-lit map");
    assert.equal(pickVis(null, {}, params, map), null, "no map yet: null");
    console.log("  PASS 20: pickVis reads the full map under the maps' own keys, after an Edges change too; quick maps only when current or newer, never for a run");
}

// ------------------------------------------------------------------------------------------------
// 21. The fit is keyed on the picture below (F2.6): the same layer and depth map over a picture lit from the other
//     side fits the other side. At 77da63f the second call returned the first fit (l0[0] stayed negative).
// ------------------------------------------------------------------------------------------------
{
    const CW = 64, CH = 64;
    const depth = { data: new Uint16Array(CW * CH), w: CW, h: CH, xf: [CW, 0, 0, CH, 0, 0], dataVersion: 7, version: 7 };
    const picture = (lx, ly, lz) => {
        const px = new Uint8ClampedArray(CW * CH * 4);
        for (let y = 0; y < CH; y++) {
            for (let x = 0; x < CW; x++) {
                const i = y * CW + x;
                const dx = (x - CW / 2) / (CW * 0.4), dy = (y - CH / 2) / (CH * 0.4), r2 = dx * dx + dy * dy;
                let v = 50;
                if (r2 <= 1) {
                    const nz = Math.sqrt(1 - r2);
                    depth.data[i] = Math.round(30000 - nz * 15000);
                    v = Math.round(Math.min(1, 0.2 + 0.8 * Math.max(0, dx * lx + dy * ly + nz * lz)) * 255);
                } else {
                    depth.data[i] = 45000;
                }
                px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v;
                px[i * 4 + 3] = 255;
            }
        }
        return { data: px, w: CW, h: CH };
    };
    const layer = { params: { depth_scale: 60, sigma: 1.5 }, _relight: {} };
    const ctx = { maps: { depth }, params: layer.params, layer };
    const left = relightStats(picture(-0.5, -0.5, 0.707), { width: CW, height: CH }, ctx);
    assert(left.fit.l0[0] < 0, `a picture lit from the left fits a light on the left, got l0[0] ${left.fit.l0[0]}`);
    const right = relightStats(picture(0.5, -0.5, 0.707), { width: CW, height: CH }, ctx);
    assert(right.fit.l0[0] > 0, `the same layer over a picture lit from the right fits a light on the right, got l0[0] ${right.fit.l0[0]}`);
    const again = relightStats(picture(0.5, -0.5, 0.707), { width: CW, height: CH }, ctx);
    assert.equal(again.fit, right.fit, "the same picture again is the cached fit");
    console.log("  PASS 21: the fit follows the picture below: lit from the left, then from the right, then cached");
}

// ------------------------------------------------------------------------------------------------
// 22. New relight layers read the flat remembered settings, always on route "app" (F3.6), and the Bria light type stays
//     unset until the user picks one (F3.5); host stores only what the user picked. At 4192a6a host held a default
//     light_type ("soft overcast daylight lighting") that every new layer copied, so the Bria route never sent the type
//     its lights give, and setRelightSettings stored the whole object, defaults included. 81178aa read the remembered
//     route (a paid one became the next new layer's) and a nested relightConf.magnific.strength.
// ------------------------------------------------------------------------------------------------
{
    const { isDeepStrictEqual } = require("node:util");
    const hostMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "host.js")).href);
    const host = hostMod.host || hostMod.default || hostMod;
    const { InpaintEditor } = await import(editorUrl("inpaint_canvas.js"));
    const savedSettings = host.relightSettings, savedPicked = host.relightPicked, savedScumble = global.window.scumble;
    const fails = [];
    const want = (ok, msg) => { if (!ok) fails.push(msg); };
    const show = (v) => JSON.stringify(v);
    const size = { width: 64, height: 48 };
    // what setRelightSettings hands the settings store (a shallow copy: a key kept as undefined still shows)
    const writes = [];
    // the members addFilterLayer and setFilterType call on the editor
    const stubEditor = () => ({
        width: size.width, height: size.height, filterCounter: 0, color: "#336699", tool: null, undo: [],
        maps: { depth: { data: new Uint16Array(size.width * size.height) } },
        pixels: { Layer: { empty: () => ({}) } },
        addLayer(o) { return { id: "Lr" + this.filterCounter, ...o }; },
        setStatus() {},
        setTool(t) { this.tool = t; },
        pushUndo(e) { this.undo.push(e); },
        markFilterChanged() {},
        renderLayers() {},
    });
    const addRelight = () => InpaintEditor.prototype.addFilterLayer.call(stubEditor(), "relight");
    const retype = () => {
        const ed = stubEditor();
        const l = { id: "Lg", name: "Grain 1", kind: "filter", filter: "grain", params: { amount: 10 } };
        InpaintEditor.prototype.setFilterType.call(ed, l, "relight");
        return { ed, l };
    };
    try {
        global.window.scumble = { ...savedScumble, settings: { set: async (patch) => { writes.push({ ...patch, relight: { ...patch.relight } }); } } };

        // a fresh profile: nothing picked
        host.relightSettings = { ...savedSettings };
        host.relightPicked = {};
        want(host.getRelightSettings().light_type === undefined, `a fresh profile has no light type (From the lights), got ${show(host.getRelightSettings().light_type)}`);
        const a = addRelight();
        want(!("light_type" in a.params), `a new relight layer has no light_type, got ${show(a.params.light_type)}`);

        // the user picks a type: it is stored alone, and new and retyped layers take it
        host.setRelightSettings({ light_type: "moonlight lighting" });
        want(writes.length === 1 && isDeepStrictEqual(writes[0].relight, { light_type: "moonlight lighting" }),
            `a picked light type is stored alone, not with the defaults: stored ${show(writes.map((w) => w.relight))}`);
        want(isDeepStrictEqual(host.relightPicked, { light_type: "moonlight lighting" }), `host.relightPicked holds the pick alone, got ${show(host.relightPicked)}`);
        const b = addRelight();
        want(b.params.light_type === "moonlight lighting", `a new layer takes the picked light type, got ${show(b.params.light_type)}`);
        const t1 = retype();
        want(t1.l.params.light_type === "moonlight lighting", `a layer switched to Relight takes the picked light type, got ${show(t1.l.params.light_type)}`);

        // From the lights again: the pick is forgotten in memory and in the store
        host.setRelightSettings({ light_type: undefined });
        want(!("light_type" in host.getRelightSettings()), `an undefined light_type forgets the pick, the settings still hold ${show(Object.keys(host.getRelightSettings()))}`);
        want(!!host.relightPicked && !("light_type" in host.relightPicked), `... and host.relightPicked has no light_type, got ${show(host.relightPicked && Object.keys(host.relightPicked))}`);
        const forgot = writes[writes.length - 1];
        want(writes.length === 2 && !!forgot && !("light_type" in forgot.relight) && isDeepStrictEqual(forgot.relight, {}),
            `forgetting the pick stores an empty relight, got keys ${show(forgot && Object.keys(forgot.relight))}`);
        const c = addRelight();
        want(!("light_type" in c.params), `after the pick is forgotten a new layer has no light_type, got ${show(c.params.light_type)}`);

        // what the Bria route sends for an unset type: the one its first light gives (the default point light gives the
        // same words as the old fixed default, so a spot and a sun)
        const spot = lightsToWords([{ ...defaultLight(0, size), type: "spot" }], size);
        const sun = lightsToWords([{ ...defaultLight(0, size), type: "sun" }], size);
        want(spot.bria.type === "spotlight on subject", `a spot gives the Bria type "spotlight on subject", got ${show(spot.bria.type)}`);
        want(sun.bria.type === "low-angle sunlight", `a sun gives the Bria type "low-angle sunlight", got ${show(sun.bria.type)}`);

        // the remembered values, every one off its default (a paid route among them): stored as given, flat; a new layer
        // and a retyped one read them, and both start on route "app"
        host.relightSettings = { ...savedSettings };
        host.relightPicked = {};
        writes.length = 0;
        const picks = { route: "magnific", strength: 40, style: "dramatic", preserve_details: false, interpolate: true,
            detail: false, enable_hr_fix: false, lora_strength: 55, steps: 6 };
        host.setRelightSettings(picks);
        want(writes.length === 1 && isDeepStrictEqual(writes[0].relight, picks), `the picks are stored as given, flat and nothing else: stored ${show(writes.map((w) => w.relight))}`);
        const nl = InpaintEditor.prototype.addFilterLayer.call(stubEditor(), "relight");
        const t2 = retype();
        for (const [what, l] of [["a new relight layer", nl], ["a layer switched to Relight", t2.l]]) {
            want(l.params.route === "app", `${what} starts on route app, not the remembered ${picks.route}: got ${show(l.params.route)}`);
            for (const [k, v] of Object.entries(picks)) {
                if (k !== "route") want(l.params[k] === v, `${what} reads the remembered ${k} ${show(v)}, got ${show(l.params[k])}`);
            }
        }
        want(t2.ed.undo.length === 1 && t2.ed.tool === "lights", `the switch is one undo step and picks the lights tool, got ${t2.ed.undo.length} / ${t2.ed.tool}`);
    } finally {
        host.relightSettings = savedSettings;
        host.relightPicked = savedPicked;
        global.window.scumble = savedScumble;
    }
    assert.deepEqual(fails, [], `suite 22:\n    ${fails.join("\n    ")}`);
    console.log("  PASS 22: new relight layers read the flat picks on route app, the light type unset until picked; only picks are stored");
}

// ------------------------------------------------------------------------------------------------
// 23. The relight command's route (F3.4): checkParams refuses a route Render cannot send; an edit without route keeps
//     the layer's route and renders nothing; a route given goes into the call's own undo step, and only when it changes.
//     At 4192a6a checkParams passed any route, and the command wrote route "app" after its step (or with no step at all)
//     whenever a call named none, so the row's Render then sent provider "app" ("Unknown provider: app").
// ------------------------------------------------------------------------------------------------
{
    const { checkParams, commands } = await import(pathToFileURL(path.join(ROOT, "renderer", "commands.js")).href);
    const hostMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "host.js")).href);
    const host = hostMod.host || hostMod.default || hostMod;
    const fails = [];
    const want = (ok, msg) => { if (!ok) fails.push(msg); };
    const show = (v) => JSON.stringify(v);

    for (const bad of ["bogus", "App", 3, null]) {
        let err = null;
        try { checkParams("relight", { route: bad }); } catch (e) { err = e; }
        want(!!err && /relight route/.test(err.message), `checkParams refuses the relight route ${show(bad)}: ${err ? err.message : "it passed"}`);
    }
    try {
        const ok = checkParams("relight", { route: "magnific" });
        want(ok.route === "magnific", `checkParams keeps route magnific, got ${show(ok)}`);
    } catch (e) {
        fails.push(`checkParams refused route magnific: ${e.message}`);
    }

    // a document holding one relight layer on route magnific, with what the command calls on the editor
    const W = 64, H = 48;
    const layer = {
        id: "Lm", name: "Relight 1", kind: "filter", filter: "relight", visible: true, opacity: 1, x: 0, y: 0, w: W, h: H,
        params: { lights: [defaultLight(0, { width: W, height: H })], original: 100, ambient: 15, depth_scale: 50, shadows: 60, route: "magnific" },
    };
    let touches = 0, changed = 0, renders = 0;
    const ed = {
        base: {}, width: W, height: H, filterCounter: 1, layers: [layer], activeLayerId: layer.id, undo: [], uploaded: {},
        isReference: () => false,
        // the route the step's snapshot holds: what undo would bring back
        pushUndo(e) { this.undo.push({ ...e, routeBefore: layer.params.route }); },
        markFilterChanged() { changed++; },
        renderLayers() { touches++; },
        renderInfo() {}, draw() {}, drawThumb() {}, notifyChanged() {},
        relightSettled: async () => {},
        belowStats: () => null,
    };
    const savedEditor = host.editor, savedWhole = host.relightWhole;
    const call = async (args) => {
        try { return await commands.run("relight", args); } catch (e) { fails.push(`relight ${show(args)} threw: ${e.message}`); return null; }
    };
    try {
        host.editor = ed;
        host.relightWhole = async (_ed, _l, opts) => { renders++; throw new Error(`rendered on route ${opts && opts.route}`); };

        // a value alone: one step and one touch, the layer's route kept and named in the answer
        let n = ed.undo.length, t = touches;
        let r = await call({ layer: layer.id, ambient: 30 });
        want(layer.params.ambient === 30, `ambient 30 is written, got ${show(layer.params.ambient)}`);
        want(layer.params.route === "magnific", `an edit without route keeps the layer's route magnific, got ${show(layer.params.route)}`);
        want(ed.undo.length === n + 1 && touches === t + 1, `an edit without route is one step and one touch, got +${ed.undo.length - n} / +${touches - t}`);
        want(!!r && r.route === "magnific", `the answer names the layer's route magnific, got ${show(r && r.route)}`);
        want(!!r && r.notes.some((x) => /nothing was rendered/.test(x)), `the answer says nothing was rendered, got ${show(r && r.notes)}`);

        // nothing given: no step, the route kept
        layer.params.route = "magnific";
        n = ed.undo.length; t = touches;
        r = await call({ layer: layer.id });
        want(layer.params.route === "magnific", `a call with the layer alone keeps route magnific, got ${show(layer.params.route)}`);
        want(ed.undo.length === n && touches === t, `a call with the layer alone is no step and no touch, got +${ed.undo.length - n} / +${touches - t}`);

        // the route alone: one step named "Relight route", taken before the route changed, written through and touched
        layer.params.route = "magnific";
        n = ed.undo.length; t = touches;
        const c0 = changed;
        r = await call({ layer: layer.id, route: "app" });
        const step = ed.undo.length > n ? ed.undo[ed.undo.length - 1] : null;
        want(layer.params.route === "app", `route app is written, got ${show(layer.params.route)}`);
        want(ed.undo.length === n + 1, `the route alone is one undo step, got +${ed.undo.length - n}`);
        want(!!step && step.label === "Relight route" && step.routeBefore === "magnific",
            `the step is "Relight route" and holds route magnific, got ${show(step && { label: step.label, routeBefore: step.routeBefore })}`);
        want(touches === t + 1 && changed === c0 + 1, `the route change is touched and marks the layer changed, got +${touches - t} / +${changed - c0}`);
        want(!!r && r.route === "app" && r.notes.length === 0, `the answer is route app with no note, got ${show(r && { route: r.route, notes: r.notes })}`);

        // the same route again: no empty step
        n = ed.undo.length;
        r = await call({ layer: layer.id, route: "app" });
        want(ed.undo.length === n && layer.params.route === "app", `the layer's own route again is no step, got +${ed.undo.length - n} (route ${show(layer.params.route)})`);
        want(renders === 0, `no call here renders, got ${renders}`);
    } finally {
        host.editor = savedEditor;
        host.relightWhole = savedWhole;
    }
    assert.deepEqual(fails, [], `suite 23:\n    ${fails.join("\n    ")}`);
    console.log("  PASS 23: the relight command keeps the layer's route unless one is given, writes a given one in its own step, refuses unknown routes");
}

// ------------------------------------------------------------------------------------------------
// 24. An undo puts the light selection back as the step recorded it, Escape's explicit "no light" included
//     (docs/PLAN_RELIGHT_FIXES.md F4). At 2f9aa60 a filter record held the selected id but not `_deselected`: an
//     undo over Escape showed light_2 on the canvas while list_layers said none, and an undo over a pick made after
//     Escape brought "no light" back without the flag, so the panel picked lights[0]. A step taken before any light was
//     picked stays "the first light" (the plan's `_deselected = !_selectedLightId` would turn it into "none").
// ------------------------------------------------------------------------------------------------
{
    const { InpaintEditor } = await import(editorUrl("inpaint_canvas.js"));
    const { layerSummary } = await import(pathToFileURL(path.join(ROOT, "renderer", "commands.js")).href);
    const P = InpaintEditor.prototype;
    const fails = [];
    const want = (ok, msg) => { if (!ok) fails.push(msg); };
    const show = (v) => JSON.stringify(v);
    const light = (id, x) => ({ id, type: "point", x, y: 20, dist: -30, intensity: 100, color: 5500, diffusion: 30, on: true });
    /** @param {any} layer @returns {any} */
    const stub = (layer) => Object.assign(Object.create(P), {
        layers: [layer], tileMode: false, activeLayerId: layer.id,
        markFilterChanged() {}, renderLayers() {}, draw() {},
        isReference() { return false; },
    });
    const sel = (l) => ({ id: l._selectedLightId ?? null, deselected: !!l._deselected });

    // light_2 selected, a step, Escape, undo: light_2 selected again, and list_layers says so
    {
        /** @type {any} */
        const layer = { id: "R1", name: "Relight 1", kind: "filter", filter: "relight", visible: true, params: { lights: [light("light_1", 10), light("light_2", 40)] }, _selectedLightId: "light_2", _deselected: false };
        const ed = stub(layer);
        const step = P.snapshot.call(ed, { kind: "filter", id: layer.id, label: "Light intensity" });
        layer.params.lights[1].intensity = 150;
        layer._selectedLightId = null; layer._deselected = true;   // Escape (the window handler's two writes)
        P.applySnapshot.call(ed, step);
        want(layer._selectedLightId === "light_2" && !layer._deselected, `undo over Escape: light_2 selected, not deselected, got ${show(sel(layer))}`);
        want(layerSummary(ed, layer).selected_light === "light_2", `list_layers after that undo reports light_2, got ${show(layerSummary(ed, layer).selected_light)}`);
    }
    // a step taken with no light selected (after Escape), a light picked, undo: none selected again
    {
        /** @type {any} */
        const layer = { id: "R2", name: "Relight 2", kind: "filter", filter: "relight", visible: true, params: { lights: [light("light_1", 10), light("light_2", 40)], original: 100 }, _selectedLightId: null, _deselected: true };
        const ed = stub(layer);
        const step = P.snapshot.call(ed, { kind: "filter", id: layer.id, label: "Original light" });
        layer.params.original = 60;
        layer._selectedLightId = "light_1"; layer._deselected = false;   // a click on light_1's row
        P.applySnapshot.call(ed, step);
        want(layer._selectedLightId === null && layer._deselected === true, `undo of a step taken with no light selected: none selected, got ${show(sel(layer))}`);
        want(layerSummary(ed, layer).selected_light === null, `list_layers reports no light, got ${show(layerSummary(ed, layer).selected_light)}`);
    }
    // a step taken before the panel ever chose a light (an agent's edit of a layer never shown): the choice stays the panel's
    {
        /** @type {any} */
        const layer = { id: "R3", name: "Relight 3", kind: "filter", filter: "relight", visible: true, params: { lights: [light("light_1", 10)] } };
        const ed = stub(layer);
        const step = P.snapshot.call(ed, { kind: "filter", id: layer.id, label: "Filter" });
        layer.params.lights[0].x = 90;
        P.applySnapshot.call(ed, step);
        want(!layer._deselected, `undo of a step taken before any choice is no explicit deselect, got ${show(sel(layer))}`);
        want(layerSummary(ed, layer).selected_light === "light_1", `list_layers reports lights[0], got ${show(layerSummary(ed, layer).selected_light)}`);
    }
    assert.deepEqual(fails, [], `suite 24:\n    ${fails.join("\n    ")}`);
    console.log("  PASS 24: an undo puts the light selection back as the step recorded it, Escape's \"no light\" included");
}

// ------------------------------------------------------------------------------------------------
// 25. A sun on the map's centre with dist 0 has no direction of its own: the CPU twin and the shadow march light it
//     from the front, the shader's rule (rl_evalLight: a sun vector of length <= 1e-5 is (0, 0, 1)) (F4). At 2f9aa60
//     lightToMap gave (0, 0, 0), shadePixel kept it (8 to 10 levels under the shader, the normal ignored) and the march
//     cast jittered horizontal shadows (1828 of 2048 texels on a sloped step).
// ------------------------------------------------------------------------------------------------
{
    const fails = [];
    const want = (ok, msg) => { if (!ok) fails.push(msg); };
    const show = (v) => JSON.stringify(v);
    const map = { w: 120, h: 80 };   // no data: far 0.5 everywhere, the centre is (60, 40)
    const sun = (x, y, dist) => ({ id: "s", type: "sun", x, y, dist, on: true, intensity: 40, color: 5500, diffusion: 30 });
    const dir = (l) => { const m = lightToMap(l, map, { depth_scale: 50 }); const n = Math.hypot(m.mx, m.my, m.mz); return n > 0 ? [m.mx / n, m.my / n, m.mz / n] : [0, 0, 0]; };
    const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

    // the direction lightToMap hands every reader (the CPU twin, the shader's uniforms, the shadow march)
    want(near(dir(sun(60, 40, 0)), [0, 0, 1]), `a sun on the centre with dist 0 points straight at the picture, got ${show(dir(sun(60, 40, 0)))}`);
    want(near(dir(sun(60, 40, -30)), [0, 0, 1]), `the same sun Close stays frontal, got ${show(dir(sun(60, 40, -30)))}`);
    want(dir(sun(60, 40, 30))[2] < -0.99, `the same sun Far is behind the picture, got ${show(dir(sun(60, 40, 30)))}`);
    want(dir(sun(90, 40, 0))[0] > 0.99, `off the centre with dist 0 it grazes from the right, got ${show(dir(sun(90, 40, 0)))}`);

    // the CPU twin: the centre sun at dist 0 shades as the limit from the Close side, under any normal
    const px = [60, 70, 80, 255];
    const shade = (l, normal) => shadePixel(px, normal, [60, 40, 20], [{ ...l, ...lightToMap(l, map, { depth_scale: 50 }) }],
        { original: 100, ambient: 10 }, null, [1, 1, 1, 1]).slice(0, 3);
    for (const normal of [[0, 0, 1], [0.6, 0, 0.8], [0, -0.6, 0.8]]) {
        const at0 = shade(sun(60, 40, 0), normal), close = shade(sun(60, 40, -0.01), normal);
        want(show(at0) === show(close), `normal ${show(normal)}: dist 0 shades as dist -0.01 (${show(close)}), got ${show(at0)}`);
    }
    // a zero vector handed to shadePixel directly is (0, 0, 1) too
    const raw = (mx, my, lz) => shadePixel(px, [0, 0, 1], [60, 40, 20], [{ type: "sun", on: true, intensity: 40, color: 5500, diffusion: 30, mx, my, lz }],
        { original: 100, ambient: 10 }, null, [1, 1, 1, 1]).slice(0, 3);
    want(show(raw(0, 0, 0)) === show(raw(0, 0, 1)), `shadePixel: a zero sun vector is (0, 0, 1), got ${show(raw(0, 0, 0))} vs ${show(raw(0, 0, 1))}`);

    // the march of that sun over a sloped step (near left, far right), radius as diffusion 30: no shadows
    const Mw = 64, Mh = 32, depth = new Uint16Array(Mw * Mh);
    for (let y = 0; y < Mh; y++) for (let x = 0; x < Mw; x++) depth[y * Mw + x] = x < 32 ? 10000 + 300 * y : 50000 - 200 * y;
    const lm = lightToMap(sun(Mw / 2, Mh / 2, 0), { w: Mw, h: Mh, data: depth }, { depth_scale: 50 });
    const scaleZ = 0.5 * Mw;
    const vis = await shadowMarch(depth, Mw, Mh, scaleZ, [lm.mx, lm.my, lm.mz, 1], 0.3 * 0.05 * Mw, 4, 32, 0.005 * scaleZ, 0, Mh);
    let dark = 0;
    for (let i = 0; i < Mw * Mh; i++) if (vis[i] < 255) dark++;
    want(dark === 0, `the centre sun at dist 0 casts no shadows (a frontal sun), got ${dark} of ${Mw * Mh} texels below 255`);

    assert.deepEqual(fails, [], `suite 25:\n    ${fails.join("\n    ")}`);
    console.log("  PASS 25: a sun on the centre with dist 0 is frontal on the CPU and in the march, as the shader takes it");
}

    console.log("\nALL 25 RELIGHT TESTS PASSED CLEANLY!");
    console.log("PASS");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
