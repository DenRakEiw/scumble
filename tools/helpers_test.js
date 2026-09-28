// Plain-Node check of the ONNX helper modules, no Electron: a synthetic 1024 × 1024 image
// (grey background, three coloured shapes) goes through SAM2's automatic mask generator
// and a point prompt, a shape on black through the matting model, and a red square on a
// gradient through LaMa with the square masked.
//
//     node tools/helpers_test.js [modelsDir] [--sam2 sam2_tiny] [--matting birefnet_lite] [--cpu]
//
// Prints timings and the execution provider; a model that is not in the folder is skipped.
// Exits non-zero when the objects, the cutout or the fill are not what they should be, or
// when no model ran at all.
"use strict";

const path = require("node:path");
const { Runtime } = require("../electron/main/onnx/runtime");
const models = require("../electron/main/onnx/models");
const { Sam2, logitsToMask, SIZE } = require("../electron/main/onnx/sam2");
const { Matting } = require("../electron/main/onnx/matting");
const { Lama, SIZE: LAMA } = require("../electron/main/onnx/lama");

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const dir = args.length && !args[0].startsWith("--") ? args[0] : path.join(process.env.APPDATA || ".", "Scumble", "models");
const sam2Id = flag("--sam2", "sam2_tiny");
const mattingId = flag("--matting", "birefnet_lite");

function synthetic() {
    const img = new Uint8ClampedArray(SIZE * SIZE * 4);
    const fill = (x0, y0, x1, y1, r, g, b, round) => {
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            if (round && ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1) continue;
            const i = (y * SIZE + x) * 4; img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = 255;
        }
    };
    fill(0, 0, SIZE, SIZE, 128, 128, 128, false);
    fill(100, 120, 420, 480, 220, 40, 40, false);      // red rectangle
    fill(560, 100, 940, 460, 40, 60, 220, true);       // blue ellipse
    fill(300, 620, 760, 900, 250, 230, 60, false);     // yellow rectangle
    return img;
}

async function main() {
    const runtime = new Runtime();
    if (args.includes("--cpu")) runtime.setDevice("cpu");
    console.log("models in", dir);
    const samOk = await testSam2(runtime);
    const cutOk = await testMatting(runtime);
    const lamaOk = await testLama(runtime);
    console.log("runtime:", JSON.stringify(runtime.status().active));
    await runtime.free();
    const ran = [samOk, cutOk, lamaOk].some((v) => v !== null);
    const ok = ran && samOk !== false && cutOk !== false && lamaOk !== false;
    console.log(ok ? "PASS" : "FAIL", { sam2: samOk, cutout: cutOk, lama: lamaOk, ran });
    process.exit(ok ? 0 : 1);
}

async function testSam2(runtime) {
    const sam2Model = models.byId(sam2Id);
    const sam2Paths = models.paths(sam2Model, dir);
    if (!sam2Paths) { console.log(`SAM2 model ${sam2Id} not present, skipped`); return null; }
    const sam = new Sam2(runtime, sam2Paths);
    const img = synthetic();
    let t0 = Date.now();
    const emb = await sam.encode(img, "test");
    console.log(`encode ${sam2Model.label}: ${Date.now() - t0} ms on ${emb.provider}`);
    t0 = Date.now();
    const res = await sam.automask(emb, SIZE, SIZE);
    console.log(`automask: ${res.count} objects from ${res.candidates} candidates in ${Date.now() - t0} ms`);
    const idAt = (x, y) => res.ids[y * SIZE + x];
    const red = idAt(260, 300), blue = idAt(750, 280), yellow = idAt(530, 760), bg = idAt(50, 1000);
    console.log("ids: red", red, "blue", blue, "yellow", yellow, "background", bg);
    const distinct = new Set([red, blue, yellow]).size === 3 && red && blue && yellow && ![red, blue, yellow].includes(bg);
    // point prompt on the blue ellipse
    t0 = Date.now();
    const p = await sam.predict(emb, [{ x: 750, y: 280, label: 1 }], null);
    const mask = logitsToMask(p.logits, SIZE, SIZE);
    let inside = 0, outside = 0;
    for (let y = 0; y < SIZE; y += 4) for (let x = 0; x < SIZE; x += 4) {
        const on = mask[y * SIZE + x];
        const isBlue = ((x - 750) / 190) ** 2 + ((y - 280) / 180) ** 2 <= 1;
        if (isBlue) inside += on; else outside += on;
    }
    console.log(`point prompt: score ${p.score.toFixed(3)}, ${Date.now() - t0} ms, inside ${inside} samples, outside ${outside}`);
    const pointOk = inside > 1000 && outside < inside * 0.1;
    return !!(distinct && pointOk);
}

