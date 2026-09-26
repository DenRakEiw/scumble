// Reading and writing TIFF files (renderer/editor/inpaint_tiff.js, docs/PLAN_0_1_29.md 3d), in plain Node, no Electron:
//   node tools/tiff_test.js [--out DIR] [--keep]
// --out DIR: the fixtures and the written files go to DIR/fixtures and DIR (kept); without it a temp folder, removed
// after a pass. `python` on PATH (or $PYTHON) with numpy, tifffile and Pillow: the fixtures come from
// tools/tiff_fixtures.py, and the files this test builds or writes are cross-checked by tifffile and Pillow.
//
// a) every fixture of tools/tiff_fixtures.py: accepted ones give exactly the expected RGBA bytes, in bands of at most
//    rowsPerBand rows (256 and 7), in order and without a gap, with the notes; refused ones throw a matching message
//    (header-level refusals before any row);
// b) files built here byte by byte, both byte orders: predictor 2 at 16 bit big-endian, ExtraSamples [0] and [2, 0],
//    StripByteCounts / StripOffsets past the end, IFD loops (in a child process with a time limit), LZW across many
//    table resets and with long runs, old-style LZW;
// c) the writer: tiffStripRows, tiffPart, TiffStreamWriter over 1001 x 777 with soft alpha and 3 x 1 (predictor 2 and
//    1), read back by readTiff, by tifffile and by Pillow; the 4 GiB check.
//
// Assumptions about the API where its description leaves a choice (the strict reading each time):
// - info.photometric / compression / predictor / planar are the numeric tag values, predictor 1 and planar 1 when the
//   tags are missing; bits is BitsPerSample of the first sample; samples is SamplesPerPixel with the extra channels;
//   tiled and bigtiff are booleans; pages counts the IFDs of the main chain (the two-page fixture says 2; the fixture
//   whose first IFD is a thumbnail is not asked). tiffInfo reports the same fields and the same notes as readTiff.
// - A note matches when it contains the manifest's substring, compared without case.
// - onHeader is called once, before the first onRows, with the width and height. Every onRows `rgba` is an instance of
//   Uint8Array (a Uint8ClampedArray is not), exactly rows * width * 4 long; the callback may keep it: the bands are
//   put together only after readTiff resolved, and no two bands share bytes.
// - A header-level refusal (CMYK, JPEG, float, signed, 32 bits, an unread compression, not a TIFF) is thrown by
//   tiffInfo too, and readTiff calls no onRows before it throws.
// - A StripByteCounts or StripOffsets that reaches past the end of the file is an error, uncompressed data included.
// - An IFD loop may end in any Error or in the first page read correctly; it must end (20 s in a child process).
// - tiffStripRows(width) is the largest power of two up to 256 whose strip (rows * width * 4 bytes) stays within
//   8 MiB, and 1 when a single row is larger.
// - tiffPart: `chunk` is an ArrayBuffer holding exactly the zlib stream (78 9C ... Adler-32) of the strip, `raw` the
//   bytes before compression (rows * w * 4); the input is left as it was; a Uint8Array view with a byteOffset is read
//   as the view; predictor defaults to 2.
// - TiffStreamWriter.add(rows, { rgba }, transfer): the writer hands `run` the whole job itself, { w, rows, predictor,
//   ...args }, as PngStreamWriter does; add() throws for a part of other than tiffStripRows(width) rows unless it is
//   the last, and for rows past the height; finish() rejects before every row is in; at most `flights` parts run at
//   once; parts finishing out of order are still written in row order; every strip of the file is a zlib stream of
//   its own. The file: classic little-endian, one IFD, BitsPerSample 8,8,8,8, Compression 8, Photometric 2,
//   SamplesPerPixel 4, ExtraSamples [2], RowsPerStrip tiffStripRows(W), X/YResolution 72 with ResolutionUnit 2,
//   Software "Scumble", SampleFormat and PlanarConfiguration 1 where written, Predictor as asked (a missing tag
//   counts as 1).
// - TiffStreamWriter.check(width, height) is static, throws /4 GB|BigTIFF/ for 32768 x 32768 and 40000 x 30000 and
//   passes 30000 x 30000 and 1001 x 777.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
// SCUMBLE_TIFF_MODULE: another copy of the module (a mutation round runs on a copy, never on the tree)
const MODULE = process.env.SCUMBLE_TIFF_MODULE ? path.resolve(process.env.SCUMBLE_TIFF_MODULE) : path.join(ROOT, "renderer", "editor", "inpaint_tiff.js");
const ARGS = process.argv.slice(2);
const OUT_ARG = ARGS.includes("--out") ? ARGS[ARGS.indexOf("--out") + 1] : null;
const OUT = OUT_ARG ? path.resolve(OUT_ARG) : fs.mkdtempSync(path.join(os.tmpdir(), "scumble_tiff_"));
const KEEP = !!OUT_ARG || ARGS.includes("--keep");
const FIX = path.join(OUT, "fixtures");
const PY = process.env.PYTHON || "python";

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
    return !!ok;
}
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 400 ? s.slice(0, 400) + " ..." : s; };
const errText = (err) => String((err && err.message) || err);

// ---- small helpers -------------------------------------------------------------------------------------------

/** A seeded generator of 32-bit values (mulberry32). */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return (t ^ (t >>> 14)) >>> 0;
    };
}

/** 16 bit to 8: floor(v / 257 + 0.5), in integers (2v + 257) / 514 rounded down. */
const to8 = (v) => Math.floor((v * 2 + 257) / 514);

/** The first differing byte of two pictures as a pixel, and how many bytes differ; null when equal. */
function pixelDiff(got, want, width) {
    if (!got || got.length !== want.length) return `${got ? got.length : "no"} bytes instead of ${want.length}`;
    let n = 0, first = -1;
    for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) { if (first < 0) first = i; n++; }
    if (!n) return null;
    const px = first >> 2, x = px % width, y = Math.floor(px / width), o = px * 4;
    return `${n} bytes differ; first at pixel (${x}, ${y}): got [${Array.from(got.subarray(o, o + 4))}] want [${Array.from(want.subarray(o, o + 4))}]`;
}

function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/** Read a whole picture through readTiff, recording every callback. */
async function readAll(T, blob, rowsPerBand) {
    const events = [], bands = [];
    let header = null, headerCalls = 0;
    const opts = {
        onHeader(i) { headerCalls++; header = i; events.push("header"); },
        onRows(rgba, y0, rows) { bands.push({ rgba, y0, rows }); events.push("rows"); },
    };
    if (rowsPerBand) opts.rowsPerBand = rowsPerBand;
    const info = await T.readTiff(blob, opts);
    return { info, header, headerCalls, bands, events };
}

