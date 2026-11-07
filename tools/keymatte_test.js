// The key matte's refine (renderer/editor/keymatte.js, docs/PLAN_CORRIDORKEY.md session I6) under plain Node.
//
//   node tools/keymatte_test.js            the tests (exit 1 on a failure)
//   node tools/keymatte_test.js --measure  the edge measurement that chose the method and the guide
//                                          (docs/ck2/refine_notes.md): synthetic edges, every method and guide
//   node tools/keymatte_test.js --time     the module alone on 4k, 8k and 15k boxes (JS twin and px.wasm boxes)
//
// The synthetic scenes are made the way a camera and the engine would: the truth alpha at full resolution (4 x 4
// supersampled), subject and screen mixed in linear light and encoded to sRGB bytes; the bucket picture the byte
// average of s x s blocks (what the tile levels give); the engine's matte the area average of the truth, softened by
// one [1 2 1] pass (a model's matte is a little softer than the ideal).

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const EDITOR = path.join(ROOT, "renderer", "editor");
const imp = (f) => import(pathToFileURL(path.join(EDITOR, f)).href);

// ---- colour and scenes ---------------------------------------------------------------------------------------------

const LINF = (b) => { const v = b / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const ENC = (v) => { v = Math.max(0, Math.min(1, v)); const x = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; return Math.round(x * 255); };
const lin3 = (c) => c.map(LINF);
const lum = (l) => 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
const GREEN = [60, 170, 70], BLUE = [40, 70, 190];
/** A colour scaled in linear light to the luminance of `target` (sRGB bytes in, linear out). */
function sameLum(colour, target) { const l = lin3(colour), k = lum(lin3(target)) / lum(l); return l.map((v) => Math.min(1, v * k)); }

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const TAN = Math.tan(7 * Math.PI / 180);

/**
 * A scene at upscale factor s over `cells` x `cellsY` bucket pixels. Returns the truth (W x H floats), the full picture
 * (RGBA bytes), the bucket picture and the engine's matte (cells floats), and the true edge per row (or null).
 */
function scene(kind, s, cells = 40, { noise = 0, seed = 7, soft: blurred = true, avg = "bytes", pnoise = 0, subject = null } = {}) {
    const W = cells * s, H = cells * s;
    const screen = kind === "blue" ? BLUE : GREEN, Bl = lin3(screen);
    const skin = sameLum([220, 150, 120], screen);
    const e0 = 0.45 * W, edge = (y) => e0 + (y - H / 2) * TAN;
    let inside = null, soft = null, F = () => skin, B = () => Bl, sharp = true;
    if (kind === "skin" || kind === "blue") inside = (x, y) => x >= edge(y);
    else if (kind === "teal") { const t = lin3([0, 140, 140]); inside = (x, y) => x >= edge(y); F = () => t; }
    else if (kind === "near") { const t = lin3(subject || [60, 158, 82]); inside = (x, y) => x >= edge(y); F = () => t; }
    else if (kind === "fold") {
        const dark = skin.map((v) => v * 0.35);
        inside = (x, y) => x >= edge(y);
        F = (x, y) => { const d = x - edge(y); return d > 0.75 * s && d < 1.25 * s ? dark : skin; };
    } else if (kind === "shade") {
        const sh = Bl.map((v) => v * 0.45);
        inside = (x, y) => x >= edge(y);
        B = (x, y) => { const d = edge(y) - x; return d > 0 && d < 1.5 * s ? sh : Bl; };
    } else if (kind === "stripes") {
        const white = [0.8, 0.8, 0.78], navy = [0.02, 0.03, 0.12], per = 1.5 * s;
        inside = (x, y) => x >= edge(y);
        F = (x, y) => (Math.floor(y / per) % 2 ? white : navy);
    } else if (kind === "blur") {
        sharp = false;
        const half = 1.5 * s;
        soft = (x, y) => Math.max(0, Math.min(1, (x - edge(y) + half) / (2 * half)));
    } else if (kind === "hair") {
        sharp = false;
        const brown = lin3([70, 45, 30]), R = rng(seed);
        const strands = [];
        for (let k = 0; k < 9; k++) strands.push({ xc: (0.15 + 0.5 * R()) * W, a: (0.02 + 0.06 * R()) * W, l: (0.3 + 0.7 * R()) * H, p: R() * 6.28, wd: 0.8 + 1.4 * R() });
        inside = (x, y) => {
            if (x >= 0.72 * W) return true;
            for (const t of strands) if (Math.abs(x - (t.xc + t.a * Math.sin(6.2832 * y / t.l + t.p))) < t.wd / 2) return true;
            return false;
        };
        F = () => brown;
    } else if (kind === "flat") {
        sharp = false;
        soft = () => 0;
    } else throw new Error("unknown scene " + kind);
    const truth = new Float32Array(W * H), rgba = new Uint8ClampedArray(W * H * 4), PR = rng(seed + 2);
    for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
        let a = 0;
        if (soft) a = soft(X + 0.5, Y + 0.5);
        else { for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if (inside(X + (i + 0.5) / 4, Y + (j + 0.5) / 4)) a++; a /= 16; }
        const f = F(X + 0.5, Y + 0.5), b = B(X + 0.5, Y + 0.5), o = (Y * W + X) * 4;
        truth[Y * W + X] = a;
        // the sensor's noise: +-pnoise levels on the bytes (uniform)
        for (let c = 0; c < 3; c++) rgba[o + c] = ENC(a * f[c] + (1 - a) * b[c]) + (pnoise ? Math.round((PR() - 0.5) * 2 * pnoise) : 0);
        rgba[o + 3] = 255;
    }
    const { small, alpha } = bucketOf(truth, rgba, W, H, s, noise, seed, blurred, avg);
    return { kind, s, W, H, truth, rgba, small, alpha, aw: cells, ah: cells, edge: sharp ? edge : null, screen };
}

/** The bucket picture (byte averages of s x s blocks) and the engine's matte (area average, one [1 2 1] pass). */
function bucketOf(truth, rgba, W, H, s, noise = 0, seed = 7, blurred = true, avg = "bytes") {
    const aw = W / s, ah = H / s, n = aw * ah, d = new Uint8ClampedArray(n * 4), avgA = new Float32Array(n);
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
        let a = 0; const c = [0, 0, 0];
        for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) {
            const k = (y * s + j) * W + x * s + i;
            a += truth[k];
            for (let q = 0; q < 3; q++) c[q] += avg === "linear" ? LINF(rgba[k * 4 + q]) : rgba[k * 4 + q];
        }
        const o = y * aw + x;
        avgA[o] = a / (s * s);
        for (let q = 0; q < 3; q++) d[o * 4 + q] = avg === "linear" ? ENC(c[q] / (s * s)) : Math.round(c[q] / (s * s));
        d[o * 4 + 3] = 255;
    }
    const tmp = new Float32Array(n), alpha = new Float32Array(n), R = rng(seed + 1);
    const at = (src, x, y) => src[Math.min(ah - 1, Math.max(0, y)) * aw + Math.min(aw - 1, Math.max(0, x))];
    // the engine's softness: `blurred` passes of [1 2 1] (true = 1)
    let area = avgA;
    for (let pass = 0; pass < Number(blurred); pass++) {
        const next = new Float32Array(n);
        for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) tmp[y * aw + x] = (at(area, x - 1, y) + 2 * at(area, x, y) + at(area, x + 1, y)) / 4;
        for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) next[y * aw + x] = (at(tmp, x, y - 1) + 2 * at(tmp, x, y) + at(tmp, x, y + 1)) / 4;
        area = next;
    }
    for (let i = 0; i < n; i++) {
        let v = area[i];
        if (noise) v += (R() - 0.5) * 2 * noise;
        alpha[i] = Math.max(0, Math.min(1, v));
    }
    return { small: { data: d, width: aw, height: ah }, alpha };
}

// ---- metrics -------------------------------------------------------------------------------------------------------

/**
 * MAE and p99 over the edge region (pixels within s of a pixel where the truth or the unrefined matte is between 0 and
 * 1), away from the crop's borders by 2s; for sharp edges the leak (the largest error farther than 1.5 px from the
 * true edge: the transition left outside +-1 px of it) and the largest error of the 0.5 crossing per row.
 */
