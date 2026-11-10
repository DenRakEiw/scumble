// MiniMax: the maker's own API for its image model MiniMax-H3-Image. Written from MiniMax's API reference
// (platform.minimax.io and platform.minimax.cn, read 2026-11-10); nothing here has run against the live API yet
// (docs/RECIPES.md "MiniMax" lists what only a real key can verify).
//
//   POST /v1/images/generations   JSON { model, prompt, n: 1, size: "WxH", output_format: "png",
//                                 response_format: "b64_json" }                                      a new image
//   POST /v1/images/edits         the same and images: [{ image_url: "data:image/png;base64,..." }]  an edit
//                                 -> { created, data: [{ b64_json, size, revised_prompt }], output_format, usage,
//                                 request_id }; a picture that failed inside a 200 is { error: { code, message } }
//                                 or { type: "error", error: { type, message: "<text> (<code>)", http_code },
//                                 request_id }
//
// Synchronous: the server waits up to 600 s, so the POST's own limits are raised past undici's 300 s. A request is
// not idempotent and a second one is billed again: there is no automatic retry of any kind, whatever the failure.
//
// There is no mask input: an edit sends the crop and the references (`images`, crop first, the prompt names them
// "image 1", "image 2" in that order) and the stitch keeps the selection. A text run (Generate new) sends the prompt
// alone: the text endpoint takes no pictures.
//
// `size` always goes as pixels (with it neither aspect_ratio nor area may go; the server never rounds it): the crop's
// own shape, or the asked aspect of a text run, fitted to the area of the Size row (params.size: 1K, 2K, 4K, default
// 2K), 655,360 to 20,000,000 pixels, 1:3 to 3:1. A crop steeper than that is refused before sending, a shape is never
// bent to fit.
//
// The Speed row (params.speed) picks MiniMax-H3-Image or MiniMax-H3-Image-Highspeed, the same parameters on a faster,
// dearer model.
//
// Not sent: disable_prompt_enhanced (text to image only; an edit always enhances the prompt, so there is no row for
// it), seed, a negative prompt, a transparent background, aspect_ratio, area, stream.
//
// Every picture must be 128 to 8192 px a side and no steeper than 4:1; the whole request body at most 64 MiB (so the
// documented 64 MiB per picture can never be the limit that bites: base64 adds a third). A body over it sends its
// largest opaque pictures as JPEG until it fits; a picture with a transparent pixel stays PNG; anything still out of
// range is refused before sending.
//
// The host is one of the two regional hosts, chosen by the Region row (a key belongs to the console it was made in),
// never a URL from a recipe; settings.minimax.base may name a loopback mock for the tests, and then only a key that
// starts with "test-" goes there, while such a key never goes to MiniMax.
// layout(req) declares where each picture goes (docs/PLAN_REFS.md C3).
"use strict";

const { fitPixels, pngSize, scrub } = require("./util");
const { layoutOf, refRoles, instruction } = require("./refs");

const REGIONS = {
    International: "https://api.minimax.io",
    China: "https://api.minimax.cn",
};
const DEFAULT_REGION = "International";
const EDIT_PATH = "/v1/images/edits";
const TEXT_PATH = "/v1/images/generations";
const SPEEDS = { Standard: "", Highspeed: "-Highspeed" };   // what the Speed row adds to the recipe's model id
const DEFAULT_SPEED = "Standard";
const AREAS = { "1K": 1024 * 1024, "2K": 2048 * 2048, "4K": 4096 * 4096 };   // the Size row's target areas
const DEFAULT_SIZE = "2K";
const MIN_AREA = 655360;
const MAX_AREA = 20000000;
const MAX_OUTPUT_RATIO = 3;
const SIZE_STEP = 16;
const MAX_PROMPT = 32000;
const MAX_PICTURES = 16;
const MIN_PICTURE_EDGE = 128;
const MAX_PICTURE_EDGE = 8192;
const MAX_PICTURE_RATIO = 4;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const JPEG_QUALITY = 92;
// the server waits up to 600 s: undici's own 300 s for the answer's headers must not end the request first
const POST_TIMEOUT_MS = 630000;
// 402 codes that mean the plan, not the balance (1008 is the balance)
const PLAN_CODES = new Set(["2053", "2067", "2068"]);

const has = (table, name) => Object.prototype.hasOwnProperty.call(table, name);

