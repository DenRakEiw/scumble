// Oxen.ai (oxen.ai): one key for many image models (GPT Image, Nano Banana, Seedream, FLUX.2, Qwen Image, Grok Imagine,
// Krea, Ideogram, Z-Image, the Topaz upscalers) and chat models, through its inference API. Written from Oxen's docs
// (docs.oxen.ai/llms.txt and the pages it lists) and its model list (GET https://hub.oxen.ai/api/ai/models, which
// answers without a key; each model's `request_schema` is copied into tools/refs/oxen/) on 2026-09-26. Nothing here has
// run against the live API (no key; docs/RECIPES.md "Oxen.ai" lists what only a real key can verify).
//
//   POST /api/ai/images/edit      JSON { model, prompt, input_image | input_images, mask_url?, <model params>, response_format: "b64_json" }
//   POST /api/ai/images/generate  JSON { model, prompt, <model params>, response_format: "b64_json" }
//     -> { model, created, images: [{ b64_json } | { url }] }
//   errors: { error: { type, title, detail }, status: "error", status_message } | { error: { message } }
//
// One synchronous request per image. The pictures go inline as data URLs ("Data URIs work as an alternative but
// aren't recommended for production", docs.oxen.ai/inference-api/reference/image_editing.md); there is no upload route
// (it would need a public Oxen repository, whose history keeps every crop), no async queue (it stores every job's
// request, the crop included, and answers URLs only) and no balance route (the hub API has none). Oxen keeps every
// generated image in the user's account.
//
// A recipe variant describes the model with `options` (each key checked against tools/refs/oxen/ by tools/oxen_test.js):
//   accepts       the parameters the model's request_schema names; nothing else is sent
//   image_field   "input_image" (default) or "input_images" (Qwen)
//   single        the picture field is one string, not an array (Grok's edit, the Topaz upscalers): one picture only
//   mask          "white": the selection goes as mask_url, white = repaint (GPT Image 2); "alpha": an RGBA mask, alpha 0 =
//                 repaint (GPT Image 2.5). Without it a "fill" run sends the mask as a second picture and the prompt says
//                 what it means (Nano Banana), as the OpenRouter adapter does
//   edit_aspect   the aspect_ratio of an edit: "auto", "match_input_image", "closest" (the preset closest to the crop),
//                 "auto-single" ("auto" with one picture, else the closest preset); absent: none is sent
//   ratios        the aspect_ratio presets (a text run sends the asked one or the closest)
//   presets       { "W:H": value } and `preset_key`: a model whose size is a named preset (Ideogram's image_size)
//   tiers         { "1K": 1024, ... }, `tier_key` (default "resolution"), `tier_unit` "area" for FLUX's "1 MP" tiers: a
//                 Resolution row left on auto takes the smallest tier that covers the crop (or the asked size)
//   keep_auto     keys whose "auto" is a real value (Moderation); any other "auto" is not sent
//   numbers       keys sent as numbers (Bloom's creativity)
//   max_images    how many pictures the model takes (crop, mask picture and references); more are refused before sending
//   max_ratio     the steepest picture it takes; a steeper one is refused before sending
//   factor_key / factor_form   an upscaler's factor field and its form ("x": "4x", else the number)
//   prompt_max    an upscaler's longest prompt (Bloom: 1024 characters)
//   text          options that replace these for Generate new (Grok's text model takes other fields)
//
// The host is https://hub.oxen.ai, never a URL from a recipe; settings.oxen.base may name a loopback mock for the tests,
// and then only a key that starts with "test-" goes there, while such a key never goes to hub.oxen.ai.
"use strict";

const { fetchImage, sleep: realSleep, closestAspect } = require("./util");
const openrouter = require("./openrouter");

