// The .scumble document file (docs/PLAN_DOCUMENTS.md §3, §4): a zip of stored entries - `mimetype`, then
// `scumble/document.json` (a version header, the editor's getValue() and per-document plugin data), an optional
// thumbnail, then every mirror file the state names under `files/<type>/<subfolder>/<filename>`, copied byte for
// byte. Plain Node, no electron (like quit.js): tools/document_test.js runs it on a scratch mirror, and Python's
// zipfile reads what it writes as an independent check.
//
// Nothing here encodes pictures: the files are the mirror's PNGs as the editor uploaded them. A write copies them in
// CHUNK pieces to a temporary file beside the target (its CRC-32 written back into each local header afterwards),
// fsyncs and renames it over the target; any failure leaves the target as it was. A read parses the central
// directory (zip64 included), checks every entry against the file's length, and copies `files/` entries into the
// mirror with a CRC check: a file already there with the same bytes is reused, other bytes under the same name are
// imported under a free name and the refs renamed.
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");

const MIME = "application/x-scumble";
const FORMAT_VERSION = 1;            // what this app writes
const READER_VERSION = 1;            // the newest minReader this app can open
const HEADER_ENTRY = "scumble/document.json";
const THUMB_ENTRY = "Thumbnails/thumbnail.png";
const MAX_HEADER = 64 * 1024 * 1024;
const MAX_DIRECTORY = 256 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024;
const SAFE_NAME = /^[^\\/:*?"<>|\x00-\x1f]+$/;          // electron/main/files.js, the mirror's own rule
const TYPES = ["input", "output", "temp"];
const TEMP_RE = /\.saving-\d+-\d+$/;
const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);

// the zip32 / entry-count thresholds; a test lowers them to take the zip64 paths with small files
const LIMITS = { u32: 0xFFFFFFFF, u16: 0xFFFF };
function setLimits(l) { Object.assign(LIMITS, l || {}); }
function resetLimits() { LIMITS.u32 = 0xFFFFFFFF; LIMITS.u16 = 0xFFFF; }

let tempSeq = 0;

// ---- names and refs ------------------------------------------------------------------------------------------------

/** The mirror path of a ref (files.js mirrorPath, with the mirror's root passed in). Throws on a name it refuses. */
function mirrorPath(root, type, subfolder, filename) {
    if (typeof filename !== "string" || !SAFE_NAME.test(filename) || filename === "." || filename === "..") throw new Error("bad file name: " + filename);
    const sub = String(subfolder || "").replace(/\\/g, "/").split("/").filter((s) => s && s !== "." && s !== "..");
    for (const s of sub) if (!SAFE_NAME.test(s)) throw new Error("bad folder name: " + s);
    if (!TYPES.includes(type)) throw new Error("bad file type: " + type);
    return path.join(root, type, ...sub, filename);
}

/** The mirror key (files.js key) and the zip entry name of a ref. */
function keyOf(ref) { return `${ref.type || "input"}/${ref.subfolder || ""}/${ref.filename}`; }
function entryOf(ref) {
    const sub = String(ref.subfolder || "").replace(/\\/g, "/").split("/").filter(Boolean);
    return ["files", ref.type || "input", ...sub, ref.filename].join("/");
}

/** An entry name back to a ref, or null when it is not a `files/` entry the mirror would take. */
function refOfEntry(name) {
    const parts = String(name).split("/");
    if (parts.length < 3 || parts[0] !== "files" || parts.some((p) => !p || p === "." || p === "..")) return null;
    const ref = { type: parts[1], subfolder: parts.slice(2, -1).join("/"), filename: parts[parts.length - 1] };
    try { mirrorPath("/", ref.type, ref.subfolder, ref.filename); } catch (_) { return null; }
    return ref;
}

