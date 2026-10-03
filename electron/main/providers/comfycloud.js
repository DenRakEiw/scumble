// Comfy Cloud (cloud.comfy.org): the ComfyUI API with an X-API-Key header, on Comfy's GPUs,
// with the Partner Nodes (OpenAI, Gemini, ByteDance, BFL, Qwen) billed in the account's
// credits. Needs a paid Comfy Cloud plan (the free tier has no API access). Inpaint Canvas is
// not among the custom nodes preinstalled there, so the local recipes cannot run on the
// cloud; this adapter builds a small workflow out of core nodes and one Partner Node instead:
//
//   LoadImage (crop) [+ LoadImage (references)] [+ LoadImage (mask) -> ImageToMask]
//     -> <partner node> -> SaveImage
//
// POST /api/upload/image (multipart image, type input) -> { name, subfolder }; POST /api/prompt
// { prompt, client_id } -> { prompt_id }; GET /api/job/<id>/status until success / error;
// GET /api/jobs/<id> -> outputs -> images [{ filename, subfolder, type }] (Comfy Cloud no longer serves
// /api/history: "This endpoint is not available on Comfy Cloud", measured 2026-10-03); GET /api/view
// answers 302 to a signed URL that must be fetched without the key (redirect: manual).
//
// A recipe variant names the partner node and its model choice; the adapter knows how each
// node takes the crop, the references, the mask, the size and the seed (SHAPES below). The
// dynamic inputs of the nodes (model combos, autogrow image lists) use dotted keys in the API
// prompt: "model": "gpt-image-2", "model.quality": "medium", "model.images.image_1": [id, 0].
// Recipe settings are copied by key, so a setting's key is the full input key.
//
// upscale (kind "upscale", docs/RECIPES.md "Upscale recipes"): the same graph around one of the upscaler
// Partner Nodes (Magnific Precise V2 and Creative, Recraft Crisp and Creative; their inputs read from a
// ComfyUI's /object_info on 2026-09-22). Magnific's nodes take the factor as "2x" .. "16x" and are told not to
// downscale the picture on their own (auto_downscale false: Scumble refuses a picture above the variant's
// limit instead); Recraft's take the picture alone.
//
// layout(req) declares where each picture goes (docs/PLAN_REFS.md C3) and how many pictures the node takes
// (NODE_PICTURES); buildGraph uploads only the pictures the layout wires and refuses a run past that count.
"use strict";

const { readError, sleep, num, closestAspect } = require("./util");
const { layoutOf, refRoles, countOf } = require("./refs");

const BASE = "https://cloud.comfy.org";
const POLL_MS = 2000;

/** Fit w x h into [lo, hi] per side, multiples of `step`. */
function fit(w, h, lo, hi, step) {
    let k = Math.min(1, hi / Math.max(w, h));
    if (Math.min(w, h) * k < lo) k = lo / Math.min(w, h);
    const r = (v) => Math.max(lo, Math.min(hi, Math.round(v * k / step) * step));
    return [r(w), r(h)];
}

const GEMINI_AR = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