const DEFAULT_ORIGIN = "https://hub.oxen.ai";
const API = "/api/ai";
// The pictures of one request, as base64 in the JSON body, mask included. Oxen states no limit for images; its chat
// reference caps an inline audio part at 20 MB and a document at 24 MB, and Gemini (behind the Nano Banana models) an
// inline request at 20 MB. 18 MB stays under the tightest of them.
const MAX_INLINE = 18 * 1000 * 1000;
const JPEG_QUALITY = 92;
const RETRY_WAIT_MS = 5000;
const RETRY_WAIT_MAX_MS = 60000;   // a Retry-After longer than this is not waited for: the run fails and says when to try again
const DOWNLOAD_TRIES = 3;          // the run is paid for by then: a download that fails on the server's side is tried again
const SEED_MOD = 2147483648;       // Qwen documents 0 to 2147483647; the other schemas take any integer

// ---- host and key ----------------------------------------------------------------------------------------------

/** http://127.0.0.1:<port> (the test mock) or null: the only base a setting may name. */
function testBase(value) {
    if (!value) return null;
    let u;
    try { u = new URL(String(value).trim()); } catch (_) { return null; }
    if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) return null;
    if (u.protocol === "http:" && u.hostname === "127.0.0.1" && u.port) return `${u.protocol}//${u.host}`;
    return null;
}

/** settings.oxen.base when it is the loopback mock, else https://hub.oxen.ai: always an origin (llm.js uses it too). */
function baseUrl(settings) {
    const s = (settings && settings.oxen) || {};
    return testBase(s.base) || DEFAULT_ORIGIN;
}

function isLoopback(base) {
    return /^http:\/\/127\.0\.0\.1:\d+$/.test(String(base || ""));
}

/** A test key goes only to the loopback mock, a real key never there. Throws before any request. */
function checkKey(base, key) {
    const test = /^test-/.test(String(key || ""));
    if (isLoopback(base) && !test) throw new Error(`Oxen.ai: the host is set to the test address ${base} (settings.oxen.base), and only a test key goes there; clear the setting to use a real key.`);
    if (!isLoopback(base) && test) throw new Error("Oxen.ai: a test key is never sent to hub.oxen.ai; store a real key under Settings › API providers.");
}

function root(ctx) {
    return testBase(ctx && ctx.base) || DEFAULT_ORIGIN;
}

/** An error text with the key taken out, whatever the server echoed. */
function scrub(text, key) {
    let s = String(text == null ? "" : text);
    if (key && key.length >= 6) s = s.split(key).join("[key]");
    return s;
}

// ---- failures --------------------------------------------------------------------------------------------------

/** The server's message and its error type from a failed answer: Oxen's documented envelope, or { error: { message } }. */
async function readFailure(r) {
    let text = "";
    try { text = await r.text(); } catch (_) { text = ""; }
    let j = null;
    try { j = JSON.parse(text); } catch (_) { j = null; }
    const e = j && j.error;
    if (e && typeof e === "object") {
        const message = e.detail || e.title || e.message;
        const type = e.type || (j && j.status_message) || "";
        if (message) return { message: String(message), meta: { type: String(type || "") } };
        return { message: text.slice(0, 300) || r.statusText || String(r.status), meta: { type: String(type || "") } };
    }
    if (typeof e === "string") return { message: e, meta: { type: String((j && j.status_message) || "") } };
    return { message: text.slice(0, 300) || r.statusText || String(r.status), meta: {} };
}

const STATUS_WORDS = {
    400: "request refused (a setting or a picture)",
    401: "key refused",
    403: "refused (the content policy, or the key's permissions)",
    408: "timed out",
    413: "request too large (set Highres fix lower or use fewer reference layers)",
    429: "rate limited",
    500: "the service failed",
    502: "the model's host failed",
    503: "the service is busy",
    504: "timed out",
    524: "timed out",
};
const TYPE_STATUS = { unauthenticated: 401, invalid_params: 400, unknown_error: 500 };

