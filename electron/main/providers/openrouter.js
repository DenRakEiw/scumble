// OpenRouter (openrouter.ai): one key for the Google, OpenAI, Black Forest Labs, ByteDance, xAI, Krea and
// Recraft image models, through its unified Image API. Written from its docs (openrouter.ai/docs/..., the
// `.md` twins, and GET /api/v1/images/models) on 2026-09-19; nothing here has run against the live API yet
// (docs/RECIPES.md "OpenRouter" lists what only a real key can verify).
//
//   POST /api/v1/images      JSON { model, prompt, input_references: [{ type: "image_url", image_url: { url } }],
//                            resolution, aspect_ratio, quality, background, output_format, seed, n, provider }
//                            -> { created, data: [{ b64_json, media_type }], usage: { cost, ... } }
//   GET  /api/v1/key         { data: { limit, limit_remaining, usage, ... } }: the key's own spending limit
//   GET  /api/v1/providers   { data: [{ slug, headquarters, datacenters }] }: public, no key
//
// One synchronous request per image: the pictures go inline as data URLs, the answer is base64. There is no
// mask input, so a "fill" run sends the mask as the second picture and the prompt says what it means (as the
// Gemini adapter does); an "edit" run sends the crop and the references only. The stitch keeps the
// selection either way. Billing is all or nothing: a generation that does not finish answers 502 and costs
// nothing.
//
// A recipe variant describes the model with `options`:
//   accepts     the parameters the model's endpoints list in GET /api/v1/images/models; nothing else is sent
//               ("an unlisted value is rejected", the model pages)
//   ratios      the model's aspect_ratio presets (without auto): a text run sends the closest one; an edit
//               sends none, so the host keeps the crop's shape as its own edit endpoint does
//   tiers       { "1K": 1024, ... }: a Resolution row left on auto takes the smallest tier whose base covers
//               the long side of the emitted crop (or of the asked size), else the largest
//   max_images  how many pictures the model takes (input_references' range); more are refused before sending
//   max_ratio   the steepest picture the model takes (Seedream: 16, ModelArk's documented input range); a steeper
//               one is refused before sending
//   only_for    { <resolution>: [host slugs] }: a tier only some of the model's hosts serve goes only to them
//               (Nano Banana Pro's 4K: Google AI Studio lists it, Vertex AI stops at 2K)
// Settings rows pass through by key when `accepts` has the key; "auto", empty values and random_seed are not
// sent. `fixed` (output_format "png" for FLUX) passes the same way.
//
// Privacy: every request carries provider.ignore with the hosts OpenRouter lists in China (headquarters or a
// datacentre, GET /api/v1/providers, fetched once per session; a dated list when that fails). The Image API
// has no data_collection or zdr field (its schema lists only allow_fallbacks, ignore, only, options, order,
// sort). No attribution header (HTTP-Referer, X-Title, X-OpenRouter-*) goes out: it would create a public
// app page before the name's trademark check.
//
// The host never comes from a recipe: baseUrl() reads settings.openrouter.base and accepts only
// https://openrouter.ai or a loopback mock, and a key that starts with "test-" goes to the mock only, any
// other key never to it (so a real key cannot reach a local listener that a setting points at).
"use strict";

const { sleep: realSleep, closestAspect } = require("./util");

const DEFAULT_BASE = "https://openrouter.ai";
const ALLOWED_HOSTS = new Set(["https://openrouter.ai"]);
// Hosts OpenRouter listed on 2026-09-19 with their headquarters or a datacentre in China (GET /api/v1/providers);
// used when the live list cannot be read, and merged with it when it can.
const CHINA_HOSTS = ["alibaba", "baidu", "deepseek", "nex-agi", "streamlake", "tencent", "xiaomi"];
// The pictures of one request, as base64 in the JSON body. OpenRouter states no limit (it answers 413 above
// one); 18 MB stays under the tightest one an upstream documents (Gemini: 20 MB for a request with inline
// images). Over it the opaque pictures go as JPEG, largest first; still over it the run is refused.
const MAX_INLINE = 18 * 1000 * 1000;
const JPEG_QUALITY = 92;
const RETRY_WAIT_MS = 5000;
const RETRY_WAIT_MAX_MS = 60000;   // a Retry-After longer than this is not waited for: the run fails and says when to try again
const PROVIDERS_TIMEOUT_MS = 10000;
const BALANCE_TIMEOUT_MS = 15000;
const PARAMS = ["resolution", "aspect_ratio", "quality", "background", "output_format", "output_compression"];

