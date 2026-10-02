// Ideogram 4.5 on Replicate and on WaveSpeedAI (recipes/ideogram_4_5.json through electron/main/providers/replicate.js
// and electron/main/providers/wavespeed.js), in plain Node, no Electron, no key and no network:
//   node tools/ideogram45_test.js
// Replicate (sections 0-6): a scripted fetch plays api.replicate.com (the prediction POST answers "succeeded" at once,
// so nothing polls) and replicate.delivery (the output download). The pictures are small (64 x 48), so every picture
// goes as a data URI and is read back from the request body.
// WaveSpeed (sections 7-13): a scripted fetch plays api.wavespeed.ai (the upload tickets, the binary upload, the submit,
// which answers "completed" at once, so nothing polls), the presigned PUT host and the CDN (the output download); each
// download_url maps back to the bytes PUT, so the picture in image, mask_url and reference_images[i] is read back.
// A fake codec stands in for Electron's nativeImage (bitmap / fromBitmap): its "PNG" is a real signature and IHDR
// followed by the raw RGBA, so the inverted mask is checked pixel for pixel.
// The light tier (CLAUDE.md "Working rules"): the request shapes the recipe's variants send, written from Replicate's and
// WaveSpeed's schemas (docs/PLAN_IDEOGRAM45.md), never run against the live APIs. Sections 6 and 13 hold other variants
// of each provider (FLUX.1 Fill, Nano Banana 2) to what they sent before the Ideogram options existed.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const PROV = path.join(ROOT, "electron", "main", "providers");
const rep = require(path.join(PROV, "replicate.js"));
const ws = require(path.join(PROV, "wavespeed.js"));
const refs = require(path.join(PROV, "refs.js"));

const KEY = "r8_test0123456789abcdef0123456789";   // the shape of a Replicate token; never a real one
const API = "https://api.replicate.com/v1";
const OUT_URL = "https://replicate.delivery/x.png";
const ALL_CALLS = [];   // Replicate's
const ERRORS = [];

const WS_KEY = "0123456789abcdef".repeat(4);        // the shape of a WaveSpeed key (64 hex digits); never a real one
const WS_API = "https://api.wavespeed.ai/api/v3/";
const WS_PUT = "https://put.wavespeed.test/";       // the presigned upload host the ticket names
const WS_CDN = "https://cdn.wavespeed.test/";       // download_url of an upload, and the output
const WS_OUT = WS_CDN + "out/x.png";
const WS_CALLS = [];
const WS_STRAYS = [];   // calls the fake WaveSpeed does not play (answered 404)
const WS_ERRORS = [];

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 500 ? s.slice(0, 500) + " ..." : s; };
async function section(name, fn) {
    console.log(`\n--- ${name} ---`);
    try { await fn(); } catch (err) { check(`${name}: ran through`, false, err && err.stack || String(err)); }
}

// ---- pictures: the fake codec (IHDR + raw RGBA), as tools/magnific_test.js has it ----------------------------------

function header(w, h, len, colour = 6) {
    const b = Buffer.alloc(len, 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    b[24] = 8;
    b[25] = colour;
    return b;
}
const sizeOf = (b) => (b && b.length >= 24 && b[0] === 0x89 ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null);
function rawPng(w, h, rgba) {
    const b = header(w, h, 33 + w * h * 4);
    Buffer.from(rgba.buffer ? Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength) : rgba).copy(b, 33);
    return b;
}
const codec = {
    bitmap(png) {
        const b = Buffer.from(png), s = sizeOf(b);
        if (!s || b.length !== 33 + s[0] * s[1] * 4) return null;
        return { width: s[0], height: s[1], data: b.subarray(33) };
    },
    fromBitmap(bm) { return rawPng(bm.width, bm.height, bm.data); },
};
/** A grey picture of the fake codec: fn(x, y) -> 0..255 (the mask's selection value, Scumble's white = repaint). */
function greyOf(w, h, fn) {
    const d = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = fn(x, y), j = (y * w + x) * 4; d[j] = v; d[j + 1] = v; d[j + 2] = v; d[j + 3] = 255; }
    return { width: w, height: h, data: d };
}
const maskPng = (w, h, fn) => codec.fromBitmap(greyOf(w, h, fn));
const imagePng = (w, h, k = 7) => codec.fromBitmap(greyOf(w, h, (x, y) => (x * k + y * 13) & 255));

const W = 64, H = 48;
const RECT = (x, y) => (x >= 16 && x < 40 && y >= 12 && y < 30 ? 255 : 0);   // the selection: a rectangle
const RAMP = (x) => Math.min(255, x * 4);                                    // 124 at x = 31, 128 at x = 32
const IMAGE = imagePng(W, H);
const RECT_MASK = maskPng(W, H, RECT);
const REF = [3, 5, 9, 11].map((k) => imagePng(32, 24, k));                   // four distinct reference layers
const RESULT = imagePng(8, 8, 17);

/** The bytes of a data URI the adapter sent, or null. */
const fromUri = (s) => { const m = /^data:image\/png;base64,(.*)$/s.exec(String(s)); return m ? Buffer.from(m[1], "base64") : null; };
const sameBytes = (uri, buf) => { const b = fromUri(uri); return !!b && Buffer.compare(b, Buffer.from(buf)) === 0; };
/** The bytes of a sent picture: a data URI (Replicate) or the bytes themselves (an upload the fake WaveSpeed kept). */
const bytesOf = (sent) => (Buffer.isBuffer(sent) ? sent : fromUri(sent));
/** [r, g, b, a] of a sent mask at (x, y). */
function pixel(sent, x, y) {
    const bm = codec.bitmap(bytesOf(sent) || Buffer.alloc(0));
    if (!bm) return null;
    const j = (y * bm.width + x) * 4;
    return [...bm.data.subarray(j, j + 4)];
}
/** null when the sent mask is Ideogram's inversion of fn (channel 0 >= 128 black, else white, opaque), else where not. */
function notInverted(sent, w, h, fn) {
    const bm = codec.bitmap(bytesOf(sent) || Buffer.alloc(0));
    if (!bm || bm.width !== w || bm.height !== h) return `size ${bm ? bm.width + "x" + bm.height : "unreadable"}`;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const want = fn(x, y) >= 128 ? 0 : 255, j = (y * w + x) * 4;
            if (bm.data[j] !== want || bm.data[j + 1] !== want || bm.data[j + 2] !== want || bm.data[j + 3] !== 255) return `pixel ${x},${y} is ${[...bm.data.subarray(j, j + 4)]} for ${fn(x, y)}`;
        }
    }
    return null;
}

// ---- a fake Replicate ---------------------------------------------------------------------------------------------

