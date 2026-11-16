// The assistant's chats on disk (docs/PLAN_ASSISTANT.md §4 A6).
//
//     <userData>/assistant/chats/<chat id>.json      the chat without its pictures
//     <userData>/assistant/chats/<chat id>/<n>.jpg   every picture of it, one file each
//
// A chat is saved at the end of every turn, so a crash costs at most the turn that was
// running. The pictures are taken out of the JSON because a screenshot is 100 to 200 kB of
// base64 and a chat of twenty turns would be a file nobody can read or copy; what stays is a
// marker string that says which file, and which prefix the family's own shape had, so the
// history goes back **byte for byte** - a replayed history the provider does not accept is
// worse than no history at all.
//
// Nothing here knows any family: it walks the JSON and replaces what looks like image bytes.
// No key can be in a file - every error text was scrubbed before it became an event (§3).
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const MARK = "$image:";
const MIN_BYTES = 256;          // shorter strings are not pictures; a mask or an id may look alike
const DATA_URL = /^data:(image\/[a-zA-Z0-9.+-]+);base64,/;
const BASE64 = /^[A-Za-z0-9+/\r\n]+={0,2}$/;
const CANONICAL = /^[A-Za-z0-9+/]*={0,2}$/;    // no line breaks: the only form that comes back from a file unchanged

class Store {
    /** @param dir the app's userData folder */
    constructor(dir) {
        this.root = path.join(String(dir || ""), "assistant");
        this.chats = path.join(this.root, "chats");
    }

    file(id) { return path.join(this.chats, `${safe(id)}.json`); }
    folder(id) { return path.join(this.chats, safe(id)); }

    /**
     * Write one chat. The pictures go beside it; the JSON goes to a temporary file and is
     * renamed, so a half-written file never replaces a whole one.
     */
    async save(chat, extra = {}) {
        if (!chat || !chat.id) return null;
        const images = [];
        const record = {
            id: chat.id,
            provider: chat.provider,
            model: chat.model,
            label: chat.label || chat.model,
            family: chat.family,
            created: chat.created || Date.now(),
            updated: Date.now(),
            title: title(extra.events || []),
            usage: { ...(chat.usage || {}) },
            vision: chat.vision !== false,
            events: strip(extra.events || [], images),
            history: strip(chat.history || [], images),
        };
        await fsp.mkdir(this.chats, { recursive: true });
        if (images.length) {
            await fsp.mkdir(this.folder(chat.id), { recursive: true });
            for (const img of images) await fsp.writeFile(path.join(this.folder(chat.id), img.name), img.buffer);
        }
        const tmp = this.file(chat.id) + ".tmp";
        await fsp.writeFile(tmp, JSON.stringify(record, null, 1), "utf8");
        await fsp.rename(tmp, this.file(chat.id));
        // the pictures an earlier save wrote and this one no longer holds (the history keeps the last few) go
        const keep = new Set(images.map((img) => img.name));
        let names = [];
        try { names = await fsp.readdir(this.folder(chat.id)); } catch (_) { /* no folder: no picture yet */ }
        for (const name of names) if (!keep.has(name)) await fsp.rm(path.join(this.folder(chat.id), name), { force: true }).catch(() => {});
        return record;
    }

    /** The saved chats, newest first, without their history: what the panel's list shows. */
    async list() {
        let names = [];
        try { names = await fsp.readdir(this.chats); } catch (_) { return []; }
        const out = [];
        for (const name of names) {
            if (!name.endsWith(".json")) continue;
            const id = name.slice(0, -5);
            try {
                const j = JSON.parse(await fsp.readFile(path.join(this.chats, name), "utf8"));
                out.push({
                    id: j.id || id,
                    provider: j.provider || "",
                    model: j.model || "",
                    label: j.label || j.model || "",
                    title: j.title || "",
                    created: j.created || 0,
                    updated: j.updated || 0,
                    turns: (j.events || []).filter((e) => e && e.type === "user").length,
                    usage: j.usage || null,
                });
            } catch (_) {
                // a file that does not parse is a row with a delete button, never a throw (§4 A6)
                out.push({ id, broken: true, title: "could not be read", updated: 0 });
            }
        }
        out.sort((a, b) => (b.updated || 0) - (a.updated || 0));
        return out;
    }

    /** One chat with its pictures put back where they were. */
    async load(id) {
        const j = JSON.parse(await fsp.readFile(this.file(id), "utf8"));
        const folder = this.folder(j.id || id);
        j.events = await put(j.events || [], folder);
        j.history = await put(j.history || [], folder);
        return j;
    }

    async remove(id) {
        await fsp.rm(this.file(id), { force: true });
        await fsp.rm(this.folder(id), { recursive: true, force: true });
    }

    /** Keep the newest `keep` chats; the rest go with their pictures. */
    async prune(keep) {
        const n = Number(keep);
        if (!Number.isFinite(n) || n <= 0) return [];
        const rows = await this.list();
        const drop = rows.slice(n);
        for (const row of drop) await this.remove(row.id);
        return drop.map((r) => r.id);
    }

    /** Everything the assistant ever wrote, gone (§8.5). Keys live elsewhere and are untouched. */
    async removeAll() {
        await fsp.rm(this.root, { recursive: true, force: true });
    }

