// Comfy Router (api.comfy.org): Comfy's direct model API. One Comfy key (the same `comfyui-...` key from
// platform.comfy.org as Comfy Cloud, so the adapter has no key row of its own: `keyName` below), billed in Comfy
// credits, and unlike Comfy Cloud no paid plan. Written from docs.comfy.org/development/comfy-router (quickstart,
// queue, providers, the API reference) and the per-model OpenAPI documents under docs.comfy.org/router-schemas/,
// read on 2026-09-23; nothing here has run against the live API yet (docs/RECIPES.md "Comfy Router").
//
//   POST /v2/models/{provider}/{model}/requests          the model's own native JSON body -> 201 { request_id,
//                                                        status: IN_QUEUE, queue_position, status_url, ... }
//   GET  /v2/models/{provider}/{model}/requests/{id}/status   -> 200 { status: IN_QUEUE | IN_PROGRESS | COMPLETED,
//                                                        error_type (a COMPLETED run that failed) }, Retry-After
//   GET  /v2/models/{provider}/{model}/requests/{id}     -> 200 the model's native output, 202 not finished yet,
//                                                        or an error { detail, error_type, upstream_detail }
//   PUT  /v2/models/{provider}/{model}/requests/{id}/cancel   when Scumble gives up waiting
//   POST /v2/models/{provider}/{model}                   the same body, answered when done (the fallback for a key
//                                                        the queue refuses with not_enabled: a key without a workspace)
//
// Headers: X-API-Key, Content-Type and an Idempotency-Key (one UUID per run, the same on every resend of that run,
// so a submit that is sent again after a lost answer or a 409 / 429 / 503 returns the first request instead of
// queueing and billing a second one). The body is the partner's own schema, so the adapter speaks one dialect per
// model family, chosen by the provider part of the model id (DIALECTS below):
//
//   openai/*     OpenAI images: prompt, image [data URLs], mask (RGBA PNG, transparent = repaint), size, quality ...
//                -> data[0].b64_json
//   vertexai/*   Gemini generateContent: contents[].parts (text, then a label part and inlineData per picture),
//                generationConfig.imageConfig -> candidates[0].content.parts[].inlineData
//   bfl/*        FLUX.2: prompt, input_image .. input_image_9 (base64), width, height; FLUX.1 Fill: image, mask
//                (base64, white = repaint) -> result.sample (a URL on Comfy storage). FLUX 3 Image (bfl/flux-3-image):
//                BFL's own body (flux3.js: prompt, images [base64], aspect_ratio, resolution, safety_tolerance,
//                grounding; no seed), the box rows in the prompt as on BFL's API -> result.sample, result.prompt
//   byteplus/*   Seedream: prompt, image [data URLs], size "WxH", watermark false, response_format b64_json
//                -> data[0].b64_json
//   qwen/*       Qwen Image 3.0: input.messages[0].content [{ image }, .., { text }], parameters { size "W*H" ..}
//                -> output.choices[0].message.content[].image (a URL)
//   freepik/*    Magnific Precision V2 (upscale): image (base64), scale_factor 2..16 -> data.generated[0] (a URL)
//   ideogram/ideogram-4-5   Ideogram 4.5: an edit is Precise Edit (image, reference_images, mask black = edit, all
//                data URLs; `image` selects the operation), a new image the prompt with a 1K / 2K size -> data[0].url
//   xai/*, ideogram/ideogram-v4, krea/*   text to image only (the Router's schemas for them take no input picture)
//
// A variant's `options` say what the model takes: max_images, max_bytes (per picture), pixels [min, max] (Seedream),
// ratios (the aspect presets of the text-only models), tiers ({ "1K": 1024, .. }, Gemini's and Grok's size classes).
// layout(req) declares where each picture goes (docs/PLAN_REFS.md C3); the instruction an edit goes out with is
// refs.instruction, numbered by that layout, so it names the pictures as the resolved markers do. A route whose layout
// declares a drop (FLUX.1 Fill) sends the crop alone. textLayout(req) does the same for Generate new with reference
// layers (26f): the same fields without the crop, the references numbered from 1, the edit cap as the reference cap
// (the crop's slot becomes a reference slot); xai, ideogram and krea take no picture for a new image and declare the
// drop (Ideogram 4.5 would edit a picture it is given, so its new image is the prompt alone too).
//
// The host is api.comfy.org and never a URL from a recipe; settings.comfyrouter.base may name a loopback mock for
// the tests, and then only a key that starts with "test-" goes there, while such a key never goes to Comfy. Answer
// URLs are fetched without the key (Comfy's own are signed; a partner's need none).
"use strict";

const { randomUUID } = require("node:crypto");
const { dataUri, b64, fetchImage, sleep: realSleep, fitPixels, closestAspect, closestSize, tierFor, seedOf, textShape, ideogramMask } = require("./util");
const { layoutOf, refRoles, countOf, instruction, labelParts } = require("./refs");
const openai = require("./openai");
const ark = require("./ark");
const flux3 = require("./flux3");

/** The FLUX 3 Image model part on the Router (bfl/flux-3-image): flux3.js builds its body and reads its shape. */
const FLUX3_MODEL = "flux-3-image";

const BASE = "https://api.comfy.org";
const EDIT_WAIT_MS = 15 * 60 * 1000;
const UPSCALE_WAIT_MS = 30 * 60 * 1000;
const POLL_MS = 2000;            // when the server names no Retry-After
const POLL_MIN_MS = 1000;
const POLL_MAX_MS = 15000;       // a Retry-After is a hint; a longer one is capped so a finished run is seen soon
const RESEND_MAX = 3;            // submits of one run in all (the same Idempotency-Key each time)
const RESEND_WAIT_MAX_MS = 60000;
const POLL_FAILURES_MAX = 5;     // status reads in a row that may fail (a 5xx, a dropped connection) before giving up
const REQUEST_BYTES_MAX = 100 * 1024 * 1024;   // the whole JSON body ("capped at 100 MiB")
const PICTURES_BYTES_MAX = 64 * 1024 * 1024;   // one request's images together (the media resolver's cap)
const PICTURE_BYTES_MAX = 25 * 1024 * 1024;    // one image (the media resolver's cap)
const MASK_BYTES_MAX = 4 * 1024 * 1024;        // OpenAI's mask ("under 4 MiB", enforced by the Router)
const JPEG_QUALITY = 92;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL_ID = /^([a-z0-9][a-z0-9_-]{0,63})\/([a-z0-9][a-z0-9._-]{0,127})$/;
// Gemini's aspectRatio values (as gemini.js): a text run with references and a free size gets the closest, since
// without one the answer takes the shape of a reference picture
const GEMINI_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

// ---- host and key --------------------------------------------------------------------------------------------

