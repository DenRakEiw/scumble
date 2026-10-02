// Ideogram 4.5 on Replicate (recipes/ideogram_4_5.json through electron/main/providers/replicate.js), in plain Node,
// no Electron, no key and no network:
//   node tools/ideogram45_test.js
// A scripted fetch plays api.replicate.com (the prediction POST answers "succeeded" at once, so nothing polls) and
// replicate.delivery (the output download). A fake codec stands in for Electron's nativeImage (bitmap / fromBitmap): its
// "PNG" is a real signature and IHDR followed by the raw RGBA, so the inverted mask is checked pixel for pixel. The
// pictures are small (64 x 48), so every picture goes as a data URI and is read back from the request body.
// The light tier (CLAUDE.md "Working rules"): the request shapes the recipe's variant sends, written from Replicate's
// schemas (docs/PLAN_IDEOGRAM45.md section 3), never run against the live API. Section 6 holds two other Replicate
// variants (FLUX.1 Fill, Nano Banana 2) to what they sent before the Ideogram options existed.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const PROV = path.join(ROOT, "electron", "main", "providers");
const rep = require(path.join(PROV, "replicate.js"));
const refs = require(path.join(PROV, "refs.js"));

const KEY = "r8_test0123456789abcdef0123456789";   // the shape of a Replicate token; never a real one
const API = "https://api.replicate.com/v1";
const OUT_URL = "https://replicate.delivery/x.png";
const ALL_CALLS = [];
const ERRORS = [];

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 500 ? s.slice(0, 500) + " ..." : s; };
async function section(name, fn) {
    console.log(`\n--- ${name} ---`);
    try { await fn(); } catch (err) { check(`${name}: ran through`, false, err && err.stack || String(err)); }
}

// ---- pictures: the fake codec (IHDR + raw RGBA), as tools/magnific_test.js has it ----------------------------------

function header(w, h, len, colour = 6) {
    const b = Buffer.alloc(len, 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    b[24] = 8;
    b[25] = colour;
    return b;
}
const sizeOf = (b) => (b && b.length >= 24 && b[0] === 0x89 ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null);
function rawPng(w, h, rgba) {
    const b = header(w, h, 33 + w * h * 4);
    Buffer.from(rgba.buffer ? Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength) : rgba).copy(b, 33);
    return b;
}
const codec = {
    bitmap(png) {
        const b = Buffer.from(png), s = sizeOf(b);
        if (!s || b.length !== 33 + s[0] * s[1] * 4) return null;
        return { width: s[0], height: s[1], data: b.subarray(33) };
    },
    fromBitmap(bm) { return rawPng(bm.width, bm.height, bm.data); },
};
/** A grey picture of the fake codec: fn(x, y) -> 0..255 (the mask's selection value, Scumble's white = repaint). */
function greyOf(w, h, fn) {
    const d = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = fn(x, y), j = (y * w + x) * 4; d[j] = v; d[j + 1] = v; d[j + 2] = v; d[j + 3] = 255; }
    return { width: w, height: h, data: d };
}
const maskPng = (w, h, fn) => codec.fromBitmap(greyOf(w, h, fn));
const imagePng = (w, h, k = 7) => codec.fromBitmap(greyOf(w, h, (x, y) => (x * k + y * 13) & 255));

const W = 64, H = 48;
const RECT = (x, y) => (x >= 16 && x < 40 && y >= 12 && y < 30 ? 255 : 0);   // the selection: a rectangle
const RAMP = (x) => Math.min(255, x * 4);                                    // 124 at x = 31, 128 at x = 32
const IMAGE = imagePng(W, H);
const RECT_MASK = maskPng(W, H, RECT);
const REF = [3, 5, 9, 11].map((k) => imagePng(32, 24, k));                   // four distinct reference layers
const RESULT = imagePng(8, 8, 17);