/** What a failed answer means, in words, ahead of the server's own message. `upscale`: the size advice of an upscale. */
function explain(status, message, meta, upscale) {
    const m = meta || {};
    const text = String(message == null ? "" : message);
    let why;
    if (/Client Error|for url|could not (be )?(download|fetch|read)/i.test(text)) {
        why = "Oxen could not read the picture; Scumble sends it inline as a data URL, which Oxen's docs allow but which has not been verified (docs/RECIPES.md \"Oxen.ai\")";
    } else if (/insufficient credits|credit/i.test(text) || status === 402) {
        why = "not enough Oxen credits, top up at oxen.ai";
    } else if (/^Model not found/.test(text) || status === 404 || m.type === "resource_not_found") {
        why = "Oxen does not serve this model (any more)";
    } else {
        const s = STATUS_WORDS[status] ? status : TYPE_STATUS[m.type];
        why = STATUS_WORDS[s];
        if (s === 413 && upscale) why = "request too large (set a smaller selection, or upscale the selection instead of the whole picture)";
    }
    return why ? `${why} - ${text}` : text;
}

async function failure(r, key, upscale) {
    const f = await readFailure(r);
    return scrub(explain(r.status, f.message, f.meta, upscale), key);
}

/** The wait a Retry-After header asks for in ms (seconds or an HTTP date), else `fallback`. */
function retryAfterMs(r, fallback = RETRY_WAIT_MS) {
    const v = r.headers && r.headers.get && r.headers.get("retry-after");
    if (v == null || v === "") return fallback;
    const n = Number(v);
    if (Number.isFinite(n)) return Math.max(0, n * 1000);
    const at = Date.parse(v);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : fallback;
}

// ---- pictures --------------------------------------------------------------------------------------------------

/** [width, height] from a PNG's IHDR, or null for anything else. */
function pngSize(b) {
    if (!b || b.length < 24) return null;
    if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
    const v = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    return [v(16), v(20)];
}

const b64Length = (n) => 4 * Math.ceil(n / 3);
const dataUrl = (p) => `data:${p.mime};base64,${Buffer.from(p.bytes).toString("base64")}`;

/**
 * The pictures of an edit, fill or upscale run, in order: the crop, the mask (a fill without `o.mask` only), the
 * references; and the mask that goes as mask_url (a fill with `o.mask`). Checks the count and the steepest ratio, and
 * holds the inline size under MAX_INLINE by sending opaque pictures as JPEG, largest first; a mask is never
 * re-encoded. Throws before any request. Returns { pics: [{ what, bytes, mime, jpeg, url }], mask: data URL | null }.
 */
