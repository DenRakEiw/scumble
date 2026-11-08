// The pixel kernels of the tile engine without Electron: renderer/editor/px/kernels_js.js and
// their Rust builds px.wasm / px_scalar.wasm (docs/PLAN_BCE.md §B2, §2b).
//
//     node tools/px_test.js
//
// Every JS kernel against a plain reference written here from the documented formulas (no fast
// paths, no word tricks), byte for byte on random inputs, and against the editor's current code
// (`distanceTransform`, `floodMask` in inpaint_raster.js) and first principles (brute force
// distances, repeated halving, float source-over, PNG unfiltering, zlib inflate). Then every
// Rust kernel of both builds against its JS twin, byte for byte (the EDT as f32 bits), and the
// module's memory: alloc / free, a view that goes stale when memory grows and the fresh one that
// replaces it, pointers above 2 GB, the arena's take / reset. Also the twin harness (`twinCheck`, with
// a self-test), px.js' call counters (`pxCalls`) and the split's clocks and laps, kernels.js' routes, its
// recovery from a trap or an out-of-memory and its instance's lifecycle (docs/PLAN_WASM_K1.md), and with
// `PX_BENCH=1` (or `large`) the timed rows: medians over rotating rounds and a cold first call on a fresh
// compile (docs/PLAN_WASM_BUILD.md §3.4).
//
//     PX_ONLY=mask,dab node tools/px_test.js
//
// runs only those case groups (GROUPS below: the case functions main() calls, named without their `Cases` suffix), each
// where main() calls it today (the reference, the twin, both builds) and in the same order; the builds' SIMD flag check
// always runs. An unknown name is an error, and the last line says the run was filtered ("PASS (only: dab, mask; ...)"):
// it is a mutation round's focused kill set (tools/mutation_round.py), never the full test. `PX_TIMES=1` prints each
// group's time. Without PX_ONLY (or with it empty) every group runs, as before.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { pathToFileURL, fileURLToPath } = require("node:url");

const ROOT = path.dirname(__dirname);
const PX_DIR = path.join(ROOT, "renderer", "editor", "px");

let failures = 0;
function check(name, ok, detail = "") {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
    if (!ok) failures++;
}

// The case groups in main()'s order (a group in both the reference part and the per-build loop runs in both)
const GROUPS = ["twinSelfTest", "mip", "edt", "flood", "composite", "matchTwin", "smudgeTwin", "poissonTwin", "png", "compositeSha",
    "blendFixture", "blendGlsl", "tierC", "relightBench", "relightStripe", "counter", "split", "route", "trap", "lifecycle", "sel", "range",
    "pngFilter", "retouchRoute", "job", "mask", "dab", "tone", "freq", "edge", "relight", "pngRead", "match", "smudge", "poisson", "pngPart", "psd", "resample", "liquify", "memory"];
const ONLY = (() => {
    const names = (process.env.PX_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!names.length) return null;
    const unknown = names.filter((n) => !GROUPS.includes(n));
    if (unknown.length) {
        console.error(`PX_ONLY: unknown group${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; the groups are ${GROUPS.join(", ")}`);
        process.exit(2);
    }
    return new Set(names);
})();
const ONLY_NOTE = ONLY ? ` (only: ${GROUPS.filter((g) => ONLY.has(g)).join(", ")}; PX_ONLY, not the full test)` : "";
const groupsRan = new Set();

/** One case group of main(): skipped unless PX_ONLY names it (or PX_ONLY is unset). */
async function group(name, fn) {
    if (!GROUPS.includes(name)) throw new Error(`px_test: group ${name} is not in GROUPS`);
    if (ONLY && !ONLY.has(name)) return;
    groupsRan.add(name);
    const t = performance.now();
    await fn();
    if (process.env.PX_TIMES) console.log(`       group ${name}: ${(performance.now() - t).toFixed(0)} ms`);
}

async function memoryCases(px, label) {
    const MB = 1 << 20;
    const a = px.alloc(MB);
    check(`${label} alloc returns an 8-aligned pointer`, a > 0 && a % 8 === 0, `ptr ${a}`);
    const stale = px.u8();
    for (let i = 0; i < 4096; i++) stale[a + i] = (i * 31) & 255;
    const before = px.byteLength;
    const big = px.alloc(256 * MB);            // forces memory.grow
    check(`${label} a large alloc grows memory`, px.byteLength > before, `${before} -> ${px.byteLength}`);
    check(`${label} the old view is detached after growth`, stale.byteLength === 0 || stale.buffer !== px.memory.buffer);
    const fresh = px.u8();
    let same = true;
    for (let i = 0; i < 4096; i++) if (fresh[a + i] !== ((i * 31) & 255)) { same = false; break; }
    check(`${label} the fresh view sees the bytes written before growth`, same);
    px.free(big, 256 * MB);
    px.free(a, MB);

    // f32 round trip through put / get
    const f = new Float32Array([1.5, -2.25, 1e20, 0]);
    const p = px.alloc(f.byteLength);
    px.put(p, f);
    const back = px.get(Float32Array, p, 4);
    check(`${label} put / get of a Float32Array`, back.every((v, i) => v === f[i]));
    px.free(p, f.byteLength);

    // the arena: two jobs of the same shape allocate once
    const arena = px.arena(64 * 1024);
    const x = arena.take(100_000), y = arena.take(50_000);
    check(`${label} arena blocks do not overlap`, y >= x + 100_000 || x >= y + 50_000);
    arena.reset();
    const x2 = arena.take(100_000), y2 = arena.take(50_000);
    arena.reset();
    const chunks = arena.chunks.length;
    const x3 = arena.take(100_000), y3 = arena.take(50_000);
    check(`${label} after a reset the job fits one kept chunk`, chunks === 1 && arena.chunks.length === 1 && x3 === x2 && y3 === y2,
        `chunks ${chunks}`);
    arena.dispose();

    // pointers above 2 GB come back as negative i32 from the export
    const GB = 1024 * MB;
    const blocks = [];
    let high = 0;
    try {
        while (px.byteLength < 2.2 * GB) blocks.push(px.alloc(512 * MB));
        high = px.alloc(MB);
        const v = px.u8();
        v[high] = 77; v[high + MB - 1] = 78;
        check(`${label} a pointer above 2 GB is usable`, high > 2 * GB && v[high] === 77 && v[high + MB - 1] === 78, `ptr ${high}`);
    } catch (e) {
        check(`${label} a pointer above 2 GB is usable`, false, String(e));
    }
    if (high) px.free(high, MB);
    for (const b of blocks) px.free(b, 512 * MB);
}

// ---- inputs ------------------------------------------------------------------------------------

function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
        return s / 4294967296;
    };
}

/** RGBA with a mix of transparent, opaque and partial alpha, plus flat patches. */
function randomRGBA(w, h, seed, { opaque = false } = {}) {
    const r = rng(seed), d = new Uint8Array(w * h * 4);
    for (let i = 0; i < d.length; i += 4) {
        d[i] = r() * 256; d[i + 1] = r() * 256; d[i + 2] = r() * 256;
        const k = r();
        d[i + 3] = opaque ? 255 : k < 0.3 ? 0 : k < 0.6 ? 255 : r() * 256;
    }
    // flat rows so the opaque / transparent fast paths get whole SIMD blocks
    if (!opaque) for (let y = 0; y < h; y += 5) for (let x = 0; x < w; x++) d[(y * w + x) * 4 + 3] = y % 10 ? 255 : 0;
    if (!opaque && h === 1) for (let x = 0; x < w; x += 40) d.fill(255, x * 4 + 3, x * 4 + 4), d.fill(0, Math.min(w - 1, x + 20) * 4 + 3, Math.min(w - 1, x + 20) * 4 + 4);
    return d;
}

/** One row of pixels with real partial alpha (20 % clear, 20 % opaque, the rest anything) and flat 16 px runs of 0, 255 and 128 alpha. */
function pixelRow(n, seed, { opaque = false } = {}) {
    const r = rng(seed), d = new Uint8Array(n * 4);
    for (let i = 0; i < d.length; i += 4) {
        d[i] = r() * 256; d[i + 1] = r() * 256; d[i + 2] = r() * 256;
        const k = r();
        d[i + 3] = opaque ? 255 : k < 0.2 ? 0 : k < 0.4 ? 255 : r() * 256;
    }
    if (!opaque) for (let p = 0, k = 0; p + 16 <= n; p += 64, k++) for (let q = p; q < p + 16; q++) d[q * 4 + 3] = [0, 255, 128][k % 3];
    return d;
}

function randomMask(n, seed) {
    const r = rng(seed), m = new Uint8Array(n);
    for (let i = 0; i < n; i++) { const k = r(); m[i] = k < 0.3 ? 0 : k < 0.6 ? 255 : r() * 256; }
    for (let i = 0; i < n; i += 97) m.fill(i % 2 ? 255 : 0, i, Math.min(n, i + 32));
    return m;
}

function blobs(w, h, seed, count = 6) {
    const r = rng(seed), f = new Uint8Array(w * h);
    for (let b = 0; b < count; b++) {
        const cx = r() * w, cy = r() * h, rx = 1 + r() * w / 4, ry = 1 + r() * h / 4;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const u = (x - cx) / rx, v = (y - cy) / ry;
            if (u * u + v * v < 1 + 0.3 * Math.sin(x * 0.7 + y * 0.3)) f[y * w + x] = 1;
        }
    }
    for (let i = 0; i < w * h; i += 1 + Math.floor(r() * 400)) f[i] = 1;   // stray pixels
    return f;
}

/** Quantised colours in regions, so a flood has shapes to follow. */
function regions(w, h, seed) {
    const r = rng(seed), d = new Uint8Array(w * h * 4);
    const cells = 7, pal = Array.from({ length: 5 }, () => [r() * 256 | 0, r() * 256 | 0, r() * 256 | 0, r() < 0.2 ? 0 : 255]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const k = (Math.floor(x / cells + Math.sin(y / 5) * 2) * 7 + Math.floor(y / cells) * 3) % 5;
        const c = pal[(k + 5) % 5], i = (y * w + x) * 4;
        const n = r() * 12 | 0;
        d[i] = Math.min(255, c[0] + n); d[i + 1] = Math.min(255, c[1] + n); d[i + 2] = c[2]; d[i + 3] = c[3];
    }
    return d;
}

const eqBytes = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;

function firstDiff(a, b) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return `at ${i}: ${a[i]} vs ${b[i]}`;
    return a.length !== b.length ? `length ${a.length} vs ${b.length}` : "";
}

// ---- the twin harness (docs/PLAN_WASM_BUILD.md §3.4) --------------------------------------------
//
// `twinCheck` runs one kernel's cases on the Rust builds and on its JS twin and compares every output: integers byte
// for byte, floats bit for bit through u32 / u64 views (so -0 against 0 and one NaN against another count). Each case
// runs twice per build, with its inputs as given and with each typed-array input copied to an odd offset (an odd
// byteOffset for bytes; a wider array cannot start inside an element, so one element in, an odd element offset).
// A difference the caller allows is a named rule, counted and printed; any other is a failure.

const f64Scratch = new Float64Array(1), u64Scratch = new BigUint64Array(f64Scratch.buffer);
const numBits = (x) => { f64Scratch[0] = x; return u64Scratch[0]; };
const isFloatArray = (v) => v instanceof Float32Array || v instanceof Float64Array;
/** The words a float array is made of (u32 / u64 over the same bytes); an integer array as it is. */
const bitsOf = (v) => (v instanceof Float32Array ? new Uint32Array(v.buffer, v.byteOffset, v.length)
    : v instanceof Float64Array ? new BigUint64Array(v.buffer, v.byteOffset, v.length) : v);

/** A copy of the typed array `v`, at offset 0 or (`odd`) one element in, which for bytes is an odd byteOffset. */
function copyView(v, odd) {
    if (!odd) return v.slice();
    const E = v.BYTES_PER_ELEMENT, out = new v.constructor(new ArrayBuffer(v.byteLength + 2 * E), E, v.length);
    out.set(v);
    return out;
}

/**
 * The first difference between a build's output `got` and the twin's `want` that no rule allows ("" for none), the
 * allowed ones added to `counts` by rule name. Outputs: typed arrays, numbers, plain arrays and objects of them, null.
 */
function twinDiff(got, want, rules, counts, at = "out") {
    if (ArrayBuffer.isView(want) || ArrayBuffer.isView(got)) {
        if (!ArrayBuffer.isView(want) || !ArrayBuffer.isView(got)) return `${at}: a typed array against ${ArrayBuffer.isView(got) ? String(want) : String(got)}`;
        if (isFloatArray(got) !== isFloatArray(want) || got.BYTES_PER_ELEMENT !== want.BYTES_PER_ELEMENT) return `${at}: ${got.constructor.name} against the twin's ${want.constructor.name}`;
        if (got.length !== want.length) return `${at}: length ${got.length}, the twin's ${want.length}`;
        const gb = bitsOf(got), wb = bitsOf(want);
        for (let i = 0; i < gb.length; i++) {
            if (gb[i] === wb[i]) continue;
            const rule = rules.find((r) => r.allow(got[i], want[i]));
            if (!rule) return `${at}[${i}] is ${got[i]}${isFloatArray(got) ? ` (0x${gb[i].toString(16)})` : ""}, the twin has ${want[i]}${isFloatArray(want) ? ` (0x${wb[i].toString(16)})` : ""}`;
            counts[rule.name]++;
        }
        return "";
    }
    if (typeof want === "number" && typeof got === "number") {
        if (numBits(got) === numBits(want)) return "";
        const rule = rules.find((r) => r.allow(got, want));
        if (!rule) return `${at} is ${got}, the twin has ${want}`;
        counts[rule.name]++;
        return "";
    }
    if (Array.isArray(want) && Array.isArray(got)) {
        if (got.length !== want.length) return `${at}: length ${got.length}, the twin's ${want.length}`;
        for (let i = 0; i < want.length; i++) { const d = twinDiff(got[i], want[i], rules, counts, `${at}[${i}]`); if (d) return d; }
        return "";
    }
    if (want && got && typeof want === "object" && typeof got === "object") {
        const keys = Object.keys(want);
        if (keys.length !== Object.keys(got).length || !keys.every((k) => k in got)) return `${at}: keys ${Object.keys(got)}, the twin's ${keys}`;
        for (const k of keys) { const d = twinDiff(got[k], want[k], rules, counts, `${at}.${k}`); if (d) return d; }
        return "";
    }
    return Object.is(got, want) ? "" : `${at} is ${String(got)}, the twin has ${String(want)}`;
}

/** Whether the output holds a float array anywhere (the check line then says "bit for bit"). */
const holdsFloats = (v) => isFloatArray(v) || (v && typeof v === "object" && !ArrayBuffer.isView(v) && Object.values(v).some(holdsFloats));

/**
 * One kernel on every build of `builds` against its twin, without reporting: `{ builds: [{ label, ok, detail, counts }],
 * twinOffset, floats }`. `cases`: `[{ tag, args }]`, random, edge and fuzz inputs alike; every typed array in `args` is
 * copied before each run (a kernel may write its input in place), and the ones `shift` names (true: all; false: none; or
 * a list of argument indexes) also go at an odd offset. `call(k, args)` runs the kernel on `k` (a `Px` or the twin
 * module). `rules`: `[{ name, allow(got, want) }]` per differing value. `twinOffset`: "" or how the twin itself differed
 * at the odd offset (its word paths are tested here too).
 */
function twinRun({ builds, twin, call, cases, rules = [], shift = true }) {
    const shifts = (i) => (shift === true || (Array.isArray(shift) && shift.includes(i)));
    const argsFor = (args, odd) => args.map((v, i) => (ArrayBuffer.isView(v) && !(v instanceof DataView) ? copyView(v, odd && shifts(i)) : v));
    const tryCall = (k, args) => { try { return { out: call(k, args) }; } catch (e) { return { threw: String((e && e.message) || e) }; } };
    const anyShift = shift === true || (Array.isArray(shift) && shift.length > 0);
    const res = builds.map(([label]) => ({ label, ok: true, detail: "", counts: Object.fromEntries(rules.map((r) => [r.name, 0])) }));
    let twinOffset = "", floats = false;
    for (const c of cases) {
        const want = tryCall(twin, argsFor(c.args, false));
        if (want.threw) { for (const r of res) if (r.ok) { r.ok = false; r.detail = `${c.tag}: the twin threw ${want.threw}`; } continue; }
        floats = floats || holdsFloats(want.out);
        if (anyShift && !twinOffset) {
            const w2 = tryCall(twin, argsFor(c.args, true));
            const d = w2.threw ? `threw ${w2.threw}` : twinDiff(w2.out, want.out, [], {});
            if (d) twinOffset = `${c.tag}: ${d}`;
        }
        builds.forEach(([, px], b) => {
            const r = res[b];
            if (!r.ok) return;
            for (const odd of anyShift ? [false, true] : [false]) {
                const got = tryCall(px, argsFor(c.args, odd));
                const d = got.threw ? `threw ${got.threw}` : twinDiff(got.out, want.out, rules, r.counts);
                if (d) { r.ok = false; r.detail = `${c.tag}${odd ? " at an odd offset" : ""}: ${d}`; return; }
            }
        });
    }
    return { builds: res, twinOffset, floats };
}

const twinOffsetChecked = new Set();   // kernel names whose twin was checked at an odd offset (once per run of this file)

/**
 * `twinRun` reported: one check line per build ("<label> <title> (N cases ...)"), the allowed differences per rule
 * printed under it, and once per kernel a line that the twin gives the same at an odd offset. `name` is the kernel's
 * export; `title` defaults to "<name> equals its twin bit for bit" (floats) or "byte for byte". `builds` is usually
 * `[["rust simd", simdPx], ["rust scalar", scalarPx]]`; a case list called per build passes its one.
 */
function twinCheck({ name, title = null, builds, twin, call, cases, rules = [], shift = true }) {
    const run = twinRun({ builds, twin, call, cases, rules, shift });
    const anyShift = shift === true || (Array.isArray(shift) && shift.length > 0);
    const what = title || `${name} equals its twin ${run.floats ? "bit for bit" : "byte for byte"}`;
    for (const r of run.builds) {
        check(`${r.label} ${what} (${cases.length} cases${anyShift ? ", each also at an odd offset" : ""})`, r.ok, r.detail);
        if (rules.length) console.log(`       ${r.label} ${name} allowed differences: ${rules.map((x) => `${x.name} ${r.counts[x.name]}`).join(", ")}`);
    }
    if (anyShift && !twinOffsetChecked.has(name)) {
        twinOffsetChecked.add(name);
        check(`js ${name} gives the same at an odd offset`, !run.twinOffset, run.twinOffset);
    }
    return run;
}

/** The harness on kernels made to differ: each kind of difference is found, an allowed one counted, nothing else. */
function twinSelfTest() {
    const half = (a) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] * 0.5; return o; };
    const twin = {
        half,
        bytes: (a) => Uint8Array.from(a, (v) => v ^ 0x5a),
        bump: (a) => { for (let i = 0; i < a.length; i++) a[i]++; return a; },   // writes its input in place
        pair: (a) => ({ sum: a.reduce((s, v) => s + v, 0), first: [a[0], a[1]] }),
    };
    const twinsOf = (over) => ({ ...twin, ...over });
    const f = Float32Array.from({ length: 37 }, (_, i) => (i % 5 ? i * 0.37 - 4 : 0));
    const b = Uint8Array.from({ length: 41 }, (_, i) => (i * 37) & 255);
    const floatCases = [{ tag: "37 floats", args: [f] }], byteCases = [{ tag: "41 bytes", args: [b] }];
    const run = (builds, kernel, cases, rules = [], shift = true) => twinRun({ builds, twin, call: (k, [a]) => k[kernel](a), cases, rules, shift });
    const same = run([["a", twin], ["b", twinsOf({})]], "half", floatCases);
    check("twin harness: identical builds pass, the run sees floats", same.builds.every((r) => r.ok) && same.floats && !same.twinOffset);
    const negZero = run([["neg", twinsOf({ half: (a) => { const o = half(a); o[o.indexOf(0)] = -0; return o; } })]], "half", floatCases);
    check("twin harness: -0 against 0 is a difference (bits, not ===)", !negZero.builds[0].ok && /0x80000000/.test(negZero.builds[0].detail), negZero.builds[0].detail);
    const withNaN = (bits) => twinsOf({ half: (a) => { const o = half(a); new Uint32Array(o.buffer)[3] = bits; return o; } });
    const nan = twinRun({ builds: [["nan", withNaN(0x7fc00001)]], twin: withNaN(0x7fc00000), call: (k, [a]) => k.half(a), cases: floatCases });
    check("twin harness: two NaNs with other payloads differ", !nan.builds[0].ok && /7fc00001/.test(nan.builds[0].detail), nan.builds[0].detail);
    const off1 = run([["off1", twinsOf({ bytes: (a) => { const o = twin.bytes(a); o[7] ^= 1; return o; } })]], "bytes", byteCases);
    check("twin harness: one byte off is a failure without a rule", !off1.builds[0].ok && /out\[7\]/.test(off1.builds[0].detail), off1.builds[0].detail);
    const level = { name: "one level", allow: (got, want) => Math.abs(got - want) <= 1 };
    const allowed = run([["lvl", twinsOf({ bytes: (a) => { const o = twin.bytes(a); o[7] ^= 1; o[9] ^= 1; return o; } })]], "bytes", byteCases, [level]);
    check("twin harness: an allowed difference passes and is counted per run (2 values x 2 offsets)", allowed.builds[0].ok && allowed.builds[0].counts["one level"] === 4, JSON.stringify(allowed.builds[0].counts));
    // a kernel that reads its input from the start of the buffer, ignoring byteOffset: right as given, wrong when shifted
    const blind = run([["blind", twinsOf({ bytes: (a) => twin.bytes(new Uint8Array(a.buffer, 0, a.length)) })]], "bytes", byteCases);
    check("twin harness: a kernel blind to byteOffset fails at the odd offset only", !blind.builds[0].ok && /at an odd offset/.test(blind.builds[0].detail), blind.builds[0].detail);
    const noShift = run([["blind", twinsOf({ bytes: (a) => twin.bytes(new Uint8Array(a.buffer, 0, a.length)) })]], "bytes", byteCases, [], false);
    check("twin harness: shift false runs the inputs as given only", noShift.builds[0].ok);
    const blindTwin = twinRun({ builds: [["b", twin]], twin: twinsOf({ bytes: (a) => twin.bytes(new Uint8Array(a.buffer, 0, a.length)) }), call: (k, [a]) => k.bytes(a), cases: byteCases });
    check("twin harness: a twin blind to byteOffset is reported as the twin's", !!blindTwin.twinOffset, blindTwin.twinOffset);
    const inPlace = run([["b", twinsOf({})]], "bump", byteCases);
    check("twin harness: inputs are copied for every run (a kernel that writes its input in place)", inPlace.builds[0].ok && b[0] === 0 && b[1] === 37, inPlace.builds[0].detail);
    const pair = run([["p", twinsOf({ pair: (a) => ({ sum: a.reduce((s, v) => s + v, 0), first: [a[0], a[2]] }) })]], "pair", byteCases);
    check("twin harness: numbers and arrays inside an object are compared too", !pair.builds[0].ok && /out\.first\[1\]/.test(pair.builds[0].detail), pair.builds[0].detail);
    const threw = run([["t", twinsOf({ half: () => { throw new Error("no room"); } })]], "half", floatCases);
    check("twin harness: a build that throws fails with its message", !threw.builds[0].ok && /no room/.test(threw.builds[0].detail), threw.builds[0].detail);
}

// ---- kernels -----------------------------------------------------------------------------------

async function mipCases(ref, label, js) {
    // the weighting itself: one opaque red over three transparent pixels stays red
    const tiny = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const t = js.mipHalf(tiny, 2, 2);
    check(`js mip keeps the colour of the one opaque sample`, t[0] === 255 && t[1] === 0 && t[2] === 0 && t[3] === 64, Array.from(t).join(","));
    let ok = true, detail = "";
    for (const [w, h, seed] of [[256, 256, 1], [37, 23, 2], [2, 2, 3], [3, 3, 4], [64, 18, 5], [512, 7, 6], [1024, 1024, 7]]) {
        for (const opaque of [false, true]) {
            const src = randomRGBA(w, h, seed * 17 + (opaque ? 1 : 0), { opaque });
            const a = js.mipHalf(src, w, h), b = ref.mipHalf(src, w, h);
            if (!eqBytes(a, b)) { ok = false; detail = `${w}x${h}${opaque ? " opaque" : ""} ${firstDiff(a, b)}`; }
        }
    }
    check(`js mipHalf equals the ${label}`, ok, detail);
    {
        // the byte path (a buffer that does not start on a word boundary) and ImageData-style input
        const src = randomRGBA(256, 256, 91), words = js.mipHalf(src, 256, 256);
        const shifted = new Uint8Array(src.length + 1); shifted.set(src, 1);
        const bytes = js.mipHalf(shifted.subarray(1), 256, 256);
        const clamped = js.mipChain(new Uint8ClampedArray(src.buffer), 256, 5), plain = js.mipChain(src, 256, 5);
        check(`js mip byte path equals the word path; Uint8ClampedArray input gives the same chain`, eqBytes(words, bytes) && eqBytes(new Uint8Array(clamped.buffer), plain));
    }
    ok = true; detail = "";
    for (const [size, levels] of [[256, 5], [512, 5], [512, 6], [64, 3]]) {
        const src = randomRGBA(size, size, size + levels);
        const a = js.mipChain(src, size, levels), b = ref.mipChain(src, size, levels);
        let chained = [], prev = src, s = size;
        for (let l = 0; l < levels; l++) { prev = js.mipHalf(prev, s, s); chained.push(prev); s >>= 1; }
        const halved = Buffer.concat(chained.map((c) => Buffer.from(c)));
        if (!eqBytes(a, b) || !eqBytes(a, new Uint8Array(halved))) { ok = false; detail = `${size}/${levels} ${firstDiff(a, b) || "chain differs from halving"}`; }
    }
    check(`js mipChain equals the ${label} and repeated halving`, ok, detail);
    ok = true; detail = "";
    if (ref.clampExtend) {
        for (const [size, vw, vh] of [[256, 256, 256], [256, 1, 1], [256, 37, 256], [256, 256, 200], [256, 100, 3], [64, 63, 1]]) {
            const src = randomRGBA(size, size, size + vw * 7 + vh);
            const a = js.clampExtend(src.slice(), size, vw, vh), b = ref.clampExtend(src.slice(), size, vw, vh);
            let edge = true;
            for (let y = 0; y < size && edge; y++) for (let x = 0; x < size; x++) {
                const sy = Math.min(y, vh - 1), sx = Math.min(x, vw - 1), i = (y * size + x) * 4, j = (sy * size + sx) * 4;
                if (a[i] !== src[j] || a[i + 1] !== src[j + 1] || a[i + 2] !== src[j + 2] || a[i + 3] !== src[j + 3]) { edge = false; break; }
            }
            if (!eqBytes(a, b) || !edge) { ok = false; detail = `${size} ${vw}x${vh} ${firstDiff(a, b) || "not the clamped edge"}`; }
        }
        check(`js clampExtend equals the ${label} and repeats the valid edge`, ok, detail);
    }
}

async function edtCases(ref, label, js, raster) {
    let ok = true, detail = "";
    const cases = [[1, 1, 0], [1, 50, 1], [50, 1, 2], [300, 200, 3], [257, 129, 4], [64, 64, -1], [64, 64, -2], [640, 480, 5]];
    for (const [w, h, seed] of cases) {
        let feature;
        if (seed === -1) feature = new Uint8Array(w * h);                 // nothing set
        else if (seed === -2) feature = new Uint8Array(w * h).fill(1);    // everything set
        else feature = blobs(w, h, seed + 11);
        const a = js.distTransform(feature, w, h), b = ref.distTransform(feature, w, h);
        if (!eqBytes(a, b)) { ok = false; detail = `${w}x${h} ${firstDiff(a, b)}`; }
    }
    check(`js distTransform equals the ${label} bit for bit`, ok, detail);
    // brute force on a small case: the exact squared distance
    const w = 41, h = 29, feature = blobs(w, h, 99, 2), d = js.distTransform(feature, w, h);
    let exact = true;
    for (let y = 0; y < h && exact; y++) for (let x = 0; x < w; x++) {
        let best = Infinity;
        for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) if (feature[v * w + u]) best = Math.min(best, (u - x) ** 2 + (v - y) ** 2);
        if (best === Infinity ? d[y * w + x] < 1e19 : d[y * w + x] !== best) { exact = false; break; }
    }
    check(`js twin is the exact squared distance (brute force 41x29)`, exact);
}

/** png_unfilter_rows against its twin: every filter type, pixels of 1, 2, 3, 4, 6 and 8 bytes, the row above carried over. */
async function pngReadCases(px, label, js) {
    let s = 12345;
    const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s >>> 8; };
    let ok = true, detail = "";
    for (const [w, bpp, rows] of [[1, 1, 3], [7, 3, 9], [33, 4, 12], [64, 4, 5], [19, 8, 7], [50, 2, 6], [21, 6, 4]]) {
        const rowBytes = w * bpp, stride = rowBytes + 1;
        const make = () => { const l = new Uint8Array(rows * stride); for (let i = 0; i < l.length; i++) l[i] = rnd() & 255; for (let y = 0; y < rows; y++) l[y * stride] = y % 5; return l; };
        const first = make(), second = make();
        for (const channels of bpp === 3 || bpp === 4 ? [0, bpp] : [0]) {
            const run = (k) => {
                const prev = new Uint8Array(rowBytes), outs = [];
                for (const block of [first, second]) {
                    const lines = block.slice(), out = channels ? new Uint8ClampedArray(rows * w * 4) : null;
                    const done = k.pngUnfilterRows(lines, rows, rowBytes, bpp, prev, channels ? { w, channels, out } : null);
                    outs.push(done, channels ? out : lines, prev.slice());
                }
                return outs;
            };
            const a = run(px), b = run(js);
            for (let i = 0; i < a.length; i++) {
                const same = typeof a[i] === "number" ? a[i] === b[i] : eqBytes(a[i], b[i]);
                if (!same) { ok = false; detail = `${w} px of ${bpp} bytes, channels ${channels}, item ${i}`; }
            }
        }
    }
    const bad = new Uint8Array(3 * 9); bad[9] = 7;
    const d1 = px.pngUnfilterRows(bad.slice(), 3, 8, 4, new Uint8Array(8)), d2 = js.pngUnfilterRows(bad.slice(), 3, 8, 4, new Uint8Array(8));
    if (d1 !== 1 || d2 !== 1) { ok = false; detail = `an unknown filter type stopped at ${d1} / ${d2}, not at line 1`; }
    check(`${label} png_unfilter_rows equals its twin (five filters, six pixel sizes, RGB and RGBA out, the row above carried)`, ok, detail);
    const W = 15000, R = 256, big = new Uint8Array(R * (W * 3 + 1));
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 255;
    for (let y = 0; y < R; y++) big[y * (W * 3 + 1)] = 4;
    const out = new Uint8ClampedArray(R * W * 4);
    const t0 = performance.now(); px.pngUnfilterRows(big.slice(), R, W * 3, 3, new Uint8Array(W * 3), { w: W, channels: 3, out });
    const t1 = performance.now(); js.pngUnfilterRows(big.slice(), R, W * 3, 3, new Uint8Array(W * 3), { w: W, channels: 3, out });
    const t2 = performance.now();
    console.log(`       256 rows of 15,000 RGB pixels, Paeth: ${label} ${(t1 - t0).toFixed(1)} ms, twin ${(t2 - t1).toFixed(1)} ms`);
}

/** The float masks of a provider run (dilate_mask, box_blurs, and K32's six mask kernels) against their twins: bit for bit. */
async function maskCases(px, label, js) {
    const mask = (w, h, seed) => {
        let s = seed >>> 0;
        const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
        const data = new Float32Array(w * h);
        const cx = rnd() * w, cy = rnd() * h, r = 2 + rnd() * Math.max(w, h) / 3;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = Math.round(Math.min(1, Math.max(0, (r - Math.hypot(x - cx, y - cy)) / 3)) * 255) / 255;
        for (let i = 0; i < w * h; i += 5) if (rnd() < 0.15) data[i] = Math.round(rnd() * 255) / 255;
        return data;
    };
    const masks = [[1, 1], [7, 3], [3, 97], [64, 64], [131, 77], [300, 211]].map(([w, h]) => [mask(w, h, w * 131 + h), w, h]);
    twinCheck({
        name: "dilate_mask", title: "dilate_mask equals its twin bit for bit", builds: [[label, px]], twin: js,
        call: (k, [m, w, h, r]) => k.dilateMask(m, w, h, r),
        cases: masks.flatMap(([m, w, h]) => [1, 2, 5, 40, 500].map((r) => ({ tag: `dilate ${w}x${h} by ${r}`, args: [m, w, h, r] }))),
    });
    // K4's lanes: one-channel rows two at a time (an odd height leaves its last row to the scalar loop), the column pass
    // four values a step (a width that is not a multiple of 4 leaves a tail; under 4 none), so the small sizes below
    // put every split at the lanes' edges
    const small = [[2, 2], [4, 4], [5, 6], [6, 5], [8, 1], [1, 8], [16, 3], [3, 16], [9, 9]].map(([w, h]) => [mask(w, h, w * 17 + h), w, h]);
    // Floats over a wide range of magnitudes (1e-12 .. 1e3): a mask's multiples of 1/255 add up exactly in f64, so they
    // cannot tell one rounding order from another (K4's mutation round: `(sum + enter) - leave` passed on them); these
    // round in f64 at almost every step, as relight's heights and the guided filter's products do
    const wide = (w, h, seed) => {
        let s = seed >>> 0;
        const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
        return [Float32Array.from({ length: w * h }, () => rnd() * 10 ** (rnd() * 15 - 12)), w, h];
    };
    small.push(wide(7, 5, 71), wide(64, 33, 72), wide(131, 77, 73), wide(1, 9, 74));
    twinCheck({
        name: "box_blurs", title: "box_blurs equals its twin bit for bit", builds: [[label, px]], twin: js,
        call: (k, [m, w, h, radii]) => k.boxBlurs(m, w, h, radii),
        cases: masks.flatMap(([m, w, h]) => [[1, 1, 1], [0, 1, 2], [3, 3, 4], [17, 18, 18], [200, 200, 201], [0, 0, 0]].map((radii) => ({ tag: `box blurs ${w}x${h} ${radii}`, args: [m, w, h, radii] })))
            .concat(small.flatMap(([m, w, h]) => [[1], [2, 0, 3], [7, 7, 8]].map((radii) => ({ tag: `box blurs ${w}x${h} ${radii}`, args: [m, w, h, radii] })))),
    });

    // K32: alpha_to_mask, mask_max_clamp, mask_one_minus, erode_mask, mask_to_rgba, mask_bounds_f32
    const allAlpha = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
        allAlpha[i * 4] = (i * 73) & 255;
        allAlpha[i * 4 + 1] = (255 - i) & 255;
        allAlpha[i * 4 + 2] = (i * 19 + 5) & 255;
        allAlpha[i * 4 + 3] = i;
    }
    const alphaCases = [
        { tag: "all 256 alphas", args: [allAlpha, false] },
        { tag: "all 256 alphas into out", args: [allAlpha, true] },
        ...[1, 2, 3, 4, 5, 7, 16, 17, 259].map((n) => ({ tag: `${n} pixels`, args: [randomRGBA(n, 1, n * 41), n % 2 === 0] })),
    ];
    twinCheck({
        name: "alpha_to_mask", title: "alpha_to_mask equals its twin bit for bit", builds: [[label, px]], twin: js,
        call: (k, [rgba, into]) => k.alphaToMask(rgba, into ? new Float32Array(rgba.length >>> 2) : null),
        cases: alphaCases,
    });

    // Edge floats for mask_max_clamp, mask_one_minus and mask_to_rgba: placed at both SIMD lanes and the scalar tail
    const fFromBits = (bits) => {
        const u = Uint32Array.from(bits);
        return new Float32Array(u.buffer);
    };
    const edgeVals = (() => {
        const special = fFromBits([
            0x00000000, 0x80000000, 0x3f800000, 0xbf800000, 0x3f000000, 0x3eff_ffff, 0x3f00_0001,
            0x7f800000, 0xff800000, 0x7fc00000, 0xffc00000, 0x7fc01234, 0xffc01234, 0x7f800001,
            0x00000001, 0x80000001, 0x33800001, 0x3f7f_ffff, 0x3f80_0001, 0x3fc0_0000, 0x4000_0000, 0x4120_0000, 0xbfc0_0000,
        ]);
        const out = new Float32Array(special.length * 2 + 520);
        out.set(special, 0);
        // Repeat specials at an odd offset so they land in the scalar tail when length % 4 !== 0
        out.set(special, out.length - special.length);
        for (let i = 0; i < 256; i++) {
            out[special.length + i * 2] = i / 255;
            out[special.length + i * 2 + 1] = (i + 0.5) / 255;
        }
        return out;
    })();
    const pairA = new Float32Array(edgeVals.length), pairB = new Float32Array(edgeVals.length);
    for (let i = 0; i < edgeVals.length; i++) {
        pairA[i] = edgeVals[i];
        pairB[i] = edgeVals[(i * 7 + 3) % edgeVals.length];
    }
    // Explicit signed-zero and NaN pairings at lanes 0..3 and scalar tail 4..7
    const zeroNaNA = fFromBits([0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x7fc00000, 0x3f000000, 0x7fc01234]);
    const zeroNaNB = fFromBits([0x80000000, 0x00000000, 0x80000000, 0x00000000, 0x3f000000, 0x7fc00000, 0xffc05678]);
    const mcCases = [];
    for (const [tag, a, b] of [
        ["zeros and NaNs (7)", zeroNaNA, zeroNaNB],
        ["edge pairs", pairA, pairB],
        ["edge pairs reversed", pairB, pairA],
        ["1 float", edgeVals.subarray(0, 1), pairB.subarray(0, 1)],
        ["2 floats", edgeVals.subarray(0, 2), pairB.subarray(0, 2)],
        ["3 floats", edgeVals.subarray(0, 3), pairB.subarray(0, 3)],
        ["5 floats", edgeVals.subarray(0, 5), pairB.subarray(0, 5)],
        ["131x77 mask", masks[4][0], mask(131, 77, 999)],
    ]) {
        for (const hasB of [true, false]) {
            for (const clamp of [false, true]) {
                for (const inPlace of [false, true]) {
                    mcCases.push({ tag: `${tag} b=${hasB} clamp=${clamp} inPlace=${inPlace}`, args: [a, hasB ? b : null, clamp, inPlace] });
                }
            }
        }
    }
    twinCheck({
        name: "mask_max_clamp", title: "mask_max_clamp equals its twin bit for bit (NaN, +-0, clamp, in-place)", builds: [[label, px]], twin: js,
        call: (k, [a, b, clamp, inPlace]) => k.maskMaxClamp(a, b, clamp, inPlace ? a : null),
        cases: mcCases,
    });

    const omCases = [
        { tag: "edge values", args: [edgeVals, false] },
        { tag: "edge values in-place", args: [edgeVals, true] },
        { tag: "zeros and NaNs (7)", args: [zeroNaNA, false] },
        ...[1, 2, 3, 4, 5, 7, 16, 19].map((n) => ({ tag: `${n} floats`, args: [edgeVals.subarray(0, n), n % 2 === 1] })),
        { tag: "131x77 mask", args: [masks[4][0], false] },
    ];
    twinCheck({
        name: "mask_one_minus", title: "mask_one_minus equals its twin bit for bit", builds: [[label, px]], twin: js,
        call: (k, [m, inPlace]) => k.maskOneMinus(m, inPlace ? m : null),
        cases: omCases,
    });

    // Direct export checks when dst !== src (Px methods pass pa as both src and dst to save arena memory)
    {
        const n = zeroNaNA.length, bytes = n * 4;
        const pa = px.alloc(bytes), pb = px.alloc(bytes), po = px.alloc(bytes);
        px.put(pa, zeroNaNA); px.put(pb, zeroNaNB);
        px.exports.mask_max_clamp(pa, pb, po, n, 1);
        const gotMc = px.get(Float32Array, po, n);
        const wantMc = js.maskMaxClamp(zeroNaNA, zeroNaNB, true);
        px.exports.mask_one_minus(pa, po, n);
        const gotOm = px.get(Float32Array, po, n);
        const wantOm = js.maskOneMinus(zeroNaNA);
        px.free(pa, bytes); px.free(pb, bytes); px.free(po, bytes);
        check(`${label} mask_max_clamp and mask_one_minus with separate dst pointer equal their twins`,
            !twinDiff(gotMc, wantMc, [], {}) && !twinDiff(gotOm, wantOm, [], {}));
    }

    twinCheck({
        name: "erode_mask", title: "erode_mask equals its twin bit for bit", builds: [[label, px]], twin: js,
        call: (k, [m, w, h, r]) => k.erodeMask(m, w, h, r),
        cases: masks.concat(small.slice(0, 5)).flatMap(([m, w, h]) => [0, 1, 2, 5, 40, 500].map((r) => ({ tag: `erode ${w}x${h} by ${r}`, args: [m, w, h, r] }))),
    });

    const rgbaCases = [];
    for (const mode of [0, 1, 2]) {
        for (const [tag, m] of [
            ["edge values", edgeVals],
            ["zeros and NaNs (7)", zeroNaNA],
            ["1 float", edgeVals.subarray(4, 5)],
            ["2 floats", edgeVals.subarray(4, 6)],
            ["3 floats", edgeVals.subarray(4, 7)],
            ["5 floats", edgeVals.subarray(4, 9)],
            ["64x64 mask", masks[3][0]],
        ]) {
            for (const into of [false, true]) {
                rgbaCases.push({ tag: `mode ${mode} ${tag} into=${into}`, args: [m, mode, into] });
            }
        }
    }
    twinCheck({
        name: "mask_to_rgba", title: "mask_to_rgba equals its twin byte for byte (white, luminance, alpha)", builds: [[label, px]], twin: js,
        call: (k, [m, mode, into]) => k.maskToRgba(m, mode, into ? new Uint8ClampedArray(m.length * 4) : null),
        cases: rgbaCases,
    });

    const boundsCases = [
        { tag: "empty 7x5", args: [new Float32Array(35), 7, 5] },
        { tag: "exactly 0.5 everywhere 7x5", args: [new Float32Array(35).fill(0.5), 7, 5] },
        { tag: "NaN and negative 7x5", args: [Float32Array.from({ length: 35 }, (_, i) => (i % 2 ? NaN : -1)), 7, 5] },
        { tag: "full 7x5", args: [new Float32Array(35).fill(1), 7, 5] },
        { tag: "zero width", args: [new Float32Array(0), 0, 5] },
        { tag: "zero height", args: [new Float32Array(0), 5, 0] },
        ...masks.map(([m, w, h]) => ({ tag: `mask ${w}x${h}`, args: [m, w, h] })),
    ];
    // Single-pixel and two-pixel masks across every x in a 10x3 mask (covers SIMD blocks 0..4, 4..8, and tail 8..10)
    const bw = 10, bh = 3, aboveHalf = fFromBits([0x3f00_0001])[0];
    for (let y = 0; y < bh; y++) {
        for (let x0 = 0; x0 < bw; x0++) {
            const single = new Float32Array(bw * bh).fill(0.5);
            single[y * bw + x0] = aboveHalf;
            boundsCases.push({ tag: `single 10x3 at ${x0},${y}`, args: [single, bw, bh] });
            for (let x1 = x0 + 1; x1 < bw; x1++) {
                const pair = new Float32Array(bw * bh).fill(0.5);
                pair[y * bw + x0] = aboveHalf;
                pair[y * bw + x1] = 1.0;
                boundsCases.push({ tag: `pair 10x3 at ${x0}..${x1} row ${y}`, args: [pair, bw, bh] });
            }
        }
    }
    twinCheck({
        name: "mask_bounds_f32", title: "mask_bounds_f32 equals its twin", builds: [[label, px]], twin: js,
        call: (k, [m, w, h]) => k.maskBoundsF32(m, w, h),
        cases: boundsCases,
    });

    // K33: color_match_rgba (f64 sequential stats, clamped total vs unclamped stats, ties-even u8) & blend_alpha
    const cmCases = [];
    {
        const p64 = randomRGBA(64, 1, 801), r64 = randomRGBA(64, 1, 802);
        const p128 = randomRGBA(128, 1, 803), r128 = randomRGBA(128, 1, 804);
        // Below 64 threshold: 0, 63.5, 64 * (1 - 2^-24), and 63 pixels at weight 2.0 (clamped to 1.0 in total -> 63 < 64)
        const wtZero = new Float32Array(64);
        const wtNeg = new Float32Array(64).fill(-1);
        const wt635 = new Float32Array(128); wt635.fill(0.5, 0, 127);
        const wtBelow1Ulp = new Float32Array(64).fill(fFromBits([0x3f7f_ffff])[0]);
        const wt63Over1 = new Float32Array(64); wt63Over1.fill(2.0, 0, 63);
        // At and above 64 threshold: 64 * 1.0, 128 * 0.5, 64 * 2.0 (total=64, stats uses wt=2.0)
        const wtExact64 = new Float32Array(64).fill(1.0);
        const wtHalf128 = new Float32Array(128).fill(0.5);
        for (let i = 0; i < 128; i += 16) wtHalf128[i] = i % 32 === 0 ? 0.0 : -0.0;
        const wtHalf130 = new Float32Array(130).fill(0.5);
        wtHalf130[0] = -0.75; wtHalf130[1] = 0.0;
        const wt64Over1 = new Float32Array(65); wt64Over1.fill(2.5, 0, 64); wt64Over1[64] = -0.5;
        cmCases.push(
            { tag: "1 pixel (total < 64)", args: [p64.subarray(0, 4), r64.subarray(0, 4), new Float32Array([1.0])] },
            { tag: "64 pixels weight 0", args: [p64, r64, wtZero] },
            { tag: "64 pixels negative weight", args: [p64, r64, wtNeg] },
            { tag: "128 pixels total 63.5", args: [p128, r128, wt635] },
            { tag: "64 pixels 1 ULP below 1.0 (total < 64)", args: [p64, r64, wtBelow1Ulp] },
            { tag: "63 pixels weight 2.0 (clamped total 63 < 64)", args: [p64, r64, wt63Over1] },
            { tag: "64 pixels exact total 64", args: [p64, r64, wtExact64] },
            { tag: "128 pixels with 0 and -0 (< 64)", args: [p128, r128, wtHalf128] },
            { tag: "130 pixels exact total 64 with <=0", args: [randomRGBA(130, 1, 805), randomRGBA(130, 1, 806), wtHalf130] },
            { tag: "65 pixels weight 2.5 (clamped total 64, unclamped stats)", args: [randomRGBA(65, 1, 807), randomRGBA(65, 1, 808), wt64Over1] },
        );
        // Ties-to-even across all 256 byte values: patch has two pixels per value v in 0..255 (mean=127.5),
        // reference has two pixels at (64 + (v >> 1)) so scale = 0.5 exactly and (v - 127.5)*0.5 + r_mean hits halves
        const nTies = 256, pTies = new Uint8ClampedArray(nTies * 4), rTies = new Uint8ClampedArray(nTies * 4);
        const wtTies = new Float32Array(nTies).fill(1.0);
        for (let i = 0; i < nTies; i++) {
            pTies[i * 4] = i; pTies[i * 4 + 1] = 255 - i; pTies[i * 4 + 2] = (i * 3) & 255; pTies[i * 4 + 3] = i;
            // Construct reference with exact 0.5 std on R, 2.0 clamp on G (flat patch or steep ref), 0.5 clamp on B (flat ref)
            rTies[i * 4] = i < 128 ? 68 : 132;     // mean 100, std 32
            rTies[i * 4 + 1] = i < 128 ? 0 : 255;  // high std -> hits 2.0 clamp when patch G is narrow
            rTies[i * 4 + 2] = 120;                // zero variance -> hits 1e-6*255*255 floor & 0.5 scale clamp
            rTies[i * 4 + 3] = 255 - i;
        }
        // Variance floor (1e-6 * 255 * 255 -> std floor 0.255) without hitting 0.5/2.0 clamps on R & B,
        // and upper scale clamp 2.0 on G with non-zero (p - t_mean):
        const nFloor = 257, pFlat = new Uint8ClampedArray(nFloor * 4), rFlat = new Uint8ClampedArray(nFloor * 4);
        const wtFlat = new Float32Array(nFloor);
        for (let i = 0; i < 256; i++) {
            wtFlat[i] = 1.0;
            // R: ref flat at 100 (std floor 0.255), patch has 40 pixels at 101 and 216 at 100 (std ~0.363) -> q ~0.702 in (0.5, 2.0)
            pFlat[i * 4] = i < 40 ? 101 : 100;
            rFlat[i * 4] = 100;
            // G: patch std 10 (80 vs 100), ref std 127.5 (0 vs 255) -> q = 12.75, clamped to 2.0; (100 - 90) * 2.0 + 127.5 = 148
            pFlat[i * 4 + 1] = i < 128 ? 80 : 100;
            rFlat[i * 4 + 1] = i < 128 ? 0 : 255;
            // B: patch flat at 100 (std floor 0.255), ref has 40 pixels at 101 and 216 at 100 (std ~0.363) -> q ~1.424 in (0.5, 2.0)
            pFlat[i * 4 + 2] = 100;
            rFlat[i * 4 + 2] = i < 40 ? 101 : 100;
            pFlat[i * 4 + 3] = i;
            rFlat[i * 4 + 3] = 255 - i;
        }
        // Pixel 256 has weight 0 (does not affect mean/variance) and p = 200 so (200 - 100) * scale sensitizes scale directly!
        wtFlat[256] = 0.0;
        pFlat[256 * 4] = 200; pFlat[256 * 4 + 1] = 110; pFlat[256 * 4 + 2] = 200; pFlat[256 * 4 + 3] = 77;
        rFlat[256 * 4] = 100; rFlat[256 * 4 + 1] = 128; rFlat[256 * 4 + 2] = 100; rFlat[256 * 4 + 3] = 88;
        // Also place all 0..255 values into R on a second 513-pixel array whose first 256 set mean=100, std=64 (wt=1)
        // and whose remaining 257 (including scalar tail pixel 512) have wt=0 so they get transformed by (v - 100)*0.5 + 100 = 50 + 0.5*v!
        const pHalf = new Uint8ClampedArray(513 * 4), rHalf = new Uint8ClampedArray(513 * 4), wtHalf = new Float32Array(513);
        for (let i = 0; i < 256; i++) {
            pHalf[i * 4] = i < 128 ? 36 : 164; pHalf[i * 4 + 1] = i < 128 ? 20 : 220; pHalf[i * 4 + 2] = i; pHalf[i * 4 + 3] = i;
            rHalf[i * 4] = i < 128 ? 68 : 132; rHalf[i * 4 + 1] = i < 128 ? 10 : 250; rHalf[i * 4 + 2] = 100; rHalf[i * 4 + 3] = 255;
            wtHalf[i] = 1.0;
            const j = (256 + i) * 4;
            pHalf[j] = i; pHalf[j + 1] = i; pHalf[j + 2] = i; pHalf[j + 3] = (i * 7) & 255;
            wtHalf[256 + i] = 0.0;
        }
        pHalf[512 * 4] = 1; pHalf[512 * 4 + 1] = 3; pHalf[512 * 4 + 2] = 5; pHalf[512 * 4 + 3] = 99;
        wtHalf[512] = 0.0;
        const wtNaN = new Float32Array(68).fill(1.0); wtNaN[17] = NaN;
        cmCases.push(
            { tag: "256 pixels ties and clamps", args: [pTies, rTies, wtTies] },
            { tag: "257 pixels flat variance floor and 2.0 clamp", args: [pFlat, rFlat, wtFlat] },
            { tag: "513 pixels exact 0.5 scale ties-to-even on all 0..255", args: [pHalf, rHalf, wtHalf] },
            { tag: "68 pixels with NaN weight", args: [randomRGBA(68, 1, 809), randomRGBA(68, 1, 810), wtNaN] },
            { tag: "67 pixels random", args: [randomRGBA(67, 1, 811), randomRGBA(67, 1, 812), mask(67, 1, 813).map((v) => v * 1.4 - 0.2)] },
            { tag: "131x77 mask weights", args: [randomRGBA(131, 77, 814), randomRGBA(131, 77, 815), masks[4][0]] },
            { tag: "300x211 mask weights", args: [randomRGBA(300, 211, 816), randomRGBA(300, 211, 817), masks[5][0]] },
        );
    }
    twinCheck({
        name: "color_match_rgba", title: "color_match_rgba equals its twin byte for byte (f64 sequential stats, <64 guard, ties-even)", builds: [[label, px]], twin: js,
        call: (k, [patch, ref, wt]) => ({ matched: k.colorMatchRgba(patch, ref, wt), patch }),
        cases: cmCases,
    });

    const baCases = [];
    {
        // All 256 alphas paired with edge mask values and half-way mask fractions
        const nEdge = edgeVals.length;
        const rgbaEdge = new Uint8ClampedArray(nEdge * 4);
        for (let i = 0; i < nEdge; i++) {
            rgbaEdge[i * 4] = (i * 53 + 7) & 255;
            rgbaEdge[i * 4 + 1] = (255 - (i & 255));
            rgbaEdge[i * 4 + 2] = (i * 19 + 3) & 255;
            rgbaEdge[i * 4 + 3] = i & 255;
        }
        for (const keep of [false, true]) {
            for (const mode of ["new", "out", "inPlace"]) {
                baCases.push(
                    { tag: `edgeVals keep=${keep} ${mode}`, args: [rgbaEdge, edgeVals, keep, mode] },
                    { tag: `zeros and NaNs (7) keep=${keep} ${mode}`, args: [rgbaEdge.subarray(0, 28), zeroNaNA, keep, mode] },
                );
            }
            for (const n of [1, 2, 3, 4, 5, 7, 16, 19]) {
                baCases.push({ tag: `${n} pixels keep=${keep}`, args: [rgbaEdge.subarray(0, n * 4), edgeVals.subarray(0, n), keep, n % 2 ? "new" : "inPlace"] });
            }
            baCases.push({ tag: `131x77 keep=${keep}`, args: [randomRGBA(131, 77, keep ? 821 : 820), masks[4][0], keep, "new"] });
        }
    }
    twinCheck({
        name: "blend_alpha", title: "blend_alpha equals its twin byte for byte (keepAlpha false/true, in-place, NaN/+-0)", builds: [[label, px]], twin: js,
        call: (k, [rgba, m, keep, mode]) => k.blendAlpha(rgba, m, keep, mode === "inPlace" ? rgba : mode === "out" ? new Uint8ClampedArray(rgba.length) : null),
        cases: baCases,
    });
    // Direct export check for blend_alpha when dst !== src
    {
        const n = zeroNaNA.length, rgba = randomRGBA(n, 1, 825);
        const ps = px.alloc(n * 4), pm = px.alloc(n * 4), po0 = px.alloc(n * 4), po1 = px.alloc(n * 4);
        px.put(ps, rgba); px.put(pm, zeroNaNA);
        px.exports.blend_alpha(ps, pm, po0, n, 0);
        px.exports.blend_alpha(ps, pm, po1, n, 1);
        const got0 = px.get(Uint8ClampedArray, po0, n * 4), want0 = js.blendAlpha(rgba, zeroNaNA, false);
        const got1 = px.get(Uint8ClampedArray, po1, n * 4), want1 = js.blendAlpha(rgba, zeroNaNA, true);
        px.free(ps, n * 4); px.free(pm, n * 4); px.free(po0, n * 4); px.free(po1, n * 4);
        check(`${label} blend_alpha with separate dst pointer equals its twin`,
            !twinDiff(got0, want0, [], {}) && !twinDiff(got1, want1, [], {}));
    }

    const esCases = [];
    {
        // All 256 alpha values 0..255 with non-zero RGB (exercises f32 alpha store vs f64 alpha luma weight in 1:1 and shrunk)
        const rgba256 = new Uint8ClampedArray(16 * 16 * 4);
        for (let i = 0; i < 256; i++) {
            rgba256[i * 4] = (i * 73 + 19) & 255;
            rgba256[i * 4 + 1] = (i * 151 + 43) & 255;
            rgba256[i * 4 + 2] = (i * 199 + 107) & 255;
            rgba256[i * 4 + 3] = i;
        }
        // Boundary around as[i] > 1e-4:
        // 1 pixel of alpha=1 in a 40-pixel box -> mean alpha = (1/255)/40 = 0.0000980392 <= 1e-4 -> gray = 0
        // 1 pixel of alpha=1 in a 39-pixel box -> mean alpha = (1/255)/39 = 0.000100553 > 1e-4 -> gray = 255
        const rgbaBox40 = new Uint8ClampedArray(80 * 4);
        rgbaBox40[0] = 255; rgbaBox40[1] = 255; rgbaBox40[2] = 255; rgbaBox40[3] = 1; // first 40px box has 1/40 of 1/255 <= 1e-4
        rgbaBox40[40 * 4] = 255; rgbaBox40[40 * 4 + 1] = 255; rgbaBox40[40 * 4 + 2] = 255; rgbaBox40[40 * 4 + 3] = 1;
        rgbaBox40[41 * 4] = 255; rgbaBox40[41 * 4 + 1] = 255; rgbaBox40[41 * 4 + 2] = 255; rgbaBox40[41 * 4 + 3] = 1; // second 40px box has 2/40 of 1/255 > 1e-4
        const rgbaBox39 = new Uint8ClampedArray(78 * 4);
        rgbaBox39[0] = 255; rgbaBox39[1] = 255; rgbaBox39[2] = 255; rgbaBox39[3] = 1; // first 39px box has 1/39 of 1/255 > 1e-4
        esCases.push(
            { tag: "1x1 -> 1x1", args: [randomRGBA(1, 1, 830), 1, 1, 1, 1, false] },
            { tag: "5x1 -> 5x1 (1:1 SIMD + scalar tail)", args: [randomRGBA(5, 1, 831), 5, 1, 5, 1, false] },
            { tag: "5x1 -> 2x1", args: [randomRGBA(5, 1, 831), 5, 1, 2, 1, true] },
            { tag: "16x16 -> 16x16 all 256 alphas", args: [rgba256, 16, 16, 16, 16, false] },
            { tag: "16x16 -> 5x5 all 256 alphas", args: [rgba256, 16, 16, 5, 5, true] },
            { tag: "80x1 -> 2x1 1e-4 alpha floor boundary (<= 1e-4 vs > 1e-4)", args: [rgbaBox40, 80, 1, 2, 1, false] },
            { tag: "78x1 -> 2x1 1e-4 alpha floor boundary (1/39 of 1/255 > 1e-4)", args: [rgbaBox39, 78, 1, 2, 1, false] },
            { tag: "7x3 -> 7x3", args: [randomRGBA(7, 3, 832), 7, 3, 7, 3, true] },
            { tag: "7x3 -> 3x2", args: [randomRGBA(7, 3, 832), 7, 3, 3, 2, false] },
            { tag: "7x3 -> 7x2 (tw===w, th<h)", args: [randomRGBA(7, 3, 832), 7, 3, 7, 2, false] },
            { tag: "3x5 -> 5x3 (upsize clamp x1=max(x0+1,...))", args: [randomRGBA(3, 5, 833), 3, 5, 5, 3, false] },
            { tag: "64x64 -> 25x25", args: [randomRGBA(64, 64, 834), 64, 64, 25, 25, false] },
            { tag: "131x77 -> 37x23", args: [randomRGBA(131, 77, 835), 131, 77, 37, 23, true] },
            { tag: "300x211 -> 64x45", args: [randomRGBA(300, 211, 836), 300, 211, 64, 45, false] },
        );
    }
    twinCheck({
        name: "edgefit_shrink", title: "edgefit_shrink equals its twin float for float (1:1 and box-shrunk, f32/f64 alpha, 1e-4 floor)", builds: [[label, px]], twin: js,
        call: (k, [rgba, w, h, tw, th, useOut]) => k.edgefitShrink(rgba, w, h, tw, th,
            useOut ? new Float32Array(tw * th) : null, useOut ? new Float32Array(tw * th) : null),
        cases: esCases,
    });

    const wrCases = [];
    {
        // Adjacent pixels differing by 1 across all 0..255 so a 0.5 shift hits exact half-way ties-to-even in Uint8ClampedArray
        const rgbaTies = new Uint8ClampedArray(257 * 2 * 4);
        for (let y = 0; y < 2; y++) {
            for (let x = 0; x < 257; x++) {
                const i = (y * 257 + x) * 4, v = Math.min(255, x);
                rgbaTies[i] = v;
                rgbaTies[i + 1] = 255 - v;
                rgbaTies[i + 2] = y === 0 ? v : Math.min(255, v + 1);
                rgbaTies[i + 3] = (v * 3 + y) & 255;
            }
        }
        const mats = [
            ["identity", [1, 0, 0, 0, 1, 0]],
            ["whole shift (2, -1)", [1, 0, 2, 0, 1, -1]],
            ["half shift (0.5, 0)", [1, 0, 0.5, 0, 1, 0]],
            ["half shift (0, 0.5)", [1, 0, 0, 0, 1, 0.5]],
            ["half shift (0.5, 0.5)", [1, 0, 0.5, 0, 1, 0.5]],
            ["affine scale+shear+shift", [1.03, -0.02, 1.37, 0.015, 0.97, -0.83]],
            ["flip/negative", [-1, 0, 6, 0, -1, 2]],
            ["far out-of-bounds", [1, 0, -100, 0, 1, 100]],
            ["finite overflow to NaN", [1.797e308, -1.797e308, 0, 0, 1, 0]],
            ["finite overflow y to NaN", [1, 0, 0, 1.797e308, -1.797e308, 0]],
            ["NaN and +-Infinity", [NaN, 0, 0, 0, 1, Infinity]],
        ];
        for (const [w, h, seed] of [[1, 1, 840], [1, 5, 841], [5, 1, 842], [2, 2, 843], [5, 3, 848], [7, 3, 844], [19, 11, 845]]) {
            const src = randomRGBA(w, h, seed);
            for (const [mTag, m] of mats) {
                wrCases.push({ tag: `${w}x${h} ${mTag}`, args: [src, w, h, m, (w + h) % 2 === 0] });
            }
        }
        wrCases.push(
            { tag: "257x2 half-x ties-to-even", args: [rgbaTies, 257, 2, [1, 0, 0.5, 0, 1, 0], false] },
            { tag: "257x2 half-y ties-to-even", args: [rgbaTies, 257, 2, [1, 0, 0, 0, 1, 0.5], true] },
            { tag: "257x2 quarter-xy ties-to-even", args: [rgbaTies, 257, 2, [1, 0, 0.5, 0, 1, 0.5], false] },
            { tag: "64x64 affine", args: [randomRGBA(64, 64, 846), 64, 64, [1.02, -0.015, -2.3, 0.012, 0.985, 3.1], false] },
            { tag: "131x77 affine", args: [randomRGBA(131, 77, 847), 131, 77, [0.97, 0.02, 4.15, -0.018, 1.03, -2.75], true] },
        );
    }
    twinCheck({
        name: "warp_rgba", title: "warp_rgba equals its twin byte for byte (bilinear clamp, 1xN/Nx1, ties-to-even, NaN/+-Inf)", builds: [[label, px]], twin: js,
        call: (k, [src, w, h, m, useOut]) => k.warpRgba(src, w, h, m, useOut ? new Uint8ClampedArray(w * h * 4) : null),
        cases: wrCases,
    });

    const wcCases = [];
    {
        const mats = [
            ["identity", [1, 0, 0, 0, 1, 0]],
            ["whole shift (3, -2)", [1, 0, 3, 0, 1, -2]],
            ["half ramp (0.5, -0.5)", [1, 0, 0.5, 0, 1, -0.5]],
            ["fractional ramp (-0.25, 0.75)", [1, 0, -0.25, 0, 1, 0.75]],
            ["exact boundary -1.0 (d==0 -> +0.0)", [1, 0, -1, 0, 1, -1]],
            ["affine scale+shear+shift", [1.04, -0.02, -0.65, 0.025, 0.96, 0.72]],
            ["far outside", [1, 0, 500, 0, 1, -500]],
            ["finite overflow to NaN", [1.797e308, -1.797e308, 0, 0, 1, 0]],
            ["finite overflow y to NaN", [1, 0, 0, 1.797e308, -1.797e308, 0]],
            ["NaN and +-Infinity", [NaN, 0, 0, 0, 1, -Infinity]],
        ];
        for (const [w, h] of [[1, 1], [1, 5], [5, 1], [4, 4], [5, 3], [7, 3], [19, 11], [64, 64], [131, 77]]) {
            for (const [mTag, m] of mats) {
                wcCases.push({ tag: `${w}x${h} ${mTag}`, args: [w, h, m, (w + h) % 2 === 1] });
            }
        }
    }
    twinCheck({
        name: "warp_coverage", title: "warp_coverage equals its twin float for float (4-edge ramp, +0.0 clamp, NaN/+-Inf)", builds: [[label, px]], twin: js,
        call: (k, [w, h, m, useOut]) => k.warpCoverage(w, h, m, useOut ? new Float32Array(w * h) : null),
        cases: wcCases,
    });

    if (label === "rust simd") {
        const K = await import(pathToFileURL(path.join(PX_DIR, "kernels.js")).href);
        try {
            K.setKernels("rust");
            if (!K.rustPx()) {
                const realFetch = globalThis.fetch;
                globalThis.fetch = async (u, ...rest) => {
                    const s = String(u && u.href ? u.href : u);
                    return s.startsWith("file:") ? new Response(fs.readFileSync(fileURLToPath(s))) : realFetch(u, ...rest);
                };
                try { await K.kernelsReady(); } finally { globalThis.fetch = realFetch; }
            }
            const rgba = randomRGBA(19, 7, 301), refRgba = randomRGBA(19, 7, 302), w = 19, h = 7;
            const wt = new Float32Array(w * h).fill(0.75);
            const warpM = [1.02, -0.01, 0.75, 0.015, 0.98, -0.5];
            const runAll = () => {
                const m = K.alphaToMask(rgba);
                const mc = K.maskMaxClamp(m, pairB.subarray(0, w * h), true);
                const om = K.maskOneMinus(mc);
                const er = K.erodeMask(om, w, h, 2);
                const r0 = K.maskToRgba(er, 0), r1 = K.maskToRgba(er, 1), r2 = K.maskToRgba(er, 2);
                const b = K.maskBoundsF32(er, w, h);
                const cmPatch = rgba.slice();
                const cmOk = K.colorMatchRgba(cmPatch, refRgba, wt);
                const ba0 = K.blendAlpha(rgba, er, false);
                const ba1 = K.blendAlpha(rgba, er, true);
                const es0 = K.edgefitShrink(rgba, w, h, w, h);
                const es1 = K.edgefitShrink(rgba, w, h, 9, 4);
                const wr = K.warpRgba(rgba, w, h, warpM);
                const wc = K.warpCoverage(w, h, warpM);
                return { m, mc, om, er, r0, r1, r2, b, cmOk, cmPatch, ba0, ba1, es0, es1, wr, wc };
            };
            K.setRoute("stitchMask", "rust");
            K.setRoute("colorMatch", "rust");
            K.setRoute("blendAlpha", "rust");
            K.setRoute("edgefit", "rust");
            K.pxCalls(true);
            const rustOut = runAll(), rustCalls = K.pxCalls(true);
            K.setRoute("stitchMask", "js");
            K.setRoute("colorMatch", "js");
            K.setRoute("blendAlpha", "js");
            K.setRoute("edgefit", "js");
            const jsOut = runAll(), jsCalls = K.pxCalls(true);
            // Also check individual sub-routes edgefitShrink, warpRgba, warpCoverage
            K.setRoute("edgefit", "rust");
            K.setRoute("edgefitShrink", "js");
            K.setRoute("warpRgba", "js");
            K.setRoute("warpCoverage", "js");
            const subJsOut = {
                es0: K.edgefitShrink(rgba, w, h, w, h),
                es1: K.edgefitShrink(rgba, w, h, 9, 4),
                wr: K.warpRgba(rgba, w, h, warpM),
                wc: K.warpCoverage(w, h, warpM),
            };
            const subJsCalls = K.pxCalls(true);
            K.setRoute("stitchMask", null);
            K.setRoute("colorMatch", null);
            K.setRoute("blendAlpha", null);
            K.setRoute("edgefit", null);
            K.setRoute("edgefitShrink", null);
            K.setRoute("warpRgba", null);
            K.setRoute("warpCoverage", null);
            const exportsAll = [
                "alpha_to_mask", "mask_max_clamp", "mask_one_minus", "erode_mask", "mask_to_rgba", "mask_bounds_f32",
                "color_match_rgba", "blend_alpha", "edgefit_shrink", "warp_rgba", "warp_coverage",
            ];
            const countsOk = exportsAll.every((e) => (rustCalls[e] || 0) > 0 && !jsCalls[e] && !subJsCalls[e])
                && rustCalls.mask_to_rgba === 3 && rustCalls.color_match_rgba === 1 && rustCalls.blend_alpha === 2
                && rustCalls.edgefit_shrink === 2 && rustCalls.warp_rgba === 1 && rustCalls.warp_coverage === 1;
            const diff = twinDiff(rustOut, jsOut, [], {}) || twinDiff({ es0: rustOut.es0, es1: rustOut.es1, wr: rustOut.wr, wc: rustOut.wc }, subJsOut, [], {});
            check("kernels.js stitchMask, colorMatch, blendAlpha and edgefit routes switch K32+K33+K34 kernels between Rust and the twins with identical outputs",
                countsOk && !diff, diff || JSON.stringify({ rustCalls, jsCalls, subJsCalls }));
        } finally {
            kernelsBack(K);
        }
        const stRun = spawnSync(process.execPath, [path.join(ROOT, "tools", "stitch_test.js")], { encoding: "utf-8" });
        const stFail = ((stRun.stdout || "") + (stRun.stderr || "")).split(/\r?\n/).find((l) => l.startsWith("[FAIL]"));
        check("stitch_test.js vs 29f6749 loops", stRun.status === 0 && !stFail, stFail || `rc=${stRun.status}`);
        const efRun = spawnSync(process.execPath, [path.join(ROOT, "tools", "edgefit_test.js")], { encoding: "utf-8" });
        const efFail = ((efRun.stdout || "") + (efRun.stderr || "")).split(/\r?\n/).find((l) => l.startsWith("FAIL"));
        check("edgefit_test.js in js and rust modes", efRun.status === 0 && !efFail, efFail || `rc=${efRun.status}`);
    }

    const big = mask(1492, 1492, 9);
    const t0 = performance.now(); px.dilateMask(big, 1492, 1492, 47);
    const t1 = performance.now(); js.dilateMask(big, 1492, 1492, 47);
    const t2 = performance.now(); px.boxBlurs(big, 1492, 1492, [19, 20, 20]);
    const t3 = performance.now(); js.boxBlurs(big, 1492, 1492, [19, 20, 20]);
    const t4 = performance.now();
    console.log(`       1492 x 1492: dilate ${label} ${(t1 - t0).toFixed(1)} ms, twin ${(t2 - t1).toFixed(1)}; three box blurs ${label} ${(t3 - t2).toFixed(1)} ms, twin ${(t4 - t3).toFixed(1)}`);
    if (process.env.PX_BENCH) {
        const bigB = mask(1492, 1492, 10), bigRgba = js.maskToRgba(big, 0), bigRef = js.maskToRgba(bigB, 0);
        const warpM = [1.02, -0.01, 2.5, 0.012, 0.985, -1.75];
        const rows = [
            ["alpha_to_mask", (k) => k.alphaToMask(bigRgba)],
            ["mask_max_clamp", (k) => k.maskMaxClamp(big, bigB, true)],
            ["mask_one_minus", (k) => k.maskOneMinus(big)],
            ["erode_mask", (k) => k.erodeMask(big, 1492, 1492, 47)],
            ["mask_to_rgba", (k) => k.maskToRgba(big, 1)],
            ["mask_bounds_f32", (k) => k.maskBoundsF32(big, 1492, 1492)],
            ["color_match_rgba", (k) => k.colorMatchRgba(bigRgba, bigRef, big)],
            ["blend_alpha", (k) => k.blendAlpha(bigRgba, big, true, bigRgba)],
            ["edgefit_shrink", (k) => k.edgefitShrink(bigRgba, 1492, 1492, 512, 512)],
            ["warp_rgba", (k) => k.warpRgba(bigRgba, 1492, 1492, warpM)],
            ["warp_coverage", (k) => k.warpCoverage(1492, 1492, warpM)],
        ];
        const parts = rows.map(([n, fn]) => {
            const m = benchMedians([[label, () => fn(px)], ["twin", () => fn(js)]]);
            return `${n} ${label} ${m[label].toFixed(2)} ms, twin ${m.twin.toFixed(2)}`;
        });
        console.log(`       1492 x 1492 K32+K33+K34 masks: ${parts.join("; ")}`);
    }
}

/**
 * The blur and sharpen brushes' filters (blur_rgba, sharpen_rgba; K26) against inpaint_stroke.js, byte for byte: every
 * size from 1 x 1 up past the lanes' edges, radii 0 to 200 (above the box), the alpha values at the premultiply's and the
 * unpremultiply's edges (0, 1, 2, 127, 128, 254, 255), sharpen's amounts; the refusals the caller turns into the twin.
 */
async function dabCases(px, label) {
    const S = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_stroke.js")).href);
    const twin = { blurRGBA: S.blurRGBA, sharpenRGBA: S.sharpenRGBA };
    const EDGE = [0, 1, 2, 127, 128, 254, 255];
    const pic = (w, h, seed, kind) => {
        let s = seed >>> 0;
        const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; };
        const d = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) {
            d[i * 4] = rnd(); d[i * 4 + 1] = rnd(); d[i * 4 + 2] = rnd();
            // "faint": alphas of 1 to 12 among zeros, so the blur's alphas land around 0.5 to 1, the unpremultiply's edge
            // (K26's mutation round: a threshold of 1 instead of 0.5 passed every other kind)
            d[i * 4 + 3] = kind === "opaque" ? 255 : kind === "edges" ? EDGE[rnd() % EDGE.length] : kind === "holes" ? (rnd() < 90 ? 0 : 255) : kind === "faint" ? (rnd() < 180 ? 0 : 1 + rnd() % 12) : rnd();
        }
        return d;
    };
    const sizes = [[1, 1], [2, 3], [3, 2], [5, 4], [7, 9], [16, 16], [33, 17], [64, 48], [131, 77]];
    const kinds = ["noise", "edges", "holes", "opaque", "faint"];
    const cases = [];
    for (const [w, h] of sizes) {
        for (const kind of kinds) {
            const src = pic(w, h, w * 977 + h * 13 + kind.length, kind);
            for (const r of [0, 1, 2, 8, 40, 200]) cases.push({ tag: `${kind} ${w}x${h} r ${r}`, args: [src, w, h, r] });
        }
    }
    const dab = pic(448, 448, 4481, "noise");
    cases.push({ tag: "a 400 px brush's box 448x448 r 8", args: [dab, 448, 448, 8] }, { tag: "the same r 2.5 (rounded as the twin)", args: [dab, 448, 448, 2.5] }, { tag: "r NaN (no pass)", args: [pic(9, 7, 3, "edges"), 9, 7, NaN] }, { tag: "r -3", args: [pic(9, 7, 4, "edges"), 9, 7, -3] });
    twinCheck({ name: "blur_rgba", title: "blur_rgba equals inpaint_stroke.js blurRGBA byte for byte", builds: [[label, px]], twin, call: (k, [src, w, h, r]) => k.blurRGBA(src, w, h, r), cases });
    const sharp = cases.flatMap((c, i) => [1, 0.5, 2.25].map((amount, j) => (i % 3 === j || c.args[1] > 100 ? { tag: `${c.tag} amount ${amount}`, args: [...c.args, amount] } : null))).filter(Boolean);
    twinCheck({ name: "sharpen_rgba", title: "sharpen_rgba equals inpaint_stroke.js sharpenRGBA byte for byte", builds: [[label, px]], twin, call: (k, [src, w, h, r, amount]) => k.sharpenRGBA(src, w, h, r, amount), cases: sharp });
    const refused = [px.blurRGBA(new Uint8ClampedArray(7), 1, 2, 1), px.blurRGBA(new Uint8ClampedArray(0), 0, 4, 1), px.sharpenRGBA(new Uint8ClampedArray(16), 2.5, 2, 1), px.blurRGBA(new Uint8ClampedArray(16), 2, 2, 2 ** 31)];
    check(`${label} blur_rgba / sharpen_rgba refuse a short source, an empty or fractional size and a radius past 2^30 (null: the twin runs)`, refused.every((v) => v === null), refused.map((v) => (v === null ? "null" : v.length)).join(", "));
    const t0 = performance.now(); px.blurRGBA(dab, 448, 448, 8);
    const t1 = performance.now(); S.blurRGBA(dab, 448, 448, 8);
    const t2 = performance.now(); px.sharpenRGBA(dab, 448, 448, 8, 1);
    const t3 = performance.now(); S.sharpenRGBA(dab, 448, 448, 8, 1);
    const t4 = performance.now();
    console.log(`       a 448 x 448 dab, r 8: blur ${label} ${(t1 - t0).toFixed(1)} ms, twin ${(t2 - t1).toFixed(1)}; sharpen ${label} ${(t3 - t2).toFixed(1)} ms, twin ${(t4 - t3).toFixed(1)}`);
}

// ---- K27: the tone brush, the sponge, frequency separation's split ------------------------------------------------

/** Straight RGBA8 of `n` pixels (a Uint8ClampedArray, as the brushes read it) of one kind (`retouchPixels`). */
function retouchPixels(n, seed, kind) {
    let s = seed >>> 0;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; };
    // the channel values at the formulas' edges: 0 (black, mn 0), 1, 2, the middle, 254, 255 (mx 255)
    const EDGE = [0, 1, 2, 3, 63, 64, 127, 128, 129, 191, 253, 254, 255];
    const ALPHA = [0, 1, 2, 127, 128, 254, 255];
    const d = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
        let r = rnd(), g = rnd(), b = rnd(), a = rnd();
        if (kind === "edges") { r = EDGE[rnd() % EDGE.length]; g = EDGE[rnd() % EDGE.length]; b = EDGE[rnd() % EDGE.length]; a = ALPHA[rnd() % ALPHA.length]; }
        else if (kind === "grey") { g = r; b = rnd() < 128 ? r : (r + 1) & 255; }   // grey (a no-op for the sponge) and a level off it
        else if (kind === "dark") { r >>= 5; g >>= 5; b >>= 5; }   // black and near-black (the protect path's v 0, a floor's speck)
        else if (kind === "bright") { r = 255 - (r >> 5); g = 255 - (g >> 5); b = 255 - (b >> 5); }   // near white: lim at 255
        else if (kind === "vivid") { const k = rnd() % 3; r = k === 0 ? 255 - (r >> 4) : r >> 4; g = k === 1 ? 255 - (g >> 4) : g >> 4; b = k === 2 ? 255 - (b >> 4) : b >> 4; }
        if (kind === "holes") a = rnd() < 90 ? 0 : 255;
        else if (kind === "faint") a = rnd() < 180 ? 0 : 1 + rnd() % 12;
        else if (kind !== "edges") a = rnd() < 30 ? 0 : rnd() < 128 ? 255 : a;
        d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = a;
    }
    return d;
}

const RETOUCH_KINDS = ["noise", "edges", "grey", "dark", "bright", "vivid", "holes", "faint"];
// pixel counts: 1 up past the lanes a later build may add, and a 400 px brush's box (450 x 450)
const RETOUCH_SIZES = [1, 2, 3, 4, 5, 7, 8, 15, 16, 17, 33, 64, 255, 1000, 4097, 450 * 450];

/** Every (r, g, b) of a grid of the formulas' edge values, opaque, then the same at alphas 0, 1 and 128 (the sponge's lim and the protect path's v, exhaustively). */
function retouchGrid() {
    const V = [0, 1, 2, 3, 4, 31, 63, 64, 100, 127, 128, 129, 150, 191, 200, 252, 253, 254, 255];
    const n = V.length ** 3, d = new Uint8ClampedArray(n * 4 * 4);
    let i = 0;
    for (const a of [255, 0, 1, 128]) for (const r of V) for (const g of V) for (const b of V) { d[i++] = r; d[i++] = g; d[i++] = b; d[i++] = a; }
    return d;
}

/**
 * The tone brush's table (tone_rgba) and the sponge (sponge_rgba) against inpaint_stroke.js, byte for byte (K27): every
 * kind of picture at pixel counts from 1 to a 400 px brush's box, the grid of edge values, the tables of every range and
 * exposure (dodge and burn) and the extremes (all 0, all 255, a floor of 255 over 0s, decreasing, random, longer than
 * 256, clamped), protect on and off; the sponge's amounts in and out of 0..1 and not numbers, saturate and desaturate,
 * vibrance on, off and left out. The refusals the caller turns into the twin.
 */
async function toneCases(px, label) {
    const S = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_stroke.js")).href);
    const twin = { toneRGBA: S.toneRGBA, spongeRGBA: S.spongeRGBA };
    const pics = [];
    RETOUCH_KINDS.forEach((kind, k) => RETOUCH_SIZES.forEach((n, j) => { if (n < 4097 || j % 3 === k % 3) pics.push([`${kind} ${n} px`, retouchPixels(n, n * 31 + k * 7 + 1, kind)]); }));
    pics.push(["the grid", retouchGrid()]);
    const lut = (f) => Uint8Array.from({ length: 256 }, (_, i) => f(i));
    let rs = 77;
    const rnd = () => { rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0; return rs >>> 24; };
    const luts = [["identity", lut((i) => i)], ["all 0", lut(() => 0)], ["all 255", lut(() => 255)], ["a floor of 255 over 0s", lut((i) => (i ? 0 : 255))],
        ["0 then 255", lut((i) => (i ? 255 : 0))], ["decreasing", lut((i) => 255 - i)], ["random", lut(() => rnd())], ["floor 200 random", lut((i) => (i ? rnd() : 200))],
        ["300 bytes", Uint8Array.from({ length: 300 }, (_, i) => (i * 7 + 3) & 255)], ["clamped", Uint8ClampedArray.from({ length: 256 }, (_, i) => (i * 3) >> 1)]];
    for (const range of ["shadows", "midtones", "highlights"]) for (const e of [0, 0.37, 0.5, 1]) for (const burn of [false, true]) luts.push([`${range} ${e}${burn ? " burn" : ""}`, S.toneLUT(range, e, burn)]);
    const tone = [];
    pics.forEach(([tag, src], i) => luts.forEach(([name, l], j) => {
        // every table on the grid and the small pictures; on the large ones a few, so the run stays short
        if (src.length <= 4 * 4097 || tag === "the grid" ? true : (i + j) % 9 === 0) for (const protect of [false, true]) tone.push({ tag: `${tag}, ${name}${protect ? ", protect" : ""}`, args: [src, l, protect] });
    }));
    tone.push({ tag: "protect left out", args: [pics[1][1], luts[6][1]] }, { tag: "protect 1 (truthy)", args: [pics[1][1], luts[6][1], 1] }, { tag: "protect \"\" (falsy)", args: [pics[1][1], luts[6][1], ""] },
        { tag: "protect \"yes\" (truthy, not a number)", args: [pics[1][1], luts[6][1], "yes"] });
    twinCheck({ name: "tone_rgba", title: "tone_rgba equals inpaint_stroke.js toneRGBA byte for byte", builds: [[label, px]], twin, call: (k, a) => k.toneRGBA(...a), cases: tone });
    const sponge = [];
    const amounts = [0, 0.05, 0.37, 0.5, 0.6, 1, -1, 2, NaN, "0.6", undefined, null];
    pics.forEach(([tag, src], i) => amounts.forEach((amount, j) => {
        if (!(src.length <= 4 * 4097 || tag === "the grid" || (i + j) % 7 === 0)) return;
        for (const [sat, vib] of [[true, true], [true, false], [false, true], [true, undefined]]) {
            if (tag !== "the grid" && (i + j + (sat ? 1 : 0) + (vib ? 2 : 0)) % 3) continue;
            sponge.push({ tag: `${tag}, amount ${String(amount)}${sat ? " saturate" : " desaturate"}${vib === undefined ? "" : vib ? " vibrance" : " flat"}`, args: vib === undefined ? [src, amount, sat] : [src, amount, sat, vib] });
        }
    }));
    sponge.push({ tag: "saturate left out", args: [pics[1][1], 0.5] }, { tag: "saturate 1 (truthy), vibrance 0 (falsy)", args: [pics[1][1], 0.8, 1, 0] },
        { tag: "saturate \"yes\", vibrance \"\" (truthiness, not numbers)", args: [pics[1][1], 0.8, "yes", ""] });
    twinCheck({ name: "sponge_rgba", title: "sponge_rgba equals inpaint_stroke.js spongeRGBA byte for byte", builds: [[label, px]], twin, call: (k, a) => k.spongeRGBA(...a), cases: sponge });
    const id = luts[0][1], src8 = new Uint8ClampedArray(8);
    const refused = [px.toneRGBA(new Uint8ClampedArray(7), id), px.toneRGBA(new Uint8ClampedArray(0), id), px.toneRGBA(new Int8Array(8), id), px.toneRGBA([1, 2, 3, 4], id),
        px.toneRGBA(src8, id.subarray(0, 255)), px.toneRGBA(src8, new Int8Array(256)), px.toneRGBA(src8, Array.from(id)), px.toneRGBA(src8, null),
        px.spongeRGBA(new Uint8ClampedArray(6), 0.5), px.spongeRGBA(new Uint8ClampedArray(0), 0.5, true), px.spongeRGBA(new Uint16Array(8), 0.5)];
    check(`${label} tone_rgba / sponge_rgba refuse what is not whole pixels of bytes and a table not of 256 bytes (null: the twin runs)`, refused.every((v) => v === null), refused.map((v) => (v === null ? "null" : v.length)).join(", "));
    // a 1000 px brush's box at 1:1 (1002 x 1002): what one dab's filter costs (explains only, section 1.1 rule 5)
    const dab = retouchPixels(1002 * 1002, 1002, "noise"), hl = S.toneLUT("midtones", 0.5, false);
    const med = benchMedians([
        ["tone rust", () => px.toneRGBA(dab, hl, true)], ["tone twin", () => S.toneRGBA(dab, hl, true)],
        ["sponge rust", () => px.spongeRGBA(dab, 0.5, true, true)], ["sponge twin", () => S.spongeRGBA(dab, 0.5, true, true)],
    ], { warm: 1, rounds: 5 });
    console.log(`       a 1002 x 1002 dab: tone (protect) ${label} ${med["tone rust"].toFixed(1)} ms, twin ${med["tone twin"].toFixed(1)}; sponge (saturate, vibrance) ${label} ${med["sponge rust"].toFixed(1)} ms, twin ${med["sponge twin"].toFixed(1)}`);
}

/**
 * Frequency separation's split (freq_split) and the whole separation in one arena (px.js `freqSeparate`: blur_rgba and
 * freq_split) against inpaint_stroke.js (`freqSplit`, and `blurRGBA` then `freqSplit`), byte for byte (K27): every
 * (I, L) pair of bytes, random pictures and blurs of every kind at pixel counts from 1 up, the separation at sizes 1 x 1
 * to a 400 px box with radii 0 to 200 (2.5, NaN and -3 as the twin rounds them); L + 2H - 255 = I wherever the twin says
 * so; the refusals.
 */
async function freqCases(px, label) {
    const S = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_stroke.js")).href);
    const twin = {
        freqSplit: (I, L) => { const high = S.freqSplit(I, L); return { low: L, high }; },
        freqSeparate: (I, w, h, r) => { const low = S.blurRGBA(I, w, h, r); return { low, high: S.freqSplit(I, low) }; },
    };
    const build = { freqSplit: (I, L) => { const high = px.freqSplit(I, L); return high && { low: L, high }; }, freqSeparate: (I, w, h, r) => px.freqSeparate(I, w, h, r) };
    // every pair of values: I = v and L = l in each colour channel (three channels, three offsets of the pair), alphas cycling
    const pairs = 65536, I0 = new Uint8ClampedArray(pairs * 4), L0 = new Uint8ClampedArray(pairs * 4);
    for (let p = 0; p < pairs; p++) {
        const v = p >> 8, l = p & 255;
        for (let c = 0; c < 3; c++) { I0[p * 4 + c] = (v + c * 85) & 255; L0[p * 4 + c] = (l + c * 85) & 255; }
        I0[p * 4 + 3] = (p * 7) & 255; L0[p * 4 + 3] = (p * 13) & 255;
    }
    const split = [{ tag: "every (I, L) pair", args: [I0, L0] }];
    RETOUCH_KINDS.forEach((kind, k) => RETOUCH_SIZES.forEach((n) => {
        const I = retouchPixels(n, n * 17 + k, kind), L = retouchPixels(n, n * 19 + k + 5, k % 2 ? "bright" : kind);
        split.push({ tag: `${kind} ${n} px`, args: [I, L] });
    }));
    twinCheck({ name: "freq_split", title: "freq_split equals inpaint_stroke.js freqSplit byte for byte (L in place and H)", builds: [[label, build]], twin, call: (k, [I, L]) => k.freqSplit(I, L), cases: split });
    // the twin's identity: L + 2H - 255 = I in every colour channel (the separation gives the picture back)
    {
        const L = L0.slice(), H = S.freqSplit(I0, L);
        let bad = -1;
        for (let i = 0; i < I0.length && bad < 0; i++) if ((i & 3) !== 3 && L[i] + 2 * H[i] - 255 !== I0[i]) bad = i;
        check("js freqSplit gives the picture back: L + 2H - 255 = I for every (I, L) pair", bad < 0, bad < 0 ? "" : `at ${bad}`);
    }
    const sep = [];
    for (const [w, h] of [[1, 1], [2, 3], [3, 2], [5, 4], [7, 9], [16, 16], [33, 17], [64, 48], [131, 77]]) {
        for (const kind of ["noise", "edges", "holes", "faint", "bright"]) {
            const I = retouchPixels(w * h, w * 977 + h * 13 + kind.length, kind);
            for (const r of [0, 1, 2, 8, 40, 200]) sep.push({ tag: `${kind} ${w}x${h} r ${r}`, args: [I, w, h, r] });
        }
    }
    const box = retouchPixels(450 * 450, 4501, "noise");
    sep.push({ tag: "a 400 px box 450x450 r 8", args: [box, 450, 450, 8] }, { tag: "the same r 40", args: [box, 450, 450, 40] }, { tag: "r 2.5 (rounded as the twin)", args: [box, 450, 450, 2.5] },
        { tag: "r NaN (no pass)", args: [retouchPixels(63, 3, "edges"), 9, 7, NaN] }, { tag: "r -3", args: [retouchPixels(63, 4, "edges"), 9, 7, -3] });
    twinCheck({ name: "freq_separate", title: "freqSeparate (blur_rgba and freq_split in one arena) equals blurRGBA then freqSplit byte for byte", builds: [[label, build]], twin, call: (k, a) => k.freqSeparate(...a), cases: sep });
    const I8 = new Uint8ClampedArray(16), L8 = new Uint8ClampedArray(16);
    const refused = [px.freqSplit(new Uint8ClampedArray(7), new Uint8ClampedArray(7)), px.freqSplit(I8, new Uint8ClampedArray(12)), px.freqSplit(I8, new Int8Array(16)), px.freqSplit(new Uint8ClampedArray(0), new Uint8ClampedArray(0)),
        px.freqSeparate(I8, 2, 3, 1), px.freqSeparate(I8, 2.5, 2, 1), px.freqSeparate(new Uint8ClampedArray(0), 0, 4, 1), px.freqSeparate(I8, 2, 2, 2 ** 31), px.freqSeparate(new Int8Array(16), 2, 2, 1)];
    const untouched = L8.every((v) => v === 0);
    px.freqSplit(I8, L8.subarray(0, 12));
    check(`${label} freq_split / freqSeparate refuse what is not whole pixels of bytes, a blur of another length, a size that is not the picture's and a radius past 2^30 (null: the twin runs), and leave L as it was`,
        refused.every((v) => v === null) && untouched && L8.every((v) => v === 0), refused.map((v) => (v === null ? "null" : "a result")).join(", "));
    // a 1024 x 1024 separation and its split alone (explains only)
    const big = retouchPixels(1024 * 1024, 1024, "noise"), bl = S.blurRGBA(big, 1024, 1024, 8);
    const med = benchMedians([
        ["split rust", () => px.freqSplit(big, bl.slice())], ["split twin", () => S.freqSplit(big, bl.slice())],
        ["separate rust", () => px.freqSeparate(big, 1024, 1024, 8)], ["separate k26", () => { const L = px.blurRGBA(big, 1024, 1024, 8); S.freqSplit(big, L); }],
    ], { warm: 1, rounds: 3 });
    console.log(`       1024 x 1024: the split ${label} ${med["split rust"].toFixed(1)} ms (with its copies), twin ${med["split twin"].toFixed(1)}; the separation r 8 in one arena ${med["separate rust"].toFixed(1)} ms, K26's way (Rust blur, the twin's split) ${med["separate k26"].toFixed(1)}`);
}

/**
 * kernels.js' wrappers of K27 (toneRGBA, spongeRGBA, freqSplit, freqSeparate): the routes "js" and "rust" give the same
 * bytes, Rust's calls are counted and the twins' never; a refusal and a trap fall back to the twin with the same bytes
 * (a trapped split leaves L for the twin as it was); the separation runs in one call only with both its routes on Rust.
 */
async function retouchRouteCases(js) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u, ...rest) => {   // kernels.js fetches ./px.wasm; Node's fetch reads no file: URL
        const s = String(u && u.href ? u.href : u);
        return s.startsWith("file:") ? new Response(fs.readFileSync(fileURLToPath(s))) : realFetch(u, ...rest);
    };
    let K = null;
    try {
        K = await import(pathToFileURL(path.join(PX_DIR, "kernels.js")).href);
        await K.kernelsReady();
    } finally { globalThis.fetch = realFetch; }
    const S = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_stroke.js")).href);
    const L = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_liquify.js")).href);
    for (const r of ["dabTone", "dabSponge", "freqSplit", "liquifyBlock", "liquifyPreview", "liquifyDab"]) if (!Object.prototype.hasOwnProperty.call(K.ROUTE_KINDS, r)) { check(`kernels.js has the ${r} route`, false); return; }
    const warned = [], realWarn = console.warn;
    console.warn = (...a) => { warned.push(a.map(String).join(" ")); };
    K.setKernels("rust");
    try {
        const w = 97, h = 61, I = retouchPixels(w * h, 9, "noise"), lut = S.toneLUT("shadows", 0.6, false);
        const lNodes = new Int32Array(5 * 5 * 2);
        for (let i = 0; i < lNodes.length; i++) lNodes[i] = (i * 43) - 300;
        const lWant = new Uint8Array(8 * 8 * 4);
        const lWantCount = L.liquifyBlock(I, 16, 16, 0, 0, lNodes, 5, 0, 0, 2, null, lWant, 0, 32, 0, 0, 8, 8);
        const pField = new L.LiquifyField(32, 32, 2);
        pField.dab("push", 14, 14, 12, 0.5, 0.8, [5, -3], null, new Map());
        const pWinSrc = I.subarray(0, 16 * 16 * 4);
        const pWant = new Uint8Array(10 * 9 * 4);
        L.previewBlock({ data: pWinSrc, w: 16, h: 16, x0: 0, y0: 0, L: 1 }, pField, -2.5, 1.25, 1.5, pWant, 10, 9);
        const fDabWantField = pField.copy();
        const fDabWantBox = fDabWantField.dab("swirlcw", 16, 16, 10, 0.4, 0.75, null, null, pField.cells, null);
        const fDabWantNodes = fDabWantField.nodes(0, 0, fDabWantField.ni + 1, fDabWantField.nj + 1);
        const want = {
            tone: S.toneRGBA(I, lut, true), sponge: S.spongeRGBA(I, 0.7, true, true),
            low: S.blurRGBA(I, w, h, 3), blur: null, high: null,
        };
        want.blur = want.low.slice();
        want.high = S.freqSplit(I, want.low);
        const all = () => {
            const low = want.blur.slice(), high = K.freqSplit(I, low), sep = K.freqSeparate(I, w, h, 3);
            const liq = new Uint8Array(8 * 8 * 4);
            const liqCount = K.liquifyBlock(I, 16, 16, 0, 0, lNodes, 5, 0, 0, 2, null, liq, 0, 32, 0, 0, 8, 8);
            const wa = K.allocLiquifyWindow(16, 16);
            wa.data.set(pWinSrc);
            const win = { data: wa.data, w: 16, h: 16, x0: 0, y0: 0, L: 1, px: wa.px, ptr: wa.ptr, bytes: wa.bytes };
            const prev = new Uint8Array(10 * 9 * 4);
            K.liquifyPreview(win, pField, -2.5, 1.25, 1.5, prev, 10, 9);
            const fDab = pField.copy();
            const dabBoxGot = fDab.dab("swirlcw", 16, 16, 10, 0.4, 0.75, null, null, pField.cells, K.liquifyDab);
            const dabSame = JSON.stringify(dabBoxGot) === JSON.stringify(fDabWantBox) && eqBytes(fDab.nodes(0, 0, fDab.ni + 1, fDab.nj + 1), fDabWantNodes);
            const hadPtr = !!win.ptr, px0 = win.px, ptr0 = win.ptr, bytes0 = win.bytes;
            K.freeLiquifyWindow(win);
            K.freeLiquifyWindow(win);
            let reused = true;
            if (hadPtr) {
                const probe = px0.alloc(bytes0);
                px0.free(probe, bytes0);
                reused = probe === ptr0;
            }
            return { tone: K.toneRGBA(I, lut, true), sponge: K.spongeRGBA(I, 0.7, true, true), low, high, sepLow: sep.low, sepHigh: sep.high, liq, liqCount, prev, dabSame, hadPtr, freed: !win.ptr && !win.px && reused };
        };
        const same = (o) => eqBytes(o.tone, want.tone) && eqBytes(o.sponge, want.sponge) && eqBytes(o.low, want.low) && eqBytes(o.high, want.high) && eqBytes(o.sepLow, want.low) && eqBytes(o.sepHigh, want.high) && eqBytes(o.liq, lWant) && o.liqCount === lWantCount && eqBytes(o.prev, pWant) && o.dabSame && o.freed;
        K.pxCalls(true);
        const rust = all(), cr = K.pxCalls(true);
        for (const r of ["dabTone", "dabSponge", "freqSplit", "dabBlur", "liquifyBlock", "liquifyPreview", "liquifyDab"]) K.setRoute(r, "js");
        const twin = all(), cj = K.pxCalls(true);
        for (const r of ["dabTone", "dabSponge", "freqSplit", "dabBlur", "liquifyBlock", "liquifyPreview", "liquifyDab"]) K.setRoute(r, null);
        check("kernels.js toneRGBA / spongeRGBA / freqSplit / freqSeparate / liquifyBlock / liquifyPreview / liquifyDab: the routes rust and js give the twins' bytes; Rust's calls counted, the twins' never",
            same(rust) && rust.hadPtr && same(twin) && !twin.hadPtr && cr.tone_rgba === 1 && cr.sponge_rgba === 1 && cr.freq_split === 2 && cr.blur_rgba === 1 && cr.liquify_block === 1 && cr.liquify_preview === 1 && cr.liquify_dab === 1 && !cj.tone_rgba && !cj.sponge_rgba && !cj.freq_split && !cj.blur_rgba && !cj.liquify_block && !cj.liquify_preview && !cj.liquify_dab,
            `rust ${JSON.stringify(cr)}, js ${JSON.stringify(cj)}`);
        // K29: liquifyPreview runs on win.px (never rustPx(), so an idle drop mid-stroke still uses win.px), and
        // refreshes win.data when the mode or route switches mid-stroke after win.px grew its memory
        {
            const wa = K.allocLiquifyWindow(16, 16);
            wa.data.set(pWinSrc);
            const win = { data: wa.data, w: 16, h: 16, x0: 0, y0: 0, L: 1, px: wa.px, ptr: wa.ptr, bytes: wa.bytes };
            const p0 = win.px;
            K.dropPx("idle");
            const p1 = K.rustPx();
            K.pxCalls(true);
            const outDropped = new Uint8Array(10 * 9 * 4);
            K.liquifyPreview(win, pField, -2.5, 1.25, 1.5, outDropped, 10, 9);
            const cDrop = K.pxCalls(true);
            // detach win.data by growing p0's memory: Rust still reads win.ptr in place and refreshes win.data
            const big0 = p0.alloc(4 * 1024 * 1024);
            p0.free(big0, 4 * 1024 * 1024);
            const detached0 = win.data.byteLength === 0;
            const outGrownRust = new Uint8Array(10 * 9 * 4);
            K.liquifyPreview(win, pField, -2.5, 1.25, 1.5, outGrownRust, 10, 9);
            // detach win.data again by growing p0's memory, then switch to JS mid-stroke
            const big = p0.alloc(8 * 1024 * 1024);
            p0.free(big, 8 * 1024 * 1024);
            const detached = win.data.byteLength === 0;
            K.setRoute("liquifyPreview", "js");
            const outSwitchRoute = new Uint8Array(10 * 9 * 4);
            K.liquifyPreview(win, pField, -2.5, 1.25, 1.5, outSwitchRoute, 10, 9);
            K.setRoute("liquifyPreview", null);
            // detach again and call previewBlock directly
            const big2 = p0.alloc(16 * 1024 * 1024);
            p0.free(big2, 16 * 1024 * 1024);
            const detached2 = win.data.byteLength === 0;
            const outDirectTwin = new Uint8Array(10 * 9 * 4);
            L.previewBlock(win, pField, -2.5, 1.25, 1.5, outDirectTwin, 10, 9);
            K.freeLiquifyWindow(win);
            // K29-L2: allocLiquifyWindow and freeLiquifyWindow reuse the same wasm block without growing memory
            const wFirst = K.allocLiquifyWindow(512, 512);
            const cycPx = wFirst.px, cycPtr = wFirst.ptr, cycBytes0 = cycPx.byteLength;
            K.freeLiquifyWindow(wFirst);
            let cycSame = cycPtr > 0;
            for (let k = 0; k < 8; k++) {
                const wk = K.allocLiquifyWindow(512, 512);
                if (wk.px !== cycPx || wk.ptr !== cycPtr || cycPx.byteLength !== cycBytes0) cycSame = false;
                K.freeLiquifyWindow(wk);
            }
            check("kernels.js K29: liquifyPreview runs on win.px after dropPx, freeLiquifyWindow returns the block to the allocator, and the twin refreshes a detached win.data on a mid-stroke mode switch",
                p0 !== p1 && cDrop.liquify_preview === 1 && eqBytes(outDropped, pWant)
                && detached0 && eqBytes(outGrownRust, pWant)
                && detached && eqBytes(outSwitchRoute, pWant)
                && detached2 && eqBytes(outDirectTwin, pWant)
                && cycSame,
                `cDrop=${JSON.stringify(cDrop)} detached=${detached0},${detached},${detached2} cycSame=${cycSame}`);
        }
        // the separation with one of its routes on the twin: the other half still Rust, the same bytes
        K.setRoute("freqSplit", "js");
        let a = K.freqSeparate(I, w, h, 3), ca = K.pxCalls(true);
        K.setRoute("freqSplit", null); K.setRoute("dabBlur", "js");
        let b = K.freqSeparate(I, w, h, 3), cb = K.pxCalls(true);
        K.setRoute("dabBlur", null);
        check("kernels.js freqSeparate with one route on the twin: the blur or the split alone in Rust, the same bytes",
            eqBytes(a.low, want.low) && eqBytes(a.high, want.high) && eqBytes(b.low, want.low) && eqBytes(b.high, want.high)
            && ca.blur_rgba === 1 && !ca.freq_split && cb.freq_split === 1 && !cb.blur_rgba, `${JSON.stringify(ca)} ${JSON.stringify(cb)}`);
        // refused by Rust: the twin's bytes
        const odd = I.subarray(0, 4 * 7 + 2), short = lut.subarray(0, 200), rlOut = new Uint8Array(8 * 8 * 4), rpOut = new Uint8Array(10 * 9 * 4);
        const rdOut = new Int32Array(3 * 3 * 2), rdBox = new Int32Array(4), rdWantOut = new Int32Array(3 * 3 * 2), rdWantBox = new Int32Array(4);
        const rdWant = L.liquifyDabNodes("push", lNodes, 5, 0, 0, 2, 16, 16, 4, 4, 6, 0.5, 0.8, 1, -1, null, null, 0, 0, 3, 3, rdWantOut, rdWantBox);
        const rt = K.toneRGBA(I, short, true), rs = K.spongeRGBA(odd, 0.7, true), rr = K.freqSeparate(I, w, h - 1, 3);
        const rl = K.liquifyBlock(I, 16, 16, 0, 0, Array.from(lNodes), 5, 0, 0, 2, null, rlOut, 0, 32, 0, 0, 8, 8);
        K.liquifyPreview({ data: pWinSrc, w: 16, h: 16, x0: 0, y0: 0, L: 1, px: {}, ptr: 0 }, pField, -2.5, 1.25, 1.5, rpOut, 10, 9);
        const rd = K.liquifyDab("push", Array.from(lNodes), 5, 0, 0, 2, 16, 16, 4, 4, 6, 0.5, 0.8, 1, -1, null, null, 0, 0, 3, 3, rdOut, rdBox);
        check("kernels.js after a refusal (a short table, a part pixel, a size that is not the picture's, a plain array of nodes, an unheld window): the twin's bytes",
            eqBytes(rt, S.toneRGBA(I, short, true)) && eqBytes(rs, S.spongeRGBA(odd, 0.7, true)) && eqBytes(rlOut, lWant) && rl === lWantCount && eqBytes(rpOut, pWant)
            && rd === rdWant && eqBytes(rdOut, rdWantOut) && eqBytes(rdBox, rdWantBox)
            && (() => { const l = S.blurRGBA(I, w, h - 1, 3); const hh = S.freqSplit(I, l); return eqBytes(rr.low, l) && eqBytes(rr.high, hh); })());
        // a trap in each: the twin's bytes, the instance replaced, the next call Rust again
        const eqFloats = (a, b) => eqBytes(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
        const warpM = [1.02, -0.01, 0.75, 0.015, 0.98, -0.5];
        want.es = js.edgefitShrink(I, w, h, 32, 20);
        want.wr = js.warpRgba(I, w, h, warpM);
        want.wc = js.warpCoverage(w, h, warpM);
        K.setRoute("edgefit", "rust");
        K.setRoute("edgefitShrink", "rust");
        K.setRoute("warpRgba", "rust");
        K.setRoute("warpCoverage", "rust");
        const trapIn2 = (p) => p.exports.mip_half(-16, 256, 256, 0);
        let ok = true, detail = "";
        for (const [name, method, callIt, check1] of [
            ["tone", "toneRGBA", () => K.toneRGBA(I, lut, true), (o) => eqBytes(o, want.tone)],
            ["sponge", "spongeRGBA", () => K.spongeRGBA(I, 0.7, true, true), (o) => eqBytes(o, want.sponge)],
            ["split", "freqSplit", () => { const low = want.blur.slice(); const hh = K.freqSplit(I, low); return { low, hh }; }, (o) => eqBytes(o.low, want.low) && eqBytes(o.hh, want.high)],
            ["separate", "freqSeparate", () => K.freqSeparate(I, w, h, 3), (o) => eqBytes(o.low, want.low) && eqBytes(o.high, want.high)],
            ["liquify", "liquifyBlock", () => { const out = new Uint8Array(8 * 8 * 4); const c = K.liquifyBlock(I, 16, 16, 0, 0, lNodes, 5, 0, 0, 2, null, out, 0, 32, 0, 0, 8, 8); return { out, c }; }, (o) => eqBytes(o.out, lWant) && o.c === lWantCount],
            ["preview", "liquifyPreview", () => {
                const wa = K.allocLiquifyWindow(16, 16);
                wa.data.set(pWinSrc);
                const win = { data: wa.data, w: 16, h: 16, x0: 0, y0: 0, L: 1, px: wa.px, ptr: wa.ptr, bytes: wa.bytes };
                const out = new Uint8Array(10 * 9 * 4);
                K.liquifyPreview(win, pField, -2.5, 1.25, 1.5, out, 10, 9);
                K.freeLiquifyWindow(win);
                return out;
            }, (o) => eqBytes(o, pWant)],
            ["dab", "liquifyDab", () => {
                const f = pField.copy();
                const b = f.dab("swirlcw", 16, 16, 10, 0.4, 0.75, null, null, pField.cells, K.liquifyDab);
                return { f, b };
            }, (o) => JSON.stringify(o.b) === JSON.stringify(fDabWantBox) && eqBytes(o.f.nodes(0, 0, o.f.ni + 1, o.f.nj + 1), fDabWantNodes)],
            ["edgefitShrink", "edgefitShrink", () => K.edgefitShrink(I, w, h, 32, 20), (o) => eqFloats(o.gray, want.es.gray) && eqFloats(o.alpha, want.es.alpha)],
            ["warpRgba", "warpRgba", () => K.warpRgba(I, w, h, warpM), (o) => eqBytes(o, want.wr)],
            ["warpCoverage", "warpCoverage", () => K.warpCoverage(w, h, warpM), (o) => eqFloats(o, want.wc)],
        ]) {
            const p = K.rustPx(), i0 = K.pxInstances();
            // the split traps after its kernel wrote L in wasm memory, before the copy out (the caller's L untouched)
            p[method] = method === "freqSplit"
                ? function (src, low) { const n = src.length, a = this.job; const ps = this._in(a, src, n), pl = this._in(a, low, n), ph = a.take(n); this.exports.freq_split(ps, pl, ph, n); return trapIn2(this); }
                : function () { return trapIn2(this); };
            const got = callIt(), after = K.rustPx(), i1 = K.pxInstances();
            if (!(check1(got) && p.trapped instanceof WebAssembly.RuntimeError && after !== p && i1.trap === i0.trap + 1)) { ok = false; detail = `${name}: ${JSON.stringify(i1)}`; }
        }
        check("kernels.js K27 / K28 / K29 / K31 / K34 wrappers after a trap: the twin's bytes (a split's L as it was before the trap), the instance replaced (trap +1)", ok, detail);
        // the separation releases the instance it grew past releaseMB (here 0, as a 16 MP one grows past 256)
        const i0 = K.pxInstances();
        K.setRoute("releaseMB", 0);
        try { K.freqSeparate(I, w, h, 3); } finally { K.setRoute("releaseMB", null); }
        const i1 = K.pxInstances();
        check("kernels.js freqSeparate releases an instance grown past releaseMB (release +1)", i1.release === i0.release + 1, JSON.stringify(i1));
    } finally {
        console.warn = realWarn;
        kernelsBack(K);
    }
    check("the K27 / K28 / K29 / K31 / K34 wrappers' traps warned once per kernel", warned.filter((w) => /tone_rgba|sponge_rgba|freq_split|freq_separate|liquify_block|liquify_preview|liquify_dab|edgefit_shrink|warp_rgba|warp_coverage/.test(w)).length === 10, warned.join(" | "));
    void js;
}

/** The edge and map kernels (range_max, docs/PLAN_WASM.md #1) against their twin. */
async function edgeCases(px, label, js) {
    const genMap = (w, h, seed) => {
        let s = seed >>> 0;
        const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
        const data = new Uint16Array(w * h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                data[y * w + x] = Math.floor(rnd() * 65536);
            }
        }
        return data;
    };
    // various geometries (tiny, 1D strips, primes, non-multiples of 8, a power of 2) and a sharp step edge
    const cases = [[1, 1], [2, 2], [3, 1], [1, 3], [7, 3], [3, 97], [64, 64], [131, 77], [256, 256], [300, 211]]
        .map(([w, h]) => ({ tag: `range_max ${w}x${h}`, args: [genMap(w, h, w * 131 + h), w, h] }));
    const step = new Uint16Array(64 * 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) step[y * 64 + x] = x < 32 ? 10000 : 50000;
    cases.push({ tag: "step edge", args: [step, 64, 64] });
    twinCheck({ name: "range_max", title: "range_max equals its twin bit for bit", builds: [[label, px]], twin: js, call: (k, [m, w, h]) => k.rangeMax(m, w, h), cases });
    // a constant map has no range anywhere
    const flat = new Uint16Array(64 * 64);
    flat.fill(32768);
    const res = px.rangeMax(flat, 64, 64);
    let nonZero = 0;
    for (let i = 0; i < res.length; i++) if (res[i] !== 0) nonZero++;
    check(`${label} range_max of a flat map is 0 everywhere`, nonZero === 0, nonZero ? `${nonZero} non-zero range values` : "");

    // Benchmark on a 2048 x 2048 map (4 MP)
    const big = genMap(2048, 2048, 42);
    const t0 = performance.now(); px.rangeMax(big, 2048, 2048);
    const t1 = performance.now(); js.rangeMax(big, 2048, 2048);
    const t2 = performance.now();
    console.log(`       2048 x 2048: range_max ${label} ${(t1 - t0).toFixed(1)} ms, twin ${(t2 - t1).toFixed(1)} ms`);
}

/** The relight kernels (height_normals, shadow_march, PLAN_RELIGHT_BUILD.md sec 4.3) against their twin. */
async function relightCases(px, label, js) {
    const genMap = (w, h, seed) => {
        let s = seed >>> 0;
        const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
        const data = new Uint16Array(w * h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                data[y * w + x] = Math.floor(rnd() * 65536);
            }
        }
        return data;
    };
    const maxDiff = (a, b) => {
        if (a.length !== b.length) return { max: 999, firstDiff: `lengths differ: ${a.length} vs ${b.length}` };
        let max = 0, firstDiff = "";
        for (let i = 0; i < a.length; i++) {
            const d = Math.abs(a[i] - b[i]);
            if (d > max) {
                max = d;
                if (!firstDiff) firstDiff = `at ${i}: ${a[i]} vs twin ${b[i]}`;
            }
        }
        return { max, firstDiff };
    };

    let okNormals = true, detailNormals = "";
    for (const [w, h, scale, sigma] of [
        [1, 1, 100, 0],
        [2, 2, 50, 0],
        [7, 3, 200, 1.0],
        [32, 32, 100, 0],
        [64, 64, 50, 2.0],
        [131, 77, 120, 1.5],
        [256, 256, 50, 2.0],
    ]) {
        const m = genMap(w, h, w * 131 + h);
        const rustN = px.heightNormals(m, w, h, scale, sigma);
        const jsN = js.heightNormals(m, w, h, scale, sigma);
        const d = maxDiff(rustN, jsN);
        if (d.max > 1) {
            okNormals = false;
            detailNormals = `${w}x${h} sigma=${sigma} scale=${scale}: maxDiff ${d.max} (${d.firstDiff})`;
            break;
        }
    }
    if (okNormals) {
        const flat = new Uint16Array(64 * 64);
        flat.fill(32768);
        const rustN = px.heightNormals(flat, 64, 64, 100, 0);
        const jsN = js.heightNormals(flat, 64, 64, 100, 0);
        const d = maxDiff(rustN, jsN);
        if (d.max > 0) {
            okNormals = false;
            detailNormals = `flat map: maxDiff ${d.max} (${d.firstDiff})`;
        }
    }
    check(`${label} height_normals equals its twin within 1 level`, okNormals, detailNormals);

    let okShadows = true, detailShadows = "";
    for (const [w, h, light, radius, taps, steps, bias, row0, rows] of [
        [32, 32, [16, 16, 100, 0], 0, 4, 16, 1.0, 0, 32],
        [64, 64, [10, 10, 50, 0], 5, 4, 32, 0.5, 0, 64],
        [64, 64, [-1, 0, 0.5, 1], 2, 4, 16, 1.0, 0, 64],
        [77, 53, [40, 25, 80, 0], 10, 8, 32, 1.0, 10, 20],
        [128, 128, [20, 20, 40, 0], 15, 16, 32, 1.0, 0, 128],
    ]) {
        const m = genMap(w, h, w * 97 + h);
        const bandRows = Math.min(rows, h - row0);
        const rustS = px.shadowMarch(m, w, h, 50, light, radius, taps, steps, bias, row0, bandRows);
        const jsS = js.shadowMarch(m, w, h, 50, light, radius, taps, steps, bias, row0, bandRows);
        const d = maxDiff(rustS, jsS);
        if (d.max > 1) {
            okShadows = false;
            detailShadows = `${w}x${h} lightKind=${light[3]}: maxDiff ${d.max} (${d.firstDiff})`;
            break;
        }
    }
    if (okShadows) {
        const W = 100, H = 20;
        const depth = new Uint16Array(W * H);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                depth[y * W + x] = x < 50 ? 10000 : 50000;
            }
        }
        const light = [60, 10, 100, 0];
        const rustVis = px.shadowMarch(depth, W, H, 50, light, 0, 4, 32, 1.0, 0, H);
        const jsVis = js.shadowMarch(depth, W, H, 50, light, 0, 4, 32, 1.0, 0, H);
        const d = maxDiff(rustVis, jsVis);
        if (d.max > 1) {
            okShadows = false;
            detailShadows = `step edge: maxDiff ${d.max} (${d.firstDiff})`;
        }
    }
    check(`${label} shadow_march equals its twin within 1 level`, okShadows, detailShadows);
}

/** A smooth depth map (0 near, 65535 far): a ground plane receding upwards, three soft objects, slow waves. */
function smoothDepth(w, h) {
    const d = new Uint16Array(w * h), L = Math.max(w, h);
    const bumps = [[0.30, 0.62, 0.16, 0.42], [0.68, 0.55, 0.10, 0.35], [0.52, 0.80, 0.07, 0.25]];   // cx, cy, r, height
    for (let y = 0; y < h; y++) {
        const v = y / Math.max(1, h - 1);
        for (let x = 0; x < w; x++) {
            const u = x / Math.max(1, w - 1);
            let far = 0.92 - 0.55 * v + 0.025 * Math.sin(u * 7.1 + v * 2.3) + 0.02 * Math.cos(v * 5.7 - u * 1.9);
            for (const [cx, cy, r, hgt] of bumps) {
                const dx = (x - cx * w) / (r * L), dy = (y - cy * h) / (r * L);
                far -= hgt * Math.exp(-(dx * dx + dy * dy) * 1.5);
            }
            d[y * w + x] = Math.max(0, Math.min(65535, Math.round(far * 65535)));
        }
    }
    return d;
}

// ---- PX_BENCH rows (docs/PLAN_WASM_BUILD.md §3.4) -----------------------------------------------
// Rows explain, they never decide (the plan's §1.1: Node runs slower than Electron's V8). Every row: each variant
// warmed up, then rounds in an order that rotates by one each round, the median per variant; and a cold first call on
// a fresh compile of px.wasm, because V8 has no on-stack replacement for wasm: a long first call stays in whatever code
// it started in (the baseline tier), which is what the app's first call after a worker starts gets.

const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

/** `fns`: `[[name, fn], ...]`; `warm` calls of each, then `rounds` rounds in a rotating order. The median ms per name. */
function benchMedians(fns, { warm = 2, rounds = 5 } = {}) {
    for (let k = 0; k < warm; k++) for (const [, fn] of fns) fn();
    const t = Object.fromEntries(fns.map(([n]) => [n, []]));
    for (let r = 0; r < rounds; r++) {
        for (let j = 0; j < fns.length; j++) {
            const [n, fn] = fns[(j + r) % fns.length];
            const t0 = performance.now(); fn(); t[n].push(performance.now() - t0);
        }
    }
    return Object.fromEntries(Object.entries(t).map(([n, a]) => [n, median(a)]));
}

let coldSerial = 0;
/**
 * px.wasm's bytes with a custom section of its own appended (ignored by the module; it makes the bytes new, so V8
 * compiles them afresh instead of reusing a module it compiled from the same bytes before).
 */
function freshWasm(bytes) {
    const name = Buffer.from("px_test_cold"), payload = Buffer.from(String(++coldSerial).padStart(8, "0"));
    const body = Buffer.concat([Buffer.from([name.length]), name, payload]);
    return Buffer.concat([bytes, Buffer.from([0, body.length]), body]);   // section id 0; both lengths below 128, one LEB byte each
}

/** A cold first call: px.wasm compiled afresh through `loadPx` (as kernels.js loads it), then `use(px)` once. `{ compile, first }` in ms. */
async function coldCall(loadPx, bytes, use) {
    const t0 = performance.now();
    const px = await loadPx(freshWasm(bytes));
    const t1 = performance.now();
    use(px);
    const t2 = performance.now();
    return { compile: t1 - t0, first: t2 - t1 };
}

const coldText = (c) => `cold first call ${c.first.toFixed(1)} ms (compile ${c.compile.toFixed(1)} ms)`;

/**
 * The relight kernels as the app runs them (docs/PERFORMANCE.md section 15.2): kernels.js, which loads px.wasm as a
 * pool worker does, against the JS twin and the SIMD build called directly, on a smooth depth map with
 * ensureRelightMaps' parameters (depth_scale 50, diffusion 30; the drag's quarter map with 1 tap and 16 steps). Each
 * call warmed up twice, then five rounds in a rotating order, medians (`benchMedians`), and the SIMD build's cold first
 * call (`coldCall`). Always checks the routing: point and spot (a spot goes as kind 0) run the twin, sun (kind 1) the
 * Rust build, byte for byte. The times only with `PX_BENCH=1` (1024 x 1024 and the quick 1024 x 682) or
 * `PX_BENCH=large` (also 2048 x 1365 and 4096 x 2731, the map of a 3:2 picture with a long side of 4096 or more,
 * WORK_MAX); without it the check runs once on a 512 x 341 map.
 */
async function relightBench(js, simd) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u, ...rest) => {   // kernels.js fetches ./px.wasm; Node's fetch reads no file: URL
        const s = String(u && u.href ? u.href : u);
        return s.startsWith("file:") ? new Response(fs.readFileSync(fileURLToPath(s))) : realFetch(u, ...rest);
    };
    let K = null, routed = null;
    try {
        K = await import(pathToFileURL(path.join(PX_DIR, "kernels.js")).href);
        routed = await K.kernelsReady();
    } finally { globalThis.fetch = realFetch; }
    check("kernels.js loads px.wasm (SIMD) as in a worker", !!routed && K.kernelsInUse() === "rust" && routed.simd === true);
    if (!routed) return;
    const { lightToMap, defaultLight } = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_relight.js")).href);
    let rustCalls = 0;
    const march = routed.shadowMarch;
    routed.shadowMarch = function (...a) { rustCalls++; return march.apply(this, a); };
    const { loadPx } = await import(pathToFileURL(path.join(PX_DIR, "px.js")).href);
    const wasmBytes = fs.readFileSync(path.join(PX_DIR, "px.wasm"));
    const bench = !!process.env.PX_BENCH;
    const sizes = bench ? [[1024, 1024, false], [1024, 682, true]] : [[512, 341, false]];
    if (process.env.PX_BENCH === "large") sizes.push([2048, 1365, false], [4096, 2731, false]);
    let ok = true, detail = "";
    for (const [w, h, quick] of sizes) {
        const depth = smoothDepth(w, h), map = { data: depth, w, h };
        const long = Math.max(w, h), scale = 0.5 * long, radius = 0.3 * 0.05 * long, bias = 0.005 * scale;
        const taps = quick ? 1 : 4, steps = quick ? 16 : 32, tag = `${w} x ${h}${quick ? " quick" : ""}`;
        if (bench && !quick) {
            const cold = await coldCall(loadPx, wasmBytes, (p) => p.heightNormals(depth, w, h, scale, 2.0));
            const m = benchMedians([["routed", () => K.heightNormals(depth, w, h, scale, 2.0)], ["twin", () => js.heightNormals(depth, w, h, scale, 2.0)]]);
            console.log(`       ${tag}: height_normals routed (rust) ${m.routed.toFixed(1)} ms, twin ${m.twin.toFixed(1)} ms; simd ${coldText(cold)}`);
        }
        for (const [name, fx, fy, dist] of [["point", 0.30, 0.35, -30], ["spot", 0.65, 0.12, -60], ["sun", 0.15, 0.20, -30]]) {
            const lm = lightToMap({ ...defaultLight(0, { width: w, height: h }), type: name, x: fx * w, y: fy * h, dist }, map, { depth_scale: 50 });
            const light = [lm.mx, lm.my, lm.mz, name === "sun" ? 1 : 0];   // ensureRelightMaps' lightVec
            const run = {
                routed: () => K.shadowMarch(depth, w, h, scale, light, radius, taps, steps, bias, 0, h),
                twin: () => js.shadowMarch(depth, w, h, scale, light, radius, taps, steps, bias, 0, h),
                simd: () => simd.shadowMarch(depth, w, h, scale, light, radius, taps, steps, bias, 0, h),
            };
            const c0 = rustCalls;
            const out = run.routed();
            const ran = rustCalls > c0 ? "rust" : "twin", want = name === "sun" ? "rust" : "twin";
            if (ran !== want || !eqBytes(out, want === "rust" ? run.simd() : run.twin())) {
                ok = false; detail += `${detail ? "; " : ""}${tag} ${name}: ran ${ran}${ran === want ? ", other bytes" : ""}`;
            }
            if (!bench) continue;
            const cold = await coldCall(loadPx, wasmBytes, (p) => p.shadowMarch(depth, w, h, scale, light, radius, taps, steps, bias, 0, h));
            const m = benchMedians(Object.entries(run));
            console.log(`       ${tag} (${taps} taps, ${steps} steps): shadow_march ${name} routed (${ran}) ${m.routed.toFixed(1)} ms, twin ${m.twin.toFixed(1)} ms, simd ${m.simd.toFixed(1)} ms (twin / simd ${(m.twin / m.simd).toFixed(2)}); simd ${coldText(cold)}`);
        }
    }
    routed.shadowMarch = march;
    K.setKernels("js");   // kernels.js stays loaded for the process: the later cases (jobCases) compare against the editor's JS
    check("shadow_march as routed: kind 0 (a point; ensureRelightMaps sends a spot as kind 0) runs the twin, kind 1 (a sun) the Rust build (byte for byte)", ok, detail);
    check("kernels.js back on the JS kernels for the later cases", K.kernelsInUse() === "js");
}

/**
 * K12 (docs/PLAN_WASM_BUILD.md §4.5): relight's march in stripes. S stripes into one shared `out` give the bytes of one
 * call, for the twin (point and spot go as kind 0) and the Rust sun on both builds and through kernels.js as a worker
 * routes it, at 512 x 341 and 1024 x 682 with taps 1 / 3 / 4 / 16 and steps 1 / 16 / 32 / 64, a light on a pixel, below
 * the surface and off the map, the sun straight up and grazing. The Rust sun's stripes copy the depth map once (the
 * one-slot resident copy, keyed), a new key or another size copies it again and never answers from the old copy.
 * `stripePlan`. And `marchOnPool` on a real WorkerPool whose workers answer as inpaint_worker.js does (from the twin): the
 * same bytes, no transfer and the rows back; a depth map that is not on a SharedArrayBuffer (the node's page) or the
 * route 0 go as one job; a failed stripe or a reply with other rows rejects the march and cancels the rest of its group;
 * a group cancelled from outside (a superseded march) rejects with a CancelledError, sends none of its queued stripes
 * and leaves another march's group alone.
 */
async function relightStripeCases(js, simd, scalar) {
    const RL = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_relight.js")).href);
    const P = await import(pathToFileURL(path.join(PX_DIR, "px.js")).href);
    const K = await import(pathToFileURL(path.join(PX_DIR, "kernels.js")).href);   // loaded by relightBench already
    const { lightToMap, defaultLight, stripePlan, marchOnPool } = RL;
    if (typeof stripePlan !== "function" || typeof marchOnPool !== "function") {
        check("inpaint_relight.js exports stripePlan and marchOnPool (K12)", false);
        return;
    }
    let ok = true, detail = "";
    for (const h of [1, 7, 31, 32, 33, 63, 64, 65, 100, 341, 682, 2731]) {
        for (const n of [0, 1, 2, 3, 7, 24, 32, 1000]) {
            const plan = stripePlan(h, n);
            let at = 0, bad = "";
            for (const [r0, rows] of plan) {
                if (r0 !== at || !(rows >= 1)) bad = bad || "a gap or an empty stripe";
                if (plan.length > 1 && rows < 32) bad = bad || "a stripe under 32 rows";
                at = r0 + rows;
            }
            if (at !== h) bad = bad || `covers ${at} of ${h} rows`;
            if (plan.length > Math.max(1, n)) bad = bad || `${plan.length} stripes for ${n}`;
            if (h >= 64 && n >= 2 && plan.length < 2) bad = bad || "not split";
            if (bad) { ok = false; detail = `h ${h}, ${n} asked: ${bad} ${JSON.stringify(plan).slice(0, 120)}`; break; }
        }
        if (!ok) break;
    }
    check("stripePlan covers every row once and in order, in stripes of 32 rows or more, never more than asked", ok, detail);

    // S stripes into one shared out against one call of the same kernel
    const striped = (impl, depth, w, h, a, S, key) => {
        const out = new Uint8Array(new SharedArrayBuffer(w * h));
        for (const [r0, rows] of stripePlan(h, S)) impl.shadowMarch(depth, w, h, a.scale, a.light, a.radius, a.taps, a.steps, a.bias, r0, rows, out, key);
        return out;
    };
    const one = (impl, depth, w, h, a) => impl.shadowMarch(depth, w, h, a.scale, a.light, a.radius, a.taps, a.steps, a.bias, 0, h);
    ok = true; detail = "";
    let cases = 0;
    K.setKernels("rust");   // a worker's mode: the sun on Rust (relightBench left the twins in force)
    for (const [w, h, combos, counts] of [
        [512, 341, [[1, 16], [3, 1], [4, 32], [16, 64], [4, 64], [1, 1]], [2, 7, 10]],
        [1024, 682, [[1, 16], [4, 32]], [5, 21]],
    ]) {
        const sab = new Uint16Array(new SharedArrayBuffer(w * h * 2));
        sab.set(smoothDepth(w, h));
        const map = { data: sab, w, h }, long = Math.max(w, h), scale = 0.5 * long;
        const lights = [];
        for (const [type, fx, fy, dist] of [["point", 0.30, 0.35, -30], ["spot", 0.65, 0.12, -60], ["sun", 0.15, 0.20, -30]]) {
            const lm = lightToMap({ ...defaultLight(0, { width: w, height: h }), type, x: fx * w, y: fy * h, dist }, map, { depth_scale: 50 });
            lights.push([type, [lm.mx, lm.my, lm.mz, type === "sun" ? 1 : 0]]);
        }
        lights.push(["a point on a pixel", [Math.floor(w / 3), Math.floor(h / 2), scale * 0.6, 0]]);
        lights.push(["a point below the surface", [w * 0.5, h * 0.5, scale * 0.05, 0]]);
        lights.push(["a point off the map", [-0.4 * w, 1.3 * h, scale * 0.8, 0]]);
        lights.push(["the sun straight up", [0, 0, 1, 1]]);
        lights.push(["the sun grazing", [1, 0.25, 0.02, 1]]);
        for (const [taps, steps] of combos) {
            for (const [name, light] of lights) {
                const a = { scale, light, radius: 0.3 * 0.05 * long, taps, steps, bias: 0.005 * scale };
                const impls = light[3] === 1 ? [["rust simd", simd, "k:sun"], ["rust scalar", scalar, "k:sun"], ["kernels.js (a worker's route)", K, "k:sun"]] : [["twin", js, null]];
                for (const [iname, impl, key] of impls) {
                    const want = one(iname.startsWith("kernels") ? simd : impl, sab, w, h, a);
                    for (const S of counts) {
                        cases++;
                        const got = striped(impl, sab, w, h, a, S, key ? `${key}:${w}x${h}` : null);
                        if (!eqBytes(got, want)) { ok = false; detail += `${detail ? "; " : ""}${w} x ${h} ${name} ${iname} taps ${taps} steps ${steps} in ${S}`; }
                    }
                }
            }
        }
    }
    K.setKernels("js");
    check(`shadow_march in stripes into one shared out equals one call: the twin (point, spot) and the Rust sun on both builds and through kernels.js (${cases} cases)`, ok, detail);

    // the one-slot resident depth copy, on an instance of its own: a key copies the map once over all stripes
    {
        const w = 512, h = 341, n = w * h;
        const fresh = new P.Px(new WebAssembly.Instance(simd.module, {}), simd.module);
        const d1 = smoothDepth(w, h), d2 = d1.map((v, i) => (i % 7 === 0 ? 65535 - v : v)), small = smoothDepth(256, 170);
        const a = { scale: 256, light: [0.3, -0.2, 0.9, 1], radius: 7.7, taps: 4, steps: 32, bias: 1.28 };
        const mb = (f) => { P.pxTimed(true); P.pxCalls(true); try { f(); return P.pxLaps().copyInMB; } finally { P.pxTimed(false); } };
        const depthMB = (n * 2) / 1048576;
        let r1, r2, r3, r4;
        const keyed = mb(() => { r1 = striped(fresh, d1, w, h, a, 8, "map:1"); });
        const again = mb(() => { r2 = striped(fresh, d1, w, h, a, 8, "map:1"); });
        const plain = mb(() => { r3 = striped(fresh, d1, w, h, a, 8, null); });
        const next = mb(() => { r4 = striped(fresh, d2, w, h, a, 8, "map:2"); });
        const want1 = one(simd, d1, w, h, a), want2 = one(simd, d2, w, h, a);
        const r5 = striped(fresh, small, 256, 170, a, 4, "map:2");   // the same key on another size: copied again
        const want5 = one(simd, small, 256, 170, a);
        check("the Rust sun's stripes with a key copy the depth map once (8 stripes), again none, without a key once a stripe",
            keyed < 1.5 * depthMB && again < 0.01 && plain > 7.5 * depthMB, `${keyed.toFixed(2)} / ${again.toFixed(2)} / ${plain.toFixed(2)} MB, the map ${depthMB.toFixed(2)} MB`);
        check("a new key copies the new map and never answers from the old one; a key on another size copies again",
            eqBytes(r1, want1) && eqBytes(r2, want1) && eqBytes(r3, want1) && eqBytes(r4, want2) && !eqBytes(want1, want2) && next > 0.9 * depthMB && eqBytes(r5, want5));
    }

    // marchOnPool on a real WorkerPool: workers that answer relight_shadow as inpaint_worker.js does, a tick later
    const { WorkerPool, CancelledError } = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_pool.js")).href);
    const sent = [];
    const answer = (msg, w, fail) => {
        try {
            const { depth, w: mw, h: mh, scale, light, radius, taps, steps, bias, row0, rows, out } = msg;
            if (fail && fail(msg)) throw new Error("stripe failed on purpose");
            if (out) {
                js.shadowMarch(depth, mw, mh, scale, light, radius, taps, steps, bias, row0, rows, out);
                const back = msg.tag === "badrows" && row0 > 0 ? rows + 1 : Math.min(rows, mh - row0);
                return { id: msg.id, ok: true, row0, rows: back };
            }
            const vis = js.shadowMarch(depth, mw, mh, scale, light, radius, taps, steps, bias, row0, rows);
            return { id: msg.id, ok: true, vis: vis.buffer, row0, rows };
        } catch (err) { return { id: msg.id, ok: false, error: String((err && err.message) || err) }; }
    };
    const poolOf = (size, fail = null) => new WorkerPool({
        size,
        create: () => {
            const wk = { onmessage: null, onerror: null, terminate() {} };
            wk.postMessage = (msg, transfer) => {
                sent.push({ msg, transfer: transfer || [] });
                setTimeout(() => wk.onmessage({ data: answer(msg, wk, fail) }), 1);
            };
            return wk;
        },
    });
    const w = 160, h = 330, plain16 = smoothDepth(w, h), shared16 = new Uint16Array(new SharedArrayBuffer(w * h * 2));
    shared16.set(plain16);
    const args = (depth, tag) => ({ depth, w, h, scale: 80, light: [40, 30, 50, 0], radius: 2.4, taps: 4, steps: 32, bias: 0.4, key: null, tag });
    const want = js.shadowMarch(plain16, w, h, 80, [40, 30, 50, 0], 2.4, 4, 32, 0.4, 0, h);
    const of = (tag) => sent.filter((s) => s.msg.tag === tag);
    {
        const pool = poolOf(3);
        const got = await marchOnPool(pool, args(shared16, "s"), { priority: 1, group: "g:s", stripes: 8 });
        const s = of("s"), plan = stripePlan(h, 8);
        check("marchOnPool on a SharedArrayBuffer: the stripes of stripePlan, one shared out, no transfer, the bytes of one call",
            eqBytes(got, want) && s.length === plan.length && plan.length > 1 && s.every((x, i) => x.msg.out && x.msg.out.buffer === s[0].msg.out.buffer
                && x.msg.out.buffer instanceof SharedArrayBuffer && x.transfer.length === 0 && x.msg.row0 === plan[i][0] && x.msg.rows === plan[i][1]) && got.buffer === s[0].msg.out.buffer,
            `${s.length} jobs for ${plan.length} stripes`);
        const one1 = await marchOnPool(pool, args(plain16, "plain"), { priority: 1, group: "g:p", stripes: 8 });
        const one0 = await marchOnPool(pool, args(shared16, "zero"), { priority: 1, group: "g:z", stripes: 0 });
        const p = of("plain"), z = of("zero");
        check("marchOnPool without a SharedArrayBuffer (the node's page) and on the route 0: one job a light, rows 0..h, the reply's own buffer",
            eqBytes(one1, want) && eqBytes(one0, want) && p.length === 1 && z.length === 1 && !p[0].msg.out && !z[0].msg.out
                && p[0].msg.row0 === 0 && p[0].msg.rows === h, `${p.length} / ${z.length} jobs`);
        pool.terminate();
    }
    {
        const plan = stripePlan(h, 8);
        const pool = poolOf(2, (msg) => msg.tag === "fail" && msg.row0 === plan[1][0]);
        const c0 = pool.stats().cancelled;
        let err = null;
        try { await marchOnPool(pool, args(shared16, "fail"), { priority: 1, group: "g:f", stripes: 8 }); } catch (e) { err = e; }
        await new Promise((r) => setTimeout(r, 20));
        check("a failed stripe rejects its march with the stripe's error and cancels the rest of its group",
            !!err && !err.cancelled && /on purpose/.test(err.message) && pool.stats().cancelled > c0 && of("fail").length < plan.length && pool.pending === 0,
            `${err && err.message}; ${of("fail").length} of ${plan.length} sent, ${pool.stats().cancelled - c0} cancelled`);
        let bad = null;
        try { await marchOnPool(pool, args(shared16, "badrows"), { priority: 1, group: "g:b", stripes: 4 }); } catch (e) { bad = e; }
        check("a stripe's reply with other rows than it was sent rejects the march", !!bad && /rows/.test(bad.message), bad && bad.message);
        pool.terminate();
    }
    {
        const pool = poolOf(2);
        const A = marchOnPool(pool, args(shared16, "A"), { priority: 1, group: "g:A", stripes: 4 });
        const B = marchOnPool(pool, args(shared16, "B"), { priority: 1, group: "g:B", stripes: 4 });
        const sentA = of("A").length;   // the pool's two workers took A's first two stripes at once
        const n = pool.cancel("g:A");   // superseded: what ensureRelightMaps does for a newer full march of the channel
        let errA = null;
        try { await A; } catch (e) { errA = e; }
        const gotB = await B;
        check("a cancelled march rejects with a CancelledError, sends none of its queued stripes, and another group's march lands whole",
            errA instanceof CancelledError && errA.cancelled === true && of("A").length === sentA && sentA < 4 && n === 4 && eqBytes(gotB, want) && of("B").length === 4,
            `${errA && errA.name}; A sent ${of("A").length} (${sentA} before the cancel), ${n} cancelled, B ${of("B").length}`);
        pool.terminate();
    }
    await feedCases({ RL, WorkerPool, CancelledError, sent, answer, args, shared16, want, of, h });
}

/**
 * K12b (docs/PLAN_WASM_BUILD.md section 7 "Stop 5"): the full marches' feed. `marchOnPool` with a budget keeps at most that many
 * stripes of all fed marches posted at once (counted by the fake workers: messages sent and not answered), first come first
 * served across the marches, the bytes of one call each; another NORMAL job posted behind two fed marches is sent as soon as
 * the first stripe answers (without the feed after every stripe); each stripe carries its march's fields of the march's start;
 * `cancelMarch` drops a march's stripes not posted yet and cancels its posted ones (a CancelledError, another march lands
 * whole, nothing left in the feed); a march waiting whole in the feed is cancelled without a stripe sent; a failed stripe
 * rejects its march, whose stripes not posted yet are never sent; the quick path (budget 0) posts every stripe at once; a pool
 * terminated with a march waiting in the feed rejects both marches and starts no worker after the terminate.
 */
async function feedCases({ RL, WorkerPool, CancelledError, sent, answer, args, shared16, want, of, h }) {
    const { marchOnPool, cancelMarch, marchFeedStats, stripePlan } = RL;
    if (typeof cancelMarch !== "function" || typeof marchFeedStats !== "function") {
        check("inpaint_relight.js exports cancelMarch and marchFeedStats (K12b)", false);
        return;
    }
    // fake workers as relightStripeCases', counting the messages in flight (sent, not answered), with a gen per defaults()
    let inflight = 0, peak = 0, gen = 0;
    const order = [];   // [tag or op] in the order the workers took them
    const poolOf = (size, fail = null) => new WorkerPool({
        size,
        defaults: () => ({ gen: ++gen }),
        create: () => {
            const wk = { onmessage: null, onerror: null, terminate() {} };
            wk.postMessage = (msg, transfer) => {
                sent.push({ msg, transfer: transfer || [] });
                order.push(msg.op === "relight_shadow" ? msg.tag : msg.op);
                if (msg.op === "relight_shadow") { inflight++; if (inflight > peak) peak = inflight; }
                setTimeout(() => {
                    if (msg.op === "relight_shadow") inflight--;
                    wk.onmessage({ data: msg.op === "relight_shadow" ? answer(msg, wk, fail) : { id: msg.id, ok: true } });
                }, 1);
            };
            return wk;
        },
    });
    const S = 8, planS = stripePlan(h, S);
    {
        const pool = poolOf(3);
        inflight = 0; peak = 0; order.length = 0;
        const A = marchOnPool(pool, args(shared16, "fA"), { priority: 1, group: "f:A", stripes: S, budget: 3 });
        const B = marchOnPool(pool, args(shared16, "fB"), { priority: 1, group: "f:B", stripes: S, budget: 3 });
        const taken = order.length;   // the stripes the three workers took at once
        const N = pool.run("noop", {}, [], { priority: 1 });
        const [gotA, gotB] = await Promise.all([A, B]);
        await N;
        const st = marchFeedStats(pool);
        const firstB = order.indexOf("fB"), lastA = order.lastIndexOf("fA");
        check("the feed: at most the budget of stripes of two marches posted at once, first come first served, the bytes of one call each",
            eqBytes(gotA, want) && eqBytes(gotB, want) && peak === 3 && taken === 3 && st.peak === 3 && of("fA").length === planS.length
                && of("fB").length === planS.length && firstB > lastA && st.flying === 0 && st.waiting === 0 && st.marches === 0,
            `peak ${peak} (feed ${st.peak}), ${taken} at once, A ${of("fA").length} B ${of("fB").length} of ${planS.length}; order ${order.join(",")}`);
        check("the feed: a NORMAL job posted behind two fed marches goes as soon as the first stripe answers",
            order.indexOf("noop") === taken, `noop sent ${order.indexOf("noop")}th of ${order.length}`);
        const gens = (tag) => new Set(of(tag).map((x) => x.msg.gen));
        check("the feed: every stripe of a march carries the fields of the march's start (one gen a march, two marches two)",
            gens("fA").size === 1 && gens("fB").size === 1 && [...gens("fA")][0] !== [...gens("fB")][0], `${[...gens("fA")]} / ${[...gens("fB")]}`);
        // without the feed (budget 0, K12's way and the quick marches') every stripe is posted at once: the job goes last
        order.length = 0;
        const A0 = marchOnPool(pool, args(shared16, "fA0"), { priority: 1, group: "f:A0", stripes: S });
        const B0 = marchOnPool(pool, args(shared16, "fB0"), { priority: 1, group: "f:B0", stripes: S });
        const N0 = pool.run("noop", {}, [], { priority: 1 });
        await Promise.all([A0, B0, N0]);
        check("without a budget every stripe is posted at once: a NORMAL job posted after them goes after all of them",
            order.indexOf("noop") === 2 * planS.length, `noop sent ${order.indexOf("noop")}th of ${order.length}`);
        // the window's budget, the pool's size + 1: one stripe stays queued, so a worker that frees takes it before EXPORT
        // work (the classes keep their order) and a NORMAL job waits for two stripes; with the size alone the EXPORT job
        // would take the first worker that frees
        order.length = 0;
        const E1 = marchOnPool(pool, args(shared16, "eA"), { priority: 1, group: "e:A", stripes: S, budget: 4 });
        const X1 = pool.run("export", {}, [], { priority: 2 });
        const N1 = pool.run("normal", {}, [], { priority: 1 });
        await Promise.all([E1, X1, N1]);
        const exportAt = order.indexOf("export"), normalAt = order.indexOf("normal");
        order.length = 0;
        const E2 = marchOnPool(pool, args(shared16, "eB"), { priority: 1, group: "e:B", stripes: S, budget: 3 });
        const X2 = pool.run("export", {}, [], { priority: 2 });
        await Promise.all([E2, X2]);
        check("with the pool's size + 1 an EXPORT job behind a fed march goes after all its stripes and a NORMAL job after two; with the size alone the EXPORT job goes first",
            exportAt === planS.length + 1 && normalAt === 4 && order.indexOf("export") === 3, `export ${exportAt}th, normal ${normalAt}th; with the size ${order.indexOf("export")}th`);
        pool.terminate();
    }
    {
        // a superseded march: cancelMarch drops its stripes in the feed and cancels its posted ones; another march lands whole
        const pool = poolOf(3);
        order.length = 0;
        const d0 = marchFeedStats(pool).dropped, c0 = pool.stats().cancelled;
        const A = marchOnPool(pool, args(shared16, "cA"), { priority: 1, group: "c:A", stripes: S, budget: 3 });
        const B = marchOnPool(pool, args(shared16, "cB"), { priority: 1, group: "c:B", stripes: S, budget: 3 });
        const sentA = of("cA").length;
        const n = cancelMarch(pool, "c:A");
        let errA = null;
        try { await A; } catch (e) { errA = e; }
        const gotB = await B;
        const st = marchFeedStats(pool);
        check("cancelMarch: the march rejects with a CancelledError, sends no stripe after the cancel, every stripe counted once, another march lands whole",
            errA instanceof CancelledError && errA.cancelled === true && sentA === 3 && of("cA").length === sentA && n === planS.length
                && st.dropped - d0 + (pool.stats().cancelled - c0) === planS.length && eqBytes(gotB, want) && of("cB").length === planS.length
                && st.flying === 0 && st.waiting === 0 && pool.pending === 0,
            `${errA && errA.name}; A sent ${of("cA").length} (${sentA} before), ${n} cancelled (feed ${st.dropped - d0}, pool ${pool.stats().cancelled - c0}), B ${of("cB").length}`);
        // a march waiting whole in the feed: cancelled without a stripe sent; the march before it lands whole
        order.length = 0;
        const C = marchOnPool(pool, args(shared16, "wC"), { priority: 1, group: "w:C", stripes: S, budget: 3 });
        const D = marchOnPool(pool, args(shared16, "wD"), { priority: 1, group: "w:D", stripes: S, budget: 3 });
        const nD = cancelMarch(pool, "w:D");
        let errD = null;
        try { await D; } catch (e) { errD = e; }
        const gotC = await C;
        check("cancelMarch on a march still waiting whole in the feed: none of its stripes sent, the march before lands whole",
            errD instanceof CancelledError && of("wD").length === 0 && nD === planS.length && eqBytes(gotC, want) && marchFeedStats(pool).waiting === 0,
            `${errD && errD.name}; D sent ${of("wD").length}, ${nD} cancelled`);
        pool.terminate();
    }
    {
        // a failed stripe of a fed march: the march rejects with its error, its stripes in the feed are never sent
        const pool = poolOf(2, (msg) => msg.tag === "xF" && msg.row0 === planS[1][0]);
        const F = marchOnPool(pool, args(shared16, "xF"), { priority: 1, group: "x:F", stripes: S, budget: 2 });
        const G = marchOnPool(pool, args(shared16, "xG"), { priority: 1, group: "x:G", stripes: S, budget: 2 });
        let errF = null;
        try { await F; } catch (e) { errF = e; }
        const gotG = await G;
        await new Promise((r) => setTimeout(r, 20));
        check("a failed stripe of a fed march rejects it with the stripe's error, its stripes in the feed never sent, the next march lands whole",
            !!errF && !errF.cancelled && /on purpose/.test(errF.message) && of("xF").length <= 3 && eqBytes(gotG, want) && pool.pending === 0 && marchFeedStats(pool).flying === 0,
            `${errF && errF.message}; F sent ${of("xF").length} of ${planS.length}, G ${of("xG").length}`);
        pool.terminate();
    }
    {
        // a pool terminated while a march waits whole in the feed (inpaint_jobs.js resetPool, a harness's fresh pool): both
        // marches reject, the waiting one sends nothing, and no worker is started after the terminate (the feed used to
        // post the waiting march's stripes, which started new workers on the terminated pool)
        const pool = poolOf(2);
        const A = marchOnPool(pool, args(shared16, "tA"), { priority: 1, group: "t:A", stripes: S, budget: 3 });
        const B = marchOnPool(pool, args(shared16, "tB"), { priority: 1, group: "t:B", stripes: S, budget: 3 });
        const waiting = marchFeedStats(pool).waiting, sentA = of("tA").length;
        pool.terminate();
        const started = pool.stats().started;
        const [rA, rB] = await Promise.allSettled([A, B]);
        await new Promise((r) => setTimeout(r, 20));
        const st = marchFeedStats(pool);
        const later = marchOnPool(pool, args(shared16, "tC"), { priority: 1, group: "t:C", stripes: S, budget: 3 }).then(() => "resolved", (e) => e.message);
        const rC = await later;
        check("a pool terminated with a march waiting whole in the feed: both reject, the waiting one sends nothing, no worker starts after it, a later march rejects at once",
            rA.status === "rejected" && rB.status === "rejected" && /terminated/.test(String(rB.reason && rB.reason.message)) && waiting === 2 * planS.length - 3
                && sentA === 2 && of("tA").length === sentA && of("tB").length === 0 && of("tC").length === 0 && pool.stats().started === started
                && pool.stats().workers === 0 && st.waiting === 0 && st.flying === 0 && marchFeedStats(pool).marches === 0 && /terminated/.test(rC),
            `A ${rA.status}, B ${rB.status} (${rB.reason && rB.reason.message}); waiting ${waiting}; sent A ${of("tA").length} B ${of("tB").length} C ${of("tC").length}; `
                + `workers started after ${pool.stats().started - started}, now ${pool.stats().workers}; later: ${rC}`);
    }
}

/**
 * The call counters of px.js (docs/PLAN_WASM_BUILD.md §3.4): a kernel call counts under its export name and nothing
 * else does, the counts go on across a new instance of the same module (kernels.js `releaseIfLarge`, here made to
 * happen for real), the instance's own exports (`px.raw`) are not counted, and a reset clears them.
 */
async function counterCases(simd) {
    const P = await import(pathToFileURL(path.join(PX_DIR, "px.js")).href);
    const K = await import(pathToFileURL(path.join(PX_DIR, "kernels.js")).href);   // loaded by relightBench already
    check("kernels.js re-exports px.js' pxCalls (one set of counters per thread)", K.pxCalls === P.pxCalls);
    const m = new Float32Array(64 * 64).fill(0.5), u = new Uint16Array(64 * 64);
    P.pxCalls(true);
    simd.dilateMask(m, 64, 64, 2);
    simd.dilateMask(m, 64, 64, 2);
    simd.rangeMax(u, 64, 64);
    let c = P.pxCalls();
    check("pxCalls counts each kernel call by its export name, and not the allocator, version or size helpers",
        c.dilate_mask === 2 && c.range_max === 1 && Object.keys(c).length === 2, JSON.stringify(c));
    const fresh = new P.Px(new WebAssembly.Instance(simd.module, {}), simd.module);   // what releaseIfLarge makes
    fresh.dilateMask(m, 64, 64, 2);
    const ps = fresh.alloc(64 * 64 * 2), po = fresh.alloc(64 * 64 * 2);
    fresh.raw.range_max(ps, 64, 64, po);   // the instance's own export: not counted
    c = P.pxCalls();
    check("the counts go on across a new instance of the same module; px.raw calls are not counted",
        c.dilate_mask === 3 && c.range_max === 1 && fresh.raw === fresh.instance.exports && fresh.exports !== fresh.raw, JSON.stringify(c));
    const was = P.pxCalls(true), after = P.pxCalls();
    check("pxCalls(true) returns the counts and clears them", was.dilate_mask === 3 && Object.keys(after).length === 0, `${JSON.stringify(was)} then ${JSON.stringify(after)}`);
    // kernels.js for real: its instance grown past RELEASE_BYTES (256 MB), released after the next call, the count goes on
    K.setKernels("rust");
    const before = K.rustPx();
    if (!before) {
        check("kernels.js has its Rust instance for the release check", false);
    } else {
        K.dilateMask(m, 64, 64, 2);
        before.alloc(300 * 1048576);   // grows the memory without a kernel call
        K.dilateMask(m, 64, 64, 2);    // releaseIfLarge after this call replaces the instance
        const now = K.rustPx();
        K.dilateMask(m, 64, 64, 2);
        c = K.pxCalls(true);
        check("kernels.js releaseIfLarge replaces a grown instance and the count goes on (3 calls over two instances)",
            !!now && now !== before && now.byteLength < 256 * 1048576 && c.dilate_mask === 3 && Object.keys(c).length === 1,
            `${JSON.stringify(c)}, ${now === before ? "the same instance" : "a new instance"} of ${now ? now.byteLength : 0} bytes`);
    }
    K.setKernels("js");   // as relightBench left it: the later cases compare against the editor's JS
}

// ---- K1: the split, the routes, a poisoned instance, the instance's lifecycle (docs/PLAN_WASM_K1.md S6) ---------------
// Each case function leaves kernels.js as it found it (`kernelsBack`): the twins in force, as relightBench left them for
// the later cases, no route overridden and the clocks off.

const LAP_KEYS = ["copyIn", "copyInMB", "copyInSharedMB", "copyOut", "copyOutMB", "alloc", "grewMB"];
const lapsZero = (l) => LAP_KEYS.every((k) => l[k] === 0);
/** What a flood job's `use` makes of the shape: a copy (the view is valid only inside the call), the count, the bounds. */
const shapeOf = (view, n, bounds) => ({ bytes: new Uint8Array(view), n, bounds });
const sameShape = (a, b) => !!a && !!b && eqBytes(a.bytes, b.bytes) && a.n === b.n && JSON.stringify(a.bounds) === JSON.stringify(b.bounds);
/** A source pointer below 0 sends mip_half out of bounds: a trap, as a corrupted instance would give. */
const trapIn = (px) => px.exports.mip_half(-16, 256, 256, 0);

function kernelsBack(K) {
    K.setKernels("js");
    for (const name of Object.keys(K.routeOverrides())) K.setRoute(name, null);
    K.pxTimed(false);
}

/**
 * The split's clocks and laps (px.js, docs/PLAN_WASM_K1.md §1.1), on a px.js of its own (imported under a query, so its
 * counters start empty whatever ran before): `ms` only while `pxTimed()` is on; `first` lists an export whose every
 * call on the thread fell since the reset, with that first call's milliseconds (null when it was not timed); `ever` and
 * `firstMs` go on across later calls, a new instance and a reset; a 64 x 64 dilateMask copies 16 KB in and 16 KB out;
 * `pxCalls(true)` clears the milliseconds and the laps; an alloc memory cannot grow for throws `PxOutOfMemory`. With
 * `PX_BENCH`, what the counted wrapper costs per call with the clocks off and on.
 */
async function splitCases(simd, js) {
    const MB = 1048576, kb16 = 16384 / MB;
    const main = await import(pathToFileURL(path.join(PX_DIR, "px.js")).href);
    const K = await import(pathToFileURL(path.join(PX_DIR, "kernels.js")).href);
    check("kernels.js re-exports px.js' pxTimed, pxLaps, pxLapAdd and PxOutOfMemory and kernels_js.js' floodScan (one split per thread)",
        K.pxTimed === main.pxTimed && K.pxLaps === main.pxLaps && K.pxLapAdd === main.pxLapAdd && K.PxOutOfMemory === main.PxOutOfMemory
        && K.floodScan === js.floodScan);
    const P = await import(pathToFileURL(path.join(PX_DIR, "px.js")).href + "?split");
    const fresh = () => new P.Px(new WebAssembly.Instance(simd.module, {}), simd.module);
    const show = (l) => JSON.stringify(l);
    const m = new Float32Array(64 * 64).fill(0.5);
    const big = Float32Array.from({ length: 256 * 256 }, (_, i) => ((i * 37) % 101) / 100);
    const a = fresh();
    let l = P.pxLaps();
    check("a px.js of its own starts with the clocks off and an empty split",
        P.pxTimed() === false && !Object.keys(l.ms).length && !Object.keys(l.first).length && lapsZero(l), show(l));
    a.dilateMask(m, 64, 64, 2);
    l = P.pxLaps();
    check("untimed, the thread's first call of an export is listed in first with null, and books no ms and no laps",
        l.first.dilate_mask === null && Object.keys(l.first).length === 1 && !Object.keys(l.ms).length && lapsZero(l), show(l));
    P.pxCalls(true);
    a.dilateMask(m, 64, 64, 2);
    l = P.pxLaps();
    check("after the next reset that export is no longer first (ever goes on) and its count starts again",
        !("dilate_mask" in l.first) && P.pxCalls().dilate_mask === 1, show(l));

    // a timed first call: its milliseconds stay first's across later calls and a new instance, until a reset
    P.pxTimed(true);
    P.pxCalls(true);
    a.boxBlurs(big, 256, 256, [3, 0, 0]);
    const l1 = P.pxLaps();
    a.boxBlurs(big, 256, 256, [3, 0, 0]);
    const l2 = P.pxLaps();
    const b = fresh();
    b.boxBlurs(big, 256, 256, [3, 0, 0]);
    const l3 = P.pxLaps();
    P.pxCalls(true);
    b.boxBlurs(big, 256, 256, [3, 0, 0]);
    const l4 = P.pxLaps(), f1 = l1.first.box_blurs;
    check("timed, the first call's milliseconds are first's and stay so across a later call and a new instance (firstMs, ever); ms sums the calls; after a reset the export is no longer first",
        typeof f1 === "number" && f1 > 0 && l1.ms.box_blurs === f1 && l2.first.box_blurs === f1 && l2.ms.box_blurs > f1
        && l3.first.box_blurs === f1 && l3.ms.box_blurs > l2.ms.box_blurs && !("box_blurs" in l4.first) && l4.ms.box_blurs > 0,
        `first ${f1}, ms ${l1.ms.box_blurs} / ${l2.ms.box_blurs} / ${l3.ms.box_blurs}, then first ${show(l4.first)}`);

    // the copies of a Px method, plain and from a SharedArrayBuffer
    P.pxCalls(true);
    const plain = a.dilateMask(m, 64, 64, 2);
    l = P.pxLaps();
    const sm = new Float32Array(new SharedArrayBuffer(m.byteLength));
    sm.set(m);
    P.pxCalls(true);
    const viaShared = a.dilateMask(sm, 64, 64, 2);
    const ls = P.pxLaps();
    check("timed, a 64 x 64 dilateMask books 16 KB copied in and 16 KB out with their milliseconds and the kernel's; from a SharedArrayBuffer the copy in counts as shared too",
        l.copyInMB === kb16 && l.copyOutMB === kb16 && l.copyInSharedMB === 0 && l.copyIn > 0 && l.copyOut > 0 && l.ms.dilate_mask > 0
        && ls.copyInMB === kb16 && ls.copyInSharedMB === kb16 && ls.copyOutMB === kb16 && eqBytes(viaShared, plain), `${show(l)}; shared ${show(ls)}`);
    P.pxCalls(true);
    const b0 = a.byteLength, ptr = a.alloc(16 * MB);
    l = P.pxLaps();
    check("timed, an alloc that grows memory books its milliseconds and the MB memory grew in it",
        l.alloc > 0 && l.grewMB > 0 && l.grewMB * MB === a.byteLength - b0, `${show(l)}, ${b0} -> ${a.byteLength} bytes`);
    a.free(ptr, 16 * MB);
    P.pxCalls(true);
    P.pxLapAdd("copyIn", 1.5, 2 * MB, true);
    P.pxLapAdd("copyOut", 0.25, MB);
    l = P.pxLaps();
    let refused = false;
    try { P.pxLapAdd("copy", 1); } catch { refused = true; }
    check("pxLapAdd books a direct user's copies (one read from shared memory as shared too) and refuses any other key",
        l.copyIn === 1.5 && l.copyInMB === 2 && l.copyInSharedMB === 2 && l.copyOut === 0.25 && l.copyOutMB === 1 && refused, show(l));
    a.dilateMask(m, 64, 64, 2);
    P.pxCalls(true);
    l = P.pxLaps();
    check("pxCalls(true) clears the milliseconds and every lap", !Object.keys(l.ms).length && lapsZero(l), show(l));
    P.pxTimed(false);
    a.dilateMask(m, 64, 64, 2);
    l = P.pxLaps();
    check("with the clocks off again a call books its count and nothing else",
        P.pxTimed() === false && P.pxCalls().dilate_mask === 1 && !Object.keys(l.ms).length && lapsZero(l), show(l));
    let oom = null;
    try { a.alloc(4000 * MB); } catch (e) { oom = e; }   // px_alloc takes an i32: 4 GiB and more would wrap
    check("an alloc memory cannot grow for throws PxOutOfMemory (an Error, its size on it, the old message) and marks nothing",
        oom instanceof P.PxOutOfMemory && oom instanceof Error && oom.name === "PxOutOfMemory" && oom.bytes === 4000 * MB
        && oom.message === `px: out of memory allocating ${4000 * MB} bytes` && a.trapped === null, String(oom));

    if (process.env.PX_BENCH) {
        // the counted wrapper against the instance's own export, on a call that does next to nothing (adler32 of 0 bytes)
        const N = 200000, ps = a.alloc(8);
        const loop = (f) => () => { for (let i = 0; i < N; i++) f(ps, 0, 1); };
        const t = benchMedians([
            ["raw", loop(a.raw.adler32)],
            ["untimed", loop(a.exports.adler32)],
            ["timed", () => { P.pxTimed(true); try { loop(a.exports.adler32)(); } finally { P.pxTimed(false); } }],
        ]);
        const ns = (k) => (t[k] * 1e6) / N;
        console.log(`       the counted wrapper per kernel call (adler32 of 0 bytes, ${N} calls a round): clocks off +${(ns("untimed") - ns("raw")).toFixed(1)} ns, on +${(ns("timed") - ns("raw")).toFixed(1)} ns over the raw export's ${ns("raw").toFixed(1)} ns (K0b: 6-16 ns, clocks off)`);
        a.free(ps, 8);
    }
    P.pxTimed(false);
    P.pxCalls(true);
}

/**
 * The routes of kernels.js (docs/PLAN_WASM_K1.md §1.3): names and values are checked, `rustPx(name, size)` follows a
 * route, the global mode beats every route, a worker's `adoptRoutes` replaces the overrides wholesale. Then the flood
 * route's two sides, which must give the same bytes: the twin `floodShape` (on `floodScan`, the loop floodMask ran)
 * against both Rust builds, `floodScan` against `flood`, and the routed callers (kernels.js `floodShape`,
 * inpaint_raster.js `floodMask`) on each side of a route, `use` called once.
 */
async function routeCases(js, simd, scalar, raster) {
    const K = await import(pathToFileURL(path.join(PX_DIR, "kernels.js")).href);
    K.setKernels("rust");
    const p = K.rustPx(), base = K.kernelRoutes();   // the defaults: a measured flood or mips default may be among them
    try {
        const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(String(e && e.message)); } };
        check("setRoute refuses an unknown name (a prototype member too) and a value of the wrong kind",
            throws(() => K.setRoute("nope", "js"), /^px: unknown route nope$/) && throws(() => K.setRoute("toString", "js"), /unknown route toString/)
            && throws(() => K.setRoute("mips", 5), /^px: route mips takes/) && throws(() => K.setRoute("flood", -1), /route flood takes/)
            && throws(() => K.setRoute("flood", NaN), /route flood takes/) && throws(() => K.setRoute("keepMB", "js"), /route keepMB takes/)
            && Object.keys(K.routeOverrides()).length === 0, JSON.stringify(K.routeOverrides()));
        K.setRoute("flood", 1000);
        const at = [K.rustPx("flood", 999), K.rustPx("flood", 1000), K.rustPx("flood", 5000), K.rustPx()];
        K.setRoute("flood", "js");
        const toJs = [K.rustPx("flood", 1e9), K.rustPx()];
        K.setRoute("flood", Infinity);
        const inf = K.rustPx("flood", 1e9);
        K.setRoute("flood", "rust");
        const toRust = K.rustPx("flood", 0);
        K.setRoute("flood", null);
        check("rustPx(\"flood\", n): null below a number of pixels, Rust at it and above, null for \"js\" and Infinity, Rust for \"rust\" and when there is no flood route; null removes the override; a call without a name ignores the routes",
            !!p && at[0] === null && at[1] === p && at[2] === p && at[3] === p && toJs[0] === null && toJs[1] === p && inf === null && toRust === p
            && ("flood" in base || K.rustPx("flood", 0) === p) && K.route("flood") === base.flood && !("flood" in K.routeOverrides()));
        K.setRoute("mips", "rust");
        K.setRoute("flood", "rust");
        K.setKernels("js");
        const off = [K.rustPx("mips"), K.rustPx("flood", 1e9), K.rustPx()];
        K.setKernels("rust");
        check("setKernels(\"js\") beats a \"rust\" route (the global mode stays the override)", off.every((v) => v === null) && K.rustPx("mips") === p);
        K.adoptRoutes({ flood: 5, keepMB: Infinity, bogus: 1, releaseMB: "js", toString: "js", mips: 3 });
        const adopted = K.routeOverrides();
        K.adoptRoutes(null);
        const none = K.routeOverrides();
        let quiet = true;
        try { K.adoptRoutes({ get flood() { throw new Error("a getter"); } }); K.adoptRoutes("flood=js"); } catch { quiet = false; }
        check("adoptRoutes replaces the overrides wholesale with the valid entries (unknown names and bad values dropped) and never throws",
            Object.keys(adopted).sort().join(" ") === "flood keepMB" && adopted.flood === 5 && adopted.keepMB === Infinity
            && !Object.keys(none).length && quiet && !Object.keys(K.routeOverrides()).length, Object.keys(adopted).join(" "));
        K.setRoute("flood", 77);
        K.setRoute("keepMB", 64);
        const kr = K.kernelRoutes(), ov = K.routeOverrides();
        K.setRoute("flood", null);
        K.setRoute("keepMB", null);
        check("kernelRoutes() is the defaults with the overrides over them (releaseMB and keepMB always among them), routeOverrides() the overrides alone",
            JSON.stringify(kr) === JSON.stringify({ ...base, flood: 77, keepMB: 64 }) && typeof base.releaseMB === "number" && typeof base.keepMB === "number"
            && Object.keys(ov).length === 2 && ov.flood === 77 && ov.keepMB === 64 && K.route("releaseMB") === base.releaseMB && K.route("keepMB") === base.keepMB
            && K.route("mips") === base.mips, JSON.stringify(kr));

        // the flood's two sides: jobCases' sizes and seeds, corner seeds, each selection kind at each tolerance either way
        const selOf = (w, h, seed, kind) => {
            if (kind === "none") return null;
            const d = new Uint8Array(w * h * 4);
            if (kind === "empty") return d;   // all transparent: the region is empty
            const f = blobs(w, h, seed, 4);
            for (let i = 0; i < w * h; i++) d[i * 4 + 3] = f[i] ? [128, 200, 255][i % 3] : [0, 90, 127][i % 3];
            return d;
        };
        const cases = [];
        for (const [w, h, seed] of [[1, 1, 1], [97, 61, 2], [256, 256, 3], [640, 480, 5]]) {
            const data = regions(w, h, seed), r = rng(seed + 9);
            [[0, 0], [w - 1, h - 1], [r() * w | 0, r() * h | 0]].forEach(([sx, sy], s) => {
                for (let k = 0; k < 6; k++) {
                    const tol = [0, 32, 255][k % 3], contiguous = k < 3, kind = ["none", "partial", "empty"][(k + s) % 3];
                    cases.push({ tag: `${w}x${h} seed ${sx},${sy} tol ${tol} ${contiguous ? "contiguous" : "anywhere"} sel ${kind}`,
                        args: [data, w, h, sx, sy, tol, contiguous, selOf(w, h, seed + k, kind)] });
                }
            });
        }
        twinCheck({
            name: "flood_shape", builds: [["rust simd", simd], ["rust scalar", scalar]], twin: js, cases,
            title: "flood_shape equals its twin floodShape byte for byte, with the count and the bounds (no selection, partial alpha, all transparent; tol 0 / 32 / 255; contiguous or not; corner seeds)",
            call: (k, [d, w, h, sx, sy, tol, contiguous, sel]) => k.floodShape(d, w, h, sx, sy, tol, contiguous, sel, 0x123456, shapeOf),
        });
        let ok = true, detail = "", n = 0;
        for (const c of cases) {
            const [d, w, h, sx, sy, tol, contiguous, sel] = c.args;
            if (sel) continue;
            for (const t of [tol, 400, -5]) {
                n++;
                const x = js.floodScan(d, w, h, sx, sy, t, contiguous), y = js.flood(d, w, h, sx, sy, t, contiguous);
                if (!eqBytes(x, y)) { ok = false; detail = `${c.tag} at tol ${t}: ${firstDiff(x, y)}`; }
            }
        }
        check(`js floodScan (floodMask's loop) equals js flood (${n} cases, also at tol 400 and -5: unclamped against clamped)`, ok, detail);

        // the routed callers on each side of a route: the same result, and the side the route names ran
        const some = cases.filter((_, i) => i % 5 === 0);
        ok = true; detail = ""; n = 0;
        for (const c of some) {
            const [d, w, h, sx, sy, tol, contiguous, sel] = c.args;
            const want = js.floodShape(d, w, h, sx, sy, tol, contiguous, sel, 0x123456, shapeOf);
            for (const [rt, rust] of [["rust", 1], ["js", 0], [w * h, 1], [w * h + 1, 0]]) {
                K.setRoute("flood", rt);
                K.pxCalls(true);
                let uses = 0;
                const got = K.floodShape(d, w, h, sx, sy, tol, contiguous, sel, 0x123456, (v, cnt, bounds) => { uses++; return shapeOf(v, cnt, bounds); });
                const ran = K.pxCalls().flood_shape || 0;
                n++;
                if (!sameShape(got, want) || uses !== 1 || ran !== rust) {
                    ok = false; detail = `${c.tag} route ${rt}: ${ran ? "rust" : "the twin"} ran, use called ${uses}x${sameShape(got, want) ? "" : ", another shape"}`;
                }
            }
        }
        K.setRoute("flood", null);
        check(`kernels.js floodShape under the flood route: "rust" and a size at or below the picture's run Rust, "js" and a size above it the twin; the same shape, use called once (${n} runs)`, ok, detail);
        ok = true; detail = ""; n = 0;
        for (const c of some) {
            const [d, w, h, sx, sy, tol, contiguous] = c.args;
            const want = js.floodScan(d, w, h, sx, sy, tol, contiguous);
            for (const [rt, rust] of [["rust", 1], ["js", 0], [w * h, 1], [w * h + 1, 0]]) {
                K.setRoute("flood", rt);
                K.pxCalls(true);
                const got = raster.floodMask(d, w, h, sx, sy, tol, contiguous);
                const ran = K.pxCalls().flood || 0;
                n++;
                if (!eqBytes(got, want) || ran !== rust) { ok = false; detail = `${c.tag} route ${rt}: ${ran ? "rust" : "floodScan"} ran ${firstDiff(got, want)}`; }
            }
        }
        K.setRoute("flood", null);
        check(`inpaint_raster.js floodMask under the flood route: the Rust flood at or above the route's size and for "rust", floodScan below it and for "js"; the same mask (${n} runs)`, ok, detail);
    } finally { kernelsBack(K); }
}

/**
 * A poisoned instance (docs/PLAN_WASM_K1.md §0.3): a trap in an export marks its instance, a wasm stack overflow
 * (RangeError) too and no other error; the callers (kernels.js' wrappers, inpaint_raster.js floodMask and
 * growMaskBounds) answer a trap or an out-of-memory with the twin from the inputs as they were, the instance is
 * replaced (synchronously, or in the background where that throws) and the next call runs Rust again; a plain error is
 * the caller's; `_reset` keeps a result already written, in place too; floodShape's `use` runs once whatever fails; a
 * recovery warns once per cause and kernel.
 */
async function trapCases(js, simd, raster) {
    const MB = 1048576;
    const P = await import(pathToFileURL(path.join(PX_DIR, "px.js")).href);
    const K = await import(pathToFileURL(path.join(PX_DIR, "kernels.js")).href);
    const m = Float32Array.from({ length: 64 * 64 }, (_, i) => (i % 7) / 7), want = js.dilateMask(m, 64, 64, 2);
    const warned = [], realWarn = console.warn;
    console.warn = (...a) => { warned.push(a.map(String).join(" ")); };   // recovered() warns; kept to be counted below
    const RealInstance = WebAssembly.Instance;
    K.setKernels("rust");
    K.setRoute("flood", "rust");   // the floods below run Rust whatever a measured flood default says
    try {
        // a trap through an export
        let p = K.rustPx(), i0 = K.pxInstances(), err = null;
        try { trapIn(p); } catch (e) { err = e; }
        const next = K.rustPx();
        let i1 = K.pxInstances();
        check("a trap in an export (mip_half below address 0) throws a RuntimeError and marks its instance; the next rustPx() is a new one (trap +1, made sync)",
            err instanceof WebAssembly.RuntimeError && p.trapped === err && !!next && next !== p && next.trapped === null
            && i1.trap === i0.trap + 1 && i1.sync === i0.sync + 1 && i1.serial === i0.serial + 1, `${err}; ${JSON.stringify(i1)}`);
        const inst = new WebAssembly.Instance(simd.module, {});
        const failing = (e) => new P.Px({ exports: { ...inst.exports, dilate_mask: () => { throw e; } } }, simd.module);
        const overflow = new RangeError("Maximum call stack size exceeded"), other = new TypeError("not from wasm");
        const pr = failing(overflow), pt = failing(other);
        let er = null, et = null;
        try { pr.dilateMask(m, 64, 64, 2); } catch (e) { er = e; }
        try { pt.dilateMask(m, 64, 64, 2); } catch (e) { et = e; }
        check("a RangeError from an export (a wasm stack overflow) marks its instance as a trap does; another error marks nothing",
            er === overflow && pr.trapped === overflow && et === other && pt.trapped === null);

        // a wrapper whose Rust call traps, twice over (the second warns no more)
        let ok = true, detail = "";
        for (let round = 0; round < 2; round++) {
            p = K.rustPx(); i0 = K.pxInstances();
            K.pxCalls(true);
            p.dilateMask = function () { return trapIn(this); };   // the method traps in its export, as a real one would
            const got = K.dilateMask(m, 64, 64, 2), after = K.rustPx();
            i1 = K.pxInstances();
            const again = K.dilateMask(m, 64, 64, 2), c = K.pxCalls();
            if (!(eqBytes(got, want) && p.trapped instanceof WebAssembly.RuntimeError && after !== p && i1.trap === i0.trap + 1
                && eqBytes(again, want) && c.dilate_mask === 1 && c.mip_half === 1)) { ok = false; detail = `round ${round}: ${JSON.stringify(c)}, ${JSON.stringify(i1)}`; }
        }
        check("a wrapper whose Rust call traps answers with the twin's bytes, the instance is replaced (trap +1) and the next call runs Rust", ok, detail);
        const fw = 97, fh = 61, fdata = regions(fw, fh, 2);
        p = K.rustPx(); i0 = K.pxInstances();
        p.flood = function () { return trapIn(this); };
        const mask = raster.floodMask(fdata, fw, fh, 10, 10, 32, true);
        const floodOk = eqBytes(mask, js.floodScan(fdata, fw, fh, 10, 10, 32, true)) && K.rustPx() !== p && K.pxInstances().trap === i0.trap + 1;
        const sel = new Uint8Array(fw * fh * 4), blob = blobs(fw, fh, 4, 4);
        for (let i = 0; i < fw * fh; i++) { sel[i * 4] = 255; sel[i * 4 + 3] = blob[i] ? 255 : 0; }
        const ref = sel.slice();
        raster.growMask(ref, fw, fh, 3);
        const refBounds = raster.maskBounds(ref, fw, fh);
        p = K.rustPx(); i0 = K.pxInstances();
        p.growMask = function () { return trapIn(this); };   // traps before it writes the selection, as Px.growMask would
        const grown = sel.slice(), gb = raster.growMaskBounds(grown, fw, fh, 3);
        check("inpaint_raster.js after a trap: floodMask gives floodScan's mask, growMaskBounds the JS growMask's selection and bounds (the selection grown once); each replaces the instance",
            floodOk && eqBytes(grown, ref) && JSON.stringify(gb) === JSON.stringify(refBounds) && K.rustPx() !== p && K.pxInstances().trap === i0.trap + 1,
            `flood ${floodOk}, bounds ${gb} vs ${refBounds} ${firstDiff(grown, ref)}`);

        // a plain error, and out of memory
        p = K.rustPx(); i0 = K.pxInstances();
        p.dilateMask = function () { throw new Error("plain"); };
        let plain = null;
        try { K.dilateMask(m, 64, 64, 2); } catch (e) { plain = e; }
        delete p.dilateMask;
        i1 = K.pxInstances();
        check("a plain Error from the Rust method is rethrown and the instance kept",
            !!plain && plain.message === "plain" && K.rustPx() === p && p.trapped === null && i1.serial === i0.serial, String(plain));
        p = K.rustPx(); i0 = K.pxInstances();
        p.dilateMask = function () { this.alloc(4000 * MB); };   // memory cannot grow that far: PxOutOfMemory
        const viaOom = K.dilateMask(m, 64, 64, 2);
        i1 = K.pxInstances();
        check("out of memory in the Rust method: the twin's bytes, the instance replaced (oom +1), nothing marked trapped",
            eqBytes(viaOom, want) && K.rustPx() !== p && i1.oom === i0.oom + 1 && i1.trap === i0.trap && p.trapped === null, JSON.stringify(i1));

        // _reset after the last export call
        const fresh = () => new P.Px(new WebAssembly.Instance(simd.module, {}), simd.module);
        const q1 = fresh(), q2 = fresh();
        q1.trapped = new WebAssembly.RuntimeError("marked by hand");
        q1.job.reset = () => { throw new WebAssembly.RuntimeError("the reset"); };
        q2.job.reset = () => { throw new Error("the reset"); };
        let r1 = null, e1 = null, e2 = null;
        try { r1 = q1.dilateMask(m, 64, 64, 2); } catch (e) { e1 = e; }
        try { q2.dilateMask(m, 64, 64, 2); } catch (e) { e2 = e; }
        check("_reset: once the instance is trapped a failing reset is swallowed and the result returned; on a sound instance a plain error from it is rethrown",
            !e1 && !!r1 && eqBytes(r1, want) && !!e2 && e2.message === "the reset" && q2.trapped === null, `${e1}; ${e2}`);
        const params = matchParams(1), src = pixelRow(4096, 11);   // k = 1: matching twice is not matching once
        const once = js.matchPixels(src.slice(), params), twice = js.matchPixels(once.slice(), params);
        p = K.rustPx(); i0 = K.pxInstances();
        p.job.reset = function () { trapIn(p); };   // a trap in the reset (its px_free) marks the instance after the result is written
        const inPlace = src.slice(), matched = K.matchPixels(inPlace, params);
        const marked = p.trapped instanceof WebAssembly.RuntimeError, nextM = K.rustPx();
        i1 = K.pxInstances();
        check("a trap in the reset after an in-place kernel wrote its result: the result stands, applied once (no twin over it), and the next rustPx() replaces the instance",
            !eqBytes(once, twice) && eqBytes(inPlace, once) && eqBytes(matched, once) && marked && nextM !== p && i1.trap === i0.trap + 1,
            `${firstDiff(inPlace, once)}; ${JSON.stringify(i1)}`);
        p = K.rustPx(); i0 = K.pxInstances();
        K.pxCalls(true);
        p.job.reset = () => { throw new P.PxOutOfMemory(1); };
        const viaReset = K.dilateMask(m, 64, 64, 2), calls = K.pxCalls().dilate_mask, oomMarked = p.trapped instanceof P.PxOutOfMemory;
        const nextO = K.rustPx();
        i1 = K.pxInstances();
        check("out of memory in the reset of a sound instance: the result stands (Rust ran), the instance is marked with it and the next rustPx() replaces it, counted oom",
            eqBytes(viaReset, want) && calls === 1 && oomMarked && nextO !== p && i1.oom === i0.oom + 1 && i1.trap === i0.trap, JSON.stringify(i1));

        // no synchronous instance: the successor loads in the background
        p = K.rustPx(); i0 = K.pxInstances();
        let grownOut = null, gone = false, pending = false, mid = null, midRust = -1;
        try {
            WebAssembly.Instance = function () { throw new Error("no synchronous instance here"); };
            p.alloc(300 * MB);
            grownOut = K.dilateMask(m, 64, 64, 2);   // Rust; releaseIfLarge then drops the grown instance
            gone = K.rustPx() === null;
            pending = K.pxInstances().pending;
            K.pxCalls(true);
            mid = K.dilateMask(m, 64, 64, 2);        // the twin meanwhile
            midRust = K.pxCalls().dilate_mask || 0;
        } finally { WebAssembly.Instance = RealInstance; }
        await K.pxSettled();
        i1 = K.pxInstances();
        K.pxCalls(true);
        const settled = K.dilateMask(m, 64, 64, 2);
        check("where a synchronous instance throws, the successor loads in the background: the twin runs meanwhile (rustPx() null), and after pxSettled() a new instance (async +1) runs Rust",
            eqBytes(grownOut, want) && gone && pending && eqBytes(mid, want) && midRust === 0 && !i1.pending && i1.async === i0.async + 1
            && i1.release === i0.release + 1 && i1.sync === i0.sync && !!K.rustPx() && K.rustPx() !== p && eqBytes(settled, want) && K.pxCalls().dilate_mask === 1,
            JSON.stringify(i1));

        // floodShape's use runs once
        const fargs = [fdata, fw, fh, 10, 10, 32, true, null, 0x123456];
        const wantShape = js.floodShape(...fargs, shapeOf);
        let uses = 0;
        const counted = (v, cnt, bounds) => { uses++; return shapeOf(v, cnt, bounds); };
        p = K.rustPx(); i0 = K.pxInstances();
        p.floodShape = function () { return trapIn(this); };
        const viaTwin = K.floodShape(...fargs, counted);
        const before = sameShape(viaTwin, wantShape) && uses === 1 && K.rustPx() !== p && K.pxInstances().trap === i0.trap + 1;
        p = K.rustPx(); i0 = K.pxInstances(); uses = 0;
        p.floodShape = function (...a) { const r = P.Px.prototype.floodShape.apply(this, a); trapIn(this); return r; };
        let ea = null;
        try { K.floodShape(...fargs, counted); } catch (e) { ea = e; }
        const after = ea instanceof WebAssembly.RuntimeError && uses === 1 && !!p.trapped && K.rustPx() !== p && K.pxInstances().trap === i0.trap + 1;
        const thrown = [];
        for (const rt of ["rust", "js"]) {
            K.setRoute("flood", rt);
            p = K.rustPx(); uses = 0;
            let eu = null;
            try { K.floodShape(...fargs, () => { uses++; throw new WebAssembly.RuntimeError("thrown by use"); }); } catch (e) { eu = e; }
            thrown.push(!!eu && eu.message === "thrown by use" && uses === 1 && K.rustPx() === p && p.trapped === null);
        }
        check("floodShape runs use once: a trap before it gives the twin's shape; a trap after it, and a RuntimeError thrown by use (Rust and twin side), are rethrown",
            before && after && thrown.every(Boolean), `trap before ${before}, trap after ${after}, use throws ${thrown}`);

        const causes = warned.map((w) => (/kernel (\S+) failed \((\w+)/.exec(w) || []).slice(1).join(" ")).sort();
        check("a recovery warns once per cause and kernel", causes.join(", ") === "dilate_mask oom, dilate_mask trap, flood trap, flood_shape trap, grow_mask trap",
            causes.join(", ") || "no warning");
    } finally {
        WebAssembly.Instance = RealInstance;
        console.warn = realWarn;
        kernelsBack(K);
    }
}

/**
 * The instance's lifecycle in kernels.js (docs/PLAN_WASM_K1.md S3): `pxInstances`, the `releaseMB` route, `dropPx`
 * and what `pxSplit` reports was renewed, and the idle trim above `keepMB` (IDLE_MS is 2 s, so about 6 s of waits):
 * it fires once the thread has been idle that long, never while a job holds the instance, and after the job ends.
 */
async function lifecycleCases(js) {
    const MB = 1048576;
    const K = await import(pathToFileURL(path.join(PX_DIR, "kernels.js")).href);
    const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
    const m = Float32Array.from({ length: 64 * 64 }, (_, i) => (i % 7) / 7), want = js.dilateMask(m, 64, 64, 2);
    K.setKernels("rust");
    try {
        const keys = Object.keys(K.pxInstances()).sort().join(" ");
        check("pxInstances() says the instance's serial, bytes, pending load and holds, its replacements by cause and how they were made",
            keys === "async bytes holds idle oom pending release serial sync trap", keys);
        K.setRoute("releaseMB", 4);
        let p = K.rustPx(), i0 = K.pxInstances();
        p.alloc(8 * MB);
        const out = K.dilateMask(m, 64, 64, 2);
        let i1 = K.pxInstances();
        K.setRoute("releaseMB", null);
        check("the releaseMB route: a releasing call on an instance grown past it replaces the instance (release +1, made sync), its result kept",
            eqBytes(out, want) && K.rustPx() !== p && i1.release === i0.release + 1 && i1.sync === i0.sync + 1 && i1.bytes < 8 * MB, JSON.stringify(i1));
        const s0 = K.pxSplit(), back = JSON.parse(JSON.stringify(s0));   // as px_jobs.py hands the window's snapshot back
        p = K.dropPx("idle");
        const s1 = K.pxSplit(s0), s2 = K.pxSplit(back);
        check("dropPx renews now; pxSplit(snapshot) reports bytes0 and the renewals since by cause, from a snapshot that went through JSON too",
            !!p && p === K.rustPx() && s1.inst === s0.inst + 1 && s1.bytes0 === s0.bytes && s1.renewed.idle === 1 && s1.renewed.release === 0
            && s1.renewed.trap === 0 && s1.renewed.oom === 0 && "renews" in s0 && !("renews" in s1) && JSON.stringify(s2.renewed) === JSON.stringify(s1.renewed),
            JSON.stringify(s1.renewed));

        K.setRoute("keepMB", 1);   // a fresh instance is about 1.06 MB: "small" below means below 8 MB
        p = K.rustPx(); i0 = K.pxInstances();
        p.alloc(8 * MB);
        K.dilateMask(m, 64, 64, 2);   // a releasing call arms the trim
        const early = K.pxInstances().idle;
        await sleep(2100);
        i1 = K.pxInstances();
        check("the idle trim: an instance above keepMB is replaced 2 s after a releasing call (idle +1), not at once",
            early === i0.idle && i1.idle === i0.idle + 1 && K.rustPx() !== p && i1.bytes < 8 * MB, JSON.stringify(i1));
        p = K.rustPx();
        p.alloc(8 * MB);
        K.dilateMask(m, 64, 64, 2);   // armed again
        K.pxJobStart();               // a job holds the instance: the countdown is cancelled
        i0 = K.pxInstances();
        await sleep(2100);
        const held = K.pxInstances(), kept = K.rustPx() === p;
        K.pxJobEnd();                 // nothing holds it now: the countdown starts again
        await sleep(2100);
        i1 = K.pxInstances();
        check("a job holds the instance: no trim while it runs (holds 1), the trim 2 s after it ends",
            i0.holds === 1 && held.idle === i0.idle && kept && i1.holds === 0 && i1.idle === i0.idle + 1 && K.rustPx() !== p,
            `held ${JSON.stringify(held)}, then ${JSON.stringify(i1)}`);
    } finally { kernelsBack(K); }
}

/** The whole-job kernels (grow_mask, flood_shape) against the editor's JS for the same jobs. */
async function jobCases(px, label, raster) {
    let ok = true, detail = "";
    const selection = (w, h, seed, empty = false) => {
        const f = empty ? new Uint8Array(w * h) : blobs(w, h, seed, 4), d = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) { d[i * 4] = 255; d[i * 4 + 3] = f[i] ? (seed & 1 ? 255 : 200) : (i % 7 ? 0 : 90); }
        return d;
    };
    for (const [w, h, seed, n, empty] of [[1, 1, 1, 3, false], [64, 64, 2, 5, false], [300, 200, 3, -4, false], [257, 129, 4, 16, false], [120, 90, 5, -40, false], [80, 60, 6, 2, true], [400, 300, 7, 1, false]]) {
        const src = selection(w, h, seed, empty);
        const a = src.slice();
        raster.growMask(a, w, h, n);
        const ab = raster.maskBounds(a, w, h);
        const b = src.slice(), bb = px.growMask(b, w, h, n);
        if (!eqBytes(a, b) || JSON.stringify(ab) !== JSON.stringify(bb)) { ok = false; detail = `${w}x${h} n ${n} ${firstDiff(a, b) || `bounds ${ab} vs ${bb}`}`; }
    }
    check(`${label} grow_mask equals growMask + maskBounds (grow, shrink, empty, partial alpha)`, ok, detail);

    ok = true; detail = "";
    for (const [w, h, seed] of [[1, 1, 1], [97, 61, 2], [256, 256, 3], [640, 480, 5]]) {
        const data = regions(w, h, seed), r = rng(seed + 9);
        for (let k = 0; k < 6; k++) {
            const sx = r() * w | 0, sy = r() * h | 0, tol = [0, 8, 32, 80, 255, 12][k], contiguous = k % 2 === 0;
            const sel = k % 3 ? selection(w, h, seed + k) : null;
            const mask = raster.floodMask(data, w, h, sx, sy, tol, contiguous);
            if (sel) for (let p = 0; p < w * h; p++) if (sel[p * 4 + 3] < 128) mask[p] = 0;
            const want = new Uint8Array(w * h * 4);
            let count = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
            for (let p = 0; p < w * h; p++) {
                if (!mask[p]) continue;
                want.set([18, 52, 86, 255], p * 4);
                count++;
                const x = p % w, y = (p / w) | 0;
                x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = y;
            }
            const wantBounds = x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
            const got = px.floodShape(data, w, h, sx, sy, tol, contiguous, sel, 0x123456, (view, n, bounds) => ({ bytes: new Uint8Array(view), n, bounds }));
            if (!eqBytes(got.bytes, want) || got.n !== count || JSON.stringify(got.bounds) !== JSON.stringify(wantBounds)) {
                ok = false; detail = `${w}x${h} seed ${sx},${sy} tol ${tol} ${contiguous} sel ${!!sel} ${firstDiff(got.bytes, want) || `count ${got.n} vs ${count}, bounds ${got.bounds} vs ${wantBounds}`}`;
            }
        }
    }
    check(`${label} flood_shape equals floodMask, the selection clip, the count, the bounds and the shape`, ok, detail);
}

async function floodCases(ref, label, js, raster) {
    let ok = true, detail = "";
    for (const [w, h, seed] of [[1, 1, 1], [97, 61, 2], [256, 256, 3], [300, 17, 4], [640, 480, 5]]) {
        const data = regions(w, h, seed);
        const r = rng(seed + 5);
        for (let k = 0; k < 6; k++) {
            const sx = r() * w | 0, sy = r() * h | 0, tol = [0, 8, 32, 80, 255, 12][k];
            for (const contiguous of [true, false]) {
                const a = js.flood(data, w, h, sx, sy, tol, contiguous);
                const b = ref.flood(data, w, h, sx, sy, tol, contiguous);
                if (!eqBytes(a, b) || a.count !== b.count) { ok = false; detail = `${w}x${h} seed ${sx},${sy} tol ${tol} ${contiguous} ${firstDiff(a, b) || `count ${a.count} vs ${b.count}`}`; }
                let n = 0; for (const v of a) n += v;
                if (n !== a.count) { ok = false; detail = "count does not match the mask"; }
            }
        }
    }
    check(`js flood equals the ${label}, with the count`, ok, detail);
}

async function compositeCases(ref, label, js) {
    let ok = true, detail = "";
    for (const pixels of [65536, 7, 16, 1000, 1003]) {
        for (let trial = 0; trial < 15; trial++) {
            const n = 1 + (trial % 4);
            const dst = pixelRow(pixels, 1000 + trial + pixels, { opaque: trial % 3 === 0 });
            const srcs = [], ops = [], alphas = [], masks = [];
            for (let l = 0; l < n; l++) {
                srcs.push(pixelRow(pixels, 2000 + trial * 10 + l + pixels));
                ops.push((trial + l) % 30);
                alphas.push([255, 0, 128, 200, 1][(trial + 2 * l) % 5]);
                masks.push((trial + l) % 3 === 0 ? null : randomMask(pixels, 3000 + trial * 10 + l));
            }
            const a = js.compositeTile(dst.slice(), srcs, ops, alphas, masks);
            const b = ref.compositeTile(dst.slice(), srcs, ops, alphas, masks);
            if (!eqBytes(a, b)) { ok = false; detail = `${pixels}px trial ${trial} ops ${ops} alphas ${alphas} ${firstDiff(a, b)}`; }
        }
    }
    check(`js compositeTile equals the ${label} (5 ops and 25 blend modes, partial alpha, opacity, masks, tails)`, ok, detail);

    // every blend mode alone: over an opaque tile (four opaque pixels at a time in the SIMD build), over a mixed one, masked or not
    let okModes = true, detailModes = "";
    for (let op = 5; op <= 29; op++) {
        for (const [pixels, opaque, o, masked] of [[4099, true, 255, false], [4099, true, 170, true], [4099, false, 255, true], [4099, false, 90, false], [3, false, 255, false]]) {
            const dst = pixelRow(pixels, 40 + op, { opaque }), src = pixelRow(pixels, 60 + op + pixels), mask = masked ? [randomMask(pixels, 80 + op)] : null;
            const a = js.compositeTile(dst.slice(), [src], [op], [o], mask);
            const b = ref.compositeTile(dst.slice(), [src], [op], [o], mask);
            if (!eqBytes(a, b)) { okModes = false; detailModes = `${BLEND_NAMES[op - 5]} ${pixels}px opaque ${opaque} opacity ${o} masked ${masked} ${firstDiff(a, b)}`; }
        }
    }
    check(`js blend modes equal the ${label}, each alone (opaque and translucent backdrops, opacity, mask)`, okModes, detailModes);

    // the same bytes from Uint8ClampedArray inputs (ImageData.data)
    const clamp = (u) => new Uint8ClampedArray(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength));
    const d0 = pixelRow(4096, 77), s0 = pixelRow(4096, 78), m0 = randomMask(4096, 79);
    const viaBytes = js.compositeTile(d0.slice(), [s0, s0], [0, 2], [200, 255], [m0, null]);
    const viaClamped = js.compositeTile(clamp(d0), [clamp(s0), s0], [0, 2], [200, 255], [m0, null]);
    check(`js composite gives the same bytes for Uint8ClampedArray inputs`, eqBytes(viaBytes, new Uint8Array(viaClamped.buffer)));

    // against float compositing (W3C straight-alpha source-over). Over an opaque destination the
    // 8-bit premultiplied maths stays within 1.5 levels; over a translucent one the storage error
    // is divided by the result's alpha, so the bound is per pixel: 2.5 · 255 / alpha + 0.6.
    let worst = 0, worstRatio = 0, alphaOff = 0, seen = 0;
    for (const o of [255, 200]) {
        const dst = pixelRow(8192, 5 + o, { opaque: true }), src = pixelRow(8192, 6 + o);
        const out = js.compositeTile(dst.slice(), [src], [0], [o], null);
        for (let p = 0; p < 8192; p++) {
            const i = p * 4, sa = src[i + 3] / 255 * o / 255;
            for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(src[i + c] * sa + dst[i + c] * (1 - sa) - out[i + c]));
        }
        const dst2 = pixelRow(8192, 7 + o), out2 = js.compositeTile(dst2.slice(), [src], [0], [o], null);
        for (let p = 0; p < 8192; p++) {
            const i = p * 4, sa = src[i + 3] / 255 * o / 255, da = dst2[i + 3] / 255, oa = sa + da * (1 - sa);
            alphaOff = Math.max(alphaOff, Math.abs(oa * 255 - out2[i + 3]));
            if (oa < 0.5 || da === 1 || da === 0) continue;
            seen++;
            const bound = 2.5 * 255 / out2[i + 3] + 0.6;
            for (let c = 0; c < 3; c++) worstRatio = Math.max(worstRatio, Math.abs((src[i + c] * sa + dst2[i + c] * da * (1 - sa)) / oa - out2[i + c]) / bound);
        }
    }
    check(`js source-over over an opaque tile within 1.5 levels of float maths`, worst <= 1.5, `worst ${worst.toFixed(2)}`);

    // the blend modes against the specification in floats: co = cs·as·(1 − ab) + cb·ab·(1 − as) + as·ab·B(cb, cs)
    let worstB = 0, worstFull = 0, worstRatioB = 0, seenB = 0, worstMode = "", worstLL = 0, worstLLFull = 0, worstRatioLL = 0;
    let worstRatioTierB = 0, worstDevTierB = 0;
    for (let op = 5; op <= 23; op++) {
        for (const o of [255, 140]) {
            const dst = pixelRow(8192, 11 + op + o, { opaque: true }), src = pixelRow(8192, 12 + op + o);
            const out = js.compositeTile(dst.slice(), [src], [op], [o], null);
            for (let p = 0; p < 8192; p++) {
                const i = p * 4, sa = src[i + 3] / 255 * o / 255;
                for (let c = 0; c < 3; c++) {
                    const want = 255 * (dst[i + c] / 255 * (1 - sa) + sa * blendFloat(op, dst[i + c] / 255, src[i + c] / 255));
                    const e = Math.abs(want - out[i + c]);
                    if (e > worstB) { worstB = e; worstMode = BLEND_NAMES[op - 5]; }
                    if (o === 255 && e > worstFull) worstFull = e;
                    if (op === 13) { worstLL = Math.max(worstLL, e); if (o === 255) worstLLFull = Math.max(worstLLFull, e); }
                }
            }
            const dst2 = pixelRow(8192, 13 + op + o), out2 = js.compositeTile(dst2.slice(), [src], [op], [o], null);
            for (let p = 0; p < 8192; p++) {
                const i = p * 4, sa = src[i + 3] / 255 * o / 255, da = dst2[i + 3] / 255, oa = sa + da * (1 - sa);
                if (oa < 0.5 || da === 1 || da < 0.5) continue;
                seenB++;
                const bound = 2.5 * 255 / out2[i + 3] + 2.5 * 255 / dst2[i + 3] + 0.6;   // the stored backdrop is unpremultiplied for B, and once more at the end
                const da8 = dst2[i + 3], h = da8 >> 1;
                for (let c = 0; c < 3; c++) {
                    const dp = ((dst2[i + c] * da8 + 128) + ((dst2[i + c] * da8 + 128) >> 8)) >> 8;
                    const cb = Math.min(255, Math.floor((dp * 255 + h) / da8)) / 255;
                    const cs = src[i + c] / 255;
                    const want = 255 * (cs * sa * (1 - da) + cb * da * (1 - sa) + sa * da * blendFloat(op, cb, cs)) / oa;
                    const ratio = Math.abs(want - out2[i + c]) / bound;
                    if (op < 20) {
                        worstRatioB = Math.max(worstRatioB, ratio);
                    } else {
                        worstRatioTierB = Math.max(worstRatioTierB, ratio);
                        worstDevTierB = Math.max(worstDevTierB, Math.abs(want - out2[i + c]));
                    }
                    if (op === 13) worstRatioLL = Math.max(worstRatioLL, ratio);
                }
            }
        }
    }
    // rounded once: half a level at full opacity; at an opacity the effective alpha is rounded to 8 bits first, which is up to half a level more
    check(`js blend modes over an opaque tile within one level of the specification's floats (half a level at full opacity)`, worstB <= 1 && worstFull <= 0.51, `worst ${worstB.toFixed(2)} (${worstMode}), at full opacity ${worstFull.toFixed(3)}; linear light ${worstLL.toFixed(3)}, at full opacity ${worstLLFull.toFixed(3)}`);
    check(`js blend modes over translucent pixels within 2.5*255/alpha + 2.5*255/backdrop alpha + 0.6 levels`, worstRatioB <= 1 && seenB > 1000, `worst at ${(worstRatioB * 100).toFixed(0)} % of the bound over ${seenB} pixels; linear light ${(worstRatioLL * 100).toFixed(0)} %; tier B raw dev ${worstDevTierB.toFixed(2)}, ratio ${(worstRatioTierB * 100).toFixed(0)} %`);
    // linear light over every opaque (b, s) pair, three channel arrangements: B16 is exact, so the result is clamp(b + 2s − 255, 0, 255) itself
    {
        const dst = new Uint8Array(65536 * 4), src = new Uint8Array(65536 * 4), ll = (b, s) => Math.min(255, Math.max(0, b + 2 * s - 255));
        for (let b = 0; b < 256; b++) for (let s = 0; s < 256; s++) {
            const i = (b * 256 + s) * 4;
            dst[i] = b; src[i] = s; dst[i + 1] = s; src[i + 1] = b; dst[i + 2] = 255 - b; src[i + 2] = 255 - s; dst[i + 3] = 255; src[i + 3] = 255;
        }
        for (const [name, k] of [["js", js], [label, ref]]) {
            const out = k.compositeTile(dst.slice(), [src], [js.OPS["linear-light"]], [255], null);   // the op the editor looks up by name
            let bad = 0, first = "";
            for (let p = 0; p < 65536; p++) for (let c = 0; c < 3; c++) {
                const i = p * 4 + c;
                if (out[i] !== ll(dst[i], src[i])) { if (!bad++) first = `b ${dst[i]} s ${src[i]}: ${out[i]}, want ${ll(dst[i], src[i])}`; }
            }
            check(`${name} linear light over every opaque (b, s) pair is clamp(b + 2s − 255, 0, 255) exactly`, bad === 0, bad ? `${bad} off, first ${first}` : "");
        }
    }
    // tier A blend modes over every opaque (b, s) pair: B16 is exact for linear dodge, linear burn, subtract, pin light, hard mix; exclusion against reference
    {
        const dst = new Uint8Array(65536 * 4), src = new Uint8Array(65536 * 4);
        for (let b = 0; b < 256; b++) for (let s = 0; s < 256; s++) {
            const i = (b * 256 + s) * 4;
            dst[i] = b; src[i] = s; dst[i + 1] = s; src[i + 1] = b; dst[i + 2] = 255 - b; src[i + 2] = 255 - s; dst[i + 3] = 255; src[i + 3] = 255;
        }
        const closed = [
            ["linear-dodge", (b, s) => Math.min(255, b + s)],
            ["linear-burn", (b, s) => Math.max(0, b + s - 255)],
            ["subtract", (b, s) => Math.max(0, b - s)],
            ["pin-light", (b, s) => (s <= 127 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 255))],
            // the tie b + s = 255 as Photoshop has it: white for s <= 127, black for s >= 128 (R4-D2)
            ["hard-mix", (b, s) => (b + s > 255 || (b + s === 255 && s <= 127) ? 255 : 0)],
        ];
        for (const [mode, fn] of closed) {
            for (const [name, k] of [["js", js], [label, ref]]) {
                const out = k.compositeTile(dst.slice(), [src], [js.OPS[mode]], [255], null);
                let bad = 0, first = "";
                for (let p = 0; p < 65536; p++) for (let c = 0; c < 3; c++) {
                    const i = p * 4 + c;
                    if (out[i] !== fn(dst[i], src[i])) { if (!bad++) first = `b ${dst[i]} s ${src[i]}: ${out[i]}, want ${fn(dst[i], src[i])}`; }
                }
                check(`${name} ${mode} over every opaque (b, s) pair matches closed form exactly`, bad === 0, bad ? `${bad} off, first ${first}` : "");
            }
        }
        for (const [name, k] of [["js", js], [label, ref]]) {
            const out = k.compositeTile(dst.slice(), [src], [js.OPS["exclusion"]], [255], null);
            const want = reference.compositeTile(dst.slice(), [src], [14], [255], null);
            check(`${name} exclusion over every opaque (b, s) pair matches reference exactly`, eqBytes(out, want), firstDiff(out, want));
        }
    }
    // tier B blend modes over every opaque (b, s) pair (65,536 pairs) against reference (0 differ)
    {
        const dst = new Uint8Array(65536 * 4), src = new Uint8Array(65536 * 4);
        for (let b = 0; b < 256; b++) for (let s = 0; s < 256; s++) {
            const i = (b * 256 + s) * 4;
            dst[i] = b; src[i] = s; dst[i + 1] = s; src[i + 1] = b; dst[i + 2] = 255 - b; src[i + 2] = 255 - s; dst[i + 3] = 255; src[i + 3] = 255;
        }
        for (const mode of ["color-dodge", "color-burn", "vivid-light", "divide"]) {
            const op = js.OPS[mode];
            for (const [name, k] of [["js", js], [label, ref]]) {
                const out = k.compositeTile(dst.slice(), [src], [op], [255], null);
                const want = reference.compositeTile(dst.slice(), [src], [op], [255], null);
                check(`${name} ${mode} over every opaque (b, s) pair matches reference exactly`, eqBytes(out, want), firstDiff(out, want));
            }
        }
        // edge sets b in {0, 255} x s in {0, 127, 128, 254, 255}
        const bEdges = [0, 255], sEdges = [0, 127, 128, 254, 255];
        const numEdge = bEdges.length * sEdges.length;
        const dstEdge = new Uint8Array(numEdge * 4), srcEdge = new Uint8Array(numEdge * 4);
        let idx = 0;
        for (const b of bEdges) for (const s of sEdges) {
            const i = idx * 4;
            dstEdge[i] = b; srcEdge[i] = s;
            dstEdge[i + 1] = s; srcEdge[i + 1] = b;
            dstEdge[i + 2] = 255 - b; srcEdge[i + 2] = 255 - s;
            dstEdge[i + 3] = 255; srcEdge[i + 3] = 255;
            idx++;
        }
        for (const mode of ["color-dodge", "color-burn", "vivid-light", "divide"]) {
            const op = js.OPS[mode];
            for (const [name, k] of [["js", js], [label, ref]]) {
                const out = k.compositeTile(dstEdge.slice(), [srcEdge], [op], [255], null);
                const want = reference.compositeTile(dstEdge.slice(), [srcEdge], [op], [255], null);
                check(`${name} ${mode} edge set matches reference exactly`, eqBytes(out, want), firstDiff(out, want));
            }
        }
    }
    if (/rust/.test(label)) {
        const N = 1 << 20, dstT = pixelRow(N, 5, { opaque: true }), srcT = pixelRow(N, 6), parts = [];
        for (const op of [5, 7, 10, 13, 14, 18, 20, 24, 28]) {
            const best = (k) => { let b = Infinity; for (let i = 0; i < 5; i++) { const w = dstT.slice(), t0 = performance.now(); k.compositeTile(w, [srcT], [op], [200], null); b = Math.min(b, performance.now() - t0); } return b; };
            parts.push(`${BLEND_NAMES[op - 5]} ${label} ${best(ref).toFixed(1)} ms, twin ${best(js).toFixed(1)}`);
        }
        console.log(`       a megapixel over an opaque tile at 78 %: ${parts.join("; ")}`);
    }
    check(`js source-over over translucent pixels within 2.5*255/alpha + 0.6 levels, alpha within 1`, worstRatio <= 1 && alphaOff <= 1 && seen > 1000,
        `worst at ${(worstRatio * 100).toFixed(0)} % of the bound over ${seen} translucent pixels, alpha off by ${alphaOff.toFixed(2)}`);
}

async function compositeShaCases(js, simd, scalar) {
    const dstOpaque = new Uint8Array(65536 * 4), srcOpaque = new Uint8Array(65536 * 4);
    for (let b = 0; b < 256; b++) for (let s = 0; s < 256; s++) {
        const i = (b * 256 + s) * 4;
        dstOpaque[i] = b; srcOpaque[i] = s;
        dstOpaque[i + 1] = s; srcOpaque[i + 1] = b;
        dstOpaque[i + 2] = 255 - b; srcOpaque[i + 2] = 255 - s;
        dstOpaque[i + 3] = 255; srcOpaque[i + 3] = 255;
    }
    const dstTrans = pixelRow(65536, 12345, { opaque: false });
    const srcTrans = pixelRow(65536, 67890, { opaque: false });

    function hashKernel(k) {
        const h = crypto.createHash("sha256");
        for (let op = 0; op <= 29; op++) {
            const outO = k.compositeTile(dstOpaque.slice(), [srcOpaque], [op], [255], null);
            const outT = k.compositeTile(dstTrans.slice(), [srcTrans], [op], [255], null);
            h.update(outO);
            h.update(outT);
        }
        return h.digest("hex");
    }

    const shaJ = hashKernel(js);
    const shaS = hashKernel(simd);
    const shaC = hashKernel(scalar);
    check("compositeTile SHA-256 identical across twin, px.wasm, and px_scalar.wasm for ops 0-29",
        shaJ === shaS && shaJ === shaC,
        `sha ${shaJ.slice(0, 16)}`);

    let op30Ok = true, op30Detail = "";
    for (const [name, k] of [["twin", js], ["simd", simd], ["scalar", scalar]]) {
        const out30O = k.compositeTile(dstOpaque.slice(), [srcOpaque], [30], [255], null);
        const out0O = k.compositeTile(dstOpaque.slice(), [srcOpaque], [0], [255], null);
        const out30T = k.compositeTile(dstTrans.slice(), [srcTrans], [30], [255], null);
        const out0T = k.compositeTile(dstTrans.slice(), [srcTrans], [0], [255], null);
        if (!eqBytes(out30O, out0O) || !eqBytes(out30T, out0T)) {
            op30Ok = false;
            op30Detail = `${name} op 30 does not match op 0`;
            break;
        }
    }
    check("compositeTile op 30 equals op 0 on twin, px.wasm, and px_scalar.wasm", op30Ok, op30Detail);
}

/** An 8-bit, non-interlaced PNG of colour type 2 (RGB) or 6 (RGBA) as RGBA bytes (alpha 255 for RGB). */
function readPngFile(file) {
    const zlib = require("node:zlib");
    const b = fs.readFileSync(file);
    let o = 8, w = 0, h = 0, type = 0;
    const idat = [];
    while (o < b.length) {
        const len = b.readUInt32BE(o), name = b.toString("latin1", o + 4, o + 8);
        if (name === "IHDR") { w = b.readUInt32BE(o + 8); h = b.readUInt32BE(o + 12); type = b[o + 17]; }
        if (name === "IDAT") idat.push(b.subarray(o + 8, o + 8 + len));
        o += 12 + len;
    }
    const bpp = type === 6 ? 4 : 3, n = w * bpp, f = zlib.inflateSync(Buffer.concat(idat)), raw = new Uint8Array(h * n);
    for (let y = 0; y < h; y++) {
        const t = f[y * (n + 1)], src = y * (n + 1) + 1, r = y * n;
        for (let i = 0; i < n; i++) {
            const a = i >= bpp ? raw[r + i - bpp] : 0, up = y ? raw[r - n + i] : 0, c = i >= bpp && y ? raw[r - n + i - bpp] : 0;
            const pred = t === 0 ? 0 : t === 1 ? a : t === 2 ? up : t === 3 ? (a + up) >> 1 : paeth(a, up, c);
            raw[r + i] = (f[src + i] + pred) & 255;
        }
    }
    const out = new Uint8Array(w * h * 4);
    for (let p = 0; p < w * h; p++) {
        for (let c = 0; c < 3; c++) out[p * 4 + c] = raw[p * bpp + c];
        out[p * 4 + 3] = bpp === 4 ? raw[p * bpp + 3] : 255;
    }
    return { w, h, data: out };
}

// The blend-mode fixture made by Photoshop 27.11 (tools/fixtures/blendmodes, R4-D6): the patch over the backdrop in the
// hard-mix cell, composited by the twin and both wasm builds, against Photoshop's merged picture. The JSX places the
// patch by its opaque bounds, which start 4 px into patch.png, so the patch's origin is the cell's x - 4, y - 4 (the
// normal cell is within a level there). Hard mix is a step: a tie rule other than Photoshop's is 255 levels off.
async function blendFixtureCases(js, simd, scalar) {
    const dir = path.join(ROOT, "tools", "fixtures", "blendmodes");
    const back = readPngFile(path.join(dir, "backdrop.png")), patch = readPngFile(path.join(dir, "patch.png"));
    const merged = readPngFile(path.join(dir, "blendmodes_merged.png"));
    const modes = JSON.parse(fs.readFileSync(path.join(dir, "modes.json"), "utf8"));
    const cell = (name) => {
        const L = modes.layers.find((l) => l.name === name), ox = L.x - 4, oy = L.y - 4, P = patch.w;
        const dst = new Uint8Array(P * P * 4), want = new Uint8Array(P * P * 4);
        for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
            const bi = ((oy + y) * back.w + ox + x) * 4, i = (y * P + x) * 4;
            for (let c = 0; c < 4; c++) { dst[i + c] = back.data[bi + c]; want[i + c] = merged.data[bi + c]; }
        }
        return { dst, want };
    };
    const worst = (out, want, dst) => {
        let max = 0, ties = 0;
        for (let i = 0; i < out.length; i++) {
            if ((i & 3) === 3) continue;
            const d = Math.abs(out[i] - want[i]);
            if (d > max) max = d;
            if (d > 2 && dst[i] + patch.data[i] === 255) ties++;
        }
        return { max, ties };
    };
    const normal = cell("normal");
    const n = worst(js.compositeTile(normal.dst.slice(), [patch.data], [0], [255], null), normal.want, normal.dst);
    check("the fixture's normal cell (twin) is within a level of Photoshop's merged picture (the patch's origin)", n.max <= 1, `max ${n.max}`);
    const hm = cell("hard_mix");
    for (const [name, k] of [["twin", js], ["px.wasm", simd], ["px_scalar.wasm", scalar]]) {
        const r = worst(k.compositeTile(hm.dst.slice(), [patch.data], [js.OPS["hard-mix"]], [255], null), hm.want, hm.dst);
        check(`${name} hard mix equals Photoshop 27.11's merged fixture cell exactly (the tie b + s = 255 included)`, r.max === 0,
            `max ${r.max}${r.ties ? `, ${r.ties} bytes off at b + s = 255` : ""}`);
    }
}

// The GPU paths' blend maths (BLEND_FN_GLSL in inpaint_compositor.js; the canvas backend's screen shader uses the same
// text) read as text and run in a small model: the hard-mix branch of blend1 against the kernel's rule on every byte
// pair, and bm_clip against an exactly grey colour with the luminosity weights summed in float32 in every order, plain
// and fused (a GPU picks one; where lum(v, v, v) rounds to v itself the unguarded clip divided 0 by 0, a NaN that
// reached the framebuffer as black). Text in, JS out: GLSL types become `let`, the built-ins Math's, a vector
// assignment one per channel.
async function blendGlslCases() {
    const text = fs.readFileSync(path.join(ROOT, "renderer", "editor", "inpaint_compositor.js"), "utf8");
    const glsl = (text.match(/export const BLEND_FN_GLSL = `([\s\S]*?)`;/) || [])[1] || "";
    const toJs = (src) => src
        .replace(/\b(?:float|int|vec3)\s+(?=[a-z_]\w*\s*=)/g, "let ")
        .replace(/\b(floor|min|max|abs)\(/g, "Math.$1(")
        .replace(/\.([rgb])\b/g, (_, ch) => `[${"rgb".indexOf(ch)}]`)
        .replace(/^(\s*)c = (.*);$/gm, "$1c = c.map((c) => $2);");
    const step = (edge, x) => (x < edge ? 0 : 1);
    // blend1's mode 19 branch, up to mode 20's
    const at = glsl.indexOf("if (mode == 19)"), end = glsl.indexOf("if (mode == 20)");
    let hardMix = null;
    try { hardMix = at >= 0 && end > at ? new Function("step", `return (mode, b, s) => { ${toJs(glsl.slice(at, end))} return -1; };`)(step) : null; } catch (_) { hardMix = null; }
    let bad = 0, first = "";
    if (hardMix) {
        for (let b8 = 0; b8 < 256; b8++) for (let s8 = 0; s8 < 256; s8++) {
            const got = hardMix(19, Math.fround(b8 / 255), Math.fround(s8 / 255));
            const want = b8 + s8 >= 255 + (s8 >> 7) ? 1 : 0;
            if (got !== want && !bad++) first = `b ${b8} s ${s8}: ${got}, want ${want}`;
        }
    }
    check("GLSL blend1 hard mix gives the kernel's rule on every byte pair (Photoshop's tie)", !!hardMix && bad === 0,
        hardMix ? (bad ? `${bad} off, first ${first}` : "65,536 pairs") : "could not read the mode 19 branch of BLEND_FN_GLSL");
    // bm_clip, with bm_setLum's c + (l - lum(c)) in float32 around it
    const clipSrc = (glsl.match(/vec3 bm_clip\(vec3 c\) \{([\s\S]*?)\n\}/) || [])[1];
    let clip = null;
    try { clip = clipSrc ? new Function("bm_lum", `return (c) => { ${toJs(clipSrc)} };`) : null; } catch (_) { clip = null; }
    const f = Math.fround, W = [f(0.3), f(0.59), f(0.11)];
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const lumOf = (order, fused) => (c) => {
        const [i, j, k] = order;
        let acc = f(W[i] * c[i]);
        acc = fused ? f(W[j] * c[j] + acc) : f(acc + f(W[j] * c[j]));
        return fused ? f(W[k] * c[k] + acc) : f(acc + f(W[k] * c[k]));
    };
    let nan = 0, off = 0, cases = 0, firstClip = "";
    const probe = (c, t, what) => {
        cases++;
        if (c.some((x) => Number.isNaN(x))) { if (!nan++ && !off) firstClip = `${what}: NaN`; }
        else if (c.some((x) => Math.abs(x - t) > 1e-5)) { if (!off++ && !nan) firstClip = `${what}: ${c.join(", ")}`; }
    };
    if (clip) {
        for (const order of orders) for (const fused of [false, true]) {
            const lum = lumOf(order, fused), run = clip(lum), how = `${order.join("")}${fused ? " fused" : ""}`;
            // setLum of every grey level to a few targets (0: a transparent or black source in luminosity mode)
            for (let g = 0; g < 256; g++) for (const t of [0, 1, f(29 / 255), f(116 / 255)]) {
                const v = f(g / 255), d = f(t - lum([v, v, v])), w = f(v + d);
                probe(run([w, w, w]), t, `grey ${g} to ${t}, ${how}`);
            }
            // greys a few ulps outside 0..1 straight into the clip: both branches meet l == n and l == x there
            for (let k = 1; k <= 64; k++) {
                const above = f(1 + k * 2 ** -23), below = f(-k * 2 ** -30);
                probe(run([above, above, above]), 1, `grey 1 + ${k} ulp, ${how}`);
                probe(run([below, below, below]), 0, `grey -${k} * 2^-30, ${how}`);
            }
        }
    }
    check("GLSL bm_clip keeps an exactly grey colour grey, no 0 / 0, in every float32 order of the luminosity sum", !!clip && nan === 0 && off === 0,
        clip ? (nan || off ? `${nan} NaN, ${off} off, first ${firstClip}` : `${cases} cases`) : "could not read bm_clip from BLEND_FN_GLSL");
}

async function tierCCases(js, simd, scalar, ref) {
    const TIER_C_MODES = ["hue", "saturation", "color", "luminosity", "darker-color", "lighter-color"];
    const TIER_C_OPS = [24, 25, 26, 27, 28, 29];

    // 1. All 65,536 grey pairs
    const dstGrey = new Uint8Array(65536 * 4), srcGrey = new Uint8Array(65536 * 4);
    for (let bg = 0; bg < 256; bg++) for (let sg = 0; sg < 256; sg++) {
        const i = (bg * 256 + sg) * 4;
        dstGrey[i] = bg; dstGrey[i + 1] = bg; dstGrey[i + 2] = bg; dstGrey[i + 3] = 255;
        srcGrey[i] = sg; srcGrey[i + 1] = sg; srcGrey[i + 2] = sg; srcGrey[i + 3] = 255;
    }
    for (let m = 0; m < 6; m++) {
        const op = TIER_C_OPS[m], name = TIER_C_MODES[m];
        const want = ref.compositeTile(dstGrey.slice(), [srcGrey], [op], [255], null);
        const outJ = js.compositeTile(dstGrey.slice(), [srcGrey], [op], [255], null);
        const outS = simd.compositeTile(dstGrey.slice(), [srcGrey], [op], [255], null);
        const outC = scalar.compositeTile(dstGrey.slice(), [srcGrey], [op], [255], null);
        const ok = eqBytes(outJ, want) && eqBytes(outS, want) && eqBytes(outC, want);
        check(`Tier C ${name} over all 65,536 grey pairs equals BigInt reference (twin, simd, scalar)`, ok, firstDiff(outJ, want));
    }

    // 2. Edge sets: primaries and secondaries, black & white backdrops, equal max/min, darker/lighter ties
    const pairs = [];
    const corners = [];
    for (const r of [0, 255]) for (const g of [0, 255]) for (const bl of [0, 255]) corners.push([r, g, bl]);
    for (const b of corners) for (const s of corners) pairs.push({ b, s });
    for (const bw of [[0, 0, 0], [255, 255, 255]]) {
        for (let v = 0; v < 256; v += 15) {
            pairs.push({ b: bw, s: [v, 255 - v, (v * 7) & 255] });
            pairs.push({ b: [v, 255 - v, (v * 7) & 255], s: bw });
        }
    }
    for (let v1 = 0; v1 < 256; v1 += 17) {
        for (let v2 = 0; v2 < 256; v2 += 17) {
            for (const b of [[v1, v1, v2], [v1, v2, v1], [v2, v1, v1], [v1, v2, v2], [v2, v1, v2], [v2, v2, v1]]) {
                for (const s of [[v2, v2, v1], [v1, v2, v1]]) {
                    pairs.push({ b, s });
                }
            }
        }
    }
    for (let r = 0; r < 256; r += 16) {
        for (let g = 0; g < 256; g += 16) {
            const b = [r, g, 100];
            const s = [g, 100, r];
            pairs.push({ b, s });
            pairs.push({ b: [100, r, g], s: [r, g, 100] });
        }
    }

    const numEdges = pairs.length;
    const dstEdgeO = new Uint8Array(numEdges * 4), srcEdgeO = new Uint8Array(numEdges * 4);
    const dstEdgeT = new Uint8Array(numEdges * 4), srcEdgeT = new Uint8Array(numEdges * 4);
    const maskEdge = new Uint8Array(numEdges);
    for (let i = 0; i < numEdges; i++) {
        const { b, s } = pairs[i];
        dstEdgeO[i * 4] = b[0]; dstEdgeO[i * 4 + 1] = b[1]; dstEdgeO[i * 4 + 2] = b[2]; dstEdgeO[i * 4 + 3] = 255;
        srcEdgeO[i * 4] = s[0]; srcEdgeO[i * 4 + 1] = s[1]; srcEdgeO[i * 4 + 2] = s[2]; srcEdgeO[i * 4 + 3] = 255;

        dstEdgeT[i * 4] = b[0]; dstEdgeT[i * 4 + 1] = b[1]; dstEdgeT[i * 4 + 2] = b[2]; dstEdgeT[i * 4 + 3] = (i * 37) % 256;
        srcEdgeT[i * 4] = s[0]; srcEdgeT[i * 4 + 1] = s[1]; srcEdgeT[i * 4 + 2] = s[2]; srcEdgeT[i * 4 + 3] = (i * 53) % 256;
        maskEdge[i] = (i * 71) % 256;
    }

    for (let m = 0; m < 6; m++) {
        const op = TIER_C_OPS[m], name = TIER_C_MODES[m];
        let ok = true, detail = "";
        for (const [dst, src, o, mask] of [
            [dstEdgeO, srcEdgeO, 255, null],
            [dstEdgeO, srcEdgeO, 140, [maskEdge]],
            [dstEdgeT, srcEdgeT, 255, [maskEdge]],
            [dstEdgeT, srcEdgeT, 140, null],
        ]) {
            const want = ref.compositeTile(dst.slice(), [src], [op], [o], mask);
            const outJ = js.compositeTile(dst.slice(), [src], [op], [o], mask);
            const outS = simd.compositeTile(dst.slice(), [src], [op], [o], mask);
            const outC = scalar.compositeTile(dst.slice(), [src], [op], [o], mask);
            if (!eqBytes(outJ, want) || !eqBytes(outS, want) || !eqBytes(outC, want)) {
                ok = false;
                detail = `failed at opacity ${o} masked ${!!mask} diff ${firstDiff(outJ, want)}`;
                break;
            }
        }
        check(`Tier C ${name} edge sets match BigInt reference across opacity/mask/backdrop combos`, ok, detail);
    }

    // 3. 2^18 random triplet pairs
    const N18 = 1 << 18;
    const countPerOp = Math.floor(N18 / 6);
    let randOk = true, randDetail = "";
    for (let m = 0; m < 6; m++) {
        const op = TIER_C_OPS[m];
        const seed = 5000 + m * 100;
        const dstO = pixelRow(countPerOp, seed, { opaque: true });
        const srcO = pixelRow(countPerOp, seed + 1, { opaque: true });
        const dstT = pixelRow(countPerOp, seed + 2, { opaque: false });
        const srcT = pixelRow(countPerOp, seed + 3, { opaque: false });
        const mask = [randomMask(countPerOp, seed + 4)];

        const configs = [
            [dstO, srcO, 255, null],
            [dstO, srcO, 140, mask],
            [dstT, srcT, 255, mask],
            [dstT, srcT, 140, null],
        ];
        const [d, s, o, mk] = configs[m % 4];
        const want = ref.compositeTile(d.slice(), [s], [op], [o], mk);
        const outJ = js.compositeTile(d.slice(), [s], [op], [o], mk);
        const outS = simd.compositeTile(d.slice(), [s], [op], [o], mk);
        const outC = scalar.compositeTile(d.slice(), [s], [op], [o], mk);
        if (!eqBytes(outJ, want) || !eqBytes(outS, want) || !eqBytes(outC, want)) {
            randOk = false;
            randDetail = `op ${op} (${TIER_C_MODES[m]}) diff: ${firstDiff(outJ, want)}`;
            break;
        }
    }
    check("Tier C 2^18 random triplet pairs: twin == px.wasm == px_scalar.wasm == BigInt reference (0 differ)", randOk, randDetail);
}

// ---- the colour match (B item 7 part 3) ----------------------------------------------------------

/** meanS, meanT, scale, k as a run's statistics have them: means 0..255, scale 0.5..2, k 0..1. */
function matchParams(seed) {
    const r = rng(seed);
    const p = new Float32Array(10);
    for (let i = 0; i < 6; i++) p[i] = r() * 255;
    for (let i = 6; i < 9; i++) p[i] = 0.5 + r() * 1.5;
    p[9] = [0, 1, 0.5, 0.25, 0.8, r()][seed % 6];
    return p;
}

/** matchCanvas' formula in doubles, with Uint8ClampedArray's rounding (half to even), on a copy. */
function matchDoubles(rgba, p) {
    const out = new Uint8ClampedArray(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
        out[i + 3] = rgba[i + 3];
        for (let c = 0; c < 3; c++) {
            if (!rgba[i + 3]) { out[i + c] = rgba[i + c]; continue; }
            const v = rgba[i + c], m = (v - p[3 + c]) * p[6 + c] + p[c];
            out[i + c] = Math.max(0, Math.min(255, v + (m - v) * p[9]));
        }
    }
    return new Uint8Array(out.buffer);
}

/** The twin against doubles (within a level), the identities, and what it must leave alone. */
async function matchTwinCases(js) {
    let worst = 0, over = 0, alphaMoved = 0, clearMoved = 0, n = 0;
    for (let seed = 0; seed < 24; seed++) {
        const p = matchParams(seed), src = pixelRow(4099 + seed, 500 + seed);
        const a = js.matchPixels(src.slice(), p), b = matchDoubles(src, p);
        for (let i = 0; i < a.length; i++) {
            const e = Math.abs(a[i] - b[i]);
            if ((i & 3) === 3) { if (a[i] !== src[i]) alphaMoved++; continue; }
            if (!src[(i | 3)]) { if (a[i] !== src[i]) clearMoved++; continue; }
            n++;
            if (e > worst) worst = e;
            if (e > 1) over++;
        }
    }
    check(`js matchPixels within a level of matchCanvas' doubles`, worst <= 1 && over === 0 && n > 50000, `worst ${worst}, over ${over} of ${n}`);
    check(`js matchPixels leaves alpha and fully transparent pixels alone`, alphaMoved === 0 && clearMoved === 0, `alpha moved ${alphaMoved}, transparent moved ${clearMoved}`);
    const src = pixelRow(2048, 9), p0 = matchParams(3);
    p0[9] = 0;
    check(`js matchPixels at k = 0 is the identity`, eqBytes(js.matchPixels(src.slice(), p0), src));
    const p1 = new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    check(`js matchPixels with meanS = meanT and scale 1 is the identity`, eqBytes(js.matchPixels(src.slice(), p1), src));
    const p2 = new Float32Array([250, 250, 250, 5, 5, 5, 2, 2, 2, 1]);
    const hi = js.matchPixels(src.slice(), p2);
    let clamped = true;
    for (let i = 0; i < hi.length; i += 4) if (src[i + 3] && src[i] > 60 && hi[i] !== 255) clamped = false;
    check(`js matchPixels clamps at 255`, clamped);
    // the same bytes from a Uint8ClampedArray
    const clamp = (u) => new Uint8ClampedArray(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength));
    const p5 = matchParams(5);
    const viaBytes = js.matchPixels(src.slice(), p5), viaClamped = js.matchPixels(clamp(src), p5);
    check(`js matchPixels gives the same bytes for Uint8ClampedArray input`, eqBytes(viaBytes, new Uint8Array(viaClamped.buffer)));
}

/** The twin against a Rust build, bit for bit: random pixels and parameters, sizes with tails, every k. */
async function matchCases(px, label, js) {
    let ok = true, detail = "";
    for (const pixels of [65536, 1, 3, 4, 5, 16, 1000, 1003, 4099]) {
        for (let trial = 0; trial < 12; trial++) {
            const p = matchParams(trial + pixels);
            const src = pixelRow(pixels, 700 + trial + pixels, { opaque: trial % 4 === 0 });
            if (trial % 5 === 1) for (let i = 3; i < src.length; i += 16) src[i] = 0;   // transparent pixels among the rest
            const a = js.matchPixels(src.slice(), p), b = px.matchPixels(src.slice(), p);
            if (!eqBytes(a, b)) { ok = false; detail = `${pixels}px trial ${trial} k ${p[9]} ${firstDiff(a, b)}`; }
        }
    }
    check(`js matchPixels equals the ${label} (random pixels and statistics, tails, k 0 to 1)`, ok, detail);
    // the extremes: scale 2 and 0.5, means at the ends, k 1
    let okX = true, detailX = "";
    for (const p of [[255, 255, 255, 0, 0, 0, 2, 2, 2, 1], [0, 0, 0, 255, 255, 255, 0.5, 0.5, 0.5, 1], [128, 64, 32, 32, 64, 128, 1.999, 0.501, 1, 0.999], [127.5, 127.5, 127.5, 127.5, 127.5, 127.5, 1, 1, 1, 0.5]]) {
        const pf = new Float32Array(p), src = pixelRow(8192, 77);
        const a = js.matchPixels(src.slice(), pf), b = px.matchPixels(src.slice(), pf);
        if (!eqBytes(a, b)) { okX = false; detailX = `${p} ${firstDiff(a, b)}`; }
    }
    check(`js matchPixels equals the ${label} at the extremes of the statistics`, okX, detailX);
    if (/rust/.test(label)) {
        const N = 1 << 20, srcT = pixelRow(N, 5, { opaque: true }), p = matchParams(2);
        const best = (k) => { let b = Infinity; for (let i = 0; i < 5; i++) { const w = srcT.slice(), t0 = performance.now(); k.matchPixels(w, p); b = Math.min(b, performance.now() - t0); } return b; };
        console.log(`       a megapixel matched: ${label} ${best(px).toFixed(1)} ms, twin ${best(js).toFixed(1)}`);
    }
}

// ---- the smudge's dab (PLAN_0_1_31 §4 step 3) --------------------------------------------------

/** The smudge dab in doubles, from the formulas of crates/px/src/smudge.rs without its integers: straight bytes in, straight doubles out (the carry premultiplied, 0..1). */
function smudgeDoubles(dst, src, carry, mask, strength, keep, flags) {
    const n = mask.length, out = Float64Array.from(dst), c2 = new Float64Array(n * 4);
    const s = strength / 65536, kp = keep / 65536, lock = flags & 1;
    for (let k = 0; k < n; k++) {
        const o = k * 4, sa = src[o + 3] / 255;
        const S = [src[o] / 255 * sa, src[o + 1] / 255 * sa, src[o + 2] / 255 * sa, sa];
        const C = [carry[o] / 65535, carry[o + 1] / 65535, carry[o + 2] / 65535, carry[o + 3] / 65535];
        if (flags & 2) { for (let c = 0; c < 4; c++) c2[o + c] = S[c]; continue; }
        const a = s * mask[k] / 255;
        if (a > 0) {
            const ta = dst[o + 3] / 255;
            const T = [dst[o] / 255 * ta, dst[o + 1] / 255 * ta, dst[o + 2] / 255 * ta, ta];
            const N = T.map((v, c) => v + (C[c] - v) * a);
            if (N[3] > 0.5 / 255 && !(lock && !dst[o + 3])) {
                for (let c = 0; c < 3; c++) out[o + c] = Math.min(255, N[c] / N[3] * 255);
                out[o + 3] = lock ? dst[o + 3] : N[3] * 255;
            } else if (!lock) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; }
        }
        for (let c = 0; c < 4; c++) { const P = S[c] + (C[c] - S[c]) * a; c2[o + c] = P + (C[c] - P) * kp; }
    }
    return { out, carry: c2 };
}

function smudgeInputs(n, seed) {
    const r = rng(seed);
    const dst = pixelRow(n, seed), src = pixelRow(n, seed + 1000), mask = randomMask(n, seed + 2000);
    // a carry picked up from something else: premultiplied, so each colour is at most its alpha
    const carry = new Uint16Array(n * 4);
    for (let k = 0; k < n; k++) {
        const a = r() < 0.2 ? 0 : r() < 0.3 ? 65535 : Math.floor(r() * 65536);
        carry[k * 4 + 3] = a;
        for (let c = 0; c < 3; c++) carry[k * 4 + c] = Math.floor(r() * (a + 1));
    }
    return { dst, src, mask, carry };
}

async function smudgeTwinCases(js) {
    // against the doubles: within a level on what is laid down, within a 16-bit unit or two on the carry
    let worst = 0, worstC = 0, n = 0, lockMoved = 0, uncovered = 0;
    for (let seed = 1; seed <= 24; seed++) {
        const { dst, src, mask, carry } = smudgeInputs(1500 + seed * 7, seed);
        const strength = [0, 1, 65536, 32768, 65535][seed % 5] || Math.floor(rng(seed)() * 65537);
        const keep = [0, 65536, 20000, 50000][seed % 4];
        const flags = seed % 3 === 0 ? 1 : 0;
        const d = dst.slice(), c = carry.slice();
        js.smudgeDab(d, src, c, mask, strength, keep, flags);
        const ref = smudgeDoubles(dst, src, carry, mask, strength, keep, flags);
        for (let k = 0; k < mask.length; k++) {
            const o = k * 4, a = Math.floor((Math.min(65536, strength) * mask[k] + 127) / 255);
            if (!a) { for (let q = 0; q < 4; q++) if (d[o + q] !== dst[o + q]) uncovered++; }
            if (flags & 1 && d[o + 3] !== dst[o + 3]) lockMoved++;
            // a colour at a tiny alpha has no level to speak of: compare where the result is at least 4 in alpha
            if (d[o + 3] >= 4) for (let q = 0; q < 4; q++) { const e = Math.abs(d[o + q] - ref.out[o + q]); if (e > worst) worst = e; }
            for (let q = 0; q < 4; q++) { const e = Math.abs(c[o + q] / 65535 - ref.carry[o + q]) * 65535; if (e > worstC) worstC = e; }
            n++;
        }
    }
    check(`js smudgeDab within a level of its doubles (what is laid down; alpha at least 4)`, worst <= 1.5, `worst ${worst.toFixed(3)} of ${n} pixels`);
    check(`js smudgeDab's carry within two 16-bit units of its doubles`, worstC <= 2, `worst ${worstC.toFixed(3)}`);
    check(`js smudgeDab leaves what the dab does not cover, and the alpha under alpha lock`, uncovered === 0 && lockMoved === 0, `uncovered moved ${uncovered}, alpha moved ${lockMoved}`);
    // the exact cases
    const { dst, src, mask, carry } = smudgeInputs(4096, 77);
    const d0 = dst.slice(), c0 = carry.slice();
    js.smudgeDab(d0, src, c0, mask, 65536, 65536, 0);
    check(`js smudgeDab with keep 1 leaves the carry as it was`, eqBytes(c0, carry));
    const d1 = dst.slice(), c1 = carry.slice();
    js.smudgeDab(d1, src, c1, mask, 0, 0, 0);
    let pickedUp = true;
    for (let k = 0; k < 4096 && pickedUp; k++) { const o = k * 4, a = src[o + 3]; for (let c = 0; c < 3; c++) if (c1[o + c] !== Math.floor((src[o + c] * a * 257 + 127) / 255)) pickedUp = false; if (c1[o + 3] !== a * 257) pickedUp = false; }
    check(`js smudgeDab at strength 0 lays nothing down, and at keep 0 the carry is what lies there`, eqBytes(d1, dst) && pickedUp);
    const d2 = dst.slice(), c2 = carry.slice();
    js.smudgeDab(d2, src, c2, mask, 65536, 0, 2);
    let premul = true;
    for (let k = 0; k < 4096; k++) for (let c = 0; c < 3; c++) if (c2[k * 4 + c] > c2[k * 4 + 3]) premul = false;
    check(`js smudgeDab's pickup fills the carry and lays nothing down; the carry stays premultiplied`, eqBytes(d2, dst) && eqBytes(c2, c1) && premul);
    // at full strength and coverage the layer becomes the carry: the round trip of a picked-up pixel is the identity
    const full = new Uint8Array(4096).fill(255), d3 = pixelRow(4096, 90), c3 = new Uint16Array(4096 * 4);
    js.smudgeDab(d3.slice(), src, c3, full, 65536, 0, 2);
    const d4 = d3.slice();
    js.smudgeDab(d4, d4.slice(), c3, full, 65536, 0, 0);
    let same = true;
    for (let k = 0; k < 4096; k++) { const o = k * 4; if (src[o + 3] === 0) { if (d4[o + 3] !== 0) same = false; } else for (let c = 0; c < 4; c++) if (d4[o + c] !== src[o + c]) same = false; }
    check(`js smudgeDab at full strength lays the carry down byte for byte (the 16-bit round trip is exact)`, same);
}

/** The twin against a Rust build, bit for bit: single dabs over random input, and a stroke of dabs whose carry goes on. */
async function smudgeCases(px, label, js) {
    let ok = true, detail = "";
    for (const n of [1, 3, 16, 1000, 4099, 65536]) {
        for (let trial = 0; trial < 8; trial++) {
            const { dst, src, mask, carry } = smudgeInputs(n, 300 + trial + n);
            const strength = [0, 65536, 12345, 65535, 40000, 1, 30000, 65536][trial], keep = [0, 65536, 32768, 1, 60000, 0, 12000, 65535][trial];
            const flags = [0, 1, 2, 3, 0, 1, 0, 1][trial];
            const da = dst.slice(), ca = carry.slice(), db = dst.slice(), cb = carry.slice();
            js.smudgeDab(da, src, ca, mask, strength, keep, flags);
            px.smudgeDab(db, src, cb, mask, strength, keep, flags);
            if (!eqBytes(da, db) || !eqBytes(ca, cb)) { ok = false; detail = `${n}px trial ${trial}: dst ${firstDiff(da, db)} carry ${firstDiff(ca, cb)}`; }
        }
    }
    check(`js smudgeDab equals the ${label} (random pixels, carries, masks; strength, keep, alpha lock, pickup)`, ok, detail);
    // a stroke: 40 dabs over a 64 x 64 box, the layer's bytes shifted under a carry that goes on
    let okS = true, detailS = "";
    const w = 64, n = w * w;
    let la = pixelRow(n, 5), lb = la.slice();
    const ca = new Uint16Array(n * 4), cb = new Uint16Array(n * 4), m = randomMask(n, 8);
    for (let i = 0; i < 40 && okS; i++) {
        const shift = (bytes) => { const o = new Uint8Array(bytes.length); o.set(bytes.subarray(4 * (i % 3 + 1)), 0); return o; };
        la = shift(la); lb = shift(lb);
        js.smudgeDab(la, la.slice(), ca, m, 45000, 20000, i === 0 ? 2 : i % 7 === 3 ? 1 : 0);
        px.smudgeDab(lb, lb.slice(), cb, m, 45000, 20000, i === 0 ? 2 : i % 7 === 3 ? 1 : 0);
        if (!eqBytes(la, lb) || !eqBytes(ca, cb)) { okS = false; detailS = `dab ${i}: ${firstDiff(la, lb)} / ${firstDiff(ca, cb)}`; }
    }
    check(`js smudgeDab equals the ${label} over a stroke of 40 dabs whose carry goes on`, okS, detailS);
    // a Uint8ClampedArray layer (what readRect gives) and a view into a larger buffer
    const big = new Uint8ClampedArray(8 + n * 4);
    big.set(pixelRow(n, 11), 8);
    const view = new Uint8ClampedArray(big.buffer, 8, n * 4), plain = new Uint8Array(view);
    const cv = new Uint16Array(n * 4), cp = new Uint16Array(n * 4);
    px.smudgeDab(view, plain.slice(), cv, m, 30000, 0, 2);
    js.smudgeDab(plain, plain.slice(), cp, m, 30000, 0, 2);
    px.smudgeDab(view, view.slice(), cv, m, 30000, 9000, 0);
    js.smudgeDab(plain, plain.slice(), cp, m, 30000, 9000, 0);
    check(`${label} smudgeDab takes a Uint8ClampedArray view and gives the twin's bytes`, eqBytes(new Uint8Array(view.buffer, 8, n * 4), plain) && eqBytes(cv, cp) && big[0] === 0);
    if (/rust/.test(label)) {
        const N = 400 * 400, t = smudgeInputs(N, 3);
        const best = (k) => { let b = Infinity; for (let i = 0; i < 5; i++) { const d = t.dst.slice(), c = t.carry.slice(), t0 = performance.now(); k.smudgeDab(d, t.src, c, t.mask, 40000, 20000, 0); b = Math.min(b, performance.now() - t0); } return b; };
        console.log(`       a 400 px dab smudged: ${label} ${best(px).toFixed(2)} ms, twin ${best(js).toFixed(2)}`);
    }
}

// ---- the healing brush's Poisson solver (PLAN_0_1_31 §5 step 1) --------------------------------

const P_NONE = 0, P_UNKNOWN = 1, P_FIXED = 2;
const P_STEPS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

/** Textured straight RGBA, opaque: a wave of its own per channel plus noise, within lo..hi. */
function poissonTexture(w, h, seed, lo = 0, hi = 255) {
    const r = rng(seed), d = new Uint8Array(w * h * 4);
    const fx = 0.04 + r() * 0.2, fy = 0.04 + r() * 0.2, ph = r() * 6, mid = (lo + hi) / 2, amp = (hi - lo) / 2;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
        for (let c = 0; c < 3; c++) {
            const v = mid + amp * (0.6 * Math.sin(x * fx * (1 + 0.3 * c) + y * fy + ph + c) + 0.4 * (r() * 2 - 1));
            d[i + c] = Math.max(lo, Math.min(hi, Math.round(v)));
        }
        d[i + 3] = 255;
    }
    return d;
}

/** `tex` under other light: an offset and a gradient per channel, clipped at 0 and 255. */
function poissonLit(tex, w, h, off, gx, gy) {
    const d = tex.slice();
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4)
        for (let c = 0; c < 3; c++) d[i + c] = Math.max(0, Math.min(255, Math.round(tex[i + c] + off[c] + gx[c] * x + gy[c] * y)));
    return d;
}

/**
 * A heal the source's transparency splits into strands (a cut-out of hair, a fence: the review of 2026-09-28): a disc of
 * mask over vertical strands `on` px wide with `off` px clear between them, where the source is clear and so is the mask.
 */
function poissonStrands(w, h, on, off, seed) {
    const src = poissonTexture(w, h, seed, 40, 200), dst = poissonLit(poissonTexture(w, h, seed + 1, 40, 200), w, h, [30, -20, 10], [0.1, 0, -0.05], [0, 0.08, 0]);
    const disc = poissonMask(w, h, discCover(w / 2, h / 2, Math.min(w, h) * 0.45)), mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const k = y * w + x;
        if (x % (on + off) >= on) src[k * 4 + 3] = 0;
        else if (disc[k]) mask[k] = disc[k];
    }
    return { w, h, dst, src, mask, name: `strands ${on} / ${off}` };
}

/** A mask from a coverage function: 0 where it is at most 0, 1 to 255 above (a soft edge gives the small values). */
function poissonMask(w, h, cover) {
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = cover(x, y);
        m[y * w + x] = v > 0 ? Math.max(1, Math.min(255, Math.round(v * 255))) : 0;
    }
    return m;
}
const discCover = (cx, cy, r, soft = 1.5) => (x, y) => (r - Math.hypot(x - cx, y - cy)) / soft + 0.5;
function capsuleCover(x0, y0, x1, y1, width, soft = 1.5) {
    const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
    return (x, y) => {
        const t = l2 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l2)) : 0;
        return (width / 2 - Math.hypot(x - x0 - t * dx, y - y0 - t * dy)) / soft + 0.5;
    };
}

/**
 * The Poisson blend in doubles, from the stated equations and not from any kernel's code. Pixels are UNKNOWN where the
 * mask is set, FIXED where it is not and both layers have alpha 8 or more (u = dst - src there), NONE otherwise (and outside the
 * box). Per RGB channel, at every unknown p: n_p u_p - (sum of u_q over p's 4-neighbours q that are not NONE) = 0, n_p
 * their count. A 4-connected region of unknowns that touches a FIXED pixel is symmetric positive definite and solved by
 * conjugate gradients to a largest residual below 1e-10; a region that touches none is singular and keeps the solver's
 * start (the plain mean of the FIXED pixels with an UNKNOWN neighbour, each pixel once, or 0). Returns the rounded
 * bytes, u (three doubles a pixel, 0 off the unknowns), the start and the CG steps.
 */
function poissonDoubles(dst, src, mask, w, h) {
    const n = w * h, kind = new Uint8Array(n), nbs = new Array(n);
    for (let p = 0; p < n; p++) kind[p] = mask[p] > 0 ? P_UNKNOWN : dst[p * 4 + 3] >= 8 && src[p * 4 + 3] >= 8 ? P_FIXED : P_NONE;
    const start = [0, 0, 0];
    let edge = 0;
    for (let p = 0; p < n; p++) {
        if (kind[p] === P_NONE) continue;
        const x = p % w, y = (p - x) / w;
        nbs[p] = [];
        for (const [dx, dy] of P_STEPS) {
            const qx = x + dx, qy = y + dy;
            if (qx < 0 || qy < 0 || qx >= w || qy >= h || kind[qy * w + qx] === P_NONE) continue;
            nbs[p].push(qy * w + qx);
        }
        if (kind[p] === P_FIXED && nbs[p].some((q) => kind[q] === P_UNKNOWN)) {
            edge++;
            for (let c = 0; c < 3; c++) start[c] += dst[p * 4 + c] - src[p * 4 + c];
        }
    }
    if (edge) for (let c = 0; c < 3; c++) start[c] /= edge;
    // the regions of unknowns; only the ones that touch a FIXED pixel go into the system
    const local = new Int32Array(n).fill(-1), order = [], seen = new Uint8Array(n);
    for (let p0 = 0; p0 < n; p0++) {
        if (kind[p0] !== P_UNKNOWN || seen[p0]) continue;
        const region = [p0];
        let fixed = false;
        seen[p0] = 1;
        for (let i = 0; i < region.length; i++) for (const q of nbs[region[i]]) {
            if (kind[q] === P_FIXED) fixed = true;
            else if (!seen[q]) { seen[q] = 1; region.push(q); }
        }
        if (fixed) for (const p of region) { local[p] = order.length; order.push(p); }
    }
    const u = new Float64Array(n * 3);
    for (let p = 0; p < n; p++) if (kind[p] === P_UNKNOWN) for (let c = 0; c < 3; c++) u[p * 3 + c] = start[c];
    const m = order.length;
    let iterations = 0;
    if (m) {
        const deg = new Float64Array(m), off = new Int32Array(m + 1), adj = [], rhs = [new Float64Array(m), new Float64Array(m), new Float64Array(m)];
        for (let i = 0; i < m; i++) {
            const p = order[i];
            deg[i] = nbs[p].length;
            for (const q of nbs[p]) {
                if (kind[q] === P_FIXED) for (let c = 0; c < 3; c++) rhs[c][i] += dst[q * 4 + c] - src[q * 4 + c];
                else adj.push(local[q]);
            }
            off[i + 1] = adj.length;
        }
        const apply = (v, into) => {
            for (let i = 0; i < m; i++) {
                let s = deg[i] * v[i];
                for (let k = off[i]; k < off[i + 1]; k++) s -= v[adj[k]];
                into[i] = s;
            }
        };
        const dot = (a, b) => { let s = 0; for (let i = 0; i < m; i++) s += a[i] * b[i]; return s; };
        const x = new Float64Array(m), r = new Float64Array(m), d = new Float64Array(m), q = new Float64Array(m);
        for (let c = 0; c < 3; c++) {
            x.fill(start[c]);
            apply(x, q);
            for (let i = 0; i < m; i++) d[i] = r[i] = rhs[c][i] - q[i];
            let rr = dot(r, r);
            for (let it = 0; ; it++) {
                let worst = 0;
                for (let i = 0; i < m; i++) worst = Math.max(worst, Math.abs(r[i]));
                if (worst < 1e-10) break;
                if (it > 20 * m + 1000) throw new Error(`poissonDoubles: CG did not converge (${m} unknowns, residual ${worst})`);
                apply(d, q);
                const alpha = rr / dot(d, q);
                for (let i = 0; i < m; i++) { x[i] += alpha * d[i]; r[i] -= alpha * q[i]; }
                const rr2 = dot(r, r), beta = rr2 / rr;
                rr = rr2;
                for (let i = 0; i < m; i++) d[i] = r[i] + beta * d[i];
                iterations++;
            }
            for (let i = 0; i < m; i++) u[order[i] * 3 + c] = x[i];
        }
    }
    const out = new Uint8Array(n * 4);
    for (let p = 0; p < n; p++) {
        const o = p * 4;
        if (!(mask[p] > 0)) { for (let c = 0; c < 4; c++) out[o + c] = dst[o + c]; continue; }
        if (!src[o + 3]) continue;
        for (let c = 0; c < 3; c++) out[o + c] = Math.max(0, Math.min(255, Math.floor(src[o + c] + u[p * 3 + c] + 0.5)));
        out[o + 3] = src[o + 3];
    }
    return { out, u, start, iterations };
}

/** The largest |n_p u_p - sum over the neighbours| over the unknowns, straight from the definition (its own classes). */
function poissonResidual(u, dst, src, mask, w, h) {
    const kindAt = (x, y) => {
        if (x < 0 || y < 0 || x >= w || y >= h) return P_NONE;
        const p = y * w + x;
        return mask[p] > 0 ? P_UNKNOWN : dst[p * 4 + 3] >= 8 && src[p * 4 + 3] >= 8 ? P_FIXED : P_NONE;
    };
    let worst = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!(mask[p] > 0)) continue;
        for (let c = 0; c < 3; c++) {
            let s = 0, k = 0;
            for (const [dx, dy] of P_STEPS) {
                const kq = kindAt(x + dx, y + dy), q = (y + dy) * w + x + dx;
                if (kq === P_NONE) continue;
                k++;
                s += kq === P_FIXED ? dst[q * 4 + c] - src[q * 4 + c] : u[q * 3 + c];
            }
            worst = Math.max(worst, Math.abs(k * u[p * 3 + c] - s));
        }
    }
    return worst;
}

/** A hole enclosed by fixed pixels whose difference is a plane with whole coefficients (no clipping): u is that plane. */
function poissonLinearScene() {
    const w = 100, h = 80, src = poissonTexture(w, h, 51, 90, 130), dst = src.slice();
    const plane = (x, y, c) => [x - 40, 30 - y, x - y][c];
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) for (let c = 0; c < 3; c++) dst[i + c] = src[i + c] + plane(x, y, c);
    return { w, h, src, dst, mask: poissonMask(w, h, discCover(50, 40, 25, 2)), plane };
}

/** The scenes a heal meets: discs, blobs, thin strokes, a ring round an island, the box edge, transparency on the boundary, soft masks, strips, clipping. */
function poissonScenes() {
    const scenes = [];
    const add = (name, w, h, seed, cover, { off = [35, -25, 50], grad = 0.6, edit = null } = {}) => {
        const src = poissonTexture(w, h, seed);
        const dst = poissonLit(poissonTexture(w, h, seed + 500), w, h, off, [grad, -0.5 * grad, 0.8 * grad], [0.3 * grad, 0.7 * grad, -0.6 * grad]);
        const s = { name, w, h, dst, src, mask: typeof cover === "function" ? poissonMask(w, h, cover) : cover };
        if (edit) edit(s, rng(seed + 900));
        scenes.push(s);
    };
    const alphaWhere = (s, bytes, test, value) => { for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (test(x, y, y * s.w + x)) bytes[(y * s.w + x) * 4 + 3] = value(); };
    add("a disc of radius 5", 20, 20, 1, discCover(9.6, 10.2, 5));
    add("a disc of radius 20", 64, 60, 2, discCover(31, 30, 20, 3));
    add("a disc of radius 60", 140, 136, 3, discCover(70, 67, 60, 6));
    const rb = rng(44);
    add("blobs with random mask values", 96, 72, 4, blobs(96, 72, 4, 4).map((v) => (v ? 1 + Math.floor(rb() * 255) : 0)));
    add("a stroke 3 px wide", 90, 40, 5, capsuleCover(6, 5, 84, 34, 3, 1));
    add("a stroke 9 px wide", 50, 120, 6, capsuleCover(9, 110, 41, 9, 9));
    add("a ring round a fixed island", 80, 80, 7, (x, y) => { const d = Math.hypot(x - 40, y - 40); return Math.min(30 - d, d - 12) / 1.5 + 0.5; });
    add("a disc cut by the box edge", 70, 50, 8, discCover(1, 24, 25));
    add("a disc over a corner", 60, 60, 9, discCover(57, 3, 30));
    add("clear and partial destination on the boundary", 80, 80, 10, discCover(40, 40, 25), {
        edit: (s, r) => {
            alphaWhere(s, s.dst, (x, y) => r() < 0.1, () => 1 + Math.floor(r() * 254));
            alphaWhere(s, s.dst, (x, y) => x >= 4 && x < 30 && y >= 28 && y < 54, () => 0);
        },
    });
    add("clear source patches inside and across the boundary", 80, 64, 11, discCover(40, 32, 22), {
        edit: (s, r) => {
            alphaWhere(s, s.src, (x, y) => r() < 0.1, () => 1 + Math.floor(r() * 254));
            alphaWhere(s, s.src, (x, y) => (x >= 30 && x < 40 && y >= 20 && y < 28) || (x >= 55 && x < 70 && y >= 25 && y < 40), () => 0);
        },
    });
    const rs = rng(1212);
    add("a soft mask throughout", 72, 72, 12, (x, y) => (Math.hypot(x - 36, y - 36) < 28 ? rs() : 0));
    add("two regions, one cut off by transparency", 100, 60, 13, (x, y) => Math.max(discCover(25, 30, 14)(x, y), discCover(72, 30, 12)(x, y)), {
        edit: (s) => alphaWhere(s, s.dst, (x, y, p) => !s.mask[p] && Math.hypot(x - 72, y - 30) < 17, () => 0),
    });
    add("strong light: clipping on both sides", 64, 64, 14, discCover(32, 32, 24), { off: [120, -120, 90], grad: 1.5 });
    add("a mask over all but the top row and the left column", 48, 40, 20, (x, y) => (x > 0 && y > 0 ? 1 : 0));
    add("a wide box with a long stroke", 160, 24, 19, capsuleCover(4, 12, 156, 10, 7));
    add("a 200 x 1 strip, fixed at both ends", 200, 1, 15, (x) => (x >= 20 && x < 180 ? 1 : 0));
    add("a 150 x 1 strip open at one end", 150, 1, 16, (x) => (x >= 60 ? 1 : 0));
    add("a 1 x 150 strip, fixed at both ends", 1, 150, 17, (x, y) => (y >= 30 && y < 130 ? 1 : 0));
    add("a 1 x 90 strip open at one end", 1, 90, 18, (x, y) => (y < 50 ? 1 : 0));
    return scenes;
}

/** The reference against closed forms before it judges anything, then its residual from the definition on the scenes. */
function poissonReferenceCases(scenes, refs) {
    // a plane with whole coefficients in a hole enclosed by fixed pixels: the 5-point Laplacian is exact on it
    const L = poissonLinearScene(), a = poissonDoubles(L.dst, L.src, L.mask, L.w, L.h);
    let e1 = 0;
    for (let p = 0; p < L.w * L.h; p++) if (L.mask[p]) for (let c = 0; c < 3; c++) e1 = Math.max(e1, Math.abs(a.u[p * 3 + c] - L.plane(p % L.w, Math.floor(p / L.w), c)));
    check(`poisson reference: u is the plane in a hole enclosed by fixed pixels`, e1 < 1e-8, `worst ${e1.toExponential(2)}, ${a.iterations} CG steps`);
    // a band from the top edge to the bottom edge, the difference a plane in x only: the rows at the edge (Neumann) keep it
    {
        const w = 90, h = 40, src = poissonTexture(w, h, 61, 60, 190), dst = src.slice();
        const plane = (x, c) => [x - 45, 30 - x, 7][c];
        for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) for (let c = 0; c < 3; c++) dst[i + c] = src[i + c] + plane(x, c);
        const mask = poissonMask(w, h, (x) => (x >= 30 && x < 60 ? 1 : 0)), b = poissonDoubles(dst, src, mask, w, h);
        let e = 0;
        for (let p = 0; p < w * h; p++) if (mask[p]) for (let c = 0; c < 3; c++) e = Math.max(e, Math.abs(b.u[p * 3 + c] - plane(p % w, c)));
        check(`poisson reference: a band across the box keeps a plane in x at the box edge (Neumann)`, e < 1e-8, `worst ${e.toExponential(2)}`);
    }
    // strips: the straight line between two fixed ends; a constant towards an open end
    {
        let e = 0;
        for (const [w, h] of [[120, 1], [1, 120]]) {
            const src = poissonTexture(w, h, 62), dst = poissonLit(poissonTexture(w, h, 63), w, h, [20, -10, 30], [0.5, -0.3, 0.2], [0.5, -0.3, 0.2]);
            const bAt = (i, c) => dst[i * 4 + c] - src[i * 4 + c];
            const both = poissonDoubles(dst, src, Uint8Array.from({ length: 120 }, (_, i) => (i >= 10 && i < 110 ? 200 : 0)), w, h);
            const open = poissonDoubles(dst, src, Uint8Array.from({ length: 120 }, (_, i) => (i >= 30 ? 9 : 0)), w, h);
            for (let c = 0; c < 3; c++) {
                for (let i = 10; i < 110; i++) e = Math.max(e, Math.abs(both.u[i * 3 + c] - (bAt(9, c) + (bAt(110, c) - bAt(9, c)) * (i - 9) / 101)));
                for (let i = 30; i < 120; i++) e = Math.max(e, Math.abs(open.u[i * 3 + c] - bAt(29, c)));
            }
        }
        check(`poisson reference: a strip is the straight line between fixed ends and constant to an open end (1 x N and N x 1)`, e < 1e-8, `worst ${e.toExponential(2)}`);
    }
    // a region cut off by transparency keeps the start: the mean of the fixed pixels next to an unknown, counted by brute force
    {
        const w = 60, h = 40, src = poissonTexture(w, h, 64), dst = poissonLit(poissonTexture(w, h, 65), w, h, [30, -30, 10], [0.4, 0.2, -0.3], [0, 0.5, 0.2]);
        const mask = poissonMask(w, h, (x, y) => Math.max(discCover(15, 20, 8)(x, y), discCover(44, 20, 8)(x, y)));
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!mask[y * w + x] && Math.hypot(x - 44, y - 20) < 12) dst[(y * w + x) * 4 + 3] = 0;
        const sum = [0, 0, 0];
        let count = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const p = y * w + x;
            if (mask[p] || !dst[p * 4 + 3] || !src[p * 4 + 3]) continue;
            if (!P_STEPS.some(([dx, dy]) => x + dx >= 0 && y + dy >= 0 && x + dx < w && y + dy < h && mask[(y + dy) * w + x + dx])) continue;
            count++;
            for (let c = 0; c < 3; c++) sum[c] += dst[p * 4 + c] - src[p * 4 + c];
        }
        const mean = sum.map((s) => s / count), r = poissonDoubles(dst, src, mask, w, h);
        let e = 0, solvedMoved = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const p = y * w + x;
            if (!mask[p]) continue;
            for (let c = 0; c < 3; c++) {
                if (x > 30) e = Math.max(e, Math.abs(r.u[p * 3 + c] - mean[c]));
                else if (Math.abs(r.u[p * 3 + c] - mean[c]) > 1e-3) solvedMoved++;
            }
        }
        check(`poisson reference: a region cut off by transparency keeps the start (the mean of ${count} fixed pixels next to an unknown)`,
            e === 0 && r.start.every((v, c) => Math.abs(v - mean[c]) < 1e-12) && solvedMoved > 0, `worst ${e}, solved values off the start ${solvedMoved}`);
    }
    // the residual from the definition, and the maximum principle: u between the least and the largest difference on the boundary
    let res = 0, outside = 0;
    scenes.forEach((s, k) => {
        res = Math.max(res, poissonResidual(refs[k].u, s.dst, s.src, s.mask, s.w, s.h));
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
            const p = y * s.w + x;
            if (s.mask[p] || !s.dst[p * 4 + 3] || !s.src[p * 4 + 3]) continue;
            if (!P_STEPS.some(([dx, dy]) => x + dx >= 0 && y + dy >= 0 && x + dx < s.w && y + dy < s.h && s.mask[(y + dy) * s.w + x + dx])) continue;
            for (let c = 0; c < 3; c++) { const b = s.dst[p * 4 + c] - s.src[p * 4 + c]; lo[c] = Math.min(lo[c], b); hi[c] = Math.max(hi[c], b); }
        }
        for (let p = 0; p < s.w * s.h; p++) if (s.mask[p]) for (let c = 0; c < 3; c++) {
            const v = refs[k].u[p * 3 + c];
            if (lo[c] === Infinity ? v !== 0 : v < lo[c] - 1e-9 || v > hi[c] + 1e-9) outside++;
        }
    });
    check(`poisson reference: residual from the definition on ${scenes.length} scenes, u within the boundary's range`, res < 1e-8 && outside === 0, `residual ${res.toExponential(2)}, outside the range ${outside}`);
}

/** The twin against the doubles (within a level), the exact cases, and what it must leave alone. */
async function poissonTwinCases(js) {
    const scenes = poissonScenes(), refs = scenes.map((s) => poissonDoubles(s.dst, s.src, s.mask, s.w, s.h));
    poissonReferenceCases(scenes, refs);
    if (typeof js.poissonBlend !== "function") { check(`js poissonBlend exists`, false); return; }
    let worst = 0, where = "", differ = 0, bytes = 0, worstU = 0, alphaBad = 0, outsideBad = 0, infoBad = "", fewest = Infinity, most = 0, slowest = "";
    scenes.forEach((s, k) => {
        const ref = refs[k], info = new Int32Array(4), out = js.poissonBlend(s.dst, s.src, s.mask, s.w, s.h, undefined, info);
        let unknowns = 0;
        for (let p = 0; p < s.w * s.h; p++) {
            const o = p * 4;
            if (!s.mask[p]) { for (let c = 0; c < 4; c++) if (out[o + c] !== s.dst[o + c]) outsideBad++; continue; }
            unknowns++;
            if (out[o + 3] !== s.src[o + 3] || (!s.src[o + 3] && (out[o] | out[o + 1] | out[o + 2]))) alphaBad++;
            if (!s.src[o + 3]) continue;
            for (let c = 0; c < 3; c++) {
                const v = out[o + c], e = Math.abs(v - ref.out[o + c]);
                bytes++;
                if (e) differ++;
                if (e > worst) { worst = e; where = `${s.name} at (${p % s.w}, ${Math.floor(p / s.w)}) channel ${c}: ${v} vs ${ref.out[o + c]}`; }
                // the byte puts the twin's u in [v - src - 0.5, v - src + 0.5), open to one side where it clipped
                const lo = v === 0 ? -Infinity : v - s.src[o + c] - 0.5, hi = v === 255 ? Infinity : v - s.src[o + c] + 0.5, ur = ref.u[p * 3 + c];
                worstU = Math.max(worstU, ur < lo ? lo - ur : ur > hi ? ur - hi : 0);
            }
        }
        if (info[0] !== unknowns || info[1] < 0 || info[1] > js.POISSON_MAX_CYCLES || (unknowns && info[2] < 1) || info[3] !== 0) infoBad = `${s.name}: info [${info}] for ${unknowns} unknowns`;
        fewest = Math.min(fewest, info[1]);
        if (info[1] > most) { most = info[1]; slowest = s.name; }
    });
    check(`js poissonBlend within a level of the doubles (${scenes.length} scenes: discs, blobs, strokes, a ring, the box edge, transparency, soft masks, strips, clipping)`,
        worst <= 1, `worst ${worst}${worst > 1 ? " in " + where : ""}; ${(100 * differ / bytes).toFixed(2)} % of ${bytes} bytes differ; the twin's u off by at least ${worstU.toFixed(3)}`);
    // a level either way is the rounding of a u near a half: the share of such bytes and how far the twin's u can be from
    // the doubles' say whether it is only that (0.06 % and 0.003 measured; a floor without the half gave 46 % and 0.502,
    // a tolerance of 4 levels a cycle 2 levels on one scene: the mutation round of 2026-09-28)
    check(`js poissonBlend differs from the doubles' rounding on at most 1 % of the bytes, its u within 0.1`, differ <= bytes / 100 && worstU <= 0.1,
        `${(100 * differ / bytes).toFixed(2)} %, u off by at least ${worstU.toFixed(3)}`);
    check(`js poissonBlend keeps the source's alpha in the mask ([0,0,0,0] where the source is clear) and the destination outside it`, alphaBad === 0 && outsideBad === 0,
        `alpha wrong ${alphaBad}, outside moved ${outsideBad}`);
    check(`js poissonBlend's info: the unknowns, the cycles (${fewest} to ${most}), the levels`, !infoBad, infoBad);
    check(`js poissonBlend converges before the cap of ${js.POISSON_MAX_CYCLES} cycles on every scene`, most < js.POISSON_MAX_CYCLES, `most ${most}`);
    // and fast: 4 to 8 cycles measured; an interpolation that pulls a NONE neighbour to 0 instead of mirroring the parent
    // still converges, in up to 29 on an open strip (the mutation round of 2026-09-28)
    check(`js poissonBlend takes at most 10 cycles on every scene`, most <= 10, `most ${most} (${slowest})`);

    // the exact cases: dst == src gives dst (the correction is 0)
    {
        const w = 64, h = 48, t = poissonTexture(w, h, 31), r = rng(32);
        for (let i = 3; i < t.length; i += 4) if (r() < 0.1) t[i] = 1 + Math.floor(r() * 254);
        check(`js poissonBlend with dst == src gives dst`, eqBytes(js.poissonBlend(t, t.slice(), poissonMask(w, h, discCover(30, 22, 17)), w, h), t));
    }
    // dst = src + k gives dst; a region cut off by transparency starts at the mean, k too
    {
        const w = 90, h = 60, src = poissonTexture(w, h, 33, 40, 200), r = rng(34), k = [12, -30, 45];
        for (let i = 3; i < src.length; i += 4) if (r() < 0.1) src[i] = 1 + Math.floor(r() * 254);
        const dst = src.slice();
        for (let i = 0; i < dst.length; i += 4) for (let c = 0; c < 3; c++) dst[i + c] = src[i + c] + k[c];
        const mask = poissonMask(w, h, (x, y) => Math.max(discCover(22, 30, 16)(x, y), capsuleCover(50, 10, 80, 50, 8)(x, y)));
        const cut = poissonMask(w, h, discCover(22, 30, 21));
        for (let p = 0; p < w * h; p++) if (cut[p] && !mask[p]) dst[p * 4 + 3] = 0;
        check(`js poissonBlend with dst = src + k gives dst (k ${k}; a region cut off by transparency takes the start, k too)`, eqBytes(js.poissonBlend(dst, src, mask, w, h), dst));
    }
    // an empty mask leaves dst and solves nothing
    {
        const w = 57, h = 31, dst = randomRGBA(w, h, 35), src = randomRGBA(w, h, 36), info = new Int32Array(4);
        const out = js.poissonBlend(dst, src, new Uint8Array(w * h), w, h, undefined, info);
        check(`js poissonBlend with an empty mask gives dst, info[0] 0`, eqBytes(out, dst) && info[0] === 0, `info [${info}]`);
    }
    // no fixed pixel: u = 0, the source comes through (its clear pixels as [0,0,0,0])
    {
        const w = 61, h = 43, n = w * h, src = randomRGBA(w, h, 37), dst = randomRGBA(w, h, 38);
        for (let i = 3; i < dst.length; i += 4) dst[i] = 0;
        const full = js.poissonBlend(dst, src, new Uint8Array(n).fill(255), w, h), part = randomMask(n, 39), some = js.poissonBlend(dst, src, part, w, h);
        let okFull = true, okPart = true;
        for (let p = 0; p < n; p++) for (let c = 0; c < 4; c++) {
            const o = p * 4 + c, want = src[p * 4 + 3] ? src[o] : 0;
            if (full[o] !== want) okFull = false;
            if (some[o] !== (part[p] ? want : dst[o])) okPart = false;
        }
        check(`js poissonBlend with no fixed pixel gives the source (a full mask, and a partial one over a clear destination)`, okFull && okPart, `full ${okFull}, partial ${okPart}`);
    }
    // a plane in a hole enclosed by fixed pixels: floor(src + plane + 0.5) within a level
    {
        const L = poissonLinearScene(), out = js.poissonBlend(L.dst, L.src, L.mask, L.w, L.h);
        let e = 0, off = 0;
        for (let p = 0; p < L.w * L.h; p++) if (L.mask[p]) for (let c = 0; c < 3; c++) {
            const want = Math.max(0, Math.min(255, Math.floor(L.src[p * 4 + c] + L.plane(p % L.w, Math.floor(p / L.w), c) + 0.5))), d = Math.abs(out[p * 4 + c] - want);
            e = Math.max(e, d);
            if (d) off++;
        }
        check(`js poissonBlend fills a hole enclosed by a plane with the plane`, e === 0, `worst ${e}, ${off} bytes off`);
    }
    // strands: where the multigrid does not settle it says so (info[3]), and where it says it did it is within a level
    {
        const rows = [];
        let honest = true;
        for (const [on, off] of [[4, 3], [6, 5], [10, 6]]) {
            const S = poissonStrands(160, 160, on, off, 41 + on), info = new Int32Array(4), out = js.poissonBlend(S.dst, S.src, S.mask, S.w, S.h, undefined, info);
            const ref = poissonDoubles(S.dst, S.src, S.mask, S.w, S.h);
            let worst = 0;
            for (let p = 0; p < S.w * S.h; p++) if (S.mask[p]) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(out[p * 4 + c] - ref.out[p * 4 + c]));
            rows.push(`${S.name}: ${info[1]} cycles, settled ${!info[3]}, worst ${worst}`);
            if (!info[3] && worst > 1) honest = false;
            if (info[3] && info[1] !== js.POISSON_MAX_CYCLES) honest = false;
        }
        check(`js poissonBlend on strands the source splits: within a level where it settled, info[3] where it did not`, honest, rows.join("; "));
    }
    // a boundary pixel at alpha below 8 holds nothing: its straight colour (here 0 0 0 at alpha 1) leaves a flat heal flat
    {
        const w = 40, h = 40, dst = new Uint8Array(w * h * 4), src = new Uint8Array(w * h * 4), mask = poissonMask(w, h, discCover(20, 20, 12, 0.01));
        for (let k = 0; k < w * h; k++) { dst.set([150, 90, 60, 255], 4 * k); src.set([100, 100, 100, 255], 4 * k); }
        for (let k = 0; k < w * h; k++) if (!mask[k] && ((k % w) + Math.floor(k / w)) % 5 === 0) dst.set([0, 0, 0, 1], 4 * k);
        const out = js.poissonBlend(dst, src, mask, w, h);
        let flat = true;
        for (let k = 0; k < w * h; k++) if (mask[k] && (out[4 * k] !== 150 || out[4 * k + 1] !== 90 || out[4 * k + 2] !== 60)) flat = false;
        check(`js poissonBlend leaves out boundary pixels below alpha 8`, flat);
    }
    // soft mask values count as set: a binary mask gives the same bytes; a Uint8ClampedArray gives the same bytes
    {
        let same = true, clamped = true;
        for (const s of scenes.filter((t) => /soft|random mask|radius 60/.test(t.name))) {
            const a = js.poissonBlend(s.dst, s.src, s.mask, s.w, s.h);
            if (!eqBytes(a, js.poissonBlend(s.dst, s.src, s.mask.map((v) => (v ? 255 : 0)), s.w, s.h))) same = false;
            if (!eqBytes(a, js.poissonBlend(new Uint8ClampedArray(s.dst), new Uint8ClampedArray(s.src), s.mask, s.w, s.h))) clamped = false;
        }
        check(`js poissonBlend: mask values 1 to 255 act alike (the bytes of a binary mask)`, same);
        check(`js poissonBlend gives the same bytes for Uint8ClampedArray input`, clamped);
    }
    // w or h 0: nothing happens
    {
        let ok = true, detail = "";
        try {
            const e = new Uint8Array(0);
            for (const [w, h] of [[0, 5], [5, 0], [0, 0]]) {
                const junk = new Uint8Array(8).fill(9), r = js.poissonBlend(e, e, e, w, h, junk);
                if (r !== junk || junk.some((v) => v !== 9) || js.poissonBlend(e, e, e, w, h).length !== 0) { ok = false; detail = `${w} x ${h}`; }
            }
        } catch (err) { ok = false; detail = String(err); }
        check(`js poissonBlend with w or h 0 does nothing`, ok, detail);
    }
}

const poissonTimed = new Map();

/** The timing inputs of a size x size box and the twin's best of two on them, made once for both Rust builds. */
function poissonTiming(size, js) {
    if (poissonTimed.has(size)) return poissonTimed.get(size);
    const g = 100 / size, src = poissonTexture(size, size, 71);
    const dst = poissonLit(poissonTexture(size, size, 72), size, size, [35, -25, 50], [g, -0.5 * g, 0.8 * g], [0.3 * g, 0.7 * g, -0.6 * g]);
    const shapes = [["a disc", discCover(size / 2, size / 2, size * 0.47, 2)], ["a diagonal 60 px stroke", capsuleCover(40, 40, size - 40, size - 40, 60)]].map(([shape, cover]) => {
        const mask = poissonMask(size, size, cover), info = new Int32Array(4);
        let best = Infinity, out = null;
        for (let i = 0; i < 2; i++) { const t0 = performance.now(); out = js.poissonBlend(dst, src, mask, size, size, undefined, info); best = Math.min(best, performance.now() - t0); }
        return { shape, mask, twin: { best, out, info } };
    });
    const t = { dst, src, shapes };
    poissonTimed.set(size, t);
    return t;
}

/** The twin against a Rust build, bit for bit (out and info): the scenes, random boxes and masks, views, out given or not; then the timings. */
async function poissonCases(px, label, js) {
    if (typeof px.poissonBlend !== "function" || typeof js.poissonBlend !== "function") { check(`${label} and js poissonBlend exist`, false); return; }
    {
        let ok = true, detail = "";
        for (const [on, off] of [[4, 3], [10, 6]]) {
            const S = poissonStrands(160, 160, on, off, 41 + on), ia = new Int32Array(4), ib = new Int32Array(4);
            const a = js.poissonBlend(S.dst, S.src, S.mask, S.w, S.h, undefined, ia), b = px.poissonBlend(S.dst, S.src, S.mask, S.w, S.h, null, ib);
            if (!eqBytes(a, b) || ia.join() !== ib.join()) { ok = false; detail = `${S.name}: ${firstDiff(a, b)}, info [${ia}] vs [${ib}]`; }
        }
        check(`js poissonBlend equals the ${label} on strands, the not-settled flag included`, ok, detail);
    }
    const both = (dst, src, mask, w, h) => {
        const ia = new Int32Array(4), ib = new Int32Array(4);
        const a = js.poissonBlend(dst, src, mask, w, h, undefined, ia), b = px.poissonBlend(dst, src, mask, w, h, null, ib);
        return eqBytes(a, b) && eqBytes(ia, ib) ? "" : `out ${firstDiff(a, b) || "same"}, info [${ia}] vs [${ib}]`;
    };
    const scenes = poissonScenes();
    let ok = true, detail = "";
    for (const s of scenes) { const d = both(s.dst, s.src, s.mask, s.w, s.h); if (d) { ok = false; detail = `${s.name}: ${d}`; } }
    check(`js poissonBlend equals the ${label} on the ${scenes.length} scenes (out and info)`, ok, detail);
    // random boxes: random pixels (clear ones among them, or opaque), sparse, dense, full and empty masks
    let okR = true, detailR = "", seed = 0;
    for (const [w, h] of [[1, 1], [1, 7], [7, 1], [3, 3], [2, 2], [257, 129], [64, 64]]) {
        const n = w * h;
        for (const kind of ["sparse", "dense", "all 255", "all 0"]) for (const opaque of [false, true]) {
            const r = rng(9000 + ++seed);
            const mask = kind === "sparse" ? Uint8Array.from({ length: n }, () => (r() < 0.06 ? 1 + Math.floor(r() * 255) : 0))
                : kind === "dense" ? randomMask(n, 9100 + seed) : new Uint8Array(n).fill(kind === "all 255" ? 255 : 0);
            const d = both(randomRGBA(w, h, 9200 + seed, { opaque }), randomRGBA(w, h, 9300 + seed, { opaque }), mask, w, h);
            if (d) { okR = false; detailR = `${w} x ${h} ${kind}${opaque ? " opaque" : ""}: ${d}`; }
        }
    }
    check(`js poissonBlend equals the ${label} on random boxes (1 x 1 to 257 x 129; sparse, dense, full and empty masks)`, okR, detailR);
    // dst and src as Uint8ClampedArray views at a byte offset of 8 into larger buffers; the inputs stay as they were
    let okV = true, detailV = "";
    const rv = { name: "random 257 x 129", w: 257, h: 129, dst: randomRGBA(257, 129, 81), src: randomRGBA(257, 129, 82), mask: randomMask(257 * 129, 83) };
    for (const s of [scenes[2], scenes[9], rv]) {
        const view = (bytes) => { const all = new Uint8ClampedArray(bytes.length + 16).fill(77); all.set(bytes, 8); return new Uint8ClampedArray(all.buffer, 8, bytes.length); };
        const dv = view(s.dst), sv = view(s.src), ia = new Int32Array(4), ib = new Int32Array(4);
        const a = js.poissonBlend(s.dst, s.src, s.mask, s.w, s.h, undefined, ia), b = px.poissonBlend(dv, sv, s.mask, s.w, s.h, null, ib);
        const intact = (v, bytes) => eqBytes(v, bytes) && new Uint8Array(v.buffer).every((x, i) => i >= 8 && i < 8 + bytes.length || x === 77);
        if (!eqBytes(a, b) || !eqBytes(ia, ib) || !eqBytes(a, js.poissonBlend(dv, sv, s.mask, s.w, s.h))) { okV = false; detailV = `${s.name}: ${firstDiff(a, b)} info [${ia}] vs [${ib}]`; }
        if (!intact(dv, s.dst) || !intact(sv, s.src)) { okV = false; detailV = `${s.name}: an input was written`; }
    }
    check(`${label} poissonBlend takes Uint8ClampedArray views at an offset, gives the twin's bytes and leaves its inputs`, okV, detailV);
    // out given (junk first) or null: the same bytes; the given array comes back, null gives a new one outside wasm memory
    {
        const s = scenes[3], junk = () => new Uint8Array(s.w * s.h * 4).fill(0x5a), oa = junk(), ob = junk();
        const ra = js.poissonBlend(s.dst, s.src, s.mask, s.w, s.h, oa), rb = px.poissonBlend(s.dst, s.src, s.mask, s.w, s.h, ob);
        const fresh = px.poissonBlend(s.dst, s.src, s.mask, s.w, s.h, null), again = px.poissonBlend(s.dst, s.src, s.mask, s.w, s.h);
        const wrong = Object.entries({
            "the twin returns another array": ra !== oa, [`the ${label} returns another array`]: rb !== ob, "the given outs differ": !eqBytes(oa, ob),
            "null gives other bytes": !eqBytes(fresh, ob), "no out gives other bytes": !eqBytes(again, ob),
            "null gives no Uint8Array": !(fresh instanceof Uint8Array), "null gives a view of wasm memory": fresh.buffer === px.memory.buffer,
        }).filter(([, bad]) => bad).map(([what]) => what);
        check(`${label} poissonBlend writes a given out and returns it; without one it returns a new array of the same bytes`, !wrong.length, wrong.join(", "));
    }
    // w or h 0
    {
        let okZ = true, detailZ = "";
        try {
            const e = new Uint8Array(0);
            for (const [w, h] of [[0, 5], [5, 0]]) if (px.poissonBlend(e, e, e, w, h, null).length !== 0) { okZ = false; detailZ = `${w} x ${h}`; }
        } catch (err) { okZ = false; detailZ = String(err); }
        check(`${label} poissonBlend with w or h 0 does nothing`, okZ, detailZ);
    }
    if (/rust/.test(label)) {
        for (const size of [512, 2048]) {
            const T = poissonTiming(size, js);
            for (const t of T.shapes) {
                const info = new Int32Array(4);
                let best = Infinity, out = null;
                for (let i = 0; i < 3; i++) { const t0 = performance.now(); out = px.poissonBlend(T.dst, T.src, t.mask, size, size, null, info); best = Math.min(best, performance.now() - t0); }
                check(`js poissonBlend equals the ${label} on ${t.shape} in a ${size} x ${size} box`, eqBytes(out, t.twin.out) && eqBytes(info, t.twin.info),
                    `${firstDiff(out, t.twin.out)} info [${info}] vs [${t.twin.info}]`);
                console.log(`       ${t.shape} healed in a ${size} x ${size} box (${info[0]} px): ${label} ${best.toFixed(1)} ms, ${info[1]} cycles, ${info[2]} levels; twin ${t.twin.best.toFixed(1)} ms, ${t.twin.info[1]} cycles`);
            }
        }
    }
}

async function pngCases(ref, label, js) {
    const zlib = require("node:zlib");
    let ok = true, okRound = true, detail = "";
    for (const [w, rows, seed, withPrev] of [[1, 1, 1, false], [256, 16, 2, false], [333, 9, 3, true], [4096, 4, 4, true]]) {
        const src = randomRGBA(w, rows, seed);
        for (let y = 0; y < rows; y += 3) src.copyWithin(y * w * 4, 0, w * 4);  // repeated rows favour Up
        const prev = withPrev ? randomRGBA(w, 1, seed + 50) : null;
        const a = js.pngFilterRows(src, w, rows, prev), b = ref.pngFilterRows(src, w, rows, prev);
        if (!eqBytes(a, b)) { ok = false; detail = `${w}x${rows} ${firstDiff(a, b)}`; }
        if (!eqBytes(unfilter(a, w, rows, prev), src)) okRound = false;
    }
    check(`js pngFilterRows equals the ${label}`, ok, detail);
    check(`js filtered rows unfilter back to the input`, okRound);
    const bytes = randomRGBA(512, 64, 9);
    bytes.fill(7, 0, 40000);
    const n = await js.deflate(bytes);
    check(`CompressionStream("deflate") inflates back to the input`, eqBytes(new Uint8Array(zlib.inflateSync(n)), bytes), `${bytes.length} -> ${n.length}`);
}

// E2: the parts of a PNG's zlib stream, deflated one by one (any order, any worker), are one stream when joined:
// header, the parts, the Adler-32 joined from the parts' own sums. Node's inflate checks the checksum itself.
async function pngPartCases(px, label) {
    const zlib = require("node:zlib");
    const png = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_png.js")).href);
    const w = 700, rows = [5, 1, 64, 30];
    const total = rows.reduce((a, b) => a + b, 0);
    const src = randomRGBA(w, total, 21);
    src.fill(9, 0, w * 4 * 3);                                     // runs, so that deflate has something to match
    for (let y = 10; y < 60; y += 2) src.copyWithin(y * w * 4, 0, w * 4);
    for (const level of [1, 2, 6]) {
        const parts = [];
        let y = 0;
        rows.forEach((n, i) => {
            const prev = y ? src.subarray((y - 1) * w * 4, y * w * 4) : null;
            parts.push(px.pngPart(src.subarray(y * w * 4, (y + n) * w * 4), w, n, prev, level, i === rows.length - 1));
            y += n;
        });
        let adler = 1;
        for (const p of parts) adler = png.adlerCombine(adler, p.adler, p.raw);
        const tail = Buffer.from([adler >>> 24, (adler >>> 16) & 255, (adler >>> 8) & 255, adler & 255]);
        const stream = Buffer.concat([Buffer.from([0x78, 0x9C]), ...parts.map((p) => Buffer.from(p.bytes)), tail]);
        let out = null, err = "";
        try { out = new Uint8Array(zlib.inflateSync(stream)); } catch (e) { err = String(e.message || e); }
        const want = px.pngFilterRows(src, w, total, null);
        check(`${label} pngPart level ${level}: ${rows.length} parts join into one zlib stream with a valid Adler-32`, !!out && eqBytes(out, want), err || `${want.length} -> ${stream.length}`);
        check(`${label} pngPart level ${level}: the joined rows unfilter back to the input`, !!out && eqBytes(unfilter(out, w, total, null), src));
    }
    const big = px.pngPart(new Uint8Array(4096 * 64 * 4), 4096, 64, null, 2, true);
    check(`${label} pngPart of an empty band is small`, big.bytes.length < 4096, `${big.bytes.length} bytes`);
    // incompressible rows: the output is larger than the input and the first buffer is still enough
    const noise = randomRGBA(900, 40, 77);
    const np = px.pngPart(noise, 900, 40, null, 1, true);
    let nout = null;
    try { nout = new Uint8Array(zlib.inflateRawSync(Buffer.from(np.bytes))); } catch (_) { /* reported below */ }
    check(`${label} pngPart of noise inflates back`, !!nout && nout.length === np.raw);
    await noisePartCases(px, label, png, zlib);
}

/** Uniform noise in all four channels, alpha too (AES-CTR over zeros: the same bytes every run): what deflate can only store. */
function noiseRGBA(w, h, seed) {
    const key = Buffer.alloc(16, seed & 255), iv = Buffer.alloc(16, (seed >>> 8) & 255);
    return new Uint8Array(crypto.createCipheriv("aes-128-ctr", key, iv).update(Buffer.alloc(w * h * 4)));
}

// The review's must rust/px-deflate-sync-truncation (docs/research/review_full_2026-11-07): at level 2 miniz_oxide
// stores noise in blocks of 31,745 bytes, 5 bytes of overhead each, while px.js' first buffer allowed 5 per 65,535. A
// part that is not the last could fill its buffer exactly with the last block's tail and the sync marker still inside
// miniz_oxide, and `deflate_part` took it as done: the part came back cut short and the joined stream broke (layer
// files in the store, the .scumble, the autosave, exports). Each shape (720 px wide: about the narrowest whose 256-row
// part broke; 4096 x 256 a tile row; 15,000 x 139 the scenario's 8 MB part): a non-last level-2 part of noise and a
// last part, joined and inflated by node, with one `deflate_part` call a part (the first buffer is enough, so noise is
// not deflated twice). Then the export itself against buffers around the part's real size, the first buffer of before
// among them: each answer is -1 (too small, the caller doubles) or the whole part, never a shorter one.
async function noisePartCases(px, label, png, zlib) {
    const P = await import(pathToFileURL(path.join(PX_DIR, "px.js")).href);
    for (const [w, rows, tail] of [[720, 256, 3], [4096, 256, 8], [15000, 139, 2]]) {
        const src = noiseRGBA(w, rows + tail, w), row = w * 4;
        P.pxCalls(true);
        const a = px.pngPart(src.subarray(0, rows * row), w, rows, null, 2, false);
        const b = px.pngPart(src.subarray(rows * row), w, tail, src.subarray((rows - 1) * row, rows * row), 2, true);
        const calls = P.pxCalls().deflate_part || 0;
        const adler = png.adlerCombine(png.adlerCombine(1, a.adler, a.raw), b.adler, b.raw);
        const stream = Buffer.concat([Buffer.from([0x78, 0x9C]), Buffer.from(a.bytes), Buffer.from(b.bytes),
            Buffer.from([adler >>> 24, (adler >>> 16) & 255, (adler >>> 8) & 255, adler & 255])]);
        let out = null, err = "";
        try { out = new Uint8Array(zlib.inflateSync(stream)); } catch (e) { err = String(e.message || e); }
        const want = px.pngFilterRows(src, w, rows + tail, null);
        check(`${label} pngPart of ${w} x ${rows} noise rows (level 2, not the last part) and a last part join into one zlib stream`,
            !!out && eqBytes(out, want), err || `${want.length} -> ${stream.length} (the first part ${a.raw} -> ${a.bytes.length})`);
        check(`${label} pngPart of ${w} x ${rows} noise rows: the first buffer is enough (one deflate_part call a part)`, calls === 2, `${calls} calls`);
        if (w !== 4096) continue;
        // the export at buffers around the part's size: never a part shorter than the whole one
        const f = px.pngFilterRows(src.subarray(0, rows * row), w, rows, null), n = f.length;
        const pi = px.alloc(n), big = 2 * n + 1024, po = px.alloc(big);
        try {
            px.u8().set(f, pi);
            const full = px.exports.deflate_part(pi, n, 2, 0, po, big), ref = px.u8().slice(po, po + Math.max(0, full));
            const old = n + Math.ceil(n / 65535) * 5 + 64;
            const bad = full > 0 && eqBytes(ref, a.bytes) ? [] : [`a buffer of ${big}: ${full}, the pngPart ${a.bytes.length}`];
            for (const cap of [old, full - 1, full, full + 1]) {
                const r = px.exports.deflate_part(pi, n, 2, 0, po, cap);
                const whole = r === full && eqBytes(px.u8().subarray(po, po + r), ref);
                if (!(r === -1 ? cap <= full : whole)) bad.push(`cap ${cap}: ${r}`);
            }
            check(`${label} deflate_part of a non-last noise part: each buffer gives -1 or the whole part (${full} bytes, as pngPart's), never a shorter one`,
                old < full && !bad.length, bad.join(", ") || `the first buffer of before was ${old}`);
        } finally { px.free(pi, n); px.free(po, big); }
    }
    // a whole zlib stream of noise (a TIFF strip): one call, and it inflates back
    const strip = noiseRGBA(1024, 512, 7);
    P.pxCalls(true);
    const z = px.zlib(strip, 2);
    const zc = P.pxCalls().deflate_part || 0;
    let zout = null;
    try { zout = new Uint8Array(zlib.inflateSync(Buffer.from(z))); } catch (_) { /* reported below */ }
    check(`${label} zlib of a 2 MB noise strip inflates back, in one deflate_part call`, !!zout && eqBytes(zout, strip) && zc === 1, `${zc} calls`);
}

// W1 (docs/PLAN_WASM_BUILD.md §7): the writer's filter choice. The SIMD build adds the five filters' costs 16 bytes at a
// time and keeps the Paeth row it computed; the scalar build is the old per-byte loop. Both against the JS twin byte
// for byte (each case also at an odd offset), the twin against the plain reference here, and the filtered rows back to
// the input. The cases: every row width from 1 to 40 px (so every count of bytes after the last 16-byte group, and the
// rows too narrow for the lanes), the widths around 64, 256, 1024 and 4096 px, with and without the row above; random
// pixels, tiny value ranges (ties of the row sums and inside Paeth), bytes around 128 (the cost of 0x80), rows made so
// each filter wins, flat rows (every sum 0: None), a row equal to the one above, and rows whose true Up sum is the
// largest possible (128 a byte) over more than 255 groups, which a lane sum that overflowed its u16 would pick.
// The writer takes 8-bit RGBA only (4 bytes a pixel), so no other pixel size or depth is asked.
function pngFilterCases(js, simdPx, scalarPx) {
    const W = [...Array.from({ length: 40 }, (_, i) => i + 1), 63, 64, 65, 67, 127, 128, 129, 255, 256, 257, 700, 1023, 1024, 1025, 4096, 4097, 4100];
    const fill = (n, seed, pick) => { const r = rng(seed), d = new Uint8Array(n); for (let i = 0; i < n; i++) d[i] = pick(r); return d; };
    const kinds = {
        random: (w, rows, s) => randomRGBA(w, rows, s),
        tiny: (w, rows, s) => fill(w * rows * 4, s, (r) => (r() * 3) | 0),
        two: (w, rows, s) => fill(w * rows * 4, s, (r) => (r() < 0.5 ? 0 : 255)),
        mid: (w, rows, s) => fill(w * rows * 4, s, (r) => 126 + ((r() * 5) | 0)),
        flat: (w, rows) => new Uint8Array(w * rows * 4),
    };
    // rows that filter T reduces to residuals of -1, 0, 1: the lines' filter bytes all T, unfiltered against `prev`
    const forced = (T) => (w, rows, s, prev) => {
        const n = w * 4, f = new Uint8Array(rows * (n + 1)), r = rng(s);
        for (let y = 0; y < rows; y++) { f[y * (n + 1)] = T; for (let i = 0; i < n; i++) f[y * (n + 1) + 1 + i] = (((r() * 3) | 0) - 1) & 255; }
        return unfilter(f, w, rows, prev);
    };
    for (let T = 1; T <= 4; T++) kinds[`forced${T}`] = forced(T);
    const cases = [];
    let seed = 1000;
    for (const w of W) for (const [kind, make] of Object.entries(kinds)) for (const withPrev of [false, true]) {
        const rows = w > 1000 ? 2 : 3, s = seed++;
        const prev = withPrev ? (kind === "flat" ? new Uint8Array(w * 4) : kind === "tiny" ? kinds.tiny(w, 1, s + 7) : randomRGBA(w, 1, s + 7)) : null;
        cases.push({ tag: `${kind} ${w} px x ${rows}${withPrev ? " with the row above" : ""}`, args: [make(w, rows, s, prev), w, rows, prev] });
    }
    for (const w of [21, 64, 333]) {
        const src = randomRGBA(w, 2, seed++), prev = src.slice(0, w * 4);
        src.copyWithin(w * 4, 0, w * 4);   // both rows equal to the one above the first
        cases.push({ tag: `rows equal to the one above ${w} px`, args: [src, w, 2, prev] });
    }
    for (const w of [4097, 8193, 1029]) {
        // x - b = 128 at every byte: Up's true sum is 128 a byte, the largest; every other filter is random
        const n = w * 4, src = randomRGBA(w, 2, seed++), prev = new Uint8Array(n);
        for (let i = 0; i < n; i++) { prev[i] = (src[i] - 128) & 255; src[n + i] = (src[i] + 128) & 255; }
        cases.push({ tag: `Up at 128 a byte over ${Math.floor((n - 4) / 16)} groups ${w} px`, args: [src, w, 2, prev] });
    }
    // what the cases exercise, counted with the reference's sums in the rows of 5 px or more (the ones that reach the
    // SIMD build's lanes; narrower rows take the scalar loop in both builds): each filter's wins, ties of the smallest
    // sum, and the Paeth predictor's ties where the order picks a different byte (a over c, b over c). A tie of a with
    // b never does: pa = pb with a != b puts c midway, so pc = 0 < pa and c is picked; it is counted only with a = b
    const wins = [0, 0, 0, 0, 0], tieWins = [0, 0, 0, 0, 0], ptie = { ab: 0, ac: 0, bc: 0 };
    let refOk = true, refDetail = "", backOk = true, backDetail = "";
    for (const c of cases) {
        const [src, w, rows, prev] = c.args, n = w * 4;
        for (let y = 0; y < (w >= 5 ? rows : 0); y++) {
            const sums = [0, 0, 0, 0, 0];
            for (let i = 0; i < n; i++) {
                const x = src[y * n + i], a = i >= 4 ? src[y * n + i - 4] : 0;
                const b = y ? src[(y - 1) * n + i] : prev ? prev[i] : 0;
                const cc = i >= 4 ? (y ? src[(y - 1) * n + i - 4] : prev ? prev[i - 4] : 0) : 0;
                const pa = Math.abs(b - cc), pb = Math.abs(a - cc), pc = Math.abs(a + b - 2 * cc);
                if (pa === pb && pa <= pc) ptie.ab++;
                if (pa === pc && pa < pb && a !== cc) ptie.ac++;
                if (pb === pc && pa > pb && b !== cc) ptie.bc++;
                [x, x - a, x - b, x - ((a + b) >> 1), x - paeth(a, b, cc)].forEach((v, t) => { v &= 255; sums[t] += v < 128 ? v : 256 - v; });
            }
            const min = Math.min(...sums), best = sums.indexOf(min);
            wins[best]++;
            if (sums.filter((v) => v === min).length > 1) tieWins[best]++;
        }
        const got = js.pngFilterRows(src, w, rows, prev), want = reference.pngFilterRows(src, w, rows, prev);
        if (refOk && !eqBytes(got, want)) { refOk = false; refDetail = `${c.tag}: ${firstDiff(got, want)}`; }
        if (backOk && !eqBytes(unfilter(simdPx.pngFilterRows(src, w, rows, prev), w, rows, prev), src)) { backOk = false; backDetail = c.tag; }
    }
    check(`js pngFilterRows equals the reference (${cases.length} cases)`, refOk, refDetail);
    twinCheck({
        name: "png_filter_rows", builds: [["rust simd", simdPx], ["rust scalar", scalarPx]], twin: js,
        call: (k, [src, w, rows, prev]) => k.pngFilterRows(src, w, rows, prev), cases,
    });
    check(`rust simd png_filter_rows unfilters back to the input (${cases.length} cases)`, backOk, backDetail);
    console.log(`       png_filter_rows cases, rows of 5 px or more: won by None ${wins[0]}, Sub ${wins[1]}, Up ${wins[2]}, Average ${wins[3]}, Paeth ${wins[4]}; won on a tied sum ${tieWins.join(" / ")}; Paeth ties a=b ${ptie.ab} (a = b), a=c ${ptie.ac}, b=c ${ptie.bc}`);
    check(`png_filter_rows cases, rows of 5 px or more: every filter wins rows, ties of the sums are won by None, Sub, Up and Average, the Paeth predictor ties a over c and b over c`,
        wins.every((v) => v > 0) && tieWins.slice(0, 4).every((v) => v > 0) && ptie.ac > 0 && ptie.bc > 0,
        `wins ${wins}, tied ${tieWins}, paeth ${JSON.stringify(ptie)}`);
}

// E4: a PSD's channel rows. The twin and the Rust kernel give the bytes of inpaint_export.js `packBits`, row by row.
async function psdCases(ref, label, js) {
    const ex = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_export.js")).href);
    let ok = true, okTwin = true, detail = "";
    for (const [w, rows, seed] of [[1, 1, 1], [2, 3, 2], [129, 4, 3], [700, 9, 4], [4096, 3, 5]]) {
        const src = randomRGBA(w, rows, seed);
        // runs of every length up to past 128, singles between runs of two, and long literals
        for (let x = 0, run = 1; x + run < w; x += run + 1, run = (run % 140) + 1) src.fill(seed * 7, (x * 4), (x + run) * 4);
        if (rows > 1) for (let x = 0; x + 3 <= w; x += 3) { const o = (w + x) * 4; src.fill(x & 255, o + 4, o + 12); }
        const a = js.psdPackRows(src, w, rows), b = ref.psdPackRows(src, w, rows);
        for (let ch = 0; ch < 4; ch++) {
            const want = [], lens = new Uint8Array(rows * 2);
            for (let y = 0; y < rows; y++) {
                const row = new Uint8Array(w);
                for (let x = 0; x < w; x++) row[x] = src[(y * w + x) * 4 + ch];
                const p = ex.packBits(row);
                lens[y * 2] = p.length >> 8; lens[y * 2 + 1] = p.length & 255;
                want.push(...p);
            }
            const wantBytes = Uint8Array.from(want);
            if (!eqBytes(a[ch].data, wantBytes) || !eqBytes(a[ch].lens, lens)) { okTwin = false; detail = `${w}x${rows} channel ${ch}`; }
            if (!eqBytes(b[ch].data, a[ch].data) || !eqBytes(b[ch].lens, a[ch].lens)) { ok = false; detail = `${w}x${rows} channel ${ch} ${firstDiff(b[ch].data, a[ch].data)}`; }
        }
    }
    check(`js psdPackRows gives the bytes of the PSD writer's packBits`, okTwin, detail);
    check(`js psdPackRows equals the ${label}`, ok, detail);
}

function unfilter(f, w, rows, prev) {
    const n = w * 4, out = new Uint8Array(rows * n);
    for (let y = 0; y < rows; y++) {
        const t = f[y * (n + 1)], src = y * (n + 1) + 1, r = y * n;
        for (let i = 0; i < n; i++) {
            const a = i >= 4 ? out[r + i - 4] : 0;
            const b = y ? out[r - n + i] : prev ? prev[i] : 0;
            const c = i >= 4 ? (y ? out[r - n + i - 4] : prev ? prev[i - 4] : 0) : 0;
            const pred = t === 0 ? 0 : t === 1 ? a : t === 2 ? b : t === 3 ? (a + b) >> 1 : paeth(a, b, c);
            out[r + i] = (f[src + i] + pred) & 255;
        }
    }
    return out;
}

function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// ---- references: the formulas written out once, per pixel, with nothing clever -----------------

const mul255 = (x, y) => { const t = x * y + 128; return (t + (t >> 8)) >> 8; };

// soft-light's d(b), in 16 bits: the table the kernels carry, made here from the specification
const SOFT_D_REF = Array.from({ length: 256 }, (_, b8) => { const b = b8 / 255; return Math.floor((b8 <= 63 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)) * 65535 + 0.5); });
const hardLightRef = (b, s) => (s <= 127 ? 2 * b * s : 65025 - (255 - b) * (510 - 2 * s));
const dodgeRef = (b, s) => {
    if (b === 0) return 0;
    if (s >= 255) return 65025;
    const d = 255 - s;
    return Math.min(65025, Math.floor((130050 * b + d) / (2 * d)));
};
const burnRef = (b, s) => {
    if (b >= 255) return 65025;
    if (s === 0) return 0;
    return 65025 - Math.min(65025, Math.floor((130050 * (255 - b) + s) / (2 * s)));
};
/** 255 * B(cb, cs) of the ops 5 to 23 in the kernels' integers (0..65025). */
const blendRef = (op, b, s) => [
    () => b * s,
    () => 65025 - (255 - b) * (255 - s),
    () => hardLightRef(s, b),
    () => 255 * Math.min(b, s),
    () => 255 * Math.max(b, s),
    () => (s <= 127 ? 255 * b - Math.floor(((255 - 2 * s) * b * (255 - b) + 127) / 255) : 255 * b + Math.floor(((2 * s - 255) * (SOFT_D_REF[b] - b * 257) + 128) / 257)),
    () => hardLightRef(b, s),
    () => 255 * Math.abs(b - s),
    () => 255 * Math.min(255, Math.max(0, b + 2 * s - 255)),
    () => b * (255 - s) + s * (255 - b),
    () => 255 * Math.min(255, b + s),
    () => 255 * Math.max(0, b + s - 255),
    () => 255 * Math.max(0, b - s),
    () => (s <= 127 ? 255 * Math.min(b, 2 * s) : 255 * Math.max(b, 2 * s - 255)),
    () => (b + s > 255 || (b + s === 255 && s <= 127) ? 65025 : 0),   // Photoshop's tie (R4-D2)
    () => dodgeRef(b, s),
    () => burnRef(b, s),
    () => (s <= 127 ? burnRef(b, 2 * s) : dodgeRef(b, 2 * s - 255)),
    () => (s === 0 ? (b === 0 ? 0 : 65025) : Math.min(65025, Math.floor((130050 * b + s) / (2 * s)))),
][op - 5]();

// BigInt fraction type for exact W3C pseudo-code reference (Tier C, ops 24 to 29):
function frac(n, d = 1n) { if (d < 0n) { n = -n; d = -d; } return { n: BigInt(n), d: BigInt(d) }; }
const fracAdd = (a, b) => frac(a.n * b.d + b.n * a.d, a.d * b.d);
const fracSub = (a, b) => frac(a.n * b.d - b.n * a.d, a.d * b.d);
const fracMul = (a, b) => frac(a.n * b.n, a.d * b.d);
const fracDiv = (a, b) => frac(a.n * b.d, a.d * b.n);
const fracCmp = (a, b) => { const diff = a.n * b.d - b.n * a.d; return diff < 0n ? -1 : diff > 0n ? 1 : 0; };
const fracToB16 = (f) => { const N = f.n * 65025n, D = f.d; return Number((2n * N + D) / (2n * D)); };

function lumRef(c) {
    return fracAdd(fracAdd(fracMul(frac(3n, 10n), c[0]), fracMul(frac(59n, 100n), c[1])), fracMul(frac(11n, 100n), c[2]));
}
function clipColorRef(c) {
    const l = lumRef(c), zero = frac(0n), one = frac(1n);
    let n = c[0]; if (fracCmp(c[1], n) < 0) n = c[1]; if (fracCmp(c[2], n) < 0) n = c[2];
    let x = c[0]; if (fracCmp(c[1], x) > 0) x = c[1]; if (fracCmp(c[2], x) > 0) x = c[2];
    let r = c[0], g = c[1], b = c[2];
    if (fracCmp(n, zero) < 0) {
        const denom = fracSub(l, n);
        r = fracAdd(l, fracDiv(fracMul(fracSub(r, l), l), denom));
        g = fracAdd(l, fracDiv(fracMul(fracSub(g, l), l), denom));
        b = fracAdd(l, fracDiv(fracMul(fracSub(b, l), l), denom));
    }
    if (fracCmp(x, one) > 0) {
        const oneSubL = fracSub(one, l), denom = fracSub(x, l);
        r = fracAdd(l, fracDiv(fracMul(fracSub(r, l), oneSubL), denom));
        g = fracAdd(l, fracDiv(fracMul(fracSub(g, l), oneSubL), denom));
        b = fracAdd(l, fracDiv(fracMul(fracSub(b, l), oneSubL), denom));
    }
    return [r, g, b];
}
function setLumRef(c, l) {
    const d = fracSub(l, lumRef(c));
    return clipColorRef([fracAdd(c[0], d), fracAdd(c[1], d), fracAdd(c[2], d)]);
}
function satRef(c) {
    let n = c[0]; if (fracCmp(c[1], n) < 0) n = c[1]; if (fracCmp(c[2], n) < 0) n = c[2];
    let x = c[0]; if (fracCmp(c[1], x) > 0) x = c[1]; if (fracCmp(c[2], x) > 0) x = c[2];
    return fracSub(x, n);
}
function setSatRef(c, s) {
    const zero = frac(0n), idx = [0, 1, 2];
    idx.sort((i, j) => fracCmp(c[i], c[j]));
    const minIdx = idx[0], midIdx = idx[1], maxIdx = idx[2];
    const cMin = c[minIdx], cMid = c[midIdx], cMax = c[maxIdx];
    const out = [zero, zero, zero];
    if (fracCmp(cMax, cMin) > 0) {
        out[midIdx] = fracDiv(fracMul(fracSub(cMid, cMin), s), fracSub(cMax, cMin));
        out[maxIdx] = s;
    }
    return out;
}
function blendRef3(op, b3, s3) {
    if (op < 24) return [blendRef(op, b3[0], s3[0]), blendRef(op, b3[1], s3[1]), blendRef(op, b3[2], s3[2])];
    if (op === 28) return (s3[0] + s3[1] + s3[2] < b3[0] + b3[1] + b3[2]) ? [255 * s3[0], 255 * s3[1], 255 * s3[2]] : [255 * b3[0], 255 * b3[1], 255 * b3[2]];
    if (op === 29) return (s3[0] + s3[1] + s3[2] > b3[0] + b3[1] + b3[2]) ? [255 * s3[0], 255 * s3[1], 255 * s3[2]] : [255 * b3[0], 255 * b3[1], 255 * b3[2]];
    const cb = [frac(b3[0], 255n), frac(b3[1], 255n), frac(b3[2], 255n)];
    const cs = [frac(s3[0], 255n), frac(s3[1], 255n), frac(s3[2], 255n)];
    let res;
    if (op === 24) res = setLumRef(setSatRef(cs, satRef(cb)), lumRef(cb));
    else if (op === 25) res = setLumRef(setSatRef(cb, satRef(cs)), lumRef(cb));
    else if (op === 26) res = setLumRef(cs, lumRef(cb));
    else if (op === 27) res = setLumRef(cb, lumRef(cs));
    else return [0, 0, 0];
    return res.map(fracToB16);
}

/** The same in the specification's floats (W3C Compositing and Blending Level 1; linear light as Photoshop has it), 0..1. */
const blendFloat = (op, b, s) => {
    const hl = (b, s) => (s <= 0.5 ? b * 2 * s : b + (2 * s - 1) - b * (2 * s - 1));
    const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
    const dodge = (b, s) => (b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)));
    const burn = (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s));
    return [
        b * s,
        b + s - b * s,
        hl(s, b),
        Math.min(b, s),
        Math.max(b, s),
        s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (d - b),
        hl(b, s),
        Math.abs(b - s),
        Math.min(1, Math.max(0, b + 2 * s - 1)),
        b + s - 2 * b * s,
        Math.min(1, b + s),
        Math.max(0, b + s - 1),
        Math.max(0, b - s),
        s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1),
        Math.floor(b * 255 + 0.5) + Math.floor(s * 255 + 0.5) >= (s <= 127.5 / 255 ? 255 : 256) ? 1 : 0,
        dodge(b, s),
        burn(b, s),
        s <= 0.5 ? burn(b, 2 * s) : dodge(b, 2 * s - 1),
        s <= 0 ? (b <= 0 ? 0 : 1) : Math.min(1, b / s),
    ][op - 5];
};
let BLEND_NAMES = [];

const reference = {
    /** 2×2 box weighted by alpha: alpha (A + 2) >> 2, colour floor((Σ c·a + A/2) / A), 0 when A is 0. */
    mipHalf(src, sw, sh) {
        const ow = sw >> 1, oh = sh >> 1, out = new Uint8Array(ow * oh * 4);
        for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
            const idx = [((2 * y) * sw + 2 * x) * 4, ((2 * y) * sw + 2 * x + 1) * 4, ((2 * y + 1) * sw + 2 * x) * 4, ((2 * y + 1) * sw + 2 * x + 1) * 4];
            const A = idx.reduce((n, i) => n + src[i + 3], 0), o = (y * ow + x) * 4;
            for (let c = 0; c < 3; c++) out[o + c] = A === 0 ? 0 : Math.floor((idx.reduce((n, i) => n + src[i + c] * src[i + 3], 0) + (A >> 1)) / A);
            out[o + 3] = (A + 2) >> 2;
        }
        return out;
    },
    mipChain(src, size, levels) {
        const parts = [];
        let prev = src, s = size;
        for (let l = 0; l < levels && s >= 2; l++) { prev = reference.mipHalf(prev, s, s); parts.push(prev); s >>= 1; }
        return new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
    },
    /** premultiply once, the five operators and the coverage lerp, unpremultiply once */
    compositeTile(dst, srcs, ops, alphas, masks) {
        const px = dst.length >> 2;
        for (let p = 0; p < px; p++) { const i = p * 4; for (let c = 0; c < 3; c++) dst[i + c] = mul255(dst[i + c], dst[i + 3]); }
        srcs.forEach((s, l) => {
            for (let p = 0; p < px; p++) {
                const i = p * 4, m = masks && masks[l] ? masks[l][p] : 255;
                const sa = mul255(s[i + 3], alphas[l]), inv = 255 - sa, d = [dst[i], dst[i + 1], dst[i + 2], dst[i + 3]], da = d[3];
                const sp = [mul255(s[i], sa), mul255(s[i + 1], sa), mul255(s[i + 2], sa), sa];
                const ra = sa + mul255(da, inv);
                let b16_3 = null;
                if (ops[l] >= 24 && ops[l] <= 29) {
                    const h = da >> 1;
                    const cb3 = da === 0 ? [0, 0, 0] : [
                        Math.min(255, Math.floor((d[0] * 255 + h) / da)),
                        Math.min(255, Math.floor((d[1] * 255 + h) / da)),
                        Math.min(255, Math.floor((d[2] * 255 + h) / da)),
                    ];
                    b16_3 = blendRef3(ops[l], cb3, [s[i], s[i + 1], s[i + 2]]);
                }
                const blended = (c) => {   // the blend modes: the W3C sum over 255^3, rounded once, never more than the alpha
                    if (c === 3) return ra;
                    const b16 = b16_3 ? b16_3[c] : blendRef(ops[l], da === 0 ? 0 : Math.min(255, Math.floor((d[c] * 255 + (da >> 1)) / da)), s[i + c]);
                    const x = BigInt(s[i + c]) * BigInt(sa) * BigInt(255 - da) * 255n + BigInt(d[c]) * BigInt(inv) * 65025n + BigInt(sa) * BigInt(da) * BigInt(b16);
                    return Math.min(ra, Number((x + 8290687n) / 16581375n));
                };
                const r = [0, 1, 2, 3].map((c) => (ops[l] >= 5 && ops[l] <= 29) ? blended(c) : [
                    sp[c] + mul255(d[c], inv),                  // source-over
                    mul255(d[c], inv),                          // destination-out
                    mul255(sp[c], da) + mul255(d[c], inv),      // source-atop
                    mul255(d[c], sa),                           // destination-in
                    sp[c],                                      // copy
                ][ops[l] > 29 ? 0 : ops[l]]);
                for (let c = 0; c < 4; c++) dst[i + c] = mul255(r[c], m) + mul255(d[c], 255 - m);
            }
        });
        for (let p = 0; p < px; p++) {
            const i = p * 4, a = dst[i + 3];
            for (let c = 0; c < 3; c++) dst[i + c] = a === 0 ? 0 : Math.min(255, Math.floor((dst[i + c] * 255 + (a >> 1)) / a));
        }
        return dst;
    },
    /** all five filters per row, the smallest sum of |signed byte|, ties to the lower type */
    pngFilterRows(rgba, w, rows, prev) {
        const n = w * 4, out = new Uint8Array(rows * (n + 1));
        for (let y = 0; y < rows; y++) {
            const row = rgba.subarray(y * n, y * n + n), up = y ? rgba.subarray((y - 1) * n, y * n) : prev || new Uint8Array(n);
            const cands = [0, 1, 2, 3, 4].map((t) => Uint8Array.from(row, (x, i) => {
                const a = i >= 4 ? row[i - 4] : 0, b = up[i], c = i >= 4 ? up[i - 4] : 0;
                return (x - [0, a, b, (a + b) >> 1, paeth(a, b, c)][t]) & 255;
            }));
            const sums = cands.map((cand) => cand.reduce((acc, v) => acc + (v < 128 ? v : 256 - v), 0));
            const best = sums.indexOf(Math.min(...sums));
            out[y * (n + 1)] = best;
            out.set(cands[best], y * (n + 1) + 1);
        }
        return out;
    },
};

/**
 * The resampler's kernel (PLAN_0_1_31 §7, 23b): the Rust build against its twin `resampleBlock` in
 * inpaint_resample.js, byte for byte, through the same `resampleStore` walk: bicubic and bilinear, colour and mask,
 * opaque and transparent blocks, transparent and clamped edges, with and without a round-trip table, maps that turn,
 * scale, mirror and shift (tools/resample_test.js holds the twin to its arithmetic and to doubles).
 */
async function resampleCases(px, label, R) {
    let seed = 7;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const image = (W, H, kind) => {
        const d = new Uint8Array(W * H * 4);
        for (let i = 0; i < d.length; i += 4) {
            const a = kind === "opaque" ? 255 : rand() < 0.2 ? 0 : Math.floor(rand() * 256);
            d[i + 3] = a;
            if (a) { d[i] = Math.floor(rand() * 256); d[i + 1] = Math.floor(rand() * 256); d[i + 2] = Math.floor(rand() * 256); }
        }
        return { W, H, d };
    };
    // a round-trip table like a canvas's: premultiplied to 8 bits and back
    const rt = new Uint8Array(65536);
    for (let a = 1; a < 256; a++) for (let c = 0; c < 256; c++) { const p = Math.floor((c * a + 127) / 255); rt[(a << 8) | c] = Math.min(255, Math.floor((p * 255 + (a >> 1)) / a)); }
    const rust = (block, bw, bh, bx, by, fx, filter, alpha, rgb, t, out, off, stride, X0, Y0, vw, vh) => {
        const w = R.resampleTable(filter);
        return px.resampleBlock(block, bw, bh, bx, by, fx, filter, alpha, rgb, t, out, off, stride, X0, Y0, vw, vh, w.table, w.taps);
    };
    const run = (img, map, outW, outH, opts, mask, table, kernel) => {
        const out = new Uint8Array(outW * outH * 4);
        let count = 0;
        R.resampleStore({ width: img.W, height: img.H, has: () => true, copyRun: (sy, x0, x1, dst, off) => dst.set(img.d.subarray((sy * img.W + x0) * 4, (sy * img.W + x1) * 4), off) },
            map, outW, outH, R.resampleOptions(opts, mask), table, { tile: (tx, ty) => [out, (ty * 256 * outW + tx * 256) * 4, outW * 4], done: (tx, ty, n) => { count += n; } }, null, kernel);
        return { out, count };
    };
    let bad = "";
    const cases = [];
    for (const kind of ["opaque", "mixed"]) {
        for (const [deg, sx, sy, flip] of [[3, 1, 1, 1], [-31, 1, 1, 1], [12, 0.6, 0.8, 1], [0, 1.7, 1.3, 1], [45, 1, 1, -1], [90, 1, 1, 1]]) {
            for (const [opts, mask] of [[{}, false], [{ filter: "bilinear" }, false], [{ edge: "clamp" }, false], [{ color: [255, 255, 255] }, true]]) {
                cases.push({ kind, deg, sx, sy, flip, opts, mask });
            }
        }
    }
    for (const c of cases) {
        const img = image(300 + Math.floor(rand() * 200), 200 + Math.floor(rand() * 150), c.kind);
        const fwd = R.xfMul(R.xfRotate(c.deg, img.W / 2, img.H / 2), [c.sx * c.flip, 0, 0, c.sy, c.flip < 0 ? img.W : 0, 0]);
        const map = R.pixelMap(R.xfInv(fwd));
        const outW = 280 + Math.floor(rand() * 300), outH = 240 + Math.floor(rand() * 200);
        for (const table of [null, rt]) {
            const a = run(img, map, outW, outH, c.opts, c.mask, table, R.resampleBlock);
            const b = run(img, map, outW, outH, c.opts, c.mask, table, rust);
            let i = 0;
            while (i < a.out.length && a.out[i] === b.out[i]) i++;
            if (i < a.out.length || a.count !== b.count) { bad = `${JSON.stringify({ ...c, rt: !!table })}: byte ${i} is ${b.out[i]}, the twin has ${a.out[i]} (counts ${b.count}, ${a.count})`; break; }
        }
        if (bad) break;
    }
    check(`${label} resample_block equals its twin (${cases.length * 2} maps: turns, scales, a mirror, bicubic / bilinear, masks, clamped edges, round trip)`, !bad, bad);
    // how fast: a 2048 x 2048 opaque picture turned by 3 degrees, bicubic
    const big = image(2048, 2048, "opaque");
    const map = R.pixelMap(R.xfInv(R.xfRotate(3, 1024, 1024)));
    const time = (kernel) => { const t0 = performance.now(); run(big, map, 2048, 2048, {}, false, null, kernel); return performance.now() - t0; };
    const tr = Math.min(time(rust), time(rust)), tj = Math.min(time(R.resampleBlock), time(R.resampleBlock));
    console.log(`       2048 x 2048 turned 3 degrees, bicubic: ${label} ${tr.toFixed(0)} ms (${(tr * 1e6 / 2048 / 2048).toFixed(1)} ns/px), twin ${tj.toFixed(0)} ms (${(tj * 1e6 / 2048 / 2048).toFixed(1)} ns/px)`);
}

/**
 * Liquify's bake kernel (docs/PLAN_WASM_BUILD.md §4.9, K28): `liquify_block` against its twin `liquifyBlock` in
 * inpaint_liquify.js, byte for byte, directly (with odd `byteOffset`, stride and offset, grid steps 1 / 2 / 4 / 8,
 * whole-pixel shifts, single-axis and two-axis fractional shifts, opaque / mixed / faint / transparent blocks, null and
 * round-trip tables, clamped edges and refused calls) and through the `liquifyStore` walk over all six brush modes.
 */
async function liquifyCases(px, label, L, R) {
    let seed = 0x4b3238;
    const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const rt = new Uint8Array(65536);
    for (let a = 1; a < 256; a++) for (let c = 0; c < 256; c++) { const p = Math.floor((c * a + 127) / 255); rt[(a << 8) | c] = Math.min(255, Math.floor((p * 255 + (a >> 1)) / a)); }
    const weights = R.resampleTable(1).table;
    const makeBlock = (bw, bh, kind) => {
        const d = new Uint8Array(bw * bh * 4);
        if (kind === "zero") return d;
        for (let i = 0; i < d.length; i += 4) {
            d[i] = Math.floor(rand() * 256); d[i + 1] = Math.floor(rand() * 256); d[i + 2] = Math.floor(rand() * 256);
            d[i + 3] = kind === "opaque" ? 255 : kind === "faint" ? (rand() < 0.5 ? 0 : 1 + Math.floor(rand() * 3)) : rand() < 0.25 ? 0 : rand() < 0.15 ? 255 : 1 + Math.floor(rand() * 254);
        }
        return d;
    };
    const directCases = [];
    for (const s of [1, 2, 4, 8]) {
        const ls = Math.log2(s) | 0;
        for (const kind of ["opaque", "mixed", "faint", "zero"]) {
            for (const pat of ["identity", "whole", "fracX", "fracY", "bilinear", "clampEdge"]) {
                const vw = s === 1 ? 11 : 19, vh = s === 1 ? 9 : 15;
                const X0 = 12 + s, Y0 = 8 + s, nx0 = (X0 >> ls) - 1, ny0 = (Y0 >> ls) - 1;
                const nw = ((X0 + vw - 1) >> ls) - nx0 + 3, nh = ((Y0 + vh - 1) >> ls) - ny0 + 3;
                const nodes = new Int32Array(nw * nh * 2);
                for (let j = 0; j < nh; j++) {
                    for (let i = 0; i < nw; i++) {
                        const q = (j * nw + i) * 2;
                        if (pat === "whole") {
                            nodes[q] = ((i - 1) * 2 - j) * 256;
                            nodes[q + 1] = (j - i) * 256;
                        } else if (pat === "fracX") {
                            nodes[q] = (i * 37 + j * 13) - 60;
                            nodes[q + 1] = 256;
                        } else if (pat === "fracY") {
                            nodes[q] = -256;
                            nodes[q + 1] = (i * 19 - j * 41) + 30;
                        } else if (pat === "bilinear") {
                            nodes[q] = Math.round((Math.sin(i * 0.9 + j * 0.4) * 3.7 + (i - j) * 0.6) * 256);
                            nodes[q + 1] = Math.round((Math.cos(j * 0.8 - i * 0.5) * 3.3 + (j + i) * 0.4) * 256);
                        } else if (pat === "clampEdge") {
                            nodes[q] = (i % 2 ? 40 : -40) * 256 + (j % 2 ? 73 : 0);
                            nodes[q + 1] = (j % 2 ? -40 : 40) * 256 + (i % 2 ? 0 : -91);
                        }
                    }
                }
                const bw = vw + 14, bh = vh + 14, bx = X0 - 5, by = Y0 - 5;
                const block = makeBlock(bw, bh, kind);
                const useRt = (s + pat.length) % 2 === 0 ? rt : null;
                const stride = vw * 4 + ((s & 2) ? 12 : 0), off = (s & 4) ? 16 : 0;
                directCases.push({
                    tag: `s=${s} ${kind} ${pat} rt=${!!useRt} stride=${stride} off=${off}`,
                    args: [block, bw, bh, bx, by, nodes, nw, nx0, ny0, s, useRt, off, stride, X0, Y0, vw, vh],
                });
            }
        }
    }
    const callDirect = (k, [block, bw, bh, bx, by, nodes, nw, nx0, ny0, s, table, off, stride, X0, Y0, vw, vh]) => {
        const out = new Uint8Array(off + vh * stride + 8);
        out.fill(0xa5);
        const count = typeof k.alloc === "function"
            ? k.liquifyBlock(block, bw, bh, bx, by, nodes, nw, nx0, ny0, s, table, out, off, stride, X0, Y0, vw, vh, weights)
            : L.liquifyBlock(block, bw, bh, bx, by, nodes, nw, nx0, ny0, s, table, out, off, stride, X0, Y0, vw, vh);
        return { out, count };
    };
    twinCheck({ name: `liquify_block (${label})`, builds: [[label, px]], twin: { liquifyBlock: L.liquifyBlock }, call: callDirect, cases: directCases, shift: [0, 1] });

    // full liquifyStore walk across all six brush modes, grid steps 1 / 2 / 4 / 8, clamp and region splits
    const rustKernel = (block, bw, bh, bx, by, nodes, nw, nx0, ny0, s, table, out, off, stride, X0, Y0, vw, vh) =>
        px.liquifyBlock(block, bw, bh, bx, by, nodes, nw, nx0, ny0, s, table, out, off, stride, X0, Y0, vw, vh, weights);
    let bad = "";
    let storeRuns = 0;
    for (const s of [1, 2, 4, 8]) {
        for (const kind of ["opaque", "mixed"]) {
            const W = 300, H = 270, img = makeBlock(W, H, kind);
            const field = new L.LiquifyField(W, H, s);
            const before = new Map();
            field.dab("push", 80, 70, 55, 0.4, 0.8, [14, -9], null, before);
            field.dab("grow", 200, 90, 60, 0.3, 0.9, null, null, before);
            field.dab("shrink", 120, 190, 65, 0.5, 0.9, null, null, before);
            field.dab("swirlcw", 230, 200, 55, 0.2, 0.85, null, null, before);
            field.dab("swirlccw", 60, 210, 50, 0.3, 0.85, null, null, before);
            field.dab("restore", 85, 75, 35, 0.4, 0.5, null, null, before);
            const keys = [[0, 0], [1, 0], [0, 1], [1, 1]];
            for (const [clamp, table, blockMax] of [[false, null, 65536], [true, rt, 1024]]) {
                const run = (kernel) => {
                    const out = new Uint8Array(W * H * 4);
                    const counts = [];
                    const stats = L.liquifyStore({
                        width: W, height: H, has: () => true,
                        copyRun: (sy, x0, x1, dst, off) => dst.set(img.subarray((sy * W + x0) * 4, (sy * W + x1) * 4), off),
                    }, s, (tx, ty) => field.tileNodes(tx, ty), keys, clamp, table, {
                        share: (tx, ty) => counts.push(-1 - tx - ty * 16),
                        tile: (tx, ty) => [out, (ty * 256 * W + tx * 256) * 4, W * 4],
                        done: (_tx, _ty, n) => counts.push(n),
                    }, blockMax, kernel);
                    return { out, counts, stats };
                };
                const a = run(L.liquifyBlock), b = run(rustKernel);
                storeRuns++;
                if (!eqBytes(a.out, b.out) || JSON.stringify(a.counts) !== JSON.stringify(b.counts) || JSON.stringify(a.stats) !== JSON.stringify(b.stats)) {
                    bad = `s=${s} ${kind} clamp=${clamp} rt=${!!table} blockMax=${blockMax}: counts ${JSON.stringify(b.counts)} vs ${JSON.stringify(a.counts)}`;
                    break;
                }
            }
            if (bad) break;
        }
        if (bad) break;
    }
    check(`${label} liquify_block equals its twin across ${storeRuns} liquifyStore walks (push, grow, shrink, swirlcw, swirlccw, restore, s=1..8, clamp, splits, round trip)`, !bad, bad);

    // refusals: px.liquifyBlock returns null and the raw export returns 0 without writing
    const okBlock = new Uint8Array(8 * 8 * 4), okNodes = new Int32Array(6 * 6 * 2), okOut = new Uint8Array(4 * 4 * 4);
    check(`${label} liquifyBlock refuses invalid s, small blocks, short nodes and out-of-range node offsets`,
        px.liquifyBlock(okBlock, 8, 8, 0, 0, okNodes, 6, 0, 0, 3, null, okOut, 0, 16, 0, 0, 4, 4, weights) === null
        && px.liquifyBlock(okBlock, 3, 8, 0, 0, okNodes, 6, 0, 0, 1, null, okOut, 0, 16, 0, 0, 4, 4, weights) === null
        && px.liquifyBlock(okBlock, 8, 8, 0, 0, okNodes.subarray(0, 10), 6, 0, 0, 1, null, okOut, 0, 16, 0, 0, 4, 4, weights) === null
        && px.liquifyBlock(okBlock, 8, 8, 0, 0, okNodes, 6, 1, 0, 1, null, okOut, 0, 16, 0, 0, 4, 4, weights) === null
        && px.liquifyBlock(okBlock, 8, 8, 0, 0, okNodes, 6, 0, 0, 1, null, okOut.subarray(0, 20), 0, 16, 0, 0, 4, 4, weights) === null);

    // K29: liquify_preview against previewBlock across s=1..8, levels L=0..3, inv < 1 / = 1 / > 1, negative and
    // out-of-layer margins, opaque / mixed / faint / zero windows, both held in px.alloc and plain
    const previewCases = [];
    for (const s of [1, 2, 4, 8]) {
        const W = 96, H = 72;
        const field = new L.LiquifyField(W, H, s);
        const before = new Map();
        field.dab("push", 28, 24, 30, 0.4, 0.85, [11, -7], null, before);
        field.dab("grow", 64, 30, 28, 0.3, 0.9, null, null, before);
        field.dab("swirlcw", 48, 50, 32, 0.2, 0.8, null, null, before);
        for (const kind of ["opaque", "mixed", "faint", "zero"]) {
            for (const [lv, inv, ox, oy, bw, bh, wx0, wy0] of [
                [0, 1, -4, -3, 35, 29, 0, 0],
                [0, 0.37, 10.25, 8.75, 31, 27, 4, 2],
                [1, 1.75, -6.5, 4.5, 29, 25, -2, 1],
                [2, 3.25, 40, -8, 23, 21, 5, 0],
                [3, 1.25, 88, 60, 17, 15, 8, 4],
            ]) {
                const ww = Math.max(4, (W >> lv) + 6), wh = Math.max(4, (H >> lv) + 6);
                const winData = makeBlock(ww, wh, kind);
                const outInit = new Uint8Array(bw * bh * 4);
                outInit.fill(0xa5);
                const useAlloc = ((s + lv + bw) & 1) === 0;
                previewCases.push({
                    tag: `s=${s} ${kind} L=${lv} inv=${inv} ox=${ox} oy=${oy} alloc=${useAlloc}`,
                    args: [winData, outInit, ww, wh, wx0, wy0, lv, field, ox, oy, inv, bw, bh, useAlloc],
                });
            }
        }
    }
    const callPreview = (k, [winData, out, ww, wh, wx0, wy0, lv, field, ox, oy, inv, bw, bh, useAlloc]) => {
        if (typeof k.alloc === "function") {
            let ptr = 0;
            try {
                let win;
                if (useAlloc) {
                    ptr = k.alloc(winData.byteLength);
                    const data = k.u8().subarray(ptr, ptr + winData.byteLength);
                    data.set(winData);
                    win = { data, w: ww, h: wh, x0: wx0, y0: wy0, L: lv, px: k, ptr, bytes: winData.byteLength };
                } else {
                    win = { data: winData, w: ww, h: wh, x0: wx0, y0: wy0, L: lv };
                }
                const ok = k.liquifyPreview(win, field, ox, oy, inv, out, bw, bh);
                if (!ok) throw new Error("liquifyPreview refused a valid case");
            } finally {
                if (ptr) k.free(ptr, winData.byteLength);
            }
        } else {
            L.previewBlock({ data: winData, w: ww, h: wh, x0: wx0, y0: wy0, L: lv }, field, ox, oy, inv, out, bw, bh);
        }
        return out;
    };
    twinCheck({ name: `liquify_preview (${label})`, builds: [[label, px]], twin: { previewBlock: L.previewBlock }, call: callPreview, cases: previewCases, shift: [0, 1] });

    const okField = new L.LiquifyField(32, 32, 2);
    const okWin = { data: okBlock, w: 8, h: 8, x0: 0, y0: 0, L: 0 };
    check(`${label} liquifyPreview refuses invalid arguments and out-of-range node offsets`,
        px.liquifyPreview(okWin, { w: 32, h: 32, s: 3, ni: 16, nj: 16, nodes: () => okNodes }, 0, 0, 1, okOut, 4, 4) === false
        && px.liquifyPreview({ ...okWin, w: 0 }, okField, 0, 0, 1, okOut, 4, 4) === false
        && px.liquifyPreview({ ...okWin, L: 17 }, okField, 0, 0, 1, okOut, 4, 4) === false
        && px.liquifyPreview({ ...okWin, px: {}, ptr: 8 }, okField, 0, 0, 1, okOut, 4, 4) === false
        && px.liquifyPreview(okWin, okField, 0, 0, 0, okOut, 4, 4) === false
        && px.liquifyPreview(okWin, okField, NaN, 0, 1, okOut, 4, 4) === false
        && px.liquifyPreview(okWin, { w: 32, h: 32, s: 2, ni: 1, nj: 1, nodes: (_x, _y, nw, nh) => new Int32Array(nw * nh * 2) }, 4, 0, 1, okOut, 4, 4) === false
        && px.liquifyPreview(okWin, okField, 0, 0, 1, okOut.subarray(0, 12), 4, 4) === false);

    // K31: liquify_dab against liquifyDabNodes across all 6 modes, s=1..8, odd/even ow, sel/freeze planes,
    // saturation at +-LIQUIFY_MAX, border clamping at 0..xmax / 0..ymax, and changed=0 windows
    const dabCases = [];
    for (const s of [1, 2, 4, 8]) {
        const r = rng(500 + s), ni = 24, nj = 20, sw = 20, sh = 18, si0 = 2, sj0 = 1;
        const baseSrc = new Int32Array(sw * sh * 2);
        for (let k = 0; k < baseSrc.length; k++) {
            const u = r();
            baseSrc[k] = u < 0.15 ? 0 : u < 0.25 ? L.LIQUIFY_MAX - 20 : u < 0.35 ? -L.LIQUIFY_MAX + 20 : Math.round((r() - 0.5) * 8000);
        }
        const satSrc = new Int32Array(sw * sh * 2);
        for (let k = 0; k < satSrc.length; k += 2) {
            satSrc[k] = L.LIQUIFY_MAX - 10;
            satSrc[k + 1] = -L.LIQUIFY_MAX + 10;
        }
        dabCases.push({
            tag: `s=${s} push clamp_d saturation`,
            args: ["push", satSrc, sw, si0, sj0, s, ni, nj, (si0 + 6) * s, (sj0 + 6) * s, 5 * s, 0.5, 1.0, -2 * s, 2 * s, null, null, si0 + 3, sj0 + 3, 6, 6, new Int32Array(6 * 6 * 2), new Int32Array(4)],
        });
        for (const mode of L.LIQUIFY_MODES) {
            for (const [ow, oh, i0, j0, h, amount, planeKind] of [
                [1, 3, si0 + 4, sj0 + 3, 0, 0.9, "none"],
                [2, 4, si0 + 3, sj0 + 2, 0.35, 0.75, "sel"],
                [5, 5, si0 + 2, sj0 + 2, 0.8, 1.0, "freeze"],
                [9, 7, si0 + 3, sj0 + 3, 0.5, 0.6, "both"],
                [6, 5, si0 + 4, sj0 + 4, 1.0, 0.85, "frozenAll"],
            ]) {
                const n = ow * oh;
                let sel = null, freeze = null;
                if (planeKind === "sel" || planeKind === "both") {
                    sel = new Uint8Array(n);
                    for (let k = 0; k < n; k++) sel[k] = k % 5 === 0 ? 0 : k % 5 === 1 ? 255 : (1 + ((k * 53) % 254));
                }
                if (planeKind === "freeze" || planeKind === "both") {
                    freeze = new Uint8Array(n);
                    for (let k = 0; k < n; k++) freeze[k] = k % 7 === 0 ? 255 : k % 7 === 1 ? 0 : (1 + ((k * 71) % 254));
                }
                if (planeKind === "frozenAll") {
                    freeze = new Uint8Array(n).fill(255);
                }
                const cx = (i0 + ow * 0.45) * s + 0.375, cy = (j0 + oh * 0.52) * s - 0.25;
                const rad = Math.max(ow, oh) * s * 0.65;
                const dxStep = mode === "push" ? 0.85 * s : 0, dyStep = mode === "push" ? -0.65 * s : 0;
                const outInit = new Int32Array(n * 2).fill(0x5a5a);
                const boxInit = new Int32Array([-9, -8, -7, -6]);
                dabCases.push({
                    tag: `s=${s} ${mode} ${ow}x${oh} h=${h} plane=${planeKind}`,
                    args: [mode, baseSrc, sw, si0, sj0, s, ni, nj, cx, cy, rad, h, amount, dxStep, dyStep, sel, freeze, i0, j0, ow, oh, outInit, boxInit],
                });
            }
        }
    }
    const callDab = (k, [mode, src, sw, si0, sj0, s, ni, nj, cx, cy, rad, h, amount, dxStep, dyStep, sel, freeze, i0, j0, ow, oh, out, box]) => {
        const count = k.liquifyDab(mode, src, sw, si0, sj0, s, ni, nj, cx, cy, rad, h, amount, dxStep, dyStep, sel, freeze, i0, j0, ow, oh, out, box);
        if (count === null) throw new Error("liquifyDab refused a valid case");
        return { count, out, box };
    };
    twinCheck({ name: `liquify_dab (${label})`, builds: [[label, px]], twin: { liquifyDab: L.liquifyDabNodes }, call: callDab, cases: dabCases, shift: true });

    // Three-way LiquifyField.dab parity on both builds: Map-based dab = dense JS twin (liquifyDabNodes) = Rust (px.liquifyDab)
    let badDab = "";
    const rustDabFn = (...a) => px.liquifyDab(...a);
    for (const s of [1, 2, 4, 8]) {
        const W = 540, H = 380, n = 256 / s, sh = Math.log2(n) | 0, m = n - 1, r = rng(400 + s);
        const selCells = new Map(), frCells = new Map();
        const tw = Math.ceil((Math.ceil(W / s) + 1) / n), th = Math.ceil((Math.ceil(H / s) + 1) / n);
        for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
            if (r() < 0.75) {
                const c = new Uint8Array(n * n);
                for (let k = 0; k < c.length; k++) c[k] = r() < 0.2 ? 0 : r() < 0.5 ? 255 : 1 + Math.floor(r() * 254);
                selCells.set((ty << 16) | tx, c);
            }
            if (r() < 0.75) {
                const c = new Uint8Array(n * n);
                for (let k = 0; k < c.length; k++) c[k] = r() < 0.3 ? 0 : r() < 0.5 ? 255 : 1 + Math.floor(r() * 254);
                frCells.set((ty << 16) | tx, c);
            }
        }
        const selByte = (i, j) => { const c = selCells.get(((j >> sh) << 16) | (i >> sh)); return c ? c[(j & m) * n + (i & m)] : 0; };
        const frByte = (i, j) => { const c = frCells.get(((j >> sh) << 16) | (i >> sh)); return c ? c[(j & m) * n + (i & m)] : 0; };
        const selFn = (i, j) => selByte(i, j) / 255;
        selFn.planes = (i0, j0, ow, oh) => ({ sel: L.thawPlane((tx, ty) => selCells.get((ty << 16) | tx), n, sh, i0, j0, ow, oh), freeze: null });
        const frFn = (i, j) => 1 - frByte(i, j) / 255;
        frFn.planes = (i0, j0, ow, oh) => ({ sel: null, freeze: L.thawPlane((tx, ty) => frCells.get((ty << 16) | tx), n, sh, i0, j0, ow, oh) });
        const bothFn = (i, j) => {
            const sv = selByte(i, j);
            if (!sv) return 0;
            const fv = frByte(i, j);
            return fv === 255 ? 0 : (sv / 255) * (1 - fv / 255);
        };
        bothFn.planes = (i0, j0, ow, oh) => ({
            sel: L.thawPlane((tx, ty) => selCells.get((ty << 16) | tx), n, sh, i0, j0, ow, oh),
            freeze: L.thawPlane((tx, ty) => frCells.get((ty << 16) | tx), n, sh, i0, j0, ow, oh),
        });
        const thaws = [null, selFn, frFn, bothFn];
        const fMap = new L.LiquifyField(W, H, s), fDense = new L.LiquifyField(W, H, s), fRust = new L.LiquifyField(W, H, s);
        let beforeMap = new Map(), beforeDense = new Map(), beforeRust = new Map(), snapDense = new Map(), snapRust = new Map();
        const reseedBefore = () => {
            beforeMap = new Map(fMap.cells);
            beforeDense = new Map(fDense.cells);
            beforeRust = new Map(fRust.cells);
            snapDense = new Map([...beforeDense].map(([k, c]) => [k, c.slice()]));
            snapRust = new Map([...beforeRust].map(([k, c]) => [k, c.slice()]));
        };
        for (let q = 0; q < 120 && !badDab; q++) {
            if (q % 15 === 0) reseedBefore();
            const mode = L.LIQUIFY_MODES[q % 6];
            const cx = -30 + r() * (W + 60), cy = -30 + r() * (H + 60);
            const rad = 4 + r() * 140, h = q % 11 === 0 ? 1 : r() * 0.9;
            const amount = (q % 13 === 0 ? -1 : 1) * (0.05 + r() * 0.95);
            const delta = [Math.cos(q) * 0.25 * rad, Math.sin(q) * 0.25 * rad];
            const thaw = thaws[q % 4];
            const b1 = fMap.dab(mode, cx, cy, rad, h, amount, delta, thaw, beforeMap, null);
            const b2 = fDense.dab(mode, cx, cy, rad, h, amount, delta, thaw, beforeDense, L.liquifyDabNodes);
            const b3 = fRust.dab(mode, cx, cy, rad, h, amount, delta, thaw, beforeRust, rustDabFn);
            if (JSON.stringify(b1) !== JSON.stringify(b2) || JSON.stringify(b1) !== JSON.stringify(b3)) {
                badDab = `s=${s} q=${q} ${mode}: box ${JSON.stringify(b1)} vs ${JSON.stringify(b2)} vs ${JSON.stringify(b3)}`;
                break;
            }
            if (fMap.cells.size !== fDense.cells.size || fMap.cells.size !== fRust.cells.size) {
                badDab = `s=${s} q=${q} ${mode}: size ${fMap.cells.size} vs ${fDense.cells.size} vs ${fRust.cells.size}`;
                break;
            }
            for (const [k, c1] of fMap.cells) {
                const c2 = fDense.cells.get(k), c3 = fRust.cells.get(k);
                if (!c2 || !c3) { badDab = `s=${s} q=${q} ${mode}: missing cell ${k}`; break; }
                for (let i = 0; i < c1.length; i++) {
                    if (c1[i] !== c2[i] || c1[i] !== c3[i]) { badDab = `s=${s} q=${q} ${mode}: cell ${k}[${i}] ${c1[i]} vs ${c2[i]} vs ${c3[i]}`; break; }
                }
                if (badDab) break;
                const sh1 = c1 === beforeMap.get(k), sh2 = c2 === beforeDense.get(k), sh3 = c3 === beforeRust.get(k);
                if (sh1 !== sh2 || sh1 !== sh3) { badDab = `s=${s} q=${q} ${mode}: before sharing mismatch on cell ${k}`; break; }
            }
            for (const [k, c] of beforeDense) {
                const o = snapDense.get(k);
                for (let i = 0; i < c.length; i++) if (c[i] !== o[i]) { badDab = `s=${s} q=${q} ${mode}: beforeDense cell ${k} mutated`; break; }
            }
            for (const [k, c] of beforeRust) {
                const o = snapRust.get(k);
                for (let i = 0; i < c.length; i++) if (c[i] !== o[i]) { badDab = `s=${s} q=${q} ${mode}: beforeRust cell ${k} mutated`; break; }
            }
        }
        if (!badDab) {
            const fPlainDense = fDense.copy(), fPlainRust = fRust.copy();
            const bPlain1 = fMap.dab("push", 200, 150, 45, 0.4, 0.7, [5, -3], (i, j) => ((i + j) & 1 ? 0.5 : 0), null, null);
            const bPlain2 = fPlainDense.dab("push", 200, 150, 45, 0.4, 0.7, [5, -3], (i, j) => ((i + j) & 1 ? 0.5 : 0), null, L.liquifyDabNodes);
            const bPlain3 = fPlainRust.dab("push", 200, 150, 45, 0.4, 0.7, [5, -3], (i, j) => ((i + j) & 1 ? 0.5 : 0), null, rustDabFn);
            const nPlain1 = fMap.nodes(0, 0, fMap.ni + 2, fMap.nj + 2), nPlain2 = fPlainDense.nodes(0, 0, fPlainDense.ni + 2, fPlainDense.nj + 2), nPlain3 = fPlainRust.nodes(0, 0, fPlainRust.ni + 2, fPlainRust.nj + 2);
            let plainDiff = JSON.stringify(bPlain1) !== JSON.stringify(bPlain2) || JSON.stringify(bPlain1) !== JSON.stringify(bPlain3) || !eqBytes(nPlain1, nPlain2) || !eqBytes(nPlain1, nPlain3);
            if (plainDiff) badDab = `s=${s} plain thaw mismatch`;
            const dirtyOut = new Int32Array((fDense.ni + 2) * (fDense.nj + 2) * 2).fill(999);
            const reusedNodes = fDense.nodes(0, 0, fDense.ni + 2, fDense.nj + 2, dirtyOut);
            const freshNodes = fDense.nodes(0, 0, fDense.ni + 2, fDense.nj + 2);
            for (let i = 0; i < freshNodes.length && !badDab; i++) if (reusedNodes[i] !== freshNodes[i]) badDab = `s=${s} nodes(..., out) dirty at ${i}`;
            for (let q = 0; q < 200 && (!fDense.empty || !fRust.empty); q++) {
                fDense.dab("restore", W / 2, H / 2, W + H, 0.9, 1, null, null, null, L.liquifyDabNodes);
                fRust.dab("restore", W / 2, H / 2, W + H, 0.9, 1, null, null, null, rustDabFn);
            }
            if (!fDense.empty || !fRust.empty) badDab = `s=${s} restore did not prune all cells (dense=${fDense.cells.size}, rust=${fRust.cells.size})`;
            let restoreCalls = 0;
            const countKernel = (...a) => { restoreCalls++; return px.liquifyDab(...a); };
            if (fRust.dab("restore", 100, 100, 40, 0.5, 1, null, null, null, countKernel) !== null || restoreCalls !== 0) badDab = `s=${s} empty restore called kernel`;
            fRust.dab("push", 30, 30, 15, 0.5, 0.8, [4, 4], null, null, rustDabFn);
            if (fRust.dab("restore", W - 15, H - 15, 15, 0.5, 1, null, null, null, countKernel) !== null || restoreCalls !== 0) badDab = `s=${s} untouched-cell restore called kernel`;
        }
    }
    check(`${label} liquify_dab (K30/K31): Map-based dab, liquifyDabNodes and px.liquifyDab are three-way equal across 120 random dabs at s=1..8`, !badDab, badDab);

    // K31 arena growth on a fresh Px instance: taking po / psel / pfrz / pbox after ps exceeds the first 1 MB arena chunk
    // and grows wasm memory before field.nodes fills sView in place, without detaching sView
    {
        const fresh = new px.constructor(new WebAssembly.Instance(px.module, {}), px.module);
        const bytes0 = fresh.byteLength;
        const fFresh = new L.LiquifyField(2000, 2000, 4), fWant = new L.LiquifyField(2000, 2000, 4);
        fFresh.dab("push", 900, 900, 300, 0.5, 0.8, [12, -9], null, null, null);
        fWant.dab("push", 900, 900, 300, 0.5, 0.8, [12, -9], null, null, null);
        const bigThaw = (i, j) => (((i + j) & 3) ? 0.75 : 1);
        bigThaw.planes = (_i0, _j0, ow, oh) => ({
            sel: new Uint8Array(ow * oh).fill(210),
            freeze: new Uint8Array(ow * oh).fill(35),
        });
        const bFresh = fFresh.dab("swirlcw", 1000, 1000, 500, 0.45, 0.9, null, bigThaw, new Map(fFresh.cells), (...a) => fresh.liquifyDab(...a));
        const bWant = fWant.dab("swirlcw", 1000, 1000, 500, 0.45, 0.9, null, bigThaw, new Map(fWant.cells), L.liquifyDabNodes);
        const grew = fresh.byteLength > bytes0;
        const sameBox = JSON.stringify(bFresh) === JSON.stringify(bWant);
        const sameNodes = eqBytes(fFresh.nodes(0, 0, fFresh.ni + 1, fFresh.nj + 1), fWant.nodes(0, 0, fWant.ni + 1, fWant.nj + 1));
        check(`${label} liquifyDab on a fresh Px instance grows the job arena past 1 MB without detaching the field.nodes view`,
            grew && sameBox && sameNodes, `bytes ${bytes0} -> ${fresh.byteLength}, sameBox=${sameBox}, sameNodes=${sameNodes}`);
    }

    // Refusals on px.liquifyDab and raw exports.liquify_dab
    {
        const src = new Int32Array(6 * 6 * 2), out = new Int32Array(4 * 4 * 2).fill(77), box = new Int32Array(4).fill(-5);
        const rPx = [
            px.liquifyDab("bogus", src, 6, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 1, 1, 1, null, null, 0, 0, 4, 4, out, box),
            px.liquifyDab("push", src, 6, 0, 0, 3, 5, 5, 2, 2, 4, 0.5, 1, 1, 1, null, null, 0, 0, 4, 4, out, box),
            px.liquifyDab("push", src, 0, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 1, 1, 1, null, null, 0, 0, 4, 4, out, box),
            px.liquifyDab("push", src, 6, 0, 0, 1, 0, 5, 2, 2, 4, 0.5, 1, 1, 1, null, null, 0, 0, 4, 4, out, box),
            px.liquifyDab("push", src, 6, 0, 0, 1, 5, 5, 2, 2, 0, 0.5, 1, 1, 1, null, null, 0, 0, 4, 4, out, box),
            px.liquifyDab("push", src, 6, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 0, 1, 1, null, null, 0, 0, 4, 4, out, box),
            px.liquifyDab("push", src, 6, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 1, 0, 0, null, null, 0, 0, 4, 4, out, box),
            px.liquifyDab("push", src, 6, 0, 0, 1, 5, 5, NaN, 2, 4, 0.5, 1, 1, 1, null, null, 0, 0, 4, 4, out, box),
            px.liquifyDab("push", src, 6, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 1, 1, 1, null, null, 0, 0, 0, 4, out, box),
            px.liquifyDab("push", src, 6, 1, 0, 1, 5, 5, 2, 2, 4, 0.5, 1, 1, 1, null, null, 0, 0, 4, 4, out, box),
            px.liquifyDab("push", src, 6, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 1, 1, 1, null, null, 0, 0, 6, 4, out, box),
            px.liquifyDab("push", src.subarray(0, 10), 6, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 1, 1, 1, null, null, 0, 0, 4, 4, out, box),
            px.liquifyDab("push", src, 6, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 1, 1, 1, new Uint8Array(3), null, 0, 0, 4, 4, out, box),
            px.liquifyDab("push", src, 6, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 1, 1, 1, null, new Uint8Array(3), 0, 0, 4, 4, out, box),
            px.liquifyDab("push", src, 6, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 1, 1, 1, null, null, 0, 0, 4, 4, out.subarray(0, 4), box),
            px.liquifyDab("push", src, 6, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 1, 1, 1, null, null, 0, 0, 4, 4, out, new Int32Array(2)),
            px.liquifyDab("push", src, 6, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 1, -100, 0, null, null, 0, 0, 4, 4, out, box),
            px.liquifyDab("push", { _dabSh: 6, nodes: () => new Int32Array(4) }, 6, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 1, 1, 1, null, null, 0, 0, 4, 4, null, box),
        ];
        check(`${label} liquifyDab refuses invalid modes, s, dims, NaN, short buffers and out-of-window advected samples without writing`,
            rPx.every((c) => c === null) && out.every((v) => v === 77) && box.every((v) => v === -5), JSON.stringify(rPx));
    }

    if (label === "rust simd") {
        // K30: thawPlane and liquifyDabNodes standalone refusal checks
        let badThaw = "";
        for (const s of [1, 2, 4, 8]) {
            const n = 256 / s, sh = Math.log2(n) | 0, m = n - 1, r = rng(300 + s);
            const cells = new Map();
            for (const [tx, ty] of [[0, 0], [1, 0], [0, 1], [2, 1]]) {
                const c = new Uint8Array(n * n);
                for (let k = 0; k < c.length; k++) c[k] = r() < 0.25 ? 0 : r() < 0.5 ? 255 : 1 + Math.floor(r() * 254);
                cells.set((ty << 16) | tx, c);
            }
            const cellOf = (tx, ty) => cells.get((ty << 16) | tx);
            for (const [i0, j0, ow, oh] of [[0, 0, n, n], [3, 5, n + 7, n + 9], [n - 4, n - 3, n + 10, 8], [2 * n - 2, 0, n + 5, 2 * n + 3]]) {
                const p = L.thawPlane(cellOf, n, sh, i0, j0, ow, oh);
                if (p.length !== ow * oh) { badThaw = `s=${s} len ${p.length} != ${ow * oh}`; break; }
                for (let j = 0; j < oh && !badThaw; j++) for (let i = 0; i < ow; i++) {
                    const gi = i0 + i, gj = j0 + j, c = cellOf(gi >> sh, gj >> sh);
                    const want = c ? c[(gj & m) * n + (gi & m)] : 0;
                    if (p[j * ow + i] !== want) { badThaw = `s=${s} at (${gi},${gj}): ${p[j * ow + i]} vs ${want}`; break; }
                }
            }
            if (L.thawPlane(cellOf, n, sh, 0, 0, 0, 5).length !== 0 || L.thawPlane(cellOf, n, sh, 0, 0, 5, 0).length !== 0) badThaw = `s=${s} non-empty on 0 size`;
        }
        check("thawPlane (K30): extracts byte planes across present and missing cells at s = 1, 2, 4, 8", !badThaw, badThaw);

        const src = new Int32Array(6 * 6 * 2), out = new Int32Array(4 * 4 * 2), box = new Int32Array(4);
        out.fill(77);
        let threwBogus = false;
        try { L.liquifyDabNodes("bogus", src, 6, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 1, 1, 1, null, null, 0, 0, 4, 4, out, box); } catch (e) { threwBogus = /no liquify mode/.test(String(e && e.message)); }
        const rBad = [
            L.liquifyDabNodes("push", src, 6, 0, 0, 1, 5, 5, 2, 2, 0, 0.5, 1, 1, 1, null, null, 0, 0, 4, 4, out, box),
            L.liquifyDabNodes("push", src, 6, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 0, 1, 1, null, null, 0, 0, 4, 4, out, box),
            L.liquifyDabNodes("push", src, 6, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 1, 0, 0, null, null, 0, 0, 4, 4, out, box),
            L.liquifyDabNodes("push", src, 6, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 1, 1, 1, null, null, 0, 0, 0, 4, out, box),
            L.liquifyDabNodes("push", src.subarray(0, 10), 6, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 1, 1, 1, null, null, 0, 0, 4, 4, out, box),
            L.liquifyDabNodes("push", src, 6, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 1, 1, 1, new Uint8Array(3), null, 0, 0, 4, 4, out, box),
            L.liquifyDabNodes("push", src, 6, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 1, 1, 1, null, new Uint8Array(3), 0, 0, 4, 4, out, box),
            L.liquifyDabNodes("push", src, 6, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 1, 1, 1, null, null, 0, 0, 4, 4, out.subarray(0, 4), box),
            L.liquifyDabNodes("push", src, 6, 0, 0, 1, 5, 5, 2, 2, 4, 0.5, 1, 1, 1, null, null, 0, 0, 4, 4, out, new Int32Array(2)),
        ];
        check("liquifyDabNodes (K30): refuses invalid modes, zero radius/amount/delta/dims and short buffers without writing",
            threwBogus && rBad.every((c) => c === 0) && out.every((v) => v === 77), JSON.stringify(rBad));
    }
}

// ---- K5: the selection's combine (docs/PLAN_WASM_BUILD.md §4.3) --------------------------------------------------------

/**
 * sel_combine (crates/px/src/sel.rs, px.js `selCombine`) on both builds against its twin (kernels_js.js `selCombine`),
 * and the twin against the editor's own `combineRows` with a plain extent scan (what inpaint_tiles.js `tileExtent`
 * computes): every mode x the source kinds 0 / 1 / 2 / 4 x the parts of a tile inside the image (256, 152, 16, 1, 255,
 * 152 x 16, 0) x a tile that is new, empty, random or holds pixels only beyond that part; sources at an offset with a
 * tile's stride and with a long row's (packed by px.js); refused arguments; `alphaAny`; the `selCombine` route of
 * kernels.js (`K`, loaded by relightBench): the same bytes either way, Rust's calls counted, `write` called at most once.
 */
async function selCases(js, simd, scalar, raster, K) {
    const S = 256, N = S * S * 4;
    let seed = 0x5e1c0;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const byte = (zeros) => (rnd() < zeros ? 0 : 1 + Math.floor(rnd() * 255));
    // the tile states: a new one (null), all transparent, random (a third of the pixels transparent, some of those with a
    // colour left in them), and pixels only beyond the part combined (x >= bw or y >= bh)
    const tileOf = (state, bw, bh) => {
        if (state === "new") return null;
        const t = new Uint8Array(N);
        if (state === "zero") return t;
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
            const o = (y * S + x) * 4;
            if (state === "beyond" && x < bw && y < bh) continue;
            if (state === "beyond" && rnd() < 0.97) continue;
            t[o] = byte(0); t[o + 1] = byte(0); t[o + 2] = byte(0); t[o + 3] = byte(0.33);
        }
        return t;
    };
    // a source region of bw x bh at `off` pixels with `stride` pixels a row (40 % zeros, some 255s); kinds 0 and 2: null
    const sourceOf = (kind, bw, bh, off, stride) => {
        if (kind === 0 || kind === 2) return null;
        const bpp = kind === 4 ? 4 : 1, n = (off + Math.max(0, bh - 1) * stride + bw) * bpp + 7;
        const s = new Uint8Array(n);
        for (let i = 0; i < n; i++) s[i] = rnd() < 0.1 ? 255 : byte(0.4);
        return s;
    };
    const parts = [[256, 256], [152, 256], [256, 16], [1, 1], [255, 255], [152, 16], [0, 256]];
    const cases = [];
    for (const mode of [0, 1, 2, 3]) for (const kind of [0, 1, 2, 4]) for (const [bw, bh] of parts) for (const state of ["new", "zero", "random", "beyond"]) {
        const long = cases.length % 3 === 0;   // a band's alpha: rows of 700 pixels, px.js packs them
        const stride = long ? 700 : (cases.length % 3 === 1 ? 256 : Math.max(1, bw));
        const off = long ? 3 * 700 + 11 : (stride === 256 ? 256 * 5 + 7 : 0);
        const rgb = cases.length % 2 ? 0xff0000 : (cases.length * 2654435761) >>> 8;
        cases.push({ tag: `mode ${mode} kind ${kind} ${bw}x${bh} ${state} stride ${stride}`,
            args: [tileOf(state, bw, bh), sourceOf(kind, bw, bh, off, stride), off, stride, kind, bw, bh, mode, rgb] });
    }
    // one call: { ext, bytes } with the bytes only for a tile that holds something (an empty one is dropped by the editor)
    const call = (k, [dst, src, off, stride, kind, bw, bh, mode, rgb]) => {
        if (typeof k.alloc === "function") {   // a Px: `dst` read, the result into what `write` gives
            const out = new Uint8Array(N);
            let writes = 0;
            const ext = k.selCombine(dst, S, src, off, stride, kind, bw, bh, mode, rgb, () => { writes++; return out; });
            if (writes !== (ext ? 1 : 0)) throw new Error(`write called ${writes} times for an extent ${JSON.stringify(ext)}`);
            return { ext, bytes: ext ? out : null };
        }
        const t = dst ? new Uint8Array(dst) : new Uint8Array(N);   // the twin works in place, on a new tile's zeros
        const ext = k.selCombine(t, S, src, off, stride, kind, bw, bh, mode, rgb);
        return { ext, bytes: ext ? t : null };
    };
    // the reference: the editor's combineRows over the part, then the extent of the whole tile by a plain scan
    const reference = {
        selCombine(t, size, src, off, stride, kind, bw, bh, mode, rgb) {
            const a = new Uint8Array(bw * bh), bpp = kind === 4 ? 4 : 1;
            for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
                a[y * bw + x] = kind === 0 ? 0 : kind === 2 ? 255 : src[(off + y * stride + x) * bpp + (kind === 4 ? 3 : 0)];
            }
            raster.combineRows(t, 0, size * 4, a, 0, bw, bw, bh, raster.SEL_MODES[mode], [(rgb >>> 16) & 255, (rgb >>> 8) & 255, rgb & 255]);
            let x0 = size, y0 = -1, x1 = -1, y1 = -1;
            for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
                if (!t[(y * size + x) * 4 + 3]) continue;
                if (y0 < 0) y0 = y;
                y1 = y;
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
            }
            return y0 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
        },
    };
    // the twin on a tile one byte off its word alignment: its bytes path (taken on big-endian too), copied back
    const jsOdd = {
        selCombine(t, ...rest) {
            const v = new Uint8Array(t.length + 1).subarray(1);
            v.set(t);
            const ext = js.selCombine(v, ...rest);
            t.set(v);
            return ext;
        },
    };
    twinCheck({ name: "sel_combine", title: "selCombine's twin equals combineRows and a plain extent scan", builds: [["js", js], ["js on an unaligned tile (its bytes path)", jsOdd]], twin: reference, call, cases, shift: false });
    twinCheck({ name: "sel_combine", builds: [["rust simd", simd], ["rust scalar", scalar]], twin: js, call, cases, shift: [0, 1] });

    // a new tile (mode + 8 in Rust) is a transparent one: the same bytes and extent
    let same = true, detail = "";
    for (const c of cases) {
        const [dst, ...rest] = c.args;
        if (dst !== null) continue;
        for (const px of [simd, scalar]) {
            const a = call(px, [null, ...rest]), b = call(px, [new Uint8Array(N), ...rest]);
            if (JSON.stringify(a.ext) !== JSON.stringify(b.ext) || (a.bytes && !eqBytes(a.bytes, b.bytes))) { same = false; detail = c.tag; break; }
        }
        if (!same) break;
    }
    check("sel_combine on a new tile gives what it gives on a transparent one (both builds)", same, detail);

    // refused arguments: the twin throws, px.js throws on sel_combine's REFUSED, neither writes
    const refusals = [
        ["mode 4", [new Uint8Array(N), null, 0, 0, 2, 4, 4, 4, 0]],
        ["kind 3", [new Uint8Array(N), new Uint8Array(64), 0, 4, 3, 4, 4, 0, 0]],
        ["a stride below bw", [new Uint8Array(N), new Uint8Array(4096), 0, 8, 1, 16, 4, 0, 0]],
        ["a source too short", [new Uint8Array(N), new Uint8Array(100), 0, 256, 1, 16, 4, 0, 0]],
        ["bw above the tile", [new Uint8Array(N), null, 0, 0, 2, 257, 4, 0, 0]],
        // a view shorter than its region over a longer buffer: px.js must not read on past the view's end
        ["a source view shorter than its region (a longer buffer)", [new Uint8Array(N), new Uint8Array(new ArrayBuffer(4096), 0, 100), 0, 256, 1, 16, 4, 0, 0]],
        ["a tile view shorter than the tile (a longer buffer)", [new Uint8Array(new ArrayBuffer(N + 64), 0, N - 4), null, 0, 0, 2, 4, 4, 1, 0]],
    ];
    for (const [what, args] of refusals) {
        let threw = 0;
        for (const k of [js, simd, scalar]) { try { call(k, args); } catch { threw++; } }
        check(`selCombine refuses ${what} on the twin and both builds`, threw === 3, `${threw} of 3 threw`);
    }
    // no pixel combined (bw or bh 0) with a source kind that has a buffer but none given: all three keep the tile and
    // answer its extent
    {
        const t = tileOf("random", 0, 0), got = [];
        for (const k of [js, simd, scalar]) {
            for (const [bw, bh] of [[0, 4], [4, 0]]) {
                try { got.push(JSON.stringify(call(k, [t, null, 0, 0, 1, bw, bh, 1, 0xff0000]).ext)); } catch (err) { got.push("threw " + err.message); }
            }
        }
        check("selCombine with no pixel to combine and no source buffer answers the kept tile's extent on all three", got.every((g) => g === got[0] && !g.startsWith("threw")), got.join(" | "));
    }

    // alphaAny against a plain scan
    let anyOk = true, anyDetail = "";
    for (const c of cases) {
        const [, src, off, stride, kind, bw, bh] = c.args;
        let want = false;
        if (bw > 0 && bh > 0) {
            if (kind === 2) want = true;
            else if (kind === 1 || kind === 4) {
                const bpp = kind === 4 ? 4 : 1;
                for (let y = 0; y < bh && !want; y++) for (let x = 0; x < bw; x++) if (src[(off + y * stride + x) * bpp + bpp - 1]) { want = true; break; }
            }
        }
        if (js.alphaAny(src, off, stride, kind, bw, bh) !== want) { anyOk = false; anyDetail = c.tag; break; }
    }
    check(`alphaAny says whether a source region covers anything (${cases.length} cases)`, anyOk, anyDetail);

    // the route of kernels.js: js and rust give the same, Rust's calls are counted, a twin's never
    if (!K || !K.rustPx || !Object.prototype.hasOwnProperty.call(K.ROUTE_KINDS, "selCombine")) {
        check("kernels.js has the selCombine route", false);
        return;
    }
    K.setKernels("rust");
    if (!K.rustPx()) {
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (u, ...rest) => {
            const s = String(u && u.href ? u.href : u);
            return s.startsWith("file:") ? new Response(fs.readFileSync(fileURLToPath(s))) : realFetch(u, ...rest);
        };
        try { await K.kernelsReady(); } finally { globalThis.fetch = realFetch; }
    }
    const routed = (r) => {
        K.setRoute("selCombine", r);
        K.pxCalls(true);
        const out = [];
        for (const c of cases) {
            const [dst, src, off, stride, kind, bw, bh, mode, rgb] = c.args;
            if (!dst && mode >= 2) continue;   // the editor skips a missing tile under subtract and intersect
            const target = dst ? new Uint8Array(dst) : new Uint8Array(N);
            let writes = 0;
            const ext = K.selCombine(dst ? new Uint8Array(dst) : null, () => { writes++; return target; }, src, off, stride, kind, bw, bh, mode, rgb, S);
            out.push({ ext, writes, bytes: ext ? target : null, fresh: !dst, covers: js.alphaAny(src, off, stride, kind, bw, bh) });
        }
        return { out, calls: K.pxCalls(true).sel_combine || 0 };
    };
    const viaJs = routed("js"), viaRust = routed("rust");
    let routeOk = viaJs.out.length === viaRust.out.length, routeDetail = "";
    for (let i = 0; routeOk && i < viaJs.out.length; i++) {
        const a = viaJs.out[i], b = viaRust.out[i];
        if (JSON.stringify(a.ext) !== JSON.stringify(b.ext) || (a.bytes && !eqBytes(a.bytes, b.bytes)) || a.writes > 1 || b.writes > 1 || b.writes !== (b.ext ? 1 : 0)) {
            routeOk = false;
            routeDetail = `case ${i}: js ${JSON.stringify(a.ext)} (${a.writes} writes), rust ${JSON.stringify(b.ext)} (${b.writes} writes)`;
        }
    }
    check(`kernels.js selCombine gives the same on the routes js and rust, write at most once (${viaJs.out.length} tiles)`, routeOk, routeDetail);
    // TileMaskPixels.combine's promise ("allocates for add only where the source is non-zero"): the twins' route makes a
    // missing tile only when the source covers something (alphaAny), the Rust route only when the result holds a pixel
    const lazy = viaJs.out.filter((o) => o.fresh && !o.covers);
    check(`the selCombine route js makes no missing tile from a source that covers nothing (${lazy.length} such tiles)`,
        lazy.length > 0 && lazy.every((o) => o.writes === 0), `${lazy.filter((o) => o.writes).length} written`);
    check("the selCombine route rust calls sel_combine for every tile, js never",
        viaJs.calls === 0 && viaRust.calls === viaRust.out.length, `js ${viaJs.calls}, rust ${viaRust.calls} of ${viaRust.out.length}`);
    K.setRoute("selCombine", null);
    K.setKernels("js");

    // ---- K11: mask_invert (docs/PLAN_WASM_BUILD.md §4.3) ----
    const invTileOf = (state, bw, bh) => {
        const t = new Uint8Array(N);
        if (state === "zero") return t;
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
            const o = (y * S + x) * 4;
            const inside = x < bw && y < bh;
            if (state === "full") {
                if (inside) { t[o] = 255; t[o + 3] = 255; }
            } else if (state === "fullAndBeyond") {
                if (inside) { t[o] = 255; t[o + 3] = 255; }
                else if (x === bw + 1 && y === 0) { t[o] = 255; t[o + 3] = 128; }
            } else if (state === "beyond") {
                if (!inside && rnd() < 0.05) { t[o] = byte(0); t[o + 1] = byte(0); t[o + 2] = byte(0); t[o + 3] = byte(0); }
            } else {
                const a = rnd() < 0.25 ? 0 : rnd() < 0.25 ? 255 : byte(0);
                t[o] = byte(0); t[o + 1] = byte(0); t[o + 2] = byte(0); t[o + 3] = a;
            }
        }
        return t;
    };
    const invCases = [];
    for (const [bw, bh] of parts) for (const state of ["zero", "full", "fullAndBeyond", "random", "beyond"]) {
        const rgb = invCases.length % 3 === 0 ? 0xff0000 : invCases.length % 3 === 1 ? 0xffffff : 0x2389da;
        invCases.push({ tag: `invert ${bw}x${bh} ${state} 0x${rgb.toString(16)}`, args: [invTileOf(state, bw, bh), bw, bh, rgb] });
    }
    const callInv = (k, [tile, bw, bh, rgb]) => {
        if (typeof k.alloc === "function") {
            const out = new Uint8Array(N);
            let writes = 0, wholeArg = null;
            const ext = k.maskInvert(tile, S, bw, bh, rgb, (whole) => { writes++; wholeArg = whole; return out; });
            if (writes !== (ext ? 1 : 0) || (ext && wholeArg !== true)) {
                throw new Error(`write(${wholeArg}) called ${writes} times for an extent ${JSON.stringify(ext)}`);
            }
            return { ext, bytes: ext ? out : null };
        }
        const t = new Uint8Array(tile);
        const ext = k.maskInvert(t, S, bw, bh, rgb);
        return { ext, bytes: ext ? t : null };
    };
    reference.maskInvert = (t, size, bw, bh, rgb) => {
        const r = (rgb >>> 16) & 255, g = (rgb >>> 8) & 255, b = rgb & 255;
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
            const o = (y * size + x) * 4;
            const a = 255 - t[o + 3];
            if (a) { t[o] = r; t[o + 1] = g; t[o + 2] = b; t[o + 3] = a; }
            else { t[o] = 0; t[o + 1] = 0; t[o + 2] = 0; t[o + 3] = 0; }
        }
        let x0 = size, y0 = -1, x1 = -1, y1 = -1;
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            if (!t[(y * size + x) * 4 + 3]) continue;
            if (y0 < 0) y0 = y;
            y1 = y;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
        }
        return y0 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
    };
    jsOdd.maskInvert = (t, ...rest) => {
        const v = new Uint8Array(t.length + 1).subarray(1);
        v.set(t);
        const ext = js.maskInvert(v, ...rest);
        t.set(v);
        return ext;
    };
    twinCheck({ name: "mask_invert", title: "maskInvert's twin equals a per-pixel 255 - a invert and a plain extent scan", builds: [["js", js], ["js on an unaligned tile (its bytes path)", jsOdd]], twin: reference, call: callInv, cases: invCases, shift: false });
    twinCheck({ name: "mask_invert", builds: [["rust simd", simd], ["rust scalar", scalar]], twin: js, call: callInv, cases: invCases, shift: [0, 1] });

    const invRefusals = [
        ["bw above the tile", [new Uint8Array(N), 257, 4, 0]],
        ["bh above the tile", [new Uint8Array(N), 4, 257, 0]],
        ["a tile view shorter than the tile (a longer buffer)", [new Uint8Array(new ArrayBuffer(N + 64), 0, N - 4), 4, 4, 0]],
        ["a null tile", [null, 4, 4, 0]],
    ];
    for (const [what, args] of invRefusals) {
        let threw = 0;
        for (const k of [js, simd, scalar]) { try { callInv(k, args); } catch { threw++; } }
        check(`maskInvert refuses ${what} on the twin and both builds`, threw === 3, `${threw} of 3 threw`);
    }

    if (!Object.prototype.hasOwnProperty.call(K.ROUTE_KINDS, "maskInvert")) {
        check("kernels.js has the maskInvert route", false);
        return;
    }
    K.setKernels("rust");
    const routedInv = (r) => {
        K.setRoute("maskInvert", r);
        K.pxCalls(true);
        const out = [];
        for (const c of invCases) {
            const [tile, bw, bh, rgb] = c.args;
            const target = new Uint8Array(tile);
            let writes = 0, wholeArg = null;
            const ext = K.maskInvert(new Uint8Array(tile), (whole) => { writes++; wholeArg = whole; return target; }, bw, bh, rgb, S);
            out.push({ ext, writes, whole: wholeArg, bytes: ext ? target : null });
        }
        return { out, calls: K.pxCalls(true).mask_invert || 0 };
    };
    const invViaJs = routedInv("js"), invViaRust = routedInv("rust");
    let invRouteOk = invViaJs.out.length === invViaRust.out.length, invRouteDetail = "";
    for (let i = 0; invRouteOk && i < invViaJs.out.length; i++) {
        const a = invViaJs.out[i], b = invViaRust.out[i];
        if (JSON.stringify(a.ext) !== JSON.stringify(b.ext) || (a.bytes && !eqBytes(a.bytes, b.bytes)) || a.writes !== 1 || b.writes !== (b.ext ? 1 : 0) || (b.ext && b.whole !== true)) {
            invRouteOk = false;
            invRouteDetail = `case ${i}: js ${JSON.stringify(a.ext)} (${a.writes} writes), rust ${JSON.stringify(b.ext)} (${b.writes} writes, whole=${b.whole})`;
        }
    }
    check(`kernels.js maskInvert gives the same on the routes js and rust, write(true) only when non-empty on rust (${invViaJs.out.length} tiles)`, invRouteOk, invRouteDetail);
    const invEmpty = invViaRust.out.filter((o) => !o.ext);
    check(`the maskInvert route rust skips write() when the inverted tile is empty (${invEmpty.length} such tiles)`,
        invEmpty.length > 0 && invEmpty.every((o) => o.writes === 0), `${invEmpty.filter((o) => o.writes).length} written`);
    check("the maskInvert route rust calls mask_invert for every tile, js never",
        invViaJs.calls === 0 && invViaRust.calls === invViaRust.out.length, `js ${invViaJs.calls}, rust ${invViaRust.calls} of ${invViaRust.out.length}`);
    {
        const { TileMaskPixels } = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_tiles.js")).href);
        // writable(..., whole=true) on a frozen tile skips copying the frozen tile's bytes into the new slot, while whole=false copies them
        const m0 = new TileMaskPixels(256, 256);
        const t0 = m0.writable(0, 0);
        t0.data[0] = 255; t0.data[3] = 200;
        const m0Clone = m0.clone();
        const tWhole = m0.writable(0, 0, true, true);
        const wholeSkippedCopy = tWhole.data[3] === 0 && m0Clone.tileAt(0, 0).data[3] === 200;
        const m1 = new TileMaskPixels(256, 256);
        const t1 = m1.writable(0, 0);
        t1.data[0] = 255; t1.data[3] = 200;
        const m1Clone = m1.clone();
        const tPartial = m1.writable(0, 0, true, false);
        const partialCopied = tPartial.data[3] === 200 && m1Clone.tileAt(0, 0).data[3] === 200;
        check("TileMaskPixels.writable(tx, ty, true, whole) skips the frozen tile copy when whole is true and copies when false",
            wholeSkippedCopy && partialCopied, `whole=${tWhole.data[3]}, partial=${tPartial.data[3]}`);

        // TileMaskPixels.invert on both routes of maskInvert (empty -> full -> empty, and partial soft + full tiles)
        const W = 300, H = 270;
        let tmOk = true, tmDetail = "";
        const refData = {};
        for (const route of ["js", "rust"]) {
            K.setKernels("rust");
            K.setRoute("maskInvert", route);
            const mk = new TileMaskPixels(W, H);
            mk.invert([255, 0, 0]);
            if (mk.tileKeys().length !== 4 || JSON.stringify(mk.bounds()) !== JSON.stringify([0, 0, W, H])) {
                tmOk = false; tmDetail = `${route} empty->full bounds ${JSON.stringify(mk.bounds())}`; break;
            }
            for (const key of mk.tileKeys()) {
                const t = mk.tileAt(key & 0xFFFF, key >>> 16);
                if (t.extVersion !== t.version) { tmOk = false; tmDetail = `${route} empty->full missing ext on ${key}`; break; }
            }
            const snapFull = mk.clone();
            let fullWrites = 0;
            const origW = mk.writable;
            mk.writable = function (...a) { fullWrites++; return origW.apply(this, a); };
            K.pxCalls(true);
            mk.invert([255, 0, 0]);
            mk.writable = origW;
            const cFull = K.pxCalls(true).mask_invert || 0;
            if (mk.tileKeys().length !== 0 || mk.bounds() !== null || cFull !== (route === "rust" ? 4 : 0) || (route === "rust" && fullWrites !== 0) || JSON.stringify(snapFull.bounds()) !== JSON.stringify([0, 0, W, H])) {
                tmOk = false; tmDetail = `${route} full->empty keys=${mk.tileKeys().length} calls=${cFull} writes=${fullWrites}`; break;
            }
            // partial soft tile at (0,0), full tile at (1,0), absent tiles at row 1
            const tSoft = mk.writable(0, 0);
            tSoft.data[3] = 100; tSoft.data[0] = 255;
            const tFullEdge = mk.writable(1, 0);
            for (let y = 0; y < 256; y++) for (let x = 0; x < 44; x++) {
                const o = (y * 256 + x) * 4;
                tFullEdge.data[o] = 255; tFullEdge.data[o + 3] = 255;
            }
            const snapMix = mk.clone();
            const mixBefore0 = snapMix.tileAt(0, 0).data.slice();
            const mixBefore1 = snapMix.tileAt(1, 0).data.slice();
            K.pxCalls(true);
            mk.invert([12.4, 300, -5]);
            const cMix = K.pxCalls(true).mask_invert || 0;
            if (cMix !== (route === "rust" ? 2 : 0) || mk.tileKeys().length !== 3 || mk.tileAt(1, 0) !== null) {
                tmOk = false; tmDetail = `${route} mix calls=${cMix} keys=${mk.tileKeys().length}`; break;
            }
            for (const key of mk.tileKeys()) {
                const t = mk.tileAt(key & 0xFFFF, key >>> 16);
                if (t.extVersion !== t.version) { tmOk = false; tmDetail = `${route} mix missing ext on ${key}`; break; }
            }
            if (!eqBytes(snapMix.tileAt(0, 0).data, mixBefore0) || !eqBytes(snapMix.tileAt(1, 0).data, mixBefore1)) {
                tmOk = false; tmDetail = `${route} mix altered frozen clone`; break;
            }
            const outTiles = new Uint8Array(3 * N);
            outTiles.set(mk.tileAt(0, 0).data, 0);
            outTiles.set(mk.tileAt(0, 1).data, N);
            outTiles.set(mk.tileAt(1, 1).data, 2 * N);
            refData[route] = outTiles;
        }
        if (tmOk && !eqBytes(refData.js, refData.rust)) { tmOk = false; tmDetail = "js vs rust bytes differ"; }
        check("TileMaskPixels.invert on js and rust routes matches, drops newly-empty tiles, keeps fresh extents, and preserves frozen clones", tmOk, tmDetail);
    }
    K.setRoute("maskInvert", null);
    K.setKernels("js");

    if (process.env.PX_BENCH) {
        // one tile, replace from RGBA (the wand's case) and add from alpha (the range's): the twin in place, Rust with
        // its copies in and out; explains only (docs/PLAN_WASM_BUILD.md §1.1 rule 5)
        const tile = tileOf("random", S, S), rgbaSrc = sourceOf(4, S, S, 0, S), alphaSrc = sourceOf(1, S, S, 0, S);
        for (const [what, src, kind, mode] of [["replace from RGBA", rgbaSrc, 4, 0], ["add from alpha", alphaSrc, 1, 1]]) {
            const t = new Uint8Array(N), out = new Uint8Array(N);
            const rows = [
                ["twin", () => { t.set(tile); js.selCombine(t, S, src, 0, S, kind, S, S, mode, 0xff0000); }],
                ["simd", () => simd.selCombine(tile, S, src, 0, S, kind, S, S, mode, 0xff0000, () => out)],
                ["scalar", () => scalar.selCombine(tile, S, src, 0, S, kind, S, S, mode, 0xff0000, () => out)],
            ];
            const med = benchMedians(rows, { rounds: 200 });
            console.log(`       sel_combine one 256² tile, ${what}: ${rows.map(([n]) => `${n} ${med[n].toFixed(3)}`).join(", ")} ms (median of 200)`);
        }
        {
            const t = new Uint8Array(N), out = new Uint8Array(N);
            const rows = [
                ["twin", () => { t.set(tile); js.maskInvert(t, S, S, S, 0xff0000); }],
                ["simd", () => simd.maskInvert(tile, S, S, S, 0xff0000, () => out)],
                ["scalar", () => scalar.maskInvert(tile, S, S, S, 0xff0000, () => out)],
            ];
            const med = benchMedians(rows, { rounds: 200 });
            console.log(`       mask_invert one 256² tile: ${rows.map(([n]) => `${n} ${med[n].toFixed(3)}`).join(", ")} ms (median of 200)`);
        }
    }
}

// ---- K21: map_tile_stats, rangeTileClass, rangeRowBookkeeping (docs/PLAN_WASM_BUILD.md §4.8) --------------------------

async function rangeCases(js, simd, scalar, resample, K) {
    const weights = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_weights.js")).href);
    const edges = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_edges.js")).href);
    const { u16Bilinear, rangeWeight, rangeTileClass, rangeRowBookkeeping } = weights;
    const { snapField, snapParams, SNAP_TAU } = edges;

    let seed = 0x4b3231;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

    // Plain independent reference for mapTileStats using resample.xfBox
    const refMapTileStats = (map, rmax, mw, mh, xf, W, H, thresh = 0, tile = 256) => {
        const cols = Math.ceil(W / tile);
        const rows = Math.ceil(H / tile);
        const min = new Uint16Array(cols * rows);
        const max = new Uint16Array(cols * rows);
        const edge = new Uint8Array(cols * rows);
        const hasRmax = rmax != null && rmax.length > 0;
        const thr = hasRmax ? Math.max(0, Math.min(0xffffffff, Math.floor(Number(thresh) || 0))) : 0;
        for (let ty = 0; ty < rows; ty++) {
            const y0 = ty * tile, y1 = Math.min(H, (ty + 1) * tile);
            for (let tx = 0; tx < cols; tx++) {
                const x0 = tx * tile, x1 = Math.min(W, (tx + 1) * tile);
                const [mx0, my0, mx1, my1] = resample.xfBox(xf, x0, y0, x1, y1);
                const ix0 = Math.max(0, Math.min(mw - 1, Math.floor(mx0 - 2)));
                const iy0 = Math.max(0, Math.min(mh - 1, Math.floor(my0 - 2)));
                const ix1 = Math.max(0, Math.min(mw - 1, Math.ceil(mx1 + 2)));
                const iy1 = Math.max(0, Math.min(mh - 1, Math.ceil(my1 + 2)));
                let lo = 65535, hi = 0, hasEdge = 0;
                for (let my = iy0; my <= iy1; my++) {
                    for (let mx = ix0; mx <= ix1; mx++) {
                        const v = map[my * mw + mx];
                        if (v < lo) lo = v;
                        if (v > hi) hi = v;
                    }
                }
                if (hasRmax) {
                    const eix0 = Math.max(0, Math.floor(mx0 - 2));
                    const eiy0 = Math.max(0, Math.floor(my0 - 2));
                    const eix1 = Math.min(mw - 1, Math.ceil(mx1 + 2));
                    const eiy1 = Math.min(mh - 1, Math.ceil(my1 + 2));
                    for (let my = eiy0; my <= eiy1 && !hasEdge; my++) {
                        for (let mx = eix0; mx <= eix1; mx++) {
                            if (rmax[my * mw + mx] > thr) { hasEdge = 1; break; }
                        }
                    }
                }
                const idx = ty * cols + tx;
                min[idx] = lo;
                max[idx] = hi;
                edge[idx] = hasEdge;
            }
        }
        return { min, max, edge, cols, rows };
    };

    const makeMapPair = (mw, mh, kind) => {
        const map = new Uint16Array(mw * mh);
        const rmax = new Uint16Array(mw * mh);
        if (kind === "ramp") {
            for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
                map[y * mw + x] = Math.round(((x + y * 0.25) / Math.max(1, mw + mh * 0.25)) * 65535);
                rmax[y * mw + x] = (x === (mw >> 1)) ? 2000 : 100;
            }
        } else if (kind === "extremes") {
            for (let i = 0; i < map.length; i++) {
                map[i] = i % 7 === 0 ? 0 : i % 11 === 0 ? 65535 : Math.floor(rnd() * 65536);
                rmax[i] = i % 13 === 0 ? 65535 : i % 5 === 0 ? 0 : Math.floor(rnd() * 65536);
            }
        } else {
            for (let i = 0; i < map.length; i++) {
                map[i] = Math.floor(rnd() * 65536);
                rmax[i] = Math.floor(rnd() * 65536);
            }
        }
        return { map, rmax };
    };

    // Transform variants: upright, 90° CW, 180°, 270° CW, h-flip, v-flip, free rotation+shift, out-of-bounds shift
    const makeXfs = (mw, mh, W, H) => [
        ["upright", [mw / W, 0, 0, mh / H, 0, 0]],
        ["hflip", [-mw / W, 0, 0, mh / H, mw, 0]],
        ["vflip", [mw / W, 0, 0, -mh / H, 0, mh]],
        ["rot180", [-mw / W, 0, 0, -mh / H, mw, mh]],
        ["rot90", [0, mh / W, -mw / H, 0, mw, 0]],
        ["rot270", [0, -mh / W, mw / H, 0, 0, mh]],
        ["rot17_shift", [0.23 * Math.cos(0.3), 0.23 * Math.sin(0.3), -0.21 * Math.sin(0.3), 0.21 * Math.cos(0.3), 17.5, -9.25]],
        ["extend_2x", [2 * mw / W, 0, 0, 2 * mh / H, 0, 0]],
        ["outside_clamped", [0.1, 0, 0, 0.1, -500, mw + 500]],
    ];

    const shapes = [
        [1, 1, 1, 1],
        [7, 5, 13, 9],
        [8, 3, 256, 256],
        [9, 4, 257, 255],
        [15, 11, 513, 257],
        [16, 12, 600, 300],
        [17, 13, 600, 300],
        [23, 19, 800, 550],
        [37, 23, 1000, 700],
        [120, 90, 1600, 1200],
    ];

    const cases = [];
    for (const [mw, mh, W, H] of shapes) {
        const { map, rmax } = makeMapPair(mw, mh, (mw + mh) % 3 === 0 ? "ramp" : (mw + mh) % 3 === 1 ? "extremes" : "random");
        for (const [xName, xf] of makeXfs(mw, mh, W, H)) {
            const withRmax = (cases.length % 3) !== 0;
            const thresh = [0, 1311, 2000, 32768, 65534, 65535][cases.length % 6];
            cases.push({
                tag: `map ${mw}x${mh} doc ${W}x${H} ${xName} rmax=${withRmax} thr=${thresh}`,
                args: [map, withRmax ? rmax : null, mw, mh, xf, W, H, thresh, 256],
            });
        }
    }

    // Specific halo = 2 boundary pin & thresh > (not >=) boundary pin:
    // On a 64 x 64 map for a 256 x 256 doc (1 tile, scale 0.25 -> mapped box [0, 0, 64, 64] shifted to [10, 10, 20, 20]):
    // Halo 2 reaches ix0 = 8, iy0 = 8, ix1 = 22, iy1 = 22; halo 1 would only reach 9..21.
    {
        const mw = 64, mh = 64, W = 256, H = 256;
        const map = new Uint16Array(mw * mh).fill(30000);
        const rmax = new Uint16Array(mw * mh).fill(500);
        // Place min spike at (8, 15) and max spike at (22, 15) - exactly 2 texels outside [10, 20]
        map[15 * mw + 8] = 1234;
        map[15 * mw + 22] = 64321;
        rmax[15 * mw + 8] = 501;
        const xf = [10 / 256, 0, 0, 10 / 256, 10, 10];
        cases.push({
            tag: "halo=2 boundary and thresh=500 (<501 -> edge 1)",
            args: [map, rmax, mw, mh, xf, W, H, 500, 256],
        });
        cases.push({
            tag: "halo=2 boundary and thresh=501 (==501 -> edge 0)",
            args: [map, rmax, mw, mh, xf, W, H, 501, 256],
        });
        const st500 = simd.mapTileStats(map, rmax, mw, mh, xf, W, H, 500, 256);
        const st501 = simd.mapTileStats(map, rmax, mw, mh, xf, W, H, 501, 256);
        check("map_tile_stats 2-texel halo reaches ±2 texels and thresh uses strict >",
            st500.min[0] === 1234 && st500.max[0] === 64321 && st500.edge[0] === 1 && st501.edge[0] === 0,
            `st500=${st500.min[0]}..${st500.max[0]} e=${st500.edge[0]}, st501 e=${st501.edge[0]}`);
    }

    let refOk = true, refDetail = "";
    for (const c of cases) {
        const got = js.mapTileStats(...c.args), want = refMapTileStats(...c.args);
        const d = twinDiff(got, want, [], {});
        if (d) { refOk = false; refDetail = `${c.tag}: ${d}`; break; }
    }
    check(`js mapTileStats equals the plain reference (${cases.length} cases)`, refOk, refDetail);

    twinCheck({
        name: "map_tile_stats",
        builds: [["rust simd", simd], ["rust scalar", scalar]],
        twin: js,
        call: (k, args) => k.mapTileStats(...args),
        cases,
    });

    // Refusal checks on invalid arguments and out-of-window wy0
    {
        const map = new Uint16Array(16 * 16), rmax = new Uint16Array(16 * 16);
        const xf = [1, 0, 0, 1, 0, 0];
        const badArgs = [
            ["null map", [null, rmax, 16, 16, xf, 64, 64, 100, 256]],
            ["short map", [new Uint16Array(48), null, 16, 16, [0, 0, 0, 0, 0, 0], 64, 64, 100, 256]],
            ["short rmax", [map, new Uint16Array(48), 16, 16, [0, 0, 0, 0, 0, 0], 64, 64, 100, 256]],
            ["zero mw", [map, null, 0, 16, xf, 64, 64, 100, 256]],
            ["zero W", [map, null, 16, 16, xf, 0, 64, 100, 256]],
            ["zero tile", [map, null, 16, 16, xf, 64, 64, 100, 0]],
            ["NaN xf", [map, null, 16, 16, [NaN, 0, 0, 1, 0, 0], 64, 64, 100, 256]],
        ];
        for (const [what, args] of badArgs) {
            let threw = 0;
            for (const k of [js, simd, scalar]) {
                try { k.mapTileStats(...args); } catch { threw++; }
            }
            check(`mapTileStats refuses ${what} on twin and both builds`, threw === 3, `${threw}/3 threw`);
        }
        // Raw export refuses wy0 window that does not cover tile's iy0..iy1
        const a = simd.job;
        try {
            const pm = simd._in(a, map, map.byteLength);
            const pMin = a.take(2), pMax = a.take(2), pEdge = a.take(1);
            const okOut = simd.exports.map_tile_stats(pm, 0, 16, 16, 5, 4, 64, 0, 64, 256, 0.25, 0, 0, 0.25, 0, 0, 0, pMin, pMax, pEdge);
            check("raw map_tile_stats returns 0 when [iy0..iy1] falls outside [wy0..wy0+wh)", okOut === 0, `got ${okOut}`);
        } finally { simd._reset(a); }
    }

    // Route & trap recovery check via kernels.js
    {
        K.setKernels("rust");
        if (!K.rustPx()) {
            const realFetch = globalThis.fetch;
            globalThis.fetch = async (u, ...rest) => {
                const s = String(u && u.href ? u.href : u);
                return s.startsWith("file:") ? new Response(fs.readFileSync(fileURLToPath(s))) : realFetch(u, ...rest);
            };
            try { await K.kernelsReady(); } finally { globalThis.fetch = realFetch; }
        }
        const { map, rmax } = makeMapPair(64, 48, "ramp");
        const xf = [64 / 600, 0, 0, 48 / 300, 0, 0];
        K.setRoute("mapTileStats", "js");
        K.pxCalls(true);
        const viaJs = K.mapTileStats(map, rmax, 64, 48, xf, 600, 300, 1000, 256);
        const jsCalls = K.pxCalls(true).map_tile_stats || 0;
        K.setRoute("mapTileStats", "rust");
        const viaRust = K.mapTileStats(map, rmax, 64, 48, xf, 600, 300, 1000, 256);
        const rustCalls = K.pxCalls(true).map_tile_stats || 0;
        K.setRoute("mapTileStats", null);
        check("kernels.js mapTileStats route switches between twin (0 calls) and rust (rows calls) with identical output",
            jsCalls === 0 && rustCalls === Math.ceil(300 / 256) && twinDiff(viaRust, viaJs, [], {}) === "",
            `jsCalls=${jsCalls}, rustCalls=${rustCalls}`);
        K.setKernels("js");
    }

    // rangeTileClass boundary & ulp checks (lo / hi on tile min / max, ±1 ulp, ±1e-12, feathers, invert)
    {
        const ulp = Number.EPSILON;
        const rHard = { lo: 0.25, hi: 0.75, fLo: 0, fHi: 0, invert: false };
        // Exact boundary at lo and hi
        check("rangeTileClass hard boundaries at lo and hi",
            rangeTileClass(0.25, 0.75, rHard) === "full"
            && rangeTileClass(0.25 - 1e-12, 0.75 + 1e-12, rHard) === "full"
            && rangeTileClass(0.25 - 1e-12 * (1 - 4 * ulp), 0.75 + 1e-12 * (1 - 4 * ulp), rHard) === "full"
            && rangeTileClass(0.25 - 1e-12 - 1e-15, 0.5, rHard) === "compute"
            && rangeTileClass(0.5, 0.75 + 1e-12 + 1e-15, rHard) === "compute"
            && rangeTileClass(0.0, 0.25 - 1e-12 - 1e-15, rHard) === "empty"
            && rangeTileClass(0.75 + 1e-12 + 1e-15, 1.0, rHard) === "empty"
            && rangeTileClass(0.0, 0.25, rHard) === "compute"
            && rangeTileClass(0.75, 1.0, rHard) === "compute");

        // Invert combinations: r.invert xor jobInvert
        check("rangeTileClass invert (r.invert xor jobInvert)",
            rangeTileClass(0.3, 0.7, rHard, true) === "empty"
            && rangeTileClass(0.3, 0.7, { ...rHard, invert: true }, false) === "empty"
            && rangeTileClass(0.3, 0.7, { ...rHard, invert: true }, true) === "full"
            && rangeTileClass(0.0, 0.1, rHard, true) === "full"
            && rangeTileClass(0.0, 0.1, { ...rHard, invert: true }, false) === "full"
            && rangeTileClass(0.0, 0.1, { ...rHard, invert: true }, true) === "empty");

        // Feathers (fLo > 0, fHi > 0) and sstep's 1e-14 clamp
        const rSoft = { lo: 0.3, hi: 0.7, fLo: 0.1, fHi: 0.1, invert: false };
        check("rangeTileClass soft feather boundaries",
            rangeTileClass(0.3, 0.7, rSoft) === "full"
            && rangeTileClass(0.3 - 0.1 * 1e-15, 0.7 + 0.1 * 1e-15, rSoft) === "full"
            && rangeTileClass(0.25, 0.7, rSoft) === "compute"
            && rangeTileClass(0.3, 0.75, rSoft) === "compute"
            && rangeTileClass(0.0, 0.2, rSoft) === "empty"
            && rangeTileClass(0.0, 0.2 + 0.1 * 1e-15, rSoft) === "empty"
            && rangeTileClass(0.8, 1.0, rSoft) === "empty"
            && rangeTileClass(0.8 - 0.1 * 1e-15, 1.0, rSoft) === "empty"
            && rangeTileClass(0.15, 0.25, rSoft) === "compute"
            && rangeTileClass(0.75, 0.85, rSoft) === "compute"
            && rangeTileClass(0.15, 0.85, rSoft) === "compute");

        // Convex combination guarantee across random/step maps (with and without snapField)
        const mw = 48, mh = 36, W = 600, H = 400;
        const { map } = makeMapPair(mw, mh, "ramp");
        const guide = new Uint8Array(mw * mh * 4);
        for (let i = 0; i < guide.length; i++) guide[i] = Math.floor(rnd() * 256);
        const rmax = simd.rangeMax(map, mw, mh);
        const [sigmaR, tau] = snapParams(50);
        const xf = [mw / W, 0, 0, mh / H, 0, 0];
        const st = simd.mapTileStats(map, rmax, mw, mh, xf, W, H, Math.round(tau * 65535), 256);
        const mapObj = { data: map, w: mw, h: mh }, guideObj = { data: guide, w: mw, h: mh };
        let convexOk = true, convexDetail = "";
        for (const lim of [
            { lo: 0.25, hi: 0.65, fLo: 0, fHi: 0, invert: false },
            { lo: 0.3, hi: 0.6, fLo: 0.08, fHi: 0.08, invert: false },
            { lo: 0.3, hi: 0.6, fLo: 0.05, fHi: 0.05, invert: true },
        ]) {
            for (const jobInv of [false, true]) {
                for (let ty = 0; ty < st.rows && convexOk; ty++) {
                    for (let tx = 0; tx < st.cols && convexOk; tx++) {
                        const idx = ty * st.cols + tx;
                        const cls = rangeTileClass(st.min[idx] / 65535, st.max[idx] / 65535, lim, jobInv);
                        if (cls === "compute") continue;
                        const wantA = cls === "full" ? 255 : 0;
                        const x0 = tx * 256, x1 = Math.min(W, x0 + 256);
                        const y0 = ty * 256, y1 = Math.min(H, y0 + 256);
                        for (let y = y0; y < y1 && convexOk; y += 7) {
                            for (let x = x0; x < x1 && convexOk; x += 7) {
                                const mx = xf[0] * (x + 0.5) + xf[2] * (y + 0.5) + xf[4];
                                const my = xf[1] * (x + 0.5) + xf[3] * (y + 0.5) + xf[5];
                                const vBil = u16Bilinear(map, mw, mh, mx, my);
                                const vSnap = snapField(mapObj, guideObj, mx, my, rnd(), rnd(), rnd(), sigmaR, tau);
                                for (const v of [vBil, vSnap]) {
                                    const w = rangeWeight(v, lim);
                                    const a = Math.round(255 * (jobInv ? 1 - w : w));
                                    if (a !== wantA) {
                                        convexOk = false;
                                        convexDetail = `tile (${tx},${ty}) cls=${cls} got a=${a} at v=${v} (min=${st.min[idx]/65535}, max=${st.max[idx]/65535})`;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        check("rangeTileClass full/empty tiles match per-pixel bilinear and snapField weights across all tiles", convexOk, convexDetail);
    }

    // rangeRowBookkeeping on partial right/bottom tiles (600 x 300, 257 x 255, 15000 x 10000)
    {
        let bkOk = true, bkDetail = "";
        for (const [W, H] of [[512, 512], [600, 300], [257, 255], [15000, 10000]]) {
            const cols = Math.ceil(W / 256), rows = Math.ceil(H / 256);
            for (const ty of [0, rows - 1]) {
                for (const pattern of ["all_empty", "all_full", "mixed"]) {
                    const rowClasses = Array.from({ length: cols }, (_, tx) =>
                        pattern === "all_empty" ? "empty" : pattern === "all_full" ? "full" : ((tx + ty) % 2 === 0 ? "full" : "empty")
                    );
                    const got = rangeRowBookkeeping(W, H, ty, rowClasses, 256);
                    const y0 = ty * 256, y1 = Math.min(H, y0 + 256), th = y1 - y0;
                    let wantAlpha = 0, bX0 = Infinity, bY0 = Infinity, bX1 = -Infinity, bY1 = -Infinity;
                    const wantTiles = [];
                    for (let tx = 0; tx < cols; tx++) {
                        if (rowClasses[tx] !== "full") continue;
                        const x0 = tx * 256, x1 = Math.min(W, x0 + 256), tw = x1 - x0;
                        wantAlpha += 255 * tw * th;
                        wantTiles.push({ tx, ty, full: true });
                        bX0 = Math.min(bX0, x0); bY0 = Math.min(bY0, y0);
                        bX1 = Math.max(bX1, x1); bY1 = Math.max(bY1, y1);
                    }
                    const wantBounds = Number.isFinite(bX0) ? [bX0, bY0, bX1, bY1] : null;
                    if (got.alphaSum !== wantAlpha || JSON.stringify(got.bounds) !== JSON.stringify(wantBounds) || JSON.stringify(got.tiles) !== JSON.stringify(wantTiles)) {
                        bkOk = false;
                        bkDetail = `${W}x${H} ty=${ty} ${pattern}: got ${JSON.stringify(got)}, want alpha=${wantAlpha} bounds=${JSON.stringify(wantBounds)}`;
                        break;
                    }
                }
            }
        }
        check("rangeRowBookkeeping matches exact in-image pixel alphaSum, bounds, and tiles on full and partial rows", bkOk, bkDetail);
    }

    if (process.env.PX_BENCH) {
        const mw = 4096, mh = 2731, W = 15000, H = 10000;
        const { map, rmax } = makeMapPair(mw, mh, "ramp");
        const xf = [mw / W, 0, 0, mh / H, 0, 0];
        const thr = Math.round(SNAP_TAU * 65535);
        for (const [what, rm] of [["depth only", null], ["depth + rmax", rmax]]) {
            const rows = [
                ["twin", () => js.mapTileStats(map, rm, mw, mh, xf, W, H, thr, 256)],
                ["simd", () => simd.mapTileStats(map, rm, mw, mh, xf, W, H, thr, 256)],
                ["scalar", () => scalar.mapTileStats(map, rm, mw, mh, xf, W, H, thr, 256)],
            ];
            const med = benchMedians(rows, { rounds: 15 });
            console.log(`       map_tile_stats 4096x2731 -> 15000x10000 (${what}): ${rows.map(([n]) => `${n} ${med[n].toFixed(2)}`).join(", ")} ms (median of 15)`);
        }
    }
}

async function main() {
    const { BLENDS } = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "blend_modes.js")).href);
    for (const b of BLENDS) if (b.op >= 5) BLEND_NAMES[b.op - 5] = b.id;
    const TIER_C_NAMES = ["hue", "saturation", "color", "luminosity", "darker-color", "lighter-color"];
    for (let i = 0; i < TIER_C_NAMES.length; i++) BLEND_NAMES[19 + i] = TIER_C_NAMES[i];
    const js = await import(pathToFileURL(path.join(PX_DIR, "kernels_js.js")).href);
    const resample = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_resample.js")).href);
    const liquify = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_liquify.js")).href);
    const raster = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_raster.js")).href);
    const { loadPx } = await import(pathToFileURL(path.join(PX_DIR, "px.js")).href);
    const ref = {
        ...reference,
        distTransform: (f, w, h) => raster.distanceTransform(f, w, h),
        flood: (d, w, h, sx, sy, tol, contiguous) => {
            const m = raster.floodMask(d, w, h, sx, sy, tol, contiguous);
            m.count = m.reduce((n, v) => n + v, 0);
            return m;
        },
    };
    const label = "reference (distanceTransform / floodMask for the EDT and the flood)";
    if (ONLY) console.log(`PX_ONLY: only the groups ${GROUPS.filter((g) => ONLY.has(g)).join(", ")} run (a filtered run, not the full test)`);
    await group("twinSelfTest", () => twinSelfTest());
    await group("mip", () => mipCases(ref, label, js));
    await group("edt", () => edtCases(ref, label, js, raster));
    await group("flood", () => floodCases(ref, label, js, raster));
    await group("composite", () => compositeCases(ref, label, js));
    await group("matchTwin", () => matchTwinCases(js));
    await group("smudgeTwin", () => smudgeTwinCases(js));
    await group("poissonTwin", () => poissonTwinCases(js));
    await group("png", () => pngCases(ref, label, js));
    const simdPx = await loadPx(fs.readFileSync(path.join(PX_DIR, "px.wasm")));
    const scalarPx = await loadPx(fs.readFileSync(path.join(PX_DIR, "px_scalar.wasm")));
    await group("compositeSha", () => compositeShaCases(js, simdPx, scalarPx));
    await group("blendFixture", () => blendFixtureCases(js, simdPx, scalarPx));
    await group("blendGlsl", () => blendGlslCases());
    await group("tierC", () => tierCCases(js, simdPx, scalarPx, ref));
    await group("relightBench", () => relightBench(js, simdPx));   // before memoryCases grows simdPx past 2 GB
    await group("relightStripe", () => relightStripeCases(js, simdPx, scalarPx));
    await group("counter", () => counterCases(simdPx));
    await group("split", () => splitCases(simdPx, js));
    await group("route", () => routeCases(js, simdPx, scalarPx, raster));
    await group("trap", () => trapCases(js, simdPx, raster));
    await group("lifecycle", () => lifecycleCases(js));
    await group("sel", async () => selCases(js, simdPx, scalarPx, raster, await import(pathToFileURL(path.join(PX_DIR, "kernels.js")).href)));
    await group("range", async () => rangeCases(js, simdPx, scalarPx, resample, await import(pathToFileURL(path.join(PX_DIR, "kernels.js")).href)));
    await group("pngFilter", () => pngFilterCases(js, simdPx, scalarPx));
    await group("retouchRoute", () => retouchRouteCases(js));
    for (const [name, px] of [["simd", simdPx], ["scalar", scalarPx]]) {
        const label = `rust ${name}`;
        check(`${label} module reports its SIMD flag`, px.simd === (name === "simd"));
        await group("mip", () => mipCases(px, label, js));
        await group("edt", () => edtCases(px, label, js, raster));
        await group("flood", () => floodCases(px, label, js, raster));
        await group("job", () => jobCases(px, label, raster));
        await group("mask", () => maskCases(px, label, js));
        await group("dab", () => dabCases(px, label));
        await group("tone", () => toneCases(px, label));
        await group("freq", () => freqCases(px, label));
        await group("edge", () => edgeCases(px, label, js));
        await group("relight", () => relightCases(px, label, js));
        await group("pngRead", () => pngReadCases(px, label, js));
        await group("composite", () => compositeCases(px, label, js));
        await group("match", () => matchCases(px, label, js));
        await group("smudge", () => smudgeCases(px, label, js));
        await group("poisson", () => poissonCases(px, label, js));
        await group("png", () => pngCases(px, label, js));
        await group("pngPart", () => pngPartCases(px, label));
        await group("psd", () => psdCases(px, label, js));
        await group("resample", () => resampleCases(px, label, resample));
        await group("liquify", () => liquifyCases(px, label, liquify, resample));
        await group("memory", () => memoryCases(px, label));
    }
    // a group PX_ONLY named that main() never reached (GROUPS and the calls above out of step) fails the run
    const missed = ONLY ? [...ONLY].filter((g) => !groupsRan.has(g)) : GROUPS.filter((g) => !groupsRan.has(g));
    if (missed.length) check(`every group in GROUPS ran${ONLY ? " that PX_ONLY named" : ""}`, false, `never reached: ${missed.join(", ")}`);
    console.log(failures ? `FAIL (${failures})${ONLY_NOTE}` : `PASS${ONLY_NOTE}`);
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
