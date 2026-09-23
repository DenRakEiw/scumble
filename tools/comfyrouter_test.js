// The Comfy Router adapter (electron/main/providers/comfyrouter.js), its recipe variants and its wiring in
// providers/index.js, in plain Node, no Electron and no key:
//   node tools/comfyrouter_test.js
// A scripted fetch plays api.comfy.org and the loopback mock: the queue (submit, status, result, cancel), the
// synchronous route and the asset links the answers name; ctx.sleep records its waits instead of waiting and ctx.uuid
// hands out known Idempotency-Keys. Every body the adapter builds is checked against the model's own published input
// schema (tools/refs/comfyrouter/, the documents under docs.comfy.org/router-schemas/ as downloaded on 2026-09-23):
// every field is one the schema names, every required field is there, every enum and bound holds. The last checks say
// that no call carried a header beyond the three the queue takes, that no asset download carried the key, and that
// the key is in no error of the run. Nothing here talks to the live API.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const router = require(path.join(ROOT, "electron", "main", "providers", "comfyrouter.js"));
const partner = require(path.join(ROOT, "electron", "main", "providers", "comfypartner.js"));

const KEY = "test-comfyrouter-0123456789";
const REAL_KEY = "comfyui-0f1e2d3c4b5a69788796a5b4c3d2e1f0aabbccdd";   // the shape of a Comfy key; never a real one
const BASE = "http://127.0.0.1:5557";
const LIVE = "https://api.comfy.org";
const RID = "6f1a1a6e-6a53-4a5f-9d3a-2b3b0a1f9c21";
const REFS = path.join(ROOT, "tools", "refs", "comfyrouter");
const ALL_CALLS = [];
const ERRORS = [];

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 500 ? s.slice(0, 500) + " ..." : s; };

/** A PNG as far as the adapter looks: the signature, a real IHDR, padding and a tag. */
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
const RESULT = pngOf(1024, 768, 80, "RESULT");
const DRAFT = pngOf(1024, 768, 80, "DRAFT");
const ASSET = pngOf(1024, 768, 80, "ASSET");
const fromDataUrl = (url) => { const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(url || "")); return m ? { mime: m[1], bytes: Buffer.from(m[2], "base64") } : null; };

// ---- the published schemas, and a validator for what the bodies use of JSON Schema --------------------------------

function schemaOf(modelId) {
    const doc = JSON.parse(fs.readFileSync(path.join(REFS, modelId.replace("/", "_") + ".json"), "utf8"));
    const op = Object.values(Object.values(doc.paths)[0])[0];
    return { doc, schema: Object.values(op.requestBody.content)[0].schema };
}
function deref(doc, s) {
    let n = 0;
    while (s && s.$ref && n++ < 30) s = s.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o && o[k], doc);
    return s;
}
/** Problems of `v` against `s` ([] when it holds). Unknown fields count as problems: the bodies stay inside the schema. */
function validate(doc, s, v, at = "body") {
    s = deref(doc, s);
    if (!s) return [];
    const out = [];
    if (s.allOf) for (const x of s.allOf) out.push(...validate(doc, x, v, at));
    for (const k of ["anyOf", "oneOf"]) {
        if (!s[k]) continue;
        const alts = s[k].map((x) => validate(doc, x, v, at));
        if (!alts.some((p) => !p.length)) out.push(`${at}: matches none of ${k} (${short(alts.map((p) => p[0]))})`);
    }
    if (v === null) return s.nullable || s.type === "null" ? out : out.concat(s.type ? [`${at}: null`] : []);
    const t = s.type;
    const is = { string: typeof v === "string", integer: Number.isInteger(v), number: typeof v === "number", boolean: typeof v === "boolean", array: Array.isArray(v), object: v && typeof v === "object" && !Array.isArray(v) };
    if (t && !is[t]) return out.concat([`${at}: not ${t} (${short(v)})`]);
    if (s.enum && !s.enum.includes(v)) out.push(`${at}: ${short(v)} not in ${short(s.enum)}`);
    if (typeof v === "number") {
        if (s.minimum != null && v < s.minimum) out.push(`${at}: ${v} < ${s.minimum}`);
        if (s.maximum != null && v > s.maximum) out.push(`${at}: ${v} > ${s.maximum}`);
    }
    if (Array.isArray(v)) {
        if (s.minItems != null && v.length < s.minItems) out.push(`${at}: ${v.length} items < ${s.minItems}`);
        if (s.maxItems != null && v.length > s.maxItems) out.push(`${at}: ${v.length} items > ${s.maxItems}`);
        if (s.items) v.forEach((x, i) => out.push(...validate(doc, s.items, x, `${at}[${i}]`)));
    }
    if (is.object && (s.properties || s.type === "object")) {
        const props = s.properties || {};
        for (const r of s.required || []) if (!(r in v)) out.push(`${at}: missing ${r}`);
        for (const [k, x] of Object.entries(v)) {
            if (props[k]) out.push(...validate(doc, props[k], x, `${at}.${k}`));
            else if (s.properties && !s.allOf && !s.anyOf && !s.oneOf && s.additionalProperties !== true) out.push(`${at}: unknown field ${k}`);
        }
    }
    return out;
}
function schemaProblems(modelId, body) {
    const { doc, schema } = schemaOf(modelId);
    return validate(doc, schema, body);
}

// ---- a fake Comfy Router ------------------------------------------------------------------------------------------

function recordHeaders(init) {
    const h = {};
    for (const [k, v] of new Headers((init && init.headers) || {})) h[k.toLowerCase()] = v;
    return h;
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const routerError = (status, type, detail, extra = {}, headers = {}) => json(status, { detail, error_type: type, ...extra }, { "x-comfy-error-type": type, "x-comfy-request-id": "req-err", ...headers });

/** The model's native answer, as the result read returns it; asset links point at the host that was asked. */
function nativeAnswer(prov, body, host) {
    const asset = (name) => `${host}/asset/${name}`;
    switch (prov) {
        case "openai": return { created: 1789000000, data: [{ b64_json: RESULT.toString("base64"), revised_prompt: "rev" }], output_format: body.output_format || "png", size: body.size, quality: "high", background: "opaque" };
        case "vertexai": return { candidates: [{ content: { role: "model", parts: [{ text: "thinking", thought: true }, { inlineData: { mimeType: "image/png", data: DRAFT.toString("base64") }, thought: true }, { inlineData: { mimeType: "image/png", data: RESULT.toString("base64") } }] }, finishReason: "STOP" }] };
        case "bfl": return { id: "bfl-1", status: "Ready", result: { sample: asset("bfl.png"), seed: 2784347701 } };
        case "byteplus": return { model: "seedream", created: 1789000000, data: [{ b64_json: RESULT.toString("base64"), size: body.size }], usage: { generated_images: 1 } };
        case "qwen": return { output: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: [{ image: asset("qwen.png") }] } }] }, usage: { output_image_count: 1 }, request_id: "q-1" };
        case "freepik": return { data: { task_id: RID, status: "COMPLETED", generated: [asset("freepik.png")] } };
        case "xai": return { data: [{ url: asset("xai.jpg"), mime_type: "image/jpeg" }] };
        case "ideogram": return { created: "2026-09-23T10:00:00Z", data: [{ url: asset("ideogram.png"), seed: 5, resolution: body.resolution, is_image_safe: true }] };
        case "krea": return { job_id: RID, created_at: "2026-09-23T10:00:00Z", completed_at: "2026-09-23T10:00:09Z", status: "completed", result: { urls: [asset("krea.png")] } };
        default: return {};
    }
}

/**
 * `submit` / `status` / `result` / `sync` answer their route in order (functions of (body, call) returning a Response,
 * or throwing for a network error); when a list runs out the route answers normally: 201 on submit, IN_PROGRESS then
 * COMPLETED on status (Retry-After 1), the native answer on the result read. Any host answers.
 */
