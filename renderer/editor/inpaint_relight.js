// @ts-check
// Inpaint Canvas - relight light model, fit, Kelvin conversion and shading maths (L0a)
// Orthographic height-field lighting from depth maps (PLAN_RELIGHT_BUILD.md sec 4.1).
// Pure ASCII, no DOM at import: runs under plain Node, in Web Workers, and in the renderer.

import { sampleMap, passToMap, rg8View, guideView, SAMPLE_GLSL } from "./inpaint_maps.js";
import { snapField, snapParams, SNAP_GLSL } from "./inpaint_edges.js";
import { registerGLFilter } from "./inpaint_filters_gl.js";
import { heightNormals, shadowMarch } from "./px/kernels.js";

const DUMMY_NORMALS = { data: new Uint8Array([128, 128, 255, 255]), width: 1, height: 1, channels: 4, linear: true };
const DUMMY_VIS = { data: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1, channels: 4, linear: true };
const DUMMY_RG8 = { data: new Uint8Array([0, 0]), width: 1, height: 1, channels: 2 };
const DUMMY_RGBA8 = { data: new Uint8Array([0, 0, 0, 255]), width: 1, height: 1, channels: 4 };

/**
 * Samples a continuous (x, y) point on a RGBA8 buffer with bilinear interpolation and border clamp.
 * @param {Uint8Array|Uint8ClampedArray} data
 * @param {number} w
 * @param {number} h
 * @param {number} x
 * @param {number} y
 * @returns {[number, number, number, number]}
 */
function sampleRgbaBilinear(data, w, h, x, y) {
    const qx = Math.max(0, Math.min(w - 1, x - 0.5));
    const qy = Math.max(0, Math.min(h - 1, y - 0.5));
    const x0 = Math.floor(qx);
    const y0 = Math.floor(qy);
    const x1 = Math.min(w - 1, x0 + 1);
    const y1 = Math.min(h - 1, y0 + 1);
    const fx = qx - x0;
    const fy = qy - y0;
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    const i00 = (y0 * w + x0) * 4;
    const i10 = (y0 * w + x1) * 4;
    const i01 = (y1 * w + x0) * 4;
    const i11 = (y1 * w + x1) * 4;
    return [
        w00 * data[i00] + w10 * data[i10] + w01 * data[i01] + w11 * data[i11],
        w00 * data[i00 + 1] + w10 * data[i10 + 1] + w01 * data[i01 + 1] + w11 * data[i11 + 1],
        w00 * data[i00 + 2] + w10 * data[i10 + 2] + w01 * data[i01 + 2] + w11 * data[i11 + 2],
        w00 * data[i00 + 3] + w10 * data[i10 + 3] + w01 * data[i01 + 3] + w11 * data[i11 + 3],
    ];
}


export const LIGHT_MAX = 4;
export const LIGHT_TYPES = Object.freeze(["point", "sun", "spot"]);

export const KELVIN_PRESETS = Object.freeze([
    Object.freeze({ kelvin: 2700, label: "Tungsten" }),
    Object.freeze({ kelvin: 3200, label: "Halogen" }),
    Object.freeze({ kelvin: 4000, label: "Fluorescent" }),
    Object.freeze({ kelvin: 5500, label: "Daylight" }),
    Object.freeze({ kelvin: 6500, label: "Overcast" }),
    Object.freeze({ kelvin: 8000, label: "Shade" }),
    Object.freeze({ kelvin: 10000, label: "Blue sky" }),
]);

/**
 * Parses a hex colour string into [r, g, b] in 0..1 (sRGB).
 * @param {string} hex
 * @returns {[number, number, number]}
 */
export function hexToRgb(hex) {
    if (typeof hex !== "string") return [1, 1, 1];
    let s = hex.trim();
    if (s.startsWith("#")) s = s.slice(1);
    if (s.length === 3) {
        s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    }
    if (s.length !== 6) return [1, 1, 1];
    const val = parseInt(s, 16);
    if (Number.isNaN(val)) return [1, 1, 1];
    return [((val >> 16) & 255) / 255, ((val >> 8) & 255) / 255, (val & 255) / 255];
}

/**
 * Transfers sRGB channel value in 0..1 to linear light.
 * @param {number} c
 * @returns {number}
 */
export function srgbToLinear(c) {
    const v = Math.max(0, Math.min(1, c));
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * Transfers linear light channel value to sRGB.
 * @param {number} c
 * @returns {number}
 */
export function linearToSrgb(c) {
    const v = Math.max(0, c);
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1.0 / 2.4) - 0.055;
}

/**
 * Internal raw Planckian approximation for blackbody radiation (Tanner Helland method).
 * @param {number} kelvin
 * @returns {[number, number, number]}
 */
function rawKelvinLinear(kelvin) {
    const temp = Math.max(1000, Math.min(10000, Number(kelvin) || 5500)) / 100;
    let r, g, b;
    if (temp <= 66) {
        r = 255;
        g = 99.4708025861 * Math.log(temp) - 161.1195681661;
        if (temp <= 19) {
            b = 0;
        } else {
            b = 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
        }
    } else {
        r = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
        g = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
        b = 255;
    }
    const rNorm = Math.max(0, Math.min(255, r)) / 255;
    const gNorm = Math.max(0, Math.min(255, g)) / 255;
    const bNorm = Math.max(0, Math.min(255, b)) / 255;
    return [srgbToLinear(rNorm), srgbToLinear(gNorm), srgbToLinear(bNorm)];
}

const KELVIN_5500_REF = rawKelvinLinear(5500);

/**
 * Converts a Kelvin colour temperature (1000..10000 K) or hex colour string
 * into linear RGB, normalized so 5500 K produces exactly (1, 1, 1).
 * @param {number|string} k - Kelvin number or hex colour string
 * @returns {[number, number, number]} Linear RGB components
 */
export function kelvinToRgb(k) {
    if (typeof k === "string" && k.trim().startsWith("#")) {
        const [sr, sg, sb] = hexToRgb(k);
        return [srgbToLinear(sr), srgbToLinear(sg), srgbToLinear(sb)];
    }
    const raw = rawKelvinLinear(typeof k === "number" ? k : Number(k) || 5500);
    return [raw[0] / KELVIN_5500_REF[0], raw[1] / KELVIN_5500_REF[1], raw[2] / KELVIN_5500_REF[2]];
}

/**
 * Returns an sRGB hex colour string ("#rrggbb") for a light colour
 * (which can be a Kelvin number or a hex string).
 * @param {number|string} color
 * @returns {string}
 */
