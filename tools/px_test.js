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
    "blendFixture", "blendGlsl", "tierC", "relightBench", "relightStripe", "counter", "split", "route", "trap", "lifecycle", "sel", "range", "guided",
    "pngFilter", "retouchRoute", "tiff", "job", "mask", "dab", "tone", "freq", "edge", "relight", "pngRead", "match", "smudge", "poisson", "pngPart", "psd", "resample", "liquify", "memory"];
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
/**
 * A NaN's sign and payload: `Math.max` and `Math.min` hand back either bit pattern depending on V8's tier (Electron 44,
 * measured 2026-11-09: 0xffc00000 and 0xffffffff in one run), so a test of them can only ask that both sides are NaN.
 */
const NAN_BITS = { name: "a NaN's bits", allow: (got, want) => got !== got && want !== want };

function twinDiff(got, want, rules, counts, at = "out") {
    if (want instanceof ArrayBuffer || got instanceof ArrayBuffer) {
        if (!(want instanceof ArrayBuffer) || !(got instanceof ArrayBuffer)) return `${at}: an ArrayBuffer against ${got instanceof ArrayBuffer ? String(want) : String(got)}`;
        return twinDiff(new Uint8Array(got), new Uint8Array(want), rules, counts, at);
    }
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
            const d = w2.threw ? `threw ${w2.threw}` : twinDiff(w2.out, want.out, rules, {});
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

    // K6 (docs/PLAN_WASM_BUILD.md §4.2): rows of 1..67 px (and 128, 255, 256, 257 px) at bpp 3 and 4, with forced
    // Paeth ties (first tie pa = pc < pb with a != c, second tie pb = pc < pa with b != c, triple tie a = b = c),
    // odd and even Average sums (rounding floor((a + b) / 2)), Up across every 16-byte group and 0..15 tail length,
    // wrapping byte sums >= 256, and odd-offset views.
    let tieOk = true, tieDetail = "", acTies = 0, bcTies = 0;
    const widths = [...Array.from({ length: 67 }, (_, i) => i + 1), 128, 255, 256, 257];
    // When upRow alternates around 100 by d = b - c in {+20, -20, +12, -12}, choosing a = curRow[idx - bpp] as a
    // function of (c, d) alone (never overwriting upRow) forces each Paeth regime at pixel x >= 1:
    //   0: a = c - 2*d  -> pa = |d|, pb = 2|d|, pc = |d|   (first tie: pa == pc < pb, a != c, picks a)
    //   1: a = c - d/2  -> pa = |d|, pb = |d|/2, pc = |d|/2 (second tie: pb == pc < pa, b != c, picks b)
    //   2: a = c + 2*d  -> pa = |d|, pb = 2|d|, pc = 3|d|  (strictly picks a)
    //   3: a = c - d/4  -> pa = |d|, pb = |d|/4, pc = 3|d|/4 (strictly picks b)
    //   4: a = c - d    -> pa = |d|, pb = |d|, pc = 0      (strictly picks c)
    for (const bpp of [3, 4]) {
        for (const w of widths) {
            const rowBytes = w * bpp, stride = rowBytes + 1, rows = 7;
            const prev0 = new Uint8Array(rowBytes);
            const raw = new Uint8Array(rows * rowBytes);
            for (let i = 0; i < rowBytes; i++) prev0[i] = (i * 29 + w * 7 + bpp) & 255;
            // Rows 0..3 use filter types 0..3; rows 4..6 use filter 4 (Paeth):
            //   row 3 (Average): alternates 100+k and 116+k (d = +-16)
            //   row 4 (Paeth, first tie):  a = c - 2*d -> 68+k and 148+k (pa = 16, pb = 32, pc = 16; picks a over c)
            //   row 5 (Paeth, second tie): a = c - d/2 -> 28+k and 188+k (pa = 80, pb = 40, pc = 40; picks b over c)
            //   row 6 (Paeth, mixed):      a in {c - d/2, c - d/4, c - d, c} (second tie, strict b, strict c, strict a)
            for (let y = 0; y < rows; y++) {
                const upRow = y === 0 ? prev0 : raw.subarray((y - 1) * rowBytes, y * rowBytes);
                const curRow = raw.subarray(y * rowBytes, (y + 1) * rowBytes);
                if (y === 3) {
                    for (let x = 0; x < w; x++) {
                        for (let k = 0; k < bpp; k++) {
                            curRow[x * bpp + k] = ((x & 1) ? 116 : 100) + k * 3 + (x === 0 ? (w & 1) : 0);
                        }
                    }
                } else if (y >= 4) {
                    for (let x = 1; x < w; x++) {
                        for (let k = 0; k < bpp; k++) {
                            const idx = x * bpp + k;
                            const cVal = upRow[idx - bpp], bVal = upRow[idx], d = bVal - cVal;
                            const mode = y === 4 ? 0 : y === 5 ? 1 : (x + k + w) & 3;
                            curRow[idx - bpp] = mode === 0 ? cVal - 2 * d : mode === 1 ? cVal - (d >> 1) : mode === 2 ? cVal - (d >> 2) : mode === 3 ? cVal - d : cVal;
                        }
                    }
                    for (let k = 0; k < bpp; k++) {
                        curRow[(w - 1) * bpp + k] = (211 + w * 19 + y * 31 + k * 53) & 255;
                    }
                } else {
                    for (let i = 0; i < rowBytes; i++) curRow[i] = (rnd() + i * 17 + y * 59) & 255;
                }
            }
            // Encode `raw` into filtered `lines` using the exact PNG filter definitions (0..4, then 4 on rows 5 and 6)
            const lines = new Uint8Array(rows * stride);
            for (let y = 0; y < rows; y++) {
                const ft = y < 5 ? y : 4;
                lines[y * stride] = ft;
                const upRow = y === 0 ? prev0 : raw.subarray((y - 1) * rowBytes, y * rowBytes);
                const curRow = raw.subarray(y * rowBytes, (y + 1) * rowBytes);
                for (let i = 0; i < rowBytes; i++) {
                    const a = i >= bpp ? curRow[i - bpp] : 0;
                    const b = upRow[i];
                    const c = i >= bpp ? upRow[i - bpp] : 0;
                    if (ft === 4 && w <= 67) {
                        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
                        if (pa === pc && pa < pb && a !== c) acTies++;
                        if (pb === pc && pa > pb && b !== c) bcTies++;
                    }
                    const pred = ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : paeth(a, b, c);
                    lines[y * stride + 1 + i] = (curRow[i] - pred) & 255;
                }
            }
            for (const channels of [0, bpp]) {
                for (const odd of [0, 1]) {
                    const run = (k) => {
                        const lBuf = new Uint8Array(lines.length + odd); lBuf.set(lines, odd);
                        const lView = lBuf.subarray(odd, odd + lines.length);
                        const pBuf = new Uint8Array(rowBytes + odd); pBuf.set(prev0, odd);
                        const pView = pBuf.subarray(odd, odd + rowBytes);
                        const oBuf = channels ? new Uint8ClampedArray(rows * w * 4 + odd) : null;
                        const oView = channels ? oBuf.subarray(odd, odd + rows * w * 4) : null;
                        const done = k.pngUnfilterRows(lView, rows, rowBytes, bpp, pView, channels ? { w, channels, out: oView } : null);
                        return { done, out: channels ? oView : lView, prev: pView };
                    };
                    const got = run(px), want = run(js);
                    if (got.done !== rows || want.done !== rows || !eqBytes(got.out, want.out) || !eqBytes(got.prev, want.prev)) {
                        if (tieOk) {
                            tieOk = false;
                            tieDetail = `w=${w}, bpp=${bpp}, channels=${channels}, odd=${odd}: done ${got.done}/${want.done}, ${firstDiff(got.out, want.out)}`;
                        }
                    }
                    if (!channels && odd === 0 && tieOk) {
                        for (let y = 0; y < rows; y++) {
                            const uRow = got.out.subarray(y * stride + 1, (y + 1) * stride);
                            const rRow = raw.subarray(y * rowBytes, (y + 1) * rowBytes);
                            if (!eqBytes(uRow, rRow)) {
                                tieOk = false;
                                tieDetail = `w=${w}, bpp=${bpp}, row ${y} did not reconstruct raw: ${firstDiff(uRow, rRow)}`;
                                break;
                            }
                        }
                    }
                }
            }
        }
    }
    check(`${label} png_unfilter_rows on rows of 1..67 px (and 128..257 px) with forced Paeth ties (ac=${acTies}, bc=${bcTies}) equals its twin and reconstructs raw at even and odd offsets`,
        tieOk && acTies > 500 && bcTies > 500, tieDetail || `ac=${acTies}, bc=${bcTies}`);
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
        rules: [NAN_BITS],
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
            !twinDiff(gotMc, wantMc, [NAN_BITS], {}) && !twinDiff(gotOm, wantOm, [], {}));
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
        rules: [NAN_BITS],
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
            const diff = twinDiff(rustOut, jsOut, [NAN_BITS], {}) || twinDiff({ es0: rustOut.es0, es1: rustOut.es1, wr: rustOut.wr, wc: rustOut.wc }, subJsOut, [], {});
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
        const fDabWantBox = fDabWantField.dab("grow", 16, 16, 10, 0.4, 0.75, null, null, pField.cells, null);
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
            const dabBoxGot = fDab.dab("grow", 16, 16, 10, 0.4, 0.75, null, null, pField.cells, K.liquifyDab);
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
        // K31 (PLAN_WASM_BUILD.md §4.9): swirlcw and swirlccw route through liquifyDabNodes (0 liquify_dab calls)
        // because wasm libm cos/sin differ from V8 Math.cos/Math.sin by 1 ULP on the swirl domain
        {
            K.pxCalls(true);
            const fSwCw = pField.copy(), fSwCwWant = pField.copy();
            fSwCw.dab("swirlcw", 16, 16, 10, 0.4, 0.75, null, null, pField.cells, K.liquifyDab);
            fSwCwWant.dab("swirlcw", 16, 16, 10, 0.4, 0.75, null, null, pField.cells, null);
            const fSwTie = new L.LiquifyField(2000, 2000, 1), fSwTieWant = new L.LiquifyField(2000, 2000, 1);
            fSwTie.dab("swirlccw", 1198.6129226787184, 1000, 700, 0.8, 0.6, null, null, null, K.liquifyDab);
            fSwTieWant.dab("swirlccw", 1198.6129226787184, 1000, 700, 0.8, 0.6, null, null, null, null);
            const cSw = K.pxCalls(true);
            const swCwSame = eqBytes(fSwCw.nodes(0, 0, fSwCw.ni + 1, fSwCw.nj + 1), fSwCwWant.nodes(0, 0, fSwCwWant.ni + 1, fSwCwWant.nj + 1));
            const swTieDy = fSwTie.node(1500, 1000)[1], swTieWantDy = process.versions.electron ? 2423 : fSwTieWant.node(1500, 1000)[1];
            check("kernels.js K31: swirlcw and swirlccw route to liquifyDabNodes (0 liquify_dab calls) and match the V8 sin/cos tie at node (1500, 1000)",
                !cSw.liquify_dab && swCwSame && swTieDy === swTieWantDy,
                `calls=${JSON.stringify(cSw)} swCwSame=${swCwSame} swTieDy=${swTieDy} want=${swTieWantDy}`);
        }
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
        const rtdMap = new Uint16Array(16 * 16);
        for (let i = 0; i < rtdMap.length; i++) rtdMap[i] = (i * 257) & 0xffff;
        const rtdGuide = { data: new Uint8Array(16 * 16 * 4).fill(128), w: 16, h: 16 };
        const rtdPic = { data: new Uint8Array(256 * 256 * 4).fill(140), x0: 0, y0: 0, w: 256, h: 256 };
        const rtdXf = [16 / 512, 0, 0, 16 / 256, 0, 0];
        const rtdLim = { lo: 0.2, hi: 0.8, fLo: 0.05, fHi: 0.05, invert: false };
        const rtdCls = new Uint8Array([2, 2]);
        const rtdSnap = [0.05, 0.02];
        want.rtd = js.rangeTilesDepth(rtdMap, 16, 16, rtdXf, 512, 256, 0, 0, 256, rtdLim, false, rtdSnap, rtdGuide, rtdPic, rtdCls, 256);
        const rtrLumaLim = { source: "luma", lo: 0.2, hi: 0.8, fLo: 0.05, fHi: 0.05, invert: false };
        const rtrColorLim = { source: "color", color: "#5080a0", tol: 30, invert: false };
        want.rtrLuma = js.rangeTilesRgba(I, w, h, 0, 0, h, rtrLumaLim, false, 256);
        want.rtrColor = js.rangeTilesRgba(I, w, h, 0, 0, h, rtrColorLim, false, 256);
        const larW = 16, larH = 300;
        const larInit = new Uint8Array(larW * larH * 4);
        for (let i = 0; i < larInit.length; i += 4) {
            larInit[i] = 48; larInit[i + 1] = 128; larInit[i + 2] = 192; larInit[i + 3] = 200;
        }
        const larXf = [16 / larW, 0, 0, 16 / larH, 0, 0];
        want.lar = js.limitAlphaRows(larInit.slice(), rtdMap, 16, 16, larXf, 0, 0, larW, larH, rtdLim, rtdSnap, rtdGuide, null);
        const gfRaw = new Float32Array(16 * 12);
        for (let i = 0; i < gfRaw.length; i++) gfRaw[i] = Math.sin(i * 0.25) * 10;
        const gfGrey = new Uint8Array(32 * 24);
        for (let i = 0; i < gfGrey.length; i++) gfGrey[i] = (i * 37) & 255;
        want.gf = js.guidedFar(gfRaw, 16, 12, gfGrey, 32, 24, 2, 1e-3, -10, 10);
        K.setRoute("edgefit", "rust");
        K.setRoute("edgefitShrink", "rust");
        K.setRoute("warpRgba", "rust");
        K.setRoute("warpCoverage", "rust");
        K.setRoute("rangeDepth", "rust");
        K.setRoute("rangeDepthSnap", "rust");
        K.setRoute("rangeLuma", "rust");
        K.setRoute("rangeColor", "rust");
        K.setRoute("limitAlphaRows", "rust");
        K.setRoute("guidedFar", "rust");
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
                const b = f.dab("grow", 16, 16, 10, 0.4, 0.75, null, null, pField.cells, K.liquifyDab);
                return { f, b };
            }, (o) => JSON.stringify(o.b) === JSON.stringify(fDabWantBox) && eqBytes(o.f.nodes(0, 0, o.f.ni + 1, o.f.nj + 1), fDabWantNodes)],
            ["edgefitShrink", "edgefitShrink", () => K.edgefitShrink(I, w, h, 32, 20), (o) => eqFloats(o.gray, want.es.gray) && eqFloats(o.alpha, want.es.alpha)],
            ["warpRgba", "warpRgba", () => K.warpRgba(I, w, h, warpM), (o) => eqBytes(o, want.wr)],
            ["warpCoverage", "warpCoverage", () => K.warpCoverage(w, h, warpM), (o) => eqFloats(o, want.wc)],
            ["rangeTilesDepth", "rangeTilesDepth", () => K.rangeTilesDepth(rtdMap, 16, 16, rtdXf, 512, 256, 0, 0, 256, rtdLim, false, rtdSnap, rtdGuide, rtdPic, rtdCls, 256), (o) => !twinDiff(o, want.rtd)],
            ["rangeTilesDepthSplit", "rangeTilesDepth", () => {
                K.setRoute("rangeDepth", "rust");
                K.setRoute("rangeDepthSnap", "js");
                try {
                    return K.rangeTilesDepth(rtdMap, 16, 16, rtdXf, 512, 256, 0, 0, 256, rtdLim, false, rtdSnap, rtdGuide, rtdPic, rtdCls, 256);
                } finally {
                    K.setRoute("rangeDepthSnap", "rust");
                }
            }, (o) => !twinDiff(o, want.rtd)],
            ["rangeTilesRgbaLuma", "rangeTilesRgba", () => K.rangeTilesRgba(I, w, h, 0, 0, h, rtrLumaLim, false, 256), (o) => !twinDiff(o, want.rtrLuma)],
            ["rangeTilesRgbaColor", "rangeTilesRgba", () => K.rangeTilesRgba(I, w, h, 0, 0, h, rtrColorLim, false, 256), (o) => !twinDiff(o, want.rtrColor)],
            ["limitAlphaRows", "limitAlphaRows", () => K.limitAlphaRows(larInit.slice(), rtdMap, 16, 16, larXf, 0, 0, larW, larH, rtdLim, rtdSnap, rtdGuide, null), (o) => eqBytes(o, want.lar)],
            ["guidedFar", "guidedFar", () => K.guidedFar(gfRaw, 16, 12, gfGrey, 32, 24, 2, 1e-3, -10, 10), (o) => !twinDiff(o, want.gf)],
        ]) {
            const p = K.rustPx(), i0 = K.pxInstances();
            // the split traps after its kernel wrote L in wasm memory, before the copy out (the caller's L untouched)
            p[method] = method === "freqSplit"
                ? function (src, low) { const n = src.length, a = this.job; const ps = this._in(a, src, n), pl = this._in(a, low, n), ph = a.take(n); this.exports.freq_split(ps, pl, ph, n); return trapIn2(this); }
                : function () { return trapIn2(this); };
            const got = callIt(), after = K.rustPx(), i1 = K.pxInstances();
            if (!(check1(got) && p.trapped instanceof WebAssembly.RuntimeError && after !== p && i1.trap === i0.trap + 1)) { ok = false; detail = `${name}: ${JSON.stringify(i1)}`; }
        }
        {
            const p = K.rustPx(), i0 = K.pxInstances();
            p.rangeTilesDepth = function () { return this.alloc(0xffff0000); };
            const got = K.rangeTilesDepth(rtdMap, 16, 16, rtdXf, 512, 256, 0, 0, 256, rtdLim, false, rtdSnap, rtdGuide, rtdPic, rtdCls, 256);
            const after = K.rustPx(), i1 = K.pxInstances();
            if (!(!twinDiff(got, want.rtd) && after !== p && i1.oom === i0.oom + 1)) {
                ok = false;
                detail = `rangeTilesDepthOom: ${JSON.stringify(i1)}`;
            }
        }
        {
            const p = K.rustPx(), i0 = K.pxInstances();
            p.rangeTilesRgba = function () { return this.alloc(0xffff0000); };
            const got = K.rangeTilesRgba(I, w, h, 0, 0, h, rtrLumaLim, false, 256);
            const after = K.rustPx(), i1 = K.pxInstances();
            if (!(!twinDiff(got, want.rtrLuma) && after !== p && i1.oom === i0.oom + 1)) {
                ok = false;
                detail = `rangeTilesRgbaOom: ${JSON.stringify(i1)}`;
            }
        }
        {
            // Multi-chunk OOM recovery on limitAlphaRows: chunk 0 (rows 0..256) succeeds on Rust, chunk 1 (rows 256..300)
            // throws PxOutOfMemory inside the real p.limitAlphaRows (which sets err.doneRows = 256); K.limitAlphaRows
            // finishes only rows 256..300 on the twin without double-multiplying rows 0..256.
            const p = K.rustPx(), i0 = K.pxInstances();
            const larBuf = larInit.slice();
            const origIn = p._in;
            let rgbaChunkCopies = 0;
            p._in = function (arena, src, bytes) {
                if (src && src.buffer === larBuf.buffer) {
                    rgbaChunkCopies++;
                    if (rgbaChunkCopies === 2) return this.alloc(0xffff0000);
                }
                return origIn.call(this, arena, src, bytes);
            };
            const got = K.limitAlphaRows(larBuf, rtdMap, 16, 16, larXf, 0, 0, larW, larH, rtdLim, rtdSnap, rtdGuide, null);
            const after = K.rustPx(), i1 = K.pxInstances();
            if (!(eqBytes(got, want.lar) && rgbaChunkCopies === 2 && after !== p && i1.oom === i0.oom + 1)) {
                ok = false;
                detail = `limitAlphaRowsOom: copies=${rgbaChunkCopies} ${firstDiff(got, want.lar)} ${JSON.stringify(i1)}`;
            }
        }
        {
            const p = K.rustPx(), i0 = K.pxInstances();
            p.guidedFar = function () { return this.alloc(0xffff0000); };
            const got = K.guidedFar(gfRaw, 16, 12, gfGrey, 32, 24, 2, 1e-3, -10, 10);
            const after = K.rustPx(), i1 = K.pxInstances();
            if (!(!twinDiff(got, want.gf) && after !== p && i1.oom === i0.oom + 1)) {
                ok = false;
                detail = `guidedFarOom: ${JSON.stringify(i1)}`;
            }
        }
        check("kernels.js K27 / K28 / K29 / K31 / K34 / K22 / K23 / K25 / K24 wrappers after a trap: the twin's bytes (a split's L as it was before the trap), the instance replaced (trap +1 / oom +1)", ok, detail);
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
    check("the K27 / K28 / K29 / K31 / K34 / K22 / K23 / K25 / K24 wrappers' traps warned once per kernel", warned.filter((w) => /tone_rgba|sponge_rgba|freq_split|freq_separate|liquify_block|liquify_preview|liquify_dab|edgefit_shrink|warp_rgba|warp_coverage|range_tiles_depth|range_tiles_rgba|limit_alpha_rows|guided_far/.test(w)).length === 18, warned.join(" | "));
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
/** What a flood job's `use` makes of the shape: a copy (the view is valid only inside the call), the count, the bounds, the cells. */
const shapeOf = (view, n, bounds, cells) => ({ bytes: new Uint8Array(view), n, bounds, cells: cells ? new Uint8Array(cells) : null });
const sameShape = (a, b) => !!a && !!b && eqBytes(a.bytes, b.bytes) && a.n === b.n && JSON.stringify(a.bounds) === JSON.stringify(b.bounds)
    && (!a.cells && !b.cells || !!a.cells && !!b.cells && eqBytes(a.cells, b.cells));
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
            title: "flood_shape equals its twin floodShape byte for byte, with the count, the bounds and the cells (no selection, partial alpha, all transparent; tol 0 / 32 / 255; contiguous or not; corner seeds)",
            call: (k, [d, w, h, sx, sy, tol, contiguous, sel]) => k.floodShape(d, w, h, sx, sy, tol, contiguous, sel, 0x123456, shapeOf),
        });
        twinCheck({
            name: "flood_shape (outKind = 1)", builds: [["rust simd", simd], ["rust scalar", scalar]], twin: js, cases,
            title: "flood_shape at outKind = 1 equals its twin floodShape byte for byte (w * h alpha bytes), with the count, the bounds and the cells",
            call: (k, [d, w, h, sx, sy, tol, contiguous, sel]) => k.floodShape(d, w, h, sx, sy, tol, contiguous, sel, 0x123456, shapeOf, 1),
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
            for (const outKind of [4, 1]) {
                const want = js.floodShape(d, w, h, sx, sy, tol, contiguous, sel, 0x123456, shapeOf, outKind);
                for (const [rt, rust] of [["rust", 1], ["js", 0], [w * h, 1], [w * h + 1, 0]]) {
                    K.setRoute("flood", rt);
                    K.pxCalls(true);
                    let uses = 0;
                    const got = K.floodShape(d, w, h, sx, sy, tol, contiguous, sel, 0x123456, (v, cnt, bounds, cells) => { uses++; return shapeOf(v, cnt, bounds, cells); }, outKind);
                    const ran = K.pxCalls().flood_shape || 0;
                    n++;
                    if (!sameShape(got, want) || got.bytes.length !== (outKind === 1 ? w * h : w * h * 4) || uses !== 1 || ran !== rust) {
                        ok = false; detail = `${c.tag} outKind ${outKind} route ${rt}: ${ran ? "rust" : "the twin"} ran, use called ${uses}x${sameShape(got, want) ? "" : ", another shape"}`;
                    }
                }
            }
        }
        K.setRoute("flood", null);
        check(`kernels.js floodShape under the flood route (outKind 4 and 1): "rust" and a size at or below the picture's run Rust, "js" and a size above it the twin; the same shape and cells, use called once (${n} runs)`, ok, detail);
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
        const ref = sel.slice(), refCells = new Uint8Array(((fw + 255) >> 8) * ((fh + 255) >> 8));
        raster.growMask(ref, fw, fh, 3, { cells: refCells });
        const refBounds = raster.maskBounds(ref, fw, fh);
        p = K.rustPx(); i0 = K.pxInstances();
        p.growMask = function () { return trapIn(this); };   // traps before it writes the selection, as Px.growMask would
        const grown = sel.slice(), grownCells = new Uint8Array(refCells.length), gb = raster.growMaskBounds(grown, fw, fh, 3, { cells: grownCells });
        check("inpaint_raster.js after a trap: floodMask gives floodScan's mask, growMaskBounds the JS growMask's selection, bounds and cells (the selection grown once); each replaces the instance",
            floodOk && eqBytes(grown, ref) && eqBytes(grownCells, refCells) && JSON.stringify(gb) === JSON.stringify(refBounds) && K.rustPx() !== p && K.pxInstances().trap === i0.trap + 1,
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
        const wantShape = js.floodShape(...fargs, shapeOf), wantAlphaShape = js.floodShape(...fargs, shapeOf, 1);
        let uses = 0;
        const counted = (v, cnt, bounds, cells) => { uses++; return shapeOf(v, cnt, bounds, cells); };
        p = K.rustPx(); i0 = K.pxInstances();
        p.floodShape = function () { return trapIn(this); };
        const viaTwin = K.floodShape(...fargs, counted);
        const before4 = sameShape(viaTwin, wantShape) && uses === 1 && K.rustPx() !== p && K.pxInstances().trap === i0.trap + 1;
        p = K.rustPx(); i0 = K.pxInstances(); uses = 0;
        p.floodShape = function () { return trapIn(this); };
        const viaTwin1 = K.floodShape(...fargs, counted, 1);
        const before = before4 && sameShape(viaTwin1, wantAlphaShape) && uses === 1 && K.rustPx() !== p && K.pxInstances().trap === i0.trap + 1;
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
    const selection = (w, h, seed, empty = false, fullBlock = false) => {
        const f = (empty || fullBlock) ? new Uint8Array(w * h) : blobs(w, h, seed, 4), d = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) { d[i * 4] = 255; d[i * 4 + 3] = f[i] ? (seed & 1 ? 255 : 200) : (i % 7 ? 0 : 90); }
        if (fullBlock) {
            const bw = Math.min(w, 300), bh = Math.min(h, 300), a = seed & 1 ? 255 : 200;
            for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
                const o = (y * w + x) * 4;
                d[o] = 255; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = a;
            }
        }
        return d;
    };
    const seenCellKinds = new Set();
    for (const [w, h, seed, n, empty, fullBlock] of [
        [1, 1, 1, 3, false, false], [64, 64, 2, 5, false, false], [300, 200, 3, -4, false, false],
        [257, 129, 4, 16, false, false], [120, 90, 5, -40, false, false], [80, 60, 6, 2, true, false],
        [400, 300, 7, 1, false, false], [600, 520, 9, 8, false, true], [600, 520, 11, -8, false, true],
        [600, 520, 8, 8, false, true],
    ]) {
        const src = selection(w, h, seed, empty, fullBlock);
        const cols = (w + 255) >> 8, rows = (h + 255) >> 8;
        const a = src.slice(), ca = new Uint8Array(cols * rows);
        raster.growMask(a, w, h, n, { cells: ca });
        const ab = raster.maskBounds(a, w, h);
        const a2 = src.slice();
        raster.growMask(a2, w, h, n);
        const b = src.slice(), cb = new Uint8Array(cols * rows), bb = px.growMask(b, w, h, n, cb);
        const c = src.slice(), cb2 = px.growMask(c, w, h, n);
        const wantCells = new Uint8Array(cols * rows);
        for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
            const x0 = tx * 256, y0 = ty * 256, x1 = Math.min(x0 + 256, w), y1 = Math.min(y0 + 256, h);
            let count = 0, changed = false;
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
                const o = (y * w + x) * 4;
                if (b[o + 3] > 0) count++;
                if (b[o] !== src[o] || b[o + 1] !== src[o + 1] || b[o + 2] !== src[o + 2] || b[o + 3] !== src[o + 3]) changed = true;
            }
            const kind = count === 0 ? 0 : changed ? 1 : 2;
            wantCells[ty * cols + tx] = kind;
            seenCellKinds.add(kind);
        }
        if (!eqBytes(a, b) || !eqBytes(a2, b) || !eqBytes(c, b) || JSON.stringify(ab) !== JSON.stringify(bb) || JSON.stringify(cb2) !== JSON.stringify(bb) || !eqBytes(ca, cb) || !eqBytes(cb, wantCells)) {
            ok = false; detail = `${w}x${h} n ${n} ${firstDiff(a, b) || firstDiff(a2, b) || firstDiff(c, b) || firstDiff(ca, cb) || firstDiff(cb, wantCells) || `bounds ${ab} vs ${bb} vs ${cb2}`}`;
        }
    }
    if (!seenCellKinds.has(0) || !seenCellKinds.has(1) || !seenCellKinds.has(2)) {
        ok = false; detail = detail || `missing cell kinds: saw ${[...seenCellKinds].join(",")}`;
    }
    check(`${label} grow_mask equals growMask + maskBounds + cells (0 empty, 1 changed, 2 unchanged; grow, shrink, empty, partial alpha)`, ok, detail);

    ok = true; detail = "";
    for (const [w, h, seed] of [[1, 1, 1], [97, 61, 2], [256, 256, 3], [640, 480, 5]]) {
        const data = regions(w, h, seed), r = rng(seed + 9);
        const cols = (w + 255) >> 8, rows = (h + 255) >> 8;
        for (let k = 0; k < 6; k++) {
            const sx = r() * w | 0, sy = r() * h | 0, tol = [0, 8, 32, 80, 255, 12][k], contiguous = k % 2 === 0;
            const sel = k % 3 ? selection(w, h, seed + k) : null;
            const mask = raster.floodMask(data, w, h, sx, sy, tol, contiguous);
            if (sel) for (let p = 0; p < w * h; p++) if (sel[p * 4 + 3] < 128) mask[p] = 0;
            const want = new Uint8Array(w * h * 4), wantAlpha = new Uint8Array(w * h), wantCells = new Uint8Array(cols * rows);
            let count = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
            for (let p = 0; p < w * h; p++) {
                if (!mask[p]) continue;
                want.set([18, 52, 86, 255], p * 4);
                wantAlpha[p] = 255;
                count++;
                const x = p % w, y = (p / w) | 0;
                wantCells[(y >> 8) * cols + (x >> 8)] = 1;
                x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = y;
            }
            const wantBounds = x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
            const got4 = px.floodShape(data, w, h, sx, sy, tol, contiguous, sel, 0x123456, shapeOf);
            const got1 = px.floodShape(data, w, h, sx, sy, tol, contiguous, sel, 0x123456, shapeOf, 1);
            if (!eqBytes(got4.bytes, want) || got4.n !== count || JSON.stringify(got4.bounds) !== JSON.stringify(wantBounds) || !eqBytes(got4.cells, wantCells)
                || !eqBytes(got1.bytes, wantAlpha) || got1.n !== count || JSON.stringify(got1.bounds) !== JSON.stringify(wantBounds) || !eqBytes(got1.cells, wantCells)) {
                ok = false; detail = `${w}x${h} seed ${sx},${sy} tol ${tol} ${contiguous} sel ${!!sel} ${firstDiff(got4.bytes, want) || firstDiff(got1.bytes, wantAlpha) || firstDiff(got4.cells, wantCells) || firstDiff(got1.cells, wantCells) || `count ${got4.n}/${got1.n} vs ${count}, bounds ${got4.bounds}/${got1.bounds} vs ${wantBounds}`}`;
            }
        }
    }
    check(`${label} flood_shape (out_kind 4 and 1) equals floodMask, the selection clip, the count, the bounds, the cells and the shape`, ok, detail);
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

    // ---- K36: composite_masked_tile (docs/PLAN_WASM_BUILD.md §4.5) ----
    const refMaskedTile = (dst, src, op, alpha, mask, px) => {
        const scratch = dst ? new Uint8Array(dst.subarray(0, px * 4)) : new Uint8Array(px * 4);
        reference.compositeTile(scratch, [src.subarray(0, px * 4)], [op], [alpha], mask ? [mask.subarray(0, px)] : null);
        let changed = false, nonEmpty = false;
        for (let p = 0; p < px; p++) {
            const i = p * 4;
            if (src[i + 3] === 0 || (mask && mask[p] === 0)) {
                if (dst) {
                    scratch[i] = dst[i]; scratch[i + 1] = dst[i + 1]; scratch[i + 2] = dst[i + 2]; scratch[i + 3] = dst[i + 3];
                } else {
                    scratch[i] = 0; scratch[i + 1] = 0; scratch[i + 2] = 0; scratch[i + 3] = 0;
                }
            }
            if (dst) {
                if (scratch[i] !== dst[i] || scratch[i + 1] !== dst[i + 1] || scratch[i + 2] !== dst[i + 2] || scratch[i + 3] !== dst[i + 3]) changed = true;
            } else if (scratch[i] || scratch[i + 1] || scratch[i + 2] || scratch[i + 3]) {
                changed = true;
            }
            if (scratch[i + 3] > 0) nonEmpty = true;
        }
        if (!changed) return { r: 0, bytes: null };
        if (!nonEmpty) return { r: 2, bytes: null };
        return { r: 1, bytes: scratch };
    };

    const callMasked = (k, [dst, src, op, alpha, mask, px]) => {
        if (k === refMaskedObj) return refMaskedTile(dst, src, op, alpha, mask, px);
        const out = new Uint8Array(px * 4);
        out.fill(0xa5);
        let writes = 0, wholeArg = null;
        const r = k.compositeMaskedTile(dst, src, op, alpha, mask, px, (whole) => {
            writes++;
            wholeArg = whole;
            return out;
        });
        if (writes !== (r === 1 ? 1 : 0) || (r === 1 && wholeArg !== true)) {
            throw new Error(`write(${wholeArg}) called ${writes} times for return code ${r}`);
        }
        if (r !== 1 && out[0] !== 0xa5) {
            throw new Error(`out buffer modified when return code was ${r}`);
        }
        return { r, bytes: r === 1 ? out : null };
    };
    const refMaskedObj = { compositeMaskedTile: refMaskedTile };

    const maskedCases = [];
    // 1. All ops 0..=30 with mixed backdrop (including low-alpha pixels that drift if premultiplied+unpremultiplied when s.a==0 or m==0)
    const makeDriftDst = (px, seed) => {
        const d = pixelRow(px, seed, { opaque: false });
        // Force some low-alpha pixels with high RGB (e.g. [200, 100, 50, 1]) and zero-alpha pixels with non-zero RGB
        for (let p = 0; p < px; p += 7) {
            const i = p * 4;
            d[i] = 213; d[i + 1] = 117; d[i + 2] = 63; d[i + 3] = 2;
        }
        for (let p = 3; p < px; p += 13) {
            const i = p * 4;
            d[i] = 99; d[i + 1] = 44; d[i + 2] = 11; d[i + 3] = 0;
        }
        return d;
    };
    for (let op = 0; op <= 30; op++) {
        const px = op % 5 === 0 ? 1031 : op % 3 === 0 ? 259 : 64;
        const dst = makeDriftDst(px, 400 + op);
        const src = pixelRow(px, 500 + op, { opaque: false });
        const mask = randomMask(px, 600 + op);
        const alpha = [255, 180, 1, 127, 0][op % 5];
        maskedCases.push({ tag: `op ${op} dst+mask px=${px} a=${alpha}`, args: [dst, src, op, alpha, mask, px] });
        maskedCases.push({ tag: `op ${op} dst no-mask px=${px} a=${alpha}`, args: [dst, src, op, alpha === 0 ? 200 : alpha, null, px] });
        maskedCases.push({ tag: `op ${op} null-dst+mask px=${px}`, args: [null, src, op, 200, mask, px] });
    }
    // 2. Full 256x256 tile (65536 px) with sparse active chunks and inactive chunks
    {
        const px = 65536;
        const dst = makeDriftDst(px, 777);
        const srcSparse = new Uint8Array(px * 4);
        // Only chunk 3 (pixels 768..1024) at pixel 777 and chunk 200 at pixel 51205 have alpha > 0
        srcSparse[777 * 4] = 250; srcSparse[777 * 4 + 1] = 120; srcSparse[777 * 4 + 2] = 30; srcSparse[777 * 4 + 3] = 200;
        srcSparse[51205 * 4] = 40; srcSparse[51205 * 4 + 1] = 220; srcSparse[51205 * 4 + 2] = 180; srcSparse[51205 * 4 + 3] = 255;
        const maskSparse = new Uint8Array(px).fill(255);
        maskSparse[51205] = 0; // masks out pixel 51205 so chunk 200 becomes completely inactive!
        maskedCases.push({ tag: "65536px sparse active chunk with dst", args: [dst, srcSparse, 0, 255, maskSparse, px] });
        maskedCases.push({ tag: "65536px sparse active chunk null dst", args: [null, srcSparse, 0, 255, maskSparse, px] });
        // Completely inactive 65536px tile (masked out) -> r = 0 (UNCHANGED)
        const maskZero = new Uint8Array(px);
        maskedCases.push({ tag: "65536px all masked out -> UNCHANGED (0)", args: [dst, srcSparse, 0, 255, maskZero, px] });
    }
    // 3. Single-pixel and SIMD+tail pair active positions across 4-pixel SIMD lane boundaries and 256-pixel chunk boundaries
    for (const px of [1, 2, 3, 4, 5, 7, 19, 255, 256, 257, 263, 513]) {
        const dst = makeDriftDst(px, 800 + px);
        for (const pos of [0, 1, 2, 3, 4, Math.min(px - 1, 255), Math.min(px - 1, 256), px - 1]) {
            if (pos >= px) continue;
            const src = new Uint8Array(px * 4);
            src[pos * 4] = 180; src[pos * 4 + 1] = 90; src[pos * 4 + 2] = 240; src[pos * 4 + 3] = 220;
            maskedCases.push({ tag: `single active pos=${pos}/${px}`, args: [dst, src, 0, 255, null, px] });
        }
        if (px >= 5 && px % 4 !== 0) {
            const srcPair = new Uint8Array(px * 4);
            const firstPos = (px >> 8) * 256;
            srcPair[firstPos * 4] = 210; srcPair[firstPos * 4 + 1] = 80; srcPair[firstPos * 4 + 2] = 40; srcPair[firstPos * 4 + 3] = 230;
            srcPair[(px - 1) * 4] = 50; srcPair[(px - 1) * 4 + 1] = 190; srcPair[(px - 1) * 4 + 2] = 240; srcPair[(px - 1) * 4 + 3] = 200;
            maskedCases.push({ tag: `SIMD+tail pair active ${firstPos}+${px - 1}/${px}`, args: [dst, srcPair, 0, 255, null, px] });
        }
    }
    // 4. Explicit outcome 0 (UNCHANGED) and outcome 2 (EMPTY) cases
    {
        const px = 260;
        const dstSpot = new Uint8Array(px * 4);
        // Only pixels 10 and 258 are non-transparent in dstSpot
        dstSpot[10 * 4] = 255; dstSpot[10 * 4 + 3] = 200;
        dstSpot[258 * 4 + 1] = 255; dstSpot[258 * 4 + 3] = 128;
        const srcEraseSpot = new Uint8Array(px * 4);
        srcEraseSpot[10 * 4 + 3] = 255;
        srcEraseSpot[258 * 4 + 3] = 255;
        // Outcome 2 (EMPTY): destination-out erases the only two non-transparent pixels in dstSpot
        maskedCases.push({ tag: "destination-out erases sparse dst to EMPTY (2)", args: [dstSpot, srcEraseSpot, 1, 255, null, px] });
        // Outcome 2 (EMPTY): destination-in at alpha=0 erases dstSpot to EMPTY (2)
        maskedCases.push({ tag: "destination-in alpha=0 erases dst to EMPTY (2)", args: [dstSpot, srcEraseSpot, 3, 0, null, px] });
        // Outcome 2 (EMPTY): copy at alpha=0 erases dstSpot to EMPTY (2)
        maskedCases.push({ tag: "copy alpha=0 erases dst to EMPTY (2)", args: [dstSpot, srcEraseSpot, 4, 0, null, px] });
        // Outcome 2 (EMPTY): dst has only RGB garbage [50, 60, 70, 0] at pixel 10; source-atop over it zeroes the RGB garbage -> changed=true, non_empty=false -> EMPTY (2)
        const dstGarbage = new Uint8Array(px * 4);
        dstGarbage[10 * 4] = 50; dstGarbage[10 * 4 + 1] = 60; dstGarbage[10 * 4 + 2] = 70; dstGarbage[10 * 4 + 3] = 0;
        maskedCases.push({ tag: "source-atop over RGB garbage with alpha=0 zeroes RGB -> EMPTY (2)", args: [dstGarbage, srcEraseSpot, 2, 255, null, px] });
        // Outcome 0 (UNCHANGED): destination-out over already-transparent pixels
        const srcMiss = new Uint8Array(px * 4);
        srcMiss[5 * 4 + 3] = 255;
        maskedCases.push({ tag: "destination-out over transparent pixel -> UNCHANGED (0)", args: [dstSpot, srcMiss, 1, 255, null, px] });
        // Outcome 0 (UNCHANGED): painting identical opaque colour over opaque pixel
        const dstOpaque1 = new Uint8Array(px * 4);
        dstOpaque1[5 * 4] = 100; dstOpaque1[5 * 4 + 1] = 150; dstOpaque1[5 * 4 + 2] = 200; dstOpaque1[5 * 4 + 3] = 255;
        const srcSame = new Uint8Array(px * 4);
        srcSame[5 * 4] = 100; srcSame[5 * 4 + 1] = 150; srcSame[5 * 4 + 2] = 200; srcSame[5 * 4 + 3] = 255;
        maskedCases.push({ tag: "source-over identical opaque pixel -> UNCHANGED (0)", args: [dstOpaque1, srcSame, 0, 255, null, px] });
        // Outcome 1 (WRITTEN) when active span is erased to 0 but non-empty pixel remains in prefix, suffix, suffix tail, or inactive chunk
        const srcErase10 = new Uint8Array(px * 4);
        srcErase10[10 * 4 + 3] = 255;
        maskedCases.push({ tag: "erase active span in chunk 0 while chunk 1 (4-px) has alpha -> WRITTEN (1)", args: [dstSpot, srcErase10, 1, 255, null, px] });
        maskedCases.push({ tag: "erase active span in chunk 0 while chunk 1 (3-px tail) has alpha -> WRITTEN (1)", args: [dstSpot.subarray(0, 259 * 4), srcErase10.subarray(0, 259 * 4), 1, 255, null, 259] });
        const dstPrefix = new Uint8Array(px * 4);
        dstPrefix[1 * 4 + 3] = 90; dstPrefix[10 * 4 + 3] = 200;
        maskedCases.push({ tag: "erase active span while chunk prefix (< x0) has alpha -> WRITTEN (1)", args: [dstPrefix, srcErase10, 1, 255, null, px] });
        const dstSuffix = new Uint8Array(px * 4);
        dstSuffix[10 * 4 + 3] = 200; dstSuffix[20 * 4 + 3] = 90;
        maskedCases.push({ tag: "erase active span while chunk suffix (>= x1) has alpha -> WRITTEN (1)", args: [dstSuffix, srcErase10, 1, 255, null, px] });
        const dstSuffixTail = new Uint8Array(263 * 4), srcErase256 = new Uint8Array(263 * 4);
        dstSuffixTail[256 * 4 + 3] = 200; dstSuffixTail[262 * 4 + 3] = 75;
        srcErase256[256 * 4 + 3] = 255;
        maskedCases.push({ tag: "erase active span while chunk suffix scalar tail has alpha -> WRITTEN (1)", args: [dstSuffixTail, srcErase256, 1, 255, null, 263] });
    }

    const seenOutcomes = new Set();
    for (const c of maskedCases) seenOutcomes.add(refMaskedTile(...c.args).r);
    check("composite_masked_tile test cases cover outcomes 0 (UNCHANGED), 1 (WRITTEN), and 2 (EMPTY)",
        seenOutcomes.has(0) && seenOutcomes.has(1) && seenOutcomes.has(2), `saw ${[...seenOutcomes].join(",")}`);

    twinCheck({
        name: "composite_masked_tile (ref)",
        title: "compositeMaskedTile's twin equals compositeTile + inactive-pixel restore + empty check",
        builds: [["js", js]],
        twin: refMaskedObj,
        call: callMasked,
        cases: maskedCases,
        shift: false,
    });
    twinCheck({
        name: "composite_masked_tile",
        builds: [["rust simd", simd], ["rust scalar", scalar]],
        twin: js,
        call: callMasked,
        cases: maskedCases,
        shift: [0, 1, 4],
    });

    // Refusal checks on twin, simd, scalar, and raw export
    {
        const s16 = new Uint8Array(16 * 4), d16 = new Uint8Array(16 * 4), m16 = new Uint8Array(16);
        const refusals = [
            ["px = 0", [d16, s16, 0, 255, null, 0]],
            ["px < 0", [d16, s16, 0, 255, null, -4]],
            ["px > 4096*4096", [d16, s16, 0, 255, null, 4096 * 4096 + 1]],
            ["null src", [d16, null, 0, 255, null, 16]],
            ["short src view over longer buffer", [d16, new Uint8Array(new ArrayBuffer(128), 0, 16 * 4 - 4), 0, 255, null, 16]],
            ["short dst view over longer buffer", [new Uint8Array(new ArrayBuffer(128), 0, 16 * 4 - 4), s16, 0, 255, null, 16]],
            ["short mask view over longer buffer", [d16, s16, 0, 255, new Uint8Array(new ArrayBuffer(64), 0, 15), 16]],
        ];
        for (const [what, args] of refusals) {
            let threw = 0;
            for (const k of [js, simd, scalar]) {
                try { callMasked(k, args); } catch { threw++; }
            }
            check(`compositeMaskedTile refuses ${what} on twin and both builds`, threw === 3, `${threw}/3 threw`);
        }
        let noWriteThrew = 0;
        for (const k of [js, simd, scalar]) {
            try { k.compositeMaskedTile(d16, s16, 0, 255, null, 16, null); } catch { noWriteThrew++; }
        }
        check("compositeMaskedTile refuses missing write callback on twin and both builds", noWriteThrew === 3, `${noWriteThrew}/3 threw`);
        const rawRefused = [
            simd.exports.composite_masked_tile(0, 0, 0, 16, 0, 255, 0),
            simd.exports.composite_masked_tile(0, 1, 16, 16, 0, 255, 0),
            simd.exports.composite_masked_tile(16, 0, 16, 0, 0, 255, 0),
            simd.exports.composite_masked_tile(16, 0, 16, 4096 * 4096 + 1, 0, 255, 0),
            scalar.exports.composite_masked_tile(0, 0, 0, 16, 0, 255, 0),
        ];
        check("raw composite_masked_tile returns 3 (REFUSED) on invalid pointers or pixel counts",
            rawRefused.every((r) => r === 3), JSON.stringify(rawRefused));
    }

    // Route, trap recovery, and TileLayerPixels.compositeStroke checks
    {
        let K = null, TileLayerPixels = null;
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (u, ...rest) => {
            const s = String(u && u.href ? u.href : u);
            return s.startsWith("file:") ? new Response(fs.readFileSync(fileURLToPath(s))) : realFetch(u, ...rest);
        };
        try {
            K = await import(pathToFileURL(path.join(PX_DIR, "kernels.js")).href);
            await K.kernelsReady();
            ({ TileLayerPixels } = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_tiles.js")).href));
        } finally { globalThis.fetch = realFetch; }
        if (!Object.prototype.hasOwnProperty.call(K.ROUTE_KINDS, "compositeMaskedTile")) {
            check("kernels.js has the compositeMaskedTile route", false);
            return;
        }
        const prevMode = K.kernelsMode();
        K.setKernels("rust");
        try {
            const runRoute = (rt) => {
                K.setRoute("compositeMaskedTile", rt);
                K.pxCalls(true);
                const out = [];
                for (const c of maskedCases) {
                    const [dst, src, op, alpha, mask, px] = c.args;
                    const target = new Uint8Array(px * 4);
                    let writes = 0, wholeArg = null;
                    const r = K.compositeMaskedTile(dst, (whole) => { writes++; wholeArg = whole; return target; }, src, op, alpha, mask, px);
                    out.push({ r, writes, whole: wholeArg, bytes: r === 1 ? target : null });
                }
                return { out, calls: K.pxCalls(true).composite_masked_tile || 0 };
            };
            const viaJs = runRoute("js"), viaRust = runRoute("rust");
            let routeOk = viaJs.out.length === viaRust.out.length, routeDetail = "";
            for (let i = 0; routeOk && i < viaJs.out.length; i++) {
                const a = viaJs.out[i], b = viaRust.out[i];
                if (a.r !== b.r || a.writes !== (a.r === 1 ? 1 : 0) || b.writes !== (b.r === 1 ? 1 : 0)
                    || (a.r === 1 && (!a.whole || !b.whole || !eqBytes(a.bytes, b.bytes)))) {
                    routeOk = false;
                    routeDetail = `case ${i} (${maskedCases[i].tag}): js r=${a.r} w=${a.writes}, rust r=${b.r} w=${b.writes}`;
                }
            }
            check(`kernels.js compositeMaskedTile gives the same on routes js (0 calls) and rust (${viaRust.calls} calls), write(true) only when r === 1`,
                routeOk && viaJs.calls === 0 && viaRust.calls === maskedCases.length,
                routeDetail || `js=${viaJs.calls}, rust=${viaRust.calls}`);

            // Trap recovery on compositeMaskedTile
            K.setRoute("compositeMaskedTile", "rust");
            const warned = [], realWarn = console.warn;
            console.warn = (...a) => { warned.push(a.map(String).join(" ")); };
            try {
                const [dst, src, op, alpha, mask, px] = maskedCases[0].args;
                const want = refMaskedTile(dst, src, op, alpha, mask, px);
                const p = K.rustPx(), i0 = K.pxInstances();
                p.compositeMaskedTile = function () { return trapIn(this); };
                const target = new Uint8Array(px * 4);
                let writes = 0;
                const r = K.compositeMaskedTile(dst, () => { writes++; return target; }, src, op, alpha, mask, px);
                const i1 = K.pxInstances();
                check("kernels.js compositeMaskedTile recovers from a trap via the twin, calls write once, and replaces the instance",
                    r === want.r && writes === 1 && eqBytes(target, want.bytes) && K.rustPx() !== p && i1.trap === i0.trap + 1
                    && warned.some((w) => /composite_masked_tile.*trap/.test(w)),
                    `r=${r}, writes=${writes}, trap=${i1.trap - i0.trap}`);
            } finally { console.warn = realWarn; }

            // TileLayerPixels.compositeStroke across all 4 tile outcomes on both js and rust routes
            const packTiles = (tp) => {
                const out = new Uint8Array(4 * 256 * 256 * 4);
                for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) {
                    const t = tp.tileAt(tx, ty);
                    if (t) out.set(t.data, (ty * 2 + tx) * 256 * 256 * 4);
                }
                return out;
            };
            const buildAndStroke = (rt) => {
                K.setRoute("compositeMaskedTile", rt);
                const layer = new TileLayerPixels(512, 512);
                // Tile (0,0): existing pixels, will be painted over partially -> r = 1
                const t00 = layer.writable(0, 0);
                for (let i = 0; i < t00.data.length; i += 4) { t00.data[i] = 40; t00.data[i + 1] = 80; t00.data[i + 2] = 120; t00.data[i + 3] = 200; }
                // Tile (1,0): existing pixels, will be erased completely by destination-out -> r = 2 (dropped)
                const t10 = layer.writable(1, 0);
                t10.data[0] = 255; t10.data[3] = 180;
                // Tile (0,1): existing pixels, stroke tile has pixels only where coverage mask is 0 -> r = 0 (unchanged, stays shared with clone)
                const t01 = layer.writable(0, 1);
                t01.data[0] = 10; t01.data[1] = 20; t01.data[2] = 30; t01.data[3] = 255;
                // Tile (1,1): absent in layer, stroke paints new pixels -> r = 1 (created)
                const snap = layer.clone(); // freezes t00, t10, t01 as commitStroke does
                const before = packTiles(snap).slice();

                // Step 1: compositeStroke with source-over (op = 0) on (0,0), (0,1), (1,1)
                const stroke1 = new TileLayerPixels(512, 512);
                const s00 = stroke1.writable(0, 0);
                for (let p = 0; p < 1000; p++) { s00.data[p * 4] = 250; s00.data[p * 4 + 1] = 30; s00.data[p * 4 + 2] = 60; s00.data[p * 4 + 3] = 180; }
                const s01 = stroke1.writable(0, 1);
                s01.data[0] = 255; s01.data[3] = 255;
                const s11 = stroke1.writable(1, 1);
                s11.data[100] = 90; s11.data[101] = 190; s11.data[102] = 210; s11.data[103] = 240;
                const zeroCov = new Uint8Array(65536);
                const cov1 = (tx, ty) => (tx === 0 && ty === 1 ? zeroCov : true); // all 0 on tile (0,1), full on others

                K.pxCalls(true);
                const w1 = layer.compositeStroke(stroke1, 0, 220, cov1);
                const c1 = K.pxCalls(true).composite_masked_tile || 0;

                // Step 2: compositeStroke with destination-out (op = 1) on (1,0) to erase it completely
                const stroke2 = new TileLayerPixels(512, 512);
                const s10 = stroke2.writable(1, 0);
                s10.data[3] = 255;
                const w2 = layer.compositeStroke(stroke2, 1, 255, null);
                const c2 = K.pxCalls(true).composite_masked_tile || 0;

                return {
                    bytes: packTiles(layer),
                    snapBytes: packTiles(snap),
                    before,
                    w1, w2, c1, c2,
                    shared01: layer.tileAt(0, 1) === snap.tileAt(0, 1),
                    dropped10: layer.tileAt(1, 0) === null && snap.tileAt(1, 0) !== null,
                    created11: layer.tileAt(1, 1) !== null && snap.tileAt(1, 1) === null,
                };
            };
            const stJs = buildAndStroke("js"), stRust = buildAndStroke("rust");
            check("TileLayerPixels.compositeStroke on js and rust routes matches byte-for-byte, drops emptied tiles, and keeps unchanged tiles shared with frozen clones",
                eqBytes(stJs.bytes, stRust.bytes) && eqBytes(stJs.snapBytes, stRust.snapBytes)
                && eqBytes(stJs.snapBytes, stJs.before) && eqBytes(stRust.snapBytes, stRust.before)
                && stJs.w1 === 2 && stRust.w1 === 2 && stJs.w2 === 1 && stRust.w2 === 1
                && stJs.c1 === 0 && stJs.c2 === 0 && stRust.c1 === 3 && stRust.c2 === 1
                && stJs.shared01 && stRust.shared01 && stJs.dropped10 && stRust.dropped10 && stJs.created11 && stRust.created11,
                `js w=${stJs.w1},${stJs.w2} c=${stJs.c1},${stJs.c2}; rust w=${stRust.w1},${stRust.w2} c=${stRust.c1},${stRust.c2}`);
        } finally {
            kernelsBack(K);
            K.setKernels(prevMode);
        }
    }

    if (process.env.PX_BENCH) {
        const px = 65536, dst = makeDriftDst(px, 901), srcFull = pixelRow(px, 902), out = new Uint8Array(px * 4);
        const srcSparse = new Uint8Array(px * 4);
        for (let y = 40; y < 88; y++) for (let x = 40; x < 88; x++) {
            const i = (y * 256 + x) * 4;
            srcSparse[i] = 220; srcSparse[i + 1] = 80; srcSparse[i + 2] = 140; srcSparse[i + 3] = 200;
        }
        for (const [what, s] of [["full 256² tile", srcFull], ["48² dab in 256² tile", srcSparse]]) {
            const rows = [
                ["twin", () => js.compositeMaskedTile(dst, s, 0, 200, null, px, () => out)],
                ["simd", () => simd.compositeMaskedTile(dst, s, 0, 200, null, px, () => out)],
                ["scalar", () => scalar.compositeMaskedTile(dst, s, 0, 200, null, px, () => out)],
            ];
            const med = benchMedians(rows, { rounds: 200 });
            console.log(`       composite_masked_tile ${what}: ${rows.map(([n]) => `${n} ${med[n].toFixed(3)}`).join(", ")} ms (median of 200)`);
        }
    }
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
async function pngPartCases(px, label, js) {
    const zlib = require("node:zlib");
    const png = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_png.js")).href);
    const w = 700, rows = [5, 1, 64, 30];
    const total = rows.reduce((a, b) => a + b, 0);
    const src = randomRGBA(w, total, 21);
    src.fill(9, 0, w * 4 * 3);                                     // runs, so that deflate has something to match
    for (let y = 10; y < 60; y += 2) src.copyWithin(y * w * 4, 0, w * 4);
    let framedOk = true, framedDetail = "";
    for (const level of [1, 2, 6]) {
        const parts = [];
        let y = 0;
        rows.forEach((n, i) => {
            const prev = y ? src.subarray((y - 1) * w * 4, y * w * 4) : null;
            const p = px.pngPart(src.subarray(y * w * 4, (y + n) * w * 4), w, n, prev, level, i === rows.length - 1);
            parts.push(p);
            const wantChunk = png.pngChunk("IDAT", p.bytes);
            const wantCrc = px.crc32(p.chunk.subarray(4, p.chunk.byteLength - 4), 0);
            const isSub = p.chunk instanceof Uint8Array && p.bytes instanceof Uint8Array
                && p.bytes.buffer === p.chunk.buffer && p.bytes.byteOffset === p.chunk.byteOffset + 8
                && p.bytes.byteLength === p.chunk.byteLength - 12;
            if (framedOk && (!isSub || p.crc !== wantCrc || !eqBytes(p.chunk, wantChunk))) {
                framedOk = false;
                framedDetail = `level ${level} part ${i}: sub=${isSub} crc=${p.crc}/${wantCrc} ${firstDiff(p.chunk, wantChunk)}`;
            }
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
    check(`${label} pngPart frames each part in wasm as an IDAT chunk (bytes a subarray of chunk, crc matching pngChunk)`, framedOk, framedDetail);
    const big = px.pngPart(new Uint8Array(4096 * 64 * 4), 4096, 64, null, 2, true);
    check(`${label} pngPart of an empty band is small`, big.bytes.length < 4096, `${big.bytes.length} bytes`);
    // incompressible rows: the output is larger than the input and the first buffer is still enough
    const noise = randomRGBA(900, 40, 77);
    const np = px.pngPart(noise, 900, 40, null, 1, true);
    let nout = null;
    try { nout = new Uint8Array(zlib.inflateRawSync(Buffer.from(np.bytes))); } catch (_) { /* reported below */ }
    check(`${label} pngPart of noise inflates back`, !!nout && nout.length === np.raw);
    await crcAndFrameCases(px, label, png, zlib, js);
    await noisePartCases(px, label, png, zlib);
    await composeWasmPartCases(px, label, png, zlib);
    await partDecodeCases(px, label, png, zlib, js);
}

// K7 (docs/PLAN_WASM_BUILD.md §4.2, §7 Stop 2): png_part_lines_cap, png_part_decode, and png_part_finish over the
// filtered lines delivered by native DecompressionStream("deflate-raw").
async function partDecodeCases(px, label, png, zlib, js) {
    // 1. png_part_lines_cap / pngPartLinesCap across widths, clamp boundaries (1024/1025, 2097152/2097153), and overflow
    const capWidths = [-5, 0, 1, 2, 16, 64, 255, 256, 257, 700, 1024, 1025, 4096, 6000, 8192, 8193, 15000, 1048576, 2097152, 2097153, 3_000_000, 0x3fffffff, 0x40000000];
    let capOk = true, capDetail = "";
    for (const w of capWidths) {
        const want = w > 0 && w <= 0x3fffffff ? Math.max(1, Math.min(2048, Math.floor((8 * 1048576) / (4 * w)))) * (4 * w + 1) : 0;
        const gotJ = js.pngPartLinesCap(w);
        const gotP = px.pngPartLinesCap(w);
        const gotE = w >= 0 ? (px.exports.png_part_lines_cap(w) >>> 0) : 0;
        if (gotJ !== want || gotP !== want || (w >= 0 && gotE !== want)) {
            capOk = false;
            capDetail = `w=${w}: js=${gotJ} px=${gotP} exp=${gotE} want=${want}`;
            break;
        }
    }
    check(`${label} png_part_lines_cap equals partRows(w) * (1 + 4 * w) across clamp boundaries and overflow`, capOk, capDetail);

    // 2. Round-trip tables: CPU-canvas 8-bit premultiply-unpremultiply table + distinct custom table
    const rtCanvas = new Uint8Array(65536);
    const rtCustom = new Uint8Array(65536);
    for (let a = 0; a < 256; a++) {
        for (let c = 0; c < 256; c++) {
            const idx = (a << 8) | c;
            if (a === 0) {
                rtCanvas[idx] = 0;
            } else if (a === 255) {
                rtCanvas[idx] = c;
            } else {
                const p = Math.floor((c * a + 127) / 255);
                rtCanvas[idx] = Math.min(255, Math.floor((p * 255 + (a >> 1)) / a));
            }
            rtCustom[idx] = a === 255 ? c : ((a * 73 + c * 19 + 7) & 255);
        }
    }

    const filterRowWithType = (row, prev, ft) => {
        const n = row.length, out = new Uint8Array(n + 1);
        out[0] = ft;
        for (let i = 0; i < n; i++) {
            const a = i >= 4 ? row[i - 4] : 0;
            const b = prev ? prev[i] : 0;
            const c = i >= 4 && prev ? prev[i - 4] : 0;
            const pred = ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : paeth(a, b, c);
            out[1 + i] = (row[i] - pred) & 255;
        }
        return out;
    };
    const buildLines = (rgba, w, rows, prev0, firstFt, nextFtFn) => {
        const rowBytes = w * 4, stride = rowBytes + 1, out = new Uint8Array(rows * stride);
        for (let y = 0; y < rows; y++) {
            const cur = rgba.subarray(y * rowBytes, (y + 1) * rowBytes);
            const up = y === 0 ? prev0 : rgba.subarray((y - 1) * rowBytes, y * rowBytes);
            const ft = y === 0 ? firstFt : nextFtFn(y);
            out.set(filterRowWithType(cur, up, ft), y * stride);
        }
        return out;
    };
    const refAdler32 = (bytes) => {
        let a = 1, b = 0;
        for (let i = 0; i < bytes.length; i++) {
            a = (a + bytes[i]) % 65521;
            b = (b + a) % 65521;
        }
        return ((b << 16) | a) >>> 0;
    };
    check(`${label} adler32 standard vector ("Wikipedia" -> 11E60398) and empty buffer`,
        js.adler32(new Uint8Array(0), 1) === 1
        && js.adler32(new Uint8Array(Buffer.from("Wikipedia")), 1) === 0x11E60398);
    const refApplyRt = (rgba, rt) => {
        const out = rgba.slice();
        let opaque = true;
        for (let i = 0; i < out.length; i += 4) {
            const a = out[i + 3];
            if (a < 255) {
                opaque = false;
                if (rt) {
                    const row = a << 8;
                    out[i] = rt[row | out[i]];
                    out[i + 1] = rt[row | out[i + 1]];
                    out[i + 2] = rt[row | out[i + 2]];
                }
            }
        }
        return { out, opaque };
    };

    const decodeCases = [];
    const finishCases = [];
    let refOk = true, refDetail = "";

    const testShapes = [
        [1, 1], [1, 3], [2, 2], [3, 2], [4, 2], [5, 3],
        [15, 2], [16, 2], [17, 3], [63, 2], [64, 2], [65, 2],
        [255, 2], [257, 2], [700, 4], [4097, 2],
    ];
    let seed = 7000;
    for (const [w, rows] of testShapes) {
        const rowBytes = w * 4;
        for (let firstFt = 0; firstFt <= 4; firstFt++) {
            const s = ++seed;
            const alphaMode = (firstFt + w) % 4;
            const rgba = randomRGBA(w, rows, s, { opaque: alphaMode !== 2 });
            if (alphaMode === 1) {
                // Single translucent pixel at the very last pixel of the last row
                rgba[(rows * w - 1) * 4 + 3] = 254;
            } else if (alphaMode === 3) {
                // Translucent pixel in the first row only
                rgba[3] = 128;
            }
            const prevRow = randomRGBA(w, 1, s + 500, { opaque: false });
            const rt = (s % 3 === 0) ? null : (s % 3 === 1) ? rtCanvas : rtCustom;
            const linesWithPrev = buildLines(rgba, w, rows, prevRow, firstFt, (y) => (firstFt + y) % 5);
            const linesTop = buildLines(rgba, w, rows, new Uint8Array(rowBytes), firstFt, (y) => (firstFt + y * 2) % 5);

            const wantAdlerWithPrev = refAdler32(linesWithPrev);
            const wantAdlerTop = refAdler32(linesTop);
            const { out: wantOut, opaque: wantOpaque } = refApplyRt(rgba, rt);
            const wantLastRow = rgba.subarray((rows - 1) * rowBytes, rows * rowBytes);

            // Case A: prev provided -> always decodes immediately (needsPrev = false)
            decodeCases.push({
                tag: `w=${w} r=${rows} ft=${firstFt} withPrev rt=${rt ? (rt === rtCanvas ? "canvas" : "custom") : "none"}`,
                args: [linesWithPrev, w, prevRow, rt],
            });
            // Case B: prev is null -> decodes immediately when firstFt <= 1 (using zero row above), or needsPrev = true when firstFt >= 2
            const linesForNullPrev = firstFt <= 1 ? linesTop : linesWithPrev;
            decodeCases.push({
                tag: `w=${w} r=${rows} ft=${firstFt} nullPrev rt=${rt ? (rt === rtCanvas ? "canvas" : "custom") : "none"}`,
                args: [linesForNullPrev, w, null, rt],
            });
            if (firstFt >= 2) {
                finishCases.push({
                    tag: `finish w=${w} r=${rows} ft=${firstFt} rt=${rt ? (rt === rtCanvas ? "canvas" : "custom") : "none"}`,
                    args: [linesWithPrev, rows, w, prevRow, rt],
                });
            }

            // Verify JS twin against independent reference + refAdler32
            if (refOk) {
                const pCopy = prevRow.slice();
                const lCopy = linesWithPrev.slice();
                const rA = js.pngPartDecode(lCopy, w, pCopy, rt);
                if (rA.code !== rows || rA.rows !== rows || rA.adler !== wantAdlerWithPrev || rA.firstFilter !== firstFt
                    || rA.opaque !== wantOpaque || rA.needsPrev !== false || !eqBytes(rA.out, wantOut)
                    || !eqBytes(pCopy, wantLastRow) || !eqBytes(lCopy, linesWithPrev)) {
                    refOk = false;
                    refDetail = `withPrev w=${w} r=${rows} ft=${firstFt}: code=${rA.code} adler=${rA.adler}/${wantAdlerWithPrev} opaque=${rA.opaque}/${wantOpaque}`;
                }
                const lNullCopy = linesForNullPrev.slice();
                const rB = js.pngPartDecode(lNullCopy, w, null, rt);
                if (firstFt <= 1) {
                    if (rB.code !== rows || rB.rows !== rows || rB.adler !== wantAdlerTop || rB.firstFilter !== firstFt
                        || rB.opaque !== wantOpaque || rB.needsPrev !== false || !eqBytes(rB.out, wantOut)
                        || !eqBytes(rB.prev, wantLastRow) || !eqBytes(lNullCopy, linesForNullPrev)) {
                        refOk = false;
                        refDetail = `nullPrev ft=${firstFt} w=${w} r=${rows}: code=${rB.code} needsPrev=${rB.needsPrev}`;
                    }
                } else {
                    if (rB.code !== rows || rB.rows !== rows || rB.adler !== wantAdlerWithPrev || rB.firstFilter !== firstFt
                        || rB.opaque !== false || rB.needsPrev !== true || rB.out !== null || rB.prev !== null
                        || !eqBytes(lNullCopy, linesForNullPrev)) {
                        refOk = false;
                        refDetail = `nullPrev ft=${firstFt} w=${w} r=${rows}: expected needsPrev=true, got ${JSON.stringify(rB)}`;
                    }
                    const pFin = prevRow.slice();
                    const rF = js.pngPartFinish(lNullCopy, rows, w, pFin, rt);
                    if (rF.code !== rows || rF.rows !== rows || rF.firstFilter !== firstFt || rF.opaque !== wantOpaque
                        || rF.needsPrev !== false || !eqBytes(rF.out, wantOut) || !eqBytes(pFin, wantLastRow)
                        || !eqBytes(lNullCopy, linesForNullPrev)) {
                        refOk = false;
                        refDetail = `finish ft=${firstFt} w=${w} r=${rows}: code=${rF.code} opaque=${rF.opaque}/${wantOpaque}`;
                    }
                }
            }
        }
    }
    check(`${label} js pngPartDecode and pngPartFinish match reference unfilter, round-trip table, pre-rt prev row, and refAdler32 (${decodeCases.length} decode + ${finishCases.length} finish cases)`,
        refOk, refDetail);

    twinCheck({
        name: "png_part_decode",
        builds: [[label, px]],
        twin: js,
        call: (k, [lines, w, prev, rt]) => {
            const lSnap = lines.slice();
            const r = k.pngPartDecode(lines, w, prev, rt);
            if (!eqBytes(lines, lSnap)) throw new Error("caller lines mutated");
            return {
                code: r.code, rows: r.rows, adler: r.adler, firstFilter: r.firstFilter,
                opaque: r.opaque, needsPrev: r.needsPrev, out: r.out, prev: r.prev,
            };
        },
        cases: decodeCases,
        shift: [0, 2, 3],
    });

    twinCheck({
        name: "png_part_finish",
        builds: [[label, px]],
        twin: js,
        call: (k, [lines, rows, w, prev, rt]) => {
            const lSnap = lines.slice();
            const r = k.pngPartFinish(lines, rows, w, prev, rt);
            if (!eqBytes(lines, lSnap)) throw new Error("caller lines mutated");
            return {
                code: r.code, rows: r.rows, firstFilter: r.firstFilter,
                opaque: r.opaque, needsPrev: r.needsPrev, out: r.out, prev: r.prev,
            };
        },
        cases: finishCases,
        shift: [0, 3, 4],
    });

    // Caller-supplied out buffer (including Uint8ClampedArray view at an offset)
    {
        const w = 33, rows = 3, rowBytes = w * 4;
        const rgba = randomRGBA(w, rows, 8888, { opaque: false });
        const prev = randomRGBA(w, 1, 8889, { opaque: false });
        const lines = buildLines(rgba, w, rows, prev, 4, (y) => y % 5);
        const backingA = new Uint8ClampedArray(rows * rowBytes + 16).fill(0x5a);
        const backingB = new Uint8ClampedArray(rows * rowBytes + 16).fill(0x5a);
        const viewA = new Uint8ClampedArray(backingA.buffer, 8, rows * rowBytes);
        const viewB = new Uint8ClampedArray(backingB.buffer, 8, rows * rowBytes);
        const rJ = js.pngPartDecode(lines, w, prev.slice(), rtCanvas, viewA);
        const rP = px.pngPartDecode(lines, w, prev.slice(), rtCanvas, viewB);
        const rFJ = js.pngPartFinish(lines, rows, w, prev.slice(), rtCanvas, viewA);
        const rFP = px.pngPartFinish(lines, rows, w, prev.slice(), rtCanvas, viewB);
        check(`${label} pngPartDecode and pngPartFinish write into a given Uint8ClampedArray view without touching guard bytes`,
            rJ.out === viewA && rP.out === viewB && rFJ.out === viewA && rFP.out === viewB
            && eqBytes(backingA, backingB) && backingB[0] === 0x5a && backingB[rows * rowBytes + 15] === 0x5a);
    }

    // 3. Error codes: -4 (PART_NOT_LINES) and -5 (PART_BAD_FILTER) on wrapper and raw exports,
    // verifying no byte of lines, prev, or out is mutated on any refusal, plus seeded refusal/decode fuzz
    {
        const w = 8, rows = 3, rowBytes = w * 4, stride = rowBytes + 1;
        const goodLines = new Uint8Array(rows * stride).fill(0x11);
        for (let y = 0; y < rows; y++) goodLines[y * stride] = y % 5;
        const goodPrev = new Uint8Array(rowBytes).fill(0x33);
        const goodOut = new Uint8Array(rows * rowBytes).fill(0x77);
        let errOk = true, errDetail = "";
        const runRefusalDecode = (what, linesIn, wIn, prevIn, rtIn, outIn, want) => {
            if (!errOk) return;
            const lSnap = linesIn ? linesIn.slice() : null;
            const pSnap = prevIn ? prevIn.slice() : null;
            const oSnap = outIn ? outIn.slice() : null;
            const lJ = linesIn ? linesIn.slice() : null, lP = linesIn ? linesIn.slice() : null;
            const pJ = prevIn ? prevIn.slice() : null, pP = prevIn ? prevIn.slice() : null;
            const oJ = outIn ? outIn.slice() : null, oP = outIn ? outIn.slice() : null;
            const gotJ = js.pngPartDecode(lJ, wIn, pJ, rtIn, oJ).code;
            const gotP = px.pngPartDecode(lP, wIn, pP, rtIn, oP).code;
            if (gotJ !== want || gotP !== want) {
                errOk = false;
                errDetail = `decode ${what}: js=${gotJ} px=${gotP} want=${want}`;
                return;
            }
            if ((lSnap && (!eqBytes(lJ, lSnap) || !eqBytes(lP, lSnap)))
                || (pSnap && (!eqBytes(pJ, pSnap) || !eqBytes(pP, pSnap)))
                || (oSnap && (!eqBytes(oJ, oSnap) || !eqBytes(oP, oSnap)))) {
                errOk = false;
                errDetail = `decode ${what}: mutated caller lines/prev/out on refusal (${want})`;
            }
        };
        const runRefusalFinish = (what, linesIn, rowsIn, wIn, prevIn, rtIn, outIn, want) => {
            if (!errOk) return;
            const lSnap = linesIn ? linesIn.slice() : null;
            const pSnap = prevIn ? prevIn.slice() : null;
            const oSnap = outIn ? outIn.slice() : null;
            const lJ = linesIn ? linesIn.slice() : null, lP = linesIn ? linesIn.slice() : null;
            const pJ = prevIn ? prevIn.slice() : null, pP = prevIn ? prevIn.slice() : null;
            const oJ = outIn ? outIn.slice() : null, oP = outIn ? outIn.slice() : null;
            const gotJ = js.pngPartFinish(lJ, rowsIn, wIn, pJ, rtIn, oJ).code;
            const gotP = px.pngPartFinish(lP, rowsIn, wIn, pP, rtIn, oP).code;
            if (gotJ !== want || gotP !== want) {
                errOk = false;
                errDetail = `finish ${what}: js=${gotJ} px=${gotP} want=${want}`;
                return;
            }
            if ((lSnap && (!eqBytes(lJ, lSnap) || !eqBytes(lP, lSnap)))
                || (pSnap && (!eqBytes(pJ, pSnap) || !eqBytes(pP, pSnap)))
                || (oSnap && (!eqBytes(oJ, oSnap) || !eqBytes(oP, oSnap)))) {
                errOk = false;
                errDetail = `finish ${what}: mutated caller lines/prev/out on refusal (${want})`;
            }
        };
        const notLinesDecode = [
            ["null lines", [null, w, goodPrev, null, goodOut]],
            ["w = 0", [goodLines, 0, goodPrev, null, goodOut]],
            ["w < 0", [goodLines, -4, goodPrev, null, goodOut]],
            ["w = 0x40000000", [goodLines, 0x40000000, goodPrev, null, goodOut]],
            ["empty lines", [new Uint8Array(0), w, goodPrev, null, goodOut]],
            ["len = stride - 1", [new Uint8Array(stride - 1).fill(0x22), w, goodPrev, null, goodOut]],
            ["len = stride + 1", [new Uint8Array(stride + 1).fill(0x22), w, goodPrev, null, goodOut]],
            ["len = 2*stride - 1", [new Uint8Array(2 * stride - 1).fill(0x22), w, goodPrev, null, goodOut]],
            ["short prev", [goodLines, w, new Uint8Array(rowBytes - 1).fill(0x33), null, goodOut]],
            ["short rt", [goodLines, w, goodPrev, new Uint8Array(65535), goodOut]],
            ["short out", [goodLines, w, goodPrev, null, new Uint8Array(rows * rowBytes - 1).fill(0x77)]],
        ];
        for (const [what, args] of notLinesDecode) {
            runRefusalDecode(what, ...args, -4);
        }
        const notLinesFinish = [
            ["null lines", [null, rows, w, goodPrev, null, goodOut]],
            ["null prev", [goodLines, rows, w, null, null, goodOut]],
            ["w = 0", [goodLines, rows, 0, goodPrev, null, goodOut]],
            ["w < 0", [goodLines, rows, -1, goodPrev, null, goodOut]],
            ["w = 0x40000000", [goodLines, rows, 0x40000000, goodPrev, null, goodOut]],
            ["rows = 0", [goodLines, 0, w, goodPrev, null, goodOut]],
            ["rows < 0", [goodLines, -1, w, goodPrev, null, goodOut]],
            ["lines length != rows * stride", [new Uint8Array((rows - 1) * stride).fill(0x22), rows, w, goodPrev, null, goodOut]],
            ["short prev", [goodLines, rows, w, new Uint8Array(rowBytes - 1).fill(0x33), null, goodOut]],
            ["short rt", [goodLines, rows, w, goodPrev, new Uint8Array(65535), goodOut]],
            ["short out", [goodLines, rows, w, goodPrev, null, new Uint8Array(rows * rowBytes - 1).fill(0x77)]],
        ];
        for (const [what, args] of notLinesFinish) {
            runRefusalFinish(what, ...args, -4);
        }
        // Filter byte checks: 4 is valid, 5..255 on row 0, middle row, or last row return -5 (PART_BAD_FILTER)
        // and leave every byte of lines, prev (both JS and Px), and out (both JS and Px) untouched.
        for (const badRow of [0, 1, rows - 1]) {
            for (const badByte of [5, 6, 128, 255]) {
                const bad = goodLines.slice();
                bad[badRow * stride] = badByte;
                runRefusalDecode(`bad filter ${badByte} row ${badRow}`, bad, w, goodPrev, null, goodOut, -5);
                runRefusalDecode(`bad filter ${badByte} row ${badRow} (null prev)`, bad, w, null, null, null, -5);
                runRefusalFinish(`bad filter ${badByte} row ${badRow}`, bad, rows, w, goodPrev, null, goodOut, -5);
            }
        }
        // Raw wasm export pointer/dimension checks
        const pl = px.alloc(rows * stride), pp = px.alloc(rowBytes), po = px.alloc(rows * rowBytes), pi = px.alloc(20);
        try {
            px.u8().fill(0, pl, pl + rows * stride);
            px.u8()[pl] = 2; // firstFilter = 2 (Up)
            const rawChecks = [
                ["decode null lines", px.exports.png_part_decode(0, rows * stride, w, pp, 0, po, pi), -4],
                ["decode null info", px.exports.png_part_decode(pl, rows * stride, w, pp, 0, po, 0), -4],
                ["decode w = 0", px.exports.png_part_decode(pl, rows * stride, 0, pp, 0, po, pi), -4],
                ["decode w overflow", px.exports.png_part_decode(pl, rows * stride, 0x40000000, pp, 0, po, pi), -4],
                ["decode len = 0", px.exports.png_part_decode(pl, 0, w, pp, 0, po, pi), -4],
                ["decode len % stride != 0", px.exports.png_part_decode(pl, rows * stride - 1, w, pp, 0, po, pi), -4],
                ["decode null out when prev given", px.exports.png_part_decode(pl, rows * stride, w, pp, 0, 0, pi), -4],
                ["decode null out when needs_prev=true succeeds", px.exports.png_part_decode(pl, rows * stride, w, 0, 0, 0, pi), rows],
                ["finish null lines", px.exports.png_part_finish(0, rows, w, pp, 0, po, pi), -4],
                ["finish null prev", px.exports.png_part_finish(pl, rows, w, 0, 0, po, pi), -4],
                ["finish null out", px.exports.png_part_finish(pl, rows, w, pp, 0, 0, pi), -4],
                ["finish null info", px.exports.png_part_finish(pl, rows, w, pp, 0, po, 0), -4],
                ["finish rows = 0", px.exports.png_part_finish(pl, 0, w, pp, 0, po, pi), -4],
                ["finish w = 0", px.exports.png_part_finish(pl, rows, 0, pp, 0, po, pi), -4],
                ["finish w overflow", px.exports.png_part_finish(pl, rows, 0x40000000, pp, 0, po, pi), -4],
            ];
            px.u8()[pl] = 1; // firstFilter = 1 (Sub): does not need prev, so null out must return -4
            rawChecks.push(["decode null out when prev=0 and firstFilter=1", px.exports.png_part_decode(pl, rows * stride, w, 0, 0, 0, pi), -4]);
            for (const [what, got, want] of rawChecks) {
                if (errOk && got !== want) {
                    errOk = false;
                    errDetail = `raw ${what}: got ${got}, want ${want}`;
                }
            }
        } finally {
            px.free(pl, rows * stride);
            px.free(pp, rowBytes);
            px.free(po, rows * rowBytes);
            px.free(pi, 20);
        }
        check(`${label} png_part_decode and png_part_finish return -4 (PART_NOT_LINES) and -5 (PART_BAD_FILTER) without mutating caller buffers`,
            errOk, errDetail);

        // Seeded fuzz of length, w, rows, filter bytes, prev, and out (including inputs bad in both length/dims and filter bytes,
        // pinning that -4 takes precedence over -5) across twin and wasm build
        let fzSeed = 0x517cc1b7;
        const fzNext = () => { fzSeed = (Math.imul(fzSeed, 1664525) + 1013904223) >>> 0; return fzSeed; };
        const fzWidths = [-7, -1, 0, 1, 2, 3, 4, 5, 7, 8, 15, 16, 17, 33, 64, 0x40000000];
        const fzRows = [-2, 0, 1, 2, 3, 4];
        let fuzzOk = true, fuzzDetail = "";
        for (let t = 0; t < 240 && fuzzOk; t++) {
            const fw = fzWidths[fzNext() & 15];
            const fr = fzRows[fzNext() % fzRows.length];
            const validW = fw > 0 && fw <= 0x3fffffff;
            const fRowBytes = validW ? fw * 4 : 16;
            const fStride = validW ? fRowBytes + 1 : 17;
            let fLen;
            if (t % 4 === 2 && validW) {
                // Force bad length/dims + bad filter simultaneously to pin -4 before -5
                const badLens = [0, 1, fStride - 1, fStride + 1, 2 * fStride - 1];
                fLen = badLens[fzNext() % badLens.length];
            } else if (validW) {
                const lenChoices = [0, 1, fStride - 1, fStride, fStride + 1, 2 * fStride - 1, 2 * fStride, 3 * fStride, fzNext() % (4 * fStride + 5)];
                fLen = lenChoices[fzNext() % lenChoices.length];
            } else {
                fLen = [0, 1, 17, 34, 51][fzNext() % 5];
            }
            const fLines = new Uint8Array(fLen);
            for (let i = 0; i < fLen; i++) fLines[i] = (fzNext() >>> 16) & 255;
            if (fLen > 0 && validW) {
                const nFullRows = Math.floor(fLen / fStride);
                if (t % 4 === 0) {
                    for (let y = 0; y < nFullRows; y++) fLines[y * fStride] = (fzNext() >>> 8) % 5;
                } else if (t % 4 === 1 && nFullRows > 0) {
                    for (let y = 0; y < nFullRows; y++) fLines[y * fStride] = (fzNext() >>> 8) % 5;
                    const badY = fzNext() % nFullRows;
                    fLines[badY * fStride] = 5 + ((fzNext() >>> 8) % 251);
                } else if (t % 4 === 2) {
                    fLines[0] = 5 + ((fzNext() >>> 8) % 251);
                }
            }
            const prevMode = fzNext() % 3; // 0: null, 1: valid, 2: short
            const fPrev = prevMode === 0 ? null : new Uint8Array(prevMode === 1 ? fRowBytes : Math.max(0, fRowBytes - 1));
            if (fPrev) for (let i = 0; i < fPrev.length; i++) fPrev[i] = (fzNext() >>> 16) & 255;
            const outMode = fzNext() % 3; // 0: null, 1: valid, 2: short
            const estRows = validW && fLen > 0 && fLen % fStride === 0 ? fLen / fStride : Math.max(1, fr);
            const fOut = outMode === 0 ? null : new Uint8Array(outMode === 1 ? estRows * fRowBytes : Math.max(0, estRows * fRowBytes - 1));
            if (fOut) for (let i = 0; i < fOut.length; i++) fOut[i] = (fzNext() >>> 16) & 255;
            const fRt = (fzNext() & 1) ? rtCanvas : null;

            const lDJ = fLines.slice(), lDP = fLines.slice();
            const pDJ = fPrev ? fPrev.slice() : null, pDP = fPrev ? fPrev.slice() : null;
            const oDJ = fOut ? fOut.slice() : null, oDP = fOut ? fOut.slice() : null;
            const dJ = js.pngPartDecode(lDJ, fw, pDJ, fRt, oDJ);
            const dP = px.pngPartDecode(lDP, fw, pDP, fRt, oDP);
            const shapeValidDecode = validW && fLen > 0 && fLen % fStride === 0
                && (!fPrev || fPrev.length >= fRowBytes) && (!fOut || fOut.length >= (fLen / fStride) * fRowBytes);
            if (dJ.code !== dP.code || (!shapeValidDecode && dJ.code !== -4)) {
                fuzzOk = false;
                fuzzDetail = `fuzz decode #${t} (w=${fw} len=${fLen}): js=${dJ.code} px=${dP.code} shapeValid=${shapeValidDecode}`;
                break;
            }
            if (!eqBytes(lDJ, fLines) || !eqBytes(lDP, fLines)) {
                fuzzOk = false;
                fuzzDetail = `fuzz decode #${t}: lines mutated`;
                break;
            }
            if (dJ.code < 0) {
                if ((fPrev && (!eqBytes(pDJ, fPrev) || !eqBytes(pDP, fPrev)))
                    || (fOut && (!eqBytes(oDJ, fOut) || !eqBytes(oDP, fOut)))) {
                    fuzzOk = false;
                    fuzzDetail = `fuzz decode #${t}: prev/out mutated on code ${dJ.code}`;
                    break;
                }
            } else if (dJ.adler !== dP.adler || dJ.firstFilter !== dP.firstFilter || dJ.opaque !== dP.opaque
                || dJ.needsPrev !== dP.needsPrev
                || !eqBytes(dJ.out || new Uint8Array(0), dP.out || new Uint8Array(0))
                || !eqBytes(dJ.prev || new Uint8Array(0), dP.prev || new Uint8Array(0))) {
                fuzzOk = false;
                fuzzDetail = `fuzz decode #${t}: output mismatch on valid decode`;
                break;
            }

            const lFJ = fLines.slice(), lFP = fLines.slice();
            const pFJ = fPrev ? fPrev.slice() : null, pFP = fPrev ? fPrev.slice() : null;
            const oFJ = fOut ? fOut.slice() : null, oFP = fOut ? fOut.slice() : null;
            const fJ = js.pngPartFinish(lFJ, fr, fw, pFJ, fRt, oFJ);
            const fP = px.pngPartFinish(lFP, fr, fw, pFP, fRt, oFP);
            const shapeValidFinish = validW && fr > 0 && fLen === fr * fStride
                && !!fPrev && fPrev.length >= fRowBytes && (!fOut || fOut.length >= fr * fRowBytes);
            if (fJ.code !== fP.code || (!shapeValidFinish && fJ.code !== -4)) {
                fuzzOk = false;
                fuzzDetail = `fuzz finish #${t} (w=${fw} r=${fr} len=${fLen}): js=${fJ.code} px=${fP.code} shapeValid=${shapeValidFinish}`;
                break;
            }
            if (!eqBytes(lFJ, fLines) || !eqBytes(lFP, fLines)) {
                fuzzOk = false;
                fuzzDetail = `fuzz finish #${t}: lines mutated`;
                break;
            }
            if (fJ.code < 0) {
                if ((fPrev && (!eqBytes(pFJ, fPrev) || !eqBytes(pFP, fPrev)))
                    || (fOut && (!eqBytes(oFJ, fOut) || !eqBytes(oFP, fOut)))) {
                    fuzzOk = false;
                    fuzzDetail = `fuzz finish #${t}: prev/out mutated on code ${fJ.code}`;
                    break;
                }
            } else if (fJ.firstFilter !== fP.firstFilter || fJ.opaque !== fP.opaque
                || !eqBytes(fJ.out, fP.out) || !eqBytes(fJ.prev, fP.prev)) {
                fuzzOk = false;
                fuzzDetail = `fuzz finish #${t}: output mismatch on valid finish`;
                break;
            }
        }
        check(`${label} png_part_decode and png_part_finish seeded fuzz (240 decode + 240 finish cases across length, w, filter bytes, and -4 before -5 precedence)`,
            fuzzOk, fuzzDetail);
    }

    // 4. Multi-part end-to-end round-trip: pngPart -> native DecompressionStream("deflate-raw") (+ 03 00 on non-last) ->
    // out-of-order pngPartDecode -> forward pngPartFinish -> adlerCombine + round-trip verification
    const inflateRawPart = async (deflated, isLast) => {
        const body = isLast ? [deflated] : [deflated, new Uint8Array([0x03, 0x00])];
        const stream = new Blob(body).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    };
    {
        const w = 257, partHeights = [7, 5, 8, 6], H = partHeights.reduce((a, b) => a + b, 0);
        const src = randomRGBA(w, H, 9401, { opaque: false });
        // Make rows 0..11 opaque and row 12+ translucent so per-part opaque flags mix true and false
        for (let i = 3; i < 12 * w * 4; i += 4) src[i] = 255;
        const encodedParts = [];
        let y0 = 0;
        for (let i = 0; i < partHeights.length; i++) {
            const r = partHeights[i];
            const prev = y0 > 0 ? src.subarray((y0 - 1) * w * 4, y0 * w * 4) : null;
            const p = px.pngPart(src.subarray(y0 * w * 4, (y0 + r) * w * 4), w, r, prev, 2, i === partHeights.length - 1);
            encodedParts.push({ y0, rows: r, bytes: p.bytes, adler: p.adler, raw: p.raw, last: i === partHeights.length - 1 });
            y0 += r;
        }
        const inflatedLines = await Promise.all(encodedParts.map((p) => inflateRawPart(p.bytes, p.last)));
        // Decode in reverse order (3, 2, 1, 0): part 0 gets zero prev, parts 1..3 get prev = null
        const decoded = new Array(encodedParts.length);
        for (let i = encodedParts.length - 1; i >= 0; i--) {
            const p0 = i === 0 ? new Uint8Array(w * 4) : null;
            decoded[i] = px.pngPartDecode(inflatedLines[i], w, p0, rtCanvas);
        }
        // Finish in forward order (0..3) any part that answered needsPrev: true
        const assembled = new Uint8Array(H * w * 4);
        let combinedAdler = 1, allOpaque = true, e2eOk = true, e2eDetail = "";
        for (let i = 0; i < encodedParts.length; i++) {
            const ep = encodedParts[i];
            let d = decoded[i];
            if (d.code !== ep.rows || d.adler !== ep.adler) {
                e2eOk = false;
                e2eDetail = `part ${i}: code=${d.code}/${ep.rows} adler=${d.adler}/${ep.adler}`;
                break;
            }
            combinedAdler = png.adlerCombine(combinedAdler, d.adler, ep.raw);
            if (d.needsPrev) {
                const prevFromAbove = decoded[i - 1].prev.slice();
                d = px.pngPartFinish(inflatedLines[i], ep.rows, w, prevFromAbove, rtCanvas);
                decoded[i].prev = d.prev;
            }
            if (!d.opaque) allOpaque = false;
            assembled.set(d.out, ep.y0 * w * 4);
        }
        const allInflated = new Uint8Array(inflatedLines.reduce((n, b) => n + b.length, 0));
        let infOff = 0;
        for (const b of inflatedLines) { allInflated.set(b, infOff); infOff += b.length; }
        const wantWholeAdler = refAdler32(allInflated);
        const { out: wantAssembled, opaque: wantOpaque } = refApplyRt(src, rtCanvas);
        check(`${label} multi-part PNG round-trip through DecompressionStream("deflate-raw") + out-of-order pngPartDecode + pngPartFinish matches byte for byte and refAdler32`,
            e2eOk && combinedAdler === wantWholeAdler && allOpaque === wantOpaque && eqBytes(assembled, wantAssembled)
            && decoded[0].opaque === true && decoded[2].opaque === false,
            e2eDetail || firstDiff(assembled, wantAssembled));
    }

    // 5. Stop 2 Node/runtime native DecompressionStream("deflate-raw") refusal checks (exercises the runtime's native
    // stream on shared LZ77 window across sync flushes, corrupt deflate bytes, and truncated streams; reaches no K7 code
    // when DecompressionStream throws)
    if (label === "rust simd") {
        const w = 64, rowBytes = w * 4, stride = rowBytes + 1;
        // Craft a 2-part stream using Node's zlib with a SHARED LZ77 sliding window across Z_SYNC_FLUSH so part 1
        // references distances back in part 0 (before part 1's start):
        const pattern = new Uint8Array(4 * stride);
        for (let y = 0; y < 4; y++) {
            pattern[y * stride] = 0;
            for (let i = 1; i < stride; i++) pattern[y * stride + i] = ((i * 37 + y * 13) & 255);
        }
        const def = zlib.createDeflateRaw({ level: 6 });
        const chunks = [];
        def.on("data", (c) => chunks.push(c));
        await new Promise((resolve) => {
            def.write(pattern);
            def.flush(zlib.constants.Z_SYNC_FLUSH, resolve);
        });
        const part0Len = Buffer.concat(chunks).length;
        await new Promise((resolve) => {
            def.end(pattern, resolve); // identical bytes -> LZ77 back-reference into part 0!
        });
        const sharedPart1 = new Uint8Array(Buffer.concat(chunks).subarray(part0Len));
        let sharedRejected = false;
        try {
            await inflateRawPart(sharedPart1, true);
        } catch {
            sharedRejected = true;
        }
        let corruptRejected = false;
        try {
            await inflateRawPart(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x01]), false);
        } catch {
            corruptRejected = true;
        }
        // Truncated valid stream: DecompressionStream throws before reaching K7
        const validPart = px.pngPart(randomRGBA(w, 4, 9500), w, 4, null, 2, false);
        let truncRefused = false;
        try {
            const lines = await inflateRawPart(validPart.bytes.subarray(0, Math.floor(validPart.bytes.length / 2)), false);
            if (px.pngPartDecode(lines, w, new Uint8Array(rowBytes)).code < 0) truncRefused = true;
        } catch {
            truncRefused = true;
        }
        check(`Node/runtime native DecompressionStream("deflate-raw") refuses a part referencing before its start, corrupt deflate bytes, and truncated parts`,
            sharedRejected && corruptRejected && truncRefused,
            `shared=${sharedRejected} corrupt=${corruptRejected} trunc=${truncRefused}`);

        // 6. Resident rt table check (_resident copies 64 KB on the first call, 0 B on subsequent calls) + kernels.js switching
        const P = await import(pathToFileURL(path.join(PX_DIR, "px.js")).href);
        const K = await import(pathToFileURL(path.join(PX_DIR, "kernels.js")).href);
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (u, ...rest) => {
            const s = String(u && u.href ? u.href : u);
            return s.startsWith("file:") ? new Response(fs.readFileSync(fileURLToPath(s))) : realFetch(u, ...rest);
        };
        try { await K.kernelsReady(); } finally { globalThis.fetch = realFetch; }

        const freshRt = rtCanvas.slice();
        const oneLine = new Uint8Array(stride);
        const wasTimed = P.pxTimed(true);
        let bytes1 = 0, bytes2 = 0;
        try {
            P.pxCalls(true);
            px.pngPartDecode(oneLine, w, new Uint8Array(rowBytes), freshRt);
            bytes1 = Math.round(P.pxLaps().copyInMB * 1048576);
            P.pxCalls(true);
            px.pngPartDecode(oneLine, w, new Uint8Array(rowBytes), freshRt);
            bytes2 = Math.round(P.pxLaps().copyInMB * 1048576);
        } finally {
            P.pxTimed(wasTimed);
        }
        const expectedLineIn = stride + rowBytes;
        check(`px.js keeps the 64 KB round-trip table resident in wasm memory (copied on first call, 0 B on subsequent calls)`,
            bytes1 === expectedLineIn + 65536 && bytes2 === expectedLineIn,
            `first bytesIn=${bytes1}, second bytesIn=${bytes2}`);

        const prevMode = K.kernelsMode();
        K.setKernels("rust");
        try {
            P.pxCalls(true);
            const capRust = K.pngPartLinesCap(15000);
            const testLines = new Uint8Array(2 * stride);
            testLines[0] = 2;
            const dRust = K.pngPartDecode(testLines, w, null, rtCanvas);
            const fRust = K.pngPartFinish(testLines, 2, w, new Uint8Array(rowBytes), rtCanvas);
            const callsRust = P.pxCalls();
            K.setKernels("js");
            P.pxCalls(true);
            const capJs = K.pngPartLinesCap(15000);
            const dJs = K.pngPartDecode(testLines, w, null, rtCanvas);
            const fJs = K.pngPartFinish(testLines, 2, w, new Uint8Array(rowBytes), rtCanvas);
            const callsJs = P.pxCalls();
            check(`kernels.js switches pngPartLinesCap, pngPartDecode, and pngPartFinish between Rust and the JS twin`,
                capRust === js.pngPartLinesCap(15000) && capJs === capRust
                && callsRust.png_part_decode === 1 && callsRust.png_part_finish === 1
                && !callsJs.png_part_decode && !callsJs.png_part_finish
                && dRust.needsPrev === true && dJs.needsPrev === true && eqBytes(fRust.out, fJs.out));
        } finally {
            kernelsBack(K);
            K.setKernels(prevMode);
        }

        // 7. PX_BENCH: 15,000 x 139 standard 8 MB part (copyIn vs decode vs copyOut)
        if (process.env.PX_BENCH) {
            const bw = 15000, brows = 139, browBytes = bw * 4;
            const bsrc = randomRGBA(bw, brows, 9701, { opaque: false });
            const bprev = randomRGBA(bw, 1, 9702, { opaque: false });
            const blinesSub = buildLines(bsrc, bw, brows, bprev, 1, (y) => (y % 4) + 1);
            const blinesPaeth = buildLines(bsrc, bw, brows, bprev, 4, () => 4);
            const bout = new Uint8Array(brows * browBytes);
            const pWork = bprev.slice();
            // Warm up resident rtCanvas
            px.pngPartDecode(blinesSub.subarray(0, browBytes + 1), bw, pWork, rtCanvas);
            const laps = { copyIn: 0, decode: 0, copyOut: 0 };
            const rounds = 15;
            const simdTimes = [], twinTimes = [];
            const copyInTimes = [], decodeTimes = [], copyOutTimes = [];
            for (let i = 0; i < rounds; i++) {
                const l = { copyIn: 0, decode: 0, copyOut: 0 };
                const t0 = performance.now();
                px.pngPartDecode(blinesSub, bw, pWork, rtCanvas, bout, l);
                simdTimes.push(performance.now() - t0);
                copyInTimes.push(l.copyIn);
                decodeTimes.push(l.decode);
                copyOutTimes.push(l.copyOut);
                const t1 = performance.now();
                js.pngPartDecode(blinesSub, bw, pWork, rtCanvas, bout);
                twinTimes.push(performance.now() - t1);
            }
            const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[s.length >> 1]; };
            console.log(`       png_part_decode 15000x139 (8.34 MB, with rt): rust simd ${med(simdTimes).toFixed(2)} ms (copyIn ${med(copyInTimes).toFixed(2)} ms, decode ${med(decodeTimes).toFixed(2)} ms, copyOut ${med(copyOutTimes).toFixed(2)} ms), twin ${med(twinTimes).toFixed(2)} ms`);
            const defPartTimes = [], finPartTimes = [], twinDefFinTimes = [];
            for (let i = 0; i < rounds; i++) {
                const l1 = { copyIn: 0, decode: 0, copyOut: 0 }, l2 = { copyIn: 0, decode: 0, copyOut: 0 };
                const t0 = performance.now();
                px.pngPartDecode(blinesPaeth, bw, null, rtCanvas, bout, l1);
                defPartTimes.push(performance.now() - t0);
                const t1 = performance.now();
                px.pngPartFinish(blinesPaeth, brows, bw, pWork, rtCanvas, bout, l2);
                finPartTimes.push(performance.now() - t1);
                const t2 = performance.now();
                js.pngPartDecode(blinesPaeth, bw, null, rtCanvas, bout);
                js.pngPartFinish(blinesPaeth, brows, bw, pWork, rtCanvas, bout);
                twinDefFinTimes.push(performance.now() - t2);
            }
            console.log(`       png_part_decode(needsPrev)+finish 15000x139 (Paeth, with rt): decode ${med(defPartTimes).toFixed(2)} ms + finish ${med(finPartTimes).toFixed(2)} ms = ${(med(defPartTimes) + med(finPartTimes)).toFixed(2)} ms, twin ${med(twinDefFinTimes).toFixed(2)} ms`);
        }
    }
}

// K3 (docs/PLAN_WASM_BUILD.md §3.3, §4.2): slice-by-16 crc32, png_chunk_frame, crc32Combine, PngStreamWriter's
// combined CRC and OraBandWriter._add(name, blob, crc).
async function crcAndFrameCases(px, label, png, zlib, js) {
    const empty = new Uint8Array(0);
    const vec123 = new Uint8Array(Buffer.from("123456789"));
    check(`${label} crc32 standard vectors ("" -> 00000000, "123456789" -> CBF43926) and null/zero continuation`,
        px.crc32(empty, 0) === 0 && js.crc32(empty, 0) === 0
        && px.crc32(vec123, 0) === 0xCBF43926 && js.crc32(vec123, 0) === 0xCBF43926
        && (px.exports.crc32(0, 0, 0xCBF43926) >>> 0) === 0xCBF43926
        && px.crc32(empty, 0xCBF43926) === 0xCBF43926 && js.crc32(empty, 0xCBF43926) === 0xCBF43926);

    // Every length 0..67 (0..4 whole 16-byte blocks and every 0..15 remainder), larger sizes, all 256 byte values in
    // every lane 0..15 and tail, and non-zero start values against the twin and Node's zlib.crc32.
    const crcLens = [...Array.from({ length: 68 }, (_, i) => i), 128, 255, 256, 257, 1024, 4099, 65537];
    const starts = [0, 1, 0xCBF43926, 0x12345678, 0x80000000, 0xFFFFFFFF];
    const crcCases = [];
    let zlibOk = true, zlibDetail = "";
    for (const n of crcLens) {
        const b = new Uint8Array(n);
        for (let i = 0; i < n; i++) b[i] = (i * 73 + n * 19 + 11) & 255;
        for (const st of n <= 33 ? starts : [0, 0xCBF43926]) {
            crcCases.push({ tag: `len ${n} start 0x${st.toString(16)}`, args: [b, st] });
            const got = js.crc32(b, st), want = zlib.crc32(b, st) >>> 0;
            if (zlibOk && got !== want) { zlibOk = false; zlibDetail = `len ${n} start 0x${st.toString(16)}: ${got} vs ${want}`; }
        }
    }
    // Every byte value 0..255 at each of the 16 slice positions and in the remainder
    for (let lane = 0; lane < 17; lane++) {
        const b = new Uint8Array(256 * (lane < 16 ? 16 : 1) + (lane === 16 ? 7 : 0));
        for (let v = 0; v < 256; v++) {
            if (lane < 16) b[v * 16 + lane] = v;
            else b[v] = v;
        }
        crcCases.push({ tag: `all 256 byte values at lane ${lane}`, args: [b, lane * 0x11111111] });
    }
    check(`${label} js crc32 equals Node's zlib.crc32 (${crcCases.length} cases)`, zlibOk, zlibDetail);
    twinCheck({
        name: "crc32", builds: [[label, px]], twin: js,
        call: (k, [b, st]) => k.crc32(b, st),
        cases: crcCases,
    });

    // Continuation across every split point of small and multi-block buffers, plus multi-part splits
    let contOk = true, contDetail = "";
    for (const n of [0, 1, 7, 15, 16, 17, 31, 32, 33, 64, 257, 4099]) {
        const buf = new Uint8Array(n);
        for (let i = 0; i < n; i++) buf[i] = (i * 131 + n * 7 + 3) & 255;
        const whole = px.crc32(buf, 0);
        const step = n <= 33 ? 1 : Math.floor(n / 19);
        for (let split = 0; split <= n; split += step) {
            const c1 = px.crc32(buf.subarray(0, split), 0);
            const c2 = px.crc32(buf.subarray(split), c1);
            if (c2 !== whole) { contOk = false; contDetail = `n=${n} split=${split}: ${c2} vs ${whole}`; break; }
        }
        // 4-way split
        const p1 = Math.floor(n / 5), p2 = Math.floor((2 * n) / 5), p3 = Math.floor((4 * n) / 5);
        let c = 0;
        for (const [s, e] of [[0, p1], [p1, p2], [p2, p3], [p3, n]]) c = px.crc32(buf.subarray(s, e), c);
        if (c !== whole) { contOk = false; contDetail = `n=${n} 4-way: ${c} vs ${whole}`; }
        if (!contOk) break;
    }
    check(`${label} crc32 continuation across splits equals one call`, contOk, contDetail);

    // crc32Combine: zero/negative lengths, empty left/right, every length 0..260, powers of two, and multi-part chains
    let combOk = true, combDetail = "";
    if (png.crc32Combine(0xCBF43926, 0, 0) !== 0xCBF43926
        || png.crc32Combine(0xCBF43926, 0xDEADBEEF, 0) !== 0xCBF43926
        || png.crc32Combine(0xCBF43926, 0xDEADBEEF, -7) !== 0xCBF43926
        || png.crc32Combine(0, 0xCBF43926, 9) !== 0xCBF43926) {
        combOk = false; combDetail = "zero/empty edge case failed";
    }
    const combBuf = new Uint8Array(70000);
    for (let i = 0; i < combBuf.length; i++) combBuf[i] = (i * 53 + (i >>> 7) * 19 + 5) & 255;
    const bigZero = new Uint8Array((1 << 24) + 1024);
    bigZero.set(combBuf.subarray(0, 1024), 0);
    const combSplits = [
        ...Array.from({ length: 261 }, (_, i) => [37, i]),
        ...[
            1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 4096, 16384, 32768, 65536,
            1 << 17, 1 << 18, 1 << 19, 1 << 20, 1 << 21, 1 << 22, 7_700_000, 1 << 23, 1 << 24,
        ].map((l2) => [113, l2]),
        [0, 0], [0, 1], [0, 257], [257, 0],
    ];
    for (const [l1, l2] of combSplits) {
        const src = l1 + l2 <= combBuf.length ? combBuf : bigZero;
        const a = src.subarray(0, l1), b = src.subarray(l1, l1 + l2);
        const want = zlib.crc32(src.subarray(0, l1 + l2)) >>> 0;
        const got = png.crc32Combine(px.crc32(a, 0), l2 <= combBuf.length ? px.crc32(b, 0) : zlib.crc32(b) >>> 0, l2);
        if (got !== want) { combOk = false; combDetail = `l1=${l1} l2=${l2}: ${got} vs ${want}`; break; }
    }
    check(`${label} crc32Combine (zero lengths, powers of 2 up to 16 MB, ~7.7 MB, 0..260 B) equals zlib.crc32 of the concatenation`, combOk, combDetail);

    // png_chunk_frame against twin and against png.pngChunk
    const chunkTypes = ["IHDR", "IDAT", "IEND", "tEXt", "sRGB", "gAMA"];
    const chunkLens = [0, 1, 2, 4, 13, 15, 16, 17, 31, 32, 33, 64, 257, 4099];
    const frameCases = [];
    let vsPngChunkOk = true, vsPngChunkDetail = "";
    for (const type of chunkTypes) {
        const kind = ((type.charCodeAt(0) << 24) | (type.charCodeAt(1) << 16) | (type.charCodeAt(2) << 8) | type.charCodeAt(3)) >>> 0;
        for (const n of chunkLens) {
            const payload = combBuf.subarray(0, n);
            const buf = new Uint8Array(n + 12);
            buf.fill(0xA5);
            buf.set(payload, 8);
            frameCases.push({ tag: `${type} ${n} B`, args: [buf, n, kind] });
            const wantChunk = png.pngChunk(type, payload);
            const wantCrc = new DataView(wantChunk.buffer, wantChunk.byteOffset + 8 + n, 4).getUint32(0);
            const testBuf = buf.slice();
            const gotCrc = px.pngChunkFrame(testBuf, n, kind);
            if (vsPngChunkOk && (gotCrc !== wantCrc || !eqBytes(testBuf, wantChunk))) {
                vsPngChunkOk = false;
                vsPngChunkDetail = `${type} ${n} B: crc ${gotCrc} vs ${wantCrc}, ${firstDiff(testBuf, wantChunk)}`;
            }
        }
    }
    if (px.exports.png_chunk_frame(0, 0, 0x49444154) !== 0) {
        vsPngChunkOk = false; vsPngChunkDetail = "null buf did not return 0";
    }
    check(`${label} png_chunk_frame equals inpaint_png.pngChunk byte for byte (${frameCases.length} cases)`, vsPngChunkOk, vsPngChunkDetail);
    twinCheck({
        name: "png_chunk_frame", builds: [[label, px]], twin: js,
        call: (k, [buf, n, kind]) => { const crc = k.pngChunkFrame(buf, n, kind); return { buf, crc }; },
        cases: frameCases,
    });

    // PngStreamWriter combined CRC, OraBandWriter without worker "crc" jobs for written PNGs, and inpaint_png.crc32 route
    if (label === "rust simd") {
        const bands = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_bands.js")).href);
        const K = await import(pathToFileURL(path.join(PX_DIR, "kernels.js")).href);
        const P = await import(pathToFileURL(path.join(PX_DIR, "px.js")).href);
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (u, ...rest) => {
            const s = String(u && u.href ? u.href : u);
            return s.startsWith("file:") ? new Response(fs.readFileSync(fileURLToPath(s))) : realFetch(u, ...rest);
        };
        try { await K.kernelsReady(); } finally { globalThis.fetch = realFetch; }
        K.setKernels("rust");

        // Route check on png.crc32: below 64 B stays in JS, from 64 B on runs Rust
        P.pxCalls(true);
        const cSmall = png.crc32(combBuf.subarray(0, 63));
        const smallCalls = P.pxCalls().crc32 || 0;
        const cLarge = png.crc32(combBuf.subarray(0, 64));
        const largeCalls = P.pxCalls().crc32 || 0;
        K.setRoute("crc32", "js");
        P.pxCalls(true);
        const cForcedJs = png.crc32(combBuf.subarray(0, 4096));
        const jsRouteCalls = P.pxCalls().crc32 || 0;
        K.setRoute("crc32", "rust");
        const cForcedRust = png.crc32(combBuf.subarray(0, 16));
        const rustRouteCalls = P.pxCalls().crc32 || 0;
        K.setRoute("crc32", null);
        check("inpaint_png.crc32 routes inputs from the cut-off (64 B) to Rust and smaller ones to the JS twin",
            smallCalls === 0 && largeCalls === 1 && jsRouteCalls === 0 && rustRouteCalls === 1
            && cSmall === js.crc32(combBuf.subarray(0, 63)) && cLarge === js.crc32(combBuf.subarray(0, 64))
            && cForcedJs === js.crc32(combBuf.subarray(0, 4096)) && cForcedRust === js.crc32(combBuf.subarray(0, 16)),
            `small=${smallCalls} large=${largeCalls} jsRoute=${jsRouteCalls} rustRoute=${rustRouteCalls}`);

        // OraBandWriter & PngStreamWriter: combined entry CRCs match the whole PNG files without "crc" worker jobs
        const W = 64, H = 20, layerRgba = randomRGBA(W, H, 501), mergedRgba = randomRGBA(W, H, 502);
        const makeSource = (rgba) => ({
            width: W, height: H, align: 8,
            async part(y, n) {
                const slice = rgba.slice(y * W * 4, (y + n) * W * 4);
                const prev = y > 0 ? rgba.slice((y - 1) * W * 4, y * W * 4) : null;
                return { args: { rgba: slice.buffer, prev: prev ? prev.buffer : null }, transfer: [] };
            },
        });
        let crcJobs = 0, partJobs = 0;
        const runJob = async (op, args) => {
            if (op === "png_part") {
                partJobs++;
                const r = px.pngPart(new Uint8Array(args.rgba), args.w, args.rows, args.prev ? new Uint8Array(args.prev) : null, args.level ?? 2, !!args.last);
                return { chunk: r.chunk.buffer, adler: r.adler, raw: r.raw, crc: r.crc };
            }
            if (op === "crc") {
                crcJobs++;
                const bytes = new Uint8Array(await args.blob.arrayBuffer());
                return { crc: png.crc32(bytes), size: bytes.length };
            }
            throw new Error("unexpected op " + op);
        };
        const thumbBytes = png.pngChunk("IEND", new Uint8Array(0));
        const thumbBlob = new Blob([thumbBytes], { type: "image/png" });
        const ora = new bands.OraBandWriter({ width: W, height: H, run: runJob });
        await ora.layer({ name: "L0", x: 0, y: 0, opacity: 1, visible: true, blend: "normal" }, makeSource(layerRgba));
        const oraBlob = await ora.finish(makeSource(mergedRgba), thumbBlob);
        const z = new Uint8Array(await oraBlob.arrayBuffer());
        const le32 = (o) => (z[o] | (z[o + 1] << 8) | (z[o + 2] << 16) | (z[o + 3] << 24)) >>> 0;
        const le16 = (o) => z[o] | (z[o + 1] << 8);
        const eo = z.length - 22, count = le16(eo + 10);
        let co = le32(eo + 16), zipOk = count === 5, zipDetail = "";
        for (let i = 0; i < count && zipOk; i++) {
            const crc = le32(co + 16), size = le32(co + 20), nl = le16(co + 28), lo = le32(co + 42);
            const name = new TextDecoder().decode(z.subarray(co + 46, co + 46 + nl));
            const localCrc = le32(lo + 14);
            const data = z.subarray(lo + 30 + le16(lo + 26) + le16(lo + 28), lo + 30 + le16(lo + 26) + le16(lo + 28) + size);
            const want = px.crc32(data, 0);
            if (crc !== want || localCrc !== want) {
                zipOk = false;
                zipDetail = `${name}: header crc 0x${crc.toString(16)} / local 0x${localCrc.toString(16)} vs 0x${want.toString(16)}`;
            }
            co += 46 + nl;
        }
        check("OraBandWriter combines layer and merged PNG CRCs from their parts (1 crc job for thumbnail only, all 5 zip entry CRCs exact)",
            zipOk && crcJobs === 1 && partJobs >= 2, zipDetail || `crcJobs=${crcJobs}, partJobs=${partJobs}`);

        if (process.env.PX_BENCH) {
            const buf64m = new Uint8Array(64 * 1048576);
            for (let i = 0; i < buf64m.length; i += 4096) buf64m[i] = (i >>> 12) & 255;
            const t = benchMedians([
                ["simd", () => px.crc32(buf64m, 0)],
                ["js", () => js.crc32(buf64m, 0)],
            ], 3);
            console.log(`       crc32 64 MB: rust ${(t.simd / 64).toFixed(3)} ms/MB (${t.simd.toFixed(1)} ms), twin ${(t.js / 64).toFixed(3)} ms/MB (${t.js.toFixed(1)} ms), ${(t.js / t.simd).toFixed(2)}x`);
        }
    }
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

// K10b (docs/PLAN_WASM_K10.md §5, §9.1): tile gather (tilesRowsToWasm), store/stack gather (storeRowsToWasm,
// stackRowsToWasm, partPtrOf) and pngPartFromPtr against rowsOfTiles, storeRows, rowsOfStack and Px.pngPart on both
// SIMD and scalar builds, plus route overrides (composeTiles, composeStack) and trap/OOM fallback in worker pngPart.
async function composeWasmPartCases(px, label, png, zlib) {
    const P = await import(pathToFileURL(path.join(PX_DIR, "px.js")).href);
    const K = await import(pathToFileURL(path.join(PX_DIR, "kernels.js")).href);
    const W = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_worker.js")).href);
    const bands = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_bands.js")).href);
    const { hash32 } = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "blend_modes.js")).href);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u, ...rest) => {
        const s = String(u && u.href ? u.href : u);
        return s.startsWith("file:") ? new Response(fs.readFileSync(fileURLToPath(s))) : realFetch(u, ...rest);
    };
    try { await K.kernelsReady(); } finally { globalThis.fetch = realFetch; }
    K.setKernels("rust");

    const TILE = 256, TILE_BYTES = TILE * TILE * 4;
    const makeTile = (seed, fn = null) => {
        const u8 = new Uint8Array(TILE_BYTES);
        const r = rng(seed);
        for (let y = 0; y < TILE; y++) {
            for (let x = 0; x < TILE; x++) {
                const o = (y * TILE + x) * 4;
                if (fn) {
                    fn(u8, o, x, y, r);
                } else {
                    u8[o] = ((r() * 256) | 0) ^ ((y * 7 + x) & 255);
                    u8[o + 1] = ((r() * 256) | 0) ^ ((y * 13 + x * 3) & 255);
                    u8[o + 2] = ((r() * 256) | 0) ^ ((y * 29 + x * 5) & 255);
                    u8[o + 3] = (r() * 256) | 0;
                }
            }
        }
        return { data: u8.buffer };
    };

    const runPtrPngPart = (msg) => {
        const a = px.job;
        try {
            const laps = {};
            const ptrs = W.partPtrOf(px, a, msg, true);
            const r = px.pngPartFromPtr(a, ptrs.pr, msg.w, msg.rows, ptrs.pp, msg.level ?? 2, !!msg.last, laps);
            return { ...r, laps };
        } finally {
            px._reset(a);
        }
    };
    const runJsPngPart = (msg) => {
        const rgba = msg.rgba ? new Uint8Array(msg.rgba, 0, msg.w * msg.rows * 4) : msg.stack ? W.rowsOfStack(msg, false) : W.rowsOfTiles(msg, false);
        const prev = msg.rgba ? (msg.prev ? new Uint8Array(msg.prev, 0, msg.w * 4) : null) : msg.stack ? W.rowsOfStack(msg, true) : W.rowsOfTiles(msg, true);
        return px.pngPart(rgba, msg.w, msg.rows, prev, msg.level ?? 2, !!msg.last);
    };
    const samePngPart = (a, b) => a.adler === b.adler && a.raw === b.raw && a.crc === b.crc && eqBytes(a.bytes, b.bytes) && eqBytes(a.chunk, b.chunk);

    // 1. Tile gather (tilesRowsToWasm + pngPartFromPtr vs rowsOfTiles + Px.pngPart) via tileRows(snap, true).part(y, n, true)
    {
        const w = 300, h = 350;
        const row0 = [makeTile(101), null];   // sparse null tile in column 1 of row 0
        const row1 = [makeTile(103), makeTile(102)];
        // Make row 255 of row0[0] match row 0 of row1[0] (and differ from row 0 of row0[0]) so prevTiles r0 = TILE - 1
        // makes Up filter win on y = 256 and directly kills a prevTiles r0 = 0 mutant on both SIMD and scalar
        const r0u8 = new Uint8Array(row0[0].data);
        const r1u8 = new Uint8Array(row1[0].data);
        for (let i = 0; i < TILE * 4; i++) {
            r0u8[i] = (i * 3 + 17) & 255;
            const v = (255 - ((i * 7 + 53) & 255)) & 255;
            r0u8[(TILE - 1) * TILE * 4 + i] = v;
            r1u8[i] = v;
        }
        const snap = {
            width: w,
            height: h,
            tileRowNames: (ty) => (ty === 0 ? row0 : ty === 1 ? row1 : [null, null]),
        };
        const source = bands.tileRows(snap, true);
        // Parts covering: (a) ty === 0, r0 === 0, prevTiles: null; (b) mid-tile-row r0 > 0; (c) tile-row boundary ty === 1, r0 === 0 with prevTiles; (d) tail row
        const spans = [[0, 60], [60, 196], [256, 40], [296, 54]];
        let ok = true, detail = "";
        const ptrParts = [], fullRows = new Uint8Array(w * h * 4);
        P.pxTimed(true);
        P.pxCalls(true);
        try {
            for (let i = 0; i < spans.length; i++) {
                const [y, n] = spans[i];
                const { args } = await source.part(y, n, true);
                const msg = { ...args, w, rows: n, level: 2, last: i === spans.length - 1 };
                const got = runPtrPngPart(msg);
                const want = runJsPngPart(msg);
                ptrParts.push(got);
                fullRows.set(W.rowsOfTiles(msg, false), y * w * 4);
                const hasLaps = ["filter", "adler", "deflate", "chunk", "copyOut"].every((k) => typeof got.laps[k] === "number");
                if (!samePngPart(got, want) || !hasLaps) {
                    ok = false;
                    detail = `part ${i} (y=${y}, n=${n}): adler ${got.adler}/${want.adler} crc ${got.crc}/${want.crc} laps=${JSON.stringify(got.laps)} ${firstDiff(got.chunk, want.chunk)}`;
                    break;
                }
            }
            const laps = P.pxLaps();
            if (!(laps.copyIn > 0 && laps.copyOut > 0 && laps.copyInMB > 0 && laps.copyOutMB > 0)) {
                ok = false;
                detail = detail || `expected timed copyIn/copyOut laps, got ${JSON.stringify(laps)}`;
            }
        } finally {
            P.pxTimed(false);
        }
        if (ok) {
            let adler = 1;
            for (const p of ptrParts) adler = png.adlerCombine(adler, p.adler, p.raw);
            const tail = Buffer.from([adler >>> 24, (adler >>> 16) & 255, (adler >>> 8) & 255, adler & 255]);
            const stream = Buffer.concat([Buffer.from([0x78, 0x9C]), ...ptrParts.map((p) => Buffer.from(p.bytes)), tail]);
            const inflated = new Uint8Array(zlib.inflateSync(stream));
            const unfiltered = unfilter(inflated, w, h, null);
            if (!eqBytes(unfiltered, fullRows)) {
                ok = false;
                detail = detail || `joined stream unfilter diff: ${firstDiff(unfiltered, fullRows)}`;
            }
        }
        check(`${label} tilesRowsToWasm + pngPartFromPtr equals rowsOfTiles + pngPart across top row, mid-tile-row, tile-row boundary (prevTiles row 255) and sparse null tiles`, ok, detail);
    }

    // 2. Stack gather (stackRowsToWasm + pngPartFromPtr vs rowsOfStack + Px.pngPart)
    {
        const Wd = 320, Hd = 520;
        // Soft-alpha base with A = 10, A = 128, and non-zero RGB under A = 0 (detects unwanted begin/end premultiply round-trip)
        const baseT00 = makeTile(201, (u8, o, x, y, r) => {
            if ((x + y) % 5 === 0) {
                u8[o] = 123; u8[o + 1] = 45; u8[o + 2] = 67; u8[o + 3] = 0;
            } else if ((x + y) % 3 === 0) {
                u8[o] = 200; u8[o + 1] = 100; u8[o + 2] = 50; u8[o + 3] = 10;
            } else {
                u8[o] = (r() * 256) | 0; u8[o + 1] = (r() * 256) | 0; u8[o + 2] = (r() * 256) | 0; u8[o + 3] = 128;
            }
        });
        const baseT01 = makeTile(202);
        const baseT10 = makeTile(203);
        const baseT11 = makeTile(204);
        const baseStore = {
            x: 0, y: 0, w: Wd, h: Hd,
            tiles: { 0: [baseT00, baseT01], 1: [baseT10, baseT11], 2: [makeTile(205), null] },
        };

        const checkStackCase = (caseName, msg) => {
            const a = px.job;
            let gotBand, gotAbove, gotPart, wantBand, wantAbove, wantPart;
            // Dirty the arena's reusable first chunk and byte 0 of linear memory so any missing zero-fill (psrc, pm, pbm)
            // or missing null check on pbm = 0 immediately corrupts the output.
            const dirtyBytes = msg.w * msg.rows * 16;
            const dirtyPtr = a.take(dirtyBytes);
            px.u8().fill(0xDD, dirtyPtr, dirtyPtr + dirtyBytes);
            px._reset(a);
            const savedByte0 = px.u8()[0];
            px.u8()[0] = 7;
            try {
                const pd = W.stackRowsToWasm(px, a, msg, false, null);
                gotBand = px.u8().slice(pd, pd + msg.w * msg.rows * 4);
                const pp = (msg.y | 0) > 0 ? W.stackRowsToWasm(px, a, msg, true, null) : 0;
                gotAbove = pp ? px.u8().slice(pp, pp + msg.w * 4) : null;
            } finally {
                px.u8()[0] = savedByte0;
                px._reset(a);
            }
            wantBand = W.rowsOfStack(msg, false, null);
            wantAbove = W.rowsOfStack(msg, true, null);
            gotPart = runPtrPngPart(msg);
            wantPart = runJsPngPart(msg);
            const bandEq = eqBytes(gotBand, wantBand);
            const aboveEq = (gotAbove === null && wantAbove === null) || (!!gotAbove && !!wantAbove && eqBytes(gotAbove, wantAbove));
            const partEq = samePngPart(gotPart, wantPart);
            const ok = bandEq && aboveEq && partEq;
            const detail = ok ? "" : `${caseName}: band=${bandEq ? "ok" : firstDiff(gotBand, wantBand)} above=${aboveEq ? "ok" : firstDiff(gotAbove || new Uint8Array(0), wantAbove || new Uint8Array(0))} part=${partEq ? "ok" : firstDiff(gotPart.chunk, wantPart.chunk)}`;
            return { ok, detail };
        };

        // (2a) Empty layers: [] over soft-alpha / A=0 base
        const r2a = checkStackCase("2a empty layers", {
            w: Wd, rows: 48, y: 12, x0: 0, y0: 0, level: 2, last: true,
            stack: { base: baseStore, layers: [] },
        });
        check(`${label} stackRowsToWasm (2a): empty layers [] preserves soft-alpha and A=0 RGB base bytes verbatim`, r2a.ok, r2a.detail);

        // (2b) Layer present in stack.layers whose tiles do not overlap the band (storeRowsToWasm returns false -> continue)
        const emptyOverlapLayers = [
            { x: 0, y: 0, w: Wd, h: Hd, alpha: 200, op: 0, tiles: { 0: [null, null] } },
            { x: 260, y: 0, w: 60, h: Hd, alpha: 180, op: 5, tiles: { 0: [makeTile(210)] } },   // outside W=256 when X0=0
        ];
        const r2b = checkStackCase("2b non-overlapping layers", {
            w: 256, rows: 40, y: 10, x0: 0, y0: 0, level: 2, last: true,
            stack: { base: baseStore, layers: emptyOverlapLayers },
        });
        check(`${label} stackRowsToWasm (2b): layers with no tiles in the band are skipped without running composite_tile on the base`, r2b.ok, r2b.detail);

        // (2c) Layer starting at y = 256 (tiles only in ty = 1) and layer ending at y = 256 (tiles only in ty = 0), built via stackRows(w, h, stores).part(256, n, true)
        const makeSnapStore = (x, y, w, h, rowMap, extra = {}) => ({
            x, y, alpha: extra.alpha ?? 255, op: extra.op ?? 0,
            match: extra.match || null, dissolve: extra.dissolve ?? null,
            clip: extra.clip || null, mask: extra.mask || null,
            snap: { width: w, height: h, tileRowNames: (ty) => rowMap[ty] || [] },
        });
        const stores2c = [
            makeSnapStore(0, 0, Wd, Hd, baseStore.tiles),
            makeSnapStore(0, 0, Wd, Hd, { 0: [makeTile(221), makeTile(222)] }, { alpha: 190, op: 0 }),   // ends at y = 256 (only in above row 255!)
            makeSnapStore(0, 256, Wd, 256, { 0: [makeTile(223), makeTile(224)] }, { alpha: 210, op: 5 }), // starts at y = 256 (not in above row 255!)
        ];
        const sr2c = bands.stackRows(Wd, Hd, stores2c);
        const part2c = await sr2c.part(256, 32, true);
        const r2c = checkStackCase("2c part boundary y=256", { ...part2c.args, w: Wd, rows: 32, level: 2, last: false });
        check(`${label} stackRowsToWasm (2c): separate above pass at part boundary y=256 with layers starting and ending at 256`, r2c.ok, r2c.detail);

        // (2d) Offset and negative-offset layers (including an unmasked partial layer narrower than the band, and a layer
        // mask with a null tile and a missing tile row under existing layer pixels) and non-zero x0 (x0: 128)
        const maskTile1 = makeTile(231), maskTile2 = makeTile(232);
        const r2d = checkStackCase("2d offset layers, partial unmasked layer, and mask holes at x0=128", {
            w: 240, rows: 60, y: 120, x0: 128, y0: 0, level: 2, last: true,
            stack: {
                base: baseStore,
                layers: [
                    { x: 160, y: 130, w: 120, h: 35, alpha: 215, op: 0, tiles: { 0: [makeTile(238)] } },
                    { x: 300, y: 140, w: 200, h: 200, alpha: 220, op: 0, tiles: { 0: [makeTile(233)] }, mask: { 0: [maskTile1] } },
                    { x: -50, y: -30, w: 450, h: 300, alpha: 170, op: 6, tiles: { 0: [makeTile(234), makeTile(235)], 1: [makeTile(236), makeTile(237)] }, mask: { 0: [maskTile2, null] } },
                ],
            },
        });
        check(`${label} stackRowsToWasm (2d): positive/negative layer offsets, unmasked partial layer, and mask holes clip identically to storeRows`, r2d.ok, r2d.detail);

        // (2e) Color-matched layer (10 floats: meanS[3], meanT[3], scale[3], k) between other blend layers
        const matchFloats = [110.5, 95.2, 80.1, 130.0, 105.5, 90.0, 1.15, 0.92, 1.08, 0.85];
        const r2e = checkStackCase("2e color-matched layer", {
            w: Wd, rows: 40, y: 20, x0: 0, y0: 0, level: 2, last: false,
            stack: {
                base: baseStore,
                layers: [
                    { x: 0, y: 0, w: Wd, h: Hd, alpha: 200, op: 5, tiles: { 0: [makeTile(241), makeTile(242)] } },
                    { x: 16, y: 8, w: 256, h: 256, alpha: 230, op: 0, match: matchFloats, tiles: { 0: [makeTile(243)] }, mask: { 0: [maskTile1] } },
                    { x: 0, y: 0, w: Wd, h: Hd, alpha: 150, op: 7, tiles: { 0: [makeTile(244), makeTile(245)] } },
                ],
            },
        });
        check(`${label} stackRowsToWasm (2e): 10-float match_pixels layer between blend layers equals rowsOfStack`, r2e.ok, r2e.detail);

        // (2f) Two layers clipped to the same masked clip base (with A=0 holes, soft-alpha ramp, and a null-tile hole in
        // c.mask under existing clip base pixels), plus a layer clipped to an unmasked clip base (pbm = 0)
        const clipBaseTile = makeTile(251, (u8, o, x, y) => {
            u8[o] = 100; u8[o + 1] = 150; u8[o + 2] = 200;
            u8[o + 3] = (x + y) % 4 === 0 ? 0 : ((x * 7 + y * 13) & 255);
        });
        const clipBaseMaskTile = makeTile(252, (u8, o, x, y) => {
            u8[o + 3] = (x * 11 + y * 5) & 255;
        });
        const ownMaskA = makeTile(253, (u8, o, x, y) => { u8[o + 3] = (x * 3 + y * 17 + 40) & 255; });
        const ownMaskB = makeTile(254, (u8, o, x, y) => { u8[o + 3] = (255 - ((x * 9 + y * 7) & 255)) & 255; });
        const sharedClip = {
            x: 10, y: 5, w: 512, h: 256, alpha: 185,
            tiles: { 0: [clipBaseTile, makeTile(257)] },
            mask: { 0: [clipBaseMaskTile, null] },
        };
        const unmaskedClip = {
            x: 6, y: 4, w: 256, h: 256, alpha: 195,
            tiles: { 0: [clipBaseTile] },
        };
        const r2f = checkStackCase("2f clipped layers (masked base with hole + unmasked base)", {
            w: 320, rows: 48, y: 12, x0: 0, y0: 0, level: 2, last: true,
            stack: {
                base: baseStore,
                layers: [
                    { x: 0, y: 0, w: 512, h: 256, alpha: 240, op: 0, tiles: { 0: [makeTile(255), makeTile(258)] }, mask: { 0: [ownMaskA, null] }, clip: sharedClip },
                    { x: 0, y: 0, w: 512, h: 256, alpha: 210, op: 5, tiles: { 0: [makeTile(256), makeTile(259)] }, mask: { 0: [null, ownMaskB] }, clip: sharedClip },
                    { x: 0, y: 0, w: 256, h: 256, alpha: 225, op: 0, tiles: { 0: [makeTile(260)] }, mask: { 0: [ownMaskA] }, clip: unmaskedClip },
                ],
            },
        });
        check(`${label} stackRowsToWasm (2f): two clipped layers over a masked clip base (with c.mask hole) and a clipped layer over an unmasked clip base (pbm=0)`, r2f.ok, r2f.detail);

        // (2g) Dissolve layer at y = 16 > 0 (so the above pass at y = 15 is non-null and compared directly) including
        // partial coverage (0 < cVal < 255) and opaque cVal === 255 where (hash32 >>> 24) === 255
        const dissolveSeed = 0x13579BDF;
        let hitHash255 = false;
        const dissolveTile = makeTile(261, (u8, o, x, y) => {
            u8[o] = (x * 19 + 33) & 255;
            u8[o + 1] = (y * 23 + 77) & 255;
            u8[o + 2] = ((x + y) * 11) & 255;
            const top = hash32(x, y, dissolveSeed) >>> 24;
            if (top === 255 && y >= 15 && y < 64) {
                hitHash255 = true;
                u8[o + 3] = 255;   // cVal === 255 at a coordinate inside y = 15..63 where top hash byte is 255
            } else if ((x + y) % 7 === 0) {
                u8[o + 3] = 0;
            } else {
                u8[o + 3] = 1 + ((x * 5 + y * 9) % 254);
            }
        });
        const r2gOpaque = checkStackCase("2g dissolve opaque + partial at y=16", {
            w: 256, rows: 48, y: 16, x0: 0, y0: 0, level: 2, last: true,
            stack: {
                base: baseStore,
                layers: [
                    { x: 0, y: 0, w: 256, h: 256, alpha: 255, op: 0, dissolve: dissolveSeed, tiles: { 0: [dissolveTile] } },
                    { x: 0, y: 0, w: 256, h: 256, alpha: 180, op: 0, dissolve: dissolveSeed ^ 0x55AA55AA, tiles: { 0: [makeTile(262)] }, mask: { 0: [ownMaskA] } },
                ],
            },
        });
        check(`${label} stackRowsToWasm (2g): dissolve layer at y=16 (above row 15, partial and cVal=255 at hash32>>>24 === 255) equals rowsOfStack`, hitHash255 && r2gOpaque.ok, r2gOpaque.detail || `hitHash255=${hitHash255}`);

        // (2h) Fresh-instance memory.grow test at y = 12 > 0: > 2 MiB multi-layer band grows freshPx.memory.buffer and stays byte-identical on both band and above row
        const freshPx = new P.Px(new WebAssembly.Instance(px.module, {}), px.module);
        const buf0 = freshPx.memory.buffer;
        const growMsg = {
            w: 512, rows: 244, y: 12, x0: 0, y0: 0,
            stack: {
                base: { x: 0, y: 0, w: 512, h: 256, tiles: { 0: [makeTile(271), makeTile(272)] } },
                layers: [
                    { x: 0, y: 0, w: 512, h: 256, alpha: 220, op: 0, tiles: { 0: [makeTile(273), makeTile(274)] }, mask: { 0: [ownMaskA, ownMaskB] } },
                    { x: 0, y: 0, w: 512, h: 256, alpha: 190, op: 5, match: matchFloats, tiles: { 0: [makeTile(275), makeTile(276)] }, clip: sharedClip },
                    { x: 0, y: 0, w: 512, h: 256, alpha: 160, op: 6, dissolve: dissolveSeed, tiles: { 0: [makeTile(277), makeTile(278)] } },
                ],
            },
        };
        const fa = freshPx.job;
        let freshOut, freshAbove;
        try {
            const pd = W.stackRowsToWasm(freshPx, fa, growMsg, false, null);
            freshOut = freshPx.u8().slice(pd, pd + 512 * 244 * 4);
            const pp = W.stackRowsToWasm(freshPx, fa, growMsg, true, null);
            freshAbove = freshPx.u8().slice(pp, pp + 512 * 4);
        } finally {
            freshPx._reset(fa);
        }
        const grew = freshPx.memory.buffer !== buf0;
        const wantGrow = W.rowsOfStack(growMsg, false, null);
        const wantGrowAbove = W.rowsOfStack(growMsg, true, null);
        check(`${label} stackRowsToWasm (2h): fresh instance grows memory.buffer mid-job and produces identical band and above-row bytes to rowsOfStack`,
            grew && eqBytes(freshOut, wantGrow) && eqBytes(freshAbove, wantGrowAbove),
            `grew=${grew} band=${firstDiff(freshOut, wantGrow)} above=${firstDiff(freshAbove, wantGrowAbove)}`);
    }

    // 3. Route overrides (composeTiles, composeStack), arena reset & releaseMB, and gather/kernel trap/OOM fallback in worker pngPart(msg)
    if (label === "rust simd") {
        const tileMsg = {
            w: 256, rows: 32, r0: 0, level: 2, last: true,
            tiles: [makeTile(301)], prevTiles: [makeTile(302)],
        };
        const stackMsg = {
            w: 256, rows: 32, y: 16, x0: 0, y0: 0, level: 2, last: true,
            stack: {
                base: { x: 0, y: 0, w: 256, h: 256, tiles: { 0: [makeTile(303)] } },
                layers: [{ x: 0, y: 0, w: 256, h: 256, alpha: 200, op: 5, tiles: { 0: [makeTile(304)] } }],
            },
        };
        try {
            const tRust = await W.pngPart(tileMsg);
            const afterTileJobBytes = K.rustPx().job.jobBytes;
            const afterTileChunks = K.rustPx().job.chunks.length;

            const sRust = await W.pngPart(stackMsg);
            const afterStack1JobBytes = K.rustPx().job.jobBytes;
            const afterStack1Chunks = K.rustPx().job.chunks.length;
            const memAfter1 = K.rustPx().memory.buffer.byteLength;
            const chunkBytesAfter1 = K.rustPx().job.chunks[0] ? K.rustPx().job.chunks[0].bytes : 0;
            for (let rep = 0; rep < 3; rep++) await W.pngPart(stackMsg);
            const afterStack4JobBytes = K.rustPx().job.jobBytes;
            const afterStack4Chunks = K.rustPx().job.chunks.length;
            const memAfter4 = K.rustPx().memory.buffer.byteLength;
            const chunkBytesAfter4 = K.rustPx().job.chunks[0] ? K.rustPx().job.chunks[0].bytes : 0;

            let rel0, rel1;
            K.setRoute("releaseMB", 0);
            try {
                rel0 = K.pxInstances().release;
                await W.pngPart(stackMsg);
                rel1 = K.pxInstances().release;
            } finally {
                K.setRoute("releaseMB", null);
            }
            const resetAndReleaseOk = afterTileJobBytes === 0 && afterTileChunks === 1
                && afterStack1JobBytes === 0 && afterStack1Chunks === 1
                && afterStack4JobBytes === 0 && afterStack4Chunks === 1
                && memAfter4 === memAfter1 && chunkBytesAfter4 === chunkBytesAfter1
                && rel1 === rel0 + 1;
            check("inpaint_worker.js pngPart resets p.job after every part (jobBytes=0, 1 chunk, stable memory across repeated parts) and calls releaseIfLarge()",
                resetAndReleaseOk,
                `jobBytes=${afterTileJobBytes}/${afterStack1JobBytes}/${afterStack4JobBytes} chunks=${afterTileChunks}/${afterStack1Chunks}/${afterStack4Chunks} mem=${memAfter1}->${memAfter4} rel=${rel0}->${rel1}`);

            K.setRoute("composeTiles", "js");
            const tJs = await W.pngPart(tileMsg);
            K.setRoute("composeTiles", null);

            K.setRoute("composeStack", "js");
            const sJs = await W.pngPart(stackMsg);
            K.setRoute("composeStack", null);

            const routeOk = tRust.timing.composeWasm === 1 && tJs.timing.composeWasm === 0
                && sRust.timing.composeWasm === 1 && sJs.timing.composeWasm === 0
                && tRust.adler === tJs.adler && tRust.crc === tJs.crc && eqBytes(new Uint8Array(tRust.chunk), new Uint8Array(tJs.chunk))
                && sRust.adler === sJs.adler && sRust.crc === sJs.crc && eqBytes(new Uint8Array(sRust.chunk), new Uint8Array(sJs.chunk));
            check("inpaint_worker.js pngPart under composeTiles and composeStack routes: composeWasm=1 on rust, composeWasm=0 on js, identical IDAT chunks",
                routeOk, `tRust=${tRust.timing.composeWasm} tJs=${tJs.timing.composeWasm} sRust=${sRust.timing.composeWasm} sJs=${sJs.timing.composeWasm}`);

            // Simulated OOM and trap both inside the gather (p0.job.take) and inside pngPartFromPtr: recovered() replaces
            // the instance and falls back to p.pngPart
            const realWarn = console.warn;
            console.warn = () => {};
            try {
                let p0 = K.rustPx(), i0 = K.pxInstances();
                p0.job.take = () => { throw new P.PxOutOfMemory(1024); };
                const gOom = await W.pngPart(stackMsg);
                let i1 = K.pxInstances();
                const gatherOomOk = gOom.timing.composeWasm === 0 && K.rustPx() !== p0 && i1.oom === i0.oom + 1
                    && eqBytes(new Uint8Array(gOom.chunk), new Uint8Array(sRust.chunk));

                p0 = K.rustPx(); i0 = K.pxInstances();
                p0.job.take = () => trapIn(p0);
                const gTrap = await W.pngPart(stackMsg);
                i1 = K.pxInstances();
                const gatherTrapOk = gTrap.timing.composeWasm === 0 && K.rustPx() !== p0 && i1.trap === i0.trap + 1
                    && eqBytes(new Uint8Array(gTrap.chunk), new Uint8Array(sRust.chunk));

                p0 = K.rustPx(); i0 = K.pxInstances();
                p0.pngPartFromPtr = () => { throw new P.PxOutOfMemory(1024); };
                const sOom = await W.pngPart(stackMsg);
                i1 = K.pxInstances();
                const oomOk = sOom.timing.composeWasm === 0 && K.rustPx() !== p0 && i1.oom === i0.oom + 1
                    && eqBytes(new Uint8Array(sOom.chunk), new Uint8Array(sRust.chunk));

                p0 = K.rustPx(); i0 = K.pxInstances();
                p0.pngPartFromPtr = function () { return trapIn(this); };
                const tTrap = await W.pngPart(tileMsg);
                i1 = K.pxInstances();
                const trapOk = tTrap.timing.composeWasm === 0 && K.rustPx() !== p0 && i1.trap === i0.trap + 1
                    && eqBytes(new Uint8Array(tTrap.chunk), new Uint8Array(tRust.chunk));

                check("inpaint_worker.js pngPart recovers from OOM and wasm trap in both partPtrOf (job.take) and pngPartFromPtr, renews the instance, and produces identical bytes via fallback",
                    gatherOomOk && gatherTrapOk && oomOk && trapOk,
                    `gatherOomOk=${gatherOomOk} gatherTrapOk=${gatherTrapOk} oomOk=${oomOk} trapOk=${trapOk}`);
            } finally {
                console.warn = realWarn;
            }
        } finally {
            K.setRoute("composeTiles", null);
            K.setRoute("composeStack", null);
        }
    }
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
    const cbRun = spawnSync(process.execPath, [path.join(ROOT, "tools", "combine_test.js")], { encoding: "utf-8" });
    const cbFail = ((cbRun.stdout || "") + (cbRun.stderr || "")).split(/\r?\n/).find((l) => /AssertionError|\[FAIL\]|^FAIL/.test(l));
    check("combine_test.js in js and rust modes", cbRun.status === 0 && !cbFail, cbFail || `rc=${cbRun.status}`);

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
    const workerMod = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_worker.js")).href);
    const { LUMA, opp, hexToRgb, u16Bilinear, rangeWeight, rangeTileClass, rangeRowBookkeeping, normalizeLimit, limitWeight } = weights;
    const { snapField, snapParams, SNAP_TAU } = edges;
    const { rangeSelectJob } = workerMod;

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

    // ---- K22: range_tiles_depth (docs/PLAN_WASM_BUILD.md §4.8) ----
    const refSnapField = (mapObj, guide, mx, my, pr, pg, pb, sigmaR, tau) => {
        const mdata = mapObj.data, w = mapObj.w, h = mapObj.h;
        const gdata = guide && (guide.data || guide);
        const gw = guide && guide.w != null ? guide.w : w;
        const gh = guide && guide.h != null ? guide.h : h;
        if (!(sigmaR > 0) || !gdata) return u16Bilinear(mdata, w, h, mx, my);
        const u = mx - 0.5, v = my - 0.5;
        const ix = Math.floor(u), iy = Math.floor(v);
        let lo = 65535, hi = 0;
        for (let dy = -1; dy <= 2; dy++) {
            const y = Math.max(0, Math.min(h - 1, iy + dy));
            const row = y * w;
            for (let dx = -1; dx <= 2; dx++) {
                const x = Math.max(0, Math.min(w - 1, ix + dx));
                const val = mdata[row + x];
                if (val < lo) lo = val;
                if (val > hi) hi = val;
            }
        }
        const range = hi / 65535 - lo / 65535;
        const k = tau >= 2 * tau ? (range >= 2 * tau ? 1 : 0) : range <= tau ? 0 : range >= 2 * tau ? 1 : (() => {
            const t = (range - tau) / tau;
            return t <= 1e-14 ? 0 : t >= 1 - 1e-14 ? 1 : t * t * (3 - 2 * t);
        })();
        if (k <= 0) return u16Bilinear(mdata, w, h, mx, my);
        const inv2SigmaR2 = 0.5 / (sigmaR * sigmaR);
        let num = 0, den = 0;
        for (let dy = -1; dy <= 2; dy++) {
            const ty = iy + dy, distY = v - ty, distY2 = distY * distY;
            const cy = Math.max(0, Math.min(h - 1, ty));
            const gy = Math.max(0, Math.min(gh - 1, ty));
            const mrow = cy * w, grow = gy * gw;
            for (let dx = -1; dx <= 2; dx++) {
                const tx = ix + dx, distX = u - tx;
                const distSpatial2 = distX * distX + distY2;
                const cx = Math.max(0, Math.min(w - 1, tx));
                const gx = Math.max(0, Math.min(gw - 1, tx));
                const gIdx = (grow + gx) * 4;
                const dr = pr - gdata[gIdx] / 255;
                const dg = pg - gdata[gIdx + 1] / 255;
                const db = pb - gdata[gIdx + 2] / 255;
                const distColor2 = dr * dr + dg * dg + db * db;
                const weight = js.libmExp(-0.5 * distSpatial2) * js.libmExp(-distColor2 * inv2SigmaR2);
                num += weight * (mdata[mrow + cx] / 65535);
                den += weight;
            }
        }
        const bil = u16Bilinear(mdata, w, h, mx, my);
        if (!(den > 1e-6)) return bil;
        return bil + k * (num / den - bil);
    };

    // Frozen table of cases generated from px.wasm's compiled libm::exp (including branch boundaries, subnormals,
    // overflows, underflows, and arguments where Electron 44's V8 15.2 Math.exp differs by 1 ulp).
    {
        const FROZEN_WASM_EXP_CASES = [
            ["0x0000000000000000", "0x3ff0000000000000"],
            ["0x8000000000000000", "0x3ff0000000000000"],
            ["0x3ff0000000000000", "0x4005bf0a8b14576a"],
            ["0xbff0000000000000", "0x3fd78b56362cef38"],
            ["0xbff8800000000000", "0x3fcbae93b5663054"],
            ["0xbfe0000000000000", "0x3fe368b2fc6f960a"],
            ["0x3fe0000000000000", "0x3ffa61298e1e069c"],
            ["0x3fd62e42fefa39ef", "0x3ff6a09e667f3bcc"],
            ["0xbfd62e42fefa39ef", "0x3fe6a09e667f3bcc"],
            ["0x3ff0a2b23f3bab73", "0x4006a09e667f3bcc"],
            ["0xbff0a2b23f3bab73", "0x3fd6a09e667f3bcd"],
            ["0x3e112e0be826d695", "0x3ff000000044b830"],
            ["0xbe112e0be826d695", "0x3fefffffff768fa1"],
            ["0x3cd203af9ee75616", "0x3ff0000000000005"],
            ["0xbcd203af9ee75616", "0x3feffffffffffff7"],
            ["0x4086280000000000", "0x7fdd422d2be5dc9b"],
            ["0x40862e42fefa39ee", "0x7feffffffffffb2a"],
            ["0x40862e42fefa39f0", "0x7ff0000000000000"],
            ["0x4086300000000000", "0x7ff0000000000000"],
            ["0xc086200000000000", "0x0017c8ab2288c9ab"],
            ["0xc086232bdd7abcd1", "0x001000000000027c"],
            ["0xc086232bdd7abcd3", "0x000ffffffffffe7c"],
            ["0xc086800000000000", "0x0000000993b4dc95"],
            ["0xc087480000000000", "0x0000000000000001"],
            ["0xc0874910d52d3050", "0x0000000000000001"],
            ["0xc0874910d52d3052", "0x0000000000000000"],
            ["0xc087700000000000", "0x0000000000000000"],
            ["0x7ff0000000000000", "0x7ff0000000000000"],
            ["0xfff0000000000000", "0x0000000000000000"],
            ["0xc037c7fd9096fb70", "0x3dc9d46af4ab84d5"],
            ["0xbffab1edcbc00000", "0x3fc8221cba844e14"],
            ["0xc02189112d400000", "0x3f2467bf5e100dbe"],
            ["0xc025879c5c880000", "0x3ef627c4b6b4507c"],
            ["0xc0180a4096700000", "0x3f641a88bd5a2d80"],
            ["0xc033604c4d700000", "0x3e3085024662b946"],
            ["0xc0154f9c44100000", "0x3f73e2d8444b78e4"],
            ["0xc026a7d05b980000", "0x3ee93cc9f87c7524"],
            ["0xc0295b6ee5a00000", "0x3eca261a28433fde"],
            ["0xbff18d0708c00000", "0x3fd55e869253c7ce"],
            ["0xbfcb1e1566000000", "0x3fe9e3fef73f9c54"],
            ["0xc02f23ec74980000", "0x3e87371c4b5fded4"],
            ["0xc02f4c9f23680000", "0x3e8570fda46cc79e"],
            ["0xbfe75e1287000000", "0x3fded5c1018b76a0"],
            ["0x3fd62e42c0db798c", "0x3ff6a09e5088c315"],
            ["0x3ff0a2b2b2848958", "0x4006a09f0988bd30"],
            ["0x3eab83460044ab8d", "0x3ff00000dc1a35ec"],
            ["0xbe1635143032007f", "0x3fefffffff4e575e"],
        ];
        const b = new ArrayBuffer(8), dv = new DataView(b);
        const f64FromBits = (hex) => { dv.setBigUint64(0, BigInt(hex), true); return dv.getFloat64(0, true); };
        const bitsFromF64 = (v) => { dv.setFloat64(0, v, true); return "0x" + dv.getBigUint64(0, true).toString(16).padStart(16, "0"); };
        let expOk = Number.isNaN(js.libmExp(NaN)), expDetail = "";
        for (const [xHex, wantHex] of FROZEN_WASM_EXP_CASES) {
            const gotHex = bitsFromF64(js.libmExp(f64FromBits(xHex)));
            if (gotHex !== wantHex) {
                expOk = false;
                expDetail = `x=${xHex}: got ${gotHex}, want ${wantHex}`;
                break;
            }
        }
        check(`js libmExp matches frozen wasm libm::exp bit for bit (${FROZEN_WASM_EXP_CASES.length} cases + NaN)`, expOk, expDetail);
    }

    const refRangeTilesDepth = (map, mw, mh, xf, W, H, ty, y0, y1, limit, jobInvert = false, snap = null, guide = null, pic = null, classes = null, tile = 256) => {
        const cols = Math.ceil(W / tile);
        const tileY0 = ty * tile, tileY1 = Math.min(tileY0 + tile, H);
        const ry0 = Math.max(tileY0, y0), ry1 = Math.min(tileY1, y1);
        const [a, b, c, d, e, f] = xf;
        const sigmaR = Array.isArray(snap) && snap.length >= 2 ? +snap[0] || 0 : 0;
        const tau = Array.isArray(snap) && snap.length >= 2 ? +snap[1] || 0 : 0;
        const doSnap = guide != null && pic != null && pic.data != null && (pic.w | 0) > 0 && (pic.h | 0) > 0 && sigmaR > 0;
        const mapObj = doSnap ? { data: map, w: mw, h: mh } : null;
        const px0 = doSnap ? (pic.x0 | 0) : 0;
        const py0 = doSnap ? (pic.y0 | 0) : 0;
        const pw = doSnap ? (pic.w | 0) : 0;
        const ph = doSnap ? (pic.h | 0) : 0;
        const pData = doSnap ? pic.data : null;
        const tiles = [];
        let alphaSum = 0;
        let bX0 = W, bY0 = H, bX1 = 0, bY1 = 0;
        for (let tx = 0; tx < cols; tx++) {
            const cls = classes ? classes[tx] : 2;
            if (cls !== 2 && cls !== "compute") continue;
            const tx0 = tx * tile, tx1 = Math.min(W, tx0 + tile);
            if (!(ry0 < ry1) || !(tx0 < tx1)) continue;
            const buf = new Uint8Array(tile * tile);
            let any = false, all = (tx1 - tx0 === tile) && (ry1 - ry0 === tile);
            for (let y = ry0; y < ry1; y++) {
                const rowOff = (y - tileY0) * tile;
                const py = y + 0.5;
                const pRow = doSnap && y >= py0 && y < py0 + ph ? (y - py0) * pw : -1;
                for (let x = tx0; x < tx1; x++) {
                    const px = x + 0.5;
                    const mx = a * px + c * py + e;
                    const my = b * px + d * py + f;
                    let v;
                    if (pRow >= 0 && x >= px0 && x < px0 + pw) {
                        const pi = (pRow + (x - px0)) * 4;
                        v = refSnapField(mapObj, guide, mx, my, pData[pi] / 255, pData[pi + 1] / 255, pData[pi + 2] / 255, sigmaR, tau);
                    } else {
                        v = u16Bilinear(map, mw, mh, mx, my);
                    }
                    let w = rangeWeight(v, limit);
                    if (jobInvert) w = 1 - w;
                    const ai = Math.round(255 * w);
                    buf[rowOff + (x - tx0)] = ai;
                    alphaSum += ai;
                    if (ai > 0) {
                        any = true;
                        if (x < bX0) bX0 = x;
                        if (y < bY0) bY0 = y;
                        if (x + 1 > bX1) bX1 = x + 1;
                        if (y + 1 > bY1) bY1 = y + 1;
                    }
                    if (ai < 255) all = false;
                }
            }
            if (all) tiles.push({ tx, ty, full: true });
            else if (any) tiles.push({ tx, ty, alpha: buf.buffer });
        }
        return { tiles, bounds: bX1 > bX0 ? [bX0, bY0, bX1, bY1] : null, alphaSum };
    };

    // Call helper so twinRun can shift map, guideData, picData, and classes as top-level typed arrays
    const callRangeDepth = (k, [map, guideData, picData, classes, mw, mh, xf, W, H, ty, y0, y1, limit, jobInvert, picBox, snap, tile]) => {
        const guide = guideData ? { data: guideData, w: mw, h: mh } : null;
        const pic = picData ? { data: picData, x0: picBox[0], y0: picBox[1], w: picBox[2], h: picBox[3] } : null;
        return k.rangeTilesDepth(map, mw, mh, xf, W, H, ty, y0, y1, limit, jobInvert, snap, guide, pic, classes, tile);
    };

    const depthCases = [];
    const limits = [
        { lo: 0.25, hi: 0.75, fLo: 0, fHi: 0, invert: false },
        { lo: 0.3, hi: 0.65, fLo: 0.08, fHi: 0.08, invert: false },
        { lo: 0.2, hi: 0.8, fLo: 0.05, fHi: 0.12, invert: true },
        { lo: 0.0, hi: 0.5, fLo: 0.0, fHi: 0.1, invert: false },
        { lo: 0.5, hi: 1.0, fLo: 0.1, fHi: 0.0, invert: true },
    ];
    for (const [mw, mh, W, H] of [
        [1, 1, 1, 1],
        [7, 5, 13, 9],
        [8, 6, 256, 256],
        [9, 7, 257, 255],
        [15, 11, 513, 257],
        [16, 12, 600, 300],
        [24, 18, 800, 550],
    ]) {
        const { map, rmax } = makeMapPair(mw, mh, (mw + mh) % 2 === 0 ? "ramp" : "random");
        const guideData = new Uint8Array(mw * mh * 4);
        for (let i = 0; i < guideData.length; i++) guideData[i] = (i & 3) === 3 ? 255 : Math.floor(rnd() * 256);
        const xfs = makeXfs(mw, mh, W, H);
        const cols = Math.ceil(W / 256), rows = Math.ceil(H / 256);
        for (let ci = 0; ci < xfs.length; ci++) {
            const [xName, xf] = xfs[ci];
            const lim = limits[(ci + mw) % limits.length];
            const jobInv = ((ci + mh) & 1) === 1;
            const useSnap = (ci % 2) === 0;
            const snap = useSnap ? snapParams(50 + (ci % 3) * 20) : null;
            const thr = useSnap ? Math.round(snap[1] * 65535) : 0;
            const st = simd.mapTileStats(map, useSnap ? rmax : null, mw, mh, xf, W, H, thr, 256);
            for (const ty of rows > 1 ? [0, rows - 1] : [0]) {
                const y0 = ty * 256, y1 = Math.min(H, y0 + 256);
                const classes = new Uint8Array(cols);
                let cMinTx = cols, cMaxTx = -1;
                for (let tx = 0; tx < cols; tx++) {
                    const idx = ty * cols + tx;
                    const c = rangeTileClass(st.min[idx] / 65535, st.max[idx] / 65535, lim, jobInv);
                    classes[tx] = c === "empty" ? 0 : c === "full" ? 1 : 2;
                    if (classes[tx] === 2 && useSnap && st.edge[idx] === 1) {
                        if (tx < cMinTx) cMinTx = tx;
                        if (tx > cMaxTx) cMaxTx = tx;
                    }
                }
                let picData = null, picBox = [0, y0, 0, 0];
                if (useSnap && cMaxTx >= cMinTx) {
                    const px0 = cMinTx * 256, pw = Math.min(W, (cMaxTx + 1) * 256) - px0, ph = y1 - y0;
                    picBox = [px0, y0, pw, ph];
                    picData = new Uint8Array(pw * ph * 4);
                    for (let i = 0; i < picData.length; i++) picData[i] = (i & 3) === 3 ? 255 : Math.floor(rnd() * 256);
                }
                depthCases.push({
                    tag: `depth ${mw}x${mh}->${W}x${H} ty=${ty} ${xName} snap=${useSnap} inv=${lim.invert}/${jobInv}`,
                    args: [map, useSnap ? guideData : null, picData, classes, mw, mh, xf, W, H, ty, y0, y1, lim, jobInv, picBox, snap, 256],
                });
            }
        }
    }

    // Exact boundary cases:
    // 1. Exact even-half in IEEE-754: d = 16384 -> v = 16384 / 65535, lo = fLo = 0.9909749217157413 -> 255 * w === 40.5
    //    Math.round(40.5) === 41 (ties toward +Infinity), whereas round_ties_even(40.5) === 40!
    // 2. Hard-step 1e-12 boundary and sstep 1e-14 clamp boundary
    // 3. All 4 combinations of (limit.invert, jobInvert)
    // 4. snapField tau .. 2*tau smoothstep blend, > 2*tau snap, wSum <= 1e-12 fallback, and partial pic box fallback
    {
        const mw = 8, mh = 8, W = 300, H = 260;
        const mapHalf = new Uint16Array(mw * mh).fill(16384);
        const limHalf = { lo: 0.9909749217157413, hi: 1.0, fLo: 0.9909749217157413, fHi: 0, invert: false };
        const xf = [mw / W, 0, 0, mh / H, 0, 0];
        const cls2 = new Uint8Array([2, 2]);
        depthCases.push({
            tag: "exact even-half 255 * w === 40.5 (Math.round -> 41 vs ties-to-even -> 40)",
            args: [mapHalf, null, null, cls2, mw, mh, xf, W, H, 0, 0, 256, limHalf, false, [0, 0, 0, 0], null, 256],
        });
        const gotHalf = simd.rangeTilesDepth(mapHalf, mw, mh, xf, W, H, 0, 0, 256, limHalf, false, null, null, null, cls2, 256);
        const alpha0 = new Uint8Array(gotHalf.tiles[0].alpha)[0];
        check("range_tiles_depth rounds exact even-half 40.5 up to 41 (JS Math.round, not ties-to-even 40)", alpha0 === 41, `got ${alpha0}`);

        // Hard-step 1e-12 tolerance: v = 16384 / 65535; lo = v + 0.5e-12 (inside tolerance -> 255) vs lo = v + 2e-12 (outside -> 0)
        const vExact = 16384 / 65535;
        for (const [delta, wantByte] of [[0.5e-12, 255], [-0.5e-12, 255], [2e-12, 0]]) {
            const limTol = { lo: vExact + delta, hi: vExact + 0.1, fLo: 0, fHi: 0, invert: false };
            depthCases.push({
                tag: `hard-step 1e-12 tolerance delta=${delta}`,
                args: [mapHalf, null, null, cls2, mw, mh, xf, W, H, 0, 0, 256, limTol, false, [0, 0, 0, 0], null, 256],
            });
            const rTol = simd.rangeTilesDepth(mapHalf, mw, mh, xf, W, H, 0, 0, 256, limTol, false, null, null, null, cls2, 256);
            const gotSum = rTol.alphaSum;
            check(`range_tiles_depth hard-step tolerance at delta=${delta} gives byte ${wantByte}`,
                gotSum === wantByte * W * 256, `got alphaSum=${gotSum}, want ${wantByte * W * 256}`);
        }

        // sstep 1e-14 endpoint clamp boundary: t in (0, 1e-14) clamps to 0, t in (1 - 1e-14, 1) clamps to 1, t = 0.5 gives 0.5
        for (const frac of [0.5e-14, 2e-14, 0.5, 1 - 2e-14, 1 - 0.5e-14]) {
            const fLo = 0.1;
            const lo = vExact + fLo * (1 - frac);
            const limSstep = { lo, hi: 1.0, fLo, fHi: 0, invert: false };
            depthCases.push({
                tag: `sstep clamp boundary frac=${frac}`,
                args: [mapHalf, null, null, cls2, mw, mh, xf, W, H, 0, 0, 256, limSstep, false, [0, 0, 0, 0], null, 256],
            });
        }

        // All 4 combinations of (limit.invert, jobInvert) on a feathered ramp
        const { map: mapRamp } = makeMapPair(mw, mh, "ramp");
        for (const limInv of [false, true]) {
            for (const jobInv of [false, true]) {
                depthCases.push({
                    tag: `invert matrix limit.invert=${limInv} jobInvert=${jobInv}`,
                    args: [mapRamp, null, null, cls2, mw, mh, xf, W, H, 0, 0, 256, { lo: 0.25, hi: 0.75, fLo: 0.12, fHi: 0.12, invert: limInv }, jobInv, [0, 0, 0, 0], null, 256],
                });
            }
        }

        // snapField tau .. 2*tau transition, > 2*tau full snap, wSum <= 1e-12 fallback, and partial pic box
        const mapEdge = new Uint16Array(mw * mh);
        const guideEdge = new Uint8Array(mw * mh * 4);
        const tau = 0.02, sigmaR = 0.05;
        // Left half of map has step = 1.5 * tau (in the smoothstep blend between tau and 2*tau);
        // right half has step = 3.0 * tau (full snap).
        for (let y = 0; y < mh; y++) {
            for (let x = 0; x < mw; x++) {
                const i = y * mw + x;
                const isMid = x < (mw >> 1);
                const step = isMid ? 1.5 * tau : 3.0 * tau;
                const side = (x + y) & 1;
                mapEdge[i] = Math.round((0.4 + (side ? step : 0)) * 65535);
                guideEdge[i * 4] = side ? 240 : 20;
                guideEdge[i * 4 + 1] = side ? 200 : 40;
                guideEdge[i * 4 + 2] = side ? 180 : 60;
                guideEdge[i * 4 + 3] = 255;
            }
        }
        // Partial pic box covering x in [10..280), y in [5..250) so edges of the tile row fall outside pic and use bilinear
        const picBox = [10, 5, 270, 245];
        const picEdge = new Uint8Array(picBox[2] * picBox[3] * 4);
        for (let i = 0; i < picEdge.length; i += 4) {
            picEdge[i] = (i * 17) & 255;
            picEdge[i + 1] = (i * 31) & 255;
            picEdge[i + 2] = (i * 47) & 255;
            picEdge[i + 3] = 255;
        }
        depthCases.push({
            tag: "snapField 1.5*tau blend, 3*tau snap, and partial pic box",
            args: [mapEdge, guideEdge, picEdge, cls2, mw, mh, xf, W, H, 0, 0, 256, { lo: 0.35, hi: 0.55, fLo: 0.05, fHi: 0.05, invert: false }, false, picBox, [sigmaR, tau], 256],
        });
        // Ultra-small sigmaR so exp(-dc2 / (2 * sigmaR^2)) underflows and wSum <= 1e-12 falls back to vBil
        depthCases.push({
            tag: "snapField wSum <= 1e-12 fallback to vBil",
            args: [mapEdge, guideEdge, picEdge, cls2, mw, mh, xf, W, H, 0, 0, 256, { lo: 0.35, hi: 0.55, fLo: 0.05, fHi: 0.05, invert: false }, false, picBox, [1e-4, tau], 256],
        });

        // K22-exp-band tie case: W = H = 256, map 128 x 128, 16384 for x < 64 else 49151, guide and picture flat grey
        // 128, m = [0.5,0,0,0.5,0.25,0], snap [0.145,0.02], limit {lo 0.55, hi 1, fLo 0.1, fHi 0}. Column x = 127 hits
        // the 127.5 tie where Electron 44's Math.exp(-0.5 / 0.145^2) differs by 1 ulp from libm::exp; with libmExp both
        // the twin and both wasm builds give 127 on all 256 pixels of column x = 127.
        const mwTie = 128, mhTie = 128, WTie = 256, HTie = 256;
        const mapTie = new Uint16Array(mwTie * mhTie);
        for (let y = 0; y < mhTie; y++) {
            for (let x = 0; x < mwTie; x++) mapTie[y * mwTie + x] = x < 64 ? 16384 : 49151;
        }
        const guideTie = new Uint8Array(mwTie * mhTie * 4).fill(128);
        const picTie = new Uint8Array(WTie * HTie * 4).fill(128);
        const mTie = [0.5, 0, 0, 0.5, 0.25, 0];
        const snapTie = [0.145, 0.02];
        const limTie = { lo: 0.55, hi: 1, fLo: 0.1, fHi: 0, invert: false };
        const clsTie = new Uint8Array([2]);
        depthCases.push({
            tag: "K22-exp-band tie case (column x = 127)",
            args: [mapTie, guideTie, picTie, clsTie, mwTie, mhTie, mTie, WTie, HTie, 0, 0, 256, limTie, false, [0, 0, WTie, HTie], snapTie, 256],
        });
        let tieOk = true, tieDetail = "";
        for (const [bName, k] of [["js", js], ["simd", simd], ["scalar", scalar]]) {
            const outTie = callRangeDepth(k, [mapTie, guideTie, picTie, clsTie, mwTie, mhTie, mTie, WTie, HTie, 0, 0, 256, limTie, false, [0, 0, WTie, HTie], snapTie, 256]);
            const aTie = new Uint8Array(outTie.tiles[0].alpha);
            let n127 = 0, n128 = 0;
            for (let y = 0; y < 256; y++) {
                const v = aTie[y * 256 + 127];
                if (v === 127) n127++;
                else if (v === 128) n128++;
            }
            if (n127 !== 128 || n128 !== 128) {
                tieOk = false;
                tieDetail = `${bName}: got n127=${n127}, n128=${n128} on column x=127 (want 128 of each)`;
                break;
            }
        }
        check("range_tiles_depth K22-exp-band tie case gives 127 on the 128 odd-row pixels of column x=127 across twin, simd, and scalar", tieOk, tieDetail);

        // Engine-independent spy: snapped js.rangeTilesDepth must call libmExp for both wSpatial and wColor, never Math.exp
        const origMathExp = Math.exp;
        let mathExpCalls = 0;
        Math.exp = (v) => { mathExpCalls++; return origMathExp(v); };
        try {
            callRangeDepth(js, [mapEdge, guideEdge, picEdge, cls2, mw, mh, xf, W, H, 0, 0, 256, { lo: 0.35, hi: 0.55, fLo: 0.05, fHi: 0.05, invert: false }, false, picBox, [sigmaR, tau], 256]);
        } finally {
            Math.exp = origMathExp;
        }
        check("js rangeTilesDepth snapped call uses libmExp for both wSpatial and wColor (0 Math.exp calls)", mathExpCalls === 0, `mathExpCalls=${mathExpCalls}`);
    }

    let refDepthOk = true, refDepthDetail = "";
    for (const c of depthCases) {
        const got = callRangeDepth(js, c.args);
        const [map, guideData, picData, classes, mw, mh, xf, W, H, ty, y0, y1, limit, jobInvert, picBox, snap, tile] = c.args;
        const guide = guideData ? { data: guideData, w: mw, h: mh } : null;
        const pic = picData ? { data: picData, x0: picBox[0], y0: picBox[1], w: picBox[2], h: picBox[3] } : null;
        const want = refRangeTilesDepth(map, mw, mh, xf, W, H, ty, y0, y1, limit, jobInvert, snap, guide, pic, classes, tile);
        const d = twinDiff(got, want, [], {});
        if (d) { refDepthOk = false; refDepthDetail = `${c.tag}: ${d}`; break; }
    }
    check(`js rangeTilesDepth equals the plain reference (${depthCases.length} cases)`, refDepthOk, refDepthDetail);

    twinCheck({
        name: "range_tiles_depth",
        builds: [["rust simd", simd], ["rust scalar", scalar]],
        twin: js,
        call: callRangeDepth,
        cases: depthCases,
    });

    // Dirty arena out-of-bounds zeroing check on partial right and bottom compute tiles
    {
        const mw = 8, mh = 8, W = 300, H = 270; // col 1 has vw = 44, row 1 has vh = 14
        const { map } = makeMapPair(mw, mh, "ramp");
        const xf = [mw / W, 0, 0, mh / H, 0, 0];
        const lim = { lo: 0.2, hi: 0.8, fLo: 0.1, fHi: 0.1, invert: false };
        const cls = new Uint8Array([2, 2]);
        let padOk = true, padDetail = "";
        for (const [bName, px] of [["simd", simd], ["scalar", scalar]]) {
            // Dirty the job arena with 0xde before calling rangeTilesDepth on the partial bottom-right row (ty=1, y0=256..270)
            const a = px.job;
            try {
                const p = a.take(512 * 1024);
                px.u8().fill(0xde, p, p + 512 * 1024);
            } finally { px._reset(a); }
            const got = px.rangeTilesDepth(map, mw, mh, xf, W, H, 1, 256, 270, lim, false, null, null, null, cls, 256);
            const want = js.rangeTilesDepth(map, mw, mh, xf, W, H, 1, 256, 270, lim, false, null, null, null, cls, 256);
            const d = twinDiff(got, want, [], {});
            if (d) { padOk = false; padDetail = `${bName}: ${d}`; break; }
            for (const t of got.tiles) {
                if (!t.alpha) continue;
                const u = new Uint8Array(t.alpha);
                const vw = Math.min(256, W - t.tx * 256), vh = 270 - 256;
                for (let y = 0; y < 256 && padOk; y++) {
                    for (let x = 0; x < 256; x++) {
                        if ((x >= vw || y >= vh) && u[y * 256 + x] !== 0) {
                            padOk = false;
                            padDetail = `${bName} tile (${t.tx},${t.ty}) non-zero pad at (${x},${y}): ${u[y * 256 + x]}`;
                            break;
                        }
                    }
                }
            }
        }
        check("range_tiles_depth zeroes out-of-bounds right and bottom columns/rows in dirty wasm arena", padOk, padDetail);
    }

    // Refusal checks for rangeTilesDepth and raw export wy0 window check
    {
        const map = new Uint16Array(16 * 16), guideData = new Uint8Array(16 * 16 * 4);
        const guide = { data: guideData, w: 16, h: 16 };
        const pic = { data: new Uint8Array(64 * 64 * 4), x0: 0, y0: 0, w: 64, h: 64 };
        const xf = [0.25, 0, 0, 0.25, 0, 0];
        const lim = { lo: 0.2, hi: 0.8, fLo: 0.05, fHi: 0.05, invert: false };
        const cls = new Uint8Array([2]);
        const snap = [0.05, 0.02];
        const badDepthArgs = [
            ["null map", [null, 16, 16, xf, 64, 64, 0, 0, 64, lim, false, null, null, null, cls, 256]],
            ["short map", [new Uint16Array(32), 16, 16, [0, 0, 0, 0, 0, 0], 64, 64, 0, 0, 64, lim, false, null, null, null, cls, 256]],
            ["short classes", [map, 16, 16, xf, 600, 64, 0, 0, 64, lim, false, null, null, null, new Uint8Array(1), 256]],
            ["short guide", [map, 16, 16, xf, 64, 64, 0, 0, 64, lim, false, snap, { data: new Uint8Array(20), w: 16, h: 16 }, pic, cls, 256]],
            ["short pic", [map, 16, 16, xf, 64, 64, 0, 0, 64, lim, false, snap, guide, { data: new Uint8Array(20), x0: 0, y0: 0, w: 64, h: 64 }, cls, 256]],
            ["zero mw", [map, 0, 16, xf, 64, 64, 0, 0, 64, lim, false, null, null, null, cls, 256]],
            ["zero W", [map, 16, 16, xf, 0, 64, 0, 0, 64, lim, false, null, null, null, cls, 256]],
            ["y0 >= y1", [map, 16, 16, xf, 64, 64, 0, 32, 32, lim, false, null, null, null, cls, 256]],
            ["zero tile", [map, 16, 16, xf, 64, 64, 0, 0, 64, lim, false, null, null, null, cls, 0]],
            ["NaN xf", [map, 16, 16, [NaN, 0, 0, 1, 0, 0], 64, 64, 0, 0, 64, lim, false, null, null, null, cls, 256]],
            ["null limit", [map, 16, 16, xf, 64, 64, 0, 0, 64, null, false, null, null, null, cls, 256]],
        ];
        for (const [what, args] of badDepthArgs) {
            let threw = 0;
            for (const k of [js, simd, scalar]) {
                try { k.rangeTilesDepth(...args); } catch { threw++; }
            }
            check(`rangeTilesDepth refuses ${what} on twin and both builds`, threw === 3, `${threw}/3 threw`);
        }
        // Raw export returns 0 when [iy0..iy1] falls outside [wy0..wy0+wh)
        const a = simd.job;
        try {
            const pm = simd._in(a, map, map.byteLength);
            const pCls = simd._in(a, cls, 1);
            const pParams = a.take(12 * 8);
            const pv = simd.view(Float64Array, pParams, 12);
            pv[0] = 0.25; pv[3] = 0.25; pv[6] = 0.2; pv[7] = 0.8; pv[8] = 0.05; pv[9] = 0.05;
            const pAlpha = a.take(65536), pStatus = a.take(1), pInfo = a.take(5 * 8);
            const okRaw = simd.exports.range_tiles_depth(
                pm, 0, 0, 16, 16, 5, 4,
                0, 0, 0, 0,
                64, 64, 0, 0, 64, 256,
                pCls, pParams, 0,
                pAlpha, pStatus, pInfo
            );
            check("raw range_tiles_depth returns 0 when [iy0..iy1] falls outside [wy0..wy0+wh)", okRaw === 0, `got ${okRaw}`);
        } finally { simd._reset(a); }
    }

    // Route & split-routing check on K.rangeTilesDepth (rangeDepth & rangeDepthSnap)
    {
        K.setKernels("rust");
        const mw = 32, mh = 24, W = 1536, H = 256; // 6 tiles across: classes [2, 2, 0, 2, 1, 2], pic spans tiles 1..3 (x0=256..1024)
        const { map } = makeMapPair(mw, mh, "ramp");
        const guideData = new Uint8Array(mw * mh * 4);
        for (let i = 0; i < guideData.length; i++) guideData[i] = (i * 29) & 255;
        const guide = { data: guideData, w: mw, h: mh };
        const pic = { data: new Uint8Array(768 * H * 4), x0: 256, y0: 0, w: 768, h: H };
        for (let i = 0; i < pic.data.length; i++) pic.data[i] = (i * 13) & 255;
        const xf = [mw / W, 0, 0, mh / H, 0, 0];
        const lim = { lo: 0.2, hi: 0.75, fLo: 0.08, fHi: 0.08, invert: false };
        const classes = new Uint8Array([2, 2, 0, 2, 1, 2]);
        const snap = snapParams(50);

        const runCombo = (rd, rs) => {
            K.setRoute("rangeDepth", rd);
            K.setRoute("rangeDepthSnap", rs);
            K.pxCalls(true);
            const res = K.rangeTilesDepth(map, mw, mh, xf, W, H, 0, 0, H, lim, false, snap, guide, pic, classes, 256);
            const calls = K.pxCalls(true).range_tiles_depth || 0;
            return { res, calls };
        };
        const jj = runCombo("js", "js");
        const rr = runCombo("rust", "rust");
        const rj = runCombo("rust", "js");
        const jr = runCombo("js", "rust");
        K.setRoute("rangeDepth", null);
        K.setRoute("rangeDepthSnap", null);
        K.setKernels("js");

        const orderOk = [jj.res, rr.res, rj.res, jr.res].every((r) =>
            r.tiles.every((t, i) => i === 0 || t.tx > r.tiles[i - 1].tx)
        );
        const diffRR = twinDiff(rr.res, jj.res, [], {});
        const diffRJ = twinDiff(rj.res, jj.res, [], {});
        const diffJR = twinDiff(jr.res, jj.res, [], {});
        check("kernels.js rangeTilesDepth routes (js/js, rust/rust, rust/js, js/rust) match byte-for-byte in ascending tx order",
            orderOk && !diffRR && !diffRJ && !diffJR && jj.calls === 0 && rr.calls === 1 && rj.calls === 1 && jr.calls === 1,
            `calls jj=${jj.calls} rr=${rr.calls} rj=${rj.calls} jr=${jr.calls} diffs=${diffRR || diffRJ || diffJR}`);

        // Turned-map window bounds: on a 90-degree turn (m1 = mh / W), a row with only 1 compute tile (tx = 2 of 6)
        // bounds [wy0..wy1] over [minTx..maxTx] instead of [0..W].
        const xfTurn = [0, mh / W, mw / H, 0, 0, 0];
        const clsSingle = new Uint8Array([0, 0, 2, 0, 0, 0]);
        let copiedMapBytes = 0;
        const origIn = simd._in;
        simd._in = function (arena, src, bytes) {
            if (src.buffer === map.buffer) copiedMapBytes = bytes;
            return origIn.call(this, arena, src, bytes);
        };
        try {
            const gotTurn = simd.rangeTilesDepth(map, mw, mh, xfTurn, W, H, 0, 0, H, lim, false, null, null, null, clsSingle, 256);
            const wantTurn = js.rangeTilesDepth(map, mw, mh, xfTurn, W, H, 0, 0, H, lim, false, null, null, null, clsSingle, 256);
            check("px.js rangeTilesDepth bounds [wy0..wy1] over [minTx..maxTx] on a 90-degree turned map",
                !twinDiff(gotTurn, wantTurn) && copiedMapBytes > 0 && copiedMapBytes <= (mh / 2) * mw * 2,
                `copiedMapBytes=${copiedMapBytes} fullMapBytes=${map.byteLength}`);
        } finally {
            simd._in = origIn;
        }
    }

    // ---- K23: range_tiles_rgba (luma & colour, docs/PLAN_WASM_BUILD.md §4.8) -------------------------------------------

    const refRangeTilesRgba = (rgba, W, H, ty, y0, y1, limit, jobInvert = false, tile = 256) => {
        const u8 = rgba instanceof Uint8Array
            ? rgba
            : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
        const isColor = limit.source === "color" || (limit.source !== "luma" && limit.color != null);
        let ref = null, twoS2 = 1;
        if (isColor) {
            const [r0, g0, b0] = hexToRgb(limit.color || "#ffffff");
            ref = opp(r0, g0, b0);
            const tol = Number(limit.tol ?? 30);
            const s = 0.04 + Math.max(0, Math.min(1, (tol || 0) / 100)) * 0.6;
            twoS2 = 2 * s * s;
        }
        const limDesc = {
            lo: Number(limit.lo ?? 0),
            hi: Number(limit.hi ?? 0),
            fLo: Number(limit.fLo || 0),
            fHi: Number(limit.fHi || 0),
            invert: Boolean(limit.invert),
        };
        const inv = Boolean(jobInvert);
        const cols = Math.ceil(W / tile);
        const tileY0 = ty * tile;
        const tileY1 = Math.min(tileY0 + tile, H);
        const ry0 = Math.max(tileY0, y0);
        const ry1 = Math.min(tileY1, y1);
        const pyStart = ry0 - tileY0;
        const pyEnd = ry1 - tileY0;
        const tiles = [];
        let bX0 = Infinity, bY0 = Infinity, bX1 = -Infinity, bY1 = -Infinity;
        let alphaSum = 0;

        for (let tx = 0; tx < cols; tx++) {
            const tileX0 = tx * tile;
            const tileX1 = Math.min(tileX0 + tile, W);
            const vw = Math.max(0, tileX1 - tileX0);
            if (vw === 0 || pyStart >= pyEnd) continue;

            const buf = new Uint8Array(tile * tile);
            let anyNonZero = false;
            let allFull = vw === tile && pyStart === 0 && pyEnd === tile;
            let tileSum = 0;
            let tX0 = Infinity, tY0 = Infinity, tX1 = -Infinity, tY1 = -Infinity;

            for (let py = pyStart; py < pyEnd; py++) {
                const gy = tileY0 + py;
                const rowBase = ((gy - y0) * W + tileX0) * 4;
                const dstRow = py * tile;
                for (let px = 0; px < vw; px++) {
                    const idx = rowBase + px * 4;
                    const R = u8[idx], G = u8[idx + 1], B = u8[idx + 2];
                    let v;
                    if (isColor) {
                        const o3 = opp(R / 255, G / 255, B / 255);
                        const d0 = o3[0] - ref[0];
                        const d1 = o3[1] - ref[1];
                        const d2 = o3[2] - ref[2];
                        const dd = d0 * d0 + 4 * (d1 * d1 + d2 * d2);
                        v = js.libmExp(-dd / twoS2);
                    } else {
                        v = (LUMA[0] * R + LUMA[1] * G + LUMA[2] * B) / 255;
                    }
                    let w = rangeWeight(v, limDesc);
                    if (inv) w = 1 - w;
                    const a = Math.min(255, Math.max(0, Math.round(w * 255)));
                    if (a > 0) {
                        buf[dstRow + px] = a;
                        anyNonZero = true;
                        tileSum += a;
                        const gx = tileX0 + px;
                        if (gx < tX0) tX0 = gx;
                        if (gy < tY0) tY0 = gy;
                        if (gx + 1 > tX1) tX1 = gx + 1;
                        if (gy + 1 > tY1) tY1 = gy + 1;
                        if (a < 255) allFull = false;
                    } else {
                        allFull = false;
                    }
                }
            }

            if (anyNonZero) {
                alphaSum += tileSum;
                if (tX0 < bX0) bX0 = tX0;
                if (tY0 < bY0) bY0 = tY0;
                if (tX1 > bX1) bX1 = tX1;
                if (tY1 > bY1) bY1 = tY1;
                if (allFull) tiles.push({ tx, ty, full: true });
                else tiles.push({ tx, ty, alpha: buf.buffer });
            }
        }

        const bounds = Number.isFinite(bX0) ? [bX0, bY0, bX1, bY1] : null;
        return { tiles, bounds, alphaSum };
    };

    const ALPHA_PAT = [0, 1, 128, 254, 255];
    const makeRgbaBand = (W, rows, kind) => {
        const u8 = new Uint8Array(W * rows * 4);
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < W; x++) {
                const idx = (y * W + x) * 4;
                if (kind === "ramp") {
                    const t = Math.round(((x + y * 0.5) / Math.max(1, W + rows * 0.5)) * 255);
                    u8[idx] = t;
                    u8[idx + 1] = Math.min(255, Math.max(0, 255 - t));
                    u8[idx + 2] = (x * 3 + y * 5) & 255;
                    u8[idx + 3] = ALPHA_PAT[(x * 7 + y * 13) % 5];
                } else if (kind === "stripes") {
                    const tx = Math.floor(x / 256);
                    if (tx % 3 === 0) {
                        u8[idx] = 255; u8[idx + 1] = 255; u8[idx + 2] = 255; u8[idx + 3] = 255;
                    } else if (tx % 3 === 1) {
                        u8[idx] = 0; u8[idx + 1] = 0; u8[idx + 2] = 0; u8[idx + 3] = 255;
                    } else {
                        u8[idx] = (x * 13 + y * 7) & 255;
                        u8[idx + 1] = (x * 29 + y * 11) & 255;
                        u8[idx + 2] = (x * 43 + y * 19) & 255;
                        u8[idx + 3] = 255;
                    }
                } else {
                    u8[idx] = Math.floor(rnd() * 256);
                    u8[idx + 1] = Math.floor(rnd() * 256);
                    u8[idx + 2] = Math.floor(rnd() * 256);
                    u8[idx + 3] = ALPHA_PAT[(x + y * 3) % 5];
                }
            }
        }
        return u8;
    };

    const rgbaCases = [];
    for (const [W, H, ty, y0, y1, kind] of [
        [1, 1, 0, 0, 1, "random"],
        [13, 9, 0, 0, 9, "ramp"],
        [256, 256, 0, 0, 256, "stripes"],
        [257, 255, 0, 0, 255, "random"],
        [513, 257, 0, 0, 257, "stripes"],
        [513, 257, 1, 0, 257, "ramp"],
        [600, 300, 0, 10, 200, "ramp"],    // partial [y0..y1) inside tile row 0 (pyStart > 0, pyEnd < 256)
        [600, 600, 1, 100, 500, "stripes"], // multi-tile band y0=100..500, ty=1 (ry0=256..500)
        [800, 550, 2, 0, 550, "random"],   // partial bottom row ty=2 (512..550) and partial right col (vw=32)
    ]) {
        const band = makeRgbaBand(W, y1 - y0, kind);
        rgbaCases.push({
            tag: `luma ${W}x${H} ty=${ty} [${y0}..${y1}) ${kind}`,
            args: [band, W, H, ty, y0, y1, { source: "luma", lo: 0.2, hi: 0.8, fLo: 0.08, fHi: 0.08, invert: false }, false, 256],
        });
        rgbaCases.push({
            tag: `color #5080a0 tol=30 ${W}x${H} ty=${ty} [${y0}..${y1}) ${kind}`,
            args: [band, W, H, ty, y0, y1, { source: "color", color: "#5080a0", tol: 30, lo: 0.25, hi: 1.0, fLo: 0.1, fHi: 0.05, invert: false }, false, 256],
        });
    }

    // Colour hex parsing (#rgb 3-char, #rrggbb, missing color fallback to white) & tol clamping (0, 100, -10, 150)
    {
        const W = 260, H = 64;
        const band = makeRgbaBand(W, H, "ramp");
        for (const [tag, lim, jobInv] of [
            ["#rgb 3-char hex tol=40", { source: "color", color: "#48c", tol: 40, lo: 0.1, hi: 0.9, fLo: 0.05, fHi: 0.05, invert: false }, false],
            ["#rrggbb 6-char hex tol=0", { source: "color", color: "#4488cc", tol: 0, lo: 0.01, hi: 0.9, fLo: 0.01, fHi: 0.05, invert: false }, false],
            ["limit.color property tol=100", { source: "color", color: "#20a060", tol: 100, lo: 0.3, hi: 0.85, fLo: 0.1, fHi: 0.1, invert: true }, false],
            ["missing hex fallback tol=-10", { source: "color", tol: -10, lo: 0.2, hi: 1.0, fLo: 0.05, fHi: 0, invert: false }, true],
            ["tol=150 clamped to 100", { source: "color", color: "#ff8000", tol: 150, lo: 0.4, hi: 0.95, fLo: 0.1, fHi: 0.05, invert: false }, false],
            ["luma invert matrix (true, true)", { source: "luma", lo: 0.25, hi: 0.75, fLo: 0.1, fHi: 0.1, invert: true }, true],
            ["luma invert matrix (true, false)", { source: "luma", lo: 0.25, hi: 0.75, fLo: 0.1, fHi: 0.1, invert: true }, false],
            ["luma invert matrix (false, true)", { source: "luma", lo: 0.25, hi: 0.75, fLo: 0.1, fHi: 0.1, invert: false }, true],
        ]) {
            rgbaCases.push({
                tag: `rgba variant ${tag}`,
                args: [band, W, H, 0, 0, H, lim, jobInv, 256],
            });
        }
        const out3 = simd.rangeTilesRgba(band, W, H, 0, 0, H, { source: "color", color: "#48c", tol: 40, lo: 0.1, hi: 0.9, fLo: 0.05, fHi: 0.05, invert: false }, false, 256);
        const out6 = simd.rangeTilesRgba(band, W, H, 0, 0, H, { source: "color", color: "#4488cc", tol: 40, lo: 0.1, hi: 0.9, fLo: 0.05, fHi: 0.05, invert: false }, false, 256);
        check("range_tiles_rgba expands 3-char #48c identically to #4488cc with non-empty alpha",
            out3.alphaSum > 0 && !twinDiff(out3, out6), `alphaSum=${out3.alphaSum}`);
    }

    // Exact boundary cases for range_tiles_rgba:
    // 1. All-255 full-tile shortcut vs 1 non-255 pixel
    // 2. Hard-step 1e-12 tolerance around lo and hi
    // 3. sstep 1e-14 endpoint clamp
    // 4. Exact half-way rounding (w * 255 = 40.5 -> 41)
    // 5. Colour libmExp vs Math.exp tie case (color="#808080", tol=10, pixel=(98,119,128), lo=0.21358439201215637)
    {
        const W = 256, H = 256;
        const gray128 = new Uint8Array(W * H * 4).fill(128);
        const vLuma128 = (0.299 * 128 + 0.587 * 128 + 0.114 * 128) / 255;

        // Exact half-way: w = 40.5 / 255 -> 41
        const wTarget = 40.5 / 255;
        let lo = 0, hi = 1;
        for (let iter = 0; iter < 80; iter++) {
            const mid = 0.5 * (lo + hi);
            if (mid * mid * (3 - 2 * mid) < wTarget) lo = mid;
            else hi = mid;
        }
        const tHalf = 0.5 * (lo + hi);
        const fLoHalf = 0.25;
        const loHalf = vLuma128 + fLoHalf * (1 - tHalf);
        const limHalf = { source: "luma", lo: loHalf, hi: 1.0, fLo: fLoHalf, fHi: 0, invert: false };
        rgbaCases.push({
            tag: "luma exact half-way 40.5 -> 41",
            args: [gray128, W, H, 0, 0, H, limHalf, false, 256],
        });
        const rHalf = simd.rangeTilesRgba(gray128, W, H, 0, 0, H, limHalf, false, 256);
        check("range_tiles_rgba rounds w*255 = 40.5 away from zero to 41 (not ties-to-even 40)",
            new Uint8Array(rHalf.tiles[0].alpha)[0] === 41, `got ${new Uint8Array(rHalf.tiles[0].alpha)[0]}`);

        // Hard-step 1e-12 boundary around vLuma128
        for (const [delta, wantByte] of [[-2e-12, 255], [-0.5e-12, 255], [0.5e-12, 255], [2e-12, 0]]) {
            const limTol = { source: "luma", lo: vLuma128 + delta, hi: 1.0, fLo: 0, fHi: 0, invert: false };
            rgbaCases.push({
                tag: `luma hard-step lo=v+${delta}`,
                args: [gray128, W, H, 0, 0, H, limTol, false, 256],
            });
            const rTol = simd.rangeTilesRgba(gray128, W, H, 0, 0, H, limTol, false, 256);
            check(`range_tiles_rgba hard-step tolerance at delta=${delta} gives byte ${wantByte}`,
                rTol.alphaSum === wantByte * W * H, `got alphaSum=${rTol.alphaSum}, want ${wantByte * W * H}`);
        }

        // sstep 1e-14 endpoint clamp
        for (const frac of [0.5e-14, 2e-14, 0.5, 1 - 2e-14, 1 - 0.5e-14]) {
            const fLo = 0.1;
            const limSstep = { source: "luma", lo: vLuma128 + fLo * (1 - frac), hi: 1.0, fLo, fHi: 0, invert: false };
            rgbaCases.push({
                tag: `luma sstep clamp frac=${frac}`,
                args: [gray128, W, H, 0, 0, H, limSstep, false, 256],
            });
        }

        // Colour libmExp vs Math.exp tie case: pixel (98, 119, 128) against #808080 at tol=10 has
        // libmExp(x) = 0.21358439201115637 vs Electron 44 Math.exp(x) = 0.21358439201115634;
        // at hard-step lo = 0.21358439201215637 (lo - 1e-12 === 0.21358439201115637), libmExp gives 255 (full tile)
        // whereas Electron 44 Math.exp gives 0 (empty tile).
        const colTiePic = new Uint8Array(256 * 256 * 4);
        for (let i = 0; i < colTiePic.length; i += 4) {
            colTiePic[i] = 98;
            colTiePic[i + 1] = 119;
            colTiePic[i + 2] = 128;
            colTiePic[i + 3] = 255;
        }
        const limColTie = { source: "color", color: "#808080", tol: 10, lo: 0.21358439201215637, hi: 1.0, fLo: 0, fHi: 0, invert: false };
        rgbaCases.push({
            tag: "K23 colour libmExp tie case (pixel 98,119,128 vs #808080 tol=10)",
            args: [colTiePic, 256, 256, 0, 0, 256, limColTie, false, 256],
        });
        for (const [bName, k] of [["js", js], ["simd", simd], ["scalar", scalar]]) {
            const outTie = k.rangeTilesRgba(colTiePic, 256, 256, 0, 0, 256, limColTie, false, 256);
            check(`range_tiles_rgba K23 colour libmExp tie case gives full tile (alphaSum=${255 * 65536}) on ${bName}`,
                outTie.alphaSum === 255 * 65536 && outTie.tiles.length === 1 && outTie.tiles[0].full === true,
                JSON.stringify(outTie));
        }

        //Engine-independent spy: js.rangeTilesRgba in colour mode must call libmExp, never Math.exp
        const origMathExp = Math.exp;
        let mathExpCalls = 0;
        Math.exp = (v) => { mathExpCalls++; return origMathExp(v); };
        try {
            js.rangeTilesRgba(colTiePic, 256, 256, 0, 0, 256, limColTie, false, 256);
        } finally {
            Math.exp = origMathExp;
        }
        check("js rangeTilesRgba colour call uses libmExp (0 Math.exp calls)", mathExpCalls === 0, `mathExpCalls=${mathExpCalls}`);

        // Frozen opp(r, g, b) order-of-operations tie case: at pixel (15, 0, 0) against #000000 (tol=0),
        // 0.299 * (15 / 255) gives v = 0.07362357377680942 >= lo - 1e-12 (lo = 0.07362357377780943),
        // whereas (0.299 * 15) / 255 gives v = 0.07362357377680939 < lo - 1e-12.
        const oppOrderPic = new Uint8Array(256 * 256 * 4);
        for (let i = 0; i < oppOrderPic.length; i += 4) {
            oppOrderPic[i] = 15;
            oppOrderPic[i + 1] = 0;
            oppOrderPic[i + 2] = 0;
            oppOrderPic[i + 3] = ALPHA_PAT[(i >> 2) % 5];
        }
        const limOppOrder = { source: "color", color: "#000000", tol: 0, lo: 0.07362357377780943, hi: 1.0, fLo: 0, fHi: 0, invert: false };
        rgbaCases.push({
            tag: "K23 colour opp(R/255) vs (0.299*R)/255 order tie case (pixel 15,0,0 vs #000000 tol=0)",
            args: [oppOrderPic, 256, 256, 0, 0, 256, limOppOrder, false, 256],
        });
        for (const [bName, k] of [["js", js], ["simd", simd], ["scalar", scalar]]) {
            const outOpp = k.rangeTilesRgba(oppOrderPic, 256, 256, 0, 0, 256, limOppOrder, false, 256);
            check(`range_tiles_rgba K23 opp(R/255) order tie case gives full tile (alphaSum=${255 * 65536}) on ${bName}`,
                outOpp.alphaSum === 255 * 65536 && outOpp.tiles.length === 1 && outOpp.tiles[0].full === true,
                JSON.stringify(outOpp));
        }

        // Multi-tile-row rangeSelectJob alphaSum and bounds union check (3 tile rows: ty=0,1,2;
        // clear left/right margins on the last tile row ty=2 so its [bX0..bX1] is strictly narrower than ty=0)
        const wJob = 300, hJob = 600;
        const jobBand = makeRgbaBand(wJob, hJob, "ramp");
        for (let y = 512; y < hJob; y++) {
            for (let x = 0; x < wJob; x++) {
                if (x < 60 || x >= 240) {
                    const idx = (y * wJob + x) * 4;
                    jobBand[idx] = 0;
                    jobBand[idx + 1] = 0;
                    jobBand[idx + 2] = 0;
                }
            }
        }
        for (const [srcKind, limJ] of [
            ["luma", { source: "luma", lo: 0.3, hi: 0.7, fLo: 0.1, fHi: 0.1, invert: false }],
            ["color", { source: "color", color: "#5080a0", tol: 30, lo: 0.25, hi: 0.9, fLo: 0.1, fHi: 0.05, invert: false }],
        ]) {
            const jobOut = rangeSelectJob({ W: wJob, H: hJob, y0: 0, y1: hJob, source: srcKind, limit: limJ, invert: false, sab: jobBand.buffer });
            let wantSum = 0, bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
            for (let y = 0; y < hJob; y++) {
                for (let x = 0; x < wJob; x++) {
                    const idx = (y * wJob + x) * 4;
                    const a = Math.round(255 * limitWeight(limJ, jobBand[idx] / 255, jobBand[idx + 1] / 255, jobBand[idx + 2] / 255, 0));
                    if (a > 0) {
                        wantSum += a;
                        if (x < bx0) bx0 = x;
                        if (y < by0) by0 = y;
                        if (x + 1 > bx1) bx1 = x + 1;
                        if (y + 1 > by1) by1 = y + 1;
                    }
                }
            }
            const wantB = [bx0, by0, bx1, by1];
            check(`rangeSelectJob ${srcKind} multi-row band (3 tile rows) matches per-pixel alphaSum and bounds union`,
                jobOut.alphaSum === wantSum && JSON.stringify(jobOut.bounds) === JSON.stringify(wantB),
                `alphaSum=${jobOut.alphaSum}/${wantSum} bounds=${JSON.stringify(jobOut.bounds)}/${JSON.stringify(wantB)}`);
        }

        // normalizeLimit refuses invalid color (#rgb/#rrggbb required) and non-numeric lo/hi/fLo/fHi/tol
        let normRefused = 0;
        for (const badLim of [
            { source: "color", lo: 0.2, hi: 0.8, color: "red" },
            { source: "color", lo: 0.2, hi: 0.8, color: "#xyz" },
            { source: "luma", lo: "bad", hi: 0.8 },
            { source: "luma", lo: 0.2, hi: NaN },
            { source: "depth", lo: 0.2, hi: 0.8, fLo: "bad" },
            { source: "depth", lo: 0.2, hi: 0.8, fHi: Infinity },
            { source: "color", lo: 0.2, hi: 0.8, color: "#ffffff", tol: "bad" },
        ]) {
            try { normalizeLimit(badLim); } catch (e) {
                if (/must be (#rgb or #rrggbb|a finite number)/.test(String(e.message || e))) normRefused++;
            }
        }
        check("normalizeLimit refuses invalid color and non-numeric lo/hi/fLo/fHi/tol with readable message",
            normRefused === 7, `${normRefused}/7 refused`);
    }

    let refRgbaOk = true, refRgbaDetail = "";
    for (const c of rgbaCases) {
        const got = js.rangeTilesRgba(...c.args), want = refRangeTilesRgba(...c.args);
        const d = twinDiff(got, want, [], {});
        if (d) { refRgbaOk = false; refRgbaDetail = `${c.tag}: ${d}`; break; }
    }
    check(`js rangeTilesRgba equals the plain reference (${rgbaCases.length} cases)`, refRgbaOk, refRgbaDetail);

    twinCheck({
        name: "range_tiles_rgba",
        builds: [["rust simd", simd], ["rust scalar", scalar]],
        twin: js,
        call: (k, args) => k.rangeTilesRgba(...args),
        cases: rgbaCases,
    });

    // Dirty wasm arena out-of-bounds zeroing check (top pyStart > 0, bottom pyEnd < tile, right vw < tile)
    // and 1-tile-row copy spy on a 1024-row band (never copying the whole band)
    {
        const W = 300, H = 300;
        const band = makeRgbaBand(W, 200, "ramp"); // y0 = 20..220 inside ty = 0 (0..256): pyStart = 20, pyEnd = 220, vw on tx=1 is 44
        const limLuma = { source: "luma", lo: 0.15, hi: 0.85, fLo: 0.1, fHi: 0.1, invert: false };
        const limCol = { source: "color", color: "#6080a0", tol: 40, lo: 0.15, hi: 0.9, fLo: 0.1, fHi: 0.1, invert: false };
        let padOk = true, padDetail = "";
        for (const [bName, px] of [["simd", simd], ["scalar", scalar]]) {
            for (const lim of [limLuma, limCol]) {
                const a = px.job;
                try {
                    const p = a.take(512 * 1024);
                    px.u8().fill(0xde, p, p + 512 * 1024);
                } finally { px._reset(a); }
                const got = px.rangeTilesRgba(band, W, H, 0, 20, 220, lim, false, 256);
                const want = js.rangeTilesRgba(band, W, H, 0, 20, 220, lim, false, 256);
                const d = twinDiff(got, want, [], {});
                if (d) { padOk = false; padDetail = `${bName} ${lim.source}: ${d}`; break; }
                for (const t of got.tiles) {
                    if (!t.alpha) continue;
                    const u = new Uint8Array(t.alpha);
                    const vw = Math.min(256, W - t.tx * 256);
                    for (let y = 0; y < 256 && padOk; y++) {
                        for (let x = 0; x < 256; x++) {
                            if ((y < 20 || y >= 220 || x >= vw) && u[y * 256 + x] !== 0) {
                                padOk = false;
                                padDetail = `${bName} ${lim.source} tile (${t.tx},${t.ty}) non-zero pad at (${x},${y}): ${u[y * 256 + x]}`;
                                break;
                            }
                        }
                    }
                }
            }
        }
        check("range_tiles_rgba zeroes out-of-bounds top, bottom, and right rows/columns in dirty wasm arena", padOk, padDetail);

        // 1-tile-row copy check: on a 1024-row band (W = 300, H = 1024, y0 = 0, y1 = 1024), calling rangeTilesRgba for ty = 2
        // copies only 256 rows (W * 256 * 4 bytes = 1/4 of the band) into the wasm arena, never the 1024-row band.
        const band1024 = makeRgbaBand(300, 1024, "ramp");
        let copiedRgbaBytes = 0;
        const origIn = simd._in;
        simd._in = function (arena, src, bytes) {
            if (src.buffer === band1024.buffer) copiedRgbaBytes = bytes;
            return origIn.call(this, arena, src, bytes);
        };
        try {
            const gotRow = simd.rangeTilesRgba(band1024, 300, 1024, 2, 0, 1024, limLuma, false, 256);
            const wantRow = js.rangeTilesRgba(band1024, 300, 1024, 2, 0, 1024, limLuma, false, 256);
            check("px.js rangeTilesRgba copies only one tile row (256 rows) from a 1024-row band into the wasm arena",
                !twinDiff(gotRow, wantRow) && copiedRgbaBytes === 300 * 256 * 4,
                `copiedRgbaBytes=${copiedRgbaBytes} want=${300 * 256 * 4} fullBand=${band1024.byteLength}`);
        } finally {
            simd._in = origIn;
        }
    }

    // Refusal checks for rangeTilesRgba and raw export range_tiles_rgba
    {
        const rgba = new Uint8Array(64 * 64 * 4);
        const limL = { source: "luma", lo: 0.2, hi: 0.8, fLo: 0.05, fHi: 0.05, invert: false };
        const badRgbaArgs = [
            ["null rgba", [null, 64, 64, 0, 0, 64, limL, false, 256]],
            ["short rgba", [new Uint8Array(100), 64, 64, 0, 0, 64, limL, false, 256]],
            ["zero W", [rgba, 0, 64, 0, 0, 64, limL, false, 256]],
            ["zero H", [rgba, 64, 0, 0, 0, 64, limL, false, 256]],
            ["zero tile", [rgba, 64, 64, 0, 0, 64, limL, false, 0]],
            ["tile > 4096", [rgba, 64, 64, 0, 0, 64, limL, false, 4097]],
            ["negative ty", [rgba, 64, 64, -1, 0, 64, limL, false, 256]],
            ["y0 >= y1", [rgba, 64, 64, 0, 32, 32, limL, false, 256]],
            ["y1 > H", [rgba, 64, 64, 0, 0, 65, limL, false, 256]],
            ["null limit", [rgba, 64, 64, 0, 0, 64, null, false, 256]],
            ["NaN lo", [rgba, 64, 64, 0, 0, 64, { source: "luma", lo: NaN, hi: 0.8 }, false, 256]],
            ["NaN tol", [rgba, 64, 64, 0, 0, 64, { source: "color", color: "#ffffff", tol: NaN, lo: 0.2, hi: 0.8 }, false, 256]],
        ];
        for (const [what, args] of badRgbaArgs) {
            let threw = 0;
            for (const k of [js, simd, scalar]) {
                try { k.rangeTilesRgba(...args); } catch { threw++; }
            }
            check(`rangeTilesRgba refuses ${what} on twin and both builds`, threw === 3, `${threw}/3 threw`);
        }
        // Raw export returns 0 when mode > 1 or [ry0..ry1) falls outside the tile row
        const a = simd.job;
        try {
            const pRgba = simd._in(a, rgba, rgba.byteLength);
            const pParams = a.take(8 * 8);
            const pAlpha = a.take(65536), pStatus = a.take(1), pInfo = a.take(5 * 8);
            const badMode = simd.exports.range_tiles_rgba(pRgba, 64, 64, 0, 0, 64, 256, 2, pParams, 0, pAlpha, pStatus, pInfo);
            const badRow = simd.exports.range_tiles_rgba(pRgba, 64, 300, 1, 256, 320, 256, 0, pParams, 0, pAlpha, pStatus, pInfo);
            check("raw range_tiles_rgba returns 0 on invalid mode or out-of-row [ry0..ry1)", badMode === 0 && badRow === 0, `badMode=${badMode} badRow=${badRow}`);
        } finally { simd._reset(a); }
    }

    // Route check on K.rangeTilesRgba (rangeLuma & rangeColor)
    {
        K.setKernels("rust");
        const W = 600, H = 256;
        const band = makeRgbaBand(W, H, "stripes");
        const limLuma = { source: "luma", lo: 0.2, hi: 0.8, fLo: 0.08, fHi: 0.08, invert: false };
        const limColor = { source: "color", color: "#5080a0", tol: 30, lo: 0.2, hi: 0.9, fLo: 0.08, fHi: 0.08, invert: false };

        K.setRoute("rangeLuma", "js");
        K.pxCalls(true);
        const lumaJs = K.rangeTilesRgba(band, W, H, 0, 0, H, limLuma, false, 256);
        const lumaJsCalls = K.pxCalls(true).range_tiles_rgba || 0;

        K.setRoute("rangeLuma", "rust");
        const lumaRust = K.rangeTilesRgba(band, W, H, 0, 0, H, limLuma, false, 256);
        const lumaRustCalls = K.pxCalls(true).range_tiles_rgba || 0;
        K.setRoute("rangeLuma", null);

        K.setRoute("rangeColor", "js");
        K.pxCalls(true);
        const colorJs = K.rangeTilesRgba(band, W, H, 0, 0, H, limColor, false, 256);
        const colorJsCalls = K.pxCalls(true).range_tiles_rgba || 0;

        K.setRoute("rangeColor", "rust");
        const colorRust = K.rangeTilesRgba(band, W, H, 0, 0, H, limColor, false, 256);
        const colorRustCalls = K.pxCalls(true).range_tiles_rgba || 0;
        K.setRoute("rangeColor", null);
        K.setKernels("js");

        check("kernels.js rangeTilesRgba routes rangeLuma and rangeColor between twin (0 calls) and rust (1 call) with identical output",
            !twinDiff(lumaRust, lumaJs) && !twinDiff(colorRust, colorJs)
            && lumaJsCalls === 0 && lumaRustCalls === 1 && colorJsCalls === 0 && colorRustCalls === 1,
            `luma=${lumaJsCalls}/${lumaRustCalls} color=${colorJsCalls}/${colorRustCalls}`);
    }

    // ---- K25: limit_alpha_rows (export / fill-layer depth alpha, docs/PLAN_WASM_BUILD.md §4.8) -------------------------

    const refLimitAlphaRows = (rgbaIn, map, mw, mh, xf, x0, y0, w, h, limit, snap = null, guide = null, col = null) => {
        const rgba = new Uint8Array(rgbaIn);
        if (w === 0 || h === 0) return rgba;
        const [a, b, c, d, e, f] = xf;
        const sigmaR = Array.isArray(snap) && snap.length >= 2 ? +snap[0] || 0 : 0;
        const tau = Array.isArray(snap) && snap.length >= 2 ? +snap[1] || 0 : 0;
        const gRaw = guide && guide.data ? guide.data : guide;
        const doSnap = gRaw != null && sigmaR > 0;
        const mapObj = doSnap ? { data: map, w: mw, h: mh } : null;
        const guideObj = doSnap ? { data: gRaw, w: mw, h: mh } : null;
        const maxX = mw - 1, maxY = mh - 1;
        for (let row = 0; row < h; row++) {
            const py = y0 + row + 0.5;
            const rowBase = row * w * 4;
            for (let colIdx = 0; colIdx < w; colIdx++) {
                const off = rowBase + colIdx * 4;
                const aIn = rgba[off + 3];
                if (aIn === 0) continue;
                const px = x0 + colIdx + 0.5;
                const mx = a * px + c * py + e;
                const my = b * px + d * py + f;
                let v;
                if (doSnap) {
                    let pr, pg, pb;
                    if (col != null) {
                        pr = col[off] / 255;
                        pg = col[off + 1] / 255;
                        pb = col[off + 2] / 255;
                    } else {
                        const gx = Math.max(0, Math.min(maxX, Math.floor(mx)));
                        const gy = Math.max(0, Math.min(maxY, Math.floor(my)));
                        const gi = (gy * mw + gx) * 4;
                        pr = gRaw[gi] / 255;
                        pg = gRaw[gi + 1] / 255;
                        pb = gRaw[gi + 2] / 255;
                    }
                    v = refSnapField(mapObj, guideObj, mx, my, pr, pg, pb, sigmaR, tau);
                } else {
                    v = u16Bilinear(map, mw, mh, mx, my);
                }
                v = Math.max(0, Math.min(1, v));
                const wt = rangeWeight(v, limit);
                rgba[off + 3] = Math.min(255, Math.max(0, Math.round(aIn * wt)));
            }
        }
        return rgba;
    };

    const callLimitAlpha = (k, [rgbaIn, map, guideData, colData, colSameAsRgba, mw, mh, xf, x0, y0, w, h, limit, snap]) => {
        const guide = guideData ? { data: guideData, w: mw, h: mh } : null;
        const col = colSameAsRgba ? rgbaIn : colData;
        k.limitAlphaRows(rgbaIn, map, mw, mh, xf, x0, y0, w, h, limit, snap, guide, col);
        return rgbaIn;
    };

    const limitAlphaCases = [];
    for (const [mw, mh, W, H, x0, y0] of [
        [1, 1, 1, 1, 0, 0],
        [7, 5, 13, 9, 3, -2],
        [8, 6, 64, 48, 0, 0],
        [9, 7, 129, 65, 10, 20],
        [15, 11, 257, 40, -5, 12],
        [16, 12, 120, 300, 0, 0], // multi-chunk (> 256 rows)
        [24, 18, 96, 550, 4, 8],  // 3 chunks (256 + 256 + 38 rows)
    ]) {
        const { map } = makeMapPair(mw, mh, (mw + mh) % 2 === 0 ? "ramp" : "random");
        const guideData = new Uint8Array(mw * mh * 4);
        for (let i = 0; i < guideData.length; i++) guideData[i] = (i & 3) === 3 ? 255 : Math.floor(rnd() * 256);
        const xfs = makeXfs(mw, mh, W + Math.abs(x0) * 2, H + Math.abs(y0) * 2);
        const rgbaIn = makeRgbaBand(W, H, (mw & 1) ? "random" : "ramp");
        for (let ci = 0; ci < xfs.length; ci++) {
            const [xName, xf] = xfs[ci];
            const lim = limits[(ci + mw) % limits.length];
            const mode = ci % 4; // 0: plain bilinear, 1: snap with guide (col=null), 2: snap with explicit col, 3: snap with col===rgba
            const snap = mode === 0 ? null : snapParams(45 + (ci % 3) * 20);
            const gData = mode === 0 ? null : guideData;
            let colData = null, colSame = false;
            if (mode === 2) {
                colData = makeRgbaBand(W, H, "stripes");
            } else if (mode === 3) {
                colSame = true;
            }
            limitAlphaCases.push({
                tag: `limit_alpha ${mw}x${mh}->${W}x${H} @(${x0},${y0}) ${xName} mode=${mode} inv=${lim.invert}`,
                args: [rgbaIn, map, gData, colData, colSame, mw, mh, xf, x0, y0, W, H, lim, snap],
            });
        }
    }

    // Exact boundary cases for limit_alpha_rows:
    // 1. Exact even-half: a_in = 255 with 255 * w === 40.5 -> 41, and a_in = 81 with w = 0.5 -> 81 * 0.5 = 40.5 -> 41
    // 2. Hard-step 1e-12 boundary and sstep 1e-14 clamp boundary
    // 3. Input alphas [0, 1, 128, 254, 255] and RGB byte preservation check
    // 4. snapField tau .. 2*tau smoothstep blend, > 2*tau snap, wSum <= 1e-12 fallback
    {
        const mw = 8, mh = 8, W = 64, H = 16;
        const mapHalf = new Uint16Array(mw * mh).fill(16384);
        const limHalf = { lo: 0.9909749217157413, hi: 1.0, fLo: 0.9909749217157413, fHi: 0, invert: false };
        const xf = [mw / W, 0, 0, mh / H, 0, 0];
        const rgba255 = new Uint8Array(W * H * 4);
        for (let i = 0; i < rgba255.length; i += 4) {
            rgba255[i] = (i * 7) & 255;
            rgba255[i + 1] = (i * 13) & 255;
            rgba255[i + 2] = (i * 29) & 255;
            rgba255[i + 3] = 255;
        }
        limitAlphaCases.push({
            tag: "limit_alpha exact even-half 255 * w === 40.5 (-> 41)",
            args: [rgba255, mapHalf, null, null, false, mw, mh, xf, 0, 0, W, H, limHalf, null],
        });
        const gotHalf255 = callLimitAlpha(simd, [new Uint8Array(rgba255), mapHalf, null, null, false, mw, mh, xf, 0, 0, W, H, limHalf, null]);
        let rgbUntouched = true;
        for (let i = 0; i < rgba255.length; i += 4) {
            if (gotHalf255[i] !== rgba255[i] || gotHalf255[i + 1] !== rgba255[i + 1] || gotHalf255[i + 2] !== rgba255[i + 2]) {
                rgbUntouched = false;
                break;
            }
        }
        check("limit_alpha_rows rounds exact even-half 255 * w === 40.5 up to 41 and leaves RGB bytes untouched",
            gotHalf255[3] === 41 && rgbUntouched, `got alpha=${gotHalf255[3]} rgbUntouched=${rgbUntouched}`);

        // Odd input alpha a_in = 81 at exact midpoint w = 0.5 (v = 16384/65535, fLo = 0.2, lo = v + 0.1 -> t = 0.5 -> sstep(0.5) = 0.5 -> 81 * 0.5 = 40.5 -> 41)
        const vExact = 16384 / 65535;
        const limMid = { lo: vExact + 0.05, hi: 1.0, fLo: 0.1, fHi: 0, invert: false };
        const rgba81 = new Uint8Array(rgba255);
        for (let i = 3; i < rgba81.length; i += 4) rgba81[i] = 81;
        limitAlphaCases.push({
            tag: "limit_alpha odd a_in = 81 at w = 0.5 -> 40.5 (-> 41)",
            args: [rgba81, mapHalf, null, null, false, mw, mh, xf, 0, 0, W, H, limMid, null],
        });
        const gotHalf81 = callLimitAlpha(simd, [new Uint8Array(rgba81), mapHalf, null, null, false, mw, mh, xf, 0, 0, W, H, limMid, null]);
        check("limit_alpha_rows rounds 81 * 0.5 === 40.5 up to 41", gotHalf81[3] === 41, `got ${gotHalf81[3]}`);

        // Hard-step 1e-12 and sstep 1e-14 boundaries
        for (const [delta, wantByte] of [[0.5e-12, 255], [-0.5e-12, 255], [2e-12, 0]]) {
            const limTol = { lo: vExact + delta, hi: vExact + 0.1, fLo: 0, fHi: 0, invert: false };
            limitAlphaCases.push({
                tag: `limit_alpha hard-step 1e-12 delta=${delta}`,
                args: [rgba255, mapHalf, null, null, false, mw, mh, xf, 0, 0, W, H, limTol, null],
            });
            const gotTol = callLimitAlpha(simd, [new Uint8Array(rgba255), mapHalf, null, null, false, mw, mh, xf, 0, 0, W, H, limTol, null]);
            check(`limit_alpha_rows hard-step tolerance at delta=${delta} gives byte ${wantByte}`,
                gotTol[3] === wantByte, `got ${gotTol[3]}, want ${wantByte}`);
        }
        for (const frac of [0.5e-14, 2e-14, 0.5, 1 - 2e-14, 1 - 0.5e-14]) {
            const fLo = 0.1;
            const lo = vExact + fLo * (1 - frac);
            limitAlphaCases.push({
                tag: `limit_alpha sstep boundary frac=${frac}`,
                args: [rgba255, mapHalf, null, null, false, mw, mh, xf, 0, 0, W, H, { lo, hi: 1.0, fLo, fHi: 0, invert: false }, null],
            });
        }

        // wSum <= 1e-12 fallback to bilinear in snapField
        const mapStep = new Uint16Array(mw * mh);
        for (let i = 0; i < mapStep.length; i++) mapStep[i] = (i & 1) ? 55000 : 10000;
        const guideBlack = new Uint8Array(mw * mh * 4);
        const colWhite = new Uint8Array(W * H * 4).fill(255);
        limitAlphaCases.push({
            tag: "limit_alpha snapField wSum <= 1e-12 fallback to bilinear",
            args: [rgba255, mapStep, guideBlack, colWhite, false, mw, mh, xf, 0, 0, W, H, { lo: 0.2, hi: 0.8, fLo: 0.1, fHi: 0.1, invert: false }, [0.015, 0.02]],
        });
    }

    let refAlphaOk = true, refAlphaDetail = "";
    for (const c of limitAlphaCases) {
        const a = c.args;
        const got = callLimitAlpha(js, [new Uint8Array(a[0]), ...a.slice(1)]);
        const want = refLimitAlphaRows(a[0], a[1], a[5], a[6], a[7], a[8], a[9], a[10], a[11], a[12], a[13], a[2] ? { data: a[2], w: a[5], h: a[6] } : null, a[4] ? a[0] : a[3]);
        const d = twinDiff(got, want, [], {});
        if (d) { refAlphaOk = false; refAlphaDetail = `${c.tag}: ${d}`; break; }
    }
    check(`js limitAlphaRows equals the plain reference (${limitAlphaCases.length} cases)`, refAlphaOk, refAlphaDetail);

    twinCheck({
        name: "limit_alpha_rows",
        builds: [["rust simd", simd], ["rust scalar", scalar]],
        twin: js,
        call: callLimitAlpha,
        cases: limitAlphaCases,
    });

    // libmExp vs Math.exp tie case (K22-exp-band column x = 127) and Math.exp spy on js.limitAlphaRows
    {
        const mwTie = 128, mhTie = 128, WTie = 256, HTie = 16;
        const mapTie = new Uint16Array(mwTie * mhTie);
        for (let y = 0; y < mhTie; y++) {
            for (let x = 0; x < mwTie; x++) mapTie[y * mwTie + x] = x < 64 ? 16384 : 49151;
        }
        const guideTie = new Uint8Array(mwTie * mhTie * 4).fill(128);
        const rgbaTie = new Uint8Array(WTie * HTie * 4).fill(255);
        const mTie = [0.5, 0, 0, 0.5, 0.25, 0];
        const snapTie = [0.145, 0.02];
        const limTie = { lo: 0.55, hi: 1, fLo: 0.1, fHi: 0, invert: false };
        const origExp = Math.exp;
        let nativeExpCalls = 0;
        Math.exp = (x) => { nativeExpCalls++; return origExp(x); };
        let tieOk = true, tieDetail = "";
        try {
            for (const [bName, k] of [["js", js], ["simd", simd], ["scalar", scalar]]) {
                const out = callLimitAlpha(k, [new Uint8Array(rgbaTie), mapTie, guideTie, null, false, mwTie, mhTie, mTie, 0, 0, WTie, HTie, limTie, snapTie]);
                let n127 = 0, n128 = 0;
                for (let y = 0; y < HTie; y++) {
                    const v = out[(y * WTie + 127) * 4 + 3];
                    if (v === 127) n127++;
                    else if (v === 128) n128++;
                }
                if (n127 !== HTie / 2 || n128 !== HTie / 2) {
                    tieOk = false;
                    tieDetail = `${bName}: got n127=${n127}, n128=${n128} on column x=127`;
                    break;
                }
            }
        } finally {
            Math.exp = origExp;
        }
        check("limit_alpha_rows twin uses libmExp (0 native Math.exp calls) and matches simd/scalar at K22-exp-band tie on column x=127",
            nativeExpCalls === 0 && tieOk, `nativeExpCalls=${nativeExpCalls} ${tieDetail}`);
    }

    // Multi-chunk 256-row windowing check on simd.limitAlphaRows
    {
        const mw = 32, mh = 60, W = 64, H = 600; // 3 chunks: 256 + 256 + 88 rows
        const { map } = makeMapPair(mw, mh, "ramp");
        const guideData = new Uint8Array(mw * mh * 4).fill(120);
        const guide = { data: guideData, w: mw, h: mh };
        const xf = [mw / W, 0, 0, mh / H, 0, 0];
        const lim = { lo: 0.2, hi: 0.8, fLo: 0.05, fHi: 0.05, invert: false };
        const snap = snapParams(50);
        const rgbaSimd = makeRgbaBand(W, H, "ramp");
        const rgbaJs = new Uint8Array(rgbaSimd);
        let maxRgbaBytes = 0, maxMapBytes = 0, chunkCalls = 0;
        const origIn = simd._in;
        simd._in = function (arena, src, bytes) {
            if (src.buffer === rgbaSimd.buffer) {
                chunkCalls++;
                if (bytes > maxRgbaBytes) maxRgbaBytes = bytes;
            } else if (src.buffer === map.buffer) {
                if (bytes > maxMapBytes) maxMapBytes = bytes;
            }
            return origIn.call(this, arena, src, bytes);
        };
        try {
            simd.limitAlphaRows(rgbaSimd, map, mw, mh, xf, 0, 0, W, H, lim, snap, guide, null);
            js.limitAlphaRows(rgbaJs, map, mw, mh, xf, 0, 0, W, H, lim, snap, guide, null);
            check("px.js limitAlphaRows chunks 600 rows into 3 bands (<= 256 rows per chunk) and bounds map window [wy0..wy1]",
                !twinDiff(rgbaSimd, rgbaJs) && chunkCalls === 3 && maxRgbaBytes === 256 * W * 4 && maxMapBytes < map.byteLength,
                `chunkCalls=${chunkCalls} maxRgbaBytes=${maxRgbaBytes} maxMapBytes=${maxMapBytes}/${map.byteLength}`);
        } finally {
            simd._in = origIn;
        }
    }

    // inpaint_limit.js limitAlphaRows integration:
    // 1. Snapped depth limit with map.guide present (col=null) snaps to map.guide sampled at floor(mx), floor(my),
    //    whereas without map.guide it falls back to rgba.
    // 2. Stored depth limits with non-finite fields never throw on export.
    {
        const { limitAlphaRows: limitAlphaRowsHigh } = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_limit.js")).href);
        const { makeMap } = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_maps.js")).href);
        const mw = 20, mh = 12, W = 80, H = 48;
        // Blurred depth step at map x = 10 (canvas x = 40): x <= 7 is 0.2, x = 8 is 0.35, x = 9 is 0.5, x = 10 is 0.65, x >= 11 is 0.8
        const mapData = new Uint16Array(mw * mh);
        const guideData = new Uint8Array(mw * mh * 4);
        for (let y = 0; y < mh; y++) {
            for (let x = 0; x < mw; x++) {
                const i = y * mw + x;
                const d = x <= 7 ? 0.2 : x === 8 ? 0.35 : x === 9 ? 0.5 : x === 10 ? 0.65 : 0.8;
                mapData[i] = Math.round(d * 65535);
                const isRed = x < 10;
                guideData[i * 4] = isRed ? 230 : 20;
                guideData[i * 4 + 1] = 40;
                guideData[i * 4 + 2] = isRed ? 30 : 230;
                guideData[i * 4 + 3] = 255;
            }
        }
        // Solid uniform fill layer (all grey [128, 128, 128, 255]):
        // At x = 39 (mx = 9.875), plain bilinear depth is ~0.556 (> 0.48 -> alpha 0).
        // With map.guide present (col=null), snapRgb reads pure red at floor(9.875)=9 and snaps toward ~0.423 (<= 0.46 -> alpha 255);
        // with col=fillUniformCol (uniform grey) or without map.guide, it does not snap to the red/blue edge (alpha 0).
        const fillWithGuide = new Uint8Array(W * H * 4);
        for (let i = 0; i < fillWithGuide.length; i += 4) {
            fillWithGuide[i] = 128; fillWithGuide[i + 1] = 128; fillWithGuide[i + 2] = 128; fillWithGuide[i + 3] = 255;
        }
        const fillUniformCol = new Uint8Array(fillWithGuide);
        const fillNoGuide = new Uint8Array(fillWithGuide);
        const limSnap = { source: "depth", lo: 0, hi: 0.46, fLo: 0, fHi: 0.02, invert: false };
        const mapWithGuide = makeMap("depth", mw, mh, mapData, [W, 0, 0, H, 0, 0], { snap: { strength: 80 } }, guideData);
        const mapWithoutGuide = makeMap("depth", mw, mh, mapData, [W, 0, 0, H, 0, 0], { snap: { strength: 80 } }, null);

        K.setKernels("rust");
        K.pxCalls(true);
        limitAlphaRowsHigh(fillWithGuide, 0, 0, W, H, limSnap, mapWithGuide);
        const guideCalls = K.pxCalls(true).limit_alpha_rows || 0;
        limitAlphaRowsHigh(fillUniformCol, 0, 0, W, H, limSnap, mapWithGuide, fillUniformCol);
        const colCalls = K.pxCalls(true).limit_alpha_rows || 0;
        limitAlphaRowsHigh(fillNoGuide, 0, 0, W, H, limSnap, mapWithoutGuide);
        const noGuideCalls = K.pxCalls(true).limit_alpha_rows || 0;

        const aLeftGuide = fillWithGuide[(24 * W + 39) * 4 + 3];
        const aRightGuide = fillWithGuide[(24 * W + 40) * 4 + 3];
        const aLeftUniformCol = fillUniformCol[(24 * W + 39) * 4 + 3];
        const aLeftNoGuide = fillNoGuide[(24 * W + 39) * 4 + 3];
        check("inpaint_limit.js limitAlphaRows snaps solid fill layer against map.guide on rust (sharp edge vs uniform col / no-guide)",
            guideCalls === 1 && colCalls === 1 && noGuideCalls === 1
            && aLeftGuide === 255 && aRightGuide === 0
            && aLeftUniformCol === 0 && aLeftNoGuide === 0,
            `calls=${guideCalls}/${colCalls}/${noGuideCalls} guide=[${aLeftGuide},${aRightGuide}] uniformCol=${aLeftUniformCol} noGuide=${aLeftNoGuide}`);

        // Stored depth limits with non-finite fields, bad map.meta.snap.strength, or overflowing corner-y map transforms never throw on export
        let storedOk = true, storedDetail = "";
        const mapBadSnap = makeMap("depth", mw, mh, mapData, [W, 0, 0, H, 0, 0], { snap: { strength: "bad" } }, guideData);
        const mapOverflowXf = makeMap("depth", 4, 2048, new Uint16Array(4 * 2048).fill(32768), [1, 1, 0, 1e-302, 0, 0], { snap: { strength: 50 } }, new Uint8Array(4 * 2048 * 4).fill(128));
        for (const [badLim, mObj, bx0, by0, bw, bh] of [
            [{ source: "depth", lo: "bad", hi: 0.8 }, mapWithGuide, 0, 0, 16, 16],
            [{ source: "depth", lo: 0.2, hi: "bad" }, mapWithGuide, 0, 0, 16, 16],
            [{ source: "depth", lo: 0.2, hi: 0.8, fLo: "bad" }, mapWithGuide, 0, 0, 16, 16],
            [{ source: "depth", lo: 0.2, hi: 0.8, fHi: Infinity }, mapWithGuide, 0, 0, 16, 16],
            [limSnap, mapBadSnap, 0, 0, 16, 16],
            [limSnap, mapOverflowXf, 0, 768, 1200, 256],
        ]) {
            try {
                const buf = new Uint8Array(bw * bh * 4).fill(200);
                limitAlphaRowsHigh(buf, bx0, by0, bw, bh, badLim, mObj);
            } catch (err) {
                storedOk = false;
                storedDetail = `${JSON.stringify(badLim)} @(${bx0},${by0},${bw},${bh}) threw ${err}`;
                break;
            }
        }
        // Also verify px.js limitAlphaRows directly when corner ry00..ry11 overflows to -Inf + Inf = NaN
        if (storedOk) {
            try {
                const buf = new Uint8Array(1200 * 4 * 4).fill(200);
                simd.limitAlphaRows(buf, new Uint16Array(4 * 2048).fill(32768), 4, 2048, [1, -2.048e305, 0, 2.048e305, 0, 0], 0, 1022, 1200, 4, limSnap);
            } catch (err) {
                storedOk = false;
                storedDetail = `px.limitAlphaRows corner-NaN threw ${err}`;
            }
        }
        K.setKernels("js");
        check("inpaint_limit.js limitAlphaRows never throws on stored depth limits with non-finite fields", storedOk, storedDetail);
    }

    // Refusals for limitAlphaRows across twin, simd, and scalar
    {
        const map = new Uint16Array(16 * 16);
        const guide = { data: new Uint8Array(16 * 16 * 4), w: 16, h: 16 };
        const rgba = new Uint8Array(32 * 32 * 4);
        const xf = [0.5, 0, 0, 0.5, 0, 0];
        const lim = { lo: 0.2, hi: 0.8, fLo: 0.05, fHi: 0.05, invert: false };
        const snap = [0.05, 0.02];
        const badCalls = [
            ["null rgba", () => (k) => k.limitAlphaRows(null, map, 16, 16, xf, 0, 0, 32, 32, lim)],
            ["short rgba", () => (k) => k.limitAlphaRows(new Uint8Array(100), map, 16, 16, xf, 0, 0, 32, 32, lim)],
            ["non-u16 map", () => (k) => k.limitAlphaRows(rgba, new Uint8Array(256), 16, 16, xf, 0, 0, 32, 32, lim)],
            ["short map", () => (k) => k.limitAlphaRows(rgba, new Uint16Array(100), 16, 16, xf, 0, 0, 32, 32, lim)],
            ["mw = 0", () => (k) => k.limitAlphaRows(rgba, map, 0, 16, xf, 0, 0, 32, 32, lim)],
            ["w < 0", () => (k) => k.limitAlphaRows(rgba, map, 16, 16, xf, 0, 0, -1, 32, lim)],
            ["non-int x0", () => (k) => k.limitAlphaRows(rgba, map, 16, 16, xf, 1.5, 0, 32, 32, lim)],
            ["short xf", () => (k) => k.limitAlphaRows(rgba, map, 16, 16, [1, 0, 0], 0, 0, 32, 32, lim)],
            ["NaN xf", () => (k) => k.limitAlphaRows(rgba, map, 16, 16, [NaN, 0, 0, 1, 0, 0], 0, 0, 32, 32, lim)],
            ["null limit", () => (k) => k.limitAlphaRows(rgba, map, 16, 16, xf, 0, 0, 32, 32, null)],
            ["NaN limit.lo", () => (k) => k.limitAlphaRows(rgba, map, 16, 16, xf, 0, 0, 32, 32, { lo: NaN, hi: 0.8, fLo: 0, fHi: 0 })],
            ["short snap", () => (k) => k.limitAlphaRows(rgba, map, 16, 16, xf, 0, 0, 32, 32, lim, [0.05], guide)],
            ["NaN snap", () => (k) => k.limitAlphaRows(rgba, map, 16, 16, xf, 0, 0, 32, 32, lim, [NaN, 0.02], guide)],
            ["short guide", () => (k) => k.limitAlphaRows(rgba, map, 16, 16, xf, 0, 0, 32, 32, lim, snap, { data: new Uint8Array(10), w: 16, h: 16 })],
            ["short col", () => (k) => k.limitAlphaRows(rgba, map, 16, 16, xf, 0, 0, 32, 32, lim, snap, guide, new Uint8Array(10))],
        ];
        let allThrew = true, miss = "";
        for (const [label, fn] of badCalls) {
            for (const [kName, k] of [["js", js], ["simd", simd], ["scalar", scalar]]) {
                let threw = false;
                try { fn()(k); } catch { threw = true; }
                if (!threw) { allThrew = false; miss = `${label} on ${kName}`; break; }
            }
            if (!allThrew) break;
        }
        check("limit_alpha_rows refuses invalid inputs across twin, simd, and scalar", allThrew, miss);

        // Raw export returns 1 on valid [wy0..wy0+wh) and 0 when [iy0..iy1] falls outside [wy0..wy0+wh)
        const a = simd.job;
        try {
            const pRgba = simd._in(a, rgba, rgba.byteLength);
            const pMap = simd._in(a, map, map.byteLength);
            const pParams = a.take(12 * 8);
            const pv = simd.view(Float64Array, pParams, 12);
            pv[0] = 0.5; pv[3] = 0.5; pv[6] = 0.2; pv[7] = 0.8; pv[8] = 0.05; pv[9] = 0.05;
            const okValid = simd.exports.limit_alpha_rows(
                pRgba, 0, pMap, 0,
                16, 16, 0, 16,
                0, 0, 32, 32,
                pParams, 0
            );
            const okOutLo = simd.exports.limit_alpha_rows(
                pRgba, 0, pMap, 0,
                16, 16, 5, 4,
                0, 0, 32, 32,
                pParams, 0
            );
            const okOutHi = simd.exports.limit_alpha_rows(
                pRgba, 0, pMap, 0,
                16, 16, 0, 4,
                0, 0, 32, 32,
                pParams, 0
            );
            check("raw limit_alpha_rows returns 0 when [iy0..iy1] falls outside [wy0..wy0+wh)",
                okValid === 1 && okOutLo === 0 && okOutHi === 0,
                `okValid=${okValid} okOutLo=${okOutLo} okOutHi=${okOutHi}`);
        } finally { simd._reset(a); }
    }

    // Route check on K.limitAlphaRows
    {
        K.setKernels("rust");
        const mw = 24, mh = 16, W = 120, H = 80;
        const { map } = makeMapPair(mw, mh, "ramp");
        const guide = { data: new Uint8Array(mw * mh * 4).fill(100), w: mw, h: mh };
        const xf = [mw / W, 0, 0, mh / H, 0, 0];
        const lim = { lo: 0.2, hi: 0.8, fLo: 0.05, fHi: 0.05, invert: false };
        const snap = snapParams(50);
        const bandJs = makeRgbaBand(W, H, "ramp");
        const bandRust = new Uint8Array(bandJs);

        K.setRoute("limitAlphaRows", "js");
        K.pxCalls(true);
        K.limitAlphaRows(bandJs, map, mw, mh, xf, 0, 0, W, H, lim, snap, guide, null);
        const jsCalls = K.pxCalls(true).limit_alpha_rows || 0;

        K.setRoute("limitAlphaRows", "rust");
        K.limitAlphaRows(bandRust, map, mw, mh, xf, 0, 0, W, H, lim, snap, guide, null);
        const rustCalls = K.pxCalls(true).limit_alpha_rows || 0;
        K.setRoute("limitAlphaRows", null);
        K.setKernels("js");

        check("kernels.js limitAlphaRows routes between twin (0 calls) and rust (1 call) with identical output",
            !twinDiff(bandRust, bandJs) && jsCalls === 0 && rustCalls === 1,
            `jsCalls=${jsCalls} rustCalls=${rustCalls}`);
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
        // One 15000 x 256 tile row (59 tiles across), plain bilinear and snapped
        const cols = Math.ceil(W / 256), ty = 10, y0 = 2560, y1 = 2816;
        const lim = { lo: 0.2, hi: 0.8, fLo: 0.05, fHi: 0.05, invert: false };
        const cls = new Uint8Array(cols).fill(2);
        const guideData = new Uint8Array(mw * mh * 4).fill(128);
        const guide = { data: guideData, w: mw, h: mh };
        const pic = { data: new Uint8Array(W * 256 * 4).fill(140), x0: 0, y0, w: W, h: 256 };
        const snap = snapParams(50);
        for (const [what, s, g, p] of [
            ["plain bilinear (59 tiles)", null, null, null],
            ["snapped (59 edge tiles)", snap, guide, pic],
        ]) {
            const rows = [
                ["twin", () => js.rangeTilesDepth(map, mw, mh, xf, W, H, ty, y0, y1, lim, false, s, g, p, cls, 256)],
                ["simd", () => simd.rangeTilesDepth(map, mw, mh, xf, W, H, ty, y0, y1, lim, false, s, g, p, cls, 256)],
                ["scalar", () => scalar.rangeTilesDepth(map, mw, mh, xf, W, H, ty, y0, y1, lim, false, s, g, p, cls, 256)],
            ];
            const med = benchMedians(rows, { rounds: 9 });
            console.log(`       range_tiles_depth 15000x256 row, ${what}: ${rows.map(([n]) => `${n} ${med[n].toFixed(2)}`).join(", ")} ms (median of 9)`);
        }
        const rgbaRow = new Uint8Array(W * 256 * 4);
        for (let i = 0; i < rgbaRow.length; i += 4) {
            rgbaRow[i] = (i * 13) & 255;
            rgbaRow[i + 1] = (i * 29) & 255;
            rgbaRow[i + 2] = (i * 47) & 255;
            rgbaRow[i + 3] = 255;
        }
        const limLumaBench = { source: "luma", lo: 0.2, hi: 0.8, fLo: 0.05, fHi: 0.05, invert: false };
        const limColorBench = { source: "color", color: "#5080a0", tol: 30, lo: 0.25, hi: 1.0, fLo: 0.1, fHi: 0, invert: false };
        for (const [what, limB] of [
            ["luma (59 tiles)", limLumaBench],
            ["colour (59 tiles)", limColorBench],
        ]) {
            const rows = [
                ["twin", () => js.rangeTilesRgba(rgbaRow, W, H, ty, y0, y1, limB, false, 256)],
                ["simd", () => simd.rangeTilesRgba(rgbaRow, W, H, ty, y0, y1, limB, false, 256)],
                ["scalar", () => scalar.rangeTilesRgba(rgbaRow, W, H, ty, y0, y1, limB, false, 256)],
            ];
            const med = benchMedians(rows, { rounds: 9 });
            console.log(`       range_tiles_rgba 15000x256 row, ${what}: ${rows.map(([n]) => `${n} ${med[n].toFixed(2)}`).join(", ")} ms (median of 9)`);
        }
        const rgbaAlphaRow = new Uint8Array(rgbaRow);
        for (const [what, s, g] of [
            ["plain bilinear (15000x256)", null, null],
            ["snapped (15000x256)", snap, guide],
        ]) {
            const rows = [
                ["twin", () => js.limitAlphaRows(rgbaAlphaRow, map, mw, mh, xf, 0, y0, W, 256, lim, s, g, null)],
                ["simd", () => simd.limitAlphaRows(rgbaAlphaRow, map, mw, mh, xf, 0, y0, W, 256, lim, s, g, null)],
                ["scalar", () => scalar.limitAlphaRows(rgbaAlphaRow, map, mw, mh, xf, 0, y0, W, 256, lim, s, g, null)],
            ];
            const med = benchMedians(rows, { rounds: 9 });
            console.log(`       limit_alpha_rows 15000x256 row, ${what}: ${rows.map(([n]) => `${n} ${med[n].toFixed(2)}`).join(", ")} ms (median of 9)`);
        }
    }
}

/**
 * TIFF strip and tile unpacking (K16, docs/PLAN_WASM_BUILD.md §4.6): `tiff_unpack` / `unpackStrip` (`TIFF_JS`) for
 * uncompressed (`1`), LZW (`5`) and PackBits (`32773`) across both wasm builds and the JS twin, stopping at `need`,
 * and every negative error code (`-1`..`-5`).
 */
async function tiffCases(js, simd, scalar, K, T) {
    check("inpaint_tiff.js exports unpackStrip and TIFF_JS.unpackStrip, re-exported by kernels_js.js and kernels.js",
        typeof T.unpackStrip === "function" && !!T.TIFF_JS && T.TIFF_JS.unpackStrip === T.unpackStrip
        && js.unpackStrip === T.unpackStrip && js.tiffUnpack === T.unpackStrip && K.unpackStrip === T.unpackStrip && K.TIFF_JS === T.TIFF_JS);

    // Helper: pack arbitrary (code, width) pairs MSB-first into a byte array.
    const packCodesMsb = (pairs) => {
        const out = [];
        let acc = 0, nacc = 0;
        for (const [code, width] of pairs) {
            acc = (acc << width) | code;
            nacc += width;
            while (nacc >= 8) {
                nacc -= 8;
                out.push((acc >>> nacc) & 255);
            }
            acc &= (1 << nacc) - 1;
        }
        if (nacc > 0) out.push((acc << (8 - nacc)) & 255);
        return Uint8Array.from(out);
    };

    // Standard TIFF 6.0 MSB-first LZW encoder (with optional Clear limit or no initial Clear).
    const lzwEncodeTiff = (data, { clearAt = 4094, initialClear = true, withEoi = true } = {}) => {
        const pairs = [];
        let width = 9, next = 258;
        const table = new Map();
        if (initialClear) pairs.push([256, width]);
        if (data.length > 0) {
            let w = data[0];
            for (let i = 1; i < data.length; i++) {
                const b = data[i];
                const c = table.get(w * 256 + b);
                if (c !== undefined) { w = c; continue; }
                pairs.push([w, width]);
                if (next < 4096) {
                    table.set(w * 256 + b, next++);
                    if (clearAt && next === clearAt) {
                        pairs.push([256, width]);
                        table.clear();
                        next = 258;
                        width = 9;
                    } else if (next > (1 << width) - 1 && width < 12) {
                        width++;
                    }
                }
                w = b;
            }
            pairs.push([w, width]);
            if (next < 4096) {
                next++;
                if (clearAt && next === clearAt) { pairs.push([256, width]); width = 9; }
                else if (next > (1 << width) - 1 && width < 12) width++;
            }
        }
        if (withEoi) pairs.push([257, width]);
        return packCodesMsb(pairs);
    };

    // PackBits encoder (literal runs, repeat runs, and optional 128 no-op bytes).
    const packBitsEncode = (data, { injectNoop = false } = {}) => {
        const out = [];
        let i = 0;
        while (i < data.length) {
            if (injectNoop && (i % 97 === 0)) out.push(128);
            let j = i;
            while (j + 1 < data.length && data[j + 1] === data[i] && j - i < 126) j++;
            const run = j - i + 1;
            if (run >= 2) {
                out.push(257 - run, data[i]);
                i = j + 1;
                continue;
            }
            let k = i;
            while (k < data.length && k - i < 128) {
                if (k + 1 < data.length && data[k + 1] === data[k]) break;
                k++;
            }
            if (k === i) k = i + 1;
            const n = k - i;
            out.push(n - 1);
            for (let m = 0; m < n; m++) out.push(data[i + m]);
            i = k;
        }
        if (injectNoop) out.push(128);
        return Uint8Array.from(out);
    };

    // Build varied test payloads for none (1), LZW (5) and PackBits (32773).
    const rng = (seed) => {
        let s = seed >>> 0;
        return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 16; };
    };
    const r = rng(1601);
    const randomPayload = (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = r() & 255; return b; };
    const runPayload = (n) => {
        const b = new Uint8Array(n);
        let i = 0;
        while (i < n) {
            const len = 1 + (r() % 300), v = r() & 255, mode = r() % 3;
            for (let k = 0; k < len && i < n; k++, i++) {
                b[i] = mode === 0 ? v : mode === 1 ? (v + (k % 3)) & 255 : (k & 1 ? v : 255 - v);
            }
        }
        return b;
    };

    const pSmall = randomPayload(37);
    const pWidths = randomPayload(12000);     // crosses 9 -> 10 -> 11 -> 12-bit LZW widths and resets at 4094
    const pKwKwK = runPayload(16384);         // heavy KwKwK (c === next) runs and alternating pairs
    const pFull4096 = randomPayload(14000);   // encoded with clearAt: 0 so the table fills to 4096 and stays at 4096

    // Frozen hand-derived LZW stream with 2-, 3-, and 4-byte table entries of distinct bytes:
    // 256 (Clear), 10, 20 (258=[10,20]), 30 (259=[20,30]), 258->[10,20] (260=[30,10]),
    // 30 (261=[10,20,30]), 261->[10,20,30] (262=[30,10]), 40 (263=[10,20,30,40]), 263->[10,20,30,40], 257 (EOI)
    const handLzwStream = Uint8Array.from([0x80, 0x02, 0x82, 0x81, 0xE8, 0x10, 0x7A, 0x0A, 0x28, 0x83, 0xC0, 0x40]);
    const handLzwWant = Uint8Array.from([10, 20, 30, 10, 20, 30, 10, 20, 30, 40, 10, 20, 30, 40]);
    // Frozen hand-derived PackBits stream: literal [11,22,33,44], 128 no-op, repeat 4x 77, literal [88,99]
    const handPbStream = Uint8Array.from([3, 11, 22, 33, 44, 128, 253, 77, 1, 88, 99]);
    const handPbWant = Uint8Array.from([11, 22, 33, 44, 77, 77, 77, 77, 88, 99]);

    const cases = [
        // Uncompressed (1)
        { tag: "none small", args: [1, pSmall, pSmall.length], want: pSmall },
        { tag: "none empty", args: [1, pSmall, 0], want: new Uint8Array(0) },
        { tag: "none with trailing padding", args: [1, Uint8Array.from([...pSmall, 99, 100, 101]), pSmall.length], want: pSmall },
        // PackBits (32773)
        { tag: "packbits small", args: [32773, packBitsEncode(pSmall), pSmall.length], want: pSmall },
        { tag: "packbits runs and 128 no-ops", args: [32773, packBitsEncode(pKwKwK, { injectNoop: true }), pKwKwK.length], want: pKwKwK },
        { tag: "packbits stop at need=13", args: [32773, packBitsEncode(pSmall), 13], want: pSmall.subarray(0, 13) },
        { tag: "packbits hand-derived full", args: [32773, handPbStream, 10], want: handPbWant },
        { tag: "packbits hand-derived stop inside literal run (need=2)", args: [32773, handPbStream, 2], want: Uint8Array.from([11, 22]) },
        { tag: "packbits hand-derived stop inside repeat run (need=6)", args: [32773, handPbStream, 6], want: Uint8Array.from([11, 22, 33, 44, 77, 77]) },
        { tag: "packbits trailing lone repeat header after need", args: [32773, Uint8Array.from([...packBitsEncode(pSmall), 200]), pSmall.length], want: pSmall },
        // LZW (5)
        { tag: "lzw small", args: [5, lzwEncodeTiff(pSmall), pSmall.length], want: pSmall },
        { tag: "lzw no initial clear", args: [5, lzwEncodeTiff(pSmall, { initialClear: false }), pSmall.length], want: pSmall },
        { tag: "lzw 9..12-bit widths and resets", args: [5, lzwEncodeTiff(pWidths), pWidths.length], want: pWidths },
        { tag: "lzw KwKwK runs", args: [5, lzwEncodeTiff(pKwKwK), pKwKwK.length], want: pKwKwK },
        { tag: "lzw full 4096 table", args: [5, lzwEncodeTiff(pFull4096, { clearAt: 0 }), pFull4096.length], want: pFull4096 },
        { tag: "lzw stop mid-code at need=511", args: [5, lzwEncodeTiff(pKwKwK), 511], want: pKwKwK.subarray(0, 511) },
        { tag: "lzw hand-derived full", args: [5, handLzwStream, 14], want: handLzwWant },
        { tag: "lzw hand-derived stop 1 byte into 3-byte code (need=7)", args: [5, handLzwStream, 7], want: Uint8Array.from([10, 20, 30, 10, 20, 30, 10]) },
        { tag: "lzw hand-derived stop 2 bytes into 3-byte code (need=8)", args: [5, handLzwStream, 8], want: Uint8Array.from([10, 20, 30, 10, 20, 30, 10, 20]) },
        { tag: "lzw hand-derived stop 2 bytes into 4-byte code (need=12)", args: [5, handLzwStream, 12], want: Uint8Array.from([10, 20, 30, 10, 20, 30, 10, 20, 30, 40, 10, 20]) },
        // Damaged LZW codes (511 beyond table) appended after the needed bytes are ignored once `need` is reached:
        { tag: "lzw damaged code after need", args: [5, packCodesMsb([[256, 9], [65, 9], [66, 9], [258, 9], [511, 9]]), 4], want: Uint8Array.from([65, 66, 65, 66]) },
    ];
    twinCheck({
        name: "tiff_unpack",
        builds: [["rust simd", simd], ["rust scalar", scalar]],
        twin: js,
        call: (k, [comp, src, need]) => k.tiffUnpack(comp, src, need),
        cases,
    });
    const wantProblems = [];
    for (const c of cases) {
        const got = js.tiffUnpack(...c.args);
        if (!eqBytes(got, c.want)) wantProblems.push(c.tag);
    }
    check(`tiff_unpack: all ${cases.length} cases match their reference payloads (including hand-derived mid-code and mid-run stops)`,
        !wantProblems.length, wantProblems.join(", "));

    // Verify caller-supplied output buffer (both 4-arg `out` with larger capacity and 3-arg `need instanceof Uint8Array` overload) on twin, simd and scalar
    const outSources = [[1, pSmall], [5, lzwEncodeTiff(pSmall)], [32773, packBitsEncode(pSmall)]];
    for (const [bname, mod] of [["twin", js], ["simd", simd], ["scalar", scalar]]) {
        let outOk = true;
        for (const [comp, enc] of outSources) {
            const outBuf = new Uint8Array(pSmall.length + 16).fill(0xAA);
            const sub = outBuf.subarray(5, 5 + pSmall.length + 4);
            const ret = mod.tiffUnpack(comp, enc, pSmall.length, sub);
            const sentinelOk = outBuf.subarray(0, 5).every((v) => v === 0xAA) && outBuf.subarray(5 + pSmall.length).every((v) => v === 0xAA);
            if (ret !== sub || !eqBytes(sub.subarray(0, pSmall.length), pSmall) || !sentinelOk) outOk = false;

            const outBuf3 = new Uint8Array(pSmall.length + 12).fill(0x55);
            const subExact = outBuf3.subarray(3, 3 + pSmall.length);
            const ret3 = mod.tiffUnpack(comp, enc, subExact);
            const sentinelOk3 = outBuf3.subarray(0, 3).every((v) => v === 0x55) && outBuf3.subarray(3 + pSmall.length).every((v) => v === 0x55);
            if (ret3 !== subExact || !eqBytes(subExact, pSmall) || !sentinelOk3) outOk = false;
        }
        check(`tiff_unpack (${bname}): writes into caller-supplied out view (4-arg and 3-arg Uint8Array overload) without touching surrounding bytes`, outOk);
    }

    for (const [bname, px] of [["simd", simd], ["scalar", scalar]]) {

        // Verify all negative error codes (-1..-5) match between Rust and JS twin
        const errCases = [
            ["unsupported compression 8 (deflate)", 8, pSmall, pSmall.length, -1, /unsupported/i],
            ["unsupported compression 32946 (deflate)", 32946, pSmall, pSmall.length, -1, /unsupported/i],
            ["unsupported compression 7 (JPEG)", 7, pSmall, pSmall.length, -1, /unsupported/i],
            ["negative need", 1, pSmall, -1, -1, /unsupported/i],
            ["bare ArrayBuffer as src (none)", 1, new ArrayBuffer(16), 4, -1, /unsupported/i],
            ["bare ArrayBuffer as src (LZW)", 5, lzwEncodeTiff(pSmall).buffer, pSmall.length, -1, /unsupported/i],
            ["fake byteLength object as src", 1, { byteLength: 16 }, 4, -1, /unsupported/i],
            ["none truncated", 1, pSmall.subarray(0, 10), 11, -2, /ends early|fewer bytes/i],
            ["PackBits empty truncated", 32773, new Uint8Array(0), 1, -2, /ends early|fewer bytes/i],
            ["PackBits truncated mid-literal", 32773, Uint8Array.from([5, 1, 2, 3]), 5, -2, /ends early|fewer bytes/i],
            ["PackBits truncated after repeat header", 32773, Uint8Array.from([255]), 2, -2, /ends early|fewer bytes/i],
            ["LZW empty truncated", 5, new Uint8Array(0), 1, -2, /ends early|fewer bytes/i],
            ["LZW 1-byte truncated", 5, Uint8Array.from([0x80]), 1, -2, /ends early|fewer bytes/i],
            ["LZW EOI before need", 5, packCodesMsb([[256, 9], [42, 9], [257, 9]]), 2, -2, /ends early|fewer bytes/i],
            ["LZW stream ends before need", 5, packCodesMsb([[256, 9], [42, 9]]), 2, -2, /ends early|fewer bytes/i],
            ["old-style LZW (00 01)", 5, Uint8Array.from([0x00, 0x01, 0x02, 0x03]), 1, -3, /old-style LZW/i],
            ["old-style LZW (00 83)", 5, Uint8Array.from([0x00, 0x83, 0x00]), 1, -3, /old-style LZW/i],
            ["LZW code > 255 at start (before literal)", 5, packCodesMsb([[300, 9], [257, 9]]), 1, -4, /before any literal/i],
            ["LZW code > 255 after Clear (before literal)", 5, packCodesMsb([[256, 9], [65, 9], [256, 9], [258, 9], [257, 9]]), 2, -4, /before any literal/i],
            ["LZW code beyond table (c > next)", 5, packCodesMsb([[256, 9], [65, 9], [259, 9], [257, 9]]), 2, -5, /beyond the table/i],
        ];
        const errProblems = [];
        for (const [what, comp, src, need, wantCode, re] of errCases) {
            let eRust = null, eJs = null;
            try { px.tiffUnpack(comp, src, need, null, "strip 3"); } catch (e) { eRust = e; }
            try { js.tiffUnpack(comp, src, need, null, "strip 3"); } catch (e) { eJs = e; }
            if (!eRust || !eJs) { errProblems.push(`${what}: rust=${!!eRust} js=${!!eJs}`); continue; }
            if (eRust.code !== wantCode || eJs.code !== wantCode) errProblems.push(`${what}: code rust=${eRust.code} js=${eJs.code} want=${wantCode}`);
            if (!re.test(eRust.message) || !re.test(eJs.message)) errProblems.push(`${what}: msg rust="${eRust.message}" js="${eJs.message}"`);
            if (wantCode <= -2 && eRust.message !== eJs.message) errProblems.push(`${what}: messages differ ("${eRust.message}" vs "${eJs.message}")`);
        }
        // Raw export pointer / compression validation
        const rawBadComp = px.exports.tiff_unpack(8, 0, 0, 0, 0) | 0;
        const rawNullSrc = px.exports.tiff_unpack(1, 0, 4, 8, 4) | 0;
        const rawNullOut = px.exports.tiff_unpack(1, 8, 4, 0, 4) | 0;
        const rawZeroNeed = px.exports.tiff_unpack(5, 0, 0, 0, 0) | 0;
        if (rawBadComp !== -1 || rawNullSrc !== -1 || rawNullOut !== -1 || rawZeroNeed !== 0) {
            errProblems.push(`raw export checks: comp=${rawBadComp} nullSrc=${rawNullSrc} nullOut=${rawNullOut} zeroNeed=${rawZeroNeed}`);
        }
        check(`tiff_unpack (${bname}): negative error codes (-1..-5) and messages match the JS twin`, !errProblems.length, errProblems.join(" | "));
    }

    // Fuzz: random, bit-flipped (9..12-bit widths and full 4096 table) and prefix-cut LZW/PackBits streams -> 0 traps, identical across twin, simd and scalar
    {
        const rf = rng(1602);
        const baseLzw9 = lzwEncodeTiff(pKwKwK.subarray(0, 256));
        const baseLzwWidths = lzwEncodeTiff(pWidths);                     // 9 -> 10 -> 11 -> 12-bit widths + Clear resets
        const baseLzwFull = lzwEncodeTiff(pFull4096, { clearAt: 0 });     // 9 -> 12-bit widths, fills table to 4096 and stays at 4096
        const baseLzwSweep = lzwEncodeTiff(pWidths.subarray(0, 2600));    // crosses 9 -> 10 -> 11 -> 12-bit widths (3475 bytes, 3476 prefixes 0..3475)
        const basePb = packBitsEncode(pKwKwK.subarray(0, 256));
        let fuzzFails = 0, fuzzDetail = "";
        const runOne = (fn) => {
            try { return { ok: true, out: fn() }; }
            catch (e) { return { ok: false, code: e.code, msg: e.message }; }
        };
        const checkTrial = (label, comp, stream, need) => {
            const rJs = runOne(() => js.tiffUnpack(comp, stream, need));
            const rSimd = runOne(() => simd.tiffUnpack(comp, stream, need));
            const rScalar = runOne(() => scalar.tiffUnpack(comp, stream, need));
            const same = rJs.ok === rSimd.ok && rJs.ok === rScalar.ok && !simd.trapped && !scalar.trapped
                && (rJs.ok ? (eqBytes(rJs.out, rSimd.out) && eqBytes(rJs.out, rScalar.out)) : (rJs.code === rSimd.code && rJs.code === rScalar.code && rJs.msg === rSimd.msg && rJs.msg === rScalar.msg));
            if (!same) {
                fuzzFails++;
                if (!fuzzDetail) fuzzDetail = `${label} (comp=${comp}, need=${need}): js=${JSON.stringify(rJs)} simd=${JSON.stringify(rSimd)} scalar=${JSON.stringify(rScalar)}`;
            }
        };
        for (let t = 0; t < 240; t++) {
            if (t < 80) {
                const comp = (t & 1) ? 5 : 32773;
                const need = 1 + (rf() % 300);
                const len = rf() % 120;
                const stream = new Uint8Array(len);
                for (let i = 0; i < len; i++) stream[i] = rf() & 255;
                checkTrial(`random-${t}`, comp, stream, need);
            } else if (t < 140) {
                const comp = (t & 1) ? 5 : 32773;
                const base = comp === 5 ? baseLzw9 : basePb;
                const need = 1 + (rf() % 300);
                const stream = base.slice(0, Math.max(1, base.length - (rf() % 20)));
                const flips = 1 + (rf() % 4);
                for (let f = 0; f < flips; f++) stream[(rf() * 65536 + rf()) % stream.length] ^= 1 << (rf() & 7);
                checkTrial(`flip9-${t}`, comp, stream, need);
            } else {
                // Bit-flips and cuts across 10..12-bit code widths, Clear resets, and full 4096-entry LZW tables
                const useFull = (t & 1) === 1;
                const base = useFull ? baseLzwFull : baseLzwWidths;
                const maxNeed = useFull ? pFull4096.length : pWidths.length;
                const cutLen = 512 + ((rf() * 65536 + rf()) % (base.length - 511));
                const stream = base.slice(0, cutLen);
                const need = 512 + ((rf() * 65536 + rf()) % (maxNeed - 511));
                const flips = 1 + (rf() % 6);
                for (let f = 0; f < flips; f++) {
                    const pos = 400 + ((rf() * 65536 + rf()) % Math.max(1, stream.length - 400));
                    stream[pos] ^= 1 << (rf() & 7);
                }
                checkTrial(`flip12-${t}`, 5, stream, need);
            }
        }
        // Sweep every prefix length of a multi-width LZW stream (9 -> 10 -> 11 -> 12 bits)
        for (let k = 0; k <= baseLzwSweep.length; k++) {
            checkTrial(`sweep-${k}`, 5, baseLzwSweep.subarray(0, k), 2600);
        }
        check("tiff_unpack fuzz (random, 9..12-bit & full-4096 bit-flipped, and every-prefix sweep): 0 traps, identical bytes or error codes across twin, simd and scalar",
            fuzzFails === 0 && baseLzwSweep.length > 0, fuzzDetail || `sweepLen=${baseLzwSweep.length} (${baseLzwSweep.length + 1} prefixes)`);
    }

    // kernels.js wrapper check
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
        const enc = lzwEncodeTiff(pSmall);
        K.setKernels("js");
        K.pxCalls(true);
        const outJs = K.tiffUnpack(5, enc, pSmall.length);
        const jsCalls = K.pxCalls(true).tiff_unpack || 0;
        K.setKernels("rust");
        const outRust = K.tiffUnpack(5, enc, pSmall.length);
        const rustCalls = K.pxCalls(true).tiff_unpack || 0;
        // Trap recovery on K.tiffUnpack falls back to the JS twin
        const p = K.rustPx(), realWarn = console.warn;
        let outRec = null, recReplaced = false;
        console.warn = () => {};
        try {
            p.tiffUnpack = function () { return trapIn(this); };
            outRec = K.tiffUnpack(5, enc, pSmall.length);
            recReplaced = K.rustPx() !== p;
        } finally { console.warn = realWarn; }
        K.setKernels("js");
        check("kernels.js tiffUnpack dispatches between JS twin (0 calls) and Rust (1 call) with identical bytes, and recovers from a trap",
            jsCalls === 0 && rustCalls === 1 && eqBytes(outJs, pSmall) && eqBytes(outRust, pSmall) && eqBytes(outRec, pSmall) && recReplaced,
            `jsCalls=${jsCalls} rustCalls=${rustCalls} recReplaced=${recReplaced}`);
    }

    // Live readTiff checks: 1-byte first-piece LZW fix and StripRows/TileRows stopping at `need`
    {
        const mkLittleTiff = (tags, data, offTag = 273, cntTag = 279) => {
            const parts = [];
            let size = 0;
            const push = (b) => { parts.push(b); size += b.length; };
            push(Uint8Array.from([0x49, 0x49, 42, 0, 0, 0, 0, 0]));
            const offsets = [];
            for (const seg of data) { if (size & 1) push(new Uint8Array(1)); offsets.push(size); push(seg); }
            if (size & 1) push(new Uint8Array(1));
            const ifdAt = size;
            const allTags = [...tags, [offTag, 4, offsets], [cntTag, 4, data.map((s) => s.length)]].sort((a, b) => a[0] - b[0]);
            const ifd = new Uint8Array(2 + 12 * allTags.length + 4);
            const dv = new DataView(ifd.buffer);
            dv.setUint16(0, allTags.length, true);
            let extraAt = ifdAt + ifd.length;
            const extras = [];
            allTags.forEach(([tag, type, vals], i) => {
                const tsz = type === 3 ? 2 : 4;
                const payload = new Uint8Array(tsz * vals.length);
                const pdv = new DataView(payload.buffer);
                vals.forEach((v, k) => { if (type === 3) pdv.setUint16(k * 2, v, true); else pdv.setUint32(k * 4, v >>> 0, true); });
                const p = 2 + 12 * i;
                dv.setUint16(p, tag, true); dv.setUint16(p + 2, type, true); dv.setUint32(p + 4, vals.length, true);
                if (payload.length <= 4) ifd.set(payload, p + 8);
                else {
                    if (extraAt & 1) { extras.push(new Uint8Array(1)); extraAt++; }
                    dv.setUint32(p + 8, extraAt, true);
                    extras.push(payload);
                    extraAt += payload.length;
                }
            });
            push(ifd);
            for (const e of extras) push(e);
            const out = new Uint8Array(size);
            let o = 0;
            for (const p of parts) { out.set(p, o); o += p.length; }
            new DataView(out.buffer).setUint32(4, ifdAt, true);
            return out;
        };
        const oneByteFirstBlob = (u8) => ({
            size: u8.byteLength,
            slice(start, end) {
                const sub = u8.subarray(start, end);
                return {
                    async arrayBuffer() { return sub.slice().buffer; },
                    stream() {
                        let step = 0;
                        return new ReadableStream({
                            pull(c) {
                                if (step === 0 && sub.length > 1) { step = 1; c.enqueue(sub.subarray(0, 1)); }
                                else if (step <= 1 && sub.length > 0) { step = 2; c.enqueue(sub.length > 1 ? sub.subarray(1) : sub); }
                                else c.close();
                            },
                        });
                    },
                };
            },
        });
        // 1) LZW 1-byte first piece with byte[0] === byte[1] === 0 and byte[2] odd
        const s1 = Uint8Array.from([0, 0, 8, 10, 20, 30]);
        const strip1 = packCodesMsb([...Array.from(s1, (b) => [b, 9]), [257, 9]]);
        const tiff1 = mkLittleTiff([[256, 4, [2]], [257, 4, [1]], [258, 3, [8, 8, 8]], [259, 3, [5]], [262, 3, [2]], [277, 3, [3]], [278, 4, [1]]], [strip1]);
        let got1 = null;
        await T.readTiff(oneByteFirstBlob(tiff1), { onRows: (rgba) => { got1 = rgba.slice(); } });
        const want1 = Uint8Array.from([0, 0, 8, 255, 10, 20, 30, 255]);
        // Also verify 1-byte first piece on actual old-style LZW [0x00, 0x01, 0x02] is still refused
        const tiffOld = mkLittleTiff([[256, 4, [2]], [257, 4, [1]], [258, 3, [8, 8, 8]], [259, 3, [5]], [262, 3, [2]], [277, 3, [3]], [278, 4, [1]]], [Uint8Array.from([0x00, 0x01, 0x02, 0x03])]);
        let errOld = null;
        try { await T.readTiff(oneByteFirstBlob(tiffOld), { onRows: () => {} }); } catch (e) { errOld = e; }
        check("inpaint_tiff.js readTiff: 1-byte first LZW piece keeps byte[0] when byte[0] === byte[1] and still refuses old-style LZW",
            !!got1 && eqBytes(got1, want1) && !!errOld && /old-style LZW/i.test(errOld.message));

        // 2) StripRows.open and TileRows.tile pass `need` / `want` to unpacked() so damaged codes after `need` are ignored
        const w2 = 16, h2 = 4, s2 = new Uint8Array(w2 * h2 * 3);
        for (let i = 0; i < s2.length; i++) s2[i] = (i * 17 + 3) & 255;
        const badStrip = packCodesMsb([[256, 9], ...Array.from(s2, (b) => [b, 9]), [511, 9]]);
        const tiffStripNeed = mkLittleTiff([[256, 4, [w2]], [257, 4, [h2]], [258, 3, [8, 8, 8]], [259, 3, [5]], [262, 3, [2]], [277, 3, [3]], [278, 4, [h2]]], [badStrip]);
        let gotStrip = null;
        await T.readTiff(new Blob([tiffStripNeed]), { onRows: (rgba) => { gotStrip = rgba.slice(); } });

        const tileSamples = new Uint8Array(16 * 16 * 3);
        tileSamples.set(s2);
        const tilePairs = [[256, 9]];
        for (let i = 0; i < tileSamples.length; i++) {
            if (i > 0 && i % 200 === 0) tilePairs.push([256, 9]);
            tilePairs.push([tileSamples[i], 9]);
        }
        tilePairs.push([511, 9]);
        const badTile = packCodesMsb(tilePairs);
        const tiffTileNeed = mkLittleTiff([[256, 4, [w2]], [257, 4, [h2]], [258, 3, [8, 8, 8]], [259, 3, [5]], [262, 3, [2]], [277, 3, [3]], [322, 4, [16]], [323, 4, [16]]], [badTile], 324, 325);
        let gotTile = null;
        await T.readTiff(new Blob([tiffTileNeed]), { onRows: (rgba) => { gotTile = rgba.slice(); } });
        check("inpaint_tiff.js readTiff: StripRows.open and TileRows.tile stop at `need` / `want` when damaged LZW bytes follow",
            !!gotStrip && !!gotTile && eqBytes(gotStrip, gotTile) && gotStrip[0] === s2[0] && gotStrip[1] === s2[1] && gotStrip[2] === s2[2]);
    }

    // ---- K15: tiff_unpredict, tiff_predict_rgba, tiff_to_rgba, tiffStrip, tiffStripFromPtr, tiffPartJob, tiffKernels ----

    // 1. tiff_unpredict twinCheck on SIMD and scalar (8-bit per=1..5, 16-bit LE/BE per=1..5, padded rowBytes, wraparound, edge cases)
    {
        const unpredictCases = [];
        const makeUnpredictBuf = (rows, rowBytes, seed) => {
            const r = rng(seed);
            const b = new Uint8Array(rows * rowBytes);
            for (let i = 0; i < b.length; i++) b[i] = r() & 255;
            return b;
        };
        // 8-bit per=4 (SIMD 4-pixel prefix sum + tail) across SIMD boundary widths and padded rows
        for (const w of [1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 255, 256, 1001]) {
            const rows = w <= 33 ? 3 : 2;
            const rbTight = w * 4;
            unpredictCases.push({
                tag: `unpredict 8b per=4 w=${w} tight`,
                args: [makeUnpredictBuf(rows, rbTight, 1700 + w), rows, rbTight, w, 4, 8, true],
            });
            if (w <= 65) {
                const rbPad = w * 4 + 7;
                unpredictCases.push({
                    tag: `unpredict 8b per=4 w=${w} pad=+7`,
                    args: [makeUnpredictBuf(rows, rbPad, 1800 + w), rows, rbPad, w, 4, 8, true],
                });
            }
        }
        // 8-bit per=1 (SIMD 16-byte prefix sum + tail)
        for (const w of [1, 2, 3, 7, 15, 16, 17, 31, 32, 33, 47, 48, 49, 64, 257]) {
            const rows = 3;
            unpredictCases.push({
                tag: `unpredict 8b per=1 w=${w} tight`,
                args: [makeUnpredictBuf(rows, w, 1900 + w), rows, w, w, 1, 8, true],
            });
            unpredictCases.push({
                tag: `unpredict 8b per=1 w=${w} pad=+5`,
                args: [makeUnpredictBuf(rows, w + 5, 2000 + w), rows, w + 5, w, 1, 8, true],
            });
        }
        // 8-bit per=3 (RGB 3-byte register loop) and per=2, 5 (scalar loop)
        for (const per of [2, 3, 5]) {
            for (const w of [1, 2, 3, 4, 5, 8, 15, 16, 17, 32, 33, 129]) {
                const rows = 2, rbTight = w * per, rbPad = w * per + 4;
                unpredictCases.push({
                    tag: `unpredict 8b per=${per} w=${w} tight`,
                    args: [makeUnpredictBuf(rows, rbTight, 2100 + per * 100 + w), rows, rbTight, w, per, 8, true],
                });
                unpredictCases.push({
                    tag: `unpredict 8b per=${per} w=${w} pad=+4`,
                    args: [makeUnpredictBuf(rows, rbPad, 2200 + per * 100 + w), rows, rbPad, w, per, 8, true],
                });
            }
        }
        // 16-bit LE and BE across per=1..5, tight and padded, plus explicit 16-bit carry/wraparound edges
        for (const le of [true, false]) {
            for (const per of [1, 2, 3, 4, 5]) {
                for (const w of [1, 2, 3, 4, 7, 16, 17, 33]) {
                    const rows = 2, rbTight = w * per * 2, rbPad = rbTight + 6;
                    unpredictCases.push({
                        tag: `unpredict 16b ${le ? "LE" : "BE"} per=${per} w=${w} tight`,
                        args: [makeUnpredictBuf(rows, rbTight, 3000 + (le ? 0 : 500) + per * 50 + w), rows, rbTight, w, per, 16, le],
                    });
                    unpredictCases.push({
                        tag: `unpredict 16b ${le ? "LE" : "BE"} per=${per} w=${w} pad=+6`,
                        args: [makeUnpredictBuf(rows, rbPad, 4000 + (le ? 0 : 500) + per * 50 + w), rows, rbPad, w, per, 16, le],
                    });
                }
            }
            // Explicit 16-bit wraparound: 0xFFFF + 1 -> 0x0000, 0x00FF + 1 -> 0x0100, 0x8000 + 0x8000 -> 0x0000
            const edge16 = new Uint8Array(4 * 2);
            const dv = new DataView(edge16.buffer);
            [0xFFFF, 0x0001, 0x00FF, 0x8001].forEach((v, i) => dv.setUint16(i * 2, v, le));
            unpredictCases.push({
                tag: `unpredict 16b ${le ? "LE" : "BE"} wraparound`,
                args: [edge16, 1, 8, 4, 1, 16, le],
            });
        }
        // Edge cases: rows=0, pixels=0, pixels=1
        unpredictCases.push(
            { tag: "unpredict rows=0", args: [Uint8Array.from([1, 2, 3, 4]), 0, 4, 1, 4, 8, true] },
            { tag: "unpredict pixels=0", args: [Uint8Array.from([1, 2, 3, 4]), 1, 4, 0, 4, 8, true] },
            { tag: "unpredict pixels=1", args: [Uint8Array.from([10, 20, 30, 40]), 1, 4, 1, 4, 8, true] },
        );
        twinCheck({
            name: "tiff_unpredict",
            builds: [["rust simd", simd], ["rust scalar", scalar]],
            twin: js,
            call: (k, [src, rows, rowBytes, pixels, per, bits, le]) => k.tiffUnpredict(src.slice(), rows, rowBytes, pixels, per, bits, le),
            cases: unpredictCases,
        });

        // Refusal checks on tiff_unpredict
        const uRefBuf = new Uint8Array(32).fill(7);
        const uBadCases = [
            ["bits=4", [uRefBuf, 1, 16, 4, 4, 4, true]],
            ["bits=0", [uRefBuf, 1, 16, 4, 4, 0, true]],
            ["per=0", [uRefBuf, 1, 16, 4, 0, 8, true]],
            ["per=-1", [uRefBuf, 1, 16, 4, -1, 8, true]],
            ["rowBytes < stride (8b)", [uRefBuf, 1, 15, 4, 4, 8, true]],
            ["rowBytes < stride (16b)", [uRefBuf, 1, 31, 4, 4, 16, true]],
            ["buf shorter than rows*rowBytes", [uRefBuf.subarray(0, 15), 1, 16, 4, 4, 8, true]],
            ["negative rows", [uRefBuf, -1, 16, 4, 4, 8, true]],
            ["negative pixels", [uRefBuf, 1, 16, -1, 4, 8, true]],
            ["non-Uint8Array", [new ArrayBuffer(32), 1, 16, 4, 4, 8, true]],
        ];
        const uBadProblems = [];
        for (const [what, args] of uBadCases) {
            for (const [bname, mod] of [["js", js], ["simd", simd], ["scalar", scalar]]) {
                let threw = false;
                try { mod.tiffUnpredict(...args); } catch (_) { threw = true; }
                if (!threw) uBadProblems.push(`${bname} ${what}`);
            }
        }
        if ((simd.exports.tiff_unpredict(0, 16, 1, 16, 4, 4, 8, 1) | 0) !== -1
            || (simd.exports.tiff_unpredict(8, 16, 1, 16, 4, 4, 4, 1) | 0) !== -1
            || (simd.exports.tiff_unpredict(8, 15, 1, 16, 4, 4, 8, 1) | 0) !== -1
            || (simd.exports.tiff_unpredict(0, 0, 0, 16, 4, 4, 8, 1) | 0) !== 0) {
            uBadProblems.push("raw tiff_unpredict export validation");
        }
        check("tiff_unpredict refuses invalid bits, per, rowBytes, and truncated buffers across twin, simd and scalar",
            !uBadProblems.length, uBadProblems.join(", "));
    }

    // 2. tiff_predict_rgba twinCheck on SIMD and scalar + round-trip with tiff_unpredict
    {
        const predictCases = [];
        const makeRgba = (w, rows, extra, seed) => {
            const r = rng(seed);
            const b = new Uint8Array(w * rows * 4 + extra);
            for (let i = 0; i < b.length; i++) b[i] = r() & 255;
            return b;
        };
        for (const w of [1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 255, 256, 1001]) {
            const rows = w <= 65 ? 3 : 2;
            predictCases.push({
                tag: `predict_rgba w=${w} rows=${rows}`,
                args: [makeRgba(w, rows, 0, 5000 + w), w, rows],
            });
            if (w <= 33) {
                predictCases.push({
                    tag: `predict_rgba w=${w} rows=${rows} trailing=+9B`,
                    args: [makeRgba(w, rows, 9, 5200 + w), w, rows],
                });
            }
        }
        // Underflow wraparound case: [255, 128, 1, 0,  0, 0, 0, 255] -> diff = [1, 128, 255, 255]
        predictCases.push(
            { tag: "predict_rgba wraparound", args: [Uint8Array.from([255, 128, 1, 0, 0, 0, 0, 255]), 2, 1] },
        );
        twinCheck({
            name: "tiff_predict_rgba",
            builds: [["rust simd", simd], ["rust scalar", scalar]],
            twin: js,
            call: (k, [src, w, rows]) => k.tiffPredictRgba(src.slice(), w, rows),
            cases: predictCases,
        });

        // Round-trip: tiff_unpredict(tiff_predict_rgba(src)) === src across all widths
        let rtOk = true, rtDetail = "";
        for (const c of predictCases) {
            const [src, w, rows] = c.args;
            if (w <= 0 || rows <= 0) continue;
            for (const [bname, mod] of [["simd", simd], ["scalar", scalar]]) {
                const work = src.slice(0, w * rows * 4);
                mod.tiffPredictRgba(work, w, rows);
                mod.tiffUnpredict(work, rows, w * 4, w, 4, 8, true);
                if (!eqBytes(work, src.subarray(0, w * rows * 4))) {
                    rtOk = false;
                    rtDetail = `${bname} ${c.tag}`;
                    break;
                }
            }
            if (!rtOk) break;
        }
        check("tiff_predict_rgba + tiff_unpredict round-trips back to the original RGBA bytes across all widths", rtOk, rtDetail);

        // Refusal checks on tiff_predict_rgba
        const pRefBuf = new Uint8Array(16);
        const pBadCases = [
            ["w=0", [pRefBuf, 0, 1]],
            ["rows=0", [pRefBuf, 1, 0]],
            ["negative w", [pRefBuf, -1, 1]],
            ["negative rows", [pRefBuf, 1, -1]],
            ["short rgba", [pRefBuf.subarray(0, 15), 2, 2]],
            ["non-Uint8Array", [new ArrayBuffer(16), 2, 1]],
        ];
        const pBadProblems = [];
        for (const [what, args] of pBadCases) {
            for (const [bname, mod] of [["js", js], ["simd", simd], ["scalar", scalar]]) {
                let threw = false;
                try { mod.tiffPredictRgba(...args); } catch (_) { threw = true; }
                if (!threw) pBadProblems.push(`${bname} ${what}`);
            }
        }
        if ((simd.exports.tiff_predict_rgba(0, 2, 1) | 0) !== -1
            || (simd.exports.tiff_predict_rgba(8, -1, 1) | 0) !== -1
            || (simd.exports.tiff_predict_rgba(8, 0, 1) | 0) !== -1
            || (simd.exports.tiff_predict_rgba(8, 1, 0) | 0) !== -1) {
            pBadProblems.push("raw tiff_predict_rgba export validation");
        }
        check("tiff_predict_rgba refuses non-positive dimensions, short buffers, and null pointers", !pBadProblems.length, pBadProblems.join(", "));
    }

    // 3. tiff_to_rgba twinCheck on SIMD and scalar across every converter branch, all 65,536 premultiplied pairs, all 65,536 16-bit values, and sub-byte palette + alpha
    {
        const toRgbaCases = [];
        const makePlaneBufs = (planes, n, rowBytes, seed) => {
            const r = rng(seed);
            return Array.from({ length: planes }, () => {
                const b = new Uint8Array(n * rowBytes);
                for (let i = 0; i < b.length; i++) b[i] = r() & 255;
                return b;
            });
        };
        const makePalette = (bits, seed) => {
            const r = rng(seed);
            const entries = 1 << bits;
            const cm = new Array(3 * entries);
            for (let i = 0; i < cm.length; i++) cm[i] = r() & 0xFFFF;
            return js.paletteLut(cm, bits);
        };

        let seedCounter = 6000;
        // Sweep photometric (0, 1, 2, 3) x bits (1, 2, 4, 8, 16) x planar (chunky, planar) x alpha ("none", "straight", "premultiplied") x extra channels x padded rowBytes
        for (const photometric of [0, 1, 2, 3]) {
            const base = photometric === 2 ? 3 : 1;
            const bitList = photometric === 2 ? [8, 16] : photometric === 3 ? [1, 2, 4, 8, 16] : [1, 2, 4, 8, 16];
            for (const bits of bitList) {
                const leList = bits === 16 ? [true, false] : [true];
                const pal = photometric === 3 ? makePalette(bits, ++seedCounter) : null;
                for (const le of leList) {
                    for (const alpha of ["none", "straight", "premultiplied"]) {
                        const extraChannels = bits === 8 && alpha === "straight" ? [0, 1] : [0];
                        for (const extra of extraChannels) {
                            const spp = base + (alpha === "none" ? 0 : 1) + extra;
                            const planeModes = spp > 1 ? [1, spp] : [1];
                            for (const planes of planeModes) {
                                const w = bits < 8 ? 11 : 9, n = 3;
                                const spw = planes === 1 ? w * spp : w;
                                const minRb = Math.ceil((spw * bits) / 8);
                                for (const pad of [0, 3]) {
                                    const rowBytes = minRb + pad;
                                    const bufs = makePlaneBufs(planes, n, rowBytes, ++seedCounter);
                                    // For 8-bit and 16-bit palette, clamp index samples in plane 0 / channel 0 to valid range while also testing saturation
                                    toRgbaCases.push({
                                        tag: `toRgba photo=${photometric} bits=${bits}${bits === 16 ? (le ? "LE" : "BE") : ""} spp=${spp} planes=${planes} alpha=${alpha} pad=${pad}`,
                                        args: [bufs, n, { w, rowBytes, spp, bits, planes, le, photometric, alpha, pal }],
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        // Question 6.4 explicit cases: 1, 2, and 4-bit palette + alpha, chunky and planar, straight and premultiplied, covering every (idx, alpha) pair
        for (const bits of [1, 2, 4]) {
            const nEntries = 1 << bits, max = nEntries - 1;
            const pal = new Uint8Array(nEntries * 3);
            for (let i = 0; i < nEntries; i++) {
                pal[i * 3] = (i * 73 + 29) & 255;
                pal[i * 3 + 1] = (i * 51 + 90) & 255;
                pal[i * 3 + 2] = (i * 97 + 140) & 255;
            }
            const totalPairs = nEntries * nEntries;
            const w = nEntries * nEntries, n = 1;
            const packVals = (vals) => {
                const out = new Uint8Array(Math.ceil((vals.length * bits) / 8));
                for (let i = 0; i < vals.length; i++) {
                    const bIdx = Math.floor((i * bits) / 8);
                    const shift = 8 - bits - ((i * bits) % 8);
                    out[bIdx] |= (vals[i] & max) << shift;
                }
                return out;
            };
            const chunkyVals = [], p0Vals = [], p1Vals = [];
            for (let idx = 0; idx < nEntries; idx++) {
                for (let a = 0; a < nEntries; a++) {
                    chunkyVals.push(idx, a);
                    p0Vals.push(idx);
                    p1Vals.push(a);
                }
            }
            const chunkyBuf = packVals(chunkyVals);
            const p0Buf = packVals(p0Vals), p1Buf = packVals(p1Vals);
            for (const alpha of ["straight", "premultiplied"]) {
                toRgbaCases.push({
                    tag: `Q6.4exhaustive ${bits}b chunky ${alpha} (${totalPairs} pairs)`,
                    args: [[chunkyBuf], n, { w, rowBytes: chunkyBuf.length, spp: 2, bits, planes: 1, le: true, photometric: 3, alpha, pal }],
                });
                toRgbaCases.push({
                    tag: `Q6.4exhaustive ${bits}b planar ${alpha} (${totalPairs} pairs)`,
                    args: [[p0Buf, p1Buf], n, { w, rowBytes: p0Buf.length, spp: 2, bits, planes: 2, le: true, photometric: 3, alpha, pal }],
                });
            }
        }

        twinCheck({
            name: "tiff_to_rgba",
            builds: [["rust simd", simd], ["rust scalar", scalar]],
            twin: js,
            call: (k, [bufs, n, spec]) => k.tiffToRgba(bufs, n, null, spec),
            cases: toRgbaCases,
        });

        // Exhaustive 65,536 (alpha, colour) premultiplied pairs on chunky RGBA8 and planar Grey+Alpha8
        {
            const w = 256, n = 256, totalPx = w * n;
            const chunky = new Uint8Array(totalPx * 4);
            const pGrey = new Uint8Array(totalPx), pAlpha = new Uint8Array(totalPx);
            for (let a = 0; a < 256; a++) {
                for (let c = 0; c < 256; c++) {
                    const p = a * 256 + c, o = p * 4;
                    chunky[o] = c;
                    chunky[o + 1] = 255 - c;
                    chunky[o + 2] = (c * 7 + a * 3) & 255;
                    chunky[o + 3] = a;
                    pGrey[p] = c;
                    pAlpha[p] = a;
                }
            }
            const specChunky = { w, rowBytes: w * 4, spp: 4, bits: 8, planes: 1, le: true, photometric: 2, alpha: "premultiplied", pal: null };
            const specPlanar = { w, rowBytes: w, spp: 2, bits: 8, planes: 2, le: true, photometric: 1, alpha: "premultiplied", pal: null };
            const wantChunky = js.tiffToRgba([chunky], n, null, specChunky);
            const wantPlanar = js.tiffToRgba([pGrey, pAlpha], n, null, specPlanar);
            const gotSimdC = simd.tiffToRgba([chunky], n, null, specChunky);
            const gotScalC = scalar.tiffToRgba([chunky], n, null, specChunky);
            const gotSimdP = simd.tiffToRgba([pGrey, pAlpha], n, null, specPlanar);
            const gotScalP = scalar.tiffToRgba([pGrey, pAlpha], n, null, specPlanar);
            // Verify A=0 gives RGB=0,0,0 and A=255 gives RGB=C verbatim
            let edgeOk = true;
            for (let c = 0; c < 256; c++) {
                const o0 = c * 4, o255 = (255 * 256 + c) * 4;
                if (wantChunky[o0] !== 0 || wantChunky[o0 + 1] !== 0 || wantChunky[o0 + 2] !== 0 || wantChunky[o0 + 3] !== 0) edgeOk = false;
                if (wantChunky[o255] !== c || wantChunky[o255 + 1] !== 255 - c || wantChunky[o255 + 3] !== 255) edgeOk = false;
            }
            check("tiff_to_rgba exhaustive 65,536 (alpha, colour) premultiplied pairs (A=0 -> 0, A=255 -> pass, 0<A<255 rounded): 0 bytes differ across twin, simd and scalar",
                edgeOk && eqBytes(gotSimdC, wantChunky) && eqBytes(gotScalC, wantChunky) && eqBytes(gotSimdP, wantPlanar) && eqBytes(gotScalP, wantPlanar),
                firstDiff(gotSimdC, wantChunky) || firstDiff(gotScalC, wantChunky) || firstDiff(gotSimdP, wantPlanar) || firstDiff(gotScalP, wantPlanar));
        }

        // Exhaustive 65,536 16-bit values (LE and BE)
        {
            const w = 256, n = 256, totalPx = w * n;
            const bufLe = new Uint8Array(totalPx * 2), bufBe = new Uint8Array(totalPx * 2);
            const dvLe = new DataView(bufLe.buffer), dvBe = new DataView(bufBe.buffer);
            for (let v = 0; v < 65536; v++) {
                dvLe.setUint16(v * 2, v, true);
                dvBe.setUint16(v * 2, v, false);
            }
            const specLe = { w, rowBytes: w * 2, spp: 1, bits: 16, planes: 1, le: true, photometric: 1, alpha: "none", pal: null };
            const specBe = { w, rowBytes: w * 2, spp: 1, bits: 16, planes: 1, le: false, photometric: 1, alpha: "none", pal: null };
            const wantLe = js.tiffToRgba([bufLe], n, null, specLe);
            const wantBe = js.tiffToRgba([bufBe], n, null, specBe);
            const gotSimdLe = simd.tiffToRgba([bufLe], n, null, specLe);
            const gotScalLe = scalar.tiffToRgba([bufLe], n, null, specLe);
            const gotSimdBe = simd.tiffToRgba([bufBe], n, null, specBe);
            const gotScalBe = scalar.tiffToRgba([bufBe], n, null, specBe);
            check("tiff_to_rgba exhaustive 65,536 16-bit values (LE and BE): 0 bytes differ across twin, simd and scalar",
                eqBytes(wantLe, wantBe) && eqBytes(gotSimdLe, wantLe) && eqBytes(gotScalLe, wantLe) && eqBytes(gotSimdBe, wantBe) && eqBytes(gotScalBe, wantBe),
                firstDiff(gotSimdLe, wantLe) || firstDiff(gotSimdBe, wantBe));
        }

        // Caller-supplied `out` view with surrounding sentinel bytes
        {
            const w = 17, n = 3, src = new Uint8Array(w * n * 4);
            for (let i = 0; i < src.length; i++) src[i] = (i * 29 + 11) & 255;
            const spec = { w, rowBytes: w * 4, spp: 4, bits: 8, planes: 1, le: true, photometric: 2, alpha: "straight", pal: null };
            let outOk = true;
            for (const mod of [js, simd, scalar]) {
                const backing = new Uint8Array(src.length + 20).fill(0xAA);
                const sub = backing.subarray(7, 7 + src.length + 5);
                const ret = mod.tiffToRgba([src], n, sub, spec);
                if (ret !== sub || !eqBytes(sub.subarray(0, src.length), src)
                    || !backing.subarray(0, 7).every((v) => v === 0xAA)
                    || !backing.subarray(7 + src.length).every((v) => v === 0xAA)) {
                    outOk = false;
                }
            }
            check("tiff_to_rgba writes into caller-supplied out view without touching surrounding bytes", outOk);
        }

        // Refusal checks on tiff_to_rgba
        {
            const validBuf = new Uint8Array(16 * 4);
            const baseSpec = { w: 4, rowBytes: 16, spp: 4, bits: 8, planes: 1, le: true, photometric: 2, alpha: "straight", pal: null };
            const badSpecs = [
                ["invalid bits=3", [validBuf], 1, { ...baseSpec, bits: 3 }],
                ["invalid photometric=4", [validBuf], 1, { ...baseSpec, photometric: 4 }],
                ["invalid planes=3", [validBuf, validBuf, validBuf], 1, { ...baseSpec, planes: 3 }],
                ["rowBytes < minRowBytes", [validBuf], 1, { ...baseSpec, rowBytes: 15 }],
                ["short plane buffer", [validBuf.subarray(0, 15)], 1, baseSpec],
                ["palette without pal", [validBuf], 1, { ...baseSpec, spp: 1, rowBytes: 4, photometric: 3, alpha: "none", pal: null }],
                ["negative w", [validBuf], 1, { ...baseSpec, w: -1 }],
                ["negative rows", [validBuf], -1, baseSpec],
            ];
            const badProblems = [];
            for (const [what, bufs, n, spec] of badSpecs) {
                for (const [bname, mod] of [["js", js], ["simd", simd], ["scalar", scalar]]) {
                    let threw = false;
                    try { mod.tiffToRgba(bufs, n, null, spec); } catch (_) { threw = true; }
                    if (!threw) badProblems.push(`${bname} ${what}`);
                }
            }
            if ((simd.exports.tiff_to_rgba(0, 16, 1, 16, 4, 1, 4, 8, 1, 2, 2, 0, 0, 8, 16) | 0) !== -1
                || (simd.exports.tiff_to_rgba(8, 16, 1, 16, 4, 1, 4, 8, 1, 2, 2, 0, 0, 0, 16) | 0) !== -1
                || (simd.exports.tiff_to_rgba(0, 0, 1, 16, 4, 0, 4, 8, 1, 2, 2, 0, 0, 0, 0) | 0) !== -1) {
                badProblems.push("raw tiff_to_rgba export validation");
            }
            check("tiff_to_rgba refuses invalid specs, short buffers, missing palette LUTs, and null pointers", !badProblems.length, badProblems.join(", "));
        }
    }

    // 4. tiffStrip, tiffStripFromPtr, tiffPartJob, tiffKernels, routes, and trap/OOM recovery
    {
        const P = await import(pathToFileURL(path.join(PX_DIR, "px.js")).href);
        const W = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_worker.js")).href);
        const bands = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_bands.js")).href);
        const TILE = 256, TILE_BYTES = TILE * TILE * 4;
        const makeTile = (seed) => {
            const u8 = new Uint8Array(TILE_BYTES);
            const r = rng(seed);
            for (let i = 0; i < TILE_BYTES; i++) u8[i] = r() & 255;
            return { data: u8.buffer };
        };

        // 4a. p.tiffStrip and p.tiffStripFromPtr on both simd and scalar vs T.tiffPart(args, (b) => p.zlib(b, level))
        const row0 = [makeTile(701), null];
        const row1 = [makeTile(702), makeTile(703)];
        const snap = { width: 300, height: 320, tileRowNames: (ty) => (ty === 0 ? row0 : ty === 1 ? row1 : [null, null]) };
        const tileSource = bands.tileRows(snap, true);
        const partTile = await tileSource.part(176, 80, false);
        const tileMsg = { ...partTile.args, w: 300, rows: 80, predictor: 2, level: 2 };
        const tileRgba = W.rowsOfTiles(tileMsg, false);

        const stackMsg = {
            w: 280, rows: 48, y: 16, x0: 0, y0: 0, predictor: 2, level: 2,
            stack: {
                base: { x: 0, y: 0, w: 280, h: 256, tiles: { 0: [makeTile(704), makeTile(705)] } },
                layers: [
                    { x: 0, y: 0, w: 280, h: 256, alpha: 210, op: 5, tiles: { 0: [makeTile(706), makeTile(707)] } },
                ],
            },
        };
        const stackRgba = W.rowsOfStack(stackMsg, false);

        for (const [bname, px] of [["simd", simd], ["scalar", scalar]]) {
            let stripOk = true, stripDetail = "";
            for (const pred of [2, 1, undefined]) {
                for (const level of [1, 2, 6]) {
                    const keep = tileRgba.slice();
                    const args = pred === undefined ? { rgba: keep, w: 300, rows: 80 } : { rgba: keep, w: 300, rows: 80, predictor: pred };
                    const want = await T.tiffPart(args, (b) => px.zlib(b, level));
                    const got = px.tiffStrip(args, level);
                    if (!eqBytes(keep, tileRgba) || got.raw !== want.raw || !eqBytes(new Uint8Array(got.chunk), new Uint8Array(want.chunk))) {
                        stripOk = false;
                        stripDetail = `tiffStrip pred=${pred} level=${level}`;
                        break;
                    }
                    // Also test tiffStripFromPtr on tileMsg and stackMsg
                    for (const [mName, msg, refRgba] of [["tiles", { ...tileMsg, predictor: pred, level }, tileRgba], ["stack", { ...stackMsg, predictor: pred, level }, stackRgba]]) {
                        const a = px.job;
                        let gotPtr;
                        try {
                            const laps = {};
                            const ptrs = W.partPtrOf(px, a, msg, false);
                            gotPtr = px.tiffStripFromPtr(a, ptrs.pr, msg.w, msg.rows, level, msg.predictor, laps);
                            if (typeof laps.predict !== "number" || typeof laps.deflate !== "number") {
                                stripOk = false;
                                stripDetail = `tiffStripFromPtr laps missing on ${mName}`;
                            }
                        } finally {
                            px._reset(a);
                        }
                        const wantPtr = await T.tiffPart(
                            pred === undefined ? { rgba: refRgba, w: msg.w, rows: msg.rows } : { rgba: refRgba, w: msg.w, rows: msg.rows, predictor: pred },
                            (b) => px.zlib(b, level),
                        );
                        if (gotPtr.raw !== wantPtr.raw || !eqBytes(new Uint8Array(gotPtr.chunk), new Uint8Array(wantPtr.chunk))) {
                            stripOk = false;
                            stripDetail = `tiffStripFromPtr ${mName} pred=${pred} level=${level}`;
                            break;
                        }
                    }
                    if (!stripOk) break;
                }
                if (!stripOk) break;
            }
            check(`tiffStrip and tiffStripFromPtr (${bname}): byte-identical to tiffPart(args, p.zlib) across predictors 2/1/default, levels 1/2/6, tiles and stack`,
                stripOk, stripDetail);
        }

        // 4b. Worker tiffPartJob(msg): routes (composeTiles, composeStack, tiffStripWasm, tiffPredict), arena reset, releaseIfLarge, and trap/OOM fallback
        K.setKernels("rust");
        const rgbaMsg = { rgba: tileRgba.slice().buffer, w: 300, rows: 80, predictor: 2 };
        const wantTileStrip = await T.tiffPart({ rgba: tileRgba, w: 300, rows: 80, predictor: 2 }, (b) => simd.zlib(b, 2));
        const wantStackStrip = await T.tiffPart({ rgba: stackRgba, w: 280, rows: 48, predictor: 2 }, (b) => simd.zlib(b, 2));

        const rTileRust = await W.tiffPartJob(tileMsg);
        const jobBytesTile = K.rustPx().job.jobBytes;
        const rStackRust = await W.tiffPartJob(stackMsg);
        const jobBytesStack = K.rustPx().job.jobBytes;
        const rRgbaRust = await W.tiffPartJob(rgbaMsg);
        const jobBytesAfter = jobBytesTile + jobBytesStack + K.rustPx().job.jobBytes;
        const chunksAfter = K.rustPx().job.chunks.length;

        let rel0, rel1;
        K.setRoute("releaseMB", 0);
        try {
            rel0 = K.pxInstances().release;
            await W.tiffPartJob(stackMsg);
            rel1 = K.pxInstances().release;
        } finally {
            K.setRoute("releaseMB", null);
        }

        K.setRoute("composeTiles", "js");
        const rTileJsCompose = await W.tiffPartJob(tileMsg);
        K.setRoute("composeTiles", null);

        K.setRoute("composeStack", "js");
        const rStackJsCompose = await W.tiffPartJob(stackMsg);
        K.setRoute("composeStack", null);

        K.setRoute("tiffStripWasm", "js");
        const rTileJsStrip = await W.tiffPartJob(tileMsg);
        K.setRoute("tiffStripWasm", null);

        K.setRoute("tiffPredict", "js");
        const rTileJsPred = await W.tiffPartJob(tileMsg);
        K.setRoute("tiffPredict", null);

        const workerRoutesOk = rTileRust.timing.composeWasm === 1 && rStackRust.timing.composeWasm === 1 && rRgbaRust.timing.composeWasm === 0
            && rTileJsCompose.timing.composeWasm === 0 && rStackJsCompose.timing.composeWasm === 0
            && rTileJsStrip.timing.composeWasm === 0 && rTileJsPred.timing.composeWasm === 0
            && jobBytesAfter === 0 && chunksAfter === 1 && rel1 === rel0 + 1
            && eqBytes(new Uint8Array(rTileRust.chunk), new Uint8Array(wantTileStrip.chunk))
            && eqBytes(new Uint8Array(rRgbaRust.chunk), new Uint8Array(wantTileStrip.chunk))
            && eqBytes(new Uint8Array(rTileJsCompose.chunk), new Uint8Array(wantTileStrip.chunk))
            && eqBytes(new Uint8Array(rTileJsStrip.chunk), new Uint8Array(wantTileStrip.chunk))
            && eqBytes(new Uint8Array(rTileJsPred.chunk), new Uint8Array(wantTileStrip.chunk))
            && eqBytes(new Uint8Array(rStackRust.chunk), new Uint8Array(wantStackStrip.chunk))
            && eqBytes(new Uint8Array(rStackJsCompose.chunk), new Uint8Array(wantStackStrip.chunk));
        check("inpaint_worker.js tiffPartJob: composeWasm=1 on tiles/stack, composeWasm=0 on rgba or js routes, resets p.job, calls releaseIfLarge(), and gives byte-identical strips to tiffPart(args, p.zlib)",
            workerRoutesOk,
            `tile=${rTileRust.timing.composeWasm} stack=${rStackRust.timing.composeWasm} rgba=${rRgbaRust.timing.composeWasm} jobBytes=${jobBytesAfter} rel=${rel0}->${rel1}`);

        // Simulated OOM and trap in tiffPartJob (both in partPtrOf/tiffStripFromPtr and in tiffStrip)
        const realWarn = console.warn;
        console.warn = () => {};
        try {
            let p0 = K.rustPx(), i0 = K.pxInstances();
            p0.tiffStripFromPtr = () => { throw new P.PxOutOfMemory(1024); };
            const sOom = await W.tiffPartJob(stackMsg);
            let i1 = K.pxInstances();
            const oomPtrOk = sOom.timing.composeWasm === 0 && K.rustPx() !== p0 && i1.oom === i0.oom + 1
                && eqBytes(new Uint8Array(sOom.chunk), new Uint8Array(wantStackStrip.chunk));

            p0 = K.rustPx(); i0 = K.pxInstances();
            p0.tiffStripFromPtr = function () { return trapIn(this); };
            const tTrap = await W.tiffPartJob(tileMsg);
            i1 = K.pxInstances();
            const trapPtrOk = tTrap.timing.composeWasm === 0 && K.rustPx() !== p0 && i1.trap === i0.trap + 1
                && eqBytes(new Uint8Array(tTrap.chunk), new Uint8Array(wantTileStrip.chunk));

            p0 = K.rustPx(); i0 = K.pxInstances();
            p0.tiffStrip = function () { return trapIn(this); };
            const rTrap = await W.tiffPartJob(rgbaMsg);
            i1 = K.pxInstances();
            const trapRgbaOk = rTrap.timing.composeWasm === 0 && K.rustPx() !== p0 && i1.trap === i0.trap + 1
                && rTrap.raw === wantTileStrip.raw;

            check("inpaint_worker.js tiffPartJob recovers from OOM and wasm traps in tiffStripFromPtr and tiffStrip, renews the instance, and falls back cleanly",
                oomPtrOk && trapPtrOk && trapRgbaOk,
                `oomPtr=${oomPtrOk} trapPtr=${trapPtrOk} trapRgba=${trapRgbaOk}`);
        } finally {
            console.warn = realWarn;
        }

        // 4c. tiffKernels() per-call rustPx() lookup across instance replacement + route switching + in-place trap safety
        const tk = K.tiffKernels();
        const pBefore = K.rustPx();
        K.dropPx("idle");
        const pAfter = K.rustPx();
        const sampleRgba = new Uint8Array(16 * 4);
        for (let i = 0; i < sampleRgba.length; i++) sampleRgba[i] = (i * 19 + 5) & 255;
        const spec4c = { w: 16, rowBytes: 64, spp: 4, bits: 8, planes: 1, le: true, photometric: 2, alpha: "straight", pal: null };

        K.pxCalls(true);
        const uRust = tk.unpredict(sampleRgba.slice(), 1, 64, 16, 4, 8, true);
        const pRust = tk.predictRgba(sampleRgba.slice(), 16, 1);
        const cRust = tk.toRgba([sampleRgba], 1, null, spec4c);
        const callsRust = K.pxCalls(true);

        for (const r of ["tiffUnpredict", "tiffPredict", "tiffToRgba"]) K.setRoute(r, "js");
        const uJs = tk.unpredict(sampleRgba.slice(), 1, 64, 16, 4, 8, true);
        const pJs = tk.predictRgba(sampleRgba.slice(), 16, 1);
        const cJs = tk.toRgba([sampleRgba], 1, null, spec4c);
        const callsJs = K.pxCalls(true);
        for (const r of ["tiffUnpredict", "tiffPredict", "tiffToRgba"]) K.setRoute(r, null);

        // In-place trap safety: when tiff_unpredict or tiff_predict_rgba traps in wasm, the caller's JS buffer was not
        // mutated before the fallback twin runs, so the returned buffer matches the JS twin on the original input!
        let trapInPlaceOk = true;
        console.warn = () => {};
        try {
            let pCur = K.rustPx();
            pCur.exports = { ...pCur.exports, tiff_unpredict: () => trapIn(pCur) };
            const uBuf = sampleRgba.slice();
            const uRec = K.tiffUnpredict(uBuf, 1, 64, 16, 4, 8, true);
            if (!eqBytes(uRec, uJs) || K.rustPx() === pCur) trapInPlaceOk = false;

            pCur = K.rustPx();
            pCur.exports = { ...pCur.exports, tiff_predict_rgba: () => trapIn(pCur) };
            const pBuf = sampleRgba.slice();
            const pRec = K.tiffPredictRgba(pBuf, 16, 1);
            if (!eqBytes(pRec, pJs) || K.rustPx() === pCur) trapInPlaceOk = false;

            pCur = K.rustPx();
            pCur.exports = { ...pCur.exports, tiff_to_rgba: () => trapIn(pCur) };
            const cRec = K.tiffToRgba([sampleRgba], 1, null, spec4c);
            if (!eqBytes(cRec, cJs) || K.rustPx() === pCur) trapInPlaceOk = false;
        } finally {
            console.warn = realWarn;
        }
        K.setKernels("js");
        check("kernels.js tiffKernels() looks up rustPx() per call across instance drops, switches routes between Rust and JS twin, and recovers from traps without double-applying in-place kernels",
            pBefore !== pAfter
            && callsRust.tiff_unpredict === 1 && callsRust.tiff_predict_rgba === 1 && callsRust.tiff_to_rgba === 1
            && !callsJs.tiff_unpredict && !callsJs.tiff_predict_rgba && !callsJs.tiff_to_rgba
            && eqBytes(uRust, uJs) && eqBytes(pRust, pJs) && eqBytes(cRust, cJs) && trapInPlaceOk,
            `callsRust=${JSON.stringify(callsRust)} callsJs=${JSON.stringify(callsJs)} trapInPlaceOk=${trapInPlaceOk}`);

        // 4d. readTiff with kernels: null (converter + JS unpredict) vs kernels: K.tiffKernels() (Rust toRgba + unpredict)
        // on a 2-bit palette + premultiplied alpha + predictor 2 TIFF (Question 6.4)
        {
            const u16le = (v) => [v & 255, (v >> 8) & 255];
            const u32le = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
            // 2-bit palette + premultiplied alpha, 4x1: samples (idx=1, a=1->85), (idx=2, a=2->170), (idx=3, a=3->255), (idx=2, a=0->0)
            // Packed into 2 bytes: [ (1<<6)|(1<<4)|(2<<2)|2 = 0x5A, (3<<6)|(3<<4)|(2<<2)|0 = 0xF8 ]
            const strip = new Uint8Array([0x5A, 0xF8]);
            const cmap = new Uint8Array(12 * 2);
            // Palette entries for indices 0..3: R=[0, 30, 120, 200], G=[0, 60, 80, 100], B=[0, 85, 170, 50]
            const cvals = [0, 30, 120, 200, 0, 60, 80, 100, 0, 85, 170, 50].map((v) => v * 257);
            cvals.forEach((v, idx) => { cmap[idx * 2] = v & 255; cmap[idx * 2 + 1] = (v >> 8) & 255; });
            // Build minimal TIFF with 11 tags at offset 8 (8 + 2 + 132 + 4 = 146), strip at 152, Bps at 156, Cmap at 160
            const tif = new Uint8Array(200);
            tif.set([0x49, 0x49, 42, 0, ...u32le(8)], 0);
            const tags = [
                [256, 3, 1, 4],       // Width = 4
                [257, 3, 1, 1],       // Height = 1
                [258, 3, 2, 2 | (2 << 16)], // BitsPerSample = [2, 2] inline (4 bytes)
                [259, 3, 1, 1],       // Compression = 1
                [262, 3, 1, 3],       // Photometric = 3 (palette)
                [273, 4, 1, 152],     // StripOffsets = 152
                [277, 3, 1, 2],       // SamplesPerPixel = 2
                [278, 3, 1, 1],       // RowsPerStrip = 1
                [279, 4, 1, 2],       // StripByteCounts = 2
                [320, 3, 12, 160],    // ColorMap
                [338, 3, 1, 1],       // ExtraSamples = [1] (premultiplied)
            ];
            tif.set(u16le(tags.length), 8);
            tags.forEach(([t, ty, cnt, val], idx) => {
                const o = 10 + idx * 12;
                tif.set([...u16le(t), ...u16le(ty), ...u32le(cnt), ...(ty === 3 && cnt === 1 ? [...u16le(val), 0, 0] : u32le(val))], o);
            });
            tif.set(strip, 152);
            tif.set([...u16le(2), ...u16le(2)], 156);
            tif.set(cmap, 160);
            let outNull = null, outRust = null;
            await T.readTiff(new Blob([tif]), { kernels: null, onRows: (rgba) => { outNull = rgba.slice(); } });
            K.setKernels("rust");
            K.pxCalls(true);
            await T.readTiff(new Blob([tif]), { kernels: K.tiffKernels(), onRows: (rgba) => { outRust = rgba.slice(); } });
            const cPal = K.pxCalls(true);
            K.setKernels("js");
            // Expected:
            // px 0: idx=1 -> (30,60,85), a=85 -> unpremul: (90,180,255,85)
            // px 1: idx=2 -> (120,80,170), a=170 -> unpremul: (180,120,255,170)
            // px 2: idx=3 -> (200,100,50), a=255 -> (200,100,50,255)
            // px 3: idx=2 -> (120,80,170), a=0 -> (0,0,0,0)
            const wantPal = new Uint8Array([90, 180, 255, 85, 180, 120, 255, 170, 200, 100, 50, 255, 0, 0, 0, 0]);
            check("inpaint_tiff.js readTiff 2-bit palette + premultiplied alpha (Question 6.4): kernels: null and kernels: tiffKernels() match expected RGBA",
                eqBytes(outNull, wantPal) && eqBytes(outRust, wantPal) && cPal.tiff_to_rgba === 1,
                `null=${Array.from(outNull || [])} rust=${Array.from(outRust || [])} calls=${JSON.stringify(cPal)}`);
        }
    }

    if (process.env.PX_BENCH) {
        const rawStrip = runPayload(1024 * 1024);
        const lzwStrip = lzwEncodeTiff(rawStrip);
        const pbStrip = packBitsEncode(rawStrip);
        for (const [what, comp, encoded] of [["LZW 1 MB strip", 5, lzwStrip], ["PackBits 1 MB strip", 32773, pbStrip]]) {
            const out = new Uint8Array(rawStrip.length);
            const rows = [
                ["twin", () => js.tiffUnpack(comp, encoded, rawStrip.length, out)],
                ["simd", () => simd.tiffUnpack(comp, encoded, rawStrip.length, out)],
                ["scalar", () => scalar.tiffUnpack(comp, encoded, rawStrip.length, out)],
            ];
            const med = benchMedians(rows, { rounds: 15 });
            console.log(`       tiff_unpack (${what}): ${rows.map(([n]) => `${n} ${med[n].toFixed(2)}`).join(", ")} ms (median of 15)`);
        }
        const bw = 15000, brows = 16;
        const bRgba = randomRGBA(bw, brows, 9801);
        const bRgb = new Uint8Array(bw * brows * 3);
        for (let i = 0; i < bRgb.length; i++) bRgb[i] = bRgba[i];
        const bOut = new Uint8Array(bw * brows * 4);
        for (const [what, fnTwin, fnSimd, fnScalar] of [
            ["tiff_unpredict RGBA8 15000x16",
                () => js.tiffUnpredict(bRgba, brows, bw * 4, bw, 4, 8, true),
                () => simd.tiffUnpredict(bRgba, brows, bw * 4, bw, 4, 8, true),
                () => scalar.tiffUnpredict(bRgba, brows, bw * 4, bw, 4, 8, true)],
            ["tiff_unpredict RGB8 15000x16",
                () => js.tiffUnpredict(bRgb, brows, bw * 3, bw, 3, 8, true),
                () => simd.tiffUnpredict(bRgb, brows, bw * 3, bw, 3, 8, true),
                () => scalar.tiffUnpredict(bRgb, brows, bw * 3, bw, 3, 8, true)],
            ["tiff_predict_rgba 15000x16",
                () => js.tiffPredictRgba(bRgba, bw, brows),
                () => simd.tiffPredictRgba(bRgba, bw, brows),
                () => scalar.tiffPredictRgba(bRgba, bw, brows)],
            ["tiff_to_rgba RGB8->RGBA8 15000x16",
                () => js.tiffToRgba([bRgb], brows, bOut, { w: bw, rowBytes: bw * 3, spp: 3, bits: 8, planes: 1, le: true, photometric: 2, alpha: "none", pal: null }),
                () => simd.tiffToRgba([bRgb], brows, bOut, { w: bw, rowBytes: bw * 3, spp: 3, bits: 8, planes: 1, le: true, photometric: 2, alpha: "none", pal: null }),
                () => scalar.tiffToRgba([bRgb], brows, bOut, { w: bw, rowBytes: bw * 3, spp: 3, bits: 8, planes: 1, le: true, photometric: 2, alpha: "none", pal: null })],
            ["tiff_to_rgba RGBA8 premul->straight 15000x16",
                () => js.tiffToRgba([bRgba], brows, bOut, { w: bw, rowBytes: bw * 4, spp: 4, bits: 8, planes: 1, le: true, photometric: 2, alpha: "premultiplied", pal: null }),
                () => simd.tiffToRgba([bRgba], brows, bOut, { w: bw, rowBytes: bw * 4, spp: 4, bits: 8, planes: 1, le: true, photometric: 2, alpha: "premultiplied", pal: null }),
                () => scalar.tiffToRgba([bRgba], brows, bOut, { w: bw, rowBytes: bw * 4, spp: 4, bits: 8, planes: 1, le: true, photometric: 2, alpha: "premultiplied", pal: null })],
        ]) {
            const rows = [["twin", fnTwin], ["simd", fnSimd], ["scalar", fnScalar]];
            const med = benchMedians(rows, { rounds: 15 });
            console.log(`       ${what}: ${rows.map(([n]) => `${n} ${med[n].toFixed(2)}`).join(", ")} ms (median of 15)`);
        }
    }
}

async function guidedCases(js, simd, scalar, K) {
    const { guidedFar: guidedFarRef, bilinearResize: bilinearResizeRef } = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_depth.js")).href);

    function makeRaw(w, h, kind = "waves") {
        const n = w * h;
        const out = new Float32Array(n);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                if (kind === "flat") out[i] = 3.25;
                else if (kind === "ramp") out[i] = (x + y * w) / Math.max(1, n - 1);
                else if (kind === "step") out[i] = x < (w >> 1) ? -5.0 : 12.0;
                else if (kind === "extreme") out[i] = Math.sin(i * 1.234567) * 100;
                else out[i] = Math.sin(x * 0.31 + y * 0.17) * 10 + Math.cos(i * 0.13) * 4;
            }
        }
        return out;
    }

    function makeGrey(w, h, kind = "texture") {
        const n = w * h;
        const out = new Uint8Array(n);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                if (kind === "flat") out[i] = 128;
                else if (kind === "step") out[i] = x < (w >> 1) ? 20 : 235;
                else if (kind === "allbytes") out[i] = i & 255;
                else out[i] = (i * 131 + ((i * i * 17) % 251)) & 255;
            }
        }
        return out;
    }

    const cases = [];
    // 1. Same-size (rw === gw && rh === gh) across odd/small/medium dimensions, radii, eps, and lo/hi edge cases
    for (const [w, h] of [[1, 1], [2, 2], [3, 5], [5, 3], [7, 9], [16, 3], [33, 17], [64, 48]]) {
        const raw = makeRaw(w, h, "waves");
        const grey = makeGrey(w, h, "allbytes");
        for (const r of [0, 1, 2, 5, 12]) {
            cases.push({
                tag: `same ${w}x${h} r=${r}`,
                args: [raw, w, h, grey, w, h, r, 1e-3, -15, 15],
            });
        }
    }

    // 2. lo/hi boundary cases: equal lo==hi, lo>hi, span == 1e-12 vs 1.0001e-12, clamping outside [lo, hi], omitted lo/hi, and q=0.5 half-way u16 tie
    {
        const w = 24, h = 18;
        const raw = makeRaw(w, h, "waves");
        const grey = makeGrey(w, h, "texture");
        for (const [tag, lo, hi, eps] of [
            ["lo==hi", 2.0, 2.0, 1e-3],
            ["lo>hi", 5.0, -5.0, 1e-3],
            ["span=1e-12", 0.0, 1e-12, 1e-3],
            ["span=1.0001e-12", 0.0, 1.0001e-12, 1e-3],
            ["tight clip", -2.0, 2.0, 1e-4],
            ["eps=1e6", -15.0, 15.0, 1e6],
            ["eps=1e-7", -15.0, 15.0, 1e-7],
            ["auto disparityRange", undefined, undefined, 1e-3],
        ]) {
            cases.push({
                tag: `bounds ${tag}`,
                args: [raw, w, h, grey, w, h, 2, eps, lo, hi],
            });
        }
        const halfRaw = new Float32Array(w * h).fill(0.5);
        cases.push({
            tag: "bounds q=0.5 half-way u16 tie (32767.5 -> 32768)",
            args: [halfRaw, w, h, grey, w, h, 2, 1e-3, 0.0, 1.0],
        });
        const longRaw = new Float32Array(w * h + 16);
        longRaw.set(raw);
        for (let i = 0; i < 16; i++) longRaw[w * h + i] = (i & 1) ? 500 : -500;
        cases.push({
            tag: "bounds auto disparityRange with raw longer than rw*rh",
            args: [longRaw, w, h, grey, w, h, 2, 1e-3, undefined, undefined],
        });
    }

    // 3. Resized (upscaled, downscaled where rw*rh > gw*gh, mixed aspect, fractional r * (gw / rw) near half-integers, wx f32 vs f64 tie)
    for (const [rw, rh, gw, gh, r, eps] of [
        [1, 1, 4, 4, 2, 1e-3],
        [3, 2, 9, 7, 2, 1e-3],
        [14, 14, 35, 27, 2, 1e-3],
        [28, 14, 64, 33, 2, 1e-4],
        [98, 32, 150, 48, 2, 1e-4],
        [64, 48, 128, 96, 2, 1e-5],
        [32, 24, 11, 9, 2, 1e-3],
        [64, 48, 19, 13, 3, 1e-4],
        [32, 8, 12, 25, 2, 1e-3],
        [8, 32, 25, 12, 2, 1e-3],
        [4, 4, 4, 4, 1.5, 1e-3],
        [4, 4, 4, 4, 1.4999999999999998, 1e-3],
    ]) {
        const raw = makeRaw(rw, rh, "waves");
        const grey = makeGrey(gw, gh, "texture");
        cases.push({
            tag: `resize ${rw}x${rh}->${gw}x${gh} r=${r}`,
            args: [raw, rw, rh, grey, gw, gh, r, eps, -12.345, 13.789],
        });
    }

    // 4. Mutant-killing case for `b` using unrounded f64 `av` (vs f32 `a[i]`) and `I` using f64 `grey * (1 / 255)` stored as f32
    {
        const rw = 128, rh = 96, gw = 256, gh = 192;
        const raw = makeRaw(rw, rh, "extreme");
        const grey = makeGrey(gw, gh, "texture");
        const lo = -100, hi = 100, r = 2, eps = 1e-3;
        cases.push({
            tag: `precision ${rw}x${rh}->${gw}x${gh} av & I`,
            args: [raw, rw, rh, grey, gw, gh, r, eps, lo, hi],
        });

        // Verify this test image flips u16 outputs under both mutants (b using f32 a[i], and I using f32 1/255 or unrounded f64)
        const refOut = guidedFarRef({ raw, rw, rh, grey, gw, gh, r, eps, lo, hi }, js.boxBlurs);
        const nRaw = rw * rh, n = gw * gh;
        const farF32 = new Float32Array(nRaw);
        const invRange = 1 / (hi - lo);
        for (let i = 0; i < nRaw; i++) {
            let t = (raw[i] - lo) * invRange;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            farF32[i] = 1 - t;
        }
        const p = bilinearResizeRef(farF32, rw, rh, gw, gh);
        const rWork = Math.max(1, Math.round(r * (gw / rw)));

        const runMutant = (kind) => {
            const I = kind === "I_f64" ? new Float64Array(n) : new Float32Array(n);
            const inv255 = kind === "I_f32" ? Math.fround(1 / 255) : 1 / 255;
            for (let i = 0; i < n; i++) {
                I[i] = kind === "I_f32" ? Math.fround(Math.fround(grey[i]) * inv255) : grey[i] * inv255;
            }
            const meanI = js.boxBlurs(new Float32Array(I), gw, gh, [rWork]);
            const meanP = js.boxBlurs(p, gw, gh, [rWork]);
            const Ip = new Float32Array(n), II = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const iv = I[i];
                Ip[i] = iv * p[i];
                II[i] = iv * iv;
            }
            const meanIp = js.boxBlurs(Ip, gw, gh, [rWork]);
            const meanII = js.boxBlurs(II, gw, gh, [rWork]);
            const a = new Float32Array(n), b = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const mi = meanI[i];
                const covIp = meanIp[i] - mi * meanP[i];
                const varI = meanII[i] - mi * mi;
                const av = covIp / (varI + eps);
                a[i] = av;
                b[i] = meanP[i] - (kind === "b_ai" ? a[i] : av) * mi;
            }
            const meanA = js.boxBlurs(a, gw, gh, [rWork]);
            const meanB = js.boxBlurs(b, gw, gh, [rWork]);
            const q = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                let v = meanA[i] * I[i] + meanB[i];
                if (v < 0) v = 0; else if (v > 1) v = 1;
                q[i] = v;
            }
            let flipped = 0;
            for (let i = 0; i < n; i++) {
                if (Math.round(q[i] * 65535) !== refOut[i]) flipped++;
            }
            return flipped;
        };
        const flipB = runMutant("b_ai");
        const flipIf32 = runMutant("I_f32");
        const flipIf64 = runMutant("I_f64");
        check("guidedFar precision case flips u16s when b uses rounded a[i] or I uses f32 1/255 / unrounded f64",
            flipB > 0 && flipIf32 > 0 && flipIf64 > 0,
            `flipB=${flipB} flipIf32=${flipIf32} flipIf64=${flipIf64}`);
    }

    twinCheck({
        name: "guided_far",
        builds: [["rust simd", simd], ["rust scalar", scalar]],
        twin: js,
        call: (k, args) => k.guidedFar(...args),
        cases,
    });

    // Object argument form and caller-supplied `out` buffer
    {
        const rw = 20, rh = 15, gw = 40, gh = 30;
        const raw = makeRaw(rw, rh, "waves");
        const grey = makeGrey(gw, gh, "texture");
        const msg = { raw, rw, rh, grey, gw, gh, r: 2, eps: 1e-3, lo: -10, hi: 10 };
        const want = guidedFarRef(msg, js.boxBlurs);
        let objOk = true, objDetail = "";
        for (const [bName, k] of [["js", js], ["simd", simd], ["scalar", scalar]]) {
            const got1 = k.guidedFar(msg);
            const outBuf = new Uint16Array(gw * gh);
            const got2 = k.guidedFar(msg, outBuf);
            const outBufPos = new Uint16Array(gw * gh);
            const got3 = k.guidedFar(raw, rw, rh, grey, gw, gh, 2, 1e-3, -10, 10, outBufPos);
            if (twinDiff(got1, want) || got2 !== outBuf || twinDiff(got2, want) || got3 !== outBufPos || twinDiff(got3, want)) {
                objOk = false;
                objDetail = bName;
                break;
            }
        }
        check("guidedFar accepts both options object and positional arguments with optional out Uint16Array", objOk, objDetail);
    }

    // Dirty wasm arena check
    {
        const rw = 19, rh = 13, gw = 37, gh = 29;
        const raw = makeRaw(rw, rh, "waves");
        const grey = makeGrey(gw, gh, "texture");
        const want = js.guidedFar(raw, rw, rh, grey, gw, gh, 2, 1e-3, -10, 10);
        let dirtyOk = true, dirtyDetail = "";
        for (const [bName, px] of [["simd", simd], ["scalar", scalar]]) {
            const a = px.job;
            try {
                const p = a.take(512 * 1024);
                px.u8().fill(0xde, p, p + 512 * 1024);
            } finally { px._reset(a); }
            const got = px.guidedFar(raw, rw, rh, grey, gw, gh, 2, 1e-3, -10, 10);
            const d = twinDiff(got, want);
            if (d) { dirtyOk = false; dirtyDetail = `${bName}: ${d}`; break; }
        }
        check("guided_far writes every output u16 identically in a dirty wasm arena", dirtyOk, dirtyDetail);
    }

    // Refusal checks on Px.guidedFar and raw exports
    {
        const raw = new Float32Array(16 * 16);
        const grey = new Uint8Array(32 * 32);
        const badArgs = [
            ["null raw", [null, 16, 16, grey, 32, 32, 2, 1e-3, 0, 1]],
            ["short raw", [new Float32Array(10), 16, 16, grey, 32, 32, 2, 1e-3, 0, 1]],
            ["null grey", [raw, 16, 16, null, 32, 32, 2, 1e-3, 0, 1]],
            ["short grey", [raw, 16, 16, new Uint8Array(10), 32, 32, 2, 1e-3, 0, 1]],
            ["zero rw", [raw, 0, 16, grey, 32, 32, 2, 1e-3, 0, 1]],
            ["zero rh", [raw, 16, 0, grey, 32, 32, 2, 1e-3, 0, 1]],
            ["zero gw", [raw, 16, 16, grey, 0, 32, 2, 1e-3, 0, 1]],
            ["zero gh", [raw, 16, 16, grey, 32, 0, 2, 1e-3, 0, 1]],
            ["fractional gw", [raw, 16, 16, grey, 31.5, 32, 2, 1e-3, 0, 1]],
            ["eps <= 0", [raw, 16, 16, grey, 32, 32, 2, 0, 0, 1]],
            ["negative eps", [raw, 16, 16, grey, 32, 32, 2, -1e-3, 0, 1]],
            ["NaN eps", [raw, 16, 16, grey, 32, 32, 2, NaN, 0, 1]],
            ["NaN r", [raw, 16, 16, grey, 32, 32, NaN, 1e-3, 0, 1]],
            ["huge r", [raw, 16, 16, grey, 32, 32, 1e12, 1e-3, 0, 1]],
            ["Infinity lo", [raw, 16, 16, grey, 32, 32, 2, 1e-3, Infinity, 1]],
            ["NaN hi", [raw, 16, 16, grey, 32, 32, 2, 1e-3, 0, NaN]],
            ["short out", [raw, 16, 16, grey, 32, 32, 2, 1e-3, 0, 1, new Uint16Array(10)]],
        ];
        for (const [what, args] of badArgs) {
            const rSimd = simd.guidedFar(...args);
            const rScal = scalar.guidedFar(...args);
            check(`Px.guidedFar refuses ${what} on both builds (returns null)`, rSimd === null && rScal === null, `simd=${rSimd} scalar=${rScal}`);
        }
        const zScratch = simd.exports.guided_far_scratch_bytes(0, 16, 32, 32);
        const ovScratch = simd.exports.guided_far_scratch_bytes(16, 16, 65536, 65536);
        const nullCall = simd.exports.guided_far(0, 16, 16, 0, 32, 32, 2, 1e-3, 0, 1, 0, 0);
        const zeroEpsCall = simd.exports.guided_far(8, 16, 16, 8, 32, 32, 2, 0, 0, 1, 8, 8);
        check("raw guided_far_scratch_bytes and guided_far refuse zero, overflowing, null, or eps <= 0 inputs",
            zScratch === 0 && ovScratch === 0 && nullCall === 0 && zeroEpsCall === 0,
            `z=${zScratch} ov=${ovScratch} null=${nullCall} zeroEps=${zeroEpsCall}`);
    }

    // Route check on K.guidedFar
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
        const rw = 24, rh = 18, gw = 48, gh = 36;
        const raw = makeRaw(rw, rh, "waves");
        const grey = makeGrey(gw, gh, "texture");

        K.setRoute("guidedFar", "js");
        K.pxCalls(true);
        const outJs = K.guidedFar(raw, rw, rh, grey, gw, gh, 2, 1e-3, -10, 10);
        const jsCalls = K.pxCalls(true).guided_far || 0;

        K.setRoute("guidedFar", "rust");
        const outRust = K.guidedFar(raw, rw, rh, grey, gw, gh, 2, 1e-3, -10, 10);
        const rustCalls = K.pxCalls(true).guided_far || 0;
        K.setRoute("guidedFar", null);
        K.setKernels("js");

        check("kernels.js guidedFar routes between twin (0 calls) and rust (1 call) with identical output",
            !twinDiff(outRust, outJs) && jsCalls === 0 && rustCalls === 1,
            `jsCalls=${jsCalls} rustCalls=${rustCalls}`);
    }

    if (process.env.PX_BENCH) {
        const gw = 4096, gh = 2731;
        const grey = makeGrey(gw, gh, "texture");
        for (const [what, rw, rh] of [
            ["model 784x518 -> 4096x2731", 784, 518],
            ["layer 4096x2731 -> 4096x2731", gw, gh],
        ]) {
            const raw = makeRaw(rw, rh, "waves");
            const rows = [
                ["twin", () => js.guidedFar(raw, rw, rh, grey, gw, gh, 2, 1e-3, -14, 14)],
                ["simd", () => simd.guidedFar(raw, rw, rh, grey, gw, gh, 2, 1e-3, -14, 14)],
                ["scalar", () => scalar.guidedFar(raw, rw, rh, grey, gw, gh, 2, 1e-3, -14, 14)],
            ];
            const med = benchMedians(rows, { rounds: 5 });
            console.log(`       guided_far ${what}: ${rows.map(([n]) => `${n} ${med[n].toFixed(2)}`).join(", ")} ms (median of 5)`);
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
    await group("guided", async () => guidedCases(js, simdPx, scalarPx, await import(pathToFileURL(path.join(PX_DIR, "kernels.js")).href)));
    await group("pngFilter", () => pngFilterCases(js, simdPx, scalarPx));
    await group("retouchRoute", () => retouchRouteCases(js));
    await group("tiff", async () => tiffCases(js, simdPx, scalarPx, await import(pathToFileURL(path.join(PX_DIR, "kernels.js")).href), await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_tiff.js")).href)));
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
        await group("pngPart", () => pngPartCases(px, label, js));
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
