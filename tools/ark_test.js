// The BytePlus ModelArk adapter (electron/main/providers/ark.js), its two recipe variants and its wiring in
// providers/index.js and recipes.js, in plain Node, no Electron and no key:
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

const EDIT_PREFIX = "Edit the first image and keep its size and framing.";
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
        check("the answer: the bytes of data[0].b64_json, image/png from the bytes, the seed as asked", out.bytes.equals(RESULT) && out.mime === "image/png" && out.seed === 42, short({ mime: out.mime, seed: out.seed, tag: tagOf(out.bytes) }));
        check("info: the answer's model, region ap-southeast, the size sent, the size answered, usage.generated_images", out.info.model === PRO_ID && out.info.region === "ap-southeast" && out.info.size === "1536x1024" && out.info.answered === "1536x1008" && out.info.generated_images === 1, short(out.info));
        check("info.pictures names what went in", eq(out.info.pictures, ["crop png", "reference 1 png", "reference 2 png"]), short(out.info.pictures));

        const s1 = fakeServer();
        await ark.edit(editReq(v, { references: [refs[0]] }), ctxFor(s1));
        check("one reference: the singular sentence", s1.posts[0].body.prompt === `${EDIT_PREFIX} a red door ${REF_ONE}` && picsOf(s1.posts[0].body).length === 2, s1.posts[0].body.prompt);
        const s0 = fakeServer();
        await ark.edit(editReq(v), ctxFor(s0));
        check("no reference: the edit sentence and the prompt only, the crop alone", s0.posts[0].body.prompt === `${EDIT_PREFIX} a red door` && picsOf(s0.posts[0].body).length === 1 && picsOf(s0.posts[0].body)[0].bytes.equals(editReq(v).image), s0.posts[0].body.prompt);

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

        // a text run (Generate new): the same endpoint without image
        const st = fakeServer();
        const ot = await ark.generate(textReq(v, { aspect: "16:9", width: 1024, height: 576, references: [pngOf(64, 64, 40, "IGNORED")], image: pngOf(64, 64, 40, "IGNORED2") }), ctxFor(st));
        const tb = st.posts[0] && st.posts[0].body;
        check("a text run: one POST to the same endpoint", st.calls.length === 1 && st.calls[0].url === BASE + PATH, st.calls.map((c) => c.url).join(", "));
        check("a text run sends no image, even when the request carries a picture and references", !!tb && eq(Object.keys(tb).sort(), TEXT_KEYS), tb && Object.keys(tb).sort().join(","));
        check("a text run: the prompt as it is, the size of the asked aspect, watermark false, b64_json, png", !!tb && tb.prompt === "a lighthouse at dusk" && tb.size === "1280x720" && tb.watermark === false && tb.response_format === "b64_json" && tb.output_format === "png" && tb.model === PRO_ID, short(tb));
        check("a text run's answer: the bytes, no pictures in info", ot.bytes.equals(RESULT) && eq(ot.info.pictures, []) && ot.info.size === "1280x720", short(ot.info));

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
        check("exactly the two Seedream 5.0 recipes carry an ark variant, both builtin", eq(served.map((r) => r.id).sort(), ["seedream_5_lite", "seedream_5_pro"]) && served.every((r) => r.source === "builtin"), served.map((r) => r.id).join(", "));
        const want = {
            seedream_5_pro: { model: PRO_ID, pixels: PRO_PIXELS, max_images: 10, regions: ["ap-southeast"], sizes: [1280, 1536, 2048] },
            seedream_5_lite: { model: LITE_ID, pixels: LITE_PIXELS, max_images: 14, regions: ["ap-southeast", "eu-west"], sizes: [2560, 3072, 4096] },
        };
        const bad = [];
        let runs = 0;
        for (const r of served) {
            const w = want[r.id];
            const raw = rawRecipe(r.id);
            const v = r.providers.ark;
            const o = v.options || {};
            const ids = r.providerIds;
            if (ids.indexOf("ark") !== ids.indexOf("toapis") + 1 || ids.indexOf("toapis") < 0) bad.push(`${r.id}: ark is not right after toapis (${ids.join(",")})`);
            if (r.default !== "fal" || raw.default !== "fal") bad.push(`${r.id}: the default is ${r.default} (file ${raw.default}), not fal`);
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
            if ((v.settings || []).some((st) => st.key !== "region")) bad.push(`${r.id}: a setting other than region`);
            if (!/not run against the live API yet/.test(String(v.note || ""))) bad.push(`${r.id}: the note lacks the live-test sentence`);
            if (!/Also on BytePlus ModelArk/.test(String(r.description || ""))) bad.push(`${r.id}: the description does not say Also on BytePlus ModelArk`);
            // an edit with the Region row's default, and a text run, against the fake server
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
            // each region the row offers goes to its host with a real key
            for (const region of o.regions) {
                const sr = fakeServer();
                await ark.edit(editReq(v, { params: { region } }), ctxFor(sr, { key: REAL_KEY, base: undefined }));
                if (!(sr.calls.length === 1 && sr.calls[0].url === ark.REGIONS[region] + PATH)) bad.push(`${r.id} ${region}: ${sr.calls.map((c) => c.url).join(",")}`);
            }
            runs++;
        }
        check("each ark variant: right after toapis, the default fal kept, its model id, input edit, the text shape and sizes, options.pixels = limits (pixels, minPixels, ratio 16, step 16), max_images, png, regions and the Region row, the notes; each builds an edit and a text request and reaches each region's host", !bad.length && runs === 2, bad.join("; ") || `${runs} variants`);

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
