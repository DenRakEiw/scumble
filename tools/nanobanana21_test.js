// Nano Banana 2.1 on Google's own API (recipes/nano_banana_2_1.json through electron/main/providers/gemini.js), in plain
// Node, no Electron, no key and no network:
//   node tools/nanobanana21_test.js
// A scripted fetch plays generativelanguage.googleapis.com: it records each request and answers with the parts a test
// hands it. The light tier (CLAUDE.md "Working rules"): the request shapes written from Google's image generation page
// (docs/PLAN_0_1_43.md §3, N1), never run against the live API. Sections 4 and 5 hold Nano Banana 2 to what it sent
// before the Thinking setting and the per-variant ratios existed, and pin the "512" size class of 3.1 Flash Image.
// Section 6 (N2) the other hosts where 2.1 adds something: fal's thinking_level by name, Comfy Router's upper-case
// thinkingConfig and its own ratios, Comfy Cloud's node option and Thinking, WaveSpeed's text-to-image route; the
// first request each adapter sends is captured and the run stopped. OpenRouter and ToAPIs are built by their own tests.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const gemini = require(path.join(ROOT, "electron", "main", "providers", "gemini.js"));

const KEY = "AIza" + "0".repeat(35);   // the shape of an AI Studio key; never a real one
const BASE = "https://generativelanguage.googleapis.com/v1beta/models/";

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 400 ? s.slice(0, 400) + " ..." : s; };
async function section(name, fn) {
    console.log(`\n--- ${name} ---`);
    try { await fn(); } catch (err) { check(`${name}: ran through`, false, err && err.stack || String(err)); }
}
async function thrown(fn) { try { await fn(); return null; } catch (err) { return String(err && err.message || err); } }

const recipe = JSON.parse(fs.readFileSync(path.join(ROOT, "recipes", "nano_banana_2_1.json"), "utf8"));
const nb2 = JSON.parse(fs.readFileSync(path.join(ROOT, "recipes", "nano_banana_2.json"), "utf8"));
const variant = recipe.providers.gemini;
/** The params the editor sends: each setting at its default, then `over`. */
function paramsOf(v, over = {}) {
    const p = { model: v.model };
    for (const s of v.settings || []) p[s.key] = s.spec[1].default;
    return { ...p, ...over };
}
const pic = (tag) => Buffer.from(`png:${tag}`);
const png64 = (tag) => Buffer.from(`png:${tag}`).toString("base64");

/** A fake fetch: records every call, answers with `parts` (default: one final picture). */
function fakeFetch(parts) {
    const calls = [];
    const fetch = async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        const answer = { candidates: [{ content: { parts: parts || [{ inlineData: { mimeType: "image/png", data: png64("final") } }] }, finishReason: "STOP" }] };
        return { ok: true, status: 200, json: async () => answer, text: async () => JSON.stringify(answer) };
    };
    return { fetch, calls };
}
const run = (req, parts) => {
    const f = fakeFetch(parts);
    return gemini.edit(req, { fetch: f.fetch, key: KEY }).then((out) => ({ out, call: f.calls[0], calls: f.calls }));
};
const fillReq = (over = {}) => ({
    kind: "fill", prompt: "a red door", image: pic("crop"), mask: pic("mask"), references: [], width: 1024, height: 768,
    params: paramsOf(variant), options: variant.options, model: variant.model, ...over,
});

