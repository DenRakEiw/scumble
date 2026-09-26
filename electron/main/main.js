// Scumble main process: window, the scumble:// scheme (renderer files and the ComfyUI
// proxy under one origin), native menu and dialogs, settings, and the ComfyUI client.
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { app, BrowserWindow, protocol, net, ipcMain, dialog, Menu, shell, clipboard } = require("electron");
const msix = require("./msix");
// the Store package keeps its data apart from a GitHub copy's (electron/main/msix.js); before anything reads
// the folder, and never over a --user-data-dir (the gates' profiles)
if (msix.isStore() && !app.commandLine.hasSwitch("user-data-dir")) app.setPath("userData", msix.storeUserData(app.getPath("appData")));
const settings = require("./settings");
const log = require("./log");
log.install(require("node:path").join(app.getPath("userData"), "logs"));   // first: the console patch has to be in place before anything logs
const { ComfyClient, authHeaders } = require("./comfy");
const { FileMirror } = require("./files");
const keys = require("./keys");
const providers = require("./providers");
const llm = require("./llm");
const recipes = require("./recipes");
const prompts = require("./prompts");
const brushes = require("./brushes");
const helpers = require("./onnx");
const gpumem = require("./gpumem");
const plugins = require("./plugins");
const skins = require("./skins");
const { Bridge } = require("./bridge");
const { LocalServer, LocalClient } = require("./local");
const { Updater } = require("./updater");
const { resolveTileMode, DEFAULT_ON: TILES_DEFAULT_ON } = require("./tilemode");
const { restartPlan } = require("./restart");
const autosave = require("./autosave");
const { QuitGuard, CrashGuard, isCrash } = require("./quit");
const registration = require("./mcp/registration");

// ---- command line -------------------------------------------------------------------------
//
//   Scumble                     the editor window
//   Scumble --headless          the app without a window (scripts talk to it through --cmd)
//   Scumble --mcp               stdio MCP server; drives the running instance, or starts one
//                               headless when none runs (docs/MCP.md)
//   Scumble --cmd <name> [json] run one command against the running (or a headless) instance,
//                               print the result as JSON and exit
//
// Electron writes a CR LF to stdout before any JavaScript runs, which strict MCP clients
// reject; it cannot be suppressed from here. Clients register mcp/launch.js instead, which
// runs in Node mode (prints nothing), spawns this process and drops those bytes.
function parseArgs(argv) {
    const out = { mcp: false, headless: false, cmd: null, cmdArgs: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--mcp") out.mcp = true;
        else if (a === "--headless") out.headless = true;
        else if (a === "--cmd") { out.cmd = argv[++i] || "ping"; if (argv[i + 1] && !argv[i + 1].startsWith("--")) out.cmdArgs = argv[++i]; }
    }
    return out;
}
const ARGS = parseArgs(process.argv.slice(1));
if (ARGS.mcp) {
    // stdout carries the protocol: every console line goes to stderr
    const util = require("node:util");
    for (const k of ["log", "info", "debug", "warn"]) console[k] = (...a) => process.stderr.write(util.format(...a) + "\n");
}

const ROOT = path.join(__dirname, "..", "..");
const RENDERER_DIR = path.join(ROOT, "renderer");
const RECIPES_DIR = path.join(ROOT, "recipes");
const PROMPTS_DIR = path.join(ROOT, "prompts");
const ICON = path.join(ROOT, "build", process.platform === "win32" ? "icon.ico" : "icon.png");
const SCHEME = "scumble";
const ORIGIN = `${SCHEME}://app`;

const MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
    ".ico": "image/x-icon", ".cube": "text/plain",
};

let win = null;
let headless = ARGS.headless;   // no window shown; a second start of Scumble shows it
let agentMode = null;           // "mcp" while the stdio MCP server runs in this process
const bridge = new Bridge();    // commands in the renderer, run from here (bridge.js)
const local = new LocalServer(bridge);   // the command socket other Scumble processes use
const comfy = new ComfyClient({
    onEvent: (ev) => { if (win && !win.isDestroyed()) win.webContents.send("comfy:event", ev); },
    onStatus: (st) => { if (win && !win.isDestroyed()) win.webContents.send("comfy:status", st); },
});

// Every upload and view goes through the local file mirror: the document lives on
// this machine, the server only gets copies (electron/main/files.js).
const mirror = new FileMirror(comfy);
// quit safety (electron/main/quit.js): a close waits for the window to save, a crashed window comes back
const quitGuard = new QuitGuard();
const crashGuard = new CrashGuard();
const flushWaits = new Map();   // id -> resolve, while the window saves (app:flush / app:flushed)
let flushSeq = 0;
let startMode = "normal";       // "safe": the window came back after a second crash and must not restore
let askingToQuit = false;
let agentsLeft = false;         // the quit under way is maybeQuit's (the last agent left): it re-checks after the save
let quitting = false;           // before-quit fired

protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true } },
]);

// ---- scumble://app -------------------------------------------------------------------

