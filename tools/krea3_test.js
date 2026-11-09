// Krea 3 Edit (recipes/krea_3.json) on every host that lists it: fal, WaveSpeed, Replicate, Comfy Cloud, OpenRouter (K3 Edit),
// Comfy Router and Oxen.ai, in plain Node, no Electron, no key and no network:
//   node tools/krea3_test.js
// The light tier (CLAUDE.md "Working rules"): written from the hosts' docs and schemas, read 2026-11-09 and saved under
// docs/research/krea3_2026-11-09/ and tools/refs/ (comfyrouter, oxen, comfy_cloud/nodes), never run against the live API.
// A scripted fetch plays each host, records the request a run sends and answers with a picture; every body is held to the
// host's saved schema or to the fields its page lists. What it pins: the pictures in the host's own list, crop first (a new
// image: the references alone, on fal and WaveSpeed through the /edit route); the sizes, the aspect presets and the
// stitch's fit; each route's own planning row and value; WaveSpeed's and the Router's Berry / Jam; the names a prompt's
// reference goes out as; the rules a host states for "ultra"; the eight-picture cap; no mask anywhere.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
function recipesModule() {
    const Module = require("node:module");
    const orig = Module._load;
    Module._load = function (request, ...rest) {
        if (request === "electron") return { app: { getPath: () => path.join(require("node:os").tmpdir(), "scumble-krea3-test") } };
        return orig.call(this, request, ...rest);
    };
    try { return require(path.join(ROOT, "electron", "main", "recipes.js")); } finally { Module._load = orig; }
}
const P = (id) => require(path.join(ROOT, "electron", "main", "providers", id + ".js"));
const fal = P("fal"), replicate = P("replicate"), wavespeed = P("wavespeed"), openrouter = P("openrouter"), cloud = P("comfycloud"), router = P("comfyrouter"), oxen = P("oxen");
const { nameOf, instruction, countOf, checkPictures } = P("refs");
const RESEARCH = path.join(ROOT, "docs", "research", "krea3_2026-11-09");
const REFS = path.join(ROOT, "tools", "refs");

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${!ok && detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 500 ? s.slice(0, 500) + " ..." : s; };
async function section(name, fn) {
    console.log(`\n--- ${name} ---`);
    try { await fn(); } catch (err) { check(`${name}: ran through`, false, String(err && err.stack || err).split(/\r?\n/).slice(0, 4).join(" ")); }
}
async function thrown(fn) { try { await fn(); return null; } catch (err) { return String(err && err.message || err); } }

function pngOf(w, h, tag = "", size = 80) {
    const b = Buffer.alloc(Math.max(size, 33 + tag.length), 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    b[24] = 8;
    b[25] = 6;
    b.write(tag, 33, "latin1");
    return b;
}
const tagOf = (b) => Buffer.from(b).toString("latin1", 33, 45).replace(/\0+$/, "");
const fromDataUri = (u) => { const m = /^data:[^;,]+;base64,(.*)$/s.exec(String(u || "")); return m ? Buffer.from(m[1], "base64") : null; };
const RESULT = pngOf(1024, 1024, "RESULT");
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const png = () => new Response(RESULT, { status: 200, headers: { "content-type": "image/png" } });

const recipes = recipesModule();
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "recipes", "krea_3.json"), "utf8"));
const R = recipes._normalize(JSON.parse(JSON.stringify(raw)));
const V = (pid) => R.providers[pid];
const TEN = ["1:1", "4:5", "3:4", "2:3", "9:16", "5:4", "4:3", "3:2", "16:9", "21:9"];
const SEVEN = ["1:1", "4:3", "3:2", "16:9", "4:5", "2:3", "9:16"];

function paramsOf(v, over = {}, text = false) {
    const p = {};
    for (const s of v.settings || []) p[s.key] = s.spec[1].default;
    Object.assign(p, v.fixed || {});
    if (text && v.text && v.text.fixed) Object.assign(p, v.text.fixed);
    return { ...p, ...over };
}
const r1 = pngOf(600, 400, "REF1"), r2 = pngOf(400, 600, "REF2");
function editReq(pid, extra = {}) {
    const v = V(pid), w = extra.width || 1216, h = extra.height || 832;
    return {
        provider: pid, model: v.model, kind: "edit", options: v.options || null, fields: v.fields || null,
        prompt: "make the door red", negative: "blurry", seed: 42, refName: v.refs.name,
        image: pngOf(w, h, "CROP"), mask: pngOf(w, h, "MASK"), maskAlpha: pngOf(w, h, "MASKALPHA"),
        width: w, height: h, references: [], original: 0, params: paramsOf(v), ...extra,
    };
}
function textReq(pid, extra = {}) {
    const v = V(pid), t = v.text;
    const refs = extra.references || [];
    const model = refs.length && t.refs && t.refs.model ? t.refs.model : t.model;
    return {
        provider: pid, model, kind: "text", options: v.options || null, fields: v.fields || null,
        prompt: "a lighthouse at dusk", negative: "blurry", seed: 7, refName: v.refs.name,
        image: null, mask: null, maskAlpha: null, references: [], original: 0,
        width: 1344, height: 768, aspect: "16:9", params: paramsOf(v, {}, true), ...extra,
    };
}

