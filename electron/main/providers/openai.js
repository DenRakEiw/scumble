// OpenAI images: POST /v1/images/edits (multipart) and POST /v1/images/generations (JSON).
// image[] = crop plus references, mask = PNG whose transparent pixels mark the area to
// repaint (same size as the crop), the answer carries b64_json.
//
// The parameters follow developers.openai.com/api/docs/guides/image-prompting and the
// /v1/images reference, both read 2026-09-11:
//   model              gpt-image-2.5-flare / -sunburst, gpt-image-2, gpt-image-1.5, gpt-image-1
//   quality            auto | low | medium | high, plus xhigh and max on 2.5
//   size               auto or WIDTHxHEIGHT (see sizeRules below)
//   background         auto | opaque | transparent   -> a cut-out with a real alpha channel
//   output_format      png | jpeg | webp             -> png or webp for transparency
//   output_compression 0..100, jpeg and webp only
//   moderation         auto | low
//   input_fidelity     high | low, only on 1.5 and 1; gpt-image-2 is always high, omit it
// `stream` / `partial_images` are not used: the app wants the finished image, not previews.
"use strict";

const { readError, closestSize } = require("./util");

const STANDARD_SIZES = ["1024x1024", "1536x1024", "1024x1536"];

const MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

/**
 * What a model takes for `size`. GPT Image 2.5 documents a free size with both edges a
 * multiple of 16, at most 3840 per edge, a total of 655,360 to 8,294,400 pixels and a
 * ratio no steeper than 3:1 (above 3,686,400 pixels the docs call the result experimental).
 * GPT Image 2 takes a free size in multiples of 16, 1.5 and 1 only the three fixed shapes.
 * Test 2.5 first: "gpt-image-2" is a prefix of "gpt-image-2.5-flare".
 */
function sizeRules(model) {
    if (/gpt-image-2\.5/.test(model)) return { custom: true, step: 16, max: 3840, minPixels: 655360, maxPixels: 8294400, maxRatio: 3 };
    if (/gpt-image-2/.test(model)) return { custom: true, step: 16, max: 2048, minPixels: 0, maxPixels: 8294400, maxRatio: 0 };
    return { custom: false };
}

/** The size string for a crop of w x h, held inside the model's rules. */
function sizeFor(model, w, h) {
    const r = sizeRules(model);
    if (!r.custom) return closestSize(w, h, STANDARD_SIZES);
    let cw = Math.max(1, Math.round(w)), ch = Math.max(1, Math.round(h));
    if (r.maxRatio && Math.max(cw, ch) / Math.min(cw, ch) > r.maxRatio) {
        // a very long crop: keep the short edge and pull the long one back to the ratio
        if (cw > ch) cw = Math.round(ch * r.maxRatio); else ch = Math.round(cw * r.maxRatio);
    }
    const fit = (k) => { cw = Math.max(1, Math.round(cw * k)); ch = Math.max(1, Math.round(ch * k)); };
    if (Math.max(cw, ch) > r.max) fit(r.max / Math.max(cw, ch));
    if (r.maxPixels && cw * ch > r.maxPixels) fit(Math.sqrt(r.maxPixels / (cw * ch)));
    if (r.minPixels && cw * ch < r.minPixels) {
        // too few pixels for the model: grow, but never past an edge or the area ceiling
        const k = Math.min(Math.sqrt(r.minPixels / (cw * ch)), r.max / Math.max(cw, ch));
        fit(k);
    }
    const snap = (v) => Math.max(r.step, Math.min(r.max, Math.round(v / r.step) * r.step));
    cw = snap(cw); ch = snap(ch);
    // rounding can drop back under the minimum: take the next step up on both edges
    while (r.minPixels && cw * ch < r.minPixels && cw + r.step <= r.max && ch + r.step <= r.max) { cw += r.step; ch += r.step; }
    // stepping in whole multiples drifts the ratio, and 3:1 is a hard refusal: widen the
    // short edge rather than cutting the long one, which also keeps the pixel floor met
    if (r.maxRatio) {
        const need = (long) => Math.min(r.max, Math.max(r.step, Math.ceil(long / r.maxRatio / r.step) * r.step));
        if (cw > ch * r.maxRatio) ch = need(cw);
        else if (ch > cw * r.maxRatio) cw = need(ch);
    }
    if (r.maxPixels && cw * ch > r.maxPixels) {
        while (cw * ch > r.maxPixels && cw > r.step && ch > r.step) { cw -= r.step; ch -= r.step; }
    }
    return `${cw}x${ch}`;
}