function recordHeaders(init) {
    const h = {};
    for (const [k, v] of new Headers((init && init.headers) || {})) h[k.toLowerCase()] = v;
    return h;
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** POST /v1/models/<owner>/<name>/predictions answers a finished prediction, the output URL answers RESULT. */
function fakeServer() {
    const calls = [], posts = [], gets = [], strays = [];
    async function fetch(url, init = {}) {
        const method = String(init.method || "GET").toUpperCase();
        const call = { url: String(url), method, headers: recordHeaders(init) };
        calls.push(call);
        ALL_CALLS.push(call);
        const u = new URL(String(url));
        if (u.origin === "https://api.replicate.com" && method === "POST" && /^\/v1\/models\/[^/]+\/[^/]+\/predictions$/.test(u.pathname)) {
            const body = JSON.parse(init.body);
            posts.push({ ...call, body });
            return json(201, { id: "pred" + posts.length, status: "succeeded", output: [OUT_URL], metrics: {} });
        }
        if (String(url) === OUT_URL && method === "GET") {
            gets.push(call);
            return new Response(RESULT, { status: 200, headers: { "content-type": "image/png" } });
        }
        strays.push(call);
        return json(404, { detail: `not played by this test: ${method} ${url}` });
    }
    return { fetch, calls, posts, gets, strays };
}

async function run(req, more = {}) {
    const s = fakeServer();
    const ctx = { key: KEY, fetch: s.fetch, bitmap: codec.bitmap, fromBitmap: codec.fromBitmap, log: () => {}, ...more };
    let out = null, err = null;
    try { out = await (req.kind === "text" ? rep.generate(req, ctx) : rep.edit(req, ctx)); } catch (e) { err = String((e && e.message) || e); ERRORS.push(err); }
    const post = s.posts[0] || null;
    return { s, out, err, post, body: post && post.body, input: (post && post.body && post.body.input) || {} };
}
const keysOf = (o) => Object.keys(o || {}).sort();

// ---- a fake WaveSpeedAI ---------------------------------------------------------------------------------------------

/**
 * POST /api/v3/media/uploads answers a ticket (a presigned PUT on WS_PUT, a download_url on WS_CDN), the PUT keeps the
 * bytes under that download_url; POST /api/v3/media/upload/binary (the fallback) keeps the multipart `file`; any other
 * POST under /api/v3/ is the submit and answers a finished prediction; WS_OUT answers RESULT. `opt.ticketFails` makes
 * every ticket answer 500.
 */
function fakeWaveSpeed(opt = {}) {
    const calls = [], tickets = [], puts = [], binaries = [], submits = [], gets = [], strays = [];
    const pending = new Map();   // the presigned PUT URL -> its download_url
    const stored = new Map();    // download_url -> { bytes, type, name }
    let k = 0;
    async function fetch(url, init = {}) {
        const method = String(init.method || "GET").toUpperCase();
        const call = { url: String(url), method, headers: recordHeaders(init) };
        calls.push(call);
        WS_CALLS.push(call);
        const u = new URL(String(url));
        const api = u.origin === "https://api.wavespeed.ai" && u.pathname.startsWith("/api/v3/");
        if (api && method === "POST" && u.pathname === "/api/v3/media/uploads") {
            const body = JSON.parse(init.body);
            tickets.push({ ...call, body });
            if (opt.ticketFails) return json(500, { code: 500, message: "the ticket service is down (test)" });
            const n = ++k, put = `${WS_PUT}u${n}?sig=test`, dl = `${WS_CDN}media/u${n}`;
            pending.set(put, { dl, name: body.filename });
            return json(200, { code: 200, message: "success", data: { download_url: dl, upload: { url: put, method: "PUT" } } });
        }
        if (method === "PUT" && pending.has(String(url))) {
            const { dl, name } = pending.get(String(url));
            pending.delete(String(url));
            const bytes = Buffer.from(init.body);
            puts.push({ ...call, bytes, dl });
            stored.set(dl, { bytes, type: call.headers["content-type"] || null, name });
            return new Response(null, { status: 200 });
        }
        if (api && method === "POST" && u.pathname === "/api/v3/media/upload/binary") {
            const file = init.body && typeof init.body.get === "function" ? init.body.get("file") : null;
            const bytes = file ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0);
            const dl = `${WS_CDN}media/b${++k}`;
            binaries.push({ ...call, bytes, name: file && file.name, type: file && file.type, dl });
            stored.set(dl, { bytes, type: file && file.type, name: file && file.name });
            return json(200, { code: 200, message: "success", data: { download_url: dl } });
        }
        if (api && method === "POST" && !u.pathname.startsWith("/api/v3/media/")) {
            const body = JSON.parse(init.body);
            submits.push({ ...call, body });
            const id = "ws" + submits.length;
            return json(200, { code: 200, message: "success", data: { id, model: u.pathname.slice("/api/v3/".length), status: "completed", urls: { get: `${WS_API}predictions/${id}/result` }, outputs: [WS_OUT], timings: { inference: 1234 } } });
        }
        if (String(url) === WS_OUT && method === "GET") {
            gets.push(call);
            return new Response(RESULT, { status: 200, headers: { "content-type": "image/png" } });
        }
        strays.push(call);
        WS_STRAYS.push(call);
        return json(404, { code: 404, message: `not played by this test: ${method} ${url}` });
    }
    /** The bytes an upload kept under a download_url, or null. */
    const at = (dl) => (stored.has(String(dl)) ? stored.get(String(dl)).bytes : null);
    return { fetch, calls, tickets, puts, binaries, submits, gets, strays, stored, at };
}

async function runWs(req, more = {}, opt = {}) {
    const s = fakeWaveSpeed(opt);
    const ctx = { key: WS_KEY, fetch: s.fetch, bitmap: codec.bitmap, fromBitmap: codec.fromBitmap, log: () => {}, ...more };
    let out = null, err = null;
    try { out = await (req.kind === "text" ? ws.generate(req, ctx) : ws.edit(req, ctx)); } catch (e) { err = String((e && e.message) || e); WS_ERRORS.push(err); }
    const sub = s.submits[0] || null;
    return { s, out, err, sub, input: (sub && sub.body) || {} };
}
const sameAs = (a, b) => !!a && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

// ---- the recipes as recipes.js serves them ------------------------------------------------------------------------

let NORMALIZE = null;
function loadRecipe(id) {
    if (!NORMALIZE) {
        const orig = Module._load;
        Module._load = function (request, ...rest) {
            if (request === "electron") return { app: { getPath: () => ROOT } };
            return orig.call(this, request, ...rest);
        };
        try { NORMALIZE = require(path.join(ROOT, "electron", "main", "recipes.js"))._normalize; } finally { Module._load = orig; }
    }
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, "recipes", id + ".json"), "utf8"));
    r.id = r.id || id;
    r.kind = r.kind === "provider" ? "provider" : "comfy";
    return NORMALIZE(r);
}
/** The values the Settings panel starts with, plus the fixed ones (host.js providerParams). */
function defaults(rows, fixed) {
    const p = {};
    for (const s of rows || []) p[s.key] = s.spec[1] && s.spec[1].default !== undefined ? s.spec[1].default : (Array.isArray(s.spec[0]) ? s.spec[0][0] : undefined);
    return { ...p, ...(fixed || {}) };
}
function fillReq(v, extra = {}) {
    return { provider: "replicate", model: v.model, kind: v.input === "fill" ? "fill" : "edit", prompt: "a red door", negative: "", seed: 7, width: W, height: H, aspect: null, image: IMAGE, mask: RECT_MASK, maskAlpha: null, references: [], original: 0, fields: v.fields || null, options: v.options || null, params: defaults(v.settings, v.fixed), ...extra };
}
function textReq(v, extra = {}) {
    return { provider: "replicate", model: v.text.model, kind: "text", prompt: "a lighthouse at dusk", negative: "", seed: 7, width: 1024, height: 1024, aspect: null, image: null, mask: null, maskAlpha: null, references: [], original: 0, fields: v.fields || null, options: v.options || null, params: defaults(v.text.settings, v.text.fixed), ...extra };
}

const wsFill = (v, extra = {}) => fillReq(v, { provider: "wavespeed", ...extra });
const wsText = (v, extra = {}) => textReq(v, { provider: "wavespeed", ...extra });

const EDIT_MODEL = "ideogram-ai/ideogram-4-5-precise-edit";
const TEXT_MODEL = "ideogram-ai/ideogram-4-5";
const WHO = `Replicate ${EDIT_MODEL}`;
const WS_EDIT = "ideogram-ai/ideogram-v4.5/edit";
const WS_TEXT = "ideogram-ai/ideogram-v4.5";
const WS_WHO = `WaveSpeed ${WS_EDIT}`;

