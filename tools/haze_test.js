// Test dehaze mathematics module (R2-S13 / PLAN_NIK9_BUILD sec 3.3) in plain Node:
// - minFilter on random 50x40, r=3 against brute force (exact)
// - minFilter with r >= w and r = 0 edge cases
// - darkChannel of a constant image (min channel everywhere)
// - airlight on synthetic I = J*t + A*(1 - t), A=(0.8, 0.85, 0.9), J textured, t ramp 0.2..1 (within 0.03/ch)
// - transmission recovered: Pearson corr(t_est, t_true) >= 0.9
// - guidedFilter against brute-force double loop on 64x48 (within 1e-4)
// - guidedFilter limits: eps -> 1e9 approaches box(box(p)), p = I with eps -> 1e-9 approaches I (within 1e-3)
// - determinism: same input produces byte-equal t
// - cost: 768x512 in < 60 ms under Node with JS kernels

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

async function main() {
    console.log("Running haze_test.js (R2-S13 Dehaze Maths)...");

    const hazeMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_haze.js")).href);
    const kernelsMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "px", "kernels.js")).href);

    const { minFilter, darkChannel, airlight, guidedFilter, dehazeStats } = hazeMod;
    const { boxBlurs } = kernelsMod;

    // -------------------------------------------------------------------------
    // 1. minFilter against brute force on 50x40 with r = 3 (exact)
    // -------------------------------------------------------------------------
    {
        const w = 50, h = 40, r = 3;
        const n = w * h;
        const src = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            src[i] = Math.random();
        }

        const filtered = minFilter(src, w, h, r);
        assert.equal(filtered.length, n, "minFilter returns matching length");

        // Brute force 2D min with replicated edges
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let m = Infinity;
                for (let dy = -r; dy <= r; dy++) {
                    const cy = Math.max(0, Math.min(h - 1, y + dy));
                    for (let dx = -r; dx <= r; dx++) {
                        const cx = Math.max(0, Math.min(w - 1, x + dx));
                        const v = src[cy * w + cx];
                        if (v < m) m = v;
                    }
                }
                const act = filtered[y * w + x];
                assert.equal(act, m, `minFilter mismatch at (${x}, ${y}): got ${act}, expected ${m}`);
            }
        }
        console.log("     [ok] minFilter 50x40 r=3 matches brute force exactly");
    }

    // -------------------------------------------------------------------------
    // 2. minFilter edge cases: r = 0, r >= w (e.g. w=20, h=15, r=25), w=1, h=1
    // -------------------------------------------------------------------------
    {
        // r = 0 returns copy
        const src0 = new Float32Array([0.1, 0.5, 0.9, 0.2]);
        const f0 = minFilter(src0, 2, 2, 0);
        assert.deepEqual(Array.from(f0), Array.from(src0), "r=0 returns identical copy");

        // r >= w
        const w = 20, h = 15, r = 25;
        const n = w * h;
        const srcLargeR = new Float32Array(n);
        for (let i = 0; i < n; i++) srcLargeR[i] = Math.random();
        const fLargeR = minFilter(srcLargeR, w, h, r);

        // Brute force check
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let m = Infinity;
                for (let dy = -r; dy <= r; dy++) {
                    const cy = Math.max(0, Math.min(h - 1, y + dy));
                    for (let dx = -r; dx <= r; dx++) {
                        const cx = Math.max(0, Math.min(w - 1, x + dx));
                        const v = srcLargeR[cy * w + cx];
                        if (v < m) m = v;
                    }
                }
                assert.equal(fLargeR[y * w + x], m, `r>=w mismatch at (${x}, ${y})`);
            }
        }
        console.log("     [ok] minFilter edge cases (r=0, r>=w) match brute force");
    }

    // -------------------------------------------------------------------------
    // 3. darkChannel of a constant image (the min channel everywhere)
    // -------------------------------------------------------------------------
    {
        const w = 32, h = 32, r = 4;
        const rgba = new Uint8Array(w * h * 4);
        const cr = 120, cg = 180, cb = 75;
        for (let i = 0; i < w * h; i++) {
            rgba[i * 4] = cr;
            rgba[i * 4 + 1] = cg;
            rgba[i * 4 + 2] = cb;
            rgba[i * 4 + 3] = 255;
        }

        const dark = darkChannel(rgba, w, h, r);
        const expected = Math.min(cr, cg, cb) / 255;
        assert.equal(dark.length, w * h, "darkChannel returns matching length");
        for (let i = 0; i < dark.length; i++) {
            assert.ok(Math.abs(dark[i] - expected) < 1e-6, `darkChannel[${i}] expected ${expected}, got ${dark[i]}`);
        }
        console.log("     [ok] darkChannel of constant image equals min channel everywhere");
    }

    // -------------------------------------------------------------------------
    // 4. airlight and transmission recovery on synthetic scene
    //    I = J*t + A*(1 - t), A = (0.8, 0.85, 0.9), J textured, t horizontal ramp 0.2..1
    // -------------------------------------------------------------------------
    {
        const w = 240, h = 120;
        const n = w * h;
        const A_true = [0.8, 0.85, 0.9];
        const rgba = new Uint8Array(n * 4);
        const t_true = new Float32Array(n);

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const idx = y * w + x;
                const t = 0.2 + 0.8 * (x / (w - 1));
                t_true[idx] = t;

                let jr, jg, jb;
                if (x < 10 && y < 30) {
                    // Sky / horizon highlight patch at the far boundary where J ~ A
                    jr = A_true[0];
                    jg = A_true[1];
                    jb = A_true[2];
                } else {
                    const cPick = (x ^ y) % 3;
                    jr = (cPick === 0 ? 0.05 : 0.6) * ((x % 7) / 7 + 0.2);
                    jg = (cPick === 1 ? 0.05 : 0.7) * ((y % 5) / 5 + 0.2);
                    jb = (cPick === 2 ? 0.05 : 0.8) * (((x + y) % 6) / 6 + 0.2);
                }

                const ir = Math.round(Math.min(255, Math.max(0, (jr * t + A_true[0] * (1 - t)) * 255)));
                const ig = Math.round(Math.min(255, Math.max(0, (jg * t + A_true[1] * (1 - t)) * 255)));
                const ib = Math.round(Math.min(255, Math.max(0, (jb * t + A_true[2] * (1 - t)) * 255)));

                rgba[idx * 4] = ir;
                rgba[idx * 4 + 1] = ig;
                rgba[idx * 4 + 2] = ib;
                rgba[idx * 4 + 3] = 255;
            }
        }

        const r = Math.max(2, Math.round(0.012 * Math.max(w, h)));
        const dark = darkChannel(rgba, w, h, r);
        const A_est = airlight(rgba, dark, w, h, 0.001);

        assert.ok(Math.abs(A_est[0] - A_true[0]) <= 0.03, `airlight R diff <= 0.03 (got ${A_est[0]}, expected ${A_true[0]})`);
        assert.ok(Math.abs(A_est[1] - A_true[1]) <= 0.03, `airlight G diff <= 0.03 (got ${A_est[1]}, expected ${A_true[1]})`);
        assert.ok(Math.abs(A_est[2] - A_true[2]) <= 0.03, `airlight B diff <= 0.03 (got ${A_est[2]}, expected ${A_true[2]})`);
        console.log(`     [ok] airlight estimated within 0.03/ch: [${A_est.map((v) => v.toFixed(3)).join(", ")}] vs [${A_true.join(", ")}]`);

        // Transmission recovery
        const darkA = darkChannel(rgba, w, h, r, A_est);
        const t_est = new Float32Array(n);
        for (let i = 0; i < n; i++) t_est[i] = 1 - 0.95 * darkA[i];

        // Pearson correlation
        let sumT = 0, sumE = 0, sumTT = 0, sumEE = 0, sumTE = 0;
        for (let i = 0; i < n; i++) {
            sumT += t_true[i];
            sumE += t_est[i];
            sumTT += t_true[i] * t_true[i];
            sumEE += t_est[i] * t_est[i];
            sumTE += t_true[i] * t_est[i];
        }
        const meanT = sumT / n, meanE = sumE / n;
        const cov = sumTE / n - meanT * meanE;
        const varT = sumTT / n - meanT * meanT;
        const varE = sumEE / n - meanE * meanE;
        const corr = cov / Math.sqrt(varT * varE);

        assert.ok(corr >= 0.9, `Pearson corr(t_est, t_true) >= 0.9, got ${corr.toFixed(4)}`);
        console.log(`     [ok] recovered transmission Pearson correlation: ${corr.toFixed(4)} >= 0.9`);
    }

    // -------------------------------------------------------------------------
    // 5. guidedFilter against brute-force double loop on 64x48 (within 1e-4)
    // -------------------------------------------------------------------------
    {
        const w = 64, h = 48, r = 2, eps = 1e-3;
        const n = w * h;
        const I = new Float32Array(n);
        const p = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            I[i] = Math.random();
            p[i] = Math.random();
        }

        const q = guidedFilter(I, p, w, h, r, eps);

        function bruteBox(src) {
            const out = new Float32Array(n);
            const K = 2 * r + 1;
            const norm = 1 / (K * K);
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    let sum = 0;
                    for (let dy = -r; dy <= r; dy++) {
                        const cy = Math.max(0, Math.min(h - 1, y + dy));
                        for (let dx = -r; dx <= r; dx++) {
                            const cx = Math.max(0, Math.min(w - 1, x + dx));
                            sum += src[cy * w + cx];
                        }
                    }
                    out[y * w + x] = sum * norm;
                }
            }
            return out;
        }

        const mI = bruteBox(I);
        const mP = bruteBox(p);
        const Ip = new Float32Array(n);
        const II = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            Ip[i] = I[i] * p[i];
            II[i] = I[i] * I[i];
        }
        const mIp = bruteBox(Ip);
        const mII = bruteBox(II);

        const a = new Float32Array(n);
        const b = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const mi = mI[i];
            const cov = mIp[i] - mi * mP[i];
            const v = mII[i] - mi * mi;
            const av = cov / (v + eps);
            a[i] = av;
            b[i] = mP[i] - av * mi;
        }

        const mA = bruteBox(a);
        const mB = bruteBox(b);
        const q_brute = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            let v = mA[i] * I[i] + mB[i];
            if (v < 0) v = 0; else if (v > 1) v = 1;
            q_brute[i] = v;
        }

        let maxDiff = 0;
        for (let i = 0; i < n; i++) {
            const diff = Math.abs(q[i] - q_brute[i]);
            if (diff > maxDiff) maxDiff = diff;
        }
        assert.ok(maxDiff <= 1e-4, `guidedFilter matches brute force within 1e-4, got max diff ${maxDiff}`);
        console.log(`     [ok] guidedFilter matches brute-force double loop (max diff: ${maxDiff.toExponential(2)} <= 1e-4)`);
    }

    // -------------------------------------------------------------------------
    // 6. guidedFilter limit cases:
    //    eps -> 1e9 / p = I with eps -> 1e-9 (~= box(box(p)) / ~= I)
    // -------------------------------------------------------------------------
    {
        const w = 64, h = 48, r = 2;
        const n = w * h;
        const I = new Float32Array(n);
        const p = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            I[i] = Math.random();
            p[i] = Math.random();
        }

        // eps -> 1e9: a -> 0, b -> mean(p), q -> box(box(p))
        const qHugeEps = guidedFilter(I, p, w, h, r, 1e9);
        const boxP = boxBlurs(p, w, h, [r]);
        const boxBoxP = boxBlurs(boxP, w, h, [r]);
        let maxDiffEps = 0;
        for (let i = 0; i < n; i++) {
            const d = Math.abs(qHugeEps[i] - boxBoxP[i]);
            if (d > maxDiffEps) maxDiffEps = d;
        }
        assert.ok(maxDiffEps <= 1e-4, `eps -> 1e9 matches box(box(p)) within 1e-4, got ${maxDiffEps}`);
        console.log(`     [ok] eps -> 1e9 matches box(box(p)) (diff: ${maxDiffEps.toExponential(2)} <= 1e-4)`);

        // p = I with eps -> 1e-9: a -> 1, b -> 0, q -> I
        const qIdent = guidedFilter(I, I, w, h, r, 1e-9);
        let maxDiffI = 0;
        for (let i = 0; i < n; i++) {
            const d = Math.abs(qIdent[i] - I[i]);
            if (d > maxDiffI) maxDiffI = d;
        }
        assert.ok(maxDiffI <= 1e-3, `p=I with eps=1e-9 matches I within 1e-3, got ${maxDiffI}`);
        console.log(`     [ok] p = I with eps -> 1e-9 matches I (diff: ${maxDiffI.toExponential(2)} <= 1e-3)`);
    }

    // -------------------------------------------------------------------------
    // 7. Determinism: same input produces byte-equal t
    // -------------------------------------------------------------------------
    {
        const w = 128, h = 96;
        const small = {
            width: w,
            height: h,
            data: new Uint8ClampedArray(w * h * 4),
        };
        for (let i = 0; i < small.data.length; i++) {
            small.data[i] = (i * 37 + 13) & 255;
        }

        const res1 = dehazeStats(small);
        const res2 = dehazeStats(small);

        assert.equal(res1.t.length, res2.t.length, "t lengths match");
        let diffBytes = 0;
        for (let i = 0; i < res1.t.length; i++) {
            if (res1.t[i] !== res2.t[i]) diffBytes++;
        }
        assert.equal(diffBytes, 0, "two runs on same input produce byte-equal t");
        assert.equal(res1.air[0], res2.air[0], "airlight R matches");
        assert.equal(res1.air[1], res2.air[1], "airlight G matches");
        assert.equal(res1.air[2], res2.air[2], "airlight B matches");
        assert.notEqual(res1.seq, res2.seq, "seq counter increments on each run");
        console.log("     [ok] determinism: identical input yields byte-equal t and airlight");
    }

    // -------------------------------------------------------------------------
    // 8. Cost: 768x512 in < 60 ms under Node with JS kernels
    // -------------------------------------------------------------------------
    {
        const w = 768, h = 512;
        const small = {
            width: w,
            height: h,
            data: new Uint8ClampedArray(w * h * 4),
        };
        // Realistic synthetic gradient/texture
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const off = (y * w + x) * 4;
                small.data[off] = Math.floor(150 + 50 * Math.sin(x * 0.02));
                small.data[off + 1] = Math.floor(160 + 40 * Math.cos(y * 0.02));
                small.data[off + 2] = Math.floor(180 + 30 * Math.sin((x + y) * 0.01));
                small.data[off + 3] = 255;
            }
        }

        // Warm up JIT
        dehazeStats(small);

        const t0 = performance.now();
        const res = dehazeStats(small);
        const elapsed = performance.now() - t0;

        assert.equal(res.w, 768, "width preserved");
        assert.equal(res.h, 512, "height preserved");
        assert.equal(res.t.length, 768 * 512, "transmission size 768x512");
        assert.ok(elapsed < 60, `dehazeStats 768x512 in < 60 ms, took ${elapsed.toFixed(2)} ms`);
        console.log(`     [ok] cost benchmark: 768x512 completed in ${elapsed.toFixed(2)} ms (< 60 ms budget)`);
    }

    console.log("\nALL DEHAZE MATHS TESTS PASSED!");
    console.log("PASS");
}

main().catch((err) => {
    console.error("FAILED:", err);
    process.exit(1);
});
