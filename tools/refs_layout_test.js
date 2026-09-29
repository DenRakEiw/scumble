// Where each picture of a provider request goes (item 26, docs/PLAN_REFS.md 26a1 and C1-C3), in plain Node, no
// Electron and no key:
//   node tools/refs_layout_test.js            (REFS_VERBOSE=1 prints what every captured request carries)
// §1-2 the helpers of electron/main/providers/refs.js, against tools/refs_cases.json. §3-6 every adapter's `layout(req)`
// pinned against the request its real builder sends: each shipped provider recipe (the upscalers aside) x variant
// (ToAPIs x channel) x references {0, 1, 3} x Original {0, 1} runs the adapter's own `edit` with a fake fetch that
// answers the uploads and captures the request carrying the pictures, then throws. Every picture is a fixture known by
// its bytes, found in that request as a data URL, raw base64, an uploaded file's URL or the bytes themselves, so the
// test reads where each one really went and holds the layout's fields, numbers, `max` and `drops` to it. §7 is
// providers/index.js: markers resolved to the route's names, the refusals and the safety net, `layout(shape)`.
//
// A field is a path into the request the builder sends ("image_urls[0]", "contents[0].parts[2]",
// "input.messages[0].content[1]"); OpenAI's multipart form is read as an object whose "x[]" keys and repeated keys hold
// arrays ("image[][0]"); on Comfy Cloud the field is the exact input key of the graph's model node
// ("model.images.image_1"), followed through its links to LoadImage and the uploaded file, so only what reaches the
// model node counts (a picture uploaded and never wired is not sent to the model). Nothing here talks to a network.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const PROV = path.join(ROOT, "electron", "main", "providers");
const RECIPES = path.join(ROOT, "recipes");
const IDX = path.join(PROV, "index.js");
const INAPP = path.join(PROV, "inapp.js");
const refs = require(path.join(PROV, "refs.js"));
const CASES = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "refs_cases.json"), "utf8"));

const KEY = "test-refs-0123456789abcdef";   // a test key: the guarded adapters send it to the loopback host only
const LOOP = "http://127.0.0.1:5591";       // every adapter's allowed test host; nothing listens there
const VERBOSE = process.env.REFS_VERBOSE === "1";
const SENTINEL = "refs_layout_test: the request carrying the pictures was captured";
const KEY_ONLY = new Set(["anthropic", "deepseek", "moonshot", "zai", "compat"]);
const C1_TOKEN = String.raw`(?<![\w-])@[Ii][Mm][Gg](?:([1-9]\d{0,2})|\?(L[0-9a-z]+))(?![\w-])`;
const SETTINGS = { toapis: { base: LOOP }, openrouter: { base: LOOP }, ark: { base: LOOP }, oxen: { base: LOOP }, magnific: { base: LOOP }, comfyrouter: { base: LOOP } };

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 400 ? s.slice(0, 400) + " ..." : s; };
/** A section that throws is a failed check, not the end of the run: the sections after it still report. */
async function section(name, fn) {
    console.log(`\n--- ${name} ---`);
    try { await fn(); } catch (err) { check(`${name}: ran through`, false, String(err && err.stack || err).split(/\r?\n/).slice(0, 3).join(" ")); }
}
async function throws(fn) {
    try { await fn(); } catch (err) { return String(err && err.message || err); }
    return null;
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ---- pictures: tagged fake PNGs (openrouter_test.js) and the raw-PNG codec (magnific_test.js) ----------------------

function header(w, h, len, colour = 6) {
    const b = Buffer.alloc(len, 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    b[24] = 8;
    b[25] = colour;
    return b;
}
/** A PNG as far as an adapter looks: the signature, a real IHDR and a tag that makes its bytes its own. */
function pngOf(w, h, size = 64, tag = "") {
    const b = header(w, h, Math.max(size, 33 + tag.length));
    b.write(tag, 33, "latin1");
    return b;
}
const sizeOf = (b) => (b && b.length >= 24 && b[0] === 0x89 ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null);
function rawPng(w, h, rgba) {
    const b = header(w, h, 33 + w * h * 4);
    Buffer.from(rgba.buffer ? Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength) : rgba).copy(b, 33);
    return b;
}
/** Electron's nativeImage as far as Magnific and in-app LaMa use it: this codec's "PNG" is an IHDR and raw RGBA. */
const codec = {
    bitmap(png) {
        const b = Buffer.from(png), s = sizeOf(b);
        if (!s || b.length !== 33 + s[0] * s[1] * 4) return null;
        return { width: s[0], height: s[1], data: b.subarray(33) };
    },
    fromBitmap(bm) { return rawPng(bm.width, bm.height, bm.data); },
    cropPng(png, r) {
        const bm = codec.bitmap(png);
        if (!bm) return null;
        const out = Buffer.alloc(r.width * r.height * 4);
        for (let y = 0; y < r.height; y++) bm.data.copy(out, y * r.width * 4, ((r.y + y) * bm.width + r.x) * 4, ((r.y + y) * bm.width + r.x + r.width) * 4);
        return rawPng(r.width, r.height, out);
    },
};
function greyOf(w, h, fn) {
    const d = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = fn(x, y), j = (y * w + x) * 4; d[j] = v; d[j + 1] = v; d[j + 2] = v; d[j + 3] = 255; }
    return { width: w, height: h, data: d };
}
const maskPng = (w, h, fn) => codec.fromBitmap(greyOf(w, h, fn));
const imagePng = (w, h) => codec.fromBitmap(greyOf(w, h, (x, y) => (x * 7 + y * 13) & 255));
const RESULT = pngOf(1024, 768, 80, "RESULT");

// ---- the recipes as recipes.js serves them, the adapters, index.js -----------------------------------------------

let RECIPE_CACHE = null;
function loadRecipes() {
    if (RECIPE_CACHE) return RECIPE_CACHE;
    const orig = Module._load;
    Module._load = function (request, ...rest) {
        if (request === "electron") return { app: { getPath: () => ROOT } };
        return orig.call(this, request, ...rest);
    };
    let recipes;
    try { recipes = require(path.join(ROOT, "electron", "main", "recipes.js")); } finally { Module._load = orig; }
    RECIPE_CACHE = fs.readdirSync(RECIPES).filter((f) => f.endsWith(".json")).map((f) => {
        const r = JSON.parse(fs.readFileSync(path.join(RECIPES, f), "utf8"));
        r.id = r.id || f.replace(/\.json$/, "");
        r.kind = r.kind === "provider" ? "provider" : "comfy";
        return recipes._normalize(r);
    });
    return RECIPE_CACHE;
}
const variantOf = (recipe, provider) => { const r = loadRecipes().find((x) => x.id === recipe); return r && r.providers ? r.providers[provider] : null; };
/** The values the Settings panel starts with, plus the fixed ones (host.js providerParams). */
function defaults(rows, fixed) {
    const p = {};
    for (const s of rows || []) p[s.key] = s.spec[1] && s.spec[1].default !== undefined ? s.spec[1].default : (Array.isArray(s.spec[0]) ? s.spec[0][0] : undefined);
    return { ...p, ...(fixed || {}) };
}
const adapter = (id) => require(path.join(PROV, id + ".js"));

