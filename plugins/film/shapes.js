// @ts-check
// Film pack: control point shapes and weights v2 (circles, ellipses, polygons, lines, softness).
// Pure ASCII module, no DOM at import, runs in Node, Web Workers and renderer.

import { luma, clamp01, sstep, mix } from "./common.js";

export const SHAPES = ["circle", "ellipse", "polygon", "line"];
export const TEXELS = 14;

const opp = (r, g, b) => {
    const L = luma(r, g, b);
    return [L, r - L, b - L];
};

const sigmaOf = (tol) => 0.04 + clamp01(tol / 100) * 0.6;

/**
 * Returns the signed Euclidean distance from (px, py) to polygon pts.
 * Negative inside, positive outside, 0 on boundary.
 * Even-odd ray casting in +x direction: winding does not matter.
 *
 * @param {number[][]} pts
 * @param {number} px
 * @param {number} py
 * @returns {number}
 */
export function polySigned(pts, px, py) {
    if (!Array.isArray(pts) || pts.length < 3) return 0;
    const n = pts.length;
    let minD2 = Infinity;
    let inside = false;
    for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        const ax = a[0], ay = a[1];
        const bx = b[0], by = b[1];
        // Ray casting in +x direction
        if ((ay > py) !== (by > py)) {
            const xInt = ax + ((py - ay) * (bx - ax)) / (by - ay);
            if (px < xInt) inside = !inside;
        }
        // Distance to segment AB
        const abx = bx - ax, aby = by - ay;
        const l2 = abx * abx + aby * aby;
        const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / l2)) : 0;
        const qx = ax + t * abx, qy = ay + t * aby;
        const dx = px - qx, dy = py - qy;
        const d2 = dx * dx + dy * dy;
        if (d2 < minD2) minD2 = d2;
    }
    const d = Math.sqrt(minD2);
    return inside ? -d : d;
}

/**
 * Returns axis-aligned bounding box of pts expanded by T: [x0, y0, x1, y1].
 *
 * @param {number[][]} pts
 * @param {number} T
 * @returns {[number, number, number, number]}
 */
export function polyBox(pts, T) {
    if (!Array.isArray(pts) || !pts.length) return [0, 0, 0, 0];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < pts.length; i++) {
        const x = pts[i][0], y = pts[i][1];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
    }
    const t = Number.isFinite(T) ? Math.max(0, T) : 0;
    return [x0 - t, y0 - t, x1 + t, y1 + t];
}

/**
 * Returns polygon interior anchor: centroid if inside, else midpoint of first inside run on centroid row.
 *
 * @param {number[][]} pts
 * @returns {[number, number]}
 */
export function interiorAnchor(pts) {
    if (!Array.isArray(pts) || !pts.length) return [0, 0];
    let sumX = 0, sumY = 0;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
        sumX += pts[i][0];
        sumY += pts[i][1];
    }
    const cx = sumX / n, cy = sumY / n;
    if (polySigned(pts, cx, cy) < 0) {
        return [cx, cy];
    }
    const xs = [];
    for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        const ay = a[1], by = b[1];
        if ((ay > cy) !== (by > cy)) {
            const xInt = a[0] + ((cy - ay) * (b[0] - a[0])) / (by - ay);
            xs.push(xInt);
        }
    }
    xs.sort((u, v) => u - v);
    if (xs.length >= 2) {
        return [(xs[0] + xs[1]) / 2, cy];
    }
    return [cx, cy];
}

/**
 * Line parameters from drag endpoints A (zero effect) and B (full effect).
 *
 * @param {number[]|{ x: number, y: number }} A
 * @param {number[]|{ x: number, y: number }} B
 * @returns {{ x: number, y: number, angle: number, r: number }}
 */
