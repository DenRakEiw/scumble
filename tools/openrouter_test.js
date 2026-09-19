// The OpenRouter adapter (electron/main/providers/openrouter.js) and llm.js's OpenRouter rows in plain Node, no
// Electron and no key:
//   node tools/openrouter_test.js
// A scripted fetch plays openrouter.ai (POST /api/v1/images, GET /api/v1/key, GET /api/v1/providers and, for
// llm.js, POST /api/v1/chat/completions); ctx.sleep records its waits instead of waiting. Every call of the whole
// run is recorded with all its headers, and the last check says that none of them carried an attribution header.
// The facts the checks rest on are OpenRouter's docs as read on 2026-09-19 (docs/RECIPES.md "OpenRouter"); nothing
// here talks to the live API.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const openrouter = require(path.join(ROOT, "electron", "main", "providers", "openrouter.js"));

// a test key goes to the loopback mock only, a real one never does (openrouter.js checkKey)
const KEY = "test-or-0123456789abcdef";
const REAL_KEY = "sk-or-v1-" + "0123456789abcdef".repeat(4);
const BASE = "http://127.0.0.1:5555";
const ALL_CALLS = [];   // every call of every section, for the attribution header check at the end

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 400 ? s.slice(0, 400) + " ..." : s; };

const EDIT_PREFIX = "Edit the first image and keep its size and framing.";
const FILL_PREFIX = "Edit the first image. The second image is a mask: change only the white area of the mask, keep everything else exactly as it is, and keep the image size and framing.";
const REF_ONE = "The remaining image is reference material.";
const REF_MANY = "The remaining images are reference material.";

/** A PNG as far as the adapter looks: the signature, a real IHDR (width, height, 8 bit, colour type) and padding. */
function pngOf(w, h, size = 64, tag = "", colour = 6) {
    const b = Buffer.alloc(Math.max(size, 33 + tag.length), 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    b[24] = 8;
    b[25] = colour;
    b.write(tag, 33, "latin1");
    return b;
}
const tagOf = (b) => Buffer.from(b).toString("latin1", 33, 33 + 12).replace(/\0+$/, "");
const RESULT = pngOf(1024, 1024, 80, "RESULT");

function fromDataUrl(url) {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(url || ""));
    return m ? { mime: m[1], bytes: Buffer.from(m[2], "base64") } : null;
}
const refsOf = (body) => (body && Array.isArray(body.input_references) ? body.input_references.map((r) => fromDataUrl(r && r.image_url && r.image_url.url)) : []);

// A /api/v1/providers answer: two hosts the dated list lacks (a CN headquarters, a CN datacentre), two it has, and
// hosts outside China. The codes are ISO 3166-1 alpha-2 as the docs say.
const PROVIDERS_LIST = [
    { name: "OpenAI", slug: "openai", headquarters: "US", datacenters: ["US"] },
    { name: "Black Forest Labs", slug: "black-forest-labs", headquarters: null, datacenters: [] },
    { name: "DeepSeek", slug: "deepseek", headquarters: "CN", datacenters: null },
    { name: "Alibaba", slug: "alibaba", headquarters: "SG", datacenters: ["SG", "CN"] },
    { name: "New CN HQ", slug: "newhost-cnhq", headquarters: "CN", datacenters: null },
    { name: "New CN DC", slug: "newhost-cndc", headquarters: "US", datacenters: ["US", "CN"] },
    { name: "Seed", slug: "seed", headquarters: "SG", datacenters: [] },
];
const EXPECT_IGNORE = [...new Set([...openrouter.CHINA_HOSTS, "newhost-cnhq", "newhost-cndc"])].sort();