/** The base URL for this install: https://openrouter.ai, or http://127.0.0.1:<port> (the test mock); else null. */
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

/** settings.openrouter.base when it is allowed, else the default host. */
function baseUrl(settings) {
    const s = (settings && settings.openrouter) || {};
    return allowedBase(s.base) || DEFAULT_BASE;
}

function isLoopback(base) {
    return /^http:\/\/127\.0\.0\.1:\d+$/.test(String(base || ""));
}

/**
 * Refuses a key that does not belong at this host: a test key ("test-...") goes only to the loopback mock, and
 * a real key never does. Throws before any request.
 */
function checkKey(base, key) {
    const test = /^test-/.test(String(key || ""));
    if (isLoopback(base) && !test) throw new Error(`OpenRouter: the host is set to the test address ${base}, and only a test key goes there; clear settings.openrouter.base to use a real key.`);
    if (!isLoopback(base) && test) throw new Error("OpenRouter: a test key is never sent to openrouter.ai; store a real key under Settings › API providers.");
}

function root(ctx) {
    return allowedBase(ctx.base) || DEFAULT_BASE;
}

/** An error text with the key taken out, whatever the server echoed. */
function scrub(text, key) {
    let s = String(text == null ? "" : text);
    if (key && key.length >= 6) s = s.split(key).join("[key]");
    return s;
}

/** What a failed answer means, in words, ahead of the server's own message. */
function explain(status, message, meta) {
    const m = meta || {};
    let why = {
        400: "request refused",
        401: "key refused",
        402: "credits too low, top up at openrouter.ai/credits",
        403: "refused (the content policy, a guardrail or the key's permissions)",
        404: "no host serves this model with these settings",
        408: "timed out",
        413: "request too large (set Highres fix lower or use fewer reference layers)",
        429: "rate limited",
        502: "the model's host failed; nothing was charged",
        503: "no host is available right now, or none meets the routing rules (Scumble leaves out hosts in China)",
        524: "timed out",
        529: "the host is overloaded",
    }[status];
    if (status === 402 && m.limit_source === "openrouter_key_limit") why = "this key's spending limit is reached (raise it at openrouter.ai/settings/keys, or wait for it to reset)";
    if (status === 402 && m.limit_source === "openrouter_in_flight_budget") why = "recent paid requests are still settling on this account; wait a moment and try again (more credits raise this budget)";
    const policy = (Array.isArray(m.reasons) && m.reasons.length) || m.error_type === "content_policy_violation" || m.error_type === "refusal";
    if (status === 403 && policy) why = "refused by the content policy" + (Array.isArray(m.reasons) && m.reasons.length ? ` (${m.reasons.join(", ")})` : "");
    if (status === 503 && m.error_type === "provider_overloaded") why = "the model's hosts are overloaded; try again shortly";
    return why ? `${why} - ${message}` : message;
}

/**
 * The server's message and metadata from a failed answer: the documented { error: { code, message, metadata } },
 * or the schema check's { success: false, error: { name: "ZodError", message: "<JSON list of issues>" } }.
 */
async function readFailure(r) {
    let text = "";
    try { text = await r.text(); } catch (_) { text = ""; }
    let j = null;
    try { j = JSON.parse(text); } catch (_) { j = null; }
    const e = j && j.error;
    if (e && typeof e === "object") {
        let message = e.message != null ? String(e.message) : "";
        if (e.name === "ZodError") {
            try {
                const issues = JSON.parse(message);
                if (Array.isArray(issues)) message = issues.map((i) => `${(i.path || []).join(".") || "body"}: ${i.message}`).join("; ");
            } catch (_) { /* keep the raw text */ }
        }
        return { message: message || r.statusText || String(r.status), meta: e.metadata || {} };
    }
    if (typeof e === "string") return { message: e, meta: {} };
    return { message: text.slice(0, 300) || r.statusText || String(r.status), meta: {} };
}

