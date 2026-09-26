// Saving and opening .scumble documents in the app (docs/PLAN_DOCUMENTS.md step D2): the main process side. The
// container itself is docfile.js; this module turns a request of the window into a write or an open of one file,
// keeps one job per path at a time, lets a cancel stop it, and tells the quit and the update install when every job
// is done (documents.idle(), inside QuitGuard.run's wait). Plain Node, no electron import (like quit.js): main.js
// passes in the mirror's root, the temp registry, the progress sender and the fetch of a file missing from the mirror.
"use strict";

const fsp = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");
const docfile = require("./docfile");

const EXT = ".scumble";
const DATA_PNG = /^data:image\/png;base64,/;

/** The key a path is locked and compared under: resolved, case-folded on Windows. */
function pathKey(p) {
    const r = path.resolve(String(p));
    return process.platform === "win32" ? r.toLowerCase() : r;
}

function isDocumentPath(p) {
    return typeof p === "string" && p.length > EXT.length && p.toLowerCase().endsWith(EXT);
}

/**
 * The .scumble files named on a command line: arguments that are not flags, end in .scumble and exist as files
 * (relative ones against `cwd`, the second instance's working directory).
 */
function documentArgs(argv, cwd) {
    const out = [];
    for (const a of argv || []) {
        if (typeof a !== "string" || a.startsWith("-") || !isDocumentPath(a)) continue;
        const p = path.resolve(cwd || process.cwd(), a);
        try { if (fs.statSync(p).isFile()) out.push(p); } catch (_) { /* not a file */ }
    }
    return out;
}

/** The selection fields of an opened document that are not PNG data URLs are dropped (§4.6): nothing else is loaded from them. */
function cleanDocument(d, notes) {
    if (d.selection != null && !(typeof d.selection === "string" && DATA_PNG.test(d.selection))) {
        delete d.selection; delete d.selectionBox;
        notes.push("the stored selection was not a picture and was left out");
    }
    if (d.selections != null) {
        const list = Array.isArray(d.selections) ? d.selections : [];
        const kept = list.filter((s) => s && typeof s.url === "string" && DATA_PNG.test(s.url));
        if (kept.length !== list.length || !Array.isArray(d.selections)) notes.push("saved selections that were not pictures were left out");
        d.selections = kept.map((s) => ({ name: typeof s.name === "string" ? s.name : "Selection", url: s.url }));
    }
    return d;
}

class Documents {
    /**
     * mirrorRoot    the local file mirror (<userData>/files)
     * registry      the temp list (<userData>/document-temps.json)
     * send          (channel, payload): progress to the window
     * fetchMissing  async (ref) => boolean: fetch a file the mirror lacks from ComfyUI (keeps a copy), false when it cannot
     * app           the app's version, written into the header
     * fault         () => { enospcAt } or null: the test hook (dev builds only)
     */
    constructor({ mirrorRoot, registry = null, send = () => {}, fetchMissing = null, app = "", fault = null }) {
        this.mirrorRoot = mirrorRoot;
        this.registry = registry;
        this.send = send;
        this.fetchMissing = fetchMissing;
        this.app = app;
        this.fault = fault;
        this.jobs = new Map();      // reqId -> { kind, key, ctrl, keys, promise }
        this.locks = new Map();     // pathKey -> reqId
        this.pending = [];          // paths to open once the window takes them (argv, a second start)
        this.waiters = [];
    }

    get busy() { return this.jobs.size > 0; }

    /** The mirror keys the jobs in flight read or write: pruning keeps them. */
    keepKeys() {
        const out = new Set();
        for (const j of this.jobs.values()) for (const k of j.keys) out.add(k);
        return Array.from(out);
    }

    /** Resolves when no job runs (the quit, the update install and a reload wait for it). */
    idle() {
        if (!this.jobs.size) return Promise.resolve();
        return new Promise((resolve) => this.waiters.push(resolve));
    }

    cancel(reqId) {
        const j = this.jobs.get(String(reqId));
        if (!j) return false;
        j.ctrl.abort();
        return true;
    }

    /** Every job stops (Quit now, the guard's timeout, a crashed window): its temporary file goes, its target stays. */
    abortAll() {
        for (const j of this.jobs.values()) j.ctrl.abort();
    }

    /** At a start: the temporary files a killed save left. */
    sweep() {
        return this.registry ? docfile.sweepTemps(this.registry) : [];
    }

    queue(paths) {
        for (const p of paths || []) if (isDocumentPath(p) && !this.pending.includes(p)) this.pending.push(p);
    }

    takePending() {
        const out = this.pending;
        this.pending = [];
        return out;
    }

    /** Is a path being saved or opened right now? */
    locked(p) { return this.locks.has(pathKey(p)); }

    async run(kind, reqId, target, fn) {
        const id = String(reqId || `${kind}-${Date.now()}`);
        if (this.jobs.has(id)) throw new Error("that request is already running");
        const key = pathKey(target);
        const holder = this.locks.get(key);
        if (holder != null) {
            const other = this.jobs.get(holder);
            throw new Error(`${path.basename(target)} is ${other && other.kind === "open" ? "being opened" : "already being saved"}; wait until that is done`);
        }
        const job = { kind, key, ctrl: new AbortController(), keys: new Set(), promise: null };
        this.jobs.set(id, job);
        this.locks.set(key, id);
        let last = 0;
        const progress = ({ done, total }) => {
            const now = Date.now();
            if (done < total && now - last < 100) return;
            last = now;
            this.send("documents:progress", { reqId: id, kind, done, total });
        };
        job.promise = (async () => fn(job, progress))();
        try {
            return await job.promise;
        } finally {
            this.jobs.delete(id);
            if (this.locks.get(key) === id) this.locks.delete(key);
            if (!this.jobs.size) { const w = this.waiters; this.waiters = []; for (const r of w) r(); }
        }
    }

