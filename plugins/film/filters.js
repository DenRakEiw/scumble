// Film pack: the filter types. Each one has a GLSL path and a CPU path with the same maths
// (common.js holds the shared formulas). Point operations declare a `glsl` block and let the
// app pick the path; filters that need a blur between stages (halation, glow, tonal contrast,
// structure, black & white, the film look's halation and grain) orchestrate their passes in
// `apply` through the runner: shader when the GPU is there, pixel loop otherwise.

import {
    PRELUDE, LR, LG, LB, luma, clamp01, screen, softlight, sstep, mix, hueRgb, vnoise, hash2,
    makeCanvas, copyCanvas, loop, blur, table, tablesTexture, lookup, monotone, toneCurve,
    num, pct, TRADEMARK, makeRunner, shader,
} from "./common.js";
import {
    STOCK_BY_ID, STOCK_OPTIONS, BW_FILTERS, TONERS, TONER_BY_ID, XPRO_STYLES, XPRO_BY_ID,
    LEAK_STYLES, FRAME_STYLES, FRAME_COLOURS, FRAME_COLOUR_BY_ID,
} from "./looks.js";

// ---- shaders (module constants: one compiled program each) ------------------------------------

const LOOK = shader("film look", { u_exp: "float", u_mixR: "vec3", u_mixG: "vec3", u_mixB: "vec3", u_mono: "bool", u_monoW: "vec3", u_wb: "vec3", u_sat: "float", u_tone: "sampler2D", u_strength: "float" }, `
vec4 shade(vec4 c, vec2 uv) {
    vec3 o = c.rgb * u_exp;
    o = vec3(dot(u_mixR, o), dot(u_mixG, o), dot(u_mixB, o));
    if (u_mono) { float l = dot(u_monoW, o); o = vec3(l); }
    o *= u_wb;
    if (!u_mono) { float l = luma(o); o = l + (o - l) * u_sat; }
    o = tab3(u_tone, sat3(o));
    return vec4(mix(c.rgb, o, u_strength), c.a);
}`);

const EXTRACT = shader("highlights", { u_thr: "float" }, `
vec4 shade(vec4 c, vec2 uv) { float h = sstep(u_thr, 1.0, luma(c.rgb)); return vec4(c.rgb * h, 1.0); }`);

const HALATION = shader("halation", { u_blur: "sampler2D", u_tint: "vec3", u_strength: "float" }, `
vec4 shade(vec4 c, vec2 uv) {
    vec3 g = texture(u_blur, uv).rgb * u_tint * u_strength;
    return vec4(screen3(c.rgb, sat3(g)), c.a);
}`);

const GLOW = shader("glow", { u_blur: "sampler2D", u_amount: "float", u_mode: "int" }, `
vec4 shade(vec4 c, vec2 uv) {
    vec3 b = texture(u_blur, uv).rgb;
    vec3 r = u_mode == 0 ? softlight3(c.rgb, b) : u_mode == 1 ? screen3(c.rgb, b) : max(c.rgb, b);
    return vec4(mix(c.rgb, r, u_amount), c.a);
}`);

const TONAL = shader("tonal contrast", { u_blur: "sampler2D", u_h: "float", u_m: "float", u_s: "float", u_sat: "float", u_protect: "float" }, `
vec4 shade(vec4 c, vec2 uv) {
    vec3 b = texture(u_blur, uv).rgb;
    float L = luma(c.rgb), Lb = luma(b);
    float ws = 1.0 - sstep(0.0, 0.5, Lb), wh = sstep(0.5, 1.0, Lb), wm = 1.0 - abs(2.0 * Lb - 1.0);
    float gain = 1.0 + 2.0 * (u_s * ws + u_m * wm + u_h * wh);
    float Ln = Lb + (L - Lb) * gain;
    Ln = mix(Ln, L, u_protect * (1.0 - 4.0 * L * (1.0 - L)));
    vec3 o = L > 0.002 ? c.rgb * (Ln / L) : c.rgb + (Ln - L);
    o = sat3(o);
    float l2 = luma(o);
    o = l2 + (o - l2) * (1.0 + u_sat);
    return vec4(sat3(o), c.a);
}`);

const STRUCTURE = shader("structure", { u_blur: "sampler2D", u_amount: "float", u_lum: "bool" }, `
vec4 shade(vec4 c, vec2 uv) {
    vec3 b = texture(u_blur, uv).rgb;
    vec3 o;
    if (u_amount >= 0.0) {
        if (u_lum) { float dL = luma(c.rgb) - luma(b); o = c.rgb + dL * u_amount * 2.0; }
        else o = c.rgb + (c.rgb - b) * u_amount * 2.0;
    } else o = mix(c.rgb, b, -u_amount);
    return vec4(sat3(o), c.a);
}`);

const BW = shader("black and white", { u_blur: "sampler2D", u_useBlur: "bool", u_w: "vec3", u_structure: "float", u_shadows: "float", u_highlights: "float", u_bright: "float", u_contrast: "float", u_toneOn: "bool", u_hi: "vec3", u_sh: "vec3" }, `
vec4 shade(vec4 c, vec2 uv) {
    float L = dot(u_w, c.rgb);
    if (u_useBlur) { float Lb = dot(u_w, texture(u_blur, uv).rgb); L += (L - Lb) * u_structure * 1.5; }
    L += u_shadows * 0.25 * (1.0 - sstep(0.0, 0.5, L));
    L += u_highlights * 0.25 * sstep(0.5, 1.0, L);
    L = 0.5 + (L - 0.5) * (1.0 + u_contrast) + u_bright * 0.5;
    L = clamp(L, 0.0, 1.0);
    vec3 o = vec3(L);
    if (u_toneOn) { float wh = sstep(0.35, 0.85, L), ws = 1.0 - sstep(0.15, 0.65, L); o += u_hi * wh + u_sh * ws; }
    return vec4(sat3(o), c.a);
}`);