export function lightColorHex(color) {
    if (typeof color === "string" && color.trim().startsWith("#")) {
        const h = color.trim().toLowerCase();
        if (h.length === 4) {
            return "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
        }
        if (h.length === 7) return h;
    }
    const [lr, lg, lb] = kelvinToRgb(color);
    const sr = Math.max(0, Math.min(255, Math.round(linearToSrgb(lr) * 255)));
    const sg = Math.max(0, Math.min(255, Math.round(linearToSrgb(lg) * 255)));
    const sb = Math.max(0, Math.min(255, Math.round(linearToSrgb(lb) * 255)));
    return "#" + [sr, sg, sb].map((c) => c.toString(16).padStart(2, "0")).join("");
}

/**
 * Creates a default light configuration object.
 * @param {number} [i=0]
 * @param {{ width?: number, height?: number }|null} [size=null]
 * @returns {object}
 */
export function defaultLight(i = 0, size = null) {
    const w = size && size.width ? size.width : 1024;
    const h = size && size.height ? size.height : 1024;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const offsets = [
        [0, 0],
        [-w * 0.25, -h * 0.2],
        [w * 0.25, -h * 0.2],
        [0, h * 0.25],
    ];
    const [ox, oy] = offsets[i % offsets.length];
    return {
        id: `light_${i + 1}`,
        type: "point",
        x: Math.round(cx + ox),
        y: Math.round(cy + oy),
        dist: -30,
        intensity: 100,
        color: 5500,
        diffusion: 30,
        range: 50,
        on: true,
        cone: 30,
        edge: 20,
        aim: [Math.round(cx + ox), Math.round(cy + oy + 100)],
    };
}

/**
 * Normalizes an array of lights, clamping fields, dropping unknown fields,
 * and capping at LIGHT_MAX (4) entries.
 * @param {any[]} list
 * @param {{ width?: number, height?: number }|null} [size=null]
 * @returns {object[]}
 */
export function normalizeLights(list, size = null) {
    if (!Array.isArray(list)) return [defaultLight(0, size)];
    const out = [];
    const count = Math.min(LIGHT_MAX, list.length);
    for (let i = 0; i < count; i++) {
        const item = list[i] || {};
        const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `light_${i + 1}`;
        const type = LIGHT_TYPES.includes(item.type) ? item.type : "point";
        const x = Number.isFinite(item.x) ? Number(item.x) : (size?.width ? size.width * 0.5 : 512);
        const y = Number.isFinite(item.y) ? Number(item.y) : (size?.height ? size.height * 0.5 : 512);
        const dist = Math.max(-100, Math.min(100, Number.isFinite(item.dist) ? Number(item.dist) : -30));
        const intensity = Math.max(0, Math.min(300, Number.isFinite(item.intensity) ? Number(item.intensity) : 100));

        let color = 5500;
        if (typeof item.color === "string" && item.color.trim().startsWith("#")) {
            const h = item.color.trim();
            if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(h)) {
                color = h.toLowerCase();
            }
        } else if (Number.isFinite(Number(item.color))) {
            color = Math.max(1000, Math.min(10000, Math.round(Number(item.color))));
        }

        const diffusion = Math.max(0, Math.min(100, Number.isFinite(item.diffusion) ? Number(item.diffusion) : 30));
        const range = Math.max(5, Math.min(500, Number.isFinite(item.range) ? Number(item.range) : 50));
        const on = item.on !== false;
        const cone = Math.max(1, Math.min(89, Number.isFinite(item.cone) ? Number(item.cone) : 30));
        const edge = Math.max(0, Math.min(100, Number.isFinite(item.edge) ? Number(item.edge) : 20));

        let aim = [Math.round(x), Math.round(y + 100)];
        if (Array.isArray(item.aim) && item.aim.length >= 2 && Number.isFinite(item.aim[0]) && Number.isFinite(item.aim[1])) {
            aim = [Number(item.aim[0]), Number(item.aim[1])];
        }

        out.push({
            id,
            type,
            x,
            y,
            dist,
            intensity,
            color,
            diffusion,
            range,
            on,
            cone,
            edge,
            aim,
        });
    }
    return out.length > 0 ? out : [defaultLight(0, size)];
}

/**
 * Computes a light's 3D position in map pixel coordinates and surface depth under the handle.
 * @param {object} light
 * @param {any} [map=null] - DocMap for depth
 * @param {object} [params=null] - Filter parameters
 * @returns {{ mx: number, my: number, mz: number, lz: number, zSurface: number, scaleZ: number, longSide: number, aim: [number, number, number]|null, rangeInMapPixels: number }}
 */
export function lightToMap(light, map = null, params = null) {
    const longSide = map && map.w > 0 && map.h > 0 ? Math.max(map.w, map.h) : 1024;
    const depthScale = Math.max(5, Math.min(200, Number(params?.depth_scale) || 50));
    const scaleZ = (depthScale / 100.0) * longSide;

    let mx = Number(light.x) || 0;
    let my = Number(light.y) || 0;
    let far01 = 0.5;

    if (map && map.data && map.w > 0 && map.h > 0) {
        if (map.xf) {
            const m = passToMap(map, 1);
            mx = m[0] * light.x + m[2] * light.y + m[4];
            my = m[1] * light.x + m[3] * light.y + m[5];
        }
        far01 = sampleMap(map, light.x, light.y);
    }

    const zSurface = far01 * scaleZ;
    const dist = Number.isFinite(light.dist) ? Number(light.dist) : -30;
    const lz = zSurface - (dist / 100.0) * scaleZ;

    /** @type {[number, number, number]|null} */
    let aimMap = null;
    if (light.aim && Array.isArray(light.aim)) {
        let ax = Number(light.aim[0]) || 0;
        let ay = Number(light.aim[1]) || 0;
        let aimFar01 = 0.5;
        if (map && map.data && map.w > 0 && map.h > 0) {
            if (map.xf) {
                const m = passToMap(map, 1);
                const rawAx = ax, rawAy = ay;
                ax = m[0] * rawAx + m[2] * rawAy + m[4];
                ay = m[1] * rawAx + m[3] * rawAy + m[5];
            }
            aimFar01 = sampleMap(map, light.aim[0], light.aim[1]);
        }
        aimMap = [ax, ay, aimFar01 * scaleZ];
    }

    const rangeVal = Math.max(1, Number.isFinite(light.range) ? Number(light.range) : 50);
    const rangeInMapPixels = (rangeVal / 100.0) * longSide;

    return {
        mx,
        my,
        mz: lz,
        lz,
        zSurface,
        scaleZ,
        longSide,
        aim: aimMap,
        rangeInMapPixels,
    };
}