async function picturesFor(req, o, ctx, model) {
    const upscale = req.kind === "upscale";
    const pics = [{ what: "crop", bytes: Buffer.from(req.image), mime: "image/png", jpeg: true }];
    let mask = null;
    if (req.kind === "fill") {
        if (o.mask === "white" || o.mask === "alpha") {
            const m = o.mask === "white" ? req.mask : req.maskAlpha;
            if (!m || !m.length) throw new Error(`Oxen.ai ${model}: the run has no mask.`);
            mask = { what: "mask", bytes: Buffer.from(m), mime: "image/png", jpeg: false };
        } else if (req.mask && req.mask.length) {
            pics.push({ what: "mask", bytes: Buffer.from(req.mask), mime: "image/png", jpeg: false });
        } else {
            throw new Error(`Oxen.ai ${model}: the run has no mask.`);
        }
    }
    const refs = upscale ? [] : (req.references || []);
    refs.forEach((r, i) => pics.push({ what: `reference ${i + 1}`, bytes: Buffer.from(r), mime: "image/png", jpeg: true }));
    const max = o.single || upscale ? 1 : (+o.max_images > 0 ? +o.max_images : 16);
    if (pics.length > max) {
        const parts = ["the crop", ...(pics.some((p) => p.what === "mask") ? ["the mask"] : []), `${refs.length} reference${refs.length === 1 ? "" : "s"}`];
        throw new Error(`Oxen.ai ${model} takes at most ${max} picture${max === 1 ? "" : "s"}; this run has ${pics.length} (${parts.join(", ")}): turn Original off or hide reference layers.`);
    }
    if (+o.max_ratio > 0) {
        for (const p of pics) {
            const s = pngSize(p.bytes);
            if (s && Math.max(s[0], s[1]) > +o.max_ratio * Math.min(s[0], s[1]) + 1e-9) {
                throw new Error(`Oxen.ai ${model} takes pictures no steeper than ${o.max_ratio}:1; the ${p.what} is ${s[0]} × ${s[1]}. Use a less narrow selection or reference layer.`);
            }
        }
    }
    const all = mask ? [...pics, mask] : pics;
    let total = all.reduce((n, p) => n + b64Length(p.bytes.length), 0);
    if (total > MAX_INLINE) {
        for (const p of [...pics].filter((x) => x.jpeg).sort((a, b) => b.bytes.length - a.bytes.length)) {
            if (total <= MAX_INLINE) break;
            if (typeof ctx.opaque !== "function" || typeof ctx.toJpeg !== "function" || !(await ctx.opaque(p.bytes))) continue;
            const jpeg = await ctx.toJpeg(p.bytes, JPEG_QUALITY);
            if (!jpeg || !jpeg.length || jpeg.length >= p.bytes.length) continue;
            total += b64Length(jpeg.length) - b64Length(p.bytes.length);
            ctx.log && ctx.log(`${p.what} ${p.bytes.length} bytes as JPEG ${jpeg.length} bytes`);
            p.bytes = Buffer.from(jpeg);
            p.mime = "image/jpeg";
        }
        if (total > MAX_INLINE) {
            const advice = upscale ? "Set a smaller selection, or upscale the selection instead of the whole picture." : "Set Highres fix lower, turn Original off, or use fewer or smaller reference layers.";
            throw new Error(`Oxen.ai ${model}: the pictures come to ${(total / 1e6).toFixed(1)} MB, more than the ${MAX_INLINE / 1e6} MB this app sends in one request. ${advice}`);
        }
    }
    for (const p of pics) p.url = dataUrl(p);
    return { pics, mask: mask ? dataUrl(mask) : null };
}

// ---- the request -----------------------------------------------------------------------------------------------

/**
 * The smallest tier whose value covers the need, else the largest; null without tiers. The need is the long side, or
 * the area (w * h) for `unit` "area" (FLUX's "0.5 MP" / "1 MP" / "2 MP").
 */
function tierFor(w, h, tiers, unit) {
    const rows = Object.entries(tiers || {}).map(([k, v]) => [k, +v]).filter(([, v]) => v > 0).sort((a, b) => a[1] - b[1]);
    if (!rows.length) return null;
    const need = unit === "area" ? w * h : Math.max(w, h);
    for (const [k, v] of rows) if (v >= need) return k;
    return rows[rows.length - 1][0];
}

/**
 * The aspect of one run: for a text run the asked one when it is a preset, else the closest; for an edit, fill or
 * upscale run what `o.edit_aspect` says. `list` are the presets (without "auto"); `pictures` how many pictures go out.
 */
function aspectFor(req, o, list, pictures) {
    const ratios = (Array.isArray(list) ? list : []).filter((r) => r && r !== "auto");
    const w = Math.max(1, +req.width || 1024), h = Math.max(1, +req.height || 1024);
    const closest = () => (ratios.length ? closestAspect(w, h, ratios) : null);
    if (req.kind === "text") {
        if (!ratios.length) return null;
        if (req.aspect && ratios.includes(req.aspect)) return req.aspect;
        const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(req.aspect || ""));
        if (m && +m[1] > 0 && +m[2] > 0) return closestAspect(+m[1], +m[2], ratios);
        return closest();
    }
    switch (o.edit_aspect) {
        case "auto": return "auto";
        case "match_input_image": return "match_input_image";
        case "closest": return closest();
        case "auto-single": return pictures === 1 ? "auto" : closest();
        default: return null;
    }
}

