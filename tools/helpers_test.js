// Plain-Node check of the ONNX helper modules, no Electron: a synthetic 1024 × 1024 image
// (grey background, three coloured shapes) goes through SAM2's automatic mask generator
// and a point prompt, a shape on black through the matting model, and a red square on a
// gradient through LaMa with the square masked.
//
//     node tools/helpers_test.js [modelsDir] [--also DIR] [--sam2 sam2_tiny] [--matting birefnet_lite] [--cpu]
//     node tools/helpers_test.js [modelsDir] [--also DIR] --process [--sam2 ...] [--matting ...] [--cpu]
//
// `--also DIR`: a second folder where a model missing in the first is looked for (the user's ComfyUI models folder
// holds SAM2 tiny and BiRefNet lite, the app folder depth). Prints timings and the execution provider; a model that is
// not in the folders is skipped. Exits non-zero when the objects, the cutout or the fill are not what they should be,
// or when no model ran at all.
//
// `--process` (U1, docs/PLAN_HELPERS_PROCESS.md §3.8): the same jobs through `HelperProcess` (helpers.js, the forked
// Node process of plain Node) and through the main-thread engine (engine.js on this thread), the answers byte for byte
// the same (the objects' ids, the point's logits, the cutout's alpha, the depth map); Free VRAM during an object map
// lets the map land and ends the process after it (a job meanwhile goes to a new one; one longer than the drain is
// refused naming the cause); a model's removal ends it at once, refusing its job with that cause; a death after
// "ready" refuses its jobs, a second within a minute falls back to this thread; a process that exits at once falls
// back with the waiting job answered; the idle unload ends the process.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Runtime } = require("../electron/main/onnx/runtime");
const models = require("../electron/main/onnx/models");
const { Sam2, logitsToMask, SIZE } = require("../electron/main/onnx/sam2");
const { Matting } = require("../electron/main/onnx/matting");
const { Lama, SIZE: LAMA } = require("../electron/main/onnx/lama");
const { Depth } = require("../electron/main/onnx/depth");

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const dir = args.length && !args[0].startsWith("--") ? args[0] : path.join(process.env.APPDATA || ".", "Scumble", "models");
const also = flag("--also", null);
const sam2Id = flag("--sam2", "sam2_tiny");
const mattingId = flag("--matting", "birefnet_lite");
const depthId = flag("--depth", "da2_small");
const depthRefDir = flag("--depth-ref", null);
const timed = args.includes("--time");

/** A model's files in the folder, else in `--also`. */
function pathsOf(model) {
    return (model && (models.paths(model, dir) || (also ? models.paths(model, also) : null))) || null;
}

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
    if (args.includes("--process")) return processMain();
    const runtime = new Runtime();
    if (args.includes("--cpu")) runtime.setDevice("cpu");
    console.log("models in", dir, also ? "and " + also : "");
    const samOk = await testSam2(runtime);
    const cutOk = await testMatting(runtime);
    const lamaOk = await testLama(runtime);
    const depthOk = await testDepth(runtime);
    console.log("runtime:", JSON.stringify(runtime.status().active));
    await runtime.free();
    const ran = [samOk, cutOk, lamaOk, depthOk].some((v) => v !== null);
    const ok = ran && samOk !== false && cutOk !== false && lamaOk !== false && depthOk !== false;
    console.log(ok ? "PASS" : "FAIL", { sam2: samOk, cutout: cutOk, lama: lamaOk, depth: depthOk, ran });
    process.exit(ok ? 0 : 1);
}

