// ToAPIs (toapis.com): a reseller with one key for the OpenAI, Google, BFL, ByteDance and Qwen image
// models, on a New API gateway. Written from the English docs (docs.toapis.com/docs/en/...) on
// 2026-09-15; nothing here has run against the live API yet (docs/RECIPES.md "ToAPIs" lists what only a
// real key can verify).
//
//   POST /v1/uploads/images            multipart `file` (JPEG / PNG / WebP / GIF, 10 MB)
//                                      -> { success, data: { id, url, mime_type, size } }
//   POST /v1/images/generations        JSON { model, prompt, n, size, resolution | metadata.resolution,
//                                      image_urls, mask_url, ... } -> { id, status: "queued" | "pending" }
//   GET  /v1/images/generations/<id>   pending / queued / submitted / in_progress, then completed
//                                      (result.data[0].url, 24 h) or failed (HTTP 200, error.message)
//   GET  /v1/balance                   { success, remain_credits, credits_per_usd (200), unlimited_quota }
//
// Every image is a task: no base64 anywhere, so crop, mask and references are uploaded first and become
// public files.toapis.com URLs. Results are downloaded at once and without the key.
//
// A recipe variant describes the model with `options`:
//   channels   { <Channel row value>: overrides }   normal, VIP and official are different model ids
//              with different rules; the variant's `model` is the default channel's id
//   mask       true: a "fill" run uploads req.maskAlpha as mask_url (only gpt-image-2-official has one;
//              alpha 0 = repaint, OpenAI's convention, which the ToAPIs page states)
//   size       "ratio" (the crop's own W:H, gpt-image-2 official / VIP), "preset" (the closest of
//              `ratios`), "pixels" (WxH under `pixels` rules, GPT Image 2.5 official / VIP, Qwen)
//   tiers      { "1K": 1024, ... } with `tier_key` ("resolution" or "metadata.resolution"): a row left on
//              auto takes the smallest tier whose base covers the emitted long side
//   urls       "objects": image_urls as [{ url }] (the Gemini standard and VIP pages), else strings
//   images     the field the images go in (default image_urls); max_images: how many the model takes
//   drop       parameters this channel does not take; transparent_only: `background` only when "transparent"
//   seed, negative   where a model takes them (Qwen: metadata.seed, metadata.negative_prompt)
// Recipe settings pass through by key, dotted keys nest ("metadata.resolution" -> { metadata: { resolution } }).
//
// The host the key goes to never comes from a recipe (an imported recipe could send it anywhere):
// baseUrl() reads settings.toapis.base and accepts only the documented hosts or a loopback mock.
//
// Referral: the key link (keyUrl) carries DenRakEiw's ToAPIs referral code.
"use strict";

const { fetchImage, readError, sleep: realSleep, closestAspect, fitPixels } = require("./util");

const DEFAULT_BASE = "https://toapis.com";
const ALLOWED_HOSTS = new Set(["https://toapis.com", "https://api.toapis.com", "https://toapis.cn", "https://api.toapis.cn"]);
const MAX_UPLOAD = 10 * 1024 * 1024;
const PARALLEL_UPLOADS = 4;
const FIRST_POLL_MS = 4000;
const POLL_MS = 5000;
const TIMEOUT_MS = 15 * 60 * 1000;
const PENDING = new Set(["pending", "queued", "submitted", "in_progress", "processing", "running", ""]);
const FAILED = new Set(["failed", "cancelled", "canceled", "expired", "error"]);
const GPT_PIXELS = { step: 16, max: 3840, minPixels: 655360, maxPixels: 8294400, maxRatio: 3 };

/**
 * The base URL for this install: the documented hosts, or http://127.0.0.1:<port> (the test mock).
 * Anything else, a path included, gives null.
 */
function allowedBase(value) {
    if (!value) return null;
    let u;
    try { u = new URL(String(value).trim()); } catch (_) { return null; }
    if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) return null;
    const origin = `${u.protocol}//${u.host}`;
    if (ALLOWED_HOSTS.has(origin)) return origin;
    if (u.protocol === "http:" && u.hostname === "127.0.0.1" && u.port) return origin;
    return null;
}

