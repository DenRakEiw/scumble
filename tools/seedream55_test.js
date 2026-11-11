// Seedream 5.5 (recipes/seedream_5_5.json) on the hosts beside BytePlus ModelArk, in plain Node, no Electron, no key and
// no network:
//   node tools/seedream55_test.js
// The light tier (CLAUDE.md "Working rules"): written from the hosts' pages, read 2026-11-11, and never run against the
// live API. ModelArk's own requests are tools/ark_test.js's, Comfy Router's and Oxen.ai's bodies are held to their saved
// schemas by tools/comfyrouter_test.js and tools/oxen_test.js, ToAPIs' by tools/toapis_test.js. This file holds what
// has no schema test of its own: WaveSpeedAI (its llms.txt pages: bytedance/seedream-v5.5, .../edit) and Comfy Cloud
// (the Partner Node's option "seedream 5.5", tools/refs/comfy_cloud/nodes/ByteDanceSeedreamNodeV3.json).
// A scripted fetch plays each host and records the request a run sends.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
function recipesModule() {
    const Module = require("node:module");
    const orig = Module._load;
    Module._load = function (request, ...rest) {
        if (request === "electron") return { app: { getPath: () => path.join(require("node:os").tmpdir(), "scumble-seedream55-test") } };
        return orig.call(this, request, ...rest);
    };
    try { return require(path.join(ROOT, "electron", "main", "recipes.js")); } finally { Module._load = orig; }
}
const P = (id) => require(path.join(ROOT, "electron", "main", "providers", id + ".js"));
const wavespeed = P("wavespeed"), cloud = P("comfycloud"), oxen = P("oxen");
const REFS = path.join(ROOT, "tools", "refs");

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${!ok && detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 600 ? s.slice(0, 600) + " ..." : s; };
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
const RESULT = pngOf(1024, 1024, "RESULT");
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const png = (b = RESULT) => new Response(b, { status: 200, headers: { "content-type": "image/png" } });

const recipes = recipesModule();
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "recipes", "seedream_5_5.json"), "utf8"));
const R = recipes._normalize(JSON.parse(JSON.stringify(raw)));
const V = (pid) => R.providers[pid];
const WS_ASPECTS = ["1:1", "1:2", "2:1", "1:3", "3:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "9:21", "21:9"];
// the input fields WaveSpeed's pages list for the edit route and the text route (prompt and the pictures besides)
const WS_EDIT_FIELDS = ["prompt", "images", "aspect_ratio", "resolution", "output_format", "background"];
const WS_TEXT_FIELDS = ["prompt", "aspect_ratio", "resolution", "output_format", "background"];

function paramsOf(v, over = {}) {
    const p = {};
    for (const s of v.settings || []) p[s.key] = s.spec[1].default;
    Object.assign(p, v.fixed || {});
    return { ...p, ...over };
}
const r1 = pngOf(600, 400, "REF1");
function editReq(pid, extra = {}) {
    const v = V(pid), w = extra.width || 1600, h = extra.height || 900;
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
        width: 2048, height: 1152, aspect: "16:9", params: paramsOf(v), ...extra,
    };
}

/** WaveSpeed: the media upload, the submit (recorded with its route), a finished prediction, the CDN. */
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
    const out = await wavespeed.edit(req, { key: "test-ws", fetch, log() {}, sleep: async () => {} });
    const tagged = (v) => (Array.isArray(v) ? v.map((x) => stored.get(x)) : stored.get(v));
    return { out, body, route, tagged };
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
    const node = Object.values(graph).find((x) => x.class_type === "ByteDanceSeedreamNodeV3") || { inputs: {} };
    const tagAt = (link) => { const at = Array.isArray(link) ? graph[link[0]] : null; return at && at.class_type === "LoadImage" ? uploads[+at.inputs.image.replace(/^u|\.png$/g, "") - 1] : null; };
    return { graph, inputs: node.inputs, uploads, tagAt };
}

