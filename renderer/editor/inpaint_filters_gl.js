// WebGL2 path for the filter layers: the point adjustments (levels, curves, brightness /
// contrast, hue / saturation, colour balance, black & white, invert), the 3D LUT and the
// grain run as one fragment shader pass instead of a getImageData / putImageData loop
// over every pixel. applyFilter() in inpaint_filters.js asks applyFilterGL() first and
// falls back to the CPU code when this returns null (no WebGL2, texture too large, a
// context loss, a GL error). The maths mirrors the CPU functions, including their 8-bit
// quantisation between steps, so both paths give the same picture within rounding.
//
// Blur, sharpen and vignette stay in inpaint_filters.js: they already run through
// ctx.filter and gradients, which the browser accelerates.
//
// App-side module for now (renderer/editor, not synced); it goes back into the node
// together with the applyFilter hook once it has proven itself here.

import { curvesToTables } from "./inpaint_curves.js";
import { levelsTable, brightnessContrastTable, hueSatMatrix, lightnessTable, colorBalanceTables, hueToRgb, LOOK_DEFAULT } from "./inpaint_filters.js";

const VS = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
uniform sampler2D u_src;
uniform sampler2D u_table;     // 256 x 1 RGBA8: one 8-bit table per channel
uniform sampler2D u_offsets;   // 256 x 1 RGBA32F: colour balance offsets by luma, in 0..255 units
uniform sampler2D u_noise;     // W x H RGBA8: the grain field
uniform sampler3D u_lut;       // N x N x N RGBA8, red fastest
uniform vec2 u_size;
uniform int u_mode;            // 0 tables, 1 matrix (+ table), 2 colour balance, 3 black & white, 4 lut, 5 grain
uniform mat3 u_matrix;
uniform bool u_useTable;
uniform vec3 u_weights;
uniform vec3 u_tint;
uniform float u_strength;
uniform float u_lutN;
uniform float u_k;             // grain: amount * gain
uniform float u_center;        // grain: noise centre, 0..255
uniform bool u_lookOn;
uniform bool u_useMix;
uniform mat3 u_mix;
uniform bool u_useMono;
uniform vec3 u_mono;
uniform vec3 u_wb;             // warmth red, tint green, warmth blue factors
uniform float u_satK;
uniform float u_conK;
uniform float u_fade;
uniform float u_lookStrength;
out vec4 o;

const vec3 LUMA = vec3(0.299, 0.587, 0.114);

// 8-bit rounding like a Uint8ClampedArray store between two CPU passes
vec3 q8(vec3 c) { return floor(clamp(c, 0.0, 1.0) * 255.0 + 0.5) / 255.0; }

vec3 tables(vec3 c) {
    vec3 i = (floor(c * 255.0 + 0.5) + 0.5) / 256.0;
    return vec3(texture(u_table, vec2(i.r, 0.5)).r, texture(u_table, vec2(i.g, 0.5)).g, texture(u_table, vec2(i.b, 0.5)).b);
}

vec3 look(vec3 c) {
    vec3 c0 = c;
    if (u_useMix) c = u_mix * c;
    if (u_useMono) { float l = dot(u_mono, c); c = vec3(l); }
    c *= u_wb;
    if (!u_useMono && u_satK != 1.0) { float l = dot(c, LUMA); c = l + (c - l) * u_satK; }
    if (u_conK != 1.0) c = 0.5 + (c - 0.5) * u_conK;
    if (u_fade != 0.0) c = u_fade + c * (1.0 - u_fade * 1.2);
    if (u_lookStrength < 1.0) c = c0 + (c - c0) * u_lookStrength;
    return clamp(c, 0.0, 1.0);
}

