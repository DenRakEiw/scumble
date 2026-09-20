// The Anthropic Messages adapter (docs/PLAN_ASSISTANT.md §3, "The four API families side by
// side"). Written from the API documentation as read on 2026-09-18; **not run against a live
// key** (§7). The whole `content` of an answer goes back into the history exactly as it
// arrived - thinking blocks with their `signature` included - because from Fable 5.1 on
// Anthropic checks signatures against the unchanged prefix.
"use strict";

const { postStream } = require("./http.js");
const { readSse } = require("./sse.js");

const VERSION = "2023-06-01";
const TEXT_CAP = 32000;          // a tool result longer than this is cut, with a note
const REQUEST_CAP = 24 * 1024 * 1024;

/** The tools as this family takes them: no annotations, `input_schema` rather than `parameters`. */
function toolsFor(tools) {
    return (tools || []).map((t) => ({
        name: t.name,
        description: t.description || "",
        input_schema: t.inputSchema || { type: "object", properties: {} },
    }));
}

/** The user's text with the state note above it. */
function userMessage(note, text) {
    const parts = [];
    if (note) parts.push({ type: "text", text: note });
    parts.push({ type: "text", text: String(text == null ? "" : text) });
    return { role: "user", content: parts };
}

/** One `tool_result` block per call, in call order, first in the next user message. */
function resultsMessages(calls, results) {
    const content = [];
    for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        const res = results[i] || {};
        const blocks = [];
        for (const part of res.content || []) {
            if (part.type === "image" && part.data) {
                blocks.push({ type: "image", source: { type: "base64", media_type: part.mimeType || "image/jpeg", data: part.data } });
            } else if (part.type === "text") {
                const text = String(part.text || "");
                blocks.push({ type: "text", text: text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) + `\n... (cut after ${TEXT_CAP} characters)` : text });
            }
        }
        if (!blocks.length) blocks.push({ type: "text", text: "ok" });
        const block = { type: "tool_result", tool_use_id: call.id, content: blocks };
        if (res.isError) block.is_error = true;
        content.push(block);
    }
    return content.length ? [{ role: "user", content }] : [];
}

/** How many screenshots the history carries. */
function countImages(history) {
    let n = 0;
    for (const m of history) {
        if (!m || !Array.isArray(m.content)) continue;
        for (const block of m.content) {
            if (block && block.type === "tool_result") for (const part of block.content || []) if (part && part.type === "image") n++;
        }
    }
    return n;
}

/**
 * Detach all but the last `keep` screenshots: every earlier image block becomes a stub. Only
 * ever called at a new user message (§2 row 9), never inside a turn.
 */
function prune(history, keep) {
    if (!keep || keep < 0) return history;
    const images = [];
    for (let m = 0; m < history.length; m++) {
        const content = history[m] && history[m].content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
            if (block && block.type === "tool_result") {
                for (const part of block.content || []) if (part && part.type === "image") images.push(part);
            }
        }
    }
    const drop = images.length - keep;
    if (drop <= 0) return history;
    let n = 0;
    for (let m = 0; m < history.length && n < drop; m++) {
        const content = history[m] && history[m].content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
            if (!block || block.type !== "tool_result" || !Array.isArray(block.content)) continue;
            block.content = block.content.map((part) => {
                if (n >= drop || !part || part.type !== "image") return part;
                n++;
                return { type: "text", text: "[screenshot no longer attached; call screenshot again]" };
            });
        }
    }
    return history;
}

/** The body this chat would send, for the size check before every model call. */
function bodyFor(chat, history) {
    const body = {
        model: chat.model,
        max_tokens: chat.maxTokens,
        stream: true,
        system: [{ type: "text", text: chat.system }],
        tools: chat.tools,
        messages: history,
        cache_control: { type: "ephemeral" },
    };
    if (chat.effort) body.output_config = { effort: chat.effort };
    return body;
}

function requestBytes(chat, history) {
    return Buffer.byteLength(JSON.stringify(bodyFor(chat, history)), "utf8");
}

const STOP = { tool_use: "tools", end_turn: "end", stop_sequence: "end", max_tokens: "cut", refusal: "refusal", pause_turn: "end" };

