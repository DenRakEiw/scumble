// ComfyUI client for the main process: HTTP proxy for the renderer (scumble://app/comfy/*),
// the websocket that carries execution events, the connection probe and the auth
// headers of a remote box.
//
// The renderer never talks to the server directly. Everything goes through this file so
// a remote server (RunPod behind its HTTPS proxy, a box behind nginx with basic auth,
// a token-checking reverse proxy) only needs its URL and auth set here once; every
// request and the websocket handshake carry the same headers.
"use strict";

const crypto = require("node:crypto");
const WebSocket = require("ws");

const HOP_HEADERS = new Set(["host", "origin", "referer", "connection", "content-length", "accept-encoding", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-dest"]);

/**
 * Headers for an auth description: { type: "none" | "basic" | "bearer" | "header",
 * user, header } plus the secret (password, token or header value) from the key store.
 */
function authHeaders(auth, secret) {
    const a = auth || {};
    const s = String(secret || "");
    switch (a.type) {
        case "basic": return s || a.user ? { Authorization: "Basic " + Buffer.from(`${a.user || ""}:${s}`, "utf8").toString("base64") } : {};
        case "bearer": return s ? { Authorization: "Bearer " + s } : {};
        case "header": return s && a.header ? { [String(a.header)]: s } : {};
        default: return {};
    }
}

// Loader inputs whose combo values tell which model files a server has (for the recipe check).
const MODEL_COMBOS = {
    UNETLoader: ["unet_name"], CheckpointLoaderSimple: ["ckpt_name"], CLIPLoader: ["clip_name"], DualCLIPLoader: ["clip_name1", "clip_name2"],
    VAELoader: ["vae_name"], LoraLoader: ["lora_name"], LoraLoaderModelOnly: ["lora_name"], ControlNetLoader: ["control_net_name"], UpscaleModelLoader: ["model_name"],
};

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

    setHeaders(headers) {
        const h = headers || {};
        if (JSON.stringify(h) !== JSON.stringify(this.headers)) {
            this.headers = { ...h };
            if (this.ws) { try { this.ws.close(); } catch (_) { /* ignore */ } this.ws = null; }
        }
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
            if (!HOP_HEADERS.has(k.toLowerCase()) && !(k.toLowerCase() === "authorization" && this.headers.Authorization)) headers[k] = v;
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

    /**
     * Look at a server without connecting to it: version, devices, node pack (and its
     * version), queue, and the model files its loaders list. Used by the connection
     * dialog's Test button; `url` / `headers` default to the current ones.
     */
    static async probe(url, headers = {}, { timeoutMs = 15000 } = {}) {
        const base = String(url || "").trim().replace(/\/+$/, "");
        if (!base) throw new Error("no URL");
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        const get = async (p) => {
            const r = await fetch(base + p, { headers, signal: ac.signal, redirect: "follow" });
            return r;
        };
        try {
            const t0 = Date.now();
            let r = await get("/system_stats");
            if (r.status === 401 || r.status === 403) throw new Error(`the server refuses the request (${r.status}): check the auth settings`);
            if (!r.ok) throw new Error(`/system_stats answered ${r.status}`);
            const ct = r.headers.get("content-type") || "";
            if (!/json/.test(ct)) throw new Error("this URL answers with " + (ct.split(";")[0] || "no content type") + ", not with ComfyUI's API (a login page? the wrong port?)");
            const stats = await r.json();
            const latency = Date.now() - t0;
            const out = {
                ok: true, url: base, latency,
                version: stats && stats.system ? stats.system.comfyui_version : "?",
                python: stats && stats.system ? stats.system.python_version : "",
                os: stats && stats.system ? stats.system.os : "",
                devices: ((stats && stats.devices) || []).map((d) => ({ name: d.name, vramTotal: d.vram_total, vramFree: d.vram_free })),
                node: false, nodeVersion: "", queue: null, models: {},
            };
            try { const q = await get("/queue"); if (q.ok) { const j = await q.json(); out.queue = { running: (j.queue_running || []).length, pending: (j.queue_pending || []).length }; } } catch (_) { /* ignore */ }
            try { const n = await get("/object_info/InpaintCanvas"); out.node = n.status === 200 && Object.keys(await n.json()).length > 0; } catch (_) { out.node = false; }
            if (out.node) { try { const i = await get("/inpaint_canvas/info"); if (i.ok) out.nodeVersion = (await i.json()).version || ""; } catch (_) { /* older node */ } }
            for (const [cls, inputs] of Object.entries(MODEL_COMBOS)) {
                try {
                    const r2 = await get("/object_info/" + cls);
                    if (!r2.ok) continue;
                    const info = (await r2.json())[cls];
                    const req = (info && info.input && info.input.required) || {};
                    for (const inp of inputs) {
                        const spec = req[inp];
                        const opts = Array.isArray(spec) && Array.isArray(spec[0]) ? spec[0] : (spec && spec[1] && Array.isArray(spec[1].options) ? spec[1].options : null);
                        if (opts) out.models[`${cls}.${inp}`] = opts;
                    }
                } catch (_) { /* ignore */ }
            }
            return out;
        } catch (err) {
            if (err.name === "AbortError") throw new Error("no answer within " + Math.round(timeoutMs / 1000) + " s");
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    /** Probe the server: version, node pack presence, queue. Starts the websocket on success. */
    async connect(url, headers) {
        if (url) this.setUrl(url);
        if (headers) this.setHeaders(headers);
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
            const remote = !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(this.url);
            this.setStatus({ state: node ? "connected" : "missing-node", version, devices, node, remote, auth: !!Object.keys(this.headers).length,
                message: node ? `ComfyUI ${version}` : `ComfyUI ${version}, Inpaint Canvas node pack not installed` });
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

module.exports = { ComfyClient, authHeaders, MODEL_COMBOS };
