// FLUX 3 Image on Black Forest Labs' API (electron/main/providers/flux3.js through bfl.js) and its recipe
// (recipes/flux3.json), in plain Node, no Electron, no key and no network:
//   node tools/flux3_test.js
// A scripted fetch plays api.bfl.ai: the submit, the poll and the result download. The request shapes follow the
// released API as docs.bfl.ai/flux_3 and api.bfl.ai/openapi.json describe it (read 2026-10-01, docs/PLAN_FLUX3.md):
// { prompt, images, aspect_ratio, resolution, safety_tolerance, grounding } under a strict schema (an unknown field
// answers 422), no seed, mask, width / height or mode. Waits are stubbed (util.sleep), so the poll loop runs at once.
"use strict";

const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const PROV = path.join(ROOT, "electron", "main", "providers");
const util = require(path.join(PROV, "util.js"));
const SLEEPS = [];
util.sleep = async (ms) => { SLEEPS.push(ms); };   // before bfl.js takes its copy
const bfl = require(path.join(PROV, "bfl.js"));
const fal = require(path.join(PROV, "fal.js"));
const oxen = require(path.join(PROV, "oxen.js"));
const wavespeed = require(path.join(PROV, "wavespeed.js"));
const flux3 = require(path.join(PROV, "flux3.js"));
const refs = require(path.join(PROV, "refs.js"));
const boxes = require(path.join(PROV, "boxes.js"));

const KEY = "test-bfl-0123456789abcdef";
const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 500 ? s.slice(0, 500) + " ..." : s; };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A PNG as far as the adapter looks: the signature, an IHDR of w x h and a tag that makes its bytes its own. */
function pngOf(w, h, tag, size = 64) {
    const b = Buffer.alloc(size, 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
    b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 6;
    b.write(tag, 33, "latin1");
    return b;
}
/** What the ctx.toJpeg stub answers: a JPEG start and the tag. */
function jpegOf(tag, size = 64) {
    const b = Buffer.alloc(size, 0);
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(b);
    b.write(tag, 33, "latin1");
    return b;
}
const tagOf = (b) => Buffer.from(b).toString("latin1", 33, 45).replace(/\0+$/, "");
const tagOfB64 = (s) => tagOf(Buffer.from(String(s), "base64"));

const CROP = pngOf(1024, 768, "CROP"), MASK = pngOf(1024, 768, "MASK"), RESULT = pngOf(1024, 768, "RESULT");
const REF = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => pngOf(640, 480, "REF" + i));
const SMALL = pngOf(200, 200, "SMALL");          // under 256 px a side
const HUGE = pngOf(5000, 4000, "HUGE");          // 20 MP
const SIXTEEN = pngOf(4000, 4000, "SIXTEEN");    // 16,000,000 px exactly: the most a picture may have
const OVER16 = pngOf(4001, 4000, "OVER16");
// 20,000,000 base64 characters is the most a picture may have: 15,000,000 bytes are exactly that, 3 more are past it
const BIG_OK = pngOf(2048, 2048, "BIGOK", 15000000);
const BIG = pngOf(2048, 2048, "BIG", 15000003);
const ALPHABIG = pngOf(2048, 2048, "ALPHABIG", 15000003);   // the opaque stub says no to every ALPHA.. tag

// ---- the recipe as recipes.js serves it -------------------------------------------------------------------------

function loadRecipe() {
    const orig = Module._load;
    Module._load = function (request, ...rest) {
        if (request === "electron") return { app: { getPath: () => ROOT } };
        return orig.call(this, request, ...rest);
    };
    let recipes;
    try { recipes = require(path.join(ROOT, "electron", "main", "recipes.js")); } finally { Module._load = orig; }
    const r = require(path.join(ROOT, "recipes", "flux3.json"));
    return recipes._normalize(JSON.parse(JSON.stringify(r)));
}
const RECIPE = loadRecipe();
const V = RECIPE.providers.bfl;

/** The Settings panel's starting values plus the fixed ones (host.js providerParams). */
function defaults(rows, fixed) {
    const p = {};
    for (const s of rows || []) p[s.key] = s.spec[1].default;
    return { ...p, ...(fixed || {}) };
}

/** A request as providers/index.js hands it to the adapter, for the shipped variant. */
function editReq(extra = {}) {
    return {
        provider: "bfl", model: V.model, kind: "edit", fields: null, options: V.options, prompt: "make the door red", negative: "", seed: 7,
        image: CROP, mask: MASK, maskAlpha: MASK, width: 1024, height: 768, references: [], original: 0, params: defaults(V.settings, V.fixed),
        refName: V.refs.name, ...extra,
    };
}
function textReq(extra = {}) {
    return {
        provider: "bfl", model: V.text.model, kind: "text", fields: null, options: V.options, prompt: "a lighthouse at dusk", negative: "", seed: 7,
        image: null, mask: null, maskAlpha: null, width: 1344, height: 768, references: [], original: 0, params: defaults(V.text.settings, V.text.fixed),
        refName: V.refs.name, ...extra,
    };
}

// ---- the fake api.bfl.ai ----------------------------------------------------------------------------------------

const EXPANDED = "A weathered wooden front door painted a deep cadmium red, the rest of the facade unchanged.";
const READY = { status: "Ready", result: { sample: "https://delivery-eu1.bfl.ai/r/1.png", prompt: EXPANDED, duration: 11.5 } };
const SUBMIT = { id: "t1", cost: 4.8, input_mp: 0.79, output_mp: 1.04 };
const F3_BODIES = [];   // every FLUX 3 body sent with the shipped field name, checked against the schema at the end
let JPEGS = [];         // the ctx.toJpeg calls of the last run

/**
 * Runs the adapter against a scripted server. `polls` are the answers to the polls in turn (the last repeats), each
 * [status, body]; `pollingUrl` what the submit answers as polling_url; `ctx` overrides the context (opaque, toJpeg).
 * Returns { out, err, calls, body }.
 */
async function run(req, { verb = "edit", polls = [[200, READY]], pollingUrl = "https://api.eu1.bfl.ai/v1/get_result?id=t1", submit = null, ctx = {}, downloadFails = 0 } = {}) {
    const calls = [];
    let body = null, k = 0;
    JPEGS = [];
    // a poll answer [0, "THROW"] drops the connection, [200, "HTML"] is a gateway page; `downloadFails` failed downloads first
    const answer = ([st, b]) => {
        if (b === "THROW") throw new Error("read ECONNRESET");
        if (b === "HTML") return new Response("<html>bad gateway</html>", { status: st, headers: { "content-type": "text/html" } });
        return json(st, b);
    };
    async function fetch(url, init = {}) {
        const u = new URL(String(url));
        const method = String(init.method || "GET").toUpperCase();
        calls.push({ method, url: String(url), headers: { ...(init.headers || {}) } });
        if (method === "POST") {
            body = JSON.parse(init.body);
            if (submit) return submit();
            return json(200, { ...SUBMIT, polling_url: pollingUrl });
        }
        if (u.pathname.endsWith("/get_result")) return answer(polls[Math.min(k++, polls.length - 1)]);
        if (u.hostname.startsWith("delivery")) {
            if (downloadFails-- > 0) throw new Error("socket hang up");
            return new Response(RESULT, { status: 200, headers: { "content-type": "image/png" } });
        }
        return json(404, { detail: "no route " + u.pathname });
    }
    const context = {
        key: KEY, fetch, log: () => {},
        opaque: async (b) => !tagOf(b).startsWith("ALPHA"),
        toJpeg: async (b, q) => { JPEGS.push({ tag: tagOf(b), q }); return jpegOf("J-" + tagOf(b)); },
        ...ctx,
    };
    let out = null, err = null;
    try { out = await bfl[verb]({ ...req }, context); } catch (e) { err = String(e && e.message || e); }
    if (body && flux3.isFlux3(req, req.model) && !(req.options && req.options.images_field)) F3_BODIES.push(body);
    return { out, err, calls, body };
}
const tagsOf = (list) => (Array.isArray(list) ? list.map(tagOfB64) : list);
const polled = (x) => x.calls.filter((c) => c.url.includes("get_result")).length;

/** The fields the released schema has (version aside: its one value is the default) and what never goes. */
const SCHEMA = ["prompt", "images", "aspect_ratio", "resolution", "safety_tolerance", "grounding"];
const NEVER = ["mode", "seed", "width", "height", "reference_images", "mask", "image", "input_image", "output_format", "negative_prompt", "steps", "guidance", "prompt_upsampling"];