/** settings.toapis.base when it is allowed, else the default host. */
function baseUrl(settings) {
    const s = (settings && settings.toapis) || {};
    return allowedBase(s.base) || DEFAULT_BASE;
}

function api(ctx) {
    return (allowedBase(ctx.base) || DEFAULT_BASE) + "/v1/";
}

/** An error text with the key taken out, whatever the server echoed. */
function scrub(text, key) {
    let s = String(text == null ? "" : text);
    if (key && key.length >= 6) s = s.split(key).join("[key]");
    return s;
}

/** What a failed HTTP answer means, in words, ahead of the server's own (possibly Chinese) message. */
function explain(status, message) {
    const why = { 401: "key refused", 402: "balance too low, top up at toapis.com", 403: "key not allowed for this model", 422: "refused by the content policy", 429: "rate limited" }[status];
    return why ? `${why} (${message})` : message;
}

async function failure(r, key) {
    return scrub(explain(r.status, await readError(r)), key);
}

function retryAfterMs(r, fallback = 10000) {
    const v = r.headers && r.headers.get && r.headers.get("retry-after");
    if (v == null || v === "") return fallback;
    const n = Number(v);
    if (Number.isFinite(n)) return Math.max(0, Math.min(120, n)) * 1000;
    const at = Date.parse(v);
    return Number.isFinite(at) ? Math.max(0, Math.min(120000, at - Date.now())) : fallback;
}

/** obj["a.b.c"] = v as obj.a.b.c = v. */
function setPath(obj, key, value) {
    const parts = String(key).split(".");
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!o[parts[i]] || typeof o[parts[i]] !== "object" || Array.isArray(o[parts[i]])) o[parts[i]] = {};
        o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = value;
}

function getPath(obj, key) {
    return String(key).split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

/** The channel a run takes: the variant's options with the chosen Channel row value's overrides on top. */
function channelOf(req) {
    const o = req.options || {};
    const p = req.params || {};
    const { channels, ...base } = o;
    const name = p.channel != null && p.channel !== "" ? String(p.channel) : "";
    let ch = { ...base, model: req.model };
    if (channels && name) {
        if (!channels[name]) throw new Error(`ToAPIs ${req.model}: no channel "${name}" (${Object.keys(channels).join(", ")})`);
        ch = { ...ch, ...channels[name] };
    }
    if (!ch.model) throw new Error("ToAPIs recipe has no model id.");
    return { name: name || "default", ...ch };
}

function gcd(a, b) {
    while (b) [a, b] = [b, a % b];
    return a;
}

/** "W:H" in lowest terms, no steeper than 3:1 (gpt-image-2 official and VIP take any such ratio). */
function reducedRatio(w, h) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (w > 3 * h) return "3:1";
    if (h > 3 * w) return "1:3";
    const g = gcd(w, h);
    return `${w / g}:${h / g}`;
}

function aspectNumbers(aspect) {
    const [a, b] = String(aspect || "").split(":").map(Number);
    return a > 0 && b > 0 ? [a, b] : null;
}

/** The smallest tier whose base covers the long side, else the largest. */
function tierFor(long, tiers) {
    const rows = Object.entries(tiers || {}).map(([k, v]) => [k, +v]).filter(([, v]) => v > 0).sort((a, b) => a[1] - b[1]);
    if (!rows.length) return null;
    for (const [k, v] of rows) if (v >= long) return k;
    return rows[rows.length - 1][0];
}

/**
 * `size` and the resolution tier for a run: from the emitted crop (edit / fill) or from the asked size
 * and aspect (text). Returns { size, tier } (either may be null).
 */
