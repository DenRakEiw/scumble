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
// limit instead); Recraft's take the picture alone. RTX Video Super Resolution (recipes/rtx_vsr_cloud.json,
// docs/PLAN_0_1_42.md U3) is no Partner Node but a node Comfy Cloud runs on its own GPUs: the picture, the
// factor in its dynamic combo ("resize_type": "scale by multiplier", "resize_type.scale": 1 to 4) and Quality;
// its answer may pass at most 8192 px on the long side (RTX_OUT), refused before the prompt is sent.
//
// layout(req) declares where each picture goes (docs/PLAN_REFS.md C3) and how many pictures the node takes
// (NODE_PICTURES); buildGraph uploads only the pictures the layout wires and refuses a run past that count.
//
// Two APIs carry the same graphs (docs/PLAN_COMFY_SDK.md 3.3, 3.9). The Comfy API v2 through Comfy's official SDK
// (comfysdk.js, runV2 below) is the default (ctx.cloudApi "v2", set by providers/index.js contextFor): each picture
// is an asset handle in its LoadImage, uploaded by its content hash (one Comfy holds already is not sent again), the
// job submitted once under an idempotency key with the key again in extra_data for the partner nodes, waited for by
// its id, its output read by node. The legacy API above (run) stays for one release behind settings.comfycloud.api
// "legacy"; a caller that names no API (the plain-Node tests) gets it too.
"use strict";

const { randomUUID } = require("node:crypto");
const { readError, sleep, num, closestAspect } = require("./util");
const { layoutOf, refRoles, countOf } = require("./refs");

const BASE = "https://cloud.comfy.org";

/** settings.comfycloud.base when it is the loopback mock (a test profile), else undefined (cloud.comfy.org). */
function baseUrl(settings) {
    const s = (settings && settings.comfycloud) || {};
    return require("./comfysdk").testBase(s.base) || undefined;
}
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
    RTXVideoSuperResolution(g, v) {
        const f = rtxFactor(v);
        g.set("images", g.crop); g.set("resize_type", "scale by multiplier"); g.set("resize_type.scale", f); g.set("quality", "ULTRA");
    },
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
    RTXVideoSuperResolution: () => cropOnly("images"),
    QwenImageEditApi: (req) => list("QwenImageEditApi", req),
};

/** Magnific's nodes take 2x, 4x, 8x or 16x. */
function magnificFactor(f) {
    const n = Math.round(+f || 2);
    if (![2, 4, 8, 16].includes(n)) throw new Error(`Magnific on Comfy Cloud upscales by 2, 4, 8 or 16, not ${f}.`);
    return `${n}x`;
}

// RTX Video Super Resolution's answer: at most 8192 px on the long side (the node's target mode takes 64 to 8192 a side;
// the recipe's limits.out, which the renderer checks first, host.upscaleOutRefusal)
const RTX_OUT = 8192;

/** A PNG's width and height from its IHDR, or null (the crop of a direct call that names no size). */
function pngSize(b) {
    if (!b || b.length < 24 || b.toString("latin1", 12, 16) !== "IHDR") return null;
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

/**
 * RTX Video Super Resolution's factor: 1 to 4 (the node's `resize_type.scale`), refused when the picture's long side
 * times it passes RTX_OUT, with the renderer's words (host.upscaleOutRefusal), so a direct call is refused before the
 * prompt is sent too.
 */
function rtxFactor(v) {
    const f = +v.factor;
    if (!(f >= 1 && f <= 4)) throw new Error(`RTX Video Super Resolution on Comfy Cloud upscales by 1 to 4, not ${v.factor}.`);
    const size = v.width > 0 && v.height > 0 ? [v.width, v.height] : pngSize(v.image);
    if (size && Math.round(Math.max(size[0], size[1]) * f) > RTX_OUT) {
        throw new Error(`The picture is ${size[0]} × ${size[1]}; at ${f}× the answer would pass ${RTX_OUT} px on the long side. Pick a smaller factor or a smaller picture.`);
    }
    return f;
}

/** The nodes whose own numbers buildGraph checks before it uploads anything (the SHAPE checks them again). */
const BEFORE_UPLOAD = { RTXVideoSuperResolution: rtxFactor };

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

/** What a LoadImage takes for a picture: on v2 an asset handle (ctx.upload, sent at submit), else the legacy upload's name. */
const put = (ctx, bytes, name) => (typeof ctx.upload === "function" ? ctx.upload(bytes, name) : upload(ctx, bytes, name));

// ---- the cloud form of a ComfyUI recipe (recipes.detach, docs/PLAN_COMFY_VIEW.md §2.4, item 35 V5) ----------------
//
// `options.graph` is the recipe's own graph without the Inpaint Canvas node: its pictures come in through LoadImage
// nodes titled "scumble:picture:<k>" (0 the crop, then the Original where it goes, then the references, the node's
// batch order) and "scumble:mask", the run writes `options.values` (prompt, negative, seed, width, height) and the
// Settings rows (keyed "<node>|<input>") into it, and its SaveImage answers. Before any upload the cloud's node list
// (GET /api/object_info, kept ten minutes per key) must hold every node the graph needs; the model files it names are
// read against the same list and explain a failed run (checkModelFiles, V6 step 3).

const INFO_TTL_MS = 10 * 60 * 1000;
const infoCache = new Map();   // key -> { at, classes }

/** Comfy Cloud's node list for this key (its /api/object_info), kept ten minutes; `base` the loopback mock of a test key. */
async function cloudInfo(ctx, base = BASE) {
    const hit = infoCache.get(ctx.key);
    if (hit && Date.now() - hit.at < INFO_TTL_MS) return hit;
    const r = await ctx.fetch(base + "/api/object_info", { headers: { "X-API-Key": ctx.key } });
    if (!r.ok) throw new Error(`Comfy Cloud node list: ${await readError(r)}`);
    const j = await r.json();
    const info = j && typeof j === "object" && !Array.isArray(j) ? j : {};
    const entry = { at: Date.now(), info, classes: new Set(Object.keys(info)) };
    infoCache.set(ctx.key, entry);
    return entry;
}

// The model files of a recipe graph (V6 step 3). The node list gives the files a loader takes as its combo, but it is
// no proof a file is missing: Comfy Cloud also resolves a loader's value through the account's model assets (the
// user's own imports, which the list does not name; Comfy's own frontend checks those against /api/assets), and the
// list is kept ten minutes. So a value the list lacks does not stop the run; it explains a run that fails, with the
// nearest file the list has, and the list is read again for the next run. Only values ending in a model file's
// extension count (sampler_name "euler" and scheduler are combos too, a picture's ".png" is the run's own upload), and
// only in nodes that lead to an output (ComfyUI checks no other node's values).
const MODEL_EXT = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx|pkl|pickle)$/i;

