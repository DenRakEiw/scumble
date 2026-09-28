// Plain-Node checks of renderer/editor/inpaint_remove.js (the Remove tool's geometry and resampling around the
// 512 x 512 LaMa model): the crop holds the hole and stays in the picture, a 512 crop goes through unchanged, flat
// colours stay flat, a hole of one pixel reaches the model, and the answer comes back where the hole is.
//
//     node tools/remove_test.js
"use strict";

(async () => {
    const R = await import("../renderer/editor/inpaint_remove.js");
    const S = R.REMOVE_SIZE;
    let fails = 0;
    const check = (name, ok, extra = "") => { console.log(`${ok ? "[ok]" : "[FAIL]"} ${name}${extra ? ": " + extra : ""}`); if (!ok) fails++; };

    // removeCrop
    const inside = (h, c) => h[0] >= c[0] && h[1] >= c[1] && h[2] <= c[2] && h[3] <= c[3];
    let bad = 0;
    for (const [W, H] of [[15000, 10000], [800, 600], [300, 200], [512, 512], [4000, 300]]) {
        for (let i = 0; i < 200; i++) {
            const w = 1 + ((i * 7919) % Math.min(W, 2048)), h = 1 + ((i * 104729) % Math.min(H, 2048));
            const x = (i * 31337) % Math.max(1, W - w + 1), y = (i * 2718) % Math.max(1, H - h + 1);
            const hole = [x, y, Math.min(W, x + w), Math.min(H, y + h)];
            const c = R.removeCrop(hole, W, H);
            const cw = c[2] - c[0], ch = c[3] - c[1];
            const want = Math.max(S, Math.ceil(Math.max(hole[2] - hole[0], hole[3] - hole[1]) * 2));
            if (!inside(hole, c) || c[0] < 0 || c[1] < 0 || c[2] > W || c[3] > H || cw !== Math.min(want, W) || ch !== Math.min(want, H)) bad++;
        }
    }
    check("the crop holds the hole, lies in the picture and is square where the picture allows", bad === 0, `${bad} bad of 1000`);
    check("a small spot gets a 512 crop at the picture's resolution", JSON.stringify(R.removeCrop([1000, 1000, 1010, 1010], 4000, 3000)) === JSON.stringify([749, 749, 1261, 1261]));

    // resampling weights
    let wsum = 0;
    for (const [a, b] of [[4096, 512], [700, 512], [512, 512], [300, 512], [1, 512], [513, 512]]) {
        for (const e of R.resampleWeights(a, b)) { let t = 0; for (const v of e.w) t += v; wsum = Math.max(wsum, Math.abs(t - 1)); if (e.i0 < 0 || e.i0 + e.w.length > a) wsum = 99; }
    }
    check("weights sum to 1 and stay in range", wsum < 1e-9, `max error ${wsum}`);

    // toModelImage
    const rnd = (n) => { const a = new Uint8Array(n); let s = 12345; for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) >>> 0; a[i] = s >>> 24; } return a; };
    const img512 = rnd(S * S * 4);
    const same = R.toModelImage(img512, S, S);
    let diff = 0;
    for (let i = 0; i < S * S; i++) for (let c = 0; c < 3; c++) diff = Math.max(diff, Math.abs(same[i * 4 + c] - img512[i * 4 + c]));
    check("a 512 crop goes to the model unchanged", diff === 0 && same[3] === 255, `max diff ${diff}`);
    for (const [w, h] of [[2000, 1500], [300, 200], [4096, 4096]]) {
        const flat = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) { flat[i * 4] = 200; flat[i * 4 + 1] = 17; flat[i * 4 + 2] = 90; flat[i * 4 + 3] = 255; }
        const m = R.toModelImage(flat, w, h);
        let off = 0;
        for (let i = 0; i < S * S; i++) off = Math.max(off, Math.abs(m[i * 4] - 200), Math.abs(m[i * 4 + 1] - 17), Math.abs(m[i * 4 + 2] - 90));
        check(`a flat ${w} x ${h} stays flat`, off === 0, `max diff ${off}`);
    }
    // a 2:1 shrink is the mean of 2 x 2 blocks
    const big = rnd(1024 * 1024 * 4), half = R.toModelImage(big, 1024, 1024);
    let dmean = 0;
    for (let y = 0; y < S; y += 17) for (let x = 0; x < S; x += 13) for (let c = 0; c < 3; c++) {
        const at = (yy, xx) => big[(yy * 1024 + xx) * 4 + c];
        const m = (at(2 * y, 2 * x) + at(2 * y, 2 * x + 1) + at(2 * y + 1, 2 * x) + at(2 * y + 1, 2 * x + 1)) / 4;
        dmean = Math.max(dmean, Math.abs(half[(y * S + x) * 4 + c] - m));
    }
    check("a 2:1 shrink averages 2 x 2 blocks", dmean <= 0.5 + 1e-9, `max diff ${dmean}`);

    // toModelMask
    const one = new Uint8Array(4096 * 4096); one[2000 * 4096 + 3001] = 255;
    const m1 = R.toModelMask(one, 4096, 4096, S, 0);
    let on = 0, where = -1;
    for (let i = 0; i < S * S; i++) if (m1[i]) { on++; where = i; }
    check("one pixel of hole in a 4096 crop reaches the model", on === 1 && where === 250 * S + 375, `on ${on} at ${where}`);
    const m3 = R.toModelMask(one, 4096, 4096, S, 3);
    let on3 = 0; for (let i = 0; i < S * S; i++) if (m3[i]) on3++;
    check("the hole grows by 3 model pixels (a 7 x 7 square)", on3 === 49, `on ${on3}`);
    const small = new Uint8Array(300 * 200); small[100 * 300 + 150] = 255;
    const ms = R.toModelMask(small, 300, 200, S, 0);
    let ons = 0; for (let i = 0; i < S * S; i++) if (ms[i]) ons++;
    check("a hole in a crop smaller than 512 is scaled up with it", ons >= 2, `on ${ons}`);

    // fromModel
    const crop = [100, 50, 100 + S, 50 + S];
    const box = { x: 150, y: 80, w: 40, h: 30 };
    const mask = new Uint8Array(box.w * box.h).fill(255); mask[0] = 0;
    const back = R.fromModel(img512, crop, box, mask);
    let bdiff = 0;
    for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) {
        const k = y * box.w + x;
        if (!mask[k]) { if (back[k * 4 + 3] !== 0) bdiff = 999; continue; }
        const i = ((box.y + y - crop[1]) * S + box.x + x - crop[0]) * 4;
        for (let c = 0; c < 3; c++) bdiff = Math.max(bdiff, Math.abs(back[k * 4 + c] - img512[i + c]));
    }
    check("the answer of a 512 crop comes back pixel for pixel, only where the hole is", bdiff === 0, `max diff ${bdiff}`);
    const flatModel = new Uint8Array(S * S * 4); for (let i = 0; i < S * S; i++) { flatModel[i * 4] = 10; flatModel[i * 4 + 1] = 220; flatModel[i * 4 + 2] = 33; flatModel[i * 4 + 3] = 255; }
    const back2 = R.fromModel(flatModel, [0, 0, 4000, 3000], { x: 3990, y: 0, w: 10, h: 10 }, new Uint8Array(100).fill(1));
    let fd = 0; for (let k = 0; k < 100; k++) fd = Math.max(fd, Math.abs(back2[k * 4] - 10), Math.abs(back2[k * 4 + 1] - 220), Math.abs(back2[k * 4 + 2] - 33));
    check("a flat answer comes back flat at the crop's edge", fd === 0, `max diff ${fd}`);

    console.log(fails ? `FAIL (${fails})` : "PASS");
    process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
