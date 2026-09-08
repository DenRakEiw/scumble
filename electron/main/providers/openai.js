// OpenAI images: POST /v1/images/edits (multipart). image[] = crop plus references,
// mask = PNG whose transparent pixels mark the area to repaint (same size as the crop),
// prompt, model (gpt-image-1 / gpt-image-1.5 / gpt-image-1-mini / gpt-image-2), size,
// quality, input_fidelity. The answer carries b64_json.
"use strict";

const { readError, closestSize } = require("./util");

const STANDARD_SIZES = ["1024x1024", "1536x1024", "1024x1536"];

/** Mask for OpenAI: alpha 0 where the editor's mask is white. Done here in Node without
 * an image library: the renderer already sends the mask as RGBA PNG "openai" variant
 * (req.maskAlpha) when the provider asks for it; fall back to no mask otherwise. */
function pickMask(req) {
    return req.maskAlpha || null;
}

module.exports = {
    label: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-... from platform.openai.com",
    wantsAlphaMask: true,
    async edit(req, ctx) {
        const p = req.params;
        const model = String(p.model || req.model || "gpt-image-1");
        const fd = new FormData();
        fd.append("model", model);
        fd.append("prompt", req.prompt || "");
        fd.append("image[]", new Blob([req.image], { type: "image/png" }), "crop.png");
        req.references.forEach((r, i) => fd.append("image[]", new Blob([r], { type: "image/png" }), `reference_${i + 1}.png`));
        const mask = pickMask(req);
        if (mask && req.kind !== "edit") fd.append("mask", new Blob([mask], { type: "image/png" }), "mask.png");
        let size = p.size || "auto";
        if (size === "auto") {
            // gpt-image-2 takes any size with both sides divisible by 16; the others need the three standard shapes
            size = /gpt-image-2/.test(model) && req.width % 16 === 0 && req.height % 16 === 0 ? `${req.width}x${req.height}` : closestSize(req.width, req.height, STANDARD_SIZES);
        }
        fd.append("size", size);
        if (p.quality && p.quality !== "auto") fd.append("quality", p.quality);
        if (p.input_fidelity && !/mini/.test(model)) fd.append("input_fidelity", p.input_fidelity);
        fd.append("output_format", "png");
        fd.append("n", "1");
        const r = await ctx.fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { Authorization: "Bearer " + ctx.key }, body: fd });
        if (!r.ok) throw new Error(`OpenAI ${model}: ${await readError(r)}`);
        const out = await r.json();
        const item = out.data && out.data[0];
        if (!item || !item.b64_json) throw new Error("OpenAI: no b64_json in the answer");
        return { bytes: Buffer.from(item.b64_json, "base64"), mime: "image/png", seed: req.seed, info: { model, size, revised_prompt: item.revised_prompt || null } };
    },
};
