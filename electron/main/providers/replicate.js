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
// layout(req) declares where each picture goes (docs/PLAN_REFS.md C3).
"use strict";

const { dataUri, fetchImage, readError, sleep, num } = require("./util");
const { layoutOf, refRoles, countOf } = require("./refs");

const BASE = "https://api.replicate.com/v1";
const DATA_URI_MAX = 256 * 1024;   // Replicate's guidance: data URLs up to 256 kB, larger files by URL

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
        // no image field at all; the shape goes as the model's aspect_ratio
        if (req.aspect && input.aspect_ratio === undefined) input.aspect_ratio = req.aspect;
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

module.exports = {
    label: "Replicate",
    keyUrl: "https://replicate.com/account/api-tokens",
    keyHint: "r8_... API token from replicate.com",
    generate(req, ctx) {
        return this.edit(req, ctx);   // inputFor() leaves the image out for kind "text"
    },
    layout,
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
