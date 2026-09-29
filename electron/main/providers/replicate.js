// Replicate: POST https://api.replicate.com/v1/models/<owner>/<name>/predictions (official
// models) or POST /v1/predictions with { version } ("owner/name:version" in the recipe),
// header Authorization: Bearer <token>, then poll urls.get until succeeded / failed.
// File inputs go in as data URIs when small, otherwise through the Files API
// (POST /v1/files, multipart "content", the answer's urls.get is the input URL; files
// expire after 24 h). The output is a URL, a list of URLs or an object; the first
// http(s) string in it is the image.
//
// Models differ in their input names, so a recipe may set `fields`:
//   fill: { image: "image", mask: "mask" }                  (flux-fill-pro, flux-fill-dev, ...)
//   edit: { images: "image_input" } or { image: "image" }   (nano-banana, qwen-image-edit, ...)
// `options.max_images` is how many pictures the image list takes (the crop included); a run with more is refused
// before any upload.
// A text run (Generate new) goes to the same model without the crop: reference layers, when there are any, fill the
// image list in order (the crop's slot being a reference's), and the shape goes as `aspect_ratio`: the one asked for,
// else the preset closest to the asked size. It never keeps the edit's "match_input_image", which would follow the
// first reference's shape or none at all.
// layout(req) and textLayout(req) declare where each picture goes (docs/PLAN_REFS.md C3).
"use strict";

const { dataUri, fetchImage, readError, sleep, num, closestAspect } = require("./util");
const { layoutOf, refRoles, countOf } = require("./refs");

const BASE = "https://api.replicate.com/v1";
const DATA_URI_MAX = 256 * 1024;   // Replicate's guidance: data URLs up to 256 kB, larger files by URL
// the aspect presets FLUX.2, Nano Banana and Seedream on Replicate share, for a text run asked for a size without an
// aspect (the Generate new dialog's free size, an agent's width and height)
const TEXT_ASPECTS = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"];

async function fileUrl(bytes, name, ctx) {
    if (bytes.length <= DATA_URI_MAX) return dataUri(bytes);
    const fd = new FormData();
    fd.append("content", new Blob([bytes], { type: "image/png" }), name);
    const r = await ctx.fetch(`${BASE}/files`, { method: "POST", headers: { Authorization: "Bearer " + ctx.key }, body: fd });
    if (!r.ok) throw new Error(`Replicate file upload: ${await readError(r)}`);
    const f = await r.json();
    if (!f.urls || !f.urls.get) throw new Error("Replicate file upload answered without urls.get");
    return f.urls.get;
}

function firstUrl(out) {
    if (typeof out === "string") return /^(https?:|data:)/.test(out) ? out : null;
    if (Array.isArray(out)) { for (const v of out) { const u = firstUrl(v); if (u) return u; } return null; }
    if (out && typeof out === "object") { for (const v of Object.values(out)) { const u = firstUrl(v); if (u) return u; } }
    return null;
}

async function inputFor(req, ctx) {
    const p = req.params;
    const fields = { ...(req.fields || {}) };
    const input = { prompt: req.prompt || "" };
    if (req.seed != null && !p.random_seed) input.seed = req.seed >>> 0;
    if (req.kind === "text") {
        // no crop; the shape goes as the model's aspect_ratio (held against the settings below), reference layers fill
        // the image list (index.js refuses a run past the cap first; this keeps a direct call from uploading one)
        if (req.aspect) input.aspect_ratio = req.aspect;
        const given = req.references || [];
        if (given.length) {
            const lay = textLayout(req), n = countOf(lay);
            if (lay.max != null && n > lay.max) throw new Error(`Replicate ${String(req.model || "")} takes at most ${lay.max} reference picture${lay.max === 1 ? "" : "s"} for a new image; this run has ${n}: hide reference layers.`);
            if (!lay.drops) {
                const refs = [];
                for (let i = 0; i < given.length; i++) refs.push(await fileUrl(given[i], `reference_${i + 1}.png`, ctx));
                input[fields.images || "image_input"] = refs;
            }
        }
    } else if (req.kind === "edit") {
        // index.js refuses a run past the cap first (refs.checkPictures); this keeps a direct call from uploading one
        const lay = layout(req), n = countOf(lay);
        if (lay.max != null && n > lay.max) throw new Error(`Replicate ${String(req.model || "")} takes at most ${lay.max} picture${lay.max === 1 ? "" : "s"}; this run has ${n}: hide reference layers or turn Original off.`);
        const crop = await fileUrl(req.image, "crop.png", ctx);
        if (fields.images || !fields.image) {
            const refs = [];
            for (let i = 0; i < req.references.length; i++) refs.push(await fileUrl(req.references[i], `reference_${i + 1}.png`, ctx));
            input[fields.images || "image_input"] = [crop, ...refs];
        } else {
            input[fields.image] = crop;
        }
    } else {
        input[fields.image || "image"] = await fileUrl(req.image, "crop.png", ctx);
        if (req.mask) input[fields.mask || "mask"] = await fileUrl(req.mask, "mask.png", ctx);
    }
    for (const [k, v] of Object.entries(p)) {
        if (k === "random_seed" || v === "" || v == null) continue;
        input[k] = v;
    }
    if (req.kind === "text") {
        // the asked aspect wins over the variant's fixed "match_input_image" (the edit's, which reaches a text run
        // through the renderer's params); without an asked aspect that value becomes the preset closest to the asked
        // size, and a model that names no aspect_ratio keeps its own default
        if (req.aspect) input.aspect_ratio = req.aspect;
        else if (input.aspect_ratio === "match_input_image") input.aspect_ratio = closestAspect(req.width || 1024, req.height || 1024, TEXT_ASPECTS);
    }
    if (req.negative && input.negative_prompt === undefined && req.kind !== "edit") input.negative_prompt = req.negative;
    return input;
}

