// Magnific (Freepik's API for the Magnific upscalers). Written from its API reference
// (docs.magnific.com, the same pages as docs.freepik.com; read 2026-09-22); nothing here has run against the live
// API yet (docs/RECIPES.md "Magnific" lists what only a real key can verify).
//
//   POST <base>/v1/ai/image-upscaler-precision-v2   JSON { image: base64, scale_factor: 2..16 (integer),
//                                                   sharpen, smart_grain, ultra_detail, flavor }
//   POST <base>/v1/ai/image-upscaler                 JSON { image: base64, scale_factor: "2x"|"4x"|"8x"|"16x",
//                                                   prompt, creativity, hdr, resemblance, fractality,
//                                                   optimized_for, engine }
//        -> { data: { task_id, status: "CREATED", generated: [] } }
//   GET  <the same path>/<task_id>                   -> { data: { task_id, status, generated: [url, ...] } }
//        status CREATED | IN_PROGRESS | COMPLETED | FAILED
//
// Header `x-magnific-api-key`. Every call is an asynchronous task, polled here until it is done (never a
// webhook: the app has no public address). The picture goes in as plain base64, the answer is fetched from the
// URL in `generated`. Every API call costs credits, whatever the web plan says. Creative's output may not exceed
// 25.3 million pixels; the adapter refuses a request that would, before sending it.
//
// A recipe variant names the route in `model` ("image-upscaler-precision-v2" or "image-upscaler") and the
// factor's form in `options.factor`: "int" (precision, the number) or "x" (creative, "4x").
//
// The host is https://api.magnific.com, never a URL from a recipe; settings.magnific.base may name a loopback
// mock for the tests, and then only a key that starts with "test-" goes there, while such a key never goes to
// Magnific.
"use strict";

const { fetchImage, sleep: realSleep } = require("./util");

const HOST = "https://api.magnific.com";
const ROUTES = new Set(["image-upscaler-precision-v2", "image-upscaler"]);
const CREATIVE_MAX_PIXELS = 25300000;
const POLL_MS = 3000;
const WAIT_MS = 30 * 60 * 1000;
const RETRY_WAIT_MS = 5000;
const RETRY_WAIT_MAX_MS = 60000;

/** http://127.0.0.1:<port> (the test mock) or null: the only base a setting may name. */
function testBase(value) {
    if (!value) return null;
    let u;
    try { u = new URL(String(value).trim()); } catch (_) { return null; }
    if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) return null;
    if (u.protocol === "http:" && u.hostname === "127.0.0.1" && u.port) return `${u.protocol}//${u.host}`;
    return null;
}

/** settings.magnific.base when it is the loopback mock, else null (the real host). */
function baseUrl(settings) {
    const s = (settings && settings.magnific) || {};
    return testBase(s.base);
}

/** A test key goes only to the mock, a real key never there. Throws before any request. */
function checkKey(test, key) {
    const isTest = /^test-/.test(String(key || ""));
    if (test && !isTest) throw new Error("Magnific: the host is set to a test address (settings.magnific.base), and only a test key goes there; clear the setting to use a real key.");
    if (!test && isTest) throw new Error("Magnific: a test key is never sent to Magnific; store a real key under Settings › API providers.");
}

function scrub(text, key) {
    let s = String(text == null ? "" : text);
    if (key && key.length >= 6) s = s.split(key).join("[key]");
    return s;
}

/** [width, height] from a PNG's IHDR, or null for anything else. */
function pngSize(b) {
    if (!b || b.length < 24) return null;
    if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
    const v = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    return [v(16), v(20)];
}

/** The factor as the route takes it: an integer 2..16 (precision) or one of "2x", "4x", "8x", "16x" (creative). */
function factorFor(route, factor, form) {
    const f = Math.round(+factor || 2);
    if ((form || (route === "image-upscaler" ? "x" : "int")) === "x") {
        if (![2, 4, 8, 16].includes(f)) throw new Error(`Magnific Creative upscales by 2, 4, 8 or 16, not ${factor}.`);
        return `${f}x`;
    }
    if (f < 2 || f > 16) throw new Error(`Magnific Precision upscales by 2 to 16, not ${factor}.`);
    return f;
}

/** The request body: the picture, the factor, the variant's settings, the prompt where the route takes one. */
function bodyFor(req, route) {
    const o = req.options || {};
    const body = { image: Buffer.from(req.image).toString("base64"), scale_factor: factorFor(route, req.factor, o.factor) };
    for (const [k, v] of Object.entries(req.params || {})) {
        if (k === "random_seed" || v === "" || v == null) continue;
        body[k] = v;
    }
    if (route === "image-upscaler" && req.prompt) body.prompt = String(req.prompt);
    return body;
}