function sizeFor(req, ch) {
    const w = Math.max(1, +req.width || 1024), h = Math.max(1, +req.height || 1024);
    const text = req.kind === "text";
    const asked = text ? aspectNumbers(req.aspect) : null;
    let size = null;
    if (ch.size === "ratio") {
        size = asked ? reducedRatio(asked[0], asked[1]) : reducedRatio(w, h);
    } else if (ch.size === "preset" && Array.isArray(ch.ratios) && ch.ratios.length) {
        if (asked && ch.ratios.includes(req.aspect)) size = req.aspect;
        else size = asked ? closestAspect(asked[0], asked[1], ch.ratios) : closestAspect(w, h, ch.ratios);
    } else if (ch.size === "pixels") {
        const [pw, ph] = fitPixels(w, h, { ...GPT_PIXELS, ...(ch.pixels || {}) });
        size = `${pw}x${ph}`;
    }
    const tier = ch.tiers ? tierFor(Math.max(w, h), ch.tiers) : null;
    return { size, tier };
}

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

const mb = (n) => (Math.ceil(n / 104857.6) / 10).toFixed(1);   // rounded up: 10 MB and a byte is "10.1"

/**
 * The files a run uploads, checked against the 10 MB limit before any request goes out. A crop over it is
 * re-encoded as JPEG (ctx.toJpeg, Electron's nativeImage in the app); a reference keeps its PNG (it may be a
 * cut-out whose alpha a JPEG would lose) and the mask always does (its alpha is the mask).
 */
async function prepareFiles(req, ctx, ch, stamp) {
    const files = [];
    if (req.kind === "text") return { images: files, mask: null };
    if (!req.image || !req.image.length) throw new Error("ToAPIs: the run has no crop.");
    let crop = { bytes: req.image, mime: "image/png", name: `scumble-${stamp}-crop.png` };
    if (crop.bytes.length > MAX_UPLOAD && typeof ctx.toJpeg === "function") {
        const jpeg = await ctx.toJpeg(req.image, 92);
        if (jpeg && jpeg.length) {
            ctx.log(`crop ${mb(req.image.length)} MB as PNG, ${mb(jpeg.length)} MB as JPEG`);
            crop = { bytes: Buffer.from(jpeg), mime: "image/jpeg", name: `scumble-${stamp}-crop.jpg` };
        }
    }
    if (crop.bytes.length > MAX_UPLOAD) throw new Error(`ToAPIs: the crop is ${mb(crop.bytes.length)} MB, ToAPIs takes 10 MB per image: set Highres fix lower.`);
    files.push(crop);
    (req.references || []).forEach((r, i) => {
        if (r.length > MAX_UPLOAD) throw new Error(`ToAPIs: reference ${i + 1} is ${mb(r.length)} MB, ToAPIs takes 10 MB per image.`);
        files.push({ bytes: r, mime: "image/png", name: `scumble-${stamp}-ref${i + 1}.png` });
    });
    if (ch.max_images && files.length > ch.max_images) throw new Error(`ToAPIs ${ch.model} takes ${ch.max_images} image${ch.max_images > 1 ? "s" : ""}, this run has ${files.length} (the crop and ${files.length - 1} reference${files.length === 2 ? "" : "s"}).`);
    let mask = null;
    if (req.kind === "fill" && ch.mask) {
        if (!req.maskAlpha || !req.maskAlpha.length) throw new Error(`ToAPIs ${ch.model}: the run has no alpha mask.`);
        if (req.maskAlpha.length > MAX_UPLOAD) throw new Error(`ToAPIs: the mask is ${mb(req.maskAlpha.length)} MB, ToAPIs takes 10 MB per image: set Highres fix lower.`);
        mask = { bytes: req.maskAlpha, mime: "image/png", name: `scumble-${stamp}-mask.png` };
    }
    return { images: files, mask };
}

async function upload(ctx, file) {
    const fd = new FormData();
    fd.append("file", new Blob([file.bytes], { type: file.mime }), file.name);
    const r = await ctx.fetch(api(ctx) + "uploads/images", { method: "POST", headers: { Authorization: "Bearer " + ctx.key }, body: fd });
    if (!r.ok) throw new Error(`ToAPIs upload (${file.name}): ${await failure(r, ctx.key)}`);
    const j = (await r.json()) || {};
    if (j.success === false) throw new Error(`ToAPIs upload (${file.name}): ${scrub(j.message || "refused", ctx.key)}`);
    const url = j.data && j.data.url;
    if (!url) throw new Error(`ToAPIs upload (${file.name}) answered without a URL: ${scrub(JSON.stringify(j).slice(0, 200), ctx.key)}`);
    return url;
}