async function testSam2(runtime) {
    const sam2Model = models.byId(sam2Id);
    const sam2Paths = pathsOf(sam2Model);
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
    const mp = pathsOf(mattingModel);
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
    const lp = pathsOf(model);
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

function syntheticDepth(W = 784, H = 518) {
    const img = new Uint8ClampedArray(W * H * 4);
    const yh = Math.floor(0.35 * H);
    const cx = W / 2, f = H * 0.8, s = 40;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            if (y < yh) {
                const t = y / Math.max(1, yh);
                img[i] = Math.round(100 + 80 * t);
                img[i + 1] = Math.round(140 + 60 * t);
                img[i + 2] = Math.round(220 + 20 * t);
                img[i + 3] = 255;
            } else {
                const dy = y - yh + 1;
                const z = f / dy;
                const X = (x - cx) * z / f;
                const chk = ((Math.floor(X / s) + Math.floor(z / s)) & 1) ? 220 : 60;
                const fog = Math.min(1, Math.max(0, 1 - 20 / z));
                const v = Math.round(chk * (1 - fog) + 128 * fog);
                img[i] = v; img[i + 1] = v; img[i + 2] = v; img[i + 3] = 255;
            }
        }
    }
    return img;
}

function rankCorr(x) {
    const n = x.length;
    const sorted = x.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Float64Array(n);
    for (let r = 0; r < n; r++) ranks[sorted[r].i] = r;
    let d2 = 0;
    for (let i = 0; i < n; i++) { const d = i - ranks[i]; d2 += d * d; }
    return 1 - (6 * d2) / (n * (n * n - 1));
}

async function testDepth(runtime) {
    const depthModel = models.byId(depthId);
    const dp = pathsOf(depthModel);
    if (!dp) { console.log(`depth model ${depthId} not present, skipped`); return null; }
    const depth = new Depth(runtime, depthModel, dp.model);

    if (depthRefDir) {
        const fs = require("node:fs");
        let refOk = true;
        const entries = fs.readdirSync(depthRefDir);
        for (const e of entries) {
            const m = e.match(/^input_(\d+)x(\d+)\.rgba$/);
            if (!m) continue;
            const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
            const refPath = path.join(depthRefDir, `ref_${w}x${h}.f32`);
            if (!fs.existsSync(refPath)) continue;
            const rgba = new Uint8Array(fs.readFileSync(path.join(depthRefDir, e)));
            const refBuf = fs.readFileSync(refPath);
            const refF32 = new Float32Array(refBuf.buffer, refBuf.byteOffset, refBuf.byteLength / 4);
            const r = await depth.run(rgba, w, h);
            const n = w * h;
            let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0, maxDiff = 0;
            for (let i = 0; i < n; i++) {
                const x = r.depth[i], y = refF32[i];
                sumX += x; sumY += y; sumXY += x * y;
                sumX2 += x * x; sumY2 += y * y;
                const d = Math.abs(x - y);
                if (d > maxDiff) maxDiff = d;
            }
            const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
            const pearson = denom > 0 ? (n * sumXY - sumX * sumY) / denom : 0;
            const span = r.max - r.min;
            const relDiff = span > 0 ? maxDiff / span : maxDiff;
            const minPearson = r.provider === "cpu" ? 0.99999 : 0.9999;
            const maxRelDiff = 1e-4;
            const ok = pearson >= minPearson && (r.provider !== "cpu" || relDiff <= maxRelDiff);
            console.log(`depth ref ${w}×${h}: Pearson ${pearson.toFixed(6)}, max |Δ|/span ${relDiff.toExponential(2)} on ${r.provider} -> ${ok ? "ok" : "FAIL"}`);
            if (!ok) refOk = false;
        }
        return refOk;
    }

    const W = 784, H = 518;
    const img = syntheticDepth(W, H);
    let t0 = Date.now();
    const r = await depth.run(img, W, H);
    const runMs = Date.now() - t0;
    console.log(`depth ${depthModel.label}: ${runMs} ms on ${r.provider}, dims ${r.width} × ${r.height}, range [${r.min.toFixed(2)}, ${r.max.toFixed(2)}]`);
    if (r.width !== W || r.height !== H) return false;

    if (timed) {
        const shapes = [[784, 518], [924, 518], [518, 686], [518, 518]];
        for (const [sw, sh] of shapes) {
            const simg = syntheticDepth(sw, sh);
            const st0 = Date.now();
            await depth.run(simg, sw, sh);
            console.log(`timed shape ${sw}×${sh}: ${Date.now() - st0} ms`);
        }
        const wt0 = Date.now();
        await depth.run(img, W, H);
        console.log(`warm run ${W}×${H}: ${Date.now() - wt0} ms`);
    }

    const yh = Math.floor(0.35 * H);
    const numBins = 20;
    const binSize = (H - yh) / numBins;
    const binMeans = [];
    for (let b = 0; b < numBins; b++) {
        const y0 = Math.floor(yh + b * binSize), y1 = Math.floor(yh + (b + 1) * binSize);
        let sum = 0, count = 0;
        for (let y = y0; y < y1; y++) {
            for (let x = 0; x < W; x++) { sum += r.depth[y * W + x]; count++; }
        }
        binMeans.push(sum / count);
    }
    const spearman = rankCorr(binMeans);
    console.log(`floor row bins Spearman rho: ${spearman.toFixed(3)}`);

    let skySum = 0, skyCount = 0;
    for (let y = 0; y < yh; y++) {
        for (let x = 0; x < W; x++) { skySum += r.depth[y * W + x]; skyCount++; }
    }
    const skyMean = skySum / skyCount;
    const floorVals = [];
    for (let y = yh; y < H; y += 4) {
        for (let x = 0; x < W; x += 4) floorVals.push(r.depth[y * W + x]);
    }
    floorVals.sort((a, b) => a - b);
    const p10 = floorVals[Math.floor(floorVals.length * 0.1)];
    console.log(`sky mean disparity: ${skyMean.toFixed(2)}, floor p10: ${p10.toFixed(2)}`);

    const depthOk = spearman >= 0.95 && skyMean <= p10;
    return depthOk;
}