void main() {
    vec2 uv = gl_FragCoord.xy / u_size;
    vec2 suv = vec2(uv.x, 1.0 - uv.y);
    vec4 s = texture(u_src, suv);
    vec3 c = s.rgb;
    if (u_mode == 0) {
        c = tables(c);
    } else if (u_mode == 1) {
        c = q8(u_matrix * c);
        if (u_useTable) c = tables(c);
    } else if (u_mode == 2) {
        float l = floor(dot(c * 255.0, LUMA) + 0.5);
        vec3 d = texture(u_offsets, vec2((l + 0.5) / 256.0, 0.5)).rgb;
        c = (c * 255.0 + d) / 255.0;
    } else if (u_mode == 3) {
        float l = dot(c * 255.0, u_weights);
        float shape = l < 127.5 ? l / 127.5 : (255.0 - l) / 127.5;
        c = (vec3(l) + u_tint * shape) / 255.0;
    } else if (u_mode == 4) {
        vec3 t = texture(u_lut, (c * (u_lutN - 1.0) + 0.5) / u_lutN).rgb;
        c = c + (t - c) * u_strength;
    } else if (u_mode == 5) {
        if (u_lookOn) c = q8(look(c));
        if (u_k > 0.0) {
            vec3 nz = texture(u_noise, suv).rgb * 255.0;
            float lum = dot(c, LUMA);
            float w = u_k * (0.35 + 0.65 * (1.0 - abs(2.0 * lum - 1.0)));
            c = (c * 255.0 + (nz - u_center) * w) / 255.0;
        }
    }
    o = vec4(clamp(c, 0.0, 1.0), s.a);
}`;

const SUPPORTED = new Set(["levels", "curves", "brightness_contrast", "hue_sat", "color_balance", "bw", "invert", "lut", "grain"]);
const MAX_PIXELS = 64 * 1024 * 1024;   // beyond this a canvas read-back is the bottleneck anyway

let G = null;          // the shared context, created on first use
let unavailable = false;
const lutTextures = new WeakMap();   // lut object -> { tex, gen }

function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, w | 0);
    c.height = Math.max(1, h | 0);
    return c;
}

function copyCanvas(src) {
    const out = makeCanvas(src.width, src.height);
    out.getContext("2d").drawImage(src, 0, 0);
    return out;
}

function compile(gl, type, source) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error("shader: " + gl.getShaderInfoLog(sh));
    return sh;
}

function texture2d(gl, unit, filter) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
}

function context() {
    if (G && !G.lost) return G;
    if (unavailable) return null;
    try {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, depth: false, stencil: false, alpha: true, desynchronized: false });
        if (!gl) { unavailable = true; return null; }
        const gen = (G ? G.gen : 0) + 1;
        canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); if (G && G.gl === gl) G.lost = true; });
        const prog = gl.createProgram();
        gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("program: " + gl.getProgramInfoLog(prog));
        gl.useProgram(prog);
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        const aPos = gl.getAttribLocation(prog, "a_pos");
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        for (const pg of PLUGIN_GL.values()) pg.prog = null;   // programs of a lost context
        const u = {};
        for (const name of ["u_src", "u_table", "u_offsets", "u_noise", "u_lut", "u_size", "u_mode", "u_matrix", "u_useTable", "u_weights", "u_tint", "u_strength", "u_lutN", "u_k", "u_center",
            "u_lookOn", "u_useMix", "u_mix", "u_useMono", "u_mono", "u_wb", "u_satK", "u_conK", "u_fade", "u_lookStrength"]) u[name] = gl.getUniformLocation(prog, name);
        // fixed texture units: 0 source, 1 table, 2 offsets, 3 noise, 4 lut
        const texSrc = texture2d(gl, 0, gl.NEAREST);
        const texTable = texture2d(gl, 1, gl.NEAREST);
        const texOffsets = texture2d(gl, 2, gl.NEAREST);
        gl.uniform1i(u.u_src, 0); gl.uniform1i(u.u_table, 1); gl.uniform1i(u.u_offsets, 2); gl.uniform1i(u.u_noise, 3); gl.uniform1i(u.u_lut, 4);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.disable(gl.BLEND);
        const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        const maxView = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
        const max = Math.min(maxTex, maxView[0], maxView[1], gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
        const emptyNoise = texture2d(gl, 3, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]));
        const emptyLut = gl.createTexture();
        gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_3D, emptyLut);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
        G = { gl, canvas, prog, u, aPos, texSrc, texTable, texOffsets, emptyNoise, emptyLut, max, gen, lost: false, max3d: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) };
        return G;
    } catch (err) {
        console.warn("WebGL2 filters unavailable:", err.message || err);
        unavailable = true;
        return null;
    }
}

/** Upload one 8-bit table per channel as a 256 x 1 RGBA texture (unit 1). */
function setTables(g, tr, tg = tr, tb = tr) {
    const { gl } = g;
    const data = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) { data[i * 4] = tr[i]; data[i * 4 + 1] = tg[i]; data[i * 4 + 2] = tb[i]; data[i * 4 + 3] = 255; }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, g.texTable);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const INVERT_TABLE = (() => { const t = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) t[i] = 255 - i; return t; })();

/** Column-major mat3 for GLSL from a row-major 3x3 (applied as M * c). */
function mat3(m) {
    return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
}

// ---------------------------------------------------------------------------
// grain noise field (same algorithm as applyGrain in inpaint_filters.js, drawn into a
// canvas that becomes the noise texture; never read back to the CPU)
// ---------------------------------------------------------------------------

function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

function noiseCanvas(W, H, { usePlate, plate, sc, size, sigma, chroma, seed }) {
    const big = makeCanvas(W, H);
    const bctx = big.getContext("2d");
    if (usePlate) {
        const pat = bctx.createPattern(plate, "repeat");
        try { pat.setTransform(new DOMMatrix().scale(sc, sc)); } catch (_) { /* old browsers */ }
        bctx.fillStyle = pat;
        bctx.fillRect(0, 0, W, H);
        return big;
    }
    const gs = Math.max(1, size);
    const nw = Math.max(1, Math.round(W / gs)), nh = Math.max(1, Math.round(H / gs));
    const noise = makeCanvas(nw, nh);
    const nctx = noise.getContext("2d");
    const nd = nctx.createImageData(nw, nh);
    const d = nd.data;
    const rand = rng(hashString(String(seed || "grain")));
    const e1 = Math.exp(sigma * sigma / 2), norm = Math.sqrt((Math.exp(sigma * sigma) - 1) * Math.exp(sigma * sigma)) || 1;
    const gauss = () => { const u = Math.max(1e-12, rand()), v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const TN = 65536;
    const table = new Float32Array(TN);
    for (let i = 0; i < TN; i++) table[i] = (sigma > 0.005 ? (Math.exp(sigma * gauss()) - e1) / norm : gauss()) * 40;
    const sample = () => table[(rand() * TN) | 0];
    for (let i = 0; i < d.length; i += 4) {
        const g = sample();
        if (chroma <= 0) { d[i] = d[i + 1] = d[i + 2] = 128 + g; }
        else {
            d[i] = 128 + g * (1 - chroma) + sample() * chroma;
            d[i + 1] = 128 + g * (1 - chroma) + sample() * chroma;
            d[i + 2] = 128 + g * (1 - chroma) + sample() * chroma;
        }
        d[i + 3] = 255;
    }
    nctx.putImageData(nd, 0, 0);
    bctx.imageSmoothingEnabled = gs > 1;
    bctx.drawImage(noise, 0, 0, W, H);
    return big;
}

// ---------------------------------------------------------------------------
// per-filter setup: uniforms and textures. Return false for "nothing to do" (the CPU
// path returns a plain copy there too), null to hand over to the CPU.
// ---------------------------------------------------------------------------

const SETUP = {
    levels(g, p) {
        const { gl, u } = g;
        setTables(g, levelsTable(p));
        gl.uniform1i(u.u_mode, 0);
        return true;
    },
    curves(g, p, info, src) {
        const { gl, u } = g;
        // the curve editor draws a luma histogram of the input; a 256 px thumbnail is plenty for that
        if (info && info.cache) {
            const s = Math.min(1, 256 / Math.max(src.width, src.height));
            const tw = Math.max(1, Math.round(src.width * s)), th = Math.max(1, Math.round(src.height * s));
            const t = makeCanvas(tw, th);
            const tctx = t.getContext("2d");
            tctx.drawImage(src, 0, 0, tw, th);
            const px = tctx.getImageData(0, 0, tw, th).data;
            const hist = new Uint32Array(256);
            for (let i = 0; i < px.length; i += 4) hist[(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] + 0.5) | 0]++;
            info.cache.histogram = hist;
        }
        const tables = curvesToTables(p.curves);
        if (!tables) return false;
        setTables(g, tables.r, tables.g, tables.b);
        gl.uniform1i(u.u_mode, 0);
        return true;
    },
    brightness_contrast(g, p) {
        const { gl, u } = g;
        if (!(p.brightness ?? 0) && !(p.contrast ?? 0)) return false;
        setTables(g, brightnessContrastTable(p.brightness, p.contrast));
        gl.uniform1i(u.u_mode, 0);
        return true;
    },
    invert(g) {
        const { gl, u } = g;
        setTables(g, INVERT_TABLE);
        gl.uniform1i(u.u_mode, 0);
        return true;
    },
    hue_sat(g, p) {
        const { gl, u } = g;
        const hue = p.hue ?? 0, sat = p.saturation ?? 0, light = p.lightness ?? 0;
        if (!hue && !sat && !light) return false;
        const M = hue || sat ? hueSatMatrix(hue, Math.max(0, 1 + sat / 100)) : IDENTITY;
        gl.uniformMatrix3fv(u.u_matrix, false, mat3(M));
        gl.uniform1i(u.u_useTable, light ? 1 : 0);
        if (light) setTables(g, lightnessTable(light));
        gl.uniform1i(u.u_mode, 1);
        return true;
    },
    color_balance(g, p) {
        const { gl, u } = g;
        const keys = ["shadows_cr", "shadows_mg", "shadows_yb", "mid_cr", "mid_mg", "mid_yb", "high_cr", "high_mg", "high_yb"];
        if (keys.every((k) => !(p[k] ?? 0))) return false;
        const { dR, dG, dB } = colorBalanceTables(p);
        const data = new Float32Array(256 * 4);
        for (let i = 0; i < 256; i++) { data[i * 4] = dR[i]; data[i * 4 + 1] = dG[i]; data[i * 4 + 2] = dB[i]; data[i * 4 + 3] = 1; }
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, g.texOffsets);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 256, 1, 0, gl.RGBA, gl.FLOAT, data);
        gl.uniform1i(u.u_mode, 2);
        return true;
    },
    bw(g, p) {
        const { gl, u } = g;
        let wr = p.red ?? 30, wg = p.green ?? 59, wb = p.blue ?? 11;
        const sum = wr + wg + wb;
        if (sum > 0) { wr /= sum; wg /= sum; wb /= sum; } else { wr = 0.299; wg = 0.587; wb = 0.114; }
        const strength = Math.max(0, Math.min(1, (p.tint_strength ?? 0) / 100));
        let tr = 0, tg = 0, tb = 0;
        if (strength > 0) {
            const t = hueToRgb(p.tint_hue ?? 35);
            const A = 0.35 * 255 * strength;
            tr = (t[0] - 0.5) * A; tg = (t[1] - 0.5) * A; tb = (t[2] - 0.5) * A;
        }
        gl.uniform3f(u.u_weights, wr, wg, wb);
        gl.uniform3f(u.u_tint, tr, tg, tb);
        gl.uniform1i(u.u_mode, 3);
        return true;
    },
    lut(g, p, info) {
        const { gl, u } = g;
        const lut = info.lut;
        const strength = (p.strength ?? 100) / 100;
        if (!lut || !lut.data || strength <= 0) return false;
        const N = lut.size;
        if (!(N > 1) || N > g.max3d) return null;
        let entry = lutTextures.get(lut);
        if (!entry || entry.gen !== g.gen) {
            const data = new Uint8Array(N * N * N * 4);
            const src = lut.data;
            for (let i = 0, j = 0; i < N * N * N; i++, j += 3) {
                data[i * 4] = Math.max(0, Math.min(255, Math.round(src[j] * 255)));
                data[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(src[j + 1] * 255)));
                data[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(src[j + 2] * 255)));
                data[i * 4 + 3] = 255;
            }
            const tex = gl.createTexture();
            gl.activeTexture(gl.TEXTURE4);
            gl.bindTexture(gl.TEXTURE_3D, tex);
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
            gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, N, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
            entry = { tex, gen: g.gen };
            lutTextures.set(lut, entry);
        } else {
            gl.activeTexture(gl.TEXTURE4);
            gl.bindTexture(gl.TEXTURE_3D, entry.tex);
        }
        gl.uniform1f(u.u_lutN, N);
        gl.uniform1f(u.u_strength, strength);
        gl.uniform1i(u.u_mode, 4);
        return true;
    },
    grain(g, p, info, src) {
        const { gl, u } = g;
        const W = src.width, H = src.height;
        const amount = (p.amount ?? 25) / 100;
        const size = Math.max(0.5, (p.size ?? 1.5) * (info.scale || 1));
        const chroma = Math.min(1, Math.max(0, (p.chroma ?? (p.mono === false ? 100 : 0)) / 100));
        const lookStrength = Math.min(1, Math.max(0, (p.look_strength ?? 100) / 100));
        const lookOn = !!(p.look && lookStrength > 0);
        gl.uniform1i(u.u_lookOn, lookOn ? 1 : 0);
        if (lookOn) {
            const L = { ...LOOK_DEFAULT, ...p.look };
            const mix = Array.isArray(L.mix) && L.mix.length === 9 ? L.mix : null;
            const mono = Array.isArray(L.mono) && L.mono.length === 3 ? L.mono : null;
            gl.uniform1i(u.u_useMix, mix ? 1 : 0);
            gl.uniformMatrix3fv(u.u_mix, false, mat3(mix || IDENTITY));
            gl.uniform1i(u.u_useMono, mono ? 1 : 0);
            if (mono) { const s = mono[0] + mono[1] + mono[2] || 1; gl.uniform3f(u.u_mono, mono[0] / s, mono[1] / s, mono[2] / s); } else gl.uniform3f(u.u_mono, 0, 0, 0);
            gl.uniform3f(u.u_wb, 1 + L.warmth / 300, 1 - L.tint / 300, 1 - L.warmth / 300);
            gl.uniform1f(u.u_satK, 1 + L.sat / 100);
            gl.uniform1f(u.u_conK, 1 + L.contrast / 100);
            gl.uniform1f(u.u_fade, L.fade / 100);
            gl.uniform1f(u.u_lookStrength, lookStrength);
        }
        gl.uniform1i(u.u_mode, 5);
        if (amount <= 0) { gl.uniform1f(u.u_k, 0); return true; }
        const cache = info.cache || {};
        const usePlate = !!(info.plate && info.plate.width);
        const sigma = Math.max(0, Math.min(0.5, (p.speckle ?? 25) / 100 * 0.5));
        const sc = Math.max(0.1, (p.plate_scale ?? 1) * (info.scale || 1));
        const noiseKey = JSON.stringify(usePlate ? ["plate", info.plateKey || "", sc, W, H] : ["synth", size, sigma, chroma, String(info.seed || "grain"), W, H]);
        let center = 128, gain = 1.3;
        if (usePlate) { center = info.plateMean ?? 128; gain = 40 / Math.max(8, info.plateStd ?? 40); }
        gl.activeTexture(gl.TEXTURE3);
        if (cache.glNoise && cache.glNoise.key === noiseKey && cache.glNoise.gen === g.gen) {
            gl.bindTexture(gl.TEXTURE_2D, cache.glNoise.tex);
        } else {
            if (cache.glNoise && cache.glNoise.gen === g.gen) { try { gl.deleteTexture(cache.glNoise.tex); } catch (_) { /* ignore */ } }
            const big = noiseCanvas(W, H, { usePlate, plate: info.plate, sc, size, sigma, chroma, seed: info.seed });
            const tex = texture2d(gl, 3, gl.NEAREST);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, big);
            cache.glNoise = { key: noiseKey, tex, gen: g.gen };
        }
        gl.uniform1f(u.u_k, amount * gain);
        gl.uniform1f(u.u_center, center);
        return true;
    },
};

// ---- plugin filters: one fragment shader per registered filter (renderer/plugins.js) -------
//
// A plugin hands in GLSL that defines `vec4 shade(vec4 color, vec2 uv)` (`filter` is a
// reserved word in GLSL ES); it gets u_src
// (the input, sample neighbours with uv + vec2(dx, dy) / u_size), u_size, u_scale (1 at
// full resolution, smaller for previews) and u_seed, plus its own uniforms (declared by
// name and type, values from values(params, info) per run).

const PLUGIN_GL = new Map();   // id -> { def: { code, uniforms, values }, prog, u, failed }
const PLUGIN_TYPES = { float: "1f", int: "1i", bool: "1i", vec2: "2fv", vec3: "3fv", vec4: "4fv", sampler2D: "tex" };
const PLUGIN_TEX_UNIT = 5;     // plugin samplers start above the built-in units (0 source, 1 table, 2 offsets, 3 noise, 4 lut)
const ADHOC = new WeakMap();   // shader definition object -> program record (gl.shade for multi-pass plugin filters)

export function registerGLFilter(id, def) {
    for (const [name, type] of Object.entries(def.uniforms || {})) {
        if (!PLUGIN_TYPES[type]) throw new Error(`uniform ${name}: type must be one of ${Object.keys(PLUGIN_TYPES).join(", ")}`);
        if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`uniform "${name}" is not a valid GLSL name`);
    }
    PLUGIN_GL.set(id, { def, prog: null, u: null, failed: false });
}

export function unregisterGLFilter(id) {
    const pg = PLUGIN_GL.get(id);
    if (pg && pg.prog && G && !G.lost) { try { G.gl.deleteProgram(pg.prog); } catch (_) { /* ignore */ } }
    PLUGIN_GL.delete(id);
}

function pluginSource(def) {
    const decls = Object.entries(def.uniforms || {}).map(([n, t]) => `uniform ${t} ${n};`).join("\n");
    return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_src;
uniform vec2 u_size;
uniform float u_scale;
uniform float u_seed;
${decls}
out vec4 o;
${def.code}
void main() {
    vec2 uv = gl_FragCoord.xy / u_size;
    vec2 suv = vec2(uv.x, 1.0 - uv.y);
    o = shade(texture(u_src, suv), suv);
}`;
}