export function lineFromDrag(A, B) {
    const ax = Array.isArray(A) ? A[0] : +A.x || 0;
    const ay = Array.isArray(A) ? A[1] : +A.y || 0;
    const bx = Array.isArray(B) ? B[0] : +B.x || 0;
    const by = Array.isArray(B) ? B[1] : +B.y || 0;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    const r = Math.max(1, len / 2);
    const angleRad = Math.atan2(dy, dx);
    const angleDeg = (angleRad * 180) / Math.PI;
    return {
        x: (ax + bx) / 2,
        y: (ay + by) / 2,
        angle: angleDeg,
        r,
    };
}

/**
 * Fills defaults, clamps values, and validates shape.
 *
 * @param {any} q
 * @returns {any}
 */
export function normalisePoint(q) {
    if (!q || typeof q !== "object") throw new Error("point must be an object");
    const shape = q.shape != null ? String(q.shape) : "circle";
    if (shape !== "circle" && shape !== "ellipse" && shape !== "polygon" && shape !== "line") {
        throw new Error("unknown shape: " + shape);
    }
    let pts = null;
    let x = Number.isFinite(+q.x) ? +q.x : 0;
    let y = Number.isFinite(+q.y) ? +q.y : 0;
    if (shape === "polygon") {
        if (!Array.isArray(q.pts) || q.pts.length < 3 || q.pts.length > 16) {
            throw new Error("polygon must have 3 to 16 vertices");
        }
        pts = q.pts.map((v) => [Number.isFinite(+v[0]) ? +v[0] : 0, Number.isFinite(+v[1]) ? +v[1] : 0]);
        if (q.x == null || q.y == null || !Number.isFinite(+q.x) || !Number.isFinite(+q.y)) {
            const anc = interiorAnchor(pts);
            x = anc[0];
            y = anc[1];
        }
    }
    const r = Math.max(1, Number.isFinite(+q.r) ? +q.r : 20);
    const ry = Math.max(1, Number.isFinite(+q.ry) ? +q.ry : Math.round(0.6 * r));
    const angle = Number.isFinite(+q.angle) ? +q.angle : 0;
    const soft = q.soft == null ? 75 : Math.max(0, Math.min(100, Number.isFinite(+q.soft) ? +q.soft : 75));
    const tol = Math.max(0, Math.min(100, Number.isFinite(+q.tol) ? +q.tol : 50));
    const ev = Number.isFinite(+q.ev) ? +q.ev : 0;
    const contrast = Number.isFinite(+q.contrast) ? +q.contrast : 0;
    const sat = Number.isFinite(+q.sat) ? +q.sat : 0;
    const warmth = Number.isFinite(+q.warmth) ? +q.warmth : 0;
    const structure = Number.isFinite(+q.structure) ? +q.structure : 0;
    const color = Array.isArray(q.color) && q.color.length >= 3 ? [q.color[0], q.color[1], q.color[2]] : [0.5, 0, 0];
    const res = {
        ...q,
        shape,
        x,
        y,
        r,
        ry,
        angle,
        soft,
        tol,
        ev,
        contrast,
        sat,
        warmth,
        structure,
        color,
    };
    if (pts) res.pts = pts;
    return res;
}

/**
 * Returns inner transition radius ratio (0..1).
 * Clamped strictly below 1 so sstep(inner, 1, dist) never divides by zero.
 *
 * @param {any} q
 * @param {number} [scale=1]
 * @returns {number}
 */
export function innerOf(q, scale = 1) {
    if (!q || q.soft == null) return 0.25;
    const soft = Number.isFinite(+q.soft) ? +q.soft : 75;
    const r = Math.max(1, (q.r != null && Number.isFinite(+q.r) ? +q.r : 1) * (scale || 1));
    const maxInner = Math.max(0, 1 - 1 / r);
    const val = 1 - soft / 100;
    return Math.min(Math.max(0, val), maxInner);
}

/**
 * Packs control points into 14 x N RGBA32F texture data.
 *
 * @param {any[]} points
 * @param {number} [scale=1]
 * @returns {{ data: Float32Array, width: number, height: number, n: number }}
 */
