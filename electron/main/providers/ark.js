// BytePlus ModelArk: ByteDance's own API for the Seedream image models. Written from its API reference
// (docs.byteplus.com/en/docs/ModelArk/1541523, updated 2026-09-10; the error codes 1299023, the model list 1330310,
// the regions 2191806, the prices 1544106) on 2026-09-19; Seedream 5.5 (dola-seedream-5-5-261028, early access) from
// BytePlus's preview docs as the user passed them on 2026-11-08 (the public pages, read the same day, do not name it
// yet); nothing here has run against the live API yet (docs/RECIPES.md "BytePlus ModelArk" lists what only a real key
// can verify).
//
//   POST /api/v3/images/generations   JSON { model, prompt, image: [data URLs], size: "WxH", watermark: false,
//                                     response_format: "b64_json", output_format: "png", background? }
//                                     -> { model, created, data: [{ b64_json, size }], usage: { generated_images, ... } }
//                                     or { error: { code, message, param, type } }
//
// One synchronous request per image. There is no mask input: an edit sends the crop and the references ("image",
// crop first) and the stitch keeps the selection; a text run (Generate new) sends its references alone, none without.
// The size always goes as pixels ("WxH", the crop's own shape fitted into the model's pixel range, or the asked
// aspect for a text run; a tier such as "2K" would let the model pick the shape from the prompt). The API adds an
// "AI-generated" watermark unless it is told not to, so `watermark: false` goes on every request.
// layout(req) and textLayout(req) declare where each picture goes (docs/PLAN_REFS.md C3, 26f).
//
// A recipe variant describes the model with `options`:
//   pixels      [min, max] total pixels of the output ("Total pixels range" of method 2 on the reference page)
//   max_images  how many pictures go in (5.0 pro 10, 5.0 lite 14, 5.5 10)
//   png         true where the model takes output_format (5.0 pro and lite, 5.5; the 5.0 default is jpeg)
//   background  true where the variant's Background row (params.background: auto / transparent / opaque) goes out as
//               `background` (5.5: text to image and image to image with up to 10 pictures). Auto sends nothing (the
//               model's default), transparent always goes with output_format png. A variant without it never sends
//               the field (5.0 pro documents it only for exactly one input picture with an alpha channel)
//   early_access  true for a model BytePlus lets only some accounts call (5.5): a refusal that may mean the account
//               is not let in says so
//   regions     the Region row's values this model may use ("ap-southeast" Johor, "eu-west" Dublin); the first is
//               the default
//   layers      { max, options } where the model splits a picture into layers (kind "layers", below): `max` layers at
//               most besides the base (5.0 pro 16, 5.5 99), `options` true where it takes layer_decomposition_options
//               (5.5; the 5.0 schema does not have the field)
// Not sent on an edit or a text run: optimize_prompt_options (its mode defaults to standard, the only one 5.5 takes;
// there is no "off"), layer_decomposition (kind "layers" below), sequential_image_generation, stream, seed.
// Every picture must be no steeper than 16:1, more than 14 px a side, at most 30 MB and at most 36 MP; a picture over
// 30 MB goes as JPEG when it has no transparent pixel, anything else out of range is refused before sending.
//
// The host is one of the two regional hosts, chosen by the Region row (a key belongs to the region it was made in),
// never a URL from a recipe; settings.ark.base may name a loopback mock for the tests, and then only a key that
// starts with "test-" goes there, while such a key never goes to BytePlus.
//
// Layer decomposition (kind "layers", "Split into layers"; the 5.0 pro schema in
// tools/refs/comfyrouter/byteplus_seedream-5-0-pro-260628.json, the rest of 5.5 from the preview docs):
//   POST /api/v3/images/generations   JSON { model, image (exactly one picture), prompt? (none: the model finds the
//                                     major elements), size (a tier only: 1K, 1.5K, 2K, auto), layer_decomposition: true,
//                                     watermark: false, response_format, output_format: "png",
//                                     layer_decomposition_options?: { max_images, text_recognition } (5.5 only;
//                                     max_images counts the base too, 2 to 100: the Router's schema of 5.5
//                                     (tools/refs/comfyrouter/byteplus_seedream-5-5-261028.json), Comfy-Org/ComfyUI#17631
//                                     and ToAPIs' and WaveSpeed's pages, read 2026-11-11, so a count of n layers sends n + 1) }
//                                     -> data: [base, ...layers], the base first and without a bounding_box, every layer
//                                     { b64_json | url, z_index, bounding_box: { absolute: [l, t, r, b], normalized },
//                                     name, description, size }
// If any layer fails the whole request fails, so an answer is all of them or an error. A layer's PNG is near the tier's
// size, not its box's: the box says where it goes.
"use strict";