/** http://127.0.0.1:<port> (the test mock) or null: the only base a setting may name. */
function testBase(value) {
    if (!value) return null;
    let u;
    try { u = new URL(String(value).trim()); } catch (_) { return null; }
    if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) return null;
    if (u.protocol === "http:" && u.hostname === "127.0.0.1" && u.port) return `${u.protocol}//${u.host}`;
    return null;
}

/** settings.comfyrouter.base when it is the loopback mock, else null (api.comfy.org). */
function baseUrl(settings) {
    const s = (settings && settings.comfyrouter) || {};
    return testBase(s.base);
}

/** A test key goes only to the mock, a real key never there. Throws before any request. */
function checkKey(test, key) {
    const isTest = /^test-/.test(String(key || ""));
    if (test && !isTest) throw new Error("Comfy Router: the host is set to a test address (settings.comfyrouter.base), and only a test key goes there; clear the setting to use a real key.");
    if (!test && isTest) throw new Error("Comfy Router: a test key is never sent to Comfy; store a real key in the Comfy Cloud row under Settings › API providers.");
}

function scrub(text, key) {
    let s = String(text == null ? "" : text);
    if (key && key.length >= 6) s = s.split(key).join("[key]");
    return s;
}

/** ["openai", "gpt-image-2"] for "openai/gpt-image-2"; throws on anything that is not a Router model id. */
function splitModel(id) {
    const m = MODEL_ID.exec(String(id || ""));
    if (!m) throw new Error(`Comfy Router: "${id}" is not a model id of the form provider/model.`);
    return [m[1], m[2]];
}

// ---- errors --------------------------------------------------------------------------------------------------

// The error buckets of the API reference, in words. An unknown bucket is read as internal_error (the reference says
// the set will grow and a client must not break on a new one), with its own name kept in the message.
const WORDS = {
    invalid_input: "request refused",
    content_policy_violation: "refused by the provider's content filter (whether a refusal is billed depends on the model)",
    provider_error: "the model's provider failed",
    provider_timeout: "the model's provider did not answer in time",
    insufficient_credits: "the Comfy account has no credits left: add credits at platform.comfy.org",
    model_not_found: "Comfy Router does not serve this model (any more)",
    unauthorized: "key refused: store a key from platform.comfy.org › API keys in the Comfy Cloud row",
    forbidden: "this key may not run this model",
    concurrency_limit_exceeded: "too many runs of this account are in flight",
    client_disconnected: "the connection was closed before the answer came",
    internal_error: "Comfy Router failed",
    deadline_exceeded: "Comfy Router stopped waiting for the model",
    not_enabled: "Comfy Router is not switched on for this key: make a key in a workspace at platform.comfy.org › API keys",
    service_unavailable: "Comfy Router is temporarily unavailable",
    rate_limited: "rate limited",
    cancelled: "the run was cancelled",
    queue_timeout: "the run waited too long in Comfy's queue and was never started",
    request_not_found: "Comfy Router no longer knows this run",
};

/** { type, detail, upstream, fields } of a failed answer; the key taken out before any cut. */
async function readFailure(r, key) {
    let text = "";
    try { text = await r.text(); } catch (_) { text = ""; }
    text = scrub(text, key);
    const header = (r.headers && r.headers.get && r.headers.get("x-comfy-error-type")) || "";
    const out = { type: header, detail: "", upstream: "", fields: [] };
    try {
        const j = JSON.parse(text);
        if (j && typeof j === "object") {
            if (!out.type && typeof j.error_type === "string") out.type = j.error_type;
            if (Array.isArray(j.detail)) {
                // a 422: one entry per field ({ loc, msg, type, ctx, input })
                out.fields = j.detail.filter((d) => d && typeof d === "object").map((d) => {
                    const loc = Array.isArray(d.loc) ? d.loc.filter((x) => x !== "body").join(".") : "";
                    return `${loc ? loc + ": " : ""}${String(d.msg || d.type || "invalid")}`;
                });
            } else if (typeof j.detail === "string") out.detail = j.detail;
            else if (typeof j.message === "string") out.detail = j.message;
            if (typeof j.upstream_detail === "string") out.upstream = j.upstream_detail;
        }
    } catch (_) { out.detail = text.slice(0, 300); }
    if (!out.detail && !out.fields.length) out.detail = r.statusText || String(r.status);
    return out;
}

/** What a failed answer means: the bucket's words, then the server's own, the fields of a 422, the partner's reason. */
function explain(status, f) {
    const type = String(f.type || "");
    let why = Object.prototype.hasOwnProperty.call(WORDS, type) ? WORDS[type] : null;
    if (!why && type) why = `${WORDS.internal_error} (${type})`;
    if (!why) {
        if (status === 401) why = WORDS.unauthorized;
        else if (status === 402) why = WORDS.insufficient_credits;
        else if (status === 404) why = "not found";
        else if (status === 413) why = "the request is too large (100 MiB at most, pictures included)";
        else if (status === 422) why = "the model refused the input";
        else if (status === 429) why = WORDS.rate_limited;
        else if (status >= 500) why = WORDS.internal_error;
    }
    const parts = [];
    if (f.fields && f.fields.length) parts.push(f.fields.slice(0, 5).join("; "));
    else if (f.detail) parts.push(f.detail);
    if (f.upstream) parts.push(`the provider said: ${f.upstream}`);
    const words = parts.join(" - ").slice(0, 600);
    return why ? `${why}${words ? " - " + words : ""}` : words;
}

function retryAfterMs(r, fallback) {
    const v = r.headers && r.headers.get && r.headers.get("retry-after");
    if (v == null || v === "") return fallback;
    const n = Number(v);
    if (Number.isFinite(n)) return Math.max(0, n * 1000);
    const at = Date.parse(v);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : fallback;
}

// ---- pictures ------------------------------------------------------------------------------------------------

/** [width, height] from a PNG's IHDR, or null for anything else. */
function pngSize(b) {
    if (!b || b.length < 24) return null;
    if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
    const v = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    return [v(16), v(20)];
}

/**
 * The pictures of an edit, crop first, then the references; of a text run (Generate new) the references alone (none
 * without reference layers). Checks the count, the steepest shape and the bytes a model takes; a picture over its byte
 * limit goes as JPEG when it has no transparent pixel. Throws before any request.
 */