const LOGS = [];
let INDEX = null;
/** providers/index.js with electron, the log, the keys (a test key for every provider) and the settings stubbed. */
function loadIndex() {
    if (INDEX) return INDEX;
    const fakeImage = { isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toBitmap: () => Buffer.alloc(0), toPNG: () => Buffer.alloc(0), toJPEG: () => Buffer.alloc(0), crop: () => fakeImage };
    const orig = Module._load;
    Module._load = function (request, parent, ...rest) {
        if (request === "electron") return { nativeImage: { createFromBuffer: () => fakeImage, createFromBitmap: () => fakeImage } };
        if (parent && parent.filename === IDX) {
            if (request === "../log") return { record: (r) => LOGS.push(r) };
            if (request === "../keys") return { get: () => KEY, describe: (id) => ({ name: id, set: true }) };
            if (request === "../settings") return { get: () => SETTINGS };
        }
        return orig.call(this, request, parent, ...rest);
    };
    try { delete require.cache[IDX]; INDEX = require(IDX); } finally { Module._load = orig; }
    return INDEX;
}

// ---- the fixtures of one request ------------------------------------------------------------------------------

/**
 * The pictures of one request, each known by its bytes: `ids` maps base64 to "crop", "mask", "maskAlpha" or "ref<i>"
 * (references[i], the Original at 0 when `original`). A route that sends a picture it derives from one of them gets
 * that derivation, computed here from the fixture, as a second key of the same id: Magnific's Ideogram mask (inverted,
 * channel 0 at 128 and above black), Image Expand's kept part (the crop inside a 32 px frame), in-app LaMa's RGBA crop
 * and its hole. Those routes decode their pictures, so they get codec pictures at a smaller size.
 */
