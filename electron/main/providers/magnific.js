// Magnific (Freepik's API): its upscalers, and since 0.1.29 the image models it serves (FLUX.2, Seedream, GPT Image,
// Z-Image, Mystic), Ideogram's mask inpainting and Image Expand (outpainting). Written from its API reference
// (docs.magnific.com, the same pages as docs.freepik.com; the upscalers read 2026-09-22, the rest 2026-09-26) and the
// whole OpenAPI document (https://storage.googleapis.com/fc-freepik-pro-rev1-eu-api-specs/magnific-api-v1-openapi.yaml,
// read 2026-09-26; the request schemas used here are copied into tools/refs/magnific/); nothing here has run against
// the live API yet except the two upscalers (docs/RECIPES.md "Magnific" lists what only a real key can verify).
//
//   POST <host>/v1/ai/<route>            JSON body in the route's own dialect (ROUTES below)
//        -> { data: { task_id, status: "CREATED", generated: [] } }
//   GET  <host>/v1/ai/<route>/<task_id>  -> { data: { task_id, status, generated: [url, ...], has_nsfw? } }
//        status CREATED | IN_PROGRESS | COMPLETED | FAILED
//
//   route                                   dialect    what it does
//   image-upscaler-precision-v2             upscale    { image, scale_factor 2..16, sharpen, smart_grain, ultra_detail, flavor }
//   image-upscaler                          upscale    { image, scale_factor "2x".."16x", prompt, creativity, hdr, ... }
//   ideogram-image-edit                     ideogram   mask inpainting: { prompt, image, mask (black = edit), seed, ... }
//   image-expand/flux-pro|ideogram|seedream-v4-5   expand   outpainting: { image (the kept part), left, right, top, bottom }
//   text-to-image/flux-2-pro|flux-2-flex    flux2      { prompt, width, height, input_image, input_image_2..4, ... }
//   text-to-image/seedream-v5-pro|-lite|v4-5 (+ -edit)   seedream   { prompt, reference_images [b64], aspect_ratio preset }
//   text-to-image/gpt-image-2|gpt-image-2-5 (+ -edit)    gpt        { prompt, reference_images [b64], aspect_ratio, resolution }
//   text-to-image/z-image                   zimage     text only: { prompt, image_size preset, num_inference_steps, ... }
//   mystic                                  mystic     text only: { prompt, resolution, aspect_ratio preset, model, engine, ... }
//
// Header `x-magnific-api-key`. Every call is an asynchronous task, polled here until it is done (never a webhook: the
// app has no public address); the poll URL is composed from the host, the route and the task id, never taken from an
// answer. The pictures go in as plain base64, the answer is downloaded from the URL in `generated` without the key.
// Every API call costs credits, whatever the web plan says. A settings row reaches the body only when the route's
// `accepts` names its key; `webhook_url` and `filter_nsfw` are never sent.
//
// A recipe variant names the route in `model` (the path after /v1/ai/), and for Generate new the text route in
// `text.model`; an upscaler names the factor's form in `options.factor`: "int" (precision, the number) or "x" (creative,
// "4x").
//
// The host is https://api.magnific.com, never a URL from a recipe; settings.magnific.base may name a loopback mock for
// the tests, and then only a key that starts with "test-" goes there, while such a key never goes to Magnific.
"use strict";

const { fetchImage, sleep: realSleep, closestAspect } = require("./util");
const { picturesFor } = require("./comfyrouter")._shared;

const HOST = "https://api.magnific.com";
const CREATIVE_MAX_PIXELS = 25300000;
const POLL_MS = 3000;
const EDIT_WAIT_MS = 15 * 60 * 1000;
const UPSCALE_WAIT_MS = 30 * 60 * 1000;
const RETRY_WAIT_MS = 5000;
const RETRY_WAIT_MAX_MS = 60000;
const POLL_FAILURES_MAX = 5;      // status reads in a row that may fail (a 5xx, a dropped connection)
const DOWNLOAD_TRIES = 3;         // the task is paid for by then: a download that fails on the server's side is tried again
const JPEG_QUALITY = 92;
const IDEOGRAM_SEED_MAX = 2147483647;
const UINT32_MAX = 4294967295;
const MB10 = 10 * 1000 * 1000;    // "10 MB" (the stricter reading of the docs' unit)
const MIB20 = 20 * 1024 * 1024;   // GPT Image: "up to 20 MiB" a picture (64 MiB together is picturesFor's own cap)
const EXPAND_MARGIN_MAX = 2048;
const EXPAND_FLUX_MIN_SIDE = 256;
const EXPAND_FLUX_MAX_PIXELS = 20000000;
const BORDER_SLACK = 0.02;        // at most 2 % of the kept box may be selected before a selection is no border
// a pixel of the kept box counts as selected for that rule only above 3/4: a feathered frame (Feather on auto) rounds
// the kept box's inner corners, where three quarters of a separable blur's window lie in the frame, so its corners
// reach 3/4 there and stay under it everywhere inside the box (measured: 190 at most after Extend canvas)
const BORDER_INSIDE = 191;
const FIT_SLACK = 0.03;           // |ln(answer aspect / preset aspect)| up to this is stretched onto the crop

// ---- aspect presets: "W:H" -> the route's own value ------------------------------------------------------------

