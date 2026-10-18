// The Comfy Cloud jobs whose answer Scumble has not taken yet (docs/PLAN_COMFY_SDK.md S6): a run on the Comfy API v2
// notes its job here at the submit and takes it out at its end, so a crash or a quit while a job ran leaves the note
// (and so does a run whose job finished or may still run but whose picture never came: comfycloud.runV2). At the next
// start the window asks once, after its documents are back (comfycloud.recoverJobs through providers/index.js): a job
// that finished meanwhile comes back as a picture the window opens as a document of its own, and its note goes only
// when the window says it has it (ack). Nothing is ever sent again; only a job's own result is read.
//
// <userData>/cloudjobs.json: { version: 1, jobs: [{ jobId, model, node, saveId, started }] }, written whole (a temp
// file, then a rename). A note older than MAX_AGE_MS is dropped unread (Comfy keeps a job's outputs for a limited time).
// Every change is one synchronous read-modify-write, so the notes of runs that end at the same time never overwrite
// each other (one main process holds the data folder).
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 50;
const FILE = "cloudjobs.json";

function read(dir) {
    try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, FILE), "utf8"));
        return Array.isArray(j && j.jobs) ? j.jobs.filter((e) => e && typeof e.jobId === "string" && e.jobId) : [];
    } catch (_) { return []; }
}

/** An unlink or a rename, tried again a few times when Windows holds the file a moment (a scanner, an indexer). */
function retrying(op) {
    for (let i = 0; ; i++) {
        try { op(); return; } catch (err) {
            if (i >= 4 || !/^(EPERM|EBUSY|EACCES)$/.test(String(err && err.code))) throw err;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
        }
    }
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
 * run's result is not brought back.
 */
function store(dir) {
    const change = (fn) => { try { const jobs = read(dir); const next = fn(jobs); if (next) write(dir, next); } catch (_) { /* see above */ } };
    return {
        dir,
        add(entry) {
            change((jobs) => {
                const rest = jobs.filter((e) => e.jobId !== String(entry.jobId));
                rest.push({ jobId: String(entry.jobId), model: entry.model || null, node: entry.node || null, saveId: entry.saveId != null ? String(entry.saveId) : null, started: +entry.started || Date.now() });
                return rest.slice(-MAX_ENTRIES);
            });
        },
        remove(jobId) { this.drop([jobId]); },
        /** Takes out the notes of these jobs alone; a note added meanwhile (a run that started) stays. */
        drop(ids) {
            const gone = new Set((ids || []).map(String));
            if (!gone.size) return;
            change((jobs) => { const left = jobs.filter((e) => !gone.has(e.jobId)); return left.length === jobs.length ? null : left; });
        },
        list() { return read(dir); },
        /** Writes exactly these notes (the tests' seed). */
        keep(jobs) { try { write(dir, jobs); } catch (_) { /* see above */ } },
    };
}

module.exports = { store, MAX_AGE_MS, FILE };
