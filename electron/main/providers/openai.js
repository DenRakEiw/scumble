// OpenAI images: POST /v1/images/edits (multipart) and POST /v1/images/generations (JSON).
// image[] = crop plus references, mask = PNG whose transparent pixels mark the area to
// repaint (same size as the crop), the answer carries b64_json.
// layout(req) declares where each picture goes (docs/PLAN_REFS.md C3).
// Generate new (kind "text") posts to /generations; with reference layers it takes /edits instead, image[] the
// references alone (no crop, no mask) at the asked size (textLayout, 26f).
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

const { readError, closestSize, fitPixels } = require("./util");
const { layoutOf, refRoles, countOf } = require("./refs");

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
    const [cw, ch] = fitPixels(w, h, r);
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

/**
 * POST /v1/images/edits: the pictures in image[] in order ([bytes, file name]), the mask in a field of its own when
 * given. Returns the answer's JSON.
 */
async function postEdits(ctx, model, prompt, pictures, mask, size, extra) {
    const fd = new FormData();
    fd.append("model", model);
    fd.append("prompt", prompt || "");
    for (const [bytes, name] of pictures) fd.append("image[]", new Blob([bytes], { type: "image/png" }), name);
    if (mask) fd.append("mask", new Blob([mask], { type: "image/png" }), "mask.png");
    fd.append("size", size);
    for (const [k, v] of Object.entries(extra)) fd.append(k, String(v));
    fd.append("n", "1");
    const r = await ctx.fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { Authorization: "Bearer " + ctx.key }, body: fd });
    if (!r.ok) throw new Error(`OpenAI ${model}: ${await readError(r)}`);
    return r.json();
}

/**
 * Where a text run's references go (Generate new, 26f): image[] of /edits, numbered from 1 (no crop, no mask), up to
 * options.max_images, the edit run's cap (the crop's slot becomes a reference slot). Every GPT Image model takes them.
 */
function textLayout(req) {
    const o = req.options || {};
    return layoutOf({ seq: refRoles(req).map(([role, i]) => [role, `image[][${i}]`, i]), max: +o.max_images > 0 ? +o.max_images : null });
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
    // edit() below: image[] holds the crop, then the references; the mask goes in a field of its own.
    // `options.max_images` is the variant's cap on image[] (the crop included; the mask field is no picture)
    layout(req) {
        const o = req.options || {};
        const own = pickMask(req) && req.kind !== "edit" ? [["mask", "mask"]] : [];
        return layoutOf({ seq: [["crop", "image[][0]"], ...refRoles(req).map(([role, i]) => [role, `image[][${i + 1}]`, i])], own, max: +o.max_images > 0 ? +o.max_images : null });
    },
    async edit(req, ctx) {
        const p = req.params;
        const model = String(p.model || req.model || "gpt-image-1");
        // index.js refuses a run past the cap first (refs.checkPictures); this keeps a direct call from sending one
        const lay = module.exports.layout(req), n = countOf(lay);
        if (lay.max != null && n > lay.max) throw new Error(`OpenAI ${model} takes at most ${lay.max} picture${lay.max === 1 ? "" : "s"}; this run has ${n}: hide reference layers or turn Original off.`);
        const extra = common(p, model);
        const size = p.size && p.size !== "auto" ? String(p.size) : sizeFor(model, req.width, req.height);
        const pictures = [[req.image, "crop.png"], ...req.references.map((r, i) => [r, `reference_${i + 1}.png`])];
        const mask = pickMask(req);
        const json = await postEdits(ctx, model, req.prompt, pictures, mask && req.kind !== "edit" ? mask : null, size, extra);
        const out = unpack(json, model, size, extra);
        return { ...out, seed: undefined };
    },

    textLayout,

    /**
     * From the prompt alone: POST /v1/images/generations, no image and no mask. With reference layers (26f) the same
     * run goes to /edits with the references alone in image[], no mask, at the asked size.
     */
    async generate(req, ctx) {
        const p = req.params;
        const model = String(p.model || req.model || "gpt-image-2");
        const extra = common(p, model);
        const size = p.size && p.size !== "auto" ? String(p.size) : sizeFor(model, req.width, req.height);
        if ((req.references || []).length) {
            // index.js refuses a run past the cap first (refs.checkPictures); this keeps a direct call from sending one
            const lay = textLayout(req), n = countOf(lay);
            if (lay.max != null && n > lay.max) throw new Error(`OpenAI ${model} takes at most ${lay.max} reference picture${lay.max === 1 ? "" : "s"} for a new image; this run has ${n}: hide reference layers.`);
            const json = await postEdits(ctx, model, req.prompt, req.references.map((r, i) => [r, `reference_${i + 1}.png`]), null, size, extra);
            return { ...unpack(json, model, size, extra), seed: undefined };
        }
        const body = { model, prompt: req.prompt || "", size, n: 1, ...extra };
        const r = await ctx.fetch("https://api.openai.com/v1/images/generations", {
            method: "POST", headers: { Authorization: "Bearer " + ctx.key, "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`OpenAI ${model}: ${await readError(r)}`);
        const out = unpack(await r.json(), model, size, extra);
        return { ...out, seed: undefined };
    },

    // exported for tools/transparent_test.py and tools/size_test.py
    _sizeFor: sizeFor,
    _common: common,
};
