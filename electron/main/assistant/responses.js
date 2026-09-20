// The OpenAI Responses adapter (docs/PLAN_ASSISTANT.md §3, "The four API families side by side";
// §4 A3). Written from the API documentation as read on 2026-09-18 and 2026-09-20; **not run
// against a live key** (§7). Every output item goes back into the history exactly as it arrived,
// reasoning items with their `encrypted_content` included, because with `store: false` the model
// has no state of its own and a chain of reasoning, calls and results is only accepted whole.
//
// The history is a list of Responses *input items*, not chat messages: a `message` item for the
// user, whatever the model answered (`reasoning`, `message`, `function_call`), and one
// `function_call_output` per call. The items are taken whole from `response.output_item.done`,
// never rebuilt from the deltas, so nothing an item carries can be lost on the way back.
"use strict";

const { postStream } = require("./http.js");
const { readSse } = require("./sse.js");

const TEXT_CAP = 32000;          // a tool result longer than this is cut, with a note
const REQUEST_CAP = 24 * 1024 * 1024;
const STUB = "[screenshot no longer attached; call screenshot again]";

/** The tools as this family takes them: flat, and `strict: false` (Responses tries strict mode otherwise). */
function toolsFor(tools) {
    return (tools || []).map((t) => ({
        type: "function",
        name: t.name,
        description: t.description || "",
        parameters: t.inputSchema || { type: "object", properties: {} },
        strict: false,
    }));
}

/** The user's text with the state note above it, as input parts. */
function userMessage(note, text) {
    const content = [];
    if (note) content.push({ type: "input_text", text: note });
    content.push({ type: "input_text", text: String(text == null ? "" : text) });
    return { type: "message", role: "user", content };
}

/** More text into the user message that is still pending (a stopped turn, §3): the family's own part type. */
function appendUserText(message, note, text) {
    const content = Array.isArray(message.content) ? message.content : [{ type: "input_text", text: String(message.content || "") }];
    if (note) content.push({ type: "input_text", text: note });
    content.push({ type: "input_text", text: String(text == null ? "" : text) });
    message.content = content;
    return message;
}

function dataUrl(part) {
    return `data:${part.mimeType || "image/jpeg"};base64,${part.data}`;
}

function cut(text) {
    return text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) + `\n... (cut after ${TEXT_CAP} characters)` : text;
}

/**
 * One `function_call_output` per call, in call order. A result that carries a screenshot takes
 * the parts form of `output` (`input_text` plus `input_image`), which is where this family puts a
 * picture; a plain result is the string, and an error result is prefixed "Error: " (the family
 * has no error flag of its own).
 */
function resultsMessages(calls, results) {
    const out = [];
    for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        const res = results[i] || {};
        const texts = [];
        const images = [];
        for (const part of res.content || []) {
            if (part && part.type === "image" && part.data) images.push({ type: "input_image", image_url: dataUrl(part), detail: "auto" });
            else if (part && part.type === "text") texts.push(cut(String(part.text || "")));
        }
        let text = texts.join("\n") || "ok";
        if (res.isError) text = "Error: " + text;
        out.push({
            type: "function_call_output",
            call_id: call.id,
            output: images.length ? [{ type: "input_text", text }, ...images] : text,
        });
    }
    return out;
}

/** How many screenshots the history carries. */
function countImages(history) {
    let n = 0;
    for (const item of history) {
        const parts = item && Array.isArray(item.output) ? item.output : (item && Array.isArray(item.content) ? item.content : null);
        if (!parts) continue;
        for (const part of parts) if (part && part.type === "input_image") n++;
    }
    return n;
}

/**
 * Detach all but the last `keep` screenshots: an image part becomes a line of text. Only ever
 * called at a new user message (§2 row 9), never inside a turn.
 */
function prune(history, keep) {
    if (!keep || keep < 0) return history;
    const total = countImages(history);
    let drop = total - keep;
    if (drop <= 0) return history;
    for (const item of history) {
        if (drop <= 0) break;
        const parts = item && Array.isArray(item.output) ? item.output : (item && Array.isArray(item.content) ? item.content : null);
        if (!parts) continue;
        const kept = [];
        for (const part of parts) {
            if (drop > 0 && part && part.type === "input_image") { drop--; kept.push({ type: "input_text", text: STUB }); }
            else kept.push(part);
        }
        if (Array.isArray(item.output)) item.output = kept;
        else item.content = kept;
    }
    return history;
}

/** The body this chat would send, for the size check before every model call. */
function bodyFor(chat, history) {
    const body = {
        model: chat.model,
        stream: true,
        store: false,                                    // §2 row 29: no state at the provider
        instructions: chat.system,
        input: history,
        tools: chat.tools,
        max_output_tokens: chat.maxTokens,
        prompt_cache_key: chat.id,
        // Not the plan's word: the plan says `store: false` returns `encrypted_content` by
        // itself (§7 lists that as unverified). Asking for it costs nothing if it does and is
        // what makes the replay work if it does not, so it is asked for.
        include: ["reasoning.encrypted_content"],
    };
    if (chat.effort) body.reasoning = { effort: chat.effort };
    return body;
}

function requestBytes(chat, history) {
    return Buffer.byteLength(JSON.stringify(bodyFor(chat, history)), "utf8");
}