export function pointsTexture2(points, scale = 1) {
    const pts = Array.isArray(points) ? points : [];
    const n = Math.min(64, pts.length);
    const data = new Float32Array(14 * 4 * Math.max(1, n));
    const s = scale || 1;
    for (let i = 0; i < n; i++) {
        const p = normalisePoint(pts[i]);
        const o = i * 56;
        const c = p.color || [0.5, 0, 0];
        const r = Math.max(1, p.r * s);
        const ry = Math.max(1, (p.shape === "ellipse" ? p.ry : p.r) * s);
        const sigma = sigmaOf(p.tol);
        const kind = p.shape === "ellipse" ? 1 : p.shape === "polygon" ? 2 : p.shape === "line" ? 3 : 0;
        const inner = innerOf(p, s);
        const angleRad = ((p.angle || 0) * Math.PI) / 180;
        const cosA = Math.cos(angleRad), sinA = Math.sin(angleRad);
        const T = Math.max(0.5, (r * p.soft) / 100);
        const nVerts = kind === 2 && Array.isArray(p.pts) ? p.pts.length : 0;

        // t0: x, y, r, sigma
        data[o + 0] = p.x * s;
        data[o + 1] = p.y * s;
        data[o + 2] = r;
        data[o + 3] = sigma;

        // t1: L, cr, cb, kind (0 circle, 1 ellipse, 2 polygon, 3 line)
        data[o + 4] = c[0];
        data[o + 5] = c[1];
        data[o + 6] = c[2];
        data[o + 7] = kind;

        // t2: ev, con, sat, warm
        data[o + 8] = p.ev;
        data[o + 9] = p.contrast / 100;
        data[o + 10] = p.sat / 100;
        data[o + 11] = p.warmth / 100;

        // t3: structure, inner, nVerts, 0
        data[o + 12] = p.structure / 100;
        data[o + 13] = inner;
        data[o + 14] = nVerts;
        data[o + 15] = 0;

        // t4: cosA, sinA, ry, T
        data[o + 16] = cosA;
        data[o + 17] = sinA;
        data[o + 18] = ry;
        data[o + 19] = T;

        if (kind === 2 && Array.isArray(p.pts)) {
            // t5: polygon bbox x0, y0, x1, y1, expanded by T
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (let j = 0; j < nVerts; j++) {
                const vx = p.pts[j][0] * s, vy = p.pts[j][1] * s;
                if (vx < minX) minX = vx;
                if (vx > maxX) maxX = vx;
                if (vy < minY) minY = vy;
                if (vy > maxY) maxY = vy;
            }
            data[o + 20] = minX - T;
            data[o + 21] = minY - T;
            data[o + 22] = maxX + T;
            data[o + 23] = maxY + T;

            // t6..t13: polygon vertices, two per texel
            for (let j = 0; j < nVerts && j < 16; j++) {
                data[o + 24 + j * 2] = p.pts[j][0] * s;
                data[o + 24 + j * 2 + 1] = p.pts[j][1] * s;
            }
        }
    }
    return { data, width: 14, height: Math.max(1, n), n };
}

/**
 * JS twin of shapeWeight(), reading row i at offset o in float array d.
 *
 * @param {Float32Array} d
 * @param {number} o
 * @param {number} px
 * @param {number} py
 * @returns {number}
 */
