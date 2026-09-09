// Vision language models for prompt upsampling through the provider keys (keys.js): the
// editor sends the instruction and the crop it built (promptContextCanvas), the answer
// is the rewritten prompt. Same keys as the image providers, so a stored OpenAI or
// Google key also gives an upsampler; Anthropic is a key of its own (no image model).
//
//   list()            -> [{ id, provider, model, label, key: bool }]
//   ask({ id, instruction, image, maxTokens }) -> { text, seconds, model }
//
// `image` is PNG bytes (Uint8Array / Buffer) or null. Model ids checked on 2026-09-09.
"use strict";

const keys = require("./keys");
const { b64, dataUri, readError } = require("./providers/util");

const MODELS = [
    { provider: "openai", model: "gpt-5.6-luna", label: "GPT-5.6 Luna (OpenAI key)" },
    { provider: "openai", model: "gpt-5.6-terra", label: "GPT-5.6 Terra (OpenAI key)" },
    { provider: "gemini", model: "gemini-3.8-flash", label: "Gemini 3.8 Flash (Google key)" },
    { provider: "gemini", model: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite (Google key)" },
    { provider: "anthropic", model: "claude-opus-5", label: "Claude Opus 5 (Anthropic key)" },
    { provider: "anthropic", model: "claude-haiku-4-5", label: "Claude Haiku 4.5 (Anthropic key)" },
];

const PROVIDER_LABEL = { openai: "OpenAI", gemini: "Google Gemini", anthropic: "Anthropic" };

function list() {
    return MODELS.map((m) => ({ id: `${m.provider}:${m.model}`, ...m, key: !!keys.describe(m.provider).set }));
}

function toBuffer(v) {
    if (!v) return null;
    if (Buffer.isBuffer(v)) return v;
    if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    return Buffer.from(v);
}

// ---- adapters -----------------------------------------------------------------------

async function askOpenAI({ model, key, instruction, image, maxTokens }) {
    // Responses API: one user turn with the text and the image as a data URI. The
    // 5.x models reason before they answer; low effort keeps a prompt rewrite quick.
    const content = [{ type: "input_text", text: instruction }];
    if (image) content.push({ type: "input_image", image_url: dataUri(image), detail: "auto" });
    const body = { model, input: [{ role: "user", content }], max_output_tokens: maxTokens, reasoning: { effort: "low" } };
    const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`OpenAI ${model}: ${await readError(r)}`);
    const out = await r.json();
    const texts = [];
    for (const item of out.output || []) {
        if (item.type !== "message") continue;
        for (const c of item.content || []) if (c.type === "output_text" && c.text) texts.push(c.text);
    }
    const text = texts.join("\n").trim();
    if (!text) {
        const why = out.status === "incomplete" ? `incomplete (${(out.incomplete_reason && out.incomplete_reason.reason) || "cut off"})` : (out.error && out.error.message) || "no text in the answer";
        throw new Error(`OpenAI ${model}: ${why}`);
    }
    return text;
}

async function askGemini({ model, key, instruction, image, maxTokens }) {
    const parts = [{ text: instruction }];
    if (image) parts.push({ inline_data: { mime_type: "image/png", data: b64(image) } });
    // Thinking tokens count against maxOutputTokens, so the limit stays generous and the
    // Gemini 3 models think at the low level (thinkingLevel is a Gemini 3 field).
    const generationConfig = { maxOutputTokens: maxTokens, responseModalities: ["TEXT"] };
    if (/^gemini-3/.test(model)) generationConfig.thinkingConfig = { thinkingLevel: "low" };
    const body = { contents: [{ role: "user", parts }], generationConfig };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Gemini ${model}: ${await readError(r)}`);
    const out = await r.json();
    const cand = out.candidates && out.candidates[0];
    const partsOut = (cand && cand.content && cand.content.parts) || [];
    const text = partsOut.filter((p) => p.text && !p.thought).map((p) => p.text).join("\n").trim();
    if (!text) {
        const why = (cand && cand.finishReason) || (out.promptFeedback && out.promptFeedback.blockReason) || "no text part";
        throw new Error(`Gemini ${model}: ${why}`);
    }
    return text;
}

async function askAnthropic({ model, key, instruction, image, maxTokens }) {
    const content = [];
    if (image) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: b64(image) } });
    content.push({ type: "text", text: instruction });
    const body = { model, max_tokens: maxTokens, messages: [{ role: "user", content }] };
    // Opus 5 thinks adaptively by default; low effort is enough for a prompt rewrite.
    // Haiku 4.5 does not take the effort field.
    if (/opus|sonnet-5/.test(model)) body.output_config = { effort: "low" };
    const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Anthropic ${model}: ${await readError(r)}`);
    const out = await r.json();
    if (out.stop_reason === "refusal") {
        const d = out.stop_details || {};
        throw new Error(`Anthropic ${model}: refused${d.category ? ` (${d.category})` : ""}${d.explanation ? `: ${d.explanation}` : ""}`);
    }
    const text = (out.content || []).filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n").trim();
    if (!text) throw new Error(`Anthropic ${model}: no text in the answer (${out.stop_reason || "?"})`);
    return text;
}

const ADAPTERS = { openai: askOpenAI, gemini: askGemini, anthropic: askAnthropic };

// ---- entry ----------------------------------------------------------------------------

async function ask(req) {
    const id = String(req.id || "");
    const m = MODELS.find((x) => `${x.provider}:${x.model}` === id);
    if (!m) throw new Error("Unknown language model: " + id);
    const key = keys.get(m.provider);
    if (!key) throw new Error(`No API key for ${PROVIDER_LABEL[m.provider]}. Add it under Settings › API providers.`);
    const instruction = String(req.instruction || "").trim();
    if (!instruction) throw new Error("empty instruction");
    const t0 = Date.now();
    let text = await ADAPTERS[m.provider]({ model: m.model, key, instruction, image: toBuffer(req.image), maxTokens: Math.max(256, Math.min(8192, +req.maxTokens || 4096)) });
    // Models like to wrap the prompt in quotes or a code fence even when told not to.
    text = text.replace(/^```[a-z]*\s*|\s*```$/g, "").trim();
    if (/^".*"$/s.test(text) && !text.slice(1, -1).includes('"')) text = text.slice(1, -1).trim();
    console.log(`[llm] ${id} ${((Date.now() - t0) / 1000).toFixed(1)} s, ${text.split(/\s+/).length} words`);
    return { text, seconds: (Date.now() - t0) / 1000, model: m.model };
}

module.exports = { list, ask, MODELS };
