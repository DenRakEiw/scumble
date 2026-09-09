// Auto-update through GitHub Releases (electron-updater). electron-builder writes the feed
// (`publish` in package.json) into resources/app-update.yml; the updater reads latest.yml
// from the newest release, downloads the installer in the background and installs it when
// the user asks (or silently when the app quits). Only the windowed, packaged app checks on
// its own; headless and agent-started instances and the dev electron never download anything.
"use strict";

const { app } = require("electron");
const { EventEmitter } = require("node:events");

/** States: dev (not packaged), idle, checking, latest, downloading, downloaded, error. */
class Updater extends EventEmitter {
    constructor() {
        super();
        this.au = null;
        this.status = { state: app.isPackaged ? "idle" : "dev", current: app.getVersion(), version: null, percent: null, error: null, manual: false };
    }

    _load() {
        if (this.au) return this.au;
        const { autoUpdater } = require("electron-updater");
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.logger = {
            info: (m) => console.log("updater:", m),
            warn: (m) => console.warn("updater:", m),
            error: (m) => console.error("updater:", m),
            debug: () => {},
        };
        autoUpdater.on("checking-for-update", () => this._set({ state: "checking", error: null }));
        autoUpdater.on("update-available", (info) => this._set({ state: "downloading", version: info.version, percent: 0 }));
        autoUpdater.on("update-not-available", (info) => this._set({ state: "latest", version: info && info.version, percent: null }));
        autoUpdater.on("download-progress", (p) => this._set({ state: "downloading", percent: Math.round(p.percent) }));
        autoUpdater.on("update-downloaded", (info) => this._set({ state: "downloaded", version: info.version, percent: 100 }));
        autoUpdater.on("error", (err) => this._set({ state: "error", error: friendly(err) }));
        this.au = autoUpdater;
        return autoUpdater;
    }

    _set(patch) {
        this.status = { ...this.status, ...patch };
        this.emit("status", this.status);
    }

    /** Check the feed; `manual` marks a check the user asked for (the UI reports "up to date"). */
    async check({ manual = false } = {}) {
        if (!app.isPackaged) { this._set({ state: "dev", manual }); return this.status; }
        if (this.status.state === "checking" || this.status.state === "downloading") return this.status;
        if (this.status.state === "downloaded") { this._set({ manual }); return this.status; }
        this._set({ manual });
        try {
            await this._load().checkForUpdates();
        } catch (err) {
            this._set({ state: "error", error: friendly(err) });   // also reported through the error event
        }
        return this.status;
    }

    /** Quit and run the downloaded installer silently, then start the new version. */
    install() {
        if (this.status.state !== "downloaded" || !this.au) return false;
        setImmediate(() => this.au.quitAndInstall(true, true));
        return true;
    }
}

function friendly(err) {
    const m = String((err && err.message) || err || "unknown error");
    if (/404|Cannot find|Unable to find latest version/i.test(m)) return "No release published yet.";
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR|getaddrinfo/i.test(m)) return "GitHub is not reachable.";
    return m.split("\n")[0].slice(0, 200);
}

module.exports = { Updater };
