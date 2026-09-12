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

async function readIndex() {
    try {
        const list = JSON.parse(await fsp.readFile(path.join(dir(), "brushes.json"), "utf8"));
        return Array.isArray(list) ? list : [];
    } catch (_) {
        return [];
    }
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
    await fsp.writeFile(path.join(d, "brushes.json"), JSON.stringify(index, null, 2));
    return { count: index.length, dir: d };
}

async function openFolder() {
    await fsp.mkdir(dir(), { recursive: true });
    return shell.openPath(dir());
}

module.exports = { list, save, dir, openFolder };