function fakeServer(opts = {}) {
    const calls = [], submits = [], syncs = [], statuses = [], reads = [], cancels = [], assets = [];
    const storage = [], uploads = [], hy = [];   // the Partner API: storage requests, signed uploads, HY Image runs
    const q = { submit: [...(opts.submit || [])], status: [...(opts.status || [])], result: [...(opts.result || [])], sync: [...(opts.sync || [])], storage: [...(opts.storage || [])], hy: [...(opts.hy || [])] };
    let polled = 0;
    const bodies = new Map();
    async function fetch(url, init = {}) {
        const method = String(init.method || "GET").toUpperCase();
        const call = { url: String(url), method, headers: recordHeaders(init) };
        calls.push(call);
        ALL_CALLS.push(call);
        const u = new URL(String(url));
        const host = `${u.protocol}//${u.host}`;
        if (u.pathname.startsWith("/asset/")) { assets.push(call); return opts.asset ? opts.asset(call) : new Response(ASSET, { status: 200, headers: { "content-type": "image/png" } }); }
        if (method === "POST" && u.pathname === "/customers/storage") {
            const body = JSON.parse(init.body);
            storage.push({ ...call, body });
            const a = q.storage.shift();
            if (a) return a(body, call);
            const n = storage.length;
            return json(200, { upload_url: `${host}/upload/${n}?sig=abc`, download_url: `${host}/stored/${n}.png?sig=def` });
        }
        if (method === "PUT" && u.pathname.startsWith("/upload/")) { uploads.push({ ...call, bytes: Buffer.from(init.body) }); return new Response(null, { status: 200 }); }
        if (method === "POST" && u.pathname === partner.HY_PATH) {
            const body = JSON.parse(init.body);
            hy.push({ ...call, body });
            const a = q.hy.shift();
            if (a) return a(body, call);
            return json(200, { choices: [{ delta: { image: { url: `${host}/asset/hy.png`, width: 1024, height: 768 } }, finish_reason: "stop" }], request_id: "hy-1" });
        }
        const m = /^\/v2\/models\/([^/]+)\/([^/]+)(\/requests(?:\/([^/]+)(\/status|\/cancel)?)?)?$/.exec(u.pathname);
        if (!m) return routerError(404, "model_not_found", "no route " + u.pathname);
        const [, prov, model, queue, id, tail] = m;
        call.model = `${prov}/${model}`;
        if (method === "POST" && !queue) {
            const body = JSON.parse(init.body);
            syncs.push({ ...call, body });
            const a = q.sync.shift();
            if (a) return a(body, call);
            return json(200, nativeAnswer(prov, body, host), { "x-comfy-request-id": "sync-1", "x-comfy-credits-used": "3.5" });
        }
        if (method === "POST" && queue === "/requests") {
            const body = JSON.parse(init.body);
            submits.push({ ...call, body });
            bodies.set(RID, { prov, body, host });
            const a = q.submit.shift();
            if (a) return a(body, call);
            return json(201, { request_id: RID, status: "IN_QUEUE", queue_position: 2, status_url: `https://evil.example/status`, response_url: `https://evil.example/result`, cancel_url: `https://evil.example/cancel` }, { "x-comfy-request-id": RID });
        }
        if (method === "GET" && tail === "/status") {
            statuses.push(call);
            const a = q.status.shift();
            if (a) return a(null, call);
            polled++;
            return json(200, { request_id: id, status: polled % 2 ? "IN_PROGRESS" : "COMPLETED", queue_position: 0 }, { "retry-after": "1" });
        }
        if (method === "GET" && id && !tail) {
            reads.push(call);
            const a = q.result.shift();
            if (a) return a(null, call);
            const b = bodies.get(id) || { prov, body: {}, host };
            return json(200, nativeAnswer(b.prov, b.body, b.host), { "x-comfy-request-id": id, "x-comfy-credits-used": "12.25", ...(opts.resultHeaders || {}) });
        }
        if (method === "PUT" && tail === "/cancel") { cancels.push(call); return json(202, { request_id: id, status: "CANCELLATION_REQUESTED" }); }
        return routerError(404, "request_not_found", "no such request");
    }
    return { fetch, calls, submits, syncs, statuses, reads, cancels, assets, storage, uploads, hy };
}

function ctxFor(server, extra = {}) {
    const sleeps = [], logs = [], uuids = [];
    let n = 0;
    return {
        key: KEY, base: BASE, fetch: server.fetch, log: (m) => logs.push(String(m)), sleep: async (ms) => { sleeps.push(ms); },
        uuid: () => { const u = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; uuids.push(u); return u; },
        sleeps, logs, uuids, opaque: () => true, toJpeg: (b) => jpegOf(Math.min(b.length - 1, 2_000_000), "JPEG"), ...extra,
    };
}

const RECIPES = path.join(ROOT, "recipes");
const rawRecipe = (id) => JSON.parse(fs.readFileSync(path.join(RECIPES, id + ".json"), "utf8"));
const variant = (id) => rawRecipe(id).providers.comfyrouter;
const defaults = (v) => { const p = {}; for (const st of v.settings || []) p[st.key] = st.spec[1].default; return p; };

function editReq(v, extra = {}) {
    return {
        provider: "comfyrouter", model: v.model, kind: v.input === "edit" ? "edit" : "fill", options: v.options,
        prompt: "a red door", negative: "blurry", seed: 42,
        image: pngOf(1024, 768, 96, "CROP"), mask: pngOf(1024, 768, 96, "MASK-LUMINANCE"), maskAlpha: pngOf(1024, 768, 96, "MASK-ALPHA"),
        width: 1024, height: 768, references: [], params: defaults(v), ...extra,
    };
}
function textReq(v, extra = {}) {
    return {
        provider: "comfyrouter", model: v.model, kind: "text", options: v.options, prompt: "a lighthouse at dusk", negative: "", seed: 7,
        image: null, mask: null, maskAlpha: null, references: [], width: 1536, height: 1024, aspect: "3:2", params: defaults(v), ...extra,
    };
}
function upReq(v, extra = {}) {
    return { provider: "comfyrouter", model: v.model, kind: "upscale", options: v.options, prompt: "", seed: 1, image: pngOf(512, 512, 96, "UPSCALE"), factor: 4, width: 512, height: 512, references: [], params: defaults(v), ...extra };
}

async function section(name, fn) {
    try { await fn(); } catch (err) { check(name + " ran to its end", false, String(err && err.stack || err).split(/\r?\n/).slice(0, 3).join(" ")); }
}
async function throws(fn) {
    try { await fn(); } catch (err) { const m = String(err && err.message || err); ERRORS.push(m); return m; }
    return null;
}

// which recipe carries which Router model, and what kind of run it is
const VARIANTS = {
    gpt_image_2: "openai/gpt-image-2", gpt_image_2_5_flare: "openai/gpt-image-2.5-flare", gpt_image_2_5_sunburst: "openai/gpt-image-2.5-sunburst",
    nano_banana_2: "vertexai/gemini-3.1-flash-image", nano_banana_2_lite: "vertexai/gemini-3.1-flash-lite-image", nano_banana_pro: "vertexai/gemini-3-pro-image",
    flux2_pro: "bfl/flux-2-pro", flux2_max: "bfl/flux-2-max", flux1_fill: "bfl/flux-pro-1.0-fill",
    seedream_5_lite: "byteplus/seedream-5-0-260128", seedream_5_pro: "byteplus/seedream-5-0-pro-260628",
    qwen_image_edit: "qwen/qwen-image-3.0", magnific_precision: "freepik/ai-image-upscaler-precision-v2",
    krea_2: "krea/krea-2-large", grok_imagine: "xai/grok-imagine-image-2.0", ideogram_4: "ideogram/ideogram-v4",
};

