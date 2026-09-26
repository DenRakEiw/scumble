// The provider registry: which API family a provider speaks, where its key comes from, what
// its base URL is, which models are offered and what the user is told about where the pictures
// go. Read from each provider's own documentation on 2026-09-18 and 2026-09-19
// (docs/PLAN_ASSISTANT.md §3, "The provider registry" and "Where the pictures go"). What has
// and has not been run against a live key is one sentence in docs/ASSISTANT.md, not a warning
// on every row of the picker (docs/BUGS.md, "The assistant's picker warns about itself").
//
// The order is the picker's (§2 row 33). A model listed here takes images and tools; a model
// without image input loses `screenshot` from its tool list (§2 row 34), which is how a free
// OpenRouter id and a row the user added under Settings > Language models are handled.
"use strict";

const ANTHROPIC = "https://api.anthropic.com";

/**
 * families: "messages" (Anthropic), "chat" (Chat Completions), "responses" (OpenAI),
 *           "gemini" (generateContent)
 * dialect:  for "chat", the provider's own rules (§3, "The Chat Completions providers side by
 *           side"); the adapter never guesses them at run time.
 * key:      the row in the credential store (electron/main/keys.js) the key comes from.
 * where:    the plain-words part of the privacy notice (§2 row 31). It names a country only
 *           where the provider's own terms do.
 */
