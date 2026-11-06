// GPT Image 2.6 Sunburst and Flare (recipes/gpt_image_2_6_{flare,sunburst}.json) on every host that lists them, and the
// GPT Image 2.5 fixes of the same day (fal and Replicate as new variants, WaveSpeed's mask_image), in plain Node, no
// Electron, no key and no network:
//   node tools/gpt26_test.js
// The light tier (CLAUDE.md "Working rules"): written from the hosts' docs and schemas, read 2026-11-06 and saved under
// tools/refs/ (fal, wavespeed, replicate, openrouter, toapis, openai), never run against the live API. A scripted fetch
// plays each host: it records the request a run sends and answers with a picture. Every body is held to the host's
// saved schema (ToAPIs to its page's parameter list); the sizes at 3840 x 2160, at odd, about 1:4 and small crops, the
// Complexity row (passed where the host takes it, under its own name, absent elsewhere), the mask where the host takes
// one, WaveSpeed's crop widened to one of its presets (stitch.js planCrop), and no GIF or SVG output anywhere.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
/** recipes.js as the app loads it (its normalize fills each variant's limits), with Electron's `app` stood in. */
function recipesModule() {
    const Module = require("node:module");
    const orig = Module._load;
    Module._load = function (request, ...rest) {
        if (request === "electron") return { app: { getPath: () => path.join(require("node:os").tmpdir(), "scumble-gpt26-test") } };
        return orig.call(this, request, ...rest);
    };
    try { return require(path.join(ROOT, "electron", "main", "recipes.js")); } finally { Module._load = orig; }
}
const P = (id) => require(path.join(ROOT, "electron", "main", "providers", id + ".js"));
const openai = P("openai"), fal = P("fal"), replicate = P("replicate"), wavespeed = P("wavespeed"), openrouter = P("openrouter"), toapis = P("toapis");
const REFS = path.join(ROOT, "tools", "refs");

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 500 ? s.slice(0, 500) + " ..." : s; };
async function section(name, fn) {
    console.log(`\n--- ${name} ---`);
    try { await fn(); } catch (err) { check(`${name}: ran through`, false, String(err && err.stack || err).split(/\r?\n/).slice(0, 3).join(" ")); }
}
async function thrown(fn) { try { await fn(); return null; } catch (err) { return String(err && err.message || err); } }

const recipe = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, "recipes", id + ".json"), "utf8"));
const R = {
    f25: recipe("gpt_image_2_5_flare"), s25: recipe("gpt_image_2_5_sunburst"),
    f26: recipe("gpt_image_2_6_flare"), s26: recipe("gpt_image_2_6_sunburst"),
};
const ref = (rel) => JSON.parse(fs.readFileSync(path.join(REFS, rel), "utf8"));

/** A PNG header of w x h (the IHDR is all the adapters read) with a tag to find the picture by. */
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
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const png = () => new Response(RESULT, { status: 200, headers: { "content-type": "image/png" } });

/** The params the editor sends: each row at its default, then the variant's (or the text shape's) fixed values, then `over`. */
function paramsOf(v, over = {}, text = false) {
    const p = {};
    for (const s of v.settings || []) p[s.key] = s.spec[1].default;
    Object.assign(p, v.fixed || {});
    if (text && v.text && v.text.fixed) Object.assign(p, v.text.fixed);
    return { ...p, ...over };
}
function editReq(pid, v, extra = {}) {
    const w = extra.width || 3840, h = extra.height || 2160;
    return {
        provider: pid, model: v.model, kind: v.input === "edit" ? "edit" : "fill", options: v.options || null, fields: v.fields || null,
        prompt: "make the door red", negative: "blurry", seed: 42, refName: "Image {n}",
        image: pngOf(w, h, "CROP"), mask: pngOf(w, h, "MASK"), maskAlpha: pngOf(w, h, "MASKALPHA"),
        width: w, height: h, references: [], original: 0, params: paramsOf(v), ...extra,
    };
}
function textReq(pid, v, extra = {}) {
    const t = v.text || {};
    const refs = extra.references || [];
    const model = refs.length && t.refs && t.refs.model ? t.refs.model : (t.model || (pid === "fal" || pid === "wavespeed" ? v.model.replace(/\/edit$/, "") : v.model));
    return {
        provider: pid, model, kind: "text", options: v.options || null, fields: v.fields || null,
        prompt: "a lighthouse at dusk", negative: "blurry", seed: 7, refName: "Image {n}",
        image: null, mask: null, maskAlpha: null, references: [], original: 0,
        width: 3840, height: 2160, aspect: "16:9", params: paramsOf(v, {}, true), ...extra,
    };
}

/** What `body` breaks of a JSON schema's top level: unknown keys (where it is strict, or always with `strict`), missing required keys, enum values, maxItems. */
function againstSchema(body, schema, { strict = true, skip = [] } = {}) {
    const bad = [];
    const props = schema.properties || {};
    for (const k of Object.keys(body)) {
        if (skip.includes(k)) continue;
        if (!(k in props)) { if (strict || schema.additionalProperties === false) bad.push(`${k}: not in the schema`); continue; }
        const p = props[k];
        if (Array.isArray(p.enum) && !p.enum.includes(body[k])) bad.push(`${k}: ${short(body[k])} not in ${short(p.enum)}`);
        if (p.type === "array" && p.maxItems != null && Array.isArray(body[k]) && body[k].length > p.maxItems) bad.push(`${k}: ${body[k].length} > ${p.maxItems}`);
    }
    for (const k of schema.required || []) if (!(k in body)) bad.push(`${k}: required, missing`);
    return bad;
}

