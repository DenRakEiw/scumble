// The Gemini `generateContent` adapter (docs/PLAN_ASSISTANT.md §3, "The four API families side by
// side"; §4 A3). Written from the API documentation as read on 2026-09-18 and 2026-09-20; **not
// run against a live key** (§7). The model's content goes back into the history exactly as it
// streamed: the parts in their order, a part that carries a `thoughtSignature` never merged with
// another one, and a signature that arrives in a last chunk with empty text kept as its own part.
// Gemini 3 answers 400 when a signature is missing from the replay.
//
// The history is a list of `contents` (`{role: "user"|"model", parts}`). Tool results are one
// user content of `functionResponse` parts in call order; a screenshot rides in that part's own
// `parts` as `inlineData`, and the JSON answer points at it by `displayName` ("$ref"), which is
// how Gemini 3 takes a picture out of a tool result.
"use strict";

const { postStream } = require("./http.js");
const { readSse } = require("./sse.js");

const TEXT_CAP = 32000;          // a tool result longer than this is cut, with a note
const REQUEST_CAP = 18 * 1024 * 1024;   // the registry's own cap for this provider (§2 row 9)
const STUB = "[screenshot no longer attached; call screenshot again]";

/** The tools as this family takes them: one declaration list, the schema untyped where it is. */
function toolsFor(tools) {
    return [{
        functionDeclarations: (tools || []).map((t) => ({
            name: t.name,
            description: t.description || "",
            parametersJsonSchema: t.inputSchema || { type: "object", properties: {} },
        })),
    }];
}

/** The user's text with the state note above it, as parts of one user content. */
function userMessage(note, text) {
    const parts = [];
    if (note) parts.push({ text: note });
    parts.push({ text: String(text == null ? "" : text) });
    return { role: "user", parts };
}

/**
 * More text into the user content that is still pending (a stopped turn, §3). A content that
 * carries the results of a stopped turn takes the text after them: one user turn, as the family
 * wants it.
 */
function appendUserText(message, note, text) {
    const parts = Array.isArray(message.parts) ? message.parts : [];
    if (note) parts.push({ text: note });
    parts.push({ text: String(text == null ? "" : text) });
    message.parts = parts;
    return message;
}

function cut(text) {
    return text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) + `\n... (cut after ${TEXT_CAP} characters)` : text;
}

/** What the model gets to read of one tool result: its JSON if it is JSON, else the text. */
function answerOf(text, isError) {
    const body = (() => {
        try {
            const parsed = JSON.parse(text);
            // `response` is a struct for this family: an array or a scalar goes in under a name
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { result: parsed };
        } catch (_) { return { result: text }; }
    })();
    return isError ? { error: text } : body;
}

/**
 * One user content with a `functionResponse` part per call, in call order. A screenshot goes into
 * that part's `parts` as `inlineData` with a `displayName`, and the answer object points at it.
 */
function resultsMessages(calls, results) {
    const parts = [];
    for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        const res = results[i] || {};
        const texts = [];
        const images = [];
        for (const part of res.content || []) {
            if (part && part.type === "image" && part.data) {
                const displayName = `screenshot-${call.id}-${images.length}`;
                images.push({ inlineData: { mimeType: part.mimeType || "image/jpeg", data: part.data, displayName } });
            } else if (part && part.type === "text") texts.push(cut(String(part.text || "")));
        }
        const text = texts.join("\n") || "ok";
        const response = answerOf(text, !!res.isError);
        const item = { name: call.name, response };
        // only where the call really carried one: this family may send a `functionCall` without
        // an id, and an id the model never used does not belong in the answer
        if (call.rawId) item.id = call.rawId;
        if (images.length) {
            item.parts = images;
            response.screenshot = { $ref: images[0].inlineData.displayName };
        }
        parts.push({ functionResponse: item });
    }
    return parts.length ? [{ role: "user", parts }] : [];
}

/** How many screenshots the history carries. */
function countImages(history) {
    let n = 0;
    for (const content of history) {
        for (const part of (content && content.parts) || []) {
            if (part && part.inlineData) n++;
            for (const inner of (part && part.functionResponse && part.functionResponse.parts) || []) if (inner && inner.inlineData) n++;
        }
    }
    return n;
}

/**
 * Detach all but the last `keep` screenshots: the picture goes, and the answer says so. Only
 * ever called at a new user message (§2 row 9), never inside a turn.
 */
function prune(history, keep) {
    if (!keep || keep < 0) return history;
    let drop = countImages(history) - keep;
    if (drop <= 0) return history;
    for (const content of history) {
        if (drop <= 0) break;
        for (const part of (content && content.parts) || []) {
            if (drop <= 0) break;
            const fr = part && part.functionResponse;
            const inner = (fr && fr.parts) || null;
            if (!inner || !inner.length) continue;
            drop -= inner.filter((p) => p && p.inlineData).length;
            delete fr.parts;
            if (fr.response && typeof fr.response === "object") {
                delete fr.response.screenshot;
                fr.response.screenshot_removed = STUB;
            }
        }
    }
    return history;
}

