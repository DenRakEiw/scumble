// Nano Banana 2.1 on Google's own API (recipes/nano_banana_2_1.json through electron/main/providers/gemini.js), in plain
// Node, no Electron, no key and no network:
//   node tools/nanobanana21_test.js
// A scripted fetch plays generativelanguage.googleapis.com: it records each request and answers with the parts a test
// hands it. The light tier (CLAUDE.md "Working rules"): the request shapes written from Google's image generation page
// (docs/PLAN_0_1_43.md §3, N1), never run against the live API. Sections 4 and 5 hold Nano Banana 2 to what it sent
// before the Thinking setting and the per-variant ratios existed, and pin the "512" size class of 3.1 Flash Image.
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

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})();
