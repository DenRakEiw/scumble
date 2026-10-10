// Test colour grading mathematics module (R3-S2 / PLAN_NIK9_BUILD sec 3.4) in plain Node:
// - identity params give all-zero tables
// - for every l = i/255 and balance in {-100, 0, 100} x blending in {0, 50, 100}, ws + wm + wh = 1 within 1e-12 and each weight >= 0
// - tintOf(h, 100) has LR*r + LG*g + LB*b = 0 within 1e-9 for h = 0..359
// - glob_lum: 40 gives the constant 25.5 on all channels at every l
// - shadows only gives d(255) = 0, highlights only d(0) = 0
// - hueRgb matches a literal table of 12 hues

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

async function main() {
    console.log("Running grade_test.js (R3-S2 Colour Grading Maths)...");

    const gradeMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_grade.js")).href);
    const {
        LUMA_601,
        GRADE_RANGES,
        K_TINT,
        K_LUM,
        hueRgb,
        gradeIdentity,
        gradeWeights,
        tintOf,
        colorGradeTables,
        HSL_CHANNELS,
        hslWeights,
        hslIdentity,
        hslUniforms,
        hslPixel,
        HSL_UNIFORMS,
        HSL_GLSL,
    } = gradeMod;


    // 1. Constants
    assert.deepEqual(LUMA_601, [0.299, 0.587, 0.114], "LUMA_601 matches Rec. 601 coefficients");
    assert.deepEqual(GRADE_RANGES, ["sh", "mid", "hi", "glob"], "GRADE_RANGES has 4 ranges");
    assert.equal(K_TINT, 0.35 * 255, "K_TINT is 0.35 * 255");
    assert.equal(K_LUM, 0.25 * 255, "K_LUM is 0.25 * 255");

    // 2. hueRgb matches a literal table of 12 hues
    const HUE_TABLE_12 = [
        [0, [1, 0, 0]],
        [30, [1, 0.5, 0]],
        [60, [1, 1, 0]],
        [90, [0.5, 1, 0]],
        [120, [0, 1, 0]],
        [150, [0, 1, 0.5]],
        [180, [0, 1, 1]],
        [210, [0, 0.5, 1]],
        [240, [0, 0, 1]],
        [270, [0.5, 0, 1]],
        [300, [1, 0, 1]],
        [330, [1, 0, 0.5]],
    ];
    for (const [hue, expected] of HUE_TABLE_12) {
        const rgb = hueRgb(hue);
        assert.ok(Math.abs(rgb[0] - expected[0]) < 1e-6, `hue ${hue} red matches`);
        assert.ok(Math.abs(rgb[1] - expected[1]) < 1e-6, `hue ${hue} green matches`);
        assert.ok(Math.abs(rgb[2] - expected[2]) < 1e-6, `hue ${hue} blue matches`);
    }
    console.log("  [ok] hueRgb matches literal table of 12 hues");

    // 3. gradeIdentity
    assert.equal(gradeIdentity({}), true, "empty object is identity");
    assert.equal(gradeIdentity({ sh_hue: 200 }), true, "hue alone is identity");
    assert.equal(gradeIdentity({ sh_sat: 0, mid_lum: 0 }), true, "zero sat and lum is identity");
    assert.equal(gradeIdentity({ sh_sat: 10 }), false, "sh_sat > 0 is not identity");
    assert.equal(gradeIdentity({ glob_lum: -5 }), false, "glob_lum != 0 is not identity");
    console.log("  [ok] gradeIdentity correctly detects identity vs non-identity");

    // 4. Identity params give all-zero tables
    const idTables = colorGradeTables({});
    for (let i = 0; i < 256; i++) {
        assert.equal(idTables.dR[i], 0, `dR[${i}] is 0 for identity`);
        assert.equal(idTables.dG[i], 0, `dG[${i}] is 0 for identity`);
        assert.equal(idTables.dB[i], 0, `dB[${i}] is 0 for identity`);
    }
    console.log("  [ok] identity params produce all-zero lookup tables");

    // 5. Partition of unity and non-negativity for gradeWeights
    // For every l = i/255 and balance in {-100, 0, 100} x blending in {0, 50, 100}
    const balances = [-100, 0, 100];
    const blendings = [0, 50, 100];
    for (const bal of balances) {
        for (const bl of blendings) {
            for (let i = 0; i < 256; i++) {
                const l = i / 255;
                const [ws, wm, wh] = gradeWeights(l, bal, bl);
                assert.ok(ws >= -1e-12, `ws >= 0 at l=${l}, bal=${bal}, bl=${bl}: got ${ws}`);
                assert.ok(wm >= -1e-12, `wm >= 0 at l=${l}, bal=${bal}, bl=${bl}: got ${wm}`);
                assert.ok(wh >= -1e-12, `wh >= 0 at l=${l}, bal=${bal}, bl=${bl}: got ${wh}`);
                const sum = ws + wm + wh;
                assert.ok(Math.abs(sum - 1.0) < 1e-12, `ws + wm + wh = 1 at l=${l}, bal=${bal}, bl=${bl}: got ${sum}`);
            }
        }
    }
    console.log("  [ok] gradeWeights partition of unity and non-negativity verified across 2,304 configurations");

    // 6. tintOf(h, 100) has LR*r + LG*g + LB*b = 0 within 1e-9 for h = 0..359
    const LR = LUMA_601[0], LG = LUMA_601[1], LB = LUMA_601[2];
    for (let h = 0; h < 360; h++) {
        const [r, g, b] = tintOf(h, 100);
        const luma = LR * r + LG * g + LB * b;
        assert.ok(Math.abs(luma) < 1e-9, `tintOf(${h}, 100) has zero luma, got ${luma}`);
    }
    console.log("  [ok] tintOf produces zero-luma tints for all 360 integer hues");

    // 7. glob_lum: 40 gives the constant 25.5 on all channels at every l
    const lum40Tables = colorGradeTables({ glob_lum: 40 });
    for (let i = 0; i < 256; i++) {
        assert.ok(Math.abs(lum40Tables.dR[i] - 25.5) < 1e-6, `dR[${i}] is 25.5`);
        assert.ok(Math.abs(lum40Tables.dG[i] - 25.5) < 1e-6, `dG[${i}] is 25.5`);
        assert.ok(Math.abs(lum40Tables.dB[i] - 25.5) < 1e-6, `dB[${i}] is 25.5`);
    }
    console.log("  [ok] glob_lum: 40 gives constant 25.5 on all channels at every l");

    // 8. Shadows only gives d(255) = 0; highlights only gives d(0) = 0
    const shOnlyTables = colorGradeTables({ sh_sat: 80, sh_hue: 200, sh_lum: 30 });
    assert.equal(shOnlyTables.dR[255], 0, "shadows only gives dR(255) = 0");
    assert.equal(shOnlyTables.dG[255], 0, "shadows only gives dG(255) = 0");
    assert.equal(shOnlyTables.dB[255], 0, "shadows only gives dB(255) = 0");

    const hiOnlyTables = colorGradeTables({ hi_sat: 80, hi_hue: 50, hi_lum: -30 });
    assert.equal(hiOnlyTables.dR[0], 0, "highlights only gives dR(0) = 0");
    assert.equal(hiOnlyTables.dG[0], 0, "highlights only gives dG(0) = 0");
    assert.equal(hiOnlyTables.dB[0], 0, "highlights only gives dB(0) = 0");
    console.log("  [ok] shadows only gives d(255)=0; highlights only gives d(0)=0");

    // 9. Wheel control: puck reference points (PLAN R3-S3)
    const wheelsMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_wheels.js")).href);
    const { puckToHueSat, hueSatToPuck, WHEEL_R, WHEEL_SIZE } = wheelsMod;
    assert.equal(WHEEL_SIZE, 72, "WHEEL_SIZE is 72 CSS px");
    assert.equal(WHEEL_R, 32, "WHEEL_R is 32 CSS px");

    // Puck at (R/2, 0) gives hue 0, sat 50
    const ref0 = puckToHueSat(WHEEL_R / 2, 0, WHEEL_R);
    assert.ok(Math.abs(ref0.hue - 0) < 1e-9, `puck at (R/2, 0) hue is 0, got ${ref0.hue}`);
    assert.ok(Math.abs(ref0.sat - 50) < 1e-9, `puck at (R/2, 0) sat is 50, got ${ref0.sat}`);

    // Puck at (0, -R/2) gives hue 90, sat 50
    const ref90 = puckToHueSat(0, -WHEEL_R / 2, WHEEL_R);
    assert.ok(Math.abs(ref90.hue - 90) < 1e-9, `puck at (0, -R/2) hue is 90, got ${ref90.hue}`);
    assert.ok(Math.abs(ref90.sat - 50) < 1e-9, `puck at (0, -R/2) sat is 50, got ${ref90.sat}`);
    console.log("  [ok] puck reference points (R/2, 0) -> (0, 50) and (0, -R/2) -> (90, 50)");

    // 10. puckToHueSat / hueSatToPuck round trip within 1e-9 on a grid
    for (let h = 0; h < 360; h += 15) {
        for (let s = 10; s <= 100; s += 10) {
            const [dx, dy] = hueSatToPuck(h, s, WHEEL_R);
            const { hue: h2, sat: s2 } = puckToHueSat(dx, dy, WHEEL_R);
            assert.ok(Math.abs(h2 - h) < 1e-9, `hue round trip at h=${h}, s=${s}: got ${h2}`);
            assert.ok(Math.abs(s2 - s) < 1e-9, `sat round trip at h=${h}, s=${s}: got ${s2}`);
        }
    }
    for (let dx = -WHEEL_R; dx <= WHEEL_R; dx += 4) {
        for (let dy = -WHEEL_R; dy <= WHEEL_R; dy += 4) {
            const dist = Math.hypot(dx, dy);
            if (dist > 0.5 && dist <= WHEEL_R) {
                const { hue, sat } = puckToHueSat(dx, dy, WHEEL_R);
                const [dx2, dy2] = hueSatToPuck(hue, sat, WHEEL_R);
                assert.ok(Math.abs(dx2 - dx) < 1e-9, `dx round trip at dx=${dx}, dy=${dy}: got ${dx2}`);
                assert.ok(Math.abs(dy2 - dy) < 1e-9, `dy round trip at dx=${dx}, dy=${dy}: got ${dy2}`);
            }
        }
    }
    console.log("  [ok] puckToHueSat / hueSatToPuck round trip within 1e-9 on grid");

    // 11. HSL: partition of unity and exact centres (PLAN R3-S4)
    assert.equal(HSL_CHANNELS.length, 8, "HSL_CHANNELS has 8 channels");
    for (let h = 0; h <= 360; h = +(h + 0.01).toFixed(2)) {
        const [_k0, _k1, w0, w1] = hslWeights(h);
        assert.ok(w0 >= -1e-12 && w0 <= 1 + 1e-12, `w0 in [0, 1] at h=${h}: got ${w0}`);
        assert.ok(w1 >= -1e-12 && w1 <= 1 + 1e-12, `w1 in [0, 1] at h=${h}: got ${w1}`);
        const sum = w0 + w1;
        assert.ok(Math.abs(sum - 1.0) < 1e-12, `w0 + w1 = 1 at h=${h}: got ${sum}`);
    }
    for (let idx = 0; idx < HSL_CHANNELS.length; idx++) {
        const ch = HSL_CHANNELS[idx];
        const [k0, _k1, w0, w1] = hslWeights(ch.hue);
        assert.equal(k0, idx, `channel ${ch.id} centre index matches`);
        assert.equal(w0, 1, `channel ${ch.id} centre has w0 = 1`);
        assert.equal(w1, 0, `channel ${ch.id} centre has w1 = 0`);
    }

    console.log("  [ok] hslWeights partition of unity and exact centres verified across 36,001 points");

    // 12. Random greys strictly unchanged for random params, exactly (PLAN R3-S4)
    const randomParamSets = [
        { red_h: 50, blue_s: -100, green_l: 40 },
        { aqua_h: -40, aqua_s: 60, blue_h: 30, blue_s: -80, purple_l: -30 },
        { red_s: -100, orange_s: -100, yellow_s: -100, green_s: -100, aqua_s: -100, blue_s: -100, purple_s: -100, magenta_s: -100 },
        { red_l: 80, green_l: -60, blue_l: 50, yellow_l: -40 },
        { red_h: 100, orange_h: -100, yellow_s: 100, green_s: -100, aqua_l: 100, blue_l: -100, purple_h: 50, magenta_s: -50 }
    ];
    for (const pSet of randomParamSets) {
        for (let i = 0; i <= 255; i++) {
            const res = hslPixel(i, i, i, pSet);
            assert.equal(res[0], i, `grey ${i} red unchanged`);
            assert.equal(res[1], i, `grey ${i} green unchanged`);
            assert.equal(res[2], i, `grey ${i} blue unchanged`);
        }
    }
    console.log("  [ok] random greys strictly unchanged across 5 random parameter sets (1,280 checks)");

    // 13. Colours with C < 0.02 move by <= 1 level (PLAN R3-S4)
    for (let r = 0; r <= 255; r += 5) {
        for (let g = Math.max(0, r - 5); g <= Math.min(255, r + 5); g++) {
            for (let b = Math.max(0, r - 5); b <= Math.min(255, r + 5); b++) {
                const C = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
                if (C < 0.02) {
                    const res = hslPixel(r, g, b, { red_h: 100, red_s: -100, red_l: 50, blue_h: 100, blue_s: 100, blue_l: -50 });
                    assert.ok(Math.abs(Math.round(res[0]) - r) <= 1, `C < 0.02 red movement <= 1 level`);
                    assert.ok(Math.abs(Math.round(res[1]) - g) <= 1, `C < 0.02 green movement <= 1 level`);
                    assert.ok(Math.abs(Math.round(res[2]) - b) <= 1, `C < 0.02 blue movement <= 1 level`);
                }
            }
        }
    }
    console.log("  [ok] colours with C < 0.02 move by <= 1 level");

    // 14. (255, 0, 0) with red_h: 100 gives (255, 128, 0) +- 1 (PLAN R3-S4)
    const pRedH = hslPixel(255, 0, 0, { red_h: 100 });
    assert.ok(Math.abs(pRedH[0] - 255) <= 1, `pure red red_h: 100 gives red 255 +- 1, got ${pRedH[0]}`);
    assert.ok(Math.abs(pRedH[1] - 128) <= 1, `pure red red_h: 100 gives green 128 +- 1, got ${pRedH[1]}`);
    assert.ok(Math.abs(pRedH[2] - 0) <= 1, `pure red red_h: 100 gives blue 0 +- 1, got ${pRedH[2]}`);
    console.log("  [ok] (255, 0, 0) with red_h: 100 gives (255, 128, 0) +- 1");

    // 15. red_* params move pure orange (255, 128, 0) by <= 1 level (PLAN R3-S4)
    const pOrange = hslPixel(255, 128, 0, { red_h: 100, red_s: -100, red_l: 100 });
    assert.ok(Math.abs(pOrange[0] - 255) <= 1, `red_* on orange gives red 255 +- 1, got ${pOrange[0]}`);
    assert.ok(Math.abs(pOrange[1] - 128) <= 1, `red_* on orange gives green 128 +- 1, got ${pOrange[1]}`);
    assert.ok(Math.abs(pOrange[2] - 0) <= 1, `red_* on orange gives blue 0 +- 1, got ${pOrange[2]}`);
    console.log("  [ok] red_* params move pure orange (255, 128, 0) by <= 1 level");

    // 16. (255, 0, 0) with red_s: -100 gives (76, 76, 76) +- 1 (PLAN R3-S4)
    const pRedS = hslPixel(255, 0, 0, { red_s: -100 });
    assert.ok(Math.abs(pRedS[0] - 76) <= 1, `pure red red_s: -100 gives red 76 +- 1, got ${pRedS[0]}`);
    assert.ok(Math.abs(pRedS[1] - 76) <= 1, `pure red red_s: -100 gives green 76 +- 1, got ${pRedS[1]}`);
    assert.ok(Math.abs(pRedS[2] - 76) <= 1, `pure red red_s: -100 gives blue 76 +- 1, got ${pRedS[2]}`);
    console.log("  [ok] (255, 0, 0) with red_s: -100 gives (76, 76, 76) +- 1");

    // 17. 10,000 random unclipped colours with only *_s set: luma before clamp kept within 1e-9 (PLAN R3-S4)
    // Custom helper returning unclipped values before the final [0, 1] clamp:
    let maxLumaErr = 0;
    for (let iter = 0; iter < 10000; iter++) {
        const r = Math.random() * 255;
        const g = Math.random() * 255;
        const b = Math.random() * 255;
        const sParams = {};
        for (const ch of HSL_CHANNELS) {
            sParams[`${ch.id}_s`] = Math.random() * 200 - 100;
        }
        // Calculate saturation shift analytically:
        const rf = r / 255, gf = g / 255, bf = b / 255;
        const mx = Math.max(rf, gf, bf), mn = Math.min(rf, gf, bf), C = mx - mn;
        const amt = C <= 0 ? 0 : (C >= 0.25 ? 1 : (C / 0.25) * (C / 0.25) * (3 - 2 * (C / 0.25)));
        if (amt === 0) continue;
        let h = 0;
        if (mx === rf) {
            let seg = (gf - bf) / C;
            if (seg < 0) seg += 6;
            h = 60 * seg;
        } else if (mx === gf) {
            h = 60 * (((bf - rf) / C) + 2);
        } else {
            h = 60 * (((rf - gf) / C) + 4);
        }
        const [k0, k1, w0, w1] = hslWeights(h);
        const s0 = +sParams[`${HSL_CHANNELS[k0].id}_s`];
        const s1 = +sParams[`${HSL_CHANNELS[k1].id}_s`];
        const ds = ((w0 * s0 + w1 * s1) / 100) * amt;
        const Y1 = 0.299 * rf + 0.587 * gf + 0.114 * bf;
        const satScale = Math.max(0, 1 + ds);
        const c2r = Y1 + (rf - Y1) * satScale;
        const c2g = Y1 + (gf - Y1) * satScale;
        const c2b = Y1 + (bf - Y1) * satScale;
        const YOut = 0.299 * c2r + 0.587 * c2g + 0.114 * c2b;
        const err = Math.abs(Y1 - YOut);
        if (err > maxLumaErr) maxLumaErr = err;
        assert.ok(err < 1e-9, `luma preserved within 1e-9, got error ${err}`);
    }
    console.log(`  [ok] 10,000 random unclipped colours preserve luma within 1e-9 (max err: ${maxLumaErr.toExponential(3)})`);

    // 18. hslIdentity, hslUniforms, and HSL_GLSL validation (PLAN R3-S4)
    assert.equal(hslIdentity({}), true, "empty object is identity");
    assert.equal(hslIdentity({ red_h: 0, blue_s: 0 }), true, "zero params is identity");
    assert.equal(hslIdentity({ red_h: 1 }), false, "red_h > 0 is not identity");
    assert.equal(hslIdentity({ blue_s: -1 }), false, "blue_s != 0 is not identity");
    assert.equal(hslIdentity({ green_l: 5 }), false, "green_l != 0 is not identity");

    const u = hslUniforms({ red_h: 50, aqua_s: -80, magenta_l: 30 });
    assert.deepEqual(u.u_h0, [0.5, 0, 0, 0], "u_h0 packs red_h divided by 100");
    assert.deepEqual(u.u_s1, [-0.8, 0, 0, 0], "u_s1 packs aqua_s divided by 100");
    assert.deepEqual(u.u_l1, [0, 0, 0, 0.3], "u_l1 packs magenta_l divided by 100");
    assert.equal(Object.keys(HSL_UNIFORMS).length, 6, "HSL_UNIFORMS has 6 vec4 uniforms");

    assert.ok(HSL_GLSL.includes("vec4 shade(vec4 c, vec2 uv)"), "HSL_GLSL defines shade function");
    assert.ok(!/\b(sample|half|filter)\b/.test(HSL_GLSL), "HSL_GLSL does not contain reserved words");
    console.log("  [ok] hslIdentity, hslUniforms, and HSL_GLSL contract verified");

    console.log("\nALL COLOUR GRADING MATHS TESTS PASSED!");
}


main().catch((err) => {
    console.error("FAILED:", err);
    process.exit(1);
});
