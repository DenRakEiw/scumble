// @ts-check
// Effects pack: Chromatic shift filter.
// Three dispersion styles: Plates (120 deg apart), Lateral (centre out), Linear (opposite along an angle).

import {
    num, pct, clamp01, bilinAt, resolve, makeCanvas, makeRunner, shader,
} from "./common.js";

const CHROMATIC_SHADER = shader("chromatic shift", {
    u_style: "int",
    u_amount: "float",
    u_strength: "float",
    u_oR: "vec2",
    u_oG: "vec2",
    u_oB: "vec2",
}, `
vec4 shade(vec4 c, vec2 uv) {
    vec2 p = uv * u_size;
    vec2 oR, oG, oB;
    if (u_style == 0) {
        oR = u_oR;
        oG = u_oG;
        oB = u_oB;
    } else if (u_style == 1) {
        vec2 d = (pictureUv(uv) - 0.5) * u_pictureSize;
        float L = 0.5 * length(u_pictureSize);
        oR = L > 0.0 ? (d / L) * u_amount * u_scale : vec2(0.0);
        oG = vec2(0.0);
        oB = -oR;
    } else {
        oR = u_oR;
        oG = vec2(0.0);
        oB = -u_oR;
    }
    vec3 o = vec3(bilin(p + oR).r, bilin(p + oG).g, bilin(p + oB).b);
    return vec4(mix(c.rgb, o, u_strength), c.a);
}
`);

export function offsets(p, scale = 1, x, y, pw, ph) {
    const amount = num(p && p.amount, 6);
    const scaledAmount = amount * scale;
    const angle = num(p && p.angle, 30);
    const style = (p && p.style) || "plates";

    if (style === "lateral") {
        if (x == null || y == null) {
            return { oR: [0, 0], oG: [0, 0], oB: [0, 0] };
        }
        let dx, dy, L;
        if (pw != null && ph != null) {
            dx = x - pw * 0.5;
            dy = y - ph * 0.5;
            L = 0.5 * Math.hypot(pw, ph);
        } else {
            dx = x - 0.5;
            dy = y - 0.5;
            L = 0.5 * Math.SQRT2;
        }
        const k = L > 0 ? scaledAmount / L : 0;
        const oR = [dx * k, dy * k];
        const oG = [0, 0];
        const oB = [-oR[0], -oR[1]];
        return { oR, oG, oB };
    }

    const rad = (angle * Math.PI) / 180;
    if (style === "linear") {
        const dir = [scaledAmount * Math.cos(rad), scaledAmount * Math.sin(rad)];
        return {
            oR: dir,
            oG: [0, 0],
            oB: [-dir[0], -dir[1]],
        };
    }

    // Default: plates (120 deg apart)
    const radG = ((angle + 120) * Math.PI) / 180;
    const radB = ((angle + 240) * Math.PI) / 180;
    return {
        oR: [scaledAmount * Math.cos(rad), scaledAmount * Math.sin(rad)],
        oG: [scaledAmount * Math.cos(radG), scaledAmount * Math.sin(radG)],
        oB: [scaledAmount * Math.cos(radB), scaledAmount * Math.sin(radB)],
    };
}

