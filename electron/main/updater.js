// Auto-update through GitHub Releases (electron-updater). electron-builder writes the feed
// (`publish` in package.json) into resources/app-update.yml; the updater reads latest.yml
// from the newest release, downloads the installer in the background and installs it when
// the user asks (or silently when the app quits). Only the windowed, packaged app checks on
// its own; headless and agent-started instances and the dev electron never download anything.
// The Microsoft Store package never does either: the Store updates its copy (electron/main/msix.js).
// Modes (electron/main/portable.js updateMode): "install" is the above, for an NSIS install; "notify" is every other
// unpacked Windows copy (a portable zip, dist/win-unpacked): it checks the same feed, never downloads and never
// installs, and only says that a new version is out (state "available"; the window offers its release page).
"use strict";

const { app } = require("electron");
const { isStore } = require("./msix");
const { EventEmitter } = require("node:events");

const RELEASES = "https://github.com/DenRakEiw/scumble/releases";

/** A release's page on GitHub, what Download opens in a copy that does not update itself. */
function releaseUrl(version) {
    const v = String(version || "").replace(/^v/, "");
    return /^[0-9A-Za-z.+-]+$/.test(v) ? `${RELEASES}/tag/v${v}` : `${RELEASES}/latest`;
}

/**
 * States: dev (not packaged), store (the Store updates it), idle, checking, latest, downloading, downloaded,
 * available (notify mode: a newer version is out, nothing downloaded), error.
 */

/** The longest notes the Updates section shows (a release of the size of 0.1.37 is about 8,300 characters). */
const NOTES_MAX = 30000;

/**
 * What changed since the installed version, as plain text for the Updates section.
 *
 * GitHub's release feed carries the release body as **HTML** (`<ul><li><strong>…` with a
 * `<br>` per source line), and electron-updater passes it through. With `fullChangelog` (on, `_load`) it hands over
 * every release newer than this one up to the offered one, as [{version, note}] newest first; each gets its version
 * as a line of its own when there are several, and none carries its "Get Scumble" block (withoutDownloads). Lists
 * become bullets and a paragraph broken over
 * several source lines becomes one line again, because the renderer shows this as text and
 * never as markup - the string comes from a server.
 */
function releaseNotes(info) {
    const list = notesList(info);
    const parts = list.map(({ version, html }) => {
        const plain = plainText(html);
        return plain && list.length > 1 && version ? `${version}\n${plain}` : plain;
    }).filter(Boolean);
    if (!parts.length) return null;
    const text = parts.join("\n\n");
    if (text.length <= NOTES_MAX) return text;
    const line = text.lastIndexOf("\n", NOTES_MAX);
    return text.slice(0, line > NOTES_MAX / 2 ? line : NOTES_MAX).trimEnd() + "\n…";
}

function plainText(html) {
    const text = String(html || "")
        // a <br> is followed by a real newline in GitHub's HTML: both are one break
        .replace(/<br\s*\/?>\s*/gi, "\n")
        // cells sit on their own source lines; joining them first keeps a table row on one
        // line, and the row break below still separates the rows
        .replace(/<\/t[dh]>\s*(?=<)/gi, " · ")
        .replace(/<\/(p|h[1-6]|tr|div|blockquote)>/gi, "\n\n")
        .replace(/<li[^>]*>/gi, "\n• ")
        .replace(/<\/li>/gi, "\n")
        .replace(/<[^>]*>/g, "");
    const lines = [];
    for (const piece of entities(text).split("\n")) {
        const t = piece.trim().replace(/\s*·\s*$/, "");   // a table row ends without a separator
        if (!t) {
            if (lines.length && lines[lines.length - 1] !== "") lines.push("");
            continue;
        }
        // a wrapped line continues the bullet or paragraph above it
        if (t.startsWith("•") || !lines.length || lines[lines.length - 1] === "") lines.push(t);
        else lines[lines.length - 1] += " " + t;
    }
    return lines.join("\n").trim();
}

/**
 * One line per change, for the update question (renderer/shell.js announceUpdate): each top-level bullet's bold lead
 * (`<li><strong>Boxes: every box its own colour.</strong> A new box ...`, the CHANGELOG's summary of a change), or its
 * first sentence when it has none. A bullet's own sub-bullets are part of it, not changes of their own. Newest release
 * first, at most 30 lines; null when the notes hold no bullet. Plain text, like the notes.
 */
function releaseHeadlines(info) {
    const out = [];
    for (const { html } of notesList(info)) {
        for (const item of topItems(html)) {
            if (out.length >= 30) break;
            const own = item.split(/<(?:ul|ol)\b/i)[0];
            const lead = /^\s*(?:<p[^>]*>\s*)?<strong[^>]*>([\s\S]*?)<\/strong>/i.exec(own);
            const t = lead ? inline(lead[1]) : sentence(inline(own));
            if (t) out.push(t);
        }
    }
    return out.length ? out : null;
}

