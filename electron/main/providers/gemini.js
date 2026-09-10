// Google Gemini image models through generateContent: parts = [text, crop, (mask), refs],
// generationConfig.responseModalities = ["IMAGE"], the answer's inlineData is the image.
// There is no mask input; the mask goes along as a second image and the prompt says what
// it means. The stitch keeps only the selection anyway (paste = selection), so a model
// that repaints a little outside the mask does no harm.
"use strict";

const { b64, readError } = require("./util");

const BASE = "https://generativelanguage.googleapis.com/v1beta/models/";

module.exports = {
    label: "Google Gemini",
    keyUrl: "https://aistudio.google.com/apikey",
    keyHint: "API key from Google AI Studio",
    generate(req, ctx) {
        return this.edit(req, ctx);   // edit() leaves every image part out for kind "text"
    },
    async edit(req, ctx) {
        const p = req.params;
        const model = String(p.model || req.model || "gemini-3.1-flash-lite-image");
        const parts = [];
        let text = req.prompt || "";
        if (req.kind === "text") {
            // from the prompt alone: no image part at all, the shape comes from imageConfig
            parts.push({ text });
        } else if (req.mask && req.kind !== "edit") {
            text = `Edit the first image. The second image is a mask: change only the white area of the mask, keep everything else exactly as it is, and keep the image size and framing. ${text}`;
        } else {
            text = `Edit this image and keep its size and framing. ${text}`;
        }
        if (req.kind !== "text") {
            if (req.references.length) text += ` The remaining image${req.references.length > 1 ? "s are" : " is"} reference material.`;
            parts.push({ text });
            parts.push({ inline_data: { mime_type: "image/png", data: b64(req.image) } });
            if (req.mask && req.kind !== "edit") parts.push({ inline_data: { mime_type: "image/png", data: b64(req.mask) } });
            for (const r of req.references) parts.push({ inline_data: { mime_type: "image/png", data: b64(r) } });
        }
        const generationConfig = { responseModalities: ["IMAGE"] };
        const imageConfig = {};
        if (req.kind === "text" && req.aspect && !p.aspect_ratio) imageConfig.aspectRatio = req.aspect;
        if (req.kind === "text" && !p.image_size) {
            // the model takes a class, not pixels: pick the one the request is closest to
            const long = Math.max(req.width || 0, req.height || 0);
            imageConfig.imageSize = long >= 3072 ? "4K" : long >= 1792 ? "2K" : "1K";
        }
        if (p.aspect_ratio && p.aspect_ratio !== "auto") imageConfig.aspectRatio = p.aspect_ratio;
        if (p.image_size && p.image_size !== "auto") imageConfig.imageSize = p.image_size;
        if (Object.keys(imageConfig).length) generationConfig.imageConfig = imageConfig;
        const body = { contents: [{ role: "user", parts }], generationConfig };
        const r = await ctx.fetch(`${BASE}${encodeURIComponent(model)}:generateContent`, {
            method: "POST", headers: { "x-goog-api-key": ctx.key, "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`Gemini ${model}: ${await readError(r)}`);
        const out = await r.json();
        const cand = out.candidates && out.candidates[0];
        const partsOut = (cand && cand.content && cand.content.parts) || [];
        const img = partsOut.find((x) => x.inlineData && x.inlineData.data);
        if (!img) {
            const why = (cand && cand.finishReason) || (out.promptFeedback && out.promptFeedback.blockReason) || partsOut.map((x) => x.text).filter(Boolean).join(" ").slice(0, 200) || "no image part";
            throw new Error("Gemini: " + why);
        }
        return { bytes: Buffer.from(img.inlineData.data, "base64"), mime: img.inlineData.mimeType || "image/png", seed: req.seed, info: { model } };
    },
};