/** The problems of a read's bands, and the picture put together from them (after the read). */
function assemble(r, width, height, rowsPerBand) {
    const problems = [];
    if (r.headerCalls !== 1) problems.push(`onHeader was called ${r.headerCalls} times`);
    else if (r.events[0] !== "header") problems.push("onRows came before onHeader");
    if (r.header && (r.header.width !== width || r.header.height !== height)) problems.push(`onHeader says ${r.header.width} x ${r.header.height}, not ${width} x ${height}`);
    let next = 0;
    for (const b of r.bands) {
        if (!(b.rgba instanceof Uint8Array)) problems.push(`the band at row ${b.y0} is a ${b.rgba && b.rgba.constructor ? b.rgba.constructor.name : typeof b.rgba}, not a Uint8Array`);
        if (b.y0 !== next) problems.push(`a band starts at row ${b.y0} where row ${next} was next`);
        if (!(b.rows >= 1 && b.rows <= rowsPerBand)) problems.push(`a band of ${b.rows} rows (rowsPerBand ${rowsPerBand})`);
        if (b.rgba && b.rgba.length !== b.rows * width * 4) problems.push(`the band at row ${b.y0} holds ${b.rgba.length} bytes, not ${b.rows} x ${width} x 4`);
        next = b.y0 + b.rows;
        if (problems.length > 6) break;
    }
    if (next !== height) problems.push(`the rows end at ${next} of ${height}`);
    // the callback may keep its array: no two bands may share bytes
    const byBuffer = new Map();
    for (const b of r.bands) {
        if (!b.rgba || !b.rgba.buffer) continue;
        if (!byBuffer.has(b.rgba.buffer)) byBuffer.set(b.rgba.buffer, []);
        byBuffer.get(b.rgba.buffer).push([b.rgba.byteOffset, b.rgba.byteOffset + b.rgba.byteLength]);
    }
    for (const spans of byBuffer.values()) {
        spans.sort((a, b) => a[0] - b[0]);
        for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) { problems.push("two bands share bytes of one buffer (the callback cannot keep them)"); break; }
    }
    const img = new Uint8Array(width * height * 4);
    for (const b of r.bands) {
        if (!b.rgba || !(b.y0 >= 0) || b.y0 >= height) continue;
        const n = Math.min(b.rgba.length, img.length - b.y0 * width * 4);
        img.set(b.rgba.subarray(0, n), b.y0 * width * 4);
    }
    return { problems, img };
}

/** Where info differs from what the manifest says. */
function infoProblems(info, e, what) {
    const p = [];
    if (!info || typeof info !== "object") return [`${what} returned ${short(info)}, not an info object`];
    if (info.width !== e.width || info.height !== e.height) p.push(`${what}: ${info.width} x ${info.height} instead of ${e.width} x ${e.height}`);
    if (!Array.isArray(info.notes) || info.notes.some((n) => typeof n !== "string")) p.push(`${what}: notes is ${short(info.notes)}, not an array of strings`);
    else for (const sub of e.notes || []) if (!info.notes.some((n) => n.toLowerCase().includes(sub.toLowerCase()))) p.push(`${what}: no note mentions "${sub}" (notes: ${short(info.notes)})`);
    for (const [k, v] of Object.entries(e.info || {})) if (info[k] !== v) p.push(`${what}: info.${k} is ${short(info[k])}, expected ${short(v)}`);
    return p;
}