/**
 * Where inputFor above puts each picture of a fill or an edit (the request body is { input } or { version, input }).
 * `max` is the variant's options.max_images (the pictures in the list); a fill, and an edit with one image field
 * (Qwen Image Edit), send no reference.
 */
function layout(req) {
    const fields = req.fields || {}, o = req.options || {};
    const max = +o.max_images > 0 ? +o.max_images : null;
    if (req.kind === "edit" && (fields.images || !fields.image)) {
        const F = `input.${fields.images || "image_input"}`;
        return layoutOf({ seq: [["crop", `${F}[0]`], ...refRoles(req).map(([role, i]) => [role, `${F}[${i + 1}]`, i])], max });
    }
    if (req.kind === "edit") return layoutOf({ seq: [["crop", `input.${fields.image}`]], max, drops: "This endpoint takes one picture" });
    return layoutOf({ seq: [["crop", `input.${fields.image || "image"}`]], own: req.mask ? [["mask", `input.${fields.mask || "mask"}`]] : [], max, drops: "This endpoint takes the crop and the mask only" });
}

/**
 * Where inputFor puts the references of a text run: the image list (`fields.images`, else "image_input") from its
 * first place, as many as options.max_images (the crop's slot is a reference's here). A model with one image field
 * (Qwen Image Edit, the fills) makes the image from the prompt alone.
 */
function textLayout(req) {
    const fields = req.fields || {}, o = req.options || {};
    if (!fields.images && fields.image) return layoutOf({ drops: "This endpoint takes no reference images for a new image" });
    const F = `input.${fields.images || "image_input"}`;
    return layoutOf({ seq: refRoles(req).map(([role, i]) => [role, `${F}[${i}]`, i]), max: +o.max_images > 0 ? +o.max_images : null });
}

module.exports = {
    label: "Replicate",
    keyUrl: "https://replicate.com/account/api-tokens",
    keyHint: "r8_... API token from replicate.com",
    generate(req, ctx) {
        return this.edit(req, ctx);   // inputFor() leaves the crop out for kind "text" (the references alone go)
    },
    layout,
    textLayout,
    async edit(req, ctx) {
        const model = String(req.model || "").replace(/^\/+|\/+$/g, "");
        if (!model) throw new Error("Replicate recipe has no model (owner/name or owner/name:version).");
        const headers = { Authorization: "Bearer " + ctx.key, "Content-Type": "application/json", Prefer: "wait=30" };
        const input = await inputFor(req, ctx);
        let url, body;
        const m = /^([^:]+):([A-Za-z0-9]+)$/.exec(model);
        if (m) { url = `${BASE}/predictions`; body = { version: m[2], input }; }
        else { url = `${BASE}/models/${model}/predictions`; body = { input }; }
        const submit = await ctx.fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        if (!submit.ok) throw new Error(`Replicate ${model}: ${await readError(submit)}`);
        let pred = await submit.json();
        const t0 = Date.now();
        while (!["succeeded", "failed", "canceled"].includes(pred.status)) {
            if (Date.now() - t0 > 15 * 60 * 1000) throw new Error("Replicate: timed out after 15 minutes");
            await sleep(pred.status === "starting" ? 2000 : 1000);
            const get = pred.urls && pred.urls.get ? pred.urls.get : `${BASE}/predictions/${pred.id}`;
            const r = await ctx.fetch(get, { headers: { Authorization: headers.Authorization } });
            if (!r.ok) throw new Error(`Replicate poll: ${await readError(r)}`);
            pred = await r.json();
        }
        if (pred.status !== "succeeded") throw new Error("Replicate: " + (pred.error || pred.status));
        const imgUrl = firstUrl(pred.output);
        if (!imgUrl) throw new Error("Replicate: no image URL in the output (" + JSON.stringify(pred.output).slice(0, 200) + ")");
        const file = await fetchImage(imgUrl, ctx.fetch);
        const metrics = pred.metrics || {};
        return { bytes: file.bytes, mime: file.mime, seed: num(input.seed, req.seed), info: { model, id: pred.id, predict_time: metrics.predict_time } };
    },
};
