// The BytePlus ModelArk adapter (electron/main/providers/ark.js), its three recipe variants (Seedream 5.0 pro and lite,
// and Seedream 5.5 in early access, section 8: the Background row, ten pictures, the range, the access hint; its facts
// are BytePlus's preview docs as the user passed them on 2026-11-08) and its wiring in providers/index.js and
// recipes.js, in plain Node, no Electron and no key:
//   node tools/ark_test.js
// A scripted fetch plays both ModelArk hosts and the loopback mock (POST /api/v3/images/generations) and a result
// host for a url answer (GET /result/...); ctx.sleep records its waits instead of waiting. Every call of the whole
// run is recorded with all its headers, and the last checks say that no call carried a header beyond the two the API
// reference names, and that neither key is in any error of the run. The facts the checks rest on are BytePlus's
// ModelArk docs as read on 2026-09-19 (the image generation API reference 1541523, the error codes 1299023, the model
// list 1330310, the regions 2191806) and one live 401 of a request without a valid key; nothing here talks to the
// live API.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const ark = require(path.join(ROOT, "electron", "main", "providers", "ark.js"));

// a test key goes to the loopback mock only, a real one never does (ark.js checkKey)
const KEY = "test-ark-0123456789abcdef";
const REAL_KEY = "3f2b9c1e-7a4d-4e21-9b8f-0c6d5e4a3b21";
const BASE = "http://127.0.0.1:5556";
const PATH = "/api/v3/images/generations";
const AP = "https://ark.ap-southeast.bytepluses.com";   // Johor (ap-southeast-1)
const EU = "https://ark.eu-west.bytepluses.com";        // Dublin (eu-west-1)
const PRO_ID = "dola-seedream-5-0-pro-260628";
const LITE_ID = "seedream-5-0-260128";
const ID_55 = "dola-seedream-5-5-261028";   // Seedream 5.5, early access (BytePlus's preview docs, 2026-11-08)
const PRO_PIXELS = [921600, 4624220];      // [1280x720, 2048x2048x1.1025]
const LITE_PIXELS = [3686400, 16777216];   // [2560x1440, 4096x4096]
const ALL_CALLS = [];   // every call of every section, for the header check at the end
const ERRORS = [];      // every error of the run, for the key check at the end

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 400 ? s.slice(0, 400) + " ..." : s; };

// refs.instruction, numbered by the layout: the crop is image 1, the references follow
const EDIT_PREFIX = "Edit image 1 and keep its size and framing.";
const REF_ONE = "Image 2 is a reference image.";
const REF_MANY = "Images 2 and 3 are reference images.";

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
/** A JPEG as far as a sniffer looks: SOI and an APP0 marker, the tag at the same place as pngOf's. */
function jpegOf(size, tag = "") {
    const b = Buffer.alloc(Math.max(size, 33 + tag.length), 0);
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(b);
    b.write(tag, 33, "latin1");
    return b;
}
const tagOf = (b) => Buffer.from(b).toString("latin1", 33, 33 + 16).replace(/\0+$/, "");
const RESULT = pngOf(1536, 1024, 80, "RESULT");
const RESULT_JPEG = jpegOf(90, "RESULTJPEG");
const DOWNLOAD = pngOf(1536, 1024, 80, "DOWNLOAD");

function fromDataUrl(url) {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(url || ""));
    return m ? { mime: m[1], bytes: Buffer.from(m[2], "base64") } : null;
}
// `image` is a string or a string[] (the reference: "string / string[]"); several pictures need the array
const picsOf = (body) => (body && Array.isArray(body.image) ? body.image.map(fromDataUrl) : body && typeof body.image === "string" ? [fromDataUrl(body.image)] : []);