async function failure(r, key) {
    const f = await readFailure(r);
    return scrub(explain(r.status, f.message, f.meta), key);
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

// ---- the hosts in China --------------------------------------------------------------------------------

const chinaCache = new Map();   // base -> Promise<string[]>, once per session

/** Slugs whose headquarters or datacentres OpenRouter lists as CN, merged with the dated list. */
function chinaHosts(ctx) {
    const base = root(ctx);
    if (!chinaCache.has(base)) {
        const p = (async () => {
            const out = new Set(CHINA_HOSTS);
            try {
                const r = await ctx.fetch(base + "/api/v1/providers", { signal: AbortSignal.timeout(PROVIDERS_TIMEOUT_MS) });
                if (!r.ok) throw new Error(`answered ${r.status}`);
                const j = (await r.json()) || {};
                for (const p of Array.isArray(j.data) ? j.data : []) {
                    const hq = String(p.headquarters || "").toUpperCase();
                    const dcs = Array.isArray(p.datacenters) ? p.datacenters.map((d) => String(d).toUpperCase()) : [];
                    if (p.slug && (hq === "CN" || dcs.includes("CN"))) out.add(String(p.slug));
                }
            } catch (err) {
                if (ctx.log) ctx.log(`the host list could not be read (${err && err.message || err}); leaving out the dated list of hosts in China`);
                chinaCache.delete(base);   // ask again next time
            }
            return [...out].sort();
        })();
        chinaCache.set(base, p);
    }
    return chinaCache.get(base);
}

// ---- pictures ------------------------------------------------------------------------------------------

/** [width, height] from a PNG's IHDR, or null for anything else. */
function pngSize(b) {
    if (!b || b.length < 24) return null;
    if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
    const v = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    return [v(16), v(20)];
}

const b64Length = (n) => 4 * Math.ceil(n / 3);

/**
 * The pictures of an edit or fill run, in order: the crop, the mask (fill only), the references. Checks the
 * count and the steepest ratio, and holds the inline size under MAX_INLINE by sending opaque pictures as JPEG,
 * largest first. The mask is never re-encoded. Throws before any request.
 */
async function picturesFor(req, o, ctx, model) {
    const pics = [{ what: "crop", bytes: Buffer.from(req.image), mime: "image/png", jpeg: true }];
    if (req.kind === "fill" && req.mask) pics.push({ what: "mask", bytes: Buffer.from(req.mask), mime: "image/png", jpeg: false });
    req.references.forEach((r, i) => pics.push({ what: `reference ${i + 1}`, bytes: Buffer.from(r), mime: "image/png", jpeg: true }));
    const max = +o.max_images > 0 ? +o.max_images : 16;
    if (pics.length > max) {
        const parts = [`the crop`, ...(pics.some((p) => p.what === "mask") ? ["the mask"] : []), `${req.references.length} reference${req.references.length === 1 ? "" : "s"}`];
        throw new Error(`OpenRouter ${model} takes at most ${max} picture${max === 1 ? "" : "s"}; this run has ${pics.length} (${parts.join(", ")}): turn Original off or hide reference layers.`);
    }
    if (+o.max_ratio > 0) {
        for (const p of pics) {
            const s = pngSize(p.bytes);
            if (s && Math.max(s[0], s[1]) > +o.max_ratio * Math.min(s[0], s[1]) + 1e-9) {
                throw new Error(`OpenRouter ${model} takes pictures no steeper than ${o.max_ratio}:1; the ${p.what} is ${s[0]} × ${s[1]}. Use a less narrow selection or reference layer.`);
            }
        }
    }
    let total = pics.reduce((n, p) => n + b64Length(p.bytes.length), 0);
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
            throw new Error(`OpenRouter ${model}: the pictures come to ${(total / 1e6).toFixed(1)} MB, more than the ${MAX_INLINE / 1e6} MB this app sends in one request. Set Highres fix lower, turn Original off, or use fewer or smaller reference layers.`);
        }
    }
    return pics;
}

// ---- the request ---------------------------------------------------------------------------------------

/** The smallest tier whose base covers the long side, else the largest; null without tiers. */
function tierFor(w, h, tiers) {
    const rows = Object.entries(tiers || {}).map(([k, v]) => [k, +v]).filter(([, v]) => v > 0).sort((a, b) => a[1] - b[1]);
    if (!rows.length) return null;
    const long = Math.max(w, h);
    for (const [k, v] of rows) if (v >= long) return k;
    return rows[rows.length - 1][0];
}

/** The aspect_ratio of a text run: the asked one when it is a preset, else the closest preset. */
function aspectFor(req, o) {
    const ratios = Array.isArray(o.ratios) ? o.ratios.filter((r) => r && r !== "auto") : [];
    if (!ratios.length) return null;
    if (req.aspect && ratios.includes(req.aspect)) return req.aspect;
    const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(req.aspect || ""));
    if (m && +m[1] > 0 && +m[2] > 0) return closestAspect(+m[1], +m[2], ratios);
    return closestAspect(Math.max(1, +req.width || 1024), Math.max(1, +req.height || 1024), ratios);
}