function score(sc, est, bil) {
    const { W, H, s, truth, edge } = sc, m = 2 * s;
    const mark = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) if ((truth[i] > 0.002 && truth[i] < 0.998) || (bil[i] > 1 && bil[i] < 254)) mark[i] = 1;
    const reg = new Uint8Array(W * H);
    for (let y = m; y < H - m; y++) for (let x = m; x < W - m; x++) {
        let hit = 0;
        for (let j = -s; j <= s && !hit; j += Math.max(1, s >> 2)) for (let i = -s; i <= s; i += Math.max(1, s >> 2)) if (mark[(y + j) * W + x + i]) { hit = 1; break; }
        reg[y * W + x] = hit;
    }
    const errs = [];
    for (let i = 0; i < W * H; i++) if (reg[i]) errs.push(Math.abs(est[i] - truth[i] * 255));
    errs.sort((a, b) => a - b);
    const mae = errs.reduce((a, b) => a + b, 0) / Math.max(1, errs.length), p99 = errs[Math.floor(errs.length * 0.99)] || 0;
    let leak = null, cross = null;
    if (edge) {
        leak = 0; cross = 0;
        for (let y = m; y < H - m; y++) {
            const e = edge(y + 0.5);
            for (let x = m; x < W - m; x++) if (Math.abs(x + 0.5 - e) > 1.5) leak = Math.max(leak, Math.abs(est[y * W + x] - truth[y * W + x] * 255));
            // the 0.5 crossing nearest the true edge
            let best = null;
            for (let x = Math.max(m, Math.floor(e - 3 * s)); x < Math.min(W - m - 1, Math.ceil(e + 3 * s)); x++) {
                const a = est[y * W + x], b = est[y * W + x + 1];
                if ((a < 127.5) !== (b < 127.5)) { const c = x + 0.5 + (127.5 - a) / (b - a); if (best == null || Math.abs(c - e) < Math.abs(best - e)) best = c; }
            }
            cross = Math.max(cross, best == null ? 99 : Math.abs(best - e));
        }
    }
    return { mae, p99, leak, cross };
}

/**
 * The largest difference from the unrefined matte farther than `d` bucket pixels from the true edge (both sides), away
 * from the crop's borders by 2s: where the engine was sure, the refine must not add anything (noise, a wrong guide).
 */
function far(sc, est, bil, d = 3) {
    const { W, H, s } = sc;
    let m = 0;
    for (let y = 2 * s; y < H - 2 * s; y++) {
        const e = sc.edge(y + 0.5);
        for (let x = 2 * s; x < W - 2 * s; x++) if (Math.abs(x + 0.5 - e) > d * s) m = Math.max(m, Math.abs(est[y * W + x] - bil[y * W + x]));
    }
    return m;
}

/** Filters a caller might wrongly composite into the full-resolution read only (the bucket stays unfiltered). */
const FILTERS = {
    "saturation 50%": (o) => { for (let i = 0; i < o.length; i += 4) { const y = 0.299 * o[i] + 0.587 * o[i + 1] + 0.114 * o[i + 2]; for (let c = 0; c < 3; c++) o[i + c] = Math.round(y + 0.5 * (o[i + c] - y)); } },
    "gamma 0.8": (o) => { for (let i = 0; i < o.length; i++) if ((i & 3) !== 3) o[i] = Math.round(255 * Math.pow(o[i] / 255, 0.8)); },
    "green x0.85": (o) => { for (let i = 1; i < o.length; i += 4) o[i] = Math.round(o[i] * 0.85); },
    "+15 levels": (o) => { for (let i = 0; i < o.length; i++) if ((i & 3) !== 3) o[i] = Math.min(255, o[i] + 15); },
};
const filtered = (rgba, name) => { const o = Uint8ClampedArray.from(rgba); FILTERS[name](o); return o; };

async function refineScene(K, sc, opts) {
    const { W, rgba } = sc;
    const res = await K.refineMatte({
        alpha: sc.alpha, aw: sc.aw, ah: sc.ah, small: sc.small, full: { w: W, h: sc.H }, screen: sc.screen,
        read: (b) => rgba.subarray(b[1] * W * 4, b[3] * W * 4), ...opts,
    });
    return res.alpha;
}

// ---- --measure -----------------------------------------------------------------------------------------------------

async function measure() {
    const K = await imp("keymatte.js");
    const kinds = ["skin", "blue", "teal", "fold", "shade", "stripes", "blur", "hair"];
    const configs = [{ method: "bilinear" }];
    for (const guide of ["luma", "chroma", "dist"]) for (const fullK of [1, 1.5, 2]) for (const eps of [1e-4, 1e-3]) configs.push({ method: "full", guide, fullK, eps });
    for (const guide of ["luma", "chroma", "dist", "rgb"]) for (const r of [1, 2, 4, 6]) for (const eps of [1e-6, 1e-5, 1e-4]) configs.push({ method: "fast", guide, r, eps });
    const name = (c) => c.method === "bilinear" ? "bilinear" : c.method === "full" ? `full ${c.guide} K${c.fullK} e${c.eps}` : `fast ${c.guide} r${c.r} e${c.eps}${c.linear === false ? " sRGB" : ""}`;
    const out = [];
    for (const s of [4, 15]) {
        const table = new Map();
        for (const kind of kinds) {
            const sc = scene(kind, s);
            const bil = await refineScene(K, sc, { method: "bilinear" });
            for (const c of configs) {
                const est = c.method === "bilinear" ? bil : await refineScene(K, sc, c);
                const r = score(sc, est, bil);
                if (!table.has(name(c))) table.set(name(c), {});
                table.get(name(c))[kind] = r;
            }
        }
        // the summary: mean MAE over the scenes, the worst leak and crossing over the sharp ones
        const rows = [...table.entries()].map(([n, by]) => {
            const v = Object.values(by);
            const sharp = v.filter((x) => x.leak != null);
            return { n, mae: v.reduce((a, b) => a + b.mae, 0) / v.length, leak: Math.max(...sharp.map((x) => x.leak)), cross: Math.max(...sharp.map((x) => x.cross)), by };
        }).sort((a, b) => a.mae - b.mae);
        out.push(`\n== s = ${s} (a ${s * 1024}-px box keyed at 1,024 px), ${kinds.length} scenes; levels of 255, px ==`);
        out.push("config".padEnd(30) + "meanMAE  worstLeak  worstCross  | MAE per scene: " + kinds.join(" "));
        for (const r of rows) out.push(r.n.padEnd(30) + r.mae.toFixed(2).padStart(7) + r.leak.toFixed(0).padStart(11) + r.cross.toFixed(2).padStart(12) + "  | " + kinds.map((k) => r.by[k].mae.toFixed(1)).join(" "));
        // the best of each family, per scene in full
        for (const fam of ["bilinear", "full luma", "full chroma", "full dist", "fast luma", "fast chroma", "fast dist", "fast rgb"]) {
            const best = rows.find((r) => r.n.startsWith(fam));
            if (!best) continue;
            out.push(`  best ${fam.padEnd(12)} ${best.n}: ` + kinds.map((k) => { const x = best.by[k]; return `${k} mae ${x.mae.toFixed(1)} p99 ${x.p99.toFixed(0)}` + (x.leak != null ? ` leak ${x.leak.toFixed(0)} cross ${x.cross.toFixed(2)}` : ""); }).join("; "));
        }
    }
    // the engine's softness: what "auto" picks, against every fixed pass count, for engines of 0-3 passes
    out.push("\n== the engine's softness: auto's pick and MAE/leak per fixed pass count k (defaults otherwise) ==");
    for (const s of [4, 15]) for (const eng of [0, 1, 2, 3]) {
        const line = [];
        for (const kind of ["skin", "fold", "hair", "stripes"]) {
            const sc = scene(kind, s, 40, { soft: eng });
            const bil = await refineScene(K, sc, { method: "bilinear" });
            const st = K.prepareRefine({ alpha: sc.alpha, aw: sc.aw, ah: sc.ah, small: sc.small, full: { w: sc.W, h: sc.H } });
            const cells = [];
            for (const k of [0, 1, 2, 3, 4]) { const r = score(sc, await refineScene(K, sc, { soft: k }), bil); cells.push(`${k}:${r.mae.toFixed(1)}` + (r.leak != null ? `/${r.leak.toFixed(0)}` : "")); }
            line.push(`${kind} auto ${st.soft} [${cells.join(" ")}] bilinear ${score(sc, bil, bil).mae.toFixed(1)}`);
        }
        out.push(`s ${s} engine ${eng}: ` + line.join(" | "));
    }
    // the defaults: linear against sRGB guide, and a noisy matte (+-0.02 at the bucket)
    out.push("\n== the defaults: linear vs sRGB guide, and an engine matte with +-0.02 noise ==");
    for (const s of [4, 15]) for (const noise of [0, 0.02]) for (const linear of [true, false]) {
        const parts = [];
        for (const kind of kinds) {
            const sc = scene(kind, s, 40, { noise });
            const bil = await refineScene(K, sc, { method: "bilinear" });
            const r = score(sc, await refineScene(K, sc, { linear }), bil);
            parts.push(`${kind} ${r.mae.toFixed(1)}` + (r.leak != null ? `/${r.leak.toFixed(0)}/${r.cross.toFixed(2)}` : ""));
        }
        out.push(`s ${s} noise ${noise} ${linear ? "linear" : "sRGB  "}: ` + parts.join("  "));
    }
    // the three-channel guide's parameters over five conditions (two factors, a softer engine, sensor noise of +-3
    // levels on the bytes, and that noise with +-0.02 on the engine's matte): mean MAE per condition, the worst leak
    out.push("\n== the rgb guide: linear or sRGB, r, eps, flat; mean MAE of the 8 scenes per condition ==");
    const conds = [{ s: 4, soft: 1 }, { s: 15, soft: 1 }, { s: 4, soft: 2 }, { s: 15, soft: 1, pnoise: 3 }, { s: 4, soft: 1, pnoise: 3, noise: 0.02 }];
    out.push("conditions: " + conds.map((c) => JSON.stringify(c)).join(" "));
    const sets = conds.map((c) => kinds.map((k) => scene(k, c.s, 40, c)));
    const bils = [];
    for (const row of sets) { const b = []; for (const sc of row) b.push(await refineScene(K, sc, { method: "bilinear" })); bils.push(b); }
    const grid = [];
    for (const linear of [true, false]) for (const r of [2, 3, 4, 6]) for (const eps of [1e-6, 3e-6, 1e-5, 3e-5, 1e-4]) grid.push({ linear, r, eps });
    for (const flat of [5e-6, 1e-4]) grid.push({ linear: false, r: 4, eps: 3e-6, flat });
    const rows = [];
    for (const g of grid) {
        const per = []; let leak = 0, cross = 0;
        for (let c = 0; c < conds.length; c++) {
            let m = 0;
            for (let k = 0; k < kinds.length; k++) {
                const x = score(sets[c][k], await refineScene(K, sets[c][k], g), bils[c][k]);
                m += x.mae; if (x.leak != null) { leak = Math.max(leak, x.leak); cross = Math.max(cross, x.cross); }
            }
            per.push(m / kinds.length);
        }
        rows.push({ n: `${g.linear ? "linear" : "sRGB"} r${g.r} e${g.eps}${g.flat ? " flat" + g.flat : ""}`, all: per.reduce((a, b) => a + b) / per.length, per, leak, cross });
    }
    rows.sort((a, b) => a.all - b.all);
    for (const r of rows) out.push(r.n.padEnd(26) + r.all.toFixed(2).padStart(6) + "  per condition " + r.per.map((v) => v.toFixed(2)).join(" ") + `  worst leak ${r.leak.toFixed(0)}, crossing ${r.cross.toFixed(2)} px`);
    out.push(...(await measureGuards(K)));
    console.log(out.join("\n"));
}