function recordHeaders(init) {
    const h = {};
    for (const [k, v] of new Headers((init && init.headers) || {})) h[k.toLowerCase()] = v;
    return h;
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
/** The documented failure: { error: { code, message, param, type } }. */
const failure = (status, code, message, headers = {}, type = "BadRequest") => json(status, { error: { code, message, param: "", type } }, headers);
/** The documented answer, echoing the request's model and size. */
const okFor = (body, extra = {}) => json(200, { model: body.model, created: 1789000000, data: [{ b64_json: RESULT.toString("base64"), size: body.size, output_format: "png" }], usage: { generated_images: 1, output_tokens: 6144, total_tokens: 6144 }, ...extra });

/**
 * A fake ModelArk. `answers` answer POST /api/v3/images/generations in order (functions of the parsed body returning
 * a Response, or throwing for a network error); after the list runs out every request succeeds. Any host answers,
 * so a call to the regional hosts is recorded as well as one to the mock. GET /result/... on any host is the url
 * answer's download (`download` replaces it). Every call is recorded with all its headers.
 */
function fakeServer(opts = {}) {
    const calls = [];
    const posts = [];   // { url, headers, body } of POST /api/v3/images/generations
    const gets = [];
    const answers = [...(opts.answers || [])];
    async function fetch(url, init = {}) {
        const method = String(init.method || "GET").toUpperCase();
        const call = { url: String(url), method, headers: recordHeaders(init) };
        calls.push(call);
        ALL_CALLS.push(call);
        const u = new URL(String(url));
        if (method === "POST" && u.pathname === PATH) {
            const body = JSON.parse(init.body);
            posts.push({ ...call, body });
            const a = answers.shift();
            if (a) return a(body);
            return okFor(body);
        }
        if (method === "GET" && u.pathname.startsWith("/result/")) {
            gets.push(call);
            return opts.download ? opts.download(call) : new Response(DOWNLOAD, { status: 200, headers: { "content-type": "image/png" } });
        }
        return failure(404, "NotFound", "no route " + u.pathname);
    }
    return { fetch, calls, posts, gets };
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
    return rawRecipe(id).providers.ark;
}

function editReq(v, extra = {}) {
    return {
        provider: "ark", model: v.model, kind: "edit", options: v.options, fields: v.fields || null,
        prompt: "a red door", negative: "blurry", seed: 42,
        image: pngOf(1536, 1024, 96, "CROP"), mask: pngOf(1536, 1024, 96, "MASK-LUMINANCE"), maskAlpha: pngOf(1536, 1024, 96, "MASK-ALPHA"),
        width: 1536, height: 1024, references: [], params: {}, ...extra,
    };
}
function textReq(v, extra = {}) {
    return {
        provider: "ark", model: (v.text && v.text.model) || v.model, kind: "text", options: v.options, fields: null,
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
    try { await fn(); } catch (err) { const m = String(err && err.message || err); ERRORS.push(m); return m; }
    return null;
}

const dims = (s) => String(s).split("x").map(Number);
const BODY_KEYS = ["image", "model", "output_format", "prompt", "response_format", "size", "watermark"];
const TEXT_KEYS = ["model", "output_format", "prompt", "response_format", "size", "watermark"];
const NEVER = ["mask", "mask_url", "mask_image", "seed", "n", "sequential_image_generation", "sequential_image_generation_options", "stream", "negative_prompt", "guidance_scale", "background", "tools", "optimize_prompt_options", "layer_decomposition"];

// A layer answer as far as the adapter reads one: the base first (no box), the layers with z_index out of order.
const layerItem = (tag, extra) => ({ b64_json: pngOf(1024, 768, 80, tag).toString("base64"), size: "1024x768", ...extra });
const layerAnswer = (body) => json(200, {
    model: body.model, created: 1789000000,
    data: [layerItem("BASE", { z_index: 0 }), layerItem("Z2", { z_index: 2, name: "dog", description: "a dog", bounding_box: { absolute: [10, 20, 110, 220], normalized: [10, 26, 107, 286] } }), layerItem("Z1", { z_index: 1, name: "sky", description: "the sky", bounding_box: { absolute: [0, 0, 1024, 300], normalized: [0, 0, 1000, 390] } })],
    usage: { generated_images: 3 },
});
const layerReq = (v, extra = {}) => ({ provider: "ark", model: v.model, kind: "layers", options: v.options, prompt: "", negative: "", seed: 0, image: pngOf(1200, 800, 96, "PICTURE"), width: 1200, height: 800, references: [], params: {}, ...extra });

async function main() {
    // ---- 1. an edit: one request, its headers, the body, the answer ----
    await section("1. edit", async () => {
        const v = variant("seedream_5_pro");
        const s = fakeServer({ answers: [(body) => okFor(body, { data: [{ b64_json: RESULT.toString("base64"), size: "1536x1008", output_format: "png" }], usage: { generated_images: 1, input_images: 3, output_tokens: 6048, total_tokens: 6048 } })] });
        const ctx = ctxFor(s);
        const refs = [pngOf(800, 600, 70, "REF1"), pngOf(600, 800, 70, "REF2")];
        const req = editReq(v, { references: refs });
        const out = await ark.edit(req, ctx);
        check("one POST to <base>/api/v3/images/generations and no other call", s.calls.length === 1 && s.posts.length === 1 && s.calls[0].method === "POST" && s.calls[0].url === BASE + PATH, s.calls.map((c) => c.method + " " + c.url).join(", "));
        const h = s.posts[0] && s.posts[0].headers;
        check("the headers are exactly Authorization: Bearer <key> and Content-Type: application/json", !!h && eq(Object.keys(h).sort(), ["authorization", "content-type"]) && h.authorization === "Bearer " + KEY && h["content-type"] === "application/json", short(h));
        const b = s.posts[0].body;
        check("the body has exactly image, model, output_format, prompt, response_format, size and watermark", eq(Object.keys(b).sort(), BODY_KEYS), Object.keys(b).sort().join(","));
        check("body.model is the variant's model id (dola-seedream-5-0-pro-260628)", b.model === PRO_ID && v.model === PRO_ID, b.model);
        check("the prompt: the edit sentence, the user's prompt, the sentence for several references", b.prompt === `${EDIT_PREFIX} a red door ${REF_MANY}`, b.prompt);
        check("image is an array of data URLs with the lowercase prefix data:image/png;base64,", Array.isArray(b.image) && b.image.length === 3 && b.image.every((u) => typeof u === "string" && u.startsWith("data:image/png;base64,")), short(Array.isArray(b.image) ? b.image.map((u) => String(u).slice(0, 30)) : b.image));
        const pics = picsOf(b);
        check("image decodes to the crop first, then the references in order", pics.length === 3 && pics[0].bytes.equals(req.image) && pics[1].bytes.equals(refs[0]) && pics[2].bytes.equals(refs[1]), pics.map((p) => p && tagOf(p.bytes)).join(", "));
        check("neither mask goes out, as a field or among the pictures", !NEVER.slice(0, 3).some((k) => k in b) && !pics.some((p) => p.bytes.equals(req.mask) || p.bytes.equals(req.maskAlpha)), pics.map((p) => p && tagOf(p.bytes)).join(", "));
        check("size is the emitted crop's own WxH when it lies in the pixel range (1536x1024 on 5.0 pro)", b.size === "1536x1024", b.size);
        check("watermark is false (the API adds one by default), response_format b64_json, output_format png", b.watermark === false && b.response_format === "b64_json" && b.output_format === "png", short({ watermark: b.watermark, response_format: b.response_format, output_format: b.output_format }));
        check("no seed, n, sequential_image_generation, stream, negative prompt or other field this run has no use for", !NEVER.some((k) => k in b), Object.keys(b).join(","));
        check("the answer: the bytes of data[0].b64_json, image/png from the bytes, no seed (none was sent)", out.bytes.equals(RESULT) && out.mime === "image/png" && out.seed === undefined, short({ mime: out.mime, seed: out.seed, tag: tagOf(out.bytes) }));
        check("info: the answer's model, region ap-southeast, the size sent, the size answered, usage.generated_images", out.info.model === PRO_ID && out.info.region === "ap-southeast" && out.info.size === "1536x1024" && out.info.answered === "1536x1008" && out.info.generated_images === 1, short(out.info));
        check("info.pictures names what went in", eq(out.info.pictures, ["crop png", "reference 1 png", "reference 2 png"]), short(out.info.pictures));

        const s1 = fakeServer();
        await ark.edit(editReq(v, { references: [refs[0]] }), ctxFor(s1));
        check("one reference: the singular sentence", s1.posts[0].body.prompt === `${EDIT_PREFIX} a red door ${REF_ONE}` && picsOf(s1.posts[0].body).length === 2, s1.posts[0].body.prompt);
        const s0 = fakeServer();
        await ark.edit(editReq(v), ctxFor(s0));
        check("no reference: the edit sentence and the prompt only, the crop alone", s0.posts[0].body.prompt === `${EDIT_PREFIX} a red door` && picsOf(s0.posts[0].body).length === 1 && picsOf(s0.posts[0].body)[0].bytes.equals(editReq(v).image), s0.posts[0].body.prompt);
        const sO = fakeServer();
        await ark.edit(editReq(v, { references: refs, original: 1, refName: "Image {n}" }), ctxFor(sO));
        check("the Original (references[0]) gets its own sentence, the reference after it its number; refName names both", sO.posts[0].body.prompt === "Edit Image 1 and keep its size and framing. a red door Image 2 is Image 1 before the selected area was filled. Image 3 is a reference image.", sO.posts[0].body.prompt);

        // the answer's format comes from its bytes
        const sj = fakeServer({ answers: [(body) => okFor(body, { data: [{ b64_json: RESULT_JPEG.toString("base64"), size: body.size }] })] });
        const oj = await ark.edit(editReq(v), ctxFor(sj));
        check("a JPEG answer (the API's default format) reads image/jpeg from its bytes", oj.mime === "image/jpeg" && oj.bytes.equals(RESULT_JPEG), oj.mime);
        const odd = Buffer.from("RIFF\0\0\0\0WEBPVP8 odd bytes");
        const so = fakeServer({ answers: [(body) => okFor(body, { data: [{ b64_json: odd.toString("base64") }], usage: undefined })] });
        const oo = await ark.edit(editReq(v), ctxFor(so));
        check("bytes that are neither PNG nor JPEG read as the asked output_format (png), and no size or usage reads null", oo.mime === "image/png" && oo.bytes.equals(odd) && oo.info.answered === null && oo.info.generated_images === null, short({ mime: oo.mime, info: oo.info }));
        const noPng = { ...v, options: { ...v.options, png: false } };
        const sn = fakeServer({ answers: [(body) => okFor(body, { data: [{ b64_json: odd.toString("base64") }] })] });
        const on = await ark.edit(editReq(noPng), ctxFor(sn));
        check("a variant without png sends no output_format, and unknown bytes read as the API's default jpeg", !("output_format" in sn.posts[0].body) && on.mime === "image/jpeg", short({ keys: Object.keys(sn.posts[0].body), mime: on.mime }));
        const sp = fakeServer();
        const op = await ark.edit(editReq(noPng), ctxFor(sp));
        check("a PNG answer without output_format asked still reads image/png from its bytes", op.mime === "image/png", op.mime);

        // kind fill (a variant with input fill): still no mask
        const sf = fakeServer();
        await ark.edit(editReq({ ...v, input: "fill" }, { kind: "fill" }), ctxFor(sf));
        const pf = picsOf(sf.posts[0].body);
        check("kind fill sends the crop alone as well: no mask picture, no mask field, no word about a mask", pf.length === 1 && pf[0].bytes.equals(editReq(v).image) && !("mask" in sf.posts[0].body) && !/mask/i.test(sf.posts[0].body.prompt), pf.map((p) => tagOf(p.bytes)).join(", "));

        // a text run (Generate new) without references: the same endpoint without image, even when the request carries a picture
        const st = fakeServer();
        const ot = await ark.generate(textReq(v, { aspect: "16:9", width: 1024, height: 576, image: pngOf(64, 64, 40, "IGNORED2") }), ctxFor(st));
        const tb = st.posts[0] && st.posts[0].body;
        check("a text run: one POST to the same endpoint", st.calls.length === 1 && st.calls[0].url === BASE + PATH, st.calls.map((c) => c.url).join(", "));
        check("a text run without references sends no image, even when the request carries a picture", !!tb && eq(Object.keys(tb).sort(), TEXT_KEYS), tb && Object.keys(tb).sort().join(","));
        check("a text run: the prompt as it is, the size of the asked aspect, watermark false, b64_json, png", !!tb && tb.prompt === "a lighthouse at dusk" && tb.size === "1280x720" && tb.watermark === false && tb.response_format === "b64_json" && tb.output_format === "png" && tb.model === PRO_ID, short(tb));
        check("a text run without references: the body as before 26f, key for key", JSON.stringify(tb) === JSON.stringify({ model: PRO_ID, prompt: "a lighthouse at dusk", size: "1280x720", watermark: false, response_format: "b64_json", output_format: "png" }), short(tb));
        check("a text run's answer: the bytes, no pictures in info", ot.bytes.equals(RESULT) && eq(ot.info.pictures, []) && ot.info.size === "1280x720", short(ot.info));

        // with references (26f): `image` holds the references alone, in order (no crop, no mask), the size of the asked
        // aspect as without them, and the sentence for them after the prompt
        const str = fakeServer();
        const trq = textReq(v, { aspect: "16:9", width: 1024, height: 576, references: refs, image: pngOf(64, 64, 40, "IGNORED2"), mask: pngOf(64, 64, 40, "IGNOREDMASK") });
        const otr = await ark.generate(trq, ctxFor(str));
        const rb = str.posts[0] && str.posts[0].body;
        const rp = picsOf(rb);
        check("a text run with 2 references: one POST to the same endpoint", str.calls.length === 1 && str.calls[0].url === BASE + PATH, str.calls.map((c) => c.url).join(", "));
        check("a text run with 2 references: image is the two references in order, no crop, no mask", !!rb && eq(Object.keys(rb).sort(), BODY_KEYS) && rp.length === 2 && rp[0].bytes.equals(refs[0]) && rp[1].bytes.equals(refs[1]) && rb.image.every((u) => u.startsWith("data:image/png;base64,")), rp.map((p) => p && tagOf(p.bytes)).join(", "));
        check("a text run with 2 references: the prompt, then the sentence for them, no edit sentence", !!rb && rb.prompt === "a lighthouse at dusk Images 1 and 2 are reference images." && !/\bEdit\b/.test(rb.prompt), rb && rb.prompt);
        check("a text run with 2 references: the size of the asked aspect (1280x720), the text model", !!rb && rb.size === "1280x720" && rb.model === PRO_ID, short(rb && { ...rb, image: rp.length }));
        const { image: _ri, ...restR } = rb || {};
        check("a text run with 2 references: the body without references plus image and the sentence, nothing else", eq({ ...restR, prompt: tb.prompt }, tb), short(restR));
        check("a text run with 2 references: info.pictures names the references", eq(otr.info.pictures, ["reference 1 png", "reference 2 png"]) && otr.info.size === "1280x720", short(otr.info));
        const st1 = fakeServer();
        await ark.generate(textReq(v, { aspect: "16:9", width: 1024, height: 576, references: [refs[1]], refName: "Image {n}" }), ctxFor(st1));
        const b1t = st1.posts[0] && st1.posts[0].body;
        check("a text run with one reference: the singular sentence in the request's refName, one picture", !!b1t && b1t.prompt === "a lighthouse at dusk Image 1 is a reference image." && picsOf(b1t).length === 1 && picsOf(b1t)[0].bytes.equals(refs[1]), b1t && b1t.prompt);
        const tl = ark.textLayout(trq);
        check("textLayout: image[0] and image[1], numbered 1 and 2, role reference, max = options.max_images (10 on 5.0 pro), no drop", eq(tl.pictures, [{ role: "reference", ref: 0, field: "image[0]", n: 1 }, { role: "reference", ref: 1, field: "image[1]", n: 2 }]) && tl.max === 10 && tl.drops === null && tl.style === false, short(tl));
        check("textLayout: 14 on 5.0 lite, 10 without max_images (as the edit layout), no pictures without references", ark.textLayout(textReq(variant("seedream_5_lite"), { references: refs })).max === 14 && ark.textLayout({ kind: "text", references: refs, options: {} }).max === 10 && ark.layout({ kind: "edit", references: [], options: {} }).max === 10 && eq(ark.textLayout(textReq(v)).pictures, []), short(ark.textLayout({ kind: "text", references: refs, options: {} })));

        const se = fakeServer();
        const e1 = await throws(() => ark.generate(textReq(v, { prompt: "   " }), ctxFor(se)));
        check("an empty prompt on a text run is refused before any call", !!e1 && /needs a prompt/.test(e1) && se.calls.length === 0, e1);
        const se2 = fakeServer();
        const e2 = await throws(() => ark.edit(editReq(v, { image: null }), ctxFor(se2)));
        check("an edit without a crop is refused before any call", !!e2 && /no crop/.test(e2) && se2.calls.length === 0, e2);
        const se3 = fakeServer();
        const e3 = await throws(() => ark.edit(editReq({ ...v, model: "" }), ctxFor(se3)));
        check("a variant without a model id is refused before any call", !!e3 && /no model id/.test(e3) && se3.calls.length === 0, e3);
        check("generate is the same function as edit (kind text decides), and the adapter's label names ModelArk", ark.generate === ark.edit && /ModelArk/.test(ark.label) && /^https:\/\/ai\.byteplus\.com\//.test(ark.keyUrl), short({ label: ark.label, keyUrl: ark.keyUrl }));
    });

    // ---- 2. sizes: the model's pixel range, 16 px steps, never steeper than 16:1 ----
    await section("2. sizes", async () => {
        const pro = { pixels: PRO_PIXELS }, lite = { pixels: LITE_PIXELS };
        const size = (o, w, h, extra = {}) => ark._size({ kind: "edit", width: w, height: h, ...extra }, o);
        const text = (o, aspect, w, h) => ark._size({ kind: "text", aspect, width: w, height: h }, o);
        check("a small crop grows into the range: 512x512 -> 960x960 on 5.0 pro (921,600 px), 1920x1920 on 5.0 lite (3,686,400 px)", size(pro, 512, 512) === "960x960" && size(lite, 512, 512) === "1920x1920", `${size(pro, 512, 512)} / ${size(lite, 512, 512)}`);
        check("a crop at the floor stays on pro (1280x720); on lite it grows to 2560x1440", size(pro, 1280, 720) === "1280x720" && size(lite, 1280, 720) === "2560x1440", `${size(pro, 1280, 720)} / ${size(lite, 1280, 720)}`);
        const bigP = dims(size(pro, 8000, 6000)), bigL = dims(size(lite, 8000, 6000));
        check("a big crop shrinks under the ceiling in its own shape: 8000x6000 -> at most 4,624,220 px on pro, 16,777,216 on lite", bigP[0] * bigP[1] <= PRO_PIXELS[1] && bigP[0] * bigP[1] >= PRO_PIXELS[1] * 0.97 && bigL[0] * bigL[1] <= LITE_PIXELS[1] && bigL[0] * bigL[1] >= LITE_PIXELS[1] * 0.97 && Math.abs(bigP[0] / bigP[1] / (4 / 3) - 1) < 0.01 && Math.abs(bigL[0] / bigL[1] / (4 / 3) - 1) < 0.01, `${bigP.join("x")} / ${bigL.join("x")}`);
        check("a crop inside the range on 16 px edges is sent as it is", size(pro, 1536, 1024) === "1536x1024" && size(pro, 2048, 2048) === "2048x2048" && size(lite, 4096, 4096) === "4096x4096" && size(lite, 3072, 2048) === "3072x2048" && size(pro, 3840, 240) === "3840x240", [size(pro, 1536, 1024), size(pro, 2048, 2048), size(lite, 4096, 4096), size(lite, 3072, 2048), size(pro, 3840, 240)].join(", "));
        check("a crop steeper than 16:1 is sent at 16:1 exactly (4000x100 -> 3840x240, 100x4000 -> 240x3840 on pro; 7680x480 on lite)", size(pro, 4000, 100) === "3840x240" && size(pro, 100, 4000) === "240x3840" && size(lite, 4000, 100) === "7680x480", [size(pro, 4000, 100), size(pro, 100, 4000), size(lite, 4000, 100)].join(", "));
        const edge = dims(size(pro, 543, 8594));
        check("a size near 16:1 above the pro cap stays within 16:1 and the range (fitPixels' last area step would tip it past)", edge[1] <= 16 * edge[0] && edge[0] * edge[1] <= PRO_PIXELS[1] && edge[0] * edge[1] >= PRO_PIXELS[0] && edge[0] % 16 === 0 && edge[1] % 16 === 0, edge.join("x"));
        check("an edit's size ignores a stray aspect (the crop's shape decides)", size(pro, 1536, 1024, { aspect: "16:9" }) === "1536x1024", size(pro, 1536, 1024, { aspect: "16:9" }));
        const bare = [size({}, 512, 512), size({}, 8000, 6000), size({ pixels: null }, 2400, 2400)];
        const bareBig = dims(bare[1]);
        check("a variant without options.pixels takes 5.0 pro's range (the lower ceiling): 512x512 -> 960x960, 8000x6000 under 4,624,220 px, 2400x2400 (in lite's range) shrunk", bare[0] === "960x960" && bareBig[0] * bareBig[1] <= PRO_PIXELS[1] && bare[2] !== "2400x2400", bare.join(", "));

        // a sweep over crop shapes on both ranges
        const EDGES = [16, 100, 333, 512, 720, 1000, 1024, 1280, 1536, 2000, 2048, 2150, 3000, 4096, 5000, 8000];
        const bad = [];
        let n = 0;
        for (const [name, o] of [["pro", pro], ["lite", lite]]) {
            for (const w of EDGES) {
                for (const h of EDGES) {
                    n++;
                    const [a, b] = dims(size(o, w, h));
                    const px = a * b;
                    const tag = `${name} ${w}x${h} -> ${a}x${b}`;
                    if (!(px >= o.pixels[0] && px <= o.pixels[1])) bad.push(tag + " out of the pixel range");
                    if (a % 16 || b % 16) bad.push(tag + " not on 16 px steps");
                    if (Math.max(a, b) > 16 * Math.min(a, b)) bad.push(tag + " steeper than 16:1");
                    if ((w > h && a < b) || (w < h && a > b) || (w === h && a !== b)) bad.push(tag + " turned");
                    if (Math.max(w, h) <= 16 * Math.min(w, h) && Math.abs(Math.log((a / b) / (w / h))) > Math.log(1 + 16 / Math.min(a, b)) + 1e-9) bad.push(tag + " off the crop's shape by more than a step");
                    if (w % 16 === 0 && h % 16 === 0 && w * h >= o.pixels[0] && w * h <= o.pixels[1] && Math.max(w, h) <= 16 * Math.min(w, h) && (a !== w || b !== h)) bad.push(tag + " changed a crop that fits");
                }
            }
        }
        check("a sweep of 512 crop shapes: inside the range, 16 px steps, never steeper than 16:1, never turned, the crop's shape within one step, a crop that fits kept", !bad.length, bad.slice(0, 8).join("; ") || `${n} sizes`);

        // text runs: the asked aspect, not the rounded dialog size
        check("Generate new 16:9 at 1024: 1280x720 on pro, 2560x1440 on lite; 9:16: 720x1280 and 1440x2560", text(pro, "16:9", 1024, 576) === "1280x720" && text(lite, "16:9", 1024, 576) === "2560x1440" && text(pro, "9:16", 576, 1024) === "720x1280" && text(lite, "9:16", 576, 1024) === "1440x2560", [text(pro, "16:9", 1024, 576), text(lite, "16:9", 1024, 576), text(pro, "9:16", 576, 1024), text(lite, "9:16", 576, 1024)].join(", "));
        check("the aspect wins over the dialog's rounded size: 3:2 asked as 1024x688 -> 2352x1568 on lite (exactly 3:2), where 1024x688 alone gives another shape", text(lite, "3:2", 1024, 688) === "2352x1568" && text(lite, null, 1024, 688) !== "2352x1568" && text(pro, "3:2", 1536, 1024) === "1536x1024", `${text(lite, "3:2", 1024, 688)} (without the aspect ${text(lite, null, 1024, 688)}); pro ${text(pro, "3:2", 1536, 1024)}`);
        check("1:1 at 1024 stays on pro (1,048,576 px lie in its range) and grows to 1920x1920 on lite; 1:1 at 512 grows to 960x960 on pro", text(pro, "1:1", 1024, 1024) === "1024x1024" && text(lite, "1:1", 1024, 1024) === "1920x1920" && text(pro, "1:1", 512, 512) === "960x960", `${text(pro, "1:1", 1024, 1024)} / ${text(lite, "1:1", 1024, 1024)} / ${text(pro, "1:1", 512, 512)}`);
        check("an aspect that is not W:H (free, empty) falls back to width and height", text(pro, "free", 1536, 1024) === "1536x1024" && text(pro, "", 1536, 1024) === "1536x1024" && text(pro, "0:1", 1536, 1024) === "1536x1024", [text(pro, "free", 1536, 1024), text(pro, "", 1536, 1024), text(pro, "0:1", 1536, 1024)].join(", "));
        check("a text ask steeper than 16:1 (20:1) is sent at 16:1", text(pro, "20:1", 4000, 200) === "3840x240" && text(lite, "1:20", 200, 4000) === "480x7680", `${text(pro, "20:1", 4000, 200)} / ${text(lite, "1:20", 200, 4000)}`);

        // the dialog's own asks: shell.js GEN_ASPECTS at the variants' text sizes, rounded as genSize() rounds them
        const shell = fs.readFileSync(path.join(ROOT, "renderer", "shell.js"), "utf8");
        const m = /const GEN_ASPECTS = (\[[^\]]*\]);/.exec(shell);
        const aspects = m ? JSON.parse(m[1]).filter((a) => a !== "free") : [];
        const round16 = (x) => Math.max(64, Math.min(8192, Math.round(x / 16) * 16));
        const gcd = (a, b) => (b ? gcd(b, a % b) : a);
        const inexact = [];
        let asks = 0;
        for (const [id, o] of [["seedream_5_pro", pro], ["seedream_5_lite", lite]]) {
            for (const long of variant(id).text.sizes) {
                for (const asp of aspects) {
                    const [aw, ah] = asp.split(":").map(Number);
                    const [w, h] = aw >= ah ? [round16(long), round16(long * ah / aw)] : [round16(long * aw / ah), round16(long)];
                    const [a, b] = dims(text(o, asp, w, h));
                    asks++;
                    // is there a size on 16 px steps of exactly this aspect inside the range? (16p·k x 16q·k)
                    const d = gcd(aw, ah), p = aw / d, q = ah / d;
                    let exists = false;
                    for (let k = 1; 256 * p * q * k * k <= o.pixels[1]; k++) if (256 * p * q * k * k >= o.pixels[0]) { exists = true; break; }
                    if (exists && a * ah !== b * aw) inexact.push(`${id.replace("seedream_5_", "")} ${asp} at ${long} (dialog ${w}x${h}) -> ${a}x${b}${a === w && b === h ? " = the dialog's rounded size" : ""}`);
                }
            }
        }
        check("the dialog's own asks (GEN_ASPECTS at each text size): the answer keeps the asked aspect exactly where a size of that aspect on 16 px steps lies in the range", aspects.length >= 8 && !inexact.length, inexact.length ? `${inexact.length} of ${asks}: ${inexact.join("; ")}` : `${asks} asks`);
    });

    // ---- 3. regions and hosts, the mock and the key rule ----
    await section("3. regions and hosts", async () => {
        const pro = variant("seedream_5_pro"), lite = variant("seedream_5_lite");
        async function real(v, params, kind = "edit", extra = {}) {
            const s = fakeServer();
            const ctx = ctxFor(s, { key: REAL_KEY, base: undefined, ...extra });
            let out = null, err = null;
            try { out = kind === "edit" ? await ark.edit(editReq(v, { params }), ctx) : await ark.generate(textReq(v, { params }), ctx); } catch (e) { err = String(e && e.message || e); ERRORS.push(err); }
            return { s, out, err };
        }
        check("the two hosts are Johor's and Dublin's, and nothing else", eq(ark.REGIONS, { "ap-southeast": AP, "eu-west": EU }), short(ark.REGIONS));
        const a = await real(lite, {});
        check("no Region param: the variant's first region (lite: ap-southeast), a real key to its host", !a.err && a.s.calls.length === 1 && a.s.calls[0].url === AP + PATH && a.s.calls[0].headers.authorization === "Bearer " + REAL_KEY && a.out.info.region === "ap-southeast", short({ err: a.err, calls: a.s.calls.map((c) => c.url), region: a.out && a.out.info.region }));
        const b = await real(lite, { region: "eu-west" });
        check("Region eu-west on lite: https://ark.eu-west.bytepluses.com, info.region eu-west", !b.err && b.s.calls.length === 1 && b.s.calls[0].url === EU + PATH && b.out.info.region === "eu-west", short({ err: b.err, calls: b.s.calls.map((c) => c.url) }));
        const b2 = await real(lite, { region: "eu-west" }, "text");
        check("Generate new on lite in eu-west goes to Dublin too", !b2.err && b2.s.calls.length === 1 && b2.s.calls[0].url === EU + PATH, short({ err: b2.err, calls: b2.s.calls.map((c) => c.url) }));
        const b3 = await real(lite, { region: "ap-southeast" });
        check("Region ap-southeast on lite: Johor", !b3.err && b3.s.calls[0].url === AP + PATH, short({ err: b3.err, calls: b3.s.calls.map((c) => c.url) }));
        const c = await real(pro, {});
        check("5.0 pro without a Region param: Johor", !c.err && c.s.calls.length === 1 && c.s.calls[0].url === AP + PATH && c.out.info.region === "ap-southeast", short({ err: c.err, calls: c.s.calls.map((x) => x.url) }));
        const d = await real(pro, { region: "eu-west" });
        check("Region eu-west on 5.0 pro (it lists ap-southeast only): refused before any call, the message names the region", !!d.err && /not offered in the region "eu-west"/.test(d.err) && d.s.calls.length === 0, d.err);
        const d2 = await real(pro, { region: "eu-west" }, "text");
        check("... and Generate new on 5.0 pro in eu-west too", !!d2.err && /not offered in the region "eu-west"/.test(d2.err) && d2.s.calls.length === 0, d2.err);
        const sm = fakeServer();
        const em = await throws(() => ark.edit(editReq(pro, { params: { region: "eu-west" } }), ctxFor(sm)));
        check("the mock does not lift the region rule: 5.0 pro in eu-west with the test base is refused before any call", !!em && /not offered in the region/.test(em) && sm.calls.length === 0, em);
        const sm2 = fakeServer();
        const om2 = await ark.edit(editReq(lite, { params: { region: "eu-west" } }), ctxFor(sm2));
        check("with the test base a region's request goes to the mock, and info.region is still the region", sm2.calls.length === 1 && sm2.calls[0].url === BASE + PATH && om2.info.region === "eu-west", short({ calls: sm2.calls.map((x) => x.url), region: om2.info.region }));

        const wrong = [];
        for (const r of ["https://evil.example", "ap-southeast-1", "EU-WEST", "eu-west/../x", "127.0.0.1:5556", "ark.eu-west.bytepluses.com"]) {
            const x = await real(lite, { region: r });
            if (!(x.err && /no region/.test(x.err) && x.s.calls.length === 0)) wrong.push(`${r}: ${x.err} (${x.s.calls.length} calls)`);
        }
        check("an unknown region value (a URL, a region id, another case, a host) is refused by name before any call", !wrong.length, wrong.join("; "));
        const open = { ...lite, options: { ...lite.options } };
        delete open.options.regions;
        const e = await real(open, { region: "https://evil.example" });
        check("a variant without a regions list refuses an unknown region value as well", !!e.err && /no region "https:\/\/evil\.example"/.test(e.err) && e.s.calls.length === 0, e.err);
        const e0 = await real(open, {});
        check("a variant without a regions list and no Region param: Johor", !e0.err && e0.s.calls.length === 1 && e0.s.calls[0].url === AP + PATH, short({ err: e0.err, calls: e0.s.calls.map((x) => x.url) }));
        const protoWrong = [];
        for (const r of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
            const x = await real(open, { region: r });
            if (!(x.err && /no region/.test(x.err) && x.s.calls.length === 0)) protoWrong.push(`${r}: ${x.s.calls.length} call(s) to ${x.s.calls.map((cc) => cc.url.slice(0, 40)).join(", ") || "-"}, ${x.err}`);
        }
        check("a region named like an Object.prototype member (constructor, toString, __proto__, hasOwnProperty) is refused by name before any call", !protoWrong.length, protoWrong.join("; "));
        const eu1 = { ...lite, options: { ...lite.options, regions: ["eu-west", "ap-southeast"] } };
        const f = await real(eu1, {});
        check("a variant whose regions list starts with eu-west defaults to Dublin", !f.err && f.s.calls[0].url === EU + PATH, short({ err: f.err, calls: f.s.calls.map((x) => x.url) }));
        let hf = null;
        try { hf = ark._hostFor({ base: undefined }, "", ["ap-southeast"]); } catch (err) { hf = String(err.message); }
        check("_hostFor: an empty Region value is the variant's first region", !!hf && hf.host === AP && hf.region === "ap-southeast" && hf.test === false, short(hf));

        // settings.ark.base: only the loopback mock
        const table = [
            ["http://127.0.0.1:5556", "http://127.0.0.1:5556"],
            ["http://127.0.0.1:5556/", "http://127.0.0.1:5556"],
            [" http://127.0.0.1:9000 ", "http://127.0.0.1:9000"],
            ["https://127.0.0.1:5556", null],
            ["http://localhost:5556", null],
            ["http://127.0.0.2:5556", null],
            ["http://[::1]:5556", null],
            ["http://127.0.0.1", null],
            ["http://127.0.0.1:5556/api/v3", null],
            ["http://user:pw@127.0.0.1:5556", null],
            ["http://127.0.0.1:5556/?x=1", null],
            ["http://127.0.0.1:5556/#x", null],
            [AP, null],
            [EU, null],
            [AP + "/api/v3", null],
            ["https://evil.example", null],
            ["not a url", null],
            ["", null],
            [null, null],
            [undefined, null],
        ];
        const tw = table.filter(([inp, want]) => ark._testBase(inp) !== want).map(([inp, want]) => `${inp} -> ${ark._testBase(inp)} (want ${want})`);
        check("_testBase: http://127.0.0.1:<port> and nothing else (not https, localhost, a path, userinfo, a query, no port, the real hosts)", !tw.length, tw.join("; ") || `${table.length} values`);
        const bu = [ark.baseUrl({ ark: { base: BASE } }), ark.baseUrl({ ark: { base: AP } }), ark.baseUrl({ ark: { base: "https://evil.example" } }), ark.baseUrl({ ark: {} }), ark.baseUrl({}), ark.baseUrl(undefined), ark.baseUrl({ openrouter: { base: BASE }, toapis: { base: BASE } })];
        check("baseUrl reads settings.ark.base through _testBase, else null (the Region row picks the host); another provider's base does not count", eq(bu, [BASE, null, null, null, null, null, null]), short(bu));

        // the key rule: a test key only to the mock, a real key never there
        const cases = [
            ["a test- key with no base (a real host)", { base: undefined }, /test key is never sent to BytePlus/],
            ["a test- key with base set to a real host (not a mock, so ignored)", { base: EU }, /test key is never sent to BytePlus/],
            ["a test- key with base http://localhost:5556 (not the mock)", { base: "http://localhost:5556" }, /test key is never sent to BytePlus/],
            ["a real key with the loopback base", { key: REAL_KEY }, /only a test key goes there/],
        ];
        for (const [what, extra, re] of cases) {
            const got = [];
            for (const [name, fn] of [["edit", (ctx) => ark.edit(editReq(lite), ctx)], ["generate", (ctx) => ark.generate(textReq(lite), ctx)]]) {
                const s = fakeServer();
                const err = await throws(() => fn(ctxFor(s, extra)));
                got.push({ name, refused: !!err && re.test(err), calls: s.calls.length, keyInError: !!err && (err.includes(REAL_KEY) || err.includes(KEY)) });
            }
            check(`${what} is refused before any call on edit and generate`, got.every((g) => g.refused && g.calls === 0 && !g.keyInError), short(got));
        }
    });

    // ---- 4. the pictures: checked before any call ----
    await section("4. pictures before any call", async () => {
        const pro = variant("seedream_5_pro"), lite = variant("seedream_5_lite");
        const tiny = (n, tag) => Array.from({ length: n }, (_, i) => pngOf(64, 64, 40, tag + i));
        const s1 = fakeServer();
        const e1 = await throws(() => ark.edit(editReq(pro, { references: tiny(10, "R") }), ctxFor(s1)));
        check("5.0 pro: the crop and ten references (eleven) are refused before any call, the message names the counts", !!e1 && /at most 10 pictures; this run has 11 \(the crop, 10 references\)/.test(e1) && s1.calls.length === 0, e1);
        const s2 = fakeServer();
        await ark.edit(editReq(pro, { references: tiny(9, "R") }), ctxFor(s2));
        check("5.0 pro: the crop and nine references (ten) go out, all ten in order", s2.posts.length === 1 && picsOf(s2.posts[0].body).length === 10 && tagOf(picsOf(s2.posts[0].body)[9].bytes) === "R8", String(s2.posts.length));
        const s3 = fakeServer();
        const e3 = await throws(() => ark.edit(editReq(lite, { references: tiny(14, "R") }), ctxFor(s3)));
        check("5.0 lite: the crop and fourteen references (fifteen) are refused before any call", !!e3 && /at most 14 pictures; this run has 15 \(the crop, 14 references\)/.test(e3) && s3.calls.length === 0, e3);
        const s4 = fakeServer();
        await ark.edit(editReq(lite, { references: tiny(13, "R") }), ctxFor(s4));
        check("5.0 lite: the crop and thirteen references (fourteen) go out", s4.posts.length === 1 && picsOf(s4.posts[0].body).length === 14, String(s4.posts.length));
        const s5 = fakeServer();
        const e5 = await throws(() => ark.edit(editReq({ ...pro, options: { ...pro.options, max_images: 1 } }, { references: tiny(1, "R") }), ctxFor(s5)));
        check("max_images 1 with one reference: refused, the singular word for the reference", !!e5 && /has 2 \(the crop, 1 reference\)/.test(e5) && s5.calls.length === 0, e5);
        const noMax = { ...lite, options: { ...lite.options } };
        delete noMax.options.max_images;
        const s6 = fakeServer();
        const e6 = await throws(() => ark.edit(editReq(noMax, { references: tiny(10, "R") }), ctxFor(s6)));
        check("a variant without max_images takes at most 10 (the smaller documented count)", !!e6 && /at most 10 pictures/.test(e6) && s6.calls.length === 0, e6);
        // a text run (Generate new, 26f): the references alone, so the crop's slot is a reference's
        const s7 = fakeServer();
        const e7 = await throws(() => ark.generate(textReq(pro, { references: tiny(11, "R") }), ctxFor(s7)));
        check("a text run on 5.0 pro with eleven references: refused before any call, in the words for a new image", !!e7 && /takes at most 10 reference pictures for a new image; this run has 11: hide reference layers\./.test(e7) && s7.calls.length === 0, e7);
        const s8 = fakeServer();
        await ark.generate(textReq(pro, { references: tiny(10, "R") }), ctxFor(s8));
        check("a text run on 5.0 pro with ten references: all ten go out in order", s8.posts.length === 1 && picsOf(s8.posts[0].body).length === 10 && tagOf(picsOf(s8.posts[0].body)[0].bytes) === "R0" && tagOf(picsOf(s8.posts[0].body)[9].bytes) === "R9", String(s8.posts.length));
        const s9 = fakeServer();
        const e9 = await throws(() => ark.generate(textReq(lite, { references: [pngOf(100, 1700, 64, "TALL")] }), ctxFor(s9)));
        check("a text run's reference steeper than 16:1: refused before any call, naming the reference layer only", !!e9 && /the reference 1 is 100 × 1700\. Use a less narrow reference layer\./.test(e9) && s9.calls.length === 0, e9);
        const s10 = fakeServer();
        const e10 = await throws(() => ark.generate(textReq(lite, { references: [pngOf(4096, 4096, ark.MAX_PICTURE_BYTES + 1, "ALPHAREF")] }), ctxFor(s10, { toJpeg: () => null, opaque: () => false })));
        check("a text run's transparent reference over 30 MB: refused before any call, no Highres fix in the remedy", !!e10 && /the reference 1 is 30\.0 MB/.test(e10) && /\. Use a smaller reference layer\./.test(e10) && !/Highres/.test(e10) && s10.calls.length === 0, e10);

        const refused = async (req, re, what) => {
            const s = fakeServer();
            const err = await throws(() => ark.edit(req, ctxFor(s)));
            check(what, !!err && re.test(err) && s.calls.length === 0, err);
        };
        const goes = async (req, what) => {
            const s = fakeServer();
            const err = await throws(() => ark.edit(req, ctxFor(s)));
            check(what, !err && s.posts.length === 1, err || String(s.posts.length));
        };
        await refused(editReq(lite, { references: [pngOf(100, 1700, 64, "TALL")] }), /no steeper than 16:1; the reference 1 is 100 × 1700/, "a reference steeper than 16:1 (100 x 1700) is refused before any call");
        await refused(editReq(lite, { image: pngOf(3201, 200, 64, "CROP") }), /no steeper than 16:1; the crop is 3201 × 200/, "a crop of 3201 x 200 is refused before any call");
        await goes(editReq(lite, { image: pngOf(3200, 200, 64, "CROP"), references: [pngOf(200, 3200, 64, "TALL")] }), "a crop of exactly 16:1 and a reference of exactly 1:16 go out");
        await refused(editReq(lite, { image: pngOf(14, 200, 64, "CROP") }), /the crop is 14 × 200; every picture must be more than 14 px a side/, "a crop 14 px wide is refused before any call");
        await refused(editReq(lite, { references: [pngOf(200, 14, 64, "FLAT")] }), /the reference 1 is 200 × 14; every picture must be more than 14 px a side/, "a reference 14 px high is refused before any call");
        await goes(editReq(lite, { image: pngOf(15, 200, 64, "CROP"), references: [pngOf(15, 15, 64, "SMALL")] }), "a crop 15 px wide and a 15 x 15 reference go out");
        await refused(editReq(lite, { references: [pngOf(6001, 6000, 64, "HUGE")] }), /at most 36 megapixels; the reference 1 is 6001 × 6000/, "a reference of 6001 x 6000 (over 36 MP) is refused before any call");
        await refused(editReq(lite, { references: [pngOf(9001, 4000, 64, "HUGE")] }), /at most 36 megapixels/, "a reference of 9001 x 4000 is refused before any call");
        await goes(editReq(lite, { references: [pngOf(6000, 6000, 64, "BIG"), pngOf(9000, 4000, 64, "BIG2")] }), "references of exactly 36 MP (6000 x 6000, 9000 x 4000) go out");

        // 30 MB a picture: an opaque one goes as JPEG, a transparent one is refused
        const MAX = ark.MAX_PICTURE_BYTES;
        check("MAX_PICTURE_BYTES is 30,000,000 (the reference's 30 MB, read as the smaller decimal megabyte)", MAX === 30000000, String(MAX));
        function encoder(outSize) {
            const calls = [];
            return {
                calls,
                toJpeg: (b, q) => { calls.push({ tag: tagOf(b), size: b.length, q }); return jpegOf(outSize, "J-" + tagOf(b)); },
                opaque: (b) => !tagOf(b).startsWith("ALPHA"),
            };
        }
        const encA = encoder(2000000);
        const sA = fakeServer();
        const oA = await ark.edit(editReq(lite, { image: pngOf(4096, 4096, MAX + 1, "CROP") }), ctxFor(sA, { toJpeg: encA.toJpeg, opaque: encA.opaque }));
        const pA = sA.posts.length ? picsOf(sA.posts[0].body) : [];
        check("an opaque crop of 30 MB + 1 byte goes as JPEG (quality 92): data:image/jpeg;base64, with the encoder's bytes", eq(encA.calls.map((c) => [c.tag, c.size, c.q]), [["CROP", MAX + 1, 92]]) && pA.length === 1 && pA[0].mime === "image/jpeg" && sA.posts[0].body.image[0].startsWith("data:image/jpeg;base64,") && tagOf(pA[0].bytes) === "J-CROP" && pA[0].bytes.length === 2000000 && eq(oA.info.pictures, ["crop jpeg"]), short({ calls: encA.calls, mimes: pA.map((p) => p.mime), pictures: oA.info.pictures }));
        const encA2 = encoder(2000000);
        const sA2 = fakeServer();
        await ark.edit(editReq(lite, { image: pngOf(4096, 4096, MAX + 1, "CROP") }), ctxFor(sA2, { toJpeg: async (b, q) => encA2.toJpeg(b, q), opaque: async (b) => encA2.opaque(b) }));
        const pA2 = sA2.posts.length ? picsOf(sA2.posts[0].body) : [];
        check("the same with an asynchronous toJpeg and opaque (both awaited)", encA2.calls.length === 1 && pA2.length === 1 && pA2[0].mime === "image/jpeg" && tagOf(pA2[0].bytes) === "J-CROP", short({ calls: encA2.calls.length, mimes: pA2.map((p) => p.mime) }));
        const encB = encoder(2000000);
        const sB = fakeServer();
        await ark.edit(editReq(lite, { image: pngOf(4096, 4096, MAX, "CROP") }), ctxFor(sB, { toJpeg: encB.toJpeg, opaque: encB.opaque }));
        const pB = sB.posts.length ? picsOf(sB.posts[0].body) : [];
        check("a crop of exactly 30,000,000 bytes goes as PNG, not converted", encB.calls.length === 0 && pB.length === 1 && pB[0].mime === "image/png" && pB[0].bytes.length === MAX, short({ calls: encB.calls.length, mime: pB[0] && pB[0].mime }));
        const encC = encoder(2000000);
        const sC = fakeServer();
        const eC = await throws(() => ark.edit(editReq(lite, { image: pngOf(4096, 4096, MAX + 1, "ALPHACROP") }), ctxFor(sC, { toJpeg: encC.toJpeg, opaque: encC.opaque })));
        check("a transparent crop over 30 MB is refused, never converted, before any call", !!eC && /more than the 30 MB/.test(eC) && /it has transparency, so it stays PNG/.test(eC) && encC.calls.length === 0 && sC.calls.length === 0, short({ err: eC, calls: encC.calls.length }));
        const encC2 = encoder(2000000);
        const sC2 = fakeServer();
        const eC2 = await throws(() => ark.edit(editReq(lite, { image: pngOf(4096, 4096, MAX + 1, "ALPHACROP") }), ctxFor(sC2, { toJpeg: async (b, q) => encC2.toJpeg(b, q), opaque: async (b) => encC2.opaque(b) })));
        check("an asynchronous opaque answering false is awaited (a pending promise is not taken for opaque): refused, not converted", !!eC2 && /it has transparency/.test(eC2) && encC2.calls.length === 0 && sC2.calls.length === 0, short({ err: eC2, calls: encC2.calls.length }));
        const encD = encoder(MAX + 1);
        const sD = fakeServer();
        const eD = await throws(() => ark.edit(editReq(lite, { image: pngOf(4096, 4096, MAX + 1, "CROP") }), ctxFor(sD, { toJpeg: encD.toJpeg, opaque: encD.opaque })));
        check("a JPEG still over 30 MB is refused before any call, with the remedy", !!eD && /even as JPEG/.test(eD) && /Highres fix lower/.test(eD) && encD.calls.length === 1 && sD.calls.length === 0, eD);
        const sE = fakeServer();
        const eE = await throws(() => ark.edit(editReq(lite, { image: pngOf(4096, 4096, MAX + 1, "CROP") }), ctxFor(sE)));
        check("without toJpeg / opaque an oversized crop is refused before any call", !!eE && /more than the 30 MB/.test(eE) && sE.calls.length === 0, eE);
        const sF = fakeServer();
        const eF = await throws(() => ark.edit(editReq(lite, { image: pngOf(4096, 4096, MAX + 1, "CROP") }), ctxFor(sF, { toJpeg: () => null, opaque: () => true })));
        check("an encoder that cannot decode the picture (null): refused before any call", !!eF && /more than the 30 MB/.test(eF) && sF.calls.length === 0, eF);
        const encG = encoder(2000000);
        const sG = fakeServer();
        const oG = await ark.edit(editReq(lite, { image: pngOf(1536, 1024, 200, "CROP"), references: [pngOf(4096, 4096, MAX + 1, "BIGREF"), pngOf(64, 64, 64, "REF2")] }), ctxFor(sG, { toJpeg: encG.toJpeg, opaque: encG.opaque }));
        const pG = sG.posts.length ? picsOf(sG.posts[0].body) : [];
        check("a reference over 30 MB goes as JPEG, the crop and the other reference stay PNG, the order kept", eq(encG.calls.map((c) => c.tag), ["BIGREF"]) && eq(pG.map((p) => p.mime), ["image/png", "image/jpeg", "image/png"]) && tagOf(pG[1].bytes) === "J-BIGREF" && eq(oG.info.pictures, ["crop png", "reference 1 jpeg", "reference 2 png"]), short({ calls: encG.calls.map((c) => c.tag), mimes: pG.map((p) => p.mime) }));
        const encH = encoder(2000000);
        const sH = fakeServer();
        await throws(() => ark.edit(editReq(lite, { image: pngOf(3201, 200, MAX + 1, "CROP") }), ctxFor(sH, { toJpeg: encH.toJpeg, opaque: encH.opaque })));
        check("a picture that breaks a shape rule is refused before it is converted (no wasted encode)", encH.calls.length === 0 && sH.calls.length === 0, String(encH.calls.length));
    });

    // ---- 5. errors ----
    await section("5. errors", async () => {
        const v = variant("seedream_5_pro");
        const errs = [];
        async function attempt(answers, extra = {}, req = null) {
            const s = fakeServer({ answers });
            const ctx = ctxFor(s, extra);
            let out = null, err = null;
            try { out = await ark.edit(req || editReq(v), ctx); } catch (e) { err = String(e && e.message || e); errs.push(err); ERRORS.push(err); }
            return { s, ctx, out, err, posts: s.posts.length };
        }
        // the live 401 of 2026-09-19 (a request without a valid key), with the key echoed into its message
        const live = await attempt([() => json(401, { error: { code: "AuthenticationError", message: "the API key or AK/SK in the request is missing or invalid. request id: 021789845264349f39d09b715cb307c823cd4ff1a5ec1abe2960e (key " + KEY + ")", param: "", type: "Unauthorized" } }, { "x-error-code": "AuthN_MissOrInvalidAuthorizationHeader", "x-request-id": "021789845264349f39d09b715cb307c823cd4ff1a5ec1abe2960e" })]);
        check("the live 401 shape on 5.0 pro (one region): key refused, naming Johor and no Region row, its code and message, the key scrubbed, one call, no wait", !!live.err && /key refused \(this model runs in Johor only, and a key works only in the region it was made in\)/.test(live.err) && !/Region row/.test(live.err) && /AuthenticationError: the API key or AK\/SK in the request is missing or invalid/.test(live.err) && !live.err.includes(KEY) && /\[key\]/.test(live.err) && live.posts === 1 && live.ctx.sleeps.length === 0, live.err);
        const words = [
            [403, "AccountOverdueError", /the BytePlus account is overdue/],
            [403, "OperationDenied.ServiceNotOpen", /ModelArk is not activated on this account/],
            [404, "ModelNotOpen", /the model is not activated: activate it under Model activation/],
            [404, "InvalidEndpointOrModel.ModelIDAccessDisabled", /through an endpoint id/],
            [404, "InvalidEndpointOrModel.NotFound", /no such model in this region/],
            [400, "InputImageSensitiveContentDetected.PrivacyInformation", /refused: the picture may show a real person/],
            [400, "InputImageSensitiveContentDetected", /refused by the content filter/],
            [400, "InputTextSensitiveContentDetected", /refused by the content filter/],
            [400, "OutputImageSensitiveContentDetected", /refused by the content filter/],
            [400, "OutputImageSensitiveContentDetected.DeepFake", /refused by the content filter/],
            [400, "InvalidParameter", /request refused/],
            [400, "MissingParameter", /request refused/],
            [400, "InvalidImageURL.InvalidFormat", /a picture was not accepted/],
            [429, "SetLimitExceeded", /Safe Experience Mode/],
            [429, "QuotaExceeded", /QuotaExceeded/],
            [429, "ModelAccountRpmRateLimitExceeded", /rate limited/],
            [500, "InternalServiceError", /the service failed/],
        ];
        for (const [status, code, re] of words) {
            // Retry-After on each: a code that is not retried must not wait for it either
            const x = await attempt([() => failure(status, code, `server words for ${code}`, { "retry-after": "1" })]);
            check(`${status} ${code}: its words, the code and the server's message, one call, no wait`, !!x.err && re.test(x.err) && x.err.includes(`${code}: server words for ${code}`) && x.posts === 1 && x.ctx.sleeps.length === 0, short({ err: x.err, posts: x.posts, sleeps: x.ctx.sleeps }));
        }
        const priv = await attempt([() => failure(400, "InputImageSensitiveContentDetected", "The request failed because the input image may contain sensitive information.")]);
        check("a plain InputImageSensitiveContentDetected is not called a real person", !!priv.err && !/real person/.test(priv.err), priv.err);

        const ipm = (ra) => () => failure(429, "ModelAccountIpmRateLimitExceeded", "IPM (Images Per Minute) limit of the model is exceeded.", ra == null ? {} : { "retry-after": String(ra) }, "TooManyRequests");
        const h = await attempt([ipm(3)]);
        check("429 ModelAccountIpmRateLimitExceeded with Retry-After 3: sent once more after 3000 ms, the same body, then the image", !h.err && h.out && h.out.bytes.equals(RESULT) && h.posts === 2 && eq(h.ctx.sleeps, [3000]) && eq(h.s.posts[0].body, h.s.posts[1].body) && eq(h.s.posts[0].headers, h.s.posts[1].headers), short({ err: h.err, posts: h.posts, sleeps: h.ctx.sleeps }));
        const i = await attempt([ipm(1), ipm(1)]);
        check("the IPM limit twice: an error after exactly two calls, rate limited (images per minute)", !!i.err && /rate limited \(images per minute\)/.test(i.err) && i.posts === 2 && eq(i.ctx.sleeps, [1000]), short({ err: i.err, posts: i.posts, sleeps: i.ctx.sleeps }));
        const i2 = await attempt([ipm(600)]);
        check("a Retry-After of 600 s is not waited for: one call, no sleep, the error says when to try again", !!i2.err && i2.posts === 1 && i2.ctx.sleeps.length === 0 && /try again in 600 s/.test(i2.err), short({ err: i2.err, posts: i2.posts, sleeps: i2.ctx.sleeps }));
        const i3 = await attempt([ipm(60)]);
        check("a Retry-After of 60 s is waited for in full, then sent once more", !i3.err && i3.posts === 2 && eq(i3.ctx.sleeps, [60000]), short({ err: i3.err, posts: i3.posts, sleeps: i3.ctx.sleeps }));
        const i4 = await attempt([ipm(61)]);
        check("a Retry-After of 61 s is past the cap: one call, no sleep, try again in 61 s", !!i4.err && i4.posts === 1 && i4.ctx.sleeps.length === 0 && /try again in 61 s/.test(i4.err), short({ err: i4.err, posts: i4.posts, sleeps: i4.ctx.sleeps }));
        const i5 = await attempt([ipm(null)]);
        check("without Retry-After the IPM limit waits the 5 s default, then sends once more", !i5.err && i5.posts === 2 && eq(i5.ctx.sleeps, [5000]), short({ err: i5.err, posts: i5.posts, sleeps: i5.ctx.sleeps }));
        const i6 = await attempt([() => failure(429, "ModelAccountIpmRateLimitExceeded", "slow down", { "retry-after": new Date(Date.now() + 3000).toUTCString() }, "TooManyRequests")]);
        check("a Retry-After as an HTTP date 3 s out is waited for until then (not the 5 s default)", !i6.err && i6.posts === 2 && i6.ctx.sleeps.length === 1 && i6.ctx.sleeps[0] > 1000 && i6.ctx.sleeps[0] <= 3000, short({ err: i6.err, posts: i6.posts, sleeps: i6.ctx.sleeps }));
        const i7 = await attempt([ipm(2), ipm(600)]);
        check("a second refusal that names a wait: no third request, the error says when to try again", !!i7.err && i7.posts === 2 && eq(i7.ctx.sleeps, [2000]) && /try again in 600 s/.test(i7.err), short({ err: i7.err, posts: i7.posts, sleeps: i7.ctx.sleeps }));
        const i8 = await attempt([ipm(2), ipm(null)]);
        check("a second refusal without Retry-After: no 'try again in' (the 5 s default is not the server's time)", !!i8.err && i8.posts === 2 && !/try again in/.test(i8.err), short({ err: i8.err, posts: i8.posts }));
        const i9 = await attempt([ipm(1), ipm(1), ipm(1)]);
        check("never a third request, however often the limit answers", i9.posts === 2 && !!i9.err, String(i9.posts));
        const over = (status, ra) => () => failure(status, "ServerOverloaded", "The service is currently unable to handle additional requests due to server overload.", ra == null ? {} : { "retry-after": String(ra) }, "TooManyRequests");
        const j1 = await attempt([over(429, 2)]);
        check("429 ServerOverloaded: sent once more after the wait, then the image", !j1.err && j1.posts === 2 && eq(j1.ctx.sleeps, [2000]) && j1.out.bytes.equals(RESULT), short({ err: j1.err, posts: j1.posts, sleeps: j1.ctx.sleeps }));
        const j2 = await attempt([over(503, null)]);
        check("503 ServerOverloaded: sent once more (5 s without Retry-After)", !j2.err && j2.posts === 2 && eq(j2.ctx.sleeps, [5000]), short({ err: j2.err, posts: j2.posts, sleeps: j2.ctx.sleeps }));
        const j3 = await attempt([over(429, 1), over(429, 1)]);
        check("ServerOverloaded twice: the service is overloaded, two calls", !!j3.err && /the service is overloaded - ServerOverloaded/.test(j3.err) && j3.posts === 2, j3.err);
        const q = await attempt([() => failure(429, "QuotaExceeded", "Your account has exhausted its free trial quota.", { "retry-after": "1" }, "TooManyRequests")]);
        check("429 QuotaExceeded is not retried: one call, no wait", !!q.err && q.posts === 1 && q.ctx.sleeps.length === 0, short({ err: q.err, posts: q.posts, sleeps: q.ctx.sleeps }));
        check("QuotaExceeded names the free quota, a period's quota and the queue (the code page's three meanings), then the server's words", !!q.err && /a quota is used up, or too many tasks are queued/.test(q.err) && /free quota/.test(q.err) && /exhausted its free trial quota/.test(q.err), q.err);
        const lite = variant("seedream_5_lite");
        const la = await attempt([() => failure(401, "AuthenticationError", "the API key is invalid", {}, "Unauthorized")], {}, editReq(lite, { params: { region: "eu-west" } }));
        check("a 401 on 5.0 lite (a Region row): names the host it went to and points at the Region row", !!la.err && /key refused by the Dublin host \(a key works only in the region it was made in: check the Region row\)/.test(la.err), la.err);
        const ias = await attempt([() => failure(401, "InvalidAccountStatus", "There is an issue with your account status.", {}, "Forbidden")]);
        check("401 InvalidAccountStatus is an account matter, not the key", !!ias.err && /account's status blocks the call/.test(ias.err) && !/key refused/.test(ias.err) && ias.posts === 1, ias.err);
        const sl = await attempt([() => failure(429, "SetLimitExceeded", "paused", {}, "TooManyRequests")]);
        check("429 SetLimitExceeded is not retried: one call, no wait", !!sl.err && sl.posts === 1 && sl.ctx.sleeps.length === 0, short({ err: sl.err, posts: sl.posts }));
        const ise = await attempt([() => failure(500, "InternalServiceError", "The service encountered an unexpected internal error.", {}, "InternalServerError")]);
        check("500 InternalServiceError is not retried: one call (a request that failed inside may have made a paid image)", !!ise.err && ise.posts === 1 && ise.ctx.sleeps.length === 0, short({ err: ise.err, posts: ise.posts }));
        const plain429 = await attempt([() => new Response("Too Many Requests", { status: 429, headers: { "content-type": "text/plain", "retry-after": "1" } })]);
        check("a 429 without a JSON code is not retried: one call, rate limited, its text", !!plain429.err && /rate limited - Too Many Requests/.test(plain429.err) && plain429.posts === 1 && plain429.ctx.sleeps.length === 0, short({ err: plain429.err, posts: plain429.posts }));
        let thrown = 0;
        const net = await attempt([() => { thrown++; throw new TypeError("fetch failed"); }]);
        check("a network error is not retried: exactly one call", !!net.err && /fetch failed/.test(net.err) && thrown === 1 && net.s.calls.length === 1, short({ err: net.err, calls: net.s.calls.length }));
        const top = await attempt([() => json(200, { error: { code: "OutputImageSensitiveContentDetected", message: "The output image may contain sensitive content.", param: "", type: "BadRequest" } })]);
        check("HTTP 200 with a top-level error is thrown with its code's words, not as 'no image in the answer'", !!top.err && /refused by the content filter - OutputImageSensitiveContentDetected: The output image may contain sensitive content\./.test(top.err) && !/no image in the answer/.test(top.err) && !top.out && top.posts === 1, top.err);
        const item = await attempt([() => json(200, { model: PRO_ID, created: 1, data: [{ error: { code: "OutputImageSensitiveContentDetected.DeepFake", message: "The output may be a deep fake." } }], usage: { generated_images: 0 } })]);
        check("HTTP 200 with data[0].error only is thrown with its code", !!item.err && /OutputImageSensitiveContentDetected\.DeepFake: The output may be a deep fake\./.test(item.err) && /content filter/.test(item.err) && !item.out, item.err);
        const none = await attempt([() => json(200, { model: PRO_ID, created: 1, data: [{ size: "1536x1024" }], usage: { generated_images: 0 } })]);
        check("HTTP 200 without an image is thrown", !!none.err && /no image in the answer/.test(none.err) && !none.out, none.err);
        const empty = await attempt([() => json(200, { model: PRO_ID, created: 1, data: [] })]);
        check("HTTP 200 with an empty data list is thrown", !!empty.err && /no image in the answer/.test(empty.err), empty.err);
        const echo = await attempt([() => json(200, { model: PRO_ID, data: [{ note: "request by " + KEY }] })]);
        check("an answer without an image that echoes the key: the key is scrubbed from the quoted answer", !!echo.err && /no image in the answer/.test(echo.err) && !echo.err.includes(KEY), echo.err);
        const echo2 = await attempt([() => json(200, { error: { code: "InvalidParameter", message: "bad token " + KEY } })]);
        check("a 200 error that echoes the key: scrubbed", !!echo2.err && !echo2.err.includes(KEY) && /bad token \[key\]/.test(echo2.err), echo2.err);
        const echo3 = await attempt([() => json(200, { data: [{ error: { code: "InternalServiceError", message: "failed for " + KEY } }] })]);
        check("a data[].error that echoes the key: scrubbed", !!echo3.err && !echo3.err.includes(KEY) && /failed for \[key\]/.test(echo3.err), echo3.err);
        const echo4 = await attempt([() => failure(400, "InvalidParameter", "bad token " + REAL_KEY)], { key: REAL_KEY, base: undefined });
        check("a real key echoed by a real host's 400: scrubbed", !!echo4.err && !echo4.err.includes(REAL_KEY) && /\[key\]/.test(echo4.err) && echo4.s.calls[0].url === AP + PATH, echo4.err);
        const html = await attempt([() => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } })]);
        check("a 502 that is not JSON reads plain words and its text", !!html.err && /the service failed - <html>Bad gateway<\/html>/.test(html.err) && html.posts === 1, html.err);
        const cut = await attempt([() => new Response("x".repeat(290) + " " + KEY + " tail", { status: 502, headers: { "content-type": "text/plain" } })]);
        check("a long non-JSON body that echoes the key across the 300-character cut: no part of the key survives", !!cut.err && !cut.err.includes(KEY.slice(0, 6)) && cut.posts === 1, cut.err);

        // a url answer (the service ignored response_format): downloaded without the key
        const RESULT_URL = "https://ark-content-ap-southeast.bytepluses.example/result/abc.png?X-Tos-Signature=1";
        const u = await attempt([(body) => json(200, { model: body.model, created: 1, data: [{ url: RESULT_URL, size: body.size }], usage: { generated_images: 1 } })]);
        const get = u.s.gets[0];
        check("a url answer is downloaded: one GET of that URL after the POST, the bytes and the answer's content type", !u.err && u.posts === 1 && u.s.gets.length === 1 && get.url === RESULT_URL && u.out.bytes.equals(DOWNLOAD) && u.out.mime === "image/png" && u.s.posts[0].body.response_format === "b64_json", short({ err: u.err, gets: u.s.gets.map((g) => g.url) }));
        check("the download carries no key and no header at all", !!get && eq(get.headers, {}), short(get && get.headers));
        const sDl = fakeServer({ answers: [() => json(200, { data: [{ url: RESULT_URL }] })], download: () => new Response("gone", { status: 403 }) });
        const eDl = await throws(() => ark.edit(editReq(v), ctxFor(sDl)));
        check("a url answer whose download fails is thrown", !!eDl && /image download answered 403/.test(eDl) && sDl.gets.length === 1, eDl);
        check("the key appears in no error of this section", errs.length >= 40 && !errs.some((x) => x.includes(KEY) || x.includes(REAL_KEY)), `${errs.length} errors`);
    });

    // ---- 6. the recipes, as recipes.js lists them, and the wiring in providers/index.js ----
    await section("6. recipes", async () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-ark-test-"));
        const orig = Module._load;
        Module._load = function (request, ...rest) {
            if (request === "electron") return { app: { getPath: () => empty } };
            return orig.call(this, request, ...rest);
        };
        let recipes;
        try { recipes = require(path.join(ROOT, "electron", "main", "recipes.js")); } finally { Module._load = orig; }
        let list;
        try { list = await recipes.list(RECIPES); } finally { fs.rmSync(empty, { recursive: true, force: true }); }
        const served = list.filter((r) => r.providers && r.providers.ark);
        check("exactly the two Seedream 5.0 recipes and Seedream 5.5 carry an ark variant, all builtin", eq(served.map((r) => r.id).sort(), ["seedream_5_5", "seedream_5_lite", "seedream_5_pro"]) && served.every((r) => r.source === "builtin"), served.map((r) => r.id).join(", "));
        // `only`: ModelArk is the recipe's default and its early-access host (5.5); else ark comes right after
        // toapis and fal stays the default
        const want = {
            seedream_5_pro: { model: PRO_ID, pixels: PRO_PIXELS, max_images: 10, regions: ["ap-southeast"], sizes: [1280, 1536, 2048], rows: [] },
            seedream_5_lite: { model: LITE_ID, pixels: LITE_PIXELS, max_images: 14, regions: ["ap-southeast", "eu-west"], sizes: [2560, 3072, 4096], rows: ["region"] },
            seedream_5_5: { model: ID_55, pixels: PRO_PIXELS, max_images: 10, regions: ["ap-southeast"], sizes: [1280, 1536, 2048], rows: ["background"], only: true },
        };
        const bad = [];
        let runs = 0;
        for (const r of served) {
            const w = want[r.id];
            const raw = rawRecipe(r.id);
            const v = r.providers.ark;
            const o = v.options || {};
            const ids = r.providerIds;
            if (w.only) {
                // since 2026-11-11 also on five other hosts (tools/seedream55_test.js), ModelArk right after ToAPIs, still the default
                if (!eq(ids, ["toapis", "ark", "wavespeed", "comfycloud", "comfyrouter", "oxen"])) bad.push(`${r.id}: providers ${ids.join(",")}, not ModelArk after ToAPIs and the four others`);
                if (r.default !== "ark" || raw.default !== "ark") bad.push(`${r.id}: the default is ${r.default} (file ${raw.default}), not ark`);
                if (o.background !== true || o.early_access !== true) bad.push(`${r.id}: options.background ${o.background}, early_access ${o.early_access}`);
                const bg = (v.settings || []).find((st) => st.key === "background");
                if (!bg || bg.label !== "Background" || !eq(bg.spec[0], ["auto", "transparent", "opaque"]) || bg.spec[1].default !== "auto") bad.push(`${r.id}: the Background row ${short(bg)}`);
                if (!v.text || !eq((v.text.settings || []).map((st) => st.key), ["background"])) bad.push(`${r.id}: Generate new lacks the Background row (${short(v.text && v.text.settings)})`);
                if (!/early access/i.test(String(r.description || "")) || !/Model activation/.test(String(r.description || "")) || !/allow-list/.test(String(r.description || ""))) bad.push(`${r.id}: the description does not say early access, Model activation and allow-list`);
                if (!/early access/i.test(String(v.note || ""))) bad.push(`${r.id}: the note does not say early access`);
            } else {
                if (ids.indexOf("ark") !== ids.indexOf("toapis") + 1 || ids.indexOf("toapis") < 0) bad.push(`${r.id}: ark is not right after toapis (${ids.join(",")})`);
                if (r.default !== "fal" || raw.default !== "fal") bad.push(`${r.id}: the default is ${r.default} (file ${raw.default}), not fal`);
                if (o.background || o.early_access) bad.push(`${r.id}: options.background ${o.background}, early_access ${o.early_access}`);
                if (!/Also on BytePlus ModelArk/.test(String(r.description || ""))) bad.push(`${r.id}: the description does not say Also on BytePlus ModelArk`);
            }
            if (v.model !== w.model) bad.push(`${r.id}: model ${v.model}`);
            if (v.input !== "edit" || v.edit !== true) bad.push(`${r.id}: input ${v.input}, edit ${v.edit}`);
            if (!v.text || v.text.model !== w.model || !eq(v.text.sizes, w.sizes)) bad.push(`${r.id}: text ${JSON.stringify(v.text)}`);
            else if (v.text.sizes.some((sz) => sz * sz < w.pixels[0] || sz * sz > w.pixels[1])) bad.push(`${r.id}: a square text size outside the range`);
            if (!eq(o.pixels, w.pixels)) bad.push(`${r.id}: options.pixels ${JSON.stringify(o.pixels)}`);
            if (o.max_images !== w.max_images) bad.push(`${r.id}: max_images ${o.max_images}`);
            if (o.png !== true) bad.push(`${r.id}: png ${o.png}`);
            if (!eq(o.regions, w.regions)) bad.push(`${r.id}: regions ${JSON.stringify(o.regions)}`);
            const l = v.limits || {};
            if (l.pixels !== o.pixels[1] || l.minPixels !== o.pixels[0] || l.ratio !== 16 || l.step !== 16) bad.push(`${r.id}: limits ${JSON.stringify(l)}`);
            if (!(l.max * l.max >= o.pixels[1] || l.max >= Math.sqrt(o.pixels[1]))) bad.push(`${r.id}: limits.max ${l.max} keeps a square crop under the pixel ceiling`);
            // a 16:1 crop must reach the floor within limits.max, or it goes out under it and is asked for at another shape
            if (l.max < Math.sqrt(16 * o.pixels[0]) - 16) bad.push(`${r.id}: limits.max ${l.max} keeps a 16:1 crop under the pixel floor (needs ${Math.ceil(Math.sqrt(16 * o.pixels[0]))})`);
            const rows = (v.settings || []).filter((st) => st.key === "region");
            if (o.regions.length > 1) {
                if (rows.length !== 1 || !eq(rows[0].spec[0], o.regions) || rows[0].spec[1].default !== o.regions[0] || rows[0].label !== "Region") bad.push(`${r.id}: the Region row ${JSON.stringify(rows)}`);
            } else if (rows.some((row) => row.spec[0].some((x) => !o.regions.includes(x)))) bad.push(`${r.id}: a Region row offers a region outside options.regions`);
            if (!eq((v.settings || []).map((st) => st.key), w.rows)) bad.push(`${r.id}: settings rows ${(v.settings || []).map((st) => st.key).join(",")}, not ${w.rows.join(",")}`);
            if (!/not run against the live API yet/.test(String(v.note || ""))) bad.push(`${r.id}: the note lacks the live-test sentence`);
            // an edit with each row's default (Region, Background auto: no field), and a text run, against the fake server
            const params = {};
            for (const st of v.settings || []) params[st.key] = st.spec[1].default;
            const [ew, eh] = dims(ark._size({ kind: "edit", width: 1600, height: 1200 }, o));
            const s = fakeServer();
            await ark.edit(editReq(v, { width: ew, height: eh, image: pngOf(ew, eh, 80, "CROP"), params }), ctxFor(s));
            const b = s.posts[0] && s.posts[0].body;
            if (!b || !eq(Object.keys(b).sort(), BODY_KEYS) || b.model !== w.model || b.size !== `${ew}x${eh}` || picsOf(b).length !== 1) bad.push(`${r.id} edit: ${short(b && { ...b, image: picsOf(b).length })}`);
            const t = fakeServer();
            await ark.generate(textReq(v, { params, aspect: "1:1", width: w.sizes[0], height: w.sizes[0] }), ctxFor(t));
            const tb = t.posts[0] && t.posts[0].body;
            if (!tb || !eq(Object.keys(tb).sort(), TEXT_KEYS) || tb.model !== w.model || tb.size !== `${w.sizes[0]}x${w.sizes[0]}`) bad.push(`${r.id} text: ${short(tb)}`);
            // and a text run with two references (26f): the two alone in image, the same size
            const t2 = fakeServer();
            const refs2 = [pngOf(640, 480, 70, "REF1"), pngOf(480, 640, 70, "REF2")];
            await ark.generate(textReq(v, { params, aspect: "1:1", width: w.sizes[0], height: w.sizes[0], references: refs2 }), ctxFor(t2));
            const tb2 = t2.posts[0] && t2.posts[0].body;
            const p2 = tb2 ? picsOf(tb2) : [];
            if (!tb2 || !eq(Object.keys(tb2).sort(), BODY_KEYS) || tb2.size !== `${w.sizes[0]}x${w.sizes[0]}` || p2.length !== 2 || !p2[0].bytes.equals(refs2[0]) || !p2[1].bytes.equals(refs2[1]) || tb2.prompt !== "a lighthouse at dusk Images 1 and 2 are reference images.") bad.push(`${r.id} text with references: ${short(tb2 && { ...tb2, image: p2.length })}`);
            // each region the row offers goes to its host with a real key
            for (const region of o.regions) {
                const sr = fakeServer();
                await ark.edit(editReq(v, { params: { region } }), ctxFor(sr, { key: REAL_KEY, base: undefined }));
                if (!(sr.calls.length === 1 && sr.calls[0].url === ark.REGIONS[region] + PATH)) bad.push(`${r.id} ${region}: ${sr.calls.map((c) => c.url).join(",")}`);
            }
            runs++;
        }
        check("each ark variant: right after toapis with the default fal kept (5.5: ark alone and its default, the Background row, early access said), its model id, input edit, the text shape and sizes, options.pixels = limits (pixels, minPixels, ratio 16, step 16), max_images, png, regions and the Region row, the notes; each builds an edit, a text request and one with two references, and reaches each region's host", !bad.length && runs === 3, bad.join("; ") || `${runs} variants`);

        // providers/index.js: ark in PROVIDERS after openrouter, a text provider, and the app's context
        const idxPath = path.join(ROOT, "electron", "main", "providers", "index.js");
        let currentSettings = { ark: { base: BASE } };
        let currentKey = KEY;
        const logged = [];
        Module._load = function (request, parent, ...rest) {
            if (request === "electron") return { nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, toJPEG: () => jpegOf(1500000, "NATIVE"), toBitmap: () => Buffer.alloc(8, 255) }) } };
            if (parent && parent.filename === idxPath) {
                if (request === "../log") return { record: (x) => logged.push(x) };
                if (request === "../keys") return { get: (id) => (id === "ark" ? currentKey : ""), describe: (id) => ({ set: id === "ark" }) };
                if (request === "../settings") return { get: () => currentSettings };
            }
            return orig.call(this, request, parent, ...rest);
        };
        let index;
        try { index = require(idxPath); } finally { Module._load = orig; }
        const rows = index.describeAll();
        const at = rows.findIndex((x) => x.id === "ark");
        check("index.js: an ark key row right after openrouter, labelled ModelArk, with its key page", at > 0 && rows[at - 1].id === "openrouter" && /ModelArk/.test(rows[at].label) && rows[at].keyUrl === ark.keyUrl && index.PROVIDERS.ark === ark, short(rows.map((x) => x.id)));
        check("index.js: ark is a text provider (Generate new)", index.textProviders().includes("ark"), short(index.textProviders()));
        const realFetch = globalThis.fetch;
        const v = variant("seedream_5_lite");
        async function viaIndex(request) {
            const s = fakeServer();
            globalThis.fetch = s.fetch;
            try { return { s, out: await index.edit(request), err: null }; } catch (e) { const m = String(e && e.message || e); ERRORS.push(m); return { s, out: null, err: m }; } finally { globalThis.fetch = realFetch; }
        }
        const base = { provider: "ark", model: v.model, kind: "edit", options: v.options, prompt: "a red door", seed: 3, image: new Uint8Array(pngOf(2560, 1440, 96, "CROP")), width: 2560, height: 1440, references: [], params: { region: "eu-west" } };
        const x1 = await viaIndex(base);
        check("index.edit: the stored key, settings.ark.base as the mock, one POST there, the bytes back", !x1.err && x1.s.calls.length === 1 && x1.s.calls[0].url === BASE + PATH && x1.s.calls[0].headers.authorization === "Bearer " + KEY && Buffer.from(x1.out.bytes).equals(RESULT) && x1.out.mime === "image/png" && x1.out.info.region === "eu-west", short({ err: x1.err, calls: x1.s.calls.map((c) => c.url) }));
        const x2 = await viaIndex({ ...base, kind: "text", image: null, aspect: "16:9", width: 2560, height: 1440 });
        check("index.edit with kind text: the same endpoint without image", !x2.err && x2.s.posts.length === 1 && !("image" in x2.s.posts[0].body) && x2.s.posts[0].body.size === "2560x1440", short({ err: x2.err, body: x2.s.posts[0] && x2.s.posts[0].body }));
        // Generate new with references (26f): textLayout numbers them, the markers become their names, the sentence follows
        const tRefs = [new Uint8Array(pngOf(640, 480, 70, "TREF1")), new Uint8Array(pngOf(480, 640, 70, "TREF2"))];
        const x2r = await viaIndex({ ...base, kind: "text", image: null, aspect: "16:9", width: 2560, height: 1440, prompt: "the jacket of {@ref:1} on the person of {@ref:0}", references: tRefs, original: 0, refName: "image {n}" });
        const b2r = x2r.s.posts[0] && x2r.s.posts[0].body;
        const p2r = b2r ? picsOf(b2r) : [];
        check("index.edit with kind text and 2 references: the markers named, the sentence after them, both references in image in order, the asked size", !x2r.err && !!b2r && b2r.prompt === "the jacket of image 2 on the person of image 1 Images 1 and 2 are reference images." && p2r.length === 2 && tagOf(p2r[0].bytes) === "TREF1" && tagOf(p2r[1].bytes) === "TREF2" && b2r.size === "2560x1440" && x2r.out.prompt === "the jacket of image 2 on the person of image 1" && eq(x2r.out.refs, [{ ref: 1, name: "image 2" }, { ref: 0, name: "image 1" }]) && eq(x2r.out.info.pictures, ["reference 1 png", "reference 2 png"]), short({ err: x2r.err, prompt: b2r && b2r.prompt, pics: p2r.map((p) => tagOf(p.bytes)), out: x2r.out && { prompt: x2r.out.prompt, refs: x2r.out.refs } }));
        const x2c = await viaIndex({ ...base, kind: "text", image: null, aspect: "16:9", width: 2560, height: 1440, prompt: "like {@ref:0}", references: tRefs, original: 0, refsMax: 1 });
        check("index.edit with kind text past the variant's refsMax (2 on 1): refused centrally before any call", !!x2c.err && /takes at most 1 reference picture for a new image; this run has 2: hide reference layers\./.test(x2c.err) && x2c.s.calls.length === 0, x2c.err);
        const x3 = await viaIndex({ ...base, image: new Uint8Array(pngOf(4096, 4096, ark.MAX_PICTURE_BYTES + 1, "CROP", 2)) });
        const p3 = x3.s.posts.length ? picsOf(x3.s.posts[0].body) : [];
        check("index.edit: the app's toJpeg and opaque reach the adapter (an opaque RGB crop over 30 MB goes as JPEG)", !x3.err && p3.length === 1 && p3[0].mime === "image/jpeg" && tagOf(p3[0].bytes) === "NATIVE", short({ err: x3.err, mimes: p3.map((p) => p.mime) }));
        currentSettings = {};
        const x4 = await viaIndex(base);
        check("index.edit without settings.ark.base: a test key is refused before any call", !!x4.err && /test key is never sent/.test(x4.err) && x4.s.calls.length === 0, x4.err);
        currentSettings = { ark: { base: "https://evil.example" } };
        const x5 = await viaIndex(base);
        check("index.edit with settings.ark.base outside the rule: ignored, and the test key refused before any call", !!x5.err && /test key is never sent/.test(x5.err) && x5.s.calls.length === 0, x5.err);
        currentSettings = { ark: { base: BASE } };
        currentKey = REAL_KEY;
        const x6 = await viaIndex(base);
        check("index.edit: a real key with the mock set is refused before any call", !!x6.err && /only a test key goes there/.test(x6.err) && x6.s.calls.length === 0 && !x6.err.includes(REAL_KEY), x6.err);
        currentKey = "";
        const x7 = await viaIndex(base);
        check("index.edit without a stored key: refused before any call, naming ModelArk", !!x7.err && /No API key for BytePlus ModelArk/.test(x7.err) && x7.s.calls.length === 0, x7.err);
        currentKey = KEY;
        check("index.js logged no key", !JSON.stringify(logged).includes(KEY) && !JSON.stringify(logged).includes(REAL_KEY), `${logged.length} records`);
    });

    // ---- 8. Seedream 5.5 (early access): the Background row, the 10 pictures, the range, the access hint ----
    await section("8. Seedream 5.5", async () => {
        const v = variant("seedream_5_5");
        const o = v.options;
        const BG_KEYS = [...BODY_KEYS, "background"].sort();
        const TEXT_BG_KEYS = [...TEXT_KEYS, "background"].sort();
        const sent = [];   // every 5.5 body of this section, for the never-sent check
        async function edit5(params, extra = {}, answers) {
            const s = fakeServer(answers ? { answers } : {});
            const err = await throws(async () => { s.out = await ark.edit(editReq(v, { params, ...extra }), ctxFor(s)); });
            for (const p of s.posts) sent.push(p.body);
            return { s, err, b: s.posts[0] && s.posts[0].body, out: s.out };
        }
        async function text5(params, extra = {}) {
            const s = fakeServer();
            const err = await throws(async () => { s.out = await ark.generate(textReq(v, { params, ...extra }), ctxFor(s)); });
            for (const p of s.posts) sent.push(p.body);
            return { s, err, b: s.posts[0] && s.posts[0].body, out: s.out };
        }

        const a = await edit5({ background: "auto" });
        check("5.5 edit, Background Auto (the default): one POST, the seven fields and no background, model dola-seedream-5-5-261028, png, the crop alone", !a.err && a.s.calls.length === 1 && a.s.calls[0].url === BASE + PATH && !!a.b && eq(Object.keys(a.b).sort(), BODY_KEYS) && a.b.model === ID_55 && a.b.output_format === "png" && a.b.watermark === false && a.b.response_format === "b64_json" && a.b.size === "1536x1024" && picsOf(a.b).length === 1 && a.out.info.background === null, a.err || short(a.b && { ...a.b, image: picsOf(a.b).length }));
        const a0 = await edit5({});
        check("5.5 edit without a Background param: the same body as Auto", !a0.err && !!a0.b && eq(a0.b, a.b), a0.err || short(a0.b && Object.keys(a0.b)));

        const tr = await edit5({ background: "transparent" }, {}, [(body) => json(200, { model: body.model, created: 1789000000, data: [{ b64_json: RESULT.toString("base64"), size: body.size, output_format: "png" }], usage: { generated_images: 1 } })]);
        check("5.5 edit, Background Transparent: background transparent, output_format png, nothing else added", !tr.err && !!tr.b && eq(Object.keys(tr.b).sort(), BG_KEYS) && tr.b.background === "transparent" && tr.b.output_format === "png" && tr.b.model === ID_55, tr.err || short(tr.b && { ...tr.b, image: picsOf(tr.b).length }));
        check("5.5 edit, Background Transparent: the answer read as image/png, info.background transparent", !tr.err && tr.out.mime === "image/png" && tr.out.bytes.equals(RESULT) && tr.out.info.background === "transparent", tr.err || short({ mime: tr.out && tr.out.mime, info: tr.out && tr.out.info }));
        const op = await edit5({ background: "opaque" });
        check("5.5 edit, Background Opaque: background opaque, png", !op.err && !!op.b && op.b.background === "opaque" && op.b.output_format === "png" && eq(Object.keys(op.b).sort(), BG_KEYS), op.err || short(op.b && Object.keys(op.b)));
        const cs = await edit5({ background: " Transparent " });
        check("5.5 edit: a Background value in another case or with spaces goes as its lower-case word", !cs.err && !!cs.b && cs.b.background === "transparent", cs.err || short(cs.b && cs.b.background));
        const bad1 = await edit5({ background: "green" });
        check("5.5 edit: an unknown Background is refused before any call, naming the three values", !!bad1.err && /Background "green" is none of auto, transparent, opaque/.test(bad1.err) && bad1.s.calls.length === 0, bad1.err);
        const badText = await text5({ background: "checker" });
        check("5.5 Generate new: an unknown Background is refused before any call too", !!badText.err && /Background "checker"/.test(badText.err) && badText.s.calls.length === 0, badText.err);

        // a variant that does not declare background never sends it, whatever the params say
        const pro = variant("seedream_5_pro");
        const sp = fakeServer();
        await ark.edit(editReq(pro, { params: { background: "transparent" } }), ctxFor(sp));
        check("5.0 pro (no options.background): a background param stays home, the body as before", !!sp.posts[0] && !("background" in sp.posts[0].body) && eq(Object.keys(sp.posts[0].body).sort(), BODY_KEYS), short(sp.posts[0] && Object.keys(sp.posts[0].body)));
        const spg = fakeServer();
        await ark.edit(editReq(pro, { params: { background: "green" } }), ctxFor(spg));
        check("5.0 pro: an unknown background param is not looked at (no refusal where the field never goes)", spg.posts.length === 1 && !("background" in spg.posts[0].body), short(spg.posts.map((p) => Object.keys(p.body))));
        // transparent always goes as PNG, even on a variant that does not ask for png otherwise
        const noPng = { ...o, png: false };
        const bT = ark._body({ ...editReq(v), params: { background: "transparent" } }, noPng, []);
        const bA = ark._body({ ...editReq(v), params: { background: "auto" } }, noPng, []);
        const bO = ark._body({ ...editReq(v), params: { background: "opaque" } }, noPng, []);
        check("a variant without png: transparent still sends output_format png, auto and opaque send none", bT.output_format === "png" && bT.background === "transparent" && !("output_format" in bA) && !("background" in bA) && !("output_format" in bO) && bO.background === "opaque", short({ bT: Object.keys(bT), bA: Object.keys(bA), bO: Object.keys(bO) }));
        check("_background: null without options.background or for auto, the word otherwise", ark._background({ params: { background: "transparent" } }, {}) === null && ark._background({ params: {} }, o) === null && ark._background({ params: { background: "auto" } }, o) === null && ark._background({ params: { background: "OPAQUE" } }, o) === "opaque", "");

        // Generate new with a transparent background, without and with references
        const t1 = await text5({ background: "transparent" }, { aspect: "16:9", width: 1280, height: 720 });
        check("5.5 Generate new, Background Transparent: the text body plus background, 1280x720 for 16:9 at 1280, png", !t1.err && !!t1.b && eq(Object.keys(t1.b).sort(), TEXT_BG_KEYS) && t1.b.background === "transparent" && t1.b.size === "1280x720" && t1.b.output_format === "png" && t1.b.model === ID_55 && t1.b.prompt === "a lighthouse at dusk", t1.err || short(t1.b));
        const ten = Array.from({ length: 10 }, (_, i) => pngOf(640, 480, 70, "R" + i));
        const t10 = await text5({ background: "transparent" }, { aspect: "1:1", width: 2048, height: 2048, references: ten });
        check("5.5 Generate new with 10 references: all ten in image in order, the background, 2048x2048 (4.2 MP, inside the range)", !t10.err && !!t10.b && picsOf(t10.b).length === 10 && picsOf(t10.b).every((p, i) => tagOf(p.bytes) === "R" + i) && t10.b.background === "transparent" && t10.b.size === "2048x2048", t10.err || short(t10.b && { size: t10.b.size, pics: picsOf(t10.b).length }));
        const t11 = await text5({}, { aspect: "1:1", width: 2048, height: 2048, references: [...ten, pngOf(640, 480, 70, "R10")] });
        check("5.5 Generate new with 11 references: refused before any call, naming the 10", !!t11.err && /takes at most 10 reference pictures for a new image; this run has 11/.test(t11.err) && t11.s.calls.length === 0, t11.err);
        const e10 = await edit5({ background: "auto" }, { references: ten.slice(0, 9) });
        check("5.5 edit with the crop and 9 references (10 pictures): sent, the crop first", !e10.err && !!e10.b && picsOf(e10.b).length === 10 && tagOf(picsOf(e10.b)[0].bytes) === "CROP", e10.err || short(e10.b && picsOf(e10.b).length));
        const e11 = await edit5({ background: "auto" }, { references: ten });
        check("5.5 edit with the crop and 10 references (11 pictures): refused before any call", !!e11.err && /takes at most 10 pictures; this run has 11 \(the crop, 10 references\)/.test(e11.err) && e11.s.calls.length === 0, e11.err);
        check("layout and textLayout of 5.5: max 10", ark.layout({ kind: "edit", references: [], options: o }).max === 10 && ark.textLayout({ kind: "text", references: [], options: o }).max === 10, "");

        // the size: 5.5's pixel range [1280x720, 2048x2048x1.1025], 16 px steps, at most 16:1
        const size = (w, h) => ark._size({ kind: "edit", width: w, height: h }, o);
        const textSize = (aspect, w, h) => ark._size({ kind: "text", aspect, width: w, height: h }, o);
        const big = dims(size(8000, 6000));
        check("5.5 sizes: 512x512 grows to 960x960 (921,600 px), 8000x6000 shrinks under 4,624,220 px in its shape, 4000x100 goes at 3840x240, a crop inside goes as it is", size(512, 512) === "960x960" && big[0] * big[1] <= PRO_PIXELS[1] && big[0] * big[1] >= PRO_PIXELS[1] * 0.97 && Math.abs(big[0] / big[1] / (4 / 3) - 1) < 0.01 && size(4000, 100) === "3840x240" && size(1536, 1024) === "1536x1024", [size(512, 512), big.join("x"), size(4000, 100), size(1536, 1024)].join(", "));
        check("5.5 Generate new sizes: 16:9 at 2048 is 2048x1152, 9:16 at 1280 is 720x1280, 21:9 at 1280 grows to the floor", textSize("16:9", 2048, 1152) === "2048x1152" && textSize("9:16", 720, 1280) === "720x1280" && (() => { const [w, h] = dims(textSize("21:9", 1280, 544)); return w * h >= PRO_PIXELS[0] && w * 9 === h * 21; })(), [textSize("16:9", 2048, 1152), textSize("9:16", 720, 1280), textSize("21:9", 1280, 544)].join(", "));

        // the region: Johor only
        const sj = fakeServer();
        await ark.edit(editReq(v, { params: {} }), ctxFor(sj, { key: REAL_KEY, base: undefined }));
        check("5.5 with a real key: https://ark.ap-southeast.bytepluses.com/api/v3/images/generations (Johor), info.region ap-southeast", sj.calls.length === 1 && sj.calls[0].url === AP + PATH && sj.calls[0].headers.authorization === "Bearer " + REAL_KEY, short(sj.calls.map((c) => c.url)));
        const se = fakeServer();
        const eEu = await throws(() => ark.edit(editReq(v, { params: { region: "eu-west" } }), ctxFor(se, { key: REAL_KEY, base: undefined })));
        check("5.5 in eu-west: refused before any call (Johor only)", !!eEu && /not offered in the region "eu-west"/.test(eEu) && se.calls.length === 0, eEu);

        // the access hint: a refusal that may mean the account is not let in says early access, others do not
        const fail5 = async (status, code, message) => (await edit5({}, {}, [() => (code ? failure(status, code, message, {}, "NotFound") : new Response(message, { status }))])).err;
        const notOpen = await fail5(404, "ModelNotOpen", "Your account mock has not activated the model dola-seedream-5-5-261028. Please activate the model service in the Ark Console. Request id: mock");
        check("5.5 ModelNotOpen: not activated, then the early-access words, then the server's", !!notOpen && /^ModelArk dola-seedream-5-5-261028: the model is not activated: activate it under Model activation in the ModelArk console \(this model is in early access: BytePlus has to let the account in first, then activate it under Model activation in the ModelArk console\) - ModelNotOpen: Your account/.test(notOpen), notOpen);
        const notFound = await fail5(404, "InvalidEndpointOrModel.NotFound", "The model or endpoint dola-seedream-5-5-261028 does not exist or you do not have access to it.");
        check("5.5 InvalidEndpointOrModel.NotFound: no such model in this region, with the early-access words", !!notFound && /no such model in this region \(this model is in early access: BytePlus has to let the account in first/.test(notFound), notFound);
        const denied = await fail5(403, "AccessDenied", "You do not have access to this model.");
        check("5.5 a 403 of no known code: the early-access words lead", !!denied && /^ModelArk dola-seedream-5-5-261028: this model is in early access: BytePlus has to let the account in first.* - AccessDenied: You do not have access/.test(denied), denied);
        const bare404 = await fail5(404, "", "not here");
        check("5.5 a 404 without a code: not found, with the early-access words", !!bare404 && /not found \(this model is in early access/.test(bare404), bare404);
        const viaId = await fail5(404, "InvalidEndpointOrModel.ModelIDAccessDisabled", "Accessing the model via Model ID is not allowed for your account.");
        const quota = await fail5(429, "QuotaExceeded", "Your account has exhausted its free trial quota.");
        check("5.5 refusals that say something else keep their words alone (the endpoint id, a quota)", !!viaId && /endpoint id/.test(viaId) && !/early access/.test(viaId) && !!quota && /a quota is used up/.test(quota) && !/early access/.test(quota), `${viaId} | ${quota}`);
        const sp4 = fakeServer({ answers: [() => failure(404, "ModelNotOpen", "Your account mock has not activated the model.", {}, "NotFound")] });
        const proNotOpen = await throws(() => ark.edit(editReq(pro), ctxFor(sp4)));
        check("5.0 pro ModelNotOpen: no early-access words (not an early-access model)", !!proNotOpen && /not activated/.test(proNotOpen) && !/early access/.test(proNotOpen), proNotOpen);
        check("_explain without where.early: the words as before", ark._explain(404, "ModelNotOpen", "m", {}) === "the model is not activated: activate it under Model activation in the ModelArk console - ModelNotOpen: m" && ark._explain(403, "AccessDenied", "m", {}) === "AccessDenied: m", ark._explain(404, "ModelNotOpen", "m", {}));

        const NOT_55 = ["optimize_prompt_options", "layer_decomposition", "layer_decomposition_options", "sequential_image_generation", "sequential_image_generation_options", "stream", "seed", "n", "mask", "negative_prompt"];
        const leaked = sent.filter((b) => NOT_55.some((k) => k in b));
        check("no 5.5 body of this section carried optimize_prompt_options, layer_decomposition, sequential generation, stream, seed, n, a mask or a negative prompt", sent.length >= 12 && !leaked.length, leaked.length ? short(leaked.map((b) => Object.keys(b))) : `${sent.length} bodies`);
    });

    // ---- 8. layer decomposition (kind "layers"): the 5.0 pro schema, 5.5 from the preview docs ----
    await section("8. layer decomposition", async () => {
        const v55 = variant("seedream_5_5"), pro = variant("seedream_5_pro"), lite = variant("seedream_5_lite");
        const split = await import(require("node:url").pathToFileURL(path.join(ROOT, "renderer", "editor", "splitlayers.js")));
        check("the variants declare their layer mode: 5.5 up to 100 with options, 5.0 pro up to 16 without, 5.0 lite none", eq(v55.options.layers, { max: 100, options: true }) && eq(pro.options.layers, { max: 16 }) && !lite.options.layers, short([v55.options.layers, pro.options.layers, lite.options.layers]));
        const raws = ["seedream_5_5", "seedream_5_pro", "seedream_5_lite"].map(rawRecipe);
        check("the renderer's list: Seedream 5.5 first, then 5.0 pro; 5.0 lite is not in it", eq(split.layerRecipes(raws).map((r) => r.id), ["seedream_5_5", "seedream_5_pro"]) && eq(split.layerSpecOf(raws[1]), { max: 16, options: false }) && split.layerSpecOf(raws[2]) === null, split.layerRecipes(raws).map((r) => r.id).join(","));
        const s = fakeServer({ answers: [layerAnswer] });
        const out = await ark.layers(layerReq(v55), ctxFor(s));
        const b = s.posts[0].body;
        check("5.5 without a prompt: one POST, the body has exactly the documented fields and no prompt", s.posts.length === 1 && eq(Object.keys(b).sort(), ["image", "layer_decomposition", "layer_decomposition_options", "model", "output_format", "response_format", "size", "watermark"]), Object.keys(b).sort().join(","));
        check("the field is true, the picture a single data URL string (not an array), watermark false, output_format png", b.layer_decomposition === true && typeof b.image === "string" && b.image.startsWith("data:image/png;base64,") && fromDataUrl(b.image).bytes.equals(layerReq(v55).image) && b.watermark === false && b.output_format === "png", short({ ...b, image: String(b.image).slice(0, 30) }));
        check("the size is the tier auto by default, not WxH", b.size === "auto", b.size);
        check("5.5's options: the default count 16, Text recognition off, answers inlined up to 32 layers", eq(b.layer_decomposition_options, { max_images: 16, text_recognition: false }) && b.response_format === "b64_json", short(b.layer_decomposition_options));
        check("the answer in stacking order, the base first: z 0, 1, 2 from an answer of z 0, 2, 1", eq(out.layers.map((l) => l.z_index), [0, 1, 2]) && eq(out.layers.map((l) => tagOf(l.bytes)), ["BASE", "Z1", "Z2"]) && out.layers[0].base === true && !out.layers[1].base, short(out.layers.map((l) => [l.z_index, tagOf(l.bytes)])));
        check("each layer keeps its box, name and description; the base has no box", out.layers[0].bounding_box === null && eq(out.layers[2].bounding_box.absolute, [10, 20, 110, 220]) && out.layers[1].name === "sky" && out.layers[2].description === "a dog", short(out.layers[1]));
        check("out.bytes is the base's, and info counts the layers", out.bytes.equals(out.layers[0].bytes) && out.info.layers === 2 && out.info.asked === 16 && out.info.size === "auto" && out.info.region === "ap-southeast", short(out.info));
        for (const tier of ["1K", "1.5K", "2K", "auto"]) {
            const st = fakeServer({ answers: [layerAnswer] });
            await ark.layers(layerReq(v55, { params: { size: tier } }), ctxFor(st));
            check(`the tier ${tier} goes as it is`, st.posts[0].body.size === tier, st.posts[0].body.size);
        }
        const refused = async (v, extra, re, what) => {
            const sx = fakeServer();
            const err = await throws(() => ark.layers(layerReq(v, extra), ctxFor(sx)));
            check(what + " is refused before any call", !!err && re.test(err) && sx.calls.length === 0, err);
        };
        await refused(v55, { params: { size: "4K" } }, /a tier/, "a size of 4K");
        await refused(v55, { params: { size: "1024x1024" } }, /a tier/, "a size in pixels");
        await refused(v55, { params: { count: 0 } }, /1 to 100/, "a count of 0");
        await refused(v55, { params: { count: 101 } }, /1 to 100/, "a count of 101");
        await refused(v55, { params: { count: 2.5 } }, /whole number/, "a count of 2.5");
        await refused(pro, { params: { count: 5 } }, /finds its own number/, "a count on 5.0 pro");
        await refused(pro, { params: { text_recognition: true } }, /no Text recognition/, "Text recognition on 5.0 pro");
        await refused(lite, {}, /no layer mode/, "5.0 lite");
        await refused(v55, { references: [pngOf(100, 100, 40, "R")] }, /exactly one picture/, "a second picture");
        await refused(v55, { image: null }, /no picture to split/, "a run without a picture");
        await refused(v55, { image: pngOf(400, 400, 64, "SMALL") }, /512 × 512 to 6000 × 6000/, "a picture under 512 x 512 in area");
        await refused(v55, { image: pngOf(6400, 300, 64, "STEEP") }, /no steeper than 16:1/, "a picture steeper than 16:1");
        const sq = fakeServer({ answers: [layerAnswer] });
        await ark.layers(layerReq(v55, { prompt: "  the cat and the text  ", params: { count: 3, text_recognition: true } }), ctxFor(sq));
        check("a prompt goes trimmed and as it is (no edit sentence), the count and the switch in the options", sq.posts[0].body.prompt === "the cat and the text" && eq(sq.posts[0].body.layer_decomposition_options, { max_images: 3, text_recognition: true }), short(sq.posts[0].body.prompt));
        const sp = fakeServer({ answers: [layerAnswer] });
        const op = await ark.layers(layerReq(pro), ctxFor(sp));
        check("5.0 pro: no layer_decomposition_options at all, no count asked", !("layer_decomposition_options" in sp.posts[0].body) && sp.posts[0].body.model === PRO_ID && op.info.asked === null && op.info.text_recognition === null, Object.keys(sp.posts[0].body).join(","));
        // above 32 layers the answer comes by URL, one download per picture
        const items = ["BASE", "Z1"].map((t, i) => ({ url: `${BASE}/result/${i}`, z_index: i, ...(i ? { name: "a", bounding_box: { absolute: [1, 2, 3, 4] } } : {}) }));
        const su = fakeServer({ answers: [(body) => json(200, { model: body.model, data: items, usage: {} })] });
        const ou = await ark.layers(layerReq(v55, { params: { count: 40 } }), ctxFor(su));
        check("40 layers: response_format url, each picture downloaded once and in order", su.posts[0].body.response_format === "url" && su.gets.length === 2 && ou.layers.length === 2 && ou.info.by === "url", short({ gets: su.gets.map((g) => g.url), by: ou.info.by }));
        let downloads = 0;
        const su2 = fakeServer({ answers: [(body) => json(200, { model: body.model, data: items, usage: {} })], download: () => (++downloads === 1 ? new Response("no", { status: 503 }) : new Response(DOWNLOAD, { status: 200, headers: { "content-type": "image/png" } })) });
        const cu2 = ctxFor(su2);
        await ark.layers(layerReq(v55, { params: { count: 40 } }), cu2);
        check("a failed base download is tried again after a wait", downloads === 3 && cu2.sleeps.length === 1, `${downloads} downloads`);
        // (one-failed-download) a layer whose link stays away costs that layer, not the paid answer; the bug: throwing here
        const gone = (which) => (call) => (call.url.endsWith(which) ? new Response("gone", { status: 404 }) : new Response(DOWNLOAD, { status: 200, headers: { "content-type": "image/png" } }));
        const threeItems = [...items, { url: `${BASE}/result/2`, z_index: 2, name: "b", bounding_box: { absolute: [1, 2, 3, 4] } }];
        const sg = fakeServer({ answers: [(body) => json(200, { model: body.model, data: threeItems, usage: {} })], download: gone("/result/1") });
        const cg = ctxFor(sg);
        const og = await ark.layers(layerReq(v55, { params: { count: 40 } }), cg);
        check("a layer whose link stays away after 3 tries is left out and named, the others land", og.layers.length === 2 && eq(og.missing, ["a"]) && eq(og.layers.map((l) => l.z_index), [0, 2]) && eq(cg.sleeps, [5000, 10000]), short({ missing: og.missing, sleeps: cg.sleeps }));
        const sb2 = fakeServer({ answers: [(body) => json(200, { model: body.model, data: threeItems, usage: {} })], download: gone("/result/0") });
        const cb2 = ctxFor(sb2);
        const eb = await throws(() => ark.layers(layerReq(v55, { params: { count: 40 } }), cb2));
        check("a base that stays away after 5 tries with growing waits fails, and says the job is charged", !!eb && /finished and is charged, but its base picture/.test(eb) && eq(cb2.sleeps, [5000, 10000, 20000, 40000]), eb);
        const sa = fakeServer({ answers: [(body) => json(200, { model: body.model, data: threeItems, usage: {} })], download: gone("/result/1") });
        const ea = await throws(() => ark.layers(layerReq(v55, { params: { count: 40 } }), ctxFor(sa, { signal: { aborted: true } })));
        check("a download that fails during a Cancel ends the run, it is not a left-out layer", !!ea && /404/.test(ea), ea);
        // (cancel-during-downloads) the job is charged once it is answered; the bug: leaving jobDone unset
        const cjd = ctxFor(fakeServer({ answers: [layerAnswer] }));
        await ark.layers(layerReq(v55), cjd);
        const cjf = ctxFor(fakeServer({ answers: [() => failure(500, "InternalServiceError", "m", {}, "InternalServerError")] }));
        await throws(() => ark.layers(layerReq(v55), cjf));
        check("jobDone is set on the caller's ctx once the service has answered, and not when it refused", cjd.jobDone === true && cjf.jobDone === undefined, String(cjd.jobDone));
        // (split-post-dies-at-undici-300s) the bug: a POST without its own dispatcher limits
        let seen = null;
        const sd = fakeServer({ answers: [layerAnswer] });
        await ark.layers(layerReq(v55, { timeoutMs: 1800000 }), ctxFor(sd, { fetch: (u, init) => { seen = init; return sd.fetch(u, init); } }));
        check("the POST's undici limits follow the run's deadline (1800 s + 30 s), not undici's 300 s", !!seen.dispatcher && seen.dispatcher.headersTimeout === 1830000 && seen.dispatcher.bodyTimeout === 1830000, short(seen.dispatcher && seen.dispatcher.headersTimeout));
        let seenE = null;
        const se2 = fakeServer();
        await ark.edit(editReq(v55), ctxFor(se2, { fetch: (u, init) => { seenE = init; return se2.fetch(u, init); } }));
        check("an edit's POST is as before: no dispatcher", !seenE.dispatcher, "");
        const failed = async (answers, re, what) => {
            const sx = fakeServer({ answers });
            const err = await throws(() => ark.layers(layerReq(v55), ctxFor(sx)));
            check(what, !!err && re.test(err) && sx.posts.length === 1, err);
        };
        await failed([() => failure(500, "InternalServiceError", "one layer failed", {}, "InternalServerError")], /the service failed - InternalServiceError: one layer failed/, "a failed request is not retried and keeps the server's words");
        await failed([(body) => json(200, { model: body.model, data: [layerItem("BASE", { z_index: 0 }), { error: { code: "OutputImageSensitiveContentDetected", message: "m" } }] })], /content filter/, "an error in one entry fails the whole answer");
        // (base-found-only-by-missing-box) the bug: only a row without a box counts as the base, so a boxed base is thrown away after it is paid for
        const box = { absolute: [0, 0, 100, 100] };
        const baseOf = async (rows) => { const sx = fakeServer({ answers: [(body) => json(200, { model: body.model, data: rows, usage: {} })] }); const o = await ark.layers(layerReq(v55), ctxFor(sx)); return o.layers.map((l) => [tagOf(l.bytes), !!l.base]); };
        check("the base: a row without a box first, whatever its z_index", eq(await baseOf([layerItem("Z0", { z_index: 0, bounding_box: box }), layerItem("Z1", { z_index: 1 })]), [["Z1", true], ["Z0", false]]), "");
        check("the base: with a box on every row, the row of z_index 0", eq(await baseOf([layerItem("Z1", { z_index: 1, bounding_box: box }), layerItem("Z0", { z_index: 0, bounding_box: box })]), [["Z0", true], ["Z1", false]]), "");
        check("the base: with neither, data[0]", eq(await baseOf([layerItem("Z5", { z_index: 5, bounding_box: box }), layerItem("Z2", { z_index: 2, bounding_box: box })]), [["Z5", true], ["Z2", false]]), "");
        await failed([(body) => json(200, { model: body.model, data: [layerItem("BASE", { z_index: 0 }), { z_index: 1 }] })], /without its pictures \(1 of 2\)/, "an answer with a picture missing is refused");
        await failed([(body) => json(200, { model: body.model, data: [] })], /without its pictures \(0 of 0\)/, "an empty answer is refused");
        // a picture over 30 MB goes as JPEG when it is opaque (the same rule as an edit's)
        const big = pngOf(1200, 800, 31 * 1000 * 1000, "BIG");
        const sb = fakeServer({ answers: [layerAnswer] });
        await ark.layers(layerReq(v55, { image: big }), ctxFor(sb, { opaque: async () => true, toJpeg: async () => jpegOf(2000, "SMALLJPEG") }));
        check("an opaque picture over 30 MB goes as a JPEG data URL", String(sb.posts[0].body.image).startsWith("data:image/jpeg;base64,"), String(sb.posts[0].body.image).slice(0, 30));
        // the two refusals are one rule: the adapter's and the renderer's say the same on every size
        const SIDES = [14, 15, 100, 511, 512, 513, 700, 1200, 2048, 5999, 6000, 6001, 8000, 9000];
        const apart = [];
        for (const w of SIDES) for (const h of SIDES) if (ark._layerSizeRefusal(w, h, "M") !== split.splitSizeRefusal(w, h, "M")) apart.push(`${w}x${h}`);
        check("the adapter's size refusal and the renderer's say the same on every size of a sweep", !apart.length, apart.slice(0, 8).join(" "));
        const okSize = (w, h) => ark._layerSizeRefusal(w, h, "M") === "";
        check("the limits by the documented rule: 512 x 512 goes, 511 x 512 not; 6000 x 6000 goes, 6001 x 6000 not; 3200 x 200 (16:1) goes, 3400 x 200 not", okSize(512, 512) && !okSize(511, 512) && okSize(6000, 6000) && !okSize(6001, 6000) && okSize(3200, 200) && !okSize(3400, 200), "");
        // where an answer lands (renderer/editor/splitlayers.js)
        const rect = { x: 100, y: 40, w: 2000, h: 1000 };
        const entries = [{ base: true, z_index: 0, bounding_box: { absolute: [10, 10, 20, 20] }, name: "" }, { z_index: 1, name: "  sky\n\tblue ", bounding_box: { absolute: [0, 0, 500, 200] } }, { z_index: 2, name: "SKY blue", bounding_box: { absolute: [500, 200, 1000, 500] } }, { z_index: 3, name: "x".repeat(200), bounding_box: { absolute: [10, 10, 10, 10], normalized: [100, 200, 300, 400] } }, { z_index: 4, name: "broken", bounding_box: { absolute: [5, 5, 5, 5] } }, { z_index: 5, name: "", bounding_box: { absolute: [900, 400, 2000, 900] } }, { z_index: 6, name: "boxless", bounding_box: null }, { z_index: 7, name: "offside", bounding_box: { absolute: [1100, 0, 1200, 100] } }];
        const plan = split.planLanding(entries, rect, 1000, 500, new Set(["base"]));
        const P = plan.rows;
        check("the base covers the source's whole rectangle even with a box of its own, its name not taken from an existing layer", P[0].name === "Base 2" && eq([P[0].x, P[0].y, P[0].w, P[0].h], [100, 40, 2000, 1000]), short(P[0]));
        check("a box scales to the document, and two boxes that meet still meet (x 100 + 1000 = 1100)", eq([P[1].x, P[1].y, P[1].w, P[1].h], [100, 40, 1000, 400]) && eq([P[2].x, P[2].y, P[2].w, P[2].h], [1100, 440, 1000, 600]) && P[1].x + P[1].w === P[2].x, short([P[1], P[2]]));
        check("names: one line, duplicates numbered whatever the case, cut to a sane length, an empty one named by its place", P[1].name === "sky blue" && P[2].name === "SKY blue 2" && P[3].name.length === 60 && P[4].name === "Layer 5", short(P.map((r) => r.name)));
        // (layer-without-box-stretched) the bug: a row without a box is taken for the base and stretched over the whole picture
        check("a box that is no box falls back to normalized (0..1000), a layer without any box or off the base is left out and named", eq([P[3].x, P[3].y, P[3].w, P[3].h], [300, 240, 400, 200]) && eq(plan.leftOut, ["broken", "boxless", "offside"]) && P.length === 5, short(plan.leftOut));
        // (box-past-base-squeezes-picture) the bug: clamping the box to the base squeezes the whole PNG into what is left
        check("a box past the base stays whole and overhangs", eq([P[4].x, P[4].y, P[4].w, P[4].h], [1900, 840, 2200, 1000]), short(P[4]));
    });

    // ---- 7. the whole run: no header beyond the two, no key in any error ----
    const extra = ALL_CALLS.filter((c) => (c.method === "POST" ? !eq(Object.keys(c.headers).sort(), ["authorization", "content-type"]) : Object.keys(c.headers).length > 0));
    check("no call of the whole run carried a header beyond Authorization and Content-Type (a POST) or any header (a download): no Referer, X-Title, X-Client-Request-Id or the like", ALL_CALLS.length > 80 && !extra.length, extra.length ? short(extra.map((c) => c.method + " " + c.url + " " + Object.keys(c.headers).join(","))) : `${ALL_CALLS.length} calls`);
    // a URL that does not parse never leaves the machine (fetch throws before it connects); section 3's check on the
    // Object.prototype names reports those calls
    const keyed = ALL_CALLS.filter((c) => URL.canParse(c.url) && c.headers.authorization && !(c.headers.authorization === "Bearer " + KEY && c.url.startsWith(BASE + "/")) && !(c.headers.authorization === "Bearer " + REAL_KEY && (c.url.startsWith(AP + "/") || c.url.startsWith(EU + "/"))));
    check("every call that can reach a host and carries a key: the test key to the mock only, the real key to the two BytePlus hosts only", !keyed.length, keyed.length ? short(keyed.map((c) => c.url + " " + c.headers.authorization.slice(0, 16))) : "");
    check("neither key appears in any error of the run", ERRORS.length > 60 && !ERRORS.some((x) => x.includes(KEY) || x.includes(REAL_KEY)), `${ERRORS.length} errors`);

    const failed = results.filter((x) => !x).length;
    console.log(`${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + (err && err.stack || err)); console.log("FAIL"); process.exit(1); });