// point operations (declared as the filter's glsl block, the prelude prepended)
const BLEACH_GLSL = PRELUDE + `
vec4 shade(vec4 c, vec2 uv) {
    float l = luma(c.rgb);
    vec3 ov = l < 0.5 ? 2.0 * c.rgb * l : 1.0 - 2.0 * (1.0 - c.rgb) * (1.0 - l);
    vec3 o = mix(c.rgb, ov, u_strength);
    o = mix(o, vec3(luma(o)), u_desat * u_strength);
    o = 0.5 + (o - 0.5) * (1.0 + u_contrast * u_strength) + u_bright;
    return vec4(sat3(o), c.a);
}`;

const XPRO_GLSL = PRELUDE + `
vec4 shade(vec4 c, vec2 uv) {
    vec3 o = tab3(u_curves, c.rgb);
    float l = luma(o);
    o = l + (o - l) * u_sat;
    o = 0.5 + (o - 0.5) * (1.0 + u_contrast);
    return vec4(mix(c.rgb, sat3(o), u_strength), c.a);
}`;

const SPLIT_GLSL = PRELUDE + `
vec4 shade(vec4 c, vec2 uv) {
    float L = luma(c.rgb);
    float wh = sstep(0.35 + u_bal, 0.85 + u_bal, L), ws = 1.0 - sstep(0.15 + u_bal, 0.65 + u_bal, L);
    vec3 o = c.rgb + u_hi * wh + u_sh * ws;
    if (u_preserve) o += L - luma(o);
    return vec4(sat3(o), c.a);
}`;

const LEAK_GLSL = PRELUDE + `
vec3 blob(vec2 uv, vec4 b, vec4 s) {
    vec2 d = (uv - b.xy) * vec2(u_aspect, 1.0);
    float ca = cos(b.z), sa = sin(b.z);
    vec2 r = vec2(d.x * ca + d.y * sa, -d.x * sa + d.y * ca);
    float I = exp(-(r.x * r.x / (2.0 * s.x * s.x) + r.y * r.y / (2.0 * s.y * s.y))) * b.w;
    return I * mix(vec3(1.0), hueRgb(s.z), s.w);
}
vec4 shade(vec4 c, vec2 uv) {
    vec3 leak = blob(uv, u_b0, u_s0);
    if (u_n > 1) leak += blob(uv, u_b1, u_s1);
    if (u_n > 2) leak += blob(uv, u_b2, u_s2);
    return vec4(screen3(c.rgb, sat3(leak * u_strength)), c.a);
}`;

const FRAME_GLSL = PRELUDE + `
float rrect(vec2 q, vec2 dims, float w, float r) {
    vec2 hf = dims * 0.5 - w - r;
    vec2 pc = abs(q - dims * 0.5) - hf;
    return length(max(pc, 0.0)) + min(max(pc.x, pc.y), 0.0) - r;
}
vec4 shade(vec4 c, vec2 uv) {
    vec2 dims = u_size / min(u_size.x, u_size.y);
    vec2 q = uv * dims;
    float dx = min(q.x, dims.x - q.x), dy = min(q.y, dims.y - q.y);
    float w = u_w, soft = max(0.0015, u_soft * w * 0.5), cov = 0.0;
    vec3 col = u_col;
    if (u_style == 0) { float d = min(dx, dy); cov = 1.0 - sstep(w - soft, w + soft, d); }
    else if (u_style == 1) {
        float d = min(dx, dy);
        cov = 1.0 - sstep(w - soft, w + soft, d);
        float k0 = w + u_inset;
        float key = sstep(k0 - 0.001, k0 + 0.001, d) * (1.0 - sstep(k0 + 0.004 - 0.001, k0 + 0.004 + 0.001, d));
        vec3 keyCol = luma(col) > 0.5 ? col * 0.45 : col + 0.5;
        col = mix(col, keyCol, key);
        cov = max(cov, key);
    }
    else if (u_style == 2) { float d = rrect(q, dims, w, u_radius); cov = sstep(-soft, soft, d); }
    else if (u_style == 3) {
        float d = rrect(q, dims, w * 1.4, u_radius + 0.01);
        cov = sstep(-soft, soft, d);
        float rim = sstep(-0.008 - soft, -0.008 + soft, d) * (1.0 - sstep(-soft, soft, d));
        col = mix(col, vec3(0.05), rim * 0.9);
        cov = max(cov, rim);
    }
    else if (u_style == 4) {
        float wb = w * 3.4;
        vec2 inner0 = vec2(w, w), inner1 = vec2(dims.x - w, dims.y - wb);
        vec2 ic = (inner0 + inner1) * 0.5, ih = (inner1 - inner0) * 0.5 - u_radius;
        vec2 pc = abs(q - ic) - ih;
        float d = length(max(pc, 0.0)) + min(max(pc.x, pc.y), 0.0) - u_radius;
        cov = sstep(-soft, soft, d);
    }
    else if (u_style == 5) {
        float d = min(dx, dy);
        float n = vnoise(q * 30.0, u_variant) * 0.65 + vnoise(q * 90.0, u_variant + 1) * 0.35;
        d += (n - 0.5) * u_rough * w * 1.6;
        cov = 1.0 - sstep(w - soft, w + soft, d);
    }
    else { vec2 e = (q - dims * 0.5) / (dims * 0.5 - w); float d = length(e); cov = sstep(1.0 - soft * 2.0, 1.0 + soft * 2.0, d); }
    return vec4(mix(c.rgb, col, cov), c.a);
}`;