/** The prompt of an edit or fill: the mask and reference sentences that ran live on OpenRouter. */
function promptFor(req, pics) {
    if (req.kind === "text") return String(req.prompt || "");
    return openrouter.promptFor(req, pics);
}

/** The JSON body of one request; `pics` and `mask` from picturesFor (none for a text run). */
function bodyFor(req, pics = [], mask = null) {
    let o = req.options || {};
    const text = req.kind === "text";
    const upscale = req.kind === "upscale";
    if (text && o.text && typeof o.text === "object") o = { ...o, ...o.text };
    const p = req.params || {};
    const accepts = new Set(Array.isArray(o.accepts) ? o.accepts : []);
    const keepAuto = new Set(Array.isArray(o.keep_auto) ? o.keep_auto : []);
    const numbers = new Set(Array.isArray(o.numbers) ? o.numbers : []);
    const body = { model: String(req.model || "") };
    if (!upscale) body.prompt = promptFor(req, pics);
    body.response_format = "b64_json";
    if (!text && pics.length) {
        const field = o.image_field || "input_image";
        body[field] = o.single || upscale ? pics[0].url : pics.map((x) => x.url);
    }
    if (mask && o.mask) body.mask_url = mask;
    for (const [k, v] of Object.entries(p)) {
        if (!accepts.has(k) || k === "random_seed" || v === "" || v == null) continue;
        if (String(v).toLowerCase() === "auto" && !keepAuto.has(k)) continue;
        body[k] = numbers.has(k) ? Number(v) : v;
    }
    const w = Math.max(1, +req.width || 1024), h = Math.max(1, +req.height || 1024);
    const tierKey = o.tier_key || "resolution";
    if (accepts.has(tierKey) && body[tierKey] == null) {
        const tier = tierFor(w, h, o.tiers, o.tier_unit);
        if (tier) body[tierKey] = tier;
    }
    if (text && o.presets && o.preset_key && accepts.has(o.preset_key) && body[o.preset_key] == null) {
        const keys = Object.keys(o.presets);
        const want = aspectFor(req, o, keys, 0);
        if (want && Object.prototype.hasOwnProperty.call(o.presets, want)) body[o.preset_key] = o.presets[want];
    }
    if (accepts.has("aspect_ratio") && body.aspect_ratio == null) {
        const a = aspectFor(req, o, o.ratios, pics.length);
        if (a) body.aspect_ratio = a;
    }
    if (accepts.has("seed") && req.seed != null && req.seed !== "" && !p.random_seed && Number.isFinite(Number(req.seed))) body.seed = (Number(req.seed) >>> 0) % SEED_MOD;
    if (accepts.has("negative_prompt") && String(req.negative || "").trim()) body.negative_prompt = String(req.negative);
    if (upscale) {
        if (o.factor_key && req.factor != null) body[o.factor_key] = o.factor_form === "x" ? `${req.factor}x` : Number(req.factor);
        const prompt = String(req.prompt || "");
        if (accepts.has("prompt") && prompt.trim()) {
            const max = +o.prompt_max > 0 ? +o.prompt_max : 0;
            if (max && prompt.length > max) {
                body.prompt = prompt.slice(0, max);
                req.log && req.log(`the prompt is ${prompt.length} characters, cut to the model's ${max}`);
            } else {
                body.prompt = prompt;
            }
        }
    }
    return body;
}

// ---- HTTP ------------------------------------------------------------------------------------------------------

