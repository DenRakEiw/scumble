// The Magnific adapter (electron/main/providers/magnific.js) beyond its upscalers, its recipe variants, the renderer-
// independent helpers and its wiring in providers/index.js, in plain Node, no Electron and no key:
//   node tools/magnific_test.js
// A scripted fetch plays api.magnific.com and the loopback mock (the task POST, the status reads, the result
// download); ctx.sleep records its waits instead of waiting, ctx.now is a clock the test moves. A fake codec stands in
// for Electron's nativeImage (bitmap / fromBitmap / cropPng): its "PNG" is a real signature and IHDR followed by the raw
// RGBA, so the Ideogram mask and the Image Expand geometry are checked byte for byte. Every body built for every shipped
// magnific variant is checked against the route's request schema (tools/refs/magnific/, resolved from Magnific's OpenAPI
// document of 2026-09-26): every field one the schema names, every required one there, every enum and bound held. The
// upscalers' own checks are in tools/upscale_test.js. Nothing here talks to the live API.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const mag = require(path.join(ROOT, "electron", "main", "providers", "magnific.js"));

const KEY = "test-magnific-0123456789";
const REAL_KEY = "FPSX0123456789abcdef0123456789ab";   // the shape of a Magnific key; never a real one
const BASE = "http://127.0.0.1:5578";
const LIVE = "https://api.magnific.com";
const TID = "046b6c7f-0b8a-43b9-b35d-6489e6daee91";
const REFS = path.join(ROOT, "tools", "refs", "magnific");
const RECIPES = path.join(ROOT, "recipes");
const ALL_CALLS = [];
const ERRORS = [];

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
async function throws(fn) {
    try { await fn(); return null; } catch (err) { const m = String((err && err.message) || err); ERRORS.push(m); return m; }
}

// ---- pictures: fake PNGs (a real IHDR, a tag) and the fake codec (IHDR + raw RGBA) ----------------------------------

function header(w, h, len, colour = 6) {
    const b = Buffer.alloc(len, 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    b[24] = 8;
    b[25] = colour;
    return b;
}
function pngOf(w, h, size = 64, tag = "") {
    const b = header(w, h, Math.max(size, 33 + tag.length));
    b.write(tag, 33, "latin1");
    return b;
}
const jpegOf = (size, tag = "") => { const b = Buffer.alloc(Math.max(size, 33 + tag.length), 0); Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(b); b.write(tag, 33, "latin1"); return b; };
const tagOf = (b) => Buffer.from(b).toString("latin1", 33, 33 + 16).replace(/\0+$/, "");
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
    cropPng(png, r) {
        const bm = codec.bitmap(png);
        if (!bm) return null;
        const out = Buffer.alloc(r.width * r.height * 4);
        for (let y = 0; y < r.height; y++) bm.data.copy(out, y * r.width * 4, ((r.y + y) * bm.width + r.x) * 4, ((r.y + y) * bm.width + r.x + r.width) * 4);
        return rawPng(r.width, r.height, out);
    },
};
/** A grey picture of the fake codec: fn(x, y) -> 0..255 (the mask's selection value). */
function greyOf(w, h, fn) {
    const d = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = fn(x, y), j = (y * w + x) * 4; d[j] = v; d[j + 1] = v; d[j + 2] = v; d[j + 3] = 255; }
    return { width: w, height: h, data: d };
}
const maskPng = (w, h, fn) => codec.fromBitmap(greyOf(w, h, fn));
const imagePng = (w, h) => codec.fromBitmap(greyOf(w, h, (x, y) => (x * 7 + y * 13) & 255));
const RESULT = pngOf(1024, 768, 80, "RESULT");

// ---- the request schemas ----------------------------------------------------------------------------------------

