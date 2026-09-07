// The local file mirror: every file the editor uploads or views is kept under
// <userData>/files/<type>/<subfolder>/<filename>, mirroring ComfyUI's input / output
// folders. The document therefore lives on this machine; the server only holds copies,
// re-uploaded on demand before a run (ensureOnServer). Editing works without a server.
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { app } = require("electron");

const SAFE_NAME = /^[^\\/:*?"<>|\x00-\x1f]+$/;

function root() {
    return path.join(app.getPath("userData"), "files");
}

function mirrorPath(type, subfolder, filename) {
    if (!SAFE_NAME.test(filename) || filename === "." || filename === "..") throw new Error("bad file name: " + filename);
    const sub = String(subfolder || "").replace(/\\/g, "/").split("/").filter((s) => s && s !== "." && s !== "..");
    if (!["input", "output", "temp"].includes(type)) throw new Error("bad file type: " + type);
    return path.join(root(), type, ...sub, filename);
}

function mimeOf(name) {
    const ext = path.extname(name).toLowerCase();
    return { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
        ".tif": "image/tiff", ".tiff": "image/tiff", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2", ".cube": "text/plain" }[ext] || "application/octet-stream";
}

/** ComfyUI's collision rule: "name (1).png", "name (2).png", ... */
async function freeName(dir, filename) {
    const ext = path.extname(filename);
    const stem = filename.slice(0, filename.length - ext.length);
    let name = filename, n = 1;
    while (fs.existsSync(path.join(dir, name))) { name = `${stem} (${n})${ext}`; n++; }
    return name;
}

class FileMirror {
    constructor(comfy) {
        this.comfy = comfy;             // ComfyClient: fetch(), url, connected state
        this.known = new Map();         // server url -> Set of "type/subfolder/filename" known to exist there
    }

    key(type, subfolder, filename) {
        return `${type}/${subfolder || ""}/${filename}`;
    }

    knownSet() {
        const u = this.comfy.url || "";
        if (!this.known.has(u)) this.known.set(u, new Set());
        return this.known.get(u);
    }

    serverUp() {
        const s = this.comfy.status || {};
        return !!this.comfy.url && (s.state === "connected" || s.state === "missing-node");
    }

    /** POST /upload/image: store locally, forward to the server when connected. */
    async handleUpload(request) {
        let form;
        try { form = await request.formData(); } catch (err) { return Response.json({ error: "bad multipart: " + err.message }, { status: 400 }); }
        const file = form.get("image");
        if (!file || typeof file.arrayBuffer !== "function") return Response.json({ error: "no image field" }, { status: 400 });
        const type = String(form.get("type") || "input");
        const subfolder = String(form.get("subfolder") || "");
        const overwrite = String(form.get("overwrite") || "") === "true";
        let filename = path.basename(String(file.name || "image.png"));
        let target;
        try { target = mirrorPath(type, subfolder, filename); } catch (err) { return Response.json({ error: err.message }, { status: 400 }); }
        const dir = path.dirname(target);
        await fsp.mkdir(dir, { recursive: true });
        if (!overwrite) { filename = await freeName(dir, filename); target = path.join(dir, filename); }
        const buf = Buffer.from(await file.arrayBuffer());
        if (overwrite || !fs.existsSync(target)) await fsp.writeFile(target, buf);
        if (this.serverUp()) {
            try {
                await this.pushToServer(type, subfolder, filename, buf, file.type || mimeOf(filename));
            } catch (err) {
                console.warn("upload not forwarded:", filename, err.message);
            }
        }
        return Response.json({ name: filename, subfolder, type });
    }

    async pushToServer(type, subfolder, filename, buf, mime) {
        const fd = new FormData();
        fd.append("image", new Blob([buf], { type: mime || mimeOf(filename) }), filename);
        fd.append("subfolder", subfolder || "");
        fd.append("type", type);
        fd.append("overwrite", "true");
        const r = await this.comfy.fetch("/upload/image", { method: "POST", body: fd });
        if (r.status !== 200) throw new Error(`/upload/image answered ${r.status}`);
        const data = await r.json().catch(() => ({}));
        if (data.name && data.name !== filename) console.warn("server renamed", filename, "to", data.name);
        this.knownSet().add(this.key(type, subfolder, filename));
    }

    /** GET /view: the mirror first, else the server (and keep a copy, except temp files). */
    async handleView(search) {
        const q = new URLSearchParams(search);
        const filename = q.get("filename") || "";
        const subfolder = q.get("subfolder") || "";
        const type = q.get("type") || "input";
        let local;
        try { local = mirrorPath(type, subfolder, filename); } catch (err) { return new Response(err.message, { status: 400 }); }
        try {
            const data = await fsp.readFile(local);
            return new Response(data, { status: 200, headers: { "content-type": mimeOf(filename), "cache-control": "no-cache" } });
        } catch (_) { /* not mirrored yet */ }
        if (!this.serverUp()) return new Response("not in the local store and ComfyUI is not connected: " + filename, { status: 404 });
        const r = await this.comfy.fetch("/view?" + q.toString());
        if (r.status !== 200) return new Response(await r.text().catch(() => ""), { status: r.status });
        const buf = Buffer.from(await r.arrayBuffer());
        if (type !== "temp") {
            try { await fsp.mkdir(path.dirname(local), { recursive: true }); await fsp.writeFile(local, buf); } catch (err) { console.warn("mirror write failed", err.message); }
        }
        this.knownSet().add(this.key(type, subfolder, filename));
        return new Response(buf, { status: 200, headers: { "content-type": r.headers.get("content-type") || mimeOf(filename), "cache-control": "no-cache" } });
    }

    /**
     * Make sure the server has these files (refs: [{filename, subfolder, type}]). Files the
     * proxy already uploaded to or fetched from this server are skipped; the others are
     * checked with HEAD /view and uploaded from the mirror when missing.
     */
    async ensureOnServer(refs) {
        if (!this.serverUp()) throw new Error("ComfyUI is not connected");
        const known = this.knownSet();
        const report = { checked: 0, uploaded: [], missing: [] };
        for (const ref of refs || []) {
            if (!ref || !ref.filename) continue;
            const type = ref.type || "input", subfolder = ref.subfolder || "";
            const k = this.key(type, subfolder, ref.filename);
            if (known.has(k)) continue;
            report.checked++;
            const q = new URLSearchParams({ filename: ref.filename, subfolder, type });
            let onServer = false;
            try { const h = await this.comfy.fetch("/view?" + q.toString(), { method: "HEAD" }); onServer = h.status === 200; } catch (_) { onServer = false; }
            if (onServer) { known.add(k); continue; }
            let buf;
            try { buf = await fsp.readFile(mirrorPath(type, subfolder, ref.filename)); } catch (_) { report.missing.push(k); continue; }
            await this.pushToServer(type, subfolder, ref.filename, buf);
            report.uploaded.push(k);
        }
        return report;
    }

    /** Size and count of the mirror, for the settings UI later. */
    async stats() {
        let files = 0, bytes = 0;
        const walk = async (dir) => {
            let entries = [];
            try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
            for (const e of entries) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) await walk(p);
                else { files++; try { bytes += (await fsp.stat(p)).size; } catch (_) { /* ignore */ } }
            }
        };
        await walk(root());
        return { files, bytes, root: root() };
    }
}

module.exports = { FileMirror, mirrorPath };
