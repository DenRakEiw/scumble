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
// A recipe variant may rename the inputs with `fields` ({ image, images, mask, references }); `options`:
// `aspect_ratios` (the model's presets, the closest to the crop is sent unless the settings
// pick one; never on a fill), `size: "star"` (send the crop size as "W*H", fitted to `max_side`), `max_images` (how
// many pictures the image list takes, the crop included; a run with more is refused before any upload).
// `options` for a model with its own conventions (Ideogram 4.5): `mask: "black"` sends the mask inverted (black =
// edit, util.js ideogramMask; none for a selection over the whole crop), `negative: false` sends no negative prompt,
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
// Referral: the key link (keyUrl) carries DenRakEiw's WaveSpeed referral code.
"use strict";

const { fetchImage, readError, sleep, num, closestAspect, tierFor, checkRatio, withinBytes, ideogramMask } = require("./util");
const { layoutOf, refRoles, countOf } = require("./refs");

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
            if (!put.ok) throw new Error(`WaveSpeed upload (${name}): ${await readError(put)}`);
            return t.download_url;
        }
        ctx.log("upload ticket without download_url / upload.url, using the binary upload:", JSON.stringify(t).slice(0, 200));
    } else {
        ctx.log("upload ticket answered", ticket.status, "- using the binary upload");
    }
    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type: mime }), name);
    const r = await ctx.fetch(BASE + "media/upload/binary", { method: "POST", headers: auth, body: fd });
    if (!r.ok) throw new Error(`WaveSpeed upload (${name}): ${await readError(r)}`);
    const d = ((await r.json()) || {}).data || {};
    if (!d.download_url) throw new Error("WaveSpeed upload answered without download_url: " + JSON.stringify(d).slice(0, 200));
    return d.download_url;
}

/** "W*H" for the crop, fitted into max_side and a multiple of 16 (the fill models' size input). */
function starSize(w, h, maxSide) {
    const k = Math.min(1, maxSide / Math.max(w, h));
    const r = (v) => Math.max(256, Math.round(v * k / 16) * 16);
    return `${r(w)}*${r(h)}`;
}

/** The variant's allowlist for this run (`text_accepts` on a text run when it has one, else `accepts`), or null. */
function acceptsOf(req) {
    const o = req.options || {};
    const list = req.kind === "text" && Array.isArray(o.text_accepts) ? o.text_accepts : o.accepts;
    return Array.isArray(list) ? list : null;
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
        if (k === "random_seed" || k === "model" || v === "" || v == null || v === "auto") continue;
        input[k] = v;
    }
    // a fill answers at the crop's size: no aspect preset (Ideogram 4.5's edit refuses one beside a mask)
    if (!fill && Array.isArray(o.aspect_ratios) && o.aspect_ratios.length && input.aspect_ratio == null) input.aspect_ratio = closestAspect(req.width, req.height, o.aspect_ratios);
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
    if (req.negative && input.negative_prompt === undefined && req.kind !== "edit" && o.negative !== false) input.negative_prompt = req.negative;
    if (input.output_format === undefined) input.output_format = "png";
    const allow = acceptsOf(req);
    if (allow) {
        const keep = new Set(["prompt", ...allow, ...pictures]);
        for (const k of Object.keys(input)) if (!keep.has(k)) delete input[k];
    }
    return input;
}

/**
 * Where inputFor above puts each picture of a fill or an edit (the image list carries no mask). `max` is the variant's
 * options.max_images (the pictures in the list; with `fields.references` the crop and the references); the fill shape
 * sends no reference, unless it names a `fields.references` list (Ideogram 4.5): its references go there unnumbered
 * (`style`, so the prompt cannot name one).
 */
function layout(req) {
    const f = req.fields || {}, o = req.options || {};
    const max = +o.max_images > 0 ? +o.max_images : null;
    if (req.kind === "edit" || f.images) {
        const F = f.images || "images";
        return layoutOf({ seq: [["crop", `${F}[0]`], ...refRoles(req).map(([role, i]) => [role, `${F}[${i + 1}]`, i])], max });
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
        const headers = { Authorization: "Bearer " + ctx.key, "Content-Type": "application/json" };
        const sent = {};
        const input = await inputFor(req, ctx, sent);
        const submit = await ctx.fetch(BASE + model, { method: "POST", headers, body: JSON.stringify(input) });
        if (!submit.ok) throw new Error(`WaveSpeed ${model}: ${await readError(submit)}`);
        const first = (await submit.json()) || {};
        let data = first.data || {};
        if (!data.id) throw new Error("WaveSpeed answered without a prediction id: " + JSON.stringify(first).slice(0, 200));
        const resultUrl = (data.urls && data.urls.get) || `${BASE}predictions/${data.id}/result`;
        const t0 = Date.now();
        const done = new Set(["completed", "failed", "cancelled", "timeout", "deleted"]);
        while (!done.has(String(data.status || "").toLowerCase())) {
            if (Date.now() - t0 > 15 * 60 * 1000) throw new Error("WaveSpeed: timed out after 15 minutes");
            await sleep(POLL_MS);
            const r = await ctx.fetch(resultUrl, { headers: { Authorization: headers.Authorization } });
            if (!r.ok) throw new Error(`WaveSpeed status: ${await readError(r)}`);
            data = ((await r.json()) || {}).data || {};
        }
        if (data.status !== "completed") throw new Error(`WaveSpeed ${model}: ${data.error || data.status}`);
        const out = Array.isArray(data.outputs) ? data.outputs[0] : null;
        if (!out) throw new Error("WaveSpeed: no output in the result (" + JSON.stringify(data).slice(0, 200) + ")");
        if (Array.isArray(data.has_nsfw_contents) && data.has_nsfw_contents[0]) ctx.log("result flagged as nsfw by WaveSpeed");
        // outputs are CDN URLs, or naked base64 with enable_base64_output
        const file = /^https?:/.test(out) ? await fetchImage(out, ctx.fetch) : { bytes: Buffer.from(String(out).replace(/^data:[^,]*,/, ""), "base64"), mime: "image/png" };
        // a route whose allowlist kept the seed home reports none (two runs differ)
        const seed = acceptsOf(req) && !("seed" in input) ? undefined : num(input.seed, req.seed);
        return { bytes: file.bytes, mime: file.mime, seed, info: { model, ms: data.timings && data.timings.inference, ...sent } };
    },
};
