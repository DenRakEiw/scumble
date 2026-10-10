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

    console.log("\nALL COLOUR GRADING MATHS TESTS PASSED!");
}

main().catch((err) => {
    console.error("FAILED:", err);
    process.exit(1);
});