async function picturesFor(req, o, ctx, model) {
    const text = req.kind === "text";
    if (!text && !req.image) return [];
    const who = ctx.who || `Comfy Router ${model}`;
    const pics = text ? [] : [{ what: "crop", bytes: Buffer.from(req.image), mime: "image/png" }];
    (req.references || []).forEach((r, i) => pics.push({ what: `reference ${i + 1}`, bytes: Buffer.from(r), mime: "image/png" }));
    if (!pics.length) return pics;
    const max = +o.max_images > 0 ? +o.max_images : 1;
    if (pics.length > max && text) throw new Error(`${who} takes at most ${max} reference picture${max === 1 ? "" : "s"} for a new image; this run has ${pics.length}: hide reference layers.`);
    if (pics.length > max) {
        const refs = pics.length - 1;
        throw new Error(`${who} takes at most ${max} picture${max === 1 ? "" : "s"}; this run has ${pics.length} (the crop, ${refs} reference${refs === 1 ? "" : "s"}): turn Original off or hide reference layers.`);
    }
    const limit = pictureLimit(o);
    // a model's own limit in whole decimal MB (Ideogram's and Seedream's 25,000,000) is named in those, the Router's 25 MiB in MiB
    const unit = Number.isInteger(limit / 1e6) ? 1e6 : 1024 * 1024;
    for (const p of pics) {
        const s = pngSize(p.bytes);
        if (s && +o.max_ratio > 0) {
            const [w, h] = s;
            if (Math.max(w, h) > +o.max_ratio * Math.min(w, h)) throw new Error(`${who} takes pictures no steeper than ${o.max_ratio}:1; the ${p.what} is ${w} × ${h}. Use a less narrow selection or reference layer.`);
        }
        if (p.bytes.length > limit) {
            const opaque = typeof ctx.opaque === "function" && (await ctx.opaque(p.bytes));
            const jpeg = opaque && typeof ctx.toJpeg === "function" ? await ctx.toJpeg(p.bytes, JPEG_QUALITY) : null;
            const mb = (limit / unit).toFixed(0);
            if (!jpeg || !jpeg.length || jpeg.length > limit) {
                throw new Error(`${who}: the ${p.what} is ${(p.bytes.length / unit).toFixed(1)} MB, more than the ${mb} MB a picture may have${opaque ? " even as JPEG" : " (it has transparency, so it stays PNG)"}. ${text ? "Use a smaller reference layer." : "Set Highres fix lower or use a smaller reference layer."}`);
            }
            ctx.log(`${p.what} ${p.bytes.length} bytes as JPEG ${jpeg.length} bytes`);
            p.bytes = Buffer.from(jpeg);
            p.mime = "image/jpeg";
        }
    }
    const total = pics.reduce((n, p) => n + p.bytes.length, 0);
    if (total > PICTURES_BYTES_MAX) throw new Error(`${who}: the pictures are ${(total / 1024 / 1024).toFixed(1)} MB together, more than the 64 MB one request may carry. ${text ? "Hide reference layers or use smaller ones." : "Set Highres fix lower or hide reference layers."}`);
    return pics;
}

/** One picture's byte limit: the variant's `options.max_bytes`, never above the Router's 25 MiB. */
function pictureLimit(o) {
    return Math.min(+o.max_bytes > 0 ? +o.max_bytes : PICTURE_BYTES_MAX, PICTURE_BYTES_MAX);
}

/** picturesFor's count check as a layout's `max`: the crop and the references together (a text run: the references). */
const picturesMax = (o) => (+o.max_images > 0 ? +o.max_images : 1);

/**
 * picturesFor's order as a layout's numbered pictures, picture k (0-based) in `field(k)`: the crop, then the
 * references; a text run's references from field(0) on.
 */
const inOrder = (req, field) => (req.kind === "text"
    ? refRoles(req).map(([role, i]) => [role, field(i), i])
    : [["crop", field(0)], ...refRoles(req).map(([role, i]) => [role, field(i + 1), i])]);

const uri = (p) => dataUri(p.bytes, p.mime);

/**
 * The instruction an edit goes out with, numbered by the dialect's layout (refs.instruction); a text run's prompt and
 * what its references are ("Images 1 and 2 are reference images."), the prompt as it is without any.
 */
const editPrompt = (req, lay) => instruction(req, lay, String(req.prompt || ""));

const setting = (p, k) => (p[k] != null && p[k] !== "" && p[k] !== "auto" ? p[k] : null);

/** Whether dialect `d` edits a picture with `model`: its `edit` is false (no model does) or a function of the model part. */
const editable = (d, model) => (typeof d.edit === "function" ? !!d.edit(model) : d.edit !== false);

const NO_TEXT_REFS = "this model takes no reference images for a new image";

// Ideogram 4.5: the one Ideogram id with an edit (the Router's body picks the operation: `image` selects Precise Edit)
const IDEOGRAM_45 = "ideogram-4-5";
const IDEOGRAM_SEED_MAX = 2147483647;
const IDEOGRAM_1K = 1024 * 1024;   // "up to 1024x1024 bills as 1K, above that as 2K" (Ideogram's 4.5 generate page)

/**
 * Ideogram 4.5's Precise Edit body: the crop as `image` (its presence selects the operation), the references as
 * `reference_images` (only when there are any), the selection as `mask` inverted to Ideogram's black = edit (none for
 * a selection over the whole crop: Ideogram refuses a mask without both colours, so the whole crop is edited and the
 * stitch keeps the selection), the quality, the seed under Ideogram's cap, one picture. No `size` or `magic_prompt`:
 * the Router drops both for Precise Edit, and the answer has the crop's size. picturesFor held the crop and the
 * references to the count, the 6:1 shape and the bytes; the mask is held here, before anything is sent.
 */
function ideogram45Edit(req, o, pics, model, ctx) {
    const who = ctx.who || `Comfy Router ideogram/${model}`;
    if (!pics.length) throw new Error(`${who}: no picture to edit.`);
    const p = req.params || {};
    const body = { prompt: String(req.prompt || ""), image: uri(pics[0]) };
    if (pics.length > 1) body.reference_images = pics.slice(1).map(uri);
    const mask = req.mask && req.mask.length ? ideogramMask(req.mask, req.image, ctx, who) : null;
    if (mask) {
        const total = pics.reduce((n, x) => n + x.bytes.length, 0) + mask.length;
        const limit = pictureLimit(o), unit = Number.isInteger(limit / 1e6) ? 1e6 : 1024 * 1024;
        if (mask.length > limit) throw new Error(`${who}: the mask is ${(mask.length / unit).toFixed(1)} MB, more than the ${(limit / unit).toFixed(0)} MB a picture may have. Set Highres fix lower.`);
        if (total > PICTURES_BYTES_MAX) throw new Error(`${who}: the pictures and the mask are ${(total / 1024 / 1024).toFixed(1)} MB together, more than the 64 MB one request may carry. Set Highres fix lower or hide reference layers.`);
        body.mask = dataUri(mask, "image/png");
    }
    if (setting(p, "quality")) body.quality = p.quality;
    const seed = seedOf(req, +o.seed_max > 0 ? +o.seed_max : IDEOGRAM_SEED_MAX);
    if (seed !== undefined) body.seed = seed;
    body.num_images = 1;
    return body;
}

/**
 * Ideogram 4.5's new image: the prompt alone with an exact size, the preset of `options.resolutions` closest to the
 * asked shape within the tier the asked size bills as (1K up to 1024 x 1024 pixels, else 2K; "Without source images,
 * an exact size must be one of the supported 1K/2K presets"), no size (the Router's auto) without a list. The edit's
 * Settings rows reach a text run (host.providerParams), so `options.text_values` swaps a value the text operation
 * refuses (very_low); `magic_prompt` goes when set (the recipe's text.fixed sends off, so the prompt goes as written).
 */