/** The body this chat would send, for the size check before every model call. */
function bodyFor(chat, history) {
    const generationConfig = { maxOutputTokens: chat.maxTokens };
    if (chat.effort) generationConfig.thinkingConfig = { thinkingLevel: chat.effort };
    return {
        systemInstruction: { parts: [{ text: chat.system }] },
        contents: history,
        tools: chat.tools,
        generationConfig,
    };
}

function requestBytes(chat, history) {
    return Buffer.byteLength(JSON.stringify(bodyFor(chat, history)), "utf8");
}

const STOP = {
    STOP: "end",
    MAX_TOKENS: "cut",
    SAFETY: "refusal",
    RECITATION: "refusal",
    PROHIBITED_CONTENT: "refusal",
    SPII: "refusal",
    BLOCKLIST: "refusal",
    IMAGE_SAFETY: "refusal",
    MALFORMED_FUNCTION_CALL: "end",
    OTHER: "end",
};

/** `usage` as the loop counts it, whatever the family calls the fields. */
function usageOf(usage) {
    const u = usage || {};
    const cached = Number(u.cachedContentTokenCount) || 0;
    return {
        input: Number(u.promptTokenCount) || 0,
        cacheRead: cached,
        cacheWrite: 0,                                  // implicit caching: nothing is billed for the write
        output: Number(u.candidatesTokenCount) || 0,
        reasoning: Number(u.thoughtsTokenCount) || 0,
    };
}

/**
 * One model call, streamed. Every chunk is a `GenerateContentResponse`; its parts are appended in
 * the order they arrive and never merged, so a `thoughtSignature` stays on the part it came with.
 *
 * @returns {{messages: [], calls: [{id, name, args}], stop: string, usage: object, text: string}}
 */
async function stream(chat, history, opts = {}) {
    const { signal, onText, fetchImpl } = opts;
    const url = `${chat.base}/models/${encodeURIComponent(chat.model)}:streamGenerateContent?alt=sse`;
    const headers = {
        "x-goog-api-key": chat.key,
        "content-type": "application/json",
    };
    const { res } = await postStream(url, headers, bodyFor(chat, history), {
        signal, key: chat.key, keys: [chat.key], idleMs: chat.idleMs,
        noRetry: (status, body) => status === 402 || /API_KEY_INVALID|PERMISSION_DENIED/.test(String(body)),
        sleep: opts.sleep, log: opts.log, fetchImpl,
    });

    const parts = [];
    let finishReason = null;
    let usage = null;
    let blocked = null;
    let streamError = null;
    let text = "";

    await readSse(res.body, {
        signal,
        idleMs: chat.idleMs,
        onEvent: ({ data }) => {
            let msg;
            try { msg = JSON.parse(data); } catch (_) { return; }
            if (msg.error) {
                const e = msg.error;
                streamError = new Error(`${e.status || e.code || "error"}: ${e.message || data}`);
                return;
            }
            if (msg.usageMetadata) usage = msg.usageMetadata;
            if (msg.promptFeedback && msg.promptFeedback.blockReason) blocked = String(msg.promptFeedback.blockReason);
            const candidate = (msg.candidates || [])[0];
            if (!candidate) return;
            for (const part of (candidate.content && candidate.content.parts) || []) {
                parts.push(part);
                if (part && typeof part.text === "string" && part.text && !part.thought) {
                    text += part.text;
                    if (onText) onText(part.text);
                }
            }
            if (candidate.finishReason) finishReason = String(candidate.finishReason);
        },
    });

    if (streamError) throw streamError;
    if (!finishReason && !blocked) {
        // no finishReason: the connection closed before the answer was finished, so nothing of it
        // is pushed (§3, "The turn": a stream that broke)
        throw new Error("the stream ended before the answer was finished");
    }

    const calls = parts
        .filter((p) => p && p.functionCall)
        .map((p, i) => ({
            id: p.functionCall.id || `call_${i}`,          // the loop needs one; rawId is what came
            rawId: p.functionCall.id || null,
            name: p.functionCall.name,
            args: p.functionCall.args && typeof p.functionCall.args === "object" ? p.functionCall.args : {},
            badJson: p.functionCall.args && typeof p.functionCall.args !== "object" ? String(p.functionCall.args) : null,
        }));
    let stop = blocked ? "refusal" : (STOP[finishReason] || "end");
    if (stop === "end" && calls.length) stop = "tools";

    return {
        messages: parts.length ? [{ role: "model", parts }] : [],
        calls,
        stop,
        stopDetails: stop === "refusal" ? { reason: blocked || finishReason } : null,
        usage: usageOf(usage),
        text,
    };
}

module.exports = {
    family: "gemini",
    toolsFor, userMessage, appendUserText, resultsMessages, prune, countImages, requestBytes, stream,
    REQUEST_CAP, TEXT_CAP, STUB, STOP,
    _bodyFor: bodyFor, _usageOf: usageOf, _answerOf: answerOf,
};
