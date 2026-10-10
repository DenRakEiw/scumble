// @ts-check
// Unit tests for plugins/film/shapes.js (R3-S5 Control Points v2).
// Tests run in plain Node without DOM.

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

async function main() {
    console.log("Running points_shapes_test.js (R3-S5 Control Points v2)...");

    const commonMod = await import(pathToFileURL(path.join(ROOT, "plugins", "film", "common.js")).href);
    const shapesMod = await import(pathToFileURL(path.join(ROOT, "plugins", "film", "shapes.js")).href);

    const { luma, clamp01, sstep, mix } = commonMod;
    const {
        SHAPES,
        TEXELS,
        normalisePoint,
        innerOf,
        pointsTexture2,
        pointWeight,
        pointsPixel,
        ellipseFollow,
        mapShape,
        handlesOf,
        hitShape,
        SHAPE_GLSL,
    } = shapesMod;

    assert.ok(Array.isArray(SHAPES) && SHAPES.includes("ellipse"));
    assert.equal(TEXELS, 14);
    assert.equal(typeof innerOf, "function");
    assert.equal(typeof ellipseFollow, "function");
    assert.ok(typeof SHAPE_GLSL === "string" && SHAPE_GLSL.includes("shapeWeight"));

    const opp = (r, g, b) => {
        const L = luma(r, g, b);
        return [L, r - L, b - L];
    };

    const sigmaOf = (tol) => 0.04 + clamp01(tol / 100) * 0.6;

    // Frozen copy of old pointsTexture from points.js:47-58 at b6c5238
    function oldPointsTexture(points, scale) {
        const n = Math.min(64, points.length);
        const data = new Float32Array(4 * 4 * Math.max(1, n));
        for (let i = 0; i < n; i++) {
            const p = points[i], o = i * 16, c = p.color || [0.5, 0, 0];
            data[o] = p.x * scale;
            data[o + 1] = p.y * scale;
            data[o + 2] = Math.max(1, p.r * scale);
            data[o + 3] = sigmaOf(p.tol != null ? p.tol : 50);
            data[o + 4] = c[0];
            data[o + 5] = c[1];
            data[o + 6] = c[2];
            data[o + 7] = 0;
            data[o + 8] = p.ev || 0;
            data[o + 9] = (p.contrast || 0) / 100;
            data[o + 10] = (p.sat || 0) / 100;
            data[o + 11] = (p.warmth || 0) / 100;
            data[o + 12] = (p.structure || 0) / 100;
            data[o + 13] = 0;
            data[o + 14] = 0;
            data[o + 15] = 0;
        }
        return { data, width: 4, height: Math.max(1, n), n };
    }

    // Frozen copy of old per-pixel loop from points.js:139-162 at b6c5238
    function oldPointsPixel(c, px, py, d, n, useBlur, g, strength = 1) {
        const o3 = opp(c[0], c[1], c[2]);
        let ev = 0, con = 0, sat = 0, warm = 0, str = 0, wsum = 0;
        for (let i = 0; i < n; i++) {
            const o = i * 16;
            const dist = Math.hypot(px - d[o], py - d[o + 1]) / Math.max(d[o + 2], 1);
            const wd = 1 - sstep(0.25, 1, dist);
            if (wd <= 0) continue;
            const d0 = o3[0] - d[o + 4], d1 = o3[1] - d[o + 5], d2 = o3[2] - d[o + 6];
            const dd = d0 * d0 + 4 * (d1 * d1 + d2 * d2);
            const w = wd * Math.exp(-dd / (2 * d[o + 3] * d[o + 3]));
            ev += w * d[o + 8]; con += w * d[o + 9]; sat += w * d[o + 10]; warm += w * d[o + 11]; str += w * d[o + 12]; wsum += w;
        }
        if (wsum <= 0) return;
        const e = Math.pow(2, ev);
        let r = c[0] * e, gg = c[1] * e, bb = c[2] * e;
        const L = luma(r, gg, bb);
        r = L + (r - L) * (1 + sat); gg = L + (gg - L) * (1 + sat); bb = L + (bb - L) * (1 + sat);
        r = 0.5 + (r - 0.5) * (1 + con); gg = 0.5 + (gg - 0.5) * (1 + con); bb = 0.5 + (bb - 0.5) * (1 + con);
        r *= 1 + warm / 3; bb *= 1 - warm / 3;
        if (useBlur && g) { const dL = luma(c[0], c[1], c[2]) - luma(g[0], g[1], g[2]); r += dL * str * 1.5; gg += dL * str * 1.5; bb += dL * str * 1.5; }
        c[0] = mix(c[0], clamp01(r), strength); c[1] = mix(c[1], clamp01(gg), strength); c[2] = mix(c[2], clamp01(bb), strength);
    }

    // PRNG for deterministic reproducible tests
    let seed = 123456789;
    function rand() {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
    }

    // Suite 1: normalisePoint
    {
        const p1 = normalisePoint({});
        if (p1.shape !== "circle" || p1.r !== 20 || p1.ry !== 12 || p1.angle !== 0 || p1.soft !== 75 || p1.tol !== 50) {
            throw new Error("Suite 1: default normalisePoint failed: " + JSON.stringify(p1));
        }
        const p2 = normalisePoint({ shape: "ellipse", r: 100, ry: 40, angle: 45, soft: 20, tol: 80, ev: 1 });
        if (p2.shape !== "ellipse" || p2.r !== 100 || p2.ry !== 40 || p2.angle !== 45 || p2.soft !== 20) {
            throw new Error("Suite 1: ellipse normalisePoint failed: " + JSON.stringify(p2));
        }
        // Refuses unknown shapes
        let threw = false;
        try { normalisePoint({ shape: "blob" }); } catch (e) { threw = true; }
        if (!threw) throw new Error("Suite 1: normalisePoint should refuse 'blob'");

        let threwPoly = false;
        try { normalisePoint({ shape: "polygon" }); } catch (e) { threwPoly = true; }
        if (!threwPoly) throw new Error("Suite 1: normalisePoint should refuse 'polygon' in R3-S5");

        // Clamps
        const p3 = normalisePoint({ r: -10, ry: 0, soft: 250, tol: -50 });
        if (p3.r < 1 || p3.ry < 1 || p3.soft !== 100 || p3.tol !== 0) {
            throw new Error("Suite 1: normalisePoint clamping failed: " + JSON.stringify(p3));
        }
        console.log("  [ok] normalisePoint fills defaults, clamps, and refuses unknown shapes");
    }

    // Suite 2: Old points bit-identical across 200,000 random evaluations
    {
        const oldPointSets = [
            // 1 point
            [{ id: 1, x: 200, y: 150, r: 80, tol: 60, ev: 0.5, contrast: 20, sat: -30, warmth: 10, structure: 0, color: [0.4, 0.1, -0.2] }],
            // 2 points with overlap
            [
                { id: 1, x: 130, y: 120, r: 110, tol: 60, ev: 1.2, contrast: 10, sat: 40, warmth: 40, structure: 30, color: [0.4, -0.2, 0.3] },
                { id: 2, x: 180, y: 150, r: 120, tol: 60, ev: -1, contrast: 30, sat: -60, warmth: -40, structure: 20, color: [0.5, 0.3, -0.1] }
            ],
            // 4 points
            [
                { id: 1, x: 100, y: 100, r: 90, tol: 40, ev: 0.5, contrast: 10, sat: 20, warmth: 10, structure: 10, color: [0.3, 0.1, -0.1] },
                { id: 2, x: 150, y: 120, r: 80, tol: 70, ev: -0.5, contrast: -10, sat: -20, warmth: -10, structure: 0, color: [0.6, -0.1, 0.2] },
                { id: 3, x: 220, y: 180, r: 100, tol: 50, ev: 0.8, contrast: 25, sat: 10, warmth: 30, structure: 50, color: [0.5, 0.2, -0.2] },
                { id: 4, x: 180, y: 220, r: 70, tol: 80, ev: -0.2, contrast: 0, sat: 50, warmth: -20, structure: 0, color: [0.4, 0.0, 0.0] }
            ],
            // 8 points
            Array.from({ length: 8 }, (_, i) => ({
                id: i + 1,
                x: 100 + (i % 3) * 60,
                y: 100 + Math.floor(i / 3) * 60,
                r: 60 + i * 5,
                tol: 30 + i * 8,
                ev: -1 + i * 0.25,
                contrast: -20 + i * 5,
                sat: -30 + i * 10,
                warmth: -20 + i * 5,
                structure: (i % 2) * 40,
                color: [0.2 + i * 0.08, -0.3 + i * 0.07, 0.3 - i * 0.08]
            }))
        ];

        let totalEvals = 0;
        for (const pts of oldPointSets) {
            const oldTex = oldPointsTexture(pts, 1);
            const newTex = pointsTexture2(pts, 1);
            assert.equal(newTex.width, 14);
            assert.equal(newTex.n, pts.length);

            // Evaluate on 50,000 random pixels and colours per set
            const numEvals = 50000;
            for (let k = 0; k < numEvals; k++) {
                const px = rand() * 400;
                const py = rand() * 400;
                const cr = rand();
                const cg = rand();
                const cb = rand();
                const useBlur = (k & 1) === 1;
                const gr = rand(), gg = rand(), gb = rand();

                const cOld = [cr, cg, cb];
                const cNew = [cr, cg, cb];
                const g = useBlur ? [gr, gg, gb] : null;

                oldPointsPixel(cOld, px, py, oldTex.data, oldTex.n, useBlur, g);
                pointsPixel(cNew, px, py, newTex.data, newTex.n, useBlur, g);

                if (cOld[0] !== cNew[0] || cOld[1] !== cNew[1] || cOld[2] !== cNew[2]) {
                    throw new Error(`Suite 2 mismatch at eval ${k}: old=[${cOld}], new=[${cNew}], px=(${px},${py})`);
                }
                totalEvals++;
            }
        }
        console.log(`  [ok] old points bit-identical across ${totalEvals} evaluations`);
    }

    // Suite 3: Ellipse weights (centre 1, perimeters 0, softness)
    {
        const cx = 200, cy = 150, r = 80, ry = 40, A_deg = 30;
        const A_rad = (A_deg * Math.PI) / 180;
        const cosA = Math.cos(A_rad), sinA = Math.sin(A_rad);

        const el = {
            shape: "ellipse",
            x: cx,
            y: cy,
            r,
            ry,
            angle: A_deg,
            soft: 75,
            tol: 50,
            color: [0.5, 0, 0]
        };
        const tex = pointsTexture2([el], 1);

        // 1 at centre
        const wCenter = pointWeight(tex.data, 0, cx, cy);
        if (wCenter !== 1) throw new Error("Suite 3: weight at centre must be 1, got " + wCenter);

        // 0 at or beyond perimeter c + r(cosA, sinA)
        const pxR = cx + r * cosA, pyR = cy + r * sinA;
        const wR = pointWeight(tex.data, 0, pxR, pyR);
        if (wR > 1e-12) throw new Error("Suite 3: weight at perimeter r must be 0, got " + wR);
        const wROutside = pointWeight(tex.data, 0, cx + 1.01 * r * cosA, cy + 1.01 * r * sinA);
        if (wROutside !== 0) throw new Error("Suite 3: weight outside perimeter r must be 0, got " + wROutside);

        // 0 at or beyond perimeter c + ry(-sinA, cosA)
        const pxRy = cx - ry * sinA, pyRy = cy + ry * cosA;
        const wRy = pointWeight(tex.data, 0, pxRy, pyRy);
        if (wRy > 1e-12) throw new Error("Suite 3: weight at perimeter ry must be 0, got " + wRy);
        const wRyOutside = pointWeight(tex.data, 0, cx - 1.01 * ry * sinA, cy + 1.01 * ry * cosA);
        if (wRyOutside !== 0) throw new Error("Suite 3: weight outside perimeter ry must be 0, got " + wRyOutside);

        // Softness 100: inner = 0, at |q| = 0.5 weight is exactly 0.5
        const elSoft100 = { shape: "ellipse", x: cx, y: cy, r, ry, angle: A_deg, soft: 100, tol: 50 };
        const tex100 = pointsTexture2([elSoft100], 1);
        const pxHalf = cx + 0.5 * r * cosA, pyHalf = cy + 0.5 * r * sinA;
        const wHalf = pointWeight(tex100.data, 0, pxHalf, pyHalf);
        if (Math.abs(wHalf - 0.5) > 1e-6) {
            throw new Error("Suite 3: soft 100 at |q|=0.5 must be 0.5, got " + wHalf);
        }

        // Softness 0 with r = 100 gives 1 at 0.98 and 0 at 1.0
        const elSoft0 = { shape: "ellipse", x: cx, y: cy, r: 100, ry: 50, angle: A_deg, soft: 0, tol: 50 };
        const tex0 = pointsTexture2([elSoft0], 1);
        const px98 = cx + 0.98 * elSoft0.r * cosA, py98 = cy + 0.98 * elSoft0.r * sinA;
        const w98 = pointWeight(tex0.data, 0, px98, py98);
        const px100 = cx + 1.0 * elSoft0.r * cosA, py100 = cy + 1.0 * elSoft0.r * sinA;
        const w100 = pointWeight(tex0.data, 0, px100, py100);
        if (w98 !== 1 || w100 > 1e-10) {
            throw new Error(`Suite 3: soft 0 with r=100 expected w(0.98)=1, w(1.0)<=1e-10; got w98=${w98}, w100=${w100}`);
        }

        console.log("  [ok] ellipse weights (centre 1, perimeters 0, soft 100 half 0.5, soft 0 sharp drop)");
    }

    // Suite 4: Ellipse follow and mapShape
    {
        const orig = { shape: "ellipse", x: 300, y: 200, r: 120, ry: 60, angle: 25, soft: 50 };

        // Generate 64 boundary points of the original ellipse
        const A0 = (orig.angle * Math.PI) / 180;
        const cos0 = Math.cos(A0), sin0 = Math.sin(A0);
        const boundaryPoints = [];
        for (let i = 0; i < 64; i++) {
            const theta = (i * 2 * Math.PI) / 64;
            const u = Math.cos(theta), v = Math.sin(theta);
            const ex = orig.r * u, ey = orig.ry * v;
            const x = orig.x + ex * cos0 - ey * sin0;
            const y = orig.y + ex * sin0 + ey * cos0;
            boundaryPoints.push([x, y]);
        }

        const testMatrices = [
            // scale (0.5, 0.75)
            { name: "scale", m: [0.5, 0, 0, 0.75, 50, 30] },
            // quarter turn clockwise
            { name: "quarter turn", m: [0, 1, -1, 0, 400, 100] },
            // flip horizontal
            { name: "flip h", m: [-1, 0, 0, 1, 800, 0] },
            // 10 deg straighten: cos(10), sin(10), -sin(10), cos(10), ...
            {
                name: "10 deg straighten",
                m: [
                    Math.cos(10 * Math.PI / 180),
                    Math.sin(10 * Math.PI / 180),
                    -Math.sin(10 * Math.PI / 180),
                    Math.cos(10 * Math.PI / 180),
                    15,
                    -20
                ]
            }
        ];

        // Test boundary on mapped ellipse
        function qDist(el, px, py) {
            const dx = px - el.x;
            const dy = py - el.y;
            const rad = (el.angle * Math.PI) / 180;
            const c = Math.cos(rad);
            const s = Math.sin(rad);
            const u = (dx * c + dy * s) / el.r;
            const v = (-dx * s + dy * c) / el.ry;
            return Math.hypot(u, v);
        }

        for (const tm of testMatrices) {
            const s = Math.sqrt(Math.abs(tm.m[0] * tm.m[3] - tm.m[1] * tm.m[2]));
            const mapped = mapShape(orig, tm.m, s);

            for (let i = 0; i < boundaryPoints.length; i++) {
                const [ox, oy] = boundaryPoints[i];
                // Map original boundary point by matrix m
                const mx = tm.m[0] * ox + tm.m[2] * oy + tm.m[4];
                const my = tm.m[1] * ox + tm.m[3] * oy + tm.m[5];

                const q = qDist(mapped, mx, my);
                if (Math.abs(q - 1.0) > 1e-9) {
                    throw new Error(`Suite 4 [${tm.name}]: boundary point ${i} |q|-1 = ${Math.abs(q - 1.0)} > 1e-9`);
                }
            }

            // Circle keeps r * s
            const circ = { shape: "circle", x: 200, y: 150, r: 50 };
            const mappedCirc = mapShape(circ, tm.m, s);
            if (Math.abs(mappedCirc.r - 50 * s) > 1e-12) {
                throw new Error(`Suite 4: circle radius failed: expected ${50 * s}, got ${mappedCirc.r}`);
            }
        }
        console.log("  [ok] ellipse follow and mapShape preserve ellipse boundary within 1e-9");
    }

    // Suite 5: Handles and hitShape
    {
        const el = { shape: "ellipse", x: 100, y: 100, r: 80, ry: 40, angle: 0 };
        const handles = handlesOf(el);
        if (handles.length !== 3) throw new Error("Suite 5: handlesOf length != 3: " + JSON.stringify(handles));
        if (handles[0].id !== "move" || handles[1].id !== "r" || handles[2].id !== "ry") {
            throw new Error("Suite 5: handle ids mismatch: " + JSON.stringify(handles));
        }
        // R handle at (180, 100)
        if (handles[1].x !== 180 || handles[1].y !== 100) throw new Error("Suite 5: r handle at " + handles[1].x + "," + handles[1].y);
        // RY handle at (100, 140)
        if (handles[2].x !== 100 || handles[2].y !== 140) throw new Error("Suite 5: ry handle at " + handles[2].x + "," + handles[2].y);

        // Hit testing
        if (hitShape(el, 180, 100, 8) !== "r") throw new Error("hitShape r handle failed");
        if (hitShape(el, 100, 140, 8) !== "ry") throw new Error("hitShape ry handle failed");
        if (hitShape(el, 100, 100, 8) !== "move") throw new Error("hitShape move handle failed");
        if (hitShape(el, 100, 60, 8) !== "ring") throw new Error("hitShape ring failed");
        if (hitShape(el, 300, 300, 8) !== null) throw new Error("hitShape outside should be null");

        console.log("  [ok] handlesOf and hitShape correctly identify handles and perimeter");
    }

    console.log("ALL POINTS SHAPES TESTS PASSED!");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