export function pointWeight(d, o, px, py) {
    const kind = Math.round(d[o + 7]);
    const r = Math.max(d[o + 2], 1);
    const inner = d[o + 13];
    if (kind === 0) {
        const dist = Math.hypot(px - d[o], py - d[o + 1]) / r;
        if (dist >= 1) return 0;
        if (dist <= inner) return 1;
        const wd = 1 - sstep(inner, 1, dist);
        return wd > 0 ? wd : 0;
    }
    if (kind === 1) {
        const dx = px - d[o], dy = py - d[o + 1];
        const cosA = d[o + 16], sinA = d[o + 17];
        const ry = Math.max(d[o + 18], 1);
        const qx = (dx * cosA + dy * sinA) / r;
        const qy = (-dx * sinA + dy * cosA) / ry;
        const dist = Math.hypot(qx, qy);
        if (dist >= 1) return 0;
        if (dist <= inner) return 1;
        const wd = 1 - sstep(inner, 1, dist);
        return wd > 0 ? wd : 0;
    }
    if (kind === 2) {
        // Expanded bbox check: early 0 outside t5
        const bx0 = d[o + 20], by0 = d[o + 21], bx1 = d[o + 22], by1 = d[o + 23];
        if (px < bx0 || px > bx1 || py < by0 || py > by1) return 0;
        const T = d[o + 19];
        const nVerts = Math.round(d[o + 14]);
        if (nVerts < 3) return 0;
        let minD2 = Infinity;
        let inside = false;
        for (let j = 0; j < nVerts; j++) {
            const jNext = (j + 1) % nVerts;
            const ax = d[o + 24 + j * 2], ay = d[o + 24 + j * 2 + 1];
            const bx = d[o + 24 + jNext * 2], by = d[o + 24 + jNext * 2 + 1];
            if ((ay > py) !== (by > py)) {
                const xInt = ax + ((py - ay) * (bx - ax)) / (by - ay);
                if (px < xInt) inside = !inside;
            }
            const abx = bx - ax, aby = by - ay;
            const l2 = abx * abx + aby * aby;
            const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / l2)) : 0;
            const qx = ax + t * abx, qy = ay + t * aby;
            const dx = px - qx, dy = py - qy;
            const d2 = dx * dx + dy * dy;
            if (d2 < minD2) minD2 = d2;
        }
        const dist = Math.sqrt(minD2);
        const sd = inside ? -dist : dist;
        if (sd <= -T) return 1;
        if (sd >= T) return 0;
        const wd = 1 - sstep(-T, T, sd);
        return wd > 0 ? wd : 0;
    }
    if (kind === 3) {
        const cx = d[o], cy = d[o + 1];
        const cosA = d[o + 16], sinA = d[o + 17];
        const T = d[o + 19];
        const proj = (px - cx) * cosA + (py - cy) * sinA;
        if (proj <= -T) return 0;
        if (proj >= T) return 1;
        const wd = sstep(-T, T, proj);
        return wd > 0 ? wd : 0;
    }
    return 0;
}

/**
 * Applies points adjustment at a single pixel c (modified in place).
 *
 * @param {number[]|Float32Array|Uint8Array|Uint8ClampedArray} c
 * @param {number} px
 * @param {number} py
 * @param {Float32Array} d
 * @param {number} n
 * @param {boolean} useBlur
 * @param {any} [g]
 * @param {number} [strength=1]
 */
export function pointsPixel(c, px, py, d, n, useBlur, g, strength = 1) {
    const o3 = opp(c[0], c[1], c[2]);
    let ev = 0, con = 0, sat = 0, warm = 0, str = 0, wsum = 0;
    for (let i = 0; i < n; i++) {
        const o = i * 56;
        const wd = pointWeight(d, o, px, py);
        if (wd <= 0) continue;
        const d0 = o3[0] - d[o + 4], d1 = o3[1] - d[o + 5], d2 = o3[2] - d[o + 6];
        const dd = d0 * d0 + 4 * (d1 * d1 + d2 * d2);
        const sig = d[o + 3];
        const w = wd * Math.exp(-dd / (2 * sig * sig));
        ev += w * d[o + 8];
        con += w * d[o + 9];
        sat += w * d[o + 10];
        warm += w * d[o + 11];
        str += w * d[o + 12];
        wsum += w;
    }
    if (wsum <= 0) return;
    const e = Math.pow(2, ev);
    let r = c[0] * e, gg = c[1] * e, bb = c[2] * e;
    const L = luma(r, gg, bb);
    r = L + (r - L) * (1 + sat);
    gg = L + (gg - L) * (1 + sat);
    bb = L + (bb - L) * (1 + sat);
    r = 0.5 + (r - 0.5) * (1 + con);
    gg = 0.5 + (gg - 0.5) * (1 + con);
    bb = 0.5 + (bb - 0.5) * (1 + con);
    r *= 1 + warm / 3;
    bb *= 1 - warm / 3;
    if (useBlur && g) {
        const dL = luma(c[0], c[1], c[2]) - luma(g[0], g[1], g[2]);
        r += dL * str * 1.5;
        gg += dL * str * 1.5;
        bb += dL * str * 1.5;
    }
    c[0] = mix(c[0], clamp01(r), strength);
    c[1] = mix(c[1], clamp01(gg), strength);
    c[2] = mix(c[2], clamp01(bb), strength);
}

