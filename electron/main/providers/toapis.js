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
//              auto takes the smallest tier whose output covers both edges of the emitted crop, read from
//              `tier_sizes` ({ "16:9": { "1K": "1820x1024", ... } }, the model page's table) for the size
//              sent, and by the tier's base against the long side where the table has no row
//   max_ratio  the steepest input ratio the model takes (Seedream: 3): a crop or reference beyond it is
//              refused before any upload
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
// "10MB" on the upload page, with no byte count: the smaller reading (10,000,000 bytes), so a file between
// the two readings takes the JPEG fallback instead of the server's refusal
const MAX_UPLOAD = 10 * 1000 * 1000;
const PARALLEL_UPLOADS = 4;
const FIRST_POLL_MS = 4000;
const POLL_MS = 5000;
const TIMEOUT_MS = 15 * 60 * 1000;
const LOST_QUERIES = 5;          // status queries in a row lost to the network or answered 5xx before the run gives up
const DOWNLOAD_TRIES = 3;
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

/**
 * The smallest tier whose output covers a w x h crop, else the largest. `table` is the model page's output
 * size per tier for the size sent ({ "1K": "1820x1024", ... }); a tier it does not list is judged by its
 * base against the long side. A tier's base is not its long edge (FLUX 1K 16:9 is 1820 x 1024, GPT Image 2
 * 1k 2:1 is 2048 x 1024), so the base alone would buy a dearer tier than the crop needs.
 */
function tierFor(w, h, tiers, table) {
    const rows = Object.entries(tiers || {}).map(([k, v]) => [k, +v]).filter(([, v]) => v > 0).sort((a, b) => a[1] - b[1]);
    if (!rows.length) return null;
    const long = Math.max(w, h);
    for (const [k, v] of rows) {
        const m = table && /^(\d+)x(\d+)$/.exec(String(table[k] || ""));
        if (m ? +m[1] >= w && +m[2] >= h : v >= long) return k;
    }
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
    const table = ch.tier_sizes && size ? ch.tier_sizes[size] : null;
    const tier = ch.tiers ? tierFor(w, h, ch.tiers, table) : null;
    return { size, tier };
}

