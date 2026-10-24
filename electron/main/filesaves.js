// Saving a file the window made (an export) in pieces: the main process side. One IPC message of about 512 MiB or
// more ends the window's renderer (oom; a save of 500 MB went through and one of 600 MB ended it, measured 2026-10-24,
// docs/BUGS.md), so the window sends an export in pieces (host.js saveExport) and this module appends them to a
// temporary file beside the target and renames it over the target at the end, as a .scumble save does (docfile.js):
// a failure, a cancel or a page that goes away deletes the temporary file and leaves the target as it was; one a
// killed app left behind is in the temp list (<userData>/document-temps.json), which the next start sweeps. Plain
// Node, no electron import: main.js passes in the dialog that picks a target.
"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const docfile = require("./docfile");

function failure(message, code) { const e = new Error(message); if (code) e.code = code; return e; }

function bytesOf(data) {
    if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    throw failure("a piece of the file is not bytes");
}

class FileSaves {
    /**
     * registry  the temp list (docfile's registry), null to keep none
     * choose    async (name, filters) => the target the user picked, or null when the dialog was cancelled
     * ops       { rename, copyFile } (tests): to inject EBUSY
     */
    constructor({ registry = null, choose = async () => null, ops = {} } = {}) {
        this.registry = registry;
        this.choose = choose;
        this.ops = ops;
        this.saves = new Map();   // id -> { id, owner, target, shown, temp, fh, size, pos, chain, dead, inPlace }
        this.seq = 0;
        this.gens = new Map();    // owner -> how often its saves were dropped (genOf)
        this.allGen = 0;
    }

    get busy() { return this.saves.size > 0; }

    /**
     * Open a save. `owner` is the page that sends the pieces (a webContents id): only it may write, and its reload or
     * end drops its saves (abortAll). `path` given (commands, scripts) shows no dialog. `size` is the whole file's.
     * Returns { id, path, name }, or null when the dialog was cancelled.
     */
    async start(owner, { name, filters, path: target, size } = {}) {
        if (!Number.isSafeInteger(size) || size < 0) throw failure("a save needs the file's size in bytes");
        // a page dropped while this waits (the dialog, the checks below) must not get a save nobody ends
        const gen = this.genOf(owner);
        let file = target ? String(target) : await this.choose(name, filters);
        if (!file) return null;
        file = path.resolve(file);
        // a symbolic link is saved through: the file it points to is replaced, the link stays
        let real = file;
        try { if ((await fsp.lstat(file)).isSymbolicLink()) real = await fsp.realpath(file); } catch (_) { /* a new file, or a link to none */ }
        let st = null;
        try { st = await fsp.stat(real); } catch (_) { /* a new file */ }
        if (st && st.isDirectory()) throw failure(`${file} is a folder`, "EISDIR");
        // a read-only file would refuse only the rename at the end, after every byte was written
        if (st && !(st.mode & 0o200)) throw failure(`${path.basename(file)} is read-only`, "EPERM");
        const free = await docfile.freeSpace(path.dirname(real));
        if (free < size + 1048576) throw failure(`the file needs ${docfile.fmtBytes(size)} and its drive has ${docfile.fmtBytes(free)} free`, "ENOSPC");
        const temp = docfile.tempFor(real);
        docfile.registerTemp(this.registry, temp);
        let fh;
        try {
            fh = await fsp.open(temp, "w");
        } catch (err) {
            try { docfile.unregisterTemp(this.registry, temp); } catch (_) { /* the sweep finds nothing to delete */ }
            if (err.code === "ENOENT" && !(await fsp.stat(path.dirname(real)).then(() => true, () => false))) throw failure(`the folder ${path.dirname(file)} does not exist`, err.code);
            throw err;
        }
        const id = ++this.seq;
        // a file with other names (a hard link) is written in place at the end, so every name holds the new bytes
        const s = { id, owner, target: real, shown: file, temp, fh, size, pos: 0, chain: Promise.resolve(), dead: false, inPlace: !!(st && st.nlink > 1) };
        this.saves.set(id, s);
        // dropped while this waited (the dialog, the checks, the open): abortAll found nothing to drop then
        if (this.genOf(owner) !== gen) { await this.drop(s); throw failure("the window reloaded during the save"); }
        return { id, path: file, name: path.basename(file) };
    }

