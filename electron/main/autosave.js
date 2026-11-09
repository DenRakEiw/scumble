// The autosaved editor state and its earlier generations (docs/PLAN_0_1_29.md §3, quit safety). Plain Node: no
// electron, so tools/quit_test.js runs it on a scratch folder.
//
// autosave.json is the bundle renderer/editor/host.js bundle() writes (every open document's getValue(), the active
// one, the id counter), written whole to a temporary file and renamed over the old one. The pixels are not in it:
// each document names its layer files in the local file mirror (%APPDATA%/Scumble/files).
//
// Generations: when the app starts (with a window or for an agent), the state of the last session becomes
// autosave.1.json and the one before autosave.2.json (only when it holds other files, so two quick starts do not push
// out an older state). A state set aside after the window crashed twice is autosave.crash.json, the one set aside
// before it autosave.crash.1.json. Settings › Local files opens any of them as tabs, and pruning the file mirror keeps
// the files they name.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const FILE = "autosave.json";
const GENERATIONS = [
    { id: "1", file: "autosave.1.json", label: "the last session" },
    { id: "2", file: "autosave.2.json", label: "the session before that" },
    { id: "crash", file: "autosave.crash.json", label: "set aside after a crash" },
    { id: "crash.1", file: "autosave.crash.1.json", label: "set aside after an earlier crash" },
];

const READ_FAIL_COOLDOWN_MS = 2000;
const readFailUntil = new Map();
const unreadableCurrent = new Set();

function retrying(op, tries = 4) {
    for (let i = 0; ; i++) {
        try { return op(); } catch (err) {
            if (i >= tries || !/^(EPERM|EBUSY|EACCES)$/.test(String(err && err.code))) throw err;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
        }
    }
}

function setAsideDamaged(file) {
    let dest = file + ".damaged";
    for (let i = 1; fs.existsSync(dest); i++) dest = `${file}.damaged.${i}`;
    try {
        retrying(() => fs.renameSync(file, dest));
        return path.basename(dest);
    } catch (_) {
        return null;
    }
}

function readState(file) {
    const key = path.resolve(file);
    const isCurrent = path.basename(key) === FILE;
    const cooling = (readFailUntil.get(key) || 0) > Date.now();
    let raw;
    try {
        raw = retrying(() => fs.readFileSync(file, "utf8"), cooling ? 0 : 4);
        readFailUntil.delete(key);
    } catch (err) {
        if (err && err.code === "ENOENT") {
            readFailUntil.delete(key);
            if (isCurrent) unreadableCurrent.delete(key);
            return { status: "missing", data: null };
        }
        if (!cooling) {
            readFailUntil.set(key, Date.now() + READ_FAIL_COOLDOWN_MS);
            console.warn("autosave read:", file, err.message);
        }
        if (isCurrent) unreadableCurrent.add(key);
        return { status: "error", data: null, error: err };
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        if (isCurrent) unreadableCurrent.delete(key);
        return { status: "ok", data: parsed };
    } catch (err) {
        console.warn("autosave damaged:", file, err.message);
        const aside = setAsideDamaged(file);
        if (aside && isCurrent) unreadableCurrent.delete(key);
        else if (!aside && isCurrent) unreadableCurrent.add(key);
        return { status: "damaged", data: null, aside };
    }
}

function readJson(file) {
    return readState(file).data;
}

/** Write `value` as JSON to `file` whole: a temporary file first, flushed to disk and renamed over the old one. */
function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    const buf = Buffer.from(JSON.stringify(value) + "\n", "utf8");
    const fd = fs.openSync(tmp, "w");
    let ok = false;
    try {
        for (let off = 0; off < buf.length; ) {
            const n = fs.writeSync(fd, buf, off, buf.length - off);
            if (!(n > 0)) throw Object.assign(new Error("short write"), { code: "EIO" });
            off += n;
        }
        fs.fsyncSync(fd);
        ok = true;
    } finally {
        try { fs.closeSync(fd); } catch (_) { /* ignore */ }
        if (!ok) { try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ } }
    }
    retrying(() => fs.renameSync(tmp, file));
}

function fileOf(dir, gen) {
    if (gen == null || gen === "" || gen === 0 || gen === "0") return path.join(dir, FILE);
    const g = GENERATIONS.find((x) => x.id === String(gen));
    if (!g) throw new Error(`no autosave generation "${gen}"`);
    return path.join(dir, g.file);
}

/** The state string of the current autosave (gen omitted) or of a generation ("1", "2", "crash"); null when none. */
function load(dir, gen) {
    const r = readState(fileOf(dir, gen));
    if (r.status === "error") throw r.error;
    const s = r.data;
    return s && typeof s.state === "string" ? s.state : null;
}

function save(dir, state) {
    const cur = path.join(dir, FILE);
    const key = path.resolve(cur);
    if (unreadableCurrent.has(key) && fs.existsSync(cur)) {
        rotate(dir);
        if (unreadableCurrent.has(key) && fs.existsSync(cur)) {
            const aside = setAsideDamaged(cur);
            if (!aside) throw new Error("autosave.json is unreadable and could not be set aside");
            unreadableCurrent.delete(key);
        }
    }
    writeJson(cur, { state: String(state || ""), time: Date.now() });
    unreadableCurrent.delete(key);
}

/** The mirror keys a state string names, sorted and joined: two states with the same files hold the same pictures. */
function filesOf(state) {
    const keys = new Set();
    let bundle = null;
    try { bundle = JSON.parse(state); } catch (_) { return ""; }
    for (const d of (bundle && Array.isArray(bundle.docs) ? bundle.docs : [])) {
        try { walkRefs(JSON.parse(d.state), keys); } catch (_) { /* an empty document */ }
    }
    return Array.from(keys).sort().join("\n");
}

