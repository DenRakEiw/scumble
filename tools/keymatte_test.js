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
function scene(kind, s, cells = 40, { noise = 0, seed = 7, soft: blurred = true, avg = "bytes", pnoise = 0 } = {}) {
    const W = cells * s, H = cells * s;
    const screen = kind === "blue" ? BLUE : GREEN, Bl = lin3(screen);
    const skin = sameLum([220, 150, 120], screen);
    const e0 = 0.45 * W, edge = (y) => e0 + (y - H / 2) * TAN;
    let inside = null, soft = null, F = () => skin, B = () => Bl, sharp = true;
    if (kind === "skin" || kind === "blue") inside = (x, y) => x >= edge(y);
    else if (kind === "teal") { const t = lin3([0, 140, 140]); inside = (x, y) => x >= edge(y); F = () => t; }
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
    console.log(out.join("\n"));
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
    const configs = [
        { label: "bilinear", o: { method: "bilinear" }, box: ["js"] },
        { label: "fast rgb (default)", o: {}, box: ["js", "rust"] },
        { label: "fast chroma", o: { guide: "chroma" }, box: ["js", "rust"] },
        { label: "full chroma K1.5", o: { method: "full", guide: "chroma" }, box: ["js", "rust"] },
    ];
    for (const [W, H] of sizes) {
        // one band's worth of picture rows, handed out again for every band (the read itself is the caller's cost)
        const maxRows = W * H <= K.REFINE.unbandedPx ? H : Math.min(H, Math.ceil(K.REFINE.bandPx / W) + 200);
        const rows = new Uint8ClampedArray(W * maxRows * 4);
        for (let y = 0; y < maxRows; y++) for (let x = 0; x < W; x++) {
            const a = Math.max(0, Math.min(1, (x - W * 0.4) / 3 + 0.5)), o = (y * W + x) * 4;
            rows[o] = 60 + a * 137; rows[o + 1] = 170 - a * 35; rows[o + 2] = 70 + a * 38; rows[o + 3] = 255;
        }
        for (const c of configs) for (const b of c.box) {
            if (c.o.method === "full" && b === "js" && W > 8192) continue;   // tens of seconds; the Rust row says enough
            let sink = 0;
            const res = await K.refineMatte({
                alpha, aw, ah, small, full: { w: W, h: H }, screen: GREEN, box: boxes[b], ...c.o,
                read: (bx) => rows.subarray(0, (bx[3] - bx[1]) * W * 4),
                onBand: (y0, y1, bytes) => { sink += bytes[(bytes.length >> 1)]; },
            });
            const mp = (W * H / 1e6).toFixed(1);
            lines.push(`${W} x ${H} (${mp} MP) ${c.label.padEnd(20)} box ${b.padEnd(4)}: ${String(res.ms.all - res.ms.read).padStart(6)} ms in all, fit ${res.ms.fit} ms, ${res.bands} bands (${(res.ms.all / res.bands).toFixed(0)} ms each), r ${res.r}, halo ${res.halo}, ${((res.ms.all - res.ms.read) / (W * H) * 1e6).toFixed(1)} ns/px`);
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
        const banded = await K.refineMatte({ ...o, read, bandRows: 50, unbandedPx: 0, onBand: (y0, y1, bytes) => { got.push([y0, y1, bytes.length]); rows += y1 - y0; } });
        const r = banded.r, plan = K.bandPlan(W, H, { halo: 2 * r, bandRows: 50, unbandedPx: 0 });
        const want = plan.map((b) => [0, Math.max(0, b.y0 - 2 * r), W, Math.min(H, b.y1 + 2 * r)]);
        check(`the full method's halo is 2r (r ${r} at s 8, K ${K.REFINE.fullK})`, banded.halo === 2 * r && r === Math.round(K.REFINE.fullK * 8), `halo ${banded.halo}`);
        check("each band reads its rows with the halo above and below, clamped to the box", JSON.stringify(asked) === JSON.stringify(want), JSON.stringify(asked.slice(0, 3)));
        check("each band answers exactly its own rows (the halo trimmed)", rows === H && got.every(([y0, y1, n], i) => y0 === plan[i].y0 && y1 === plan[i].y1 && n === (y1 - y0) * W), JSON.stringify(got.slice(0, 3)));
        // the same bands answered without a halo: the box blurs read across the cut and the rows near it differ
        const st = K.prepareRefine(o);
        const cut = new Uint8Array(W * H);
        for (const b of K.bandPlan(W, H, { halo: 0, bandRows: 50, unbandedPx: 0 })) cut.set(K.refineBand(st, b, sc.rgba.subarray(b.ry0 * W * 4, b.ry1 * W * 4)), b.y0 * W);
        check("without the halo the band seams differ from the unbanded matte (the halo is what removes them)", maxDiff(cut, one.alpha) > 1, `max ${maxDiff(cut, one.alpha)} levels`);
        // the fast method needs none
        const fast = K.refineParams(8);
        check("the fast method is pointwise at full resolution: halo 0", fast.halo === 0 && fast.method === "fast");
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
    }

    // 8. the box blur is px/kernels.js' (the JS twin here) and an injected one is used
    {
        const sc = scene("hair", 4, 24);
        let calls = 0;
        const box = (d, w, h, r) => { calls++; return KJ.boxBlurs(d, w, h, r); };
        const a = await refineScene(K, sc, {}), b = await refineScene(K, sc, { box });
        const want = 18 * K.REFINE.softs.length;   // the colour fit's 18 means, once per softness "auto" tries
        check("an injected box blur is the one the fit uses, with the same bytes", calls === want && maxDiff(a, b) === 0, `${calls} calls of ${want}`);
        const bil = await refineScene(K, sc, { method: "bilinear" });
        const r = score(sc, a, bil), rb = score(sc, bil, bil);
        check("hair strands over the screen come back closer to the truth than the bilinear matte", r.mae < rb.mae * 0.5, `MAE ${r.mae.toFixed(1)} against ${rb.mae.toFixed(1)} levels`);
    }

    console.log(failed ? `\nkeymatte_test: ${failed} FAILED` : "\nkeymatte_test: all PASS");
    process.exit(failed ? 1 : 0);
}

if (require.main !== module) module.exports = { scene, bucketOf, score, refineScene, GREEN, BLUE };
const mode = require.main === module ? process.argv[2] : "lib";
if (mode !== "lib") (mode === "--measure" ? measure() : mode === "--time" ? time() : tests()).catch((err) => { console.error(err); process.exit(1); });
