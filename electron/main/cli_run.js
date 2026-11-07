// `Scumble --run <steps.json>` and `Scumble --run -` (the steps from stdin): several commands in one call, on one
// backend, for batch work from a terminal (CLAUDE.md item 69, docs/MCP.md "Batches: --run").
//
// The file is a plain array of steps, `[{"cmd": "<name>", "args": {...}}, ...]`, JSON lines (one step per line), or an
// object `{"files": ["<path or glob>", ...], "steps": [...], "keep_going": false}` whose steps run once per file, with
// {file} {dir} {name} {stem} {ext} {index} filled into every string of `args`. One JSON line per step goes to stdout,
// then a summary line; the exit code is 0 only when no step failed (1: a step failed or Scumble could not be reached;
// 2: the steps file could not be used, nothing ran).
//
// Plain Node, no Electron import: main.js hands in its AgentBackend (`describe()`, `run(name, args)`), and
// tools/cli_run_test.js hands in a fake one.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** The placeholders a file fills into the strings of a step's args. */
const PLACEHOLDER = /\{(file|dir|name|stem|ext|index)\}/g;
/** Commands that write their `path`: its folder is made when it is missing. */
const WRITES = new Set(["export", "export_layer", "export_mask", "save_document"]);
/** Commands whose answer is a document (its `id`): the file's later steps go to it. */
const OPENS = new Set(["new_document", "open_document"]);
const STEP_KEYS = new Set(["cmd", "args", "comment"]);
const PLAN_KEYS = new Set(["files", "steps", "keep_going", "comment"]);

/** An error in the steps file or its files: nothing runs, exit code 2. */
class PlanError extends Error {}

const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/** One step checked: { cmd, args } (args a fresh object). `where` names it in an error ("step 3", "line 4"). */
function checkStep(raw, where) {
    if (!isObject(raw)) throw new PlanError(`${where}: a step is an object {"cmd": "<name>", "args": {...}}, not ${JSON.stringify(raw)}`);
    for (const k of Object.keys(raw)) {
        if (!STEP_KEYS.has(k)) throw new PlanError(`${where}: unknown key "${k}" (a step is {"cmd": "<name>", "args": {...}}: the command's parameters go into args)`);
    }
    if (typeof raw.cmd !== "string" || !raw.cmd.trim()) throw new PlanError(`${where}: "cmd" must name a command`);
    if (raw.args != null && !isObject(raw.args)) throw new PlanError(`${where}: "args" must be an object of the command's parameters`);
    return { cmd: raw.cmd.trim(), args: raw.args ? { ...raw.args } : {} };
}

/** A plan from an object, an array or a list of JSON lines' values: { steps, files (null: none), keepGoing }. */
function planFrom(value, lines) {
    if (Array.isArray(value)) {
        if (!value.length) throw new PlanError("no steps: the array is empty");
        return { steps: value.map((s, i) => checkStep(s, lines ? `line ${lines[i]}` : `step ${i + 1}`)), files: null, keepGoing: false };
    }
    if (!isObject(value)) throw new PlanError("the steps must be an array of steps, JSON lines of steps, or an object with steps");
    // one JSON line, or a file holding a single step
    if (value.cmd !== undefined && value.steps === undefined) return { steps: [checkStep(value, lines ? `line ${lines[0]}` : "step 1")], files: null, keepGoing: false };
    for (const k of Object.keys(value)) {
        if (!PLAN_KEYS.has(k)) throw new PlanError(`unknown key "${k}" (the object takes files, steps, keep_going and comment)`);
    }
    if (!Array.isArray(value.steps) || !value.steps.length) throw new PlanError('"steps" must be a non-empty array of steps');
    const steps = value.steps.map((s, i) => checkStep(s, `step ${i + 1}`));
    let files = null;
    if (value.files !== undefined) {
        const list = typeof value.files === "string" ? [value.files] : value.files;
        if (!Array.isArray(list) || !list.length || !list.every((f) => typeof f === "string" && f.trim())) throw new PlanError('"files" must be a non-empty array of paths or globs');
        files = list.map((f) => f.trim());
    }
    if (value.keep_going !== undefined && typeof value.keep_going !== "boolean") throw new PlanError('"keep_going" must be true or false');
    return { steps, files, keepGoing: value.keep_going === true };
}

/**
 * The text of a steps file -> { steps: [{ cmd, args }], files: [pattern] | null, keepGoing }. Takes one JSON value (an
 * array of steps, one step, or the object form) or JSON lines (one step per line; empty lines are skipped). Throws a
 * PlanError naming the line or the step.
 */
