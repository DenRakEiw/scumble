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
// a self-test), px.js' call counters (`pxCalls`), and with `PX_BENCH=1` (or `large`) the timed rows:
// medians over rotating rounds and a cold first call on a fresh compile (docs/PLAN_WASM_BUILD.md §3.4).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL, fileURLToPath } = require("node:url");

const ROOT = path.dirname(__dirname);
const PX_DIR = path.join(ROOT, "renderer", "editor", "px");

let failures = 0;
function check(name, ok, detail = "") {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
    if (!ok) failures++;
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

/** The float masks of a provider run (dilate_mask, box_blurs) against their twins: the same floats, bit for bit. */
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
    twinCheck({
        name: "box_blurs", title: "box_blurs equals its twin bit for bit", builds: [[label, px]], twin: js,
        call: (k, [m, w, h, radii]) => k.boxBlurs(m, w, h, radii),
        cases: masks.flatMap(([m, w, h]) => [[1, 1, 1], [0, 1, 2], [3, 3, 4], [17, 18, 18], [200, 200, 201], [0, 0, 0]].map((radii) => ({ tag: `box blurs ${w}x${h} ${radii}`, args: [m, w, h, radii] }))),
    });
    const big = mask(1492, 1492, 9);
    const t0 = performance.now(); px.dilateMask(big, 1492, 1492, 47);
    const t1 = performance.now(); js.dilateMask(big, 1492, 1492, 47);
    const t2 = performance.now(); px.boxBlurs(big, 1492, 1492, [19, 20, 20]);
    const t3 = performance.now(); js.boxBlurs(big, 1492, 1492, [19, 20, 20]);
    const t4 = performance.now();
    console.log(`       1492 x 1492: dilate ${label} ${(t1 - t0).toFixed(1)} ms, twin ${(t2 - t1).toFixed(1)}; three box blurs ${label} ${(t3 - t2).toFixed(1)} ms, twin ${(t4 - t3).toFixed(1)}`);
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

async function main() {
    const { BLENDS } = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "blend_modes.js")).href);
    for (const b of BLENDS) if (b.op >= 5) BLEND_NAMES[b.op - 5] = b.id;
    const TIER_C_NAMES = ["hue", "saturation", "color", "luminosity", "darker-color", "lighter-color"];
    for (let i = 0; i < TIER_C_NAMES.length; i++) BLEND_NAMES[19 + i] = TIER_C_NAMES[i];
    const js = await import(pathToFileURL(path.join(PX_DIR, "kernels_js.js")).href);
    const resample = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_resample.js")).href);
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
    twinSelfTest();
    await mipCases(ref, label, js);
    await edtCases(ref, label, js, raster);
    await floodCases(ref, label, js, raster);
    await compositeCases(ref, label, js);
    await matchTwinCases(js);
    await smudgeTwinCases(js);
    await poissonTwinCases(js);
    await pngCases(ref, label, js);
    const simdPx = await loadPx(fs.readFileSync(path.join(PX_DIR, "px.wasm")));
    const scalarPx = await loadPx(fs.readFileSync(path.join(PX_DIR, "px_scalar.wasm")));
    await compositeShaCases(js, simdPx, scalarPx);
    await blendFixtureCases(js, simdPx, scalarPx);
    await blendGlslCases();
    await tierCCases(js, simdPx, scalarPx, ref);
    await relightBench(js, simdPx);   // before memoryCases grows simdPx past 2 GB
    await counterCases(simdPx);
    for (const [name, px] of [["simd", simdPx], ["scalar", scalarPx]]) {
        const label = `rust ${name}`;
        check(`${label} module reports its SIMD flag`, px.simd === (name === "simd"));
        await mipCases(px, label, js);
        await edtCases(px, label, js, raster);
        await floodCases(px, label, js, raster);
        await jobCases(px, label, raster);
        await maskCases(px, label, js);
        await edgeCases(px, label, js);
        await relightCases(px, label, js);
        await pngReadCases(px, label, js);
        await compositeCases(px, label, js);
        await matchCases(px, label, js);
        await smudgeCases(px, label, js);
        await poissonCases(px, label, js);
        await pngCases(px, label, js);
        await pngPartCases(px, label);
        await psdCases(px, label, js);
        await resampleCases(px, label, resample);
        await memoryCases(px, label);
    }
    console.log(failures ? `FAIL (${failures})` : "PASS");
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
