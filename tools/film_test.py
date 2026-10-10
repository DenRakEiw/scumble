"""Film pack plugin test against the running app (see tools/cdp.py for the setup).

No ComfyUI needed: loads the test image from the local mirror, then checks every film filter
on the GPU and the CPU path (same maths, at most two levels apart), the film look presets,
the commands film.looks / film.apply_look / film.add_point, the control point tool through
the pointer and key hooks (place, resize, move, delete, undo), the control points following a
crop, a resize and a turn of the whole picture (and a straighten's matrix sent by hand), the
layer-row control, the Film looks panel thumbnails and the exports. Writes one PNG per filter
to out_dir/film.

    python tools/film_test.py [out_dir]
"""
import asyncio
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "dist", "smoke"))
os.makedirs(os.path.join(OUT, "film"), exist_ok=True)
FILM_DIR = json.dumps(os.path.join(OUT, "film").replace(os.sep, "/"))

STEPS = [
    ("plugin_loaded", """
const P = await import("./plugins.js");
const list = await P.pluginHost.list();
const film = list.find((p) => p.id === "film");
if (!film) throw new Error("film plugin not listed: " + list.map((p) => p.id));
if (film.error) throw new Error("film plugin error: " + film.error);
const types = await c("filter_types");
const ids = types.filters.filter((f) => f.plugin === "film").map((f) => f.id);
const want = ["film.look", "film.halation", "film.glow", "film.tonal_contrast", "film.structure", "film.bleach_bypass", "film.cross_process", "film.split_tone", "film.light_leak", "film.frame", "film.bw", "film.points"];
const missing = want.filter((w) => !ids.includes(w));
if (missing.length) throw new Error("filters missing: " + missing);
const cmds = (await c("list_commands")).commands.map((x) => x.name);
for (const n of ["film.looks", "film.apply_look", "film.add_point"]) if (!cmds.includes(n)) throw new Error("command missing: " + n);
return { filters: ids.length, commands: 3 };
"""),
    ("document", """
const d = await c("new_document");
window.__filmDoc = d.id;
const r = await fetch("/comfy/view?filename=test_base.png&subfolder=inpaint_canvas&type=input");
if (r.status !== 200) throw new Error("test image " + r.status + " (run the smoke test once so it is in the mirror)");
const s = await c("load_image", { filename: "test_base.png", subfolder: "inpaint_canvas", type: "input", doc: d.id });
return { width: s.width, height: s.height };
"""),
    ("gpu_vs_cpu", """
const F = await import("./editor/inpaint_filters.js");
const GL = await import("./editor/inpaint_filters_gl.js");
const src = editor.flattenToCanvas({ forRun: true });
const W = src.width, H = src.height;
const cases = {
  "film.look": [{ preset: "portra400" }, { preset: "velvia50", push: 1 }, { preset: "trix400" }, { preset: "cinestill800t" }, { preset: "custom", contrast: 20, warmth: 20 }, { preset: "portra400", limit: { source: "luma", lo: 0.3, hi: 0.7, fLo: 0.1, fHi: 0.1 } }],
  "film.halation": [{ strength: 80, radius: 20, threshold: 55 }],
  "film.glow": [{ mode: "soft", amount: 80 }, { mode: "screen", amount: 60, threshold: 50 }, { mode: "lighten", amount: 60 }],
  "film.tonal_contrast": [{ highlights: 60, midtones: 70, shadows: 60 }],
  "film.structure": [{ amount: 100, radius: 4 }, { amount: -100, radius: 6, luminance: false }],
  "film.bleach_bypass": [{}],
  "film.cross_process": [{ style: "e6c41" }, { style: "c41e6", shift: 40 }, { style: "lomo" }, { style: "cool" }],
  "film.split_tone": [{ hi_sat: 70, sh_sat: 70 }, { preserve: false, balance: 40 }],
  "film.light_leak": [{ style: "edge" }, { style: "streak" }, { style: "corner" }, { style: "double" }, { style: "bars", seed: 5 }],
  "film.frame": [{ style: "line" }, { style: "matte" }, { style: "rebate", radius: 6 }, { style: "slide", colour: "cream" }, { style: "instant" }, { style: "rough", roughness: 80 }, { style: "oval", softness: 30 }],
  "film.bw": [{ preset: "red", filter_hue: 10, filter_strength: 90, structure: 50 }, { tone: "sepia", tone_strength: 80, grain: 40 }, { tone: "split", tone_strength: 100, structure: -50 }],
  "film.points": [
    { points: [{ id: 1, x: 130, y: 120, r: 110, tol: 60, ev: 1.2, contrast: 10, sat: 40, warmth: 40, structure: 30, color: [0.4, -0.2, 0.3] }, { id: 2, x: 380, y: 250, r: 120, tol: 60, ev: -1, contrast: 30, sat: -60, warmth: -40, structure: 0, color: [0.5, 0.3, -0.1] }] },
    { points: [{ id: 1, shape: "ellipse", x: 200, y: 150, r: 120, ry: 60, angle: 30, soft: 40, tol: 60, ev: 0.8, contrast: 20, sat: -30, warmth: 20, structure: 0, color: [0.4, -0.2, 0.3] }] },
    { points: [{ id: 1, shape: "circle", x: 250, y: 180, r: 100, soft: 0, tol: 60, ev: 1.0, contrast: 15, sat: 20, warmth: 10, structure: 0, color: [0.5, 0.1, -0.1] }] },
    { points: [{ id: 1, shape: "circle", x: 250, y: 180, r: 100, soft: 100, tol: 60, ev: -0.8, contrast: -20, sat: -40, warmth: -20, structure: 0, color: [0.5, 0.1, -0.1] }] },
    { points: [{ id: 1, shape: "polygon", x: 220, y: 160, r: 30, soft: 50, tol: 60, ev: 0.8, contrast: 20, sat: 30, warmth: 20, structure: 0, color: [0.5, 0.1, -0.1], pts: [[200, 100], [225, 130], [260, 110], [250, 140], [290, 150], [260, 170], [280, 200], [240, 195], [230, 230], [210, 200], [180, 220], [190, 185], [150, 180], [180, 160], [160, 130], [195, 140]] }] },
    { points: [{ id: 1, shape: "line", x: 250, y: 180, angle: 120, r: 60, soft: 75, tol: 60, ev: 1.0, contrast: -20, sat: 40, warmth: -20, structure: 0, color: [0.5, 0.1, -0.1] }] },
  ],
};
const out = {}, bad = [];
for (const [id, list] of Object.entries(cases)) {
  for (const over of list) {
    const p = { ...F.filterDefaults(id), ...over };
    const a = F.applyFilter(id, src, p, { cpu: true, scale: 1, seed: 7, cache: {} });
    const b = F.applyFilter(id, src, p, { scale: 1, seed: 7, cache: {} });
    const pa = a.getContext("2d").getImageData(0, 0, W, H).data, pb = b.getContext("2d").getImageData(0, 0, W, H).data, ps = src.getContext("2d").getImageData(0, 0, W, H).data;
    if (id === "film.points" && list.indexOf(over) === 0) {
      const buf = await crypto.subtle.digest("SHA-256", pa);
      const sha = Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, "0")).join("");
      if (sha !== "47c19741e47fe18862de489e5c9e5fad2f6bb6353fbe5e002b72eaf28906510a") {
        bad.push("film.points case 1 SHA mismatch: " + sha);
      }
    }
    let max = 0, over2 = 0, n = 0, changed = 0;
    for (let i = 0; i < pa.length; i++) { if ((i & 3) === 3) continue; const df = Math.abs(pa[i] - pb[i]); if (df > max) max = df; if (df > 2) over2++; if (pa[i] !== ps[i]) changed++; n++; }
    const key = id + " " + JSON.stringify(over).slice(0, 40);
    out[key] = { max, over2: +(over2 / n * 100).toFixed(3), changed: +(changed / n * 100).toFixed(1) };
    if (GL.glFiltersAvailable() && (max > 4 || over2 / n > 0.001)) bad.push(key + " " + JSON.stringify(out[key]));
    if (changed === 0) bad.push(key + " changed nothing");
  }
}
const warn = (window.__log || []).filter((l) => /WebGL2 filter film|plugin film/.test(l[1]));
if (warn.length) bad.push("console: " + warn.map((l) => l[1].slice(0, 120)).join(" | "));
if (bad.length) throw new Error(bad.join("; "));
return { cases: Object.keys(out).length, gl: GL.glFiltersAvailable(), worst: Math.max(...Object.values(out).map((o) => o.max)) };
"""),
    ("points_structure_above_the_drawing_buffer", """
const F = await import("./editor/inpaint_filters.js");
const GL = await import("./editor/inpaint_filters_gl.js");
GL.glTestLimits({ maxDraw: 1e6 });
try {
    const W = 1600, H = 1200;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, "#f06"); g.addColorStop(0.5, "#4a9"); g.addColorStop(1, "#0af");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const params = {
        ...F.filterDefaults("film.points"),
        points: [{ id: 1, x: 800, y: 600, r: 400, tol: 60, ev: 0.5, contrast: 20, sat: 30, warmth: 20, structure: 50, color: [0.5, 0.1, -0.2] }],
    };
    const a = F.applyFilter("film.points", cv, params, { cpu: true, scale: 1, seed: 7, cache: {} });
    const b = F.applyFilter("film.points", cv, params, { scale: 1, seed: 7, cache: {} });
    const pa = a.getContext("2d").getImageData(0, 0, W, H).data;
    const pb = b.getContext("2d").getImageData(0, 0, W, H).data;
    const buf = await crypto.subtle.digest("SHA-256", pa);
    const sha = Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, "0")).join("");
    if (sha !== "d71190e1b0450c3192a5da9b06064b5f9ca32cc42591a9232008526c16203c67") {
        throw new Error("points_structure_above_the_drawing_buffer SHA mismatch: " + sha);
    }
    let max = 0, over2 = 0, n = 0;
    for (let i = 0; i < pa.length; i++) {
        if ((i & 3) === 3) continue;
        const df = Math.abs(pa[i] - pb[i]);
        if (df > max) max = df;
        if (df > 2) over2++;
        n++;
    }
    const over2Pct = over2 / n * 100;
    if (GL.glFiltersAvailable() && (max > 4 || over2 / n > 0.001)) {
        throw new Error(`points_structure_above_the_drawing_buffer tolerance exceeded: max=${max}, over2=${over2Pct.toFixed(3)}%`);
    }
    // Re-run with an ellipse
    const elParams = {
        ...F.filterDefaults("film.points"),
        points: [{ id: 1, shape: "ellipse", x: 800, y: 600, r: 400, ry: 240, angle: 25, soft: 50, tol: 60, ev: 0.5, contrast: 20, sat: 30, warmth: 20, structure: 50, color: [0.5, 0.1, -0.2] }],
    };
    const aEl = F.applyFilter("film.points", cv, elParams, { cpu: true, scale: 1, seed: 7, cache: {} });
    const bEl = F.applyFilter("film.points", cv, elParams, { scale: 1, seed: 7, cache: {} });
    const paEl = aEl.getContext("2d").getImageData(0, 0, W, H).data;
    const pbEl = bEl.getContext("2d").getImageData(0, 0, W, H).data;
    let maxEl = 0, over2El = 0;
    for (let i = 0; i < paEl.length; i++) {
        if ((i & 3) === 3) continue;
        const df = Math.abs(paEl[i] - pbEl[i]);
        if (df > maxEl) maxEl = df;
        if (df > 2) over2El++;
    }
    const over2ElPct = over2El / n * 100;
    if (GL.glFiltersAvailable() && (maxEl > 4 || over2El / n > 0.001)) {
        throw new Error(`ellipse points_structure tolerance exceeded: max=${maxEl}, over2=${over2ElPct.toFixed(3)}%`);
    }
    return { max, over2: +over2Pct.toFixed(3), maxEl, over2El: +over2ElPct.toFixed(3), pixels: W * H };
} finally {
    GL.glTestLimits(null);
}
"""),
    ("points_24mp_band_measure", """
const F = await import("./editor/inpaint_filters.js");
const GL = await import("./editor/inpaint_filters_gl.js");

// Build 64 polygon points of 16 corners each on a 15000 x 10000 document
const points = [];
for (let i = 0; i < 64; i++) {
    const cx = 800 + (i % 8) * 1800;
    const cy = 600 + Math.floor(i / 8) * 1100;
    const pts = [];
    for (let k = 0; k < 16; k++) {
        const theta = (k * 2 * Math.PI) / 16;
        const rad = (k % 2 === 0) ? 200 : 100;
        pts.push([cx + rad * Math.cos(theta), cy + rad * Math.sin(theta)]);
    }
    points.push({
        id: i + 1,
        shape: "polygon",
        x: cx,
        y: cy,
        r: 30,
        soft: 50,
        tol: 60,
        ev: 0.5,
        contrast: 10,
        sat: 20,
        warmth: 10,
        structure: 0,
        color: [0.5, 0.1, -0.1],
        pts,
    });
}

// 24 MP band: 6000 x 4000 = 24,000,000 px
const bandW = 6000, bandH = 4000;
const canvas = document.createElement("canvas");
canvas.width = bandW;
canvas.height = bandH;
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#888888";
ctx.fillRect(0, 0, bandW, bandH);

const layer = {
    id: "bench_pts",
    kind: "filter",
    filter: "film.points",
    params: { points, strength: 100 },
};

// Measure GPU time of one 24 MP band through film.points (budget <= 150 ms)
let gpuMs = 0;
if (GL.glFiltersAvailable()) {
    editor.bandFilter(layer, canvas, [0, 0], true);
    const t0 = performance.now();
    editor.bandFilter(layer, canvas, [0, 0], true);
    gpuMs = performance.now() - t0;
}

// CPU fallback reported
const cpuCrop = document.createElement("canvas");
cpuCrop.width = 256; cpuCrop.height = 256;
const tCpu0 = performance.now();
F.applyFilter("film.points", cpuCrop, layer.params, { cpu: true, scale: 1, seed: 7, cache: {} });
const cpuCropMs = performance.now() - tCpu0;
const cpu24mpEstMs = cpuCropMs * (24000000 / (256 * 256));

if (GL.glFiltersAvailable() && gpuMs > 150) {
    throw new Error(`24 MP band GPU time exceeded 150 ms budget: ${gpuMs.toFixed(1)} ms`);
}
return { gpuMs: +gpuMs.toFixed(1), cpu24mpEstMs: +cpu24mpEstMs.toFixed(1), gl: GL.glFiltersAvailable(), passBudget: !GL.glFiltersAvailable() || gpuMs <= 150 };
"""),
    ("gl_scratch_and_static_cache", """
const GL = await import("./editor/inpaint_filters_gl.js");
if (!GL.glFiltersAvailable()) return { skipped: "no webgl2" };

// 1. An ad-hoc runShader with three constant-colour samplers after glReleasePool()
// so that createSurface happens between bind and draw, returning their sum exactly.
GL.glReleasePool();
const def3 = {
    code: `
        vec4 shade(vec4 c, vec2 uv) {
            return texture(s1, uv) + texture(s2, uv) + texture(s3, uv);
        }
    `,
    uniforms: { s1: "sampler2D", s2: "sampler2D", s3: "sampler2D" },
    label: "sum3",
};
const cvSrc = document.createElement("canvas"); cvSrc.width = 2; cvSrc.height = 2;
const s1 = { data: new Uint8Array([10, 20, 30, 255]), width: 1, height: 1 };
const s2 = { data: new Uint8Array([40, 50, 60, 255]), width: 1, height: 1 };
const s3 = { data: new Uint8Array([70, 80, 90, 255]), width: 1, height: 1 };
const out3 = GL.runShader(def3, cvSrc, { s1, s2, s3 });
const pix3 = out3.getContext("2d").getImageData(0, 0, 1, 1).data;
const expected3 = [120, 150, 180, 255];
for (let i = 0; i < 3; i++) {
    if (Math.abs(pix3[i] - expected3[i]) > 1) {
        throw new Error(`sum3 sampler failed at ${i}: expected ${expected3[i]}, got ${pix3[i]}`);
    }
}

// 2. The same static value twice adds 1 to G.uploads; a new key adds 1 more; a WEBGL_lose_context round re-uploads.
const G = GL.G || GL.glContext();
const u0 = G.uploads;
const staticData = new Uint8Array([11, 22, 33, 255]);
const staticVal = { data: staticData, width: 1, height: 1, static: true, key: "k1" };
const defStat = {
    code: `vec4 shade(vec4 c, vec2 uv) { return texture(s, uv); }`,
    uniforms: { s: "sampler2D" },
    label: "static_test",
};
GL.runShader(defStat, cvSrc, { s: staticVal });
const u1 = G.uploads;
if (u1 !== u0 + 1) throw new Error(`first static upload expected uploads=${u0 + 1}, got ${u1}`);

GL.runShader(defStat, cvSrc, { s: staticVal });
const u2 = G.uploads;
if (u2 !== u1) throw new Error(`second static upload expected no upload (${u1}), got ${u2}`);

staticVal.key = "k2";
GL.runShader(defStat, cvSrc, { s: staticVal });
const u3 = G.uploads;
if (u3 !== u2 + 1) throw new Error(`new key static upload expected ${u2 + 1}, got ${u3}`);

// Context loss round
const ext = G.gl.getExtension("WEBGL_lose_context");
if (ext) {
    ext.loseContext();
    GL.runShader(defStat, cvSrc, { s: staticVal });
    const G2 = GL.G || GL.glContext();
    if (G2.uploads !== 1) throw new Error(`after context lost expected 1 upload, got ${G2.uploads}`);
}

return { sum3: Array.from(pix3), uploads: { u0, u1, u2, u3 } };
"""),
    ("gl_u16_sampling", """
const GL = await import("./editor/inpaint_filters_gl.js");
const W = await import("./editor/inpaint_weights.js");
if (!GL.glFiltersAvailable()) return { skipped: "no webgl2" };

// SAMPLE_GLSL against F3's u16Bilinear on a 5 x 3 map at 1,000 random points, within 1 level after 8-bit quantisation
const mw = 5, mh = 3;
const u16 = new Uint16Array(mw * mh);
const vals = [
    1200, 15400, 32000, 48000, 65000,
    8000, 22000, 41000, 55000, 62000,
    3000, 18000, 37000, 51000, 64000,
];
for (let i = 0; i < 15; i++) u16[i] = vals[i];
const u8 = new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength);

let seed = 42;
function rng() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
}
const N = 1000;
const ptsData = new Float32Array(N * 4);
for (let i = 0; i < N; i++) {
    ptsData[i * 4] = rng() * 5.0;
    ptsData[i * 4 + 1] = rng() * 3.0;
    ptsData[i * 4 + 2] = 0;
    ptsData[i * 4 + 3] = 1;
}

const mapSampler = { data: u8, width: mw, height: mh, channels: 2 };
const ptsSampler = { data: ptsData, width: N, height: 1, channels: 4 };

const defSample = {
    code: `
        ${GL.SAMPLE_GLSL}
        vec4 shade(vec4 c, vec2 uv) {
            ivec2 coord = ivec2(gl_FragCoord.xy);
            vec2 pt = texelFetch(u_pts, coord, 0).xy;
            float val = u16Bilinear(u_map, pt);
            return vec4(val, val, val, 1.0);
        }
    `,
    uniforms: { u_map: "sampler2D", u_pts: "sampler2D" },
    label: "u16_sample_test",
};

const cvSample = document.createElement("canvas"); cvSample.width = N; cvSample.height = 1;
const outSample = GL.runShader(defSample, cvSample, { u_map: mapSampler, u_pts: ptsSampler });
const sampleData = outSample.getContext("2d").getImageData(0, 0, N, 1).data;

let worstDiff = 0, diffCount = 0;
for (let i = 0; i < N; i++) {
    const px = ptsData[i * 4], py = ptsData[i * 4 + 1];
    const jsNorm = W.u16Bilinear(u16, mw, mh, px, py);
    const jsByte = Math.round(jsNorm * 255);
    const glByte = sampleData[i * 4];
    const diff = Math.abs(jsByte - glByte);
    if (diff > worstDiff) worstDiff = diff;
    if (diff > 1) {
        throw new Error(`point ${i} (${px.toFixed(2)}, ${py.toFixed(2)}): js=${jsByte}, gl=${glByte}, diff=${diff} > 1`);
    }
    if (diff > 0) diffCount++;
}

return { points: N, worstDiff, diffCount };
"""),
    ("look_commands", """
// docs/PLAN_0_1_42.md F1: "None (adjustments only)" adds no grain (it fell back to grain 25 without a stock). Its Grain
// slider at 0, at its default and at 200 % gives the same bytes, on the CPU and on the GPU path
const F = await import("./editor/inpaint_filters.js");
const src = editor.flattenToCanvas({ forRun: true });
const W = src.width, H = src.height;
const noneGrain = {};
for (const cpu of [true, false]) {
    const at = (grain) => F.applyFilter("film.look", src, { ...F.filterDefaults("film.look"), preset: "none", ...(grain == null ? {} : { grain }) }, { cpu, scale: 1, seed: 7, cache: {} }).getContext("2d").getImageData(0, 0, W, H).data;
    const a = at(0), b = at(null), d = at(200);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] || a[i] !== d[i]) diff++;
    noneGrain[cpu ? "cpu" : "gpu"] = diff;
    if (diff) throw new Error(`None's grain slider changed ${diff} bytes on the ${cpu ? "CPU" : "GPU"} path: None adds grain`);
}
const looks = await c("film.looks");
if (!looks.stocks || looks.stocks.length < 40) throw new Error("film.looks: " + JSON.stringify(looks).slice(0, 100));
const bw = await c("film.looks", { group: "Black & white" });
if (!bw.stocks.length || bw.stocks.some((s) => s.group !== "Black & white")) throw new Error("group filter");
const l1 = await c("film.apply_look", { preset: "portra400", strength: 80 });
if (l1.filter !== "film.look" || l1.params.preset !== "portra400" || l1.params.strength !== 80) throw new Error("apply_look add: " + JSON.stringify(l1));
await c("set_active_layer", { layer: l1.id });
const l2 = await c("film.apply_look", { preset: "velvia50" });
if (l2.id !== l1.id || l2.params.preset !== "velvia50") throw new Error("apply_look should change the active look layer: " + JSON.stringify(l2));
const layers = (await c("list_layers")).layers;
const lk = layers.find((l) => l.id === l1.id);
if (!lk || !/Velvia/.test(lk.name)) throw new Error("layer not renamed: " + (lk && lk.name));
let bad = null;
try { await c("film.apply_look", { preset: "nope" }); } catch (e) { bad = e.message; }
if (!bad) throw new Error("unknown stock accepted");
// undo takes the preset change back
await c("undo");
const back = (await c("list_layers")).layers.find((l) => l.id === l1.id);
if (!back || back.params.preset !== "portra400") throw new Error("undo: " + JSON.stringify(back && back.params));
await c("remove_layer", { layer: l1.id });
return { stocks: looks.stocks.length, bw: bw.stocks.length, noneGrain };
"""),
    ("add_point_command", """
// C6 (c1): a point's colour is the 3 x 3 mean under it of the points layer's input (everything below that layer) at
// full resolution, read as one small box: no whole flatten, no mirror, and not the picture the last full-resolution
// render left (it went stale), not the points' own effect, not the layers above.
const P = await import("./plugins.js");
const ed = editor;
const opp = (r, g, b) => { const L = 0.299 * r + 0.587 * g + 0.114 * b; return [L, r - L, b - L]; };
const colourBelow = (layerId, x, y) => {
    const idx = ed.layers.findIndex((l) => l.id === layerId);
    const flat = ed.flattenToCanvas({ forRun: true, upTo: idx });
    const d = flat.getContext("2d").getImageData(x - 1, y - 1, 3, 3).data;
    let r = 0, g = 0, b = 0; for (let i = 0; i < 36; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    return opp(r / 9 / 255, g / 9 / 255, b / 9 / 255);
};
const same = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 1e-6);
const counted = async (fn) => {
    const f0 = ed.flattenToCanvas, d0 = P.Document.prototype.flatten;
    const n = { flatten: 0, whole: 0 };
    ed.flattenToCanvas = function (...a) { n.flatten++; return f0.apply(this, a); };
    P.Document.prototype.flatten = function (o) { if (!o || (!o.maxSize && !o.box)) n.whole++; return d0.call(this, o); };
    try { return [await fn(), n]; } finally { ed.flattenToCanvas = f0; P.Document.prototype.flatten = d0; }
};
const T = await import("./editor/inpaint_tiles.js");
ed.releaseCaches({ mirrors: true });
const [r, n1] = await counted(() => c("film.add_point", { x: 130, y: 120, radius: 100, exposure: 1, saturation: 30 }));
if (!r.layer || r.points !== 1 || r.point.r !== 100 || !Array.isArray(r.point.color)) throw new Error("add_point: " + JSON.stringify(r));
if (n1.flatten || n1.whole) throw new Error("placing a point flattened the picture: " + JSON.stringify(n1));
if (ed.tileMode && ed.memoryReport().tiles.mirrors) throw new Error("placing a point made " + ed.memoryReport().tiles.mirrors + " display mirrors");
const want1 = colourBelow(r.layer, 130, 120);
if (!same(r.point.color, want1)) throw new Error("point 1's colour " + JSON.stringify(r.point.color) + " is not the picture below it " + JSON.stringify(want1));
// what the last full-resolution render leaves (the export, a run): the colour must not come from it after a change below
ed.flattenToCanvas({ forRun: true });
const under = await c("add_paint_layer", { name: "Under the points" });
await c("move_layer", { layer: under.id, to: "bottom" });
{   // a hard edge through x = 400 around the second point's place: red left of it, green from it on
    const U = ed.layers.find((l) => l.id === under.id);
    const img = new ImageData(120, 120);
    for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) { const i = (y * 120 + x) * 4; if (x < 60) { img.data[i] = 220; img.data[i + 1] = 30; img.data[i + 2] = 40; } else { img.data[i] = 30; img.data[i + 1] = 200; img.data[i + 2] = 60; } img.data[i + 3] = 255; }
    U.px.writeRect(img, 340, 200);
    ed.markLayerChanged(U, [340, 200, 460, 320]);
}
const [r2, n2] = await counted(() => c("film.add_point", { x: 400, y: 260, exposure: -1 }));
if (r2.layer !== r.layer || r2.points !== 2) throw new Error("second point went elsewhere: " + JSON.stringify(r2));
if (n2.flatten || n2.whole) throw new Error("the second point flattened the picture: " + JSON.stringify(n2));
const want2 = colourBelow(r.layer, 400, 260);
if (!same(r2.point.color, want2)) throw new Error("point 2 on the edge painted below took " + JSON.stringify(r2.point.color) + ", the picture below is " + JSON.stringify(want2));
// a point where point 1 already acts, under a layer above the points layer: still the colour below both
const over = await c("add_paint_layer", { name: "Over the points" });
{
    const O = ed.layers.find((l) => l.id === over.id);
    const img = new ImageData(40, 40); for (let i = 0; i < img.data.length; i += 4) { img.data[i] = 10; img.data[i + 1] = 10; img.data[i + 2] = 250; img.data[i + 3] = 255; }
    O.px.writeRect(img, 110, 100);
    ed.markLayerChanged(O, [110, 100, 150, 140]);
}
const pl = P.Document ? new P.Document(ed) : null;
const layerObj = ed.layers.find((l) => l.id === r.layer);
const [r3] = await counted(() => c("film.add_point", { x: 132, y: 121, exposure: 0.5 }));
const want3 = colourBelow(r.layer, 132, 121);
if (!same(r3.point.color, want3)) throw new Error("point 3 took " + JSON.stringify(r3.point.color) + " with the points' own effect or the layer above in it; the picture below is " + JSON.stringify(want3));
const flatNow = ed.flattenToCanvas({ forRun: true }).getContext("2d").getImageData(131, 120, 3, 3).data;
const whole3 = (() => { let a = 0, b = 0, cc = 0; for (let i = 0; i < 36; i += 4) { a += flatNow[i]; b += flatNow[i + 1]; cc += flatNow[i + 2]; } return opp(a / 9 / 255, b / 9 / 255, cc / 9 / 255); })();
if (same(whole3, want3)) throw new Error("the test cannot tell the picture below from the whole picture at point 3");
// back to the two points the steps after this one expect, and the helper layers gone
await c("remove_layer", { layer: over.id });
await c("remove_layer", { layer: under.id });
pl.setFilterParams(r.layer, { points: layerObj.params.points.slice(0, 2) });
// the picture changed near point 1 and not far away from both
const flat = editor.flattenToCanvas({ forRun: true }).getContext("2d");
const bc = document.createElement("canvas"); bc.width = editor.width; bc.height = editor.height; editor.basePx.drawTo(bc.getContext("2d"), 0, 0);
const at = (ctx, x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
const near = at(flat, 130, 120), nearBase = at(bc.getContext("2d"), 130, 120);
if (near.join() === nearBase.join()) throw new Error("point 1 changed nothing at its centre: " + near + " vs " + nearBase);
const far = at(flat, 20, 370), farBase = at(bc.getContext("2d"), 20, 370);
if (far.join() !== farBase.join()) throw new Error("pixels far from the points changed: " + far + " vs " + farBase);
window.__pointsLayer = r.layer;
return { layer: r.layer, near, nearBase, far };
"""),
    ("points_in_a_box_away_from_the_origin", """
// C6 (c1) review: the control points are placed in the image, whatever part of it a pass composites. Their shader and
// CPU path measured a point from the pass's own corner, so a box read over a point (the sample plugin's exact reads, a
// region pass on the screen at zoom) returned the picture without the point's effect. And a point's colour is the
// points layer's input even under a filter no box of its surroundings can give (a vignette): the whole flatten below.
// Its own document, closed at the end; the film document is active again after it.
const P = await import("./plugins.js");
const H0 = (await import("./editor/host.js")).host;
const d = await c("new_document");
const ed = H0.editors().find((e) => e.node.id === d.id);
H0.shell.activate(ed);
await c("new_canvas", { width: 1600, height: 1200, doc: d.id });
const W = 1600, H = 1200;
const base = document.createElement("canvas"); base.width = W; base.height = H;
{
    const x = base.getContext("2d");
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#506070"); g.addColorStop(1, "#907860");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 120; i++) { x.fillStyle = `hsl(${(i * 53) % 360},45%,${35 + (i * 11) % 30}%)`; x.fillRect((i * 331) % (W - 60), (i * 197) % (H - 60), 60, 60); }
}
Object.defineProperty(base, "naturalWidth", { value: W });
Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "pointsbox.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
const doc = new P.Document(ed);
const read = (cv, x = 0, y = 0, w = cv.width, h = cv.height) => cv.getContext("2d").getImageData(x, y, w, h).data;
const diff = (a, b) => { let m = 0, n = 0; for (let i = 0; i < a.length; i++) { const q = Math.abs(a[i] - b[i]); if (q > m) m = q; if (q > 1) n++; } return [m, n]; };
const out = { tiles: ed.tileMode };
const r = await c("film.add_point", { x: 1100, y: 800, radius: 250, tolerance: 100, exposure: 1, doc: d.id });
const idx = ed.layers.findIndex((l) => l.id === r.layer);
// (1) an exact box over the point at full resolution, clear of the origin
const box = [1000, 700, 1200, 900];
if (ed.boxReach(box) !== 0) throw new Error("the stack's reach is " + ed.boxReach(box) + ": the step would not read a box");
const whole = ed.flattenToCanvas({ forRun: true });
const belowPts = ed.flattenToCanvas({ forRun: true, upTo: idx });
const want = read(whole, box[0], box[1], 200, 200);
const [acts] = diff(want, read(belowPts, box[0], box[1], 200, 200));
if (acts < 40) throw new Error("the point barely changes the picture around it (" + acts + " levels): the step proves nothing");
const [bm, bn] = diff(read(doc.flatten({ box, exact: true })), want);
out.box = { acts, max: bm, over1: bn };
if (bm > 1) throw new Error("an exact box over the point differs from the whole flatten by " + bm + " levels on " + bn + " bytes: the point is not where the image has it");
// (2) mean_color of a selection at the point: the whole flatten's mean there
await c("select_rect", { x: 1050, y: 750, w: 100, h: 100, doc: d.id });
const mean = await c("sample.mean_color", { doc: d.id });
await c("select_none", { doc: d.id });
{
    const px = read(whole, 1050, 750, 100, 100); let s = [0, 0, 0];
    for (let i = 0; i < px.length; i += 4) { s[0] += px[i]; s[1] += px[i + 1]; s[2] += px[i + 2]; }
    const m = s.map((v) => Math.round(v / 10000));
    out.mean = [mean.rgb, m];
    if (JSON.stringify(mean.rgb) !== JSON.stringify(m)) throw new Error("mean_color at the point " + JSON.stringify(mean.rgb) + " is not the whole flatten's " + JSON.stringify(m));
}
// (3) a pass at 0.5 over a region that does not start at the origin: the pass over the whole image there
{
    const reg = ed.sampleRegion("image", [800, 600, 1400, 1000], 0.5, { forRun: true });
    const all = ed.sampleRegion("image", [0, 0, W, H], 0.5, { forRun: true });
    const [hm, hn] = diff(read(reg), read(all, 400, 300, 300, 200));
    out.half = { max: hm, over1: hn };
    if (hm > 2) throw new Error("a pass at 0.5 over the point's region differs from the pass over the whole image by " + hm + " levels on " + hn + " bytes");
    // the CPU path places the points by the origin as the shader does
    const F = await import("./editor/inpaint_filters.js");
    const GL = await import("./editor/inpaint_filters_gl.js");
    const layer = ed.layers.find((l) => l.id === r.layer);
    const src = ed.sampleRegion("image", [800, 600, 1400, 1000], 1, { forRun: true, upTo: idx });
    const info = { scale: 1, origin: [800, 600], seed: 7, cache: {} };
    const cpu = read(F.applyFilter("film.points", src, layer.params, { ...info, cpu: true }));
    const buf = await crypto.subtle.digest("SHA-256", cpu);
    const sha = Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, "0")).join("");
    if (sha !== "4e35c9d84b02bbe8560cc8705c25e7c3429a992fd268976ef0b39d59233e2e0c") {
        throw new Error("points_in_a_box CPU SHA mismatch: " + sha);
    }
    const gpu = read(F.applyFilter("film.points", src, layer.params, { ...info, cache: {} }));
    const [cm, cn] = diff(cpu, read(src));
    const [gm, gn] = diff(cpu, gpu);
    out.cpu = { acts: cm, vsGpu: gm, gl: GL.glFiltersAvailable() };
    if (cm < 40) throw new Error("the CPU path over the point's region changed " + cm + " levels: the point is not where the image has it");
    if (GL.glFiltersAvailable() && gm > 2) throw new Error("the points' CPU and GPU paths with an origin differ by " + gm + " levels on " + gn + " bytes");
}
// (3b) an ellipse in a box away from the origin: box read equals the whole flatten exactly
{
    const layer = ed.layers.find((l) => l.id === r.layer);
    const origPoints = layer.params.points;
    layer.params.points = [{
        id: 1, shape: "ellipse", x: 1100, y: 800, r: 250, ry: 150, angle: 35, soft: 60,
        tol: 100, ev: 1, contrast: 0, sat: 0, warmth: 0, structure: 0, color: origPoints[0].color,
    }];
    try {
        const wholeEl = ed.flattenToCanvas({ forRun: true });
        const wantEl = read(wholeEl, box[0], box[1], 200, 200);
        const [actsEl] = diff(wantEl, read(belowPts, box[0], box[1], 200, 200));
        if (actsEl < 40) throw new Error("the ellipse point barely changes the picture: " + actsEl);
        const [bmEl, bnEl] = diff(read(doc.flatten({ box, exact: true })), wantEl);
        out.boxEllipse = { acts: actsEl, max: bmEl, over1: bnEl };
        if (bmEl > 1) throw new Error("an exact box over the ellipse point differs from the whole flatten by " + bmEl + " levels on " + bnEl + " bytes");
    } finally {
        layer.params.points = origPoints;
    }
}
// (3c) a polygon in a box away from the origin: box read equals the whole flatten exactly
{
    const layer = ed.layers.find((l) => l.id === r.layer);
    const origPoints = layer.params.points;
    layer.params.points = [{
        id: 1, shape: "polygon", x: 1100, y: 800, r: 40, soft: 60,
        tol: 100, ev: 1, contrast: 0, sat: 0, warmth: 0, structure: 0, color: origPoints[0].color,
        pts: [[1050, 750], [1150, 750], [1180, 820], [1120, 860], [1040, 830]],
    }];
    try {
        const wholePoly = ed.flattenToCanvas({ forRun: true });
        const wantPoly = read(wholePoly, box[0], box[1], 200, 200);
        const [actsPoly] = diff(wantPoly, read(belowPts, box[0], box[1], 200, 200));
        if (actsPoly < 40) throw new Error("the polygon point barely changes the picture: " + actsPoly);
        const [bmPoly, bnPoly] = diff(read(doc.flatten({ box, exact: true })), wantPoly);
        out.boxPolygon = { acts: actsPoly, max: bmPoly, over1: bnPoly };
        if (bmPoly > 1) throw new Error("an exact box over the polygon point differs from the whole flatten by " + bmPoly + " levels on " + bnPoly + " bytes");
    } finally {
        layer.params.points = origPoints;
    }
}
// (3d) a line in a box away from the origin: box read equals the whole flatten exactly
{
    const layer = ed.layers.find((l) => l.id === r.layer);
    const origPoints = layer.params.points;
    layer.params.points = [{
        id: 1, shape: "line", x: 1100, y: 800, angle: 45, r: 60, soft: 60,
        tol: 100, ev: 1, contrast: 0, sat: 0, warmth: 0, structure: 0, color: origPoints[0].color,
    }];
    try {
        const wholeLine = ed.flattenToCanvas({ forRun: true });
        const wantLine = read(wholeLine, box[0], box[1], 200, 200);
        const [actsLine] = diff(wantLine, read(belowPts, box[0], box[1], 200, 200));
        if (actsLine < 40) throw new Error("the line point barely changes the picture: " + actsLine);
        const [bmLine, bnLine] = diff(read(doc.flatten({ box, exact: true })), wantLine);
        out.boxLine = { acts: actsLine, max: bmLine, over1: bnLine };
        if (bmLine > 1) throw new Error("an exact box over the line point differs from the whole flatten by " + bmLine + " levels on " + bnLine + " bytes");
    } finally {
        layer.params.points = origPoints;
    }
}
// (4) a vignette under the points layer: its picture depends on the whole image. Since E3 it is placed in the whole
// picture whatever part a pass composites (info.full, info.origin), so the point's colour is a box read and still the
// whole flatten's below the points layer; before, only the whole flatten gave it (a padded box was 40 levels off)
const vig = await c("add_filter", { type: "vignette", doc: d.id });
await c("move_layer", { layer: vig.id, to: "bottom", doc: d.id });
const f0 = ed.flattenToCanvas; let flats = 0;
ed.flattenToCanvas = function (...q) { flats++; return f0.apply(this, q); };
let r2;
try { r2 = await c("film.add_point", { x: 1500, y: 1120, radius: 80, tolerance: 10, exposure: 1, doc: d.id }); } finally { ed.flattenToCanvas = f0; }
const pts = ed.layers.findIndex((l) => l.id === r.layer);
const opp = (rr, gg, bb) => { const L = 0.299 * rr + 0.587 * gg + 0.114 * bb; return [L, rr - L, bb - L]; };
const mean9 = (cv, x0, y0) => { const q = read(cv, x0, y0, 3, 3); let a = 0, b = 0, e = 0; for (let i = 0; i < 36; i += 4) { a += q[i]; b += q[i + 1]; e += q[i + 2]; } return opp(a / 9 / 255, b / 9 / 255, e / 9 / 255); };
const want2 = mean9(ed.flattenToCanvas({ forRun: true, upTo: pts }), 1499, 1119);
const padded = mean9(doc.flatten({ box: [1499, 1119, 1502, 1122], below: r.layer, pad: 128 }), 0, 0);
out.vignette = { got: r2.point.color, want: want2, padded, flats };
if (Math.abs(padded[0] - want2[0]) > 0.005) throw new Error("the vignette's picture in a box is not the whole picture's under the point " + JSON.stringify(out.vignette));
if (flats) throw new Error("a point under a vignette flattened the whole picture " + flats + " times: a box has been enough since E3");
if (!r2.point.color.every((v, k) => Math.abs(v - want2[k]) < 1e-6)) throw new Error("the point under a vignette took " + JSON.stringify(r2.point.color) + ", the picture below the points layer is " + JSON.stringify(want2));
await c("close_document", { doc: d.id, force: true });
await c("activate_document", { doc: window.__filmDoc });
return out;
"""),
    ("points_follow_crop_resize_and_turn", """
// PLAN_0_1_31 Section 7 (23b): the control points follow the whole picture's geometry changes by the editor's "geometry"
// event matrix: the centre mapped, the radius scaled by sqrt(|det m|), no rounding (a turn gives 23a's numbers, a
// non-uniform resize fractions); an undo of the change puts them back without an event, its redo brings the mapped
// ones. A straighten's matrix is sent by hand (the editor's straighten is a later step). Its own document, closed at
// the end; the film document is active again after it.
const H0 = (await import("./editor/host.js")).host;
const d = await c("new_document");
const ed = H0.editors().find((e) => e.node.id === d.id);
H0.shell.activate(ed);
await c("new_canvas", { width: 800, height: 600, doc: d.id });
const seen = [];
const off = H0.on("geometry", (e) => { if (e.editor === ed) seen.push({ kind: e.kind, m: e.m, op: e.op }); });
const pt = () => ed.layers.find((l) => l.kind === "filter" && l.filter === "film.points").params.points[0];
const at = (want, what, tol = 1e-9) => {
    const p = pt();
    if (Math.abs(p.x - want[0]) > tol || Math.abs(p.y - want[1]) > tol || Math.abs(p.r - want[2]) > tol) throw new Error(what + ": the point is at " + JSON.stringify([p.x, p.y, p.r]) + ", not " + JSON.stringify(want));
};
const out = {};
try {
    // exposure -1 on white: the point darkens the picture where it is
    await c("film.add_point", { x: 300, y: 200, radius: 80, exposure: -1, doc: d.id });
    at([300, 200, 80], "placed");
    await c("film.add_point", { shape: "ellipse", x: 450, y: 350, radius: 100, height: 60, angle: 30, exposure: -1, doc: d.id });
    const ptEl = () => ed.layers.find((l) => l.kind === "filter" && l.filter === "film.points").params.points[1];
    await c("film.add_point", { shape: "polygon", vertices: [[400, 300], [500, 300], [450, 400]], radius: 25, exposure: -1, doc: d.id });
    const ptPoly = () => ed.layers.find((l) => l.kind === "filter" && l.filter === "film.points").params.points[2];
    let polyPts = [[400, 300], [500, 300], [450, 400]];
    const polyPts0 = polyPts.slice();
    const checkPoly = (poly, wantPts, what) => {
        for (let i = 0; i < wantPts.length; i++) {
            const exp = wantPts[i], got = poly.pts[i];
            if (Math.abs(exp[0] - got[0]) > 1e-4 || Math.abs(exp[1] - got[1]) > 1e-4) {
                throw new Error(`${what}: corner ${i} got ${JSON.stringify(got)}, want ${JSON.stringify(exp)}`);
            }
        }
    };
    const makeBpts = (el) => {
        const pts = [];
        const rad = (el.angle || 0) * Math.PI / 180, co = Math.cos(rad), si = Math.sin(rad);
        for (let i = 0; i < 8; i++) {
            const t = (i * 2 * Math.PI) / 8;
            const u = el.r * Math.cos(t), v = (el.ry || Math.round(0.6 * el.r)) * Math.sin(t);
            pts.push([el.x + u * co - v * si, el.y + u * si + v * co]);
        }
        return pts;
    };
    const mapBpts = (pts, m) => pts.map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
    const checkEl = (el, pts, what, tol = 1e-6) => {
        const rad = (el.angle || 0) * Math.PI / 180, co = Math.cos(rad), si = Math.sin(rad);
        const ry = el.ry || Math.round(0.6 * el.r);
        for (let i = 0; i < pts.length; i++) {
            const dx = pts[i][0] - el.x, dy = pts[i][1] - el.y;
            const u = (dx * co + dy * si) / el.r;
            const v = (-dx * si + dy * co) / ry;
            const dist = Math.hypot(u, v);
            if (Math.abs(dist - 1) > tol) throw new Error(`${what}: boundary point ${i} |q|-1 = ${Math.abs(dist - 1)} on ${JSON.stringify(el)}`);
        }
    };
    let bpts = makeBpts(ptEl());
    const bpts0 = bpts.slice();
    checkEl(ptEl(), bpts, "initial ellipse");
    checkPoly(ptPoly(), polyPts0, "initial polygon");
    // a crop: 50 off the left, 30 off the top, 20 and 10 off the other sides -> 730 x 560
    await c("extend_canvas", { left: -50, top: -30, right: -20, bottom: -10, doc: d.id });
    if (ed.width !== 730 || ed.height !== 560) throw new Error("the crop made " + ed.width + " x " + ed.height);
    at([250, 170, 80], "after the crop");
    bpts = mapBpts(bpts, seen[seen.length - 1].m);
    checkEl(ptEl(), bpts, "after the crop");
    polyPts = mapBpts(polyPts, seen[seen.length - 1].m);
    checkPoly(ptPoly(), polyPts, "after the crop");
    await c("undo", { doc: d.id });
    at([300, 200, 80], "after the crop's undo");
    checkEl(ptEl(), bpts0, "after the crop's undo");
    checkPoly(ptPoly(), polyPts0, "after the crop's undo");
    await c("redo", { doc: d.id });
    at([250, 170, 80], "after the crop's redo");
    checkEl(ptEl(), bpts, "after the crop's redo");
    checkPoly(ptPoly(), polyPts, "after the crop's redo");
    // a resize that is not uniform: 730 x 560 -> 365 x 420, x by 0.5 and y by 0.75, the radius by sqrt(0.375)
    await ed.resizeImage(365, 420);
    at([125, 127.5, 80 * Math.sqrt(0.375)], "after the resize");
    bpts = mapBpts(bpts, seen[seen.length - 1].m);
    checkEl(ptEl(), bpts, "after the resize");
    polyPts = mapBpts(polyPts, seen[seen.length - 1].m);
    checkPoly(ptPoly(), polyPts, "after the resize");
    // a quarter turn clockwise: (H - y, x), the radius kept
    await c("rotate_canvas", { angle: 90, doc: d.id });
    at([420 - 127.5, 125, 80 * Math.sqrt(0.375)], "after the turn");
    bpts = mapBpts(bpts, seen[seen.length - 1].m);
    checkEl(ptEl(), bpts, "after the turn");
    polyPts = mapBpts(polyPts, seen[seen.length - 1].m);
    checkPoly(ptPoly(), polyPts, "after the turn");
    // a flip horizontal
    const bptsBeforeFlip = bpts.slice();
    const polyPtsBeforeFlip = polyPts.slice();
    await c("flip_canvas", { axis: "horizontal", doc: d.id });
    at([127.5, 125, 80 * Math.sqrt(0.375)], "after the flip");
    bpts = mapBpts(bpts, seen[seen.length - 1].m);
    checkEl(ptEl(), bpts, "after the flip");
    polyPts = mapBpts(polyPts, seen[seen.length - 1].m);
    checkPoly(ptPoly(), polyPts, "after the flip");
    await c("undo", { doc: d.id });
    at([420 - 127.5, 125, 80 * Math.sqrt(0.375)], "after flip undo");
    checkEl(ptEl(), bptsBeforeFlip, "after flip undo");
    checkPoly(ptPoly(), polyPtsBeforeFlip, "after flip undo");
    await c("redo", { doc: d.id });
    at([127.5, 125, 80 * Math.sqrt(0.375)], "after flip redo");
    checkEl(ptEl(), bpts, "after flip redo");
    checkPoly(ptPoly(), polyPts, "after flip redo");
    out.kinds = seen.map((e) => e.kind);
    if (JSON.stringify(out.kinds) !== JSON.stringify(["crop", "resize", "turn", "turn"])) throw new Error("the editor sent " + JSON.stringify(seen) + " (one event per change, none for undo and redo)");
    if (seen.some((e) => !Array.isArray(e.m) || e.m.length !== 6) || seen[2].op !== 1 || seen[3].op !== "h" || seen[0].op !== undefined) throw new Error("the events: " + JSON.stringify(seen));
    // a straighten's matrix, sent by hand: 10 degrees clockwise about the picture's centre, the same size
    const W = ed.width, H = ed.height, t = 10 * Math.PI / 180, co = Math.cos(t), si = Math.sin(t);
    const m = [co, si, -si, co, W / 2 - co * W / 2 + si * H / 2, H / 2 - si * W / 2 - co * H / 2];
    const q = pt();
    H0.emit("geometry", { editor: ed, kind: "straighten", m, from: { width: W, height: H }, to: { width: W, height: H } });
    at([m[0] * q.x + m[2] * q.y + m[4], m[1] * q.x + m[3] * q.y + m[5], q.r], "after a straighten's matrix", 1e-6);
    bpts = mapBpts(bpts, m);
    checkEl(ptEl(), bpts, "after a straighten's matrix");
    polyPts = mapBpts(polyPts, m);
    checkPoly(ptPoly(), polyPts, "after a straighten's matrix");
    // an event this plugin cannot read changes nothing (23a's code took any unknown op for a -90 turn)
    const q2 = pt();
    H0.emit("geometry", { editor: ed, kind: "turn", op: "sideways", from: { width: W, height: H }, to: { width: W, height: H } });
    at([q2.x, q2.y, q2.r], "after an event without a matrix or a known op", 0);
    checkEl(ptEl(), bpts, "after an event without a matrix or a known op");
    // the point acts where it is now: dark at its centre, the picture untouched far from it
    const p = pt();
    const flat = ed.flattenToCanvas({ forRun: true }).getContext("2d");
    const centre = Array.from(flat.getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data);
    const corners = [[2, 2], [W - 3, 2], [2, H - 3], [W - 3, H - 3]];
    const farC = corners.reduce((a, b) => (Math.hypot(b[0] - p.x, b[1] - p.y) > Math.hypot(a[0] - p.x, a[1] - p.y) ? b : a));
    const far = Array.from(flat.getImageData(farC[0], farC[1], 1, 1).data);
    const pEl2 = ptEl();
    const centreEl = Array.from(flat.getImageData(Math.floor(pEl2.x), Math.floor(pEl2.y), 1, 1).data);
    out.point = { x: p.x, y: p.y, r: p.r, centre, far, centreEl };
    if (!(centre[0] < 200)) throw new Error("the point does not act at its centre " + [p.x, p.y] + ": " + centre);
    if (!(centreEl[0] < 200)) throw new Error("the ellipse does not act at its centre " + [pEl2.x, pEl2.y] + ": " + centreEl);
    if (Math.hypot(farC[0] - p.x, farC[1] - p.y) > p.r && far[0] < 250) throw new Error("the picture far from the point changed: " + far + " at " + farC);
    out.ok = true;
} finally {
    off();
    await c("close_document", { doc: d.id, force: true });
    await c("activate_document", { doc: window.__filmDoc });
}
return out;
"""),
    ("point_tool", """
const H = (await import("./editor/host.js")).host;
const layer = editor.layers.find((l) => l.id === window.__pointsLayer);
await c("set_active_layer", { layer: layer.id });
editor.setTool("film.point");
if (editor.tool !== "film.point") throw new Error("tool not selected");
const fake = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, pressure: 0.5, pointerType: "mouse", type: "pointerdown" };
const undo0 = editor.undo.length;
// place a third point with a drag that sets its size
H.pluginPointer(editor, "down", fake, 250, 300);
H.pluginPointer(editor, "move", { ...fake, type: "pointermove" }, 250 + 60, 300);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 310, 300, editor.pointer); editor.pointer = null;
let pts = layer.params.points;
if (pts.length !== 3 || pts[2].x !== 250 || pts[2].r !== 60) throw new Error("place + size: " + JSON.stringify(pts.map((q) => [q.x, q.y, q.r])));
if (editor.undo.length !== undo0 + 1) throw new Error("placing a point should be one undo step: " + (editor.undo.length - undo0));
if (layer._fpSel !== pts[2].id) throw new Error("new point not selected");
// drag the centre of point 3 to move it
H.pluginPointer(editor, "down", fake, 250, 300);
if (!editor.pointer || editor.pointer.kind !== "plugin") throw new Error("down on a centre not routed");
H.pluginPointer(editor, "move", { ...fake, type: "pointermove" }, 280, 320);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 280, 320, editor.pointer); editor.pointer = null;
pts = layer.params.points;
if (pts[2].x !== 280 || pts[2].y !== 320) throw new Error("move: " + JSON.stringify(pts[2]));
// drag the ring to resize
H.pluginPointer(editor, "down", fake, 280 + 60, 320);
H.pluginPointer(editor, "move", { ...fake, type: "pointermove" }, 280 + 90, 320);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 370, 320, editor.pointer); editor.pointer = null;
pts = layer.params.points;
if (pts[2].r !== 90) throw new Error("resize: " + JSON.stringify(pts[2]));
// a click on the centre of point 1 selects it without an undo step
const undo1 = editor.undo.length;
H.pluginPointer(editor, "down", fake, 130, 120);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 130, 120, editor.pointer); editor.pointer = null;
if (layer._fpSel !== pts[0].id) throw new Error("click did not select point 1");
if (editor.undo.length !== undo1) throw new Error("selecting pushed an undo step");
// Delete removes the selected point, undo brings it back
const del = H.pluginKey(editor, { key: "Delete", shiftKey: false, preventDefault() {} }, "delete");
if (!del || layer.params.points.length !== 2) throw new Error("Delete: " + layer.params.points.length);
await c("undo");
if (layer.params.points.length !== 3) throw new Error("undo after delete: " + layer.params.points.length);
// the layer row shows chips and sliders for the selected point
const row = editor.root.querySelector(".film-points");
if (!row || row.querySelectorAll(".film-chip").length !== 3) throw new Error("layer-row control missing or wrong chip count");
if (!row.querySelector(".film-chip-on")) throw new Error("no selected chip");
if (row.querySelectorAll("input[type=range]").length < 7) throw new Error("point sliders missing");

// Switch new shape to ellipse via row button
const shapeBtns = Array.from(row.querySelectorAll(".film-shape-btn"));
const elBtn = shapeBtns.find((b) => b.textContent === "ellipse");
if (!elBtn) throw new Error("ellipse shape button missing");
elBtn.click();

// Place a fourth point (ellipse) dragging 80 px at 30 deg: dx = 69.282, dy = 40
H.pluginPointer(editor, "down", fake, 200, 200);
H.pluginPointer(editor, "move", { ...fake, type: "pointermove" }, 200 + 69.282, 200 + 40);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 269.282, 240, editor.pointer); editor.pointer = null;
pts = layer.params.points;
const pEl = pts[3];
if (!pEl || pEl.shape !== "ellipse") throw new Error("ellipse not placed: " + JSON.stringify(pEl));
if (pEl.r !== 80 || Math.abs(pEl.angle - 30) > 0.5 || pEl.ry !== 48) {
    throw new Error(`ellipse params mismatch: r=${pEl.r} (want 80), angle=${pEl.angle} (want 30), ry=${pEl.ry} (want 48)`);
}

// Drag ry handle: at (200, 200) with r 80, ry 48, angle 30:
// ry handle is at x = 200 - 48*sin(30) = 176, y = 200 + 48*cos(30) = 241.569
// Drag to (170, 252) -> proj = -(-30)*sin(30) + 52*cos(30) = 15 + 45.033 = 60.033 -> ry = 60
H.pluginPointer(editor, "down", fake, 176, 241.6);
H.pluginPointer(editor, "move", { ...fake, type: "pointermove" }, 170, 252);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 170, 252, editor.pointer); editor.pointer = null;
pts = layer.params.points;
if (pts[3].ry !== 60) throw new Error(`drag ry handle: got ry=${pts[3].ry}, want 60`);

// Command tests: film.add_point with shape: "ellipse"
const cmdEl = await c("film.add_point", { x: 300, y: 250, shape: "ellipse", height: 50, angle: 45, softness: 60 });
if (!cmdEl.point || cmdEl.point.shape !== "ellipse" || cmdEl.point.ry !== 50 || cmdEl.point.angle !== 45 || cmdEl.point.soft !== 60) {
    throw new Error("film.add_point command ellipse mismatch: " + JSON.stringify(cmdEl));
}
layer.params.points = layer.params.points.filter((q) => q.id !== cmdEl.point.id);

let threwShape = false;
try {
    await c("film.add_point", { shape: "triangle" });
} catch (e) {
    threwShape = true;
}
if (!threwShape) throw new Error("film.add_point should refuse shape 'triangle'");

// Command tests for polygon vertex count
let threwPoly2 = false;
try {
    await c("film.add_point", { shape: "polygon", vertices: [[100, 100], [200, 200]] });
} catch (e) {
    threwPoly2 = true;
}
if (!threwPoly2) throw new Error("film.add_point should refuse polygon with 2 vertices");

let threwPoly17 = false;
try {
    await c("film.add_point", { shape: "polygon", vertices: Array.from({ length: 17 }, (_, i) => [i * 10, i * 10]) });
} catch (e) {
    threwPoly17 = true;
}
if (!threwPoly17) throw new Error("film.add_point should refuse polygon with 17 vertices");

// --- Polygon tool interactive tests ---
const polyBtn = Array.from(row.querySelectorAll(".film-shape-btn")).find((b) => b.textContent === "polygon");
if (!polyBtn) throw new Error("polygon shape button missing in layer row");
polyBtn.click();

// 1. Five clicks + Enter -> one undo step and 5 corners
const undoBeforePoly = editor.undo.length;
const corners = [[100, 100], [150, 90], [180, 140], [140, 180], [90, 150]];
for (const [cx, cy] of corners) {
    H.pluginPointer(editor, "down", fake, cx, cy);
    H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, cx, cy, editor.pointer);
    editor.pointer = null;
}
H.pluginKey(editor, { key: "Enter", preventDefault() {} }, "enter");
pts = layer.params.points;
const pPoly = pts[pts.length - 1];
if (!pPoly || pPoly.shape !== "polygon" || pPoly.pts.length !== 5) {
    throw new Error("polygon 5 clicks + Enter failed: " + JSON.stringify(pPoly));
}
if (editor.undo.length !== undoBeforePoly + 1) {
    throw new Error("polygon creation must be exactly 1 undo step: got " + (editor.undo.length - undoBeforePoly));
}

// 2. Escape halfway -> no point and no undo step
const undoBeforeEscape = editor.undo.length;
const countBeforeEscape = layer.params.points.length;
H.pluginPointer(editor, "down", fake, 50, 50);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 50, 50, editor.pointer);
editor.pointer = null;
H.pluginPointer(editor, "down", fake, 70, 70);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 70, 70, editor.pointer);
editor.pointer = null;
H.pluginKey(editor, { key: "Escape", preventDefault() {} }, "escape");
if (layer.params.points.length !== countBeforeEscape || editor.undo.length !== undoBeforeEscape) {
    throw new Error("polygon Escape halfway must not create a point or push undo");
}

// 3. Backspace drops corner
H.pluginPointer(editor, "down", fake, 60, 60);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 60, 60, editor.pointer);
editor.pointer = null;
H.pluginPointer(editor, "down", fake, 80, 60);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 80, 60, editor.pointer);
editor.pointer = null;
H.pluginPointer(editor, "down", fake, 200, 200); // 3rd corner to drop
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 200, 200, editor.pointer);
editor.pointer = null;
H.pluginKey(editor, { key: "Backspace", preventDefault() {} }, "backspace");
H.pluginPointer(editor, "down", fake, 80, 80);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 80, 80, editor.pointer);
editor.pointer = null;
H.pluginPointer(editor, "down", fake, 60, 80);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 60, 80, editor.pointer);
editor.pointer = null;
H.pluginKey(editor, { key: "Enter", preventDefault() {} }, "enter");
const pDrop = layer.params.points[layer.params.points.length - 1];
if (!pDrop || pDrop.pts.length !== 4) {
    throw new Error("polygon backspace corner drop failed: " + JSON.stringify(pDrop));
}

// 4. Double-click closes polygon
H.pluginPointer(editor, "down", fake, 300, 100);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 300, 100, editor.pointer);
editor.pointer = null;
H.pluginPointer(editor, "down", fake, 350, 100);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 350, 100, editor.pointer);
editor.pointer = null;
H.pluginPointer(editor, "down", fake, 350, 150);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 350, 150, editor.pointer);
editor.pointer = null;
// Double-click on 4th corner (within 100 ms and 1 px)
H.pluginPointer(editor, "down", fake, 300, 150);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 300, 150, editor.pointer);
editor.pointer = null;
H.pluginPointer(editor, "down", fake, 300, 150);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 300, 150, editor.pointer);
editor.pointer = null;
const pDbl = layer.params.points[layer.params.points.length - 1];
if (!pDbl || pDbl.pts.length < 3) {
    throw new Error("polygon double-click close failed: " + JSON.stringify(pDbl));
}

// --- Line tool interactive test ---
const curRow = editor.root.querySelector(".film-points");
const lineBtn = Array.from(curRow.querySelectorAll(".film-shape-btn")).find((b) => b.textContent === "line");
if (!lineBtn) throw new Error("line shape button missing in layer row");
lineBtn.click();

H.pluginPointer(editor, "down", fake, 420, 20);
H.pluginPointer(editor, "move", { ...fake, type: "pointermove" }, 480, 100);
H.pluginPointer(editor, "up", { ...fake, type: "pointerup" }, 480, 100, editor.pointer);
editor.pointer = null;
pts = layer.params.points;
const pLine = pts[pts.length - 1];
if (!pLine || pLine.shape !== "line") throw new Error("line not placed: " + JSON.stringify(pLine));
if (pLine.r !== 50 || Math.abs(pLine.angle - 53.1) > 0.5) {
    throw new Error(`line params mismatch: r=${pLine.r} (want 50), angle=${pLine.angle} (want 53.1)`);
}

const curRow2 = editor.root.querySelector(".film-points");
const circBtn = Array.from(curRow2.querySelectorAll(".film-shape-btn")).find((b) => b.textContent === "circle");
if (circBtn) circBtn.click();

layer._fpSel = pts[0].id;
editor.renderLayers();
editor.draw();
return { points: layer.params.points.map((q) => ({ x: q.x, y: q.y, r: q.r })), undoSteps: editor.undo.length - undo0 };
"""),
    ("panel_thumbnails", """
const sec = Array.from(editor.root.querySelectorAll("details")).find((d) => d.querySelector("summary") && d.querySelector("summary").textContent === "Film looks");
if (!sec) throw new Error("Film looks panel missing");
sec.open = true;
const grp = sec.querySelector("select");
grp.value = "Slide"; grp.dispatchEvent(new Event("change"));
await new Promise((r) => setTimeout(r, 1500));
const cvs = Array.from(sec.querySelectorAll(".film-cell canvas"));
const filled = cvs.filter((cv) => { const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false; });
if (cvs.length < 4 || filled.length !== cvs.length) throw new Error(`thumbnails: ${filled.length} of ${cvs.length} rendered`);
// clicking a cell adds a look layer
const before = editor.layers.length;
sec.querySelector(".film-cell").click();
await new Promise((r) => setTimeout(r, 300));
const added = editor.layers.find((l) => l.kind === "filter" && l.filter === "film.look");
if (editor.layers.length !== before + 1 || !added) throw new Error("click did not add a look layer");
await c("remove_layer", { layer: added.id });
sec.open = false;
return { thumbnails: cvs.length };
"""),
    ("panel_over_the_active_look", """
// docs/PLAN_0_1_43.md B3: with a black-and-white look layer active a click replaces that look, so the thumbnails show
// each stock over the picture below it (they were drawn over the whole composite and came out grey); a click on the
// look's row in the layer list (no "changed" event) brings them back. The grid fills the section (it shrank to one column)
const sec = Array.from(editor.root.querySelectorAll("details")).find((d) => d.querySelector("summary") && d.querySelector("summary").textContent === "Film looks");
if (!sec) throw new Error("Film looks panel missing");
sec.open = true;
const grp = sec.querySelector("select");
const bwGroup = Array.from(grp.options).map((o) => o.value).find((v) => /black|white|mono|b&w/i.test(v));
if (!bwGroup) throw new Error("no black-and-white group: " + Array.from(grp.options).map((o) => o.value).join(", "));
grp.value = bwGroup; grp.dispatchEvent(new Event("change"));
await new Promise((r) => setTimeout(r, 900));
sec.querySelector(".film-cell").click();
await new Promise((r) => setTimeout(r, 300));
const look = editor.layers.find((l) => l.kind === "filter" && l.filter === "film.look");
if (!look) throw new Error("no look layer");
grp.value = "Slide"; grp.dispatchEvent(new Event("change"));
const colour = async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const cvs = Array.from(sec.querySelectorAll(".film-cell canvas"));
    let n = 0;
    for (const cv of cvs) {
        const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
        let best = 0;
        for (let i = 0; i < d.length; i += 4) best = Math.max(best, Math.abs(d[i] - d[i + 1]), Math.abs(d[i + 1] - d[i + 2]), Math.abs(d[i] - d[i + 2]));
        if (best > 16) n++;
    }
    return { coloured: n, of: cvs.length };
};
await c("set_active_layer", { layer: look.id });
const active = await colour();
if (active.coloured !== active.of) throw new Error("thumbnails with the look active: " + JSON.stringify(active));
// the base active: the look stays in the composite and a click adds a layer on top, so the thumbnails go grey
editor.activeLayerId = null; editor.renderLayers();
editor.root.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
const other = await colour();
if (other.coloured) throw new Error("with the base active the thumbnails should show the look on top (grey): " + JSON.stringify(other));
// a click on the look's row: the panel looks again although no "changed" event comes
const row = editor.root.querySelector(`.ipc-layer[data-layer="${look.id}"]`);
if (!row) throw new Error("no row for the look layer");
row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const clicked = await colour();
if (clicked.coloured !== clicked.of) throw new Error("after a click on the look's row: " + JSON.stringify({ clicked, other }));
const grid = sec.querySelector(".film-grid");
const cols = getComputedStyle(grid).gridTemplateColumns.split(" ").length;
if (grid.getBoundingClientRect().width > 220 && cols < 2) throw new Error(`one column in a ${Math.round(grid.getBoundingClientRect().width)} px grid`);
await c("remove_layer", { layer: look.id });
sec.open = false;
return { active, other, clicked, cols, width: Math.round(grid.getBoundingClientRect().width), section: Math.round(sec.getBoundingClientRect().width) };
"""),
    ("panel_hover_preview", """
const sec = Array.from(editor.root.querySelectorAll("details")).find((d) => d.querySelector("summary") && d.querySelector("summary").textContent === "Film looks");
if (!sec) throw new Error("Film looks panel missing");
sec.open = true;
const grp = sec.querySelector("select");
grp.value = "Slide"; grp.dispatchEvent(new Event("change"));
await new Promise((r) => setTimeout(r, 600));

const grid = sec.querySelector(".film-grid");
const cells = Array.from(sec.querySelectorAll(".film-cell"));
if (!cells.length) throw new Error("no film cells in Slide group");
const targetCell = cells[0];
const targetStockId = targetCell.getAttribute("data-id");

// 1. Without look layer: hover on cell changes nothing
editor.activeLayerId = null;
editor.renderLayers();
const lookBefore = editor.layers.find((l) => l.kind === "filter" && l.filter === "film.look");
if (lookBefore) throw new Error("expected no look layer initially");
const undo0 = editor.undo.length;

targetCell.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
await new Promise((r) => setTimeout(r, 200));

if (editor.layers.find((l) => l.kind === "filter" && l.filter === "film.look")) {
    throw new Error("hover without look layer should not create a look layer");
}
if (editor.filterPreview !== null) {
    throw new Error("filterPreview should be null without look layer");
}
if (editor.undo.length !== undo0) {
    throw new Error("hover without look layer should not change undo");
}

// 2. With look layer active: hover on Slide cell changes preset, pushes no undo step
const added = await c("add_filter", { type: "film.look", params: { preset: "portra400" }, name: "Kodak Portra 400" });
await c("set_active_layer", { layer: added.id });
const look = editor.layers.find((l) => l.id === added.id);
editor.renderLayers();
const initialPreset = look.params.preset;
const initialName = look.name;
const undo1 = editor.undo.length;

targetCell.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
await new Promise((r) => setTimeout(r, 200));

if (look.params.preset !== targetStockId) {
    throw new Error(`hover should change preset to ${targetStockId}, got ${look.params.preset}`);
}
if (editor.filterPreview !== look.id) {
    throw new Error(`filterPreview should be ${look.id}, got ${editor.filterPreview}`);
}
if (editor.undo.length !== undo1) {
    throw new Error(`hover should push NO undo step, had ${undo1} now ${editor.undo.length}`);
}

// 3. Leaving grid restores initial preset with _undoPending null
grid.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true }));
if (look.params.preset !== initialPreset) {
    throw new Error(`pointerleave should restore initial preset ${initialPreset}, got ${look.params.preset}`);
}
if (look._undoPending !== null) {
    throw new Error(`pointerleave should leave _undoPending null, got ${look._undoPending}`);
}
if (editor.filterPreview !== null) {
    throw new Error(`pointerleave should clear filterPreview, got ${editor.filterPreview}`);
}

// 4. Hover plus click pushes 1 undo step; undo restores initial state
targetCell.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
await new Promise((r) => setTimeout(r, 200));
targetCell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 300));

if (look.params.preset !== targetStockId) {
    throw new Error(`click should apply preset ${targetStockId}, got ${look.params.preset}`);
}
if (editor.undo.length !== undo1 + 1) {
    throw new Error(`hover plus click should push exactly 1 undo step: expected ${undo1 + 1}, got ${editor.undo.length}`);
}

// Undo restores initial state
await editor.undoStep();
if (look.params.preset !== initialPreset) {
    throw new Error(`undo should restore initial preset ${initialPreset}, got ${look.params.preset}`);
}
if (look.name !== initialName) {
    throw new Error(`undo should restore initial name ${initialName}, got ${look.name}`);
}

// 5. Measure and report 15000 x 10000 hover response time
const vpCanvas = document.createElement("canvas");
vpCanvas.width = 1200; vpCanvas.height = 800;
const vpCtx = vpCanvas.getContext("2d");
vpCtx.fillStyle = "#808080";
vpCtx.fillRect(0, 0, 1200, 800);
const t0 = performance.now();
editor.filteredCanvas(look, vpCanvas, false, true);
const hover15kMs = performance.now() - t0;

await c("remove_layer", { layer: look.id });
sec.open = false;
return { ok: true, targetStockId, hover15kMs: +hover15kMs.toFixed(1) };
"""),
    ("exports", """
const H = (await import("./editor/host.js")).host;
const cases = [["look_portra400", "film.look", { preset: "portra400" }], ["halation", "film.halation", { strength: 80 }], ["frame_instant", "film.frame", { style: "instant" }], ["bw_red", "film.bw", { preset: "red", filter_hue: 10, filter_strength: 90 }], ["points", null, null]];
const files = [];
for (const [name, type, params] of cases) {
  let layer = null;
  if (type) layer = await c("add_filter", { type, params, name });
  const path = %s + "/" + name + ".png";
  const r = await c("export", { format: "png", path });
  if (!r || !r.file || !r.file.path) throw new Error("export " + name + ": " + JSON.stringify(r).slice(0, 120));
  files.push(r.file.name);
  if (layer) await c("remove_layer", { layer: layer.id });
}
H.exportPath = null;
return { files };
""" % FILM_DIR),
    ("close", """
await c("close_document", { doc: window.__filmDoc, force: true });
return { closed: true };
"""),
]


