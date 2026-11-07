"use strict";
// P10 of docs/PLAN_WASM_BUILD.md section 7 ("The user's answers after K4", item 3): the atlas slot's copy in 32-bit
// words. inpaint_tiles.js `tileWithGutter` tests an opaque and a transparent pixel a word at a time (as `coarseSlot`
// does), copies the opaque word whole and writes the transparent one as 0, and keeps the premultiply table for the rest.
// The bytes must be the old code's on every input, so this plain-Node test holds the store's answers against a twin:
// the old `tileWithGutter` copied verbatim (the byte path only), run on the same store's `_levelBytes`.
//
// Inputs: tiles of every alpha kind (all opaque, all transparent with colour left in the RGB bytes, alpha runs of
// 255 / 0 / soft, single pixels near the thresholds 1 and 254, noise, and in each store's first tile every (colour,
// alpha) pair once per channel, which the computed premultiply of the soft words must match), tiles left out, images whole tiles wide and
// not (the edge copies and chains), every level 0-5 (slot sides 258 to 10), `ring` and `display` (stale chains and
// the coarse picture of a tile with none), and output buffers aligned, larger than a slot, on a SharedArrayBuffer and
// off a 4-byte boundary (byteOffset 1, 2, 3: `words()` gives null, the byte path for every pixel, which is also what
// a big-endian machine takes). Sources off a word boundary (a copy at byteOffset 1-3, or `off` not a multiple of 4)
// take the byte path for that neighbour while the others take words. The test also asserts which path ran (the word
// views were made, or not), so a twin that matches only because the word path never ran fails.
//
//     node tools/gutter_words_test.js            RESULT PASS / FAIL
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");

const ROOT = path.join(__dirname, "..");

if (!globalThis.ImageData) {
    globalThis.ImageData = class ImageData {
        constructor(a, b, c) {
            if (a && a.buffer) { this.data = a; this.width = b; this.height = c; } else { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
        }
    };
}
if (typeof document === "undefined") globalThis.document = { createElement() { return { getContext() { return null; } }; } };

const TS = 256;
let seed = 0x9e3779b9;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const ri = (n) => Math.floor(rnd() * n);

// the old code's premultiply (SkMulDiv255Round), built here so the twin shares nothing with the module
const PM = new Uint8Array(65536);
for (let a = 0; a < 256; a++) for (let c = 0; c < 256; c++) { const x = c * a + 128; PM[(a << 8) | c] = (x + (x >> 8)) >> 8; }

/** The old `tileWithGutter` (inpaint_tiles.js before P10), verbatim but for `this` -> `p`. */
function twinTileWithGutter(p, tx, ty, level = 0, out = null, ring = false, display = false) {
    const own = p._levelBytes(tx, ty, level, display);
    if (!own) return null;
    const side = TS >> level, S = side + 2;
    if (!out || out.length < S * S * 4) out = new Uint8Array(S * S * 4);
    const near = [];
    const infoAt = (dx, dy) => {
        const k = (dy + 1) * 3 + (dx + 1);
        if (near[k] === undefined) near[k] = !dx && !dy ? own : p._levelBytes(tx + dx, ty + dy, level, display);
        return near[k];
    };
    const leftX = tx > 0 ? -1 : 0, leftS = tx > 0 ? side - 1 : 0;
    const rightX = ((tx + 1) << 8) < p._w ? 1 : 0, rightS = rightX ? 0 : side - 1;
    const topY = ty > 0 ? -1 : 0, topS = ty > 0 ? side - 1 : 0;
    const botY = ((ty + 1) << 8) < p._h ? 1 : 0, botS = botY ? 0 : side - 1;
    const P = PM;
    const put = (info, sx, sy, n, o) => {
        if (!info) { out.fill(0, o, o + n * 4); return; }
        if (info.coarse) {
            const d = info.t.data, f = 1 << level, half = f >> 1, lastX = info.vw - 1;
            const row = Math.min(sy * f + half, info.vh - 1) * TS;
            for (let k = 0; k < n; k++, o += 4) {
                const i = (row + Math.min((sx + k) * f + half, lastX)) * 4;
                const a = d[i + 3];
                if (a === 255) { out[o] = d[i]; out[o + 1] = d[i + 1]; out[o + 2] = d[i + 2]; out[o + 3] = 255; continue; }
                if (!a) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; continue; }
                const b = a << 8;
                out[o] = P[b | d[i]]; out[o + 1] = P[b | d[i + 1]]; out[o + 2] = P[b | d[i + 2]]; out[o + 3] = a;
            }
            return;
        }
        const d = info.data;
        let i = info.off + (sy * side + sx) * 4;
        for (let k = 0; k < n; k++, i += 4, o += 4) {
            const a = d[i + 3];
            if (a === 255) { out[o] = d[i]; out[o + 1] = d[i + 1]; out[o + 2] = d[i + 2]; out[o + 3] = 255; continue; }
            if (!a) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; continue; }
            const b = a << 8;
            out[o] = P[b | d[i]]; out[o + 1] = P[b | d[i + 1]]; out[o + 2] = P[b | d[i + 2]]; out[o + 3] = a;
        }
    };
    for (let y = 0; y < S; y++) {
        const dy = y === 0 ? topY : y === S - 1 ? botY : 0;
        const sy = y === 0 ? topS : y === S - 1 ? botS : y - 1;
        const o = y * S * 4;
        put(infoAt(leftX, dy), leftS, sy, 1, o);
        if (!ring || y === 0 || y === S - 1) put(infoAt(0, dy), 0, sy, side, o + 4);
        put(infoAt(rightX, dy), rightS, sy, 1, o + (S - 1) * 4);
    }
    return out;
}