const SEEDREAM_ASPECTS = Object.freeze({ "1:1": "square_1_1", "16:9": "widescreen_16_9", "9:16": "social_story_9_16", "2:3": "portrait_2_3", "3:4": "traditional_3_4", "3:2": "standard_3_2", "4:3": "classic_4_3", "21:9": "cinematic_21_9" });
const GPT_ASPECTS = Object.freeze({ "1:1": "square_1_1", "4:3": "classic_4_3", "3:4": "traditional_3_4", "16:9": "widescreen_16_9", "9:16": "social_story_9_16", "21:9": "film_horizontal_21_9", "3:2": "standard_3_2", "2:3": "portrait_2_3", "2:1": "horizontal_2_1", "3:1": "banner_3_1" });
// the spec's enum also lists "social_post_4_5'" with a stray quote: left out until a live check says what it takes
const MYSTIC_ASPECTS = Object.freeze({ "1:1": "square_1_1", "4:3": "classic_4_3", "3:4": "traditional_3_4", "16:9": "widescreen_16_9", "9:16": "social_story_9_16", "20:9": "smartphone_horizontal_20_9", "9:20": "smartphone_vertical_9_20", "3:2": "standard_3_2", "2:3": "portrait_2_3", "2:1": "horizontal_2_1", "1:2": "vertical_1_2", "5:4": "social_5_4" });
// "fluid" takes five of them only (the aspect_ratio field's description)
const MYSTIC_FLUID = Object.freeze({ "1:1": "square_1_1", "9:16": "social_story_9_16", "16:9": "widescreen_16_9", "3:4": "traditional_3_4", "4:3": "classic_4_3" });
const ZIMAGE_SIZES = Object.freeze({ square: [512, 512], square_hd: [1024, 1024], portrait_3_4: [768, 1024], portrait_9_16: [576, 1024], landscape_4_3: [1024, 768], landscape_16_9: [1024, 576] });
const TIERS = Object.freeze({ "1k": 1024, "2k": 2048, "4k": 4096 });

// ---- the routes ------------------------------------------------------------------------------------------------
// label: the words of a refusal; dialect: DIALECTS below; edit / text / fill / upscale: what the route does (fill: it
// needs the selection as a mask); maxImages / maxBytes: the pictures it takes (crop first); maxSide: FLUX's side;
// aspects / tiers: its presets; accepts: the settings keys it takes; seedMax: the largest seed, null for none.

