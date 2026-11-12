// WaveSpeedAI (api.wavespeed.ai): one key, the Google, OpenAI, ByteDance, BFL and Qwen image
// models behind one protocol. POST /api/v3/<model> with the input as JSON -> { code, data: {
// id, status, urls: { get } } }, poll data.urls.get (every 2 s, the minimum in the docs) until
// completed / failed / cancelled / timeout, data.outputs = [url]. Model inputs take URLs only
// (no data URIs, says the upload guide): crop, mask and references go through the media
// upload first (POST /api/v3/media/uploads -> presigned PUT, download_url, kept 7 days), the
// single-step POST /api/v3/media/upload/binary as fallback.
//
// Two request shapes, chosen by the recipe's `input`:
//   fill: { image, mask_image, prompt, size "W*H" }   (flux-fill-dev, 256..1536 per side)
//         { image, mask_url, reference_images, prompt } (Ideogram 4.5 edit: the references in a list of their own,
//                                                       unnumbered)
//   edit: { images: [crop, references...], prompt }   (nano-banana, gpt-image, seedream, flux-2, qwen)
//   fill with an image list: { images: [crop, references...], mask_image, prompt }  (GPT Image 2.5 and 2.6 edit: a
//         variant of input "fill" naming `fields.images` and `fields.mask`; the mask is the first picture's, white =
//         edit, and no aspect preset goes beside it: the route picks the shape "automatically from the input image"
//         (read 2026-11-06; not verified that it keeps the exact ratio), and the variant's `limits.aspects` (the same
//         15 presets) has widened the crop to one of them, so a pick among them cannot differ from the crop)
// A recipe variant may rename the inputs with `fields` ({ image, images, mask, references }); `options`:
// `aspect_ratios` (the model's presets, the closest to the crop is sent unless the settings
// pick one; never on a fill), `size: "star"` (send the crop size as "W*H", fitted to `max_side`), `max_images` (how
// many pictures the image list takes, the crop included; a run with more is refused before any upload), `model_row`
// (true: the Settings row keyed "model" goes out as the route's own `model` input, Krea 3's Berry or Jam).
// `options` for a model with its own conventions (Ideogram 4.5): `mask: "black"` sends the mask inverted (black =
// edit, util.js ideogramMask; none for a selection over the whole crop), `negative: false` sends no negative prompt (`edit_negative: true`: an edit sends one too, Krea 3),
// `accepts` (a text run: `text_accepts`, else `accepts`) lists the optional keys the route takes, and with a list
// every other key but the prompt and the pictures stays home (seed, output_format, a Settings row the route lacks;
// the schemas say additionalProperties false), `tiers` ({ "1k": 1024, ... }) gives a text run `resolution` by the
// asked long side, `text_values` ({ key: { value: replacement } }) swaps a Settings value a text route does not take,
// and on a fill `max_ratio` refuses a crop steeper than that and `max_bytes` holds each picture to that size (JPEG
// for an opaque one over it), both before the first upload.
// A text run (Generate new) sends the prompt alone to the text model; with reference layers the recipe names the edit
// route (`text.refs.model`, ".../edit") and they are uploaded into the image list in order, the crop's slot being a
// reference's, the shape as for a text run (the closest `aspect_ratios` preset; a variant without them, FLUX.2,
// Seedream 5 lite and Qwen edit-plus, sends no shape, so the route may follow the first reference's).
// layout(req) and textLayout(req) declare where each picture goes (docs/PLAN_REFS.md C3).
//
// FLUX 3 Image (black-forest-labs/flux-3/image-edit and text-to-image; docs/PLAN_FLUX3.md "WaveSpeed"): `options.sizing:
// "flux3"` sends FLUX 3's shape instead of the closest preset: `resolution` the tier by area (flux3.js: 1k / 2k / 4k), on
// a text run `aspect_ratio` the nearest of `aspect_ratios` (WaveSpeed's 14, no "9:21" and no "auto"), on an edit the
// preset the crop was widened to or one within 3 % of it (info.fit "stretch" for the stitch), else none (the route then
// follows image 1); enable_prompt_expansion goes as a boolean, and a blank prompt is refused (the schema's minLength 1).
// `options.min_side` / `max_pixels` (256 px, 4 MP): a reference layer or the Original outside them is scaled into them
// (ctx.resizePng), the crop is refused, before the first upload.
//
// Split into layers (kind "layers", Seedream 5.5's `options.layers.model`, bytedance/seedream-v5.5/layer-decomposition;
// its llms.txt and model page, read 2026-11-11): { image (one URL, uploaded), prompt?, resolution 1k / 1.5k / 2k (the
// page's default 1k; no auto: Scumble's Auto picks by the picture's area), max_images (the base and the layers, 2 to
// 100; billed in full whatever comes back), output_format (the base's; every layer is a PNG with transparency) }; the
// answer's outputs are "the base image first, then the layers", "usually URL strings". The pages name no box, no name
// and no order for a layer, so a URL string lands as "Layer n" over the whole picture (layersplit.js `full`); an
// object entry's url / b64_json, z_index, bounding_box, name and description are read where they come. Not stated
// either: whether a layer's PNG is the whole frame or its element (ModelArk's are near the tier's size, placed by a
// box), a Text recognition switch (none sent), the input limits (ModelArk's are held: its pixels and aspect, and its
// 30 MB a picture with the JPEG fallback for an opaque one).
//
// Referral: the key link (keyUrl) carries DenRakEiw's WaveSpeed referral code.
"use strict";

