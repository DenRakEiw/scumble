// Reading PSD and ORA files (renderer/editor/inpaint_layered.js), in plain Node, no Electron:
//   node tools/layered_test.js
// The files are built here, byte by byte after Adobe's file format specification and the OpenRaster spec, so every
// case the reader claims to handle has a file of its own: RLE, raw, ZIP and ZIP with prediction; 8 and 16 bit; RGB
// and grayscale; a Unicode name; hidden, opacity, blend modes known and unknown; a group (its divider and folder
// record) that is hidden or half transparent, nested; layer masks kept as masks (docs/PLAN_0_1_31.md 3e: inside and
// outside their rectangle with either default colour, switched off, -3 alone, a 36-byte record with its second
// rectangle and parameters, a rectangle larger than, offset from, partly over or away from the layer, an empty one, 16
// bit, ZIP with prediction at the mask's own width, a -2 without a record); an adjustment layer; a clipping mask; an
// empty layer; a flat file (the merged picture only); the refusals (PSB, CMYK, 32 bit, a truncated file). ORA: stored
// and deflated entries, nested stacks with offsets, visibility, opacity, composite-op, a layer without its picture.
// The writers (inpaint_export.js PsdWriter on stand-in canvases, inpaint_bands.js PsdBandWriter on row sources with
// the psd_part job run here, on the JS twin and on px.wasm): a masked layer, a switched-off one and plain ones written,
// parsed by this file's own reader and read back by readPsd; the two writers byte-identical; without masks, the bytes
// of before (a SHA-256); ORA ignores a stray mask. The app side (open, drop, the round trip through the editor's own
// writers) is tools/layered_test.py.
"use strict";

const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

const EDITOR = path.join(__dirname, "..", "renderer", "editor");
const editorModule = (rel) => import(pathToFileURL(path.join(EDITOR, rel)).href);

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 300 ? s.slice(0, 300) + " ..." : s; };
async function throwsWith(fn, re) {
    try { await fn(); return { ok: false, msg: "(no error)" }; } catch (err) { const msg = String(err && err.message || err); return { ok: re.test(msg), msg }; }
}

// ---- a PSD writer for the test ------------------------------------------------------------

class B {
    constructor() { this.a = []; }
    u8(v) { this.a.push(v & 255); return this; }
    u16(v) { this.a.push((v >> 8) & 255, v & 255); return this; }
    i16(v) { return this.u16(v & 0xffff); }
    u32(v) { this.a.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); return this; }
    i32(v) { return this.u32(v >>> 0); }
    ascii(s) { for (const c of s) this.a.push(c.charCodeAt(0)); return this; }
    bytes(b) { for (const x of b) this.a.push(x); return this; }
    get length() { return this.a.length; }
    out() { return Uint8Array.from(this.a); }
}

function packbitsRow(row) {
    const out = [];
    let i = 0;
    while (i < row.length) {
        let j = i;
        while (j + 1 < row.length && row[j + 1] === row[i] && j - i < 127) j++;
        if (j > i) { out.push(257 - (j - i + 1), row[i]); i = j + 1; continue; }
        let k = i;
        while (k < row.length && k - i < 128 && !(k + 1 < row.length && row[k + 1] === row[k])) k++;
        if (k === i) k = i + 1;
        out.push(k - i - 1, ...row.slice(i, k));
        i = k;
    }
    return out;
}

/** One channel's data block (compression + data) of `samples` (w * h, values 0..255 or 0..65535 for 16 bit). */
function channelData(samples, w, h, depth, comp) {
    if (!(w * h > 0)) return new B().u16(comp).out();   // an empty rectangle: the compression alone
    const bpc = depth / 8;
    const raw = new Uint8Array(w * h * bpc);
    for (let i = 0; i < w * h; i++) {
        if (bpc === 1) raw[i] = samples[i];
        else { raw[2 * i] = samples[i] >> 8; raw[2 * i + 1] = samples[i] & 255; }
    }
    const b = new B().u16(comp);
    if (comp === 0) b.bytes(raw);
    else if (comp === 1) {
        const rows = [];
        for (let y = 0; y < h; y++) rows.push(packbitsRow(Array.from(raw.subarray(y * w * bpc, (y + 1) * w * bpc))));
        for (const r of rows) b.u16(r.length);
        for (const r of rows) b.bytes(r);
    } else {
        const d = raw.slice();
        if (comp === 3) {
            if (bpc === 1) { for (let y = 0; y < h; y++) for (let x = w - 1; x >= 1; x--) { const i = y * w + x; d[i] = (d[i] - d[i - 1]) & 255; } }
            else {
                const v = new DataView(d.buffer);
                for (let y = 0; y < h; y++) for (let x = w - 1; x >= 1; x--) { const i = (y * w + x) * 2; v.setUint16(i, (v.getUint16(i) - v.getUint16(i - 2)) & 0xffff); }
            }
        }
        b.bytes(zlib.deflateSync(d));
    }
    return b.out();
}

/**
 * A PSD from `layers` (bottom first), each { name, luni, top, left, w, h, ch: { id: samples }, blend, opacity (0..255),
 * flags, clipping, mask: { top, left, w, h, def, flags, params, real }, info: { key: bytes }, section, comp, dims }.
 * `mask.params`: raw bytes after the flags (flag bit 4's parameters); `mask.real`: { flags, def, top, left, w, h }, the
 * second rectangle of a 36-byte record, which channel -3 is written at; `dims`: { id: [w, h] } for a channel written
 * at another size than the builder picks (a -2 without a mask record).
 */
function psd({ width, height, depth = 8, mode = 3, version = 1, layers = [], merged = null, mergedComp = 1, channels = null }) {
    const b = new B().ascii("8BPS").u16(version).bytes([0, 0, 0, 0, 0, 0]);
    const nch = channels || (mode === 1 ? 1 : 3);
    b.u16(nch).u32(height).u32(width).u16(depth).u16(mode);
    b.u32(0);   // colour mode data
    b.u32(0);   // image resources
    const rec = new B(), data = new B();
    for (const L of layers) {
        const ids = Object.keys(L.ch || {}).map(Number);
        const blocks = ids.map((id) => {
            const [w, h] = L.dims && L.dims[id] ? L.dims[id] : id === -3 && L.mask.real ? [L.mask.real.w, L.mask.real.h] : id === -2 || id === -3 ? [L.mask.w, L.mask.h] : [L.w, L.h];
            return [id, channelData(L.ch[id], w, h, depth, L.comp ?? 1)];
        });
        rec.i32(L.top).i32(L.left).i32(L.top + L.h).i32(L.left + L.w).u16(blocks.length);
        for (const [id, d] of blocks) rec.i16(id).u32(d.length);
        rec.ascii("8BIM").ascii(L.blend || "norm").u8(L.opacity ?? 255).u8(L.clipping || 0).u8(L.flags || 0).u8(0);
        const extra = new B();
        if (L.mask) {
            const m = L.mask, mr = new B().i32(m.top).i32(m.left).i32(m.top + m.h).i32(m.left + m.w).u8(m.def).u8(m.flags || 0);
            if (m.params) mr.bytes(m.params);
            if (m.real) mr.u8(m.real.flags || 0).u8(m.real.def).i32(m.real.top).i32(m.real.left).i32(m.real.top + m.real.h).i32(m.real.left + m.real.w);
            while (mr.length < 20) mr.u8(0);   // the padding of a 20-byte record
            extra.u32(mr.length).bytes(mr.a);
        } else extra.u32(0);
        extra.u32(0);   // blending ranges
        const name = L.name || "";
        const pn = [name.length, ...Buffer.from(name, "latin1")];
        while (pn.length % 4) pn.push(0);
        extra.bytes(pn);
        const info = { ...(L.info || {}) };
        if (L.luni) { const u = new B().u32(L.luni.length); for (const c of L.luni) u.u16(c.charCodeAt(0)); info.luni = u.out(); }
        if (L.section) info.lsct = new B().u32(L.section).out();
        for (const [k, v] of Object.entries(info)) extra.ascii("8BIM").ascii(k).u32(v.length).bytes(v);
        rec.u32(extra.length).bytes(extra.a);
        for (const [, d] of blocks) data.bytes(d);
    }
    const li = new B();
    if (layers.length) {
        li.i16(-layers.length).bytes(rec.a).bytes(data.a);
        if (li.length % 2) li.u8(0);
    }
    const lm = new B();
    if (layers.length) lm.u32(li.length).bytes(li.a).u32(0);
    b.u32(lm.length).bytes(lm.a);
    // merged
    const planes = merged || Array.from({ length: nch }, () => new Array(width * height).fill(0));
    if (mergedComp === 1) {
        const rows = [];
        for (const p of planes) for (let y = 0; y < height; y++) rows.push(packbitsRow(Array.from(p.slice(y * width, (y + 1) * width))));
        b.u16(1);
        for (const r of rows) b.u16(r.length);
        for (const r of rows) b.bytes(r);
    } else {
        b.u16(0);
        for (const p of planes) b.bytes(p);
    }
    return b.out();
}

