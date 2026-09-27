// The pressure curve and the stabiliser of renderer/editor/inpaint_stroke.js without Electron (PLAN_0_1_31 §4 step 5).
//
//     node tools/stroke_test.js
"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

let failures = 0;
function check(name, ok, detail = "") {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
    if (!ok) failures++;
}

(async () => {
    const S = await import(pathToFileURL(path.join(__dirname, "..", "renderer", "editor", "inpaint_stroke.js")).href);
    const near = (a, b, e = 1e-12) => Math.abs(a - b) <= e;
    // the curves: the ends stay, the middle moves the way the name says
    check("the curves keep 0 and 1", ["linear", "soft", "hard"].every((c) => S.pressureCurve(0, c) === 0 && S.pressureCurve(1, c) === 1));
    check("linear is the pressure, soft gives more, hard less", near(S.pressureCurve(0.5, "linear"), 0.5) && near(S.pressureCurve(0.25, "soft"), 0.5) && near(S.pressureCurve(0.5, "hard"), 0.25));
    check("an unknown curve is linear; out of range and junk are clamped", near(S.pressureCurve(0.3, "odd"), 0.3) && S.pressureCurve(2, "soft") === 1 && S.pressureCurve(-1, "hard") === 0 && S.pressureCurve(NaN) === 0);
    let mono = true;
    for (const c of ["linear", "soft", "hard"]) for (let v = 0; v < 1; v += 0.01) if (S.pressureCurve(v + 0.01, c) < S.pressureCurve(v, c)) mono = false;
    check("every curve rises", mono);
    // the pull string
    const s = new S.Stabiliser(10, 0, 0, 1);
    check("inside the radius the brush stays", s.push(6, 8, 0.5).length === 0 && s.x === 0 && s.y === 0);
    const out = s.push(20, 0, 0.7);
    check("beyond it the brush is pulled to the radius behind the cursor", out.length === 1 && near(out[0][0], 10) && near(out[0][1], 0) && out[0][2] === 0.7, JSON.stringify(out));
    const back = s.push(15, 0, 0.7);
    check("a step back within the string moves nothing", back.length === 0 && near(s.x, 10));
    const fin = s.finish();
    check("the release draws the rest to the last cursor", fin.length === 1 && fin[0][0] === 15 && fin[0][1] === 0);
    check("a second release draws nothing", s.finish().length === 0);
    // radius 0 follows the cursor exactly; a repeated point gives nothing
    const z = new S.Stabiliser(0, 5, 5);
    const a = z.push(9, 8, 1);
    check("radius 0 follows the cursor", a.length === 1 && a[0][0] === 9 && a[0][1] === 8 && z.push(9, 8, 1).length === 0 && z.finish().length === 0);
    // a jittering line comes out calmer: the brush's distance from the straight line is far below the hand's
    const j = new S.Stabiliser(12, 0, 0);
    let worst = 0, hand = 0;
    for (let i = 1; i <= 200; i++) {
        const y = (i % 2 ? 8 : -8);
        hand = Math.max(hand, Math.abs(y));
        for (const [, py] of j.push(i * 3, y, 1)) worst = Math.max(worst, Math.abs(py));
    }
    check("a hand trembling 8 px either side draws within 2 px of its line (radius 12)", worst < 2 && hand === 8, `brush ${worst.toFixed(2)}`);
    console.log(failures ? `${failures} FAILED` : "PASS");
    process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