const { downloadImage, pollJob, scrub, readError, num, closestAspect, tierFor, checkRatio, withinBytes, ideogramMask, pngSize } = require("./util");
const { layoutOf, refRoles, countOf } = require("./refs");
const flux3 = require("./flux3");
const openrouter = require("./openrouter");
const split = require("./layersplit");

/** A split's tier as WaveSpeed's `resolution`; Auto by the picture's area (ModelArk's auto: about the input's own size within 1K to 2K). */
const SPLIT_RESOLUTION = { "1K": "1k", "1.5K": "1.5k", "2K": "2k" };
const SPLIT_MAX_BYTES = 30 * 1000 * 1000;   // ark.js MAX_PICTURE_BYTES
function splitResolution(tier, image) {
    if (SPLIT_RESOLUTION[tier]) return SPLIT_RESOLUTION[tier];
    const d = pngSize(Buffer.from(image || [])) || [1024, 1024];
    const area = d[0] * d[1];
    return area <= 1024 * 1024 ? "1k" : area <= 1536 * 1536 ? "1.5k" : "2k";
}

const BASE = "https://api.wavespeed.ai/api/v3/";
const POLL_MS = 2000;
// an edit route, the only kind that takes pictures ("google/nano-banana-2/edit", ".../qwen-image/edit-plus")
const EDIT_ROUTE = /(?:^|[/-])edit(?:[/-]|$)/;

async function upload(ctx, bytes, name, mime = "image/png") {
    const auth = { Authorization: "Bearer " + ctx.key };
    // two-step: ticket, then PUT the bytes to the presigned URL (no API key there)
    const ticket = await ctx.fetch(BASE + "media/uploads", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ filename: name, size: bytes.length, content_type: mime }) });
    if (ticket.ok) {
        const t = ((await ticket.json()) || {}).data || {};
        const up = t.upload || {};
        if (t.download_url && up.url) {
            const put = await ctx.fetch(up.url, { method: up.method || "PUT", headers: up.headers || { "Content-Type": mime }, body: bytes });
            if (!put.ok) throw new Error(scrub(`WaveSpeed upload (${name}): ${await readError(put, ctx.key)}`, ctx.key));
            return t.download_url;
        }
        ctx.log("upload ticket without download_url / upload.url, using the binary upload:", JSON.stringify(t).slice(0, 200));
    } else {
        ctx.log("upload ticket answered", ticket.status, "- using the binary upload");
    }
    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type: mime }), name);
    const r = await ctx.fetch(BASE + "media/upload/binary", { method: "POST", headers: auth, body: fd });
    if (!r.ok) throw new Error(scrub(`WaveSpeed upload (${name}): ${await readError(r, ctx.key)}`, ctx.key));
    const d = ((await r.json()) || {}).data || {};
    if (!d.download_url) throw new Error("WaveSpeed upload answered without download_url: " + scrub(JSON.stringify(d), ctx.key).slice(0, 200));
    return d.download_url;
}