export function applyChromaticShift(src, p, info) {
    const amount = num(p && p.amount, 6);
    const strength = pct(p && p.strength, 100);
    const scale = (info && info.scale) || 1;
    if (amount <= 0 || strength <= 0) return resolve(src);

    const srcCanvas = resolve(src);
    const W = srcCanvas.width, H = srcCanvas.height;
    const sctx = srcCanvas.getContext("2d");
    const srcData = sctx.getImageData(0, 0, W, H).data;

    const out = makeCanvas(W, H);
    const outCtx = out.getContext("2d");
    const outImg = outCtx.createImageData(W, H);
    const dstData = outImg.data;

    const style = (p && p.style) || "plates";
    const scaledAmount = amount * scale;

    let oR_fixed = [0, 0], oG_fixed = [0, 0], oB_fixed = [0, 0];
    if (style !== "lateral") {
        const off = offsets(p, scale);
        oR_fixed = off.oR;
        oG_fixed = off.oG;
        oB_fixed = off.oB;
    }

    const PW = (info && info.full && info.full[0]) || W;
    const PH = (info && info.full && info.full[1]) || H;
    const ox = (info && info.origin && info.origin[0]) || 0;
    const oy = (info && info.origin && info.origin[1]) || 0;
    const L = 0.5 * Math.hypot(PW, PH);
    const latK = L > 0 ? scaledAmount / L : 0;

    for (let y = 0; y < H; y++) {
        const picY = oy + y + 0.5;
        const dy = picY - PH * 0.5;
        for (let x = 0; x < W; x++) {
            let oR, oG, oB;
            if (style === "lateral") {
                const picX = ox + x + 0.5;
                const dx = picX - PW * 0.5;
                const rx = dx * latK;
                const ry = dy * latK;
                oR = [rx, ry];
                oG = [0, 0];
                oB = [-rx, -ry];
            } else {
                oR = oR_fixed;
                oG = oG_fixed;
                oB = oB_fixed;
            }

            const sR = bilinAt(srcData, W, H, x + oR[0], y + oR[1]);
            const sG = bilinAt(srcData, W, H, x + oG[0], y + oG[1]);
            const sB = bilinAt(srcData, W, H, x + oB[0], y + oB[1]);

            const idx = (y * W + x) * 4;
            const cR = srcData[idx] / 255;
            const cG = srcData[idx + 1] / 255;
            const cB = srcData[idx + 2] / 255;

            const tR = sR[0];
            const tG = sG[1];
            const tB = sB[2];

            dstData[idx] = Math.round(clamp01(cR + (tR - cR) * strength) * 255);
            dstData[idx + 1] = Math.round(clamp01(cG + (tG - cG) * strength) * 255);
            dstData[idx + 2] = Math.round(clamp01(cB + (tB - cB) * strength) * 255);
            dstData[idx + 3] = srcData[idx + 3];
        }
    }

    outCtx.putImageData(outImg, 0, 0);
    return out;
}

export function makeChromaticShift(scumble) {
    const run = makeRunner(scumble);

    const filter = {
        id: "chromatic_shift",
        label: "Chromatic shift",
        params: [
            {
                key: "style",
                label: "Style",
                type: "select",
                default: "plates",
                options: [
                    { id: "plates", label: "Plates (120\u00B0)" },
                    { id: "lateral", label: "Lateral" },
                    { id: "linear", label: "Linear" },
                ],
            },
            {
                key: "amount",
                label: "Shift",
                type: "number",
                min: 0,
                max: 60,
                step: 1,
                default: 6,
                unit: "px",
            },
            {
                key: "angle",
                label: "Angle",
                type: "number",
                min: -180,
                max: 180,
                step: 1,
                default: 30,
                unit: "\u00B0",
            },
            {
                key: "strength",
                label: "Strength",
                type: "number",
                min: 0,
                max: 100,
                step: 1,
                default: 100,
                unit: "%",
            },
        ],
        reach: (p) => (num(p.amount, 6) > 0 && pct(p.strength, 100) > 0 ? Math.ceil(num(p.amount, 6)) + 2 : 0),
        skip: (p) => num(p.amount, 6) <= 0 || pct(p.strength, 100) <= 0,
        apply: (src, p, info) => {
            const amount = num(p && p.amount, 6);
            const strength = pct(p && p.strength, 100);
            if (amount <= 0 || strength <= 0) return src;
            const scale = (info && info.scale) || 1;
            const style = (p && p.style) || "plates";
            const styleId = style === "lateral" ? 1 : style === "linear" ? 2 : 0;
            const off = offsets(p, scale);
            return run(CHROMATIC_SHADER, src, {
                u_style: styleId,
                u_amount: amount,
                u_strength: strength,
                u_oR: off.oR,
                u_oG: off.oG,
                u_oB: off.oB,
            }, info, () => applyChromaticShift(src, p, info));
        },
    };

    return { filter };
}
