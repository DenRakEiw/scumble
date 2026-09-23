// Comfy Partner API: the proxy routes on api.comfy.org that ComfyUI's own Partner Nodes call, for models Comfy serves
// only that way (not through the Router). One model today: Tencent's HY Image 3.5 Preview, which ComfyUI's nodes
// `HunyuanImageEditApi` and `HunyuanImageTextToImageApi` (comfy_api_nodes/nodes_hunyuan_image.py, added 2026-09-22,
// ComfyUI PR #16462) drive. Written from that node's source and ComfyUI's API client (comfy_api_nodes/util/client.py,
// upload_helpers.py, _helpers.py), read on 2026-09-23. **These routes are not a documented public API** like the
// Router: they are what ComfyUI itself sends, and Comfy can change them with a ComfyUI release.
//
//   POST /customers/storage                    { file_name, content_type } -> { upload_url, download_url }
//   PUT  <upload_url>                          the picture's bytes, Content-Type image/png, no key (a signed URL)
//   POST /proxy/tencent/v1/wand/hunyuan-image/v35-generation
//        { model: "hy-image-v3.5-preview", messages: [{ role: "user", content: [{ type: "text", text },
//          { type: "image_url", image_url: { url } } ..] }], size: "WxH", resize_max_pixels, seed, logo_add: 0 }
//        -> { choices: [{ delta: { image: { url, width, height } } }], error: { message, code, type }, request_id }
//
// The key goes as X-API-Key on the two api.comfy.org calls (the node's client sends X-API-KEY; headers are not
// case-sensitive), never on the signed upload or the answer's picture. The same Comfy key as Comfy Cloud and the
// Router (`keyName`), the same host rule (settings.comfyrouter.base may name the loopback mock, and then only a
// "test-" key goes there). Answered in one request; nothing is polled.
"use strict";

const { randomUUID } = require("node:crypto");
const { sleep: realSleep, fitPixels } = require("./util");
const router = require("./comfyrouter");

const { testBase, checkKey, scrub, picturesFor, download, sniff } = router._shared;

const BASE = "https://api.comfy.org";
const HY_PATH = "/proxy/tencent/v1/wand/hunyuan-image/v35-generation";
const HY_MODELS = { "hy-image-v3.5-preview": true };
const HY_MAX_IMAGES = 5;
const HY_MAX_AREA = 16777216;                 // "the total pixel area can be up to 4096x4096"
const HY_DETAIL = { standard: 1048576, high: 4194304 };   // reference_detail: what the model sees of each picture
const DOWNLOAD_RETRIES = 2;                   // the node's INPUT_DOWNLOAD_RETRIES for "download image failed"
const IMAGE_REF = /@image(\d*)(?!\w)/gi;
const BUSINESS_ERROR = /msg:\s*(.+)$/s;

/** @ImageN in the user's prompt becomes "Image N", as the node does; a number past the pictures sent is refused. */
function resolveRefs(prompt, total) {
    return String(prompt || "").replace(IMAGE_REF, (m, n, at, all) => {
        const before = at > 0 ? all[at - 1] : "";
        if (before && /[A-Za-z0-9_]/.test(before)) return m;
        const idx = n ? +n : 1;
        if (idx < 1 || idx > total) throw new Error(`HY Image: the prompt names @Image${idx}, but only ${total} picture${total === 1 ? " goes" : "s go"} in.`);
        return `Image ${idx}`;
    });
}

/** The size as "WxH": both sides multiples of 16, 256..8192 each, at most 4096 x 4096 in area. */
function sizeFor(w, h) {
    const [cw, ch] = fitPixels(Math.max(1, +w || 1024), Math.max(1, +h || 1024), { step: 16, max: 8192, minPixels: 65536, maxPixels: HY_MAX_AREA, maxRatio: 32 });
    return `${Math.max(256, cw)}x${Math.max(256, ch)}`;
}