function recordHeaders(init) {
    const h = {};
    for (const [k, v] of new Headers((init && init.headers) || {})) h[k.toLowerCase()] = v;
    return h;
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const okImage = (extra = {}) => json(200, { created: 1789000000, data: [{ b64_json: RESULT.toString("base64"), media_type: "image/png" }], usage: { cost: 0.04 }, ...extra });

/**
 * A fake openrouter.ai. `images` answers POST /api/v1/images in order (functions returning a Response, or
 * throwing for a network error); after the list runs out every image request succeeds. `providers` and `key`
 * replace the answers of GET /api/v1/providers and GET /api/v1/key. Every call is recorded with all its headers.
 */
function fakeServer(opts = {}) {
    const calls = [];
    const images = [];        // the parsed bodies of POST /api/v1/images
    const providerCalls = [];
    const answers = [...(opts.images || [])];
    async function fetch(url, init = {}) {
        const method = String(init.method || "GET").toUpperCase();
        const call = { url: String(url), method, headers: recordHeaders(init) };
        calls.push(call);
        ALL_CALLS.push(call);
        const u = new URL(String(url));
        if (u.pathname === "/api/v1/providers" && method === "GET") {
            providerCalls.push(call);
            return opts.providers ? opts.providers() : json(200, { data: PROVIDERS_LIST });
        }
        if (u.pathname === "/api/v1/images" && method === "POST") {
            images.push(JSON.parse(init.body));
            const a = answers.shift();
            if (a) return a();
            return okImage();
        }
        if (u.pathname === "/api/v1/key" && method === "GET") {
            return opts.key ? opts.key() : json(200, { data: { label: "sk-or-v1-012...def", limit: 20, limit_remaining: 12.5, limit_reset: null, usage: 7.5, is_free_tier: false } });
        }
        return json(404, { error: { code: 404, message: "no route " + u.pathname } });
    }
    return { fetch, calls, images, providerCalls };
}

function ctxFor(server, extra = {}) {
    const sleeps = [];
    const logs = [];
    return { key: KEY, base: BASE, fetch: server.fetch, log: (m) => logs.push(String(m)), sleep: async (ms) => { sleeps.push(ms); }, sleeps, logs, ...extra };
}

const RECIPES = path.join(ROOT, "recipes");
function rawRecipe(id) {
    return JSON.parse(fs.readFileSync(path.join(RECIPES, id + ".json"), "utf8"));
}
function variant(id) {
    return rawRecipe(id).providers.openrouter;
}

function editReq(v, extra = {}) {
    return {
        provider: "openrouter", model: v.model, kind: v.input === "edit" ? "edit" : "fill", options: v.options, fields: v.fields || null,
        prompt: "a red door", negative: "", seed: 42,
        image: pngOf(1536, 1024, 96, "CROP"), mask: pngOf(1536, 1024, 96, "MASK-LUMINANCE"), maskAlpha: pngOf(1536, 1024, 96, "MASK-ALPHA"),
        width: 1536, height: 1024, references: [], params: {}, ...extra,
    };
}
function textReq(v, extra = {}) {
    return {
        provider: "openrouter", model: (v.text && v.text.model) || v.model, kind: "text", options: v.options, fields: null,
        prompt: "a lighthouse at dusk", negative: "", seed: 7,
        image: null, mask: null, maskAlpha: null, references: [],
        width: 1024, height: 1024, aspect: null, params: {}, ...extra,
    };
}

/** A section that throws is a failed check, not the end of the run: the checks after it still report. */
async function section(name, fn) {
    try { await fn(); } catch (err) { check(name + " ran to its end", false, String(err && err.stack || err).split(/\r?\n/).slice(0, 3).join(" ")); }
}

async function throws(fn) {
    try { await fn(); } catch (err) { return String(err && err.message || err); }
    return null;
}

async function main() {
    // ---- 1. an edit: one request, its headers, the body, the answer ----
    await section("1. edit", async () => {
        openrouter._resetHosts();
        const v = variant("seedream_5_pro");   // edit input; accepts resolution, aspect_ratio, seed, n; tiers 1K / 2K
        const s = fakeServer({ images: [() => okImage({ data: [{ b64_json: RESULT.toString("base64"), media_type: "image/webp" }], usage: { cost: 0.045, prompt_tokens: 0 } })] });
        const ctx = ctxFor(s);
        const refs = [pngOf(800, 600, 70, "REF1"), pngOf(600, 800, 70, "REF2")];
        const out = await openrouter.edit(editReq(v, { references: refs }), ctx);
        const posts = s.calls.filter((c) => c.method === "POST");
        check("one POST to <base>/api/v1/images and nothing else but the host list", posts.length === 1 && posts[0].url === BASE + "/api/v1/images" && s.calls.length === 2 && s.providerCalls.length === 1, s.calls.map((c) => c.method + " " + c.url).join(", "));
        const h = posts[0] && posts[0].headers;
        check("the image request's headers are exactly Authorization: Bearer <key> and Content-Type: application/json", !!h && eq(Object.keys(h).sort(), ["authorization", "content-type"]) && h.authorization === "Bearer " + KEY && h["content-type"] === "application/json", short(h));
        const b = s.images[0];
        check("body.model is the variant's model id", b.model === "bytedance-seed/seedream-5-0-pro", b.model);
        check("the prompt: the edit sentence, the user's prompt, the sentence for several references", b.prompt === `${EDIT_PREFIX} a red door ${REF_MANY}`, b.prompt);
        const pics = refsOf(b);
        check("input_references are {type:image_url,image_url:{url:data:image/png;base64,...}} objects", Array.isArray(b.input_references) && b.input_references.every((r) => r && r.type === "image_url" && r.image_url && /^data:image\/png;base64,/.test(r.image_url.url) && eq(Object.keys(r).sort(), ["image_url", "type"])), short(b.input_references && b.input_references.map((r) => r.image_url.url.slice(0, 40))));
        check("input_references decode to the crop, then the references in order (no mask on an edit)", pics.length === 3 && pics[0].bytes.equals(editReq(v).image) && pics[1].bytes.equals(refs[0]) && pics[2].bytes.equals(refs[1]), pics.map((p) => p && tagOf(p.bytes)).join(", "));
        check("an edit sends no aspect_ratio (the host keeps the crop's shape)", !("aspect_ratio" in b), short(b));
        check("resolution: the smallest tier whose base covers the long side (1536 -> 2K)", b.resolution === "2K", b.resolution);
        check("n:1 and the seed as sent (accepts has both)", b.n === 1 && b.seed === 42, short({ n: b.n, seed: b.seed }));
        check("provider.ignore is the dated list and the CN hosts of /api/v1/providers, sorted, and nothing else in provider", eq(b.provider, { ignore: EXPECT_IGNORE }), short(b.provider));
        check("no mask field, no size, no data_collection on the Image API", !("mask" in b) && !("mask_url" in b) && !("size" in b) && !JSON.stringify(b.provider).includes("data_collection"), Object.keys(b).join(","));
        check("the answer: bytes decoded from b64_json, the media_type, usage.cost, the seed", out.bytes.equals(RESULT) && out.mime === "image/webp" && out.info.cost === 0.045 && out.seed === 42 && out.info.model === v.model && out.info.resolution === "2K", short({ mime: out.mime, info: out.info, seed: out.seed }));
        check("info.pictures names what went in", eq(out.info.pictures, ["crop png", "reference 1 png", "reference 2 png"]), short(out.info.pictures));

        // one reference, no media_type, no usage
        const s1 = fakeServer({ images: [() => json(200, { created: 1, data: [{ b64_json: RESULT.toString("base64") }] })] });
        const out1 = await openrouter.edit(editReq(v, { references: [refs[0]] }), ctxFor(s1));
        check("one reference: the singular sentence", s1.images[0].prompt === `${EDIT_PREFIX} a red door ${REF_ONE}`, s1.images[0].prompt);
        check("no media_type reads image/png, no usage reads cost null", out1.mime === "image/png" && out1.info.cost === null, short({ mime: out1.mime, cost: out1.info.cost }));
        const s0 = fakeServer();
        await openrouter.edit(editReq(v), ctxFor(s0));
        check("no reference: the edit sentence and the prompt only", s0.images[0].prompt === `${EDIT_PREFIX} a red door` && refsOf(s0.images[0]).length === 1, s0.images[0].prompt);

        // the tier rule
        const tiers = { "1K": 1024, "2K": 2048 };
        const got = [[900, 600], [1024, 700], [1025, 700], [700, 2048], [3000, 2000]].map(([w, hh]) => openrouter._tier(w, hh, tiers));
        check("tiers: 900 -> 1K, 1024 -> 1K, 1025 -> 2K, 2048 (tall) -> 2K, 3000 -> 2K (the largest)", eq(got, ["1K", "1K", "2K", "2K", "2K"]), short(got));
        const nb = variant("nano_banana_2");
        const nbTiers = [[400, 300], [512, 512], [513, 300], [4096, 2304], [6000, 4000]].map(([w, hh]) => openrouter._tier(w, hh, nb.options.tiers));
        check("tiers on Nano Banana 2 (512 / 1K / 2K / 4K): 400 -> 512, 512 -> 512, 513 -> 1K, 4096 -> 4K, 6000 -> 4K", eq(nbTiers, ["512", "512", "1K", "4K", "4K"]), short(nbTiers));
        const s2 = fakeServer();
        await openrouter.edit(editReq(v, { width: 3000, height: 2000, params: { resolution: "1K" } }), ctxFor(s2));
        check("a Resolution row's value wins over the tier rule", s2.images[0].resolution === "1K", s2.images[0].resolution);
        const s3 = fakeServer();
        await openrouter.edit(editReq(v, { width: 900, height: 600, params: { resolution: "auto" } }), ctxFor(s3));
        check("Resolution auto is not sent as auto: the tier rule picks 1K", s3.images[0].resolution === "1K", s3.images[0].resolution);

        // seed and n
        const s4 = fakeServer();
        await openrouter.edit(editReq(v, { seed: -5 }), ctxFor(s4));
        check("a negative seed goes as seed >>> 0", s4.images[0].seed === (-5 >>> 0) && s4.images[0].seed === 4294967291, String(s4.images[0].seed));
        const s5 = fakeServer();
        await openrouter.edit(editReq(v, { params: { random_seed: true } }), ctxFor(s5));
        check("params.random_seed: no seed is sent (and random_seed itself is not)", !("seed" in s5.images[0]) && !("random_seed" in s5.images[0]), Object.keys(s5.images[0]).join(","));
        const s6 = fakeServer();
        await openrouter.edit(editReq(v, { seed: null }), ctxFor(s6));
        check("no seed in the request: none in the body", !("seed" in s6.images[0]), Object.keys(s6.images[0]).join(","));
        const s7 = fakeServer();
        const out7 = await openrouter.edit(editReq(variant("gpt_image_2"), { seed: 42 }), ctxFor(s7));
        check("a model without seed in accepts (GPT Image 2) gets no seed", !("seed" in s7.images[0]) && s7.images[0].n === 1 && out7.seed === 42, Object.keys(s7.images[0]).join(","));
        const s8 = fakeServer();
        await openrouter.edit(editReq({ model: "test/no-n", input: "edit", options: { accepts: ["aspect_ratio"], ratios: ["1:1"] } }), ctxFor(s8));
        check("a model without n in accepts gets no n (and no seed)", !("n" in s8.images[0]) && !("seed" in s8.images[0]) && !("resolution" in s8.images[0]), Object.keys(s8.images[0]).join(","));
    });

    // ---- 2. fill: the mask as the second picture; an edit never sends it ----
    await section("2. fill", async () => {
        const v = variant("gpt_image_2");   // fill input
        const s = fakeServer();
        const req = editReq(v, { references: [pngOf(640, 480, 70, "REF1"), pngOf(640, 480, 70, "REF2")] });
        await openrouter.edit(req, ctxFor(s));
        const b = s.images[0];
        const pics = refsOf(b);
        check("fill: the crop, then the luminance mask (not maskAlpha), then the references", pics.length === 4 && pics[0].bytes.equals(req.image) && pics[1].bytes.equals(req.mask) && !pics[1].bytes.equals(req.maskAlpha) && pics[2].bytes.equals(req.references[0]) && pics[3].bytes.equals(req.references[1]), pics.map((p) => p && tagOf(p.bytes)).join(", "));
        check("fill: the mask sentence, the prompt, the references sentence", b.prompt === `${FILL_PREFIX} a red door ${REF_MANY}`, b.prompt);
        check("fill: no mask or mask_url field (the Image API has none)", !("mask" in b) && !("mask_url" in b), Object.keys(b).join(","));
        const s1 = fakeServer();
        await openrouter.edit(editReq(v), ctxFor(s1));
        check("fill without references: the mask sentence and the prompt only", s1.images[0].prompt === `${FILL_PREFIX} a red door` && refsOf(s1.images[0]).length === 2, s1.images[0].prompt);
        const e = variant("flux2_pro");   // edit input
        const s2 = fakeServer();
        const req2 = editReq(e, { references: [pngOf(640, 480, 70, "REF1")] });
        await openrouter.edit(req2, ctxFor(s2));
        const pics2 = refsOf(s2.images[0]);
        check("kind edit never sends the mask, even when the request has one", req2.kind === "edit" && !!req2.mask && pics2.length === 2 && pics2[0].bytes.equals(req2.image) && pics2[1].bytes.equals(req2.references[0]) && !pics2.some((p) => p.bytes.equals(req2.mask)), pics2.map((p) => tagOf(p.bytes)).join(", "));
        check("kind edit: no word about a mask in the prompt", !/mask/i.test(s2.images[0].prompt) && s2.images[0].prompt === `${EDIT_PREFIX} a red door ${REF_ONE}`, s2.images[0].prompt);
    });

    // ---- 3. text (Generate new): no pictures, the aspect preset, the tier from the asked size ----
    await section("3. text (generate)", async () => {
        const v = variant("nano_banana_2");
        const run = async (extra) => { const s = fakeServer(); await openrouter.generate(textReq(v, extra), ctxFor(s)); return s.images[0]; };
        const b = await run({ aspect: "16:9", width: 2048, height: 1152, references: [pngOf(10, 10, 40, "IGNORED")] });
        check("a text run sends no input_references, even when the request carries references", !("input_references" in b), Object.keys(b).join(","));
        check("a text run: the prompt as it is, the asked aspect (a preset), the tier of the asked long side", b.prompt === "a lighthouse at dusk" && b.aspect_ratio === "16:9" && b.resolution === "2K" && b.n === 1 && b.model === "google/gemini-3.1-flash-image", short(b));
        const b2 = await run({ aspect: "7:3", width: 2100, height: 900 });
        check("an aspect that is no preset takes the closest one (7:3 -> 21:9)", b2.aspect_ratio === "21:9", b2.aspect_ratio);
        const b3 = await run({ aspect: null, width: 2000, height: 1000 });
        check("no aspect: the closest preset to width:height (2000 x 1000 -> 16:9, the nearest of 16:9 and 21:9 in log ratio)", b3.aspect_ratio === "16:9" && b3.resolution === "2K", short({ aspect_ratio: b3.aspect_ratio, resolution: b3.resolution }));
        const b4 = await run({ aspect: null, width: 1000, height: 1000 });
        check("no aspect, a square size: 1:1 at 1K", b4.aspect_ratio === "1:1" && b4.resolution === "1K", short({ aspect_ratio: b4.aspect_ratio, resolution: b4.resolution }));
        const b5 = await run({ aspect: "9:16", width: 2304, height: 4096 });
        check("a tall 4K ask: 9:16 at 4K", b5.aspect_ratio === "9:16" && b5.resolution === "4K", short({ aspect_ratio: b5.aspect_ratio, resolution: b5.resolution }));
        const b6 = await run({ aspect: null, width: 6000, height: 4000 });
        check("a size past the largest tier takes the largest (6000 -> 4K)", b6.resolution === "4K", b6.resolution);
        const sd = variant("seedream_5_lite");
        const sb = fakeServer();
        await openrouter.generate(textReq(sd, { aspect: "19.5:9", width: 2600, height: 1200 }), ctxFor(sb));
        check("a decimal preset (Seedream 19.5:9) passes as it is", sb.images[0].aspect_ratio === "19.5:9", sb.images[0].aspect_ratio);
        const s = fakeServer();
        const e = await throws(() => openrouter.generate(textReq(v, { prompt: "   " }), ctxFor(s)));
        check("an empty prompt is refused before any call", !!e && /needs a prompt/.test(e) && s.calls.length === 0, e);
        const s2 = fakeServer();
        const e2 = await throws(() => openrouter.edit(editReq(v, { image: null }), ctxFor(s2)));
        check("an edit without a crop is refused before any call", !!e2 && /no crop/.test(e2) && s2.calls.length === 0, e2);
        const s3 = fakeServer();
        const e3 = await throws(() => openrouter.edit(editReq({ ...v, model: "" }), ctxFor(s3)));
        check("a variant without a model id is refused before any call", !!e3 && /no model id/.test(e3) && s3.calls.length === 0, e3);
    });

    // ---- 4. parameters: only what accepts lists and the adapter knows ----
    await section("4. params", async () => {
        const wide = { accepts: ["quality", "background", "output_format", "output_compression", "size", "moderation", "channel", "random_seed", "style", "aspect_ratio"], ratios: ["1:1", "16:9"] };
        const s = fakeServer();
        await openrouter.edit(editReq({ model: "test/wide", input: "edit", options: wide }, { params: { quality: "high", background: "opaque", output_format: "webp", output_compression: 80, size: "1024x1024", moderation: "low", channel: "vip", random_seed: true, style: "photo", aspect_ratio: "16:9" } }), ctxFor(s));
        const b = s.images[0];
        check("size, moderation, channel, random_seed and style are never sent, even when accepts lists them", !["size", "moderation", "channel", "random_seed", "style"].some((k) => k in b), Object.keys(b).join(","));
        check("quality, background, output_format and output_compression pass when accepts lists them", b.quality === "high" && b.background === "opaque" && b.output_format === "webp" && b.output_compression === 80, short(b));
        const gpt = variant("gpt_image_2");   // accepts aspect_ratio, quality, n: no background, no output_format
        const s1 = fakeServer();
        await openrouter.edit(editReq(gpt, { params: { quality: "high", background: "transparent", output_format: "png", resolution: "2K" } }), ctxFor(s1));
        const b1 = s1.images[0];
        check("a parameter the model does not accept is dropped (GPT Image 2: background, output_format, resolution)", b1.quality === "high" && !("background" in b1) && !("output_format" in b1) && !("resolution" in b1), Object.keys(b1).join(","));
        const s2 = fakeServer();
        await openrouter.edit(editReq(gpt, { params: { quality: "auto" } }), ctxFor(s2));
        check("quality auto is not sent", !("quality" in s2.images[0]), Object.keys(s2.images[0]).join(","));
        const s3 = fakeServer();
        await openrouter.edit(editReq(gpt, { params: { quality: "" } }), ctxFor(s3));
        check("an empty value is not sent", !("quality" in s3.images[0]), Object.keys(s3.images[0]).join(","));
        const alpha = { accepts: ["background", "output_format"] };
        const s4 = fakeServer();
        await openrouter.edit(editReq({ model: "test/alpha", input: "edit", options: alpha }, { params: { background: "transparent", output_format: "jpeg" } }), ctxFor(s4));
        check("background transparent with output_format jpeg goes as png", s4.images[0].background === "transparent" && s4.images[0].output_format === "png", short(s4.images[0]));
        const s5 = fakeServer();
        await openrouter.edit(editReq({ model: "test/alpha", input: "edit", options: alpha }, { params: { background: "transparent", output_format: "webp" } }), ctxFor(s5));
        check("background transparent keeps webp (it carries alpha)", s5.images[0].output_format === "webp", s5.images[0].output_format);
        const s6 = fakeServer();
        await openrouter.edit(editReq({ model: "test/alpha", input: "edit", options: alpha }, { params: { background: "opaque", output_format: "jpeg" } }), ctxFor(s6));
        check("an opaque background keeps jpeg", s6.images[0].output_format === "jpeg", s6.images[0].output_format);
        const flux = variant("flux2_pro");
        const s7 = fakeServer();
        await openrouter.edit(editReq(flux, { params: { ...flux.fixed } }), ctxFor(s7));
        check("the recipe's fixed output_format (FLUX: png) passes", flux.fixed && flux.fixed.output_format === "png" && s7.images[0].output_format === "png" && s7.images[0].seed === 42, short(s7.images[0]));
        const s8 = fakeServer();
        await openrouter.edit(editReq({ model: "test/none", input: "edit", options: null }, { params: { quality: "high", seed: 3 } }), ctxFor(s8));
        check("no options: model, prompt, input_references and provider only", eq(Object.keys(s8.images[0]).sort(), ["input_references", "model", "prompt", "provider"]), Object.keys(s8.images[0]).join(","));
        // a tier only some of the model's hosts serve goes only to them (Nano Banana Pro's 4K: AI Studio, not Vertex)
        const pro = variant("nano_banana_pro");
        const s9 = fakeServer();
        await openrouter.edit(editReq(pro, { params: { resolution: "4K" } }), ctxFor(s9));
        check("Nano Banana Pro at 4K: provider.only is google-ai-studio, next to the ignore list", s9.images[0].resolution === "4K" && eq(s9.images[0].provider.only, ["google-ai-studio"]) && Array.isArray(s9.images[0].provider.ignore) && s9.images[0].provider.ignore.length > 0, short(s9.images[0].provider));
        const s10 = fakeServer();
        await openrouter.generate(textReq(pro, { width: 4096, height: 2304, aspect: "16:9" }), ctxFor(s10));
        check("Generate new at 4096 on Nano Banana Pro: auto picks 4K and pins it to AI Studio", s10.images[0].resolution === "4K" && eq(s10.images[0].provider.only, ["google-ai-studio"]), short(s10.images[0].provider));
        const s11 = fakeServer();
        await openrouter.edit(editReq(pro, { params: { resolution: "2K" } }), ctxFor(s11));
        check("Nano Banana Pro at 2K: no provider.only, any host", !("only" in s11.images[0].provider), short(s11.images[0].provider));
    });

    // ---- 5. guards: refused before any call ----
    await section("5. guards before any call", async () => {
        const few = { model: "test/three", input: "fill", options: { accepts: [], max_images: 3 } };
        const s = fakeServer();
        const e = await throws(() => openrouter.edit(editReq(few, { references: [pngOf(10, 10, 40, "R1"), pngOf(10, 10, 40, "R2")] }), ctxFor(s)));
        check("more pictures than max_images: refused before any call, the message names the counts", !!e && /at most 3 pictures/.test(e) && /has 4/.test(e) && /the crop, the mask, 2 references/.test(e) && s.calls.length === 0, e);
        const s1 = fakeServer();
        await openrouter.edit(editReq({ ...few, input: "edit" }, { references: [pngOf(10, 10, 40, "R1"), pngOf(10, 10, 40, "R2")] }), ctxFor(s1));
        check("the same three pictures without a mask (edit) go through", s1.images.length === 1 && refsOf(s1.images[0]).length === 3, String(s1.images.length));
        const one = { model: "test/one", input: "edit", options: { accepts: [], max_images: 1 } };
        const s1b = fakeServer();
        const e1b = await throws(() => openrouter.edit(editReq(one, { references: [pngOf(10, 10, 40, "R1")] }), ctxFor(s1b)));
        check("max_images 1 with one reference: refused, singular words", !!e1b && /at most 1 picture;/.test(e1b) && /has 2 \(the crop, 1 reference\)/.test(e1b) && s1b.calls.length === 0, e1b);

        const sd = variant("seedream_5_pro");   // max_ratio 16, ModelArk's documented input range
        check("Seedream's max_ratio is ModelArk's 16, not ToAPIs' 3, and 5.0 pro takes ten pictures", sd.options.max_ratio === 16 && sd.limits.ratio === 16 && sd.options.max_images === 10 && variant("seedream_5_lite").options.max_images === 14, short(sd.options));
        const sl = variant("seedream_5_lite");
        check("Seedream 5.0 lite: max_ratio and limits.ratio are ModelArk's 16 too", sl.options.max_ratio === 16 && !!sl.limits && sl.limits.ratio === 16, short({ max_ratio: sl.options.max_ratio, limits: sl.limits }));
        const s2 = fakeServer();
        const e2 = await throws(() => openrouter.edit(editReq(sd, { references: [pngOf(100, 1700, 64, "TALL")] }), ctxFor(s2)));
        check("a reference steeper than max_ratio (100 x 1700 on Seedream, 16:1) is refused before any call", !!e2 && /no steeper than 16:1/.test(e2) && /reference 1 is 100 × 1700/.test(e2) && s2.calls.length === 0, e2);
        const s3 = fakeServer();
        const e3 = await throws(() => openrouter.edit(editReq(sd, { image: pngOf(3201, 200, 64, "CROP") }), ctxFor(s3)));
        check("a crop of 3201 x 200 is refused before any call", !!e3 && /the crop is 3201 × 200/.test(e3) && s3.calls.length === 0, e3);
        const s4 = fakeServer();
        await openrouter.edit(editReq(sd, { image: pngOf(3200, 200, 64, "CROP"), references: [pngOf(400, 1600, 64, "TALL")] }), ctxFor(s4));
        check("a crop of exactly 16:1 and a 4:1 reference go through", s4.images.length === 1, String(s4.images.length));
        const s4b = fakeServer();
        const e4b = await throws(() => openrouter.edit(editReq(sd, { references: Array.from({ length: 10 }, (_, i) => pngOf(10, 10, 40, "R" + i)) }), ctxFor(s4b)));
        check("Seedream 5.0 pro: the crop and ten references (eleven) are refused before any call", !!e4b && /at most 10 pictures/.test(e4b) && s4b.calls.length === 0, e4b);
        const s5 = fakeServer();
        await openrouter.edit(editReq(variant("gpt_image_2"), { image: pngOf(4000, 500, 64, "CROP") }), ctxFor(s5));
        check("a model without max_ratio is not held to it", s5.images.length === 1, String(s5.images.length));

        // the inline budget: MAX_INLINE counts base64 characters, so R raw bytes are the most that fit
        const MAX = openrouter.MAX_INLINE;
        const R = Math.floor(MAX * 3 / 4);
        const raw = (f) => Math.round(f * R);
        const jpegOf = (size, tag) => { const j = Buffer.alloc(size, 0); Buffer.from([0xff, 0xd8, 0xff]).copy(j); j.write("JPEG-" + tag, 3, "latin1"); return j; };
        // the app's toJpeg and opaque are synchronous (providers/index.js: nativeImage); a picture tagged ALPHA has transparency
        function encoder(outFraction) {
            const calls = [];
            return {
                calls,
                toJpeg: (b, q) => { calls.push({ tag: tagOf(b), size: b.length, q }); return jpegOf(raw(outFraction), tagOf(b)); },
                opaque: (b) => !tagOf(b).startsWith("ALPHA"),
            };
        }
        check("MAX_INLINE is 18 MB", MAX === 18000000, String(MAX));

        // A: two conversions needed, the larger picture first
        const encA = encoder(0.05);
        const sA = fakeServer();
        await openrouter.edit(editReq(variant("flux2_pro"), { image: pngOf(2048, 1536, raw(1.04), "CROP"), references: [pngOf(2048, 1536, raw(1.1), "BIGREF")] }), ctxFor(sA, { toJpeg: encA.toJpeg, opaque: encA.opaque }));
        const picsA = refsOf(sA.images[0]);
        check("over the budget: opaque pictures go as JPEG (quality 92), the largest first, until it fits", eq(encA.calls.map((c) => [c.tag, c.q]), [["BIGREF", 92], ["CROP", 92]]) && picsA.length === 2 && picsA.every((p) => p.mime === "image/jpeg"), short({ calls: encA.calls, mimes: picsA.map((p) => p.mime) }));
        // B: one conversion is enough, the rest stay PNG
        const encB = encoder(0.05);
        const sB = fakeServer();
        await openrouter.edit(editReq(variant("flux2_pro"), { image: pngOf(2048, 1536, raw(0.6), "CROP"), references: [pngOf(2048, 1536, raw(0.7), "REF1"), pngOf(512, 512, raw(0.05), "REF2")] }), ctxFor(sB, { toJpeg: encB.toJpeg, opaque: encB.opaque }));
        const picsB = refsOf(sB.images[0]);
        check("once it fits no further picture is converted", eq(encB.calls.map((c) => c.tag), ["REF1"]) && eq(picsB.map((p) => p.mime), ["image/png", "image/jpeg", "image/png"]) && picsB[0].bytes.length === raw(0.6), short({ calls: encB.calls.map((c) => c.tag), mimes: picsB.map((p) => p.mime) }));
        // C: the mask is never re-encoded
        const encC = encoder(0.01);
        const sC = fakeServer();
        const eC = await throws(() => openrouter.edit(editReq(variant("gpt_image_2"), { image: pngOf(2048, 1536, raw(0.1), "CROP"), mask: pngOf(2048, 1536, raw(1.2), "MASK") }), ctxFor(sC, { toJpeg: encC.toJpeg, opaque: encC.opaque })));
        check("a mask over the budget is never re-encoded, and the run is refused before any call", !!eC && /more than the 18 MB/.test(eC) && !encC.calls.some((c) => c.tag === "MASK") && sC.calls.length === 0, short({ err: eC, calls: encC.calls.map((c) => c.tag) }));
        // D: a transparent crop keeps its PNG; an opaque reference is converted instead
        const encD = encoder(0.05);
        const sD = fakeServer();
        await openrouter.edit(editReq(variant("flux2_pro"), { image: pngOf(2048, 1536, raw(0.8), "ALPHACROP"), references: [pngOf(2048, 1536, raw(0.4), "REF1")] }), ctxFor(sD, { toJpeg: encD.toJpeg, opaque: encD.opaque }));
        const picsD = refsOf(sD.images[0]);
        check("a transparent crop is not re-encoded (the opaque reference is)", eq(encD.calls.map((c) => c.tag), ["REF1"]) && picsD[0].mime === "image/png" && picsD[0].bytes.length === raw(0.8) && picsD[1].mime === "image/jpeg", short({ calls: encD.calls.map((c) => c.tag), mimes: picsD.map((p) => p.mime) }));
        const encD2 = encoder(0.05);
        const sD2 = fakeServer();
        const eD2 = await throws(() => openrouter.edit(editReq(variant("flux2_pro"), { image: pngOf(2048, 1536, raw(1.2), "ALPHACROP") }), ctxFor(sD2, { toJpeg: encD2.toJpeg, opaque: encD2.opaque })));
        check("a transparent crop over the budget alone is refused, never converted, before any call", !!eD2 && /more than the 18 MB/.test(eD2) && encD2.calls.length === 0 && sD2.calls.length === 0, short({ err: eD2, calls: encD2.calls.length }));
        // E: still over after the conversion
        const encE = encoder(1.1);
        const sE = fakeServer();
        const eE = await throws(() => openrouter.edit(editReq(variant("flux2_pro"), { image: pngOf(2048, 1536, raw(1.2), "CROP") }), ctxFor(sE, { toJpeg: encE.toJpeg, opaque: encE.opaque })));
        check("still over the budget as JPEG: refused before any call, with the remedy", !!eE && /more than the 18 MB/.test(eE) && /Highres fix lower/.test(eE) && encE.calls.length === 1 && sE.calls.length === 0, eE);
        // F: no encoder in ctx
        const sF = fakeServer();
        const eF = await throws(() => openrouter.edit(editReq(variant("flux2_pro"), { image: pngOf(2048, 1536, raw(1.2), "CROP") }), ctxFor(sF)));
        check("without toJpeg / opaque an oversized run is refused before any call", !!eF && /more than the 18 MB/.test(eF) && sF.calls.length === 0, eF);
        // G: exactly at the budget (R raw bytes are MAX_INLINE base64 characters): nothing converted
        const encG = encoder(0.05);
        const sG = fakeServer();
        await openrouter.edit(editReq(variant("flux2_pro"), { image: pngOf(2048, 1536, R, "CROP") }), ctxFor(sG, { toJpeg: encG.toJpeg, opaque: encG.opaque }));
        check("a crop whose base64 is exactly the budget is sent as PNG, not converted", encG.calls.length === 0 && sG.images.length === 1 && refsOf(sG.images[0])[0].mime === "image/png", short({ calls: encG.calls.length }));
        // H: the app's encoders may become asynchronous; both are awaited
        const encH = encoder(0.05);
        const sH = fakeServer();
        const eH = await throws(() => openrouter.edit(editReq(variant("flux2_pro"), { image: pngOf(2048, 1536, raw(0.8), "ALPHACROP"), references: [pngOf(2048, 1536, raw(0.4), "REF1")] }), ctxFor(sH, { toJpeg: async (b, q) => encH.toJpeg(b, q), opaque: async (b) => encH.opaque(b) })));
        const picsH = sH.images.length ? refsOf(sH.images[0]) : [];
        check("async toJpeg / opaque are awaited: the transparent crop stays PNG, the opaque reference goes as JPEG", !eH && eq(encH.calls.map((c) => c.tag), ["REF1"]) && picsH.length === 2 && picsH[0].mime === "image/png" && picsH[1].mime === "image/jpeg", short({ err: eH, calls: encH.calls.map((c) => c.tag), mimes: picsH.map((p) => p.mime) }));
    });

    // ---- 6. errors ----
    await section("6. errors", async () => {
        const v = variant("flux2_pro");
        const errs = [];
        async function attempt(answers, extra = {}) {
            const s = fakeServer({ images: answers });
            const ctx = ctxFor(s, extra);
            let out = null, err = null;
            try { out = await openrouter.edit(editReq(v), ctx); } catch (e) { err = String(e && e.message || e); errs.push(err); }
            return { s, ctx, out, err, posts: s.images.length };
        }
        const zod = { success: false, error: { name: "ZodError", message: JSON.stringify([{ code: "invalid_type", expected: "string", received: "undefined", path: ["prompt"], message: "Required" }]) } };
        const a = await attempt([() => json(400, zod)]);
        check("400 in the schema check's shape reads the issue as path: message", !!a.err && /request refused/.test(a.err) && /prompt: Required/.test(a.err) && !/ZodError|invalid_type/.test(a.err) && a.posts === 1, a.err);
        const b = await attempt([() => json(400, { error: { code: 400, message: "aspect_ratio 5:1 is not supported", metadata: { provider_name: "Black Forest Labs" } } })]);
        check("400 in the documented shape reads its message", !!b.err && /request refused - aspect_ratio 5:1 is not supported/.test(b.err) && b.posts === 1, b.err);
        const c = await attempt([() => json(401, { error: { code: 401, message: "Invalid credentials: " + KEY } })]);
        check("401 echoing the key: key refused, the key scrubbed", !!c.err && /key refused/.test(c.err) && !c.err.includes(KEY) && c.posts === 1, c.err);
        const d = await attempt([() => json(402, { error: { code: 402, message: "Insufficient credits. Add more using https://openrouter.ai/credits" } })]);
        check("402: credits too low, exactly one call, no wait", !!d.err && /credits too low/.test(d.err) && /Insufficient credits/.test(d.err) && d.posts === 1 && d.ctx.sleeps.length === 0, short({ err: d.err, posts: d.posts, sleeps: d.ctx.sleeps }));
        const e = await attempt([() => json(402, { error: { code: 402, message: "Key limit exceeded", metadata: { limit_source: "openrouter_key_limit" } } })]);
        check("402 with limit_source openrouter_key_limit: the key's spending limit, one call", !!e.err && /spending limit/.test(e.err) && e.posts === 1, e.err);
        const f = await attempt([() => json(402, { error: { code: 402, message: "In-flight budget exceeded", metadata: { limit_source: "openrouter_in_flight_budget" } } }, { "retry-after": "2" })]);
        check("402 of the in-flight budget with Retry-After: sent once more after the wait, and the image arrives", !f.err && f.out && f.out.bytes.equals(RESULT) && f.posts === 2 && eq(f.ctx.sleeps, [2000]) && eq(f.s.images[0], f.s.images[1]), short({ err: f.err, posts: f.posts, sleeps: f.ctx.sleeps }));
        const f2 = await attempt([() => json(402, { error: { code: 402, message: "In-flight budget exceeded", metadata: { limit_source: "openrouter_in_flight_budget" } } })]);
        check("402 of the in-flight budget without Retry-After: not a wait-and-retry case, one call, and not called a lack of credits", !!f2.err && f2.posts === 1 && f2.ctx.sleeps.length === 0 && /still settling/.test(f2.err) && !/credits too low/.test(f2.err), short({ err: f2.err, posts: f2.posts }));
        const g = await attempt([() => json(403, { error: { code: 403, message: "Input was flagged", metadata: { reasons: ["sexual", "violence"], flagged_input: "..." } } })]);
        check("403 lists metadata.reasons", !!g.err && /content policy \(sexual, violence\)/.test(g.err) && /Input was flagged/.test(g.err) && g.posts === 1, g.err);
        const g2 = await attempt([() => json(403, { error: { code: 403, message: "Only management keys can perform this operation" } })]);
        check("403 without reasons is not called a content-policy refusal", !!g2.err && /refused \(the content policy, a guardrail or the key's permissions\)/.test(g2.err) && g2.posts === 1, g2.err);
        const g3 = await attempt([() => json(403, { error: { code: 403, message: "Blocked", metadata: { error_type: "content_policy_violation" } } })]);
        check("403 of error_type content_policy_violation reads refused by the content policy", !!g3.err && /refused by the content policy - Blocked/.test(g3.err), g3.err);
        const g4 = await attempt([() => json(403, { error: { code: 403, message: "Declined", metadata: { error_type: "refusal" } } })]);
        check("403 of error_type refusal reads refused by the content policy", !!g4.err && /refused by the content policy - Declined/.test(g4.err) && g4.posts === 1, g4.err);
        const words = [[404, /no host serves this model/], [413, /request too large/], [503, /none meets the routing rules/], [524, /timed out/]];
        for (const [status, re] of words) {
            const x = await attempt([() => json(status, { error: { code: status, message: "upstream says " + status } })]);
            check(`${status} reads plain words and the server's message, one call`, !!x.err && re.test(x.err) && x.err.includes("upstream says " + status) && x.posts === 1, x.err);
        }
        const h = await attempt([() => json(429, { error: { code: 429, message: "Rate limit exceeded" } }, { "retry-after": "3" })]);
        check("429 with Retry-After: 3 is sent again after 3000 ms, then the image arrives", !h.err && h.out && h.out.bytes.equals(RESULT) && h.posts === 2 && h.ctx.sleeps[0] === 3000 && h.ctx.sleeps.length === 1, short({ err: h.err, posts: h.posts, sleeps: h.ctx.sleeps }));
        const i = await attempt([() => json(429, { error: { code: 429, message: "Rate limit exceeded" } }, { "retry-after": "1" }), () => json(429, { error: { code: 429, message: "Rate limit exceeded" } }, { "retry-after": "1" })]);
        check("429 twice: an error after exactly two calls", !!i.err && /rate limited/.test(i.err) && i.posts === 2, short({ err: i.err, posts: i.posts }));
        const i2 = await attempt([() => json(429, { error: { code: 429, message: "slow down" } }, { "retry-after": "600" })]);
        check("a Retry-After past 60 s is not waited for: one call, no sleep, the error says when to try again", !!i2.err && i2.posts === 1 && i2.ctx.sleeps.length === 0 && /try again in 600 s/.test(i2.err), short({ err: i2.err, posts: i2.posts, sleeps: i2.ctx.sleeps }));
        const i3 = await attempt([() => json(429, { error: { code: 429, message: "slow down" } }, { "retry-after": "60" })]);
        check("a Retry-After of 60 s (the docs' example) is waited for in full, then sent once more", !i3.err && i3.posts === 2 && eq(i3.ctx.sleeps, [60000]), short({ err: i3.err, posts: i3.posts, sleeps: i3.ctx.sleeps }));
        const i4 = await attempt([() => json(503, { error: { code: 503, message: "Provider overloaded", metadata: { error_type: "provider_overloaded" } } }, { "retry-after": "4" })]);
        check("503 with Retry-After (an overloaded host) is sent once more after the wait", !i4.err && i4.posts === 2 && eq(i4.ctx.sleeps, [4000]), short({ err: i4.err, posts: i4.posts, sleeps: i4.ctx.sleeps }));
        const i5 = await attempt([() => json(503, { error: { code: 503, message: "Provider overloaded", metadata: { error_type: "provider_overloaded" } } }, { "retry-after": "1" }), () => json(503, { error: { code: 503, message: "Provider overloaded", metadata: { error_type: "provider_overloaded" } } }, { "retry-after": "1" })]);
        check("503 provider_overloaded twice reads overloaded, not a routing rule", !!i5.err && /hosts are overloaded/.test(i5.err) && i5.posts === 2, i5.err);
        const i9 = await attempt([() => json(429, { error: { code: 429, message: "slow down" } }, { "retry-after": "2" }), () => json(429, { error: { code: 429, message: "slow down" } }, { "retry-after": "600" })]);
        check("a second refusal that names a wait: no third request, the error says when to try again", !!i9.err && i9.posts === 2 && eq(i9.ctx.sleeps, [2000]) && /try again in 600 s/.test(i9.err), short({ err: i9.err, posts: i9.posts, sleeps: i9.ctx.sleeps }));
        const i10 = await attempt([() => json(429, { error: { code: 429, message: "slow down" } }), () => json(429, { error: { code: 429, message: "slow down" } })]);
        check("a second refusal without Retry-After: no 'try again in' (the 5 s default is not the server's time)", !!i10.err && i10.posts === 2 && !/try again in/.test(i10.err), short({ err: i10.err, posts: i10.posts }));
        const i6 = await attempt([() => json(429, { error: { code: 429, message: "slow down" } }, { "retry-after": "61" })]);
        check("a Retry-After of 61 s is past the cap: one call, no sleep, try again in 61 s", !!i6.err && i6.posts === 1 && i6.ctx.sleeps.length === 0 && /try again in 61 s/.test(i6.err), short({ err: i6.err, posts: i6.posts, sleeps: i6.ctx.sleeps }));
        const i7 = await attempt([() => json(429, { error: { code: 429, message: "slow down" } }, { "retry-after": new Date(Date.now() + 3000).toUTCString() })]);
        check("a Retry-After as an HTTP date 3 s out is waited for until then (not the 5 s fallback), then sent once more", !i7.err && i7.posts === 2 && i7.ctx.sleeps.length === 1 && i7.ctx.sleeps[0] > 1000 && i7.ctx.sleeps[0] <= 3000, short({ err: i7.err, posts: i7.posts, sleeps: i7.ctx.sleeps }));
        const i8 = await attempt([() => json(429, { error: { code: 429, message: "slow down" } }, { "retry-after": new Date(Date.now() + 600000).toUTCString() })]);
        check("a Retry-After as an HTTP date 10 min out is not waited for: one call, no sleep, try again in about 600 s", !!i8.err && i8.posts === 1 && i8.ctx.sleeps.length === 0 && /try again in (599|600) s/.test(i8.err), short({ err: i8.err, posts: i8.posts, sleeps: i8.ctx.sleeps }));
        const j = await attempt([() => json(529, { error: { code: 529, message: "Provider overloaded" } })]);
        check("529 is sent once more (5 s without Retry-After)", !j.err && j.posts === 2 && eq(j.ctx.sleeps, [5000]), short({ err: j.err, posts: j.posts, sleeps: j.ctx.sleeps }));
        const k = await attempt([() => json(502, { error: { code: 502, message: "Provider returned error" } })]);
        check("502 is not retried and says nothing was charged", !!k.err && /nothing was charged/.test(k.err) && k.posts === 1 && k.ctx.sleeps.length === 0, short({ err: k.err, posts: k.posts }));
        let thrown = 0;
        const l = await attempt([() => { thrown++; throw new TypeError("fetch failed"); }]);
        check("a network error is not retried: exactly one image call", !!l.err && /fetch failed/.test(l.err) && thrown === 1 && l.posts === 1 && l.s.calls.filter((c) => c.method === "POST").length === 1, short({ err: l.err, posts: l.posts }));
        const m = await attempt([() => json(200, { error: { code: 502, message: "Provider disconnected" } })]);
        // read as an error with its code's words, not as "no image in the answer" (which quotes the body too)
        check("HTTP 200 carrying an error object is thrown as that error", !!m.err && /the model's host failed; nothing was charged - Provider disconnected/.test(m.err) && !/no image in the answer/.test(m.err) && !m.out && m.posts === 1, m.err);
        const n = await attempt([() => json(200, { created: 1, data: [{ media_type: "image/png" }], usage: { cost: 0.03 } })]);
        check("HTTP 200 without b64_json is thrown", !!n.err && /no image in the answer/.test(n.err) && !n.out, n.err);
        const o = await attempt([() => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } })]);
        check("a 502 that is not JSON still reads plain words", !!o.err && /nothing was charged/.test(o.err) && /Bad gateway/.test(o.err), o.err);
        check("the key appears in no error of this section", errs.length >= 15 && !errs.some((x) => x.includes(KEY)), `${errs.length} errors`);
    });

    // ---- 7. the hosts in China: once per session and base ----
    await section("7. chinaHosts", async () => {
        openrouter._resetHosts();
        const v = variant("flux2_pro");
        const s = fakeServer();
        await openrouter.edit(editReq(v), ctxFor(s));
        await openrouter.generate(textReq(v), ctxFor(s));
        check("two runs on the same base read /api/v1/providers once", s.providerCalls.length === 1 && s.providerCalls[0].url === BASE + "/api/v1/providers" && s.images.length === 2 && eq(s.images[1].provider, { ignore: EXPECT_IGNORE }), s.calls.map((c) => c.method + " " + c.url).join(", "));
        check("the host list is read without the key (a public endpoint)", s.providerCalls.every((c) => !("authorization" in c.headers) && !JSON.stringify(c.headers).includes(KEY)), short(s.providerCalls.map((c) => c.headers)));
        openrouter._resetHosts();
        const bad = fakeServer({ providers: () => json(500, { error: { code: 500, message: "down" } }) });
        const ctxBad = ctxFor(bad);
        await openrouter.edit(editReq(v), ctxBad);
        check("a failing /providers: the dated list is sent, and the run goes on", eq(bad.images[0].provider, { ignore: [...openrouter.CHINA_HOSTS].sort() }) && ctxBad.logs.some((x) => /could not be read/.test(x)), short({ provider: bad.images[0].provider, logs: ctxBad.logs }));
        await openrouter.edit(editReq(v), ctxFor(bad));
        check("after a failure the next run asks again", bad.providerCalls.length === 2, String(bad.providerCalls.length));
        openrouter._resetHosts();
        let lost = 0;
        const net = fakeServer({ providers: () => { lost++; throw new TypeError("fetch failed"); } });
        await openrouter.edit(editReq(v), ctxFor(net));
        check("a /providers lost to the network: the dated list", lost === 1 && eq(net.images[0].provider, { ignore: [...openrouter.CHINA_HOSTS].sort() }), short(net.images[0].provider));
        openrouter._resetHosts();
        const two = fakeServer();
        await openrouter.edit(editReq(v), ctxFor(two));
        await openrouter.edit(editReq(v), ctxFor(two, { base: "http://127.0.0.1:5556" }));
        await openrouter.edit(editReq(v), ctxFor(two));
        check("a different base asks again (once per base)", eq(two.providerCalls.map((c) => c.url), [BASE + "/api/v1/providers", "http://127.0.0.1:5556/api/v1/providers"]) && two.images.length === 3, two.providerCalls.map((c) => c.url).join(", "));
        openrouter._resetHosts();
        let provSignal = null;
        const sP = fakeServer();
        await openrouter.edit(editReq(v), ctxFor({ fetch: (url, init) => { if (/\/api\/v1\/providers$/.test(String(url))) provSignal = init && init.signal; return sP.fetch(url, init); } }));
        check("the host list is read with a timeout signal (a hanging /providers does not hang every run)", provSignal instanceof AbortSignal && !provSignal.aborted && sP.providerCalls.length === 1, String(provSignal));
        check("the dated list is the one read on 2026-09-19 (GET /api/v1/providers: CN headquarters or a CN datacentre)", eq(openrouter.CHINA_HOSTS, ["alibaba", "baidu", "deepseek", "nex-agi", "streamlake", "tencent", "xiaomi"]), short(openrouter.CHINA_HOSTS));
    });

    // ---- 8. balance: GET /api/v1/key ----
    await section("8. balance", async () => {
        const s = fakeServer();
        const bal = await openrouter.balance(ctxFor(s));
        const c = s.calls[0];
        check("balance: one GET <base>/api/v1/key with the key", s.calls.length === 1 && c.method === "GET" && c.url === BASE + "/api/v1/key" && c.headers.authorization === "Bearer " + KEY, short(s.calls));
        check("a key with a limit: usd is limit_remaining, the note names the limit and the use", bal.usd === 12.5 && /\$20\.00/.test(bal.note) && /\$7\.50 used/.test(bal.note), short(bal));
        const s1 = fakeServer({ key: () => json(200, { data: { label: "sk-or-v1-012...def", limit: null, limit_remaining: null, usage: 3.25 } }) });
        const bal1 = await openrouter.balance(ctxFor(s1));
        check("a key without a limit: usd null, the note says so and names the use", bal1.usd === null && /^no spending limit on this key/.test(bal1.note) && /\$3\.25 used/.test(bal1.note), short(bal1));
        const s1m = fakeServer({ key: () => json(200, { data: { limit: 100, limit_remaining: 74.5, limit_reset: "monthly", usage: 250, usage_monthly: 25.5, byok_usage_monthly: 1, include_byok_in_limit: false } }) });
        const bal1m = await openrouter.balance(ctxFor(s1m));
        check("a monthly limit: the note names the month's use, not the all-time one", bal1m.usd === 74.5 && /\$100\.00 monthly limit/.test(bal1m.note) && /\$25\.50 used this month/.test(bal1m.note) && !/\$250/.test(bal1m.note), short(bal1m));
        const s1b = fakeServer({ key: () => json(200, { data: { limit: 10, limit_remaining: 6, limit_reset: "daily", usage: 50, usage_daily: 3, byok_usage_daily: 1, include_byok_in_limit: true } }) });
        const bal1b = await openrouter.balance(ctxFor(s1b));
        check("a daily limit that includes BYOK: today's use counts the BYOK spending", /\$4\.00 used today/.test(bal1b.note), short(bal1b));
        const s1u = fakeServer({ key: () => json(200, { data: { limit: 10, limit_remaining: 6, limit_reset: "fortnightly", usage: 50 } }) });
        const bal1u = await openrouter.balance(ctxFor(s1u));
        check("a reset this adapter does not know: no used figure rather than the all-time one", bal1u.usd === 6 && !/used/.test(bal1u.note) && !/\$50/.test(bal1u.note), short(bal1u));
        const s1n = fakeServer({ key: () => json(200, { data: { limit: 10, limit_remaining: 4, limit_reset: null, usage: 5, byok_usage: 1, include_byok_in_limit: true } }) });
        const bal1n = await openrouter.balance(ctxFor(s1n));
        check("a limit without reset that includes BYOK: the use counts the BYOK spending", bal1n.usd === 4 && /\$6\.00 used/.test(bal1n.note), short(bal1n));
        let keySignal = null;
        const sT = fakeServer();
        await openrouter.balance(ctxFor({ fetch: (url, init) => { keySignal = init && init.signal; return sT.fetch(url, init); } }));
        check("balance: GET /api/v1/key carries a timeout signal (a hanging host does not hang the key row)", keySignal instanceof AbortSignal && !keySignal.aborted, String(keySignal));
        const s2 = fakeServer({ key: () => json(401, { error: { code: 401, message: "User not found for " + KEY } }) });
        const e2 = await throws(() => openrouter.balance(ctxFor(s2)));
        check("a refused key: key refused, without the key", !!e2 && /key refused/.test(e2) && !e2.includes(KEY), e2);
    });

    // ---- 9. the host allowlist and the key rule ----
    await section("9. allowlist and key rule", async () => {
        const table = [
            ["https://openrouter.ai", "https://openrouter.ai"],
            ["https://openrouter.ai/", "https://openrouter.ai"],
            ["http://127.0.0.1:5555", "http://127.0.0.1:5555"],
            ["https://openrouter.ai/api/v1", null],
            ["http://openrouter.ai", null],
            ["https://eu.openrouter.ai", null],
            ["https://openrouter.ai.evil.example", null],
            ["http://localhost:5555", null],
            ["http://127.0.0.1", null],
            ["https://user:pw@openrouter.ai", null],
            ["https://openrouter.ai/?x=1", null],
            ["", null],
        ];
        const wrong = table.filter(([inp, want]) => openrouter._allowedBase(inp) !== want).map(([inp, want]) => `${inp} -> ${openrouter._allowedBase(inp)} (want ${want})`);
        check("the base allowlist: https://openrouter.ai and a loopback port, nothing else", !wrong.length, wrong.join("; ") || `${table.length} bases`);
        check("baseUrl reads settings.openrouter.base through the list and falls back to https://openrouter.ai", openrouter.baseUrl({ openrouter: { base: "http://127.0.0.1:9000" } }) === "http://127.0.0.1:9000" && openrouter.baseUrl({ openrouter: { base: "https://evil.example" } }) === "https://openrouter.ai" && openrouter.baseUrl({}) === "https://openrouter.ai" && openrouter.baseUrl(undefined) === "https://openrouter.ai" && openrouter.baseUrl({ openrouter: {} }) === "https://openrouter.ai");
        const v = variant("nano_banana_2");
        const cases = [
            ["a test- key with base https://openrouter.ai", { base: "https://openrouter.ai" }, /test key is never sent/],
            ["a test- key with a base outside the list (it falls back to openrouter.ai)", { base: "https://evil.example" }, /test key is never sent/],
            ["a test- key with no base", { base: undefined }, /test key is never sent/],
            ["an sk-or-v1- key with a loopback base", { key: REAL_KEY }, /only a test key goes there/],
        ];
        for (const [what, extra, re] of cases) {
            const got = [];
            for (const [name, fn] of [["edit", (ctx) => openrouter.edit(editReq(v), ctx)], ["generate", (ctx) => openrouter.generate(textReq(v), ctx)], ["balance", (ctx) => openrouter.balance(ctx)]]) {
                const s = fakeServer();
                const e = await throws(() => fn(ctxFor(s, extra)));
                got.push({ name, refused: !!e && re.test(e), calls: s.calls.length, keyInError: !!e && e.includes(REAL_KEY) });
            }
            check(`${what} is refused before any call on edit, generate and balance`, got.every((g) => g.refused && g.calls === 0 && !g.keyInError), short(got));
        }
        const s = fakeServer();
        let threw = null;
        try { openrouter.checkKey(BASE, KEY); openrouter.checkKey("https://openrouter.ai", REAL_KEY); } catch (e) { threw = e.message; }
        check("checkKey lets a test key go to the loopback base and a real key to openrouter.ai", threw === null && s.calls.length === 0, threw);
    });

    // ---- 10. every shipped recipe with an openrouter variant, normalised as the app does ----
    await section("10. recipes", async () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-openrouter-test-"));
        const orig = Module._load;
        Module._load = function (request, ...rest) {
            if (request === "electron") return { app: { getPath: () => empty } };
            return orig.call(this, request, ...rest);
        };
        let recipes;
        try { recipes = require(path.join(ROOT, "electron", "main", "recipes.js")); } finally { Module._load = orig; }
        let list;
        try { list = await recipes.list(RECIPES); } finally { fs.rmSync(empty, { recursive: true, force: true }); }
        const served = list.filter((r) => r.providers && r.providers.openrouter);
        const want = ["flux2_flex", "flux2_max", "flux2_pro", "gpt_image_2", "gpt_image_2_5_flare", "gpt_image_2_5_sunburst", "grok_imagine", "krea_2", "nano_banana_2", "nano_banana_2_lite", "nano_banana_pro", "recraft_v4", "seedream_5_lite", "seedream_5_pro"];
        check("fourteen shipped recipes carry an openrouter variant, all of them builtin", eq(served.map((r) => r.id).sort(), want) && served.every((r) => r.source === "builtin"), served.map((r) => r.id).join(", "));
        const qwen = list.filter((r) => r.providers && r.providers.openrouter && /qwen/i.test(String(r.providers.openrouter.model || "")));
        check("no recipe has an openrouter variant with a Qwen model (Alibaba, the only host, has a datacentre in China)", qwen.length === 0, qwen.map((r) => r.id).join(", "));
        const bad = [];
        let edits = 0, texts = 0;
        for (const r of served) {
            const raw = rawRecipe(r.id);
            const v = r.providers.openrouter;
            const o = v.options || {};
            const accepts = Array.isArray(o.accepts) ? o.accepts : [];
            if (r.providerIds[r.providerIds.length - 1] !== "openrouter") bad.push(r.id + ": openrouter is not the last provider (" + r.providerIds.join(",") + ")");
            if (r.default !== raw.default) bad.push(r.id + ": the default moved from " + raw.default + " to " + r.default);
            if (r.default === "openrouter") bad.push(r.id + ": openrouter became the home provider");
            if (raw.providers.toapis && r.providerIds[0] !== "toapis") bad.push(r.id + ": toapis is not first");
            if (!v.text || !v.text.model || !Array.isArray(v.text.sizes) || !v.text.sizes.length) bad.push(r.id + ": no text shape " + JSON.stringify(v.text));
            else if (v.text.model !== v.model) bad.push(r.id + ": the text model " + v.text.model + " is not the edit model " + v.model);
            for (const st of v.settings || []) if (!accepts.includes(st.key)) bad.push(r.id + ": the setting " + st.key + " is not in accepts");
            if (!Array.isArray(o.ratios) || !o.ratios.length || o.ratios.includes("auto")) bad.push(r.id + ": ratios " + JSON.stringify(o.ratios));
            if (!(typeof o.max_images === "number" && o.max_images > 0)) bad.push(r.id + ": max_images " + JSON.stringify(o.max_images));
            if (accepts.includes("resolution")) {
                const tiers = o.tiers && typeof o.tiers === "object" ? o.tiers : {};
                if (!Object.keys(tiers).length) bad.push(r.id + ": resolution accepted without tiers");
                const row = (v.settings || []).find((st) => st.key === "resolution");
                if (row && !row.spec[0].filter((x) => x !== "auto").every((x) => x in tiers)) bad.push(r.id + ": a Resolution option is no tier");
            }
            if (!/not run against the live API yet/.test(String(v.note || ""))) bad.push(r.id + ": the note lacks the live-test sentence");
            if (!/Also on OpenRouter\./.test(String(r.description || ""))) bad.push(r.id + ": the description does not say Also on OpenRouter");
            const allowed = (k, kind) => ["model", "prompt", "provider"].includes(k) || (k === "input_references" && kind !== "text") || accepts.includes(k);
            if (v.edit !== false) {
                const params = {};
                for (const st of v.settings || []) params[st.key] = st.spec[1].default;
                Object.assign(params, v.fixed || {});
                const s = fakeServer();
                const req = editReq(v, { kind: v.input === "edit" ? "edit" : "fill", width: 1024, height: 768, image: pngOf(1024, 768, 80, "CROP"), mask: pngOf(1024, 768, 80, "MASK"), params });
                await openrouter.edit(req, ctxFor(s));
                const b = s.images[0];
                const extra = b ? Object.keys(b).filter((k) => !allowed(k, req.kind)) : ["no request"];
                if (extra.length) bad.push(r.id + " edit: keys outside accepts: " + extra.join(","));
                if (b && ("aspect_ratio" in b)) bad.push(r.id + " edit: an aspect_ratio");
                if (b && accepts.includes("resolution") && !b.resolution) bad.push(r.id + " edit: no resolution");
                if (b && refsOf(b).length !== (req.kind === "fill" ? 2 : 1)) bad.push(r.id + " edit: " + refsOf(b).length + " pictures");
                if (b && b.model !== v.model) bad.push(r.id + " edit: model " + b.model);
                edits++;
            }
            const tparams = {};
            for (const st of v.text.settings || []) tparams[st.key] = st.spec[1].default;
            Object.assign(tparams, v.text.fixed || {});
            const t = fakeServer();
            await openrouter.generate(textReq(v, { params: tparams, aspect: "1:1", width: 1024, height: 1024 }), ctxFor(t));
            const tb = t.images[0];
            const textExtra = tb ? Object.keys(tb).filter((k) => !allowed(k, "text")) : ["no request"];
            if (textExtra.length) bad.push(r.id + " text: keys outside accepts: " + textExtra.join(","));
            if (tb && accepts.includes("aspect_ratio") && tb.aspect_ratio !== "1:1") bad.push(r.id + " text: aspect_ratio " + tb.aspect_ratio);
            if (tb && ("input_references" in tb)) bad.push(r.id + " text: input_references");
            texts++;
        }
        check("every variant: openrouter last, the home default kept, toapis first where present, a text shape, settings within accepts, ratios, max_images, tiers, the notes; each builds an edit and a text request with accepted keys only", !bad.length, bad.join("; ") || `${served.length} recipes, ${edits} edits, ${texts} text runs`);
        const krea = served.find((r) => r.id === "krea_2"), recraft = served.find((r) => r.id === "recraft_v4");
        check("Krea 2 and Recraft V4 are text to image only on OpenRouter (edit false)", !!krea && krea.providers.openrouter.edit === false && !!recraft && recraft.providers.openrouter.edit === false, short({ krea: krea && krea.providers.openrouter.edit, recraft: recraft && recraft.providers.openrouter.edit }));
    });

    // ---- 11. prompt upsampling on the OpenRouter key (llm.js) ----
    await section("11. llm.js", async () => {
        openrouter._resetHosts();
        let currentKey = KEY;
        let currentSettings = { openrouter: { base: BASE } };
        const orig = Module._load;
        const llmPath = path.join(ROOT, "electron", "main", "llm.js");
        Module._load = function (request, parent, ...rest) {
            if (request === "electron") return { app: { getPath: () => path.join(os.tmpdir(), "scumble-openrouter-test-llm") }, safeStorage: {} };
            if (parent && parent.filename === llmPath) {
                if (request === "./keys") return { get: (id) => (id === "openrouter" ? currentKey : ""), describe: (id) => ({ set: id === "openrouter" }) };
                if (request === "./settings") return { get: () => currentSettings };
            }
            return orig.call(this, request, parent, ...rest);
        };
        let llm;
        try { llm = require(llmPath); } finally { Module._load = orig; }

        const rows = llm.list();
        const orRows = rows.filter((r) => r.provider === "openrouter");
        const firstOr = rows.findIndex((r) => r.provider === "openrouter");
        check("llm.list(): four openrouter rows, after every other row, each with key true", orRows.length === 4 && firstOr === rows.length - 4 && orRows.every((r) => r.key === true) && rows.filter((r) => r.provider !== "openrouter").every((r) => r.key === false), short(rows.map((r) => `${r.id}:${r.key}`)));
        check("no listed row carries a reasoning field (list() names id, provider, model, label, key)", rows.every((r) => !("reasoning" in r)) && eq(Object.keys(orRows[0] || {}).sort(), ["id", "key", "label", "model", "provider"]), short(orRows[0]));
        check("the rows are the curated ids", eq(orRows.map((r) => r.id), ["openrouter:google/gemini-3.8-flash", "openrouter:openai/gpt-5.6-luna", "openrouter:anthropic/claude-haiku-4.5", "openrouter:mistralai/mistral-small-2603"]), short(orRows.map((r) => r.id)));

        const realFetch = globalThis.fetch;
        const IMAGE = pngOf(64, 64, 90, "UPSAMPLE");
        async function scenario(id, answers, opts = {}) {
            const calls = [];
            const chats = [];
            globalThis.fetch = async (url, init = {}) => {
                const method = String(init.method || "GET").toUpperCase();
                const call = { url: String(url), method, headers: recordHeaders(init) };
                calls.push(call);
                ALL_CALLS.push(call);
                const u = new URL(String(url));
                if (u.pathname === "/api/v1/providers") return json(200, { data: PROVIDERS_LIST });
                if (u.pathname === "/api/v1/chat/completions" && method === "POST") {
                    const body = JSON.parse(init.body);
                    chats.push({ ...call, body });
                    const a = answers[Math.min(chats.length, answers.length) - 1];
                    return a();
                }
                return json(404, { error: { code: 404, message: "no route " + u.pathname } });
            };
            try {
                const res = await llm.ask({ id, instruction: "rewrite the prompt", image: opts.noImage ? null : IMAGE });
                return { calls, chats, res };
            } catch (err) {
                return { calls, chats, err: String(err && err.message || err) };
            } finally {
                globalThis.fetch = realFetch;
            }
        }
        const answer = (content, extra = {}) => () => json(200, { id: "gen-1", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { cost: 0.0001 }, ...extra });
        const fail = (status, message, headers) => () => json(status, { error: { code: status, message } }, headers);
        const GEMINI = "openrouter:google/gemini-3.8-flash", HAIKU = "openrouter:anthropic/claude-haiku-4.5";

        const a = await scenario(GEMINI, [answer("a rewritten prompt")]);
        const c = a.chats[0];
        check("ask: one POST to <base>/api/v1/chat/completions, after one read of the host list", !a.err && a.chats.length === 1 && c.url === BASE + "/api/v1/chat/completions" && a.calls.filter((x) => /\/providers$/.test(x.url)).length === 1, short({ err: a.err, calls: a.calls.map((x) => x.method + " " + x.url) }));
        check("ask: Bearer key and JSON, nothing else", !!c && eq(Object.keys(c.headers).sort(), ["authorization", "content-type"]) && c.headers.authorization === "Bearer " + KEY, short(c && c.headers));
        const content = c && c.body.messages[0].content;
        const img = Array.isArray(content) && content[1] && fromDataUrl(content[1].image_url && content[1].image_url.url);
        check("ask: the text part, then the crop as an image_url data URL", Array.isArray(content) && content.length === 2 && eq(content[0], { type: "text", text: "rewrite the prompt" }) && content[1].type === "image_url" && !!img && img.mime === "image/png" && img.bytes.equals(IMAGE), short(content && content.map((p) => p.type)));
        check("ask: the row's reasoning switch {effort: low, exclude: true}", !!c && eq(c.body.reasoning, { effort: "low", exclude: true }), short(c && c.body.reasoning));
        check("ask: provider {data_collection: deny, ignore: the hosts in China}", !!c && eq(c.body.provider, { data_collection: "deny", ignore: EXPECT_IGNORE }), short(c && c.body.provider));
        check("ask: model, max_tokens, stream false", !!c && c.body.model === "google/gemini-3.8-flash" && c.body.max_tokens === 4096 && c.body.stream === false, short(c && { model: c.body.model, max_tokens: c.body.max_tokens, stream: c.body.stream }));
        check("ask: the answer is the text, with no note", !!a.res && a.res.text === "a rewritten prompt" && a.res.note === "" && a.res.model === "google/gemini-3.8-flash", short(a.res));
        const hk = await scenario(HAIKU, [answer("a haiku prompt")]);
        check("the Haiku row sends no reasoning field, and the same provider object", !hk.err && hk.chats.length === 1 && !("reasoning" in hk.chats[0].body) && eq(hk.chats[0].body.provider, { data_collection: "deny", ignore: EXPECT_IGNORE }) && hk.chats[0].body.model === "anthropic/claude-haiku-4.5", short({ err: hk.err, body: hk.chats[0] && Object.keys(hk.chats[0].body) }));
        const d = await scenario(GEMINI, [fail(402, "Insufficient credits. Add more using https://openrouter.ai/credits"), answer("never")]);
        check("402: one call, no text-only retry, credits too low", d.chats.length === 1 && !!d.err && /credits too low/.test(d.err), short({ err: d.err, chats: d.chats.length }));
        const e = await scenario(GEMINI, [fail(429, "Rate limit exceeded", { "retry-after": "1" }), answer("never")]);
        check("429: not asked again without the image, reads rate limited", e.chats.length === 1 && Array.isArray(e.chats[0].body.messages[0].content) && !!e.err && /rate limited/.test(e.err), short({ err: e.err, chats: e.chats.length }));
        const f = await scenario(GEMINI, [fail(400, "image_url content part is not supported by this model"), answer("a text only prompt")]);
        check("400 naming the image: asked again without it, the answer says text only", f.chats.length === 2 && Array.isArray(f.chats[0].body.messages[0].content) && typeof f.chats[1].body.messages[0].content === "string" && !!f.res && f.res.text === "a text only prompt" && f.res.note === "text only" && eq(f.chats[1].body.provider, { data_collection: "deny", ignore: EXPECT_IGNORE }), short({ err: f.err, chats: f.chats.length, res: f.res }));
        const f2 = await scenario(GEMINI, [fail(400, "max_tokens must be at least 16"), answer("never")]);
        check("400 that does not name the image: not retried", f2.chats.length === 1 && !!f2.err && /request refused/.test(f2.err), short({ err: f2.err, chats: f2.chats.length }));
        const g = await scenario(GEMINI, [() => json(200, { id: "gen-2", choices: [{ index: 0, message: { role: "assistant", content: "a half-written pro" }, finish_reason: "error", error: { code: 502, message: "Provider disconnected mid-stream", metadata: { error_type: "provider_unavailable" } } }] })]);
        check("HTTP 200 with finish_reason error and partial content: thrown, not returned", !!g.err && !g.res && /Provider disconnected mid-stream/.test(g.err) && g.chats.length === 1, short({ err: g.err, res: g.res }));
        const g2 = await scenario(GEMINI, [() => json(200, { error: { code: 502, message: "Upstream error before any output" } })]);
        check("HTTP 200 with only an error object: thrown", !!g2.err && !g2.res && /Upstream error before any output/.test(g2.err), short({ err: g2.err, res: g2.res }));
        const g3 = await scenario(HAIKU, [() => json(200, { choices: [{ index: 0, message: { role: "assistant", content: null, refusal: "I can't help with that image." }, finish_reason: "content_filter" }] })]);
        check("a refusal (finish_reason content_filter, message.refusal) is thrown with its reason", !!g3.err && !g3.res && /refused: I can't help with that image\./.test(g3.err), short({ err: g3.err, res: g3.res }));
        const g4 = await scenario(GEMINI, [() => json(200, { choices: [{ index: 0, message: { role: "assistant", content: "a half written prom" }, finish_reason: "content_filter" }] })]);
        check("content cut by a content filter is not taken as the prompt", !!g4.err && !g4.res && /refused by a content filter/.test(g4.err), short({ err: g4.err, res: g4.res }));
        const g5 = await scenario(GEMINI, [() => json(200, { choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "error", error: { code: 401, message: "upstream rejected the key " + KEY } }] })]);
        check("an error inside a 200 answer that echoes the key: thrown without the key", !!g5.err && !g5.res && !g5.err.includes(KEY) && /upstream rejected the key \[key\]/.test(g5.err), short({ err: g5.err }));
        const g6 = await scenario(HAIKU, [() => json(200, { choices: [{ index: 0, message: { role: "assistant", content: null, refusal: "I will not describe that image." }, finish_reason: "stop" }] })]);
        check("a refusal with finish_reason stop (message.refusal set) is thrown with its reason", !!g6.err && !g6.res && /refused: I will not describe that image\./.test(g6.err), short({ err: g6.err, res: g6.res }));
        const g7 = await scenario(GEMINI, [() => json(200, { choices: [{ index: 0, message: { role: "assistant", content: "a half-writ" }, finish_reason: "error" }] })]);
        check("finish_reason error without an error object: thrown, not returned", !!g7.err && !g7.res && /the model failed while answering/.test(g7.err), short({ err: g7.err, res: g7.res }));
        const h = await scenario(GEMINI, [fail(401, "Invalid credentials: " + KEY)]);
        check("401 echoing the key: the key is not in the error", !!h.err && /key refused/.test(h.err) && !h.err.includes(KEY), h.err);
        // openrouter.explain is exported for llm.js as "the same words for a failed chat request on the OpenRouter
        // key"; the docs (api_reference/limits "Handling 402 errors", errors-and-debugging "moderation") put the
        // key's own limit and the flagged reasons in error.metadata, which an image run reads
        const kl = await scenario(GEMINI, [() => json(402, { error: { code: 402, message: "Key limit exceeded", metadata: { limit_source: "openrouter_key_limit", remedy_hint: "raise the key's limit" } } }), answer("never")]);
        check("402 of the key's own limit (metadata.limit_source openrouter_key_limit): one call, the key's spending limit, not top up credits (the words of an image run)", kl.chats.length === 1 && !!kl.err && /spending limit/.test(kl.err) && !/top up/.test(kl.err), short({ err: kl.err, chats: kl.chats.length }));
        const fl = await scenario(GEMINI, [() => json(403, { error: { code: 403, message: "Input was flagged", metadata: { reasons: ["violence"], flagged_input: "..." } } }), answer("never")]);
        check("403 with metadata.reasons: one call, the reasons listed (the words of an image run)", fl.chats.length === 1 && !!fl.err && /content policy \(violence\)/.test(fl.err), short({ err: fl.err, chats: fl.chats.length }));
        check("the key never appears in an upsampling error (402, 429, 400, 403, 200 errors)", ![d, e, f2, g, g2, kl, fl].some((x) => String(x.err).includes(KEY)), "");
        currentKey = REAL_KEY;
        const i = await scenario(GEMINI, [answer("never")]);
        check("a real-looking key with the loopback base is refused with no call", !!i.err && /only a test key goes there/.test(i.err) && i.calls.length === 0 && !i.err.includes(REAL_KEY), short({ err: i.err, calls: i.calls.length }));
        currentKey = KEY;
        currentSettings = {};
        const j = await scenario(GEMINI, [answer("never")]);
        check("a test key with no base setting (openrouter.ai) is refused with no call", !!j.err && /test key is never sent/.test(j.err) && j.calls.length === 0, short({ err: j.err, calls: j.calls.length }));
        currentSettings = { openrouter: { base: BASE } };
        check("the llm host-list reads carry no key", ALL_CALLS.filter((x) => /\/api\/v1\/providers$/.test(x.url)).every((x) => !("authorization" in x.headers)), "");
    });

    // ---- 12. every upsampling provider takes its key out of an error (llm.ask) ----
    await section("12. llm.js: the key out of every provider's error", async () => {
        const K = { openai: "sk-proj-openai-0123456789abcdef", gemini: "AIzaSyGemini0123456789abcdef", anthropic: "sk-ant-api03-0123456789abcdef", toapis: "sk-toapis-0123456789abcdef", compat: "sk-compat-0123456789abcdef" };
        const CURRENT = { key: K };
        const orig = Module._load;
        const llmPath = path.join(ROOT, "electron", "main", "llm.js");
        delete require.cache[llmPath];
        Module._load = function (request, parent, ...rest) {
            if (request === "electron") return { app: { getPath: () => path.join(os.tmpdir(), "scumble-openrouter-test-llm") }, safeStorage: {} };
            if (parent && parent.filename === llmPath) {
                if (request === "./keys") return { get: (id) => CURRENT.key[id] || "", describe: (id) => ({ set: !!CURRENT.key[id] }) };
                if (request === "./settings") return { get: () => ({ llm: { compat: { url: "http://127.0.0.1:5999", model: "local-vision" } } }) };
            }
            return orig.call(this, request, parent, ...rest);
        };
        let llm2;
        try { llm2 = require(llmPath); } finally { Module._load = orig; delete require.cache[llmPath]; }
        const realFetch = globalThis.fetch;
        async function echo(id, answer) {
            globalThis.fetch = async () => answer();
            try { await llm2.ask({ id, instruction: "rewrite the prompt", image: null }); return null; } catch (e) { return String(e && e.message || e); } finally { globalThis.fetch = realFetch; }
        }
        const cases = [
            ["openai:gpt-5.6-luna", () => json(401, { error: { message: "Incorrect API key provided: " + K.openai } }), K.openai],
            ["gemini:gemini-3.8-flash", () => json(400, { error: { message: "API key not valid: " + K.gemini } }), K.gemini],
            ["anthropic:claude-haiku-4-5", () => json(401, { error: { message: "invalid x-api-key " + K.anthropic } }), K.anthropic],
            ["toapis:gemini-3.8-flash", () => json(200, { choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "error", error: { message: "upstream said " + K.toapis } }] }), K.toapis],
            ["toapis:gemini-3.8-flash", () => json(200, { error: { message: "bad token " + K.toapis } }), K.toapis],
            ["compat:local-vision", () => json(200, { error: { message: "upstream said " + K.compat } }), K.compat],
        ];
        const out = [];
        for (const [id, answer, key] of cases) {
            const err = await echo(id, answer);
            out.push({ id, err, leaked: !!err && err.includes(key), scrubbed: !!err && err.includes("[key]") });
        }
        check("OpenAI, Gemini, Anthropic, ToAPIs (failed status and errors inside a 200) and the local endpoint: the key is taken out", out.every((o) => o.err && !o.leaked && o.scrubbed), short(out));
        CURRENT.key = { ...K, compat: "ollama" };
        const short6 = await echo("compat:local-vision", () => json(404, { error: { message: "model not found, try: ollama pull llava" } }));
        check("a local server's short placeholder key is not scrubbed from its own words", !!short6 && /ollama pull llava/.test(short6) && !short6.includes("[key]"), short6);
    });

    // ---- the whole run: no attribution header on any call ----
    const attribution = (k) => /^(http-referer|referer|x-title)$/i.test(k) || /^x-openrouter-/i.test(k);
    const offenders = ALL_CALLS.filter((c) => Object.keys(c.headers).some(attribution));
    check("no call of the whole run carried HTTP-Referer, Referer, X-Title or X-OpenRouter-*", ALL_CALLS.length > 50 && !offenders.length, offenders.length ? short(offenders.map((c) => c.url + " " + Object.keys(c.headers).join(","))) : `${ALL_CALLS.length} calls`);

    const failed = results.filter((x) => !x).length;
    console.log(`${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + (err && err.stack || err)); console.log("FAIL"); process.exit(1); });
