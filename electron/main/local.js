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

function lines(socket, onLine) {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch (_) { continue; }
            onLine(msg);
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
    /** @param bridge the command bridge (bridge.js) */
    constructor(bridge) {
        super();
        this.bridge = bridge;
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
        this.server.listen(this.path);
        return this.path;
    }

    _accept(socket) {
        this.clients.add(socket);
        this.emit("clients", this.clients.size);
        socket.on("close", () => { this.clients.delete(socket); this.emit("clients", this.clients.size); });
        socket.on("error", () => { /* closed by the peer */ });
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
        });
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
    constructor(socket) {
        super();
        this.socket = socket;
        this.pending = new Map();
        this.seq = 0;
        this.closed = false;
        lines(socket, (msg) => {
            if (msg.event) { this.emit(msg.event); return; }
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            if (msg.ok) p.resolve(msg.result === undefined ? null : msg.result);
            else p.reject(new Error(msg.error || "command failed"));
        });
        const gone = () => {
            if (this.closed) return;
            this.closed = true;
            for (const [id, p] of this.pending) { this.pending.delete(id); p.reject(new Error("Scumble closed the connection")); }
            this.emit("close");
        };
        socket.on("close", gone);
        socket.on("error", gone);
    }

    /** Connect to the running instance; resolves with a client or rejects when none listens. */
    static connect(userData, timeout = 2000) {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection(socketPath(userData));
            const t = setTimeout(() => { socket.destroy(); reject(new Error("no answer from the local socket")); }, timeout);
            socket.once("connect", () => { clearTimeout(t); resolve(new LocalClient(socket)); });
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

module.exports = { LocalServer, LocalClient, socketPath };