/** A size inside GPT Image 2.5 / 2.6's rules: multiples of 16, at most 3840 an edge, 655,360 to 8,294,400 pixels, no steeper than 3:1. */
function sizeBad(w, h) {
    const bad = [];
    if (w % 16 || h % 16) bad.push("not multiples of 16");
    if (Math.max(w, h) > 3840) bad.push("over 3840");
    if (w * h < 655360) bad.push("under 655,360 px");
    if (w * h > 8294400) bad.push("over 8,294,400 px");
    if (Math.max(w, h) / Math.min(w, h) > 3) bad.push("steeper than 3:1");
    return bad;
}
const sizeOf = (s) => String(s).split("x").map(Number);

// ---- the hosts as their adapters meet them ----

/** api.openai.com: /v1/images/edits (multipart) and /generations (JSON); the request as { url, fields, files } or { url, body }. */
async function runOpenAI(req, verb = "edit") {
    const calls = [];
    const fetch = async (url, init = {}) => {
        if (init.body instanceof FormData) {
            const fields = {}, files = {};
            for (const [k, v] of init.body.entries()) {
                if (typeof v === "string") fields[k] = v;
                else (files[k] || (files[k] = [])).push(tagOf(Buffer.from(await v.arrayBuffer())));
            }
            calls.push({ url: String(url), fields, files });
        } else calls.push({ url: String(url), body: JSON.parse(init.body) });
        return json(200, { data: [{ b64_json: RESULT.toString("base64") }] });
    };
    const out = await openai[verb](req, { key: "sk-test", fetch, log() {} });
    return { out, call: calls[0], calls };
}

/** queue.fal.run: the submit, one status poll, the result, the CDN download. */
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
        if (u.hostname === "queue.fal.run") return json(200, { images: [{ url: "https://v3.fal.media/files/r1.png", content_type: "image/png", width: 1024, height: 1024 }] });
        if (u.hostname === "v3.fal.media") return png();
        return json(404, { detail: "no route " + u.pathname });
    };
    const out = await fal.edit(req, { key: "test-fal", fetch, log() {}, sleep: async () => {} });
    return { out, body, route };
}

/** api.replicate.com: a model prediction that succeeds at once, then the download. */
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

/** api.wavespeed.ai: an upload ticket and a presigned PUT per picture, the submit (done at once), the CDN download. */
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

/** The OpenRouter loopback mock (a test key goes nowhere else): the providers list and one image answer. */
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
    openrouter._resetHosts && openrouter._resetHosts();
    const out = await openrouter[verb](req, { key: "test-or-0123456789abcdef", base: "http://127.0.0.1:5555", fetch, log() {}, sleep: async () => {} });
    return { out, body: bodies[0] };
}

/** toapis.com: the uploads, the submit, one poll, the download. */
async function runToapis(req, verb = "edit") {
    const uploads = [], submits = [];
    let n = 0;
    const fetch = async (url, init = {}) => {
        const u = new URL(String(url)), method = String(init.method || "GET").toUpperCase();
        if (u.hostname === "files.toapis.com") return png();
        if (u.pathname === "/v1/uploads/images" && method === "POST") {
            const file = init.body.get("file");
            const i = ++n, at = `https://files.toapis.com/uploads/1/${i}_${file.name}`;
            uploads.push({ tag: tagOf(Buffer.from(await file.arrayBuffer())), url: at });
            return json(200, { success: true, data: { id: "u" + i, url: at } });
        }
        if (u.pathname === "/v1/images/generations" && method === "POST") { submits.push(JSON.parse(init.body)); return json(200, { id: "tsk1", status: "queued" }); }
        if (u.pathname.startsWith("/v1/images/generations/")) return json(200, { id: "tsk1", status: "completed", result: { data: [{ url: "https://files.toapis.com/generated/out.png" }] } });
        return json(404, { error: { message: "no route " + u.pathname } });
    };
    const out = await toapis[verb](req, { key: "sk-test-0123456789abcdef", fetch, log() {}, sleep: async () => {}, random: () => 0.5 });
    const tagOfUrl = (x) => (uploads.find((up) => up.url === x) || {}).tag;
    return { out, body: submits[0], tagOfUrl };
}