/** The names an input of `cls` takes by the node list (its combo), or null when the list gives none. */
function choicesOf(info, cls, input) {
    const def = info && info[cls] && info[cls].input;
    const spec = def && ((def.required && def.required[input]) || (def.optional && def.optional[input]));
    if (!Array.isArray(spec)) return null;
    // the older form [[names], {...}] and the newer ["COMBO", { options: [names] }]
    const list = Array.isArray(spec[0]) ? spec[0] : spec[0] === "COMBO" && spec[1] && Array.isArray(spec[1].options) ? spec[1].options : [];
    const names = list.filter((x) => typeof x === "string");
    return names.length ? names : null;
}

/** The nodes whose result reaches an output (`save`, or a class the node list marks output_node), or null without one. */
function liveNodes(graph, info, save) {
    const stack = Object.keys(graph).filter((id) => (save != null && id === String(save)) || !!(graph[id] && info[graph[id].class_type] && info[graph[id].class_type].output_node));
    if (!stack.length) return null;
    const live = new Set();
    while (stack.length) {
        const id = stack.pop();
        if (live.has(id) || !graph[id]) continue;
        live.add(id);
        for (const v of Object.values(graph[id].inputs || {})) if (Array.isArray(v) && v.length === 2 && graph[String(v[0])]) stack.push(String(v[0]));
    }
    return live;
}

/** The model files a run of this graph asks for, a Settings row ("<node>|<input>") over the graph's own value. */
function modelFiles(req, info) {
    const graph = req.options.graph || {};
    const live = liveNodes(graph, info || {}, req.options.save);
    const at = new Map();
    for (const [id, node] of Object.entries(graph)) {
        if (live && !live.has(id)) continue;
        for (const [input, v] of Object.entries((node && node.inputs) || {})) at.set(`${id}|${input}`, v);
    }
    for (const [k, v] of Object.entries(req.params || {})) {
        const i = k.indexOf("|"), id = k.slice(0, i);
        if (i > 0 && v !== "" && v != null && graph[id] && (!live || live.has(id))) at.set(k, v);
    }
    const out = [];
    for (const [k, v] of at) {
        if (typeof v !== "string" || !MODEL_EXT.test(v)) continue;
        const i = k.indexOf("|"), id = k.slice(0, i);
        out.push({ id, input: k.slice(i + 1), cls: graph[id].class_type, value: v });
    }
    return out;
}

const fileBase = (s) => String(s).split(/[\\/]/).pop().toLowerCase();

function editDistance(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = row;
    }
    return prev[b.length];
}

/** The file of `names` nearest to a missing one: the same file in another folder, else a name a few letters off. */
function nearestFile(value, names) {
    const base = fileBase(value);
    const same = names.find((n) => fileBase(n) === base);
    if (same) return same;
    const stem = base.replace(MODEL_EXT, "");
    let best = null, bestD = Infinity;
    for (const n of names) {
        const d = editDistance(stem, fileBase(n).replace(MODEL_EXT, ""));
        if (d < bestD) { bestD = d; best = n; }
    }
    return bestD <= Math.max(2, Math.floor(stem.length / 4)) ? best : null;
}

