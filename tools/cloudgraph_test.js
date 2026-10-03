// A ComfyUI recipe in the cloud form (recipes.detach) run through the Comfy Cloud adapter (comfycloud.js,
// options.graph), item 35 V5b (docs/PLAN_COMFY_VIEW.md §2.4), in plain Node against a fake cloud.comfy.org:
//   node tools/cloudgraph_test.js
// The fake answers the upload, the node list, the prompt, the job status, the history and the view (a 302 to a signed
// URL); it keeps every graph it was given. Checked: the pictures go into the titled LoadImage nodes in the node's batch
// order (a picture past the run's last is the last one), the prompt, the negative, the seed and the Settings rows land
// in their inputs, the run's own SaveImage answers before another output, a node the cloud lacks stops the run before
// any upload, a run past the graph's picture count is refused by the layout, a fill recipe takes the mask, a model file
// the cloud's node list lacks stops the run by name with the nearest file it has (V6 step 3).
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 500 ? s.slice(0, 500) + " ..." : s; };
async function thrown(fn) { try { await fn(); return null; } catch (err) { return String((err && err.message) || err); } }

const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-cloudgraph-test-"));
const orig = Module._load;
Module._load = function (request, ...rest) {
    if (request === "electron") return { app: { getPath: () => USERDATA } };
    return orig.call(this, request, ...rest);
};
const recipes = require(path.join(ROOT, "electron", "main", "recipes.js"));
Module._load = orig;
const cloud = require(path.join(ROOT, "electron", "main", "providers", "comfycloud.js"));
const refsLib = require(path.join(ROOT, "electron", "main", "providers", "refs.js"));

const png = (tag) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);
const tagOf = (b) => Buffer.from(b).slice(8).toString("latin1");
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A fake cloud.comfy.org: `classes` the node list it offers (or `info`, the node list itself), `outputs(graph)` what the finished job's history holds. */
function fakeCloud({ classes, info, outputs } = {}) {
    const s = { uploads: [], prompts: [], calls: [] };
    s.fetch = async (url, init = {}) => {
        const u = new URL(String(url));
        const method = String(init.method || "GET").toUpperCase();
        s.calls.push(`${method} ${u.pathname}`);
        if (method === "POST" && u.pathname === "/api/upload/image") {
            const f = init.body.get("image");
            s.uploads.push(tagOf(Buffer.from(await f.arrayBuffer())));
            return json(200, { name: `up${s.uploads.length}.png`, subfolder: "", type: "input" });
        }
        if (u.pathname === "/api/object_info") return json(200, info || Object.fromEntries((classes || []).map((c) => [c, {}])));
        if (method === "POST" && u.pathname === "/api/prompt") { s.prompts.push(JSON.parse(init.body).prompt); return json(200, { prompt_id: "p1" }); }
        if (u.pathname === "/api/job/p1/status") return json(200, { status: "success" });
        if (u.pathname === "/api/history/p1") return json(200, { p1: { outputs: (outputs || (() => ({})))(s.prompts[s.prompts.length - 1]) } });
        if (u.pathname === "/api/view") return new Response(null, { status: 302, headers: { location: "https://signed.example/" + u.searchParams.get("filename") } });
        if (u.host === "signed.example") return new Response(png("RESULT " + u.pathname.slice(1)), { status: 200, headers: { "content-type": "image/png" } });
        return json(404, { error: "no route " + u.pathname });
    };
    return s;
}