/** "W*H" for the crop, fitted into max_side and a multiple of 16 (the fill models' size input). */
function starSize(w, h, maxSide) {
    const k = Math.min(1, maxSide / Math.max(w, h));
    const r = (v) => Math.max(256, Math.round(v * k / 16) * 16);
    return `${r(w)}*${r(h)}`;
}

/**
 * A fill whose route takes the image list (`fields.images`) and names a mask field beside it (`fields.mask`, GPT Image
 * 2.5 / 2.6 edit's mask_image), with a mask to send: the mask goes there; an edit run or a text run sends none.
 */
function maskBeside(req) {
    const f = req.fields || {};
    return req.kind !== "text" && req.kind !== "edit" && !!f.images && typeof f.mask === "string" && !!f.mask && !!(req.mask && req.mask.length);
}

/** The variant's allowlist for this run (`text_accepts` on a text run when it has one, else `accepts`), or null. */
function acceptsOf(req) {
    const o = req.options || {};
    const list = req.kind === "text" && Array.isArray(o.text_accepts) ? o.text_accepts : o.accepts;
    return Array.isArray(list) ? list : null;
}

/** `sizing: "flux3"`: { aspect, resolution, fit } by FLUX 3's rules over the variant's presets (`options.aspect_ratios`). */
function flux3Shape(req) {
    const o = req.options || {};
    const presets = Array.isArray(o.aspect_ratios) && o.aspect_ratios.length ? o.aspect_ratios.map(String) : flux3.FLUX3_ASPECTS;
    return flux3.shapeOf({ ...req, options: {}, params: {} }, presets);
}

/**
 * `options.min_side` / `max_pixels` (FLUX 3 on WaveSpeed: 256 px a side, 4 MP): a reference layer or the Original outside
 * them is scaled into them through ctx.resizePng, the crop is refused; OpenRouter's rules on the same picture list.
 * Answers the request with the pictures as they go; throws, naming the picture, before the first upload.
 */
async function fitPictures(req, ctx, model) {
    const o = req.options || {};
    if (!(+o.min_side > 0) && !(+o.max_pixels > 0)) return req;
    const text = req.kind === "text";
    const pics = [...(text ? [] : [{ what: "crop", bytes: Buffer.from(req.image) }]), ...(req.references || []).map((r, i) => ({ what: `reference ${i + 1}`, bytes: Buffer.from(r) }))];
    await openrouter.sizeRules(pics, o, ctx, model, "WaveSpeed");
    return text ? { ...req, references: pics.map((x) => x.bytes) } : { ...req, image: pics[0].bytes, references: pics.slice(1).map((x) => x.bytes) };
}

