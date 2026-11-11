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
const wavespeed = P("wavespeed"), cloud = P("comfycloud");
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
        check("ten pictures in all", cloud.layout(editReq("comfycloud")).max === 10, String(cloud.layout(editReq("comfycloud")).max));
    });

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + (err && err.stack || err)); console.log("FAIL"); process.exit(1); });
