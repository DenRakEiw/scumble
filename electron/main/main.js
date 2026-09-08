// Scumble main process: window, the scumble:// scheme (renderer files and the ComfyUI
// proxy under one origin), native menu and dialogs, settings, and the ComfyUI client.
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { app, BrowserWindow, protocol, net, ipcMain, dialog, Menu, shell } = require("electron");
const settings = require("./settings");
const { ComfyClient, authHeaders } = require("./comfy");
const { FileMirror } = require("./files");
const keys = require("./keys");
const providers = require("./providers");
const recipes = require("./recipes");
const helpers = require("./onnx");

const ROOT = path.join(__dirname, "..", "..");
const RENDERER_DIR = path.join(ROOT, "renderer");
const RECIPES_DIR = path.join(ROOT, "recipes");
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

async function serveFile(pathname) {
    const rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    const abs = path.normalize(path.join(RENDERER_DIR, rel));
    if (!abs.startsWith(RENDERER_DIR + path.sep) && abs !== RENDERER_DIR) return new Response("forbidden", { status: 403 });
    try {
        const data = await fsp.readFile(abs);
        const type = MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
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
                if (rel === "/view" && (request.method === "GET" || request.method === "HEAD")) return await mirror.handleView(url.search);
            } catch (err) {
                console.error("mirror", rel, err);
                return new Response("file mirror error: " + (err.message || err), { status: 500 });
            }
            return comfy.proxy(request, rel + url.search);
        }
        return serveFile(url.pathname);
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
    if (saved.maximized) win.maximize();
    win.once("ready-to-show", () => win.show());
    win.on("close", () => {
        const b = win.getNormalBounds();
        settings.set({ window: { ...b, maximized: win.isMaximized() } });
    });
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
    win.loadURL(ORIGIN + "/index.html");
}

function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function buildMenu() {
    const isMac = process.platform === "darwin";
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
        {
            label: "&Help",
            submenu: [
                { label: "Editor guide", click: () => send("menu", "guide") },
                { label: "Inpaint Canvas node on GitHub", click: () => shell.openExternal("https://github.com/DenRakEiw/ComfyUI-InpaintCanvas") },
                { type: "separator" },
                { label: `Scumble ${app.getVersion()} · Electron ${process.versions.electron}`, enabled: false },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- dialogs -------------------------------------------------------------------------

const IMAGE_FILTERS = [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"] }, { name: "All files", extensions: ["*"] }];

async function openImage() {
    const r = await dialog.showOpenDialog(win, { title: "Open image", properties: ["openFile"], filters: IMAGE_FILTERS });
    if (r.canceled || !r.filePaths.length) return null;
    const file = r.filePaths[0];
    const data = await fsp.readFile(file);
    const payload = { name: path.basename(file), path: file, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
    send("file:opened", payload);
    return payload;
}

/** Write bytes to a file. With `path` given (scripts, MCP export) no dialog is shown. */
async function saveFile({ name, data, filters, path: target }) {
    const ext = path.extname(name || "").slice(1).toLowerCase();
    let filePath = target;
    if (!filePath) {
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
    ipcMain.handle("recipes:list", () => listRecipes());
    ipcMain.handle("recipes:import", (_e, file) => importRecipe(file));
    ipcMain.handle("recipes:remove", (_e, id) => recipes.remove(id));
    ipcMain.handle("recipes:openFolder", async () => { const r = recipes.userDir(); await fsp.mkdir(r, { recursive: true }); return shell.openPath(r); });
    ipcMain.handle("keys:list", () => keys.list());
    ipcMain.handle("keys:set", (_e, { name, value }) => keys.set(name, value));
    ipcMain.handle("keys:clear", (_e, name) => keys.clear(name));
    ipcMain.handle("providers:list", () => providers.describeAll());
    ipcMain.handle("provider:edit", (_e, request) => providers.edit(request));
    // in-app helper models (electron/main/onnx): SAM2 objects, background removal
    helpers.setProgressSink((ev) => send("helpers:progress", ev));
    ipcMain.handle("helpers:status", () => helpers.status());
    ipcMain.handle("helpers:configure", (_e, patch) => helpers.configure(patch));
    ipcMain.handle("helpers:browseDir", () => helpers.browseDir(win));
    ipcMain.handle("helpers:openFolder", () => helpers.openFolder());
    ipcMain.handle("helpers:download", (_e, id) => helpers.download(id));
    ipcMain.handle("helpers:cancel", (_e, id) => helpers.cancel(id));
    ipcMain.handle("helpers:remove", (_e, id) => helpers.remove(id));
    ipcMain.handle("helpers:free", () => helpers.free());
    ipcMain.handle("helpers:objects", (_e, req) => helpers.objects(req));
    ipcMain.handle("helpers:segment", (_e, req) => helpers.segment(req));
    ipcMain.handle("helpers:cutout", (_e, req) => helpers.cutout(req));
    ipcMain.handle("app:info", () => ({ version: app.getVersion(), electron: process.versions.electron, platform: process.platform, userData: app.getPath("userData") }));
    ipcMain.handle("app:openExternal", (_e, url) => { if (/^https?:\/\//.test(String(url))) shell.openExternal(url); });
}

// ---- lifecycle ------------------------------------------------------------------------

app.setName("Scumble");
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
    app.whenReady().then(() => {
        installProtocol();
        installIpc();
        buildMenu();
        createWindow();
        const url = settings.get().comfy && settings.get().comfy.url;
        if (url) connectComfy().catch((err) => console.warn("connect at start:", err.message));
        app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
    });
    app.on("window-all-closed", () => { comfy.disconnect(); app.quit(); });
}