export const SHAPE_GLSL = `
float shapeWeight(vec2 p, int i) {
    vec4 a = texelFetch(u_pts, ivec2(0, i), 0);
    vec4 col = texelFetch(u_pts, ivec2(1, i), 0);
    vec4 adj2 = texelFetch(u_pts, ivec2(3, i), 0);
    int kind = int(col.w + 0.5);
    float inner = adj2.y;
    if (kind == 0) {
        float dist = distance(p, a.xy) / max(a.z, 1.0);
        return 1.0 - sstep(inner, 1.0, dist);
    } else if (kind == 1) {
        vec4 tr = texelFetch(u_pts, ivec2(4, i), 0);
        vec2 d = p - a.xy;
        float cosA = tr.x, sinA = tr.y, ry = max(tr.z, 1.0);
        vec2 q = vec2(d.x * cosA + d.y * sinA, -d.x * sinA + d.y * cosA);
        q.x /= max(a.z, 1.0);
        q.y /= ry;
        float dist = length(q);
        return 1.0 - sstep(inner, 1.0, dist);
    } else if (kind == 2) {
        vec4 bb = texelFetch(u_pts, ivec2(5, i), 0);
        if (p.x < bb.x || p.x > bb.z || p.y < bb.y || p.y > bb.w) return 0.0;
        vec4 tr = texelFetch(u_pts, ivec2(4, i), 0);
        float T = tr.w;
        int nVerts = int(adj2.z + 0.5);
        if (nVerts < 3) return 0.0;
        vec2 v[16];
        for (int k = 0; k < 8; k++) {
            if (k * 2 >= nVerts) break;
            vec4 vt = texelFetch(u_pts, ivec2(6 + k, i), 0);
            v[k * 2] = vt.xy;
            v[k * 2 + 1] = vt.zw;
        }
        float minD2 = 1e20;
        bool inside = false;
        for (int j = 0; j < 16; j++) {
            if (j >= nVerts) break;
            vec2 va = v[j];
            int next = j + 1;
            if (next >= nVerts) next = 0;
            vec2 vb = v[next];
            if ((va.y > p.y) != (vb.y > p.y)) {
                if (p.x < va.x + (p.y - va.y) * (vb.x - va.x) / (vb.y - va.y)) {
                    inside = !inside;
                }
            }
            vec2 ab = vb - va;
            float l2 = dot(ab, ab);
            float t = (l2 > 1e-12) ? clamp(dot(p - va, ab) / l2, 0.0, 1.0) : 0.0;
            vec2 diff = p - (va + t * ab);
            minD2 = min(minD2, dot(diff, diff));
        }
        float sd = sqrt(minD2);
        if (inside) sd = -sd;
        return 1.0 - sstep(-T, T, sd);
    } else if (kind == 3) {
        vec4 tr = texelFetch(u_pts, ivec2(4, i), 0);
        float cosA = tr.x, sinA = tr.y, T = tr.w;
        vec2 d = p - a.xy;
        float proj = d.x * cosA + d.y * sinA;
        return sstep(-T, T, proj);
    }
    return 0.0;
}
`;

/**
 * Closed-form 2x2 SVD of L * R(A) * diag(r, ry).
 *
 * @param {any} q
 * @param {number[]} m 6-element affine matrix [a, b, c, d, e, f]
 * @returns {{ r: number, ry: number, angle: number }}
 */
