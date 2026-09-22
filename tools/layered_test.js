// Reading PSD and ORA files (renderer/editor/inpaint_layered.js), in plain Node, no Electron:
//   node tools/layered_test.js
// The files are built here, byte by byte after Adobe's file format specification and the OpenRaster spec, so every
// case the reader claims to handle has a file of its own: RLE, raw, ZIP and ZIP with prediction; 8 and 16 bit; RGB
// and grayscale; a Unicode name; hidden, opacity, blend modes known and unknown; a group (its divider and folder
// record) that is hidden or half transparent, nested; a layer mask (inside and outside its rectangle, disabled); an
// adjustment layer; a clipping mask; an empty layer; a flat file (the merged picture only); the refusals (PSB,
// CMYK, 32 bit, a truncated file). ORA: stored and deflated entries, nested stacks with offsets, visibility,
// opacity, composite-op, a layer without its picture. The app side (open, drop, the round trip through the editor's
// own writers) is tools/layered_test.py.
"use strict";

const zlib = require("node:zlib");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

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
 * flags, clipping, mask: { top, left, w, h, def, flags, data }, info: { key: bytes }, section, comp }.
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
            const [w, h] = id === -2 ? [L.mask.w, L.mask.h] : [L.w, L.h];
            return [id, channelData(L.ch[id], w, h, depth, L.comp ?? 1)];
        });
        rec.i32(L.top).i32(L.left).i32(L.top + L.h).i32(L.left + L.w).u16(blocks.length);
        for (const [id, d] of blocks) rec.i16(id).u32(d.length);
        rec.ascii("8BIM").ascii(L.blend || "norm").u8(L.opacity ?? 255).u8(L.clipping || 0).u8(L.flags || 0).u8(0);
        const extra = new B();
        if (L.mask) extra.u32(20).i32(L.mask.top).i32(L.mask.left).i32(L.mask.top + L.mask.h).i32(L.mask.left + L.mask.w).u8(L.mask.def).u8(L.mask.flags || 0).u16(0);
        else extra.u32(0);
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
const px = (doc, li, x, y) => { const L = doc.layers[li]; const o = (y * L.w + x) * 4; return Array.from(L.rgba.slice(o, o + 4)); };
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
    const fs = require("node:fs");
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

(async () => {
    const at = process.argv.indexOf("--write-fixtures");
    if (at > 0) { writeFixtures(process.argv[at + 1]); return; }
    const mod = await import(pathToFileURL(path.join(__dirname, "..", "renderer", "editor", "inpaint_layered.js")).href);
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
        const L = doc.layers[1];
        check("the Unicode name wins over the Pascal one", L.name === "Ebene äöü ✓");
        check("position, size, blend and opacity", L.x === 3 && L.y === 2 && L.w === 4 && L.h === 3 && L.blend === "multiply" && Math.abs(L.opacity - 128 / 255) < 1e-9, short({ x: L.x, y: L.y, w: L.w, h: L.h, blend: L.blend, opacity: L.opacity }));
        check("a hidden layer (flag 2) is hidden, a negative offset kept", doc.layers[2].visible === false && doc.layers[2].x === -1 && doc.layers[2].y === -2 && doc.layers[1].visible === true);
        check("an unknown blend mode becomes normal and is named", doc.layers[3].blend === "normal" && doc.notes.some((n) => /blend modes.*odd blend \(vLit\)/.test(n)), short(doc.notes));
        check("a clipping mask is named", doc.notes.some((n) => /clipping masks.*"clipped"/.test(n)), short(doc.notes));
        check("adjustment layers are named, with and without pixels", doc.notes.some((n) => /2 adjustment or fill layers left out \("Levels 1", "Curves over pixels"\)/.test(n)), short(doc.notes));
        check("the merged picture is read", doc.composite && doc.composite.length === W * H * 4 && doc.composite[3] === 255);
        const every = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "soft-light", "hard-light", "difference"];
        const keys = ["norm", "mul ", "scrn", "over", "dark", "lite", "sLit", "hLit", "diff"];
        const bd = await readPsd(psd({ width: 2, height: 2, layers: keys.map((k) => ({ name: k, top: 0, left: 0, w: 1, h: 1, ch: solid(1, 1, 1, 1, 1), blend: k })) }));
        check("every blend mode the editor writes comes back", JSON.stringify(bd.layers.map((l) => l.blend)) === JSON.stringify(every), short(bd.layers.map((l) => l.blend)));
    }

    console.log("\n--- PSD: masks and groups ---");
    {
        const W = 6, H = 6;
        const solid = (w, h) => ({ 0: fill(w * h, () => 100), 1: fill(w * h, () => 100), 2: fill(w * h, () => 100), "-1": fill(w * h, () => 200) });
        // a mask covering columns 1..2 of the layer (x 1..2), 0 at x 1, 255 at x 2, default 0 outside
        const mask = { top: 0, left: 1, w: 2, h: H, def: 0, data: fill(2 * H, (i) => (i % 2 ? 255 : 0)) };
        const masked = { name: "masked", top: 0, left: 0, w: W, h: H, ch: { ...solid(W, H), "-2": mask.data }, mask };
        const d = await readPsd(psd({ width: W, height: H, layers: [masked] }));
        const a = (x) => d.layers[0].rgba[(2 * W + x) * 4 + 3];
        check("a mask multiplies alpha inside its rectangle and uses its default outside", a(0) === 0 && a(1) === 0 && a(2) === 200 && a(3) === 0, `${a(0)} ${a(1)} ${a(2)} ${a(3)}`);
        check("an applied mask is named", d.notes.some((n) => /1 layer mask applied/.test(n)));
        const white = { ...masked, mask: { ...mask, def: 255 } };
        const dw = await readPsd(psd({ width: W, height: H, layers: [white] }));
        check("a mask with default white keeps what lies outside it", dw.layers[0].rgba[(2 * W + 4) * 4 + 3] === 200);
        const off = { ...masked, mask: { ...mask, flags: 2 } };
        const doff = await readPsd(psd({ width: W, height: H, layers: [off] }));
        check("a disabled mask is not applied", doff.layers[0].rgba[(2 * W + 0) * 4 + 3] === 200 && !doff.notes.some((n) => /mask/.test(n)));
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

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); console.log("FAIL"); process.exit(1); });
