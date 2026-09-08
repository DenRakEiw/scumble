// Plugin folders: the built-in ones shipped with the app (<app>/plugins) and the user's
// (<userData>/plugins). Each plugin is a folder with a plugin.json manifest and a
// JavaScript module; the renderer loads the module through scumble://app/plugins/<id>/...
// (served by main.js from resolve()). This module only knows folders, manifests and the
// enabled flags; what a plugin registers lives in renderer/plugins.js.
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { app, shell } = require("electron");
const settings = require("./settings");

const BUILTIN_DIR = path.join(__dirname, "..", "..", "plugins");
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function userDir() {
    return path.join(app.getPath("userData"), "plugins");
}

function readManifest(dir) {
    const file = path.join(dir, "plugin.json");
    let m;
    try { m = JSON.parse(fs.readFileSync(file, "utf8")); } catch (err) { return { error: `plugin.json: ${err.message}` }; }
    if (!m || typeof m !== "object") return { error: "plugin.json is not an object" };
    const entry = typeof m.entry === "string" && m.entry ? m.entry.replace(/\\/g, "/") : "main.js";
    if (entry.startsWith("/") || entry.includes("..")) return { error: `entry "${entry}" must be a relative path inside the plugin folder` };
    if (!fs.existsSync(path.join(dir, entry))) return { error: `entry file "${entry}" not found` };
    return {
        name: typeof m.name === "string" ? m.name : path.basename(dir),
        version: m.version != null ? String(m.version) : "",
        description: typeof m.description === "string" ? m.description : "",
        author: typeof m.author === "string" ? m.author : "",
        homepage: typeof m.homepage === "string" ? m.homepage : "",
        entry,
        registers: Array.isArray(m.registers) ? m.registers.map(String) : [],
        enabledByDefault: m.enabledByDefault !== false,
    };
}

function scan(root, source) {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return out; }
    for (const d of names) {
        if (!d.isDirectory() || d.name.startsWith(".") || d.name.startsWith("_")) continue;
        const dir = path.join(root, d.name);
        if (!fs.existsSync(path.join(dir, "plugin.json"))) continue;
        const id = d.name;
        const m = readManifest(dir);
        if (!ID_RE.test(id)) { out.push({ id, source, dir, name: id, error: `folder name "${id}" is not a valid plugin id (letters, digits, - and _)` }); continue; }
        out.push({ id, source, dir, ...m });
    }
    return out;
}

/** Every plugin folder: built-in first, then the user's (a user plugin with the same id wins). */
function list() {
    const byId = new Map();
    for (const p of scan(BUILTIN_DIR, "builtin")) byId.set(p.id, p);
    for (const p of scan(userDir(), "user")) byId.set(p.id, p);
    const prefs = settings.get().plugins || {};
    const disabled = new Set(prefs.disabled || []);
    const enabled = new Set(prefs.enabled || []);
    return Array.from(byId.values()).map((p) => ({
        ...p,
        enabled: !p.error && (enabled.has(p.id) || (!disabled.has(p.id) && p.enabledByDefault !== false)),
    }));
}

function setEnabled(id, on) {
    const prefs = settings.get().plugins || {};
    const disabled = new Set(prefs.disabled || []);
    const enabled = new Set(prefs.enabled || []);
    if (on) { disabled.delete(id); enabled.add(id); } else { enabled.delete(id); disabled.add(id); }
    settings.set({ plugins: { ...prefs, disabled: Array.from(disabled), enabled: Array.from(enabled) } });
    return list();
}

/** Absolute path of a file inside a plugin folder, or null (unknown plugin, path outside the folder). */
function resolve(id, rel) {
    const p = list().find((x) => x.id === id);
    if (!p) return null;
    const abs = path.normalize(path.join(p.dir, rel));
    if (!abs.startsWith(p.dir + path.sep)) return null;
    return abs;
}

async function openFolder() {
    const dir = userDir();
    await fsp.mkdir(dir, { recursive: true });
    return shell.openPath(dir);
}

/** Per-plugin persistent data (settings.json, pluginData[id]); small things only. */
function getData(id) {
    const all = settings.get().pluginData || {};
    return all[id] || {};
}

function setData(id, patch) {
    const all = settings.get().pluginData || {};
    const next = { ...all, [id]: { ...(all[id] || {}), ...(patch || {}) } };
    settings.set({ pluginData: next });
    return next[id];
}

module.exports = { list, setEnabled, resolve, openFolder, userDir, getData, setData, BUILTIN_DIR };