function ideogram45Text(req, o) {
    const p = { ...(req.params || {}) };
    for (const [k, swap] of Object.entries(o.text_values || {})) {
        if (swap && typeof swap === "object" && p[k] != null && Object.prototype.hasOwnProperty.call(swap, String(p[k]))) p[k] = swap[String(p[k])];
    }
    const body = { prompt: String(req.prompt || "") };
    const all = (Array.isArray(o.resolutions) ? o.resolutions : []).filter((s) => /^\d+x\d+$/.test(String(s)));
    if (all.length) {
        const area = (s) => { const [w, h] = String(s).split("x").map(Number); return w * h; };
        const asked = (+req.width || 0) * (+req.height || 0);
        const small = asked > 0 && asked <= IDEOGRAM_1K;
        const tier = all.filter((s) => (area(s) <= IDEOGRAM_1K) === small);
        const [w, h] = textShape(req);
        body.size = closestSize(w, h, tier.length ? tier : all);
    }
    if (setting(p, "quality")) body.quality = p.quality;
    if (setting(p, "magic_prompt")) body.magic_prompt = p.magic_prompt;
    const seed = seedOf(req, +o.seed_max > 0 ? +o.seed_max : IDEOGRAM_SEED_MAX);
    if (seed !== undefined) body.seed = seed;
    body.num_images = 1;
    return body;
}

// ---- dialects ------------------------------------------------------------------------------------------------
// Each: body(req, o, pics, model, ctx) -> JSON body; read(json, req, o, ctx, body) -> { bytes, mime, seed?, info? } or
// { url } (fetched by the caller); layout(req, o, model) -> where body() puts each picture of an edit, and of a text
// run with references (req.kind "text": no crop, the references from the first picture field on). `text: false`
// where the Router's schema takes no prompt-only run, `edit: false` where it takes no input picture (a function of the
// model part where only some of the family's models do), `upscale: true` for an upscaler.