function schemaOf(route) {
    return JSON.parse(fs.readFileSync(path.join(REFS, route.replace(/\//g, "_") + ".json"), "utf8")).schema;
}
/** allOf parts merged into one object schema (the Seedream edit routes are two parts). */
function flat(s) {
    if (!s || !s.allOf) return s;
    const out = { type: "object", properties: {}, required: [] };
    for (const p of s.allOf.map(flat)) { Object.assign(out.properties, p.properties || {}); out.required.push(...(p.required || [])); }
    return out;
}
/** Problems of `v` against `s` ([] when it holds). An unknown field is a problem: the bodies stay inside the schema. */
function validate(s, v, at = "body") {
    s = flat(s);
    if (!s) return [];
    const out = [];
    for (const k of ["anyOf", "oneOf"]) {
        if (!s[k]) continue;
        if (!s[k].some((x) => !validate(x, v, at).length)) out.push(`${at}: matches none of ${k}`);
    }
    const t = s.type;
    const is = { string: typeof v === "string", integer: Number.isInteger(v), number: typeof v === "number", boolean: typeof v === "boolean", array: Array.isArray(v), object: v && typeof v === "object" && !Array.isArray(v) };
    if (t && !is[t]) return out.concat([`${at}: not ${t} (${short(v)})`]);
    if (s.enum && !s.enum.includes(v)) out.push(`${at}: ${short(v)} not in ${short(s.enum)}`);
    if (typeof v === "number") {
        if (s.minimum != null && v < s.minimum) out.push(`${at}: ${v} < ${s.minimum}`);
        if (s.maximum != null && v > s.maximum) out.push(`${at}: ${v} > ${s.maximum}`);
    }
    if (typeof v === "string") {
        if (s.minLength != null && v.length < s.minLength) out.push(`${at}: shorter than ${s.minLength}`);
        if (s.maxLength != null && v.length > s.maxLength) out.push(`${at}: longer than ${s.maxLength}`);
        if (s.format === "byte" && !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) out.push(`${at}: not base64`);
    }
    if (Array.isArray(v)) {
        if (s.minItems != null && v.length < s.minItems) out.push(`${at}: ${v.length} items < ${s.minItems}`);
        if (s.maxItems != null && v.length > s.maxItems) out.push(`${at}: ${v.length} items > ${s.maxItems}`);
        if (s.items) v.forEach((x, i) => out.push(...validate(s.items, x, `${at}[${i}]`)));
    }
    if (is.object && (s.properties || s.type === "object")) {
        const props = s.properties || {};
        for (const r of s.required || []) if (!(r in v)) out.push(`${at}: missing ${r}`);
        for (const [k, x] of Object.entries(v)) {
            if (props[k]) out.push(...validate(props[k], x, `${at}.${k}`));
            else if (s.additionalProperties !== true) out.push(`${at}: unknown field ${k}`);
        }
    }
    return out;
}

// ---- a fake Magnific ----------------------------------------------------------------------------------------------

function recordHeaders(init) {
    const h = {};
    for (const [k, v] of new Headers((init && init.headers) || {})) h[k.toLowerCase()] = v;
    return h;
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const task = (status, generated = [], extra = {}) => json(200, { data: { task_id: TID, status, generated, ...extra } });

/**
 * `post` / `poll` / `asset` answer their calls in order (functions of (body|call) returning a Response, or throwing for
 * a network error); when a list runs out a route answers normally: CREATED on the POST, IN_PROGRESS then COMPLETED on
 * the status reads (with the asset on the asked host, https for the live one), the RESULT picture for the asset.
 */
function fakeServer(opts = {}) {
    const calls = [], posts = [], polls = [], assets = [];
    const q = { post: [...(opts.post || [])], poll: [...(opts.poll || [])], asset: [...(opts.asset || [])] };
    let polled = 0;
    async function fetch(url, init = {}) {
        const method = String(init.method || "GET").toUpperCase();
        const call = { url: String(url), method, headers: recordHeaders(init) };
        calls.push(call);
        ALL_CALLS.push(call);
        const u = new URL(String(url));
        const host = `${u.protocol}//${u.host}`;
        if (u.pathname.startsWith("/v1/ai/") && method === "POST") {
            const body = JSON.parse(init.body);
            posts.push({ ...call, body, route: u.pathname.slice(7) });
            const a = q.post.shift();
            if (a) return a(body, call);
            return json(200, { data: { task_id: TID, status: "CREATED", generated: [] } });
        }
        if (u.pathname.startsWith("/v1/ai/")) {
            polls.push(call);
            const a = q.poll.shift();
            if (a) return a(call);
            polled++;
            const asset = host === LIVE ? "https://ai-statics.freepik.com/out.png" : `${host}/asset/out.png`;
            const nsfw = /\/v1\/ai\/mystic\//.test(u.pathname) ? { has_nsfw: [false] } : {};
            return polled % 2 ? task("IN_PROGRESS", [], nsfw) : task("COMPLETED", [asset], nsfw);
        }
        assets.push(call);
        const a = q.asset.shift();
        if (a) return a(call);
        return new Response(RESULT, { status: 200, headers: { "content-type": "image/png" } });
    }
    return { fetch, calls, posts, polls, assets };
}

function ctxFor(s, extra = {}) {
    const ctx = {
        key: KEY, base: BASE, fetch: s.fetch, waits: [], logs: [], clock: 0,
        opaque: () => true, toJpeg: (b) => jpegOf(Math.floor(b.length / 4), "JPEG"),
        bitmap: codec.bitmap, fromBitmap: codec.fromBitmap, cropPng: codec.cropPng,
        ...extra,
    };
    ctx.sleep = extra.sleep || (async (ms) => { ctx.waits.push(ms); });
    ctx.log = (m) => ctx.logs.push(String(m));
    ctx.now = extra.now || (() => ctx.clock);
    return ctx;
}

// ---- the recipes as recipes.js serves them ------------------------------------------------------------------------

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
        r.kind = r.kind === "provider" ? "provider" : "comfy";
        return recipes._normalize(r);
    });
    return RECIPE_CACHE;
}
const rawRecipe = (id) => JSON.parse(fs.readFileSync(path.join(RECIPES, id + ".json"), "utf8"));
const variant = (id) => { const r = loadRecipes().find((x) => x.id === id); return r && r.providers.magnific; };
/** The values the Settings panel starts with, plus the fixed ones (host.js providerParams). */
function defaults(rows, fixed) {
    const p = {};
    for (const s of rows || []) p[s.key] = s.spec[1] && s.spec[1].default !== undefined ? s.spec[1].default : (Array.isArray(s.spec[0]) ? s.spec[0][0] : undefined);
    return { ...p, ...(fixed || {}) };
}
function editReq(v, extra = {}) {
    return { provider: "magnific", model: v.model, kind: v.input === "fill" ? "fill" : "edit", options: v.options || null, prompt: "a red door", negative: "", seed: 7, image: pngOf(1024, 576, 96, "CROP"), mask: null, maskAlpha: null, width: 1024, height: 576, references: [], params: defaults(v.settings, v.fixed), ...extra };
}
function textReq(v, extra = {}) {
    return { provider: "magnific", model: v.text.model, kind: "text", prompt: "a lighthouse at dusk", negative: "", seed: 7, width: 2048, height: 1152, aspect: null, image: null, mask: null, maskAlpha: null, references: [], params: { ...defaults(v.settings, v.fixed), ...(v.text.fixed || {}) }, ...extra };
}
/** An Image Expand / Ideogram request with the fake codec: the picture and a mask of the selection (fn: 0..255). */
function maskedReq(v, w, h, fn, extra = {}) {
    return editReq(v, { image: imagePng(w, h), mask: maskPng(w, h, fn), width: w, height: h, ...extra });
}
const frame = (l, t, r, b, w, h) => (x, y) => (x < l || x >= w - r || y < t || y >= h - b ? 255 : 0);
const unb64 = (s) => Buffer.from(String(s), "base64");

async function runEdit(v, req, extra = {}, server = {}) {
    const s = fakeServer(server);
    const ctx = ctxFor(s, extra);
    let out = null, err = null;
    try { out = await mag.edit(req, ctx); } catch (e) { err = String(e.message || e); ERRORS.push(err); }
    return { s, ctx, out, err, body: s.posts[0] && s.posts[0].body };
}
async function runText(v, req, extra = {}, server = {}) {
    const s = fakeServer(server);
    const ctx = ctxFor(s, extra);
    let out = null, err = null;
    try { out = await mag.generate(req, ctx); } catch (e) { err = String(e.message || e); ERRORS.push(err); }
    return { s, ctx, out, err, body: s.posts[0] && s.posts[0].body };
}

async function main() {
    const ROUTES = mag._routes;

    // ---- 1. the route table ----
    await section("1. the route table", async () => {
        const bad = [];
        for (const [route, R] of Object.entries(ROUTES)) {
            if (!R.label || !R.dialect) bad.push(`${route}: no label or dialect`);
            if (R.upscale && (R.edit || R.text)) bad.push(`${route}: an upscaler that edits`);
            if (!R.upscale && !R.edit && !R.text) bad.push(`${route}: does nothing`);
            if (!R.upscale && !mag._dialects[R.dialect]) bad.push(`${route}: no dialect ${R.dialect}`);
            if (!R.upscale && !Array.isArray(R.accepts)) bad.push(`${route}: no accepts`);
            if (R.fill && !R.edit) bad.push(`${route}: fill but no edit`);
            if (!fs.existsSync(path.join(REFS, route.replace(/\//g, "_") + ".json"))) bad.push(`${route}: no schema copy`);
            for (const k of R.accepts || []) if (!(k in (flat(schemaOf(route)).properties || {}))) bad.push(`${route}: accepts ${k}, which its schema does not name`);
        }
        check("every route: a label, a dialect of its own, what it does, a schema copy; every accepted key is in the route's schema", !bad.length && Object.isFrozen(ROUTES), bad.join(" | "));
        const s = fakeServer();
        const e1 = await throws(() => mag.edit({ ...editReq(variant("flux2_pro")), model: "constructor" }, ctxFor(s)));
        const e2 = await throws(() => mag.edit({ ...editReq(variant("flux2_pro")), model: "../mystic" }, ctxFor(s)));
        const e3 = await throws(() => mag.generate({ ...textReq(variant("flux2_pro")), model: "v1/ai/../x" }, ctxFor(s)));
        const e4 = await throws(() => mag.upscale({ ...editReq(variant("flux2_pro")), kind: "upscale", factor: 2 }, ctxFor(s)));
        check("constructor, ../mystic and v1/ai/../x are no routes; an image route is no upscaler; nothing is sent", /knows no route "constructor"/.test(e1 || "") && /knows no route "\.\.\/mystic"/.test(e2 || "") && /knows no route "\.\.\/x"/.test(e3 || "") && /no upscaler route "text-to-image\/flux-2-pro"/.test(e4 || "") && s.calls.length === 0, short([e1, e2, e3, e4]));
        const r = await runEdit(null, editReq(variant("flux2_pro"), { model: "/v1/ai/text-to-image/flux-2-pro/" }));
        check("a model id with /v1/ai/ and slashes around it is the same route", !r.err && r.s.posts[0].url === `${BASE}/v1/ai/text-to-image/flux-2-pro`, r.err || r.s.posts[0].url);
    });

    // ---- 2. every shipped variant's bodies against the schemas ----
    await section("2. schemas", async () => {
        const bad = [];
        let n = 0;
        for (const r of loadRecipes().filter((x) => x.providers && x.providers.magnific && x.task !== "upscale")) {
            const v = r.providers.magnific;
            if (v.edit !== false) {
                const R = ROUTES[v.model.replace(/^\/+/, "")];
                let req;
                if (R.dialect === "expand") req = maskedReq(v, 640, 480, frame(40, 30, 40, 30, 640, 480));
                else if (R.dialect === "ideogram") req = maskedReq(v, 320, 240, (x, y) => (x > 100 && x < 200 && y > 80 && y < 160 ? 255 : 0), { references: [pngOf(512, 512, 64, "REF1")] });
                else req = editReq(v, { references: [pngOf(512, 512, 64, "REF1")] });
                const x = await runEdit(v, req);
                if (x.err) { bad.push(`${r.id} edit: ${x.err}`); continue; }
                const p = validate(schemaOf(v.model), x.body);
                if (p.length) bad.push(`${r.id} edit: ${p.slice(0, 3).join("; ")}`);
                n++;
            }
            if (v.text) {
                for (const [w, h] of [[2048, 1152], [1024, 1024], [768, 1024]]) {
                    const x = await runText(v, textReq(v, { width: w, height: h }));
                    if (x.err) { bad.push(`${r.id} text ${w}x${h}: ${x.err}`); continue; }
                    const p = validate(schemaOf(v.text.model), x.body);
                    if (p.length) bad.push(`${r.id} text ${w}x${h}: ${p.slice(0, 3).join("; ")}`);
                    n++;
                }
            }
        }
        check("every edit and text body of every shipped magnific variant holds against its route's published schema", !bad.length && n >= 30, bad.length ? bad.join(" | ") : `${n} bodies`);
    });

    // ---- 3. instruction edits ----
    await section("3. instruction edits", async () => {
        const sp = variant("seedream_5_pro");
        const refs = [pngOf(512, 512, 64, "REF1"), pngOf(600, 400, 64, "REF2")];
        let x = await runEdit(sp, editReq(sp, { references: refs }));
        const imgs = (x.body || {}).reference_images || [];
        check("Seedream 5.0 Pro: the crop first, the references after, plain base64", !x.err && imgs.length === 3 && tagOf(unb64(imgs[0])) === "CROP" && tagOf(unb64(imgs[1])) === "REF1" && tagOf(unb64(imgs[2])) === "REF2" && !imgs.some((s) => /^data:/.test(s)), x.err || short(imgs.map((s) => s.slice(0, 12))));
        check("the instruction prompt names the references; no mask field; the aspect preset from the emitted 1024 x 576; its resolution row", x.body.prompt === "Edit the first image and keep its size and framing. a red door The remaining images are reference material." && !("mask" in x.body) && x.body.aspect_ratio === "widescreen_16_9" && x.body.resolution === "2k" && x.out.info.fit === "stretch" && x.out.info.aspect === "16:9", short({ ...x.body, reference_images: undefined, info: x.out.info }));
        x = await runEdit(sp, editReq(sp, { width: 1024, height: 640 }));
        check("1024 x 640 is nearest 3:2 but more than 3 % off it: no stretch (the stitch centre-crops)", x.body.aspect_ratio === "standard_3_2" && x.out.info.fit === null, short(x.out && x.out.info));
        x = await runEdit(sp, editReq(sp, { width: 1024, height: 690 }));
        check("1024 x 690 is within 3 % of 3:2: stretched", x.body.aspect_ratio === "standard_3_2" && x.out.info.fit === "stretch", short(x.out && x.out.info));
        const lite = variant("seedream_5_lite");
        x = await runEdit(lite, editReq(lite, { references: Array.from({ length: 5 }, (_, i) => pngOf(512, 512, 64, "R" + i)) }));
        check("six pictures to a five-picture route: refused in words, nothing sent", /takes at most 5 pictures; this run has 6/.test(x.err || "") && x.s.calls.length === 0, x.err);
        x = await runEdit(sp, editReq(sp, { image: pngOf(1024, 576, 11e6, "BIG") }));
        check("an opaque crop over 10 MB goes as JPEG", !x.err && tagOf(unb64(x.body.reference_images[0])) === "JPEG" && unb64(x.body.reference_images[0])[0] === 0xff, x.err);
        x = await runEdit(sp, editReq(sp, { image: pngOf(1024, 576, 11e6, "BIG") }), { opaque: () => false });
        check("one with transparency is refused, nothing sent", /it has transparency, so it stays PNG/.test(x.err || "") && x.s.calls.length === 0, x.err);
        x = await runEdit(sp, editReq(sp, { references: [pngOf(200, 300, 64, "SMALL")] }));
        check("a Seedream reference under 256 x 256 is refused, nothing sent", /reference 1 is 200 × 300, under the 256 × 256 Seedream takes/.test(x.err || "") && x.s.calls.length === 0, x.err);
        const g = variant("gpt_image_2");
        x = await runEdit(g, editReq(g, { width: 1536, height: 1024 }));
        check("GPT Image 2: its aspect preset from the emitted size, 2k, quality and moderation, png, one image", !x.err && x.body.aspect_ratio === "standard_3_2" && x.body.resolution === "2k" && x.body.quality === "high" && x.body.moderation === "auto" && x.body.output_format === "png" && x.body.num_images === 1 && x.out.info.fit === "stretch", x.err || short({ ...x.body, reference_images: undefined }));
        const fl = variant("gpt_image_2_5_flare");
        x = await runEdit(fl, editReq(fl, { width: 1024, height: 768 }));
        check("GPT Image 2.5: aspect auto at 1k whatever the crop, the variant fixed, stretched with the crop alone", !x.err && x.body.aspect_ratio === "auto" && x.body.resolution === "1k" && x.body.variant === "flare" && x.body.background === "auto" && x.body.quality === "high" && x.out.info.fit === "stretch", x.err || short({ ...x.body, reference_images: undefined }));
        x = await runEdit(fl, editReq(fl, { width: 1000, height: 560 }));
        check("... but an answer that did not keep the crop's shape (1024 x 768 for 1000 x 560) is not stretched", !x.err && x.body.aspect_ratio === "auto" && x.out.info.fit === null, x.err || short(x.out.info));
        x = await runEdit(fl, editReq(fl, { references: [pngOf(512, 512, 64, "REF1")], params: { ...defaults(fl.settings, fl.fixed), resolution: "4k" } }));
        check("... with a reference: no stretch, and a resolution row cannot move the 1k", !x.err && x.body.resolution === "1k" && x.out.info.fit === null, x.err || short(x.out.info));
        x = await runEdit(sp, editReq(sp, { params: { resolution: "1.5k", bogus: 1, webhook_url: "https://evil.example/hook", filter_nsfw: false, num_images: 4 } }));
        check("the allowlist: a key the route does not accept never goes out (webhook_url, filter_nsfw and num_images included)", !x.err && x.body.resolution === "1.5k" && !["bogus", "webhook_url", "filter_nsfw", "num_images"].some((k) => k in x.body), x.err || short(Object.keys(x.body)));
        const fp = variant("flux2_pro");
        x = await runEdit(fp, editReq(fp, { params: { ...defaults(fp.settings), random_seed: true } }));
        const y = await runEdit(fp, editReq(fp, { seed: 4294967295 }));
        check("the seed: left out with Random seed on, the full 32 bits on FLUX", !x.err && !("seed" in x.body) && y.body.seed === 4294967295, short([x.body && x.body.seed, y.body && y.body.seed]));
        x = await runEdit(fp, editReq(fp, { references: [pngOf(512, 512, 64, "R1"), pngOf(512, 512, 64, "R2")], width: 1440, height: 800 }));
        check("FLUX.2 [pro]: input_image, input_image_2 and _3, the emitted size, prompt upsampling", !x.err && tagOf(unb64(x.body.input_image)) === "CROP" && tagOf(unb64(x.body.input_image_3)) === "R2" && !("input_image_4" in x.body) && x.body.width === 1440 && x.body.height === 800 && x.body.prompt_upsampling === false && x.out.info.fit === "stretch", x.err || short({ ...x.body, input_image: 1, input_image_2: 1, input_image_3: 1 }));
        x = await runEdit(fp, editReq(fp, { references: Array.from({ length: 4 }, (_, i) => pngOf(64, 64, 64, "R" + i)) }));
        check("FLUX.2: a fifth picture is refused", /takes at most 4 pictures; this run has 5/.test(x.err || "") && x.s.calls.length === 0, x.err);
        x = await runEdit(sp, editReq(sp, { prompt: "   " }));
        check("an edit without a prompt is refused before anything is sent", /an edit needs a prompt/.test(x.err || "") && x.s.calls.length === 0, x.err);
    });

    // ---- 4. text runs ----
    await section("4. text runs", async () => {
        const run = async (id, extra) => { const v = variant(id); return runText(v, textReq(v, extra)); };
        let x = await run("seedream_5_pro", { width: 2048, height: 1152 });
        let y = await run("seedream_5_pro", { width: 1536, height: 1536, params: { resolution: "2k" } });
        const z = await run("seedream_5_lite", { width: 2048, height: 1152 });
        check("Seedream: the preset from the size, the tier from the long side (not from the edit row), no tier where the route has none", x.body.aspect_ratio === "widescreen_16_9" && x.body.resolution === "2k" && y.body.aspect_ratio === "square_1_1" && y.body.resolution === "1.5k" && !("resolution" in z.body) && z.body.enable_safety_checker === true, short([x.body, y.body, z.body]));
        x = await run("gpt_image_2", { width: 1024, height: 1024 });
        y = await run("gpt_image_2", { width: 3000, height: 2000 });
        check("GPT Image 2: 1k for 1024, 4k for 3000, the preset of 3:2, the edit's resolution row not sent", x.body.resolution === "1k" && x.body.aspect_ratio === "square_1_1" && y.body.resolution === "4k" && y.body.aspect_ratio === "standard_3_2" && x.body.output_format === "png", short([x.body, y.body]));
        x = await run("gpt_image_2_5_sunburst", { width: 2048, height: 1152, aspect: "16:9" });
        check("GPT Image 2.5: a preset (not auto), the tier, the variant", x.body.aspect_ratio === "widescreen_16_9" && x.body.resolution === "2k" && x.body.variant === "sunburst", short(x.body));
        x = await run("mystic", { width: 2048, height: 1152 });
        check("Mystic: 2k, 16:9, its four rows, no seed", x.body.resolution === "2k" && x.body.aspect_ratio === "widescreen_16_9" && x.body.model === "realism" && x.body.engine === "automatic" && x.body.creative_detailing === 33 && x.body.fixed_generation === false && !("seed" in x.body), short(x.body));
        const m = variant("mystic");
        x = await runText(m, textReq(m, { aspect: "7:3", width: 2800, height: 1200, params: { ...defaults(m.settings), model: "fluid" } }));
        y = await runText(m, textReq(m, { aspect: "7:3", width: 2800, height: 1200 }));
        check("Mystic: a free 7:3 goes to 16:9 on fluid (its five shapes) and to 20:9 on the others", x.body.aspect_ratio === "widescreen_16_9" && y.body.aspect_ratio === "smartphone_horizontal_20_9" && x.body.resolution === "4k", short([x.body.aspect_ratio, y.body.aspect_ratio]));
        const zi = await Promise.all([[512, 512], [1024, 1024], [500, 400], [1024, 576], [576, 1024]].map(([w, h]) => run("z_image_turbo", { width: w, height: h })));
        check("Z-Image: square only at 512 or less and square, else the nearest of the five; steps, the safety checker, png", eq(zi.map((r) => r.body.image_size), ["square", "square_hd", "landscape_4_3", "landscape_16_9", "portrait_9_16"]) && zi[0].body.num_inference_steps === 8 && zi[0].body.output_format === "png" && zi[0].body.seed === 7, short(zi.map((r) => r.body.image_size)));
        x = await run("flux2_pro", { width: 3000, height: 2000 });
        y = await run("flux2_pro", { width: 100, height: 100 });
        const f2 = await run("flux2_flex", { width: 1000, height: 1000 });
        check("FLUX.2 text: the long side held to 1440 (flex 1920), 256 at least, sides in 16s", x.body.width === 1440 && x.body.height === 960 && y.body.width === 256 && y.body.height === 256 && f2.body.width === 1008 && f2.body.output_format === "png" && f2.body.steps === 50 && !("input_image" in x.body), short([x.body.width, x.body.height, y.body.width, f2.body.width]));
        x = await run("mystic", { prompt: "  " });
        check("a new image without a prompt is refused before anything is sent", /a new image needs a prompt/.test(x.err || "") && x.s.calls.length === 0, x.err);
        const e1 = await runEdit(null, editReq(variant("mystic"), { model: "mystic" }));
        const e2 = await runText(null, textReq(variant("flux2_pro"), { model: "text-to-image/seedream-v5-pro-edit" }));
        check("a text-only route refuses an edit, an edit-only route a text run", /makes pictures from the prompt alone: use Generate new/.test(e1.err || "") && /needs a picture: use Generate/.test(e2.err || "") && e1.s.calls.length + e2.s.calls.length === 0, short([e1.err, e2.err]));
    });

    // ---- 5. Ideogram ----
    await section("5. Ideogram", async () => {
        const v = variant("ideogram_inpaint");
        const W = 256, H = 2;
        let x = await runEdit(v, maskedReq(v, W, H, (xx) => xx, { seed: 4294967295 }));
        const mask = codec.bitmap(unb64((x.body || {}).mask || ""));
        let exact = !!mask && mask.width === W && mask.height === H;
        for (let i = 0; exact && i < W * H; i++) { const want = (i % W) >= 128 ? 0 : 255; exact = mask.data[i * 4] === want && mask.data[i * 4 + 1] === want && mask.data[i * 4 + 2] === want && mask.data[i * 4 + 3] === 255; }
        check("the mask inverted exactly: a grey ramp at 128 and above black (edit), below white (keep), opaque", !x.err && exact, x.err || short(mask && [...mask.data.subarray(127 * 4, 130 * 4)]));
        check("the picture as sent, the prompt as written, the three rows, the seed wrapped to 2^31-1, stretched", !x.err && Buffer.compare(unb64(x.body.image), x.s.posts.length && maskedReq(v, W, H, (xx) => xx).image) === 0 && x.body.prompt === "a red door" && x.body.rendering_speed === "DEFAULT" && x.body.magic_prompt === "OFF" && x.body.style_type === "AUTO" && x.body.seed === 2147483647 && x.out.info.fit === "stretch", x.err || short({ ...x.body, image: 1, mask: 1 }));
        x = await runEdit(v, maskedReq(v, 64, 64, () => 255, { references: [pngOf(512, 512, 64, "S1")] }));
        check("references go as style_reference_images", !x.err && x.body.style_reference_images.length === 1 && tagOf(unb64(x.body.style_reference_images[0])) === "S1", x.err);
        x = await runEdit(v, maskedReq(v, 64, 64, () => 255, { references: [pngOf(512, 512, 6e6, "S1"), pngOf(512, 512, 6e6, "S2")] }));
        check("style references over 10 MB together are refused, nothing sent", /style references are 12\.0 MB together, more than the 10 MB/.test(x.err || "") && x.s.calls.length === 0, x.err);
        x = await runEdit(v, { ...maskedReq(v, 64, 64, () => 255), mask: maskPng(32, 64, () => 255) });
        check("a mask of another size is refused, nothing sent", /the mask is 32 × 64 and the picture 64 × 64/.test(x.err || "") && x.s.calls.length === 0, x.err);
        x = await runEdit(v, { ...maskedReq(v, 64, 64, () => 255), kind: "edit" });
        check("an edit without the mask (input edit) is refused", /needs the selection as a mask/.test(x.err || "") && x.s.calls.length === 0, x.err);
        const s = fakeServer();
        const e = await throws(() => mag._invertedMask(maskPng(8, 8, () => 0), imagePng(8, 8), { bitmap: codec.bitmap }, "Ideogram"));
        check("no codec in the context: refused in words", /cannot read the mask/.test(e || "") && s.calls.length === 0, e);
    });

    // ---- 6. Image Expand ----
    await section("6. Image Expand", async () => {
        const W = 100, H = 80;
        const kr = (fn) => { try { return mag._keptRect(greyOf(W, H, fn)); } catch (err) { return { err: String(err.message) }; } };
        const cases = [
            ["frame on all sides", frame(10, 8, 10, 8, W, H), { left: 10, top: 8, right: 10, bottom: 8 }],
            ["right strip only", (x) => (x >= 80 ? 255 : 0), { left: 0, top: 0, right: 20, bottom: 0 }],
            ["top and left", (x, y) => (x < 15 || y < 12 ? 255 : 0), { left: 15, top: 12, right: 0, bottom: 0 }],
            ["feathered frame", (x, y) => { const d = Math.min(x - 20, 79 - x, y - 16, 63 - y); return d < 0 ? 255 : Math.max(0, 255 - d * 50); }, { left: 23, top: 19, right: 23, bottom: 19 }],
            // what Feather on auto sends: a box blur (radius 6) of the frame rounds the kept box's inner corners, 2.4 % of
            // the box at 128 and over, none of it over 3/4
            ["blurred frame (rounded inner corners)", (x, y) => { const f = (c, lo, hi) => { let n = 0; for (let i = c - 6; i <= c + 6; i++) if (i >= lo && i < hi) n++; return n / 13; }; return Math.round(255 * (1 - f(x, 20, 80) * f(y, 16, 64))); }, { left: 20, top: 16, right: 20, bottom: 16 }],
            ["blob in the middle", (x, y) => ((x - 50) ** 2 + (y - 40) ** 2 < 100 ? 255 : 0), /not a border \(4 %/],
            ["notch at the edge", (x, y) => (x >= 80 || (x >= 40 && x < 60 && y < 20) ? 255 : 0), /not a border/],
            ["everything selected", () => 255, /nothing is kept/],
            ["nothing selected", () => 0, /reaches no edge of the crop/],
        ];
        for (const [name, fn, want] of cases) {
            const r = kr(fn);
            const ok = want instanceof RegExp ? !!r.err && want.test(r.err) && /Image › Extend canvas/.test(r.err) : !r.err && eq(r.margins, want) && r.width === W - want.left - want.right && r.height === H - want.top - want.bottom;
            check(`keptRect, ${name}: ${want instanceof RegExp ? "refused" : "accepted, the margins exact"}`, ok, short(r));
        }
        const v = variant("expand_flux_pro");
        const req = maskedReq(v, 600, 400, frame(50, 40, 70, 30, 600, 400), { references: [pngOf(64, 64, 64, "REF")] });
        let x = await runEdit(v, req);
        const kept = codec.cropPng(req.image, { x: 50, y: 40, width: 480, height: 330 });
        check("FLUX Pro Expand: the kept rectangle cut out of the crop byte for byte, the four margins, no mask, the prompt, no seed", !x.err && Buffer.compare(unb64(x.body.image), kept) === 0 && x.body.left === 50 && x.body.top === 40 && x.body.right === 70 && x.body.bottom === 30 && !("mask" in x.body) && x.body.prompt === "a red door" && !("seed" in x.body), x.err || short({ ...x.body, image: 1 }));
        check("the answer is stretched onto the crop; the references are left out with a log line", x.out && x.out.info.fit === "stretch" && eq(x.out.info.margins, { left: 50, top: 40, right: 70, bottom: 30 }) && x.ctx.logs.some((l) => /takes no reference pictures/.test(l)), short(x.out && x.out.info));
        x = await runEdit(v, maskedReq(v, 400, 300, (xx) => (xx >= 350 ? 255 : 0), { prompt: "" }));
        check("one strip: all four edges are sent (0 where nothing grows: FLUX puts 512 / 256 on a missing one); an empty prompt is left out", !x.err && x.body.left === 0 && x.body.top === 0 && x.body.bottom === 0 && x.body.right === 50 && !("prompt" in x.body), x.err || short({ ...x.body, image: 1 }));
        x = await runEdit(v, maskedReq(v, 400, 300, frame(100, 100, 100, 100, 400, 300)));
        check("FLUX Pro Expand refuses a kept part under 256 px a side", /the kept part is 200 × 100 .*under the 256 px/.test(x.err || "") && x.s.calls.length === 0, x.err);
        const vi = variant("expand_ideogram");
        x = await runEdit(vi, maskedReq(vi, 2600, 300, (xx) => (xx >= 500 ? 255 : 0)));
        check("a margin over 2048 px is refused", /a margin of 2100 px \(right\).*over Image Expand's 2048/.test(x.err || "") && x.s.calls.length === 0, x.err);
        x = await runEdit(vi, maskedReq(vi, 400, 300, frame(20, 20, 20, 20, 400, 300)));
        check("Ideogram Expand sends the seed", !x.err && x.body.seed === 7, x.err);
        const vs = variant("expand_seedream_4_5");
        x = await runEdit(vs, maskedReq(vs, 1800, 1500, (xx) => (xx >= 1700 ? 255 : 0)));
        check("Seedream 4.5 Expand: a kept part over 10 MB goes as JPEG", !x.err && tagOf(unb64(x.body.image)) === "JPEG" && x.out.info.format === "jpeg", x.err);
        x = await runEdit(vs, maskedReq(vs, 1800, 1500, (xx) => (xx >= 1700 ? 255 : 0)), { opaque: () => false });
        check("... and is refused when it has transparency", /kept part is 10\.2 MB.*it has transparency/.test(x.err || "") && x.s.calls.length === 0, x.err);
        x = await runEdit(v, maskedReq(v, 400, 300, (xx, yy) => ((xx - 200) ** 2 + (yy - 150) ** 2 < 900 ? 255 : 0)));
        check("through edit(): a selection that is no border is refused before anything is sent", /not a border/.test(x.err || "") && x.s.calls.length === 0, x.err);
    });

    // ---- 7. the task client ----
    await section("7. the task client", async () => {
        const v = variant("seedream_5_lite");
        let x = await runEdit(v, editReq(v));
        check("POST the route, read <route>/<task id> until COMPLETED, then download the answer; 3 s between reads",
            !x.err && eq(x.s.calls.map((c) => `${c.method} ${c.url}`), [`POST ${BASE}/v1/ai/text-to-image/seedream-v5-lite-edit`, `GET ${BASE}/v1/ai/text-to-image/seedream-v5-lite-edit/${TID}`, `GET ${BASE}/v1/ai/text-to-image/seedream-v5-lite-edit/${TID}`, `GET ${BASE}/asset/out.png`]) && eq(x.ctx.waits, [3000, 3000]), x.err || short(x.s.calls.map((c) => c.url)));
        check("the answer: its bytes, PNG, the task, the size read from it", tagOf(x.out.bytes) === "RESULT" && x.out.mime === "image/png" && x.out.info.task === TID && x.out.info.width === 1024 && x.out.info.height === 768 && x.out.info.route === "text-to-image/seedream-v5-lite-edit" && x.out.info.pictures === 1, short(x.out.info));
        x = await runEdit(v, editReq(v), {}, { poll: [() => task("FAILED")] });
        check("FAILED ends the run and says Magnific names no reason", /the task failed \(046b6c7f.*\); Magnific names no reason/.test(x.err || ""), x.err);
        x = await runEdit(v, editReq(v), {}, { poll: [() => task("COMPLETED", [])] });
        check("COMPLETED without a picture is an error", /names no picture/.test(x.err || ""), x.err);
        x = await runEdit(v, editReq(v), {}, { post: [() => json(200, { data: { task_id: "../../v1/stock", status: "CREATED" } })] });
        check("a task id that is not an id never goes into a URL", /unexpected task id/.test(x.err || "") && x.s.calls.length === 1, x.err);
        const slow = { poll: Array.from({ length: 400 }, () => () => task("IN_PROGRESS")) };
        let clock = 0;
        x = await runEdit(v, editReq(v), { now: () => clock, sleep: async (ms) => { clock += ms * 50; } }, slow);
        check("an edit gives up after 15 minutes and says it may still be billed", /no answer after 15 minutes \(task .*\); it may still finish and be billed/.test(x.err || ""), x.err);
        clock = 0;
        const up = loadRecipes().find((r) => r.id === "magnific_precision").providers.magnific;
        const su = fakeServer(slow);
        const eu = await throws(() => mag.upscale({ model: up.model, kind: "upscale", image: pngOf(64, 64), factor: 2, params: {}, options: up.options }, ctxFor(su, { now: () => clock, sleep: async (ms) => { clock += ms * 50; } })));
        check("an upscale waits 30 minutes", /no answer after 30 minutes/.test(eu || ""), eu);
        const e500 = () => json(500, { message: "oops" });
        x = await runEdit(v, editReq(v), {}, { poll: [e500, e500, e500, e500, e500] });
        check("five failed status reads in a row end the run", /status reads failed 5 times in a row; the task \(.*\) may still finish/.test(x.err || "") && x.s.polls.length === 5, x.err);
        const net = () => { throw new Error("socket hang up"); };
        x = await runEdit(v, editReq(v), {}, { poll: [e500, net, e500, e500, () => task("IN_PROGRESS"), e500, net, e500, e500] });
        check("the count starts again after a good read (a network error counts too)", !x.err && x.s.polls.length === 11, x.err || String(x.s.polls.length));
        x = await runEdit(v, editReq(v), {}, { poll: [() => json(404, { message: "Not found" })] });
        check("a 4xx on a status read ends the run at once", /status: Magnific does not know this route or task/.test(x.err || "") && x.s.polls.length === 1, x.err);
        x = await runEdit(v, editReq(v), {}, { poll: [() => task("COMPLETED", ["http://x.example/out.png"])] });
        check("an answer on plain http is not fetched", /points to "http:\/\/x\.example\/out\.png", which Scumble does not fetch/.test(x.err || "") && x.s.assets.length === 0, x.err);
        x = await runEdit(v, editReq(v), {}, { poll: [() => task("COMPLETED", [`data:image/png;base64,${RESULT.toString("base64")}`])] });
        check("a data: picture is taken", !x.err && tagOf(x.out.bytes) === "RESULT" && x.s.assets.length === 0, x.err);
        x = await runEdit(v, editReq(v), { key: REAL_KEY, base: undefined }, { poll: [() => task("COMPLETED", [`${BASE}/asset/out.png`])] });
        check("the mock's host is taken only in test mode", /which Scumble does not fetch/.test(x.err || "") && x.s.assets.length === 0, x.err);
        x = await runEdit(v, editReq(v), {}, { poll: [() => task("COMPLETED", [`${BASE}/asset/out.png`])], asset: [e500, net] });
        check("a download that fails on the server's side or the line is tried again, up to three times, without the key", !x.err && x.s.assets.length === 3 && x.s.assets.every((c) => !c.headers["x-magnific-api-key"]), x.err || String(x.s.assets.length));
        x = await runEdit(v, editReq(v), {}, { poll: [() => task("COMPLETED", [`${BASE}/asset/out.png`])], asset: [e500, e500, e500] });
        check("... and then it is the error", /the result download answered 500/.test(x.err || "") && x.s.assets.length === 3, x.err);
        x = await runEdit(v, editReq(v), {}, { poll: [() => task("COMPLETED", [`${BASE}/asset/out.png`])], asset: [() => json(403, {})] });
        check("a 403 on the download: the link was refused, not tried again", /result link was refused \(expired\?\)/.test(x.err || "") && x.s.assets.length === 1, x.err);
        const m = variant("mystic");
        x = await runText(m, textReq(m), {}, { poll: [() => task("COMPLETED", [`${BASE}/asset/out.png`], { has_nsfw: [true] })] });
        check("Mystic's has_nsfw goes to the log and info; the picture is still used", !x.err && x.out.info.nsfw === true && x.ctx.logs.some((l) => /has_nsfw/.test(l)) && tagOf(x.out.bytes) === "RESULT", x.err || short(x.out.info));
    });

    // ---- 8. errors ----
    await section("8. errors", async () => {
        const v = variant("gpt_image_2");
        const cases = [
            [400, { message: `Bad request for ${KEY}` }, /: request refused - Bad request for \[key\]$/, 1],
            [400, { problem: { message: "Validation error", invalid_params: [{ name: "prompt", reason: `is required ${KEY}` }] } }, /request refused - Validation error \(prompt: is required \[key\]\)/, 1],
            [401, { message: `Invalid API key ${KEY}` }, /key refused - Invalid API key \[key\]/, 1],
            [402, { message: "Not enough credits" }, /no credits left on the Magnific account - Not enough credits/, 1],
            [403, { message: "Forbidden" }, /access refused - Forbidden/, 1],
            [404, { message: "Not found" }, /Magnific does not know this route or task \(the API may have changed; an update of Scumble may be needed\) - Not found/, 1],
            [500, { message: "Internal" }, /the service failed - Internal/, 1],
            [503, { message: "Service Unavailable" }, /the service failed - Service Unavailable/, 2],
        ];
        for (const [status, body, re, calls] of cases) {
            const x = await runEdit(v, editReq(v), {}, { post: [() => json(status, body), () => json(status, body)] });
            check(`${status}${body.problem ? " (problem shape)" : ""}: the words, the server's message, no key, ${calls} call${calls > 1 ? "s" : ""}`, re.test(x.err || "") && x.err.startsWith("Magnific text-to-image/gpt-image-2-edit: ") && !x.err.includes(KEY) && x.s.calls.length === calls, x.err);
        }
        let x = await runEdit(v, editReq(v), {}, { post: [() => json(429, { message: "slow" }, { "retry-after": "1" })] });
        check("429: waits exactly the Retry-After and sends once more", !x.err && x.s.posts.length === 2 && x.ctx.waits[0] === 1000, x.err || short(x.ctx.waits));
        x = await runEdit(v, editReq(v), {}, { post: [() => json(429, { message: "slow" }, { "retry-after": "1" }), () => json(429, { message: "slow" }, { "retry-after": "1" })] });
        check("429 twice: the error", /rate limited - slow/.test(x.err || "") && x.s.posts.length === 2, x.err);
        x = await runEdit(v, editReq(v), {}, { post: [() => json(503, { message: "later" }, { "retry-after": "120" })] });
        check("a wait over a minute is not waited: one call, try again in 120 s", /the service failed - later; try again in 120 s/.test(x.err || "") && x.s.calls.length === 1 && !x.ctx.waits.length, x.err);
        x = await runEdit(v, editReq(v), {}, { post: [() => { throw new Error("ECONNRESET"); }] });
        check("a network error on the POST is not sent again (the task may exist)", /no answer from Magnific \(ECONNRESET\); the task may still have been made/.test(x.err || "") && x.s.calls.length === 1, x.err);
        check("_explain reads both error shapes and takes the key out", mag._explain(402, JSON.stringify({ message: "x " + KEY }), KEY) === "no credits left on the Magnific account - x [key]" && mag._explain(400, JSON.stringify({ problem: { message: "Validation error", invalid_params: [{ field: "seed", reason: "too big" }] } }), KEY) === "request refused - Validation error (seed: too big)");
    });

    // ---- 9. host and key ----
    await section("9. host and key", async () => {
        check("only a loopback mock may be named", mag._testBase(BASE) === BASE && mag._testBase("https://evil.example") === null && mag._testBase(BASE + "/v1") === null && mag._testBase("http://localhost:5578") === null && mag._testBase("http://127.0.0.1") === null && mag.baseUrl({ magnific: { base: BASE } }) === BASE && mag.baseUrl({}) === null);
        const v = variant("flux2_pro"), up = loadRecipes().find((r) => r.id === "magnific_precision").providers.magnific;
        const upReq = { model: up.model, kind: "upscale", image: pngOf(64, 64), factor: 2, params: {}, options: up.options };
        const bad = [];
        for (const [name, key, base, re] of [["a real key to the mock", REAL_KEY, BASE, /only a test key goes there/], ["a test key to Magnific", KEY, undefined, /test key is never sent to Magnific/]]) {
            for (const [what, fn] of [["edit", (c) => mag.edit(editReq(v), c)], ["generate", (c) => mag.generate(textReq(v), c)], ["upscale", (c) => mag.upscale(upReq, c)]]) {
                const s = fakeServer();
                const e = await throws(() => fn(ctxFor(s, { key, base })));
                if (!re.test(e || "") || s.calls.length) bad.push(`${name}, ${what}: ${e}, ${s.calls.length} calls`);
            }
        }
        check("the test-key rule both ways on edit, generate and upscale, before any call", !bad.length, bad.join(" | "));
        const x = await runEdit(v, editReq(v), { key: REAL_KEY, base: undefined });
        check("a real key goes to https://api.magnific.com, the answer from its CDN", !x.err && x.s.posts[0].url === `${LIVE}/v1/ai/text-to-image/flux-2-pro` && x.s.posts[0].headers["x-magnific-api-key"] === REAL_KEY && x.s.assets[0].url === "https://ai-statics.freepik.com/out.png", x.err);
    });

    // ---- 10. the upscalers through the new client ----
    await section("10. upscale", async () => {
        const up = loadRecipes().find((r) => r.id === "magnific_precision").providers.magnific;
        const s = fakeServer();
        const ctx = ctxFor(s);
        const out = await mag.upscale({ model: up.model, kind: "upscale", image: pngOf(300, 200, 64, "UP"), factor: 2, params: defaults(up.settings, up.fixed), options: up.options }, ctx);
        const b = s.posts[0].body;
        check("Precision V2: its body, the round trip, the factor and task in info", b.scale_factor === 2 && b.flavor === "photo" && tagOf(unb64(b.image)) === "UP" && s.polls.length === 2 && out.info.factor === 2 && out.info.task === TID && tagOf(out.bytes) === "RESULT", short({ ...b, image: 1 }));
        check("Precision V2's body holds against its schema", !validate(schemaOf(up.model), b).length, short(validate(schemaOf(up.model), b)));
    });

    // ---- 11. the recipes ----
    await section("11. recipes", async () => {
        const recipes = loadRecipes();
        const served = recipes.filter((r) => r.providers && r.providers.magnific && r.task !== "upscale").map((r) => r.id).sort();
        const VARIANTS = ["flux2_flex", "flux2_pro", "gpt_image_2", "gpt_image_2_5_flare", "gpt_image_2_5_sunburst", "seedream_5_lite", "seedream_5_pro", "z_image_turbo"];
        const NEW = ["expand_flux_pro", "expand_ideogram", "expand_seedream_4_5", "ideogram_inpaint", "mystic", "seedream_4_5"];
        check("the magnific variants sit in exactly the eight recipes and the six new ones", eq(served, [...VARIANTS, ...NEW].sort()), served.join(", "));
        const bad = [];
        for (const id of served) {
            const r = recipes.find((x) => x.id === id), raw = rawRecipe(id), v = r.providers.magnific;
            const route = v.model, R = mag._routes[route];
            if (!R) { bad.push(`${id}: no route ${route}`); continue; }
            if (r.providerIds[r.providerIds.length - 1] !== "magnific") bad.push(`${id}: magnific is not last (${r.providerIds})`);
            if (r.default !== raw.default) bad.push(`${id}: the default moved`);
            if (NEW.includes(id) ? r.default !== "magnific" || !eq(r.providerIds, ["magnific"]) : r.default === "magnific") bad.push(`${id}: default ${r.default}`);
            if (!NEW.includes(id) && !/Also on Magnific\./.test(r.description || "")) bad.push(`${id}: the description does not say Also on Magnific`);
            if (!/^Runs on Magnific \(Freepik's API, api\.magnific\.com\) with the Magnific key; every API call costs credits, whatever the web plan says; not run against the live API yet\. /.test(v.note || "")) bad.push(`${id}: the note's opening`);
            if (!/Freepik Company S\.L\., Málaga, Spain/.test(v.note || "")) bad.push(`${id}: the note does not say where the pictures go`);
            if (!("text" in raw.providers.magnific)) bad.push(`${id}: the file names no text shape (text: false or { model })`);
            if (v.text && !(mag._routes[v.text.model] || {}).text) bad.push(`${id}: text.model ${v.text.model} is no text route`);
            if (v.edit !== false && !R.edit) bad.push(`${id}: model ${route} is no edit route`);
            if (v.edit === false && R.edit) bad.push(`${id}: edit false on an edit route`);
            if (R.fill && v.input !== "fill") bad.push(`${id}: input ${v.input} on a mask route`);
            if (!R.fill && v.edit !== false && v.input !== "edit") bad.push(`${id}: input ${v.input} on an instruction route`);
            const keys = [...(v.settings || []).map((s) => s.key), ...Object.keys(v.fixed || {})];
            const acc = new Set(R.accepts || []);
            if (v.edit !== false) for (const k of keys) if (!acc.has(k)) bad.push(`${id}: ${k} is not accepted by ${route}`);
            if (v.text) {
                const tacc = new Set(mag._routes[v.text.model].accepts || []);
                for (const k of [...(v.text.settings || []).map((s) => s.key), ...Object.keys(v.text.fixed || {})]) if (!tacc.has(k)) bad.push(`${id}: ${k} is not accepted by ${v.text.model}`);
            }
            const slots = (v.settings || []).map((s) => s.index);
            if (new Set(slots).size !== slots.length || slots.some((i) => !(i >= 1 && i <= 8))) bad.push(`${id}: slots ${slots}`);
            // the crop is widened to the presets only where an edit sends one (not GPT Image 2.5's auto, not a text-only route)
            const want = v.edit !== false && R.aspects && !R.auto ? Object.keys(R.aspects) : [];
            if (!eq(v.limits.aspects, want)) bad.push(`${id}: limits.aspects ${v.limits.aspects} against ${want}`);
        }
        check("each variant: last, the default kept, Also on Magnific, the note's opening and privacy sentence, a text shape of a text route, an edit route, every key accepted, one slot each, the route's presets as limits.aspects", !bad.length, bad.join(" | "));
        const lim = (id) => recipes.find((x) => x.id === id).providers.magnific.limits;
        check("the expand limits from the docs' output sizes", lim("expand_flux_pro").pixels === 1600000 && lim("expand_ideogram").step === 32 && lim("expand_ideogram").pixels === 1048576 && lim("expand_seedream_4_5").minPixels === 3686400 && lim("expand_seedream_4_5").max === 4096 && lim("flux2_flex").max === 1920 && lim("flux2_pro").max === 1440, short([lim("expand_flux_pro"), lim("expand_ideogram")]));
        check("no background row on GPT Image 2 (its route has no transparency), one on 2.5", !variant("gpt_image_2").settings.some((s) => s.key === "background") && variant("gpt_image_2_5_flare").settings.some((s) => s.key === "background"));
        check("the upscalers keep magnific as their home", ["magnific_precision", "magnific_creative"].every((id) => recipes.find((x) => x.id === id).default === "magnific"));
    });

    // ---- 12. providers/index.js ----
    await section("12. index.js", async () => {
        const idxPath = path.join(ROOT, "electron", "main", "providers", "index.js");
        const orig = Module._load;
        const stored = { magnific: KEY };
        const fakeImage = (b) => ({ isEmpty: () => false, getSize: () => ({ width: 2, height: 1 }), toBitmap: () => Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), toPNG: () => Buffer.from("PNG:" + b), crop: (r) => fakeImage(`crop ${r.x},${r.y},${r.width},${r.height}`), toJPEG: () => jpegOf(40, "NATIVE") });
        Module._load = function (request, parent, ...rest) {
            if (request === "electron") return { nativeImage: { createFromBuffer: () => fakeImage("buf"), createFromBitmap: (buf, o) => fakeImage(`bitmap ${buf.length} ${o.width}x${o.height}`) } };
            if (parent && parent.filename === idxPath) {
                if (request === "../log") return { record: () => {} };
                if (request === "../keys") return { get: (id) => stored[id] || "", describe: (id) => ({ name: id, set: !!stored[id] }) };
                if (request === "../settings") return { get: () => ({ magnific: { base: BASE } }) };
            }
            return orig.call(this, request, parent, ...rest);
        };
        let index;
        try { index = require(idxPath); } finally { Module._load = orig; }
        const row = index.describeAll().find((x) => x.id === "magnific");
        check("magnific is a text and an upscale provider; its key row has no balance and shares no key", index.textProviders().includes("magnific") && index.upscaleProviders().includes("magnific") && row && row.balance === false && row.sharesKey === null, short(row));
        let ctx = null;
        const keep = index.PROVIDERS.magnific.edit;
        index.PROVIDERS.magnific.edit = async (req, c) => { ctx = c; return { bytes: RESULT, mime: "image/png", info: {} }; };
        try { await index.edit({ provider: "magnific", kind: "fill", model: "ideogram-image-edit", image: new Uint8Array(RESULT), mask: new Uint8Array(RESULT), references: [], params: {} }); } finally { index.PROVIDERS.magnific.edit = keep; }
        const bm = ctx && ctx.bitmap(Buffer.from("x"));
        check("the context carries bitmap, fromBitmap and cropPng on nativeImage, and the mock base from the settings",
            !!ctx && ctx.base === BASE && ctx.key === KEY && bm && bm.width === 2 && bm.height === 1 && bm.data.length === 8 && String(ctx.fromBitmap({ width: 2, height: 1, data: bm.data })) === "PNG:bitmap 8 2x1" && String(ctx.cropPng(Buffer.from("x"), { x: 1, y: 2, width: 3, height: 4 })) === "PNG:crop 1,2,3,4", short(ctx && Object.keys(ctx)));
    });

    // ---- 13. the whole run ----
    const keyed = ALL_CALLS.filter((c) => c.headers["x-magnific-api-key"]);
    const api = ALL_CALLS.filter((c) => { const u = new URL(c.url); return u.pathname.startsWith("/v1/ai/") && (c.url.startsWith(BASE) || c.url.startsWith(LIVE)); });
    check("the key went on every /v1/ai/ call and on nothing else (never on a download)", ALL_CALLS.length > 150 && keyed.length === api.length && keyed.every((c) => api.includes(c)) && api.every((c) => c.headers["x-magnific-api-key"] === (c.url.startsWith(LIVE) ? REAL_KEY : KEY)), `${ALL_CALLS.length} calls, ${keyed.length} keyed, ${api.length} to the API`);
    check("neither key appears in any error of the run", ERRORS.length > 40 && !ERRORS.some((x) => x.includes(KEY) || x.includes(REAL_KEY)), `${ERRORS.length} errors`);

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + (err && err.stack || err)); console.log("FAIL"); process.exit(1); });