/** `usage` as the loop counts it, whatever the family calls the fields. */
function usageOf(start, delta) {
    const u = { ...(start || {}), ...(delta || {}) };
    const details = u.output_tokens_details || {};
    return {
        input: Number(u.input_tokens) || 0,
        cacheRead: Number(u.cache_read_input_tokens) || 0,
        cacheWrite: Number(u.cache_creation_input_tokens) || 0,
        output: Number(u.output_tokens) || 0,
        reasoning: Number(details.thinking_tokens) || 0,
    };
}

/**
 * One model call, streamed. The blocks are rebuilt in the order they arrived, byte for byte,
 * so the assistant message can go back into the history unchanged.
 *
 * @returns {{messages: [], calls: [{id, name, args}], stop: string, usage: object, text: string}}
 */
async function stream(chat, history, opts = {}) {
    const { signal, onText, fetchImpl } = opts;
    const url = `${chat.base}/v1/messages`;
    const headers = {
        "x-api-key": chat.key,
        "anthropic-version": VERSION,
        "content-type": "application/json",
    };
    const { res } = await postStream(url, headers, bodyFor(chat, history), {
        signal, key: chat.key, keys: [chat.key], idleMs: chat.idleMs,
        noRetry: (status, body) => status === 402 || /"type"\s*:\s*"(authentication|permission)_error"/.test(String(body)),
        sleep: opts.sleep, log: opts.log, fetchImpl,
    });

    const blocks = [];
    const fragments = new Map();      // index -> the joined input_json_delta text
    let stopReason = null;
    let startUsage = null;
    let deltaUsage = null;
    let streamError = null;
    let text = "";

    await readSse(res.body, {
        signal,
        idleMs: chat.idleMs,
        onEvent: ({ event, data }) => {
            let msg;
            try { msg = JSON.parse(data); } catch (_) { return; }
            const type = msg.type || event;
            if (type === "message_start") { startUsage = (msg.message && msg.message.usage) || null; return; }
            if (type === "content_block_start") {
                blocks[msg.index] = JSON.parse(JSON.stringify(msg.content_block || {}));
                if (blocks[msg.index].type === "tool_use") fragments.set(msg.index, "");
                return;
            }
            if (type === "content_block_delta") {
                const block = blocks[msg.index];
                const d = msg.delta || {};
                if (!block) return;
                if (d.type === "text_delta") { block.text = (block.text || "") + d.text; text += d.text; if (onText) onText(d.text); }
                else if (d.type === "thinking_delta") block.thinking = (block.thinking || "") + d.thinking;
                else if (d.type === "signature_delta") block.signature = (block.signature || "") + d.signature;
                else if (d.type === "input_json_delta") fragments.set(msg.index, (fragments.get(msg.index) || "") + d.partial_json);
                return;
            }
            if (type === "content_block_stop") {
                const block = blocks[msg.index];
                if (block && block.type === "tool_use") {
                    const raw = fragments.get(msg.index) || "";
                    try { block.input = raw ? JSON.parse(raw) : {}; }
                    catch (err) { block.input = {}; block._badJson = raw; }
                }
                return;
            }
            if (type === "message_delta") {
                if (msg.delta && msg.delta.stop_reason) stopReason = msg.delta.stop_reason;
                if (msg.delta && msg.delta.stop_details) blocks.stopDetails = msg.delta.stop_details;
                if (msg.usage) deltaUsage = msg.usage;
                return;
            }
            if (type === "error") {
                const e = msg.error || {};
                streamError = new Error(`${e.type || "error"}: ${e.message || data}`);
            }
        },
    });

    if (streamError) throw streamError;
    if (stopReason === null) {
        // no message_delta: the connection closed before the answer was finished, so nothing of it
        // is pushed (§3, "The turn": a stream that broke)
        throw new Error("the stream ended before the answer was finished");
    }

    const content = blocks.filter(Boolean);
    const calls = content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, args: b.input || {}, badJson: b._badJson || null }));
    for (const b of content) delete b._badJson;

    return {
        messages: content.length ? [{ role: "assistant", content }] : [],
        calls,
        stop: STOP[stopReason] || (calls.length ? "tools" : "end"),
        stopDetails: blocks.stopDetails || null,
        usage: usageOf(startUsage, deltaUsage),
        text,
    };
}

module.exports = {
    family: "messages",
    toolsFor, userMessage, resultsMessages, prune, countImages, requestBytes, stream,
    REQUEST_CAP, TEXT_CAP, VERSION,
    _bodyFor: bodyFor, _usageOf: usageOf, STOP,
};
