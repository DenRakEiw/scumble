"use strict";
// Files the user chose, served to the window by a token instead of sent in one IPC message (docs/BUGS.md "Ctrl+O sends
// the whole file to the window in one message"; the videos of CLAUDE.md item 68 first, electron/main/videofiles.js).
// One IPC message of about 512 MiB ends the renderer (G2, docs/PLAN_WASM_BUILD.md §7), and a message the window has to
// take whole blocks it while it is copied in. Main grants a path it was handed (the open dialog's answer, a command's
// `path`) a random token and serves the file at scumble://app/<route>/<token> with HTTP ranges; the window fetches what
// it reads and releases the token. Nothing else is reachable through the route: no path in the URL, only a token main
// made, dropped by release() or when more than `max` are held (the oldest first).

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");

/**
 * A Range header against a file of `size` bytes: { start, end } (end inclusive), null for none (the whole file), or
 * "bad" (unsatisfiable: 416). Only the one-range form `bytes=a-b`, `bytes=a-` and `bytes=-n`, which is what Chromium's
 * player and a sliced fetch send; a multi-range header is answered whole.
 */
function parseRange(header, size) {
    if (!header) return null;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
    if (!m) return null;
    let start, end;
    if (m[1] === "" && m[2] === "") return null;
    if (m[1] === "") {
        const n = +m[2];
        if (!(n > 0)) return "bad";
        start = Math.max(0, size - n);
        end = size - 1;
    } else {
        start = +m[1];
        end = m[2] === "" ? size - 1 : Math.min(+m[2], size - 1);
    }
    if (!(start >= 0) || start >= size || end < start) return "bad";
    return { start, end };
}

/** A file's problem in plain words (an open's grant, a serve that finds it gone): the code's meaning and the name. */
function fileProblem(err, file) {
    const name = path.basename(String(file || "")) || String(file || "the file");
    const code = err && err.code;
    if (code === "ENOENT" || code === "ENOTDIR") return `${name} is not there any more`;
    if (code === "EACCES" || code === "EPERM") return `Scumble may not read ${name} (no permission)`;
    if (code === "EISDIR") return `${name} is a folder, not a file`;
    if (code === "EBUSY") return `${name} is in use by another program`;
    return `could not read ${name}: ${(err && err.message) || err}`;
}

// a read stream's pieces: 1 MiB, against Node's 64 KiB default (fewer pieces through the scheme for a file of a GB)
const CHUNK = 1 << 20;

class GrantedFiles {
    /**
     * `types`: extension (".mp4") -> content type, else application/octet-stream. `words`: the answers' texts
     * ({ missing, gone }: no such token, the file went away after the grant).
     */
    constructor({ max = 8, types = {}, words = {} } = {}) {
        this.max = max;
        this.types = types;
        this.words = { missing: "no such file", gone: "the file is gone", ...words };
        this.grants = new Map();   // token -> absolute path, oldest first
    }

    /** A token for one file; the oldest grant goes when more than `max` are held. */
    grant(file) {
        const token = crypto.randomBytes(16).toString("hex");
        this.grants.set(token, path.resolve(String(file)));
        while (this.grants.size > this.max) this.grants.delete(this.grants.keys().next().value);
        return token;
    }

    /**
     * grant() after the file was opened for reading once (so a file gone, a folder or no permission is refused here,
     * in plain words, before the window asks): { token, size, name, path }. Throws an Error with the words and the
     * fs code (`code`).
     */
    async grantReadable(file) {
        const abs = path.resolve(String(file));
        let fh = null, st;
        try {
            fh = await fsp.open(abs, "r");
            st = await fh.stat();
        } catch (err) {
            throw Object.assign(new Error(fileProblem(err, abs)), { code: err && err.code });
        } finally {
            if (fh) await fh.close().catch(() => {});
        }
        if (!st.isFile()) throw Object.assign(new Error(fileProblem({ code: "EISDIR" }, abs)), { code: "EISDIR" });
        return { token: this.grant(abs), size: st.size, name: path.basename(abs), path: abs };
    }

    release(token) {
        return this.grants.delete(String(token || ""));
    }

    has(token) {
        return this.grants.has(String(token || ""));
    }

    /** The answer for scumble://app/<route>/<token>: GET or HEAD, with the Range header when one is sent. */
    async serve(token, { method = "GET", range = null } = {}) {
        const file = this.grants.get(String(token || ""));
        if (!file) return new Response(this.words.missing, { status: 404 });
        if (method !== "GET" && method !== "HEAD") return new Response("method not allowed", { status: 405 });
        let st;
        try { st = await fsp.stat(file); } catch (err) { return new Response(`${this.words.gone}: ${fileProblem(err, file)}`, { status: 404 }); }
        if (!st.isFile()) return new Response("not a file", { status: 404 });
        const size = st.size;
        const type = this.types[path.extname(file).toLowerCase()] || "application/octet-stream";
        const base = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-store" };
        const r = size > 0 ? parseRange(range, size) : null;
        if (r === "bad") return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
        const start = r ? r.start : 0;
        const end = r ? r.end : size - 1;
        const headers = { ...base, "content-length": String(Math.max(0, end - start + 1)) };
        if (r) headers["content-range"] = `bytes ${start}-${end}/${size}`;
        const status = r ? 206 : 200;
        if (method === "HEAD" || size === 0) return new Response(null, { status, headers });
        // opened here, so a file that went away after the stat answers 404 in words instead of a stream error
        let fh;
        try { fh = await fsp.open(file, "r"); } catch (err) { return new Response(`${this.words.gone}: ${fileProblem(err, file)}`, { status: 404 }); }
        const body = Readable.toWeb(fh.createReadStream({ start, end, highWaterMark: CHUNK, autoClose: true }));
        return new Response(body, { status, headers });
    }
}

module.exports = { GrantedFiles, parseRange, fileProblem };
