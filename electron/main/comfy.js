// ComfyUI client for the main process: HTTP proxy for the renderer (scumble://app/comfy/*),
// the websocket that carries execution events, and the connection probe.
//
// The renderer never talks to the server directly. Everything goes through this file so
// a remote box (RunPod, phase 2) only needs its URL and auth header set here once.
"use strict";

const crypto = require("node:crypto");
const WebSocket = require("ws");

const HOP_HEADERS = new Set(["host", "origin", "referer", "connection", "content-length", "accept-encoding", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-dest"]);

class ComfyClient {
    constructor({ onEvent, onStatus } = {}) {
        this.url = "";
        this.headers = {};
        this.clientId = crypto.randomUUID();
        this.onEvent = onEvent || (() => {});
        this.onStatus = onStatus || (() => {});
        this.ws = null;
        this.wsWanted = false;
        this.retry = 0;
        this.status = { state: "disconnected", url: "", message: "not connected" };
    }

    setUrl(url) {
        const u = String(url || "").trim().replace(/\/+$/, "");
        if (u !== this.url) {
            this.url = u;
            this.disconnect();
        }
        return this.url;
    }

    setStatus(patch) {
        this.status = { ...this.status, url: this.url, ...patch };
        this.onStatus(this.status);
    }

    // ---- HTTP -------------------------------------------------------------------

    target(pathWithQuery) {
        if (!this.url) throw new Error("ComfyUI URL is not set");
        return this.url + (pathWithQuery.startsWith("/") ? "" : "/") + pathWithQuery;
    }

    /** fetch against the server with the auth headers; init as for global fetch. */
    async fetch(pathWithQuery, init = {}) {
        const headers = { ...this.headers, ...(init.headers || {}) };
        return fetch(this.target(pathWithQuery), { ...init, headers });
    }

    async json(pathWithQuery, init) {
        const r = await this.fetch(pathWithQuery, init);
        if (!r.ok) throw new Error(`${pathWithQuery} answered ${r.status}`);
        return r.json();
    }

    /**
     * Proxy a renderer request (a Fetch API Request from protocol.handle) to the server.
     * The body is buffered: uploads are a few tens of MB at most and a buffered body
     * keeps the multipart boundary intact whatever undici does with streams.
     */
    async proxy(request, pathWithQuery) {
        if (!this.url) return new Response("ComfyUI is not connected", { status: 503 });
        const headers = { ...this.headers };
        for (const [k, v] of request.headers) {
            if (!HOP_HEADERS.has(k.toLowerCase())) headers[k] = v;
        }
        const method = request.method || "GET";
        const init = { method, headers, redirect: "follow" };
        if (method !== "GET" && method !== "HEAD") init.body = Buffer.from(await request.arrayBuffer());
        let upstream;
        try {
            upstream = await fetch(this.target(pathWithQuery), init);
        } catch (err) {
            return new Response("ComfyUI unreachable: " + (err.message || err), { status: 502 });
        }
        const out = new Headers();
        for (const name of ["content-type", "content-length", "content-disposition", "cache-control", "last-modified", "etag"]) {
            const v = upstream.headers.get(name);
            if (v) out.set(name, v);
        }
        return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
    }

    // ---- connection ---------------------------------------------------------------

    /** Probe the server: version, node pack presence, queue. Starts the websocket on success. */
    async connect(url) {
        if (url) this.setUrl(url);
        if (!this.url) { this.setStatus({ state: "disconnected", message: "no URL" }); return this.status; }
        this.setStatus({ state: "connecting", message: "connecting ..." });
        try {
            const stats = await this.json("/system_stats");
            let node = false;
            try { const r = await this.fetch("/object_info/InpaintCanvas"); node = r.status === 200 && Object.keys(await r.json()).length > 0; } catch (_) { node = false; }
            const version = stats && stats.system ? stats.system.comfyui_version : "?";
            const devices = ((stats && stats.devices) || []).map((d) => d.name).join(", ");
            this.wsWanted = true;
            this.retry = 0;
            this.openSocket();
            this.setStatus({ state: node ? "connected" : "missing-node", version, devices, node, message: node ? `ComfyUI ${version}` : `ComfyUI ${version}, Inpaint Canvas node pack not installed` });
        } catch (err) {
            this.setStatus({ state: "error", message: "cannot reach " + this.url + ": " + (err.message || err) });
        }
        return this.status;
    }

    disconnect() {
        this.wsWanted = false;
        if (this.ws) { try { this.ws.close(); } catch (_) { /* ignore */ } this.ws = null; }
        this.setStatus({ state: "disconnected", message: "not connected" });
    }

    openSocket() {
        if (this.ws || !this.wsWanted) return;
        const wsUrl = this.url.replace(/^http/, "ws") + "/ws?clientId=" + encodeURIComponent(this.clientId);
        const ws = new WebSocket(wsUrl, { headers: this.headers });
        this.ws = ws;
        ws.on("open", () => { this.retry = 0; this.setStatus({ socket: true }); });
        ws.on("message", (data, isBinary) => {
            if (isBinary) return;   // preview frames (binary) are not needed
            let msg;
            try { msg = JSON.parse(data.toString()); } catch (_) { return; }
            if (msg && msg.type) this.onEvent({ type: msg.type, data: msg.data });
        });
        const gone = () => {
            if (this.ws === ws) this.ws = null;
            this.setStatus({ socket: false });
            if (this.wsWanted) {
                const delay = Math.min(15000, 500 * 2 ** Math.min(this.retry++, 5));
                setTimeout(() => this.openSocket(), delay);
            }
        };
        ws.on("close", gone);
        ws.on("error", () => { try { ws.close(); } catch (_) { /* ignore */ } });
    }
}

module.exports = { ComfyClient };
