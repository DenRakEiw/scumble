// The Chat Completions adapter: one adapter for OpenRouter, DeepSeek, Moonshot (Kimi), Z.ai (GLM),
// ToAPIs, WaveSpeed and the local OpenAI-compatible endpoint, each with its dialect from the
// registry (docs/PLAN_ASSISTANT.md §3, "The Chat Completions providers side by side"; §4 A2).
// Written from each provider's documentation as read on 2026-09-18 and 2026-09-19; **not run
// against a live key** (§7). The assistant message goes back into the history exactly as it was
// rebuilt from the stream - `content`, `tool_calls` and the dialect's reasoning field - because
// DeepSeek answers 400 without `reasoning_content` in a request that carries tools, Moonshot's K3
// requires it unchanged, and OpenRouter's `reasoning_details` carry signatures.
//
// The dialect is data (`providers.js`), never guessed at run time (§2 row 35): which reasoning
// field goes back, the thinking switch, the length field, where a screenshot goes, and which
// error codes are final. `tool_choice`, `parallel_tool_calls`, `temperature`, `top_p`, `n` and the
// penalties are sent to no provider.
"use strict";

const { postStream, refusesImage, scrub } = require("./http.js");
const { readSse } = require("./sse.js");
const { openrouterIgnore } = require("./providers.js");

const TEXT_CAP = 32000;                       // a tool result longer than this is cut, with a note
const REQUEST_CAP = 24 * 1024 * 1024;
const STUB = "[screenshot no longer attached; call screenshot again]";
const FOLLOWS = "The screenshot follows in the next message.";
const REFUSED = "[screenshot removed: this server does not take images]";

/** The tools as this family takes them: `function` objects, `strict: false` where the dialect says so. */
function toolsFor(tools, dialect = {}) {
    return (tools || []).map((t) => {
        const fn = {
            name: t.name,
            description: t.description || "",
            parameters: t.inputSchema || { type: "object", properties: {} },
        };
        if (dialect && dialect.strictOnTools === false) fn.strict = false;
        return { type: "function", function: fn };
    });
}

/** The user's text with the state note above it, as text parts (every listed provider takes them). */
function userMessage(note, text) {
    const parts = [];
    if (note) parts.push({ type: "text", text: note });
    parts.push({ type: "text", text: String(text == null ? "" : text) });
    return { role: "user", content: parts };
}

function dataUrl(part) {
    return `data:${part.mimeType || "image/jpeg"};base64,${part.data}`;
}

function cut(text) {
    return text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) + `\n... (cut after ${TEXT_CAP} characters)` : text;
}

/**
 * One `role: "tool"` message per call, in call order, before anything else; each carries text.
 * A screenshot goes inline as an `image_url` part of the tool message where the dialect allows it
 * (Moonshot); everywhere else the tool message says the screenshot follows, and one `user`
 * message after the last tool message carries every screenshot of the step, each after the text
 * "Screenshot from call <id>" (§2 row 9).
 */
function resultsMessages(calls, results, chat) {
    const inline = !!(chat && chat.dialect && chat.dialect.imagesInToolMessage);
    const out = [];
    const follow = [];
    for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        const res = results[i] || {};
        const texts = [];
        const images = [];
        for (const part of res.content || []) {
            if (part.type === "image" && part.data) images.push(part);
            else if (part.type === "text") texts.push(cut(String(part.text || "")));
        }
        let text = texts.join("\n");
        if (res.isError) text = `Error: ${text || "the call failed"}`;
        else if (!text) text = "ok";
        if (images.length && inline) {
            const parts = [];
            if (text) parts.push({ type: "text", text });
            for (const img of images) parts.push({ type: "image_url", image_url: { url: dataUrl(img) } });
            out.push({ role: "tool", tool_call_id: call.id, content: parts });
        } else {
            if (images.length) {
                text = text ? `${text}\n${FOLLOWS}` : FOLLOWS;
                for (const img of images) follow.push({ id: call.id, img });
            }
            out.push({ role: "tool", tool_call_id: call.id, content: text });
        }
    }
    if (follow.length) {
        const content = [];
        for (const { id, img } of follow) {
            content.push({ type: "text", text: `Screenshot from call ${id}` });
            content.push({ type: "image_url", image_url: { url: dataUrl(img) } });
        }
        out.push({ role: "user", content });
    }
    return out;
}