function fixturesFor(provider, model, nRefs, original) {
    const route = String(model || "").replace(/^\/+|\/+$/g, "").replace(/^v1\/ai\//, "");
    const magnific = provider === "magnific" && (route === "ideogram-image-edit" || route.startsWith("image-expand/"));
    const inapp = provider === "inapp";
    const [w, h] = inapp ? [512, 512] : magnific ? [512, 384] : [1024, 768];
    const F = 32;
    let image, mask;
    if (inapp) {
        image = imagePng(w, h);
        mask = maskPng(w, h, (x, y) => (x >= 128 && x < 384 && y >= 128 && y < 384 ? 255 : 0));
    } else if (magnific) {
        image = imagePng(w, h);
        mask = maskPng(w, h, (x, y) => (x < F || y < F || x >= w - F || y >= h - F ? 255 : 0));
    } else {
        image = pngOf(w, h, 96, "CROP");
        mask = pngOf(w, h, 96, "MASK");
    }
    const maskAlpha = pngOf(w, h, 96, "MASKA");
    const references = [];
    for (let i = 0; i < original + nRefs; i++) references.push(i < original ? pngOf(w, h, 96, "ORIG") : pngOf(640, 480, 80, `REF${i}`));
    const ids = new Map();
    const add = (id, b) => ids.set(Buffer.from(b).toString("base64"), id);
    add("crop", image); add("mask", mask); add("maskAlpha", maskAlpha);
    references.forEach((b, i) => add(`ref${i}`, b));
    if (magnific && route === "ideogram-image-edit") {
        const bm = codec.bitmap(mask), inv = Buffer.alloc(bm.data.length);
        for (let j = 0; j < inv.length; j += 4) { const v = bm.data[j] >= 128 ? 0 : 255; inv[j] = v; inv[j + 1] = v; inv[j + 2] = v; inv[j + 3] = 255; }
        add("mask", codec.fromBitmap({ width: bm.width, height: bm.height, data: inv }));
    }
    if (magnific && route.startsWith("image-expand/")) add("crop", codec.cropPng(image, { x: F, y: F, width: w - 2 * F, height: h - 2 * F }));
    if (inapp) {
        const img = codec.bitmap(image), soft = codec.bitmap(mask), n = w * h;
        const rgba = Buffer.alloc(n * 4), hole = Buffer.alloc(n);
        for (let i = 0, j = 0; i < n; i++, j += 4) { rgba[j] = img.data[j + 2]; rgba[j + 1] = img.data[j + 1]; rgba[j + 2] = img.data[j]; rgba[j + 3] = 255; if (soft.data[j + 1] > 127) hole[i] = 255; }
        add("crop", rgba); add("mask", hole);
    }
    return { image, mask, maskAlpha, references, width: w, height: h, ids };
}

// ---- the shapes: every shipped provider variant that edits ---------------------------------------------------

/** One request shape: a recipe variant (and ToAPIs channel) with n reference layers and the Original on or off. */
function shapesOf() {
    const out = [];
    for (const r of loadRecipes()) {
        if (r.kind !== "provider" || r.task === "upscale") continue;
        for (const [id, v] of Object.entries(r.providers)) {
            if (typeof adapter(id).edit !== "function" || v.edit === false) continue;
            const channels = id === "toapis" && v.options && v.options.channels ? Object.keys(v.options.channels) : [null];
            for (const channel of channels) {
                for (const n of [0, 1, 3]) for (const original of [0, 1]) out.push({ recipe: r.id, provider: id, variant: v, channel, refs: n, original });
            }
        }
    }
    return out;
}
const labelOf = (s) => `${s.recipe}/${s.provider}${s.channel ? ":" + s.channel : ""}`;
const tagOf = (s) => `${s.refs} ref${s.refs === 1 ? "" : "s"}${s.original ? " + Original" : ""}`;

/** The request providers/index.js hands the adapter (C3): Buffers, fields / options / params, original, refName. */
function requestFor(s, fx, extra = {}) {
    const v = s.variant;
    const params = defaults(v.settings, v.fixed);
    if (s.channel) params.channel = s.channel;
    return {
        provider: s.provider, model: v.model, kind: v.input === "edit" ? "edit" : "fill", fields: v.fields || null, options: v.options || null,
        prompt: "a red door", negative: "", seed: 7,
        image: fx.image, mask: fx.mask, maskAlpha: fx.maskAlpha, width: fx.width, height: fx.height, references: fx.references,
        params, original: s.original ? 1 : 0, refName: (v.refs && v.refs.name) || refs.REF_NAME_DEFAULT, ...extra,
    };
}

// ---- the capture harness --------------------------------------------------------------------------------------

async function bytesOf(v) {
    if (v == null) return null;
    if (typeof v === "string") return Buffer.from(v, "latin1");
    if (typeof Blob !== "undefined" && v instanceof Blob) return Buffer.from(await v.arrayBuffer());
    return Buffer.from(v.buffer ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v);
}
/** A multipart form as an object: a key ending in "[]" or appended twice holds an array, a file its bytes. */
async function formOf(fd) {
    const all = {};
    for (const [k, v] of fd.entries()) (all[k] = all[k] || []).push(typeof v === "string" ? v : await bytesOf(v));
    const out = {};
    for (const [k, vs] of Object.entries(all)) out[k] = k.endsWith("[]") || vs.length > 1 ? vs : vs[0];
    return out;
}
async function bodyOf(body) {
    if (typeof body === "string") { try { return JSON.parse(body); } catch (_) { return body; } }
    if (typeof FormData !== "undefined" && body instanceof FormData) return formOf(body);
    return bytesOf(body);
}

/**
 * Runs the adapter's real `edit` (or `generate`) against a fake fetch. The uploads are answered, each file's URL (or
 * Comfy Cloud name) mapped to its bytes; a GET that is no upload answers what the adapter asks first (OpenRouter's host
 * list); the first other POST is the request with the pictures: its body is kept and the call throws. In-app LaMa sends
 * nothing: its ONNX call is that request. Returns { calls, uploads, request, error }.
 */
async function capture(p, req, verb = "edit") {
    const shot = { calls: [], uploads: new Map(), pending: new Map(), request: null, error: null, result: null };
    let k = 0;
    const upload = (url, bytes) => { shot.uploads.set(url, bytes); return url; };
    async function fetch(url, init = {}) {
        const method = String(init.method || "GET").toUpperCase();
        const u = new URL(String(url));
        shot.calls.push(`${method} ${u.host}${u.pathname}`);
        if (method === "PUT" && shot.pending.has(String(url))) { upload(shot.pending.get(String(url)), await bytesOf(init.body)); return new Response(null, { status: 200 }); }
        if (method === "GET") return u.pathname === "/api/v1/providers" ? json(200, { data: [] }) : json(404, { error: { message: "no route " + u.pathname } });
        const at = u.pathname;
        if (/\/v1\/uploads\/images$/.test(at)) {                              // ToAPIs
            const url2 = upload(`${u.origin}/files/u${++k}.png`, (await formOf(init.body)).file);
            return json(200, { success: true, data: { id: "u" + k, url: url2, mime_type: "image/png" } });
        }
        if (u.host === "api.replicate.com" && at === "/v1/files") {          // Replicate's Files API (over 256 kB)
            return json(201, { urls: { get: upload(`https://api.replicate.com/v1/files/u${++k}`, (await formOf(init.body)).content) } });
        }
        if (/\/media\/uploads$/.test(at)) {                                   // WaveSpeed: a ticket, then the PUT
            const dl = `https://cdn.wavespeed.test/u${++k}.png`, put = `https://put.wavespeed.test/u${k}`;
            shot.pending.set(put, dl);
            return json(200, { data: { download_url: dl, upload: { url: put, method: "PUT" } } });
        }
        if (/\/media\/upload\/binary$/.test(at)) return json(200, { data: { download_url: upload(`https://cdn.wavespeed.test/u${++k}.png`, (await formOf(init.body)).file) } });
        if (at === "/api/upload/image") {                                     // Comfy Cloud: the name LoadImage reads
            const name = `u${++k}.png`;
            upload(name, (await formOf(init.body)).image);
            return json(200, { name, subfolder: "", type: "input" });
        }
        if (at === "/customers/storage") {                                    // the Comfy Partner API: a signed PUT
            const dl = `${u.origin}/dl/u${++k}.png`, put = `${u.origin}/put/u${k}`;
            shot.pending.set(put, dl);
            return json(200, { upload_url: put, download_url: dl });
        }
        if (!shot.request) shot.request = await bodyOf(init.body);   // a resend of it (Comfy Router) is not kept again
        throw new Error(SENTINEL);
    }
    const ctx = {
        key: KEY, base: LOOP, fetch, log: () => {}, sleep: async () => {}, random: () => 0, now: () => 0, uuid: () => "0b0e7a52-5c4f-4a8e-9d1b-3f6a2c7d8e90",
        toJpeg: () => null, opaque: () => true, bitmap: codec.bitmap, fromBitmap: codec.fromBitmap, cropPng: codec.cropPng,
    };
    const orig = Module._load;
    if (req.provider === "inapp") {
        Module._load = function (request, parent, ...rest) {
            if (request === "../onnx" && parent && parent.filename === INAPP) {
                return { inpaint: async (a) => { shot.request = { model: a.model, image: Buffer.from(a.image), mask: Buffer.from(a.mask) }; throw new Error(SENTINEL); } };
            }
            return orig.call(this, request, parent, ...rest);
        };
    }
    try { shot.result = await p[verb]({ ...req }, ctx); } catch (err) { shot.error = String(err && err.message || err); } finally { Module._load = orig; }
    if (shot.request && req.provider === "comfycloud" && shot.request.prompt) {
        // the field of a Comfy Cloud picture is an input key of the model node; its links lead to the uploads
        shot.graph = shot.request.prompt;
        const node = String((req.options && req.options.node) || "");
        const id = Object.keys(shot.graph).find((n) => shot.graph[n] && shot.graph[n].class_type === node);
        shot.node = id ? shot.graph[id].inputs : null;
    }
    return shot;
}

/** The fixture a value is (bytes, a data URL, raw base64, an uploaded file's URL or name), or null. */
function fixtureOf(v, fx, shot) {
    if (v == null) return null;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return fx.ids.get(Buffer.from(v).toString("base64")) || null;
    if (typeof v !== "string") return null;
    if (shot.uploads.has(v)) return fixtureOf(shot.uploads.get(v), fx, shot);
    const m = /^data:[^,]*;base64,(.*)$/s.exec(v);
    return fx.ids.get(m ? m[1] : v) || null;
}
const isLink = (v, graph) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number" && !!graph && Object.prototype.hasOwnProperty.call(graph, v[0]);

/** Every fixture under `v`, as { path, id }; a Comfy Cloud link is followed to its LoadImage and the upload behind it. */
function walk(v, where, fx, shot, out = [], seen = new Set()) {
    const id = fixtureOf(v, fx, shot);
    if (id) { out.push({ path: where, id }); return out; }
    if (v == null || typeof v !== "object" || Buffer.isBuffer(v) || v instanceof Uint8Array) return out;
    if (isLink(v, shot.graph)) {
        if (seen.has(v[0])) return out;
        seen.add(v[0]);
        const node = shot.graph[v[0]];
        if (node.class_type === "LoadImage") {
            const got = fixtureOf(shot.uploads.get(String(node.inputs && node.inputs.image)), fx, shot);
            if (got) out.push({ path: where, id: got });
            return out;
        }
        for (const x of Object.values(node.inputs || {})) walk(x, where, fx, shot, out, seen);
        return out;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${where}[${i}]`, fx, shot, out, seen)); return out; }
    for (const [k, x] of Object.entries(v)) walk(x, where ? `${where}.${k}` : k, fx, shot, out, seen);
    return out;
}

/** "contents[0].parts[2]" -> [["contents", [0]], ["parts", [2]]]; "image[][0]" -> [["image[]", [0]]]. */
function parseField(field) {
    return String(field).split(".").map((seg) => {
        const m = /^(.*?)((?:\[\d+\])*)$/.exec(seg);
        return [m[1], [...m[2].matchAll(/\[(\d+)\]/g)].map((x) => +x[1])];
    });
}
/** The fixtures at a layout field of the captured request, or null when the request has no such field. */
function picturesAt(shot, field, fx) {
    if (shot.graph) {
        if (!shot.node || !Object.prototype.hasOwnProperty.call(shot.node, field)) return null;
        return walk(shot.node[field], field, fx, shot);
    }
    let v = shot.request;
    for (const [key, idx] of parseField(field)) {
        if (v == null || typeof v !== "object" || Buffer.isBuffer(v) || !Object.prototype.hasOwnProperty.call(v, key)) return null;
        v = v[key];
        for (const i of idx) { if (!Array.isArray(v) || i >= v.length) return null; v = v[i]; }
    }
    return walk(v, field, fx, shot);
}
/** Every fixture the request carries (on Comfy Cloud: every one that reaches the model node). */
function picturesIn(shot, fx) {
    if (!shot.request) return [];
    if (shot.graph) return shot.node ? walk(shot.node, "", fx, shot) : [];
    return walk(shot.request, "", fx, shot);
}

/** Natural order of two fields: digit runs compared as numbers, "input_image" before "input_image_2". */
function naturalCmp(a, b) {
    const ta = String(a).match(/\d+|\D+/g) || [], tb = String(b).match(/\d+|\D+/g) || [];
    for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
        const x = ta[i], y = tb[i];
        if (x === y) continue;
        if (/^\d/.test(x) && /^\d/.test(y)) return +x - +y || x.length - y.length;
        return x < y ? -1 : 1;
    }
    return ta.length - tb.length;
}

const refId = (p) => `ref${p.ref}`;
const ROLE_OK = { crop: (id) => id === "crop", mask: (id) => id === "mask" || id === "maskAlpha" };

/**
 * Routes whose builder refuses a run its layout declares as dropping the references, kept as they are in 26a1 (the
 * builders are not changed there): step 26a2 strips the dropped references before the builder runs. docs/BUGS.md,
 * "flux1_fill on Comfy Router refuses any run with a visible reference".
 */
const KNOWN_REFUSALS = { "flux1_fill/comfyrouter": /takes at most 1 picture; this run has \d+/ };

/**
 * What is wrong between one layout and the request its builder sent (an empty list when they agree):
 * (e) the builder refuses before any request exactly when countOf(layout) > max; then for a request that went out,
 * (0) checkLayout takes the layout, (a) each field holds exactly its fixture, (b) the fixtures in the request are the
 * layout's, (c) the numbered pictures by n are their fields in natural order, (d) a reference is left out of the
 * layout exactly when the request lacks it, and then only with `drops` set. `drops` is the route's sentence (26a1's
 * contract change 3), so it may stand while this request loses nothing, as long as the route leaves references out at
 * some count: `wide` is the layout of the same request with 64 references (BFL keeps 7, Comfy Cloud's Qwen node 2).
 */
function pin(req, fx, lay, shot, wide, known = null) {
    const bad = [];
    const count = refs.countOf(lay);
    const over = lay.max != null && count > lay.max;
    if (!shot.request) {
        // `known`: the refusal a route gives today although its layout drops the references (KNOWN_REFUSALS)
        const expected = known && req.references.length > 0 && known.test(shot.error || "");
        if (shot.error && !shot.calls.length) { if (!over && !expected) bad.push(`(e) refused before any request with countOf ${count}, max ${lay.max}: ${shot.error}`); }
        else bad.push(`no request with the pictures after ${shot.calls.length} calls: ${shot.error}`);
        return bad;
    }
    if (over) bad.push(`(e) countOf ${count} > max ${lay.max}, yet the builder sent the request`);
    try { refs.checkLayout(lay, req); } catch (err) { bad.push(`(0) ${err.message}`); }
    if (shot.graph && !shot.node) { bad.push(`no ${req.options && req.options.node} node in the graph`); return bad; }
    const found = picturesIn(shot, fx);
    if (!found.some((x) => x.id === "crop")) bad.push(`(h) the crop is nowhere in the request (${short(Object.keys(shot.request))})`);
    const expected = [];
    for (const p of lay.pictures) {
        const at = picturesAt(shot, p.field, fx);
        const nominal = p.role === "crop" || p.role === "mask" ? p.role : refId(p);
        if (at === null) { bad.push(`(a) ${p.role} ${p.field}: no such field`); expected.push(nominal); continue; }
        if (at.length !== 1) { bad.push(`(a) ${p.role} ${p.field}: ${at.length} pictures (${at.map((x) => x.id).join(", ")})`); expected.push(nominal); continue; }
        const id = at[0].id;
        const ok = ROLE_OK[p.role] ? ROLE_OK[p.role](id) : id === refId(p);
        if (!ok) bad.push(`(a) ${p.role}${p.ref != null ? " " + p.ref : ""} ${p.field}: holds ${id}`);
        expected.push(ok ? id : nominal);
    }
    const got = found.map((x) => x.id).sort(), want = expected.sort();
    if (!eq(got, want)) bad.push(`(b) the request carries [${got.join(", ")}], the layout [${want.join(", ")}] (${found.map((x) => `${x.id}@${x.path}`).join(" ")})`);
    const numbered = lay.pictures.filter((p) => p.n != null).sort((a, b) => a.n - b.n).map((p) => p.field);
    for (let i = 1; i < numbered.length; i++) if (naturalCmp(numbered[i - 1], numbered[i]) >= 0) { bad.push(`(c) by n the fields are ${numbered.join(", ")}, not in the request's order`); break; }
    const given = req.references.length;
    let missing = 0;
    for (let i = 0; i < given; i++) {
        const inLay = lay.pictures.some((p) => p.ref === i && (p.role === "original" || p.role === "reference"));
        const inReq = found.some((x) => x.id === `ref${i}`);
        if (inLay !== inReq) bad.push(`(d) reference ${i} is ${inLay ? "in" : "not in"} the layout and ${inReq ? "in" : "not in"} the request`);
        if (!inLay) missing++;
    }
    if (missing && !lay.drops) bad.push(`(d) ${missing} reference${missing > 1 ? "s" : ""} left out without drops`);
    if (!missing && given && lay.drops) {
        const kept = wide && !wide.error ? new Set(wide.pictures.filter((p) => p.ref != null).map((p) => p.ref)) : null;
        if (!kept) bad.push(`(d) drops set ("${lay.drops}") with all ${given} references sent, and the layout at 64 references ${wide ? "threw: " + wide.error : "is missing"}`);
        else if (kept.size >= 64) bad.push(`(d) drops set ("${lay.drops}") but the route sends every reference, even 64`);
    }
    return bad;
}

/** The adapter's layout of the same request with 64 references (placeholders), or { error }. */
function wideLayout(p, req) {
    const references = Array.from({ length: 64 }, (_, i) => (i < req.original ? req.references[0] || Buffer.from([0]) : Buffer.from([i])));
    try { return p.layout({ ...req, references }); } catch (err) { return { error: String(err && err.message || err) }; }
}

/** One shape end to end: fixtures, request, the adapter's layout, the capture. */
async function runShape(s, nRefs = s.refs, original = s.original) {
    const fx = fixturesFor(s.provider, s.variant.model, nRefs, original);
    const req = requestFor(s, fx);
    const p = adapter(s.provider);
    let lay = null, layErr = null;
    if (typeof p.layout !== "function") layErr = "no layout export";
    else { try { lay = p.layout({ ...req }); } catch (err) { layErr = "layout threw: " + (err && err.message || err); } }
    const shot = await capture(p, req);
    return { fx, req, lay, layErr, shot, found: picturesIn(shot, fx), wide: lay ? wideLayout(p, req) : null };
}

async function main() {
    // ---- 1. the grammar ----
    await section("1. grammar", async () => {
        check("TOKEN is C1's grammar exactly, without a flag", refs.TOKEN.source === C1_TOKEN && refs.TOKEN.flags === "", `${refs.TOKEN.source} /${refs.TOKEN.flags}`);
        const tokenBad = [];
        for (const c of CASES.grammar) {
            const got = [...c.text.matchAll(new RegExp(refs.TOKEN.source, "g"))].map((m) => (m[1] ? { text: m[0], n: +m[1] } : { text: m[0], id: m[2] }));
            if (!eq(got, c.tokens)) tokenBad.push(`${JSON.stringify(c.text)} -> ${JSON.stringify(got)}, want ${JSON.stringify(c.tokens)}`);
        }
        check(`TOKEN finds exactly the tokens of all ${CASES.grammar.length} grammar cases (live @img1..@img999, parked @img?L.., nothing else)`, CASES.grammar.length >= 30 && !tokenBad.length, tokenBad.slice(0, 4).join(" | "));
        const markers = [..."a {@ref:0} b {@ref:12} {@ref:x} {@ref:} {@ref:3".matchAll(refs.MARKER)].map((m) => m[1]);
        check("MARKER is global and takes {@ref:<digits>} only", refs.MARKER.flags === "g" && eq(markers, ["0", "12"]), short(markers));
        check("MARKER_ANY sees any {@ref: left over, a malformed one too", refs.MARKER_ANY.test("x {@ref:x}") && refs.MARKER_ANY.test("{@ref:") && !refs.MARKER_ANY.test("{@re f:1}") && !refs.MARKER_ANY.test("@img1"));
        check("the grammar cases treat a marker as no token", CASES.grammar.some((c) => c.text === "{@ref:1}" && !c.tokens.length));
        for (const c of CASES.markers) {
            const r = refs.resolveMarkers(c.text, c.pictures, c.pattern);
            check(`resolveMarkers: ${c._comment}`, r.text === c.out && eq(r.left, c.left) && eq(r.refs, c.refs), short(r));
        }
        const v = CASES.markers[0];
        const twice = [refs.resolveMarkers(v.text, v.pictures, v.pattern), refs.resolveMarkers(v.text, v.pictures, v.pattern)];
        check("resolveMarkers answers the same twice (the global MARKER keeps no state)", eq(twice[0], twice[1]) && twice[0].text === v.out, short(twice));
        const empty = refs.resolveMarkers(null, [], "image {n}");
        check("resolveMarkers of no text: empty text, nothing left, nothing resolved", empty.text === "" && !empty.left.length && !empty.refs.length, short(empty));
    });

    // ---- 2. the helpers ----
    await section("2. helpers", async () => {
        check("nameOf {n} (1-based), {n0} (0-based), both in one pattern", refs.nameOf("image {n}", 3) === "image 3" && refs.nameOf("<frame>{n0}</frame>", 3) === "<frame>2</frame>" && refs.nameOf("Image {n} ({n0})", 2) === "Image 2 (1)", [refs.nameOf("image {n}", 3), refs.nameOf("<frame>{n0}</frame>", 3), refs.nameOf("Image {n} ({n0})", 2)].join(" / "));
        check("nameOf with an invalid pattern takes the default", refs.nameOf("@img{n}", 4) === "image 4" && refs.nameOf(null, 1) === "image 1" && refs.REF_NAME_DEFAULT === "image {n}");
        const good = ["image {n}", "<image{n}>", "<frame>{n0}</frame>", "Image {n}", "x".repeat(37) + "{n}"];
        const badNames = ["", "image", "@img{n}", "{@ref:{n}}", "image {n} }", "x".repeat(38) + "{n}", null, undefined, 3, {}, ["{n}"]];
        check("validRefName takes image {n}, <image{n}>, <frame>{n0}</frame>, 40 characters", good.every(refs.validRefName), short(good.filter((s) => !refs.validRefName(s))));
        check("validRefName refuses '', no {n}, @, a marker, a stray brace, 41 characters, non-strings", badNames.every((s) => !refs.validRefName(s)), short(badNames.filter((s) => refs.validRefName(s))));
        const l = refs.layoutOf({ seq: [["crop", "image_urls[0]"], ["original", "image_urls[1]", 0], ["reference", "image_urls[2]", 1]], own: [["mask", "mask_url"]], max: 5, drops: "", style: 0 });
        check("layoutOf numbers seq 1..N in order sent, own gets n null, drops '' reads null, style a boolean", eq(l, { pictures: [{ role: "crop", field: "image_urls[0]", n: 1 }, { role: "original", ref: 0, field: "image_urls[1]", n: 2 }, { role: "reference", ref: 1, field: "image_urls[2]", n: 3 }, { role: "mask", field: "mask_url", n: null }], max: 5, drops: null, style: false }), short(l));
        check("layoutOf() is empty: no pictures, max null, drops null, style false", eq(refs.layoutOf(), { pictures: [], max: null, drops: null, style: false }), short(refs.layoutOf()));
        const two = { references: [1, 2, 3], original: 1 };
        check("refRoles: the Original at 0 when original, then the references; a cap takes the first n", eq(refs.refRoles(two), [["original", 0], ["reference", 1], ["reference", 2]]) && eq(refs.refRoles(two, 2), [["original", 0], ["reference", 1]]) && eq(refs.refRoles({ references: [1, 2] }), [["reference", 0], ["reference", 1]]) && eq(refs.refRoles({}), []), short(refs.refRoles(two)));
        const style = refs.layoutOf({ seq: [["crop", "image"]], own: [["reference", "style_reference_images[0]", 0], ["mask", "mask"]], style: true });
        const numberedMask = refs.layoutOf({ seq: [["crop", "input_references[0]"], ["mask", "input_references[1]"]] });
        check("countOf counts every picture but a mask in a field of its own (style references count)", refs.countOf(l) === 3 && refs.countOf(style) === 2 && refs.countOf(numberedMask) === 2 && refs.countOf(refs.layoutOf()) === 0, [refs.countOf(l), refs.countOf(style), refs.countOf(numberedMask)].join(", "));
        const req = { provider: "test", kind: "fill", references: [1, 2], original: 1 };
        const lay = (pics) => ({ pictures: pics, max: null, drops: null, style: false });
        const C = { role: "crop", field: "a", n: 1 };
        check("checkLayout takes a good layout and answers it", refs.checkLayout(l, req) === l && !!refs.checkLayout(lay([C]), { kind: "edit", references: [] }) && !!refs.checkLayout(refs.layoutOf(), { kind: "text", references: [] }));
        const refusals = [
            ["a gap in the numbers", lay([C, { role: "original", ref: 0, field: "b", n: 3 }])],
            ["two crops", lay([C, { role: "crop", field: "b", n: 2 }])],
            ["no crop on a fill", lay([{ role: "original", ref: 0, field: "b", n: 1 }])],
            ["a reference index past the end", lay([C, { role: "reference", ref: 2, field: "b", n: 2 }])],
            ["a negative reference index", lay([C, { role: "reference", ref: -1, field: "b", n: 2 }])],
            ["a reference twice", lay([C, { role: "reference", ref: 1, field: "b", n: 2 }, { role: "reference", ref: 1, field: "c", n: 3 }])],
            ["the Original role off index 0", lay([C, { role: "original", ref: 1, field: "b", n: 2 }])],
            ["index 0 as a plain reference while the Original is on", lay([C, { role: "reference", ref: 0, field: "b", n: 2 }])],
            ["no pictures list", { max: null }],
        ];
        for (const [what, x] of refusals) check(`checkLayout refuses ${what}`, !!(await throws(() => refs.checkLayout(x, req))));
        check("checkLayout refuses a crop on a text run", !!(await throws(() => refs.checkLayout(lay([C]), { kind: "text", references: [] }))));
        check("checkLayout refuses the Original role when the request has none", !!(await throws(() => refs.checkLayout(lay([C, { role: "original", ref: 0, field: "b", n: 2 }]), { kind: "fill", references: [1], original: 0 }))));
    });

    // ---- the shapes, captured once for §4 (a harness that needs no layout) ----
    const SHAPES = shapesOf();
    const RUNS = [];
    await section("capture harness", async () => {
        const byProvider = new Map();
        for (const s of SHAPES) {
            const run = await runShape(s);
            RUNS.push({ s, ...run });
            const g = byProvider.get(s.provider) || { shapes: 0, sent: 0, refused: 0, lost: [] };
            byProvider.set(s.provider, g);
            g.shapes++;
            if (run.shot.request) g.sent++;
            else if (run.shot.error && !run.shot.calls.length) g.refused++;
            else g.lost.push(`${labelOf(s)} ${tagOf(s)}: ${run.shot.error}`);
            if (VERBOSE) {
                const what = run.shot.request ? run.found.map((x) => `${x.id}@${x.path}`).join(" ") : `refused before any request: ${run.shot.error}`;
                console.log(`  ${labelOf(s)} ${run.req.kind} ${tagOf(s)}: ${what}`);
            }
        }
        for (const [id, g] of byProvider) {
            const withCrop = RUNS.filter((r) => r.s.provider === id && r.shot.request).every((r) => r.found.some((x) => x.id === "crop"));
            check(`${id}: ${g.shapes} shapes, ${g.sent} requests captured with the crop found in each, ${g.refused} refused before any request`, !g.lost.length && withCrop && g.sent > 0, g.lost.slice(0, 3).join(" | "));
        }
        // every adapter with an image edit, but the test provider (no recipe) and the key-only rows (their edit refuses)
        const want = fs.readdirSync(PROV).filter((f) => f.endsWith(".js") && !["index.js", "refs.js", "util.js", "loopback.js"].includes(f)).map((f) => f.replace(/\.js$/, "")).filter((id) => !KEY_ONLY.has(id) && typeof adapter(id).edit === "function");
        const lacking = want.filter((id) => !byProvider.has(id));
        check(`the shapes cover every provider with an image edit (${want.length})`, SHAPES.length > 300 && !lacking.length, `${SHAPES.length} shapes${lacking.length ? ", none for " + lacking.join(", ") : ""}`);
    });

    // ---- 3. coverage ----
    await section("3. coverage", async () => {
        const idx = loadIndex();
        const ids = Object.keys(idx.PROVIDERS);
        for (const id of ids) {
            const p = idx.PROVIDERS[id];
            if (KEY_ONLY.has(id)) continue;
            check(`${id} ${typeof p.edit === "function" ? "exports layout(req) beside edit" : "has no edit and needs no layout"}`, typeof p.edit !== "function" || typeof p.layout === "function");
        }
        // the key-only rows keep an edit that only refuses (no image model behind the key), so they need no layout
        const refusing = [];
        for (const id of KEY_ONLY) {
            const p = idx.PROVIDERS[id];
            if (p && (typeof p.edit !== "function" || await throws(() => p.edit({}, {})))) refusing.push(id);
        }
        check(`the key-only rows (${[...KEY_ONLY].join(", ")}) are in PROVIDERS and exempt: no edit, or one that refuses`, refusing.length === KEY_ONLY.size, `exempt: ${refusing.join(", ")}`);
    });

    // ---- 4. the pin: each layout against the request its builder sent ----
    await section("4. the pin", async () => {
        const groups = new Map();
        for (const r of RUNS) {
            const name = labelOf(r.s);
            const g = groups.get(name) || { n: 0, bad: [] };
            groups.set(name, g);
            g.n++;
            const where = `${tagOf(r.s)}`;
            if (r.layErr) { if (!g.bad.some((b) => b.endsWith(r.layErr))) g.bad.push(`${where}: ${r.layErr}`); continue; }
            for (const b of pin(r.req, r.fx, r.lay, r.shot, r.wide, KNOWN_REFUSALS[name] || null)) g.bad.push(`${where}: ${b}`);
        }
        for (const [name, g] of groups) {
            check(`${name} (${RUNS.find((r) => labelOf(r.s) === name).req.kind}): the layout is the request on ${g.n} shapes${KNOWN_REFUSALS[name] ? " (its refusal of any reference is known, until 26a2)" : ""}`, !g.bad.length, (VERBOSE ? g.bad : g.bad.slice(0, 3)).join(" | ") + (!VERBOSE && g.bad.length > 3 ? ` (+${g.bad.length - 3} more)` : ""));
        }
    });

    // ---- 5. caps and partial drops ----
    await section("5. caps", async () => {
        const shape = (recipe, provider, channel = null) => ({ recipe, provider, channel, variant: variantOf(recipe, provider), refs: 0, original: 0 });
        // the partial drops of 26a1: BFL sends 7 references, Comfy Cloud's Qwen node 3 pictures
        for (const [recipe, provider, n, kept] of [["flux2_pro", "bfl", 9, 7], ["qwen_image_edit", "comfycloud", 4, 2]]) {
            const s = shape(recipe, provider);
            const r = await runShape(s, n, 0);
            const bad = r.layErr ? [r.layErr] : pin(r.req, r.fx, r.lay, r.shot, r.wide);
            const inLay = r.lay ? r.lay.pictures.filter((p) => p.ref != null).map((p) => p.ref) : [];
            check(`${recipe}/${provider} with ${n} references: the first ${kept} sent and laid out, the rest dropped with drops`, !bad.length && eq(inLay, [...Array(kept).keys()]) && !!(r.lay && r.lay.drops), bad.join(" | ") || short(inLay));
        }
        for (const [recipe, provider, channel] of [["gpt_image_2", "openrouter"], ["gpt_image_2", "toapis", "standard"], ["nano_banana_2", "comfyrouter"], ["grok_imagine", "oxen"]]) {
            const s = shape(recipe, provider, channel);
            const name = `${recipe}/${provider}${channel ? ":" + channel : ""}`;
            const r0 = await runShape(s, 0, 0);
            if (r0.layErr) { check(`${name}: caps`, false, r0.layErr); continue; }
            const max = r0.lay.max;
            if (max == null) { console.log(`[skip] ${name}: the layout declares no max`); continue; }
            const k = max - refs.countOf(r0.lay);
            if (k < 0) { check(`${name}: caps`, false, `countOf ${refs.countOf(r0.lay)} without references is past max ${max}`); continue; }
            const at = await runShape(s, k, 0), past = await runShape(s, k + 1, 0);
            const cAt = at.lay ? refs.countOf(at.lay) : null, cPast = past.lay ? refs.countOf(past.lay) : null;
            check(`${name}: at max ${max} (${k} references) the request goes out`, cAt === max && !!at.shot.request, `countOf ${cAt}, ${at.shot.request ? "sent" : "not sent: " + at.shot.error}`);
            check(`${name}: at max + 1 (${k + 1} references) countOf is over and the builder refuses before any request`, cPast === max + 1 && !past.shot.request && !!past.shot.error && past.shot.calls.length === 0, `countOf ${cPast}, ${past.shot.request ? "sent" : `refused after ${past.shot.calls.length} calls: ${past.shot.error}`}`);
            if (provider === "toapis") check("ToAPIs standard declares max 6", max === 6, String(max));
            if (provider === "comfyrouter") check("Comfy Router vertexai on a fill: max is max_images + 1 (the mask picture)", max === s.variant.options.max_images + 1, `${max} for max_images ${s.variant.options.max_images}`);
            if (provider === "oxen") check("Oxen single: max 1", max === 1, String(max));
        }
    });

    // ---- 6. central kinds: a text run carries no reference ----
    await section("6. text runs", async () => {
        const idx = (() => { try { return loadIndex(); } catch (_) { return null; } })();
        const ids = idx ? Object.keys(idx.PROVIDERS) : fs.readdirSync(PROV).filter((f) => f.endsWith(".js") && f !== "index.js" && f !== "refs.js" && f !== "util.js").map((f) => f.replace(/\.js$/, ""));
        for (const id of ids) {
            const p = adapter(id);
            if (typeof p.generate !== "function") continue;
            // a shipped variant's text shape, an edit route's first (the fill models' text shapes are the odd ones)
            const withText = loadRecipes().filter((r) => r.kind === "provider" && r.task !== "upscale" && r.providers[id] && r.providers[id].text && r.providers[id].text.model).map((r) => r.providers[id]);
            const v = withText.find((x) => x.input === "edit") || withText[0] || null;
            if (!v && id !== "loopback") { console.log(`[skip] ${id}: no shipped variant with a text shape`); continue; }
            const t = v ? v.text : { model: "loopback", settings: [], fixed: null };
            const fx = fixturesFor(id, t.model, 2, 0);
            const req = {
                provider: id, model: t.model, kind: "text", prompt: "a lighthouse at dusk", negative: "", seed: 7, width: 1024, height: 768, aspect: null,
                image: null, mask: null, maskAlpha: null, references: fx.references, fields: (v && v.fields) || null, options: (v && v.options) || null,
                params: defaults((t.settings && t.settings.length ? t.settings : v && v.settings) || [], { ...((v && v.fixed) || {}), ...(t.fixed || {}) }), original: 0, refName: refs.REF_NAME_DEFAULT,
            };
            const shot = await capture(p, req, "generate");
            const carried = shot.request ? picturesIn(shot, fx) : walk(shot.result && shot.result.info, "info", fx, shot);
            const uploaded = [...shot.uploads.values()].filter((b) => fixtureOf(b, fx, shot));
            const reached = !!shot.request || (id === "loopback" && !!shot.result);
            check(`${id} (${t.model}): a text run with 2 references sends none of them`, reached && !carried.length && !uploaded.length, reached ? short(carried.map((x) => `${x.id}@${x.path}`)) : `no request: ${shot.error}`);
        }
        if (idx && typeof idx.layout === "function") {
            const l = await idx.layout({ provider: "fal", model: "fal-ai/nano-banana-2/edit", kind: "text", count: 2 });
            check("layout of a text shape: no pictures, drops says Generate new sends none, no names", !!l && eq(l.pictures, []) && l.drops === "Generate new sends no reference images." && eq(l.names, [null, null]) && l.sent === 0, short(l));
        } else check("index.js exports layout(shape)", false);
    });

    // ---- 7. providers/index.js ----
    await section("7. index.js", async () => {
        const idx = loadIndex();
        let FETCH = null;
        /** index.edit with adapters replaced by counting spies and a counting fetch; the log records of the call. */
        async function viaIndex(request, spies = []) {
            const calls = { adapter: 0, fetch: 0 };
            const saved = {};
            for (const id of spies) {
                const p = idx.PROVIDERS[id];
                saved[id] = p;
                const spy = { ...p };
                for (const verb of ["edit", "generate", "upscale"]) if (typeof p[verb] === "function") spy[verb] = function (...a) { calls.adapter++; return p[verb].apply(this, a); };
                idx.PROVIDERS[id] = spy;
            }
            const realFetch = globalThis.fetch;
            globalThis.fetch = async (...a) => { calls.fetch++; if (!FETCH) throw new Error("no network in this test"); return FETCH(...a); };
            const before = LOGS.length;
            let out = null, err = null;
            try { out = await idx.edit(request); } catch (e) { err = String(e && e.message || e); } finally {
                globalThis.fetch = realFetch;
                for (const [id, p] of Object.entries(saved)) idx.PROVIDERS[id] = p;
            }
            const recs = LOGS.slice(before);
            return { out, err, calls, recs, errors: recs.filter((r) => r.level === "error") };
        }
        const png = (tag) => pngOf(64, 64, 64, tag);
        const loop = (extra = {}) => ({ provider: "loopback", kind: "edit", model: "loopback", prompt: "the coat from {@ref:1}", negative: "", seed: 3, references: [png("ORIG"), png("REF1")], original: 1, refName: "image {n}", image: png("CROP"), mask: png("MASK"), maskAlpha: png("MASKA"), width: 64, height: 64, params: {}, ...extra });

        let x = await viaIndex(loop());
        check("loopback, the Original and one reference: {@ref:1} is picture 3, 'image 3' in info.prompt and result.prompt", !x.err && x.out.info && x.out.info.prompt === "the coat from image 3" && x.out.prompt === "the coat from image 3", x.err || short({ info: x.out.info, prompt: x.out.prompt }));
        check("result.refs lists the resolved reference once", !x.err && eq(x.out.refs, [{ ref: 1, name: "image 3" }]), short(x.out && x.out.refs));
        const ok = x.recs.find((r) => r.level !== "error" && r.source === "loopback");
        check("the success record carries the resolved prompt", !!ok && ok.detail && ok.detail.prompt === "the coat from image 3", short(ok));
        x = await viaIndex(loop({ refName: "Image {n}" }));
        check("refName 'Image {n}' names it 'Image 3'", !x.err && x.out.prompt === "the coat from Image 3" && x.out.info.prompt === "the coat from Image 3", x.err || x.out.prompt);
        x = await viaIndex(loop({ refName: "<frame>{n0}</frame>" }));
        check("refName '<frame>{n0}</frame>' counts from 0: '<frame>2</frame>'", !x.err && x.out.prompt === "the coat from <frame>2</frame>", x.err || x.out.prompt);
        x = await viaIndex(loop({ refName: "@img{n}" }));
        check("an invalid refName over IPC takes the default 'image {n}'", !x.err && x.out.prompt === "the coat from image 3", x.err || x.out.prompt);
        x = await viaIndex(loop({ negative: "not {@ref:0}", prompt: "{@ref:1} and {@ref:1}" }));
        const once = (list, ref, name) => !!list && list.filter((r) => r.ref === ref).length === 1 && list.some((r) => r.ref === ref && r.name === name);
        check("the negative resolves too; a marker twice gets one name and one refs entry", !x.err && x.out.negative === "not image 2" && x.out.prompt === "image 3 and image 3" && once(x.out.refs, 1, "image 3"), x.err || short({ negative: x.out.negative, prompt: x.out.prompt, refs: x.out.refs }));
        x = await viaIndex(loop({ negative: null }));
        check("negative null stays null", !x.err && x.out.negative === null, x.err || short(x.out.negative));
        const long = "{@ref:1} " + "x".repeat(700);
        x = await viaIndex(loop({ prompt: long }));
        const rec = x.recs.find((r) => r.level !== "error" && r.source === "loopback");
        check("a long prompt: the result keeps it whole, the success record at most 500 characters", !x.err && x.out.prompt === "image 3 " + "x".repeat(700) && !!rec && typeof rec.detail.prompt === "string" && rec.detail.prompt.length <= 500 && rec.detail.prompt.startsWith("image 3 "), x.err || short(rec && rec.detail && rec.detail.prompt.length));

        const flux1 = variantOf("flux1_fill", "fal");
        const ideo = variantOf("ideogram_inpaint", "magnific");
        const refusals = [
            ["an index past the end ({@ref:5} with 2 references)", loop({ prompt: "from {@ref:5}" }), ["loopback"], null],
            ["a reference the route drops (fal's FLUX.1 Fill, no fields.images)", { provider: "fal", kind: "fill", model: flux1.model, fields: flux1.fields || null, options: flux1.options || null, prompt: "the coat from {@ref:0}", references: [png("REF0")], original: 0, image: png("CROP"), mask: png("MASK"), maskAlpha: png("MASKA"), width: 64, height: 64, params: defaults(flux1.settings, flux1.fixed) }, ["fal"], /left out|takes the crop/i],
            ["an Ideogram style reference (no number)", { provider: "magnific", kind: "fill", model: ideo.model, prompt: "in the style of {@ref:0}", references: [png("REF0")], original: 0, image: png("CROP"), mask: png("MASK"), maskAlpha: png("MASKA"), width: 64, height: 64, params: defaults(ideo.settings, ideo.fixed) }, ["magnific"], /no number/i],
            ["a text run with a marker", { provider: "loopback", kind: "text", model: "loopback", prompt: "like {@ref:0}", references: [png("REF0")], original: 0, width: 64, height: 64, params: {} }, ["loopback"], /Generate new sends no reference/i],
            ["a raw @img2", loop({ prompt: "the coat from @img2" }), ["loopback"], null],
            ["a raw parked @img?Lk3", loop({ prompt: "the coat from @img?Lk3" }), ["loopback"], null],
            ["a malformed {@ref:x}", loop({ prompt: "the coat from {@ref:x}" }), ["loopback"], null],
            ["a raw @img1 in the negative", loop({ prompt: "a coat", negative: "no @img1" }), ["loopback"], null],
            ["original 1 without references", loop({ prompt: "a coat", references: [] }), ["loopback"], null],
        ];
        for (const [what, request, spies, words] of refusals) {
            x = await viaIndex(request, spies);
            check(`refused: ${what}; no adapter call, no request, an error record`, !!x.err && x.calls.adapter === 0 && x.calls.fetch === 0 && x.errors.length >= 1 && (!words || words.test(x.err)), `${x.err} (adapter ${x.calls.adapter}, fetch ${x.calls.fetch}, error records ${x.errors.length})`);
        }
        let stubCalls = 0;
        idx.PROVIDERS.refsstub = { label: "Refs stub", needsKey: false, layout() { throw new Error("refs stub: no such route"); }, async edit() { stubCalls++; return { bytes: RESULT, mime: "image/png", info: {} }; } };
        try {
            x = await viaIndex({ provider: "refsstub", kind: "fill", model: "stub", prompt: "plain words, no marker", references: [], original: 0, image: png("CROP"), mask: png("MASK"), width: 64, height: 64, params: {} });
        } finally { delete idx.PROVIDERS.refsstub; }
        check("a layout that throws refuses the run (no marker in it) before the adapter and any request, with an error record", !!x.err && /refs stub: no such route/.test(x.err) && stubCalls === 0 && x.calls.fetch === 0 && x.errors.length >= 1, `${x.err} (edit ${stubCalls}, fetch ${x.calls.fetch})`);

        // end to end: OpenRouter's builder behind index.js, the prompt as the body says it
        const or = variantOf("gpt_image_2", "openrouter");
        const bodies = [];
        FETCH = async (url, init = {}) => {
            const u = new URL(String(url));
            if (u.pathname === "/api/v1/providers") return json(200, { data: [] });
            if (u.pathname === "/api/v1/images") { bodies.push(JSON.parse(init.body)); return json(200, { data: [{ b64_json: RESULT.toString("base64"), media_type: "image/png" }] }); }
            return json(404, { error: { message: "no route" } });
        };
        adapter("openrouter")._resetHosts();
        try {
            x = await viaIndex({ provider: "openrouter", model: or.model, kind: "fill", options: or.options, fields: null, prompt: "{@ref:1}", negative: "", seed: 7, image: pngOf(1024, 768, 96, "CROP"), mask: pngOf(1024, 768, 96, "MASK"), maskAlpha: pngOf(1024, 768, 96, "MASKA"), width: 1024, height: 768, references: [pngOf(1024, 768, 96, "ORIG"), pngOf(640, 480, 80, "REF1")], original: 1, params: defaults(or.settings, or.fixed) });
        } finally { FETCH = null; }
        const b = bodies[0];
        check("OpenRouter end to end, a fill with the Original and one reference: {@ref:1} reaches the body as 'image 4' (the mask is picture 2)", !x.err && !!b && b.prompt.includes("image 4") && !/\{@ref|@img/i.test(b.prompt) && b.input_references.length === 4 && x.out.prompt === "image 4", x.err || short({ prompt: b && b.prompt, pictures: b && b.input_references.length }));

        // layout(shape), the preview's answer
        check("index.js exports layout(shape)", typeof idx.layout === "function");
        let l = await idx.layout({ provider: "openrouter", model: "openai/gpt-image-2", kind: "fill", options: { max_images: 16 }, count: 2, original: 1, refName: "Image {n}" });
        check("layout: OpenRouter GPT Image 2, a fill with the Original and one reference: names Image 3 and Image 4, 4 sent, not over", !!l && eq(l.names, ["Image 3", "Image 4"]) && l.sent === 4 && l.over === false && l.max === 16, short(l));
        l = await idx.layout({ provider: "openrouter", model: "openai/gpt-image-2", kind: "fill", options: { max_images: 16 }, count: 100, original: 0, refName: "Image {n}" });
        check("layout: count 100 is clamped to 64, and that is over max", !!l && l.names.length === 64 && l.over === true && l.sent === 66, short(l && { n: l.names.length, sent: l.sent, over: l.over }));
        l = await idx.layout({ provider: "openrouter", model: "openai/gpt-image-2", kind: "fill", options: { max_images: 16 }, count: -4, original: 0 });
        check("layout: a negative count is 0: no names, the crop and the mask sent", !!l && eq(l.names, []) && l.sent === 2 && l.over === false, short(l));
        for (const bad of ["nope", "__proto__", "toString", "constructor"]) {
            const e = await throws(() => idx.layout({ provider: bad, kind: "fill", count: 1 }));
            check(`layout: the unknown provider "${bad}" throws`, !!e, e);
        }
        const tv = variantOf("gpt_image_2", "toapis");
        const toShape = (channel) => ({ provider: "toapis", model: tv.model, kind: "fill", options: tv.options, params: { ...defaults(tv.settings, tv.fixed), channel }, count: 1, original: 0, refName: "Image {n}" });
        const off = await idx.layout(toShape("official")), std = await idx.layout(toShape("standard"));
        check("layout: a ToAPIs channel picked through params (official: the mask as mask_url, max 16; standard: no mask, max 6)", !!off && !!std && off.pictures.some((p) => p.role === "mask" && p.field === "mask_url") && off.max === 16 && !std.pictures.some((p) => p.role === "mask") && std.max === 6 && eq(std.names, ["Image 2"]), short({ off: off && { pictures: off.pictures, max: off.max }, std: std && { pictures: std.pictures, max: std.max } }));
        const eCh = await throws(() => idx.layout(toShape("nope")));
        check("layout: an unknown ToAPIs channel throws the builder's own words", !!eCh && /no channel "nope"/.test(eCh), eCh);
        l = await idx.layout({ provider: "fal", model: "fal-ai/seedvr/upscale/image", kind: "upscale", count: 1 });
        check("layout: an upscale is the crop alone (image, n 1) and drops the references", !!l && eq(l.pictures, [{ role: "crop", field: "image", n: 1 }]) && !!l.drops && eq(l.names, [null]), short(l));
        l = await idx.layout({ provider: "fal", model: flux1.model, kind: "fill", count: 1 });
        check("layout: a route that drops references names none (names[i] null) and says why", !!l && eq(l.names, [null]) && !!l.drops, short(l));
    });

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + (err && err.stack || err)); console.log("FAIL"); process.exit(1); });