const { fetchImage, sleep: realSleep, fitPixels } = require("./util");
const { layoutOf, refRoles, instruction } = require("./refs");

const REGIONS = {
    "ap-southeast": "https://ark.ap-southeast.bytepluses.com",   // Johor, Malaysia
    "eu-west": "https://ark.eu-west.bytepluses.com",             // Dublin, Ireland
};
const DEFAULT_REGION = "ap-southeast";
const PATH = "/api/v3/images/generations";
const MAX_PICTURE_BYTES = 30 * 1000 * 1000;   // "Size: Up to 30 MB", read as the smaller 10^6 megabyte
const MAX_PICTURE_PIXELS = 36000000;
const MIN_PICTURE_EDGE = 15;                  // "Width and height (px): > 14"
const MAX_RATIO = 16;
const JPEG_QUALITY = 92;
// layer decomposition: the documented input ("total pixels in the range [512x512, 6000x6000]", aspect [1/16, 16]) and
// sizes; renderer/editor/splitlayers.js refuses the same before anything is read, tools/ark_test.js holds the two together
const LAYER_MIN_PIXELS = 512 * 512;
const LAYER_MAX_PIXELS = 6000 * 6000;
const LAYER_TIERS = ["1K", "1.5K", "2K", "auto"];
const LAYER_COUNT_DEFAULT = 16;
// an answer of many layers as base64 would pass what one string of JSON may hold in V8 (about 512 MB): above this many
// layers the service is asked for URLs (they live 24 hours and need no key), and they come one after another
const LAYER_URLS_ABOVE = 32;
// a finished job's pictures: the base carries the frame every box is in, so it gets more tries; a layer that stays
// away is left out and named, the rest land (the job is charged whatever a download does)
const LAYER_BASE_TRIES = 5;
const LAYER_PIECE_TRIES = 3;
// one synchronous request makes up to 101 pictures: undici's own 300 s for the answer's headers must not end it first
const LAYER_POST_TIMEOUT_MS = 900000;
const LAYER_POST_GRACE_MS = 30000;
const MAX_TIMER_MS = 2147483647;
const RETRY_WAIT_MS = 5000;
const RETRY_WAIT_MAX_MS = 60000;
// codes a second request can outlast (nothing was generated, and only generated images are billed)
const RETRYABLE = new Set(["ModelAccountIpmRateLimitExceeded", "ServerOverloaded"]);

/** http://127.0.0.1:<port> (the test mock) or null: the only base a setting may name. */
function testBase(value) {
    if (!value) return null;
    let u;
    try { u = new URL(String(value).trim()); } catch (_) { return null; }
    if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) return null;
    if (u.protocol === "http:" && u.hostname === "127.0.0.1" && u.port) return `${u.protocol}//${u.host}`;
    return null;
}

/** settings.ark.base when it is the loopback mock, else null (the Region row picks the host). */
function baseUrl(settings) {
    const s = (settings && settings.ark) || {};
    return testBase(s.base);
}

/** The host a run goes to: the test mock, or the region's host; an unknown region is refused. */
function hostFor(ctx, region, allowed) {
    const test = testBase(ctx.base);
    const r = String(region || (allowed && allowed[0]) || DEFAULT_REGION);
    if (!Object.prototype.hasOwnProperty.call(REGIONS, r)) throw new Error(`ModelArk: no region "${r}" (${Object.keys(REGIONS).join(", ")}).`);
    if (Array.isArray(allowed) && allowed.length && !allowed.includes(r)) throw new Error(`ModelArk: this model is not offered in the region "${r}" (${allowed.join(", ")}).`);
    return { host: test || REGIONS[r], region: r, test: !!test };
}

/** A test key goes only to the mock, a real key never there. Throws before any request. */
function checkKey(test, key) {
    const isTest = /^test-/.test(String(key || ""));
    if (test && !isTest) throw new Error("ModelArk: the host is set to a test address (settings.ark.base), and only a test key goes there; clear the setting to use a real key.");
    if (!test && isTest) throw new Error("ModelArk: a test key is never sent to BytePlus; store a real key under Settings › API providers.");
}

function scrub(text, key) {
    let s = String(text == null ? "" : text);
    if (key && key.length >= 6) s = s.split(key).join("[key]");
    return s;
}

const REGION_NAMES = { "ap-southeast": "Johor", "eu-west": "Dublin" };

// a refusal an account outside a model's early access may get (the preview docs name no code of their own for it)
const EARLY_ACCESS = "this model is in early access: BytePlus has to let the account in first, then activate it under Model activation in the ModelArk console";