const fill = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const px = (doc, li, x, y) => { const L = doc.layers[li]; if (!L) return []; const o = (y * L.w + x) * 4; return Array.from(L.rgba.slice(o, o + 4)); };
const inflate = async (b) => new Uint8Array(zlib.inflateSync(b));
const inflateRaw = async (b) => new Uint8Array(zlib.inflateRawSync(b));

// ---- a zip writer for ORA ------------------------------------------------------------------

function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {   // [{ name, data, deflate }]
    const parts = [], central = [];
    let off = 0;
    const le = (n, v) => { const b = Buffer.alloc(n); if (n === 2) b.writeUInt16LE(v); else b.writeUInt32LE(v >>> 0); return b; };
    for (const e of entries) {
        const data = Buffer.from(e.data), body = e.deflate ? zlib.deflateRawSync(data) : data, name = Buffer.from(e.name);
        const crc = crc32(data), method = e.deflate ? 8 : 0;
        const local = Buffer.concat([le(4, 0x04034b50), le(2, 20), le(2, 0), le(2, method), le(2, 0), le(2, 0), le(4, crc), le(4, body.length), le(4, data.length), le(2, name.length), le(2, 0), name]);
        central.push(Buffer.concat([le(4, 0x02014b50), le(2, 20), le(2, 20), le(2, 0), le(2, method), le(2, 0), le(2, 0), le(4, crc), le(4, body.length), le(4, data.length), le(2, name.length), le(2, 0), le(2, 0), le(2, 0), le(2, 0), le(4, 0), le(4, off), name]));
        parts.push(local, body);
        off += local.length + body.length;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.concat([le(4, 0x06054b50), le(2, 0), le(2, 0), le(2, entries.length), le(2, entries.length), le(4, cd.length), le(4, off), le(2, 0)]);
    return new Uint8Array(Buffer.concat([...parts, cd, end]));
}

/**
 * `--write-fixtures <dir>`: two files for the app gate (tools/layered_test.py): `loose.psd`, 40 x 30, whose bottom layer
 * does not cover the picture (so the base is transparent), a mask and a hidden group; `loose.ora`, the same shape.
 */
function writeFixtures(dir) {
    const solid = (w, h, r, g, b) => ({ 0: fill(w * h, () => r), 1: fill(w * h, () => g), 2: fill(w * h, () => b), "-1": fill(w * h, () => 255) });
    const file = psd({ width: 40, height: 30, layers: [
        { name: "Corner", top: 2, left: 3, w: 10, h: 8, ch: solid(10, 8, 255, 0, 0) },
        { name: "</Layer group>", top: 0, left: 0, w: 0, h: 0, ch: {}, section: 3 },
        { name: "Hidden inside", top: 10, left: 10, w: 5, h: 5, ch: solid(5, 5, 0, 255, 0) },
        { name: "Group", top: 0, left: 0, w: 0, h: 0, ch: {}, section: 1, flags: 2 },
        { name: "Masked", top: 0, left: 20, w: 20, h: 30, ch: { ...solid(20, 30, 0, 0, 255), "-2": fill(10 * 30, () => 255) }, mask: { top: 0, left: 20, w: 10, h: 30, def: 0 } },
    ] });
    fs.writeFileSync(path.join(dir, "loose.psd"), file);
    const png = (w, h, rgb) => {   // a tiny truecolour + alpha PNG
        const raw = Buffer.alloc((w * 4 + 1) * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2]; raw[o + 3] = 255; }
        const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
        const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
        return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
    };
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<image version="0.0.3" w="40" h="30">
 <stack>
  <layer name="Right" src="data/b.png" x="25" y="4" opacity="0.5" composite-op="svg:screen" />
  <layer name="Corner" src="data/a.png" x="3" y="2" />
 </stack>
</image>
`;
    fs.writeFileSync(path.join(dir, "loose.ora"), zip([
        { name: "mimetype", data: "image/openraster" },
        { name: "stack.xml", data: xml, deflate: true },
        { name: "data/a.png", data: png(10, 8, [255, 0, 0]) },
        { name: "data/b.png", data: png(6, 7, [0, 0, 255]), deflate: true },
    ]));
    console.log("fixtures written");
}

// ---- the editor's own PSD writers ------------------------------------------------------------

// The SHA-256 of the document below written without masks by the writers of before the masks (commit 6c4e4f9, both
// writers gave these bytes): a layer without a mask must still be written exactly so.
const NO_MASK_SHA256 = "5b2532a0ef7d8a1601aca23607256fd2da1af2a7958aacbc2c40b09d7ac020fe";

/** A repeatable byte stream (xorshift32). */
function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
}

/** RGBA of w x h with long runs (past PackBits' 128), noise and alternations; colour under alpha 0 included. */
function picture(w, h, seed, opaque = false) {
    const r = rng(seed), out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w;) {
            const kind = r() % 3, n = 1 + (r() % (kind === 0 ? 200 : 40));
            const v = [r() & 255, r() & 255, r() & 255, r() & 255];
            for (let k = 0; k < n && x < w; k++, x++) {
                const o = (y * w + x) * 4;
                for (let c = 0; c < 4; c++) out[o + c] = kind === 0 ? v[c] : kind === 1 ? r() & 255 : k & 1 ? v[c] : 255 - v[c];
                if (opaque) out[o + 3] = 255;
                else if (y === 1 && x >= 5 && x < 60) out[o + 3] = 0;   // a long run of alpha 0, colour under it
            }
        }
    }
    return out;
}

/** A stand-in for a canvas: what PsdWriter reads (`getImageData` of the whole of it) and OraWriter (`convertToBlob`). */
function standIn(w, h, rgba) {
    return {
        width: w, height: h,
        getContext(kind) {
            if (kind !== "2d") throw new Error("a " + kind + " context");
            return {
                getImageData(x, y, gw, gh) {
                    if (x || y || gw !== w || gh !== h) throw new Error(`getImageData(${x}, ${y}, ${gw}, ${gh}) of ${w} x ${h}`);
                    return { data: rgba };
                },
                drawImage() {},
            };
        },
        async convertToBlob() { return new Blob([`png ${w}x${h} `, rgba]); },
    };
}

const planeOf = (rgba, c) => Uint8Array.from({ length: rgba.length / 4 }, (_, i) => rgba[i * 4 + c]);
const alphaOf = (rgba) => planeOf(rgba, 3);
const equalBytes = (a, b) => !!a && !!b && a.length === b.length && Array.prototype.every.call(a, (v, i) => v === b[i]);
function firstDiff(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return `first difference at byte ${i}: ${a[i]} / ${b[i]} (${a.length} / ${b.length} bytes)`;
    return a.length === b.length ? "equal" : `lengths ${a.length} / ${b.length}`;
}

/**
 * A PSD the editor wrote, parsed strictly here (apart from readPsd): every section's length, every channel's PackBits
 * rows unpacked to exactly the layer's width and ending where the record says, the padding, nothing left over.
 */
function parseWritten(b) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let p = 0;
    const u8 = () => b[p++];
    const u16 = () => { const x = v.getUint16(p); p += 2; return x; };
    const i16 = () => { const x = v.getInt16(p); p += 2; return x; };
    const u32 = () => { const x = v.getUint32(p); p += 4; return x; };
    const i32 = () => { const x = v.getInt32(p); p += 4; return x; };
    const ascii = (n) => { const s = String.fromCharCode(...b.subarray(p, p + n)); p += n; return s; };
    const fail = (what) => { throw new Error(`${what} (at byte ${p})`); };
    // PackBits rows (`lens` bytes each) into `plane`, w pixels a row
    const unpack = (lens, plane, w, what) => {
        lens.forEach((len, y) => {
            const end = p + len;
            let q = y * w;
            while (p < end) {
                const k = b[p++];
                if (k < 128) { for (let j = 0; j <= k; j++) plane[q++] = b[p++]; } else if (k > 128) { const x = b[p++]; for (let j = 0; j < 257 - k; j++) plane[q++] = x; }
            }
            if (p !== end || q !== (y + 1) * w) fail(`${what} row ${y}: ${q - y * w} pixels for ${w}`);
        });
    };
    if (ascii(4) !== "8BPS" || u16() !== 1) fail("not a PSD of version 1");
    p += 6;
    const nch = u16(), H = u32(), W = u32(), depth = u16(), mode = u16();
    if (nch !== 3 || depth !== 8 || mode !== 3) fail(`the header says ${nch} channels, ${depth} bit, mode ${mode}`);
    if (u32() !== 0 || u32() !== 0) fail("colour mode data or image resources");
    const lmLen = u32(), lmEnd = p + lmLen;
    const liLen = u32(), liEnd = p + liLen;
    const count = i16();
    const records = [];
    for (let i = 0; i < count; i++) {
        const R = { top: i32(), left: i32(), bottom: i32(), right: i32(), channels: [] };
        const n = u16();
        for (let c = 0; c < n; c++) R.channels.push({ id: i16(), len: u32() });
        if (ascii(4) !== "8BIM") fail("a record's signature");
        R.blend = ascii(4); R.opacity = u8(); R.clipping = u8(); R.flags = u8(); R.filler = u8();
        R.extraLen = u32();
        const extraEnd = p + R.extraLen;
        R.maskLen = u32();
        R.maskBytes = Array.from(b.subarray(p, p + R.maskLen));
        p += R.maskLen;
        R.rangesLen = u32();
        p += R.rangesLen;
        const nameLen = u8();
        R.name = ascii(nameLen);
        p += (4 - ((1 + nameLen) % 4)) % 4;
        R.infoKeys = [];
        while (p < extraEnd) { if (ascii(4) !== "8BIM") fail("an additional info signature"); R.infoKeys.push(ascii(4)); const len = u32(); p += len; }
        if (p !== extraEnd) fail(`record "${R.name}": its extra data ends at ${p}, its length says ${extraEnd}`);
        records.push(R);
    }
    for (const R of records) {
        const w = R.right - R.left, h = R.bottom - R.top;
        R.planes = {};
        for (const c of R.channels) {
            const start = p;
            if (u16() !== 1) fail(`"${R.name}" channel ${c.id} is not PackBits`);
            const lens = [];
            for (let y = 0; y < h; y++) lens.push(u16());
            const plane = new Uint8Array(w * h);
            unpack(lens, plane, w, `"${R.name}" channel ${c.id}`);
            if (p - start !== c.len) fail(`"${R.name}" channel ${c.id}: ${p - start} bytes, the record says ${c.len}`);
            R.planes[c.id] = plane;
        }
    }
    if (liEnd - p > 1 || (liEnd - p === 1 && b[p] !== 0)) fail(`the layer info ends at ${liEnd}, its data at ${p}`);
    if ((p - (liEnd - liLen)) % 2 !== (liEnd - p)) fail("the layer info's padding does not make it even");
    const infoUsed = p - (liEnd - liLen);
    p = liEnd;
    if (u32() !== 0) fail("global layer mask info");
    if (p !== lmEnd) fail("the layer and mask section's length");
    if (u16() !== 1) fail("the merged picture is not PackBits");
    const lens = [];
    for (let i = 0; i < 3 * H; i++) lens.push(u16());
    const merged = [0, 1, 2].map((c) => { const plane = new Uint8Array(W * H); unpack(lens.slice(c * H, (c + 1) * H), plane, W, `merged channel ${c}`); return plane; });
    if (p !== b.length) fail(`${b.length - p} bytes after the merged picture`);
    return { W, H, records, merged, infoUsed };
}

async function writerChecks(readPsd) {
    const X = await editorModule("inpaint_export.js");
    const BW = await editorModule("inpaint_bands.js");
    const KJ = await editorModule("px/kernels_js.js");
    const packs = [["JS twin", (rgba, w, rows) => KJ.psdPackRows(rgba, w, rows)]];
    try {
        const { loadPx } = await editorModule("px/px.js");
        const px = await loadPx(fs.readFileSync(path.join(EDITOR, "px", "px.wasm")));
        packs.push(["px.wasm", (rgba, w, rows) => px.psdPackRows(rgba, w, rows)]);
    } catch (err) { check("px.wasm loads in Node", false, err.message); }

    // a background, a masked layer 150 px wide (runs and literals past 128), a switched-off mask on a hidden layer at
    // negative coordinates, a plain layer; the masks' colour is noise, so a writer that took it for the mask shows
    const DW = 160, DH = 12;
    const doc = [
        { name: "Background", x: 0, y: 0, w: DW, h: DH, rgba: picture(DW, DH, 1, true) },
        { name: "Masked äö", x: 3, y: 2, w: 150, h: 7, rgba: picture(150, 7, 2), blend: "multiply", opacity: 128 / 255, mask: { rgba: picture(150, 7, 3), disabled: false } },
        { name: "Mask off", x: -2, y: 5, w: 6, h: 4, rgba: picture(6, 4, 4), visible: false, mask: { rgba: picture(6, 4, 5), disabled: true } },
        { name: "Plain", x: 10, y: 9, w: 5, h: 5, rgba: picture(5, 5, 6) },
    ];
    const bare = doc.map((L) => { const c = { ...L }; delete c.mask; return c; });
    const composite = picture(DW, DH, 7, true);
    const meta = (L) => ({ name: L.name, x: L.x, y: L.y, opacity: L.opacity ?? 1, visible: L.visible !== false, blend: L.blend || "normal" });
    const viaCanvas = async (layers) => {
        const w = new X.PsdWriter({ width: DW, height: DH });
        for (const L of layers) w.layer({ ...meta(L), ...(L.mask ? { mask: { canvas: standIn(L.w, L.h, L.mask.rgba), disabled: L.mask.disabled } } : {}) }, standIn(L.w, L.h, L.rgba));
        return new Uint8Array(await w.finish(standIn(DW, DH, composite)).arrayBuffer());
    };
    const jobs = [];
    // the pool's psd_part, as inpaint_worker.js psdPart answers it
    const runWith = (pack) => async (op, args, transfer) => {
        if (op !== "psd_part") throw new Error("a job the PSD writer should not ask for: " + op);
        jobs.push({ rows: args.rows, prev: "prev" in args || "prevTiles" in args, transfer: transfer.length });
        const packed = pack(new Uint8Array(args.rgba, 0, args.w * args.rows * 4), args.w, args.rows);
        return { channels: packed.map((c) => ({ lens: c.lens.buffer, data: c.data.buffer })) };
    };
    const rowsOf = (w, h, rgba, band) => BW.bandRows(w, h, (y0, y1) => rgba.slice(y0 * w * 4, y1 * w * 4), band);
    const viaBands = async (layers, pack, band, progress = null) => {
        const w = new BW.PsdBandWriter({ width: DW, height: DH, run: runWith(pack), flights: 2 });
        for (const L of layers) {
            const m = L.mask ? { ...meta(L), mask: { disabled: L.mask.disabled } } : meta(L);
            await w.layer(m, rowsOf(L.w, L.h, L.rgba, band), progress ? progress(L) : null, L.mask ? rowsOf(L.w, L.h, L.mask.rgba, band) : null);
        }
        return new Uint8Array(await (await w.finish(rowsOf(DW, DH, composite, 5))).arrayBuffer());
    };

    const a = await viaCanvas(doc);
    const seen = {};
    for (const [label, pack] of packs) {
        for (const band of [3, 256]) {
            const b = await viaBands(doc, pack, band, label === "JS twin" && band === 3 ? (L) => (f) => (seen[L.name] = seen[L.name] || []).push(f) : null);
            check(`PsdBandWriter (${label}, parts of ${band === 3 ? "3 rows" : "a whole layer"}) writes PsdWriter's bytes, masks and all`, equalBytes(a, b), firstDiff(a, b));
        }
    }
    check("the band writer sent parts of 3 rows without their previous rows", jobs.some((j) => j.rows === 3) && jobs.every((j) => !j.prev && j.transfer === 1), short(jobs.slice(0, 4)));
    const pm = seen["Masked äö"] || [], pp = seen.Plain || [];
    const rising = (s) => s.every((f, i) => i === 0 || f >= s[i - 1]);
    check("progress of a masked layer: the pixels to one half, the mask to the whole, rising", pm.includes(0.5) && pm[pm.length - 1] === 1 && rising(pm) && pm.filter((f) => f <= 0.5).length === 3 && pm.length === 6, short(pm));
    check("progress of a plain layer: to the whole", pp[pp.length - 1] === 1 && rising(pp) && pp.length === 2, short(pp));

    let P = null;
    try { P = parseWritten(a); check("the written PSD parses strictly: every length, every row, nothing left over", true); } catch (err) { check("the written PSD parses strictly", false, err.message); }
    if (P) {
        const [bg, mk, off, plain] = P.records;
        const ids = (R) => R.channels.map((c) => c.id).join(",");
        const rect = (L) => new B().i32(L.y).i32(L.x).i32(L.y + L.h).i32(L.x + L.w).a;
        check("four records, each at its layer's rectangle", P.records.length === 4 && P.records.every((R, i) => R.top === doc[i].y && R.left === doc[i].x && R.bottom === doc[i].y + doc[i].h && R.right === doc[i].x + doc[i].w), short(P.records.map((R) => [R.left, R.top, R.right, R.bottom])));
        check("a layer without a mask: four channels (-1, 0, 1, 2) and a mask record of 0 bytes", ids(bg) === "-1,0,1,2" && ids(plain) === "-1,0,1,2" && bg.maskLen === 0 && plain.maskLen === 0, `${ids(bg)} / ${ids(plain)}; ${bg.maskLen} / ${plain.maskLen}`);
        check("a masked layer: five channels, the user mask (-2) last", ids(mk) === "-1,0,1,2,-2" && ids(off) === "-1,0,1,2,-2", `${ids(mk)} / ${ids(off)}`);
        check("the mask record: 20 bytes, the layer's rectangle, default colour 255, flags 0, two bytes of padding", mk.maskLen === 20 && equalBytes(mk.maskBytes, [...rect(doc[1]), 255, 0, 0, 0]), short(mk.maskBytes));
        check("a switched-off mask: flags 2, its rectangle at negative coordinates", off.maskLen === 20 && equalBytes(off.maskBytes, [...rect(doc[2]), 255, 2, 0, 0]), short(off.maskBytes));
        check("no blending ranges, the Unicode name, nothing else in the extra data", P.records.every((R) => R.rangesLen === 0 && R.infoKeys.join() === "luni"), short(P.records.map((R) => [R.rangesLen, R.infoKeys])));
        check("the layer flags, blend and opacity", mk.flags === 0 && off.flags === 2 && mk.blend === "mul " && mk.opacity === 128 && bg.blend === "norm" && bg.opacity === 255, short([mk.flags, off.flags, mk.blend, mk.opacity]));
        check("the pixels are written raw, colour under alpha 0 included", P.records.every((R, i) => [0, 1, 2].every((c) => equalBytes(R.planes[c], planeOf(doc[i].rgba, c))) && equalBytes(R.planes[-1], alphaOf(doc[i].rgba))) && doc[1].rgba.some((v, i) => i % 4 === 3 && v === 0));
        check("the mask channel is the mask's alpha, not its colour", equalBytes(mk.planes[-2], alphaOf(doc[1].mask.rgba)) && equalBytes(off.planes[-2], alphaOf(doc[2].mask.rgba)) && !equalBytes(mk.planes[-2], planeOf(doc[1].mask.rgba, 0)));
        check("the merged picture", [0, 1, 2].every((c) => equalBytes(P.merged[c], planeOf(composite, c))));
    }

    // readPsd takes back what the writers put in
    const back = await readPsd(a);
    const [rb, rm, ro, rp] = back.layers;
    check("read back: four layers at their boxes", back.layers.length === 4 && back.layers.every((l, i) => l.x === doc[i].x && l.y === doc[i].y && l.w === doc[i].w && l.h === doc[i].h && l.name === doc[i].name), short(back.layers.map((l) => [l.name, l.x, l.y, l.w, l.h])));
    check("read back: the pixels raw, byte for byte (the masks not multiplied in)", back.layers.every((l, i) => equalBytes(l.rgba, doc[i].rgba)));
    check("read back: each mask byte for byte at its layer's size", rm && rm.mask && ro && ro.mask && equalBytes(rm.mask.data, alphaOf(doc[1].mask.rgba)) && equalBytes(ro.mask.data, alphaOf(doc[2].mask.rgba)));
    check("read back: the switch and the default colour", rm && rm.mask && ro.mask && rm.mask.disabled === false && ro.mask.disabled === true && rm.mask.defaultColor === 255 && ro.mask.defaultColor === 255);
    check("read back: no mask on the plain layers", rb && rp && !("mask" in rb) && !("mask" in rp));
    check("read back: hidden, blend and opacity", ro.visible === false && rm.visible === true && rm.blend === "multiply" && Math.abs(rm.opacity - 128 / 255) < 1e-9);
    check("read back: the note", back.notes.includes("2 layer masks kept as masks (1 switched off)"), short(back.notes));
    check("read back: the merged picture", equalBytes(back.composite, composite));

    // without masks: the bytes of before, from both writers
    const na = await viaCanvas(bare), nb = await viaBands(bare, packs[packs.length - 1][1], 4);
    const sha = crypto.createHash("sha256").update(na).digest("hex");
    check("without masks both writers give the same bytes", equalBytes(na, nb), firstDiff(na, nb));
    check("without masks the bytes are the ones of before (SHA-256)", sha === NO_MASK_SHA256, sha);
    // per mask: its channel's 6 bytes in the record, the 20-byte mask record and the channel's data
    const extra = P ? P.records.reduce((s, R) => s + R.channels.filter((c) => c.id === -2).reduce((t, c) => t + 6 + 20 + c.len, 0), 0) : -1;
    const pad = (n) => n + (n % 2);   // the layer info is padded to an even length
    let Pn = null;
    try { Pn = parseWritten(na); } catch (err) { check("the PSD without masks parses strictly", false, err.message); }
    check("a mask adds its channel and its record, nothing else", P && Pn && extra > 0 && P.infoUsed === Pn.infoUsed + extra && a.length - na.length === pad(P.infoUsed) - pad(Pn.infoUsed) && Pn.records.every((R) => R.maskLen === 0 && R.channels.length === 4), `${a.length - na.length} bytes more, ${extra} expected`);

    // refusals: a mask of another size, a mask without pixels, a flag without its source and a source without its flag
    const L1 = doc[1];
    const tiny = standIn(5, 5, new Uint8ClampedArray(100));
    const e1 = await throwsWith(async () => new X.PsdWriter({ width: DW, height: DH }).layer({ ...meta(L1), mask: { canvas: tiny, disabled: false } }, standIn(L1.w, L1.h, L1.rgba)), /is 5 x 5, its pixels 150 x 7/);
    check("PsdWriter refuses a mask of another size", e1.ok, e1.msg);
    const e2 = await throwsWith(async () => new X.PsdWriter({ width: DW, height: DH }).layer({ ...meta(L1), mask: { disabled: false } }, standIn(L1.w, L1.h, L1.rgba)), /has no pixels/);
    check("PsdWriter refuses a mask without pixels", e2.ok, e2.msg);
    const band = () => new BW.PsdBandWriter({ width: DW, height: DH, run: runWith(packs[0][1]) });
    const e3 = await throwsWith(() => band().layer({ ...meta(L1), mask: { disabled: false } }, rowsOf(L1.w, L1.h, L1.rgba, 3), null, rowsOf(5, 5, new Uint8ClampedArray(100), 3)), /is 5 x 5, its pixels 150 x 7/);
    check("PsdBandWriter refuses a mask of another size", e3.ok, e3.msg);
    const e4 = await throwsWith(() => band().layer({ ...meta(L1), mask: { disabled: false } }, rowsOf(L1.w, L1.h, L1.rgba, 3)), /flag without its pixels/);
    check("PsdBandWriter refuses a mask flag without its rows", e4.ok, e4.msg);
    const e5 = await throwsWith(() => band().layer(meta(L1), rowsOf(L1.w, L1.h, L1.rgba, 3), null, rowsOf(L1.w, L1.h, L1.mask.rgba, 3)), /source without L.mask/);
    check("PsdBandWriter refuses mask rows without the flag", e5.ok, e5.msg);

    // ORA has no layer masks: a stray `mask` changes nothing (the editor bakes them for ORA itself)
    const hadOffscreen = "OffscreenCanvas" in globalThis, was = globalThis.OffscreenCanvas;
    globalThis.OffscreenCanvas = class {
        constructor(w, h) { this.width = w; this.height = h; }
        getContext() { return { drawImage() {} }; }
        async convertToBlob() { return new Blob([`thumbnail ${this.width}x${this.height}`]); }
    };
    try {
        const ora = async (layers) => {
            const described = layers.map((L) => ({ ...meta(L), canvas: standIn(L.w, L.h, L.rgba), ...(L.mask ? { mask: { canvas: standIn(L.w, L.h, L.mask.rgba), disabled: L.mask.disabled } } : {}) }));
            return new Uint8Array(await (await X.buildOra({ width: DW, height: DH, layers: described, composite: standIn(DW, DH, composite) })).arrayBuffer());
        };
        const withMask = await ora(doc), without = await ora(bare);
        check("ORA ignores a stray mask: the same file with and without", equalBytes(withMask, without) && withMask.length > 4 * DW * DH, firstDiff(withMask, without));
    } finally {
        if (hadOffscreen) globalThis.OffscreenCanvas = was; else delete globalThis.OffscreenCanvas;
    }
}