/**
 * The review's round (docs/ck2/refine_notes.md "The guards"): sensor noise at full resolution, subjects near the
 * screen's colour, the zone and the noise guard's parameters, and a full-resolution read that is not the bucket's picture.
 * "far" is the largest difference from the unrefined matte more than 3 bucket px from the true edge.
 */
async function measureGuards(K) {
    const out = [];
    const near = [[60, 158, 82], [60, 164, 76], [50, 150, 80]];
    const kinds = ["skin", "blue", "teal", "fold", "shade", "stripes", "blur", "hair"];
    const run = async (sc, opts) => {
        const res = await K.refineMatte({ alpha: sc.alpha, aw: sc.aw, ah: sc.ah, small: sc.small, full: { w: sc.W, h: sc.H }, screen: sc.screen, read: (b) => sc.rgba.subarray(b[1] * sc.W * 4, b[3] * sc.W * 4), ...opts });
        return res;
    };
    const cell = (sc, est, bil) => { const r = score(sc, est, bil); return `${r.mae.toFixed(1)}/${r.leak != null ? r.leak.toFixed(0) : "-"}/${sc.edge ? far(sc, est, bil) : "-"}`; };
    out.push("\n== the guards: sensor noise (+-levels on the bytes) and subjects near the screen [60,170,70]; MAE/leak/far ==");
    out.push("(far: the largest |refined - unrefined| more than 3 bucket px from the true edge; the unguarded row is the first round's default)");
    for (const s of [4, 15]) for (const pn of [0, 3, 6]) {
        const scs = [...near.map((c) => ({ n: `near ${JSON.stringify(c)}`, sc: nearScene(c, s, pn) })), ...["skin", "teal", "fold", "hair"].map((k) => ({ n: k, sc: scene(k, s, 40, { pnoise: pn }) }))];
        const lines = { bilinear: [], unguarded: [], defaults: [] };
        let noise = null;
        for (const { n, sc } of scs) {
            const bil = (await run(sc, { method: "bilinear" })).alpha;
            lines.bilinear.push(`${n} ${cell(sc, bil, bil)}`);
            lines.unguarded.push(`${n} ${cell(sc, (await run(sc, { gate: false, tau: 0 })).alpha, bil)}`);
            const d = await run(sc, {});
            noise = d.noise;
            lines.defaults.push(`${n} ${cell(sc, d.alpha, bil)}`);
        }
        out.push(`s ${s} noise +-${pn} (estimated ${JSON.stringify(noise)} levels):`);
        for (const [k, v] of Object.entries(lines)) out.push(`  ${k.padEnd(10)} ` + v.join("  "));
    }
    out.push("\n== the guards' parameters: mean MAE / worst leak / worst far per set (clean: the 8 scenes; noisy: skin teal fold hair at +-3 and +-6; near: the 3 subjects at +-3 and +-6) ==");
    const sets = [];
    for (const s of [4, 15]) {
        sets.push({ n: `clean s${s}`, scs: kinds.map((k) => scene(k, s)) });
        sets.push({ n: `noisy s${s}`, scs: [3, 6].flatMap((pn) => ["skin", "teal", "fold", "hair"].map((k) => scene(k, s, 40, { pnoise: pn }))) });
        sets.push({ n: `near s${s}`, scs: [3, 6].flatMap((pn) => near.map((c) => nearScene(c, s, pn))) });
    }
    for (const set of sets) { set.bil = []; for (const sc of set.scs) set.bil.push((await run(sc, { method: "bilinear" })).alpha); }
    const variants = [{ gate: false, tau: 0 }];
    for (const gate of [0, 1, 2]) for (const tau of [0.02, 0.03, 0.04, 0.06]) variants.push({ gate, tau });
    for (const v of variants) {
        const parts = [];
        for (const set of sets) {
            let mae = 0, leak = 0, fr = 0;
            for (let i = 0; i < set.scs.length; i++) {
                const sc = set.scs[i], est = (await run(sc, v)).alpha, r = score(sc, est, set.bil[i]);
                mae += r.mae / set.scs.length;
                if (r.leak != null) leak = Math.max(leak, r.leak);
                if (sc.edge) fr = Math.max(fr, far(sc, est, set.bil[i]));
            }
            parts.push(`${set.n} ${mae.toFixed(2)}/${leak.toFixed(0)}/${fr}`);
        }
        const tag = v.gate === K.REFINE.gate && v.tau === K.REFINE.tau ? " (default)" : "";
        out.push(`${JSON.stringify(v)}${tag}`.padEnd(34) + parts.join("  "));
    }
    out.push("\n== a full-resolution read that is not the bucket's picture (a filter composited into it only) ==");
    for (const s of [4, 15]) for (const kind of ["skin", "hair", "stripes"]) {
        const sc = scene(kind, s), bil = (await run(sc, { method: "bilinear" })).alpha;
        const parts = [`${kind} s ${s}: bilinear ${score(sc, bil, bil).mae.toFixed(1)}`];
        const same = await run(sc, {});
        parts.push(`same picture: guideDiff ${same.guideDiff}, MAE ${score(sc, same.alpha, bil).mae.toFixed(1)}`);
        for (const name of Object.keys(FILTERS)) {
            const rgba = filtered(sc.rgba, name);
            const unguarded = await K.refineMatte({ alpha: sc.alpha, aw: sc.aw, ah: sc.ah, small: sc.small, full: { w: sc.W, h: sc.H }, read: (b) => rgba.subarray(b[1] * sc.W * 4, b[3] * sc.W * 4), gate: false, tau: 0, guideTol: 1e9 });
            const res = await K.refineMatte({ alpha: sc.alpha, aw: sc.aw, ah: sc.ah, small: sc.small, full: { w: sc.W, h: sc.H }, read: (b) => rgba.subarray(b[1] * sc.W * 4, b[3] * sc.W * 4) });
            parts.push(`${name}: guideDiff ${res.guideDiff}, ${res.fallback ? "fallback" : "refined"} MAE ${score(sc, res.alpha, bil).mae.toFixed(1)} (unguarded ${score(sc, unguarded.alpha, bil).mae.toFixed(1)})`);
        }
        const R = rng(5), grain = Uint8ClampedArray.from(sc.rgba, (v, i) => (i & 3) === 3 ? v : v + Math.round((R() - 0.5) * 16));
        const g = await K.refineMatte({ alpha: sc.alpha, aw: sc.aw, ah: sc.ah, small: sc.small, full: { w: sc.W, h: sc.H }, read: (b) => grain.subarray(b[1] * sc.W * 4, b[3] * sc.W * 4) });
        parts.push(`grain +-8 (zero mean): guideDiff ${g.guideDiff}, noise ${JSON.stringify(g.noise)}, ${g.fallback ? "fallback" : "refined"} MAE ${score(sc, g.alpha, bil).mae.toFixed(1)}`);
        out.push(parts.join("; "));
    }
    return out;
}

