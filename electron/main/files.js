// The local file mirror: every file the editor uploads or views is kept under
// <userData>/files/<type>/<subfolder>/<filename>, mirroring ComfyUI's input / output
// folders. The document therefore lives on this machine; the server only holds copies,
// re-uploaded on demand before a run (ensureOnServer). Editing works without a server.
"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { app } = require("electron");

const SAFE_NAME = /^[^\\/:*?"<>|\x00-\x1f]+$/;
const HASH_NAME = /~([0-9a-f]{8,64})(?:\.[a-z0-9]+)?$/i;
const STEM_MAX = 200;

// Above this a file goes to the node's streaming upload route instead of ComfyUI's
// multipart one, which stops at --max-upload-size (100 MB by default). The editor uses
// the same threshold in uploadBlob.
const LARGE_UPLOAD = 64 * 1024 * 1024;

function root() {
    return path.join(app.getPath("userData"), "files");
}

function mirrorPath(type, subfolder, filename, base = root()) {
    if (!SAFE_NAME.test(filename) || filename === "." || filename === "..") throw new Error("bad file name: " + filename);
    const sub = String(subfolder || "").replace(/\\/g, "/").split("/").filter((s) => s && s !== "." && s !== "..");
    if (!["input", "output", "temp"].includes(type)) throw new Error("bad file type: " + type);
    return path.join(base, type, ...sub, filename);
}

function mimeOf(name) {
    const ext = path.extname(name).toLowerCase();
    return { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
        ".tif": "image/tiff", ".tiff": "image/tiff", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2", ".cube": "text/plain" }[ext] || "application/octet-stream";
}

function isHashName(filename) {
    return HASH_NAME.test(String(filename || ""));
}

function hasContentHash(filename, buf) {
    if (!Buffer.isBuffer(buf)) return false;
    const m = String(filename || "").match(HASH_NAME);
    if (!m) return false;
    const suffix = m[1].toLowerCase();
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    return sha256.startsWith(suffix);
}

/** Content-addressed name `stem~<hash>.ext` hashed from `buf` for `overwrite:false` uploads. */
function contentName(filename, buf, len = 8) {
    const raw = path.basename(String(filename || "image.png"));
    const extMatch = raw.match(/(\.[a-z0-9]+)$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : "";
    const base = (ext ? raw.slice(0, raw.length - ext.length) : raw).replace(/~[0-9a-f]{8,64}$/i, "");
    let stem = base.replace(/[^a-z0-9._-]/gi, "_").replace(/^[_.-]+|[_.-]+$/g, "");
    if (stem.length > STEM_MAX) stem = stem.slice(0, STEM_MAX).replace(/[_.-]+$/g, "");
    if (!stem) stem = "image";
    const hash = crypto.createHash("sha256").update(buf).digest("hex").slice(0, len);
    return `${stem}~${hash}${ext}`;
}

let tmpSeq = 0;

async function writeAtomic(dest, buf) {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}-${++tmpSeq}-${crypto.randomBytes(4).toString("hex")}`;
    try {
        await fsp.writeFile(tmp, buf);
        try {
            await fsp.rename(tmp, dest);
        } catch (err) {
            if (err && (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES")) {
                const st = await fsp.stat(dest).catch(() => null);
                if (st && st.isFile() && st.size === buf.length) return;
            }
            throw err;
        }
    } finally {
        await fsp.unlink(tmp).catch(() => {});
    }
}

async function storeMirrorFile(rawName, type, subfolder, buf, base, overwrite) {
    if (overwrite) {
        const target = mirrorPath(type, subfolder, rawName, base);
        await writeAtomic(target, buf);
        return { filename: rawName, target };
    }
    let filename = rawName, target = "";
    for (const len of [8, 16, 32, 64]) {
        filename = contentName(rawName, buf, len);
        target = mirrorPath(type, subfolder, filename, base);
        let existing = null;
        try { existing = await fsp.readFile(target); } catch (_) { existing = null; }
        if (!existing) {
            await writeAtomic(target, buf);
            return { filename, target };
        }
        if (existing.length === buf.length && existing.equals(buf)) {
            const now = new Date();
            await fsp.utimes(target, now, now).catch(() => {});
            return { filename, target };
        }
        if (existing.length === 0 || (existing.length < buf.length && buf.subarray(0, existing.length).equals(existing))) {
            await writeAtomic(target, buf);
            return { filename, target };
        }
    }
    await writeAtomic(target, buf);
    return { filename, target };
}

class FileMirror {
    constructor(comfy, { root: customRoot } = {}) {
        this.comfy = comfy;             // ComfyClient: fetch(), url, connected state
        this.known = new Map();         // server url -> Set of "type/subfolder/filename" known to exist there
        this._root = customRoot || null;
    }

    key(type, subfolder, filename) {
        return `${type}/${subfolder || ""}/${filename}`;
    }

    knownSet() {
        const u = this.comfy.url || "";
        if (!this.known.has(u)) this.known.set(u, new Set());
        return this.known.get(u);
    }

    /**
     * While the app saves to quit (electron/main/quit.js), uploads land in the mirror only: a close must not wait on a
     * slow or remote ComfyUI, and ensureOnServer uploads what a run needs anyway.
     */
    get localOnly() { return !!this._localOnly; }
    set localOnly(on) { this._localOnly = !!on; }

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
        const rawName = path.basename(String(file.name || "image.png"));
        if (rawName === "." || rawName === "..") return Response.json({ error: "bad file name: " + rawName }, { status: 400 });
        const buf = Buffer.from(await file.arrayBuffer());
        let filename;
        try { ({ filename } = await storeMirrorFile(rawName, type, subfolder, buf, this.root(), overwrite)); } catch (err) { return Response.json({ error: err.message }, { status: 400 }); }
        if (this.serverUp() && !this.localOnly) {
            try {
                await this.pushToServer(type, subfolder, filename, buf, file.type || mimeOf(filename), { overwrite: true });
            } catch (err) {
                console.warn("upload not forwarded:", filename, err.message);
            }
        }
        return Response.json({ name: filename, subfolder, type });
    }

    /**
     * POST /inpaint_canvas/upload?filename&subfolder&type&overwrite: the editor's route for
     * files above 64 MB (a 12k PNG is easily 150 MB, over ComfyUI's --max-upload-size). The
     * body is the raw file. The node serves this route on the server; in the app it has to
     * land in the mirror like every other upload, otherwise loading a large image would
     * need a reachable ComfyUI, and a proxied one answered 502.
     */
    async handleRawUpload(request, search) {
        const q = new URLSearchParams(search || "");
        const rawName = path.basename(String(q.get("filename") || ""));
        if (!rawName) return Response.json({ error: "filename missing" }, { status: 400 });
        if (rawName === "." || rawName === "..") return Response.json({ error: "bad file name: " + rawName }, { status: 400 });
        const type = String(q.get("type") || "input");
        const subfolder = String(q.get("subfolder") || "");
        const overwrite = String(q.get("overwrite") || "").toLowerCase() === "true";
        const buf = Buffer.from(await request.arrayBuffer());
        if (!buf.length) return Response.json({ error: "empty body" }, { status: 400 });
        let filename;
        try { ({ filename } = await storeMirrorFile(rawName, type, subfolder, buf, this.root(), overwrite)); } catch (err) { return Response.json({ error: err.message }, { status: 400 }); }
        if (this.serverUp() && !this.localOnly) {
            try {
                await this.pushToServer(type, subfolder, filename, buf, mimeOf(filename), { overwrite: true });
            } catch (err) {
                console.warn("upload not forwarded:", filename, err.message);
            }
        }
        return Response.json({ name: filename, subfolder, type, size: buf.length });
    }

    /**
     * Copy a mirrored file to the server. Multipart through ComfyUI's own route for normal
     * files, the node's streaming route above its --max-upload-size (100 MB by default;
     * the multipart body is a little larger than the file, so the switch sits below it).
     */
    async pushToServer(type, subfolder, filename, buf, mime, { overwrite = false } = {}) {
        const canOverwrite = !!(overwrite || hasContentHash(filename, buf));
        if (buf.length >= LARGE_UPLOAD) return this.pushLargeToServer(type, subfolder, filename, buf, { overwrite: canOverwrite });
        const fd = new FormData();
        fd.append("image", new Blob([buf], { type: mime || mimeOf(filename) }), filename);
        fd.append("subfolder", subfolder || "");
        fd.append("type", type);
        if (canOverwrite) fd.append("overwrite", "true");
        const r = await this.comfy.fetch("/upload/image", { method: "POST", body: fd });
        if (r.status === 413) return this.pushLargeToServer(type, subfolder, filename, buf, { overwrite: canOverwrite });
        if (r.status !== 200) throw new Error(`/upload/image answered ${r.status}`);
        const data = await r.json().catch(() => ({}));
        const serverName = (data && typeof data.name === "string" && data.name) ? data.name : filename;
        if (serverName !== filename) console.warn("server renamed", filename, "to", serverName);
        else this.knownSet().add(this.key(type, subfolder, filename));
        return serverName;
    }

    async pushLargeToServer(type, subfolder, filename, buf, { overwrite = false } = {}) {
        const canOverwrite = !!(overwrite || hasContentHash(filename, buf));
        const q = new URLSearchParams({ filename, subfolder: subfolder || "", type, overwrite: canOverwrite ? "true" : "false" });
        const r = await this.comfy.fetch("/inpaint_canvas/upload?" + q, {
            method: "POST",
            body: buf,
            headers: { "Content-Type": "application/octet-stream" },
        });
        if (r.status === 404) throw new Error(`${Math.round(buf.length / 1048576)} MB needs the node's upload route: update ComfyUI-InpaintCanvas on the server and restart ComfyUI`);
        if (r.status !== 200) throw new Error(`/inpaint_canvas/upload answered ${r.status}`);
        const data = await r.json().catch(() => ({}));
        const serverName = (data && typeof data.name === "string" && data.name) ? data.name : filename;
        if (serverName !== filename) console.warn("server renamed", filename, "to", serverName);
        else this.knownSet().add(this.key(type, subfolder, filename));
        return serverName;
    }

    /**
     * GET /view: the mirror first, else the server (and keep a copy, except temp files). `head` (a HEAD request: the
     * editor asks whether an undo's file is still there) answers a mirrored file from a stat, without reading it.
     */
    async handleView(search, { head = false } = {}) {
        const q = new URLSearchParams(search);
        const filename = q.get("filename") || "";
        const subfolder = q.get("subfolder") || "";
        const type = q.get("type") || "input";
        let local;
        try { local = mirrorPath(type, subfolder, filename, this.root()); } catch (err) { return new Response(err.message, { status: 400 }); }
        if (head) {
            try {
                const st = await fsp.stat(local);
                if (st.isFile()) return new Response(null, { status: 200, headers: { "content-type": mimeOf(filename), "content-length": String(st.size), "cache-control": "no-cache" } });
            } catch (_) { /* not mirrored: as a GET, from the server when it is connected */ }
        }
        try {
            const data = await fsp.readFile(local);
            return new Response(data, { status: 200, headers: { "content-type": mimeOf(filename), "cache-control": "no-cache" } });
        } catch (_) { /* not mirrored yet */ }
        if (!this.serverUp()) return new Response("not in the local store and ComfyUI is not connected: " + filename, { status: 404 });
        const r = await this.comfy.fetch("/view?" + q.toString());
        if (r.status !== 200) return new Response(await r.text().catch(() => ""), { status: r.status });
        const buf = Buffer.from(await r.arrayBuffer());
        if (type !== "temp") {
            try { await writeAtomic(local, buf); } catch (err) { console.warn("mirror write failed", err.message); }
        }
        this.knownSet().add(this.key(type, subfolder, filename));
        return new Response(buf, { status: 200, headers: { "content-type": r.headers.get("content-type") || mimeOf(filename), "cache-control": "no-cache" } });
    }

    /**
     * Make sure the server has these files (refs: [{filename, subfolder, type}]). Files the
     * proxy already uploaded to or fetched from this server are skipped; the others are
     * checked with HEAD /view (including Content-Length against the mirror file's size) and
     * uploaded from the mirror when missing or mismatched.
     */
    async ensureOnServer(refs) {
        if (!this.serverUp()) throw new Error("ComfyUI is not connected");
        const known = this.knownSet();
        const report = { checked: 0, uploaded: [], missing: [], renamed: {} };
        for (const ref of refs || []) {
            if (!ref || !ref.filename) continue;
            const type = ref.type || "input", subfolder = ref.subfolder || "";
            const k = this.key(type, subfolder, ref.filename);
            if (report.renamed[k]) { ref.filename = report.renamed[k]; continue; }
            if (known.has(k)) continue;
            report.checked++;
            let local, st = null;
            try {
                local = mirrorPath(type, subfolder, ref.filename, this.root());
                st = await fsp.stat(local);
                if (!st.isFile()) st = null;
            } catch (_) { st = null; }
            const q = new URLSearchParams({ filename: ref.filename, subfolder, type });
            let onServer = false;
            try {
                const h = await this.comfy.fetch("/view?" + q.toString(), { method: "HEAD" });
                if (h.status === 200) {
                    if (!st) {
                        onServer = true;
                    } else {
                        const len = h.headers && typeof h.headers.get === "function" ? h.headers.get("content-length") : null;
                        onServer = len !== null && len !== "" && Number(len) === st.size;
                    }
                }
            } catch (_) { onServer = false; }
            if (onServer) { known.add(k); continue; }
            let buf;
            try { buf = await fsp.readFile(local || mirrorPath(type, subfolder, ref.filename, this.root())); } catch (_) { report.missing.push(k); continue; }
            const proven = hasContentHash(ref.filename, buf);
            const serverName = await this.pushToServer(type, subfolder, ref.filename, buf, undefined, { overwrite: proven });
            if (serverName && serverName !== ref.filename) {
                report.renamed[k] = serverName;
                ref.filename = serverName;
            } else {
                known.add(k);
            }
            report.uploaded.push(k);
        }
        return report;
    }

    root() {
        return this._root || root();
    }

    /**
     * Delete mirrored files that no open document references (keep: mirror keys
     * "type/subfolder/filename"). dryRun only counts. Fresh files (younger than an hour)
     * stay: a helper result may not be in any state yet.
     */
    async prune({ keep = [], dryRun = false } = {}) {
        const keepSet = new Set(keep);
        const report = { files: 0, bytes: 0, deleted: [] };
        const base = this.root();
        const now = Date.now();
        const walk = async (dir) => {
            let entries = [];
            try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
            for (const e of entries) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) { await walk(p); continue; }
                const rel = path.relative(base, p).split(path.sep);
                const type = rel.shift();
                const filename = rel.pop();
                const key = `${type}/${rel.join("/")}/${filename}`;
                if (keepSet.has(key)) continue;
                let st;
                try { st = await fsp.stat(p); } catch (_) { continue; }
                if (now - st.mtimeMs < 3600 * 1000) continue;
                report.files++; report.bytes += st.size;
                if (!dryRun) { try { await fsp.unlink(p); report.deleted.push(key); } catch (err) { console.warn("prune", key, err.message); } }
            }
        };
        await walk(base);
        if (!dryRun) this.known.clear();
        return report;
    }

    /** Size and count of the mirror, for the settings UI. */
    async stats() {
        let files = 0, bytes = 0;
        const base = this.root();
        const walk = async (dir) => {
            let entries = [];
            try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
            for (const e of entries) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) await walk(p);
                else { files++; try { bytes += (await fsp.stat(p)).size; } catch (_) { /* ignore */ } }
            }
        };
        await walk(base);
        return { files, bytes, root: base };
    }
}

module.exports = { FileMirror, mirrorPath, contentName, isHashName, hasContentHash };
