// Server-sent events, as the four model APIs send them. One reader for all of them:
// `event:` and `data:` lines, several `data:` lines per event, comment lines (DeepSeek sends
// `: keep-alive`), CR LF, chunks cut anywhere in a line, and `data: [DONE]`, which ends the
// stream on Chat Completions. Every byte, a comment line included, feeds the idle watchdog:
// without one for `idleMs` the read ends with an error, which is how a model call that stops
// answering is cut off (docs/PLAN_ASSISTANT.md §2 row 11).
"use strict";

/** A field line, or null for a line that is neither (the spec ignores it). */
function fieldOf(line) {
    if (!line) return null;                       // an empty line ends an event, handled by the caller
    if (line.startsWith(":")) return null;        // a comment line: a byte, no field
    const colon = line.indexOf(":");
    if (colon < 0) return { name: line, value: "" };
    const value = line.slice(colon + 1);
    return { name: line.slice(0, colon), value: value.startsWith(" ") ? value.slice(1) : value };
}

/**
 * Read an SSE body to its end, calling `onEvent({event, data})` per event.
 *
 * @param body      the `ReadableStream` of a fetch response
 * @param onEvent   called once per event, in order; `data` is the joined data lines
 * @param signal    aborts the read (the turn's signal)
 * @param idleMs    no byte for this long ends the read with an error (0 turns it off)
 * @returns {Promise<{events: number, done: boolean}>} `done` is true when `data: [DONE]` ended it
 */
async function readSse(body, { onEvent, signal, idleMs = 120000 } = {}) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let name = "";
    let data = [];
    let events = 0;
    let done = false;

    let idle = null;
    let idleError = null;
    const arm = () => {
        if (!idleMs) return;
        clearTimeout(idle);
        idle = setTimeout(() => {
            idleError = new Error(`the model sent nothing for ${Math.round(idleMs / 1000)} s`);
            reader.cancel().catch(() => { /* already gone */ });
        }, idleMs);
    };
    const onAbort = () => { reader.cancel().catch(() => { /* already gone */ }); };
    if (signal) {
        if (signal.aborted) { clearTimeout(idle); throw abortError(signal); }
        signal.addEventListener("abort", onAbort, { once: true });
    }

    const flush = () => {
        if (!data.length && !name) return;
        if (data.length) {
            const text = data.join("\n");
            if (text === "[DONE]") done = true;
            else { events++; if (onEvent) onEvent({ event: name || "message", data: text }); }
        }
        name = "";
        data = [];
    };

    try {
        arm();
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            arm();
            buffer += decoder.decode(chunk.value, { stream: true });
            for (;;) {
                const at = buffer.search(/\r\n|\n|\r/);
                if (at < 0) break;
                const line = buffer.slice(0, at);
                buffer = buffer.slice(at + (buffer.startsWith("\r\n", at) ? 2 : 1));
                if (!line) { flush(); if (done) break; continue; }
                const field = fieldOf(line);
                if (!field) continue;
                if (field.name === "event") name = field.value;
                else if (field.name === "data") data.push(field.value);
                // id and retry are not used by any of the four families
            }
            if (done) break;
        }
        if (!done) {
            buffer += decoder.decode();
            for (const line of buffer.split(/\r\n|\n|\r/)) {
                if (!line) { flush(); continue; }
                const field = fieldOf(line);
                if (!field) continue;
                if (field.name === "event") name = field.value;
                else if (field.name === "data") data.push(field.value);
            }
            flush();                       // a last event without its blank line
        }
    } finally {
        clearTimeout(idle);
        if (signal) signal.removeEventListener("abort", onAbort);
    }
    if (idleError) throw idleError;
    if (signal && signal.aborted) throw abortError(signal);
    return { events, done };
}

function abortError(signal) {
    const reason = signal.reason;
    if (reason instanceof Error) return reason;
    const err = new Error("stopped");
    err.name = "AbortError";
    return err;
}

module.exports = { readSse, _fieldOf: fieldOf };
