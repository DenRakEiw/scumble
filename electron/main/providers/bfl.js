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
//   FLUX 3: an endpoint the recipe marks `options.schema: "flux3"` (or one named flux-3..) takes its own body, built by
//         flux3.js: { prompt, images: [..], aspect_ratio, resolution, safety_tolerance, grounding }, the same submit
//         and poll; the endpoint path is the recipe's model (recipes/flux3.json), the host flux3.js's FLUX3_BASE
// layout(req) and textLayout(req) declare where each picture goes (docs/PLAN_REFS.md C3).
"use strict";

const { b64, fetchImage, readError, sleep, num } = require("./util");
const { layoutOf, refRoles, countOf } = require("./refs");
const flux3 = require("./flux3");

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

/** The host an endpoint is served from: FLUX 3's own constant, else the BFL API. */
function baseOf(req, endpoint) {
    return flux3.isFlux3(req, endpoint) ? flux3.FLUX3_BASE : BASE;
}

/**
 * The URL to poll: the submit's polling_url where it is an https URL on a bfl.ai host (BFL answers with a regional
 * host there), else get_result on the host the job went to. The key goes with every poll, so never to another host.
 */
function pollUrlOf(job, base) {
    try {
        const u = new URL(String(job.polling_url || ""));
        if (u.protocol === "https:" && (u.hostname === "bfl.ai" || u.hostname.endsWith(".bfl.ai"))) return u.href;
    } catch (_) { /* no URL: get_result below */ }
    return `${base}/v1/get_result?id=${encodeURIComponent(job.id)}`;
}

async function bodyFor(req, ctx) {
    const p = req.params;
    if (flux3.isFlux3(req, endpointOf(req))) return flux3.body(req, endpointOf(req), ctx);
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
    if (flux3.isFlux3(req, endpointOf(req))) return flux3.layout(req);
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
    const endpoint = endpointOf(req);
    if (flux3.isFlux3(req, endpoint)) return flux3.textLayout(req);
    const max = maxOf(endpoint);
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
        const base = baseOf(req, endpoint);
        const isF3 = flux3.isFlux3(req, endpoint);
        const submit = await ctx.fetch(`${base}/v1/${endpoint}`, { method: "POST", headers, body: JSON.stringify(await bodyFor(req, ctx)) });
        if (!submit.ok) throw new Error(`BFL ${endpoint}: ${await readError(submit)}`);
        const job = await submit.json();
        const pollUrl = pollUrlOf(job, base);
        const t0 = Date.now();
        let misses = 0;
        for (;;) {
            if (Date.now() - t0 > 15 * 60 * 1000) throw new Error("BFL: timed out after 15 minutes");
            await sleep(1000);
            // the job is submitted and paid for: a dropped connection, a busy or broken gateway (429, 5xx) or a page that
            // is no JSON is retried a few times before the run gives up
            const retry = async (why) => {
                if (++misses > 5) throw new Error(`BFL poll: ${why}`);
                await sleep(1000 * misses);
            };
            let r;
            try {
                r = await ctx.fetch(pollUrl, { headers: { "x-key": ctx.key, accept: "application/json" } });
            } catch (e) {
                await retry(String((e && e.message) || e));
                continue;
            }
            let s = null;
            const text = await r.text().catch(() => "");
            try { s = JSON.parse(text); } catch (_) { s = null; }
            if (!s || typeof s !== "object" || !s.status) {
                // a failed task answers with a status body (HTTP 422, { status: "Error", details }), read below
                if (!r.ok && !(r.status === 429 || r.status >= 500)) throw new Error(`BFL poll: HTTP ${r.status} ${text.slice(0, 300) || r.statusText || ""}`.trim());
                await retry(`HTTP ${r.status} ${text.slice(0, 300) || r.statusText || ""}`.trim());
                continue;
            }
            misses = 0;
            const status = s.status || "";
            if (status === "Ready") {
                const sample = s.result && s.result.sample;
                if (!sample) throw new Error("BFL: result without sample");
                let file = null;
                for (let tries = 0; !file; tries++) {
                    try { file = await fetchImage(sample, ctx.fetch); } catch (e) { if (tries >= 2) throw e; await sleep(1500); }
                }
                // the submit's cost (credits) and megapixels, the settled cost where the poll carries one; FLUX 3 takes
                // no seed, so it reports none unless the answer names one, and keeps the prompt as the model expanded it
                const given = (v) => (v == null || v === "" ? undefined : num(v, undefined));
                const info = { endpoint };
                const cost = given(s.cost) ?? given(job.cost);
                if (cost != null) info.cost = cost;
                if (given(job.input_mp) != null) info.input_mp = given(job.input_mp);
                if (given(job.output_mp) != null) info.output_mp = given(job.output_mp);
                if (isF3) {
                    Object.assign(info, flux3.infoOf(req));
                    if (typeof s.result.prompt === "string" && s.result.prompt) info.expanded_prompt = s.result.prompt.slice(0, 2000);
                    if (s.result.duration != null) info.duration = s.result.duration;
                }
                const seed = isF3 ? given(s.result.seed) : num(s.result.seed, req.seed);
                return { bytes: file.bytes, mime: file.mime, seed, info };
            }
            if (/Moderated|Error|not found/i.test(status)) {
                const why = /Request Moderated/i.test(status) ? " (the prompt or an input picture was blocked; the same request fails again)"
                    : /Content Moderated/i.test(status) ? " (the result was blocked)" : "";
                throw new Error("BFL: " + status + why + (s.details ? " " + JSON.stringify(s.details).slice(0, 200) : ""));
            }
        }
    },
};