const ROUTES = Object.freeze({
    "image-upscaler-precision-v2": { label: "Magnific Precision", dialect: "upscale", upscale: true },
    "image-upscaler": { label: "Magnific Creative", dialect: "upscale", upscale: true },
    "ideogram-image-edit": { label: "Ideogram Inpaint on Magnific", dialect: "ideogram", edit: true, fill: true, maxImages: 11, maxBytes: MB10, seedMax: IDEOGRAM_SEED_MAX, accepts: ["rendering_speed", "magic_prompt", "style_type"], fit: "stretch" },
    "image-expand/flux-pro": { label: "FLUX Pro Expand on Magnific", dialect: "expand", edit: true, fill: true, minKept: EXPAND_FLUX_MIN_SIDE, maxKeptPixels: EXPAND_FLUX_MAX_PIXELS, seedMax: null, accepts: [], fit: "stretch" },
    "image-expand/ideogram": { label: "Ideogram Expand on Magnific", dialect: "expand", edit: true, fill: true, seedMax: IDEOGRAM_SEED_MAX, accepts: [], fit: "stretch" },
    "image-expand/seedream-v4-5": { label: "Seedream 4.5 Expand on Magnific", dialect: "expand", edit: true, fill: true, maxBytes: MB10, seedMax: IDEOGRAM_SEED_MAX, accepts: [], fit: "stretch" },
    "text-to-image/flux-2-pro": { label: "FLUX.2 [pro] on Magnific", dialect: "flux2", edit: true, text: true, maxImages: 4, maxSide: 1440, seedMax: UINT32_MAX, accepts: ["prompt_upsampling"], fit: "stretch" },
    "text-to-image/flux-2-flex": { label: "FLUX.2 [flex] on Magnific", dialect: "flux2", edit: true, text: true, maxImages: 4, maxSide: 1920, seedMax: UINT32_MAX, accepts: ["guidance", "steps", "safety_tolerance", "prompt_upsampling", "output_format"], fit: "stretch" },
    "text-to-image/seedream-v5-pro-edit": { label: "Seedream 5.0 Pro on Magnific", dialect: "seedream", edit: true, maxImages: 10, maxBytes: MB10, aspects: SEEDREAM_ASPECTS, seedMax: UINT32_MAX, accepts: ["resolution"] },
    "text-to-image/seedream-v5-pro": { label: "Seedream 5.0 Pro on Magnific", dialect: "seedream", text: true, aspects: SEEDREAM_ASPECTS, tiers: { "1.5k": 1536, "2k": 2048 }, seedMax: UINT32_MAX, accepts: [] },
    "text-to-image/seedream-v5-lite-edit": { label: "Seedream 5.0 Lite on Magnific", dialect: "seedream", edit: true, maxImages: 5, maxBytes: MB10, aspects: SEEDREAM_ASPECTS, seedMax: UINT32_MAX, accepts: ["enable_safety_checker"] },
    "text-to-image/seedream-v5-lite": { label: "Seedream 5.0 Lite on Magnific", dialect: "seedream", text: true, aspects: SEEDREAM_ASPECTS, seedMax: UINT32_MAX, accepts: ["enable_safety_checker"] },
    "text-to-image/seedream-v4-5-edit": { label: "Seedream 4.5 on Magnific", dialect: "seedream", edit: true, maxImages: 5, maxBytes: MB10, aspects: SEEDREAM_ASPECTS, seedMax: UINT32_MAX, accepts: ["enable_safety_checker"] },
    "text-to-image/seedream-v4-5": { label: "Seedream 4.5 on Magnific", dialect: "seedream", text: true, aspects: SEEDREAM_ASPECTS, seedMax: UINT32_MAX, accepts: ["enable_safety_checker"] },
    "text-to-image/gpt-image-2-edit": { label: "GPT Image 2 on Magnific", dialect: "gpt", edit: true, maxImages: 16, maxBytes: MIB20, aspects: GPT_ASPECTS, tiers: TIERS, accepts: ["quality", "resolution", "moderation"] },
    "text-to-image/gpt-image-2": { label: "GPT Image 2 on Magnific", dialect: "gpt", text: true, aspects: GPT_ASPECTS, tiers: TIERS, accepts: ["quality", "moderation"] },
    "text-to-image/gpt-image-2-5-edit": { label: "GPT Image 2.5 on Magnific", dialect: "gpt", edit: true, auto: true, maxImages: 16, maxBytes: MIB20, aspects: GPT_ASPECTS, tiers: TIERS, accepts: ["quality", "background", "moderation", "variant"] },
    "text-to-image/gpt-image-2-5": { label: "GPT Image 2.5 on Magnific", dialect: "gpt", text: true, auto: true, aspects: GPT_ASPECTS, tiers: TIERS, accepts: ["quality", "background", "moderation", "variant"] },
    "text-to-image/z-image": { label: "Z-Image on Magnific", dialect: "zimage", text: true, seedMax: UINT32_MAX, accepts: ["num_inference_steps", "enable_safety_checker", "output_format"] },
    "mystic": { label: "Mystic on Magnific", dialect: "mystic", text: true, aspects: MYSTIC_ASPECTS, tiers: TIERS, accepts: ["model", "engine", "creative_detailing", "fixed_generation"] },
});

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The route of a model id: the path after /v1/ai/, slashes at either end taken off. */
function routeOf(model) {
    return String(model || "").replace(/^\/+|\/+$/g, "").replace(/^v1\/ai\//, "");
}

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

// ---- pictures --------------------------------------------------------------------------------------------------

/** [width, height] from a PNG's IHDR, or null for anything else. */
function pngSize(b) {
    if (!b || b.length < 24) return null;
    if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
    const v = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    return [v(16), v(20)];
}

function sniff(bytes, fallback) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    if (bytes.length > 12 && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
    return fallback || "image/png";
}

const b64 = (buf) => Buffer.from(buf).toString("base64");

/**
 * The pictures of an edit, the crop first, then the references, each held to the route's count and bytes (an opaque
 * picture over the bytes goes as JPEG). Seedream takes no picture under 256 × 256. Throws before any request.
 */
async function picturesOf(req, R, ctx) {
    if (R.dialect === "seedream") {
        const all = [["crop", req.image], ...(req.references || []).map((r, i) => [`reference ${i + 1}`, r])];
        for (const [what, bytes] of all) {
            const s = pngSize(Buffer.from(bytes));
            if (s && (s[0] < 256 || s[1] < 256)) throw new Error(`${R.label}: the ${what} is ${s[0]} × ${s[1]}, under the 256 × 256 Seedream takes. Use a larger reference layer or turn Original off.`);
        }
    }
    return picturesFor(req, { max_images: R.maxImages || 1, max_bytes: R.maxBytes || 0 }, { ...ctx, who: R.label }, R.label);
}

/** The instruction an edit without a mask input goes out with (the same words as the Comfy Router and ModelArk adapters). */
function editPrompt(req, pics) {
    const text = String(req.prompt || "");
    if (req.kind === "text") return text;
    const refs = pics.length - 1;
    let out = `Edit the first image and keep its size and framing. ${text}`;
    if (refs > 0) out += ` The remaining image${refs > 1 ? "s are" : " is"} reference material.`;
    return out.trim();
}

/** The seed as the route takes it, or undefined (no seed, or the Random seed row on). */
function seedOf(req, max) {
    if (max == null || req.seed == null || req.seed === "" || (req.params || {}).random_seed) return undefined;
    return (Number(req.seed) >>> 0) % (max + 1);
}

/** The preset of `table` ("W:H" -> value) closest to w:h: { ratio, value }. */
function preset(w, h, table) {
    const ratio = closestAspect(Math.max(1, w), Math.max(1, h), Object.keys(table));
    return { ratio, value: table[ratio] };
}

/** The shape a text run asks for: `aspect` when it reads as W:H, else the size. */
function textShape(req) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(String(req.aspect || ""));
    if (m && +m[1] > 0 && +m[2] > 0) return [+m[1], +m[2]];
    return [Math.max(1, +req.width || 1024), Math.max(1, +req.height || 1024)];
}

