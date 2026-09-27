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
    // the blur and the sharpen of the brushes (step 6)
    const img = (w, h, f) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(f(x, y), (y * w + x) * 4); return d; };
    const flat = img(12, 9, () => [90, 150, 30, 255]);
    check("a flat picture stays as it is under the blur and the sharpen", S.blurRGBA(flat, 12, 9, 2).every((v, i) => v === flat[i]) && S.sharpenRGBA(flat, 12, 9, 2).every((v, i) => v === flat[i]));
    const edge = img(20, 3, (x) => (x < 10 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const bl = S.blurRGBA(edge, 20, 3, 1);
    const row = (d) => Array.from({ length: 20 }, (_, x) => d[(20 + x) * 4]);
    const br = row(bl);
    let ramp = true; for (let x = 1; x < 20; x++) if (br[x] < br[x - 1]) ramp = false;
    check("the blur softens an edge into a ramp, far pixels untouched", ramp && br[9] > 0 && br[10] < 255 && br[0] === 0 && br[19] === 255, br.join(","));
    const sh = row(S.sharpenRGBA(bl, 20, 3, 1));
    check("the sharpen steepens the ramp again", sh[8] <= br[8] && sh[11] >= br[11] && sh[9] < br[9] && sh[10] > br[10], sh.join(","));
    const half = img(10, 1, (x) => (x < 5 ? [200, 40, 40, 255] : [0, 0, 0, 0]));
    const hb = S.blurRGBA(half, 10, 1, 1);
    let noDark = true; for (let x = 0; x < 10; x++) { const i = x * 4; if (hb[i + 3] > 0 && Math.abs(hb[i] - 200) > 2) noDark = false; if (!hb[i + 3] && (hb[i] || hb[i + 1] || hb[i + 2])) noDark = false; }
    check("the blur is premultiplied: a colour next to transparency keeps its colour, not darker", noDark);
    const sa = S.sharpenRGBA(half, 10, 1, 1);
    check("the sharpen keeps the alpha", sa.every((v, i) => i % 4 !== 3 || v === half[i]));
    // dodge and burn (step 9): GIMP's tone curves as tables
    const RANGES = ["shadows", "midtones", "highlights"], EXPS = [0, 0.1, 0.25, 0.5, 0.75, 1];
    const T = (range, e, burn) => S.toneLUT(range, e, burn);
    check("exposure 0 is the identity in every range, dodge and burn", RANGES.every((r) => [false, true].every((b) => T(r, 0, b).every((v, i) => v === i))));
    let rises = true, dodgeUp = true, burnDown = true;
    for (const r of RANGES) for (const e of EXPS) for (const b of [false, true]) {
        const l = T(r, e, b);
        for (let i = 0; i < 256; i++) { if (i && l[i] < l[i - 1]) rises = false; if (!b && l[i] < i) dodgeUp = false; if (b && l[i] > i) burnDown = false; }
    }
    check("every table rises; dodge lies on or above the identity, burn on or below", rises && dodgeUp && burnDown);
    check("midtones keep 0 and 255, highlights keep 0", EXPS.every((e) => [false, true].every((b) => T("midtones", e, b)[0] === 0 && T("midtones", e, b)[255] === 255 && T("highlights", e, b)[0] === 0)));
    let shEnds = true;
    for (const e of EXPS) { const f = 0.333333 * e, bu = T("shadows", e, true); if (T("shadows", e)[0] !== Math.round(f * 255)) shEnds = false; for (let i = 0; i < f * 255; i++) if (bu[i]) shEnds = false; }
    check("shadows dodge lifts 0 to f*255, shadows burn puts everything below f*255 at 0", shEnds);
    // hand values from Python (2026-09-27), the literal 0.333333 as third:
    //   (128/255)**(1/1.5)*255 = 161.06; (128/255)**(1+0.333333)*255 = 101.73; 200*(1-0.333333) = 133.33;
    //   0.333333*0.5*255 = 42.49996 (an exact third would give 42.5 -> 43); (128/255-0.333333)/(1-0.333333)*255 = 64.5001
    const hv = [T("midtones", 0.5)[128], T("midtones", 1, true)[128], T("highlights", 1, true)[200], T("shadows", 0.5)[0], T("shadows", 1, true)[128]];
    check("hand values: midtones dodge/burn, highlights burn, shadows dodge/burn", hv.join() === "161,102,133,42,65", hv.join());
    check("an unknown range is midtones; exposure is clamped", T("odd", 0.5).join() === T("midtones", 0.5).join() && T("highlights", 3).join() === T("highlights", 1).join() && T("shadows", -1, true).every((v, i) => v === i));
    // random straight RGBA: a seeded PRNG (mulberry32), a tenth transparent with junk colour, a tenth grey
    let seed = 0x5eed1234;
    const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const N = 4000, px = new Uint8ClampedArray(N * 4);
    for (let p = 0; p < N; p++) {
        const k = rnd(), c = [0, 0, 0].map(() => (rnd() * 256) | 0);
        if (k < 0.1) c[1] = c[2] = c[0];
        px.set([...c, k > 0.9 ? 0 : 1 + ((rnd() * 255) | 0)], p * 4);
    }
    const keepsAlpha = (o) => o.every((v, i) => i % 4 !== 3 || v === px[i]);
    const clearSame = (o) => { for (let i = 0; i < px.length; i += 4) if (!px[i + 3] && (o[i] !== px[i] || o[i + 1] !== px[i + 1] || o[i + 2] !== px[i + 2])) return false; return true; };
    const ordered = (o) => { for (let i = 0; i < px.length; i += 4) for (const [a, b] of [[0, 1], [1, 2], [0, 2]]) if ((px[i + a] - px[i + b]) * (o[i + a] - o[i + b]) < 0) return false; return true; };
    // the tone brush on pixels
    let tAlpha = true, tClear = true, tPlain = true, tOrder = true, tRatio = true, worstR = 0;
    for (const r of RANGES) for (const e of [0.3, 1]) for (const b of [false, true]) {
        const l = T(r, e, b), plain = S.toneRGBA(px, l), prot = S.toneRGBA(px, l, true);
        tAlpha = tAlpha && keepsAlpha(plain) && keepsAlpha(prot);
        tClear = tClear && clearSame(plain) && clearSame(prot);
        for (let i = 0; i < px.length; i += 4) if (px[i + 3]) for (let c = 0; c < 3; c++) if (plain[i + c] !== l[px[i + c]]) tPlain = false;
        tOrder = tOrder && ordered(prot);
        // protect scales the three alike above the table's floor o = lut[0]: (c' - o) / (lut[v] - o) = c / v to rounding
        const o = l[0];
        for (let i = 0; i < px.length; i += 4) {
            const v = Math.max(px[i], px[i + 1], px[i + 2]), span = l[v] - o;
            if (!px[i + 3] || !v || !span) continue;
            for (let c = 0; c < 3; c++) { const d = Math.abs((prot[i + c] - o) / span - px[i + c] / v); worstR = Math.max(worstR, d * span); if (d > 0.5 / span + 1e-9) tRatio = false; }
        }
    }
    check("tone: the alpha stays, transparent pixels keep their bytes (plain and protect)", tAlpha && tClear);
    check("tone without protect is the table per channel", tPlain);
    check("tone with protect keeps the channel order and every c/max within rounding", tOrder && tRatio, `worst ${worstR.toFixed(3)} of a level`);
    // near black a shadows dodge lifts to the floor's grey: a pixel a level off black lands beside it, not on a speck
    // (the review of 2026-09-28: (1, 0, 0) came out (43, 0, 0) next to (42, 42, 42) when protect only scaled)
    const shd = T("shadows", 0.5), dark = Uint8ClampedArray.of(0, 0, 0, 255, 1, 0, 0, 255, 0, 1, 0, 255, 2, 1, 0, 255, 5, 3, 2, 255);
    const dq = S.toneRGBA(dark, shd, true), dp = S.toneRGBA(dark, shd);
    let speck = 0;
    for (let i = 0; i < dark.length; i += 4) speck = Math.max(speck, Math.max(dq[i], dq[i + 1], dq[i + 2]) - Math.min(dq[i], dq[i + 1], dq[i + 2]));
    check("protect is continuous at black under a shadows dodge (no coloured specks)", dq.slice(0, 3).join() === "42,42,42" && speck <= 3 && dq.every((v, i) => Math.abs(v - dp[i]) <= 1), `${Array.from(dq).join()} / per channel ${Array.from(dp).join()}`);
    const warm = Uint8ClampedArray.of(250, 120, 40, 255), hi = T("highlights", 1);
    const wp = S.toneRGBA(warm, hi), wq = S.toneRGBA(warm, hi, true);
    check("highlights dodge 1 on (250,120,40): per channel clips red and shifts the hue, protect keeps the ratio",
        wp.join() === "255,160,53,255" && wq.join() === "255,122,41,255" && Math.abs(wq[1] / wq[0] - 120 / 250) < 0.005 && Math.abs(wp[1] / wp[0] - 120 / 250) > 0.1, `${wp.join()} / ${wq.join()}`);
    // the sponge
    const luma = (i) => (77 * px[i] + 150 * px[i + 1] + 29 * px[i + 2] + 128) >> 8;
    const spread = (d, i) => Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
    check("sponge amount 0 is the identity (desaturate, saturate, without vibrance)", [[false, true], [true, true], [true, false]].every(([s, v]) => S.spongeRGBA(px, 0, s, v).every((x, i) => x === px[i])));
    let gAlpha = true, gClear = true, gGrey = true, gOrder = true, gSign = true, gLine = true, gSpread = true;
    for (const amt of [0.1, 0.5, 1]) for (const [sat, vib] of [[false, true], [true, true], [true, false]]) {
        const o = S.spongeRGBA(px, amt, sat, vib);
        gAlpha = gAlpha && keepsAlpha(o); gClear = gClear && clearSame(o); gOrder = gOrder && ordered(o);
        for (let i = 0; i < px.length; i += 4) {
            if (!px[i + 3]) continue;
            if (px[i] === px[i + 1] && px[i] === px[i + 2]) { if (o[i] !== px[i] || o[i + 1] !== px[i] || o[i + 2] !== px[i]) gGrey = false; continue; }
            const y = luma(i), d = [0, 1, 2].map((c) => px[i + c] - y), n = [0, 1, 2].map((c) => o[i + c] - y);
            if (d.some((x, c) => x * n[c] < 0)) gSign = false;
            // the colour moves along its line through the luma: a clipped channel would leave it by far more than rounding
            for (const [a, b] of [[0, 1], [1, 2], [0, 2]]) if (Math.abs(n[a] * d[b] - n[b] * d[a]) > 0.5 * (Math.abs(d[a]) + Math.abs(d[b])) + 1e-9) gLine = false;
            if (sat ? spread(o, i) < spread(px, i) : spread(o, i) > spread(px, i)) gSpread = false;
        }
    }
    check("sponge: the alpha stays, transparent and grey pixels keep their bytes", gAlpha && gClear && gGrey);
    check("sponge keeps the channel order and the side of the luma every channel is on", gOrder && gSign);
    check("sponge moves along the line through the luma: no channel clips", gLine);
    check("saturate never narrows max-min, desaturate never widens it", gSpread);
    const flatG = S.spongeRGBA(px, 1);
    let allY = true; for (let i = 0; i < px.length; i += 4) if (px[i + 3] && !(flatG[i] === luma(i) && flatG[i + 1] === luma(i) && flatG[i + 2] === luma(i))) allY = false;
    check("desaturate 1 gives r = g = b = the luma on every visible pixel", allY);
    // vibrance: at 0.25 neither colour reaches its clip limit (dull 8.3, vivid 1.30), so only the vibrance tells them apart
    const pair = Uint8ClampedArray.of(140, 120, 110, 255, 220, 60, 30, 255);
    const gain = (o) => [spread(o, 0) / 30, spread(o, 4) / 190];
    const [dv, vv] = gain(S.spongeRGBA(pair, 0.25, true)), [dn, vn] = gain(S.spongeRGBA(pair, 0.25, true, false));
    check("vibrance lifts a dull colour more than a vivid one; without it both gain alike", dv > vv + 0.1 && Math.abs(dn - vn) < 0.05 && dn > 1.2, `vibrance ${dv.toFixed(3)} / ${vv.toFixed(3)}, plain ${dn.toFixed(3)} / ${vn.toFixed(3)}`);
    console.log(failures ? `${failures} FAILED` : "PASS");
    process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
