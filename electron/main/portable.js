// A portable copy of Scumble (CLAUDE.md item 36, docs/PLAN_0_1_42.md P1): a file `portable.txt` beside Scumble.exe
// makes the app keep everything it stores (settings, keys, autosave, the file mirror, plugins, recipes, helper models,
// logs, Chromium's own caches and the Comfy Cloud sign-in) in a `data` folder beside it, made at the first start.
// Plain Node, no Electron: main.js passes in what it knows, tools/platform_test.js checks it.
//
// Where the data lives, in one order (`userData`): a --user-data-dir on the command line (the gates' profiles), then
// the Store package's own folder (msix.js), then a portable copy's data folder, then Electron's default
// (%APPDATA%\Scumble). main.js sets the folder before anything reads it (log.install is the first).
//
// How this copy updates (`updateMode`): only an NSIS install (its uninstaller beside the exe) installs updates itself;
// every other unpacked Windows copy (a portable zip, a zip with its marker deleted, dist/win-unpacked) only says that a
// new version is out ("notify", electron/main/updater.js), and the Store updates its own.
"use strict";

const path = require("node:path");
const msix = require("./msix");

const MARKER = "portable.txt";
const DATA = "data";
const UNINSTALLER = "Uninstall Scumble.exe";
/** The probe written and removed at the start: fs.accessSync(W_OK) on Windows reads only the read-only flag, not the ACLs. */
const PROBE = ".write-test";

/** The marker's text (tools/portable_zip.js writes it into the zip, P2). */
const MARKER_TEXT = [
    "Scumble, portable copy.",
    "",
    "This file makes Scumble keep everything it stores (settings, keys, autosave, the local files,",
    "plugins, recipes, helper models, logs) in the \"data\" folder next to it, not in %APPDATA%\\Scumble.",
    "",
    "- API keys are encrypted for this Windows account. On another PC or account, type them again.",
    "- This copy does not update itself. When a new version is out, Scumble says so: download the new",
    "  zip and unpack it over this folder. The data folder stays.",
    "- Delete this file and Scumble uses %APPDATA%\\Scumble like an installed copy, and shares that",
    "  data with it.",
    "- Unpack into a plain folder you can write to (for example C:\\Tools\\Scumble), not into Program",
    "  Files and not into a folder OneDrive syncs.",
    "",
].join("\r\n");

/** The folder the exe sits in, as one spelling: a subst drive or a junction would give a second pipe name. */
function exeDir(execPath, realpath) {
    const dir = path.win32.dirname(String(execPath || ""));
    if (typeof realpath !== "function") return dir;
    try { return realpath(dir) || dir; } catch (_) { return dir; }
}

/**
 * The portable data folder (`<exe dir>\data`), or null: only for a packaged Windows copy that is not the Store's,
 * started without --user-data-dir, with the marker beside the exe.
 * @param {{ packaged: boolean, platform: string, execPath: string, store?: boolean, userDataSwitch?: boolean,
 *   exists: (p: string) => boolean, realpath?: (p: string) => string }} o
 */
function dataDir({ packaged, platform, execPath, store = false, userDataSwitch = false, exists, realpath } = {}) {
    if (!packaged || platform !== "win32" || store || userDataSwitch || !execPath) return null;
    const dir = exeDir(execPath, realpath);
    let marked = false;
    try { marked = !!exists(path.win32.join(dir, MARKER)); } catch (_) { marked = false; }
    return marked ? path.win32.join(dir, DATA) : null;
}

/**
 * Where this process keeps its data: `from` names the rule that decided, `dir` the folder main.js sets (null: leave
 * Electron's own, which is the --user-data-dir or the default).
 * @returns {{ from: "switch" | "store" | "portable" | "default", dir: string | null }}
 */
function userData(o = {}) {
    if (o.userDataSwitch) return { from: "switch", dir: null };
    if (o.store) return { from: "store", dir: msix.storeUserData(o.appData || "") };
    const dir = dataDir(o);
    return dir ? { from: "portable", dir } : { from: "default", dir: null };
}

/**
 * Make the portable data folder and prove it can be written (a file written and removed: Program Files, a read-only
 * share, a folder whose ACL denies writing). Null when it can, else the error (with its `code`).
 * @param {string} dir
 * @param {{ mkdirSync: Function, writeFileSync: Function, unlinkSync: Function }} fs
 */
function prepare(dir, fs) {
    const probe = path.win32.join(dir, PROBE);
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(probe, "");
    } catch (err) {
        return err || new Error("cannot write");
    }
    try { fs.unlinkSync(probe); } catch (_) { /* written, so the folder works; the next start writes it again */ }
    return null;
}

/** The message when the folder cannot be written (main.js shows it in an error box before the app is ready, then exits). */
function refusal(dir, err) {
    const code = (err && (err.code || err.message)) || "unknown error";
    return {
        title: "Scumble cannot use its folder",
        text: `This portable copy keeps its data in ${dir}, but cannot write there (${code}). Move the Scumble folder to a place you can write to, such as C:\\Tools\\Scumble.`,
    };
}

/**
 * How this copy gets updates: "dev" (not packaged), "store" (the Store updates it), "install" (an NSIS install, its
 * uninstaller beside the exe; Linux and the rest as before), "notify" (every other Windows copy: it says a new version
 * is out and never installs one).
 * @param {{ packaged: boolean, store?: boolean, portable?: boolean, platform: string, installed?: boolean }} o
 */
function updateMode({ packaged, store = false, portable = false, platform, installed = false } = {}) {
    if (!packaged) return "dev";
    if (store) return "store";
    if (platform !== "win32") return "install";
    return installed && !portable ? "install" : "notify";
}

/** Whether the NSIS uninstaller sits beside the exe (an installed copy). */
function isInstalled(execPath, exists) {
    try { return !!exists(path.win32.join(path.win32.dirname(String(execPath || "")), UNINSTALLER)); } catch (_) { return false; }
}

module.exports = { dataDir, userData, prepare, refusal, updateMode, isInstalled, MARKER, DATA, UNINSTALLER, PROBE, MARKER_TEXT };