/** http://127.0.0.1:<port> (the test mock) or null: the only base a setting may name. */
function testBase(value) {
    if (!value) return null;
    let u;
    try { u = new URL(String(value).trim()); } catch (_) { return null; }
    if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) return null;
    if (u.protocol === "http:" && u.hostname === "127.0.0.1" && u.port) return `${u.protocol}//${u.host}`;
    return null;
}

/** settings.minimax.base when it is the loopback mock, else null (the Region row picks the host). */
function baseUrl(settings) {
    const s = (settings && settings.minimax) || {};
    return testBase(s.base);
}

/** The value of a Settings row, its default when empty; anything that is no key of `table` is refused before any request. */
function rowValue(params, key, table, fallback, label) {
    const raw = (params || {})[key];
    const v = raw == null || raw === "" ? fallback : String(raw);
    if (!has(table, v)) throw new Error(`MiniMax: ${label} "${raw}" is none of ${Object.keys(table).join(", ")}.`);
    return v;
}

/** The host a run goes to: the test mock, or the region's host; an unknown region is refused. */
function hostFor(ctx, params) {
    const test = testBase(ctx.base);
    const region = rowValue(params, "region", REGIONS, DEFAULT_REGION, "Region");
    return { host: test || REGIONS[region], region, test: !!test };
}

/** A test key goes only to the mock, a real key never there. Throws before any request. */
function checkKey(test, key) {
    const isTest = /^test-/.test(String(key || ""));
    if (test && !isTest) throw new Error("MiniMax: the host is set to a test address (settings.minimax.base), and only a test key goes there; clear the setting to use a real key.");
    if (!test && isTest) throw new Error("MiniMax: a test key is never sent to MiniMax; store a real key under Settings › API providers.");
}

/** The model id a run asks for: the recipe's, or its Highspeed sibling. */
function modelFor(req) {
    const base = String(req.model || "");
    if (!base) throw new Error("MiniMax recipe has no model id.");
    return base + SPEEDS[rowValue(req.params, "speed", SPEEDS, DEFAULT_SPEED, "Speed")];
}

/**
 * The plain words for a failed answer or a failed picture, by MiniMax's code before its error type and status, ahead
 * of MiniMax's own message. `w` ({ region }) words the key hint.
 */
function explain(status, type, code, message, w) {
    const words = explainWhy(status, String(type || ""), String(code || ""), w || {});
    return words ? `${words} - ${message}` : String(message);
}

function explainWhy(status, t, c, w) {
    if (c === "1008") return "the MiniMax balance is used up: top it up in the console";
    if (PLAN_CODES.has(c)) return "the MiniMax plan of this key does not include this model";
    if (c === "1026") return "refused: the prompt failed MiniMax's safety check";
    if (c === "1027") return "refused: a picture failed MiniMax's safety check";
    if (c === "1001") return "MiniMax timed out on this picture";
    if (c === "1000") return "MiniMax failed to make this picture";
    if (t === "authorized_error" || status === 401) return `key refused by the ${w.region || "chosen"} host (a key works only with the console it was made in: check the Region row)`;
    if (t === "insufficient_balance_error" || status === 402) return "the MiniMax balance is used up, or the plan of this key does not include this model";
    if (t === "unprocessable_entity_error" || status === 422) return "MiniMax could not process this request";
    if (t === "rate_limit_error" || status === 429 || c === "1002" || c === "2056") return "rate limited by MiniMax; not sent again, try again in a moment";
    if (t === "bad_request_error" || status === 400) return "request refused";
    if (t === "server_error" || status >= 500) return "the service failed";
    return null;
}

/** The trailing "(1234)" of an error's message: the code MiniMax puts there. */
function codeOf(message) {
    const m = /\((\d+)\)\s*$/.exec(String(message || ""));
    return m ? m[1] : "";
}

/** { type, code, message } of a failed answer ({ type: "error", error: { type, message, http_code } }), else its text; the key taken out before any cut. */
async function readFailure(r, key) {
    let text = "";
    try { text = await r.text(); } catch (_) { text = ""; }
    text = scrub(text, key);
    try {
        const e = (JSON.parse(text) || {}).error;
        if (e && typeof e === "object") return { type: e.type || "", code: e.code != null ? String(e.code) : codeOf(e.message), message: String(e.message || e.type || r.statusText || r.status) };
    } catch (_) { /* not JSON */ }
    return { type: "", code: "", message: text.slice(0, 300) || r.statusText || String(r.status) };
}

