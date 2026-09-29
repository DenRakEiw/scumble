// Black Forest Labs direct API (api.bfl.ai). POST /v1/<endpoint> -> { id, polling_url },
// poll until status "Ready", result.sample is a short-lived URL. Header x-key.
//
//   fill: /v1/flux-pro-1.0-fill    { image, mask (base64, white = repaint), prompt, steps, guidance, seed }
//   edit: /v1/flux-2-pro | flux-2-flex | flux-2-max | flux-2-klein-9b | flux-kontext-pro
//         { prompt, input_image, input_image_2.., width, height, seed }
//         klein takes 4 pictures, pro / flex / max 8 (the crop included; docs.bfl.ai, read 2026-09-29): a run with
//         more is refused before sending, never cut short
//   text: the same flux-2 endpoints without an image { prompt, width, height, seed }; with reference layers (Generate
//         new, 26f) they go as input_image, input_image_2 .. in order, the crop's slot being a reference's (klein 4,
//         pro / flex / max 8); the fill endpoint makes a new image from the prompt alone
// layout(req) and textLayout(req) declare where each picture goes (docs/PLAN_REFS.md C3).
"use strict";

const { b64, fetchImage, readError, sleep, num } = require("./util");
const { layoutOf, refRoles, countOf } = require("./refs");

const BASE = "https://api.bfl.ai";
const PASS = new Set(["steps", "guidance", "safety_tolerance", "output_format", "prompt_upsampling", "aspect_ratio"]);   // "endpoint" picks the model, "random_seed" is the app's

/** The endpoint a request goes to: the `endpoint` setting, else the model, else the fill endpoint. */
function endpointOf(req) {
    return String((req.params && req.params.endpoint) || req.model || "flux-pro-1.0-fill").replace(/^\/+|\/+$/g, "").replace(/^v1\//, "");
}

/** How many pictures an edit endpoint takes, the crop included (input_image .. input_image_N); null where not known. */
function maxOf(endpoint) {
    if (/^flux-2-klein(-|$)/.test(endpoint)) return 4;
    if (/^flux-2-(pro|flex|max)(-|$)/.test(endpoint)) return 8;
    return null;
}

function bodyFor(req) {
    const p = req.params;
    const body = { prompt: req.prompt || "", output_format: "png" };
    if (req.seed != null && !p.random_seed) body.seed = req.seed >>> 0;
    if (req.kind === "text") {
        // no crop: without references the flux-2 endpoints generate from the prompt alone; reference layers go as the
        // numbered inputs (index.js refuses a run past the cap first; this keeps a direct call from sending one)
        const given = req.references || [];
        if (given.length) {
            const lay = textLayout(req), n = countOf(lay);
            if (lay.max != null && n > lay.max) throw new Error(`BFL ${endpointOf(req)} takes at most ${lay.max} reference picture${lay.max === 1 ? "" : "s"} for a new image; this run has ${n}: hide reference layers.`);
            for (const pic of lay.pictures) body[pic.field] = b64(given[pic.ref]);
        }
        body.width = req.width; body.height = req.height;
    } else if (req.kind === "edit") {
        // index.js refuses a run past the cap first (refs.checkPictures); this keeps a direct call from sending one
        const lay = layout(req), n = countOf(lay);
        if (lay.max != null && n > lay.max) throw new Error(`BFL ${endpointOf(req)} takes at most ${lay.max} pictures; this run has ${n}: hide reference layers or turn Original off.`);
        body.input_image = b64(req.image);
        req.references.forEach((r, i) => { body[`input_image_${i + 2}`] = b64(r); });
        body.width = req.width; body.height = req.height;
    } else {
        body.image = b64(req.image);
        if (req.mask) body.mask = b64(req.mask);
    }
    for (const [k, v] of Object.entries(p)) if (PASS.has(k) && v !== "" && v != null) body[k] = v;
    return body;
}

/** Where bodyFor puts each picture: an edit numbers input_image, input_image_2 .., the fill endpoint takes crop and mask. */
function layout(req) {
    if (req.kind === "edit") {
        return layoutOf({ seq: [["crop", "input_image"], ...refRoles(req).map(([role, i]) => [role, `input_image_${i + 2}`, i])], max: maxOf(endpointOf(req)) });
    }
    return layoutOf({ seq: [["crop", "image"]], own: req.mask ? [["mask", "mask"]] : [], drops: "FLUX.1 Fill takes no reference images" });
}

/**
 * Where bodyFor puts the references of a text run: reference 1 in input_image, reference k in input_image_k, as many
 * as the endpoint takes pictures on an edit (the crop's slot is a reference's here). An endpoint with no known picture
 * inputs (the fill endpoint, the text shape of FLUX.1 Fill) makes the image from the prompt alone.
 */
function textLayout(req) {
    const endpoint = endpointOf(req), max = maxOf(endpoint);
    if (max == null) return layoutOf({ drops: /fill/.test(endpoint) ? "FLUX.1 Fill takes no reference images" : "this endpoint takes no reference images for a new image" });
    return layoutOf({ seq: refRoles(req).map(([role, i]) => [role, i ? `input_image_${i + 1}` : "input_image", i]), max });
}

module.exports = {
    label: "Black Forest Labs",
    keyUrl: "https://dashboard.bfl.ai/",
    keyHint: "API key from dashboard.bfl.ai",
    generate(req, ctx) {
        return this.edit(req, ctx);   // bodyFor() leaves the image out for kind "text" (the references alone go)
    },
    layout,
    textLayout,
    async edit(req, ctx) {
        const endpoint = endpointOf(req);
        const headers = { "x-key": ctx.key, "Content-Type": "application/json", accept: "application/json" };
        const submit = await ctx.fetch(`${BASE}/v1/${endpoint}`, { method: "POST", headers, body: JSON.stringify(bodyFor(req)) });
        if (!submit.ok) throw new Error(`BFL ${endpoint}: ${await readError(submit)}`);
        const job = await submit.json();
        const pollUrl = job.polling_url || `${BASE}/v1/get_result?id=${encodeURIComponent(job.id)}`;
        const t0 = Date.now();
        for (;;) {
            if (Date.now() - t0 > 15 * 60 * 1000) throw new Error("BFL: timed out after 15 minutes");
            await sleep(1000);
            const r = await ctx.fetch(pollUrl, { headers: { "x-key": ctx.key, accept: "application/json" } });
            if (!r.ok) throw new Error(`BFL poll: ${await readError(r)}`);
            const s = await r.json();
            const status = s.status || "";
            if (status === "Ready") {
                const sample = s.result && s.result.sample;
                if (!sample) throw new Error("BFL: result without sample");
                const file = await fetchImage(sample, ctx.fetch);
                return { bytes: file.bytes, mime: file.mime, seed: num(s.result.seed, req.seed), info: { endpoint } };
            }
            if (/Moderated|Error|not found/i.test(status)) throw new Error("BFL: " + status + (s.details ? " " + JSON.stringify(s.details).slice(0, 200) : ""));
        }
    },
};
