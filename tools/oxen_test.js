// The Oxen.ai adapter (electron/main/providers/oxen.js), its recipe variants, its upsampling rows (llm.js) and its
// assistant entry, in plain Node, no Electron and no key:
//   node tools/oxen_test.js
// A scripted fetch plays hub.oxen.ai and its loopback mock; ctx.sleep records its waits instead of waiting. Every body
// the adapter builds for a shipped variant is checked against the model's own request_schema (tools/refs/oxen/, copied
// from GET https://hub.oxen.ai/api/ai/models on 2026-09-26): every field one the schema names, every enum and bound held.
// The last check says that no call carried the key anywhere but in Authorization toward the API's own origin, and no
// attribution header. Nothing here talks to the live API.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const oxen = require(path.join(ROOT, "electron", "main", "providers", "oxen.js"));

const KEY = "test-oxen-0123456789ab";
const REAL_KEY = "oxn_" + "0123456789abcdefghijklmnopqrstuvwxyzAB".slice(0, 36);   // 40 characters; the real format is not documented
const BASE = "http://127.0.0.1:5561";
const LIVE = "https://hub.oxen.ai";
const REFS = path.join(ROOT, "tools", "refs", "oxen");
const RECIPES = path.join(ROOT, "recipes");
const ALL_CALLS = [];

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 500 ? s.slice(0, 500) + " ..." : s; };
async function throws(fn) { try { await fn(); return null; } catch (e) { return String(e && e.message || e); } }

/** A PNG as far as the adapter looks: the signature, a real IHDR, padding and a tag. */
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
const tagOf = (b) => Buffer.from(b).toString("latin1", 33, 33 + 16).replace(/\0+$/, "");
const RESULT = pngOf(1024, 768, 80, "RESULT");
const WEBP = Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"), Buffer.alloc(40)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
const fromDataUrl = (url) => { const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(url || "")); return m ? { mime: m[1], bytes: Buffer.from(m[2], "base64") } : null; };
/** A body with every data URL replaced by "<mime tag>", for exact comparisons. */
const norm = (body) => JSON.parse(JSON.stringify(body, (k, v) => {
    if (typeof v !== "string" || !v.startsWith("data:")) return v;
    const d = fromDataUrl(v);
    return d ? `<${d.mime.replace("image/", "")} ${tagOf(d.bytes) || d.bytes.length}>` : v;
}));

// ---- the model schemas, and a validator for what they use of JSON Schema ------------------------------------------

const schemaOf = (id) => JSON.parse(fs.readFileSync(path.join(REFS, id + ".json"), "utf8")).request_schema;
function validate(s, v, at = "body") {
    const out = [];
    if (v === null) return s.nullable ? out : [`${at}: null`];
    const is = { string: typeof v === "string", integer: Number.isInteger(v), number: typeof v === "number", boolean: typeof v === "boolean", array: Array.isArray(v), object: !!v && typeof v === "object" && !Array.isArray(v) };
    if (s.type && !is[s.type]) return [`${at}: not ${s.type} (${short(v)})`];
    if (s.enum && !s.enum.includes(v)) out.push(`${at}: ${short(v)} not in ${short(s.enum)}`);
    if (s.format === "uri" && typeof v === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(v)) out.push(`${at}: not a URI`);
    if (typeof v === "number") {
        if (s.minimum != null && v < s.minimum) out.push(`${at}: ${v} < ${s.minimum}`);
        if (s.maximum != null && v > s.maximum) out.push(`${at}: ${v} > ${s.maximum}`);
    }
    if (typeof v === "string" && s.maxLength != null && v.length > s.maxLength) out.push(`${at}: longer than ${s.maxLength}`);
    if (Array.isArray(v)) {
        if (s.maxItems != null && v.length > s.maxItems) out.push(`${at}: ${v.length} items > ${s.maxItems}`);
        if (s.items) v.forEach((x, i) => out.push(...validate(s.items, x, `${at}[${i}]`)));
    }
    if (is.object && s.properties) {
        for (const r of s.required || []) if (!(r in v)) out.push(`${at}: missing ${r}`);
        for (const [k, x] of Object.entries(v)) {
            if (s.properties[k]) out.push(...validate(s.properties[k], x, `${at}.${k}`));
            else out.push(`${at}: unknown field ${k}`);
        }
    }
    return out;
}
/** A body against its model's schema; the envelope (model, response_format) is Oxen's own, not the model's. */
function problems(modelId, body) {
    const { model, response_format, ...rest } = body;
    const out = validate(schemaOf(modelId), rest);
    if (model !== modelId) out.push(`model ${model}`);
    if (response_format !== "b64_json") out.push(`response_format ${response_format}`);
    return out;
}

// ---- a fake hub.oxen.ai ---------------------------------------------------------------------------------------------

function recordHeaders(init) {
    const h = {};
    for (const [k, v] of new Headers((init && init.headers) || {})) h[k.toLowerCase()] = v;
    return h;
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const oxenError = (status, type, detail, headers = {}) => json(status, { error: { type, title: type, detail }, status: "error", status_message: type }, headers);
const okImage = (bytes = RESULT) => json(200, { model: "m", created: 1789000000, images: [{ b64_json: bytes.toString("base64") }] });

/** answers: functions (call) -> Response, taken in order for the POSTs; `files` answers GETs by URL. */
function fakeServer(answers = [], files = {}) {
    const calls = [];
    const posts = [];
    async function fetch(url, init = {}) {
        const method = String(init.method || "GET").toUpperCase();
        const call = { url: String(url), method, headers: recordHeaders(init), body: init.body ? JSON.parse(init.body) : null };
        calls.push(call);
        ALL_CALLS.push(call);
        if (method === "POST") {
            posts.push(call);
            const a = answers.length ? answers.shift() : null;
            return a ? a(call) : okImage();
        }
        const f = files[String(url)];
        if (f) return f(call);
        return json(404, { error: { message: "no file" } });
    }
    return { fetch, calls, posts };
}
function ctxFor(server, extra = {}) {
    const sleeps = [];
    const logs = [];
    return {
        key: KEY, base: BASE, fetch: server.fetch, log: (m) => logs.push(String(m)), sleep: async (ms) => { sleeps.push(ms); },
        opaque: async () => true, toJpeg: async (png) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(Math.floor(png.length / 4))]),
        sleeps, logs, ...extra,
    };
}