    existsSync(id) { return fs.existsSync(this.file(id)); }
}

/** A chat id is ours (`c<base36>`), but a file name is a file name. */
function safe(id) {
    return String(id).replace(/[^A-Za-z0-9_-]/g, "_");
}

/** The first thing the user said, cut to 60 characters. */
function title(events) {
    const first = (events || []).find((e) => e && e.type === "user" && e.text);
    const text = String((first && first.text) || "").replace(/\s+/g, " ").trim();
    return text.length > 60 ? text.slice(0, 60) + "…" : text;
}

/**
 * Is this string the bytes of a picture, in whatever shape its family uses? A `data:image/...;base64,` URL anywhere;
 * bare base64 only where a family carries a picture's bytes (`raw`: an image part's `data`, Anthropic's base64
 * `source.data`, Gemini's `inlineData.data`), so a signature, an `encrypted_content` or a long line of text is never
 * taken for one. Only canonical base64 (what `toString("base64")` gives back byte for byte): anything else would come
 * back changed from the file.
 */
function imageString(value, raw = false) {
    if (typeof value !== "string" || value.length < MIN_BYTES) return null;
    const m = DATA_URL.exec(value);
    const img = m ? { prefix: m[0], body: value.slice(m[0].length), mime: m[1] }
        : (raw && BASE64.test(value) ? { prefix: "", body: value, mime: "image/jpeg" } : null);
    if (!img || !CANONICAL.test(img.body) || img.body.length % 4 !== 0) return null;
    return Buffer.from(img.body, "base64").toString("base64") === img.body ? img : null;
}

const extOf = (mime) => (/png/.test(mime) ? "png" : (/webp/.test(mime) ? "webp" : "jpg"));

/** A copy of `node` with every picture written into `images` and replaced by its marker. */
function strip(node, images, raw = false, key = "") {
    if (typeof node === "string") {
        const img = imageString(node, raw);
        if (!img) return node;
        const name = `${images.length + 1}.${extOf(img.mime)}`;
        images.push({ name, buffer: Buffer.from(img.body, "base64") });
        return `${MARK}${name}|${img.prefix}`;
    }
    if (Array.isArray(node)) return node.map((x) => strip(x, images));
    if (node && typeof node === "object") {
        const out = {};
        // the places a family puts a picture's bare base64
        const carrier = node.type === "image" || node.type === "base64" || key === "inlineData";
        for (const [k, v] of Object.entries(node)) out[k] = strip(v, images, carrier && k === "data", k);
        return out;
    }
    return node;
}

const STUB = "[screenshot no longer attached; call screenshot again]";
const MISSING = Symbol("missing picture");
const GEMINI_LOST = new WeakSet();      // the text parts put in place of Gemini pictures whose files are gone

/**
 * The other way: every marker back to the bytes of its file, in the shape it had. A picture whose file is gone
 * becomes its family's text part (an image field that holds words is refused by every API), the panel's `image`
 * nothing, and a marker anywhere else the line that says so.
 */
async function put(node, folder) {
    const v = await putIn(node, folder);
    return v === MISSING ? STUB : v;
}

async function putIn(node, folder) {
    if (typeof node === "string") {
        if (!node.startsWith(MARK)) return node;
        const rest = node.slice(MARK.length);
        const at = rest.indexOf("|");
        const name = at < 0 ? rest : rest.slice(0, at);
        const prefix = at < 0 ? "" : rest.slice(at + 1);
        try {
            const buffer = await fsp.readFile(path.join(folder, path.basename(name)));
            return prefix + buffer.toString("base64");
        } catch (_) {
            return MISSING;
        }
    }
    if (Array.isArray(node)) {
        const out = [];
        for (const x of node) { const v = await putIn(x, folder); out.push(v === MISSING ? STUB : v); }
        return out;
    }
    if (node && typeof node === "object") {
        const out = {};
        let lost = null;
        for (const [k, v] of Object.entries(node)) {
            const got = await putIn(v, folder);
            if (got === MISSING) lost = lost || k;
            out[k] = got;
        }
        // Gemini's functionResponse takes only pictures in its parts: a lost one goes, and the answer says so (as prune)
        if (Array.isArray(out.parts) && out.response !== undefined && out.parts.some((x) => GEMINI_LOST.has(x))) {
            out.parts = out.parts.filter((x) => !GEMINI_LOST.has(x));
            if (!out.parts.length) delete out.parts;
            if (out.response && typeof out.response === "object") {
                out.response = { ...out.response };
                delete out.response.screenshot;
                out.response.screenshot_removed = STUB;
            }
        }
        if (!lost) return out;
        if (node.type === "image" || node.type === "image_url") return { type: "text", text: STUB };   // Anthropic, MCP, Chat Completions
        if (node.type === "input_image") return { type: "input_text", text: STUB };                    // Responses
        if (lost === "inlineData") { const t = { text: STUB }; GEMINI_LOST.add(t); return t; }     // Gemini
        if (lost === "data" || lost === "url") return MISSING;     // the carrier inside a part: the part above replaces itself
        for (const [k, v] of Object.entries(out)) if (v === MISSING) out[k] = k === "image" ? null : STUB;
        return out;
    }
    return node;
}

module.exports = { Store, _strip: strip, _put: put, _title: title, _imageString: imageString, MARK };