/** Every ref object ({ filename, subfolder?, type? }) under `v`, grouped by mirror key. */
function collectRefs(v, out = new Map()) {
    if (!v || typeof v !== "object") return out;
    if (Array.isArray(v)) { for (const x of v) collectRefs(x, out); return out; }
    if (typeof v.filename === "string") {
        const k = keyOf(v);
        if (!out.has(k)) out.set(k, []);
        out.get(k).push(v);
    }
    for (const x of Object.values(v)) collectRefs(x, out);
    return out;
}

/** Rename refs in place: `renames` maps a mirror key to the new file name (same type and subfolder). */
function renameRefs(v, renames) {
    for (const [k, list] of collectRefs(v)) {
        const to = renames.get(k);
        if (to) for (const ref of list) ref.filename = to;
    }
}

// ---- the header ----------------------------------------------------------------------------------------------------

/**
 * The document.json of a save: `document` is JSON.parse(getValue()), `plugins` the per-document plugin data, `files`
 * [{ ref, size, required }] (made by the caller from collectRefs and the mirror). Returns the object.
 */
function buildHeader({ document, plugins = {}, extra = {}, app = "", summary = {}, recipe = null, files = [], saved = null }) {
    return {
        format: "scumble", version: FORMAT_VERSION, minReader: 1,
        app: String(app), saved: saved || new Date().toISOString(),
        summary, recipe, document, extra, plugins,
        files: files.map((f) => ({ entry: entryOf(f.ref), size: f.size, required: f.required !== false })),
    };
}

/** Check a parsed document.json: throws when this app must not open it; returns notes for one it opens anyway. */
function checkHeader(h) {
    if (!h || typeof h !== "object" || h.format !== "scumble") throw new Error("not a Scumble document (no document header)");
    if (!Number.isInteger(h.version) || h.version < 1) throw new Error("the document header has no valid version");
    const minReader = Number.isInteger(h.minReader) ? h.minReader : h.version;
    if (minReader > READER_VERSION) throw new Error(`made by a newer Scumble (${h.app || "version " + h.version}) in a form this version cannot read; update Scumble to open it`);
    if (!h.document || typeof h.document !== "object" || Array.isArray(h.document)) throw new Error("the document header holds no document");
    if (!Array.isArray(h.files)) throw new Error("the document header lists no files");
    const notes = [];
    if (h.version > FORMAT_VERSION) notes.push(`made by a newer Scumble (${h.app || "version " + h.version}): what this version does not know is kept, and saving over the file asks first`);
    return notes;
}

// ---- zip writing -----------------------------------------------------------------------------------------------------

function dosTime(d) {
    const t = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const dt = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return [t & 0xFFFF, dt & 0xFFFF];
}

function u64(buf, v, at) { buf.writeBigUInt64LE(BigInt(v), at); }

/** A local header; `zip64` puts the sizes into a zip64 extra field (needed when the size passes the zip32 limit). */
function localHeader(name, size, crc, when, zip64, bare) {
    const nameBuf = Buffer.from(name, "utf8");
    const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (zip64) { extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(16, 2); u64(extra, size, 4); u64(extra, size, 12); }
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(zip64 ? 45 : 20, 4);
    h.writeUInt16LE(bare ? 0 : 0x0800, 6);                  // UTF-8 names (the mimetype entry stays bare, as ORA's)
    h.writeUInt16LE(0, 8);                                  // stored
    h.writeUInt16LE(when[0], 10); h.writeUInt16LE(when[1], 12);
    h.writeUInt32LE(crc >>> 0, 14);
    h.writeUInt32LE(zip64 ? 0xFFFFFFFF : size, 18);
    h.writeUInt32LE(zip64 ? 0xFFFFFFFF : size, 22);
    h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(extra.length, 28);
    return Buffer.concat([h, nameBuf, extra]);
}

