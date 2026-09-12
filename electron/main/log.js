// The app's log: one place both processes write to, a ring buffer for the console panel and a
// file under <userData>/logs/scumble.log (rotated at 1 MB into scumble.1.log, two files kept).
// The main process is where every provider adapter, the ONNX runtime, the mirror and the MCP
// bridge run, and a packaged Windows GUI exe shows no stdout, so console.log / warn / error of
// this process are patched to land here too; the renderer forwards its console and its
// uncaught errors over IPC (log:add). Entries carry a monotonic id so the panel asks for
// "everything after N".
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const RING = 2000;
const ROTATE_BYTES = 1024 * 1024;
const MAX_MESSAGE = 2000;
const MAX_DETAIL = 8000;

const entries = [];
let nextId = 1;
let listeners = [];
let dir = null;
let queue = Promise.resolve();
let installed = false;
let size = -1;               // the current file's size, kept up to date so rotation needs no stat per line

function setDir(d) { dir = d; size = -1; }
function file() { return dir ? path.join(dir, "scumble.log") : null; }

function stringify(v) {
    if (v == null) return "";
    if (v instanceof Error) return (v.stack || v.message || String(v));
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch (_) { return String(v); }
}

function stamp(d = new Date()) {
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Append one line to the file; rotation when the file has grown past the limit. Never synchronous, never throws. */
function write(line) {
    const f = file();
    if (!f) return;
    queue = queue.then(async () => {
        await fsp.mkdir(dir, { recursive: true });
        if (size < 0) { try { size = (await fsp.stat(f)).size; } catch (_) { size = 0; } }
        if (size > ROTATE_BYTES) {
            try { await fsp.rename(f, path.join(dir, "scumble.1.log")); } catch (_) { /* nothing to rotate */ }
            size = 0;
        }
        await fsp.appendFile(f, line + "\n");
        size += Buffer.byteLength(line) + 1;
    }).catch(() => { /* a log must never take the app down */ });
    return queue;
}

/**
 * Record an entry: level info | warn | error, source a short tag (main, renderer, fal,
 * comfycloud, onnx, mcp, update ...), message a string, detail anything JSON-able (cut to
 * 8000 characters; never a key, never image bytes: the callers see to that).
 */
function record({ level = "info", source = "main", message = "", detail = null, time = null } = {}) {
    const e = {
        id: nextId++,
        time: time || Date.now(),
        level: level === "error" || level === "warn" ? level : "info",
        source: String(source || "main").slice(0, 32),
        message: stringify(message).slice(0, MAX_MESSAGE),
        detail: detail == null ? null : stringify(detail).slice(0, MAX_DETAIL),
    };
    entries.push(e);
    if (entries.length > RING) entries.splice(0, entries.length - RING);
    write(`${stamp(new Date(e.time))} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.message.replace(/\r?\n/g, " | ")}${e.detail ? "  " + e.detail.replace(/\r?\n/g, " | ") : ""}`);
    for (const fn of listeners) { try { fn(e); } catch (_) { /* a listener must not break the log */ } }
    return e;
}

/** Entries after `after` (an id), at most `limit`; the whole ring by default. */
function list({ after = 0, limit = RING } = {}) {
    const from = after > 0 ? entries.findIndex((e) => e.id > after) : 0;
    if (from < 0) return [];
    return entries.slice(from, from + Math.max(1, Math.min(RING, limit | 0 || RING)));
}

function clear() { entries.length = 0; }

function onEntry(fn) { listeners.push(fn); return () => { listeners = listeners.filter((x) => x !== fn); }; }

/** Wait for the file to hold everything recorded so far (tests). */
function flush() { return queue; }

/**
 * Patch this process's console so existing console.log / warn / error calls land here (the
 * original still prints, for a dev terminal), and record uncaught errors before anything
 * else sees them.
 */
function install(logDir) {
    setDir(logDir);
    if (installed) return;
    installed = true;
    const wrap = (name, level) => {
        const orig = console[name].bind(console);
        console[name] = (...args) => {
            try {
                const first = args.length && typeof args[0] === "string" ? args[0] : "";
                const m = /^\[([a-z0-9_-]+)\]\s*/i.exec(first);   // "[fal] ..." from an adapter's ctx.log: the tag is the source
                const source = m ? m[1] : "main";
                const parts = m ? [first.slice(m[0].length), ...args.slice(1)] : args;
                record({ level, source, message: parts.map(stringify).join(" ") });
            } catch (_) { /* never */ }
            orig(...args);
        };
    };
    wrap("log", "info"); wrap("info", "info"); wrap("warn", "warn"); wrap("error", "error");
    process.on("uncaughtException", (err) => { record({ level: "error", source: "main", message: "uncaught: " + (err && err.message), detail: err && err.stack }); });
    process.on("unhandledRejection", (err) => { record({ level: "error", source: "main", message: "unhandled rejection: " + ((err && err.message) || err), detail: err && err.stack }); });
    record({ source: "main", message: `log started, ${path.join(logDir, "scumble.log")}` });
}

module.exports = { install, record, list, clear, onEntry, flush, file, setDir, ROTATE_BYTES, RING };