function python(args, timeout = 600000) {
    const r = spawnSync(PY, args, { cwd: ROOT, encoding: "utf-8", timeout, maxBuffer: 64 * 1048576 });
    if (r.error) throw new Error(`${PY} ${args[0]}: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`${PY} ${args[0]} exited ${r.status}: ${(r.stderr || r.stdout || "").slice(-1500)}`);
    return r.stdout;
}

function pyJson(args) {
    const out = python(args).trim().split(/\r?\n/);
    return JSON.parse(out[out.length - 1]);
}

// ---- a TIFF builder for the byte-built cases ------------------------------------------------------------------

const TSIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };

function encodeValues(le, type, values) {
    if (type === 2) return new Uint8Array(Buffer.from(String(values) + "\0", "latin1"));
    const out = new Uint8Array(TSIZE[type] * values.length);
    const dv = new DataView(out.buffer);
    values.forEach((v, i) => {
        if (type === 1 || type === 7) out[i] = v;
        else if (type === 3) dv.setUint16(i * 2, v, le);
        else if (type === 4) dv.setUint32(i * 4, v >>> 0, le);
        else if (type === 5) { dv.setUint32(i * 8, v[0], le); dv.setUint32(i * 8 + 4, v[1], le); }
    });
    return out;
}

/**
 * A classic TIFF from pages [{ tags: [[tag, type, values]], data: [Uint8Array per strip], offTag?, cntTag? }]; the
 * data of a page comes before its IFD. Returns { bytes, ifdAt, links } (links[i]: where the pointer to IFD i lies,
 * links[0] = 4 in the header, links[i + 1] the next pointer of IFD i).
 */
function buildTiff(pages, { le = true } = {}) {
    const parts = [];
    let size = 0;
    const push = (b) => { parts.push(b); size += b.length; };
    const pad = () => { if (size % 2) push(new Uint8Array(1)); };
    push(Uint8Array.from(le ? [0x49, 0x49, 42, 0, 0, 0, 0, 0] : [0x4D, 0x4D, 0, 42, 0, 0, 0, 0]));
    const links = [4], ifdAt = [];
    for (const page of pages) {
        const offsets = [];
        for (const seg of page.data) { pad(); offsets.push(size); push(seg); }
        const tags = new Map(page.tags.map(([t, ty, v]) => [t, [ty, v]]));
        tags.set(page.offTag || 273, [4, offsets]);
        tags.set(page.cntTag || 279, [4, page.data.map((s) => s.length)]);
        pad();
        const at = size;
        ifdAt.push(at);
        const entries = [...tags.entries()].sort((a, b) => a[0] - b[0]);
        const ifd = new Uint8Array(2 + 12 * entries.length + 4);
        const dv = new DataView(ifd.buffer);
        dv.setUint16(0, entries.length, le);
        let extraAt = at + ifd.length;
        const extras = [];
        entries.forEach(([tag, [type, vals]], i) => {
            const payload = encodeValues(le, type, vals);
            const count = type === 2 || type === 7 ? payload.length : vals.length;
            const p = 2 + 12 * i;
            dv.setUint16(p, tag, le); dv.setUint16(p + 2, type, le); dv.setUint32(p + 4, count, le);
            if (payload.length <= 4) ifd.set(payload, p + 8);
            else {
                if (extraAt % 2) { extras.push(new Uint8Array(1)); extraAt++; }
                dv.setUint32(p + 8, extraAt, le);
                extras.push(payload);
                extraAt += payload.length;
            }
        });
        links.push(at + 2 + 12 * entries.length);
        push(ifd);
        for (const e of extras) push(e);
    }
    const bytes = new Uint8Array(size);
    let o = 0;
    for (const p of parts) { bytes.set(p, o); o += p.length; }
    const dv = new DataView(bytes.buffer);
    ifdAt.forEach((at, i) => dv.setUint32(links[i], at, le));
    return { bytes, ifdAt, links };
}

/** The IFDs of a classic TIFF: [Map(tag -> { type, count, values, entryAt, valueAt })]. */
function parseTiff(u8) {
    const le = u8[0] === 0x49;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dv.getUint16(2, le) !== 42) throw new Error("not a classic TIFF (magic " + dv.getUint16(2, le) + ")");
    let off = dv.getUint32(4, le);
    const ifds = [], seen = new Set();
    while (off && !seen.has(off) && off + 2 <= u8.length) {
        seen.add(off);
        const n = dv.getUint16(off, le);
        const tags = new Map();
        for (let i = 0; i < n; i++) {
            const p = off + 2 + 12 * i;
            const tag = dv.getUint16(p, le), type = dv.getUint16(p + 2, le), count = dv.getUint32(p + 4, le);
            const size = (TSIZE[type] || 1) * count;
            const at = size <= 4 ? p + 8 : dv.getUint32(p + 8, le);
            const values = [];
            for (let k = 0; k < count && at + size <= u8.length; k++) {
                if (type === 3) values.push(dv.getUint16(at + 2 * k, le));
                else if (type === 4) values.push(dv.getUint32(at + 4 * k, le));
                else if (type === 5) values.push([dv.getUint32(at + 8 * k, le), dv.getUint32(at + 8 * k + 4, le)]);
                else values.push(u8[at + k]);
            }
            tags.set(tag, { type, count, values, entryAt: p, valueAt: at });
        }
        ifds.push(tags);
        off = dv.getUint32(off + 2 + 12 * n, le);
    }
    return { le, ifds };
}

const asciiOf = (t) => (t ? Buffer.from(t.values).toString("latin1").replace(/\0+$/, "") : null);

/** Samples (a typed array of 8- or 16-bit values) as file bytes. */
function sampleBytes(samples, bits, le) {
    if (bits === 8) return Uint8Array.from(samples);
    const out = new Uint8Array(samples.length * 2);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < samples.length; i++) dv.setUint16(i * 2, samples[i], le);
    return out;
}

/** Horizontal differencing (Predictor 2) of rows x w x spp samples, modulo 2^bits. */
function hdiff(samples, w, spp, rows, bits) {
    const out = samples.slice();
    const mask = bits === 16 ? 0xFFFF : 0xFF;
    for (let y = 0; y < rows; y++) {
        const r = y * w * spp;
        for (let x = w - 1; x >= 1; x--) for (let c = 0; c < spp; c++) out[r + x * spp + c] = (samples[r + x * spp + c] - samples[r + (x - 1) * spp + c]) & mask;
    }
    return out;
}

function imageTags({ w, h, bits, spp, photometric, compression = 1, predictor = 1, rps, extra = null }) {
    const t = [[254, 4, [0]], [256, 4, [w]], [257, 4, [h]], [258, 3, Array(spp).fill(bits)], [259, 3, [compression]], [262, 3, [photometric]],
        [277, 3, [spp]], [278, 4, [rps]], [282, 5, [[72, 1]]], [283, 5, [[72, 1]]], [284, 3, [1]], [296, 3, [2]]];
    if (predictor !== 1) t.push([317, 3, [predictor]]);
    if (extra) t.push([338, 3, extra]);
    return t;
}

/** Strips of rps rows from interleaved samples, each compressed by `encode` (bytes -> bytes). */
function strips(samples, w, h, spp, bits, le, rps, { predictor = 1, encode = (b) => b } = {}) {
    const out = [];
    for (let y = 0; y < h; y += rps) {
        const rows = Math.min(rps, h - y);
        let s = samples.slice(y * w * spp, (y + rows) * w * spp);
        if (predictor === 2) s = hdiff(s, w, spp, rows, bits);
        out.push(encode(sampleBytes(s, bits, le)));
    }
    return out;
}

/**
 * TIFF LZW: new style (MSB-first codes, the early change of libtiff: a code is written wider once the next free entry
 * passes 2^bits - 1, a Clear when it reaches 4094) or `lsb` (the old style: LSB-first codes, one entry later).
 */
function lzwEncode(data, { lsb = false } = {}) {
    const out = [];
    let acc = 0, nacc = 0;
    const put = lsb
        ? (code, width) => { acc |= code << nacc; nacc += width; while (nacc >= 8) { out.push(acc & 255); acc >>>= 8; nacc -= 8; } }
        : (code, width) => { acc = (acc << width) | code; nacc += width; while (nacc >= 8) { nacc -= 8; out.push((acc >>> nacc) & 255); } acc &= (1 << nacc) - 1; };
    const early = lsb ? 0 : 1;
    let width = 9, next = 258, resets = 0;
    const table = new Map();
    put(256, width);
    let w = data[0];
    for (let i = 1; i < data.length; i++) {
        const b = data[i];
        const c = table.get(w * 256 + b);
        if (c !== undefined) { w = c; continue; }
        put(w, width);
        table.set(w * 256 + b, next++);
        if (next === 4094) { put(256, width); table.clear(); next = 258; width = 9; resets++; }
        else if (next > (1 << width) - early) width++;
        w = b;
    }
    put(w, width);
    next++;
    if (next === 4094) { put(256, width); width = 9; } else if (next > (1 << width) - early) width++;
    put(257, width);
    if (nacc) out.push(lsb ? acc & 255 : (acc << (8 - nacc)) & 255);
    return { bytes: Uint8Array.from(out), resets };
}

/** RGBA8 expected from interleaved 8- or 16-bit samples: `pick(samples, i)` -> [r, g, b, a]. */
function expectRgba(n, pick) {
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) out.set(pick(i), i * 4);
    return out;
}

const CROSS_PY = `import json, sys
import numpy as np
path, raw, dtype, h, w, c, dec = sys.argv[1:8]
src = np.fromfile(raw, dtype=np.dtype(dtype)).reshape(int(h), int(w), int(c))
if dec == "tifffile":
    import tifffile
    a = tifffile.imread(path, key=0)
else:
    from PIL import Image
    im = Image.open(path)
    im.load()
    a = np.asarray(im)
a = a.reshape(src.shape) if a.size == src.size else a
print(json.dumps({"equal": bool(a.shape == src.shape and (a == src).all()), "shape": list(a.shape), "dtype": str(a.dtype)}))
`;

/** Is the file the test built what it means to be? tifffile or Pillow decodes it against the samples. */
function crossCheck(name, bytes, samples, bits, h, w, c, decoder) {
    const f = path.join(OUT, `built_${name}.tif`);
    const raw = path.join(OUT, `built_${name}.raw`);
    fs.writeFileSync(f, bytes);
    const arr = bits === 16 ? new Uint16Array(samples) : new Uint8Array(samples);
    fs.writeFileSync(raw, Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
    const r = pyJson([path.join(OUT, "cross_check.py"), f, raw, bits === 16 ? "<u2" : "u1", String(h), String(w), String(c), decoder]);
    if (!r.equal) throw new Error(`the test's own ${name} file is not what it means to be (${decoder} reads ${JSON.stringify(r)})`);
    return f;
}

// ---- deflate through CompressionStream, as the app's kernels_js.js does ------------------------------------------

async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---- the cases ------------------------------------------------------------------------------------------------

async function fixtureCases(T) {
    fs.mkdirSync(FIX, { recursive: true });
    const t0 = Date.now();
    const table = python([path.join(ROOT, "tools", "tiff_fixtures.py"), FIX], 900000);
    const manifest = JSON.parse(fs.readFileSync(path.join(FIX, "manifest.json"), "utf-8"));
    check("fixtures", manifest.length > 40 && /fixtures \(/.test(table), `${manifest.length} written by tools/tiff_fixtures.py in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    for (const e of manifest) {
        const bytes = fs.readFileSync(path.join(FIX, e.file));
        const blob = new Blob([bytes]);
        const head = new Uint8Array(bytes.subarray(0, 16));
        const want = e.name !== "not_tiff";
        let isT;
        try { isT = T.isTiff(head); } catch (err) { isT = "threw " + errText(err); }
        if (isT !== want) check(`isTiff ${e.name}`, false, `${short(isT)} instead of ${want}`);
        if (e.accept) await acceptedFixture(T, e, blob);
        else await refusedFixture(T, e, blob);
    }
}

async function acceptedFixture(T, e, blob) {
    const want = new Uint8Array(fs.readFileSync(path.join(FIX, e.expect)));
    const problems = [];
    let bandsSeen = [];
    for (const rpb of [256, 7]) {
        let r;
        try { r = await readAll(T, blob, rpb); } catch (err) { problems.push(`rowsPerBand ${rpb}: threw ${errText(err)}`); continue; }
        const a = assemble(r, e.width, e.height, rpb);
        for (const p of a.problems) problems.push(`rowsPerBand ${rpb}: ${p}`);
        const d = pixelDiff(a.img, want, e.width);
        if (d) problems.push(`rowsPerBand ${rpb}: ${d}`);
        for (const p of infoProblems(r.info, e, "readTiff")) problems.push(p);
        bandsSeen.push(r.bands.length);
    }
    try {
        const i = await T.tiffInfo(blob);
        for (const p of infoProblems(i, e, "tiffInfo")) problems.push(p);
    } catch (err) { problems.push(`tiffInfo threw ${errText(err)}`); }
    const uniq = [...new Set(problems)];
    check(`reads ${e.name}`, !uniq.length, uniq.length ? uniq.slice(0, 5).join(" | ") : `${e.width} x ${e.height}, ${bandsSeen.join(" / ")} bands`);
}

async function refusedFixture(T, e, blob) {
    const re = new RegExp(e.error, e.error_flags || "");
    let rowsCalls = 0, err = null;
    try { await T.readTiff(blob, { onRows: () => { rowsCalls++; } }); } catch (x) { err = x; }
    const problems = [];
    if (!err) problems.push("readTiff read it without an error");
    else {
        if (!(err instanceof Error)) problems.push(`readTiff threw a ${typeof err}, not an Error`);
        if (!re.test(errText(err))) problems.push(`the message "${errText(err)}" does not match ${re}`);
        if (e.header && rowsCalls) problems.push(`${rowsCalls} onRows calls before the refusal`);
    }
    if (e.header) {
        let ierr = null;
        try { await T.tiffInfo(blob); } catch (x) { ierr = x; }
        if (!ierr) problems.push("tiffInfo accepted it");
        else if (!re.test(errText(ierr))) problems.push(`tiffInfo says "${errText(ierr)}", not ${re}`);
    }
    check(`refuses ${e.name}`, !problems.length, problems.length ? problems.join(" | ") : `"${errText(err)}"`);
}

/** A read of a byte-built file: pixels, notes and fields. */
async function expectRead(T, name, bytes, width, height, want, { notes = [], info = {} } = {}) {
    const e = { name, width, height, notes, info };
    const blob = new Blob([bytes]);
    const problems = [];
    for (const rpb of [256, 3]) {
        let r;
        try { r = await readAll(T, blob, rpb); } catch (err) { problems.push(`rowsPerBand ${rpb}: threw ${errText(err)}`); continue; }
        const a = assemble(r, width, height, rpb);
        problems.push(...a.problems.map((p) => `rowsPerBand ${rpb}: ${p}`));
        const d = pixelDiff(a.img, want, width);
        if (d) problems.push(`rowsPerBand ${rpb}: ${d}`);
        problems.push(...infoProblems(r.info, e, "readTiff"));
    }
    const uniq = [...new Set(problems)];
    return check(name, !uniq.length, uniq.slice(0, 5).join(" | "));
}

async function expectRefusal(T, name, bytes, re) {
    let err = null;
    try { await T.readTiff(new Blob([bytes]), { onRows: () => {} }); } catch (x) { err = x; }
    return check(name, !!err && err instanceof Error && re.test(errText(err)), err ? `"${errText(err)}"` : "no error");
}

async function builtCases(T) {
    fs.writeFileSync(path.join(OUT, "cross_check.py"), CROSS_PY);

    // -- isTiff on the four signatures and on what is none of them --
    const heads = [
        [[0x49, 0x49, 0x2A, 0x00, 8, 0, 0, 0], true, "II*\\0"], [[0x4D, 0x4D, 0x00, 0x2A, 0, 0, 0, 8], true, "MM\\0*"],
        [[0x49, 0x49, 0x2B, 0x00, 8, 0, 0, 0], true, "II+\\0 (BigTIFF)"], [[0x4D, 0x4D, 0x00, 0x2B, 0, 8, 0, 0], true, "MM\\0+ (BigTIFF)"],
        [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], false, "a PNG"], [[0x49, 0x49, 0x00, 0x2A], false, "II\\0*"],
        [[0x49, 0x49, 0x2A], false, "three bytes"], [[], false, "nothing"], [[0x38, 0x42, 0x50, 0x53, 0, 1], false, "a PSD"],
    ];
    const wrong = [];
    for (const [b, want, what] of heads) {
        let got;
        try { got = T.isTiff(Uint8Array.from(b)); } catch (err) { got = "threw " + errText(err); }
        if (got !== want) wrong.push(`${what}: ${short(got)}`);
    }
    check("isTiff signatures", !wrong.length, wrong.join(", ") || `${heads.length} heads`);

    // -- Predictor 2 at 16 bit, big-endian, deflate, two strips of 4 and 3 rows --
    {
        const w = 13, h = 7, spp = 3, r = rng(101);
        const s = new Uint16Array(w * h * spp);
        for (let i = 0; i < s.length; i++) s[i] = r() & 0xFFFF;
        for (let i = 0; i < w * spp; i++) s[i] = 257 * (i % 255) + (i % 2 ? 129 : 128);   // the rounding edges in row 0
        s[w * spp] = 0; s[w * spp + 1] = 65535; s[w * spp + 2] = 65534;
        const data = strips(s, w, h, spp, 16, false, 4, { predictor: 2, encode: (b) => zlib.deflateSync(b) });
        const { bytes } = buildTiff([{ tags: imageTags({ w, h, bits: 16, spp, photometric: 2, compression: 8, predictor: 2, rps: 4 }), data }], { le: false });
        crossCheck("pred16_be", bytes, s, 16, h, w, spp, "tifffile");
        const want = expectRgba(w * h, (i) => [to8(s[i * 3]), to8(s[i * 3 + 1]), to8(s[i * 3 + 2]), 255]);
        await expectRead(T, "predictor 2 at 16 bit big-endian (deflate)", bytes, w, h, want, { info: { bits: 16, samples: 3, photometric: 2, compression: 8, predictor: 2, planar: 1, tiled: false, bigtiff: false, alpha: "none" } });
    }

    // -- ExtraSamples [0]: RGB and an unspecified channel --
    {
        const w = 9, h = 5, spp = 4, r = rng(102);
        const s = new Uint8Array(w * h * spp);
        for (let i = 0; i < s.length; i++) s[i] = r() & 255;
        const { bytes } = buildTiff([{ tags: imageTags({ w, h, bits: 8, spp, photometric: 2, rps: 2, extra: [0] }), data: strips(s, w, h, spp, 8, true, 2) }]);
        crossCheck("extra0", bytes, s, 8, h, w, spp, "tifffile");
        const want = expectRgba(w * h, (i) => [s[i * 4], s[i * 4 + 1], s[i * 4 + 2], 255]);
        await expectRead(T, "ExtraSamples [0] (an unspecified channel is left out)", bytes, w, h, want, { notes: ["extra channel"], info: { samples: 4, alpha: "none" } });
    }

    // -- ExtraSamples [2, 0]: RGBA and an unspecified channel, 8 bit little-endian and 16 bit big-endian --
    for (const [bits, le] of [[8, true], [16, false]]) {
        const w = 11, h = 6, spp = 5, r = rng(103 + bits);
        const s = bits === 16 ? new Uint16Array(w * h * spp) : new Uint8Array(w * h * spp);
        for (let i = 0; i < s.length; i++) s[i] = bits === 16 ? r() & 0xFFFF : r() & 255;
        for (let y = 0; y < h; y++) { s[(y * w) * spp + 3] = 0; s[(y * w + 1) * spp + 3] = bits === 16 ? 65535 : 255; }
        const opts = bits === 16 ? { predictor: 2, encode: (b) => zlib.deflateSync(b) } : {};
        const { bytes } = buildTiff([{ tags: imageTags({ w, h, bits, spp, photometric: 2, compression: bits === 16 ? 8 : 1, predictor: bits === 16 ? 2 : 1, rps: 4, extra: [2, 0] }), data: strips(s, w, h, spp, bits, le, 4, opts) }], { le });
        crossCheck(`extra20_${bits}`, bytes, s, bits, h, w, spp, "tifffile");
        const cv = bits === 16 ? to8 : (v) => v;
        const want = expectRgba(w * h, (i) => [cv(s[i * 5]), cv(s[i * 5 + 1]), cv(s[i * 5 + 2]), cv(s[i * 5 + 3])]);
        await expectRead(T, `ExtraSamples [2, 0] at ${bits} bit ${le ? "II" : "MM"} (alpha kept, the extra channel left out)`, bytes, w, h, want, { notes: ["extra channel"], info: { bits, samples: 5, alpha: "straight" } });
    }

    // -- a strip that reaches past the end of the file: StripByteCounts, then StripOffsets --
    {
        const w = 9, h = 6, spp = 3, r = rng(104);
        const s = new Uint8Array(w * h * spp);
        for (let i = 0; i < s.length; i++) s[i] = r() & 255;
        const built = buildTiff([{ tags: imageTags({ w, h, bits: 8, spp, photometric: 2, rps: 3 }), data: strips(s, w, h, spp, 8, true, 3) }]);
        const tags = parseTiff(built.bytes).ifds[0];
        const counts = tags.get(279), offs = tags.get(273);
        const a = built.bytes.slice();
        new DataView(a.buffer).setUint32(counts.valueAt + 4, a.length, true);          // the second strip: as long as the file
        await expectRefusal(T, "StripByteCounts past the end of the file", a, /ends early|truncated/i);
        const b = built.bytes.slice();
        new DataView(b.buffer).setUint32(offs.valueAt + 4, b.length + 100, true);      // the second strip: after the end
        await expectRefusal(T, "StripOffsets past the end of the file", b, /ends early|truncated/i);
    }

    // -- IFD loops: must end (a child process with a time limit), with an Error or the first page --
    {
        const w = 5, h = 4, spp = 3, r = rng(105);
        const page = () => { const s = new Uint8Array(w * h * spp); for (let i = 0; i < s.length; i++) s[i] = r() & 255; return s; };
        const s0 = page(), s1 = page();
        const mk = () => buildTiff([
            { tags: imageTags({ w, h, bits: 8, spp, photometric: 2, rps: h }), data: strips(s0, w, h, spp, 8, true, h) },
            { tags: imageTags({ w, h, bits: 8, spp, photometric: 2, rps: h }), data: strips(s1, w, h, spp, 8, true, h) },
        ]);
        const want = Array.from(expectRgba(w * h, (i) => [s0[i * 3], s0[i * 3 + 1], s0[i * 3 + 2], 255]));
        const self = mk();
        new DataView(self.bytes.buffer).setUint32(self.links[1], self.ifdAt[0], true);   // IFD 0 -> IFD 0
        const two = mk();
        new DataView(two.bytes.buffer).setUint32(two.links[2], two.ifdAt[0], true);      // IFD 0 -> IFD 1 -> IFD 0
        const child = `import { readFileSync } from "node:fs";
const T = await import(${JSON.stringify(pathToFileURL(MODULE).href)});
const bytes = readFileSync(process.argv[2]);
const out = {};
try { const i = await T.tiffInfo(new Blob([bytes])); out.info = { width: i.width, height: i.height, pages: i.pages }; } catch (e) { out.infoError = String(e && e.message || e); }
try {
    const rows = [];
    const i = await T.readTiff(new Blob([bytes]), { onRows: (rgba, y0, n) => { rows.push(...Array.from(rgba)); } });
    out.read = { width: i.width, height: i.height, pages: i.pages, rgba: rows };
} catch (e) { out.readError = String(e && e.message || e); }
console.log(JSON.stringify(out));
`;
        const childFile = path.join(OUT, "ifd_loop_child.mjs");
        fs.writeFileSync(childFile, child);
        for (const [what, built] of [["an IFD that points to itself", self], ["two IFDs that point to each other", two]]) {
            const f = path.join(OUT, `built_loop_${built === self ? "self" : "two"}.tif`);
            fs.writeFileSync(f, built.bytes);
            const t0 = Date.now();
            const r = spawnSync(process.execPath, [childFile, f], { encoding: "utf-8", timeout: 20000 });
            if (r.error || r.signal) { check(`${what} does not hang`, false, `the child was stopped after ${Date.now() - t0} ms (${r.error ? r.error.code || r.error.message : r.signal})`); continue; }
            let out = null;
            try { out = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()); } catch (_) { /* below */ }
            if (!out) { check(`${what} does not hang`, false, `no answer: ${short(r.stdout + r.stderr)}`); continue; }
            const problems = [];
            if (out.read) {
                if (out.read.width !== w || out.read.height !== h) problems.push(`read as ${out.read.width} x ${out.read.height}`);
                if (JSON.stringify(out.read.rgba) !== JSON.stringify(want)) problems.push("the first page's pixels are not right");
                if (out.read.pages !== undefined && !(Number.isFinite(out.read.pages) && out.read.pages >= 1 && out.read.pages <= 2)) problems.push(`pages ${out.read.pages}`);
            }
            if (out.info && out.info.pages !== undefined && !(Number.isFinite(out.info.pages) && out.info.pages >= 1 && out.info.pages <= 2)) problems.push(`tiffInfo pages ${out.info.pages}`);
            check(`${what} does not hang`, !problems.length, problems.join(" | ") || `${Date.now() - t0} ms, ${out.read ? "first page read" : "refused: " + out.readError}`);
        }
    }

    // -- LZW over a long random row (many table resets), big-endian, and over long runs (KwKwK codes) --
    {
        const w = 50000, h = 1, r = rng(106);
        const s = new Uint8Array(w * 3);
        for (let i = 0; i < s.length; i++) s[i] = r() & 255;
        const enc = lzwEncode(s);
        const { bytes } = buildTiff([{ tags: imageTags({ w, h, bits: 8, spp: 3, photometric: 2, compression: 5, rps: 1 }), data: [enc.bytes] }], { le: false });
        crossCheck("lzw_long_row", bytes, s, 8, h, w, 3, "pillow");
        const want = expectRgba(w, (i) => [s[i * 3], s[i * 3 + 1], s[i * 3 + 2], 255]);
        await expectRead(T, `LZW over a random row of ${w} px (${enc.resets} table resets, MM)`, bytes, w, h, want, { info: { compression: 5 } });
    }
    {
        const w = 30000, h = 2, r = rng(107);
        const s = new Uint8Array(w * h * 3);
        let i = 0;
        while (i < s.length) {
            const run = 1 + (r() % 2000), v = r() & 255, mode = r() % 3;
            for (let k = 0; k < run && i < s.length; k++, i++) s[i] = mode === 0 ? v : mode === 1 ? (v + (k % 3)) & 255 : (k & 1 ? v : 255 - v);
        }
        const enc = lzwEncode(s.subarray(0, w * 3));
        const enc2 = lzwEncode(s.subarray(w * 3));
        const { bytes } = buildTiff([{ tags: imageTags({ w, h, bits: 8, spp: 3, photometric: 2, compression: 5, rps: 1 }), data: [enc.bytes, enc2.bytes] }]);
        crossCheck("lzw_runs", bytes, s, 8, h, w, 3, "pillow");
        const want = expectRgba(w * h, (k) => [s[k * 3], s[k * 3 + 1], s[k * 3 + 2], 255]);
        await expectRead(T, `LZW over long runs (${enc.bytes.length + enc2.bytes.length} bytes for ${s.length})`, bytes, w, h, want, { info: { compression: 5 } });
    }

    // -- old-style LZW (LSB-first codes: a strip that starts 00 01) --
    {
        const w = 16, h = 4, r = rng(108);
        const s = new Uint8Array(w * h * 3);
        for (let i = 0; i < s.length; i++) s[i] = r() & 255;
        s[0] = 0;   // the first code after the Clear is 0, so the strip starts 00 01
        const enc = lzwEncode(s, { lsb: true });
        const starts = enc.bytes[0] === 0x00 && enc.bytes[1] === 0x01;
        const { bytes } = buildTiff([{ tags: imageTags({ w, h, bits: 8, spp: 3, photometric: 2, compression: 5, rps: h }), data: [enc.bytes] }]);
        if (check("old-style LZW strip starts 00 01", starts, Array.from(enc.bytes.subarray(0, 4)).map((b) => b.toString(16).padStart(2, "0")).join(" "))) await expectRefusal(T, "old-style LZW is refused", bytes, /old-style LZW/i);
    }
}

/** A picture of W x H with gradients, noise and a soft alpha from 0 to 255. */
function softPicture(W, H, seed) {
    const r = rng(seed);
    const out = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const o = (y * W + x) * 4, n = (r() & 31) - 16;
            out[o] = Math.max(0, Math.min(255, Math.round((x * 255) / Math.max(1, W - 1)) + n));
            out[o + 1] = Math.max(0, Math.min(255, Math.round((y * 255) / Math.max(1, H - 1)) - n));
            out[o + 2] = (x * 7 + y * 3 + (r() & 7)) & 255;
            out[o + 3] = Math.max(0, Math.min(255, Math.round(((x / Math.max(1, W - 1)) * 1.6 - 0.3) * 255) + (n >> 2)));
        }
    }
    return out;
}

const WRITER_PY = `import json, sys
import numpy as np
import tifffile
from PIL import Image
path, raw, w, h = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
src = np.fromfile(raw, dtype=np.uint8).reshape(h, w, 4)
out = {}
with tifffile.TiffFile(path) as t:
    p = t.pages[0]
    a = p.asarray()
    tags = p.tags
    def ratio(name):
        if name not in tags:
            return None
        v = tags[name].value
        return v[0] / v[1] if isinstance(v, tuple) else float(v)
    out.update(tifffile_equal=bool(a.shape == src.shape and (a == src).all()), compression=int(p.compression), predictor=int(p.predictor),
               extrasamples=[int(x) for x in p.extrasamples], samples=int(p.samplesperpixel), photometric=int(p.photometric),
               bits=p.bitspersample, byteorder=t.byteorder, bigtiff=bool(t.is_bigtiff), pages=len(t.pages),
               software=tags["Software"].value if "Software" in tags else None, xres=ratio("XResolution"), yres=ratio("YResolution"),
               unit=int(tags["ResolutionUnit"].value) if "ResolutionUnit" in tags else None)
im = Image.open(path)
im.load()
b = np.asarray(im)
out.update(pillow_mode=im.mode, pillow_equal=bool(im.mode == "RGBA" and b.shape == src.shape and (b == src).all()))
print(json.dumps(out))
`;

async function writerCases(T) {
    fs.writeFileSync(path.join(OUT, "writer_check.py"), WRITER_PY);

    // -- tiffStripRows --
    {
        const wrong = [];
        for (const w of [1, 3, 1001, 2048, 8192, 8193, 15000, 40000, 3000000]) {
            let want = 256;
            while (want > 1 && want * w * 4 > 8 * 1048576) want >>= 1;
            let got;
            try { got = T.tiffStripRows(w); } catch (err) { got = "threw " + errText(err); }
            if (got !== want) wrong.push(`${w}: ${short(got)} instead of ${want}`);
        }
        check("tiffStripRows", !wrong.length, wrong.join(", ") || "the largest power of two up to 256 within 8 MiB");
    }

    // -- tiffPart: one strip --
    {
        const w = 5, rows = 3, r = rng(201);
        const src = new Uint8Array(w * rows * 4);
        for (let i = 0; i < src.length; i++) src[i] = r() & 255;
        const keep = src.slice();
        const problems = [];
        for (const pred of [2, 1, undefined]) {
            let res;
            try { res = await T.tiffPart(pred === undefined ? { rgba: src, w, rows } : { rgba: src, w, rows, predictor: pred }, deflate); } catch (err) { problems.push(`predictor ${pred}: threw ${errText(err)}`); continue; }
            if (!bytesEqual(src, keep)) problems.push(`predictor ${pred}: the input was changed`);
            if (!res || !(res.chunk instanceof ArrayBuffer)) { problems.push(`predictor ${pred}: chunk is ${res && res.chunk ? res.chunk.constructor.name : "missing"}, not an ArrayBuffer`); continue; }
            if (res.raw !== w * rows * 4) problems.push(`predictor ${pred}: raw ${res.raw}, not ${w * rows * 4}`);
            const c = new Uint8Array(res.chunk);
            if (c[0] !== 0x78 || c[1] !== 0x9C) problems.push(`predictor ${pred}: the chunk starts ${c[0]} ${c[1]}, not 78 9C`);
            let inflated = null;
            try { inflated = new Uint8Array(zlib.inflateSync(Buffer.from(c))); } catch (err) { problems.push(`predictor ${pred}: the chunk is no zlib stream (${errText(err)})`); continue; }
            const want = (pred === 1) ? src : hdiff(src, w, 4, rows, 8);
            if (!bytesEqual(inflated, want)) problems.push(`predictor ${pred}: the inflated strip is not the ${pred === 1 ? "picture" : "differenced picture"}`);
        }
        // an ArrayBuffer, and a view with a byteOffset
        try {
            const a = await T.tiffPart({ rgba: src.slice().buffer, w, rows, predictor: 2 }, deflate);
            if (!bytesEqual(new Uint8Array(zlib.inflateSync(Buffer.from(new Uint8Array(a.chunk)))), hdiff(src, w, 4, rows, 8))) problems.push("an ArrayBuffer source gives another strip");
            const big = new Uint8Array(src.length + 40);
            big.fill(7);
            big.set(src, 20);
            const b = await T.tiffPart({ rgba: big.subarray(20, 20 + src.length), w, rows, predictor: 2 }, deflate);
            if (!bytesEqual(new Uint8Array(zlib.inflateSync(Buffer.from(new Uint8Array(b.chunk)))), hdiff(src, w, 4, rows, 8))) problems.push("a view with a byteOffset is not read as the view");
        } catch (err) { problems.push("threw " + errText(err)); }
        check("tiffPart", !problems.length, problems.join(" | ") || "predictor 2 / 1 / default, ArrayBuffer and view sources");
    }

    // -- TiffStreamWriter: the files --
    const cases = [
        { W: 1001, H: 777, predictor: undefined, seed: 301 },   // the default predictor (2)
        { W: 3, H: 1, predictor: 2, seed: 302 },
        { W: 3, H: 1, predictor: 1, seed: 303 },
    ];
    for (const c of cases) {
        const { W, H } = c;
        const pred = c.predictor === undefined ? 2 : c.predictor;
        const name = `TiffStreamWriter ${W} x ${H} predictor ${c.predictor === undefined ? "default (2)" : c.predictor}`;
        const src = softPicture(W, H, c.seed);
        const problems = [];
        let blob = null, most = 0;
        const seen = [];
        try {
            const flights = 3;
            let inFlight = 0, n = 0;
            const run = async (args, transfer) => {
                const k = n++;
                inFlight++;
                most = Math.max(most, inFlight);
                seen.push({ w: args && args.w, rows: args && args.rows, predictor: args && args.predictor, transfer: Array.isArray(transfer) });
                try {
                    // the first of every three parts is the slowest, so parts finish out of order
                    await new Promise((res) => setTimeout(res, [18, 9, 1][k % 3]));
                    return await T.tiffPart(args, deflate);
                } finally { inFlight--; }
            };
            const wr = c.predictor === undefined ? new T.TiffStreamWriter(W, H, { run, flights }) : new T.TiffStreamWriter(W, H, { run, flights, predictor: c.predictor });
            const R = T.tiffStripRows(W);
            for (let y = 0; y < H; y += R) {
                const rows = Math.min(R, H - y);
                await wr.room();
                const part = src.slice(y * W * 4, (y + rows) * W * 4);
                wr.add(rows, { rgba: part }, [part.buffer]);
            }
            blob = await wr.finish();
            if (most > flights) problems.push(`${most} parts ran at once with flights ${flights}`);
            const bad = seen.filter((s) => s.w !== W || s.predictor !== pred || !(s.rows > 0));
            if (bad.length) problems.push(`run got ${short(bad[0])} (w ${W}, predictor ${pred} expected)`);
        } catch (err) { problems.push("threw " + errText(err)); }
        if (!blob) { check(name, false, problems.join(" | ")); continue; }
        if (!(blob instanceof Blob)) problems.push(`finish() gave a ${blob && blob.constructor ? blob.constructor.name : typeof blob}, not a Blob`);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        // the file as this test reads it
        try {
            if (bytes[0] !== 0x49 || bytes[1] !== 0x49 || bytes[2] !== 42 || bytes[3] !== 0) throw new Error("not a classic little-endian TIFF: " + Array.from(bytes.subarray(0, 4)));
            const { ifds } = parseTiff(bytes);
            if (ifds.length !== 1) problems.push(`${ifds.length} IFDs`);
            const t = ifds[0];
            const v = (tag) => (t.get(tag) ? t.get(tag).values : undefined);
            const R = T.tiffStripRows(W);
            const expectTag = (tag, want, what) => { const got = v(tag); if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${what} (${tag}) is ${short(got)}, not ${short(want)}`); };
            expectTag(256, [W], "ImageWidth"); expectTag(257, [H], "ImageLength"); expectTag(258, [8, 8, 8, 8], "BitsPerSample");
            expectTag(259, [8], "Compression"); expectTag(262, [2], "PhotometricInterpretation"); expectTag(277, [4], "SamplesPerPixel");
            expectTag(278, [R], "RowsPerStrip"); expectTag(338, [2], "ExtraSamples"); expectTag(296, [2], "ResolutionUnit");
            if (v(317) !== undefined || pred !== 1) expectTag(317, [pred], "Predictor");
            if (v(284) !== undefined) expectTag(284, [1], "PlanarConfiguration");
            if (v(339) !== undefined) expectTag(339, [1, 1, 1, 1], "SampleFormat");
            for (const tag of [282, 283]) { const r = v(tag); if (!r || r.length !== 1 || r[0][0] / r[0][1] !== 72) problems.push(`resolution tag ${tag} is ${short(r)}, not 72`); }
            if (asciiOf(t.get(305)) !== "Scumble") problems.push(`Software is ${short(asciiOf(t.get(305)))}`);
            const offs = v(273) || [], counts = v(279) || [];
            const nStrips = Math.ceil(H / R);
            if (offs.length !== nStrips || counts.length !== nStrips) problems.push(`${offs.length} offsets and ${counts.length} counts for ${nStrips} strips`);
            for (let i = 0; i < Math.min(offs.length, counts.length); i++) {
                if (offs[i] + counts[i] > bytes.length) { problems.push(`strip ${i} passes the end of the file`); break; }
                const rows = Math.min(R, H - i * R);
                let inflated;
                try { inflated = zlib.inflateSync(Buffer.from(bytes.subarray(offs[i], offs[i] + counts[i]))); } catch (err) { problems.push(`strip ${i} is no zlib stream of its own (${errText(err)})`); break; }
                if (inflated.length !== rows * W * 4) { problems.push(`strip ${i} inflates to ${inflated.length} bytes, not ${rows * W * 4}`); break; }
                const own = new Uint8Array(inflated);
                const want = pred === 2 ? hdiff(src.subarray(i * R * W * 4, (i * R + rows) * W * 4), W, 4, rows, 8) : src.subarray(i * R * W * 4, (i * R + rows) * W * 4);
                if (!bytesEqual(own, want)) { problems.push(`strip ${i} holds other bytes than rows ${i * R} to ${i * R + rows - 1}`); break; }
            }
        } catch (err) { problems.push("parse: " + errText(err)); }
        // read back by readTiff
        try {
            const r = await readAll(T, new Blob([bytes]), 256);
            const a = assemble(r, W, H, 256);
            problems.push(...a.problems);
            const d = pixelDiff(a.img, src, W);
            if (d) problems.push("readTiff: " + d);
            problems.push(...infoProblems(r.info, { width: W, height: H, notes: [], info: { bits: 8, samples: 4, photometric: 2, compression: 8, predictor: pred, planar: 1, tiled: false, bigtiff: false, alpha: "straight", pages: 1 } }, "readTiff"));
        } catch (err) { problems.push("readTiff threw " + errText(err)); }
        // read back by tifffile and Pillow
        try {
            const f = path.join(OUT, `written_${W}x${H}_p${pred}.tif`), raw = path.join(OUT, `written_${W}x${H}_p${pred}.rgba`);
            fs.writeFileSync(f, bytes);
            fs.writeFileSync(raw, src);
            const py = pyJson([path.join(OUT, "writer_check.py"), f, raw, String(W), String(H)]);
            const want = { tifffile_equal: true, pillow_equal: true, compression: 8, predictor: pred, extrasamples: [2], samples: 4, photometric: 2, byteorder: "<", bigtiff: false, pages: 1, software: "Scumble", xres: 72, yres: 72, unit: 2 };
            for (const [k, val] of Object.entries(want)) if (JSON.stringify(py[k]) !== JSON.stringify(val)) problems.push(`Python: ${k} is ${short(py[k])}, not ${short(val)}`);
        } catch (err) { problems.push("Python: " + errText(err)); }
        check(name, !problems.length, problems.slice(0, 6).join(" | ") || `${bytes.length} bytes, ${seen.length} parts, at most ${most} at once; readTiff, tifffile and Pillow read the source back`);
    }

    // -- the writer's refusals --
    {
        const problems = [];
        const run = (args) => T.tiffPart(args, deflate);
        const W = 1001, H = 777, R = T.tiffStripRows(W);
        const part = (rows) => ({ rgba: new Uint8Array(rows * W * 4) });
        try {
            const wr = new T.TiffStreamWriter(W, H, { run });
            let threw = false;
            try { wr.add(R - 1, part(R - 1)); } catch (_) { threw = true; }
            if (!threw) problems.push(`add(${R - 1} rows) as a first part of ${H} was taken (parts are ${R} rows but the last)`);
        } catch (err) { problems.push("threw " + errText(err)); }
        try {
            const wr = new T.TiffStreamWriter(W, H, { run });
            wr.add(R, part(R));
            let rejected = false;
            try { await wr.finish(); } catch (_) { rejected = true; }
            if (!rejected) problems.push("finish() with rows missing gave a file");
        } catch (err) { problems.push("threw " + errText(err)); }
        try {
            const wr = new T.TiffStreamWriter(3, 2, { run });
            wr.add(2, { rgba: new Uint8Array(24) });
            let threw = false;
            try { wr.add(1, { rgba: new Uint8Array(12) }); } catch (_) { threw = true; }
            if (!threw) problems.push("a part past the height was taken");
            await wr.finish().catch(() => {});
        } catch (err) { problems.push("threw " + errText(err)); }
        check("TiffStreamWriter refuses wrong parts", !problems.length, problems.join(" | "));
    }

    // -- the 4 GiB check --
    {
        const problems = [];
        if (typeof T.TiffStreamWriter.check !== "function") problems.push("TiffStreamWriter.check is not a function");
        else {
            for (const [w, h] of [[32768, 32768], [40000, 30000], [65535, 65535]]) {
                let err = null;
                try { T.TiffStreamWriter.check(w, h); } catch (x) { err = x; }
                if (!err) problems.push(`${w} x ${h} passed`);
                else if (!/4 GB|BigTIFF/.test(errText(err))) problems.push(`${w} x ${h}: "${errText(err)}" does not match /4 GB|BigTIFF/`);
            }
            for (const [w, h] of [[30000, 30000], [1001, 777], [15000, 10000]]) {
                try { T.TiffStreamWriter.check(w, h); } catch (x) { problems.push(`${w} x ${h} was refused: ${errText(x)}`); }
            }
        }
        check("TiffStreamWriter.check refuses past 4 GiB", !problems.length, problems.join(" | ") || "32768 x 32768, 40000 x 30000 and 65535 x 65535 refused; 30000 x 30000 passes");
    }
}

