// Vision language models for prompt upsampling through the provider keys (keys.js): the
// editor sends the instruction and the crop it built (promptContextCanvas), the answer
// is the rewritten prompt. Same keys as the image providers, so a stored OpenAI or
// Google key also gives an upsampler; Anthropic is a key of its own (no image model).
//
// A local or self-hosted OpenAI-compatible server (Ollama, LM Studio, vLLM, a proxy) joins
// the list through settings.llm.compat = { url, model } and needs no key. ToAPIs' Chat
// Completions are OpenAI-compatible too, so its rows go through the same client on the ToAPIs
// image key, at the host providers/toapis.js allows (settings.toapis.base, else toapis.com).
// OpenRouter's rows take the same client on the OpenRouter key, with its reasoning switch per row
// and a routing object that leaves out hosts that train on the data and hosts in China
// (providers/openrouter.js has the host rule, the key rule and the list).
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
const toapis = require("./providers/toapis");
const openrouter = require("./providers/openrouter");
const custom = require("./llm_custom");

// ToAPIs first, as in every provider list. Prices from its catalogue on 2026-09-15 (per million tokens
// in / out): Gemini 3.8 Flash and Claude Haiku 4.5 $0.30 / $1.50, GPT-5.6 Terra $0.40 / $2.40, about a
// tenth of a cent for one rewrite with the crop. GPT-5.6 Luna and the -official text channels are left out.
const MODELS = [
    { provider: "toapis", model: "gemini-3.8-flash", label: "Gemini 3.8 Flash (ToAPIs key)" },
    { provider: "toapis", model: "claude-haiku-4-5", label: "Claude Haiku 4.5 (ToAPIs key)" },
    { provider: "toapis", model: "gpt-5.6-terra", label: "GPT-5.6 Terra (ToAPIs key)" },
    { provider: "openai", model: "gpt-5.6-luna", label: "GPT-5.6 Luna (OpenAI key)" },
    { provider: "openai", model: "gpt-5.6-terra", label: "GPT-5.6 Terra (OpenAI key)" },
    { provider: "gemini", model: "gemini-3.8-flash", label: "Gemini 3.8 Flash (Google key)" },
    { provider: "gemini", model: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite (Google key)" },
    { provider: "anthropic", model: "claude-opus-5", label: "Claude Opus 5 (Anthropic key)" },
    { provider: "anthropic", model: "claude-haiku-4-5", label: "Claude Haiku 4.5 (Anthropic key)" },
    // OpenRouter, from GET /api/v1/models on 2026-09-19 (per million tokens in / out): Gemini 3.8 Flash $0.75 / $3.75,
    // GPT-5.6 Luna $0.20 / $1.20, Claude Haiku 4.5 $1 / $5, Mistral Small 4 $0.15 / $0.60 (Mistral's own hosts in
    // France). `reasoning` is OpenRouter's switch: the lowest effort each model takes, and never returned; Haiku and
    // Mistral Small think only when asked. Gemini 3.8 Flash reasons always, so "none" would be refused.
    { provider: "openrouter", model: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash (OpenRouter key)", reasoning: { effort: "low", exclude: true } },
    { provider: "openrouter", model: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna (OpenRouter key)", reasoning: { effort: "low", exclude: true } },
    { provider: "openrouter", model: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5 (OpenRouter key)" },
    { provider: "openrouter", model: "mistralai/mistral-small-2603", label: "Mistral Small 4 (OpenRouter key)" },
];

const PROVIDER_LABEL = {
    toapis: "ToAPIs", openai: "OpenAI", gemini: "Google Gemini", anthropic: "Anthropic", openrouter: "OpenRouter",
    deepseek: "DeepSeek", moonshot: "Moonshot (Kimi)", zai: "Z.ai (GLM)", wavespeed: "WaveSpeedAI",
    compat: "OpenAI-compatible endpoint",
};

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

function compatUnreachable(err, base, label) {
    const m = String((err && (err.message || err)) || "");
    if (/abort|timeout/i.test(m)) return `No answer from ${label ? label + " at " : ""}${base} within the timeout.`;
    return label ? `${label} at ${base} could not be reached - ${m}` : `No server at ${base} (is Ollama / LM Studio running?) - ${m}`;
}

function list() {
    const out = MODELS.map((m) => ({ id: `${m.provider}:${m.model}`, provider: m.provider, model: m.model, label: m.label, key: !!keys.describe(m.provider).set }));
    const c = compatConfig();
    // `key` is what the editor filters on (host.upsampleBackends), so a keyless local
    // server counts as "set" as soon as it has a URL and a model.
    if (c.url && c.model) out.push({ id: `compat:${c.model}`, provider: "compat", model: c.model, label: `${c.model} (${compatHost(c.url)})`, key: true });
    // the rows the user added under Settings > Language models, after the built-in ones
    for (const row of custom.forUpsample(settings.get())) {
        const id = `${row.provider}:${row.model}`;
        if (out.some((x) => x.id === id)) continue;
        const label = `${row.label || row.model} (${PROVIDER_LABEL[row.provider] || row.provider})`;
        out.push({ id, provider: row.provider, model: row.model, label, key: customHasKey(row), custom: true });
    }
    return out;
}

/**
 * Whether a row the user added can run: a stored key, or for the local endpoint a saved URL
 * (it needs no key). This is what the editor filters its upsample list on.
 */
function customHasKey(row) {
    if (row.provider === "compat") return !!compatConfig().url;
    return !!keys.describe(row.provider).set;
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

/**
 * An error text with the key taken out, whatever the server echoed. Only a key of 12 characters or more: a local
 * server's placeholder key ("ollama", "lm-studio") is no secret, and taking it out would garble that server's own
 * words ("ollama pull llava").
 */
function scrubKey(text, key) {
    const s = String(text == null ? "" : text);
    return key && key.length >= 12 ? s.split(key).join("[key]") : s;
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
 *
 * `strict` (ToAPIs, whose rows are all vision models): the retry without the image only for a
 * 400 / 413 / 415 / 422 that names the image, never for a refused key, an empty balance, a rate
 * limit or a server error, which a second request cannot fix; `explain(status, message)` puts
 * plain words in front of the server's message and gets the error's metadata when `readFailure(r)`
 * ({ message, meta }) reads it (OpenRouter). `extra` goes into the body as it is (OpenRouter: reasoning
 * and provider). The key is taken out of a failed answer's text, whatever the server echoed.
 */
async function askCompatible({ model, key, instruction, image, maxTokens, url, label, strict, explain, extra, readFailure }) {
    const base = compatBase(url);
    const endpoint = base + "/chat/completions";
    const headers = { "Content-Type": "application/json", ...(key ? { Authorization: "Bearer " + key } : {}) };

    async function once(withImage) {
        const content = withImage
            ? [{ type: "text", text: instruction }, { type: "image_url", image_url: { url: dataUri(image) } }]
            : instruction;                                   // a plain string is what every server understands
        const body = { model, messages: [{ role: "user", content }], max_tokens: maxTokens, stream: false, ...(extra || {}) };
        let r;
        try {
            r = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
        } catch (err) {
            throw new Error(compatUnreachable(err, base, label));
        }
        if (!r.ok) {
            const f = readFailure ? await readFailure(r) : { message: await readError(r), meta: {} };
            const raw = scrubKey(f.message, key);
            const e = new Error(`${model} at ${compatHost(url)}: ${explain ? explain(r.status, raw, f.meta) : raw}`);
            e.status = r.status;
            e.raw = raw;
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
            const aboutImage = (s) => /image|vision|multimodal|content part/i.test(String(s));
            if (strict ? !([400, 413, 415, 422].includes(err.status) && aboutImage(err.raw)) : (!(err.status >= 400 && err.status < 500) && !aboutImage(err.message))) throw err;
            textOnly = true;
            out = await once(false);
        }
    } else {
        out = await once(false);
    }

    const choice = (out.choices && out.choices[0]) || {};
    // an error after the answer began comes as HTTP 200 (OpenRouter): what came before it is not the prompt
    if (choice.finish_reason === "error" || choice.error) {
        const e = choice.error || {};
        throw new Error(`${model} at ${compatHost(url)}: ${e.message || "the model failed while answering"}`);
    }
    const msg = choice.message || {};
    // a refusal comes as HTTP 200 with finish_reason "content_filter" and the reason in message.refusal (OpenRouter's
    // contract; OpenAI's content_filter also means the text was cut): whatever content came is not the prompt
    if (choice.finish_reason === "content_filter" || msg.refusal) {
        throw new Error(`${model} at ${compatHost(url)}: refused${msg.refusal ? `: ${msg.refusal}` : " by a content filter (content_filter)"}`);
    }
    let text = msg.content;                                  // reasoning_content, when there is one, is not the answer
    if (Array.isArray(text)) text = text.filter((p) => p && (p.type === "text" || p.text)).map((p) => p.text || "").join("\n");
    text = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();   // Qwen3 / DeepSeek think inside the content
    if (!text) {
        const why = (out.choices && out.choices[0] && out.choices[0].finish_reason) || (out.error && out.error.message) || "no text in the answer";
        throw new Error(`${model} at ${compatHost(url)}: ${why}`);
    }
    return { text, textOnly };
}

/** ToAPIs' /v1/chat/completions: the OpenAI-compatible client with the image key and ToAPIs' host. */
async function askToAPIs(a) {
    return await askCompatible({ ...a, url: toapis.baseUrl(settings.get()) + "/v1", label: "ToAPIs", strict: true, explain: toapis.explain });
}

/**
 * OpenRouter's /api/v1/chat/completions: the OpenAI-compatible client with the OpenRouter key, the row's
 * reasoning switch, and a routing object that keeps to hosts that do not train on the data
 * (data_collection "deny") and leaves out the hosts in China. No attribution header goes out.
 */
async function askOpenRouter(a) {
    const base = openrouter.baseUrl(settings.get());
    openrouter.checkKey(base, a.key);
    const ignore = await openrouter.chinaHosts({ fetch, base, log: (m) => console.log("[llm] openrouter:", m) });
    const extra = { provider: { data_collection: "deny", ignore } };
    if (a.row && a.row.reasoning) extra.reasoning = { ...a.row.reasoning };
    return await askCompatible({ ...a, url: base + "/api/v1", label: "OpenRouter", strict: true, explain: openrouter.explain, readFailure: openrouter.readFailure, extra });
}

/**
 * The Chat Completions providers that have no upsample adapter of their own (DeepSeek, Moonshot,
 * Z.ai, WaveSpeedAI): the OpenAI-compatible client on that provider's own key and base URL, as
 * the registry (assistant/providers.js) has them. Only a model the user added by hand reaches
 * this; `strict` keeps the retry without the picture to a 4xx that names the image.
 */
async function askChat(a) {
    const entry = custom.endpoint(a.provider);
    if (!entry) throw new Error(`No endpoint for ${PROVIDER_LABEL[a.provider] || a.provider}.`);
    return await askCompatible({ ...a, url: entry.base, label: entry.label, strict: true });
}

const ADAPTERS = {
    toapis: askToAPIs, openai: askOpenAI, gemini: askGemini, anthropic: askAnthropic, openrouter: askOpenRouter,
    deepseek: askChat, moonshot: askChat, zai: askChat, wavespeed: askChat,
};

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
        const key = keys.get("compat");
        let res;
        try {
            res = await askCompatible({ model, key, instruction, image, maxTokens, url: c.url });
        } catch (err) {
            throw new Error(scrubKey(err && err.message || err, key));
        }
        text = res.text;
        if (res.textOnly) note = "text only";
    } else {
        const m = MODELS.find((x) => `${x.provider}:${x.model}` === id) || customModel(id);
        if (!m) throw new Error("Unknown language model: " + id);
        const key = keys.get(m.provider);
        if (!key) throw new Error(`No API key for ${PROVIDER_LABEL[m.provider]}. Add it under Settings › API providers.`);
        model = m.model;
        let res;
        try {
            res = await ADAPTERS[m.provider]({ provider: m.provider, model: m.model, key, instruction, image, maxTokens, row: m });
        } catch (err) {
            // every provider's error text, a failed status or an error inside an HTTP 200, without the key
            throw new Error(scrubKey(err && err.message || err, key));
        }
        // the OpenAI-compatible client (ToAPIs, OpenRouter) says whether the answer came without the image
        text = typeof res === "string" ? res : res.text;
        if (res && res.textOnly) note = "text only";
    }
    // Models like to wrap the prompt in quotes or a code fence even when told not to.
    text = text.replace(/^```[a-z]*\s*|\s*```$/g, "").trim();
    if (/^".*"$/s.test(text) && !text.slice(1, -1).includes('"')) text = text.slice(1, -1).trim();
    console.log(`[llm] ${id} ${((Date.now() - t0) / 1000).toFixed(1)} s, ${text.split(/\s+/).length} words${note ? ", " + note : ""}`);
    return { text, seconds: (Date.now() - t0) / 1000, model, note };
}

/** One of the user's own rows as a MODELS entry, or null (Settings > Language models). */
function customModel(id) {
    const at = id.indexOf(":");
    if (at < 0) return null;
    const provider = id.slice(0, at);
    const model = id.slice(at + 1);
    const row = custom.find(custom.forUpsample(settings.get()), provider, model);
    if (!row || !ADAPTERS[Object.prototype.hasOwnProperty.call(ADAPTERS, provider) ? provider : ""]) return null;
    return { provider, model, label: row.label || model };
}

module.exports = { list, ask, compatModels, MODELS };