// How each partner node is wired. `g` is the graph builder: g.crop / g.refs are [node id, 0]
// image links, g.mask() a MASK link (null without a mask), g.set(key, value) writes an input.
const SHAPES = {
    OpenAIGPTImageNodeV2(g, v) {
        g.set("prompt", v.prompt); g.set("model", v.model); g.set("n", 1); g.set("seed", v.seed);
        g.set("model.size", "auto"); g.set("model.background", "auto"); g.set("model.quality", "medium");
        if (/gpt-image-2/.test(v.model)) {
            // any size in multiples of 16 within OpenAI's limits: keep the crop's size
            const [w, h] = fit(v.width, v.height, 480, 3840, 16);
            if (w * h >= 655360 && w * h <= 8294400 && Math.max(w, h) / Math.min(w, h) <= 3) { g.set("model.size", "Custom"); g.set("model.custom_width", w); g.set("model.custom_height", h); }
        }
        g.images("model.images.image_", [g.crop, ...g.refs]);
        const m = g.mask();
        if (m) g.set("model.mask", m);
    },
    GeminiNanoBanana2V2(g, v) {
        g.set("prompt", v.prompt); g.set("model", v.model); g.set("seed", v.seed); g.set("response_modalities", "IMAGE");
        g.set("model.aspect_ratio", closestAspect(v.width, v.height, GEMINI_AR)); g.set("model.resolution", "1K"); g.set("model.thinking_level", "MINIMAL");
        g.images("model.images.image_", [g.crop, ...g.refs]);
    },
    GeminiImage2Node(g, v) {   // Nano Banana Pro: one image input
        g.set("prompt", v.prompt); g.set("model", v.model); g.set("seed", v.seed); g.set("response_modalities", "IMAGE");
        g.set("aspect_ratio", closestAspect(v.width, v.height, GEMINI_AR)); g.set("resolution", "1K"); g.set("images", g.crop);
    },
    GeminiImageNode(g, v) {    // Nano Banana (2.5 Flash Image)
        g.set("prompt", v.prompt); g.set("model", v.model); g.set("seed", v.seed); g.set("response_modalities", "IMAGE");
        g.set("aspect_ratio", closestAspect(v.width, v.height, GEMINI_AR)); g.set("images", g.crop);
    },
    ByteDanceSeedreamNodeV3(g, v) {
        const pro = /pro/.test(v.model);
        g.set("prompt", v.prompt); g.set("model", v.model); g.set("model.seed", v.seed); g.set("model.watermark", false); g.set("model.thinking", true);
        const [w, h] = fit(v.width, v.height, 1024, pro ? 2496 : 4992, 2);
        g.set("model.size_preset", "Custom"); g.set("model.width", w); g.set("model.height", h);
        if (pro) g.set("model.prompt_optimization", "standard"); else { g.set("model.max_images", 1); g.set("model.fail_on_partial", false); }
        g.images("model.images.image_", [g.crop, ...g.refs]);
    },
    Flux2ImageNode(g, v) {
        g.set("prompt", v.prompt); g.set("model", v.model); g.set("seed", v.seed);
        const [w, h] = fit(v.width, v.height, 256, 2048, 32);
        g.set("model.width", w); g.set("model.height", h);
        g.images("model.images.image_", [g.crop, ...g.refs]);
    },
    FluxProFillNode(g, v) {
        const m = g.mask();
        if (!m) throw new Error("Flux.1 Fill on Comfy Cloud needs a selection mask.");
        g.set("image", g.crop); g.set("mask", m); g.set("prompt", v.prompt); g.set("seed", v.seed);
        g.set("prompt_upsampling", false); g.set("guidance", 60); g.set("steps", 50);
    },
    MagnificImageUpscalerPreciseV2Node(g, v) {
        g.set("image", g.crop); g.set("scale_factor", magnificFactor(v.factor)); g.set("auto_downscale", false);
        g.set("flavor", "photo"); g.set("sharpen", 7); g.set("smart_grain", 7); g.set("ultra_detail", 30);
    },
    MagnificImageUpscalerCreativeNode(g, v) {
        g.set("image", g.crop); g.set("prompt", v.prompt); g.set("scale_factor", magnificFactor(v.factor)); g.set("auto_downscale", false);
        g.set("optimized_for", "standard"); g.set("engine", "automatic");
        for (const k of ["creativity", "hdr", "resemblance", "fractality"]) g.set(k, 0);
    },
    RecraftCrispUpscaleNode(g) { g.set("image", g.crop); },
    RecraftCreativeUpscaleNode(g) { g.set("image", g.crop); },
    QwenImageEditApi(g, v) {
        g.set("model", v.model); g.set("model.prompt", v.prompt); g.set("model.negative_prompt", v.negative || "");
        g.set("size", "match input"); g.set("n", 1); g.set("seed", v.seed); g.set("prompt_extend", true); g.set("watermark", false);
        g.images("model.images.image_", [g.crop, ...g.refs]);
    },
};

// How many pictures each node with an image list takes, the crop included (a mask input of its own is no picture), as
// its source says (the local ComfyUI's comfy_api_nodes, read on 2026-09-29): nodes_openai.py image_1 .. image_16,
// nodes_gemini.py image_1 .. image_14 ("the current maximum number of supported images is 14"), nodes_bytedance.py
// max_ref_images 14 for Seedream 5.0 lite and 10 for the others, nodes_bfl.py "n_images > 8", nodes_qwen.py "a maximum
// of 3 reference images". buildGraph refuses a run past it before any upload.
const NODE_PICTURES = {
    OpenAIGPTImageNodeV2: 16,
    GeminiNanoBanana2V2: 14,
    ByteDanceSeedreamNodeV3: (model) => (/lite/i.test(String(model || "")) ? 14 : 10),
    Flux2ImageNode: 8,
    QwenImageEditApi: 3,
};
const picturesOf = (node, model) => (typeof NODE_PICTURES[node] === "function" ? NODE_PICTURES[node](model) : NODE_PICTURES[node]);