/** [width, height] from a PNG's IHDR, or null for anything else. */
function pngSize(b) {
    if (!b || b.length < 24 || b[0] !== 0x89 || b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null;
    const u32 = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    return [u32(16), u32(20)];
}

const steeper = (w, h, r) => w > 0 && h > 0 && Math.max(w, h) / Math.min(w, h) > r;

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

const mb = (n) => (Math.ceil(n / 100000) / 10).toFixed(1);   // decimal MB, rounded up: 10 MB and a byte is "10.1"

/**
 * The files a run uploads, checked against the model's input ratio and the 10 MB limit before any request
 * goes out. A crop over the limit is re-encoded as JPEG (ctx.toJpeg, Electron's nativeImage in the app), and
 * so is a reference with no transparent pixel (ctx.opaque; the Original copy of the crop is one); a reference
 * with transparency keeps its PNG (a JPEG would flatten the cut-out) and the mask always does (its alpha is
 * the mask).
 */
async function prepareFiles(req, ctx, ch, stamp) {
    const files = [];
    if (req.kind === "text") return { images: files, mask: null };
    if (!req.image || !req.image.length) throw new Error("ToAPIs: the run has no crop.");
    const refs = req.references || [];
    if (ch.max_ratio) {
        const r = +ch.max_ratio;
        if (steeper(+req.width, +req.height, r)) throw new Error(`ToAPIs ${ch.model} takes no image longer than ${r}:1, and the crop is ${req.width} × ${req.height}: select a less elongated area, or a larger one around it.`);
        refs.forEach((b, i) => {
            const s = pngSize(b);
            if (s && steeper(s[0], s[1], r)) throw new Error(`ToAPIs ${ch.model} takes no image longer than ${r}:1, and reference ${i + 1} is ${s[0]} × ${s[1]}: crop that reference layer closer to square.`);
        });
    }
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
    for (let i = 0; i < refs.length; i++) {
        const r = refs[i];
        let ref = { bytes: r, mime: "image/png", name: `scumble-${stamp}-ref${i + 1}.png` };
        let transparent = false;
        if (r.length > MAX_UPLOAD) {
            const flat = typeof ctx.opaque === "function" && typeof ctx.toJpeg === "function" && await ctx.opaque(r);
            transparent = !flat;
            const jpeg = flat ? await ctx.toJpeg(r, 92) : null;
            if (jpeg && jpeg.length) {
                ctx.log(`reference ${i + 1} ${mb(r.length)} MB as PNG, ${mb(jpeg.length)} MB as JPEG`);
                ref = { bytes: Buffer.from(jpeg), mime: "image/jpeg", name: `scumble-${stamp}-ref${i + 1}.jpg` };
            }
        }
        if (ref.bytes.length > MAX_UPLOAD) throw new Error(`ToAPIs: reference ${i + 1} is ${mb(ref.bytes.length)} MB${transparent ? " (with transparency, so it stays a PNG)" : ""}, ToAPIs takes 10 MB per image: set Highres fix lower, turn Original off, or use a smaller reference layer.`);
        files.push(ref);
    }
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
    let wait = FIRST_POLL_MS, lost = 0;
    for (;;) {
        if (Date.now() - t0 > TIMEOUT_MS) throw new Error(`ToAPIs ${model} (task ${id}): no answer after 15 minutes; the task may still finish in the ToAPIs console.`);
        await ctx.sleep(wait);
        wait = POLL_MS + Math.floor(ctx.random() * 1000);
        let r;
        try {
            r = await ctx.fetch(url, { headers: { Authorization: "Bearer " + ctx.key } });
        } catch (err) {
            // a status query costs nothing and changes nothing: a few lost ones are not a failure
            if (++lost > LOST_QUERIES) throw new Error(`ToAPIs ${model} (task ${id}): status query failed ${lost} times in a row: ${scrub(err && err.message || err, ctx.key)}; the task may still finish in the ToAPIs console.`);
            ctx.log(`task ${id}: status query lost (${lost}), polling on`);
            continue;
        }
        if (r.status === 429 || r.status === 503) { lost = 0; wait = retryAfterMs(r); continue; }
        if (r.status >= 500) {
            // a gateway error on a status query is a lost query too: the paid task runs on upstream
            const msg = await failure(r, ctx.key);
            if (++lost > LOST_QUERIES) throw new Error(`ToAPIs ${model} (task ${id}): status query answered ${r.status} ${lost} times in a row (${msg}); the task may still finish in the ToAPIs console.`);
            ctx.log(`task ${id}: status query answered ${r.status} (${lost}), polling on`);
            wait = Math.min(30000, wait * lost);
            continue;
        }
        lost = 0;
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

/**
 * The finished image from files.toapis.com, without the key. The task is paid for by now, so a failed
 * download is tried again, and the error names the task, whose image stays in the ToAPIs console for 24 h.
 */
async function download(ctx, model, id, url) {
    let last = null;
    for (let attempt = 1; attempt <= DOWNLOAD_TRIES; attempt++) {
        try {
            return await fetchImage(url, ctx.fetch);
        } catch (err) {
            last = err;
            if (attempt < DOWNLOAD_TRIES) {
                ctx.log(`task ${id}: result download failed (${scrub(err && err.message || err, ctx.key)}), trying again`);
                await ctx.sleep(2000 * attempt);
            }
        }
    }
    throw new Error(`ToAPIs ${model} (task ${id}): the finished image could not be downloaded (${scrub(last && last.message || last, ctx.key)}); it stays in the ToAPIs console for 24 hours.`);
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
    ctx.log(`task ${task.id} submitted (${ch.model})`);
    const done = await poll(ctx, ch.model, task.id);
    const url = resultUrl(done);
    if (!url) throw new Error(`ToAPIs ${ch.model} (task ${task.id}): completed without an image URL.`);
    const file = await download(ctx, ch.model, task.id, url);   // files.toapis.com, no key
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
    explain,   // llm.js: the same words for a failed chat request on the ToAPIs key
    // exported for tools/toapis_test.js
    _allowedBase: allowedBase,
    _body: bodyFor,
    _size: sizeFor,
    _tier: tierFor,
    _channel: channelOf,
    _ratio: reducedRatio,
    MAX_UPLOAD,
};
