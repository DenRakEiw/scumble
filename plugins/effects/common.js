// @ts-check
// Effects pack: shared helpers and math foundations.
// Every filter has a GLSL shader path and a CPU twin with identical formulas.

export const PRELUDE = `
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
float luma(vec3 c) { return dot(c, LUMA); }
vec3 sat3(vec3 c) { return clamp(c, 0.0, 1.0); }
float screen(float b, float s) { return 1.0 - (1.0 - b) * (1.0 - s); }
vec3 screen3(vec3 b, vec3 s) { return 1.0 - (1.0 - b) * (1.0 - s); }
float sstep(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }

uint ihash(uint x) { x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u; return x; }
float hash2(int x, int y, int seed) { return float(ihash(uint(x) * 1597334677u ^ ihash(uint(y) * 3812015801u ^ uint(seed) * 2654435761u))) / 4294967295.0; }
float vnoise(vec2 p, int seed) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    int x = int(i.x), y = int(i.y);
    float a = hash2(x, y, seed), b = hash2(x + 1, y, seed), c = hash2(x, y + 1, seed), d = hash2(x + 1, y + 1, seed);
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p, int seed) {
    return (vnoise(p, seed) * 4.0 + vnoise(p * 2.0, seed) * 2.0 + vnoise(p * 4.0, seed)) / 7.0;
}

vec4 bilin(vec2 p) {
    vec2 p0 = p - 0.5;
    vec2 i0 = floor(p0);
    vec2 f = p0 - i0;
    ivec2 maxCoord = ivec2(u_size) - ivec2(1);
    ivec2 c0 = clamp(ivec2(i0), ivec2(0), maxCoord);
    ivec2 c1 = clamp(ivec2(i0) + ivec2(1), ivec2(0), maxCoord);
    vec4 s00 = texelFetch(u_src, c0, 0);
    vec4 s10 = texelFetch(u_src, ivec2(c1.x, c0.y), 0);
    vec4 s01 = texelFetch(u_src, ivec2(c0.x, c1.y), 0);
    vec4 s11 = texelFetch(u_src, c1, 0);
    vec4 p00 = vec4(s00.rgb * s00.a, s00.a);
    vec4 p10 = vec4(s10.rgb * s10.a, s10.a);
    vec4 p01 = vec4(s01.rgb * s01.a, s01.a);
    vec4 p11 = vec4(s11.rgb * s11.a, s11.a);
    vec4 top = mix(p00, p10, f.x);
    vec4 bot = mix(p01, p11, f.x);
    vec4 res = mix(top, bot, f.y);
    return vec4(res.a > 1e-5 ? res.rgb / res.a : vec3(0.0), res.a);
}
`;

export const LR = 0.299, LG = 0.587, LB = 0.114;
export const luma = (r, g, b) => LR * r + LG * g + LB * b;
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const screen = (b, s) => 1 - (1 - b) * (1 - s);
export function sstep(a, b, x) { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }
export const mix = (a, b, t) => a + (b - a) * t;

function ihash(x) {
    x = (x ^ (x >>> 16)) >>> 0; x = Math.imul(x, 0x7feb352d) >>> 0;
    x = (x ^ (x >>> 15)) >>> 0; x = Math.imul(x, 0x846ca68b) >>> 0;
    return (x ^ (x >>> 16)) >>> 0;
}
export function hash2(x, y, seed) {
    const a = Math.imul(x >>> 0, 1597334677) >>> 0;
    const b = ihash((Math.imul(y >>> 0, 3812015801) ^ Math.imul(seed >>> 0, 2654435761)) >>> 0);
    return ihash((a ^ b) >>> 0) / 4294967295;
}
export function vnoise(px, py, seed) {
    const ix = Math.floor(px), iy = Math.floor(py);
    let fx = px - ix, fy = py - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
    return mix(mix(a, b, fx), mix(c, d, fx), fy);
}
export function fbm(px, py, seed) {
    return (vnoise(px, py, seed) * 4 + vnoise(px * 2, py * 2, seed) * 2 + vnoise(px * 4, py * 4, seed)) / 7;
}

export function bilinAt(d, W, H, x, y) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const cx0 = Math.max(0, Math.min(W - 1, x0));
    const cy0 = Math.max(0, Math.min(H - 1, y0));
    const cx1 = Math.max(0, Math.min(W - 1, x0 + 1));
    const cy1 = Math.max(0, Math.min(H - 1, y0 + 1));
    const i00 = (cy0 * W + cx0) * 4;
    const i10 = (cy0 * W + cx1) * 4;
    const i01 = (cy1 * W + cx0) * 4;
    const i11 = (cy1 * W + cx1) * 4;
    const a00 = d[i00 + 3] / 255;
    const r00 = (d[i00] / 255) * a00, g00 = (d[i00 + 1] / 255) * a00, b00 = (d[i00 + 2] / 255) * a00;
    const a10 = d[i10 + 3] / 255;
    const r10 = (d[i10] / 255) * a10, g10 = (d[i10 + 1] / 255) * a10, b10 = (d[i10 + 2] / 255) * a10;
    const a01 = d[i01 + 3] / 255;
    const r01 = (d[i01] / 255) * a01, g01 = (d[i01 + 1] / 255) * a01, b01 = (d[i01 + 2] / 255) * a01;
    const a11 = d[i11 + 3] / 255;
    const r11 = (d[i11] / 255) * a11, g11 = (d[i11 + 1] / 255) * a11, b11 = (d[i11 + 2] / 255) * a11;

    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;

    const pr = r00 * w00 + r10 * w10 + r01 * w01 + r11 * w11;
    const pg = g00 * w00 + g10 * w10 + g01 * w01 + g11 * w11;
    const pb = b00 * w00 + b10 * w10 + b01 * w01 + b11 * w11;
    const pa = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;

    const invA = pa > 1e-5 ? 1 / pa : 0;
    return [pr * invA, pg * invA, pb * invA, pa];
}

