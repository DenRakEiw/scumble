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
    console.log("  PASS 1: identity at defaults");
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
// 5. A light behind the surface lights nothing without wrap
// ------------------------------------------------------------------------------------------------
{
    // Surface normal facing camera: n = (0, 0, 1)
    const normal = [0, 0, 1];
    const src = [100, 100, 100, 255];
    const params = { original: 0, ambient: 0, shadows: 0 };

    // Light behind edge: normal is (0, 0, 1), light is to the side and behind (dirZ = -0.2)
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
    console.log("  PASS 5: light behind surface requires diffusion wrap to illuminate front face");
}

// ------------------------------------------------------------------------------------------------
// 6. kelvinToRgb(5500) ~= 1
// ------------------------------------------------------------------------------------------------
{
    const rgb5500 = kelvinToRgb(5500);
    assert(Math.abs(rgb5500[0] - 1.0) < 1e-6, "5500K red is 1.0");
    assert(Math.abs(rgb5500[1] - 1.0) < 1e-6, "5500K green is 1.0");
    assert(Math.abs(rgb5500[2] - 1.0) < 1e-6, "5500K blue is 1.0");
    console.log("  PASS 6: kelvinToRgb(5500) is exactly [1, 1, 1]");
}

// ------------------------------------------------------------------------------------------------
// 7. 2700 K warmer than 8000 K
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
    const mapped = lightToMap({ type: "point", x: 10, y: 20, z: 30, dist: 40 }, null, null);
    assert(Number.isFinite(mapped.lz), "lightToMap lz finite");
    const stats = relightStats(null, null, null);
    assert(stats && stats.fit, "relightStats fallback fit");
    console.log("  PASS 7: 2700 K is warmer than 8000 K and color helpers work");
}

// ------------------------------------------------------------------------------------------------
// 8. fitOriginalLight on a synthetic sphere recovers the direction within 10 degrees
// ------------------------------------------------------------------------------------------------
{
    const W = 256, H = 256;
    const small = new Uint8Array(W * H * 4);
    const normals = new Uint8Array(W * H * 4);

    const L_true = [-0.5, -0.3, 0.8];
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
    assert(angleDeg <= 10.0, `fit direction angle error ${angleDeg.toFixed(2)} deg <= 10 deg`);
    assert(fit.ka >= 0, "ka non-negative");
    assert(fit.kd >= 0, "kd non-negative");

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
    console.log(`  PASS 8: fitOriginalLight recovered sphere direction within ${angleDeg.toFixed(2)} deg (<= 10 deg)`);
}

// ------------------------------------------------------------------------------------------------
// 9. normalizeLights drops the fifth light and clamps fields
// ------------------------------------------------------------------------------------------------
{
    const rawList = [
        { id: "custom_a", type: "point", x: 10, y: 20, dist: -150, intensity: 500, color: 15000, unknownField: "bad" },
        { id: "custom_b", type: "spot", x: 100, y: 100, dist: 200, intensity: -50, color: 500 },
        { id: "custom_c", type: "sun", x: 200, y: 200, dist: 50, intensity: 100, color: "#ff8800" },
        { id: "custom_d", type: "invalid_type", x: 300, y: 300 },
        { id: "custom_e", type: "point", x: 400, y: 400 }, // Fifth light - should be dropped!
    ];
    const norm = normalizeLights(rawList);
    assert.equal(norm.length, LIGHT_MAX, `at most ${LIGHT_MAX} lights kept`);
    assert.equal(norm[0].dist, -100, "dist clamped to -100");
    assert.equal(norm[0].intensity, 300, "intensity clamped to 300");
    assert.equal(norm[0].color, 10000, "color clamped to 10000");
    assert.equal(norm[0].unknownField, undefined, "unknown field dropped");
    assert.equal(norm[1].dist, 100, "dist clamped to 100");
    assert.equal(norm[1].intensity, 0, "intensity clamped to 0");
    assert.equal(norm[1].color, 1000, "color clamped to 1000");
    assert.equal(norm[2].color, "#ff8800", "valid hex color preserved");
    assert.equal(norm[3].type, "point", "invalid type falls back to point");
    console.log("  PASS 9: normalizeLights clamps, drops 5th light and unknown fields");
}

