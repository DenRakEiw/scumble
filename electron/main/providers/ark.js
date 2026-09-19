// BytePlus ModelArk: ByteDance's own API for the Seedream image models. Written from its API reference
// (docs.byteplus.com/en/docs/ModelArk/1541523, updated 2026-09-10; the error codes 1299023, the model list 1330310,
// the regions 2191806, the prices 1544106) on 2026-09-19; nothing here has run against the live API yet
// (docs/RECIPES.md "BytePlus ModelArk" lists what only a real key can verify).
//
//   POST /api/v3/images/generations   JSON { model, prompt, image: [data URLs], size: "WxH", watermark: false,
//                                     response_format: "b64_json", output_format: "png" }
//                                     -> { model, created, data: [{ b64_json, size }], usage: { generated_images, ... } }
//                                     or { error: { code, message, param, type } }
//
// One synchronous request per image. There is no mask input: an edit sends the crop and the references ("image",
// crop first) and the stitch keeps the selection. The size always goes as pixels ("WxH", the crop's own shape fitted
// into the model's pixel range; a tier such as "2K" would let the model pick the shape from the prompt). The API
// adds an "AI-generated" watermark unless it is told not to, so `watermark: false` goes on every request.
//
// A recipe variant describes the model with `options`:
//   pixels      [min, max] total pixels of the output ("Total pixels range" of method 2 on the reference page)
//   max_images  how many pictures go in (5.0 pro 10, 5.0 lite 14)
//   png         true where the model takes output_format (5.0 pro and lite; the default is jpeg)
//   regions     the Region row's values this model may use ("ap-southeast" Johor, "eu-west" Dublin); the first is
//               the default
// Every picture must be no steeper than 16:1, more than 14 px a side, at most 30 MB and at most 36 MP; a picture over
// 30 MB goes as JPEG when it has no transparent pixel, anything else out of range is refused before sending.
//
// The host is one of the two regional hosts, chosen by the Region row (a key belongs to the region it was made in),
// never a URL from a recipe; settings.ark.base may name a loopback mock for the tests, and then only a key that
// starts with "test-" goes there, while such a key never goes to BytePlus.
"use strict";

const { fetchImage, sleep: realSleep, fitPixels } = require("./util");

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

/**
 * What a failed answer means, by its error code (the error-code page) before its status, ahead of the server's
 * words. `where` ({ region, regions }) words the key hint: with a Region row it points there, with one region it
 * names it.
 */
