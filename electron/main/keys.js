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

function readAll() {
    try { return JSON.parse(fs.readFileSync(file(), "utf8")) || {}; } catch (_) { return {}; }
}

function writeAll(data) {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    const tmp = file() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file());
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
    const all = readAll();
    all[name] = { data: safeStorage.encryptString(v).toString("base64"), hint: v.length > 6 ? v.slice(-4) : "", time: Date.now() };
    writeAll(all);
    return describe(name);
}

function clear(name) {
    const all = readAll();
    delete all[name];
    writeAll(all);
    return describe(name);
}

/** { set, hint } for one secret; never the value. */
function describe(name) {
    const entry = readAll()[name];
    return { name, set: !!(entry && entry.data), hint: entry ? entry.hint || "" : "", time: entry ? entry.time : 0 };
}

function list() {
    const out = {};
    for (const name of Object.keys(readAll())) out[name] = describe(name);
    return { backend: backend(), available: available(), keys: out };
}

module.exports = { get, set, clear, describe, list, available, backend };