function parseSteps(text) {
    const raw = String(text == null ? "" : text);
    const s = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;   // a byte order mark (Notepad, PowerShell)
    if (!s.trim()) throw new PlanError("no steps: the input is empty");
    let whole;
    try { whole = JSON.parse(s); } catch (err) { whole = undefined; }
    if (whole !== undefined) return planFrom(whole, null);
    // JSON lines
    const values = [], at = [];
    const rows = s.split(/\r?\n/);
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i].trim();
        if (!row) continue;
        let v;
        try { v = JSON.parse(row); } catch (err) { throw new PlanError(`line ${i + 1} is not JSON: ${err.message}`); }
        values.push(v); at.push(i + 1);
    }
    if (values.some((v) => !isObject(v))) {
        const k = values.findIndex((v) => !isObject(v));
        throw new PlanError(`line ${at[k]}: JSON lines hold one step object per line`);
    }
    return planFrom(values, at);
}

/** A file name pattern with * and ? as a RegExp over the whole name (case-insensitive on Windows). */
function globRegex(pattern, platform = process.platform) {
    const body = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/\\\\]*").replace(/\?/g, "[^/\\\\]");
    return new RegExp("^" + body + "$", platform === "win32" ? "i" : "");
}

const COLLATE = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const byName = (a, b) => COLLATE.compare(path.basename(a), path.basename(b)) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * The files of a plan: each pattern against `cwd` (absolute paths as they are). A pattern with * or ? in its last part
 * lists that folder's files whose names match, sorted by name (numbers in names in their order: 2 before 10); a plain
 * path must be a file. Duplicates go (the first stays). Throws a PlanError for a missing plain file, a wildcard in a
 * folder part, an unreadable folder or an empty result.
 */
function expandFiles(patterns, cwd, { fsImpl = fs, platform = process.platform } = {}) {
    const out = [], seen = new Set();
    const add = (p) => { const k = platform === "win32" ? p.toLowerCase() : p; if (!seen.has(k)) { seen.add(k); out.push(p); } };
    for (const pattern of patterns) {
        const abs = path.resolve(cwd, pattern);
        const dir = path.dirname(abs), base = path.basename(abs);
        if (/[*?]/.test(dir)) throw new PlanError(`${pattern}: wildcards (* ?) go in the file name only, not in a folder`);
        if (!/[*?]/.test(base)) {
            let st = null;
            try { st = fsImpl.statSync(abs); } catch (_) { st = null; }
            if (!st || !st.isFile()) throw new PlanError(`no file ${abs}`);
            add(abs);
            continue;
        }
        let entries;
        try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch (err) { throw new PlanError(`${pattern}: cannot read the folder ${dir} (${err.code || err.message})`); }
        const re = globRegex(base, platform);
        const hits = [];
        for (const e of entries) {
            if (!re.test(e.name)) continue;
            const p = path.join(dir, e.name);
            let file = e.isFile();
            if (!file && e.isSymbolicLink()) { try { file = fsImpl.statSync(p).isFile(); } catch (_) { file = false; } }
            if (file) hits.push(p);
        }
        hits.sort(byName);
        for (const p of hits) add(p);
    }
    if (!out.length) throw new PlanError(`no file matches ${patterns.join(", ")}`);
    return out;
}

/** The placeholders of one file: {file} its absolute path, {dir}, {name} (with extension), {stem}, {ext} (no dot), {index} (1-based). */
function fileVars(file, index) {
    const name = path.basename(file), ext = path.extname(name);
    return { file, dir: path.dirname(file), name, stem: ext ? name.slice(0, -ext.length) : name, ext: ext.slice(1), index: String(index) };
}

/** Every string inside `value` (objects and arrays deep) with the placeholders of `vars` filled; unknown ones stay. */
function fill(value, vars) {
    if (!vars) return value;
    if (typeof value === "string") return value.replace(PLACEHOLDER, (m, k) => vars[k]);
    if (Array.isArray(value)) return value.map((v) => fill(v, vars));
    if (isObject(value)) { const o = {}; for (const [k, v] of Object.entries(value)) o[k] = fill(v, vars); return o; }
    return value;
}

/**
 * Run a plan on `backend` ({ describe(), run(name, args) }): each file's steps in order (once without files), one line
 * per step through `write`. A failing step skips the rest of its file's steps, except a close_document step while the
 * file's steps opened a document that is still open (so a failed file leaves no tab behind), and stops the run unless
 * `keepGoing`. A file's new_document / open_document answer pins its later steps to that document (`doc`, unless a step
 * gives its own). A relative `path` is taken against `cwd`; export, export_layer, export_mask and save_document make
 * their path's folder; a command with a `timeout` parameter gets its default when the step gives none (so the call waits
 * for the command's own end). -> { code, summary }
 */