// Where each node above takes the pictures of an edit: `field` the exact input key on the partner node, `mask` whether
// buildGraph's g.mask() gives a link. A node with one image input takes the crop alone and declares the drop: index.js
// then sends it no reference at all (a note says so), and buildGraph never uploads one it does not wire.
const autogrow = (req) => [["crop", "model.images.image_1"], ...refRoles(req).map(([role, i]) => [role, `model.images.image_${i + 2}`, i])];
const list = (node, req, own = []) => layoutOf({ seq: autogrow(req), own, max: picturesOf(node, req.model) });
const ONE_PICTURE = "this node takes one picture";
const cropOnly = (field) => layoutOf({ seq: [["crop", field]], max: 1, drops: ONE_PICTURE });
const LAYOUTS = {
    OpenAIGPTImageNodeV2: (req, mask) => list("OpenAIGPTImageNodeV2", req, mask ? [["mask", "model.mask"]] : []),
    GeminiNanoBanana2V2: (req) => list("GeminiNanoBanana2V2", req),
    GeminiImage2Node: () => cropOnly("images"),
    GeminiImageNode: () => cropOnly("images"),
    ByteDanceSeedreamNodeV3: (req) => list("ByteDanceSeedreamNodeV3", req),
    Flux2ImageNode: (req) => list("Flux2ImageNode", req),
    FluxProFillNode(req, mask) {
        if (!mask) throw new Error("Flux.1 Fill on Comfy Cloud needs a selection mask.");
        return layoutOf({ seq: [["crop", "image"]], own: [["mask", "mask"]], max: 1, drops: "FLUX.1 Fill takes no reference images" });
    },
    MagnificImageUpscalerPreciseV2Node: () => cropOnly("image"),
    MagnificImageUpscalerCreativeNode: () => cropOnly("image"),
    RecraftCrispUpscaleNode: () => cropOnly("image"),
    RecraftCreativeUpscaleNode: () => cropOnly("image"),
    QwenImageEditApi: (req) => list("QwenImageEditApi", req),
};

/** Magnific's nodes take 2x, 4x, 8x or 16x. */
function magnificFactor(f) {
    const n = Math.round(+f || 2);
    if (![2, 4, 8, 16].includes(n)) throw new Error(`Magnific on Comfy Cloud upscales by 2, 4, 8 or 16, not ${f}.`);
    return `${n}x`;
}

async function upload(ctx, bytes, name) {
    const fd = new FormData();
    fd.append("image", new Blob([bytes], { type: "image/png" }), name);
    fd.append("type", "input");
    fd.append("overwrite", "true");
    const r = await ctx.fetch(BASE + "/api/upload/image", { method: "POST", headers: { "X-API-Key": ctx.key }, body: fd });
    if (!r.ok) throw new Error(`Comfy Cloud upload (${name}): ${await readError(r)}`);
    const d = await r.json();
    if (!d.name) throw new Error("Comfy Cloud upload answered without a name: " + JSON.stringify(d).slice(0, 200));
    return d.subfolder ? `${d.subfolder}/${d.name}` : d.name;
}