/**
 * The model files of a recipe graph against the node list, before any upload. A value that differs from the cloud's
 * file only in its path separators (a recipe saved on Windows) is that file; one the list lacks is named in `missing`,
 * with the nearest file it has, for a failure's message (missingNote).
 * @returns {{ fixes: Map<string, string>, missing: string[] }} fixes: "<node>|<input>" -> the cloud's spelling
 */
function checkModelFiles(req, info) {
    const fixes = new Map(), missing = new Set();
    for (const f of modelFiles(req, info)) {
        const names = choicesOf(info, f.cls, f.input);
        if (!names || names.includes(f.value)) continue;
        const slash = f.value.replace(/\\/g, "/");
        const same = names.find((n) => n.replace(/\\/g, "/") === slash);
        if (same) { fixes.set(`${f.id}|${f.input}`, same); continue; }
        const near = nearestFile(f.value, names);
        missing.add(`${f.value} (${f.cls} ${f.input}${near ? `; it lists ${near}` : ""})`);
    }
    return { fixes, missing: [...missing] };
}

/** What a failed run adds when the node list lacked a model file of the graph. */
function missingNote(missing) {
    if (!missing.length) return "";
    const one = missing.length === 1;
    return ` Comfy Cloud's node list does not name the model file${one ? "" : "s"} ${missing.join(", ")}; unless ${one ? "it is" : "they are"} among your own models on Comfy Cloud, the recipe needs a file Comfy Cloud has.`;
}

/** The pictures of a cloud-form graph: the crop as picture 0, then the Original and the references; the mask on its own. */
function graphLayout(req) {
    const o = req.options || {};
    const seq = [["crop", "scumble:picture:0"], ...refRoles(req).map(([role, i]) => [role, `scumble:picture:${i + 1}`, i])];
    return layoutOf({ seq, own: o.mask && req.mask ? [["mask", "scumble:mask"]] : [], max: Math.max(1, Math.round(+o.pictures || 1)) });
}

/** What a cloud-form graph refuses before anything goes out: more pictures than it takes, a fill without a mask. */
function detachedFits(req) {
    const lay = graphLayout(req);
    const max = lay.max, count = countOf(lay);
    if (count > max) throw new Error(`This Comfy Cloud recipe takes at most ${max} picture${max === 1 ? "" : "s"}; this run has ${count}: hide reference layers or turn Original off.`);
    if (req.options.mask && !req.mask) throw new Error("This Comfy Cloud recipe needs a selection mask.");
    return lay;
}