/** One POST to the API, retried once on a 429 or 503 (never before Retry-After); a network error is not retried. */
async function post(ctx, path, body, model) {
    const headers = { Authorization: "Bearer " + ctx.key, "Content-Type": "application/json" };
    const payload = JSON.stringify(body);
    const send = async () => {
        try {
            return await ctx.fetch(root(ctx) + API + path, { method: "POST", headers, body: payload });
        } catch (err) {
            const cause = err && err.cause;
            if (cause && cause.code === "UND_ERR_HEADERS_TIMEOUT") throw new Error(`Oxen.ai ${model}: no answer within 5 minutes; the run may still be billed and saved in your Oxen account.`);
            throw new Error(`Oxen.ai ${model}: hub.oxen.ai could not be reached - ${scrub(err && err.message || err, ctx.key)}`);
        }
    };
    let r = await send();
    // a 429 or 503 made nothing, so one retry is safe; a 502 or any other 5xx may be a paid image already
    if (r.status === 429 || r.status === 503) {
        const ms = retryAfterMs(r);
        if (ms > RETRY_WAIT_MAX_MS) {
            r.waitSeconds = Math.ceil(ms / 1000);
            return r;
        }
        ctx.log(`answered ${r.status}, sending once more after ${ms} ms`);
        await ctx.sleep(ms);
        r = await send();
        if (!r.ok) {
            const again = retryAfterMs(r, 0);
            if (again > 0) r.waitSeconds = Math.ceil(again / 1000);
        }
    }
    return r;
}

/** The MIME type of image bytes by their magic number; PNG when unknown. */
function sniff(b) {
    if (b && b.length >= 12) {
        if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
        if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
        if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
    }
    return "image/png";
}

/**
 * A result URL's bytes: a data URL, https on any host, or the mock's own address. First without the key; on a 401 or
 * 403 from the API's own origin once more with it (the key then goes only where it already went). A network error or
 * a 5xx is tried again, up to three times: the run is paid for.
 */
async function download(url, ctx, model) {
    const u = String(url || "");
    if (/^data:/i.test(u)) return await fetchImage(u, ctx.fetch);
    let parsed;
    try { parsed = new URL(u); } catch (_) { throw new Error(`Oxen.ai ${model}: the answer names no usable picture URL.`); }
    const origin = `${parsed.protocol}//${parsed.host}`;
    const api = root(ctx);
    const mock = testBase(ctx.base);
    if (parsed.protocol !== "https:" && !(mock && origin === mock)) throw new Error(`Oxen.ai ${model}: the answer's picture URL is not https (${scrub(u.slice(0, 80), ctx.key)}).`);
    let withKey = false;
    let last = null;
    for (let attempt = 1; attempt <= DOWNLOAD_TRIES; attempt++) {
        let r;
        try {
            r = await ctx.fetch(u, { headers: withKey ? { Authorization: "Bearer " + ctx.key } : {} });
        } catch (err) {
            last = `could not be reached (${scrub(err && err.message || err, ctx.key)})`;
            if (attempt < DOWNLOAD_TRIES) { await ctx.sleep(2000 * attempt); continue; }
            break;
        }
        if (r.ok) {
            const bytes = Buffer.from(await r.arrayBuffer());
            return { bytes, mime: sniff(bytes) };
        }
        if ((r.status === 401 || r.status === 403) && !withKey && origin === api) {
            withKey = true;
            attempt--;   // the one try with the key is not a retry
            continue;
        }
        last = `answered ${r.status}`;
        if (r.status >= 500 && attempt < DOWNLOAD_TRIES) { await ctx.sleep(2000 * attempt); continue; }
        break;
    }
    throw new Error(`Oxen.ai ${model}: the finished image could not be downloaded (${last}); it is saved in your Oxen account.`);
}

/** The picture of a successful answer. A 200 that carries an error is an error. */
async function readAnswer(j, ctx, model) {
    if (j && j.error) {
        const e = j.error;
        const msg = typeof e === "string" ? e : (e.detail || e.title || e.message || JSON.stringify(e));
        throw new Error(`Oxen.ai ${model}: ${scrub(explain(0, msg, { type: e.type || j.status_message }), ctx.key)}`);
    }
    const images = Array.isArray(j && j.images) ? j.images : [];
    const b64 = images.find((x) => x && typeof x.b64_json === "string" && x.b64_json);
    if (b64) {
        const bytes = Buffer.from(b64.b64_json, "base64");
        return { bytes, mime: sniff(bytes), answer: "b64_json" };
    }
    const byUrl = images.find((x) => x && typeof x.url === "string" && x.url);
    if (byUrl) {
        const got = await download(byUrl.url, ctx, model);
        return { bytes: got.bytes, mime: sniff(got.bytes), answer: "url" };
    }
    throw new Error(`Oxen.ai ${model}: no image in the answer (${scrub(JSON.stringify(j).slice(0, 200), ctx.key)})`);
}