async function testMatting(runtime) {
    // the yellow rectangle on black
    let t0;
    const mattingModel = models.byId(mattingId);
    const mp = models.paths(mattingModel, dir);
    let cutOk = null;
    if (mp) {
        const m = new Matting(runtime, mattingModel, mp.model);
        const src = new Uint8ClampedArray(SIZE * SIZE * 4);
        for (let i = 3; i < src.length; i += 4) src[i] = 255;
        for (let y = 200; y < 800; y++) for (let x = 250; x < 700; x++) { const i = (y * SIZE + x) * 4; src[i] = 250; src[i + 1] = 200; src[i + 2] = 60; }
        t0 = Date.now();
        const r = await m.run(src);
        let inA = 0, outA = 0, nIn = 0, nOut = 0;
        for (let y = 0; y < SIZE; y += 8) for (let x = 0; x < SIZE; x += 8) {
            const a = r.alpha[y * SIZE + x];
            if (y >= 220 && y < 780 && x >= 270 && x < 680) { inA += a; nIn++; } else if (y < 150 || y > 850 || x < 200 || x > 750) { outA += a; nOut++; }
        }
        console.log(`cutout ${mattingModel.label}: ${Date.now() - t0} ms on ${r.provider}, logits ${r.logits}, mean alpha inside ${(inA / nIn).toFixed(0)}, outside ${(outA / nOut).toFixed(0)}`);
        cutOk = inA / nIn > 200 && outA / nOut < 40;
    } else {
        console.log(`matting model ${mattingId} not present, skipped`);
    }
    return cutOk;
}

async function testLama(runtime) {
    // a red square on a horizontal gradient, the square masked: the fill continues the
    // gradient (no red left), the pixels outside the mask come back as they went in
    const model = models.byId("lama");
    const lp = models.paths(model, dir);
    if (!lp) { console.log("LaMa not present, skipped"); return null; }
    const n = LAMA * LAMA;
    const src = new Uint8Array(n * 4), mask = new Uint8Array(n);
    for (let y = 0; y < LAMA; y++) for (let x = 0; x < LAMA; x++) {
        const i = y * LAMA + x, g = Math.round(40 + 160 * x / (LAMA - 1));
        src[i * 4] = g; src[i * 4 + 1] = g; src[i * 4 + 2] = g; src[i * 4 + 3] = 255;
        if (x >= 200 && x < 300 && y >= 180 && y < 300) { src[i * 4] = 230; src[i * 4 + 1] = 20; src[i * 4 + 2] = 20; }
        if (x >= 196 && x < 304 && y >= 176 && y < 304) mask[i] = 255;
    }
    const lama = new Lama(model, lp.model);
    let t0 = Date.now();
    await lama.warm();
    const loadMs = Date.now() - t0;
    t0 = Date.now();
    const r = await lama.run(src, mask);
    const runMs = Date.now() - t0, where = lama.local ? "main thread" : "its process";
    lama.kill();
    let same = true, red = 0, err = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
        const j = i * 4;
        if (!mask[i]) { if (r.rgba[j] !== src[j] || r.rgba[j + 1] !== src[j + 1] || r.rgba[j + 2] !== src[j + 2] || r.rgba[j + 3] !== 255) same = false; continue; }
        if (r.rgba[j] - r.rgba[j + 1] > 40) red++;
        const x = i % LAMA, g = 40 + 160 * x / (LAMA - 1);
        err += Math.abs(r.rgba[j + 1] - g); cnt++;
    }
    const meanErr = err / cnt;
    console.log(`LaMa: load ${loadMs} ms, run ${runMs} ms on ${r.provider} (${where}), outside unchanged ${same}, red pixels left ${red}, mean |fill - gradient| ${meanErr.toFixed(1)}`);
    return same && red < cnt * 0.01 && meanErr < 12;
}

main().catch((err) => { console.error(err); process.exit(1); });
