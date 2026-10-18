// The Comfy Cloud jobs whose answer Scumble has not taken yet (docs/PLAN_COMFY_SDK.md S6): a run on the Comfy API v2
// notes its job here at the submit and takes it out at its end, so a crash or a quit while a job ran leaves the note
// (and so does a run whose job finished or may still run but whose picture never came: comfycloud.runV2, which then
// ends its words with KEPT). The window asks for the notes after its documents are back, again when main says the
// notes changed, and every 90 s while some are kept (comfycloud.recoverJobs through providers/index.js): a job that
// finished meanwhile comes back as a picture the window opens as a document of its own, and its note goes only when the
// window says it has it (ack). Nothing is ever sent again; only a job's own result is read. A job whose run is still
// in flight in this process (`flying`) is left to its run.
//
// <userData>/cloudjobs.json: { version: 1, jobs: [{ jobId, model, recipe, node, saveId, started }] }, written whole (a
// temp file, then a rename). A note older than MAX_AGE_MS is dropped unread (Comfy keeps a job's outputs for a limited
// time). Every change is one synchronous read-modify-write, so the notes of runs that end at the same time never
// overwrite each other (one main process holds the data folder); a change whose read fails for any reason but a missing
// or broken file writes nothing, so it cannot replace the notes it could not read.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 50;
const FILE = "cloudjobs.json";
// the end of a run's words when its job's note stays (docs/PLAN_COMFY_SDK.md, the fix contract's section 3)
const KEPT = "Scumble keeps the job and opens its picture as a document of its own when Comfy has it.";

/** The ids of the jobs whose run is in flight in this process right now (comfycloud.runV2 adds and takes them out). */
const flying = new Set();

/**
 * The ids whose note this process took out (a run's end, an ack, a read that settled it), so an ask leaves such a note
 * alone and takes it out again: a note whose removal Windows refused never opens its picture a second time. A note put
 * back (add, keep) leaves the set.
 */
const settled = new Set();
const SETTLED_MAX = 1000;
function settle(id) {
    settled.delete(id);
    settled.add(id);
    if (settled.size > SETTLED_MAX) settled.delete(settled.values().next().value);
}

/** An unlink, a rename or a read, tried again a few times when Windows holds the file a moment (a scanner, an indexer). */
function retrying(op) {
    for (let i = 0; ; i++) {
        try { return op(); } catch (err) {
            if (i >= 4 || !/^(EPERM|EBUSY|EACCES)$/.test(String(err && err.code))) throw err;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
        }
    }
}

/**
 * The notes. No file, or one that is not JSON, is no notes; any other failure to read (a file Windows still holds after
 * the retries) throws when `strict` (a change must not write over notes it could not read), else reads as no notes.
 */
function read(dir, strict = false) {
    let text;
    try { text = retrying(() => fs.readFileSync(path.join(dir, FILE), "utf8")); } catch (err) {
        if (strict && !(err && err.code === "ENOENT")) throw err;
        return [];
    }
    let j;
    try { j = JSON.parse(text); } catch (_) { return []; }
    return Array.isArray(j && j.jobs) ? j.jobs.filter((e) => e && typeof e.jobId === "string" && e.jobId) : [];
}

function write(dir, jobs) {
    const file = path.join(dir, FILE);
    if (!jobs.length) {
        if (fs.existsSync(file)) retrying(() => fs.unlinkSync(file));
        return;
    }
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, jobs }, null, 1));
    retrying(() => fs.renameSync(tmp, file));
}

/**
 * The notes under `dir` (the app's userData). No method throws: a note that cannot be written only means a crashed
 * run's result is not brought back. `pushedOut(entries)` hears the notes a full file pushed out (the oldest past
 * MAX_ENTRIES, after the ones past MAX_AGE_MS that a read would drop anyway), so they can be named in the log.
 */
function store(dir, { pushedOut = null } = {}) {
    const change = (fn) => { try { const jobs = read(dir, true); const next = fn(jobs); if (next) write(dir, next); } catch (_) { /* see above */ } };
    return {
        dir,
        add(entry) {
            settled.delete(String(entry.jobId));
            let out = [];
            change((jobs) => {
                const rest = jobs.filter((e) => e.jobId !== String(entry.jobId));
                rest.push({ jobId: String(entry.jobId), model: entry.model || null, recipe: entry.recipe || null, node: entry.node || null, saveId: entry.saveId != null ? String(entry.saveId) : null, started: +entry.started || Date.now() });
                if (rest.length <= MAX_ENTRIES) return rest;
                const now = Date.now();
                const young = rest.filter((e) => now - (+e.started || 0) < MAX_AGE_MS);
                out = young.length > MAX_ENTRIES ? young.slice(0, young.length - MAX_ENTRIES) : [];
                return young.slice(-MAX_ENTRIES);
            });
            if (out.length && typeof pushedOut === "function") { try { pushedOut(out); } catch (_) { /* a log line only */ } }
        },
        remove(jobId) { this.drop([jobId]); },
        /** Takes out the notes of these jobs alone; a note added meanwhile (a run that started) stays. */
        drop(ids) {
            const gone = new Set((ids || []).map(String));
            if (!gone.size) return;
            for (const id of gone) settle(id);
            change((jobs) => { const left = jobs.filter((e) => !gone.has(e.jobId)); return left.length === jobs.length ? null : left; });
        },
        list() { return read(dir); },
        /** Writes exactly these notes (the tests' seed). */
        keep(jobs) { for (const e of jobs || []) settled.delete(String(e && e.jobId)); try { write(dir, jobs); } catch (_) { /* see above */ } },
    };
}

module.exports = { store, flying, settled, MAX_AGE_MS, FILE, KEPT };
