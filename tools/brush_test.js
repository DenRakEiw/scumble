// The .abr reader without Electron: synthetic files of every version this reader knows
// (1, 2, 6.1, 6.2 with a desc block), written here so nothing copyrighted is stored, plus the
// real Photoshop packs on this machine when they exist (reported, never required).
//
//     node tools/brush_test.js [outdir]     # writes synthetic_v6.abr into outdir for brush_test.py
//
// Checks: tip counts, names, spacing (v1 / v2 from the header, v6 from the desc block by
// UUID), computed tips counted and skipped, PackBits rows, alpha polarity (the stored value
// is the coverage), dual-brush tips named after their preset, and that the descriptor parser
// consumes the desc block to its last byte.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// ---- byte writers ------------------------------------------------------------------------------
class W {
    constructor() { this.parts = []; }
    u8(v) { this.parts.push(Buffer.from([v & 255])); return this; }
    u16(v) { const b = Buffer.alloc(2); b.writeUInt16BE(v); this.parts.push(b); return this; }
    u32(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); this.parts.push(b); return this; }
    f64(v) { const b = Buffer.alloc(8); b.writeDoubleBE(v); this.parts.push(b); return this; }
    tag(s) { this.parts.push(Buffer.from(s.padEnd(4).slice(0, 4), "latin1")); return this; }
    raw(b) { this.parts.push(Buffer.from(b)); return this; }
    pstr(s) { this.u8(s.length); this.parts.push(Buffer.from(s, "latin1")); return this; }
    ustr(s) { this.u32(s.length + 1); for (const ch of s) this.u16(ch.charCodeAt(0)); this.u16(0); return this; }
    key(s) { if (s.length === 4) { this.u32(0); this.tag(s); } else { this.u32(s.length); this.parts.push(Buffer.from(s, "latin1")); } return this; }
    pad(n) { const len = this.length; if (len % n) this.parts.push(Buffer.alloc(n - (len % n))); return this; }
    get length() { return this.parts.reduce((a, b) => a + b.length, 0); }
    bytes() { return Buffer.concat(this.parts); }
}

/** A tip bitmap: a ring (coverage 255 in a band, 0 elsewhere), a bar, or a gradient row. */
function ring(w, h) { const d = new Uint8Array(w * h); const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const dd = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r; d[y * w + x] = dd > 0.55 && dd < 0.95 ? 255 : 0; } return d; }
function bar(w, h) { const d = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = x < w / 2 ? 255 : 0; return d; }
function gradient(w, h) { const d = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = Math.round(255 * x / (w - 1)); return d; }

/** PackBits, per row: row lengths first, then the runs (a literal chunk per row here, plus one repeat run to exercise both). */
function packRows(data, w, h) {
    const rows = [];
    for (let y = 0; y < h; y++) {
        const row = data.subarray(y * w, (y + 1) * w);
        const out = new W();
        let x = 0;
        while (x < w) {
            let run = 1;
            while (x + run < w && run < 128 && row[x + run] === row[x]) run++;
            if (run >= 2) { out.u8(256 - (run - 1)); out.u8(row[x]); x += run; }
            else { let lit = 1; while (x + lit < w && lit < 128 && !(x + lit + 1 < w && row[x + lit] === row[x + lit + 1])) lit++; out.u8(lit - 1); out.raw(row.subarray(x, x + lit)); x += lit; }
        }
        rows.push(out.bytes());
    }
    const out = new W();
    for (const r of rows) out.u16(r.length);
    for (const r of rows) out.raw(r);
    return out.bytes();
}

// ---- version 1 / 2 ------------------------------------------------------------------------------
function v1Brush(version, { name, w, h, data, spacing, compressed }) {
    const b = new W();
    b.u16(2).u32(0).u16(spacing);
    if (version === 2) b.ustr(name);
    b.u8(1).u16(0).u16(0).u16(h).u16(w).u32(0).u32(0).u32(h).u32(w).u16(8).u8(compressed ? 1 : 0);
    b.raw(compressed ? packRows(data, w, h) : data);
    return b.bytes();
}
function v1Computed() { const b = new W(); b.u16(1).u32(0).u16(25).u8(1).u16(30).u16(50).u16(100).u16(0); return b.bytes(); }
function makeV1(version) {
    const brushes = [
        v1Brush(version, { name: "Ring", w: 32, h: 32, data: ring(32, 32), spacing: 30, compressed: true }),
        v1Computed(),
        v1Brush(version, { name: "Bar", w: 24, h: 12, data: bar(24, 12), spacing: 15, compressed: false }),
        v1Brush(version, { name: "Ramp", w: 16, h: 4, data: gradient(16, 4), spacing: 0, compressed: true }),
    ];
    const f = new W();
    f.u16(version).u16(brushes.length);
    for (const b of brushes) { f.u16(b.length).raw(b); }
    return f.bytes();
}