/** The input of a run; what the answer's info should say about it goes into `info`. */
async function inputFor(req, ctx, info = {}) {
    const p = req.params || {}, f = req.fields || {}, o = req.options || {};
    const stamp = Date.now().toString(36);
    const input = { prompt: req.prompt || "" };
    const pictures = new Set();   // the keys a picture went into, which an allowlist keeps
    const fill = req.kind !== "text" && req.kind !== "edit" && !f.images;
    if (req.seed != null && !p.random_seed) input.seed = req.seed >>> 0;
    if (req.kind === "text") {
        // reference layers go to an edit route's image list (index.js refuses a run past the cap first; this keeps a
        // direct call from uploading one)
        const given = req.references || [];
        if (given.length) {
            const lay = textLayout(req), n = countOf(lay);
            if (lay.max != null && n > lay.max) throw new Error(`WaveSpeed ${String(req.model || "")} takes at most ${lay.max} reference picture${lay.max === 1 ? "" : "s"} for a new image; this run has ${n}: hide reference layers.`);
            if (!lay.drops) {
                const urls = [];
                for (let i = 0; i < given.length; i++) urls.push(await upload(ctx, given[i], `scumble-${stamp}-ref${i + 1}.png`));
                input[f.images || "images"] = urls;
                pictures.add(f.images || "images");
            }
        }
        if (o.size === "star") input.size = `${req.width}*${req.height}`;
    } else if (!fill) {
        // index.js refuses a run past the cap first (refs.checkPictures); this keeps a direct call from uploading one
        const lay = layout(req), n = countOf(lay);
        if (lay.max != null && n > lay.max) throw new Error(`WaveSpeed ${String(req.model || "")} takes at most ${lay.max} picture${lay.max === 1 ? "" : "s"}; this run has ${n}: hide reference layers or turn Original off.`);
        const urls = [await upload(ctx, req.image, `scumble-${stamp}-crop.png`)];
        for (let i = 0; i < req.references.length; i++) urls.push(await upload(ctx, req.references[i], `scumble-${stamp}-ref${i + 1}.png`));
        input[f.images || "images"] = urls;
        pictures.add(f.images || "images");
        // a fill whose route takes the image list and a mask beside it (GPT Image 2.5 / 2.6 edit): the selection's mask
        if (maskBeside(req)) {
            input[f.mask] = await upload(ctx, req.mask, `scumble-${stamp}-mask.png`);
            pictures.add(f.mask);
        }
    } else {
        const who = `WaveSpeed ${String(req.model || "")}`;
        const lay = layout(req), n = countOf(lay);
        if (lay.max != null && n > lay.max) throw new Error(`${who} takes at most ${lay.max} picture${lay.max === 1 ? "" : "s"}; this run has ${n}: hide reference layers or turn Original off.`);
        // every check before the first upload: the crop's shape (`options.max_ratio`), the mask, the bytes of each picture
        checkRatio(req.image, o, who);
        let mask = req.mask && req.mask.length ? req.mask : null;
        if (mask && o.mask === "black") {
            mask = ideogramMask(mask, req.image, ctx, who);
            if (!mask) info.mask = "none: the selection covers the whole crop, so the whole crop was edited";
        }
        const crop = withinBytes(req.image, "crop", o, ctx, who);
        const maskPic = mask ? withinBytes(mask, "mask", o, ctx, who) : null;
        const refPics = f.references ? (req.references || []).map((b, i) => withinBytes(b, `reference picture ${i + 1}`, o, ctx, who)) : [];
        const ext = (pic) => (pic.mime === "image/jpeg" ? "jpg" : "png");
        input[f.image || "image"] = await upload(ctx, crop.bytes, `scumble-${stamp}-crop.${ext(crop)}`, crop.mime);
        pictures.add(f.image || "image");
        if (maskPic) {
            input[f.mask || "mask_image"] = await upload(ctx, maskPic.bytes, `scumble-${stamp}-mask.${ext(maskPic)}`, maskPic.mime);
            pictures.add(f.mask || "mask_image");
        }
        if (refPics.length) {
            const urls = [];
            for (let i = 0; i < refPics.length; i++) urls.push(await upload(ctx, refPics[i].bytes, `scumble-${stamp}-ref${i + 1}.${ext(refPics[i])}`, refPics[i].mime));
            input[f.references] = urls;
            pictures.add(f.references);
        }
    }
    if (o.size === "star" && req.kind !== "text") input.size = starSize(req.width, req.height, num(o.max_side, 1536));
    // recipe settings are passed through by name; the recipe decides which exist for the model
    for (const [k, v] of Object.entries(p)) {
        if (k === "random_seed" || (k === "model" && !o.model_row) || v === "" || v == null || v === "auto") continue;
        input[k] = v;
    }
    if (o.sizing === "flux3") {
        // FLUX 3: the tier by area; a text run the nearest preset, an edit the crop's preset or none (image 1's shape)
        const shape = flux3Shape(req);
        if (input.resolution == null) input.resolution = shape.resolution;
        if (input.aspect_ratio == null && shape.aspect !== "auto") input.aspect_ratio = shape.aspect;
        // the row as the schema types it (an agent may give "on" / "off")
        if (input.enable_prompt_expansion !== undefined) input.enable_prompt_expansion = flux3.switchOf(input.enable_prompt_expansion, "Prompt expansion");
        info.resolution = input.resolution;
        info.aspect_ratio = input.aspect_ratio || null;
        // an edit sent at a preset comes back in its shape, which the stitch stretches onto the crop
        if (req.kind !== "text" && input.aspect_ratio) info.fit = "stretch";
    }
    // a fill answers at the crop's size: no aspect preset (Ideogram 4.5's edit refuses one beside a mask), nor beside a
    // mask that goes with an image list (the route picks the shape from the crop, which limits.aspects made a preset's)
    if (!fill && !pictures.has(f.mask) && o.sizing !== "flux3" && Array.isArray(o.aspect_ratios) && o.aspect_ratios.length && input.aspect_ratio == null) input.aspect_ratio = closestAspect(req.width, req.height, o.aspect_ratios);
    if (req.kind === "text") {
        // a value the text route does not take becomes the one the variant names for it (a new image gets the edit's
        // Settings rows, host.providerParams)
        for (const [k, swap] of Object.entries(o.text_values || {})) {
            if (swap && typeof swap === "object" && input[k] != null && Object.prototype.hasOwnProperty.call(swap, String(input[k]))) input[k] = swap[String(input[k])];
        }
        if (o.tiers && input.resolution == null) {
            const tier = tierFor(Math.max(+req.width || 0, +req.height || 0), o.tiers);
            if (tier) input.resolution = tier;
        }
    }
    if (req.negative && input.negative_prompt === undefined && (req.kind !== "edit" || o.edit_negative) && o.negative !== false) input.negative_prompt = req.negative;
    if (input.output_format === undefined) input.output_format = "png";
    const allow = acceptsOf(req);
    if (allow) {
        const keep = new Set(["prompt", ...allow, ...pictures]);
        for (const k of Object.keys(input)) if (!keep.has(k)) delete input[k];
    }
    return input;
}

