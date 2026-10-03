// fal.ai: one key, many image models. Queue protocol: POST https://queue.fal.run/<model>
// -> { request_id, status_url, response_url }, poll status_url until COMPLETED, GET
// response_url. Images go in as base64 data URIs, come back as URLs.
//
// Two request shapes, chosen by the recipe's `kind`:
//   fill: { image_url, mask_url, prompt, ... }        (flux-pro/v1/fill, flux-lora-fill, qwen-image-edit/inpaint, ...)
//   edit: { image_urls: [crop, references...], prompt } (flux-2-pro/edit, flux-2/edit, nano-banana/edit, ...)
// A recipe variant may rename the inputs with `fields` ({ image, images, mask }; gpt-image-2 on fal
// takes image_urls plus mask_url) and switch the size hint off with options.sizing = "none" for
// endpoints without a free image_size (nano-banana, seedream, gpt-image). `fields.mask: false`
// drops the mask for an image-to-image endpoint that has none (Ideogram 4), and `options.omit`
// lists input fields a strict endpoint refuses (Recraft V4, Krea 2). `options.max_images` is how many pictures the
// image list takes (the crop included); a run with more is refused before sending.
// layout(req) declares where each picture goes (docs/PLAN_REFS.md C3).
//
// FLUX 3 Image (blackforestlabs/flux-3/edit-image and text-to-image; docs/PLAN_FLUX3.md "fal"): `options.sizing:
// "flux3"` sends FLUX 3's shape instead of a size: `resolution` the tier by area (flux3.js: 1k / 2k / 4k), on a text
// run `aspect_ratio` the nearest of `options.aspect_ratios` (fal's 14, no "9:21"), on an edit the preset the crop was
// widened to or one within 3 % of it (info.fit "stretch" for the stitch), else none (fal's "auto", image 1's shape);
// safety_tolerance goes as a whole number 0 to 4, enable_prompt_expansion as a boolean. `options.min_side` /
// `max_pixels` (256 px, 4 MP): a reference layer or the Original outside them is scaled into them (ctx.resizePng), the
// crop is refused. The seed reported is the one sent: none where `options.omit` keeps it home.
//
// text (kind "text", Generate new): the text-to-image route takes no picture. With reference layers the recipe's
// `text.refs.model` sends the run to the edit route (".../edit", FLUX 3's ".../edit-image"), which gets the references
// alone in its image list (no crop, no mask) and the asked size as `options.sizing` says; textLayout(req) declares
// them (26f).
//
// upscale (kind "upscale", docs/RECIPES.md "Upscale recipes"): { image_url, upscale_factor, output_format,
// the variant's settings, prompt only when the variant takes one }. Topaz, Clarity and SeedVR2 name the
// factor `upscale_factor`; a variant renames it with `fields.factor`, or leaves it out with `fields.factor:
// false` for a model that picks its own (Recraft's upscalers). Topaz takes minutes on a large picture, so an
// upscale waits up to 30 minutes in the queue, not 15.
"use strict";

const { dataUri, fetchImage, readError, sleep, num, fitPixels, closestAspect, pngSize } = require("./util");
const { layoutOf, refRoles, countOf } = require("./refs");
const flux3 = require("./flux3");

const QUEUE = "https://queue.fal.run/";
/** The routes that take an image list besides the text route (FLUX 3 names its own ".../edit-image"). */
const EDIT_ROUTE = /\/edit(-image)?$/;

/**
 * The asked size inside an edit route's area range (`text.refs.options.pixels` [min, max]; Seedream 5 on fal: pro 1 to
 * 4 MP, lite 3.7 to 16.8 MP), multiples of 16 and never over the ceiling after the rounding.
 */
function fittedSize(w, h, range) {
    const lo = +range[0] || 0, hi = +range[1] || 0;
    let [fw, fh] = fitPixels(w, h, { step: 16, max: 4096, minPixels: lo, maxPixels: hi });
    while (hi && fw * fh > hi && fw > 16 && fh > 16) { if (fw >= fh) fw -= 16; else fh -= 16; }
    return { width: fw, height: fh };
}

/** `sizing: "flux3"`: { aspect, resolution, fit } by FLUX 3's rules over the variant's presets (`options.aspect_ratios`). */
function flux3Shape(req) {
    const o = req.options || {};
    const presets = Array.isArray(o.aspect_ratios) && o.aspect_ratios.length ? o.aspect_ratios.map(String) : flux3.FLUX3_ASPECTS;
    return flux3.shapeOf({ ...req, options: {}, params: {} }, presets);
}