async function runFal(req) {
    let body = null, route = null;
    const fetch = async (url, init = {}) => {
        const u = new URL(String(url)), method = String(init.method || "GET").toUpperCase();
        if (method === "POST") {
            body = JSON.parse(init.body);
            route = u.pathname.replace(/^\/+/, "");
            const base = `https://queue.fal.run${u.pathname}/requests/r1`;
            return json(200, { request_id: "r1", status: "IN_QUEUE", status_url: base + "/status", response_url: base });
        }
        if (u.pathname.endsWith("/status")) return json(200, { status: "COMPLETED" });
        if (u.hostname === "queue.fal.run") return json(200, { images: [{ url: "https://v3.fal.media/files/r1.png", content_type: "image/png" }], seed: 11 });
        if (u.hostname === "v3.fal.media") return png();
        return json(404, { detail: "no route " + u.pathname });
    };
    const ctx = { key: "test-fal", fetch, log() {}, sleep: async () => {} };
    const out = await fal.edit(req, ctx);
    return { out, body, route };
}
async function runReplicate(req) {
    let body = null, url0 = null;
    const fetch = async (url, init = {}) => {
        const u = new URL(String(url)), method = String(init.method || "GET").toUpperCase();
        if (method === "POST" && u.hostname === "api.replicate.com") {
            url0 = String(url);
            body = JSON.parse(init.body);
            return json(201, { id: "p1", status: "succeeded", output: "https://replicate.delivery/p1.png", metrics: { predict_time: 3 } });
        }
        if (u.hostname === "replicate.delivery") return png();
        return json(404, { detail: "no route " + u.pathname });
    };
    const out = await replicate.edit(req, { key: "r8_test", fetch, log() {} });
    return { out, body, url: url0 };
}
async function runWs(req) {
    const stored = new Map();
    let body = null, route = null, k = 0;
    const fetch = async (url, init = {}) => {
        const u = new URL(String(url)), method = String(init.method || "GET").toUpperCase();
        if (method === "POST" && u.pathname === "/api/v3/media/uploads") {
            const n = ++k;
            return json(200, { code: 200, data: { download_url: `https://cdn.wavespeed.test/u${n}`, upload: { url: `https://put.wavespeed.test/u${n}`, method: "PUT" } } });
        }
        if (method === "PUT" && u.hostname === "put.wavespeed.test") { stored.set(`https://cdn.wavespeed.test${u.pathname}`, tagOf(Buffer.from(init.body))); return new Response(null, { status: 200 }); }
        if (method === "POST" && u.hostname === "api.wavespeed.ai") {
            body = JSON.parse(init.body);
            route = u.pathname.replace(/^\/api\/v3\//, "");
            return json(200, { code: 200, data: { id: "p1", status: "completed", urls: { get: "https://api.wavespeed.ai/api/v3/predictions/p1/result" }, outputs: ["https://cdn.wavespeed.test/out.png"] } });
        }
        if (u.hostname === "cdn.wavespeed.test") return png();
        return json(404, { code: 404, message: "no route " + u.pathname });
    };
    const out = await wavespeed.edit(req, { key: "test-ws", fetch, log() {} });
    const tagged = (v) => (Array.isArray(v) ? v.map((x) => stored.get(x)) : stored.get(v));
    return { out, body, route, tagged };
}
async function runOr(req, verb = "edit") {
    const bodies = [];
    const fetch = async (url, init = {}) => {
        const u = new URL(String(url)), method = String(init.method || "GET").toUpperCase();
        if (u.pathname === "/api/v1/providers") return json(200, { data: [] });
        if (u.pathname === "/api/v1/images" && method === "POST") {
            bodies.push(JSON.parse(init.body));
            return json(200, { created: 1, data: [{ b64_json: RESULT.toString("base64"), media_type: "image/png" }], usage: { cost: 0.04 } });
        }
        return json(404, { error: { message: "no route " + u.pathname } });
    };
    if (openrouter._resetHosts) openrouter._resetHosts();
    const out = await openrouter[verb](req, { key: "test-or-0123456789abcdef", base: "http://127.0.0.1:5555", fetch, log() {}, sleep: async () => {} });
    return { out, body: bodies[0] };
}
async function runOxen(req, verb = "edit") {
    const calls = [];
    const fetch = async (url, init = {}) => {
        const u = new URL(String(url));
        calls.push({ path: u.pathname, body: JSON.parse(init.body) });
        return json(200, { model: "krea-3", created: 1, images: [{ b64_json: RESULT.toString("base64") }] });
    };
    const out = await oxen[verb](req, { key: "test-ox-0123456789", base: "http://127.0.0.1:5556", fetch, log() {}, sleep: async () => {} });
    return { out, body: calls[0].body, path: calls[0].path };
}
/** Comfy Router on a loopback host: each picture to Krea's asset route, the queue through the SDK (the global fetch), the download. */
async function runRouter(req, verb = "edit", opts = {}) {
    const assets = [], submits = [];
    const BASE = "http://127.0.0.1:5557", RID = "11111111-2222-4333-8444-555555555555";
    const fetch = async (url, init = {}) => {
        const u = new URL(String(url)), method = String(init.method || "GET").toUpperCase();
        if (method === "POST" && u.pathname === "/proxy/krea/assets") {
            if (opts.assetFails) return json(413, { detail: "too large" });
            const f = init.body.get("file");
            const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
            assets.push({ tag: tagOf(Buffer.from(await f.arrayBuffer())), mime: f.type, headers });
            return json(200, { id: `a${assets.length}`, image_url: opts.assetUrl || `${BASE}/krea/${assets.length}.png`, uploaded_at: "2026-11-09T10:00:00Z" });
        }
        if (method === "POST" && u.pathname === "/v2/models/krea/krea-3/requests") {
            submits.push(JSON.parse(init.body));
            return json(201, { request_id: RID, status: "IN_QUEUE", queue_position: 0, status_url: "x", response_url: "x", cancel_url: "x" }, { "x-comfy-request-id": RID });
        }
        if (method === "GET" && u.pathname.endsWith("/status")) return json(200, { request_id: RID, status: "COMPLETED", queue_position: 0 });
        if (method === "GET" && u.pathname.startsWith("/v2/models/")) return json(200, { job_id: RID, status: "completed", result: { urls: [`${BASE}/asset/k.png`] } });
        if (method === "GET" && u.pathname.startsWith("/asset/")) return png();
        return json(404, { detail: "no route " + u.pathname });
    };
    const real = globalThis.fetch;
    globalThis.fetch = fetch;
    try {
        const out = await router[verb](req, { key: "test-router-0123456789", base: BASE, fetch, log() {}, sleep: async () => {}, routerRetry: { baseDelayMs: 1, maxDelayMs: 5, budgetMs: 200 }, opaque: () => true, toJpeg: () => null });
        return { out, body: submits[0], assets };
    } finally { globalThis.fetch = real; }
}
/** The graph buildGraph makes for `req` on Comfy Cloud's legacy path; each upload's tag kept. */
async function graphOf(req) {
    const uploads = [];
    const fetch = async (url, init = {}) => {
        const file = init.body && typeof init.body.get === "function" ? init.body.get("image") : null;
        uploads.push(file ? tagOf(Buffer.from(await file.arrayBuffer())) : "?");
        return json(200, { name: `u${uploads.length}.png`, subfolder: "", type: "input" });
    };
    const graph = await cloud._buildGraph(req, { key: "k-test", fetch, log() {} }, req.options.node);
    const node = Object.values(graph).find((x) => x.class_type === "Krea3ImageNode") || { inputs: {} };
    const tagAt = (link) => { const at = Array.isArray(link) ? graph[link[0]] : null; return at && at.class_type === "LoadImage" ? uploads[+at.inputs.image.replace(/^u|\.png$/g, "") - 1] : null; };
    return { graph, inputs: node.inputs, uploads, tagAt };
}

const notIn = (body, schema) => Object.keys(body).filter((k) => !(k in schema.properties));

async function main() {
    const falEdit = JSON.parse(fs.readFileSync(path.join(RESEARCH, "fal_krea_v3_edit_openapi.json"), "utf8")).components.schemas.V3EditInput;
    const falText = JSON.parse(fs.readFileSync(path.join(RESEARCH, "fal_krea_v3_t2i_openapi.json"), "utf8")).components.schemas.V3TextToImageInput;
    const replInput = JSON.parse(fs.readFileSync(path.join(RESEARCH, "replicate_krea-3_input.json"), "utf8"));
    const orEndpoint = JSON.parse(fs.readFileSync(path.join(RESEARCH, "openrouter_k3-edit_endpoints.json"), "utf8")).endpoints[0];
    const oxenSchema = JSON.parse(fs.readFileSync(path.join(REFS, "oxen", "krea-3.json"), "utf8")).request_schema;
    const nodeSpec = JSON.parse(fs.readFileSync(path.join(REFS, "comfy_cloud", "nodes", "Krea3ImageNode.json"), "utf8"));

    await section("the recipe", async () => {
        check("id, name, family, the default provider", R.id === "krea_3" && R.name === "Krea 3 Edit" && R.family === "Krea" && R.default === "fal", short([R.id, R.name, R.family, R.default]));
        check("the seven hosts that list it, none of the others", eq(Object.keys(R.providers).sort(), ["comfycloud", "comfyrouter", "fal", "openrouter", "oxen", "replicate", "wavespeed"]), short(Object.keys(R.providers)));
        check("every variant edits without a mask", Object.values(R.providers).every((v) => v.input === "edit"), short(Object.values(R.providers).map((v) => v.input)));
        check("every variant says it has not run live", Object.values(R.providers).every((v) => /not run against the live API yet|this model not yet/.test(v.note || "")), "");
        check("nothing of regions or regional_edit in the recipe", !/regional_edit|"regions"/.test(JSON.stringify(raw)), "");
        check("a reference is <image-n> on fal and WaveSpeed, image n elsewhere", V("fal").refs.name === "<image-{n}>" && V("wavespeed").refs.name === "<image-{n}>" && ["openrouter", "replicate", "comfycloud", "comfyrouter", "oxen"].every((p) => V(p).refs.name === "image {n}"), short(Object.values(R.providers).map((v) => v.refs)));
        check("... as a marker's name: picture 2 on fal", nameOf(V("fal").refs.name, 2) === "<image-2>", nameOf(V("fal").refs.name, 2));
        check("OpenRouter makes no new image: it needs a picture", V("openrouter").text === null && (V("openrouter").edit !== false), short(V("openrouter").text));
        check("the five others take references to a new image, fal and WaveSpeed through /edit", V("fal").text.refs.model === "krea/v3/edit" && V("wavespeed").text.refs.model === "krea/v3/edit" && !V("replicate").text.refs.model && !V("comfycloud").text.refs.model && !V("comfyrouter").text.refs.model && !V("oxen").text.refs.model, short(Object.values(R.providers).map((v) => v.text && v.text.refs)));
        check("the limits are each host's own", V("fal").limits.pixels === 4220160 && V("fal").limits.max === 3200 && V("fal").limits.step === 16 && V("wavespeed").limits.pixels === 4194304 && V("wavespeed").limits.max === 4096, short([V("fal").limits, V("wavespeed").limits]));
        check("the preset hosts list their presets as limits.aspects, so the crop is widened to one", eq(V("openrouter").limits.aspects, SEVEN) && ["replicate", "comfycloud", "comfyrouter", "oxen"].every((p) => eq(V(p).limits.aspects, TEN)), "");
    });

    await section("fal", async () => {
        const v = V("fal");
        const e = await runFal(editReq("fal", { references: [r1, r2], params: paramsOf(v, { reasoning_level: "ultra" }) }));
        check("the edit route", e.route === "krea/v3/edit", e.route);
        check("the crop first, then the references, as inline pictures", eq(e.body.image_urls.map((u) => tagOf(fromDataUri(u))), ["CROP", "REF1", "REF2"]), short(e.body.image_urls && e.body.image_urls.length));
        check("every key is in fal's schema (no num_images)", !notIn(e.body, falEdit).length, short(notIn(e.body, falEdit)));
        check("image_size is the crop's", eq(e.body.image_size, { width: 1216, height: 832 }), short(e.body.image_size));
        check("no mask goes", !("mask_url" in e.body), short(Object.keys(e.body)));
        check("the Planning row as fal's reasoning_level", e.body.reasoning_level === "ultra", e.body.reasoning_level);
        check("its default is fal's", v.settings[0].spec[1].default === "medium" && eq(v.settings[0].spec[0], ["medium", "high", "ultra"]), short(v.settings[0]));
        const big = await runFal(editReq("fal", { width: 4000, height: 3000, image: pngOf(4000, 3000, "CROP") }));
        check("a size over the ceiling comes down to fal's rules", big.body.image_size.width * big.body.image_size.height <= 4220160 && Math.max(big.body.image_size.width, big.body.image_size.height) <= 3200 && big.body.image_size.width % 16 === 0 && big.body.image_size.height % 16 === 0, short(big.body.image_size));
        const nine = editReq("fal", { references: new Array(8).fill(r1) });
        check("nine pictures are refused before anything is sent", /at most 8 picture/.test(await thrown(() => runFal(nine)) || ""), "");
        check("the layout counts eight as allowed", countOf(fal.layout(editReq("fal", { references: new Array(7).fill(r1) }))) === 8 && fal.layout(editReq("fal")).max === 8, "");
        const t = await runFal(textReq("fal", { params: paramsOf(v, { reasoning_level: "ultra" }, true) }));
        check("a new image: the text route", t.route === "krea/v3/text-to-image", t.route);
        check("... every key in its schema, no picture", !notIn(t.body, falText).length && !("image_urls" in t.body), short(Object.keys(t.body)));
        check("... ultra, which that route lacks, goes as high", t.body.reasoning_level === "high", t.body.reasoning_level);
        check("... the asked size", eq(t.body.image_size, { width: 1344, height: 768 }), short(t.body.image_size));
        check("... a negative prompt goes (the schema has one)", t.body.negative_prompt === "blurry", t.body.negative_prompt);
        const tr = await runFal(textReq("fal", { references: [r1, r2], params: paramsOf(v, { reasoning_level: "ultra" }, true) }));
        check("a new image with references: the edit route, the references alone", tr.route === "krea/v3/edit" && eq(tr.body.image_urls.map((u) => tagOf(fromDataUri(u))), ["REF1", "REF2"]), short([tr.route, tr.body.image_urls && tr.body.image_urls.length]));
        check("... ultra stays (the edit route takes it)", tr.body.reasoning_level === "ultra", tr.body.reasoning_level);
    });

    await section("WaveSpeed", async () => {
        const v = V("wavespeed");
        const e = await runWs(editReq("wavespeed", { references: [r1], params: paramsOf(v, { reasoning_level: "medium", model: "jam" }) }));
        check("the edit route", e.route === "krea/v3/edit", e.route);
        check("the uploaded pictures in `images`, the crop first", eq(e.tagged(e.body.images), ["CROP", "REF1"]), short(e.body.images));
        check("size as W*H, the crop's", e.body.size === "1216*832", e.body.size);
        check("reasoning_level and the Berry / Jam row as `model`", e.body.reasoning_level === "medium" && e.body.model === "jam", short(e.body));
        check("only the page's fields go", Object.keys(e.body).every((k) => ["prompt", "images", "negative_prompt", "size", "reasoning_level", "model", "output_format", "seed"].includes(k)), short(Object.keys(e.body)));
        check("the defaults are WaveSpeed's", v.settings[0].spec[1].default === "low" && v.settings[1].spec[1].default === "berry", short(v.settings));
        const off = await runWs({ ...editReq("wavespeed", { params: { model: "jam" } }), options: { ...v.options, model_row: false } });
        check("without model_row a `model` row stays home (every other WaveSpeed recipe)", !("model" in off.body), short(off.body));
        const t = await runWs(textReq("wavespeed", { params: paramsOf(v, { model: "jam" }, true) }));
        check("a new image: the text route with its size", t.route === "krea/v3/text-to-image" && t.body.size === "1344*768" && !("images" in t.body) && t.body.model === "jam", short([t.route, t.body]));
        const tr = await runWs(textReq("wavespeed", { references: [r1, r2] }));
        check("a new image with references: the edit route, the references alone", tr.route === "krea/v3/edit" && eq(tr.tagged(tr.body.images), ["REF1", "REF2"]), short([tr.route, tr.body.images]));
    });

    await section("Replicate", async () => {
        const v = V("replicate");
        const e = await runReplicate(editReq("replicate", { references: [r1], width: 1216, height: 832, cropAspect: "3:2" }));
        check("Krea's official model", e.url === "https://api.replicate.com/v1/models/krea/krea-3/predictions", e.url);
        check("the pictures in `images`", e.body.input.images.length === 2 && tagOf(fromDataUri(e.body.input.images[0])) === "CROP", short(e.body.input.images.length));
        check("every key is in Replicate's schema", !notIn(e.body.input, replInput).length, short(notIn(e.body.input, replInput)));
        check("the preset the crop was widened to", e.body.input.aspect_ratio === "3:2", e.body.input.aspect_ratio);
        check("... and the answer is stretched onto the crop", e.out.info.fit === "stretch", short(e.out.info));
        check("resolution and thinking_mode at their defaults", e.body.input.resolution === "2k" && e.body.input.thinking_mode === "fast" && v.settings[0].spec[1].default === "2k", short(e.body.input));
        const odd = await runReplicate(editReq("replicate", { width: 1000, height: 390, image: pngOf(1000, 390, "CROP") }));
        check("a crop no preset fits goes on auto, no fit", odd.body.input.aspect_ratio === "auto" && !odd.out.info.fit, short([odd.body.input.aspect_ratio, odd.out.info]));
        const t = await runReplicate(textReq("replicate"));
        check("a new image: the asked aspect, no picture", t.body.input.aspect_ratio === "16:9" && !("images" in t.body.input), short(t.body.input));
        const free = await runReplicate(textReq("replicate", { aspect: null, width: 900, height: 1600 }));
        check("a free size: the closest preset, never Replicate's unknown match_input_image", free.body.input.aspect_ratio === "9:16", free.body.input.aspect_ratio);
        const tr = await runReplicate(textReq("replicate", { references: [r1, r2] }));
        check("a new image with references: `images` alone holds them", tr.body.input.images.map((u) => tagOf(fromDataUri(u))).join() === "REF1,REF2", short(tr.body.input.images.length));
    });

    await section("Comfy Cloud", async () => {
        const v = V("comfycloud");
        const g = await graphOf(editReq("comfycloud", { references: [r1, r2], cropAspect: "3:2", seed: 4294967295 }));
        check("the crop first, the references after it, from image_0", g.uploads.join() === "CROP,REF1,REF2" && g.tagAt(g.inputs["model.images.image_0"]) === "CROP" && g.tagAt(g.inputs["model.images.image_1"]) === "REF1" && g.tagAt(g.inputs["model.images.image_2"]) === "REF2" && !("model.images.image_3" in g.inputs), short(g.inputs));
        check("the one model of the combo", g.inputs.model === "Krea 3" && nodeSpec.inputs.model.options.includes(g.inputs.model), g.inputs.model);
        check("the prompt under the combo", g.inputs["model.prompt"] === "make the door red", short(g.inputs["model.prompt"]));
        check("every input the node requires goes, and none it does not list", Object.entries(nodeSpec.inputs).filter(([, s]) => s.required).every(([k]) => k in g.inputs) && Object.keys(g.inputs).every((k) => k in nodeSpec.inputs || /^model\.images\.image_\d$/.test(k)), short(Object.keys(g.inputs)));
        check("the seed under the node's maximum", g.inputs["model.seed"] <= nodeSpec.inputs["model.seed"].max, String(g.inputs["model.seed"]));
        check("the preset the crop was widened to", g.inputs["model.aspect_ratio"] === "3:2", g.inputs["model.aspect_ratio"]);
        check("precise edit stays off", g.inputs["model.precise_edit"] === false, String(g.inputs["model.precise_edit"]));
        check("the rows reach the node by their full keys", g.inputs["model.resolution"] === "2K" && g.inputs["model.thinking_mode"] === "fast", short(g.inputs));
        const u = await graphOf(editReq("comfycloud", { params: paramsOf(v, { "model.thinking_mode": "ultra", "model.resolution": "1K" }) }));
        check("Planning ultra on an edit stays", u.inputs["model.thinking_mode"] === "ultra" && u.inputs["model.resolution"] === "1K", short(u.inputs));
        const odd = await graphOf(editReq("comfycloud", { width: 1000, height: 390, image: pngOf(1000, 390, "CROP") }));
        check("a crop no preset fits goes on auto", odd.inputs["model.aspect_ratio"] === "auto", odd.inputs["model.aspect_ratio"]);
        check("the layout names the same keys", eq(cloud.layout(editReq("comfycloud", { references: [r1] })).pictures.map((p) => p.field), ["model.images.image_0", "model.images.image_1"]), short(cloud.layout(editReq("comfycloud", { references: [r1] })).pictures));
        check("eight pictures in all", cloud.layout(editReq("comfycloud")).max === 8, String(cloud.layout(editReq("comfycloud")).max));
        const nine = editReq("comfycloud", { references: new Array(8).fill(r1) });
        check("nine are refused before any upload", /at most 8 picture/.test(await thrown(() => graphOf(nine)) || ""), "");
        const t = await graphOf(textReq("comfycloud", { params: paramsOf(v, { "model.thinking_mode": "ultra" }, true) }));
        check("a new image: no crop, no picture, a preset aspect", !t.uploads.length && !Object.keys(t.inputs).some((k) => k.startsWith("model.images.")) && t.inputs["model.aspect_ratio"] === "16:9" && t.inputs["model.prompt"] === "a lighthouse at dusk", short(t.inputs));
        check("... ultra, which the node refuses with no picture, goes as high", t.inputs["model.thinking_mode"] === "high", t.inputs["model.thinking_mode"]);
        const tr = await graphOf(textReq("comfycloud", { references: [r1, r2], params: paramsOf(v, { "model.thinking_mode": "ultra" }, true) }));
        check("a new image with references: them alone, from image_0, ultra stays", tr.uploads.join() === "REF1,REF2" && tr.tagAt(tr.inputs["model.images.image_0"]) === "REF1" && tr.inputs["model.thinking_mode"] === "ultra", short(tr.inputs));
        check("the text layout matches", eq(cloud.textLayout(textReq("comfycloud", { references: [r1, r2] })).pictures.map((p) => p.field), ["model.images.image_0", "model.images.image_1"]), short(cloud.textLayout(textReq("comfycloud", { references: [r1, r2] }))));
        const other = await thrown(() => cloud.generate({ ...textReq("comfycloud"), options: { node: "Flux2ImageNode" } }, { key: "k", fetch: async () => json(404, {}), log() {} }));
        check("any other partner node still takes no text run", /own graph/.test(other || ""), other);
        check("... and its references are left out of a new image with a drop", /left out/.test(cloud.textLayout({ ...textReq("comfycloud"), options: { graph: {} } }).drops || ""), "");
    });

    await section("OpenRouter", async () => {
        const v = V("openrouter");
        const e = await runOr(editReq("openrouter", { references: [r1], width: 1216, height: 832, cropAspect: "3:2", params: paramsOf(v, { thinking_mode: "high", resolution: "2K" }) }));
        check("the model and its pictures in input_references", e.body.model === "krea/k3-edit" && e.body.input_references.length === 2 && e.body.input_references[0].type === "image_url" && tagOf(fromDataUri(e.body.input_references[0].image_url.url)) === "CROP", short([e.body.model, e.body.input_references.length]));
        const listed = new Set(["model", "prompt", "provider", "input_references", ...Object.keys(orEndpoint.supported_parameters)]);
        check("only what its endpoint lists goes (no n)", Object.keys(e.body).every((k) => listed.has(k)), short(Object.keys(e.body)));
        check("resolution and the preset the crop was widened to", e.body.resolution === "2K" && e.body.aspect_ratio === "3:2", short([e.body.resolution, e.body.aspect_ratio]));
        check("... the answer stretched onto the crop", e.out.info.fit === "stretch", short(e.out.info));
        check("Planning as Krea's passthrough", eq(e.body.provider.options, { krea: { thinking_mode: "high" } }) && orEndpoint.allowed_passthrough_parameters.includes("thinking_mode"), short(e.body.provider));
        check("the instruction names the crop as image 1", /^Edit image 1 and keep its size and framing\. make the door red\b/.test(e.body.prompt) && /Image 2 is a reference image\./.test(e.body.prompt), e.body.prompt);
        const a = await runOr(editReq("openrouter", { width: 900, height: 1500, image: pngOf(900, 1500, "CROP"), params: paramsOf(v, {}) }));
        check("Resolution auto: the smallest tier that covers the crop", a.body.resolution === "2K", a.body.resolution);
        const s = await runOr(editReq("openrouter", { width: 700, height: 500, image: pngOf(700, 500, "CROP") }));
        check("... a small crop 1K", s.body.resolution === "1K", s.body.resolution);
        const odd = await runOr(editReq("openrouter", { width: 1000, height: 390, image: pngOf(1000, 390, "CROP") }));
        check("no preset fits: no aspect_ratio (its list has no auto), no fit", !("aspect_ratio" in odd.body) && !odd.out.info.fit, short([odd.body.aspect_ratio, odd.out.info]));
        check("nine pictures are refused before sending", /at most 8 picture/.test(await thrown(() => runOr(editReq("openrouter", { references: new Array(8).fill(r1) }))) || ""), "");
        check("a value OpenRouter does not list for it never passes", openrouter._body({ ...editReq("openrouter"), params: { thinking_mode: "ultra" }, references: [] }, [], []).provider === undefined, "");
    });

    await section("Comfy Router", async () => {
        const v = V("comfyrouter");
        const e = await runRouter(editReq("comfyrouter", { references: [r1], width: 1216, height: 832, cropAspect: "3:2", negative: "x".repeat(2000), params: paramsOf(v, { model: "jam", thinking_mode: "high", resolution: "1k" }) }));
        check("each picture goes up to Krea's assets, crop first, the key as X-API-Key", e.assets.map((a) => a.tag).join() === "CROP,REF1" && e.assets.every((a) => a.headers["x-api-key"] === "test-router-0123456789" && a.mime === "image/png"), short(e.assets));
        const schema = (() => { const doc = JSON.parse(fs.readFileSync(path.join(REFS, "comfyrouter", "krea_krea-3.json"), "utf8")); return doc.paths["/v2/models/krea/krea-3"].post.requestBody.content["application/json"].schema; })();
        check("every key is in the Router's schema, the required ones go", !notIn(e.body, schema).length && schema.required.every((k) => k in e.body), short(Object.keys(e.body)));
        check("the answered URLs in order", eq(e.body.image_urls, ["http://127.0.0.1:5557/krea/1.png", "http://127.0.0.1:5557/krea/2.png"]), short(e.body.image_urls));
        check("resolution, thinking_mode, Berry / Jam as the rows say", e.body.resolution === "1k" && e.body.thinking_mode === "high" && e.body.model === "jam", short(e.body));
        check("the preset the crop was widened to, and the fit", e.body.aspect_ratio === "3:2" && e.out.info.fit === "stretch", short([e.body.aspect_ratio, e.out.info]));
        check("the negative prompt cut to the schema's 1024", e.body.negative_prompt.length === 1024, String(e.body.negative_prompt && e.body.negative_prompt.length));
        check("the instruction names the pictures", /^Edit image 1/.test(e.body.prompt) && /Image 2 is a reference image\./.test(e.body.prompt), e.body.prompt);
        check("the pictures' count in the answer", e.out.info.pictures === 2, short(e.out.info));
        const ultra = await runRouter(editReq("comfyrouter", { params: paramsOf(v, { thinking_mode: "ultra", resolution: "1k" }) }));
        check("Planning ultra needs resolution 2k: it goes as 2k", ultra.body.thinking_mode === "ultra" && ultra.body.resolution === "2k", short(ultra.body));
        const odd = await runRouter(editReq("comfyrouter", { width: 1000, height: 390, image: pngOf(1000, 390, "CROP") }));
        check("no preset fits: no aspect_ratio, the schema's automatic framing", !("aspect_ratio" in odd.body) && !odd.out.info.fit, short([odd.body.aspect_ratio, odd.out.info]));
        check("auto takes the tier that covers the crop", odd.body.resolution === "1k", odd.body.resolution);
        const t = await runRouter(textReq("comfyrouter", { params: paramsOf(v, { thinking_mode: "ultra" }, true) }), "generate");
        check("a new image: no upload, the asked aspect, a tier", !t.assets.length && !("image_urls" in t.body) && t.body.aspect_ratio === "16:9" && t.body.resolution === "2k", short([t.assets, t.body]));
        check("... ultra from the prompt alone goes as high", t.body.thinking_mode === "high", t.body.thinking_mode);
        const tr = await runRouter(textReq("comfyrouter", { references: [r1, r2], params: paramsOf(v, { thinking_mode: "ultra" }, true) }), "generate");
        check("a new image with references: them alone, ultra stays", eq(tr.assets.map((a) => a.tag), ["REF1", "REF2"]) && tr.body.image_urls.length === 2 && tr.body.thinking_mode === "ultra", short([tr.assets, tr.body]));
        check("an upload refused says so and nothing is submitted", /upload of the crop failed/.test(await thrown(() => runRouter(editReq("comfyrouter"), "edit", { assetFails: true })) || ""), "");
        check("an answer URL that is no https is not sent on", /no usable URL/.test(await thrown(() => runRouter(editReq("comfyrouter"), "edit", { assetUrl: "http://evil.example/x.png" })) || ""), "");
        const k2 = recipes._normalize(JSON.parse(fs.readFileSync(path.join(ROOT, "recipes", "krea_2.json"), "utf8"))).providers.comfyrouter;
        const k2r = { provider: "comfyrouter", model: k2.model, kind: "edit", options: k2.options, params: {}, references: [], original: 0, image: pngOf(512, 512), width: 512, height: 512 };
        check("Krea 2 stays text only on the Router", /Generate new/.test(await thrown(() => router.edit(k2r, { key: "test-x-0123456789", base: "http://127.0.0.1:5557", fetch: async () => json(404, {}), log() {} })) || ""), "");
    });

    await section("Oxen.ai", async () => {
        const v = V("oxen");
        const e = await runOxen(editReq("oxen", { references: [r1], width: 1216, height: 832, cropAspect: "3:2", params: paramsOf(v, { thinking_level: "high" }) }));
        check("the edit route with its pictures in input_image", e.path === "/api/ai/images/edit" && e.body.input_image.length === 2 && tagOf(fromDataUri(e.body.input_image[0])) === "CROP", short([e.path, e.body.input_image && e.body.input_image.length]));
        const extra = ["model", "response_format"];
        check("every other key is in the model's request_schema", Object.keys(e.body).filter((k) => !extra.includes(k) && !(k in oxenSchema.properties)).length === 0, short(Object.keys(e.body)));
        check("the Planning row as Oxen's thinking_level", e.body.thinking_level === "high" && !("thinking_mode" in e.body), short(e.body));
        check("the preset the crop was widened to, the fit", e.body.aspect_ratio === "3:2" && e.out.info.fit === "stretch", short([e.body.aspect_ratio, e.out.info]));
        const odd = await runOxen(editReq("oxen", { width: 1000, height: 390, image: pngOf(1000, 390, "CROP") }));
        check("no preset fits: auto, no fit", odd.body.aspect_ratio === "auto" && !odd.out.info.fit, short([odd.body.aspect_ratio, odd.out.info]));
        check("Resolution auto: the tier that covers the crop", odd.body.resolution === "1k", odd.body.resolution);
        const t = await runOxen(textReq("oxen"), "generate");
        check("a new image: the generate route, no picture", t.path === "/api/ai/images/generate" && !("input_image" in t.body) && t.body.aspect_ratio === "16:9", short([t.path, t.body]));
    });

    await section("the prompt's names", async () => {
        const lay = fal.layout(editReq("fal", { references: [r1] }));
        const named = { fal: lay.pictures.find((p) => p.ref === 0).n };
        check("a reference is numbered after the crop", named.fal === 2, short(lay.pictures));
        check("fal writes it as its page does", nameOf("<image-{n}>", named.fal) === "<image-2>", "");
        const words = instruction(editReq("openrouter", { references: [r1] }), openrouter.layout(editReq("openrouter", { references: [r1] })), "x");
        check("on OpenRouter the sentence uses image n", /Image 2 is a reference image/.test(words), words);
        check("the check in front of each adapter holds eight", !checkPictures(fal.layout(editReq("fal", { references: new Array(7).fill(r1) })), editReq("fal", { references: new Array(7).fill(r1) }), "fal").notes.length, "");
    });

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main();