async function main() {
    const R = loadRecipe("ideogram_4_5");
    const V = R.providers.replicate;

    // ---- 0. the recipe ----
    await section("0. the recipe", async () => {
        check("ideogram_4_5: a provider recipe, Replicate its default, the variant a fill on the Precise Edit model", R.kind === "provider" && R.default === "replicate" && R.task === "edit" && V.model === EDIT_MODEL && V.input === "fill" && V.edit === true, short({ kind: R.kind, default: R.default, model: V.model, input: V.input }));
        check("fields: image, mask, references as reference_images", eq(V.fields, { image: "image", mask: "mask", references: "reference_images" }), short(V.fields));
        const o = V.options || {};
        check("options: mask black, max_images 4, max_ratio 6, max_bytes 25 MB, seed_max 2147483647, negative false, seven sizes, very_low as low on a text run", o.mask === "black" && o.max_images === 4 && o.max_ratio === 6 && o.max_bytes === 25000000 && o.seed_max === 2147483647 && o.negative === false && eq(o.sizes, ["1024x1024", "1280x896", "896x1280", "1344x768", "768x1344", "1536x640", "640x1536"]) && eq(o.text_values, { quality: { very_low: "low" } }), short(o));
        check("the text shape: the ideogram-4-5 model, the edit's fixed num_images 1 and its Quality row (default medium)", V.text && V.text.model === TEXT_MODEL && eq(V.text.fixed, { num_images: 1 }) && eq(defaults(V.text.settings, V.text.fixed), { quality: "medium", num_images: 1 }), short(V.text));
        check("limits: the recipe's ratio 6 (1:6 .. 6:1) on the variant, the default 2048 / 256 / 16 kept", V.limits && V.limits.ratio === 6 && V.limits.max === 2048 && V.limits.min === 256 && V.limits.step === 16, short(V.limits));
        check("the edit's Settings values: quality medium, num_images 1", eq(defaults(V.settings, V.fixed), { quality: "medium", num_images: 1 }), short(defaults(V.settings, V.fixed)));
    });

    // ---- 1. a fill ----
    await section("1. a fill", async () => {
        const req = fillReq(V, { negative: "blurry, low quality", seed: 7 });
        const x = await run(req);
        check("one POST to /v1/models/ideogram-ai/ideogram-4-5-precise-edit/predictions, then the output's download, nothing else", !x.err && x.s.posts.length === 1 && x.post.url === `${API}/models/${EDIT_MODEL}/predictions` && x.s.gets.length === 1 && x.s.calls.length === 2 && !x.s.strays.length, x.err || short(x.s.calls.map((c) => `${c.method} ${c.url}`)));
        check("the body is { input } alone (a versionless model: no version)", !x.err && eq(keysOf(x.body), ["input"]), short(keysOf(x.body)));
        check("the input holds prompt, seed, image, mask, quality and num_images, nothing else", !x.err && eq(keysOf(x.input), ["image", "mask", "num_images", "prompt", "quality", "seed"]), short(keysOf(x.input)));
        check("no negative_prompt although the request has a negative (options.negative false)", !x.err && !("negative_prompt" in x.input), short(x.input.negative_prompt));
        check("no size, no aspect_ratio, no output_format on an edit", !x.err && !("size" in x.input) && !("aspect_ratio" in x.input) && !("output_format" in x.input), short(keysOf(x.input)));
        check("the prompt as written, quality medium, num_images 1, seed 7", x.input.prompt === "a red door" && x.input.quality === "medium" && x.input.num_images === 1 && x.input.seed === 7, short({ ...x.input, image: undefined, mask: undefined }));
        check("the image is the crop as sent, byte for byte, as a PNG data URI", sameBytes(x.input.image, IMAGE), short(String(x.input.image).slice(0, 40)));
        const bad = notInverted(x.input.mask, W, H, RECT);
        check("the mask is Scumble's inverted, every pixel: the selected rectangle black (edit), the rest white, opaque", !x.err && bad === null, bad);
        check("... spot pixels: (16,12) and (39,29) black, (15,12), (40,29), (0,0) and (63,47) white", eq(pixel(x.input.mask, 16, 12), [0, 0, 0, 255]) && eq(pixel(x.input.mask, 39, 29), [0, 0, 0, 255]) && eq(pixel(x.input.mask, 15, 12), [255, 255, 255, 255]) && eq(pixel(x.input.mask, 40, 29), [255, 255, 255, 255]) && eq(pixel(x.input.mask, 0, 0), [255, 255, 255, 255]) && eq(pixel(x.input.mask, 63, 47), [255, 255, 255, 255]), short([pixel(x.input.mask, 16, 12), pixel(x.input.mask, 15, 12)]));
        check("... and it is not the mask as given", !sameBytes(x.input.mask, RECT_MASK));
        const y = await run(fillReq(V, { mask: maskPng(W, H, RAMP) }));
        const badRamp = notInverted(y.input.mask, W, H, RAMP);
        check("a grey ramp: 128 and above black, below white (x = 31 at 124 white, x = 32 at 128 black)", !y.err && badRamp === null && eq(pixel(y.input.mask, 31, 0), [255, 255, 255, 255]) && eq(pixel(y.input.mask, 32, 0), [0, 0, 0, 255]), y.err || badRamp);
        check("the answer: the downloaded picture, the model and the prediction id in info, no info.mask for a partial selection", !x.err && Buffer.compare(Buffer.from(x.out.bytes), RESULT) === 0 && x.out.mime === "image/png" && x.out.info.model === EDIT_MODEL && x.out.info.id === "pred1" && !("mask" in x.out.info), x.err || short(x.out && x.out.info));
        check("the POST carries the token, JSON and Prefer: wait=30; the download carries no token", x.post.headers.authorization === "Bearer " + KEY && x.post.headers["content-type"] === "application/json" && x.post.headers.prefer === "wait=30" && x.s.gets.length === 1 && !("authorization" in x.s.gets[0].headers), short([x.post.headers, x.s.gets[0] && x.s.gets[0].headers]));
    });

    // ---- 2. a selection over the whole crop, and one with nothing to edit ----
    await section("2. whole and empty selections", async () => {
        let x = await run(fillReq(V, { mask: maskPng(W, H, () => 255) }));
        check("the mask all 255 (the whole crop selected): sent without a mask key, the crop still goes", !x.err && !("mask" in x.input) && sameBytes(x.input.image, IMAGE) && x.s.posts.length === 1, x.err || short(keysOf(x.input)));
        check("... and the answer's info.mask says so", !x.err && x.out.info.mask === "none: the selection covers the whole crop, so the whole crop was edited", short(x.out && x.out.info));
        x = await run(fillReq(V, { mask: maskPng(W, H, (xx) => (xx === 0 ? 128 : 255)) }));
        check("a mask at 128 or more everywhere also counts as the whole crop (no mask key)", !x.err && !("mask" in x.input) && /^none: /.test(x.out.info.mask || ""), x.err || short(keysOf(x.input)));
        x = await run(fillReq(V, { mask: maskPng(W, H, () => 0) }));
        check("the mask all 0: refused in words, no fetch at all", x.err === `${WHO}: the selection holds no pixel at half strength or more, so the model would have nothing to edit. Select the area to change.` && x.s.calls.length === 0, x.err);
        x = await run(fillReq(V, { mask: maskPng(W, H, () => 127) }));
        check("the mask all 127 (under half strength): refused the same way, no fetch", /holds no pixel at half strength or more/.test(x.err || "") && x.s.calls.length === 0, x.err);
        x = await run(fillReq(V, { mask: maskPng(32, H, () => 255) }));
        check("a mask of another size than the crop: refused, no fetch", x.err === `${WHO}: the mask is 32 × 48 and the picture 64 × 48; Ideogram takes a mask of the picture's own size.` && x.s.calls.length === 0, x.err);
    });

    // ---- 2b. the crop's shape and the bytes of each picture, before any upload ----
    await section("2b. shape and bytes", async () => {
        const strip = (w, h) => fillReq(V, { image: imagePng(w, h), mask: maskPng(w, h, (xx) => (xx < 8 ? 255 : 0)), width: w, height: h });
        let x = await run(strip(64, 8));
        check("a crop of 64 x 8 (8:1) is refused before any request", x.err === `${WHO} takes pictures no steeper than 6:1; the crop is 64 × 8, and the picture is too narrow to widen it. Nothing was sent.` && x.s.calls.length === 0, x.err);
        x = await run(strip(8, 64));
        check("... and 8 x 64 (1:8) too", /no steeper than 6:1; the crop is 8 × 64/.test(x.err || "") && x.s.calls.length === 0, x.err);
        x = await run(strip(60, 10));
        check("a crop of 60 x 10 (6:1) goes", !x.err && x.s.posts.length === 1, x.err);
        const small = { ...V.options, max_bytes: IMAGE.length - 1 };
        const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
        const asJpeg = (uri) => { const m = /^data:image\/jpeg;base64,(.*)$/s.exec(String(uri)); return m ? Buffer.from(m[1], "base64") : null; };
        x = await run(fillReq(V, { options: small, references: [REF[0]] }), { opaque: () => true, toJpeg: () => JPEG });
        check("an opaque crop and mask over max_bytes go as JPEG data URIs, a reference under it as PNG", !x.err && Buffer.compare(asJpeg(x.input.image) || Buffer.alloc(0), JPEG) === 0 && Buffer.compare(asJpeg(x.input.mask) || Buffer.alloc(0), JPEG) === 0 && sameBytes(x.input.reference_images[0], REF[0]), x.err || short({ image: String(x.input.image).slice(0, 30), mask: String(x.input.mask).slice(0, 30) }));
        x = await run(fillReq(V, { options: small }), { opaque: () => false, toJpeg: () => JPEG });
        check("a crop with transparency over max_bytes is refused in words, no fetch", x.err === `${WHO}: the crop is ${(IMAGE.length / 1e6).toFixed(1)} MB, more than the 0 MB a picture may have (it has transparency, so it stays PNG). Set Highres fix lower or use a smaller reference layer. Nothing was sent.` && x.s.calls.length === 0, x.err);
        const BIG = imagePng(80, 60);   // larger than the crop, so only the reference trips the cap
        x = await run(fillReq(V, { options: { ...V.options, max_bytes: IMAGE.length }, references: [BIG] }), { opaque: () => true, toJpeg: () => Buffer.alloc(BIG.length) });
        check("a reference still over max_bytes as JPEG is refused, naming it, no fetch", /the reference picture 1 is .* MB, more than the .* MB a picture may have even as JPEG/.test(x.err || "") && x.s.calls.length === 0, x.err);
    });

    // ---- 3. the seed ----
    await section("3. the seed", async () => {
        let x = await run(fillReq(V, { seed: 4000000000 }));
        check("seed 4000000000 goes as 4000000000 % 2147483648 = 1852516352", !x.err && x.input.seed === 4000000000 % 2147483648 && x.input.seed === 1852516352, short(x.input.seed));
        check("... and the answer reports the seed sent", !x.err && x.out.seed === 1852516352, short(x.out && x.out.seed));
        x = await run(fillReq(V, { seed: 2147483647 }));
        const y = await run(fillReq(V, { seed: 2147483648 }));
        check("2147483647 stays, 2147483648 wraps to 0", x.input.seed === 2147483647 && y.input.seed === 0, short([x.input.seed, y.input.seed]));
        x = await run(fillReq(V, { seed: 4000000000, params: { ...defaults(V.settings, V.fixed), random_seed: true } }));
        check("params.random_seed true: no seed and no random_seed key", !x.err && !("seed" in x.input) && !("random_seed" in x.input) && x.input.quality === "medium", x.err || short(keysOf(x.input)));
    });

    // ---- 4. reference layers ----
    await section("4. references", async () => {
        let x = await run(fillReq(V));
        check("no reference layer: no reference_images key", !x.err && !("reference_images" in x.input), short(keysOf(x.input)));
        x = await run(fillReq(V, { references: [REF[0], REF[1]] }));
        const list = x.input.reference_images;
        check("2 references: reference_images of 2 data URIs in order, the crop still in image, the mask still inverted", !x.err && Array.isArray(list) && list.length === 2 && sameBytes(list[0], REF[0]) && sameBytes(list[1], REF[1]) && sameBytes(x.input.image, IMAGE) && notInverted(x.input.mask, W, H, RECT) === null, x.err || short(Array.isArray(list) ? list.map((s) => String(s).slice(0, 30)) : list));
        x = await run(fillReq(V, { references: REF.slice(0, 3) }));
        check("3 references (crop + 3 = 4, the cap): all three go", !x.err && x.input.reference_images.length === 3 && sameBytes(x.input.reference_images[2], REF[2]), x.err);
        x = await run(fillReq(V, { references: REF.slice(0, 4) }));
        check("4 references (crop + 4 = 5 > max 4): refused before any fetch", x.err === `${WHO} takes at most 4 pictures; this run has 5: hide reference layers or turn Original off.` && x.s.calls.length === 0, x.err);
        x = await run(fillReq(V, { references: REF.slice(0, 4), mask: maskPng(W, H, () => 0) }));
        check("... the count is refused before the mask is read (4 references and an empty mask: the count's message)", /takes at most 4 pictures; this run has 5/.test(x.err || "") && x.s.calls.length === 0, x.err);

        const req2 = fillReq(V, { references: [REF[0], REF[1]] });
        const lay = rep.layout(req2);
        const pics = lay.pictures.map((p) => [p.role, p.ref === undefined ? null : p.ref, p.field, p.n]);
        check("layout for 2 references: style true, max 4, no drops", lay.style === true && lay.max === 4 && lay.drops === null, short(lay));
        check("... the crop numbered 1 in input.image, the mask in input.mask unnumbered, the references unnumbered in input.reference_images[i]", eq(pics, [["crop", null, "input.image", 1], ["mask", null, "input.mask", null], ["reference", 0, "input.reference_images[0]", null], ["reference", 1, "input.reference_images[1]", null]]), short(pics));
        let ok = true, why = "";
        try { refs.checkLayout(lay, { ...req2, provider: "replicate" }); } catch (e) { ok = false; why = String(e.message); }
        check("... refs.checkLayout accepts it, and it counts 3 pictures (the mask in its own field is not counted)", ok && refs.countOf(lay) === 3, why || String(refs.countOf(lay)));
        let e = null;
        try { refs.checkPictures(lay, { ...req2, prompt: "the hat from {@ref:1}" }, WHO); } catch (err) { e = String(err.message); }
        check("... so a prompt naming a reference is refused by checkPictures (unnumbered references)", /sends reference layers without a number/.test(e || ""), e);
        const lay4 = rep.layout(fillReq(V, { references: REF.slice(0, 4) }));
        check("layout for 4 references counts 5 against max 4 (what index.js refuses before the adapter)", refs.countOf(lay4) === 5 && lay4.max === 4, short([refs.countOf(lay4), lay4.max]));
    });

    // ---- 5. a text run (Generate new) ----
    await section("5. text runs", async () => {
        let x = await run(textReq(V, { aspect: "16:9", width: 2048, height: 1152, negative: "blurry" }));
        check("one POST to /v1/models/ideogram-ai/ideogram-4-5/predictions, then the download", !x.err && x.s.posts.length === 1 && x.post.url === `${API}/models/${TEXT_MODEL}/predictions` && x.s.gets.length === 1 && !x.s.strays.length, x.err || short(x.s.calls.map((c) => `${c.method} ${c.url}`)));
        check("the input holds prompt, seed, quality, num_images and size, nothing else", !x.err && eq(keysOf(x.input), ["num_images", "prompt", "quality", "seed", "size"]), short(keysOf(x.input)));
        check("no image, mask, reference_images, aspect_ratio or negative_prompt", !["image", "mask", "reference_images", "images", "aspect_ratio", "negative_prompt"].some((k) => k in x.input), short(keysOf(x.input)));
        check("aspect 16:9: size 1344x768", x.input.size === "1344x768", short(x.input.size));
        x = await run(textReq(V, { aspect: null, width: 640, height: 1536 }));
        check("no aspect and 640 x 1536: size 640x1536, no aspect_ratio", !x.err && x.input.size === "640x1536" && !("aspect_ratio" in x.input), x.err || short(x.input));
        x = await run(textReq(V, { aspect: "1:1", width: 2048, height: 1152 }));
        check("aspect 1:1 (whatever the size): size 1024x1024", !x.err && x.input.size === "1024x1024" && !("aspect_ratio" in x.input), x.err || short(x.input));
        x = await run(textReq(V, { aspect: "3:2" }));
        const y = await run(textReq(V, { aspect: "9:16" }));
        const z = await run(textReq(V, { aspect: "21:9" }));
        check("aspect 3:2 -> 1280x896, 9:16 -> 768x1344, 21:9 -> 1536x640", x.input.size === "1280x896" && y.input.size === "768x1344" && z.input.size === "1536x640", short([x.input.size, y.input.size, z.input.size]));
        x = await run(textReq(V, { params: { ...defaults(V.text.settings, V.text.fixed), quality: "very_low" } }));
        const hi = await run(textReq(V, { params: { ...defaults(V.text.settings, V.text.fixed), quality: "high" } }));
        const med = await run(textReq(V));
        check("quality very_low goes as low, high stays high, the default medium stays medium", !x.err && x.input.quality === "low" && hi.input.quality === "high" && med.input.quality === "medium", short([x.input.quality, hi.input.quality, med.input.quality]));
        const edit = await run(fillReq(V, { params: { ...defaults(V.settings, V.fixed), quality: "very_low" } }));
        check("... while an edit keeps very_low (text_values is the text run's only)", !edit.err && edit.input.quality === "very_low", short(edit.input.quality));
        x = await run(textReq(V, { seed: 4000000000 }));
        const r = await run(textReq(V, { seed: 4000000000, params: { ...defaults(V.text.settings, V.text.fixed), random_seed: true } }));
        check("the seed held under 2^31 on a text run too (4000000000 -> 1852516352); random_seed sends none", !x.err && x.input.seed === 1852516352 && !("seed" in r.input) && !("random_seed" in r.input), short([x.input.seed, keysOf(r.input)]));
        x = await run(textReq(V, { references: [REF[0], REF[1]] }));
        const lay = rep.textLayout(textReq(V, { references: [REF[0], REF[1]] }));
        check("a text run called directly with 2 references sends no picture (textLayout declares the drop)", !x.err && eq(keysOf(x.input), ["num_images", "prompt", "quality", "seed", "size"]) && typeof lay.drops === "string" && lay.drops.length > 0 && lay.pictures.length === 0, x.err || short({ input: keysOf(x.input), lay }));
    });

    // ---- 6. other Replicate variants unchanged ----
    await section("6. other Replicate variants", async () => {
        const F = loadRecipe("flux1_fill").providers.replicate;
        check("flux1_fill's Replicate variant: a fill without options (so no mask, negative or seed rule of its own)", F.model === "black-forest-labs/flux-fill-pro" && F.input === "fill" && !F.options, short({ model: F.model, input: F.input, options: F.options }));
        let x = await run(fillReq(F, { negative: "blurry", seed: 4000000000 }));
        check("FLUX.1 Fill: POST to /v1/models/black-forest-labs/flux-fill-pro/predictions", !x.err && x.post.url === `${API}/models/black-forest-labs/flux-fill-pro/predictions`, x.err || short(x.post && x.post.url));
        check("... the mask goes exactly as given (not inverted)", sameBytes(x.input.mask, RECT_MASK), short(String(x.input.mask).slice(0, 40)));
        check("... negative_prompt goes, the seed goes uncapped (4000000000), output_format png and its four rows", x.input.negative_prompt === "blurry" && x.input.seed === 4000000000 && x.input.output_format === "png" && x.input.steps === 50 && x.input.guidance === 60 && x.input.safety_tolerance === 2 && x.input.prompt_upsampling === false && !("size" in x.input) && !("reference_images" in x.input), short({ ...x.input, image: undefined, mask: undefined }));
        x = await run(fillReq(F, { mask: maskPng(W, H, () => 255) }));
        check("... a whole-crop mask still goes as given, no info.mask", !x.err && sameBytes(x.input.mask, maskPng(W, H, () => 255)) && !("mask" in x.out.info), x.err || short(x.out && x.out.info));

        const N = loadRecipe("nano_banana_2").providers.replicate;
        check("nano_banana_2's Replicate variant: the text model is google/nano-banana-2, no sizes option", N.text && N.text.model === "google/nano-banana-2" && !(N.options && N.options.sizes), short({ text: N.text, options: N.options }));
        x = await run(textReq(N, { aspect: "16:9", width: 2048, height: 1152, negative: "blurry" }));
        check("Nano Banana 2 text run with aspect 16:9: POST to its model, aspect_ratio 16:9 (not the fixed match_input_image), no size", !x.err && x.post.url === `${API}/models/google/nano-banana-2/predictions` && x.input.aspect_ratio === "16:9" && !("size" in x.input) && x.input.resolution === "2K" && x.input.output_format === "png", x.err || short(x.input));
        check("... no picture field and the seed as given (no seed_max)", !("image_input" in x.input) && !("image" in x.input) && x.input.seed === 7, short(keysOf(x.input)));
        x = await run(textReq(N, { aspect: null, width: 640, height: 1536 }));
        check("Nano Banana 2 text run without an aspect (640 x 1536): the closest aspect preset 9:16, no size", !x.err && x.input.aspect_ratio === "9:16" && !("size" in x.input), x.err || short(x.input));
    });

    // ---- 7. WaveSpeed: the recipe ----
    const WV = R.providers.wavespeed;
    await section("7. WaveSpeed: the recipe", async () => {
        check("ideogram_4_5's WaveSpeed variant: a fill on ideogram-ai/ideogram-v4.5/edit", WV && WV.model === WS_EDIT && WV.input === "fill" && WV.edit === true, short(WV && { model: WV.model, input: WV.input, edit: WV.edit }));
        check("fields: image, the mask as mask_url, references as reference_images", eq(WV.fields, { image: "image", mask: "mask_url", references: "reference_images" }), short(WV.fields));
        const o = WV.options || {};
        check("options: mask black, max_images 4, max_ratio 6, max_bytes 25 MB, negative false, no seed_max and no sizes", o.mask === "black" && o.max_images === 4 && o.max_ratio === 6 && o.max_bytes === 25000000 && o.negative === false && !("seed_max" in o) && !("sizes" in o), short(o));
        check("options.accepts quality and edit_precision; text_accepts quality, aspect_ratio, resolution and enable_prompt_expansion", eq(o.accepts, ["quality", "edit_precision"]) && eq(o.text_accepts, ["quality", "aspect_ratio", "resolution", "enable_prompt_expansion"]), short([o.accepts, o.text_accepts]));
        check("options: the seven aspect presets, tiers 1k 1024 / 2k 2048, very_low as low on a text run", eq(o.aspect_ratios, ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"]) && eq(o.tiers, { "1k": 1024, "2k": 2048 }) && eq(o.text_values, { quality: { very_low: "low" } }), short([o.aspect_ratios, o.tiers, o.text_values]));
        const rows = (WV.settings || []).map((s) => [s.key, s.spec[0], s.spec[1] && s.spec[1].default]);
        check("Settings rows: Quality (very_low .. high, default medium), Edit precision (regular / high, default high)", eq(rows, [["quality", ["very_low", "low", "medium", "high"], "medium"], ["edit_precision", ["regular", "high"], "high"]]), short(rows));
        check("the edit's Settings values: quality medium, edit_precision high, nothing fixed", eq(defaults(WV.settings, WV.fixed), { quality: "medium", edit_precision: "high" }), short([defaults(WV.settings, WV.fixed), WV.fixed]));
        check("the text shape: ideogram-ai/ideogram-v4.5, sizes 1024 and 2048, fixed enable_prompt_expansion false, the edit's two rows, no refs", WV.text && WV.text.model === WS_TEXT && eq(WV.text.sizes, [1024, 2048]) && eq(WV.text.fixed, { enable_prompt_expansion: false }) && eq((WV.text.settings || []).map((s) => s.key), ["quality", "edit_precision"]) && WV.text.refs === null, short(WV.text));
        check("... so a text run's params are quality medium, edit_precision high, enable_prompt_expansion false", eq(defaults(WV.text.settings, WV.text.fixed), { quality: "medium", edit_precision: "high", enable_prompt_expansion: false }), short(defaults(WV.text.settings, WV.text.fixed)));
        check("limits: the recipe's ratio 6 inherited, the default 2048 / 256 / 16 kept", WV.limits && WV.limits.ratio === 6 && WV.limits.max === 2048 && WV.limits.min === 256 && WV.limits.step === 16, short(WV.limits));
    });

    // ---- 8. WaveSpeed: a fill ----
    await section("8. WaveSpeed: a fill", async () => {
        const x = await runWs(wsFill(WV, { negative: "blurry, low quality", seed: 7 }));
        const seq = x.s.calls.map((c) => `${c.method} ${c.url}`);
        check("a ticket and a PUT for the crop, then for the mask, one submit to .../ideogram-ai/ideogram-v4.5/edit, the download; nothing else", !x.err && eq(seq, [`POST ${WS_API}media/uploads`, `PUT ${WS_PUT}u1?sig=test`, `POST ${WS_API}media/uploads`, `PUT ${WS_PUT}u2?sig=test`, `POST ${WS_API}${WS_EDIT}`, `GET ${WS_OUT}`]) && !x.s.strays.length && !x.s.binaries.length, x.err || short(seq));
        check("the input holds edit_precision, image, mask_url, prompt and quality, nothing else", !x.err && eq(keysOf(x.input), ["edit_precision", "image", "mask_url", "prompt", "quality"]), short(keysOf(x.input)));
        check("no seed, output_format, negative_prompt, aspect_ratio or size although the request has a negative and a seed (the allowlist)", !x.err && ["seed", "output_format", "negative_prompt", "aspect_ratio", "size", "mask_image", "images"].every((k) => !(k in x.input)), short(keysOf(x.input)));
        check("the body is the input itself, the prompt as written, quality medium, edit_precision high", !("input" in x.input) && x.input.prompt === "a red door" && x.input.quality === "medium" && x.input.edit_precision === "high", short(x.input));
        check("image and mask_url are the download_urls of the first and the second upload", x.input.image === `${WS_CDN}media/u1` && x.input.mask_url === `${WS_CDN}media/u2`, short([x.input.image, x.input.mask_url]));
        check("the image is the crop as given, byte for byte", sameAs(x.s.at(x.input.image), IMAGE), short(x.input.image));
        const m = x.s.at(x.input.mask_url);
        const bad = notInverted(m, W, H, RECT);
        check("the mask is Scumble's inverted, every pixel: the selected rectangle black (edit), the rest white, opaque", !x.err && bad === null, bad);
        check("... spot pixels: (16,12) and (39,29) black, (15,12), (40,29), (0,0) and (63,47) white", eq(pixel(m, 16, 12), [0, 0, 0, 255]) && eq(pixel(m, 39, 29), [0, 0, 0, 255]) && eq(pixel(m, 15, 12), [255, 255, 255, 255]) && eq(pixel(m, 40, 29), [255, 255, 255, 255]) && eq(pixel(m, 0, 0), [255, 255, 255, 255]) && eq(pixel(m, 63, 47), [255, 255, 255, 255]), short([pixel(m, 16, 12), pixel(m, 15, 12)]));
        check("... and it is not the mask as given", !sameAs(m, RECT_MASK));
        const t = x.s.tickets.map((c) => c.body);
        check("the tickets: { filename, size, content_type }, scumble-<stamp>-crop.png then -mask.png, the PUT's byte count, image/png", t.length === 2 && t.every((b) => eq(keysOf(b), ["content_type", "filename", "size"]) && b.content_type === "image/png") && /^scumble-[0-9a-z]+-crop\.png$/.test(t[0].filename) && /^scumble-[0-9a-z]+-mask\.png$/.test(t[1].filename) && t[0].size === x.s.puts[0].bytes.length && t[1].size === x.s.puts[1].bytes.length, short(t));
        check("the tickets and the submit carry the key and JSON; the PUTs carry image/png and no key; the download no key", [...x.s.tickets, ...x.s.submits].every((c) => c.headers.authorization === "Bearer " + WS_KEY && c.headers["content-type"] === "application/json") && x.s.puts.length === 2 && x.s.puts.every((c) => c.headers["content-type"] === "image/png" && !("authorization" in c.headers)) && x.s.gets.length === 1 && !("authorization" in x.s.gets[0].headers), short([x.s.tickets[0] && x.s.tickets[0].headers, x.s.puts[0] && x.s.puts[0].headers, x.s.gets[0] && x.s.gets[0].headers]));
        check("the answer: the downloaded picture, no seed (the allowlist kept it home), info { model, ms } without info.mask", !x.err && sameAs(x.out.bytes, RESULT) && x.out.mime === "image/png" && x.out.seed === undefined && eq(x.out.info, { model: WS_EDIT, ms: 1234 }), x.err || short(x.out && { seed: x.out.seed, info: x.out.info }));
        const y = await runWs(wsFill(WV, { mask: maskPng(W, H, RAMP) }));
        const ym = y.s.at(y.input.mask_url);
        const badRamp = notInverted(ym, W, H, RAMP);
        check("a grey ramp: 128 and above black, below white (x = 31 at 124 white, x = 32 at 128 black)", !y.err && badRamp === null && eq(pixel(ym, 31, 0), [255, 255, 255, 255]) && eq(pixel(ym, 32, 0), [0, 0, 0, 255]), y.err || badRamp);
        const vl = await runWs(wsFill(WV, { params: { ...defaults(WV.settings, WV.fixed), quality: "very_low", edit_precision: "regular" } }));
        check("an edit keeps very_low (text_values is the text run's only) and sends edit_precision regular as picked", !vl.err && vl.input.quality === "very_low" && vl.input.edit_precision === "regular", vl.err || short(vl.input));
        const open = await runWs(wsFill(WV, { negative: "blurry", options: { ...WV.options, accepts: undefined } }));
        check("without the allowlist the fill still sends no aspect_ratio (the fill guard) and no negative_prompt (negative false), but seed 7 and output_format png, and reports the seed", !open.err && !("aspect_ratio" in open.input) && !("negative_prompt" in open.input) && open.input.seed === 7 && open.input.output_format === "png" && open.out.seed === 7, open.err || short(keysOf(open.input)));
        const fb = await runWs(wsFill(WV), {}, { ticketFails: true });
        const b = fb.s.binaries;
        check("a ticket answering 500: each picture goes by the binary upload instead (multipart file, its name and type, the key), no PUT", !fb.err && fb.s.tickets.length === 2 && b.length === 2 && !fb.s.puts.length && b.every((c) => c.headers.authorization === "Bearer " + WS_KEY && c.type === "image/png") && /-crop\.png$/.test(b[0].name || "") && /-mask\.png$/.test(b[1].name || "") && sameAs(fb.s.at(fb.input.image), IMAGE) && notInverted(fb.s.at(fb.input.mask_url), W, H, RECT) === null, fb.err || short(b.map((c) => [c.name, c.type])));
    });

    // ---- 9. WaveSpeed: a selection over the whole crop, and one with nothing to edit ----
    await section("9. WaveSpeed: whole and empty selections", async () => {
        let x = await runWs(wsFill(WV, { mask: maskPng(W, H, () => 255) }));
        check("the mask all 255 (the whole crop selected): no mask_url and no mask upload (one ticket and PUT: the crop), the crop still goes", !x.err && !("mask_url" in x.input) && x.s.tickets.length === 1 && x.s.puts.length === 1 && /-crop\.png$/.test(x.s.tickets[0].body.filename) && sameAs(x.s.at(x.input.image), IMAGE) && x.s.submits.length === 1 && eq(keysOf(x.input), ["edit_precision", "image", "prompt", "quality"]), x.err || short(keysOf(x.input)));
        check("... and the answer's info.mask says so", !x.err && x.out.info.mask === "none: the selection covers the whole crop, so the whole crop was edited" && x.out.info.model === WS_EDIT, short(x.out && x.out.info));
        x = await runWs(wsFill(WV, { mask: maskPng(W, H, (xx) => (xx === 0 ? 128 : 255)) }));
        check("a mask at 128 or more everywhere also counts as the whole crop (no mask_url)", !x.err && !("mask_url" in x.input) && /^none: /.test(x.out.info.mask || ""), x.err || short(keysOf(x.input)));
        x = await runWs(wsFill(WV, { mask: maskPng(W, H, () => 0) }));
        check("the mask all 0: refused in words, no fetch at all", x.err === `${WS_WHO}: the selection holds no pixel at half strength or more, so the model would have nothing to edit. Select the area to change.` && x.s.calls.length === 0, x.err);
        x = await runWs(wsFill(WV, { mask: maskPng(W, H, () => 127) }));
        check("the mask all 127 (under half strength): refused the same way, no fetch", /holds no pixel at half strength or more/.test(x.err || "") && x.s.calls.length === 0, x.err);
        x = await runWs(wsFill(WV, { mask: maskPng(32, H, () => 255) }));
        check("a mask of another size than the crop: refused, no fetch", x.err === `${WS_WHO}: the mask is 32 × 48 and the picture 64 × 48; Ideogram takes a mask of the picture's own size.` && x.s.calls.length === 0, x.err);
    });

    // ---- 10. WaveSpeed: reference layers ----
    await section("10. WaveSpeed: references", async () => {
        let x = await runWs(wsFill(WV));
        check("no reference layer: no reference_images key, two uploads", !x.err && !("reference_images" in x.input) && x.s.tickets.length === 2, x.err || short(keysOf(x.input)));
        x = await runWs(wsFill(WV, { references: [REF[0], REF[1]] }));
        const list = x.input.reference_images || [];
        const order = x.s.tickets.map((c) => (/-(crop|mask|ref\d)\.png$/.exec(c.body.filename) || [])[1]);
        check("2 references: four uploads in order (crop, mask, ref1, ref2), reference_images the last two download_urls, all four distinct", !x.err && eq(order, ["crop", "mask", "ref1", "ref2"]) && list.length === 2 && list[0] === x.s.puts[2].dl && list[1] === x.s.puts[3].dl && new Set([x.input.image, x.input.mask_url, ...list]).size === 4, x.err || short({ order, list }));
        check("... reference_images[0] and [1] are the two layers in order, the crop still in image, the mask still inverted", sameAs(x.s.at(list[0]), REF[0]) && sameAs(x.s.at(list[1]), REF[1]) && sameAs(x.s.at(x.input.image), IMAGE) && notInverted(x.s.at(x.input.mask_url), W, H, RECT) === null, short(list));
        check("... the input's keys: edit_precision, image, mask_url, prompt, quality, reference_images", eq(keysOf(x.input), ["edit_precision", "image", "mask_url", "prompt", "quality", "reference_images"]), short(keysOf(x.input)));
        x = await runWs(wsFill(WV, { references: REF.slice(0, 3) }));
        check("3 references (crop + 3 = 4, the cap): all three go", !x.err && (x.input.reference_images || []).length === 3 && sameAs(x.s.at(x.input.reference_images[2]), REF[2]) && x.s.tickets.length === 5, x.err);
        x = await runWs(wsFill(WV, { references: REF.slice(0, 4) }));
        check("4 references (crop + 4 = 5 > max 4): refused before any fetch", x.err === `${WS_WHO} takes at most 4 pictures; this run has 5: hide reference layers or turn Original off.` && x.s.calls.length === 0, x.err);
        x = await runWs(wsFill(WV, { references: REF.slice(0, 4), mask: maskPng(W, H, () => 0) }));
        check("... the count is refused before the mask is read (4 references and an empty mask: the count's message)", /takes at most 4 pictures; this run has 5/.test(x.err || "") && x.s.calls.length === 0, x.err);

        const req2 = wsFill(WV, { references: [REF[0], REF[1]] });
        const lay = ws.layout(req2);
        const pics = lay.pictures.map((p) => [p.role, p.ref === undefined ? null : p.ref, p.field, p.n]);
        check("layout for 2 references: style true, max 4, no drops", lay.style === true && lay.max === 4 && lay.drops === null, short(lay));
        check("... the crop numbered 1 in image, the mask in mask_url unnumbered, the references unnumbered in reference_images[i]", eq(pics, [["crop", null, "image", 1], ["mask", null, "mask_url", null], ["reference", 0, "reference_images[0]", null], ["reference", 1, "reference_images[1]", null]]), short(pics));
        let ok = true, why = "";
        try { refs.checkLayout(lay, req2); } catch (e) { ok = false; why = String(e.message); }
        check("... refs.checkLayout accepts it, and it counts 3 pictures (the mask in its own field is not counted)", ok && refs.countOf(lay) === 3, why || String(refs.countOf(lay)));
        let e = null;
        try { refs.checkPictures(lay, { ...req2, prompt: "the hat from {@ref:1}" }, WS_WHO); } catch (err) { e = String(err.message); }
        check("... so a prompt naming a reference is refused by checkPictures (unnumbered references)", /sends reference layers without a number/.test(e || ""), e);
        const lay4 = ws.layout(wsFill(WV, { references: REF.slice(0, 4) }));
        check("layout for 4 references counts 5 against max 4 (what index.js refuses before the adapter)", refs.countOf(lay4) === 5 && lay4.max === 4, short([refs.countOf(lay4), lay4.max]));
    });

    // ---- 11. WaveSpeed: the crop's shape and the bytes of each picture, before any upload ----
    await section("11. WaveSpeed: shape and bytes", async () => {
        const strip = (w, h) => wsFill(WV, { image: imagePng(w, h), mask: maskPng(w, h, (xx) => (xx < 8 ? 255 : 0)), width: w, height: h });
        let x = await runWs(strip(64, 8));
        check("a crop of 64 x 8 (8:1) is refused before any request", x.err === `${WS_WHO} takes pictures no steeper than 6:1; the crop is 64 × 8, and the picture is too narrow to widen it. Nothing was sent.` && x.s.calls.length === 0, x.err);
        x = await runWs(strip(8, 64));
        check("... and 8 x 64 (1:8) too", /no steeper than 6:1; the crop is 8 × 64/.test(x.err || "") && x.s.calls.length === 0, x.err);
        x = await runWs(strip(60, 10));
        check("a crop of 60 x 10 (6:1) goes", !x.err && x.s.submits.length === 1, x.err);
        const small = { ...WV.options, max_bytes: IMAGE.length - 1 };
        const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
        x = await runWs(wsFill(WV, { options: small, references: [REF[0]] }), { opaque: () => true, toJpeg: () => JPEG });
        const t = x.s.tickets.map((c) => c.body);
        check("an opaque crop and mask over max_bytes go as JPEG: tickets with content_type image/jpeg and a .jpg name, PUTs with content-type image/jpeg, the JPEG bytes", !x.err && t.length === 3 && [0, 1].every((i) => t[i].content_type === "image/jpeg" && /\.jpg$/.test(t[i].filename) && t[i].size === JPEG.length && x.s.puts[i].headers["content-type"] === "image/jpeg") && /-crop\.jpg$/.test(t[0].filename) && /-mask\.jpg$/.test(t[1].filename) && sameAs(x.s.at(x.input.image), JPEG) && sameAs(x.s.at(x.input.mask_url), JPEG), x.err || short(t));
        check("... the reference under the cap stays PNG (image/png, -ref1.png, its own bytes)", !x.err && t[2] && t[2].content_type === "image/png" && /-ref1\.png$/.test(t[2].filename) && x.s.puts[2].headers["content-type"] === "image/png" && sameAs(x.s.at((x.input.reference_images || [])[0]), REF[0]), x.err || short(t[2]));
        x = await runWs(wsFill(WV, { options: small }), { opaque: () => false, toJpeg: () => JPEG });
        check("a crop with transparency over max_bytes is refused in words, no fetch", x.err === `${WS_WHO}: the crop is ${(IMAGE.length / 1e6).toFixed(1)} MB, more than the 0 MB a picture may have (it has transparency, so it stays PNG). Set Highres fix lower or use a smaller reference layer. Nothing was sent.` && x.s.calls.length === 0, x.err);
        const BIG = imagePng(80, 60);   // larger than the crop, so only the reference trips the cap
        x = await runWs(wsFill(WV, { options: { ...WV.options, max_bytes: IMAGE.length }, references: [BIG] }), { opaque: () => true, toJpeg: () => Buffer.alloc(BIG.length) });
        check("a reference still over max_bytes as JPEG is refused, naming it, no fetch", /the reference picture 1 is .* MB, more than the .* MB a picture may have even as JPEG/.test(x.err || "") && x.s.calls.length === 0, x.err);
    });

    // ---- 12. WaveSpeed: a text run (Generate new) ----
    await section("12. WaveSpeed: text runs", async () => {
        const tparams = (more = {}) => ({ ...defaults(WV.text.settings, WV.text.fixed), ...more });
        const TEXT_KEYS = ["aspect_ratio", "enable_prompt_expansion", "prompt", "quality", "resolution"];
        let x = await runWs(wsText(WV, { width: 2048, height: 1152, negative: "blurry", seed: 7 }));
        const seq = x.s.calls.map((c) => `${c.method} ${c.url}`);
        check("one submit to .../ideogram-ai/ideogram-v4.5, then the download; no upload", !x.err && eq(seq, [`POST ${WS_API}${WS_TEXT}`, `GET ${WS_OUT}`]), x.err || short(seq));
        check("the input holds aspect_ratio, enable_prompt_expansion, prompt, quality and resolution, nothing else", !x.err && eq(keysOf(x.input), TEXT_KEYS), short(keysOf(x.input)));
        check("no edit_precision (the edit's row), seed, output_format, negative_prompt, size or picture field", ["edit_precision", "seed", "output_format", "negative_prompt", "size", "image", "images", "mask_url", "reference_images"].every((k) => !(k in x.input)), short(keysOf(x.input)));
        check("enable_prompt_expansion false (text.fixed), quality medium, the prompt as written", x.input.enable_prompt_expansion === false && x.input.quality === "medium" && x.input.prompt === "a lighthouse at dusk", short(x.input));
        check("2048 x 1152: 16:9 at 2k", x.input.aspect_ratio === "16:9" && x.input.resolution === "2k", short([x.input.aspect_ratio, x.input.resolution]));
        check("the answer: the downloaded picture, no seed, info { model: the text route, ms }", !x.err && sameAs(x.out.bytes, RESULT) && x.out.seed === undefined && eq(x.out.info, { model: WS_TEXT, ms: 1234 }), x.err || short(x.out && { seed: x.out.seed, info: x.out.info }));
        const shape = async (w, h) => { const r = await runWs(wsText(WV, { width: w, height: h })); return r.err ? [r.err] : [r.input.aspect_ratio, r.input.resolution]; };
        const sq = await shape(1024, 1024), wide = await shape(1536, 1024), tall = await shape(640, 1536), huge = await shape(4096, 4096), over = await shape(1025, 768);
        check("1024 x 1024: 1:1 at 1k", eq(sq, ["1:1", "1k"]), short(sq));
        check("1536 x 1024: 3:2 at 2k", eq(wide, ["3:2", "2k"]), short(wide));
        check("640 x 1536 (0.42; 9:16 = 0.56 is the closest preset on a log scale): 9:16 at 2k", eq(tall, ["9:16", "2k"]), short(tall));
        check("4096 x 4096: past the largest tier, so 2k", eq(huge, ["1:1", "2k"]), short(huge));
        check("1025 x 768: one pixel over 1024, so 2k (4:3)", eq(over, ["4:3", "2k"]), short(over));
        x = await runWs(wsText(WV, { params: tparams({ quality: "very_low" }) }));
        const hi = await runWs(wsText(WV, { params: tparams({ quality: "high" }) }));
        check("quality very_low goes as low, high stays high", !x.err && x.input.quality === "low" && hi.input.quality === "high", short([x.input.quality, hi.input.quality]));
        x = await runWs(wsText(WV, { params: tparams({ edit_precision: "regular" }) }));
        check("an edit_precision row set to regular still stays home on a text run", !x.err && eq(keysOf(x.input), TEXT_KEYS), short(keysOf(x.input)));
        x = await runWs(wsText(WV, { references: [REF[0], REF[1]] }));
        const lay = ws.textLayout(wsText(WV, { references: [REF[0], REF[1]] }));
        check("a text run called directly with 2 references uploads nothing and sends no picture (textLayout declares the drop: no edit in the route)", !x.err && !x.s.tickets.length && !x.s.binaries.length && !x.s.puts.length && x.s.submits.length === 1 && eq(keysOf(x.input), TEXT_KEYS) && typeof lay.drops === "string" && lay.drops.length > 0 && lay.pictures.length === 0, x.err || short({ input: keysOf(x.input), lay }));
    });

    // ---- 13. other WaveSpeed variants unchanged ----
    await section("13. WaveSpeed: other variants", async () => {
        const F = loadRecipe("flux1_fill").providers.wavespeed;
        const fo = F.options || {};
        check("flux1_fill's WaveSpeed variant: a fill on wavespeed-ai/flux-fill-dev, fields image / mask_image, size star at 1536, negative false, no accepts and no mask option", F.model === "wavespeed-ai/flux-fill-dev" && F.input === "fill" && eq(F.fields, { image: "image", mask: "mask_image" }) && fo.size === "star" && fo.max_side === 1536 && fo.negative === false && !("accepts" in fo) && !("mask" in fo), short({ model: F.model, fields: F.fields, options: fo }));
        let x = await runWs(wsFill(F, { negative: "blurry", seed: 4000000000 }));
        check("FLUX.1 Fill: two uploads (crop, mask), the submit to .../wavespeed-ai/flux-fill-dev, the download", !x.err && x.s.tickets.length === 2 && x.sub.url === `${WS_API}wavespeed-ai/flux-fill-dev` && x.s.gets.length === 1 && !x.s.strays.length, x.err || short(x.s.calls.map((c) => `${c.method} ${c.url}`)));
        check("... the keys as before: guidance_scale, image, mask_image, num_inference_steps, output_format, prompt, seed, size", eq(keysOf(x.input), ["guidance_scale", "image", "mask_image", "num_inference_steps", "output_format", "prompt", "seed", "size"]), short(keysOf(x.input)));
        check("... the mask goes exactly as given (not inverted)", sameAs(x.s.at(x.input.mask_image), RECT_MASK), short(x.input.mask_image));
        check("... seed 4000000000 uncapped, output_format png, size 256*256 (the 64 x 48 crop at the 256 floor), steps 28, guidance 30; no negative_prompt (its own negative false), no aspect_ratio", x.input.seed === 4000000000 && x.input.output_format === "png" && x.input.size === "256*256" && x.input.num_inference_steps === 28 && x.input.guidance_scale === 30 && !("negative_prompt" in x.input) && !("aspect_ratio" in x.input), short(x.input));
        check("... the answer reports the seed sent, info { model, ms } and no mask note", !x.err && x.out.seed === 4000000000 && eq(x.out.info, { model: "wavespeed-ai/flux-fill-dev", ms: 1234 }), x.err || short(x.out && { seed: x.out.seed, info: x.out.info }));
        x = await runWs(wsFill(F, { mask: maskPng(W, H, () => 255) }));
        check("... a whole-crop mask still goes as given, no info.mask", !x.err && sameAs(x.s.at(x.input.mask_image), maskPng(W, H, () => 255)) && !("mask" in x.out.info), x.err || short(x.out && x.out.info));
        x = await runWs(wsFill(F, { negative: "blurry", options: { ...fo, negative: undefined } }));
        check("... the same fill without negative false sends negative_prompt (the option alone holds it back)", !x.err && x.input.negative_prompt === "blurry", x.err || short(keysOf(x.input)));

        const N = loadRecipe("nano_banana_2").providers.wavespeed;
        const no = N.options || {};
        check("nano_banana_2's WaveSpeed variant: an edit on google/nano-banana-2/edit, max_images 14, 14 aspect presets, no accepts", N.model === "google/nano-banana-2/edit" && N.input === "edit" && no.max_images === 14 && (no.aspect_ratios || []).length === 14 && !("accepts" in no) && !("text_accepts" in no), short({ model: N.model, input: N.input, options: no }));
        x = await runWs(wsFill(N, { negative: "blurry", references: [REF[0], REF[1]] }));
        check("Nano Banana 2 edit: three uploads (crop, ref1, ref2; no mask), the submit to .../google/nano-banana-2/edit", !x.err && eq(x.s.tickets.map((c) => (/-(crop|mask|ref\d)\.png$/.exec(c.body.filename) || [])[1]), ["crop", "ref1", "ref2"]) && x.sub.url === `${WS_API}google/nano-banana-2/edit` && !x.s.strays.length, x.err || short(x.s.calls.map((c) => `${c.method} ${c.url}`)));
        check("... the keys as before: aspect_ratio, images, output_format, prompt, resolution, seed", eq(keysOf(x.input), ["aspect_ratio", "images", "output_format", "prompt", "resolution", "seed"]), short(keysOf(x.input)));
        const imgs = x.input.images || [];
        check("... images the crop then the references, aspect_ratio 4:3 (closest to 64 x 48), seed 7, output_format png, resolution 2k; no negative_prompt on an edit", imgs.length === 3 && sameAs(x.s.at(imgs[0]), IMAGE) && sameAs(x.s.at(imgs[1]), REF[0]) && sameAs(x.s.at(imgs[2]), REF[1]) && x.input.aspect_ratio === "4:3" && x.input.seed === 7 && x.input.output_format === "png" && x.input.resolution === "2k" && !("negative_prompt" in x.input), short({ ...x.input, images: imgs.length }));
        check("... the answer reports seed 7", !x.err && x.out.seed === 7, short(x.out && x.out.seed));
        x = await runWs(wsText(N, { width: 640, height: 1536 }));
        check("Nano Banana 2 text run (640 x 1536): google/nano-banana-2, aspect_ratio 9:16, seed 7, output_format png, resolution 2k, no picture", !x.err && x.sub.url === `${WS_API}google/nano-banana-2` && eq(keysOf(x.input), ["aspect_ratio", "output_format", "prompt", "resolution", "seed"]) && x.input.aspect_ratio === "9:16" && x.input.seed === 7 && x.input.output_format === "png" && x.input.resolution === "2k" && !x.s.tickets.length && x.out.seed === 7, x.err || short(x.input));
    });

    // ---- 14. the whole run ----
    console.log("\n--- 14. the whole run ---");
    const api = ALL_CALLS.filter((c) => c.url.startsWith(API + "/"));
    const downloads = ALL_CALLS.filter((c) => c.url === OUT_URL);
    check("Replicate: the token went on every api.replicate.com call and never on a download; no call outside the two hosts", ALL_CALLS.length > 40 && api.length + downloads.length === ALL_CALLS.length && api.every((c) => c.headers.authorization === "Bearer " + KEY) && downloads.every((c) => !("authorization" in c.headers)), `${ALL_CALLS.length} calls, ${api.length} to the API, ${downloads.length} downloads`);
    check("Replicate: the token appears in no error of the run", ERRORS.length >= 5 && !ERRORS.some((m) => m.includes(KEY)), `${ERRORS.length} errors`);
    const wsApi = WS_CALLS.filter((c) => c.url.startsWith(WS_API));
    const wsPuts = WS_CALLS.filter((c) => c.url.startsWith(WS_PUT));
    const wsCdn = WS_CALLS.filter((c) => c.url.startsWith(WS_CDN));
    check("WaveSpeed: the key went on every api.wavespeed.ai call, never on a PUT to the presigned URL or a download; no call outside the three hosts", WS_CALLS.length > 60 && wsApi.length + wsPuts.length + wsCdn.length === WS_CALLS.length && wsApi.every((c) => c.headers.authorization === "Bearer " + WS_KEY) && wsPuts.length > 0 && wsPuts.every((c) => c.method === "PUT" && !("authorization" in c.headers)) && wsCdn.length > 0 && wsCdn.every((c) => c.method === "GET" && c.url === WS_OUT && !("authorization" in c.headers)), `${WS_CALLS.length} calls, ${wsApi.length} to the API, ${wsPuts.length} PUTs, ${wsCdn.length} downloads`);
    check("WaveSpeed: every call was one the fake plays (no 404 stray)", WS_STRAYS.length === 0, short(WS_STRAYS.map((c) => `${c.method} ${c.url}`)));
    check("WaveSpeed: the key (and the Replicate token) appear in no error of the run", WS_ERRORS.length >= 8 && !WS_ERRORS.some((m) => m.includes(WS_KEY) || m.includes(KEY)), `${WS_ERRORS.length} errors`);

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + (err && err.stack || err)); console.log("FAIL"); process.exit(1); });