const DIALECTS = {
    openai: {
        body(req, o, pics, model) {
            const p = req.params || {};
            const extra = openai._common(p, model);
            const size = setting(p, "size") || openai._sizeFor(model, req.width, req.height);
            const body = { prompt: String(req.prompt || ""), n: 1, size, ...extra };
            if (pics.length) {
                body.image = pics.map(uri);
                const mask = req.kind === "fill" ? req.maskAlpha : null;
                if (mask && mask.length) {
                    if (mask.length > MASK_BYTES_MAX) throw new Error(`Comfy Router openai/${model}: the mask is ${(mask.length / 1024 / 1024).toFixed(1)} MB, more than the 4 MB OpenAI takes. Set Highres fix lower.`);
                    body.mask = dataUri(mask, "image/png");
                }
            }
            return body;
        },
        layout(req, o) {
            const mask = req.kind === "fill" && req.maskAlpha && req.maskAlpha.length;
            return layoutOf({ seq: inOrder(req, (k) => `image[${k}]`), own: mask ? [["mask", "mask"]] : [], max: picturesMax(o) });
        },
        read(j, req, o, ctx, body) {
            const item = Array.isArray(j.data) ? j.data.find((d) => d && (d.b64_json || d.url)) : null;
            if (!item) return null;
            const info = { size: j.size || body.size, quality: j.quality || null, background: j.background || null, revised_prompt: item.revised_prompt || null };
            if (item.b64_json) {
                const fmt = j.output_format || body.output_format || "png";
                return { bytes: Buffer.from(item.b64_json, "base64"), mime: fmt === "jpeg" ? "image/jpeg" : fmt === "webp" ? "image/webp" : "image/png", info };
            }
            return { url: item.url, info };
        },
    },

    vertexai: {
        body(req, o, pics, model) {
            const p = req.params || {};
            const parts = [];
            if (pics.length) {
                const text = req.kind === "text";
                const lay = DIALECTS.vertexai.layout(req, o);
                // index.js refuses a run past the cap before this; picturesFor counts no mask, so the mask picture is counted here
                const max = +lay.max > 0 ? +lay.max : null, count = countOf(lay);
                if (max != null && count > max && text) throw new Error(`Comfy Router vertexai/${model} takes at most ${max} reference picture${max === 1 ? "" : "s"} for a new image; this run has ${count}: hide reference layers.`);
                if (max != null && count > max) {
                    const refs = pics.length - 1, mask = lay.pictures.some((pic) => pic.role === "mask");
                    throw new Error(`Comfy Router vertexai/${model} takes at most ${max} picture${max === 1 ? "" : "s"}; this run has ${count} (the crop${mask ? ", the mask" : ""}${refs ? `, ${refs} reference${refs === 1 ? "" : "s"}` : ""}): turn Original off or hide reference layers.`);
                }
                // the instruction (a text run: the prompt, then what the references are), then each picture by n, with a
                // label part before it when more than one goes
                parts.push({ text: instruction(req, lay, req.prompt) });
                const labels = labelParts(lay, req.refName);
                // a text run's pictures are its references alone, reference i at pics[i]
                const inline = (pic) => (pic.role === "crop" ? pics[0] : pic.role === "mask" ? { mime: "image/png", bytes: Buffer.from(req.mask) } : pics[pic.ref + (text ? 0 : 1)]);
                lay.pictures.filter((pic) => pic.n != null).sort((a, b) => a.n - b.n).forEach((pic, k) => {
                    const x = inline(pic);
                    if (labels.length) parts.push(labels[k]);
                    parts.push({ inlineData: { mimeType: x.mime, data: x.bytes.toString("base64") } });
                });
            } else parts.push({ text: String(req.prompt || "") });
            const imageConfig = {};
            // a model that takes more presets than Gemini's ten names them in options.ratios (Nano Banana 2.1)
            const ratios = Array.isArray(o.ratios) && o.ratios.length ? o.ratios : GEMINI_RATIOS;
            const free = req.kind === "text" && !req.aspect && pics.length ? closestAspect(req.width || 1, req.height || 1, ratios) : null;
            const aspect = setting(p, "aspect_ratio") || (req.kind === "text" ? req.aspect || free : null);
            if (aspect) imageConfig.aspectRatio = String(aspect);
            const size = setting(p, "image_size") || (req.kind === "text" ? tierFor(Math.max(req.width || 0, req.height || 0), o.tiers) : null);
            if (size) imageConfig.imageSize = String(size);
            const generationConfig = { responseModalities: ["IMAGE"] };
            if (Object.keys(imageConfig).length) generationConfig.imageConfig = imageConfig;
            // only a variant with a Thinking row sends one, as the schema's upper-case enum (MINIMAL / MEDIUM / HIGH)
            const thinking = setting(p, "thinking_level");
            if (thinking) generationConfig.thinkingConfig = { thinkingLevel: String(thinking).toUpperCase() };
            return { contents: [{ role: "user", parts }], generationConfig };
        },
        // parts[0] is the instruction; with more than one picture each has its label part before it, so picture n sits
        // at part 2n, else the one picture at part 1. The mask picture counts against max_images like any other. A text
        // run has no crop: its references are pictures 1..N.
        layout(req, o) {
            const masked = req.kind === "fill" && req.mask && req.mask.length;
            const seq = [...(req.kind === "text" ? [] : [["crop"]]), ...(masked ? [["mask"]] : []), ...refRoles(req).map(([role, i]) => [role, i])];
            const at = (k) => `contents[0].parts[${seq.length > 1 ? 2 * (k + 1) : 1}]`;
            return layoutOf({ seq: seq.map(([role, i], k) => [role, at(k), i]), max: picturesMax(o) });
        },
        read(j) {
            const cand = Array.isArray(j.candidates) ? j.candidates[0] : null;
            const parts = (cand && cand.content && cand.content.parts) || [];
            // a thinking model may send draft pictures marked `thought`; the answer is the last one that is not
            const images = parts.filter((x) => x && x.inlineData && x.inlineData.data);
            const img = images.filter((x) => !x.thought).pop() || images.pop();
            if (img) return { bytes: Buffer.from(img.inlineData.data, "base64"), mime: img.inlineData.mimeType || "image/png" };
            const why = (cand && cand.finishReason) || (j.promptFeedback && (j.promptFeedback.blockReasonMessage || j.promptFeedback.blockReason)) || parts.map((x) => x && x.text).filter(Boolean).join(" ").slice(0, 200);
            return { refused: why || null };
        },
    },

    bfl: {
        body(req, o, pics, model, ctx) {
            // FLUX 3 Image: the Router takes BFL's own schema (tools/refs/comfyrouter/bfl_flux-3-image.json), so the body
            // is the one bfl.js sends, pictures and their rules included (a promise; run() awaits every body)
            if (model === FLUX3_MODEL) return flux3.body(req, `bfl/${model}`, ctx);
            const p = req.params || {};
            const body = { prompt: String(req.prompt || ""), output_format: "png" };
            if (req.seed != null && !p.random_seed) body.seed = req.seed >>> 0;
            if (model === "flux-pro-1.0-fill") {
                if (!pics.length) throw new Error(`Comfy Router bfl/${model} needs a crop and a mask; it cannot make a picture from the prompt alone.`);
                body.image = pics[0].bytes.toString("base64");
                if (req.mask && req.mask.length) body.mask = b64(req.mask);
                for (const k of ["steps", "guidance", "safety_tolerance", "prompt_upsampling"]) if (p[k] !== "" && p[k] != null) body[k] = p[k];
                return body;
            }
            // FLUX.2: width and height 256 to 2048 in the Router's schema, sent in 16 px steps
            const clamp = (v) => Math.max(256, Math.min(2048, Math.round((+v || 1024) / 16) * 16));
            body.width = clamp(req.width); body.height = clamp(req.height);
            if (pics.length) {
                body.input_image = pics[0].bytes.toString("base64");
                pics.slice(1).forEach((r, i) => { body[`input_image_${i + 2}`] = r.bytes.toString("base64"); });
            }
            for (const k of ["safety_tolerance", "prompt_upsampling"]) if (p[k] !== "" && p[k] != null) body[k] = p[k];
            return body;
        },
        layout(req, o, model) {
            if (model === FLUX3_MODEL) return req.kind === "text" ? flux3.textLayout(req) : flux3.layout(req);
            if (model === "flux-pro-1.0-fill") {
                if (req.kind === "text") return layoutOf({ drops: "FLUX.1 Fill takes no reference images" });
                return layoutOf({ seq: [["crop", "image"]], own: req.mask && req.mask.length ? [["mask", "mask"]] : [], max: picturesMax(o), drops: "FLUX.1 Fill takes no reference images" });
            }
            return layoutOf({ seq: inOrder(req, (k) => (k ? `input_image_${k + 1}` : "input_image")), max: picturesMax(o) });
        },
        read(j, req) {
            const r = j.result || {};
            if (!r.sample) return { refused: j.status || null };
            // FLUX 3 is sent no seed: one the answer names is reported, else none (null, not the editor's); its shape
            // goes to the stitch (fit "stretch" when a preset went) and the prompt as the model expanded it to the log
            if (splitModel(String(req.model || ""))[1] === FLUX3_MODEL) {
                const seed = r.seed != null && Number.isFinite(Number(r.seed)) ? Number(r.seed) : null;
                return { url: r.sample, seed, info: { ...flux3.infoOf(req), expanded_prompt: typeof r.prompt === "string" ? r.prompt : null, duration: r.duration != null ? Number(r.duration) : null } };
            }
            return { url: r.sample, seed: r.seed != null ? Number(r.seed) : undefined };
        },
    },

    byteplus: {
        body(req, o, pics) {
            const body = { prompt: editPrompt(req, DIALECTS.byteplus.layout(req, o)), size: ark._size(req, o), watermark: false, response_format: "b64_json", output_format: "png" };
            if (req.seed != null && !(req.params || {}).random_seed) body.seed = (req.seed >>> 0) % 2147483648;
            if (pics.length) body.image = pics.map(uri);
            return body;
        },
        layout(req, o) { return layoutOf({ seq: inOrder(req, (k) => `image[${k}]`), max: picturesMax(o) }); },
        read(j) {
            if (j.error && (j.error.code || j.error.message)) return { refused: `${j.error.code ? j.error.code + ": " : ""}${j.error.message || ""}` };
            const item = Array.isArray(j.data) ? j.data.find((d) => d && (d.b64_json || d.url)) : null;
            if (!item) return null;
            if (item.url && !item.b64_json) return { url: item.url, info: { answered: item.size || null } };
            const bytes = Buffer.from(item.b64_json, "base64");
            return { bytes, mime: bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : "image/png", info: { answered: item.size || null } };
        },
    },

    qwen: {
        body(req, o, pics) {
            const p = req.params || {};
            const content = pics.map((x) => ({ image: uri(x) }));
            content.push({ text: editPrompt(req, DIALECTS.qwen.layout(req, o)) });
            const [w, h] = fitPixels(req.width || 1024, req.height || 1024, { step: 16, max: 4096, minPixels: 262144, maxPixels: 6553600, maxRatio: 8 });
            const parameters = { n: 1, size: `${w}*${h}`, prompt_extend: false, watermark: false };
            if (req.seed != null && !p.random_seed) parameters.seed = (req.seed >>> 0) % 2147483648;
            if (req.negative) parameters.negative_prompt = String(req.negative);
            return { input: { messages: [{ role: "user", content }] }, parameters };
        },
        layout(req, o) { return layoutOf({ seq: inOrder(req, (k) => `input.messages[0].content[${k}]`), max: picturesMax(o) }); },
        read(j) {
            if (j.code && !j.output) return { refused: `${j.code}${j.message ? ": " + j.message : ""}` };
            const choices = (j.output && j.output.choices) || [];
            for (const c of choices) {
                const items = (c && c.message && c.message.content) || [];
                const img = items.find((x) => x && x.image);
                if (img) return { url: img.image };
            }
            const text = choices.flatMap((c) => (c && c.message && c.message.content) || []).map((x) => x && x.text).filter(Boolean).join(" ");
            return { refused: text.slice(0, 200) || null };
        },
    },

    freepik: {
        upscale: true,
        body(req) {
            const p = req.params || {};
            const f = Math.round(+req.factor || 2);
            const body = { image: b64(req.image), scale_factor: Math.max(2, Math.min(16, f)) };
            for (const k of ["flavor", "sharpen", "smart_grain", "ultra_detail"]) if (p[k] !== "" && p[k] != null) body[k] = p[k];
            return body;
        },
        read(j) {
            const d = j.data || {};
            const url = Array.isArray(d.generated) ? d.generated.find((x) => typeof x === "string" && x) : null;
            return url ? { url } : { refused: d.status || null };
        },
    },

    xai: {
        edit: false,
        body(req, o) {
            const p = req.params || {};
            const body = { prompt: String(req.prompt || ""), n: 1, aspect_ratio: closestAspect(req.width || 1, req.height || 1, o.ratios || ["1:1"]) };
            const tier = setting(p, "resolution") || tierFor(Math.max(req.width || 0, req.height || 0), o.tiers);
            if (tier) body.resolution = String(tier).toLowerCase();
            if (setting(p, "quality")) body.quality = p.quality;
            return body;
        },
        read(j) {
            if (j.block_reason) return { refused: j.block_reason };
            const item = Array.isArray(j.data) ? j.data.find((d) => d && (d.url || d.b64_json)) : null;
            if (!item) return null;
            if (item.b64_json) return { bytes: Buffer.from(item.b64_json, "base64"), mime: item.mime_type || "image/jpeg" };
            return { url: item.url };
        },
    },

    ideogram: {
        // Ideogram 4.0 (ideogram-v4) takes no input picture; 4.5 edits through Precise Edit
        edit: (model) => model === IDEOGRAM_45,
        body(req, o, pics, model, ctx) {
            const p = req.params || {};
            if (model === IDEOGRAM_45) return req.kind === "text" ? ideogram45Text(req, o) : ideogram45Edit(req, o, pics, model, ctx);
            // the 2K sizes of the Router's schema, as "WxH"; the one closest to the asked aspect
            const res = closestAspect(req.width || 1, req.height || 1, (o.resolutions || ["2048x2048"]).map((s) => s.replace("x", ":")));
            const body = { text_prompt: String(req.prompt || ""), resolution: res.replace(":", "x") };
            if (setting(p, "rendering_speed")) body.rendering_speed = p.rendering_speed;
            return body;
        },
        // 4.5's edit: the crop in `image`, the mask and the references in fields of their own, the references
        // unnumbered (no host documents how a prompt names one, so `style`: a prompt that names one is refused); a new
        // image is the prompt alone, since a picture in that call would become the picture edited
        layout(req, o, model) {
            if (model !== IDEOGRAM_45 || req.kind === "text") return layoutOf({ drops: NO_TEXT_REFS });
            const mask = req.mask && req.mask.length ? [["mask", "mask"]] : [];
            const refs = refRoles(req).map(([role, i]) => [role, `reference_images[${i}]`, i]);
            return layoutOf({ seq: [["crop", "image"]], own: [...mask, ...refs], max: picturesMax(o), style: true });
        },
        read(j, req, o, ctx, body) {
            const items = Array.isArray(j.data) ? j.data.filter((d) => d && typeof d === "object") : [];
            // "Only use images where this is true" (the schema's is_image_safe); Ideogram leaves `url` empty when it is false
            const item = items.find((d) => d.url && d.is_image_safe !== false);
            if (!item) return items.some((d) => d.is_image_safe === false) ? { refused: "Ideogram marked the picture as not safe (is_image_safe false)" } : null;
            const info = {};
            if (j.generation_id) info.generation_id = String(j.generation_id);
            if (item.resolution) info.answered = String(item.resolution);
            if (body && body.image && !body.mask) info.mask = "none: the selection covers the whole crop, so the whole crop was edited";
            const seed = item.seed != null ? Number(item.seed) : j.seed != null ? Number(j.seed) : body && body.seed != null ? body.seed : undefined;
            return { url: item.url, seed, info };
        },
    },

    krea: {
        edit: false,
        body(req, o) {
            const p = req.params || {};
            const body = { prompt: String(req.prompt || ""), aspect_ratio: closestAspect(req.width || 1, req.height || 1, o.ratios || ["1:1"]), resolution: "1K" };
            if (setting(p, "creativity")) body.creativity = p.creativity;
            if (req.seed != null && !p.random_seed) body.seed = req.seed >>> 0;
            return body;
        },
        read(j) {
            const urls = (j.result && j.result.urls) || [];
            const url = urls.find((x) => typeof x === "string" && x);
            return url ? { url } : { refused: j.status || null };
        },
    },
};

