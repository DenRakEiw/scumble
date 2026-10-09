// Test edge mathematics module (R2-S2 / PLAN_NIK9_BUILD sec 3.3) in plain Node:
// - off equals bilinear (1,000 random points on 37x23 map)
// - flat map (constant 30000, any colour, strength 100 -> 30000/65535, k=0)
// - step snaps by colour (16x16 map, red/blue guide)
// - monotone in strength (strengths 0, 25, 50, 100)
// - fit exact & robust (least-squares scale & shift with 90th percentile outlier rejection)
// - fuse better than global & no seams (ground truth synthetic scene, 2x2 tiles)
// - dropped tile (a <= 0 dropped -> lowpass global on that tile)
// - edge tiles (400x300 map vertical step on 1600x1200 doc, identity and 90 deg xf)
// - tileBoxes (6000x4000 grid 2 overlap 0.25 -> 4 boxes 3429x2286)

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

async function main() {
    console.log("Running edges_test.js (R2-S2 Edge Maths)...");

    const edgesMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_edges.js")).href);
    const weightsMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_weights.js")).href);

    const {
        SNAP_TAU,
        SNAP_DEFAULT,
        snapParams,
        snapField,
        SNAP_GLSL,
        tileBoxes,
        fusedSize,
        fitScaleShift,
        fuseTiles,
        rangeMax,
        edgeTiles,
        gaussRadii,
        gaussBlur,
    } = edgesMod;

    const { u16Bilinear } = weightsMod;

    // -------------------------------------------------------------------------
    // 1. Constants and parameter mappings
    // -------------------------------------------------------------------------
    assert.equal(SNAP_TAU, 0.02, "SNAP_TAU is 0.02");
    assert.equal(SNAP_DEFAULT, 50, "SNAP_DEFAULT is 50");

    assert.equal(snapParams(0), null, "strength 0 gives null");
    const sp50 = snapParams(50);
    assert.ok(sp50, "strength 50 gives params");
    assert.equal(sp50[1], 0.02, "tau is SNAP_TAU");
    // sigmaR: mix(0.25, 0.04, 0.5) = 0.145
    assert.ok(Math.abs(sp50[0] - 0.145) < 1e-6, "sigmaR at 50 is 0.145");

    assert.ok(typeof SNAP_GLSL === "string" && SNAP_GLSL.includes("float snapField"), "SNAP_GLSL exported");

    // -------------------------------------------------------------------------
    // 2. off equals bilinear (1,000 random points on 37 x 23 random map, sigmaR = 0)
    // -------------------------------------------------------------------------
    console.log("  1. off equals bilinear...");
    const mw1 = 37, mh1 = 23;
    const mData1 = new Uint16Array(mw1 * mh1);
    for (let i = 0; i < mData1.length; i++) mData1[i] = Math.floor(Math.random() * 65536);
    const guide1 = new Uint8Array(mw1 * mh1 * 4);
    for (let i = 0; i < guide1.length; i++) guide1[i] = Math.floor(Math.random() * 256);

    const map1 = { data: mData1, w: mw1, h: mh1 };
    for (let i = 0; i < 1000; i++) {
        const rx = Math.random() * (mw1 + 2) - 1;
        const ry = Math.random() * (mh1 + 2) - 1;
        const vSnap = snapField(map1, guide1, rx, ry, 0.5, 0.5, 0.5, 0, SNAP_TAU);
        const vBil = u16Bilinear(mData1, mw1, mh1, rx, ry);
        assert.equal(vSnap, vBil, `sigmaR=0 must equal u16Bilinear exactly at (${rx}, ${ry})`);
    }
    console.log("     [ok] 1,000 points match u16Bilinear exactly when sigmaR = 0");

    // -------------------------------------------------------------------------
    // 3. flat map: every texel 30000, any colour, strength 100 -> 30000 / 65535 (k = 0)
    // -------------------------------------------------------------------------
    console.log("  2. flat map...");
    const flatData = new Uint16Array(16 * 16);
    flatData.fill(30000);
    const flatGuide = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < flatGuide.length; i++) flatGuide[i] = (i * 17) % 256;
    const [sigmaR100, tau100] = snapParams(100);
    const flatVal = snapField({ data: flatData, w: 16, h: 16 }, flatGuide, 8.3, 8.3, 0.2, 0.8, 0.4, sigmaR100, tau100);
    const expectedFlat = 30000 / 65535;
    assert.ok(Math.abs(flatVal - expectedFlat) < 1e-12, `flat map must equal 30000/65535 within 1e-12, got ${flatVal}`);
    console.log("     [ok] flat map returns exact flat value (k = 0)");

    // -------------------------------------------------------------------------
    // 4. step snaps by colour
    // 16 x 16 map: x < 8 -> 0.2, x >= 8 -> 0.8; guide red for x < 8, blue for x >= 8; strength 100
    // At mx = 8.3 with blue >= 0.79; at mx = 7.7 with red <= 0.21 (bilinear gives 0.38 / 0.62)
    // -------------------------------------------------------------------------
    console.log("  3. step snaps by colour...");
    const stepData = new Uint16Array(16 * 16);
    const stepGuide = new Uint8Array(16 * 16 * 4);
    for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
            const idx = y * 16 + x;
            if (x < 8) {
                stepData[idx] = Math.round(0.2 * 65535);
                stepGuide[idx * 4] = 255;     // Red
                stepGuide[idx * 4 + 1] = 0;
                stepGuide[idx * 4 + 2] = 0;
                stepGuide[idx * 4 + 3] = 255;
            } else {
                stepData[idx] = Math.round(0.8 * 65535);
                stepGuide[idx * 4] = 0;
                stepGuide[idx * 4 + 1] = 0;
                stepGuide[idx * 4 + 2] = 255; // Blue
                stepGuide[idx * 4 + 3] = 255;
            }
        }
    }
    const stepMap = { data: stepData, w: 16, h: 16 };

    // At mx = 8.3 (x in [0..16], centre at 0.5):
    // In pure bilinear:
    const bilAt83 = u16Bilinear(stepData, 16, 16, 8.3, 8.0);
    // mx = 8.3 with blue colour [0, 0, 1] at strength 100:
    const snapBlueAt83 = snapField(stepMap, stepGuide, 8.3, 8.0, 0, 0, 1, sigmaR100, tau100);
    assert.ok(snapBlueAt83 >= 0.79, `mx=8.3 with blue must be >= 0.79, got ${snapBlueAt83} (bilinear: ${bilAt83})`);

    // At mx = 7.7 with red colour [1, 0, 0] at strength 100:
    const snapRedAt77 = snapField(stepMap, stepGuide, 7.7, 8.0, 1, 0, 0, sigmaR100, tau100);
    assert.ok(snapRedAt77 <= 0.21, `mx=7.7 with red must be <= 0.21, got ${snapRedAt77}`);
    console.log(`     [ok] mx=8.3 (blue): ${snapBlueAt83.toFixed(4)} >= 0.79, mx=7.7 (red): ${snapRedAt77.toFixed(4)} <= 0.21`);

    // -------------------------------------------------------------------------
    // 5. monotone in strength
    // the step, mx = 8.3, blue, strengths 0 / 25 / 50 / 100 -> |v - 0.8| strictly decreasing
    // -------------------------------------------------------------------------
    console.log("  4. monotone in strength...");
    const strengths = [0, 25, 50, 100];
    const diffs = strengths.map((s) => {
        const p = snapParams(s);
        const sig = p ? p[0] : 0;
        const v = snapField(stepMap, stepGuide, 8.3, 8.0, 0, 0, 1, sig, SNAP_TAU);
        return Math.abs(v - 0.8);
    });

    for (let i = 0; i < diffs.length - 1; i++) {
        assert.ok(diffs[i] >= diffs[i + 1], `diff at strength ${strengths[i]} (${diffs[i]}) must be >= diff at ${strengths[i + 1]} (${diffs[i + 1]})`);
    }
    assert.ok(diffs[0] > diffs[1] && diffs[1] > diffs[2], "diff strictly decreases across 0 -> 25 -> 50 until float64 machine zero");
    console.log("     [ok] errors strictly decrease with strength:", diffs.map((d) => d.toFixed(5)).join(" > "));

    // -------------------------------------------------------------------------
    // 6. fitScaleShift exact & robust
    // -------------------------------------------------------------------------
    console.log("  5. fitScaleShift exact and robust...");
    const nPts = 1000;
    const tExact = new Float64Array(nPts);
    const gExact = new Float64Array(nPts);
    for (let i = 0; i < nPts; i++) {
        tExact[i] = Math.random() * 2 - 1;
        gExact[i] = 0.4 * tExact[i] - 0.12;
    }
    const fitEx = fitScaleShift(tExact, gExact, nPts);
    assert.ok(Math.abs(fitEx.a - 0.4) < 1e-9, `exact fit a must be 0.4 within 1e-9, got ${fitEx.a}`);
    assert.ok(Math.abs(fitEx.b - (-0.12)) < 1e-9, `exact fit b must be -0.12 within 1e-9, got ${fitEx.b}`);
    assert.ok(Math.abs(fitEx.r2 - 1.0) < 1e-6, `exact fit r2 must be 1.0, got ${fitEx.r2}`);

    // Robust fit with 10% outliers (+0.5)
    const gRobust = new Float32Array(gExact);
    for (let i = 0; i < Math.floor(nPts * 0.1); i++) {
        gRobust[i] += 0.5; // Outlier
    }
    const fitRob = fitScaleShift(tExact, gRobust, nPts);
    assert.ok(Math.abs(fitRob.a - 0.4) < 1e-2, `robust fit a error < 1e-2, got ${fitRob.a}`);
    assert.ok(Math.abs(fitRob.b - (-0.12)) < 1e-2, `robust fit b error < 1e-2, got ${fitRob.b}`);
    console.log(`     [ok] exact fit a=${fitEx.a.toFixed(9)}, b=${fitEx.b.toFixed(9)}; robust fit a=${fitRob.a.toFixed(4)}, b=${fitRob.b.toFixed(4)}`);

    // -------------------------------------------------------------------------
    // 7. tileBoxes
    // W = 6000, H = 4000, g = 2, o = 0.25 -> 4 boxes 3429 x 2286, all equal, union = the picture
    // -------------------------------------------------------------------------
    console.log("  6. tileBoxes...");
    const boxes = tileBoxes(6000, 4000, 2, 0.25);
    assert.equal(boxes.length, 4, "grid 2 gives 4 boxes");
    for (const b of boxes) {
        assert.equal(b.x1 - b.x0, 3429, `box width must be 3429, got ${b.x1 - b.x0}`);
        assert.equal(b.y1 - b.y0, 2286, `box height must be 2286, got ${b.y1 - b.y0}`);
    }
    assert.equal(boxes[0].x0, 0); assert.equal(boxes[0].y0, 0);
    assert.equal(boxes[3].x1, 6000); assert.equal(boxes[3].y1, 4000);
    console.log("     [ok] tileBoxes 6000x4000 produces 4 equal 3429x2286 boxes covering the image");

    // -------------------------------------------------------------------------
    // 8. fusedSize
    // -------------------------------------------------------------------------
    console.log("  7. fusedSize...");
    const [fw, fh] = fusedSize(6000, 4000, boxes, 518);
    // sf = 518 / 2286 = 0.226596...
    // wf = round(6000 * sf) = 1360, hf = round(4000 * sf) = 906
    assert.ok(fw > 0 && fh > 0, "fusedSize positive");
    assert.ok(Math.abs(fw / fh - 6000 / 4000) < 0.01, "aspect preserved");
    console.log(`     [ok] fusedSize is ${fw} x ${fh}`);

    // -------------------------------------------------------------------------
    // 9. fuseTiles & dropped tile & no seams
    // Ground truth 1200 x 800: three planes, an 8 px pole, sine texture;
    // global = GT blurred (sigma 6) to 300 x 200, * 1.7 + 0.2;
    // tiles (2 x 2) = GT blurred (sigma 2) per box at fused scale, each with scale and shift;
    // MAE <= 0.6 * global's; pole contrast >= 50% of GT; no seams: max |dx| on overlap <= 1.5 * median |dx| within 8 px
    // -------------------------------------------------------------------------
    console.log("  8. fuseTiles, no seams, and dropped tile...");
    const W = 1200, H = 800;
    const gt = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            let v = 0.2;
            if (x < 400) v = 0.3 + 0.2 * (y / H); // Plane 1
            else if (x < 800) v = 0.6 - 0.1 * (x / W); // Plane 2
            else v = 0.85; // Plane 3

            // 8 px pole at x = 200..208, y = 200..600
            if (x >= 200 && x < 208 && y >= 200 && y < 600) v = 0.1;
            // Sine texture
            v += 0.05 * Math.sin(x * 0.15) * Math.cos(y * 0.15);
            gt[y * W + x] = Math.max(0, Math.min(1, v));
        }
    }

    // Global: GT blurred (sigma 6) to 300 x 200, * 1.7 + 0.2
    const gtBlurredGlobal = gaussBlur(gt, W, H, 6.0);
    const gw = 300, gh = 200;
    const gtDown = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
        const sy = Math.floor((gy + 0.5) * (H / gh));
        for (let gx = 0; gx < gw; gx++) {
            const sx = Math.floor((gx + 0.5) * (W / gw));
            gtDown[gy * gw + gx] = gtBlurredGlobal[sy * W + sx];
        }
    }
    const globalData = new Float32Array(gw * gh);
    for (let i = 0; i < gw * gh; i++) globalData[i] = gtDown[i] * 1.7 + 0.2;
    const globalMap = { data: globalData, w: gw, h: gh };

    // Detail tiles 2x2: GT blurred (sigma 2) per box at fused scale, each with its own scale and shift
    const gtBlurredTiles = gaussBlur(gt, W, H, 2.0);
    const tboxes = tileBoxes(W, H, 2, 0.25);
    const [wfGrid, hfGrid] = fusedSize(W, H, tboxes, 518); // Fused grid
    const tileList = [];
    const tileScales = [0.8, 1.2, 0.9, 1.1];
    const tileShifts = [0.1, -0.05, 0.05, -0.1];

    for (let idx = 0; idx < tboxes.length; idx++) {
        const b = tboxes[idx];
        const tw = b.x1 - b.x0;
        const th = b.y1 - b.y0;
        const tData = new Float32Array(tw * th);
        for (let ty = 0; ty < th; ty++) {
            const sy = b.y0 + ty;
            for (let tx = 0; tx < tw; tx++) {
                const sx = b.x0 + tx;
                tData[ty * tw + tx] = gtBlurredTiles[sy * W + sx] * tileScales[idx] + tileShifts[idx];
            }
        }
        tileList.push({ box: b, data: tData, w: tw, h: th });
    }

    const fused = fuseTiles(globalMap, tileList, W, H, wfGrid, hfGrid);
    assert.equal(fused.fits.length, 4, "4 fits returned");
    for (const f of fused.fits) {
        assert.ok(!f.dropped, "all valid tiles kept");
        assert.ok(f.r2 > 0.8, `r2 must be high, got ${f.r2}`);
    }

    // Downscale GT to fused grid for comparison (if fused != doc size):
    const gtFused = new Float32Array(wfGrid * hfGrid);
    for (let y = 0; y < hfGrid; y++) {
        const sy = Math.floor((y + 0.5) * (H / hfGrid));
        for (let x = 0; x < wfGrid; x++) {
            const sx = Math.floor((x + 0.5) * (W / wfGrid));
            gtFused[y * wfGrid + x] = gt[sy * W + sx];
        }
    }

    // Global resampled to fused grid (bilinear):
    const gUp = new Float32Array(wfGrid * hfGrid);
    for (let y = 0; y < hfGrid; y++) {
        const gy = (y + 0.5) * (gh / hfGrid) - 0.5;
        const y0 = Math.max(0, Math.min(gh - 1, Math.floor(gy)));
        const y1 = Math.max(0, Math.min(gh - 1, y0 + 1));
        const fy = gy - Math.floor(gy);
        for (let x = 0; x < wfGrid; x++) {
            const gx = (x + 0.5) * (gw / wfGrid) - 0.5;
            const x0 = Math.max(0, Math.min(gw - 1, Math.floor(gx)));
            const x1 = Math.max(0, Math.min(gw - 1, x0 + 1));
            const fx = gx - Math.floor(gx);
            const v00 = globalData[y0 * gw + x0];
            const v10 = globalData[y0 * gw + x1];
            const v01 = globalData[y1 * gw + x0];
            const v11 = globalData[y1 * gw + x1];
            gUp[y * wfGrid + x] = (v00 + fx * (v10 - v00)) * (1 - fy) + (v01 + fx * (v11 - v01)) * fy;
        }
    }

    // Fit global to GT
    const fitG = fitScaleShift(gUp, gtFused, wfGrid * hfGrid);
    let maeGlobal = 0;
    for (let i = 0; i < wfGrid * hfGrid; i++) maeGlobal += Math.abs((fitG.a * gUp[i] + fitG.b) - gtFused[i]);
    maeGlobal /= (wfGrid * hfGrid);

    // Fit fused to GT
    const fitF = fitScaleShift(fused.data, gtFused, wfGrid * hfGrid);
    let maeFused = 0;
    for (let i = 0; i < wfGrid * hfGrid; i++) maeFused += Math.abs((fitF.a * fused.data[i] + fitF.b) - gtFused[i]);
    maeFused /= (wfGrid * hfGrid);

    assert.ok(maeFused <= 0.6 * maeGlobal, `fused MAE (${maeFused.toFixed(4)}) must be <= 0.6 * global MAE (${maeGlobal.toFixed(4)})`);

    // Check pole contrast:
    // Pole at x ~ 204 on 1200 grid -> xf ~ 204 * (wfGrid / 1200)
    const poleX = Math.round(204 * (wfGrid / W));
    const poleY = Math.round(400 * (hfGrid / H));
    const fusedPoleVal = fitF.a * fused.data[poleY * wfGrid + poleX] + fitF.b;
    const fusedBgVal = fitF.a * fused.data[poleY * wfGrid + (poleX - 12)] + fitF.b;
    const fusedContrast = Math.abs(fusedPoleVal - fusedBgVal);
    const gtContrast = Math.abs(gtFused[poleY * wfGrid + poleX] - gtFused[poleY * wfGrid + (poleX - 12)]);
    assert.ok(fusedContrast >= 0.5 * gtContrast, `pole contrast (${fusedContrast.toFixed(3)}) must be >= 50% of GT (${gtContrast.toFixed(3)})`);
    console.log(`     [ok] fuseTiles MAE ${maeFused.toFixed(4)} <= 0.6 * global ${maeGlobal.toFixed(4)}, pole contrast: ${(fusedContrast / gtContrast * 100).toFixed(1)}%`);

    // No seams test: max |dx| on overlap borders <= 1.5 * median |dx| within 8 px
    for (const bx of [tboxes[1].x0, tboxes[0].x1]) {
        let worstRatio = 0;
        for (let y = 50; y < 350; y++) {
            const borderDx = Math.abs(fused.data[y * wfGrid + bx] - fused.data[y * wfGrid + (bx - 1)]);
            const neighbors = [];
            for (let d = -8; d <= 8; d++) {
                if (d !== 0) neighbors.push(Math.abs(fused.data[y * wfGrid + bx + d] - fused.data[y * wfGrid + bx + d - 1]));
            }
            neighbors.sort((a, b) => a - b);
            const med = neighbors[Math.floor(neighbors.length / 2)];
            if (med > 1e-6) {
                worstRatio = Math.max(worstRatio, borderDx / med);
            }
        }
        assert.ok(worstRatio <= 1.5, `max |dx| on overlap border ${bx} <= 1.5 * median within 8 px (got ${worstRatio})`);
    }
    console.log("     [ok] no seams: max |dx| on overlap borders <= 1.5 * median |dx| within 8 px");

    // Dropped tile test: tile 0 with a = -1 (invert)
    const badTileList = tileList.map((t, idx) => {
        if (idx === 0) {
            const badData = new Float32Array(t.data.length);
            for (let k = 0; k < badData.length; k++) badData[k] = -t.data[k];
            return { ...t, data: badData };
        }
        return t;
    });
    const fusedBad = fuseTiles(globalMap, badTileList, W, H, wfGrid, hfGrid);
    assert.ok(fusedBad.fits[0].dropped, "tile 0 dropped when a <= 0");

    // Fused equals the upsampled lowpass global where only that tile covers, within 1e-6
    const fusedNone = fuseTiles(globalMap, [], W, H, wfGrid, hfGrid);
    let maxDiffLow = 0;
    for (let y = 0; y < tboxes[2].y0; y++) {
        for (let x = 0; x < tboxes[1].x0; x++) {
            const diff = Math.abs(fusedBad.data[y * wfGrid + x] - fusedNone.data[y * wfGrid + x]);
            if (diff > maxDiffLow) maxDiffLow = diff;
        }
    }
    assert.ok(maxDiffLow < 1e-6, `dropped tile covers match lowpass global within 1e-6 (got ${maxDiffLow})`);
    console.log("     [ok] inverted tile successfully marked dropped and matches lowpass global");

    // -------------------------------------------------------------------------
    // 10. rangeMax & edgeTiles
    // a 400 x 300 map with one vertical step, doc 1600 x 1200, identity xf
    // -> only the tile column of the step's doc x (+- 1 column) is 1; under 90 deg xf the flagged set is a row
    // -------------------------------------------------------------------------
    console.log("  9. rangeMax and edgeTiles...");
    const emW = 400, emH = 300;
    const edgeMapData = new Uint16Array(emW * emH);
    // Vertical step at x = 200
    for (let y = 0; y < emH; y++) {
        for (let x = 0; x < emW; x++) {
            edgeMapData[y * emW + x] = x < 200 ? 10000 : 50000;
        }
    }
    const edgeMap = { data: edgeMapData, w: emW, h: emH };
    const rmax = rangeMax(edgeMap);
    assert.equal(rmax.length, emW * emH, "rangeMax buffer length matches");

    // Check rmax values: should be high around x = 200, 0 elsewhere
    assert.equal(rmax[150 * emW + 50], 0, "flat region has rmax 0");
    assert.equal(rmax[150 * emW + 350], 0, "flat region has rmax 0");
    assert.ok(rmax[150 * emW + 200] > 30000, "step edge has rmax > 30000");

    // Document 1600 x 1200, tiles 256 x 256 -> 7 cols x 5 rows
    // Identity mapping doc px -> map px: scale 400/1600 = 0.25
    const docW = 1600, docH = 1200;
    const xfDocToMap = [0.25, 0, 0, 0.25, 0, 0];
    const et = edgeTiles(edgeMap, rmax, xfDocToMap, docW, docH, SNAP_TAU, 256);
    const cols = Math.ceil(docW / 256); // 7
    const rows = Math.ceil(docH / 256); // 5

    // Step at map x = 200 corresponds to doc x = 800.
    // Tile index for doc x = 800 is Math.floor(800 / 256) = 3.
    // Only col 3 (or +- 1 col) should be 1
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const val = et[r * cols + c];
            if (Math.abs(c - 3) <= 1) {
                // Should be flagged at or near the boundary
                if (c === 3) assert.equal(val, 1, `tile col 3 must be flagged at row ${r}`);
            } else {
                assert.equal(val, 0, `tile col ${c} must not be flagged at row ${r}`);
            }
        }
    }
    console.log("     [ok] vertical step flags only step column (+- 1 col)");

    // Under 90 deg rotation xf: step in map is horizontal in doc -> flags a row
    // Doc x, y -> Map y, -x
    // e.g. xf sends doc y ~ 800 to map x ~ 200
    const xfRot90 = [0, 0.25, -0.25, 0, 300, 0];
    const etRot = edgeTiles(edgeMap, rmax, xfRot90, docW, docH, SNAP_TAU, 256);
    // Now a row is flagged, not all columns
    let flaggedRows = new Set();
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (etRot[r * cols + c] === 1) flaggedRows.add(r);
        }
    }
    assert.ok(flaggedRows.size >= 1 && flaggedRows.size <= 3, `90 deg xf flags a horizontal row set, got ${flaggedRows.size} rows`);
    console.log("     [ok] 90 deg transform flags horizontal rows correctly");

    console.log("\nALL EDGE MATHS TESTS PASSED!");
}

main().catch((err) => {
    console.error("FAILED:", err);
    process.exit(1);
});
