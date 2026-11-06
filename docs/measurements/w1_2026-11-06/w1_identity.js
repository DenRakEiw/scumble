// W1's byte identity on real pictures (docs/PLAN_WASM_BUILD.md §7 W1): each PNG decoded here, its pixels filtered again
// in parts of 128 rows (the app's parts, each with the row above it) by the new SIMD build, the scalar build, the old
// SIMD build (the one before W1, passed with --old) and the JS twin, every byte compared; for a file Scumble wrote (its
// lines the old writer's), the new lines against the file's own lines too. Prints the filter types chosen, each build's
// time and the SHA-256 of all its lines.
//
//     node w1_identity.js --old <px.wasm before W1> file.png [file.png ...]
//
// The build before W1 is the SIMD px.wasm of its parent commit: `git show 59ff16f:renderer/editor/px/px.wasm > px_old.wasm`
// (sha256 2985f252...; the scalar build did not change, px_scalar.wasm ade55404... before and after).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const PX_DIR = path.join(ROOT, "renderer", "editor", "px");
const PART = 128;

function readPng(file) {
    const b = fs.readFileSync(file);
    let o = 8, ihdr = null;
    const idat = [];
    while (o < b.length) {
        const len = b.readUInt32BE(o), type = b.toString("latin1", o + 4, o + 8);
        const data = b.subarray(o + 8, o + 8 + len);
        if (type === "IHDR") ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], colour: data[9], interlace: data[12] };
        if (type === "IDAT") idat.push(data);
        o += 12 + len;
        if (type === "IEND") break;
    }
    return { ihdr, lines: zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: 2 ** 31 - 1 }), bytes: b.length };
}

async function main() {
    const args = process.argv.slice(2);
    const oi = args.indexOf("--old");
    const oldPath = oi >= 0 ? args.splice(oi, 2)[1] : null;
    const { loadPx } = await import(pathToFileURL(path.join(PX_DIR, "px.js")).href);
    const js = await import(pathToFileURL(path.join(PX_DIR, "kernels_js.js")).href);
    const builds = [
        ["simd", await loadPx(fs.readFileSync(path.join(PX_DIR, "px.wasm")))],
        ["scalar", await loadPx(fs.readFileSync(path.join(PX_DIR, "px_scalar.wasm")))],
    ];
    if (oldPath) builds.push(["old simd", await loadPx(fs.readFileSync(oldPath))]);
    let bad = 0;
    for (const file of args) {
        const t0 = Date.now();
        const { ihdr, lines, bytes } = readPng(file);
        const { w, h, depth, colour, interlace } = ihdr;
        if (depth !== 8 || interlace || (colour !== 6 && colour !== 2)) { console.log(`${file}: skipped (depth ${depth}, colour ${colour}, interlace ${interlace})`); continue; }
        const ch = colour === 6 ? 4 : 3, inStride = 1 + w * ch, n = w * 4, outStride = 1 + n;
        const hashes = builds.map(() => crypto.createHash("sha256")), jsHash = crypto.createHash("sha256");
        const ms = builds.map(() => 0);
        let jsMs = 0, sameAsFile = colour === 6, firstBad = "";
        const types = [0, 0, 0, 0, 0], fileTypes = [0, 0, 0, 0, 0];
        const prevIn = new Uint8Array(w * ch);
        let prevRgba = null;
        console.log(`${path.basename(file)}: ${w} x ${h}, ${ch === 4 ? "RGBA" : "RGB"}, ${(bytes / 1048576).toFixed(1)} MB, decoded in ${Date.now() - t0} ms`);
        for (let y0 = 0; y0 < h; y0 += PART) {
            const rows = Math.min(PART, h - y0);
            const band = new Uint8Array(lines.buffer, lines.byteOffset + y0 * inStride, rows * inStride).slice();
            for (let y = 0; y < rows; y++) fileTypes[band[y * inStride]]++;
            const rgba = new Uint8Array(rows * n);
            const done = builds[0][1].pngUnfilterRows(band, rows, w * ch, ch, prevIn, { w, channels: ch, out: rgba });
            if (done !== rows) throw new Error(`unfilter stopped at row ${y0 + done}`);
            const outs = builds.map(([, px], i) => { const t = performance.now(); const o = px.pngFilterRows(rgba, w, rows, prevRgba); ms[i] += performance.now() - t; return o; });
            const tj = performance.now(); const oj = js.pngFilterRows(rgba, w, rows, prevRgba); jsMs += performance.now() - tj;
            outs.forEach((o, i) => hashes[i].update(o));
            jsHash.update(oj);
            for (let y = 0; y < rows; y++) types[outs[0][y * outStride]]++;
            for (let i = 1; i < outs.length; i++) if (!firstBad && Buffer.compare(Buffer.from(outs[i]), Buffer.from(outs[0])) !== 0) firstBad = `${builds[i][0]} differs from simd in the part at row ${y0}`;
            if (!firstBad && Buffer.compare(Buffer.from(oj), Buffer.from(outs[0])) !== 0) firstBad = `the JS twin differs from simd in the part at row ${y0}`;
            if (sameAsFile) {
                const orig = new Uint8Array(lines.buffer, lines.byteOffset + y0 * inStride, rows * inStride);
                if (Buffer.compare(Buffer.from(orig), Buffer.from(outs[0])) !== 0) sameAsFile = false;
            }
            prevRgba = rgba.slice((rows - 1) * n);
        }
        const hx = hashes.map((x) => x.digest("hex")), jx = jsHash.digest("hex");
        const ok = !firstBad && hx.every((x) => x === hx[0]) && jx === hx[0];
        if (!ok) bad++;
        console.log(`  ${ok ? "ok  " : "FAIL"} every build and the twin give the same lines${firstBad ? `: ${firstBad}` : ""}; sha256 ${hx[0]}`);
        console.log(`  the new lines ${sameAsFile ? "equal" : "differ from"} the file's own lines${colour === 6 ? "" : " (an RGB file: not comparable)"}`);
        console.log(`  types chosen None ${types[0]}, Sub ${types[1]}, Up ${types[2]}, Average ${types[3]}, Paeth ${types[4]}; the file's ${fileTypes.join(" / ")}`);
        console.log(`  filter ms: ${builds.map(([l], i) => `${l} ${ms[i].toFixed(0)}`).join(", ")}, js ${jsMs.toFixed(0)} (Node, explains only)`);
    }
    console.log(bad ? `FAIL (${bad})` : "PASS");
    process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