/**
 * What a failed answer means, by its error code (the error-code page) before its status, ahead of the server's
 * words. `where` ({ region, regions, early }) words the key hint: with a Region row it points there, with one region
 * it names it; `early` (a model in early access) adds the access hint to a refusal that may mean the account is not
 * let in (not activated, no such model, a 403 or 404 of no known code).
 */
function explain(status, code, message, where) {
    const w = where || {};
    const why = explainWhy(status, code, w);
    const c = String(code || "");
    const notLetIn = c === "ModelNotOpen" || (c.startsWith("InvalidEndpointOrModel") && c !== "InvalidEndpointOrModel.ModelIDAccessDisabled")
        || (status === 403 && !why) || (status === 404 && !c);
    const words = w.early && notLetIn ? (why ? `${why} (${EARLY_ACCESS})` : EARLY_ACCESS) : why;
    return words ? `${words} - ${c ? c + ": " : ""}${message}` : `${c ? c + ": " : ""}${message}`;
}

function explainWhy(status, code, w) {
    const c = String(code || "");
    let why = null;
    if (c === "InvalidAccountStatus") why = "the BytePlus account's status blocks the call: see the ModelArk console or BytePlus support";
    else if (c === "AuthenticationError" || (status === 401 && !c)) {
        const name = REGION_NAMES[w.region] || w.region;
        why = Array.isArray(w.regions) && w.regions.length > 1
            ? `key refused by the ${name || "chosen"} host (a key works only in the region it was made in: check the Region row)`
            : `key refused (this model runs in ${name || "one region"} only, and a key works only in the region it was made in)`;
    }
    else if (status === 401) why = "refused";
    else if (c === "AccountOverdueError") why = "the BytePlus account is overdue: top it up in the console";
    else if (c.startsWith("OperationDenied.ServiceNotOpen")) why = "ModelArk is not activated on this account";
    else if (c === "ModelNotOpen") why = "the model is not activated: activate it under Model activation in the ModelArk console";
    else if (c === "InvalidEndpointOrModel.ModelIDAccessDisabled") why = "this account must call the model through an endpoint id, which Scumble does not support yet";
    else if (c.startsWith("InvalidEndpointOrModel")) why = "no such model in this region";
    else if (c === "InputImageSensitiveContentDetected.PrivacyInformation") why = "refused: the picture may show a real person";
    else if (/SensitiveContentDetected/.test(c)) why = "refused by the content filter";
    else if (c === "ModelAccountIpmRateLimitExceeded") why = "rate limited (images per minute)";
    else if (c === "SetLimitExceeded") why = "paused by the account's Safe Experience Mode limit (the console's model settings)";
    else if (c === "QuotaExceeded") why = "a quota is used up, or too many tasks are queued (the free quota, a period's quota or the queue: the server's words say which)";
    else if (c === "ServerOverloaded") why = "the service is overloaded";
    else if (/^InvalidImageURL/.test(c)) why = "a picture was not accepted";
    else if (c === "InvalidParameter" || c === "MissingParameter" || status === 400) why = "request refused";
    else if (status === 404) why = "not found";
    else if (status === 429) why = "rate limited";
    else if (status >= 500) why = "the service failed";
    return why;
}

/** { code, message } of a failed answer ({ error: { code, message, param, type } }), else the text; the key taken out before any cut. */
async function readFailure(r, key) {
    let text = "";
    try { text = await r.text(); } catch (_) { text = ""; }
    text = scrub(text, key);
    try {
        const j = JSON.parse(text);
        const e = j && j.error;
        if (e && typeof e === "object") return { code: e.code || "", message: String(e.message || e.type || r.statusText || r.status) };
    } catch (_) { /* not JSON */ }
    return { code: "", message: text.slice(0, 300) || r.statusText || String(r.status) };
}

function retryAfterMs(r, fallback = RETRY_WAIT_MS) {
    const v = r.headers && r.headers.get && r.headers.get("retry-after");
    if (v == null || v === "") return fallback;
    const n = Number(v);
    if (Number.isFinite(n)) return Math.max(0, n * 1000);
    const at = Date.parse(v);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : fallback;
}

/** [width, height] from a PNG's IHDR, or null for anything else. */
function pngSize(b) {
    if (!b || b.length < 24) return null;
    if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
    const v = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    return [v(16), v(20)];
}

/**
 * The pictures of a run, in order: the crop, then the references; a text run (Generate new) has the references alone,
 * none without. Checks count, shape, pixels and bytes against the reference page's input rules; a picture over 30 MB
 * goes as JPEG when it has no transparent pixel. Throws before any request.
 */