/**
 * Solves for the dominant light direction l0 and ambient/diffuse terms (ka, kd)
 * by least-squares fit against picture luminance and normals over opaque pixels.
 * S_fit = ka + kd * max(0, n . l0) is normalized so its mean is 1.0.
 *
 * @param {Uint8Array|Uint8ClampedArray} small - Composite RGBA8 bytes (256x256)
 * @param {Uint8Array|Uint8ClampedArray} normalsSmall - Packed RGBA8 normals (256x256)
 * @param {number} [w=256]
 * @param {number} [h=256]
 * @returns {{ l0: [number, number, number], ka: number, kd: number }}
 */
export function fitOriginalLight(small, normalsSmall, w = 256, h = 256) {
    const N = w * h;
    const M = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const V = [0, 0, 0, 0];
    let sumY = 0;
    let count = 0;

    for (let i = 0; i < N; i++) {
        const off = i * 4;
        if (small[off + 3] < 128 || normalsSmall[off + 3] < 128) continue;
        const Y = (0.299 * small[off] + 0.587 * small[off + 1] + 0.114 * small[off + 2]) / 255.0;
        const nx = (normalsSmall[off] - 127.5) / 127.5;
        const ny = (normalsSmall[off + 1] - 127.5) / 127.5;
        const nz = (normalsSmall[off + 2] - 127.5) / 127.5;
        const feats = [1.0, nx, ny, nz];
        sumY += Y;
        count++;
        for (let r = 0; r < 4; r++) {
            V[r] += Y * feats[r];
            for (let c = 0; c < 4; c++) {
                M[r][c] += feats[r] * feats[c];
            }
        }
    }

    if (count === 0) {
        return { l0: [0, 0, 1], ka: 1.0, kd: 0.0 };
    }

    const meanY = sumY / count;

    // Solve 4x4 system M * b = V using Gaussian elimination with partial pivoting
    const aug = M.map((row, idx) => [...row, V[idx]]);
    let singular = false;
    for (let i = 0; i < 4; i++) {
        let maxRow = i;
        for (let k = i + 1; k < 4; k++) {
            if (Math.abs(aug[k][i]) > Math.abs(aug[maxRow][i])) maxRow = k;
        }
        [aug[i], aug[maxRow]] = [aug[maxRow], aug[i]];
        const p = aug[i][i];
        if (Math.abs(p) < 1e-6) {
            singular = true;
            break;
        }
        for (let j = i; j <= 4; j++) aug[i][j] /= p;
        for (let k = 0; k < 4; k++) {
            if (k === i) continue;
            const factor = aug[k][i];
            for (let j = i; j <= 4; j++) aug[k][j] -= factor * aug[i][j];
        }
    }

    /** @type {[number, number, number]} */
    let l0 = [0, 0, 1];
    let bLen = 0;
    if (!singular) {
        const b = aug.map(row => row[4]);
        bLen = Math.hypot(b[1], b[2], b[3]);
        if (bLen > 1e-4) {
            l0 = [b[1] / bLen, b[2] / bLen, b[3] / bLen];
        }
    }

    if (bLen <= 1e-4) {
        return { l0: [0, 0, 1], ka: 1.0, kd: 0.0 };
    }

    // Solve for ka >= 0, kd >= 0 in Y ~= ka + kd * max(0, n . l0)
    let sC = 0, sC2 = 0, sYC = 0;
    for (let i = 0; i < N; i++) {
        const off = i * 4;
        if (small[off + 3] < 128 || normalsSmall[off + 3] < 128) continue;
        const Y = (0.299 * small[off] + 0.587 * small[off + 1] + 0.114 * small[off + 2]) / 255.0;
        const nx = (normalsSmall[off] - 127.5) / 127.5;
        const ny = (normalsSmall[off + 1] - 127.5) / 127.5;
        const nz = (normalsSmall[off + 2] - 127.5) / 127.5;
        const c = Math.max(0, nx * l0[0] + ny * l0[1] + nz * l0[2]);
        sC += c;
        sC2 += c * c;
        sYC += Y * c;
    }

    let ka = meanY;
    let kd = 0;
    const det = count * sC2 - sC * sC;
    if (det > 1e-9) {
        ka = (sumY * sC2 - sC * sYC) / det;
        kd = (count * sYC - sC * sumY) / det;
        if (kd < 0) {
            kd = 0;
            ka = meanY;
        } else if (ka < 0) {
            ka = 0;
            kd = sC2 > 0 ? sYC / sC2 : 0;
        }
    }

    const meanFit = ka + kd * (sC / count);
    if (meanFit > 1e-6) {
        ka /= meanFit;
        kd /= meanFit;
    } else {
        ka = 1.0;
        kd = 0.0;
    }

    return { l0, ka, kd };
}

/**
 * Evaluates the relight shading formula for a single pixel.
 * Matches WebGL2 shader maths exactly.
 *
 * @param {number[]|Uint8Array} srcRgba - Input pixel [r, g, b, a] in 0..255
 * @param {number[]|Float32Array} normal - Surface normal [nx, ny, nz] (-1..1) or packed bytes
 * @param {[number, number, number]|[number, number]} mapCoord - [mx, my, mz]
 * @param {object[]} lights - Light definitions
 * @param {object} [params=null] - Filter parameters (original, ambient, shadows, recover)
 * @param {{ l0: [number, number, number], ka: number, kd: number }|null} [fit=null]
 * @param {number[]|null} [visValues=null] - Shadow visibility for each light (0..1)
 * @returns {[number, number, number, number]} Output pixel RGBA in 0..255
 */
