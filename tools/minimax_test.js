// The MiniMax adapter (electron/main/providers/minimax.js), its recipe and its wiring in providers/index.js and
// recipes.js, in plain Node, no Electron and no key:
//   node tools/minimax_test.js
// A scripted fetch plays both MiniMax hosts and the loopback mock; section 8 sends through the real fetch to a loopback
// server of its own. Every call of the whole run is recorded with all its headers, and the last checks say that no
// call carried a header beyond the two the API names, that each key only went where it may, and that neither key is in
// any error of the run. The facts the checks rest on are MiniMax's API reference as read on 2026-11-10; nothing here
// talks to the live API.
// In brackets after a check, where it is not obvious: the bug that turns it red.
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const RECIPES = path.join(ROOT, "recipes");
const minimax = require(path.join(ROOT, "electron", "main", "providers", "minimax.js"));

const KEY = "test-minimax-0123456789";            // a test key goes to the loopback mock only
const REAL_KEY = "eyJhbGciOi-real-minimax-key";   // a real key never does
const BASE = "http://127.0.0.1:5557";
const INTL = "https://api.minimax.io";
const CN = "https://api.minimax.cn";
const EDITS = "/v1/images/edits";
const GENERATIONS = "/v1/images/generations";
const MODEL = "MiniMax-H3-Image";
const FAST = "MiniMax-H3-Image-Highspeed";
const MIB = 1024 * 1024;
const ALL_CALLS = [];
const ERRORS = [];

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${ok || !detail ? "" : ": " + detail}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 400 ? s.slice(0, 400) + " ..." : s; };

/** A PNG as far as the adapter looks: the signature, a real IHDR and padding. */
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
function jpegOf(size, tag = "") {
    const b = Buffer.alloc(Math.max(size, 33 + tag.length), 0);
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(b);
    b.write(tag, 33, "latin1");
    return b;
}
const tagOf = (b) => Buffer.from(b).toString("latin1", 33, 33 + 16).replace(/\0+$/, "");
const RESULT = pngOf(2048, 2048, 80, "RESULT");
const fromDataUrl = (url) => { const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(url || "")); return m ? { mime: m[1], bytes: Buffer.from(m[2], "base64") } : null; };
const picsOf = (body) => (body && body.images ? body.images.map((x) => fromDataUrl(x.image_url)) : []);

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const okFor = (body) => json(200, { created: 1789000000, data: [{ b64_json: RESULT.toString("base64"), size: body.size, revised_prompt: "revised" }], output_format: "png", usage: { images: 1 }, request_id: "req-1" });
const failure = (status, type, message) => json(status, { type: "error", error: { type, message, http_code: String(status) }, request_id: "req-err" });
const itemFailure = (code, message) => json(200, { created: 1, data: [{ error: { code, message } }], output_format: "png", request_id: "req-item" });

function recordHeaders(init) {
    const h = {};
    for (const [k, v] of new Headers((init && init.headers) || {})) h[k.toLowerCase()] = v;
    return h;
}

/** A fake MiniMax: `answers` in order (functions of the parsed body; one that throws is a network error), then every request succeeds. Any host answers. */
function fakeServer(opts = {}) {
    const calls = [], posts = [];
    const answers = [...(opts.answers || [])];
    async function fetch(url, init = {}) {
        const method = String(init.method || "GET").toUpperCase();
        const call = { url: String(url), method, headers: recordHeaders(init), init };
        calls.push(call);
        ALL_CALLS.push(call);
        const body = JSON.parse(init.body);
        posts.push({ url: String(url), body });
        const a = answers.shift();
        return a ? a(body) : okFor(body);
    }
    return { fetch, calls, posts };
}

const ctxOf = (s, extra = {}) => ({ key: KEY, fetch: s.fetch, base: BASE, ...extra });
const editReq = (extra = {}) => ({ provider: "minimax", model: MODEL, kind: "edit", prompt: "a red door", negative: "blurry", seed: 7, image: pngOf(1024, 768, 96, "CROP"), mask: pngOf(1024, 768, 96, "MASK"), maskAlpha: pngOf(1024, 768, 96, "ALPHA"), width: 1024, height: 768, references: [], original: 0, params: {}, refName: "image {n}", ...extra });
const textReq = (extra = {}) => ({ provider: "minimax", model: MODEL, kind: "text", prompt: "a lighthouse at dusk", negative: "blurry", seed: 7, image: null, mask: null, maskAlpha: null, width: 2048, height: 2048, aspect: null, references: [], params: {}, ...extra });

async function section(name, fn) {
    try { await fn(); } catch (err) { check(name + " ran to its end", false, String(err && err.stack || err).split(/\r?\n/).slice(0, 3).join(" ")); }
}
async function throws(fn) {
    try { await fn(); } catch (err) { const m = String(err && err.message || err); ERRORS.push(m); return m; }
    return null;
}
const dims = (s) => String(s).split("x").map(Number);
const EDIT_KEYS = ["images", "model", "n", "output_format", "prompt", "response_format", "size"];
const TEXT_KEYS = ["model", "n", "output_format", "prompt", "response_format", "size"];