/** The tier whose size covers the long side, else the largest; null without tiers. */
function tierFor(long, tiers) {
    const list = Object.entries(tiers || {}).filter(([, v]) => +v > 0).sort((a, b) => a[1] - b[1]);
    if (!list.length) return null;
    const hit = list.find(([, v]) => +v >= long);
    return (hit || list[list.length - 1])[0];
}

/** "stretch" when the preset is within 3 % of w:h (the answer then maps onto the crop exactly), else null. */
function fitFor(ratio, w, h) {
    const [a, b] = String(ratio).split(":").map(Number);
    if (!(a > 0 && b > 0 && w > 0 && h > 0)) return null;
    return Math.abs(Math.log(w / h) - Math.log(a / b)) <= FIT_SLACK ? "stretch" : null;
}

/** The settings rows the route takes (its `accepts`), empty values left out. */
function accepted(params, R) {
    const out = {};
    for (const k of R.accepts || []) {
        if (!own(params || {}, k)) continue;
        const v = params[k];
        if (v === "" || v == null) continue;
        out[k] = v;
    }
    return out;
}

/**
 * Ideogram's mask from Scumble's: Scumble's is white where to repaint, Ideogram's black ("Black regions indicate where
 * to edit"), of the picture's own size. Channel 0 at 128 or more becomes black, the rest white; always PNG.
 */
function invertedMask(mask, image, ctx, who = "Magnific") {
    if (!mask || !mask.length) throw new Error(`${who} needs the selection as a mask.`);
    if (typeof ctx.bitmap !== "function" || typeof ctx.fromBitmap !== "function") throw new Error(`${who}: this build cannot read the mask.`);
    const bm = ctx.bitmap(mask);
    if (!bm || !bm.width || !bm.height) throw new Error(`${who}: the mask could not be read.`);
    const size = pngSize(Buffer.from(image || []));
    if (size && (size[0] !== bm.width || size[1] !== bm.height)) throw new Error(`${who}: the mask is ${bm.width} × ${bm.height} and the picture ${size[0]} × ${size[1]}; Ideogram takes a mask of the picture's own size.`);
    const n = bm.width * bm.height;
    const out = Buffer.alloc(n * 4);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
        const v = bm.data[j] >= 128 ? 0 : 255;
        out[j] = v; out[j + 1] = v; out[j + 2] = v; out[j + 3] = 255;
    }
    return Buffer.from(ctx.fromBitmap({ width: bm.width, height: bm.height, data: out }));
}

const EXPAND_RULE = "Image Expand extends a picture outward: select only the new border around it (Image › Extend canvas selects it for you); for other selections use an edit recipe.";

/**
 * The part of the crop an Image Expand run keeps (the pixels outside the selection, channel 0 under 128) as a box, and
 * the four margins the model draws around it. Throws with the rule's words when the selection is not a border (more
 * than BORDER_SLACK of the box selected above BORDER_INSIDE, so a feathered frame's rounded corners do not count).
 */
function keptRect(bm, who = "Magnific Image Expand") {
    const { width: W, height: H, data } = bm;
    let kx0 = W, ky0 = H, kx1 = -1, ky1 = -1;
    for (let y = 0; y < H; y++) {
        const row = y * W * 4;
        for (let x = 0; x < W; x++) {
            if (data[row + x * 4] < 128) {
                if (x < kx0) kx0 = x;
                if (x > kx1) kx1 = x;
                if (y < ky0) ky0 = y;
                if (y > ky1) ky1 = y;
            }
        }
    }
    if (kx1 < 0) throw new Error(`${who}: the whole crop is selected, nothing is kept. ${EXPAND_RULE}`);
    kx1 += 1; ky1 += 1;
    let selected = 0;
    for (let y = ky0; y < ky1; y++) for (let x = kx0; x < kx1; x++) if (data[(y * W + x) * 4] > BORDER_INSIDE) selected++;
    const box = (kx1 - kx0) * (ky1 - ky0);
    if (selected > BORDER_SLACK * box) throw new Error(`${who}: this selection is not a border (${Math.round(selected / box * 100)} % of the kept box is selected). ${EXPAND_RULE}`);
    const margins = { left: kx0, top: ky0, right: W - kx1, bottom: H - ky1 };
    if (!margins.left && !margins.top && !margins.right && !margins.bottom) throw new Error(`${who}: the selection reaches no edge of the crop, so there is nothing to expand. ${EXPAND_RULE}`);
    return { x: kx0, y: ky0, width: kx1 - kx0, height: ky1 - ky0, margins };
}

// ---- dialects --------------------------------------------------------------------------------------------------
// Each: async body(req, R, ctx, kind) -> { body, info, pictures }; kind "edit" or "text" (checked against the route
// before). read(task, info, ctx) adds what the answer says to info.