/** What a failed answer means ({ message } or { problem: { message, invalid_params } }), the key taken out. */
async function readFailure(r, key) {
    let text = "";
    try { text = await r.text(); } catch (_) { text = ""; }
    text = scrub(text, key);
    let msg = "";
    try {
        const j = JSON.parse(text);
        const p = j && j.problem;
        if (p && typeof p === "object") {
            const bad = Array.isArray(p.invalid_params) ? p.invalid_params.map((x) => x && (x.name + (x.reason ? ": " + x.reason : ""))).filter(Boolean) : [];
            msg = String(p.message || "invalid request") + (bad.length ? ` (${bad.join("; ")})` : "");
        } else if (j && (j.message || j.detail || j.error)) {
            const m = j.message || j.detail || j.error;
            msg = typeof m === "string" ? m : JSON.stringify(m);
        }
    } catch (_) { /* not JSON */ }
    if (!msg) msg = text.slice(0, 300) || r.statusText || String(r.status);
    const why = r.status === 401 ? "key refused" : r.status === 402 ? "no credits left on the Magnific account" : r.status === 429 ? "rate limited" : r.status === 400 ? "request refused" : r.status >= 500 ? "the service failed" : "";
    return why ? `${why} - ${msg}` : msg;
}

function retryAfterMs(r, fallback = RETRY_WAIT_MS) {
    const v = r.headers && r.headers.get && r.headers.get("retry-after");
    if (v == null || v === "") return fallback;
    const n = Number(v);
    if (Number.isFinite(n)) return Math.max(0, n * 1000);
    const at = Date.parse(v);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : fallback;
}

/**
 * A request with one retry for a rate limit or an unavailable service (nothing was made, so nothing is billed),
 * never before the time the server set and not at all past a minute. A network error is never retried.
 */
async function send(ctx, url, init) {
    let r = await ctx.fetch(url, init);
    if (r.status === 429 || r.status === 503) {
        const ms = retryAfterMs(r);
        if (ms > RETRY_WAIT_MAX_MS) { r.waitSeconds = Math.ceil(ms / 1000); return r; }
        ctx.log(`answered ${r.status}, sending once more after ${ms} ms`);
        await ctx.sleep(ms);
        r = await ctx.fetch(url, init);
    }
    return r;
}

async function upscale(req, ctx) {
    // ctx.sleep and ctx.now are injectable so tools/upscale_test.js waits in milliseconds
    ctx = { ...ctx, sleep: ctx.sleep || realSleep, log: ctx.log || (() => {}), now: ctx.now || Date.now };
    const route = String(req.model || "").replace(/^\/+|\/+$/g, "").replace(/^v1\/ai\//, "");
    if (!ROUTES.has(route)) throw new Error(`Magnific: no upscaler route "${route}" (${[...ROUTES].join(", ")}).`);
    if (!req.image) throw new Error("Magnific: no picture to upscale.");
    const test = testBase(ctx.base);
    checkKey(!!test, ctx.key);
    const host = test || HOST;
    const body = bodyFor(req, route);
    const size = pngSize(Buffer.from(req.image));
    const f = Math.round(+req.factor || 2);
    if (route === "image-upscaler" && size && size[0] * f * size[1] * f > CREATIVE_MAX_PIXELS) {
        throw new Error(`Magnific Creative: ${size[0]} × ${size[1]} at ${f}x would be ${Math.round(size[0] * f * size[1] * f / 1e6)} MP, over its 25.3 MP cap; pick a smaller factor or a smaller selection.`);
    }
    const headers = { "x-magnific-api-key": ctx.key, "Content-Type": "application/json" };
    const url = `${host}/v1/ai/${route}`;
    const r = await send(ctx, url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(scrub(`Magnific ${route}: ${await readFailure(r, ctx.key)}${r.waitSeconds ? `; try again in ${r.waitSeconds} s` : ""}`, ctx.key));
    const first = (await r.json()) || {};
    let task = first.data || {};
    const id = String(task.task_id || "");
    if (!id) throw new Error(scrub(`Magnific ${route}: no task id in the answer (${JSON.stringify(first).slice(0, 200)})`, ctx.key));
    if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) throw new Error(`Magnific ${route}: an unexpected task id.`);
    const t0 = ctx.now();
    while (task.status !== "COMPLETED") {
        if (task.status === "FAILED") throw new Error(`Magnific ${route}: the task failed (${id}).`);
        if (ctx.now() - t0 > WAIT_MS) throw new Error(`Magnific ${route}: no answer after ${Math.round(WAIT_MS / 60000)} minutes (task ${id}).`);
        await ctx.sleep(POLL_MS);
        const s = await send(ctx, `${url}/${id}`, { headers: { "x-magnific-api-key": ctx.key } });
        if (!s.ok) throw new Error(scrub(`Magnific ${route} status: ${await readFailure(s, ctx.key)}`, ctx.key));
        task = ((await s.json()) || {}).data || {};
    }
    const out = Array.isArray(task.generated) ? task.generated.find((u) => typeof u === "string" && u) : null;
    if (!out) throw new Error(`Magnific ${route}: the task is done but names no picture (${id}).`);
    // the picture is fetched without the key: a generated URL is a public file, and the key never leaves for another host
    const file = await fetchImage(out, ctx.fetch);
    return { bytes: file.bytes, mime: file.mime, seed: req.seed, info: { model: route, task: id, factor: body.scale_factor } };
}

module.exports = {
    label: "Magnific",
    keyUrl: "https://www.magnific.com/user/organization/api-keys",
    keyHint: "API key from Magnific's organization settings (every API call costs credits)",
    upscale,
    baseUrl,
    // exported for tools/upscale_test.js
    _testBase: testBase,
    _body: bodyFor,
    _factor: factorFor,
    HOST,
    CREATIVE_MAX_PIXELS,
};