// ------------------------------------------------------------------------------------------------
// 10. lightsToWords for the four corners and a rim light
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
    assert(wordsRim.prompt.includes("rim light") || wordsRim.prompt.includes("behind"), "identifies rim light");

    // ICLight latent enum check
    const lightLeft = [{ ...defaultLight(0, size), x: 100, y: 500, dist: -30 }];
    const wordsLeft = lightsToWords(lightLeft, size);
    assert.equal(wordsLeft.latent, "Left", "latent is Left for light on left");

    const lightRight = [{ ...defaultLight(0, size), x: 900, y: 500, dist: -30 }];
    const wordsRight = lightsToWords(lightRight, size);
    assert.equal(wordsRight.latent, "Right", "latent is Right for light on right");

    console.log("  PASS 10: lightsToWords describes directions, corners, and rim lights");
}

// ------------------------------------------------------------------------------------------------
// 11. heightNormals on a ramp gives the ramp's normal
// ------------------------------------------------------------------------------------------------
{
    const W = 64, H = 32;
    const depth = new Uint16Array(W * H);
    const scale = 50.0;

    // Linear horizontal ramp: depth increases from left (0) to right (65535)
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

    // dz/dx > 0, so normal nx = -dz/dx should be negative
    assert(nx < -0.1, `ramp normal nx should be negative: got ${nx}`);
    assert(Math.abs(ny) < 0.05, `ramp normal ny should be approximately 0: got ${ny}`);
    assert(nz > 0.5, `ramp normal nz should be positive: got ${nz}`);
    console.log("  PASS 11: heightNormals computes analytic normal on depth ramp");
}

// ------------------------------------------------------------------------------------------------
// 12. shadowMarch on a step occludes behind the step and not in front
// ------------------------------------------------------------------------------------------------
{
    const W = 100, H = 20;
    const depth = new Uint16Array(W * H);
    const scale = 100.0;

    // Step at x = 50: low ground on left (depth = 10000), high ground on right (depth = 50000)
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            depth[y * W + x] = x < 50 ? 10000 : 50000;
        }
    }

    // Light above the high ground at (80, 10, 100)
    const light = [80, 10, 100, 0];
    const vis = shadowMarch(depth, W, H, scale, light, 0, 4, 32, 1.0, 0, H);

    // Pixel at x = 20 (on low ground, behind the step from the light)
    const visBehind = vis[10 * W + 20];
    assert.equal(visBehind, 0, `behind step must be in shadow: got ${visBehind}`);

    // Pixel at x = 80 (directly under the light, in front of the step)
    const visInFront = vis[10 * W + 80];
    assert.equal(visInFront, 255, `in front of step must be lit: got ${visInFront}`);
    console.log("  PASS 12: shadowMarch occludes behind step and illuminates in front");
}

// ------------------------------------------------------------------------------------------------
// 13. A disc radius softens the edge monotonically
// ------------------------------------------------------------------------------------------------
{
    const W = 100, H = 20;
    const depth = new Uint16Array(W * H);
    const scale = 100.0;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            depth[y * W + x] = x < 50 ? 10000 : 50000;
        }
    }

    // Light at (60, 10, 100)
    const light = [60, 10, 100, 0];
    const visR0 = shadowMarch(depth, W, H, scale, light, 0, 16, 32, 1.0, 0, H);
    const visR5 = shadowMarch(depth, W, H, scale, light, 5, 16, 32, 1.0, 0, H);
    const visR15 = shadowMarch(depth, W, H, scale, light, 15, 16, 32, 1.0, 0, H);

    // At edge x = 49 (just on the shadowed side of the step)
    // Larger radius should cast partial light over the edge into the shadow
    const v0 = visR0[10 * W + 49];
    const v5 = visR5[10 * W + 49];
    const v15 = visR15[10 * W + 49];

    assert(v0 <= v5, `penumbra: r0 (${v0}) <= r5 (${v5})`);
    assert(v5 <= v15, `penumbra: r5 (${v5}) <= r15 (${v15})`);
    console.log(`  PASS 13: disc radius softens penumbra monotonically (r0=${v0}, r5=${v5}, r15=${v15})`);
}

    console.log("\nALL 13 RELIGHT TESTS PASSED CLEANLY!");
    console.log("PASS");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