function centralHeader(e, when) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const bigSize = e.size >= LIMITS.u32, bigOff = e.offset >= LIMITS.u32;
    const fields = [];
    if (bigSize) fields.push(e.size, e.size);
    if (bigOff) fields.push(e.offset);
    const extra = Buffer.alloc(fields.length ? 4 + 8 * fields.length : 0);
    if (fields.length) { extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(8 * fields.length, 2); fields.forEach((v, i) => u64(extra, v, 4 + 8 * i)); }
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(45, 4); h.writeUInt16LE(fields.length ? 45 : 20, 6);
    h.writeUInt16LE(e.bare ? 0 : 0x0800, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(when[0], 12); h.writeUInt16LE(when[1], 14);
    h.writeUInt32LE(e.crc >>> 0, 16);
    h.writeUInt32LE(bigSize ? 0xFFFFFFFF : e.size, 20);
    h.writeUInt32LE(bigSize ? 0xFFFFFFFF : e.size, 24);
    h.writeUInt16LE(nameBuf.length, 28); h.writeUInt16LE(extra.length, 30); h.writeUInt16LE(0, 32);
    h.writeUInt16LE(0, 34); h.writeUInt16LE(0, 36); h.writeUInt32LE(0, 38);
    h.writeUInt32LE(bigOff ? 0xFFFFFFFF : e.offset, 42);
    return Buffer.concat([h, nameBuf, extra]);
}