function inputFor(req) {
    const p = req.params;
    const input = { prompt: req.prompt || "", output_format: "png", num_images: 1 };
    if (req.seed != null && !p.random_seed) input.seed = req.seed >>> 0;
    const f = req.fields || {};
    const sizing = (req.options && req.options.sizing) || "image_size";
    // a text run with references on an edit route: the pictures are the references alone (textLayout)
    const refLay = req.kind === "text" && (req.references || []).length ? textLayout(req) : null;
    const withRefs = !!(refLay && !refLay.drops);
    // FLUX 3: the tier by area; a text run always the nearest preset, an edit the crop's preset or none (auto)
    const shape = sizing === "flux3" ? flux3Shape(req) : null;
    if (shape) {
        input.resolution = shape.resolution;
        if (shape.aspect !== "auto") input.aspect_ratio = shape.aspect;
    }
    if (req.kind === "text") {
        const o = req.options || {};
        if (sizing === "image_size") input.image_size = withRefs && Array.isArray(o.pixels) ? fittedSize(req.width, req.height, o.pixels) : { width: req.width, height: req.height };
        else if (!shape && req.aspect) input.aspect_ratio = req.aspect;
        // a free size on an edit route that takes presets only: the closest one, not the first picture's shape
        // (`text.refs.options.aspect_ratios`; Nano Banana 2 and Pro)
        else if (!shape && withRefs && Array.isArray(o.aspect_ratios) && o.aspect_ratios.length) input.aspect_ratio = closestAspect(req.width || 1, req.height || 1, o.aspect_ratios);
        if (withRefs) {
            // index.js refuses a run past the cap first (refs.checkPictures); this keeps a direct call from sending one
            const n = countOf(refLay), max = refLay.max;
            if (max != null && n > max) throw new Error(`fal.ai ${String(req.model || "")} takes at most ${max} reference picture${max === 1 ? "" : "s"} for a new image; this run has ${n}: hide reference layers.`);
            input[f.images || "image_urls"] = req.references.map((r) => dataUri(r));
        }
    } else if (req.kind === "edit" || f.images) {
        // index.js refuses a run past the cap first (refs.checkPictures); this keeps a direct call from sending one
        const lay = layout(req), n = countOf(lay);
        if (lay.max != null && n > lay.max) throw new Error(`fal.ai ${String(req.model || "")} takes at most ${lay.max} picture${lay.max === 1 ? "" : "s"}; this run has ${n}: hide reference layers or turn Original off.`);
        input[f.images || "image_urls"] = [dataUri(req.image), ...req.references.map((r) => dataUri(r))];
        // keep the crop's size: the stitch stretches only a same-aspect result back exactly
        if (sizing === "image_size" && req.kind === "edit") input.image_size = { width: req.width, height: req.height };
    } else {
        input[f.image || "image_url"] = dataUri(req.image);
    }
    if (req.mask && req.kind !== "edit" && f.mask !== false) input[f.mask || "mask_url"] = dataUri(req.mask);
    // recipe settings are passed through by name; the recipe decides which exist for the model. On an edit route an
    // "auto" size or aspect follows the first picture, so with references the asked one written above stays
    // (Seedream's "auto_2K" Size row)
    const auto = (v) => typeof v === "string" && (/^auto/i.test(v) || v === "match_input_image");
    for (const [k, v] of Object.entries(p)) {
        if (k === "random_seed" || k === "model" || v === "" || v == null) continue;
        if (withRefs && (k === "image_size" || k === "aspect_ratio") && input[k] !== undefined && auto(v)) continue;
        input[k] = v;
    }
    if (sizing === "flux3") {
        // the rows as FLUX 3's schema types them (an agent may give "3" or "on"); a safety that is no number goes as fal's 2
        if (input.safety_tolerance !== undefined) {
            const s = flux3.safetyOf(input.safety_tolerance);
            if (s == null) delete input.safety_tolerance;
            else input.safety_tolerance = s;
        }
        if (input.enable_prompt_expansion !== undefined) input.enable_prompt_expansion = flux3.switchOf(input.enable_prompt_expansion, "Prompt expansion");
    }
    // an edit route takes no negative prompt on an edit run, and a text run with references goes to that route
    if (req.negative && input.negative_prompt === undefined && req.kind !== "edit" && !withRefs) input.negative_prompt = req.negative;
    // endpoints that validate their input strictly (Recraft V4, Krea 2) reject the fields
    // every other fal model takes; a variant names them in options.omit
    for (const k of (req.options && req.options.omit) || []) delete input[k];
    return input;
}

/**
 * Where inputFor puts each picture of a fill or an edit: the crop and the references in one list, the mask on its own.
 * `max` is the variant's options.max_images (the pictures in the list); a route without the list sends no reference.
 */
