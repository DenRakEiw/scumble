// The ComfyUI window (item 35 V1, docs/PLAN_COMFY_VIEW.md §2.1): ComfyUI's own page in a window of Scumble's, with a
// bar of Scumble's on top. Made when the user first opens it and destroyed when it closes (the page holds hundreds of
// MB with a large graph); nothing here runs at start, and no request goes anywhere until the window is opened.
//
// One BaseWindow, two views:
// - the bar (scumble://app/comfybar.html with electron/comfybar_preload.js): the target, the recipe the window holds,
//   the save buttons (V3) and Reload. It is the only way into main from this window: every comfyview:* call it makes
//   is answered for its webContents alone;
// - the page (a WebContentsView in the partition persist:comfyui, sandboxed, **no preload**): it runs the JavaScript
//   of every custom node pack on that server, so it must never reach window.scumble, IPC, scumble:// or a key. Auth
//   reaches it only as headers on requests to the target's origin (and a `login` answer for basic auth).
// With no ComfyUI to show (no address set, the server does not answer, --no-comfy), the bar's own start page fills
// the window (§2.5): nothing retries by itself, Reload tries again.
"use strict";

const { BaseWindow, WebContentsView, session, shell, ipcMain } = require("electron");

const BAR_H = 36;
const PARTITION = "persist:comfyui";

/** The origin of an http(s) URL, or "" for anything else. */
function originOf(url) {
    try { const u = new URL(String(url)); return /^https?:$/.test(u.protocol) ? u.origin : ""; } catch (_) { return ""; }
}

/**
 * The `session.webRequest` URL patterns of an http(s) origin: its own and its websocket twin. The http pattern alone
 * does not reach the page's websocket (measured 2026-10-03 on Electron 44.2.0: a bearer header filtered on
 * `http://host/*` only, and the `/ws` handshake went without it; with the `ws://` pattern beside it, all four auth
 * types reached both).
 */
function requestPatterns(origin) {
    return [origin + "/*", origin.replace(/^http/, "ws") + "/*"];
}

/** Whether a request URL (http, https, ws, wss) belongs to an http(s) origin. */
function sameOrigin(url, origin) {
    if (!origin) return false;
    try {
        const u = new URL(String(url));
        const proto = u.protocol === "ws:" ? "http:" : u.protocol === "wss:" ? "https:" : u.protocol;
        return `${proto}//${u.host}` === origin;
    } catch (_) { return false; }
}

class ComfyView {
    /**
     * `target()` -> { url, headers, basic: { user, password } | null } of the user's ComfyUI (settings.comfy and the
     * key store; url "" when none is set); `offline` a --no-comfy start, which shows no ComfyUI unless a test passes
     * a stub's URL to open(); `settings` the settings module (the window's bounds); `origin` scumble://app; `preload`
     * the bar's preload; `icon`, `background()` the window's look; `openSettings()` brings Settings › ComfyUI up in
     * the main window.
     */
    constructor({ target, offline, settings, origin, preload, icon, background, openSettings }) {
        this.target = target;
        this.offline = !!offline;
        this.settings = settings;
        this.origin = origin;
        this.preload = preload;
        this.icon = icon;
        this.background = background || (() => "#181818");
        this.openSettings = openSettings || (() => {});
        this.win = null;
        this.bar = null;
        this.page = null;
        this.testUrl = "";
        this.shown = { url: "", origin: "", headers: {}, basic: null };   // what the page is loaded from
        this.phase = "closed";      // closed | none (no target) | loading | page | error
        this.message = "";
        this.logins = 0;
        this.installIpc();
    }

    get isOpen() { return !!(this.win && !this.win.isDestroyed()); }

    /** The bar's calls: answered for the bar's webContents only (§4: the page has no preload, the main window no such call). */
    installIpc() {
        const fromBar = (e) => this.isOpen && this.bar && !this.bar.webContents.isDestroyed() && e.sender === this.bar.webContents;
        const refuse = () => { throw new Error("comfyview: only the ComfyUI window's bar may call this"); };
        ipcMain.handle("comfyview:state", (e) => (fromBar(e) ? this.state() : refuse()));
        ipcMain.handle("comfyview:reload", (e) => { if (!fromBar(e)) refuse(); this.load(); return this.state(); });
        ipcMain.handle("comfyview:settings", (e) => { if (!fromBar(e)) refuse(); this.openSettings(); return true; });
    }