function pluginProgram(g, pg) {
    if (pg.prog && pg.gen === g.gen) return pg.prog;
    const { gl } = g;
    pg.gen = g.gen;
    pg.samplers = [];
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, pluginSource(pg.def)));
    gl.bindAttribLocation(prog, g.aPos, "a_pos");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("program: " + gl.getProgramInfoLog(prog));
    pg.prog = prog;
    pg.u = {};
    for (const name of ["u_src", "u_size", "u_scale", "u_seed", ...Object.keys(pg.def.uniforms || {})]) pg.u[name] = gl.getUniformLocation(prog, name);
    for (const [name, type] of Object.entries(pg.def.uniforms || {})) if (type === "sampler2D") pg.samplers.push({ name, unit: PLUGIN_TEX_UNIT + pg.samplers.length, tex: null });
    return prog;
}

/**
 * Upload one plugin sampler: a canvas / ImageData / image, or { data, width, height } with a
 * Uint8(Clamped)Array (RGBA8) or a Float32Array (RGBA32F, e.g. control point tables); `linear`
 * on the value picks bilinear filtering (8-bit sources only).
 */
function uploadSampler(gl, s, v) {
    gl.activeTexture(gl.TEXTURE0 + s.unit);
    if (!s.tex) s.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, s.tex);
    const isFloat = !!(v && v.data instanceof Float32Array);
    const f = v && v.linear && !isFloat ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (v && v.data && v.width) {
        const w = v.width | 0, h = (v.height | 0) || 1;
        if (isFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, v.data);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, v.data instanceof Uint8Array ? v.data : new Uint8Array(v.data.buffer, v.data.byteOffset, v.data.byteLength));
    } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, v.canvas || v.image || v);
    }
}