// ---- version 6 / 10: samp + desc -------------------------------------------------------------
function sampEntry(subversion, uuid, w, h, data, compressed) {
    const body = new W();
    body.pstr(uuid);
    body.raw(Buffer.alloc((subversion === 1 ? 47 : 301) - body.length));
    body.u32(0).u32(0).u32(h).u32(w).u16(8).u8(compressed ? 1 : 0);
    body.raw(compressed ? packRows(data, w, h) : data);
    const e = new W();
    e.u32(body.length).raw(body.bytes()).pad(4);
    return e.bytes();
}
function untf(w, unit, v) { w.tag("UntF").tag(unit).f64(v); }
function text(w, s) { w.tag("TEXT").ustr(s); }
function objc(w, cls, items) { w.tag("Objc"); w.ustr(""); w.key(cls); w.u32(items.length); for (const [k, fn] of items) { w.key(k); fn(w); } }
function brushObj(w, { uuid, diameter, spacing, angle = 0, roundness = 100, hardness }) {
    const items = [["Dmtr", (x) => untf(x, "#Pxl", diameter)], ["Angl", (x) => untf(x, "#Ang", angle)], ["Rndn", (x) => untf(x, "#Prc", roundness)], ["Spcn", (x) => untf(x, "#Prc", spacing)], ["Intr", (x) => { x.tag("bool").u8(1); }], ["flipX", (x) => { x.tag("bool").u8(0); }]];
    if (uuid) items.push(["sampledData", (x) => text(x, uuid)]);
    else items.push(["Hrdn", (x) => untf(x, "#Prc", hardness == null ? 100 : hardness)]);
    objc(w, uuid ? "sampledBrush" : "computedBrush", items);
}
function preset(w, name, brush, dual) {
    const items = [["Nm  ", (x) => text(x, `$$$/Presets/Brushes/${name.replace(/\W/g, "")}=${name}`)], ["Brsh", (x) => brushObj(x, brush)], ["useTipDynamics", (x) => { x.tag("bool").u8(0); }], ["Wtdg", (x) => { x.tag("doub").f64(1); }], ["Rpt ", (x) => { x.tag("long").u32(3); }],
        ["mode", (x) => { x.tag("enum").key("BlnM").key("Nrml"); }], ["Scl ", (x) => { x.tag("VlLs").u32(2); x.tag("doub").f64(0.5); x.tag("long").u32(7); }]];
    if (dual) items.push(["dualBrush", (x) => objc(x, "dualBrush", [["useDualBrush", (y) => { y.tag("bool").u8(1); }], ["Brsh", (y) => brushObj(y, dual)]])]);
    objc(w, "brushPreset", items);
}
function makeV6(subversion) {
    const U1 = "11111111-2222-3333-4444-555555555555", U2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", U3 = "99999999-8888-7777-6666-555555555555";
    const samp = new W();
    samp.raw(sampEntry(subversion, U1, 32, 32, ring(32, 32), true));
    samp.raw(sampEntry(subversion, U2, 24, 12, bar(24, 12), false));
    samp.raw(sampEntry(subversion, U3, 16, 4, gradient(16, 4), true));
    const desc = new W();
    desc.u32(16);
    desc.ustr(""); desc.key("null"); desc.u32(1); desc.key("Brsh");
    desc.tag("VlLs").u32(4);
    preset(desc, "Ring Brush", { uuid: U1, diameter: 48, spacing: 30 });
    preset(desc, "Soft Round", { uuid: null, diameter: 20, spacing: 25, hardness: 0 });
    preset(desc, "Bar Brush", { uuid: U2, diameter: 24, spacing: 15, angle: -90 }, { uuid: U3, diameter: 16, spacing: 50 });
    preset(desc, "Ring Again", { uuid: U1, diameter: 12, spacing: 5 });
    const f = new W();
    f.u16(6).u16(subversion);
    for (const [key, block] of [["samp", samp.bytes()], ["patt", Buffer.alloc(6)], ["desc", desc.bytes()]]) {
        f.tag("8BIM").tag(key).u32(block.length).raw(block).pad(4);
    }
    return f.bytes();
}

