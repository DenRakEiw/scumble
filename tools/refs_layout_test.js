// Where each picture of a provider request goes (item 26, docs/PLAN_REFS.md 26a1 and C1-C3), in plain Node, no
// Electron and no key:
//   node tools/refs_layout_test.js            (REFS_VERBOSE=1 prints what every captured request carries)
// §1-2 the helpers of electron/main/providers/refs.js, against tools/refs_cases.json. §3-6 every adapter's `layout(req)`
// pinned against the request its real builder sends: each shipped provider recipe (the upscalers aside) x variant
// (ToAPIs x channel) x references {0, 1, 3} x Original {0, 1} runs the adapter's own `edit` with a fake fetch that
// answers the uploads and captures the request carrying the pictures, then throws. Every picture is a fixture known by
// its bytes, found in that request as a data URL, raw base64, an uploaded file's URL or the bytes themselves, so the
// test reads where each one really went and holds the layout's fields, numbers, `max` and `drops` to it. §7 is
// providers/index.js: markers resolved to the route's names, the refusals and the safety net, `layout(shape)`. §8 the
// 26a2 helpers of refs.js (instruction, labelParts, checkPictures) against literals, §9 index.js's check before the
// adapter through the loopback's test hooks (options.drops, options.max_images) and the answer's `notes`. §10 the 26a2
// sweep: every provider edit variant run in index.js's order (layout, checkPictures, the builder): a declared drop
// sends the crop (and the mask) only with the note, any other route exactly countOf(layout) pictures in the layout's
// order, max + 1 is refused by checkPictures and by the builder itself, every variant has a max, a drop or an entry in
// UNDOCUMENTED, and a resolved marker names a picture by the number the instruction's sentence gives it. §11 the routes
// 26a2 changed one by one (BFL klein through index.js, Comfy Cloud's one-picture node, Gemini and vertexai parts).
// Text runs (Generate new with references, 26f): §6 one per adapter and `layout(shape)` of kind text, §7-9 the markers,
// refusals, instruction and checkPictures of kind text, §12 every shipped variant whose text shape declares `text.refs`
// as host.runGenerate builds the request (the route of text.refs.model, its options, refsMax): the endpoint, the
// references alone in order in textLayout's fields, no edit sentence, the asked shape, the reference sentence where the
// route writes one, the text cap equal to the edit cap and lowered by text.refs.max, max + 1 refused by index.js before
// any fetch; with 0 references every text variant's request against the adapters of a608e8d (git, the commit before
// 26f; skipped without git) and a marker resolved through index.js on two shipped variants.
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