    /**
     * Write a document. `document` is the editor's getValue() (a string or the object), `plugins` the per-document plugin
     * data, `extra` the top-level fields of an opened newer document this app did not know, `thumbnail` PNG bytes or
     * null, `history: false` leaves the result history (and the prompts of earlier runs) out.
     * Returns { path, name, bytes, entries, ms, mtime, size, notes }.
     */
    async write({ reqId, path: target, document, plugins = {}, extra = {}, summary = {}, recipe = null, thumbnail = null, history = true } = {}) {
        if (!isDocumentPath(target) || !path.isAbsolute(target)) throw new Error("a document is saved to a full path ending in .scumble");
        let doc;
        try { doc = typeof document === "string" ? JSON.parse(document) : JSON.parse(JSON.stringify(document)); } catch (err) { throw new Error("the document's state is not readable: " + err.message); }
        if (!doc || typeof doc !== "object" || Array.isArray(doc) || !doc.base) throw new Error("the document holds no picture yet");
        const plug = plugins && typeof plugins === "object" && !Array.isArray(plugins) ? JSON.parse(JSON.stringify(plugins)) : {};
        const ext = extra && typeof extra === "object" && !Array.isArray(extra) ? JSON.parse(JSON.stringify(extra)) : {};
        const notes = [];
        if (history === false) { doc.history = []; doc.seen = []; }
        // the fields of an opened newer document go back where it had them; the editor's own fields win (§6)
        if (Object.keys(ext).length) doc = { ...ext, ...doc };
        return this.run("save", reqId, target, async (job, progress) => {
            // the refs outside the result history must all be there; a history file that is gone leaves its entry out
            const all = docfile.collectRefs({ doc, plug });
            const outside = docfile.collectRefs({ doc: { ...doc, history: undefined }, plug });
            const files = [];
            const missingHistory = new Set();
            for (const [k, list] of all) {
                const ref = list[0];
                const p = docfile.mirrorPath(this.mirrorRoot, ref.type || "input", ref.subfolder || "", ref.filename);
                job.keys.add(k);
                let st = await fsp.stat(p).catch(() => null);
                if (!st && this.fetchMissing) {
                    try { if (await this.fetchMissing(ref)) st = await fsp.stat(p).catch(() => null); } catch (_) { st = null; }
                }
                if (!st || !st.isFile()) {
                    if (outside.has(k)) throw new Error(`${ref.filename} is not in the local store${this.fetchMissing ? " and ComfyUI could not send it" : ""}; the document was not saved`);
                    missingHistory.add(k);
                    continue;
                }
                files.push({ ref, path: p, size: st.size, required: outside.has(k) });
            }
            if (missingHistory.size && Array.isArray(doc.history)) {
                const before = doc.history.length;
                doc.history = doc.history.filter((h) => !(h && h.ref && missingHistory.has(docfile.keyOf(h.ref))));
                notes.push(`${before - doc.history.length} result${before - doc.history.length === 1 ? "" : "s"} of the history left out: the file${before - doc.history.length === 1 ? " is" : "s are"} gone`);
            }
            const header = docfile.buildHeader({ document: doc, plugins: plug, extra: ext, app: this.app, summary, recipe, files });
            const thumb = thumbnail && thumbnail.byteLength ? Buffer.from(thumbnail) : null;   // a Uint8Array over IPC
            const r = await docfile.writeDocument({
                target, header, thumbnail: thumb, files, registry: this.registry, signal: job.ctrl.signal, onProgress: progress,
                fault: this.fault ? this.fault() : null,
            });
            const st = await fsp.stat(target);
            return { path: target, name: path.basename(target), bytes: r.bytes, entries: r.entries, ms: r.ms, mtime: st.mtimeMs, size: st.size, notes };
        });
    }

    /**
     * Open a document into the mirror. Returns { path, name, mtime, size, document, plugins, extra, summary, recipe,
     * version, app, newer, notes, imported, reused, renamed }; the refs of `document` and `plugins` name files that are in
     * this mirror with the saved bytes.
     */
    async open({ reqId, path: file } = {}) {
        if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("a document is opened from a full path");
        return this.run("open", reqId, file, async (job, progress) => {
            const r = await docfile.openDocument({ file, mirrorRoot: this.mirrorRoot, signal: job.ctrl.signal, onProgress: progress });
            const h = r.header;
            const notes = [...r.notes];
            const document = cleanDocument(h.document, notes);
            const st = await fsp.stat(file);
            return {
                path: file, name: path.basename(file), mtime: st.mtimeMs, size: st.size,
                document,
                plugins: h.plugins && typeof h.plugins === "object" && !Array.isArray(h.plugins) ? h.plugins : {},
                extra: h.extra && typeof h.extra === "object" && !Array.isArray(h.extra) ? h.extra : {},
                summary: h.summary || {}, recipe: h.recipe || null, version: h.version, app: h.app || "",
                newer: h.version > docfile.FORMAT_VERSION,
                notes, imported: r.imported.length, reused: r.reused.length, renamed: r.renamed,
            };
        });
    }
}

module.exports = { Documents, documentArgs, isDocumentPath, pathKey, cleanDocument, EXT };