/** The bytes of a data URI the adapter sent, or null. */
const fromUri = (s) => { const m = /^data:image\/png;base64,(.*)$/s.exec(String(s)); return m ? Buffer.from(m[1], "base64") : null; };
const sameBytes = (uri, buf) => { const b = fromUri(uri); return !!b && Buffer.compare(b, Buffer.from(buf)) === 0; };
/** [r, g, b, a] of a sent mask at (x, y). */
function pixel(uri, x, y) {
    const bm = codec.bitmap(fromUri(uri) || Buffer.alloc(0));
    if (!bm) return null;
    const j = (y * bm.width + x) * 4;
    return [...bm.data.subarray(j, j + 4)];
}
/** null when the sent mask is Ideogram's inversion of fn (channel 0 >= 128 black, else white, opaque), else where not. */
function notInverted(uri, w, h, fn) {
    const bm = codec.bitmap(fromUri(uri) || Buffer.alloc(0));
    if (!bm || bm.width !== w || bm.height !== h) return `size ${bm ? bm.width + "x" + bm.height : "unreadable"}`;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const want = fn(x, y) >= 128 ? 0 : 255, j = (y * w + x) * 4;
            if (bm.data[j] !== want || bm.data[j + 1] !== want || bm.data[j + 2] !== want || bm.data[j + 3] !== 255) return `pixel ${x},${y} is ${[...bm.data.subarray(j, j + 4)]} for ${fn(x, y)}`;
        }
    }
    return null;
}

// ---- a fake Replicate ---------------------------------------------------------------------------------------------

function recordHeaders(init) {
    const h = {};
    for (const [k, v] of new Headers((init && init.headers) || {})) h[k.toLowerCase()] = v;
    return h;
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** POST /v1/models/<owner>/<name>/predictions answers a finished prediction, the output URL answers RESULT. */
function fakeServer() {
    const calls = [], posts = [], gets = [], strays = [];
    async function fetch(url, init = {}) {
        const method = String(init.method || "GET").toUpperCase();
        const call = { url: String(url), method, headers: recordHeaders(init) };
        calls.push(call);
        ALL_CALLS.push(call);
        const u = new URL(String(url));
        if (u.origin === "https://api.replicate.com" && method === "POST" && /^\/v1\/models\/[^/]+\/[^/]+\/predictions$/.test(u.pathname)) {
            const body = JSON.parse(init.body);
            posts.push({ ...call, body });
            return json(201, { id: "pred" + posts.length, status: "succeeded", output: [OUT_URL], metrics: {} });
        }
        if (String(url) === OUT_URL && method === "GET") {
            gets.push(call);
            return new Response(RESULT, { status: 200, headers: { "content-type": "image/png" } });
        }
        strays.push(call);
        return json(404, { detail: `not played by this test: ${method} ${url}` });
    }
    return { fetch, calls, posts, gets, strays };
}

async function run(req, more = {}) {
    const s = fakeServer();
    const ctx = { key: KEY, fetch: s.fetch, bitmap: codec.bitmap, fromBitmap: codec.fromBitmap, log: () => {}, ...more };
    let out = null, err = null;
    try { out = await (req.kind === "text" ? rep.generate(req, ctx) : rep.edit(req, ctx)); } catch (e) { err = String((e && e.message) || e); ERRORS.push(err); }
    const post = s.posts[0] || null;
    return { s, out, err, post, body: post && post.body, input: (post && post.body && post.body.input) || {} };
}
const keysOf = (o) => Object.keys(o || {}).sort();

// ---- the recipes as recipes.js serves them ------------------------------------------------------------------------

let NORMALIZE = null;
function loadRecipe(id) {
    if (!NORMALIZE) {
        const orig = Module._load;
        Module._load = function (request, ...rest) {
            if (request === "electron") return { app: { getPath: () => ROOT } };
            return orig.call(this, request, ...rest);
        };
        try { NORMALIZE = require(path.join(ROOT, "electron", "main", "recipes.js"))._normalize; } finally { Module._load = orig; }
    }
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, "recipes", id + ".json"), "utf8"));
    r.id = r.id || id;
    r.kind = r.kind === "provider" ? "provider" : "comfy";
    return NORMALIZE(r);
}
/** The values the Settings panel starts with, plus the fixed ones (host.js providerParams). */
function defaults(rows, fixed) {
    const p = {};
    for (const s of rows || []) p[s.key] = s.spec[1] && s.spec[1].default !== undefined ? s.spec[1].default : (Array.isArray(s.spec[0]) ? s.spec[0][0] : undefined);
    return { ...p, ...(fixed || {}) };
}
function fillReq(v, extra = {}) {
    return { provider: "replicate", model: v.model, kind: v.input === "fill" ? "fill" : "edit", prompt: "a red door", negative: "", seed: 7, width: W, height: H, aspect: null, image: IMAGE, mask: RECT_MASK, maskAlpha: null, references: [], original: 0, fields: v.fields || null, options: v.options || null, params: defaults(v.settings, v.fixed), ...extra };
}
function textReq(v, extra = {}) {
    return { provider: "replicate", model: v.text.model, kind: "text", prompt: "a lighthouse at dusk", negative: "", seed: 7, width: 1024, height: 1024, aspect: null, image: null, mask: null, maskAlpha: null, references: [], original: 0, fields: v.fields || null, options: v.options || null, params: defaults(v.text.settings, v.text.fixed), ...extra };
}