export function shadePixel(srcRgba, normal, mapCoord, lights, params = null, fit = null, visValues = null) {
    const sr = Number(srcRgba[0]) / 255.0;
    const sg = Number(srcRgba[1]) / 255.0;
    const sb = Number(srcRgba[2]) / 255.0;
    const sa = Number(srcRgba[3]);

    const origPct = Number.isFinite(params?.original) ? Number(params?.original) : 100;
    const activeLights = (lights || []).filter(l => l && l.on);

    // Identity fast-path when no lights are active and original light is 100%
    if (activeLights.length === 0 && origPct === 100) {
        return [Number(srcRgba[0]), Number(srcRgba[1]), Number(srcRgba[2]), sa];
    }

    // Normal unpack and normalization
    let nx = Number(normal[0]);
    let ny = Number(normal[1]);
    let nz = Number(normal[2]);
    if (nx > 1.0 || ny > 1.0 || nz > 1.0 || nx < -1.0 || ny < -1.0 || nz < -1.0) {
        nx = (nx - 127.5) / 127.5;
        ny = (ny - 127.5) / 127.5;
        nz = (nz - 127.5) / 127.5;
    }
    const nLen = Math.hypot(nx, ny, nz);
    if (nLen > 1e-6) {
        nx /= nLen;
        ny /= nLen;
        nz /= nLen;
    } else {
        nx = 0;
        ny = 0;
        nz = 1;
    }

    const mx = Number(mapCoord[0]) || 0;
    const my = Number(mapCoord[1]) || 0;
    const mz = Number(mapCoord[2]) || 0;

    // Linear input color
    const pr = srgbToLinear(sr);
    const pg = srgbToLinear(sg);
    const pb = srgbToLinear(sb);

    // Fitted original light S_fit
    const l0 = fit?.l0 || [0, 0, 1];
    const ka = Number.isFinite(fit?.ka) ? Number(fit?.ka) : 1.0;
    const kd = Number.isFinite(fit?.kd) ? Number(fit?.kd) : 0.0;
    const dotL0 = Math.max(0, nx * l0[0] + ny * l0[1] + nz * l0[2]);
    const sFit = Math.max(0.1, ka + kd * dotL0);

    // Shadow recovery gain G = 1 / S_fit clamped by recover
    const recover = Number.isFinite(params?.recover) ? Number(params?.recover) : 3.0;
    let gain = Math.min(recover, 1.0 / sFit);

    // Fade gain to 1.0 in deepest shadow noise
    const pLuma = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
    if (pLuma < 0.03) {
        const fade = Math.max(0, Math.min(1, (pLuma - 0.005) / 0.025));
        gain = 1.0 + (gain - 1.0) * fade;
    }

    const fr = pr * gain;
    const fg = pg * gain;
    const fb = pb * gain;

    // Accumulate virtual lights
    let lsumR = 0, lsumG = 0, lsumB = 0;
    const shadowsStrength = (Number.isFinite(params?.shadows) ? Number(params?.shadows) : 60) / 100.0;

    for (let i = 0; i < (lights || []).length; i++) {
        const l = lights[i];
        if (!l || !l.on) continue;

        const rgbLin = kelvinToRgb(l.color);
        const intensity = (Number.isFinite(l.intensity) ? Number(l.intensity) : 100) / 100.0;
        const diffusion = (Number.isFinite(l.diffusion) ? Number(l.diffusion) : 30) / 100.0;
        const range = Number.isFinite(l.rangeInMapPixels) ? Number(l.rangeInMapPixels) : Math.max(1, Number.isFinite(l.range) ? Number(l.range) : 50);

        let lx = Number(l.mx ?? l.x) || 0;
        let ly = Number(l.my ?? l.y) || 0;
        let lz = Number.isFinite(l.lz) ? Number(l.lz) : 0;

        let dirX, dirY, dirZ;
        let att = 1.0;

        if (l.type === "sun") {
            dirX = lx;
            dirY = ly;
            dirZ = lz;
            const dLen = Math.hypot(dirX, dirY, dirZ) || 1.0;
            dirX /= dLen;
            dirY /= dLen;
            dirZ /= dLen;
            att = 1.0;
        } else {
            const dx = lx - mx;
            const dy = ly - my;
            const dz = lz - mz;
            const dist = Math.hypot(dx, dy, dz);
            if (dist > 1e-6) {
                dirX = dx / dist;
                dirY = dy / dist;
                dirZ = dz / dist;
            } else {
                dirX = 0;
                dirY = 0;
                dirZ = 1;
            }
            att = 1.0 / (1.0 + Math.pow(dist / range, 2));
        }

        // Wrapped Lambert term
        const dotNL = nx * dirX + ny * dirY + nz * dirZ;
        const ndl = Math.max(0.0, (dotNL + diffusion) / (1.0 + diffusion));

        // Spot cone term
        let coneTerm = 1.0;
        if (l.type === "spot" && l.aim) {
            const [ax, ay, az] = l.aim;
            const aimDx = ax - lx;
            const aimDy = ay - ly;
            const aimDz = (az || 0) - lz;
            const aimLen = Math.hypot(aimDx, aimDy, aimDz) || 1.0;
            const sDirX = aimDx / aimLen;
            const sDirY = aimDy / aimLen;
            const sDirZ = aimDz / aimLen;

            // Angle between spot direction and ray from light to surface (-dir)
            const cosAngle = -(dirX * sDirX + dirY * sDirY + dirZ * sDirZ);
            const coneAngleRad = ((Number.isFinite(l.cone) ? Number(l.cone) : 30) * Math.PI) / 180.0;
            const cosCone = Math.cos(coneAngleRad);
            const edgeSoftness = (Number.isFinite(l.edge) ? Number(l.edge) : 20) / 100.0;
            const cosOuter = cosCone - edgeSoftness * (1.0 - cosCone);

            if (cosAngle <= cosOuter) {
                coneTerm = 0.0;
            } else if (cosAngle >= cosCone) {
                coneTerm = 1.0;
            } else {
                const t = (cosAngle - cosOuter) / Math.max(1e-6, cosCone - cosOuter);
                coneTerm = t * t * (3.0 - 2.0 * t);
            }
        }

        // Shadow visibility
        const vis = visValues && Number.isFinite(visValues[i]) ? Number(visValues[i]) : 1.0;
        const vTerm = 1.0 - shadowsStrength * (1.0 - vis);

        const factor = intensity * ndl * att * coneTerm * vTerm;
        lsumR += rgbLin[0] * factor;
        lsumG += rgbLin[1] * factor;
        lsumB += rgbLin[2] * factor;
    }

    const o = origPct / 100.0;
    const ambient = (Number.isFinite(params?.ambient) ? Number(params?.ambient) : 15) / 100.0;

    if (params?.mode === 1) {
        let lmR = lsumR + ambient;
        let lmG = lsumG + ambient;
        let lmB = lsumB + ambient;
        return [
            Math.max(0, Math.min(255, Math.round(linearToSrgb(lmR) * 255))),
            Math.max(0, Math.min(255, Math.round(linearToSrgb(lmG) * 255))),
            Math.max(0, Math.min(255, Math.round(linearToSrgb(lmB) * 255))),
            sa
        ];
    }

    const termR = o * sFit + (1.0 - o) * ambient + lsumR;
    const termG = o * sFit + (1.0 - o) * ambient + lsumG;
    const termB = o * sFit + (1.0 - o) * ambient + lsumB;

    let outLinR = fr * termR;
    let outLinG = fg * termG;
    let outLinB = fb * termB;

    // Highlight soft shoulder rolloff
    if (outLinR > 0.8) outLinR = 0.8 + 0.2 * (1.0 - Math.exp(-(outLinR - 0.8) / 0.2));
    if (outLinG > 0.8) outLinG = 0.8 + 0.2 * (1.0 - Math.exp(-(outLinG - 0.8) / 0.2));
    if (outLinB > 0.8) outLinB = 0.8 + 0.2 * (1.0 - Math.exp(-(outLinB - 0.8) / 0.2));

    const outSrgbR = Math.max(0, Math.min(255, Math.round(linearToSrgb(outLinR) * 255)));
    const outSrgbG = Math.max(0, Math.min(255, Math.round(linearToSrgb(outLinG) * 255)));
    const outSrgbB = Math.max(0, Math.min(255, Math.round(linearToSrgb(outLinB) * 255)));

    return [outSrgbR, outSrgbG, outSrgbB, sa];
}