/** Every `image_url` part of the history, in order, with a setter that replaces it. */
function imageParts(history) {
    const found = [];
    for (const message of history) {
        if (!message || (message.role !== "tool" && message.role !== "user")) continue;
        const content = message.content;
        if (!Array.isArray(content)) continue;
        content.forEach((part, at) => {
            if (part && part.type === "image_url") found.push({ content, at });
        });
    }
    return found;
}

/**
 * Detach all but the last `keep` screenshots: every earlier image part becomes a text stub. Only
 * ever called at a new user message (§2 row 9), never inside a turn.
 */
function prune(history, keep) {
    if (!keep || keep < 0) return history;
    const images = imageParts(history);
    const drop = images.length - keep;
    for (let i = 0; i < drop; i++) images[i].content[images[i].at] = { type: "text", text: STUB };
    return history;
}

/** How many screenshots the history carries. */
function countImages(history) {
    return imageParts(history).length;
}

/** Every screenshot replaced by a note: the local server refused a picture (§2 row 26). */
function stripImages(history) {
    const images = imageParts(history);
    for (const { content, at } of images) content[at] = { type: "text", text: REFUSED };
    return images.length;
}

/** The body this chat would send, for the size check before every model call and for the tests. */
function bodyFor(chat, history) {
    const d = chat.dialect || {};
    const body = {
        model: chat.model,
        messages: [{ role: "system", content: chat.system }, ...history],
        tools: chat.tools,
        stream: true,
    };
    body[d.lengthField || "max_tokens"] = chat.maxTokens;
    if (d.thinking && typeof d.thinking === "object") Object.assign(body, d.thinking);
    if (d.streamOptions) body.stream_options = { include_usage: true };
    if (d.toolStream) body.tool_stream = true;
    if (d.sessionId) body.session_id = chat.id;
    if (d.ignoreHosts) body.provider = { data_collection: d.dataCollection || "deny", ignore: [...(chat.ignore || [])] };
    if (d.cacheControlFor && d.cacheControlFor.test(String(chat.model))) body.cache_control = { type: "ephemeral" };
    if (!body.tools || !body.tools.length) delete body.tools;   // Help offers none (help.js), and an empty list is refused
    return body;
}

function requestBytes(chat, history) {
    return Buffer.byteLength(JSON.stringify(bodyFor(chat, history)), "utf8");
}

/**
 * The plain words for an answer that no retry can fix, from the dialect: an HTTP status (a 402
 * on DeepSeek or OpenRouter), an `error.code` (Z.ai's 1113, 1261, 1301), an `error.type`
 * (Moonshot's `exceeded_current_quota_error`) or a `rate_limit_reached_error` whose message names
 * the daily limit. Null for everything else, which keeps `postStream`'s own retry rules.
 */
function finalWords(d, status, bodyText) {
    let e = null;
    try { const j = JSON.parse(String(bodyText || "")); e = (j && j.error) || null; } catch (_) { /* not JSON */ }
    if (e && typeof e === "object") {
        const code = e.code !== undefined && e.code !== null ? String(e.code) : "";
        if (code && d.finalCodes && Object.prototype.hasOwnProperty.call(d.finalCodes, code)) return d.finalCodes[code];
        const type = String(e.type || "");
        if (type && d.finalTypes && Object.prototype.hasOwnProperty.call(d.finalTypes, type)) return d.finalTypes[type];
        const fm = d.finalMessage;
        if (fm && type === fm.type && fm.test.test(String(e.message || ""))) return fm.words;
    }
    if (d.finalStatus && Object.prototype.hasOwnProperty.call(d.finalStatus, String(status))) return d.finalStatus[String(status)];
    return null;
}

/** `usage` as the loop counts it. `prompt_tokens` includes the cached tokens on this family. */
function usageOf(u) {
    u = u || {};
    const pd = u.prompt_tokens_details || {};
    const cd = u.completion_tokens_details || {};
    const prompt = Number(u.prompt_tokens) || 0;
    const cacheRead = Number(pd.cached_tokens !== undefined && pd.cached_tokens !== null ? pd.cached_tokens : u.prompt_cache_hit_tokens) || 0;
    const cacheWrite = Number(pd.cache_write_tokens) || 0;
    const out = {
        input: Math.max(0, prompt - cacheRead - cacheWrite),
        cacheRead,
        cacheWrite,
        output: Number(u.completion_tokens) || 0,
        reasoning: Number(cd.reasoning_tokens) || 0,
    };
    if (u.cost !== undefined && u.cost !== null && Number.isFinite(Number(u.cost))) out.cost = Number(u.cost);
    return out;
}

