// The ToAPIs adapter (electron/main/providers/toapis.js) in plain Node, no Electron and no key:
//   node tools/toapis_test.js
// A scripted fetch plays toapis.com and its file host; ctx.sleep and ctx.random make the polling instant and
// its waits visible. Run by tools/toapis_test.py as its first step (layer 1 of the ToAPIs design; layer 2 drives
// the app against tools/toapis_mock.py).
"use strict";

const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const toapis = require(path.join(ROOT, "electron", "main", "providers", "toapis.js"));

const KEY = "sk-test-0123456789abcdef";
const results = [];
function check(what, ok, detail) {
    results.push(ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function variant(id) {
    const r = require(path.join(ROOT, "recipes", id + ".json"));
    return r.providers.toapis;
}

const png = (tag, size) => { const b = Buffer.alloc(size || 64, 0); b.write(tag); return b; };

/**
 * A fake toapis.com. `script` answers submits and polls in order; uploads always succeed unless
 * `uploadAnswer` says otherwise. Every call is recorded with its URL, method, headers and body.
 */
function fakeServer(opts = {}) {
    const calls = [];
    const uploads = [];
    const submits = [];
    const polls = [...(opts.polls || [{ status: "completed", result: { type: "image", data: [{ url: "https://files.toapis.com/generated/out.png" }] } }])];
    const submitAnswers = [...(opts.submits || [])];
    let n = 0;
    const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
    async function fetch(url, init = {}) {
        const method = (init.method || "GET").toUpperCase();
        const headers = { ...(init.headers || {}) };
        const call = { url: String(url), method, headers, body: init.body };
        calls.push(call);
        const u = new URL(String(url));
        if (u.hostname === "files.toapis.com") return new Response(png("RESULT"), { status: 200, headers: { "content-type": "image/png" } });
        if (u.pathname === "/v1/uploads/images" && method === "POST") {
            const file = init.body.get("file");
            const bytes = Buffer.from(await file.arrayBuffer());
            const i = ++n;
            uploads.push({ name: file.name, type: file.type, bytes, url: `https://files.toapis.com/uploads/1/${i}_${file.name}` });
            if (opts.uploadAnswer) return opts.uploadAnswer(uploads[uploads.length - 1]);
            return json(200, { success: true, message: "", data: { id: "upload_" + i, url: uploads[uploads.length - 1].url, mime_type: file.type, size: bytes.length } });
        }
        if (u.pathname === "/v1/images/generations" && method === "POST") {
            submits.push(JSON.parse(init.body));
            const a = submitAnswers.shift();
            if (a) return a();
            return json(200, { id: "tsk_img_test", object: "generation.task", model: submits[submits.length - 1].model, status: "queued", progress: 0 });
        }
        if (u.pathname.startsWith("/v1/images/generations/") && method === "GET") {
            const a = polls.length > 1 ? polls.shift() : polls[0];
            if (typeof a === "function") return a();
            return json(200, { id: decodeURIComponent(u.pathname.split("/").pop()), object: "generation.task", ...a });
        }
        if (u.pathname === "/v1/balance") return opts.balance ? opts.balance() : json(200, { success: true, remain_balance: 10.5, remain_credits: 2100, credits_per_usd: 200, unlimited_quota: false });
        return json(404, { error: { message: "no route " + u.pathname } });
    }
    return { fetch, calls, uploads, submits, json };
}

function ctxFor(server, extra = {}) {
    const sleeps = [];
    return { key: KEY, fetch: server.fetch, log() {}, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, sleeps, ...extra };
}

function editReq(v, extra = {}) {
    return {
        provider: "toapis", model: v.model, kind: v.input === "edit" ? "edit" : "fill", options: v.options, fields: v.fields || null,
        prompt: "a red door", negative: "", seed: 42,
        image: png("CROP"), mask: png("MASK-LUMINANCE"), maskAlpha: png("MASK-ALPHA"),
        width: 1536, height: 1024, references: [], params: {}, ...extra,
    };
}

async function throws(fn) {
    try { await fn(); } catch (err) { return String(err && err.message || err); }
    return null;
}

async function main() {
    // ---- 1. fill on the official GPT Image 2 channel, then the same recipe on its other channels ----
    {
        const v = variant("gpt_image_2");
        const s = fakeServer();
        const ctx = ctxFor(s);
        const out = await toapis.edit(editReq(v, { references: [png("REF1")], params: { channel: "official", quality: "high", resolution: "auto", background: "auto" } }), ctx);
        const b = s.submits[0];
        const byName = (re) => s.uploads.find((u) => re.test(u.name));
        const crop = byName(/-crop\.png$/), ref = byName(/-ref1\.png$/), mask = byName(/-mask\.png$/);
        check("official: the crop, the reference and the alpha mask are uploaded", s.uploads.length === 3 && !!crop && !!ref && !!mask, s.uploads.map((u) => u.name).join(", "));
        check("official: the mask upload is maskAlpha, not the luminance mask", !!mask && mask.bytes.equals(png("MASK-ALPHA")), mask && mask.bytes.toString("latin1", 0, 14));
        check("official: image_urls holds the crop first, then the reference; mask_url the mask", !!crop && eq(b.image_urls, [crop.url, ref.url]) && b.mask_url === mask.url, JSON.stringify({ image_urls: b.image_urls, mask_url: b.mask_url }));
        check("official: model, size as the reduced ratio, tier from the long side, no channel / auto fields", b.model === "gpt-image-2-official" && b.size === "3:2" && b.resolution === "2k" && b.quality === "high" && b.n === 1 && !("channel" in b) && !("background" in b), JSON.stringify(b));
        check("official: the answer is the downloaded file, info names model, channel and task", out.bytes.equals(png("RESULT")) && out.info.model === "gpt-image-2-official" && out.info.channel === "official" && out.info.task === "tsk_img_test", JSON.stringify(out.info));
        const tiers = [];
        for (const [w, h] of [[1024, 768], [2048, 1152], [2560, 1440], [4000, 1400], [700, 3000]]) tiers.push([w, h, toapis._size({ kind: "fill", width: w, height: h }, toapis._channel(editReq(v, { params: { channel: "official" } })))]);
        check("official: tiers 1k / 2k / 4k by the long side, ratios in lowest terms, clamped to 3:1", eq(tiers.map((t) => [t[2].size, t[2].tier]), [["4:3", "1k"], ["16:9", "2k"], ["16:9", "4k"], ["20:7", "4k"], ["1:3", "4k"]]), JSON.stringify(tiers));

        const s2 = fakeServer();
        await toapis.edit(editReq(v, { width: 1000, height: 700, params: { channel: "standard", quality: "high", background: "opaque" } }), ctxFor(s2));
        const b2 = s2.submits[0];
        check("standard: no mask upload, no mask_url, a preset ratio, no quality, no opaque background", s2.uploads.length === 1 && !("mask_url" in b2) && b2.model === "gpt-image-2" && b2.size === "3:2" && !("quality" in b2) && !("background" in b2), JSON.stringify(b2));
        const s3 = fakeServer();
        await toapis.edit(editReq(v, { width: 1000, height: 700, params: { channel: "vip", background: "transparent" } }), ctxFor(s3));
        const b3 = s3.submits[0];
        check("vip: no mask, the exact ratio, a transparent background passes", s3.uploads.length === 1 && !("mask_url" in b3) && b3.model === "gpt-image-2-vip" && b3.size === "10:7" && b3.background === "transparent", JSON.stringify(b3));
        const e = await throws(() => toapis.edit(editReq(v, { params: { channel: "cheapest" } }), ctxFor(fakeServer())));
        check("an unknown channel is refused", !!e && /no channel "cheapest"/.test(e), e);
    }

    // ---- 2. shapes: objects, metadata nesting, a text run, pixel sizes with seed and negative ----
    {
        const v = variant("nano_banana_2");
        const s = fakeServer();
        await toapis.edit(editReq(v, { width: 2048, height: 1152, params: { channel: "standard", "metadata.resolution": "auto" } }), ctxFor(s));
        const b = s.submits[0];
        check("nano banana standard: image_urls as [{url}] objects", Array.isArray(b.image_urls) && b.image_urls.length === 1 && typeof b.image_urls[0] === "object" && b.image_urls[0].url === s.uploads[0].url, JSON.stringify(b.image_urls));
        check("nano banana: metadata.resolution nests under metadata", b.metadata && b.metadata.resolution === "2K" && !("metadata.resolution" in b) && b.size === "16:9", JSON.stringify(b));
        const s2 = fakeServer();
        await toapis.edit(editReq(v, { width: 1024, height: 1024, params: { channel: "official", "metadata.resolution": "4K" } }), ctxFor(s2));
        const b2 = s2.submits[0];
        check("nano banana official: image_urls as strings, a chosen tier is kept", typeof b2.image_urls[0] === "string" && b2.metadata.resolution === "4K" && b2.model === "gemini-3.1-flash-image-official", JSON.stringify(b2));
        const s3 = fakeServer();
        await toapis.generate({ ...editReq(v, { kind: "text", image: null, mask: null, maskAlpha: null, width: 2048, height: 1152, aspect: "16:9", params: { channel: "official" } }) }, ctxFor(s3));
        const b3 = s3.submits[0];
        check("a text run uploads nothing and sends the asked aspect with the tier", s3.uploads.length === 0 && !s3.calls.some((c) => /uploads/.test(c.url)) && !("image_urls" in b3) && b3.size === "16:9" && b3.metadata.resolution === "2K", JSON.stringify(b3));
        const q = variant("qwen_image_edit");
        const s4 = fakeServer();
        await toapis.edit(editReq(q, { width: 1536, height: 864, negative: "blurry", seed: 7, params: { ...q.fixed, channel: "pro" } }), ctxFor(s4));
        const b4 = s4.submits[0];
        check("qwen: pixels, seed and negative under metadata next to prompt_extend false", b4.model === "qwen-image-3.0-pro" && b4.size === "1536x864" && b4.metadata && b4.metadata.seed === 7 && b4.metadata.negative_prompt === "blurry" && b4.metadata.prompt_extend === false, JSON.stringify(b4));
        const e = await throws(() => toapis.edit(editReq(q, { references: [png("R1"), png("R2"), png("R3")] }), ctxFor(fakeServer())));
        check("qwen: more images than the model takes are refused before any request", !!e && /takes 3 images/.test(e), e);
        const g = variant("gpt_image_2_5_flare");
        const s5 = fakeServer();
        await toapis.edit(editReq(g, { width: 320, height: 240, params: { channel: "official", quality: "xhigh", background: "auto" } }), ctxFor(s5));
        const b5 = s5.submits[0];
        const [pw, ph] = b5.size.split("x").map(Number);
        check("gpt 2.5 official: a pixel size grown to 655,360 px in 16 px steps, quality passes", pw % 16 === 0 && ph % 16 === 0 && pw * ph >= 655360 && b5.quality === "xhigh" && !("resolution" in b5), JSON.stringify(b5));
        const s6 = fakeServer();
        await toapis.edit(editReq(g, { width: 2048, height: 1536, params: { channel: "standard", quality: "max" } }), ctxFor(s6));
        const b6 = s6.submits[0];
        check("gpt 2.5 standard: a preset ratio, the 2K tier, no quality", b6.model === "gpt-image-2.5-flare" && b6.size === "4:3" && b6.resolution === "2K" && !("quality" in b6), JSON.stringify(b6));
    }

    // ---- 3. polling: queued, a 429 with Retry-After, in progress, completed; both result shapes; a submit 429 ----
    {
        const v = variant("flux2_pro");
        const s = fakeServer({ polls: [
            { status: "queued" },
            () => new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Async task request rate exceeded" } }), { status: 429, headers: { "retry-after": "7" } }),
            { status: "in_progress", progress: 50 },
            { status: "completed", result: { type: "image", data: [{ url: "https://files.toapis.com/generated/a.png" }] } },
        ] });
        const ctx = ctxFor(s);
        const out = await toapis.edit(editReq(v), ctx);
        const polls = s.calls.filter((c) => c.method === "GET" && /generations\//.test(c.url)).length;
        check("polling survives queued, a 429 and in_progress", out.bytes.equals(png("RESULT")) && polls === 4, `${polls} polls`);
        check("the first poll waits 4 s, then 5 s plus jitter, and the 429's Retry-After (7 s)", eq(ctx.sleeps, [4000, 5500, 7000, 5500]), JSON.stringify(ctx.sleeps));
        const s2 = fakeServer({ polls: [{ status: "completed", url: "https://files.toapis.com/generated/top.png" }] });
        const out2 = await toapis.edit(editReq(v), ctxFor(s2));
        check("a top-level url is read when result.data is missing", out2.bytes.equals(png("RESULT")) && s2.calls.some((c) => /top\.png$/.test(c.url)), s2.calls.map((c) => c.url).join(" "));
        const s3 = fakeServer({ submits: [() => new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "slow down" } }), { status: 429, headers: { "retry-after": "3" } })] });
        const ctx3 = ctxFor(s3);
        await toapis.edit(editReq(v), ctx3);
        check("a submit answered 429 is sent once more after Retry-After", s3.submits.length === 2 && ctx3.sleeps[0] === 3000, JSON.stringify({ submits: s3.submits.length, sleeps: ctx3.sleeps }));
        let net = 0;
        const s4 = fakeServer({ submits: [() => { net++; throw new TypeError("fetch failed"); }] });
        const e4 = await throws(() => toapis.edit(editReq(v), ctxFor(s4)));
        check("a submit lost to the network is not sent again", !!e4 && net === 1 && s4.submits.length === 1, e4);
    }

    // ---- 4. failures ----
    {
        const v = variant("seedream_5_pro");
        const s = fakeServer({
            polls: [{ status: "failed", billing: { status: "refunded", credits: "0", cost_usd: "0" }, error: { code: "generation_failed", message: "call upstream API failed: upstream returned status 422" } }],
            submits: [() => new Response(JSON.stringify({ id: "tsk_img_fail9", status: "queued" }), { status: 200 })],
        });
        const e = await throws(() => toapis.edit(editReq(v), ctxFor(s)));
        check("a failed task names the model, the task id and the message", !!e && /doubao-seedream-5-0-pro/.test(e) && /tsk_img_fail9/.test(e) && /upstream returned status 422/.test(e), e);
        const s2 = fakeServer({ uploadAnswer: () => new Response(JSON.stringify({ success: false, message: "Unsupported image type. Allowed: JPEG, PNG, WebP, GIF" }), { status: 200 }) });
        const e2 = await throws(() => toapis.edit(editReq(v), ctxFor(s2)));
        check("an upload answering success:false is thrown with its message", !!e2 && /Unsupported image type/.test(e2) && s2.submits.length === 0, e2);
        const s3 = fakeServer({ submits: [() => new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "余额不足" } }), { status: 402 })] });
        const e3 = await throws(() => toapis.edit(editReq(v), ctxFor(s3)));
        check("a 402 reads balance too low, with the server's own words", !!e3 && /balance too low/.test(e3) && /余额不足/.test(e3), e3);
        const s4 = fakeServer({ polls: [() => new Response(JSON.stringify({ error: { code: 404, message: "Task not found", type: "not_found_error" } }), { status: 404 })] });
        const e4 = await throws(() => toapis.edit(editReq(v), ctxFor(s4)));
        check("a lost task is an error with its id", !!e4 && /tsk_img_test/.test(e4) && /Task not found/.test(e4), e4);
    }

    // ---- 5. the 10 MB guard ----
    {
        const v = variant("gpt_image_2");
        const big = png("BIGCROP", 11 * 1024 * 1024);
        const jpegCalls = [];
        const s = fakeServer();
        await toapis.edit(editReq(v, { image: big, params: { channel: "official" } }), ctxFor(s, { toJpeg: async (b, q) => { jpegCalls.push([b.length, q]); return png("JPEG", 2 * 1024 * 1024); } }));
        const crop = s.uploads.find((u) => /-crop\./.test(u.name));
        check("an 11 MB crop goes up as a JPEG through toJpeg (quality 92)", jpegCalls.length === 1 && jpegCalls[0][1] === 92 && crop && crop.type === "image/jpeg" && /\.jpg$/.test(crop.name) && crop.bytes.length === 2 * 1024 * 1024, JSON.stringify({ jpegCalls, crop: crop && [crop.name, crop.type, crop.bytes.length] }));
        const s2 = fakeServer();
        const e2 = await throws(() => toapis.edit(editReq(v, { maskAlpha: png("MASK", 11 * 1024 * 1024), params: { channel: "official" } }), ctxFor(s2, { toJpeg: async () => png("J") })));
        check("an 11 MB mask is refused before any request (a mask is never re-encoded)", !!e2 && /mask is 11\.0 MB/.test(e2) && s2.calls.length === 0, e2);
        const s3 = fakeServer();
        const e3 = await throws(() => toapis.edit(editReq(v, { image: big }), ctxFor(s3, { toJpeg: async () => png("STILLBIG", 10 * 1024 * 1024 + 1) })));
        check("a crop still over 10 MB as JPEG is refused before any request", !!e3 && /set Highres fix lower/.test(e3) && s3.calls.length === 0, e3);
        const s4 = fakeServer();
        const e4 = await throws(() => toapis.edit(editReq(v, { references: [png("BIGREF", 11 * 1024 * 1024)] }), ctxFor(s4, { toJpeg: async () => png("J") })));
        check("an 11 MB reference is refused before any request (it keeps its PNG)", !!e4 && /reference 1 is 11\.0 MB/.test(e4) && s4.calls.length === 0, e4);
    }

    // ---- 6. the key, the host and the balance ----
    {
        const v = variant("gpt_image_2");
        const s = fakeServer();
        await toapis.edit(editReq(v, { references: [png("R")], params: { channel: "official" } }), ctxFor(s));
        const api = s.calls.filter((c) => new URL(c.url).hostname === "toapis.com");
        const files = s.calls.filter((c) => new URL(c.url).hostname === "files.toapis.com");
        check("every toapis.com call carries the key", api.length >= 5 && api.every((c) => c.headers.Authorization === "Bearer " + KEY), api.map((c) => c.method + " " + c.url).join(", "));
        check("the result download carries no key", files.length === 1 && !Object.keys(files[0].headers).some((k) => /authorization/i.test(k)) && !JSON.stringify(files[0].headers).includes(KEY), JSON.stringify(files.map((c) => c.headers)));
        const s2 = fakeServer({ submits: [() => new Response(JSON.stringify({ error: { code: 401, message: "Invalid token " + KEY, type: "authentication_error" } }), { status: 401 })] });
        const e2 = await throws(() => toapis.edit(editReq(v), ctxFor(s2)));
        check("a refused key reads key refused, and the key never appears in the message", !!e2 && /key refused/.test(e2) && !e2.includes(KEY), e2);
        const s3 = fakeServer();
        const bal = await toapis.balance(ctxFor(s3));
        check("balance: remain_credits / 200 in USD, the key on the call", bal.usd === 10.5 && bal.credits === 2100 && bal.unlimited === false && s3.calls[0].url === "https://toapis.com/v1/balance" && s3.calls[0].headers.Authorization === "Bearer " + KEY, JSON.stringify(bal));
        const s4 = fakeServer({ balance: () => new Response(JSON.stringify({ success: false, message: "Failed to get token info: record not found" }), { status: 200 }) });
        const e4 = await throws(() => toapis.balance(ctxFor(s4)));
        check("balance: success:false is a key that was not found", !!e4 && /key not found/.test(e4), e4);
        const bases = ["https://toapis.com", "https://api.toapis.com/", "https://toapis.cn", "https://api.toapis.cn", "http://127.0.0.1:8123", "http://127.0.0.1", "https://toapis.com/v1", "https://evil.example", "https://toapis.com.evil.example", "http://localhost:8123", "https://user:pw@toapis.com", "http://toapis.com"];
        const got = bases.map((b) => toapis._allowedBase(b));
        check("the base allowlist: the four documented hosts and a loopback port, nothing else", eq(got, ["https://toapis.com", "https://api.toapis.com", "https://toapis.cn", "https://api.toapis.cn", "http://127.0.0.1:8123", null, null, null, null, null, null, null]), JSON.stringify(got));
        const s5 = fakeServer();
        await toapis.balance(ctxFor(s5, { base: "https://evil.example" }));
        check("a base outside the list falls back to toapis.com", s5.calls[0].url === "https://toapis.com/v1/balance", s5.calls[0].url);
        check("baseUrl reads settings.toapis.base through the list", toapis.baseUrl({ toapis: { base: "http://127.0.0.1:9000" } }) === "http://127.0.0.1:9000" && toapis.baseUrl({ toapis: { base: "https://evil.example" } }) === "https://toapis.com" && toapis.baseUrl({}) === "https://toapis.com");
    }

    // ---- 7. every shipped variant, normalised as the app does, on every channel ----
    {
        const orig = Module._load;
        Module._load = function (request, ...rest) {
            if (request === "electron") return { app: { getPath: () => path.join(require("node:os").tmpdir(), "scumble-toapis-test-no-user-recipes") } };
            return orig.call(this, request, ...rest);
        };
        const recipes = require(path.join(ROOT, "electron", "main", "recipes.js"));
        Module._load = orig;
        const list = await recipes.list(path.join(ROOT, "recipes"));
        const served = list.filter((r) => r.providers && r.providers.toapis);
        const want = ["flux2_flex", "flux2_pro", "gpt_image_2", "gpt_image_2_5_flare", "gpt_image_2_5_sunburst", "nano_banana_2", "nano_banana_2_lite", "nano_banana_pro", "qwen_image_edit", "seedream_5_lite", "seedream_5_pro"];
        check("eleven recipes carry a toapis variant", eq(served.map((r) => r.id).sort(), want), served.map((r) => r.id).join(", "));
        const bad = [];
        const homes = { gpt_image_2: "openai", gpt_image_2_5_flare: "openai", gpt_image_2_5_sunburst: "openai", nano_banana_2: "gemini", nano_banana_2_lite: "gemini", nano_banana_pro: "gemini", flux2_pro: "bfl", flux2_flex: "bfl", seedream_5_lite: "fal", seedream_5_pro: "fal", qwen_image_edit: "fal" };
        for (const r of served) {
            const v = r.providers.toapis;
            if (r.providerIds[0] !== "toapis") bad.push(r.id + ": toapis is not first");
            if (r.default !== homes[r.id]) bad.push(r.id + ": the default moved to " + r.default);
            if (!v.text || !v.text.model || !Array.isArray(v.text.sizes)) bad.push(r.id + ": no text shape");
            if (!/files\.toapis\.com/.test(v.note) || !/not run against the live API/.test(v.note)) bad.push(r.id + ": the note lacks the upload or live-test sentence");
            if (!/Also on ToAPIs\./.test(r.description)) bad.push(r.id + ": the description does not say Also on ToAPIs");
            const chRow = v.settings.find((s) => s.key === "channel");
            const chans = v.options.channels;
            if (!!chRow !== !!chans) bad.push(r.id + ": a Channel row without channels or the other way round");
            const values = chRow ? chRow.spec[0] : [""];
            if (chRow && !values.every((x) => chans[x])) bad.push(r.id + ": a Channel row value has no channel: " + values.join(","));
            const tierRow = v.settings.find((s) => s.key === v.options.tier_key);
            for (const value of values) {
                const params = { ...(v.fixed || {}) };
                for (const s of v.settings) params[s.key] = s.spec[1].default;
                if (chRow) params.channel = value;
                const ch = toapis._channel({ model: v.model, options: v.options, params });
                if (tierRow && ch.tiers && !tierRow.spec[0].filter((x) => x !== "auto").every((x) => x in ch.tiers)) bad.push(r.id + "/" + value + ": a Resolution option is no tier of the channel");
                const s = fakeServer();
                const req = { ...editReq(v, { kind: v.input === "edit" ? "edit" : "fill", width: 1024, height: 768, params }) };
                await toapis.edit(req, ctxFor(s));
                const b = s.submits[0];
                if (!b || typeof b.model !== "string" || !b.model || "channel" in b || !b.image_urls || !b.size) bad.push(r.id + "/" + value + ": " + JSON.stringify(b));
                const t = fakeServer();
                await toapis.generate({ ...req, kind: "text", model: v.text.model, image: null, mask: null, maskAlpha: null, aspect: "1:1", width: 1024, height: 1024 }, ctxFor(t));
                if (t.uploads.length || !t.submits[0] || !t.submits[0].size) bad.push(r.id + "/" + value + " text: " + JSON.stringify(t.submits[0]));
            }
        }
        check("every variant: toapis first, the home default kept, a text shape, the notes, each channel builds a request", !bad.length, bad.join("; ") || `${served.length} recipes`);
    }

    const failed = results.filter((x) => !x).length;
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + (err && err.stack || err)); console.log("FAIL"); process.exit(1); });