function promptFor(req, pics) {
    const text = String(req.prompt || "");
    if (req.kind === "text") return text;
    const refs = pics.filter((p) => p.what.startsWith("reference")).length;
    let out = pics.some((p) => p.what === "mask")
        ? `Edit the first image. The second image is a mask: change only the white area of the mask, keep everything else exactly as it is, and keep the image size and framing. ${text}`
        : `Edit the first image and keep its size and framing. ${text}`;
    if (refs) out += ` The remaining image${refs > 1 ? "s are" : " is"} reference material.`;
    return out.trim();
}

/** The JSON body of one request; `pics` are the pictures of an edit (none for a text run), `ignore` the hosts left out. */
function bodyFor(req, pics, ignore) {
    const o = req.options || {};
    const p = req.params || {};
    const accepts = new Set(Array.isArray(o.accepts) ? o.accepts : []);
    const body = { model: String(req.model || ""), prompt: promptFor(req, pics) };
    for (const [k, v] of [...Object.entries(p)]) {
        if (!PARAMS.includes(k) || !accepts.has(k) || v === "" || v == null || String(v).toLowerCase() === "auto") continue;
        body[k] = v;
    }
    // only PNG and WebP carry an alpha channel
    if (String(body.background || "").toLowerCase() === "transparent" && body.output_format && !/^(png|webp)$/i.test(body.output_format)) body.output_format = "png";
    const w = Math.max(1, +req.width || 1024), h = Math.max(1, +req.height || 1024);
    if (accepts.has("resolution") && body.resolution == null) {
        const tier = tierFor(w, h, o.tiers);
        if (tier) body.resolution = tier;
    }
    if (req.kind === "text" && accepts.has("aspect_ratio") && body.aspect_ratio == null) {
        const a = aspectFor(req, o);
        if (a) body.aspect_ratio = a;
    }
    if (accepts.has("seed") && req.seed != null && !p.random_seed) body.seed = Number(req.seed) >>> 0;
    if (accepts.has("n")) body.n = 1;
    if (pics.length) body.input_references = pics.map((x) => ({ type: "image_url", image_url: { url: `data:${x.mime};base64,${x.bytes.toString("base64")}` } }));
    const provider = {};
    if (ignore && ignore.length) provider.ignore = [...ignore];
    const only = o.only_for && body.resolution != null ? o.only_for[body.resolution] : null;
    if (Array.isArray(only) && only.length) provider.only = only.map(String);
    if (Object.keys(provider).length) body.provider = provider;
    return body;
}

async function post(ctx, body) {
    const headers = { Authorization: "Bearer " + ctx.key, "Content-Type": "application/json" };
    const send = () => ctx.fetch(root(ctx) + "/api/v1/images", { method: "POST", headers, body: JSON.stringify(body) });
    let r = await send();
    // a 429, a 529, a 503 with Retry-After (an overloaded host) or a 402 of the in-flight budget means nothing was
    // generated and nothing charged, so one retry is safe, never before the time the server set; a network error
    // is never retried (an answer lost on the way could be a second paid image)
    const header = !!(r.headers && r.headers.get && r.headers.get("retry-after"));
    let inflight = false;
    if (r.status === 402 && header) {
        const peek = await r.clone().json().catch(() => null);
        inflight = !!(peek && peek.error && peek.error.metadata && peek.error.metadata.limit_source === "openrouter_in_flight_budget");
    }
    if (r.status === 429 || r.status === 529 || (r.status === 503 && header) || inflight) {
        const ms = retryAfterMs(r);
        if (ms > RETRY_WAIT_MAX_MS) {
            r.waitSeconds = Math.ceil(ms / 1000);   // run() says when to try again
            return r;
        }
        ctx.log(`answered ${r.status}, sending once more after ${ms} ms`);
        await ctx.sleep(ms);
        r = await send();
        // no third request: a second refusal that names a wait is passed on as "try again in N s"
        if (!r.ok) {
            const again = retryAfterMs(r, 0);
            if (again > 0) r.waitSeconds = Math.ceil(again / 1000);
        }
    }
    return r;
}

