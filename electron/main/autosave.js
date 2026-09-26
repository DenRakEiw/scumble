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

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; }
}

/** Write `value` as JSON to `file` whole: a temporary file first, renamed over the old one. */
function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(value) + "\n", "utf8");
    fs.renameSync(tmp, file);
}

function fileOf(dir, gen) {
    if (gen == null || gen === "" || gen === 0 || gen === "0") return path.join(dir, FILE);
    const g = GENERATIONS.find((x) => x.id === String(gen));
    if (!g) throw new Error(`no autosave generation "${gen}"`);
    return path.join(dir, g.file);
}

/** The state string of the current autosave (gen omitted) or of a generation ("1", "2", "crash"); null when none. */
function load(dir, gen) {
    const s = readJson(fileOf(dir, gen));
    return s && typeof s.state === "string" ? s.state : null;
}

function save(dir, state) {
    writeJson(path.join(dir, FILE), { state: String(state || ""), time: Date.now() });
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
    const now = readJson(cur);
    if (!now || typeof now.state !== "string") return { rotated: false, why: "no autosave" };
    const prev = readJson(one);
    if (prev && sameState(prev.state, now.state)) return { rotated: false, why: "the same as generation 1" };
    if (!summary(now.state).pictures && prev && summary(prev.state).pictures) {
        // an empty session never pushes out one with pictures (a start whose restore failed and was closed again)
        return { rotated: false, why: "no picture in the last session; generation 1 keeps the one before" };
    }
    if (fs.existsSync(one)) fs.renameSync(one, two);
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
    const prev = readJson(crash);
    if (prev && typeof prev.state === "string" && sameState(prev.state, now.state)) return false;
    if (prev) fs.renameSync(crash, older);
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
        const s = readJson(path.join(dir, g.file));
        if (!s || typeof s.state !== "string") continue;
        let bundle = null;
        try { bundle = JSON.parse(s.state); } catch (_) { continue; }
        const docs = bundle && Array.isArray(bundle.docs) ? bundle.docs : [];
        for (const d of docs) {
            if (!d || typeof d.state !== "string") continue;
            try { walkRefs(JSON.parse(d.state), keys); } catch (_) { /* an empty document */ }
            walkRefs(d.plugins, keys);        // per-document plugin data (a 3D layer's model file), docs/PLAN_DOCUMENTS.md §3.6
        }
        // the closed tabs of that session (Reopen Closed Tab, docs/PLAN_DOCUMENTS.md §5.4)
        for (const c of bundle && Array.isArray(bundle.closed) ? bundle.closed : []) {
            if (!c || typeof c.state !== "string") continue;
            try { walkRefs(JSON.parse(c.state), keys); } catch (_) { /* an empty state */ }
            walkRefs(c.plugins, keys);
        }
    }
    return Array.from(keys);
}

module.exports = { FILE, GENERATIONS, load, save, rotate, setAside, generations, referencedKeys, summary, sameState, walkRefs };