async function serveFile(pathname, search = "") {
    const rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    let abs;
    let plugin = false;
    if (rel.startsWith("/plugins/")) {
        plugin = true;
        // plugin files (renderer/plugins.js imports the module from here): built-in or user folder
        const m = rel.match(/^\/plugins\/([^/]+)\/(.+)$/);
        abs = m ? plugins.resolve(m[1], m[2]) : null;
        if (!abs) return new Response("no such plugin file: " + rel, { status: 404 });
    } else {
        abs = path.normalize(path.join(RENDERER_DIR, rel));
        if (!abs.startsWith(RENDERER_DIR + path.sep) && abs !== RENDERER_DIR) return new Response("forbidden", { status: 403 });
    }
    try {
        let data = await fsp.readFile(abs);
        const type = MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
        // Reload plugins: the entry is imported with ?v=N; relative imports inside plugin modules get
        // the same query so the browser's module map does not hand back the previous submodules
        const v = plugin && /\.(m?js)$/i.test(abs) ? new URLSearchParams(search).get("v") : null;
        if (v) data = data.toString("utf8").replace(/((?:^|[^\w$.])(?:import|export)\s*(?:[^;'"]*?\sfrom\s*)?|\bimport\s*\(\s*)(["'])(\.{1,2}\/[^"'?]+)\2/g, (m, head, q, spec) => `${head}${q}${spec}?v=${v}${q}`);
        return new Response(data, { status: 200, headers: { "content-type": type, "cache-control": "no-cache" } });
    } catch (_) {
        return new Response("not found: " + rel, { status: 404 });
    }
}

/**
 * Every scumble://app response makes the window cross-origin isolated (docs/PLAN_BCE.md §E1): COOP same-origin and COEP
 * require-corp, which `SharedArrayBuffer` needs (the tile arena the worker pool reads without a copy). Everything the
 * window loads is same-origin already (the files, the mirror, the ComfyUI proxy, plugins, blob: and data: URLs); a
 * resource from anywhere else would be refused, and belongs in the mirror.
 */
function isolated(res) {
    const headers = new Headers(res.headers);
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function installProtocol() {
    protocol.handle(SCHEME, async (request) => isolated(await serveScheme(request)));
}

async function serveScheme(request) {
    const url = new URL(request.url);
    if (url.host !== "app") return new Response("unknown host", { status: 404 });
    // the skin in use (docs/SKINS.md): index.html links this sheet after the app's own; it imports the skin's
    // stylesheet from its folder, or is empty in the default look. Never cached: a switch loads it again
    if (url.pathname === "/skin.css") {
        return new Response(skins.sheetFor(currentSkin(), Date.now()), { status: 200, headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" } });
    }
    if (url.pathname.startsWith("/comfy/")) {
        const rel = url.pathname.slice("/comfy".length);
        try {
            if (rel === "/upload/image" && request.method === "POST") return await mirror.handleUpload(request);
            if (rel === "/inpaint_canvas/upload" && request.method === "POST") return await mirror.handleRawUpload(request, url.search);
            if (rel === "/view" && (request.method === "GET" || request.method === "HEAD")) return await mirror.handleView(url.search);
        } catch (err) {
            console.error("mirror", rel, err);
            return new Response("file mirror error: " + (err.message || err), { status: 500 });
        }
        return comfy.proxy(request, rel + url.search);
    }
    return serveFile(url.pathname, url.search);
}

// ---- skins (electron/main/skins.js, docs/SKINS.md) ------------------------------------------

/** The settings' appearance object, whole (settings.js merges only the top level). */
function appearanceSettings() {
    return { ...settings.DEFAULTS.appearance, ...(settings.get().appearance || {}) };
}

/** The skin in use (a plugins.list() entry), or null for the default look; --no-skin is read here only. */
function currentSkin() {
    return skins.activeSkin({ argv: process.argv, appearance: appearanceSettings(), list: plugins.list() });
}

/** What Settings › Appearance and renderer/skins.js need: the choice, what is in use, and every skin folder. */
function appearanceState() {
    const a = appearanceSettings();
    const list = plugins.list().filter((p) => p.kind === "skin");
    const active = skins.activeSkin({ argv: process.argv, appearance: a, list });
    return {
        skin: a.skin || "",
        refused: a.refused || null,
        active: active ? active.id : null,
        background: skins.backgroundFor(active),
        noSkinFlag: process.argv.includes("--no-skin"),
        tokens: skins.SKIN_TOKENS_VERSION,
        skins: list.map((p) => ({
            id: p.id, name: p.name || p.id, version: p.version || "", description: p.description || "", author: p.author || "",
            source: p.source, dir: p.dir, error: p.error || null, warnings: p.warnings || [], skin: p.skin || null,
        })),
    };
}

/** The window's own background follows the skin, so a resize or a reload shows no default-grey flash. */
function applySkinBackground() {
    if (win && !win.isDestroyed()) win.setBackgroundColor(skins.backgroundFor(currentSkin()));
}

// ---- window ---------------------------------------------------------------------------

/**
 * The editor's pixel backend (docs/PLAN_BCE.md §C2, "C2 as built", step b; §C7): the tile store or
 * one canvas per layer, resolved by electron/main/tilemode.js: --tiles / --no-tiles, then
 * SCUMBLE_TILES=1 / 0, then a boolean `tiles` in settings.json (Settings › Rendering › Tile engine),
 * else on (since 0.1.13 in the packaged app too). Never written as a default. `from` says what decided.
 */
function tileMode() {
    return resolveTileMode({ argv: process.argv, env: process.env, setting: settings.get().tiles, packaged: app.isPackaged });
}

/** What the window was created with; a change of the setting reaches the next start. */
let windowTiles = null;

function createWindow() {
    const tiles = tileMode();
    windowTiles = tiles;
    const saved = settings.get().window || {};
    win = new BrowserWindow({
        width: saved.width || 1600,
        height: saved.height || 1000,
        x: saved.x, y: saved.y,
        minWidth: 1100, minHeight: 700,
        backgroundColor: skins.backgroundFor(currentSkin()),
        title: "Scumble",
        icon: fs.existsSync(ICON) ? ICON : undefined,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, "..", "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
            // runs and helpers keep going while another window is in front; without this,
            // canvas.toBlob and timers in a hidden window are throttled to one per second
            backgroundThrottling: false,
            // dev builds run the editor's pixel access strict (docs/PLAN_BCE.md C1): the old
            // layer.canvas / editor.selection names throw instead of warning. SCUMBLE_STRICT=0
            // turns it off, --pixels-copy makes toCanvas() hand out copies (the gates' write check),
            // --scumble-tiles carries tileMode() (always passed: the renderer has no default of its own)
            additionalArguments: [
                ...(!app.isPackaged && process.env.SCUMBLE_STRICT !== "0" ? ["--scumble-strict"] : []),
                ...(process.argv.includes("--pixels-copy") ? ["--scumble-pixels-copy"] : []),
                `--scumble-tiles=${tiles.on ? "1" : "0"}`,
                `--scumble-tiles-from=${encodeURIComponent(tiles.from)}`,
            ],
        },
    });
    if (saved.maximized && !headless) win.maximize();
    win.once("ready-to-show", () => { if (!headless) win.show(); });
    win.on("close", (e) => {
        const b = win.getNormalBounds();
        settings.set({ window: { ...b, maximized: win.isMaximized() } });
        // while an agent drives the app, closing the window only hides it; the app ends
        // with the MCP session (or stays when a script still talks to the socket)
        if (agentMode) { e.preventDefault(); win.hide(); headless = true; return; }
        // the window saves its last changes first (quit.js): the edited layers, the selection, the autosave
        const what = quitGuard.onClose();
        if (what === "allow") return;
        e.preventDefault();
        if (what === "ask") { askWhileSaving(); return; }
        const forAgents = agentsLeft;       // maybeQuit: the last agent left a headless instance
        mirror.localOnly = true;            // a close must not wait on a slow or remote ComfyUI (files.js)
        quitGuard.run(() => flushWindow("quit")).then((r) => {
            if (!r.ok || r.ms > 5000) log.record({ level: r.ok ? "info" : "warn", source: "main", message: r.ok ? `saved before closing in ${(r.ms / 1000).toFixed(1)} s` : `closed without saving everything: ${r.timedOut ? "the window did not finish in time" : r.error || "the window did not answer"}` });
            // an agent that connected, or a window shown by a new start, while it saved: this instance is in use again
            if (forAgents && (agentMode || local.clients.size || windowVisible())) { agentsLeft = false; mirror.localOnly = false; quitGuard.reset(); return; }
            if (win && !win.isDestroyed()) win.close();
        });
    });
    // a page that goes away (a reload) answers no save any more
    win.webContents.on("did-start-navigation", (details) => {
        if (!details || details.isSameDocument || !details.isMainFrame) return;
        for (const resolve of flushWaits.values()) resolve({ ok: false, error: "the window reloaded" });
    });
    // a window whose renderer ended (a crash, out of memory) comes back and restores the autosave (quit.js CrashGuard)
    win.webContents.on("render-process-gone", (_e, d) => {
        for (const resolve of flushWaits.values()) resolve({ ok: false, error: "the window's renderer ended" });
        if (quitGuard.done || quitGuard.flushing || !isCrash(d) || win.isDestroyed()) return;   // not while it closes
        const plan = crashGuard.record();
        const what = plan === "reload" ? "reloaded; the documents come back from the autosave"
            : plan === "safe" ? "it ended again right after a reload: started without the documents, which are kept under Settings › Local files › Earlier states"
            : "it keeps ending: Scumble closes";
        log.record({ level: "error", source: "main", message: `the window's renderer ended (${d.reason}, exit code ${d.exitCode}): ${what}` });
        if (plan === "reload" || plan === "safe") {
            if (plan === "safe") { try { autosave.setAside(app.getPath("userData")); } catch (err) { console.warn("autosave: set aside", err.message); } }
            startMode = plan === "safe" ? "safe" : "normal";
            win.loadURL(ORIGIN + "/index.html");
            return;
        }
        const done = () => { quitGuard.release(); if (win && !win.isDestroyed()) win.destroy(); app.quit(); };
        if (!windowVisible()) { done(); return; }
        dialog.showMessageBox(win, {
            type: "error", buttons: ["Close Scumble"], defaultId: 0, noLink: true,
            message: "Scumble's window keeps crashing.",
            detail: "It ended three times in two minutes. Your documents of before the crashes are kept: Settings › Local files › Earlier states opens them at the next start.",
        }).then(done, done);
    });
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
    // an unhandled file drop (the shell bar, the tabs, a panel) would navigate the window to the file:
    // every call in flight rejects and the editor is gone. Only the app's own origin may be navigated
    // to; the Bridge reads the same rule, because `did-start-navigation` fires before this handler and
    // a drop for a navigation that never happens would leave it waiting for a `commands:ready` forever
    const staysInApp = (url) => String(url).startsWith(ORIGIN + "/");
    win.webContents.on("will-navigate", (e, url) => { if (!staysInApp(url)) e.preventDefault(); });
    bridge.attach(win.webContents, { navigates: staysInApp });
    win.loadURL(ORIGIN + "/index.html");
}

/** Show the (headless or hidden) window: a second start of Scumble, or macOS activate. */
/**
 * Ask the window to save what a close would lose (renderer/shell.js saveBeforeRestart); resolves with its answer
 * ({ ok, error }), or { ok: true, skipped: true } when there is no window that could (none, crashed, still starting).
 */
function flushWindow(reason) {
    if (!win || win.isDestroyed() || win.webContents.isCrashed() || !bridge.ready) return Promise.resolve({ ok: true, skipped: true });
    const id = ++flushSeq;
    return new Promise((resolve) => {
        flushWaits.set(id, resolve);
        win.webContents.send("app:flush", { id, reason });
    }).finally(() => flushWaits.delete(id));
}

/** View › Reload: the window saves first (a reload drops what is not uploaded, like a close), then reloads. */
async function reloadWindow(ignoreCache) {
    if (!win || win.isDestroyed()) return;
    if (!quitGuard.flushing) {
        mirror.localOnly = true;        // like a close: not waiting on a slow ComfyUI (files.js)
        try { await flushWindow("reload"); } finally { mirror.localOnly = false; }
    }
    if (!win || win.isDestroyed()) return;
    if (ignoreCache) win.webContents.reloadIgnoringCache(); else win.webContents.reload();
}

/** A second close while the window saves: wait, or quit now and lose the last seconds. */
function askWhileSaving() {
    if (askingToQuit || !windowVisible()) return;
    askingToQuit = true;
    dialog.showMessageBox(win, {
        type: "question", buttons: ["Keep waiting", "Quit now"], defaultId: 0, cancelId: 0, noLink: true,
        message: "Scumble is still saving your last changes.",
        detail: "Quit now loses what changed in the last seconds.",
    }).then(({ response }) => {
        askingToQuit = false;
        if (response !== 1 || quitGuard.done) return;
        log.record({ level: "warn", source: "main", message: "closed without waiting for the save: the user chose Quit now" });
        quitGuard.release();
        if (win && !win.isDestroyed()) win.close();
    }, () => { askingToQuit = false; });
}

function showWindow() {
    headless = false;
    if (!win || win.isDestroyed()) { createWindow(); return; }
    if (!win.isVisible()) {
        win.show();
        // a window that was never shown stays hidden after show() on Windows; restore() brings it up
        if (!win.isVisible()) win.restore();
    }
    if (win.isMinimized()) win.restore();
    win.focus();
}

function windowVisible() {
    return !!(win && !win.isDestroyed() && win.isVisible());
}

/** Dialogs need a window the user can see; headless callers pass paths instead. */
function needWindow(what) {
    if (!windowVisible()) throw new Error(`${what} needs the Scumble window (none is shown): pass a path instead`);
}

function send(channel, payload) {
    // a crashed or reloading window has no frame to send to, and Electron logs the failed send as an error
    if (win && !win.isDestroyed() && !win.webContents.isCrashed()) win.webContents.send(channel, payload);
}

/** Title suffix and a status line while agents (MCP, --cmd, scripts) are connected. */
function showAgents() {
    const n = local.clients.size + (agentMode ? 1 : 0);
    if (win && !win.isDestroyed()) win.setTitle(n ? `Scumble · ${n} agent${n > 1 ? "s" : ""} connected` : "Scumble");
}

// ---- the in-app assistant (electron/main/assistant/index.js, docs/PLAN_ASSISTANT.md) -----
//
// The loop runs here, in main: only main reads the keys and reaches the model hosts, and it
// survives a window reload. It drives the editor through an in-process MCP client against the
// same server external agents get (mcp/server.js createServer), so both see one tool surface.
// Made at the first use, so the SDK's client is not loaded at start.
let assistant = null;

/** An ask that waits while the window is in the back flashes the taskbar entry, and stops on focus. */
function attention(event) {
    if (!win || win.isDestroyed()) return;
    if (event && event.type === "ask" && !win.isFocused()) {
        win.flashFrame(true);
        win.once("focus", () => { if (!win.isDestroyed()) win.flashFrame(false); });
    } else if (event && (event.type === "turn:done" || event.type === "call")) {
        win.flashFrame(false);
    }
}

function getAssistant() {
    if (assistant) return assistant;
    const { Assistant } = require("./assistant/index.js");
    const { Store } = require("./assistant/store.js");
    const { createServer } = require("./mcp/server");
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
    assistant = new Assistant({
        bridge, keys, settings, log,
        store: new Store(app.getPath("userData")),
        emit: (event) => { send("assistant:event", event); attention(event); },
        createServer, Client, InMemoryTransport,
        version: app.getVersion(),
        // what the policy needs to know about an export path (the extension, whether the file exists)
        statFile: (file) => {
            const ext = path.extname(String(file || "")).slice(1).toLowerCase();
            try { return { ext, exists: fs.statSync(String(file)).isFile() }; } catch (_) { return { ext, exists: false }; }
        },
        // the assistant is not an agent for the title line: it counts what showAgents() counts
        agents: () => local.clients.size + (agentMode ? 1 : 0),
    });
    return assistant;
}

// ---- Help (electron/main/assistant/help.js, docs/PLAN_HELP.md) --------------------------------
//
// The manual (docs/MANUAL.md, shipped with the app) for the Help panel, and its chat: the
// assistant's adapters with no tools, so nothing here reaches the editor. Made at the first question.
const MANUAL_FILE = path.join(ROOT, "docs", "MANUAL.md");
let help = null;

function readManual() {
    return fs.readFileSync(MANUAL_FILE, "utf8");
}

function getHelp() {
    if (help) return help;
    const { Help } = require("./assistant/help.js");
    help = new Help({
        keys, settings,
        manual: readManual,
        emit: (event) => send("help:event", event),
        log: (line) => log.record({ source: "help", message: String(line) }),
    });
    return help;
}

let pluginActions = [];   // [{id, label, accelerator}] from renderer/plugins.js
const updater = new Updater();
updater.on("status", (s) => send("update:status", s));

/** View › Skin: the default look, one radio per usable skin, and the way to Settings › Appearance. */
function skinMenu() {
    let active = null;
    let usable = [];
    try {
        active = currentSkin();
        usable = plugins.list().filter((p) => p.kind === "skin" && !p.error);
    } catch (err) { console.warn("skins menu:", err.message); }
    return [
        { label: "Default", type: "radio", checked: !active, click: () => send("menu", "skin:") },
        ...usable.map((p) => ({ label: String(p.name || p.id).replace(/&/g, "&&"), type: "radio", checked: !!active && active.id === p.id, click: () => send("menu", "skin:" + p.id) })),
        { type: "separator" },
        { label: "Appearance settings...", click: () => send("menu", "settings-appearance") },
    ];
}

function buildMenu() {
    const isMac = process.platform === "darwin";
    const pluginMenu = {
        label: "&Plugins",
        submenu: [
            ...pluginActions.map((a) => ({ label: a.label, accelerator: a.accelerator || undefined, click: () => send("menu", "plugin:" + a.id) })),
            ...(pluginActions.length ? [{ type: "separator" }] : []),
            { label: "Reload plugins", click: () => send("menu", "reload-plugins") },
            { label: "Open plugin folder", click: () => plugins.openFolder() },
            { label: "Manage plugins...", click: () => send("menu", "settings-plugins") },
        ],
    };
    const template = [
        ...(isMac ? [{ role: "appMenu" }] : []),
        {
            label: "&File",
            submenu: [
                { label: "New Tab", accelerator: "CmdOrCtrl+T", click: () => send("menu", "new-tab") },
                { label: "Open Image...", accelerator: "CmdOrCtrl+O", click: () => openImage() },
                { label: "Save Image...", accelerator: "CmdOrCtrl+S", click: () => send("menu", "save") },
                { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => send("menu", "close-tab") },
                { type: "separator" },
                { label: "Import Workflow as Recipe...", click: () => send("menu", "import-recipe") },
                { type: "separator" },
                { label: "Next Tab", accelerator: "CmdOrCtrl+Tab", click: () => send("menu", "next-tab") },
                { label: "Previous Tab", accelerator: "CmdOrCtrl+Shift+Tab", click: () => send("menu", "prev-tab") },
                { type: "separator" },
                { label: "Settings...", accelerator: "CmdOrCtrl+,", click: () => send("menu", "settings") },
                { type: "separator" },
                isMac ? { role: "close" } : { role: "quit" },
            ],
        },
        {
            label: "&View",
            submenu: [
                { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => reloadWindow(false) },
                { label: "Force Reload", click: () => reloadWindow(true) },   // Ctrl+Shift+R is the editor's rulers
                { role: "toggleDevTools" },
                { type: "separator" },
                { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
                { type: "separator" },
                { role: "togglefullscreen" },
                { type: "separator" },
                { label: "Assistant", accelerator: "CmdOrCtrl+Shift+A", click: () => send("menu", "assistant") },
                { type: "separator" },
                // the native menu is out of any skin's reach: Default always brings the default look back
                { label: "Skin", submenu: skinMenu() },
            ],
        },
        pluginMenu,
        {
            label: "&Help",
            submenu: [
                { label: "Scumble help", accelerator: "F1", click: () => send("menu", "help") },
                { label: "Console (log)", accelerator: "CmdOrCtrl+Shift+L", click: () => send("menu", "console") },
                { label: "Scumble on GitHub", click: () => shell.openExternal("https://github.com/DenRakEiw/scumble") },
                { label: "Inpaint Canvas node on GitHub", click: () => shell.openExternal("https://github.com/DenRakEiw/ComfyUI-InpaintCanvas") },
                { type: "separator" },
                { label: "Copy MCP registration (Claude Code)", click: () => copyMcpRegistration("code") },
                { label: "Copy MCP registration (Claude Desktop JSON)", click: () => copyMcpRegistration("desktop") },
                { type: "separator" },
                // the Store copy is updated by the Store (electron/main/msix.js)
                ...(msix.isStore() ? [] : [
                    { label: "Check for updates...", click: () => { updater.check({ manual: true }); send("menu", "settings-updates"); } },
                    { type: "separator" },
                ]),
                { label: `Scumble ${app.getVersion()} · Electron ${process.versions.electron} · GPL-3.0`, enabled: false },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * The registration line for an MCP client, with the paths of this installation
 * (electron/main/mcp/registration.js says which). Nobody types an asar path by hand, hence
 * the menu entry.
 */
function mcpRegistration(kind) {
    return registration.registration(kind, {
        platform: process.platform,
        exe: app.isPackaged ? app.getPath("exe") : process.execPath,
        launcher: app.isPackaged
            ? path.join(process.resourcesPath, "app.asar", "electron", "main", "mcp", "launch.js")
            : path.join(ROOT, "electron", "main", "mcp", "launch.js"),
        appImage: app.isPackaged ? process.env.APPIMAGE : "",
        storeAlias: msix.isStore() ? msix.aliasPath(process.env.LOCALAPPDATA || "") : "",
    });
}

function copyMcpRegistration(kind) {
    clipboard.writeText(mcpRegistration(kind));
    send("menu", "mcp-copied");
}

// ---- dialogs -------------------------------------------------------------------------

const IMAGE_FILTERS = [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff", "svg", "psd", "ora"] }, { name: "Layered (PSD, ORA)", extensions: ["psd", "ora"] }, { name: "All files", extensions: ["*"] }];

async function openImage() {
    needWindow("Open image");
    const r = await dialog.showOpenDialog(win, { title: "Open image", properties: ["openFile"], filters: IMAGE_FILTERS });
    if (r.canceled || !r.filePaths.length) return null;
    const file = r.filePaths[0];
    const data = await fsp.readFile(file);
    const payload = { name: path.basename(file), path: file, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
    send("file:opened", payload);
    return payload;
}

/** Read a file for the renderer (commands with a `path` argument: load_image, add_image_layer). */
async function readFile(file) {
    const data = await fsp.readFile(file);
    return { name: path.basename(file), path: file, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

/** Write bytes to a file. With `path` given (scripts, MCP export) no dialog is shown. */
async function saveFile({ name, data, filters, path: target }) {
    const ext = path.extname(name || "").slice(1).toLowerCase();
    let filePath = target;
    if (!filePath) {
        needWindow("Save");
        const r = await dialog.showSaveDialog(win, {
            title: "Save image",
            defaultPath: path.join(settings.get().lastSaveDir || app.getPath("pictures"), name || "scumble.png"),
            filters: filters || (ext ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: "All files", extensions: ["*"] }] : [{ name: "All files", extensions: ["*"] }]),
        });
        if (r.canceled || !r.filePath) return null;
        filePath = r.filePath;
        settings.set({ lastSaveDir: path.dirname(filePath) });
    }
    await fsp.writeFile(filePath, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    return { path: filePath, name: path.basename(filePath), bytes: data.byteLength };
}

// ---- recipes -------------------------------------------------------------------------

function listRecipes() {
    return recipes.list(RECIPES_DIR);
}

/** Import a ComfyUI workflow (UI or API format) as a user recipe; UI format needs /object_info. */
async function importRecipe(file) {
    if (!file) {
        needWindow("Import recipe");
        const r = await dialog.showOpenDialog(win, { title: "Import workflow as recipe", properties: ["openFile"], filters: [{ name: "Workflow / recipe (JSON)", extensions: ["json"] }, { name: "All files", extensions: ["*"] }] });
        if (r.canceled || !r.filePaths.length) return null;
        file = r.filePaths[0];
    }
    let objectInfo = null;
    if (comfy.status.state === "connected" || comfy.status.state === "missing-node") {
        try { objectInfo = await comfy.json("/object_info"); } catch (err) { console.warn("object_info for the import:", err.message); }
    }
    return recipes.importFile(file, objectInfo);
}

// ---- ComfyUI connection with auth ------------------------------------------------------

const COMFY_SECRET = "comfy-auth";

/** Connect with the stored URL / auth, or the given ones (which are then stored). */
async function connectComfy(conn) {
    let { comfy: saved } = settings.get();
    saved = saved || {};
    if (conn && typeof conn === "object") {
        const auth = conn.auth && conn.auth.type && conn.auth.type !== "none" ? { type: conn.auth.type, user: conn.auth.user || "", header: conn.auth.header || "" } : { type: "none" };
        saved = settings.set({ comfy: { ...saved, url: conn.url || saved.url, auth } }).comfy;
        if (typeof conn.secret === "string") keys.set(COMFY_SECRET, conn.secret);
    } else if (typeof conn === "string" && conn) {
        saved = settings.set({ comfy: { ...saved, url: conn } }).comfy;
    }
    return comfy.connect(saved.url, authHeaders(saved.auth, keys.get(COMFY_SECRET)));
}

async function probeComfy(conn) {
    const saved = settings.get().comfy || {};
    const url = (conn && conn.url) || saved.url;
    const auth = conn && conn.auth ? conn.auth : saved.auth;
    const secret = conn && typeof conn.secret === "string" && conn.secret !== "" ? conn.secret : keys.get(COMFY_SECRET);
    return ComfyClient.probe(url, authHeaders(auth, secret));
}

// ---- IPC -----------------------------------------------------------------------------

function installIpc() {
    ipcMain.handle("settings:get", () => settings.get());
    ipcMain.handle("settings:set", (_e, patch) => settings.set(patch));
    ipcMain.handle("state:load", (_e, gen) => settings.loadState(gen));
    ipcMain.handle("state:generations", () => autosave.generations(app.getPath("userData")));
    ipcMain.handle("state:startMode", () => { const m = startMode; startMode = "normal"; return m; });
    ipcMain.on("app:flushed", (_e, r) => { const resolve = r && flushWaits.get(r.id); if (resolve) resolve(r); });
    ipcMain.handle("state:save", (_e, state) => { settings.saveState(state); return true; });
    ipcMain.handle("comfy:connect", (_e, conn) => connectComfy(conn));
    ipcMain.handle("comfy:probe", (_e, conn) => probeComfy(conn));
    ipcMain.handle("comfy:disconnect", () => { comfy.disconnect(); return comfy.status; });
    ipcMain.handle("comfy:status", () => comfy.status);
    ipcMain.handle("comfy:clientId", () => comfy.clientId);
    ipcMain.handle("comfy:ensure", (_e, refs) => mirror.ensureOnServer(refs));
    ipcMain.handle("files:stats", () => mirror.stats());
    // the files the earlier autosave generations name stay too (autosave.js): they are what those states open
    ipcMain.handle("files:prune", (_e, args) => {
        const a = args || {};
        let kept = [];
        try { kept = autosave.referencedKeys(app.getPath("userData")); } catch (err) { console.warn("autosave: generations", err.message); }
        return mirror.prune({ ...a, keep: [...(Array.isArray(a.keep) ? a.keep : []), ...kept] });
    });
    ipcMain.handle("files:openFolder", async () => { const r = mirror.root(); await fsp.mkdir(r, { recursive: true }); return shell.openPath(msix.forExplorer(r)); });
    ipcMain.handle("file:open", () => openImage());
    ipcMain.handle("file:save", (_e, args) => saveFile(args));
    ipcMain.handle("file:read", (_e, file) => readFile(String(file)));
    ipcMain.handle("recipes:list", () => listRecipes());
    ipcMain.handle("recipes:import", (_e, file) => importRecipe(file));
    ipcMain.handle("recipes:remove", (_e, id) => recipes.remove(id));
    ipcMain.handle("recipes:openFolder", async () => { const r = recipes.userDir(); await fsp.mkdir(r, { recursive: true }); return shell.openPath(msix.forExplorer(r)); });
    ipcMain.handle("keys:list", () => keys.list());
    ipcMain.handle("keys:set", (_e, { name, value }) => keys.set(name, value));
    ipcMain.handle("keys:clear", (_e, name) => keys.clear(name));
    ipcMain.handle("providers:list", () => providers.describeAll());
    ipcMain.handle("provider:edit", (_e, request) => providers.edit(request));
    ipcMain.handle("provider:balance", (_e, id) => providers.balance(id));
    // vision language models on the provider keys (prompt upsampling)
    ipcMain.handle("llm:list", () => llm.list());
    ipcMain.handle("llm:ask", (_e, req) => llm.ask(req));
    ipcMain.handle("llm:models", (_e, url) => llm.compatModels(url));
    // the providers a row of Settings > Language models may name, with whether each has its key
    ipcMain.handle("llm:providers", () => require("./llm_custom.js").options().map((o) => ({ ...o, hasKey: !!keys.describe(o.key).set })));
    // prompt instruction templates (electron/main/prompts.js)
    ipcMain.handle("log:add", (_e, entry) => { const e = entry && typeof entry === "object" ? entry : { message: String(entry) }; return log.record({ level: e.level, source: e.source || "renderer", message: e.message, detail: e.detail }).id; });
    ipcMain.handle("log:list", (_e, q) => log.list(q || {}));
    ipcMain.handle("log:clear", () => { log.clear(); return true; });
    ipcMain.handle("log:open", async () => { const f = log.file(); if (!f) return null; await require("node:fs/promises").mkdir(require("node:path").dirname(f), { recursive: true }); return shell.openPath(msix.forExplorer(require("node:path").dirname(f))); });
    ipcMain.handle("log:file", () => log.file());
    // not re-entered: a send that fails logs an error (Electron's own console.error), which would be sent again
    let forwarding = false;
    log.onEntry((e) => {
        if (forwarding) return;
        forwarding = true;
        try { send("log:entry", e); } finally { forwarding = false; }
    });
    ipcMain.handle("brushes:list", () => brushes.list());
    ipcMain.handle("brushes:save", (_e, tips) => brushes.save(tips));
    ipcMain.handle("brushes:open", () => brushes.openFolder());
    ipcMain.handle("prompts:list", () => prompts.list(PROMPTS_DIR));
    ipcMain.handle("prompts:open", () => prompts.openFolder());
    ipcMain.handle("prompts:remove", (_e, id) => prompts.remove(id));
    ipcMain.handle("prompts:import", async () => {
        needWindow("Import a prompt template");
        const r = await dialog.showOpenDialog(win, { title: "Import a prompt template", properties: ["openFile"], filters: [{ name: "Markdown", extensions: ["md"] }] });
        if (r.canceled || !r.filePaths.length) return null;
        return await prompts.importFile(r.filePaths[0]);
    });
    // in-app helper models (electron/main/onnx): SAM2 objects, background removal
    helpers.setProgressSink((ev) => send("helpers:progress", ev));
    ipcMain.handle("helpers:status", () => helpers.status());
    ipcMain.handle("helpers:configure", (_e, patch) => helpers.configure(patch));
    ipcMain.handle("helpers:scan", () => helpers.scan());
    ipcMain.handle("helpers:browseDir", () => { needWindow("Choose folder"); return helpers.browseDir(win); });
    ipcMain.handle("helpers:openFolder", () => helpers.openFolder());
    ipcMain.handle("helpers:download", (_e, id) => helpers.download(id));
    ipcMain.handle("helpers:cancel", (_e, id) => helpers.cancel(id));
    ipcMain.handle("helpers:remove", (_e, id) => helpers.remove(id));
    ipcMain.handle("helpers:free", () => helpers.free());
    ipcMain.handle("helpers:objects", (_e, req) => helpers.objects(req));
    ipcMain.handle("helpers:segment", (_e, req) => helpers.segment(req));
    ipcMain.handle("helpers:cutout", (_e, req) => helpers.cutout(req));
    // plugins (electron/main/plugins.js): folders and manifests; the renderer loads the modules
    ipcMain.handle("plugins:list", () => plugins.list());
    ipcMain.handle("plugins:setEnabled", (_e, { id, enabled }) => plugins.setEnabled(String(id), !!enabled));
    ipcMain.handle("plugins:openFolder", () => plugins.openFolder());
    ipcMain.handle("plugins:menu", (_e, actions) => { pluginActions = Array.isArray(actions) ? actions.map((a) => ({ id: String(a.id), label: String(a.label || a.id), accelerator: a.accelerator ? String(a.accelerator) : null })) : []; buildMenu(); return true; });
    ipcMain.handle("plugins:getData", (_e, id) => plugins.getData(String(id)));
    ipcMain.handle("plugins:setData", (_e, { id, patch }) => plugins.setData(String(id), patch));
    // skins (docs/SKINS.md): main keeps the choice and answers skin.css; renderer/skins.js swaps the sheet
    // read afresh from the folders each time (Reload skins, Settings › Appearance): View › Skin follows what is there
    ipcMain.handle("appearance:get", () => { buildMenu(); return appearanceState(); });
    ipcMain.handle("appearance:set", (_e, id) => {
        const skin = String(id == null ? "" : id);
        if (skin && !plugins.list().some((p) => p.id === skin && p.kind === "skin" && !p.error)) throw new Error(`no skin "${skin}"`);
        const { refused } = appearanceSettings();
        // choosing a skin again that was switched off gives it another chance
        settings.set({ appearance: { skin, refused: refused && refused.id === skin ? null : refused || null } });
        applySkinBackground();
        buildMenu();
        return appearanceState();
    });
    ipcMain.handle("appearance:refuse", (_e, req) => {
        const id = String((req && req.id) || "");
        const reason = String((req && req.reason) || "").slice(0, 300);
        settings.set({ appearance: { skin: "", refused: { id, reason, at: Date.now() } } });
        applySkinBackground();
        buildMenu();
        log.record({ level: "warn", source: "skins", message: `the skin "${id}" was switched off: ${reason}` });
        return appearanceState();
    });
    // the in-app assistant (docs/PLAN_ASSISTANT.md §4 A4): `send` starts a turn that runs on in the
    // background and reports through `assistant:event`; `state` rebuilds the panel after a reload
    ipcMain.handle("assistant:send", (_e, req) => getAssistant().begin(String(req && req.text != null ? req.text : "")));
    ipcMain.handle("assistant:stop", () => getAssistant().stop());
    ipcMain.handle("assistant:answer", (_e, req) => getAssistant().answer(req && req.call, !!(req && req.allow)));
    ipcMain.handle("assistant:reset", (_e, opts) => getAssistant().reset(opts || {}));
    ipcMain.handle("assistant:state", () => getAssistant().state());
    ipcMain.handle("assistant:models", () => getAssistant().models());
    ipcMain.handle("assistant:openrouterModels", () => getAssistant().openrouterModels());
    ipcMain.handle("assistant:tools", () => getAssistant().tools());
    // the saved chats (docs/PLAN_ASSISTANT.md §4 A6)
    ipcMain.handle("assistant:chats", () => getAssistant().chats());
    ipcMain.handle("assistant:open", (_e, req) => getAssistant().openChat(String(req && req.id)));
    ipcMain.handle("assistant:delete", (_e, req) => getAssistant().deleteChat(String(req && req.id)));
    ipcMain.handle("assistant:resetAll", () => getAssistant().resetAll());
    ipcMain.handle("assistant:turnUndone", (_e, req) => getAssistant().turnUndone(req || {}));
    // Help (docs/PLAN_HELP.md): the manual's text for the panel, and the chat that answers from it;
    // `send` resolves when the answer is in, the text streams through `help:event` before that
    ipcMain.handle("help:manual", () => readManual());
    ipcMain.handle("help:models", () => getHelp().models());
    ipcMain.handle("help:send", (_e, req) => getHelp().send(String(req && req.text != null ? req.text : ""), req && req.model ? String(req.model) : ""));
    ipcMain.handle("help:stop", () => getHelp().stop());
    ipcMain.handle("help:reset", () => getHelp().reset());
    ipcMain.handle("help:state", () => (help ? help.state() : { busy: false, model: null, events: [] }));
    ipcMain.handle("help:setModel", (_e, value) => {
        settings.set({ help: { ...(settings.get().help || {}), model: String(value || "") } });
        return true;
    });
    ipcMain.handle("assistant:noticed", (_e, req) => {
        // the privacy notice was shown for this provider: the date, in the whole merged object (settings.js)
        const a = { ...settings.DEFAULTS.assistant, ...(settings.get().assistant || {}) };
        a.noticed = { ...(a.noticed || {}), [String(req && req.provider)]: new Date().toISOString().slice(0, 10) };
        settings.set({ assistant: a });
        return a.noticed;
    });
    ipcMain.handle("app:info", () => ({ version: app.getVersion(), electron: process.versions.electron, platform: process.platform, userData: msix.forExplorer(app.getPath("userData")), pluginDir: msix.forExplorer(plugins.userDir()), store: msix.isStore() }));
    ipcMain.handle("app:openExternal", (_e, url) => { if (/^https?:\/\//.test(String(url))) shell.openExternal(url); });
    // memory (docs/PHASE6_PLAN.md step 1a): the bytes that matter live in the GPU process, and
    // only the main process can see them. Sizes are KB, as Electron reports them.
    ipcMain.handle("app:metrics", () => ({
        processes: app.getAppMetrics().map((p) => ({
            pid: p.pid,
            type: p.type,
            name: p.name || p.serviceName || "",
            workingSetKB: p.memory ? p.memory.workingSetSize : 0,
            peakWorkingSetKB: p.memory ? p.memory.peakWorkingSetSize : 0,
            privateKB: p.memory ? p.memory.privateBytes : undefined, // Windows only
        })),
    }));
    // the card as a whole (electron/main/gpumem.js): what ComfyUI and everything else hold too
    ipcMain.handle("app:gpuMemory", () => gpumem.gpuMemory());
    // the pixel backend (Settings › Rendering › Tile engine): what this window runs, what the next start
    // would take with the settings as they are now, the stored boolean (null when none) and the default
    ipcMain.handle("app:tileMode", () => {
        const s = settings.get().tiles;
        return {
            window: windowTiles,
            next: tileMode(),
            setting: typeof s === "boolean" ? s : null,
            defaultOn: TILES_DEFAULT_ON,
            argv: process.argv.includes("--tiles") ? "--tiles" : process.argv.includes("--no-tiles") ? "--no-tiles" : null,
            env: process.env.SCUMBLE_TILES === "1" || process.env.SCUMBLE_TILES === "0" ? process.env.SCUMBLE_TILES : null,
        };
    });
    // quit and start again (a backend change needs a new window), electron/main/restart.js: the command line
    // without --mcp / --headless / --cmd, or through the installer while an update is downloaded; refused
    // while an agent drives the app, whose session would end with it
    ipcMain.handle("app:relaunch", () => {
        if (agentMode || local.clients.size) throw new Error("An agent is connected to Scumble; restart it after the agent is done.");
        if (assistant && assistant.busy()) throw new Error("The assistant is working; stop it first.");
        const plan = restartPlan({ argv: process.argv.slice(1), updateState: updater.status.state });
        quitGuard.release();   // the window saved before it asked (renderer/shell.js saveBeforeRestart)
        if (plan.install && installOrReset()) return { installing: updater.status.version };
        app.relaunch({ args: restartPlan({ argv: process.argv.slice(1) }).args });
        setImmediate(() => app.quit());
        return { relaunching: true };
    });
    // updates (electron/main/updater.js): GitHub Releases feed, checked at start unless switched off
    ipcMain.handle("update:status", () => updater.status);
    ipcMain.handle("update:check", () => updater.check({ manual: true }));
    // the installer ends every Scumble process as soon as it starts: the window saves first (quit.js)
    ipcMain.handle("update:install", async () => {
        if (updater.status.state !== "downloaded") return false;
        mirror.localOnly = true;
        const r = await quitGuard.run(() => flushWindow("update"));
        if (!r.ok) log.record({ level: "warn", source: "main", message: `installing the update without saving everything: ${r.timedOut ? "the window did not finish in time" : r.error || "the window did not answer"}` });
        return installOrReset();
    });
}

/**
 * Install the downloaded update (the window has saved). electron-updater may still decline it after this returns (an
 * install already called, no installer file): when no quit has begun ten seconds later, the next close saves again.
 */
function installOrReset() {
    const ok = updater.install();
    if (!ok) { mirror.localOnly = false; quitGuard.reset(); return false; }
    setTimeout(() => { if (!quitting) { mirror.localOnly = false; quitGuard.reset(); } }, 10000);
    return true;
}

// ---- lifecycle ------------------------------------------------------------------------

/** The app proper (after whenReady, holding the single-instance lock): window, socket, ComfyUI. */
function startApp() {
    // the last session's state becomes an earlier generation (autosave.js), also when an agent starts the app: what it
    // changes then never replaces the user's last state (the rotation moves only when the files differ)
    try { autosave.rotate(app.getPath("userData")); } catch (err) { console.warn("autosave: rotate", err.message); }
    installProtocol();
    installIpc();
    buildMenu();
    createWindow();
    local.listen(app.getPath("userData"));
    local.on("clients", (n) => { showAgents(); maybeQuit(); send("assistant:event", { type: "agents", n: local.clients.size + (agentMode ? 1 : 0), at: Date.now() }); });
    // a running assistant turn ends with the app; a relaunch between turns is refused while one runs (app:relaunch)
    app.on("before-quit", () => { quitting = true; if (assistant) assistant.stop(); if (help) help.stop(); });
    // --no-comfy: a test instance that stays off the server (no connect at start, so no upload is forwarded to it)
    const url = !process.argv.includes("--no-comfy") && settings.get().comfy && settings.get().comfy.url;
    if (url) connectComfy().catch((err) => console.warn("connect at start:", err.message));
    const upd = settings.get().updates || {};
    if (app.isPackaged && !headless && !agentMode && upd.check !== false) setTimeout(() => updater.check().catch(() => {}), 8000);
    app.on("activate", () => showWindow());
    app.on("window-all-closed", () => { comfy.disconnect(); app.quit(); });
}

/** An agent-started app ends when nobody talks to it any more and no window is shown. */
function maybeQuit() {
    if (ARGS.mcp && !agentMode && !windowVisible() && local.clients.size === 0) { agentsLeft = true; comfy.disconnect(); app.quit(); }
}

/**
 * The command backend for --mcp and --cmd: the running Scumble instance over the local socket
 * when there is one, otherwise this process starts the app headless and runs the commands in
 * it. A proxy whose instance went away reconnects, or takes over, at the next call.
 */
class AgentBackend extends require("node:events").EventEmitter {
    constructor() { super(); this.client = null; this.own = false; }

    async ensure() {
        if (this.own) return bridge;
        if (this.client && !this.client.closed) return this.client;
        const userData = app.getPath("userData");
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                this.client = await LocalClient.connect(userData);
                this.client.on("commands", () => this.emit("changed"));
                this.client.on("close", () => { this.client = null; });
                return this.client;
            } catch (_) { /* nobody listens */ }
            if (app.requestSingleInstanceLock()) {
                app.on("second-instance", () => showWindow());
                await app.whenReady();
                headless = true;
                startApp();
                bridge.on("changed", () => this.emit("changed"));
                this.own = true;
                return bridge;
            }
            await new Promise((r) => setTimeout(r, 1500));   // another instance is starting: its socket comes up in a moment
        }
        throw new Error("Scumble is running in another process but does not answer on the local socket");
    }

    async run(name, args) { return (await this.ensure()).run(name, args); }
    async describe() { return (await this.ensure()).describe(); }
    info() { return { mode: this.own ? (windowVisible() ? "window" : "headless") : "proxy", pid: process.pid }; }
}

async function agentMain() {
    const backend = new AgentBackend();
    if (ARGS.cmd) {
        let args = {};
        if (ARGS.cmdArgs) { try { args = JSON.parse(ARGS.cmdArgs); } catch (err) { throw new Error("the arguments must be JSON: " + err.message); } }
        let r;
        try { r = { ok: true, result: await backend.run(ARGS.cmd, args) }; }
        catch (err) { r = { ok: false, error: String((err && err.message) || err) }; }
        const out = r.ok ? JSON.stringify(r.result, null, 2) : "error: " + r.error;
        process.stdout.write(out + "\n", () => app.exit(r.ok ? 0 : 1));
        return;
    }
    // --mcp: serve stdio; the app (own or remote) is started right away so the first tool call is quick
    agentMode = "mcp";
    const mcp = require("./mcp/server");
    await mcp.serve(backend, {
        version: app.getVersion(),
        info: () => backend.info(),
        onClose: () => {
            agentMode = null;
            if (!backend.own) { if (backend.client) backend.client.close(); app.exit(0); return; }
            showAgents();
            maybeQuit();   // stays alive while the window is shown or a script is connected
        },
    });
    backend.ensure().then(() => { showAgents(); return backend.run("set_status", { text: "MCP client connected." }); })
        .catch((err) => console.error("MCP backend:", err.message));
}

app.setName("Scumble");
if (ARGS.mcp || ARGS.cmd) {
    agentMain().catch((err) => { process.stderr.write("scumble: " + (err.message || err) + "\n"); app.exit(1); });
} else if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on("second-instance", () => showWindow());
    app.whenReady().then(startApp);
}
