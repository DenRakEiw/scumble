// Upscaling through the providers (docs/RECIPES.md "Upscale recipes"), in plain Node, no Electron and no key:
//   node tools/upscale_test.js
// The recipe format (`task: "upscale"`, `factor`, `usesPrompt`) as recipes.js normalizes it, the fal adapter's
// upscale bodies for every shipped fal upscaler (golden), the Magnific adapter (electron/main/providers/magnific.js:
// both routes' bodies, the factor rules, the 25.3 MP cap, the host and test-key rules, the task poll, the retry, the
// errors without the key), the Comfy Cloud graphs around the four upscaler Partner Nodes, the dispatch in providers/index.js and the assistant's policy row. A scripted fetch plays
// fal's queue, Magnific's task routes, Comfy Cloud's job routes and a result host; ctx.sleep records its waits instead of waiting. The facts are
// fal's OpenAPI schemas (queue/openapi.json per endpoint) and Magnific's API reference, both read 2026-09-22; nothing
// here talks to a live API.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const P = (...a) => path.join(ROOT, ...a);

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 400 ? s.slice(0, 400) + " ..." : s; };
async function section(name, fn) { console.log(`\n--- ${name} ---`); await fn(); }
async function throwsWith(fn, re) {
    try { await fn(); return { ok: false, msg: "(no error)" }; } catch (err) { const msg = String(err && err.message || err); return { ok: re.test(msg), msg }; }
}

/** A PNG as far as the adapters look: the signature and an IHDR with width and height. */
function pngOf(w, h, tag = "") {
    const b = Buffer.alloc(Math.max(64, 33 + tag.length), 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    b[24] = 8; b[25] = 6;
    b.write(tag, 33, "latin1");
    return b;
}

/** modules that require electron (recipes.js, providers/index.js) with a stand-in for it */
function withElectron(fn) {
    const orig = Module._load;
    Module._load = function (request, ...rest) {
        if (request === "electron") return { app: { getPath: () => ROOT }, nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) }, safeStorage: { isEncryptionAvailable: () => false } };
        return orig.call(this, request, ...rest);
    };
    try { return fn(); } finally { Module._load = orig; }
}

