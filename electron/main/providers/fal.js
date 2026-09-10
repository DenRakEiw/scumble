// fal.ai: one key, many image models. Queue protocol: POST https://queue.fal.run/<model>
// -> { request_id, status_url, response_url }, poll status_url until COMPLETED, GET
// response_url. Images go in as base64 data URIs, come back as URLs.
//
// Two request shapes, chosen by the recipe's `kind`:
//   fill: { image_url, mask_url, prompt, ... }        (flux-pro/v1/fill, flux-lora-fill, qwen-image-edit/inpaint, ...)
//   edit: { image_urls: [crop, references...], prompt } (flux-2-pro/edit, flux-2/edit, nano-banana/edit, ...)
// A recipe variant may rename the inputs with `fields` ({ image, images, mask }; gpt-image-2 on fal
// takes image_urls plus mask_url) and switch the size hint off with options.sizing = "none" for
// endpoints without a free image_size (nano-banana, seedream, gpt-image).
"use strict";

const { dataUri, fetchImage, readError, sleep, num } = require("./util");

const QUEUE = "https://queue.fal.run/";

function inputFor(req) {
    const p = req.params;
    const input = { prompt: req.prompt || "", output_format: "png", num_images: 1 };
    if (req.seed != null && !p.random_seed) input.seed = req.seed >>> 0;
    const f = req.fields || {};
    const sizing = (req.options && req.options.sizing) || "image_size";
    if (req.kind === "text") {
        if (sizing === "image_size") input.image_size = { width: req.width, height: req.height };
        else if (req.aspect) input.aspect_ratio = req.aspect;
    } else if (req.kind === "edit" || f.images) {
        input[f.images || "image_urls"] = [dataUri(req.image), ...req.references.map((r) => dataUri(r))];
        // keep the crop's size: the stitch stretches only a same-aspect result back exactly
        if (sizing === "image_size" && req.kind === "edit") input.image_size = { width: req.width, height: req.height };
    } else {
        input[f.image || "image_url"] = dataUri(req.image);
    }
    if (req.mask && req.kind !== "edit") input[f.mask || "mask_url"] = dataUri(req.mask);
    // recipe settings are passed through by name; the recipe decides which exist for the model
    for (const [k, v] of Object.entries(p)) {
        if (k === "random_seed" || k === "model" || v === "" || v == null) continue;
        input[k] = v;
    }
    if (req.negative && input.negative_prompt === undefined && req.kind !== "edit") input.negative_prompt = req.negative;
    return input;
}

module.exports = {
    label: "fal.ai",
    keyUrl: "https://fal.ai/dashboard/keys",
    keyHint: "FAL_KEY from the fal.ai dashboard",
    generate(req, ctx) {
        return this.edit(req, ctx);   // inputFor() leaves the images out for kind "text"
    },
    async edit(req, ctx) {
        const model = String(req.model || "").replace(/^\/+|\/+$/g, "");
        if (!model) throw new Error("fal.ai recipe has no model id.");
        const headers = { Authorization: "Key " + ctx.key, "Content-Type": "application/json" };
        const submit = await ctx.fetch(QUEUE + model, { method: "POST", headers, body: JSON.stringify(inputFor(req)) });
        if (!submit.ok) throw new Error(`fal.ai ${model}: ${await readError(submit)}`);
        const job = await submit.json();
        const statusUrl = job.status_url, resultUrl = job.response_url;
        if (!statusUrl || !resultUrl) throw new Error("fal.ai answered without status_url / response_url: " + JSON.stringify(job).slice(0, 200));
        const t0 = Date.now();
        let status = job.status || "IN_QUEUE";
        while (status !== "COMPLETED") {
            if (Date.now() - t0 > 15 * 60 * 1000) throw new Error("fal.ai: timed out after 15 minutes");
            await sleep(status === "IN_QUEUE" ? 1500 : 1000);
            const r = await ctx.fetch(statusUrl, { headers: { Authorization: headers.Authorization } });
            if (!r.ok) throw new Error(`fal.ai status: ${await readError(r)}`);
            const s = await r.json();
            status = s.status || status;
            if (status === "FAILED" || s.error) throw new Error("fal.ai: " + (s.error || "request failed"));
        }
        const r = await ctx.fetch(resultUrl, { headers: { Authorization: headers.Authorization } });
        if (!r.ok) throw new Error(`fal.ai result: ${await readError(r)}`);
        const out = await r.json();
        const img = (out.images && out.images[0]) || out.image;
        if (!img || !img.url) throw new Error("fal.ai: no image in the result (" + JSON.stringify(out).slice(0, 200) + ")");
        if (Array.isArray(out.has_nsfw_concepts) && out.has_nsfw_concepts[0]) ctx.log("result flagged as nsfw by fal.ai, image may be blurred");
        const file = await fetchImage(img.url, ctx.fetch);
        return { bytes: file.bytes, mime: img.content_type || file.mime, seed: num(out.seed, req.seed), info: { model, width: img.width, height: img.height } };
    },
};
