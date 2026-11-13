// Plain-Node check of Deep paint's helper models (docs/PLAN_SURFACE_PAINT.md SP2), no Electron: the decomposition set
// (Marigold IID Lighting, Scumble's ONNX export) and MoGe-2 normal on a synthetic scene (a red ball lit from the upper
// left in front of a warm wall), through the helpers' process and through the engine on this thread.
//
//     node tools/deeppaint_helpers_test.js <modelsDir> [--cpu] [--normals moge2_vits_normal]
//
// The folder holds the set in onnx/intrinsic/ and the MoGe-2 files under their registry names (models.js). Checks:
// the registry (the set offered from its repo at a pinned commit, present when its files are in place; MoGe-2 pinned
// to commits), the refusals of sizes out of range, the decomposition's sense (the ball's albedo more even than the
// picture, its shading following the light), the normals' frame (against the model's own points), the same
// seed giving the same bytes and another seed other bytes, a size that is no multiple of 64 coming back at its size,
// and every answer byte for byte the same in the helpers' process and on this thread. Exits non-zero on a failure or
// when a model is missing.
"use strict";

const path = require("node:path");
const models = require("../electron/main/onnx/models");
const { Runtime } = require("../electron/main/onnx/runtime");
const { engine, modelInfo } = require("../electron/main/onnx/engine");
const { HelperProcess } = require("../electron/main/onnx/helpers");
const { gaussian } = require("../electron/main/onnx/intrinsic");

const args = process.argv.slice(2);
const dir = args[0] && !args[0].startsWith("--") ? path.resolve(args[0]) : null;
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const device = args.includes("--cpu") ? "cpu" : "auto";
const normalsId = flag("--normals", "moge2_vitb_normal");

