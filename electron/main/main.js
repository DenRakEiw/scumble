// Scumble main process: window, the scumble:// scheme (renderer files and the ComfyUI
// proxy under one origin), native menu and dialogs, settings, and the ComfyUI client.
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { app, BrowserWindow, protocol, net, ipcMain, dialog, Menu, shell, clipboard } = require("electron");
const settings = require("./settings");
const { ComfyClient, authHeaders } = require("./comfy");
const { FileMirror } = require("./files");
const keys = require("./keys");
const providers = require("./providers");
const llm = require("./llm");
const recipes = require("./recipes");
const prompts = require("./prompts");
const helpers = require("./onnx");
const plugins = require("./plugins");
const { Bridge } = require("./bridge");
const { LocalServer, LocalClient } = require("./local");
const { Updater } = require("./updater");

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
    ".svg": "image/svg+xml", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
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

function installProtocol() {
    protocol.handle(SCHEME, async (request) => {
        const url = new URL(request.url);
        if (url.host !== "app") return new Response("unknown host", { status: 404 });
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
    });
}

// ---- window ---------------------------------------------------------------------------

function createWindow() {
    const saved = settings.get().window || {};
    win = new BrowserWindow({
        width: saved.width || 1600,
        height: saved.height || 1000,
        x: saved.x, y: saved.y,
        minWidth: 1100, minHeight: 700,
        backgroundColor: "#181818",
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
        },
    });
    if (saved.maximized && !headless) win.maximize();
    win.once("ready-to-show", () => { if (!headless) win.show(); });
    win.on("close", (e) => {
        const b = win.getNormalBounds();
        settings.set({ window: { ...b, maximized: win.isMaximized() } });
        // while an agent drives the app, closing the window only hides it; the app ends
        // with the MCP session (or stays when a script still talks to the socket)
        if (agentMode) { e.preventDefault(); win.hide(); headless = true; }
    });
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
    bridge.attach(win.webContents);
    win.loadURL(ORIGIN + "/index.html");
}

/** Show the (headless or hidden) window: a second start of Scumble, or macOS activate. */
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
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Title suffix and a status line while agents (MCP, --cmd, scripts) are connected. */
function showAgents() {
    const n = local.clients.size + (agentMode ? 1 : 0);
    if (win && !win.isDestroyed()) win.setTitle(n ? `Scumble · ${n} agent${n > 1 ? "s" : ""} connected` : "Scumble");
}