function applyPluginGL(id, pg, src, params, info, override) {
    if (pg.failed) return null;
    const g = context();
    if (!g) return null;
    const W = src.width, H = src.height;
    if (!W || !H || W > g.max || H > g.max || W * H > MAX_PIXELS) return null;
    const { gl } = g;
    try {
        const prog = pluginProgram(g, pg);
        gl.useProgram(prog);
        gl.uniform1i(pg.u.u_src, 0);
        gl.uniform1f(pg.u.u_scale, info.scale || 1);
        gl.uniform1f(pg.u.u_seed, +info.seed || 0);
        const values = override || pg.def.values(params || {}, info, src) || {};
        for (const [name, type] of Object.entries(pg.def.uniforms || {})) {
            const v = values[name];
            if (v == null || pg.u[name] == null) continue;
            const setter = PLUGIN_TYPES[type];
            if (setter === "tex") continue;
            if (setter === "1f") gl.uniform1f(pg.u[name], +v);
            else if (setter === "1i") gl.uniform1i(pg.u[name], v === true ? 1 : v === false ? 0 : Math.round(+v));
            else gl["uniform" + setter](pg.u[name], Float32Array.from(v));
        }
        for (const s of pg.samplers) {
            const v = values[s.name];
            if (v == null || pg.u[s.name] == null) continue;
            uploadSampler(gl, s, v);
            gl.uniform1i(pg.u[s.name], s.unit);
        }
        if (g.canvas.width !== W || g.canvas.height !== H) { g.canvas.width = W; g.canvas.height = H; }
        gl.viewport(0, 0, W, H);
        gl.uniform2f(pg.u.u_size, W, H);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, g.texSrc);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const err = gl.getError();
        if (err !== gl.NO_ERROR) { console.warn("plugin WebGL2 filter", id, "GL error", err); return null; }
        const out = makeCanvas(W, H);
        out.getContext("2d").drawImage(g.canvas, 0, 0);
        return out;
    } catch (err) {
        console.warn("plugin WebGL2 filter", id, "failed, using the CPU path:", err.message || err);
        if (gl.isContextLost && gl.isContextLost()) g.lost = true; else pg.failed = true;
        return null;
    }
}