function gcd(a, b) {
    while (b) [a, b] = [b, a % b];
    return a;
}

function aspectNumbers(aspect) {
    const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(aspect || ""));
    return m && +m[1] > 0 && +m[2] > 0 ? [+m[1], +m[2]] : null;
}

/** Exactly a:b on 16 px steps at the area nearest `area`, or null when no such size lies within 10 % of it. */
function exactSize(a, b, area) {
    let x = a, y = b;
    for (let i = 0; i < 6 && (!Number.isInteger(x) || !Number.isInteger(y)); i++) { x *= 2; y *= 2; }   // 19.5:9 -> 39:18
    if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
    const g = gcd(x, y);
    const uw = SIZE_STEP * (x / g), uh = SIZE_STEP * (y / g);
    const t = Math.max(1, Math.round(Math.sqrt(area / (uw * uh))));
    const got = uw * uh * t * t;
    return Math.abs(got / area - 1) <= 0.1 ? [uw * t, uh * t] : null;
}

/**
 * The output size as "WxH": the crop's own shape (an edit) or the asked aspect (a text run) at the Size row's area, in
 * 16 px steps, inside the API's area range. A shape steeper than 1:3 .. 3:1 is refused, never bent.
 */
function sizeFor(req, model) {
    const area = AREAS[rowValue(req.params, "size", AREAS, DEFAULT_SIZE, "Size")];
    const asked = req.kind === "text" ? aspectNumbers(req.aspect) : null;
    let w = Math.max(1, +req.width || 1), h = Math.max(1, +req.height || 1);
    if (req.kind !== "text") {
        const crop = req.image ? pngSize(Buffer.from(req.image)) : null;
        if (crop) [w, h] = crop;
    }
    if (asked) [w, h] = asked;
    if (Math.max(w, h) > MAX_OUTPUT_RATIO * Math.min(w, h)) {
        const shape = asked ? `the aspect is ${req.aspect}` : `${req.kind === "text" ? "the size" : "the crop"} is ${w} × ${h}`;
        throw new Error(`MiniMax ${model} makes pictures no steeper than 3:1; ${shape}. ${req.kind === "text" ? "Pick a less narrow shape." : "Use a less narrow selection; the picture is too narrow to widen the crop."} Nothing was sent.`);
    }
    const exact = asked ? exactSize(asked[0], asked[1], area) : null;
    const k = Math.sqrt(area / (w * h));
    const [pw, ph] = exact || fitPixels(w * k, h * k, { step: SIZE_STEP, max: 16384, minPixels: MIN_AREA, maxPixels: MAX_AREA, maxRatio: MAX_OUTPUT_RATIO });
    if (pw * ph < MIN_AREA || pw * ph > MAX_AREA || Math.max(pw, ph) > MAX_OUTPUT_RATIO * Math.min(pw, ph)) throw new Error(`MiniMax ${model}: no output size in its range fits ${w} × ${h} (it came to ${pw} × ${ph}). Nothing was sent.`);
    return `${pw}x${ph}`;
}

/** Where picturesFor below puts each picture: `images` holds the crop, then the references (there is no mask input). */
function layout(req) {
    return layoutOf({ seq: [["crop", "images[0]"], ...refRoles(req).map(([role, i]) => [role, `images[${i + 1}]`, i])], max: MAX_PICTURES });
}

/** The prompt of a run: refs.instruction numbered by layout(), a text run's prompt as it is. */
function promptFor(req) {
    return req.kind === "text" ? String(req.prompt == null ? "" : req.prompt) : instruction(req, layout(req), req.prompt);
}

/** The body's fields without the pictures: exactly what the API documents for both endpoints, and n is always 1. */
function fieldsFor(model, prompt, size) {
    return { model, prompt, n: 1, size, output_format: "png", response_format: "b64_json" };
}

const dataUrl = (p) => `data:${p.mime};base64,${p.bytes.toString("base64")}`;

/** What JSON.stringify of the whole body would weigh, without building the base64 strings: base64 and a data URL hold nothing JSON escapes. */
function bodyBytes(fields, pics) {
    const shell = Buffer.byteLength(JSON.stringify({ ...fields, images: pics.map(() => ({ image_url: "" })) }), "utf8");
    return shell + pics.reduce((sum, p) => sum + `data:${p.mime};base64,`.length + 4 * Math.ceil(p.bytes.length / 3), 0);
}