/** A scripted fetch: `routes` is [{ match(url, init), answer(url, init, n) }]; every call is recorded. */
function scripted(routes) {
    const calls = [];
    const fetch = async (url, init = {}) => {
        const call = { url: String(url), method: init.method || "GET", headers: { ...(init.headers || {}) }, body: typeof init.body === "string" ? JSON.parse(init.body) : (init.body || null) };
        calls.push(call);
        for (const r of routes) {
            if (r.match(call)) {
                r.n = (r.n || 0) + 1;
                const a = await r.answer(call, r.n);
                return a instanceof Response ? a : new Response(typeof a === "string" ? a : JSON.stringify(a), { status: 200, headers: { "content-type": "application/json" } });
            }
        }
        return new Response("no route " + call.url, { status: 404 });
    };
    return { fetch, calls };
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const png = (bytes) => new Response(bytes, { status: 200, headers: { "content-type": "image/png" } });

(async () => {
    const recipes = withElectron(() => require(P("electron", "main", "recipes.js")));
    const rawOf = (id) => JSON.parse(fs.readFileSync(P("recipes", id + ".json"), "utf8"));
    const norm = (id) => recipes._normalize ? recipes._normalize(rawOf(id)) : null;
    const SHIPPED = ["topaz_precision", "topaz_creative", "topaz_generative", "clarity_upscaler", "seedvr2", "recraft_crisp", "recraft_creative", "magnific_precision", "magnific_creative"];

    await section("the recipe format", async () => {
        check("recipes.js exports _normalize for the test", typeof recipes._normalize === "function");
        for (const id of SHIPPED) {
            const r = norm(id);
            const bad = [];
            if (r.task !== "upscale") bad.push("task " + r.task);
            if (r.family !== "Upscale") bad.push("family " + r.family);
            for (const [pid, v] of Object.entries(r.providers)) {
                if (v.text !== null) bad.push(pid + " has a Generate new shape");
                if (!v.factor) bad.push(pid + " has no factor");
                if (v.limits.step !== 1 || v.limits.max !== 4096 || v.limits.min !== 32) bad.push(pid + " limits " + JSON.stringify(v.limits));
            }
            check(`${id} is an upscale recipe without a Generate new shape, the crop at its own size`, !bad.length, bad.join("; "));
        }
        const f = norm("magnific_creative").providers.magnific.factor;
        check("Magnific Creative offers 2, 4, 8, 16 only", eq(f.steps, [2, 4, 8, 16]) && f.default === 2 && !f.fixed, short(f));
        const mp = norm("magnific_precision").providers.magnific.factor;
        check("Magnific Precision offers 2 to 16", mp.min === 2 && mp.max === 16 && mp.steps === null && mp.default === 2, short(mp));
        check("Recraft picks its own factor", norm("recraft_crisp").providers.fal.factor.fixed === true && norm("recraft_creative").providers.fal.factor.fixed === true);
        check("Clarity and Magnific Creative take the prompt, Topaz does not",
            norm("clarity_upscaler").providers.fal.usesPrompt === true && norm("magnific_creative").providers.magnific.usesPrompt === true && norm("topaz_precision").providers.fal.usesPrompt === false);
        // the normalizer on its own inputs
        const odd = recipes._normalize({ kind: "provider", task: "upscale", factor: { default: 3, steps: [8, 2, 99, 4] }, providers: { fal: { model: "x" } } });
        check("steps outside min..max are dropped and sorted, a default not among them falls to the first", eq(odd.providers.fal.factor.steps, [2, 4]) && odd.providers.fal.factor.default === 2, short(odd.providers.fal.factor));
        const plain = recipes._normalize({ kind: "provider", providers: { fal: { model: "fal-ai/flux-2-pro/edit" } } });
        check("an edit recipe keeps task edit, its Generate new shape and no factor", plain.task === "edit" && !!plain.providers.fal.text && plain.providers.fal.factor === undefined, short(plain.providers.fal));
        const def = recipes._normalize({ kind: "provider", task: "upscale", providers: { fal: { model: "x" } } });
        check("without a factor block: 2, 1 to 4", eq({ d: def.providers.fal.factor.default, a: def.providers.fal.factor.min, b: def.providers.fal.factor.max }, { d: 2, a: 1, b: 4 }));
    });

    await section("the ComfyUI upscale recipe (recipes/upscale_model_local.json)", async () => {
        const raw = rawOf("upscale_model_local");
        const r = recipes._normalize(JSON.parse(JSON.stringify(raw)));
        check("it is a ComfyUI recipe (no kind), task upscale, local mode", r.kind === undefined && r.task === "upscale" && r.mode === "local", short({ kind: r.kind, task: r.task, mode: r.mode }));
        check("its model picks the factor: fixed, so the dialog offers none", r.factor && r.factor.fixed === true, short(r.factor));
        check("no providers map was made for it", r.providers === undefined && r.providerIds === undefined);
        const P_ = r.prompt;
        const canvas = P_[r.canvas];
        check("the canvas node is an InpaintCanvas with target_size 0 (the crop at its native size)", canvas && canvas.class_type === "InpaintCanvas" && canvas.inputs.target_size === 0, short(canvas));
        const [rid, rslot] = String(r.result).split(":");
        check("the result is the upscaler's IMAGE", P_[rid] && P_[rid].class_type === "ImageUpscaleWithModel" && rslot === "0", r.result);
        const up = P_[rid];
        check("the upscaler reads the loader's model and the crop's first picture",
            eq(up.inputs.upscale_model, ["loader", 0]) && P_.loader.class_type === "UpscaleModelLoader" && eq(up.inputs.image, ["img0", 0])
            && P_.img0.class_type === "ImageFromBatch" && eq(P_.img0.inputs.image, [r.canvas, 0]) && P_.img0.inputs.batch_index === 0 && P_.img0.inputs.length === 1, short(P_));
        const links = [];
        for (const [id, n] of Object.entries(P_)) for (const [k, v] of Object.entries(n.inputs || {})) if (Array.isArray(v)) links.push([id, k, v[0]]);
        check("every link names a node of the prompt", links.every(([, , to]) => P_[to]), short(links.filter(([, , to]) => !P_[to])));
        const classes = [...new Set(Object.values(P_).map((n) => n.class_type))].sort();
        check("needs lists exactly the node types of the prompt", eq([...r.needs].sort(), classes), short({ needs: r.needs, classes }));
        check("one setting, slot 1: the loader's model_name as Model", r.settings.length === 1 && r.settings[0].index === 1 && r.settings[0].node === "loader" && r.settings[0].input === "model_name" && P_.loader.inputs.model_name === "4x-UltraSharp.pth", short(r.settings));
        const odd = recipes._normalize({ task: "sharpen", prompt: {} });
        check("a ComfyUI recipe with another task is an edit recipe", odd.task === "edit" && odd.factor === undefined, short(odd));
        const none = recipes._normalize({ prompt: {} });
        check("a ComfyUI recipe without a task stays as it was", none.task === undefined && none.factor === undefined, short(none));
    });

    const fal = require(P("electron", "main", "providers", "fal.js"));
    const IMG = pngOf(100, 80, "crop");
    const URI = "data:image/png;base64," + IMG.toString("base64");
    const reqOf = (id, pid, extra = {}) => {
        const r = norm(id);
        const v = r.providers[pid];
        const params = {};
        for (const s of v.settings || []) params[s.key] = s.spec[1] && s.spec[1].default !== undefined ? s.spec[1].default : (Array.isArray(s.spec[0]) ? s.spec[0][0] : undefined);
        Object.assign(params, v.fixed || {});
        return { model: v.model, kind: "upscale", fields: v.fields || null, options: v.options || null, image: IMG, factor: v.factor.fixed ? null : v.factor.default, params, prompt: "", negative: "", seed: 42, references: [], ...extra };
    };

    await section("fal: the upscale bodies (golden)", async () => {
        check("Topaz Precision: picture, factor, png, the model and face row; every auto row left out",
            eq(fal._upscaleInput(reqOf("topaz_precision", "fal")), { image_url: URI, output_format: "png", upscale_factor: 2, model: "Standard V2", face_enhancement: false }),
            short(fal._upscaleInput(reqOf("topaz_precision", "fal"))));
        const numbers = fal._upscaleInput(reqOf("topaz_precision", "fal", { params: { model: "CGI", sharpen: "0.3", denoise: "auto", fix_compression: "0", face_enhancement: true } }));
        check("Topaz Precision: a chosen Sharpen goes out as a number, 0 stays 0, auto stays out",
            numbers.sharpen === 0.3 && numbers.fix_compression === 0 && !("denoise" in numbers) && numbers.model === "CGI", short(numbers));
        check("Topaz Bloom: model, factor 4, creativity as a number",
            eq(fal._upscaleInput(reqOf("topaz_creative", "fal", { factor: 4, params: { model: "Bloom 2", creativity: "5" } })), { image_url: URI, output_format: "png", upscale_factor: 4, model: "Bloom 2", creativity: 5 }));
        check("Topaz Wonder: model and face row",
            eq(fal._upscaleInput(reqOf("topaz_generative", "fal")), { image_url: URI, output_format: "png", upscale_factor: 2, model: "Wonder 3.5", face_enhancement: false }));
        check("Clarity: the prompt and the negative as guidance, the seed, its four rows, no output_format",
            eq(fal._upscaleInput(reqOf("clarity_upscaler", "fal", { prompt: "a stone wall", negative: "blur" })), { image_url: URI, upscale_factor: 2, prompt: "a stone wall", negative_prompt: "blur", seed: 42, creativity: 0.35, resemblance: 0.6, num_inference_steps: 18, guidance_scale: 4 }),
            short(fal._upscaleInput(reqOf("clarity_upscaler", "fal", { prompt: "a stone wall", negative: "blur" }))));
        check("Clarity without a prompt: fal's own default prompt stands (none sent)", !("prompt" in fal._upscaleInput(reqOf("clarity_upscaler", "fal"))));
        check("Clarity with a random seed sends none", !("seed" in fal._upscaleInput(reqOf("clarity_upscaler", "fal", { params: { random_seed: true } }))));
        check("SeedVR2: factor mode, the noise row, the seed, png",
            eq(fal._upscaleInput(reqOf("seedvr2", "fal", { factor: 3 })), { image_url: URI, output_format: "png", upscale_factor: 3, seed: 42, noise_scale: 0.1, upscale_mode: "factor" }));
        for (const id of ["recraft_crisp", "recraft_creative"]) {
            check(`${id}: the picture alone (no factor, no output_format)`, eq(fal._upscaleInput(reqOf(id, "fal")), { image_url: URI }), short(fal._upscaleInput(reqOf(id, "fal"))));
            // fields.factor false: a factor that reaches the adapter anyway (an agent's, a stale dialog's) stays out
            check(`${id}: a factor handed in anyway is not sent`, eq(fal._upscaleInput(reqOf(id, "fal", { factor: 4 })), { image_url: URI }));
        }
        check("Topaz with no prompt sends none even when the tab has one (the recipe decides; the host sends none)", !("prompt" in fal._upscaleInput(reqOf("topaz_precision", "fal"))));
    });

    await section("fal: the queue round trip", async () => {
        const OUT = pngOf(200, 160, "big");
        const s = scripted([
            { match: (c) => c.method === "POST" && c.url === "https://queue.fal.run/topaz/upscale/image/precision", answer: () => ({ request_id: "r1", status: "IN_QUEUE", status_url: "https://queue.fal.run/x/requests/r1/status", response_url: "https://queue.fal.run/x/requests/r1" }) },
            { match: (c) => c.url.endsWith("/status"), answer: (c, n) => ({ status: n < 3 ? "IN_PROGRESS" : "COMPLETED" }) },
            { match: (c) => c.url === "https://queue.fal.run/x/requests/r1", answer: () => ({ image: { url: "https://v3.fal.media/files/out.png", content_type: "image/png", width: 200, height: 160 } }) },
            { match: (c) => c.url === "https://v3.fal.media/files/out.png", answer: () => png(OUT) },
        ]);
        const waits = [];
        const out = await fal.upscale(reqOf("topaz_precision", "fal"), { key: "fal-key-123456", fetch: s.fetch, log: () => {}, sleep: async (ms) => { waits.push(ms); } });
        check("the answer is the result host's bytes", Buffer.compare(Buffer.from(out.bytes), OUT) === 0 && out.info.width === 200 && out.info.factor === 2, short(out.info));
        check("the key goes to fal's queue only, never to the file host", s.calls.filter((c) => c.headers.Authorization).every((c) => c.url.startsWith("https://queue.fal.run/")) && !s.calls.find((c) => c.url.startsWith("https://v3.fal.media")).headers.Authorization);
        check("the status was polled until COMPLETED", s.calls.filter((c) => c.url.endsWith("/status")).length === 3 && waits.length === 3, `${waits.length} waits`);
        const slow = scripted([
            { match: (c) => c.method === "POST", answer: () => ({ status: "IN_QUEUE", status_url: "https://q/s", response_url: "https://q/r" }) },
            { match: () => true, answer: () => ({ status: "IN_QUEUE" }) },
        ]);
        let clock = 0;
        const realNow = Date.now;
        Date.now = () => clock;
        try {
            const t = await throwsWith(() => fal.upscale(reqOf("topaz_precision", "fal"), { key: "k", fetch: slow.fetch, log: () => {}, sleep: async (ms) => { clock += ms * 200; } }), /timed out after 30 minutes/);
            check("an upscale waits 30 minutes in fal's queue, not the edit's 15", t.ok, t.msg);
        } finally { Date.now = realNow; }
        const failed = scripted([
            { match: (c) => c.method === "POST", answer: () => ({ status: "IN_QUEUE", status_url: "https://q/s", response_url: "https://q/r" }) },
            { match: () => true, answer: () => ({ status: "FAILED", error: "image too large" }) },
        ]);
        const f = await throwsWith(() => fal.upscale(reqOf("topaz_precision", "fal"), { key: "k", fetch: failed.fetch, log: () => {}, sleep: async () => {} }), /image too large/);
        check("a failed request says fal's words", f.ok, f.msg);
    });

    await section("Comfy Cloud: the upscaler Partner Nodes (golden graphs)", async () => {
        const cc = require(P("electron", "main", "providers", "comfycloud.js"));
        const OUT = pngOf(400, 320, "cc");
        const run = async (req) => {
            let prompt = null;
            const s = scripted([
                { match: (c) => c.url === "https://cloud.comfy.org/api/upload/image", answer: () => ({ name: "scumble-crop.png", subfolder: "" }) },
                { match: (c) => c.url === "https://cloud.comfy.org/api/prompt", answer: (c) => { prompt = c.body.prompt; return { prompt_id: "p1" }; } },
                { match: (c) => c.url.endsWith("/api/job/p1/status"), answer: () => ({ status: "success" }) },
                { match: (c) => c.url.endsWith("/api/history/p1"), answer: () => ({ p1: { outputs: { 9: { images: [{ filename: "out.png", subfolder: "", type: "output" }] } } } }) },
                { match: (c) => c.url.startsWith("https://cloud.comfy.org/api/view"), answer: () => png(OUT) },
            ]);
            const out = await cc.upscale(req, { key: "cc-key-123456", fetch: s.fetch, log: () => {}, sleep: async () => {} });
            return { out, prompt, calls: s.calls };
        };
        const partner = (g) => Object.values(g).find((n) => n.class_type !== "LoadImage" && n.class_type !== "SaveImage");
        const prec = await run(reqOf("magnific_precision", "comfycloud", { factor: 4, params: { flavor: "sublime", sharpen: 20, smart_grain: 7, ultra_detail: 30 } }));
        check("Magnific Precise V2: the picture, 4x, no downscale on its own, the rows over the defaults",
            eq(partner(prec.prompt), { class_type: "MagnificImageUpscalerPreciseV2Node", inputs: { image: ["1", 0], scale_factor: "4x", auto_downscale: false, flavor: "sublime", sharpen: 20, smart_grain: 7, ultra_detail: 30 } }), short(partner(prec.prompt)));
        check("the graph is LoadImage -> the node -> SaveImage, and the answer is the view's bytes",
            eq(Object.values(prec.prompt).map((n) => n.class_type), ["LoadImage", "MagnificImageUpscalerPreciseV2Node", "SaveImage"]) && Buffer.compare(Buffer.from(prec.out.bytes), OUT) === 0);
        const cre = await run(reqOf("magnific_creative", "comfycloud", { factor: 8, prompt: "wet stones" }));
        check("Magnific Creative: the prompt, 8x, the six rows",
            eq(partner(cre.prompt).inputs, { image: ["1", 0], prompt: "wet stones", scale_factor: "8x", auto_downscale: false, optimized_for: "standard", engine: "automatic", creativity: 0, hdr: 0, resemblance: 0, fractality: 0 }), short(partner(cre.prompt).inputs));
        for (const [id, node] of [["recraft_crisp", "RecraftCrispUpscaleNode"], ["recraft_creative", "RecraftCreativeUpscaleNode"]]) {
            const r = await run(reqOf(id, "comfycloud"));
            check(`${node}: the picture alone`, eq(partner(r.prompt), { class_type: node, inputs: { image: ["1", 0] } }), short(partner(r.prompt)));
        }
        const bad = await throwsWith(() => run(reqOf("magnific_precision", "comfycloud", { factor: 3 })), /2, 4, 8 or 16, not 3/);
        check("Magnific on Comfy Cloud refuses 3x before anything is sent", bad.ok, bad.msg);
        check("the Comfy Cloud variants offer 2, 4, 8, 16 for both Magnific recipes", eq(norm("magnific_precision").providers.comfycloud.factor.steps, [2, 4, 8, 16]) && eq(norm("magnific_creative").providers.comfycloud.factor.steps, [2, 4, 8, 16]));
        // Comfy Router (added later) comes after it where it serves the model: Magnific Precision
        check("Comfy Cloud is the last variant before Comfy Router and the default stays", ["magnific_precision", "magnific_creative", "recraft_crisp", "recraft_creative"].every((id) => { const r = norm(id); const ids = r.providerIds.filter((x) => x !== "comfyrouter" && x !== "oxen"); return ids[ids.length - 1] === "comfycloud" && r.default !== "comfycloud" && r.default !== "comfyrouter"; }));
        check("Comfy Router is the last variant of Magnific Precision, and of no other upscaler", ["magnific_precision", "magnific_creative", "recraft_crisp", "recraft_creative", "topaz_precision", "clarity_upscaler", "seedvr2"].every((id) => { const r = norm(id); return (r.providerIds[r.providerIds.length - 1] === "comfyrouter") === (id === "magnific_precision"); }));
    });

    const mag = require(P("electron", "main", "providers", "magnific.js"));
    const B64 = IMG.toString("base64");
    await section("Magnific: bodies and factors", async () => {
        const prec = mag._body(reqOf("magnific_precision", "magnific"), "image-upscaler-precision-v2");
        check("Precision V2: base64 (no data: prefix), the factor as an integer, its four rows",
            eq(prec, { image: B64, scale_factor: 2, flavor: "photo", sharpen: 7, smart_grain: 7, ultra_detail: 30 }), short(prec));
        const cre = mag._body(reqOf("magnific_creative", "magnific", { factor: 4, prompt: "old brick" }), "image-upscaler");
        check("Creative: the factor as \"4x\", the prompt, its six rows",
            eq(cre, { image: B64, scale_factor: "4x", optimized_for: "standard", engine: "automatic", creativity: 0, hdr: 0, resemblance: 0, fractality: 0, prompt: "old brick" }), short(cre));
        check("Precision sends no prompt even when one is given", !("prompt" in mag._body(reqOf("magnific_precision", "magnific", { prompt: "x" }), "image-upscaler-precision-v2")));
        for (const [route, f, re] of [["image-upscaler", 3, /2, 4, 8 or 16/], ["image-upscaler", 32, /2, 4, 8 or 16/], ["image-upscaler-precision-v2", 1, /2 to 16/], ["image-upscaler-precision-v2", 17, /2 to 16/]]) {
            const t = await throwsWith(() => mag._factor(route, f), re);
            check(`${route} refuses the factor ${f}`, t.ok, t.msg);
        }
        check("16 is the top of both", mag._factor("image-upscaler", 16) === "16x" && mag._factor("image-upscaler-precision-v2", 16) === 16);
    });

    const TEST_KEY = "test-magnific-0123456789";
    const REAL_KEY = "FPSX0123456789abcdef0123";
    const MOCK = "http://127.0.0.1:5577";
    const OUT2 = pngOf(200, 160, "mag");
    const magRoutes = (host, opts = {}) => {
        let polls = 0;
        return [
            { match: (c) => c.method === "POST" && c.url === `${host}/v1/ai/${opts.route || "image-upscaler-precision-v2"}`, answer: () => opts.post ? opts.post() : ({ data: { task_id: "046b6c7f-0b8a-43b9-b35d-6489e6daee91", status: "CREATED", generated: [] } }) },
            { match: (c) => c.method === "GET" && c.url.startsWith(`${host}/v1/ai/`), answer: () => { polls++; return opts.poll ? opts.poll(polls) : ({ data: { task_id: "046b6c7f-0b8a-43b9-b35d-6489e6daee91", status: polls < 2 ? "IN_PROGRESS" : "COMPLETED", generated: polls < 2 ? [] : ["https://ai-statics.freepik.com/out.png"] } }); } },
            { match: (c) => c.url === "https://ai-statics.freepik.com/out.png", answer: () => png(OUT2) },
        ];
    };
    const ctxOf = (s, key, base, extra = {}) => ({ key, base, fetch: s.fetch, log: () => {}, sleep: async (ms) => { (extra.waits || []).push(ms); }, ...extra });
    const ALL_ERRORS = [];

    await section("Magnific: the task round trip", async () => {
        const s = scripted(magRoutes(mag.HOST));
        const waits = [];
        const out = await mag.upscale(reqOf("magnific_precision", "magnific"), ctxOf(s, REAL_KEY, undefined, { waits }));
        check("the answer is the generated picture", Buffer.compare(Buffer.from(out.bytes), OUT2) === 0 && out.info.task === "046b6c7f-0b8a-43b9-b35d-6489e6daee91" && out.info.factor === 2, short(out.info));
        check("POST to the route, then GET <route>/<task id> until COMPLETED",
            eq(s.calls.map((c) => `${c.method} ${c.url}`), [
                "POST https://api.magnific.com/v1/ai/image-upscaler-precision-v2",
                "GET https://api.magnific.com/v1/ai/image-upscaler-precision-v2/046b6c7f-0b8a-43b9-b35d-6489e6daee91",
                "GET https://api.magnific.com/v1/ai/image-upscaler-precision-v2/046b6c7f-0b8a-43b9-b35d-6489e6daee91",
                "GET https://ai-statics.freepik.com/out.png",
            ]), short(s.calls.map((c) => `${c.method} ${c.url}`)));
        check("the key in x-magnific-api-key on Magnific's calls only, never to the picture's host",
            s.calls.slice(0, 3).every((c) => c.headers["x-magnific-api-key"] === REAL_KEY && !c.headers.Authorization) && !s.calls[3].headers["x-magnific-api-key"]);
        check("it waited between the polls", waits.length === 2 && waits.every((w) => w === 3000), short(waits));
        const cre = scripted(magRoutes(mag.HOST, { route: "image-upscaler" }));
        await mag.upscale(reqOf("magnific_creative", "magnific", { factor: 2, prompt: "moss" }), ctxOf(cre, REAL_KEY));
        check("Creative polls its own route", cre.calls[1].url === "https://api.magnific.com/v1/ai/image-upscaler/046b6c7f-0b8a-43b9-b35d-6489e6daee91" && cre.calls[0].body.prompt === "moss");
    });

    await section("Magnific: host and key rules", async () => {
        check("a loopback mock is the only base a setting may name",
            mag._testBase("http://127.0.0.1:5577") === MOCK && mag._testBase("https://evil.example") === null && mag._testBase("http://127.0.0.1:5577/v1") === null && mag._testBase("http://localhost:5577") === null && mag._testBase("http://127.0.0.1") === null);
        check("baseUrl reads settings.magnific.base", mag.baseUrl({ magnific: { base: MOCK } }) === MOCK && mag.baseUrl({}) === null && mag.baseUrl({ magnific: { base: "https://x.example" } }) === null);
        const toMock = scripted(magRoutes(MOCK));
        const t1 = await throwsWith(() => mag.upscale(reqOf("magnific_precision", "magnific"), ctxOf(toMock, REAL_KEY, MOCK)), /only a test key goes there/);
        check("a real key is never sent to the mock", t1.ok && toMock.calls.length === 0, t1.msg);
        const toReal = scripted(magRoutes(mag.HOST));
        const t2 = await throwsWith(() => mag.upscale(reqOf("magnific_precision", "magnific"), ctxOf(toReal, TEST_KEY)), /test key is never sent/);
        check("a test key is never sent to Magnific", t2.ok && toReal.calls.length === 0, t2.msg);
        const mock = scripted(magRoutes(MOCK));
        await mag.upscale(reqOf("magnific_precision", "magnific"), ctxOf(mock, TEST_KEY, MOCK));
        check("a test key reaches the mock", mock.calls[0].url === `${MOCK}/v1/ai/image-upscaler-precision-v2`);
        const t3 = await throwsWith(() => mag.upscale({ ...reqOf("magnific_precision", "magnific"), model: "../mystic" }, ctxOf(scripted([]), REAL_KEY)), /no upscaler route/);
        check("a route outside the two is refused before any request", t3.ok, t3.msg);
    });

    await section("Magnific: refusals and errors", async () => {
        const big = scripted(magRoutes(mag.HOST, { route: "image-upscaler" }));
        const t = await throwsWith(() => mag.upscale(reqOf("magnific_creative", "magnific", { image: pngOf(3000, 2200), factor: 2 }), ctxOf(big, REAL_KEY)), /25\.3 MP cap/);
        check("Creative refuses an answer over 25.3 MP before sending (3000 x 2200 at 2x = 26.4 MP)", t.ok && big.calls.length === 0, t.msg);
        const fits = scripted(magRoutes(mag.HOST, { route: "image-upscaler" }));
        await mag.upscale(reqOf("magnific_creative", "magnific", { image: pngOf(2500, 2500), factor: 2 }), ctxOf(fits, REAL_KEY));
        check("25 MP is let through", fits.calls.length === 4);
        const auth = scripted(magRoutes(mag.HOST, { post: () => json(401, { message: `Invalid API key ${REAL_KEY}` }) }));
        const a = await throwsWith(() => mag.upscale(reqOf("magnific_precision", "magnific"), ctxOf(auth, REAL_KEY)), /key refused/);
        ALL_ERRORS.push(a.msg);
        check("a 401 reads as words, without the key", a.ok && !a.msg.includes(REAL_KEY) && a.msg.includes("[key]"), a.msg);
        const bad = scripted(magRoutes(mag.HOST, { post: () => json(400, { problem: { message: "Validation error", invalid_params: [{ name: "scale_factor", reason: "must be 2..16" }] } }) }));
        const b = await throwsWith(() => mag.upscale(reqOf("magnific_precision", "magnific"), ctxOf(bad, REAL_KEY)), /request refused - Validation error \(scale_factor: must be 2\.\.16\)/);
        check("a 400 names the invalid parameter", b.ok, b.msg);
        const failed = scripted(magRoutes(mag.HOST, { poll: () => ({ data: { task_id: "t-1", status: "FAILED", generated: [] } }) }));
        const f = await throwsWith(() => mag.upscale(reqOf("magnific_precision", "magnific"), ctxOf(failed, REAL_KEY)), /the task failed/);
        check("a FAILED task ends the run", f.ok, f.msg);
        const empty = scripted(magRoutes(mag.HOST, { poll: () => ({ data: { task_id: "t-1", status: "COMPLETED", generated: [] } }) }));
        const e = await throwsWith(() => mag.upscale(reqOf("magnific_precision", "magnific"), ctxOf(empty, REAL_KEY)), /names no picture/);
        check("a COMPLETED task without a picture is an error, not an empty answer", e.ok, e.msg);
        const noid = scripted(magRoutes(mag.HOST, { post: () => ({ data: { status: "CREATED" } }) }));
        const n = await throwsWith(() => mag.upscale(reqOf("magnific_precision", "magnific"), ctxOf(noid, REAL_KEY)), /no task id/);
        check("an answer without a task id is an error", n.ok, n.msg);
        const odd = scripted(magRoutes(mag.HOST, { post: () => ({ data: { task_id: "../../v1/stock", status: "CREATED" } }) }));
        const o = await throwsWith(() => mag.upscale(reqOf("magnific_precision", "magnific"), ctxOf(odd, REAL_KEY)), /unexpected task id/);
        check("a task id that is not an id is never put into a URL", o.ok && odd.calls.length === 1, o.msg);
        let clock = 0;
        const slow = scripted(magRoutes(mag.HOST, { poll: () => ({ data: { task_id: "t-1", status: "IN_PROGRESS" } }) }));
        const w = await throwsWith(() => mag.upscale(reqOf("magnific_precision", "magnific"), ctxOf(slow, REAL_KEY, undefined, { now: () => clock, sleep: async (ms) => { clock += ms * 100; } })), /no answer after 30 minutes/);
        check("a task that never ends gives up after 30 minutes", w.ok, w.msg);
    });

    await section("Magnific: rate limits", async () => {
        let n = 0;
        const once = scripted(magRoutes(mag.HOST, { post: () => (++n === 1 ? json(429, { message: "Too many requests" }, { "retry-after": "2" }) : { data: { task_id: "t-2", status: "COMPLETED", generated: ["https://ai-statics.freepik.com/out.png"] } }) }));
        const waits = [];
        await mag.upscale(reqOf("magnific_precision", "magnific"), ctxOf(once, REAL_KEY, undefined, { waits }));
        check("a 429 is sent once more, after the Retry-After", once.calls.filter((c) => c.method === "POST").length === 2 && waits[0] === 2000, short(waits));
        const far = scripted(magRoutes(mag.HOST, { post: () => json(429, { message: "slow down" }, { "retry-after": "120" }) }));
        const f = await throwsWith(() => mag.upscale(reqOf("magnific_precision", "magnific"), ctxOf(far, REAL_KEY)), /rate limited - slow down; try again in 120 s/);
        check("a Retry-After past a minute is not waited for", f.ok && far.calls.length === 1, f.msg);
        const twice = scripted(magRoutes(mag.HOST, { post: () => json(503, { message: "Service Unavailable. Please try again later." }) }));
        const t = await throwsWith(() => mag.upscale(reqOf("magnific_precision", "magnific"), ctxOf(twice, REAL_KEY)), /the service failed/);
        check("a second 503 is the answer (one retry only)", t.ok && twice.calls.length === 2, t.msg);
    });

    await section("providers/index.js dispatches kind upscale", async () => {
        const keysPath = P("electron", "main", "keys.js");
        const settingsPath = P("electron", "main", "settings.js");
        const logPath = P("electron", "main", "log.js");
        require.cache[keysPath] = { id: keysPath, filename: keysPath, loaded: true, exports: { get: (id) => (id === "fal" ? "fal-key-123456" : ""), describe: () => ({ set: true }) } };
        require.cache[settingsPath] = { id: settingsPath, filename: settingsPath, loaded: true, exports: { get: () => ({}) } };
        const logged = [];
        require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: { record: (e) => logged.push(e) } };
        const index = withElectron(() => require(P("electron", "main", "providers", "index.js")));
        check("fal, Magnific, Comfy Cloud, Comfy Router, Oxen.ai and loopback have an upscaler, nothing else", eq(index.upscaleProviders().sort(), ["comfycloud", "comfyrouter", "fal", "loopback", "magnific", "oxen"]), short(index.upscaleProviders()));
        const t = await throwsWith(() => index.edit({ provider: "bfl", kind: "upscale", model: "x", image: IMG }), /has no upscaler/);
        check("a provider without an upscaler is refused by name", t.ok, t.msg);
        const k = await throwsWith(() => index.edit({ provider: "magnific", kind: "upscale", model: "image-upscaler", image: IMG, factor: 2 }), /No API key for Magnific/);
        check("no Magnific key: the key row is named", k.ok, k.msg);
        let got = null;
        const orig = index.PROVIDERS.fal.upscale;
        index.PROVIDERS.fal.upscale = async (req) => { got = req; return { bytes: pngOf(8, 8), mime: "image/png", info: { width: 8 } }; };
        try {
            const out = await index.edit({ provider: "fal", kind: "upscale", model: "topaz/upscale/image/precision", image: new Uint8Array(IMG), factor: 4, params: { model: "CGI" } });
            check("kind upscale reaches the adapter's upscale with the factor and a Buffer", got && got.factor === 4 && Buffer.isBuffer(got.image) && out.bytes.length === 64);
            const line = logged.find((e) => /upscale ok/.test(e.message));
            check("the log line says upscale and carries the factor, never the pixels", !!line && logged.some((e) => e.message.startsWith("fal.ai upscale ok")), short(logged.map((e) => e.message)));
        } finally { index.PROVIDERS.fal.upscale = orig; }
    });

    await section("the assistant's policy", async () => {
        const policy = require(P("electron", "main", "assistant", "policy.js"));
        const sel = policy.decide({ name: "upscale", args: { doc: 1, scope: "selection" } }, { tools: new Set(["upscale"]) });
        const doc = policy.decide({ name: "upscale", args: { doc: 1, scope: "document" } }, { tools: new Set(["upscale"]) });
        check("upscale asks (it costs money), with its own reason per scope", sel.action === "ask" && doc.action === "ask" && /selection/.test(sel.reason) && /whole picture/.test(doc.reason), `${sel.reason} | ${doc.reason}`);
        check("upscale is a run: a busy document refuses it", policy.decide({ name: "upscale", args: {} }, { tools: new Set(["upscale"]), busy: true }).action === "refuse");
        check("its timeout defaults to 30 minutes", policy.clamp({ name: "upscale", args: {} }).args.timeout === 1800);
        check("the selection's upscale gets a layers step, the whole picture's none (it pushes its own)",
            policy.undoStep({ name: "upscale", args: { scope: "selection" } }) === "layers" && policy.undoStep({ name: "upscale", args: { scope: "document" } }) === null && policy.undoStep({ name: "upscale", args: {} }) === "layers");
    });

    await section("the key never leaks", async () => {
        check("no error of the run carries a key", ALL_ERRORS.every((m) => !m.includes(REAL_KEY) && !m.includes(TEST_KEY)));
    });

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); console.log("FAIL"); process.exit(1); });