async function buildDetached(req, ctx) {
    const o = req.options;
    const graph = JSON.parse(JSON.stringify(o.graph || {}));
    // a new image (Generate new, a text-to-image graph, V6 step 5): no picture goes up, the size goes in steps of 16
    const text = req.kind === "text";
    if (!text) {
        const lay = detachedFits(req);
        const stamp = Date.now().toString(36);
        const files = [await put(ctx, req.image, `scumble-${stamp}-crop.png`)];
        for (const p of lay.pictures.filter((x) => x.ref != null && x.n != null).sort((a, b) => a.n - b.n)) {
            files.push(await put(ctx, req.references[p.ref], `scumble-${stamp}-ref${p.ref + 1}.png`));
        }
        const maskFile = o.mask ? await put(ctx, req.mask, `scumble-${stamp}-mask.png`) : null;
        for (const node of Object.values(graph)) {
            const title = String((node && node._meta && node._meta.title) || "");
            const m = /^scumble:picture:(\d+)$/.exec(title);
            // a picture past the run's last is the last one, as the node's ImageFromBatch clamps
            if (m) node.inputs.image = files[Math.min(+m[1], files.length - 1)];
            else if (title === "scumble:mask") node.inputs.image = maskFile;
        }
    }
    const seed = req.seed != null && !(req.params && req.params.random_seed) ? (req.seed >>> 0) : Math.floor(Math.random() * 2147483647);
    const step16 = (v) => (v == null ? v : Math.max(64, Math.round(+v / 16) * 16));
    const vals = { prompt: req.prompt || "", negative: req.negative || "", seed, width: text ? step16(req.width) : req.width, height: text ? step16(req.height) : req.height };
    for (const [name, pairs] of Object.entries(o.values || {})) {
        if (!Object.prototype.hasOwnProperty.call(vals, name) || vals[name] == null) continue;   // denoise, mode: the graph's own
        // an empty negative field keeps the graph's own negative (a template's default, "worst quality, ..."), not ""
        if (name === "negative" && !vals.negative) continue;
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
    const vals = { prompt: req.prompt || "", negative: req.negative || "", model: req.model, seed: req.seed != null && !req.params.random_seed ? (req.seed >>> 0) : Math.floor(Math.random() * 2147483647), width: req.width, height: req.height, factor: req.factor, image: req.image };
    // what a node refuses by its own numbers, before any upload (its SHAPE checks the same as it wires them)
    if (BEFORE_UPLOAD[node]) BEFORE_UPLOAD[node](vals);
    const stamp = Date.now().toString(36);
    const graph = {};
    let n = 0;
    const load = (file) => { const id = String(++n); graph[id] = { class_type: "LoadImage", inputs: { image: file } }; return [id, 0]; };
    const crop = load(await put(ctx, req.image, `scumble-${stamp}-crop.png`));
    // the references the node wires, in the order its image list takes them; one it does not wire is never uploaded
    const refs = [];
    for (const p of lay.pictures.filter((x) => x.ref != null && x.n != null).sort((a, b) => a.n - b.n)) {
        refs.push(load(await put(ctx, req.references[p.ref], `scumble-${stamp}-ref${p.ref + 1}.png`)));
    }
    // the mask only where the layout wires one (g.mask()'s rule), never for a node that takes none
    const uploadedMask = req.mask && lay.pictures.some((p) => p.role === "mask") ? await put(ctx, req.mask, `scumble-${stamp}-mask.png`) : null;
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
    shape(g, vals);
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
    baseUrl,
    keyUrl: "https://platform.comfy.org/profile/api-keys",
    keyHint: "API key from platform.comfy.org (Comfy Cloud needs a paid plan; Comfy Router and the Partner API run on the same key with credits only)",
    edit(req, ctx) { return runOn(req, ctx, EDIT_WAIT_MS); },
    relight(req, ctx) { return runOn(req, ctx, EDIT_WAIT_MS); },
    // Generate new: only a Comfy Cloud recipe's own text-to-image graph (V6 step 5); the partner nodes take no text run
    generate(req, ctx) {
        if (!(req.options && req.options.graph)) return Promise.reject(new Error("Comfy Cloud makes a new image only through a Comfy Cloud recipe's own graph; pick another provider for this model."));
        return runOn({ ...req, image: null, mask: null, references: [] }, ctx, EDIT_WAIT_MS);
    },
    layout,
    upscale(req, ctx) {
        if (!req.image) return Promise.reject(new Error("Comfy Cloud: no picture to upscale."));
        return runOn({ ...req, references: [], mask: null }, ctx, UPSCALE_WAIT_MS);
    },
    failureDetail,   // for tests
    _buildGraph: buildGraph,
    _runV2: runV2,   // for tests: a run on v2 with its own wait
    _clearNodeList: () => infoCache.clear(),
    // the node definitions for reading a UI workflow exported from Comfy Cloud (recipes.importFile, item 35 V5c)
    async objectInfo(ctx) { return (await cloudInfo(ctx)).info; },
};

/** The Comfy API v2 when the context names it (contextFor's default), else the legacy API. */
function runOn(req, ctx, waitMs) {
    return ctx && ctx.cloudApi === "v2" ? runV2(req, ctx, waitMs) : run(req, ctx, waitMs);
}

async function run(req, ctx, waitMs) {
        const pause = ctx.sleep || sleep;
        const detached = !!(req.options && req.options.graph);
        const node = detached ? "recipe graph" : String(req.options && req.options.node || "");
        if (!node) throw new Error("Comfy Cloud recipe has no partner node (options.node).");
        const headers = { "X-API-Key": ctx.key, "Content-Type": "application/json" };
        let files = { fixes: new Map(), missing: [] };
        if (detached) {
            // what the graph refuses by itself, before any call; then every node it needs, before any upload (§2.4: a
            // missing one stops the run by name); the model files it names only explain a failure (V6 step 3)
            if (req.kind !== "text") detachedFits(req);
            const { info, classes: have } = await cloudInfo(ctx);
            const needs = Array.isArray(req.options.needs) ? req.options.needs : Object.values(req.options.graph).map((n) => n && n.class_type);
            const missing = [...new Set(needs.filter((c) => c && !have.has(c)))];
            if (missing.length) throw new Error(`Comfy Cloud has no ${missing.join(", ")} node${missing.length === 1 ? "" : "s"}, so this recipe cannot run there.`);
            files = checkModelFiles(req, info);
        }
        // a failure names the model files the node list lacked, and the next run reads the list again (a file added on
        // Comfy Cloud since)
        const failed = (msg) => {
            if (files.missing.length) infoCache.delete(ctx.key);
            return new Error(msg + missingNote(files.missing));
        };
        const graph = await buildGraph(req, ctx, node);
        for (const [k, v] of files.fixes) {
            const i = k.indexOf("|"), n = graph[k.slice(0, i)];
            if (n && n.inputs) n.inputs[k.slice(i + 1)] = v;
        }
        const saveId = !detached ? null : req.options.save && graph[req.options.save] ? String(req.options.save)
            : Object.keys(graph).find((id) => graph[id] && graph[id].class_type === "SaveImage" && /^scumble_save/.test(id));
        const submit = await ctx.fetch(BASE + "/api/prompt", { method: "POST", headers, body: JSON.stringify({ prompt: graph, client_id: "scumble" }) });
        if (!submit.ok) throw failed(`Comfy Cloud prompt: ${await readError(submit)}`);
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
        if (status !== "success" && status !== "completed") throw failed(`Comfy Cloud ${node}: ${await failureDetail(ctx, id, status, info)}`);
        // the job's outputs (ComfyUI's outputs object, keyed by node); a job just finished may not list them yet
        let file = null, entry = {};
        for (let tries = 0; !file && tries < 4; tries++) {
            if (tries) await pause(POLL_MS);
            const h = await jobDetails(ctx, id);
            if (!h.ok) throw new Error(`Comfy Cloud job: ${await readError(h)}`);
            const job = await h.json();
            entry = (job && job[id]) || job || {};
            // a recipe graph may hold more image outputs (a preview): its own SaveImage answers first
            const own = saveId && entry.outputs && entry.outputs[saveId];
            if (own && Array.isArray(own.images) && own.images.length) file = own.images[0];
            for (const out of Object.values(entry.outputs || {})) { if (file) break; if (out && Array.isArray(out.images) && out.images.length) { file = out.images[0]; break; } }
        }
        if (!file) {
            const { workflow: _w, ...rest } = entry;
            throw new Error("Comfy Cloud: the job finished without an image (" + JSON.stringify(rest).slice(0, 300) + ")");
        }
        const got = await download(ctx, file);
        return { bytes: got.bytes, mime: got.mime, seed: num(req.seed, null), info: { node, model: req.model, prompt_id: id } };
}

// ---- the Comfy API v2 through the SDK (docs/PLAN_COMFY_SDK.md 3.3, 3.6, 10) ------------------------------------------

const TERMINAL = new Set(["succeeded", "canceled", "failed", "expired"]);
const STATUS_MISSES = 5;          // status reads Comfy did not answer (or answered 5xx) while the status stays the same
const DOWNLOAD_TRIES = 3;         // the result is paid for by then: a dropped download is read again by the output's id
const CANCEL_TIMEOUT_MS = 10000;
const THROTTLE_MAX_MS = 60000;    // the longest pause a 429's Retry-After may ask for
const UPLOAD_RATE = 32768;        // bytes per second an upload may not fall below before its request gives up
const LOST_ANSWER = "Comfy Cloud: the answer to the submit was lost, and Comfy already holds a job under this run's key; Scumble does not send it again (that job may still run and be charged).";

/**
 * Whether a request may have reached Comfy without an answer coming back: no HTTP status at all (a dropped connection,
 * a request's own timeout) or a gateway's 5xx. The run's own Cancel is checked before this is asked.
 */
function unanswered(err) {
    if (!err || typeof err !== "object") return false;
    const st = +err.httpStatus || 0;
    if (st) return st >= 500;
    if (err.name === "TimeoutError" || err.name === "AbortError") return true;
    if (err.name === "TypeError" && /fetch failed|network|terminated|socket/i.test(String(err.message || ""))) return true;
    return /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR)/.test(String(err.code || (err.cause && err.cause.code) || ""));
}

