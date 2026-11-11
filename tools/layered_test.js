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
// of before (a SHA-256); ORA ignores a stray mask. H1 S5: inflateAtMost (zlib's bytes within its cap, a byte past it
// refused, a cut stream or a wrong checksum still an error), valid ZIP files the same through it as through zlib, and
// crafted files (craftedFixtures: deflate bombs, a 30,000 x 30,000 layer and a 20,000 x 20,000 mask of empty rows, a
// side past 65,535, a raw channel without data, ORA entries past their sizes, a PNG header of 70,000 px) refused in
// their words at once, with no buffers made; `--write-fixtures DIR` writes them too (crafted.json their refusals). The
// app side (open, drop, the round trip through the editor's own writers, the crafted files on both routes) is
// tools/layered_test.py.
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
        // `blocks`: [[id, bytes]] written as they are (a crafted channel: its compression and data, H1 S5)
        const blocks = L.blocks || ids.map((id) => {
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
function zip(entries, { comment = "", after = "" } = {}) {   // [{ name, data, deflate, body, size, localExtra, dirExtra, dirComment }]: `body` deflated bytes as they are, `size` the size the directory gives
    const parts = [], central = [];
    let off = 0;
    const le = (n, v) => { const b = Buffer.alloc(n); if (n === 2) b.writeUInt16LE(v); else b.writeUInt32LE(v >>> 0); return b; };
    for (const e of entries) {
        const data = Buffer.from(e.data || ""), body = e.body ? Buffer.from(e.body) : e.deflate ? zlib.deflateRawSync(data) : data, name = Buffer.from(e.name);
        const crc = crc32(data), method = e.deflate || e.body ? 8 : 0, size = e.size ?? data.length;
        const lx = Buffer.from(e.localExtra || ""), dx = Buffer.from(e.dirExtra || ""), dc = Buffer.from(e.dirComment || "");
        const local = Buffer.concat([le(4, 0x04034b50), le(2, 20), le(2, 0), le(2, method), le(2, 0), le(2, 0), le(4, crc), le(4, body.length), le(4, size), le(2, name.length), le(2, lx.length), name, lx]);
        central.push(Buffer.concat([le(4, 0x02014b50), le(2, 20), le(2, 20), le(2, 0), le(2, method), le(2, 0), le(2, 0), le(4, crc), le(4, body.length), le(4, size), le(2, name.length), le(2, dx.length), le(2, dc.length), le(2, 0), le(2, 0), le(4, 0), le(4, off), name, dx, dc]));
        parts.push(local, body);
        off += local.length + body.length;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.concat([le(4, 0x06054b50), le(2, 0), le(2, 0), le(2, entries.length), le(2, entries.length), le(4, cd.length), le(4, off), le(2, Buffer.from(comment).length)]);
    return new Uint8Array(Buffer.concat([...parts, cd, end, Buffer.from(comment), Buffer.from(after)]));
}

/** A copy of a zip with one field of its end record (`at` from the record's start) or of the i-th directory record changed. */
function zipEndAt(bytes) { for (let i = bytes.length - 22; i >= 0; i--) if (Buffer.from(bytes.buffer, bytes.byteOffset + i, 4).readUInt32LE(0) === 0x06054b50) return i; throw new Error("no end record"); }
function withField(bytes, at, width, value) { const out = Buffer.from(bytes); if (width === 2) out.writeUInt16LE(value, at); else out.writeUInt32LE(value >>> 0, at); return new Uint8Array(out); }
const endField = (bytes, at, width, value) => withField(bytes, zipEndAt(bytes) + at, width, value);
function dirAt(bytes, i) {
    const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
    let p = b.readUInt32LE(zipEndAt(bytes) + 16);
    while (i-- > 0) p += 46 + b.readUInt16LE(p + 28) + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
    return p;
}
const dirField = (bytes, i, at, width, value) => withField(bytes, dirAt(bytes, i) + at, width, value);

/** A PNG of one IDAT, `f(x, y)` -> [r, g, b, a], of 8 or 16 bits, with a gAMA chunk when asked. */
function rgbaPng(w, h, f, { depth = 8, gamma = false } = {}) {
    const n = depth === 16 ? 8 : 4, raw = Buffer.alloc((w * n + 1) * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = f(x, y), o = y * (w * n + 1) + 1 + x * n;
        for (let c = 0; c < 4; c++) { if (depth === 16) raw.writeUInt16BE(v[c] * 257, o + c * 2); else raw[o + c] = v[c]; }
    }
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = 6;
    const gama = Buffer.alloc(4); gama.writeUInt32BE(45455);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...(gamma ? [chunk("gAMA", gama)] : []), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * K20c's ORAs for tools/layered_test.py: 8-bit PNGs of one IDAT with half-transparent pixels whose colour does not
 * survive a premultiply by itself, a fully transparent layer with colour under it, an entry deflated by the zip, a
 * nested stack, and a merged picture nothing may read; `deep.ora` has a 16-bit layer, `gamma.ora` a bottom layer with gAMA.
 */
function k20cOras() {
    const W = 300, H = 200;
    const under = (x, y) => [(x * 251) >> 8, (y * 251) >> 8, (x + y) & 255, 255];
    const soft = (x, y) => [200 - (x & 7), 100 + (y & 7), 50, 1 + ((x * 3 + y * 7) % 254)];
    const stack = (body) => `<?xml version='1.0' encoding='UTF-8'?>\n<image version="0.0.3" w="${W}" h="${H}">\n<stack>\n${body}\n<layer name="Background" src="data/bg.png" />\n</stack>\n</image>\n`;
    const bg = rgbaPng(W, H, under);
    const single = zip([
        { name: "mimetype", data: "image/openraster" },
        { name: "mergedimage.png", data: Buffer.alloc(70000, 0x5a) },
        { name: "stack.xml", data: stack(`<stack x="5" y="7"><layer name="Nested" src="data/n.png" x="1" y="2" /></stack>\n<layer name="Zero" src="data/z.png" x="100" y="100" />\n<layer name="Soft" src="data/s.png" x="20" y="30" />`), deflate: true },
        { name: "data/bg.png", data: bg },
        { name: "data/s.png", data: rgbaPng(64, 48, soft), deflate: true },
        { name: "data/z.png", data: rgbaPng(32, 32, (x, y) => [x * 7, y * 7, 99, 0]) },
        { name: "data/n.png", data: rgbaPng(16, 16, (x) => [x * 15, 40, 40, 255]) },
    ]);
    const deep = zip([
        { name: "mimetype", data: "image/openraster" },
        { name: "stack.xml", data: stack(`<layer name="Deep" src="data/d.png" x="4" y="4" />`) },
        { name: "data/bg.png", data: bg },
        { name: "data/d.png", data: rgbaPng(24, 24, (x, y) => [x * 9, y * 9, 200, 255], { depth: 16 }) },
    ]);
    const gamma = zip([
        { name: "mimetype", data: "image/openraster" },
        { name: "stack.xml", data: stack(`<layer name="Top" src="data/t.png" x="4" y="4" />`) },
        { name: "data/bg.png", data: rgbaPng(W, H, under, { gamma: true }) },
        { name: "data/t.png", data: rgbaPng(8, 8, () => [9, 9, 9, 255]) },
    ]);
    return { "single.ora": single, "deep.ora": deep, "gamma.ora": gamma };
}

/**
 * D0's files of more than one band of 256 rows (the app twin in tools/layered_test.py, and the twin here): a flat
 * file with alpha (the merged picture is all there is), and a 16-bit ZIP-with-prediction layer over an RLE one, partly
 * outside the picture, with a mask offset from it at 16 bit, and a clipped layer.
 */
function bandFixtures() {
    const noise = rng(9), n8 = () => noise() & 255, n16 = () => noise() & 0xffff;
    const FW = 300, FH = 600;
    const flat = psd({ width: FW, height: FH, channels: 4, merged: [fill(FW * FH, (i) => (i * 7) & 255), fill(FW * FH, n8), fill(FW * FH, (i) => (i >> 9) & 255), fill(FW * FH, (i) => (i % 5 ? n8() : 255))] });
    const DW = 280, DH = 500, LW = 300, LH = 520;
    const deep = psd({ width: DW, height: DH, depth: 16, layers: [
        { name: "Under", top: 0, left: 0, w: DW, h: DH, comp: 1, ch: { 0: fill(DW * DH, n16), 1: fill(DW * DH, (i) => i * 3), 2: fill(DW * DH, () => 40000), "-1": fill(DW * DH, () => 65535) } },
        { name: "Deep masked", top: -10, left: -15, w: LW, h: LH, comp: 3, blend: "scrn", opacity: 200,
            ch: { 0: fill(LW * LH, n16), 1: fill(LW * LH, (i) => (i * 131) & 0xffff), 2: fill(LW * LH, n16), "-1": fill(LW * LH, (i) => (i % 3 ? n16() : 65535)), "-2": fill(200 * 400, (i) => (i * 37) & 0xffff) },
            mask: { top: 40, left: 0, w: 200, h: 400, def: 255 } },
        { name: "Clipped", top: 100, left: 50, w: 60, h: 300, clipping: 1, ch: { 0: fill(60 * 300, n16), 1: fill(60 * 300, n16), 2: fill(60 * 300, n16), "-1": fill(60 * 300, n16) } },
    ] });
    return { "flat.psd": flat, "deep.psd": deep };
}

/**
 * `--write-fixtures <dir>`: two files for the app gate (tools/layered_test.py): `loose.psd`, 40 x 30, whose bottom layer
 * does not cover the picture (so the base is transparent), a mask and a hidden group; `loose.ora`, the same shape;
 * `flat.psd` and `deep.psd` (bandFixtures).
 */
/**
 * H1 S5's crafted files (docs/research/review_external_2026-11-07/verified.json): small files that asked the reader for
 * gigabytes before, each with the refusal it gets now (`re`) and the reader it is for. `bombMB`: what the deflate bombs
 * unpack to (the app's fixtures make them large enough to see in the renderer's memory).
 */
function craftedFixtures(bombMB = 64) {
    const rleZeros = (rows) => { const b = new B().u16(1); for (let y = 0; y < rows; y++) b.u16(0); return b.out(); };
    const zeros = zlib.deflateSync(Buffer.alloc(bombMB * 1048576));
    const zipBomb = new B().u16(2).bytes(zeros).out();
    const tiny = (w, h, comp = 1) => channelData(fill(w * h, (i) => i % 251), w, h, 8, comp);
    const files = {};
    // a 30,000 x 30,000 layer whose RLE rows are all empty: 180 KB of row lengths for 2.7 GB of planes
    files["crafted_huge_rle.psd"] = { re: /"Huge" holds less data than its 30,000 × 30,000 px need/, bytes: psd({ width: 64, height: 64, layers: [
        { name: "Huge", top: 0, left: 0, w: 30000, h: 30000, blocks: [[0, rleZeros(30000)], [1, rleZeros(30000)], [2, rleZeros(30000)]] }] }) };
    // a side past what a document can hold
    files["crafted_wide.psd"] = { re: /"Wide" is 70,000 × 4 px, more than a layer can be/, bytes: psd({ width: 64, height: 64, layers: [
        { name: "Wide", top: 0, left: 0, w: 70000, h: 4, blocks: [[0, rleZeros(4)]] }] }) };
    // a real 8 x 8 layer with a 20,000 x 20,000 mask of empty rows
    files["crafted_mask.psd"] = { re: /"Masked"'s mask holds less data than its 20,000 × 20,000 px need/, bytes: psd({ width: 64, height: 64, layers: [
        { name: "Masked", top: 0, left: 0, w: 8, h: 8, mask: { top: 0, left: 0, w: 20000, h: 20000, def: 0 }, blocks: [[0, tiny(8, 8)], [1, tiny(8, 8)], [2, tiny(8, 8)], [-2, rleZeros(20000)]] }] }) };
    // a ZIP channel of a 512 x 512 layer that unpacks to bombMB MB (a deflate bomb)
    files["crafted_zip_bomb.psd"] = { re: /a ZIP channel of the PSD layer "Bomb" unpacks to more than its 512 × 512 px/, bytes: psd({ width: 64, height: 64, layers: [
        { name: "Bomb", top: 0, left: 0, w: 512, h: 512, blocks: [[0, zipBomb]] }] }) };
    // a raw channel of 4096 x 4096 with 16 bytes of data
    files["crafted_raw_short.psd"] = { re: /"Short" holds less data than its 4,096 × 4,096 px need/, bytes: psd({ width: 64, height: 64, layers: [
        { name: "Short", top: 0, left: 0, w: 4096, h: 4096, blocks: [[0, new B().u16(0).bytes(new Uint8Array(16)).out()]] }] }) };
    // an RLE channel whose own length holds its row table alone: its rows (256 KB) would be read from the next
    // channel's bytes, so many such records could each claim the same data
    const table = new B().u16(1);
    for (let y = 0; y < 4096; y++) table.u16(64);
    files["crafted_overlap.psd"] = { re: /"Overlap" holds less data than its 4,096 × 4,096 px need/, bytes: psd({ width: 64, height: 64, layers: [
        { name: "Overlap", top: 0, left: 0, w: 4096, h: 4096, blocks: [[0, table.out()], [1, new B().u16(0).bytes(new Uint8Array(300000)).out()]] }] }) };
    // a flat file of 16,000 x 16,000 (no layers) whose merged rows are all empty: refused, not opened empty
    const flat = new B().ascii("8BPS").u16(1).bytes([0, 0, 0, 0, 0, 0]).u16(3).u32(16000).u32(16000).u16(8).u16(3).u32(0).u32(0).u32(0).u16(1);
    for (let i = 0; i < 3 * 16000; i++) flat.u16(0);
    files["crafted_flat.psd"] = { re: /the PSD's merged picture holds less data than its 16,000 × 16,000 px need/, bytes: flat.out() };
    // OpenRaster: a layer's PNG deflated to a bomb behind a directory size of 1 KB; an entry the directory says is 1 GB;
    // a stack.xml of 20 MB; a stored PNG whose IHDR says 70,000 x 4
    const xml = `<?xml version='1.0' encoding='UTF-8'?>\n<image version="0.0.3" w="64" h="64"><stack><layer name="L" src="data/l.png" /></stack></image>\n`;
    const ora = (entry, xmlEntry = { name: "stack.xml", data: xml }) => zip([{ name: "mimetype", data: "image/openraster" }, xmlEntry, entry]);
    files["crafted_bomb.ora"] = { re: /the ORA entry data\/l\.png unpacks to more than the 1,024 bytes its zip directory gives/, bytes: ora({ name: "data/l.png", body: zlib.deflateRawSync(Buffer.alloc(bombMB * 1048576)), size: 1024 }) };
    files["crafted_declared.ora"] = { re: /the ORA file's entries unpack to more than \d[\d,]* MB \(at data\/l\.png\)/, bytes: ora({ name: "data/l.png", body: zlib.deflateRawSync(Buffer.alloc(1024)), size: 1024 * 1048576 }) };
    files["crafted_xml.ora"] = { re: /stack\.xml unpacks to 20 MB, more than a stack\.xml can be \(16 MB\)/, bytes: ora({ name: "data/l.png", data: "x" }, { name: "stack.xml", body: zlib.deflateRawSync(Buffer.from(xml)), size: 20 * 1048576 }) };
    const ihdr = Buffer.alloc(25);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(ihdr, 0);
    ihdr.writeUInt32BE(13, 8); ihdr.write("IHDR", 12, "latin1"); ihdr.writeUInt32BE(70000, 16); ihdr.writeUInt32BE(4, 20); ihdr[24] = 8;
    files["crafted_png.ora"] = { re: /the ORA layer "L" is 70,000 × 4 px, more than a layer can be/, bytes: ora({ name: "data/l.png", data: Buffer.concat([ihdr, Buffer.alloc(12)]) }) };
    // three layers of 16,000 x 16,000 px (each below the one-layer cap) over a picture of 64 x 64: more than 268 MP
    const big = Buffer.from(ihdr);
    big.writeUInt32BE(16000, 16); big.writeUInt32BE(16000, 20);
    const xml3 = `<?xml version='1.0' encoding='UTF-8'?>\n<image version="0.0.3" w="64" h="64"><stack><layer name="L3" src="data/l.png" /><layer name="L2" src="data/l.png" /><layer name="L1" src="data/l.png" /></stack></image>\n`;
    files["crafted_many.ora"] = { re: /the ORA file's layers add up to more than 268 MP at the ORA layer "L2"/, bytes: ora({ name: "data/l.png", data: Buffer.concat([big, Buffer.alloc(12)]) }, { name: "stack.xml", data: xml3 }) };
    // one layer past what Blink decodes (2^29 px), below the 65,535 px side
    const huge = Buffer.from(ihdr);
    huge.writeUInt32BE(30000, 16); huge.writeUInt32BE(20000, 20);
    files["crafted_decode.ora"] = { re: /the ORA layer "L" is 30,000 × 20,000 px, more than a layer can be \(65,535 px a side, 537 MP\)/, bytes: ora({ name: "data/l.png", data: Buffer.concat([huge, Buffer.alloc(12)]) }) };
    return files;
}

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
    for (const [name, bytes] of Object.entries(bandFixtures())) fs.writeFileSync(path.join(dir, name), bytes);
    for (const [name, bytes] of Object.entries(k20cOras())) fs.writeFileSync(path.join(dir, name), bytes);
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
    // H1 S5: the crafted files, their bombs at 512 MB (what a reader without its caps would make the renderer hold),
    // and crafted.json with each one's refusal for tools/layered_test.py
    const crafted = craftedFixtures(512), said = {};
    for (const [name, f] of Object.entries(crafted)) { fs.writeFileSync(path.join(dir, name), f.bytes); said[name] = f.re.source; }
    fs.writeFileSync(path.join(dir, "crafted.json"), JSON.stringify(said, null, 1));
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
    check("read back: masks kept are no loss (the status line stays plain)", back.lossy === false, short(back.notes));
    check("read back: the merged picture", equalBytes(back.composite, composite));

    // without masks: the bytes of before, from both writers
    const na = await viaCanvas(bare), nb = await viaBands(bare, packs[packs.length - 1][1], 4);
    const sha = crypto.createHash("sha256").update(na).digest("hex");
    check("without masks both writers give the same bytes", equalBytes(na, nb), firstDiff(na, nb));
    check("without masks the bytes are the ones of before (SHA-256)", sha === NO_MASK_SHA256, sha);

    // groups (PLAN_0_1_31 §6.5): the section records of both writers, the same bytes, read back as folders
    {
        const sect = (section, name, visible = true) => ({ section, name, visible, x: 0, y: 0, opacity: 1, blend: "normal" });
        const list = [bare[0], sect(3, "</Layer group>"), bare[1], sect(3, "</Layer group>"), bare[2], sect(1, "Inner", false), sect(2, "Outer äö"), bare[3]];
        const w1 = new X.PsdWriter({ width: DW, height: DH });
        for (const L of list) { if (L.section) w1.layer(L); else w1.layer(meta(L), standIn(L.w, L.h, L.rgba)); }
        const ga = new Uint8Array(await w1.finish(standIn(DW, DH, composite)).arrayBuffer());
        const w2 = new BW.PsdBandWriter({ width: DW, height: DH, run: runWith(packs[packs.length - 1][1]), flights: 2 });
        for (const L of list) { if (L.section) w2.section(L); else await w2.layer(meta(L), rowsOf(L.w, L.h, L.rgba, 4)); }
        const gb = new Uint8Array(await (await w2.finish(rowsOf(DW, DH, composite, 5))).arrayBuffer());
        check("groups: both writers give the same bytes", equalBytes(ga, gb), firstDiff(ga, gb));
        const gr = await readPsd(ga);
        const gn = Object.fromEntries((gr.groups || []).map((g) => [g.name, g]));
        const outer = gn["Outer äö"];
        check("groups: read back as folders, nested, hidden, folded, the Unicode name", gr.groups.length === 2 && gn.Inner && outer && gn.Inner.parent === outer.id && outer.parent === null && gn.Inner.visible === false && outer.visible === true && outer.collapsed === true && gn.Inner.collapsed === false, short(gr.groups));
        check("groups: the layers in them, their own eyes kept", JSON.stringify(gr.layers.map((l) => (l.group ? gr.groups.find((g) => g.id === l.group).name : null))) === JSON.stringify([null, outer && outer.name, "Inner", null]) && gr.layers.every((l, i) => l.visible === (bare[i].visible !== false)), short(gr.layers.map((l) => [l.group, l.visible])));
        check("groups: no note of a group's opacity or blend", !gr.notes.some((n) => /opacity of|pass through/.test(n)) && gr.notes.some((n) => /2 groups kept as folders/.test(n)), short(gr.notes));
        let Pg = null;
        try { Pg = parseWritten(ga); } catch (err) { check("the PSD with groups parses strictly", false, err.message); }
        if (Pg) check("groups: four records with lsct, pass through on the folders", Pg.records.filter((R) => R.infoKeys.includes("lsct")).length === 4 && Pg.records.filter((R) => R.blend === "pass").length === 2, short(Pg.records.map((R) => [R.blend, R.infoKeys.join()])));
    }
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

// ---- D0: the worker's reader beside readPsd ---------------------------------------------------
// docs/PLAN_WASM_BUILD.md §7 D0: the pool job psd_read runs readPsdStream, which hands every layer's pixels out as RGBA
// bands as soon as its channels are read (and its mask as the white-with-alpha bands the editor's Mask takes), and
// reads the merged picture only when no layer has pixels. Every readPsd call of this file runs it too, in bands of 3
// rows and of 256, and the two answers must be the same: every layer's bytes, its mask's bytes against the window's
// mask loop (a copy of inpaint_canvas.js readLayered's at bbff117, below), its fields, the groups, notes and loss
// flag, the merged picture where it is read; a file readPsd refuses, refused with the same message.

/** The window's mask loop (inpaint_canvas.js readLayered, bbff117): a mask's bytes as the RGBA Mask.fromImageData takes. */
function windowMaskRgba(v) {
    const d = new Uint8ClampedArray(v.length * 4);
    for (let i = 0, o = 0; i < v.length; i++, o += 4) { d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; d[o + 3] = v[i]; }
    return d;
}

/**
 * readPsdStream's answer with its bands put together: `{ doc, header, got }`, `got` index -> { w, h, rgba, mask, rows,
 * maskRows } (the RGBA of each kind, and the rows each band began at, in order). `hash`: keep a SHA-256 per kind instead
 * of the bytes (the 15k file).
 */
async function streamed(readPsdStream, bytes, opts, rowsPerBand, hash = false) {
    const got = new Map();
    let header = null, headers = 0;
    const doc = await readPsdStream(bytes, {
        ...opts,
        rowsPerBand,
        onHeader: (h) => { header = h; headers++; },
        onRows: (index, kind, rgba, w, h, y0, rows) => {
            let e = got.get(index);
            if (!e) got.set(index, (e = { w, h, rgba: null, mask: null, rows: [], maskRows: [], sha: {}, order: [] }));
            if (e.w !== w || e.h !== h) throw new Error(`stream index ${index}: ${w} x ${h} after ${e.w} x ${e.h}`);
            if (!(rgba instanceof Uint8ClampedArray) || rgba.length !== rows * w * 4) throw new Error(`stream index ${index}: a band of ${rgba && rgba.length} bytes for ${rows} rows of ${w}`);
            e.order.push(kind);
            (kind === "mask" ? e.maskRows : e.rows).push([y0, rows]);
            if (hash) { (e.sha[kind] = e.sha[kind] || crypto.createHash("sha256")).update(rgba); return; }
            const key = kind === "mask" ? "mask" : "rgba";
            if (!e[key]) e[key] = new Uint8ClampedArray(w * h * 4);
            e[key].set(rgba, y0 * w * 4);
        },
    });
    return { doc, header, headers, got };
}

/** The rows of bands [[y0, rows], ...] cover 0..h once, in order, each at most `per` rows. */
const bandsCover = (bands, h, per) => bands.length > 0 && bands.every(([y0, n], i) => y0 === (i ? bands[i - 1][0] + bands[i - 1][1] : 0) && n > 0 && n <= per) && bands[bands.length - 1][0] + bands[bands.length - 1][1] === h;
const LAYER_KEYS = ["name", "x", "y", "w", "h", "opacity", "visible", "blend", "group", "clip"];

/** The differences between readPsd's answer `win` and the stream's `s` (empty when they are the same). */
function twinDiffs(win, s, per, hash = false) {
    const out = [];
    const { doc, got } = s;
    const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
    if (s.headers !== 1 || !s.header || s.header.width !== win.width || s.header.height !== win.height) out.push(`header ${short(s.header)} (${s.headers} calls)`);
    if (doc.width !== win.width || doc.height !== win.height) out.push(`size ${doc.width} x ${doc.height}`);
    if (doc.layers.length !== win.layers.length) out.push(`${doc.layers.length} layers, readPsd ${win.layers.length}`);
    const used = new Set();
    win.layers.forEach((W, i) => {
        const S = doc.layers[i];
        if (!S) return;
        for (const k of LAYER_KEYS) if (S[k] !== W[k]) out.push(`layer ${i} ${k}: ${short(S[k])} / ${short(W[k])}`);
        if ("rgba" in S) out.push(`layer ${i} carries rgba`);
        const e = got.get(S.index);
        used.add(S.index);
        if (!e) { out.push(`layer ${i}: no bands for index ${S.index}`); return; }
        if (e.w !== W.w || e.h !== W.h) out.push(`layer ${i}: bands of ${e.w} x ${e.h}`);
        if (!bandsCover(e.rows, W.h, per)) out.push(`layer ${i}: rgba bands ${short(e.rows)}`);
        if (hash ? e.sha.rgba?.digest("hex") !== sha(W.rgba) : !equalBytes(e.rgba, W.rgba)) out.push(`layer ${i} (${W.name}): rgba differs${hash ? "" : " (" + firstDiff(e.rgba || [], W.rgba) + ")"}`);
        if (W.mask) {
            if (!S.mask || S.mask.defaultColor !== W.mask.defaultColor || S.mask.disabled !== W.mask.disabled || "data" in S.mask) out.push(`layer ${i}: mask ${short(S.mask)} / ${short({ defaultColor: W.mask.defaultColor, disabled: W.mask.disabled })}`);
            if (!bandsCover(e.maskRows, W.h, per)) out.push(`layer ${i}: mask bands ${short(e.maskRows)}`);
            const want = windowMaskRgba(W.mask.data);
            if (hash ? e.sha.mask?.digest("hex") !== sha(want) : !equalBytes(e.mask, want)) out.push(`layer ${i}: mask bytes differ${hash ? "" : " (" + firstDiff(e.mask || [], want) + ")"}`);
            const firstMask = e.order.indexOf("mask");
            if (firstMask >= 0 && e.order.slice(firstMask).some((k) => k !== "mask")) out.push(`layer ${i}: rgba bands after its mask bands`);
        } else if (S.mask || e.maskRows.length) out.push(`layer ${i}: a mask the file has not (${short(S.mask)}, ${e.maskRows.length} bands)`);
    });
    if (JSON.stringify(doc.groups) !== JSON.stringify(win.groups)) out.push(`groups ${short(doc.groups)} / ${short(win.groups)}`);
    if (JSON.stringify(doc.notes) !== JSON.stringify(win.notes)) out.push(`notes ${short(doc.notes)} / ${short(win.notes)}`);
    if (doc.lossy !== win.lossy) out.push(`lossy ${doc.lossy} / ${win.lossy}`);
    // the merged picture: read only when no layer has pixels (the one case the editor shows it)
    if (win.layers.length) {
        if (doc.composite != null) out.push(`a merged picture read beside ${win.layers.length} layers (index ${doc.composite})`);
    } else if ((win.composite == null) !== (doc.composite == null)) out.push(`merged picture ${doc.composite} / ${win.composite ? "read" : "none"}`);
    else if (win.composite) {
        const e = got.get(doc.composite);
        used.add(doc.composite);
        if (!e || e.w !== win.width || e.h !== win.height || e.maskRows.length || !bandsCover(e.rows, win.height, per)) out.push(`merged picture bands ${short(e && e.rows)}`);
        else if (hash ? e.sha.rgba?.digest("hex") !== sha(win.composite) : !equalBytes(e.rgba, win.composite)) out.push(`merged picture differs${hash ? "" : " (" + firstDiff(e.rgba, win.composite) + ")"}`);
    }
    const stray = [...got.keys()].filter((k) => !used.has(k));
    if (stray.length) out.push(`bands for indices nobody names: ${stray.join(", ")}`);
    return out;
}

const TWIN = { files: 0, refusals: 0, fails: [] };

const pxKernelsOf = (px) => ({
    packbitsRows: (lb, s, r, rb, o) => px.packbitsRows(lb, s, r, rb, o),
    maskRgba: (s, mw, sx0, w, r, x0, x1, ry0, ry1, b, def, o) => px.psdMaskRgba(s, mw, sx0, w, r, x0, x1, ry0, ry1, b, def, o),
    bandRgba: (d, w, y0, r, dep, g, sp) => px.psdBandRgba(d, w, y0, r, dep, g, sp),
    bandMask: (d, L, m, w, h, y0, r, dep, sp) => px.psdBandMask(d, L, m, w, h, y0, r, dep, sp),
});

async function loadPxBuilds() {
    const { loadPx } = await editorModule("px/px.js");
    const pxDir = path.join(EDITOR, "px");
    const simdPx = await loadPx(fs.readFileSync(path.join(pxDir, "px.wasm")));
    const scalarPx = await loadPx(fs.readFileSync(path.join(pxDir, "px_scalar.wasm")));
    return [
        ["PSD_JS", null],
        ["px.wasm", pxKernelsOf(simdPx)],
        ["px_scalar.wasm", pxKernelsOf(scalarPx)],
    ];
}

/** readPsd, with readPsdStream run beside it on the same bytes (bands of 3 rows and of 256, on PSD_JS, px.wasm and px_scalar.wasm) and the answers compared. */
/**
 * K20c: `readOra`, and beside it every read through `readOraBlob` on a Blob of the same bytes: the same size, notes, loss
 * flag and layer fields, each layer's PNG the same bytes (and typed as a PNG), `onHeader` the same calls with a throw
 * thrown there too, and the same refusal word for word. A difference lands in ORA_TWIN.fails, which the last check reads.
 */
const ORA_TWIN = { files: 0, refusals: 0, fails: [] };
function oraTwinned(mod) {
    const fields = (d) => JSON.stringify({ w: d.width, h: d.height, notes: d.notes, lossy: d.lossy, layers: d.layers.map(({ png, pngBlob, ...rest }) => rest) });
    return async (input, opts = {}) => {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        const said = [];
        const byHeader = opts.onHeader ? { ...opts, onHeader: (h) => { const one = { h: { ...h }, err: null }; said.push(one); try { return opts.onHeader(h); } catch (err) { one.err = err; throw err; } } } : opts;
        let doc = null, err = null;
        try { doc = await mod.readOra(bytes, byHeader); } catch (e) { err = e; }
        const heard = [];
        const blobHeader = opts.onHeader ? { ...opts, onHeader: (h) => { heard.push({ ...h }); const one = said[heard.length - 1]; if (one && one.err) throw one.err; } } : opts;
        let bdoc = null, berr = null;
        try { bdoc = await mod.readOraBlob(new Blob([bytes]), blobHeader); } catch (e) { berr = e; }
        ORA_TWIN.files++;
        const fail = (t) => ORA_TWIN.fails.push(`case ${ORA_TWIN.files}: ${t}`);
        if (JSON.stringify(said.map((x) => x.h)) !== JSON.stringify(heard)) fail(`onHeader ${short(said.map((x) => x.h))} against ${short(heard)}`);
        if (err || berr) {
            const a = err ? String(err.message || err) : null, b = berr ? String(berr.message || berr) : null;
            if (a !== b) fail(`readOra ${a ? "throws " + a : "reads it"}, readOraBlob ${b ? "throws " + b : "reads it"}`);
            if (err) { ORA_TWIN.refusals++; throw err; }
            return doc;
        }
        if (fields(doc) !== fields(bdoc)) fail(`${short(fields(bdoc))} against ${short(fields(doc))}`);
        for (let i = 0; i < Math.min(doc.layers.length, bdoc.layers.length); i++) {
            const got = bdoc.layers[i].pngBlob;
            if (!(got instanceof Blob) || got.type !== "image/png") { fail(`layer ${i}: pngBlob is not a PNG Blob`); continue; }
            if (bdoc.layers[i].png !== undefined) fail(`layer ${i}: readOraBlob keeps png bytes`);
            if (!equalBytes(doc.layers[i].png, new Uint8Array(await got.arrayBuffer()))) fail(`layer ${i}: other PNG bytes`);
        }
        return doc;
    };
}

function twinned(mod, pxBuilds = [["PSD_JS", null]]) {
    return async (input, opts) => {
        let win = null, werr = null;
        try { win = await mod.readPsd(input, opts); } catch (err) { werr = err; }
        for (const per of [3, 256]) {
            for (const [kLabel, kernels] of pxBuilds) {
                let s = null, serr = null;
                try { s = await streamed(mod.readPsdStream, input, { ...(opts || {}), kernels }, per); } catch (err) { serr = err; }
                if (werr || serr) {
                    const a = werr && String(werr.message || werr), b = serr && String(serr.message || serr);
                    if (a !== b) TWIN.fails.push(`case ${TWIN.files + 1} (${kLabel}, bands of ${per}): readPsd ${a ? "throws " + a : "reads it"}, the stream ${b ? "throws " + b : "reads it"}`);
                    continue;
                }
                const d = twinDiffs(win, s, per);
                if (d.length) TWIN.fails.push(`case ${TWIN.files + 1} (${kLabel}, bands of ${per}, ${win.layers.length} layers): ${d.slice(0, 4).join("; ")}`);
            }
        }
        TWIN.files++;
        if (werr) { TWIN.refusals++; throw werr; }
        return win;
    };
}

/** `--twin-file PATH`: one PSD (the G2 15k file) through readPsd and readPsdStream (PSD_JS, px.wasm SIMD, px_scalar.wasm), compared by SHA-256; the timings beside. */
async function twinFile(file) {
    const mod = await editorModule("inpaint_layered.js");
    const pxBuilds = await loadPxBuilds();
    const bytes = new Uint8Array(fs.readFileSync(file));
    console.log(`${file}: ${(bytes.length / 1048576).toFixed(1)} MB`);
    let t = performance.now();
    const win = await mod.readPsd(bytes, { inflate });
    const winMs = performance.now() - t;
    console.log(`readPsd ${winMs.toFixed(0)} ms (${win.layers.length} layers ${win.layers.map((l) => `${l.name} ${l.w}x${l.h}${l.mask ? " masked" : ""}`).join(", ")}, merged picture ${win.composite ? "read" : "none"})`);
    const allDiffs = [];
    for (const [kLabel, kernels] of pxBuilds) {
        const spent = {};
        t = performance.now();
        const s = await streamed(mod.readPsdStream, bytes, { inflate, spent, kernels }, 256, true);
        const streamMs = performance.now() - t;
        const d = twinDiffs(win, s, 256, true);
        console.log(`readPsdStream (${kLabel}) ${streamMs.toFixed(0)} ms ${short(spent)}`);
        for (const msg of d) allDiffs.push(`${kLabel}: ${msg}`);
    }
    check(`the worker's reader (PSD_JS, px.wasm, px_scalar.wasm) equals readPsd on ${path.basename(file)}: every layer's bytes and mask by SHA-256, the fields, groups, notes`, allDiffs.length === 0, allDiffs.slice(0, 6).join("; "));
}

(async () => {
    const at = process.argv.indexOf("--write-fixtures");
    if (at > 0) { writeFixtures(process.argv[at + 1]); return; }
    const tf = process.argv.indexOf("--twin-file");
    if (tf > 0) {
        await twinFile(process.argv[tf + 1]);
        const bad = results.filter((x) => !x).length;
        console.log(bad ? "FAIL" : "PASS");
        process.exit(bad ? 1 : 0);
    }
    const mod = await editorModule("inpaint_layered.js");
    const pxBuilds = await loadPxBuilds();
    const { isPsd, isOra, LAYERED_EXT } = mod;
    const readOra = oraTwinned(mod);   // every ORA read below goes through readOraBlob too (K20c)
    const readPsd = twinned(mod, pxBuilds);   // every PSD read below goes through readPsdStream on PSD_JS, px.wasm and px_scalar.wasm (D0, K20b)
    const { BLENDS } = await editorModule("blend_modes.js");

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
        check("16 bit rounded is a loss (the status line goes red)", d16.lossy === true, short(d16.notes));
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
            { name: "odd blend", top: 0, left: 0, w: 2, h: 2, ch: solid(2, 2, 1, 2, 3), blend: "xxxx" },
            { name: "clipped", top: 0, left: 0, w: 2, h: 2, ch: solid(2, 2, 1, 2, 3), clipping: 1 },
            { name: "empty", top: 0, left: 0, w: 0, h: 0, ch: {} },
            { name: "Levels 1", top: 0, left: 0, w: 0, h: 0, ch: {}, info: { levl: new Uint8Array(4) } },
            { name: "Curves over pixels", top: 0, left: 0, w: 2, h: 2, ch: solid(2, 2, 9, 9, 9), info: { curv: new Uint8Array(4) } },
            { name: "clipped to curves", top: 0, left: 0, w: 2, h: 2, ch: solid(2, 2, 4, 5, 6), clipping: 1 },
        ];
        const doc = await readPsd(psd({ width: W, height: H, layers }));
        const names = doc.layers.map((l) => l.name);
        check("layers bottom first, adjustments and empty layers left out", JSON.stringify(names) === JSON.stringify(["Background", "Ebene äöü ✓", "hidden", "odd blend", "clipped", "clipped to curves"]), short(names));
        check("layers without a mask have no mask field, and no note speaks of layer masks", doc.layers.every((l) => !("mask" in l)) && !doc.notes.some((n) => /layer mask/.test(n)), short(doc.notes));
        const L = doc.layers[1];
        check("the Unicode name wins over the Pascal one", L.name === "Ebene äöü ✓");
        check("position, size, blend and opacity", L.x === 3 && L.y === 2 && L.w === 4 && L.h === 3 && L.blend === "multiply" && Math.abs(L.opacity - 128 / 255) < 1e-9, short({ x: L.x, y: L.y, w: L.w, h: L.h, blend: L.blend, opacity: L.opacity }));
        check("a hidden layer (flag 2) is hidden, a negative offset kept", doc.layers[2].visible === false && doc.layers[2].x === -1 && doc.layers[2].y === -2 && doc.layers[1].visible === true);
        check("an unknown blend mode becomes normal and is named", doc.layers[3].blend === "normal" && doc.notes.some((n) => /blend modes.*odd blend \(xxxx\)/.test(n)), short(doc.notes));
        // PLAN_0_1_31 §6 step 3: a clip onto a kept layer stays, a clip onto a left-out one (an adjustment here) goes and is named
        check("a clipped layer stays clipped", doc.layers[4].clip === true && doc.layers.filter((l) => l.clip).length === 1 && doc.notes.some((n) => /1 clipped layer kept clipped/.test(n)), short(doc.notes));
        check("a clip onto a left-out layer is dropped and named", !doc.layers[5].clip && doc.notes.some((n) => /not kept.*"clipped to curves"/.test(n)), short(doc.notes));
        check("adjustment layers are named, with and without pixels", doc.notes.some((n) => /2 adjustment or fill layers left out \("Levels 1", "Curves over pixels"\)/.test(n)), short(doc.notes));
        check("left-out layers are a loss", doc.lossy === true, short(doc.notes));
        check("the merged picture is read", doc.composite && doc.composite.length === W * H * 4 && doc.composite[3] === 255);
        const every = BLENDS.map((b) => b.id);
        const keys = BLENDS.map((b) => b.psd);
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
        check("a kept mask is no loss", d.lossy === false, short(d.notes));
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
        // groups come back as folders (PLAN_0_1_31 §6.5): the layers keep their own eyes, the groups theirs
        const gby = Object.fromEntries((gd.groups || []).map((g) => [g.name, g]));
        check("the groups come back as folders", gd.groups.length === 2 && gby.inner && gby.outer && gby.inner.parent === gby.outer.id && gby.outer.parent === null, short(gd.groups));
        check("a layer names its innermost group", by["in inner"].group === gby.inner.id && by["in outer"].group === gby.outer.id && by.below.group === null && by.above.group === null, short(gd.layers.map((l) => l.group)));
        check("a hidden group is hidden, its layer keeps its own eye", gby.inner.visible === false && gby.outer.visible === true && by["in inner"].visible === true, short(gd.groups));
        check("a folded group comes back folded", gby.outer.collapsed === true && gby.inner.collapsed === false);
        check("the groups are named", gd.notes.some((n) => /2 groups kept as folders/.test(n)) && gd.notes.some((n) => /opacity of 1 group went into its layers/.test(n)), short(gd.notes));
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
    <layer name="Odd" src="data/odd.png" composite-op="svg:odd-blend" />
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
        check("an unknown composite-op, a missing picture and the group are named", doc.notes.some((n) => /Odd \(svg:odd-blend\)/.test(n)) && doc.notes.some((n) => /1 layer without a picture left out \("Lost"\)/.test(n)) && doc.notes.some((n) => /1 group flattened/.test(n)), short(doc.notes));
        check("an ORA with a part left out is a loss", doc.lossy === true, short(doc.notes));
        const noXml = await throwsWith(() => readOra(zip([{ name: "mimetype", data: "image/openraster" }]), { inflateRaw }), /no stack.xml/);
        check("an ORA without stack.xml is refused", noXml.ok, noXml.msg);
        const noInflater = await throwsWith(() => readOra(file), /needs an inflater/);
        check("a deflated entry without an inflater is an error", noInflater.ok, noInflater.msg);
        const oraXml = `<?xml version='1.0' encoding='UTF-8'?>
<image version="0.0.3" w="10" h="10">
  <stack>
${BLENDS.slice().reverse().map((b) => `    <layer name="${b.id}" src="data/${b.id}.png" composite-op="${b.ora}" />`).join("\n")}
  </stack>
</image>`;
        const oraFile = zip([
            { name: "mimetype", data: "image/openraster" },
            { name: "stack.xml", data: oraXml, deflate: true },
            ...BLENDS.map((b) => ({ name: `data/${b.id}.png`, data: png(b.id) })),
        ]);
        const oraDoc = await readOra(oraFile, { inflateRaw });
        check("every blend mode in ORA comes back", JSON.stringify(oraDoc.layers.map((l) => l.blend)) === JSON.stringify(BLENDS.map((b) => b.id)), short(oraDoc.layers.map((l) => l.blend)));

        console.log("\n--- K20c: readOraBlob (the same answers as readOra, from slices of the file) ---");
        const text = (u) => Buffer.from(u).toString("latin1");
        const xml2 = `<image w="8" h="8"><stack><layer name="a" src="a.png" /><layer name="b" src="b.png" /></stack></image>`;
        const two = () => [{ name: "mimetype", data: "image/openraster" }, { name: "stack.xml", data: xml2 }, { name: "a.png", data: png("aa") }, { name: "b.png", data: png("bb"), deflate: true }, { name: "z.txt", data: "unused" }];
        const plain = zip(two());
        // the local header's own extra field and the directory's extra and comment move every offset after them
        const fieldy = await readOra(zip(two().map((e, i) => ({ ...e, localExtra: Buffer.alloc(3 + i, 0x41), dirExtra: Buffer.alloc(i, 0x42), dirComment: Buffer.alloc(2 * i, 0x43) }))), { inflateRaw });
        check("extra fields in the local headers and the directory: both pictures found", fieldy.layers.length === 2 && text(fieldy.layers[0].png).endsWith("bb") && text(fieldy.layers[1].png).endsWith("aa"), short(fieldy.layers.map((l) => text(l.png))));
        // the end record: the same 65,557 bytes searched
        const commented = await readOra(zip(two(), { comment: Buffer.alloc(65535, 0x20) }), { inflateRaw });
        check("the longest comment a zip can have: the end record is found, 65,557 bytes from the end", commented.layers.length === 2);
        const tooFar = await throwsWith(() => readOra(zip(two(), { after: Buffer.alloc(65536, 0x20) }), { inflateRaw }), /not a complete zip/);
        check("an end record one byte further from the end than that is not looked for", tooFar.ok, tooFar.msg);
        const noEnd = await throwsWith(() => readOra(new Uint8Array(10), { inflateRaw }), /not a complete zip/);
        check("a file too short for an end record is no zip", noEnd.ok, noEnd.msg);
        // the record count decides, the end record's byte count is not read (a wrong one opens today)
        const lied = await readOra(endField(plain, 12, 4, 7), { inflateRaw });
        check("a wrong directory byte count in the end record changes nothing", lied.layers.length === 2);
        const farDir = await throwsWith(() => readOra(endField(plain, 16, 4, plain.length + 1000), { inflateRaw }), /./);
        check("a directory said to lie past the file is refused", farDir.ok, farDir.msg);
        const noDir = await throwsWith(() => readOra(endField(plain, 16, 4, 0), { inflateRaw }), /zip directory is damaged/);
        check("a directory said to lie where none is is refused", noDir.ok, noDir.msg);
        // a local header has to lie inside the file, the header of an entry nothing asks for too
        const past = await throwsWith(() => readOra(dirField(plain, 4, 42, 4, plain.length - 29), { inflateRaw }), /zip directory is damaged/);
        check("a local header one byte past the file's end is refused, for an unused entry too", past.ok, past.msg);
        const edge = await readOra(dirField(plain, 4, 42, 4, plain.length - 30), { inflateRaw });
        check("a local header that just fits is read", edge.layers.length === 2);
        // Blob.slice clamps as subarray does: an entry said to be longer ends at the file
        const lastPng = zip([two()[0], two()[1], { name: "a.png", data: png("aa") }, { name: "b.png", data: png("bb") }]);
        const over = await readOra(dirField(lastPng, 3, 20, 4, 0x7fffffff), { inflateRaw });
        check("a stored entry said to run past the file ends at the file", text(over.layers[0].png).includes("bb") && over.layers[0].png.length > 10, short(over.layers[0].png.length));
        const localNames = withField(lastPng, Buffer.from(lastPng.buffer, lastPng.byteOffset, lastPng.length).readUInt32LE(dirAt(lastPng, 3) + 42) + 26, 2, 0xffff);
        const nothing = await readOra(localNames, { inflateRaw });
        check("a local header whose name runs past the file gives no bytes for that entry", nothing.layers[0].png.length === 0 && nothing.layers[1].png.length > 0, short(nothing.layers.map((l) => l.png.length)));
        const odd2 = await throwsWith(() => readOra(dirField(plain, 2, 10, 2, 12), { inflateRaw }), /unknown zip method 12 for a\.png/);
        check("an unknown zip method is refused by name", odd2.ok, odd2.msg);
        const empty = await readOra(zip([two()[0], two()[1], { name: "a.png", data: "" }, { name: "b.png", data: png("bb") }]), { inflateRaw });
        check("an empty stored picture stays a layer of no bytes (the decoder refuses it later)", empty.layers.length === 2 && empty.layers[1].png.length === 0);

        // what is read: a Blob that counts the bytes read, in file offsets
        const spy = (blob, base, reads) => ({
            size: blob.size,
            type: blob.type,
            slice(a = 0, b = blob.size, t = "") { const s = Math.min(blob.size, a), e = Math.max(s, Math.min(blob.size, b)); return spy(blob.slice(a, b, t), base + s, reads); },
            async arrayBuffer() { reads.push([base, base + blob.size]); return blob.arrayBuffer(); },
        });
        const wide = (seed) => crypto.createHash("sha256").update(seed).digest().toString("latin1").repeat(7000);
        const stored = [
            { name: "mimetype", data: "image/openraster" },
            { name: "mergedimage.png", data: Buffer.from(wide("m"), "latin1") },
            { name: "data/a.png", data: Buffer.concat([png("aa"), Buffer.from(wide("a"), "latin1")]) },
            { name: "data/b.png", data: Buffer.concat([png("bb"), Buffer.from(wide("b"), "latin1")]) },
            { name: "stack.xml", data: `<image w="8" h="8"><stack><layer name="a" src="data/a.png" /><layer name="b" src="data/b.png" /></stack></image>` },
            { name: "Thumbnails/thumbnail.png", data: Buffer.from(wide("t"), "latin1") },
            { name: "stuffing", data: Buffer.alloc(70000, 0x20) },
        ];
        const big = zip(stored);
        const rangeOf = (name) => {   // [first byte of the entry's data, end], from the same field arithmetic the test's zip() wrote
            let at = 0;
            for (const e of stored) {
                const head = 30 + Buffer.byteLength(e.name), len = Buffer.byteLength(e.data);
                if (e.name === name) return [at + head, at + head + len];
                at += head + len;
            }
            throw new Error(name);
        };
        const overlaps = (reads, [a, b]) => reads.filter(([x, y]) => y > a && x < b);
        const reads = [];
        let readsAtHeader = -1;
        const blobDoc = await mod.readOraBlob(spy(new Blob([big]), 0, reads), { inflateRaw, onHeader: () => { readsAtHeader = reads.length; } });
        const merged = overlaps(reads, rangeOf("mergedimage.png")), thumb = overlaps(reads, rangeOf("Thumbnails/thumbnail.png"));
        check("mergedimage.png and the thumbnail are not read", merged.length === 0 && thumb.length === 0, short({ merged, thumb }));
        const layerA = overlaps(reads, rangeOf("data/a.png")), layerB = overlaps(reads, rangeOf("data/b.png"));
        check("of each stored layer 24 bytes are read, the rest of the file is left alone", layerA.length === 1 && layerB.length === 1 && layerA[0][1] - layerA[0][0] === 24 && layerB[0][1] - layerB[0][0] === 24 && layerA[0][0] === rangeOf("data/a.png")[0], short({ layerA, layerB }));
        const total = reads.reduce((n, [x, y]) => n + y - x, 0);
        check("in all the tail, the directory, stack.xml and the layers' headers: far less than the file", total < 200 * 1024 && big.length > 600 * 1024, `${total} of ${big.length} bytes`);
        check("onHeader comes after stack.xml and before any layer is read", readsAtHeader > 0 && overlaps(reads.slice(0, readsAtHeader), rangeOf("data/a.png")).length === 0 && overlaps(reads.slice(0, readsAtHeader), rangeOf("data/b.png")).length === 0, short({ readsAtHeader }));
        const stopped = [];
        const stopDoc = await throwsWith(() => mod.readOraBlob(spy(new Blob([big]), 0, stopped), { inflateRaw, onHeader: () => { throw new Error("size refused"); } }), /size refused/);
        check("a throw in onHeader reads no layer", stopDoc.ok && overlaps(stopped, rangeOf("data/a.png")).length === 0, stopDoc.msg);
        check("a stored layer comes back as a slice of the file, its bytes untouched", blobDoc.layers.length === 2 && blobDoc.layers[0].png === undefined && blobDoc.layers[0].pngBlob.size === rangeOf("data/b.png")[1] - rangeOf("data/b.png")[0], short(blobDoc.layers[0].pngBlob.size));
        // one entry named by many layers is one header read
        const again = [];
        const dup = zip([{ name: "mimetype", data: "image/openraster" }, { name: "stack.xml", data: `<image w="8" h="8"><stack>${`<layer name="x" src="a.png" />`.repeat(50)}</stack></image>` }, { name: "a.png", data: png("aa") }]);
        await mod.readOraBlob(spy(new Blob([dup]), 0, again), { inflateRaw });
        check("a picture that many layers name is read once (the tail, the directory, stack.xml and its header, the picture's header and its 24 bytes)", again.length === 6, short(again.length));
    }

    console.log("\n--- PSD writers: layer masks (PsdWriter, PsdBandWriter) ---");
    await writerChecks(readPsd);

    console.log("\n--- D0: the worker's reader (readPsdStream) beside readPsd ---");
    for (const [name, bytes] of Object.entries(bandFixtures())) {
        const d = await readPsd(bytes, { inflate });
        check(`${name} reads (${d.layers.length} layers, ${d.width} x ${d.height}), through both readers`, name === "deep.psd" ? d.layers.length === 3 && d.layers[1].mask && d.layers[2].clip : !d.layers.length && !!d.composite);
    }
    {
        // the cases the mutation round of D0 asked for: a record with a rectangle but no colour channel (left out as
        // empty, never sent); an empty layer over a merged picture (no "no layer has pixels" note: the merged picture is
        // the stream's index 0); a grayscale flat file
        const W = 4, H = 3, plane = (v) => fill(W * H, (i) => (v + i * 17) & 255);
        const alphaOnly = await readPsd(psd({ width: W, height: H, layers: [{ name: "alpha only", top: 0, left: 0, w: W, h: H, ch: { "-1": plane(9) } }, { name: "real", top: 0, left: 0, w: W, h: H, ch: { 0: plane(1), 1: plane(2), 2: plane(3) } }] }));
        check("a record with a rectangle and no colour channel is left out as empty", alphaOnly.layers.length === 1 && alphaOnly.layers[0].name === "real", short(alphaOnly.layers.map((l) => l.name)));
        const emptyOver = await readPsd(psd({ width: W, height: H, layers: [{ name: "nothing", top: 0, left: 0, w: 0, h: 0, ch: {} }], merged: [plane(4), plane(5), plane(6)] }));
        check("an empty layer over a merged picture: the picture, no loss", !emptyOver.layers.length && !!emptyOver.composite && !emptyOver.lossy && !emptyOver.notes.length, short(emptyOver.notes));
        const grayFlat = await readPsd(psd({ width: W, height: H, mode: 1, merged: [plane(7)] }));
        check("a grayscale flat file: gray replicated, opaque", !!grayFlat.composite && grayFlat.composite[4] === plane(7)[1] && grayFlat.composite[5] === plane(7)[1] && grayFlat.composite[6] === plane(7)[1] && grayFlat.composite[7] === 255, short(Array.from(grayFlat.composite || []).slice(0, 8)));

        // K20b: [-2, -1, 0, 1, 2] channel order (mask & alpha before colour), missing green channel [0, 2],
        // dangling PackBits repeat byte > 128 at end - 1, and truncated raw (comp 0) merged picture beside layers vs flat
        const maskBefore = { top: 0, left: 0, w: W, h: H, def: 0, data: plane(11) };
        const reordered = await readPsd(psd({
            width: W, height: H,
            layers: [{
                name: "mask-first", top: 0, left: 0, w: W, h: H, mask: maskBefore,
                blocks: [
                    [-2, channelData(maskBefore.data, W, H, 8, 1)],
                    [-1, channelData(plane(99), W, H, 8, 1)],
                    [0, channelData(plane(1), W, H, 8, 1)],
                    [1, channelData(plane(2), W, H, 8, 1)],
                    [2, channelData(plane(3), W, H, 8, 1)],
                ],
            }],
        }));
        check("K20b: channel order [-2, -1, 0, 1, 2] keeps mask, alpha and RGB alike", reordered.layers.length === 1 && reordered.layers[0].rgba[0] === plane(1)[0] && reordered.layers[0].rgba[3] === plane(99)[0] && equalBytes(reordered.layers[0].mask.data, maskBefore.data));

        const missingGreen = await readPsd(psd({
            width: W, height: H,
            layers: [{ name: "no-green", top: 0, left: 0, w: W, h: H, ch: { 0: plane(21), 2: plane(23) } }],
        }));
        check("K20b: missing green channel fills 0 and missing alpha fills 255", missingGreen.layers[0].rgba[0] === plane(21)[0] && missingGreen.layers[0].rgba[1] === 0 && missingGreen.layers[0].rgba[2] === plane(23)[0] && missingGreen.layers[0].rgba[3] === 255);

        // Dangling PackBits repeat byte (254) at end - 1 of row 0 must zero-fill row 0 without consuming row 1's first byte.
        // Row 1 starts with the literal header 1 (two bytes 0xAB 0xCD follow), not 0: a reader that takes the repeat's
        // value from the next row fills row 0's tail with 1, which this check sees (K20b review K20b-T2; the window's
        // unpackRows `p < lim`, the stream's packbitsRows twin and the Rust packbits_rows).
        const badPbBlock = new B().u16(1).u16(3).u16(3).bytes([0, 0x55, 254, 1, 0xAB, 0xCD]).out();
        const danglingPb = await readPsd(psd({
            width: 4, height: 2,
            layers: [{
                name: "dangling-rle", top: 0, left: 0, w: 4, h: 2,
                blocks: [[0, badPbBlock], [1, channelData(fill(8, () => 9), 4, 2, 8, 0)], [2, channelData(fill(8, () => 7), 4, 2, 8, 0)]],
            }],
        }));
        const dRed = danglingPb.layers.length === 1 ? Array.from({ length: 8 }, (_, i) => danglingPb.layers[0].rgba[i * 4]) : [];
        check("K20b: dangling PackBits repeat byte > 128 at end - 1 zero-fills without reading into row 1",
            dRed.join(",") === [0x55, 0, 0, 0, 0xAB, 0xCD, 0, 0].join(","), `red ${dRed.join(",")}`);

        const rawMergedLayers = psd({ width: 8, height: 8, mergedComp: 0, layers: [{ name: "kept", top: 0, left: 0, w: 4, h: 4, ch: { 0: fill(16, (i) => i), 1: fill(16, () => 2), 2: fill(16, () => 3) } }] });
        const rawMergedLayersCut = await readPsd(rawMergedLayers.subarray(0, rawMergedLayers.length - 10));
        check("K20b: truncated raw merged picture beside layers keeps the layers (composite null)", rawMergedLayersCut.layers.length === 1 && rawMergedLayersCut.composite === null);
        // read directly (an unexpected throw fails the test) and the document asserted (K20b review: it asserted nothing)
        const rawMergedFlat = psd({ width: 8, height: 8, mergedComp: 0, layers: [] });
        const rawMergedFlatCut = await readPsd(rawMergedFlat.subarray(0, rawMergedFlat.length - 10));
        check("K20b: truncated raw merged picture on a flat PSD is neglected (no layers, composite null)",
            rawMergedFlatCut.layers.length === 0 && rawMergedFlatCut.composite === null, `layers ${rawMergedFlatCut.layers.length}, composite ${rawMergedFlatCut.composite === null ? "null" : "set"}`);

        // K20b review (K20b-D1, two mutants that survived): the upfront refusals of the channel checks, each on a file only
        // that check refuses. Rows that claim more bytes than their channel holds, inside the file (a reader without
        // `2 * h + total > dataLen` takes the next channels' bytes for them); a ZIP channel too small for its size even at
        // deflate's best ratio (a reader without `DEFLATE_MAX_RATIO` zero-fills what the stream did not give). A stream
        // reader that opens either file differs from readPsd, which twinned() reports.
        const rowsPastBlock = new B().u16(1).u16(6).u16(6).bytes([0, 1, 0, 2]).out();
        const rowsPast = await throwsWith(() => readPsd(psd({
            width: 4, height: 2,
            layers: [{
                name: "rows-past", top: 0, left: 0, w: 4, h: 2,
                blocks: [[0, rowsPastBlock], [1, channelData(fill(8, () => 9), 4, 2, 8, 0)], [2, channelData(fill(8, () => 7), 4, 2, 8, 0)]],
            }],
        })), /holds less data than its/);
        check("K20b: RLE rows that claim more than their channel holds are refused, not read from the next channel", rowsPast.ok, rowsPast.msg);
        const tinyZip = new B().u16(2).bytes(zlib.deflateSync(Buffer.alloc(8))).out();
        const zipRatio = await throwsWith(() => readPsd(psd({
            width: 200, height: 200,
            layers: [{ name: "zip-ratio", top: 0, left: 0, w: 200, h: 200, blocks: [[0, tinyZip], [1, tinyZip], [2, tinyZip]] }],
        }), { inflate }), /holds less data than its/);
        check(`K20b: a ZIP channel of ${tinyZip.length - 2} bytes for 40,000 is refused by the deflate ratio, not zero-filled`,
            zipRatio.ok && (200 * 200) > (tinyZip.length - 2) * 1032, zipRatio.msg);
    }
    console.log("\n--- H1 S5: crafted files are refused before they grow; valid files read as before ---");
    {
        const { inflateAtMost } = mod;
        const capped = (b, cap) => inflateAtMost(b, "deflate", cap), cappedRaw = (b, cap) => inflateAtMost(b, "deflate-raw", cap);
        // the inflater both readers use: the whole inflate within its cap, zlib's bytes; a byte past it refused
        const mixed = Buffer.concat([crypto.randomBytes(300000), Buffer.alloc(500000, 7), crypto.randomBytes(77)]);
        const z = zlib.deflateSync(mixed), zr = zlib.deflateRawSync(mixed);
        const whole = await inflateAtMost(z, "deflate"), exact = await inflateAtMost(zr, "deflate-raw", mixed.length);
        check("inflateAtMost: zlib's bytes, zlib and raw, with no cap and with the cap at the size", equalBytes(whole, mixed) && equalBytes(exact, mixed), `${whole.length} / ${exact.length} of ${mixed.length}`);
        let over = null;
        try { await inflateAtMost(z, "deflate", mixed.length - 1); } catch (err) { over = err; }
        check("a cap one byte short is refused (.tooLarge)", over && over.tooLarge && /unpacks to more than 800,076 bytes/.test(over.message), over && over.message);
        const cut = await throwsWith(() => inflateAtMost(z.subarray(0, z.length - 9), "deflate", Infinity), /./);
        const bad = Buffer.from(z); bad[bad.length - 1] ^= 1;
        const sum = await throwsWith(() => inflateAtMost(bad, "deflate", mixed.length), /./);
        check("a cut stream and a wrong checksum still fail as a whole inflate does (the end is read within the cap)", cut.ok && sum.ok && !/unpacks to more/.test(cut.msg + sum.msg), `${cut.msg} / ${sum.msg}`);
        const bomb = zlib.deflateSync(Buffer.alloc(256 * 1048576));
        let t = performance.now(), ab0 = process.memoryUsage().arrayBuffers, b2 = null;
        try { await inflateAtMost(bomb, "deflate", 1048576); } catch (err) { b2 = err; }
        const bombMs = performance.now() - t, grew = (process.memoryUsage().arrayBuffers - ab0) / 1048576;
        check(`a bomb of 256 MB (${Math.round(bomb.length / 1024)} KB) with a cap of 1 MB stops there: ${bombMs.toFixed(0)} ms, ${grew.toFixed(0)} MB of buffers more`, b2 && b2.tooLarge && bombMs < 1500 && grew < 100, b2 && b2.message);

        // valid ZIP files: the same layers through the capped inflater as through zlib (8 and 16 bit, prediction, a mask)
        const W = 37, H = 19, ramp = fill(W * H, (i) => (i * 13 + 5) % 256), r16 = fill(W * H, (i) => (i * 3001) % 65536);
        const zips = [
            psd({ width: W, height: H, layers: [{ name: "z", top: 1, left: 2, w: W, h: H, comp: 2, ch: { 0: ramp, 1: ramp.map((v) => 255 - v), 2: ramp, "-1": fill(W * H, (i) => (i % 5) * 60) } }] }),
            psd({ width: W, height: H, layers: [{ name: "zp", top: 0, left: 0, w: W, h: H, comp: 3, ch: { 0: ramp, 1: ramp, 2: ramp, "-2": fill(10 * 6, (i) => i * 4) }, mask: { top: 2, left: 3, w: 10, h: 6, def: 255 } }] }),
            psd({ width: W, height: H, depth: 16, layers: [{ name: "z16", top: 0, left: 0, w: W, h: H, comp: 3, ch: { 0: r16, 1: r16, 2: r16, "-1": fill(W * H, () => 65535) } }] }),
            ...Object.values(bandFixtures()),
        ];
        let same = 0;
        const diffs = [];
        for (const f of zips) {
            const a = await readPsd(f, { inflate }), b = await readPsd(f, { inflate: capped });
            const key = (d) => JSON.stringify({ w: d.width, h: d.height, notes: d.notes, layers: d.layers.map((l) => ({ ...l, rgba: crypto.createHash("sha256").update(l.rgba).digest("hex"), mask: l.mask ? { ...l.mask, data: crypto.createHash("sha256").update(l.mask.data).digest("hex") } : null })), c: d.composite ? crypto.createHash("sha256").update(d.composite).digest("hex") : null });
            if (key(a) === key(b)) same++; else diffs.push(key(b).slice(0, 200));
        }
        check(`${zips.length} valid ZIP-channel PSDs read the same through the capped inflater as through zlib`, same === zips.length, diffs.join(" | "));
        const oraFile = zip([{ name: "mimetype", data: "image/openraster" }, { name: "stack.xml", data: `<image w="4" h="4"><stack><layer name="a" src="a.png" /></stack></image>`, deflate: true }, { name: "a.png", data: crypto.randomBytes(5000), deflate: true }]);
        const o1 = await readOra(oraFile, { inflateRaw }), o2 = await readOra(oraFile, { inflateRaw: cappedRaw });
        check("a valid ORA with deflated entries reads the same through it", equalBytes(o1.layers[0].png, o2.layers[0].png) && JSON.stringify(o1.notes) === JSON.stringify(o2.notes));

        // the crafted files: each refused with its words, at once, before its planes are made
        for (const [name, f] of Object.entries(craftedFixtures(64))) {
            const ora = name.endsWith(".ora");
            t = performance.now();
            ab0 = process.memoryUsage().arrayBuffers;
            const res = await throwsWith(() => (ora ? readOra(f.bytes, { inflateRaw: cappedRaw }) : readPsd(f.bytes, { inflate: capped })), f.re);
            const ms = performance.now() - t, more = (process.memoryUsage().arrayBuffers - ab0) / 1048576;
            check(`${name} (${Math.max(1, Math.round(f.bytes.length / 1024))} KB) is refused in ${ms.toFixed(0)} ms with ${more.toFixed(0)} MB of buffers more`, res.ok && ms < 2000 && more < 100, res.msg);
        }
        // a test's inflater that ignores the cap is held to it as well (the bomb's channel and entry)
        const crafted = craftedFixtures(64);
        const loose = await throwsWith(() => readPsd(crafted["crafted_zip_bomb.psd"].bytes, { inflate }), crafted["crafted_zip_bomb.psd"].re);
        const looseOra = await throwsWith(() => readOra(crafted["crafted_bomb.ora"].bytes, { inflateRaw }), crafted["crafted_bomb.ora"].re);
        check("an inflater that ignores the cap is held to it: the same refusals", loose.ok && looseOra.ok, `${loose.msg} / ${looseOra.msg}`);

        // a merged picture too short for its size beside layers: the layers open (the merged picture is not shown then)
        const W2 = 8, H2 = 8, lay = { name: "kept", top: 0, left: 0, w: W2, h: H2, ch: { 0: fill(64, (i) => i), 1: fill(64, (i) => i), 2: fill(64, (i) => i) } };
        const withLayers = psd({ width: 16, height: 16, layers: [lay], merged: [fill(256, () => 0), fill(256, () => 0), fill(256, () => 0)] });
        // the merged rows' table sits after the layer section: zero it, so the rows cannot fill the picture
        const zeroed = withLayers.slice(), at = zeroed.length - (3 * 16 * 2 + 3 * 16 * 2);   // 48 row lengths, then 48 rows of 2 bytes
        for (let i = at; i < at + 96; i++) zeroed[i] = 0;
        const kept = await readPsd(zeroed, {});
        check("a merged picture too short beside layers: the layers open, no merged picture", kept.layers.length === 1 && kept.layers[0].name === "kept" && kept.composite === null, short({ layers: kept.layers.length, composite: !!kept.composite }));

        // onHeader: the caller's size check before anything else is read or made
        const seen = [];
        const okDoc = await mod.readPsd(zips[0], { inflate, onHeader: (h) => seen.push(h) });
        const big = new B().ascii("8BPS").u16(1).bytes([0, 0, 0, 0, 0, 0]).u16(3).u32(40000).u32(40000).u16(8).u16(3).out();
        const stop = await throwsWith(() => mod.readPsd(big, { onHeader: (h) => { if (h.width * h.height > 268435456) throw new Error(`${h.width} x ${h.height} too large`); } }), /40000 x 40000 too large/);
        const oraSeen = [];
        await readOra(oraFile, { inflateRaw, onHeader: (h) => oraSeen.push(h) });
        const oraStop = await throwsWith(() => readOra(crafted["crafted_bomb.ora"].bytes, { inflateRaw, onHeader: () => { throw new Error("size refused"); } }), /size refused/);
        check("readPsd and readOra call onHeader once with the size, before the layers (a throw there stops the read before the file ends early)",
            seen.length === 1 && seen[0].width === W && seen[0].height === H && seen[0].depth === 8 && okDoc.layers.length === 1 && stop.ok
            && oraSeen.length === 1 && oraSeen[0].width === 4 && oraSeen[0].height === 4 && oraStop.ok, `${short(seen)} ${stop.msg} ${short(oraSeen)} ${oraStop.msg}`);
    }

    check(`readOraBlob answers as readOra on all ${ORA_TWIN.files} ORAs read above (${ORA_TWIN.refusals} of them refused)`, ORA_TWIN.files >= 25 && ORA_TWIN.refusals >= 12 && ORA_TWIN.fails.length === 0, ORA_TWIN.fails.length ? ORA_TWIN.fails.slice(0, 4).join(" | ") : `${ORA_TWIN.files} files`);
    check(`readPsdStream (PSD_JS, px.wasm, px_scalar.wasm) answers as readPsd on all ${TWIN.files} PSDs read above (${TWIN.refusals} of them refused), in bands of 3 rows and of 256`, TWIN.files >= 40 && TWIN.refusals >= 5 && TWIN.fails.length === 0, TWIN.fails.length ? TWIN.fails.slice(0, 4).join(" | ") : `${TWIN.files} files x 3 kernel builds x 2 band sizes`);

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); console.log("FAIL"); process.exit(1); });
