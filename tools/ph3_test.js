// P-H3-Image on WaveSpeedAI (recipes/p_h3_image.json through electron/main/providers/wavespeed.js, docs/PLAN_PH3.md), in
// plain Node, no Electron, no key and no network:
//   node tools/ph3_test.js
// A scripted fetch plays api.wavespeed.ai (the upload ticket, the presigned PUT, the submit, the download) and records
// every request. The light tier (CLAUDE.md "Working rules"): the request shapes written from WaveSpeed's schema of
// wavespeed-ai/p-h3-image/edit and /text-to-image (read 2026-11-06: prompt; images, 1 to 9, the first edited;
// aspect_ratio of fifteen; resolution 1k / 1.5k / 2k / 3k / 4k; output_format; seed; additionalProperties false), never
// run against the live API. Also the recipe as normalize() serves it (the text route, its references' edit route),
// and the local recipe (recipes/p_h3_image_local.json, §3) against the node specs of tools/refs/comfy_templates/
// object_info.json: input names, combo values, ranges, links, Pruna AI's model values pinned.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const ws = require(path.join(ROOT, "electron", "main", "providers", "wavespeed.js"));

const KEY = "ws_" + "0".repeat(32);   // never a real key
const API = "https://api.wavespeed.ai/api/v3/";
const PUT = "https://put.wavespeed.test/";
const CDN = "https://cdn.wavespeed.test/";
const OUT = CDN + "out.png";
const EDIT = "wavespeed-ai/p-h3-image/edit";
const TEXT = "wavespeed-ai/p-h3-image/text-to-image";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
// the schema's fields (additionalProperties false): nothing else may go
const EDIT_FIELDS = ["prompt", "images", "aspect_ratio", "resolution", "output_format", "seed"];
const TEXT_FIELDS = ["prompt", "aspect_ratio", "resolution", "output_format", "seed"];

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 400 ? s.slice(0, 400) + " ..." : s; };
async function section(name, fn) {
    console.log(`\n--- ${name} ---`);
    try { await fn(); } catch (err) { check(`${name}: ran through`, false, (err && err.stack) || String(err)); }
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeWaveSpeed() {
    const calls = [], submits = [], puts = [];
    const pending = new Map();
    let k = 0;
    async function fetch(url, init = {}) {
        const method = String(init.method || "GET").toUpperCase();
        const u = new URL(String(url));
        calls.push({ method, url: String(url), auth: (init.headers || {}).Authorization || (init.headers || {}).authorization || null });
        if (u.origin === "https://api.wavespeed.ai" && method === "POST" && u.pathname === "/api/v3/media/uploads") {
            const n = ++k, put = `${PUT}u${n}`, dl = `${CDN}media/u${n}`;
            pending.set(put, dl);
            return json(200, { code: 200, data: { download_url: dl, upload: { url: put, method: "PUT" } } });
        }
        if (method === "PUT" && pending.has(String(url))) {
            puts.push(pending.get(String(url)));
            pending.delete(String(url));
            return new Response(null, { status: 200 });
        }
        if (u.origin === "https://api.wavespeed.ai" && method === "POST") {
            submits.push({ model: u.pathname.slice("/api/v3/".length), body: JSON.parse(init.body) });
            return json(200, { code: 200, data: { id: "p1", status: "completed", outputs: [OUT], urls: { get: `${API}predictions/p1/result` }, timings: { inference: 900 } } });
        }
        if (String(url) === OUT) return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
        return json(404, { code: 404, message: `not played by this test: ${method} ${url}` });
    }
    return { fetch, calls, submits, puts };
}

async function run(req) {
    const s = fakeWaveSpeed();
    const ctx = { key: KEY, fetch: s.fetch, log: () => {} };
    let out = null, err = null;
    try { out = await (req.kind === "text" ? ws.generate(req, ctx) : ws.edit(req, ctx)); } catch (e) { err = String((e && e.message) || e); }
    return { s, out, err, sub: s.submits[0] || null };
}

let NORMALIZE = null;
function loadRecipe(id) {
    if (!NORMALIZE) {
        const orig = Module._load;
        Module._load = function (request, ...rest) {
            if (request === "electron") return { app: { getPath: () => ROOT } };
            return orig.call(this, request, ...rest);
        };
        try { NORMALIZE = require(path.join(ROOT, "electron", "main", "recipes.js"))._normalize; } finally { Module._load = orig; }
    }
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, "recipes", id + ".json"), "utf8"));
    return NORMALIZE(r);
}
/** The Settings rows at their defaults (host.js providerParams). */
const defaults = (rows) => Object.fromEntries((rows || []).map((s) => [s.key, s.spec[1].default]));
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- a graph against the node list's specs (tools/refs/comfy_templates/object_info.json) ----------------------------
// A combo of model files is not checked (the saved list is one machine's folder); every other combo, number, text and
// switch is, and a link must name a node of the graph. Both spec shapes: the old ([options], {...}) and V3's
// ("COMBO", { options }), a growing input (COMFY_AUTOGROW_V3: "images.image_1" ... by its template's names) and a
// dynamic combo (COMFY_DYNAMICCOMBO_V3: its value one of the options' keys, the chosen option's inputs as "name.sub").
const MODEL_FILE = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx)$/i;
function specKind(spec) {
    const [t, o = {}] = Array.isArray(spec) ? spec : [spec];
    if (Array.isArray(t)) return { kind: "combo", options: t };
    if (t === "COMBO") return { kind: "combo", options: o.options || [] };
    if (t === "COMFY_AUTOGROW_V3") return { kind: "grow", names: (o.template && o.template.names) || [] };
    if (t === "COMFY_DYNAMICCOMBO_V3") return { kind: "dyn", options: o.options || [] };
    if (t === "INT" || t === "FLOAT" || t === "STRING" || t === "BOOLEAN") return { kind: t, o };
    return { kind: "socket" };
}
function specProblems(g, info) {
    const out = [];
    const isLink = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && Number.isInteger(v[1]);
    for (const [id, n] of Object.entries(g)) {
        const decl = info[n.class_type] && info[n.class_type].input;
        if (!decl) continue;
        const ins = n.inputs || {};
        const known = new Map();
        for (const [k, spec] of Object.entries({ ...(decl.required || {}), ...(decl.optional || {}) })) {
            const s = specKind(spec);
            if (s.kind === "grow") { for (const name of s.names) known.set(`${k}.${name}`, { kind: "socket" }); continue; }
            known.set(k, s);
            if (s.kind !== "dyn") continue;
            const chosen = s.options.find((x) => x.key === ins[k]);
            const sub = (chosen && chosen.inputs) || {};
            for (const [sk, sspec] of Object.entries({ ...(sub.required || {}), ...(sub.optional || {}) })) known.set(`${k}.${sk}`, specKind(sspec));
            for (const sk of Object.keys(sub.required || {})) if (!(`${k}.${sk}` in ins)) out.push(`${id}.${k}.${sk} missing`);
        }
        for (const [k, spec] of Object.entries(decl.required || {})) if (specKind(spec).kind !== "grow" && !(k in ins)) out.push(`${id}.${k} missing`);
        for (const [k, v] of Object.entries(ins)) {
            const s = known.get(k);
            if (!s) { out.push(`${id}.${k} unknown to ${n.class_type}`); continue; }
            if (isLink(v)) { if (!g[v[0]]) out.push(`${id}.${k} links to ${v[0]}, no node of the graph`); continue; }
            if (s.kind === "socket") out.push(`${id}.${k} is no link`);
            else if (s.kind === "combo") { if (!s.options.some((x) => MODEL_FILE.test(String(x))) && !s.options.includes(v)) out.push(`${id}.${k}=${JSON.stringify(v)} not among its options`); }
            else if (s.kind === "dyn") { if (!s.options.some((x) => x.key === v)) out.push(`${id}.${k}=${JSON.stringify(v)} not among its options`); }
            else if (s.kind === "INT" || s.kind === "FLOAT") {
                const okType = s.kind === "INT" ? Number.isInteger(v) : typeof v === "number" && Number.isFinite(v);
                if (!okType || (s.o.min !== undefined && v < s.o.min) || (s.o.max !== undefined && v > s.o.max)) out.push(`${id}.${k}=${JSON.stringify(v)} out of range or no ${s.kind}`);
            } else if (s.kind === "STRING" && typeof v !== "string") out.push(`${id}.${k} is no text`);
            else if (s.kind === "BOOLEAN" && typeof v !== "boolean") out.push(`${id}.${k} is no boolean`);
        }
    }
    return out;
}