async function main() {
    // ---- 1. the queue ----
    await section("1. the queue", async () => {
        const v = variant("gpt_image_2");
        const s = fakeServer();
        const ctx = ctxFor(s);
        const out = await router.edit(editReq(v), ctx);
        const root = `${BASE}/v2/models/openai/gpt-image-2`;
        check("one submit to /v2/models/openai/gpt-image-2/requests, then status reads and one result read", s.submits.length === 1 && s.submits[0].url === root + "/requests" && s.statuses.length === 2 && s.reads.length === 1 && s.syncs.length === 0, short(s.calls.map((c) => c.method + " " + c.url)));
        check("the status and result URLs are composed from the host and the request id, never the answer's (evil.example)", s.statuses.every((c) => c.url === `${root}/requests/${RID}/status`) && s.reads[0].url === `${root}/requests/${RID}` && !s.calls.some((c) => /evil/.test(c.url)));
        const h = s.submits[0].headers;
        check("the submit carries X-API-Key, Content-Type and a UUID Idempotency-Key, and nothing else", eq(Object.keys(h).sort(), ["content-type", "idempotency-key", "x-api-key"]) && h["x-api-key"] === KEY && h["idempotency-key"] === ctx.uuids[0] && /^[0-9a-f-]{36}$/.test(h["idempotency-key"]), short(h));
        check("the reads carry the key alone", [...s.statuses, ...s.reads].every((c) => eq(Object.keys(c.headers), ["x-api-key"]) && c.headers["x-api-key"] === KEY));
        check("the first poll waits 2 s (the submit names no Retry-After), the next the status read's Retry-After (1 s)", eq(ctx.sleeps, [2000, 1000]), short(ctx.sleeps));
        check("the answer: the b64 picture, the Router's request id and credits in info", tagOf(out.bytes) === "RESULT" && out.mime === "image/png" && out.info.request_id === RID && out.info.credits === 12.25 && out.info.model === "openai/gpt-image-2", short(out.info));

        const s2 = fakeServer({ result: [() => json(202, { request_id: RID, status: "IN_PROGRESS" }, { "retry-after": "3" })] });
        const c2 = ctxFor(s2);
        const o2 = await router.edit(editReq(v), c2);
        check("a result read that answers 202 goes back to polling (Retry-After 3 s) and collects later", tagOf(o2.bytes) === "RESULT" && s2.reads.length === 2 && c2.sleeps.includes(3000), short({ reads: s2.reads.length, sleeps: c2.sleeps }));

        const s3 = fakeServer({ status: [() => json(200, { request_id: RID, status: "IN_QUEUE", queue_position: 40 }, { "retry-after": "120" })] });
        const c3 = ctxFor(s3);
        await router.edit(editReq(v), c3);
        check("a long Retry-After while queued is capped at 15 s so a finished run is seen soon", c3.sleeps[0] === 1000 || c3.sleeps.includes(15000), short(c3.sleeps));

        let t = 0;
        const realNow = Date.now;
        const s4 = fakeServer({ status: Array.from({ length: 50 }, () => () => { t += 60000; return json(200, { request_id: RID, status: "IN_PROGRESS" }, { "retry-after": "5" }); }) });
        Date.now = () => realNow() + t;
        let e4;
        try { e4 = await throws(() => router.edit(editReq(v), ctxFor(s4))); } finally { Date.now = realNow; }
        check("after 15 minutes the run is given up and asked to stop (PUT .../cancel)", /no answer after 15 minutes/.test(e4 || "") && s4.cancels.length === 1 && s4.cancels[0].url === `${root}/requests/${RID}/cancel` && s4.cancels[0].method === "PUT", short({ e4, cancels: s4.cancels.length }));

        const flaky = Array.from({ length: 4 }, () => () => json(503, { detail: "busy", error_type: "service_unavailable" }));
        const s5 = fakeServer({ status: flaky });
        const o5 = await router.edit(editReq(v), ctxFor(s5));
        check("four failed status reads in a row are outlasted", tagOf(o5.bytes) === "RESULT", "");
        const s6 = fakeServer({ status: Array.from({ length: 5 }, () => () => json(503, { detail: "busy", error_type: "service_unavailable" })) });
        const e6 = await throws(() => router.edit(editReq(v), ctxFor(s6)));
        check("five are not", /temporarily unavailable/.test(e6 || "") && s6.reads.length === 0, e6);

        const s7 = fakeServer({ status: [() => json(200, { request_id: RID, status: "COMPLETED", error_type: "content_policy_violation" })], result: [() => routerError(400, "content_policy_violation", "The provider refused the request.")] });
        const e7 = await throws(() => router.edit(editReq(v), ctxFor(s7)));
        check("a run that completed with an error_type: the result read's error, in words", /content filter/.test(e7 || "") && /provider refused/.test(e7 || "") && s7.reads.length === 1, e7);

        const s8 = fakeServer({ submit: [() => json(201, { status: "IN_QUEUE" })] });
        const e8 = await throws(() => router.edit(editReq(v), ctxFor(s8)));
        check("a submit answer without a request id is an error, not a poll of nothing", /without a request id/.test(e8 || "") && s8.statuses.length === 0, e8);
    });

    // ---- 2. resends under one key, and the synchronous fallback ----
    await section("2. resends", async () => {
        const v = variant("nano_banana_2");
        const s = fakeServer({ submit: [
            () => routerError(409, "concurrency_limit_exceeded", "still admitting", {}, { "retry-after": "4" }),
            () => routerError(429, "rate_limited", "slow down", {}, { "retry-after": "2" }),
        ] });
        const ctx = ctxFor(s);
        const out = await router.edit(editReq(v), ctx);
        const keys = s.submits.map((c) => c.headers["idempotency-key"]);
        check("a 409 concurrency_limit_exceeded and a 429 are sent again after their Retry-After, under the same Idempotency-Key", tagOf(out.bytes) === "RESULT" && s.submits.length === 3 && new Set(keys).size === 1 && ctx.sleeps[0] === 4000 && ctx.sleeps[1] === 2000, short({ keys, sleeps: ctx.sleeps }));
        const s2 = fakeServer({ submit: [() => { throw new TypeError("fetch failed"); }] });
        const c2 = ctxFor(s2);
        await router.edit(editReq(v), c2);
        check("a submit whose answer was lost is sent again under the same key (the Router returns the first run)", s2.submits.length === 2 && s2.submits[0].headers["idempotency-key"] === s2.submits[1].headers["idempotency-key"], short(s2.submits.map((c) => c.headers["idempotency-key"])));
        const s3 = fakeServer({ submit: Array.from({ length: 3 }, () => () => routerError(429, "rate_limited", "slow down", {}, { "retry-after": "2" })) });
        const e3 = await throws(() => router.edit(editReq(v), ctxFor(s3)));
        check("three refusals end the run with the words and the wait", s3.submits.length === 3 && /rate limited/.test(e3 || "") && /try again in 2 s/.test(e3 || ""), e3);
        const s4 = fakeServer({ submit: [() => routerError(429, "rate_limited", "slow down", {}, { "retry-after": "90" })] });
        const e4 = await throws(() => router.edit(editReq(v), ctxFor(s4)));
        check("a Retry-After over 60 s is not waited out: the user is told when to try again", s4.submits.length === 1 && /try again in 90 s/.test(e4 || ""), e4);
        const s5 = fakeServer({ submit: [() => routerError(402, "insufficient_credits", "The workspace cannot fund the run.")] });
        const e5 = await throws(() => router.edit(editReq(v), ctxFor(s5)));
        check("402 insufficient_credits: said in words, not sent again", s5.submits.length === 1 && /no credits left/.test(e5 || "") && /cannot fund/.test(e5 || ""), e5);
        const s6 = fakeServer({ submit: [() => routerError(409, "invalid_input", "Idempotency-Key held for another request")] });
        const e6 = await throws(() => router.edit(editReq(v), ctxFor(s6)));
        check("409 invalid_input (a key held for another request) is not sent again", s6.submits.length === 1 && /request refused/.test(e6 || ""), e6);

        const s7 = fakeServer({ submit: [() => routerError(403, "not_enabled", "This caller cannot use the queue.")] });
        const c7 = ctxFor(s7);
        const o7 = await router.edit(editReq(v), c7);
        check("403 not_enabled on the queue: the same body once to the synchronous route, under a new key", tagOf(o7.bytes) === "RESULT" && s7.syncs.length === 1 && s7.syncs[0].url === `${BASE}/v2/models/vertexai/gemini-3.1-flash-image` && eq(s7.syncs[0].body, s7.submits[0].body) && s7.syncs[0].headers["idempotency-key"] !== s7.submits[0].headers["idempotency-key"] && o7.info.credits === 3.5, short({ syncs: s7.syncs.length, info: o7.info }));
        const s8 = fakeServer({ submit: [() => routerError(403, "not_enabled", "no queue")], sync: [() => routerError(403, "not_enabled", "Router is not switched on")] });
        const e8 = await throws(() => router.edit(editReq(v), ctxFor(s8)));
        check("not_enabled on both routes: the words say to make a key in a workspace", /not switched on for this key/.test(e8 || "") && /workspace/.test(e8 || "") && s8.syncs.length === 1, e8);
    });

    // ---- 3. errors in words ----
    await section("3. errors", async () => {
        const v = variant("seedream_5_pro");
        const cases = [
            [401, "unauthorized", "no key", /key refused/],
            [403, "forbidden", "not entitled", /may not run this model/],
            [404, "model_not_found", "no such model", /does not serve this model/],
            [413, "", "too big", /too large/],
            [503, "service_unavailable", "down", /temporarily unavailable/],
            [400, "something_new", "a new bucket", /Comfy Router failed \(something_new\)/],
        ];
        const bad = [];
        for (const [status, type, detail, want] of cases) {
            // three of each: a 503 is sent again (the same key) before it is believed
            const answer = () => (type ? routerError(status, type, detail) : json(status, { detail }));
            const s = fakeServer({ submit: [answer, answer, answer] });
            const e = await throws(() => router.edit(editReq(v), ctxFor(s)));
            if (!want.test(e || "") || !(e || "").includes(detail)) bad.push(`${status} ${type}: ${e}`);
        }
        check("every bucket reads as words with the server's own detail after them; an unknown bucket as internal_error with its name", !bad.length, bad.join("; "));
        const s = fakeServer({ submit: [() => json(422, { detail: [{ loc: ["body", "size"], msg: "total pixels out of range", type: "value_error" }, { loc: ["body", "image", 0], msg: "image too small", type: "image_too_small", ctx: { min_width: 14 } }] }, { "x-comfy-error-type": "invalid_input" })] });
        const e = await throws(() => router.edit(editReq(v), ctxFor(s)));
        check("a 422 names each field (size, image.0) and its reason", /request refused - size: total pixels out of range; image\.0: image too small/.test(e || ""), e);
        const s2 = fakeServer({ submit: [() => routerError(400, "invalid_input", "The provider refused the request.", { upstream_detail: "prompt too long" })] });
        const e2 = await throws(() => router.edit(editReq(v), ctxFor(s2)));
        check("upstream_detail is added as the provider's own reason", /the provider said: prompt too long/.test(e2 || ""), e2);
        const s3 = fakeServer({ submit: [() => routerError(400, "invalid_input", `bad key ${KEY} echoed`)] });
        const e3 = await throws(() => router.edit(editReq(v), ctxFor(s3)));
        check("a key the server echoes is taken out of the error", !!e3 && !e3.includes(KEY) && e3.includes("[key]"), e3);
        const s4 = fakeServer({ result: [() => json(200, { error: { code: "OutputImageSensitiveContentDetected", message: "flagged" } })] });
        const e4 = await throws(() => router.edit(editReq(v), ctxFor(s4)));
        check("a native answer without a picture: its own reason (Seedream's error code)", /no picture in the answer: OutputImageSensitiveContentDetected: flagged/.test(e4 || ""), e4);
    });

    // ---- 4. hosts and keys ----
    await section("4. hosts and keys", async () => {
        const v = variant("gpt_image_2");
        check("baseUrl takes settings.comfyrouter.base only as http://127.0.0.1:<port>", router.baseUrl({ comfyrouter: { base: BASE } }) === BASE && router.baseUrl({ comfyrouter: { base: "https://api.comfy.org" } }) === null && router.baseUrl({ comfyrouter: { base: "http://localhost:5557" } }) === null && router.baseUrl({ comfyrouter: { base: BASE + "/v2" } }) === null && router.baseUrl({ comfyrouter: { base: "http://u:p@127.0.0.1:5557" } }) === null && router.baseUrl({}) === null);
        const s = fakeServer();
        const e = await throws(() => router.edit(editReq(v), ctxFor(s, { key: REAL_KEY })));
        check("a real key is never sent to the test address", /only a test key goes there/.test(e || "") && s.calls.length === 0 && !(e || "").includes(REAL_KEY), e);
        const s2 = fakeServer();
        const e2 = await throws(() => router.edit(editReq(v), ctxFor(s2, { base: undefined })));
        check("a test key is never sent to api.comfy.org", /test key is never sent/.test(e2 || "") && s2.calls.length === 0, e2);
        const s3 = fakeServer();
        const o3 = await router.generate(textReq(variant("flux2_pro")), ctxFor(s3, { key: REAL_KEY, base: undefined }));
        check("a real key goes to https://api.comfy.org, and the asset link on Comfy's storage is fetched without it", s3.submits[0].url === `${LIVE}/v2/models/bfl/flux-2-pro/requests` && s3.submits[0].headers["x-api-key"] === REAL_KEY && s3.assets.length === 1 && eq(Object.keys(s3.assets[0].headers), []) && tagOf(o3.bytes) === "ASSET", short(s3.calls.map((c) => c.url)));
        const s4 = fakeServer({ result: [() => json(200, { id: "x", status: "Ready", result: { sample: "http://evil.example/a.png" } })] });
        const e4 = await throws(() => router.generate(textReq(variant("flux2_pro")), ctxFor(s4)));
        check("an asset link that is not https (and not the test host) is not fetched", /does not fetch/.test(e4 || "") && s4.assets.length === 0, e4);
        const e5 = await throws(() => router.edit(editReq(v, { model: "openai/../../x" }), ctxFor(fakeServer())));
        const e6 = await throws(() => router.edit(editReq(v, { model: "anthropic/claude-sonnet-5" }), ctxFor(fakeServer())));
        const e7 = await throws(() => router.edit(editReq(v, { model: "__proto__/x" }), ctxFor(fakeServer())));
        const s8 = fakeServer();
        const e8 = await throws(() => router.edit(editReq(v, { model: "constructor/x" }), ctxFor(s8)));
        check("a model id that is not provider/model, a family Scumble does not speak and a prototype name (__proto__, constructor) are refused before any call", /not a model id/.test(e5 || "") && /does not speak the input of anthropic/.test(e6 || "") && /does not speak|not a model id/.test(e7 || "") && /does not speak the input of constructor/.test(e8 || "") && s8.calls.length === 0, short([e5, e6, e7, e8]));
    });

    // ---- 5. pictures before any call ----
    await section("5. pictures", async () => {
        const v = variant("qwen_image_edit");
        const s = fakeServer();
        const refs = [pngOf(512, 512, 64, "R1"), pngOf(512, 512, 64, "R2"), pngOf(512, 512, 64, "R3")];
        const e = await throws(() => router.edit(editReq(v, { references: refs }), ctxFor(s)));
        check("more pictures than the model takes: refused before any call, with the count and the way out", /at most 3 pictures; this run has 4/.test(e || "") && /Original off/.test(e || "") && s.calls.length === 0, e);
        const e2 = await throws(() => router.edit(editReq(v, { image: pngOf(9000, 1000, 96, "CROP") }), ctxFor(s)));
        check("a picture steeper than the model's ratio (Qwen 8:1): refused before any call", /no steeper than 8:1/.test(e2 || "") && s.calls.length === 0, e2);
        const lite = variant("seedream_5_lite");
        const big = pngOf(3000, 2000, 10_000_001, "BIG", 2);
        const s3 = fakeServer();
        const o3 = await router.edit(editReq(lite, { image: big, width: 3000, height: 2000 }), ctxFor(s3));
        const p3 = fromDataUrl(s3.submits[0].body.image[0]);
        check("an opaque crop over Seedream Lite's 10 MB goes as JPEG", o3 && p3.mime === "image/jpeg" && tagOf(p3.bytes) === "JPEG", short(p3 && p3.mime));
        const s4 = fakeServer();
        const e4 = await throws(() => router.edit(editReq(lite, { image: big, width: 3000, height: 2000 }), ctxFor(s4, { opaque: () => false })));
        check("one with transparency stays PNG and is refused", /more than the 10 MB/.test(e4 || "") && /transparency/.test(e4 || "") && s4.calls.length === 0, e4);
        const gv = variant("gpt_image_2");
        const s5 = fakeServer();
        const e5 = await throws(() => router.edit(editReq(gv, { maskAlpha: pngOf(1024, 768, 4 * 1024 * 1024 + 1, "MASK") }), ctxFor(s5)));
        check("an OpenAI mask over 4 MB: refused before any call", /mask is 4\.0 MB, more than the 4 MB/.test(e5 || "") && s5.calls.length === 0, e5);
        const s6 = fakeServer();
        const e6 = await throws(() => router.edit(editReq(gv, { image: pngOf(4000, 3000, 26 * 1024 * 1024, "HUGE") }), ctxFor(s6, { opaque: () => false })));
        check("any picture over the Router's 25 MB: refused before any call", /more than the 25 MB/.test(e6 || "") && s6.calls.length === 0, e6);
        const s7 = fakeServer();
        const e7 = await throws(() => router.upscale(upReq(variant("magnific_precision"), { image: pngOf(8000, 8000, 26 * 1024 * 1024, "HUGE") }), ctxFor(s7)));
        check("an upscale picture over 25 MB: refused before any call", /more than the 25 MB/.test(e7 || "") && s7.calls.length === 0, e7);
        const e8 = await throws(() => router.edit(editReq(variant("krea_2")), ctxFor(fakeServer())));
        const e9 = await throws(() => router.generate(textReq(variant("magnific_precision")), ctxFor(fakeServer())));
        const e10 = await throws(() => router.upscale(upReq(variant("gpt_image_2")), ctxFor(fakeServer())));
        const e11 = await throws(() => router.generate(textReq(variant("gpt_image_2"), { prompt: "  " }), ctxFor(fakeServer())));
        check("a text-only model refuses an edit, an upscaler a prompt, an image model an upscale, a text run an empty prompt", /Generate new/.test(e8 || "") && /upscaler/.test(e9 || "") && /not an upscaler/.test(e10 || "") && /needs a prompt/.test(e11 || ""), short([e8, e9, e10, e11]));
    });

    // ---- 6. every variant: the recipe, and the bodies against the published schemas ----
    await section("6. recipes and schemas", async () => {
        const recipes = loadRecipes();
        const served = recipes.filter((r) => r.providers && r.providers.comfyrouter).map((r) => r.id).sort();
        check("sixteen shipped recipes carry a comfyrouter variant", eq(served, Object.keys(VARIANTS).sort()), served.join(", "));
        const bad = [];
        let bodies = 0;
        for (const r of recipes.filter((x) => x.providers && x.providers.comfyrouter)) {
            const raw = rawRecipe(r.id);
            const v = r.providers.comfyrouter;
            if (v.model !== VARIANTS[r.id]) bad.push(`${r.id}: model ${v.model}`);
            if (r.providerIds[r.providerIds.length - 1] !== "comfyrouter") bad.push(`${r.id}: not the last provider (${r.providerIds})`);
            if (r.default !== raw.default || r.default === "comfyrouter") bad.push(`${r.id}: the default moved to ${r.default}`);
            if (!/Also on Comfy Router\./.test(r.description || "")) bad.push(`${r.id}: the description does not say Also on Comfy Router`);
            // the live status, true per model: GPT Image 2 and Nano Banana 2 ran through the Router on 2026-09-23, the rest not
            const ranLive = ["gpt_image_2", "nano_banana_2"].includes(r.id);
            const opening = ranLive ? /^Runs on Comfy Router \(api\.comfy\.org\) with the Comfy Cloud key, billed in Comfy credits, no paid plan needed; run against the live API on 2026-09-23 / : /^Runs on Comfy Router \(api\.comfy\.org\) with the Comfy Cloud key, billed in Comfy credits, no paid plan needed; not run against the live API yet\./;
            if (!opening.test(v.note || "")) bad.push(`${r.id}: the note's opening sentence does not say ${ranLive ? "that it ran live" : "that it has not run live"}`);
            if (!/passes (them|it) to /.test(v.note || "")) bad.push(`${r.id}: the note does not say where the pictures go`);
            const prov = v.model.split("/")[0];
            const d = router.DIALECTS[prov];
            if (!d) { bad.push(`${r.id}: no dialect for ${prov}`); continue; }
            const up = r.task === "upscale";
            if (up !== !!d.upscale) bad.push(`${r.id}: task ${r.task} but the dialect ${d.upscale ? "is" : "is not"} an upscaler`);
            if (!up && (v.edit === false) !== (d.edit === false)) bad.push(`${r.id}: edit ${v.edit} against the dialect`);
            const textless = up || v.text === null;
            if (!up && prov === "bfl" && v.model.endsWith("fill") !== textless) bad.push(`${r.id}: a text shape ${JSON.stringify(v.text)}`);
            if (!up && !v.model.endsWith("fill") && (!v.text || v.text.model !== v.model || !v.text.sizes.length)) bad.push(`${r.id}: text ${JSON.stringify(v.text)}`);
            const seen = new Set();
            for (const st of v.settings || []) { if (seen.has(st.index)) bad.push(`${r.id}: slot ${st.index} twice`); seen.add(st.index); }
            // the bodies: an edit (or upscale) and a text run, each checked against the model's schema
            const runs = [];
            if (up) runs.push(["upscale", upReq(v)]);
            else {
                if (v.edit !== false) runs.push(["edit", editReq(v, { references: (v.options.max_images || 1) > 1 ? [pngOf(512, 512, 64, "REF1")] : [] })]);
                if (v.text) runs.push(["text", textReq(v)]);
            }
            for (const [kind, req] of runs) {
                const s = fakeServer();
                const out = await (kind === "upscale" ? router.upscale(req, ctxFor(s)) : kind === "text" ? router.generate(req, ctxFor(s)) : router.edit(req, ctxFor(s)));
                const body = s.submits[0] && s.submits[0].body;
                const problems = body ? schemaProblems(v.model, body) : ["no submit"];
                if (problems.length) bad.push(`${r.id} ${kind}: ${problems.slice(0, 4).join("; ")}`);
                if (!out || !out.bytes || !out.bytes.length) bad.push(`${r.id} ${kind}: no picture back`);
                if (s.submits[0] && s.submits[0].url !== `${BASE}/v2/models/${v.model}/requests`) bad.push(`${r.id} ${kind}: ${s.submits[0].url}`);
                bodies++;
            }
        }
        check("each variant: its model, last in the list, the default kept, the description and the note, a dialect that fits its task, the text shape, one slot per setting; every edit, text and upscale body it builds holds against the model's published schema", !bad.length && bodies >= 26, bad.join(" | ") || `${bodies} bodies`);
    });

    // ---- 7. the dialects field by field ----
    await section("7. dialects", async () => {
        const run = async (id, kind, extra = {}, sopts = {}) => {
            const v = variant(id);
            const s = fakeServer(sopts);
            const req = kind === "text" ? textReq(v, extra) : kind === "upscale" ? upReq(v, extra) : editReq(v, extra);
            const out = await (kind === "text" ? router.generate(req, ctxFor(s)) : kind === "upscale" ? router.upscale(req, ctxFor(s)) : router.edit(req, ctxFor(s)));
            return { out, body: s.submits[0].body, s };
        };
        // OpenAI
        let x = await run("gpt_image_2", "edit", { references: [pngOf(512, 512, 64, "REF1")], params: { quality: "high", background: "transparent", output_format: "jpeg", size: "auto", moderation: "low" } });
        const pics = x.body.image.map(fromDataUrl);
        check("OpenAI fill: the crop and the reference as data URLs, the alpha mask, size in the crop's shape, n 1, transparent turns jpeg into png", pics.length === 2 && tagOf(pics[0].bytes) === "CROP" && tagOf(pics[1].bytes) === "REF1" && tagOf(fromDataUrl(x.body.mask).bytes) === "MASK-ALPHA" && x.body.size === "1024x768" && x.body.n === 1 && x.body.quality === "high" && x.body.background === "transparent" && x.body.output_format === "png" && x.body.moderation === "low" && !("model" in x.body) && x.body.prompt === "a red door", short({ ...x.body, image: pics.length, mask: !!x.body.mask }));
        x = await run("gpt_image_2", "edit", { kind: "edit" });
        check("OpenAI instruction edit (kind edit): the crop goes, the mask does not", Array.isArray(x.body.image) && x.body.image.length === 1 && !("mask" in x.body), short(Object.keys(x.body)));
        x = await run("gpt_image_2_5_flare", "text", { width: 2048, height: 1152 });
        check("OpenAI text: no image, no mask, the asked size", !("image" in x.body) && !("mask" in x.body) && x.body.size === "2048x1152", short(x.body));
        // Gemini
        x = await run("nano_banana_pro", "edit", { references: [pngOf(512, 512, 64, "REF1")] });
        const parts = x.body.contents[0].parts;
        check("Gemini fill: the instruction, the crop, the mask, the reference, as camelCase inlineData; IMAGE only; the thought draft skipped in the answer", /^Edit the first image\. The second image is a mask/.test(parts[0].text) && /The remaining image is reference material/.test(parts[0].text) && tagOf(Buffer.from(parts[1].inlineData.data, "base64")) === "CROP" && tagOf(Buffer.from(parts[2].inlineData.data, "base64")) === "MASK-LUMINANCE" && tagOf(Buffer.from(parts[3].inlineData.data, "base64")) === "REF1" && parts.every((p) => !p.inline_data) && eq(x.body.generationConfig.responseModalities, ["IMAGE"]) && x.body.generationConfig.imageConfig.imageSize === "2K" && tagOf(x.out.bytes) === "RESULT", short(x.body.generationConfig));
        x = await run("nano_banana_2", "text", { params: { aspect_ratio: "auto", image_size: "auto" }, width: 1536, height: 1024, aspect: "3:2" });
        check("Gemini text: the dialog's aspect and the smallest tier covering its long side", eq(x.body.generationConfig.imageConfig, { aspectRatio: "3:2", imageSize: "2K" }) && x.body.contents[0].parts.length === 1, short(x.body));
        // FLUX.2 and Fill
        x = await run("flux2_max", "edit", { references: [pngOf(512, 512, 64, "REF1")], width: 3000, height: 100, params: { safety_tolerance: 3, prompt_upsampling: false } });
        check("FLUX.2 edit: input_image and input_image_2 as plain base64, width and height held to 256..2048, the seed, png, the settings", Buffer.from(x.body.input_image, "base64").toString("latin1").includes("CROP") && Buffer.from(x.body.input_image_2, "base64").toString("latin1").includes("REF1") && x.body.width === 2048 && x.body.height === 256 && x.body.seed === 42 && x.body.output_format === "png" && x.body.safety_tolerance === 3 && x.body.prompt_upsampling === false && x.out.seed === 2784347701, short({ ...x.body, input_image: "..", input_image_2: ".." }));
        x = await run("flux1_fill", "edit", { params: { steps: 40, guidance: 30, safety_tolerance: 2, prompt_upsampling: false } });
        check("FLUX.1 Fill: image and the white-is-repaint mask as base64, steps and guidance, the answer downloaded from the sample link", tagOf(Buffer.from(x.body.image, "base64")) === "CROP" && tagOf(Buffer.from(x.body.mask, "base64")) === "MASK-LUMINANCE" && x.body.steps === 40 && x.body.guidance === 30 && tagOf(x.out.bytes) === "ASSET" && x.s.assets.length === 1, short({ ...x.body, image: "..", mask: ".." }));
        // Seedream
        x = await run("seedream_5_pro", "edit", { width: 1600, height: 900 });
        const [sw, sh] = x.body.size.split("x").map(Number);
        check("Seedream edit: the instruction, data URL pictures, a size in the crop's shape inside 1 to 4.2 MP, no watermark, b64_json, png, the seed", /^Edit the first image and keep its size and framing\. a red door$/.test(x.body.prompt) && fromDataUrl(x.body.image[0]).mime === "image/png" && sw * sh >= 1048576 && sw * sh <= 4194304 && Math.abs(sw / sh - 16 / 9) < 0.02 && x.body.watermark === false && x.body.response_format === "b64_json" && x.body.output_format === "png" && x.body.seed === 42 && !("model" in x.body), short({ ...x.body, image: 1 }));
        x = await run("seedream_5_lite", "text", { width: 3072, height: 2048, aspect: "3:2" });
        const [lw, lh] = x.body.size.split("x").map(Number);
        check("Seedream Lite text: no image, 3:2 inside 3.7 to 9.4 MP", !("image" in x.body) && lw * lh >= 3686400 && lw * lh <= 9437184 && Math.abs(lw / lh - 1.5) < 0.01, x.body.size);
        // Qwen
        x = await run("qwen_image_edit", "edit", { references: [pngOf(512, 512, 64, "REF1")] });
        const c = x.body.input.messages[0].content;
        check("Qwen edit: the pictures then the text in one user message, size W*H, prompt rewriting and watermark off, seed and negative prompt; the answer's image link downloaded", c.length === 3 && tagOf(fromDataUrl(c[0].image).bytes) === "CROP" && tagOf(fromDataUrl(c[1].image).bytes) === "REF1" && /^Edit the first image/.test(c[2].text) && x.body.parameters.size === "1024*768" && x.body.parameters.prompt_extend === false && x.body.parameters.watermark === false && x.body.parameters.seed === 42 && x.body.parameters.negative_prompt === "blurry" && x.body.parameters.n === 1 && tagOf(x.out.bytes) === "ASSET", short(x.body.parameters));
        // Freepik
        x = await run("magnific_precision", "upscale", { factor: 20, params: { flavor: "sublime", sharpen: 12, smart_grain: 7, ultra_detail: 30 } });
        check("Magnific Precision: the picture as base64, the factor held to 2..16, the four settings, the answer's link downloaded", tagOf(Buffer.from(x.body.image, "base64")) === "UPSCALE" && x.body.scale_factor === 16 && x.body.flavor === "sublime" && x.body.sharpen === 12 && tagOf(x.out.bytes) === "ASSET", short({ ...x.body, image: ".." }));
        // text only
        x = await run("grok_imagine", "text", { width: 1920, height: 1080, params: { resolution: "auto", quality: "low" } });
        check("Grok text: the closest preset aspect, the tier covering 1920 as 2k, the quality", x.body.aspect_ratio === "16:9" && x.body.resolution === "2k" && x.body.quality === "low" && x.body.n === 1, short(x.body));
        x = await run("ideogram_4", "text", { width: 2560, height: 1440 });
        check("Ideogram text: text_prompt and the 2K size of the asked aspect", x.body.text_prompt === "a lighthouse at dusk" && x.body.resolution === "2560x1440" && x.body.rendering_speed === "DEFAULT", short(x.body));
        x = await run("krea_2", "text", { width: 2350, height: 1000 });
        check("Krea text: the 2.35:1 preset, 1K, creativity and the seed", x.body.aspect_ratio === "2.35:1" && x.body.resolution === "1K" && x.body.creativity === "medium" && x.body.seed === 7, short(x.body));
        const sQ = fakeServer({ result: [() => json(200, { output: { choices: [{ message: { content: [{ text: "I cannot draw that." }] } }] } })] });
        const eQ = await throws(() => router.edit(editReq(variant("qwen_image_edit")), ctxFor(sQ)));
        check("an answer with text in place of a picture says so", /no picture in the answer: I cannot draw that/.test(eQ || ""), eQ);
        const sG = fakeServer({ result: [() => json(200, { candidates: [{ finishReason: "IMAGE_SAFETY", content: { parts: [] } }] })] });
        const eG = await throws(() => router.edit(editReq(variant("nano_banana_2")), ctxFor(sG)));
        check("Gemini without a picture: its finish reason", /no picture in the answer: IMAGE_SAFETY/.test(eG || ""), eG);
        const sX = fakeServer({ result: [() => json(200, { block_reason: "moderation" })] });
        const eX = await throws(() => router.generate(textReq(variant("grok_imagine")), ctxFor(sX)));
        check("xAI blocked by input moderation: the block reason", /no picture in the answer: moderation/.test(eX || ""), eX);
    });

    // ---- 8. providers/index.js: the shared key, the lists, the app's context ----
    await section("8. index.js", async () => {
        const idxPath = path.join(ROOT, "electron", "main", "providers", "index.js");
        const orig = Module._load;
        let currentSettings = { comfyrouter: { base: BASE } };
        let stored = { comfycloud: KEY };
        const asked = [];
        const logged = [];
        Module._load = function (request, parent, ...rest) {
            if (request === "electron") return { nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, toJPEG: () => jpegOf(100, "NATIVE"), toBitmap: () => Buffer.alloc(8, 255) }) } };
            if (parent && parent.filename === idxPath) {
                if (request === "../log") return { record: (x) => logged.push(x) };
                if (request === "../keys") return { get: (id) => { asked.push(id); return stored[id] || ""; }, describe: (id) => ({ name: id, set: !!stored[id], hint: stored[id] ? stored[id].slice(-4) : "" }) };
                if (request === "../settings") return { get: () => currentSettings };
            }
            return orig.call(this, request, parent, ...rest);
        };
        let index;
        try { index = require(idxPath); } finally { Module._load = orig; }
        const rows = index.describeAll();
        const cr = rows.find((x) => x.id === "comfyrouter"), cc = rows.find((x) => x.id === "comfycloud");
        check("describeAll: Comfy Router listed with sharesKey comfycloud and the Comfy Cloud key's state; every other row shares nothing", cr && cr.sharesKey === "comfycloud" && cr.key.name === "comfycloud" && cr.key.set === true && cc && cc.sharesKey === null && rows.filter((x) => x.sharesKey).length === 2 && rows.find((x) => x.id === "comfypartner").sharesKey === "comfycloud", short(cr));
        check("Comfy Router is a text and an upscale provider, the Partner API a text provider and no upscaler", index.textProviders().includes("comfyrouter") && index.upscaleProviders().includes("comfyrouter") && index.textProviders().includes("comfypartner") && !index.upscaleProviders().includes("comfypartner"));
        const realFetch = globalThis.fetch;
        const v = variant("gpt_image_2");
        async function viaIndex(request) {
            const s = fakeServer();
            globalThis.fetch = s.fetch;
            try { return { s, out: await index.edit(request), err: null }; } catch (e) { const m = String(e && e.message || e); ERRORS.push(m); return { s, out: null, err: m }; } finally { globalThis.fetch = realFetch; }
        }
        const base = { provider: "comfyrouter", model: v.model, kind: "fill", options: v.options, prompt: "a red door", seed: 3, image: new Uint8Array(pngOf(1024, 768, 96, "CROP")), maskAlpha: new Uint8Array(pngOf(1024, 768, 96, "MA")), width: 1024, height: 768, references: [], params: {} };
        asked.length = 0;
        const x1 = await viaIndex(base);
        check("index.edit: the key stored under comfycloud, settings.comfyrouter.base as the mock, the picture back", !x1.err && eq(asked, ["comfycloud"]) && x1.s.submits.length === 1 && x1.s.submits[0].url.startsWith(BASE + "/v2/models/openai/gpt-image-2/requests") && x1.s.submits[0].headers["x-api-key"] === KEY && tagOf(Buffer.from(x1.out.bytes)) === "RESULT", short({ err: x1.err, asked }));
        stored = {};
        const x2 = await viaIndex(base);
        check("without the Comfy Cloud key: refused before any call, naming Comfy Router", !!x2.err && /No API key for Comfy Router/.test(x2.err) && x2.s.calls.length === 0, x2.err);
        stored = { comfycloud: KEY };
        currentSettings = { comfyrouter: { base: "https://evil.example" } };
        const x3 = await viaIndex(base);
        check("settings.comfyrouter.base outside the rule is ignored, and the test key then refused before any call", !!x3.err && /test key is never sent/.test(x3.err) && x3.s.calls.length === 0, x3.err);
        currentSettings = { comfyrouter: { base: BASE } };
        check("index.js logged no key", !JSON.stringify(logged).includes(KEY), `${logged.length} records`);
    });

    // ---- 10. HY Image 3.5 through the Partner API ----
    await section("10. HY Image through the Partner API", async () => {
        const recipe = loadRecipes().find((r) => r.id === "hy_image_3_5");
        const v = recipe && recipe.providers.comfypartner;
        check("the recipe: one comfypartner variant, its default, an instruction edit, a text shape of the same model, crops held to 2048 px and 4.2 MP", !!v && recipe.default === "comfypartner" && eq(recipe.providerIds, ["comfypartner"]) && v.model === "hy-image-v3.5-preview" && v.input === "edit" && v.text && v.text.model === v.model && v.limits.max === 2048 && v.limits.pixels === 4194304 && /run against the live API on 2026-09-23/.test(v.note) && /not a documented public API/.test(v.note), short(v && { limits: v.limits, text: v.text }));
        const req = (extra = {}) => ({ provider: "comfypartner", model: v.model, kind: "edit", options: v.options, prompt: "put @image2 on the table", negative: "", seed: 42, image: pngOf(1024, 768, 96, "CROP"), mask: null, maskAlpha: null, width: 1024, height: 768, references: [pngOf(512, 512, 64, "REF1")], params: defaults(v), ...extra });
        const s = fakeServer();
        const ctx = ctxFor(s);
        const out = await partner.edit(req(), ctx);
        const b = s.hy[0] && s.hy[0].body;
        const content = b ? b.messages[0].content : [];
        check("an edit: one storage request per picture with the key and its type, the bytes PUT to the signed URL without the key, in order", s.storage.length === 2 && s.storage.every((c) => c.headers["x-api-key"] === KEY && c.body.content_type === "image/png" && /\.png$/.test(c.body.file_name)) && s.uploads.length === 2 && tagOf(s.uploads[0].bytes) === "CROP" && tagOf(s.uploads[1].bytes) === "REF1" && s.uploads.every((c) => !c.headers["x-api-key"] && c.headers["content-type"] === "image/png"), short(s.calls.map((c) => c.method + " " + c.url)));
        check("then one generation request: the model, a user message of the text and the two download URLs, the crop's size, resize_max_pixels for Detail standard, the seed, no watermark", !!b && b.model === "hy-image-v3.5-preview" && b.messages.length === 1 && b.messages[0].role === "user" && content[0].type === "text" && content[1].image_url.url === `${BASE}/stored/1.png?sig=def` && content[2].image_url.url === `${BASE}/stored/2.png?sig=def` && b.size === "1024x768" && b.resize_max_pixels === 1048576 && b.seed === 42 && b.logo_add === 0 && eq(Object.keys(b).sort(), ["logo_add", "messages", "model", "resize_max_pixels", "seed", "size"]), short(b && { ...b, messages: content.map((x) => x.type) }));
        check("the text: the crop is Image 1, @image2 became Image 2, the reference is named", !!b && content[0].text === "Edit Image 1 and keep its size and framing. put Image 2 on the table Image 2 is reference material.", content[0] && content[0].text);
        check("the generation request carries the key, a UUID Idempotency-Key and JSON; the answer's picture is fetched without the key", s.hy[0].headers["x-api-key"] === KEY && s.hy[0].headers["idempotency-key"] === ctx.uuids[0] && s.assets.length === 1 && eq(Object.keys(s.assets[0].headers), []) && tagOf(out.bytes) === "ASSET" && out.info.answered === "1024x768" && out.info.detail === "standard" && out.seed === 42, short(out.info));

        const s2 = fakeServer();
        await partner.edit(req({ params: { reference_detail: "high" }, references: [], prompt: "make it night" }), ctxFor(s2));
        check("Detail high: resize_max_pixels 4194304; one picture, no reference sentence", s2.hy[0].body.resize_max_pixels === 4194304 && s2.hy[0].body.messages[0].content.length === 2 && s2.hy[0].body.messages[0].content[0].text === "Edit Image 1 and keep its size and framing. make it night", short(s2.hy[0].body.messages[0].content[0]));
        const s3 = fakeServer();
        const o3 = await partner.generate({ ...req({ kind: "text", image: null, references: [], prompt: "a lighthouse at dusk" }), width: 4096, height: 2304 }, ctxFor(s3));
        check("Generate new: no storage request, no upload, the prompt alone, the asked size, no resize_max_pixels", s3.storage.length === 0 && s3.uploads.length === 0 && s3.hy[0].body.messages[0].content.length === 1 && s3.hy[0].body.messages[0].content[0].text === "a lighthouse at dusk" && s3.hy[0].body.size === "4096x2304" && !("resize_max_pixels" in s3.hy[0].body) && tagOf(o3.bytes) === "ASSET", short(s3.hy[0].body));
        check("sizes: multiples of 16, at most 4096 x 4096 in area", partner._sizeFor(1000, 750) === "1008x752" && partner._sizeFor(8000, 4000) === "5792x2896" && partner._sizeFor(100, 100) === "256x256", short([partner._sizeFor(1000, 750), partner._sizeFor(8000, 4000), partner._sizeFor(100, 100)]));

        const s4 = fakeServer();
        const e4 = await throws(() => partner.edit(req({ prompt: "use @Image3" }), ctxFor(s4)));
        check("@Image3 with two pictures: refused before any call", /names @Image3, but only 2 pictures go in/.test(e4 || "") && s4.calls.length === 0, e4);
        const s5 = fakeServer();
        const refs = Array.from({ length: 5 }, (_, i) => pngOf(64, 64, 64, "R" + i));
        const e5 = await throws(() => partner.edit(req({ references: refs }), ctxFor(s5)));
        check("six pictures: refused before any call", /HY Image 3\.5 takes at most 5 pictures; this run has 6/.test(e5 || "") && s5.calls.length === 0, e5);
        const s6 = fakeServer();
        await partner.edit(req({ references: [], prompt: "make it night" }), ctxFor(s6, { opaque: () => false }));
        check("a crop with transparency goes as JPEG (the node sends no alpha)", s6.storage[0].body.content_type === "image/jpeg" && /\.jpg$/.test(s6.storage[0].body.file_name) && s6.uploads[0].headers["content-type"] === "image/jpeg" && tagOf(s6.uploads[0].bytes) === "JPEG", short(s6.storage[0].body));

        const flaky = () => json(200, { error: { message: "code: 400, msg: download image failed", code: 400 } });
        const s7 = fakeServer({ hy: [flaky, flaky] });
        const c7 = ctxFor(s7);
        const o7 = await partner.edit(req(), c7);
        check("\"download image failed\" is sent again (twice, each under a new key), as the node does", tagOf(o7.bytes) === "ASSET" && s7.hy.length === 3 && new Set(s7.hy.map((c) => c.headers["idempotency-key"])).size === 3 && s7.storage.length === 2, short({ runs: s7.hy.length, storage: s7.storage.length }));
        const s8 = fakeServer({ hy: [flaky, flaky, flaky] });
        const e8 = await throws(() => partner.edit(req(), ctxFor(s8)));
        check("a third time it is the error, with the message after msg:", s8.hy.length === 3 && /HY Image 3\.5: download image failed$/.test(e8 || ""), e8);
        const s7b = fakeServer({ hy: [() => json(400, { error: { message: "code: 400, msg: download image failed" } })] });
        const o7b = await partner.edit(req(), ctxFor(s7b));
        check("the same when it comes as an HTTP 400", tagOf(o7b.bytes) === "ASSET" && s7b.hy.length === 2, String(s7b.hy.length));
        const s9 = fakeServer({ hy: [() => json(402, { error: "insufficient_credits", message: "Payment required" })] });
        const e9 = await throws(() => partner.edit(req(), ctxFor(s9)));
        check("402: the credits in words, not sent again", s9.hy.length === 1 && /no credits left/.test(e9 || "") && /Payment required/.test(e9 || ""), e9);
        const s10 = fakeServer({ hy: [() => json(404, { detail: "Not Found" })] });
        const e10 = await throws(() => partner.edit(req(), ctxFor(s10)));
        check("404: says the route is gone and why that can happen", /no longer serves this route/.test(e10 || "") && /not a public contract/.test(e10 || ""), e10);
        const s11 = fakeServer({ hy: [() => json(401, { error: { message: `bad key ${KEY}`, type: "auth" } })] });
        const e11 = await throws(() => partner.edit(req(), ctxFor(s11)));
        check("401: key refused, the echoed key taken out", /key refused/.test(e11 || "") && !(e11 || "").includes(KEY), e11);
        const s12 = fakeServer({ storage: [() => json(200, { upload_url: "http://evil.example/up", download_url: "https://x/y" })] });
        const e12 = await throws(() => partner.edit(req(), ctxFor(s12)));
        check("an upload URL that is not https is not used", /without usable URLs/.test(e12 || "") && s12.uploads.length === 0 && s12.hy.length === 0, e12);
        const s13 = fakeServer({ hy: [() => json(200, { choices: [{ delta: {} }], request_id: "x" })] });
        const e13 = await throws(() => partner.edit(req(), ctxFor(s13)));
        check("an answer without a picture says so", /answer holds no picture/.test(e13 || ""), e13);

        const s14 = fakeServer();
        const e14 = await throws(() => partner.edit(req(), ctxFor(s14, { key: REAL_KEY })));
        const s15 = fakeServer();
        const e15 = await throws(() => partner.edit(req(), ctxFor(s15, { base: undefined })));
        const s16 = fakeServer();
        const e16 = await throws(() => partner.edit(req({ model: "hy-image-v9" }), ctxFor(s16)));
        const s17 = fakeServer();
        await partner.generate({ ...req({ kind: "text", image: null, references: [], prompt: "a lighthouse" }) }, ctxFor(s17, { key: REAL_KEY, base: undefined }));
        check("a real key never to the mock, a test key never to api.comfy.org, an unknown model refused, all before any call; a real key goes to https://api.comfy.org", /only a test key goes there/.test(e14 || "") && /test key is never sent/.test(e15 || "") && /knows no model "hy-image-v9"/.test(e16 || "") && s14.calls.length + s15.calls.length + s16.calls.length === 0 && s17.hy[0].url === LIVE + partner.HY_PATH && s17.hy[0].headers["x-api-key"] === REAL_KEY, short([e14, e15, e16]));
    });

    // ---- 9. the whole run ----
    const okHeaders = (c) => {
        const k = Object.keys(c.headers).sort();
        if (/\/asset\//.test(c.url)) return k.length === 0;
        if (/\/customers\/storage$/.test(c.url)) return eq(k, ["content-type", "x-api-key"]);
        if (c.method === "PUT" && /\/upload\//.test(c.url)) return eq(k, ["content-type"]);
        if (c.method === "POST") return eq(k, ["content-type", "idempotency-key", "x-api-key"]);
        return eq(k, ["x-api-key"]);
    };
    const extra = ALL_CALLS.filter((c) => !okHeaders(c));
    check("no call of the whole run carried a header beyond X-API-Key, Content-Type and Idempotency-Key (the reads the key alone, a storage request no Idempotency-Key, a signed upload only its Content-Type, the asset downloads nothing)", ALL_CALLS.length > 150 && !extra.length, extra.length ? short(extra.map((c) => c.method + " " + c.url + " " + Object.keys(c.headers).join(","))) : `${ALL_CALLS.length} calls`);
    const keyed = ALL_CALLS.filter((c) => c.headers["x-api-key"] && !(c.headers["x-api-key"] === KEY && c.url.startsWith(BASE + "/")) && !(c.headers["x-api-key"] === REAL_KEY && c.url.startsWith(LIVE + "/")));
    check("the test key went to the mock only, the real key to api.comfy.org only", !keyed.length, short(keyed.map((c) => c.url)));
    check("neither key appears in any error of the run", ERRORS.length > 30 && !ERRORS.some((x) => x.includes(KEY) || x.includes(REAL_KEY)), `${ERRORS.length} errors`);

    const failed = results.filter((x) => !x).length;
    console.log(`${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

/** The recipes as recipes.js serves them (normalized), read without Electron. */
let RECIPE_CACHE = null;
function loadRecipes() {
    if (RECIPE_CACHE) return RECIPE_CACHE;
    const orig = Module._load;
    Module._load = function (request, ...rest) {
        if (request === "electron") return { app: { getPath: () => ROOT } };   // only list() and save() would ask it
        return orig.call(this, request, ...rest);
    };
    let recipes;
    try { recipes = require(path.join(ROOT, "electron", "main", "recipes.js")); } finally { Module._load = orig; }
    RECIPE_CACHE = fs.readdirSync(RECIPES).filter((f) => f.endsWith(".json")).map((f) => {
        const r = JSON.parse(fs.readFileSync(path.join(RECIPES, f), "utf8"));
        r.kind = r.kind === "provider" ? "provider" : "comfy";
        return recipes._normalize(r);
    });
    return RECIPE_CACHE;
}

main().catch((err) => { console.log("[FAIL] " + (err && err.stack || err)); console.log("FAIL"); process.exit(1); });
