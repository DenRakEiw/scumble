// @ts-check
// Film pack: control point shapes and weights v2 (circles, ellipses, softness).
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
 * Fills defaults, clamps values, and validates shape.
 * Refuses polygon and line until R3-S6.
 *
 * @param {any} q
 * @returns {any}
 */
export function normalisePoint(q) {
    if (!q || typeof q !== "object") throw new Error("point must be an object");
    const shape = q.shape != null ? String(q.shape) : "circle";
    if (shape !== "circle" && shape !== "ellipse") {
        throw new Error("unknown shape: " + shape);
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
    return {
        ...q,
        shape,
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
        const kind = p.shape === "ellipse" ? 1 : 0;
        const inner = innerOf(p, s);
        const angleRad = ((p.angle || 0) * Math.PI) / 180;
        const cosA = Math.cos(angleRad), sinA = Math.sin(angleRad);

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
        data[o + 14] = 0;
        data[o + 15] = 0;

        // t4: cosA, sinA, ry, T
        data[o + 16] = cosA;
        data[o + 17] = sinA;
        data[o + 18] = ry;
        data[o + 19] = 0;
        // t5..t13 remain 0.0
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
    float dist = 0.0;
    if (kind == 0) {
        dist = distance(p, a.xy) / max(a.z, 1.0);
    } else if (kind == 1) {
        vec4 tr = texelFetch(u_pts, ivec2(4, i), 0);
        vec2 d = p - a.xy;
        float cosA = tr.x, sinA = tr.y, ry = max(tr.z, 1.0);
        vec2 q = vec2(d.x * cosA + d.y * sinA, -d.x * sinA + d.y * cosA);
        q.x /= max(a.z, 1.0);
        q.y /= ry;
        dist = length(q);
    } else {
        return 0.0;
    }
    return 1.0 - sstep(inner, 1.0, dist);
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
    return { ...q, x: nx, y: ny, r: +q.r * s };
}

/**
 * Returns handle coordinates for shape q.
 *
 * @param {any} q
 * @returns {{ id: "move" | "r" | "ry", x: number, y: number }[]}
 */
export function handlesOf(q) {
    const res = [{ id: /** @type {"move"} */ ("move"), x: q.x, y: q.y }];
    const A = ((q.angle || 0) * Math.PI) / 180;
    const cosA = Math.cos(A), sinA = Math.sin(A);
    const xr = q.x + q.r * cosA, yr = q.y + q.r * sinA;
    res.push({ id: /** @type {"r"} */ ("r"), x: xr, y: yr });
    if (q.shape === "ellipse") {
        const ry = q.ry != null ? q.ry : Math.round(0.6 * q.r);
        const xry = q.x - ry * sinA, yry = q.y + ry * cosA;
        res.push({ id: /** @type {"ry"} */ ("ry"), x: xry, y: yry });
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
 * @returns {null | "move" | "ring" | "r" | "ry"}
 */
export function hitShape(q, x, y, tol) {
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