(async () => {
    await section("1. the recipes", async () => {
        for (const [r, tier] of [[R.f26, "flare"], [R.s26, "sunburst"]]) {
            const T = tier[0].toUpperCase() + tier.slice(1);
            check(`${r.id}: GPT Image 2.6 ${T}, family OpenAI, refs Image {n}, home openai`, r.id === `gpt_image_2_6_${tier}` && r.kind === "provider" && r.name === `GPT Image 2.6 ${T}` && r.family === "OpenAI" && eq(r.refs, { name: "Image {n}" }) && r.default === "openai");
            const want = tier === "flare" ? ["openai", "fal", "replicate", "wavespeed", "openrouter"] : ["toapis", "openai", "fal", "replicate", "wavespeed", "openrouter"];
            check(`${r.id}: the hosts that list it, in the 2.5 order (ToAPIs first where it serves the model; no Comfy Cloud, Comfy Router, Oxen or Magnific yet)`, eq(Object.keys(r.providers), want), Object.keys(r.providers).join(", "));
            const ids = { openai: `gpt-image-2.6-${tier}`, fal: `openai/gpt-image-2.6/${tier}/edit`, replicate: `openai/gpt-image-2.6-${tier}`, wavespeed: `openai/gpt-image-2.6-${tier}/edit`, openrouter: `openai/gpt-image-2.6-${tier}`, toapis: `gpt-image-2.6-${tier}-official` };
            const wrong = Object.entries(r.providers).filter(([pid, v]) => v.model !== ids[pid]).map(([pid, v]) => `${pid} ${v.model}`);
            check(`${r.id}: each host's own model id`, !wrong.length, wrong.join(", "));
            // the Complexity row: low / medium / high, default high, under the host's name for it
            const bad = [];
            for (const [pid, v] of Object.entries(r.providers)) {
                const key = pid === "fal" ? "reasoning_effort" : "complexity";
                const rows = (v.settings || []).filter((s) => s.label === "Complexity");
                if (rows.length !== 1 || rows[0].key !== key || !eq(rows[0].spec[0], ["low", "medium", "high"]) || rows[0].spec[1].default !== "high") bad.push(`${pid}: ${short(rows)}`);
                if (!/low is faster/.test(v.note || "")) bad.push(`${pid}: the note does not say what low does`);
                if (!/not run against the live API|this model not yet/i.test(v.note || "")) bad.push(`${pid}: the note does not say it has not run live`);
                const idx = (v.settings || []).map((s) => s.index);
                if (new Set(idx).size !== idx.length) bad.push(`${pid}: two rows on one slot ${idx}`);
            }
            check(`${r.id}: a Complexity row on every host (low / medium / high, default high; fal's reasoning_effort), the note on low, no live run claimed`, !bad.length, bad.join(" | "));
            const fmt = Object.entries(r.providers).flatMap(([pid, v]) => (v.settings || []).filter((s) => s.key === "output_format").map((s) => [pid, s.spec[0]]));
            check(`${r.id}: no GIF or SVG output offered (a File format row keeps png / webp / jpeg)`, fmt.every(([, list]) => !list.some((x) => /gif|svg/i.test(x))) && !JSON.stringify(r).match(/"(gif|svg)"/), short(fmt));
            check(`${r.id}: the OpenAI note marks the mask unverified until a live run`, /not verified until a live run/.test(r.providers.openai.note));
            // the crop the stitch plans for the hosts that take a free size: 2.5's rules, and ratio 3 so a thin selection
            // gets more context instead of an answer of another shape
            const rules = { max: 3840, step: 16, pixels: 8294400, minPixels: 655360, ratio: 3 };
            const offRules = ["openai", "fal", "toapis"].filter((pid) => r.providers[pid] && !eq(r.providers[pid].limits, rules)).map((pid) => `${pid} ${short(r.providers[pid].limits)}`);
            check(`${r.id}: the OpenAI, fal and ToAPIs variants plan the crop by the size rules (3840, 16 px, 655,360 to 8,294,400 px, ratio 3)`, !offRules.length, offRules.join(" | "));
        }
        check("Flare has no ToAPIs variant: ToAPIs' price list marks gpt-image-2.6-flare-official disabled (saved 2026-11-06)", !R.f26.providers.toapis && /disabled/.test(ref("toapis/gpt-image-2.6-official.json").pricing.find((x) => x.model_name === "gpt-image-2.6-flare-official").description));
        for (const r of [R.f25, R.s25]) {
            const ids = Object.keys(r.providers);
            check(`${r.id}: fal and Replicate after openai, the other hosts kept`, eq(ids, ["toapis", "openai", "fal", "replicate", "wavespeed", "comfycloud", "openrouter", "comfyrouter", "oxen", "magnific"]), ids.join(", "));
            const keys = Object.values(r.providers).flatMap((v) => (v.settings || []).map((s) => s.key));
            check(`${r.id}: no Complexity row (2.5 has no such field)`, !keys.includes("complexity") && !keys.includes("reasoning_effort"));
            const ws = r.providers.wavespeed;
            check(`${r.id}: WaveSpeed is a fill with mask_image beside the image list, its note no longer says "no mask input"`, ws.input === "fill" && eq(ws.fields, { images: "images", mask: "mask_image" }) && !/no mask input/.test(ws.note) && /mask_image/.test(ws.note));
            check(`${r.id}: the description names fal.ai and Replicate`, /Also on fal\.ai\. Also on Replicate\./.test(r.description));
        }
    });

    await section("2. the size rule: GPT Image 2.6 takes 2.5's (openai.js sizeRules)", async () => {
        const cases = [[3840, 2160], [1000, 333], [320, 240], [4000, 500], [8000, 6000], [1500, 1000]];
        const bad = [];
        for (const [w, h] of cases) {
            const s26 = openai._sizeFor("gpt-image-2.6-flare", w, h), s25 = openai._sizeFor("gpt-image-2.5-flare", w, h), ss = openai._sizeFor("gpt-image-2.6-sunburst", w, h);
            const [sw, sh] = sizeOf(s26);
            if (s26 !== s25 || ss !== s25) bad.push(`${w}x${h}: 2.6 ${s26} / ${ss}, 2.5 ${s25}`);
            if (sizeBad(sw, sh).length) bad.push(`${w}x${h} -> ${s26}: ${sizeBad(sw, sh).join(", ")}`);
        }
        check("every crop gets the same size as on 2.5, inside the rules (16 px steps, 3840 an edge, 655,360 to 8,294,400 px, 3:1)", !bad.length, bad.join(" | "));
        check("3840 x 2160 goes as it is (not 2048 x 1152, GPT Image 2's edge)", openai._sizeFor("gpt-image-2.6-flare", 3840, 2160) === "3840x2160", openai._sizeFor("gpt-image-2.6-flare", 3840, 2160));
        check("GPT Image 2 keeps its 2048 edge", openai._sizeFor("gpt-image-2", 3840, 2160) === "2048x1152", openai._sizeFor("gpt-image-2", 3840, 2160));
        check("Comfy Router's id (openai/gpt-image-2.6-*) takes the same rule through openai._sizeFor", openai._sizeFor("openai/gpt-image-2.6-sunburst", 3840, 2160) === "3840x2160");
    });

    await section("3. OpenAI direct", async () => {
        const c = (p, m) => openai._common(p, m);
        check("common(): complexity goes on 2.6", c({ complexity: "low" }, "gpt-image-2.6-flare").complexity === "low" && c({ complexity: "HIGH" }, "gpt-image-2.6-sunburst").complexity === "high");
        check("common(): never on 2.5, 2 or 1.5, nor on a Router 2.5 id", !("complexity" in c({ complexity: "low" }, "gpt-image-2.5-flare")) && !("complexity" in c({ complexity: "low" }, "gpt-image-2")) && !("complexity" in c({ complexity: "low" }, "gpt-image-1.5")) && !("complexity" in c({ complexity: "low" }, "openai/gpt-image-2.5-flare")));
        check("common(): a value outside low / medium / high, or none, sends none", !("complexity" in c({ complexity: "extreme" }, "gpt-image-2.6-flare")) && !("complexity" in c({}, "gpt-image-2.6-flare")));
        check("common(): GIF and SVG become PNG (a layer is a raster picture)", c({ output_format: "gif" }, "gpt-image-2.6-flare").output_format === "png" && c({ output_format: "svg" }, "gpt-image-2.6-flare").output_format === "png");
        const schema = ref("openai/images_gpt-image-2.6.json");
        check("the saved spec: both ids on /edits and /generations, complexity low / medium / high, the mask generic", ["edits", "generations"].every((k) => schema[k].properties.model.anyOf[1].enum.includes("gpt-image-2.6-flare") && schema[k].properties.model.anyOf[1].enum.includes("gpt-image-2.6-sunburst") && "complexity" in schema[k].properties) && eq(schema.complexity.enum.filter(Boolean), ["low", "medium", "high"]) && /transparent areas/.test(schema.edits.properties.mask.description));
        check("the saved spec: /edits takes at most 16 images, the cap both 2.6 variants declare", schema.edits.properties.image.anyOf[1].maxItems === 16 && R.f26.providers.openai.options.max_images === 16 && R.s26.providers.openai.options.max_images === 16);
        for (const r of [R.f26, R.s26]) {
            const v = r.providers.openai;
            const a = await runOpenAI(editReq("openai", v, { references: [pngOf(1024, 1024, "REF1")] }));
            const f = a.call.fields, files = a.call.files;
            check(`${r.id} edit 3840 x 2160: /v1/images/edits, size 3840x2160, complexity high (the row's default), crop and reference in image[], the alpha mask`, a.call.url === "https://api.openai.com/v1/images/edits" && f.model === v.model && f.size === "3840x2160" && f.complexity === "high" && eq(files["image[]"], ["CROP", "REF1"]) && eq(files.mask, ["MASKALPHA"]) && f.output_format === "png" && !("input_fidelity" in f), short({ f, files }));
            const odd = await runOpenAI(editReq("openai", v, { width: 1000, height: 333, params: paramsOf(v, { complexity: "low" }) }));
            const [ow, oh] = sizeOf(odd.call.fields.size);
            check(`${r.id} edit at an odd crop (1000 x 333): a size inside the rules, complexity low`, !sizeBad(ow, oh).length && odd.call.fields.complexity === "low", odd.call.fields.size);
            const t = await runOpenAI(textReq("openai", v, { width: 1024, height: 576 }), "generate");
            const [tw, th] = sizeOf(t.call.body.size);
            check(`${r.id} new image (16:9 at 1024): /generations, the asked size grown over the pixel floor, complexity high`, t.call.url === "https://api.openai.com/v1/images/generations" && !sizeBad(tw, th).length && t.call.body.complexity === "high" && t.call.body.model === v.model, short(t.call.body));
        }
        const a25 = await runOpenAI(editReq("openai", R.f25.providers.openai, { params: { ...paramsOf(R.f25.providers.openai), complexity: "low" } }));
        check("2.5 Flare: no complexity even when one is handed in", !("complexity" in a25.call.fields) && a25.call.fields.size === "3840x2160", short(a25.call.fields));
    });

    await section("4. fal", async () => {
        for (const r of [R.f25, R.s25, R.f26, R.s26]) {
            const v = r.providers.fal, ver = r.id.includes("2_6") ? "2.6" : "2.5", tier = r.id.endsWith("flare") ? "flare" : "sunburst";
            const editSchema = Object.values(ref(`fal/openai_gpt-image-${ver}_${tier}_edit.json`).components.schemas).find((s) => s.properties && s.properties.image_urls);
            const textSchema = Object.values(ref(`fal/openai_gpt-image-${ver}_${tier}_text-to-image.json`).components.schemas).find((s) => s.properties && s.properties.prompt && !s.properties.image_urls);
            const e = await runFal(editReq("fal", v, { references: [pngOf(1024, 1024, "REF1")] }));
            const b = e.body;
            const imgs = (b.image_urls || []).map((u) => tagOf(fromDataUri(u)));
            check(`${r.id} edit 3840 x 2160: the edit route, crop and reference in image_urls, the mask in mask_url, image_size 3840 x 2160, no seed or negative prompt`, e.route === `openai/gpt-image-${ver}/${tier}/edit` && eq(imgs, ["CROP", "REF1"]) && tagOf(fromDataUri(b.mask_url)) === "MASK" && eq(b.image_size, { width: 3840, height: 2160 }) && !("seed" in b) && !("negative_prompt" in b) && b.output_format === "png", short({ route: e.route, keys: Object.keys(b), image_size: b.image_size }));
            check(`${r.id} edit: the body inside fal's saved schema`, !againstSchema(b, editSchema).length, againstSchema(b, editSchema).join(" | "));
            if (ver === "2.6") check(`${r.id} edit: Complexity goes as reasoning_effort (high), never as complexity`, b.reasoning_effort === "high" && !("complexity" in b), short(b.reasoning_effort));
            else check(`${r.id} edit: no reasoning_effort on 2.5 (its schema has none)`, !("reasoning_effort" in b) && !("reasoning_effort" in editSchema.properties));
            const odd = await runFal(editReq("fal", v, { width: 1000, height: 333 }));
            const os = odd.body.image_size;
            check(`${r.id} edit at an odd crop (1000 x 333): image_size inside the rules`, os && !sizeBad(os.width, os.height).length, short(os));
            for (const [w, h] of [[544, 2160], [512, 512]]) {
                const s = (await runFal(editReq("fal", v, { width: w, height: h }))).body.image_size;
                check(`${r.id} edit at a ${w} x ${h} crop (${w < h ? "about 1:4" : "under the pixel floor"}): image_size inside the rules`, s && !sizeBad(s.width, s.height).length, short(s) + " " + (s ? sizeBad(s.width, s.height).join(", ") : ""));
            }
            const t = await runFal(textReq("fal", v, { width: 1024, height: 576 }));
            const ts = t.body.image_size;
            check(`${r.id} new image (16:9 at 1024): the text-to-image route, image_size grown over the floor, no aspect_ratio, no pictures`, t.route === `openai/gpt-image-${ver}/${tier}/text-to-image` && ts && !sizeBad(ts.width, ts.height).length && Math.abs(ts.width / ts.height - 16 / 9) < 0.05 && !("aspect_ratio" in t.body) && !("image_urls" in t.body), short({ route: t.route, body: t.body }));
            check(`${r.id} new image: the body inside fal's saved text schema (no svg_model, no GIF frames)`, !againstSchema(t.body, textSchema).length && !("svg_model" in t.body) && !("frame_count" in t.body), againstSchema(t.body, textSchema).join(" | "));
            const tr = await runFal(textReq("fal", v, { references: [pngOf(1024, 1024, "REF1"), pngOf(1024, 1024, "REF2")] }));
            check(`${r.id} new image with two reference layers: the edit route, the references alone, no mask`, tr.route === `openai/gpt-image-${ver}/${tier}/edit` && eq(tr.body.image_urls.map((u) => tagOf(fromDataUri(u))), ["REF1", "REF2"]) && !("mask_url" in tr.body) && eq(tr.body.image_size, { width: 3840, height: 2160 }), short({ route: tr.route, size: tr.body.image_size }));
            check(`${r.id}: the seed fal never takes is not reported`, e.out.seed == null, String(e.out.seed));
        }
    });

    await section("5. Replicate", async () => {
        for (const r of [R.f25, R.s25, R.f26, R.s26]) {
            const v = r.providers.replicate, ver = r.id.includes("2_6") ? "2.6" : "2.5", tier = r.id.endsWith("flare") ? "flare" : "sunburst";
            const schema = ref(`replicate/openai_gpt-image-${ver}-${tier}.json`).components.schemas.Input;
            const e = await runReplicate(editReq("replicate", v, { references: [pngOf(1024, 1024, "REF1")] }));
            const inp = e.body.input;
            check(`${r.id} edit: the official model's predictions, crop and reference in input_images, aspect_ratio auto, PNG, no mask, no seed`, e.url === `https://api.replicate.com/v1/models/openai/gpt-image-${ver}-${tier}/predictions` && eq(inp.input_images.map((u) => tagOf(fromDataUri(u))), ["CROP", "REF1"]) && inp.aspect_ratio === "auto" && inp.output_format === "png" && !("mask" in inp) && !("seed" in inp), short(inp && Object.keys(inp)));
            check(`${r.id} edit: the input inside Replicate's saved schema`, !againstSchema(inp, schema).length, againstSchema(inp, schema).join(" | "));
            if (ver === "2.6") check(`${r.id} edit: complexity high`, inp.complexity === "high");
            else check(`${r.id} edit: no complexity (2.5's schema has none)`, !("complexity" in inp) && !("complexity" in schema.properties));
            const t = await runReplicate(textReq("replicate", v));
            check(`${r.id} new image 16:9: the asked aspect, no pictures, no negative prompt`, t.body.input.aspect_ratio === "16:9" && !("input_images" in t.body.input) && !("negative_prompt" in t.body.input) && !againstSchema(t.body.input, schema).length, short(t.body.input));
            const free = await runReplicate(textReq("replicate", v, { aspect: null, width: 3840, height: 1280 }));
            check(`${r.id} new image at a free 3:1 size: the closest of Replicate's seven ratios (16:9)`, free.body.input.aspect_ratio === "16:9", free.body.input.aspect_ratio);
            check(`${r.id}: the output formats offered stay png (Replicate's 2.6 also has gif and svg)`, (v.fixed || {}).output_format === "png" && ((v.text && v.text.fixed) || {}).output_format === "png");
            check(`${r.id}: no seed reported (the model takes none)`, e.out.seed === undefined, String(e.out.seed));
        }
    });

    await section("6. WaveSpeed", async () => {
        const S = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "stitch.js")).href);
        const recipes = recipesModule();
        for (const r of [R.f25, R.s25, R.f26, R.s26]) {
            const v = r.providers.wavespeed, ver = r.id.includes("2_6") ? "2.6" : "2.5", tier = r.id.endsWith("flare") ? "flare" : "sunburst";
            const editSchema = ref(`wavespeed/openai_gpt-image-${ver}-${tier}_edit.json`).components.schemas.Input;
            const textSchema = ref(`wavespeed/openai_gpt-image-${ver}-${tier}_text-to-image.json`).components.schemas.Input;
            check(`${r.id}: the saved schemas are strict and the edit takes mask_image`, editSchema.additionalProperties === false && textSchema.additionalProperties === false && "mask_image" in editSchema.properties && editSchema.properties.images.maxItems === 16);
            // a masked edit sends no preset and WaveSpeed picks the shape from the input image: the crop is widened to one
            // of WaveSpeed's 15 presets first (limits.aspects), so a pick among them cannot differ from the crop
            const lim = recipes._normalize(JSON.parse(JSON.stringify(r))).providers.wavespeed.limits;
            const presets = editSchema.properties.aspect_ratio.enum;
            check(`${r.id}: limits.aspects are WaveSpeed's 15 presets (the edit schema's aspect_ratio enum, the variant's aspect_ratios), the recipe's 2048 edge and pixel budget kept`, eq([...lim.aspects].sort(), [...presets].sort()) && eq(v.options.aspect_ratios, presets) && presets.length === 15 && lim.max === r.limits.max && lim.pixels === r.limits.pixels, short(lim));
            check(`${r.id}: the note says WaveSpeed's pick of the shape is not verified`, /not verified that it keeps the exact ratio/.test(v.note) && /widened to the nearest of WaveSpeed's 15 presets/.test(v.note));
            const W = 4000, H = 3000;
            const planOf = (b, l) => S.planCrop({ width: W, height: H, gen: { mode: "api", denoise: 1 }, crop: { context: "auto", feather: "auto", fill: "none", paste: "selection" }, params: { padding: 0, target_size: 0, feather: 0, multiple_of: 16 }, limits: l ? { ...l, mode: "max" } : null, base: null }, { bounds: b, fullW: W, fullH: H });
            const off = [];
            for (const b of [[1000, 1000, 2600, 1150], [1000, 1000, 1700, 1310], [1500, 500, 1650, 2500], [1200, 900, 2050, 1700]]) {
                const p = planOf(b, lim), [a, c] = String(p.info.aspect).split(":").map(Number);
                const near = presets.includes(p.info.aspect) && Math.abs(Math.log(p.cw / p.ch) - Math.log(a / c)) < 0.005 && Math.abs(Math.log(p.ew / p.eh) - Math.log(a / c)) < 0.03;
                if (!near) off.push(`${b}: crop ${p.cw} x ${p.ch} (${p.info.aspect}), sent ${p.ew} x ${p.eh}`);
            }
            const free = planOf([1000, 1000, 1700, 1310], { ...lim, aspects: [] });
            check(`${r.id}: a thin, an odd, a 1:13 and a near-square selection on a 4000 x 3000 picture: the crop widened to a preset's shape, the sent size within 3 % of it`, !off.length && free.info.aspect === null, off.join(" | ") || `without aspects: ${free.cw} x ${free.ch}`);
            const e = await runWs(editReq("wavespeed", v, { references: [pngOf(1024, 1024, "REF1")] }));
            const b = e.body;
            check(`${r.id} edit: the edit route, crop and reference in images, the mask in mask_image, no aspect preset beside the mask (the route takes the crop's shape)`, e.route === `openai/gpt-image-${ver}-${tier}/edit` && eq(e.tagged(b.images), ["CROP", "REF1"]) && e.tagged(b.mask_image) === "MASK" && !("aspect_ratio" in b), short({ route: e.route, body: b }));
            check(`${r.id} edit: the body inside the strict schema (no seed, no negative prompt)`, !againstSchema(b, editSchema).length && !("seed" in b), againstSchema(b, editSchema).join(" | "));
            if (ver === "2.6") check(`${r.id} edit: complexity high, quality and resolution from the rows`, b.complexity === "high" && b.quality === "medium" && b.resolution === "2k", short(b));
            else check(`${r.id} edit: no complexity`, !("complexity" in b));
            const nomask = await runWs(editReq("wavespeed", v, { width: 1000, height: 333, mask: null, maskAlpha: null }));
            check(`${r.id} edit without a mask at an odd crop (1000 x 333): no mask_image, the closest preset (3:1)`, !("mask_image" in nomask.body) && nomask.body.aspect_ratio === "3:1", short(nomask.body));
            const t = await runWs(textReq("wavespeed", v));
            check(`${r.id} new image 3840 x 2160: the text-to-image route, 16:9, no pictures, inside the strict text schema`, t.route === `openai/gpt-image-${ver}-${tier}/text-to-image` && t.body.aspect_ratio === "16:9" && !("images" in t.body) && !againstSchema(t.body, textSchema).length, againstSchema(t.body, textSchema).join(" | ") || short(t.body));
            const tr = await runWs(textReq("wavespeed", v, { references: [pngOf(1024, 1024, "REF1")] }));
            check(`${r.id} new image with a reference layer: the edit route, the reference alone, no mask`, tr.route === `openai/gpt-image-${ver}-${tier}/edit` && eq(tr.tagged(tr.body.images), ["REF1"]) && !("mask_image" in tr.body) && !againstSchema(tr.body, editSchema).length, short(tr.body));
            const lay = wavespeed.layout(editReq("wavespeed", v, { references: [pngOf(1024, 1024, "REF1")] }));
            check(`${r.id}: the layout names the mask in its own field and the cap of 16`, lay.max === 16 && lay.pictures.some((p) => p.role === "mask" && p.field === "mask_image" && p.n == null), short(lay.pictures));
        }
    });

    await section("7. OpenRouter", async () => {
        for (const r of [R.f26, R.s26]) {
            const v = r.providers.openrouter, tier = r.id.endsWith("flare") ? "flare" : "sunburst";
            const saved = ref(`openrouter/openai_gpt-image-2.6-${tier}.json`);
            const ep = saved.endpoints.endpoints[0];
            check(`${r.id}: the saved endpoint list is OpenAI's, and it allows complexity as a passthrough`, ep.provider_slug === "openai" && ep.allowed_passthrough_parameters.includes("complexity"));
            const e = await runOr(editReq("openrouter", v));
            const b = e.body;
            check(`${r.id} edit: the model, complexity high as provider.options.openai, never at the top`, b.model === `openai/gpt-image-2.6-${tier}` && eq(b.provider.options, { openai: { complexity: "high" } }) && !("complexity" in b), short(b && { ...b, input_references: (b.input_references || []).length, prompt: undefined }));
            const params = saved.model.supported_parameters;
            check(`${r.id} edit: output_format png (the endpoint lists png, jpeg, webp, gif; the variant pins png)`, b.output_format === "png" && params.output_format.values.includes("png") && v.options.accepts.includes("output_format") && eq(v.fixed, { output_format: "png" }), short(b.output_format));
            const outside = Object.keys(b).filter((k) => !["model", "prompt", "provider", "input_references"].includes(k) && !(k in params));
            check(`${r.id} edit: every other key in OpenRouter's supported_parameters, crop and mask as two pictures`, !outside.length && b.input_references.length === 2, outside.join(", "));
            const low = await runOr(editReq("openrouter", v, { params: paramsOf(v, { complexity: "low" }) }));
            const junk = await runOr(editReq("openrouter", v, { params: paramsOf(v, { complexity: "extreme" }) }));
            check(`${r.id}: Complexity low goes as low; a value outside the three is left out`, low.body.provider.options.openai.complexity === "low" && !(junk.body.provider.options && junk.body.provider.options.openai), short([low.body.provider, junk.body.provider]));
            const t = await runOr(textReq("openrouter", v), "generate");
            check(`${r.id} new image 3840 x 2160: aspect 16:9, PNG and the passthrough`, t.body.aspect_ratio === "16:9" && t.body.output_format === "png" && t.body.provider.options.openai.complexity === "high" && !("input_references" in t.body), short(t.body));
            const tb = await runOr(editReq("openrouter", v, { params: paramsOf(v, { background: "transparent" }) }));
            check(`${r.id} edit with a transparent background: background transparent, still PNG`, tb.body.background === "transparent" && tb.body.output_format === "png", short([tb.body.background, tb.body.output_format]));
        }
        const e25 = await runOr(editReq("openrouter", R.f25.providers.openrouter, { params: { ...paramsOf(R.f25.providers.openrouter), complexity: "low" } }));
        check("2.5 Flare on OpenRouter: no passthrough options (its variant names none)", !(e25.body.provider && e25.body.provider.options), short(e25.body.provider));
    });

    await section("8. ToAPIs (Sunburst, official channel)", async () => {
        const v = R.s26.providers.toapis;
        const saved = ref("toapis/gpt-image-2.6-official.json");
        check("the saved page: both official ids, the mask as a PNG alpha mask, up to 16 images, the pixel rules", eq(saved.models, ["gpt-image-2.6-sunburst-official", "gpt-image-2.6-flare-official"]) && /alpha mask/.test(saved.page.mask_url) && /up to 16 images/.test(saved.page.image_urls) && /multiples of 16/.test(saved.page.size) && /8,294,400/.test(saved.page.size));
        const e = await runToapis(editReq("toapis", v, { references: [pngOf(1024, 1024, "REF1")] }));
        const b = e.body;
        check("edit 3840 x 2160: the official id, size 3840x2160, crop and reference uploaded into image_urls, the alpha mask as mask_url, complexity high, quality high, no channel", b.model === "gpt-image-2.6-sunburst-official" && b.size === "3840x2160" && eq(b.image_urls.map(e.tagOfUrl), ["CROP", "REF1"]) && e.tagOfUrl(b.mask_url) === "MASKALPHA" && b.complexity === "high" && b.quality === "high" && !("channel" in b) && !("background" in b), short(b));
        const odd = await runToapis(editReq("toapis", v, { width: 1000, height: 333, params: paramsOf(v, { complexity: "medium", background: "transparent" }) }));
        const [ow, oh] = sizeOf(odd.body.size);
        check("edit at an odd crop (1000 x 333): a size inside the rules, complexity medium, background transparent", !sizeBad(ow, oh).length && odd.body.complexity === "medium" && odd.body.background === "transparent", short(odd.body));
        for (const [w, h] of [[544, 2160], [512, 512]]) {
            const s = (await runToapis(editReq("toapis", v, { width: w, height: h }))).body.size;
            const [sw, sh] = sizeOf(s);
            check(`edit at a ${w} x ${h} crop (${w < h ? "about 1:4" : "under the pixel floor"}): a size inside the rules`, !sizeBad(sw, sh).length, s + " " + sizeBad(sw, sh).join(", "));
        }
        const t = await runToapis(textReq("toapis", v, { width: 1024, height: 576 }), "generate");
        const [tw, th] = sizeOf(t.body.size);
        check("new image (16:9 at 1024): no upload, the asked size grown over the floor, no mask, no output_format beyond the upstream default", !("image_urls" in t.body) && !("mask_url" in t.body) && !sizeBad(tw, th).length && !("output_format" in t.body), short(t.body));
        // every body against the page's parameter list (saved with the ref): no key it does not name, each value in its
        // enum or range, never GIF or SVG
        const P26 = saved.params;
        const paramBad = (body) => {
            const bad = againstSchema(body, P26);
            for (const [k, x] of Object.entries(body)) {
                const p = P26.properties[k];
                if (!p) continue;
                if (p.type === "integer" && (!Number.isInteger(x) || (p.minimum != null && x < p.minimum) || (p.maximum != null && x > p.maximum))) bad.push(`${k}: ${x} outside ${p.minimum}..${p.maximum}`);
                if (p.type === "string" && typeof x !== "string") bad.push(`${k}: not a string`);
                if (p.type === "array" && !Array.isArray(x)) bad.push(`${k}: not a list`);
            }
            if ("output_format" in body && body.output_format !== "png") bad.push(`output_format ${body.output_format}`);
            return bad;
        };
        const bodies = { "edit 3840 x 2160": b, "edit 1000 x 333 transparent": odd.body, "new image": t.body };
        const lowQ = await runToapis(editReq("toapis", v, { params: paramsOf(v, { quality: "max", complexity: "low", background: "opaque" }) }));
        bodies["edit quality max, complexity low, opaque"] = lowQ.body;
        const pbad = Object.entries(bodies).flatMap(([what, body]) => paramBad(body).map((x) => `${what}: ${x}`));
        check("the saved parameter list names model, prompt, size, resolution, quality (auto..max), n 1-4, output_format, background, moderation, complexity, image_urls, mask_url", ["model", "prompt", "size", "resolution", "quality", "n", "output_format", "background", "moderation", "complexity", "image_urls", "mask_url"].every((k) => k in P26.properties) && eq(P26.properties.quality.enum, ["auto", "low", "medium", "high", "xhigh", "max"]) && P26.properties.n.maximum === 4 && eq(P26.properties.complexity.enum, ["low", "medium", "high"]));
        check("every ToAPIs body inside the page's parameter list (keys, enums, n in 1..4; output_format absent or png)", !pbad.length, pbad.join(" | "));
        check("the layout: the cap of 16 and the mask in its own field", toapis.layout(editReq("toapis", v)).max === 16 && toapis.layout(editReq("toapis", v)).pictures.some((p) => p.role === "mask" && p.field === "mask_url"));
        let asked = 0;
        const many = await thrown(() => toapis.edit(editReq("toapis", v, { references: Array.from({ length: 16 }, (_, i) => pngOf(64, 64, "R" + i)) }), { key: "sk-test", fetch: async () => { asked++; return json(500, {}); }, log() {}, sleep: async () => {} }));
        check("17 pictures are refused before any request", !!many && /takes 16 images, this run has 17/.test(many) && asked === 0, many);
    });

    const passed = results.filter(Boolean).length;
    console.log(`\n${passed} of ${results.length} checks passed`);
    console.log(passed === results.length ? "PASS" : "FAIL");
    process.exit(passed === results.length ? 0 : 1);
})();