// ---- the shipped recipes, normalised as the app does ------------------------------------------------------------------

async function loadRecipes() {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-oxen-test-"));
    const orig = Module._load;
    Module._load = function (request, ...rest) {
        if (request === "electron") return { app: { getPath: () => empty } };
        return orig.call(this, request, ...rest);
    };
    let recipes;
    try { recipes = require(path.join(ROOT, "electron", "main", "recipes.js")); } finally { Module._load = orig; }
    try { return await recipes.list(RECIPES); } finally { fs.rmSync(empty, { recursive: true, force: true }); }
}
const raw = (id) => JSON.parse(fs.readFileSync(path.join(RECIPES, id + ".json"), "utf8"));

/** The settings' defaults and the fixed values, as host.providerParams gives them. */
function paramsOf(settings, fixed) {
    const p = {};
    for (const st of settings || []) p[st.key] = st.spec[1].default;
    return Object.assign(p, fixed || {});
}
const CROP = () => pngOf(1024, 768, 80, "CROP");
const editReq = (v, extra = {}) => ({
    model: v.model, kind: v.input === "edit" ? "edit" : "fill", options: v.options, params: paramsOf(v.settings, v.fixed),
    prompt: "a red door", negative: "", seed: 1234, image: CROP(), mask: pngOf(1024, 768, 70, "MASK", 0), maskAlpha: pngOf(1024, 768, 70, "ALPHA"),
    width: 1024, height: 768, references: [], ...extra,
});
const textReq = (v, extra = {}) => ({
    model: v.text.model, kind: "text", options: v.options, params: paramsOf(v.text.settings, v.text.fixed),
    prompt: "a lighthouse", negative: "", seed: 99, width: 1024, height: 1024, aspect: "1:1", image: null, references: [], ...extra,
});
const upReq = (v, extra = {}) => ({
    model: v.model, kind: "upscale", options: v.options, params: paramsOf(v.settings, v.fixed), factor: v.factor.fixed ? null : v.factor.default,
    prompt: "", seed: 5, image: pngOf(800, 600, 80, "UP"), width: 800, height: 600, references: [], ...extra,
});
async function bodyOf(req, ctx = ctxFor(fakeServer())) {
    if (req.kind === "text") return oxen._body(req);
    const { pics, mask } = await oxen._pictures(req, req.options || {}, ctx, req.model);
    return oxen._body(req, pics, mask);
}

