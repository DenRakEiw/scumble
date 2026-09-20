// The command bridge: runs a command of the renderer's command core (renderer/commands.js)
// from the main process. The MCP server (mcp/server.js), the local command socket (local.js)
// and `--cmd` go through here; every call is one round trip over IPC:
//
//     main   --commands:request {id, name, args}-->   renderer (commands.call)
//     main   <--commands:reply   {id, ok, result|error}--
//
// The renderer announces itself with `commands:ready` at the end of its start (plugins loaded,
// session restored); calls that arrive earlier wait for it. A reload of the window rejects
// every pending call and waits for the next ready.
"use strict";

const { EventEmitter } = require("node:events");
const { ipcMain } = require("electron");

const READY_TIMEOUT = 120000;   // ms to wait for the renderer's ready signal
const BASE_TIMEOUT = 600000;    // ms a command may take on top of its own `timeout` argument

class Bridge extends EventEmitter {
    constructor() {
        super();
        this.contents = null;
        this.ready = false;
        this.pending = new Map();   // id -> {resolve, reject, timer}
        this.seq = 0;
        this._waiters = [];
        ipcMain.on("commands:ready", (e) => { if (!this.contents || e.sender === this.contents) this._setReady(true); });
        ipcMain.on("commands:reply", (e, payload) => { if (!this.contents || e.sender === this.contents) this._reply(payload); });
        ipcMain.on("commands:changed", () => this.emit("changed"));
    }

    /**
     * The window's webContents the commands run in. `opts.navigates(url)` says whether a
     * navigation really takes the page away: Chromium fires `did-start-navigation` before the
     * `will-navigate` handler in main.js can prevent one (a file dropped on the window), and
     * dropping the readiness for a navigation that is then cancelled would leave the Bridge
     * waiting for a `commands:ready` that never comes again - every command of the session
     * would then wait 120 s and fail. The two rules have to say the same thing.
     */
    attach(contents, opts = {}) {
        this.contents = contents;
        this.navigates = typeof opts.navigates === "function" ? opts.navigates : () => true;
        this._setReady(false);
        const drop = (why) => { this._setReady(false); this._rejectAll(new Error(why)); };
        contents.on("did-start-navigation", (details) => {
            if (details.isSameDocument || !details.isMainFrame) return;
            if (!this.navigates(String(details.url || ""))) return;   // prevented in main: the page stays
            drop("the window reloaded");
        });
        contents.on("render-process-gone", (_e, d) => drop("the renderer process ended (" + (d && d.reason) + ")"));
        contents.on("destroyed", () => drop("the window closed"));
    }

    _setReady(on) {
        this.ready = on;
        if (on) { const w = this._waiters; this._waiters = []; for (const r of w) r(); this.emit("ready"); }
    }

    _waitReady(ms = READY_TIMEOUT) {
        if (this.ready) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => { this._waiters = this._waiters.filter((x) => x !== ok); reject(new Error("the editor did not become ready in " + Math.round(ms / 1000) + " s")); }, ms);
            const ok = () => { clearTimeout(t); resolve(); };
            this._waiters.push(ok);
        });
    }

    _reply(payload) {
        if (!payload || !this.pending.has(payload.id)) return;
        const p = this.pending.get(payload.id);
        this.pending.delete(payload.id);
        clearTimeout(p.timer);
        if (payload.ok) p.resolve(payload.result === undefined ? null : payload.result);
        else p.reject(new Error(payload.error || "command failed"));
    }

    _rejectAll(err) {
        for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(err); this.pending.delete(id); }
    }

    /**
     * Run one command; resolves with its result or rejects with the command core's message.
     * The command's own `timeout` argument (seconds) extends the bridge timeout, so a long
     * `generate` always ends in the editor first.
     */
    async run(name, args = {}, meta) {
        if (!this.contents || this.contents.isDestroyed()) throw new Error("no editor window");
        await this._waitReady();
        const id = ++this.seq;
        const extra = args && Number.isFinite(+args.timeout) ? Math.max(0, +args.timeout) * 1000 : 0;
        // the in-app assistant's requests carry `meta` (origin, the user-activity wait, the busy check,
        // the turn and its undo step; docs/PLAN_ASSISTANT.md §3); its abort signal stays here: when it
        // fires before the reply, the renderer is told to drop the request and the call rejects at once
        const { signal, ...wire } = meta && typeof meta === "object" ? meta : {};
        const withMeta = meta && typeof meta === "object";
        return new Promise((resolve, reject) => {
            let onAbort = null;
            const settle = () => { if (onAbort && signal) signal.removeEventListener("abort", onAbort); };
            const timer = setTimeout(() => { this.pending.delete(id); settle(); reject(new Error(`command "${name}" did not answer in time`)); }, BASE_TIMEOUT + extra);
            this.pending.set(id, { resolve: (v) => { settle(); resolve(v); }, reject: (e) => { settle(); reject(e); }, timer });
            if (signal && typeof signal.addEventListener === "function") {
                onAbort = () => {
                    if (!this.pending.has(id)) return;
                    clearTimeout(timer);
                    this.pending.delete(id);           // a late reply is ignored
                    this.cancel(id);
                    const err = new Error("stopped"); err.name = "AbortError";
                    reject(err);
                };
                if (signal.aborted) { clearTimeout(timer); this.pending.delete(id); const err = new Error("stopped"); err.name = "AbortError"; reject(err); return; }
                signal.addEventListener("abort", onAbort, { once: true });
            }
            const payload = { id, name: String(name), args: args || {} };
            if (withMeta) payload.meta = wire;
            try { this.contents.send("commands:request", payload); }
            catch (err) { clearTimeout(timer); this.pending.delete(id); settle(); reject(err); }
        });
    }

    /** Tell the renderer to drop a request that has not run yet (one still in the user-activity wait). */
    cancel(id) {
        if (!this.contents || this.contents.isDestroyed()) return;
        try { this.contents.send("commands:cancel", { id }); } catch (_) { /* the window is going */ }
    }

    /** Like run, never throws: {ok, result} or {ok: false, error}. */
    async call(name, args) {
        try { return { ok: true, result: await this.run(name, args) }; }
        catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
    }

    /** The command table ([{name, description, scope, needsImage, plugin, params}]). */
    async describe() {
        const r = await this.run("list_commands");
        return (r && r.commands) || [];
    }
}

module.exports = { Bridge };