async function picturesFor(req, o, ctx, model) {
    const text = req.kind === "text";
    const pics = text ? [] : [{ what: req.kind === "layers" ? "picture" : "crop", bytes: Buffer.from(req.image), mime: "image/png" }];
    req.references.forEach((r, i) => pics.push({ what: `reference ${i + 1}`, bytes: Buffer.from(r), mime: "image/png" }));
    const max = +o.max_images > 0 ? +o.max_images : 10;
    if (pics.length > max) {
        // index.js refuses first (refs.checkPictures, in the same words for a text run); this stays the safety net
        if (text) throw new Error(`ModelArk ${model} takes at most ${max} reference picture${max === 1 ? "" : "s"} for a new image; this run has ${pics.length}: hide reference layers.`);
        const refs = req.references.length;
        throw new Error(`ModelArk ${model} takes at most ${max} pictures; this run has ${pics.length} (the crop, ${refs} reference${refs === 1 ? "" : "s"}): turn Original off or hide reference layers.`);
    }
    for (const p of pics) {
        const s = pngSize(p.bytes);
        if (s) {
            const [w, h] = s;
            if (Math.min(w, h) < MIN_PICTURE_EDGE) throw new Error(`ModelArk ${model}: the ${p.what} is ${w} × ${h}; every picture must be more than 14 px a side.`);
            if (Math.max(w, h) > MAX_RATIO * Math.min(w, h)) throw new Error(`ModelArk ${model} takes pictures no steeper than 16:1; the ${p.what} is ${w} × ${h}. Use a less narrow ${text ? "reference layer" : "selection or reference layer"}.`);
            if (w * h > MAX_PICTURE_PIXELS) throw new Error(`ModelArk ${model} takes pictures of at most 36 megapixels; the ${p.what} is ${w} × ${h}. Use a smaller reference layer.`);
        }
        if (p.bytes.length > MAX_PICTURE_BYTES) {
            const opaque = typeof ctx.opaque === "function" && (await ctx.opaque(p.bytes));
            const jpeg = opaque && typeof ctx.toJpeg === "function" ? await ctx.toJpeg(p.bytes, JPEG_QUALITY) : null;
            if (!jpeg || !jpeg.length || jpeg.length > MAX_PICTURE_BYTES) {
                throw new Error(`ModelArk ${model}: the ${p.what} is ${(p.bytes.length / 1e6).toFixed(1)} MB, more than the 30 MB a picture may have${opaque ? " even as JPEG" : " (it has transparency, so it stays PNG)"}. ${req.kind === "layers" ? "Use a smaller picture or layer." : `${text ? "Use" : "Set Highres fix lower or use"} a smaller reference layer.`}`);
            }
            ctx.log(`${p.what} ${p.bytes.length} bytes as JPEG ${jpeg.length} bytes`);
            p.bytes = Buffer.from(jpeg);
            p.mime = "image/jpeg";
        }
    }
    return pics;
}

/** Where picturesFor above puts each picture: `image` holds the crop, then the references (there is no mask input). */
function layout(req) {
    const o = req.options || {};
    return layoutOf({ seq: [["crop", "image[0]"], ...refRoles(req).map(([role, i]) => [role, `image[${i + 1}]`, i])], max: +o.max_images > 0 ? +o.max_images : 10 });
}

/**
 * The same for a text run (Generate new, 26f): `image` holds the references alone, numbered from 1, as many as an edit
 * takes pictures (the crop's slot becomes a reference's).
 */
function textLayout(req) {
    const o = req.options || {};
    return layoutOf({ seq: refRoles(req).map(([role, i]) => [role, `image[${i}]`, i]), max: +o.max_images > 0 ? +o.max_images : 10 });
}

function gcd(a, b) {
    while (b) [a, b] = [b, a % b];
    return a;
}

/**
 * The size of exactly a:b on 16 px steps whose long side is nearest `long`, moved into [min, max] pixels; null when
 * no size of that aspect lies in the range or the aspect is steeper than 16:1.
 */
function exactSize(a, b, long, min, max) {
    let x = a, y = b;
    for (let i = 0; i < 6 && (!Number.isInteger(x) || !Number.isInteger(y)); i++) { x *= 2; y *= 2; }   // 19.5:9 -> 39:18
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 1 || y < 1) return null;
    const g = gcd(x, y);
    const uw = 16 * (x / g), uh = 16 * (y / g);
    if (Math.max(uw, uh) > MAX_RATIO * Math.min(uw, uh)) return null;
    let t = Math.max(1, Math.round(long / Math.max(uw, uh)));
    while (uw * uh * t * t < min) t++;
    while (t > 1 && uw * uh * t * t > max) t--;
    const area = uw * uh * t * t;
    return area >= min && area <= max ? [uw * t, uh * t] : null;
}