function explain(status, code, message, where) {
    const c = String(code || "");
    const w = where || {};
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
    return why ? `${why} - ${c ? c + ": " : ""}${message}` : `${c ? c + ": " : ""}${message}`;
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
 * The pictures of an edit, in order: the crop, then the references. Checks count, shape, pixels and bytes against
 * the reference page's input rules; a picture over 30 MB goes as JPEG when it has no transparent pixel. Throws
 * before any request.
 */
async function picturesFor(req, o, ctx, model) {
    const pics = [{ what: "crop", bytes: Buffer.from(req.image), mime: "image/png" }];
    req.references.forEach((r, i) => pics.push({ what: `reference ${i + 1}`, bytes: Buffer.from(r), mime: "image/png" }));
    const max = +o.max_images > 0 ? +o.max_images : 10;
    if (pics.length > max) {
        const refs = req.references.length;
        throw new Error(`ModelArk ${model} takes at most ${max} pictures; this run has ${pics.length} (the crop, ${refs} reference${refs === 1 ? "" : "s"}): turn Original off or hide reference layers.`);
    }
    for (const p of pics) {
        const s = pngSize(p.bytes);
        if (s) {
            const [w, h] = s;
            if (Math.min(w, h) < MIN_PICTURE_EDGE) throw new Error(`ModelArk ${model}: the ${p.what} is ${w} × ${h}; every picture must be more than 14 px a side.`);
            if (Math.max(w, h) > MAX_RATIO * Math.min(w, h)) throw new Error(`ModelArk ${model} takes pictures no steeper than 16:1; the ${p.what} is ${w} × ${h}. Use a less narrow selection or reference layer.`);
            if (w * h > MAX_PICTURE_PIXELS) throw new Error(`ModelArk ${model} takes pictures of at most 36 megapixels; the ${p.what} is ${w} × ${h}. Use a smaller reference layer.`);
        }
        if (p.bytes.length > MAX_PICTURE_BYTES) {
            const opaque = typeof ctx.opaque === "function" && (await ctx.opaque(p.bytes));
            const jpeg = opaque && typeof ctx.toJpeg === "function" ? await ctx.toJpeg(p.bytes, JPEG_QUALITY) : null;
            if (!jpeg || !jpeg.length || jpeg.length > MAX_PICTURE_BYTES) {
                throw new Error(`ModelArk ${model}: the ${p.what} is ${(p.bytes.length / 1e6).toFixed(1)} MB, more than the 30 MB a picture may have${opaque ? " even as JPEG" : " (it has transparency, so it stays PNG)"}. Set Highres fix lower or use a smaller reference layer.`);
            }
            ctx.log(`${p.what} ${p.bytes.length} bytes as JPEG ${jpeg.length} bytes`);
            p.bytes = Buffer.from(jpeg);
            p.mime = "image/jpeg";
        }
    }
    return pics;
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

function promptFor(req, pics) {
    const text = String(req.prompt || "");
    if (req.kind === "text") return text;
    const refs = pics.length - 1;
    let out = `Edit the first image and keep its size and framing. ${text}`;
    if (refs) out += ` The remaining image${refs > 1 ? "s are" : " is"} reference material.`;
    return out.trim();
}

function bodyFor(req, o, pics) {
    const body = { model: String(req.model || ""), prompt: promptFor(req, pics), size: sizeFor(req, o), watermark: false, response_format: "b64_json" };
    if (o.png) body.output_format = "png";
    if (pics.length) body.image = pics.map((p) => `data:${p.mime};base64,${p.bytes.toString("base64")}`);
    return body;
}

async function post(ctx, url, body) {
    const headers = { Authorization: "Bearer " + ctx.key, "Content-Type": "application/json" };
    const send = () => ctx.fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
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

async function run(req, ctx) {
    // ctx.sleep is injectable so tools/ark_test.js waits in milliseconds
    ctx = { ...ctx, sleep: ctx.sleep || realSleep, log: ctx.log || (() => {}) };
    const model = String(req.model || "");
    if (!model) throw new Error("ModelArk recipe has no model id.");
    const o = req.options || {};
    const p = req.params || {};
    const where = hostFor(ctx, p.region, o.regions);
    checkKey(where.test, ctx.key);
    req = { ...req, references: req.kind === "text" ? [] : (req.references || []) };
    if (req.kind === "text" && !String(req.prompt || "").trim()) throw new Error(`ModelArk ${model}: a new image needs a prompt.`);
    if (req.kind !== "text" && !req.image) throw new Error(`ModelArk ${model}: no crop to edit.`);
    const pics = req.kind === "text" ? [] : await picturesFor(req, o, ctx, model);
    const body = bodyFor(req, o, pics);
    const r = await post(ctx, where.host + PATH, body);
    const at = { region: where.region, regions: o.regions };
    if (!r.ok) {
        const f = await readFailure(r, ctx.key);
        throw new Error(scrub(`ModelArk ${model}: ${explain(r.status, f.code, f.message, at)}${r.waitSeconds ? `; try again in ${r.waitSeconds} s` : ""}`, ctx.key));
    }
    const j = (await r.json()) || {};
    if (j.error) throw new Error(scrub(`ModelArk ${model}: ${explain(200, j.error.code, j.error.message || "error", at)}`, ctx.key));
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
        bytes, mime, seed: req.seed,
        info: { model: j.model || model, region: where.region, size: body.size, answered: item.size || null, pictures: pics.map((x) => `${x.what} ${x.mime === "image/jpeg" ? "jpeg" : "png"}`), generated_images: usage.generated_images != null ? usage.generated_images : null },
    };
}

module.exports = {
    label: "BytePlus ModelArk (Seedream)",
    keyUrl: "https://ai.byteplus.com/ark/region:ap-southeast-1/apiKey",
    keyHint: "API key from the ModelArk console (it belongs to the region it was made in)",
    edit: run,
    generate: run,   // kind "text": the same endpoint without image
    baseUrl,
    // exported for tools/ark_test.js
    _testBase: testBase,
    _hostFor: hostFor,
    _body: bodyFor,
    _size: sizeFor,
    _pictures: picturesFor,
    _explain: explain,
    REGIONS,
    MAX_PICTURE_BYTES,
};