// ---- --process: the helpers' process against the main-thread engine (U1) ----------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
    try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

async function waitFor(fn, ms) {
    const t = Date.now();
    while (!fn() && Date.now() - t < ms) await sleep(20);
    return fn();
}

function sameBytes(a, b) {
    if (!a || !b || a.length !== b.length || a.constructor !== b.constructor) return false;
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
}

function cutoutSource() {
    const src = new Uint8ClampedArray(SIZE * SIZE * 4);
    for (let i = 3; i < src.length; i += 4) src[i] = 255;
    for (let y = 200; y < 800; y++) for (let x = 250; x < 700; x++) { const i = (y * SIZE + x) * 4; src[i] = 250; src[i + 1] = 200; src[i + 2] = 60; }
    return src;
}

async function processMain() {
    const { HelperProcess, STOPPED, REASONS } = require("../electron/main/onnx/helpers");
    const { engine, modelInfo } = require("../electron/main/onnx/engine");
    const device = args.includes("--cpu") ? "cpu" : "auto";
    console.log("models in", dir, also ? "and " + also : "", "· device", device);
    let failures = 0;
    const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`); if (!ok) failures++; return ok; };

    const sam = models.byId(sam2Id), samFiles = pathsOf(sam);
    const mat = models.byId(mattingId), matFiles = pathsOf(mat);
    const dep = models.byId(depthId), depFiles = pathsOf(dep);
    for (const [m, f] of [[sam, samFiles], [mat, matFiles], [dep, depFiles]]) if (!f) console.log(`${m ? m.label : "a model"} not present, skipped`);
    if (!samFiles && !matFiles && !depFiles) { console.log("FAIL no model present"); process.exit(1); }

    const W = 784, H = 518;
    const objectsJob = samFiles && { device, model: modelInfo(sam), files: samFiles, key: "test", image: synthetic(), outWidth: SIZE, outHeight: SIZE, params: {} };
    const pointJob = samFiles && { device, model: modelInfo(sam), files: samFiles, key: "test", image: null, points: [{ x: 750, y: 280, label: 1 }], box: null, raw: true };
    const pointWithImage = samFiles && { ...pointJob, image: objectsJob.image };
    const jobs = [];
    if (samFiles) {
        jobs.push(["objects", "objects", objectsJob]);
        jobs.push(["point", "segment", pointJob]);
        jobs.push(["point_mask", "segment", { ...pointJob, raw: false, box: [560, 100, 940, 460], outWidth: 512, outHeight: 300 }]);
    }
    if (matFiles) jobs.push(["cutout", "cutout", { device, model: modelInfo(mat), files: matFiles, image: cutoutSource() }]);
    if (depFiles) jobs.push(["depth", "depth", { device, model: modelInfo(dep), files: depFiles, image: syntheticDepth(W, H), width: W, height: H }]);

    // 1. every job through the helpers' process, then the same on this thread's engine
    const hp = new HelperProcess({ idleMs: 0 });
    const viaProc = {}, viaLocal = {};
    for (const [name, type, job] of jobs) {
        const t = Date.now();
        viaProc[name] = await hp.call(type, job);
        console.log(`process ${name}: ${Date.now() - t} ms on ${viaProc[name].provider} (pid ${hp.pid})`);
    }
    const pid0 = hp.pid;
    check("the jobs ran in the helpers' process", hp.state === "ready" && pid0 && pid0 !== process.pid && hp.starts === 1, `state ${hp.state}, pid ${pid0}, starts ${hp.starts}`);
    const st = hp.status(device);
    check("status from the last answer: its sessions and its pid, no call into it", st.loaded >= 1 && st.process.pid === pid0 && st.process.state === "ready" && !!st.version,
        JSON.stringify({ loaded: st.loaded, active: Object.values(st.active), process: st.process, version: st.version }));
    const released = await hp.retire({ reason: "free" });
    check("Free VRAM with nothing running: the process gone at once, its sessions counted, nothing loaded after", released === st.loaded && !alive(pid0) && hp.state === "off" && hp.status(device).loaded === 0 && hp.status(device).process.pid === null,
        `released ${released}, alive ${alive(pid0)}`);
    const local = engine(new Runtime());
    for (const [name, type, job] of jobs) {
        local.runtime.setDevice(job.device);
        const t = Date.now();
        viaLocal[name] = await local[type](job);
        console.log(`this thread ${name}: ${Date.now() - t} ms on ${viaLocal[name].provider}`);
    }
    await local.free();
    const keys = (o) => Object.keys(o).sort().join(",");
    for (const [name] of jobs) {
        const a = viaProc[name], b = viaLocal[name];
        check(`${name}: the same answer's fields in the process and on this thread`, keys(a) === keys(b), keys(a));
    }
    if (samFiles) {
        const a = viaProc.objects, b = viaLocal.objects;
        check("objects: the label map's bytes the same", sameBytes(a.ids, b.ids) && a.count === b.count && a.candidates === b.candidates, `${a.count} / ${b.count} objects, ${a.candidates} / ${b.candidates} candidates`);
        const idAt = (x, y) => a.ids[y * SIZE + x];
        const red = idAt(260, 300), blue = idAt(750, 280), yellow = idAt(530, 760), bg = idAt(50, 1000);
        check("objects: the three shapes three objects, apart from the background", new Set([red, blue, yellow]).size === 3 && red && blue && yellow && ![red, blue, yellow].includes(bg), `red ${red}, blue ${blue}, yellow ${yellow}, background ${bg}`);
        check("point: the logits' bytes and the score the same", sameBytes(viaProc.point.logits, viaLocal.point.logits) && viaProc.point.score === viaLocal.point.score && viaProc.point.n === 256, `score ${viaProc.point.score}`);
        check("point with a box, as a mask: the bytes the same", sameBytes(viaProc.point_mask.mask, viaLocal.point_mask.mask) && viaProc.point_mask.width === 512 && viaProc.point_mask.height === 300);
        const mask = logitsToMask(viaProc.point.logits, SIZE, SIZE);
        let inside = 0, outside = 0;
        for (let y = 0; y < SIZE; y += 4) for (let x = 0; x < SIZE; x += 4) {
            const isBlue = ((x - 750) / 190) ** 2 + ((y - 280) / 180) ** 2 <= 1;
            if (isBlue) inside += mask[y * SIZE + x]; else outside += mask[y * SIZE + x];
        }
        check("point: the blue ellipse", inside > 1000 && outside < inside * 0.1, `inside ${inside}, outside ${outside}`);
    }
    if (matFiles) {
        const a = viaProc.cutout;
        check("cutout: the alpha's bytes the same", sameBytes(a.alpha, viaLocal.cutout.alpha) && a.size === viaLocal.cutout.size);
        let inA = 0, outA = 0, nIn = 0, nOut = 0;
        for (let y = 0; y < SIZE; y += 8) for (let x = 0; x < SIZE; x += 8) {
            const v = a.alpha[y * SIZE + x];
            if (y >= 220 && y < 780 && x >= 270 && x < 680) { inA += v; nIn++; } else if (y < 150 || y > 850 || x < 200 || x > 750) { outA += v; nOut++; }
        }
        check("cutout: the rectangle kept, the black gone", inA / nIn > 200 && outA / nOut < 40, `inside ${(inA / nIn).toFixed(0)}, outside ${(outA / nOut).toFixed(0)}`);
    }
    if (depFiles) {
        const a = viaProc.depth, b = viaLocal.depth;
        check("depth: the map's bytes, min and max the same", sameBytes(a.depth, b.depth) && a.min === b.min && a.max === b.max && a.width === W && a.height === H, `range [${a.min.toFixed(2)}, ${a.max.toFixed(2)}] on ${a.provider}`);
    }

    if (samFiles) {
        // 2. Free VRAM (the button, or the free a local ComfyUI run does) during an object map: the map still lands and
        // the process ends after it, a job sent meanwhile goes to a new process; a job longer than the drain is refused
        // naming the cause; a model's removal ends the process at once, refusing its job with that cause; a point
        // without its picture on a new process is refused (the window sends the picture then), with it answered
        const hp2 = new HelperProcess({ idleMs: 0 });
        await hp2.call("segment", pointWithImage);
        const pid1 = hp2.pid;
        const map = hp2.call("objects", { ...objectsJob, key: "drain" }).then((r) => r, (e) => ({ error: e.message }));
        await sleep(300);
        const freed = hp2.retire({ reason: "free" });
        check("a retired process takes no new job", hp2.pid === null && hp2.state === "off" && hp2.status(device).process.retiring === 1 && hp2.busy());
        const during = hp2.call("segment", pointWithImage);
        const landed = await map;
        const releasedB = await freed;
        check("Free VRAM during an object map: the map still lands, the same bytes", !landed.error && sameBytes(landed.ids, viaProc.objects.ids), landed.error || `${landed.count} objects`);
        check("... and the retired process ended after it", !alive(pid1) && hp2.status(device).process.retiring === 0 && releasedB >= 0, `released ${releasedB}`);
        const dur = await during;
        check("a job sent during the drain went to a new process", hp2.pid && hp2.pid !== pid1 && hp2.starts === 2 && sameBytes(dur.logits, viaProc.point.logits), `pid ${hp2.pid}, starts ${hp2.starts}`);
        const pidB = hp2.pid;
        const capped = hp2.call("objects", { ...objectsJob, key: "cap" }).then(() => "answered", (e) => e.message);
        await sleep(200);
        await hp2.retire({ reason: "free", drainMs: 100 });
        const rCap = await capped;
        check("a job the drain cannot wait for is refused, naming the cause", rCap === REASONS.free, rCap);
        check("... and that process is gone", !alive(pidB) && hp2.pid === null);
        await hp2.call("segment", pointWithImage);
        const pidC = hp2.pid;
        const removed = hp2.call("objects", { ...objectsJob, key: "remove" }).then(() => "answered", (e) => e.message);
        await sleep(200);
        await hp2.kill({ reason: "remove" });
        const rRemove = await removed;
        check("a model's removal ends the process at once and refuses its job, naming the cause", rRemove === REASONS.remove && !alive(pidC) && hp2.pid === null, rRemove);
        const startsBefore = hp2.starts;
        const noImage = await hp2.call("segment", pointJob).then(() => "answered", (e) => e.message);
        check("a point without its picture on the new process is refused (host.segmentLogits sends it then)", /RGBA image of 1024/.test(noImage), noImage);
        const again = await hp2.call("segment", pointWithImage);
        check("the next job started a new process and answered the same", hp2.pid && hp2.pid !== pidC && hp2.starts === startsBefore + 1 && sameBytes(again.logits, viaProc.point.logits), `pid ${hp2.pid}, starts ${hp2.starts}`);

        // 3. a death after "ready" (killed from outside, as a crash ends it) during a job: refused; the next job starts
        // a new process; a second death within the minute leaves the helpers to this thread
        const pid2 = hp2.pid;
        const dying = hp2.call("objects", { ...objectsJob, key: "death" }).then(() => "answered", (e) => e.message);
        await sleep(300);
        process.kill(pid2);
        const r2 = await dying;
        check("a death refuses the job under way", r2 === STOPPED && hp2.state === "off" && hp2.deaths.length === 1, `${r2}; state ${hp2.state}, deaths ${hp2.deaths.length}`);
        const after = await hp2.call("segment", pointWithImage);
        const pid3 = hp2.pid;
        check("the job after a death starts a new process", pid3 && pid3 !== pid2 && hp2.starts === startsBefore + 2 && sameBytes(after.logits, viaProc.point.logits), `pid ${pid3}`);
        process.kill(pid3);
        await waitFor(() => hp2.state === "fallback", 5000);
        check("a second death within a minute falls back to this thread", hp2.state === "fallback" && !!hp2.local && hp2.pid === null, `state ${hp2.state}`);
        const fb = await hp2.call("segment", pointWithImage);
        check("the fallback answers on this thread, the same bytes", sameBytes(fb.logits, viaProc.point.logits) && hp2.starts === startsBefore + 2 && hp2.status(device).process.state === "fallback");
        await hp2.kill();

        // 4. a process that ends at its start (onnxruntime missing, say): the engine runs here, the waiting job answered
        const script = path.join(os.tmpdir(), `scumble_u1_exit_${process.pid}.js`);
        fs.writeFileSync(script, "process.exit(3);\n");
        const hp3 = new HelperProcess({ script, idleMs: 0 });
        const r3 = await hp3.call("segment", pointWithImage).then((r) => r, (e) => ({ error: e.message }));
        check("a process that exits at once falls back with the waiting job answered", hp3.state === "fallback" && r3.logits && sameBytes(r3.logits, viaProc.point.logits), r3.error || `state ${hp3.state}`);
        await hp3.kill();
        fs.unlinkSync(script);

        // 5. the idle unload: never while a job runs (a cold point takes longer than the 200 ms here), then the end
        const hp4 = new HelperProcess({ idleMs: 200 });
        const cold = await hp4.call("segment", pointWithImage).then((r) => r, (e) => ({ error: e.message }));
        const pid4 = hp4.pid;
        check("the idle timer does not end a job under way", !!cold.logits && hp4.state === "ready", cold.error || "");
        await waitFor(() => hp4.state === "off" && !alive(pid4), 3000);
        check("the idle unload ended the process after the last answer", hp4.state === "off" && !alive(pid4) && hp4.status(device).loaded === 0, `state ${hp4.state}`);
        await hp4.kill();
    }

    console.log(failures ? `FAIL ${failures} check(s)` : "PASS");
    process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
