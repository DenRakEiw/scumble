// Vision language models for prompt upsampling through the provider keys (keys.js): the
// editor sends the instruction and the crop it built (promptContextCanvas), the answer
// is the rewritten prompt. Same keys as the image providers, so a stored OpenAI or
// Google key also gives an upsampler; Anthropic is a key of its own (no image model).
//
// A local or self-hosted OpenAI-compatible server (Ollama, LM Studio, vLLM, a proxy) joins
// the list through settings.llm.compat = { url, model } and needs no key.
//
//   list()            -> [{ id, provider, model, label, key: bool }]
//   ask({ id, instruction, image, maxTokens }) -> { text, seconds, model, note }
//   compatModels(url) -> [model id] from GET <url>/v1/models
//
// `image` is PNG bytes (Uint8Array / Buffer) or null. Model ids checked on 2026-09-09.
"use strict";

const keys = require("./keys");
const settings = require("./settings");
const { b64, dataUri, readError } = require("./providers/util");

const MODELS = [
    { provider: "openai", model: "gpt-5.6-luna", label: "GPT-5.6 Luna (OpenAI key)" },
    { provider: "openai", model: "gpt-5.6-terra", label: "GPT-5.6 Terra (OpenAI key)" },
    { provider: "gemini", model: "gemini-3.8-flash", label: "Gemini 3.8 Flash (Google key)" },
    { provider: "gemini", model: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite (Google key)" },
    { provider: "anthropic", model: "claude-opus-5", label: "Claude Opus 5 (Anthropic key)" },
    { provider: "anthropic", model: "claude-haiku-4-5", label: "Claude Haiku 4.5 (Anthropic key)" },
];

const PROVIDER_LABEL = { openai: "OpenAI", gemini: "Google Gemini", anthropic: "Anthropic", compat: "OpenAI-compatible endpoint" };

/** settings.llm.compat = { url, model }: an Ollama / LM Studio / any /v1/chat/completions server. */
function compatConfig() {
    const c = (settings.get().llm || {}).compat || {};
    return { url: String(c.url || "").trim(), model: String(c.model || "").trim() };
}

/** "http://host:port" or ".../v1" -> ".../v1" (no trailing slash). */
function compatBase(url) {
    const u = String(url || "").trim().replace(/\/+$/, "");
    if (!u) throw new Error("No endpoint URL. Set one under Settings › Local / OpenAI-compatible endpoint.");
    return /\/v\d+$/.test(u) ? u : u + "/v1";
}

function compatHost(url) {
    try { return new URL(compatBase(url)).host; } catch (_) { return String(url || ""); }
}

function compatUnreachable(err, base) {
    const m = String((err && (err.message || err)) || "");
    if (/abort|timeout/i.test(m)) return `No answer from ${base} within the timeout.`;
    return `No server at ${base} (is Ollama / LM Studio running?) - ${m}`;
}

function list() {
    const out = MODELS.map((m) => ({ id: `${m.provider}:${m.model}`, ...m, key: !!keys.describe(m.provider).set }));
    const c = compatConfig();
    // `key` is what the editor filters on (host.upsampleBackends), so a keyless local
    // server counts as "set" as soon as it has a URL and a model.
    if (c.url && c.model) out.push({ id: `compat:${c.model}`, provider: "compat", model: c.model, label: `${c.model} (${compatHost(c.url)})`, key: true });
    return out;
}

/** The model ids the endpoint serves (GET <base>/models); used by the Test button. */
async function compatModels(url) {
    const base = compatBase(url || compatConfig().url);
    const key = keys.get("compat");
    let r;
    try {
        r = await fetch(base + "/models", { headers: key ? { Authorization: "Bearer " + key } : {}, signal: AbortSignal.timeout(15000) });
    } catch (err) {
        throw new Error(compatUnreachable(err, base));
    }
    if (!r.ok) throw new Error(`${base}/models: ${await readError(r)}`);
    const out = await r.json();
    const rows = Array.isArray(out) ? out : (out.data || out.models || []);
    return rows.map((m) => (typeof m === "string" ? m : m.id || m.name)).filter(Boolean);
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

/**
 * Any OpenAI-compatible /v1/chat/completions server: Ollama, LM Studio, vLLM, a proxy.
 * The key is optional (local servers want none, OpenRouter and some proxies do).
 * A text-only model answers 400 on the image; we retry once without it and say so, so the
 * user learns the model never saw the crop.
 */
async function askCompatible({ model, key, instruction, image, maxTokens, url }) {
    const base = compatBase(url);
    const endpoint = base + "/chat/completions";
    const headers = { "Content-Type": "application/json", ...(key ? { Authorization: "Bearer " + key } : {}) };

    async function once(withImage) {
        const content = withImage
            ? [{ type: "text", text: instruction }, { type: "image_url", image_url: { url: dataUri(image) } }]
            : instruction;                                   // a plain string is what every server understands
        const body = { model, messages: [{ role: "user", content }], max_tokens: maxTokens, stream: false };
        let r;
        try {
            r = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
        } catch (err) {
            throw new Error(compatUnreachable(err, base));
        }
        if (!r.ok) {
            const e = new Error(`${model} at ${compatHost(url)}: ${await readError(r)}`);
            e.status = r.status;
            throw e;
        }
        return await r.json();
    }

    let textOnly = false;
    let out;
    if (image) {
        try {
            out = await once(true);
        } catch (err) {
            // a 4xx, or a message about images: the model has no vision, ask again without it
            if (!(err.status >= 400 && err.status < 500) && !/image|vision|multimodal|content part/i.test(String(err.message))) throw err;
            textOnly = true;
            out = await once(false);
        }
    } else {
        out = await once(false);
    }

    const msg = (out.choices && out.choices[0] && out.choices[0].message) || {};
    let text = msg.content;                                  // reasoning_content, when there is one, is not the answer
    if (Array.isArray(text)) text = text.filter((p) => p && (p.type === "text" || p.text)).map((p) => p.text || "").join("\n");
    text = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();   // Qwen3 / DeepSeek think inside the content
    if (!text) {
        const why = (out.choices && out.choices[0] && out.choices[0].finish_reason) || (out.error && out.error.message) || "no text in the answer";
        throw new Error(`${model} at ${compatHost(url)}: ${why}`);
    }
    return { text, textOnly };
}

const ADAPTERS = { openai: askOpenAI, gemini: askGemini, anthropic: askAnthropic };

// ---- entry ----------------------------------------------------------------------------

async function ask(req) {
    const id = String(req.id || "");
    const instruction = String(req.instruction || "").trim();
    if (!instruction) throw new Error("empty instruction");
    const maxTokens = Math.max(256, Math.min(8192, +req.maxTokens || 4096));
    const image = toBuffer(req.image);
    const t0 = Date.now();
    let text;
    let note = "";
    let model;
    if (id.startsWith("compat:")) {
        const c = compatConfig();
        model = id.slice("compat:".length) || c.model;
        if (!c.url) throw new Error("No endpoint URL. Set one under Settings › Local / OpenAI-compatible endpoint.");
        const res = await askCompatible({ model, key: keys.get("compat"), instruction, image, maxTokens, url: c.url });
        text = res.text;
        if (res.textOnly) note = "text only";
    } else {
        const m = MODELS.find((x) => `${x.provider}:${x.model}` === id);
        if (!m) throw new Error("Unknown language model: " + id);
        const key = keys.get(m.provider);
        if (!key) throw new Error(`No API key for ${PROVIDER_LABEL[m.provider]}. Add it under Settings › API providers.`);
        model = m.model;
        text = await ADAPTERS[m.provider]({ model: m.model, key, instruction, image, maxTokens });
    }
    // Models like to wrap the prompt in quotes or a code fence even when told not to.
    text = text.replace(/^```[a-z]*\s*|\s*```$/g, "").trim();
    if (/^".*"$/s.test(text) && !text.slice(1, -1).includes('"')) text = text.slice(1, -1).trim();
    console.log(`[llm] ${id} ${((Date.now() - t0) / 1000).toFixed(1)} s, ${text.split(/\s+/).length} words${note ? ", " + note : ""}`);
    return { text, seconds: (Date.now() - t0) / 1000, model, note };
}

module.exports = { list, ask, compatModels, MODELS };