const DIALECTS = {
    ideogram: {
        async body(req, R, ctx) {
            const pics = await picturesOf(req, R, ctx);
            const refs = pics.slice(1);
            const refBytes = refs.reduce((n, p) => n + p.bytes.length, 0);
            if (refBytes > MB10) throw new Error(`${R.label}: the style references are ${(refBytes / 1e6).toFixed(1)} MB together, more than the 10 MB Ideogram takes. Hide reference layers or turn Original off.`);
            const mask = invertedMask(req.mask, req.image, ctx, R.label);
            if (mask.length > MB10) throw new Error(`${R.label}: the mask is ${(mask.length / 1e6).toFixed(1)} MB, more than the 10 MB Ideogram takes. Set Highres fix lower.`);
            const body = { prompt: String(req.prompt || ""), image: b64(pics[0].bytes), mask: b64(mask), ...accepted(req.params, R) };
            const seed = seedOf(req, R.seedMax);
            if (seed !== undefined) body.seed = seed;
            if (refs.length) body.style_reference_images = refs.map((p) => b64(p.bytes));
            return { body, info: { fit: "stretch", style_references: refs.length }, pictures: pics.length };
        },
    },

    expand: {
        async body(req, R, ctx) {
            if (typeof ctx.bitmap !== "function" || typeof ctx.cropPng !== "function") throw new Error(`${R.label}: this build cannot read the mask.`);
            const bm = ctx.bitmap(req.mask);
            if (!bm || !bm.width || !bm.height) throw new Error(`${R.label}: the mask could not be read.`);
            const size = pngSize(Buffer.from(req.image));
            if (size && (size[0] !== bm.width || size[1] !== bm.height)) throw new Error(`${R.label}: the mask is ${bm.width} × ${bm.height} and the picture ${size[0]} × ${size[1]}.`);
            const k = keptRect(bm, R.label);
            const m = k.margins;
            if (R.minKept && (k.width < R.minKept || k.height < R.minKept)) {
                throw new Error(`${R.label}: the kept part is ${k.width} × ${k.height} at the size it is sent, under the ${R.minKept} px a side FLUX Pro Expand takes; give the crop more context (Crop panel › Context) or use Ideogram or Seedream Expand.`);
            }
            if (R.maxKeptPixels && k.width * k.height > R.maxKeptPixels) throw new Error(`${R.label}: the kept part is ${k.width} × ${k.height}, more than the ${R.maxKeptPixels / 1e6} MP it takes. Set Highres fix lower.`);
            for (const edge of ["left", "right", "top", "bottom"]) {
                if (m[edge] > EXPAND_MARGIN_MAX) throw new Error(`${R.label}: a margin of ${m[edge]} px (${edge}) at the size it is sent is over Image Expand's ${EXPAND_MARGIN_MAX}: set Highres fix lower.`);
            }
            let kept = ctx.cropPng(req.image, { x: k.x, y: k.y, width: k.width, height: k.height });
            if (!kept || !kept.length) throw new Error(`${R.label}: the kept part could not be cut out of the crop.`);
            kept = Buffer.from(kept);
            let format = "png";
            if (R.maxBytes && kept.length > R.maxBytes) {
                const opaque = typeof ctx.opaque === "function" && (await ctx.opaque(kept));
                const jpeg = opaque && typeof ctx.toJpeg === "function" ? await ctx.toJpeg(kept, JPEG_QUALITY) : null;
                if (!jpeg || !jpeg.length || jpeg.length > R.maxBytes) {
                    throw new Error(`${R.label}: the kept part is ${(kept.length / 1e6).toFixed(1)} MB, more than the ${R.maxBytes / 1e6} MB it takes${opaque ? " even as JPEG" : " (it has transparency, so it stays PNG)"}. Set Highres fix lower.`);
                }
                ctx.log(`the kept part ${kept.length} bytes as JPEG ${jpeg.length} bytes`);
                kept = Buffer.from(jpeg);
                format = "jpeg";
            }
            // all four edges always: FLUX Pro puts 512 / 512 / 256 / 256 on an edge that is left out
            const body = { image: b64(kept), left: m.left, right: m.right, top: m.top, bottom: m.bottom };
            const prompt = String(req.prompt || "").trim();
            if (prompt) body.prompt = prompt;
            const seed = seedOf(req, R.seedMax);
            if (seed !== undefined) body.seed = seed;
            if ((req.references || []).length) ctx.log(`Image Expand takes no reference pictures: ${req.references.length} left out`);
            return { body, info: { fit: "stretch", kept: [k.x, k.y, k.width, k.height], margins: m, format }, pictures: 1 };
        },
    },

    flux2: {
        async body(req, R, ctx, kind) {
            const round16 = (v) => Math.max(256, Math.min(R.maxSide, Math.round((+v || 1024) / 16) * 16));
            let w = +req.width || 1024, h = +req.height || 1024;
            if (kind === "text") {
                const k = Math.min(1, R.maxSide / Math.max(w, h));
                w *= k; h *= k;
            }
            const body = { prompt: kind === "text" ? String(req.prompt || "") : "", width: round16(w), height: round16(h), ...accepted(req.params, R) };
            const seed = seedOf(req, R.seedMax);
            if (seed !== undefined) body.seed = seed;
            let pics = [];
            if (kind !== "text") {
                pics = await picturesOf(req, R, ctx);
                body.prompt = editPrompt(req, pics);
                body.input_image = b64(pics[0].bytes);
                pics.slice(1).forEach((p, i) => { body[`input_image_${i + 2}`] = b64(p.bytes); });
            }
            return { body, info: kind === "text" ? {} : { fit: fitFor(`${body.width}:${body.height}`, +req.width || body.width, +req.height || body.height) ? "stretch" : null }, pictures: pics.length };
        },
    },

    seedream: {
        async body(req, R, ctx, kind) {
            const rows = accepted(req.params, R);
            if (kind === "text") {
                const [w, h] = textShape(req);
                const p = preset(w, h, R.aspects);
                const body = { prompt: String(req.prompt || ""), aspect_ratio: p.value, ...rows };
                const tier = R.tiers ? tierFor(Math.max(+req.width || 0, +req.height || 0), R.tiers) : null;
                if (tier) body.resolution = tier;
                const seed = seedOf(req, R.seedMax);
                if (seed !== undefined) body.seed = seed;
                return { body, info: { aspect: p.ratio }, pictures: 0 };
            }
            const pics = await picturesOf(req, R, ctx);
            const p = preset(+req.width, +req.height, R.aspects);
            const body = { prompt: editPrompt(req, pics), reference_images: pics.map((x) => b64(x.bytes)), aspect_ratio: p.value, ...rows };
            const seed = seedOf(req, R.seedMax);
            if (seed !== undefined) body.seed = seed;
            return { body, info: { aspect: p.ratio, fit: fitFor(p.ratio, +req.width, +req.height) }, pictures: pics.length };
        },
    },

    gpt: {
        async body(req, R, ctx, kind) {
            const rows = accepted(req.params, R);
            if (kind === "text") {
                const [w, h] = textShape(req);
                const p = preset(w, h, R.aspects);
                const body = { prompt: String(req.prompt || ""), num_images: 1, ...rows, aspect_ratio: p.value, resolution: tierFor(Math.max(+req.width || 0, +req.height || 0), R.tiers), output_format: "png" };
                return { body, info: { aspect: p.ratio }, pictures: 0 };
            }
            const pics = await picturesOf(req, R, ctx);
            const body = { prompt: editPrompt(req, pics), reference_images: pics.map((x) => b64(x.bytes)), num_images: 1, ...rows, output_format: "png" };
            let info;
            if (R.auto) {
                // with aspect_ratio auto only 1k leaves the size to the model; 2k and 4k render a square
                body.aspect_ratio = "auto";
                body.resolution = "1k";
                info = { aspect: "auto", fit: pics.length === 1 ? "stretch" : null };
            } else {
                const p = preset(+req.width, +req.height, R.aspects);
                body.aspect_ratio = p.value;
                body.resolution = rows.resolution || "2k";
                info = { aspect: p.ratio, fit: fitFor(p.ratio, +req.width, +req.height) };
            }
            return { body, info, pictures: pics.length };
        },
    },

    zimage: {
        async body(req, R) {
            const [w, h] = textShape(req);
            const long = Math.max(+req.width || 0, +req.height || 0);
            const near = closestAspect(w, h, ["1:1", "3:4", "9:16", "4:3", "16:9"]);
            const bigger = { "1:1": "square_hd", "3:4": "portrait_3_4", "9:16": "portrait_9_16", "4:3": "landscape_4_3", "16:9": "landscape_16_9" };
            const image_size = near === "1:1" && long > 0 && long <= 512 ? "square" : bigger[near];
            const body = { prompt: String(req.prompt || ""), image_size, ...accepted(req.params, R) };
            if (!body.output_format) body.output_format = "png";
            const seed = seedOf(req, R.seedMax);
            if (seed !== undefined) body.seed = seed;
            return { body, info: { size: ZIMAGE_SIZES[image_size] }, pictures: 0 };
        },
    },

    mystic: {
        async body(req, R) {
            const rows = accepted(req.params, R);
            const [w, h] = textShape(req);
            const p = preset(w, h, rows.model === "fluid" ? MYSTIC_FLUID : R.aspects);
            const body = { prompt: String(req.prompt || ""), resolution: tierFor(Math.max(+req.width || 0, +req.height || 0), R.tiers), aspect_ratio: p.value, ...rows };
            return { body, info: { aspect: p.ratio }, pictures: 0 };
        },
        read(task, info, ctx) {
            if (Array.isArray(task.has_nsfw) && task.has_nsfw[0] === true) {
                info.nsfw = true;
                ctx.log("Magnific flagged the answer has_nsfw");
            }
        },
    },
};

