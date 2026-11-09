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

function file() {
    return path.join(app.getPath("userData"), FILE);
}

function retrying(op) {
    for (let i = 0; ; i++) {
        try { return op(); } catch (err) {
            if (i >= 4 || !/^(EPERM|EBUSY|EACCES)$/.test(String(err && err.code))) throw err;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
        }
    }
}

function readAll(forWrite = false) {
    const p = file();
    let raw;
    try {
        raw = retrying(() => fs.readFileSync(p, "utf8"));
    } catch (err) {
        if (err && err.code === "ENOENT") {
            if (forWrite && fs.existsSync(p + ".damaged")) {
                throw new Error("secrets.json is damaged (set aside as secrets.json.damaged); refusing to overwrite stored keys.");
            }
            return {};
        }
        console.warn("secrets read:", p, err.message);
        if (forWrite) throw err;
        return {};
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        return parsed;
    } catch (err) {
        console.warn("secrets damaged:", p, err.message);
        try { retrying(() => fs.renameSync(p, p + ".damaged")); } catch (_) { /* keep as-is */ }
        if (forWrite) throw new Error("secrets.json is damaged (set aside as secrets.json.damaged); refusing to overwrite stored keys.");
        return {};
    }
}

function writeAll(data) {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    const tmp = file() + ".tmp";
    const fd = fs.openSync(tmp, "w");
    try {
        fs.writeSync(fd, JSON.stringify(data, null, 2) + "\n", null, "utf8");
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
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
    delete all[name];
    writeAll(all);
    return describe(name);
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

module.exports = { get, set, clear, describe, list, available, backend };