(async () => {
    const at = process.argv.indexOf("--write-fixtures");
    if (at > 0) { writeFixtures(process.argv[at + 1]); return; }
    const mod = await editorModule("inpaint_layered.js");
    const { readPsd, readOra, isPsd, isOra, LAYERED_EXT } = mod;

    console.log("\n--- PSD: channels, compression, depth ---");
    {
        const W = 6, H = 4;
        const ramp = fill(W * H, (i) => (i * 11) % 256);
        const mk = (comp, name) => ({ name, top: 0, left: 0, w: W, h: H, comp, ch: { "-1": fill(W * H, () => 255), 0: ramp, 1: fill(W * H, (i) => 255 - ramp[i]), 2: fill(W * H, () => 7) } });
        for (const [comp, what] of [[0, "raw"], [1, "RLE"], [2, "ZIP"], [3, "ZIP with prediction"]]) {
            const doc = await readPsd(psd({ width: W, height: H, layers: [mk(comp, what)] }), { inflate });
            const ok = doc.layers.length === 1 && doc.layers[0].rgba.length === W * H * 4 && ramp.every((v, i) => doc.layers[0].rgba[i * 4] === v && doc.layers[0].rgba[i * 4 + 1] === 255 - v && doc.layers[0].rgba[i * 4 + 2] === 7 && doc.layers[0].rgba[i * 4 + 3] === 255);
            check(`${what} channels read exactly`, ok, short(px(doc, 0, 3, 2)));
        }
        const zipNoInflater = await throwsWith(() => readPsd(psd({ width: W, height: H, layers: [mk(2, "z")] })), /needs an inflater/);
        check("a ZIP channel without an inflater is an error, not garbage", zipNoInflater.ok, zipNoInflater.msg);
        // 16 bit, with prediction: 16-bit words are rounded to 8 bits
        const s16 = fill(W * H, (i) => i * 2700 % 65536);
        const d16 = await readPsd(psd({ width: W, height: H, depth: 16, layers: [{ name: "deep", top: 0, left: 0, w: W, h: H, comp: 3, ch: { 0: s16, 1: s16, 2: s16, "-1": fill(W * H, () => 65535) } }] }), { inflate });
        check("16 bit (ZIP with prediction on words) rounds to 8", s16.every((v, i) => d16.layers[0].rgba[i * 4] === Math.round(v / 257)) && d16.layers[0].rgba[3] === 255, short(px(d16, 0, 5, 3)));
        check("16 bit is named in the notes", d16.notes.some((n) => /16 bits/.test(n)), short(d16.notes));
        const d16r = await readPsd(psd({ width: W, height: H, depth: 16, layers: [{ name: "deep", top: 0, left: 0, w: W, h: H, comp: 1, ch: { 0: s16, 1: s16, 2: s16 } }] }), { inflate });
        check("16 bit RLE, and no alpha channel is opaque", s16.every((v, i) => d16r.layers[0].rgba[i * 4 + 2] === Math.round(v / 257)) && d16r.layers[0].rgba[7] === 255);
        // grayscale
        const g = await readPsd(psd({ width: W, height: H, mode: 1, layers: [{ name: "gray", top: 0, left: 0, w: W, h: H, ch: { 0: ramp, "-1": fill(W * H, (i) => i % 2 ? 128 : 255) } }] }));
        check("grayscale replicates its channel, alpha kept", ramp.every((v, i) => { const o = i * 4; return g.layers[0].rgba[o] === v && g.layers[0].rgba[o + 1] === v && g.layers[0].rgba[o + 2] === v; }) && g.layers[0].rgba[7] === 128);
    }

    console.log("\n--- PSD: layer records ---");
    {
        const W = 8, H = 8;
        const solid = (w, h, r, g, b, a = 255) => ({ 0: fill(w * h, () => r), 1: fill(w * h, () => g), 2: fill(w * h, () => b), "-1": fill(w * h, () => a) });
        const layers = [
            { name: "Background", top: 0, left: 0, w: W, h: H, ch: solid(W, H, 200, 200, 200) },
            { name: "latin", luni: "Ebene äöü ✓", top: 2, left: 3, w: 4, h: 3, ch: solid(4, 3, 255, 0, 0), blend: "mul ", opacity: 128 },
            { name: "hidden", top: -2, left: -1, w: 3, h: 3, ch: solid(3, 3, 0, 0, 255), flags: 2 },
            { name: "odd blend", top: 0, left: 0, w: 2, h: 2, ch: solid(2, 2, 1, 2, 3), blend: "vLit" },
            { name: "clipped", top: 0, left: 0, w: 2, h: 2, ch: solid(2, 2, 1, 2, 3), clipping: 1 },
            { name: "empty", top: 0, left: 0, w: 0, h: 0, ch: {} },
            { name: "Levels 1", top: 0, left: 0, w: 0, h: 0, ch: {}, info: { levl: new Uint8Array(4) } },
            { name: "Curves over pixels", top: 0, left: 0, w: 2, h: 2, ch: solid(2, 2, 9, 9, 9), info: { curv: new Uint8Array(4) } },
        ];
        const doc = await readPsd(psd({ width: W, height: H, layers }));
        const names = doc.layers.map((l) => l.name);
        check("layers bottom first, adjustments and empty layers left out", JSON.stringify(names) === JSON.stringify(["Background", "Ebene äöü ✓", "hidden", "odd blend", "clipped"]), short(names));
        check("layers without a mask have no mask field, and no note speaks of layer masks", doc.layers.every((l) => !("mask" in l)) && !doc.notes.some((n) => /layer mask/.test(n)), short(doc.notes));
        const L = doc.layers[1];
        check("the Unicode name wins over the Pascal one", L.name === "Ebene äöü ✓");
        check("position, size, blend and opacity", L.x === 3 && L.y === 2 && L.w === 4 && L.h === 3 && L.blend === "multiply" && Math.abs(L.opacity - 128 / 255) < 1e-9, short({ x: L.x, y: L.y, w: L.w, h: L.h, blend: L.blend, opacity: L.opacity }));
        check("a hidden layer (flag 2) is hidden, a negative offset kept", doc.layers[2].visible === false && doc.layers[2].x === -1 && doc.layers[2].y === -2 && doc.layers[1].visible === true);
        check("an unknown blend mode becomes normal and is named", doc.layers[3].blend === "normal" && doc.notes.some((n) => /blend modes.*odd blend \(vLit\)/.test(n)), short(doc.notes));
        check("a clipping mask is named", doc.notes.some((n) => /clipping masks.*"clipped"/.test(n)), short(doc.notes));
        check("adjustment layers are named, with and without pixels", doc.notes.some((n) => /2 adjustment or fill layers left out \("Levels 1", "Curves over pixels"\)/.test(n)), short(doc.notes));
        check("the merged picture is read", doc.composite && doc.composite.length === W * H * 4 && doc.composite[3] === 255);
        const every = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "soft-light", "hard-light", "linear-light", "difference"];
        const keys = ["norm", "mul ", "scrn", "over", "dark", "lite", "sLit", "hLit", "lLit", "diff"];
        const bd = await readPsd(psd({ width: 2, height: 2, layers: keys.map((k) => ({ name: k, top: 0, left: 0, w: 1, h: 1, ch: solid(1, 1, 1, 1, 1), blend: k })) }));
        check("every blend mode the editor writes comes back", JSON.stringify(bd.layers.map((l) => l.blend)) === JSON.stringify(every), short(bd.layers.map((l) => l.blend)));
    }

    console.log("\n--- PSD: masks and groups ---");
    {
        const W = 6, H = 6;
        const solid = (w, h) => ({ 0: fill(w * h, () => 100), 1: fill(w * h, () => 100), 2: fill(w * h, () => 100), "-1": fill(w * h, () => 200) });
        const raw = (doc, i) => { const L = doc.layers[i]; return L.rgba.length === L.w * L.h * 4 && L.rgba.every((v, k) => v === (k % 4 === 3 ? 200 : 100)); };
        // what the mask of a layer should read as, pixel by pixel: the mask's own rectangle where it covers the layer's
        // pixel, its default colour elsewhere (a reference written apart from the reader's row copies)
        const placed = (L, m, data = m.data, d8 = (v) => v) => {
            const out = [];
            for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
                const mx = L.left + x - m.left, my = L.top + y - m.top;
                out.push(mx >= 0 && my >= 0 && mx < m.w && my < m.h ? d8(data[my * m.w + mx]) : m.def);
            }
            return out;
        };
        const same = (got, want) => got instanceof Uint8Array && got.length === want.length && want.every((v, i) => got[i] === v);
        // a file the reader throws on is a failed check, not the end of the run
        const readOrNote = async (file) => { try { return await readPsd(file); } catch (err) { return { layers: [], notes: [], error: String(err.message || err) }; } };
        const at = (m, n = 12) => (m && m.data ? Array.from(m.data.slice(0, n)).join(",") : String(m));
        // a mask over columns 1..2 of the layer, every sample different, default 0 outside
        const mask = { top: 0, left: 1, w: 2, h: H, def: 0, data: fill(2 * H, (i) => (i * 37 + 11) % 256) };
        const masked = { name: "masked", top: 0, left: 0, w: W, h: H, ch: { ...solid(W, H), "-2": mask.data }, mask };
        const d = await readPsd(psd({ width: W, height: H, layers: [masked] }));
        const M = d.layers[0].mask;
        check("a masked layer's pixels come back as they are (the mask is not multiplied in)", raw(d, 0));
        check("the mask comes back at the layer's size: its rectangle placed, its default (0) outside", M && same(M.data, placed(masked, mask)), at(M));
        check("the mask's default colour and switch", M && M.defaultColor === 0 && M.disabled === false, short(M && { def: M.defaultColor, off: M.disabled }));
        check("a kept mask is named, nothing says applied", d.notes.includes("1 layer mask kept as a mask") && !d.notes.some((n) => /applied/.test(n)), short(d.notes));
        const white = { ...masked, mask: { ...mask, def: 255 } };
        const dw = await readPsd(psd({ width: W, height: H, layers: [white] }));
        check("a mask with default white is white outside its rectangle", same(dw.layers[0].mask?.data, placed(white, white.mask)) && dw.layers[0].mask?.defaultColor === 255 && dw.layers[0].mask?.data[4] === 255, at(dw.layers[0].mask));
        const off = { ...masked, mask: { ...mask, flags: 2 } };
        const doff = await readPsd(psd({ width: W, height: H, layers: [off] }));
        check("a switched-off mask comes back switched off, placed the same, the pixels untouched", doff.layers[0].mask?.disabled === true && same(doff.layers[0].mask?.data, placed(off, mask)) && raw(doff, 0), short(doff.layers[0].mask?.disabled));
        check("the note says it is switched off", doff.notes.includes("1 layer mask kept as a mask (switched off)"), short(doff.notes));
        const other = { ...masked, mask: { ...mask, flags: 1 | 4 } };   // position relative (ignored), invert (obsolete): not "off"
        check("only flag bit 1 switches a mask off", (await readPsd(psd({ width: W, height: H, layers: [other] }))).layers[0].mask?.disabled === false);
        // -3 alone, with a 20-byte record: read at that record's rectangle
        const m3 = { name: "m3", top: 0, left: 0, w: W, h: H, ch: { ...solid(W, H), "-3": mask.data }, mask };
        const d3 = await readPsd(psd({ width: W, height: H, layers: [m3] }));
        check("a -3 alone is the mask", d3.layers[0].mask && same(d3.layers[0].mask?.data, placed(m3, mask)) && raw(d3, 0), at(d3.layers[0].mask));
        // a 36-byte record (Photoshop's with a vector mask): -2 at the first rectangle wins, -3 is read at the second
        // (the layer after it reads right only if -3 was read at its own size)
        const real = { flags: 2, def: 255, top: 1, left: 0, w: 3, h: 2 };
        const realData = fill(6, (i) => 250 - i * 9);
        const both = { name: "both", top: 0, left: 0, w: W, h: H, ch: { ...solid(W, H), "-2": mask.data, "-3": realData }, mask: { ...mask, real } };
        const next = { name: "next", top: 0, left: 0, w: 2, h: 2, ch: { 0: fill(4, () => 1), 1: fill(4, () => 2), 2: fill(4, () => 3), "-1": fill(4, () => 4) } };
        const db = await readOrNote(psd({ width: W, height: H, layers: [both, next] }));
        check("with -2 and -3, -2 at the first rectangle is the mask, with its own flags", same(db.layers[0]?.mask?.data, placed(both, mask)) && db.layers[0]?.mask?.disabled === false && db.layers[0]?.mask?.defaultColor === 0, at(db.layers[0]?.mask));
        check("the layer after a -3 at the second rectangle reads right", db.layers[1] && px(db, 1, 1, 1).join() === "1,2,3,4", short(db.layers[1] && px(db, 1, 1, 1)));
        const only3 = { name: "only3", top: 0, left: 0, w: W, h: H, ch: { ...solid(W, H), "-3": realData }, mask: { ...mask, real } };
        const do3 = await readOrNote(psd({ width: W, height: H, layers: [only3, next] }));
        check("a -3 alone with a 36-byte record: at the second rectangle, its default and its switch", same(do3.layers[0]?.mask?.data, placed(only3, real, realData)) && do3.layers[0]?.mask?.defaultColor === 255 && do3.layers[0]?.mask?.disabled === true && px(do3, 1, 1, 1).join() === "1,2,3,4", at(do3.layers[0]?.mask));
        // flag bit 4: the parameters (a density byte for the user and for the vector mask) come before the second rectangle
        const withParams = { ...only3, mask: { ...mask, flags: 16, params: [1 | 4, 200, 100], real } };
        const dp = await readOrNote(psd({ width: W, height: H, layers: [withParams, next] }));
        check("mask parameters (flag bit 4) are skipped before the second rectangle", same(dp.layers[0]?.mask?.data, placed(withParams, real, realData)) && px(dp, 1, 1, 1).join() === "1,2,3,4", at(dp.layers[0]?.mask));
        // a rectangle larger than the layer and offset from it, the layer at negative coordinates
        const big = { top: -3, left: -4, w: 9, h: 7, def: 0, data: fill(63, (i) => (i * 13 + 7) % 256) };
        const lb = { name: "big", top: -1, left: -2, w: 4, h: 3, ch: { ...solid(4, 3), "-2": big.data }, mask: big };
        const dbig = await readPsd(psd({ width: W, height: H, layers: [lb] }));
        check("a mask larger than the layer, offset, at negative coordinates: the part over the layer", same(dbig.layers[0].mask?.data, placed(lb, big)) && dbig.layers[0].mask?.data.length === 12, at(dbig.layers[0].mask));
        // a rectangle partly over the layer (its left columns and lower rows), default white elsewhere
        const part = { top: 3, left: -1, w: 4, h: 5, def: 255, data: fill(20, (i) => i * 11) };
        const lp = { name: "part", top: 1, left: 1, w: 5, h: 4, ch: { ...solid(5, 4), "-2": part.data }, mask: part };
        const dpart = await readPsd(psd({ width: W, height: H, layers: [lp] }));
        const wantPart = placed(lp, part);
        check("a mask partly over the layer: placed where it covers it, the default elsewhere", same(dpart.layers[0].mask?.data, wantPart) && wantPart.filter((v) => v !== 255).length > 0 && wantPart.filter((v) => v === 255).length > 10, at(dpart.layers[0].mask, 20));
        // a rectangle away from the layer, and an empty one (Photoshop's "hide all" / "reveal all"): the default everywhere
        const away = { top: 0, left: 5, w: 1, h: 2, def: 0, data: [255, 255] };
        const la = { name: "away", top: 0, left: 0, w: 3, h: 3, ch: { ...solid(3, 3), "-2": away.data }, mask: away };
        const daway = await readPsd(psd({ width: W, height: H, layers: [la] }));
        check("a mask rectangle away from the layer is its default everywhere", same(daway.layers[0].mask?.data, fill(9, () => 0)));
        for (const def of [0, 255]) {
            const empty = { top: 0, left: 0, w: 0, h: 0, def, data: [] };
            const le = { name: "empty", top: 0, left: 0, w: 3, h: 2, ch: { ...solid(3, 2), "-2": [] }, mask: empty };
            const de = await readPsd(psd({ width: W, height: H, layers: [le, next] }));
            check(`an empty mask rectangle with default ${def} is ${def} everywhere, the next layer reads right`, de.layers[0].mask && same(de.layers[0].mask?.data, fill(6, () => def)) && de.layers[0].mask?.defaultColor === def && px(de, 1, 1, 1).join() === "1,2,3,4", at(de.layers[0].mask));
        }
        // 16 bit, ZIP with prediction: the mask at its own width (not the layer's), rounded to 8 like the channels
        const deepMask = { top: 1, left: 2, w: 3, h: 4, def: 0, data: fill(12, (i) => (i * 5431 + 99) % 65536) };
        const s16 = (n, v) => fill(n, () => v);
        const deep = { name: "deep", top: 0, left: 0, w: 5, h: 5, comp: 3, ch: { 0: s16(25, 25700), 1: s16(25, 25700), 2: s16(25, 25700), "-1": s16(25, 51400), "-2": deepMask.data }, mask: deepMask };
        const d16 = await readPsd(psd({ width: W, height: H, depth: 16, layers: [deep] }), { inflate });
        check("a 16-bit mask with prediction is read at its own width and rounded to 8", same(d16.layers[0].mask?.data, placed(deep, deepMask, deepMask.data, (v) => Math.round(v / 257))), at(d16.layers[0].mask, 25));
        const zipMask = { top: 0, left: 1, w: 4, h: 3, def: 255, data: fill(12, (i) => (i * 29) % 256) };
        const lz = { name: "zip", top: 0, left: 0, w: 6, h: 4, comp: 3, ch: { ...solid(6, 4), "-2": zipMask.data }, mask: zipMask };
        const dz = await readPsd(psd({ width: W, height: H, layers: [lz] }), { inflate });
        check("an 8-bit mask with prediction at its own width", same(dz.layers[0].mask?.data, placed(lz, zipMask)) && raw(dz, 0), at(dz.layers[0].mask, 24));
        // a -2 without a mask record is skipped, the channels after it still in step; a layer without a mask has none
        const stray = { name: "stray", top: 0, left: 0, w: 2, h: 2, ch: { ...solid(2, 2), "-2": [9, 9, 9, 9] }, dims: { "-2": [2, 2] } };
        const ds = await readPsd(psd({ width: W, height: H, layers: [stray, next] }));
        check("a -2 without a mask record is no mask, the next layer reads right", !("mask" in ds.layers[0]) && px(ds, 1, 1, 1).join() === "1,2,3,4" && !ds.notes.some((n) => /mask/.test(n)), short(ds.notes));
        check("a layer without a mask has no mask field", !("mask" in ds.layers[1]) && "mask" in d3.layers[0]);
        // the note for several, some or all switched off
        const two = await readPsd(psd({ width: W, height: H, layers: [masked, off, next] }));
        check("two masks, one switched off, in one note", two.notes.includes("2 layer masks kept as masks (1 switched off)") && !("mask" in two.layers[2]), short(two.notes));
        const twoOff = await readPsd(psd({ width: W, height: H, layers: [off, off] }));
        check("all switched off", twoOff.notes.includes("2 layer masks kept as masks (all switched off)"), short(twoOff.notes));
        const twoOn = await readPsd(psd({ width: W, height: H, layers: [masked, white] }));
        check("none switched off", twoOn.notes.includes("2 layer masks kept as masks"), short(twoOn.notes));
        // groups: outer (half opacity) holds a layer and an inner hidden group holding a layer; one layer outside
        const lay = (name) => ({ name, top: 0, left: 0, w: 2, h: 2, ch: solid(2, 2) });
        const recs = [
            lay("below"),
            { name: "</Layer group>", top: 0, left: 0, w: 0, h: 0, ch: {}, section: 3 },
            lay("in outer"),
            { name: "</Layer group>", top: 0, left: 0, w: 0, h: 0, ch: {}, section: 3 },
            lay("in inner"),
            { name: "inner", top: 0, left: 0, w: 0, h: 0, ch: {}, section: 1, flags: 2 },
            { name: "outer", top: 0, left: 0, w: 0, h: 0, ch: {}, section: 2, opacity: 128 },
            lay("above"),
        ];
        const gd = await readPsd(psd({ width: W, height: H, layers: recs }));
        const by = Object.fromEntries(gd.layers.map((l) => [l.name, l]));
        check("group records are not layers", JSON.stringify(gd.layers.map((l) => l.name)) === JSON.stringify(["below", "in outer", "in inner", "above"]), short(gd.layers.map((l) => l.name)));
        check("a group's opacity goes into its layers, nested ones too", Math.abs(by["in outer"].opacity - 128 / 255) < 1e-9 && Math.abs(by["in inner"].opacity - 128 / 255) < 1e-9 && by.below.opacity === 1 && by.above.opacity === 1, short(gd.layers.map((l) => l.opacity)));
        check("a hidden group hides its layers only", by["in inner"].visible === false && by["in outer"].visible === true && by.above.visible === true && by.below.visible === true);
        check("the groups are named", gd.notes.some((n) => /2 groups flattened/.test(n)), short(gd.notes));
    }

    console.log("\n--- PSD: flat files and refusals ---");
    {
        const W = 3, H = 2;
        const flat = await readPsd(psd({ width: W, height: H, merged: [fill(6, (i) => i * 10), fill(6, () => 1), fill(6, () => 2)] }));
        check("a flat PSD has no layers and its merged picture", flat.layers.length === 0 && flat.composite[4] === 10 && flat.composite[5] === 1 && flat.composite[7] === 255, short(Array.from(flat.composite.slice(0, 8))));
        const raw = await readPsd(psd({ width: W, height: H, mergedComp: 0, merged: [fill(6, () => 5), fill(6, () => 6), fill(6, () => 7)] }));
        check("a raw merged picture too", raw.composite[0] === 5 && raw.composite[1] === 6 && raw.composite[2] === 7);
        const alpha = await readPsd(psd({ width: W, height: H, channels: 4, merged: [fill(6, () => 5), fill(6, () => 6), fill(6, () => 7), fill(6, () => 99)] }));
        check("a merged picture with transparency keeps it", alpha.composite[3] === 99);
        for (const [what, file, re] of [
            ["PSB", psd({ width: 2, height: 2, version: 2 }), /PSB/],
            ["CMYK", psd({ width: 2, height: 2, mode: 4, channels: 4 }), /CMYK colour; only RGB and grayscale/],
            ["32 bit", psd({ width: 2, height: 2, depth: 32 }), /32 bits per channel/],
            ["not a PSD", new Uint8Array([1, 2, 3, 4, 5, 6]), /not a PSD/],
        ]) {
            const t = await throwsWith(() => readPsd(file), re);
            check(`${what} is refused by name`, t.ok, t.msg);
        }
        const full = psd({ width: 4, height: 4, layers: [{ name: "a", top: 0, left: 0, w: 4, h: 4, ch: { 0: fill(16, () => 1), 1: fill(16, () => 1), 2: fill(16, () => 1) } }] });
        const cut = await throwsWith(() => readPsd(full.slice(0, 80)), /ends early/);
        check("a truncated file says so", cut.ok, cut.msg);
        check("isPsd reads the signature", isPsd(full) && !isPsd(new Uint8Array([0x89, 0x50, 0x4e, 0x47])));
        check("LAYERED_EXT names .psd and .ora", LAYERED_EXT.test("a.PSD") && LAYERED_EXT.test("b.ora") && !LAYERED_EXT.test("c.png"));
    }

    console.log("\n--- ORA ---");
    {
        const png = (tag) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);
        const xml = `<?xml version='1.0' encoding='UTF-8'?>
<image version="0.0.3" w="640" h="480">
  <stack>
    <layer name="Top &amp; &quot;quoted&quot;" src="data/top.png" x="10" y="20" opacity="0.500" visibility="visible" composite-op="svg:multiply" />
    <stack name="group" x="5" y="7" opacity="0.5" visibility="hidden">
      <layer name="In group" src="data/in.png" x="1" y="2" opacity="1.0" />
    </stack>
    <layer name='Lost' src='data/missing.png' />
    <layer name="Odd" src="data/odd.png" composite-op="svg:color-dodge" />
    <layer name="Background" src="data/bg.png" x="0" y="0" />
  </stack>
</image>`;
        const file = zip([
            { name: "mimetype", data: "image/openraster" },
            { name: "stack.xml", data: xml, deflate: true },
            { name: "data/top.png", data: png("top") },
            { name: "data/in.png", data: png("in"), deflate: true },
            { name: "data/odd.png", data: png("odd") },
            { name: "data/bg.png", data: png("bg"), deflate: true },
        ]);
        check("isOra reads the stored mimetype", isOra(file) && !isOra(zip([{ name: "mimetype", data: "application/zip" }])) && !isOra(new Uint8Array(60)));
        const doc = await readOra(file, { inflateRaw });
        const names = doc.layers.map((l) => l.name);
        check("the size and the layers bottom first", doc.width === 640 && doc.height === 480 && JSON.stringify(names) === JSON.stringify(["Background", "Odd", "In group", "Top & \"quoted\""]), short({ w: doc.width, names }));
        const top = doc.layers[3], inG = doc.layers[2];
        check("position, opacity and blend of a layer", top.x === 10 && top.y === 20 && top.opacity === 0.5 && top.blend === "multiply" && top.visible, short(top));
        check("a nested stack adds its offset, opacity and visibility", inG.x === 6 && inG.y === 9 && inG.opacity === 0.5 && inG.visible === false, short(inG));
        check("stored and deflated pictures come back as written", Buffer.from(doc.layers[0].png).toString("latin1").endsWith("bg") && Buffer.from(inG.png).toString("latin1").endsWith("in") && Buffer.from(top.png).toString("latin1").endsWith("top"));
        check("an unknown composite-op, a missing picture and the group are named", doc.notes.some((n) => /Odd \(svg:color-dodge\)/.test(n)) && doc.notes.some((n) => /1 layer without a picture left out \("Lost"\)/.test(n)) && doc.notes.some((n) => /1 group flattened/.test(n)), short(doc.notes));
        const noXml = await throwsWith(() => readOra(zip([{ name: "mimetype", data: "image/openraster" }]), { inflateRaw }), /no stack.xml/);
        check("an ORA without stack.xml is refused", noXml.ok, noXml.msg);
        const noInflater = await throwsWith(() => readOra(file), /needs an inflater/);
        check("a deflated entry without an inflater is an error", noInflater.ok, noInflater.msg);
    }

    console.log("\n--- PSD writers: layer masks (PsdWriter, PsdBandWriter) ---");
    await writerChecks(readPsd);

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); console.log("FAIL"); process.exit(1); });