// ---- the queue -----------------------------------------------------------------------------------------------

/**
 * Sends one run and waits for its answer: submit to the queue (resent under the same Idempotency-Key when the Router
 * says to wait), poll the status as long as the server's Retry-After says, collect the result. A key the queue refuses
 * with not_enabled is sent once to the synchronous route instead. Returns the parsed native output and the headers
 * worth keeping.
 */
async function send(ctx, host, modelId, body, waitMs) {
    const [prov, model] = splitModel(modelId);
    const root = `${host}/v2/models/${prov}/${model}`;
    const json = JSON.stringify(body);
    if (json.length > REQUEST_BYTES_MAX) throw new Error(`Comfy Router ${modelId}: the request is ${(json.length / 1024 / 1024).toFixed(0)} MB, more than the 100 MB the Router takes. Set Highres fix lower or hide reference layers.`);
    const key = ctx.uuid();
    const headers = { "X-API-Key": ctx.key, "Content-Type": "application/json", "Idempotency-Key": key };
    const fail = async (r, what) => {
        const f = await readFailure(r, ctx.key);
        const wait = r.status === 429 || r.status === 503 || r.status === 409 ? retryAfterMs(r, 0) : 0;
        return new Error(scrub(`Comfy Router ${modelId}${what ? " " + what : ""}: ${explain(r.status, f)}${wait > 0 ? `; try again in ${Math.ceil(wait / 1000)} s` : ""}`, ctx.key));
    };

    let r = null;
    for (let n = 1; ; n++) {
        try {
            r = await ctx.fetch(root + "/requests", { method: "POST", headers, body: json });
        } catch (err) {
            // the answer may be lost with the run admitted: the same key returns that run, so a resend is safe
            if (n < RESEND_MAX) { ctx.log(`submit failed (${err && err.message}), sending once more`); await ctx.sleep(POLL_MS); continue; }
            throw new Error(scrub(`Comfy Router ${modelId}: no answer from the Router (${err && err.message || err})`, ctx.key));
        }
        if (r.status === 201 || r.ok) break;
        const type = (r.headers && r.headers.get && r.headers.get("x-comfy-error-type")) || "";
        if (r.status === 403 && type === "not_enabled") {
            // a key without a workspace behind it cannot use the queue; the synchronous route may still take it
            ctx.log("the queue refused this key (not_enabled), sending to the synchronous route");
            return sync(ctx, root, modelId, json);
        }
        const again = (r.status === 409 && type === "concurrency_limit_exceeded") || r.status === 429 || r.status === 503;
        const ms = retryAfterMs(r, POLL_MS);
        if (again && n < RESEND_MAX && ms <= RESEND_WAIT_MAX_MS) {
            ctx.log(`submit answered ${r.status} ${type}, sending the same request again after ${ms} ms`);
            await ctx.sleep(ms);
            continue;
        }
        throw await fail(r);
    }
    const sub = (await r.json().catch(() => null)) || {};
    const id = String(sub.request_id || "");
    if (!UUID.test(id)) throw new Error(scrub(`Comfy Router ${modelId}: the queue answered without a request id (${JSON.stringify(sub).slice(0, 200)})`, ctx.key));
    // the three URLs are composed here from the host and the id, never taken from the answer
    const at = `${root}/requests/${id}`;
    const read = { headers: { "X-API-Key": ctx.key } };
    const t0 = Date.now();
    let wait = retryAfterMs(r, POLL_MS), failures = 0, status = String(sub.status || "IN_QUEUE");
    const cancel = async () => {
        try { await ctx.fetch(at + "/cancel", { method: "PUT", headers: { "X-API-Key": ctx.key } }); } catch (_) { /* a request, not a guarantee */ }
    };
    for (;;) {
        while (status !== "COMPLETED") {
            if (Date.now() - t0 > waitMs) {
                await cancel();
                throw new Error(`Comfy Router ${modelId}: no answer after ${Math.round(waitMs / 60000)} minutes; the run was asked to stop (a run the provider finishes anyway is billed).`);
            }
            await ctx.sleep(Math.max(POLL_MIN_MS, Math.min(POLL_MAX_MS, wait)));
            let s;
            try { s = await ctx.fetch(at + "/status", read); } catch (err) {
                if (++failures >= POLL_FAILURES_MAX) throw new Error(scrub(`Comfy Router ${modelId}: the status read failed ${failures} times (${err && err.message || err})`, ctx.key));
                continue;
            }
            if (s.status === 429 || s.status >= 500) {
                if (++failures >= POLL_FAILURES_MAX) throw await fail(s, "status");
                wait = retryAfterMs(s, POLL_MS * 2);
                continue;
            }
            if (!s.ok) throw await fail(s, "status");
            failures = 0;
            wait = retryAfterMs(s, POLL_MS);
            const j = (await s.json().catch(() => null)) || {};
            status = String(j.status || "");
            if (status === "COMPLETED" && j.error_type) ctx.log(`completed with error_type ${j.error_type}`);
        }
        const out = await ctx.fetch(at, read);
        if (out.status === 202) { status = "IN_PROGRESS"; wait = retryAfterMs(out, POLL_MS); continue; }   // not collectable yet
        if (!out.ok) throw await fail(out);
        return answerOf(out, id);
    }
}

