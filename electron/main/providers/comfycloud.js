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

// ---- the cloud form of a ComfyUI recipe (recipes.detach, docs/PLAN_COMFY_VIEW.md §2.4, item 35 V5) ----------------
//
// `options.graph` is the recipe's own graph without the Inpaint Canvas node: its pictures come in through LoadImage
// nodes titled "scumble:picture:<k>" (0 the crop, then the Original where it goes, then the references, the node's
// batch order) and "scumble:mask", the run writes `options.values` (prompt, negative, seed, width, height) and the
// Settings rows (keyed "<node>|<input>") into it, and its SaveImage answers. Before any upload the cloud's node list
// (GET /api/object_info, kept ten minutes per key) must hold every node the graph needs.

const INFO_TTL_MS = 10 * 60 * 1000;
const infoCache = new Map();   // key -> { at, classes }

/** The node types Comfy Cloud offers to this key. */
async function cloudClasses(ctx) {
    const hit = infoCache.get(ctx.key);
    if (hit && Date.now() - hit.at < INFO_TTL_MS) return hit.classes;
    const r = await ctx.fetch(BASE + "/api/object_info", { headers: { "X-API-Key": ctx.key } });
    if (!r.ok) throw new Error(`Comfy Cloud node list: ${await readError(r)}`);
    const j = await r.json();
    const classes = new Set(Object.keys(j && typeof j === "object" ? j : {}));
    infoCache.set(ctx.key, { at: Date.now(), classes });
    return classes;
}

/** The pictures of a cloud-form graph: the crop as picture 0, then the Original and the references; the mask on its own. */
function graphLayout(req) {
    const o = req.options || {};
    const seq = [["crop", "scumble:picture:0"], ...refRoles(req).map(([role, i]) => [role, `scumble:picture:${i + 1}`, i])];
    return layoutOf({ seq, own: o.mask && req.mask ? [["mask", "scumble:mask"]] : [], max: Math.max(1, Math.round(+o.pictures || 1)) });
}

async function buildDetached(req, ctx) {
    const o = req.options;
    const lay = graphLayout(req);
    const max = lay.max, count = countOf(lay);
    if (count > max) throw new Error(`This Comfy Cloud recipe takes at most ${max} picture${max === 1 ? "" : "s"}; this run has ${count}: hide reference layers or turn Original off.`);
    if (o.mask && !req.mask) throw new Error("This Comfy Cloud recipe needs a selection mask.");
    const graph = JSON.parse(JSON.stringify(o.graph || {}));
    const stamp = Date.now().toString(36);
    const files = [await upload(ctx, req.image, `scumble-${stamp}-crop.png`)];
    for (const p of lay.pictures.filter((x) => x.ref != null && x.n != null).sort((a, b) => a.n - b.n)) {
        files.push(await upload(ctx, req.references[p.ref], `scumble-${stamp}-ref${p.ref + 1}.png`));
    }
    const maskFile = o.mask ? await upload(ctx, req.mask, `scumble-${stamp}-mask.png`) : null;
    for (const node of Object.values(graph)) {
        const title = String((node && node._meta && node._meta.title) || "");
        const m = /^scumble:picture:(\d+)$/.exec(title);
        // a picture past the run's last is the last one, as the node's ImageFromBatch clamps
        if (m) node.inputs.image = files[Math.min(+m[1], files.length - 1)];
        else if (title === "scumble:mask") node.inputs.image = maskFile;
    }
    const seed = req.seed != null && !(req.params && req.params.random_seed) ? (req.seed >>> 0) : Math.floor(Math.random() * 2147483647);
    const vals = { prompt: req.prompt || "", negative: req.negative || "", seed, width: req.width, height: req.height };
    for (const [name, pairs] of Object.entries(o.values || {})) {
        if (!Object.prototype.hasOwnProperty.call(vals, name) || vals[name] == null) continue;   // denoise, mode: the graph's own
        for (const [id, input] of Array.isArray(pairs) ? pairs : []) if (graph[id] && graph[id].inputs) graph[id].inputs[input] = vals[name];
    }
    for (const [k, v] of Object.entries(req.params || {})) {
        const i = k.indexOf("|");
        if (i <= 0 || v === "" || v == null) continue;
        const id = k.slice(0, i), input = k.slice(i + 1);
        if (graph[id] && graph[id].inputs) graph[id].inputs[input] = v;
    }
    return graph;
}