let toCanvas = (v) => v;
export function setResolve(fn) { if (typeof fn === "function") toCanvas = fn; }
export const resolve = (v) => toCanvas(v);

export function makeCanvas(w, h) {
    if (typeof document !== "undefined" && document.createElement) {
        const c = document.createElement("canvas");
        c.width = Math.max(1, w | 0);
        c.height = Math.max(1, h | 0);
        return c;
    }
    return { width: Math.max(1, w | 0), height: Math.max(1, h | 0) };
}

export function copyCanvas(src) {
    src = resolve(src);
    const out = makeCanvas(src.width, src.height);
    out.getContext("2d").drawImage(src, 0, 0);
    return out;
}

export function blur(src, sigma) {
    src = resolve(src);
    const W = src.width, H = src.height;
    if (sigma < 0.05) return copyCanvas(src);
    const pad = Math.min(W, H, Math.ceil(sigma * 3) + 2);
    const PW = W + 2 * pad, PH = H + 2 * pad;
    const padded = makeCanvas(PW, PH);
    const p = padded.getContext("2d");
    p.drawImage(src, pad, pad);
    p.save(); p.translate(pad, 0); p.scale(-1, 1); p.drawImage(src, 0, 0, pad, H, 0, pad, pad, H); p.restore();
    p.save(); p.translate(PW, 0); p.scale(-1, 1); p.drawImage(src, W - pad, 0, pad, H, 0, pad, pad, H); p.restore();
    p.save(); p.translate(0, pad); p.scale(1, -1); p.drawImage(src, 0, 0, W, pad, pad, 0, W, pad); p.restore();
    p.save(); p.translate(0, PH); p.scale(1, -1); p.drawImage(src, 0, H - pad, W, pad, pad, 0, W, pad); p.restore();
    p.save(); p.translate(pad, pad); p.scale(-1, -1); p.drawImage(src, 0, 0, pad, pad, 0, 0, pad, pad); p.restore();
    p.save(); p.translate(PW, pad); p.scale(-1, -1); p.drawImage(src, W - pad, 0, pad, pad, 0, 0, pad, pad); p.restore();
    p.save(); p.translate(pad, PH); p.scale(-1, -1); p.drawImage(src, 0, H - pad, pad, pad, 0, 0, pad, pad); p.restore();
    p.save(); p.translate(PW, PH); p.scale(-1, -1); p.drawImage(src, W - pad, H - pad, pad, pad, 0, 0, pad, pad); p.restore();
    const out = makeCanvas(W, H);
    const o = out.getContext("2d");
    try { o.filter = `blur(${sigma}px)`; } catch (_) { /* no filter support */ }
    o.drawImage(padded, -pad, -pad);
    o.filter = "none";
    o.globalCompositeOperation = "destination-over";
    o.drawImage(src, 0, 0);
    o.globalCompositeOperation = "source-over";
    return out;
}

export function open(src) {
    src = resolve(src);
    const W = src.width, H = src.height;
    const out = makeCanvas(W, H);
    const ctx = out.getContext("2d");
    ctx.drawImage(src, 0, 0);
    const img = ctx.getImageData(0, 0, W, H);
    return { out, ctx, img, d: img.data, W, H };
}

export function loop(src, fn, extra) {
    const { out, ctx, img, d, W, H } = open(src);
    const e = extra ? resolve(extra).getContext("2d").getImageData(0, 0, W, H).data : null;
    const c = [0, 0, 0], b = [0, 0, 0];
    for (let y = 0, i = 0, j = 0; y < H; y++) {
        for (let x = 0; x < W; x++, i += 4, j++) {
            c[0] = d[i] / 255; c[1] = d[i + 1] / 255; c[2] = d[i + 2] / 255;
            if (e) { b[0] = e[i] / 255; b[1] = e[i + 1] / 255; b[2] = e[i + 2] / 255; }
            fn(c, x, y, j, b);
            d[i] = Math.round(clamp01(c[0]) * 255); d[i + 1] = Math.round(clamp01(c[1]) * 255); d[i + 2] = Math.round(clamp01(c[2]) * 255);
        }
    }
    ctx.putImageData(img, 0, 0);
    return out;
}

export const num = (v, d) => (v == null || Number.isNaN(+v) ? d : +v);
export const pct = (v, d) => num(v, d) / 100;

export function makeRunner(scumble) {
    if (scumble.gl && scumble.gl.toCanvas) setResolve(scumble.gl.toCanvas);
    return (shaderDef, src, values, info, cpu) => {
        if (!info || !info.cpu) {
            const out = scumble.gl.shade(shaderDef, src, values, info || {});
            if (out) return out;
        }
        return cpu();
    };
}

export function shader(label, uniforms, code) {
    return { label, uniforms, code: PRELUDE + code };
}