/**
 * Where inputFor above puts each picture of a fill or an edit (the image list carries no mask; a fill that names
 * `fields.mask` beside the list sends the mask in that field of its own). `max` is the variant's options.max_images
 * (the pictures in the list; with `fields.references` the crop and the references); the fill shape sends no reference,
 * unless it names a `fields.references` list (Ideogram 4.5): its references go there unnumbered (`style`, so the
 * prompt cannot name one).
 */
function layout(req) {
    const f = req.fields || {}, o = req.options || {};
    const max = +o.max_images > 0 ? +o.max_images : null;
    if (req.kind === "edit" || f.images) {
        const F = f.images || "images";
        const own = maskBeside(req) ? [["mask", f.mask]] : [];
        return layoutOf({ seq: [["crop", `${F}[0]`], ...refRoles(req).map(([role, i]) => [role, `${F}[${i + 1}]`, i])], own, max });
    }
    const mask = req.mask ? [["mask", f.mask || "mask_image"]] : [];
    if (f.references) {
        const refs = refRoles(req).map(([role, i]) => [role, `${f.references}[${i}]`, i]);
        return layoutOf({ seq: [["crop", f.image || "image"]], own: [...mask, ...refs], max, style: true });
    }
    return layoutOf({ seq: [["crop", f.image || "image"]], own: mask, max, drops: "This endpoint takes the crop and the mask only" });
}

/**
 * Where inputFor puts the references of a text run: the image list from its first place, as many as
 * options.max_images (the crop's slot is a reference's here). Only an edit route takes pictures; a text-to-image model
 * and the fill models make the image from the prompt alone.
 */