// ---- errors ----------------------------------------------------------------------------------------------------

/** What a failed answer means ({ message } or { problem: { message, invalid_params } }), the key taken out first. */
function explain(status, text, key, statusText) {
    text = scrub(text, key);
    let msg = "";
    try {
        const j = JSON.parse(text);
        const p = j && j.problem;
        if (p && typeof p === "object") {
            const bad = Array.isArray(p.invalid_params) ? p.invalid_params.map((x) => x && ((x.name || x.field) + (x.reason ? ": " + x.reason : ""))).filter(Boolean) : [];
            msg = String(p.message || "invalid request") + (bad.length ? ` (${bad.join("; ")})` : "");
        } else if (j && (j.message || j.detail || j.error)) {
            const m = j.message || j.detail || j.error;
            msg = typeof m === "string" ? m : JSON.stringify(m);
        }
    } catch (_) { /* not JSON */ }
    if (!msg) msg = text.slice(0, 300) || statusText || String(status);
    const why = status === 401 ? "key refused"
        : status === 402 ? "no credits left on the Magnific account"
        : status === 403 ? "access refused"
        : status === 404 ? "Magnific does not know this route or task (the API may have changed; an update of Scumble may be needed)"
        : status === 429 ? "rate limited"
        : status === 400 ? "request refused"
        : status >= 500 ? "the service failed" : "";
    return scrub(why ? `${why} - ${msg}` : msg, key);
}