// ---- shared stages ----------------------------------------------------------------------------

/** Halation / bloom: highlights above `thr` blurred by `sigma` px, tinted, screened over the picture. */
function halationStage(run, src, { thr, sigma, strength, tint }, info) {
    if (strength <= 0 || sigma <= 0) return src;
    const hi = run(EXTRACT, src, { u_thr: thr }, info, () => loop(src, (c) => {
        const h = sstep(thr, 1, luma(c[0], c[1], c[2]));
        c[0] *= h; c[1] *= h; c[2] *= h;
    }));
    const b = blur(hi, sigma);
    return run(HALATION, src, { u_blur: b, u_tint: tint, u_strength: strength }, info, () => loop(src, (c, x, y, j, g) => {
        for (let k = 0; k < 3; k++) c[k] = screen(c[k], clamp01(g[k] * tint[k] * strength));
    }, b));
}

/** The colour weights of a black-and-white conversion behind a colour filter of hue `hue` and strength `s` (0..1). */
export function bwWeights(hue, s) {
    const k = (h) => 0.5 + 0.5 * Math.cos((hue - h) * Math.PI / 180);
    let w = [LR * (1 + 2.4 * s * (k(0) - 0.5)), LG * (1 + 2.4 * s * (k(120) - 0.5)), LB * (1 + 2.4 * s * (k(240) - 0.5))];
    w = w.map((v) => Math.max(0, v));
    const sum = w[0] + w[1] + w[2] || 1;
    return w.map((v) => v / sum);
}

/** Split-toning tints premultiplied: (pure hue - 0.5) * saturation * 0.5. */
const tint = (hue, sat) => hueRgb(hue).map((v) => (v - 0.5) * sat * 0.5);

// ---- the film look ----------------------------------------------------------------------------

