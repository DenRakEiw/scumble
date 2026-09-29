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
// (providers/openrouter.js has the host rule, the key rule and the list). Oxen.ai's rows take it on the Oxen key, at
// /api/ai/chat/completions (no /v1), at the host providers/oxen.js allows (settings.oxen.base: the loopback mock only).
//
//   list()            -> [{ id, provider, model, label, key: bool }]
//   ask({ id, instruction, image, images, maxTokens }) -> { text, seconds, model, note, pictures }
//   compatModels(url) -> [model id] from GET <url>/v1/models
//
// `image` is PNG bytes (Uint8Array / Buffer) or null: the crop. `images` are the reference pictures the prompt names
// ([{ png, label }], item 26, docs/PLAN_REFS.md 26d2): at most six go out, each after a line with its label; absent or
// empty, every request is the one it was before them. `pictures` is how many of them went out. settings.llm.refPictures
// false keeps them all back, and a row the user marked `vision: false` gets no picture at all. Model ids checked on
// 2026-09-09.
"use strict";

const keys = require("./keys");
const settings = require("./settings");
const { b64, dataUri, readError } = require("./providers/util");
const toapis = require("./providers/toapis");
const openrouter = require("./providers/openrouter");
const oxen = require("./providers/oxen");
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
    // Oxen.ai, from GET https://hub.oxen.ai/api/ai/models on 2026-09-26 (per million tokens in / out): Gemini 3.8 Flash
    // $0.75 / $3.75, GPT-5.6 Luna $1 / $6, Gemma 4 31B $0.14 / $0.40. Not run against the live API.
    { provider: "oxen", model: "gemini-3-8-flash", label: "Gemini 3.8 Flash (Oxen key)" },
    { provider: "oxen", model: "gpt-5-6-luna", label: "GPT-5.6 Luna (Oxen key)" },
    { provider: "oxen", model: "gemma-4-31b-it", label: "Gemma 4 31B (Oxen key)" },
];