async function main() {
    const spec = JSON.parse(fs.readFileSync(path.join(REFS, "comfy_cloud", "nodes", "ByteDanceSeedreamNodeV3.json"), "utf8"));

    await section("the recipe", async () => {
        check("the hosts that list it: ModelArk, WaveSpeedAI, Comfy Cloud, ToAPIs, Comfy Router, Oxen.ai; ModelArk stays the default",
            eq(R.providerIds, ["toapis", "ark", "wavespeed", "comfycloud", "comfyrouter", "oxen"]) && R.default === "ark", short([R.providerIds, R.default]));
        check("the description names each host beside ModelArk", /Also on WaveSpeedAI\. Also on Comfy Cloud\. Also on ToAPIs\. Also on Comfy Router\. Also on Oxen\.ai\./.test(R.description), R.description);
        check("every variant edits without a mask and says it has not run live", Object.values(R.providers).every((v) => v.input === "edit" && /not run against the live API yet/.test(v.note || "")), "");
        check("the model ids, each from its host's page", V("ark").model === "dola-seedream-5-5-261028" && V("wavespeed").model === "bytedance/seedream-v5.5/edit" && V("comfycloud").model === "seedream 5.5"
            && V("toapis").model === "doubao-seedream-5-5" && V("comfyrouter").model === "byteplus/seedream-5-5-261028" && V("oxen").model === "bytedance-seedream-5-5",
            short(Object.fromEntries(Object.entries(R.providers).map(([k, v]) => [k, v.model]))));
        check("ten pictures at most on every host", ["ark", "wavespeed", "toapis", "comfyrouter", "oxen"].every((p) => V(p).options.max_images === 10), "");
        check("a Background row wherever the host passes it on and its answer keeps the alpha; none on Comfy Cloud", ["ark", "wavespeed", "toapis", "comfyrouter", "oxen"].every((p) => (V(p).settings || []).some((s) => s.key === "background" && eq(s.spec[0], ["auto", "transparent", "opaque"]))) && !(V("comfycloud").settings || []).length, "");
    });

    await section("WaveSpeedAI", async () => {
        const v = V("wavespeed");
        const e = await runWs(editReq("wavespeed", { references: [r1], params: paramsOf(v, { background: "transparent" }) }));
        check("an edit: the 5.5 edit route", e.route === "bytedance/seedream-v5.5/edit", e.route);
        check("... the uploaded crop first, then the reference, in images", eq(e.tagged(e.body.images), ["CROP", "REF1"]), short(e.body.images));
        check("... the preset closest to the crop (16:9 for 1600 x 900), Resolution 2k, Background transparent, png", e.body.aspect_ratio === "16:9" && e.body.resolution === "2k" && e.body.background === "transparent" && e.body.output_format === "png", short(e.body));
        check("... only the fields its page lists: no seed, no negative prompt", Object.keys(e.body).every((k) => WS_EDIT_FIELDS.includes(k)) && !("seed" in e.body) && !("negative_prompt" in e.body), short(Object.keys(e.body)));
        check("the Resolution row is the page's tiers, its aspects the page's fifteen", eq(v.settings[0].spec[0], ["1k", "1.5k", "2k"]) && eq(v.options.aspect_ratios, WS_ASPECTS), short(v.settings[0]));
        const a = await runWs(editReq("wavespeed"));
        check("Background auto sends none (the page's default)", !("background" in a.body), short(a.body));
        const t = await runWs(textReq("wavespeed"));
        check("a new image: the bare 5.5 route, no picture, the asked 16:9, only the text page's fields", t.route === "bytedance/seedream-v5.5" && !("images" in t.body) && t.body.aspect_ratio === "16:9" && Object.keys(t.body).every((k) => WS_TEXT_FIELDS.includes(k)), short([t.route, t.body]));
        const tr = await runWs(textReq("wavespeed", { references: [r1, pngOf(400, 600, "REF2")] }));
        check("a new image with references: the edit route, the references alone", tr.route === "bytedance/seedream-v5.5/edit" && eq(tr.tagged(tr.body.images), ["REF1", "REF2"]), short([tr.route, tr.body.images]));
        const eleven = editReq("wavespeed", { references: new Array(10).fill(r1) });
        check("eleven pictures are refused before any upload", /at most 10 picture/.test(await thrown(() => runWs(eleven)) || ""), "");
    });

    await section("Comfy Cloud", async () => {
        const g = await graphOf(editReq("comfycloud", { references: [r1] }));
        const i = g.inputs;
        check("the option \"seedream 5.5\" of the node", i.model === "seedream 5.5" && spec.inputs.model.options.includes(i.model), i.model);
        check("the crop in image_1, the reference in image_2", g.tagAt(i["model.images.image_1"]) === "CROP" && g.tagAt(i["model.images.image_2"]) === "REF1" && !("model.images.image_3" in i) && g.uploads.join() === "CROP,REF1", short(i));
        const w = i["model.width"], h = i["model.height"];
        check("Custom, a size in the crop's shape inside 0.92 to 4.62 MP, even sides inside the node's bounds", i["model.size_preset"] === "Custom" && w * h >= 921600 && w * h <= 4624220 && Math.abs(w / h - 16 / 9) < 0.02 && w % 2 === 0 && h % 2 === 0 && w >= 240 && w <= 8594 && h >= 240 && h <= 8594, short([w, h]));
        check("background opaque (the one IMAGE output drops alpha), no watermark, the seed", i["model.background"] === "opaque" && i["model.watermark"] === false && i["model.seed"] === 42 && i.prompt === "make the door red", short(i));
        check("none of the inputs the node has only for other models (thinking, prompt optimisation, batch)", spec.not_for_this_option.every((k) => !(k in i)), short(Object.keys(i)));
        check("every input is one of the option's, every required one there", Object.keys(i).every((k) => k in spec.inputs || /^model\.images\.image_\d+$/.test(k)) && Object.entries(spec.inputs).filter(([, s]) => s.required).every(([k]) => k in i), short(Object.keys(i)));
        const small = await graphOf(editReq("comfycloud", { width: 600, height: 400, image: pngOf(600, 400, "CROP") }));
        const sw = small.inputs["model.width"], sh = small.inputs["model.height"];
        check("a small crop is asked at the model's least (0.92 MP), its shape kept", sw * sh >= 921600 && Math.abs(sw / sh - 1.5) < 0.02, short([sw, sh]));
        const big = await graphOf(editReq("comfycloud", { width: 6000, height: 4000, image: pngOf(6000, 4000, "CROP") }));
        const bw = big.inputs["model.width"], bh = big.inputs["model.height"];
        check("a large crop comes down under 4.62 MP", bw * bh <= 4624220 && Math.abs(bw / bh - 1.5) < 0.02, short([bw, bh]));
        const pro = await graphOf({ ...editReq("comfycloud"), model: "seedream 5.0 pro" });
        check("5.0 pro on the same node is as before: thinking, prompt optimisation, no background", pro.inputs["model.thinking"] === true && pro.inputs["model.prompt_optimization"] === "standard" && !("model.background" in pro.inputs), short(pro.inputs));
        // (cc55-seed-range) the bug: a random seed above the node's 2147483647 sent as it is, which ComfyUI refuses
        const hi = await graphOf(editReq("comfycloud", { seed: 3e9 }));
        const hiPro = await graphOf({ ...editReq("comfycloud", { seed: 3e9 }), model: "seedream 5.0 pro" });
        check("a seed of 3e9 goes inside the node's range on 5.5 and on 5.0 (modulo 2^31)", hi.inputs["model.seed"] === 3e9 % 2147483648 && hi.inputs["model.seed"] <= spec.inputs["model.seed"].max && hiPro.inputs["model.seed"] === 3e9 % 2147483648, short([hi.inputs["model.seed"], hiPro.inputs["model.seed"]]));
        check("ten pictures in all", cloud.layout(editReq("comfycloud")).max === 10, String(cloud.layout(editReq("comfycloud")).max));
    });

    // ---- Split into layers on WaveSpeedAI and Oxen.ai (kind "layers") ----
    const split = await import(require("node:url").pathToFileURL(path.join(ROOT, "renderer", "editor", "splitlayers.js")).href);
    const layerReq = (pid, extra = {}) => ({ provider: pid, model: V(pid).model, kind: "layers", options: V(pid).options, prompt: "", negative: "", seed: 0, image: pngOf(1200, 800, "PICTURE"), width: 1200, height: 800, references: [], params: {}, ...extra });

    await section("Split into layers on WaveSpeedAI", async () => {
        const v = V("wavespeed");
        check("the variant's layer mode: up to 99, a count, no Text recognition, its own route", v.options.layers.max === 99 && v.options.layers.count === true && v.options.layers.text === false && v.options.layers.model === "bytedance/seedream-v5.5/layer-decomposition", short(v.options.layers));
        // a canned answer: the base, a layer as a bare URL (no box: the docs name none), a layer object with a box and a name
        const run = async (req, opts = {}) => {
            const stored = new Map();
            let body = null, route = null, k = 0;
            const files = { "https://cdn.wavespeed.test/base.png": pngOf(1024, 683, "BASE"), "https://cdn.wavespeed.test/l1.png": pngOf(1024, 683, "L1"), "https://cdn.wavespeed.test/l2.png": pngOf(512, 512, "L2") };
            const outputs = opts.outputs || ["https://cdn.wavespeed.test/base.png", "https://cdn.wavespeed.test/l1.png", { url: "https://cdn.wavespeed.test/l2.png", name: "dog", bounding_box: { absolute: [10, 20, 310, 420] } }];
            const fetch = async (url, init = {}) => {
                const u = new URL(String(url)), method = String(init.method || "GET").toUpperCase();
                if (method === "POST" && u.pathname === "/api/v3/media/uploads") { const n = ++k; return json(200, { code: 200, data: { download_url: `https://cdn.wavespeed.test/u${n}`, upload: { url: `https://put.wavespeed.test/u${n}`, method: "PUT" } } }); }
                if (method === "PUT" && u.hostname === "put.wavespeed.test") { stored.set(`https://cdn.wavespeed.test${u.pathname}`, tagOf(Buffer.from(init.body))); return new Response(null, { status: 200 }); }
                if (method === "POST" && u.hostname === "api.wavespeed.ai") {
                    body = JSON.parse(init.body);
                    route = u.pathname.replace(/^\/api\/v3\//, "");
                    return json(200, { code: 200, data: { id: "p9", status: "completed", urls: { get: "https://api.wavespeed.ai/api/v3/predictions/p9/result" }, outputs } });
                }
                if (u.hostname === "cdn.wavespeed.test" && files[String(url)]) return opts.gone && String(url).endsWith(opts.gone) ? new Response("gone", { status: 404 }) : png(files[String(url)]);
                return json(404, { code: 404, message: "no route " + u.pathname });
            };
            const ctx = { key: "test-ws", fetch, log() {}, sleep: async () => {} };
            const out = await wavespeed.layers(req, ctx);
            return { out, body, route, stored, ctx };
        };
        const a = await run(layerReq("wavespeed", { prompt: "  the dog  ", params: { count: 5, size: "auto" } }));
        check("one upload and one submit to the layer route, the picture as the uploaded URL", a.route === "bytedance/seedream-v5.5/layer-decomposition" && a.stored.get(a.body.image) === "PICTURE" && a.stored.size === 1, short([a.route, a.body.image]));
        check("the body: the picture, the prompt trimmed, Auto as 1k for a 0.96 MP picture, max_images the count and the base (6), png, nothing else", eq(a.body, { image: a.body.image, prompt: "the dog", resolution: "1k", max_images: 6, output_format: "png" }), short(a.body));
        check("the answer: the base first, then the two layers in order", eq(a.out.layers.map((l) => tagOf(l.bytes)), ["BASE", "L1", "L2"]) && a.out.layers[0].base === true && !a.out.layers[1].base && a.out.bytes.equals(a.out.layers[0].bytes), short(a.out.layers.map((l) => [tagOf(l.bytes), l.base])));
        check("a bare URL is a layer without a box: full, named by its place (Layer 1); the object's box and name are kept", a.out.layers[1].full === true && a.out.layers[1].bounding_box === null && a.out.layers[1].name === "Layer 1" && a.out.layers[2].full === false && eq(a.out.layers[2].bounding_box.absolute, [10, 20, 310, 420]) && a.out.layers[2].name === "dog", short(a.out.layers.slice(1).map((l) => ({ full: l.full, box: l.bounding_box, name: l.name }))));
        check("info says what was asked, and how many came without a position; the job is marked done", a.out.info.max_images === 6 && a.out.info.asked === 5 && a.out.info.unplaced === 1 && a.out.info.layers === 2 && a.ctx.jobDone === true && eq(a.out.missing, []), short(a.out.info));
        const t = await run(layerReq("wavespeed", { params: { size: "2K" } }));
        check("a 2K tier goes as 2k; no count: the default 16 layers, max_images 17; no prompt sent", t.body.resolution === "2k" && t.body.max_images === 17 && !("prompt" in t.body), short(t.body));
        const big = await run(layerReq("wavespeed", { image: pngOf(3000, 2000, "BIG"), width: 3000, height: 2000 }));
        check("Auto on a 6 MP picture asks 2k", big.body.resolution === "2k", big.body.resolution);
        const g = await run(layerReq("wavespeed"), { gone: "/l1.png" });
        check("a layer whose download fails is left out and named, the rest land", g.out.layers.length === 2 && eq(g.out.missing, ["Layer 1"]), short(g.out.missing));
        // (split-missing-name-collision) the bug: the left-out one and a landed one both called "Layer 1"
        const g3 = await run(layerReq("wavespeed"), { gone: "/l1.png", outputs: ["https://cdn.wavespeed.test/base.png", "https://cdn.wavespeed.test/l1.png", "https://cdn.wavespeed.test/l2.png"] });
        const plan3 = split.planLanding(g3.out.layers, { x: 0, y: 0, w: 1200, h: 800 }, 1024, 683, new Set());
        check("a left-out unnamed layer and the ones that land never share a name: Layer 1 missing, Layer 2 landed", eq(g3.out.missing, ["Layer 1"]) && eq(plan3.rows.map((r) => r.name), ["Base", "Layer 2"]), short([g3.out.missing, plan3.rows.map((r) => r.name)]));
        // (split-wavespeed-base-shift) the bug: an empty first slot dropped, so a layer becomes the base
        const e0 = await thrown(() => run(layerReq("wavespeed"), { outputs: ["", "https://cdn.wavespeed.test/l1.png", "https://cdn.wavespeed.test/l2.png"] }));
        check("an answer with an empty slot is refused, not shifted onto the base", !!e0 && /an answer without its pictures \(2 of 3\)/.test(e0), e0);
        // the source picture: ModelArk's 30 MB, an opaque one as JPEG
        const huge = pngOf(1200, 800, "HUGE", 30 * 1000 * 1000 + 1);
        const hj = await (async () => {
            const stored = [];
            const fetch = async (url, init = {}) => {
                const u = new URL(String(url)), method = String(init.method || "GET").toUpperCase();
                if (method === "POST" && u.pathname === "/api/v3/media/uploads") { stored.push(JSON.parse(init.body)); return json(200, { code: 200, data: { download_url: "https://cdn.wavespeed.test/u1", upload: { url: "https://put.wavespeed.test/u1", method: "PUT" } } }); }
                if (method === "PUT") return new Response(null, { status: 200 });
                if (method === "POST") return json(200, { code: 200, data: { id: "p1", status: "completed", urls: { get: "https://api.wavespeed.ai/api/v3/predictions/p1/result" }, outputs: ["https://cdn.wavespeed.test/base.png"] } });
                return png(pngOf(1024, 683, "BASE"));
            };
            await wavespeed.layers(layerReq("wavespeed", { image: huge }), { key: "test-ws", fetch, log() {}, sleep: async () => {}, opaque: async () => true, toJpeg: async () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1000)]) });
            return stored[0];
        })();
        check("a source over 30 MB goes as JPEG when it is opaque", hj && hj.content_type === "image/jpeg" && /\.jpg$/.test(hj.filename), short(hj));
        let hugeCalls = 0;
        const eh = await thrown(() => wavespeed.layers(layerReq("wavespeed", { image: huge }), { key: "test-ws", fetch: async () => { hugeCalls++; return json(500, {}); }, log() {}, sleep: async () => {}, opaque: async () => false, toJpeg: async () => null }));
        check("... and is refused before any call when it has transparency", !!eh && /more than the 30 MB/.test(eh) && hugeCalls === 0, eh);
        const eb = await thrown(() => run(layerReq("wavespeed"), { gone: "/base.png" }));
        check("a base that does not come fails the run and says the job is charged", !!eb && /finished and is charged, but its base picture/.test(eb), eb);
        const no = async (extra, re, what) => {
            let calls = 0;
            const err = await thrown(() => wavespeed.layers(layerReq("wavespeed", extra), { key: "test-ws", fetch: async () => { calls++; return json(500, {}); }, log() {}, sleep: async () => {} }));
            check(`${what} is refused before any call`, !!err && re.test(err) && calls === 0, err);
        };
        await no({ params: { text_recognition: true } }, /no Text recognition switch/, "Text recognition on WaveSpeed");
        await no({ params: { count: 100 } }, /1 to 99/, "a count of 100");
        await no({ params: { size: "4K" } }, /a tier/, "a size of 4K");
        await no({ references: [r1] }, /exactly one picture/, "a second picture");
        await no({ image: pngOf(400, 400, "SMALL") }, /512 × 512 to 6000 × 6000/, "a picture under 512 x 512");
        await no({ options: { ...V("wavespeed").options, layers: undefined } }, /has no layer mode/, "a variant without a layer mode");
    });

    await section("Split into layers on Oxen.ai", async () => {
        const v = V("oxen");
        const schema = JSON.parse(fs.readFileSync(path.join(REFS, "oxen", "bytedance-seedream-5-5-layers.json"), "utf8")).request_schema;
        check("the variant's layer mode: up to 99, the count and Text recognition, no size, its own model", v.options.layers.max === 99 && v.options.layers.options === true && v.options.layers.tiers === false && v.options.layers.model === "bytedance-seedream-5-5-layers" && schema.properties.max_layers.maximum === 99, short(v.options.layers));
        const b64 = (b) => b.toString("base64");
        const run = async (req, answer) => {
            const posts = [];
            const fetch = async (url, init = {}) => { posts.push({ url: String(url), body: JSON.parse(init.body), init }); return answer ? answer() : json(200, { model: "m", created: 1, images: [{ b64_json: b64(pngOf(1024, 683, "BASE")) }, { b64_json: b64(pngOf(1024, 683, "SKY")), name: "sky" }, { b64_json: b64(pngOf(300, 400, "DOG")), name: "dog", bounding_box: { x: 10, y: 20, width: 300, height: 400 }, z_index: 2 }] }); };
            const ctx = { key: "test-ox-0123456789", base: "http://127.0.0.1:5556", fetch, log() {}, sleep: async () => {} };
            const out = await oxen.layers(req, ctx);
            return { out, post: posts[0], posts, ctx };
        };
        const a = await run(layerReq("oxen", { prompt: " the dog ", params: { count: 8, text_recognition: true } }));
        const { model, response_format, ...rest } = a.post.body;
        const unknown = Object.keys(rest).filter((k) => !(k in schema.properties));
        check("one POST to /api/ai/images/generate (the route the model list names), the layer model", a.posts.length === 1 && a.post.url === "http://127.0.0.1:5556/api/ai/images/generate" && model === "bytedance-seedream-5-5-layers" && response_format === "b64_json", short([a.post.url, model]));
        check("the body: the picture as one data URL, the prompt, max_layers the count (the base not counted), Text recognition, png, no watermark, the hidden switch; every field in the schema", typeof rest.input_image === "string" && rest.input_image.startsWith("data:image/png;base64,") && rest.prompt === "the dog" && rest.max_layers === 8 && rest.text_recognition === true && rest.output_format === "png" && rest.watermark === false && rest.layer_decomposition === true && !unknown.length && !("size" in rest), short({ ...rest, input_image: String(rest.input_image).slice(0, 30), unknown }));
        check("a split's POST carries the run's undici limits (a long job outlasts 300 s)", !!a.post.init.dispatcher, "");
        check("the answer: the base, then the layers by z_index", eq(a.out.layers.map((l) => tagOf(l.bytes)), ["BASE", "SKY", "DOG"]) && a.out.layers[0].base === true, short(a.out.layers.map((l) => tagOf(l.bytes))));
        check("a box as x / y / width / height becomes [left, top, right, bottom]; a layer without one lands over the whole picture", eq(a.out.layers[2].bounding_box, { absolute: [10, 20, 310, 420] }) && a.out.layers[2].full === false && a.out.layers[1].full === true && a.out.layers[1].bounding_box === null && a.out.layers[1].name === "sky", short(a.out.layers.slice(1).map((l) => [l.bounding_box, l.full, l.name])));
        check("info and the job's state", a.out.info.asked === 8 && a.out.info.text_recognition === true && a.out.info.unplaced === 1 && a.ctx.jobDone === true, short(a.out.info));
        const d = await run(layerReq("oxen"));
        check("no count: 16 layers; Text recognition off is sent as off", d.post.body.max_layers === 16 && d.post.body.text_recognition === false, short(d.post.body.max_layers));
        const many = await run(layerReq("oxen", { params: { count: 40 } }), () => json(200, { images: [{ url: "data:image/png;base64," + b64(pngOf(1024, 683, "BASE")) }, { url: "data:image/png;base64," + b64(pngOf(1024, 683, "L1")) }] }));
        check("above 32 layers the answer is asked for as URLs, and URL entries are read", many.post.body.response_format === "url" && eq(many.out.layers.map((l) => tagOf(l.bytes)), ["BASE", "L1"]), short(many.post.body.response_format));
        const bad = await thrown(() => run(layerReq("oxen"), () => json(200, { images: [] })));
        check("an answer without pictures fails", !!bad && /without its pictures/.test(bad), bad);
        const refuse = async (extra, re, what) => {
            let calls = 0;
            const err = await thrown(() => oxen.layers(layerReq("oxen", extra), { key: "test-ox-0123456789", base: "http://127.0.0.1:5556", fetch: async () => { calls++; return json(500, {}); }, log() {}, sleep: async () => {} }));
            check(`${what} is refused before any call`, !!err && re.test(err) && calls === 0, err);
        };
        await refuse({ params: { size: "1K" } }, /takes no size for a split/, "a size tier on Oxen");
        await refuse({ params: { count: 0 } }, /1 to 99/, "a count of 0");
        await refuse({ image: pngOf(6400, 300, "STEEP") }, /no steeper than 16:1/, "a picture steeper than 16:1");
        // (split-test-z-vacuous) the order: layers out of z order, a base that is not first
        const zAnswer = (rows) => () => json(200, { images: rows.map(([tag, extra]) => ({ b64_json: b64(pngOf(1024, 683, tag)), ...extra })) });
        const z1 = await run(layerReq("oxen"), zAnswer([["SKY", { z_index: 3 }], ["BASE", { z_index: 0 }], ["DOG", { z_index: 1 }], ["CAT", { z_index: 2 }]]));
        check("every entry with a z_index: the only z 0 is the base wherever it stands, the rest bottom to top by z", eq(z1.out.layers.map((l) => tagOf(l.bytes)), ["BASE", "DOG", "CAT", "SKY"]) && z1.out.layers[0].base === true && eq(z1.out.layers.map((l) => l.z_index), [0, 1, 2, 3]), short(z1.out.layers.map((l) => [tagOf(l.bytes), l.z_index])));
        const z2 = await run(layerReq("oxen"), zAnswer([["TOP", { z_index: 5 }], ["BASE", { base: true }], ["MID", { z_index: 2 }]]));
        check("an entry marked base is the base, the others by z", eq(z2.out.layers.map((l) => tagOf(l.bytes)), ["BASE", "MID", "TOP"]) && z2.out.layers[0].base === true, short(z2.out.layers.map((l) => tagOf(l.bytes))));
        // (split-oxen-timeout-text) the words follow the split's own limit, not undici's 5 minutes
        const slow = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }); };
        const et = await thrown(() => oxen.layers(layerReq("oxen", { timeoutMs: 1800000 }), { key: "test-ox-0123456789", base: "http://127.0.0.1:5556", fetch: slow, log() {}, sleep: async () => {} }));
        check("a split that hears nothing says the split's own wait (1800 s + 30 s: 31 minutes)", !!et && /no answer within 31 minutes/.test(et), et);
    });

    await section("which host a split runs on (renderer/editor/splitlayers.js)", async () => {
        const pro = JSON.parse(fs.readFileSync(path.join(ROOT, "recipes", "seedream_5_pro.json"), "utf8"));
        // (split-on-chosen-provider) the bug: a split that reads providers.ark alone, whatever the user picked
        check("5.5 chosen on WaveSpeed: WaveSpeed; on Oxen: Oxen; on ModelArk: ModelArk", split.splitProviderOf(raw, "wavespeed") === "wavespeed" && split.splitProviderOf(raw, "oxen") === "oxen" && split.splitProviderOf(raw, "ark") === "ark", short(["wavespeed", "oxen", "ark"].map((p) => split.splitProviderOf(raw, p))));
        check("5.5 chosen on a host without a layer mode (Comfy Cloud, ToAPIs, Comfy Router): ModelArk", ["comfycloud", "toapis", "comfyrouter"].every((p) => split.splitProviderOf(raw, p) === "ark"), "");
        check("no choice: the recipe's default (ModelArk for 5.5; 5.0 pro's fal has none, so ModelArk)", split.splitProviderOf(raw) === "ark" && split.splitProviderOf(pro) === "ark" && split.splitProviderOf(pro, "wavespeed") === "ark", "");
        const noArk = { ...raw, providers: { wavespeed: raw.providers.wavespeed, comfycloud: raw.providers.comfycloud } };
        check("never a host without a layer mode: a recipe with neither the chosen one's nor ModelArk's has none", split.splitProviderOf(noArk, "comfycloud") === null && split.layerSpecOf(noArk, "comfycloud") === null && split.splitProviderOf(noArk, "wavespeed") === "wavespeed", "");
        const ws = split.layerSpecOf(raw, "wavespeed"), ox = split.layerSpecOf(raw, "oxen"), ak = split.layerSpecOf(raw, "ark");
        check("each host's spec: WaveSpeed a count without Text recognition, Oxen both without tiers, ModelArk both with tiers", ws.provider === "wavespeed" && ws.count && !ws.text && ws.tiers && ox.provider === "oxen" && ox.count && ox.text && !ox.tiers && ak.provider === "ark" && ak.count && ak.text && ak.tiers, short([ws, ox, ak]));
        check("the list follows each recipe's chosen host", eq(split.layerRecipes([pro, raw], (r) => (r.id === "seedream_5_5" ? "comfycloud" : undefined)).map((r) => r.id), ["seedream_5_5", "seedream_5_pro"]), "");
        // the job and its request, on a shell that resolves the recipe as shell.js does
        const shellFor = (pick) => ({
            recipes: () => [raw, pro],
            resolveRecipe: (r, pid = (pick[r.id] && r.providers[pick[r.id]] ? pick[r.id] : r.default)) => {
                const vv = r.providers[pid];
                return { ...r, provider: pid, providerLabel: { ark: "BytePlus ModelArk (Seedream)", wavespeed: "WaveSpeedAI", oxen: "Oxen.ai", comfycloud: "Comfy Cloud", fal: "fal.ai" }[pid] || pid, model: vv.model, options: vv.options || null, settings: vv.settings || [] };
            },
            keyState: () => ({ ok: true }),
        });
        const editor = { base: true, width: 1200, height: 800, providerPending: null, node: { id: "d1" }, setStatus(t) { this.status = t; (this.said = this.said || []).push(t); }, flattenToCanvas: () => ({}), geometrySeq: 0 };
        const appFor = (pick) => ({ shell: shellFor(pick), recipe: null, editors: () => [editor], _providerRuns: new Set(), notifyProviderRuns() {}, endRun() {}, endRunRow() {} });
        const jw = split.splitJob(appFor({ seedream_5_5: "wavespeed" }), editor, { recipe: "seedream_5_5", count: 5 });
        const jc = split.splitJob(appFor({ seedream_5_5: "comfycloud" }), editor, { recipe: "seedream_5_5", count: 5 });
        check("the job on 5.5 chosen on WaveSpeed runs on WaveSpeed; chosen on Comfy Cloud, on ModelArk", jw.r.provider === "wavespeed" && jw.spec.provider === "wavespeed" && jc.r.provider === "ark", short([jw.r.provider, jc.r.provider]));
        const tr = (() => { try { split.splitJob(appFor({ seedream_5_5: "wavespeed" }), editor, { recipe: "seedream_5_5", textRecognition: true }); return null; } catch (e) { return String(e.message); } })();
        const sz = (() => { try { split.splitJob(appFor({ seedream_5_5: "oxen" }), editor, { recipe: "seedream_5_5", size: "2K" }); return null; } catch (e) { return String(e.message); } })();
        check("the job refuses Text recognition on WaveSpeed and a tier on Oxen, naming the host", !!tr && /on WaveSpeedAI has no Text recognition switch/.test(tr) && !!sz && /on Oxen\.ai takes no size/.test(sz), short([tr, sz]));
        let sent = null;
        const deps = { providerEdit: async (request, token) => { sent = { request, token }; throw new Error("stop here"); }, canvasBytes: async () => pngOf(1200, 800, "PICTURE"), bytesToImage: async () => null, viaLine: () => "", runIdOf: () => "r1" };
        await thrown(() => split.runSplitLayers(appFor({ seedream_5_5: "wavespeed" }), editor, { recipe: "seedream_5_5", count: 5 }, deps));
        check("the request and the run's row go to WaveSpeed with its variant's options, kind layers", !!sent && sent.request.provider === "wavespeed" && sent.token.provider === "wavespeed" && sent.request.kind === "layers" && sent.request.options.layers.model === "bytedance/seedream-v5.5/layer-decomposition" && sent.request.params.count === 5, short(sent && { provider: sent.request.provider, token: sent.token.provider }));
        check("the status line names the host it is sent to", (editor.said || []).some((t) => /^Split into layers: sending the picture \(1200 × 800\) to Seedream 5\.5 on WaveSpeedAI, up to 5 layers/.test(t)), short(editor.said));
        // where boxless layers land
        const rect = { x: 50, y: 40, w: 2000, h: 1000 };
        const plan = split.planLanding([{ base: true, name: "" }, { full: true, name: "" }, { name: "dog", bounding_box: { absolute: [100, 50, 300, 250] } }], rect, 1000, 500, new Set());
        // (split-full-stretch) the bug: a boxless layer of another shape stretched over the whole picture
        const R0 = { x: 100, y: 50, w: 3000, h: 2000 };
        const same = split.fitFull(2048, 1365, 2048, 1365, R0), near = split.fitFull(1024, 683, 2048, 1365, R0);
        const tall = split.fitFull(1400, 2048, 2048, 1365, R0), wide = split.fitFull(2048, 700, 2048, 1365, R0);
        check("a boxless layer of the base's shape (to the pixel) covers the source", !same.fitted && !near.fitted && eq(same.box, { x: 100, y: 50, w: 3000, h: 2000 }) && eq(near.box, same.box), short([same, near]));
        check("one of another shape keeps it: fitted inside the source, centred, never stretched (1400 x 2048 -> 1367 x 2000; 2048 x 700 -> 3000 x 1025)",
            tall.fitted && eq(tall.box, { x: 100 + Math.round((3000 - 1367) / 2), y: 50, w: 1367, h: 2000 }) && wide.fitted && eq(wide.box, { x: 100, y: 50 + Math.round((2000 - 1025) / 2), w: 3000, h: 1025 })
            && Math.abs(tall.box.w / tall.box.h - 1400 / 2048) < 0.002 && Math.abs(wide.box.w / wide.box.h - 2048 / 700) < 0.003, short([tall, wide]));
        check("a layer without a position covers the source like the base, is named by its place and listed in `whole`; a boxed one lands from its box", eq([plan.rows[1].x, plan.rows[1].y, plan.rows[1].w, plan.rows[1].h], [50, 40, 2000, 1000]) && plan.rows[1].name === "Layer 1" && eq(plan.whole, ["Layer 1"]) && eq([plan.rows[2].x, plan.rows[2].y, plan.rows[2].w, plan.rows[2].h], [250, 140, 400, 400]) && !plan.leftOut.length, short(plan));
    });

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + (err && err.stack || err)); console.log("FAIL"); process.exit(1); });
