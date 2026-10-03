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
const { CLOUD_URL, popupAction, navigationAllowed } = require("./comfyhosts");

const BAR_H = 36;
const PARTITION = "persist:comfyui";
const READY_MS = 20000;     // how long a loaded page may take to offer window.app before the recipe is given up
const READY_STEP_MS = 400;
const MAX_GRAPH = 20 * 1024 * 1024;   // the page's graph, as JSON text, at most (§2.2)

// What the page answers is untrusted data (§2.2): only these fields are read, as booleans or a short string
const READY_JS = `(() => { const a = window.app; return { app: !!a, graph: !!(a && a.graph), api: !!(a && typeof a.loadApiJson === "function"),
    graphData: !!(a && typeof a.loadGraphData === "function"), read: !!(a && typeof a.graphToPrompt === "function"), version: String(window.__COMFYUI_FRONTEND_VERSION__ || "").slice(0, 40) }; })()`;

// The page's graph (§2.2 read): the UI graph and the API prompt, as JSON text so main can cap its size before parsing
const READ_JS = `(async () => { try { const p = await window.app.graphToPrompt();
    return { ok: true, workflow: JSON.stringify((p && p.workflow) || null), output: JSON.stringify((p && p.output) || null) }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 300) }; } })()`;

/** Whether a graph needs the Inpaint Canvas node (every ComfyUI recipe does; Comfy Cloud has none, §2.4). */
function needsCanvasNode(prompt) {
    return Object.values(prompt || {}).some((n) => n && n.class_type === "InpaintCanvas");
}