const PROVIDER_LABEL = {
    toapis: "ToAPIs", openai: "OpenAI", gemini: "Google Gemini", anthropic: "Anthropic", openrouter: "OpenRouter", oxen: "Oxen.ai",
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

const MAX_REF_PICTURES = 6;
const MAX_LABEL = 120;

/**
 * The reference pictures of a request, cleaned: PNG bytes (a Uint8Array from IPC, a Buffer or an ArrayBuffer) and a
 * label on one line of at most MAX_LABEL characters, at most MAX_REF_PICTURES of them. A picture without bytes or
 * without a label is left out: the model could not tie it to a token.
 */
function refPictures(list) {
    const out = [];
    for (const r of Array.isArray(list) ? list : []) {
        if (out.length >= MAX_REF_PICTURES) break;
        const v = r && r.png;
        const png = v && (Buffer.isBuffer(v) || v instanceof Uint8Array || v instanceof ArrayBuffer) ? toBuffer(v) : null;
        // cut by code points: a cut through an emoji's surrogate pair makes a string some JSON parsers refuse
        const label = Array.from(String((r && r.label) || "").replace(/\s+/g, " ").trim()).slice(0, MAX_LABEL).join("").trim();
        if (png && png.length && label) out.push({ png, label });
    }
    return out;
}

/**
 * The user turn as neutral parts, [{ text } | { png }], which each builder maps to its own part types. Without
 * reference pictures it is exactly the turn from before them (the instruction, then the crop when there is one), so
 * such a request is byte-identical. With them: the instruction and a sentence on the order, the crop after a line that
 * says so, then each reference picture after a line with its label. The labels carry the tokens ("@img1 (the layer
 * "jacket")"), never numbers, so the model is not invited to write "picture 2".
 */
function turn(instruction, image, images) {
    if (!images || !images.length) return [{ text: instruction }, ...(image ? [{ png: image }] : [])];
    const out = [{ text: instruction + "\n\n" + (image
        ? "The first picture is the one being edited; the reference pictures follow it, each after a line that gives its token."
        : "The pictures are reference images, each after a line that gives its token.") }];
    if (image) out.push({ text: "The picture being edited:" }, { png: image });
    for (const r of images) out.push({ text: `Reference picture ${r.label}:` }, { png: r.png });
    return out;
}

// ---- adapters -----------------------------------------------------------------------

async function askOpenAI({ model, key, instruction, image, images, maxTokens }) {
    // Responses API: one user turn with the text and the pictures as data URIs. The
    // 5.x models reason before they answer; low effort keeps a prompt rewrite quick.
    const content = turn(instruction, image, images).map((p) => (p.png
        ? { type: "input_image", image_url: dataUri(p.png), detail: "auto" }
        : { type: "input_text", text: p.text }));
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

async function askGemini({ model, key, instruction, image, images, maxTokens }) {
    const parts = turn(instruction, image, images).map((p) => (p.png ? { inline_data: { mime_type: "image/png", data: b64(p.png) } } : { text: p.text }));
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

async function askAnthropic({ model, key, instruction, image, images, maxTokens }) {
    // the pictures first and the instruction last, as this request always had it: the turn with its first part
    // (the instruction) moved to the end, which is [crop, instruction] when there are no reference pictures
    const [first, ...rest] = turn(instruction, image, images);
    const content = [...rest, first].map((p) => (p.png
        ? { type: "image", source: { type: "base64", media_type: "image/png", data: b64(p.png) } }
        : { type: "text", text: p.text }));
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
 * The request goes in steps: every picture (the crop and the reference pictures), then the crop
 * alone, then the text alone (a plain string). A model that takes one picture per request answers
 * 400 on several, a text-only model on any; each step down is taken only on a failure a second
 * request can fix, and the note says what the model did not see ("crop only", "text only").
 * Without reference pictures the steps are the crop, then the text, as before item 26.
 *
 * A step down, for the local endpoint: a 400 / 413 / 415 / 422, or a failure whose own words are
 * about images; never a refused key, an empty balance or a rate limit (401 / 402 / 429), a server
 * that cannot be reached, or another failure that does not name images, so a wrong key costs one
 * request. `strict` (ToAPIs, whose rows are all vision models, and the other hosted rows): only a
 * 400 / 413 / 415 / 422 that names the image, never a refused key, an empty balance, a rate limit
 * or a server error, which a second request cannot fix. `explain(status, message)` puts
 * plain words in front of the server's message and gets the error's metadata when `readFailure(r)`
 * ({ message, meta }) reads it (OpenRouter). `extra` goes into the body as it is (OpenRouter: reasoning
 * and provider). `exact`: the URL is the base as it is, without the /v1 compatBase adds (Oxen.ai's /api/ai). The key
 * is taken out of a failed answer's text, whatever the server echoed.
 */
async function askCompatible({ model, key, instruction, image, images = [], maxTokens, url, label, strict, explain, extra, readFailure, exact }) {
    const base = exact ? String(url || "").trim().replace(/\/+$/, "") : compatBase(url);
    const endpoint = base + "/chat/completions";
    const headers = { "Content-Type": "application/json", ...(key ? { Authorization: "Bearer " + key } : {}) };

    async function once(step) {
        const content = step === "text"
            ? instruction                                    // a plain string is what every server understands
            : turn(instruction, image, step === "all" ? images : []).map((p) => (p.png
                ? { type: "image_url", image_url: { url: dataUri(p.png) } }
                : { type: "text", text: p.text }));
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

    // err.raw is the server's own text, without the model id in front, and the id is taken out of it too (a server
    // repeats it: 'model "llama3.2-vision" not found'): a model called "llava-vision" does not make a refused key or a
    // missing model look like a failure about images
    const aboutImage = (s) => /image|vision|multimodal|content part/i.test(model ? String(s == null ? "" : s).split(String(model)).join("") : String(s));
    const badRequest = (s) => [400, 413, 415, 422].includes(s);
    // a 413 on every picture is the reference pictures' size wherever the server sends its answer from (a proxy's page
    // names no image): the crop alone is a smaller request, on a strict host too
    const retry = (err, step) => (strict
        ? (badRequest(err.status) && aboutImage(err.raw)) || (step === "all" && err.status === 413)
        : !!err.status && ![401, 402, 429].includes(err.status) && (badRequest(err.status) || aboutImage(err.raw)));
    const steps = [images.length && "all", image && "crop", "text"].filter(Boolean);
    let out;
    let step;
    for (let i = 0; i < steps.length; i++) {
        step = steps[i];
        try {
            out = await once(step);
            break;
        } catch (err) {
            if (i === steps.length - 1 || !retry(err, step)) throw err;
        }
    }
    const textOnly = step === "text" && (!!image || images.length > 0);
    const note = textOnly ? "text only" : step === "crop" && images.length ? "crop only" : "";

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
    return { text, textOnly, step, note, pictures: step === "all" ? images.length : 0 };
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
 * Oxen.ai's /api/ai/chat/completions: the OpenAI-compatible client on the Oxen key, at the host providers/oxen.js allows
 * (settings.oxen.base: the loopback mock only), with Oxen's words for a failure. The base has no /v1, so it is taken as
 * it is. The picture goes as a data URL, as Oxen's vision example sends it.
 */
async function askOxen(a) {
    const origin = oxen.baseUrl(settings.get());
    oxen.checkKey(origin, a.key);
    return await askCompatible({ ...a, url: origin + oxen.API, exact: true, label: "Oxen.ai", strict: true, explain: oxen.explain, readFailure: oxen.readFailure });
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
    toapis: askToAPIs, openai: askOpenAI, gemini: askGemini, anthropic: askAnthropic, openrouter: askOpenRouter, oxen: askOxen,
    deepseek: askChat, moonshot: askChat, zai: askChat, wavespeed: askChat,
};

// ---- entry ----------------------------------------------------------------------------

async function ask(req) {
    const id = String(req.id || "");
    const instruction = String(req.instruction || "").trim();
    if (!instruction) throw new Error("empty instruction");
    const maxTokens = Math.max(256, Math.min(8192, +req.maxTokens || 4096));
    let image = toBuffer(req.image);
    // the reference pictures: none when the user switched them off (settings.llm.refPictures false; absent means on)
    let images = (settings.get().llm || {}).refPictures === false ? [] : refPictures(req.images);
    const t0 = Date.now();
    let text;
    let note = "";
    let pictures = 0;
    let model;
    if (id.startsWith("compat:")) {
        const c = compatConfig();
        model = id.slice("compat:".length) || c.model;
        if (!c.url) throw new Error("No endpoint URL. Set one under Settings › Local / OpenAI-compatible endpoint.");
        // a row of the endpoint's model under Settings > Language models, whichever use it is ticked for: its
        // "Can see the picture" is about the model
        const row = custom.find(custom.rows(settings.get()), "compat", model);
        if (row && row.vision === false) { image = null; images = []; }
        const key = keys.get("compat");
        let res;
        try {
            res = await askCompatible({ model, key, instruction, image, images, maxTokens, url: c.url });
        } catch (err) {
            throw new Error(scrubKey(err && err.message || err, key));
        }
        text = res.text;
        note = res.note;
        pictures = res.pictures;
    } else {
        const m = MODELS.find((x) => `${x.provider}:${x.model}` === id) || customModel(id);
        if (!m) throw new Error("Unknown language model: " + id);
        const key = keys.get(m.provider);
        if (!key) throw new Error(`No API key for ${PROVIDER_LABEL[m.provider]}. Add it under Settings › API providers.`);
        model = m.model;
        // a row the user marked as not seeing pictures gets none, the crop included, and no note: the user set it so
        if (m.vision === false) { image = null; images = []; }
        let res;
        try {
            res = await ADAPTERS[m.provider]({ provider: m.provider, model: m.model, key, instruction, image, images, maxTokens, row: m });
        } catch (err) {
            // every provider's error text, a failed status or an error inside an HTTP 200, without the key
            throw new Error(scrubKey(err && err.message || err, key));
        }
        // the OpenAI-compatible client (ToAPIs, OpenRouter, Oxen.ai, the Chat providers) says what the answer came
        // without and how many reference pictures went; the other three send every picture or fail
        if (typeof res === "string") {
            text = res;
            pictures = images.length;
        } else {
            text = res.text;
            note = res.note;
            pictures = res.pictures;
        }
    }
    // Models like to wrap the prompt in quotes or a code fence even when told not to.
    text = text.replace(/^```[a-z]*\s*|\s*```$/g, "").trim();
    if (/^".*"$/s.test(text) && !text.slice(1, -1).includes('"')) text = text.slice(1, -1).trim();
    const refs = pictures ? `, ${pictures} reference picture${pictures === 1 ? "" : "s"}` : "";
    console.log(`[llm] ${id} ${((Date.now() - t0) / 1000).toFixed(1)} s, ${text.split(/\s+/).length} words${refs}${note ? ", " + note : ""}`);
    return { text, seconds: (Date.now() - t0) / 1000, model, note, pictures };
}

/** One of the user's own rows as a MODELS entry, or null (Settings > Language models). */
function customModel(id) {
    const at = id.indexOf(":");
    if (at < 0) return null;
    const provider = id.slice(0, at);
    const model = id.slice(at + 1);
    const row = custom.find(custom.forUpsample(settings.get()), provider, model);
    if (!row || !ADAPTERS[Object.prototype.hasOwnProperty.call(ADAPTERS, provider) ? provider : ""]) return null;
    return { provider, model, label: row.label || model, vision: row.vision !== false };
}

module.exports = { list, ask, compatModels, MODELS };
