// Plain-Node check of the ONNX helper modules, no Electron: a synthetic 1024 × 1024 image
// (grey background, three coloured shapes) goes through SAM2's automatic mask generator
// and a point prompt, and a shape on black through the matting model.
//
//     node tools/helpers_test.js [modelsDir] [--sam2 sam2_tiny] [--matting birefnet_lite] [--cpu]
//
// Prints timings and the execution provider; exits non-zero when the objects or the
// cutout are not where they should be.
"use strict";

const path = require("node:path");
const { Runtime } = require("../electron/main/onnx/runtime");
const models = require("../electron/main/onnx/models");
const { Sam2, logitsToMask, SIZE } = require("../electron/main/onnx/sam2");
const { Matting } = require("../electron/main/onnx/matting");

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
    const sam2Model = models.byId(sam2Id);
    const sam2Paths = models.paths(sam2Model, dir);
    if (!sam2Paths) throw new Error(`${sam2Id} not present in ${dir}`);
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

    // matting: the yellow rectangle on black
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
    console.log("runtime:", JSON.stringify(runtime.status().active));
    await runtime.free();
    const ok = distinct && pointOk && cutOk !== false;
    console.log(ok ? "PASS" : "FAIL", { distinct, pointOk, cutOk });
    process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