(async () => {
    await section("1. the recipe", async () => {
        check("id, name, family, default gemini", recipe.id === "nano_banana_2_1" && recipe.name === "Nano Banana 2.1" && recipe.family === "Google" && recipe.default === "gemini");
        check("refs as Nano Banana 2 (image {n})", eq(recipe.refs, nb2.refs), short(recipe.refs));
        check("model gemini-nano-banana-2.1, input fill, 14 pictures", variant.model === "gemini-nano-banana-2.1" && variant.input === "fill" && variant.options.max_images === 14);
        const set = Object.fromEntries(variant.settings.map((s) => [s.key, s.spec]));
        const RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];
        check("Aspect: auto and the 14 ratios of Google's page", eq([...set.aspect_ratio[0]].sort(), ["auto", ...RATIOS].sort()) && set.aspect_ratio[1].default === "auto", short(set.aspect_ratio));
        check("options.ratios: the same 14", eq([...variant.options.ratios].sort(), [...RATIOS].sort()));
        check("Size: auto, 1K, 2K, 4K (no 512), default 2K", eq(set.image_size[0], ["auto", "1K", "2K", "4K"]) && set.image_size[1].default === "2K", short(set.image_size));
        check("Thinking: minimal, medium, high, default medium", eq(set.thinking_level[0], ["minimal", "medium", "high"]) && set.thinking_level[1].default === "medium", short(set.thinking_level));
        check("the text shape takes references", variant.text && eq(variant.text.refs, {}));
    });

    await section("2. the requests", async () => {
        const { call } = await run(fillReq());
        check("an edit goes to v1beta's generateContent of the model", call.url === `${BASE}gemini-nano-banana-2.1:generateContent`, call.url);
        check("the key goes as x-goog-api-key", call.init.headers["x-goog-api-key"] === KEY);
        const gc = call.body.generationConfig;
        check("responseModalities IMAGE", eq(gc.responseModalities, ["IMAGE"]));
        check("imageConfig: Size 2K, no aspect on auto", eq(gc.imageConfig, { imageSize: "2K" }), short(gc.imageConfig));
        check("thinkingConfig: Medium (the default), no includeThoughts", eq(gc.thinkingConfig, { thinkingLevel: "Medium" }), short(gc.thinkingConfig));
        const parts = call.body.contents[0].parts;
        check("parts: the text, then label + crop, label + mask", parts.length === 5 && typeof parts[0].text === "string" && parts[2].inline_data.data === png64("crop") && parts[4].inline_data.data === png64("mask"), short(parts.map((x) => Object.keys(x)[0])));

        const hi = await run(fillReq({ params: paramsOf(variant, { thinking_level: "high", aspect_ratio: "8:1", image_size: "4K" }) }));
        check("Thinking high goes as High", eq(hi.call.body.generationConfig.thinkingConfig, { thinkingLevel: "High" }));
        check("Aspect 8:1 and Size 4K go in imageConfig", eq(hi.call.body.generationConfig.imageConfig, { aspectRatio: "8:1", imageSize: "4K" }), short(hi.call.body.generationConfig.imageConfig));
        const lo = await run(fillReq({ params: paramsOf(variant, { thinking_level: "minimal" }) }));
        check("Thinking minimal goes as Minimal", eq(lo.call.body.generationConfig.thinkingConfig, { thinkingLevel: "Minimal" }));

        const text = await run({ kind: "text", prompt: "a lighthouse", references: [], width: 2048, height: 512, aspect: "4:1", params: paramsOf(variant, { image_size: "auto" }), options: variant.options, model: variant.model });
        const tb = text.call.body;
        check("a text run sends the prompt alone", tb.contents[0].parts.length === 1 && tb.contents[0].parts[0].text === "a lighthouse", short(tb.contents[0].parts));
        // Size auto sends no class (Google's default 1K), as every Gemini variant does today
        check("a text run on Size auto: the asked 4:1, no size class", eq(tb.generationConfig.imageConfig, { aspectRatio: "4:1" }), short(tb.generationConfig.imageConfig));
        const sized = await run({ kind: "text", prompt: "a lighthouse", references: [], width: 2048, height: 512, aspect: "4:1", params: paramsOf(variant, { image_size: "4K" }), options: variant.options, model: variant.model });
        check("a text run on Size 4K sends 4K", eq(sized.call.body.generationConfig.imageConfig, { aspectRatio: "4:1", imageSize: "4K" }), short(sized.call.body.generationConfig.imageConfig));
        check("a text run sends the Thinking level", eq(tb.generationConfig.thinkingConfig, { thinkingLevel: "Medium" }));

        // a text run with references and no asked aspect: the closest of the variant's ratios, 8:1 included
        const wide = await run({ kind: "text", prompt: "a banner", references: [pic("r0")], width: 4096, height: 520, params: paramsOf(variant, { image_size: "auto" }), options: variant.options, model: variant.model });
        check("a free-size text run with references takes the closest of the variant's ratios (8:1)", wide.call.body.generationConfig.imageConfig.aspectRatio === "8:1", short(wide.call.body.generationConfig.imageConfig));
    });

    await section("3. the cap of 14 pictures", async () => {
        const refs = (n) => Array.from({ length: n }, (_, i) => pic(`r${i}`));
        const ok = await run(fillReq({ references: refs(12) }));
        const sent = ok.call.body.contents[0].parts.filter((x) => x.inline_data).length;
        check("crop + mask + 12 references (14) go", sent === 14, String(sent));
        const f = fakeFetch();
        const err = await thrown(() => gemini.edit(fillReq({ references: refs(13) }), { fetch: f.fetch, key: KEY }));
        check("15 pictures are refused before any fetch", !!err && /at most 14 pictures; this run has 15/.test(err) && f.calls.length === 0, err);
    });

    await section("4. the answer", async () => {
        const draft = (tag) => ({ inlineData: { mimeType: "image/png", data: png64(tag) }, thought: true });
        const final = { inlineData: { mimeType: "image/png", data: png64("final") } };
        const two = await run(fillReq(), [{ text: "thinking", thought: true }, draft("d1"), draft("d2"), final]);
        check("two thought pictures before the final one: the final one comes back", two.out.bytes.toString() === "png:final", two.out.bytes.toString());
        const after = await run(fillReq(), [final, { text: "done" }]);
        check("a final picture with a text part after it comes back", after.out.bytes.toString() === "png:final");
        const onlyDraft = await run(fillReq(), [draft("d1")]);
        check("an answer of thought pictures alone gives the last one (as Comfy Router)", onlyDraft.out.bytes.toString() === "png:d1");
        const none = await thrown(() => run(fillReq(), [{ text: "secret plan", thought: true }, { text: "I cannot draw that." }]));
        check("no picture: the error names the finish reason, not the thoughts", !!none && /Gemini: STOP/.test(none) && !/secret plan/.test(none), none);
    });

    await section("5. Nano Banana 2 as before", async () => {
        const v = nb2.providers.gemini;
        const { call } = await run({ kind: "fill", prompt: "x", image: pic("crop"), mask: pic("mask"), references: [], width: 1024, height: 768, params: paramsOf(v), options: v.options, model: v.model });
        const gc = call.body.generationConfig;
        check("no thinkingConfig (the variant has no Thinking setting)", !("thinkingConfig" in gc), short(gc));
        check("imageConfig as before (Size 2K)", eq(gc.imageConfig, { imageSize: "2K" }), short(gc.imageConfig));
        const size = v.settings.find((s) => s.key === "image_size").spec[0];
        check("NB2's smallest Size is \"512\" (Google: \"The 512 value does not use a 'K' suffix\")", size.includes("512") && !size.includes("0.5K"), short(size));
        const wide = await run({ kind: "text", prompt: "a banner", references: [pic("r0")], width: 4096, height: 520, params: paramsOf(v, { image_size: "auto" }), options: v.options, model: v.model });
        check("NB2 keeps its own ratios: a very wide text run with references gets 21:9", wide.call.body.generationConfig.imageConfig.aspectRatio === "21:9", short(wide.call.body.generationConfig.imageConfig));
        const pro = JSON.parse(fs.readFileSync(path.join(ROOT, "recipes", "nano_banana_pro.json"), "utf8"));
        const falRes = pro.providers.fal.settings.find((s) => s.key === "resolution").spec[0];
        check("Nano Banana Pro on fal offers no 0.5K (fal's enum: 1K, 2K, 4K)", eq(falRes, ["1K", "2K", "4K"]), short(falRes));
    });

    await section("6. the other hosts (N2)", async () => {
        const PROV = path.join(ROOT, "electron", "main", "providers");
        const STOP = "captured";
        /** The first request an adapter sends, then a throw: { url, body }. */
        async function firstRequest(adapter, req) {
            let got = null;
            const fetch = async (url, init = {}) => {
                got = { url: String(url), body: typeof init.body === "string" ? JSON.parse(init.body) : init.body };
                throw new Error(STOP);
            };
            const err = await thrown(() => adapter[req.kind === "text" ? "generate" : "edit"](req, { fetch, key: "k-test", sleep: async () => {} }));
            if (!got) throw new Error("no request: " + err);
            return got;
        }
        const hostReq = (pid, over = {}) => {
            const v = recipe.providers[pid];
            return { provider: pid, kind: v.input === "edit" ? "edit" : "fill", model: v.model, options: v.options || {}, fields: v.fields || {}, fixed: v.fixed || null, params: paramsOf(v, over.params || {}), prompt: "a red door", negative: "", seed: 7, image: pic("crop"), mask: pic("mask"), references: [], width: 1024, height: 768, ...over, ...(over.params ? { params: paramsOf(v, over.params) } : {}) };
        };

        const fal = require(path.join(PROV, "fal.js"));
        const f = await firstRequest(fal, hostReq("fal"));
        check("fal: the edit endpoint, Thinking medium, Resolution 2K, Safety 4 by name", /\/fal-ai\/nano-banana-2\.1\/edit$/.test(f.url) && f.body.thinking_level === "medium" && f.body.resolution === "2K" && f.body.safety_tolerance === "4", short({ url: f.url, thinking_level: f.body.thinking_level, resolution: f.body.resolution }));
        const fh = await firstRequest(fal, hostReq("fal", { params: { thinking_level: "high" } }));
        check("fal: Thinking high goes as fal's lower-case enum", fh.body.thinking_level === "high");

        const router = require(path.join(PROV, "comfyrouter.js"));
        const r = await firstRequest(router, hostReq("comfyrouter"));
        const rg = r.body && r.body.generationConfig;
        check("Comfy Router: vertexai/gemini-nano-banana-2.1", /vertexai\/gemini-nano-banana-2\.1/.test(r.url), r.url);
        check("Comfy Router: thinkingConfig in the schema's upper case (MEDIUM), Size 2K", rg && eq(rg.thinkingConfig, { thinkingLevel: "MEDIUM" }) && rg.imageConfig && rg.imageConfig.imageSize === "2K", short(rg));
        const nb2r = nb2.providers.comfyrouter;
        const r2 = await firstRequest(router, { ...hostReq("comfyrouter"), model: nb2r.model, options: nb2r.options, params: paramsOf(nb2r) });
        check("Comfy Router: Nano Banana 2 sends no thinkingConfig, as before", r2.body && r2.body.generationConfig && !("thinkingConfig" in r2.body.generationConfig), short(r2.body && r2.body.generationConfig));
        const rw = await firstRequest(router, { ...hostReq("comfyrouter"), kind: "text", image: null, mask: null, references: [pic("r0")], width: 4096, height: 520, params: paramsOf(recipe.providers.comfyrouter, { image_size: "auto" }) });
        check("Comfy Router: a free-size text run with a reference takes the closest of the variant's ratios (8:1)", rw.body.generationConfig.imageConfig.aspectRatio === "8:1", short(rw.body.generationConfig.imageConfig));

        const cloud = require(path.join(PROV, "comfycloud.js"));
        const uploads = [];
        const cctx = { key: "k-test", fetch: async (url, init = {}) => {
            uploads.push(String(url));
            return { ok: true, status: 200, json: async () => ({ name: `u${uploads.length}.png`, subfolder: "", type: "input" }), text: async () => "{}" };
        } };
        const g = await cloud._buildGraph(hostReq("comfycloud", { params: { "model.thinking_level": "HIGH" } }), cctx, "GeminiNanoBanana2V2");
        const node = Object.values(g).find((x) => x.class_type === "GeminiNanoBanana2V2");
        check("Comfy Cloud: the node's model option \"Gemini Nano Banana 2.1\", Thinking HIGH over the node's default, Resolution 2K", node && node.inputs.model === "Gemini Nano Banana 2.1" && node.inputs["model.thinking_level"] === "HIGH" && node.inputs["model.resolution"] === "2K", short(node && node.inputs));

        const orig = require("node:module")._load;
        require("node:module")._load = function (request, ...rest) { return request === "electron" ? { app: { getPath: () => ROOT } } : orig.call(this, request, ...rest); };
        let normalize;
        try { normalize = require(path.join(ROOT, "electron", "main", "recipes.js"))._normalize; } finally { require("node:module")._load = orig; }
        const n = normalize(JSON.parse(JSON.stringify(recipe)));
        const tw = n.providers.wavespeed.text;
        check("WaveSpeed: a new image goes to google/nano-banana-2.1/text-to-image, with references to /edit", tw && tw.model === "google/nano-banana-2.1/text-to-image" && tw.refs && tw.refs.model === "google/nano-banana-2.1/edit", short(tw && { model: tw.model, refs: tw.refs }));
        check("no Oxen variant (Oxen does not list the model)", !("oxen" in recipe.providers));
    });

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})();