async function main() {
    const warned = [];
    const warn = console.warn;
    console.warn = (...a) => warned.push(a.join(" "));
    let R;
    try { R = loadRecipe("p_h3_image"); } finally { console.warn = warn; }
    const V = R.providers.wavespeed;

    await section("0. the recipe", async () => {
        check("p_h3_image: a provider recipe, WaveSpeed its default, an edit on wavespeed-ai/p-h3-image/edit, <Picture {n}>, read without a warning",
            R.kind === "provider" && R.default === "wavespeed" && R.task === "edit" && V.model === EDIT && V.input === "edit" && V.refs && V.refs.name === "<Picture {n}>" && !warned.length, short({ model: V.model, refs: V.refs, warned }));
        check("options: nine pictures, fifteen aspects, the edit's allowlist without aspect_ratio, the text route's with it, five tiers",
            V.options.max_images === 9 && V.options.aspect_ratios.length === 15 && eq(V.options.accepts, ["resolution", "output_format", "seed"])
            && eq(V.options.text_accepts, ["aspect_ratio", "resolution", "output_format", "seed"]) && eq(Object.keys(V.options.tiers), ["1k", "1.5k", "2k", "3k", "4k"]), short(V.options));
        check("one Settings row: Resolution, 1k to 4k, 2k by default (about 4 MP, Pruna AI's edit size)",
            V.settings.length === 1 && V.settings[0].key === "resolution" && eq(V.settings[0].spec[0], ["1k", "1.5k", "2k", "3k", "4k"]) && V.settings[0].spec[1].default === "2k", short(V.settings));
        check("the text route: wavespeed-ai/p-h3-image/text-to-image, references go to the edit route",
            V.text && V.text.model === TEXT && V.text.refs && V.text.refs.model === EDIT && eq(V.text.sizes, [1024, 1536, 2048, 3072, 4096]), short(V.text));
        check("the description carries the licence line and Powered by MiniMax H3",
            /Powered by MiniMax H3\./.test(R.description) && R.description.includes("P-H3-Image is under the MiniMax H3 Community License, which does not cover use in the EU, the UK, South Korea or the US without a separate licence from MiniMax (platform.minimax.io/h3-license).") && /not run against the live API yet/.test(R.description));
    });

    const base = { provider: "wavespeed", negative: "blurry", seed: 4242, aspect: null, mask: null, maskAlpha: null, original: 0, fields: V.fields || null, options: V.options, params: defaults(V.settings) };

    await section("1. an edit: the crop and two reference layers", async () => {
        const x = await run({ ...base, model: EDIT, kind: "edit", prompt: "put the hat of <Picture 2> on the person", width: 1024, height: 768, image: PNG, references: [PNG, PNG] });
        const b = x.sub && x.sub.body;
        check("three uploads, one submit to .../wavespeed-ai/p-h3-image/edit, the download", !x.err && x.s.puts.length === 3 && x.s.submits.length === 1 && x.sub.model === EDIT, x.err || short(x.s.calls.map((c) => `${c.method} ${c.url}`)));
        check("images: the crop first, then the references, as the upload URLs", !!b && eq(b.images, [`${CDN}media/u1`, `${CDN}media/u2`, `${CDN}media/u3`]), short(b && b.images));
        check("the prompt as written, resolution 2k, the seed, output_format png", !!b && b.prompt === "put the hat of <Picture 2> on the person" && b.resolution === "2k" && b.seed === 4242 && b.output_format === "png", short(b));
        check("no aspect_ratio (the edit follows the first picture), no negative_prompt, nothing the schema lacks", !!b && !("aspect_ratio" in b) && !("negative_prompt" in b) && Object.keys(b).every((k) => EDIT_FIELDS.includes(k)), short(Object.keys(b || {})));
        check("the key on every API call, never on the PUT or the download; the answer's seed and model", x.s.calls.every((c) => (c.url.startsWith(API) ? c.auth === "Bearer " + KEY : !c.auth)) && x.out && x.out.seed === 4242 && x.out.info.model === EDIT, short(x.out && x.out.info));
        const h = await run({ ...base, model: EDIT, kind: "edit", prompt: "x", width: 1024, height: 1024, image: PNG, references: [], params: { resolution: "4k" } });
        check("the Resolution row goes as it is (4k)", !h.err && h.sub.body.resolution === "4k" && eq(h.sub.body.images, [`${CDN}media/u1`]), h.err || short(h.sub && h.sub.body));
        const many = await run({ ...base, model: EDIT, kind: "edit", prompt: "x", width: 1024, height: 1024, image: PNG, references: Array(9).fill(PNG) });
        check("ten pictures (the crop and nine references) refused before any upload", !!many.err && /at most 9 pictures/.test(many.err) && !many.s.calls.length, many.err);
    });

    await section("2. a new image", async () => {
        const x = await run({ ...base, model: TEXT, kind: "text", prompt: "a neon sign that says \"OPEN\"", width: 2048, height: 1152, image: null, references: [] });
        const b = x.sub && x.sub.body;
        check("one submit to .../wavespeed-ai/p-h3-image/text-to-image, no upload", !x.err && x.s.submits.length === 1 && x.sub.model === TEXT && !x.s.puts.length, x.err || short(x.s.calls.map((c) => `${c.method} ${c.url}`)));
        check("aspect_ratio 16:9 (the preset closest to 2048 x 1152), resolution 2k, the seed, png; no images, no negative_prompt, nothing the schema lacks",
            !!b && b.aspect_ratio === "16:9" && b.resolution === "2k" && b.seed === 4242 && b.output_format === "png" && !("images" in b) && !("negative_prompt" in b) && Object.keys(b).every((k) => TEXT_FIELDS.includes(k)), short(b));
        const tall = await run({ ...base, model: TEXT, kind: "text", prompt: "x", width: 1024, height: 2389, image: null, references: [] });
        check("a tall canvas (1024 x 2389) goes as 9:21", !tall.err && tall.sub.body.aspect_ratio === "9:21", tall.err || short(tall.sub && tall.sub.body));
        const noRow = await run({ ...base, model: TEXT, kind: "text", prompt: "x", width: 3072, height: 3072, image: null, references: [], params: {} });
        check("without the row the tier comes from the size (3072 a side: 3k)", !noRow.err && noRow.sub.body.resolution === "3k", noRow.err || short(noRow.sub && noRow.sub.body));
        const refs = await run({ ...base, model: EDIT, kind: "text", prompt: "<Picture 1> on a beach", width: 1024, height: 1024, image: null, references: [PNG, PNG] });
        const rb = refs.sub && refs.sub.body;
        check("with two reference layers: the edit route, the references alone as images (the first is <Picture 1>), the aspect kept",
            !refs.err && refs.sub.model === EDIT && eq(rb.images, [`${CDN}media/u1`, `${CDN}media/u2`]) && rb.aspect_ratio === "1:1" && Object.keys(rb).every((k) => EDIT_FIELDS.includes(k)), refs.err || short(rb));
    });

    // the local graph has never run (docs/PLAN_PH3.md §4): every node against the spec its class has in the saved node
    // list, so a renamed input or a value outside its range shows here, and Pruna AI's model values pinned, so a value
    // reset to the node's default shows too
    await section("3. the local graph against its node specs", async () => {
        const info = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "refs", "comfy_templates", "object_info.json"), "utf8"));
        const C = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "comfyprompt.js")).href);
        let L;
        const before = warned.length;
        console.warn = (...a) => warned.push(a.join(" "));
        try { L = loadRecipe("p_h3_image_local"); } finally { console.warn = warn; }
        const g = L.prompt;
        check("p_h3_image_local read without a warning, its upsampler, newImage and loras kept", warned.length === before && !!L.upsampler && !!L.newImage && !!L.loras, short(warned.slice(before)));
        const lacking = Object.entries(g).filter(([, n]) => !info[n.class_type]).map(([id, n]) => `${id} ${n.class_type}`);
        check("every class of the graph but the canvas node's has its spec in the node list", eq(lacking, ["canvas InpaintCanvas"]), short(lacking));
        const probs = specProblems(g, info);
        check("every node: its required inputs there, every input one its class declares (a growing input's names, a dynamic combo's options), combos in their options (model files aside), numbers in range, links to nodes of the graph",
            !probs.length, short(probs));
        // what a run queues: Generate new with the upsampler on (the conditioning without image_1, the run without its
        // pictures) and an edit with the upsampler off (its nodes gone, the switch's side wired in)
        const t2i = clone(g);
        C.dropForNewImage(t2i, L);
        C.wireUpsampler(t2i, L, { text: "x", fresh: true, refsGo: false, aspect: "16:9", files: null, classes: null });
        const off = clone(g);
        off.up_switch.inputs.switch = false;
        C.wireUpsampler(off, { ...L, prompt: off }, { text: "x", files: null, classes: null });
        const tp = specProblems(t2i, info), op = specProblems(off, info);
        check("the queued shapes hold too: Generate new with the upsampler (no image_1, no picture on the run), an edit with the upsampler off",
            !tp.length && !op.length && !("images.image_1" in t2i.cond.inputs) && !("images.image1" in t2i.up_run.inputs) && !off.up_run && eq(off.cond.inputs.prompt, ["canvas", 7]), short({ tp, op }));
        // Pruna AI's values, pinned (the node defaults differ: shift 12 / 3, sigmas "1, 0.5", strength 1, type stable_diffusion)
        const sigmas = "1.0, 0.984753, 0.967905, 0.951688, 0.925372, 0.881923, 0.810083, 0.528718, 0.0";
        const pins = [
            ["shift.shift_video", g.shift.inputs.shift_video, 1], ["shift.shift_audio", g.shift.inputs.shift_audio, 1], ["shift.model", g.shift.inputs.model, ["lora", 0]],
            ["sigmas.sigmas", g.sigmas.inputs.sigmas, sigmas], ["lora.strength_model", g.lora.inputs.strength_model, 1], ["lora.model", g.lora.inputs.model, ["unet", 0]],
            ["clip.type", g.clip.inputs.type, "minimax"], ["up_clip.type", g.up_clip.inputs.type, "minimax"], ["sampler.sampler_name", g.sampler.inputs.sampler_name, "euler"],
            ["run.latent_image", g.run.inputs.latent_image, ["cond", 1]], ["run.sigmas", g.run.inputs.sigmas, ["sigmas", 0]], ["guider.model", g.guider.inputs.model, ["shift", 0]],
            ["guider.conditioning", g.guider.inputs.conditioning, ["cond", 0]], ["scale0.resolution_steps", g.scale0.inputs.resolution_steps, 32], ["scale0.megapixels", g.scale0.inputs.megapixels, 4],
            ["cond.width", g.cond.inputs.width, ["size", 0]], ["cond.height", g.cond.inputs.height, ["size", 1]], ["cond.images.image_1", g.cond.inputs["images.image_1"], ["scale0", 0]],
            ["decode.samples", g.decode.inputs.samples, ["run", 0]], ["noise.noise_seed", g.noise.inputs.noise_seed, ["canvas", 10]],
        ];
        const off2 = pins.filter(([, got, want]) => !eq(got, want)).map(([k, got]) => `${k}=${JSON.stringify(got)}`);
        check("Pruna AI's values: shift 1 / 1 after the LoRA, the eight sigmas, the LoRA at 1, both text encoders type minimax, euler, the latent from the conditioning, the size from the scaled crop in steps of 32 at 4 MP",
            !off2.length && (sigmas.match(/,/g) || []).length === 8, short(off2));
        // the check itself: the renames and resets a reviewer named are caught
        const bad = clone(g);
        bad.shift.inputs.video_shift = bad.shift.inputs.shift_video;
        delete bad.shift.inputs.shift_video;
        bad.run.inputs.latent = bad.run.inputs.latent_image;
        delete bad.run.inputs.latent_image;
        bad.clip.inputs.type = "minimax_h3";
        bad.scale0.inputs.megapixels = 40;
        bad.cond.inputs["images.image_10"] = ["img7", 0];
        bad.guider.inputs.model = ["nope", 0];
        const caught = specProblems(bad, info).join(" | ");
        check("the spec check itself: a renamed input (shift_video, latent_image), a combo value outside its options, a number out of range, a tenth picture input (images.image_10, the node grows to nine) and a link to no node are each caught",
            ["shift.shift_video missing", "shift.video_shift unknown", "run.latent_image missing", "run.latent unknown", "clip.type", "scale0.megapixels", "cond.images.image_10 unknown", "guider.model links"].every((s) => caught.includes(s)), caught);
    });

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