function aspectNumbers(aspect) {
    const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(aspect || ""));
    return m && +m[1] > 0 && +m[2] > 0 ? [+m[1], +m[2]] : null;
}

/**
 * The output size as "WxH": the emitted crop's own size (an edit), or for a text run exactly the asked aspect at the
 * size nearest the asked long side (the dialog's rounded pixel size would miss 3:2 or 21:9 by a little); both in
 * 16 px steps, inside the model's pixel range and no steeper than 16:1.
 */
function sizeFor(req, o) {
    let w = Math.max(1, +req.width || 2048), h = Math.max(1, +req.height || 2048);
    const [min, max] = Array.isArray(o.pixels) ? o.pixels.map(Number) : [921600, 4624220];
    const a = req.kind === "text" ? aspectNumbers(req.aspect) : null;
    if (a) {
        const exact = exactSize(a[0], a[1], Math.max(w, h), min, max);
        if (exact) return `${exact[0]}x${exact[1]}`;
        const long = Math.max(w, h);
        if (a[0] >= a[1]) { w = long; h = long * a[1] / a[0]; } else { h = long; w = long * a[0] / a[1]; }
    }
    let [pw, ph] = fitPixels(w, h, { step: 16, max: 16384, minPixels: min, maxPixels: max, maxRatio: MAX_RATIO });
    // fitPixels' last area loop can tip a size near 16:1 past it: the long side back, which only lowers the area
    if (pw > MAX_RATIO * ph) pw = MAX_RATIO * ph;
    else if (ph > MAX_RATIO * pw) ph = MAX_RATIO * pw;
    return `${pw}x${ph}`;
}

/**
 * The prompt of a run: refs.instruction numbered by layout() (no mask picture here), or by textLayout() for a text run
 * (its text as it is, then what its references are, if any).
 */
function promptFor(req) {
    return instruction(req, req.kind === "text" ? textLayout(req) : layout(req), req.prompt);
}

const BACKGROUNDS = ["auto", "transparent", "opaque"];

/**
 * The `background` a run sends: null for a variant without options.background (whatever the params say) and for
 * auto (the model's default); an unknown value is refused before any request.
 */
function backgroundFor(req, o) {
    if (!o.background) return null;
    const raw = (req.params || {}).background;
    const v = raw == null || raw === "" ? "auto" : String(raw).trim().toLowerCase();
    if (!BACKGROUNDS.includes(v)) throw new Error(`ModelArk ${req.model}: Background "${raw}" is none of ${BACKGROUNDS.join(", ")}.`);
    return v === "auto" ? null : v;
}

function bodyFor(req, o, pics) {
    const body = { model: String(req.model || ""), prompt: promptFor(req), size: sizeFor(req, o), watermark: false, response_format: "b64_json" };
    if (o.png) body.output_format = "png";
    const background = backgroundFor(req, o);
    if (background) {
        body.background = background;
        // only PNG carries the alpha, and a transparent background with jpeg is an error
        if (background === "transparent") body.output_format = "png";
    }
    if (pics.length) body.image = pics.map((p) => `data:${p.mime};base64,${p.bytes.toString("base64")}`);
    return body;
}

async function post(ctx, url, body, extra = {}) {
    const headers = { Authorization: "Bearer " + ctx.key, "Content-Type": "application/json" };
    const send = () => ctx.fetch(url, { method: "POST", headers, body: JSON.stringify(body), ...extra });
    let r = await send();
    // a per-minute rate limit or an overloaded service means nothing was generated, and only generated images are
    // billed, so one retry is safe, never before the time the server set; a network error is never retried (an
    // answer lost on the way may be a paid image)
    if (r.status === 429 || r.status === 503 || r.status === 500) {
        const peek = await r.clone().json().catch(() => null);
        const code = peek && peek.error && peek.error.code;
        if (RETRYABLE.has(code)) {
            const ms = retryAfterMs(r);
            if (ms > RETRY_WAIT_MAX_MS) {
                r.waitSeconds = Math.ceil(ms / 1000);
                return r;
            }
            ctx.log(`answered ${r.status} ${code}, sending once more after ${ms} ms`);
            await ctx.sleep(ms);
            r = await send();
            if (!r.ok) {
                const again = retryAfterMs(r, 0);
                if (again > 0) r.waitSeconds = Math.ceil(again / 1000);
            }
        }
    }
    return r;
}