async function main() {
    const list = await recipes.list(path.join(ROOT, "recipes"));
    const klein = list.find((r) => r.id === "flux2_klein_local");
    const { recipe: cloudRecipe } = recipes.detach(klein);
    const v = recipes._normalize(JSON.parse(JSON.stringify(cloudRecipe))).providers.comfycloud;
    const all = Object.values(v.options.graph).map((n) => n.class_type);
    const saveId = Object.keys(v.options.graph).find((id) => v.options.graph[id].class_type === "SaveImage");
    const reqOf = (extra = {}) => ({ provider: "comfycloud", model: v.model, kind: v.input === "edit" ? "edit" : "fill", options: v.options, prompt: "a red door", negative: "blurry", seed: 4242,
        image: png("CROP"), mask: png("MASK"), width: 1024, height: 768, references: [], params: { "unet|unet_name": "my-unet.safetensors", "sigmas|steps": 12, random_seed: false }, original: 0, ...extra });

    // 1. a run with the Original and one reference: four LoadImage pictures, three files
    cloud._clearNodeList();
    let s = fakeCloud({ classes: all, outputs: (g) => ({ other: { images: [{ filename: "preview.png", type: "temp" }] }, [saveId]: { images: [{ filename: "own.png", subfolder: "", type: "output" }] } }) });
    const ctx = { key: "k-test", fetch: s.fetch, sleep: async () => {} };
    const req1 = reqOf({ references: [png("ORIGINAL"), png("REF1")], original: 1 });
    const lay = cloud.layout(req1);
    check("the layout: the crop, the Original and the reference numbered 1 to 3, at most the graph's 4 pictures", lay.max === 4 && refsLib.countOf(lay) === 3 && lay.pictures.map((p) => p.role).join(",") === "crop,original,reference", short(lay));
    const out = await cloud.edit(req1, ctx);
    const g = s.prompts[0];
    const imgOf = (id) => g[id].inputs.image;
    check("the uploads in the node's batch order: the crop, the Original, the reference", s.uploads.join(",") === "CROP,ORIGINAL,REF1", s.uploads.join(","));
    check("picture k into LoadImage k; the fourth, past the run's last, is the last one",
        imgOf("img0") === "up1.png" && imgOf("img1") === "up2.png" && imgOf("img2") === "up3.png" && imgOf("img3") === "up3.png", short(["img0", "img1", "img2", "img3"].map(imgOf)));
    check("the prompt, the seed and the Settings rows in their inputs; no Inpaint Canvas node",
        g.pos.inputs.text === "a red door" && g.noise.inputs.noise_seed === 4242 && g.unet.inputs.unet_name === "my-unet.safetensors" && g.sigmas.inputs.steps === 12 && !Object.values(g).some((n) => n.class_type === "InpaintCanvas"),
        short({ text: g.pos.inputs.text, seed: g.noise.inputs.noise_seed, unet: g.unet.inputs.unet_name, steps: g.sigmas.inputs.steps }));
    check("the run's own SaveImage answers before a preview", tagOf(out.bytes) === "RESULT own.png" && s.calls.filter((c) => c === "GET /api/object_info").length === 1, tagOf(out.bytes));

    // 2. the node list is kept per key: a second run asks for it no more
    await cloud.edit(reqOf(), ctx);
    check("the cloud's node list is asked once per key and kept", s.calls.filter((c) => c === "GET /api/object_info").length === 1, short(s.calls));

    // 3. a node the cloud lacks: refused by name before any upload
    cloud._clearNodeList();
    s = fakeCloud({ classes: all.filter((c) => c !== "Flux2Scheduler") });
    const e3 = await thrown(() => cloud.edit(reqOf(), { key: "k-test", fetch: s.fetch, sleep: async () => {} }));
    check("a node the cloud lacks stops the run by name before any upload", /Comfy Cloud has no Flux2Scheduler node/.test(e3 || "") && s.uploads.length === 0, e3);

    // 4. more pictures than the graph takes: index.js's check refuses on the layout
    const tooMany = reqOf({ references: [png("A"), png("B"), png("C"), png("D")] });
    const e4 = await thrown(() => refsLib.checkPictures(cloud.layout(tooMany), tooMany, "Comfy Cloud"));
    const e4b = await thrown(() => cloud._buildGraph(tooMany, { key: "k", fetch: fakeCloud({ classes: all }).fetch }, "recipe graph"));
    check("five pictures for a graph of four: refused (the layout's check, and the build itself before any upload)", !!e4 && /at most 4 pictures; this run has 5/.test(e4b || ""), short({ e4, e4b }));

    // 5. a fill recipe takes the mask through its LoadImage; without a mask it is refused
    const withMask = JSON.parse(JSON.stringify(klein));
    withMask.prompt.extra = { class_type: "SetLatentNoiseMask", inputs: { samples: ["noise", 0], mask: [klein.canvas, 1] } };
    const fill = recipes._normalize(JSON.parse(JSON.stringify(recipes.detach(withMask).recipe))).providers.comfycloud;
    cloud._clearNodeList();
    s = fakeCloud({ classes: Object.values(fill.options.graph).map((n) => n.class_type), outputs: () => ({ x: { images: [{ filename: "f.png" }] } }) });
    const fctx = { key: "k-fill", fetch: s.fetch, sleep: async () => {} };
    await cloud.edit(reqOf({ options: fill.options, kind: "fill" }), fctx);
    const gm = s.prompts[0];
    const maskLoad = Object.values(gm).find((n) => n._meta && n._meta.title === "scumble:mask");
    check("a fill recipe: the mask uploaded after the crop and set into its LoadImage", fill.input === "fill" && s.uploads.join(",") === "CROP,MASK" && maskLoad && maskLoad.inputs.image === "up2.png", short(s.uploads));
    const e5 = await thrown(() => cloud._buildGraph(reqOf({ options: fill.options, kind: "fill", mask: null }), fctx, "recipe graph"));
    check("a fill recipe without a mask: refused", /needs a selection mask/.test(e5 || ""), e5);

    // 6. a graph made for Comfy Cloud (fromCloudGraph, V5c): its SaveImage titled "Scumble result" answers by id
    const marked = {
        1: { class_type: "LoadImage", inputs: { image: "x.png" }, _meta: { title: "Scumble crop" } },
        2: { class_type: "CLIPTextEncode", inputs: { text: "" }, _meta: { title: "Scumble prompt" } },
        3: { class_type: "ImageInvert", inputs: { image: ["1", 0] } },
        9: { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: "a" }, _meta: { title: "Scumble result" } },
        10: { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "b" } },
    };
    const mv = recipes._normalize(JSON.parse(JSON.stringify(recipes.fromCloudGraph({ output: marked, name: "marked", ids: [], date: "2026-10-03" })))).providers.comfycloud;
    cloud._clearNodeList();
    s = fakeCloud({ classes: ["LoadImage", "CLIPTextEncode", "ImageInvert", "SaveImage"], outputs: () => ({ 10: { images: [{ filename: "other.png" }] }, 9: { images: [{ filename: "mine.png" }] } }) });
    const mo = await cloud.edit(reqOf({ options: mv.options, params: {} }), { key: "k-marked", fetch: s.fetch, sleep: async () => {} });
    check("a graph made for Comfy Cloud: the crop into its LoadImage, the prompt into its text, its Scumble result answers",
        tagOf(mo.bytes) === "RESULT mine.png" && s.prompts[0][1].inputs.image === "up1.png" && s.prompts[0][2].inputs.text === "a red door", tagOf(mo.bytes));

    // 7. a shipped Comfy Cloud recipe (Comfy's Qwen Image Edit 2509 template, V6 step 4): the crop and the Original into
    // its two LoadImage nodes, the prompt and the negative into its two encoders, its SaveImageAdvanced answers; an empty
    // negative keeps the graph's own (a template's default), a set one replaces it
    const q = list.find((r) => r.id === "cloud_qwen_image_edit_2509");
    const qv = q && q.providers.comfycloud;
    if (!qv) check("the shipped recipe cloud_qwen_image_edit_2509 is listed", false);
    else {
        const opts = JSON.parse(JSON.stringify(qv.options));
        opts.graph["433:110"].inputs.prompt = "worst quality";
        cloud._clearNodeList();
        s = fakeCloud({ classes: qv.options.needs, outputs: () => ({ 469: { images: [{ filename: "qwen.png" }] } }) });
        const qctx = { key: "k-qwen", fetch: s.fetch, sleep: async () => {} };
        const qo = await cloud.edit(reqOf({ options: opts, negative: "", params: {}, references: [png("ORIGINAL")], original: 1 }), qctx);
        const qg = s.prompts[0];
        check("Qwen Image Edit 2509 on Comfy Cloud: the crop into LoadImage 78, the Original into 470, the prompt into 433:111, its SaveImageAdvanced answers",
            tagOf(qo.bytes) === "RESULT qwen.png" && s.uploads.join(",") === "CROP,ORIGINAL" && qg["78"].inputs.image === "up1.png" && qg["470"].inputs.image === "up2.png" && qg["433:111"].inputs.prompt === "a red door",
            short({ uploads: s.uploads, crop: qg["78"].inputs.image, second: qg["470"].inputs.image, prompt: qg["433:111"].inputs.prompt }));
        check("an empty negative keeps the graph's own", qg["433:110"].inputs.prompt === "worst quality", qg["433:110"].inputs.prompt);
        await cloud.edit(reqOf({ options: opts, negative: "blurry", params: {}, references: [png("ORIGINAL")], original: 1 }), qctx);
        check("a negative of the run replaces it", s.prompts[1]["433:110"].inputs.prompt === "blurry", s.prompts[1]["433:110"].inputs.prompt);
    }

    // 8. Generate new on a shipped text-to-image recipe (V6 step 5): nothing uploaded, the prompt, the seed and the size
    // (in steps of 16) into the graph, its SaveImage answers; a partner-node recipe makes no new image on Comfy Cloud
    const z = list.find((r) => r.id === "cloud_z_image_turbo");
    const zv = z && z.providers.comfycloud;
    if (!zv || !zv.text) check("the shipped recipe cloud_z_image_turbo is listed with a text route", false);
    else {
        cloud._clearNodeList();
        s = fakeCloud({ classes: zv.options.needs, outputs: () => ({ [zv.options.save]: { images: [{ filename: "z.png" }] } }) });
        const zo = await cloud.generate({ provider: "comfycloud", model: zv.text.model, kind: "text", options: zv.options, prompt: "a lighthouse at dusk", negative: "", seed: 77,
            width: 1000, height: 777, references: [], params: {} }, { key: "k-z", fetch: s.fetch, sleep: async () => {} });
        const zg = s.prompts[0];
        const at = (k) => zv.options.values[k].map(([id, input]) => zg[id].inputs[input]);
        check("a text-to-image graph: nothing uploaded, the prompt and the seed in their inputs, 1000 x 777 asked as 1008 x 784, its SaveImage answers",
            tagOf(zo.bytes) === "RESULT z.png" && !s.uploads.length && at("prompt").every((x) => x === "a lighthouse at dusk") && at("seed").every((x) => x === 77) && at("width").every((x) => x === 1008) && at("height").every((x) => x === 784),
            short({ uploads: s.uploads, prompt: at("prompt"), seed: at("seed"), width: at("width"), height: at("height") }));
        const ez = await thrown(() => cloud.generate({ provider: "comfycloud", model: "Nano Banana Pro", kind: "text", options: { node: "GeminiImageNode" }, prompt: "x", width: 1024, height: 1024, references: [], params: {} }, { key: "k", fetch: fakeCloud({}).fetch }));
        check("a partner-node recipe: no new image on Comfy Cloud, said by name", /only through a Comfy Cloud recipe's own graph/.test(ez || ""), ez);
    }

    // 9. the model files against the node list (V6 step 3): a file the list lacks stops the run before any upload, named
    // with the nearest file the cloud has; sampler_name ("euler") is a combo too but no file; an input the list gives no
    // names for is not checked; a Settings row counts over the graph's value; a backslash path is the cloud's own file
    if (qv) {
        const UNET = "433:37";
        const own = qv.options.graph[UNET].inputs.unet_name;
        const infoWith = (unets, extra = {}) => ({
            ...Object.fromEntries(qv.options.needs.map((c) => [c, {}])),
            UNETLoader: { input: { required: { unet_name: [unets, {}], weight_dtype: [["default"], {}] } } },
            KSampler: { input: { required: { sampler_name: [["dpmpp_2m"], {}], scheduler: [["simple"], {}] } } },
            LoraLoaderModelOnly: { input: { required: { lora_name: ["COMBO", { options: ["Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors"] }] } } },
            CLIPLoader: { input: { required: { clip_name: [[], {}] } } },
            ...extra,
        });
        const runQ = async (unets, extra = {}) => {
            cloud._clearNodeList();
            const fc = fakeCloud({ info: infoWith(unets), outputs: () => ({ 469: { images: [{ filename: "q.png" }] } }) });
            const err = await thrown(() => cloud.edit(reqOf({ options: qv.options, negative: "", params: {}, references: [png("ORIGINAL")], original: 1, ...extra }), { key: "k-files", fetch: fc.fetch, sleep: async () => {} }));
            return { err, fc };
        };
        let r = await runQ(["qwen_image_edit_2509_fp8mixed.safetensors", "qwen_image_edit_2511_bf16.safetensors"]);
        check("a model file the cloud lacks: refused before any upload, with the node, the input and the nearest file it has",
            own === "qwen_image_edit_2509_fp8_e4m3fn.safetensors" && /^Comfy Cloud has no model file qwen_image_edit_2509_fp8_e4m3fn\.safetensors \(UNETLoader unet_name; it has qwen_image_edit_2509_fp8mixed\.safetensors\), so this recipe/.test(r.err || "") && !r.fc.uploads.length && !r.fc.prompts.length,
            short({ err: r.err, uploads: r.fc.uploads, prompts: r.fc.prompts.length }));
        r = await runQ(["qwen_image_edit_2509_fp8mixed.safetensors", own]);
        check("the file listed: the run goes; sampler_name euler outside its combo and a loader whose list names nothing are not checked",
            !r.err && r.fc.prompts.length === 1 && r.fc.prompts[0][UNET].inputs.unet_name === own && r.fc.prompts[0]["433:3"].inputs.sampler_name === "euler", short(r.err));
        r = await runQ(["qwen_image_edit_2509_fp8mixed.safetensors"], { params: { [`${UNET}|unet_name`]: "qwen_image_edit_2509_fp8mixed.safetensors" } });
        check("a Settings row with a file the cloud has counts over the graph's own", !r.err && r.fc.prompts[0][UNET].inputs.unet_name === "qwen_image_edit_2509_fp8mixed.safetensors", short(r.err));
        r = await runQ([own], { params: { [`${UNET}|unet_name`]: "my_own_unet.safetensors" } });
        check("a Settings row with a file the cloud lacks: refused by the row's file, no near name when none is close",
            /no model file my_own_unet\.safetensors \(UNETLoader unet_name\), so/.test(r.err || "") && !r.fc.uploads.length, short(r.err));
        r = await runQ(["qwen/" + own], { params: { [`${UNET}|unet_name`]: "qwen\\" + own } });
        check("a path with backslashes (a recipe saved on Windows): the cloud's own spelling goes out", !r.err && r.fc.prompts[0][UNET].inputs.unet_name === "qwen/" + own, short(r.err || r.fc.prompts[0][UNET].inputs.unet_name));
        r = await runQ(["qwen/" + own]);
        check("the same file in another folder: named, not swapped", new RegExp(`it has qwen/${own.replace(/\./g, "\\.")}\\)`).test(r.err || "") && !r.fc.prompts.length, short(r.err));
        const lora = await (async () => {
            cloud._clearNodeList();
            const fc = fakeCloud({ info: infoWith([own], { LoraLoaderModelOnly: { input: { required: { lora_name: ["COMBO", { options: ["other-lora.safetensors"] }] } } } }) });
            return thrown(() => cloud.edit(reqOf({ options: qv.options, params: {}, references: [png("ORIGINAL")], original: 1 }), { key: "k-lora", fetch: fc.fetch, sleep: async () => {} }));
        })();
        check("the newer combo form (COMBO with options) is read too", /no model file Qwen-Image-Edit-2509-Lightning-4steps-V1\.0-bf16\.safetensors \(LoraLoaderModelOnly lora_name\)/.test(lora || ""), short(lora));
    }
    if (zv && zv.text) {
        cloud._clearNodeList();
        const info = { ...Object.fromEntries(zv.options.needs.map((c) => [c, {}])), VAELoader: { input: { required: { vae_name: [["flux2-vae.safetensors", "qwen_image_vae.safetensors"], {}] } } } };
        s = fakeCloud({ info });
        const ezf = await thrown(() => cloud.generate({ provider: "comfycloud", model: zv.text.model, kind: "text", options: zv.options, prompt: "x", negative: "", seed: 1, width: 1024, height: 1024, references: [], params: {} }, { key: "k-zf", fetch: s.fetch, sleep: async () => {} }));
        check("Generate new is checked the same way: a VAE the cloud lacks stops the run before the prompt goes", /no model file ae\.safetensors \(VAELoader vae_name\), so/.test(ezf || "") && !s.prompts.length, short(ezf));
    }

    fs.rmSync(USERDATA, { recursive: true, force: true });
    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