function endRecords(count, cdSize, cdOffset) {
    const need64 = count >= LIMITS.u16 || cdSize >= LIMITS.u32 || cdOffset >= LIMITS.u32;
    const parts = [];
    if (need64) {
        const rec = Buffer.alloc(56);
        rec.writeUInt32LE(0x06064b50, 0); u64(rec, 44, 4);
        rec.writeUInt16LE(45, 12); rec.writeUInt16LE(45, 14);
        rec.writeUInt32LE(0, 16); rec.writeUInt32LE(0, 20);
        u64(rec, count, 24); u64(rec, count, 32); u64(rec, cdSize, 40); u64(rec, cdOffset, 48);
        const loc = Buffer.alloc(20);
        loc.writeUInt32LE(0x07064b50, 0); loc.writeUInt32LE(0, 4); u64(loc, cdOffset + cdSize, 8); loc.writeUInt32LE(1, 16);
        parts.push(rec, loc);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(need64 ? 0xFFFF : count, 8); eocd.writeUInt16LE(need64 ? 0xFFFF : count, 10);
    eocd.writeUInt32LE(need64 ? 0xFFFFFFFF : cdSize, 12); eocd.writeUInt32LE(need64 ? 0xFFFFFFFF : cdOffset, 16);
    eocd.writeUInt16LE(0, 20);
    parts.push(eocd);
    return Buffer.concat(parts);
}

// ---- the temporary files ---------------------------------------------------------------------------------------------

function readList(registry) {
    try { const v = JSON.parse(fs.readFileSync(registry, "utf8")); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch (_) { return []; }
}
function writeList(registry, list) {
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    const tmp = registry + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(list), "utf8");
    fs.renameSync(tmp, registry);
}
function registerTemp(registry, p) { if (registry) writeList(registry, [...readList(registry).filter((x) => x !== p), p]); }
function unregisterTemp(registry, p) { if (registry) writeList(registry, readList(registry).filter((x) => x !== p)); }

/** At a start: delete the temporary files a killed save left (only the listed ones, only with the temp pattern). */
function sweepTemps(registry) {
    const removed = [];
    for (const p of readList(registry)) {
        if (!TEMP_RE.test(p)) continue;
        try { fs.unlinkSync(p); removed.push(p); } catch (_) { /* gone already */ }
    }
    try { writeList(registry, []); } catch (_) { /* a read-only profile: nothing to keep either */ }
    return removed;
}

// ---- writing a document ------------------------------------------------------------------------------------------------

/** An error that says what went wrong in the user's words, keeping the system code. */
function failure(message, code) { const e = new Error(message); if (code) e.code = code; return e; }

async function freeSpace(dir) {
    try { const s = await fsp.statfs(dir); return Number(s.bavail) * Number(s.bsize); } catch (_) { return Infinity; }
}

async function renameRetry(from, to, { tries = 20, delay = 100, rename = fsp.rename } = {}) {
    for (let i = 0; ; i++) {
        try { await rename(from, to); return; } catch (err) {
            if (!BUSY.has(err.code) || i >= tries - 1) throw err;
            await new Promise((r) => setTimeout(r, delay));
        }
    }
}

/**
 * Write a .scumble file.
 *   target     the file to write (replaced whole, only at the end)
 *   header     buildHeader()'s object
 *   thumbnail  a PNG Buffer or null
 *   files      [{ ref, path, size }] - the mirror files, in the header's order
 *   registry   the temp list (<userData>/document-temps.json), null to keep none
 *   signal     an AbortSignal: a cancel deletes the temporary file
 *   onProgress ({ done, total }) in bytes
 *   fault      { enospcAt: bytes } (tests): fail like a full disk once that much is written
 *   ops        { rename } (tests): the rename, to inject EBUSY
 * Returns { bytes, entries, ms }.
 */
async function writeDocument({ target, header, thumbnail = null, files = [], registry = null, signal = null, onProgress = null, fault = null, ops = {} }) {
    const t0 = Date.now();
    const dir = path.dirname(target);
    const headerBuf = Buffer.from(JSON.stringify(header), "utf8");
    if (headerBuf.length > MAX_HEADER) throw failure(`the document's description is ${Math.round(headerBuf.length / 1048576)} MB, more than a .scumble file takes (64 MB)`);
    const entries = [
        { name: "mimetype", data: Buffer.from(MIME, "ascii"), bare: true },
        { name: HEADER_ENTRY, data: headerBuf },
    ];
    if (thumbnail && thumbnail.length) entries.push({ name: THUMB_ENTRY, data: thumbnail });
    const seen = new Set(entries.map((e) => e.name));
    for (const f of files) {
        const name = entryOf(f.ref);
        if (seen.has(name)) continue;
        if (!refOfEntry(name)) throw failure("a file name the document cannot carry: " + name);
        seen.add(name);
        entries.push({ name, file: f.path, size: f.size });
    }
    const total = entries.reduce((n, e) => n + (e.data ? e.data.length : e.size) + 100 + Buffer.byteLength(e.name) * 2, 0);
    const free = await freeSpace(dir);
    if (free < total + 1048576) throw failure(`the file needs ${fmtBytes(total)} and its drive has ${fmtBytes(free)} free`, "ENOSPC");
    const temp = `${target}.saving-${process.pid}-${++tempSeq}`;
    registerTemp(registry, temp);
    const when = dosTime(new Date());
    let fh = null, pos = 0, done = 0;
    const check = () => { if (signal && signal.aborted) throw failure("the save was cancelled", "ABORT_ERR"); };
    const write = async (buf, at) => {
        if (fault && fault.enospcAt != null && pos + buf.length > fault.enospcAt) throw failure("no space left on the drive (a test fault)", "ENOSPC");
        await fh.write(buf, 0, buf.length, at);
    };
    try {
        fh = await fsp.open(temp, "w");
        const written = [];
        for (const e of entries) {
            check();
            const size = e.data ? e.data.length : e.size;
            const zip64 = size >= LIMITS.u32;
            const offset = pos;
            const lh = localHeader(e.name, size, 0, when, zip64, e.bare);
            await write(lh, pos);
            pos += lh.length;
            let crc = 0;
            if (e.data) {
                crc = zlib.crc32(e.data);
                await write(e.data, pos);
                pos += e.data.length;
                done += e.data.length;
            } else {
                const src = await fsp.open(e.file, "r");
                try {
                    const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, size)));
                    let copied = 0;
                    for (;;) {
                        check();
                        const { bytesRead } = await src.read(buf, 0, buf.length, copied);
                        if (!bytesRead) break;
                        if (copied + bytesRead > size) throw failure(`${path.basename(e.file)} changed while it was saved`);
                        const part = bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
                        crc = zlib.crc32(part, crc);
                        await write(part, pos);
                        pos += bytesRead; copied += bytesRead; done += bytesRead;
                        if (onProgress) onProgress({ done, total });
                    }
                    if (copied !== size) throw failure(`${path.basename(e.file)} changed while it was saved`);
                } finally {
                    await src.close();
                }
            }
            const crcBuf = Buffer.alloc(4);
            crcBuf.writeUInt32LE(crc >>> 0, 0);
            await write(crcBuf, offset + 14);                // back into the local header
            written.push({ name: e.name, size, crc, offset, bare: e.bare });
        }
        check();
        const cd = Buffer.concat(written.map((e) => centralHeader(e, when)));
        const cdOffset = pos;
        await write(cd, pos); pos += cd.length;
        const end = endRecords(written.length, cd.length, cdOffset);
        await write(end, pos); pos += end.length;
        await fh.sync();
        await fh.close();
        fh = null;
        check();
        try {
            await renameRetry(temp, target, { rename: ops.rename });
        } catch (err) {
            throw BUSY.has(err.code) ? failure(`${path.basename(target)} is in use by another program`, err.code) : err;
        }
        unregisterTemp(registry, temp);
        if (onProgress) onProgress({ done: total, total });
        return { bytes: pos, entries: written.length, ms: Date.now() - t0 };
    } catch (err) {
        if (fh) { try { await fh.close(); } catch (_) { /* closed */ } }
        try { await fsp.unlink(temp); } catch (_) { /* never made */ }
        unregisterTemp(registry, temp);
        throw err;
    }
}

