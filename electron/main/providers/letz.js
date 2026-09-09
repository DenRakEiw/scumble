// LetzAI (api.letz.ai, Bearer key from letz.ai/subscription). Images must be public URLs,
// so the crop goes up as a user asset first: POST /user-assets -> { uploadUrl, imageUrl },
// PUT the PNG to uploadUrl, then POST /image-edits { mode: "in", prompt, imageUrl, mask
// (base64 PNG, white on black, same size as the image), settings: { resolution } } and
// poll GET /image-edits/<id> until status ready / saved; imageVersions.original is the
// result. Mode "context" (no mask) is used for edit recipes, references go in as
// inputImageUrls.
"use strict";

const { b64, fetchImage, readError, sleep } = require("./util");

const BASE = "https://api.letz.ai";

async function upload(bytes, name, ctx) {
    const headers = { Authorization: "Bearer " + ctx.key, "Content-Type": "application/json" };
    const r = await ctx.fetch(`${BASE}/user-assets`, {
        method: "POST", headers,
        body: JSON.stringify({ extension: "png", mimeType: "image/png", fileSize: bytes.length, originalFilename: name }),
    });
    if (!r.ok) throw new Error(`LetzAI asset: ${await readError(r)}`);
    const asset = await r.json();
    if (!asset.uploadUrl || !asset.imageUrl) throw new Error("LetzAI asset answered without uploadUrl / imageUrl: " + JSON.stringify(asset).slice(0, 200));
    const put = await ctx.fetch(asset.uploadUrl, { method: "PUT", headers: { "Content-Type": "image/png" }, body: bytes });
    if (!put.ok) throw new Error(`LetzAI upload: ${await readError(put)}`);
    return asset.imageUrl;
}

module.exports = {
    label: "LetzAI",
    keyUrl: "https://letz.ai/subscription",
    keyHint: "API key from the LetzAI subscription page",
    async edit(req, ctx) {
        const p = req.params;
        const headers = { Authorization: "Bearer " + ctx.key, "Content-Type": "application/json" };
        const imageUrl = await upload(req.image, "crop.png", ctx);
        const body = { prompt: req.prompt || "", imageUrl, settings: {} };
        if (req.kind === "edit" || !req.mask) {
            body.mode = String(p.mode || "context");
            if (req.references.length) {
                body.inputImageUrls = [];
                for (let i = 0; i < Math.min(req.references.length, 8); i++) body.inputImageUrls.push(await upload(req.references[i], `reference_${i + 1}.png`, ctx));
            }
        } else {
            body.mode = "in";
            body.mask = b64(req.mask);
        }
        if (p.resolution) body.settings.resolution = p.resolution;
        if (p.model) body.settings.model = p.model;
        if (!Object.keys(body.settings).length) delete body.settings;
        const submit = await ctx.fetch(`${BASE}/image-edits`, { method: "POST", headers, body: JSON.stringify(body) });
        if (!submit.ok) throw new Error(`LetzAI edit: ${await readError(submit)}`);
        let job = await submit.json();
        if (!job.id) throw new Error("LetzAI edit answered without id: " + JSON.stringify(job).slice(0, 200));
        const t0 = Date.now();
        while (!["ready", "saved", "failed", "interrupted"].includes(job.status)) {
            if (Date.now() - t0 > 15 * 60 * 1000) throw new Error("LetzAI: timed out after 15 minutes");
            await sleep(2000);
            const r = await ctx.fetch(`${BASE}/image-edits/${encodeURIComponent(job.id)}`, { headers: { Authorization: headers.Authorization } });
            if (!r.ok) throw new Error(`LetzAI poll: ${await readError(r)}`);
            job = await r.json();
        }
        if (job.status !== "ready" && job.status !== "saved") throw new Error("LetzAI: " + (job.progressMessage || job.status));
        const versions = job.imageVersions || (job.image && job.image.imageVersions) || {};
        const url = versions.original || versions["1920x1920"] || Object.values(versions)[0];
        if (!url) throw new Error("LetzAI: no imageVersions in the result (" + JSON.stringify(job).slice(0, 200) + ")");
        const file = await fetchImage(url, ctx.fetch);
        return { bytes: file.bytes, mime: file.mime, seed: req.seed, info: { mode: body.mode, id: job.id } };
    },
};