/** The generation request's JSON body (uploads done by `uploadAll`, which gives { images: [url], mask: url }). */
function bodyFor(req, ch, urls, sz) {
    const p = req.params || {};
    const body = { model: ch.model, prompt: req.prompt || "", n: 1 };
    const drop = new Set(["channel", "random_seed", "model", "n", "prompt", ...(ch.drop || [])]);
    for (const [k, v] of Object.entries(p)) {
        if (drop.has(k) || v === "" || v == null || v === "auto") continue;
        if (k === "background" && ch.transparent_only && String(v).toLowerCase() !== "transparent") continue;
        setPath(body, k, v);
    }
    if (urls.images.length) {
        const field = ch.images || "image_urls";
        body[field] = ch.urls === "objects" ? urls.images.map((url) => ({ url })) : urls.images;
    }
    if (urls.mask) body.mask_url = urls.mask;
    if (sz.size && body.size == null) body.size = sz.size;
    if (sz.tier && ch.tier_key && getPath(body, ch.tier_key) == null) setPath(body, ch.tier_key, sz.tier);
    if (ch.seed && req.seed != null && !p.random_seed && getPath(body, ch.seed) == null) setPath(body, ch.seed, req.seed >>> 0);
    if (ch.negative && req.negative && getPath(body, ch.negative) == null) setPath(body, ch.negative, String(req.negative));
    return body;
}

async function submit(ctx, body) {
    const headers = { Authorization: "Bearer " + ctx.key, "Content-Type": "application/json" };
    const post = () => ctx.fetch(api(ctx) + "images/generations", { method: "POST", headers, body: JSON.stringify(body) });
    let r = await post();
    // the docs: a 429 or a 503 at submit means the task was not accepted, so one retry is safe; a network
    // error is never retried (a lost answer could be a second paid task)
    if (r.status === 429 || r.status === 503) {
        const ms = retryAfterMs(r);
        ctx.log(`submit answered ${r.status}, retrying once after ${ms} ms`);
        await ctx.sleep(ms);
        r = await post();
    }
    if (!r.ok) throw new Error(`ToAPIs ${body.model}: ${await failure(r, ctx.key)}`);
    const j = (await r.json()) || {};
    const id = j.id || j.task_id || (j.data && (j.data.id || j.data.task_id));
    if (!id) throw new Error(`ToAPIs ${body.model} answered without a task id: ${scrub(JSON.stringify(j).slice(0, 200), ctx.key)}`);
    return { id: String(id), first: j };
}

/** The image URL of a completed task: result.data[0].url, else a top-level url. */
function resultUrl(j) {
    const d = j.result && Array.isArray(j.result.data) ? j.result.data[0] : null;
    if (typeof d === "string") return d;
    if (d && d.url) return d.url;
    if (j.result && typeof j.result.url === "string") return j.result.url;
    return typeof j.url === "string" ? j.url : null;
}