async function run(req, ctx) {
    // ctx.sleep is injectable so tools/openrouter_test.js waits in milliseconds
    ctx = { ...ctx, sleep: ctx.sleep || realSleep, log: ctx.log || (() => {}) };
    const model = String(req.model || "");
    if (!model) throw new Error("OpenRouter recipe has no model id.");
    const base = root(ctx);
    checkKey(base, ctx.key);
    const o = req.options || {};
    req = { ...req, references: req.kind === "text" ? [] : (req.references || []) };
    if (req.kind === "text" && !String(req.prompt || "").trim()) throw new Error(`OpenRouter ${model}: a new image needs a prompt.`);
    if (req.kind !== "text" && !req.image) throw new Error(`OpenRouter ${model}: no crop to edit.`);
    const pics = req.kind === "text" ? [] : await picturesFor(req, o, ctx, model);
    const ignore = await chinaHosts(ctx);
    const body = bodyFor(req, pics, ignore);
    const r = await post(ctx, body);
    if (!r.ok) throw new Error(`OpenRouter ${model}: ${await failure(r, ctx.key)}${r.waitSeconds ? `; try again in ${r.waitSeconds} s` : ""}`);
    const j = (await r.json()) || {};
    if (j.error) throw new Error(`OpenRouter ${model}: ${scrub(explain(+j.error.code || 0, j.error.message || "error", j.error.metadata), ctx.key)}`);
    const item = Array.isArray(j.data) ? j.data.find((d) => d && d.b64_json) : null;
    if (!item) throw new Error(`OpenRouter ${model}: no image in the answer (${scrub(JSON.stringify(j).slice(0, 200), ctx.key)})`);
    const usage = j.usage || {};
    return {
        bytes: Buffer.from(item.b64_json, "base64"),
        mime: item.media_type || "image/png",
        seed: body.seed != null ? body.seed : req.seed,
        info: {
            model, resolution: body.resolution || null, aspect_ratio: body.aspect_ratio || null,
            pictures: pics.map((x) => `${x.what} ${x.mime === "image/jpeg" ? "jpeg" : "png"}`),
            cost: usage.cost != null ? usage.cost : null,
        },
    };
}

module.exports = {
    label: "OpenRouter",
    keyUrl: "https://openrouter.ai/settings/keys",
    keyHint: "sk-or-v1-... from openrouter.ai › Settings › API keys",
    edit: run,
    generate: run,   // kind "text": the same endpoint without input_references

    /**
     * GET /api/v1/key: what this key may still spend. It reports the key's own limit, not the account's credits
     * (those need a management key, which cannot make images), so an unlimited key shows what it has used.
     */
    async balance(ctx) {
        const base = root(ctx);
        checkKey(base, ctx.key);
        const r = await ctx.fetch(base + "/api/v1/key", { headers: { Authorization: "Bearer " + ctx.key }, signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS) });
        if (!r.ok) throw new Error(`OpenRouter key check: ${await failure(r, ctx.key)}`);
        const d = ((await r.json()) || {}).data || {};
        const num = (v) => v != null && v !== "" && Number.isFinite(Number(v));
        const money = (v) => `$${Number(v).toFixed(2)}`;
        const byok = !!d.include_byok_in_limit;
        const tail = "the account's credits are on openrouter.ai/credits";
        if (num(d.limit_remaining)) {
            // a limit that resets counts what was spent in its period, BYOK spending too when the key includes it;
            // for a reset this table does not know, no "used" figure rather than the all-time one
            const PERIOD = { daily: ["usage_daily", "byok_usage_daily", "today"], weekly: ["usage_weekly", "byok_usage_weekly", "this week"], monthly: ["usage_monthly", "byok_usage_monthly", "this month"] };
            const reset = d.limit_reset == null ? null : String(d.limit_reset);
            const per = reset ? PERIOD[reset] : null;
            let used = "";
            if (!reset && num(d.usage)) used = `${money(+d.usage + (byok && num(d.byok_usage) ? +d.byok_usage : 0))} used`;
            else if (per && num(d[per[0]])) used = `${money(+d[per[0]] + (byok && num(d[per[1]]) ? +d[per[1]] : 0))} used ${per[2]}`;
            const limit = num(d.limit) ? ` ${money(d.limit)}` : "";
            return { usd: Number(d.limit_remaining), note: `of this key's${limit}${per ? ` ${reset}` : ""} limit${used ? `, ${used}` : ""}; ${tail}` };
        }
        return { usd: null, note: `no spending limit on this key${num(d.usage) ? `, ${money(d.usage)} used in all` : ""}; ${tail}` };
    },

    baseUrl,
    checkKey,
    chinaHosts,
    // llm.js: a failed chat request on the OpenRouter key is read and put in the same words
    explain,
    readFailure,
    // providers/oxen.js: the same mask and reference sentences for a model without a mask input
    promptFor,
    // exported for tools/openrouter_test.js
    _allowedBase: allowedBase,
    _body: bodyFor,
    _pictures: picturesFor,
    _tier: tierFor,
    _aspect: aspectFor,
    _failure: failure,
    _resetHosts: () => chinaCache.clear(),
    CHINA_HOSTS,
    MAX_INLINE,
};