async function buildGraph(req, ctx, node) {
    // the layout first: it refuses what the node cannot take (no node, Fill without a mask) before any upload
    const lay = layout(req);
    const max = +lay.max > 0 ? +lay.max : null, count = countOf(lay);
    // index.js refuses a run past the node's count before this; the check keeps a direct call from uploading one
    if (max != null && count > max) throw new Error(`Comfy Cloud ${node} takes at most ${max} picture${max === 1 ? "" : "s"}; this run has ${count}: hide reference layers or turn Original off.`);
    const stamp = Date.now().toString(36);
    const graph = {};
    let n = 0;
    const load = (file) => { const id = String(++n); graph[id] = { class_type: "LoadImage", inputs: { image: file } }; return [id, 0]; };
    const crop = load(await upload(ctx, req.image, `scumble-${stamp}-crop.png`));
    // the references the node wires, in the order its image list takes them; one it does not wire is never uploaded
    const refs = [];
    for (const p of lay.pictures.filter((x) => x.ref != null && x.n != null).sort((a, b) => a.n - b.n)) {
        refs.push(load(await upload(ctx, req.references[p.ref], `scumble-${stamp}-ref${p.ref + 1}.png`)));
    }
    // the mask only where the layout wires one (g.mask()'s rule), never for a node that takes none
    const uploadedMask = req.mask && lay.pictures.some((p) => p.role === "mask") ? await upload(ctx, req.mask, `scumble-${stamp}-mask.png`) : null;
    let maskLink = null;
    const partner = { class_type: node, inputs: {} };
    const g = {
        crop, refs,
        set(k, v) { if (v !== undefined) partner.inputs[k] = v; },
        images(prefix, links) { links.forEach((l, i) => { partner.inputs[prefix + (i + 1)] = l; }); },
        mask() {
            if (!uploadedMask || (req.kind === "edit" && !(req.options && req.options.mask))) return null;
            if (!maskLink) {
                // the mask PNG is white where to repaint; ImageToMask's red channel gives 1 there
                const img = load(uploadedMask);
                const id = String(++n);
                graph[id] = { class_type: "ImageToMask", inputs: { image: img, channel: "red" } };
                maskLink = [id, 0];
            }
            return maskLink;
        },
    };
    const shape = SHAPES[node];
    if (!shape) throw new Error(`Comfy Cloud: no wiring for the node ${node} (known: ${Object.keys(SHAPES).join(", ")})`);
    shape(g, { prompt: req.prompt || "", negative: req.negative || "", model: req.model, seed: req.seed != null && !req.params.random_seed ? (req.seed >>> 0) : Math.floor(Math.random() * 2147483647), width: req.width, height: req.height, factor: req.factor });
    // recipe settings and fixed values by input key (the settings' keys are the full input keys)
    for (const [k, v] of Object.entries(req.params)) { if (k === "random_seed" || k === "model" || v === "" || v == null || v === "auto") continue; partner.inputs[k] = v; }
    const pid = String(++n);
    graph[pid] = partner;
    graph[String(++n)] = { class_type: "SaveImage", inputs: { images: [pid, 0], filename_prefix: "scumble" } };
    return graph;
}

/** Where each picture of an edit goes: buildGraph's node and mask rule, then LAYOUTS; refused with run()'s and buildGraph's words. */
function layout(req) {
    const node = String(req.options && req.options.node || "");
    if (!node) throw new Error("Comfy Cloud recipe has no partner node (options.node).");
    if (!Object.prototype.hasOwnProperty.call(LAYOUTS, node)) throw new Error(`Comfy Cloud: no wiring for the node ${node} (known: ${Object.keys(SHAPES).join(", ")})`);
    // g.mask(): a mask, and on an edit only with options.mask
    const mask = !!req.mask && !(req.kind === "edit" && !(req.options && req.options.mask));
    return LAYOUTS[node](req, mask);
}

async function download(ctx, file) {
    const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || "", type: file.type || "output" });
    const r = await ctx.fetch(`${BASE}/api/view?${q}`, { headers: { "X-API-Key": ctx.key }, redirect: "manual" });
    if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        if (!loc) throw new Error("Comfy Cloud view: redirect without location");
        const s = await ctx.fetch(loc);   // signed URL, no key
        if (!s.ok) throw new Error(`Comfy Cloud download: ${s.status}`);
        return { bytes: Buffer.from(await s.arrayBuffer()), mime: s.headers.get("content-type") || "image/png" };
    }
    if (!r.ok) throw new Error(`Comfy Cloud view: ${await readError(r)}`);
    return { bytes: Buffer.from(await r.arrayBuffer()), mime: r.headers.get("content-type") || "image/png" };
}

/** The job's details (GET /api/jobs/<id>: status, outputs, execution_error); Comfy Cloud no longer serves /api/history. */
function jobDetails(ctx, id) {
    return ctx.fetch(`${BASE}/api/jobs/${id}`, { headers: { "X-API-Key": ctx.key } });
}

/**
 * Why a job failed. The status endpoint mostly says just "error"; the node's exception lives in the job's details
 * (execution_error with node_type, exception_type, exception_message; ComfyUI's history form, status.messages, is read
 * too), so that is read when the status carries nothing.
 */