const PROVIDERS = {
    openrouter: {
        label: "OpenRouter",
        family: "chat",
        key: "openrouter",
        base: "https://openrouter.ai/api/v1",
        where: "a host OpenRouter picks for the model, never one it lists in China; Scumble asks it to leave out hosts that train on your data",
        models: [
            { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
            { id: "anthropic/claude-opus-5", label: "Claude Opus 5" },
            { id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra" },
            { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash" },
            { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
            { id: "moonshotai/kimi-k3", label: "Kimi K3" },
            { id: "moonshotai/kimi-k2.6", label: "Kimi K2.6" },
            { id: "z-ai/glm-5.3-flash", label: "GLM-5.3-Flash" },
        ],
        dialect: {
            reasoningField: "reasoning_details",
            thinking: { reasoning: { effort: "medium" } },
            lengthField: "max_tokens",
            imagesInToolMessage: false,
            streamOptions: false,            // OpenRouter always sends usage in the last chunk
            sessionId: true,                 // = the chat id: sticky routing, cache hits
            ignoreHosts: true,               // provider.ignore = the hosts in China (openrouterIgnore below)
            dataCollection: "deny",          // provider.data_collection: hosts that train on the data are left out
            cacheControlFor: /^anthropic\//,
            costFromUsage: true,             // usage.cost, taken as it comes (§2 row 25)
            finalStatus: { 402: "the OpenRouter credits are used up" },
        },
    },
    openai: {
        label: "OpenAI",
        family: "responses",
        key: "openai",
        base: "https://api.openai.com/v1",
        where: "OpenAI; its default region is not stated",
        models: [
            { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
            { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
            { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
        ],
    },
    anthropic: {
        label: "Anthropic",
        family: "messages",
        key: "anthropic",
        base: ANTHROPIC,
        where: "Anthropic, which runs inference in any region",
        models: [
            { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
            { id: "claude-opus-5", label: "Claude Opus 5" },
        ],
    },
    gemini: {
        label: "Google Gemini",
        family: "gemini",
        key: "gemini",
        base: "https://generativelanguage.googleapis.com/v1beta",
        where: "Google, which runs inference in any region",
        requestCap: 18 * 1024 * 1024,        // §2 row 9: Google's own docs contradict each other
        models: [
            { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
            { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)" },
            { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
        ],
    },
    deepseek: {
        label: "DeepSeek",
        family: "chat",
        key: "deepseek",
        base: "https://api.deepseek.com",
        where: "DeepSeek, in the People's Republic of China",
        models: [{ id: "deepseek-flash", label: "DeepSeek V4.1 Flash" }],
        dialect: {
            reasoningField: "reasoning_content",
            reasoningOnEveryMessage: true,   // 400 without it in a request that carries tools
            thinking: { thinking: { type: "enabled" }, reasoning_effort: "high" },
            lengthField: "max_tokens",
            imagesInToolMessage: false,
            streamOptions: true,
            finalStatus: { 402: "the DeepSeek balance is empty" },
        },
    },
    moonshot: {
        label: "Moonshot (Kimi)",
        family: "chat",
        key: "moonshot",
        base: "https://api.moonshot.ai/v1",
        where: "Moonshot AI, in the People's Republic of China",
        models: [
            { id: "kimi-k3", label: "Kimi K3", thinking: { reasoning_effort: "high" } },
            { id: "kimi-k2.6", label: "Kimi K2.6", thinking: { thinking: { type: "enabled", keep: "all" } } },
        ],
        dialect: {
            reasoningField: "reasoning_content",
            reasoningOnEveryMessage: true,
            lengthField: "max_completion_tokens",
            imagesInToolMessage: true,       // its Message schema allows one; not verified (§7)
            strictOnTools: false,
            streamOptions: true,
            // read from error.type: an empty balance and the daily limit are final; engine_overloaded_error
            // and the RPM, TPM and concurrency limits are retried like any 429
            finalTypes: { exceeded_current_quota_error: "the Moonshot balance is empty" },
            finalMessage: { type: "rate_limit_reached_error", test: /TPD|tokens per day|daily/i, words: "Moonshot's daily token limit is reached; it resets the next day" },
        },
    },
    zai: {
        label: "Z.ai (GLM)",
        family: "chat",
        key: "zai",
        base: "https://api.z.ai/api/paas/v4",
        where: "Z.ai, in the People's Republic of China",
        models: [
            { id: "glm-5.3-flash", label: "GLM-5.3-Flash" },
            { id: "glm-5.3-flashx", label: "GLM-5.3-FlashX" },
        ],
        dialect: {
            reasoningField: "reasoning_content",
            reasoningOnEveryMessage: true,
            thinking: { thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "high" },
            lengthField: "max_tokens",
            imagesInToolMessage: false,
            streamOptions: false,
            toolStream: true,
            // read from error.code; 1302 and 1305 (rate limits) are retried like any 429
            finalCodes: { 1113: "the Z.ai balance is empty", 1301: "Z.ai refused the content as sensitive", 1261: "the request is too long for Z.ai; start a new chat" },
        },
    },
    toapis: {
        label: "ToAPIs",
        family: "chat",
        key: "toapis",
        base: null,                          // toapis.baseUrl(settings) + "/v1", filled in by index.js
        where: "ToAPIs, a reseller; its terms were not read, so where it sends them is not stated",
        models: [
            { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
            { id: "claude-opus-5", label: "Claude Opus 5" },
            { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
        ],
        dialect: { reasoningField: "any", lengthField: "max_tokens", imagesInToolMessage: false, streamOptions: true },
    },
    wavespeed: {
        label: "WaveSpeedAI",
        family: "chat",
        key: "wavespeed",
        base: "https://llm.wavespeed.ai/v1",
        where: "WaveSpeedAI; its terms were not read, so where it sends them is not stated",
        models: [
            { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
            { id: "anthropic/claude-opus-5", label: "Claude Opus 5" },
            { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash" },
        ],
        dialect: { reasoningField: "any", lengthField: "max_tokens", imagesInToolMessage: false, streamOptions: true },
    },
    oxen: {
        label: "Oxen.ai",
        family: "chat",
        key: "oxen",
        base: "https://hub.oxen.ai/api/ai",   // no /v1: Oxen's chat route is /api/ai/chat/completions
        where: "Oxen.ai, which runs the model or passes it on to its maker or another host; its terms could not be read, so where the pictures go and how long they are kept is not stated",
        // from GET https://hub.oxen.ai/api/ai/models on 2026-09-26; all three take images
        models: [
            { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
            { id: "gpt-5-6-terra", label: "GPT-5.6 Terra" },
            { id: "gemini-3-8-flash", label: "Gemini 3.8 Flash" },
        ],
        // Oxen documents no stream_options (an unknown field refused would break every turn; leaving it out only loses the
        // cost line) and no common thinking switch (reasoning_effort's values differ per model)
        dialect: { reasoningField: "any", lengthField: "max_tokens", imagesInToolMessage: false, streamOptions: false,
                   finalStatus: { 402: "the Oxen credits are used up" } },
    },
    compat: {
        label: "Local / OpenAI-compatible endpoint",
        family: "chat",
        key: "compat",                       // a local server needs none; the key is sent only when stored
        base: null,                          // compatBase(settings.llm.compat.url), filled in by index.js
        needsKey: false,
        where: "the server at the URL you set; nothing leaves your machine when it runs on it",
        models: [],                          // whatever its /models lists
        dialect: {
            reasoningField: "any", lengthField: "max_tokens", imagesInToolMessage: false, streamOptions: true,
            localKey: true,                  // its key goes to the saved URL, loopback or not (§2 row 26)
            imageFallback: true,             // a refused picture: once more without it, no screenshot afterwards
            contextNote: "The local server should give the model at least 64k tokens of context (Ollama: OLLAMA_CONTEXT_LENGTH=65536); with less, the tool list alone fills it.",
        },
    },
};

/** The picker's order (§2 row 33). */
const ORDER = ["openrouter", "openai", "anthropic", "gemini", "deepseek", "moonshot", "zai", "toapis", "wavespeed", "oxen", "compat"];

/** The model a fresh install starts on (§2 row 6). */
const DEFAULT_MODEL = "anthropic:claude-sonnet-5";

/**
 * "<provider>:<model id>" -> {provider, id, entry, model} or null. `custom` are the user's own
 * rows: a model that is not curated takes its label and whether it sees pictures from its row,
 * so a blind model the user marked as one loses `screenshot` like any other.
 */
function providerOf(value, custom = []) {
    const raw = String(value || "");
    const at = raw.indexOf(":");
    if (at < 0) return null;
    const provider = raw.slice(0, at);
    const id = raw.slice(at + 1);
    const entry = PROVIDERS[Object.prototype.hasOwnProperty.call(PROVIDERS, provider) ? provider : ""];
    if (!entry || !id) return null;
    const own = (custom || []).find((r) => r.provider === provider && r.model === id);
    const model = entry.models.find((m) => m.id === id)
        || (own ? { id, label: own.label || id, vision: own.vision !== false, custom: true } : { id, label: id });
    return { provider, id, entry, model, custom: !!own };
}

/**
 * The picker's rows, grouped by provider in the order above. `ready` says which providers have
 * what they need (a stored key; for the local server a saved URL), and only those are selectable.
 * `custom` are the rows the user added under Settings > Language models (llm_custom.js): they
 * join their provider's group, after its curated models and without repeating one.
 */
function picker(ready = {}, custom = []) {
    return ORDER.map((provider) => {
        const p = PROVIDERS[provider];
        const listed = provider === "compat" ? (ready.compatModels || []) : p.models;
        const mine = (custom || []).filter((r) => r.provider === provider && !listed.some((m) => m.id === r.model));
        return {
            provider,
            label: p.label,
            ready: !!ready[provider],
            note: ready[provider] ? "" : (provider === "compat" ? "no URL" : "no key"),
            where: p.where,
            models: listed.map((m) => ({
                value: `${provider}:${m.id}`,
                label: m.label || m.id,
                vision: m.vision !== false,
                note: m.note || "",
            })).concat(mine.map((r) => ({
                value: `${provider}:${r.model}`,
                label: r.label || r.model,
                vision: r.vision !== false,
                note: "",
                custom: true,
            }))),
        };
    });
}

/**
 * The hosts OpenRouter lists in China, for `provider.ignore` on every request (§3, "Where the
 * pictures go"): the image adapter's list and its once-per-session cache, so both read
 * `GET /api/v1/providers` once and fall back to the same dated list. `base` is the chat's base
 * (`https://openrouter.ai/api/v1`, or the loopback test base with that path).
 */
function openrouterIgnore(base, ctx = {}) {
    const { chinaHosts } = require("../providers/openrouter.js");
    let origin = "https://openrouter.ai";
    try { const u = new URL(String(base)); origin = `${u.protocol}//${u.host}`; } catch (_) { /* the default */ }
    return chinaHosts({ base: origin, fetch: ctx.fetch || fetch, log: ctx.log });
}

/**
 * OpenRouter's live list of models that take tools (`GET /models?supported_parameters=tools`,
 * §2 row 33), read once per session in main: `[{id, label, vision, price: {input, output} in USD
 * per million tokens, reasoning}]`. `base` is the chat's base (`https://openrouter.ai/api/v1`, or
 * the loopback test base with that path). A row whose `input_modalities` lack `image` is a blind
 * model (§2 row 34).
 */
async function openrouterModels(base, ctx = {}) {
    const send = ctx.fetch || fetch;
    const r = await send(`${String(base).replace(/\/+$/, "")}/models?supported_parameters=tools`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`OpenRouter's model list answered ${r.status}`);
    const j = (await r.json()) || {};
    const perMillion = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 1e6 * 1000) / 1000 : null; };
    return (Array.isArray(j.data) ? j.data : [])
        .filter((m) => m && m.id)
        .filter((m) => !Array.isArray(m.supported_parameters) || m.supported_parameters.includes("tools"))
        .map((m) => ({
            id: String(m.id),
            label: String(m.name || m.id),
            vision: Array.isArray((m.architecture || {}).input_modalities) ? m.architecture.input_modalities.includes("image") : false,
            price: { input: perMillion((m.pricing || {}).prompt), output: perMillion((m.pricing || {}).completion) },
            reasoning: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes("reasoning") : false,
        }));
}

module.exports = { PROVIDERS, ORDER, DEFAULT_MODEL, providerOf, picker, openrouterIgnore, openrouterModels };
