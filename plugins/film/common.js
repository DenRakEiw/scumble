// Film pack: helpers shared by the filters. Every filter has two paths that compute the
// same maths: a GLSL fragment (through scumble.gl.shade or the filter's glsl block) and a
// CPU pixel loop. The prelude below is prepended to every shader; the JS functions next to
// it are the same formulas for the CPU loop, so a change in one place has a twin.

export const PRELUDE = `
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
float luma(vec3 c) { return dot(c, LUMA); }
vec3 sat3(vec3 c) { return clamp(c, 0.0, 1.0); }
float screen(float b, float s) { return 1.0 - (1.0 - b) * (1.0 - s); }
vec3 screen3(vec3 b, vec3 s) { return 1.0 - (1.0 - b) * (1.0 - s); }
float softlight(float b, float s) { return (1.0 - 2.0 * s) * b * b + 2.0 * s * b; }
vec3 softlight3(vec3 b, vec3 s) { return (1.0 - 2.0 * s) * b * b + 2.0 * s * b; }
float sstep(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
// 8-bit table lookup (256 x 1 RGBA texture): the CPU path indexes t[round(v * 255)]
float tab(sampler2D t, float v, int ch) { vec4 s = texture(t, vec2((floor(clamp(v, 0.0, 1.0) * 255.0 + 0.5) + 0.5) / 256.0, 0.5)); return ch == 0 ? s.r : ch == 1 ? s.g : s.b; }
vec3 tab3(sampler2D t, vec3 c) { return vec3(tab(t, c.r, 0), tab(t, c.g, 1), tab(t, c.b, 2)); }
// pure hue (degrees) as rgb
vec3 hueRgb(float hue) {
    float h = mod(mod(hue, 360.0) + 360.0, 360.0) / 60.0;
    float x = 1.0 - abs(mod(h, 2.0) - 1.0);
    int k = int(floor(h)) % 6;
    return k == 0 ? vec3(1.0, x, 0.0) : k == 1 ? vec3(x, 1.0, 0.0) : k == 2 ? vec3(0.0, 1.0, x) : k == 3 ? vec3(0.0, x, 1.0) : k == 4 ? vec3(x, 0.0, 1.0) : vec3(1.0, 0.0, x);
}
// integer hash on the lattice (identical in JS), value noise on top
uint ihash(uint x) { x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u; return x; }
float hash2(int x, int y, int seed) { return float(ihash(uint(x) * 1597334677u ^ ihash(uint(y) * 3812015801u ^ uint(seed) * 2654435761u))) / 4294967295.0; }
float vnoise(vec2 p, int seed) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    int x = int(i.x), y = int(i.y);
    float a = hash2(x, y, seed), b = hash2(x + 1, y, seed), c = hash2(x, y + 1, seed), d = hash2(x + 1, y + 1, seed);
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

// ---- the same formulas in JS -----------------------------------------------------------------

export const LR = 0.299, LG = 0.587, LB = 0.114;
export const luma = (r, g, b) => LR * r + LG * g + LB * b;
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const screen = (b, s) => 1 - (1 - b) * (1 - s);
export const softlight = (b, s) => (1 - 2 * s) * b * b + 2 * s * b;
export function sstep(a, b, x) { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }
export const mix = (a, b, t) => a + (b - a) * t;

export function hueRgb(hue) {
    const h = (((hue % 360) + 360) % 360) / 60, x = 1 - Math.abs((h % 2) - 1);
    const k = Math.floor(h) % 6;
    return k === 0 ? [1, x, 0] : k === 1 ? [x, 1, 0] : k === 2 ? [0, 1, x] : k === 3 ? [0, x, 1] : k === 4 ? [x, 0, 1] : [1, 0, x];
}

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

// ---- canvases ---------------------------------------------------------------------------------

// With the editor's GPU filter chain a stage's input can be a texture (a surface) instead of a
// canvas; makeRunner() installs the resolver, and everything below that reads pixels calls it.
let toCanvas = (v) => v;

/** Called by makeRunner(scumble): how to turn a GPU surface into a canvas. */
export function setResolve(fn) { if (typeof fn === "function") toCanvas = fn; }

/** A stage's input as something drawImage / getImageData can read. */
export const resolve = (v) => toCanvas(v);

export function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, w | 0);
    c.height = Math.max(1, h | 0);
    return c;
}

export function copyCanvas(src) {
    src = toCanvas(src);
    const out = makeCanvas(src.width, src.height);
    out.getContext("2d").drawImage(src, 0, 0);
    return out;
}

/** Read a canvas as ImageData plus a canvas to write the result into. */
export function open(src) {
    src = toCanvas(src);
    const W = src.width, H = src.height;
    const out = makeCanvas(W, H);
    const ctx = out.getContext("2d");
    ctx.drawImage(src, 0, 0);
    const img = ctx.getImageData(0, 0, W, H);
    return { out, ctx, img, d: img.data, W, H };
}

/**
 * CPU pixel loop: fn(c, x, y, i) gets the pixel as [r, g, b] in 0..1 (mutable, written back
 * rounded to 8 bit) plus its position and index; `extra` (another canvas of the same size,
 * e.g. a blurred copy) is handed in as a second [r, g, b].
 */
export function loop(src, fn, extra) {
    const { out, ctx, img, d, W, H } = open(src);
    const e = extra ? toCanvas(extra).getContext("2d").getImageData(0, 0, W, H).data : null;
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

/**
 * Gaussian blur through ctx.filter on a canvas padded with mirrored copies of the source, so
 * edges blur into themselves. sigma in pixels of `src` (scale it with info.scale first).
 */
export function blur(src, sigma) {
    src = toCanvas(src);   // ctx.filter needs a canvas: this is the one place a GPU chain touches down
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

// ---- tables -----------------------------------------------------------------------------------

/** A 256-entry 8-bit table from fn(v in 0..1) -> 0..1. */
export function table(fn) {
    const t = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) t[i] = Math.round(clamp01(fn(i / 255)) * 255);
    return t;
}

/** Three tables as one 256 x 1 RGBA texture value for a sampler2D uniform. */
export function tablesTexture(tr, tg = tr, tb = tr) {
    const data = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) { data[i * 4] = tr[i]; data[i * 4 + 1] = tg[i]; data[i * 4 + 2] = tb[i]; data[i * 4 + 3] = 255; }
    return { data, width: 256, height: 1 };
}

/** CPU twin of tab(): t[round(v * 255)] / 255. */
export const lookup = (t, v) => t[Math.round(clamp01(v) * 255)] / 255;

/**
 * Monotone cubic interpolation (Fritsch-Carlson) through [x, y] points in 0..1, as a
 * function of x; used for the cross-processing curves.
 */
export function monotone(points) {
    const pts = points.slice().sort((a, b) => a[0] - b[0]);
    const n = pts.length;
    if (n < 2) return (x) => x;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const dx = [], dy = [], m = [];
    for (let i = 0; i < n - 1; i++) { dx.push(xs[i + 1] - xs[i] || 1e-6); dy.push(ys[i + 1] - ys[i]); m.push(dy[i] / dx[i]); }
    const t = [m[0]];
    for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
    t.push(m[n - 2]);
    for (let i = 0; i < n - 1; i++) {
        if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
        const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
        if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
    }
    return (x) => {
        if (x <= xs[0]) return ys[0];
        if (x >= xs[n - 1]) return ys[n - 1];
        let i = 0;
        while (i < n - 2 && x > xs[i + 1]) i++;
        const h = dx[i], u = (x - xs[i]) / h;
        const h00 = (1 + 2 * u) * (1 - u) * (1 - u), h10 = u * (1 - u) * (1 - u), h01 = u * u * (3 - 2 * u), h11 = u * u * (u - 1);
        return h00 * ys[i] + h10 * h * t[i] + h01 * ys[i + 1] + h11 * h * t[i + 1];
    };
}

/**
 * Parametric film tone curve: a toe that compresses shadows, a shoulder that rolls off
 * highlights, an S-curve for contrast (negative flattens) and a fade that lifts the blacks.
 */
export function toneCurve({ contrast = 0, toe = 0, shoulder = 0, fade = 0 } = {}) {
    return (v) => {
        let t = clamp01(v);
        if (toe > 0) t = t * (t + toe) / (1 + toe);
        if (shoulder > 0) { const u = 1 - t; t = 1 - u * (u + shoulder) / (1 + shoulder); }
        if (contrast > 0) { const s = t * t * (3 - 2 * t); t = mix(t, s, Math.min(1, contrast)); }
        else if (contrast < 0) t = 0.5 + (t - 0.5) * (1 + Math.max(-0.8, contrast));
        if (fade) t = fade + t * (1 - fade * 1.2);
        return clamp01(t);
    };
}

// ---- parameter helpers ------------------------------------------------------------------------

export const num = (v, d) => (v == null || Number.isNaN(+v) ? d : +v);
export const pct = (v, d) => num(v, d) / 100;

/** The plugin's select tooltips carry the trademark note (decided 2026-09-08). */
export const TRADEMARK = "Film names are trademarks of their owners; the looks are Scumble's own parametric approximations, not licensed products or measured profiles.";

/**
 * A two-path runner bound to the plugin API: run(shader, src, values, info, cpu) tries the
 * GPU (unless info.cpu is set) and falls back to cpu() otherwise. `shader` objects must be
 * module constants (the program is cached per object).
 */
export function makeRunner(scumble) {
    if (scumble.gl && scumble.gl.toCanvas) setResolve(scumble.gl.toCanvas);
    return (shader, src, values, info, cpu) => {
        if (!info || !info.cpu) {
            const out = scumble.gl.shade(shader, src, values, info || {});
            if (out) return out;
        }
        return cpu();
    };
}

/** Build a shader definition: prelude + code, uniforms, label. */
export function shader(label, uniforms, code) {
    return { label, uniforms, code: PRELUDE + code };
}