/** The instruction for an edit: the crop is Image 1, the rest are references. */
function editText(req, pics) {
    const user = resolveRefs(req.prompt, pics.length);
    let out = `Edit Image 1 and keep its size and framing. ${user}`;
    if (pics.length > 1) out += pics.length > 2 ? ` Images 2 to ${pics.length} are reference material.` : " Image 2 is reference material.";
    return out.trim();
}

/** { message } of a failed answer in any of the envelopes Comfy's API uses, the key taken out. */
async function readFailure(r, key) {
    let text = "";
    try { text = await r.text(); } catch (_) { text = ""; }
    text = scrub(text, key);
    let msg = "";
    try {
        const j = JSON.parse(text);
        if (j && typeof j === "object") {
            if (typeof j.error === "string") msg = typeof j.message === "string" && j.message ? j.message : j.error;
            else if (j.error && typeof j.error === "object") msg = String(j.error.message || j.error.type || "");
            if (!msg && typeof j.detail === "string") msg = j.detail;
            if (!msg && typeof j.message === "string") msg = j.message;
        }
    } catch (_) { msg = text.slice(0, 300); }
    return msg || r.statusText || String(r.status);
}

function words(status, msg) {
    if (status === 401) return `key refused: store a key from platform.comfy.org › API keys in the Comfy Cloud row - ${msg}`;
    if (status === 402) return `the Comfy account has no credits left: add credits at platform.comfy.org - ${msg}`;
    if (status === 409) return `Comfy says there is a problem with the account (see support@comfy.org) - ${msg}`;
    if (status === 429) return `rate limited - ${msg}`;
    if (status === 404) return `Comfy no longer serves this route (the Partner API is not a public contract; an update of Scumble may be needed) - ${msg}`;
    if (status >= 500) return `Comfy's service failed - ${msg}`;
    return msg;
}

async function post(ctx, url, body, idem) {
    const headers = { "X-API-Key": ctx.key, "Content-Type": "application/json" };
    if (idem) headers["Idempotency-Key"] = idem;
    return ctx.fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}

/** One picture into Comfy's storage: a signed upload URL, the bytes PUT there without the key, the download URL back. */
async function upload(ctx, host, test, pic, n) {
    const ext = pic.mime === "image/jpeg" ? "jpg" : "png";
    const r = await post(ctx, host + "/customers/storage", { file_name: `scumble-${Date.now()}-${n}.${ext}`, content_type: pic.mime });
    if (!r.ok) throw new Error(scrub(`Comfy Partner API storage: ${words(r.status, await readFailure(r, ctx.key))}`, ctx.key));
    const j = (await r.json().catch(() => null)) || {};
    const up = String(j.upload_url || ""), down = String(j.download_url || "");
    const okUrl = (u) => /^https:\/\//i.test(u) || (test && u.startsWith(test + "/"));
    if (!okUrl(up) || !okUrl(down)) throw new Error(`Comfy Partner API storage answered without usable URLs (${scrub(JSON.stringify(j), ctx.key).slice(0, 200)})`);
    const put = await ctx.fetch(up, { method: "PUT", headers: { "Content-Type": pic.mime }, body: pic.bytes });
    if (!put.ok) throw new Error(scrub(`Comfy Partner API: the upload of the ${pic.what} failed (${put.status})`, ctx.key));
    return down;
}