// ---- tile contents -------------------------------------------------------------------------------------------------

const KINDS = ["opaque", "transparent", "runs", "soft", "thresholds", "noise", "mostlyOpaque", "allPairs"];
function fillTile(d, kind) {
    const n = TS * TS;
    const rgb = (i) => { d[i] = ri(256); d[i + 1] = ri(256); d[i + 2] = ri(256); };
    if (kind === "allPairs") {
        // every (colour, alpha) pair once in each channel: pixel a * 256 + c (a tile holds exactly 65,536)
        for (let p = 0; p < n; p++) { const a = p >> 8, c = p & 255; d[p * 4] = c; d[p * 4 + 1] = 255 - c; d[p * 4 + 2] = (c * 7 + a) & 255; d[p * 4 + 3] = a; }
        return;
    }
    if (kind === "opaque") { for (let p = 0; p < n; p++) { rgb(p * 4); d[p * 4 + 3] = 255; } return; }
    if (kind === "transparent") { for (let p = 0; p < n; p++) { rgb(p * 4); d[p * 4 + 3] = 0; } return; }   // colour under alpha 0
    if (kind === "soft") { for (let p = 0; p < n; p++) { rgb(p * 4); d[p * 4 + 3] = 1 + ri(254); } return; }
    if (kind === "noise") { for (let p = 0; p < n; p++) { rgb(p * 4); d[p * 4 + 3] = ri(256); } return; }
    if (kind === "thresholds") {
        const A = [0, 1, 2, 127, 128, 253, 254, 255];
        for (let p = 0; p < n; p++) { rgb(p * 4); d[p * 4 + 3] = A[ri(A.length)]; }
        return;
    }
    if (kind === "mostlyOpaque") {
        for (let p = 0; p < n; p++) { rgb(p * 4); d[p * 4 + 3] = rnd() < 0.97 ? 255 : (rnd() < 0.5 ? 0 : 1 + ri(254)); }
        return;
    }
    // runs: alpha 255, 0 or soft in runs of 1 to 600 pixels (a run crosses rows), colour 0 / 255 extremes in places
    let p = 0;
    while (p < n) {
        const len = 1 + ri(600), mode = ri(3);
        for (let k = 0; k < len && p < n; k++, p++) {
            const i = p * 4;
            if (rnd() < 0.1) { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; } else if (rnd() < 0.1) { d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; } else rgb(i);
            d[i + 3] = mode === 0 ? 255 : mode === 1 ? 0 : 1 + ri(254);
        }
    }
}

/** A store of W x H with every tile filled by a random kind, about one in six left out. */
function makeStore(T, W, H) {
    const p = new T.TileLayerPixels(W, H);
    for (let ty = 0; ty * TS < H; ty++) {
        for (let tx = 0; tx * TS < W; tx++) {
            const first = !tx && !ty;   // the first tile holds every (colour, alpha) pair, so level 0 meets each once
            if (!first && rnd() < 0.16) continue;
            const t = p.writable(tx, ty);
            fillTile(t.data, first ? "allPairs" : KINDS[ri(KINDS.length)]);
        }
    }
    return p;
}

/** A fresh tile's bytes for a tile that exists, so its version moves and its chain goes stale. */
function rewrite(p, tx, ty) {
    const t = p.writable(tx, ty, false);
    if (t) fillTile(t.data, KINDS[ri(KINDS.length)]);
}