// ---- --time --------------------------------------------------------------------------------------------------------

async function time() {
    const K = await imp("keymatte.js");
    const KJ = await imp("px/kernels_js.js");
    const { loadPx } = await imp("px/px.js");
    const px = await loadPx(fs.readFileSync(path.join(EDITOR, "px", "px.wasm")));
    const boxes = { js: (d, w, h, r) => KJ.boxBlurs(d, w, h, r), rust: (d, w, h, r) => px.boxBlurs(d, w, h, r) };
    const sizes = [[4096, 2731], [8192, 5461], [15000, 10000]];
    const aw = 1024, ah = 683;
    // a bucket matte and picture: a disc with a soft rim on green, so every band crosses an edge
    const small = { data: new Uint8ClampedArray(aw * ah * 4), width: aw, height: ah }, alpha = new Float32Array(aw * ah);
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
        const d = Math.hypot(x - aw / 2, y - ah / 2) - ah * 0.4, a = Math.max(0, Math.min(1, 0.5 - d / 3)), i = y * aw + x;
        alpha[i] = a;
        small.data[i * 4] = Math.round(60 + a * 137); small.data[i * 4 + 1] = Math.round(170 - a * 35); small.data[i * 4 + 2] = Math.round(70 + a * 38); small.data[i * 4 + 3] = 255;
    }
    const lines = [`node ${process.version}, ${require("node:os").cpus()[0].model}; bucket ${aw} x ${ah}; ms of the module alone (the read is a view, ${"<"} 1 ms)`];
    lines.push("the picture rows carry +-3 levels of noise, so the fast method's smoothing runs as on a photo (\"clean\": none, the first round's case);");
    lines.push("the rows are not the bucket's picture (one band's rows handed out for every band), so the check is off (guideTol 1e9)");
    const configs = [
        { label: "bilinear", o: { method: "bilinear" }, box: ["js"] },
        { label: "fast rgb (default)", o: {}, box: ["js", "rust"] },
        { label: "fast rgb, clean", o: {}, box: ["rust"], clean: true },
        { label: "fast chroma", o: { guide: "chroma" }, box: ["rust"] },
        { label: "full chroma K1.5", o: { method: "full", guide: "chroma" }, box: ["js", "rust"] },
    ];
    for (const [W, H] of sizes) {
        // one band's worth of picture rows, handed out again for every band (the read itself is the caller's cost)
        const maxRows = W * H <= K.REFINE.unbandedPx ? H : Math.min(H, Math.ceil(K.REFINE.bandPx / W) + 200);
        const rows = new Uint8ClampedArray(W * maxRows * 4), clean = new Uint8ClampedArray(W * maxRows * 4), R = rng(11);
        for (let y = 0; y < maxRows; y++) for (let x = 0; x < W; x++) {
            const a = Math.max(0, Math.min(1, (x - W * 0.4) / 3 + 0.5)), o = (y * W + x) * 4;
            clean[o] = 60 + a * 137; clean[o + 1] = 170 - a * 35; clean[o + 2] = 70 + a * 38; clean[o + 3] = 255;
            for (let c = 0; c < 3; c++) rows[o + c] = clean[o + c] + Math.round((R() - 0.5) * 6);
            rows[o + 3] = 255;
        }
        for (const c of configs) for (const b of c.box) {
            if (c.o.method === "full" && b === "js" && W > 8192) continue;   // tens of seconds; the Rust row says enough
            let sink = 0;
            const src = c.clean ? clean : rows;
            const res = await K.refineMatte({
                alpha, aw, ah, small, full: { w: W, h: H }, screen: GREEN, box: boxes[b], guideTol: 1e9, ...c.o,
                read: (bx) => src.subarray(0, (bx[3] - bx[1]) * W * 4),
                onBand: (y0, y1, bytes) => { sink += bytes[(bytes.length >> 1)]; },
            });
            const mp = (W * H / 1e6).toFixed(1);
            lines.push(`${W} x ${H} (${mp} MP) ${c.label.padEnd(20)} box ${b.padEnd(4)}: ${String(res.ms.all - res.ms.read).padStart(6)} ms in all, fit ${res.ms.fit} ms, ${res.bands} bands (${((res.ms.all - res.ms.fit) / res.bands).toFixed(0)} ms each after the fit), r ${res.r}, halo ${res.halo}, noise ${res.noise ? res.noise[1] : "-"}, ${((res.ms.all - res.ms.read) / (W * H) * 1e6).toFixed(1)} ns/px`);
            if (sink < 0) console.log(sink);
        }
    }
    console.log(lines.join("\n"));
}

// ---- the tests -----------------------------------------------------------------------------------------------------