/** The inner HTML of every list item on the first level of a list (nested lists' items stay inside theirs). */
function topItems(html) {
    const items = [];
    const tag = /<(\/?)(ul|ol|li)\b[^>]*>/gi;
    let depth = 0, start = -1;
    for (let m; (m = tag.exec(String(html || "")));) {
        const close = m[1] === "/", name = m[2].toLowerCase();
        if (name !== "li") { depth = Math.max(0, depth + (close ? -1 : 1)); continue; }
        if (depth !== 1) continue;
        if (!close) {
            if (start >= 0) items.push(html.slice(start, m.index));   // an item left open ends at the next one
            start = m.index + m[0].length;
        } else if (start >= 0) {
            items.push(html.slice(start, m.index));
            start = -1;
        }
    }
    return items;
}

/** A piece of inline HTML as one line of text (a lead wrapped over two source lines carries a <br>). */
function inline(html) {
    return entities(String(html).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/** The first sentence of a bullet without a lead, at most about 160 characters. */
function sentence(t) {
    const m = /^(.+?[.!?])(?=\s|$)/.exec(t);
    const s = m ? m[1] : t;
    if (s.length <= 160) return s;
    const cut = s.lastIndexOf(" ", 157);
    return s.slice(0, cut > 80 ? cut : 157) + " …";
}

/**
 * The notes as electron-updater hands them over: one HTML string, or [{version, note}] with fullChangelog; each body
 * without its "Get Scumble" block (withoutDownloads), so neither the notes nor the update question show it.
 */
function notesList(info) {
    const raw = info && info.releaseNotes;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map((r) => ({ version: (r && r.version) || null, html: withoutDownloads(String((r && r.note) || "")) })).filter((r) => r.html);
    return [{ version: (info && info.version) || null, html: withoutDownloads(String(raw)) }];
}

/**
 * A release body without the "Get Scumble" block on top of it (tools/release_notes.py: a heading, a table of the
 * downloads, a line on the updater's files, a horizontal rule). It is for the release page, not a change. The feed
 * carries the body as GitHub renders it (`<h3>Get Scumble</h3>` ... `<hr>`; the web view adds attributes, an anchor
 * or a `<div class="markdown-heading">` around the heading): cut from that heading, of any level, to the first `<hr>`
 * after it, when that rule comes before any list or heading (the block has neither, the CHANGELOG section starts with
 * a list). A block that lost its rule loses only the heading and a table right under it. A body without the heading
 * (every release up to 0.1.42 as published) comes back as it is.
 */
function withoutDownloads(html) {
    const s = String(html || "");
    const heading = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
    for (let m; (m = heading.exec(s));) {
        if (!/^get scumble$/i.test(inline(m[2]))) continue;
        const wrap = /<div\b[^>]*\bmarkdown-heading\b[^>]*>\s*$/i.exec(s.slice(0, m.index));
        const start = wrap ? wrap.index : m.index;
        const rest = s.slice(m.index + m[0].length);
        const next = /<(hr|ul|ol|h[1-6])\b[^>]*>/i.exec(rest);
        if (next && next[1].toLowerCase() === "hr") return s.slice(0, start) + rest.slice(next.index + next[0].length);
        // no rule: the heading (with its wrapper's anchor and end) and a table right under it
        const tail = /^(?:\s*<a\b[^>]*>[\s\S]*?<\/a>)?(?:\s*<\/div>)?(?:\s*<markdown-accessib\w*-table\b[^>]*>)?(?:\s*<table\b[\s\S]*?<\/table>(?:\s*<\/markdown-accessib\w*-table>)?)?/i.exec(rest);
        return s.slice(0, start) + rest.slice(tail[0].length);
    }
    return s;
}

/** The few entities GitHub's HTML uses, decoded; `&amp;` last, so `&amp;lt;` stays the text "&lt;". */
function entities(s) {
    return s
        .replace(/&nbsp;/gi, " ")
        .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"').replace(/&#3?9;/gi, "'")
        .replace(/&amp;/gi, "&");
}

class Updater extends EventEmitter {
    /** @param {{ mode?: "dev" | "store" | "notify" | "install" }} [o] main.js passes portable.updateMode(...) */
    constructor({ mode } = {}) {
        super();
        this.au = null;
        this.mode = mode || (!app.isPackaged ? "dev" : isStore() ? "store" : "install");
        // `skip`: the version the user skipped (settings.updates.skip): it is offered, never installed on quit.
        // `announced`: the version this start asked about (renderer/shell.js announceUpdate), kept here so a window
        // reloaded after a crash does not ask again; the next start asks again
        this.status = { state: this.mode === "dev" ? "dev" : this.mode === "store" ? "store" : "idle", mode: this.mode, current: app.getVersion(), version: null, percent: null, error: null, manual: false, skip: null, announced: null };
    }

    _load() {
        if (this.au) return this.au;
        const { autoUpdater } = require("electron-updater");
        const notify = this.mode === "notify";
        // a copy that does not update itself never downloads, and never installs on quit: both off before any check
        autoUpdater.autoDownload = !notify;
        autoUpdater.autoInstallOnAppQuit = !notify;
        // the notes of every release since the installed one, not only the newest (releaseNotes)
        autoUpdater.fullChangelog = true;
        autoUpdater.logger = {
            info: (m) => console.log("updater:", m),
            warn: (m) => console.warn("updater:", m),
            error: (m) => console.error("updater:", m),
            debug: () => {},
        };
        autoUpdater.on("checking-for-update", () => this._set({ state: "checking", error: null }));
        autoUpdater.on("update-available", (info) => this._set(notify
            ? { state: "available", version: info.version, percent: null, url: releaseUrl(info.version), notes: releaseNotes(info), headlines: releaseHeadlines(info) }
            : { state: "downloading", version: info.version, percent: 0, notes: releaseNotes(info), headlines: releaseHeadlines(info) }));
        autoUpdater.on("update-not-available", (info) => this._set({ state: "latest", version: info && info.version, percent: null }));
        // notify mode asks for no download: one that came anyway is not offered for installing
        autoUpdater.on("download-progress", (p) => { if (!notify) this._set({ state: "downloading", percent: Math.round(p.percent) }); });
        autoUpdater.on("update-downloaded", (info) => { if (!notify) this._set({ state: "downloaded", version: info.version, percent: 100, notes: releaseNotes(info), headlines: releaseHeadlines(info) }); });
        autoUpdater.on("error", (err) => this._set({ state: "error", error: friendly(err) }));
        this.au = autoUpdater;
        this._applySkip();
        return autoUpdater;
    }

    _set(patch) {
        this.status = { ...this.status, ...patch };
        this._applySkip();
        this.emit("status", this.status);
    }

    /**
     * A skipped version is not installed when the app quits. electron-updater reads `autoInstallOnAppQuit` when a
     * download ends and again in its quit handler (6.8.9 BaseUpdater), so the switch follows the offered version and
     * the skip. It adds that handler once, when a download ends, and not at all while the switch is off: a skip taken
     * back after the download needs the handler now (`addQuitHandler` adds it once). Install still installs a skipped one.
     * In notify mode the switch stays off whatever happens and the handler is never added: this runs on every status
     * change, and turning the switch on here would install a download on the next quit.
     */
    _applySkip() {
        if (!this.au) return;
        if (this.mode === "notify") { this.au.autoInstallOnAppQuit = false; this.au.autoDownload = false; return; }
        const on = !(this.status.skip && this.status.version === this.status.skip);
        this.au.autoInstallOnAppQuit = on;
        if (on && this.status.state === "downloaded" && typeof this.au.addQuitHandler === "function") this.au.addQuitHandler();
    }

    /** Whether the downloaded version is the skipped one: not installed on quit, nor by a restart (main.js app:relaunch). */
    skipped() {
        return !!(this.status.skip && this.status.state === "downloaded" && this.status.version === this.status.skip);
    }

    /** The version the user skipped, from settings.updates.skip (main.js, at the start and on every settings write). */
    setSkip(version) {
        const skip = version ? String(version) : null;
        if (skip !== this.status.skip) this._set({ skip });
    }

    /** The window asked about this version (one question per start, renderer/shell.js announceUpdate). */
    announce(version) {
        const announced = version ? String(version) : null;
        if (announced !== this.status.announced) this._set({ announced });
        return this.status;
    }

    /**
     * Check the feed; `manual` marks a check the user asked for (the UI reports "up to date", and the update question
     * leaves the answer to Settings). A check that runs already, or a download in hand, answers with its status; a
     * manual one marks it, and a later automatic one never takes that back. A skipped download is checked again: a
     * newer version may be out.
     */
    async check({ manual = false } = {}) {
        if (this.mode === "dev" || !app.isPackaged) { this._set({ state: "dev", manual }); return this.status; }
        if (this.mode === "store" || this.status.state === "store") { this._set({ manual }); return this.status; }
        const s = this.status.state;
        if (s === "checking" || s === "downloading" || (s === "downloaded" && !this.skipped())) {
            if (manual && !this.status.manual) this._set({ manual: true });
            return this.status;
        }
        this._set({ manual });
        try {
            await this._load().checkForUpdates();
        } catch (err) {
            this._set({ state: "error", error: friendly(err) });   // also reported through the error event
        }
        return this.status;
    }

    /** Quit and run the downloaded installer silently, then start the new version. Never in notify mode. */
    install() {
        if (this.mode === "notify" || this.status.state !== "downloaded" || !this.au) return false;
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

module.exports = { Updater, releaseNotes, releaseHeadlines, releaseUrl };
