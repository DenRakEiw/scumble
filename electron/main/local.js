// The local command socket: the running Scumble instance listens on a named pipe (Windows)
// or a Unix socket (Linux, macOS), and a second `Scumble --mcp` or `Scumble --cmd` process
// talks to it instead of starting an app of its own (the single-instance lock would end it
// anyway). Local machine only, no authentication: the same trust as the DevTools port and
// the node's loopback command route.
//
// Wire format: one JSON object per line, both ways.
//   request   {id, cmd: "run", name, args} | {id, cmd: "describe"} | {id, cmd: "ping"}
//   response  {id, ok: true, result} | {id, ok: false, error}
//   event     {event: "commands"}   (the command table changed: plugins reloaded)
"use strict";

const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

/** The socket path for this user data folder (dev and packaged app share it when they share userData). */
function socketPath(userData) {
    const hash = crypto.createHash("sha1").update(String(userData).toLowerCase()).digest("hex").slice(0, 12);
    if (process.platform === "win32") return `\\\\.\\pipe\\scumble-${hash}`;
    return path.join(userData, "scumble.sock");
}

// The longest line either side takes, in UTF-16 code units: just under V8's longest string (2^29 - 24 on 64-bit), so
// every line that could be read before still is (a select_mask array or a base64 picture at 15k), and a line that
// never ends stops here instead of growing until the string throws on the main process (H1 S6).
const MAX_LINE = 500 * 1024 * 1024;
const sizeText = (n) => (n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * One JSON message per line from `socket` to `onLine`. The part of a line not ended yet is kept as its chunks and only
 * each new chunk is searched for the newline, so a long line costs its length once (the whole buffer copied and
 * searched again on every chunk was quadratic: seconds of the main process for a 100 MB line). A line longer than
 * `max` ends the reading: `onTooLong()` is called once and nothing more is read from the socket.
 */
function lines(socket, onLine, { max = MAX_LINE, onTooLong = null } = {}) {
    let parts = [], size = 0, dead = false;
    socket.setEncoding("utf8");
    const take = (line) => {
        line = line.trim();
        if (!line) return;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { return; }
        onLine(msg);
    };
    const tooLong = () => {
        dead = true;
        parts = []; size = 0;
        if (onTooLong) onTooLong(); else socket.destroy();
    };
    socket.on("data", (chunk) => {
        if (dead) return;
        let from = 0, i;
        while ((i = chunk.indexOf("\n", from)) >= 0) {
            if (size + (i - from) > max) { tooLong(); return; }
            const piece = chunk.slice(from, i);
            from = i + 1;
            let line = piece;
            if (parts.length) { parts.push(piece); line = parts.join(""); parts = []; size = 0; }
            take(line);
            if (dead) return;
        }
        if (from < chunk.length) {
            size += chunk.length - from;
            if (size > max) { tooLong(); return; }
            parts.push(from ? chunk.slice(from) : chunk);
        }
    });
}

function write(socket, obj) {
    if (socket.destroyed || !socket.writable) return false;
    socket.write(JSON.stringify(obj) + "\n");
    return true;
}

// ---- server (inside the running app) ----------------------------------------------------------

class LocalServer extends EventEmitter {
    /** @param bridge the command bridge (bridge.js); `maxLine` the longest request line taken (a test makes it small) */
    constructor(bridge, { maxLine = MAX_LINE } = {}) {
        super();
        this.bridge = bridge;
        this.maxLine = maxLine;
        this.server = null;
        this.clients = new Set();
        this.path = null;
        bridge.on("changed", () => this.broadcast({ event: "commands" }));
    }

    listen(userData) {
        this.path = socketPath(userData);
        if (process.platform !== "win32") { try { fs.unlinkSync(this.path); } catch (_) { /* none */ } }
        this.server = net.createServer((socket) => this._accept(socket));
        this.server.on("error", (err) => console.error("local command socket:", err.message));
        // a Unix socket is made with the process's umask: 077 for its bind, so only this user can connect (H1 S6). The
        // bind of a path is synchronous inside listen(), so the umask is back before any other file is made
        const umask = process.platform !== "win32" ? process.umask(0o077) : null;
        try { this.server.listen(this.path); } finally { if (umask !== null) process.umask(umask); }
        return this.path;
    }

    _accept(socket) {
        this.clients.add(socket);
        this.emit("clients", this.clients.size);
        socket.on("close", () => { this.clients.delete(socket); this.emit("clients", this.clients.size); });
        socket.on("error", () => { /* closed by the peer */ });
        const tooLong = () => {
            // the reason, then the connection ends (destroyed once the line is out, or after a second)
            const end = () => socket.destroy();
            const t = setTimeout(end, 1000);
            if (t.unref) t.unref();
            if (socket.destroyed || !socket.writable) { end(); return; }
            socket.end(JSON.stringify({ id: null, ok: false, error: `a request line longer than ${sizeText(this.maxLine)}: the connection is closed` }) + "\n", end);
        };
        lines(socket, async (msg) => {
            if (!msg || msg.id == null) return;
            let out;
            try {
                if (msg.cmd === "run") out = { id: msg.id, ok: true, result: await this.bridge.run(String(msg.name), msg.args || {}) };
                else if (msg.cmd === "describe") out = { id: msg.id, ok: true, result: await this.bridge.describe() };
                else if (msg.cmd === "ping") out = { id: msg.id, ok: true, result: { pid: process.pid, ready: this.bridge.ready } };
                else out = { id: msg.id, ok: false, error: "unknown request " + msg.cmd };
            } catch (err) {
                out = { id: msg.id, ok: false, error: String((err && err.message) || err) };
            }
            write(socket, out);
        }, { max: this.maxLine, onTooLong: tooLong });
    }

    broadcast(obj) {
        for (const s of this.clients) write(s, obj);
    }

    close() {
        for (const s of this.clients) s.destroy();
        this.clients.clear();
        if (this.server) { this.server.close(); this.server = null; }
        if (process.platform !== "win32" && this.path) { try { fs.unlinkSync(this.path); } catch (_) { /* none */ } }
    }
}

// ---- client (the --mcp / --cmd process) --------------------------------------------------------

class LocalClient extends EventEmitter {
    /** `maxLine` the longest answer line taken (a test makes it small). */
    constructor(socket, { maxLine = MAX_LINE } = {}) {
        super();
        this.socket = socket;
        this.pending = new Map();
        this.seq = 0;
        this.closed = false;
        const gone = (why = "Scumble closed the connection") => {
            if (this.closed) return;
            this.closed = true;
            for (const [id, p] of this.pending) { this.pending.delete(id); p.reject(new Error(why)); }
            this.emit("close");
        };
        lines(socket, (msg) => {
            if (msg.event) { this.emit(msg.event); return; }
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            if (msg.ok) p.resolve(msg.result === undefined ? null : msg.result);
            else p.reject(new Error(msg.error || "command failed"));
        }, { max: maxLine, onTooLong: () => { gone(`Scumble's answer was longer than ${sizeText(maxLine)}: the connection is closed`); socket.destroy(); } });
        socket.on("close", () => gone());
        socket.on("error", () => gone());
    }

    /** Connect to the running instance; resolves with a client or rejects when none listens. */
    static connect(userData, timeout = 2000, opts = {}) {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection(socketPath(userData));
            const t = setTimeout(() => { socket.destroy(); reject(new Error("no answer from the local socket")); }, timeout);
            socket.once("connect", () => { clearTimeout(t); resolve(new LocalClient(socket, opts)); });
            socket.once("error", (err) => { clearTimeout(t); reject(err); });
        });
    }

    _send(msg) {
        if (this.closed) return Promise.reject(new Error("Scumble is not connected"));
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            if (!write(this.socket, { id, ...msg })) { this.pending.delete(id); reject(new Error("Scumble is not connected")); }
        });
    }

    run(name, args) { return this._send({ cmd: "run", name, args: args || {} }); }
    describe() { return this._send({ cmd: "describe" }); }
    ping() { return this._send({ cmd: "ping" }); }
    close() { this.socket.destroy(); }
}

module.exports = { LocalServer, LocalClient, socketPath, MAX_LINE, _lines: lines };