let FETCH = null;   // what the network answers inside viaIndex (null: every fetch throws)
/** index.edit with adapters replaced by counting spies and a counting fetch; the log records of the call. */
async function viaIndex(request, spies = []) {
    const idx = loadIndex();
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

// ---- the fixtures of one request ------------------------------------------------------------------------------

/**
 * The pictures of one request, each known by its bytes: `ids` maps base64 to "crop", "mask", "maskAlpha" or "ref<i>"
 * (references[i], the Original at 0 when `original`). A route that sends a picture it derives from one of them gets
 * that derivation, computed here from the fixture, as a second key of the same id: Magnific's and Ideogram 4.5's mask (inverted,
 * channel 0 at 128 and above black), Image Expand's kept part (the crop inside a 32 px frame), in-app LaMa's RGBA crop
 * and its hole. Those routes decode their pictures, so they get codec pictures at a smaller size.
 */
function fixturesFor(provider, model, nRefs, original) {
    const route = String(model || "").replace(/^\/+|\/+$/g, "").replace(/^v1\/ai\//, "");
    // Ideogram 4.5 (Replicate, WaveSpeed, Comfy Router) inverts the mask as Magnific's Ideogram does (util.js blackEditMask)
    const ideogram45 = /ideogram.*4[-.]5/.test(route);
    const magnific = (provider === "magnific" && (route === "ideogram-image-edit" || route.startsWith("image-expand/"))) || ideogram45;
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
    if (magnific && (route === "ideogram-image-edit" || ideogram45)) {
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
    return { image, mask, maskAlpha, references, original: original ? 1 : 0, width: w, height: h, ids };
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

/** The request providers/index.js hands the adapter (C3): Buffers, fields / options / params, original (the fixtures'), refName. */
function requestFor(s, fx, extra = {}) {
    const v = s.variant;
    const params = defaults(v.settings, v.fixed);
    if (s.channel) params.channel = s.channel;
    return {
        provider: s.provider, model: v.model, kind: v.input === "edit" ? "edit" : "fill", fields: v.fields || null, options: v.options || null,
        prompt: "a red door", negative: "", seed: 7,
        image: fx.image, mask: fx.mask, maskAlpha: fx.maskAlpha, width: fx.width, height: fx.height, references: fx.references,
        params, original: fx.original, refName: (v.refs && v.refs.name) || refs.REF_NAME_DEFAULT, ...extra,
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
 * list, Comfy Cloud's node list for a graph recipe); the first other POST is the request with the pictures: its body is kept and the call throws. In-app LaMa sends
 * nothing: its ONNX call is that request. Returns { calls, uploads, request, error }.
 */
async function capture(p, req, verb = "edit") {
    const shot = { calls: [], uploads: new Map(), pending: new Map(), request: null, error: null, result: null };
    let k = 0;
    const upload = (url, bytes) => { shot.uploads.set(url, bytes); return url; };
    if (typeof p._clearNodeList === "function") p._clearNodeList();   // Comfy Cloud keeps the node list per key
    async function fetch(url, init = {}) {
        const method = String(init.method || "GET").toUpperCase();
        const u = new URL(String(url));
        shot.calls.push(`${method} ${u.host}${u.pathname}`);
        if (method === "PUT" && shot.pending.has(String(url))) { upload(shot.pending.get(String(url)), await bytesOf(init.body)); return new Response(null, { status: 200 }); }
        // Comfy Cloud's node list, asked before a graph recipe's run: every node its graph needs
        if (method === "GET" && u.pathname === "/api/object_info") return json(200, Object.fromEntries(((req.options && req.options.needs) || []).map((c) => [c, {}])));
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
        if (!shot.request) { shot.request = await bodyOf(init.body); shot.url = String(url); }   // a resend of it (Comfy Router) is not kept again
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
        if (req.options && req.options.graph) {
            // a graph recipe (item 35 V5): its pictures are the titled LoadImage nodes, keyed by title as the layout's
            // fields are; a picture past the run's last repeats an earlier upload and is no picture of its own
            const titled = Object.values(shot.graph).map((n) => [String((n && n._meta && n._meta.title) || ""), n]).filter(([t]) => /^scumble:(picture:\d+|mask)$/.test(t));
            titled.sort(([a], [b]) => naturalCmp(a, b));
            const seen = new Set();
            shot.node = {};
            for (const [t, n] of titled) { const v = n.inputs && n.inputs.image; if (seen.has(v)) continue; seen.add(v); shot.node[t] = v; }
        } else {
            const node = String((req.options && req.options.node) || "");
            const id = Object.keys(shot.graph).find((n) => shot.graph[n] && shot.graph[n].class_type === node);
            shot.node = id ? shot.graph[id].inputs : null;
        }
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
 * What is wrong between one layout and the request its builder sent (an empty list when they agree):
 * (e) the builder refuses before any request exactly when countOf(layout) > max; then for a request that went out,
 * (0) checkLayout takes the layout, (a) each field holds exactly its fixture, (b) the fixtures in the request are the
 * layout's, (c) the numbered pictures by n are their fields in natural order, (d) a reference is left out of the
 * layout exactly when the request lacks it, and then only with `drops` set; `drops` is all or nothing (C3, 26a2): a
 * layout that declares it keeps no Original and no reference, one that does not keeps every one.
 */
function pin(req, fx, lay, shot) {
    const bad = [];
    const count = refs.countOf(lay);
    const over = lay.max != null && count > lay.max;
    if (!shot.request) {
        if (shot.error && !shot.calls.length) { if (!over) bad.push(`(e) refused before any request with countOf ${count}, max ${lay.max}: ${shot.error}`); }
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
    if (lay.drops && missing !== given) bad.push(`(d) drops set ("${lay.drops}") but ${given - missing} of ${given} references kept: drops is all or nothing`);
    return bad;
}

// ---- the 26a2 sweep: index.js's order, the caps, the instruction's numbers ----------------------------------------

/**
 * The edit variants whose provider names no picture count, read on 2026-09-29 (the recipes part of 26a2) and mirrored
 * in docs/RECIPES.md's undocumented list. They keep `max` null, so the host may still drop pictures past its own count
 * without a word; flux2_klein/oxen declares 16, oxen.js's own default for a list endpoint, not a documented number.
 */
const UNDOCUMENTED = {
    "nano_banana_2/fal": { max: null, why: "fal nano-banana-2/edit: image_urls has no maxItems and the page names no number" },
    "nano_banana_pro/fal": { max: null, why: "fal nano-banana-pro/edit: no maxItems, no number" },
    "gpt_image_2/replicate": { max: null, why: "replicate.com openai/gpt-image-2: \"pass multiple images\", no number" },
    "nano_banana_2_lite/wavespeed": { max: null, why: "WaveSpeed nano-banana-2-lite-edit: the images row has no range" },
    "reve/wavespeed": { max: null, why: "no WaveSpeed Reve edit page found (404)" },
    "gpt_image_2_5_flare/toapis:official": { max: null, why: "ToAPIs gpt-image-2.5-official: no maximum named" },
    "gpt_image_2_5_flare/toapis:vip": { max: null, why: "ToAPIs gpt-image-2.5-vip: no maximum named" },
    "gpt_image_2_5_flare/toapis:standard": { max: null, why: "ToAPIs gpt-image-2.5: no maximum named" },
    "gpt_image_2_5_sunburst/toapis:official": { max: null, why: "ToAPIs gpt-image-2.5-official: no maximum named" },
    "gpt_image_2_5_sunburst/toapis:vip": { max: null, why: "ToAPIs gpt-image-2.5-vip: no maximum named" },
    "gpt_image_2_5_sunburst/toapis:standard": { max: null, why: "ToAPIs gpt-image-2.5: no maximum named" },
    "flux2_klein/oxen": { max: 16, why: "hub.oxen.ai input_image has no maxItems; 16 is oxen.js's default" },
};

const numberedOf = (lay) => lay.pictures.filter((p) => p.n != null).sort((a, b) => a.n - b.n);
const isMaskId = (id) => id === "mask" || id === "maskAlpha";
const patternOfReq = (req) => (refs.validRefName(req.refName) ? req.refName : refs.REF_NAME_DEFAULT);

/**
 * One shape as providers/index.js runs it (C3's order): the adapter's layout of the request as given (`first`),
 * checkPictures, the layout again when it stripped the references, then the real builder against the fake fetch.
 * `err` is checkPictures' refusal (nothing is captured then). `extra` goes into the request (a resolved prompt).
 */
async function throughCheck(s, nRefs, original, extra = {}) {
    const fx = fixturesFor(s.provider, s.variant.model, nRefs, original);
    let req = requestFor(s, fx, extra);
    const p = adapter(s.provider);
    const who = `${p.label} ${req.model}`;
    const first = refs.checkLayout(p.layout({ ...req }), req);
    let chk;
    try { chk = refs.checkPictures(first, req, who); } catch (err) { return { fx, req, first, lay: first, who, err: String(err && err.message || err) }; }
    let lay = first;
    if (chk.req !== req) { req = chk.req; lay = refs.checkLayout(p.layout({ ...req }), req); }
    const shot = await capture(p, req);
    return { fx, req, first, lay, who, chk, shot, found: picturesIn(shot, fx) };
}

/** Every string under `v` that holds `needle` (the prompt as the builder sent it). */
function stringsWith(v, needle, out = []) {
    if (typeof v === "string") { if (v.includes(needle)) out.push(v); return out; }
    if (v == null || typeof v !== "object" || Buffer.isBuffer(v) || v instanceof Uint8Array) return out;
    for (const x of Array.isArray(v) ? v : Object.values(v)) stringsWith(x, needle, out);
    return out;
}

/** A picture name of `pat` as a regex source with the number as a capture, a leading letter in either case (capital()). */
function nameSource(pat) {
    let src = "", off = 0;
    for (const part of pat.split(/(\{n0?\})/)) {
        if (part === "{n}") src += "(\\d+)";
        else if (part === "{n0}") { src += "(\\d+)"; off = 1; }
        else src += part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    if (/^[A-Za-z]/.test(pat)) src = `[${pat[0].toUpperCase()}${pat[0].toLowerCase()}]${src.slice(1)}`;
    return { src, off };
}

/**
 * The numbers the instruction's sentences give each kind of picture, read back from the text alone (not through
 * refs.instruction): the crop from "Edit X", the mask from "X is a mask:", the Original from "X is Y before the
 * selected area was filled.", the references from "X is a reference image." and the range or list sentences.
 */
function sentenceNumbers(text, pat) {
    const { src: N, off } = nameSource(pat);
    const num = (d) => +d + off;
    const out = { crop: null, mask: null, original: null, refs: [] };
    let m = new RegExp(`^Edit ${N}[ .]`).exec(text);
    if (m) out.crop = num(m[1]);
    m = new RegExp(`${N} is a mask:`).exec(text);
    if (m) out.mask = num(m[1]);
    m = new RegExp(`${N} is ${N} before the selected area was filled\\.`).exec(text);
    if (m) out.original = num(m[1]);
    for (const x of text.matchAll(new RegExp(`${N} is a reference image\\.`, "g"))) out.refs.push(num(x[1]));
    const word = /^([A-Za-z]+) \{n\}$/.exec(pat);
    if (word) {
        const W = `[${word[1][0].toUpperCase()}${word[1][0].toLowerCase()}]${word[1].slice(1)}s`;
        for (const x of text.matchAll(new RegExp(`${W} (\\d+) (and|to) (\\d+) are reference images\\.`, "g"))) {
            const a = +x[1], b = +x[3];
            if (x[2] === "and") out.refs.push(a, b); else for (let k = a; k <= b; k++) out.refs.push(k);
        }
    } else {
        for (const x of text.matchAll(new RegExp(`((?:${N}, )*${N} and ${N}) are reference images\\.`, "g"))) {
            for (const y of x[1].matchAll(new RegExp(N, "g"))) out.refs.push(num(y[1]));
        }
    }
    out.refs.sort((a, b) => a - b);
    return out;
}

/** A Gemini-style parts list as ids: a label part as its text, a picture as its fixture id, the instruction as "text". */
function partsAsIds(parts, fx, shot) {
    return (parts || []).map((x, i) => {
        if (i === 0 && x && typeof x.text === "string") return "text";
        if (x && typeof x.text === "string") return x.text;
        const got = walk(x, "", fx, shot);
        return got.length === 1 ? got[0].id : `?${short(Object.keys(x || {}))}`;
    });
}

// ---- 26f: text runs with references ------------------------------------------------------------------------------

/**
 * Every shipped provider variant with a text shape (ToAPIs once per channel): { recipe, provider, variant, channel,
 * takes }, `takes` whether its text shape declares `text.refs` (the shown reference layers go along, 26f).
 */
function textShapesOf() {
    const out = [];
    for (const r of loadRecipes()) {
        if (r.kind !== "provider" || r.task === "upscale") continue;
        for (const [id, v] of Object.entries(r.providers)) {
            if (!v.text || !v.text.model || typeof adapter(id).generate !== "function") continue;
            const channels = id === "toapis" && v.options && v.options.channels ? Object.keys(v.options.channels) : [null];
            for (const channel of channels) out.push({ recipe: r.id, provider: id, variant: v, channel, takes: !!v.text.refs });
        }
    }
    return out;
}

/**
 * The request host.runGenerate builds for a text run with `n` reference pictures (docs/PLAN_REFS.md 26f sub-task 7),
 * as index.js hands it on: with references the route `text.refs.model` names, `text.refs.options` over the variant's
 * options and `refsMax` the variant's cap; without, the text request of today. The pictures are the fixtures REF<i>.
 */
function textRequestFor(s, n, extra = {}) {
    const v = s.variant, t = v.text, tr = t.refs || {};
    const fx = fixturesFor(s.provider, t.model, n, 0);
    const withRefs = n > 0;
    const params = defaults(t.settings, t.fixed);
    if (s.channel) params.channel = s.channel;
    const req = {
        provider: s.provider, model: (withRefs && tr.model) || t.model, kind: "text", prompt: "a lighthouse at dusk", negative: "", seed: 7,
        width: 1344, height: 768, aspect: "16:9", image: null, mask: null, maskAlpha: null, references: fx.references, original: 0,
        refName: tr.name || (v.refs && v.refs.name) || refs.REF_NAME_DEFAULT, refsMax: withRefs ? tr.max || null : null,
        fields: v.fields || null, options: withRefs && tr.options ? { ...(v.options || {}), ...tr.options } : v.options || null, params, ...extra,
    };
    return { fx, req };
}

/** Every string under `v`. */
function stringsIn(v, out = []) {
    if (typeof v === "string") { out.push(v); return out; }
    if (v == null || typeof v !== "object" || Buffer.isBuffer(v) || v instanceof Uint8Array) return out;
    for (const x of Array.isArray(v) ? v : Object.values(v)) stringsIn(x, out);
    return out;
}

/** The request with each fixture as "<id>" and long strings cut: what REFS_VERBOSE prints. */
function redacted(v, fx, shot) {
    const id = fixtureOf(v, fx, shot);
    if (id) return `<${id}>`;
    if (typeof v === "string") return v.length > 120 ? v.slice(0, 120) + " ..." : v;
    if (v == null || typeof v !== "object") return v;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `<${v.length} bytes>`;
    if (Array.isArray(v)) return v.map((x) => redacted(x, fx, shot));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redacted(x, fx, shot)]));
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
    return { fx, req, lay, layErr, shot, found: picturesIn(shot, fx) };
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
            for (const b of pin(r.req, r.fx, r.lay, r.shot)) g.bad.push(`${where}: ${b}`);
        }
        for (const [name, g] of groups) {
            check(`${name} (${RUNS.find((r) => labelOf(r.s) === name).req.kind}): the layout is the request on ${g.n} shapes`, !g.bad.length, (VERBOSE ? g.bad : g.bad.slice(0, 3)).join(" | ") + (!VERBOSE && g.bad.length > 3 ? ` (+${g.bad.length - 3} more)` : ""));
        }
    });

    // ---- 5. caps (26a1's partial drops are caps from 26a2 on) ----
    await section("5. caps", async () => {
        const shape = (recipe, provider, channel = null) => ({ recipe, provider, channel, variant: variantOf(recipe, provider), refs: 0, original: 0 });
        // BFL cut the references at 7 and Comfy Cloud's Qwen node at 2 without a word; now every one is laid out and sent
        // up to the model's own count, and one more is refused before any request (or upload)
        for (const [recipe, provider, max, last] of [["flux2_pro", "bfl", 8, "input_image_8"], ["flux2_klein", "bfl", 4, "input_image_4"], ["qwen_image_edit", "comfycloud", 3, "model.images.image_3"]]) {
            const s = shape(recipe, provider);
            const name = `${recipe}/${provider}`;
            const at = await runShape(s, max - 1, 0), past = await runShape(s, max, 0);
            const bad = [...(at.layErr ? [at.layErr] : pin(at.req, at.fx, at.lay, at.shot)), ...(past.layErr ? [past.layErr] : pin(past.req, past.fx, past.lay, past.shot))];
            const inLay = at.lay ? at.lay.pictures.filter((p) => p.ref != null).map((p) => p.ref) : [];
            const lastPic = at.shot.request ? picturesAt(at.shot, last, at.fx) : null;
            const next = last.replace(/\d+$/, (d) => String(+d + 1));
            check(`${name}: max ${max}, no drops; ${max - 1} references are all laid out and sent, the last in ${last} and nothing in ${next}`, !bad.length && at.lay && at.lay.max === max && !at.lay.drops && eq(inLay, [...Array(max - 1).keys()]) && !!lastPic && lastPic.length === 1 && lastPic[0].id === `ref${max - 2}` && picturesAt(at.shot, next, at.fx) === null, bad.join(" | ") || short({ max: at.lay && at.lay.max, drops: at.lay && at.lay.drops, inLay, last: lastPic }));
            const e = await throws(() => refs.checkPictures(past.lay, past.req, name));
            check(`${name}: ${max} references (${max + 1} pictures) are refused by checkPictures and by the builder before any request`, !past.shot.request && past.shot.calls.length === 0 && new RegExp(`takes at most ${max} pictures; this run has ${max + 1}`).test(past.shot.error || "") && e === `${name} takes at most ${max} pictures; this run has ${max + 1} (the crop, ${max} reference layers): hide reference layers or turn Original off.`, `builder: ${past.shot.error} (${past.shot.calls.length} calls) | checkPictures: ${e}`);
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
            if (provider === "comfyrouter") check("Comfy Router vertexai on a fill: max is max_images, and the mask picture counts against it", max === s.variant.options.max_images && refs.countOf(r0.lay) === 2 && r0.lay.pictures.some((p) => p.role === "mask" && p.n === 2), `${max} for max_images ${s.variant.options.max_images}, countOf ${refs.countOf(r0.lay)} without references`);
            if (provider === "oxen") check("Oxen single: max 1", max === 1, String(max));
        }
    });

    // ---- 6. central kinds: a text run sends the references where the variant takes them (26f) ----
    await section("6. text runs", async () => {
        const idx = (() => { try { return loadIndex(); } catch (_) { return null; } })();
        const ids = idx ? Object.keys(idx.PROVIDERS) : fs.readdirSync(PROV).filter((f) => f.endsWith(".js") && f !== "index.js" && f !== "refs.js" && f !== "util.js").map((f) => f.replace(/\.js$/, ""));
        const TEXT = textShapesOf();
        for (const id of ids) {
            const p = adapter(id);
            if (typeof p.generate !== "function") continue;
            // the first shipped variant whose text shape takes references (§12 runs every one); the loopback has its own
            const s = TEXT.find((x) => x.provider === id && x.takes && !x.channel) || TEXT.find((x) => x.provider === id && x.takes)
                || (id === "loopback" ? { recipe: "(test)", provider: id, channel: null, takes: true, variant: { model: "loopback", refs: { name: "image {n}" }, text: { model: "loopback", settings: [], fixed: null, refs: { max: null, field: null, model: null, options: null, name: null } } } } : null);
            if (!s) {
                // a provider whose text routes take no references (Comfy Cloud's text-to-image graphs, item 35 V6): a text
                // run with references declares the drop
                const plain = TEXT.find((x) => x.provider === id);
                if (plain && idx && typeof idx.layout === "function") {
                    const t = plain.variant.text || {};
                    const l = await idx.layout({ provider: id, model: t.model, kind: "text", count: 2, options: t.options || plain.variant.options || null });
                    check(`${id}: its text routes take no references (${plain.recipe}): a text run with two declares the drop`, !!l && eq(l.pictures, []) && !!l.drops, short(l));
                } else check(`${id}: a shipped variant whose text shape takes references`, false, "none: add text.refs or drop generate");
                continue;
            }
            check(`${id}: exports textLayout(req) beside generate`, typeof p.textLayout === "function");
            // two references, or one on a route that takes one (Grok's edit id on Oxen)
            const cap = (() => { try { return p.textLayout({ ...textRequestFor(s, 1).req }).max; } catch (_) { return null; } })();
            const n = cap != null && cap < 2 ? cap : 2;
            const { fx, req } = textRequestFor(s, n);
            const shot = await capture(p, req, "generate");
            const carried = shot.request ? picturesIn(shot, fx) : [];
            const uploaded = [...shot.uploads.values()].map((b) => fixtureOf(b, fx, shot)).filter(Boolean);
            const want = Array.from({ length: n }, (_, i) => `ref${i}`);
            if (id === "loopback") {
                const info = shot.result && shot.result.info;
                check(`${id}: a text run with ${n} references hands both to the model (info.references)`, !!info && info.references === n, short(info) || shot.error);
                continue;
            }
            const got = carried.map((x) => x.id);
            check(`${id} ${s.recipe} (${req.model}): a text run with ${n} reference${n === 1 ? "" : "s"} sends ${n === 1 ? "it" : "them"} in order, and no other picture`, !!shot.request && eq(got, want) && uploaded.every((u) => want.includes(u)), shot.request ? short(carried.map((x) => `${x.id}@${x.path}`)) : `no request: ${shot.error}`);
        }
        if (idx && typeof idx.layout === "function") {
            const refPic = (i, field) => ({ role: "reference", ref: i, field, n: i + 1 });
            let l = await idx.layout({ provider: "fal", model: "fal-ai/nano-banana-2/edit", kind: "text", count: 2 });
            check("layout of a text shape on a route that takes references (fal nano-banana-2/edit): the references numbered 'image 1', 'image 2', no crop, no drop", !!l && eq(l.pictures, [refPic(0, "image_urls[0]"), refPic(1, "image_urls[1]")]) && l.drops === null && eq(l.names, ["image 1", "image 2"]) && l.sent === 2 && l.over === false, short(l));
            l = await idx.layout({ provider: "fal", model: "fal-ai/nano-banana-2", kind: "text", count: 2 });
            check("layout of a text shape on a route that takes none (fal's text-to-image route): no pictures, the drop said, no names", !!l && eq(l.pictures, []) && !!l.drops && eq(l.names, [null, null]) && l.sent === 0 && l.over === false, short(l));
            l = await idx.layout({ provider: "fal", model: "fal-ai/nano-banana-2/edit", kind: "text", count: 0 });
            const l0 = await idx.layout({ provider: "fal", model: "fal-ai/nano-banana-2", kind: "text", count: 0 });
            check("layout of a text shape with count 0: no pictures, no drop, no names (either route)", [l, l0].every((x) => !!x && eq(x.pictures, []) && x.drops === null && eq(x.names, []) && x.sent === 0 && x.over === false), short({ edit: l, text: l0 }));
            l = await idx.layout({ provider: "fal", model: "fal-ai/flux-2-pro/edit", kind: "text", count: 2, refsMax: 1, refName: "Image {n}" });
            check("layout of a text shape: refsMax lowers the route's max (8 to 1), over past it, the names by refName", !!l && l.max === 1 && l.over === true && l.sent === 2 && eq(l.names, ["Image 1", "Image 2"]), short(l));
            l = await idx.layout({ provider: "fal", model: "fal-ai/flux-2-pro/edit", kind: "text", count: 2, original: 1 });
            check("layout of a text shape ignores original: 1 (a new image has no Original): both counted as references", !!l && eq(l.names, ["image 1", "image 2"]) && l.pictures.every((x) => x.role === "reference"), short(l));
            const e = await throws(() => idx.layout({ provider: "inapp", model: "lama", kind: "text", count: 1 }));
            check("layout of a text shape on a provider with no text-to-image endpoint throws", !!e && /no text-to-image endpoint/.test(e), e);
            idx.PROVIDERS.refsstub = { label: "Refs stub", needsKey: false, async generate() { return { bytes: RESULT, mime: "image/png", info: {} }; } };
            try { l = await idx.layout({ provider: "refsstub", model: "stub", kind: "text", count: 2 }); } finally { delete idx.PROVIDERS.refsstub; }
            check("layout of a text shape on an adapter without textLayout: index.js declares the drop in its own words", !!l && eq(l.pictures, []) && l.drops === "Refs stub makes a new image from the prompt alone: reference images are left out" && eq(l.names, [null, null]), short(l));
        } else check("index.js exports layout(shape)", false);
    });

    // ---- 7. providers/index.js ----
    await section("7. index.js", async () => {
        const idx = loadIndex();
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
        // a text run (26f): no crop, so the first reference is picture 1
        x = await viaIndex({ provider: "loopback", kind: "text", model: "loopback", prompt: "the jacket of {@ref:1} on the person of {@ref:0}", negative: "not {@ref:1}", seed: 3, references: [png("REF0"), png("REF1")], original: 0, refName: "image {n}", image: null, mask: null, width: 64, height: 64, params: {} }, ["loopback"]);
        check("loopback, a text run with 2 references: {@ref:1} is 'image 2', {@ref:0} 'image 1' (no crop), both references reach the model", !x.err && x.calls.adapter === 1 && x.out.prompt === "the jacket of image 2 on the person of image 1" && x.out.info.prompt === x.out.prompt && x.out.negative === "not image 2" && x.out.info.references === 2 && eq(x.out.refs, [{ ref: 1, name: "image 2" }, { ref: 0, name: "image 1" }]) && eq(x.out.notes, []), x.err || short({ prompt: x.out.prompt, negative: x.out.negative, refs: x.out.refs, info: x.out.info }));
        x = await viaIndex({ provider: "loopback", kind: "text", model: "loopback", prompt: "a lighthouse", seed: 3, references: [], original: 0, width: 64, height: 64, params: {} }, ["loopback"]);
        check("loopback, a text run without references: the prompt as given, refs [], no notes", !x.err && x.out.prompt === "a lighthouse" && x.out.info.references === 0 && eq(x.out.refs, []) && eq(x.out.notes, []), x.err || short(x.out));

        const flux1 = variantOf("flux1_fill", "fal");
        const ideo = variantOf("ideogram_inpaint", "magnific");
        const refusals = [
            ["an index past the end ({@ref:5} with 2 references)", loop({ prompt: "from {@ref:5}" }), ["loopback"], null],
            ["a reference the route drops (fal's FLUX.1 Fill, no fields.images)", { provider: "fal", kind: "fill", model: flux1.model, fields: flux1.fields || null, options: flux1.options || null, prompt: "the coat from {@ref:0}", references: [png("REF0")], original: 0, image: png("CROP"), mask: png("MASK"), maskAlpha: png("MASKA"), width: 64, height: 64, params: defaults(flux1.settings, flux1.fixed) }, ["fal"], /left out|takes the crop/i],
            ["an Ideogram style reference (no number)", { provider: "magnific", kind: "fill", model: ideo.model, prompt: "in the style of {@ref:0}", references: [png("REF0")], original: 0, image: png("CROP"), mask: png("MASK"), maskAlpha: png("MASKA"), width: 64, height: 64, params: defaults(ideo.settings, ideo.fixed) }, ["magnific"], /without a number/i],
            ["a text run with a marker on a route that drops the references (loopback options.drops)", { provider: "loopback", kind: "text", model: "loopback", prompt: "like {@ref:0}", references: [png("REF0")], original: 0, width: 64, height: 64, params: {}, options: { drops: "test drop" } }, ["loopback"], /test drop, so the prompt cannot name a reference image/],
            ["a text run that marks an Original", { provider: "loopback", kind: "text", model: "loopback", prompt: "like {@ref:1}", references: [png("ORIG"), png("REF1")], original: 1, width: 64, height: 64, params: {} }, ["loopback"], /A new image has no Original picture/],
            ["a text run with a marker past its references ({@ref:2} with 2)", { provider: "loopback", kind: "text", model: "loopback", prompt: "like {@ref:2}", references: [png("REF0"), png("REF1")], original: 0, width: 64, height: 64, params: {} }, ["loopback"], /names reference picture 3, and the request carries 2/],
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

    // ---- 8. the instruction, the label parts and the check before the adapter (26a2) ----
    await section("8. instruction, labelParts, checkPictures", async () => {
        const L = refs.layoutOf;
        const HEAD = "Edit image 1 and keep its size and framing.";
        const MASKED = "Edit image 1. Image 2 is a mask: change only the white area of the mask, keep everything else exactly as it is, and keep the image size and framing.";
        /** n references (plus the Original when `original`), the request fields instruction and checkPictures read. */
        const reqOf = (n, extra = {}) => ({ kind: "edit", refName: "image {n}", original: 0, prompt: "a red door", negative: "", ...extra, references: Array.from({ length: n + (extra.original ? 1 : 0) }, (_, i) => i) });
        /** The crop, then the mask as a picture (`mask`) or in its own field (`own`), then the references in order. */
        const layOf = (req, { mask = false, own = false } = {}) => L({ seq: [["crop", "p[0]"], ...(mask ? [["mask", "p[1]"]] : []), ...refs.refRoles(req).map(([role, i]) => [role, `p[${i + (mask ? 2 : 1)}]`, i])], own: own ? [["mask", "mask"]] : [] });
        const cases = [
            ["no reference", reqOf(0), {}, `${HEAD} a red door`],
            ["1 reference", reqOf(1), {}, `${HEAD} a red door Image 2 is a reference image.`],
            ["2 references", reqOf(2), {}, `${HEAD} a red door Images 2 and 3 are reference images.`],
            ["3 references", reqOf(3), {}, `${HEAD} a red door Images 2 to 4 are reference images.`],
            ["4 references", reqOf(4), {}, `${HEAD} a red door Images 2 to 5 are reference images.`],
            ["a mask picture, no reference", reqOf(0, { kind: "fill" }), { mask: true }, `${MASKED} a red door`],
            ["a mask picture and 2 references", reqOf(2, { kind: "fill" }), { mask: true }, `${MASKED} a red door Images 3 and 4 are reference images.`],
            ["a mask in its own field is no picture", reqOf(1, { kind: "fill" }), { own: true }, `${HEAD} a red door Image 2 is a reference image.`],
            ["the Original alone", reqOf(0, { original: 1 }), {}, `${HEAD} a red door Image 2 is image 1 before the selected area was filled.`],
            ["a mask picture, the Original and 2 references", reqOf(2, { kind: "fill", original: 1 }), { mask: true }, `${MASKED} a red door Image 3 is image 1 before the selected area was filled. Images 4 and 5 are reference images.`],
            ["'Image {n}', the Original and 2 references", reqOf(2, { original: 1, refName: "Image {n}" }), {}, "Edit Image 1 and keep its size and framing. a red door Image 2 is Image 1 before the selected area was filled. Images 3 and 4 are reference images."],
            ["'<image{n}>' and 3 references: a list, nothing capitalised", reqOf(3, { refName: "<image{n}>" }), {}, "Edit <image1> and keep its size and framing. a red door <image2>, <image3> and <image4> are reference images."],
            ["'<image{n}>' and 2 references", reqOf(2, { refName: "<image{n}>" }), {}, "Edit <image1> and keep its size and framing. a red door <image2> and <image3> are reference images."],
            ["'<image{n}>', a mask picture and 1 reference", reqOf(1, { kind: "fill", refName: "<image{n}>" }), { mask: true }, "Edit <image1>. <image2> is a mask: change only the white area of the mask, keep everything else exactly as it is, and keep the image size and framing. a red door <image3> is a reference image."],
            ["'picture {n0}': a list, a letter at the start capitalised", reqOf(2, { refName: "picture {n0}" }), {}, "Edit picture 0 and keep its size and framing. a red door Picture 1 and picture 2 are reference images."],
            ["an invalid refName takes 'image {n}'", reqOf(1, { refName: "@img{n}" }), {}, `${HEAD} a red door Image 2 is a reference image.`],
        ];
        for (const [what, req, opt, want] of cases) {
            const got = refs.instruction(req, layOf(req, opt), "a red door");
            check(`instruction: ${what}`, got === want, got);
        }
        let got = refs.instruction(reqOf(1), layOf(reqOf(1)), "  a red door  ");
        check("instruction: the text is trimmed, one space between the parts", got === `${HEAD} a red door Image 2 is a reference image.`, got);
        got = refs.instruction(reqOf(1), layOf(reqOf(1)), "");
        check("instruction: an empty text leaves no double space", got === `${HEAD} Image 2 is a reference image.`, got);
        got = refs.instruction(reqOf(0), layOf(reqOf(0)), null);
        check("instruction: no text at all is the head alone", got === HEAD, got);
        const gap = L({ seq: [["crop", "a"], ["reference", "b", 0], ["mask", "c"], ["reference", "d", 1]] });
        got = refs.instruction(reqOf(2, { kind: "fill" }), gap, "a red door");
        check("instruction: references that are not consecutive get one sentence per run", got === "Edit image 1. Image 3 is a mask: change only the white area of the mask, keep everything else exactly as it is, and keep the image size and framing. a red door Image 2 is a reference image. Image 4 is a reference image.", got);
        const style = L({ seq: [["crop", "image"]], own: [["mask", "mask"], ["reference", "style_reference_images[0]", 0], ["reference", "style_reference_images[1]", 1]], max: 11, style: true });
        got = refs.instruction(reqOf(2, { kind: "fill" }), style, "a red door");
        check("instruction: style references get no reference sentence", got === `${HEAD} a red door`, got);
        const styleNumbered = L({ seq: [["crop", "a"], ["reference", "b", 0]], style: true });
        got = refs.instruction(reqOf(1), styleNumbered, "a red door");
        check("instruction: a style layout gets none even for a numbered reference", got === `${HEAD} a red door`, got);
        const passBad = [];
        for (const kind of ["text", "upscale"]) for (const t of [" a lighthouse ", "", "x {@ref:0}"]) {
            const out = refs.instruction({ kind, refName: "image {n}", references: [1, 2], original: 0 }, L(), t);
            if (out !== t) passBad.push(`${kind} ${JSON.stringify(t)} -> ${JSON.stringify(out)}`);
        }
        check("instruction: kind upscale takes the text unchanged, and kind text without a numbered reference", !passBad.length, passBad.join(" | "));
        const upNumbered = refs.instruction({ kind: "upscale", refName: "image {n}", references: [1, 2], original: 0 }, L({ seq: [["crop", "image"], ["reference", "r[0]", 0]] }), " a lighthouse ");
        check("instruction: kind upscale stays unchanged even with a numbered layout", upNumbered === " a lighthouse ", upNumbered);
        // kind text (Generate new, 26f): no crop, the references numbered from 1, the sentence after the text
        const textReq = (n, refName = "image {n}") => ({ kind: "text", refName, original: 0, references: Array.from({ length: n }, (_, i) => i) });
        const textLay = (n) => L({ seq: refs.refRoles(textReq(n)).map(([role, i]) => [role, `image_urls[${i}]`, i]) });
        const textCases = [
            ["1 reference", 1, "image {n}", "a lighthouse", "a lighthouse Image 1 is a reference image."],
            ["2 references", 2, "image {n}", "a lighthouse", "a lighthouse Images 1 and 2 are reference images."],
            ["3 references", 3, "image {n}", "a lighthouse", "a lighthouse Images 1 to 3 are reference images."],
            ["5 references", 5, "image {n}", "a lighthouse", "a lighthouse Images 1 to 5 are reference images."],
            ["'Image {n}' and 2 references", 2, "Image {n}", "a lighthouse", "a lighthouse Images 1 and 2 are reference images."],
            ["'<image{n}>' and 2 references: a list", 2, "<image{n}>", "a lighthouse", "a lighthouse <image1> and <image2> are reference images."],
            ["'<image{n}>' and 3 references", 3, "<image{n}>", "a lighthouse", "a lighthouse <image1>, <image2> and <image3> are reference images."],
            ["'<image{n}>' and 1 reference", 1, "<image{n}>", "a lighthouse", "a lighthouse <image1> is a reference image."],
            ["'picture {n0}': counted from 0, the first letter capitalised", 2, "picture {n0}", "a lighthouse", "a lighthouse Picture 0 and picture 1 are reference images."],
            ["an invalid refName takes 'image {n}'", 2, "@img{n}", "a lighthouse", "a lighthouse Images 1 and 2 are reference images."],
            ["the text trimmed, one space between the parts", 2, "image {n}", "  a lighthouse  ", "a lighthouse Images 1 and 2 are reference images."],
            ["an empty text: the sentence alone", 2, "image {n}", "", "Images 1 and 2 are reference images."],
            ["no text at all: the sentence alone", 1, "image {n}", null, "Image 1 is a reference image."],
        ];
        for (const [what, n, pat, t, want] of textCases) {
            const out = refs.instruction(textReq(n, pat), textLay(n), t);
            check(`instruction, kind text: ${what}`, out === want, out);
        }
        const noEdit = [];
        for (const n of [1, 2, 3]) { const out = refs.instruction(textReq(n), textLay(n), "a lighthouse"); if (/\bEdit\b|before the selected area|\bmask\b/.test(out)) noEdit.push(out); }
        check("instruction, kind text: never an 'Edit ...' head, a mask or an Original sentence", !noEdit.length, noEdit.join(" | "));
        const textDrop = refs.instruction(textReq(2), L({ drops: "test drop" }), " a lighthouse ");
        const textStyle = refs.instruction(textReq(2), L({ own: [["reference", "style[0]", 0], ["reference", "style[1]", 1]], style: true }), " a lighthouse ");
        check("instruction, kind text: a drop layout (no pictures) and a style layout leave the text unchanged", textDrop === " a lighthouse " && textStyle === " a lighthouse ", short({ textDrop, textStyle }));

        const five = reqOf(2, { kind: "fill", original: 1 });
        let parts = refs.labelParts(layOf(five, { mask: true }), "image {n}");
        check("labelParts: one part per numbered picture by n, capitalised, with a colon", eq(parts, [1, 2, 3, 4, 5].map((n) => ({ text: `Image ${n}:` }))), short(parts));
        parts = refs.labelParts(layOf(reqOf(0)), "image {n}");
        check("labelParts: [] when only one picture goes", eq(parts, []), short(parts));
        parts = refs.labelParts(layOf(reqOf(0, { kind: "fill" }), { own: true }), "image {n}");
        check("labelParts: [] for the crop and a mask in its own field", eq(parts, []), short(parts));
        parts = refs.labelParts(layOf(reqOf(1, { kind: "fill" }), { own: true }), "<image{n}>");
        check("labelParts: '<image{n}>' stays as it is; a mask in its own field gets no part", eq(parts, [{ text: "<image1>:" }, { text: "<image2>:" }]), short(parts));
        parts = refs.labelParts(gap, "Image {n}");
        check("labelParts: in n order, whatever the order of `pictures`", eq(parts.map((x) => x.text), ["Image 1:", "Image 2:", "Image 3:", "Image 4:"]), short(parts));
        parts = refs.labelParts(layOf(reqOf(1)), "@img{n}");
        check("labelParts: an invalid pattern takes 'image {n}'", eq(parts, [{ text: "Image 1:" }, { text: "Image 2:" }]), short(parts));

        const WHO = "Test route";
        const DROP = "FLUX.1 Fill takes no reference images";
        const cropOnly = (drops) => L({ seq: [["crop", "image"]], own: [["mask", "mask"]], drops });
        let req = reqOf(2, { kind: "fill", original: 1 });
        let chk = refs.checkPictures(cropOnly(DROP), req, WHO);
        check("checkPictures: a declared drop strips the Original and every reference and says so", chk.req !== req && eq(chk.req.references, []) && chk.req.original === 0 && chk.req.prompt === "a red door" && chk.req.kind === "fill" && eq(chk.notes, [`${WHO}: ${DROP}; the Original and 2 reference layers not sent.`]), short(chk));
        check("checkPictures: the request it was given is not changed", req.references.length === 3 && req.original === 1);
        chk = refs.checkPictures(cropOnly("This endpoint takes the crop and the mask only: reference images are left out."), reqOf(1, { kind: "fill" }), WHO);
        check("checkPictures: a drop sentence's full stop goes; 1 reference layer", eq(chk.notes, [`${WHO}: This endpoint takes the crop and the mask only: reference images are left out; 1 reference layer not sent.`]), short(chk.notes));
        chk = refs.checkPictures(cropOnly(DROP), reqOf(0, { kind: "fill", original: 1 }), WHO);
        check("checkPictures: the Original alone", eq(chk.notes, [`${WHO}: ${DROP}; the Original not sent.`]) && eq(chk.req.references, []), short(chk.notes));
        req = reqOf(0, { kind: "fill" });
        chk = refs.checkPictures(cropOnly(DROP), req, WHO);
        check("checkPictures: a drop with no reference given changes nothing and notes nothing", chk.req === req && eq(chk.notes, []), short(chk));
        chk = refs.checkPictures(cropOnly(DROP), reqOf(1, { kind: "fill", prompt: "a coat {@ref:x}" }), WHO);
        check("checkPictures: a malformed marker is no marker here (index.js's safety net takes it)", eq(chk.req.references, []) && chk.notes.length === 1, short(chk));
        let e = await throws(() => refs.checkPictures(cropOnly(DROP), reqOf(1, { kind: "fill", prompt: "the coat from {@ref:0}" }), WHO));
        check("checkPictures: a drop with a marker in the prompt is refused", e === `${WHO}: ${DROP}, so the prompt cannot name a reference image. Take the name out or pick a recipe that sends references.`, e);
        e = await throws(() => refs.checkPictures(cropOnly(DROP), reqOf(1, { kind: "fill", negative: "not {@ref:0}" }), WHO));
        check("checkPictures: a drop with a marker in the negative is refused", !!e && e.startsWith(`${WHO}: ${DROP}, so the prompt cannot name`), e);
        e = await throws(() => refs.checkPictures(style, reqOf(2, { kind: "fill", prompt: "in the style of {@ref:1}" }), WHO));
        check("checkPictures: a style reference named by a marker is refused", e === `${WHO} sends reference layers without a number (as style references or unnumbered references): take the name out of the prompt.`, e);
        req = reqOf(2, { kind: "fill" });
        chk = refs.checkPictures(style, req, WHO);
        check("checkPictures: style references without a marker go (3 of max 11)", chk.req === req && eq(chk.notes, []), short(chk));
        const capped = (req, max, opt) => ({ ...layOf(req, opt), max });
        req = reqOf(3, { kind: "fill", original: 1 });
        e = await throws(() => refs.checkPictures(capped(req, 5, { mask: true }), req, WHO));
        check("checkPictures: over max, the exact message (countOf, every part named)", e === `${WHO} takes at most 5 pictures; this run has 6 (the crop, the mask, the Original, 3 reference layers): hide reference layers or turn Original off.`, e);
        req = reqOf(1);
        e = await throws(() => refs.checkPictures(capped(req, 1), req, WHO));
        check("checkPictures: max 1 in the singular", e === `${WHO} takes at most 1 picture; this run has 2 (the crop, 1 reference layer): hide reference layers or turn Original off.`, e);
        req = reqOf(2, { kind: "fill" });
        e = await throws(() => refs.checkPictures(capped(req, 2, { own: true }), req, WHO));
        check("checkPictures: a mask in its own field is not counted", e === `${WHO} takes at most 2 pictures; this run has 3 (the crop, 2 reference layers): hide reference layers or turn Original off.`, e);
        chk = refs.checkPictures(capped(req, 3, { own: true }), req, WHO);
        check("checkPictures: at max the request goes unchanged", chk.req === req && eq(chk.notes, []), short(chk));
        req = reqOf(2, { kind: "fill" });
        e = await throws(() => refs.checkPictures({ ...style, max: 2 }, req, WHO));
        check("checkPictures: style references count against max (the mask in its own field does not)", e === `${WHO} takes at most 2 pictures; this run has 3 (the crop, 2 reference layers): hide reference layers or turn Original off.`, e);
        const loose = [];
        for (const max of [null, 0, "0", "x", -1]) {
            req = reqOf(3);
            try { const c = refs.checkPictures(capped(req, max), req, WHO); if (c.req !== req) loose.push(`${max}: changed`); } catch (err) { loose.push(`${JSON.stringify(max)}: ${err.message}`); }
        }
        check("checkPictures: a max that is no positive number is no cap (read as +x > 0)", !loose.length, loose.join(" | "));
        chk = refs.checkPictures(capped(reqOf(3), "5"), reqOf(3), WHO);
        e = await throws(() => refs.checkPictures(capped(reqOf(5), "5"), reqOf(5), WHO));
        check("checkPictures: a max given as the string '5' caps at 5", chk.notes.length === 0 && !!e && e.includes("takes at most 5 pictures; this run has 6"), e);
        const leftAlone = [];
        req = reqOf(2, { kind: "upscale", prompt: "like {@ref:0}" });
        for (const lay of [cropOnly(DROP), capped(reqOf(0), 1), style]) {
            try { const c = refs.checkPictures(lay, req, WHO); if (c.req !== req || c.notes.length) leftAlone.push("upscale: changed"); } catch (err) { leftAlone.push(`upscale: ${err.message}`); }
        }
        check("checkPictures: kind upscale is left alone (index.js lays it out without references)", !leftAlone.length, leftAlone.join(" | "));

        // kind text (26f): held to its text layout, the refusal names reference pictures only
        const textOf = (n, extra = {}) => ({ kind: "text", refName: "image {n}", original: 0, prompt: "a lighthouse", negative: "", ...extra, references: Array.from({ length: n }, (_, i) => i) });
        const textLayOf = (n, max = null) => L({ seq: refs.refRoles(textOf(n)).map(([role, i]) => [role, `image_urls[${i}]`, i]), max });
        const TDROP = "this model takes no reference images for a new image";
        req = textOf(2);
        chk = refs.checkPictures(L({ drops: TDROP }), req, WHO);
        check("checkPictures, kind text: a declared drop strips both references and says so", chk.req !== req && eq(chk.req.references, []) && chk.req.original === 0 && chk.req.kind === "text" && eq(chk.notes, [`${WHO}: ${TDROP}; 2 reference layers not sent.`]) && req.references.length === 2, short(chk));
        chk = refs.checkPictures(L({ drops: TDROP + "." }), textOf(1), WHO);
        check("checkPictures, kind text: a drop with 1 reference, the full stop taken off", eq(chk.notes, [`${WHO}: ${TDROP}; 1 reference layer not sent.`]), short(chk.notes));
        e = await throws(() => refs.checkPictures(L({ drops: TDROP }), textOf(2, { prompt: "like {@ref:1}" }), WHO));
        check("checkPictures, kind text: a drop with a marker is refused", e === `${WHO}: ${TDROP}, so the prompt cannot name a reference image. Take the name out or pick a recipe that sends references.`, e);
        e = await throws(() => refs.checkPictures(textLayOf(3, 2), textOf(3), WHO));
        check("checkPictures, kind text: past max, the words of a new image (reference pictures, no crop, no Original)", e === `${WHO} takes at most 2 reference pictures for a new image; this run has 3: hide reference layers.`, e);
        e = await throws(() => refs.checkPictures(textLayOf(2, 1), textOf(2), WHO));
        check("checkPictures, kind text: max 1 in the singular", e === `${WHO} takes at most 1 reference picture for a new image; this run has 2: hide reference layers.`, e);
        e = await throws(() => refs.checkPictures(textLayOf(9, 8), textOf(9, { prompt: "like {@ref:0}" }), WHO));
        check("checkPictures, kind text: the cap refuses before a marker is looked at", !!e && e.includes("takes at most 8 reference pictures for a new image; this run has 9"), e);
        req = textOf(3, { prompt: "like {@ref:2}" });
        chk = refs.checkPictures(textLayOf(3, 3), req, WHO);
        check("checkPictures, kind text: at max the request goes unchanged, no notes", chk.req === req && eq(chk.notes, []), short(chk));
        req = textOf(0);
        chk = refs.checkPictures(L({ drops: TDROP }), req, WHO);
        check("checkPictures, kind text: no reference given, nothing changes (a drop included)", chk.req === req && eq(chk.notes, []), short(chk));
        e = await throws(() => refs.checkPictures(L({ own: [["reference", "style[0]", 0]], style: true }), textOf(1, { prompt: "like {@ref:0}" }), WHO));
        check("checkPictures, kind text: a style reference named by a marker is refused", e === `${WHO} sends reference layers without a number (as style references or unnumbered references): take the name out of the prompt.`, e);
    });

    // ---- 9. providers/index.js: the check before the adapter, the notes (26a2) ----
    await section("9. index.js drops and caps", async () => {
        const idx = loadIndex();
        const png = (tag) => pngOf(64, 64, 64, tag);
        const loop = (extra = {}) => ({ provider: "loopback", kind: "edit", model: "loopback", prompt: "a red door", negative: "", seed: 3, references: [png("ORIG"), png("REF1"), png("REF2")], original: 1, refName: "image {n}", image: png("CROP"), mask: png("MASK"), maskAlpha: png("MASKA"), width: 64, height: 64, params: {}, ...extra });
        const WHO = "Loopback (test) loopback";
        const NOTE = `${WHO}: test drop; the Original and 2 reference layers not sent.`;
        const okRec = (x) => x.recs.find((r) => r.level !== "error" && r.source === "loopback");

        let x = await viaIndex(loop({ options: { drops: "test drop" } }), ["loopback"]);
        check("options.drops: the adapter runs once and gets no reference and no Original", !x.err && x.calls.adapter === 1 && x.out.info.references === 0 && x.out.info.original === 0, x.err || short(x.out.info));
        check("options.drops: result.notes holds the one note", !x.err && eq(x.out.notes, [NOTE]), short(x.out && x.out.notes));
        let rec = okRec(x);
        check("options.drops: the success record carries notes and pictures (countOf: the crop)", !!rec && eq(rec.detail.notes, [NOTE]) && rec.detail.pictures === 1, short(rec && rec.detail));
        x = await viaIndex(loop({ options: { drops: "test drop" }, references: [png("REF0")], original: 0 }), ["loopback"]);
        check("options.drops with one reference layer: '1 reference layer not sent'", !x.err && eq(x.out.notes, [`${WHO}: test drop; 1 reference layer not sent.`]) && x.out.info.references === 0, x.err || short(x.out.notes));
        x = await viaIndex(loop({ options: { drops: "test drop" }, prompt: "the coat from {@ref:1}" }), ["loopback"]);
        check("options.drops and a marker: refused before the adapter and any request, with an error record", x.err === `${WHO}: test drop, so the prompt cannot name a reference image. Take the name out or pick a recipe that sends references.` && x.calls.adapter === 0 && x.calls.fetch === 0 && x.errors.length >= 1, `${x.err} (adapter ${x.calls.adapter})`);
        x = await viaIndex(loop({ options: { drops: "test drop" }, prompt: "the coat from {@ref:x}" }), ["loopback"]);
        check("options.drops and a malformed marker: the safety net refuses it (the stripped request counts no empty picture)", !!x.err && /keeps for itself/.test(x.err) && x.calls.adapter === 0, x.err);
        x = await viaIndex(loop({ options: { drops: "test drop" }, references: [png("REF0"), null], original: 0 }), ["loopback"]);
        check("options.drops with an empty picture in the list and no marker: stripped, the run goes", !x.err && x.calls.adapter === 1 && x.out.info.references === 0 && x.out.notes.length === 1, x.err || short(x.out.notes));

        x = await viaIndex(loop({ options: { max_images: 2 }, references: [png("REF0"), png("REF1")], original: 0 }), ["loopback"]);
        check("options.max_images 2 with 3 pictures: refused before the adapter and any request, the exact message, an error record", x.err === `${WHO} takes at most 2 pictures; this run has 3 (the crop, 2 reference layers): hide reference layers or turn Original off.` && x.calls.adapter === 0 && x.calls.fetch === 0 && x.errors.length >= 1, `${x.err} (adapter ${x.calls.adapter}, fetch ${x.calls.fetch})`);
        x = await viaIndex(loop({ options: { max_images: 2 }, references: [png("REF0"), png("REF1")], original: 0, prompt: "from {@ref:1}" }), ["loopback"]);
        check("options.max_images: the cap refuses before a marker is resolved", !!x.err && x.err.includes("at most 2 pictures; this run has 3") && x.calls.adapter === 0, x.err);
        x = await viaIndex(loop({ options: { max_images: 4 }, prompt: "from {@ref:2}" }), ["loopback"]);
        rec = okRec(x);
        check("options.max_images 4 with 4 pictures: the run goes, the marker resolves, notes [], pictures 4", !x.err && x.calls.adapter === 1 && x.out.info.references === 3 && x.out.prompt === "from image 4" && eq(x.out.notes, []) && !!rec && rec.detail.pictures === 4 && eq(rec.detail.notes, []), x.err || short({ out: x.out.notes, rec: rec && rec.detail }));
        x = await viaIndex(loop(), ["loopback"]);
        check("a plain run answers notes: []", !x.err && Array.isArray(x.out.notes) && x.out.notes.length === 0 && x.out.info.references === 3, x.err || short(x.out.notes));
        // a text run (26f) is held to its text layout the same way
        const text = (extra = {}) => ({ provider: "loopback", kind: "text", model: "loopback", prompt: "a lighthouse", negative: "", seed: 3, references: [png("REF0"), png("REF1")], original: 0, refName: "image {n}", width: 64, height: 64, params: {}, ...extra });
        x = await viaIndex(text({ options: { drops: "test drop" } }), ["loopback"]);
        rec = okRec(x);
        check("a text run, options.drops: the adapter runs once with no reference, the note says 2 reference layers", !x.err && x.calls.adapter === 1 && x.out.info.references === 0 && eq(x.out.notes, [`${WHO}: test drop; 2 reference layers not sent.`]) && !!rec && rec.detail.pictures === 0, x.err || short({ info: x.out.info, notes: x.out.notes }));
        x = await viaIndex(text({ options: { max_images: 1 } }), ["loopback"]);
        check("a text run, options.max_images 1 with 2 references: refused before the adapter and any request, the words of a new image", x.err === `${WHO} takes at most 1 reference picture for a new image; this run has 2: hide reference layers.` && x.calls.adapter === 0 && x.calls.fetch === 0 && x.errors.length >= 1, `${x.err} (adapter ${x.calls.adapter})`);
        x = await viaIndex(text({ refsMax: 1 }), ["loopback"]);
        check("a text run, refsMax 1 (the variant's text.refs.max) with 2 references: refused the same way", x.err === `${WHO} takes at most 1 reference picture for a new image; this run has 2: hide reference layers.` && x.calls.adapter === 0, `${x.err} (adapter ${x.calls.adapter})`);
        x = await viaIndex(text({ options: { max_images: 4 }, refsMax: 2 }), ["loopback"]);
        check("a text run, refsMax 2 under the route's max 4: the lower cap wins, 2 references go", !x.err && x.calls.adapter === 1 && x.out.info.references === 2 && eq(x.out.notes, []), x.err || short(x.out.notes));
        x = await viaIndex(text({ options: { max_images: 1 }, refsMax: 3 }), ["loopback"]);
        check("a text run, refsMax 3 over the route's max 1: the route's cap still refuses", !!x.err && x.err.includes("takes at most 1 reference picture for a new image; this run has 2") && x.calls.adapter === 0, x.err);
        x = await viaIndex(text({ options: { max_images: 2 }, prompt: "like {@ref:1}" }), ["loopback"]);
        rec = okRec(x);
        check("a text run at max 2: the run goes, {@ref:1} is 'image 2', notes [], pictures 2", !x.err && x.calls.adapter === 1 && x.out.prompt === "like image 2" && x.out.info.references === 2 && eq(x.out.notes, []) && !!rec && rec.detail.pictures === 2, x.err || short({ prompt: x.out.prompt, rec: rec && rec.detail }));

        let l = await idx.layout({ provider: "loopback", model: "loopback", kind: "edit", options: { drops: "test drop" }, count: 3, original: 1 });
        check("layout(shape) of a route that declares a drop: every name null, the drop said", !!l && eq(l.names, [null, null, null]) && l.drops === "test drop" && l.sent === 1 && l.over === false, short(l));
        l = await idx.layout({ provider: "loopback", model: "loopback", kind: "edit", options: { max_images: 2 }, count: 2, original: 0, refName: "Image {n}" });
        check("layout(shape) over the cap: over true, the names as they would be sent", !!l && l.over === true && l.sent === 3 && l.max === 2 && eq(l.names, ["Image 2", "Image 3"]), short(l));
        l = await idx.layout({ provider: "loopback", model: "loopback", kind: "edit", options: { max_images: 3 }, count: 2, original: 0 });
        check("layout(shape) at the cap: not over", !!l && l.over === false && l.sent === 3 && eq(l.names, ["image 2", "image 3"]), short(l));
        l = await idx.layout({ provider: "loopback", model: "loopback", kind: "edit", options: { drops: "test drop" }, count: 0 });
        check("layout(shape) of a drop with no references: no names", !!l && eq(l.names, []), short(l));
        l = await idx.layout({ provider: "loopback", model: "loopback", kind: "text", options: { drops: "test drop" }, count: 2 });
        check("layout(shape) of a text run on a route that drops: every name null, nothing sent, the drop said", !!l && eq(l.names, [null, null]) && l.drops === "test drop" && l.sent === 0 && l.over === false, short(l));
        l = await idx.layout({ provider: "loopback", model: "loopback", kind: "text", options: { max_images: 1 }, count: 2 });
        check("layout(shape) of a text run over the cap: over true, the names from 'image 1'", !!l && l.over === true && l.sent === 2 && l.max === 1 && eq(l.names, ["image 1", "image 2"]), short(l));
        l = await idx.layout({ provider: "loopback", model: "loopback", kind: "text", count: 3, refsMax: 3 });
        check("layout(shape) of a text run at refsMax: not over, three names", !!l && l.over === false && l.max === 3 && eq(l.names, ["image 1", "image 2", "image 3"]), short(l));
    });

    // ---- 10. the sweep: every provider edit variant as index.js runs it (26a2) ----
    await section("10. sweep: drops, caps, order, the instruction's numbers", async () => {
        const variants = SHAPES.filter((s) => s.refs === 0 && !s.original);
        const labels = new Set(variants.map(labelOf));
        const tally = { drops: 0, capped: 0, undocumented: 0, instruction: 0, plain: 0, noFit: 0, labelled: 0 };
        for (const s of variants) {
            const name = labelOf(s);
            const bad = [];
            const p = adapter(s.provider);
            const fx0 = fixturesFor(s.provider, s.variant.model, 0, 0);
            const req0 = requestFor(s, fx0);
            const base = refs.checkLayout(p.layout({ ...req0 }), req0);
            const drops = base.drops, max = base.max;
            if (drops) tally.drops++;
            // every variant says how many pictures it takes, drops them all, or is on the undocumented list
            const und = UNDOCUMENTED[name];
            if (und) {
                tally.undocumented++;
                if (drops) bad.push(`on the undocumented list, yet it declares drops ("${drops}")`);
                if (max !== und.max) bad.push(`on the undocumented list with max ${und.max}, yet the layout says ${max}`);
            } else if (!drops) {
                if (max == null) bad.push("no max, no drops and not on the undocumented list");
                else tally.capped++;
            }
            // 0, 1 and 3 references, the Original off and on
            let labelled = false;
            for (const n of [0, 1, 3]) for (const original of [0, 1]) {
                const tag = `${n} ref${n === 1 ? "" : "s"}${original ? " + Original" : ""}`;
                const given = n + original;
                const r = await throughCheck(s, n, original);
                if ((r.first.drops || null) !== (drops || null)) { bad.push(`${tag}: drops "${r.first.drops}", with no reference "${drops}" (drops is the route's, not the request's)`); continue; }
                if (r.err) {
                    const c = refs.countOf(r.first);
                    if (drops || max == null || c <= max || !r.err.startsWith(`${r.who} takes at most ${max} picture${max === 1 ? "" : "s"}; this run has ${c} (`)) bad.push(`${tag}: refused: ${r.err}`);
                    continue;
                }
                if (!r.shot.request) { bad.push(`${tag}: the builder sent nothing after checkPictures let it through: ${r.shot.error}`); continue; }
                const ids = r.found.map((x) => x.id);
                if (drops) {
                    const words = [original ? "the Original" : "", n ? `${n} reference layer${n === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
                    const note = given ? [`${r.who}: ${String(drops).replace(/[\s.]+$/, "")}; ${words} not sent.`] : [];
                    if (!eq(r.chk.notes, note)) bad.push(`${tag}: notes ${short(r.chk.notes)}, not ${short(note)}`);
                    if (r.req.references.length || r.req.original) bad.push(`${tag}: the adapter got ${r.req.references.length} references, original ${r.req.original}`);
                    if (!ids.includes("crop") || ids.some((id) => id !== "crop" && !isMaskId(id))) bad.push(`${tag}: a drop route sent [${ids.join(", ")}], not the crop (and the mask) only`);
                    continue;
                }
                if (r.chk.req !== r.req || r.chk.notes.length) bad.push(`${tag}: checkPictures changed a request under the cap (${short(r.chk.notes)})`);
                // exactly countOf(layout) pictures, the numbered ones in the layout's order
                const ownMask = r.lay.pictures.some((x) => x.role === "mask" && x.n == null);
                const counted = r.found.filter((x) => !(ownMask && isMaskId(x.id)));
                if (counted.length !== refs.countOf(r.lay)) bad.push(`${tag}: the builder sent ${counted.length} pictures [${counted.map((x) => x.id).join(", ")}], countOf is ${refs.countOf(r.lay)}`);
                const want = numberedOf(r.lay).map((x) => (x.role === "crop" ? "crop" : x.role === "mask" ? "mask" : `ref${x.ref}`));
                const numberedIds = new Set(want);
                const got = counted.map((x) => (isMaskId(x.id) ? "mask" : x.id)).filter((id) => numberedIds.has(id));
                if (!eq(got, want)) bad.push(`${tag}: the numbered pictures go as [${got.join(", ")}], the layout by n says [${want.join(", ")}]`);
                // Gemini and Comfy Router vertexai: a label part before each picture when more than one goes
                const partsField = numberedOf(r.lay).length && /^contents\[0\]\.parts\[\d+\]$/.test(numberedOf(r.lay)[0].field);
                if (partsField) {
                    labelled = true;
                    const parts = r.shot.request.contents[0].parts;
                    const pat = patternOfReq(r.req);
                    const pics = numberedOf(r.lay);
                    const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
                    const expect = ["text", ...(pics.length > 1 ? pics.flatMap((x, k) => [`${cap(refs.nameOf(pat, x.n))}:`, want[k]]) : want)];
                    const gotParts = partsAsIds(parts, r.fx, r.shot).map((id) => (isMaskId(id) ? "mask" : id));
                    if (!eq(gotParts, expect)) bad.push(`${tag}: parts [${gotParts.join(", ")}], not [${expect.join(", ")}]`);
                }
            }
            if (labelled) tally.labelled++;
            // one more picture than max: refused in checkPictures, and by the builder itself before any request
            if (!drops && max != null) {
                const k = max - refs.countOf(base) + 1;
                if (k < 1) bad.push(`max ${max} is below the ${refs.countOf(base)} pictures of a run without references`);
                else {
                    const r = await throughCheck(s, k, 0);
                    const phrase = `takes at most ${max} picture${max === 1 ? "" : "s"}; this run has ${max + 1} (`;
                    if (!r.err || !r.err.startsWith(`${r.who} ${phrase}`)) bad.push(`max + 1 (${k} references): checkPictures ${r.err ? "said " + r.err : "let it through"}`);
                    const shot = await capture(p, requestFor(s, fixturesFor(s.provider, s.variant.model, k, 0)));
                    if (shot.request || shot.calls.length) bad.push(`max + 1 (${k} references): the builder called directly ${shot.request ? "sent the request" : `made ${shot.calls.length} calls first`} (${shot.error})`);
                }
            }
            // the invariant: a marker resolves to the number the instruction's sentence gives the same picture
            if (!drops && !base.style) {
                let fit = null;
                for (const n of [3, 2, 1]) {
                    const fx = fixturesFor(s.provider, s.variant.model, n, 1), q = requestFor(s, fx);
                    const l = p.layout({ ...q });
                    if (max == null || refs.countOf(l) <= max) { fit = { n, lay: l, req: q }; break; }
                }
                if (!fit) tally.noFit++;
                else {
                    const pat = patternOfReq(fit.req);
                    const last = fit.n;   // references[last] is the last reference layer (the Original at 0)
                    const res = refs.resolveMarkers(`a red door like {@ref:${last}}, lit as {@ref:0}`, fit.lay.pictures, fit.req.refName);
                    const r = await throughCheck(s, fit.n, 1, { prompt: res.text });
                    const sent = r.shot && r.shot.request ? [...new Set(stringsWith(r.shot.request, res.text))] : [];
                    if (res.left.length) bad.push(`markers left: ${short(res.left)}`);
                    else if (sent.length !== 1) bad.push(`the resolved prompt is ${sent.length ? "in the request " + sent.length + " ways" : "not in the request"} (${r.err || (r.shot && r.shot.error)})`);
                    else if (sent[0] === res.text) tally.plain++;
                    else {
                        tally.instruction++;
                        const { src, off } = nameSource(pat);
                        const numOf = (nm) => { const m = new RegExp(`^${src}$`).exec(nm); return m ? +m[1] + off : null; };
                        const got = sentenceNumbers(sent[0], pat);
                        const pics = numberedOf(r.lay);
                        const nOf = (role) => { const x = pics.find((q) => q.role === role); return x ? x.n : null; };
                        const refNs = pics.filter((x) => x.role === "reference").map((x) => x.n);
                        const byRef = new Map(res.refs.map((x) => [x.ref, x.name]));
                        const origPic = pics.find((x) => x.role === "original"), lastPic = pics.find((x) => x.ref === last);
                        const why = [];
                        if (got.crop !== nOf("crop")) why.push(`the crop is ${got.crop} in the sentence, ${nOf("crop")} in the layout`);
                        if (got.mask !== nOf("mask")) why.push(`the mask is ${got.mask} in the sentence, ${nOf("mask")} in the layout`);
                        if (!origPic || got.original !== origPic.n || numOf(byRef.get(0)) !== got.original) why.push(`the Original: sentence ${got.original}, layout ${origPic && origPic.n}, marker "${byRef.get(0)}"`);
                        if (!eq(got.refs, refNs)) why.push(`the references: sentences [${got.refs}], layout [${refNs}]`);
                        if (!lastPic || !got.refs.includes(numOf(byRef.get(last))) || numOf(byRef.get(last)) !== lastPic.n) why.push(`the last reference: marker "${byRef.get(last)}", layout ${lastPic && lastPic.n}`);
                        if (sent[0] !== refs.instruction(r.req, r.lay, res.text)) why.push("the text is not refs.instruction of this layout");
                        if (why.length) bad.push(`${fit.n} refs + Original, markers resolved: ${why.join("; ")} (${short(sent[0])})`);
                    }
                }
            }
            check(`${name}: ${drops ? `drops ("${drops}")` : max != null ? `max ${max}` : "no max (undocumented)"}; index.js's order sends what the layout says`, !bad.length, (VERBOSE ? bad : bad.slice(0, 3)).join(" | ") + (!VERBOSE && bad.length > 3 ? ` (+${bad.length - 3} more)` : ""));
        }
        const stale = Object.keys(UNDOCUMENTED).filter((k) => !labels.has(k));
        check("every UNDOCUMENTED entry names a shipped edit variant", !stale.length, stale.join(", "));
        check(`the sweep covered ${variants.length} variants: ${tally.capped} capped, ${tally.drops} dropping, ${tally.undocumented} undocumented; ${tally.instruction} checked against their instruction, ${tally.plain} send the text as it is, ${tally.noFit} take no reference; ${tally.labelled} with label parts (Gemini, Comfy Router vertexai)`, variants.length > 100 && tally.instruction > 20 && tally.labelled >= 6 && tally.drops > 5, short(tally));
    });

    // ---- 11. the routes 26a2 changed, one by one ----
    await section("11. BFL, Comfy Cloud, Gemini and vertexai", async () => {
        const shape = (recipe, provider) => ({ recipe, provider, channel: null, variant: variantOf(recipe, provider), refs: 0, original: 0 });
        // BFL klein through index.js: the Original and 3 references are 5 pictures, one past the 4 it takes
        const kv = variantOf("flux2_klein", "bfl");
        const png = (tag) => pngOf(64, 64, 64, tag);
        let x = await viaIndex({ provider: "bfl", model: kv.model, kind: "edit", fields: kv.fields || null, options: kv.options || null, prompt: "a red door", negative: "", seed: 7, image: png("CROP"), mask: png("MASK"), maskAlpha: png("MASKA"), width: 64, height: 64, references: [png("ORIG"), png("REF1"), png("REF2"), png("REF3")], original: 1, params: defaults(kv.settings, kv.fixed) }, ["bfl"]);
        check("BFL klein through index.js with 5 pictures: refused before the adapter and any request, the exact message", x.err === `Black Forest Labs ${kv.model} takes at most 4 pictures; this run has 5 (the crop, the Original, 3 reference layers): hide reference layers or turn Original off.` && x.calls.adapter === 0 && x.calls.fetch === 0 && x.errors.length >= 1, `${x.err} (adapter ${x.calls.adapter}, fetch ${x.calls.fetch})`);

        // Comfy Cloud's one-picture Gemini node: a direct call with references uploads the crop alone and wires it
        const nb = shape("nano_banana_pro", "comfycloud");
        const g = await runShape(nb, 2, 1);
        const uploaded = [...g.shot.uploads.values()].map((b) => fixtureOf(b, g.fx, g.shot));
        check(`Comfy Cloud ${nb.variant.options.node} with the Original and 2 references, called directly: one upload (the crop), wired to images`, g.shot.request && eq(uploaded, ["crop"]) && eq(g.found.map((f) => f.id), ["crop"]) && g.found[0].path === "images" && !pin(g.req, g.fx, g.lay, g.shot).length, short({ uploaded, found: g.found, bad: pin(g.req, g.fx, g.lay, g.shot) }));
        const gi = await throughCheck(nb, 2, 1);
        check(`Comfy Cloud ${nb.variant.options.node} through checkPictures: stripped, the note names the node's one picture`, !gi.err && eq(gi.chk.notes, [`Comfy Cloud ${nb.variant.model}: this node takes one picture; the Original and 2 reference layers not sent.`]) && gi.shot.uploads.size === 1, gi.err || short(gi.chk.notes));

        // Gemini direct, a fill with the Original and one reference: the text, then each picture after its label
        const gm = shape("nano_banana_2", "gemini");
        let r = await runShape(gm, 1, 1);
        let ids = r.shot.request ? partsAsIds(r.shot.request.contents[0].parts, r.fx, r.shot) : [];
        check("Gemini nano_banana_2, a fill with the Original and 1 reference: parts [text, Image 1:, crop, Image 2:, mask, Image 3:, Original, Image 4:, reference]", eq(ids, ["text", "Image 1:", "crop", "Image 2:", "mask", "Image 3:", "ref0", "Image 4:", "ref1"]) && !pin(r.req, r.fx, r.lay, r.shot).length, short(ids));
        const text = r.shot.request ? r.shot.request.contents[0].parts[0].text : "";
        check("Gemini: the text part is the instruction with the mask, the Original and the reference numbered as the parts", text === "Edit image 1. Image 2 is a mask: change only the white area of the mask, keep everything else exactly as it is, and keep the image size and framing. a red door Image 3 is image 1 before the selected area was filled. Image 4 is a reference image.", text);
        const ge = { ...gm, variant: { ...gm.variant, input: "edit" } };
        r = await runShape(ge, 0, 0);
        ids = r.shot.request ? partsAsIds(r.shot.request.contents[0].parts, r.fx, r.shot) : [];
        check("Gemini, an edit with the crop alone: no label part, [text, crop] as before", eq(ids, ["text", "crop"]) && r.lay.pictures.length === 1 && r.lay.pictures[0].field === "contents[0].parts[1]", short(ids));
        r = await runShape(gm, 12, 0);
        check("Gemini at max 14 (the crop, the mask, 12 references): sent", !!r.shot.request && refs.countOf(r.lay) === 14 && r.lay.max === 14, `${refs.countOf(r.lay)} ${r.shot.error}`);
        r = await runShape(gm, 13, 0);
        check("Gemini with the crop, the mask and 13 references: the builder refuses before any request", !r.shot.request && r.shot.calls.length === 0 && /takes at most 14 pictures; this run has 15/.test(r.shot.error || ""), r.shot.error);

        // Comfy Router vertexai, the same fill: the same parts under Comfy Router's inlineData
        const vx = shape("nano_banana_2", "comfyrouter");
        r = await runShape(vx, 1, 0);
        ids = r.shot.request ? partsAsIds(r.shot.request.contents[0].parts, r.fx, r.shot) : [];
        check("Comfy Router vertexai nano_banana_2, a fill with 1 reference: parts [text, Image 1:, crop, Image 2:, mask, Image 3:, reference]", eq(ids, ["text", "Image 1:", "crop", "Image 2:", "mask", "Image 3:", "ref0"]) && !pin(r.req, r.fx, r.lay, r.shot).length, short(ids));
        const vt = r.shot.request ? r.shot.request.contents[0].parts[0].text : "";
        check("Comfy Router vertexai: the text part is the instruction numbered as the parts", /^Edit image 1\. Image 2 is a mask: .* a red door Image 3 is a reference image\.$/.test(vt), vt);
    });

    // ---- 12. text runs with references (26f): every variant whose text shape takes them, as its builder sends it ----
    await section("12. text runs with references", async () => {
        const idx = loadIndex();
        const TEXT = textShapesOf();
        const takes = TEXT.filter((s) => s.takes);
        const dialectOf = (s, model) => (s.provider === "comfyrouter" ? adapter("comfyrouter")._splitModel(model)[0] : null);
        const keyOf = (s, model) => (s.provider === "comfyrouter" ? `comfyrouter:${dialectOf(s, model)}` : s.provider);
        const tally = { variants: 0, capped: 0, uncapped: 0, sentence: 0, parts: 0, noShape: 0, routes: new Set() };
        for (const s of takes) {
            const name = labelOf(s);
            const bad = [];
            const p = adapter(s.provider);
            const tr = s.variant.text.refs;
            if (typeof p.textLayout !== "function") { check(`${name}: textLayout`, false, "the adapter exports none"); continue; }
            // the route's own cap (refsMax aside) and the central one; two references, or one where the route takes one
            const own = p.textLayout({ ...textRequestFor(s, 1).req }).max;
            const n = own != null && own < 2 ? own : 2;
            const { fx, req } = textRequestFor(s, n);
            const key = keyOf(s, req.model);
            tally.routes.add(key);
            let lay = null;
            try { lay = refs.checkLayout(p.textLayout({ ...req }), req); } catch (err) { bad.push(`textLayout: ${err.message}`); }
            if (lay) {
                const want = Array.from({ length: n }, (_, i) => ({ role: "reference", ref: i, n: i + 1 }));
                if (!eq(lay.pictures.map((x) => ({ role: x.role, ref: x.ref, n: x.n })), want) || lay.drops) bad.push(`textLayout: ${short(lay)}, not ${n} references numbered from 1 without a drop`);
            }
            const shot = await capture(p, req, "generate");
            if (!shot.request) { bad.push(`no request: ${shot.error} (${shot.calls.join(", ")})`); check(`${name}: ${n} references`, false, bad.join(" | ")); continue; }
            tally.variants++;
            // the endpoint and the route
            const url = shot.url;
            const ENDPOINT = {
                toapis: `${LOOP}/v1/images/generations`, bfl: `https://api.bfl.ai/v1/${req.model}`, fal: `https://queue.fal.run/${req.model}`,
                replicate: `https://api.replicate.com/v1/models/${req.model}/predictions`, wavespeed: `https://api.wavespeed.ai/api/v3/${req.model}`,
                openai: "https://api.openai.com/v1/images/edits", gemini: `https://generativelanguage.googleapis.com/v1beta/models/${req.model}:generateContent`,
                openrouter: `${LOOP}/api/v1/images`, ark: `${LOOP}/api/v3/images/generations`, oxen: `${LOOP}/api/ai/images/edit`,
                magnific: `${LOOP}/v1/ai/${req.model}`, comfyrouter: `${LOOP}/v2/models/${req.model}/requests`, comfypartner: `${LOOP}/proxy/tencent/v1/wand/hunyuan-image/v35-generation`,
            };
            if (!(s.provider in ENDPOINT)) bad.push(`no endpoint known for ${s.provider}: add it to this test`);
            else if (url !== ENDPOINT[s.provider]) bad.push(`POSTs to ${url}, not ${ENDPOINT[s.provider]}`);
            if (tr.model && req.model !== tr.model) bad.push(`goes to ${req.model}, not text.refs.model ${tr.model}`);
            if (tr.model && tr.model !== s.variant.model) bad.push(`text.refs.model ${tr.model} is not the variant's edit model ${s.variant.model}`);
            if (s.provider === "fal" && !/\/edit(-image)?$/.test(req.model)) bad.push(`fal: ${req.model} is no /edit route`);
            if (s.provider === "wavespeed" && !/(?:^|[/-])edit(?:[/-]|$)/.test(req.model)) bad.push(`WaveSpeed: ${req.model} is no edit route`);
            if (s.provider === "magnific" && !/^text-to-image\/flux-2-|-edit$/.test(req.model)) bad.push(`Magnific: ${req.model} is neither a flux-2 route nor an -edit route`);
            if (s.provider === "openai") {
                const imgs = shot.request["image[]"];
                if (!Array.isArray(imgs) || imgs.length !== n) bad.push(`OpenAI: image[] holds ${Array.isArray(imgs) ? imgs.length : "no"} pictures, not ${n}`);
            }
            // the pictures: the references in order, each in its layout field, nothing else (no crop, no mask)
            const found = picturesIn(shot, fx).map((x) => x.id);
            const refIds = Array.from({ length: n }, (_, i) => `ref${i}`);
            if (!eq(found, refIds)) bad.push(`carries [${found.join(", ")}], not [${refIds.join(", ")}]`);
            const uploaded = [...shot.uploads.values()].map((b) => fixtureOf(b, fx, shot));
            if (uploaded.some((u) => !refIds.includes(u))) bad.push(`uploads [${uploaded.join(", ")}]`);
            if (lay) {
                const inOrder = numberedOf(lay).map((x) => { const at = picturesAt(shot, x.field, fx); return at && at.length === 1 ? at[0].id : `?${x.field}`; });
                if (!eq(inOrder, refIds)) bad.push(`by the layout's fields the request holds [${inOrder.join(", ")}]`);
            }
            const keys = new Set();
            (function keysOf(v) { if (v == null || typeof v !== "object" || Buffer.isBuffer(v) || v instanceof Uint8Array) return; for (const [k, x] of Object.entries(v)) { keys.add(k); keysOf(x); } })(shot.request);
            const maskKeys = [...keys].filter((k) => /^mask/i.test(k));
            if (maskKeys.length) bad.push(`mask fields [${maskKeys.join(", ")}]`);
            // no edit sentence, the asked shape
            const all = stringsIn(shot.request);
            const edits = all.filter((t) => /\bEdit (?:the|this|image|Image|<image)/.test(t));
            if (edits.length) bad.push(`an edit sentence: ${short(edits[0])}`);
            const shape = [];
            (function shapeOf(v) {
                if (v == null || typeof v !== "object" || Buffer.isBuffer(v) || v instanceof Uint8Array) return;
                if (!Array.isArray(v) && typeof v.width === "number" && typeof v.height === "number") shape.push(["width x height", `${v.width}x${v.height}`]);
                for (const [k, x] of Object.entries(v)) { if (/^(size|aspect_ratio|aspectRatio|image_size)$/.test(k)) shape.push([k, x]); else shapeOf(x); }
            })(shot.request);
            // the asked pixels (1344 x 768), a size of the asked aspect picked from it (ModelArk), or the aspect by name
            // a route with an area range (`text.refs.options.pixels`, fal Seedream 5) gets the asked shape inside it
            const px = req.options && Array.isArray(req.options.pixels) ? req.options.pixels : null;
            const is169 = ([k, v]) => {
                if (v && typeof v === "object" && px) return v.width % 16 === 0 && v.height % 16 === 0 && v.width * v.height >= px[0] && v.width * v.height <= px[1] && Math.abs(v.width / v.height - 16 / 9) < 0.04;
                if (v && typeof v === "object") return v.width === 1344 && v.height === 768;
                const t = String(v), m = /^(\d+)\s*[x*]\s*(\d+)$/.exec(t);
                if (m) return (+m[1] === 1344 && +m[2] === 768) || (k !== "width x height" && Math.abs(+m[1] / +m[2] - 16 / 9) < 0.01);
                return /^(16:9|widescreen_16_9)$/.test(t);
            };
            const auto = shape.filter(([, v]) => typeof v === "string" && /^(auto|match_input_image)/i.test(v));
            if (auto.length) bad.push(`sends ${short(auto)}`);
            const NO_SHAPE = /^(flux2_(pro|flex|max|klein)|seedream_5_lite|qwen_image_edit)\/wavespeed$|^grok_imagine\/oxen$/;
            if (NO_SHAPE.test(name)) { tally.noShape++; if (shape.length) bad.push(`on the no-shape list, yet it sends ${short(shape)}`); }
            else if (!shape.some(is169)) bad.push(`the asked 16:9 at 1344 x 768 is not in ${short(shape)}`);
            // the instruction sentence where the route writes one, the prompt as given where it does not
            const SENTENCE = new Set(["gemini", "openrouter", "ark", "oxen", "magnific", "comfypartner", "comfyrouter:vertexai", "comfyrouter:byteplus", "comfyrouter:qwen"]);
            const sent = [...new Set(stringsWith(shot.request, req.prompt))];
            // a variant whose prompt goes as written (FLUX 3 on OpenRouter, options.prompt "as_written") writes none
            const writes = SENTENCE.has(key) && !(req.options && req.options.prompt === "as_written");
            const wantText = writes && lay ? refs.instruction(req, lay, req.prompt) : req.prompt;
            if (writes) tally.sentence++;
            if (!eq(sent, [wantText])) bad.push(`the prompt goes as ${short(sent)}, not ${JSON.stringify(wantText)}`);
            if (!writes && all.some((t) => /reference image/.test(t))) bad.push("a reference sentence on a route that writes none");
            if (/^(gemini|comfyrouter:vertexai)$/.test(key) && lay) {
                tally.parts++;
                const pat = patternOfReq(req);
                const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
                const want = ["text", ...(n > 1 ? refIds.flatMap((id, k) => [`${cap(refs.nameOf(pat, k + 1))}:`, id]) : refIds)];
                const got = partsAsIds(shot.request.contents[0].parts, fx, shot);
                if (!eq(got, want)) bad.push(`parts [${got.join(", ")}], not [${want.join(", ")}]`);
            }
            // the cap: the text route's is the edit route's (the crop's slot becomes a reference slot), text.refs.max
            // lowers it, max + 1 is refused by index.js before the adapter and any request, max goes out
            if (typeof p.layout === "function" && s.variant.edit !== false) {
                const es = { recipe: s.recipe, provider: s.provider, variant: s.variant, channel: s.channel };
                const e0 = requestFor(es, fixturesFor(s.provider, s.variant.model, 0, 0));
                let editMax;
                try { editMax = p.layout({ ...e0 }).max; } catch (err) { editMax = `threw: ${err.message}`; }
                if (editMax !== own) bad.push(`the text route's max is ${own}, the edit layout's ${editMax}`);
            }
            const shapeReq = { provider: s.provider, model: req.model, kind: "text", fields: req.fields, options: req.options, params: req.params, count: 1, refName: req.refName, refsMax: req.refsMax };
            const central = (await idx.layout(shapeReq)).max;
            const wantMax = tr.max ? (own == null ? tr.max : Math.min(own, tr.max)) : own;
            if (central !== wantMax) bad.push(`index.js's max is ${central}, not ${wantMax} (route ${own}, text.refs.max ${tr.max})`);
            if (central == null) {
                tally.uncapped++;
                if (!UNDOCUMENTED[name] || UNDOCUMENTED[name].max !== null) bad.push("no max, and not on the undocumented list");
            } else {
                tally.capped++;
                const over = textRequestFor(s, central + 1).req;
                const x = await viaIndex(over, [s.provider]);
                const words = `${p.label} ${over.model} takes at most ${central} reference picture${central === 1 ? "" : "s"} for a new image; this run has ${central + 1}: hide reference layers.`;
                if (x.err !== words || x.calls.adapter || x.calls.fetch) bad.push(`max + 1 (${central + 1}) through index.js: ${x.err} (adapter ${x.calls.adapter}, fetch ${x.calls.fetch})`);
                const at = textRequestFor(s, central);
                const atShot = await capture(p, at.req, "generate");
                const atIds = atShot.request ? picturesIn(atShot, at.fx).map((f) => f.id) : null;
                if (!atIds || atIds.length !== central) bad.push(`at max (${central}) the builder sent ${atIds ? atIds.length + " pictures" : "nothing: " + atShot.error}`);
            }
            check(`${name}: ${n} reference${n === 1 ? "" : "s"} to ${url.replace(LOOP, "<test host>")}${central != null ? `, max ${central}` : ", no max"}`, !bad.length, (VERBOSE ? bad : bad.slice(0, 3)).join(" | ") + (!VERBOSE && bad.length > 3 ? ` (+${bad.length - 3} more)` : ""));
            if (VERBOSE) console.log("   " + JSON.stringify(redacted(shot.request, fx, shot)));
        }
        const DIALECTS = ["openai", "vertexai", "bfl", "byteplus", "qwen"].map((d) => `comfyrouter:${d}`);
        const ADAPTERS = ["toapis", "bfl", "fal", "replicate", "wavespeed", "openai", "gemini", "openrouter", "ark", "oxen", "magnific", "comfypartner"];
        const missing = [...ADAPTERS, ...DIALECTS].filter((k) => !tally.routes.has(k));
        check(`the text runs covered ${tally.variants} variants: every adapter and every Comfy Router dialect with a text route (${tally.routes.size}); ${tally.capped} capped, ${tally.uncapped} uncapped; ${tally.sentence} with the reference sentence, ${tally.parts} with label parts, ${tally.noShape} with no shape field`, !missing.length && tally.variants >= 90, missing.length ? "none for " + missing.join(", ") : short({ ...tally, routes: [...tally.routes] }));

        // 0 references: today's request, the new request shape (refName, refsMax) changing nothing; against the adapters
        // of the last commit before 26f too, when git has it
        const BEFORE_26F = "a608e8d";
        let before = null, why = "";
        // a recipe added after 26f (FLUX 3, docs/PLAN_FLUX3.md) has no request of before to compare with
        let oldRecipes = null;
        const { execFileSync } = require("node:child_process");
        const os = require("node:os");
        let dir = null;
        try {
            const names = execFileSync("git", ["-C", ROOT, "ls-tree", "--name-only", `${BEFORE_26F}:electron/main/providers`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).filter((f) => f.endsWith(".js"));
            dir = fs.mkdtempSync(path.join(os.tmpdir(), "refs-layout-before-26f-"));
            for (const f of names) fs.writeFileSync(path.join(dir, f), execFileSync("git", ["-C", ROOT, "show", `${BEFORE_26F}:electron/main/providers/${f}`], { stdio: ["ignore", "pipe", "ignore"] }));
            before = (id) => require(path.join(dir, id + ".js"));
            oldRecipes = new Set(execFileSync("git", ["-C", ROOT, "ls-tree", "--name-only", `${BEFORE_26F}:recipes`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")));
        } catch (err) { why = String(err && err.message || err).split(/\r?\n/)[0]; }
        const reset = (m) => { if (m && typeof m._resetHosts === "function") m._resetHosts(); };
        /** Where two values differ: "path: a -> b" per leaf (a Buffer is a leaf). */
        const diffPaths = (a, b, at = "", out = []) => {
            const leaf = (v) => v == null || typeof v !== "object" || Buffer.isBuffer(v) || v instanceof Uint8Array;
            if (leaf(a) || leaf(b) || Array.isArray(a) !== Array.isArray(b)) { if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${at || "(top)"}: ${short(a)} -> ${short(b)}`); return out; }
            for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], at ? `${at}.${k}` : k, out);
            if (!Array.isArray(a) && !eq(Object.keys(a), Object.keys(b)) && !out.length) out.push(`${at || "(top)"}: key order ${short(Object.keys(a))} -> ${short(Object.keys(b))}`);
            return out;
        };
        const calls = (x) => x.calls.filter((c) => !c.startsWith("GET"));
        /** What differs between two captures (the URL, the POSTs, the error, the body), [] when nothing. */
        const differs = (a, b) => [...(a.url !== b.url ? [`url: ${a.url} -> ${b.url}`] : []), ...(!eq(calls(a), calls(b)) ? [`calls: ${short(calls(a))} -> ${short(calls(b))}`] : []), ...(a.error !== b.error ? [`error: ${a.error} -> ${b.error}`] : []), ...diffPaths(a.request, b.request)];
        // the one change 26f makes to a text run without references (docs/BUGS.md, found in 26f): Replicate sends the
        // asked aspect where a fixed "match_input_image" went before, which made every such run follow no picture at all
        // and since 0.1.36 Gemini direct sends the asked aspect where the Aspect row's "auto" sent none (docs/BUGS.md)
        const FIXED_IN_26F = (s, d) => (s.provider === "replicate" && /^input\.aspect_ratio: match_input_image -> (?!match_input_image$)\d+:\d+$/.test(d))
            || (s.provider === "gemini" && /^generationConfig\.imageConfig(\.aspectRatio: undefined -> \d+:\d+|: undefined -> \{"aspectRatio":"\d+:\d+"\})$/.test(d));
        const zero = { shapes: 0, sameShape: [], sameBefore: [], fixed: 0 };
        const zeroShape = async (s, extra) => {
            const name = `${labelOf(s)}${extra.aspect === null ? " (a free size)" : ""}`;
            const p = adapter(s.provider);
            const now = textRequestFor(s, 0, extra).req;
            // what index.js handed an adapter before 26f: references [], original 0, the default refName, no refsMax
            const old = { ...now, refName: refs.REF_NAME_DEFAULT };
            delete old.refsMax;
            zero.shapes++;
            reset(p);
            const a = await capture(p, now, "generate");
            reset(p);
            const b = await capture(p, old, "generate");
            const d1 = differs(b, a);
            if (d1.length) zero.sameShape.push(`${name}: ${d1.join("; ")}`);
            if (!before || (oldRecipes && !oldRecipes.has(s.recipe))) return;
            const q = before(s.provider);
            reset(p); reset(q);
            const c = await capture(q, old, "generate");
            const d2 = differs(c, a);
            const fixed = d2.filter((d) => FIXED_IN_26F(s, d));
            if (fixed.length) zero.fixed++;
            if (d2.length > fixed.length) zero.sameBefore.push(`${name}: ${d2.filter((d) => !FIXED_IN_26F(s, d)).join("; ")}`);
        };
        try {
            for (const s of TEXT) for (const extra of [{}, { aspect: null, width: 1536, height: 1024 }]) await zeroShape(s, extra);
        } finally { if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
        check(`0 references: every text variant's request (${zero.shapes} shapes, ${TEXT.length} variants with a text route) is the same with the new request fields (refName, refsMax) as without`, !zero.sameShape.length, zero.sameShape.slice(0, 3).join(" | "));
        if (before) check(`0 references: every text variant's request is byte for byte what the adapters of ${BEFORE_26F} (before 26f) sent, but the asked aspect on ${zero.fixed} shapes (Replicate's match_input_image, the fix of 26f; Gemini's \"auto\", 0.1.36)`, !zero.sameBefore.length && zero.fixed > 0, zero.sameBefore.slice(0, 3).join(" | ") + (zero.sameBefore.length > 3 ? ` (+${zero.sameBefore.length - 3} more)` : ""));
        else console.log(`[skip] 0 references against ${BEFORE_26F}: ${why}`);
        // Gemini direct with the Aspect row at its default "auto": the asked aspect goes, an Aspect row set wins over it
        for (const s of TEXT.filter((x) => x.provider === "gemini")) {
            const p = adapter("gemini");
            const ask = async (params) => { const { req } = textRequestFor(s, 0); const r = await capture(p, { ...req, params: { ...req.params, ...params } }, "generate"); return r.request && r.request.generationConfig.imageConfig || {}; };
            const auto = await ask({ aspect_ratio: "auto" }), set = await ask({ aspect_ratio: "3:2" });
            check(`${labelOf(s)}, 0 references, Aspect "auto": the asked 16:9 is sent; Aspect 3:2 is sent as 3:2`, auto.aspectRatio === "16:9" && set.aspectRatio === "3:2", short([auto, set]));
        }

        // a marker in a text prompt through index.js on shipped variants: the route's name for that picture, res.refs
        const answer = { "/api/v1/images": () => json(200, { data: [{ b64_json: RESULT.toString("base64"), media_type: "image/png" }] }), "/api/ai/images/edit": () => json(200, { images: [{ b64_json: RESULT.toString("base64") }] }) };
        for (const [recipe, provider, names, field] of [["gpt_image_2", "openrouter", ["Image 1", "Image 2"], "input_references"], ["qwen_image_2_1", "oxen", ["<image1>", "<image2>"], "input_images"]]) {
            const s = TEXT.find((x) => x.recipe === recipe && x.provider === provider);
            if (!s) { check(`${recipe}/${provider}: a shipped text variant`, false); continue; }
            const bodies = [];
            FETCH = async (url, init = {}) => {
                const u = new URL(String(url));
                if (u.pathname === "/api/v1/providers") return json(200, { data: [] });
                if (answer[u.pathname]) { bodies.push(JSON.parse(init.body)); return answer[u.pathname](); }
                return json(404, { error: { message: "no route" } });
            };
            reset(adapter(provider));
            const { req } = textRequestFor(s, 2, { prompt: "the jacket of {@ref:1} on the person of {@ref:0}" });
            let x;
            try { x = await viaIndex(req); } finally { FETCH = null; }
            const resolved = `the jacket of ${names[1]} on the person of ${names[0]}`;
            const body = bodies[0];
            const sentence = refs.instruction({ kind: "text", refName: req.refName, references: [0, 1], original: 0 }, refs.layoutOf({ seq: [["reference", "a", 0], ["reference", "b", 1]] }), resolved);
            check(`${recipe}/${provider} through index.js: {@ref:1} and {@ref:0} in a text prompt with 2 references become "${names[1]}" and "${names[0]}", res.refs says so, the body carries the sentence and both pictures in ${field}`, !x.err && x.out.prompt === resolved && eq(x.out.refs, [{ ref: 1, name: names[1] }, { ref: 0, name: names[0] }]) && !!body && body.prompt === sentence && !/\{@ref|@img/.test(body.prompt) && Array.isArray(body[field]) && body[field].length === 2 && eq(x.out.notes, []), x.err || short({ prompt: x.out.prompt, refs: x.out.refs, body: body && body.prompt, pictures: body && Array.isArray(body[field]) ? body[field].length : null }));
        }
        // the review of 26f: a free size on fal's Nano Banana edit routes goes as the closest of the model's ratios
        // (text.refs.options.aspect_ratios), not in the first reference's shape; without references nothing changes
        for (const recipe of ["nano_banana_2", "nano_banana_pro"]) {
            const s = textShapesOf().find((x) => x.recipe === recipe && x.provider === "fal");
            if (!s) { check(`${recipe}/fal: a shipped text variant`, false); continue; }
            const one = await capture(adapter("fal"), textRequestFor(s, 1, { aspect: null, width: 1536, height: 1024 }).req, "generate");
            const none = await capture(adapter("fal"), textRequestFor(s, 0, { aspect: null, width: 1536, height: 1024 }).req, "generate");
            check(`${recipe}/fal: a free 1536 x 1024 with a reference asks for aspect_ratio 3:2; without references no aspect_ratio goes`, !!one.request && one.request.aspect_ratio === "3:2" && !!none.request && !("aspect_ratio" in none.request), short({ with: one.request && one.request.aspect_ratio, without: none.request && none.request.aspect_ratio, err: one.error || none.error }));
        }
    });

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + (err && err.stack || err)); console.log("FAIL"); process.exit(1); });
