// @ts-check
// Effects pack: Glass displacement filter.
// Styles: ribbed, reeded, wavy, blocks, frosted, pebbled.

import {
    num, pct, clamp01, screen, sstep, hash2, fbm, blur, bilinAt, resolve, makeCanvas, makeRunner, shader,
} from "./common.js";

export const STYLES = ["ribbed", "reeded", "wavy", "blocks", "frosted", "pebbled"];

const GLASS_SHADER = shader("glass", {
    u_style: "int",
    u_glassSize: "float",
    u_amount: "float",
    u_angle: "float",
    u_sheen: "float",
    u_glassSeed: "int",
}, `
const vec3 L = normalize(vec3(-1.0, -1.0, 0.75));

vec2 glassField(vec2 P) {
    float size = max(4.0, u_glassSize);
    float rad = radians(u_angle);
    vec2 dir = vec2(cos(rad), sin(rad));
    if (u_style == 0) {
        float s = dot(P, dir) / size;
        return sin(6.283185307179586 * s) * dir;
    } else if (u_style == 1) {
        float s = dot(P, dir) / size;
        float fractS = s - floor(s);
        return (2.0 * fractS - 1.0) * dir;
    } else if (u_style == 2) {
        float cosA = cos(rad);
        float sinA = sin(rad);
        vec2 rP = vec2(P.x * cosA + P.y * sinA, -P.x * sinA + P.y * cosA);
        vec2 d0 = vec2(sin(6.283185307179586 * rP.y / size), sin(6.283185307179586 * rP.x / size));
        return vec2(d0.x * cosA - d0.y * sinA, d0.x * sinA + d0.y * cosA) * 0.7071;
    } else if (u_style == 3) {
        float cosA = cos(rad);
        float sinA = sin(rad);
        vec2 rP = vec2(P.x * cosA + P.y * sinA, -P.x * sinA + P.y * cosA);
        ivec2 cell = ivec2(floor(rP / size));
        float h1 = hash2(cell.x, cell.y, u_glassSeed);
        float h2 = hash2(cell.x + 17, cell.y + 31, u_glassSeed);
        return vec2(2.0 * h1 - 1.0, 2.0 * h2 - 1.0) * 0.7071;
    } else if (u_style == 4) {
        float cosA = cos(rad);
        float sinA = sin(rad);
        vec2 rP = vec2(P.x * cosA + P.y * sinA, -P.x * sinA + P.y * cosA);
        vec2 p0 = rP / size;
        float fx = 2.0 * fbm(p0, u_glassSeed) - 1.0;
        float fy = 2.0 * fbm(p0 + vec2(17.3, 17.3), u_glassSeed + 1) - 1.0;
        vec2 d0 = vec2(fx * cosA - fy * sinA, fx * sinA + fy * cosA);
        float len = length(d0);
        return len > 1.0 ? d0 / len : d0;
    } else if (u_style == 5) {
        float cosA = cos(rad);
        float sinA = sin(rad);
        vec2 rP = vec2(P.x * cosA + P.y * sinA, -P.x * sinA + P.y * cosA);
        ivec2 cell = ivec2(floor(rP / size));
        vec2 bestF = vec2(0.0);
        float bestD2 = 1e20;
        for (int dj = -1; dj <= 1; dj++) {
            for (int di = -1; di <= 1; di++) {
                ivec2 c = cell + ivec2(di, dj);
                float jx = 0.15 + 0.70 * hash2(c.x, c.y, u_glassSeed);
                float jy = 0.15 + 0.70 * hash2(c.x + 31, c.y + 17, u_glassSeed);
                vec2 pt = (vec2(c) + vec2(jx, jy)) * size;
                vec2 diff = rP - pt;
                float d2 = dot(diff, diff);
                if (d2 < bestD2) {
                    bestD2 = d2;
                    bestF = pt;
                }
            }
        }
        vec2 diff = (rP - bestF) / (0.7 * size);
        float len = length(diff);
        vec2 d0 = len > 1.0 ? diff / len : diff;
        return vec2(d0.x * cosA - d0.y * sinA, d0.x * sinA + d0.y * cosA);
    }
    return vec2(0.0);
}

vec4 shade(vec4 c, vec2 uv) {
    vec2 p = uv * u_size;
    vec2 P = (u_pictureOrigin + p) / u_scale;
    vec2 d_unit = glassField(P);
    vec2 d = d_unit * u_amount * u_scale;
    vec4 o = bilin(p + d);
    if (u_sheen > 0.0) {
        vec3 N = normalize(vec3(-d_unit, 1.0));
        float k = sstep(0.55, 1.0, dot(N, L)) * u_sheen;
        o = vec4(screen3(o.rgb, vec3(k)), o.a);
    }
    return o;
}
`);

const L_LEN = Math.hypot(-1.0, -1.0, 0.75);
const LX = -1.0 / L_LEN;
const LY = -1.0 / L_LEN;
const LZ = 0.75 / L_LEN;