/**
 * Run an ad-hoc shader (`{ code, uniforms, label }`, the same contract as a filter's `glsl`
 * block) on a canvas with the given uniform values; the program is compiled once per
 * definition object. For plugin filters that need several passes (blur between shader
 * stages, halation, control points). Returns the canvas, or null without a GPU path.
 */
export function runShader(def, src, values, info = {}) {
    if (!def || typeof def.code !== "string") throw new Error("gl.shade needs { code, uniforms } with the fragment defining vec4 shade(vec4 color, vec2 uv)");
    let pg = ADHOC.get(def);
    if (!pg) {
        for (const [name, type] of Object.entries(def.uniforms || {})) {
            if (!PLUGIN_TYPES[type]) throw new Error(`uniform ${name}: type must be one of ${Object.keys(PLUGIN_TYPES).join(", ")}`);
            if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`uniform "${name}" is not a valid GLSL name`);
        }
        pg = { def: { code: def.code, uniforms: def.uniforms || {}, values: () => ({}) }, prog: null, u: null, failed: false, label: def.label || "shader" };
        ADHOC.set(def, pg);
    }
    return applyPluginGL(pg.label, pg, src, {}, info, values || {});
}

/**
 * Apply filter `id` to `src` on the GPU. Returns the filtered canvas, or null when this
 * filter or this machine is not covered (the caller then runs the CPU code).
 */