async function readFailure(r, key) {
    let text = "";
    try { text = await r.text(); } catch (_) { text = ""; }
    return explain(r.status, text, key, r.statusText);
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
 * never before the time the server set and not at all past a minute. A network error is never retried here.
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

// ---- the task client -------------------------------------------------------------------------------------------

/** POST the body; the task as the answer names it. */
async function submit(ctx, url, route, body) {
    const headers = { "x-magnific-api-key": ctx.key, "Content-Type": "application/json" };
    let r;
    try {
        r = await send(ctx, url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (err) {
        // the task may have been made: never sent twice
        throw new Error(scrub(`Magnific ${route}: no answer from Magnific (${(err && err.message) || err}); the task may still have been made.`, ctx.key));
    }
    if (!r.ok) throw new Error(scrub(`Magnific ${route}: ${await readFailure(r, ctx.key)}${r.waitSeconds ? `; try again in ${r.waitSeconds} s` : ""}`, ctx.key));
    const first = (await r.json().catch(() => null)) || {};
    const task = first.data || {};
    const id = String(task.task_id || "");
    if (!id) throw new Error(scrub(`Magnific ${route}: no task id in the answer (${JSON.stringify(first).slice(0, 200)})`, ctx.key));
    if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) throw new Error(`Magnific ${route}: an unexpected task id.`);
    return { task, id };
}

/** Status reads every 3 s on <route>/<id> until the task is done; the finished task. */
async function poll(ctx, url, route, id, task, waitMs) {
    const t0 = ctx.now();
    let failures = 0;
    const tooMany = () => new Error(`Magnific ${route}: status reads failed ${POLL_FAILURES_MAX} times in a row; the task (${id}) may still finish and be billed on Magnific's side.`);
    while (task.status !== "COMPLETED") {
        if (task.status === "FAILED") throw new Error(`Magnific ${route}: the task failed (${id}); Magnific names no reason (a safety filter, a picture it could not read, or a fault on its side).`);
        if (ctx.now() - t0 > waitMs) throw new Error(`Magnific ${route}: no answer after ${Math.round(waitMs / 60000)} minutes (task ${id}); it may still finish and be billed on Magnific's side.`);
        await ctx.sleep(POLL_MS);
        let s;
        try {
            s = await send(ctx, `${url}/${id}`, { headers: { "x-magnific-api-key": ctx.key } });
        } catch (err) {
            ctx.log(`status read failed (${scrub((err && err.message) || err, ctx.key)})`);
            if (++failures >= POLL_FAILURES_MAX) throw tooMany();
            continue;
        }
        if (s.status >= 500 || s.status === 429) {
            // a rate limit on a status read does not end a task that is already made (and billed); read again later
            ctx.log(`status read answered ${s.status}`);
            if (++failures >= POLL_FAILURES_MAX) throw tooMany();
            continue;
        }
        if (!s.ok) throw new Error(scrub(`Magnific ${route} status: ${await readFailure(s, ctx.key)}`, ctx.key));
        failures = 0;
        const j = (await s.json().catch(() => null)) || {};
        task = j.data || {};
    }
    return task;
}

/**
 * The finished task's picture, fetched without the key: an https URL, a data: picture or the test mock's own host,
 * nothing else. A download that fails on the server's side is tried again (the task is paid for); a 4xx is not.
 */
async function fetchResult(task, ctx, test, route, id) {
    const out = Array.isArray(task.generated) ? task.generated.find((u) => typeof u === "string" && u) : null;
    if (!out) throw new Error(`Magnific ${route}: the task is done but names no picture (${id}).`);
    const s = String(out);
    const ok = /^https:\/\//i.test(s) || /^data:image\//i.test(s) || (test && s.startsWith(test + "/"));
    if (!ok) throw new Error(`Magnific ${route}: the answer points to "${s.slice(0, 80)}", which Scumble does not fetch.`);
    if (/^data:/i.test(s)) return fetchImage(s, ctx.fetch);
    for (let n = 1; ; n++) {
        let r;
        try {
            r = await ctx.fetch(s, {});
        } catch (err) {
            if (n < DOWNLOAD_TRIES) { ctx.log(`result download failed (${(err && err.message) || err}), trying again`); await ctx.sleep(POLL_MS); continue; }
            throw new Error(`Magnific ${route}: the result could not be downloaded (${(err && err.message) || err}); task ${id}.`);
        }
        if (r.ok) return { bytes: Buffer.from(await r.arrayBuffer()), mime: (r.headers && r.headers.get && r.headers.get("content-type")) || "image/png" };
        if (r.status >= 500 && n < DOWNLOAD_TRIES) { ctx.log(`result download answered ${r.status}, trying again`); await ctx.sleep(POLL_MS); continue; }
        throw new Error(r.status === 403 ? `Magnific ${route}: the result link was refused (expired?); task ${id}.` : `Magnific ${route}: the result download answered ${r.status}; task ${id}.`);
    }
}

// ---- upscale (the two upscalers, as since 0.1.24) --------------------------------------------------------------

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

/** The upscale body: the picture, the factor, the variant's settings, the prompt where the route takes one. */
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

// ---- runs ------------------------------------------------------------------------------------------------------

async function run(req, ctx, kind) {
    // ctx.sleep and ctx.now are injectable so the tests wait in milliseconds
    ctx = { ...ctx, sleep: ctx.sleep || realSleep, log: ctx.log || (() => {}), now: ctx.now || Date.now };
    const route = routeOf(req.model);
    const R = own(ROUTES, route) ? ROUTES[route] : null;
    if (kind === "upscale" && !(R && R.upscale)) throw new Error(`Magnific: no upscaler route "${route}" (${Object.keys(ROUTES).filter((k) => ROUTES[k].upscale).join(", ")}).`);
    if (!R) throw new Error(`Magnific: Scumble knows no route "${route}".`);
    const test = testBase(ctx.base);
    checkKey(!!test, ctx.key);
    const host = test || HOST;
    const url = `${host}/v1/ai/${route}`;

    let body, info = {}, pictures = 0;
    if (kind === "upscale") {
        if (!req.image) throw new Error("Magnific: no picture to upscale.");
        body = bodyFor(req, route);
        const size = pngSize(Buffer.from(req.image));
        const f = Math.round(+req.factor || 2);
        if (route === "image-upscaler" && size && size[0] * f * size[1] * f > CREATIVE_MAX_PIXELS) {
            throw new Error(`Magnific Creative: ${size[0]} × ${size[1]} at ${f}x would be ${Math.round(size[0] * f * size[1] * f / 1e6)} MP, over its 25.3 MP cap; pick a smaller factor or a smaller selection.`);
        }
        info = { model: route, factor: body.scale_factor };
        pictures = 1;
    } else {
        if (R.upscale) throw new Error(`${R.label} is an upscaler; run it with Upscale.`);
        if (kind === "edit" && !R.edit) throw new Error(`${R.label} makes pictures from the prompt alone: use Generate new.`);
        if (kind === "text" && !R.text) throw new Error(`${R.label} needs a picture: use Generate.`);
        if (kind === "edit" && R.fill && !(req.kind === "fill" && req.mask && req.mask.length)) throw new Error(`${R.label} needs the selection as a mask (the variant's input must be fill).`);
        if (R.dialect !== "expand" && !String(req.prompt || "").trim()) throw new Error(`${R.label}: ${kind === "text" ? "a new image needs a prompt" : "an edit needs a prompt"}.`);
        if (kind === "edit" && !req.image) throw new Error(`${R.label}: no picture to edit.`);
        const d = DIALECTS[R.dialect];
        req = { ...req, params: req.params || {}, references: kind === "text" ? [] : (req.references || []), kind: kind === "text" ? "text" : req.kind };
        const made = await d.body(req, R, ctx, kind);
        body = made.body;
        info = { ...made.info };
        pictures = made.pictures;
    }

    const { task: first, id } = await submit(ctx, url, route, body);
    const task = await poll(ctx, url, route, id, first, kind === "upscale" ? UPSCALE_WAIT_MS : EDIT_WAIT_MS);
    const d = DIALECTS[R.dialect];
    if (d && typeof d.read === "function") d.read(task, info, ctx);
    const file = await fetchResult(task, ctx, test, route, id);
    const bytes = Buffer.from(file.bytes);
    const size = pngSize(bytes);
    const out = { route, task: id, pictures, ...info };
    if (size) {
        out.width = size[0]; out.height = size[1];
        // aspect_ratio auto: the docs say the answer keeps the reference's shape, unchecked live; stretch it only when it
        // really has the crop's shape, any other goes to the stitch's own aspect rule
        if (out.fit === "stretch" && out.aspect === "auto" && +req.width > 0 && +req.height > 0 && !fitFor(`${size[0]}:${size[1]}`, +req.width, +req.height)) {
            ctx.log(`the answer is ${size[0]} x ${size[1]}, not the shape of the ${req.width} x ${req.height} crop; not stretched`);
            out.fit = null;
        }
    }
    return { bytes, mime: sniff(bytes, file.mime), seed: body.seed != null ? body.seed : req.seed, info: out };
}

module.exports = {
    label: "Magnific",
    keyUrl: "https://www.magnific.com/user/organization/api-keys",
    keyHint: "API key from Magnific's organization settings (every API call costs credits)",
    edit(req, ctx) { return run(req, ctx, "edit"); },
    generate(req, ctx) { return run(req, ctx, "text"); },
    upscale(req, ctx) { return run(req, ctx, "upscale"); },
    baseUrl,
    // exported for tools/upscale_test.js and tools/magnific_test.js
    _testBase: testBase,
    _body: bodyFor,
    _factor: factorFor,
    _routes: ROUTES,
    _dialects: DIALECTS,
    _keptRect: keptRect,
    _preset: preset,
    _explain: explain,
    _invertedMask: invertedMask,
    _fitFor: fitFor,
    _tierFor: tierFor,
    _aspects: { SEEDREAM_ASPECTS, GPT_ASPECTS, MYSTIC_ASPECTS, MYSTIC_FLUID, ZIMAGE_SIZES },
    HOST,
    CREATIVE_MAX_PIXELS,
};