/** The JSON of an answer, or the error of a failed one in the adapter's words. */
async function readAnswer(r, ctx, model, at) {
    if (!r.ok) {
        const f = await readFailure(r, ctx.key);
        throw new Error(scrub(`ModelArk ${model}: ${explain(r.status, f.code, f.message, at)}${r.waitSeconds ? `; try again in ${r.waitSeconds} s` : ""}`, ctx.key));
    }
    const j = (await r.json()) || {};
    if (j.error) throw new Error(scrub(`ModelArk ${model}: ${explain(200, j.error.code, j.error.message || "error", at)}`, ctx.key));
    return j;
}

async function run(req, ctx) {
    // ctx.sleep is injectable so tools/ark_test.js waits in milliseconds
    ctx = { ...ctx, sleep: ctx.sleep || realSleep, log: ctx.log || (() => {}) };
    const model = String(req.model || "");
    if (!model) throw new Error("ModelArk recipe has no model id.");
    const o = req.options || {};
    const p = req.params || {};
    const where = hostFor(ctx, p.region, o.regions);
    checkKey(where.test, ctx.key);
    req = { ...req, references: req.references || [] };
    if (req.kind === "text" && !String(req.prompt || "").trim()) throw new Error(`ModelArk ${model}: a new image needs a prompt.`);
    if (req.kind !== "text" && !req.image) throw new Error(`ModelArk ${model}: no crop to edit.`);
    backgroundFor(req, o);   // an unknown Background is refused before the pictures are read
    // a text run's pictures are its references (none without: then the body is the text-to-image one as before)
    const pics = await picturesFor(req, o, ctx, model);
    const body = bodyFor(req, o, pics);
    const r = await post(ctx, where.host + PATH, body);
    const at = { region: where.region, regions: o.regions, early: !!o.early_access };
    const j = await readAnswer(r, ctx, model, at);
    const item = Array.isArray(j.data) ? j.data.find((d) => d && (d.b64_json || d.url)) : null;
    if (!item) {
        const e = Array.isArray(j.data) && j.data.find((d) => d && d.error);
        throw new Error(scrub(`ModelArk ${model}: ${e ? explain(200, e.error.code, e.error.message, at) : "no image in the answer (" + scrub(JSON.stringify(j), ctx.key).slice(0, 200) + ")"}`, ctx.key));
    }
    let bytes, mime;
    if (item.b64_json) {
        bytes = Buffer.from(item.b64_json, "base64");
        // the bytes say what they are (output_format is answered by 5.0 pro only; the default is jpeg)
        mime = bytes[0] === 0x89 && bytes[1] === 0x50 ? "image/png" : bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : (o.png ? "image/png" : "image/jpeg");
    } else {
        // only if the service ignored response_format: its URL lives 24 hours and needs no key
        const got = await fetchImage(item.url, ctx.fetch);
        bytes = got.bytes;
        mime = got.mime;
    }
    const usage = j.usage || {};
    return {
        bytes, mime, seed: undefined,   // the body carries no seed
        info: { model: j.model || model, region: where.region, size: body.size, answered: item.size || null, background: body.background || null, pictures: pics.map((x) => `${x.what} ${x.mime === "image/jpeg" ? "jpeg" : "png"}`), generated_images: usage.generated_images != null ? usage.generated_images : null },
    };
}

// ---- layer decomposition ("Split into layers", kind "layers") ------------------------------------------------------

/** The variant's `options.layers` as { max, options }, or null: the model has no layer mode. */
function layerSpec(o) {
    const s = o && o.layers;
    return s && typeof s === "object" && +s.max > 0 ? { max: Math.floor(+s.max), options: !!s.options } : null;
}

/** "" when a w x h picture may go, else the refusal (the documented pixels and aspect). */
function layerSizeRefusal(w, h, model) {
    const pixels = w * h;
    if (Math.min(w, h) >= MIN_PICTURE_EDGE && pixels >= LAYER_MIN_PIXELS && pixels <= LAYER_MAX_PIXELS && Math.max(w, h) <= MAX_RATIO * Math.min(w, h)) return "";
    return `The picture is ${w} × ${h} (${(pixels / 1e6).toFixed(2)} megapixels): ${model} splits pictures of 512 × 512 to 6000 × 6000 in area, no steeper than 16:1.`;
}