async function main() {
    // ---- 1. an edit ----
    await section("1. edit", async () => {
        const s = fakeServer();
        const refs = [pngOf(640, 480, 70, "ORIGINAL"), pngOf(480, 640, 70, "REF1"), pngOf(512, 512, 70, "REF2")];
        const out = await minimax.edit(editReq({ references: refs, original: 1 }), ctxOf(s));
        const p = s.posts[0], c = s.calls[0];
        check("one POST, to /v1/images/edits on the host in use", s.calls.length === 1 && c.method === "POST" && c.url === BASE + EDITS, short(s.calls.map((x) => x.url)));
        check("the two headers: Bearer key and JSON", c.headers.authorization === "Bearer " + KEY && c.headers["content-type"] === "application/json", short(c.headers));
        check("the body holds exactly the documented fields (bug: a mask, seed, negative, aspect_ratio, area, stream, disable_prompt_enhanced goes out)", eq(Object.keys(p.body).sort(), EDIT_KEYS), short(Object.keys(p.body)));
        check("model, n 1, PNG, base64", p.body.model === MODEL && p.body.n === 1 && p.body.output_format === "png" && p.body.response_format === "b64_json", short({ ...p.body, images: undefined }));
        const pics = picsOf(p.body);
        check("images: each { image_url } a PNG data URL", p.body.images.every((x) => eq(Object.keys(x), ["image_url"]) && x.image_url.startsWith("data:image/png;base64,")) && pics.length === 4);
        check("the order is the picture number: the crop, the Original, then the references (bug: references before the crop)", eq(pics.map((x) => tagOf(x.bytes)), ["CROP", "ORIGINAL", "REF1", "REF2"]), short(pics.map((x) => tagOf(x.bytes))));
        check("the mask never goes", !pics.some((x) => tagOf(x.bytes) === "MASK" || tagOf(x.bytes) === "ALPHA"));
        check("the prompt names the pictures by their place, the user's text kept", p.body.prompt === "Edit image 1 and keep its size and framing. a red door Image 2 is image 1 before the selected area was filled. Images 3 and 4 are reference images.", p.body.prompt);
        check("the answer: the bytes, PNG, no seed", Buffer.from(out.bytes).equals(RESULT) && out.mime === "image/png" && out.seed === undefined);
        check("info: model, region, sizes, pictures, the revised prompt, the request id", out.info.model === MODEL && out.info.size === p.body.size && out.info.answered === p.body.size && out.info.pictures.length === 4 && out.info.revised_prompt === "revised" && out.info.request_id === "req-1", short(out.info));
        const fast = fakeServer();
        await minimax.edit(editReq({ params: { speed: "Highspeed" } }), ctxOf(fast));
        check("the Speed row: Highspeed goes to MiniMax-H3-Image-Highspeed (bug: the row is ignored)", fast.posts[0].body.model === FAST, fast.posts[0].body.model);
        const unknown = fakeServer();
        const m = await throws(() => minimax.edit(editReq({ params: { speed: "__proto__" } }), ctxOf(unknown)));
        check("an unknown Speed is refused before any call (bug: Object.prototype names read as rows)", !!m && /Speed "__proto__"/.test(m) && unknown.calls.length === 0, m);
        const lay = minimax.layout(editReq({ references: refs, original: 1 }));
        check("layout() says what the builder sends: images[0] the crop, then the Original and the references, 16 at most", eq(lay.pictures.map((x) => [x.role, x.field, x.n]), [["crop", "images[0]", 1], ["original", "images[1]", 2], ["reference", "images[2]", 3], ["reference", "images[3]", 4]]) && lay.max === 16, short(lay));
    });

    // ---- 2. a new image ----
    await section("2. text", async () => {
        const s = fakeServer();
        await minimax.generate(textReq({ references: [pngOf(640, 480, 70, "REF")] }), ctxOf(s));
        const p = s.posts[0];
        check("a new image goes to /v1/images/generations (bug: the edit endpoint)", s.calls.length === 1 && s.calls[0].url === BASE + GENERATIONS, short(s.calls.map((x) => x.url)));
        check("the body holds exactly the documented fields, no images key", eq(Object.keys(p.body).sort(), TEXT_KEYS), short(Object.keys(p.body)));
        check("the prompt as it is", p.body.prompt === "a lighthouse at dusk", p.body.prompt);
        const empty = fakeServer();
        const m = await throws(() => minimax.generate(textReq({ prompt: "   " }), ctxOf(empty)));
        check("an empty prompt on a new image is refused before any call", !!m && /needs a prompt/.test(m) && empty.calls.length === 0, m);
        check("no textLayout: index.js leaves references out of a new image with a note", minimax.textLayout === undefined);
    });

    // ---- 3. sizes ----
    await section("3. sizes", async () => {
        const size = (r) => dims(minimax._size(r, MODEL));
        const edit = (w, h, row) => size({ kind: "edit", width: w, height: h, params: row ? { size: row } : {} });
        check("the Size row's areas: 1K, 2K, 4K on a square crop, 2K the default", eq(edit(1000, 1000, "1K"), [1024, 1024]) && eq(edit(1000, 1000, "2K"), [2048, 2048]) && eq(edit(1000, 1000, "4K"), [4096, 4096]) && eq(edit(1000, 1000), [2048, 2048]));
        check("a landscape crop keeps its shape at the row's area (bug: the size follows the crop's pixels, not the row)", (() => { const [a, b] = edit(640, 360, "2K"); return a % 16 === 0 && b % 16 === 0 && Math.abs(a / b - 640 / 360) < 0.02 && Math.abs(a * b / (2048 * 2048) - 1) < 0.05; })(), short(edit(640, 360, "2K")));
        let inRange = true;
        for (const row of ["1K", "2K", "4K"]) for (const [w, h] of [[3000, 1000], [1000, 3000], [1234, 777], [8192, 2731], [128, 384], [384, 128], [16000, 5400]]) {
            const [a, b] = edit(w, h, row);
            if (a * b < 655360 || a * b > 20000000 || Math.max(a, b) > 3 * Math.min(a, b) || a % 16 || b % 16) { inRange = false; console.log("   out of range:", row, w, h, a, b); }
        }
        check("every crop up to 3:1 at every row: 655,360 to 20,000,000 pixels, 1:3 to 3:1, multiples of 16 (bug: the snap tips a 3:1 crop past 3:1)", inRange);
        const steep = await throws(() => minimax._size({ kind: "edit", width: 3100, height: 1000, params: {} }, MODEL));
        check("a crop steeper than 3:1 is refused, not bent to fit (bug: fitPixels' ratio pull changes the shape)", !!steep && /no steeper than 3:1; the crop is 3100 × 1000/.test(steep), steep);
        check("the crop's PNG is the shape read, not a stale width and height", (() => { try { return eq(size({ kind: "edit", image: pngOf(1000, 1000), width: 3000, height: 1000, params: {} }), [2048, 2048]); } catch (_) { return false; } })());
        const text = (aspect, row) => size({ kind: "text", width: 1024, height: 1024, aspect, params: row ? { size: row } : {} });
        check("Generate new: exactly the asked aspect at the row's area, the dialog's own size ignored (bug: width and height decide)", eq(text("1:1"), [2048, 2048]) && eq(text("3:2", "2K"), [2496, 1664]) && eq(text("16:9", "2K"), [2816, 1584]) && eq(text("21:9", "2K"), [3136, 1344]), short([text("1:1"), text("3:2", "2K"), text("16:9", "2K"), text("21:9", "2K")]));
        const big = text("16:9", "4K"), small = text("16:9", "1K");
        check("the row moves the aspect's area, every size in range", big[0] * big[1] > 15000000 && big[0] * big[1] <= 20000000 && small[0] * small[1] >= 655360 && small[0] * small[1] < 1300000 && Math.abs(big[0] / big[1] - 16 / 9) < 0.001, short({ big, small }));
        const odd = text("1.91:1", "1K");
        check("an aspect with no near exact size falls back to the fitted one, still at the row's area", odd[0] * odd[1] >= 655360 && odd[0] * odd[1] < 1300000, short(odd));
        const steepAspect = await throws(() => minimax._size({ kind: "text", width: 1024, height: 1024, aspect: "4:1", params: {} }, MODEL));
        check("an asked aspect steeper than 3:1 is refused", !!steepAspect && /no steeper than 3:1; the aspect is 4:1/.test(steepAspect), steepAspect);
        const free = size({ kind: "text", width: 1600, height: 900, aspect: null, params: { size: "1K" } });
        check("a free size: its shape at the row's area", Math.abs(free[0] / free[1] - 16 / 9) < 0.02 && free[0] * free[1] < 1300000, short(free));
        const badSize = await throws(() => minimax._size({ kind: "edit", width: 1000, height: 1000, params: { size: "8K" } }, MODEL));
        check("an unknown Size is refused", !!badSize && /Size "8K"/.test(badSize), badSize);
        const s = fakeServer();
        await minimax.edit(editReq({ image: pngOf(1024, 576, 96, "CROP"), width: 1024, height: 576, params: { size: "1K" } }), ctxOf(s));
        check("the run sends that size as WxH", /^\d+x\d+$/.test(s.posts[0].body.size) && dims(s.posts[0].body.size)[0] > dims(s.posts[0].body.size)[1], s.posts[0].body.size);
    });

    // ---- 4. the Region, the hosts, the key rule ----
    await section("4. regions and keys", async () => {
        const run = async (params, ctx) => { const s = fakeServer(); const err = await throws(() => minimax.edit(editReq({ params }), { key: REAL_KEY, fetch: s.fetch, ...ctx })); return { s, err }; };
        const a = await run({}, {});
        check("no row: the international host, a real key goes there", !a.err && a.s.calls.length === 1 && a.s.calls[0].url === INTL + EDITS && a.s.calls[0].headers.authorization === "Bearer " + REAL_KEY, short({ err: a.err, url: a.s.calls[0] && a.s.calls[0].url }));
        const b = await run({ region: "International" }, {});
        check("Region International: api.minimax.io", !b.err && b.s.calls[0].url === INTL + EDITS);
        const c = await run({ region: "China" }, {});
        check("Region China: api.minimax.cn (bug: the row is ignored)", !c.err && c.s.calls[0].url === CN + EDITS, short(c.s.calls[0] && c.s.calls[0].url));
        const t = fakeServer();
        await minimax.generate(textReq({ params: { region: "China" } }), { key: REAL_KEY, fetch: t.fetch });
        check("a new image goes to the Region's host too", t.calls[0].url === CN + GENERATIONS, t.calls[0].url);
        for (const bad of ["Mars", "__proto__", "constructor"]) {
            const d = await run({ region: bad }, {});
            check(`Region "${bad}" is refused before any call (bug: a name of Object.prototype read as a host)`, !!d.err && /Region/.test(d.err) && d.s.calls.length === 0, d.err);
        }
        const e = await run({}, { base: BASE });
        check("a real key is never sent to the loopback mock", !!e.err && /only a test key goes there/.test(e.err) && e.s.calls.length === 0, e.err);
        const f = fakeServer();
        const m = await throws(() => minimax.edit(editReq(), { key: KEY, fetch: f.fetch }));
        check("a test- key is never sent to MiniMax", !!m && /test key is never sent/.test(m) && f.calls.length === 0, m);
        const g = fakeServer();
        const m2 = await throws(() => minimax.edit(editReq({ params: { region: "China" } }), { key: KEY, fetch: g.fetch, base: "https://evil.example" }));
        check("a base outside loopback counts for nothing: a test key is still refused", !!m2 && /test key is never sent/.test(m2) && g.calls.length === 0, m2);
        const h = await run({}, { base: "https://evil.example" });
        check("a real key with such a base goes to MiniMax, never to it", !h.err && h.s.calls[0].url === INTL + EDITS, short(h.s.calls[0] && h.s.calls[0].url));
        const i = fakeServer();
        await minimax.edit(editReq({ options: { base: "https://evil.example", url: "https://evil.example/x" }, url: "https://evil.example/y", fields: { host: "https://evil.example" } }), { key: REAL_KEY, fetch: i.fetch });
        check("nothing in a recipe or request names the host (bug: a URL from a recipe)", i.calls[0].url === INTL + EDITS, i.calls[0].url);
        const j = (v) => minimax._testBase(v);
        check("the mock's base: http on 127.0.0.1 with a port, nothing else", j("http://127.0.0.1:5557") === "http://127.0.0.1:5557" && !j("https://127.0.0.1:5557") && !j("http://localhost:5557") && !j("http://127.0.0.1") && !j("http://127.0.0.1:5557/x") && !j("http://a@127.0.0.1:5557") && !j("") && !j(null));
        check("baseUrl reads settings.minimax.base only", minimax.baseUrl({ minimax: { base: BASE } }) === BASE && minimax.baseUrl({ minimax: { base: "https://x.y" } }) === null && minimax.baseUrl({}) === null);
    });

    // ---- 5. the refusals before sending ----
    await section("5. refusals", async () => {
        const refuse = async (what, req, re) => {
            const s = fakeServer();
            const m = await throws(() => minimax.edit(req, ctxOf(s)));
            check(`refused before any call: ${what}`, !!m && re.test(m) && s.calls.length === 0, m || "not refused");
        };
        await refuse("a crop under 128 px a side (a crop that passes the 3:1 rule)", editReq({ image: pngOf(127, 127), width: 127, height: 127 }), /must be 128 to 8192 px a side/);
        await refuse("a reference under 128 px", editReq({ references: [pngOf(127, 400)] }), /reference 1 is 127 × 400.*128 to 8192/);
        await refuse("a reference over 8192 px", editReq({ references: [pngOf(8193, 4000)] }), /reference 1 is 8193 × 4000/);
        await refuse("a reference steeper than 4:1", editReq({ references: [pngOf(4100, 1000)] }), /no steeper than 4:1; the reference 1 is 4100 × 1000/);
        await refuse("a crop steeper than 3:1, though the input side takes 4:1", editReq({ image: pngOf(3500, 1000), width: 3500, height: 1000 }), /no steeper than 3:1/);
        await refuse("17 pictures (the crop and 16 references)", editReq({ references: Array.from({ length: 16 }, () => pngOf(512, 512)) }), /at most 16 pictures; this run has 17/);
        await refuse("a prompt past 32,000 characters", editReq({ prompt: "x".repeat(32001) }), /at most 32000 characters/);
        await refuse("an edit without a crop", editReq({ image: null }), /no crop to edit/);
        await refuse("a recipe without a model", editReq({ model: "" }), /no model id/);
        const okS = fakeServer();
        await minimax.edit(editReq({ references: [pngOf(4000, 1000, 64, "4TO1"), pngOf(128, 512, 64, "EDGE")] }), ctxOf(okS));
        check("exactly 4:1 and exactly 128 px go (bug: the limits are off by one)", okS.posts.length === 1 && picsOf(okS.posts[0].body).length === 3);
        const sixteen = fakeServer();
        await minimax.edit(editReq({ references: Array.from({ length: 15 }, () => pngOf(512, 512)) }), ctxOf(sixteen));
        check("16 pictures go", picsOf(sixteen.posts[0].body).length === 16);
        const edge = fakeServer();
        const longPrompt = "y".repeat(32000 - "Edit image 1 and keep its size and framing. ".length);
        await minimax.edit(editReq({ prompt: longPrompt }), ctxOf(edge));
        check("a sent prompt of exactly 32,000 characters goes (the limit counts the prompt that is sent)", edge.posts[0].body.prompt.length === 32000, String(edge.posts[0].body.prompt.length));
    });

    // ---- 6. the body limit and the JPEG fallback ----
    await section("6. body size", async () => {
        const fields = { model: MODEL, prompt: "ä", n: 1, size: "2048x2048", output_format: "png", response_format: "b64_json" };
        const pics = [{ what: "crop", bytes: pngOf(1024, 1024, 1000), mime: "image/png" }, { what: "ref", bytes: jpegOf(1001), mime: "image/jpeg" }];
        const real = Buffer.byteLength(JSON.stringify({ ...fields, images: pics.map((p) => ({ image_url: `data:${p.mime};base64,${p.bytes.toString("base64")}` })) }), "utf8");
        check("bodyBytes is what JSON.stringify of the body weighs (bug: base64's third or a non-ASCII prompt left out)", minimax._bodyBytes(fields, pics) === real, `${minimax._bodyBytes(fields, pics)} vs ${real}`);
        check("the body limit is the documented 64 MiB", minimax.MAX_BODY_BYTES === 64 * MIB, String(minimax.MAX_BODY_BYTES));
        const NEAR = Math.floor((minimax.MAX_BODY_BYTES - 400) * 3 / 4);   // this much PNG comes to just under the limit as base64
        const OVER = Math.floor(minimax.MAX_BODY_BYTES * 3 / 4) + 16;
        const crop = (size, colour) => editReq({ prompt: "p", image: pngOf(2048, 2048, size, "CROP", colour) });
        let asked = 0, jpegs = 0;
        const under = fakeServer();
        await minimax.edit(crop(NEAR, 6), ctxOf(under, { opaque: () => { asked++; return true; }, toJpeg: () => { jpegs++; return jpegOf(1000); } }));
        check("a body under 64 MiB stays PNG, nothing re-encoded (bug: JPEG always, or the limit counted without base64)", picsOf(under.posts[0].body)[0].mime === "image/png" && asked === 0 && jpegs === 0, `asked ${asked}, jpegs ${jpegs}`);
        const big = fakeServer();
        let quality = 0;
        const out = await minimax.edit(crop(OVER, 2), ctxOf(big, { opaque: () => true, toJpeg: (b, q) => { quality = q; return jpegOf(4000, "SMALL"); } }));
        const sent = picsOf(big.posts[0].body)[0];
        check("a body over 64 MiB with an opaque crop goes as JPEG", big.posts.length === 1 && sent.mime === "image/jpeg" && tagOf(sent.bytes) === "SMALL" && quality >= 90, short({ mime: sent && sent.mime, quality }));
        check("info says the crop went as JPEG", eq(out.info.pictures, ["crop jpeg"]), short(out.info.pictures));
        const clear = fakeServer();
        let jpeg2 = 0;
        const m = await throws(() => minimax.edit(crop(OVER, 6), ctxOf(clear, { opaque: () => false, toJpeg: () => { jpeg2++; return jpegOf(4000); } })));
        check("a crop with a transparent pixel stays PNG and is refused (bug: JPEG flattens the alpha)", !!m && /has transparency, so it stays PNG/.test(m) && /64 MiB/.test(m) && clear.calls.length === 0 && jpeg2 === 0, m);
        const stillBig = fakeServer();
        const m2 = await throws(() => minimax.edit(crop(OVER, 2), ctxOf(stillBig, { opaque: () => true, toJpeg: () => jpegOf(OVER - 1) })));
        check("still too large as JPEG: refused, nothing sent", !!m2 && /even as JPEG/.test(m2) && stillBig.calls.length === 0, m2);
        const noJpeg = fakeServer();
        const m3 = await throws(() => minimax.edit(crop(OVER, 2), ctxOf(noJpeg)));
        check("without toJpeg and opaque: refused, nothing sent", !!m3 && /64 MiB/.test(m3) && noJpeg.calls.length === 0, m3);
        // the largest picture goes first and the others stay PNG: the crop first in `images` whatever got converted
        const two = fakeServer();
        const reqTwo = editReq({ prompt: "p", image: pngOf(2048, 2048, 2000, "CROP"), references: [pngOf(2048, 2048, OVER, "BIGREF", 2)] });
        const seen = [];
        await minimax.edit(reqTwo, ctxOf(two, { opaque: (b) => { seen.push(tagOf(b)); return true; }, toJpeg: () => jpegOf(4000, "REFJPEG") }));
        const both = picsOf(two.posts[0].body);
        check("the largest goes first, only as many as needed, the order of the pictures unchanged (bug: every picture re-encoded, or the sort reorders `images`)", eq(seen, ["BIGREF"]) && eq(both.map((x) => [x.mime, tagOf(x.bytes)]), [["image/png", "CROP"], ["image/jpeg", "REFJPEG"]]), short({ seen, both: both.map((x) => x.mime) }));
        const worse = fakeServer();
        const m4 = await throws(() => minimax.edit(crop(OVER, 2), ctxOf(worse, { opaque: () => true, toJpeg: () => jpegOf(OVER + 500) })));
        check("a JPEG larger than the PNG alone is refused too", !!m4 && worse.calls.length === 0, m4);
        const mixed = fakeServer();
        const reqMixed = editReq({ prompt: "p", image: pngOf(2048, 2048, NEAR - 2000, "LARGE", 2), references: [pngOf(1024, 1024, 3 * MIB, "SMALLER", 2)] });
        await minimax.edit(reqMixed, ctxOf(mixed, { opaque: () => true, toJpeg: (b) => (tagOf(b) === "LARGE" ? jpegOf(NEAR + 1000, "BIGGERJPEG") : jpegOf(300, "SMALLJPEG")) }));
        const mixedPics = picsOf(mixed.posts[0].body);
        check("a JPEG larger than its PNG is not taken, the next picture's is (bug: the swap makes the body larger)", eq(mixedPics.map((x) => [x.mime, tagOf(x.bytes)]), [["image/png", "LARGE"], ["image/jpeg", "SMALLJPEG"]]), short(mixedPics.map((x) => x.mime)));
    });

    // ---- 7. errors, and never a second request ----
    await section("7. errors", async () => {
        const failOne = async (answer, ctx = {}) => {
            const s = fakeServer({ answers: [answer] });
            const slept = [];
            const m = await throws(() => minimax.edit(editReq(), ctxOf(s, { sleep: async (ms) => slept.push(ms), ...ctx })));
            return { m, s, slept };
        };
        const envelopes = [
            ["400 bad_request_error", 400, "bad_request_error", "invalid size (2013)", /request refused - invalid size \(2013\)/],
            ["401 authorized_error", 401, "authorized_error", "login fail (2049)", /key refused by the International host .*Region row\) - login fail \(2049\)/],
            ["402 balance (1008)", 402, "insufficient_balance_error", "insufficient balance (1008)", /balance is used up: top it up in the console - insufficient balance \(1008\)/],
            ["402 plan (2053)", 402, "insufficient_balance_error", "no access (2053)", /plan of this key does not include this model - no access \(2053\)/],
            ["402 plan (2067)", 402, "insufficient_balance_error", "no access (2067)", /plan of this key does not include this model/],
            ["402 plan (2068)", 402, "insufficient_balance_error", "no access (2068)", /plan of this key does not include this model/],
            ["402 without a known code", 402, "insufficient_balance_error", "no money", /used up, or the plan of this key/],
            ["422 prompt safety (1026)", 422, "unprocessable_entity_error", "sensitive prompt (1026)", /prompt failed MiniMax's safety check - sensitive prompt \(1026\)/],
            ["422 picture safety (1027)", 422, "unprocessable_entity_error", "sensitive picture (1027)", /a picture failed MiniMax's safety check - sensitive picture \(1027\)/],
            ["422 another", 422, "unprocessable_entity_error", "bad thing", /could not process this request - bad thing/],
            ["429 (1002)", 429, "rate_limit_error", "rate limit (1002)", /rate limited by MiniMax.*not sent again.* - rate limit \(1002\)/],
            ["429 (2056)", 429, "rate_limit_error", "plan limit (2056)", /rate limited by MiniMax/],
            ["500 server_error", 500, "server_error", "internal error (1033)", /the service failed - internal error \(1033\)/],
        ];
        for (const [name, status, type, msg, re] of envelopes) {
            const { m, s, slept } = await failOne(() => failure(status, type, msg));
            check(`${name}: its plain line and MiniMax's message, one POST, no wait (bug: a retry is billed again)`, !!m && m.startsWith(`MiniMax ${MODEL}: `) && re.test(m) && s.posts.length === 1 && slept.length === 0, m);
        }
        const china = fakeServer({ answers: [() => failure(401, "authorized_error", "nope")] });
        const m401 = await throws(() => minimax.edit(editReq({ params: { region: "China" } }), { key: REAL_KEY, fetch: china.fetch }));
        check("401 names the host in use", !!m401 && /China host/.test(m401), m401);
        const html = await failOne(() => new Response("<html>bad gateway</html>", { status: 502 }));
        check("a failure that is no JSON: by its status, its text, one POST", !!html.m && /the service failed - <html>bad gateway/.test(html.m) && html.s.posts.length === 1, html.m);
        const items = [
            [1000, "generation failed", /failed to make this picture - generation failed/],
            [1001, "timed out", /timed out on this picture - timed out/],
            [1008, "no balance", /balance is used up/],
            [1026, "prompt blocked", /prompt failed MiniMax's safety check/],
            [1027, "picture blocked", /a picture failed MiniMax's safety check/],
        ];
        for (const [code, msg, re] of items) {
            const { m, s } = await failOne(() => itemFailure(code, msg));
            check(`a failed picture inside a 200, code ${code}: its plain line, one POST (bug: the 200 taken for success)`, !!m && re.test(m) && m.includes(msg) && s.posts.length === 1, m);
        }
        const none = await failOne(() => json(200, { data: [{}], request_id: "x" }));
        check("a 200 with no picture and no error says so", !!none.m && /no image in the answer/.test(none.m), none.m);
        const envelope200 = await failOne(() => json(200, { type: "error", error: { type: "bad_request_error", message: "odd (2013)" } }));
        check("an error envelope behind a 200 is an error", !!envelope200.m && /request refused - odd \(2013\)/.test(envelope200.m), envelope200.m);
        const notJson = await failOne(() => new Response("not json", { status: 200 }));
        check("a 200 that is no JSON says so", !!notJson.m && /no JSON/.test(notJson.m), notJson.m);
        const net = await failOne(() => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }); });
        check("a network failure: says why and that it is not sent again, one POST (bug: a retry after a lost answer is billed twice)", !!net.m && /UND_ERR_HEADERS_TIMEOUT/.test(net.m) && /does not send it again/.test(net.m) && net.s.posts.length === 1 && net.slept.length === 0, net.m);
        const abort = fakeServer({ answers: [() => { throw Object.assign(new Error("cancelled"), { name: "AbortError" }); }] });
        let abortErr = null;
        try { await minimax.edit(editReq(), ctxOf(abort)); } catch (e) { abortErr = e; }
        check("a Cancel stays an AbortError for index.js's own words", !!abortErr && abortErr.name === "AbortError" && abort.posts.length === 1, abortErr && abortErr.message);
        const leak = await failOne(() => failure(400, "bad_request_error", `bad key ${KEY} here`));
        check("the key is taken out of MiniMax's message", !!leak.m && !leak.m.includes(KEY) && leak.m.includes("[key]"), leak.m);
        const itemLeak = await failOne(() => itemFailure(1000, `key ${KEY}`));
        check("the key is taken out of a failed picture's message", !!itemLeak.m && !itemLeak.m.includes(KEY), itemLeak.m);
        const cutLeak = await failOne(() => new Response("x".repeat(290) + KEY, { status: 500 }));
        check("the key is taken out before the 300-character cut (bug: the key's head survives the cut)", !!cutLeak.m && !cutLeak.m.includes(KEY.slice(0, 8)), cutLeak.m && cutLeak.m.slice(-40));
        const netLeak = await failOne(() => { throw new Error(`boom ${KEY}`); });
        check("the key is taken out of a network error", !!netLeak.m && !netLeak.m.includes(KEY), netLeak.m);
    });

    // ---- 8. the long wait and the real fetch ----
    await section("8. real fetch", async () => {
        const fake = fakeServer();
        await minimax.edit(editReq(), ctxOf(fake));
        const init = fake.calls[0].init;
        check("the POST's own limits are at least the server's 600 s (bug: undici's 300 s ends a slow run, and the paid answer is lost)", init.dispatcher && init.dispatcher.headersTimeout >= 600000 && init.dispatcher.bodyTimeout >= 600000, short(init.dispatcher));
        const sym = Symbol.for("undici.globalDispatcher.1");
        void globalThis.fetch;
        const saved = globalThis[sym];
        const seen = [];
        globalThis[sym] = { dispatch: (o, h) => { seen.push({ o, h }); return true; } };
        let d;
        try { d = minimax._longPostInit().dispatcher; d.dispatch({ path: "/x" }, "handler"); } finally { globalThis[sym] = saved; }
        check("the delegate hands every request on with those limits", seen.length === 1 && seen[0].o.path === "/x" && seen[0].o.headersTimeout >= 600000 && seen[0].o.bodyTimeout >= 600000 && seen[0].h === "handler", short(seen));
        const got = [];
        let status = 200;
        const server = http.createServer((q, a) => {
            const chunks = [];
            q.on("data", (c) => chunks.push(c));
            q.on("end", () => {
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                got.push({ url: q.url, auth: q.headers.authorization, type: q.headers["content-type"], body });
                a.writeHead(status, { "content-type": "application/json" });
                a.end(status === 200 ? JSON.stringify({ data: [{ b64_json: RESULT.toString("base64"), size: body.size }], request_id: "r" }) : JSON.stringify({ type: "error", error: { type: "server_error", message: "down (1000)", http_code: "500" } }));
            });
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const local = `http://127.0.0.1:${server.address().port}`;
        try {
            const out = await minimax.edit(editReq(), { key: KEY, fetch: globalThis.fetch, base: local });
            check("through the real fetch and its dispatcher: the mock gets the JSON and the key, the picture comes back", got.length === 1 && got[0].url === EDITS && got[0].auth === "Bearer " + KEY && got[0].type === "application/json" && picsOf(got[0].body).length === 1 && Buffer.from(out.bytes).equals(RESULT), short(got.map((x) => x.url)));
            status = 500;
            got.length = 0;
            const m = await throws(() => minimax.generate(textReq(), { key: KEY, fetch: globalThis.fetch, base: local }));
            check("the same with a 500: exactly one request reached the server", got.length === 1 && got[0].url === GENERATIONS && !!m && /failed to make this picture|the service failed/.test(m), short({ n: got.length, m }));
        } finally { await new Promise((r) => server.close(r)); }
    });

    // ---- 9. the recipe, as recipes.js lists it, and the wiring in providers/index.js ----
    await section("9. recipe and wiring", async () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-minimax-test-"));
        const orig = Module._load;
        Module._load = function (request, ...rest) {
            if (request === "electron") return { app: { getPath: () => empty } };
            return orig.call(this, request, ...rest);
        };
        let recipes;
        try { recipes = require(path.join(ROOT, "electron", "main", "recipes.js")); } finally { Module._load = orig; }
        let list;
        try { list = await recipes.list(RECIPES); } finally { fs.rmSync(empty, { recursive: true, force: true }); }
        const r = list.find((x) => x.id === "minimax_h3_image");
        const v = r && r.providers.minimax;
        check("the recipe is listed, builtin, minimax its one provider and its default", !!r && r.source === "builtin" && eq(r.providerIds, ["minimax"]) && r.default === "minimax" && r.kind === "provider", short(r && { ids: r.providerIds, def: r.default }));
        check("no other recipe carries a minimax variant", list.filter((x) => x.providers && x.providers.minimax).length === 1);
        check("the model id, input edit, image {n} as the picture name (the docs' \"image 1\", \"image 2\")", v.model === MODEL && v.input === "edit" && r.refs.name === "image {n}" && v.refs.name === "image {n}", short({ m: v.model, i: v.input, refs: v.refs }));
        const row = (key) => v.settings.find((s) => s.key === key);
        check("the rows: Size 1K, 2K, 4K defaulting to 2K", row("size").label === "Size" && eq(row("size").spec[0], ["1K", "2K", "4K"]) && row("size").spec[1].default === "2K", short(row("size")));
        check("Speed Standard, Highspeed defaulting to Standard (the adapter's own names)", row("speed").label === "Speed" && eq(row("speed").spec[0], ["Standard", "Highspeed"]) && row("speed").spec[1].default === "Standard", short(row("speed")));
        check("Region International first, then China", row("region").label === "Region" && eq(row("region").spec[0], Object.keys(minimax.REGIONS)) && row("region").spec[0][0] === "International" && row("region").spec[1].default === "International", short(row("region")));
        check("each row its own slot, no row for disable_prompt_enhanced", new Set(v.settings.map((s) => s.index)).size === 3 && !v.settings.some((s) => /enhance/.test(s.key)));
        check("limits: 8192 at most, 384 long side at least (short side 128 at 3:1), 3:1, 16 px steps, the 4K row's area", v.limits.max === 8192 && v.limits.min === 384 && v.limits.ratio === 3 && v.limits.step === 16 && v.limits.pixels === 16777216, short(v.limits));
        check("Generate new: the same model, the prompt alone, the Size row among its settings", !!v.text && v.text.model === MODEL && v.text.refs === null && v.text.settings.some((s) => s.key === "size"), short(v.text));
        const words = `${r.description} ${v.note}`;
        check("description and note say not run against the live API yet, no mask, the price is approximate", /not run against the live API yet/.test(r.description) && /not run against the live API yet/.test(v.note) && /no mask/.test(words) && /whole crop/.test(words) && /reference values/.test(v.note) && /\$0\.02/.test(v.note) && /\$0\.07/.test(v.note) && /\$0\.03/.test(v.note), short(v.note));
        check("no licence line for the hosted API", !/licen[cs]e/i.test(words), short(words));

        const idxPath = path.join(ROOT, "electron", "main", "providers", "index.js");
        let currentSettings = { minimax: { base: BASE } };
        let currentKey = KEY;
        const logged = [];
        Module._load = function (request, parent, ...rest) {
            if (request === "electron") return { nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, toJPEG: () => jpegOf(1500000, "NATIVE"), toBitmap: () => Buffer.alloc(8, 255) }) } };
            if (parent && parent.filename === idxPath) {
                if (request === "../log") return { record: (x) => logged.push(x) };
                if (request === "../keys") return { get: (id) => (id === "minimax" ? currentKey : ""), describe: (id) => ({ set: id === "minimax" }) };
                if (request === "../settings") return { get: () => currentSettings };
            }
            return orig.call(this, request, parent, ...rest);
        };
        let index;
        try { index = require(idxPath); } finally { Module._load = orig; }
        const rows = index.describeAll();
        const at = rows.findIndex((x) => x.id === "minimax");
        check("index.js: a key row labelled MiniMax after ModelArk, with its key page and hint", at > 0 && rows[at - 1].id === "ark" && rows[at].label === "MiniMax" && rows[at].keyUrl === minimax.keyUrl && /console/.test(rows[at].keyHint) && index.PROVIDERS.minimax === minimax, short(rows.map((x) => x.id)));
        check("index.js: minimax is a text provider", index.textProviders().includes("minimax"));
        const realFetch = globalThis.fetch;
        async function viaIndex(request) {
            const s = fakeServer();
            globalThis.fetch = s.fetch;
            try { return { s, out: await index.edit(request), err: null }; } catch (e) { const m = String(e && e.message || e); ERRORS.push(m); return { s, out: null, err: m }; } finally { globalThis.fetch = realFetch; }
        }
        const base = { provider: "minimax", model: v.model, kind: "edit", options: v.options || null, prompt: "like {@ref:0}", seed: 3, image: new Uint8Array(pngOf(1024, 1024, 96, "CROP")), width: 1024, height: 1024, references: [new Uint8Array(pngOf(640, 640, 70, "REF"))], params: {}, refName: "image {n}" };
        const x1 = await viaIndex(base);
        const b1 = x1.s.posts[0] && x1.s.posts[0].body;
        check("index.edit: the stored key to the mock, the @img marker named image 2, the bytes back", !x1.err && x1.s.calls.length === 1 && x1.s.calls[0].url === BASE + EDITS && x1.s.calls[0].headers.authorization === "Bearer " + KEY && b1.prompt === "Edit image 1 and keep its size and framing. like image 2 Image 2 is a reference image." && Buffer.from(x1.out.bytes).equals(RESULT), short({ err: x1.err, prompt: b1 && b1.prompt }));
        const x2 = await viaIndex({ ...base, prompt: "a door", kind: "text", image: null, aspect: "16:9", width: 1024, height: 576, references: [new Uint8Array(pngOf(640, 640, 70, "REF"))], params: { size: "2K" } });
        const b2 = x2.s.posts[0] && x2.s.posts[0].body;
        check("index.edit with kind text: /generations, the references left out with a note", !x2.err && x2.s.calls[0].url === BASE + GENERATIONS && !("images" in b2) && b2.size === "2816x1584" && x2.out.notes.some((n) => /prompt alone/.test(n)), short({ err: x2.err, body: b2, notes: x2.out && x2.out.notes }));
        const x3 = await viaIndex({ ...base, references: Array.from({ length: 16 }, () => new Uint8Array(pngOf(512, 512))) });
        check("index.edit: 17 pictures refused centrally by the layout's cap", !!x3.err && /at most 16 pictures; this run has 17/.test(x3.err) && x3.s.calls.length === 0, x3.err);
        currentSettings = {};
        const x4 = await viaIndex(base);
        check("index.edit without settings.minimax.base: a test key is refused before any call", !!x4.err && /test key is never sent/.test(x4.err) && x4.s.calls.length === 0, x4.err);
        currentSettings = { minimax: { base: BASE } };
        currentKey = "";
        const x5 = await viaIndex(base);
        check("index.edit without a stored key: refused before any call, naming MiniMax", !!x5.err && /No API key for MiniMax/.test(x5.err) && x5.s.calls.length === 0, x5.err);
        currentKey = KEY;
        check("index.js logged no key", !JSON.stringify(logged).includes(KEY) && !JSON.stringify(logged).includes(REAL_KEY), `${logged.length} records`);
    });

    // ---- 10. the whole run ----
    const extra = ALL_CALLS.filter((c) => !eq(Object.keys(c.headers).sort(), ["authorization", "content-type"]));
    check("no call of the whole run carried a header beyond Authorization and Content-Type", ALL_CALLS.length > 40 && !extra.length, short(extra.map((c) => c.headers)));
    const keyed = ALL_CALLS.filter((c) => !(c.headers.authorization === "Bearer " + KEY && c.url.startsWith(BASE + "/")) && !(c.headers.authorization === "Bearer " + REAL_KEY && (c.url.startsWith(INTL + "/") || c.url.startsWith(CN + "/"))));
    check("every call: the test key to the mock only, the real key to the two MiniMax hosts only", !keyed.length, short(keyed.map((c) => c.url)));
    check("neither key appears in any error of the run", ERRORS.length > 30 && !ERRORS.some((x) => x.includes(KEY) || x.includes(REAL_KEY)), `${ERRORS.length} errors`);

    const failed = results.filter((x) => !x).length;
    console.log(`${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + (err && err.stack || err)); console.log("FAIL"); process.exit(1); });