async def main():
    sys.stdout.reconfigure(encoding="utf-8")

    # Run Node unit tests first
    proc = subprocess.run(["node", "tools/points_shapes_test.js"], capture_output=True, text=True)
    if proc.returncode != 0:
        print("FAIL points_shapes_test.js:\n", proc.stdout, proc.stderr)
        return False
    print("PASS points_shapes_test.js")

    async def run(cdp):
        ev = cdp.eval
        await ev("(() => { window.__log = []; return 1; })()")
        failed = 0
        for name, body in STEPS:
            js = "(async () => { const raw = await import('./commands.js'); const c = (n, a) => raw.commands.run(n, a || {}); const editor = window.editor; " + body + " })()"
            try:
                res = await ev(js)
                print(f"PASS {name}: {json.dumps(res)[:300]}")
                if name == "point_tool":
                    await cdp.call("Emulation.setFocusEmulationEnabled", enabled=True)
                    await cdp.call("Input.dispatchKeyEvent", type="keyDown", key="Escape", code="Escape", windowsVirtualKeyCode=27, nativeVirtualKeyCode=27)
                    await cdp.call("Input.dispatchKeyEvent", type="keyUp", key="Escape", code="Escape", windowsVirtualKeyCode=27, nativeVirtualKeyCode=27)
                    sel = await ev("(() => { const l = window.editor.layers.find(l => l.id === window.__pointsLayer); return l._fpSel; })()")
                    if sel is not None:
                        raise RuntimeError(f"Escape key did not deselect point: _fpSel is {sel}")
                    await ev("(() => { const l = window.editor.layers.find(l => l.id === window.__pointsLayer); l.params.points = l.params.points.slice(0, 2); window.editor.setTool('select'); })()")
                    print("  [ok] real Escape through CDP deselected point (_fpSel is null)")
            except Exception as err:  # noqa: BLE001
                failed += 1
                print(f"FAIL {name}: {err}")
                try:
                    log = await ev("JSON.stringify((window.__log || []).slice(-8))")
                    print("  console:", str(log)[:1200])
                except Exception:  # noqa: BLE001
                    pass
        print("RESULT", "PASS" if not failed else f"FAIL ({failed})")
        return not failed

    return await session(run)


if __name__ == "__main__":
    sys.exit(0 if asyncio.run(main()) else 1)