function fmtBytes(n) {
    if (!Number.isFinite(n)) return "enough";
    return n >= 1073741824 ? (n / 1073741824).toFixed(1) + " GB" : n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
}

// ---- zip reading -------------------------------------------------------------------------------------------------------

function readU64(buf, at) {
    const v = buf.readBigUInt64LE(at);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw failure("a size in the file is out of range");
    return Number(v);
}

async function readAt(fh, at, len) {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, at);
    if (bytesRead !== len) throw failure("the file ends early (truncated?)");
    return buf;
}

/**
 * The central directory of a .scumble (or any stored zip): { size, entries: [{ name, size, crc, dataStart }] }.
 * Every offset and size is checked against the file's length; a compressed entry is refused (this format stores).
 */
async function readDirectory(fh) {
    const { size } = await fh.stat();
    if (size < 22) throw failure("not a Scumble document (too short)");
    const tailLen = Math.min(size, 22 + 65535 + 20);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw failure("not a Scumble document (no zip directory)");
    let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOffset = tail.readUInt32LE(e + 16);
    const eocdAt = size - tailLen + e;
    if (eocdAt >= 20) {
        const loc = await readAt(fh, eocdAt - 20, 20);
        if (loc.readUInt32LE(0) === 0x07064b50) {
            const recAt = readU64(loc, 8);
            if (recAt + 56 > eocdAt) throw failure("the zip64 end record lies outside the file");
            const rec = await readAt(fh, recAt, 56);
            if (rec.readUInt32LE(0) !== 0x06064b50) throw failure("the zip64 end record is damaged");
            count = readU64(rec, 32); cdSize = readU64(rec, 40); cdOffset = readU64(rec, 48);
        }
    }
    if (cdOffset + cdSize > eocdAt || cdSize > MAX_DIRECTORY) throw failure("the zip directory lies outside the file");
    const cd = await readAt(fh, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
        if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw failure("the zip directory is damaged");
        const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10), crc = cd.readUInt32LE(p + 16);
        let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
        const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
        let offset = cd.readUInt32LE(p + 42);
        if (p + 46 + nlen + xlen + clen > cd.length) throw failure("the zip directory is damaged");
        const name = cd.toString(flags & 0x0800 ? "utf8" : "latin1", p + 46, p + 46 + nlen);
        const extra = cd.subarray(p + 46 + nlen, p + 46 + nlen + xlen);
        for (let q = 0; q + 4 <= extra.length;) {
            const id = extra.readUInt16LE(q), len = extra.readUInt16LE(q + 2);
            if (id === 0x0001) {
                let r = q + 4;
                if (usize === 0xFFFFFFFF) { usize = readU64(extra, r); r += 8; }
                if (csize === 0xFFFFFFFF) { csize = readU64(extra, r); r += 8; }
                if (offset === 0xFFFFFFFF) { offset = readU64(extra, r); r += 8; }
            }
            q += 4 + len;
        }
        if (method !== 0 || csize !== usize) throw failure(`"${name}" is compressed; a .scumble file stores its entries`);
        entries.push({ name, size: usize, crc: crc >>> 0, offset });
        p += 46 + nlen + xlen + clen;
    }
    for (const en of entries) {
        if (en.offset + 30 > cdOffset) throw failure(`"${en.name}" lies outside the file`);
        const lh = await readAt(fh, en.offset, 30);
        if (lh.readUInt32LE(0) !== 0x04034b50) throw failure(`"${en.name}" has no local header`);
        en.dataStart = en.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        if (en.dataStart + en.size > cdOffset) throw failure(`"${en.name}" runs past its place in the file`);
    }
    return { size, entries };
}