const MIB = 1024 * 1024;

/**
 * The pictures of an edit, in order: the crop, then the references (a text run has none). Checks the count, each
 * picture's sides and shape and the whole body against the documented input rules; a body over 64 MiB sends its
 * largest pictures without a transparent pixel as JPEG until it fits. Throws before any request.
 */
async function picturesFor(req, fields, ctx, model) {
    if (req.kind === "text") return [];
    const pics = [{ what: "crop", bytes: Buffer.from(req.image), mime: "image/png" }];
    req.references.forEach((r, i) => pics.push({ what: `reference ${i + 1}`, bytes: Buffer.from(r), mime: "image/png" }));
    if (pics.length > MAX_PICTURES) {
        // index.js refuses first (refs.checkPictures); this stays the safety net
        throw new Error(`MiniMax ${model} takes at most ${MAX_PICTURES} pictures; this run has ${pics.length} (the crop, ${req.references.length} reference${req.references.length === 1 ? "" : "s"}): turn Original off or hide reference layers.`);
    }
    for (const p of pics) {
        const s = pngSize(p.bytes);
        if (!s) continue;
        const [w, h] = s;
        if (Math.min(w, h) < MIN_PICTURE_EDGE || Math.max(w, h) > MAX_PICTURE_EDGE) throw new Error(`MiniMax ${model}: the ${p.what} is ${w} × ${h}; every picture must be 128 to 8192 px a side. Nothing was sent.`);
        if (Math.max(w, h) > MAX_PICTURE_RATIO * Math.min(w, h)) throw new Error(`MiniMax ${model} takes pictures no steeper than 4:1; the ${p.what} is ${w} × ${h}. Use a less narrow selection or reference layer. Nothing was sent.`);
    }
    if (bodyBytes(fields, pics) <= MAX_BODY_BYTES) return pics;
    const kept = [];
    for (const p of [...pics].sort((a, b) => b.bytes.length - a.bytes.length)) {
        if (bodyBytes(fields, pics) <= MAX_BODY_BYTES) break;
        const opaque = typeof ctx.opaque === "function" && (await ctx.opaque(p.bytes));
        const jpeg = opaque && typeof ctx.toJpeg === "function" ? await ctx.toJpeg(p.bytes, JPEG_QUALITY) : null;
        if (!opaque) kept.push(p.what);
        if (jpeg && jpeg.length && jpeg.length < p.bytes.length) {
            ctx.log(`${p.what} ${p.bytes.length} bytes as JPEG ${jpeg.length} bytes`);
            p.bytes = Buffer.from(jpeg);
            p.mime = "image/jpeg";
        }
    }
    const total = bodyBytes(fields, pics);
    if (total > MAX_BODY_BYTES) throw new Error(`MiniMax ${model}: this request comes to ${(total / MIB).toFixed(1)} MiB with its pictures, more than the 64 MiB the API takes${kept.length ? ` (${kept.join(", ")} has transparency, so it stays PNG)` : " even as JPEG"}. Set Highres fix lower or use smaller reference layers. Nothing was sent.`);
    return pics;
}

/** The POST's own limits: 630 s in place of undici's 300 s (the Comfy SDK's way, a delegate of the global dispatcher; ark.js does the same for a split). */
function longPostInit() {
    if (typeof globalThis.fetch !== "function") return {};   // reading `fetch` is what installs the symbol below
    const inner = Reflect.get(globalThis, Symbol.for("undici.globalDispatcher.1"));
    if (!inner || typeof inner.dispatch !== "function") return {};
    return { dispatcher: { headersTimeout: POST_TIMEOUT_MS, bodyTimeout: POST_TIMEOUT_MS, dispatch: (options, handler) => inner.dispatch({ ...options, headersTimeout: POST_TIMEOUT_MS, bodyTimeout: POST_TIMEOUT_MS }, handler) } };
}

const isAbort = (ctx, err) => (err && err.name === "AbortError") || (ctx.signal && ctx.signal.aborted);

