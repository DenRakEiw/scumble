// Google Gemini image models through generateContent: parts = [text, crop, (mask), refs],
// generationConfig.responseModalities = ["IMAGE"], the answer's inlineData is the image.
// There is no mask input; the mask goes along as a second image and the prompt says what
// it means. The stitch keeps only the selection anyway (paste = selection), so a model
// that repaints a little outside the mask does no harm.
// layout(req) declares where each picture goes (docs/PLAN_REFS.md C3); the text part is
// refs.instruction, and with more than one picture a label part ("Image 2:") goes before
// each, numbered as the text and the resolved markers name them. `options.max_images` is
// the variant's cap (crop, mask picture, Original and references).
"use strict";

const { b64, readError } = require("./util");
const { layoutOf, refRoles, countOf, instruction, labelParts } = require("./refs");

const BASE = "https://generativelanguage.googleapis.com/v1beta/models/";

module.exports = {
    label: "Google Gemini",
    keyUrl: "https://aistudio.google.com/apikey",
    keyHint: "API key from Google AI Studio",
    generate(req, ctx) {
        return this.edit(req, ctx);   // edit() leaves every image part out for kind "text"
    },
    // edit() below: part 0 is the text, then the crop, the mask (a fill), the Original and the references; with more
    // than one picture each has its label part before it, so picture n sits at part 2n, else the one picture at part 1
    layout(req) {
        const o = req.options || {};
        const first = req.mask && req.kind !== "edit" ? [["crop"], ["mask"]] : [["crop"]];
        const seq = [...first, ...refRoles(req).map(([role, i]) => [role, i])];
        const at = (k) => `contents[0].parts[${seq.length > 1 ? 2 * (k + 1) : 1}]`;
        return layoutOf({ seq: seq.map(([role, i], k) => [role, at(k), i]), max: +o.max_images > 0 ? +o.max_images : null });
    },
    async edit(req, ctx) {
        const p = req.params;
        const model = String(p.model || req.model || "gemini-3.1-flash-lite-image");
        const parts = [];
        if (req.kind === "text") {
            // from the prompt alone: no image part at all, the shape comes from imageConfig
            parts.push({ text: req.prompt || "" });
        } else {
            const lay = module.exports.layout(req);
            // index.js refuses a run past the cap before this; the check keeps a direct call from sending one
            if (lay.max != null && countOf(lay) > lay.max) throw new Error(`Gemini ${model} takes at most ${lay.max} picture${lay.max === 1 ? "" : "s"}; this run has ${countOf(lay)}: hide reference layers or turn Original off.`);
            parts.push({ text: instruction(req, lay, req.prompt) });
            const labels = labelParts(lay, req.refName);
            const bytesOf = (pic) => (pic.role === "crop" ? req.image : pic.role === "mask" ? req.mask : req.references[pic.ref]);
            lay.pictures.filter((pic) => pic.n != null).sort((a, b) => a.n - b.n).forEach((pic, k) => {
                if (labels.length) parts.push(labels[k]);
                parts.push({ inline_data: { mime_type: "image/png", data: b64(bytesOf(pic)) } });
            });
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