/**
 * Compute normalized glass displacement vector [dx, dy] with |d| <= 1.
 * Px, Py are continuous image pixels of the full unscaled picture.
 */
export function glassField(style, Px, Py, size = 40, angle = 0, seed = 0) {
    const sSize = Math.max(4, size);
    const rad = (angle * Math.PI) / 180;
    const dirX = Math.cos(rad);
    const dirY = Math.sin(rad);

    if (style === "reeded") {
        const s = (Px * dirX + Py * dirY) / sSize;
        const fractS = s - Math.floor(s);
        const val = 2 * fractS - 1;
        return [val * dirX, val * dirY];
    }

    if (style === "wavy") {
        const cosA = Math.cos(rad);
        const sinA = Math.sin(rad);
        const rx = Px * cosA + Py * sinA;
        const ry = -Px * sinA + Py * cosA;
        const dx0 = Math.sin((2 * Math.PI * ry) / sSize);
        const dy0 = Math.sin((2 * Math.PI * rx) / sSize);
        return [
            (dx0 * cosA - dy0 * sinA) * 0.7071,
            (dx0 * sinA + dy0 * cosA) * 0.7071,
        ];
    }

    if (style === "blocks") {
        const cosA = Math.cos(rad);
        const sinA = Math.sin(rad);
        const rx = Px * cosA + Py * sinA;
        const ry = -Px * sinA + Py * cosA;
        const cellX = Math.floor(rx / sSize);
        const cellY = Math.floor(ry / sSize);
        const h1 = hash2(cellX, cellY, seed);
        const h2 = hash2(cellX + 17, cellY + 31, seed);
        return [
            (2 * h1 - 1) * 0.7071,
            (2 * h2 - 1) * 0.7071,
        ];
    }

    if (style === "frosted") {
        const cosA = Math.cos(rad);
        const sinA = Math.sin(rad);
        const rx = Px * cosA + Py * sinA;
        const ry = -Px * sinA + Py * cosA;
        const p0x = rx / sSize;
        const p0y = ry / sSize;
        const fx = 2 * fbm(p0x, p0y, seed) - 1;
        const fy = 2 * fbm(p0x + 17.3, p0y + 17.3, seed + 1) - 1;
        const dx = fx * cosA - fy * sinA;
        const dy = fx * sinA + fy * cosA;
        const len = Math.hypot(dx, dy);
        if (len > 1) return [dx / len, dy / len];
        return [dx, dy];
    }

    if (style === "pebbled") {
        const cosA = Math.cos(rad);
        const sinA = Math.sin(rad);
        const rx = Px * cosA + Py * sinA;
        const ry = -Px * sinA + Py * cosA;
        const cellX = Math.floor(rx / sSize);
        const cellY = Math.floor(ry / sSize);
        let bestFx = 0, bestFy = 0;
        let bestD2 = Infinity;
        for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
                const cx = cellX + di;
                const cy = cellY + dj;
                const jx = 0.15 + 0.70 * hash2(cx, cy, seed);
                const jy = 0.15 + 0.70 * hash2(cx + 31, cy + 17, seed);
                const ptx = (cx + jx) * sSize;
                const pty = (cy + jy) * sSize;
                const diffX = rx - ptx;
                const diffY = ry - pty;
                const d2 = diffX * diffX + diffY * diffY;
                if (d2 < bestD2) {
                    bestD2 = d2;
                    bestFx = ptx;
                    bestFy = pty;
                }
            }
        }
        let d0x = (rx - bestFx) / (0.7 * sSize);
        let d0y = (ry - bestFy) / (0.7 * sSize);
        const len = Math.hypot(d0x, d0y);
        if (len > 1) {
            d0x /= len;
            d0y /= len;
        }
        return [
            d0x * cosA - d0y * sinA,
            d0x * sinA + d0y * cosA,
        ];
    }

    // Default: ribbed
    const s = (Px * dirX + Py * dirY) / sSize;
    const sinS = Math.sin((2 * Math.PI * s));
    return [sinS * dirX, sinS * dirY];
}

/**
 * CPU twin for Glass filter.
 */