export function applyFilterGL(id, src, params, info = {}) {
    if (!SUPPORTED.has(id)) { const pg = PLUGIN_GL.get(id); return pg ? applyPluginGL(id, pg, src, params, info) : null; }
    const g = context();
    if (!g) return null;
    const W = src.width, H = src.height;
    if (!W || !H || W > g.max || H > g.max || W * H > MAX_PIXELS) return null;
    const { gl, u } = g;
    try {
        gl.useProgram(g.prog);
        const ok = SETUP[id](g, params || {}, info, src);
        if (ok === false) return copyCanvas(src);
        if (ok === null) return null;
        if (g.canvas.width !== W || g.canvas.height !== H) { g.canvas.width = W; g.canvas.height = H; }
        gl.viewport(0, 0, W, H);
        gl.uniform2f(u.u_size, W, H);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, g.texSrc);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const err = gl.getError();
        if (err !== gl.NO_ERROR) { console.warn("WebGL2 filter", id, "GL error", err); return null; }
        const out = makeCanvas(W, H);
        out.getContext("2d").drawImage(g.canvas, 0, 0);
        return out;
    } catch (err) {
        console.warn("WebGL2 filter", id, "failed, using the CPU path:", err.message || err);
        if (gl.isContextLost && gl.isContextLost()) g.lost = true;
        return null;
    }
}

/** For the settings UI and tests: is the GPU path in use? */
export function glFiltersAvailable() {
    return !!context();
}

/** Tests: run a filter on the CPU and the GPU and report the difference. */
export function compareFilterPaths(cpuApply, id, src, params, info = {}) {
    const a = cpuApply(src, params, { ...info, cache: {} });
    const b = applyFilterGL(id, src, params, { ...info, cache: {} });
    if (!b) return { id, gl: false };
    const W = src.width, H = src.height;
    const pa = a.getContext("2d").getImageData(0, 0, W, H).data, pb = b.getContext("2d").getImageData(0, 0, W, H).data;
    let max = 0, sum = 0, n = 0, over2 = 0;
    for (let i = 0; i < pa.length; i++) {
        if ((i & 3) === 3) continue;
        const d = Math.abs(pa[i] - pb[i]);
        if (d > max) max = d;
        if (d > 2) over2++;
        sum += d; n++;
    }
    return { id, gl: true, max, mean: +(sum / n).toFixed(4), over2: +(over2 / n * 100).toFixed(3) };
}
