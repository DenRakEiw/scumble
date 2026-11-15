"use strict";
// Video files for the frame picker (CLAUDE.md item 68): File › Open on a video sends the window no bytes (a clip can
// be gigabytes, and one IPC message of about 512 MiB ends the renderer). Main grants the one path the user just chose
// a random token instead, and serves it at scumble://app/video/<token> with HTTP ranges, so the window's <video> reads
// only what it plays or seeks to. Nothing else is reachable through the route: no path in the URL, only a token main
// made for a file the open dialog returned, dropped again when the window closes its picker (release) or when more
// than MAX are held.

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");

/** The file names the picker takes (the open dialog's filter, the window's drop and the commands' refusal). */
const VIDEO_EXT = /\.(mp4|m4v|webm|mov)$/i;
// .mov goes as video/mp4: QuickTime and MP4 are the same box format, and Chromium's player opens an H.264 .mov under
// that type; what it cannot decode (ProRes, often HEVC) fails in the window, which refuses it in plain words
const TYPES = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/mp4", ".webm": "video/webm" };
const MAX = 8;

const isVideoPath = (file) => VIDEO_EXT.test(String(file || ""));

/**
 * A Range header against a file of `size` bytes: { start, end } (end inclusive), null for none (the whole file), or
 * "bad" (unsatisfiable: 416). Only the one-range form `bytes=a-b`, `bytes=a-` and `bytes=-n`, which is what Chromium's
 * player sends; a multi-range answer is never needed for a <video>, so it is served whole.
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

class VideoFiles {
    constructor({ max = MAX } = {}) {
        this.max = max;
        this.grants = new Map();   // token -> absolute path, oldest first
    }

    /** A token for one file (a path the open dialog returned); the oldest grant goes when more than `max` are held. */
    grant(file) {
        const token = crypto.randomBytes(16).toString("hex");
        this.grants.set(token, path.resolve(String(file)));
        while (this.grants.size > this.max) this.grants.delete(this.grants.keys().next().value);
        return token;
    }

    release(token) {
        return this.grants.delete(String(token || ""));
    }

    has(token) {
        return this.grants.has(String(token || ""));
    }

    /** The answer for scumble://app/video/<token>: GET or HEAD, with the Range header when the player sends one. */
    async serve(token, { method = "GET", range = null } = {}) {
        const file = this.grants.get(String(token || ""));
        if (!file) return new Response("no such video", { status: 404 });
        if (method !== "GET" && method !== "HEAD") return new Response("method not allowed", { status: 405 });
        let st;
        try { st = await fsp.stat(file); } catch (_) { return new Response("the video is gone", { status: 404 }); }
        if (!st.isFile()) return new Response("not a file", { status: 404 });
        const size = st.size;
        const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
        const base = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-store" };
        const r = size > 0 ? parseRange(range, size) : null;
        if (r === "bad") return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
        const start = r ? r.start : 0;
        const end = r ? r.end : size - 1;
        const headers = { ...base, "content-length": String(Math.max(0, end - start + 1)) };
        if (r) headers["content-range"] = `bytes ${start}-${end}/${size}`;
        const status = r ? 206 : 200;
        if (method === "HEAD" || size === 0) return new Response(null, { status, headers });
        const body = Readable.toWeb(fs.createReadStream(file, { start, end }));
        return new Response(body, { status, headers });
    }
}

module.exports = { VideoFiles, VIDEO_EXT, isVideoPath, parseRange };
