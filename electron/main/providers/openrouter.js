// OpenRouter's unified Image API: POST https://openrouter.ai/api/v1/images with { model,
// prompt, input_references: [{ type: "image_url", image_url: { url } }], resolution |
// size, aspect_ratio, quality, output_format, seed }; the answer is { data: [{ b64_json,
// media_type }] }. One key for Google, OpenAI, BFL, ByteDance and Qwen image models
// (GET /api/v1/images/models lists them with their supported parameters).
//
// There is no mask input: like the Gemini adapter, a fill run sends the mask as the second
// reference and the prompt says what it means; the stitch keeps the selection anyway.
"use strict";

const { dataUri, readError } = require("./util");

const URL = "https://openrouter.ai/api/v1/images";
const PASS = new Set(["resolution", "size", "aspect_ratio", "quality", "background", "output_format"]);

function bodyFor(req) {
    const p = req.params;
    let prompt = req.prompt || "";
    const refs = [req.image];
    if (req.mask && req.kind !== "edit") {
        prompt = `Edit the first image. The second image is a mask: change only the white area of the mask, keep everything else exactly as it is, and keep the image size and framing. ${prompt}`;
        refs.push(req.mask);
    } else {
        prompt = `Edit the first image and keep its size and framing. ${prompt}`;
    }
    if (req.references.length) prompt += ` The remaining image${req.references.length > 1 ? "s are" : " is"} reference material.`;
    refs.push(...req.references);
    const body = {
        model: req.model, prompt, n: 1, output_format: "png",
        input_references: refs.map((r) => ({ type: "image_url", image_url: { url: dataUri(r) } })),
    };
    if (req.seed != null && !p.random_seed) body.seed = req.seed >>> 0;
    for (const [k, v] of Object.entries(p)) if (PASS.has(k) && v !== "" && v != null && v !== "auto") body[k] = v;
    return body;
}

module.exports = {
    label: "OpenRouter",
    keyUrl: "https://openrouter.ai/settings/keys",
    keyHint: "sk-or-... from openrouter.ai",
    async edit(req, ctx) {
        const model = String(req.model || "");
        if (!model) throw new Error("OpenRouter recipe has no model id.");
        const r = await ctx.fetch(URL, {
            method: "POST",
            headers: { Authorization: "Bearer " + ctx.key, "Content-Type": "application/json", "HTTP-Referer": "https://github.com/DenRakEiw/scumble", "X-Title": "Scumble" },
            body: JSON.stringify(bodyFor(req)),
        });
        if (!r.ok) throw new Error(`OpenRouter ${model}: ${await readError(r)}`);
        const out = await r.json();
        const item = out.data && out.data[0];
        if (!item || !item.b64_json) throw new Error("OpenRouter: no b64_json in the answer (" + JSON.stringify(out).slice(0, 200) + ")");
        const cost = out.usage && out.usage.cost;
        return { bytes: Buffer.from(item.b64_json, "base64"), mime: item.media_type || "image/png", seed: req.seed, info: { model, cost: cost == null ? null : cost } };
    },
};
