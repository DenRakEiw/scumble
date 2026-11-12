// Brush tips the user imported (Photoshop .abr files, images): kept as PNG files under
// <userData>/brushes/ with a brushes.json index, so a tip survives a restart. The renderer
// holds the canvases and does the reading of .abr files; this module only stores and lists
// bytes. The node has no file system and keeps its tips in memory.
"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { app, shell } = require("electron");

const SAFE_ID = /^[a-z0-9]+$/i;

function dir() {
    return path.join(app.getPath("userData"), "brushes");
}

/**
 * The index's entries. No index (none written yet, or a crash between a tip's PNG and the index) or one that does not
 * parse (a write cut short) gives the tips the folder holds, by their file names, so a save after it keeps them; a
 * damaged index is moved aside first (brushes.json.damaged-<time>). Any other read error (the file held by another
 * program) throws: list() then rejects, and the window saves no library this session (it would delete every tip).
 */
async function readIndex() {
    const d = dir();
    const file = path.join(d, "brushes.json");
    let text;
    try {
        text = await fsp.readFile(file, "utf8");
    } catch (err) {
        if (err && err.code === "ENOENT") return fromFiles(d);
        throw err;
    }
    let list;
    try { list = JSON.parse(text); } catch (_) { list = null; }
    if (Array.isArray(list)) return list;
    try { await fsp.rename(file, `${file}.damaged-${Date.now()}`); } catch (_) { /* kept where it is: read again next time */ }
    console.warn("brush tips: brushes.json could not be read; the tips are taken from the folder's files");
    return fromFiles(d);
}

/** The tips of the folder by their PNG files' names (no index to name them). */
async function fromFiles(d) {
    let names = [];
    try { names = await fsp.readdir(d); } catch (err) { if (err && err.code === "ENOENT") return []; throw err; }
    return names.map((f) => /^([a-z0-9]+)\.png$/i.exec(f)).filter(Boolean).map((m) => ({ id: m[1], name: m[1], spacing: 0, source: "" }));
}

/** Every stored tip with its PNG bytes: { id, name, spacing, source, png }. A tip whose file is gone is skipped. */
async function list() {
    const out = [];
    for (const t of await readIndex()) {
        if (!t || !SAFE_ID.test(String(t.id))) continue;
        try {
            const data = await fsp.readFile(path.join(dir(), t.id + ".png"));
            out.push({ id: t.id, name: String(t.name || ""), spacing: +t.spacing || 0, source: String(t.source || ""), png: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
        } catch (_) { /* the file is gone: drop the entry */ }
    }
    return out;
}

/**
 * Replace the index with `tips` ({ id, name, spacing, source, png? }). PNG bytes are written
 * when given (a tip already on disk sends none), the files of ids no longer listed are removed.
 */
async function save(tips) {
    const d = dir();
    await fsp.mkdir(d, { recursive: true });
    const keep = new Set();
    const index = [];
    for (const t of tips || []) {
        if (!t || !SAFE_ID.test(String(t.id))) continue;
        keep.add(t.id);
        if (t.png && t.png.byteLength) await fsp.writeFile(path.join(d, t.id + ".png"), Buffer.from(t.png.buffer, t.png.byteOffset, t.png.byteLength));
        index.push({ id: t.id, name: String(t.name || ""), spacing: +t.spacing || 0, source: String(t.source || "") });
    }
    for (const f of await fsp.readdir(d)) {
        const m = /^([a-z0-9]+)\.png$/i.exec(f);
        if (m && !keep.has(m[1])) await fsp.unlink(path.join(d, f)).catch(() => {});
    }
    // through a temp file, flushed, then renamed: a crash or a power loss mid-write leaves the old index or the new one
    const file = path.join(d, "brushes.json"), tmp = file + ".tmp";
    const fh = await fsp.open(tmp, "w");
    try { await fh.writeFile(JSON.stringify(index, null, 2)); await fh.sync(); } finally { await fh.close(); }
    await fsp.rename(tmp, file);
    return { count: index.length, dir: d };
}

async function openFolder() {
    await fsp.mkdir(dir(), { recursive: true });
    return shell.openPath(require("./msix").forExplorer(dir()));
}

module.exports = { list, save, dir, openFolder };