/**
 * The same state for the rotation: the same text, or the same documents naming the same files. A restore writes the
 * state back re-serialized (a selection encoded again, settings in another order); that is not a new session's work.
 */
function sameState(a, b) {
    if (a === b) return true;
    const sa = summary(a), sb = summary(b);
    return sa.docs === sb.docs && sa.pictures > 0 && filesOf(a) === filesOf(b);
}

/** What a state string holds: its documents and whether any names a file (a document with a picture). */
function summary(state) {
    let bundle = null;
    try { bundle = JSON.parse(state); } catch (_) { bundle = null; }
    const docs = bundle && Array.isArray(bundle.docs) ? bundle.docs : [];
    let pictures = 0;
    for (const d of docs) {
        const keys = new Set();
        try { walkRefs(JSON.parse(d.state), keys); } catch (_) { /* an empty document */ }
        if (keys.size) pictures++;
    }
    return { docs: docs.length, pictures };
}

/**
 * At the start of a windowed app: the last session's state becomes generation 1 and generation 1 becomes 2. Nothing
 * moves when there is no autosave, or when it holds the same state as generation 1 (a second start in a row, a start
 * that restored and closed again): generation 2 then keeps an older state. Returns what it did.
 */
function rotate(dir) {
    const cur = path.join(dir, FILE), one = path.join(dir, GENERATIONS[0].file), two = path.join(dir, GENERATIONS[1].file);
    const nowRes = readState(cur);
    if (nowRes.status === "error") return { rotated: false, why: "autosave unreadable" };
    const now = nowRes.data;
    if (!now || typeof now.state !== "string") return { rotated: false, why: "no autosave" };
    const prevRes = readState(one);
    if (prevRes.status === "error") return { rotated: false, why: "generation 1 unreadable" };
    const prev = prevRes.data;
    if (prev && sameState(prev.state, now.state)) return { rotated: false, why: "the same as generation 1" };
    if (!summary(now.state).pictures && prev && summary(prev.state).pictures) {
        // an empty session never pushes out one with pictures (a start whose restore failed and was closed again)
        return { rotated: false, why: "no picture in the last session; generation 1 keeps the one before" };
    }
    if (fs.existsSync(one)) retrying(() => fs.renameSync(one, two));
    writeJson(one, now);
    return { rotated: true };
}

/**
 * Set the current autosave aside as the crash generation (the window crashed twice while it restored it); the crash
 * copy before goes to crash.1. Nothing moves when the autosave holds no picture (a safe start that crashed again) or
 * the same state as the crash copy: an empty or repeated state never pushes out the documents set aside.
 */
function setAside(dir) {
    const now = readJson(path.join(dir, FILE));
    if (!now || typeof now.state !== "string") return false;
    if (!summary(now.state).pictures) return false;
    const crash = path.join(dir, GENERATIONS[2].file), older = path.join(dir, GENERATIONS[3].file);
    const prevRes = readState(crash);
    if (prevRes.status === "error") return false;
    const prev = prevRes.data;
    if (prev && typeof prev.state === "string" && sameState(prev.state, now.state)) return false;
    if (prev) retrying(() => fs.renameSync(crash, older));
    writeJson(crash, { ...now, setAside: Date.now() });
    return true;
}

/** The earlier states there are: [{ id, label, time, docs, pictures, bytes }], newest kind first. */
function generations(dir) {
    const out = [];
    for (const g of GENERATIONS) {
        const file = path.join(dir, g.file);
        let st = null;
        try { st = fs.statSync(file); } catch (_) { continue; }
        const s = readJson(file);
        if (!s || typeof s.state !== "string") continue;
        out.push({ id: g.id, label: g.label, time: s.time || st.mtimeMs, ...summary(s.state), bytes: st.size });
    }
    return out;
}

/** Every file ref ({ filename, subfolder, type }) in a parsed document state, as the mirror's keys (host.js referencedFileKeys). */
function walkRefs(v, keys) {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) walkRefs(x, keys); return; }
    if (typeof v.filename === "string") keys.add(`${v.type || "input"}/${v.subfolder || ""}/${v.filename}`);
    for (const x of Object.values(v)) walkRefs(x, keys);
}

/** The mirror keys the earlier generations name, which pruning the mirror must keep. */
function referencedKeys(dir) {
    const keys = new Set();
    for (const g of GENERATIONS) {
        const r = readState(path.join(dir, g.file));
        if (r.status === "error") throw r.error;
        const s = r.data;
        if (!s || typeof s.state !== "string") continue;
        let bundle = null;
        try { bundle = JSON.parse(s.state); } catch (_) { continue; }
        const docs = bundle && Array.isArray(bundle.docs) ? bundle.docs : [];
        for (const d of docs) {
            if (!d || typeof d.state !== "string") continue;
            try { walkRefs(JSON.parse(d.state), keys); } catch (_) { /* an empty document */ }
            walkRefs(d.plugins, keys);        // per-document plugin data (a 3D layer's model file), docs/PLAN_DOCUMENTS.md §3.6
            walkRefs(d.extra, keys);          // a newer document's unknown fields
        }
        // the closed tabs of that session (Reopen Closed Tab, docs/PLAN_DOCUMENTS.md §5.4)
        for (const c of bundle && Array.isArray(bundle.closed) ? bundle.closed : []) {
            if (!c || typeof c.state !== "string") continue;
            try { walkRefs(JSON.parse(c.state), keys); } catch (_) { /* an empty state */ }
            walkRefs(c.plugins, keys);
            walkRefs(c.extra, keys);
        }
    }
    return Array.from(keys);
}

module.exports = { FILE, GENERATIONS, load, save, rotate, setAside, generations, referencedKeys, summary, sameState, walkRefs };
