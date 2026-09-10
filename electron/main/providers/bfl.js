// Black Forest Labs direct API (api.bfl.ai). POST /v1/<endpoint> -> { id, polling_url },
// poll until status "Ready", result.sample is a short-lived URL. Header x-key.
//
//   fill: /v1/flux-pro-1.0-fill    { image, mask (base64, white = repaint), prompt, steps, guidance, seed }
//   edit: /v1/flux-2-pro | flux-2-flex | flux-2-max | flux-2-klein-9b | flux-kontext-pro
//         { prompt, input_image, input_image_2.., width, height, seed }
"use strict";

const { b64, fetchImage, readError, sleep, num } = require("./util");

const BASE = "https://api.bfl.ai";
const PASS = new Set(["steps", "guidance", "safety_tolerance", "output_format", "prompt_upsampling", "aspect_ratio"]);   // "endpoint" picks the model, "random_seed" is the app's

function bodyFor(req) {
    const p = req.params;
    const body = { prompt: req.prompt || "", output_format: "png" };
    if (req.seed != null && !p.random_seed) body.seed = req.seed >>> 0;
    if (req.kind === "text") {
        // no input_image: the flux-2 endpoints then generate from the prompt alone
        body.width = req.width; body.height = req.height;
    } else if (req.kind === "edit") {
        body.input_image = b64(req.image);
        req.references.slice(0, 7).forEach((r, i) => { body[`input_image_${i + 2}`] = b64(r); });
        body.width = req.width; body.height = req.height;
    } else {
        body.image = b64(req.image);
        if (req.mask) body.mask = b64(req.mask);
    }
    for (const [k, v] of Object.entries(p)) if (PASS.has(k) && v !== "" && v != null) body[k] = v;
    return body;
}

module.exports = {
    label: "Black Forest Labs",
    keyUrl: "https://dashboard.bfl.ai/",
    keyHint: "API key from dashboard.bfl.ai",
    generate(req, ctx) {
        return this.edit(req, ctx);   // bodyFor() leaves the image out for kind "text"
    },
    async edit(req, ctx) {
        const endpoint = String(req.params.endpoint || req.model || "flux-pro-1.0-fill").replace(/^\/+|\/+$/g, "").replace(/^v1\//, "");
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