function textLayout(req) {
    const f = req.fields || {}, o = req.options || {};
    const model = String(req.model || "").replace(/^\/+|\/+$/g, "");
    if (!EDIT_ROUTE.test(model)) return layoutOf({ drops: "this model takes no reference images for a new image" });
    const F = f.images || "images";
    return layoutOf({ seq: refRoles(req).map(([role, i]) => [role, `${F}[${i}]`, i]), max: +o.max_images > 0 ? +o.max_images : null });
}

module.exports = {
    label: "WaveSpeedAI",
    generate(req, ctx) {
        return this.edit(req, ctx);   // inputFor() leaves the crop out for kind "text" (the references alone go)
    },
    keyUrl: "https://wavespeed.ai/?ref=dennisi6",
    keyHint: "API key from wavespeed.ai > Access Keys (the link carries Scumble's referral code)",
    layout,
    textLayout,
    async edit(req, ctx) {
        const model = String(req.model || "").replace(/^\/+|\/+$/g, "");
        if (!model) throw new Error("WaveSpeed recipe has no model id.");
        // FLUX 3's schema takes no blank prompt (minLength 1): refused before the first upload
        if ((req.options || {}).sizing === "flux3" && !String(req.prompt || "").trim()) throw new Error(`WaveSpeed ${model} needs a prompt: say what to make or change.`);
        req = await fitPictures(req, ctx, model);
        const sent = {};
        const input = await inputFor(req, ctx, sent);
        const { data, id } = await submitAndWait(ctx, model, input);
        ctx.jobDone = true;   // completed: generated and charged, so a Cancel during the download says that
        const out = Array.isArray(data.outputs) ? data.outputs[0] : null;
        if (!out) throw new Error("WaveSpeed: no output in the result (" + scrub(JSON.stringify(data), ctx.key).slice(0, 200) + ")");
        if (Array.isArray(data.has_nsfw_contents) && data.has_nsfw_contents[0]) ctx.log("result flagged as nsfw by WaveSpeed");
        // outputs are CDN URLs, or naked base64 with enable_base64_output
        const file = /^https?:/.test(out) ? await downloadImage(out, ctx, { who: `WaveSpeed ${model}`, id }) : { bytes: Buffer.from(String(out).replace(/^data:[^,]*,/, ""), "base64"), mime: "image/png" };
        // a route whose allowlist kept the seed home reports none (two runs differ)
        const seed = acceptsOf(req) && !("seed" in input) ? undefined : num(input.seed, req.seed);
        return { bytes: file.bytes, mime: file.mime, seed, info: { model, ms: data.timings && data.timings.inference, ...sent } };
    },

    /**
     * Split one picture into layers (req.image; no references, no mask) on the variant's layer route
     * (`options.layers.model`). -> layersplit.js's answer: the base first, then the layers; each output that is a bare
     * URL lands over the whole picture (`full`), as "Layer n".
     */
    async layers(req, ctx) {
        const caller = ctx;   // the job's state is read on the object providers/index.js holds
        const o = req.options || {};
        const spec = split.specOf(o);
        const model = spec && spec.model ? spec.model.replace(/^\/+|\/+$/g, "") : "";
        const who = `WaveSpeed ${model || String(req.model || "")}`;
        if (!spec || !model) throw new Error(`${who} has no layer mode.`);
        const ask = split.askOf(req, who, spec);
        const stamp = Date.now().toString(36);
        // ModelArk's 30 MB a picture (the same model; WaveSpeed states none): an opaque picture over it goes as JPEG, else refused
        let pic = { bytes: Buffer.from(req.image), mime: "image/png" };
        if (pic.bytes.length > SPLIT_MAX_BYTES && typeof ctx.opaque === "function" && typeof ctx.toJpeg === "function" && await ctx.opaque(pic.bytes)) {
            const jpeg = await ctx.toJpeg(pic.bytes, 92);
            if (jpeg && jpeg.length && jpeg.length < pic.bytes.length) pic = { bytes: Buffer.from(jpeg), mime: "image/jpeg" };
        }
        if (pic.bytes.length > SPLIT_MAX_BYTES) throw new Error(`${who}: the picture is ${(pic.bytes.length / 1e6).toFixed(1)} MB, more than the 30 MB a picture may have${pic.mime === "image/png" ? " (it has transparency or could not go as JPEG, so it stays PNG)" : " even as JPEG"}. Use a smaller picture or layer.`);
        const input = { image: await upload(ctx, pic.bytes, `scumble-${stamp}-split.${pic.mime === "image/jpeg" ? "jpg" : "png"}`, pic.mime) };
        if (ask.prompt) input.prompt = ask.prompt;
        input.resolution = splitResolution(ask.tier, req.image);
        // the base and the layers together; the count is the layers alone
        input.max_images = (ask.count != null ? ask.count : spec.max) + 1;
        input.output_format = "png";
        const { data, id } = await submitAndWait(ctx, model, input);
        caller.jobDone = true;   // answered: generated and charged, so a Cancel during the downloads says that
        const list = Array.isArray(data.outputs) ? data.outputs : [];
        const items = list.filter((x) => (typeof x === "string" && x) || (x && typeof x === "object" && (x.url || x.b64_json)));
        // an empty slot is refused as ModelArk's and Oxen's are: dropping it would make a layer the base (the frame of every box)
        if (!items.length || items.length !== list.length) throw new Error(scrub(`WaveSpeed ${model}: an answer without its pictures (${items.length} of ${list.length})`, ctx.key));
        const get = async (d) => {
            const url = typeof d === "string" ? d : d.url;
            if (d && typeof d === "object" && d.b64_json) { const bytes = Buffer.from(String(d.b64_json), "base64"); return { bytes, mime: bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : "image/png" }; }
            if (!/^https?:/.test(String(url))) { const bytes = Buffer.from(String(url).replace(/^data:[^,]*,/, ""), "base64"); return { bytes, mime: "image/png" }; }
            return await downloadImage(url, ctx, { who: `WaveSpeed ${model}`, id });
        };
        const { out, missing } = await split.collect(items, get, ctx, `WaveSpeed ${model}`);
        return {
            bytes: out[0].bytes, mime: out[0].mime, seed: undefined, layers: out, missing,
            info: { model, resolution: input.resolution, asked: ask.count, max_images: input.max_images, layers: out.length - 1, unplaced: out.filter((l) => l.full).length },
        };
    },
};

