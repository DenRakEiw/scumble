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
// GET /api/history/<id> -> outputs -> images [{ filename, subfolder, type }]; GET /api/view
// answers 302 to a signed URL that must be fetched without the key (redirect: manual).
//
// A recipe variant names the partner node and its model choice; the adapter knows how each
// node takes the crop, the references, the mask, the size and the seed (SHAPES below). The
// dynamic inputs of the nodes (model combos, autogrow image lists) use dotted keys in the API
// prompt: "model": "gpt-image-2", "model.quality": "medium", "model.images.image_1": [id, 0].
// Recipe settings are copied by key, so a setting's key is the full input key.
"use strict";

const { readError, sleep, num } = require("./util");

const BASE = "https://cloud.comfy.org";
const POLL_MS = 2000;

/** Fit w x h into [lo, hi] per side, multiples of `step`. */
function fit(w, h, lo, hi, step) {
    let k = Math.min(1, hi / Math.max(w, h));
    if (Math.min(w, h) * k < lo) k = lo / Math.min(w, h);
    const r = (v) => Math.max(lo, Math.min(hi, Math.round(v * k / step) * step));
    return [r(w), r(h)];
}

function closestAspect(w, h, presets) {
    const want = Math.log(w / h);
    let best = presets[0], bestD = Infinity;
    for (const p of presets) {
        const [a, b] = String(p).split(":").map(Number);
        if (!a || !b) continue;
        const d = Math.abs(Math.log(a / b) - want);
        if (d < bestD) { best = p; bestD = d; }
    }
    return best;
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
    QwenImageEditApi(g, v) {
        g.set("model", v.model); g.set("model.prompt", v.prompt); g.set("model.negative_prompt", v.negative || "");
        g.set("size", "match input"); g.set("n", 1); g.set("seed", v.seed); g.set("prompt_extend", true); g.set("watermark", false);
        g.images("model.images.image_", [g.crop, ...g.refs].slice(0, 3));
    },
};

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
    const stamp = Date.now().toString(36);
    const graph = {};
    let n = 0;
    const load = (file) => { const id = String(++n); graph[id] = { class_type: "LoadImage", inputs: { image: file } }; return [id, 0]; };
    const crop = load(await upload(ctx, req.image, `scumble-${stamp}-crop.png`));
    const refs = [];
    for (let i = 0; i < req.references.length; i++) refs.push(load(await upload(ctx, req.references[i], `scumble-${stamp}-ref${i + 1}.png`)));
    const uploadedMask = req.mask ? await upload(ctx, req.mask, `scumble-${stamp}-mask.png`) : null;
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
    shape(g, { prompt: req.prompt || "", negative: req.negative || "", model: req.model, seed: req.seed != null && !req.params.random_seed ? (req.seed >>> 0) : Math.floor(Math.random() * 2147483647), width: req.width, height: req.height });
    // recipe settings and fixed values by input key (the settings' keys are the full input keys)
    for (const [k, v] of Object.entries(req.params)) { if (k === "random_seed" || k === "model" || v === "" || v == null || v === "auto") continue; partner.inputs[k] = v; }
    const pid = String(++n);
    graph[pid] = partner;
    graph[String(++n)] = { class_type: "SaveImage", inputs: { images: [pid, 0], filename_prefix: "scumble" } };
    return graph;
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

module.exports = {
    label: "Comfy Cloud",
    keyUrl: "https://platform.comfy.org/profile/api-keys",
    keyHint: "API key from platform.comfy.org (needs a paid Comfy Cloud plan; Partner Nodes are billed in credits)",
    async edit(req, ctx) {
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
            if (Date.now() - t0 > 20 * 60 * 1000) throw new Error("Comfy Cloud: timed out after 20 minutes");
            await sleep(POLL_MS);
            const r = await ctx.fetch(`${BASE}/api/job/${id}/status`, { headers: { "X-API-Key": ctx.key } });
            if (!r.ok) throw new Error(`Comfy Cloud status: ${await readError(r)}`);
            info = await r.json();
            status = String(info.status || "").toLowerCase();
        }
        if (status !== "success" && status !== "completed") {
            const m = info.messages || info.execution_error || info.error;
            throw new Error(`Comfy Cloud ${node}: ${status}${m ? " - " + JSON.stringify(m).slice(0, 400) : ""}`);
        }
        const h = await ctx.fetch(`${BASE}/api/history/${id}`, { headers: { "X-API-Key": ctx.key } });
        if (!h.ok) throw new Error(`Comfy Cloud history: ${await readError(h)}`);
        const hist = await h.json();
        const entry = hist[id] || hist;
        let file = null;
        for (const out of Object.values(entry.outputs || {})) { if (out && Array.isArray(out.images) && out.images.length) { file = out.images[0]; break; } }
        if (!file) throw new Error("Comfy Cloud: the job finished without an image (" + JSON.stringify(entry).slice(0, 300) + ")");
        const got = await download(ctx, file);
        return { bytes: got.bytes, mime: got.mime, seed: num(req.seed, null), info: { node, model: req.model, prompt_id: id } };
    },
};