/** A 429 (rate_limited, queue_full): the v2 contract says back off and try again; the pause it asks for, bounded. */
function throttled(err, left) {
    if (!err || +err.httpStatus !== 429) return -1;
    const ask = err.retryAfter == null ? POLL_MS : +err.retryAfter * 1000;
    return Math.max(0, Math.min(Math.max(ask, POLL_MS), THROTTLE_MAX_MS, left));
}

/** Asks Comfy to stop a job (best effort); true when it answered that the job stops. The job adopts the answer's state. */
async function askStop(job) {
    try { await job.cancel(AbortSignal.timeout(CANCEL_TIMEOUT_MS)); } catch (_) { return false; }
    return job.status === "canceling" || job.status === "canceled";
}

/** The node whose image answers: the recipe's own SaveImage for a recipe graph, the one buildGraph wrote for a partner node. */
function saveOf(req, graph, detached) {
    if (!detached) return Object.keys(graph).find((id) => graph[id] && graph[id].class_type === "SaveImage") || null;
    if (req.options.save && graph[req.options.save]) return String(req.options.save);
    return Object.keys(graph).find((id) => graph[id] && graph[id].class_type === "SaveImage" && /^scumble_save/.test(id)) || null;
}

/** The output to download: an image of the answering node, else the job's first image (a preview may come first). */
function pickOutput(job, saveId) {
    const image = (o) => o && (o.type === "image" || /^image\//.test(String(o.contentType || "")));
    return (saveId != null && job.getOutputs(String(saveId)).find(image)) || job.outputs.find(image) || null;
}

/** A failed job in words: the failing node's class and id (unless it is the partner node already named), then Comfy's message. */
function jobFailure(job, key, node) {
    const scrub = require("./comfysdk").scrub;
    const e = job.error || {};
    const where = e.class_type && e.class_type !== node ? `${e.class_type}${e.node_id ? ` (node ${e.node_id})` : ""}` : e.node_id && !e.class_type ? `node ${e.node_id}` : "";
    const what = scrub(e.message || e.code || "", key);
    return [where, what].filter(Boolean).join(": ") || "the job failed without a reason from Comfy";
}

async function runV2(req, ctx, waitMs) {
    const sdk = require("./comfysdk");
    const signal = ctx.signal || undefined;
    const stopped = () => !!(signal && signal.aborted);
    const say = (err) => sdk.errorText(err, ctx.key);
    const detached = !!(req.options && req.options.graph);
    const node = detached ? "recipe graph" : String(req.options && req.options.node || "");
    if (!node) throw new Error("Comfy Cloud recipe has no partner node (options.node).");
    if (detached && req.kind !== "text") detachedFits(req);
    // where the job stands for a Cancel's words (providers/index.js): nothing that runs has gone out yet
    ctx.jobSent = false;
    // the client first: a key that may not go where the settings point is refused before any request
    const client = sdk.cloudClient(ctx);
    const info = { node, model: req.model };
    let files = { fixes: new Map(), missing: [] };
    if (detached) {
        // v2 has no node list: the v1 read stays, advisory. One that fails or names nothing skips the check (v2's own
        // invalid_workflow then names a missing node); one that names nodes still stops a run whose node it lacks.
        let entry = null;
        try { entry = await cloudInfo(ctx, sdk.testBase(ctx.base) || BASE); } catch (err) {
            if (stopped()) throw err;
            info.nodeList = `unread: ${say(err)}`.slice(0, 200);
            if (typeof ctx.log === "function") ctx.log(`the node list could not be read (${say(err)}); the run goes without its check`);
        }
        if (entry && entry.classes.size) {
            const needs = Array.isArray(req.options.needs) ? req.options.needs : Object.values(req.options.graph).map((n) => n && n.class_type);
            const missing = [...new Set(needs.filter((c) => c && !entry.classes.has(c)))];
            if (missing.length) throw new Error(`Comfy Cloud has no ${missing.join(", ")} node${missing.length === 1 ? "" : "s"}, so this recipe cannot run there.`);
            files = checkModelFiles(req, entry.info);
        } else if (entry) info.nodeList = "empty";
    }
    const failed = (msg) => {
        if (files.missing.length) infoCache.delete(ctx.key);
        return new Error(msg + missingNote(files.missing));
    };
    // every picture an asset handle in its LoadImage; nothing leaves before the graph is built and checked. Each goes up
    // through a client whose request limit fits its size (a large picture on a slow line outlasts the default).
    const pictures = [];
    const upload = (bytes, name) => {
        const via = sdk.cloudClient(ctx, { timeoutMs: Math.max(sdk.CLIENT_TIMEOUT_MS, Math.ceil(bytes.length / UPLOAD_RATE) * 1000) });
        const opts = { filename: name, contentType: "image/png" };
        const a = via.assets.fromBytes(bytes, opts);
        pictures.push({ a, name, bytes, opts, via });
        return a;
    };
    const graph = await buildGraph(req, { ...ctx, upload }, node);
    for (const [k, v] of files.fixes) {
        const i = k.indexOf("|"), n = graph[k.slice(0, i)];
        if (n && n.inputs) n.inputs[k.slice(i + 1)] = v;
    }
    const saveId = saveOf(req, graph, detached);
    // the pictures go up before the submit (by content hash: bytes Comfy holds already are not sent again), so a failure
    // is named as an upload's. One that got no answer is sent once more under a fresh handle (a new upload key: Comfy may
    // hold the first one's key with no bytes behind it); the run's own handle then finds the bytes by their hash.
    for (const p of pictures) {
        for (let tries = 0; ; tries++) {
            try {
                if (tries > 0) await p.via.assets.fromBytes(p.bytes, p.opts).commit(signal);
                await p.a.commit(signal);
                break;
            } catch (err) {
                if (stopped()) throw err;
                if (tries === 0 && unanswered(err)) continue;
                throw new Error(`Comfy Cloud upload (${p.name}): ${say(err)}`);
            }
        }
    }
    // one submit under one key; a submit that got no answer goes once more under the same key, which Comfy refuses
    // (idempotency_key_reuse) when the first one landed: then the job exists, its id is lost, and nothing is resent
    const workflow = client.workflows.fromJson(graph);
    ctx.jobSent = true;   // from here a job may exist on Comfy
    const idempotencyKey = (typeof ctx.uuid === "function" ? ctx.uuid : randomUUID)();
    let job = null;
    for (let tries = 0; !job; tries++) {
        try {
            job = await client.submit(workflow, { idempotencyKey, apiKey: ctx.key, signal });
        } catch (err) {
            if (stopped()) throw err;
            const code = String((err && (err.errorType || err.code)) || "");
            if (tries > 0 && code === "idempotency_key_reuse") throw new Error(LOST_ANSWER);
            if (tries === 0 && unanswered(err)) {
                if (typeof ctx.log === "function") ctx.log(`the submit got no answer (${say(err)}); sent once more under the same key`);
                continue;
            }
            if (tries > 0 && unanswered(err)) throw new Error(`Comfy Cloud did not answer the submit twice (${say(err)}); Scumble does not send it again, and if Comfy took it, it may run and be charged.`);
            throw failed(`Comfy Cloud prompt: ${say(err)}`);
        }
    }
    info.job_id = job.id;
    if (typeof ctx.progress === "function") ctx.progress({ status: job.status, queuePosition: job.queuePosition, urgent: true });
    // the live events feed the status row's bar and a summary in the answer's info; the polled status decides
    const live = followEvents(job, ctx, signal);
    try {
        const got = await finishV2(job, { req, ctx, waitMs, node, saveId, failed });
        got.info = info;   // the events' summary joins it below
        return got;
    } catch (err) {
        // the user's Cancel: Comfy is asked to stop the job on a transport of its own (the run's refuses every request
        // now), so it is not run on and charged; providers/index.js words the cancel by ctx.cancelAsked
        if (stopped() && !TERMINAL.has(job.status)) {
            let answer = null;
            try { answer = await sdk.cancelJob(ctx, job.id); } catch (_) { /* the words say the job may still be charged */ }
            ctx.cancelAsked = answer === "canceling" || answer === "canceled";
            if (answer === "succeeded") ctx.jobDone = true;
        } else if (stopped() && job.status === "succeeded") ctx.jobDone = true;   // a Cancel while its picture came down
        throw err;
    } finally {
        const seen = await live.stop();
        if (seen) info.events = seen;
    }
}

/** A submitted job to its picture: the wait, the status's words, the output, the download. */
async function finishV2(job, { req, ctx, waitMs, node, saveId, failed }) {
    const sdk = require("./comfysdk");
    const pause = ctx.sleep || sleep;
    const signal = ctx.signal || undefined;
    const stopped = () => !!(signal && signal.aborted);
    const say = (err) => sdk.errorText(err, ctx.key);
    // the job's status decides (wait() polls it, and throws on a read that fails). A read Comfy throttles (429) waits
    // as long as it asks; a read with no answer is tried again a few times while the status stays the same. Past the
    // run's time, or when the status cannot be read, Comfy is asked to stop the job, so it is not run on and charged unseen.
    const end = Date.now() + waitMs;
    let seen = job.status, misses = 0, unread = null;
    while (!TERMINAL.has(job.status)) {
        const left = end - Date.now();
        if (left <= 0) break;
        try { await job.wait(left, signal); } catch (err) {
            if (stopped()) throw err;
            if (job.status !== seen) { seen = job.status; misses = 0; }
            if (Date.now() >= end) break;   // wait()'s own deadline
            const ms = throttled(err, end - Date.now());
            if (ms >= 0) { await pause(ms); continue; }
            if (unanswered(err) && ++misses <= STATUS_MISSES) { await pause(POLL_MS); continue; }
            unread = err;
            break;
        }
    }
    if (!TERMINAL.has(job.status)) {
        const asked = await askStop(job);
        // the cancel's answer may say the job ended meanwhile: then its own status decides below
        if (!TERMINAL.has(job.status) || job.status === "canceled") {
            const why = unread ? `Comfy Cloud status: ${say(unread)}` : `Comfy Cloud: timed out after ${Math.round(waitMs / 60000)} minutes`;
            throw new Error(`${why}; ${asked ? "Scumble asked Comfy Cloud to stop the job" : `the job (${job.id}) may still finish and be charged`}.`);
        }
    }
    if (job.status === "canceled") throw new Error(`Comfy Cloud ${node}: the job was canceled on Comfy's side.`);
    if (job.status === "expired") throw new Error(`Comfy Cloud ${node}: the job expired on Comfy's side before it finished; run it again.`);
    if (job.status !== "succeeded") throw failed(`Comfy Cloud ${node}: ${jobFailure(job, ctx.key, node)}`);
    // a job just finished may not list its outputs yet
    let out = pickOutput(job, saveId);
    for (let tries = 0; !out && tries < 3; tries++) {
        await pause(POLL_MS);
        try { await job.refresh(signal); } catch (err) { if (stopped()) throw err; }
        out = pickOutput(job, saveId);
    }
    if (!out) throw new Error(`Comfy Cloud: the job finished without an image (${JSON.stringify(job.outputs.map((o) => ({ node: o.nodeId, type: o.type, name: o.name }))).slice(0, 300)})`);
    // the job is paid for: a download that dropped (or was throttled) is read again by the output's id
    let bytes;
    for (let tries = 1; ; tries++) {
        try { bytes = await out.toBytes({ signal }); break; } catch (err) {
            if (stopped()) throw err;
            const ms = throttled(err, THROTTLE_MAX_MS);
            if (tries < DOWNLOAD_TRIES && (ms >= 0 || unanswered(err))) { await pause(ms >= 0 ? ms : POLL_MS); continue; }
            throw new Error(`Comfy Cloud download (job ${job.id}): ${say(err)}`);
        }
    }
    return { bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), mime: out.contentType || "image/png", seed: num(req.seed, null), info: null };
}