let failed = 0;
function check(name, ok, detail = "") { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ": " + detail : ""}`); if (!ok) failed++; }
function maxDiff(a, b) { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; }

async function tests() {
    const K = await imp("keymatte.js");
    const D = await imp("inpaint_depth.js");
    const KJ = await imp("px/kernels_js.js");

    // 1. a soft matte against a sharp edge of equal luminance (green against a skin tone) snaps to within 1 px
    for (const kind of ["skin", "blue"]) for (const s of [4, 15]) {
        const sc = scene(kind, s);
        const bil = await refineScene(K, sc, { method: "bilinear" });
        const est = await refineScene(K, sc, {});
        const r = score(sc, est, bil), rb = score(sc, bil, bil);
        check(`${kind} edge of equal luminance at s ${s}: the transition stays within 1 px of the true edge`, r.leak <= 8 && r.cross <= 1, `leak ${r.leak.toFixed(1)} levels beyond 1.5 px, crossing off by ${r.cross.toFixed(2)} px (unrefined: leak ${rb.leak.toFixed(0)}, crossing ${rb.cross.toFixed(2)})`);
        check(`${kind} at s ${s}: the unrefined matte did not (the test can fail)`, rb.leak > 60, `unrefined leak ${rb.leak.toFixed(0)}`);
        // the scene's colours share their relative luminance in linear light, so the foil decodes the bytes
        const lu = score(sc, await refineScene(K, sc, { guide: "luma", linear: true }), bil);
        check(`${kind} at s ${s}: a luminance guide finds no edge there (the foil)`, lu.leak > 60, `luma leak ${lu.leak.toFixed(0)}`);
    }

    // 2. a flat picture leaves the matte as it is (the bilinear bytes), every method and guide
    {
        const s = 8, cells = 24, W = cells * s;
        const rgba = new Uint8ClampedArray(W * W * 4).fill(0);
        for (let i = 0; i < W * W; i++) { rgba[i * 4] = GREEN[0]; rgba[i * 4 + 1] = GREEN[1]; rgba[i * 4 + 2] = GREEN[2]; rgba[i * 4 + 3] = 255; }
        const small = { data: new Uint8ClampedArray(cells * cells * 4), width: cells, height: cells };
        for (let i = 0; i < cells * cells; i++) small.data.set([GREEN[0], GREEN[1], GREEN[2], 255], i * 4);
        const alpha = new Float32Array(cells * cells);
        for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) alpha[y * cells + x] = Math.max(0, Math.min(1, 1.5 - Math.hypot(x - 11.5, y - 11.5) / 5));
        const base = { alpha, aw: cells, ah: cells, small, full: { w: W, h: W }, screen: GREEN, read: (b) => rgba.subarray(b[1] * W * 4, b[3] * W * 4) };
        const bil = (await K.refineMatte({ ...base, method: "bilinear" })).alpha;
        for (const o of [{}, { guide: "chroma" }, { guide: "dist" }, { guide: "luma" }, { method: "full", guide: "chroma" }, { method: "full", guide: "luma" }]) {
            const est = (await K.refineMatte({ ...base, ...o })).alpha;
            check(`a flat picture leaves the matte alone (${o.method || "fast"} ${o.guide || "rgb"})`, maxDiff(est, bil) === 0, `max ${maxDiff(est, bil)} levels from the bilinear matte`);
        }
    }

    // 3. no band seam: a vertical edge crossing band boundaries stays straight within 1 level, banded = unbanded
    {
        const s = 8, cells = 32, W = cells * s, H = W;
        const skin = sameLum([220, 150, 120], GREEN), Bl = lin3(GREEN);
        const truth = new Float32Array(W * H), rgba = new Uint8ClampedArray(W * H * 4);
        const ex = 101.3;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const a = Math.max(0, Math.min(1, x + 1 - ex)), o = (y * W + x) * 4;
            truth[y * W + x] = a;
            for (let c = 0; c < 3; c++) rgba[o + c] = ENC(a * skin[c] + (1 - a) * Bl[c]);
            rgba[o + 3] = 255;
        }
        const { small, alpha } = bucketOf(truth, rgba, W, H, s);
        const base = { alpha, aw: cells, ah: cells, small, full: { w: W, h: H }, screen: GREEN };
        for (const o of [{}, { guide: "chroma" }, { method: "full", guide: "chroma" }, { method: "bilinear" }]) {
            const label = `${o.method || "fast"} ${o.guide || (o.method === "bilinear" ? "" : "rgb")}`;
            const asked = [];
            const read = (b) => { asked.push(b); return rgba.subarray(b[1] * W * 4, b[3] * W * 4); };
            const one = await K.refineMatte({ ...base, ...o, read });
            const banded = await K.refineMatte({ ...base, ...o, read, bandRows: 37, unbandedPx: 0 });
            check(`${label}: banded (37 rows, ${banded.bands} bands, halo ${banded.halo}) equals unbanded within 1 level`, maxDiff(one.alpha, banded.alpha) <= 1, `max ${maxDiff(one.alpha, banded.alpha)}`);
            let straight = 0;
            for (let x = 0; x < W; x++) { let lo = 255, hi = 0; for (let y = 0; y < H; y++) { const v = banded.alpha[y * W + x]; lo = Math.min(lo, v); hi = Math.max(hi, v); } straight = Math.max(straight, hi - lo); }
            check(`${label}: the vertical edge stays straight across the band boundaries`, straight <= 1, `largest spread down a column ${straight} levels`);
        }
    }

    // 4. the halo: read exactly (2r above and below, clamped), trimmed exactly; without it the seams show
    {
        const sc = scene("skin", 8, 32);
        const { W, H } = sc;
        const asked = [];
        const read = (b) => { asked.push(b); return sc.rgba.subarray(b[1] * W * 4, b[3] * W * 4); };
        const o = { alpha: sc.alpha, aw: sc.aw, ah: sc.ah, small: sc.small, full: { w: W, h: H }, screen: sc.screen, method: "full", guide: "chroma" };
        const one = await K.refineMatte({ ...o, read });
        asked.length = 0;
        const got = []; let rows = 0;
        const stream = new Uint8Array(W * H);
        const banded = await K.refineMatte({ ...o, read, bandRows: 50, unbandedPx: 0, onBand: (y0, y1, bytes) => { got.push([y0, y1, bytes.length]); rows += y1 - y0; stream.set(bytes, y0 * W); } });
        const r = banded.r, plan = K.bandPlan(W, H, { halo: 2 * r, bandRows: 50, unbandedPx: 0 });
        const want = plan.map((b) => [0, Math.max(0, b.y0 - 2 * r), W, Math.min(H, b.y1 + 2 * r)]);
        check(`the full method's halo is 2r (r ${r} at s 8, K ${K.REFINE.fullK})`, banded.halo === 2 * r && r === Math.round(K.REFINE.fullK * 8), `halo ${banded.halo}`);
        check("each band reads its rows with the halo above and below, clamped to the box", JSON.stringify(asked) === JSON.stringify(want), JSON.stringify(asked.slice(0, 3)));
        check("each band answers exactly its own rows (the halo trimmed)", rows === H && got.every(([y0, y1, n], i) => y0 === plan[i].y0 && y1 === plan[i].y1 && n === (y1 - y0) * W), JSON.stringify(got.slice(0, 3)));
        check("the full method's bands, streamed, are the unbanded matte's bytes (a halo off by a row shows here)", maxDiff(stream, one.alpha) <= 1, `max ${maxDiff(stream, one.alpha)} levels`);
        // the same bands answered without a halo: the box blurs read across the cut and the rows near it differ
        const st = K.prepareRefine(o);
        const cut = new Uint8Array(W * H);
        for (const b of K.bandPlan(W, H, { halo: 0, bandRows: 50, unbandedPx: 0 })) cut.set(K.refineBand(st, b, sc.rgba.subarray(b.ry0 * W * 4, b.ry1 * W * 4)), b.y0 * W);
        check("without the halo the band seams differ from the unbanded matte (the halo is what removes them)", maxDiff(cut, one.alpha) > 1, `max ${maxDiff(cut, one.alpha)} levels`);
        // the fast method's halo is the noise smoothing's reach: half the factor, at most rhoMax
        const f8 = K.refineParams(8), f15 = K.refineParams(15), f40 = K.refineParams(40), f1 = K.refineParams(1.5);
        check("the fast method's halo is min(rhoMax, floor(factor / 2))", f8.halo === 4 && f15.halo === 7 && f40.halo === K.REFINE.rhoMax && f1.halo === 0, `${f8.halo} / ${f15.halo} / ${f40.halo} / ${f1.halo}`);
    }

    // 4b. the same for the fast method on a noisy picture (the smoothing reads across band boundaries)
    {
        const sc = nearScene([60, 158, 82], 8, 6, 32), { W, H } = sc;
        const asked = [];
        const read = (b) => { asked.push(b); return sc.rgba.subarray(b[1] * W * 4, b[3] * W * 4); };
        const o = { alpha: sc.alpha, aw: sc.aw, ah: sc.ah, small: sc.small, full: { w: W, h: H } };
        const one = await K.refineMatte({ ...o, read });
        asked.length = 0;
        const stream = new Uint8Array(W * H);
        const banded = await K.refineMatte({ ...o, read, bandRows: 37, unbandedPx: 0, onBand: (y0, y1, bytes) => { stream.set(bytes, y0 * W); } });
        const halo = banded.halo, plan = K.bandPlan(W, H, { halo, bandRows: 37, unbandedPx: 0 });
        const st = K.prepareRefine(o), [sy0, sy1] = st.sample;
        const want = [[0, sy0, W, sy1], ...plan.map((b) => [0, Math.max(0, b.y0 - halo), W, Math.min(H, b.y1 + halo)])];
        check(`the fast method reads the noise sample, then each band with a halo of ${halo} rows`, halo === 4 && JSON.stringify(asked) === JSON.stringify(want), JSON.stringify(asked.slice(0, 3)));
        check(`the fast method's bands, streamed, are the unbanded matte's bytes exactly (smoothing on: noise ${banded.noise[1]} levels)`, maxDiff(stream, one.alpha) === 0 && banded.noise[1] > 3, `max ${maxDiff(stream, one.alpha)} levels`);
        K.noteSample(st, sc.rgba.subarray(sy0 * W * 4, sy1 * W * 4));
        const cut = new Uint8Array(W * H);
        for (const b of K.bandPlan(W, H, { halo: 0, bandRows: 37, unbandedPx: 0 })) cut.set(K.refineBand(st, b, sc.rgba.subarray(b.ry0 * W * 4, b.ry1 * W * 4)), b.y0 * W);
        check("without the halo the fast method's band seams differ (the halo is what removes them)", maxDiff(cut, one.alpha) > 1, `max ${maxDiff(cut, one.alpha)} levels`);
        let threw = false; try { K.refineBand(K.prepareRefine(o), plan[0], sc.rgba); } catch { threw = true; }
        check("refused: a fast band before the noise sample", threw);
        // the smoothing's box is centred: the picture flipped (rows, then columns) gives the matte flipped, within a level
        const flip = (a, n, wd, ht, rows) => {
            const o2 = new a.constructor(a.length);
            for (let y = 0; y < ht; y++) for (let x = 0; x < wd; x++) {
                const yy = rows ? ht - 1 - y : y, xx = rows ? x : wd - 1 - x;
                for (let c = 0; c < n; c++) o2[(yy * wd + xx) * n + c] = a[(y * wd + x) * n + c];
            }
            return o2;
        };
        for (const rows of [true, false]) {
            const fr = flip(sc.rgba, 4, W, H, rows);
            const fo = { alpha: flip(sc.alpha, 1, sc.aw, sc.ah, rows), aw: sc.aw, ah: sc.ah, small: { data: flip(sc.small.data, 4, sc.aw, sc.ah, rows), width: sc.aw, height: sc.ah }, full: { w: W, h: H }, noise: banded.noise };
            const a = await K.refineMatte({ ...o, noise: banded.noise, read }), b = await K.refineMatte({ ...fo, read: (bx) => fr.subarray(bx[1] * W * 4, bx[3] * W * 4) });
            const d = maxDiff(flip(b.alpha, 1, W, H, rows), a.alpha);
            check(`the picture flipped ${rows ? "upside down" : "left to right"} gives the matte flipped (the smoothing's box is centred)`, d <= 1, `max ${d} levels`);
        }
        // the box sums skip the pixels farther than two bucket px from the zone: the answer is the one without the skip
        for (const s2 of [2, 8, 15]) {
            const z = nearScene([60, 158, 82], s2, 6, 24), rz = (bx) => z.rgba.subarray(bx[1] * z.W * 4, bx[3] * z.W * 4);
            const oz = { alpha: z.alpha, aw: z.aw, ah: z.ah, small: z.small, full: { w: z.W, h: z.H }, read: rz };
            const d = maxDiff((await K.refineMatte(oz)).alpha, (await K.refineMatte({ ...oz, reach: 99 })).alpha);
            check(`s ${s2}: skipping the pixels no box reaches changes nothing`, d === 0, `max ${d} levels`);
        }
        asked.length = 0;
        await K.refineMatte({ ...o, read, noise: 0 });
        check("a given noise skips the sample read", asked.length === 1 && asked[0][1] === 0 && asked[0][3] === H, JSON.stringify(asked));
    }

    // 5. the geometry: the default map is inpaint_depth's bilinearResize; a source region and a matte box crop it
    {
        const aw = 37, ah = 23, R = rng(3), a = new Float32Array(aw * ah).map(() => R());
        const geo = K.geometry({ aw, ah, full: { w: 301, h: 177 } });
        const mine = K.upsampleRows(a, geo, 0, 177), ref = D.bilinearResize(a, aw, ah, 301, 177);
        // inside the outer half bucket pixel; there bilinearResize lerps toward the second pixel, this clamps to the first
        let inner = 0, border = 0;
        for (let y = 0; y < 177; y++) for (let x = 0; x < 301; x++) {
            const d = Math.abs(mine[y * 301 + x] - ref[y * 301 + x]), u = (x + 0.5) * aw / 301 - 0.5, v = (y + 0.5) * ah / 177 - 0.5;
            if (u >= 0 && v >= 0 && u <= aw - 1 && v <= ah - 1) inner = Math.max(inner, d); else border = Math.max(border, Math.abs(mine[y * 301 + x] - a[Math.min(ah - 1, Math.max(0, Math.round(v))) * aw + Math.min(aw - 1, Math.max(0, Math.round(u)))]) > 0.5 ? 1 : border);
        }
        check("the bilinear upsample equals inpaint_depth.js bilinearResize inside the outer half bucket pixel", inner < 1e-5, `max ${inner}`);
        const sub = K.geometry({ aw, ah, full: { w: 301, h: 177 }, out: { x: 40, y: 30, w: 100, h: 60 } });
        const part = K.upsampleRows(a, sub, 0, 60);
        let m = 0; for (let y = 0; y < 60; y++) for (let x = 0; x < 100; x++) m = Math.max(m, Math.abs(part[y * 100 + x] - ref[(y + 30) * 301 + x + 40]));
        check("a matte box inside the key box is the same pixels of the whole upsample", m < 1e-6, `max ${m}`);
        // padding at the bucket's right and bottom (the picture's edge left the bucket short): src maps the content
        const pad = K.geometry({ aw, ah, src: { x: 0, y: 0, w: 30, h: 20 }, full: { w: 300, h: 200 } });
        const g2 = K.geometry({ aw: 30, ah: 20, full: { w: 300, h: 200 } });
        const crop = new Float32Array(30 * 20); for (let y = 0; y < 20; y++) for (let x = 0; x < 30; x++) crop[y * 30 + x] = a[y * aw + x];
        const pa = K.upsampleRows(a, pad, 0, 200), pb = K.upsampleRows(crop, g2, 0, 200);
        let mm = 0; for (let y = 0; y < 195; y++) for (let x = 0; x < 295; x++) mm = Math.max(mm, Math.abs(pa[y * 300 + x] - pb[y * 300 + x]));
        check("a source region (the padding left out) maps its content onto the key box", mm < 1e-5 && pad.scale === 10, `max ${mm}, scale ${pad.scale}`);
        const u8 = Uint8Array.from(a, (v) => Math.round(v * 255)), u16 = Uint16Array.from(u8, (v) => v * 257), f = Float32Array.from(u8, (v) => v / 255);
        const outs = [u8, u16, f].map((x) => K.upsampleRows(K.toFloatAlpha(x), geo, 0, 177));
        check("the engine's alpha as u8, u16 or float gives the same matte", maxDiff(outs[0], outs[1]) < 1e-6 && maxDiff(outs[0], outs[2]) < 1e-6);
        const t = K.toFloatAlpha(Float32Array.from([-0.5, 0.25, 1.5, NaN]));
        check("float alpha is clamped to [0, 1], NaN to 0", t.join() === "0,0.25,1,0", t.join());
    }

    // 6. the parameters, the plan, the refusals
    {
        const p4 = K.refineParams(4, { method: "full" }), p15 = K.refineParams(14.6, { method: "full" });
        check("the full method's radius follows the upscale factor (about 22 px at 15k / 1024)", p4.r === 6 && p15.r === 22 && p15.halo === 44, `${p4.r} / ${p15.r}`);
        check("the fast method's radius is in bucket pixels and the same at every factor", K.refineParams(4).r === K.REFINE.r && K.refineParams(15).r === K.REFINE.r);
        const one = K.bandPlan(4000, 4000), many = K.bandPlan(15000, 10000, { halo: 44 });
        check("a box up to 16 MP is one band", one.length === 1 && one[0].y1 === 4000);
        check("a 15k box is cut into bands of about 4 MP covering every row once", many.length > 30 && many[0].y0 === 0 && many[many.length - 1].y1 === 10000 && many.every((b, i) => i === 0 || b.y0 === many[i - 1].y1) && many[1].ry0 === many[1].y0 - 44, `${many.length} bands of ${many[0].y1} rows`);
        const sc = scene("skin", 4, 16), o = { alpha: sc.alpha, aw: 16, ah: 16, small: sc.small, full: { w: 64, h: 64 } };
        const throws = (f) => { try { f(); return false; } catch { return true; } };
        check("refused: the matte's box outside the key box", throws(() => K.prepareRefine({ ...o, out: { x: 10, y: 0, w: 60, h: 64 } })));
        check("refused: the bucket picture at another size", throws(() => K.prepareRefine({ ...o, small: { data: new Uint8Array(4 * 15 * 16), width: 15, height: 16 } })));
        check("refused: the alpha at another size", throws(() => K.prepareRefine({ ...o, alpha: new Float32Array(10) })));
        check("refused: the three-channel guide with the full method", throws(() => K.prepareRefine({ ...o, method: "full", guide: "rgb" })));
        check("refused: a chroma guide with no screen colour and no picture to find it in", throws(() => K.prepareRefine({ ...o, small: null, method: "full", guide: "chroma" })));
        let threw = false; try { await K.refineMatte({ ...o }); } catch { threw = true; }
        check("refused: no read callback", threw);
        const c = await K.refineMatte({ ...o, read: () => sc.rgba, cancelled: () => true });
        check("a cancel before a band answers cancelled and nothing else", c.cancelled === true && !c.alpha);
    }

    // 7. the screen colour from the bucket, and the stream equals the collected matte
    {
        const sc = scene("skin", 4, 40);
        const sc2 = K.screenColor(sc.small, sc.alpha);
        check("the screen colour is read from the bucket's screen pixels", sc2 && maxDiff(sc2, GREEN) <= 1, JSON.stringify(sc2));
        check("no screen colour when the matte has no screen", K.screenColor(sc.small, new Float32Array(sc.alpha.length).fill(1)) === null);
        const one = await refineScene(K, sc, {});
        const parts = new Uint8Array(sc.W * sc.H);
        await K.refineMatte({ alpha: sc.alpha, aw: sc.aw, ah: sc.ah, small: sc.small, full: { w: sc.W, h: sc.H }, read: (b) => sc.rgba.subarray(b[1] * sc.W * 4, b[3] * sc.W * 4), bandRows: 13, unbandedPx: 0, onBand: (y0, y1, bytes) => { parts.set(bytes, y0 * sc.W); } });
        check("the matte streamed band by band equals the collected one", maxDiff(parts, one) === 0);
        const nz = scene("teal", 4, 40, { pnoise: 6 });
        const oneN = await refineScene(K, nz, {}), partsN = new Uint8Array(nz.W * nz.H);
        await K.refineMatte({ alpha: nz.alpha, aw: nz.aw, ah: nz.ah, small: nz.small, full: { w: nz.W, h: nz.H }, read: (b) => nz.rgba.subarray(b[1] * nz.W * 4, b[3] * nz.W * 4), bandRows: 13, unbandedPx: 0, onBand: (y0, y1, bytes) => { partsN.set(bytes, y0 * nz.W); } });
        check("on a noisy picture too (the smoothing's box sums are exact)", maxDiff(partsN, oneN) === 0, `max ${maxDiff(partsN, oneN)}`);
    }

    // 8. the box blur is px/kernels.js' (the JS twin here) and an injected one is used
    {
        const sc = scene("hair", 4, 24);
        let calls = 0;
        const box = (d, w, h, r) => { calls++; return KJ.boxBlurs(d, w, h, r); };
        const a = await refineScene(K, sc, {}), b = await refineScene(K, sc, { box });
        // the colour fit's 17 means once per softness "auto" tries, and the matte's mean once for all of them (P13)
        const want = 1 + 17 * K.REFINE.softs.length;
        check("an injected box blur is the one the fit uses, with the same bytes", calls === want && maxDiff(a, b) === 0, `${calls} calls of ${want}`);
        const bil = await refineScene(K, sc, { method: "bilinear" });
        const r = score(sc, a, bil), rb = score(sc, bil, bil);
        check("hair strands over the screen come back closer to the truth than the bilinear matte", r.mae < rb.mae * 0.5, `MAE ${r.mae.toFixed(1)} against ${rb.mae.toFixed(1)} levels`);
    }

    // 9. sensor noise: where the engine was sure (more than 3 bucket px from the edge) the refine adds at most 3 levels,
    // also for a subject 12-24 levels from the screen's colour; it stays better than the unrefined matte overall
    for (const s of [4, 15]) {
        const cases = [];
        // the bound on the mean error: below the unrefined matte's where the noise is a third of the colours' distance or
        // more (an SNR-limited edge: the refine smooths toward the bilinear matte), a quarter of it where it is not
        for (const pn of [3, 6]) for (const c of [[60, 158, 82], [60, 164, 76]]) cases.push([`a subject ${JSON.stringify(c)} near the screen, +-${pn} levels`, nearScene(c, s, pn), 1]);
        for (const k of ["skin", "teal", "fold"]) cases.push([`${k}, +-6 levels`, scene(k, s, 40, { pnoise: 6 }), 0.25]);
        for (const [label, sc, k] of cases) {
            const bil = await refineScene(K, sc, { method: "bilinear" });
            const est = await refineScene(K, sc, {});
            const r = score(sc, est, bil), rb = score(sc, bil, bil), f = far(sc, est, bil);
            check(`${label} at s ${s}: nothing added where the engine was sure, better than unrefined`, f <= 3 && r.mae < rb.mae * k && r.leak <= rb.leak, `far ${f} levels, MAE ${r.mae.toFixed(1)} / ${rb.mae.toFixed(1)}, leak ${r.leak.toFixed(0)} / ${rb.leak.toFixed(0)}`);
        }
    }
    {
        // without the guards (the zone and the noise) the same scene shows the speckle (the test can fail)
        const sc = nearScene([60, 158, 82], 15, 3), bil = await refineScene(K, sc, { method: "bilinear" });
        const raw = far(sc, await refineScene(K, sc, { gate: false, tau: 0 }), bil);
        check("without the zone and the noise guard the near-screen subject speckles (the guards are what remove it)", raw > 20, `far ${raw} levels`);
    }

    // 10. the noise estimate from the sample
    {
        const read = (sc) => (b) => sc.rgba.subarray(b[1] * sc.W * 4, b[3] * sc.W * 4);
        const hc = scene("hair", 8, 32), sc = scene("skin", 8, 32, { pnoise: 3 });
        const clean = await K.refineMatte({ alpha: hc.alpha, aw: hc.aw, ah: hc.ah, small: hc.small, full: { w: hc.W, h: hc.H }, read: read(hc) });
        const noisy = await K.refineMatte({ alpha: sc.alpha, aw: sc.aw, ah: sc.ah, small: sc.small, full: { w: sc.W, h: sc.H }, read: read(sc) });
        // +-3 levels rounded from a uniform draw: sigma = sqrt(10 / 6 + 1.5) = 1.78 levels
        check("a clean picture (hair over the screen) estimates no noise", clean.noise.every((v) => v === 0), JSON.stringify(clean.noise));
        check("+-3 levels of sensor noise are estimated within 15 %", noisy.noise.every((v) => Math.abs(v - 1.78) < 0.27), JSON.stringify(noisy.noise));
    }

    // 11. the read must be the bucket's picture: a filtered read falls back to the bilinear matte, a faithful one does not
    for (const s of [4, 15]) {
        const sc = scene("skin", s), bil = await refineScene(K, sc, { method: "bilinear" });
        const base = { alpha: sc.alpha, aw: sc.aw, ah: sc.ah, small: sc.small, full: { w: sc.W, h: sc.H } };
        const ok = await K.refineMatte({ ...base, read: (b) => sc.rgba.subarray(b[1] * sc.W * 4, b[3] * sc.W * 4) });
        check(`s ${s}: the bucket's own picture passes the check`, !ok.fallback && ok.guideDiff <= 1, `guideDiff ${ok.guideDiff}`);
        for (const name of Object.keys(FILTERS)) {
            const rgba = filtered(sc.rgba, name);
            const res = await K.refineMatte({ ...base, read: (b) => rgba.subarray(b[1] * sc.W * 4, b[3] * sc.W * 4) });
            check(`s ${s}: a read with ${name} that the bucket lacks falls back to the bilinear matte`, !!res.fallback && maxDiff(res.alpha, bil) === 0, `guideDiff ${res.guideDiff}`);
        }
        // grain is zero-mean: not a different picture, more noise; the refine smooths and stays far better than none
        const R = rng(5), grain = Uint8ClampedArray.from(sc.rgba, (v, i) => (i & 3) === 3 ? v : v + Math.round((R() - 0.5) * 16));
        const gr = await K.refineMatte({ ...base, read: (b) => grain.subarray(b[1] * sc.W * 4, b[3] * sc.W * 4) });
        const r = score(sc, gr.alpha, bil), rb = score(sc, bil, bil);
        check(`s ${s}: grain (+-8, zero mean) is noise, not a mismatch`, !gr.fallback && r.mae < rb.mae * 0.3 && far(sc, gr.alpha, bil) <= 3, `guideDiff ${gr.guideDiff}, MAE ${r.mae.toFixed(1)} / ${rb.mae.toFixed(1)}, far ${far(sc, gr.alpha, bil)}`);
    }

    // 12. P13: the fit's floats are the code's before P13 (twinFit below: the matte's mean per softness, a new array per
    // product, every softness's blur from the planes): every coefficient float, the softness and the residual, on the
    // JS and the Rust box, rgb / chroma / luma guides, the default softnesses and orders that go back and repeat
    {
        const { loadPx } = await imp("px/px.js");
        const px = await loadPx(fs.readFileSync(path.join(EDITOR, "px", "px.wasm")));
        const boxes = { js: (d, w, h, r) => KJ.boxBlurs(d, w, h, r), rust: (d, w, h, r) => px.boxBlurs(d, w, h, r) };
        const cases = [
            ["hair", 4, 24, {}], ["skin", 15, 40, {}], ["teal", 4, 40, { pnoise: 6 }], ["stripes", 4, 32, {}],
            ["skin", 4, 40, { guide: "chroma" }], ["fold", 4, 32, { guide: "luma" }],
            ["hair", 4, 24, { softs: [3, 1, 4, 4, 0, 2] }], ["shade", 4, 32, { soft: 3 }], ["blue", 4, 32, { softs: [2, 1.5, 3] }],
            // a softness that is not a whole number of passes (1.5 runs 2) is never carried on from: here the best is 4
            ["fold", 4, 32, { guide: "luma", softs: [1.5, 4] }],
        ];
        let floats = 0, worst = "";
        for (const [kind, s, cells, extra] of cases) {
            const { pnoise, ...opt } = extra;
            const sc = scene(kind, s, cells, pnoise ? { pnoise } : {});
            for (const b of ["js", "rust"]) {
                const o = { alpha: sc.alpha, aw: sc.aw, ah: sc.ah, small: sc.small, full: { w: sc.W, h: sc.H }, screen: sc.screen, box: boxes[b], noise: 2, ...opt };
                const st = K.prepareRefine(o), tw = twinFit(K, o);
                let same = st.soft === tw.k && Object.is(st.residual, tw.res) && st.coef.length === tw.coef.length;
                for (let c = 0; same && c < tw.coef.length; c++) {
                    const A = st.coef[c], B = tw.coef[c];
                    if (A.length !== B.length) { same = false; break; }
                    for (let i = 0; i < A.length; i++) if (!Object.is(A[i], B[i])) { same = false; worst = `${kind} ${b} plane ${c} at ${i}: ${A[i]} vs ${B[i]}`; break; }
                    floats += A.length;
                }
                if (!same && !worst) worst = `${kind} ${b}: soft ${st.soft} vs ${tw.k}, residual ${st.residual} vs ${tw.res}`;
                check(`P13 ${kind} s ${s} ${JSON.stringify(opt)} box ${b}: the fit's floats are the old code's bit for bit`, same, same ? `soft ${st.soft}, residual ${st.residual.toExponential(3)}` : worst);
            }
        }
        console.log(`  (P13: ${floats} coefficient floats compared)`);
    }

    console.log(failed ? `\nkeymatte_test: ${failed} FAILED` : "\nkeymatte_test: all PASS");
    process.exit(failed ? 1 : 0);
}