let pluginActions = [];   // [{id, label, accelerator}] from renderer/plugins.js
const updater = new Updater();
updater.on("status", (s) => send("update:status", s));

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
                { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" },
                { type: "separator" },
                { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
                { type: "separator" },
                { role: "togglefullscreen" },
            ],
        },
        pluginMenu,
        {
            label: "&Help",
            submenu: [
                { label: "Editor guide", click: () => send("menu", "guide") },
                { label: "Scumble on GitHub", click: () => shell.openExternal("https://github.com/DenRakEiw/scumble") },
                { label: "Inpaint Canvas node on GitHub", click: () => shell.openExternal("https://github.com/DenRakEiw/ComfyUI-InpaintCanvas") },
                { type: "separator" },
                { label: "Copy MCP registration (Claude Code)", click: () => copyMcpRegistration("code") },
                { label: "Copy MCP registration (Claude Desktop JSON)", click: () => copyMcpRegistration("desktop") },
                { type: "separator" },
                { label: "Check for updates...", click: () => { updater.check({ manual: true }); send("menu", "settings-updates"); } },
                { type: "separator" },
                { label: `Scumble ${app.getVersion()} · Electron ${process.versions.electron} · GPL-3.0`, enabled: false },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * The registration line for an MCP client, with the paths of this installation. Clients get
 * the Node-mode launcher (electron/main/mcp/launch.js), never the exe with `--mcp`: Electron
 * writes a CR LF to stdout before any of our code runs and strict clients reject it.
 * Nobody types an asar path by hand, hence the menu entry.
 */
function mcpRegistration(kind) {
    const exe = app.isPackaged ? app.getPath("exe") : process.execPath;
    const launcher = app.isPackaged
        ? path.join(process.resourcesPath, "app.asar", "electron", "main", "mcp", "launch.js")
        : path.join(ROOT, "electron", "main", "mcp", "launch.js");
    if (kind === "desktop") {
        return JSON.stringify({ mcpServers: { scumble: { command: exe, args: [launcher, "--mcp"], env: { ELECTRON_RUN_AS_NODE: "1" } } } }, null, 2);
    }
    return `claude mcp add scumble -e ELECTRON_RUN_AS_NODE=1 -- "${exe}" "${launcher}" --mcp`;
}

function copyMcpRegistration(kind) {
    clipboard.writeText(mcpRegistration(kind));
    send("menu", "mcp-copied");
}

// ---- dialogs -------------------------------------------------------------------------

const IMAGE_FILTERS = [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff", "svg"] }, { name: "All files", extensions: ["*"] }];

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
    ipcMain.handle("state:load", () => settings.loadState());
    ipcMain.handle("state:save", (_e, state) => { settings.saveState(state); return true; });
    ipcMain.handle("comfy:connect", (_e, conn) => connectComfy(conn));
    ipcMain.handle("comfy:probe", (_e, conn) => probeComfy(conn));
    ipcMain.handle("comfy:disconnect", () => { comfy.disconnect(); return comfy.status; });
    ipcMain.handle("comfy:status", () => comfy.status);
    ipcMain.handle("comfy:clientId", () => comfy.clientId);
    ipcMain.handle("comfy:ensure", (_e, refs) => mirror.ensureOnServer(refs));
    ipcMain.handle("files:stats", () => mirror.stats());
    ipcMain.handle("files:prune", (_e, args) => mirror.prune(args || {}));
    ipcMain.handle("files:openFolder", async () => { const r = mirror.root(); await fsp.mkdir(r, { recursive: true }); return shell.openPath(r); });
    ipcMain.handle("file:open", () => openImage());
    ipcMain.handle("file:save", (_e, args) => saveFile(args));
    ipcMain.handle("file:read", (_e, file) => readFile(String(file)));
    ipcMain.handle("recipes:list", () => listRecipes());
    ipcMain.handle("recipes:import", (_e, file) => importRecipe(file));
    ipcMain.handle("recipes:remove", (_e, id) => recipes.remove(id));
    ipcMain.handle("recipes:openFolder", async () => { const r = recipes.userDir(); await fsp.mkdir(r, { recursive: true }); return shell.openPath(r); });
    ipcMain.handle("keys:list", () => keys.list());
    ipcMain.handle("keys:set", (_e, { name, value }) => keys.set(name, value));
    ipcMain.handle("keys:clear", (_e, name) => keys.clear(name));
    ipcMain.handle("providers:list", () => providers.describeAll());
    ipcMain.handle("provider:edit", (_e, request) => providers.edit(request));
    // vision language models on the provider keys (prompt upsampling)
    ipcMain.handle("llm:list", () => llm.list());
    ipcMain.handle("llm:ask", (_e, req) => llm.ask(req));
    ipcMain.handle("llm:models", (_e, url) => llm.compatModels(url));
    // prompt instruction templates (electron/main/prompts.js)
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
    ipcMain.handle("app:info", () => ({ version: app.getVersion(), electron: process.versions.electron, platform: process.platform, userData: app.getPath("userData"), pluginDir: plugins.userDir() }));
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
    // updates (electron/main/updater.js): GitHub Releases feed, checked at start unless switched off
    ipcMain.handle("update:status", () => updater.status);
    ipcMain.handle("update:check", () => updater.check({ manual: true }));
    ipcMain.handle("update:install", () => updater.install());
}

// ---- lifecycle ------------------------------------------------------------------------

/** The app proper (after whenReady, holding the single-instance lock): window, socket, ComfyUI. */
function startApp() {
    installProtocol();
    installIpc();
    buildMenu();
    createWindow();
    local.listen(app.getPath("userData"));
    local.on("clients", () => { showAgents(); maybeQuit(); });
    const url = settings.get().comfy && settings.get().comfy.url;
    if (url) connectComfy().catch((err) => console.warn("connect at start:", err.message));
    const upd = settings.get().updates || {};
    if (app.isPackaged && !headless && !agentMode && upd.check !== false) setTimeout(() => updater.check().catch(() => {}), 8000);
    app.on("activate", () => showWindow());
    app.on("window-all-closed", () => { comfy.disconnect(); app.quit(); });
}

/** An agent-started app ends when nobody talks to it any more and no window is shown. */
function maybeQuit() {
    if (ARGS.mcp && !agentMode && !windowVisible() && local.clients.size === 0) { comfy.disconnect(); app.quit(); }
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