// ---- the run ---------------------------------------------------------------------------------------------------

async function run(req, ctx) {
    // ctx.sleep is injectable so tools/oxen_test.js waits in milliseconds
    ctx = { ...ctx, sleep: ctx.sleep || realSleep, log: ctx.log || (() => {}) };
    const model = String(req.model || "");
    if (!model) throw new Error("Oxen.ai recipe has no model id.");
    const text = req.kind === "text";
    const upscale = req.kind === "upscale";
    if (text && !String(req.prompt || "").trim()) throw new Error(`Oxen.ai ${model}: a new image needs a prompt.`);
    if (!text && !req.image) throw new Error(`Oxen.ai ${model}: no ${upscale ? "picture to upscale" : "crop to edit"}.`);
    const base = root(ctx);
    checkKey(base, ctx.key);
    let o = req.options || {};
    if (text && o.text && typeof o.text === "object") o = { ...o, ...o.text };
    req = { ...req, references: text || upscale ? [] : (req.references || []), log: ctx.log };
    const { pics, mask } = text ? { pics: [], mask: null } : await picturesFor(req, o, ctx, model);
    const body = bodyFor(req, pics, mask);
    const route = text ? "generate" : "edit";
    const r = await post(ctx, "/images/" + route, body, model);
    if (!r.ok) throw new Error(`Oxen.ai ${model}: ${await failure(r, ctx.key, upscale)}${r.waitSeconds ? `; try again in ${r.waitSeconds} s` : ""}`);
    let j;
    try { j = (await r.json()) || {}; } catch (_) { throw new Error(`Oxen.ai ${model}: the answer is not JSON.`); }
    const got = await readAnswer(j, ctx, model);
    const oo = text && (req.options || {}).text ? { ...(req.options || {}), ...req.options.text } : (req.options || {});
    const tierKey = oo.tier_key || "resolution";
    return {
        bytes: got.bytes,
        mime: got.mime,
        seed: body.seed != null ? body.seed : req.seed,
        info: {
            model, route,
            pictures: pics.map((x) => `${x.what} ${x.mime === "image/jpeg" ? "jpeg" : "png"}`),
            mask: mask ? "mask_url" : pics.some((x) => x.what === "mask") ? "picture" : null,
            aspect_ratio: body.aspect_ratio || (oo.preset_key && body[oo.preset_key]) || null,
            tier: body[tierKey] != null ? body[tierKey] : null,
            factor: oo.factor_key && body[oo.factor_key] != null ? body[oo.factor_key] : null,
            answer: got.answer,
        },
    };
}

/** An upscale: the same route as an edit (/images/edit), one picture, the factor in the model's own field. */
async function upscale(req, ctx) {
    return await run({ ...req, kind: "upscale", references: [] }, ctx);
}

module.exports = {
    label: "Oxen.ai",
    keyUrl: "https://oxen.ai/settings/profile",   // docs.oxen.ai/inference-api/overview.md, "Authentication"
    keyHint: "API key from oxen.ai › Settings › Profile (every call costs Oxen credits)",
    edit: run,
    generate: run,   // kind "text": /images/generate, no picture field
    upscale,

    baseUrl,
    checkKey,
    // llm.js: a failed chat request on the Oxen key is read and put in the same words
    explain,
    readFailure,
    // exported for tools/oxen_test.js
    _testBase: testBase,
    _body: bodyFor,
    _pictures: picturesFor,
    _tier: tierFor,
    _aspect: aspectFor,
    _failure: failure,
    _download: download,
    _readAnswer: readAnswer,
    DEFAULT_ORIGIN,
    API,
    MAX_INLINE,
};