(async () => {
    // ---- 1. the recipe ------------------------------------------------------------------------------------------
    console.log("\n--- 1. recipes/flux3.json ---");
    // B1: Comfy Router serves the same body (tools/comfyrouter_test.js holds that variant)
    check("the bfl variant, the home provider, an edit route, named FLUX 3 Image; fal, WaveSpeed, OpenRouter, Comfy Router and Oxen.ai after it", eq(RECIPE.providerIds, ["bfl", "fal", "wavespeed", "openrouter", "comfyrouter", "oxen"]) && RECIPE.default === "bfl" && V.input === "edit" && V.edit === true && RECIPE.name === "FLUX 3 Image", short({ ids: RECIPE.providerIds, def: RECIPE.default, input: V.input, name: RECIPE.name }));
    check("the endpoint flux-3-image is the variant's model, and the variant declares the FLUX 3 schema", V.model === "flux-3-image" && V.options.schema === "flux3" && flux3.isFlux3({ options: V.options }, V.model), short({ model: V.model, options: V.options }));
    check("options: accepts safety_tolerance and grounding (the adapter's default too), 10 pictures, no images_field", eq(V.options.accepts, ["safety_tolerance", "grounding"]) && eq(flux3.FLUX3_ACCEPTS, V.options.accepts) && V.options.max_images === 10 && !("images_field" in V.options) && flux3.FLUX3_IMAGES_FIELD === "images", short(V.options));
    check("limits: 2048 long side in 16 px steps, 608 the smallest, the 15 aspect presets", V.limits.max === 2048 && V.limits.step === 16 && V.limits.min === 608 && eq(V.limits.aspects, flux3.FLUX3_ASPECTS) && V.limits.aspects.length === 15, short(V.limits));
    check("the aspect presets are the docs' 15", eq(flux3.FLUX3_ASPECTS, ["21:9", "2:1", "16:9", "3:2", "7:5", "4:3", "5:4", "1:1", "4:5", "3:4", "5:7", "2:3", "9:16", "1:2", "9:21"]), short(flux3.FLUX3_ASPECTS));
    check("Generate new: the same endpoint, sizes 1024 / 2048 / 4096 (1k / 2k / 4k), the reference layers go along (text.refs)", V.text && V.text.model === V.model && eq(V.text.sizes, [1024, 2048, 4096]) && eq(V.text.refs, { max: null, field: null, model: null, options: null, name: null }), short(V.text));
    check("refs.name 'image {n}' (the docs: 'image 1' is the first entry of images)", V.refs.name === "image {n}", short(V.refs));
    const safety = (V.settings || []).find((s) => s.key === "safety_tolerance"), grounding = (V.settings || []).find((s) => s.key === "grounding");
    check("the rows: Safety tolerance INT 0 to 4 (default 2), Grounding BOOLEAN (default true, the API's), nothing else (the Boxes switch is the prompt's, S3d)", safety && eq(safety.spec, ["INT", { default: 2, min: 0, max: 4 }]) && grounding && eq(grounding.spec, ["BOOLEAN", { default: true }]) && V.settings.length === 2, short(V.settings));
    check("the variant takes boxes in the flux3 format (options.boxes), no selection_box row on either shape", V.options.boxes === "flux3" && boxes.schemaOf({ options: V.options }) === "flux3" && ![...(V.settings || []), ...(V.text.settings || [])].some((s) => s.key === "selection_box"), short({ boxes: V.options.boxes, text: V.text.settings }));
    check("a FLUX.2 endpoint is not FLUX 3, a flux-3 endpoint is without the option, flux-30 is not", !flux3.isFlux3({}, "flux-2-pro") && flux3.isFlux3({}, "flux-3") && flux3.isFlux3({}, "flux-3-image") && !flux3.isFlux3({}, "flux-30"), "");
    check("another endpoint name with options.schema flux3 is FLUX 3", flux3.isFlux3({ options: { schema: "flux3" } }, "flux-image-pro"), "");

    // ---- 2. an edit ------------------------------------------------------------------------------------------------
    console.log("\n--- 2. an edit ---");
    let x = await run(editReq());
    check("POST to https://api.bfl.ai/v1/flux-3-image with x-key and JSON", !x.err && x.calls[0].method === "POST" && x.calls[0].url === "https://api.bfl.ai/v1/flux-3-image" && x.calls[0].headers["x-key"] === KEY && x.calls[0].headers["Content-Type"] === "application/json", x.err || short(x.calls[0]));
    check("the body: prompt, images [crop], aspect_ratio 4:3, resolution 1k, safety_tolerance 2, grounding true; nothing else", x.body && eq(Object.keys(x.body), SCHEMA) && x.body.prompt === "make the door red" && eq(tagsOf(x.body.images), ["CROP"]) && x.body.aspect_ratio === "4:3" && x.body.resolution === "1k" && x.body.safety_tolerance === 2 && x.body.grounding === true, short(x.body && { ...x.body, images: tagsOf(x.body.images) }));
    check("no mode, seed, width, height, reference_images, mask, output_format or negative_prompt (a strict schema)", x.body && NEVER.every((k) => !(k in x.body)), short(x.body && Object.keys(x.body)));
    check("the crop goes as the PNG it is (base64, no data URI)", x.body && Buffer.from(x.body.images[0], "base64").equals(CROP), short(x.body && x.body.images[0].slice(0, 40)));
    check("the answer: the result bytes, no seed (none was sent and the answer names none)", x.out && Buffer.from(x.out.bytes).equals(RESULT) && x.out.mime === "image/png" && x.out.seed === undefined, short(x.out && { seed: x.out.seed, mime: x.out.mime }));
    check("info: the endpoint, the submit's cost and megapixels, aspect 4:3, 1k, fit stretch, the expanded prompt and the duration", x.out && eq(x.out.info, { endpoint: V.model, cost: 4.8, input_mp: 0.79, output_mp: 1.04, aspect: "4:3", resolution: "1k", fit: "stretch", expanded_prompt: EXPANDED, duration: 11.5 }), short(x.out && x.out.info));
    check("the poll goes to the submit's polling_url (a regional bfl.ai host) with the key; the download goes without it", x.calls[1].url === "https://api.eu1.bfl.ai/v1/get_result?id=t1" && x.calls[1].headers["x-key"] === KEY && x.calls[2].url.startsWith("https://delivery-eu1.bfl.ai/") && !("x-key" in x.calls[2].headers), short(x.calls.map((c) => c.url)));
    x = await run(editReq(), { polls: [[200, { status: "Ready", cost: 5, result: { sample: "https://delivery-eu1.bfl.ai/r/1.png", prompt: "x".repeat(2500), seed: 42 } }]] });
    check("a Ready poll with a settled cost: info.cost is that one; the expanded prompt is cut to 2000 characters; a seed the answer names is reported", !x.err && x.out.info.cost === 5 && x.out.info.expanded_prompt.length === 2000 && !("duration" in x.out.info) && x.out.seed === 42, x.err || short(x.out && { ...x.out.info, expanded_prompt: x.out.info.expanded_prompt.length, seed: x.out.seed }));

    x = await run(editReq({ prompt: "" }));
    check("a blank prompt is refused before any request", x.err === "FLUX 3 Image needs a prompt: say what to make or change. Nothing was sent." && x.calls.length === 0, x.err + " " + x.calls.length);
    x = await run(editReq({ prompt: "  \n\t " }));
    check("a prompt of white space alone is refused before any request", x.err === "FLUX 3 Image needs a prompt: say what to make or change. Nothing was sent." && x.calls.length === 0, x.err + " " + x.calls.length);
    x = await run(editReq({ prompt: undefined }));
    check("no prompt at all is refused before any request", !!x.err && /needs a prompt/.test(x.err) && x.calls.length === 0, x.err + " " + x.calls.length);

    const three = { references: [REF[0], REF[1], REF[2]], original: 1 };
    x = await run(editReq(three));
    check("Original + 2 references: images [crop, Original, ref, ref] in that order", !x.err && eq(tagsOf(x.body.images), ["CROP", "REF0", "REF1", "REF2"]), x.err || short(tagsOf(x.body.images)));
    const lay = refs.checkLayout(bfl.layout(editReq(three)), editReq(three));
    check("layout: crop images[0], Original [1], references [2], [3], numbered 1 to 4, max 10", eq(lay.pictures.map((p) => [p.role, p.field, p.n]), [["crop", "images[0]", 1], ["original", "images[1]", 2], ["reference", "images[2]", 3], ["reference", "images[3]", 4]]) && lay.max === 10 && !lay.drops, short(lay));
    const named = refs.resolveMarkers("the coat of {@ref:0} and the hat of {@ref:2} on the person", lay.pictures, V.refs.name);
    check("markers for the Original and the second reference layer become 'image 2' and 'image 4'", named.text === "the coat of image 2 and the hat of image 4 on the person" && !named.left.length, short(named));

    x = await run(editReq({ references: REF.slice(0, 9) }));
    check("the crop and 9 references (10 pictures) go out", !x.err && x.body.images.length === 10, x.err || String(x.body && x.body.images.length));
    x = await run(editReq({ references: REF.slice(0, 10) }));
    check("the crop and 10 references (11) are refused before any request", x.err === `BFL ${V.model} takes at most 10 pictures; this run has 11: hide reference layers or turn Original off.` && x.calls.length === 0, x.err + " " + x.calls.length);

    x = await run(editReq({ kind: "fill" }));
    check("a fill run (a variant set to input fill) is an edit here: the crop alone, no mask field", !x.err && eq(tagsOf(x.body.images), ["CROP"]) && !("mask" in x.body), x.err || short(Object.keys(x.body)));

    // ---- 3. the pictures' input rules ----------------------------------------------------------------------------------
    console.log("\n--- 3. 256 px, 16 MP, 20 MB ---");
    x = await run(editReq({ references: [SMALL] }));
    check("a 200 x 200 reference is refused before any request, by name", !!x.err && /^FLUX 3 Image takes pictures of at least 256 px a side; reference picture 1 is 200 . 200: use a larger layer\. Nothing was sent\.$/.test(x.err) && x.calls.length === 0, x.err + " " + x.calls.length);
    x = await run(editReq({ references: [SMALL], original: 1 }));
    check("a 200 x 200 Original is named the Original", !!x.err && /; the Original is 200 . 200: use a larger layer\./.test(x.err) && x.calls.length === 0, x.err);
    x = await run(editReq({ image: pngOf(608, 200, "THINCROP"), width: 608, height: 200 }));
    check("a crop 200 px high is refused with 'select a larger area'", !!x.err && /; the crop is 608 . 200: select a larger area or more context around it\. Nothing was sent\.$/.test(x.err) && x.calls.length === 0, x.err);
    x = await run(editReq({ image: pngOf(608, 200, "THINCROP"), width: 608, height: 200 }), { ctx: { resizePng: async () => pngOf(777, 256, "SCALED") } });
    check("the crop is never scaled, ctx.resizePng or not (the selection decides its size)", !!x.err && /the crop is 608 . 200/.test(x.err) && x.calls.length === 0, x.err);
    x = await run(editReq({ references: [REF[0], HUGE] }));
    check("a 5000 x 4000 reference (20 MP) is refused before any request", !!x.err && /^FLUX 3 Image takes pictures of at most 16 MP; reference picture 2 is 5000 . 4000 \(20\.0 MP\): use a smaller layer\. Nothing was sent\.$/.test(x.err) && x.calls.length === 0, x.err + " " + x.calls.length);
    x = await run(editReq({ references: [SIXTEEN] }));
    check("4000 x 4000 (16,000,000 px) goes", !x.err && eq(tagsOf(x.body.images), ["CROP", "SIXTEEN"]), x.err);
    x = await run(editReq({ references: [OVER16] }));
    check("4001 x 4000 is refused", !!x.err && /at most 16 MP; reference picture 1 is 4001 . 4000/.test(x.err) && x.calls.length === 0, x.err);
    x = await run(textReq({ references: [REF[0], SMALL] }), { verb: "generate" });
    check("Generate new checks its references the same way", !!x.err && /at least 256 px a side; reference picture 2 is 200 . 200/.test(x.err) && x.calls.length === 0, x.err);
    // with ctx.resizePng (the app's context) a reference outside the rules is scaled into them instead
    const RESIZED = [];
    const resizePng = async (b, to) => { RESIZED.push({ tag: tagOf(b), ...to }); return pngOf(to.width, to.height, "R-" + tagOf(b)); };
    x = await run(editReq({ references: [SMALL, HUGE], original: 1 }), { ctx: { resizePng } });
    const big = RESIZED.find((r) => r.tag === "HUGE"), small = RESIZED.find((r) => r.tag === "SMALL");
    check("with ctx.resizePng a 200 x 200 Original goes up to 256 x 256 and a 5000 x 4000 reference down under 16 MP, in their places", !x.err && eq(tagsOf(x.body.images), ["CROP", "R-SMALL", "R-HUGE"]) && small && small.width === 256 && small.height === 256 && big && big.width * big.height <= 16000000 && big.width * big.height > 15800000 && Math.abs(big.width / big.height - 1.25) < 0.002, x.err || short(RESIZED));
    x = await run(editReq({ references: [REF[0]] }), { ctx: { resizePng } });
    check("a reference inside the rules is not scaled", !x.err && RESIZED.length === 2, short(RESIZED));
    x = await run(editReq({ references: [pngOf(70000, 200, "STRIP")] }), { ctx: { resizePng } });
    check("a strip no scale fits (70000 x 200) is refused before any request", !!x.err && /which no scale fits/.test(x.err) && x.calls.length === 0, x.err);
    x = await run(editReq({ references: [HUGE] }), { ctx: { resizePng: async () => null } });
    check("a scale that fails (an undecodable picture) is refused, never sent unscaled", !!x.err && /could not be scaled/.test(x.err) && x.calls.length === 0, x.err);
    x = await run(editReq({ image: Buffer.alloc(0) }));
    check("an empty crop is refused (a dropped picture would renumber the rest)", !!x.err && /the crop is empty/.test(x.err) && x.calls.length === 0, x.err);
    x = await run(editReq({ references: [REF[0], null] }));
    check("a missing reference picture is refused, not left out", !!x.err && /reference picture 2 is empty/.test(x.err) && x.calls.length === 0, x.err);

    x = await run(editReq({ references: [BIG_OK, BIG] }));
    check("20,000,000 base64 characters go as PNG; an opaque picture past it goes as JPEG (quality 92) through ctx.toJpeg", !x.err && eq(tagsOf(x.body.images), ["CROP", "BIGOK", "J-BIG"]) && eq(JPEGS, [{ tag: "BIG", q: 92 }]) && x.body.images[1].length === 20000000, x.err || short({ images: x.body && tagsOf(x.body.images), jpegs: JPEGS }));
    x = await run(editReq({ references: [ALPHABIG] }));
    check("a transparent picture past 20 MB is refused before any request (it cannot go as JPEG)", !!x.err && /^FLUX 3 Image takes at most 20 MB per picture; reference picture 1 is 20\.0 MB as sent and has transparent pixels, so it cannot go as JPEG: use a smaller layer\. Nothing was sent\.$/.test(x.err) && x.calls.length === 0 && !JPEGS.length, x.err);
    x = await run(editReq({ references: [BIG] }), { ctx: { toJpeg: async () => jpegOf("J-BIG", 15000003) } });
    check("an opaque picture still past 20 MB as JPEG is refused", !!x.err && /^FLUX 3 Image takes at most 20 MB per picture; reference picture 1 is 20\.0 MB as sent even as JPEG: use a smaller layer\. Nothing was sent\.$/.test(x.err) && x.calls.length === 0, x.err);
    x = await run(editReq({ references: [BIG] }), { ctx: { opaque: undefined, toJpeg: undefined } });
    check("without ctx.opaque / ctx.toJpeg (a direct call) a picture past 20 MB is refused, never sent", !!x.err && /at most 20 MB per picture/.test(x.err) && x.calls.length === 0, x.err);

    // ---- 4. shape, seed, parameters, accepts ------------------------------------------------------------------------
    console.log("\n--- 4. shape, seed, parameters ---");
    x = await run(editReq({ width: 1000, height: 701 }));
    check("1000 x 701 (2 % off 7:5) sends 7:5 with fit stretch, no width or height", x.body && x.body.aspect_ratio === "7:5" && x.out && x.out.info.fit === "stretch" && x.out.info.aspect === "7:5" && !("width" in x.body) && !("height" in x.body), short(x.body && { aspect: x.body.aspect_ratio, info: x.out && x.out.info }));
    x = await run(editReq({ width: 1000, height: 617 }));
    check("1000 x 617 (no preset within 3 %) sends auto, fit null: the answer follows image 1, the crop", x.body && x.body.aspect_ratio === "auto" && x.out && x.out.info.fit === null && x.out.info.aspect === "auto", short(x.body && { aspect: x.body.aspect_ratio, info: x.out && x.out.info }));
    // A2: the preset the crop was widened to goes even when the 16 px rounding put the emitted size past 3 %
    x = await run(editReq({ width: 1000, height: 590, cropAspect: "16:9" }));
    check("1000 x 590 (4 % off its planned 16:9) sends 16:9 with fit stretch", x.body && x.body.aspect_ratio === "16:9" && x.out && x.out.info.fit === "stretch" && x.out.info.aspect === "16:9", short(x.body && { aspect: x.body.aspect_ratio, info: x.out && x.out.info }));
    x = await run(editReq({ width: 1000, height: 617, cropAspect: "1:1" }));
    check("a planned preset far from the size (1:1 for 1000 x 617) is not trusted: auto", x.body && x.body.aspect_ratio === "auto" && x.out && x.out.info.fit === null, short(x.body && x.body.aspect_ratio));
    x = await run(editReq({ width: 1000, height: 590, cropAspect: "17:9" }));
    check("a planned aspect that is no preset (17:9) is not sent: the 3 % rule decides (auto)", x.body && x.body.aspect_ratio === "auto", short(x.body && x.body.aspect_ratio));
    x = await run(editReq({ width: 1920, height: 1080, params: { safety_tolerance: 2, aspect_ratio: "1:1" } }));
    check("1920 x 1080 sends 16:9 / 2k; an aspect_ratio parameter does not override the shape", x.body && x.body.aspect_ratio === "16:9" && x.body.resolution === "2k", short(x.body && { aspect: x.body.aspect_ratio, resolution: x.body.resolution }));
    check("the tiers by area: 1024 x 768 1k, 1088 x 1088 1k (15 % slack), 1536 x 1024 2k, 2048 x 1024 2k, 2048 x 2048 2k, 4096 x 2304 4k, 5000 x 5000 4k", flux3._tierOf(1024, 768) === "1k" && flux3._tierOf(1088, 1088) === "1k" && flux3._tierOf(1536, 1024) === "2k" && flux3._tierOf(2048, 1024) === "2k" && flux3._tierOf(2048, 2048) === "2k" && flux3._tierOf(4096, 2304) === "4k" && flux3._tierOf(5000, 5000) === "4k", short([[1024, 768], [1088, 1088], [1536, 1024], [2048, 1024], [2048, 2048], [4096, 2304], [5000, 5000]].map(([w, h]) => flux3._tierOf(w, h))));
    const tiers = new Set();
    for (let w = 64; w <= 6144; w += 160) for (let h = 64; h <= 6144; h += 224) tiers.add(flux3._tierOf(w, h));
    check("no size ever gives 768sq or 1.5k", [...tiers].every((t) => ["1k", "2k", "4k"].includes(t)), short([...tiers]));
    for (const params of [{ ...defaults(V.settings), random_seed: true }, { ...defaults(V.settings), random_seed: false }]) {
        x = await run(editReq({ params, seed: 4294967295 }));
        if (!x.body || "seed" in x.body) break;
    }
    check("no seed field, random seed on or off, at 2^32 - 1 too", x.body && !("seed" in x.body), short(x.body && Object.keys(x.body)));
    x = await run(editReq({ params: { safety_tolerance: 4, grounding: true, steps: 30, guidance: 4, output_format: "png", endpoint: "flux-3-image", prompt_upsampling: true }, negative: "blurry" }));
    check("safety_tolerance 4 goes; steps, guidance, output_format, prompt_upsampling, endpoint and the negative stay out", x.body && x.body.safety_tolerance === 4 && eq(Object.keys(x.body), SCHEMA), short(x.body && Object.keys(x.body)));
    const wide = { ...V.options, accepts: ["mode", "seed", "safety_tolerance", "grounding", "steps", "guidance", "negative_prompt", "aspect_ratio", "width"] };
    x = await run(editReq({ options: wide, params: { safety_tolerance: 1, grounding: false, steps: 30, guidance: 4, aspect_ratio: "1:1", width: 99 }, negative: " blurry " }));
    check("even named in options.accepts, mode, seed, steps, guidance, negative_prompt and width stay out (FLUX 3 has none); grounding false goes as false", x.body && eq(Object.keys(x.body), SCHEMA) && x.body.grounding === false && x.body.safety_tolerance === 1 && x.body.aspect_ratio === "4:3", short(x.body));
    x = await run(editReq({ params: { safety_tolerance: 2, grounding: false } }));
    check("Grounding off on the shipped variant sends grounding false", x.body && x.body.grounding === false, short(x.body && x.body.grounding));
    x = await run(editReq({ options: { ...V.options, accepts: ["safety_tolerance"] } }));
    check("without grounding in options.accepts the body has no grounding field", x.body && !("grounding" in x.body) && x.body.safety_tolerance === 2, short(x.body && Object.keys(x.body)));
    x = await run(editReq({ options: { ...V.options, accepts: ["safety_tolerance", "grounding", "resolution"] }, params: { safety_tolerance: 2, grounding: true, resolution: "2k" } }));
    const rowRes = x.body && x.body.resolution;
    x = await run(editReq({ options: { ...V.options, accepts: ["safety_tolerance", "grounding", "resolution"] }, params: { safety_tolerance: 2, grounding: true, resolution: "1.5k" } }));
    const oddRes = x.body && x.body.resolution;
    x = await run(editReq({ params: { safety_tolerance: 2, grounding: true, resolution: "4k" } }));
    check("a resolution row overrides the tier only where accepted and only with 1k / 2k / 4k (1.5k falls back to the tier)", rowRes === "2k" && oddRes === "1k" && x.body && x.body.resolution === "1k", short([rowRes, oddRes, x.body && x.body.resolution]));
    x = await run(editReq({ options: { ...V.options, images_field: "input_images", max_images: 4 }, references: [REF[0]] }));
    check("options.images_field cannot rename the picture list (another field is a 422); max_images lowers the cap", x.body && eq(tagsOf(x.body.images), ["CROP", "REF0"]) && !("input_images" in x.body) && bfl.layout(editReq({ options: { ...V.options, images_field: "input_images", max_images: 4 } })).max === 4 && bfl.layout(editReq({ options: { ...V.options, images_field: "input_images" } })).pictures[0].field === "images[0]", short(x.body && Object.keys(x.body)));
    const sent = [];
    for (const v of [5, "3", 2.6, -1, "x", ""]) { x = await run(editReq({ params: { safety_tolerance: v, grounding: true } })); sent.push(x.body && ("safety_tolerance" in x.body ? x.body.safety_tolerance : "none")); }
    check("safety_tolerance goes as an integer 0 to 4: 5 -> 4, \"3\" -> 3, 2.6 -> 3, -1 -> 0; no number or empty -> left out (the API's 2)", eq(sent, [4, 3, 3, 0, "none", "none"]), short(sent));
    const ground = [];
    for (const v of ["on", "yes", "True", 1, "off", "no", "0", false]) { x = await run(editReq({ params: { safety_tolerance: 2, grounding: v } })); ground.push(x.body && x.body.grounding); }
    check("grounding from an agent: on / yes / True / 1 -> true, off / no / 0 / false -> false (a JSON boolean)", eq(ground, [true, true, true, true, false, false, false, false]), short(ground));
    x = await run(editReq({ params: { safety_tolerance: 2, grounding: "maybe" } }));
    check("grounding \"maybe\" is refused before any request", !!x.err && /Grounding is on or off/.test(x.err) && x.calls.length === 0, x.err);

    // ---- 5. Generate new ---------------------------------------------------------------------------------------------
    console.log("\n--- 5. Generate new ---");
    x = await run(textReq(), { verb: "generate" });
    check("no references: no images field, no mode, 1344 x 768 as 16:9 / 1k (never auto)", !x.err && eq(Object.keys(x.body), ["prompt", "aspect_ratio", "resolution", "safety_tolerance", "grounding"]) && x.body.aspect_ratio === "16:9" && x.body.resolution === "1k" && x.calls[0].url === `https://api.bfl.ai/v1/${V.model}`, x.err || short(x.body));
    check("its info: aspect 16:9, 1k, fit null", x.out && x.out.info.aspect === "16:9" && x.out.info.resolution === "1k" && x.out.info.fit === null && x.out.seed === undefined, short(x.out && x.out.info));
    x = await run(textReq({ aspect: "3:2" }), { verb: "generate" });
    check("a text request with aspect 3:2 sends 3:2", x.body && x.body.aspect_ratio === "3:2", short(x.body && x.body.aspect_ratio));
    x = await run(textReq({ width: 1000, height: 617 }), { verb: "generate" });
    check("a text size near no preset still sends the nearest one (3:2), never auto", x.body && x.body.aspect_ratio === "3:2", short(x.body && x.body.aspect_ratio));
    x = await run(textReq({ width: 4096, height: 2304 }), { verb: "generate" });
    check("4096 x 2304 (the 4096 size) sends 16:9 / 4k", x.body && x.body.aspect_ratio === "16:9" && x.body.resolution === "4k", short(x.body && [x.body.aspect_ratio, x.body.resolution]));
    x = await run(textReq({ width: 2048, height: 1152 }), { verb: "generate" });
    check("2048 x 1152 (the 2048 size) sends 2k", x.body && x.body.resolution === "2k", short(x.body && x.body.resolution));
    x = await run(textReq({ prompt: " " }), { verb: "generate" });
    check("a blank prompt for a new image is refused before any request", !!x.err && /needs a prompt/.test(x.err) && x.calls.length === 0, x.err);
    x = await run(textReq({ references: [REF[0], REF[1]] }), { verb: "generate" });
    check("two references: images [ref, ref] with no crop, aspect 16:9, no mode", !x.err && eq(tagsOf(x.body.images), ["REF0", "REF1"]) && x.body.aspect_ratio === "16:9" && !("mode" in x.body), x.err || short(x.body && Object.keys(x.body)));
    const tl = bfl.textLayout(textReq({ references: [REF[0], REF[1]] }));
    check("textLayout: images[0], [1], numbered from 1, max 10", eq(tl.pictures.map((p) => [p.role, p.field, p.n]), [["reference", "images[0]", 1], ["reference", "images[1]", 2]]) && tl.max === 10, short(tl));
    const tnamed = refs.resolveMarkers("the hat of {@ref:1} on a lighthouse keeper", tl.pictures, V.refs.name);
    check("a marker for the second reference layer of a new image becomes 'image 2'", tnamed.text === "the hat of image 2 on a lighthouse keeper" && !tnamed.left.length, short(tnamed));
    x = await run(textReq({ references: REF.slice(0, 10) }), { verb: "generate" });
    check("10 references for a new image go out", !x.err && x.body.images.length === 10, x.err || String(x.body && x.body.images.length));
    x = await run(textReq({ references: REF.slice(0, 11) }), { verb: "generate" });
    check("11 references for a new image are refused before any request", x.err === `BFL ${V.model} takes at most 10 reference pictures for a new image; this run has 11: hide reference layers.` && !x.calls.length, x.err);

    // ---- 6. the poll ------------------------------------------------------------------------------------------------
    console.log("\n--- 6. the poll ---");
    x = await run(editReq(), { pollingUrl: "https://evil.example.com/v1/get_result?id=t1" });
    check("a polling_url off bfl.ai is not followed: get_result on the API host instead, the key never leaves bfl.ai", !x.err && x.calls[1].url === "https://api.bfl.ai/v1/get_result?id=t1" && x.calls.every((c) => !("x-key" in c.headers) || new URL(c.url).hostname.endsWith("bfl.ai")), x.err || short(x.calls.map((c) => c.url)));
    x = await run(editReq(), { pollingUrl: "http://api.bfl.ai/v1/get_result?id=t1" });
    check("a plain-http polling_url is not followed either", !x.err && x.calls[1].url === "https://api.bfl.ai/v1/get_result?id=t1", x.err || short(x.calls[1]));
    x = await run(editReq(), { polls: [[200, { status: "Pending" }], [200, { status: "Reasoning" }], [200, { status: "Generating", progress: 0.5 }], [200, READY]] });
    check("Pending, Reasoning, Generating, Ready: four polls, then the download", !x.err && polled(x) === 4 && x.calls.length === 6 && x.out && x.out.seed === undefined, x.err || short(x.calls.map((c) => c.url)));
    x = await run(editReq(), { polls: [[422, { status: "Error", details: { error: "the image could not be decoded" } }]] });
    check("HTTP 422 with a status body (a failed task) ends the run with its details, no retry", x.err && /^BFL: Error /.test(x.err) && x.err.includes("could not be decoded") && polled(x) === 1, x.err);
    x = await run(editReq(), { polls: [[503, { status: "Error", details: { error: "generation failed" } }]] });
    check("HTTP 503 with a status body {status: Error} ends the run with its details, no retry", x.err && /^BFL: Error /.test(x.err) && x.err.includes("generation failed") && polled(x) === 1, x.err);
    x = await run(editReq(), { polls: [[503, { detail: "upstream" }], [429, { detail: "slow down" }], [200, READY]] });
    check("503 and 429 without a status body are retried (the job is paid for); then Ready", !x.err && x.out && polled(x) === 3, x.err || short(x.calls.map((c) => c.url)));
    x = await run(editReq(), { polls: [[503, { detail: "upstream" }]] });
    check("a gateway that stays broken gives up after five retries with the status", x.err && /^BFL poll: HTTP 503/.test(x.err) && polled(x) === 6, x.err);
    x = await run(editReq(), { polls: [[404, { detail: [{ msg: "Field required" }] }]] });
    check("a 404 without a status body (a validation answer) is not retried", x.err && /^BFL poll: HTTP 404/.test(x.err) && polled(x) === 1, x.err);
    x = await run(editReq(), { polls: [[200, { status: "Request Moderated", details: { "Moderation Reasons": ["Derivative Works Filter"] } }]] });
    check("Request Moderated: the prompt or an input picture was blocked, the same request fails again, with the reason", x.err && x.err.startsWith("BFL: Request Moderated (the prompt or an input picture was blocked; the same request fails again)") && x.err.includes("Derivative Works Filter"), x.err);
    x = await run(editReq(), { polls: [[200, { status: "Content Moderated", details: { "Moderation Reasons": ["NSFW"] } }]] });
    check("Content Moderated: the result was blocked, with the reason", x.err && x.err.startsWith("BFL: Content Moderated (the result was blocked)") && x.err.includes("NSFW"), x.err);
    x = await run(editReq(), { polls: [[200, { status: "Task not found" }]] });
    check("Task not found ends the run", x.err === "BFL: Task not found" && polled(x) === 1, x.err);
    x = await run(editReq(), { submit: () => json(422, { detail: [{ loc: ["body", "seed"], msg: "Extra inputs are not permitted", type: "extra_forbidden" }] }) });
    check("a refused submit (a strict schema's extra field) names the field in the error", x.err && x.err.startsWith(`BFL ${V.model}: `) && x.err.includes("extra_forbidden") && x.err.includes("seed"), x.err);
    x = await run(editReq(), { submit: () => json(403, { detail: "Not authenticated" }) });
    check("403 on the submit: the server's words", x.err === `BFL ${V.model}: Not authenticated`, x.err);
    x = await run(editReq(), { polls: [[0, "THROW"], [200, "HTML"], [200, READY]] });
    check("a dropped connection and a gateway page that is no JSON are retried (the job is paid for); then Ready", !x.err && x.out && polled(x) === 3, x.err || short(x.calls.map((c) => c.url)));
    x = await run(editReq(), { polls: [[0, "THROW"]] });
    check("a connection that stays down gives up after five retries", x.err && /^BFL poll: read ECONNRESET/.test(x.err) && polled(x) === 6, x.err);
    x = await run(editReq(), { downloadFails: 2 });
    check("a failed download of the result is tried again (twice)", !x.err && x.out && x.calls.filter((c) => c.url.includes("delivery")).length === 3, x.err);
    x = await run(editReq(), { downloadFails: 3 });
    check("a download that keeps failing ends the run", !!x.err && /socket hang up/.test(x.err), x.err);
    x = await run(editReq(), { submit: () => json(200, { id: "t1", polling_url: "https://api.eu1.bfl.ai/v1/get_result?id=t1", cost: null, input_mp: null }), polls: [[200, { ...READY, cost: null, result: { ...READY.result, seed: null } }]] });
    check("a cost, megapixels or seed given as null are left out, not reported as 0", !x.err && !("cost" in x.out.info) && !("input_mp" in x.out.info) && x.out.seed === undefined, x.err || short({ info: x.out && x.out.info, seed: x.out && x.out.seed }));

    // ---- 6b. one box in the request (item 28; the rows themselves in tools/boxes_test.js) ------------------------------
    console.log("\n--- 6b. one box in the request ---");
    // index.js applies the rows to the prompt after resolveNames, before body(): the same here, by hand
    const BOX = { id: "edit_1", kind: "new", rect: [0.25, 0.25, 0.75, 0.75], src: null, ref: null, desc: "make the door red" };
    // a stray app-side key in the params (as S1's selection_box row was) must not reach the body either
    let boxed = editReq({ params: { ...defaults(V.settings, V.fixed), selection_box: true }, boxes: [BOX] });
    boxed = { ...boxed, prompt: boxes.applyBoxes(boxed, bfl.layout(boxed)).prompt };
    x = await run(boxed);
    check("a request with one box: the prompt ends in the JSON rows, after the caption (the prompt is the box's desc: it goes as it is, the box says where)", !x.err && x.body.prompt === 'make the door red. In <ref_image_0>, the change goes in <edit_1> in the middle. Leave the rest of the picture as it is. [{"id":"edit_1","from":null,"src_bbox":null,"tgt_bbox":[250,250,750,750],"desc":"make the door red"}]', x.err || short(x.body && x.body.prompt));
    check("a key that is no API field never reaches the body, the keys are the schema's", !x.err && !("selection_box" in x.body) && eq(Object.keys(x.body), SCHEMA), short(x.body && Object.keys(x.body)));
    const plain = await run(editReq());
    const plainOff = await run(editReq({ boxes: [] }));
    check("a request without boxes (boxes []) sends the same body as one without the field", !plain.err && !plainOff.err && eq(plain.body, plainOff.body), short(plainOff.body && Object.keys(plainOff.body)));
    boxed = editReq({ references: [REF[0], REF[1]], original: 1, prompt: "put {@ref:1} here", boxes: [{ id: "edit_1", kind: "from", rect: [0.5, 0, 1, 0.5], src: [0, 0, 1, 1], ref: 1, desc: "put {@ref:1} here" }] });
    const lay2 = bfl.layout(boxed);
    const named2 = refs.resolveMarkers(boxed.prompt, lay2.pictures, boxed.refName);
    boxed = { ...boxed, prompt: boxes.applyBoxes({ ...boxed, prompt: named2.text }, lay2).prompt };
    x = await run(boxed);
    check("a from box with the Original: the reference is ref_image_2 (the crop 0, the Original 1), named 'image 3' in the desc", !x.err && x.body.prompt === 'put image 3 here. In <ref_image_0>, <ref_image_2> goes in <edit_1> at the top right. Leave the rest of the picture as it is. [{"id":"edit_1","from":"ref_image_2","src_bbox":[0,0,1000,1000],"tgt_bbox":[0,500,500,1000],"desc":"put image 3 here"}]' && eq(tagsOf(x.body.images), ["CROP", "REF0", "REF1"]), x.err || short(x.body && x.body.prompt));

    // ---- 7. every body against the schema -----------------------------------------------------------------------------
    console.log("\n--- 7. the schema ---");
    const off = [];
    for (const b of F3_BODIES) {
        const keys = Object.keys(b);
        if (!keys.every((k) => SCHEMA.includes(k))) off.push(`keys ${keys.join(",")}`);
        if (typeof b.prompt !== "string" || !/\S/.test(b.prompt)) off.push(`prompt ${short(b.prompt)}`);
        if ("images" in b && !(Array.isArray(b.images) && b.images.length >= 1 && b.images.length <= 10 && b.images.every((s) => typeof s === "string" && s.length <= 20000000 && !s.startsWith("data:")))) off.push("images");
        if (!["auto", ...flux3.FLUX3_ASPECTS].includes(b.aspect_ratio)) off.push(`aspect_ratio ${b.aspect_ratio}`);
        if (!["1k", "2k", "4k"].includes(b.resolution)) off.push(`resolution ${b.resolution}`);
        if ("safety_tolerance" in b && !(Number.isInteger(b.safety_tolerance) && b.safety_tolerance >= 0 && b.safety_tolerance <= 4)) off.push(`safety_tolerance ${b.safety_tolerance}`);
        if ("grounding" in b && typeof b.grounding !== "boolean") off.push(`grounding ${b.grounding}`);
    }
    check(`every FLUX 3 body this test sent (${F3_BODIES.length}) holds only the schema's fields, in range`, F3_BODIES.length >= 30 && !off.length, off.slice(0, 5).join(" | "));

    // ---- 8. FLUX.2 unchanged -----------------------------------------------------------------------------------------
    console.log("\n--- 8. FLUX.2 through the same adapter ---");
    const f2 = (extra = {}) => editReq({ model: "flux-2-pro", options: null, references: [REF[0]], params: { safety_tolerance: 2 }, ...extra });
    x = await run(f2(), { submit: () => json(200, { id: "t1", polling_url: "https://api.eu1.bfl.ai/v1/get_result?id=t1" }) });
    check("flux-2-pro still gets input_image, input_image_2, output_format png, seed, width, height", !x.err && x.calls[0].url === "https://api.bfl.ai/v1/flux-2-pro" && eq(Object.keys(x.body), ["prompt", "output_format", "seed", "input_image", "input_image_2", "width", "height", "safety_tolerance"]) && tagOfB64(x.body.input_image) === "CROP" && tagOfB64(x.body.input_image_2) === "REF0" && x.body.seed === 7, x.err || short(Object.keys(x.body || {})));
    check("FLUX.2 without a cost in the submit: info is the endpoint alone, the asked seed is reported", x.out && eq(x.out.info, { endpoint: "flux-2-pro" }) && x.out.seed === 7, short(x.out && { info: x.out.info, seed: x.out.seed }));
    x = await run(f2());
    check("FLUX.2 with a cost in the submit: info gains it and the megapixels, no FLUX 3 fields", x.out && eq(x.out.info, { endpoint: "flux-2-pro", cost: 4.8, input_mp: 0.79, output_mp: 1.04 }), short(x.out && x.out.info));
    x = await run(f2({ references: [SMALL], prompt: "" }));
    check("the FLUX 3 checks stay FLUX 3's: a 200 x 200 reference and an empty prompt still go to FLUX.2", !x.err && tagOfB64(x.body.input_image_2) === "SMALL" && x.body.prompt === "", x.err || short(x.body && Object.keys(x.body)));
    check("flux-2-pro's layout is FLUX.2's (input_image .., max 8)", bfl.layout(f2()).max === 8 && bfl.layout(f2()).pictures[0].field === "input_image", "");

    // ---- 9. FLUX 3 on fal (docs/PLAN_FLUX3.md "fal", docs/PLAN_0_1_38.md B4) ------------------------------------------
    console.log("\n--- 9. FLUX 3 on fal ---");
    const FV = RECIPE.providers.fal;
    const FAL14 = flux3.FLUX3_ASPECTS.filter((a) => a !== "9:21");
    check("the fal variant: edit-image, the text route by name, references on edit-image, 4 MP and fal's 14 presets as its limits, two rows (prompt expansion on)",
        !!FV && FV.model === "blackforestlabs/flux-3/edit-image" && FV.input === "edit" && FV.text.model === "blackforestlabs/flux-3/text-to-image" && FV.text.refs && FV.text.refs.model === "blackforestlabs/flux-3/edit-image"
        && FV.limits.pixels === 4000000 && eq(FV.limits.aspects, FAL14) && eq(FV.options.aspect_ratios, FAL14) && FV.limits.max === 2048
        && eq(FV.settings.map((s) => s.key), ["safety_tolerance", "enable_prompt_expansion"]) && FV.settings[1].spec[1].default === true && eq(FV.text.settings.map((s) => s.key), ["safety_tolerance", "enable_prompt_expansion"]),
        short(FV && { model: FV.model, text: FV.text, limits: FV.limits, settings: FV.settings.map((s) => s.key) }));
    // the schema fal serves (tools/refs/fal, fetched 2026-10-03 without a key): every body below is checked against it
    const falSchema = (id) => {
        const j = require(path.join(ROOT, "tools", "refs", "fal", `blackforestlabs_flux-3_${id}.json`));
        return Object.values(j.components.schemas).find((s) => s.properties && s.properties.prompt);
    };
    const FAL_SCHEMA = { "edit-image": falSchema("edit-image"), "text-to-image": falSchema("text-to-image") };
    check("the saved schemas: fal's 14 presets plus auto, no seed, num_images or negative_prompt on either route",
        ["edit-image", "text-to-image"].every((id) => eq(FAL_SCHEMA[id].properties.aspect_ratio.enum, ["auto", ...FAL14]) && !["seed", "num_images", "negative_prompt"].some((k) => k in FAL_SCHEMA[id].properties)),
        short(Object.keys(FAL_SCHEMA["edit-image"].properties)));
    const FAL_BODIES = [];
    const falEdit = (extra = {}) => ({
        provider: "fal", model: FV.model, kind: "edit", fields: null, options: FV.options, prompt: "make the door red", negative: "blurry", seed: 7,
        image: CROP, mask: MASK, maskAlpha: MASK, width: 1024, height: 768, references: [], original: 0, params: defaults(FV.settings, FV.fixed),
        refName: FV.refs.name, cropAspect: "4:3", ...extra,
    });
    const falText = (extra = {}) => ({
        provider: "fal", model: FV.text.model, kind: "text", fields: null, options: FV.options, prompt: "a lighthouse at dusk", negative: "blurry", seed: 7,
        image: null, mask: null, maskAlpha: null, width: 1344, height: 768, aspect: null, references: [], original: 0, params: defaults(FV.text.settings, FV.text.fixed),
        refName: FV.refs.name, ...extra,
    });
    const FAL_RESIZED = [];
    /** fal's queue as fal.js meets it: the submit, one status poll, the result, the CDN download. */
    async function runFal(req, { ctx = {} } = {}) {
        const calls = [];
        let body = null;
        FAL_RESIZED.length = 0;
        async function fetch(url, init = {}) {
            const u = new URL(String(url)), method = String(init.method || "GET").toUpperCase();
            calls.push({ method, url: String(url), auth: (init.headers || {}).Authorization });
            if (method === "POST") {
                body = JSON.parse(init.body);
                const base = `https://queue.fal.run${u.pathname}/requests/r1`;
                return json(200, { request_id: "r1", status: "IN_QUEUE", status_url: base + "/status", response_url: base });
            }
            if (u.pathname.endsWith("/status")) return json(200, { status: "COMPLETED" });
            if (u.hostname === "queue.fal.run") return json(200, { images: [{ url: "https://v3.fal.media/files/r1.png", content_type: "image/png", width: 1024, height: 768 }] });
            if (u.hostname === "v3.fal.media") return new Response(RESULT, { status: 200, headers: { "content-type": "image/png" } });
            return json(404, { detail: "no route " + u.pathname });
        }
        const context = {
            key: "test-fal-key", fetch, log: () => {}, sleep: async () => {},
            resizePng: async (b, to) => { FAL_RESIZED.push({ tag: tagOf(b), ...to }); return pngOf(to.width, to.height, "S-" + tagOf(b)); },
            ...ctx,
        };
        let out = null, err = null;
        try { out = await fal[req.kind === "text" ? "generate" : "edit"]({ ...req }, context); } catch (e) { err = String(e && e.message || e); }
        if (body) FAL_BODIES.push({ route: calls[0].url.replace(/^.*\/flux-3\//, ""), body });
        return { out, err, calls, body };
    }
    const tagsOfUri = (list) => (Array.isArray(list) ? list.map((s) => tagOfB64(String(s).replace(/^data:[^,]*,/, ""))) : list);

    x = await runFal(falEdit());
    check("an edit (1024 x 768 at 4:3) goes to edit-image with the crop, 1k, 4:3, the two rows; no seed, num_images or negative prompt",
        !x.err && x.calls[0].url === "https://queue.fal.run/blackforestlabs/flux-3/edit-image" && x.calls[0].auth === "Key test-fal-key"
        && eq(Object.keys(x.body).sort(), ["aspect_ratio", "enable_prompt_expansion", "image_urls", "output_format", "prompt", "resolution", "safety_tolerance"])
        && eq(tagsOfUri(x.body.image_urls), ["CROP"]) && x.body.resolution === "1k" && x.body.aspect_ratio === "4:3" && x.body.output_format === "png"
        && x.body.safety_tolerance === 2 && x.body.enable_prompt_expansion === true && x.body.prompt === "make the door red",
        x.err || short(x.body && { ...x.body, image_urls: tagsOfUri(x.body.image_urls) }));
    check("the answer: the seed null (none went), info with the tier, the preset and fit stretch for the stitch",
        x.out && x.out.seed === null && x.out.info.resolution === "1k" && x.out.info.aspect_ratio === "4:3" && x.out.info.fit === "stretch" && x.out.info.model === FV.model,
        short(x.out && { seed: x.out.seed, info: x.out.info }));
    x = await runFal(falEdit({ image: pngOf(2000, 2000, "CROP2K"), width: 2000, height: 2000, cropAspect: "1:1" }));
    check("the crop at the variant's cap (2000 x 2000, 4.0 MP) goes as 2k at 1:1", !x.err && x.body.resolution === "2k" && x.body.aspect_ratio === "1:1", x.err || short(x.body && [x.body.resolution, x.body.aspect_ratio]));
    x = await runFal(falEdit({ image: pngOf(1100, 500, "WIDE"), width: 1100, height: 500, cropAspect: null }));
    check("a crop near no preset (2.2:1) sends no aspect_ratio (fal's auto, image 1's shape) and no fit", !x.err && !("aspect_ratio" in x.body) && x.body.resolution === "1k" && x.out && !("fit" in x.out.info), x.err || short(x.body && Object.keys(x.body)));
    x = await runFal(falEdit({ image: pngOf(432, 1008, "TALL"), width: 432, height: 1008, cropAspect: "9:21" }));
    check("BFL's 9:21 is not fal's: a 9:21 crop planned so goes as auto, never 9:21", !x.err && !("aspect_ratio" in x.body), x.err || short(x.body && x.body.aspect_ratio));
    x = await runFal(falEdit({ image: pngOf(1000, 700, "NEAR"), width: 1000, height: 700, cropAspect: null }));
    check("a crop within 3 % of a preset (1000 x 700 against 7:5) sends that preset with fit stretch", !x.err && x.body.aspect_ratio === "7:5" && x.out.info.fit === "stretch", x.err || short(x.body && x.body.aspect_ratio));
    x = await runFal(falEdit({ references: [REF[0], REF[1]], original: 1 }));
    check("the Original and a reference go after the crop in image_urls (image 2, image 3)", !x.err && eq(tagsOfUri(x.body.image_urls), ["CROP", "REF0", "REF1"]), x.err || short(x.body && tagsOfUri(x.body.image_urls)));
    const fl = fal.layout(falEdit({ references: [REF[0], REF[1]], original: 1 }));
    check("fal.layout of the variant: the crop image_urls[0] (1), the Original [1] (2), the reference [2] (3), max 10", fl.max === 10 && eq(fl.pictures.map((p) => [p.role, p.field, p.n]), [["crop", "image_urls[0]", 1], ["original", "image_urls[1]", 2], ["reference", "image_urls[2]", 3]]), short(fl));

    // the picture rules: 256 px a side to 4 MP, references scaled, the crop refused
    x = await runFal(falEdit({ references: [SMALL, pngOf(3000, 2000, "SIXMP")], original: 1 }));
    const scaledOk = FAL_RESIZED.length === 2 && FAL_RESIZED[0].tag === "SMALL" && FAL_RESIZED[0].width === 256 && FAL_RESIZED[0].height === 256 && FAL_RESIZED[1].tag === "SIXMP" && FAL_RESIZED[1].width * FAL_RESIZED[1].height <= 4000000 && FAL_RESIZED[1].width * FAL_RESIZED[1].height > 3900000;
    check("a 200 x 200 Original is scaled up to 256 x 256, a 6 MP reference down under 4 MP; they go scaled, in place", !x.err && scaledOk && eq(tagsOfUri(x.body.image_urls), ["CROP", "S-SMALL", "S-SIXMP"]), x.err || short({ FAL_RESIZED, sent: x.body && tagsOfUri(x.body.image_urls) }));
    x = await runFal(falEdit({ references: [pngOf(2000, 2000, "FOURMP")] }));
    check("a reference of exactly 4,000,000 px goes as it is", !x.err && !FAL_RESIZED.length && eq(tagsOfUri(x.body.image_urls), ["CROP", "FOURMP"]), x.err || short(FAL_RESIZED));
    for (const [what, img, w, h, re] of [["over 4 MP (2048 x 2048)", pngOf(2048, 2048, "C"), 2048, 2048, /at most 4 MP; the crop is 2048 × 2048/], ["under 256 px a side", pngOf(200, 300, "C"), 200, 300, /at least 256 px a side; the crop is 200 × 300/]]) {
        x = await runFal(falEdit({ image: img, width: w, height: h, cropAspect: null }));
        check(`a crop ${what} is refused before anything is sent`, !!x.err && re.test(x.err) && /Nothing was sent/.test(x.err) && !x.calls.length, x.err || "sent");
    }
    x = await runFal(falEdit({ references: [pngOf(300, 20000, "STRIP")] }));
    check("a reference no scale fits (300 x 20000) is refused, named, nothing sent", !!x.err && /reference picture 1 is 300 × 20000, which no scale fits/.test(x.err) && !x.calls.length, x.err || "sent");
    x = await runFal(falEdit({ references: [HUGE] }), { ctx: { resizePng: undefined } });
    check("without ctx.resizePng an oversized reference is refused, not sent as it is", !!x.err && /could not be scaled/.test(x.err) && !x.calls.length, x.err || "sent");

    // the rows as an agent may give them
    const safeties = [];
    for (const v of ["3", 9, -1, 2.6, "abc"]) { x = await runFal(falEdit({ params: { safety_tolerance: v, enable_prompt_expansion: true } })); safeties.push(x.body ? (x.body.safety_tolerance === undefined ? "none" : x.body.safety_tolerance) : x.err); }
    check("safety tolerance as a whole number 0 to 4 (\"3\" -> 3, 9 -> 4, -1 -> 0, 2.6 -> 3); one that is no number stays home (fal's 2)", eq(safeties, [3, 4, 0, 3, "none"]), short(safeties));
    const expansions = [];
    for (const v of ["off", "on", 0, "yes", false]) { x = await runFal(falEdit({ params: { safety_tolerance: 2, enable_prompt_expansion: v } })); expansions.push(x.body ? x.body.enable_prompt_expansion : x.err); }
    check("prompt expansion as a JSON boolean (off / on / 0 / yes / false)", eq(expansions, [false, true, false, true, false]), short(expansions));
    x = await runFal(falEdit({ params: { safety_tolerance: 2, enable_prompt_expansion: "maybe" } }));
    check("a prompt expansion that is neither on nor off is refused, nothing sent", !!x.err && /Prompt expansion is on or off/.test(x.err) && !x.calls.length, x.err || "sent");

    // new images: the text route, or edit-image with the references alone
    x = await runFal(falText());
    check("a new image (1344 x 768) goes to text-to-image: no picture, the nearest of fal's presets (16:9), 1k, no negative prompt or seed",
        !x.err && x.calls[0].url === "https://queue.fal.run/blackforestlabs/flux-3/text-to-image" && !("image_urls" in x.body) && x.body.aspect_ratio === "16:9" && x.body.resolution === "1k"
        && !("negative_prompt" in x.body) && !("seed" in x.body) && !("num_images" in x.body) && x.out && x.out.seed === null && !("fit" in x.out.info),
        x.err || short(x.body));
    x = await runFal(falText({ aspect: "9:21", width: 768, height: 1792 }));
    check("an agent's 9:21 for a new image goes as fal's nearest, 1:2", !x.err && x.body.aspect_ratio === "1:2", x.err || short(x.body && x.body.aspect_ratio));
    const falTiers = [];
    for (const [w, h] of [[2048, 2048], [2048, 1152], [4096, 4096], [1024, 1024]]) { x = await runFal(falText({ width: w, height: h })); falTiers.push(x.body && x.body.resolution); }
    check("a new image's tier by area: 2048² 2k, 2048 x 1152 2k, 4096² 4k, 1024² 1k", eq(falTiers, ["2k", "2k", "4k", "1k"]), short(falTiers));
    const withRefsReq = falText({ model: FV.text.refs.model, references: [REF[0], REF[1]], options: { ...FV.options, ...(FV.text.refs.options || {}) } });
    const falTl = fal.textLayout(withRefsReq);
    check("textLayout of edit-image (a new image with references): image_urls[0..1], no drop, max 10", !falTl.drops && falTl.max === 10 && eq(falTl.pictures.map((p) => p.field), ["image_urls[0]", "image_urls[1]"]), short(falTl));
    check("textLayout of text-to-image drops references (a run with them goes to edit-image)", !!fal.textLayout(falText({ references: [REF[0]] })).drops, "");
    x = await runFal(withRefsReq);
    check("a new image with two references goes to edit-image with them alone, at the asked shape (16:9) and tier",
        !x.err && x.calls[0].url === "https://queue.fal.run/blackforestlabs/flux-3/edit-image" && eq(tagsOfUri(x.body.image_urls), ["REF0", "REF1"]) && x.body.aspect_ratio === "16:9" && x.body.resolution === "1k" && !("negative_prompt" in x.body),
        x.err || short(x.body && { ...x.body, image_urls: tagsOfUri(x.body.image_urls) }));

    // other fal recipes keep their shape
    x = await runFal({ ...falEdit(), model: "fal-ai/flux-2-pro/edit", options: { max_images: 9 }, params: {}, cropAspect: null });
    check("FLUX.2 pro on fal unchanged: image_size of the crop, num_images 1, the seed sent and reported, no resolution",
        !x.err && eq(x.body.image_size, { width: 1024, height: 768 }) && x.body.num_images === 1 && x.body.seed === 7 && !("resolution" in x.body) && !("aspect_ratio" in x.body) && x.out.seed === 7,
        x.err || short(x.body && Object.keys(x.body)));
    x = await runFal({ ...falEdit(), model: "fal-ai/recraft/v4/edit", options: { omit: ["seed"] }, params: {}, cropAspect: null });
    check("a fal route whose omit keeps the seed home reports none (it reported the editor's)", !x.err && !("seed" in x.body) && x.out.seed === null, x.err || short(x.out && x.out.seed));

    // every FLUX 3 body against the schema fal serves
    const falOff = [];
    for (const { route, body } of FAL_BODIES) {
        const S = FAL_SCHEMA[route];
        if (!S) continue;
        const props = S.properties, keys = Object.keys(body);
        for (const k of keys) if (!(k in props)) falOff.push(`${route}: ${k} not in the schema`);
        for (const k of S.required || []) if (!(k in body)) falOff.push(`${route}: ${k} missing`);
        for (const k of keys) {
            const e = props[k] && props[k].enum;
            if (e && !e.includes(body[k])) falOff.push(`${route}: ${k} ${body[k]} not in its enum`);
        }
        if ("safety_tolerance" in body && !(Number.isInteger(body.safety_tolerance) && body.safety_tolerance >= 0 && body.safety_tolerance <= 4)) falOff.push(`${route}: safety_tolerance ${body.safety_tolerance}`);
        if ("enable_prompt_expansion" in body && typeof body.enable_prompt_expansion !== "boolean") falOff.push(`${route}: enable_prompt_expansion ${body.enable_prompt_expansion}`);
        if ("image_urls" in body && !(Array.isArray(body.image_urls) && body.image_urls.length >= 1 && body.image_urls.length <= 10 && body.image_urls.every((s) => /^data:image\/png;base64,/.test(s)))) falOff.push(`${route}: image_urls`);
        if (typeof body.prompt !== "string" || !/\S/.test(body.prompt)) falOff.push(`${route}: prompt`);
    }
    const falRoutes = new Set(FAL_BODIES.filter((b) => FAL_SCHEMA[b.route]).map((b) => b.route));
    check(`every FLUX 3 body sent to fal (${FAL_BODIES.filter((b) => FAL_SCHEMA[b.route]).length}, both routes) holds only the saved schema's fields, required ones present, enums kept`, falRoutes.size === 2 && FAL_BODIES.length >= 20 && !falOff.length, falOff.slice(0, 5).join(" | ") || [...falRoutes].join(", "));

    // ---- 10. FLUX 3 on Oxen.ai (docs/PLAN_FLUX3.md "Oxen.ai", docs/PLAN_0_1_38.md B5) --------------------------------
    console.log("\n--- 10. FLUX 3 on Oxen.ai ---");
    const OV = RECIPE.providers.oxen;
    check("the oxen variant: flux-3-image for edits and new images, the last provider, BFL's 15 presets, 10 pictures of 256 px to 16 MP, the prompt as written, boxes, two rows (grounding on)",
        !!OV && OV.model === "flux-3-image" && OV.input === "edit" && RECIPE.providerIds[RECIPE.providerIds.length - 1] === "oxen" && OV.text.model === OV.model
        && eq(OV.options.accepts, ["aspect_ratio", "resolution", "safety_tolerance", "grounding"]) && OV.options.sizing === "flux3" && eq(OV.options.ratios, flux3.FLUX3_ASPECTS)
        && OV.options.max_images === 10 && OV.options.prompt === "as_written" && OV.options.min_side === 256 && OV.options.max_pixels === 16000000 && boxes.schemaOf({ options: OV.options }) === "flux3"
        && eq(OV.limits, V.limits) && eq(OV.settings.map((s) => s.key), ["safety_tolerance", "grounding"]) && OV.settings[1].spec[1].default === true
        && eq(OV.text.settings.map((s) => s.key), ["safety_tolerance", "grounding"]) && eq(OV.text.sizes, [1024, 2048, 4096]),
        short(OV && { model: OV.model, options: OV.options, settings: OV.settings.map((s) => s.key) }));
    // the model entry Oxen serves (tools/refs/oxen, fetched 2026-10-03 without a key): every body below is checked against it
    const OXEN_SCHEMA = require(path.join(ROOT, "tools", "refs", "oxen", "flux-3-image.json")).request_schema;
    const OP = OXEN_SCHEMA.properties;
    check("the saved schema: BFL's 15 presets plus auto, 768sq to 4k, grounding off by default, safety 0 to 4, ten pictures, no seed, negative prompt or count",
        eq(OP.aspect_ratio.enum, ["auto", ...flux3.FLUX3_ASPECTS]) && eq(OP.resolution.enum, ["768sq", "1k", "2k", "4k"]) && OP.grounding.default === false && eq(OP.safety_tolerance.enum, [0, 1, 2, 3, 4])
        && OP.input_image.maxItems === 10 && !["seed", "negative_prompt", "num_images"].some((k) => k in OP),
        short(Object.keys(OP)));
    const OXEN_BASE = "http://127.0.0.1:5561", OXEN_KEY = "test-oxen-0123456789ab";
    const OXEN_BODIES = [], OXEN_RESIZED = [];
    const oxenEdit = (extra = {}) => ({
        provider: "oxen", model: OV.model, kind: "edit", fields: null, options: OV.options, prompt: "make the door red", negative: "blurry", seed: 7,
        image: CROP, mask: MASK, maskAlpha: MASK, width: 1024, height: 768, references: [], original: 0, params: defaults(OV.settings, OV.fixed),
        refName: OV.refs.name, cropAspect: "4:3", ...extra,
    });
    const oxenText = (extra = {}) => ({
        provider: "oxen", model: OV.text.model, kind: "text", fields: null, options: OV.options, prompt: "a lighthouse at dusk", negative: "blurry", seed: 7,
        image: null, mask: null, maskAlpha: null, width: 1344, height: 768, aspect: null, references: [], original: 0, params: defaults(OV.text.settings, OV.text.fixed),
        refName: OV.refs.name, ...extra,
    });
    /** hub.oxen.ai as oxen.js meets it, at the loopback mock's address with a test key: one synchronous POST, b64_json back. */
    async function runOxen(req, { ctx = {} } = {}) {
        const calls = [];
        let body = null;
        OXEN_RESIZED.length = 0;
        async function fetch(url, init = {}) {
            const method = String(init.method || "GET").toUpperCase();
            calls.push({ method, url: String(url), auth: (init.headers || {}).Authorization });
            if (method === "POST") {
                body = JSON.parse(init.body);
                return json(200, { model: body.model, created: 1790926044, images: [{ b64_json: RESULT.toString("base64") }] });
            }
            return json(404, { error: { type: "resource_not_found", title: "no route", detail: "no route" } });
        }
        const context = {
            key: OXEN_KEY, base: OXEN_BASE, fetch, log: () => {}, sleep: async () => {},
            resizePng: async (b, to) => { OXEN_RESIZED.push({ tag: tagOf(b), ...to }); return pngOf(to.width, to.height, "S-" + tagOf(b)); },
            ...ctx,
        };
        let out = null, err = null;
        try { out = await oxen[req.kind === "text" ? "generate" : "edit"]({ ...req }, context); } catch (e) { err = String(e && e.message || e); }
        if (body) OXEN_BODIES.push({ route: calls[0].url.replace(/^.*\/images\//, ""), body });
        return { out, err, calls, body };
    }

    x = await runOxen(oxenEdit());
    check("an edit (1024 x 768 at 4:3) goes to /images/edit with the crop as a data URL, 1k, 4:3, the two rows typed, the prompt as written; no seed, negative prompt or mask",
        !x.err && x.calls.length === 1 && x.calls[0].url === OXEN_BASE + "/api/ai/images/edit" && x.calls[0].auth === "Bearer " + OXEN_KEY
        && eq(Object.keys(x.body).sort(), ["aspect_ratio", "grounding", "input_image", "model", "prompt", "resolution", "response_format", "safety_tolerance"])
        && x.body.model === "flux-3-image" && x.body.response_format === "b64_json" && eq(tagsOfUri(x.body.input_image), ["CROP"]) && /^data:image\/png;base64,/.test(x.body.input_image[0])
        && x.body.resolution === "1k" && x.body.aspect_ratio === "4:3" && x.body.safety_tolerance === 2 && x.body.grounding === true && x.body.prompt === "make the door red",
        x.err || short(x.body && { ...x.body, input_image: tagsOfUri(x.body.input_image) }));
    check("the answer: the seed null (none went), info with the route, the tier, the preset and fit stretch for the stitch",
        x.out && x.out.seed === null && x.out.info.route === "edit" && x.out.info.tier === "1k" && x.out.info.aspect_ratio === "4:3" && x.out.info.fit === "stretch" && tagOf(x.out.bytes) === "RESULT",
        short(x.out && { seed: x.out.seed, info: x.out.info }));
    x = await runOxen(oxenEdit({ image: pngOf(2048, 2048, "CROP2K"), width: 2048, height: 2048, cropAspect: "1:1" }));
    check("a 2048 x 2048 crop (4.19 MP, within the 15 % slack) goes as 2k at 1:1", !x.err && x.body.resolution === "2k" && x.body.aspect_ratio === "1:1", x.err || short(x.body && [x.body.resolution, x.body.aspect_ratio]));
    x = await runOxen(oxenEdit({ image: pngOf(1100, 500, "WIDE"), width: 1100, height: 500, cropAspect: null }));
    check("a crop near no preset (2.2:1) sends aspect_ratio auto (image 1's shape) and no fit", !x.err && x.body.aspect_ratio === "auto" && x.body.resolution === "1k" && x.out && !("fit" in x.out.info), x.err || short(x.body && x.body.aspect_ratio));
    x = await runOxen(oxenEdit({ image: pngOf(432, 1008, "TALL"), width: 432, height: 1008, cropAspect: "9:21" }));
    check("9:21 is one of Oxen's presets (not fal's): a crop planned so goes as 9:21 with fit stretch", !x.err && x.body.aspect_ratio === "9:21" && x.out.info.fit === "stretch", x.err || short(x.body && x.body.aspect_ratio));
    x = await runOxen(oxenEdit({ image: pngOf(1000, 700, "NEAR"), width: 1000, height: 700, cropAspect: null }));
    check("a crop within 3 % of a preset (1000 x 700 against 7:5) sends that preset with fit stretch", !x.err && x.body.aspect_ratio === "7:5" && x.out.info.fit === "stretch", x.err || short(x.body && x.body.aspect_ratio));
    x = await runOxen(oxenEdit({ references: [REF[0], REF[1]], original: 1 }));
    check("the Original and a reference go after the crop in input_image (image 2, image 3), the prompt still as written", !x.err && eq(tagsOfUri(x.body.input_image), ["CROP", "REF0", "REF1"]) && x.body.prompt === "make the door red", x.err || short(x.body && { pics: tagsOfUri(x.body.input_image), prompt: x.body.prompt }));
    const ol = oxen.layout(oxenEdit({ references: [REF[0], REF[1]], original: 1 }));
    check("oxen.layout of the variant: the crop input_image[0] (1), the Original [1] (2), the reference [2] (3), max 10", ol.max === 10 && eq(ol.pictures.map((p) => [p.role, p.field, p.n]), [["crop", "input_image[0]", 1], ["original", "input_image[1]", 2], ["reference", "input_image[2]", 3]]), short(ol));
    x = await runOxen(oxenEdit({ references: REF.slice(0, 10) }));
    check("eleven pictures (the crop and ten references) are refused before sending", !!x.err && /takes at most 10 pictures; this run has 11/.test(x.err) && !x.calls.length, x.err || "sent");

    // the picture rules: BFL's 256 px a side to 16 MP (Oxen states none), references scaled, the crop refused
    x = await runOxen(oxenEdit({ references: [SMALL, HUGE], original: 1 }));
    const oxScaled = OXEN_RESIZED.length === 2 && OXEN_RESIZED[0].tag === "SMALL" && OXEN_RESIZED[0].width === 256 && OXEN_RESIZED[0].height === 256 && OXEN_RESIZED[1].tag === "HUGE" && OXEN_RESIZED[1].width * OXEN_RESIZED[1].height <= 16000000 && OXEN_RESIZED[1].width * OXEN_RESIZED[1].height > 15800000;
    check("a 200 x 200 Original is scaled up to 256 x 256, a 20 MP reference down under 16 MP; they go scaled, in place", !x.err && oxScaled && eq(tagsOfUri(x.body.input_image), ["CROP", "S-SMALL", "S-HUGE"]), x.err || short({ OXEN_RESIZED, sent: x.body && tagsOfUri(x.body.input_image) }));
    x = await runOxen(oxenEdit({ references: [SIXTEEN] }));
    check("a reference of exactly 16,000,000 px goes as it is", !x.err && !OXEN_RESIZED.length && eq(tagsOfUri(x.body.input_image), ["CROP", "SIXTEEN"]), x.err || short(OXEN_RESIZED));
    for (const [what, img, w, h, re] of [["over 16 MP (4001 x 4000)", OVER16, 4001, 4000, /at most 16 MP; the crop is 4001 × 4000/], ["under 256 px a side", pngOf(200, 300, "C"), 200, 300, /at least 256 px a side; the crop is 200 × 300/]]) {
        x = await runOxen(oxenEdit({ image: img, width: w, height: h, cropAspect: null }));
        check(`a crop ${what} is refused before anything is sent`, !!x.err && re.test(x.err) && !x.calls.length, x.err || "sent");
    }
    x = await runOxen(oxenEdit({ references: [pngOf(260, 70000, "STRIP")] }));
    check("a reference no scale fits (260 x 70000) is refused, named, nothing sent", !!x.err && /the reference 1 is 260 × 70000, which no scale fits/.test(x.err) && !x.calls.length, x.err || "sent");
    x = await runOxen(oxenEdit({ references: [HUGE] }), { ctx: { resizePng: undefined } });
    check("without ctx.resizePng an oversized reference is refused, not sent as it is", !!x.err && /at most 16 MP; the reference 1 is 5000 × 4000/.test(x.err) && !x.calls.length, x.err || "sent");

    // the rows as an agent may give them, and the prompt
    const oxSafeties = [];
    for (const v of ["3", 9, -1, 2.6, "abc"]) { x = await runOxen(oxenEdit({ params: { safety_tolerance: v, grounding: true } })); oxSafeties.push(x.body ? (x.body.safety_tolerance === undefined ? "none" : x.body.safety_tolerance) : x.err); }
    check("safety tolerance as a whole number 0 to 4 (\"3\" -> 3, 9 -> 4, -1 -> 0, 2.6 -> 3); one that is no number stays home (Oxen's 2)", eq(oxSafeties, [3, 4, 0, 3, "none"]), short(oxSafeties));
    const groundings = [];
    for (const v of ["off", "on", 0, "yes", false]) { x = await runOxen(oxenEdit({ params: { safety_tolerance: 2, grounding: v } })); groundings.push(x.body ? x.body.grounding : x.err); }
    check("grounding as a JSON boolean (off / on / 0 / yes / false)", eq(groundings, [false, true, false, true, false]), short(groundings));
    x = await runOxen(oxenEdit({ params: { safety_tolerance: 2, grounding: "maybe" } }));
    check("a grounding that is neither on nor off is refused, nothing sent", !!x.err && /Grounding is on or off/.test(x.err) && !x.calls.length, x.err || "sent");
    x = await runOxen(oxenEdit({ prompt: "   " }));
    check("a blank prompt is refused before anything is sent (it goes as written)", !!x.err && /needs a prompt/.test(x.err) && !x.calls.length, x.err || "sent");

    // the boxes: index.js writes the rows after resolveNames, numbered by Oxen's layout; the prompt keeps them at its end
    let oxBoxed = oxenEdit({ references: [REF[0], REF[1]], original: 1, prompt: "put {@ref:1} here", boxes: [{ id: "edit_1", kind: "from", rect: [0.5, 0, 1, 0.5], src: [0, 0, 1, 1], ref: 1, desc: "put {@ref:1} here" }] });
    const oxLay = oxen.layout(oxBoxed);
    const oxNamed = refs.resolveMarkers(oxBoxed.prompt, oxLay.pictures, oxBoxed.refName);
    oxBoxed = { ...oxBoxed, prompt: boxes.applyBoxes({ ...oxBoxed, prompt: oxNamed.text }, oxLay).prompt };
    x = await runOxen(oxBoxed);
    check("a from box with the Original: the reference is ref_image_2 by Oxen's layout, named 'image 3', the rows at the prompt's end as on BFL", !x.err && x.body.prompt === 'put image 3 here. In <ref_image_0>, <ref_image_2> goes in <edit_1> at the top right. Leave the rest of the picture as it is. [{"id":"edit_1","from":"ref_image_2","src_bbox":[0,0,1000,1000],"tgt_bbox":[0,500,500,1000],"desc":"put image 3 here"}]' && eq(tagsOfUri(x.body.input_image), ["CROP", "REF0", "REF1"]), x.err || short(x.body && x.body.prompt));

    // new images: /images/generate, or /images/edit with the references alone
    x = await runOxen(oxenText());
    check("a new image (1344 x 768) goes to /images/generate: no picture, the nearest preset (16:9), 1k, the prompt as written, the rows; no negative prompt or seed",
        !x.err && x.calls[0].url === OXEN_BASE + "/api/ai/images/generate" && !("input_image" in x.body) && x.body.aspect_ratio === "16:9" && x.body.resolution === "1k" && x.body.prompt === "a lighthouse at dusk"
        && x.body.safety_tolerance === 2 && x.body.grounding === true && !("negative_prompt" in x.body) && !("seed" in x.body) && x.out && x.out.seed === null && !("fit" in x.out.info) && x.out.info.route === "generate",
        x.err || short(x.body));
    x = await runOxen(oxenText({ aspect: "9:21", width: 768, height: 1792 }));
    check("an agent's 9:21 for a new image goes as 9:21 (one of Oxen's presets)", !x.err && x.body.aspect_ratio === "9:21", x.err || short(x.body && x.body.aspect_ratio));
    const oxTiers = [];
    for (const [w, h] of [[2048, 2048], [2048, 1152], [4096, 4096], [1024, 1024]]) { x = await runOxen(oxenText({ width: w, height: h })); oxTiers.push(x.body && x.body.resolution); }
    check("a new image's tier by area: 2048² 2k, 2048 x 1152 2k, 4096² 4k, 1024² 1k (never 768sq)", eq(oxTiers, ["2k", "2k", "4k", "1k"]), short(oxTiers));
    const oxRefs = oxenText({ model: OV.text.refs.model || OV.text.model, references: [REF[0], REF[1]], options: { ...OV.options, ...(OV.text.refs.options || {}) } });
    const oxTl = oxen.textLayout(oxRefs);
    check("textLayout of a new image with references: input_image[0..1], no drop, max 10", !oxTl.drops && oxTl.max === 10 && eq(oxTl.pictures.map((p) => p.field), ["input_image[0]", "input_image[1]"]), short(oxTl));
    x = await runOxen(oxRefs);
    check("a new image with two references goes to /images/edit with them alone, at the asked shape (16:9) and tier, the prompt as written (no sentence about them)",
        !x.err && x.calls[0].url === OXEN_BASE + "/api/ai/images/edit" && eq(tagsOfUri(x.body.input_image), ["REF0", "REF1"]) && x.body.aspect_ratio === "16:9" && x.body.resolution === "1k" && x.body.prompt === "a lighthouse at dusk" && !("fit" in x.out.info),
        x.err || short(x.body && { ...x.body, input_image: tagsOfUri(x.body.input_image) }));

    // other Oxen recipes keep their shape; one whose schema takes no seed now reports none
    const f2ox = { ...oxenEdit(), model: "flux-2-pro", options: { accepts: ["aspect_ratio", "resolution", "seed", "output_format"], edit_aspect: "match_input_image", ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"], tiers: { "0.5 MP": 500000, "1 MP": 1000000, "2 MP": 2000000 }, tier_unit: "area", max_images: 8 }, params: { output_format: "png" }, cropAspect: null };
    x = await runOxen(f2ox);
    check("FLUX.2 pro on Oxen unchanged: the instruction around the prompt, match_input_image, its MP tier, the seed sent and reported, no fit",
        !x.err && x.body.prompt === "Edit image 1 and keep its size and framing. make the door red" && x.body.aspect_ratio === "match_input_image" && x.body.resolution === "1 MP" && x.body.seed === 7 && x.out.seed === 7 && !("fit" in x.out.info),
        x.err || short(x.body && { prompt: x.body.prompt, aspect: x.body.aspect_ratio, res: x.body.resolution, seed: x.out && x.out.seed }));
    x = await runOxen({ ...f2ox, model: "gpt-image-2", options: { accepts: ["quality", "resolution", "aspect_ratio", "output_format"], edit_aspect: "auto", tiers: { "1K": 1024, "2K": 2048, "4K": 4096 } }, params: { quality: "high", output_format: "png" } });
    check("an Oxen model whose schema takes no seed sends none and reports none (it reported the editor's)", !x.err && !("seed" in x.body) && x.out.seed === null, x.err || short(x.out && x.out.seed));

    // every FLUX 3 body against the schema Oxen serves (model and response_format are Oxen's envelope, not the model's)
    const oxOff = [];
    const oxFlux3 = OXEN_BODIES.filter((b) => b.body.model === "flux-3-image");
    for (const { route, body } of oxFlux3) {
        const { model: _model, response_format, ...rest } = body;
        if (response_format !== "b64_json") oxOff.push(`${route}: response_format ${response_format}`);
        for (const k of Object.keys(rest)) if (!(k in OP)) oxOff.push(`${route}: ${k} not in the schema`);
        for (const k of OXEN_SCHEMA.required || []) if (!(k in rest)) oxOff.push(`${route}: ${k} missing`);
        for (const k of Object.keys(rest)) {
            const e = OP[k] && OP[k].enum;
            if (e && !e.includes(rest[k])) oxOff.push(`${route}: ${k} ${rest[k]} not in its enum`);
        }
        if ("grounding" in rest && typeof rest.grounding !== "boolean") oxOff.push(`${route}: grounding ${rest.grounding}`);
        if ("input_image" in rest && !(Array.isArray(rest.input_image) && rest.input_image.length >= 1 && rest.input_image.length <= 10 && rest.input_image.every((s) => /^data:image\/png;base64,/.test(s)))) oxOff.push(`${route}: input_image`);
        if (typeof rest.prompt !== "string" || !/\S/.test(rest.prompt)) oxOff.push(`${route}: prompt`);
    }
    const oxRoutes = new Set(oxFlux3.map((b) => b.route));
    check(`every FLUX 3 body sent to Oxen (${oxFlux3.length}, both routes) holds only the saved schema's fields, required ones present, enums kept`, oxRoutes.size === 2 && oxFlux3.length >= 20 && !oxOff.length, oxOff.slice(0, 5).join(" | ") || [...oxRoutes].join(", "));

    // ---- 11. FLUX 3 on WaveSpeedAI (docs/PLAN_FLUX3.md "WaveSpeed", docs/PLAN_0_1_38.md B6) ----------------------------
    console.log("\n--- 11. FLUX 3 on WaveSpeedAI ---");
    const WV = RECIPE.providers.wavespeed;
    const WS14 = flux3.FLUX3_ASPECTS.filter((a) => a !== "9:21");
    const ids = RECIPE.providerIds;
    check("the wavespeed variant: image-edit (renamed from /edit since the research), the text route by name, references on image-edit, after fal and before OpenRouter, 4 MP and the 14 presets, one row (prompt expansion on)",
        !!WV && WV.model === "black-forest-labs/flux-3/image-edit" && WV.input === "edit" && WV.text.model === "black-forest-labs/flux-3/text-to-image" && WV.text.refs && WV.text.refs.model === WV.model
        && ids.indexOf("wavespeed") === ids.indexOf("fal") + 1 && ids.indexOf("openrouter") === ids.indexOf("wavespeed") + 1
        && WV.options.sizing === "flux3" && eq(WV.options.aspect_ratios, WS14) && WV.options.max_images === 10 && WV.options.min_side === 256 && WV.options.max_pixels === 4000000 && WV.options.negative === false
        && eq(WV.options.accepts, ["aspect_ratio", "resolution", "output_format", "enable_prompt_expansion"]) && boxes.schemaOf({ options: WV.options }) === "flux3"
        && WV.limits.pixels === 4000000 && eq(WV.limits.aspects, WS14) && eq(WV.settings.map((s) => s.key), ["enable_prompt_expansion"]) && WV.settings[0].spec[1].default === true
        && eq(WV.text.settings.map((s) => s.key), ["enable_prompt_expansion"]) && eq(WV.text.sizes, [1024, 2048, 4096]),
        short(WV && { model: WV.model, text: WV.text.model, ids, options: WV.options, limits: WV.limits }));
    // the schemas WaveSpeed serves (tools/refs/wavespeed, fetched 2026-10-03 without a key): every body below is checked against them
    const wsSchema = (id) => require(path.join(ROOT, "tools", "refs", "wavespeed", `black-forest-labs_flux-3_${id}.json`)).components.schemas.Input;
    const WS_SCHEMA = { "image-edit": wsSchema("image-edit"), "text-to-image": wsSchema("text-to-image") };
    check("the saved schemas: the 14 presets (no auto, no 9:21), 1k to 4k, a strict input, no seed, safety, grounding or negative prompt; image-edit takes 1 to 10 images, text-to-image none",
        ["image-edit", "text-to-image"].every((id) => eq(WS_SCHEMA[id].properties.aspect_ratio.enum, WS14) && eq(WS_SCHEMA[id].properties.resolution.enum, ["1k", "2k", "4k"]) && WS_SCHEMA[id].additionalProperties === false
            && !["seed", "safety_tolerance", "grounding", "negative_prompt"].some((k) => k in WS_SCHEMA[id].properties))
        && WS_SCHEMA["image-edit"].properties.images.maxItems === 10 && eq(WS_SCHEMA["image-edit"].required, ["prompt", "images"]) && !("images" in WS_SCHEMA["text-to-image"].properties),
        short(Object.keys(WS_SCHEMA["image-edit"].properties)));
    const WS_BODIES = [], WS_RESIZED = [];
    const wsEdit = (extra = {}) => ({
        provider: "wavespeed", model: WV.model, kind: "edit", fields: null, options: WV.options, prompt: "make the door red", negative: "blurry", seed: 7,
        image: CROP, mask: MASK, maskAlpha: MASK, width: 1024, height: 768, references: [], original: 0, params: defaults(WV.settings, WV.fixed),
        refName: WV.refs.name, cropAspect: "4:3", ...extra,
    });
    const wsText = (extra = {}) => ({
        provider: "wavespeed", model: WV.text.model, kind: "text", fields: null, options: WV.options, prompt: "a lighthouse at dusk", negative: "blurry", seed: 7,
        image: null, mask: null, maskAlpha: null, width: 1344, height: 768, aspect: null, references: [], original: 0, params: defaults(WV.text.settings, WV.text.fixed),
        refName: WV.refs.name, ...extra,
    });
    /** api.wavespeed.ai as wavespeed.js meets it: an upload ticket and a presigned PUT per picture, the submit (done at once), the CDN download. */
    async function runWs(req, { ctx = {} } = {}) {
        const calls = [], stored = new Map();
        let body = null, route = null, k = 0;
        WS_RESIZED.length = 0;
        async function fetch(url, init = {}) {
            const u = new URL(String(url)), method = String(init.method || "GET").toUpperCase();
            calls.push({ method, url: String(url), auth: (init.headers || {}).Authorization });
            if (method === "POST" && u.pathname === "/api/v3/media/uploads") {
                const n = ++k;
                return json(200, { code: 200, data: { download_url: `https://cdn.wavespeed.test/u${n}`, upload: { url: `https://put.wavespeed.test/u${n}`, method: "PUT" } } });
            }
            if (method === "PUT" && u.hostname === "put.wavespeed.test") { stored.set(`https://cdn.wavespeed.test${u.pathname}`, tagOf(Buffer.from(init.body))); return new Response(null, { status: 200 }); }
            if (method === "POST" && u.hostname === "api.wavespeed.ai") {
                body = JSON.parse(init.body);
                route = u.pathname.replace(/^\/api\/v3\//, "");
                return json(200, { code: 200, data: { id: "p1", status: "completed", urls: { get: "https://api.wavespeed.ai/api/v3/predictions/p1/result" }, outputs: ["https://cdn.wavespeed.test/out.png"], timings: { inference: 900 } } });
            }
            if (u.hostname === "cdn.wavespeed.test") return new Response(RESULT, { status: 200, headers: { "content-type": "image/png" } });
            return json(404, { code: 404, message: "no route " + u.pathname });
        }
        const context = {
            key: "test-ws-key", fetch, log: () => {},
            resizePng: async (b, to) => { WS_RESIZED.push({ tag: tagOf(b), ...to }); return pngOf(to.width, to.height, "S-" + tagOf(b)); },
            ...ctx,
        };
        let out = null, err = null;
        try { out = await wavespeed[req.kind === "text" ? "generate" : "edit"]({ ...req }, context); } catch (e) { err = String(e && e.message || e); }
        if (body) WS_BODIES.push({ route: route.replace(/^.*\/flux-3\//, ""), body });
        const tags = body && Array.isArray(body.images) ? body.images.map((dl) => stored.get(dl) || dl) : null;
        return { out, err, calls, body, route, tags };
    }

    x = await runWs(wsEdit());
    check("an edit (1024 x 768 at 4:3) goes to image-edit with the crop uploaded, 1k, 4:3, expansion on, png, the prompt as written; no seed, negative prompt, safety or grounding",
        !x.err && x.route === "black-forest-labs/flux-3/image-edit" && x.calls.find((c) => c.url.endsWith("/flux-3/image-edit")).auth === "Bearer test-ws-key"
        && eq(Object.keys(x.body).sort(), ["aspect_ratio", "enable_prompt_expansion", "images", "output_format", "prompt", "resolution"])
        && eq(x.tags, ["CROP"]) && x.body.resolution === "1k" && x.body.aspect_ratio === "4:3" && x.body.enable_prompt_expansion === true && x.body.output_format === "png" && x.body.prompt === "make the door red",
        x.err || short({ route: x.route, body: x.body && { ...x.body, images: x.tags } }));
    check("the answer: no seed (none went), info with the tier, the preset and fit stretch for the stitch",
        x.out && x.out.seed == null && x.out.info.resolution === "1k" && x.out.info.aspect_ratio === "4:3" && x.out.info.fit === "stretch" && x.out.info.model === WV.model && tagOf(x.out.bytes) === "RESULT",
        short(x.out && { seed: x.out.seed, info: x.out.info }));
    x = await runWs(wsEdit({ image: pngOf(2000, 2000, "CROP2K"), width: 2000, height: 2000, cropAspect: "1:1" }));
    check("the crop at the variant's cap (2000 x 2000, 4.0 MP) goes as 2k at 1:1", !x.err && x.body.resolution === "2k" && x.body.aspect_ratio === "1:1", x.err || short(x.body && [x.body.resolution, x.body.aspect_ratio]));
    x = await runWs(wsEdit({ image: pngOf(1100, 500, "WIDE"), width: 1100, height: 500, cropAspect: null }));
    check("a crop near no preset (2.2:1) sends no aspect_ratio (the route follows image 1) and no fit", !x.err && !("aspect_ratio" in x.body) && x.body.resolution === "1k" && x.out && !("fit" in x.out.info), x.err || short(x.body && Object.keys(x.body)));
    x = await runWs(wsEdit({ image: pngOf(432, 1008, "TALL"), width: 432, height: 1008, cropAspect: "9:21" }));
    check("BFL's 9:21 is not WaveSpeed's: a 9:21 crop planned so goes without an aspect_ratio, never 9:21", !x.err && !("aspect_ratio" in x.body), x.err || short(x.body && x.body.aspect_ratio));
    x = await runWs(wsEdit({ image: pngOf(1000, 700, "NEAR"), width: 1000, height: 700, cropAspect: null }));
    check("a crop within 3 % of a preset (1000 x 700 against 7:5) sends that preset with fit stretch", !x.err && x.body.aspect_ratio === "7:5" && x.out.info.fit === "stretch", x.err || short(x.body && x.body.aspect_ratio));
    x = await runWs(wsEdit({ references: [REF[0], REF[1]], original: 1 }));
    check("the Original and a reference go after the crop in images (image 2, image 3)", !x.err && eq(x.tags, ["CROP", "REF0", "REF1"]), x.err || short(x.tags));
    const wl = wavespeed.layout(wsEdit({ references: [REF[0], REF[1]], original: 1 }));
    check("wavespeed.layout of the variant: the crop images[0] (1), the Original [1] (2), the reference [2] (3), max 10", wl.max === 10 && eq(wl.pictures.map((p) => [p.role, p.field, p.n]), [["crop", "images[0]", 1], ["original", "images[1]", 2], ["reference", "images[2]", 3]]), short(wl));
    x = await runWs(wsEdit({ references: REF.slice(0, 10) }));
    check("eleven pictures (the crop and ten references) are refused before any upload", !!x.err && /takes at most 10 pictures; this run has 11/.test(x.err) && !x.calls.length, x.err || "sent");

    // the picture rules: 256 px a side to 4 MP, references scaled, the crop refused, all before the first upload
    x = await runWs(wsEdit({ references: [SMALL, pngOf(3000, 2000, "SIXMP")], original: 1 }));
    const wsScaled = WS_RESIZED.length === 2 && WS_RESIZED[0].tag === "SMALL" && WS_RESIZED[0].width === 256 && WS_RESIZED[0].height === 256 && WS_RESIZED[1].tag === "SIXMP" && WS_RESIZED[1].width * WS_RESIZED[1].height <= 4000000 && WS_RESIZED[1].width * WS_RESIZED[1].height > 3900000;
    check("a 200 x 200 Original is scaled up to 256 x 256, a 6 MP reference down under 4 MP; they go scaled, in place", !x.err && wsScaled && eq(x.tags, ["CROP", "S-SMALL", "S-SIXMP"]), x.err || short({ WS_RESIZED, sent: x.tags }));
    x = await runWs(wsEdit({ references: [pngOf(2000, 2000, "FOURMP")] }));
    check("a reference of exactly 4,000,000 px goes as it is", !x.err && !WS_RESIZED.length && eq(x.tags, ["CROP", "FOURMP"]), x.err || short(WS_RESIZED));
    for (const [what, img, w, h, re] of [["over 4 MP (2048 x 2048)", pngOf(2048, 2048, "C"), 2048, 2048, /at most 4 MP; the crop is 2048 × 2048/], ["under 256 px a side", pngOf(200, 300, "C"), 200, 300, /at least 256 px a side; the crop is 200 × 300/]]) {
        x = await runWs(wsEdit({ image: img, width: w, height: h, cropAspect: null }));
        check(`a crop ${what} is refused before any upload`, !!x.err && re.test(x.err) && !x.calls.length, x.err || "sent");
    }
    x = await runWs(wsEdit({ references: [pngOf(300, 20000, "STRIP")] }));
    check("a reference no scale fits (300 x 20000) is refused, named, nothing uploaded", !!x.err && /the reference 1 is 300 × 20000, which no scale fits/.test(x.err) && !x.calls.length, x.err || "sent");
    x = await runWs(wsEdit({ references: [HUGE] }), { ctx: { resizePng: undefined } });
    check("without ctx.resizePng an oversized reference is refused, not sent as it is", !!x.err && /at most 4 MP; the reference 1 is 5000 × 4000/.test(x.err) && !x.calls.length, x.err || "sent");

    // the row as an agent may give it, and the prompt
    const wsExp = [];
    for (const v of ["off", "on", 0, "yes", false]) { x = await runWs(wsEdit({ params: { enable_prompt_expansion: v } })); wsExp.push(x.body ? x.body.enable_prompt_expansion : x.err); }
    check("prompt expansion as a JSON boolean (off / on / 0 / yes / false)", eq(wsExp, [false, true, false, true, false]), short(wsExp));
    x = await runWs(wsEdit({ params: { enable_prompt_expansion: "maybe" } }));
    check("a prompt expansion that is neither on nor off is refused, nothing uploaded", !!x.err && /Prompt expansion is on or off/.test(x.err) && !x.calls.some((c) => c.method === "POST" && c.url.includes("/flux-3/")), x.err || "sent");
    x = await runWs(wsEdit({ prompt: "  " }));
    check("a blank prompt is refused before any upload (the schema's minLength 1)", !!x.err && /needs a prompt/.test(x.err) && !x.calls.length, x.err || "sent");

    // the boxes: index.js writes the rows after resolveNames, numbered by WaveSpeed's layout
    let wsBoxed = wsEdit({ references: [REF[0], REF[1]], original: 1, prompt: "put {@ref:1} here", boxes: [{ id: "edit_1", kind: "from", rect: [0.5, 0, 1, 0.5], src: [0, 0, 1, 1], ref: 1, desc: "put {@ref:1} here" }] });
    const wsLay = wavespeed.layout(wsBoxed);
    const wsNamed = refs.resolveMarkers(wsBoxed.prompt, wsLay.pictures, wsBoxed.refName);
    wsBoxed = { ...wsBoxed, prompt: boxes.applyBoxes({ ...wsBoxed, prompt: wsNamed.text }, wsLay).prompt };
    x = await runWs(wsBoxed);
    check("a from box with the Original: the reference is ref_image_2 by WaveSpeed's layout, named 'image 3', the rows at the prompt's end as on BFL", !x.err && x.body.prompt === 'put image 3 here. In <ref_image_0>, <ref_image_2> goes in <edit_1> at the top right. Leave the rest of the picture as it is. [{"id":"edit_1","from":"ref_image_2","src_bbox":[0,0,1000,1000],"tgt_bbox":[0,500,500,1000],"desc":"put image 3 here"}]' && eq(x.tags, ["CROP", "REF0", "REF1"]), x.err || short(x.body && x.body.prompt));

    // new images: the text route, or image-edit with the references alone
    x = await runWs(wsText());
    check("a new image (1344 x 768) goes to text-to-image: no picture, the nearest of the 14 (16:9), 1k, expansion on; no negative prompt or seed",
        !x.err && x.route === "black-forest-labs/flux-3/text-to-image" && !("images" in x.body) && x.body.aspect_ratio === "16:9" && x.body.resolution === "1k" && x.body.enable_prompt_expansion === true
        && !("negative_prompt" in x.body) && !("seed" in x.body) && x.out && x.out.seed == null && !("fit" in x.out.info) && !x.calls.some((c) => c.url.includes("/media/")),
        x.err || short(x.body));
    x = await runWs(wsText({ aspect: "9:21", width: 768, height: 1792 }));
    check("an agent's 9:21 for a new image goes as WaveSpeed's nearest, 1:2", !x.err && x.body.aspect_ratio === "1:2", x.err || short(x.body && x.body.aspect_ratio));
    const wsTiers = [];
    for (const [w, h] of [[2048, 2048], [2048, 1152], [4096, 4096], [1024, 1024]]) { x = await runWs(wsText({ width: w, height: h })); wsTiers.push(x.body && x.body.resolution); }
    check("a new image's tier by area: 2048² 2k, 2048 x 1152 2k, 4096² 4k, 1024² 1k", eq(wsTiers, ["2k", "2k", "4k", "1k"]), short(wsTiers));
    const wsRefs = wsText({ model: WV.text.refs.model, references: [REF[0], REF[1]], options: { ...WV.options, ...(WV.text.refs.options || {}) } });
    const wsTl = wavespeed.textLayout(wsRefs);
    check("textLayout of image-edit (a new image with references): images[0..1], no drop, max 10", !wsTl.drops && wsTl.max === 10 && eq(wsTl.pictures.map((p) => p.field), ["images[0]", "images[1]"]), short(wsTl));
    check("textLayout of text-to-image drops references (a run with them goes to image-edit)", !!wavespeed.textLayout(wsText({ references: [REF[0]] })).drops, "");
    x = await runWs(wsRefs);
    check("a new image with two references goes to image-edit with them alone, at the asked shape (16:9) and tier, no fit",
        !x.err && x.route === "black-forest-labs/flux-3/image-edit" && eq(x.tags, ["REF0", "REF1"]) && x.body.aspect_ratio === "16:9" && x.body.resolution === "1k" && !("fit" in x.out.info),
        x.err || short(x.body && { ...x.body, images: x.tags }));

    // other WaveSpeed recipes keep their shape
    x = await runWs({ ...wsEdit(), model: "google/nano-banana-2/edit", options: { aspect_ratios: ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"], max_images: 14 }, params: {}, cropAspect: null, image: pngOf(1000, 700, "NB"), width: 1000, height: 700 });
    check("Nano Banana 2 on WaveSpeed unchanged: the closest preset always, the seed sent and reported, no resolution or fit",
        !x.err && x.body.aspect_ratio === "3:2" && x.body.seed === 7 && x.out.seed === 7 && !("resolution" in x.body) && !("fit" in x.out.info) && eq(x.tags, ["NB"]),
        x.err || short(x.body && { aspect: x.body.aspect_ratio, seed: x.body.seed, res: x.body.resolution }));

    // every FLUX 3 body against the schema WaveSpeed serves (strict: additionalProperties false)
    const wsOff = [];
    for (const { route, body } of WS_BODIES) {
        const S = WS_SCHEMA[route];
        if (!S) continue;
        const props = S.properties, keys = Object.keys(body);
        for (const k of keys) if (!(k in props)) wsOff.push(`${route}: ${k} not in the schema`);
        for (const k of S.required || []) if (!(k in body)) wsOff.push(`${route}: ${k} missing`);
        for (const k of keys) {
            const e = props[k] && props[k].enum;
            if (e && !e.includes(body[k])) wsOff.push(`${route}: ${k} ${body[k]} not in its enum`);
        }
        if ("enable_prompt_expansion" in body && typeof body.enable_prompt_expansion !== "boolean") wsOff.push(`${route}: enable_prompt_expansion ${body.enable_prompt_expansion}`);
        if ("images" in body && !(Array.isArray(body.images) && body.images.length >= 1 && body.images.length <= 10 && body.images.every((s) => /^https:\/\//.test(s)))) wsOff.push(`${route}: images`);
        if (typeof body.prompt !== "string" || !/\S/.test(body.prompt)) wsOff.push(`${route}: prompt`);
    }
    const wsRoutes = new Set(WS_BODIES.filter((b) => WS_SCHEMA[b.route]).map((b) => b.route));
    check(`every FLUX 3 body sent to WaveSpeed (${WS_BODIES.filter((b) => WS_SCHEMA[b.route]).length}, both routes) holds only the saved schema's fields, required ones present, enums kept`, wsRoutes.size === 2 && WS_BODIES.length >= 20 && !wsOff.length, wsOff.slice(0, 5).join(" | ") || [...wsRoutes].join(", "));

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
