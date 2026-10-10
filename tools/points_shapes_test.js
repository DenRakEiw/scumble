// @ts-check
// Unit tests for plugins/film/shapes.js (R3-S5 and R3-S6 Control Points v2).
// Tests run in plain Node without DOM.

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

async function main() {
    console.log("Running points_shapes_test.js (R3-S5 & R3-S6 Control Points v2)...");

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
        polySigned,
        polyBox,
        interiorAnchor,
        lineFromDrag,
    } = shapesMod;

    assert.ok(Array.isArray(SHAPES) && SHAPES.includes("polygon") && SHAPES.includes("line"));
    assert.equal(TEXELS, 14);
    assert.equal(typeof innerOf, "function");
    assert.equal(typeof ellipseFollow, "function");
    assert.equal(typeof polySigned, "function");
    assert.equal(typeof polyBox, "function");
    assert.equal(typeof interiorAnchor, "function");
    assert.equal(typeof lineFromDrag, "function");
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

        // Polygon valid
        const poly = normalisePoint({ shape: "polygon", pts: [[0, 0], [100, 0], [100, 100], [0, 100]], r: 25 });
        if (poly.shape !== "polygon" || poly.pts.length !== 4 || poly.x !== 50 || poly.y !== 50 || poly.r !== 25) {
            throw new Error("Suite 1: polygon normalisePoint failed: " + JSON.stringify(poly));
        }

        // Polygon vertex count errors
        let threw2 = false;
        try { normalisePoint({ shape: "polygon", pts: [[0, 0], [10, 10]] }); } catch (_) { threw2 = true; }
        if (!threw2) throw new Error("Suite 1: polygon with 2 vertices must error");

        let threw17 = false;
        try { normalisePoint({ shape: "polygon", pts: Array.from({ length: 17 }, (_, i) => [i, i]) }); } catch (_) { threw17 = true; }
        if (!threw17) throw new Error("Suite 1: polygon with 17 vertices must error");

        // Line valid
        const line = normalisePoint({ shape: "line", x: 100, y: 100, angle: 45, r: 50 });
        if (line.shape !== "line" || line.x !== 100 || line.y !== 100 || line.angle !== 45 || line.r !== 50) {
            throw new Error("Suite 1: line normalisePoint failed: " + JSON.stringify(line));
        }

        // Refuses unknown shapes
        let threw = false;
        try { normalisePoint({ shape: "blob" }); } catch (_) { threw = true; }
        if (!threw) throw new Error("Suite 1: normalisePoint should refuse 'blob'");

        // Clamps
        const p3 = normalisePoint({ r: -10, ry: 0, soft: 250, tol: -50 });
        if (p3.r < 1 || p3.ry < 1 || p3.soft !== 100 || p3.tol !== 0) {
            throw new Error("Suite 1: normalisePoint clamping failed: " + JSON.stringify(p3));
        }
        console.log("  [ok] normalisePoint fills defaults, clamps, and validates 3..16 polygon and line");
    }

    // Suite 2: Old points bit-identical across 200,000 random evaluations
    {
        const oldPointSets = [
            // 1 point
            [{ id: 1, x: 200, y: 150, r: 80, tol: 60, ev: 0.5, contrast: 20, sat: -30, warmth: 10, structure: 0, color: [0.4, 0.1, -0.2] }],
            // 2 points with overlap
            [
                { id: 1, x: 130, y: 120, r: 110, tol: 60, ev: 1.2, contrast: 10, sat: 40, warmth: 40, structure: 30, color: [0.4, -0.2, 0.3] },
                { id: 2, x: 180, y: 150, r: 120, tol: 60, ev: -1, contrast: 30, sat: -60, warmth: -40, structure: 20, color: [0.5, 0.3, -0.1] },
            ],
            // 4 points
            [
                { id: 1, x: 100, y: 100, r: 90, tol: 40, ev: 0.5, contrast: 10, sat: 20, warmth: 10, structure: 10, color: [0.3, 0.1, -0.1] },
                { id: 2, x: 150, y: 120, r: 80, tol: 70, ev: -0.5, contrast: -10, sat: -20, warmth: -10, structure: 0, color: [0.6, -0.1, 0.2] },
                { id: 3, x: 220, y: 180, r: 100, tol: 50, ev: 0.8, contrast: 25, sat: 10, warmth: 30, structure: 50, color: [0.5, 0.2, -0.2] },
                { id: 4, x: 180, y: 220, r: 70, tol: 80, ev: -0.2, contrast: 0, sat: 50, warmth: -20, structure: 0, color: [0.4, 0.0, 0.0] },
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
                color: [0.2 + i * 0.08, -0.3 + i * 0.07, 0.3 - i * 0.08],
            })),
        ];

        let totalEvals = 0;
        for (const pts of oldPointSets) {
            const oldTex = oldPointsTexture(pts, 1);
            const newTex = pointsTexture2(pts, 1);
            assert.equal(newTex.width, 14);
            assert.equal(newTex.n, pts.length);

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
            color: [0.5, 0, 0],
        };
        const tex = pointsTexture2([el], 1);

        const wCenter = pointWeight(tex.data, 0, cx, cy);
        if (wCenter !== 1) throw new Error("Suite 3: weight at centre must be 1, got " + wCenter);

        const pxR = cx + r * cosA, pyR = cy + r * sinA;
        const wR = pointWeight(tex.data, 0, pxR, pyR);
        if (wR > 1e-12) throw new Error("Suite 3: weight at perimeter r must be 0, got " + wR);
        const wROutside = pointWeight(tex.data, 0, cx + 1.01 * r * cosA, cy + 1.01 * r * sinA);
        if (wROutside !== 0) throw new Error("Suite 3: weight outside perimeter r must be 0, got " + wROutside);

        const pxRy = cx - ry * sinA, pyRy = cy + ry * cosA;
        const wRy = pointWeight(tex.data, 0, pxRy, pyRy);
        if (wRy > 1e-12) throw new Error("Suite 3: weight at perimeter ry must be 0, got " + wRy);
        const wRyOutside = pointWeight(tex.data, 0, cx - 1.01 * ry * sinA, cy + 1.01 * ry * cosA);
        if (wRyOutside !== 0) throw new Error("Suite 3: weight outside perimeter ry must be 0, got " + wRyOutside);

        const elSoft100 = { shape: "ellipse", x: cx, y: cy, r, ry, angle: A_deg, soft: 100, tol: 50 };
        const tex100 = pointsTexture2([elSoft100], 1);
        const pxHalf = cx + 0.5 * r * cosA, pyHalf = cy + 0.5 * r * sinA;
        const wHalf = pointWeight(tex100.data, 0, pxHalf, pyHalf);
        if (Math.abs(wHalf - 0.5) > 1e-6) {
            throw new Error("Suite 3: soft 100 at |q|=0.5 must be 0.5, got " + wHalf);
        }

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
            { name: "scale", m: [0.5, 0, 0, 0.75, 50, 30] },
            { name: "quarter turn", m: [0, 1, -1, 0, 400, 100] },
            { name: "flip h", m: [-1, 0, 0, 1, 800, 0] },
            {
                name: "10 deg straighten",
                m: [
                    Math.cos(10 * Math.PI / 180),
                    Math.sin(10 * Math.PI / 180),
                    -Math.sin(10 * Math.PI / 180),
                    Math.cos(10 * Math.PI / 180),
                    15,
                    -20,
                ],
            },
        ];

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
                const mx = tm.m[0] * ox + tm.m[2] * oy + tm.m[4];
                const my = tm.m[1] * ox + tm.m[3] * oy + tm.m[5];

                const q = qDist(mapped, mx, my);
                if (Math.abs(q - 1.0) > 1e-9) {
                    throw new Error(`Suite 4 [${tm.name}]: boundary point ${i} |q|-1 = ${Math.abs(q - 1.0)} > 1e-9`);
                }
            }

            const circ = { shape: "circle", x: 200, y: 150, r: 50 };
            const mappedCirc = mapShape(circ, tm.m, s);
            if (Math.abs(mappedCirc.r - 50 * s) > 1e-12) {
                throw new Error(`Suite 4: circle radius failed: expected ${50 * s}, got ${mappedCirc.r}`);
            }
        }
        console.log("  [ok] ellipse follow and mapShape preserve ellipse boundary within 1e-9");
    }

    // Suite 5: Handles and hitShape for circle/ellipse
    {
        const el = { shape: "ellipse", x: 100, y: 100, r: 80, ry: 40, angle: 0 };
        const handles = handlesOf(el);
        if (handles.length !== 3) throw new Error("Suite 5: handlesOf length != 3: " + JSON.stringify(handles));
        if (handles[0].id !== "move" || handles[1].id !== "r" || handles[2].id !== "ry") {
            throw new Error("Suite 5: handle ids mismatch: " + JSON.stringify(handles));
        }
        if (handles[1].x !== 180 || handles[1].y !== 100) throw new Error("Suite 5: r handle at " + handles[1].x + "," + handles[1].y);
        if (handles[2].x !== 100 || handles[2].y !== 140) throw new Error("Suite 5: ry handle at " + handles[2].x + "," + handles[2].y);

        if (hitShape(el, 180, 100, 8) !== "r") throw new Error("hitShape r handle failed");
        if (hitShape(el, 100, 140, 8) !== "ry") throw new Error("hitShape ry handle failed");
        if (hitShape(el, 100, 100, 8) !== "move") throw new Error("hitShape move handle failed");
        if (hitShape(el, 100, 60, 8) !== "ring") throw new Error("hitShape ring failed");
        if (hitShape(el, 300, 300, 8) !== null) throw new Error("hitShape outside should be null");

        console.log("  [ok] handlesOf and hitShape correctly identify handles and perimeter");
    }

    // Suite 6: polySigned (unit square, concave L, reversed winding, bow-tie)
    {
        // Unit square (0,0)-(100,100)
        const sq = [[0, 0], [100, 0], [100, 100], [0, 100]];
        const sdCenter = polySigned(sq, 50, 50);
        if (Math.abs(sdCenter - (-50)) > 1e-9) throw new Error("Suite 6: unit square centre sd want -50, got " + sdCenter);
        const sdOut = polySigned(sq, 150, 50);
        if (Math.abs(sdOut - 50) > 1e-9) throw new Error("Suite 6: unit square (150,50) sd want +50, got " + sdOut);
        const sdCorner = polySigned(sq, 0, 0);
        if (Math.abs(sdCorner) > 1e-9) throw new Error("Suite 6: unit square (0,0) sd want 0, got " + sdCorner);

        // Concave L shape
        const L = [[0, 0], [100, 0], [100, 50], [50, 50], [50, 100], [0, 100]];
        const sdNotch = polySigned(L, 75, 75);
        if (sdNotch <= 0) throw new Error("Suite 6: point in concave L notch must be outside (> 0), got " + sdNotch);
        const sdInside = polySigned(L, 25, 25);
        if (sdInside >= 0) throw new Error("Suite 6: point inside concave L must be negative, got " + sdInside);

        // Reversed winding gives identical signed distance
        const sqRev = [[0, 100], [100, 100], [100, 0], [0, 0]];
        const sdCenterRev = polySigned(sqRev, 50, 50);
        const sdOutRev = polySigned(sqRev, 150, 50);
        if (Math.abs(sdCenterRev - (-50)) > 1e-9 || Math.abs(sdOutRev - 50) > 1e-9) {
            throw new Error(`Suite 6: reversed winding failed: center=${sdCenterRev}, out=${sdOutRev}`);
        }

        // Bow-tie (even-odd crossing test)
        const bowtie = [[0, 0], [100, 100], [100, 0], [0, 100]];
        const sdLeft = polySigned(bowtie, 20, 50);
        const sdRight = polySigned(bowtie, 80, 50);
        const sdTop = polySigned(bowtie, 50, 80);
        const sdBottom = polySigned(bowtie, 50, 20);
        if (sdLeft >= 0 || sdRight >= 0) throw new Error("Suite 6: bowtie left and right lobes must be inside (< 0)");
        if (sdTop <= 0 || sdBottom <= 0) throw new Error("Suite 6: bowtie top and bottom wedges must be outside (> 0)");

        console.log("  [ok] polySigned handles square, concave L, reversed winding, and bow-tie even-odd");
    }

    // Suite 7: polyBox and BBox early-out agreement across 10,000 points
    {
        const sq = [[0, 0], [100, 0], [100, 100], [0, 100]];
        const box = polyBox(sq, 20);
        if (box[0] !== -20 || box[1] !== -20 || box[2] !== 120 || box[3] !== 120) {
            throw new Error("Suite 7: polyBox failed: " + JSON.stringify(box));
        }

        // Polygon point with feather 30, softness 60 -> T = 30 * 0.6 = 18
        const polyPt = {
            shape: "polygon",
            x: 50,
            y: 50,
            r: 30,
            soft: 60,
            pts: [[0, 0], [100, 0], [100, 50], [50, 50], [50, 100], [0, 100]],
        };
        const tex = pointsTexture2([polyPt], 1);
        const T = Math.max(0.5, (polyPt.r * polyPt.soft) / 100);

        for (let i = 0; i < 10000; i++) {
            const px = -60 + rand() * 220;
            const py = -60 + rand() * 220;

            const wOpt = pointWeight(tex.data, 0, px, py);
            const sd = polySigned(polyPt.pts, px, py);
            const wFull = sd <= -T ? 1 : sd >= T ? 0 : 1 - sstep(-T, T, sd);

            if (Math.abs(wOpt - wFull) > 1e-6) {
                throw new Error(`Suite 7: bbox early-out mismatch at (${px}, ${py}): opt=${wOpt}, full=${wFull}, sd=${sd}, T=${T}`);
            }
        }
        console.log("  [ok] bbox early-out agrees with full computation on 10,000 random points");
    }

    // Suite 8: Polygon weights (1 at sd <= -T, 0 at sd >= T, 0.5 at sd = 0)
    {
        const sq = [[0, 0], [100, 0], [100, 100], [0, 100]];
        const r = 20, soft = 100; // T = 20
        const polyPt = { shape: "polygon", x: 50, y: 50, r, soft, pts: sq };
        const tex = pointsTexture2([polyPt], 1);

        // At centre (50, 50), sd = -50 <= -T -> weight 1
        const wCenter = pointWeight(tex.data, 0, 50, 50);
        if (wCenter !== 1) throw new Error("Suite 8: weight at centre must be 1, got " + wCenter);

        // On boundary (0, 50), sd = 0 -> weight 0.5
        const wBoundary = pointWeight(tex.data, 0, 0, 50);
        if (Math.abs(wBoundary - 0.5) > 1e-6) throw new Error("Suite 8: weight on boundary must be 0.5, got " + wBoundary);

        // At (150, 50), sd = +50 >= T -> weight 0
        const wOutside = pointWeight(tex.data, 0, 150, 50);
        if (wOutside !== 0) throw new Error("Suite 8: weight far outside must be 0, got " + wOutside);

        console.log("  [ok] polygon weights: 1 at sd <= -T, 0 at sd >= T, 0.5 at boundary");
    }

    // Suite 9: interiorAnchor inside a C shape
    {
        const C = [[0, 0], [100, 0], [100, 30], [30, 30], [30, 70], [100, 70], [100, 100], [0, 100]];
        const anchor = interiorAnchor(C);
        const sd = polySigned(C, anchor[0], anchor[1]);
        if (sd >= 0) {
            throw new Error(`Suite 9: interiorAnchor (${anchor[0]}, ${anchor[1]}) is outside C shape (sd=${sd})`);
        }
        if (anchor[0] !== 15 || anchor[1] !== 50) {
            throw new Error(`Suite 9: interiorAnchor want [15, 50], got [${anchor[0]}, ${anchor[1]}]`);
        }
        console.log("  [ok] interiorAnchor lands inside concave C shape at [15, 50]");
    }

    // Suite 10: Line weights (0.5 on line, 1 at +T, 0 at -T)
    {
        const linePt = { shape: "line", x: 100, y: 100, angle: 90, r: 40, soft: 100 };
        // angle 90 deg: n = (0, 1). Grows downwards in +y. T = 40.
        const tex = pointsTexture2([linePt], 1);

        // On line (y = 100) -> weight 0.5
        const wOn = pointWeight(tex.data, 0, 100, 100);
        if (Math.abs(wOn - 0.5) > 1e-6) throw new Error("Suite 10: line weight on line must be 0.5, got " + wOn);

        // At +T (y = 140) -> weight 1.0
        const wPlusT = pointWeight(tex.data, 0, 100, 140);
        if (Math.abs(wPlusT - 1.0) > 1e-6) throw new Error("Suite 10: line weight at +T must be 1, got " + wPlusT);

        // At -T (y = 60) -> weight 0.0
        const wMinusT = pointWeight(tex.data, 0, 100, 60);
        if (wMinusT !== 0) throw new Error("Suite 10: line weight at -T must be 0, got " + wMinusT);

        console.log("  [ok] line weights: 0.5 on the line, 1 at +T, 0 at -T");
    }

    // Suite 11: Affine transformation invariance for lines and polygon corners
    {
        const origLine = { shape: "line", x: 200, y: 150, angle: 35, r: 80, soft: 75 };
        const origPoly = {
            shape: "polygon",
            x: 100,
            y: 80,
            r: 30,
            soft: 50,
            pts: [[50, 40], [150, 40], [160, 120], [80, 130]],
        };

        const testMatrices = [
            { name: "scale", m: [0.5, 0, 0, 0.75, 50, 30] },
            { name: "quarter turn", m: [0, 1, -1, 0, 400, 100] },
            { name: "flip h", m: [-1, 0, 0, 1, 800, 0] },
            {
                name: "10 deg straighten",
                m: [
                    Math.cos(10 * Math.PI / 180),
                    Math.sin(10 * Math.PI / 180),
                    -Math.sin(10 * Math.PI / 180),
                    Math.cos(10 * Math.PI / 180),
                    15,
                    -20,
                ],
            },
        ];

        for (const tm of testMatrices) {
            const s = Math.sqrt(Math.abs(tm.m[0] * tm.m[3] - tm.m[1] * tm.m[2]));
            const mappedLine = mapShape(origLine, tm.m, s);
            const texOrig = pointsTexture2([origLine], 1);
            const texMapped = pointsTexture2([mappedLine], 1);

            // Pure mathematical line weight function in double precision
            function lineWeight(q, px, py) {
                const A = ((q.angle || 0) * Math.PI) / 180;
                const cosA = Math.cos(A), sinA = Math.sin(A);
                const T = Math.max(0.5, (q.r * (q.soft == null ? 75 : q.soft)) / 100);
                const proj = (px - q.x) * cosA + (py - q.y) * sinA;
                if (proj <= -T) return 0;
                if (proj >= T) return 1;
                return sstep(-T, T, proj);
            }

            // Test line invariance across 1000 random points: w'(m p) == w(p) within 1e-9
            for (let i = 0; i < 1000; i++) {
                const px = rand() * 400;
                const py = rand() * 400;
                const wOrig = lineWeight(origLine, px, py);

                const mpx = tm.m[0] * px + tm.m[2] * py + tm.m[4];
                const mpy = tm.m[1] * px + tm.m[3] * py + tm.m[5];
                const wMapped = lineWeight(mappedLine, mpx, mpy);

                if (Math.abs(wOrig - wMapped) > 1e-9) {
                    throw new Error(`Suite 11 [${tm.name}]: double precision line weight invariance failed at (${px}, ${py}): orig=${wOrig}, mapped=${wMapped}, diff=${Math.abs(wOrig - wMapped)}`);
                }

                // Also verify Float32Array texture weight within float precision
                const wTexOrig = pointWeight(texOrig.data, 0, px, py);
                const wTexMapped = pointWeight(texMapped.data, 0, mpx, mpy);
                if (Math.abs(wTexOrig - wTexMapped) > 1e-6) {
                    throw new Error(`Suite 11 [${tm.name}]: float32 texture line weight diff ${Math.abs(wTexOrig - wTexMapped)} > 1e-6`);
                }
            }

            // Test polygon corner mapping
            const mappedPoly = mapShape(origPoly, tm.m, s);
            for (let j = 0; j < origPoly.pts.length; j++) {
                const ox = origPoly.pts[j][0], oy = origPoly.pts[j][1];
                const expX = tm.m[0] * ox + tm.m[2] * oy + tm.m[4];
                const expY = tm.m[1] * ox + tm.m[3] * oy + tm.m[5];
                const gotX = mappedPoly.pts[j][0], gotY = mappedPoly.pts[j][1];
                if (Math.abs(expX - gotX) > 1e-12 || Math.abs(expY - gotY) > 1e-12) {
                    throw new Error(`Suite 11 [${tm.name}]: polygon corner ${j} map mismatch`);
                }
            }
        }
        console.log("  [ok] affine transformation preserves line weights within 1e-9 and maps polygon corners exactly");
    }

    // Suite 12: Handles and hitShape for polygon and line
    {
        const pts = [[0, 0], [100, 0], [50, 80]];
        const poly = { shape: "polygon", x: 50, y: 26.7, r: 20, pts };
        const hdlsPoly = handlesOf(poly);
        if (hdlsPoly.length !== 4) throw new Error("Suite 12: polygon handlesOf want 4, got " + hdlsPoly.length);
        if (hitShape(poly, 0, 0, 6) !== "corner_0") throw new Error("Suite 12: hit corner 0 failed");
        if (hitShape(poly, 50, 26.7, 6) !== "move") throw new Error("Suite 12: hit center failed");
        if (hitShape(poly, 40, 20, 6) !== "move") throw new Error("Suite 12: inside hit failed");
        if (hitShape(poly, 50, 0, 6) !== "ring") throw new Error("Suite 12: edge ring hit failed");
        if (hitShape(poly, 200, 200, 6) !== null) throw new Error("Suite 12: outside hit should be null");

        // Line handles: A = c - r*n, B = c + r*n
        const line = { shape: "line", x: 100, y: 100, angle: 0, r: 50 }; // n = (1, 0)
        const hdlsLine = handlesOf(line);
        if (hdlsLine.length !== 3) throw new Error("Suite 12: line handlesOf want 3, got " + hdlsLine.length);
        if (hitShape(line, 50, 100, 6) !== "handleA") throw new Error("Suite 12: hit handleA failed");
        if (hitShape(line, 150, 100, 6) !== "handleB") throw new Error("Suite 12: hit handleB failed");
        if (hitShape(line, 100, 100, 6) !== "move") throw new Error("Suite 12: hit line move failed");
        if (hitShape(line, 75, 100, 6) !== "move") throw new Error("Suite 12: hit line segment failed");
        if (hitShape(line, 100, 200, 6) !== null) throw new Error("Suite 12: outside line should be null");

        console.log("  [ok] handlesOf and hitShape correctly identify polygon and line handles");
    }

    console.log("ALL POINTS SHAPES TESTS PASSED!");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