/** A live event as the status row's bar takes it (providers/index.js passes it on with the run's id), or null. */
function frameOf(ev) {
    if (ev.kind === "progress") return { value: ev.value, step: ev.step, steps: ev.steps, nodesDone: ev.nodesDone, nodesTotal: ev.nodesTotal, node: ev.currentNode, nodeClass: ev.currentNodeClass };
    if (ev.kind === "statusChange") return { status: ev.status, queuePosition: ev.queuePosition, urgent: true };
    return null;
}

const PROGRESS_FIELDS = ["value", "message", "nodesDone", "nodesTotal", "currentNode", "currentNodeClass", "step", "steps"];

const EVENT_FAILS = 5;         // live-event streams in a row that fail before the following gives up (the run goes on)
const EVENT_PAUSE_MS = 500;    // the pause before a failed stream is joined again, times the failures in a row

/**
 * Follows a job's live events (SSE) beside the wait: each goes to ctx.progress as a frame, and a summary of what came
 * (kinds, the progress fields that carried a value, the value's range, the statuses) answers stop(). The events are a
 * live enhancement, never the source of truth: a stream that fails is joined again after a pause (the SDK's own
 * reconnect ends when the status read after a drop fails), a share lower than one sent is not passed on (a stream
 * joined again may replay it), and a stream that ends with the job, or a refusal that will not change, ends it.
 */