// output buffers: [label, make(S) -> a Uint8Array of at least S * S * 4, expect words]
const OUTS = [
    ["fresh", null, true],
    ["exact", (n) => new Uint8Array(n), true],
    ["larger", (n) => new Uint8Array(n + 4 * 37), true],
    ["shared", (n) => new Uint8Array(new SharedArrayBuffer(n + 8), 4, n), true],
    ["offset1", (n) => new Uint8Array(new ArrayBuffer(n + 8), 1, n), false],
    ["offset2", (n) => new Uint8Array(new ArrayBuffer(n + 8), 2, n), false],
    ["offset3", (n) => new Uint8Array(new SharedArrayBuffer(n + 8), 3, n), false],
];

async function main() {
    const PX_DIR = path.join(ROOT, "renderer", "editor", "px");
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u, ...rest) => {   // kernels.js fetches ./px.wasm; Node's fetch reads no file: URL
        const s = String(u && u.href ? u.href : u);
        return s.startsWith("file:") ? new Response(fs.readFileSync(fileURLToPath(s))) : realFetch(u, ...rest);
    };
    try {
        const K = await import(pathToFileURL(path.join(PX_DIR, "kernels.js")).href);
        assert.ok(await K.kernelsReady(), "kernels.js did not load px.wasm");
    } finally { globalThis.fetch = realFetch; }
    const T = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_tiles.js")).href);
    const little = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    console.log(`little-endian: ${little}`);

    const stats = { slots: 0, words: 0, bytePath: 0, misalignedSources: 0, coarse: 0, stale: 0, ring: 0, bytes: 0 };
    let failures = 0;
    // the word views the new code made (it sets `w32` on the infos it reads); the twin's own reads come first
    const viewsOf = (p) => { const seen = []; const lb = p._levelBytes; p._levelBytes = function (...a) { const r = lb.apply(this, a); if (r) seen.push(r); return r; }; return { seen, restore: () => { p._levelBytes = lb; } }; };

    const check = (p, tx, ty, level, outKind, ring, display, label) => {
        const S = (TS >> level) + 2, n = S * S * 4;
        const [oname, make, wantWords] = outKind;
        // both buffers start with the same garbage, so a ring that wrote the interior, or a pixel left out, shows
        const garbage = new Uint8Array(n); for (let i = 0; i < n; i++) garbage[i] = ri(256);
        let a = make ? make(n) : null, b = make ? make(n) : null;
        if (a) { a.set(garbage); b.set(garbage); }
        if (ring && !a) { a = new Uint8Array(n); b = new Uint8Array(n); a.set(garbage); b.set(garbage); }
        const want = twinTileWithGutter(p, tx, ty, level, b, ring, display);
        const spy = viewsOf(p);
        let got;
        try { got = p.tileWithGutter(tx, ty, level, a, ring, display); } finally { spy.restore(); }
        if (!want) { assert.equal(got, null, `${label}: the store gave a slot where the twin gave none`); return; }
        assert.ok(got, `${label}: no slot`);
        if (a) assert.equal(got, a, `${label}: the buffer handed in was not used`);
        stats.slots++;
        stats.bytes += n;
        if (ring) stats.ring++;
        // which path ran: with an aligned output on a little-endian machine every source got a word view (null only
        // for a source off a word boundary); with a misaligned output none did. A ring reads only the neighbours (the
        // tile's own lines only at the image's edge), so its own info is not looked at there
        const own = spy.seen.length && !ring ? spy.seen[0] : null;
        if (own) {
            const w = own.w32;
            if (little && wantWords) {
                const aligned = own.coarse || (!(own.off & 3) && own.data.byteOffset % 4 === 0);
                if (aligned) { assert.ok(w instanceof Uint32Array, `${label}: the word path did not run (no word view for the tile)`); stats.words++; }
                else { assert.equal(w, null, `${label}: a source off a word boundary got a word view`); stats.misalignedSources++; }
            } else {
                assert.ok(!w, `${label}: a word view for an output off a word boundary`);
                stats.bytePath++;
            }
            if (own.coarse) stats.coarse++;
            if (own.stale && !own.coarse) stats.stale++;
        }
        for (let i = 0; i < n; i++) {
            if (got[i] === want[i]) continue;
            const px = (i >> 2) % S, py = ((i >> 2) / S) | 0, q = (i >> 2) * 4;
            failures++;
            throw new Error(`${label} (${oname}): byte ${i} at ${px},${py}: ${Array.from(got.slice(q, q + 4))} against the twin's ${Array.from(want.slice(q, q + 4))}`);
        }
    };

    const SIZES = [[601, 501], [512, 512], [300, 700], [257, 255], [1024, 768], [1, 1], [770, 260]];
    for (const [W, H] of SIZES) {
        const p = makeStore(T, W, H);
        const cols = Math.ceil(W / TS), rows = Math.ceil(H / TS);
        for (let level = 0; level <= T.MIP_LEVELS; level++) {
            for (let ty = 0; ty < rows; ty++) {
                for (let tx = 0; tx < cols; tx++) {
                    const ok = OUTS[ri(OUTS.length)];
                    check(p, tx, ty, level, ok, false, false, `${W}x${H} tile ${tx},${ty} level ${level}`);
                    check(p, tx, ty, level, OUTS[ri(OUTS.length)], true, false, `${W}x${H} tile ${tx},${ty} level ${level} ring`);
                }
            }
            // a tile outside the image and one past the last column
            assert.equal(p.tileWithGutter(cols, 0, level), null);
        }
        // every output kind once on one tile at level 0 and level 3
        for (const ok of OUTS) for (const level of [0, 3]) check(p, 0, 0, level, ok, false, false, `${W}x${H} every out level ${level}`);
    }

    // display: stale chains (built, then the tiles rewritten) and the coarse picture (tiles that never had a chain),
    // with a scheduler that builds nothing here
    {
        const W = 601, H = 501;
        const p = makeStore(T, W, H);
        const cols = Math.ceil(W / TS), rows = Math.ceil(H / TS);
        // some tiles' chains built (that tile's alone: a slot would build its neighbours' too), the rest never had one
        for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) if ((tx + ty) % 2) p._levelBytes(tx, ty, 2);
        for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) rewrite(p, tx, ty);
        p._chains = { mayBuild: () => false, request() {} };
        for (let level = 1; level <= T.MIP_LEVELS; level++) {
            for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
                for (const ok of [OUTS[0], OUTS[3], OUTS[5]]) {
                    check(p, tx, ty, level, ok, false, true, `display ${tx},${ty} level ${level}`);
                    check(p, tx, ty, level, ok, true, true, `display ${tx},${ty} level ${level} ring`);
                }
            }
        }
        assert.ok(stats.coarse > 0, "no coarse slot was made (the display case is vacuous)");
        assert.ok(stats.stale > 0, "no stale slot was made (the display case is vacuous)");
    }

    // sources off a word boundary: `_levelBytes` answers with copies at byteOffset 1-3, or with `off` moved by 2, for
    // some neighbours; those take the byte path while the rest take words
    {
        const W = 770, H = 530;
        const p = makeStore(T, W, H);
        const lb = p._levelBytes;
        p._levelBytes = function (tx, ty, level, display) {
            const r = lb.call(this, tx, ty, level, display);
            if (!r || r.coarse || ((tx + ty + level) % 3) === 0) return r;
            const len = r.data.length, shift = 1 + ((tx * 7 + ty * 3 + level) % 3);
            if ((tx + level) % 2) {
                const buf = new Uint8Array(new ArrayBuffer(len + 8), shift, len);
                buf.set(r.data);
                return { ...r, data: buf };
            }
            const buf = new Uint8Array(len + 2);   // aligned, but `off` two bytes in
            buf.set(r.data, 2);
            return { ...r, data: buf, off: r.off + 2 };
        };
        for (let level = 0; level <= T.MIP_LEVELS; level++) {
            for (let ty = 0; ty < 3; ty++) for (let tx = 0; tx < 4; tx++) {
                check(p, tx, ty, level, OUTS[1], false, false, `misaligned source ${tx},${ty} level ${level}`);
                check(p, tx, ty, level, OUTS[3], true, false, `misaligned source ${tx},${ty} level ${level} ring`);
            }
        }
        p._levelBytes = lb;
        assert.ok(stats.misalignedSources > 0, "no source off a word boundary was read (the case is vacuous)");
    }
    assert.ok(stats.words > 0 || !little, "the word path never ran");
    assert.ok(stats.bytePath > 0, "the byte path never ran");
    console.log(JSON.stringify(stats));
    console.log(failures ? "RESULT FAIL" : "RESULT PASS");
}

main().catch((err) => { console.error(err && err.stack || err); console.log("RESULT FAIL"); process.exit(1); });
