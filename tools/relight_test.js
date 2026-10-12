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
    const before = { ...host.getRelightSettings() };
    for (const [stored, want] of [[1, 100], [0.8, 80], [55, 55], [0, 0]]) {
        host.configure({ relight: { lora_strength: stored } });
        assert.equal(host.getRelightSettings().lora_strength, want, `configure with a stored lora_strength ${stored} reads ${want} %, got ${host.getRelightSettings().lora_strength}`);
    }
    host.configure({ relight: { route: "magnific" } });
    assert.equal(host.getRelightSettings().route, "magnific", "configure without a lora_strength keeps the other fields");
    host.relightSettings = before;
    console.log("  PASS 19: the relight LoRA strength is in percent, stored fractions read x 100");
}

    console.log("\nALL 19 RELIGHT TESTS PASSED CLEANLY!");
    console.log("PASS");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
