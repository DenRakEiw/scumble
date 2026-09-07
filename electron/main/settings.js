// Settings and the autosaved editor state, both plain JSON files in the user data folder.
// Secrets (API keys, remote auth) never go here: they belong to safeStorage (phase 2).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const DEFAULTS = {
    comfy: { url: "http://127.0.0.1:8188" },
    recipe: "flux2_klein_local",
    // InpaintCanvas node widgets, filled into the recipe's canvas node on every run
    nodeParams: { padding: 64, target_size: 1024, feather: 16, multiple_of: 64 },
    window: null,
};

function file(name) {
    return path.join(app.getPath("userData"), name);
}

function readJson(name, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file(name), "utf8"));
    } catch (_) {
        return fallback;
    }
}

function writeJson(name, value) {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    const tmp = file(name + ".tmp");
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file(name));
}

let cache = null;

function get() {
    if (!cache) cache = { ...DEFAULTS, ...readJson("settings.json", {}) };
    return cache;
}

function set(patch) {
    cache = { ...get(), ...(patch || {}) };
    writeJson("settings.json", cache);
    return cache;
}

/** The editor's canvas_state JSON of the last session (a string, or null). */
function loadState() {
    const s = readJson("autosave.json", null);
    return s && typeof s.state === "string" ? s.state : null;
}

function saveState(state) {
    writeJson("autosave.json", { state: String(state || ""), time: Date.now() });
}

module.exports = { get, set, loadState, saveState, DEFAULTS };