function layout(req) {
    const f = req.fields || {}, o = req.options || {};
    const max = +o.max_images > 0 ? +o.max_images : null;
    const own = req.mask && req.kind !== "edit" && f.mask !== false ? [["mask", f.mask || "mask_url"]] : [];
    if (req.kind === "edit" || f.images) {
        const F = f.images || "image_urls";
        return layoutOf({ seq: [["crop", `${F}[0]`], ...refRoles(req).map(([role, i]) => [role, `${F}[${i + 1}]`, i])], own, max });
    }
    const drops = f.mask === false ? "This endpoint takes one picture" : "This endpoint takes the crop and the mask only";
    return layoutOf({ seq: [["crop", f.image || "image_url"]], own, max, drops });
}

/**
 * Where inputFor puts the references of a text run (Generate new, 26f): an edit route (".../edit", the recipe's
 * `text.refs.model`) takes them in its image list, numbered from 1 (no crop), up to options.max_images, the edit
 * run's cap (the crop's slot becomes a reference slot); a text-to-image route takes none.
 */
function textLayout(req) {
    const f = req.fields || {}, o = req.options || {};
    if (!EDIT_ROUTE.test(String(req.model || "").replace(/\/+$/, ""))) return layoutOf({ drops: "This text-to-image endpoint takes no reference images" });
    const F = f.images || "image_urls";
    return layoutOf({ seq: refRoles(req).map(([role, i]) => [role, `${F}[${i}]`, i]), max: +o.max_images > 0 ? +o.max_images : null });
}

/** The input of an upscale: the picture, the factor, the variant's own settings. */
function upscaleInput(req) {
    const p = req.params || {};
    const f = req.fields || {};
    const input = { [f.image || "image_url"]: dataUri(req.image), output_format: "png" };
    if (f.factor !== false && req.factor != null) input[f.factor || "upscale_factor"] = +req.factor;
    if (req.prompt) input.prompt = String(req.prompt);
    if (req.negative) input.negative_prompt = String(req.negative);
    if (req.seed != null && !p.random_seed && req.options && req.options.seed) input.seed = req.seed >>> 0;
    // a row's "auto" leaves the value to the model (Topaz' defaults differ per model); `options.numbers` names
    // the rows whose choices are numbers written as a list (Sharpen 0 ... 1), which go out as numbers
    const numbers = new Set((req.options && req.options.numbers) || []);
    for (const [k, v] of Object.entries(p)) {
        if (k === "random_seed" || v === "" || v == null || v === "auto") continue;
        input[k] = numbers.has(k) && Number.isFinite(+v) ? +v : v;
    }
    for (const k of (req.options && req.options.omit) || []) delete input[k];
    return input;
}

const EDIT_WAIT_MS = 15 * 60 * 1000;
const UPSCALE_WAIT_MS = 30 * 60 * 1000;

/** Submit to the queue, poll, fetch the answer: the JSON fal returns for the request. */
async function queued(model, input, ctx, waitMs) {
    const headers = { Authorization: "Key " + ctx.key, "Content-Type": "application/json" };
    const submit = await ctx.fetch(QUEUE + model, { method: "POST", headers, body: JSON.stringify(input) });
    if (!submit.ok) throw new Error(`fal.ai ${model}: ${await readError(submit)}`);
    const job = await submit.json();
    const statusUrl = job.status_url, resultUrl = job.response_url;
    if (!statusUrl || !resultUrl) throw new Error("fal.ai answered without status_url / response_url: " + JSON.stringify(job).slice(0, 200));
    const t0 = Date.now();
    const pause = ctx.sleep || sleep;
    let status = job.status || "IN_QUEUE";
    while (status !== "COMPLETED") {
        if (Date.now() - t0 > waitMs) throw new Error(`fal.ai: timed out after ${Math.round(waitMs / 60000)} minutes`);
        await pause(status === "IN_QUEUE" ? 1500 : 1000);
        const r = await ctx.fetch(statusUrl, { headers: { Authorization: headers.Authorization } });
        if (!r.ok) throw new Error(`fal.ai status: ${await readError(r)}`);
        const s = await r.json();
        status = s.status || status;
        if (status === "FAILED" || s.error) throw new Error("fal.ai: " + (s.error || "request failed"));
    }
    const r = await ctx.fetch(resultUrl, { headers: { Authorization: headers.Authorization } });
    if (!r.ok) throw new Error(`fal.ai result: ${await readError(r)}`);
    return r.json();
}

function modelOf(req) {
    const model = String(req.model || "").replace(/^\/+|\/+$/g, "");
    if (!model) throw new Error("fal.ai recipe has no model id.");
    return model;
}

/**
 * `options.min_side` / `max_pixels` (FLUX 3 on fal: 256 px a side, 4 MP): a reference layer or the Original outside them
 * is scaled into them through ctx.resizePng, the crop is refused (the selection and the variant's limits decide its
 * size). Answers the request with the scaled references; throws, naming the picture, before anything is sent.
 */