// ---- the checks -----------------------------------------------------------------------------------
async function main() {
    const { readAbr } = await import(pathToFileURL(path.join(__dirname, "..", "renderer", "editor", "inpaint_brushes.js")).href);
    const toAb = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    let failed = 0;
    const check = (name, fn) => { try { const r = fn(); console.log(`PASS ${name}: ${JSON.stringify(r)}`); } catch (err) { failed++; console.log(`FAIL ${name}: ${err.message || err}`); } };
    const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
    const ringData = ring(32, 32), barData = bar(24, 12), rampData = gradient(16, 4);
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

    for (const version of [1, 2]) {
        check(`v${version}`, () => {
            const r = readAbr(toAb(makeV1(version)));
            eq(r.version, version, "version"); eq(r.brushes.length, 3, "tips"); eq(r.computed, 1, "computed"); eq(r.presets, 4, "presets");
            const [a, b, c] = r.brushes;
            eq(`${a.width}x${a.height}`, "32x32", "ring size"); eq(a.spacing, 0.3, "ring spacing");
            if (!same(a.data, ringData)) throw new Error("ring bitmap (PackBits) differs");
            if (!same(b.data, barData)) throw new Error("bar bitmap (raw) differs");
            if (!same(c.data, rampData)) throw new Error("ramp bitmap differs");
            eq(b.data[0], 255, "polarity: the stored value is the coverage"); eq(b.data[23], 0, "polarity");
            eq(a.name, version === 2 ? "Ring" : "", "name");
            return { tips: r.brushes.map((t) => `${t.name || "?"} ${t.width}x${t.height} @${t.spacing}`) };
        });
    }
    for (const sub of [1, 2]) {
        check(`v6.${sub}`, () => {
            const r = readAbr(toAb(makeV6(sub)));
            eq(r.version, 6, "version"); eq(r.subversion, sub, "subversion"); eq(r.brushes.length, 3, "tips"); eq(r.computed, 1, "computed"); eq(r.presets, 4, "presets");
            eq(r.warnings.length, 0, "warnings " + JSON.stringify(r.warnings));
            const [a, b, c] = r.brushes;
            eq(a.name, "Ring Brush", "ring name"); eq(a.spacing, 0.3, "ring spacing"); eq(a.diameter, 48, "ring diameter"); eq(a.presets, 2, "ring is used by two presets");
            eq(b.name, "Bar Brush", "bar name"); eq(b.spacing, 0.15, "bar spacing"); eq(b.angle, -90, "bar angle");
            eq(c.name, "Bar Brush (dual)", "dual tip named after its preset"); eq(c.spacing, 0.5, "dual spacing");
            if (!same(a.data, ringData) || !same(b.data, barData) || !same(c.data, rampData)) throw new Error("a bitmap differs");
            eq(a.uuid, "11111111-2222-3333-4444-555555555555", "uuid");
            return { tips: r.brushes.map((t) => `${t.name} ${t.width}x${t.height} @${t.spacing}`) };
        });
    }
    check("unknown version", () => { try { readAbr(toAb(Buffer.from([0, 3, 0, 1, 0, 0]))); } catch (err) { return String(err.message); } throw new Error("no error"); });
    check("only computed", () => { const f = new W(); const c = v1Computed(); f.u16(1).u16(1).u16(c.length).raw(c); try { readAbr(toAb(f.bytes())); } catch (err) { if (!/computed/.test(err.message)) throw err; return String(err.message); } throw new Error("no error"); });

    // the real packs on this machine, when present: read, and the desc block fully consumed
    const real = [
        "C:/Program Files/Adobe/Adobe Photoshop 2026/Required/Default Brushes.abr",
        "C:/Program Files/Adobe/Adobe Photoshop 2026/Presets/Brushes/Legacy Brushes.abr",
        "C:/Program Files/Adobe/Adobe Photoshop 2026/Presets/Brushes/Converted Legacy Tool Presets.abr",
        "F:/boris.abr",
    ].filter((p) => fs.existsSync(p));
    for (const p of real) {
        check(`real ${path.basename(p)}`, () => {
            const t0 = Date.now();
            const r = readAbr(toAb(fs.readFileSync(p)));
            const bad = r.warnings.filter((w) => !/not referenced/.test(w));
            if (bad.length) throw new Error("desc: " + bad.join("; "));
            const named = r.brushes.filter((b) => b.name).length;
            if (named < r.brushes.length * 0.6) throw new Error(`only ${named} of ${r.brushes.length} tips named`);   // orphan bitmaps stay index-named
            const cov = r.brushes.slice(0, 20).map((b) => { let s = 0; for (const v of b.data) s += v; return s / b.data.length / 255; });
            if (cov.some((c) => c > 0.9)) throw new Error("a tip is almost fully covered: alpha polarity?");
            return { version: `${r.version}.${r.subversion}`, tips: r.brushes.length, named, computed: r.computed, presets: r.presets, ms: Date.now() - t0, warnings: r.warnings };
        });
    }
    if (!real.length) console.log("SKIP real packs: none on this machine");

    const outDir = process.argv[2];
    if (outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, "synthetic_v6.abr"), makeV6(2));
        fs.writeFileSync(path.join(outDir, "synthetic_v2.abr"), makeV1(2));
        console.log("wrote", path.join(outDir, "synthetic_v6.abr"));
    }
    console.log("RESULT", failed ? `FAIL (${failed})` : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