/** A small entry into memory, its CRC checked. */
async function readEntry(fh, en, max) {
    if (en.size > max) throw failure(`"${en.name}" is too large (${fmtBytes(en.size)})`);
    const buf = await readAt(fh, en.dataStart, en.size);
    if ((zlib.crc32(buf) >>> 0) !== en.crc) throw failure(`"${en.name}" is damaged (its checksum does not match)`);
    return buf;
}

/** The CRC-32 of a file on disk, read in chunks. */
async function crcOfFile(p) {
    const fh = await fsp.open(p, "r");
    try {
        const buf = Buffer.allocUnsafe(CHUNK);
        let crc = 0, at = 0;
        for (;;) {
            const { bytesRead } = await fh.read(buf, 0, buf.length, at);
            if (!bytesRead) break;
            crc = zlib.crc32(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead), crc);
            at += bytesRead;
        }
        return crc >>> 0;
    } finally {
        await fh.close();
    }
}

/** An entry copied to `dest` through `<dest>.importing-<pid>`, its CRC checked on the way. */
async function copyEntry(fh, en, dest, check) {
    const tmp = `${dest}.importing-${process.pid}`;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const out = await fsp.open(tmp, "w");
    try {
        const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, en.size)));
        let crc = 0, at = 0;
        while (at < en.size) {
            if (check) check();
            const n = Math.min(buf.length, en.size - at);
            const { bytesRead } = await fh.read(buf, 0, n, en.dataStart + at);
            if (bytesRead !== n) throw failure("the file ends early (truncated?)");
            const part = buf.subarray(0, n);
            crc = zlib.crc32(part, crc);
            await out.write(part, 0, n, at);
            at += n;
        }
        if ((crc >>> 0) !== en.crc) throw failure(`"${en.name}" is damaged (its checksum does not match)`);
        await out.sync();
        await out.close();
        await fsp.rename(tmp, dest);
    } catch (err) {
        try { await out.close(); } catch (_) { /* closed */ }
        try { await fsp.unlink(tmp); } catch (_) { /* never made */ }
        throw err;
    }
}

function freeName(dir, filename) {
    const ext = path.extname(filename);
    const stem = filename.slice(0, filename.length - ext.length);
    let name = filename, n = 1;
    while (fs.existsSync(path.join(dir, name))) { name = `${stem} (${n})${ext}`; n++; }
    return name;
}

/**
 * Open a .scumble file into the mirror at `mirrorRoot`. Returns { header, notes, imported, reused, renamed, thumbnail }
 * with the refs in header.document and header.plugins renamed where a file had to be imported under a free name.
 */