/** The script that hands a recipe's graph to the page: its UI graph when it has one, else the API prompt ComfyUI lays out. */
function loadScript(recipe) {
    const call = recipe.workflow
        ? `await window.app.loadGraphData(${JSON.stringify(recipe.workflow)})`
        : `await window.app.loadApiJson(${JSON.stringify(recipe.prompt)}, ${JSON.stringify(String(recipe.name || recipe.id))})`;
    return `(async () => { try { ${call}; return { ok: true }; } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 300) }; } })()`;
}

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
     * the main window; `saveRecipe({ output, workflow, objectInfo, heldId, name })` turns the page's graph into a
     * recipe and saves it (main.js: recipes.fromGraph), answering { recipe: { id, name, prompt, workflow }, message }.
     */
    constructor({ target, offline, settings, origin, preload, icon, background, openSettings, saveRecipe }) {
        this.target = target;
        this.offline = !!offline;
        this.settings = settings;
        this.origin = origin;
        this.preload = preload;
        this.icon = icon;
        this.background = background || (() => "#181818");
        this.openSettings = openSettings || (() => {});
        this.saveRecipe = saveRecipe || (async () => { throw new Error("saving is not wired"); });
        this.saveNote = "";
        this.win = null;
        this.bar = null;
        this.page = null;
        this.testUrl = "";
        this.shown = { url: "", origin: "", headers: {}, basic: null };   // what the page is loaded from
        this.phase = "closed";      // closed | none (no target) | loading | page | error
        this.message = "";
        this.logins = 0;
        // the recipe the window holds (V2): { id, name, prompt, workflow } from main (recipes.toPrompt), loaded into the
        // page once it offers window.app; `recipeNote` says why it is not there
        this.recipe = null;
        this.recipeNote = "";
        this.pageReady = false;
        this.frontend = "";
        this.readyGen = 0;
        this.can = null;        // what the page's window.app offers: { api, graphData }
        this.loaded = null;     // the id of the recipe the page was given last
        this.kind = "comfy";    // what the window shows: "comfy" (My ComfyUI) or "cloud" (Comfy Cloud, V4)
        this.children = new Set();   // Comfy Cloud's sign-in windows, closed with this one
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
        ipcMain.handle("comfyview:target", (e, kind) => { if (!fromBar(e)) refuse(); this.setTarget(kind); return this.state(); });
        ipcMain.handle("comfyview:save", (e, opts) => { if (!fromBar(e)) refuse(); const o = opts || {}; return this.save({ asNew: !!o.asNew, name: typeof o.name === "string" ? o.name.slice(0, 200) : "" }); });
    }

    /**
     * Open the window, or bring it to the front. `url` is a test's stub page, taken in a --no-comfy start only (a
     * normal start always shows the ComfyUI of Settings › ComfyUI). `recipe` ({ id, name, prompt, workflow }) is the
     * graph the window then holds: loaded into the page as soon as it offers one, named in the bar either way. `target`
     * ("comfy" / "cloud") switches what the window shows, as the bar's select does.
     */
    open({ url, recipe, target } = {}) {
        const test = this.offline && url ? String(url) : "";
        if (test) this.testUrl = test;
        if (target === "comfy" || target === "cloud") this.storeTarget(target);
        else if (!this.isOpen) this.kind = (this.settings.get().comfyView || {}).target === "cloud" ? "cloud" : "comfy";
        if (recipe) { this.recipe = recipe; this.recipeNote = this.cloudRefusal(recipe); }
        if (this.isOpen) {
            if (target && !test) { this.front(); this.load(); return this.info(); }
            this.front();
            if (test) this.load();
            else if (recipe && this.pageReady) this.loadRecipe();
            else this.sendState();
            return this.info();
        }
        this.create();
        this.load();
        return this.info();
    }

    close() {
        if (this.isOpen) this.win.close();
    }

    storeTarget(kind) {
        this.kind = kind === "cloud" ? "cloud" : "comfy";
        const cur = this.settings.get().comfyView || {};
        if (cur.target !== this.kind) this.settings.set({ comfyView: { ...cur, target: this.kind } });
    }

    /** The bar's select and the start page's Use Comfy Cloud: the other target, loaded at once and kept for next time. */
    setTarget(kind) {
        this.storeTarget(kind);
        if (this.recipe) this.recipeNote = this.cloudRefusal(this.recipe);
        this.load();
    }

    /** On Comfy Cloud a recipe with the Inpaint Canvas node does not open: why, or "" when it can. */
    cloudRefusal(recipe) {
        if (this.kind !== "cloud" || !recipe || !needsCanvasNode(recipe.prompt)) return "";
        return "Comfy Cloud has no Inpaint Canvas node and takes no custom nodes: this recipe opens on your own ComfyUI (Show: My ComfyUI).";
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

        // the page: links to other origins go to the system browser; the page stays on the target's origin, and on Comfy
        // Cloud its sign-in opens as a child window in the same partition (electron/main/comfyhosts.js)
        const wc = page.webContents;
        wc.setWindowOpenHandler(({ url }) => {
            const act = popupAction(url, this.kind);
            if (act === "child") {
                return { action: "allow", overrideBrowserWindowOptions: {
                    width: 520, height: 720, title: "Sign in to Comfy Cloud", autoHideMenuBar: true, backgroundColor: this.background(),
                    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
                } };
            }
            if (act === "external") shell.openExternal(url);
            return { action: "deny" };
        });
        wc.on("did-create-window", (child) => {
            this.children.add(child);
            child.on("closed", () => this.children.delete(child));
            if (process.platform !== "darwin") child.setMenu(null);
            child.webContents.setIgnoreMenuShortcuts(true);
            child.webContents.setWindowOpenHandler(({ url }) => { if (popupAction(url, "cloud") !== "deny") shell.openExternal(url); return { action: "deny" }; });
        });
        wc.on("will-navigate", (e, url) => {
            if (navigationAllowed(url, this.shown.origin, this.kind)) return;
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
        // the page's scripts ran: wait for window.app, then hand it the recipe the window holds
        wc.on("did-finish-load", () => { if (this.phase === "page") this.waitReady(); });
        wc.on("render-process-gone", (_e, d) => this.fail(`The ComfyUI page stopped (${(d && d.reason) || "gone"}). Reload loads it again.`));

        win.on("resize", () => this.layout());
        win.on("close", () => {
            const cur = this.settings.get().comfyView || {};
            this.settings.set({ comfyView: { ...cur, bounds: win.getNormalBounds(), maximized: win.isMaximized() } });
        });
        win.on("closed", () => {
            for (const c of this.children) { try { if (!c.isDestroyed()) c.close(); } catch (_) { /* gone */ } }
            this.children.clear();
            for (const v of [bar, page]) { try { if (!v.webContents.isDestroyed()) v.webContents.close(); } catch (_) { /* gone */ } }
            try { this.session().webRequest.onBeforeSendHeaders(null); } catch (_) { /* gone */ }
            if (this.win === win) { this.win = null; this.bar = null; this.page = null; }
            this.testUrl = "";      // a test's stub belongs to the window it opened
            this.recipe = null;     // and so does the recipe it held
            this.recipeNote = "";
            this.saveNote = "";
            this.pageReady = false;
            this.readyGen++;
            this.phase = "closed";
            this.message = "";
        });
        this.layout();
    }

    session() { return session.fromPartition(PARTITION); }

    /** What the window shows now: the test's stub, the user's ComfyUI, or nothing (and why). */
    resolve() {
        if (this.kind === "cloud") {
            if (this.offline && !this.testUrl) return { url: "", why: "This start of Scumble does not connect to Comfy Cloud (--no-comfy)." };
            return { url: this.offline ? this.testUrl.replace(/\/+$/, "") : CLOUD_URL, headers: {}, basic: null };   // the sign-in happens in the page
        }
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
        this.win.setTitle(this.kind === "cloud" ? "Comfy Cloud" : host ? `ComfyUI · ${host}` : "ComfyUI");
        if (!t.url) { this.setPhase("none", t.why); return; }
        this.logins = 0;
        this.pageReady = false;
        this.loaded = null;
        this.saveNote = "";
        this.readyGen++;
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

    /** Poll the loaded page for window.app (ComfyUI's frontend sets it up after its extensions); a new load cancels it. */
    async waitReady() {
        const gen = ++this.readyGen;
        const t0 = Date.now();
        let r = null;
        while (gen === this.readyGen && this.isOpen && this.phase === "page") {
            try { r = await this.page.webContents.executeJavaScript(READY_JS, true); } catch (_) { r = null; }
            if (gen !== this.readyGen || !this.isOpen) return;
            const ok = !!(r && r.graph && (r.api || r.graphData));
            this.frontend = r && typeof r.version === "string" ? r.version.slice(0, 40) : "";
            if (ok) {
                this.pageReady = true;
                this.can = { api: !!r.api, graphData: !!r.graphData, read: !!r.read };
                if (this.recipe) await this.loadRecipe(); else this.sendState();
                return;
            }
            if (Date.now() - t0 > READY_MS) {
                if (this.recipe) this.recipeNote = `This ComfyUI page offers no way to load a graph (frontend ${this.frontend || "unknown"}).`;
                this.sendState();
                return;
            }
            await new Promise((res) => setTimeout(res, READY_STEP_MS));
        }
    }

    /** Hand the held recipe's graph to the page (§2.2 load); its answer is only read as ok / a short error. */
    async loadRecipe() {
        const recipe = this.recipe;
        if (!recipe || !this.pageReady || !this.isOpen) return;
        const refusal = this.cloudRefusal(recipe);
        if (refusal) { this.recipeNote = refusal; this.sendState(); return; }
        const can = this.can || {};
        if (recipe.workflow ? !can.graphData : !can.api) {
            this.recipeNote = `This ComfyUI page offers no way to load ${recipe.workflow ? "a saved graph" : "an API prompt"} (frontend ${this.frontend || "unknown"}).`;
            this.sendState();
            return;
        }
        const gen = this.readyGen;
        let r = null;
        try { r = await this.page.webContents.executeJavaScript(loadScript(recipe), true); } catch (err) { r = { ok: false, error: (err && err.message) || String(err) }; }
        if (gen !== this.readyGen || recipe !== this.recipe) return;
        this.recipeNote = r && r.ok === true ? "" : `The graph did not load: ${String((r && r.error) || "no answer").slice(0, 300)}`;
        this.loaded = r && r.ok === true ? recipe.id : null;
        this.sendState();
    }

    /**
     * The bar's Save to recipe (overwrites the recipe the window holds) and Save as new recipe (`name`): the page's
     * graph read (§2.2), the node list of the server it came from, then main's saveRecipe. The answer goes to the bar.
     */
    async save({ asNew, name }) {
        const done = (ok, message) => { this.saveNote = message; this.sendState(); return { ok, message }; };
        if (!this.isOpen || !this.pageReady) return done(false, "The page is not ready: wait until ComfyUI has loaded.");
        if (!this.can || !this.can.read) return done(false, `This ComfyUI page offers no way to read its graph (frontend ${this.frontend || "unknown"}).`);
        if (!asNew && !this.recipe) return done(false, "This window holds no recipe: use Save as new recipe.");
        let r = null;
        try { r = await this.page.webContents.executeJavaScript(READ_JS, true); } catch (err) { r = { ok: false, error: (err && err.message) || String(err) }; }
        if (!r || r.ok !== true || typeof r.output !== "string" || typeof r.workflow !== "string") return done(false, `The page did not hand over its graph: ${String((r && r.error) || "no answer").slice(0, 300)}`);
        if (r.output.length > MAX_GRAPH || r.workflow.length > MAX_GRAPH) return done(false, "The page's graph is larger than 20 MB.");
        let output, workflow;
        try { output = JSON.parse(r.output); workflow = JSON.parse(r.workflow); } catch (_) { return done(false, "The page's graph is not JSON."); }
        const objectInfo = await this.objectInfo();
        try {
            const saved = await this.saveRecipe({ output, workflow, objectInfo, heldId: this.recipe ? this.recipe.id : null, name: asNew ? name : "" });
            this.recipe = saved.recipe;
            this.loaded = saved.recipe.id;
            this.recipeNote = "";
            return done(true, saved.message);
        } catch (err) {
            return done(false, String((err && err.message) || err));
        }
    }

    /** The node list of the server the page came from ({} when it cannot be read): never another server's (§2.5). */
    async objectInfo() {
        const { url, headers } = this.shown;
        if (!url) return {};
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 15000);
        try {
            const res = await fetch(url + "/object_info", { headers, signal: ac.signal });
            if (!res.ok) return {};
            const j = await res.json();
            return j && typeof j === "object" && !Array.isArray(j) ? j : {};
        } catch (_) {
            return {};
        } finally {
            clearTimeout(timer);
        }
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
        const r = this.recipe;
        return {
            phase: this.phase, message: this.message, url: this.shown.url, host, target: this.kind, offline: this.offline,
            recipe: r ? String(r.name || r.id) : null, recipeId: r ? r.id : null, recipeNote: this.recipeNote,
            recipeLoaded: !!(r && this.loaded === r.id && this.pageReady), frontend: this.frontend,
            // a graph without the Inpaint Canvas node becomes a Comfy Cloud recipe (main.js saveComfyGraph, V5c)
            canSaveNew: !!(this.pageReady && this.can && this.can.read), canSave: !!(this.pageReady && this.can && this.can.read && r),
            saveNote: this.saveNote,
        };
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