async function run(req, ctx, kind) {
    ctx = { ...ctx, sleep: ctx.sleep || realSleep, uuid: ctx.uuid || randomUUID, log: ctx.log || (() => {}), who: "HY Image 3.5" };
    const model = String(req.model || "");
    if (!Object.prototype.hasOwnProperty.call(HY_MODELS, model)) throw new Error(`Comfy Partner API: Scumble knows no model "${model}" there (hy-image-v3.5-preview).`);
    const test = testBase(ctx.base);
    checkKey(!!test, ctx.key);
    const host = test || BASE;
    const o = { max_images: HY_MAX_IMAGES, ...(req.options || {}) };
    const p = req.params || {};
    req = { ...req, references: kind === "text" ? [] : (req.references || []) };
    if (!String(req.prompt || "").trim()) throw new Error(`HY Image: ${kind === "text" ? "a new image needs a prompt" : "an edit needs a prompt that says what to change"}.`);
    if (kind !== "text" && !req.image) throw new Error("HY Image: no crop to edit.");
    const pics = kind === "text" ? [] : await picturesFor(req, o, ctx, "HY Image 3.5");
    // the node sends the pictures without alpha; a picture with transparency goes as JPEG (flattened) where it can
    for (const pic of pics) {
        if (pic.mime !== "image/png") continue;
        const opaque = typeof ctx.opaque === "function" ? await ctx.opaque(pic.bytes) : true;
        if (opaque) continue;
        const jpeg = typeof ctx.toJpeg === "function" ? await ctx.toJpeg(pic.bytes, 92) : null;
        if (jpeg && jpeg.length) { pic.bytes = Buffer.from(jpeg); pic.mime = "image/jpeg"; }
    }
    const text = kind === "text" ? resolveRefs(req.prompt, 0) : editText(req, pics);
    const content = [{ type: "text", text }];
    for (let i = 0; i < pics.length; i++) content.push({ type: "image_url", image_url: { url: await upload(ctx, host, test, pics[i], i + 1) } });
    const detail = Object.prototype.hasOwnProperty.call(HY_DETAIL, p.reference_detail) ? p.reference_detail : "standard";
    const body = {
        model, messages: [{ role: "user", content }],
        size: sizeFor(req.width, req.height),
        seed: (req.seed != null && !p.random_seed ? req.seed >>> 0 : Math.floor(Math.random() * 2147483647)) % 2147483648,
        logo_add: 0,
    };
    if (pics.length) body.resize_max_pixels = HY_DETAIL[detail];
    const url = host + HY_PATH;
    let j = null;
    for (let attempt = 0; ; attempt++) {
        const r = await post(ctx, url, body, ctx.uuid());
        if (!r.ok) {
            const msg = await readFailure(r, ctx.key);
            // the service fetches the uploaded pictures itself; the node sends again when that fetch failed
            if (/download image failed/i.test(msg) && attempt < DOWNLOAD_RETRIES) { ctx.log("the service could not fetch a picture yet, sending again"); await ctx.sleep(1000); continue; }
            throw new Error(scrub(`HY Image 3.5: ${words(r.status, msg)}`, ctx.key));
        }
        j = (await r.json().catch(() => null)) || {};
        const failed = j.error && (j.error.message || j.error.code);
        if (failed && /download image failed/i.test(String(j.error.message || "")) && attempt < DOWNLOAD_RETRIES) { await ctx.sleep(1000); continue; }
        break;
    }
    const choice = Array.isArray(j.choices) ? j.choices[0] : null;
    const image = choice && choice.delta && choice.delta.image;
    if (j.error || !image || !image.url) {
        const raw = (j.error && j.error.message) || "The answer holds no picture.";
        const m = BUSINESS_ERROR.exec(String(raw));
        throw new Error(scrub(`HY Image 3.5: ${m ? m[1].trim() : raw}`, ctx.key));
    }
    const file = await download(image.url, ctx, test, "HY Image 3.5");
    const bytes = Buffer.from(file.bytes);
    return {
        bytes, mime: sniff(bytes, file.mime), seed: body.seed,
        info: { model, size: body.size, answered: image.width && image.height ? `${image.width}x${image.height}` : null, pictures: pics.length, detail: pics.length ? detail : null, request_id: j.request_id || null },
    };
}

module.exports = {
    label: "Comfy Partner API",
    keyName: "comfycloud",   // the Comfy key, as Comfy Cloud and the Router
    keyUrl: "https://platform.comfy.org/profile/api-keys",
    keyHint: "the Comfy Cloud key (platform.comfy.org); credits only, no paid plan",
    edit(req, ctx) { return run(req, ctx, "edit"); },
    generate(req, ctx) { return run(req, ctx, "text"); },
    baseUrl: router.baseUrl,   // settings.comfyrouter.base: the one loopback mock of api.comfy.org
    // exported for tools/comfyrouter_test.js
    _sizeFor: sizeFor,
    _resolveRefs: resolveRefs,
    HY_PATH,
    BASE,
};