// ---- P13's twin: keymatte.js's fit before P13, verbatim (fitGrey, fitColour, blur121, fitResidual, the loop) ---------

const TWIN_FLOOR = 0.05;
function twinMean(box, a, w, h, r) { return box(a, w, h, [r]); }
function twinFitGrey(I, p, w, h, r, eps, flat, box) {
    const n = w * h, Ip = new Float32Array(n), II = new Float32Array(n);
    for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
    const mI = twinMean(box, I, w, h, r), mP = twinMean(box, p, w, h, r), mIp = twinMean(box, Ip, w, h, r), mII = twinMean(box, II, w, h, r);
    const ca = new Float32Array(n), cb = new Float32Array(n), cc = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        let v = mII[i] - mI[i] * mI[i] - flat * TWIN_FLOOR;
        if (!(v > 0)) v = 0;
        const a = (mIp[i] - mI[i] * mP[i]) / (v + eps), c = v / (v + flat);
        ca[i] = c * a; cb[i] = c * (mP[i] - a * mI[i]); cc[i] = c;
    }
    return [twinMean(box, ca, w, h, r), twinMean(box, cb, w, h, r), twinMean(box, cc, w, h, r)];
}
function twinFitColour(I0, I1, I2, p, w, h, r, eps, flat, box) {
    const n = w * h, mean = twinMean;
    const prod = (x, y) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = x[i] * y[i]; return o; };
    const m0 = mean(box, I0, w, h, r), m1 = mean(box, I1, w, h, r), m2 = mean(box, I2, w, h, r), mP = mean(box, p, w, h, r);
    const m0p = mean(box, prod(I0, p), w, h, r), m1p = mean(box, prod(I1, p), w, h, r), m2p = mean(box, prod(I2, p), w, h, r);
    const v00 = mean(box, prod(I0, I0), w, h, r), v01 = mean(box, prod(I0, I1), w, h, r), v02 = mean(box, prod(I0, I2), w, h, r);
    const v11 = mean(box, prod(I1, I1), w, h, r), v12 = mean(box, prod(I1, I2), w, h, r), v22 = mean(box, prod(I2, I2), w, h, r);
    const ca0 = new Float32Array(n), ca1 = new Float32Array(n), ca2 = new Float32Array(n), cb = new Float32Array(n), cc = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const a0 = m0[i], a1 = m1[i], a2 = m2[i], mp = mP[i];
        const s00 = v00[i] - a0 * a0, s01 = v01[i] - a0 * a1, s02 = v02[i] - a0 * a2;
        const s11 = v11[i] - a1 * a1, s12 = v12[i] - a1 * a2, s22 = v22[i] - a2 * a2;
        const tr = s00 + s11 + s22 - flat * TWIN_FLOOR;
        if (!(tr > 0)) continue;
        const q0 = m0p[i] - a0 * mp, q1 = m1p[i] - a1 * mp, q2 = m2p[i] - a2 * mp;
        const e00 = s00 + eps, e11 = s11 + eps, e22 = s22 + eps;
        const c00 = e11 * e22 - s12 * s12, c01 = s02 * s12 - s01 * e22, c02 = s01 * s12 - e11 * s02;
        const c11 = e00 * e22 - s02 * s02, c12 = s01 * s02 - e00 * s12, c22 = e00 * e11 - s01 * s01;
        const det = e00 * c00 + s01 * c01 + s02 * c02;
        const k = det !== 0 ? 1 / det : 0;
        const x0 = (c00 * q0 + c01 * q1 + c02 * q2) * k, x1 = (c01 * q0 + c11 * q1 + c12 * q2) * k, x2 = (c02 * q0 + c12 * q1 + c22 * q2) * k;
        const c = tr / (tr + flat);
        ca0[i] = c * x0; ca1[i] = c * x1; ca2[i] = c * x2; cb[i] = c * (mp - x0 * a0 - x1 * a1 - x2 * a2); cc[i] = c;
    }
    return [mean(box, ca0, w, h, r), mean(box, ca1, w, h, r), mean(box, ca2, w, h, r), mean(box, cb, w, h, r), mean(box, cc, w, h, r)];
}
function twinBlur121(planes, w, h, k) {
    return planes.map((P) => {
        let a = Float32Array.from(P);
        const b = new Float32Array(w * h);
        for (let pass = 0; pass < k; pass++) {
            for (let y = 0; y < h; y++) {
                const o = y * w;
                for (let x = 0; x < w; x++) b[o + x] = (a[o + (x > 0 ? x - 1 : 0)] + 2 * a[o + x] + a[o + (x < w - 1 ? x + 1 : w - 1)]) * 0.25;
            }
            for (let y = 0; y < h; y++) {
                const o = y * w, u = (y > 0 ? y - 1 : 0) * w, d = (y < h - 1 ? y + 1 : h - 1) * w;
                for (let x = 0; x < w; x++) a[o + x] = (b[u + x] + 2 * b[o + x] + b[d + x]) * 0.25;
            }
        }
        return a;
    });
}
function twinFitResidual(coef, planes, p) {
    const three = planes.length === 3, n = p.length;
    let e = 0, m = 0;
    for (let i = 0; i < n; i++) {
        const v = p[i];
        if (!(v > 0.02 && v < 0.98)) continue;
        const q = three
            ? coef[0][i] * planes[0][i] + coef[1][i] * planes[1][i] + coef[2][i] * planes[2][i] + coef[3][i] + (1 - coef[4][i]) * v
            : coef[0][i] * planes[0][i] + coef[1][i] + (1 - coef[2][i]) * v;
        const d = (q < 0 ? 0 : q > 1 ? 1 : q) - v;
        e += d * d; m++;
    }
    return m ? e / m : 0;
}
/** prepareRefine's "fast" fit as it was before P13, from the module's exported pieces: the best { k, coef, res }. */
function twinFit(K, o) {
    const geo = K.geometry(o), p = K.toFloatAlpha(o.alpha), prm = K.refineParams(geo.scale, o);
    const guide = o.guide || K.REFINE.guide, linear = o.linear != null ? o.linear : K.REFINE.linear;
    let screen = o.screen || null;
    if (!screen && (guide === "chroma" || guide === "dist") && o.small) screen = K.screenColor(o.small, p);
    const g = K.guideSetup(guide, screen, linear), n = geo.aw * geo.ah, { aw, ah } = geo;
    const planes = Array.from({ length: g.planes }, () => new Float32Array(n));
    K.guidePlanes(g, o.small.data, 0, n, planes, 0);
    const fit = (P) => P.length === 3
        ? twinFitColour(P[0], P[1], P[2], p, aw, ah, prm.r, prm.eps, prm.flat, o.box)
        : twinFitGrey(P[0], p, aw, ah, prm.r, prm.eps, prm.flat, o.box);
    const soft = o.soft != null ? o.soft : K.REFINE.soft;
    const softs = soft === "auto" ? (o.softs || K.REFINE.softs) : [Math.max(0, soft | 0)];
    let best = null;
    for (const k of softs) {
        const P = k ? twinBlur121(planes, aw, ah, k) : planes, coef = fit(P);
        const res = softs.length > 1 ? twinFitResidual(coef, P, p) : 0;
        if (!best || res < best.res) best = { k, coef, res };
    }
    return best;
}

/** A subject close to the screen's colour (an olive garment, green spill), +-pnoise levels of sensor noise. */
const nearScene = (subject, s, pnoise = 0, cells = 40) => scene("near", s, cells, { pnoise, subject });

if (require.main !== module) module.exports = { scene, nearScene, bucketOf, score, far, refineScene, filtered, FILTERS, GREEN, BLUE };
const mode = require.main === module ? process.argv[2] : "lib";
if (mode !== "lib") (mode === "--measure" ? measure() : mode === "--time" ? time() : tests()).catch((err) => { console.error(err); process.exit(1); });