async function runPlan(plan, backend, { cwd = process.cwd(), write, keepGoing = false, now = Date.now, files = null, mkdir = (d) => fs.mkdirSync(d, { recursive: true }) } = {}) {
    const t0 = now();
    const table = await backend.describe();
    const cmds = new Map((Array.isArray(table) ? table : []).map((c) => [c.name, c]));
    // an MCP tool name (film_apply_look) for a plugin command (film.apply_look)
    const alias = new Map([...cmds.keys()].filter((n) => n.includes(".")).map((n) => [n.replace(/\./g, "_"), n]));
    const resolveName = (n) => (cmds.has(n) ? n : alias.get(n) || n);
    const list = files || [null];
    const keep = keepGoing || plan.keepGoing;
    let ran = 0, failed = 0, skipped = 0, filesFailed = 0, stopped = false;
    for (let f = 0; f < list.length; f++) {
        if (stopped) { skipped += plan.steps.length; continue; }
        const file = list[f];
        const vars = file ? fileVars(file, f + 1) : null;
        let doc = null, owned = false, broke = false;
        for (let i = 0; i < plan.steps.length; i++) {
            const step = plan.steps[i];
            const name = resolveName(step.cmd);
            const desc = cmds.get(name);
            // after a failure only the clean-up of a document this file's steps opened
            if (broke && !(name === "close_document" && doc != null && owned)) { skipped++; continue; }
            const args = fill(step.args, vars);
            if (typeof args.path === "string" && args.path.trim() && !path.isAbsolute(args.path.trim())) args.path = path.resolve(cwd, args.path.trim());
            if (doc != null && desc && desc.scope !== "app" && (args.doc == null || args.doc === "")) args.doc = doc;
            const tp = desc && desc.params && desc.params.timeout;
            if (tp && Number.isFinite(+tp.default) && (args.timeout == null || args.timeout === "")) args.timeout = +tp.default;
            const s0 = now();
            let line;
            try {
                if (WRITES.has(name) && typeof args.path === "string" && args.path.trim()) mkdir(path.dirname(args.path));
                const result = await backend.run(name, args);
                line = { index: i + 1, file, cmd: name, ok: true, result: result === undefined ? null : result, ms: now() - s0 };
                if (OPENS.has(name) && result && result.id != null) { doc = result.id; owned = !result.already; }
                if (name === "close_document" && (args.doc == null || String(args.doc) === String(doc))) { doc = null; owned = false; }
            } catch (err) {
                line = { index: i + 1, file, cmd: name, ok: false, error: String((err && err.message) || err), ms: now() - s0 };
            }
            ran++;
            if (!line.ok) { failed++; broke = true; }
            await write(line);
        }
        if (broke) {
            filesFailed++;
            if (!keep) stopped = true;
        }
    }
    const summary = { done: true, steps: ran, failed, skipped, files: files ? files.length : 0, files_failed: filesFailed, stopped, ms: now() - t0 };
    await write(summary);
    return { code: failed ? 1 : 0, summary };
}

/** All of fd 0 as text (the main process never sees `data` on process.stdin from a pipe on Windows: CLAUDE.md traps). */
function readFd0() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let s;
        try { s = fs.createReadStream(null, { fd: 0 }); } catch (err) { reject(err); return; }
        s.on("data", (c) => chunks.push(c));
        s.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        s.on("error", (err) => (err && err.code === "EOF" ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(err)));
    });
}

/**
 * The whole of --run: read the steps (`source` a path against `cwd`, or "-" for stdin), expand the files, run them on
 * `backend`, write the lines to `stdout`. Returns the exit code (0, 1 or 2); a run that cannot start ends with one line
 * { done: false, error } on stdout and the message on stderr.
 */
async function main({ source, keepGoing = false, backend, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, readStdin = readFd0, now = Date.now } = {}) {
    if (stdout && typeof stdout.on === "function") stdout.on("error", () => { /* the reader went away (a closed pipe) */ });
    const write = (obj) => new Promise((resolve) => {
        try { stdout.write(JSON.stringify(obj) + "\n", () => resolve()); } catch (_) { resolve(); }
    });
    const fail = async (message, code) => {
        try { stderr.write("scumble: " + message + "\n"); } catch (_) { /* nowhere to say it */ }
        await write({ done: false, error: message });
        return code;
    };
    let plan, files = null;
    try {
        if (!source) throw new PlanError("--run needs a steps file, or - for the steps on stdin");
        let text;
        if (source === "-") text = await readStdin();
        else {
            const p = path.resolve(cwd, source);
            try { text = fs.readFileSync(p, "utf8"); } catch (err) { throw new PlanError(`cannot read ${p} (${err.code || err.message})`); }
        }
        plan = parseSteps(text);
        if (plan.files) files = expandFiles(plan.files, cwd);
    } catch (err) {
        return fail(String((err && err.message) || err), err instanceof PlanError ? 2 : 1);
    }
    try {
        const { code } = await runPlan(plan, backend, { cwd, write, keepGoing, now, files });
        return code;
    } catch (err) {
        // the backend could not be reached (no Scumble with --attach-only, an editor that never became ready)
        return fail(String((err && err.message) || err), 1);
    }
}

module.exports = { main, parseSteps, expandFiles, fileVars, fill, runPlan, globRegex, readFd0, PlanError, WRITES, OPENS };