export function applyGlass(src, p, info) {
    const amount = num(p && p.amount, 12);
    const sheen = pct(p && p.sheen, 15);
    const style = (p && p.style) || "ribbed";
    const size = Math.max(4, num(p && p.size, 40));
    const angle = num(p && p.angle, 0);
    const seed = Math.max(0, Math.min(99, Math.round(num(p && p.seed, 0))));
    const frost = num(p && p.frost, 0);

    if (amount <= 0 && sheen <= 0 && frost <= 0) return resolve(src);

    const scale = (info && info.scale) || 1;
    const frostPx = frost * scale;
    const workingSrc = frostPx > 0.05 ? blur(src, frostPx) : src;

    if (amount <= 0 && sheen <= 0) return resolve(workingSrc);

    const srcCanvas = resolve(workingSrc);
    const W = srcCanvas.width, H = srcCanvas.height;
    const sctx = srcCanvas.getContext("2d");
    const srcData = sctx.getImageData(0, 0, W, H).data;

    const out = makeCanvas(W, H);
    const outCtx = out.getContext("2d");
    const outImg = outCtx.createImageData(W, H);
    const dstData = outImg.data;

    const ox = (info && info.origin && info.origin[0]) || 0;
    const oy = (info && info.origin && info.origin[1]) || 0;

    for (let y = 0; y < H; y++) {
        const picY = (oy + y + 0.5) / scale;
        for (let x = 0; x < W; x++) {
            const picX = (ox + x + 0.5) / scale;
            const [duX, duY] = glassField(style, picX, picY, size, angle, seed);
            const dx = duX * amount * scale;
            const dy = duY * amount * scale;

            const sPix = bilinAt(srcData, W, H, x + dx, y + dy);

            let r = sPix[0];
            let g = sPix[1];
            let b = sPix[2];
            const a = sPix[3];

            if (sheen > 0) {
                const nLen = Math.hypot(-duX, -duY, 1.0);
                const nx = -duX / nLen;
                const ny = -duY / nLen;
                const nz = 1.0 / nLen;
                const dot = nx * LX + ny * LY + nz * LZ;
                const k = sstep(0.55, 1.0, dot) * sheen;
                r = screen(r, k);
                g = screen(g, k);
                b = screen(b, k);
            }

            const idx = (y * W + x) * 4;
            dstData[idx] = Math.round(clamp01(r) * 255);
            dstData[idx + 1] = Math.round(clamp01(g) * 255);
            dstData[idx + 2] = Math.round(clamp01(b) * 255);
            dstData[idx + 3] = Math.round(clamp01(a) * 255);
        }
    }

    outCtx.putImageData(outImg, 0, 0);
    return out;
}

export function makeGlass(scumble) {
    const run = makeRunner(scumble);

    const filter = {
        id: "glass",
        label: "Glass",
        params: [
            {
                key: "style",
                label: "Style",
                type: "select",
                default: "ribbed",
                options: [
                    { id: "ribbed", label: "Ribbed" },
                    { id: "reeded", label: "Reeded" },
                    { id: "wavy", label: "Wavy" },
                    { id: "blocks", label: "Blocks" },
                    { id: "frosted", label: "Frosted" },
                    { id: "pebbled", label: "Pebbled" },
                ],
            },
            {
                key: "size",
                label: "Size",
                type: "number",
                min: 4,
                max: 400,
                step: 1,
                default: 40,
                unit: "px",
            },
            {
                key: "amount",
                label: "Displacement",
                type: "number",
                min: 0,
                max: 100,
                step: 1,
                default: 12,
                unit: "px",
            },
            {
                key: "frost",
                label: "Frost",
                type: "number",
                min: 0,
                max: 20,
                step: 1,
                default: 0,
                unit: "px",
            },
            {
                key: "angle",
                label: "Angle",
                type: "number",
                min: -90,
                max: 90,
                step: 1,
                default: 0,
                unit: "\u00B0",
            },
            {
                key: "sheen",
                label: "Sheen",
                type: "number",
                min: 0,
                max: 100,
                step: 1,
                default: 15,
                unit: "%",
            },
            {
                key: "seed",
                label: "Variant",
                type: "number",
                min: 0,
                max: 99,
                step: 1,
                default: 0,
            },
        ],
        reach: (p) => (num(p && p.amount, 12) > 0 ? Math.ceil(num(p && p.amount, 12)) + 2 : 0) +
                      (num(p && p.frost, 0) > 0 ? Math.ceil(3 * num(p && p.frost, 0)) + 2 : 0),
        skip: (p) => num(p && p.amount, 12) <= 0 && pct(p && p.sheen, 15) <= 0 && num(p && p.frost, 0) <= 0,
        apply: (src, p, info) => {
            const amount = num(p && p.amount, 12);
            const sheen = pct(p && p.sheen, 15);
            const frost = num(p && p.frost, 0);
            if (amount <= 0 && sheen <= 0 && frost <= 0) return src;

            const scale = (info && info.scale) || 1;
            const frostPx = frost * scale;
            const workingSrc = frostPx > 0.05 ? blur(src, frostPx) : src;
            if (amount <= 0 && sheen <= 0) return workingSrc;

            const style = (p && p.style) || "ribbed";
            const styleId = style === "reeded" ? 1 : style === "wavy" ? 2 : style === "blocks" ? 3 : style === "frosted" ? 4 : style === "pebbled" ? 5 : 0;
            const size = Math.max(4, num(p && p.size, 40));
            const angle = num(p && p.angle, 0);
            const seed = Math.max(0, Math.min(99, Math.round(num(p && p.seed, 0))));

            return run(GLASS_SHADER, workingSrc, {
                u_style: styleId,
                u_glassSize: size,
                u_amount: amount,
                u_angle: angle,
                u_sheen: sheen,
                u_glassSeed: seed,
            }, info, () => applyGlass(workingSrc, { ...p, frost: 0 }, info));
        },
    };

    return { filter };
}