/** The synchronous route, for a key the queue does not take; a new Idempotency-Key, since the path differs. */
async function sync(ctx, root, modelId, json) {
    const headers = { "X-API-Key": ctx.key, "Content-Type": "application/json", "Idempotency-Key": ctx.uuid() };
    let r;
    try { r = await ctx.fetch(root, { method: "POST", headers, body: json }); } catch (err) {
        throw new Error(scrub(`Comfy Router ${modelId}: no answer from the Router (${err && err.message || err})`, ctx.key));
    }
    if (!r.ok) {
        const f = await readFailure(r, ctx.key);
        throw new Error(scrub(`Comfy Router ${modelId}: ${explain(r.status, f)}`, ctx.key));
    }
    return answerOf(r, null);
}

/** { json } of a JSON answer or { bytes, mime } of a picture answered as such, with the Router's headers. */
async function answerOf(r, id) {
    const h = (n) => (r.headers && r.headers.get && r.headers.get(n)) || null;
    const meta = { request_id: id || h("x-comfy-request-id"), credits: h("x-comfy-credits-used"), dropped: h("x-comfy-router-dropped-params"), fallback: h("x-comfy-router-fallback-provider") };
    const type = String(h("content-type") || "");
    if (/^image\//i.test(type)) return { bytes: Buffer.from(await r.arrayBuffer()), mime: type.split(";")[0], meta };
    const json = await r.json().catch(() => null);
    return { json: json || {}, meta };
}

// ---- runs ----------------------------------------------------------------------------------------------------

/** A URL the answer names, fetched without the key: https, or the test mock's own host. */
async function download(url, ctx, test, modelId) {
    const s = String(url || "");
    const ok = /^https:\/\//i.test(s) || /^data:image\//i.test(s) || (test && s.startsWith(test + "/"));
    if (!ok) throw new Error(`${ctx.who || "Comfy Router " + modelId}: the answer points to "${s.slice(0, 80)}", which Scumble does not fetch.`);
    return fetchImage(s, ctx.fetch);
}

function sniff(bytes, fallback) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    if (bytes.length > 12 && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
    return fallback || "image/png";
}

async function run(req, ctx, kind) {
    // ctx.sleep and ctx.uuid are injectable so tools/comfyrouter_test.js waits in milliseconds and knows the keys
    ctx = { ...ctx, sleep: ctx.sleep || realSleep, uuid: ctx.uuid || randomUUID, log: ctx.log || (() => {}) };
    const modelId = String(req.model || "");
    if (!modelId) throw new Error("Comfy Router recipe has no model id.");
    const [prov, model] = splitModel(modelId);
    if (!Object.prototype.hasOwnProperty.call(DIALECTS, prov)) throw new Error(`Comfy Router: Scumble does not speak the input of ${prov}/* models (${Object.keys(DIALECTS).join(", ")}).`);
    const d = DIALECTS[prov];
    const test = testBase(ctx.base);
    checkKey(!!test, ctx.key);
    if (kind === "upscale" && !d.upscale) throw new Error(`Comfy Router ${modelId} is not an upscaler.`);
    if (kind !== "upscale" && d.upscale) throw new Error(`Comfy Router ${modelId} is an upscaler; run it with Upscale.`);
    if (kind === "edit" && !editable(d, model)) throw new Error(`Comfy Router ${modelId} makes pictures from the prompt alone: use Generate new.`);
    const o = req.options || {};
    req = { ...req, params: req.params || {}, references: req.references || [], kind: kind === "text" ? "text" : req.kind };
    // a route whose layout declares a drop (FLUX.1 Fill; for a new image xai, ideogram and krea) sends no reference at
    // all, as index.js's checkPictures leaves the request; a direct call gets the crop alone (a new image: the prompt
    // alone) too instead of a refusal of pictures the route never sends
    if (kind === "edit" && req.references.length && d.layout(req, o, model).drops) req = { ...req, references: [], original: 0 };
    if (kind === "text" && req.references.length && textLayoutOf(d, req, o, model).drops) req = { ...req, references: [], original: 0 };
    if (kind === "text" && !String(req.prompt || "").trim()) throw new Error(`Comfy Router ${modelId}: a new image needs a prompt.`);
    if (kind !== "text" && !req.image) throw new Error(`Comfy Router ${modelId}: no picture to ${kind === "upscale" ? "upscale" : "edit"}.`);
    // FLUX 3 Image builds and checks its own pictures (flux3.js: scaled into 16 MP, JPEG past 20 MB of base64); the
    // Router's rules for the raw layers would refuse what it sends, so only the total of what goes is checked here
    const ownPictures = prov === "bfl" && model === FLUX3_MODEL;
    const pics = kind === "upscale" || ownPictures ? [] : await picturesFor(req, o, ctx, modelId);
    if (kind === "upscale" && req.image.length > PICTURE_BYTES_MAX) throw new Error(`Comfy Router ${modelId}: the picture is ${(req.image.length / 1024 / 1024).toFixed(1)} MB, more than the 25 MB the Router takes; upscale a smaller selection.`);
    const body = await d.body(req, o, pics, model, ctx);
    const sentPictures = ownPictures ? (Array.isArray(body.images) ? body.images : []) : pics;
    if (ownPictures) {
        const total = sentPictures.reduce((n, b) => n + Math.floor((String(b).length * 3) / 4), 0);
        if (total > PICTURES_BYTES_MAX) throw new Error(`${ctx.who || "Comfy Router " + modelId}: the pictures are ${(total / 1024 / 1024).toFixed(1)} MB together as sent, more than the 64 MB one request may carry. Hide reference layers or use smaller ones.`);
    }
    const got = await send(ctx, test || BASE, modelId, body, kind === "upscale" ? UPSCALE_WAIT_MS : EDIT_WAIT_MS);
    if (got.meta.dropped) ctx.log(`the Router dropped parameters: ${got.meta.dropped}`);
    let out = got.bytes ? { bytes: got.bytes, mime: got.mime } : d.read(got.json, req, o, ctx, body);
    if (!out || (!out.bytes && !out.url)) {
        const why = out && out.refused ? `no picture in the answer: ${out.refused}` : `no picture in the answer (${scrub(JSON.stringify(got.json || {}), ctx.key).slice(0, 200)})`;
        throw new Error(scrub(`Comfy Router ${modelId}: ${why}`, ctx.key));
    }
    if (out.url && !out.bytes) {
        const file = await download(out.url, ctx, test, modelId);
        out = { ...out, bytes: file.bytes, mime: file.mime };
    }
    const bytes = Buffer.from(out.bytes);
    return {
        // the seed the answer names, else the one the body sent (bfl, ideogram, byteplus put it in `seed`), else none:
        // a read that says null sent none (FLUX 3 Image)
        bytes, mime: sniff(bytes, out.mime), seed: out.seed === null ? null : out.seed != null && Number.isFinite(out.seed) ? out.seed : body && body.seed != null && Number.isFinite(Number(body.seed)) ? Number(body.seed) : null,
        info: { model: modelId, request_id: got.meta.request_id, credits: got.meta.credits != null ? Number(got.meta.credits) : null, dropped: got.meta.dropped || null, pictures: sentPictures.length, ...(out.info || {}) },
    };
}

/** The dialect of a request's model id and the model part, refused with run()'s own words. */
function dialectOf(req) {
    const modelId = String(req.model || "");
    if (!modelId) throw new Error("Comfy Router recipe has no model id.");
    const [prov, model] = splitModel(modelId);
    if (!Object.prototype.hasOwnProperty.call(DIALECTS, prov)) throw new Error(`Comfy Router: Scumble does not speak the input of ${prov}/* models (${Object.keys(DIALECTS).join(", ")}).`);
    const d = DIALECTS[prov];
    if (d.upscale) throw new Error(`Comfy Router ${modelId} is an upscaler; run it with Upscale.`);
    return { d, model, modelId };
}

/** Where each picture of an edit goes: the dialect run() picks, refused with run()'s own words. */
function layout(req) {
    const { d, model, modelId } = dialectOf(req);
    if (!editable(d, model)) throw new Error(`Comfy Router ${modelId} makes pictures from the prompt alone: use Generate new.`);
    return d.layout(req, req.options || {}, model);
}

/**
 * A text run's pictures in dialect `d`: its references alone, in the fields an edit puts them in from the first on,
 * capped by the model's max_images (the crop's slot becomes a reference slot); a model whose schema takes no input
 * picture (xai, ideogram-v4, krea) declares the drop, and so does Ideogram 4.5's layout for a text run.
 */
function textLayoutOf(d, req, o, model) {
    if (!editable(d, model) || typeof d.layout !== "function") return layoutOf({ drops: NO_TEXT_REFS });
    return d.layout(req, o, model);
}

/** Where each reference of a text run (Generate new, 26f) goes: the dialect run() picks. */
function textLayout(req) {
    const { d, model } = dialectOf(req);
    return textLayoutOf(d, { ...req, kind: "text" }, req.options || {}, model);
}

module.exports = {
    label: "Comfy Router",
    keyName: "comfycloud",   // the same Comfy key as Comfy Cloud: no key row of its own
    keyUrl: "https://platform.comfy.org/profile/api-keys",
    keyHint: "the Comfy Cloud key (platform.comfy.org); Comfy Router needs no paid plan, only credits",
    edit(req, ctx) { return run(req, ctx, "edit"); },
    layout,
    textLayout,
    generate(req, ctx) { return run(req, ctx, "text"); },
    upscale(req, ctx) { return run(req, ctx, "upscale"); },
    baseUrl,
    // exported for tools/comfyrouter_test.js
    _testBase: testBase,
    _splitModel: splitModel,
    _explain: explain,
    _pictures: picturesFor,
    _tierFor: tierFor,
    _editable: editable,
    DIALECTS,
    BASE,
    // shared with comfypartner.js, which talks to the same host with the same key
    _shared: { testBase, checkKey, scrub, picturesFor, download, sniff, retryAfterMs, pngSize },
};