export function ellipseFollow(q, m) {
    const r = Math.max(1, +q.r || 1);
    const ry = Math.max(1, +q.ry || Math.round(0.6 * r));
    const angleRad = ((+q.angle || 0) * Math.PI) / 180;
    const cosA = Math.cos(angleRad), sinA = Math.sin(angleRad);
    const a = m[0], b = m[1], c = m[2], d = m[3];
    const m00 = a * r * cosA + c * r * sinA;
    const m01 = -a * ry * sinA + c * ry * cosA;
    const m10 = b * r * cosA + d * r * sinA;
    const m11 = -b * ry * sinA + d * ry * cosA;
    const E = m00 * m00 + m01 * m01;
    const G = m10 * m10 + m11 * m11;
    const F = m00 * m10 + m01 * m11;
    const diff = E - G;
    const disc = Math.hypot(diff, 2 * F);
    const l1 = (E + G + disc) / 2;
    const l2 = Math.max(0, (E + G - disc) / 2);
    const newR = Math.sqrt(l1);
    const newRy = Math.sqrt(l2);
    const newAngleRad = 0.5 * Math.atan2(2 * F, diff);
    const newAngleDeg = (newAngleRad * 180) / Math.PI;
    return { r: newR, ry: newRy, angle: newAngleDeg };
}

/**
 * Maps a control point by affine matrix m and scale s = sqrt(|det m|).
 *
 * @param {any} q
 * @param {number[]} m
 * @param {number} s
 * @returns {any}
 */
export function mapShape(q, m, s) {
    const x = +q.x, y = +q.y;
    const nx = m[0] * x + m[2] * y + m[4];
    const ny = m[1] * x + m[3] * y + m[5];
    if (q.shape === "ellipse") {
        const fol = ellipseFollow(q, m);
        return { ...q, x: nx, y: ny, r: fol.r, ry: fol.ry, angle: fol.angle };
    }
    if (q.shape === "polygon") {
        const pts = Array.isArray(q.pts) ? q.pts.map((v) => [
            m[0] * v[0] + m[2] * v[1] + m[4],
            m[1] * v[0] + m[3] * v[1] + m[5],
        ]) : [];
        return { ...q, x: nx, y: ny, r: +q.r * s, pts };
    }
    if (q.shape === "line") {
        // Line normal n' = normalize(L^-T n), r' = r / |L^-T n|
        // Exact: preserves every point's weight under any affine map.
        const a = m[0], b = m[1], c = m[2], d = m[3];
        const det = a * d - b * c;
        if (Math.abs(det) < 1e-12) {
            return { ...q, x: nx, y: ny, r: +q.r * s };
        }
        const angleRad = ((+q.angle || 0) * Math.PI) / 180;
        const cosA = Math.cos(angleRad), sinA = Math.sin(angleRad);
        const vx = (d * cosA - b * sinA) / det;
        const vy = (-c * cosA + a * sinA) / det;
        const len = Math.hypot(vx, vy);
        const newR = (+q.r || 1) / len;
        const newAngleDeg = (Math.atan2(vy, vx) * 180) / Math.PI;
        return { ...q, x: nx, y: ny, r: newR, angle: newAngleDeg };
    }
    return { ...q, x: nx, y: ny, r: +q.r * s };
}

/**
 * Returns handle coordinates for shape q.
 *
 * @param {any} q
 * @returns {{ id: string, index?: number, x: number, y: number }[]}
 */
export function handlesOf(q) {
    const res = [{ id: "move", x: q.x, y: q.y }];
    if (q.shape === "circle" || q.shape === "ellipse") {
        const A = ((q.angle || 0) * Math.PI) / 180;
        const cosA = Math.cos(A), sinA = Math.sin(A);
        const xr = q.x + q.r * cosA, yr = q.y + q.r * sinA;
        res.push({ id: "r", x: xr, y: yr });
        if (q.shape === "ellipse") {
            const ry = q.ry != null ? q.ry : Math.round(0.6 * q.r);
            const xry = q.x - ry * sinA, yry = q.y + ry * cosA;
            res.push({ id: "ry", x: xry, y: yry });
        }
        return res;
    }
    if (q.shape === "polygon") {
        const pts = Array.isArray(q.pts) ? q.pts : [];
        for (let i = 0; i < pts.length; i++) {
            res.push({ id: "corner", index: i, x: pts[i][0], y: pts[i][1] });
        }
        return res;
    }
    if (q.shape === "line") {
        const A = ((q.angle || 0) * Math.PI) / 180;
        const cosA = Math.cos(A), sinA = Math.sin(A);
        const r = Math.max(1, +q.r || 1);
        res.push({ id: "handleA", x: q.x - r * cosA, y: q.y - r * sinA });
        res.push({ id: "handleB", x: q.x + r * cosA, y: q.y + r * sinA });
        return res;
    }
    return res;
}