function followEvents(job, ctx, signal) {
    const ac = new AbortController();
    const stop = () => ac.abort();
    if (signal) signal.addEventListener("abort", stop, { once: true });
    const seen = { count: 0, kinds: {}, fields: new Set(), min: null, max: null, statuses: [] };
    let top = -Infinity;
    const take = (ev) => {
        seen.count++;
        seen.kinds[ev.kind] = (seen.kinds[ev.kind] || 0) + 1;
        if (ev.kind === "progress") {
            for (const k of PROGRESS_FIELDS) if (ev[k] != null && ev[k] !== "") seen.fields.add(k);
            seen.min = seen.min == null ? ev.value : Math.min(seen.min, ev.value);
            seen.max = seen.max == null ? ev.value : Math.max(seen.max, ev.value);
            if (ev.value < top) return;
            top = ev.value;
        } else if (ev.kind === "statusChange" && seen.statuses.length < 8) seen.statuses.push(ev.status);
        const frame = typeof ctx.progress === "function" ? frameOf(ev) : null;
        if (frame) { try { ctx.progress(frame); } catch (_) { /* the bar is optional */ } }
    };
    // a pause that stop() ends at once
    const rest = (ms) => new Promise((resolve) => {
        if (ac.signal.aborted) { resolve(); return; }
        const done = () => { clearTimeout(t); ac.signal.removeEventListener("abort", done); resolve(); };
        const t = setTimeout(done, ms);
        ac.signal.addEventListener("abort", done, { once: true });
    });
    const following = (async () => {
        for (let fails = 0; !ac.signal.aborted && fails < EVENT_FAILS;) {
            try {
                for await (const ev of job.events(ac.signal)) { fails = 0; take(ev); }
                return;   // the job's end, or a surface without live events (501)
            } catch (err) {
                if (ac.signal.aborted) return;
                const st = +(err && err.httpStatus) || 0;
                if (st >= 400 && st < 500 && st !== 429) return;   // a refusal that will not change
                fails++;
                await rest(Math.min(THROTTLE_MAX_MS, err && +err.retryAfter > 0 ? +err.retryAfter * 1000 : EVENT_PAUSE_MS * fails));
            }
        }
    })();
    return {
        async stop() {
            ac.abort();
            if (signal) signal.removeEventListener("abort", stop);
            await following;
            if (!seen.count) return null;
            return { count: seen.count, kinds: seen.kinds, fields: [...seen.fields], value: seen.min == null ? null : [seen.min, seen.max], statuses: seen.statuses };
        },
    };
}