/**
 * The parameters both endpoints share. `background` is the transparency switch: with
 * "transparent" the model returns an alpha channel, which only PNG and WebP can carry, so
 * a JPEG request is turned into a PNG rather than silently losing the cut-out.
 */
function common(p, model) {
    const out = {};
    const quality = String(p.quality || "auto");
    if (quality && quality !== "auto") out.quality = quality;

    const background = String(p.background || "auto").toLowerCase();
    if (background === "transparent" || background === "opaque") out.background = background;

    let format = String(p.output_format || "png").toLowerCase();
    if (!MIME[format]) format = format === "jpg" ? "jpeg" : "png";
    if (out.background === "transparent" && format === "jpeg") format = "png";
    out.output_format = format;

    const comp = p.output_compression;
    if (format !== "png" && comp != null && comp !== "" && Number.isFinite(+comp)) {
        out.output_compression = Math.max(0, Math.min(100, Math.round(+comp)));
    }

    const moderation = String(p.moderation || "auto").toLowerCase();
    if (moderation === "low") out.moderation = "low";

    // gpt-image-2 processes image inputs at high fidelity and rejects nothing but wastes the
    // field; the docs say to omit it there. 1.5 and 1 take low / high.
    const fidelity = String(p.input_fidelity || "").toLowerCase();
    if ((fidelity === "high" || fidelity === "low") && /^gpt-image-1(\.5)?(-mini)?/.test(model)) out.input_fidelity = fidelity;

    return out;
}

/** Mask for OpenAI: alpha 0 where the editor's mask is white. The renderer sends it as the
 * RGBA PNG "openai" variant (req.maskAlpha) when the provider asks for it. */
function pickMask(req) {
    return req.maskAlpha || null;
}

function unpack(out, model, size, extra) {
    const item = out.data && out.data[0];
    if (!item || !item.b64_json) throw new Error("OpenAI: no b64_json in the answer");
    return {
        bytes: Buffer.from(item.b64_json, "base64"),
        mime: MIME[extra.output_format] || "image/png",
        info: { model, size, background: extra.background || "auto", output_format: extra.output_format, revised_prompt: item.revised_prompt || null },
    };
}

module.exports = {
    label: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-... from platform.openai.com",
    wantsAlphaMask: true,
    async edit(req, ctx) {
        const p = req.params;
        const model = String(p.model || req.model || "gpt-image-1");
        const extra = common(p, model);
        const size = p.size && p.size !== "auto" ? String(p.size) : sizeFor(model, req.width, req.height);
        const fd = new FormData();
        fd.append("model", model);
        fd.append("prompt", req.prompt || "");
        fd.append("image[]", new Blob([req.image], { type: "image/png" }), "crop.png");
        req.references.forEach((r, i) => fd.append("image[]", new Blob([r], { type: "image/png" }), `reference_${i + 1}.png`));
        const mask = pickMask(req);
        if (mask && req.kind !== "edit") fd.append("mask", new Blob([mask], { type: "image/png" }), "mask.png");
        fd.append("size", size);
        for (const [k, v] of Object.entries(extra)) fd.append(k, String(v));
        fd.append("n", "1");
        const r = await ctx.fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { Authorization: "Bearer " + ctx.key }, body: fd });
        if (!r.ok) throw new Error(`OpenAI ${model}: ${await readError(r)}`);
        const out = unpack(await r.json(), model, size, extra);
        return { ...out, seed: req.seed };
    },

    /** From the prompt alone: POST /v1/images/generations, no image and no mask. */
    async generate(req, ctx) {
        const p = req.params;
        const model = String(p.model || req.model || "gpt-image-2");
        const extra = common(p, model);
        const size = p.size && p.size !== "auto" ? String(p.size) : sizeFor(model, req.width, req.height);
        const body = { model, prompt: req.prompt || "", size, n: 1, ...extra };
        const r = await ctx.fetch("https://api.openai.com/v1/images/generations", {
            method: "POST", headers: { Authorization: "Bearer " + ctx.key, "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`OpenAI ${model}: ${await readError(r)}`);
        const out = unpack(await r.json(), model, size, extra);
        return { ...out, seed: req.seed };
    },

    // exported for tools/transparent_test.py and tools/size_test.py
    _sizeFor: sizeFor,
    _common: common,
};