const FINISH = { stop: "end", tool_calls: "tools", function_call: "tools", length: "cut", content_filter: "refusal", sensitive: "refusal" };
const FINISH_ERRORS = {
    error: "the model failed while answering",
    network_error: "the provider reported a network error while answering",
    insufficient_system_resource: "the provider ran out of resources (insufficient_system_resource)",
    aborted: "the provider aborted the answer",
    model_context_window_exceeded: "this chat exceeds the model's context window; start a new chat",
};

/** The text of a delta's `content`, a string or (on some servers) an array of parts. */
function textOfDelta(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("");
    return "";
}

/** Which reasoning fields of a delta this dialect keeps. */
function reasoningFields(d) {
    if (d.reasoningField === "any") return ["reasoning_content", "reasoning", "reasoning_details"];
    return d.reasoningField ? [d.reasoningField] : [];
}

/**
 * One model call, streamed. `tool_calls` are rebuilt by `index` (`id`, `type` and the name from
 * the first fragment, `arguments` appended) and parsed only when the stream has ended; a call
 * that arrives whole in one delta is taken the same way, an `arguments` object as it is.
 *
 * @returns {{messages: [], calls: [{id, name, args, badJson}], stop: string, usage: object, text: string}}
 */
async function stream(chat, history, opts = {}) {
    const { signal, onText, fetchImpl, log } = opts;
    const d = chat.dialect || {};
    const keys = chat.key ? [chat.key] : [];
    if (d.ignoreHosts && !chat.ignore) chat.ignore = await openrouterIgnore(chat.base, { fetch: fetchImpl, log });

    const url = `${chat.base}/chat/completions`;
    const headers = { "content-type": "application/json" };
    if (chat.key) headers.Authorization = `Bearer ${chat.key}`;   // no attribution header goes out (§7)

    let res;
    try {
        ({ res } = await postStream(url, headers, bodyFor(chat, history), {
            signal, key: chat.key, keys, idleMs: chat.idleMs,
            localOk: !!d.localKey,
            noRetry: (status, body) => finalWords(d, status, body) !== null,
            sleep: opts.sleep, log, fetchImpl,
        }));
    } catch (err) {
        if (err && err.status !== undefined) {
            const words = finalWords(d, err.status, err.body);
            if (words) { const e = new Error(words); e.status = err.status; e.final = true; throw e; }
            // the local server turned the request away because of the picture (§2 row 26): once
            // more without it, and no screenshot for the rest of the chat
            if (d.imageFallback && !opts.imagesStripped && refusesImage(err.status, err.body) && imageParts(history).length) {
                stripImages(history);
                chat.noImages = true;
                if (log) log(`the server refused the picture (HTTP ${err.status}); sending again without it, screenshot is off for this chat`);
                return stream(chat, history, { ...opts, imagesStripped: true });
            }
        }
        throw err;
    }

    const type = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
    if (type && !/event-stream/i.test(String(type))) {
        // an answer that is not a stream (Z.ai reports some errors as HTTP 200 JSON)
        const text = scrub(await res.text().catch(() => ""), keys);
        throw new Error(finalWords(d, res.status, text) || `the server did not stream: ${String(text).slice(0, 300)}`);
    }

    const state = { text: "", reasoning: {}, calls: new Map(), finish: null, usage: null, error: null, refusal: "" };
    const fields = reasoningFields(d);

    await readSse(res.body, {
        signal,
        idleMs: chat.idleMs,
        onEvent: ({ data }) => {
            let msg;
            try { msg = JSON.parse(data); } catch (_) { return; }
            if (!msg || typeof msg !== "object") return;
            if (msg.error && typeof msg.error === "object") {
                state.error = `${msg.error.message || msg.error.code || "error"}`;
            }
            if (msg.usage && typeof msg.usage === "object") state.usage = { ...(state.usage || {}), ...msg.usage };
            const choice = Array.isArray(msg.choices) && msg.choices.length ? msg.choices[0] : null;
            if (!choice) return;
            if (choice.usage && typeof choice.usage === "object") state.usage = { ...(state.usage || {}), ...choice.usage };
            if (choice.finish_reason) state.finish = String(choice.finish_reason);
            if (choice.error && typeof choice.error === "object") state.error = `${choice.error.message || choice.error.code || "error"}`;
            const delta = choice.delta || {};
            const piece = textOfDelta(delta.content);
            if (piece) { state.text += piece; if (onText) onText(piece); }
            if (typeof delta.refusal === "string" && delta.refusal) state.refusal += delta.refusal;
            for (const field of fields) {
                const v = delta[field];
                if (v === undefined || v === null) continue;
                if (Array.isArray(v)) state.reasoning[field] = (state.reasoning[field] || []).concat(v);   // unmodified, in order
                else if (typeof v === "string") state.reasoning[field] = (state.reasoning[field] || "") + v;
            }
            if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                    if (!tc || typeof tc !== "object") continue;
                    let index = Number.isInteger(tc.index) ? tc.index : null;
                    if (index === null) {
                        // a server without index: a fragment that repeats an id belongs to that call, one
                        // that brings an id or a name opens a call, the rest joins the last one
                        const known = tc.id ? [...state.calls.entries()].find(([, c]) => c.id === String(tc.id)) : null;
                        if (known) index = known[0];
                        else if (tc.id || (tc.function && tc.function.name)) index = state.calls.size;
                        else index = Math.max(0, state.calls.size - 1);
                    }
                    if (!state.calls.has(index)) state.calls.set(index, { id: null, type: null, name: null, raw: "", object: undefined });
                    const call = state.calls.get(index);
                    if (tc.id && !call.id) call.id = String(tc.id);
                    if (tc.type && !call.type) call.type = String(tc.type);
                    const fn = tc.function || {};
                    if (fn.name && !call.name) call.name = String(fn.name);
                    if (typeof fn.arguments === "string") call.raw += fn.arguments;
                    else if (fn.arguments && typeof fn.arguments === "object") call.object = fn.arguments;   // Z.ai's schema says object
                }
            }
        },
    });

    if (state.error) throw new Error(scrub(state.error, keys));
    if (FINISH_ERRORS[state.finish]) throw new Error(FINISH_ERRORS[state.finish]);

    const ordered = [...state.calls.keys()].sort((a, b) => a - b).map((k) => state.calls.get(k));
    const calls = ordered.map((c, n) => {
        const id = c.id || `call_${n + 1}`;
        let args = {};
        let badJson = null;
        if (c.object !== undefined) {
            args = c.object;
            if (args === null || typeof args !== "object" || Array.isArray(args)) { badJson = JSON.stringify(c.object); args = {}; }
        } else if (c.raw.trim()) {
            try { args = JSON.parse(c.raw); } catch (_) { badJson = c.raw; }
            if (!badJson && (args === null || typeof args !== "object" || Array.isArray(args))) { badJson = c.raw; args = {}; }
        }
        return {
            id, name: c.name || "", args, badJson,
            replay: { id, type: c.type || "function", function: { name: c.name || "", arguments: c.object !== undefined ? JSON.stringify(c.object) : c.raw } },
        };
    });

    if (state.finish === null) {
        // no finish_reason: the connection closed before the answer was finished (every dialect
        // sends one), so nothing of it is pushed (§3, "The turn": a stream that broke)
        throw new Error(state.text || calls.length || state.refusal
            ? "the stream ended before the answer was finished"
            : "the answer was empty: the stream ended without a finish_reason");
    }

    const message = { role: "assistant", content: state.text };
    for (const field of fields) {
        if (state.reasoning[field] !== undefined) message[field] = state.reasoning[field];
        else if (d.reasoningOnEveryMessage && d.reasoningField !== "any") message[field] = "";
    }
    if (calls.length) message.tool_calls = calls.map((c) => c.replay);
    for (const c of calls) delete c.replay;

    let stop = FINISH[state.finish] || (calls.length ? "tools" : "end");
    if (state.refusal && stop !== "cut") stop = "refusal";

    return {
        messages: [message],
        calls,
        stop,
        stopDetails: stop === "refusal" ? { reason: state.refusal || state.finish } : null,
        usage: usageOf(state.usage),
        text: state.text,
    };
}

module.exports = {
    family: "chat",
    toolsFor, userMessage, resultsMessages, prune, countImages, requestBytes, stream,
    REQUEST_CAP, TEXT_CAP, STUB, FOLLOWS, REFUSED,
    _bodyFor: bodyFor, _usageOf: usageOf, _finalWords: finalWords, _stripImages: stripImages, FINISH, FINISH_ERRORS,
};
