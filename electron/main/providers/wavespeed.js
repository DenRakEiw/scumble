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
//   edit: { images: [crop, references...], prompt }   (nano-banana, gpt-image, seedream, flux-2, qwen)
// A recipe variant may rename the inputs with `fields` ({ image, images, mask }); `options`:
// `aspect_ratios` (the model's presets, the closest to the crop is sent unless the settings
// pick one), `size: "star"` (send the crop size as "W*H", fitted to `max_side`).
//
// Referral: the key link (keyUrl) carries DenRakEiw's WaveSpeed referral code.
"use strict";

const { fetchImage, readError, sleep, num } = require("./util");

const BASE = "https://api.wavespeed.ai/api/v3/";
const POLL_MS = 2000;

async function upload(ctx, bytes, name) {
    const auth = { Authorization: "Bearer " + ctx.key };
    // two-step: ticket, then PUT the bytes to the presigned URL (no API key there)
    const ticket = await ctx.fetch(BASE + "media/uploads", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ filename: name, size: bytes.length, content_type: "image/png" }) });
    if (ticket.ok) {
        const t = ((await ticket.json()) || {}).data || {};
        const up = t.upload || {};
        if (t.download_url && up.url) {
            const put = await ctx.fetch(up.url, { method: up.method || "PUT", headers: up.headers || { "Content-Type": "image/png" }, body: bytes });
            if (!put.ok) throw new Error(`WaveSpeed upload (${name}): ${await readError(put)}`);
            return t.download_url;
        }
        ctx.log("upload ticket without download_url / upload.url, using the binary upload:", JSON.stringify(t).slice(0, 200));
    } else {
        ctx.log("upload ticket answered", ticket.status, "- using the binary upload");
    }
    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type: "image/png" }), name);
    const r = await ctx.fetch(BASE + "media/upload/binary", { method: "POST", headers: auth, body: fd });
    if (!r.ok) throw new Error(`WaveSpeed upload (${name}): ${await readError(r)}`);
    const d = ((await r.json()) || {}).data || {};
    if (!d.download_url) throw new Error("WaveSpeed upload answered without download_url: " + JSON.stringify(d).slice(0, 200));
    return d.download_url;
}

/** The preset ("W:H") whose aspect is closest to w:h. */
function closestAspect(w, h, presets) {
    const want = Math.log(w / h);
    let best = presets[0], bestD = Infinity;
    for (const p of presets) {
        const [a, b] = String(p).split(":").map(Number);
        if (!a || !b) continue;
        const d = Math.abs(Math.log(a / b) - want);
        if (d < bestD) { best = p; bestD = d; }
    }
    return best;
}

/** "W*H" for the crop, fitted into max_side and a multiple of 16 (the fill models' size input). */
function starSize(w, h, maxSide) {
    const k = Math.min(1, maxSide / Math.max(w, h));
    const r = (v) => Math.max(256, Math.round(v * k / 16) * 16);
    return `${r(w)}*${r(h)}`;
}

async function inputFor(req, ctx) {
    const p = req.params, f = req.fields || {}, o = req.options || {};
    const stamp = Date.now().toString(36);
    const input = { prompt: req.prompt || "" };
    if (req.seed != null && !p.random_seed) input.seed = req.seed >>> 0;
    if (req.kind === "edit" || f.images) {
        const urls = [await upload(ctx, req.image, `scumble-${stamp}-crop.png`)];
        for (let i = 0; i < req.references.length; i++) urls.push(await upload(ctx, req.references[i], `scumble-${stamp}-ref${i + 1}.png`));
        input[f.images || "images"] = urls;
    } else {
        input[f.image || "image"] = await upload(ctx, req.image, `scumble-${stamp}-crop.png`);
        if (req.mask) input[f.mask || "mask_image"] = await upload(ctx, req.mask, `scumble-${stamp}-mask.png`);
    }
    if (o.size === "star") input.size = starSize(req.width, req.height, num(o.max_side, 1536));
    // recipe settings are passed through by name; the recipe decides which exist for the model
    for (const [k, v] of Object.entries(p)) {
        if (k === "random_seed" || k === "model" || v === "" || v == null || v === "auto") continue;
        input[k] = v;
    }
    if (Array.isArray(o.aspect_ratios) && o.aspect_ratios.length && input.aspect_ratio == null) input.aspect_ratio = closestAspect(req.width, req.height, o.aspect_ratios);
    if (req.negative && input.negative_prompt === undefined && req.kind !== "edit" && o.negative !== false) input.negative_prompt = req.negative;
    if (input.output_format === undefined) input.output_format = "png";
    return input;
}

module.exports = {
    label: "WaveSpeedAI",
    keyUrl: "https://wavespeed.ai/?ref=dennisi6",
    keyHint: "API key from wavespeed.ai > Access Keys (the link carries Scumble's referral code)",
    async edit(req, ctx) {
        const model = String(req.model || "").replace(/^\/+|\/+$/g, "");
        if (!model) throw new Error("WaveSpeed recipe has no model id.");
        const headers = { Authorization: "Bearer " + ctx.key, "Content-Type": "application/json" };
        const input = await inputFor(req, ctx);
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
        return { bytes: file.bytes, mime: file.mime, seed: num(input.seed, req.seed), info: { model, ms: data.timings && data.timings.inference } };
    },
};