let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`); if (!ok) failures++; return ok; };

const srgb = (v) => { v = Math.max(0, Math.min(1, v)); return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)); };
const LIGHT = (() => { const l = [-0.5, -0.6, -0.62]; const n = Math.hypot(...l); return l.map((x) => x / n); })();

/** The scene at w × h: a red ball (albedo 0.6, 0.08, 0.06; Lambert from the upper left) on a warm wall lit by a ramp. */
function scene(w, h) {
    const rgba = new Uint8Array(w * h * 4);
    const cx = w * 0.5, cy = h * 0.52, r = Math.min(w, h) * 0.32;
    const ball = new Uint8Array(w * h), lambert = new Float32Array(w * h), nx = new Float32Array(w * h), ny = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x, dx = (x + 0.5 - cx) / r, dy = (y + 0.5 - cy) / r, d2 = dx * dx + dy * dy;
            let c;
            if (d2 < 1) {
                const dz = -Math.sqrt(1 - d2);   // the camera's frame: z away from the viewer, the ball's front faces us
                const l = Math.max(0, -(dx * LIGHT[0] + dy * LIGHT[1] + dz * LIGHT[2]));
                const s = 0.08 + 0.92 * l;
                c = [0.6 * s, 0.08 * s, 0.06 * s];
                ball[i] = 1; lambert[i] = s; nx[i] = dx; ny[i] = dy;
            } else {
                const s = 0.35 + 0.45 * (1 - x / w);
                c = [0.7 * s, 0.6 * s, 0.5 * s];
            }
            rgba[4 * i] = srgb(c[0]); rgba[4 * i + 1] = srgb(c[1]); rgba[4 * i + 2] = srgb(c[2]); rgba[4 * i + 3] = 255;
        }
    }
    return { rgba, ball, lambert, nx, ny, w, h };
}

function pearson(a, b) {
    const n = a.length;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
    return sab / Math.sqrt(saa * sbb);
}

/** Coefficient of variation of a channel sum over the ball's inner part (away from its rim). */
function cv(values) {
    let m = 0;
    for (const v of values) m += v;
    m /= values.length;
    let s = 0;
    for (const v of values) s += (v - m) ** 2;
    return Math.sqrt(s / values.length) / m;
}

function sameBytes(a, b) {
    if (!a || !b || a.length !== b.length || a.constructor !== b.constructor) return false;
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return Buffer.compare(Buffer.from(x), Buffer.from(y)) === 0;
}

const finite01 = (arr, lo, hi) => { for (let i = 0; i < arr.length; i++) if (!(arr[i] >= lo && arr[i] <= hi)) return false; return true; };

async function main() {
    if (!dir) { console.log("usage: node tools/deeppaint_helpers_test.js <modelsDir> [--cpu]"); process.exit(2); }
    console.log("models in", dir, "· device", device);

    // ---- the registry ------------------------------------------------------------------------------------------
    const set = models.byId("intrinsic");
    check("the decomposition set: in onnx/intrinsic, four files with size and sha256, offered from its repo pinned to a commit",
        set && set.subdir === "onnx/intrinsic" && set.strict && !set.invalid && set.files.length === 4
        && set.files.every((f) => f.size > 0 && /^[0-9a-f]{64}$/.test(f.sha256) && /^https:[/][/]huggingface[.]co[/]DenRakEiw[/]scumble-intrinsic-onnx[/]resolve[/][0-9a-f]{40}[/][a-z_]+[.](onnx|json)$/.test(f.url))
        && models.offered(set) && /Open RAIL[+][+]-M/.test(models.termsText(set)) && /Hugging Face/.test(models.termsText(set)),
        set && JSON.stringify({ subdir: set.subdir, invalid: set.invalid, offered: models.offered(set) }));
    const setFiles = models.paths(set, dir);
    check("the set present from the files in its folder, its row listed", !!setFiles
        && models.describeAll(dir).some((r) => r.id === "intrinsic" && r.present && r.offered === true && r.set === true));
    const nm = models.byId(normalsId);
    check("MoGe-2 normal rows: offered, pinned to a commit, one file with its sha256",
        ["moge2_vitb_normal", "moge2_vits_normal"].every((id) => {
            const m = models.byId(id);
            return m && m.kind === "normals" && models.offered(m) && m.files.length === 1 && /\/resolve\/[0-9a-f]{40}\/model\.onnx$/.test(m.files[0].url) && /^[0-9a-f]{64}$/.test(m.files[0].sha256);
        }));
    const nFiles = models.paths(nm, dir);
    if (!setFiles || !nFiles) { console.log(`FAIL a model is missing in ${dir} (set ${!!setFiles}, ${normalsId} ${!!nFiles})`); process.exit(1); }

    // ---- the refusals (no model loaded for these) --------------------------------------------------------------
    const local = engine(new Runtime());
    local.runtime.setDevice(device);
    const refuse = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e); } };
    const big = scene(800, 400);
    const r1 = await refuse(() => local.intrinsic({ model: modelInfo(set), files: setFiles, image: big.rgba, width: 800, height: 400 }));
    check("the decomposition refuses a side above 768", !!r1 && /16 to 768/.test(r1), r1);
    const r2 = await refuse(() => local.normals({ model: modelInfo(nm), files: nFiles, image: new Uint8Array(10), width: 64, height: 64 }));
    check("the normal model refuses an image of the wrong length", !!r2 && /14 to 2048/.test(r2), r2);

    // ---- the jobs: through the helpers' process, then on this thread -------------------------------------------
    const W = 512, H = 384;
    const sc = scene(W, H);
    const odd = scene(301, 227);
    const jobs = [
        ["intrinsic", "intrinsic", { device, model: modelInfo(set), files: setFiles, image: sc.rgba, width: W, height: H, seed: 0 }],
        ["intrinsic_odd", "intrinsic", { device, model: modelInfo(set), files: setFiles, image: odd.rgba, width: odd.w, height: odd.h, seed: 0 }],
        ["intrinsic_seed7", "intrinsic", { device, model: modelInfo(set), files: setFiles, image: sc.rgba, width: W, height: H, seed: 7 }],
        ["normals", "normals", { device, model: modelInfo(nm), files: nFiles, image: sc.rgba, width: W, height: H }],
        ["normals_odd", "normals", { device, model: modelInfo(nm), files: nFiles, image: odd.rgba, width: odd.w, height: odd.h }],
    ];
    const hp = new HelperProcess({ idleMs: 0 });
    const viaProc = {}, viaLocal = {};
    try {
        for (const [name, type, job] of jobs) {
            const t = Date.now();
            viaProc[name] = await hp.call(type, job);
            console.log(`process ${name}: ${Date.now() - t} ms on ${viaProc[name].provider}${viaProc[name].ms ? " " + JSON.stringify(viaProc[name].ms) : ""}`);
        }
        check("the jobs ran in the helpers' process", hp.state === "ready" && hp.pid && hp.pid !== process.pid, `state ${hp.state}`);
        // a second run of the first job warm, for the timing line
        const t = Date.now();
        const warm = await hp.call("intrinsic", jobs[0][2]);
        console.log(`process intrinsic warm: ${Date.now() - t} ms ${JSON.stringify(warm.ms)}`);
        check("the same picture and seed twice in the process: the same bytes", ["albedo", "shading", "residual"].every((k) => sameBytes(warm[k], viaProc.intrinsic[k])));
    } finally {
        await hp.kill({ reason: "quit" });
    }
    for (const [name, type, job] of jobs) {
        const t = Date.now();
        viaLocal[name] = await local[type](job);
        console.log(`local ${name}: ${Date.now() - t} ms on ${viaLocal[name].provider}`);
    }
    await local.free();
    for (const [name, type] of jobs) {
        const keys = type === "intrinsic" ? ["albedo", "shading", "residual"] : ["normal", "points", "mask"];
        const a = viaProc[name], b = viaLocal[name];
        check(`${name}: byte for byte the same in the process and on this thread`, keys.every((k) => sameBytes(a[k], b[k])) && (type !== "normals" || a.scale === b.scale),
            keys.map((k) => `${k} ${a[k] && a[k].length}`).join(", "));
    }

    // ---- what the answers say -----------------------------------------------------------------------------------
    const d = viaProc.intrinsic;
    const n3 = W * H * 3;
    check("decomposition: three interleaved RGB maps at the picture's size, every value in [0, 1]",
        d.width === W && d.height === H && ["albedo", "shading", "residual"].every((k) => d[k] instanceof Float32Array && d[k].length === n3 && finite01(d[k], 0, 1)));
    const o = viaProc.intrinsic_odd;
    check("a size that is no multiple of 64 (301 × 227) comes back at its size", o.width === 301 && o.height === 227 && o.albedo.length === 301 * 227 * 3 && finite01(o.shading, 0, 1));
    // the ball's inner part (its rim mixes wall and ball)
    const inner = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (sc.ball[i] && Math.hypot(sc.nx[i], sc.ny[i]) < 0.85) inner.push(i);
    }
    const lumIn = inner.map((i) => sc.rgba[4 * i] + sc.rgba[4 * i + 1] + sc.rgba[4 * i + 2]);
    const lumA = inner.map((i) => d.albedo[3 * i] + d.albedo[3 * i + 1] + d.albedo[3 * i + 2]);
    const lumS = inner.map((i) => d.shading[3 * i] + d.shading[3 * i + 1] + d.shading[3 * i + 2]);
    const cvIn = cv(lumIn), cvA = cv(lumA);
    check("the ball's albedo is more even than the picture (the light taken out)", cvA < 0.6 * cvIn, `cv albedo ${cvA.toFixed(3)}, picture ${cvIn.toFixed(3)}`);
    const pS = pearson(lumS, inner.map((i) => sc.lambert[i]));
    check("the ball's shading follows the light", pS > 0.8, `Pearson ${pS.toFixed(3)}`);
    const redA = inner.reduce((a, i) => a + d.albedo[3 * i], 0) / inner.length, greenA = inner.reduce((a, i) => a + d.albedo[3 * i + 1], 0) / inner.length;
    check("the ball's albedo is red", redA > 2.5 * greenA, `R ${redA.toFixed(3)}, G ${greenA.toFixed(3)}`);
    const s7 = viaProc.intrinsic_seed7;
    let diff = 0, maxd = 0;
    for (let i = 0; i < n3; i++) { const e = Math.abs(s7.shading[i] - d.shading[i]); diff += e; if (e > maxd) maxd = e; }
    check("another seed gives other bytes, close to the first", !sameBytes(s7.shading, d.shading) && diff / n3 < 0.02, `mean |Δ| ${(diff / n3).toFixed(4)}, max ${maxd.toFixed(3)}`);
    // a check of the generator itself: mean 0, variance 1
    const g = gaussian(200000, 3);
    let gm = 0, gv = 0;
    for (const v of g) gm += v;
    gm /= g.length;
    for (const v of g) gv += (v - gm) ** 2;
    gv /= g.length;
    check("the seeded noise is a standard normal", Math.abs(gm) < 0.01 && Math.abs(gv - 1) < 0.02, `mean ${gm.toFixed(4)}, var ${gv.toFixed(4)}`);

    const nr = viaProc.normals;
    let unit = true;
    for (let i = 0; i < W * H; i++) { const l = Math.hypot(nr.normal[3 * i], nr.normal[3 * i + 1], nr.normal[3 * i + 2]); if (!(Math.abs(l - 1) < 0.01)) { unit = false; break; } }
    check("normals: unit vectors at the picture's size, points and mask beside them",
        nr.width === W && nr.height === H && nr.normal.length === n3 && nr.points.length === n3 && nr.mask.length === W * H && unit && Number.isFinite(nr.scale), `scale ${nr.scale}, tokens ${nr.tokens}`);
    // The frame, from the model's own geometry (a lone shaded ball reads as a ball or as a dish lit from the other
    // side, so the scene cannot say which way it bulges; the points and the normals must agree whatever it reads):
    // x grows to the right, y downwards, z away from the viewer, and a normal faces the viewer where the surface is
    // seen, i.e. along cross(dP/dy, dP/dx).
    const P = nr.points, N = nr.normal;
    let agree = 0, count = 0, xRight = 0, yDown = 0, zAway = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (nr.mask[i] < 0.5) continue;
        const r = 3 * (i + 1), l = 3 * (i - 1), dn = 3 * (i + W), up = 3 * (i - W);
        const ax = P[r] - P[l], ay = P[r + 1] - P[l + 1], az = P[r + 2] - P[l + 2];        // dP/dx
        const bx = P[dn] - P[up], by = P[dn + 1] - P[up + 1], bz = P[dn + 2] - P[up + 2];   // dP/dy
        const cx = by * az - bz * ay, cy = bz * ax - bx * az, cz = bx * ay - by * ax;      // dP/dy × dP/dx
        const len = Math.hypot(cx, cy, cz);
        if (!(len > 0)) continue;
        agree += (cx * N[3 * i] + cy * N[3 * i + 1] + cz * N[3 * i + 2]) / len;
        count++;
        if (ax > 0) xRight++;
        if (by > 0) yDown++;
        if (P[3 * i + 2] > 0) zAway++;
    }
    const mean = agree / count;
    check("the normals' frame: x right, y down, z away, the normal along dP/dy × dP/dx (towards the viewer)",
        count > W * H * 0.2 && mean > 0.9 && xRight > 0.95 * count && yDown > 0.95 * count && zAway > 0.99 * count,
        `mean cos ${mean.toFixed(3)} over ${count} pixels, x right ${(xRight / count).toFixed(3)}, y down ${(yDown / count).toFixed(3)}, z > 0 ${(zAway / count).toFixed(3)}`);
    const zc = inner.filter((i) => Math.hypot(sc.nx[i], sc.ny[i]) < 0.2).reduce((a, i) => a + N[3 * i + 2], 0);
    check("the ball's front faces the viewer (z < 0 at its centre)", zc < 0);
    const no = viaProc.normals_odd;
    check("normals at an odd size (301 × 227) come back at its size", no.width === 301 && no.height === 227 && no.normal.length === 301 * 227 * 3);

    console.log(failures ? `FAIL ${failures}` : "PASS");
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("FAIL", e && e.stack || e); process.exit(1); });