/**
 * Summarizes the lights as prompt words for generative routes (PLAN_RELIGHT_BUILD.md sec 4.6).
 * @param {object[]} lights
 * @param {{ width?: number, height?: number }|null} [size=null]
 * @returns {{ prompt: string, latent: string, bria: { direction: string, type: string }, words: string }}
 */
export function lightsToWords(lights, size = null) {
    const active = (lights || []).filter(l => l && l.on);
    const w = size?.width || 1024;
    const h = size?.height || 1024;
    const cx = w * 0.5;
    const cy = h * 0.5;

    if (active.length === 0) {
        return {
            prompt: "Relight: natural balanced lighting",
            latent: "None",
            bria: { direction: "front", type: "soft overcast daylight lighting" },
            words: "natural lighting",
        };
    }

    const describeLight = (l) => {
        const dx = l.x - cx;
        const dy = l.y - cy;
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);

        let dir = "front";
        if (l.dist > 25) {
            dir = "behind (rim light)";
        } else if (absX > 0.15 * w && absY > 0.15 * h) {
            dir = (dy < 0 ? "upper " : "lower ") + (dx < 0 ? "left" : "right");
        } else if (absX > absY && absX > 0.15 * w) {
            dir = dx < 0 ? "left" : "right";
        } else if (absY > 0.15 * h) {
            dir = dy < 0 ? "above" : "below";
        } else {
            dir = "front";
        }

        let colWord = "white";
        if (typeof l.color === "string" && l.color.startsWith("#")) {
            colWord = "colored";
        } else {
            const k = Number(l.color) || 5500;
            if (k <= 3000) colWord = "warm tungsten";
            else if (k <= 4500) colWord = "warm";
            else if (k <= 6000) colWord = "daylight";
            else if (k <= 7500) colWord = "cool";
            else colWord = "deep cool blue";
        }

        const diffWord = (Number(l.diffusion) || 30) >= 50 ? "soft" : "hard";
        const typeWord = l.type === "sun" ? "sunlight" : (l.type === "spot" ? "spotlight" : "light");

        return {
            phrase: `a ${diffWord} ${colWord} ${typeWord} from the ${dir}`,
            dir,
        };
    };

    const phrases = active.map(describeLight).map(d => d.phrase);
    const prompt = `Relight: ${phrases.join(", ")}`;

    // ICLight latent enum: Left / Right / Top / Bottom / None
    const firstDx = active[0].x - cx;
    const firstDy = active[0].y - cy;
    let latent = "None";
    if (Math.abs(firstDx) > Math.abs(firstDy) && Math.abs(firstDx) > 0.15 * w) {
        latent = firstDx < 0 ? "Left" : "Right";
    } else if (Math.abs(firstDy) > 0.15 * h) {
        latent = firstDy < 0 ? "Top" : "Bottom";
    }

    // Bria direction enum: front / side / bottom / top-down
    let briaDir = "front";
    if (active[0].dist > 25) {
        briaDir = "side";
    } else if (Math.abs(firstDx) > Math.abs(firstDy) && Math.abs(firstDx) > 0.15 * w) {
        briaDir = "side";
    } else if (firstDy < -0.15 * h) {
        briaDir = "top-down";
    } else if (firstDy > 0.15 * h) {
        briaDir = "bottom";
    }

    const briaType = active[0].type === "sun"
        ? "low-angle sunlight"
        : (active[0].type === "spot" ? "spotlight on subject" : "soft overcast daylight lighting");

    return {
        prompt,
        latent,
        bria: { direction: briaDir, type: briaType },
        words: phrases.join(", "),
    };
}

/**
 * wholeStats provider for the relight filter (PLAN_RELIGHT_BUILD.md sec 4.4).
 * Samples 256x256 composite below the layer and depth normals to compute original light fit.
 *
 * @param {{ data: Uint8Array|Uint8ClampedArray, w: number, h: number }} small
 * @param {{ width: number, height: number }} size
 * @param {any} ctx
 * @returns {{ fit: { l0: [number, number, number], ka: number, kd: number }, seq: number }}
 */
export function relightStats(small, size, ctx) {
    if (!small || !small.data || small.w <= 0 || small.h <= 0) {
        return { fit: { l0: [0, 0, 1], ka: 1.0, kd: 0.0 }, seq: 0 };
    }

    const depthMap = ctx?.maps?.depth;
    if (!depthMap || !depthMap.data || depthMap.w <= 0 || depthMap.h <= 0) {
        return { fit: { l0: [0, 0, 1], ka: 1.0, kd: 0.0 }, seq: 0 };
    }

    // Build 256x256 depth map sample
    const W = small.w;
    const H = small.h;
    const depthSmall = new Uint16Array(W * H);
    for (let y = 0; y < H; y++) {
        const docY = ((y + 0.5) / H) * size.height;
        for (let x = 0; x < W; x++) {
            const docX = ((x + 0.5) / W) * size.width;
            const far01 = sampleMap(depthMap, docX, docY);
            depthSmall[y * W + x] = Math.round(Math.max(0, Math.min(1, far01)) * 65535);
        }
    }

    const longSide = Math.max(W, H);
    const scale = (50 / 100.0) * longSide;
    const normalsSmall = heightNormals(depthSmall, W, H, scale, 2.0);
    const fit = fitOriginalLight(small.data, normalsSmall, W, H);

    return { fit, seq: Date.now() };
}

function makeCanvas(w, h) {
    if (typeof document !== "undefined" && document.createElement) {
        const c = document.createElement("canvas");
        c.width = Math.max(1, w | 0);
        c.height = Math.max(1, h | 0);
        return c;
    }
    // @ts-ignore
    if (typeof OffscreenCanvas !== "undefined") {
        // @ts-ignore
        return new OffscreenCanvas(Math.max(1, w | 0), Math.max(1, h | 0));
    }
    throw new Error("No canvas implementation available in this environment");
}

function openPixels(src) {
    const W = src.width, H = src.height;
    const out = makeCanvas(W, H);
    const octx = out.getContext("2d");
    if (!octx) throw new Error("Could not get 2d context");
    octx.drawImage(src, 0, 0);
    const img = octx.getImageData(0, 0, W, H);
    return { out, octx, img, px: img.data };
}