/** One prediction: the submit, then its status until it is done. Throws on a refusal or an end that is no success. -> { data, id }. */
async function submitAndWait(ctx, model, input) {
    const headers = { Authorization: "Bearer " + ctx.key, "Content-Type": "application/json" };
    const submit = await ctx.fetch(BASE + model, { method: "POST", headers, body: JSON.stringify(input) });
    if (!submit.ok) throw new Error(scrub(`WaveSpeed ${model}: ${await readError(submit, ctx.key)}`, ctx.key));
    const first = (await submit.json()) || {};
    let data = first.data || {};
    if (!data.id) throw new Error("WaveSpeed answered without a prediction id: " + scrub(JSON.stringify(first), ctx.key).slice(0, 200));
    const id = String(data.id);
    const resultUrl = (data.urls && data.urls.get) || `${BASE}predictions/${data.id}/result`;
    const done = new Set(["completed", "failed", "cancelled", "timeout", "deleted"]);
    data = await pollJob(ctx, {
        who: `WaveSpeed ${model}`,
        timeoutWho: "WaveSpeed",
        statusWho: "WaveSpeed status",
        id,
        waitMs: 15 * 60 * 1000,
        initial: data,
        url: resultUrl,
        headers: { Authorization: headers.Authorization },
        delay: POLL_MS,
        parse: (j, prev) => (j && typeof j === "object" && j.data && typeof j.data === "object" && typeof j.data.status === "string" ? { ...prev, ...j.data } : null),
        done: (d) => done.has(String(d.status || "").toLowerCase()),
    });
    if (String(data.status || "").toLowerCase() !== "completed") throw new Error(scrub(`WaveSpeed ${model}: ${data.error || data.status}`, ctx.key));
    return { data, id };
}

module.exports._splitResolution = splitResolution;