/** What a request asks for, refused before any call when the model cannot: { tier, count (null: the model's own), textRecognition }. */
function layerAsk(req, model, spec) {
    const p = req.params || {};
    const tier = p.size == null || p.size === "" ? "auto" : String(p.size);
    if (!LAYER_TIERS.includes(tier)) throw new Error(`ModelArk ${model}: the size of a split is a tier (${LAYER_TIERS.join(", ")}), not "${p.size}".`);
    const textRecognition = !!p.text_recognition;
    if (!spec.options) {
        if (p.count != null && p.count !== "" && +p.count !== spec.max) throw new Error(`ModelArk ${model} finds its own number of layers, up to ${spec.max}: it takes no count.`);
        if (textRecognition) throw new Error(`ModelArk ${model} has no Text recognition switch for a split.`);
        return { tier, count: null, textRecognition: false };
    }
    const raw = p.count == null || p.count === "" ? Math.min(LAYER_COUNT_DEFAULT, spec.max) : +p.count;
    if (!Number.isInteger(raw) || raw < 1 || raw > spec.max) throw new Error(`ModelArk ${model}: the number of layers is a whole number from 1 to ${spec.max}, not "${p.count}".`);
    return { tier, count: raw, textRecognition };
}

/** The request body of a split: the one picture alone (a string, the documented single form), a tier, the switch. */
function layersBody(req, ask, pic, spec) {
    const body = {
        model: String(req.model || ""),
        image: `data:${pic.mime};base64,${pic.bytes.toString("base64")}`,
        size: ask.tier,
        layer_decomposition: true,
        watermark: false,
        response_format: (ask.count != null ? ask.count : spec.max) > LAYER_URLS_ABOVE ? "url" : "b64_json",
        output_format: "png",   // the base's; every layer is PNG whatever this says
    };
    const prompt = String(req.prompt || "").trim();
    if (prompt) body.prompt = prompt;
    // max_images is the base and the layers together (2 to 100), the count the layers alone
    if (spec.options) body.layer_decomposition_options = { max_images: ask.count + 1, text_recognition: ask.textRecognition };
    return body;
}

/**
 * The entries of an answer in stacking order, the base first. The base is the row without a bounding box (the 5.0 pro
 * schema), else the row of z_index 0, else data[0]: an answer of a job already charged is not thrown away over the shape
 * of a model known only from preview docs.
 */
function orderLayers(data) {
    const hasZ = (d) => d.z_index !== null && d.z_index !== undefined && d.z_index !== "" && Number.isFinite(+d.z_index);
    const rows = data.map((d, i) => ({ d, i, z: hasZ(d) ? +d.z_index : i })).sort((a, b) => a.z - b.z || a.i - b.i);
    let at = rows.findIndex((x) => !x.d.bounding_box);
    if (at < 0) at = rows.findIndex((x) => hasZ(x.d) && +x.d.z_index === 0);
    if (at < 0) at = rows.findIndex((x) => x.i === 0);
    return [rows[at], ...rows.slice(0, at), ...rows.slice(at + 1)];
}

/** The POST's own limits for a split: the run's deadline in place of undici's 300 s (the Comfy SDK's way, a delegate of the global dispatcher). */
function layerPostInit(timeoutMs) {
    if (typeof globalThis.fetch !== "function") return {};   // reading `fetch` is what installs the symbol below
    const inner = Reflect.get(globalThis, Symbol.for("undici.globalDispatcher.1"));
    if (!inner || typeof inner.dispatch !== "function") return {};
    const ms = Math.min(MAX_TIMER_MS, (+timeoutMs > 0 ? +timeoutMs : LAYER_POST_TIMEOUT_MS) + LAYER_POST_GRACE_MS);
    return { dispatcher: { headersTimeout: ms, bodyTimeout: ms, dispatch: (options, handler) => inner.dispatch({ ...options, headersTimeout: ms, bodyTimeout: ms }, handler) } };
}

/** One entry's picture: its bytes, as inlined or downloaded from its URL (which needs no key), `tries` times with growing waits. */
async function layerBytes(item, ctx, tries) {
    if (item.b64_json) {
        const bytes = Buffer.from(item.b64_json, "base64");
        return { bytes, mime: bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : "image/png" };
    }
    for (let attempt = 1; ; attempt++) {
        try { return await fetchImage(item.url, ctx.fetch); }
        catch (err) {
            if (attempt >= tries || (ctx.signal && ctx.signal.aborted)) throw err;
            ctx.log(`a layer's download failed (${err && err.message}), once more`);
            await ctx.sleep(RETRY_WAIT_MS * 2 ** (attempt - 1));
        }
    }
}

/**
 * Split one picture into layers (req.image; no references, no mask). -> { bytes (the base's), mime, layers: [{ bytes,
 * mime, z_index, base, bounding_box, name, description, size }] (the base first, then bottom to top), missing: the names
 * of the layers whose download failed, info }. The service generates every layer or none; a link that stays away after
 * the job is charged costs that layer, not the answer. `req.timeoutMs`: the run's deadline.
 */