async function failureDetail(ctx, id, status, info) {
    const brief = (v) => (typeof v === "string" ? v : JSON.stringify(v)).slice(0, 400);
    const said = (e) => [e.node_type, e.exception_type, e.exception_message].filter(Boolean).join(": ") || brief(e);
    let detail = info.messages || info.execution_error || info.error || info.error_message || info.message || info.detail;
    if (!detail) {
        try {
            const h = await jobDetails(ctx, id);
            if (h.ok) {
                const job = await h.json();
                const entry = (job && job[id]) || job || {};
                const st = entry.status && typeof entry.status === "object" ? entry.status : {};
                const msgs = Array.isArray(st.messages) ? st.messages : [];
                const err = msgs.find((m) => Array.isArray(m) && /error/i.test(String(m[0])));
                const e = entry.execution_error || (err && err[1]);
                if (e && typeof e === "object") detail = said(e);
                else if (st.status_str && st.status_str !== status) detail = st.status_str;
                else {
                    const { workflow: _w, ...rest } = entry;
                    if (Object.keys(rest).length) detail = "job " + brief(rest);
                }
            } else detail = `job details ${h.status}`;
        } catch (err) { detail = "job details unreadable: " + (err.message || err); }
    }
    const extra = Object.keys(info).filter((k) => k !== "status").length ? ` [status ${brief(info).slice(0, 200)}]` : "";
    return `${status}${detail ? " - " + brief(detail) : ""}${detail ? "" : extra}`;
}

const EDIT_WAIT_MS = 20 * 60 * 1000;
const UPSCALE_WAIT_MS = 30 * 60 * 1000;

module.exports = {
    label: "Comfy Cloud",
    keyUrl: "https://platform.comfy.org/profile/api-keys",
    keyHint: "API key from platform.comfy.org (Comfy Cloud needs a paid plan; Comfy Router and the Partner API run on the same key with credits only)",
    edit(req, ctx) { return run(req, ctx, EDIT_WAIT_MS); },
    layout,
    upscale(req, ctx) {
        if (!req.image) return Promise.reject(new Error("Comfy Cloud: no picture to upscale."));
        return run({ ...req, references: [], mask: null }, ctx, UPSCALE_WAIT_MS);
    },
    failureDetail,   // for tests
    _buildGraph: buildGraph,
};

async function run(req, ctx, waitMs) {
        const pause = ctx.sleep || sleep;
        const node = String(req.options && req.options.node || "");
        if (!node) throw new Error("Comfy Cloud recipe has no partner node (options.node).");
        const headers = { "X-API-Key": ctx.key, "Content-Type": "application/json" };
        const graph = await buildGraph(req, ctx, node);
        const submit = await ctx.fetch(BASE + "/api/prompt", { method: "POST", headers, body: JSON.stringify({ prompt: graph, client_id: "scumble" }) });
        if (!submit.ok) throw new Error(`Comfy Cloud prompt: ${await readError(submit)}`);
        const job = await submit.json();
        const id = job.prompt_id;
        if (!id) throw new Error("Comfy Cloud answered without prompt_id: " + JSON.stringify(job).slice(0, 300));
        const t0 = Date.now();
        let status = "", info = {};
        const done = new Set(["success", "completed", "error", "non_retryable_error", "lost", "cancelled", "failed"]);
        while (!done.has(status)) {
            if (Date.now() - t0 > waitMs) throw new Error(`Comfy Cloud: timed out after ${Math.round(waitMs / 60000)} minutes`);
            await pause(POLL_MS);
            const r = await ctx.fetch(`${BASE}/api/job/${id}/status`, { headers: { "X-API-Key": ctx.key } });
            if (!r.ok) throw new Error(`Comfy Cloud status: ${await readError(r)}`);
            info = await r.json();
            status = String(info.status || "").toLowerCase();
        }
        if (status !== "success" && status !== "completed") throw new Error(`Comfy Cloud ${node}: ${await failureDetail(ctx, id, status, info)}`);
        // the job's outputs (ComfyUI's outputs object, keyed by node); a job just finished may not list them yet
        let file = null, entry = {};
        for (let tries = 0; !file && tries < 4; tries++) {
            if (tries) await pause(POLL_MS);
            const h = await jobDetails(ctx, id);
            if (!h.ok) throw new Error(`Comfy Cloud job: ${await readError(h)}`);
            const job = await h.json();
            entry = (job && job[id]) || job || {};
            for (const out of Object.values(entry.outputs || {})) { if (out && Array.isArray(out.images) && out.images.length) { file = out.images[0]; break; } }
        }
        if (!file) {
            const { workflow: _w, ...rest } = entry;
            throw new Error("Comfy Cloud: the job finished without an image (" + JSON.stringify(rest).slice(0, 300) + ")");
        }
        const got = await download(ctx, file);
        return { bytes: got.bytes, mime: got.mime, seed: num(req.seed, null), info: { node, model: req.model, prompt_id: id } };
}
