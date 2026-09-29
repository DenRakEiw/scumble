// The Comfy Router adapter (electron/main/providers/comfyrouter.js), its recipe variants and its wiring in
// providers/index.js, the Partner API's HY Image (comfypartner.js) and the pictures Comfy Cloud's graph takes per node
// (comfycloud.js), in plain Node, no Electron and no key:
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
const cloud = require(path.join(ROOT, "electron", "main", "providers", "comfycloud.js"));
const refsLib = require(path.join(ROOT, "electron", "main", "providers", "refs.js"));

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
            // Oxen.ai and Magnific (added later) may follow it, in that order
            const upToRouter = r.providerIds.filter((x) => x !== "oxen" && x !== "magnific");
            if (upToRouter[upToRouter.length - 1] !== "comfyrouter") bad.push(`${r.id}: not the last provider before oxen / magnific (${r.providerIds})`);
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
                // one reference each: FLUX.1 Fill (max_images 1) declares the drop and goes out with the crop alone
                if (v.edit !== false) runs.push(["edit", editReq(v, { references: [pngOf(512, 512, 64, "REF1")] })]);
                if (v.text) runs.push(["text", textReq(v)]);
            }
            for (const [kind, req] of runs) {
                const s = fakeServer();
                const out = await (kind === "upscale" ? router.upscale(req, ctxFor(s)) : kind === "text" ? router.generate(req, ctxFor(s)) : router.edit(req, ctxFor(s)));
                const body = s.submits[0] && s.submits[0].body;
                const problems = body ? schemaProblems(v.model, body) : ["no submit"];
                if (problems.length) bad.push(`${r.id} ${kind}: ${problems.slice(0, 4).join("; ")}`);
                if (!out || !out.bytes || !out.bytes.length) bad.push(`${r.id} ${kind}: no picture back`);
                // the pictures sent are the layout's: every one it numbers, the crop alone where it declares a drop
                if (kind === "edit" && out) {
                    const lay = router.layout(req), numbered = lay.pictures.filter((p) => p.n != null).length;
                    const sent = out.info.pictures + (lay.pictures.some((p) => p.role === "mask" && p.n != null) ? 1 : 0);
                    if (lay.drops ? out.info.pictures !== 1 : sent !== numbered) bad.push(`${r.id} edit: ${out.info.pictures} pictures sent, the layout numbers ${numbered}${lay.drops ? " and drops the references" : ""}`);
                }
                if (s.submits[0] && s.submits[0].url !== `${BASE}/v2/models/${v.model}/requests`) bad.push(`${r.id} ${kind}: ${s.submits[0].url}`);
                bodies++;
            }
        }
        check("each variant: its model, last in the list, the default kept, the description and the note, a dialect that fits its task, the text shape, one slot per setting; every edit (with one reference: the layout's pictures, FLUX.1 Fill the crop alone), text and upscale body it builds holds against the model's published schema",!bad.length && bodies >= 26, bad.join(" | ") || `${bodies} bodies`);
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
        const inl = (k) => tagOf(Buffer.from(parts[k].inlineData.data, "base64"));
        check("Gemini fill: the instruction, then a label part before the crop, the mask and the reference, as camelCase inlineData; IMAGE only; the thought draft skipped in the answer", parts.length === 7 && parts[0].text === "Edit image 1. Image 2 is a mask: change only the white area of the mask, keep everything else exactly as it is, and keep the image size and framing. a red door Image 3 is a reference image." && eq([parts[1], parts[3], parts[5]], [{ text: "Image 1:" }, { text: "Image 2:" }, { text: "Image 3:" }]) && inl(2) === "CROP" && inl(4) === "MASK-LUMINANCE" && inl(6) === "REF1" && parts.every((p) => !p.inline_data) && eq(x.body.generationConfig.responseModalities, ["IMAGE"]) && x.body.generationConfig.imageConfig.imageSize === "2K" && tagOf(x.out.bytes) === "RESULT", short(parts.map((p) => p.text || tagOf(Buffer.from(p.inlineData.data, "base64")))));
        x = await run("nano_banana_pro", "edit", { kind: "edit", refName: "<image{n}>", references: [pngOf(512, 512, 64, "REF1"), pngOf(512, 512, 64, "REF2")], original: 1 });
        const p2 = x.body.contents[0].parts;
        check("Gemini edit with the Original and a reference under <image{n}>: no mask picture, the Original named as the crop before the fill, the labels in the recipe's names", p2.length === 7 && p2[0].text === "Edit <image1> and keep its size and framing. a red door <image2> is <image1> before the selected area was filled. <image3> is a reference image." && eq([p2[1], p2[3], p2[5]], [{ text: "<image1>:" }, { text: "<image2>:" }, { text: "<image3>:" }]) && tagOf(Buffer.from(p2[2].inlineData.data, "base64")) === "CROP" && tagOf(Buffer.from(p2[4].inlineData.data, "base64")) === "REF1" && tagOf(Buffer.from(p2[6].inlineData.data, "base64")) === "REF2", short(p2.map((p) => p.text || tagOf(Buffer.from(p.inlineData.data, "base64")))));
        x = await run("nano_banana_2", "edit", { kind: "edit" });
        check("Gemini with one picture: no label part, the instruction and the crop", x.body.contents[0].parts.length === 2 && x.body.contents[0].parts[0].text === "Edit image 1 and keep its size and framing. a red door" && tagOf(Buffer.from(x.body.contents[0].parts[1].inlineData.data, "base64")) === "CROP", short(x.body.contents[0].parts.map((p) => p.text || "picture")));
        const sCap = fakeServer();
        const thirteen = Array.from({ length: 13 }, (_, i) => pngOf(64, 64, 64, "R" + i));
        const eCap = await throws(() => router.edit(editReq(variant("nano_banana_2"), { references: thirteen }), ctxFor(sCap)));
        const layCap = router.layout(editReq(variant("nano_banana_2"), { references: thirteen }));
        check("Gemini fill with the crop, the mask and 13 references (15 pictures, max_images 14): the mask picture counts, refused before any call", layCap.max === 14 && /vertexai\/gemini-3\.1-flash-image takes at most 14 pictures; this run has 15 \(the crop, the mask, 13 references\)/.test(eCap || "") && sCap.calls.length === 0, `max ${layCap.max}: ${eCap}`);
        x = await run("nano_banana_2", "text", { params: { aspect_ratio: "auto", image_size: "auto" }, width: 1536, height: 1024, aspect: "3:2" });
        check("Gemini text: the dialog's aspect and the smallest tier covering its long side", eq(x.body.generationConfig.imageConfig, { aspectRatio: "3:2", imageSize: "2K" }) && x.body.contents[0].parts.length === 1, short(x.body));
        // FLUX.2 and Fill
        x = await run("flux2_max", "edit", { references: [pngOf(512, 512, 64, "REF1")], width: 3000, height: 100, params: { safety_tolerance: 3, prompt_upsampling: false } });
        check("FLUX.2 edit: input_image and input_image_2 as plain base64, width and height held to 256..2048, the seed, png, the settings", Buffer.from(x.body.input_image, "base64").toString("latin1").includes("CROP") && Buffer.from(x.body.input_image_2, "base64").toString("latin1").includes("REF1") && x.body.width === 2048 && x.body.height === 256 && x.body.seed === 42 && x.body.output_format === "png" && x.body.safety_tolerance === 3 && x.body.prompt_upsampling === false && x.out.seed === 2784347701, short({ ...x.body, input_image: "..", input_image_2: ".." }));
        x = await run("flux1_fill", "edit", { params: { steps: 40, guidance: 30, safety_tolerance: 2, prompt_upsampling: false } });
        check("FLUX.1 Fill: image and the white-is-repaint mask as base64, steps and guidance, the answer downloaded from the sample link", tagOf(Buffer.from(x.body.image, "base64")) === "CROP" && tagOf(Buffer.from(x.body.mask, "base64")) === "MASK-LUMINANCE" && x.body.steps === 40 && x.body.guidance === 30 && tagOf(x.out.bytes) === "ASSET" && x.s.assets.length === 1, short({ ...x.body, image: "..", mask: ".." }));
        const fillReq = editReq(variant("flux1_fill"), { references: [pngOf(512, 512, 64, "ORIG"), pngOf(512, 512, 64, "REF1")], original: 1, prompt: "a red door" });
        const fillLay = router.layout(fillReq);
        const fillChk = refsLib.checkPictures(fillLay, fillReq, "Comfy Router " + fillReq.model);
        check("FLUX.1 Fill with the Original and a reference: the layout declares the drop, index.js's check strips both and says so", fillLay.drops === "FLUX.1 Fill takes no reference images" && fillChk.req.references.length === 0 && fillChk.req.original === 0 && eq(fillChk.notes, ["Comfy Router bfl/flux-pro-1.0-fill: FLUX.1 Fill takes no reference images; the Original and 1 reference layer not sent."]), short({ drops: fillLay.drops, notes: fillChk.notes }));
        x = await run("flux1_fill", "edit", { references: [pngOf(512, 512, 64, "ORIG"), pngOf(512, 512, 64, "REF1")], original: 1 });
        const fillSent = JSON.stringify(x.body);
        check("FLUX.1 Fill called directly with references: it goes out with the crop and the mask alone, no reference anywhere in the body", tagOf(Buffer.from(x.body.image, "base64")) === "CROP" && tagOf(Buffer.from(x.body.mask, "base64")) === "MASK-LUMINANCE" && !fillSent.includes(pngOf(512, 512, 64, "REF1").toString("base64")) && !fillSent.includes(pngOf(512, 512, 64, "ORIG").toString("base64")) && x.out.info.pictures === 1, short({ keys: Object.keys(x.body), pictures: x.out.info.pictures }));
        // Seedream
        x = await run("seedream_5_pro", "edit", { width: 1600, height: 900 });
        const [sw, sh] = x.body.size.split("x").map(Number);
        check("Seedream edit: the instruction, data URL pictures, a size in the crop's shape inside 1 to 4.2 MP, no watermark, b64_json, png, the seed", x.body.prompt === "Edit image 1 and keep its size and framing. a red door" && fromDataUrl(x.body.image[0]).mime === "image/png" && sw * sh >= 1048576 && sw * sh <= 4194304 && Math.abs(sw / sh - 16 / 9) < 0.02 && x.body.watermark === false && x.body.response_format === "b64_json" && x.body.output_format === "png" && x.body.seed === 42 && !("model" in x.body), short({ ...x.body, image: 1 }));
        x = await run("seedream_5_lite", "text", { width: 3072, height: 2048, aspect: "3:2" });
        const [lw, lh] = x.body.size.split("x").map(Number);
        check("Seedream Lite text: no image, 3:2 inside 3.7 to 9.4 MP", !("image" in x.body) && lw * lh >= 3686400 && lw * lh <= 9437184 && Math.abs(lw / lh - 1.5) < 0.01, x.body.size);
        // Qwen
        x = await run("qwen_image_edit", "edit", { references: [pngOf(512, 512, 64, "REF1")] });
        const c = x.body.input.messages[0].content;
        check("Qwen edit: the pictures then the instruction in one user message, size W*H, prompt rewriting and watermark off, seed and negative prompt; the answer's image link downloaded", c.length === 3 && tagOf(fromDataUrl(c[0].image).bytes) === "CROP" && tagOf(fromDataUrl(c[1].image).bytes) === "REF1" && c[2].text === "Edit image 1 and keep its size and framing. a red door Image 2 is a reference image." && x.body.parameters.size === "1024*768" && x.body.parameters.prompt_extend === false && x.body.parameters.watermark === false && x.body.parameters.seed === 42 && x.body.parameters.negative_prompt === "blurry" && x.body.parameters.n === 1 && tagOf(x.out.bytes) === "ASSET", short([c[2] && c[2].text, x.body.parameters]));
        x = await run("seedream_5_lite", "edit", { references: [pngOf(512, 512, 64, "ORIG"), pngOf(512, 512, 64, "REF1"), pngOf(512, 512, 64, "REF2")], original: 1 });
        check("Seedream edit with the Original and two references: the Original named as the crop before the fill, the references in range words", x.body.prompt === "Edit image 1 and keep its size and framing. a red door Image 2 is image 1 before the selected area was filled. Images 3 and 4 are reference images." && x.body.image.length === 4, x.body.prompt);
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

        // a text run with references (26f): textLayout, the check, the markers named from 1, then the adapter
        const nb = variant("nano_banana_2"), gv = variant("grok_imagine");
        const T = (tag) => new Uint8Array(pngOf(512, 512, 64, tag));
        const tbase = { provider: "comfyrouter", model: nb.model, kind: "text", options: nb.options, prompt: "the coat of {@ref:1} on the person of {@ref:0}", negative: "", seed: 3, width: 1024, height: 1024, aspect: "1:1", image: null, mask: null, maskAlpha: null, references: [T("TREF1"), T("TREF2")], original: 0, params: {}, refName: "image {n}" };
        const x4 = await viaIndex(tbase);
        const tp = x4.s.submits[0] && x4.s.submits[0].body.contents[0].parts;
        check("index.edit, a Gemini text run with 2 references: the markers become image 2 and image 1, the reference sentence after the prompt, both references sent after their labels, no note", !x4.err && !!tp && tp.length === 5 && tp[0].text === "the coat of image 2 on the person of image 1 Images 1 and 2 are reference images." && tp[1].text === "Image 1:" && tagOf(Buffer.from(tp[2].inlineData.data, "base64")) === "TREF1" && x4.out.prompt === "the coat of image 2 on the person of image 1" && eq(x4.out.notes, []), x4.err || short(tp && tp.map((p) => p.text || "picture")));
        const x5 = await viaIndex({ ...tbase, model: gv.model, options: gv.options, prompt: "a lighthouse" });
        check("... on Grok: the drop, the prompt alone to the Router, a note", !x5.err && x5.s.submits.length === 1 && x5.out.info.pictures === 0 && eq(x5.out.notes, ["Comfy Router xai/grok-imagine-image-2.0: this model takes no reference images for a new image; 2 reference layers not sent."]), x5.err || short(x5.out && x5.out.notes));
        const x6 = await viaIndex({ ...tbase, model: gv.model, options: gv.options });
        check("... and with a marker in the prompt: refused before any call", /this model takes no reference images for a new image, so the prompt cannot name a reference image/.test(x6.err || "") && x6.s.calls.length === 0, x6.err);
        check("index.js logged no key", !JSON.stringify(logged).includes(KEY), `${logged.length} records`);
    });

    // ---- 10. HY Image 3.5 through the Partner API ----
    await section("10. HY Image through the Partner API", async () => {
        const recipe = loadRecipes().find((r) => r.id === "hy_image_3_5");
        const v = recipe && recipe.providers.comfypartner;
        check("the recipe: one comfypartner variant, its default, an instruction edit, a text shape of the same model, crops held to 2048 px and 4.2 MP", !!v && recipe.default === "comfypartner" && eq(recipe.providerIds, ["comfypartner"]) && v.model === "hy-image-v3.5-preview" && v.input === "edit" && v.text && v.text.model === v.model && v.limits.max === 2048 && v.limits.pixels === 4194304 && /run against the live API on 2026-09-23/.test(v.note) && /not a documented public API/.test(v.note), short(v && { limits: v.limits, text: v.text }));
        // refName: the recipe's refs.name, as runProvider sends it
        check("the recipe names its pictures as the node does: refs.name Image {n}", !!v && !!v.refs && v.refs.name === "Image {n}", short(v && v.refs));
        const req = (extra = {}) => ({ provider: "comfypartner", model: v.model, kind: "edit", options: v.options, prompt: "put @image2 on the table", negative: "", seed: 42, image: pngOf(1024, 768, 96, "CROP"), mask: null, maskAlpha: null, width: 1024, height: 768, references: [pngOf(512, 512, 64, "REF1")], params: defaults(v), refName: v.refs && v.refs.name, ...extra });
        const s = fakeServer();
        const ctx = ctxFor(s);
        const out = await partner.edit(req(), ctx);
        const b = s.hy[0] && s.hy[0].body;
        const content = b ? b.messages[0].content : [];
        check("an edit: one storage request per picture with the key and its type, the bytes PUT to the signed URL without the key, in order", s.storage.length === 2 && s.storage.every((c) => c.headers["x-api-key"] === KEY && c.body.content_type === "image/png" && /\.png$/.test(c.body.file_name)) && s.uploads.length === 2 && tagOf(s.uploads[0].bytes) === "CROP" && tagOf(s.uploads[1].bytes) === "REF1" && s.uploads.every((c) => !c.headers["x-api-key"] && c.headers["content-type"] === "image/png"), short(s.calls.map((c) => c.method + " " + c.url)));
        check("then one generation request: the model, a user message of the text and the two download URLs, the crop's size, resize_max_pixels for Detail standard, the seed, no watermark", !!b && b.model === "hy-image-v3.5-preview" && b.messages.length === 1 && b.messages[0].role === "user" && content[0].type === "text" && content[1].image_url.url === `${BASE}/stored/1.png?sig=def` && content[2].image_url.url === `${BASE}/stored/2.png?sig=def` && b.size === "1024x768" && b.resize_max_pixels === 1048576 && b.seed === 42 && b.logo_add === 0 && eq(Object.keys(b).sort(), ["logo_add", "messages", "model", "resize_max_pixels", "seed", "size"]), short(b && { ...b, messages: content.map((x) => x.type) }));
        check("the text: the crop is Image 1, @image2 became Image 2, the reference is named", !!b && content[0].text === "Edit Image 1 and keep its size and framing. put Image 2 on the table Image 2 is a reference image.", content[0] && content[0].text);
        check("the generation request carries the key, a UUID Idempotency-Key and JSON; the answer's picture is fetched without the key", s.hy[0].headers["x-api-key"] === KEY && s.hy[0].headers["idempotency-key"] === ctx.uuids[0] && s.assets.length === 1 && eq(Object.keys(s.assets[0].headers), []) && tagOf(out.bytes) === "ASSET" && out.info.answered === "1024x768" && out.info.detail === "standard" && out.seed === 42, short(out.info));

        const s2 = fakeServer();
        await partner.edit(req({ params: { reference_detail: "high" }, references: [], prompt: "make it night" }), ctxFor(s2));
        check("Detail high: resize_max_pixels 4194304; one picture, no reference sentence", s2.hy[0].body.resize_max_pixels === 4194304 && s2.hy[0].body.messages[0].content.length === 2 && s2.hy[0].body.messages[0].content[0].text === "Edit Image 1 and keep its size and framing. make it night", short(s2.hy[0].body.messages[0].content[0]));
        const s2b = fakeServer();
        await partner.edit(req({ references: [pngOf(512, 512, 64, "ORIG"), pngOf(512, 512, 64, "REF1"), pngOf(512, 512, 64, "REF2")], original: 1, prompt: "put @image3 on the table" }), ctxFor(s2b));
        const t2b = s2b.hy[0] && s2b.hy[0].body.messages[0].content[0].text;
        check("the Original on: @image3 still names picture 3, the Original is named as Image 1 before the fill, the references in range words", t2b === "Edit Image 1 and keep its size and framing. put Image 3 on the table Image 2 is Image 1 before the selected area was filled. Images 3 and 4 are reference images." && s2b.uploads.length === 4, t2b);
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

        // Generate new with reference layers (26f): the references alone, uploaded in order, the node's @ImageN kept
        const T1 = pngOf(512, 512, 64, "TREF1"), T2 = pngOf(600, 400, 64, "TREF2");
        const textWith = (refs, prompt = "the coat of @image2 on the person of @image1") => ({ ...req({ kind: "text", image: null, references: refs, prompt }), width: 1536, height: 1024 });
        const s18 = fakeServer();
        const o18 = await partner.generate(textWith([T1, T2]), ctxFor(s18));
        const b18 = s18.hy[0] && s18.hy[0].body;
        const c18 = b18 ? b18.messages[0].content : [];
        check("Generate new with 2 references: one storage request and one upload per reference in order, no crop; the text, then the two URLs; the asked size; resize_max_pixels for Detail standard", s18.storage.length === 2 && eq(s18.uploads.map((u) => tagOf(u.bytes)), ["TREF1", "TREF2"]) && c18.length === 3 && c18[1].image_url.url === `${BASE}/stored/1.png?sig=def` && c18[2].image_url.url === `${BASE}/stored/2.png?sig=def` && b18.size === partner._sizeFor(1536, 1024) && b18.resize_max_pixels === 1048576 && o18.info.pictures === 2 && o18.info.detail === "standard", short(b18 && { ...b18, messages: c18.map((x) => x.type) }));
        check("... the text: @image2 and @image1 as Image 2 and Image 1, then the reference sentence in the recipe's names (no Edit sentence)", c18[0] && c18[0].text === "the coat of Image 2 on the person of Image 1 Images 1 and 2 are reference images.", c18[0] && c18[0].text);
        const tl = partner.textLayout(textWith([T1, T2]));
        check("textLayout: the references at messages[0].content[1] and [2], no crop, max 5 (the edit's)", eq(tl.pictures.map((p) => [p.role, p.ref, p.field, p.n]), [["reference", 0, "messages[0].content[1]", 1], ["reference", 1, "messages[0].content[2]", 2]]) && tl.max === 5 && tl.max === partner.layout(req()).max && !refsLib.checkLayout(tl, textWith([T1, T2])).drops, short(tl));
        const s19 = fakeServer();
        const e19 = await throws(() => partner.generate(textWith([T1, T2, T1, T2, T1, T2], "a lighthouse"), ctxFor(s19)));
        check("six references for a new image: refused in words before any call", e19 === "HY Image 3.5 takes at most 5 reference pictures for a new image; this run has 6: hide reference layers." && s19.calls.length === 0, e19);
        const s20 = fakeServer();
        const e20 = await throws(() => partner.generate(textWith([T1, T2], "use @Image3"), ctxFor(s20)));
        check("@Image3 with two references: refused before any call", /names @Image3, but only 2 pictures go in/.test(e20 || "") && s20.calls.length === 0, e20);
        const s22 = fakeServer();
        await partner.generate(textWith([T1], "a lighthouse"), ctxFor(s22, { opaque: () => false }));
        check("a reference with transparency goes as JPEG (the node sends no alpha); one reference, one sentence", s22.storage[0].body.content_type === "image/jpeg" && tagOf(s22.uploads[0].bytes) === "JPEG" && s22.hy[0].body.messages[0].content[0].text === "a lighthouse Image 1 is a reference image.", short(s22.hy[0] && s22.hy[0].body.messages[0].content[0]));
    });

    // ---- 11. Comfy Cloud: the pictures each partner node takes ----
    await section("11. Comfy Cloud pictures per node", async () => {
        const cv = (id) => rawRecipe(id).providers.comfycloud;
        const cloudReq = (id, extra = {}) => {
            const v = cv(id);
            return { provider: "comfycloud", model: v.model, kind: v.input === "edit" ? "edit" : "fill", options: v.options, prompt: "a red door", negative: "", seed: 42, image: pngOf(1024, 768, 96, "CROP"), mask: pngOf(1024, 768, 96, "MASK-LUMINANCE"), maskAlpha: null, width: 1024, height: 768, references: [], params: {}, ...extra };
        };
        const refsN = (n) => Array.from({ length: n }, (_, i) => pngOf(64, 64, 64, "R" + i));
        // the upload route of cloud.comfy.org, answering each file's name; nothing else is asked by buildGraph
        const cloudCtx = () => {
            const uploads = [];
            return { uploads, key: KEY, fetch: async (url, init = {}) => {
                const u = new URL(String(url));
                if (String(init.method).toUpperCase() !== "POST" || u.pathname !== "/api/upload/image") return json(404, { error: "no route " + u.pathname });
                const file = init.body.get("image");
                uploads.push(tagOf(Buffer.from(await file.arrayBuffer())));
                return json(200, { name: `u${uploads.length}.png`, subfolder: "", type: "input" });
            } };
        };
        const maxOf = (id, model) => cloud.layout(cloudReq(id, model ? { model } : {})).max;
        check("each node's picture count as its source says: GPT Image 16, Nano Banana 2 14, Seedream 5.0 lite 14 and pro 10, FLUX.2 8, Qwen 3", maxOf("gpt_image_2") === 16 && maxOf("nano_banana_2") === 14 && maxOf("nano_banana_2_lite") === 14 && maxOf("seedream_5_lite") === 14 && maxOf("seedream_5_pro") === 10 && maxOf("flux2_pro") === 8 && maxOf("flux2_max") === 8 && maxOf("qwen_image_edit") === 3, short(["gpt_image_2", "nano_banana_2", "seedream_5_lite", "seedream_5_pro", "flux2_pro", "qwen_image_edit"].map((id) => `${id} ${maxOf(id)}`)));
        const one = cloud.layout(cloudReq("nano_banana_pro", { references: refsN(2) })), fill = cloud.layout(cloudReq("flux1_fill", { references: refsN(2) }));
        check("the one-picture Gemini node and FLUX.1 Fill declare the drop, the crop alone numbered", one.drops === "this node takes one picture" && one.max === 1 && refsLib.countOf(one) === 1 && fill.drops === "FLUX.1 Fill takes no reference images" && refsLib.countOf(fill) === 1 && !fill.pictures.some((p) => p.ref != null), short({ one, fill }));
        const oneReq = cloudReq("nano_banana_pro", { references: refsN(2) });
        const chk = refsLib.checkPictures(one, oneReq, "Comfy Cloud " + oneReq.model);
        check("index.js's check strips the references of the one-picture node and says so", chk.req.references.length === 0 && eq(chk.notes, ["Comfy Cloud gemini-3-pro-image-preview: this node takes one picture; 2 reference layers not sent."]), short(chk.notes));

        let c = cloudCtx();
        let g = await cloud._buildGraph(oneReq, c, "GeminiImage2Node");
        const node = (graph, type) => Object.values(graph).find((x) => x.class_type === type);
        const loads = (graph) => Object.values(graph).filter((x) => x.class_type === "LoadImage").length;
        check("GeminiImage2Node called directly with 2 references: the crop alone uploaded and wired, no LoadImage of a reference", eq(c.uploads, ["CROP"]) && loads(g) === 1 && g[node(g, "GeminiImage2Node").inputs.images[0]].inputs.image === "u1.png", short({ uploads: c.uploads, loads: loads(g) }));

        c = cloudCtx();
        const eQ = await throws(() => cloud._buildGraph(cloudReq("qwen_image_edit", { references: refsN(3) }), c, "QwenImageEditApi"));
        check("QwenImageEditApi with the crop and 3 references (4 pictures): refused before any upload, not cut to 3", /Comfy Cloud QwenImageEditApi takes at most 3 pictures; this run has 4: hide reference layers or turn Original off\./.test(eQ || "") && c.uploads.length === 0, eQ);
        c = cloudCtx();
        g = await cloud._buildGraph(cloudReq("qwen_image_edit", { references: refsN(2), original: 1 }), c, "QwenImageEditApi");
        const qn = node(g, "QwenImageEditApi").inputs;
        check("QwenImageEditApi with 3 pictures: all uploaded in order and wired as image_1 .. image_3", eq(c.uploads, ["CROP", "R0", "R1"]) && ["model.images.image_1", "model.images.image_2", "model.images.image_3"].every((k, i) => g[qn[k][0]].inputs.image === `u${i + 1}.png`) && !("model.images.image_4" in qn), short({ uploads: c.uploads, keys: Object.keys(qn).filter((k) => /images/.test(k)) }));
        c = cloudCtx();
        const eF = await throws(() => cloud._buildGraph(cloudReq("flux2_pro", { references: refsN(8) }), c, "Flux2ImageNode"));
        const c7 = cloudCtx();
        g = await cloud._buildGraph(cloudReq("flux2_pro", { references: refsN(7) }), c7, "Flux2ImageNode");
        check("Flux2ImageNode: 9 pictures refused before any upload, 8 go as image_1 .. image_8", /takes at most 8 pictures; this run has 9/.test(eF || "") && c.uploads.length === 0 && c7.uploads.length === 8 && "model.images.image_8" in node(g, "Flux2ImageNode").inputs && !("model.images.image_9" in node(g, "Flux2ImageNode").inputs), eF);
        c = cloudCtx();
        const eM = await throws(() => cloud._buildGraph(cloudReq("flux1_fill", { mask: null }), c, "FluxProFillNode"));
        check("FLUX.1 Fill without a mask: refused before any upload", /needs a selection mask/.test(eM || "") && c.uploads.length === 0, eM);
    });

    // ---- 12. Generate new with reference layers (26f): the references alone, no crop, no mask, the asked size ----
    await section("12. text runs with references", async () => {
        const T1 = pngOf(512, 512, 64, "TREF1"), T2 = pngOf(600, 400, 64, "TREF2");
        const run = async (id, extra = {}, ctxExtra = {}) => {
            const v = variant(id);
            const s = fakeServer();
            const req = textReq(v, extra);
            const out = await router.generate(req, ctxFor(s, ctxExtra));
            return { v, req, out, s, body: s.submits[0].body };
        };
        const without = (o, ...keys) => { const c = { ...o }; for (const k of keys) delete c[k]; return c; };
        const inl = (p) => tagOf(Buffer.from(p.inlineData.data, "base64"));
        const fields = (l) => l.pictures.map((p) => [p.role, p.ref, p.field, p.n]);
        const bad = [];
        const schema = (x) => { const p = schemaProblems(x.v.model, x.body); if (p.length) bad.push(`${x.v.model}: ${p.slice(0, 3).join("; ")}`); };

        // every shipped variant with a text shape: its text layout holds for 2 references (no crop, numbered 1..N), with
        // the edit's cap; xai, ideogram and krea declare the drop
        const shapes = [];
        for (const r of loadRecipes().filter((x) => x.providers && x.providers.comfyrouter && x.task !== "upscale")) {
            const v = r.providers.comfyrouter;
            if (!v.text) continue;
            const req = { ...textReq(v), references: [T1, T2] };
            let l;
            try { l = refsLib.checkLayout(router.textLayout(req), req); } catch (e) { shapes.push(`${r.id}: ${e.message}`); continue; }
            const prov = v.model.split("/")[0];
            if (["xai", "ideogram", "krea"].includes(prov)) { if (l.drops !== "this model takes no reference images for a new image" || l.pictures.length) shapes.push(`${r.id}: ${short(l)}`); continue; }
            const want = +(v.options || {}).max_images > 0 ? +v.options.max_images : 1;
            if (l.drops || refsLib.countOf(l) !== 2 || l.max !== want || l.max !== router.layout(editReq(v)).max) shapes.push(`${r.id}: ${short(l)}`);
            if (!!v.text.refs === !!l.drops) shapes.push(`${r.id}: text.refs ${JSON.stringify(v.text.refs)} against the layout's ${l.drops ? "drop" : "pictures"}`);
        }
        check("each shipped variant's text layout: 2 references numbered 1 and 2 without a crop, the edit's max_images as the cap, text.refs where it takes them; the drop on Grok, Ideogram and Krea", !shapes.length, shapes.join(" | "));
        const fill = router.textLayout({ ...textReq(variant("flux1_fill")), references: [T1] });
        check("FLUX.1 Fill's text layout (it has no text shape): the drop, no crop", fill.drops === "FLUX.1 Fill takes no reference images" && !fill.pictures.length, short(fill));

        // OpenAI: image = the references, no mask, the asked size, the prompt as it is (no sentence on an edit either)
        let x0 = await run("gpt_image_2_5_flare", { width: 2048, height: 1152 });
        let x = await run("gpt_image_2_5_flare", { width: 2048, height: 1152, references: [T1, T2] });
        const op = (x.body.image || []).map(fromDataUrl);
        check("OpenAI text with 2 references: image = the references in order as data URLs, no mask, the asked size, the prompt as it is; the rest as without references", op.length === 2 && tagOf(op[0].bytes) === "TREF1" && tagOf(op[1].bytes) === "TREF2" && !("mask" in x.body) && x.body.size === "2048x1152" && x.body.prompt === "a lighthouse at dusk" && eq(without(x.body, "image"), x0.body) && !("image" in x0.body) && x.out.info.pictures === 2 && x0.out.info.pictures === 0 && eq(fields(router.textLayout(x.req)), [["reference", 0, "image[0]", 1], ["reference", 1, "image[1]", 2]]), short({ ...x.body, image: op.length }));
        schema(x);
        // Gemini (vertexai): the prompt and the reference sentence, a label part before each picture; one picture, no label
        const gp = { aspect_ratio: "auto", image_size: "auto" };
        x0 = await run("nano_banana_2", { params: gp, width: 1536, height: 1024, aspect: "3:2" });
        x = await run("nano_banana_2", { params: gp, width: 1536, height: 1024, aspect: "3:2", references: [T1, T2] });
        const parts = x.body.contents[0].parts;
        check("Gemini text with 2 references: the prompt and \"Images 1 and 2 are reference images.\" (no Edit sentence), a label part before each reference, no crop; the asked aspect and tier as without references", parts.length === 5 && parts[0].text === "a lighthouse at dusk Images 1 and 2 are reference images." && eq([parts[1], parts[3]], [{ text: "Image 1:" }, { text: "Image 2:" }]) && inl(parts[2]) === "TREF1" && inl(parts[4]) === "TREF2" && eq(x.body.generationConfig, x0.body.generationConfig) && eq(x.body.generationConfig.imageConfig, { aspectRatio: "3:2", imageSize: "2K" }) && eq(x0.body.contents[0].parts, [{ text: "a lighthouse at dusk" }]) && eq(fields(router.textLayout(x.req)).map((f) => f[2]), ["contents[0].parts[2]", "contents[0].parts[4]"]), short(parts.map((p) => p.text || inl(p))));
        schema(x);
        x = await run("nano_banana_pro", { params: gp, references: [T1], refName: "<image{n}>" });
        const p1 = x.body.contents[0].parts;
        check("Gemini text with 1 reference under <image{n}>: no label part, the prompt then the sentence in the recipe's name, the picture at part 1", p1.length === 2 && p1[0].text === "a lighthouse at dusk <image1> is a reference image." && inl(p1[1]) === "TREF1" && eq(fields(router.textLayout(x.req)).map((f) => f[2]), ["contents[0].parts[1]"]), short(p1.map((p) => p.text || inl(p))));
        // a free size (no aspect asked): with references the closest aspect goes (else the answer takes a reference's
        // shape), without them the body stays as it was (no aspectRatio)
        x0 = await run("nano_banana_2", { params: gp, width: 2048, height: 1152, aspect: null });
        x = await run("nano_banana_2", { params: gp, width: 2048, height: 1152, aspect: null, references: [T1, T2] });
        check("Gemini text with a free 2048 x 1152 size: with 2 references aspectRatio 16:9 and the 2K tier, without references no aspectRatio", eq(x.body.generationConfig.imageConfig, { aspectRatio: "16:9", imageSize: "2K" }) && eq(x0.body.generationConfig.imageConfig, { imageSize: "2K" }), short([x.body.generationConfig, x0.body.generationConfig]));
        schema(x);
        // FLUX.2 (bfl): input_image .. from the references, the asked width and height, the prompt as it is
        x0 = await run("flux2_pro");
        x = await run("flux2_pro", { references: [T1, T2] });
        check("FLUX.2 text with 2 references: input_image and input_image_2 the references, the asked 1536 x 1024, the prompt as it is, no image or mask field; the rest as without references", tagOf(Buffer.from(x.body.input_image, "base64")) === "TREF1" && tagOf(Buffer.from(x.body.input_image_2, "base64")) === "TREF2" && !("input_image_3" in x.body) && x.body.width === 1536 && x.body.height === 1024 && x.body.prompt === "a lighthouse at dusk" && !("image" in x.body) && !("mask" in x.body) && eq(without(x.body, "input_image", "input_image_2"), x0.body) && eq(fields(router.textLayout(x.req)).map((f) => f[2]), ["input_image", "input_image_2"]), short({ ...x.body, input_image: "..", input_image_2: ".." }));
        schema(x);
        // Seedream (byteplus): image = the references, the reference sentence, the text size
        x0 = await run("seedream_5_pro");
        x = await run("seedream_5_pro", { references: [T1, T2] });
        check("Seedream text with 2 references: image = the references as data URLs, the prompt and the reference sentence, the text run's size; the rest as without references", (x.body.image || []).length === 2 && tagOf(fromDataUrl(x.body.image[0]).bytes) === "TREF1" && tagOf(fromDataUrl(x.body.image[1]).bytes) === "TREF2" && x.body.prompt === "a lighthouse at dusk Images 1 and 2 are reference images." && x0.body.prompt === "a lighthouse at dusk" && eq(without(x.body, "image", "prompt"), without(x0.body, "prompt")) && eq(fields(router.textLayout(x.req)).map((f) => f[2]), ["image[0]", "image[1]"]), short({ ...x.body, image: 2 }));
        schema(x);
        // Qwen: the references, then the prompt and the sentence, in one message
        x0 = await run("qwen_image_edit");
        x = await run("qwen_image_edit", { references: [T1, T2] });
        const qc = x.body.input.messages[0].content;
        check("Qwen text with 2 references: the references then the prompt and the reference sentence in one message; the parameters as without references", qc.length === 3 && tagOf(fromDataUrl(qc[0].image).bytes) === "TREF1" && tagOf(fromDataUrl(qc[1].image).bytes) === "TREF2" && qc[2].text === "a lighthouse at dusk Images 1 and 2 are reference images." && eq(x.body.parameters, x0.body.parameters) && eq(x0.body.input.messages[0].content, [{ text: "a lighthouse at dusk" }]) && eq(fields(router.textLayout(x.req)).map((f) => f[2]), ["input.messages[0].content[0]", "input.messages[0].content[1]"]), short(qc.map((c) => c.text || tagOf(fromDataUrl(c.image).bytes))));
        schema(x);
        check("every text body with references holds against the model's published schema", !bad.length, bad.join(" | "));

        // the models that take no picture: the drop, and a direct call sends the prompt alone
        const gReq = { ...textReq(variant("grok_imagine")), references: [T1, T2] };
        const gLay = router.textLayout(gReq);
        const gChk = refsLib.checkPictures(gLay, gReq, "Comfy Router " + gReq.model);
        x0 = await run("grok_imagine");
        x = await run("grok_imagine", { references: [T1, T2] });
        check("Grok with 2 references: index.js's check strips both and says so; called directly, the body as without references", gChk.req.references.length === 0 && eq(gChk.notes, ["Comfy Router xai/grok-imagine-image-2.0: this model takes no reference images for a new image; 2 reference layers not sent."]) && eq(x.body, x0.body) && x.out.info.pictures === 0, short({ notes: gChk.notes, pictures: x.out.info.pictures }));

        // refusals before any call
        const four = [T1, T2, pngOf(512, 512, 64, "TREF3"), pngOf(512, 512, 64, "TREF4")];
        const qReq = { ...textReq(variant("qwen_image_edit")), references: four };
        const qLay = router.textLayout(qReq);
        let eChk = null;
        try { refsLib.checkPictures(qLay, qReq, "Comfy Router " + qReq.model); } catch (e) { eChk = e.message; }
        const sCap = fakeServer();
        const eCap = await throws(() => router.generate(qReq, ctxFor(sCap)));
        const want = "Comfy Router qwen/qwen-image-3.0 takes at most 3 reference pictures for a new image; this run has 4: hide reference layers.";
        check("Qwen text with 4 references (it takes 3): the text layout's cap is the edit's 3; index.js's check and the adapter both refuse in the same words before any call", qLay.max === 3 && eChk === want && eCap === want && sCap.calls.length === 0, short([eChk, eCap]));
        const sBig = fakeServer();
        const eBig = await throws(() => router.generate(textReq(variant("seedream_5_lite"), { references: [pngOf(3000, 2000, 10_000_001, "BIGREF", 2)] }), ctxFor(sBig, { opaque: () => false })));
        check("a reference over the model's bytes with transparency: refused before any call, without the edit's Highres fix advice", /the reference 1 is 9\.5 MB, more than the 10 MB a picture may have \(it has transparency, so it stays PNG\)\. Use a smaller reference layer\.$/.test(eBig || "") && sBig.calls.length === 0, eBig);
        const x2 = await run("seedream_5_lite", { references: [pngOf(3000, 2000, 10_000_001, "BIGREF", 2)] });
        check("... an opaque one goes as JPEG", fromDataUrl(x2.body.image[0]).mime === "image/jpeg" && tagOf(fromDataUrl(x2.body.image[0]).bytes) === "JPEG", short(fromDataUrl(x2.body.image[0]).mime));
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