/** `usage` as the loop counts it, whatever the family calls the fields. */
function usageOf(usage) {
    const u = usage || {};
    const input = u.input_tokens_details || {};
    const output = u.output_tokens_details || {};
    return {
        input: Number(u.input_tokens) || 0,
        cacheRead: Number(input.cached_tokens) || 0,
        cacheWrite: Number(input.cache_write_tokens) || 0,
        output: Number(u.output_tokens) || 0,
        reasoning: Number(output.reasoning_tokens) || 0,
    };
}

/**
 * The answers that never come back by waiting, in plain words (§2 row 35). An exhausted
 * account answers 429 like a rate limit does, and only the body tells them apart.
 */
function finalWords(status, bodyText) {
    let e = null;
    try { const j = JSON.parse(String(bodyText || "")); e = (j && j.error) || null; } catch (_) { /* not JSON */ }
    const code = String((e && e.code) || "");
    const message = String((e && e.message) || "");
    if (code === "insufficient_quota" || /exceeded your current quota/i.test(message)) {
        return "The OpenAI account has no credit left for this key; top it up or use another key.";
    }
    if (code === "invalid_api_key" || Number(status) === 401) {
        return "The OpenAI key is not valid. Check it under Settings > API providers.";
    }
    if (code === "model_not_found") {
        return `OpenAI does not serve this model: ${message.slice(0, 200)}`;
    }
    return null;
}

/** The refusal a message item carries, if it carries one. */
function refusalOf(items) {
    for (const item of items) {
        if (!item || item.type !== "message" || !Array.isArray(item.content)) continue;
        for (const part of item.content) if (part && part.type === "refusal") return String(part.refusal || "refused");
    }
    return null;
}

/**
 * One model call, streamed. The items are collected from `response.output_item.done` in the
 * order they finished, so the assistant's whole answer goes back into the history unchanged.
 *
 * @returns {{messages: [], calls: [{id, name, args}], stop: string, usage: object, text: string}}
 */
async function stream(chat, history, opts = {}) {
    const { signal, onText, fetchImpl } = opts;
    const url = `${chat.base}/responses`;
    const headers = {
        Authorization: `Bearer ${chat.key}`,
        "content-type": "application/json",
    };
    let res;
    try {
        ({ res } = await postStream(url, headers, bodyFor(chat, history), {
            signal, key: chat.key, keys: [chat.key], idleMs: chat.idleMs,
            noRetry: (status, body) => status === 402 || finalWords(status, body) !== null,
            sleep: opts.sleep, log: opts.log, fetchImpl,
        }));
    } catch (err) {
        if (err && err.status !== undefined) {
            const words = finalWords(err.status, err.body);
            if (words) { const e = new Error(words); e.status = err.status; e.final = true; throw e; }
        }
        throw err;
    }

    const items = [];
    let usage = null;
    let finish = null;               // "completed", "incomplete" or "failed"
    let incomplete = null;
    let streamError = null;
    let text = "";

    await readSse(res.body, {
        signal,
        idleMs: chat.idleMs,
        onEvent: ({ event, data }) => {
            let msg;
            try { msg = JSON.parse(data); } catch (_) { return; }
            const type = msg.type || event;
            if (type === "response.output_text.delta") {
                const piece = String(msg.delta == null ? "" : msg.delta);
                text += piece;
                if (piece && onText) onText(piece);
                return;
            }
            if (type === "response.output_item.done") {
                if (msg.item) items.push(msg.item);
                return;
            }
            if (type === "response.completed" || type === "response.incomplete") {
                finish = type === "response.completed" ? "completed" : "incomplete";
                const r = msg.response || {};
                if (r.usage) usage = r.usage;
                incomplete = r.incomplete_details || null;
                return;
            }
            if (type === "response.failed" || type === "error") {
                const e = (msg.response && msg.response.error) || msg.error || msg;
                streamError = new Error(`${e.code || e.type || "error"}: ${e.message || data}`);
                finish = "failed";
            }
        },
    });

    if (streamError) throw streamError;
    if (!finish) {
        // no terminal event: the connection closed before the answer was finished, so nothing of
        // it is pushed (§3, "The turn": a stream that broke)
        throw new Error("the stream ended before the answer was finished");
    }

    const calls = items
        .filter((item) => item && item.type === "function_call")
        .map((item) => {
            let args = {};
            let badJson = null;
            try { args = item.arguments ? JSON.parse(item.arguments) : {}; }
            catch (_) { badJson = String(item.arguments || ""); }
            return { id: item.call_id, name: item.name, args, badJson };
        });
    const refusal = refusalOf(items);
    let stop = calls.length ? "tools" : "end";
    if (refusal) stop = "refusal";
    else if (finish === "incomplete") stop = "cut";      // the reason is in stopDetails

    return {
        messages: items,
        calls,
        stop,
        stopDetails: refusal ? { reason: refusal } : (incomplete || null),
        usage: usageOf(usage),
        text,
    };
}

module.exports = {
    family: "responses",
    toolsFor, userMessage, appendUserText, resultsMessages, prune, countImages, requestBytes, stream,
    REQUEST_CAP, TEXT_CAP, STUB,
    _bodyFor: bodyFor, _usageOf: usageOf, _finalWords: finalWords,
};