async function openDocument({ file, mirrorRoot, signal = null, onProgress = null }) {
    const check = () => { if (signal && signal.aborted) throw failure("the open was cancelled", "ABORT_ERR"); };
    const fh = await fsp.open(file, "r");
    try {
        const { entries } = await readDirectory(fh);
        const byName = new Map(entries.map((e) => [e.name, e]));
        const mime = entries[0];
        if (!mime || mime.name !== "mimetype" || (await readEntry(fh, mime, 256)).toString("ascii") !== MIME) throw failure("not a Scumble document (no mimetype entry)");
        const hdrEntry = byName.get(HEADER_ENTRY);
        if (!hdrEntry) throw failure("not a Scumble document (no document header)");
        let header;
        try { header = JSON.parse((await readEntry(fh, hdrEntry, MAX_HEADER)).toString("utf8")); } catch (err) { throw err.code ? err : failure("the document header is not readable: " + err.message); }
        const notes = checkHeader(header);
        const thumbEntry = byName.get(THUMB_ENTRY);
        let thumbnail = null;
        if (thumbEntry) { try { thumbnail = await readEntry(fh, thumbEntry, 16 * 1048576); } catch (_) { notes.push("the thumbnail is damaged; the document is not"); } }
        // every listed file: its name checked before anything is written, its size against the directory
        const listed = [];
        for (const f of header.files) {
            const ref = f && refOfEntry(f.entry);
            if (!ref) throw failure(`the document names a file it may not carry: ${f && f.entry}`);
            const en = byName.get(f.entry);
            if (!en) { if (f.required !== false) throw failure(`the file lacks "${f.entry}"`); notes.push(`"${ref.filename}" of the result history is missing`); continue; }
            if (en.size !== f.size) throw failure(`"${f.entry}" is ${en.size} bytes, the header says ${f.size}`);
            listed.push({ ref, en });
        }
        const total = listed.reduce((n, x) => n + x.en.size, 0);
        let done = 0;
        const imported = [], reused = [], renamed = new Map();
        for (const { ref, en } of listed) {
            check();
            const dest = mirrorPath(mirrorRoot, ref.type, ref.subfolder, ref.filename);
            let st = null;
            try { st = await fsp.stat(dest); } catch (_) { st = null; }
            if (st && st.size === en.size && (await crcOfFile(dest)) === en.crc) { reused.push(keyOf(ref)); }
            else if (st) {
                const name = freeName(path.dirname(dest), ref.filename);
                await copyEntry(fh, en, path.join(path.dirname(dest), name), check);
                renamed.set(keyOf(ref), name);
                imported.push(keyOf({ ...ref, filename: name }));
            } else {
                await copyEntry(fh, en, dest, check);
                imported.push(keyOf(ref));
            }
            done += en.size;
            if (onProgress) onProgress({ done, total });
        }
        if (renamed.size) { renameRefs(header.document, renamed); renameRefs(header.plugins, renamed); }
        return { header, notes, imported, reused, renamed: Object.fromEntries(renamed), thumbnail };
    } finally {
        await fh.close();
    }
}

/** Is the file a .scumble (its first bytes: a stored `mimetype` entry holding MIME)? `head` is at least 60 bytes. */
function isScumble(head) {
    if (!head || head.length < 38 + MIME.length) return false;
    return head.readUInt32LE(0) === 0x04034b50 && head.toString("ascii", 30, 38) === "mimetype" && head.toString("ascii", 38, 38 + MIME.length) === MIME;
}

module.exports = {
    MIME, FORMAT_VERSION, READER_VERSION, HEADER_ENTRY, THUMB_ENTRY, TEMP_RE, LIMITS,
    setLimits, resetLimits, mirrorPath, keyOf, entryOf, refOfEntry, collectRefs, renameRefs,
    buildHeader, checkHeader, writeDocument, readDirectory, openDocument, sweepTemps, registerTemp, unregisterTemp,
    isScumble, crcOfFile, fmtBytes,
};