async function fitPictures(req, ctx, model) {
    const o = req.options || {};
    const minSide = +o.min_side > 0 ? +o.min_side : 0, maxPx = +o.max_pixels > 0 ? +o.max_pixels : 0;
    if (!minSide && !maxPx) return req;
    const mp = (n) => `${+(n / 1e6).toFixed(1)} MP`;
    const small = ([w, h]) => !!minSide && Math.min(w, h) < minSide;
    const big = ([w, h]) => !!maxPx && w * h > maxPx;
    const crop = req.kind !== "text" && req.image ? pngSize(Buffer.from(req.image)) : null;
    if (crop && small(crop)) throw new Error(`fal.ai ${model} takes pictures of at least ${minSide} px a side; the crop is ${crop[0]} × ${crop[1]}: select a larger area or more context around it. Nothing was sent.`);
    if (crop && big(crop)) throw new Error(`fal.ai ${model} takes pictures of at most ${mp(maxPx)}; the crop is ${crop[0]} × ${crop[1]}: select a smaller area or set Highres fix lower. Nothing was sent.`);
    const roles = refRoles(req), orig = req.original ? 1 : 0;
    const references = [];
    for (const [i, bytes] of (req.references || []).entries()) {
        const s = pngSize(Buffer.from(bytes || []));
        if (!s || (!small(s) && !big(s))) { references.push(bytes); continue; }
        const what = roles[i] && roles[i][0] === "original" ? "the Original" : `reference picture ${i + 1 - orig}`;
        const [w, h] = s;
        const k = big(s) ? Math.sqrt((maxPx * 0.995) / (w * h)) : minSide / Math.min(w, h);
        const to = [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
        if (small(to) || big(to)) throw new Error(`fal.ai ${model} takes pictures of ${minSide} px a side to ${mp(maxPx)}; ${what} is ${w} × ${h}, which no scale fits: use a less elongated layer. Nothing was sent.`);
        const scaled = typeof ctx.resizePng === "function" ? await ctx.resizePng(Buffer.from(bytes), { width: to[0], height: to[1] }) : null;
        if (!scaled || !scaled.length) throw new Error(`fal.ai ${model}: ${what} (${w} × ${h}) could not be scaled to ${to[0]} × ${to[1]}. Nothing was sent.`);
        if (ctx.log) ctx.log(`${what} ${w} × ${h} scaled to ${to[0]} × ${to[1]}`);
        references.push(Buffer.from(scaled));
    }
    return { ...req, references };
}

module.exports = {
    label: "fal.ai",
    keyUrl: "https://fal.ai/dashboard/keys",
    keyHint: "FAL_KEY from the fal.ai dashboard",
    generate(req, ctx) {
        return this.edit(req, ctx);   // inputFor() sends a text run's references alone (textLayout), or no picture
    },
    layout,
    textLayout,
    async edit(req, ctx) {
        const model = modelOf(req);
        req = await fitPictures(req, ctx, model);
        const input = inputFor(req);
        const out = await queued(model, input, ctx, EDIT_WAIT_MS);
        const img = (out.images && out.images[0]) || out.image;
        if (!img || !img.url) throw new Error("fal.ai: no image in the result (" + JSON.stringify(out).slice(0, 200) + ")");
        if (Array.isArray(out.has_nsfw_concepts) && out.has_nsfw_concepts[0]) ctx.log("result flagged as nsfw by fal.ai, image may be blurred");
        const file = await fetchImage(img.url, ctx.fetch);
        const flux = req.options && req.options.sizing === "flux3";
        // FLUX 3: an edit sent at a preset comes back in its shape, which the stitch stretches onto the crop
        const shape = flux ? { resolution: input.resolution || null, aspect_ratio: input.aspect_ratio || null, ...(req.kind !== "text" && input.aspect_ratio ? { fit: "stretch" } : {}) } : {};
        // the seed sent (none where options.omit kept it home), or the one the answer names
        return { bytes: file.bytes, mime: img.content_type || file.mime, seed: num(out.seed, "seed" in input ? req.seed : null), info: { model, width: img.width, height: img.height, ...shape } };
    },
    async upscale(req, ctx) {
        const model = modelOf(req);
        if (!req.image) throw new Error(`fal.ai ${model}: no picture to upscale.`);
        const input = upscaleInput(req);
        const out = await queued(model, input, ctx, UPSCALE_WAIT_MS);
        const img = out.image || (out.images && out.images[0]);
        if (!img || !img.url) throw new Error("fal.ai: no image in the result (" + JSON.stringify(out).slice(0, 200) + ")");
        const file = await fetchImage(img.url, ctx.fetch);
        return { bytes: file.bytes, mime: img.content_type || file.mime, seed: num(out.seed, req.seed), info: { model, factor: input[(req.fields && req.fields.factor) || "upscale_factor"] || null, width: img.width, height: img.height } };
    },
    // exported for tools/upscale_test.js
    _upscaleInput: upscaleInput,
};