async function layers(req, ctx) {
    const caller = ctx;   // the job's state is read on the object providers/index.js holds
    ctx = { ...ctx, sleep: ctx.sleep || realSleep, log: ctx.log || (() => {}) };
    const model = String(req.model || "");
    if (!model) throw new Error("ModelArk recipe has no model id.");
    const o = req.options || {};
    const spec = layerSpec(o);
    if (!spec) throw new Error(`ModelArk ${model} has no layer mode.`);
    const where = hostFor(ctx, (req.params || {}).region, o.regions);
    checkKey(where.test, ctx.key);
    if (!req.image) throw new Error(`ModelArk ${model}: no picture to split.`);
    if ((req.references || []).length) throw new Error(`ModelArk ${model} splits exactly one picture; this run has ${req.references.length + 1}.`);
    const ask = layerAsk(req, model, spec);
    const dims = pngSize(Buffer.from(req.image));
    if (dims) {
        const no = layerSizeRefusal(dims[0], dims[1], model);
        if (no) throw new Error(no);
    }
    const [pic] = await picturesFor({ ...req, references: [] }, { ...o, max_images: 1 }, ctx, model);
    const body = layersBody(req, ask, pic, spec);
    const r = await post(ctx, where.host + PATH, body, layerPostInit(req.timeoutMs));
    const at = { region: where.region, regions: o.regions, early: !!o.early_access };
    const j = await readAnswer(r, ctx, model, at);
    caller.jobDone = true;   // answered: generated and charged, so a Cancel during the downloads says that
    const data = Array.isArray(j.data) ? j.data : [];
    const bad = data.find((d) => d && d.error);
    if (bad) throw new Error(scrub(`ModelArk ${model}: ${explain(200, bad.error.code, bad.error.message, at)}`, ctx.key));
    const usable = data.filter((d) => d && (d.b64_json || d.url));
    if (!usable.length || usable.length !== data.length) throw new Error(scrub(`ModelArk ${model}: an answer without its pictures (${usable.length} of ${data.length})`, ctx.key));
    const ordered = orderLayers(usable);
    const out = [], missing = [];
    for (let k = 0; k < ordered.length; k++) {
        const d = ordered[k].d;
        let got;
        try { got = await layerBytes(d, ctx, k === 0 ? LAYER_BASE_TRIES : LAYER_PIECE_TRIES); }
        catch (err) {
            if (ctx.signal && ctx.signal.aborted) throw err;
            const why = scrub(String((err && err.message) || err), ctx.key);
            if (k === 0) throw new Error(`ModelArk ${model}: the job finished and is charged, but its base picture could not be downloaded (${why}); nothing landed.`);
            ctx.log(`layer "${d.name || k}" left out, its download failed: ${why} (${d.url})`);
            missing.push(d.name == null || d.name === "" ? `Layer ${k}` : String(d.name));
            continue;
        }
        out.push({ bytes: got.bytes, mime: got.mime, z_index: ordered[k].z, base: k === 0, bounding_box: d.bounding_box || null, name: d.name == null ? "" : String(d.name), description: d.description == null ? "" : String(d.description), size: d.size || null });
    }
    const usage = j.usage || {};
    return {
        bytes: out[0].bytes, mime: out[0].mime, seed: undefined, layers: out, missing,
        info: { model: j.model || model, region: where.region, size: body.size, answered: out[0].size, layers: out.length - 1, asked: ask.count, text_recognition: spec.options ? ask.textRecognition : null, picture: pic.mime === "image/jpeg" ? "jpeg" : "png", by: body.response_format, generated_images: usage.generated_images != null ? usage.generated_images : null },
    };
}

module.exports = {
    label: "BytePlus ModelArk (Seedream)",
    keyUrl: "https://ai.byteplus.com/ark/region:ap-southeast-1/apiKey",
    keyHint: "API key from the ModelArk console (it belongs to the region it was made in)",
    edit: run,
    generate: run,   // kind "text": the same endpoint, `image` the references alone (none without)
    layers,          // kind "layers": Split into layers
    layout,
    textLayout,
    baseUrl,
    // exported for tools/ark_test.js
    _testBase: testBase,
    _hostFor: hostFor,
    _body: bodyFor,
    _size: sizeFor,
    _pictures: picturesFor,
    _background: backgroundFor,
    _explain: explain,
    _layerSizeRefusal: layerSizeRefusal,
    _layerPostInit: layerPostInit,   // oxen.js: a split's one synchronous request outlasts undici's 300 s the same way
    REGIONS,
    MAX_PICTURE_BYTES,
};