function copyCanvas(src) {
    const W = src.width, H = src.height;
    const out = makeCanvas(W, H);
    const octx = out.getContext("2d");
    if (octx) octx.drawImage(src, 0, 0);
    return out;
}

/**
 * CPU twin for the relight filter (PLAN_RELIGHT_BUILD.md sec 4.2).
 * Shaded per-pixel with bilinear map sampling and bilateral edge snap.
 *
 * @param {any} src
 * @param {any} params
 * @param {any} info
 * @returns {any}
 */
export function applyRelight(src, params, info = {}) {
    const map = (info && info.maps && info.maps.depth) || null;
    if (!map || !map.data || map.w <= 0 || map.h <= 0) return copyCanvas(src);
    const p = params || {};
    const lightsList = Array.isArray(p.lights) ? p.lights : [];
    const origPct = Number.isFinite(p.original) ? Number(p.original) : 100;
    if (p.mode !== 1 && (!lightsList || lightsList.every((l) => !l || !l.on)) && origPct === 100) {
        return copyCanvas(src);
    }

    const { out, octx, img, px } = openPixels(src);
    const W = src.width, H = src.height;
    const scale = info.scale || 1;
    const m = passToMap(map, scale);
    const origin = info.full ? (info.origin || [0, 0]) : [0, 0];
    const snap = (map.guide) ? (snapParams(map.meta?.snap?.strength) || [0, 0]) : [0, 0];
    const [sigmaR, tau] = snap;
    const guide = map.guide || null;

    const depthScale = Number.isFinite(p.depth_scale) ? Number(p.depth_scale) : 50;
    const sigma = Number.isFinite(p.sigma) ? Number(p.sigma) : 2.0;
    const mapLongSide = Math.max(map.w, map.h);
    const scaleZ = (depthScale / 100.0) * mapLongSide;

    const cache = info.relight || info.layer?._relight || null;
    let normalsData = null;
    if (cache && cache.normals && cache.normals.data) {
        normalsData = cache.normals.data;
    } else {
        normalsData = heightNormals(map.data, map.w, map.h, scaleZ, sigma);
    }

    let visData = null;
    if (cache && cache.vis && cache.vis.data) {
        visData = cache.vis.data;
    } else {
        const vd = new Uint8Array(map.w * map.h * 4);
        vd.fill(255);
        for (let i = 0; i < Math.min(4, lightsList.length); i++) {
            const l = lightsList[i];
            if (!l || !l.on) continue;
            const lm = lightToMap(l, map, { depth_scale: depthScale });
            const lightVec = [lm.mx, lm.my, lm.mz, l.type === "sun" ? 1 : 0];
            const diff = Number.isFinite(l.diffusion) ? Number(l.diffusion) : 30;
            const radius = (diff / 100.0) * (0.05 * mapLongSide);
            const bias = 0.005 * scaleZ;
            const vChan = shadowMarch(map.data, map.w, map.h, scaleZ, lightVec, radius, 4, 32, bias, 0, map.h);
            for (let idx = 0; idx < map.w * map.h; idx++) {
                vd[idx * 4 + i] = vChan[idx];
            }
        }
        visData = vd;
    }

    const fit = (info && (info.wholeStats?.fit || info.stats?.fit || cache?.fit)) || { l0: [0, 0, 1], ka: 1.0, kd: 0.0 };
    const mappedLights = lightsList.map((l) => ({ ...l, ...lightToMap(l, map, { depth_scale: depthScale }) }));

    for (let y = 0; y < H; y++) {
        const py = origin[1] + y + 0.5;
        const row = y * W;
        for (let x = 0; x < W; x++) {
            const idx = (row + x) * 4;
            const px_x = origin[0] + x + 0.5;
            const mx = m[0] * px_x + m[2] * py + m[4];
            const my = m[1] * px_x + m[3] * py + m[5];

            const sr = px[idx];
            const sg = px[idx + 1];
            const sb = px[idx + 2];
            const sa = px[idx + 3];
            if (sa === 0) continue;

            const far = snapField(map, guide, mx, my, sr / 255.0, sg / 255.0, sb / 255.0, sigmaR, tau);
            const nRgba = sampleRgbaBilinear(normalsData, map.w, map.h, mx, my);
            const nx = (nRgba[0] - 127.5) / 127.5;
            const ny = (nRgba[1] - 127.5) / 127.5;
            const nz = (nRgba[2] - 127.5) / 127.5;

            const vRgba = sampleRgbaBilinear(visData, map.w, map.h, mx, my);
            const vVals = [vRgba[0] / 255.0, vRgba[1] / 255.0, vRgba[2] / 255.0, vRgba[3] / 255.0];

            const outRgba = shadePixel([sr, sg, sb, sa], [nx, ny, nz], [mx, my, far * scaleZ], mappedLights, p, fit, vVals);
            px[idx] = outRgba[0];
            px[idx + 1] = outRgba[1];
            px[idx + 2] = outRgba[2];
            px[idx + 3] = outRgba[3];
        }
    }
    octx.putImageData(img, 0, 0);
    return out;
}