async function buildGraph(req, ctx, node) {
    if (req.options && req.options.graph) return buildDetached(req, ctx);
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
    if (req.options && req.options.graph) return graphLayout(req);
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

/**
 * Why a job failed. The status endpoint mostly says just "error"; the node's exception lives in
 * the job's history entry (status.messages, an execution_error with node_type,
 * exception_type, exception_message), so that is read when the status carries nothing.
 */
async function failureDetail(ctx, id, status, info) {
    const brief = (v) => (typeof v === "string" ? v : JSON.stringify(v)).slice(0, 400);
    let detail = info.messages || info.execution_error || info.error || info.error_message || info.message || info.detail;
    if (!detail) {
        try {
            const h = await ctx.fetch(`${BASE}/api/history/${id}`, { headers: { "X-API-Key": ctx.key } });
            if (h.ok) {
                const hist = await h.json();
                const entry = hist[id] || hist;
                const st = entry.status || {};
                const msgs = Array.isArray(st.messages) ? st.messages : [];
                const err = msgs.find((m) => Array.isArray(m) && /error/i.test(String(m[0])));
                const e = err && err[1];
                if (e && typeof e === "object") detail = [e.node_type, e.exception_type, e.exception_message].filter(Boolean).join(": ") || brief(e);
                else if (st.status_str && st.status_str !== status) detail = st.status_str;
                else if (Object.keys(entry).length) detail = "history " + brief(entry);
            } else detail = `history ${h.status}`;
        } catch (err) { detail = "history unreadable: " + (err.message || err); }
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
    _clearNodeList: () => infoCache.clear(),
};

async function run(req, ctx, waitMs) {
        const pause = ctx.sleep || sleep;
        const detached = !!(req.options && req.options.graph);
        const node = detached ? "recipe graph" : String(req.options && req.options.node || "");
        if (!node) throw new Error("Comfy Cloud recipe has no partner node (options.node).");
        const headers = { "X-API-Key": ctx.key, "Content-Type": "application/json" };
        if (detached) {
            // every node the graph needs, before any upload (§2.4: a missing one stops the run by name)
            const have = await cloudClasses(ctx);
            const needs = Array.isArray(req.options.needs) ? req.options.needs : Object.values(req.options.graph).map((n) => n && n.class_type);
            const missing = [...new Set(needs.filter((c) => c && !have.has(c)))];
            if (missing.length) throw new Error(`Comfy Cloud has no ${missing.join(", ")} node${missing.length === 1 ? "" : "s"}, so this recipe cannot run there.`);
        }
        const graph = await buildGraph(req, ctx, node);
        const saveId = detached ? Object.keys(graph).find((id) => graph[id] && graph[id].class_type === "SaveImage" && /^scumble_save/.test(id)) : null;
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
        const h = await ctx.fetch(`${BASE}/api/history/${id}`, { headers: { "X-API-Key": ctx.key } });
        if (!h.ok) throw new Error(`Comfy Cloud history: ${await readError(h)}`);
        const hist = await h.json();
        const entry = hist[id] || hist;
        let file = null;
        // a recipe graph may hold more image outputs (a preview): its own SaveImage answers first
        const own = saveId && entry.outputs && entry.outputs[saveId];
        if (own && Array.isArray(own.images) && own.images.length) file = own.images[0];
        for (const out of Object.values(entry.outputs || {})) { if (file) break; if (out && Array.isArray(out.images) && out.images.length) { file = out.images[0]; break; } }
        if (!file) throw new Error("Comfy Cloud: the job finished without an image (" + JSON.stringify(entry).slice(0, 300) + ")");
        const got = await download(ctx, file);
        return { bytes: got.bytes, mime: got.mime, seed: num(req.seed, null), info: { node, model: req.model, prompt_id: id } };
}