async function poll(ctx, model, id) {
    const t0 = Date.now();
    const url = api(ctx) + "images/generations/" + encodeURIComponent(id);
    let wait = FIRST_POLL_MS, netErrors = 0;
    for (;;) {
        if (Date.now() - t0 > TIMEOUT_MS) throw new Error(`ToAPIs ${model} (task ${id}): no answer after 15 minutes; the task may still finish in the ToAPIs console.`);
        await ctx.sleep(wait);
        wait = POLL_MS + Math.floor(ctx.random() * 1000);
        let r;
        try {
            r = await ctx.fetch(url, { headers: { Authorization: "Bearer " + ctx.key } });
        } catch (err) {
            // a status query costs nothing and changes nothing: a few lost ones are not a failure
            if (++netErrors > 3) throw new Error(`ToAPIs ${model} (task ${id}): status query failed: ${scrub(err && err.message || err, ctx.key)}`);
            continue;
        }
        netErrors = 0;
        if (r.status === 429 || r.status === 503) { wait = retryAfterMs(r); continue; }
        if (!r.ok) throw new Error(`ToAPIs ${model} (task ${id}): ${await failure(r, ctx.key)}`);
        const j = (await r.json()) || {};
        const status = String(j.status || "").toLowerCase();
        if (status === "completed" || status === "succeeded" || status === "success") return j;
        if (FAILED.has(status)) {
            const e = j.error;
            const msg = (e && (e.message || (typeof e === "string" ? e : ""))) || j.fail_reason || status;
            throw new Error(`ToAPIs ${model} (task ${id}): ${scrub(msg, ctx.key)}`);
        }
        if (!PENDING.has(status)) ctx.log(`task ${id}: unknown status "${status}", polling on`);
    }
}

async function run(req, ctx) {
    // ctx.sleep and ctx.random are injectable so tools/toapis_test.js runs a poll in milliseconds
    ctx = { ...ctx, sleep: ctx.sleep || realSleep, random: ctx.random || Math.random, log: ctx.log || (() => {}) };
    const ch = channelOf(req);
    const stamp = Date.now().toString(36);
    const files = await prepareFiles(req, ctx, ch, stamp);
    const sz = sizeFor(req, ch);
    const urls = { images: [], mask: null };
    if (files.images.length || files.mask) {
        const all = files.mask ? [...files.images, files.mask] : files.images;
        const got = await mapLimit(all, PARALLEL_UPLOADS, (f) => upload(ctx, f));
        urls.images = got.slice(0, files.images.length);
        urls.mask = files.mask ? got[got.length - 1] : null;
    }
    const body = bodyFor(req, ch, urls, sz);
    const task = await submit(ctx, body);
    const done = await poll(ctx, ch.model, task.id);
    const url = resultUrl(done);
    if (!url) throw new Error(`ToAPIs ${ch.model} (task ${task.id}): completed without an image URL.`);
    const file = await fetchImage(url, ctx.fetch);   // files.toapis.com, no key
    const billing = done.billing || {};
    return {
        bytes: file.bytes, mime: file.mime, seed: req.seed,
        info: { model: ch.model, channel: ch.name, task: task.id, size: body.size || null, resolution: getPath(body, ch.tier_key || "resolution") || null, cost_usd: billing.cost_usd != null ? billing.cost_usd : null, credits: billing.credits != null ? billing.credits : null },
    };
}

module.exports = {
    label: "ToAPIs",
    keyUrl: "https://toapis.com/login?aff=vfR1",
    keyHint: "API key from toapis.com › Console › API keys (the link carries Scumble's referral code)",
    edit: run,
    generate: run,   // kind "text": no uploads, the same endpoint

    /** GET /v1/balance, free: what the key has left, in USD (1 USD = 200 credits). */
    async balance(ctx) {
        const r = await ctx.fetch(api(ctx) + "balance", { headers: { Authorization: "Bearer " + ctx.key } });
        if (!r.ok) throw new Error(`ToAPIs balance: ${await failure(r, ctx.key)}`);
        const j = (await r.json()) || {};
        if (j.success === false) throw new Error(`ToAPIs balance: key not found (${scrub(j.message || "", ctx.key)})`);
        const credits = Number(j.remain_credits);
        const per = Number(j.credits_per_usd) > 0 ? Number(j.credits_per_usd) : 200;
        return { usd: Number.isFinite(credits) ? credits / per : null, credits: Number.isFinite(credits) ? credits : null, unlimited: !!j.unlimited_quota };
    },

    baseUrl,
    // exported for tools/toapis_test.js
    _allowedBase: allowedBase,
    _body: bodyFor,
    _size: sizeFor,
    _tier: tierFor,
    _channel: channelOf,
    _ratio: reducedRatio,
    MAX_UPLOAD,
};
