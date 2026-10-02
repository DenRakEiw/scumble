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
    check("the bfl variant, the home provider, an edit route, named FLUX 3 Image; OpenRouter and Comfy Router after it", eq(RECIPE.providerIds, ["bfl", "openrouter", "comfyrouter"]) && RECIPE.default === "bfl" && V.input === "edit" && V.edit === true && RECIPE.name === "FLUX 3 Image", short({ ids: RECIPE.providerIds, def: RECIPE.default, input: V.input, name: RECIPE.name }));
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

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