/** Uniform values of the colour stage for `p` (the tone table is cached in `cache` by its key). */
export function lookValues(p, cache = {}) {
    const stock = STOCK_BY_ID[p.preset] || null;
    const L = { sat: 0, contrast: 0, warmth: 0, tint: 0, fade: 0, ...(stock ? stock.look : {}) };
    const push = num(p.push, 0);
    const mixM = Array.isArray(L.mix) && L.mix.length === 9 ? L.mix : [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const mono = Array.isArray(L.mono) && L.mono.length === 3 ? L.mono : null;
    const ms = mono ? (mono[0] + mono[1] + mono[2] || 1) : 1;
    const warmth = L.warmth + num(p.warmth, 0), tn = L.tint + num(p.tint, 0);
    const toneSpec = { contrast: (L.contrast + num(p.contrast, 0) + push * 8) / 100, toe: stock ? stock.toe : 0, shoulder: stock ? stock.shoulder : 0, fade: (L.fade + num(p.fade, 0)) / 100 };
    const key = JSON.stringify(toneSpec);
    if (cache.toneKey !== key) { cache.toneKey = key; cache.tone = table(toneCurve(toneSpec)); cache.toneTex = tablesTexture(cache.tone); }
    return {
        stock,
        u_exp: Math.pow(2, num(p.exposure, 0)),
        u_mixR: mixM.slice(0, 3), u_mixG: mixM.slice(3, 6), u_mixB: mixM.slice(6, 9),
        u_mono: !!mono, u_monoW: mono ? [mono[0] / ms, mono[1] / ms, mono[2] / ms] : [LR, LG, LB],
        u_wb: [1 + warmth / 300, 1 - tn / 300, 1 - warmth / 300],
        u_sat: 1 + (L.sat + num(p.saturation, 0)) / 100,
        u_tone: cache.toneTex, tone: cache.tone,
        u_strength: pct(p.strength, 100),
    };
}

/** The colour stage alone (used by the panel thumbnails too). */
export function lookStage(run, src, p, info) {
    const v = lookValues(p, info.cache || {});
    return run(LOOK, src, v, info, () => loop(src, (c) => {
        const r0 = c[0], g0 = c[1], b0 = c[2];
        let r = r0 * v.u_exp, g = g0 * v.u_exp, b = b0 * v.u_exp;
        const nr = v.u_mixR[0] * r + v.u_mixR[1] * g + v.u_mixR[2] * b, ng = v.u_mixG[0] * r + v.u_mixG[1] * g + v.u_mixG[2] * b, nb = v.u_mixB[0] * r + v.u_mixB[1] * g + v.u_mixB[2] * b;
        r = nr; g = ng; b = nb;
        if (v.u_mono) { const l = v.u_monoW[0] * r + v.u_monoW[1] * g + v.u_monoW[2] * b; r = g = b = l; }
        r *= v.u_wb[0]; g *= v.u_wb[1]; b *= v.u_wb[2];
        if (!v.u_mono) { const l = luma(r, g, b); r = l + (r - l) * v.u_sat; g = l + (g - l) * v.u_sat; b = l + (b - l) * v.u_sat; }
        r = lookup(v.tone, r); g = lookup(v.tone, g); b = lookup(v.tone, b);
        c[0] = mix(r0, r, v.u_strength); c[1] = mix(g0, g, v.u_strength); c[2] = mix(b0, b, v.u_strength);
    }));
}

// ---- light leak geometry ----------------------------------------------------------------------

/** Up to three anisotropic blobs (normalised coordinates, y down) for a style and seed. */
export function leakBlobs(p) {
    const style = String(p.style || "edge"), seed = Math.round(num(p.seed, 0));
    const pos = pct(p.position, 50), ang = num(p.angle, 20) * Math.PI / 180, spread = pct(p.spread, 40);
    const hue = num(p.hue, 25), sat = pct(p.saturation, 70);
    const j = (k) => hash2(seed, k, 11) - 0.5;
    const V = Math.PI / 2;
    const B = (cx, cy, a, sx, sy, I, h, s) => ({ b: [cx, cy, a, I], s: [Math.max(0.003, sx), Math.max(0.003, sy), h, s] });
    switch (style) {
        case "streak": return [B(pos + j(1) * 0.1, 0.5, V + ang, 2, spread * 0.15, 0.9, hue + j(2) * 16, sat)];
        case "corner": {
            const cx = j(1) > 0 ? 1 : 0, cy = j(2) > 0 ? 1 : 0;
            return [B(cx, cy, 0, spread * 0.9, spread * 0.9, 1.1, hue + j(3) * 10, sat), B(cx, cy + (cy ? -1 : 1) * pos * 0.6, 0, spread * 0.35, spread * 0.35, 0.8, hue + 30, sat * 0.9)];
        }
        case "double": return [
            B(pos - 0.15 + j(1) * 0.1, 0.5, V + ang, 2, spread * 0.12, 0.85, hue + j(2) * 16, sat),
            B(pos + 0.2 + j(3) * 0.1, 0.5, V + ang * 1.4, 2, spread * 0.08, 0.7, hue + 35 + j(4) * 16, sat * 0.9),
        ];
        case "bars": return [-1, 0, 1].map((k) => B(pos + k * 0.13 + j(k + 5) * 0.03, 0.5, V, 1.5, spread * 0.05, 0.8, hue + k * 8, sat));
        default: return [   // edge
            B(1.05 + j(1) * 0.1, pos + j(2) * 0.2, V + ang * 0.3, 0.5 + j(3) * 0.2, spread * 0.35, 1, hue + j(4) * 20, sat),
            B(1, pos + 0.25 + j(5) * 0.3, V, 0.15, spread * 0.12, 0.7, hue + 25, sat * 0.8),
        ];
    }
}

function blobAt(u, vv, aspect, b, s) {
    const dx = (u - b[0]) * aspect, dy = vv - b[1];
    const ca = Math.cos(b[2]), sa = Math.sin(b[2]);
    const rx = dx * ca + dy * sa, ry = -dx * sa + dy * ca;
    const I = Math.exp(-(rx * rx / (2 * s[0] * s[0]) + ry * ry / (2 * s[1] * s[1]))) * b[3];
    const h = hueRgb(s[2]);
    return [I * mix(1, h[0], s[3]), I * mix(1, h[1], s[3]), I * mix(1, h[2], s[3])];
}

// ---- frame geometry (CPU twin of FRAME_GLSL) --------------------------------------------------

function rrect(qx, qy, dw, dh, w, r) {
    const hx = dw * 0.5 - w - r, hy = dh * 0.5 - w - r;
    const px = Math.abs(qx - dw * 0.5) - hx, py = Math.abs(qy - dh * 0.5) - hy;
    const mx = Math.max(px, 0), my = Math.max(py, 0);
    return Math.hypot(mx, my) + Math.min(Math.max(px, py), 0) - r;
}

function frameCoverage(qx, qy, dw, dh, u) {
    const dx = Math.min(qx, dw - qx), dy = Math.min(qy, dh - qy);
    const w = u.w, soft = Math.max(0.0015, u.soft * w * 0.5);
    let cov = 0, col = u.col;
    switch (u.style) {
        case 0: { const d = Math.min(dx, dy); cov = 1 - sstep(w - soft, w + soft, d); break; }
        case 1: {
            const d = Math.min(dx, dy);
            cov = 1 - sstep(w - soft, w + soft, d);
            const k0 = w + u.inset;
            const key = sstep(k0 - 0.001, k0 + 0.001, d) * (1 - sstep(k0 + 0.004 - 0.001, k0 + 0.004 + 0.001, d));
            const keyCol = luma(col[0], col[1], col[2]) > 0.5 ? col.map((v) => v * 0.45) : col.map((v) => v + 0.5);
            col = [mix(col[0], keyCol[0], key), mix(col[1], keyCol[1], key), mix(col[2], keyCol[2], key)];
            cov = Math.max(cov, key);
            break;
        }
        case 2: { const d = rrect(qx, qy, dw, dh, w, u.radius); cov = sstep(-soft, soft, d); break; }
        case 3: {
            const d = rrect(qx, qy, dw, dh, w * 1.4, u.radius + 0.01);
            cov = sstep(-soft, soft, d);
            const rim = sstep(-0.008 - soft, -0.008 + soft, d) * (1 - sstep(-soft, soft, d));
            col = col.map((v) => mix(v, 0.05, rim * 0.9));
            cov = Math.max(cov, rim);
            break;
        }
        case 4: {
            const wb = w * 3.4;
            const i0x = w, i0y = w, i1x = dw - w, i1y = dh - wb;
            const icx = (i0x + i1x) * 0.5, icy = (i0y + i1y) * 0.5, ihx = (i1x - i0x) * 0.5 - u.radius, ihy = (i1y - i0y) * 0.5 - u.radius;
            const px = Math.abs(qx - icx) - ihx, py = Math.abs(qy - icy) - ihy;
            const d = Math.hypot(Math.max(px, 0), Math.max(py, 0)) + Math.min(Math.max(px, py), 0) - u.radius;
            cov = sstep(-soft, soft, d);
            break;
        }
        case 5: {
            let d = Math.min(dx, dy);
            const n = vnoise(qx * 30, qy * 30, u.seed) * 0.65 + vnoise(qx * 90, qy * 90, u.seed + 1) * 0.35;
            d += (n - 0.5) * u.rough * w * 1.6;
            cov = 1 - sstep(w - soft, w + soft, d);
            break;
        }
        default: {
            const ex = (qx - dw * 0.5) / (dw * 0.5 - w), ey = (qy - dh * 0.5) / (dh * 0.5 - w);
            const d = Math.hypot(ex, ey);
            cov = sstep(1 - soft * 2, 1 + soft * 2, d);
        }
    }
    return { cov, col };
}

// ---- the registry ------------------------------------------------------------------------------

const S = (key, label, min, max, step, def, unit = "", extra = {}) => ({ key, label, min, max, step, default: def, unit, keepPreset: true, ...extra });

/** Filter definitions for scumble.filters.register (ids get the plugin prefix). */
export function makeFilters(scumble) {
    const run = makeRunner(scumble);
    const grainStage = (src, g, info) => (g.amount > 0 ? scumble.filters.apply("grain", src, { preset: "custom", look: null, look_strength: 0, amount: g.amount, size: g.size, speckle: g.speckle, chroma: g.chroma }, info) : src);

    const look = {
        id: "look",
        label: "Film look",
        params: [
            { key: "preset", label: "Film", type: "select", options: STOCK_OPTIONS, default: "portra400", title: "Film stock: colour matrix, tone curve (toe, shoulder, contrast), fade, grain by speed and a halation default. The sliders below are offsets on top of the stock. " + TRADEMARK },
            S("strength", "Strength", 0, 100, 1, 100, "%"),
            S("exposure", "Exposure", -2, 2, 0.05, 0, " EV"),
            S("push", "Push / pull", -1, 2, 0.5, 0, " st"),
            S("contrast", "Contrast", -50, 50, 1, 0),
            S("saturation", "Saturation", -50, 50, 1, 0),
            S("warmth", "Warmth", -50, 50, 1, 0),
            S("tint", "Tint", -50, 50, 1, 0),
            S("fade", "Fade", 0, 30, 1, 0),
            S("grain", "Grain", 0, 200, 1, 100, "%"),
            S("halation", "Halation", 0, 100, 1, 100, "%"),
        ],
        apply(src, p, info) {
            const cache = info.cache || (info.cache = {});
            let out = lookStage(run, src, p, info);
            const stock = STOCK_BY_ID[p.preset] || null;
            const strength = pct(p.strength, 100), push = num(p.push, 0);
            const halBase = stock ? stock.halation : 0;
            const hal = halBase / 100 * pct(p.halation, 100) * strength;
            if (hal > 0) {
                const longSide = Math.max(src.width, src.height);
                out = halationStage(run, out, { thr: 0.62, sigma: longSide * 0.012, strength: hal * 0.9, tint: hueRgb(12).map((v) => mix(1, v, 0.85)) }, info);
            }
            const g = stock ? stock.grain : { amount: 25, size: 1.5, speckle: 25, chroma: 0 };
            const gp = pct(p.grain, 100) * strength * (1 + 0.35 * push);
            if (gp > 0) out = grainStage(out, { amount: g.amount * gp, size: g.size * (1 + 0.12 * push), speckle: g.speckle, chroma: g.chroma }, { ...info, cache });
            return out;
        },
    };

    const halation = {
        id: "halation",
        label: "Halation",
        params: [
            S("threshold", "Threshold", 0, 100, 1, 65, "%"),
            S("radius", "Radius", 2, 200, 1, 30, "px"),
            S("strength", "Strength", 0, 100, 1, 40, "%"),
            S("hue", "Hue", 0, 360, 1, 12, "°"),
            S("saturation", "Colour", 0, 100, 1, 85, "%"),
        ],
        apply(src, p, info) {
            const sat = pct(p.saturation, 85);
            return halationStage(run, src, { thr: pct(p.threshold, 65), sigma: num(p.radius, 30) * (info.scale || 1), strength: pct(p.strength, 40), tint: hueRgb(num(p.hue, 12)).map((v) => mix(1, v, sat)) }, info);
        },
    };

    const glow = {
        id: "glow",
        label: "Glow / Orton",
        params: [
            { key: "mode", label: "Mode", type: "select", options: [{ id: "soft", label: "Soft light (Orton)" }, { id: "screen", label: "Screen (bloom)" }, { id: "lighten", label: "Lighten (diffusion)" }], default: "soft" },
            S("radius", "Radius", 2, 300, 1, 40, "px"),
            S("amount", "Amount", 0, 100, 1, 50, "%"),
            S("threshold", "Highlights only", 0, 100, 1, 0, "%"),
        ],
        apply(src, p, info) {
            const amount = pct(p.amount, 50);
            if (amount <= 0) return src;
            const thr = pct(p.threshold, 0);
            const base = thr > 0 ? run(EXTRACT, src, { u_thr: thr }, info, () => loop(src, (c) => { const h = sstep(thr, 1, luma(c[0], c[1], c[2])); c[0] *= h; c[1] *= h; c[2] *= h; })) : src;
            const b = blur(base, num(p.radius, 40) * (info.scale || 1));
            const mode = p.mode === "screen" ? 1 : p.mode === "lighten" ? 2 : 0;
            return run(GLOW, src, { u_blur: b, u_amount: amount, u_mode: mode }, info, () => loop(src, (c, x, y, j, g) => {
                for (let k = 0; k < 3; k++) { const r = mode === 0 ? softlight(c[k], g[k]) : mode === 1 ? screen(c[k], g[k]) : Math.max(c[k], g[k]); c[k] = mix(c[k], r, amount); }
            }, b));
        },
    };

    const tonal = {
        id: "tonal_contrast",
        label: "Tonal contrast",
        params: [
            S("highlights", "Highlights", -100, 100, 1, 20, "%"),
            S("midtones", "Midtones", -100, 100, 1, 30, "%"),
            S("shadows", "Shadows", -100, 100, 1, 20, "%"),
            S("radius", "Radius", 5, 200, 1, 40, "px"),
            S("saturation", "Saturation", -100, 100, 1, 10, "%"),
            S("protect", "Protect ends", 0, 100, 1, 50, "%"),
        ],
        apply(src, p, info) {
            const h = pct(p.highlights, 20), m = pct(p.midtones, 30), s = pct(p.shadows, 20), sat = pct(p.saturation, 10), protect = pct(p.protect, 50);
            const b = blur(src, num(p.radius, 40) * (info.scale || 1));
            return run(TONAL, src, { u_blur: b, u_h: h, u_m: m, u_s: s, u_sat: sat, u_protect: protect }, info, () => loop(src, (c, x, y, j, g) => {
                const L = luma(c[0], c[1], c[2]), Lb = luma(g[0], g[1], g[2]);
                const ws = 1 - sstep(0, 0.5, Lb), wh = sstep(0.5, 1, Lb), wm = 1 - Math.abs(2 * Lb - 1);
                const gain = 1 + 2 * (s * ws + m * wm + h * wh);
                let Ln = Lb + (L - Lb) * gain;
                Ln = mix(Ln, L, protect * (1 - 4 * L * (1 - L)));
                let r, gg, bb;
                if (L > 0.002) { const k = Ln / L; r = c[0] * k; gg = c[1] * k; bb = c[2] * k; } else { r = c[0] + Ln - L; gg = c[1] + Ln - L; bb = c[2] + Ln - L; }
                r = clamp01(r); gg = clamp01(gg); bb = clamp01(bb);
                const l2 = luma(r, gg, bb);
                c[0] = l2 + (r - l2) * (1 + sat); c[1] = l2 + (gg - l2) * (1 + sat); c[2] = l2 + (bb - l2) * (1 + sat);
            }, b));
        },
    };

    const structure = {
        id: "structure",
        label: "Structure / Detail",
        params: [
            S("amount", "Amount", -100, 100, 1, 30, "%"),
            S("radius", "Radius", 0.5, 30, 0.5, 3, "px"),
            { key: "luminance", label: "Luminance only", type: "bool", default: true, keepPreset: true },
        ],
        apply(src, p, info) {
            const amount = pct(p.amount, 30);
            if (amount === 0) return src;
            const lum = p.luminance !== false;
            const b = blur(src, num(p.radius, 3) * (info.scale || 1));
            return run(STRUCTURE, src, { u_blur: b, u_amount: amount, u_lum: lum }, info, () => loop(src, (c, x, y, j, g) => {
                if (amount >= 0) {
                    if (lum) { const dL = luma(c[0], c[1], c[2]) - luma(g[0], g[1], g[2]); for (let k = 0; k < 3; k++) c[k] += dL * amount * 2; }
                    else for (let k = 0; k < 3; k++) c[k] += (c[k] - g[k]) * amount * 2;
                } else for (let k = 0; k < 3; k++) c[k] = mix(c[k], g[k], -amount);
            }, b));
        },
    };

    const bleach = {
        id: "bleach_bypass",
        label: "Bleach bypass",
        params: [
            S("strength", "Strength", 0, 100, 1, 70, "%"),
            S("desaturate", "Desaturate", 0, 100, 1, 50, "%"),
            S("contrast", "Contrast", 0, 100, 1, 30, "%"),
            S("brightness", "Brightness", -50, 50, 1, 0),
        ],
        apply(src, p) {
            const st = pct(p.strength, 70), de = pct(p.desaturate, 50), co = pct(p.contrast, 30), br = num(p.brightness, 0) / 100;
            return loop(src, (c) => {
                const l = luma(c[0], c[1], c[2]);
                for (let k = 0; k < 3; k++) { const ov = l < 0.5 ? 2 * c[k] * l : 1 - 2 * (1 - c[k]) * (1 - l); c[k] = mix(c[k], ov, st); }
                const l2 = luma(c[0], c[1], c[2]);
                for (let k = 0; k < 3; k++) { c[k] = mix(c[k], l2, de * st); c[k] = 0.5 + (c[k] - 0.5) * (1 + co * st) + br; }
            });
        },
        glsl: {
            uniforms: { u_strength: "float", u_desat: "float", u_contrast: "float", u_bright: "float" },
            values: (p) => ({ u_strength: pct(p.strength, 70), u_desat: pct(p.desaturate, 50), u_contrast: pct(p.contrast, 30), u_bright: num(p.brightness, 0) / 100 }),
            code: BLEACH_GLSL,
        },
    };

    const xproTables = (p, cache) => {
        const style = XPRO_BY_ID[p.style] || XPRO_STYLES[0];
        const shift = num(p.shift, 0) / 100;
        const key = style.id + ":" + shift;
        if (cache.xproKey !== key) {
            const fr = monotone(style.r), fg = monotone(style.g.map(([x, y]) => [x, y - shift * 0.08])), fb = monotone(style.b);
            cache.xproKey = key;
            cache.xpro = { r: table(fr), g: table(fg), b: table(fb) };
            cache.xproTex = tablesTexture(cache.xpro.r, cache.xpro.g, cache.xpro.b);
        }
        return { style, tables: cache.xpro, tex: cache.xproTex };
    };
    const xpro = {
        id: "cross_process",
        label: "Cross processing",
        params: [
            { key: "style", label: "Process", type: "select", options: XPRO_STYLES.map((s) => ({ id: s.id, label: s.label })), default: "e6c41" },
            S("strength", "Strength", 0, 100, 1, 100, "%"),
            S("contrast", "Contrast", -50, 50, 1, 0),
            S("shift", "Green ↔ magenta", -100, 100, 1, 0),
        ],
        apply(src, p, info) {
            const { style, tables } = xproTables(p, info.cache || {});
            const st = pct(p.strength, 100), co = num(p.contrast, 0) / 100, sat = style.sat;
            return loop(src, (c) => {
                let r = lookup(tables.r, c[0]), g = lookup(tables.g, c[1]), b = lookup(tables.b, c[2]);
                const l = luma(r, g, b);
                r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
                r = 0.5 + (r - 0.5) * (1 + co); g = 0.5 + (g - 0.5) * (1 + co); b = 0.5 + (b - 0.5) * (1 + co);
                c[0] = mix(c[0], clamp01(r), st); c[1] = mix(c[1], clamp01(g), st); c[2] = mix(c[2], clamp01(b), st);
            });
        },
        glsl: {
            uniforms: { u_curves: "sampler2D", u_strength: "float", u_sat: "float", u_contrast: "float" },
            values: (p, info) => { const { style, tex } = xproTables(p, info.cache || {}); return { u_curves: tex, u_strength: pct(p.strength, 100), u_sat: style.sat, u_contrast: num(p.contrast, 0) / 100 }; },
            code: XPRO_GLSL,
        },
    };

    const split = {
        id: "split_tone",
        label: "Split toning",
        params: [
            S("hi_hue", "Highlights hue", 0, 360, 1, 45, "°"),
            S("hi_sat", "Highlights", 0, 100, 1, 30, "%"),
            S("sh_hue", "Shadows hue", 0, 360, 1, 215, "°"),
            S("sh_sat", "Shadows", 0, 100, 1, 30, "%"),
            S("balance", "Balance", -100, 100, 1, 0),
            { key: "preserve", label: "Keep luminance", type: "bool", default: true, keepPreset: true },
        ],
        apply(src, p) {
            const hi = tint(num(p.hi_hue, 45), pct(p.hi_sat, 30)), sh = tint(num(p.sh_hue, 215), pct(p.sh_sat, 30)), bal = num(p.balance, 0) / 100 * 0.5, keep = p.preserve !== false;
            return loop(src, (c) => {
                const L = luma(c[0], c[1], c[2]);
                const wh = sstep(0.35 + bal, 0.85 + bal, L), ws = 1 - sstep(0.15 + bal, 0.65 + bal, L);
                for (let k = 0; k < 3; k++) c[k] += hi[k] * wh + sh[k] * ws;
                if (keep) { const d = L - luma(c[0], c[1], c[2]); c[0] += d; c[1] += d; c[2] += d; }
            });
        },
        glsl: {
            uniforms: { u_hi: "vec3", u_sh: "vec3", u_bal: "float", u_preserve: "bool" },
            values: (p) => ({ u_hi: tint(num(p.hi_hue, 45), pct(p.hi_sat, 30)), u_sh: tint(num(p.sh_hue, 215), pct(p.sh_sat, 30)), u_bal: num(p.balance, 0) / 100 * 0.5, u_preserve: p.preserve !== false }),
            code: SPLIT_GLSL,
        },
    };

    const leak = {
        id: "light_leak",
        label: "Light leak",
        params: [
            { key: "style", label: "Style", type: "select", options: LEAK_STYLES, default: "edge" },
            S("strength", "Strength", 0, 100, 1, 60, "%"),
            S("hue", "Hue", 0, 360, 1, 25, "°"),
            S("saturation", "Colour", 0, 100, 1, 70, "%"),
            S("spread", "Spread", 5, 100, 1, 40, "%"),
            S("position", "Position", 0, 100, 1, 50, "%"),
            S("angle", "Angle", -90, 90, 1, 20, "°"),
            S("seed", "Variant", 0, 99, 1, 0),
        ],
        apply(src, p) {
            const blobs = leakBlobs(p), st = pct(p.strength, 60);
            const W = src.width, H = src.height, aspect = W / H;
            return loop(src, (c, x, y) => {
                const u = (x + 0.5) / W, vv = (y + 0.5) / H;
                let r = 0, g = 0, b = 0;
                for (const q of blobs) { const l = blobAt(u, vv, aspect, q.b, q.s); r += l[0]; g += l[1]; b += l[2]; }
                c[0] = screen(c[0], clamp01(r * st)); c[1] = screen(c[1], clamp01(g * st)); c[2] = screen(c[2], clamp01(b * st));
            });
        },
        glsl: {
            uniforms: { u_n: "int", u_b0: "vec4", u_s0: "vec4", u_b1: "vec4", u_s1: "vec4", u_b2: "vec4", u_s2: "vec4", u_aspect: "float", u_strength: "float" },
            values: (p, info, src) => {
                const blobs = leakBlobs(p);
                const z = { b: [0, 0, 0, 0], s: [1, 1, 0, 0] };
                const q = [blobs[0] || z, blobs[1] || z, blobs[2] || z];
                return { u_n: blobs.length, u_b0: q[0].b, u_s0: q[0].s, u_b1: q[1].b, u_s1: q[1].s, u_b2: q[2].b, u_s2: q[2].s, u_aspect: src ? src.width / src.height : 1, u_strength: pct(p.strength, 60) };
            },
            code: LEAK_GLSL,
        },
    };

    const frameUniforms = (p) => ({
        style: Math.max(0, FRAME_STYLES.findIndex((s) => s.id === p.style)),
        w: pct(p.width, 4), col: (FRAME_COLOUR_BY_ID[p.colour] || FRAME_COLOURS[0]).rgb,
        rough: pct(p.roughness, 40), soft: pct(p.softness, 10), radius: pct(p.radius, 2) * 0.5, inset: pct(p.inset, 3), seed: Math.round(num(p.seed, 0)),
    });
    const frame = {
        id: "frame",
        label: "Frame",
        params: [
            { key: "style", label: "Style", type: "select", options: FRAME_STYLES, default: "matte" },
            { key: "colour", label: "Colour", type: "select", options: FRAME_COLOURS.map((c) => ({ id: c.id, label: c.label })), default: "white" },
            S("width", "Width", 0.5, 25, 0.5, 4, "%"),
            S("softness", "Softness", 0, 100, 1, 10, "%"),
            S("radius", "Corner radius", 0, 50, 1, 2, "%"),
            S("inset", "Key line offset", 0, 30, 0.5, 3, "%"),
            S("roughness", "Roughness", 0, 100, 1, 40, "%"),
            S("seed", "Variant", 0, 99, 1, 0),
        ],
        apply(src, p) {
            const u = frameUniforms(p);
            const W = src.width, H = src.height, m = Math.min(W, H), dw = W / m, dh = H / m;
            return loop(src, (c, x, y) => {
                const { cov, col } = frameCoverage((x + 0.5) / m, (y + 0.5) / m, dw, dh, u);
                if (cov <= 0) return;
                c[0] = mix(c[0], col[0], cov); c[1] = mix(c[1], col[1], cov); c[2] = mix(c[2], col[2], cov);
            });
        },
        glsl: {
            uniforms: { u_style: "int", u_w: "float", u_col: "vec3", u_rough: "float", u_soft: "float", u_radius: "float", u_inset: "float", u_variant: "int" },
            values: (p) => { const u = frameUniforms(p); return { u_style: u.style, u_w: u.w, u_col: u.col, u_rough: u.rough, u_soft: u.soft, u_radius: u.radius, u_inset: u.inset, u_variant: u.seed }; },
            code: FRAME_GLSL,
        },
    };

    const bw = {
        id: "bw",
        label: "Black & white film",
        params: [
            { key: "preset", label: "Colour filter", type: "select", options: BW_FILTERS, default: "none", title: "A colour filter in front of the lens: the film sees the filter's colour bright and its complement dark (a red filter darkens the sky, an orange one lightens skin). Custom: set the hue and strength below." },
            { key: "filter_hue", label: "Filter hue", min: 0, max: 360, step: 1, default: 0, unit: "°" },
            { key: "filter_strength", label: "Filter", min: 0, max: 100, step: 1, default: 0, unit: "%" },
            S("brightness", "Brightness", -50, 50, 1, 0),
            S("contrast", "Contrast", -50, 50, 1, 10),
            S("structure", "Structure", -100, 100, 1, 20, "%"),
            S("shadows", "Shadows", -50, 50, 1, 0),
            S("highlights", "Highlights", -50, 50, 1, 0),
            { key: "tone", label: "Toning", type: "select", options: TONERS.map((t) => ({ id: t.id, label: t.label })), default: "none", keepPreset: true },
            S("tone_strength", "Toning", 0, 100, 1, 50, "%"),
            S("grain", "Grain", 0, 100, 1, 0, "%"),
        ],
        apply(src, p, info) {
            const w = bwWeights(num(p.filter_hue, 0), pct(p.filter_strength, 0));
            const st = pct(p.structure, 20), sh = num(p.shadows, 0) / 100, hi = num(p.highlights, 0) / 100, br = num(p.brightness, 0) / 100, co = num(p.contrast, 10) / 100;
            const toner = TONER_BY_ID[p.tone] || null, ts = pct(p.tone_strength, 50);
            const toneOn = !!(toner && toner.id !== "none" && ts > 0);
            const hiT = toneOn ? tint(toner.hh, toner.hs / 100 * ts) : [0, 0, 0], shT = toneOn ? tint(toner.sh, toner.ss / 100 * ts) : [0, 0, 0];
            const useBlur = st !== 0;
            const b = useBlur ? blur(src, 4 * (info.scale || 1)) : null;
            let out = run(BW, src, { u_blur: b || null, u_useBlur: useBlur, u_w: w, u_structure: st, u_shadows: sh, u_highlights: hi, u_bright: br, u_contrast: co, u_toneOn: toneOn, u_hi: hiT, u_sh: shT }, info, () => loop(src, (c, x, y, j, g) => {
                let L = w[0] * c[0] + w[1] * c[1] + w[2] * c[2];
                if (useBlur) { const Lb = w[0] * g[0] + w[1] * g[1] + w[2] * g[2]; L += (L - Lb) * st * 1.5; }
                L += sh * 0.25 * (1 - sstep(0, 0.5, L));
                L += hi * 0.25 * sstep(0.5, 1, L);
                L = clamp01(0.5 + (L - 0.5) * (1 + co) + br * 0.5);
                c[0] = c[1] = c[2] = L;
                if (toneOn) { const wh = sstep(0.35, 0.85, L), ws = 1 - sstep(0.15, 0.65, L); for (let k = 0; k < 3; k++) c[k] += hiT[k] * wh + shT[k] * ws; }
            }, b));
            const gr = pct(p.grain, 0);
            if (gr > 0) out = grainStage(out, { amount: gr * 40, size: 1.5, speckle: 55, chroma: 0 }, info);
            return out;
        },
    };

    return [look, halation, glow, tonal, structure, bleach, xpro, split, leak, frame, bw];
}

export { halationStage, tint, LOOK };
