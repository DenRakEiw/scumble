// What one canvas holds (docs/PLAN_0_1_48.md S5): renderer/editor/inpaint_sizelimit.js in plain Node.
//   node tools/sizelimit_test.js
"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

(async () => {
    const S = await import(pathToFileURL(path.join(__dirname, "..", "renderer", "editor", "inpaint_sizelimit.js")).href);

    let failed = 0;
    function check(name, ok, got) {
        if (ok) console.log(`[ok] ${name}`);
        else { failed++; console.log(`[FAIL] ${name}: ${JSON.stringify(got)}`); }
    }

    check("65,535 x 4,096 fits", S.canvasFits(65535, 4096));
    check("65,536 x 1 does not", !S.canvasFits(65536, 1));
    check("16,384 x 16,384 fits (exactly 268,435,456 px)", S.canvasFits(16384, 16384));
    check("16,384 x 16,385 does not", !S.canvasFits(16384, 16385));
    check("0 x 10 does not", !S.canvasFits(0, 10));
    check("the refusal names the size and the limit", S.canvasSizeRefusal(70000, 100, "The resized picture") === "The resized picture would be 70,000 × 100 px, more than one canvas holds (65,535 px a side, 268 megapixels).", S.canvasSizeRefusal(70000, 100, "The resized picture"));
    check("no refusal when it fits", S.canvasSizeRefusal(4000, 3000) === "");
    check("the tile engine's limits are the same", S.CANVAS_MAX_SIDE === 65535 && S.CANVAS_MAX_PIXELS === 268435456);

    // the largest factor
    check("4096 x 4096, 2..16: 4", S.largestFactor(4096, 4096, { min: 2, max: 16 }) === 4, S.largestFactor(4096, 4096, { min: 2, max: 16 }));
    check("4096 x 4096, steps 2 4 8 16: 4", S.largestFactor(4096, 4096, { steps: [2, 4, 8, 16] }) === 4);
    check("4096 x 2304, 1..8: 5", S.largestFactor(4096, 2304, { min: 1, max: 8 }) === 5, S.largestFactor(4096, 2304, { min: 1, max: 8 }));
    check("4096 x 2304, steps 8 16: none", S.largestFactor(4096, 2304, { steps: [8, 16] }) === null);
    check("4096 x 16, 2..16: 15 (the side, not the area)", S.largestFactor(4096, 16, { min: 2, max: 16 }) === 15, S.largestFactor(4096, 16, { min: 2, max: 16 }));
    check("a small picture: the largest factor offered", S.largestFactor(512, 512, { min: 1, max: 8 }) === 8);
    check("no spec: none", S.largestFactor(512, 512, null) === null);
    // a model's own area cap (Magnific Creative, 25.3 MP)
    check("2560 x 1920, steps 2 4 8 16, a 25.3 MP cap: 2", S.largestFactor(2560, 1920, { steps: [2, 4, 8, 16] }, 25300000) === 2, S.largestFactor(2560, 1920, { steps: [2, 4, 8, 16] }, 25300000));
    check("1024 x 1024, 2..16, a 25.3 MP cap: 4", S.largestFactor(1024, 1024, { min: 2, max: 16 }, 25300000) === 4, S.largestFactor(1024, 1024, { min: 2, max: 16 }, 25300000));
    check("4096 x 4096, steps 2 4 8 16, a 25.3 MP cap: none", S.largestFactor(4096, 4096, { steps: [2, 4, 8, 16] }, 25300000) === null);
    check("no cap (0): the canvas alone", S.largestFactor(4096, 4096, { min: 2, max: 16 }, 0) === 4);

    // fitting an answer
    const [fw, fh] = S.fitInCanvas(2000, 1000000);
    check("a too-tall answer is scaled to fit, its shape kept", S.canvasFits(fw, fh) && fh <= 65535 && Math.abs(fw / fh - 0.002) < 0.0005, [fw, fh]);
    const [aw, ah] = S.fitInCanvas(30000, 30000);
    check("a too-large square: under 268 MP, near it", S.canvasFits(aw, ah) && aw * ah > 268e6, [aw, ah]);
    check("a size that fits stays", JSON.stringify(S.fitInCanvas(4000, 3000)) === "[4000,3000]");

    console.log(failed ? `${failed} failed` : "PASS");
    process.exit(failed ? 1 : 0);
})();