    /**
     * Open the window, or bring it to the front. `url` is a test's stub page, taken in a --no-comfy start only (a
     * normal start always shows the ComfyUI of Settings › ComfyUI).
     */
    open({ url } = {}) {
        const test = this.offline && url ? String(url) : "";
        if (test) this.testUrl = test;
        if (this.isOpen) {
            this.front();
            if (test) this.load();
            return this.info();
        }
        this.create();
        this.load();
        return this.info();
    }

    close() {
        if (this.isOpen) this.win.close();
    }

    front() {
        if (!this.isOpen) return;
        if (this.win.isMinimized()) this.win.restore();
        this.win.show();
        this.win.focus();
        if (this.phase === "page") this.page.webContents.focus();
    }

    /** Scumble's menu set again (buildMenu) is put on every window on Windows and Linux: this one stays without it. */
    dropMenu() {
        if (this.isOpen && process.platform !== "darwin") this.win.setMenu(null);
    }

    create() {
        const saved = (this.settings.get().comfyView || {});
        const b = saved.bounds || {};
        const win = new BaseWindow({
            width: b.width || 1400, height: b.height || 900, x: b.x, y: b.y,
            minWidth: 640, minHeight: 420,
            title: "ComfyUI", icon: this.icon, backgroundColor: this.background(),
        });
        this.win = win;
        // no menu here (Windows, Linux), and neither view takes the application menu's shortcuts (macOS keeps its
        // global menu): ComfyUI's own Ctrl+S, Ctrl+Z and Ctrl+Enter reach the page, never Scumble's Save or Reload
        this.dropMenu();
        const bar = new WebContentsView({ webPreferences: { preload: this.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } });
        const page = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } });
        this.bar = bar;
        this.page = page;
        bar.setBackgroundColor(this.background());
        win.contentView.addChildView(page);
        win.contentView.addChildView(bar);     // on top: the start page covers the page view
        for (const v of [bar, page]) v.webContents.setIgnoreMenuShortcuts(true);
        if (saved.maximized) win.maximize();

        // the bar: the app's own file, nothing else
        const barUrl = this.origin + "/comfybar.html";
        bar.webContents.on("will-navigate", (e) => e.preventDefault());
        bar.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
        bar.webContents.on("did-finish-load", () => this.sendState());
        bar.webContents.loadURL(barUrl).catch(() => { /* a reload or a close while it loads */ });

        // the page: links to other origins go to the system browser; the page stays on the target's origin
        const wc = page.webContents;
        wc.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
        wc.on("will-navigate", (e, url) => {
            if (sameOrigin(url, this.shown.origin)) return;
            e.preventDefault();
            if (/^https?:\/\//.test(String(url))) shell.openExternal(url);
        });
        // basic auth: the stored user and password, once per load (a wrong password must not ask forever, and no
        // browser prompt ever shows); never for a proxy or another origin
        wc.on("login", (e, details, authInfo, callback) => {
            e.preventDefault();
            const b2 = this.shown.basic;
            if (b2 && !authInfo.isProxy && sameOrigin(details.url, this.shown.origin) && this.logins++ === 0) callback(b2.user, b2.password);
            else callback();
        });
        wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
            if (!isMainFrame || code === -3) return;   // -3: aborted (a new load replaced it)
            this.fail(`ComfyUI at ${url || this.shown.url} does not answer (${desc || code}).`);
        });
        wc.on("did-navigate", (_e, url, status, statusText) => {
            if (status >= 400) {
                const auth = status === 401 || status === 403 ? " Check the auth under Settings › ComfyUI." : "";
                this.fail(`${url} answered ${status}${statusText ? " " + statusText : ""}.${auth}`);
                return;
            }
            this.setPhase("page", "");
            // the keys go to the page, not to the bar (ComfyUI's own shortcuts), when the window is in front
            if (this.win && this.win.isFocused()) wc.focus();
        });
        wc.on("render-process-gone", (_e, d) => this.fail(`The ComfyUI page stopped (${(d && d.reason) || "gone"}). Reload loads it again.`));

        win.on("resize", () => this.layout());
        win.on("close", () => {
            const cur = this.settings.get().comfyView || {};
            this.settings.set({ comfyView: { ...cur, bounds: win.getNormalBounds(), maximized: win.isMaximized() } });
        });
        win.on("closed", () => {
            for (const v of [bar, page]) { try { if (!v.webContents.isDestroyed()) v.webContents.close(); } catch (_) { /* gone */ } }
            try { this.session().webRequest.onBeforeSendHeaders(null); } catch (_) { /* gone */ }
            if (this.win === win) { this.win = null; this.bar = null; this.page = null; }
            this.testUrl = "";      // a test's stub belongs to the window it opened
            this.phase = "closed";
            this.message = "";
        });
        this.layout();
    }

    session() { return session.fromPartition(PARTITION); }

    /** What the window shows now: the test's stub, the user's ComfyUI, or nothing (and why). */
    resolve() {
        if (this.offline && !this.testUrl) return { url: "", why: "This start of Scumble does not connect to ComfyUI (--no-comfy)." };
        const t = this.target() || {};
        const url = String(this.offline ? this.testUrl : t.url || "").trim().replace(/\/+$/, "");
        if (!url) return { url: "", why: "No ComfyUI address is set." };
        if (!originOf(url)) return { url: "", why: `The ComfyUI address ${url} is not an http or https URL.` };
        return { url, headers: t.headers || {}, basic: t.basic || null };
    }

    /** Load the target (or show why there is none); Reload in the bar does the same, with the settings read again. */
    load() {
        if (!this.isOpen) return;
        const t = this.resolve();
        const origin = originOf(t.url);
        this.shown = { url: t.url, origin, headers: t.headers || {}, basic: t.basic || null };
        this.applyHeaders();
        let host = "";
        try { host = t.url ? new URL(t.url).host : ""; } catch (_) { /* none */ }
        this.win.setTitle(host ? `ComfyUI · ${host}` : "ComfyUI");
        if (!t.url) { this.setPhase("none", t.why); return; }
        this.logins = 0;
        this.setPhase("loading", "");
        this.page.webContents.loadURL(t.url + "/").catch(() => { /* did-fail-load says why */ });
    }

    /** The auth headers on every request of the page to the target's origin, its websocket included, and nowhere else. */
    applyHeaders() {
        const ses = this.session();
        const { origin, headers } = this.shown;
        if (!origin || !Object.keys(headers).length) { ses.webRequest.onBeforeSendHeaders(null); return; }
        ses.webRequest.onBeforeSendHeaders({ urls: requestPatterns(origin) }, (d, cb) => {
            if (!sameOrigin(d.url, this.shown.origin)) { cb({}); return; }
            cb({ requestHeaders: { ...d.requestHeaders, ...this.shown.headers } });
        });
    }

    fail(message) { this.setPhase("error", message); }

    setPhase(phase, message) {
        this.phase = phase;
        this.message = message || "";
        this.layout();
        this.sendState();
    }

    /** The bar is a strip over the page while there is one; otherwise its start page fills the window. */
    layout() {
        if (!this.isOpen || !this.bar) return;
        const { width, height } = this.win.getContentBounds();
        const withPage = this.phase === "page" || this.phase === "loading";
        this.bar.setBounds({ x: 0, y: 0, width, height: withPage ? BAR_H : height });
        this.page.setBounds({ x: 0, y: BAR_H, width, height: Math.max(0, height - BAR_H) });
        this.page.setVisible(withPage);
    }

    state() {
        let host = "";
        try { host = this.shown.url ? new URL(this.shown.url).host : ""; } catch (_) { /* none */ }
        return { phase: this.phase, message: this.message, url: this.shown.url, host, target: "comfy", recipe: null, offline: this.offline };
    }

    sendState() {
        if (this.bar && !this.bar.webContents.isDestroyed()) this.bar.webContents.send("comfyview:state", this.state());
    }

    /** For the gates: what the window is and shows. */
    info() {
        const open = this.isOpen;
        return {
            ...this.state(), open,
            focused: open && this.win.isFocused(),
            bounds: open ? this.win.getBounds() : null,
            title: open ? this.win.getTitle() : "",
            page: open ? { url: this.page.webContents.getURL(), visible: this.phase === "page" || this.phase === "loading" } : null,
            bar: open ? { url: this.bar.webContents.getURL() } : null,
        };
    }
}

module.exports = { ComfyView, originOf, sameOrigin, requestPatterns, PARTITION, BAR_H };