/** The one send of a run: never repeated, since a second request is billed again. */
async function post(ctx, url, body, model) {
    const headers = { Authorization: "Bearer " + ctx.key, "Content-Type": "application/json" };
    try {
        return await ctx.fetch(url, { method: "POST", headers, body: JSON.stringify(body), ...longPostInit() });
    } catch (err) {
        if (isAbort(ctx, err)) throw err;   // providers/index.js has its own words for a Cancel
        const c = err && err.cause;
        const why = scrub((c && (c.code || c.message)) || (err && err.message) || String(err), ctx.key);
        throw new Error(`MiniMax ${model}: no answer (${why}). Scumble does not send it again, because a second request is billed again; this one may still be charged.`);
    }
}

async function run(req, ctx) {
    ctx = { ...ctx, log: ctx.log || (() => {}) };
    const model = modelFor(req);
    const where = hostFor(ctx, req.params);
    checkKey(where.test, ctx.key);
    req = { ...req, references: req.references || [] };
    const text = req.kind === "text";
    if (text && !String(req.prompt || "").trim()) throw new Error(`MiniMax ${model}: a new image needs a prompt.`);
    if (!text && !req.image) throw new Error(`MiniMax ${model}: no crop to edit.`);
    const prompt = promptFor(req);
    if (prompt.length > MAX_PROMPT) throw new Error(`MiniMax ${model} takes a prompt of at most ${MAX_PROMPT} characters; this one is ${prompt.length}. Nothing was sent.`);
    const size = sizeFor(req, model);
    const fields = fieldsFor(model, prompt, size);
    const pics = await picturesFor(req, fields, ctx, model);
    const body = pics.length ? { ...fields, images: pics.map((p) => ({ image_url: dataUrl(p) })) } : fields;
    const r = await post(ctx, where.host + (text ? TEXT_PATH : EDIT_PATH), body, model);
    if (!r.ok) {
        const f = await readFailure(r, ctx.key);
        throw new Error(scrub(`MiniMax ${model}: ${explain(r.status, f.type, f.code, f.message, where)}`, ctx.key));
    }
    let raw;
    try { raw = await r.text(); } catch (err) {
        if (isAbort(ctx, err)) throw err;
        throw new Error(scrub(`MiniMax ${model}: the answer was cut off (${(err && err.message) || err}). Scumble does not send it again; this run may be charged.`, ctx.key));
    }
    let j;
    try { j = JSON.parse(raw) || {}; } catch (_) {
        throw new Error(scrub(`MiniMax ${model}: an answer that is no JSON (${scrub(raw, ctx.key).slice(0, 200)})`, ctx.key));
    }
    if (j.error && !Array.isArray(j.data)) {
        const e = j.error;
        throw new Error(scrub(`MiniMax ${model}: ${explain(200, e.type, e.code != null ? e.code : codeOf(e.message), e.message || "error", where)}`, ctx.key));
    }
    const list = Array.isArray(j.data) ? j.data : [];
    const item = list.find((d) => d && d.b64_json);
    if (!item) {
        const bad = list.find((d) => d && d.error);
        if (bad) throw new Error(scrub(`MiniMax ${model}: ${explain(200, bad.error.type, bad.error.code, bad.error.message || "failed", where)}`, ctx.key));
        throw new Error(scrub(`MiniMax ${model}: no image in the answer (${scrub(JSON.stringify(j), ctx.key).slice(0, 200)})`, ctx.key));
    }
    const bytes = Buffer.from(item.b64_json, "base64");
    // the bytes say what they are; output_format asked for PNG
    const mime = bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : "image/png";
    return {
        bytes, mime, seed: undefined,   // the API has no seed
        info: { model, region: where.region, size, answered: item.size || null, pictures: pics.map((p) => `${p.what} ${p.mime === "image/jpeg" ? "jpeg" : "png"}`), revised_prompt: item.revised_prompt || null, usage: j.usage || null, request_id: j.request_id || null },
    };
}

module.exports = {
    label: "MiniMax",
    keyUrl: "https://platform.minimax.io/",
    keyHint: "API key from the MiniMax console (it belongs to the console it was made in: platform.minimax.io or platform.minimax.cn)",
    edit: run,
    generate: run,   // kind "text": /v1/images/generations, the prompt alone (no textLayout: index.js leaves references out)
    layout,
    baseUrl,
    checkKey,
    // exported for tools/minimax_test.js
    _testBase: testBase,
    _hostFor: hostFor,
    _size: sizeFor,
    _pictures: picturesFor,
    _explain: explain,
    _bodyBytes: bodyBytes,
    _longPostInit: longPostInit,
    REGIONS,
    MAX_BODY_BYTES,
};