const RELIGHT_GLSL = `
float w_sstep(float a, float b, float x) {
    if (b <= a) return x >= b ? 1.0 : 0.0;
    float t = clamp((x - a) / (b - a), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

${SAMPLE_GLSL}
${SNAP_GLSL}

float rl_srgbToLinear(float c) {
    c = clamp(c, 0.0, 1.0);
    return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}
vec3 rl_srgbToLinear(vec3 c) {
    return vec3(rl_srgbToLinear(c.r), rl_srgbToLinear(c.g), rl_srgbToLinear(c.b));
}
float rl_linearToSrgb(float c) {
    c = clamp(c, 0.0, 1.0);
    return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
vec3 rl_linearToSrgb(vec3 c) {
    return vec3(rl_linearToSrgb(c.r), rl_linearToSrgb(c.g), rl_linearToSrgb(c.b));
}
float rl_rolloff(float x) {
    return x > 0.8 ? 0.8 + 0.2 * (1.0 - exp(-(x - 0.8) / 0.2)) : x;
}

vec3 rl_evalLight(
    vec4 l_pos,
    vec4 l_col,
    vec4 l_cone,
    float l_edge,
    float kind,
    float l_mask,
    float vis,
    vec3 normal,
    vec3 mpos
) {
    if (l_col.r <= 0.0 && l_col.g <= 0.0 && l_col.b <= 0.0) return vec3(0.0);

    vec3 dir;
    float att = 1.0;
    if (kind > 0.5 && kind < 1.5) {
        float lLen = length(l_pos.xyz);
        dir = lLen > 1e-5 ? l_pos.xyz / lLen : vec3(0.0, 0.0, 1.0);
    } else {
        vec3 d = l_pos.xyz - mpos;
        float dist = length(d);
        if (dist > 1e-6) dir = d / dist; else dir = vec3(0.0, 0.0, 1.0);
        float r = max(1.0, l_pos.w);
        att = 1.0 / (1.0 + (dist * dist) / (r * r));
    }

    float diff = l_col.w;
    float ndl = max(0.0, (dot(normal, dir) + diff) / (1.0 + diff));

    float coneTerm = 1.0;
    if (kind > 1.5) {
        vec3 sDir = l_cone.xyz;
        float sLen = length(sDir);
        if (sLen > 1e-5) sDir /= sLen; else sDir = vec3(0.0, 0.0, -1.0);
        float cosAngle = -dot(dir, sDir);
        float cosCone = l_cone.w;
        float cosOuter = l_edge;
        if (cosAngle <= cosOuter) {
            coneTerm = 0.0;
        } else if (cosAngle >= cosCone) {
            coneTerm = 1.0;
        } else {
            float t = clamp((cosAngle - cosOuter) / max(1e-6, cosCone - cosOuter), 0.0, 1.0);
            coneTerm = t * t * (3.0 - 2.0 * t);
        }
    }

    float vTerm = 1.0 - l_mask * (1.0 - vis);
    return l_col.rgb * (ndl * att * coneTerm * vTerm);
}

vec4 shade(vec4 c, vec2 uv) {
    vec2 pp = pictureUv(uv) * u_pictureSize;
    vec2 mpx = vec2(dot(u_m0.xy, pp) + u_m1.x, dot(u_m0.zw, pp) + u_m1.y);

    float far = snapField(u_map, u_guide, mpx, c.rgb, u_snap);
    vec2 suv_map = mpx / vec2(textureSize(u_normals, 0));

    vec4 nTex = texture(u_normals, suv_map);
    vec4 vTex = texture(u_vis, suv_map);

    if (u_snap.x > 0.0) {
        vec2 q = mpx - 0.5;
        ivec2 i0 = ivec2(floor(q));
        float lo = 1.0, hi = 0.0;
        for (int j = -1; j <= 2; j++) {
            for (int i = -1; i <= 2; i++) {
                float d = u16At(u_map, i0 + ivec2(i, j));
                lo = min(lo, d);
                hi = max(hi, d);
            }
        }
        float k = w_sstep(u_snap.y, 2.0 * u_snap.y, hi - lo);
        if (k > 0.0) {
            float sw = 0.0;
            vec4 sdN = vec4(0.0);
            vec4 sdV = vec4(0.0);
            float inv = 0.5 / (u_snap.x * u_snap.x);
            for (int j = -1; j <= 2; j++) {
                for (int i = -1; i <= 2; i++) {
                    ivec2 p = i0 + ivec2(i, j);
                    vec2 dd = vec2(p) - q;
                    vec3 e = c.rgb - snapRgb(u_guide, p);
                    float w = exp(-0.5 * dot(dd, dd)) * exp(-dot(e, e) * inv);
                    sw += w;
                    ivec2 clp = clamp(p, ivec2(0), textureSize(u_normals, 0) - 1);
                    sdN += w * texelFetch(u_normals, clp, 0);
                    sdV += w * texelFetch(u_vis, clp, 0);
                }
            }
            if (sw > 1e-6) {
                nTex = mix(nTex, sdN / sw, k);
                vTex = mix(vTex, sdV / sw, k);
            }
        }
    }

    vec3 nRaw = (nTex.xyz - 0.5) * 2.0;
    float nLen = length(nRaw);
    vec3 normal = nLen > 1e-5 ? nRaw / nLen : vec3(0.0, 0.0, 1.0);
    vec4 vis = vTex;
    vec3 mpos = vec3(mpx.x, mpx.y, far * u_depth_scale);

    vec3 pLin = rl_srgbToLinear(c.rgb);

    vec3 l0 = u_fit.xyz;
    float ka = u_fit.w;
    float kd = u_kd;
    float dotL0 = max(0.0, dot(normal, l0));
    float sFit = max(0.1, ka + kd * dotL0);

    float gain = min(u_recover, 1.0 / sFit);
    float pLuma = dot(pLin, vec3(0.2126, 0.7152, 0.0722));
    if (pLuma < 0.03) {
        float fade = clamp((pLuma - 0.005) / 0.025, 0.0, 1.0);
        gain = 1.0 + (gain - 1.0) * fade;
    }
    vec3 fLin = pLin * gain;

    vec3 lsum = vec3(0.0);
    lsum += rl_evalLight(u_l0_pos, u_l0_col, u_l0_cone, u_l0_edge, u_lkind.x, u_lmask.x, vis.r, normal, mpos);
    lsum += rl_evalLight(u_l1_pos, u_l1_col, u_l1_cone, u_l1_edge, u_lkind.y, u_lmask.y, vis.g, normal, mpos);
    lsum += rl_evalLight(u_l2_pos, u_l2_col, u_l2_cone, u_l2_edge, u_lkind.z, u_lmask.z, vis.b, normal, mpos);
    lsum += rl_evalLight(u_l3_pos, u_l3_col, u_l3_cone, u_l3_edge, u_lkind.w, u_lmask.w, vis.a, normal, mpos);

    if (u_mode == 1) {
        vec3 lm = lsum + vec3(u_ambient);
        return vec4(rl_linearToSrgb(lm), c.a);
    }

    if (u_original >= 0.999 && dot(lsum, vec3(1.0)) <= 1e-5) {
        return c;
    }

    vec3 term = vec3(u_original * sFit + (1.0 - u_original) * u_ambient) + lsum;
    vec3 outLin = fLin * term;

    outLin.r = rl_rolloff(outLin.r);
    outLin.g = rl_rolloff(outLin.g);
    outLin.b = rl_rolloff(outLin.b);

    return vec4(rl_linearToSrgb(outLin), c.a);
}
`;

let relightRegistered = false;