// ---- main -----------------------------------------------------------------------------------------------------

(async () => {
    let T;
    try {
        T = await import(pathToFileURL(MODULE).href);
    } catch (err) {
        check("import renderer/editor/inpaint_tiff.js", false, errText(err));
        console.log("FAIL");
        process.exit(1);
    }
    const missing = ["isTiff", "tiffInfo", "readTiff", "tiffStripRows", "tiffPart", "TiffStreamWriter"].filter((k) => typeof T[k] !== "function");
    if (!check("exports", !missing.length, missing.length ? "missing: " + missing.join(", ") : "isTiff, tiffInfo, readTiff, tiffStripRows, tiffPart, TiffStreamWriter")) {
        console.log("FAIL");
        process.exit(1);
    }
    for (const [what, fn] of [["fixtures", fixtureCases], ["byte-built files", builtCases], ["the writer", writerCases]]) {
        try { await fn(T); } catch (err) { check(what, false, "stopped: " + (err && err.stack ? err.stack.split("\n").slice(0, 3).join(" / ") : errText(err))); }
    }
    const ok = results.length > 0 && results.every(Boolean);
    if (ok && !KEEP) fs.rmSync(OUT, { recursive: true, force: true });
    else if (!ok) console.log(`files kept in ${OUT}`);
    console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
    console.log(ok ? "PASS" : "FAIL");
    process.exit(ok ? 0 : 1);
})();