/**
 * Tests hit against handles, ring, or centre.
 *
 * @param {any} q
 * @param {number} x
 * @param {number} y
 * @param {number} tol
 * @returns {null | string}
 */
export function hitShape(q, x, y, tol) {
    if (q.shape === "circle" || q.shape === "ellipse") {
        const A = ((q.angle || 0) * Math.PI) / 180;
        const cosA = Math.cos(A), sinA = Math.sin(A);
        const xr = q.x + q.r * cosA, yr = q.y + q.r * sinA;
        if (Math.hypot(x - xr, y - yr) <= tol) return "r";
        if (q.shape === "ellipse") {
            const ry = q.ry != null ? q.ry : Math.round(0.6 * q.r);
            const xry = q.x - ry * sinA, yry = q.y + ry * cosA;
            if (Math.hypot(x - xry, y - yry) <= tol) return "ry";
        }
        if (q.shape === "ellipse") {
            const dx = x - q.x, dy = y - q.y;
            const qx = (dx * cosA + dy * sinA) / Math.max(q.r, 1);
            const ry = q.ry != null ? q.ry : Math.round(0.6 * q.r);
            const qy = (-dx * sinA + dy * cosA) / Math.max(ry, 1);
            const dist = Math.hypot(qx, qy);
            const rEff = Math.hypot(q.r * (dist > 1e-6 ? qx / dist : 1), ry * (dist > 1e-6 ? qy / dist : 0));
            if (Math.abs(dist - 1) * rEff <= tol) return "ring";
        } else {
            const d = Math.hypot(x - q.x, y - q.y);
            if (Math.abs(d - q.r) <= tol) return "ring";
        }
        const dCenter = Math.hypot(x - q.x, y - q.y);
        if (dCenter <= Math.max(tol * 1.5, q.r * 0.12)) return "move";
        return null;
    }
    if (q.shape === "polygon") {
        const pts = Array.isArray(q.pts) ? q.pts : [];
        for (let i = 0; i < pts.length; i++) {
            if (Math.hypot(x - pts[i][0], y - pts[i][1]) <= tol) {
                return "corner_" + i;
            }
        }
        // Centre anchor hit
        if (Math.hypot(x - q.x, y - q.y) <= Math.max(tol * 1.5, 10)) return "move";
        // Edge hit within tol
        const sd = polySigned(pts, x, y);
        if (Math.abs(sd) <= tol) return "ring";
        // Inside hit moves polygon
        if (sd < 0) return "move";
        return null;
    }
    if (q.shape === "line") {
        const A = ((q.angle || 0) * Math.PI) / 180;
        const cosA = Math.cos(A), sinA = Math.sin(A);
        const r = Math.max(1, +q.r || 1);
        const ax = q.x - r * cosA, ay = q.y - r * sinA;
        const bx = q.x + r * cosA, by = q.y + r * sinA;
        if (Math.hypot(x - ax, y - ay) <= tol) return "handleA";
        if (Math.hypot(x - bx, y - by) <= tol) return "handleB";
        if (Math.hypot(x - q.x, y - q.y) <= Math.max(tol * 1.5, 10)) return "move";
        // Distance to segment AB
        const dx = bx - ax, dy = by - ay;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
        const qx = ax + t * dx, qy = ay + t * dy;
        if (Math.hypot(x - qx, y - qy) <= tol) return "move";
        return null;
    }
    return null;
}