export function registerRelightGL() {
    if (relightRegistered) return;
    registerGLFilter("relight", {
        uniforms: {
            u_map: "sampler2D",
            u_guide: "sampler2D",
            u_m0: "vec4",
            u_m1: "vec2",
            u_snap: "vec2",
            u_normals: "sampler2D",
            u_vis: "sampler2D",
            u_fit: "vec4",
            u_kd: "float",
            u_l0_pos: "vec4",
            u_l1_pos: "vec4",
            u_l2_pos: "vec4",
            u_l3_pos: "vec4",
            u_l0_col: "vec4",
            u_l1_col: "vec4",
            u_l2_col: "vec4",
            u_l3_col: "vec4",
            u_l0_cone: "vec4",
            u_l1_cone: "vec4",
            u_l2_cone: "vec4",
            u_l3_cone: "vec4",
            u_l0_edge: "float",
            u_l1_edge: "float",
            u_l2_edge: "float",
            u_l3_edge: "float",
            u_lkind: "vec4",
            u_lmask: "vec4",
            u_original: "float",
            u_ambient: "float",
            u_recover: "float",
            u_depth_scale: "float",
            u_mode: "int",
        },
        code: RELIGHT_GLSL,
        values: (params, info) => {
            const map = (info && info.maps && info.maps.depth) || null;
            const scale = (info && info.scale) || 1;
            const m = map ? passToMap(map, scale) : [1, 0, 0, 1, 0, 0];
            const snap = (map && map.guide) ? (snapParams(map.meta?.snap?.strength) || [0, 0]) : [0, 0];
            const p = params || {};
            const cache = info.relight || info.layer?._relight || null;

            const normalsSampler = (cache && cache.normals && cache.normals.data) ? {
                data: cache.normals.data,
                width: cache.normals.w,
                height: cache.normals.h,
                channels: 4,
                linear: true,
                static: true,
                key: "relight:n:" + (cache.normals.key || cache.key || 0),
            } : DUMMY_NORMALS;

            const visSampler = (cache && cache.vis && cache.vis.data) ? {
                data: cache.vis.data,
                width: cache.vis.w,
                height: cache.vis.h,
                channels: 4,
                linear: true,
                static: true,
                key: "relight:v:" + (cache.vis.keys ? cache.vis.keys.join("_") : (cache.key || 0)),
            } : DUMMY_VIS;

            const fit = (info && (info.wholeStats?.fit || info.stats?.fit || cache?.fit)) || { l0: [0, 0, 1], ka: 1.0, kd: 0.0 };
            const depthScale = Number.isFinite(p.depth_scale) ? Number(p.depth_scale) : 50;
            const depthScaleMap = (depthScale / 100.0) * (map ? Math.max(map.w, map.h) : 1024);

            const lightsList = Array.isArray(p.lights) ? p.lights : [];
            const lPositions = [];
            const lColors = [];
            const lCones = [];
            const lEdges = [];
            const lKinds = [0, 0, 0, 0];
            const lMasks = [0, 0, 0, 0];

            for (let i = 0; i < 4; i++) {
                const l = lightsList[i];
                if (l && l.on) {
                    const lm = lightToMap(l, map, { depth_scale: depthScale });
                    const lx = lm.mx, ly = lm.my, lz = lm.mz;
                    const rInMap = lm.rangeInMapPixels;
                    lPositions.push([lx, ly, lz, rInMap]);

                    const rgbLin = kelvinToRgb(l.color);
                    const intensity = (Number.isFinite(l.intensity) ? Number(l.intensity) : 100) / 100.0;
                    const diffusion = (Number.isFinite(l.diffusion) ? Number(l.diffusion) : 30) / 100.0;
                    lColors.push([rgbLin[0] * intensity, rgbLin[1] * intensity, rgbLin[2] * intensity, diffusion]);

                    if (l.type === "spot" && lm.aim) {
                        const aimDx = lm.aim[0] - lx;
                        const aimDy = lm.aim[1] - ly;
                        const aimDz = (lm.aim[2] || 0) - lz;
                        const aimLen = Math.hypot(aimDx, aimDy, aimDz) || 1.0;
                        const sDir = [aimDx / aimLen, aimDy / aimLen, aimDz / aimLen];
                        const coneRad = ((Number.isFinite(l.cone) ? Number(l.cone) : 30) * Math.PI) / 180.0;
                        const cosCone = Math.cos(coneRad);
                        const edgeSoftness = (Number.isFinite(l.edge) ? Number(l.edge) : 20) / 100.0;
                        const cosOuter = cosCone - edgeSoftness * (1.0 - cosCone);
                        lCones.push([sDir[0], sDir[1], sDir[2], cosCone]);
                        lEdges.push(cosOuter);
                    } else {
                        lCones.push([0, 0, 1, 1]);
                        lEdges.push(0);
                    }

                    lKinds[i] = l.type === "sun" ? 1.0 : (l.type === "spot" ? 2.0 : 0.0);
                    const shadowsStrength = (Number.isFinite(p.shadows) ? Number(p.shadows) : 60) / 100.0;
                    lMasks[i] = shadowsStrength;
                } else {
                    lPositions.push([0, 0, 0, 1]);
                    lColors.push([0, 0, 0, 0]);
                    lCones.push([0, 0, 1, 1]);
                    lEdges.push(0);
                    lKinds[i] = 0;
                    lMasks[i] = 0;
                }
            }

            const origPct = Number.isFinite(p.original) ? Number(p.original) : 100;
            const ambientPct = Number.isFinite(p.ambient) ? Number(p.ambient) : 15;
            const recoverVal = Number.isFinite(p.recover) ? Number(p.recover) : 3.0;

            return {
                u_map: map ? rg8View(map) : DUMMY_RG8,
                u_guide: (map && map.guide) ? guideView(map) : DUMMY_RGBA8,
                u_m0: [m[0], m[2], m[1], m[3]],
                u_m1: [m[4], m[5]],
                u_snap: snap,
                u_normals: normalsSampler,
                u_vis: visSampler,
                u_fit: [fit.l0[0], fit.l0[1], fit.l0[2], fit.ka],
                u_kd: fit.kd,
                u_l0_pos: lPositions[0],
                u_l1_pos: lPositions[1],
                u_l2_pos: lPositions[2],
                u_l3_pos: lPositions[3],
                u_l0_col: lColors[0],
                u_l1_col: lColors[1],
                u_l2_col: lColors[2],
                u_l3_col: lColors[3],
                u_l0_cone: lCones[0],
                u_l1_cone: lCones[1],
                u_l2_cone: lCones[2],
                u_l3_cone: lCones[3],
                u_l0_edge: lEdges[0],
                u_l1_edge: lEdges[1],
                u_l2_edge: lEdges[2],
                u_l3_edge: lEdges[3],
                u_lkind: lKinds,
                u_lmask: lMasks,
                u_original: origPct / 100.0,
                u_ambient: ambientPct / 100.0,
                u_recover: recoverVal,
                u_depth_scale: depthScaleMap,
                u_mode: p.mode === 1 ? 1 : 0,
            };
        },
        skip: (p, info) => !(info && info.maps && info.maps.depth) || (p?.mode !== 1 && (!p?.lights || p.lights.every((l) => !l || !l.on)) && (p?.original === undefined || Number(p.original) === 100)),
    });
    relightRegistered = true;
}