(async () => {
    const list = await loadRecipes();
    const byId = Object.fromEntries(list.map((r) => [r.id, r]));
    const V = (id) => byId[id].providers.oxen;

    // ---- 1. host and key -----------------------------------------------------------------------------------------
    {
        const table = [["http://127.0.0.1:5", true], ["http://localhost:5", false], [LIVE, false], ["http://127.0.0.1:5/api", false], ["http://127.0.0.1:5/?a=1", false], ["http://u@127.0.0.1:5", false], ["https://evil.example", false], ["http://127.0.0.1", false]];
        check("host_testBase_takes_the_loopback_mock_only", table.every(([v, ok]) => !!oxen._testBase(v) === ok), short(table.map(([v]) => [v, oxen._testBase(v)])));
        check("host_baseUrl_defaults_to_hub.oxen.ai", oxen.baseUrl({}) === LIVE && oxen.baseUrl({ oxen: { base: "https://evil.example" } }) === LIVE && oxen.baseUrl({ oxen: { base: BASE } }) === BASE);
        const got = [];
        for (const [what, key, base] of [["a real key to the mock", REAL_KEY, BASE], ["a test key to hub.oxen.ai", KEY, undefined]]) {
            for (const verb of ["edit", "generate", "upscale"]) {
                const s = fakeServer();
                const req = verb === "generate" ? textReq(V("nano_banana_2")) : verb === "upscale" ? upReq(V("topaz_precision")) : editReq(V("nano_banana_2"));
                const e = await throws(() => oxen[verb](req, ctxFor(s, { key, base })));
                got.push({ what, verb, e, calls: s.calls.length });
            }
        }
        check("key_rule_both_ways_before_any_call", got.every((g) => g.calls === 0 && (g.what.startsWith("a real") ? /only a test key goes there/.test(g.e) : /test key is never sent to hub\.oxen\.ai/.test(g.e)) && !String(g.e).includes(REAL_KEY)), short(got));
        const s = fakeServer();
        await oxen.edit(editReq(V("nano_banana_2")), ctxFor(s, { key: REAL_KEY, base: undefined }));
        check("a_real_key_goes_to_hub.oxen.ai_as_bearer", s.posts.length === 1 && s.posts[0].url === LIVE + "/api/ai/images/edit" && s.posts[0].headers.authorization === "Bearer " + REAL_KEY, short(s.posts.map((p) => p.url)));
    }

    // ---- 2. golden bodies ----------------------------------------------------------------------------------------
    {
        const FILL = "Edit the first image. The second image is a mask: change only the white area of the mask, keep everything else exactly as it is, and keep the image size and framing. a red door";
        const EDIT = "Edit the first image and keep its size and framing. a red door";
        const g = [];
        const want = (name, body, exp) => { if (!eq(norm(body), exp)) g.push(`${name}: ${short(norm(body))}`); };
        want("gpt_image_2 fill", await bodyOf(editReq(V("gpt_image_2"))),
            { model: "gpt-image-2", prompt: EDIT, response_format: "b64_json", input_image: ["<png CROP>"], mask_url: "<png MASK>", quality: "high", output_format: "png", resolution: "1K", aspect_ratio: "auto" });
        want("flare fill transparent", await bodyOf(editReq(V("gpt_image_2_5_flare"), { params: { ...paramsOf(V("gpt_image_2_5_flare").settings, V("gpt_image_2_5_flare").fixed), background: "transparent", moderation: "auto" }, width: 1536, height: 1024 })),
            { model: "gpt-image-2-5-flare", prompt: EDIT, response_format: "b64_json", input_image: ["<png CROP>"], mask_url: "<png ALPHA>", quality: "high", background: "transparent", moderation: "auto", output_format: "png", resolution: "2K", aspect_ratio: "auto" });
        want("nano_banana_2 fill", await bodyOf(editReq(V("nano_banana_2"))),
            { model: "nano-banana-2", prompt: FILL, response_format: "b64_json", input_image: ["<png CROP>", "<png MASK>"], thinking_level: "minimal", resolution: "1K", aspect_ratio: "auto" });
        want("seedream_5_pro edit", await bodyOf(editReq(V("seedream_5_pro"), { width: 1600, height: 900 })),
            { model: "bytedance-seedream-5-pro", prompt: EDIT, response_format: "b64_json", input_image: ["<png CROP>"], watermark: false, output_format: "png", size: "2K", aspect_ratio: "16:9" });
        want("qwen_image_edit alone", await bodyOf(editReq(V("qwen_image_edit"), { negative: "blur" })),
            { model: "qwen-image-3", prompt: EDIT, response_format: "b64_json", input_images: ["<png CROP>"], enable_prompt_expansion: false, watermark: false, resolution: "1K", aspect_ratio: "auto", seed: 1234, negative_prompt: "blur" });
        want("qwen_image_edit with a reference", await bodyOf(editReq(V("qwen_image_edit"), { references: [pngOf(512, 512, 70, "REF")] })),
            { model: "qwen-image-3", prompt: EDIT + " The remaining image is reference material.", response_format: "b64_json", input_images: ["<png CROP>", "<png REF>"], enable_prompt_expansion: false, watermark: false, resolution: "1K", aspect_ratio: "4:3", seed: 1234 });
        want("grok edit", await bodyOf(editReq(V("grok_imagine"))),
            { model: "xai-grok-imagine-image-edit", prompt: EDIT, response_format: "b64_json", input_image: "<png CROP>", output_format: "png" });
        want("grok text", await bodyOf(textReq(V("grok_imagine"), { aspect: "16:9", width: 1920, height: 1080 })),
            { model: "xai-grok-imagine-image", prompt: "a lighthouse", response_format: "b64_json", output_format: "png", resolution: "2k", aspect_ratio: "16:9" });
        want("flux2_pro edit", await bodyOf(editReq(V("flux2_pro"))),
            { model: "flux-2-pro", prompt: EDIT, response_format: "b64_json", input_image: ["<png CROP>"], output_format: "png", resolution: "1 MP", aspect_ratio: "match_input_image", seed: 1234 });
        want("flux2_klein edit", await bodyOf(editReq(V("flux2_klein"), { width: 900, height: 1200 })),
            { model: "black-forest-labs-flux-2-klein-9b", prompt: EDIT, response_format: "b64_json", input_image: ["<png CROP>"], num_inference_steps: 28, output_quality: "standard", output_format: "png", aspect_ratio: "3:4", seed: 1234 });
        want("ideogram text", await bodyOf(textReq(V("ideogram_4"), { aspect: "9:16", width: 576, height: 1024 })),
            { model: "ideogram-v4", prompt: "a lighthouse", response_format: "b64_json", rendering_speed: "BALANCED", expansion_model: "Medium", output_format: "png", num_images: 1, image_size: "portrait_16_9", seed: 99 });
        want("krea text", await bodyOf(textReq(V("krea_2"), { aspect: "21:9", width: 2100, height: 900 })),
            { model: "krea-v2-large-text-to-image", prompt: "a lighthouse", response_format: "b64_json", creativity: "medium", aspect_ratio: "2.35:1", seed: 99 });
        want("z-image text", await bodyOf(textReq(V("z_image_turbo"))),
            { model: "z-image-turbo", prompt: "a lighthouse", response_format: "b64_json", num_inference_steps: 8, output_format: "png", seed: 99 });
        want("topaz_precision 4x", await bodyOf(upReq(V("topaz_precision"), { factor: 4 })),
            { model: "topazlabs-image-upscale", response_format: "b64_json", input_image: "<png UP>", enhance_model: "Standard V2", output_format: "png", upscale_factor: "4x" });
        want("wonder 6x", await bodyOf(upReq(V("topaz_generative"), { factor: 6 })),
            { model: "topazlabs-wonder-3-5-image", response_format: "b64_json", input_image: "<png UP>", enhancement_strength: "high", scale: "6x" });
        const long = "x".repeat(1100);
        const bloomLogs = [];
        const bloom = await bodyOf({ ...upReq(V("topaz_creative"), { prompt: long, params: { creativity: "7", autoprompt: false } }), log: (m) => bloomLogs.push(m) });
        want("bloom", bloom, { model: "topazlabs-bloom-2-image", response_format: "b64_json", input_image: "<png UP>", creativity: 7, autoprompt: false, prompt: "x".repeat(1024) });
        want("qwen_image_2_1 edit", await bodyOf(editReq(V("qwen_image_2_1"))),
            { model: "qwen-image-2-1", prompt: EDIT, response_format: "b64_json", input_images: ["<png CROP>"], output_format: "png", resolution: "1K", aspect_ratio: "4:3" });
        check("golden_bodies_of_every_dialect", !g.length, g.join(" | ") || "17 bodies");
        check("a_cut_prompt_is_logged", bloomLogs.some((m) => /cut to the model's 1024/.test(m)), short(bloomLogs));
    }

    // ---- 3. every body of every shipped variant validates against its model's schema --------------------------------
    {
        const served = list.filter((r) => r.providers && r.providers.oxen);
        const bad = [];
        let n = 0;
        const variantsOf = (settings) => {
            const out = [];
            for (const st of settings || []) if (Array.isArray(st.spec[0])) for (const val of st.spec[0]) out.push({ [st.key]: val });
            return out;
        };
        for (const r of served) {
            const v = r.providers.oxen;
            const o = v.options || {};
            const edSchema = schemaOf(v.model);
            for (const k of o.accepts || []) if (!(k in edSchema.properties)) bad.push(`${r.id}: accepts ${k}, the schema has no such field`);
            if (o.text && v.text) for (const k of o.text.accepts || []) if (!(k in schemaOf(v.text.model).properties)) bad.push(`${r.id}: text accepts ${k}, not in ${v.text.model}`);
            for (const st of [...(v.settings || []), ...((v.text && v.text.settings) || [])]) {
                const acc = (v.text && (v.text.settings || []).includes(st) && o.text ? o.text.accepts : o.accepts) || [];
                if (!acc.includes(st.key)) bad.push(`${r.id}: the setting ${st.key} is not in accepts`);
            }
            const run = (req) => bodyOf(req).then((b) => { n++; const p = problems(req.model, b); if (p.length) bad.push(`${r.id} ${req.kind}: ${p.join("; ")}`); return b; }, (e) => bad.push(`${r.id} ${req.kind}: threw ${e.message}`));
            if (r.task === "upscale") {
                const factors = v.factor.fixed ? [null] : (v.factor.steps || [v.factor.default]);
                for (const f of factors) await run(upReq(v, { factor: f }));
                for (const ov of variantsOf(v.settings)) await run(upReq(v, { params: { ...paramsOf(v.settings, v.fixed), ...ov } }));
                await run(upReq(v, { prompt: "sharp moss" }));
                continue;
            }
            if (v.edit !== false) {
                const perMask = v.input !== "edit" && !o.mask ? 1 : 0;
                const most = Math.max(0, (o.single ? 1 : (o.max_images || 16)) - 1 - perMask);
                for (const refs of [...new Set([0, Math.min(1, most), most])]) {
                    await run(editReq(v, { references: Array.from({ length: refs }, (_, i) => pngOf(640, 480, 60, "R" + i)) }));
                }
                for (const ov of variantsOf(v.settings)) await run(editReq(v, { params: { ...paramsOf(v.settings, v.fixed), ...ov } }));
                await run(editReq(v, { params: { ...paramsOf(v.settings, v.fixed), random_seed: true } }));
            }
            if (v.text) {
                for (const aspect of ["1:1", "16:9", "9:16", "4:3", "3:2"]) await run(textReq(v, { aspect }));
                for (const ov of variantsOf(v.text.settings)) await run(textReq(v, { params: { ...paramsOf(v.text.settings, v.text.fixed), ...ov } }));
            }
        }
        check("every_body_validates_against_its_schema", !bad.length, bad.slice(0, 12).join(" | ") || `${served.length} recipes, ${n} bodies`);
    }

    // ---- 4. pictures and masks -------------------------------------------------------------------------------------
    {
        const s = fakeServer();
        const refs = (k) => Array.from({ length: k }, (_, i) => pngOf(300, 300, 60, "R" + i));
        const q = await throws(() => oxen.edit(editReq(V("qwen_image_edit"), { references: refs(3) }), ctxFor(s)));
        check("more_pictures_than_the_model_takes_are_refused_before_sending", /takes at most 3 pictures; this run has 4 \(the crop, 3 references\): turn Original off/.test(q) && s.calls.length === 0, q);
        const nb = await throws(() => oxen.edit(editReq(V("nano_banana_2"), { references: refs(13) }), ctxFor(s)));
        check("the_mask_picture_counts", /this run has 15 \(the crop, the mask, 13 references\)/.test(nb) && s.calls.length === 0, nb);
        const gk = await throws(() => oxen.edit(editReq(V("grok_imagine"), { references: refs(1) }), ctxFor(s)));
        check("a_single_picture_model_refuses_references", /takes at most 1 picture;/.test(gk) && s.calls.length === 0, gk);
        const steep = await throws(() => oxen.edit(editReq(V("seedream_5_pro"), { image: pngOf(3400, 200, 80, "CROP") }), ctxFor(s)));
        check("a_picture_steeper_than_max_ratio_is_refused", /no steeper than 16:1; the crop is 3400 × 200/.test(steep) && s.calls.length === 0, steep);
        const big = (tag) => pngOf(1024, 768, 7 * 1000 * 1000, tag);
        const jpegs = [];
        const ctx = ctxFor(s, { toJpeg: async (png) => { jpegs.push(tagOf(png)); return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1000)]); } });
        const got = await oxen._pictures(editReq(V("gpt_image_2"), { image: big("CROP"), references: [pngOf(10, 10, 3 * 1000 * 1000, "R1")], mask: pngOf(1024, 768, 5 * 1000 * 1000, "MASK") }), V("gpt_image_2").options, ctx, "gpt-image-2");
        check("over_the_inline_cap_opaque_pictures_go_as_jpeg_largest_first_never_the_mask", eq(jpegs, ["CROP"]) && got.pics[0].mime === "image/jpeg" && got.pics[1].mime === "image/png" && /^data:image\/png;base64,/.test(got.mask), short({ jpegs, mimes: got.pics.map((p) => p.mime) }));
        const clear = await throws(() => oxen._pictures(editReq(V("gpt_image_2"), { image: big("CROP"), references: [big("R1")], mask: big("MASK") }), V("gpt_image_2").options, ctxFor(s, { opaque: async () => false }), "gpt-image-2"));
        check("a_transparent_crop_is_not_re_encoded_and_the_run_is_refused_over_the_cap", /more than the 18 MB this app sends in one request\. Set Highres fix lower/.test(clear) && s.calls.length === 0, clear);
        const white = await oxen._pictures(editReq(V("gpt_image_2")), V("gpt_image_2").options, ctxFor(s), "m");
        const alpha = await oxen._pictures(editReq(V("gpt_image_2_5_flare")), V("gpt_image_2_5_flare").options, ctxFor(s), "m");
        check("mask_white_sends_req.mask_and_alpha_req.maskAlpha", tagOf(fromDataUrl(white.mask).bytes) === "MASK" && tagOf(fromDataUrl(alpha.mask).bytes) === "ALPHA" && white.pics.length === 1 && alpha.pics.length === 1);
        const none = await throws(() => oxen.edit(editReq(V("gpt_image_2_5_flare"), { maskAlpha: null }), ctxFor(s)));
        check("a_missing_alpha_mask_is_an_error_before_sending", /the run has no mask/.test(none) && s.calls.length === 0, none);
        const ed = await bodyOf(editReq(V("seedream_5_pro")));
        check("an_edit_sends_no_mask_field_and_no_mask_picture", !("mask_url" in ed) && ed.input_image.length === 1, short(norm(ed)));
    }

    // ---- 5. tiers and aspects --------------------------------------------------------------------------------------
    {
        const T = { "1K": 1024, "2K": 2048, "4K": 3840 };
        const MP = { "0.5 MP": 500000, "1 MP": 1000000, "2 MP": 2000000 };
        check("tier_by_the_long_side", oxen._tier(1024, 500, T) === "1K" && oxen._tier(1025, 10, T) === "2K" && oxen._tier(5000, 10, T) === "4K" && oxen._tier(1, 1, {}) === null);
        check("tier_by_area", oxen._tier(700, 700, MP, "area") === "0.5 MP" && oxen._tier(1024, 768, MP, "area") === "1 MP" && oxen._tier(1440, 1440, MP, "area") === "2 MP" && oxen._tier(1414, 1414, MP, "area") === "2 MP");
        const set = await bodyOf(editReq(V("gpt_image_2"), { params: { quality: "low", resolution: "4K", output_format: "png" } }));
        check("a_setting_overrides_the_auto_tier", set.resolution === "4K", set.resolution);
        const R = ["1:1", "16:9", "9:16", "4:3", "3:4"];
        check("text_aspect_the_asked_preset_or_the_closest", oxen._aspect({ kind: "text", aspect: "4:3" }, {}, R, 0) === "4:3" && oxen._aspect({ kind: "text", aspect: "21:9" }, {}, R, 0) === "16:9" && oxen._aspect({ kind: "text", width: 1000, height: 1300 }, {}, R, 0) === "3:4");
        const e = (mode, pics, w = 1000, h = 1300) => oxen._aspect({ kind: "edit", width: w, height: h }, { edit_aspect: mode }, R, pics);
        check("every_edit_aspect_mode", e("auto", 1) === "auto" && e("match_input_image", 1) === "match_input_image" && e("closest", 1) === "3:4" && e("auto-single", 1) === "auto" && e("auto-single", 2) === "3:4" && e(undefined, 1) === null);
        const lite = await bodyOf(editReq(V("seedream_5_lite"), { width: 3000, height: 2000 }));
        check("seedream_lite_sends_no_aspect_and_its_size_tier", !("aspect_ratio" in lite) && lite.size === "3K", short(norm(lite)));
    }

    // ---- 6. answers ------------------------------------------------------------------------------------------------
    {
        const url = BASE + "/api/repos/mock/files/1.png?sig=x";
        const s1 = fakeServer([() => json(200, { images: [{ url }] })], { [url]: () => new Response(RESULT, { status: 200 }) });
        const a1 = await oxen.edit(editReq(V("nano_banana_2")), ctxFor(s1));
        const get1 = s1.calls.find((c) => c.method === "GET");
        check("a_url_answer_is_fetched_without_the_key", a1.info.answer === "url" && tagOf(a1.bytes) === "RESULT" && !!get1 && !get1.headers.authorization, short(s1.calls.map((c) => c.method + " " + c.url)));
        let n = 0;
        const s2 = fakeServer([() => json(200, { images: [{ url }] })], { [url]: (c) => (++n && c.headers.authorization === "Bearer " + KEY ? new Response(RESULT) : json(401, { error: { message: "auth" } })) });
        const a2 = await oxen.edit(editReq(V("nano_banana_2")), ctxFor(s2));
        const gets2 = s2.calls.filter((c) => c.method === "GET");
        check("a_401_on_the_api_origin_is_fetched_once_more_with_the_key", tagOf(a2.bytes) === "RESULT" && gets2.length === 2 && !gets2[0].headers.authorization && gets2[1].headers.authorization === "Bearer " + KEY, short(gets2.map((g) => g.headers)));
        const other = "https://cdn.example/files/1.png";
        const s3 = fakeServer([() => json(200, { images: [{ url: other }] })], { [other]: () => json(401, { error: { message: "no" } }) });
        const e3 = await throws(() => oxen.edit(editReq(V("nano_banana_2")), ctxFor(s3, { key: REAL_KEY, base: undefined })));
        check("a_401_on_another_host_is_an_error_and_the_key_never_goes_there", /could not be downloaded \(answered 401\)/.test(e3) && s3.calls.filter((c) => c.url === other).every((c) => !c.headers.authorization), e3);
        const plain = "http://cdn.example/1.png";
        const s4 = fakeServer([() => json(200, { images: [{ url: plain }] })]);
        const e4 = await throws(() => oxen.edit(editReq(V("nano_banana_2")), ctxFor(s4)));
        check("plain_http_off_the_mock_is_refused", /not https/.test(e4) && !s4.calls.some((c) => c.url === plain), e4);
        const s5 = fakeServer([() => json(200, { images: [{ url: "data:image/webp;base64," + WEBP.toString("base64") }] })]);
        const a5 = await oxen.edit(editReq(V("nano_banana_2")), ctxFor(s5));
        const s6 = fakeServer([() => okImage(JPEG)]);
        const a6 = await oxen.edit(editReq(V("nano_banana_2")), ctxFor(s6));
        check("a_data_url_is_taken_and_the_mime_is_sniffed", a5.mime === "image/webp" && a6.mime === "image/jpeg" && a1.mime === "image/png", `${a5.mime} ${a6.mime}`);
        let tries = 0;
        const s7 = fakeServer([() => json(200, { images: [{ url }] })], { [url]: () => (++tries < 3 ? json(502, { error: { message: "bad gateway" } }) : new Response(RESULT)) });
        const c7 = ctxFor(s7);
        const a7 = await oxen.edit(editReq(V("nano_banana_2")), c7);
        check("a_5xx_download_is_tried_three_times", tagOf(a7.bytes) === "RESULT" && tries === 3 && eq(c7.sleeps, [2000, 4000]), `${tries} ${c7.sleeps}`);
        const e8 = await throws(() => oxen.edit(editReq(V("nano_banana_2")), ctxFor(fakeServer([() => json(200, { images: [] })]))));
        const e9 = await throws(() => oxen.edit(editReq(V("nano_banana_2")), ctxFor(fakeServer([() => json(200, { error: { message: "generation failed" } })]))));
        check("empty_images_and_a_200_carrying_an_error_are_errors", /no image in the answer/.test(e8) && /generation failed/.test(e9), `${e8} | ${e9}`);
    }

    // ---- 7. errors, retries, timeouts ---------------------------------------------------------------------------------
    {
        const rows = [
            [400, "invalid_params", "aspect_ratio: not in enum", /^request refused \(a setting or a picture\) - aspect_ratio/],
            [401, "unauthenticated", "Invalid API key " + KEY, /^key refused - Invalid API key \[key\]$/],
            [402, "insufficient_credits", "Insufficient credits", /^not enough Oxen credits/],
            [403, "forbidden", "blocked", /^refused \(the content policy/],
            [404, "resource_not_found", "gone", /^Oxen does not serve this model/],
            [413, "too_large", "big", /^request too large \(set Highres fix lower/],
            [429, "rate_limited", "slow down", /^rate limited/],
            [500, "unknown_error", "boom", /^the service failed/],
            [502, "bad_gateway", "upstream", /^the model's host failed/],
            [504, "timeout", "late", /^timed out/],
            [400, "invalid_params", "403 Client Error: Forbidden for url: data:image/png;base64,iVBOR", /^Oxen could not read the picture; Scumble sends it inline as a data URL/],
        ];
        const bad = [];
        for (const [status, type, detail, re] of rows) {
            const s = fakeServer([() => oxenError(status, type, detail, status === 429 ? { "retry-after": "120" } : {})]);
            const e = await throws(() => oxen.edit(editReq(V("nano_banana_2")), ctxFor(s)));
            const msg = String(e).replace(/^Oxen\.ai nano-banana-2: /, "");
            if (!re.test(msg) || s.posts.length !== 1 || String(e).includes(KEY)) bad.push(`${status}: ${e} (${s.posts.length} calls)`);
        }
        check("every_status_reads_in_words_one_call_each_the_key_scrubbed", !bad.length, bad.join(" | ") || `${rows.length} rows`);
        const nf = await throws(() => oxen.edit(editReq(V("nano_banana_2")), ctxFor(fakeServer([() => json(404, { error: { message: "Model not found: x" } })]))));
        const txt = await throws(() => oxen.edit(editReq(V("nano_banana_2")), ctxFor(fakeServer([() => new Response("<html>Bad Gateway</html>", { status: 502 })]))));
        check("both_envelopes_and_a_non_json_body", /Oxen does not serve this model \(any more\) - Model not found: x/.test(nf) && /the model's host failed - <html>Bad Gateway<\/html>/.test(txt), `${nf} | ${txt}`);
        const up413 = await throws(() => oxen.upscale(upReq(V("topaz_precision")), ctxFor(fakeServer([() => oxenError(413, "too_large", "big")]))));
        check("an_upscale_413_says_to_upscale_a_selection", /set a smaller selection, or upscale the selection/.test(up413), up413);

        const c1 = ctxFor(fakeServer([() => oxenError(429, "rate_limited", "x", { "retry-after": "2" })]));
        const r1 = await oxen.edit(editReq(V("nano_banana_2")), c1);
        const at = new Date(Date.now() + 30000).toUTCString();
        const c2 = ctxFor(fakeServer([() => oxenError(503, "busy", "x", { "retry-after": at })]));
        await oxen.edit(editReq(V("nano_banana_2")), c2);
        const c3 = ctxFor(fakeServer([() => oxenError(503, "busy", "x")]));
        await oxen.edit(editReq(V("nano_banana_2")), c3);
        check("retry_after_in_seconds_and_as_a_date_5s_by_default", !!r1 && eq(c1.sleeps, [2000]) && c2.sleeps.length === 1 && c2.sleeps[0] > 25000 && c2.sleeps[0] <= 30000 && eq(c3.sleeps, [5000]), short([c1.sleeps, c2.sleeps, c3.sleeps]));
        const s4 = fakeServer([() => oxenError(429, "rate_limited", "x", { "retry-after": "120" })]);
        const c4 = ctxFor(s4);
        const e4 = await throws(() => oxen.edit(editReq(V("nano_banana_2")), c4));
        const s5 = fakeServer([() => oxenError(429, "r", "x", { "retry-after": "1" }), () => oxenError(429, "r", "x", { "retry-after": "40" })]);
        const e5 = await throws(() => oxen.edit(editReq(V("nano_banana_2")), ctxFor(s5)));
        check("over_60s_no_wait_and_a_second_refusal_names_its_wait", /; try again in 120 s$/.test(e4) && !c4.sleeps.length && s4.posts.length === 1 && /; try again in 40 s$/.test(e5) && s5.posts.length === 2, `${e4} | ${e5}`);
        const s6 = fakeServer([() => oxenError(502, "x", "x")]);
        await throws(() => oxen.edit(editReq(V("nano_banana_2")), ctxFor(s6)));
        let netCalls = 0;
        const net = (cause) => ({ fetch: async () => { netCalls++; const e = new TypeError("fetch failed"); e.cause = cause; throw e; } });
        const t1 = await throws(() => oxen.edit(editReq(V("nano_banana_2")), ctxFor(net({ code: "UND_ERR_HEADERS_TIMEOUT" }))));
        const t2 = await throws(() => oxen.edit(editReq(V("nano_banana_2")), ctxFor(net({ code: "ECONNRESET" }))));
        check("a_502_and_network_errors_are_not_retried", s6.posts.length === 1 && netCalls === 2, `${s6.posts.length} ${netCalls}`);
        check("the_5_minute_limit_and_an_unreachable_host_in_words", /no answer within 5 minutes; the run may still be billed and saved in your Oxen account/.test(t1) && /hub\.oxen\.ai could not be reached - fetch failed/.test(t2), `${t1} | ${t2}`);
    }

    // ---- 8. upscale and generate routes --------------------------------------------------------------------------------
    {
        const s = fakeServer();
        const out = await oxen.upscale(upReq(V("topaz_precision"), { factor: 2, references: [pngOf(10, 10)] }), ctxFor(s));
        const b = s.posts[0].body;
        check("upscale_posts_to_images_edit_with_one_picture_and_the_factor", s.posts[0].url === BASE + "/api/ai/images/edit" && typeof b.input_image === "string" && b.upscale_factor === "2x" && out.info.factor === "2x" && out.info.route === "edit", short(norm(b)));
        const bl = await bodyOf(upReq(V("topaz_creative")));
        check("a_fixed_factor_sends_none_and_an_empty_prompt_is_left_out", !("prompt" in bl) && !Object.keys(bl).some((k) => /factor|scale/.test(k)), short(norm(bl)));
        const noPrompt = await bodyOf(upReq(V("topaz_precision"), { prompt: "ignored" }));
        check("a_model_without_a_prompt_field_gets_none", !("prompt" in noPrompt));
        const t = fakeServer();
        const gen = await oxen.generate(textReq(V("nano_banana_2")), ctxFor(t));
        const tb = t.posts[0].body;
        check("generate_posts_to_images_generate_with_no_picture_field", t.posts[0].url === BASE + "/api/ai/images/generate" && !("input_image" in tb) && tb.aspect_ratio === "1:1" && tb.resolution === "1K" && gen.info.route === "generate", short(tb));
        const np = await throws(() => oxen.generate(textReq(V("nano_banana_2"), { prompt: " " }), ctxFor(t)));
        check("a_new_image_needs_a_prompt", /a new image needs a prompt/.test(np) && t.posts.length === 1, np);
    }

    // ---- 9. providers/index.js ----------------------------------------------------------------------------------------
    {
        const keysPath = path.join(ROOT, "electron", "main", "keys.js");
        const settingsPath = path.join(ROOT, "electron", "main", "settings.js");
        const logPath = path.join(ROOT, "electron", "main", "log.js");
        require.cache[keysPath] = { id: keysPath, filename: keysPath, loaded: true, exports: { get: () => "", describe: () => ({ set: false }) } };
        require.cache[settingsPath] = { id: settingsPath, filename: settingsPath, loaded: true, exports: { get: () => ({}) } };
        require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: { record: () => {} } };
        const orig = Module._load;
        Module._load = function (request, ...rest) {
            if (request === "electron") return { nativeImage: {}, app: { getPath: () => os.tmpdir() } };
            return orig.call(this, request, ...rest);
        };
        let index;
        try { index = require(path.join(ROOT, "electron", "main", "providers", "index.js")); } finally { Module._load = orig; }
        const all = index.describeAll();
        const ids = all.map((p) => p.id);
        const row = all.find((p) => p.id === "oxen");
        check("index_registration_after_ark_before_magnific", ids.indexOf("oxen") === ids.indexOf("ark") + 1 && ids.indexOf("magnific") === ids.indexOf("oxen") + 1 && row.label === "Oxen.ai" && row.keyUrl === "https://oxen.ai/settings/profile" && row.balance === false && row.sharesKey === null, short(ids));
        check("oxen_makes_new_images_and_upscales", index.textProviders().includes("oxen") && index.upscaleProviders().includes("oxen"));
        const e = await throws(() => index.edit({ provider: "oxen", kind: "fill", model: "gpt-image-2", image: CROP() }));
        check("no_key_names_the_row", /No API key for Oxen\.ai/.test(e), e);
    }

    // ---- 10. the recipes ---------------------------------------------------------------------------------------------
    {
        const WANT = ["flux2_flex", "flux2_klein", "flux2_pro", "gpt_image_2", "gpt_image_2_5_flare", "gpt_image_2_5_sunburst", "grok_imagine", "ideogram_4", "krea_2", "nano_banana_2", "nano_banana_2_lite", "nano_banana_pro", "qwen_image_2_1", "qwen_image_edit", "seedream_5_lite", "seedream_5_pro", "topaz_creative", "topaz_generative", "topaz_precision", "z_image_turbo"];
        const served = list.filter((r) => r.providers && r.providers.oxen);
        check("twenty_recipes_carry_an_oxen_variant", eq(served.map((r) => r.id).sort(), WANT), served.map((r) => r.id).join(","));
        const bad = [];
        const OPEN = /^Runs on Oxen\.ai \(one key for many models\); not run against the live API yet \(written from Oxen's docs and model list, 2026-09-26\)\./;
        const PRIV = /The pictures go inline \(data URLs, which Oxen's docs allow but do not recommend for production\) in the request to Oxen\.ai/;
        for (const r of served) {
            const v = r.providers.oxen;
            const last = r.providerIds.filter((x) => x !== "magnific");
            if (last[last.length - 1] !== "oxen") bad.push(`${r.id}: oxen is not last before magnific (${r.providerIds})`);
            if (r.id !== "qwen_image_2_1" && r.default !== raw(r.id).default) bad.push(`${r.id}: default`);
            if (r.id !== "qwen_image_2_1" && (r.default === "oxen" || !/Also on Oxen\.ai\./.test(r.description || ""))) bad.push(`${r.id}: default or description`);
            if (!OPEN.test(v.note || "")) bad.push(`${r.id}: the note's opening`);
            if (v.edit !== false && !PRIV.test(v.note || "")) bad.push(`${r.id}: the privacy sentence`);
            const slots = (v.settings || []).map((s) => s.index);
            if (new Set(slots).size !== slots.length || slots.some((i) => i < 1 || i > 8)) bad.push(`${r.id}: slots ${slots}`);
        }
        check("each_variant_last_default_kept_described_and_noted", !bad.length, bad.join(" | "));
        check("seedream_lite_has_no_generate_new_and_three_are_text_only", V("seedream_5_lite").text === null && ["krea_2", "ideogram_4", "z_image_turbo"].every((id) => V(id).edit === false && !!V(id).text));
        check("qwen_image_2_1_runs_on_oxen_alone", byId.qwen_image_2_1.default === "oxen" && eq(byId.qwen_image_2_1.providerIds, ["oxen"]) && byId.qwen_image_2_1.family === byId.qwen_image_edit.family);
    }

    // ---- 11. prompt upsampling on the Oxen key (llm.js) ----------------------------------------------------------------
    {
        let currentKey = KEY;
        let currentSettings = { oxen: { base: BASE } };
        const orig = Module._load;
        const llmPath = path.join(ROOT, "electron", "main", "llm.js");
        Module._load = function (request, parent, ...rest) {
            if (request === "electron") return { app: { getPath: () => os.tmpdir() }, safeStorage: {} };
            if (parent && parent.filename === llmPath) {
                if (request === "./keys") return { get: (id) => (id === "oxen" ? currentKey : ""), describe: (id) => ({ set: id === "oxen" }) };
                if (request === "./settings") return { get: () => currentSettings };
            }
            return orig.call(this, request, parent, ...rest);
        };
        let llm;
        try { llm = require(llmPath); } finally { Module._load = orig; }
        const rows = llm.list().filter((r) => r.provider === "oxen");
        check("llm_three_oxen_rows", eq(rows.map((r) => r.id), ["oxen:gemini-3-8-flash", "oxen:gpt-5-6-luna", "oxen:gemma-4-31b-it"]) && rows.every((r) => r.key === true), short(rows));
        const realFetch = globalThis.fetch;
        const IMAGE = pngOf(64, 64, 90, "UPSAMPLE");
        async function scenario(answers, opts = {}) {
            const calls = [];
            globalThis.fetch = async (url, init = {}) => {
                const call = { url: String(url), method: String(init.method || "GET"), headers: recordHeaders(init), body: init.body ? JSON.parse(init.body) : null };
                calls.push(call);
                ALL_CALLS.push(call);
                return answers[Math.min(calls.length, answers.length) - 1]();
            };
            try { return { calls, res: await llm.ask({ id: opts.id || "oxen:gemini-3-8-flash", instruction: "rewrite", image: IMAGE }) }; } catch (e) { return { calls, err: String(e && e.message || e) }; } finally { globalThis.fetch = realFetch; }
        }
        const answer = (content) => () => json(200, { choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
        const a = await scenario([answer("a better prompt")]);
        const c = a.calls[0];
        const img = c && fromDataUrl(c.body.messages[0].content[1].image_url.url);
        check("llm_ask_posts_to_api_ai_chat_completions_not_v1", !a.err && a.calls.length === 1 && c.url === BASE + "/api/ai/chat/completions" && c.headers.authorization === "Bearer " + KEY && a.res.text === "a better prompt", short({ err: a.err, url: c && c.url }));
        check("llm_body_text_and_the_picture_as_a_data_url", !!c && eq(Object.keys(c.body).sort(), ["max_tokens", "messages", "model", "stream"]) && c.body.model === "gemini-3-8-flash" && c.body.stream === false && eq(c.body.messages[0].content[0], { type: "text", text: "rewrite" }) && !!img && img.mime === "image/png" && img.bytes.equals(IMAGE), short(c && c.body.messages[0].content.map((p) => p.type)));
        const b = await scenario([() => oxenError(402, "insufficient_credits", "Insufficient credits for " + KEY), answer("never")]);
        check("llm_errors_in_oxen_words_one_call_the_key_scrubbed", b.calls.length === 1 && /not enough Oxen credits/.test(b.err) && !b.err.includes(KEY), b.err);
        const d = await scenario([() => oxenError(400, "invalid_params", "image_url content part is not supported"), answer("text only answer")]);
        check("llm_retry_without_the_picture_only_on_a_4xx_that_names_the_image", d.calls.length === 2 && typeof d.calls[1].body.messages[0].content === "string" && d.res && d.res.note === "text only", short({ err: d.err, n: d.calls.length }));
        const e = await scenario([() => oxenError(401, "unauthenticated", "bad key"), answer("never")]);
        check("llm_a_refused_key_is_not_retried", e.calls.length === 1 && /key refused/.test(e.err), e.err);
        currentKey = REAL_KEY;
        const f = await scenario([answer("never")]);
        currentKey = KEY;
        currentSettings = {};
        const g = await scenario([answer("never")]);
        check("llm_key_rule_both_ways_with_no_call", /only a test key goes there/.test(f.err) && f.calls.length === 0 && !f.err.includes(REAL_KEY) && /test key is never sent/.test(g.err) && g.calls.length === 0, `${f.err} | ${g.err}`);
    }

    // ---- 12. the assistant's registry ----------------------------------------------------------------------------------
    {
        const reg = require(path.join(ROOT, "electron", "main", "assistant", "providers.js"));
        const models = require(path.join(ROOT, "electron", "main", "assistant", "models.js"));
        const e = reg.PROVIDERS.oxen;
        check("assistant_entry_fields", !!e && e.family === "chat" && e.key === "oxen" && e.base === "https://hub.oxen.ai/api/ai" && e.dialect.streamOptions === false && e.dialect.lengthField === "max_tokens" && eq(e.models.map((m) => m.id), ["claude-sonnet-5", "gpt-5-6-terra", "gemini-3-8-flash"]), short(e));
        check("assistant_order_oxen_before_the_local_endpoint", reg.ORDER.indexOf("oxen") === reg.ORDER.indexOf("wavespeed") + 1 && reg.ORDER[reg.ORDER.length - 1] === "compat");
        const group = reg.picker({ oxen: true }).find((x) => x.provider === "oxen");
        const po = reg.providerOf("oxen:gpt-5-6-terra");
        check("assistant_picker_and_providerOf", !!group && group.ready && group.models.length === 3 && !!po && po.model.label === "GPT-5.6 Terra");
        check("assistant_prices", eq(models.PRICES.oxen["claude-sonnet-5"], [3.5, 18, null, null]) && eq(models.PRICES.oxen["gemini-3-8-flash"], [0.75, 3.75, null, null]));
    }

    // ---- 13. over the whole run ----------------------------------------------------------------------------------------
    {
        const keys = [KEY, REAL_KEY];
        const bad = [];
        for (const c of ALL_CALLS) {
            const s = JSON.stringify({ url: c.url, body: c.body, headers: { ...c.headers, authorization: undefined } });
            if (keys.some((k) => s.includes(k))) bad.push(`key outside Authorization: ${c.method} ${c.url}`);
            if (c.headers.authorization) {
                const o = new URL(c.url);
                const origin = `${o.protocol}//${o.host}`;
                if (origin !== BASE && origin !== LIVE) bad.push(`Authorization to ${origin}`);
            }
            if (Object.keys(c.headers).some((h) => /referer|x-title/i.test(h))) bad.push(`attribution header on ${c.url}`);
            if (c.body && ("target_namespace" in c.body || "num_generations" in c.body)) bad.push(`target_namespace / num_generations on ${c.url}`);
            if (c.method === "POST" && /\/images\//.test(c.url) && c.body.response_format !== "b64_json") bad.push(`no b64_json on ${c.url}`);
        }
        check("whole_run_the_key_only_in_authorization_toward_the_api_no_attribution", !bad.length, bad.slice(0, 6).join(" | ") || `${ALL_CALLS.length} calls`);
    }

    const passed = results.filter(Boolean).length;
    console.log(`${passed} of ${results.length} checks passed`);
    console.log(passed === results.length ? "PASS" : "FAIL");
    process.exit(passed === results.length ? 0 : 1);
})().catch((err) => { console.error(err); console.log("FAIL"); process.exit(1); });
