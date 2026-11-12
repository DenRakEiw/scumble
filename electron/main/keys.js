// Secrets (API keys, the auth secret of a remote ComfyUI) encrypted with Electron's
// safeStorage: DPAPI on Windows, Keychain on macOS, the keyring (or basic text) on Linux.
// The ciphertexts live in <userData>/secrets.json; nothing secret ever goes into
// settings.json or a recipe. The renderer only ever sees whether a key is set and its
// last four characters.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, safeStorage } = require("electron");

const FILE = "secrets.json";
const READ_FAIL_COOLDOWN_MS = 2000;
let readFailUntil = 0;
let damagedNotice = null;
// a damaged secrets.json that could not be set aside: its size and time, so it is not parsed, renamed (a 250 ms block
// of the main process) and logged again on every read (settings.js does the same)
let stuckDamaged = null;

function stamp(p) {
    try { const st = fs.statSync(p); return `${st.size}:${st.mtimeMs}`; } catch (_) { return null; }
}

function file() {
    return path.join(app.getPath("userData"), FILE);
}

function retrying(op, tries = 4) {
    for (let i = 0; ; i++) {
        try { return op(); } catch (err) {
            if (i >= tries || !/^(EPERM|EBUSY|EACCES)$/.test(String(err && err.code))) throw err;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
        }
    }
}

function setAsideDamaged(p) {
    let dest = p + ".damaged";
    for (let i = 1; fs.existsSync(dest); i++) dest = `${p}.damaged.${i}`;
    try {
        retrying(() => fs.renameSync(p, dest));
        return path.basename(dest);
    } catch (_) {
        return null;
    }
}

function readAll(forWrite = false) {
    const p = file();
    if (stuckDamaged) {
        if (stamp(p) === stuckDamaged) {
            if (forWrite) throw new Error("secrets.json is damaged and could not be set aside; refusing to overwrite stored keys.");
            return {};
        }
        stuckDamaged = null;
    }
    const cooling = readFailUntil > Date.now();
    let raw;
    try {
        raw = retrying(() => fs.readFileSync(p, "utf8"), cooling ? 0 : 4);
        readFailUntil = 0;
    } catch (err) {
        if (err && err.code === "ENOENT") {
            readFailUntil = 0;
            return {};
        }
        if (!cooling) {
            readFailUntil = Date.now() + READ_FAIL_COOLDOWN_MS;
            console.warn("secrets read:", p, err.message);
        }
        if (forWrite) throw err;
        return {};
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        return parsed;
    } catch (err) {
        console.warn("secrets damaged:", p, err.message);
        const aside = setAsideDamaged(p);
        if (aside) {
            damagedNotice = `Your stored API keys were damaged and reset; the old file is kept as ${aside}, and keys must be entered again.`;
            return {};
        }
        stuckDamaged = stamp(p);
        damagedNotice = "Your stored API keys file (secrets.json) is damaged and could not be set aside, so no key can be read or saved until the file is moved or deleted.";
        if (forWrite) throw new Error("secrets.json is damaged and could not be set aside; refusing to overwrite stored keys.");
        return {};
    }
}

function writeAll(data) {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    const tmp = file() + ".tmp";
    const buf = Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf8");
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
    retrying(() => fs.renameSync(tmp, file()));
}

function available() {
    try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; }
}

/** How the secrets are protected, for the settings dialog. */
function backend() {
    if (!available()) return "unavailable";
    if (process.platform === "linux") { try { return safeStorage.getSelectedStorageBackend(); } catch (_) { return "unknown"; } }
    return process.platform === "win32" ? "dpapi" : "keychain";
}

/** The plain secret, or "" when unset or undecryptable. */
function get(name) {
    const all = readAll();
    const entry = all[name];
    if (!entry || !entry.data) return "";
    if (!available()) return "";
    try {
        return safeStorage.decryptString(Buffer.from(entry.data, "base64"));
    } catch (err) {
        console.warn("secret", name, "cannot be decrypted:", err.message);
        return "";
    }
}

function set(name, value) {
    const v = String(value == null ? "" : value).trim();
    if (!v) return clear(name);
    if (!available()) throw new Error("This system offers no credential store (safeStorage is unavailable); the key was not saved.");
    const all = readAll(true);
    all[name] = { data: safeStorage.encryptString(v).toString("base64"), hint: v.length > 6 ? v.slice(-4) : "", time: Date.now() };
    writeAll(all);
    return describe(name);
}

function clear(name) {
    const all = readAll(true);
    if (name in all) {
        delete all[name];
        writeAll(all);
    }
    return describe(name);
}

function takeDamagedNotice() {
    const n = damagedNotice;
    damagedNotice = null;
    return n;
}

/**
 * Whether a stored secret cannot be decrypted here: DPAPI binds it to the Windows account (and PC) that stored it, so
 * a portable copy taken to another PC or account holds keys it cannot read. Only reads: a stale entry is never
 * cleared or rewritten (the copy may go back to the PC that can read it); the user's new key replaces it through set().
 */
function stale(entry) {
    if (!entry || !entry.data || !available()) return false;
    try { safeStorage.decryptString(Buffer.from(entry.data, "base64")); return false; } catch (_) { return true; }
}

/** { set, hint, stale } for one secret; never the value. */
function describe(name) {
    const entry = readAll()[name];
    return { name, set: !!(entry && entry.data), hint: entry ? entry.hint || "" : "", time: entry ? entry.time : 0, stale: stale(entry) };
}

function list() {
    const out = {};
    for (const name of Object.keys(readAll())) out[name] = describe(name);
    return { backend: backend(), available: available(), keys: out };
}

module.exports = { get, set, clear, describe, list, available, backend, takeDamagedNotice };