    /** Append a piece at `offset` (where the last one ended). Returns { bytes } written so far. */
    async write(owner, { id, offset, data } = {}) {
        const s = this.saveOf(owner, id);
        return this.step(s, async () => {
            const buf = bytesOf(data);
            if (offset !== s.pos) throw failure(`a piece of the file came at byte ${offset}, not at ${s.pos}`);
            if (s.pos + buf.length > s.size) throw failure(`the file grew past its size of ${s.size} bytes`);
            let done = 0;
            while (done < buf.length) {
                const { bytesWritten } = await s.fh.write(buf, done, buf.length - done, s.pos + done);
                if (!bytesWritten) throw failure("the drive took no more bytes");
                done += bytesWritten;
            }
            s.pos += buf.length;
            return { bytes: s.pos };
        });
    }

    /** Close the file and put it in place of the target. Returns { path, name, bytes }. */
    async finish(owner, { id } = {}) {
        const s = this.saveOf(owner, id);
        return this.step(s, async () => {
            if (s.pos !== s.size) throw failure(`the file came short: ${s.pos} of ${s.size} bytes`);
            await s.fh.sync();
            const fh = s.fh;
            s.fh = null;
            await fh.close();
            let renamed = false;
            if (!s.inPlace) {
                try {
                    await docfile.renameRetry(s.temp, s.target, { rename: this.ops.rename });
                    renamed = true;
                } catch (err) {
                    if (!docfile.BUSY.has(err.code)) throw err;
                    // Windows refuses to replace a file another program holds open (a viewer), whatever it shares, and
                    // a folder may allow writes but no replace: written in place then, as every save before 0.1.51 was
                }
            }
            if (!renamed) {
                try {
                    await (this.ops.copyFile || fsp.copyFile)(s.temp, s.target);
                } catch (err) {
                    throw docfile.BUSY.has(err.code) ? failure(`${path.basename(s.shown)} is in use by another program, or its folder does not allow replacing it`, err.code) : err;
                }
            }
            s.dead = true;
            this.saves.delete(s.id);
            // the file is saved: a registry that cannot be written now only leaves a name the next sweep finds gone
            if (renamed || await removeTemp(s.temp)) {
                try { docfile.unregisterTemp(this.registry, s.temp); } catch (err) { console.warn("save temps:", err.message); }
            }
            return { path: s.shown, name: path.basename(s.shown), bytes: s.pos };
        });
    }

    /** Drop a save: its temporary file goes, the target stays. False when there is no such save (any more). */
    async abort(owner, { id } = {}) {
        const s = this.saves.get(id);
        if (!s || s.owner !== owner) return false;
        await this.drop(s);
        return true;
    }

    /** Drop every save of `owner` (a page that reloaded or ended), or every save at all. */
    async abortAll(owner) {
        // a save of that page still being opened (start awaits the dialog) is refused when its open ends
        if (owner === undefined) this.allGen++;
        else this.gens.set(owner, (this.gens.get(owner) || 0) + 1);
        const list = [...this.saves.values()].filter((s) => owner === undefined || s.owner === owner);
        await Promise.all(list.map((s) => this.drop(s)));
        return list.length;
    }

    saveOf(owner, id) {
        const s = this.saves.get(id);
        if (!s || s.owner !== owner || s.dead) throw failure("no such save: it was cancelled, or the window reloaded");
        return s;
    }

    // one step at a time per save, in the order the window sent them; a failed step drops the save
    step(s, fn) {
        const run = s.chain.then(() => {
            if (s.dead) throw failure("the save was cancelled");
            return fn();
        });
        s.chain = run.catch(() => {});
        return run.catch(async (err) => { await this.drop(s); throw err; });
    }

    async drop(s) {
        s.dead = true;
        this.saves.delete(s.id);
        await s.chain;   // a write under way ends first
        if (s.fh) { const fh = s.fh; s.fh = null; try { await fh.close(); } catch (_) { /* closed */ } }
        // a temporary file something still holds stays listed: the next start's sweep deletes it
        if (await removeTemp(s.temp)) { try { docfile.unregisterTemp(this.registry, s.temp); } catch (_) { /* the sweep deletes it */ } }
    }

    // a page's generation: abortAll(owner) moves it, abortAll() moves every page's
    genOf(owner) { return `${this.allGen}:${this.gens.get(owner) || 0}`; }
}

/** Delete a temporary file; true when it is gone (or never was), false when something holds it. */
async function removeTemp(p) {
    try { await fsp.unlink(p); return true; } catch (err) { return err.code === "ENOENT"; }
}

module.exports = { FileSaves };