const EDIT_MODEL = "ideogram-ai/ideogram-4-5-precise-edit";
const TEXT_MODEL = "ideogram-ai/ideogram-4-5";
const WHO = `Replicate ${EDIT_MODEL}`;

async function main() {
    const R = loadRecipe("ideogram_4_5");
    const V = R.providers.replicate;

    // ---- 0. the recipe ----
    await section("0. the recipe", async () => {
        check("ideogram_4_5: a provider recipe, Replicate its default, the variant a fill on the Precise Edit model", R.kind === "provider" && R.default === "replicate" && R.task === "edit" && V.model === EDIT_MODEL && V.input === "fill" && V.edit === true, short({ kind: R.kind, default: R.default, model: V.model, input: V.input }));
        check("fields: image, mask, references as reference_images", eq(V.fields, { image: "image", mask: "mask", references: "reference_images" }), short(V.fields));
        const o = V.options || {};
        check("options: mask black, max_images 4, max_ratio 6, max_bytes 25 MB, seed_max 2147483647, negative false, seven sizes, very_low as low on a text run", o.mask === "black" && o.max_images === 4 && o.max_ratio === 6 && o.max_bytes === 25000000 && o.seed_max === 2147483647 && o.negative === false && eq(o.sizes, ["1024x1024", "1280x896", "896x1280", "1344x768", "768x1344", "1536x640", "640x1536"]) && eq(o.text_values, { quality: { very_low: "low" } }), short(o));
        check("the text shape: the ideogram-4-5 model, the edit's fixed num_images 1 and its Quality row (default medium)", V.text && V.text.model === TEXT_MODEL && eq(V.text.fixed, { num_images: 1 }) && eq(defaults(V.text.settings, V.text.fixed), { quality: "medium", num_images: 1 }), short(V.text));
        check("limits: the recipe's ratio 6 (1:6 .. 6:1) on the variant, the default 2048 / 256 / 16 kept", V.limits && V.limits.ratio === 6 && V.limits.max === 2048 && V.limits.min === 256 && V.limits.step === 16, short(V.limits));
        check("the edit's Settings values: quality medium, num_images 1", eq(defaults(V.settings, V.fixed), { quality: "medium", num_images: 1 }), short(defaults(V.settings, V.fixed)));
    });

    // ---- 1. a fill ----
    await section("1. a fill", async () => {
        const req = fillReq(V, { negative: "blurry, low quality", seed: 7 });
        const x = await run(req);
        check("one POST to /v1/models/ideogram-ai/ideogram-4-5-precise-edit/predictions, then the output's download, nothing else", !x.err && x.s.posts.length === 1 && x.post.url === `${API}/models/${EDIT_MODEL}/predictions` && x.s.gets.length === 1 && x.s.calls.length === 2 && !x.s.strays.length, x.err || short(x.s.calls.map((c) => `${c.method} ${c.url}`)));
        check("the body is { input } alone (a versionless model: no version)", !x.err && eq(keysOf(x.body), ["input"]), short(keysOf(x.body)));
        check("the input holds prompt, seed, image, mask, quality and num_images, nothing else", !x.err && eq(keysOf(x.input), ["image", "mask", "num_images", "prompt", "quality", "seed"]), short(keysOf(x.input)));
        check("no negative_prompt although the request has a negative (options.negative false)", !x.err && !("negative_prompt" in x.input), short(x.input.negative_prompt));
        check("no size, no aspect_ratio, no output_format on an edit", !x.err && !("size" in x.input) && !("aspect_ratio" in x.input) && !("output_format" in x.input), short(keysOf(x.input)));
        check("the prompt as written, quality medium, num_images 1, seed 7", x.input.prompt === "a red door" && x.input.quality === "medium" && x.input.num_images === 1 && x.input.seed === 7, short({ ...x.input, image: undefined, mask: undefined }));
        check("the image is the crop as sent, byte for byte, as a PNG data URI", sameBytes(x.input.image, IMAGE), short(String(x.input.image).slice(0, 40)));
        const bad = notInverted(x.input.mask, W, H, RECT);
        check("the mask is Scumble's inverted, every pixel: the selected rectangle black (edit), the rest white, opaque", !x.err && bad === null, bad);
        check("... spot pixels: (16,12) and (39,29) black, (15,12), (40,29), (0,0) and (63,47) white", eq(pixel(x.input.mask, 16, 12), [0, 0, 0, 255]) && eq(pixel(x.input.mask, 39, 29), [0, 0, 0, 255]) && eq(pixel(x.input.mask, 15, 12), [255, 255, 255, 255]) && eq(pixel(x.input.mask, 40, 29), [255, 255, 255, 255]) && eq(pixel(x.input.mask, 0, 0), [255, 255, 255, 255]) && eq(pixel(x.input.mask, 63, 47), [255, 255, 255, 255]), short([pixel(x.input.mask, 16, 12), pixel(x.input.mask, 15, 12)]));
        check("... and it is not the mask as given", !sameBytes(x.input.mask, RECT_MASK));
        const y = await run(fillReq(V, { mask: maskPng(W, H, RAMP) }));
        const badRamp = notInverted(y.input.mask, W, H, RAMP);
        check("a grey ramp: 128 and above black, below white (x = 31 at 124 white, x = 32 at 128 black)", !y.err && badRamp === null && eq(pixel(y.input.mask, 31, 0), [255, 255, 255, 255]) && eq(pixel(y.input.mask, 32, 0), [0, 0, 0, 255]), y.err || badRamp);
        check("the answer: the downloaded picture, the model and the prediction id in info, no info.mask for a partial selection", !x.err && Buffer.compare(Buffer.from(x.out.bytes), RESULT) === 0 && x.out.mime === "image/png" && x.out.info.model === EDIT_MODEL && x.out.info.id === "pred1" && !("mask" in x.out.info), x.err || short(x.out && x.out.info));
        check("the POST carries the token, JSON and Prefer: wait=30; the download carries no token", x.post.headers.authorization === "Bearer " + KEY && x.post.headers["content-type"] === "application/json" && x.post.headers.prefer === "wait=30" && x.s.gets.length === 1 && !("authorization" in x.s.gets[0].headers), short([x.post.headers, x.s.gets[0] && x.s.gets[0].headers]));
    });

    // ---- 2. a selection over the whole crop, and one with nothing to edit ----
    await section("2. whole and empty selections", async () => {
        let x = await run(fillReq(V, { mask: maskPng(W, H, () => 255) }));
        check("the mask all 255 (the whole crop selected): sent without a mask key, the crop still goes", !x.err && !("mask" in x.input) && sameBytes(x.input.image, IMAGE) && x.s.posts.length === 1, x.err || short(keysOf(x.input)));
        check("... and the answer's info.mask says so", !x.err && x.out.info.mask === "none: the selection covers the whole crop, so the whole crop was edited", short(x.out && x.out.info));
        x = await run(fillReq(V, { mask: maskPng(W, H, (xx) => (xx === 0 ? 128 : 255)) }));
        check("a mask at 128 or more everywhere also counts as the whole crop (no mask key)", !x.err && !("mask" in x.input) && /^none: /.test(x.out.info.mask || ""), x.err || short(keysOf(x.input)));
        x = await run(fillReq(V, { mask: maskPng(W, H, () => 0) }));
        check("the mask all 0: refused in words, no fetch at all", x.err === `${WHO}: the selection holds no pixel at half strength or more, so the model would have nothing to edit. Select the area to change.` && x.s.calls.length === 0, x.err);
        x = await run(fillReq(V, { mask: maskPng(W, H, () => 127) }));
        check("the mask all 127 (under half strength): refused the same way, no fetch", /holds no pixel at half strength or more/.test(x.err || "") && x.s.calls.length === 0, x.err);
        x = await run(fillReq(V, { mask: maskPng(32, H, () => 255) }));
        check("a mask of another size than the crop: refused, no fetch", x.err === `${WHO}: the mask is 32 × 48 and the picture 64 × 48; Ideogram takes a mask of the picture's own size.` && x.s.calls.length === 0, x.err);
    });

    // ---- 2b. the crop's shape and the bytes of each picture, before any upload ----
    await section("2b. shape and bytes", async () => {
        const strip = (w, h) => fillReq(V, { image: imagePng(w, h), mask: maskPng(w, h, (xx) => (xx < 8 ? 255 : 0)), width: w, height: h });
        let x = await run(strip(64, 8));
        check("a crop of 64 x 8 (8:1) is refused before any request", x.err === `${WHO} takes pictures no steeper than 6:1; the crop is 64 × 8, and the picture is too narrow to widen it. Nothing was sent.` && x.s.calls.length === 0, x.err);
        x = await run(strip(8, 64));
        check("... and 8 x 64 (1:8) too", /no steeper than 6:1; the crop is 8 × 64/.test(x.err || "") && x.s.calls.length === 0, x.err);
        x = await run(strip(60, 10));
        check("a crop of 60 x 10 (6:1) goes", !x.err && x.s.posts.length === 1, x.err);
        const small = { ...V.options, max_bytes: IMAGE.length - 1 };
        const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
        const asJpeg = (uri) => { const m = /^data:image\/jpeg;base64,(.*)$/s.exec(String(uri)); return m ? Buffer.from(m[1], "base64") : null; };
        x = await run(fillReq(V, { options: small, references: [REF[0]] }), { opaque: () => true, toJpeg: () => JPEG });
        check("an opaque crop and mask over max_bytes go as JPEG data URIs, a reference under it as PNG", !x.err && Buffer.compare(asJpeg(x.input.image) || Buffer.alloc(0), JPEG) === 0 && Buffer.compare(asJpeg(x.input.mask) || Buffer.alloc(0), JPEG) === 0 && sameBytes(x.input.reference_images[0], REF[0]), x.err || short({ image: String(x.input.image).slice(0, 30), mask: String(x.input.mask).slice(0, 30) }));
        x = await run(fillReq(V, { options: small }), { opaque: () => false, toJpeg: () => JPEG });
        check("a crop with transparency over max_bytes is refused in words, no fetch", x.err === `${WHO}: the crop is ${(IMAGE.length / 1e6).toFixed(1)} MB, more than the 0 MB a picture may have (it has transparency, so it stays PNG). Set Highres fix lower or use a smaller reference layer. Nothing was sent.` && x.s.calls.length === 0, x.err);
        const BIG = imagePng(80, 60);   // larger than the crop, so only the reference trips the cap
        x = await run(fillReq(V, { options: { ...V.options, max_bytes: IMAGE.length }, references: [BIG] }), { opaque: () => true, toJpeg: () => Buffer.alloc(BIG.length) });
        check("a reference still over max_bytes as JPEG is refused, naming it, no fetch", /the reference picture 1 is .* MB, more than the .* MB a picture may have even as JPEG/.test(x.err || "") && x.s.calls.length === 0, x.err);
    });

    // ---- 3. the seed ----
    await section("3. the seed", async () => {
        let x = await run(fillReq(V, { seed: 4000000000 }));
        check("seed 4000000000 goes as 4000000000 % 2147483648 = 1852516352", !x.err && x.input.seed === 4000000000 % 2147483648 && x.input.seed === 1852516352, short(x.input.seed));
        check("... and the answer reports the seed sent", !x.err && x.out.seed === 1852516352, short(x.out && x.out.seed));
        x = await run(fillReq(V, { seed: 2147483647 }));
        const y = await run(fillReq(V, { seed: 2147483648 }));
        check("2147483647 stays, 2147483648 wraps to 0", x.input.seed === 2147483647 && y.input.seed === 0, short([x.input.seed, y.input.seed]));
        x = await run(fillReq(V, { seed: 4000000000, params: { ...defaults(V.settings, V.fixed), random_seed: true } }));
        check("params.random_seed true: no seed and no random_seed key", !x.err && !("seed" in x.input) && !("random_seed" in x.input) && x.input.quality === "medium", x.err || short(keysOf(x.input)));
    });

    // ---- 4. reference layers ----
    await section("4. references", async () => {
        let x = await run(fillReq(V));
        check("no reference layer: no reference_images key", !x.err && !("reference_images" in x.input), short(keysOf(x.input)));
        x = await run(fillReq(V, { references: [REF[0], REF[1]] }));
        const list = x.input.reference_images;
        check("2 references: reference_images of 2 data URIs in order, the crop still in image, the mask still inverted", !x.err && Array.isArray(list) && list.length === 2 && sameBytes(list[0], REF[0]) && sameBytes(list[1], REF[1]) && sameBytes(x.input.image, IMAGE) && notInverted(x.input.mask, W, H, RECT) === null, x.err || short(Array.isArray(list) ? list.map((s) => String(s).slice(0, 30)) : list));
        x = await run(fillReq(V, { references: REF.slice(0, 3) }));
        check("3 references (crop + 3 = 4, the cap): all three go", !x.err && x.input.reference_images.length === 3 && sameBytes(x.input.reference_images[2], REF[2]), x.err);
        x = await run(fillReq(V, { references: REF.slice(0, 4) }));
        check("4 references (crop + 4 = 5 > max 4): refused before any fetch", x.err === `${WHO} takes at most 4 pictures; this run has 5: hide reference layers or turn Original off.` && x.s.calls.length === 0, x.err);
        x = await run(fillReq(V, { references: REF.slice(0, 4), mask: maskPng(W, H, () => 0) }));
        check("... the count is refused before the mask is read (4 references and an empty mask: the count's message)", /takes at most 4 pictures; this run has 5/.test(x.err || "") && x.s.calls.length === 0, x.err);

        const req2 = fillReq(V, { references: [REF[0], REF[1]] });
        const lay = rep.layout(req2);
        const pics = lay.pictures.map((p) => [p.role, p.ref === undefined ? null : p.ref, p.field, p.n]);
        check("layout for 2 references: style true, max 4, no drops", lay.style === true && lay.max === 4 && lay.drops === null, short(lay));
        check("... the crop numbered 1 in input.image, the mask in input.mask unnumbered, the references unnumbered in input.reference_images[i]", eq(pics, [["crop", null, "input.image", 1], ["mask", null, "input.mask", null], ["reference", 0, "input.reference_images[0]", null], ["reference", 1, "input.reference_images[1]", null]]), short(pics));
        let ok = true, why = "";
        try { refs.checkLayout(lay, { ...req2, provider: "replicate" }); } catch (e) { ok = false; why = String(e.message); }
        check("... refs.checkLayout accepts it, and it counts 3 pictures (the mask in its own field is not counted)", ok && refs.countOf(lay) === 3, why || String(refs.countOf(lay)));
        let e = null;
        try { refs.checkPictures(lay, { ...req2, prompt: "the hat from {@ref:1}" }, WHO); } catch (err) { e = String(err.message); }
        check("... so a prompt naming a reference is refused by checkPictures (unnumbered references)", /sends reference layers without a number/.test(e || ""), e);
        const lay4 = rep.layout(fillReq(V, { references: REF.slice(0, 4) }));
        check("layout for 4 references counts 5 against max 4 (what index.js refuses before the adapter)", refs.countOf(lay4) === 5 && lay4.max === 4, short([refs.countOf(lay4), lay4.max]));
    });

    // ---- 5. a text run (Generate new) ----
    await section("5. text runs", async () => {
        let x = await run(textReq(V, { aspect: "16:9", width: 2048, height: 1152, negative: "blurry" }));
        check("one POST to /v1/models/ideogram-ai/ideogram-4-5/predictions, then the download", !x.err && x.s.posts.length === 1 && x.post.url === `${API}/models/${TEXT_MODEL}/predictions` && x.s.gets.length === 1 && !x.s.strays.length, x.err || short(x.s.calls.map((c) => `${c.method} ${c.url}`)));
        check("the input holds prompt, seed, quality, num_images and size, nothing else", !x.err && eq(keysOf(x.input), ["num_images", "prompt", "quality", "seed", "size"]), short(keysOf(x.input)));
        check("no image, mask, reference_images, aspect_ratio or negative_prompt", !["image", "mask", "reference_images", "images", "aspect_ratio", "negative_prompt"].some((k) => k in x.input), short(keysOf(x.input)));
        check("aspect 16:9: size 1344x768", x.input.size === "1344x768", short(x.input.size));
        x = await run(textReq(V, { aspect: null, width: 640, height: 1536 }));
        check("no aspect and 640 x 1536: size 640x1536, no aspect_ratio", !x.err && x.input.size === "640x1536" && !("aspect_ratio" in x.input), x.err || short(x.input));
        x = await run(textReq(V, { aspect: "1:1", width: 2048, height: 1152 }));
        check("aspect 1:1 (whatever the size): size 1024x1024", !x.err && x.input.size === "1024x1024" && !("aspect_ratio" in x.input), x.err || short(x.input));
        x = await run(textReq(V, { aspect: "3:2" }));
        const y = await run(textReq(V, { aspect: "9:16" }));
        const z = await run(textReq(V, { aspect: "21:9" }));
        check("aspect 3:2 -> 1280x896, 9:16 -> 768x1344, 21:9 -> 1536x640", x.input.size === "1280x896" && y.input.size === "768x1344" && z.input.size === "1536x640", short([x.input.size, y.input.size, z.input.size]));
        x = await run(textReq(V, { params: { ...defaults(V.text.settings, V.text.fixed), quality: "very_low" } }));
        const hi = await run(textReq(V, { params: { ...defaults(V.text.settings, V.text.fixed), quality: "high" } }));
        const med = await run(textReq(V));
        check("quality very_low goes as low, high stays high, the default medium stays medium", !x.err && x.input.quality === "low" && hi.input.quality === "high" && med.input.quality === "medium", short([x.input.quality, hi.input.quality, med.input.quality]));
        const edit = await run(fillReq(V, { params: { ...defaults(V.settings, V.fixed), quality: "very_low" } }));
        check("... while an edit keeps very_low (text_values is the text run's only)", !edit.err && edit.input.quality === "very_low", short(edit.input.quality));
        x = await run(textReq(V, { seed: 4000000000 }));
        const r = await run(textReq(V, { seed: 4000000000, params: { ...defaults(V.text.settings, V.text.fixed), random_seed: true } }));
        check("the seed held under 2^31 on a text run too (4000000000 -> 1852516352); random_seed sends none", !x.err && x.input.seed === 1852516352 && !("seed" in r.input) && !("random_seed" in r.input), short([x.input.seed, keysOf(r.input)]));
        x = await run(textReq(V, { references: [REF[0], REF[1]] }));
        const lay = rep.textLayout(textReq(V, { references: [REF[0], REF[1]] }));
        check("a text run called directly with 2 references sends no picture (textLayout declares the drop)", !x.err && eq(keysOf(x.input), ["num_images", "prompt", "quality", "seed", "size"]) && typeof lay.drops === "string" && lay.drops.length > 0 && lay.pictures.length === 0, x.err || short({ input: keysOf(x.input), lay }));
    });

    // ---- 6. other Replicate variants unchanged ----
    await section("6. other Replicate variants", async () => {
        const F = loadRecipe("flux1_fill").providers.replicate;
        check("flux1_fill's Replicate variant: a fill without options (so no mask, negative or seed rule of its own)", F.model === "black-forest-labs/flux-fill-pro" && F.input === "fill" && !F.options, short({ model: F.model, input: F.input, options: F.options }));
        let x = await run(fillReq(F, { negative: "blurry", seed: 4000000000 }));
        check("FLUX.1 Fill: POST to /v1/models/black-forest-labs/flux-fill-pro/predictions", !x.err && x.post.url === `${API}/models/black-forest-labs/flux-fill-pro/predictions`, x.err || short(x.post && x.post.url));
        check("... the mask goes exactly as given (not inverted)", sameBytes(x.input.mask, RECT_MASK), short(String(x.input.mask).slice(0, 40)));
        check("... negative_prompt goes, the seed goes uncapped (4000000000), output_format png and its four rows", x.input.negative_prompt === "blurry" && x.input.seed === 4000000000 && x.input.output_format === "png" && x.input.steps === 50 && x.input.guidance === 60 && x.input.safety_tolerance === 2 && x.input.prompt_upsampling === false && !("size" in x.input) && !("reference_images" in x.input), short({ ...x.input, image: undefined, mask: undefined }));
        x = await run(fillReq(F, { mask: maskPng(W, H, () => 255) }));
        check("... a whole-crop mask still goes as given, no info.mask", !x.err && sameBytes(x.input.mask, maskPng(W, H, () => 255)) && !("mask" in x.out.info), x.err || short(x.out && x.out.info));

        const N = loadRecipe("nano_banana_2").providers.replicate;
        check("nano_banana_2's Replicate variant: the text model is google/nano-banana-2, no sizes option", N.text && N.text.model === "google/nano-banana-2" && !(N.options && N.options.sizes), short({ text: N.text, options: N.options }));
        x = await run(textReq(N, { aspect: "16:9", width: 2048, height: 1152, negative: "blurry" }));
        check("Nano Banana 2 text run with aspect 16:9: POST to its model, aspect_ratio 16:9 (not the fixed match_input_image), no size", !x.err && x.post.url === `${API}/models/google/nano-banana-2/predictions` && x.input.aspect_ratio === "16:9" && !("size" in x.input) && x.input.resolution === "2K" && x.input.output_format === "png", x.err || short(x.input));
        check("... no picture field and the seed as given (no seed_max)", !("image_input" in x.input) && !("image" in x.input) && x.input.seed === 7, short(keysOf(x.input)));
        x = await run(textReq(N, { aspect: null, width: 640, height: 1536 }));
        check("Nano Banana 2 text run without an aspect (640 x 1536): the closest aspect preset 9:16, no size", !x.err && x.input.aspect_ratio === "9:16" && !("size" in x.input), x.err || short(x.input));
    });

    // ---- 7. the whole run ----
    const api = ALL_CALLS.filter((c) => c.url.startsWith(API + "/"));
    const downloads = ALL_CALLS.filter((c) => c.url === OUT_URL);
    check("the token went on every api.replicate.com call and never on a download; no call outside the two hosts", ALL_CALLS.length > 40 && api.length + downloads.length === ALL_CALLS.length && api.every((c) => c.headers.authorization === "Bearer " + KEY) && downloads.every((c) => !("authorization" in c.headers)), `${ALL_CALLS.length} calls, ${api.length} to the API, ${downloads.length} downloads`);
    check("the token appears in no error of the run", ERRORS.length >= 5 && !ERRORS.some((m) => m.includes(KEY)), `${ERRORS.length} errors`);

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + (err && err.stack || err)); console.log("FAIL"); process.exit(1); });
